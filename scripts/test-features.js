'use strict';

/**
 * 新功能测试：用量统计 / 安全自动暂停 / 冷场暖场 / 对话导出
 *   node scripts/test-features.js
 *
 * 同样不联网：DeepSeek 那一跳用本地假接口。
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Copilot } = require('../src/main/copilot');
const { UsageTracker, priceOf, formatMoney } = require('../src/main/stats');
const { BilibiliDanmakuClient } = require('../src/main/danmaku');

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

// ---------------------------------------------------------------- 工具

function makeStore(overrides = {}) {
  const base = {
    api: { apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1', model: 'deepseek-chat', temperature: 1.1, maxTokens: 200, timeoutSec: 10, useJsonFormat: true },
    persona: { botName: '小助手', nickname: '小助手', systemPrompt: '你是搭档。', contextRounds: 8, memoryMinutes: 20, anchorName: '', sendStreamTitle: false, selfTuning: true, selfNote: '' },
    danmaku: {
      roomId: '1',
      ignoreKeywords: '',
      maxLength: 120,
      minIntervalSec: 0,
      batchWindowMs: 200,
      maxBatch: 8,
      blockedUsers: '',
      triggerMode: 'all'
    },
    // 主动搭话（2026-10-21 替换原来的冷场暖场）：默认关着，测试按需覆盖
    proactive: {
      enabled: false,
      idleSeconds: 30,
      maxPerHour: 6,
      chancePercent: 100,
      maxChars: 40,
      modes: ['topic', 'ask', 'follow'],
      useKnowledge: true,
      prompt: '随便聊聊'
    },
    safety: { autoPauseOnError: true, maxConsecutiveFailures: 3 },
    logging: { pricing: null }
  };
  const settings = {
    ...base,
    ...overrides,
    api: { ...base.api, ...(overrides.api || {}) },
    persona: { ...base.persona, ...(overrides.persona || {}) },
    danmaku: { ...base.danmaku, ...(overrides.danmaku || {}) },
    proactive: { ...base.proactive, ...(overrides.proactive || {}) },
    safety: { ...base.safety, ...(overrides.safety || {}) },
    logging: { ...base.logging, ...(overrides.logging || {}) }
  };
  return { get: () => settings, patch: (partial) => Object.assign(settings, partial) };
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    debug: (m) => lines.push(['debug', m]),
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
    onChange: () => () => {}
  };
}

function realDanmakuCmd(text, name, idSeed = 1) {
  return {
    cmd: 'DANMU_MSG',
    dm_v2: '',
    info: [
      [
        0, 1, 25, 16777215, 1791561665953, 1791561665000 + idSeed, 0, '26187a4d', 0, 0, 0, '', 0, '{}', '{}',
        { extra: JSON.stringify({ content: text }), mode: 0, user: { base: { name }, uid: 0 } },
        { activity_identity: '', activity_source: 0, not_show: 0 },
        0
      ],
      text,
      [0, name, 0, 0, 0, 10000, 1, ''],
      [],
      [0, 0, 9868950, '>50000', 0],
      ['', ''],
      0, 0, null,
      { ts: 1791561665, ct: '113C4255' },
      0, 0, null, null, 0, 7
    ]
  };
}

function parseViaClient(payload) {
  const client = new BilibiliDanmakuClient({
    roomId: '1',
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  client._dispatch(payload);
  return events[0];
}

function waitFor(emitter, name, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待事件 ${name} 超时`)), timeoutMs);
    emitter.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function startFakeLlm(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch (_) {
        /* ignore */
      }
      received.push(parsed);
      const result = handler(parsed, received.length);
      res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, received, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function okReply(reply, extraUsage = {}) {
  return {
    json: {
      model: 'deepseek-chat',
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ reply, emotion: 'happy' }) } }],
      usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, ...extraUsage }
    }
  };
}

(async () => {
  console.log('用量统计');

  await test('记录一次成功调用并估算费用', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const tracker = new UsageTracker({
      store: makeStore(),
      logger: makeLogger(),
      file: path.join(dir, 'usage.json')
    });
    const result = tracker.recordSuccess({
      model: 'deepseek-flash',
      usage: { prompt_tokens: 1000, completion_tokens: 100 }
    });
    // deepseek-flash 按 1.1 元/百万 input、4.3 元/百万 output 估算（官方闲时价）
    const expected = (1000 * 1.1 + 100 * 4.3) / 1e6;
    assert.ok(Math.abs(result.cost - expected) < 1e-9, `费用估算不对: ${result.cost} vs ${expected}`);
    const summary = tracker.summary();
    assert.strictEqual(summary.today.calls, 1);
    assert.strictEqual(summary.session.calls, 1);
    assert.strictEqual(summary.today.prompt, 1000);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('思考 token 会单独解出来（界面靠它显示「思考 N」）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const tracker = new UsageTracker({
      store: makeStore(),
      logger: makeLogger(),
      file: path.join(dir, 'usage.json')
    });
    const result = tracker.recordSuccess({
      model: 'deepseek-flash',
      usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 31 } }
    });
    // 官方把思考 token 放在 completion_tokens_details.reasoning_tokens，不在顶层
    assert.strictEqual(result.reasoning, 31, `reasoning token 没解出来: ${JSON.stringify(result)}`);
    assert.strictEqual(result.total, 60, `total 应该是输入+输出: ${result.total}`);
    // 没有这个字段时不能崩，也不能算出 NaN
    const plain = tracker.recordSuccess({ model: 'deepseek-flash', usage: { prompt_tokens: 5, completion_tokens: 6 } });
    assert.strictEqual(plain.reasoning, 0);
    assert.strictEqual(plain.total, 11);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('统计能落盘并重新加载', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const file = path.join(dir, 'usage.json');
    const first = new UsageTracker({ store: makeStore(), logger: makeLogger(), file });
    first.recordSuccess({ model: 'deepseek-chat', usage: { prompt_tokens: 500, completion_tokens: 50 } });
    first.save();

    const second = new UsageTracker({ store: makeStore(), logger: makeLogger(), file });
    assert.strictEqual(second.summary().today.calls, 1, '历史统计没有被读回来');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('统计文件损坏时不会崩，只是重新统计', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const file = path.join(dir, 'usage.json');
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
    const tracker = new UsageTracker({ store: makeStore(), logger: makeLogger(), file });
    assert.strictEqual(tracker.summary().today.calls, 0);
    tracker.recordSuccess({ model: 'deepseek-chat', usage: { prompt_tokens: 10, completion_tokens: 1 } });
    assert.strictEqual(tracker.summary().today.calls, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('失败会单独计数', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const tracker = new UsageTracker({ store: makeStore(), logger: makeLogger(), file: path.join(dir, 'usage.json') });
    tracker.recordFailure();
    tracker.recordFailure();
    assert.strictEqual(tracker.summary().session.failed, 2);
    assert.strictEqual(tracker.summary().today.calls, 2, '失败次数应计入调用数');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('可以清空今日或全部', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
    const tracker = new UsageTracker({ store: makeStore(), logger: makeLogger(), file: path.join(dir, 'usage.json') });
    tracker.recordSuccess({ model: 'deepseek-chat', usage: { prompt_tokens: 100, completion_tokens: 10 } });
    tracker.reset('today');
    assert.strictEqual(tracker.summary().today.calls, 0, '今日应被清空');
    tracker.recordSuccess({ model: 'deepseek-chat', usage: { prompt_tokens: 100, completion_tokens: 10 } });
    tracker.reset('all');
    assert.strictEqual(tracker.summary().today.calls, 0);
    assert.strictEqual(tracker.summary().total.calls, 0, '全部应被清空');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await test('支持自定义价目表，未知模型有兜底', () => {
    const flash = { input: 1.1, output: 4.3 };
    assert.deepStrictEqual(priceOf('deepseek-flash', null), flash);
    assert.deepStrictEqual(priceOf('deepseek-flash-0813', null), flash, '前缀匹配应生效');
    // 旧名字（官方已停用、请求被路由到 flash）也要能算出个数
    assert.deepStrictEqual(priceOf('deepseek-chat', null), flash);
    assert.deepStrictEqual(priceOf('未知模型', null), flash, '未知模型应回退默认价');
    const custom = { 'my-model': { input: 1, output: 2 } };
    assert.deepStrictEqual(priceOf('my-model', custom), { input: 1, output: 2 });
  });

  await test('金额显示不会出现难看的小数', () => {
    assert.strictEqual(formatMoney(0), '0');
    assert.strictEqual(formatMoney(0.0023), '0.0023');
    assert.strictEqual(formatMoney(0.123), '0.123');
    assert.strictEqual(formatMoney(1.2345), '1.23');
  });

  console.log('\n安全自动暂停');

  await test('连续失败达到阈值会自动暂停并清空队列', async () => {
    const fake = await startFakeLlm(() => ({ status: 401, json: { error: { message: 'Authentication Fails' } } }));
    const store = makeStore({ api: { baseUrl: fake.baseUrl }, safety: { maxConsecutiveFailures: 2 } });
    const copilot = new Copilot({ store, logger: makeLogger() });

    const pausedEvents = [];
    copilot.on('paused', (payload) => pausedEvents.push(payload));

    // 第一次失败
    const first = waitFor(copilot, 'error');
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('第一次', '甲', 1)));
    await first;
    assert.strictEqual(copilot.paused, false, '一次失败不应暂停');

    // 第二次失败 → 触发暂停
    const second = waitFor(copilot, 'error');
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('第二次', '乙', 2)));
    await second;
    assert.strictEqual(copilot.paused, true, '连续两次失败应自动暂停');
    assert.ok(copilot.pausedReason.includes('连续'), `暂停原因不明确: ${copilot.pausedReason}`);
    assert.strictEqual(pausedEvents.length, 1, '应发出 paused 事件');
    fake.server.close();
  });

  await test('暂停后不再发起请求', async () => {
    const fake = await startFakeLlm(() => ({ status: 401, json: { error: { message: 'nope' } } }));
    const store = makeStore({ api: { baseUrl: fake.baseUrl }, safety: { maxConsecutiveFailures: 1 } });
    const copilot = new Copilot({ store, logger: makeLogger() });

    const first = waitFor(copilot, 'error');
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('触发暂停', '甲', 1)));
    await first;
    assert.strictEqual(copilot.paused, true);

    const callsBefore = fake.received.length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('暂停后再说', '乙', 2)));
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.strictEqual(fake.received.length, callsBefore, '暂停后不应再调用接口');
    fake.server.close();
  });

  await test('恢复后能继续正常回复', async () => {
    let call = 0;
    const fake = await startFakeLlm(() => {
      call += 1;
      if (call === 1) return { status: 500, json: { error: { message: 'boom' } } };
      return okReply('恢复成功');
    });
    const store = makeStore({ api: { baseUrl: fake.baseUrl }, safety: { maxConsecutiveFailures: 1 } });
    const copilot = new Copilot({ store, logger: makeLogger() });

    const err = waitFor(copilot, 'error');
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('第一条', '甲', 1)));
    await err;
    assert.strictEqual(copilot.paused, true);

    copilot.resume('测试恢复');
    assert.strictEqual(copilot.paused, false);

    const reply = waitFor(copilot, 'reply');
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('第二条', '乙', 2)));
    const result = await reply;
    assert.strictEqual(result.text, '恢复成功');
    fake.server.close();
  });

  await test('关掉安全开关后连续失败也不暂停', async () => {
    const fake = await startFakeLlm(() => ({ status: 500, json: { error: { message: 'boom' } } }));
    const store = makeStore({
      api: { baseUrl: fake.baseUrl },
      safety: { autoPauseOnError: false, maxConsecutiveFailures: 1 }
    });
    const copilot = new Copilot({ store, logger: makeLogger() });
    for (let i = 0; i < 2; i += 1) {
      const err = waitFor(copilot, 'error');
      copilot.onDanmaku(parseViaClient(realDanmakuCmd(`第${i}条`, '甲', i + 1)));
      // eslint-disable-next-line no-await-in-loop
      await err;
    }
    assert.strictEqual(copilot.paused, false, '关掉开关后不应暂停');
    fake.server.close();
  });

  await test('手动暂停 / 恢复会收到事件', async () => {
    const copilot = new Copilot({ store: makeStore(), logger: makeLogger() });
    const events = [];
    copilot.on('paused', (payload) => events.push(payload));
    copilot.pause('手动测试');
    assert.strictEqual(copilot.paused, true);
    copilot.resume('手动恢复');
    assert.strictEqual(copilot.paused, false);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].paused, true);
    assert.strictEqual(events[1].paused, false);
  });

  console.log('\n主动搭话');

  await test('手动让她搭一句：走正常回复链路，回复标成 proactive', async () => {
    const fake = await startFakeLlm(() => okReply('那我们聊聊最近在玩什么游戏吧'));
    const store = makeStore({
      api: { baseUrl: fake.baseUrl },
      proactive: { enabled: false, prompt: '随便聊聊' }
    });
    const copilot = new Copilot({ store, logger: makeLogger() });

    const replyPromise = waitFor(copilot, 'reply');
    await copilot.warmupNow();
    const reply = await replyPromise;
    assert.strictEqual(reply.text, '那我们聊聊最近在玩什么游戏吧');
    assert.strictEqual(reply.source, 'proactive', '手动搭话也要标成 proactive（界面/统计据此区分）');
    // 完整指令是这一轮的 user 消息（最后一条），记忆里只留那句短的
    const content = fake.received[0].messages.slice(-1)[0].content;
    assert.ok(content.includes('主动开口'), `搭话提示词没有带过去: ${content.slice(0, 160)}`);
    assert.ok(content.includes('随便聊聊'), '主播写的搭话规矩要带进提示词');
    assert.ok(
      copilot.history.some((item) => item.kind === 'proactive' && item.content.length < 40),
      '记忆里要留一条短的（说明是自己搭的话）'
    );
    fake.server.close();
  });

  await test('开启主动搭话后：会挂冷场计时器；触发时自己开口并重新计时', async () => {
    const fake = await startFakeLlm(() => okReply('有人在吗'));
    const store = makeStore({
      api: { baseUrl: fake.baseUrl },
      proactive: { enabled: true, idleSeconds: 30, chancePercent: 100, maxPerHour: 6 }
    });
    const copilot = new Copilot({ store, logger: makeLogger() });
    copilot.scheduleProactive();
    assert.ok(copilot.proactiveTimer, '开启后应设冷场计时器');

    // 冷场时间最小 30 秒，测试不真等：直接走触发路径，验证触发本身
    const proactiveEvent = waitFor(copilot, 'proactive', 5000);
    const reply = await copilot.triggerProactive();
    const event = await proactiveEvent;
    assert.ok(reply && reply.source === 'proactive', '应产出 proactive 回复');
    assert.ok(['topic', 'ask', 'follow'].includes(event.mode), `方式应是三种之一：${event.mode}`);
    assert.ok(copilot.proactiveTimer, '说完之后要重新挂上计时器');
    assert.strictEqual(copilot.proactiveTimes.length, 1, '要说的话要记一次（限频用）');
    fake.server.close();
  });

  await test('关着主动搭话：不挂计时器，也不会自己开口', async () => {
    const fake = await startFakeLlm(() => okReply('不该被调用'));
    const copilot = new Copilot({
      store: makeStore({ api: { baseUrl: fake.baseUrl }, proactive: { enabled: false } }),
      logger: makeLogger()
    });
    copilot.scheduleProactive();
    assert.strictEqual(copilot.proactiveTimer, null, '关闭时不应设定时器');
    const result = await copilot.triggerProactive();
    assert.strictEqual(result, null, '关着的时候普通触发不该说话');
    fake.server.close();
  });

  await test('模型回「[跳过]」：这条不发、不计次数、也不留在记忆里', async () => {
    const fake = await startFakeLlm(() => ({
      json: {
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: '[跳过] 现在有人在说话，不适合插嘴' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }
    }));
    const store = makeStore({ api: { baseUrl: fake.baseUrl }, proactive: { enabled: true, chancePercent: 100 } });
    const copilot = new Copilot({ store, logger: makeLogger() });
    let replies = 0;
    copilot.on('reply', () => {
      replies += 1;
    });
    const result = await copilot.triggerProactive();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(result, null, '跳过就不该产出回复');
    assert.strictEqual(replies, 0, '跳过就不能发出去');
    assert.strictEqual(copilot.proactiveTimes.length, 0, '跳过不计入次数');
    assert.ok(!copilot.history.some((item) => item.kind === 'proactive'), '跳过时那条记忆要撤掉');
    fake.server.close();
  });

  await test('每小时上限：说够了普通触发不说话；手动强制也不越过上限', async () => {
    const fake = await startFakeLlm(() => okReply('再说一句'));
    const store = makeStore({
      api: { baseUrl: fake.baseUrl },
      proactive: { enabled: true, chancePercent: 100, maxPerHour: 1 }
    });
    const copilot = new Copilot({ store, logger: makeLogger() });
    copilot.proactiveTimes = [Date.now()];
    assert.strictEqual(await copilot.triggerProactive(), null, '到上限后普通触发不该说话');
    assert.strictEqual(await copilot.warmupNow(), null, '手动强制也受上限约束（免得按着按钮刷屏）');
    // 把记录清掉就能说了
    copilot.proactiveTimes = [];
    const reply = await copilot.warmupNow();
    assert.ok(reply && reply.source === 'proactive');
    fake.server.close();
  });

  await test('进场事件已经没有入口了（「进场招呼」和礼物/进场解析 2026-10-21 一起删掉）', async () => {
    const fake = await startFakeLlm(() => okReply('欢迎欢迎'));
    const copilot = new Copilot({
      store: makeStore({ api: { baseUrl: fake.baseUrl }, proactive: { enabled: true, chancePercent: 100 } }),
      logger: makeLogger()
    });
    copilot.on('error', () => {});
    // 这条连接收不到 INTERACT_WORD，所以连解析带事件入口都删了：既不该进队列，也不该搭话
    assert.strictEqual(typeof copilot.onEventMessage, 'undefined', 'onEventMessage 应该已经删掉');
    assert.strictEqual(copilot.queue.length, 0);
    assert.strictEqual(copilot.proactiveRunning, false);
    copilot.pause('测试收尾，别真的去回复');
    fake.server.close();
  });

  await test('搭话期间有人说话：这条作废（不抢话、不发出去）', async () => {
    // 把模型调用挂住：给测试留出"说话期间来弹幕"的窗口（比真等网络稳）
    const fake = await startFakeLlm(() => okReply('这句不该发出去'));
    const store = makeStore({ api: { baseUrl: fake.baseUrl }, proactive: { enabled: true, chancePercent: 100 } });
    const copilot = new Copilot({ store, logger: makeLogger() });
    let release = null;
    copilot.llm.chatWithRetry = () => new Promise((resolve) => {
      release = resolve;
    });
    copilot.on('error', () => {});
    let replies = 0;
    copilot.on('reply', () => {
      replies += 1;
    });
    const pending = copilot.triggerProactive();
    // 等它真的走到"调模型"这一步（release 被赋值）
    while (!release) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 让出几毫秒：真机上"生成中"至少是几百毫秒，同毫秒内到达的弹幕不算"期间"
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 这期间观众说话了
    copilot.enqueue({ type: 'danmaku', user: '甲', text: '我来了', ts: Date.now() });
    release({ content: '这句不该发出去', attempts: [{ empty: false }], latencyMs: 5, usage: null });
    const result = await pending;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.strictEqual(result, null, '有人说话之后搭话要作废');
    assert.strictEqual(replies, 0, '作废的搭话不能发出去');
    fake.server.close();
  });

  console.log('\n对话导出');

  await test('导出内容包含对话双方，且注明时间', async () => {
    const fake = await startFakeLlm(() => okReply('第一条回复'));
    const copilot = new Copilot({ store: makeStore({ api: { baseUrl: fake.baseUrl } }), logger: makeLogger() });
    const reply = waitFor(copilot, 'reply');
    copilot.onDanmaku(parseViaClient(realDanmakuCmd('你好呀', '小明', 1)));
    await reply;

    const text = copilot.exportHistory();
    assert.ok(text.includes('对话记录'), '缺少标题');
    assert.ok(text.includes('小明'), `应包含观众弹幕: ${text.slice(0, 200)}`);
    assert.ok(text.includes('第一条回复'), '应包含 AI 回复');
    assert.ok(text.includes('搭档'), '应标明说话人');
    fake.server.close();
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
