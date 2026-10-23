'use strict';

/**
 * 主动搭话的纯函数层：提示词 / 解析 / 选方式 / 限频判断
 *   node scripts/test-proactive.js
 *
 * 不联网、不起定时器：只验证「该不该说、说什么、模型那句话怎么解析」这几件最容易错的事。
 * 定时器和真正说话在 `test-features.js` 里用假 LLM 服务器验。
 */

const assert = require('assert');

const {
  MODES,
  MODE_LABELS,
  DEFAULT_IDLE_SECONDS,
  MIN_IDLE_SECONDS,
  MAX_IDLE_SECONDS,
  DEFAULT_MAX_PER_HOUR,
  DEFAULT_CHANCE,
  DEFAULT_MAX_CHARS,
  MIN_GAP_MS,
  HOUR_MS,
  DEFAULT_PROMPT,
  normaliseModes,
  countRecent,
  shouldSpeak,
  chooseMode,
  buildProactivePrompt,
  parseProactiveAnswer,
  describeUtterance
} = require('../src/main/proactive');

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

const baseConfig = (patch = {}) => ({
  enabled: true,
  idleSeconds: 180,
  maxPerHour: 6,
  chancePercent: 100,
  maxChars: 40,
  modes: MODES.slice(),
  useKnowledge: true,
  greetEnter: false,
  prompt: '',
  ...patch
});

(async () => {
  console.log('主动搭话：提示词与判定\n');

  await test('默认值都在合理范围里（界面和配置清洗都依赖它们）', () => {
    assert.ok(DEFAULT_IDLE_SECONDS >= MIN_IDLE_SECONDS && DEFAULT_IDLE_SECONDS <= MAX_IDLE_SECONDS);
    assert.ok(DEFAULT_CHANCE > 0 && DEFAULT_CHANCE <= 100);
    assert.ok(DEFAULT_MAX_CHARS >= 20 && DEFAULT_MAX_CHARS <= 120);
    assert.ok(DEFAULT_MAX_PER_HOUR >= 0);
    assert.ok(DEFAULT_PROMPT && DEFAULT_PROMPT.length > 5);
    assert.deepStrictEqual(MODES, ['topic', 'ask', 'follow']);
    // 只有这三种方式（「进场招呼」2026-10-21 删了：收不到进场事件）
    assert.deepStrictEqual(Object.keys(MODE_LABELS).sort(), ['ask', 'follow', 'topic']);
  });

  await test('方式表：没给/乱填 → 三种全开；给了就按给的来，顺序固定', () => {
    assert.deepStrictEqual(normaliseModes(undefined), ['topic', 'ask', 'follow']);
    assert.deepStrictEqual(normaliseModes('topic'), ['topic', 'ask', 'follow']);
    assert.deepStrictEqual(normaliseModes(['follow', 'ask', 'bogus']), ['ask', 'follow']);
    assert.deepStrictEqual(normaliseModes(['topic']), ['topic']);
    // 空数组 = 一种都不许（等于关掉），不能被当成"没设置"
    assert.deepStrictEqual(normaliseModes([]), []);
  });

  await test('限频计数只看这一小时内的', () => {
    const now = Date.now();
    const times = [now - 10, now - HOUR_MS - 1, now - 60 * 1000, 'x', null];
    assert.strictEqual(countRecent(times, now), 2);
    assert.strictEqual(countRecent(null, now), 0);
  });

  await test('该不该说：关着 / 说够了 / 抽签没过 / 太近 / 方式全关 都不说', () => {
    const now = Date.now();
    assert.strictEqual(shouldSpeak({ config: baseConfig({ enabled: false }), now }).reason, 'off');
    assert.strictEqual(
      shouldSpeak({ config: baseConfig({ maxPerHour: 1 }), now, times: [now - 1000] }).reason,
      'rate'
    );
    assert.strictEqual(
      shouldSpeak({ config: baseConfig({ chancePercent: 0 }), now, random: () => 0.5 }).reason,
      'chance'
    );
    assert.strictEqual(
      shouldSpeak({ config: baseConfig(), now, lastSpokeAt: now - 1000 }).reason,
      'gap'
    );
    assert.strictEqual(shouldSpeak({ config: baseConfig({ modes: [] }), now }).ok, false);
    assert.strictEqual(shouldSpeak({ config: baseConfig({ modes: [] }), now }).reason, 'nomode');
  });

  await test('该不该说：条件都满足就说；maxPerHour=0 表示不限', () => {
    const now = Date.now();
    assert.strictEqual(shouldSpeak({ config: baseConfig(), now }).ok, true);
    assert.strictEqual(shouldSpeak({ config: baseConfig({ maxPerHour: 0 }), now, times: Array(50).fill(now - 10) }).ok, true);
    // 抽签：random() < 100% 就一定过
    assert.strictEqual(shouldSpeak({ config: baseConfig({ chancePercent: 50 }), now, random: () => 0.1 }).ok, true);
    assert.strictEqual(shouldSpeak({ config: baseConfig({ chancePercent: 50 }), now, random: () => 0.9 }).reason, 'chance');
  });

  await test('删掉的「进场招呼」不许再冒出来（收不到进场事件，留着就是死功能）', () => {
    // 配置里就算手写了 greetEnter，也不该有任何效果
    const config = baseConfig({ greetEnter: true, chancePercent: 0 });
    assert.strictEqual(shouldSpeak({ config, now: Date.now() }).reason, 'chance', 'greetEnter 不再有特殊通道');
    assert.strictEqual(MODE_LABELS.greet, undefined, '方式表里不该再有 greet');
    const prompt = buildProactivePrompt({ mode: 'greet', config: baseConfig(), idleSeconds: 60 });
    assert.ok(prompt.text.includes('直播间很安静'), '就算传 greet 也只会走普通搭话，不再有「有人进场」那一套');
    assert.ok(!prompt.text.includes('有人进场'));
  });

  await test('选方式：尽量和上一次不同；只有一种就固定它；关光了返回空', () => {
    assert.strictEqual(chooseMode({ modes: MODES.slice(), lastMode: 'ask', random: () => 0 }).length > 0, true);
    const picked = chooseMode({ modes: MODES.slice(), lastMode: 'ask', random: () => 0 });
    assert.notStrictEqual(picked, 'ask', `不该又选 ask：${picked}`);
    assert.strictEqual(chooseMode({ modes: ['ask'], lastMode: 'ask' }), 'ask');
    assert.strictEqual(chooseMode({ modes: [], lastMode: '' }), '');
    // 上一次是唯一允许的那种 → 只能复用它
    assert.strictEqual(chooseMode({ modes: ['ask'], lastMode: 'topic' }), 'ask');
  });

  await test('搭话提示词：讲清"这次的方式"、字数、自定义规矩、最近聊过、说过什么、可以聊的料', () => {
    const { text, history } = buildProactivePrompt({
      mode: 'ask',
      config: baseConfig({ maxChars: 35, prompt: '别问隐私问题' }),
      idleSeconds: 200,
      recentLines: ['观众说：今天玩什么', '你说：在玩丝之歌'],
      lastUtterances: ['刚问过大家吃饭没'],
      knowledgeBlock: '· 丝之歌：8 月发售',
      viewer: ''
    });
    assert.ok(text.includes('直播间很安静'), text.slice(0, 60));
    assert.ok(text.includes('200 秒'), '要说清楚安静了多久');
    assert.ok(text.includes('问观众'), '要写清这次的方式');
    assert.ok(text.includes('35 字'), '字数上限要进提示词');
    assert.ok(text.includes('别问隐私问题'), '自定义规矩要原样带进去');
    assert.ok(text.includes('今天玩什么'), '最近聊过的要带上');
    assert.ok(text.includes('刚问过大家吃饭没'), '防复读的清单要带上');
    assert.ok(text.includes('8 月发售'), '可以聊的料要带上');
    assert.ok(text.includes('[跳过]'), '要教它"不该说话就跳过"');
    // 存进记忆的那句必须短、且不含资料（不然下次上下文里全是模板）
    assert.ok(history.length < 40, `记忆里那句太长了：${history}`);
    assert.ok(!history.includes('8 月发售'), '记忆里不该带资料');
  });

  await test('搭话提示词：没给资料就不出现资料段；记忆里那句是短的', () => {
    const { text, history } = buildProactivePrompt({
      mode: 'topic',
      config: baseConfig(),
      knowledgeBlock: ''
    });
    assert.ok(text.includes('直播间很安静'), text.slice(0, 60));
    assert.ok(!text.includes('【可以聊的料】'), '没有资料就不该出现资料段');
    assert.ok(history.includes('自己开口'), history);
  });

  await test('解析：正常一句话（去引号、去"台词："、只取第一行）', () => {
    assert.deepStrictEqual(parseProactiveAnswer('来聊聊今天玩什么吧'), {
      skip: false,
      reason: '',
      text: '来聊聊今天玩什么吧'
    });
    assert.strictEqual(parseProactiveAnswer('「你们今天玩什么呢」').text, '你们今天玩什么呢');
    assert.strictEqual(parseProactiveAnswer('台词：大家晚上好呀').text, '大家晚上好呀');
    assert.strictEqual(parseProactiveAnswer('```\n来聊两句\n```').text, '来聊两句');
    assert.strictEqual(parseProactiveAnswer('第一句。\n第二句不该出现').text, '第一句。');
  });

  await test('解析：[跳过] 就是这次不开口（理由可选）', () => {
    assert.strictEqual(parseProactiveAnswer('[跳过]').skip, true);
    const withReason = parseProactiveAnswer('[跳过]：现在有人正在说话');
    assert.strictEqual(withReason.skip, true);
    assert.ok(withReason.reason.includes('有人'));
    assert.strictEqual(parseProactiveAnswer('这句不重要 [跳过] 收尾').skip, true);
  });

  await test('解析：空 / 太长 / 像抄了提示词 → 都不发（problem）', () => {
    assert.ok(parseProactiveAnswer('').problem, '空内容要判为不可用');
    const long = '一'.repeat(200);
    const tooLong = parseProactiveAnswer(long, { maxChars: 40 });
    assert.ok(tooLong.problem && tooLong.problem.includes('太长'), tooLong.problem);
    assert.ok(parseProactiveAnswer('【硬要求】1. 说出口的只有一句话').problem);
    assert.ok(parseProactiveAnswer('（想了想）今天玩什么').problem, '旁白开头也要拦');
    // 边界：正好 2 倍以内可以发
    const ok = parseProactiveAnswer('二'.repeat(80), { maxChars: 40 });
    assert.strictEqual(ok.problem, undefined);
  });

  await test('日志文案：带上是哪种方式', () => {
    assert.ok(describeUtterance('ask', '今天玩什么').includes('问观众'));
    assert.ok(describeUtterance('unknown', 'x').includes('主动搭话'));
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
