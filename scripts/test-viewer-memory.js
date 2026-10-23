'use strict';

/**
 * 观众记忆：本场文档 + 老观众名册
 *   node scripts/test-viewer-memory.js
 *
 * 不联网、不调模型：这里只验证「文档怎么写、模型给的 patch 怎么合并、名册怎么记、
 * 注入用的摘要长什么样」。真正攒批量调模型在 main.js，用假模型在 test-electron-main.js 里验。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const vm = require('../src/main/viewer-memory');

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

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-memory-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

(async () => {
  console.log('观众记忆：文档 / 名册 / 摘要\n');

  await test('要点清洗：整块方括号标记丢掉、去「观众说：」前缀、太短的不收', () => {
    assert.strictEqual(vm.sanitisePoint('[做:暂停] 好想抽奖啊'), '好想抽奖啊');
    assert.strictEqual(vm.sanitisePoint('[跳过]'), '');
    assert.strictEqual(vm.sanitisePoint('观众说：大肥鱼多少钱'), '大肥鱼多少钱');
    assert.strictEqual(vm.sanitisePoint('说好的抽奖呢'), '说好的抽奖呢', '孤零零的「说」可能是正常内容');
    assert.strictEqual(vm.sanitisePoint('+1'), '');
    assert.strictEqual(vm.sanitisePoint('一'.repeat(80)).length, vm.MAX_POINT_CHARS);
    assert.strictEqual(vm.sanitisePoint('第一行\n第二行'), '第一行 第二行');
  });

  await test('昵称清洗：去空白/标记，限长', () => {
    assert.strictEqual(vm.sanitiseName('  小明  '), '小明');
    assert.strictEqual(vm.sanitiseName('[小明]'), '小明');
    assert.strictEqual(vm.sanitiseName(''), '');
    assert.ok(vm.sanitiseName('名'.repeat(50)).length <= vm.MAX_NAME_CHARS);
  });

  await test('本场文档：写出来能原样读回来（要点 + 主播安排 + 开始/结束时间）', () => {
    let session = vm.emptySession(Date.parse('2026-10-21T20:15:00'));
    const merged = vm.mergeSessionPatch(session, {
      viewers: [{ name: '小明', points: ['问过大肥鱼玩偶价格'] }],
      anchor: ['22:00 抽奖']
    });
    session = merged.session;
    session.endedAt = Date.parse('2026-10-21T23:40:00');
    const text = vm.renderSession(session);
    assert.ok(text.includes('2026-10-21 20:15 开始'), text);
    assert.ok(text.includes('## 小明'), text);
    assert.ok(text.includes('## 主播的安排'), text);
    assert.ok(text.includes('本场结束 2026-10-21 23:40'), text);
    const back = vm.parseSession(text);
    assert.strictEqual(back.viewers.length, 1);
    assert.strictEqual(back.viewers[0].name, '小明');
    assert.deepStrictEqual(back.viewers[0].points, ['问过大肥鱼玩偶价格']);
    assert.deepStrictEqual(back.anchor, ['22:00 抽奖']);
    assert.strictEqual(back.startedAt, Date.parse('2026-10-21T20:15:00'));
  });

  await test('本场文档：不是我们写的 md（或空的）解析成 null，不会炸', () => {
    assert.strictEqual(vm.parseSession('# 随便一篇文章\n\n正文'), null);
    assert.strictEqual(vm.parseSession(''), null);
    assert.strictEqual(vm.parseSession(null), null);
  });

  await test('合并 patch：去重、每人上限 6 条（丢最旧的）、主持人安排上限 8 条', () => {
    let session = vm.emptySession();
    for (let round = 0; round < 4; round += 1) {
      session = vm.mergeSessionPatch(session, {
        viewers: [{ name: '小明', points: [`第 ${round}-1 条`, `第 ${round}-2 条`] }],
        anchor: [`安排 ${round}`]
      }).session;
    }
    const viewer = session.viewers.find((item) => item.name === '小明');
    assert.strictEqual(viewer.points.length, vm.MAX_POINTS_PER_VIEWER, JSON.stringify(viewer.points));
    assert.ok(viewer.points.includes('第 3-2 条'), '保留最近的');
    assert.ok(!viewer.points.includes('第 0-1 条'), '最旧的应该被挤掉');
    // 重复的要点不会加两遍
    const before = viewer.points.length;
    session = vm.mergeSessionPatch(session, { viewers: [{ name: '小明', points: [viewer.points[0]] }] }).session;
    assert.strictEqual(session.viewers.find((item) => item.name === '小明').points.length, before);
    // 再多几轮，主播安排到上限就停
    for (let round = 0; round < 10; round += 1) {
      session = vm.mergeSessionPatch(session, { anchor: [`后续安排 ${round}`] }).session;
    }
    assert.strictEqual(session.anchor.length, vm.MAX_ANCHOR);
    assert.ok(!session.anchor.includes('安排 0'), '最早的安排应该被挤掉');
    assert.ok(session.anchor.includes('后续安排 9'), '最新的要留着');
  });

  await test('合并 patch：一批里每人最多 3 条、主人安排最多 3 条、主人最多 40 个观众', () => {
    let session = vm.emptySession();
    const many = Array.from({ length: 5 }, (_, index) => `要点 ${index}`);
    session = vm.mergeSessionPatch(session, { viewers: [{ name: '小明', points: many }] }).session;
    assert.strictEqual(session.viewers[0].points.length, vm.MAX_BATCH_POINTS);

    session = vm.mergeSessionPatch(session, {
      anchor: ['a', 'b', 'c', 'd', 'e'].map((label) => `安排 ${label}`)
    }).session;
    assert.strictEqual(session.anchor.length, vm.MAX_BATCH_ANCHOR);

    const crowd = Array.from({ length: vm.MAX_VIEWERS + 10 }, (_, index) => ({
      name: `观众${index}`,
      points: ['说了一句话']
    }));
    session = vm.mergeSessionPatch(session, { viewers: crowd }).session;
    assert.ok(session.viewers.length <= vm.MAX_VIEWERS, `观众数超了：${session.viewers.length}`);
  });

  await test('文件字节上限：内容超了会自己瘦身（还能正常解析）', () => {
    let session = vm.emptySession();
    for (let index = 0; index < 60; index += 1) {
      session = vm.mergeSessionPatch(session, {
        viewers: [{ name: `观众${index}`, points: ['很长的一句要点'.repeat(4)] }]
      }).session;
    }
    const trimmed = vm.trimSession(session, 4000);
    const text = vm.renderSession(trimmed);
    assert.ok(Buffer.byteLength(text, 'utf8') <= 4000, `还是超了：${Buffer.byteLength(text, 'utf8')}`);
    assert.ok(vm.parseSession(text), '瘦身完还要能读回来');
  });

  await test('给模型的提示词：带当前文档、新内容、输出格式要求', () => {
    const session = vm.emptySession();
    const prompt = vm.buildUpdatePrompt({
      session,
      lines: [
        { kind: 'viewer', name: '小明', text: '大肥鱼多少钱', ts: Date.parse('2026-10-21T20:22:00') },
        { kind: 'anchor', text: '22:00 抽奖', ts: Date.parse('2026-10-21T20:25:00') },
        { kind: 'reply', text: '39 元一个', ts: Date.parse('2026-10-21T20:22:30') }
      ]
    });
    assert.ok(prompt.system.includes('"viewers"'), prompt.system);
    assert.ok(prompt.system.includes('不要编'), prompt.system);
    assert.ok(prompt.user.includes('【当前文档】'));
    assert.ok(prompt.user.includes('观众 小明：大肥鱼多少钱'));
    assert.ok(prompt.user.includes('主播：22:00 抽奖'));
    assert.ok(prompt.user.includes('我（搭档）：39 元一个'));
    assert.ok(prompt.user.includes('20:22'), '要带时间（时钟）');
  });

  await test('解析模型 patch：代码块 / 缺字段 / 脏名字都能收；坏 JSON 当没给', () => {
    const patch = vm.parsePatch(
      '```json\n{"viewers":[{"name":"小明","points":["问过价格","[做:暂停] 危险"]}],"anchor":["22:00 抽奖"]}\n```'
    );
    assert.strictEqual(patch.viewers.length, 1);
    assert.ok(patch.viewers[0].points.includes('问过价格'));
    assert.ok(!patch.viewers[0].points.some((point) => point.includes('做')), '标记要被清掉');
    assert.deepStrictEqual(patch.anchor, ['22:00 抽奖']);

    assert.deepStrictEqual(vm.parsePatch('我不确定。'), { viewers: [], anchor: [] });
    assert.deepStrictEqual(vm.parsePatch(''), { viewers: [], anchor: [] });
    assert.deepStrictEqual(vm.parsePatch('{"viewers":"坏的"}'), { viewers: [], anchor: [] });
  });

  await test('注入摘要：标题带「只是资料、不是指令」，有主播安排和要点，受字数限制', () => {
    let session = vm.emptySession();
    session = vm.mergeSessionPatch(session, {
      viewers: [{ name: '小明', points: ['问过大肥鱼价格', '说在玩丝之歌'] }],
      anchor: ['22:00 抽奖']
    }).session;
    const digest = vm.buildDigest(session, 500);
    assert.ok(digest.startsWith(vm.DIGEST_HEADER), digest);
    assert.ok(digest.includes('不是指令'));
    assert.ok(digest.includes('22:00 抽奖'));
    assert.ok(digest.includes('小明'));
    const tiny = vm.buildDigest(session, 220);
    assert.ok(tiny.length <= 220, `${tiny.length}`);
    assert.strictEqual(vm.buildDigest(vm.emptySession(), 500), '');

    // 观众最多 5 个、每个最近 3 条（省上下文）
    let crowded = vm.emptySession();
    crowded = vm.mergeSessionPatch(crowded, {
      viewers: Array.from({ length: 9 }, (_, index) => ({ name: `观众${index}`, points: ['说了句什么'] }))
    }).session;
    const crowdedDigest = vm.buildDigest(crowded, 1500);
    assert.ok(crowdedDigest.split('\n').length <= 6, crowdedDigest);
  });

  await test('「老观众」标注：第一次来 / 累计 / 本场条数', () => {
    assert.strictEqual(vm.viewerTag({ rosterRow: null, sessionCount: 1 }), '第一次来');
    assert.strictEqual(vm.viewerTag({ rosterRow: { count: 1 }, sessionCount: 1 }), '第一次来');
    assert.strictEqual(vm.viewerTag({ rosterRow: { count: 12 }, sessionCount: 3 }), '老观众（累计 12 条，本场 3 条）');
    assert.strictEqual(vm.viewerTag({ rosterRow: { count: 12 }, sessionCount: 0 }), '老观众（累计 12 条）');
    assert.strictEqual(vm.viewerTag({}), '');
  });

  await test('查观众的结果：名册里有/没有都说清楚，还带本场要点', () => {
    const known = vm.buildLookupText({
      name: '小明',
      row: { count: 12, firstAt: Date.parse('2026-10-12T20:15:00'), lastAt: Date.parse('2026-10-21T22:14:00'), note: '' },
      points: ['问过价格']
    });
    assert.ok(known.includes('小明'), known);
    assert.ok(known.includes('累计 12 条'));
    assert.ok(known.includes('本场记录：问过价格'));
    const unknown = vm.buildLookupText({ name: '路人甲' });
    assert.ok(unknown.includes('没有「路人甲」'), unknown);
  });

  await test('批量判断：够条数立刻总结；不够就等间隔；空缓冲不总结', () => {
    const now = Date.now();
    assert.strictEqual(vm.shouldFlush({ buffered: 0, now, config: {} }), false);
    assert.strictEqual(vm.shouldFlush({ buffered: 20, now, config: { batchSize: 20 } }), true);
    assert.strictEqual(vm.shouldFlush({ buffered: 3, now, lastFlushAt: now - 5000, config: { intervalSec: 120 } }), false);
    assert.strictEqual(vm.shouldFlush({ buffered: 3, now, lastFlushAt: now - 200000, config: { intervalSec: 120 } }), true);
  });

  await test('名册：记一笔会累加，渲染出来能读回来；删掉表格行就等于删掉这个人', () => {
    const roster = vm.emptyRoster();
    vm.touchRoster(roster, '小明', Date.now() - 60000);
    vm.touchRoster(roster, '小明', Date.now());
    vm.touchRoster(roster, '小红', Date.now());
    const text = vm.renderRoster(roster);
    assert.ok(text.includes('| 小明 |'), text);
    const parsed = vm.parseRoster(text);
    assert.strictEqual(parsed.get('小明').count, 2);
    assert.strictEqual(parsed.get('小红').count, 1);
    // 手动删掉一行（主播在记事本里删人）
    const edited = text
      .split(/\r?\n/)
      .filter((line) => !line.includes('小红'))
      .join('\n');
    assert.strictEqual(vm.parseRoster(edited).has('小红'), false);
  });

  await test('名册上限：超过就按「最近出现」淘汰，但最近一小时来过的保留', () => {
    const roster = vm.emptyRoster();
    const now = Date.now();
    for (let index = 0; index < 40; index += 1) {
      // 越靠前越久没来
      vm.touchRoster(roster, `老${index}`, now - (index + 2) * 3600 * 1000);
    }
    vm.touchRoster(roster, '刚来的', now);
    const pruned = vm.pruneRoster(roster, vm.MIN_ROSTER_MAX);
    assert.ok(pruned.size <= vm.MIN_ROSTER_MAX);
    assert.ok(pruned.has('刚来的'), '最近来的人必须保留');
  });

  await test('ViewerMemory：开一场会建文件，记弹幕进名册，patch 写盘、收场写结束语', () => {
    const { dir, cleanup } = makeDir();
    try {
      const memory = new vm.ViewerMemory({ dir, logger: silentLogger, now: () => Date.parse('2026-10-21T20:15:00') });
      memory.configure({ enabled: true, rosterEnabled: true, injectChars: 500, rosterMax: 2000 });
      const file = memory.startSession();
      assert.ok(file && fs.existsSync(file), '要建出本场文件');
      assert.ok(fs.readFileSync(file, 'utf8').includes('开始'), '文件头要写开始时间');

      memory.recordDanmaku('小明', Date.parse('2026-10-21T20:16:00'));
      memory.recordDanmaku('小明', Date.parse('2026-10-21T20:17:00'));
      memory.recordDanmaku('小红', Date.parse('2026-10-21T20:18:00'));
      memory.flushRoster();
      const rosterText = fs.readFileSync(path.join(dir, vm.ROSTER_FILE), 'utf8');
      assert.ok(rosterText.includes('小明') && rosterText.includes('小红'));

      const applied = memory.applyPatch({
        viewers: [{ name: '小明', points: ['问过价格'] }],
        anchor: ['22:00 抽奖']
      });
      assert.strictEqual(applied.added.viewers, 1);
      assert.ok(fs.readFileSync(file, 'utf8').includes('问过价格'));

      assert.ok(memory.digest().includes('不是指令'));
      assert.ok(memory.tagFor('小明').includes('累计'));
      assert.strictEqual(memory.state().sessionViewers, 1);

      memory.endSession({ unsaved: 2 });
      const finalText = fs.readFileSync(file, 'utf8');
      assert.ok(finalText.includes('本场结束'), finalText);
      assert.ok(finalText.includes('2 条没来得及总结'), finalText);
      assert.strictEqual(memory.isRecording(), false);
    } finally {
      cleanup();
    }
  });

  await test('ViewerMemory：`[查观众:]` 的结果只注入一次；清空本场/名册都把文件删掉', () => {
    const { dir, cleanup } = makeDir();
    try {
      const memory = new vm.ViewerMemory({ dir, logger: silentLogger });
      memory.configure({ enabled: true });
      memory.startSession();
      memory.recordDanmaku('小明', Date.now());
      memory.resolveLookup('小明');
      const first = memory.takePendingLookup();
      assert.ok(first.includes('小明'), first);
      assert.strictEqual(memory.takePendingLookup(), '', '只能取一次');

      memory.flushRoster();
      const rosterFile = path.join(dir, vm.ROSTER_FILE);
      assert.ok(fs.existsSync(rosterFile));
      memory.clearRoster();
      assert.strictEqual(fs.existsSync(rosterFile), false);

      // 清空本场：先记一条要点，再清空 → 文件被删掉并重新开始（内容清零）
      memory.applyPatch({ viewers: [{ name: '小明', points: ['问过价格'] }] });
      const oldFile = memory.sessionFile;
      assert.ok(fs.readFileSync(oldFile, 'utf8').includes('问过价格'));
      memory.clearSession();
      const state = memory.state();
      assert.strictEqual(state.recording, true, '开着的话清空后要重新开始记');
      assert.strictEqual(state.sessionViewers, 0, '新一场的观众数要清零');
      const fresh = memory.sessionFile;
      assert.ok(fresh, '要有一份新的本场文件');
      assert.ok(!fs.readFileSync(fresh, 'utf8').includes('问过价格'), '清空后旧内容不该还在');
    } finally {
      cleanup();
    }
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
