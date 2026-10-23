'use strict';

/**
 * 知识库「整理 / 校对 / 更新」的**纯函数**部分（提示词、解析、选目标、判改动）
 *   node scripts/test-review.js
 *
 * 这里不联网、不写盘：只验证「模型输出 → 建议条目」这条最容易出错的链路。
 * 真机踩过的教训（和 parseDrafts 那次同一个）：模型会把 `类型：` 写成 `**类型：**`、
 * 把正文写成好几行、把 id 抄错——解析必须宽容，但**宁可丢一条，也不能应用错一条**。
 */

const assert = require('assert');

const {
  REVIEW_THINKING,
  DEFAULT_VERIFY_LIMIT,
  normaliseKind,
  briefNote,
  auditNotes,
  buildAuditPrompt,
  buildVerifyPrompt,
  parseReviewItems,
  parseVerifyAnswer,
  selectVerifyTargets,
  noteChangedSince,
  describeChange
} = require('../src/main/review');

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

/** 造一条笔记 */
function note(id, title, content, extra = {}) {
  return {
    id,
    title,
    content,
    tags: extra.tags || [],
    updated: extra.updated || '2026-10-01T00:00:00.000Z',
    enabled: true,
    locked: Boolean(extra.locked)
  };
}

(async () => {
  console.log('知识库整理/校对：提示词与解析\n');

  await test('思考档位用最高档（主播要的是 "最高的思考等级"）', () => {
    assert.strictEqual(REVIEW_THINKING, 'max');
  });

  await test('摘要卡：正文截断、标签拼成逗号串、locked 透传', () => {
    const brief = briefNote(note('k-1', '茶区划分', '一'.repeat(400), { tags: ['茶', '地理'], locked: true }));
    assert.strictEqual(brief.id, 'k-1');
    assert.strictEqual(brief.tags, '茶,地理');
    assert.strictEqual(brief.locked, true);
    assert.strictEqual(brief.chars, 400);
    assert.ok(brief.excerpt.length <= 301, `摘要应该截断，实际 ${brief.excerpt.length}`);
    assert.ok(brief.excerpt.endsWith('…'));
  });

  await test('整理只把没锁的条目给模型看（锁了的不许被建议改动）', () => {
    const list = auditNotes([note('k-1', 'a', 'x'), note('k-2', 'b', 'y', { locked: true })]);
    assert.deepStrictEqual(list.map((item) => item.id), ['k-1']);
  });

  await test('整理提示词：带 id / 标题 / 摘要，且锁住的条目一个字都不出现', () => {
    const { system, user } = buildAuditPrompt(
      [note('k-1', '中国茶区划分', '中国分四大茶区……'), note('k-2', '秘密条目', '这句话不该出现', { locked: true })],
      { today: '2026-10-19' }
    );
    assert.ok(system.includes('===建议==='), system.slice(0, 60));
    assert.ok(user.includes('k-1'), '要带 id 才能回指');
    assert.ok(user.includes('中国茶区划分'));
    assert.ok(user.includes('2026-10-19'));
    assert.ok(!user.includes('秘密条目'), '锁住的条目不该进提示词');
    assert.ok(!user.includes('这句话不该出现'));
  });

  await test('校对提示词：笔记全文 + 搜索结果（站点/日期/链接都在），最多 5 条', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      title: `结果${i + 1}`,
      site_name: `站点${i + 1}`,
      date: '2026-10-18',
      summary: `摘要${i + 1}`,
      url: `https://example.com/${i + 1}`
    }));
    const { system, user } = buildVerifyPrompt({
      note: note('k-1', '茶区划分', '中国分四大茶区。'),
      results,
      today: '2026-10-19'
    });
    assert.ok(system.includes('无需改动'));
    assert.ok(user.includes('中国分四大茶区。'), '要带正文全文，不能只给摘要');
    assert.ok(user.includes('结果1'));
    assert.ok(user.includes('https://example.com/1'), '依据要带链接');
    assert.ok(!user.includes('结果6'), '最多给 5 条，多了是浪费 token');
  });

  await test('解析：标准建议块 → 一条 rewrite（正文多行也能拼回来）', () => {
    const raw = [
      '===建议===',
      '类型：改写',
      '条目：k-abc',
      '标题：中国茶区划分（修正版）',
      '标签：茶,地理',
      '正文：第一行。',
      '第二行还在正文里。',
      '理由：原文把二级茶区写成了四个'
    ].join('\n');
    const items = parseReviewItems(raw, { knownIds: ['k-abc'] });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'rewrite');
    assert.deepStrictEqual(items[0].noteIds, ['k-abc']);
    assert.strictEqual(items[0].title, '中国茶区划分（修正版）');
    assert.strictEqual(items[0].tags, '茶,地理');
    assert.ok(items[0].content.includes('第二行还在正文里'), items[0].content);
    assert.ok(items[0].reason.includes('二级茶区'));
  });

  await test('解析：宽容 `**类型：**` / `# 条目：` / 全角逗号的 id 列表', () => {
    const raw = [
      '=== 建议 ===',
      '**类型：**合并',
      '# 条目：k-a，k-b',
      '**标题：**合并后的标题',
      '**正文：**合并后的正文内容',
      '**理由：**两条说的是同一件事'
    ].join('\n');
    const items = parseReviewItems(raw, { knownIds: ['k-a', 'k-b'] });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].kind, 'merge');
    assert.deepStrictEqual(items[0].noteIds, ['k-a', 'k-b']);
    assert.strictEqual(items[0].content, '合并后的正文内容');
  });

  await test('解析：删除建议可以没有正文；没写类型时按内容猜', () => {
    const del = parseReviewItems('===建议===\n条目：k-a\n理由：没用\n', { knownIds: ['k-a'] });
    assert.strictEqual(del.length, 1);
    assert.strictEqual(del[0].kind, 'delete');
    // 没类型 + 有正文 → 改写
    assert.strictEqual(normaliseKind('', ['k-a'], '正文'), 'rewrite');
    // 没类型 + 多条 id → 合并
    assert.strictEqual(normaliseKind('', ['k-a', 'k-b'], '正文'), 'merge');
    // 没类型 + 没正文 → 删除
    assert.strictEqual(normaliseKind('', ['k-a'], ''), 'delete');
  });

  await test('解析：指向不存在条目的建议直接丢掉（不能等到"应用"才发现）', () => {
    const raw = '===建议===\n类型：改写\n条目：k-不存在\n正文：随便\n理由：x';
    assert.deepStrictEqual(parseReviewItems(raw, { knownIds: ['k-a'] }), []);
    // 一条里一半 id 有效：保留有效的那些
    const mixed = parseReviewItems('===建议===\n类型：合并\n条目：k-a,k-zzz\n正文：合并后\n理由：x', {
      knownIds: ['k-a']
    });
    assert.deepStrictEqual(mixed[0].noteIds, ['k-a']);
  });

  await test('解析：模型什么都没提（或只输出解释）→ 零条建议，不报错', () => {
    assert.deepStrictEqual(parseReviewItems('', {}), []);
    assert.deepStrictEqual(parseReviewItems('库里很干净，没有需要改的。', {}), []);
    // 说"改写"却不给正文 → 没法应用，丢掉
    assert.deepStrictEqual(parseReviewItems('===建议===\n类型：改写\n条目：k-a\n理由：x', { knownIds: ['k-a'] }), []);
  });

  await test('解析：多块建议一条不落（模型一口气给出好几条）', () => {
    const raw = [
      '===建议===',
      '类型：改写',
      '条目：k-a',
      '正文：A 的新正文',
      '理由：改 A',
      '',
      '===建议===',
      '类型：删除',
      '条目：k-b',
      '理由：重复了'
    ].join('\n');
    const items = parseReviewItems(raw, { knownIds: ['k-a', 'k-b'] });
    assert.strictEqual(items.length, 2);
    assert.deepStrictEqual(items.map((item) => item.kind), ['rewrite', 'delete']);
  });

  await test('校对回答：结论块 →「无需改动」+ 理由', () => {
    const answer = parseVerifyAnswer('===结论===\n结果：无需改动\n理由：资料和笔记一致', { noteId: 'k-a' });
    assert.strictEqual(answer.verdict, 'unchanged');
    assert.ok(answer.reason.includes('一致'));
    assert.strictEqual(answer.item, null);
  });

  await test('校对回答：建议块 → changed + 可应用的建议', () => {
    const raw = '===建议===\n类型：改写\n条目：k-a\n标题：新标题\n正文：新正文\n理由：资料显示价格变了';
    const answer = parseVerifyAnswer(raw, { noteId: 'k-a' });
    assert.strictEqual(answer.verdict, 'changed');
    assert.strictEqual(answer.item.noteIds[0], 'k-a');
    assert.strictEqual(answer.item.content, '新正文');
  });

  await test('校对回答：模型胡言乱语 → 当「无需改动」（宁可不动）', () => {
    const answer = parseVerifyAnswer('我不确定，可能吧。', { noteId: 'k-a' });
    assert.strictEqual(answer.verdict, 'unchanged');
    assert.strictEqual(answer.item, null);
  });

  await test('选目标：跳过锁定的、默认按「最久没更新」优先、超出上限要如实截断', () => {
    const notes = [
      note('k-new', '新', 'x', { updated: '2026-10-18T00:00:00.000Z' }),
      note('k-old', '老', 'y', { updated: '2026-01-01T00:00:00.000Z' }),
      note('k-locked', '锁', 'z', { locked: true }),
      note('k-mid', '中', 'w', { updated: '2026-06-01T00:00:00.000Z' })
    ];
    const plan = selectVerifyTargets({ notes, limit: 2 });
    assert.deepStrictEqual(plan.targets.map((item) => item.id), ['k-old', 'k-mid']);
    assert.deepStrictEqual(plan.skippedLocked.map((item) => item.id), ['k-locked']);
    assert.strictEqual(plan.truncated, 1);
    assert.strictEqual(plan.total, 3);
    // 默认上限从常量来
    assert.strictEqual(selectVerifyTargets({ notes }).targets.length, Math.min(DEFAULT_VERIFY_LIMIT, 3));
  });

  await test('选目标：指定了 ids 就按指定顺序；不存在 / 锁定的分别记账', () => {
    const notes = [note('k-a', 'a', 'x'), note('k-b', 'b', 'y'), note('k-c', 'c', 'z', { locked: true })];
    const plan = selectVerifyTargets({ notes, ids: ['k-b', 'k-c', 'k-zzz', 'k-a'], limit: 5 });
    assert.deepStrictEqual(plan.targets.map((item) => item.id), ['k-b', 'k-a']);
    assert.deepStrictEqual(plan.skippedLocked.map((item) => item.id), ['k-c']);
    assert.deepStrictEqual(plan.missing, ['k-zzz']);
    assert.strictEqual(plan.truncated, 0);
  });

  await test('应用前校验：生成建议之后条目被改过 → 不许应用（免得盖掉手改）', () => {
    const before = { title: 't', content: '正文', tags: ['a', 'b'] };
    assert.strictEqual(noteChangedSince(before, { title: 't', content: '正文', tags: 'a,b' }), false);
    assert.strictEqual(noteChangedSince(before, { title: 't2', content: '正文', tags: ['a', 'b'] }), true);
    assert.strictEqual(noteChangedSince(before, { title: 't', content: '改了', tags: ['a', 'b'] }), true);
    assert.strictEqual(noteChangedSince(before, { title: 't', content: '正文', tags: ['a'] }), true);
    // 没有旧快照 = 不安全
    assert.strictEqual(noteChangedSince(null, { title: 't' }), true);
  });

  await test('界面文案：说清改了标题 / 标签 / 正文多少字 / 删几条', () => {
    const rewrite = describeChange({
      kind: 'rewrite',
      before: { title: '旧标题', content: '一'.repeat(100), tags: ['a'] },
      after: { title: '新标题', content: '二'.repeat(120), tags: ['a'] }
    });
    assert.ok(rewrite.includes('标题'), rewrite);
    assert.ok(rewrite.includes('100 → 120'), rewrite);
    const remove = describeChange({ kind: 'delete', before: { title: 'x', content: 'y' }, after: {} });
    assert.ok(remove.includes('删掉'), remove);
    const merge = describeChange({
      kind: 'merge',
      noteIds: ['k-a', 'k-b'],
      dropIds: ['k-b'],
      before: { title: 'a', content: 'x', tags: [] },
      after: { title: 'a', content: 'x', tags: [] }
    });
    assert.ok(merge.includes('删除') || merge.includes('删掉'), merge);
    assert.strictEqual(describeChange(null), '');
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
