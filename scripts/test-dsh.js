'use strict';

/**
 * DSH 对接测试（全部用假的 spawn，不真的起进程、不联网、不装任何东西）
 *   node scripts/test-dsh.js
 *
 * 覆盖：候选路径发现 / 环境检测的每一项 / 检测不过就拒绝跑任务 /
 * 任务文本与输出解析 / 超时中止 / 输出上限 / 待审流程。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const {
  DshRunner,
  DshSessionRunner,
  candidateDshPaths,
  normalizeDshPath,
  parseNodeVersion,
  parseDshVersion,
  buildTaskPrompt,
  parseDrafts,
  MAX_OUTPUT_BYTES
} = require('../src/main/dsh');
const { KnowledgeBase } = require('../src/main/knowledge');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}${process.env.DSH_TEST_TIMING ? ` (${Date.now() - t0}ms)` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

/**
 * 造一个假 spawn：按「命令 + 参数」决定怎么回答。
 * 匹配规则：先精确匹配，再**最长前缀匹配**（因为跑任务时最后一个参数是任务原文，
 * 每个用例都不一样，用 `node <bin> --profile` 当前缀就能覆盖）。
 * 记录每次调用，测试据此断言「到底有没有真的去起进程」。
 */
function makeFakeSpawn(handlers = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const key = [command, ...(args || [])].join(' ');
    let handler = handlers[key] || handlers[command];
    if (!handler) {
      const prefix = Object.keys(handlers)
        .filter((name) => name !== 'default' && key.startsWith(name))
        .sort((a, b) => b.length - a.length)[0];
      if (prefix) handler = handlers[prefix];
    }
    if (!handler) handler = handlers.default || { code: 0, stdout: '', stderr: '' };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let killed = false;
    child.kill = () => {
      killed = true;
      child.killedByTest = true;
      return true;
    };
    // 用真实定时器稍后触发，让 runner 有机会先挂上监听
    setTimeout(() => {
      if (killed) {
        if (typeof handler.onKill === 'function') handler.onKill(child);
        else child.emit('close', null);
        return;
      }
      if (handler.stdout) child.stdout.emit('data', Buffer.from(handler.stdout));
      if (handler.stderr) child.stderr.emit('data', Buffer.from(handler.stderr));
      if (handler.error) {
        child.emit('error', new Error(handler.error));
        return;
      }
      if (handler.hang) return; // 永远不结束，用来测超时
      child.emit('close', handler.code === undefined ? 0 : handler.code);
    }, handler.delay || 1);
    return child;
  };
  return { spawnImpl, calls };
}

function makeRunner({ handlers, env = {}, config = {} } = {}) {
  const { spawnImpl, calls } = makeFakeSpawn(handlers);
  const runner = new DshRunner({
    getConfig: () => ({ nodePath: '', dshCommand: '', timeoutSec: 5, ...config }),
    logger: { info() {}, warn() {}, error() {} },
    spawnImpl,
    env,
    appPath: ''
  });
  return { runner, calls };
}

(async function main() {
  console.log('DSH 对接测试（假 spawn，不真的起进程）\n');

  const nodeOk = { 'node -v': { code: 0, stdout: 'v24.21.0\n' } };

  // ------------------------------------------------------------ 基础解析

  await test('版本解析', () => {
    assert.deepStrictEqual(parseNodeVersion('v24.21.0'), { text: 'v24.21.0', major: 24 });
    assert.deepStrictEqual(parseNodeVersion('24.1.0'), { text: 'v24.1.0', major: 24 });
    assert.strictEqual(parseNodeVersion('没有版本号'), null);
    assert.strictEqual(parseDshVersion('0.1.5-rc.1\n'), '0.1.5-rc.1');
    assert.strictEqual(parseDshVersion('乱七八糟'), '');
  });

  await test('路径规整：给包目录 / bin.js / 其它可执行文件都能认', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpath-'));
    try {
      const pkg = path.join(dir, 'node_modules', '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      // 给包目录 → 补成 bin.js
      assert.strictEqual(normalizeDshPath(pkg), path.join(pkg, 'lib', 'bin.js'));
      // 给 node_modules → 也能补
      assert.strictEqual(normalizeDshPath(path.join(dir, 'node_modules')), path.join(pkg, 'lib', 'bin.js'));
      // 直接给 bin.js → 原样
      assert.strictEqual(normalizeDshPath(path.join(pkg, 'lib', 'bin.js')), path.join(pkg, 'lib', 'bin.js'));
      // 带引号（从资源管理器复制路径常带）→ 去掉
      assert.strictEqual(normalizeDshPath(`"${pkg}"`), path.join(pkg, 'lib', 'bin.js'));
      // 找不到的路径 → 原样返回，交给探测去报错
      assert.strictEqual(normalizeDshPath('C:\\nope\\dsh.cmd'), 'C:\\nope\\dsh.cmd');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('候选路径：全局 npm + npx 缓存 + 软件目录都去找', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcand-'));
    try {
      const npxRoot = path.join(dir, 'npm-cache', '_npx');
      const hit = path.join(npxRoot, 'abcdef', 'node_modules', '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(hit, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(hit, 'lib', 'bin.js'), '// bin', 'utf8');
      const candidates = candidateDshPaths({
        explicit: 'C:\\我自己填的\\lib\\bin.js',
        env: { LOCALAPPDATA: path.join(dir, 'npm-cache', '..'), APPDATA: path.join(dir, 'appdata') }
      });
      const paths = candidates.map((item) => item.binPath);
      assert.ok(
        paths.some((item) => item.includes('我自己填的')),
        '显式指定的要排在最前面'
      );
      assert.strictEqual(candidates[0].source, '你指定的路径');
      assert.ok(
        paths.some((item) => item.includes('_npx') && item.endsWith('bin.js')),
        `npx 缓存里那份要能找到：${paths.join(' | ')}`
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ 环境检测

  await test('检测：全都没有时逐项报缺，并给「怎么补」', async () => {
    const { runner } = makeRunner({
      handlers: {
        'node -v': { code: 1, stderr: "'node' 不是内部或外部命令\n" },
        default: { code: 1, stderr: 'not found' }
      },
      env: {}
    });
    const result = await runner.detect();
    assert.strictEqual(result.ok, false, '缺 Node 时不该算通过');
    const node = result.checks.find((item) => item.key === 'node');
    assert.strictEqual(node.ok, false);
    assert.ok(node.hint.includes('nodejs.org'), `缺 Node 时要告诉去哪儿装：${node.hint}`);
    const dsh = result.checks.find((item) => item.key === 'dsh');
    assert.strictEqual(dsh.ok, false);
    assert.ok(/Node/.test(dsh.detail) || /没找到/.test(dsh.detail), `detail 要说清楚：${dsh.detail}`);
  });

  await test('检测：Node 有、DSH 包也有 → 通过，并报出各自版本与来源', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshdetect-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const { runner } = makeRunner({
        handlers: {
          'node -v': { code: 0, stdout: 'v24.21.0\n' },
          [`node ${path.join(pkg, 'lib', 'bin.js')} --version`]: { code: 0, stdout: '0.1.5-rc.1\n' }
        },
        config: { dshCommand: pkg, apiKey: 'sk-test' },
        env: {}
      });
      const result = await runner.detect();
      assert.strictEqual(result.ok, true, `应该通过：${JSON.stringify(result.checks)}`);
      assert.strictEqual(result.node.version, 'v24.21.0');
      assert.strictEqual(result.dsh.version, '0.1.5-rc.1');
      assert.ok(result.dsh.binPath.endsWith('bin.js'));
      const credentials = result.checks.find((item) => item.key === 'credentials');
      assert.strictEqual(credentials.ok, true);
      assert.ok(credentials.detail.includes('软件里配的'), `凭证来源要说清楚：${credentials.detail}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('检测：凭证可以是环境变量，也可以是 DSH 自己的凭证文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcred-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const handlers = {
        'node -v': { code: 0, stdout: 'v24.21.0\n' },
        [`node ${path.join(pkg, 'lib', 'bin.js')} --version`]: { code: 0, stdout: '0.1.5\n' }
      };
      // 环境变量里有 key
      const envRunner = makeRunner({ handlers, config: { dshCommand: pkg }, env: { DEEPSEEK_API_KEY: 'sk-env' } });
      const envResult = await envRunner.runner.detect();
      assert.ok(envResult.checks.find((c) => c.key === 'credentials').detail.includes('环境变量'));

      // 只有 DSH 的凭证文件
      const dshHome = path.join(dir, 'home');
      fs.mkdirSync(dshHome, { recursive: true });
      fs.writeFileSync(path.join(dshHome, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-x\n', 'utf8');
      const fileRunner = makeRunner({ handlers, config: { dshCommand: pkg }, env: { DSH_HOME: dshHome } });
      const fileResult = await fileRunner.runner.detect();
      assert.ok(fileResult.checks.find((c) => c.key === 'credentials').ok, '有凭证文件时也该算有凭证');
      assert.ok(fileResult.checks.find((c) => c.key === 'credentials').detail.includes('凭证文件'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ 跑任务

  await test('环境没配好时，跑任务直接被拒（不只靠界面禁用按钮）', async () => {
    const { runner, calls } = makeRunner({
      handlers: { 'node -v': { code: 1, stderr: 'not found' }, default: { code: 1, stderr: 'no' } },
      env: {}
    });
    const result = await runner.runTask({ task: '整理一下' });
    assert.strictEqual(result.ok, false);
    assert.ok(/环境没配好/.test(result.message), `拒绝理由要明确：${result.message}`);
    // 关键：连 DSH 都没启动过（只探测了 node）
    assert.ok(
      calls.every((call) => call.args[0] === '-v'),
      `不该真的去跑 DSH，实际调用了：${JSON.stringify(calls.map((c) => c.args))}`
    );
  });

  await test('跑任务：不经过 shell，任务原文是单独一个参数（不会有命令注入）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshrun-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const binPath = path.join(pkg, 'lib', 'bin.js');
      const { runner, calls } = makeRunner({
        handlers: {
          'node -v': { code: 0, stdout: 'v24.21.0\n' },
          [`node ${binPath} --version`]: { code: 0, stdout: '0.1.5\n' },
          [`node ${binPath} --profile`]: { code: 0, stdout: '整理结果\n' }
        },
        config: { dshCommand: pkg, apiKey: 'sk-test' },
        env: {}
      });
      const nasty = '整理 & del C:\\ /c "引号" | 管道';
      const result = await runner.runTask({ task: nasty, cwd: dir });
      assert.strictEqual(result.ok, true, result.message);
      const run = calls.find((call) => call.args.includes('--profile'));
      assert.ok(run, '应该调用 headless profile');
      assert.deepStrictEqual(run.args.slice(0, 2), [binPath, '--profile']);
      assert.strictEqual(run.args[2], 'headless');
      assert.ok(run.args[3].startsWith(nasty), '任务原文要原样作为单独一个参数传进去');
      assert.strictEqual(run.options.shell, undefined, '不能用 shell（否则就有注入风险）');
      // 我们把软件里的 Key 注进子进程环境，用户不用再去 DSH 里配一遍
      assert.strictEqual(run.options.env.DEEPSEEK_API_KEY, 'sk-test');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('跑任务：工作区就是传进来的目录；没传就用临时目录，绝不用软件目录', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcwd-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const binPath = path.join(pkg, 'lib', 'bin.js');
      const { runner, calls } = makeRunner({
        handlers: {
          'node -v': { code: 0, stdout: 'v24.21.0\n' },
          [`node ${binPath} --version`]: { code: 0, stdout: '0.1.5\n' },
          [`node ${binPath} --profile`]: { code: 0, stdout: '好了\n' }
        },
        config: { dshCommand: pkg, apiKey: 'sk-test' },
        env: {}
      });
      await runner.runTask({ task: '整理', cwd: dir });
      let run = calls.filter((call) => call.args.includes('--profile')).pop();
      assert.strictEqual(run.options.cwd, dir, '工作区要跟着传进来的目录走（= 知识库）');

      calls.length = 0;
      await runner.runTask({ task: '整理' });
      run = calls.filter((call) => call.args.includes('--profile')).pop();
      assert.strictEqual(run.options.cwd, os.tmpdir(), '没给工作区就退临时目录');
      // 这条是安全底线：工作区要是落到软件目录，DSH 就能翻遍整个程序目录
      assert.notStrictEqual(path.resolve(run.options.cwd), path.resolve(process.cwd()), '绝不能默认用软件目录当工作区');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('跑任务：退出码非 0 要带上错误原因', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshfail-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const binPath = path.join(pkg, 'lib', 'bin.js');
      const { runner } = makeRunner({
        handlers: {
          'node -v': { code: 0, stdout: 'v24.21.0\n' },
          [`node ${binPath} --version`]: { code: 0, stdout: '0.1.5\n' },
          [`node ${binPath} --profile`]: { code: 1, stderr: 'Error: 凭证无效\n' }
        },
        config: { dshCommand: pkg, apiKey: 'sk-test' },
        env: {}
      });
      const result = await runner.runTask({ task: '整理', cwd: dir });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, 1);
      assert.ok(result.message.includes('凭证无效'), `要带出 stderr 的原文：${result.message}`);
      assert.ok(result.stderr.includes('凭证无效'), 'stderr 要完整保留给界面看');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('跑任务：超时会被中止，并给出可读的提示', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshtimeout-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const binPath = path.join(pkg, 'lib', 'bin.js');
      const { runner } = makeRunner({
        handlers: {
          'node -v': { code: 0, stdout: 'v24.21.0\n' },
          [`node ${binPath} --version`]: { code: 0, stdout: '0.1.5\n' },
          [`node ${binPath} --profile`]: { hang: true }
        },
        config: { dshCommand: pkg, apiKey: 'sk-test', timeoutSec: 1 },
        env: {}
      });
      const result = await runner.runTask({ task: '整理', cwd: dir });
      assert.strictEqual(result.ok, false);
      assert.ok(/超.*秒/.test(result.message), `超时提示不对：${result.message}`);
      assert.ok(result.ms >= 900, `至少要等满超时时间，实际 ${result.ms}ms`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('跑任务：输出有上限（agent 的 stderr 能刷屏）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshcap-'));
    try {
      const pkg = path.join(dir, '@deepseek-ai', 'dsh');
      fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'lib', 'bin.js'), '// bin', 'utf8');
      const binPath = path.join(pkg, 'lib', 'bin.js');
      const { runner } = makeRunner({
        handlers: {
          'node -v': { code: 0, stdout: 'v24.21.0\n' },
          [`node ${binPath} --version`]: { code: 0, stdout: '0.1.5\n' },
          [`node ${binPath} --profile`]: { code: 0, stdout: 'x'.repeat(MAX_OUTPUT_BYTES + 5000) }
        },
        config: { dshCommand: pkg, apiKey: 'sk-test', timeoutSec: 20 },
        env: {}
      });
      const result = await runner.runTask({ task: '整理', cwd: dir });
      assert.ok(result.output.length <= MAX_OUTPUT_BYTES, `输出没截断：${result.output.length}`);
      assert.strictEqual(result.truncated, true, '截断了要标记出来');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ 任务文本与解析

  await test('任务文本会自动附上输出格式要求', () => {
    const prompt = buildTaskPrompt('把 inbox 里的清单整理成知识');
    assert.ok(prompt.startsWith('把 inbox 里的清单整理成知识'), '原任务要在最前面');
    assert.ok(prompt.includes('===知识条目==='), '要附上结构标记');
    assert.ok(prompt.includes('标题：') && prompt.includes('正文：'), '要说明字段名');
  });

  await test('解析输出：按格式输出的多条能拆开', () => {
    const output = [
      '我整理好了。',
      '',
      '===知识条目===',
      '标题：大肥鱼玩偶价格',
      '标签：商品,价格',
      '正文：49 元，下单送贴纸。',
      '',
      '===知识条目===',
      '标题：直播间的梗：吃白饭',
      '正文：观众调侃主播白拿工资，回一句自嘲就好。',
      ''
    ].join('\n');
    const drafts = parseDrafts(output);
    assert.strictEqual(drafts.length, 2, `应该解析出 2 条，实际 ${drafts.length}`);
    assert.strictEqual(drafts[0].title, '大肥鱼玩偶价格');
    assert.strictEqual(drafts[0].content, '49 元，下单送贴纸。');
    assert.strictEqual(drafts[0].tags, '商品,价格');
    assert.strictEqual(drafts[1].title, '直播间的梗：吃白饭');
    assert.ok(drafts[1].content.includes('自嘲'), '正文没解析对');
  });

  await test('解析输出：模型把标记写成 markdown（# 知识条目 / **标题：**）也要拆得出来', () => {
    // 实测踩到（2026-10-18，走自研搜索那条路）：模型把 ===知识条目=== 写成「# 知识条目」、
    // 把「标题：」写成「**标题：**」。旧的正则只认严格写法 → 整段被兜底成一条草稿，
    // 标题还是「知识条目」四个字，主播看到的就是一条废草稿。
    const output = [
      '# 知识条目',
      '**标题：** 祀是终末地的六星寒冷辅助干员',
      '**标签：** 明日方舟, 祀',
      '**正文：** 随「丹青渡」版本实装，限定寻访「万物更新」登场。',
      '',
      '# 知识条目',
      '**标题：** 另一个条目',
      '**正文：** 第二段内容'
    ].join('\n');
    const drafts = parseDrafts(output);
    assert.strictEqual(drafts.length, 2, `应该拆成 2 条，实际 ${drafts.length}`);
    assert.strictEqual(drafts[0].title, '祀是终末地的六星寒冷辅助干员');
    assert.strictEqual(drafts[0].tags, '明日方舟, 祀');
    assert.ok(drafts[0].content.includes('丹青渡'), drafts[0].content);
    assert.ok(!drafts[0].content.includes('**'), '加粗符号不该留在正文里');
    assert.strictEqual(drafts[1].title, '另一个条目');
  });

  await test('解析输出：【知识条目】这种写法也认', () => {
    const drafts = parseDrafts('【知识条目】\n标题：甲\n正文：乙');
    assert.strictEqual(drafts.length, 1, `应该 1 条，实际 ${drafts.length}`);
    assert.strictEqual(drafts[0].title, '甲');
    assert.strictEqual(drafts[0].content, '乙');
  });

  await test('解析输出：没按格式来时整段收下，绝不丢结果', () => {
    const drafts = parseDrafts('# 整理结果\n\n直播间主要卖玩偶，价格 39~49 元。');
    assert.strictEqual(drafts.length, 1, '至少要留一条');
    assert.strictEqual(drafts[0].title, '整理结果');
    assert.ok(drafts[0].content.includes('39~49'), '正文要完整保留');
    assert.ok(drafts[0].source.includes('未按格式'), '要标出来它是兜底收下的');
    assert.deepStrictEqual(parseDrafts('   '), [], '空输出不该造出草稿');
  });

  // ------------------------------------------------------------ 待审流程

  await test('待审：DSH 的产出只有点「通过」才进知识库', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dshpending-'));
    try {
      const kb = new KnowledgeBase({ dir, logger: { warn() {} } });
      kb.load();
      const draft = kb.addPending({ title: '商品价格', content: '49 元', tags: '商品', source: 'DSH 整理', engine: 'dsh' });
      assert.strictEqual(kb.stats().count, 0, '草稿不该立刻进知识库');
      assert.strictEqual(kb.stats().pending, 1);
      assert.strictEqual(kb.listPending()[0].engine, 'dsh');
      assert.ok(fs.existsSync(path.join(dir, 'pending', `${draft.id}.json`)), '草稿要落盘（重启后还在）');

      const entry = kb.approvePending(draft.id, { content: '49 元（已核对）' });
      assert.strictEqual(kb.stats().count, 1, '通过后应该进知识库');
      assert.strictEqual(kb.stats().pending, 0, '通过后草稿要删掉');
      assert.strictEqual(kb.get(entry.id).content, '49 元（已核对）', '通过时可以顺手改内容');
      assert.ok(kb.get(entry.id).source.includes('待审通过'), '来源要标出「经过人工通过」');

      const draft2 = kb.addPending({ title: '不要的', content: 'x' });
      assert.strictEqual(kb.rejectPending(draft2.id), true);
      assert.strictEqual(kb.stats().count, 1, '丢弃不该动知识库');
      assert.strictEqual(kb.stats().pending, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
