'use strict';

/**
 * DSH 会话模式（ACP）测试：全部用假 spawn，不起真进程、不联网、不花钱
 *   node scripts/test-dsh-acp.js
 *
 * 为什么单独一个文件：会话模式的协议实现换过一次（SDK stdio → ACP），
 * 旧协议**只会 create 不会 open**，导致「固定会话 id」第二次跑必炸：
 *   session "…" already exists
 * ACP 才支持 `session/resume`，会话 id 由服务端生成、我们存下来续用。
 */

const assert = require('assert');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { DshSessionRunner, resolveModelValue, parseModelValue, currentModelName } = require('../src/main/dsh-acp');
const { DshSessionRunner: FromBarrel } = require('../src/main/dsh');

/** ACP 的 configOptions 长这样（模型选项的 value 是 JSON 数组字符串） */
function makeConfigOptions(currentModel = 'deepseek-v4-flash', provider = 'deepseek-official') {
  const value = (model) => JSON.stringify([provider, model]);
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: value(currentModel),
      options: [
        {
          group: provider,
          name: 'DeepSeek',
          options: [
            { value: value('deepseek-flash'), name: 'DeepSeek-V41-Flash' },
            { value: value('deepseek-v4-flash'), name: 'DeepSeek-V4-Flash' },
            { value: value('deepseek-v4-pro'), name: 'DeepSeek-V4-Pro' }
          ]
        }
      ]
    }
  ];
}
/**
 * 假的 ACP 模型目录：会话默认 v4-flash（和 acp 档自带的一样），
 * 收到 set_config_option 就把当前值换掉并回报。
 */
function modelAwareScript(currentModel = 'deepseek-v4-flash', extra = {}) {
  return {
    initialize: {
      result: {
        protocolVersion: 1,
        agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
        agentCapabilities: { sessionCapabilities: { list: {}, resume: {}, close: {} } }
      }
    },
    'session/new': { result: { sessionId: 's-1', configOptions: makeConfigOptions(currentModel) } },
    'session/resume': { result: { configOptions: makeConfigOptions(currentModel) } },
    'session/set_config_option': { result: { configOptions: makeConfigOptions('deepseek-flash') } },
    'session/prompt': { chunks: ['好了'], sessionId: 's-1' },
    ...extra
  };
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

function tick(ms = 4) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 假的长驻 ACP 服务端：真的按 JSON-RPC 协议（换行分隔）应答，
 * 这样测的是**协议实现**，而不是「有没有调那个函数」。
 *
 * script 按键给行为：
 *   { result }        正常返回
 *   { error }         返回 JSON-RPC 错误
 *   { silent:true }   不回（测超时）
 *   { chunks:[...] }  session/prompt 时先推若干 agent_message_chunk，再返回 stopReason
 *   { permission:true } 先向客户端要一次权限，拿到回复再继续
 *   { stopReason }    返回的 stopReason（默认 end_turn）
 */
function makeFakeAcpChild({ script = {} } = {}) {
  const written = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.stdinEnded = false;
  child.kill = () => {
    child.killed = true;
    setTimeout(() => child.emit('close', 0), 1);
    return true;
  };
  const send = (message) => {
    setTimeout(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)), 1);
  };
  const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
  child.stdin = {
    write(chunk) {
      const line = String(chunk).trim();
      written.push(line);
      const message = JSON.parse(line);
      const isNotification = message.id === undefined;
      const behaviour = script[message.method] || {};
      // 客户端对我们的回应（比如权限答复）→ 记下来交给测试断言
      if (isNotification && message.method !== 'session/cancel') return;
      if (message.method === 'session/cancel') {
        child.cancelled = true;
        return;
      }
      if (behaviour.silent) return;
      const finish = () => {
        if (behaviour.error) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: behaviour.error } });
          return;
        }
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: behaviour.result === undefined ? (message.method === 'session/prompt' ? { stopReason: behaviour.stopReason || 'end_turn' } : {}) : behaviour.result
        });
      };
      const pushChunks = () => {
        const chunks = behaviour.chunks || [];
        chunks.forEach((text, index) => {
          setTimeout(
            () =>
              notify('session/update', {
                sessionId: behaviour.sessionId || 's-1',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
              }),
            1 + index
          );
        });
      };
      if (behaviour.permission) {
        // 服务端反过来问客户端「要不要放它动别的地方」（ACP 的 session/request_permission）
        const requestId = `srv_${written.length}`;
        send({
          jsonrpc: '2.0',
          id: requestId,
          method: 'session/request_permission',
          params: {
            sessionId: behaviour.sessionId || 's-1',
            toolCall: { toolCallId: 'call-1' },
            options: [
              { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
            ]
          }
        });
        // 客户端回话后会再写一条（id = requestId 的响应），这里不阻塞：直接继续推正文
      }
      if (behaviour.unknownRequest) {
        send({ jsonrpc: '2.0', id: 'srv_unknown', method: 'fs/read_text_file', params: { path: 'x' } });
      }
      pushChunks();
      setTimeout(finish, 6 + (behaviour.chunks || []).length);
      if (behaviour.silentAfterPrompt) clearTimeout();
    },
    end() {
      child.stdinEnded = true;
      // 真的 ACP 服务端在 stdin EOF 后收尾退出
      setTimeout(() => {
        child.emit('close', 0);
      }, 2);
    },
    destroyed: false
  };
  return { child, written };
}

function makeAcpRunner(options = {}) {
  const { child, written } = makeFakeAcpChild({ script: options.script });
  const spawnCalls = [];
  const sessions = [];
  const runner = new DshSessionRunner({
    getConfig: () => ({
      sessionName: options.sessionName === undefined ? '直播知识整理' : options.sessionName,
      sessionId: options.sessionId === undefined ? '' : options.sessionId,
      // 和软件里的默认一致：钉 4.1 Flash（想测「不指定」就传 model: ''）
      model: options.model === undefined ? 'deepseek-flash' : options.model,
      timeoutSec: options.timeoutSec === undefined ? 5 : options.timeoutSec,
      apiKey: 'sk-test',
      cwd: options.cwd === undefined ? 'C:\\demo\\知识库' : options.cwd
    }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    spawnImpl: (command, args, spawnOptions) => {
      spawnCalls.push({ command, args, options: spawnOptions });
      return child;
    },
    env: {},
    onSession: (id) => sessions.push(id),
    resolve: async () => ({
      ok: true,
      node: { command: 'node', version: 'v24.21.0' },
      dsh: { binPath: 'C:\\npx\\dsh\\lib\\bin.js', version: '0.1.5-rc.1' },
      checks: []
    })
  });
  return { runner, child, written, spawnCalls, sessions };
}

/** 默认脚本：initialize + 新建会话 + 一轮正文（模型目录用 modelAwareScript） */
function defaultScript(extra = {}) {
  return modelAwareScript('deepseek-v4-flash', {
    'session/prompt': { chunks: ['整理好了\n\n===知识条目===\n标题：甲\n正文：乙'], sessionId: 's-1' },
    ...extra
  });
}

(async () => {
  console.log('DSH 会话模式（ACP）测试\n');

  await test('走的是 acp profile：命令行、工作区、密钥注入都对', async () => {
    const { runner, spawnCalls, written } = makeAcpRunner({ script: defaultScript() });
    await runner.prompt('整理一下', { timeoutMs: 5000 });
    assert.strictEqual(spawnCalls.length, 1, '只该起一个进程');
    assert.deepStrictEqual(spawnCalls[0].args.slice(0, 2), ['C:\\npx\\dsh\\lib\\bin.js', '--profile']);
    assert.strictEqual(spawnCalls[0].args[2], 'acp', '会话模式必须走 acp（sdk 那条路不会 open，第二次跑必炸）');
    assert.strictEqual(spawnCalls[0].options.cwd, 'C:\\demo\\知识库', '进程 cwd 就是工作区');
    assert.strictEqual(spawnCalls[0].options.env.DEEPSEEK_API_KEY, 'sk-test');
    const init = JSON.parse(written[0]);
    assert.strictEqual(init.method, 'initialize');
    assert.strictEqual(init.params.protocolVersion, 1, 'ACP v1');
    assert.strictEqual(init.params.clientCapabilities.fs.readTextFile, false, '我们不当文件系统代理');
  });

  await test('第一次跑：新建会话 → 存下 id → 把任务发进去', async () => {
    const { runner, written, sessions } = makeAcpRunner({ script: defaultScript() });
    const result = await runner.prompt('整理一下', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.sessionId, 's-1');
    assert.deepStrictEqual(sessions, ['s-1'], '新建后要回调把 id 交出去（主进程存进配置，下次续用）');
    const methods = written.map((line) => JSON.parse(line).method);
    // 建完会话会顺手把模型钉成配置里那个，再发任务
    assert.deepStrictEqual(methods.slice(0, 4), ['initialize', 'session/new', 'session/set_config_option', 'session/prompt']);
    const prompt = JSON.parse(written[3]);
    assert.deepStrictEqual(prompt.params.prompt, [{ type: 'text', text: '【直播知识整理】\n整理一下' }], '新会话第一句话带名字前缀（DSH 用它生成会话标题）');
    assert.ok(result.output.includes('===知识条目==='), `正文没收到：${result.output}`);
  });

  await test('模型钉在配置指定的那个（默认 4.1 Flash，value 是 JSON 数组字符串）', async () => {
    const { runner, written } = makeAcpRunner({ script: defaultScript() });
    const result = await runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, result.message);
    const pin = written.map((line) => JSON.parse(line)).find((message) => message.method === 'session/set_config_option');
    assert.ok(pin, '必须发 session/set_config_option 去指定模型');
    assert.strictEqual(pin.params.configId, 'model');
    assert.strictEqual(pin.params.sessionId, 's-1');
    // ⚠️ ACP 的 value 不是 "provider/model"，是 JSON.stringify([provider, model])
    assert.strictEqual(pin.params.value, JSON.stringify(['deepseek-official', 'deepseek-flash']));
    assert.strictEqual(runner.model, 'deepseek-flash', '钉完要报出实际在用的模型');
  });

  await test('已经是目标模型就不再发请求（少一次往返）', async () => {
    const { runner, written } = makeAcpRunner({ script: modelAwareScript('deepseek-flash') });
    await runner.prompt('整理', { timeoutMs: 5000 });
    const pinned = written.map((line) => JSON.parse(line)).filter((message) => message.method === 'session/set_config_option');
    assert.strictEqual(pinned.length, 0, '当前就是它，不该多发一次');
    assert.strictEqual(runner.model, 'deepseek-flash');
  });

  await test('模型名不在 DSH 的清单里：只警告，任务照跑（不把整轮搞失败）', async () => {
    const warns = [];
    const { runner, written } = makeAcpRunner({ script: defaultScript(), model: 'gpt-5' });
    runner.logger = { info() {}, warn: (m) => warns.push(m), error() {}, debug() {} };
    const result = await runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, `指定模型失败不该让任务失败：${result.message}`);
    assert.ok(!written.includes('session/set_config_option') || !written.some((line) => line.includes('set_config_option')), '不该硬发一个不存在的模型');
    assert.ok(warns.some((m) => /没有/.test(m)), `要留下警告：${warns.join(' / ')}`);
    assert.strictEqual(runner.model, 'deepseek-v4-flash', '退回会话自己的模型并报出来');
  });

  await test('模型留空 = 不指定，用 DSH 自己的默认', async () => {
    const { runner, written } = makeAcpRunner({ script: defaultScript(), model: '' });
    await runner.prompt('整理', { timeoutMs: 5000 });
    assert.ok(!written.some((line) => line.includes('set_config_option')), '留空就不该去指定');
    assert.strictEqual(runner.model, 'deepseek-v4-flash', '报出会话实际在用的那个');
  });

  await test('续用会话时也会把模型钉回来（DSH 记着的可能是别的）', async () => {
    const { runner, written } = makeAcpRunner({
      sessionId: 's-1',
      script: modelAwareScript('deepseek-v4-pro', { 'session/prompt': { chunks: ['续上了'], sessionId: 's-1' } })
    });
    const result = await runner.prompt('接着整理', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, result.message);
    const methods = written.map((line) => JSON.parse(line).method);
    assert.deepStrictEqual(methods, ['initialize', 'session/resume', 'session/set_config_option', 'session/prompt']);
    assert.strictEqual(runner.model, 'deepseek-flash', '续用后也要回到配置指定的模型');
  });

  await test('模型名解析：裸名字 / provider 前缀 / 完整 value 都认，找不到返回空', () => {
    const options = makeConfigOptions('deepseek-v4-flash');
    const flash = JSON.stringify(['deepseek-official', 'deepseek-flash']);
    assert.strictEqual(resolveModelValue(options, 'deepseek-flash'), flash);
    assert.strictEqual(resolveModelValue(options, 'deepseek-official/deepseek-flash'), flash);
    assert.strictEqual(resolveModelValue(options, flash), flash);
    assert.strictEqual(resolveModelValue(options, 'deepseek-official/deepseek-v4-pro'), JSON.stringify(['deepseek-official', 'deepseek-v4-pro']));
    assert.strictEqual(resolveModelValue(options, 'gpt-5'), '');
    assert.strictEqual(resolveModelValue(options, ''), '');
    assert.deepStrictEqual(parseModelValue(flash), { provider: 'deepseek-official', model: 'deepseek-flash' });
    assert.deepStrictEqual(parseModelValue('乱七八糟'), { provider: '', model: '' });
    assert.strictEqual(currentModelName(options), 'deepseek-v4-flash');
  });

  await test('正文按 session/update 分块收齐，思考 / 别的会话不算正文', async () => {
    const { runner, child } = makeAcpRunner({
      script: defaultScript({ 'session/prompt': { sessionId: 's-1', chunks: ['甲', '乙'] } })
    });
    await runner.prompt('整理', { timeoutMs: 5000 });
    // 再推一条「思考」和一条别的会话的正文（都不该进正文）
    await new Promise((resolve) => {
      child.stdout.emit(
        'data',
        Buffer.from(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想…' } } } })}\n` +
            `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'other', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '别人的' } } } })}\n`
        )
      );
      setTimeout(resolve, 5);
    });
    const again = await runner.prompt('再来一次', { timeoutMs: 5000 });
    assert.strictEqual(again.output, '甲乙', `正文该只有甲乙，实际 ${again.output}`);
  });

  await test('第二次启动：先 resume 同一个会话，不再新建', async () => {
    const { runner, written, sessions } = makeAcpRunner({
      sessionId: 's-1',
      script: defaultScript({ 'session/prompt': { sessionId: 's-1', chunks: ['续上了'] } })
    });
    const result = await runner.prompt('接着整理', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, result.message);
    const methods = written.map((line) => JSON.parse(line).method);
    assert.deepStrictEqual(
      methods,
      ['initialize', 'session/resume', 'session/set_config_option', 'session/prompt'],
      '有 id 就该 resume（再钉一下模型），不该再 new'
    );
    const resume = JSON.parse(written[1]);
    assert.strictEqual(resume.params.sessionId, 's-1');
    assert.strictEqual(resume.params.cwd, 'C:\\demo\\知识库', 'resume 要带上工作区（DSH 会核对是不是同一个目录）');
    assert.deepStrictEqual(sessions, [], '续用成功不该再回调存 id');
    assert.strictEqual(result.sessionId, 's-1');
  });

  await test('resume 失败（会话被删了 / 目录搬了）→ 自动新建一个', async () => {
    const { runner, written, sessions } = makeAcpRunner({
      sessionId: 'gone',
      script: defaultScript({ 'session/resume': { error: 'session is not resumable: gone' } })
    });
    const result = await runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, result.message);
    const methods = written.map((line) => JSON.parse(line).method);
    assert.deepStrictEqual(methods, ['initialize', 'session/resume', 'session/new', 'session/set_config_option', 'session/prompt']);
    assert.deepStrictEqual(sessions, ['', 's-1'], '先把作废的 id 清掉，再存新的');
  });

  await test('服务端要权限时一律拒绝（不弹窗、也不卡住）', async () => {
    const { runner, written } = makeAcpRunner({
      script: defaultScript({ 'session/prompt': { sessionId: 's-1', chunks: ['结果'], permission: true } })
    });
    const result = await runner.prompt('读一下我桌面的文件', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, `要权限也不该把整轮卡死：${result.message}`);
    assert.strictEqual(result.denied, 1, '拒绝次数要报出来');
    const answer = written
      .map((line) => JSON.parse(line))
      .find((message) => message.id && String(message.id).startsWith('srv_'));
    assert.ok(answer, '客户端必须回服务端的请求（不回它就一直等）');
    assert.strictEqual(answer.result.outcome.optionId, 'reject-once', '默认拒绝：用户要的就是把它关在知识库里');
  });

  await test('认不出的服务端请求也回一句「不支持」，不让对方干等', async () => {
    const { runner, written } = makeAcpRunner({
      script: defaultScript({ 'session/prompt': { sessionId: 's-1', chunks: ['结果'], unknownRequest: true } })
    });
    const result = await runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(result.ok, true, result.message);
    const answer = written
      .map((line) => JSON.parse(line))
      .find((message) => message.error && message.error.code === -32601);
    assert.ok(answer, '未知请求要回 -32601');
  });

  await test('同一个进程复用：第二次不再 initialize / 不再建会话', async () => {
    const { runner, written } = makeAcpRunner({
      script: defaultScript({ 'session/prompt': { sessionId: 's-1', chunks: ['好'] } })
    });
    await runner.prompt('第一次', { timeoutMs: 5000 });
    await runner.prompt('第二次', { timeoutMs: 5000 });
    const methods = written.map((line) => JSON.parse(line).method);
    assert.strictEqual(methods.filter((m) => m === 'initialize').length, 1, '只该握手一次');
    assert.strictEqual(methods.filter((m) => m === 'session/new').length, 1, '只该建一次会话');
    assert.strictEqual(methods.filter((m) => m === 'session/prompt').length, 2, '两次任务都该发出去');
    // 第二次不该再带名字前缀
    const second = JSON.parse(written[written.length - 1]);
    assert.strictEqual(second.params.prompt[0].text, '第二次');
  });

  await test('中止：发 session/cancel 通知（不杀进程），这一轮以 cancelled 收尾', async () => {
    const { runner, child, written } = makeAcpRunner({
      script: defaultScript({ 'session/prompt': { sessionId: 's-1', chunks: ['半截'], stopReason: 'cancelled' } })
    });
    const running = runner.prompt('长任务', { timeoutMs: 5000 });
    // 等握手 + 建会话完成（真机上点「中止」时早就跑起来了，这里只是让测试确定）
    for (let i = 0; i < 100 && !runner.sessionId; i += 1) await tick(2);
    assert.ok(runner.sessionId, '前置：会话应该已经建好');
    assert.strictEqual(runner.cancel(), true, '应该发得出取消');
    const result = await running;
    const cancel = written.map((line) => JSON.parse(line)).find((message) => message.method === 'session/cancel');
    assert.ok(cancel, '要发 session/cancel');
    assert.strictEqual(cancel.id, undefined, 'ACP 的取消是**通知**（没有 id）');
    assert.strictEqual(cancel.params.sessionId, 's-1');
    assert.strictEqual(result.ok, false);
    assert.ok(/中止/.test(result.message), `提示要说清是被中止：${result.message}`);
    assert.strictEqual(child.killed, false, '取消了不该顺手把常驻进程杀掉');
  });

  await test('超时：按用户设的秒数收尾，并说清「它没被杀、还在会话里跑」', async () => {
    const { runner } = makeAcpRunner({
      timeoutSec: 1,
      script: defaultScript({ 'session/prompt': { silent: true } })
    });
    const started = Date.now();
    const result = await runner.prompt('慢慢跑', { timeoutMs: 1000 });
    const ms = Date.now() - started;
    assert.strictEqual(result.ok, false);
    assert.ok(ms < 3000, `一条链路上只该有一个时间上限（实际 ${ms}ms）`);
    assert.ok(/超过 1 秒/.test(result.message), `提示里要有秒数：${result.message}`);
    assert.ok(/没有被杀掉|还在会话里/.test(result.message), `要说清它还在跑：${result.message}`);
  });

  await test('环境没配好时直接拒绝，不启动进程', async () => {
    let spawned = 0;
    const runner = new DshSessionRunner({
      getConfig: () => ({ sessionName: 'x', sessionId: '', timeoutSec: 5, apiKey: '', cwd: 'C:\\demo' }),
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      spawnImpl: () => {
        spawned += 1;
        return new EventEmitter();
      },
      env: {},
      resolve: async () => ({ ok: false, checks: [{ key: 'node', label: '系统 Node', ok: false }] })
    });
    const result = await runner.prompt('整理', { timeoutMs: 1000 });
    assert.strictEqual(result.ok, false);
    assert.ok(/环境没配好/.test(result.message), result.message);
    assert.strictEqual(spawned, 0, '检测不过就不该起进程');
  });

  await test('工作区：报出来的就是配置里的目录；没配就退临时目录（绝不用软件目录）', async () => {
    const a = makeAcpRunner({ script: defaultScript() });
    await a.runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(a.runner.workspace, 'C:\\demo\\知识库');

    const { runner, spawnCalls } = makeAcpRunner({ cwd: '', script: defaultScript() });
    await runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(spawnCalls[0].options.cwd, os.tmpdir());
    assert.strictEqual(runner.workspace, os.tmpdir());
    assert.notStrictEqual(path.resolve(runner.workspace), path.resolve(process.cwd()), '绝不能默认用软件目录当工作区');
  });

  await test('收尾：优雅退出走 stdin EOF（等价于 shutdown），不优雅就直接杀', async () => {
    const graceful = makeAcpRunner({ script: defaultScript() });
    await graceful.runner.prompt('整理', { timeoutMs: 5000 });
    await graceful.runner.stop({ graceful: true, timeoutMs: 200 });
    assert.strictEqual(graceful.child.stdinEnded, true, 'ACP 没有 shutdown 方法，优雅退出 = 关 stdin');

    const hard = makeAcpRunner({ script: defaultScript() });
    await hard.runner.prompt('整理', { timeoutMs: 5000 });
    await hard.runner.stop({ graceful: false });
    assert.strictEqual(hard.child.stdinEnded, false, '不优雅就别发 EOF');
    assert.strictEqual(hard.child.killed, true);
  });

  await test('进程自己退了：等着的人要被解掉，不能一直挂着', async () => {
    const { runner, child } = makeAcpRunner({
      script: defaultScript({ 'session/prompt': { silent: true } })
    });
    const running = runner.prompt('任务', { timeoutMs: 30000 });
    await tick(8);
    child.emit('close', 1);
    const result = await running;
    assert.strictEqual(result.ok, false);
    assert.ok(/退出了|任务没送出去/.test(result.message), `要给出退出的原因：${result.message}`);
    assert.strictEqual(runner.running, false);
  });

  await test('上次建会话失败过：下一次复用进程补建，不拿着空 id 发任务', async () => {
    const script = defaultScript({ 'session/new': { error: '建会话超时了' } });
    const { runner, spawnCalls } = makeAcpRunner({ script });
    const first = await runner.prompt('整理', { timeoutMs: 2000 });
    assert.strictEqual(first.ok, false);
    assert.ok(/建会话超时了/.test(first.message), `要把服务端的原话带出来：${first.message}`);

    // 服务端恢复（真机上就是超时过后再跑一次）
    script['session/new'] = { result: { sessionId: 's-9' } };
    script['session/prompt'] = { chunks: ['好了'], sessionId: 's-9' };
    const second = await runner.prompt('再试一次', { timeoutMs: 5000 });
    assert.strictEqual(second.ok, true, second.message);
    assert.strictEqual(second.sessionId, 's-9');
    assert.strictEqual(spawnCalls.length, 1, '进程还活着就该复用，不用重新起（起一次要好几秒）');
  });

  await test('会话 id 生成后能报出来（界面要显示「用哪个会话」）', async () => {
    const { runner } = makeAcpRunner({ script: defaultScript() });
    assert.strictEqual(runner.sessionId, '', '还没跑过 → 没有 id');
    await runner.prompt('整理', { timeoutMs: 5000 });
    assert.strictEqual(runner.sessionId, 's-1');
    runner.resetSession();
    assert.strictEqual(runner.sessionId, '', '作废后应该回到「还没建」');
  });

  await test('barrel（dsh.js）也导出同一个实现（main.js 从这里拿）', () => {
    assert.strictEqual(FromBarrel, DshSessionRunner, 'dsh.js 应该转出 dsh-acp 的实现');
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
