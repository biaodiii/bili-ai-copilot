'use strict';

/**
 * 知识库测试（本地文件，不联网、不消耗额度）
 *   node scripts/test-knowledge.js
 *
 * 覆盖：文件格式往返 / 检索质量（相关命中、无关不命中）/ 停用 / 删除 /
 * 手工改文件生效 / 坏文件不影响整库 / 注入片段的字数上限。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  KnowledgeBase,
  parseNote,
  serialiseNote,
  normaliseTags,
  slugify,
  KNOWLEDGE_MARKER,
  KNOWLEDGE_DIR_NAME,
  KB_README_FILE,
  defaultKnowledgeDir,
  migrateKnowledgeDir
} = require('../src/main/knowledge');

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

/** 每个用例一个临时目录：绝不碰 data/knowledge */
function makeKb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
  const kb = new KnowledgeBase({ dir, logger: { warn() {}, info() {}, error() {} } });
  kb.load();
  return { kb, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function seed(kb) {
  kb.add({
    title: '直播间的梗：吃白饭',
    content: '观众发「吃白饭」是调侃主播白拿工资不干活，回一句自嘲就好。',
    tags: '梗,弹幕'
  });
  kb.add({
    title: '商品：大肥鱼玩偶',
    content: '大肥鱼玩偶 39 元，今晚直播下单送贴纸。库存 200 件。',
    tags: '商品,价格'
  });
  kb.add({
    title: '口播稿开场',
    content: '大家好，我是你们的老朋友，今天带来一款超好用的产品。',
    tags: '口播'
  });
}

(async () => {
  console.log('知识库测试\n');

  await test('一个条目 = 一个 md 文件，front-matter 能原样读回来', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '标题', content: '正文内容', tags: 'a,b', source: '测试' });
      const files = fs.readdirSync(path.join(dir, 'notes'));
      assert.strictEqual(files.length, 1, `应该只生成一个文件，实际 ${files.join(',')}`);
      const raw = fs.readFileSync(path.join(dir, 'notes', files[0]), 'utf8');
      assert.ok(raw.startsWith('---'), '文件应该以 front-matter 开头');
      assert.ok(raw.includes('id: '), 'front-matter 里要有 id');
      assert.ok(raw.includes('正文内容'), '正文要写进去');

      const again = new KnowledgeBase({ dir });
      again.load();
      const back = again.get(entry.id);
      assert.strictEqual(back.title, '标题');
      assert.strictEqual(back.content, '正文内容');
      assert.deepStrictEqual(back.tags, ['a', 'b']);
      assert.strictEqual(back.source, '测试');
      assert.strictEqual(back.enabled, true);
    } finally {
      cleanup();
    }
  });

  await test('新增后立刻能查到（回归：内存索引没刷新会让新条目消失到重启）', () => {
    const { kb, cleanup } = makeKb();
    try {
      assert.strictEqual(kb.size, 0);
      kb.add({ title: '直播间的梗：吃白饭', content: '观众发吃白饭是调侃主播' });
      assert.strictEqual(kb.size, 1, '新增后 size 应该立刻变 1');
      assert.strictEqual(kb.search('吃白饭').length, 1, '新增后应该立刻能检索到');
    } finally {
      cleanup();
    }
  });

  await test('相关提问命中，无关提问不注入（弱命中不算证据）', () => {
    const { kb, cleanup } = makeKb();
    try {
      seed(kb);
      const hit = kb.context('大肥鱼多少钱', { maxEntries: 3, maxChars: 300 });
      assert.ok(hit.hits.length >= 1, '相关提问应该命中');
      assert.ok(hit.text.includes('大肥鱼'), '注入片段里应该有正文');

      const none = kb.context('今天天气怎么样', { maxEntries: 3, maxChars: 300 });
      assert.strictEqual(none.hits.length, 0, `无关提问不该注入，实际命中了 ${JSON.stringify(none.hits)}`);
      assert.strictEqual(none.text, '', '没命中时不该返回任何文本');

      // 但检索接口本身还能看到这条「弱命中」，方便界面解释为什么没注入
      const weak = kb.search('今天天气怎么样');
      assert.ok(weak.length >= 1, '检索应该仍能列出弱命中');
      assert.strictEqual(weak[0].strong, false, '弱命中要被标成不注入');
    } finally {
      cleanup();
    }
  });

  await test('标题/标签命中比正文命中更管用，弱命中被相对阈值砍掉', () => {
    const { kb, cleanup } = makeKb();
    try {
      kb.add({ title: '礼物相关', content: '有人送礼物要说谢谢', tags: '礼物' });
      kb.add({ title: '随便一条', content: '礼物这个词只在正文里出现一次' });

      // minRatio: 0 = 不做相对筛选，纯粹看权重：标题/标签命中的必须排在前面
      const all = kb.search('礼物', { minRatio: 0 });
      assert.strictEqual(all.length, 2, '两条都该被检索到');
      assert.strictEqual(all[0].entry.title, '礼物相关', '标题/标签命中的应该排前面');
      assert.strictEqual(all[0].titleHit, true);
      assert.strictEqual(all[1].titleHit, false);

      // 默认阈值下，「只有正文蹭到一次」的弱命中会被砍掉——这是故意的：
      // 库里几百条时，沾一个词就被列出来只会制造噪音、白花 token
      const strict = kb.search('礼物');
      assert.strictEqual(strict.length, 1, `弱命中该被砍掉，实际还剩 ${strict.length} 条`);
      assert.strictEqual(strict[0].entry.title, '礼物相关');
    } finally {
      cleanup();
    }
  });

  await test('停用的条目不参与检索（但 includeDisabled 能查到）', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '临时条目', content: '喵喵喵' });
      assert.strictEqual(kb.search('喵喵喵').length, 1);
      kb.update(entry.id, { enabled: false });
      assert.strictEqual(kb.search('喵喵喵').length, 0, '停用后不该再命中');
      assert.strictEqual(kb.search('喵喵喵', { includeDisabled: true }).length, 1);
      assert.strictEqual(kb.stats().enabled, 0);
      assert.strictEqual(kb.stats().count, 1, '停用不等于删除');
    } finally {
      cleanup();
    }
  });

  await test('删除会连文件一起删掉', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '待删', content: 'x' });
      assert.strictEqual(fs.readdirSync(path.join(dir, 'notes')).length, 1);
      assert.strictEqual(kb.remove(entry.id), true);
      assert.strictEqual(fs.readdirSync(path.join(dir, 'notes')).length, 0, '文件没删掉');
      assert.strictEqual(kb.size, 0);
      assert.strictEqual(kb.remove('不存在的 id'), false);
    } finally {
      cleanup();
    }
  });

  await test('用记事本改了文件，重新读取就生效', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '旧标题', content: '旧正文' });
      const file = path.join(dir, 'notes', fs.readdirSync(path.join(dir, 'notes'))[0]);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('旧标题', '新标题'), 'utf8');
      const fresh = new KnowledgeBase({ dir });
      fresh.load();
      assert.strictEqual(fresh.get(entry.id).title, '新标题');
    } finally {
      cleanup();
    }
  });

  await test('坏文件 / 没有 front-matter 的文件不会弄垮整个库', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      kb.add({ title: '好条目', content: '正常内容' });
      // 手工丢两个「不规矩」的文件进去
      fs.writeFileSync(path.join(dir, 'notes', '没有front-matter.md'), '就是一段纯文本', 'utf8');
      fs.writeFileSync(path.join(dir, 'notes', '空的.md'), '', 'utf8');
      const fresh = new KnowledgeBase({ dir, logger: { warn() {}, info() {}, error() {} } });
      fresh.load();
      assert.strictEqual(fresh.size, 3, `三个文件都该被读进来，实际 ${fresh.size}`);
      const plain = fresh.list().find((item) => item.title === '没有front-matter');
      assert.ok(plain, '没有 front-matter 的文件也要能当条目用');
      assert.strictEqual(plain.content, '就是一段纯文本');
      assert.strictEqual(fresh.search('正常内容').length, 1, '正常条目不受影响');
    } finally {
      cleanup();
    }
  });

  await test('注入片段有字数上限，塞不下的条目直接丢掉', () => {
    const { kb, cleanup } = makeKb();
    try {
      for (let i = 0; i < 5; i += 1) {
        kb.add({ title: `知识${i}`, content: `关键词甲 后面跟着很长很长的内容${'啊'.repeat(200)}` });
      }
      const short = kb.context('关键词甲', { maxEntries: 5, maxChars: 120 });
      assert.ok(short.hits.length < 5, `字数上限应该砍掉一些条目，实际注入了 ${short.hits.length} 条`);
      assert.ok(short.text.length <= 200, `注入文本不该超太多，实际 ${short.text.length} 字`);
      assert.ok(short.text.includes(KNOWLEDGE_MARKER), '注入片段要带标记（对话展示靠它切掉资料）');
    } finally {
      cleanup();
    }
  });

  await test('标签和文件名的边界处理', () => {
    assert.deepStrictEqual(normaliseTags('a, b、c d'), ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual(normaliseTags(['x', 'x', ' y ']), ['x', 'y'], '重复标签要去掉');
    assert.strictEqual(normaliseTags('').length, 0);
    assert.strictEqual(slugify('标题/带:非法*字符?'), '标题-带-非法-字符', '文件名里的非法字符要替换掉');
    assert.strictEqual(slugify(''), 'note', '空标题要有兜底名字');
    assert.strictEqual(slugify('a'.repeat(80)).length, 30, 'slug 要截断');

    // front-matter 往返
    const text = serialiseNote({
      id: 'k1',
      title: '标题',
      tags: ['a', 'b'],
      source: 's',
      created: 'c',
      updated: 'u',
      enabled: false,
      content: '正文'
    });
    const parsed = parseNote(text);
    assert.strictEqual(parsed.meta.id, 'k1');
    assert.strictEqual(parsed.meta.enabled, 'false');
    assert.strictEqual(parsed.body, '正文');
  });

  // ---------------------------------------------------------------- 目录位置与迁移
  //
  // 这一组守的是「知识库 = 软件目录里那个看得见的文件夹」：
  // 它同时是 DSH 的工作区，所以位置不能飘、老数据不能丢。

  await test('默认位置就是软件目录下的「知识库」', () => {
    assert.strictEqual(KNOWLEDGE_DIR_NAME, '知识库', '目录名要能一眼认出来');
    assert.strictEqual(defaultKnowledgeDir('D:\\app'), path.join('D:\\app', '知识库'));
    assert.strictEqual(defaultKnowledgeDir('D:\\app\\'), path.join('D:\\app', '知识库'), '结尾的斜杠不该影响结果');
  });

  await test('第一次启动把老位置 data/knowledge 搬进「知识库」，旧目录改名留着', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-move-'));
    const from = path.join(root, 'data', 'knowledge');
    const to = path.join(root, '知识库');
    try {
      fs.mkdirSync(path.join(from, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(from, 'pending'), { recursive: true });
      fs.mkdirSync(path.join(from, 'inbox'), { recursive: true });
      const note = serialiseNote({
        id: 'k1',
        title: '杀戮尖塔',
        tags: ['游戏'],
        source: '手工',
        created: '2026-01-01T00:00:00.000Z',
        updated: '2026-01-01T00:00:00.000Z',
        content: '第一层精英怪别硬碰。'
      });
      fs.writeFileSync(path.join(from, 'notes', 'note.md'), note, 'utf8');
      fs.writeFileSync(path.join(from, 'pending', 'p1.json'), '{"id":"p1","title":"草稿"}', 'utf8');
      fs.writeFileSync(path.join(from, 'inbox', '资料.txt'), '待整理的一段资料', 'utf8');

      const result = migrateKnowledgeDir({ from, to });
      assert.strictEqual(result.ok, true, `迁移该成功：${JSON.stringify(result)}`);
      assert.strictEqual(result.migrated, true, '有东西就该真的搬');
      assert.strictEqual(result.copied, 3, `三个文件都该过去，实际 ${result.copied}`);

      // 内容一字不差
      assert.strictEqual(fs.readFileSync(path.join(to, 'notes', 'note.md'), 'utf8'), note);
      assert.strictEqual(fs.readFileSync(path.join(to, 'inbox', '资料.txt'), 'utf8'), '待整理的一段资料');
      // 新位置能当知识库读
      const kb = new KnowledgeBase({ dir: to, logger: { warn() {}, info() {}, error() {} } });
      kb.load();
      assert.strictEqual(kb.size, 1, '搬过来的条目要能被检索到');
      assert.strictEqual(kb.listPending().length, 1, '待审草稿也要一起过去');
      // 旧目录改名留着（不删：万一用户想核对）
      assert.ok(!fs.existsSync(from), '旧位置不该再留着同名目录');
      assert.ok(result.backup && fs.existsSync(result.backup), '旧目录应该改名留一份');
      // 中转目录不能留下
      assert.ok(!fs.existsSync(`${to}.migrating`), '中转目录要清掉');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('「知识库」里已经有条目就不覆盖，两边都不动', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-keep-'));
    const from = path.join(root, 'data', 'knowledge');
    const to = path.join(root, '知识库');
    try {
      fs.mkdirSync(path.join(from, 'notes'), { recursive: true });
      fs.mkdirSync(path.join(to, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(from, 'notes', 'old.md'), '老条目', 'utf8');
      fs.writeFileSync(path.join(to, 'notes', 'new.md'), '新条目', 'utf8');

      const result = migrateKnowledgeDir({ from, to });
      assert.strictEqual(result.ok, true, '不算失败，只是不搬');
      assert.strictEqual(result.migrated, false, '目标里已经有东西就不该搬');
      assert.strictEqual(fs.readFileSync(path.join(to, 'notes', 'new.md'), 'utf8'), '新条目');
      assert.deepStrictEqual(fs.readdirSync(path.join(to, 'notes')), ['new.md'], '不该混进老条目');
      assert.strictEqual(fs.readFileSync(path.join(from, 'notes', 'old.md'), 'utf8'), '老条目', '旧目录原样不动');
      assert.ok(!result.backup, '没搬就不该产生备份目录');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('复制失败就整块回退：不留半份数据，旧目录原样', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fail-'));
    const from = path.join(root, 'data', 'knowledge');
    const to = path.join(root, '知识库');
    try {
      fs.mkdirSync(path.join(from, 'notes'), { recursive: true });
      fs.writeFileSync(path.join(from, 'notes', 'a.md'), '内容 A', 'utf8');
      fs.writeFileSync(path.join(from, 'notes', 'b.md'), '内容 B', 'utf8');

      const result = migrateKnowledgeDir({
        from,
        to,
        // 第二个文件开始失败，模拟「拷到一半出错」
        copyFile: (src, dest) => {
          if (String(src).endsWith('b.md')) throw new Error('磁盘满了');
          fs.copyFileSync(src, dest);
        }
      });
      assert.strictEqual(result.ok, false, '有文件没拷过去就该报失败');
      assert.strictEqual(result.migrated, false);
      assert.ok(!fs.existsSync(to), '失败时不能把半份数据留在新位置');
      assert.ok(!fs.existsSync(`${to}.migrating`), '中转目录也要清掉');
      assert.strictEqual(fs.readFileSync(path.join(from, 'notes', 'b.md'), 'utf8'), '内容 B', '旧目录必须原样');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('老位置没有东西时什么都不做（新用户不该看到旧目录）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-none-'));
    try {
      const result = migrateKnowledgeDir({ from: path.join(root, 'data', 'knowledge'), to: path.join(root, '知识库') });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.migrated, false);
      assert.strictEqual(result.copied, 0);
      assert.ok(!fs.existsSync(path.join(root, '知识库')), '没东西搬就别乱建目录（布局由知识库自己建）');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('知识库目录里自动建好 notes / pending / inbox 和一份说明', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      for (const name of ['notes', 'pending', 'inbox']) {
        assert.ok(fs.existsSync(path.join(dir, name)), `${name} 目录要自动建好（DSH 要往里放东西）`);
      }
      const readme = path.join(dir, KB_README_FILE);
      assert.ok(fs.existsSync(readme), '要有一份人看得懂的说明');
      const text = fs.readFileSync(readme, 'utf8');
      assert.ok(text.includes('DSH'), '说明里要写清楚 DSH 会在这个文件夹里干活');
      assert.strictEqual(kb.size, 0, '说明文件不能被当成知识条目');
      assert.strictEqual(kb.stats().dir, dir, 'stats 要给出知识库根目录（界面要显示它）');
      assert.strictEqual(kb.stats().inboxDir, path.join(dir, 'inbox'));
    } finally {
      cleanup();
    }
  });

  // ------------------------------------------------ 她自己改库（改错 / 扩写）

  await test('她自己改一条知识：正文换掉、front-matter 保住、旧版本留了备份', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '终末地', content: '2025 年公测的 3D 续作。', tags: '游戏' });
      const before = fs.readFileSync(entry.file, 'utf8');

      const result = kb.applyEdit(entry.id, {
        content: '2026 年 1 月公测的 3D 续作，玩法是四人小队实时战斗。',
        reason: '公测时间写错了',
        kind: 'edit',
        source: '她自己改的'
      });
      assert.strictEqual(result.changed, true);
      assert.ok(result.backup && result.backup.file, '要留下备份的路径');
      assert.strictEqual(result.entry.content.includes('2026 年 1 月'), true, '内存里也要立刻是新的');

      const after = fs.readFileSync(entry.file, 'utf8');
      assert.ok(after.startsWith('---\n'), 'front-matter 不能被弄丢');
      assert.ok(after.includes(`id: ${entry.id}`), 'id 不能变');
      assert.ok(after.includes('tags: 游戏'), '标签不能丢');
      assert.ok(after.includes('2026 年 1 月公测'), '正文要是新的');
      assert.ok(!after.includes('2025 年公测的 3D 续作'), '旧正文不该还留着');
      assert.strictEqual(fs.readFileSync(result.backup.file, 'utf8'), before, '备份必须是改之前的原文');

      // 索引要立刻更新：不然直播里注入的还是旧内容
      assert.ok(kb.get(entry.id).content.includes('2026 年 1 月'));
      assert.ok(kb.search('终末地公测时间').some((hit) => hit.entry.id === entry.id));
    } finally {
      cleanup();
    }
  });

  await test('改库有下限：空正文、明显变短的正文、没变化的都拒绝或跳过', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '大肥鱼玩偶', content: '大肥鱼玩偶 39 元，下单送贴纸，库存 200 件。', tags: '商品' });

      // 一律**返回结果**而不是抛（改库流水线要拿 reason 说给主播听）
      const empty = kb.applyEdit(entry.id, { content: '   ' });
      assert.strictEqual(empty.ok, false, '空正文必须拒绝');
      assert.ok(/空/.test(empty.reason || ''), `理由要说清楚：${empty.reason}`);

      const same = kb.applyEdit(entry.id, { content: entry.content });
      assert.strictEqual(same.ok, true);
      assert.strictEqual(same.changed, false, '一模一样就不写盘（免得刷一堆无意义的备份）');

      const shrink = kb.applyEdit(entry.id, { content: '39 元。' });
      assert.strictEqual(shrink.ok, false, '只留一小截等于把知识删了，必须拒绝');
      assert.ok(/太短|缩/.test(shrink.reason || ''), `理由要说清楚：${shrink.reason}`);

      const missing = kb.applyEdit('k-不存在', { content: '随便什么' });
      assert.strictEqual(missing.ok, false);
      assert.ok(/没找到|没有/.test(missing.reason || ''), `要给出理由：${missing.reason}`);

      // 被拒绝之后文件不能被动过
      assert.strictEqual(kb.get(entry.id).content, '大肥鱼玩偶 39 元，下单送贴纸，库存 200 件。');
    } finally {
      cleanup();
    }
  });

  await test('她改过的能撤销：撤销之后一个字都不差地回到改之前', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '联动安排', content: '下周六晚八点和隔壁联动直播。', tags: '安排' });
      const original = fs.readFileSync(entry.file, 'utf8');

      kb.applyEdit(entry.id, { content: '下周六晚八点和隔壁联动直播，主题是《杀戮尖塔》。', kind: 'expand' });
      assert.ok(kb.get(entry.id).content.includes('杀戮尖塔'));

      const edits = kb.listEdits();
      const mine = edits.filter((item) => item.kind === 'expand' || item.kind === 'edit');
      assert.strictEqual(mine.length, 1, `应该有 1 次「她改的」记录，实际 ${mine.length}（全部：${edits.map((e) => e.kind).join('/')}）`);
      assert.strictEqual(mine[0].noteId, entry.id);
      assert.strictEqual(mine[0].kind, 'expand');
      assert.strictEqual(mine[0].undone, false);

      const undone = kb.undoEdit(mine[0].id);
      assert.strictEqual(undone.ok, true, undone.reason);
      assert.strictEqual(fs.readFileSync(entry.file, 'utf8'), original, '撤销后文件要跟原来一模一样');
      assert.strictEqual(kb.get(entry.id).content, '下周六晚八点和隔壁联动直播。');
      const after = kb.listEdits().find((item) => item.id === mine[0].id);
      assert.strictEqual(after.undone, true, '撤销过要标出来（界面按钮要变成「已撤销」）');
    } finally {
      cleanup();
    }
  });

  await test('撤销还能救回被删掉的条目（删除也先留备份）', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '要删的条目', content: '这条待会儿要被删掉。', tags: '' });
      assert.strictEqual(kb.remove(entry.id), true);
      assert.ok(!kb.get(entry.id), '删掉之后就不该还在库里');

      const edits = kb.listEdits();
      assert.ok(edits.length >= 1, '删除也该留一条记录');
      const removed = edits.find((item) => item.kind === 'remove');
      assert.ok(removed, `要有 kind=remove 的记录：${edits.map((e) => e.kind).join('/')}`);

      const undone = kb.undoEdit(removed.id);
      assert.strictEqual(undone.ok, true, undone.reason);
      assert.ok(kb.get(entry.id), '撤销之后条目要回来');
      assert.strictEqual(kb.get(entry.id).content, '这条待会儿要被删掉。');
    } finally {
      cleanup();
    }
  });

  await test('她自己新建一条知识：直接入库、记一笔「create」、撤销就是删掉它', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      const result = kb.applyCreate({
        title: '下周六晚八点与隔壁联动直播',
        content: '下周六（10/24）晚八点和隔壁联动直播，主题是《杀戮尖塔》。',
        tags: '安排',
        reason: '直播间里定下来的',
        source: '她自己记的'
      });
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.created, true, '库里本来没有，就该新建');
      const entry = result.entry;
      assert.ok(entry && kb.get(entry.id), '新建的条目要立刻能用（直播里马上会检索到）');
      assert.ok(fs.existsSync(entry.file), '文件要真的落盘');
      assert.strictEqual(fs.readFileSync(entry.file, 'utf8').includes('杀戮尖塔'), true);

      const edits = kb.listEdits();
      const created = edits.find((item) => item.kind === 'create');
      assert.ok(created, `要有一条 kind=create 的记录：${edits.map((e) => e.kind).join('/')}`);
      assert.strictEqual(created.noteId, entry.id);

      const undone = kb.undoEdit(created.id);
      assert.strictEqual(undone.ok, true, undone.reason);
      assert.ok(!kb.get(entry.id), '撤销「她新建的」= 把这条删掉');
      assert.ok(!fs.existsSync(entry.file), '文件也要删掉');
    } finally {
      cleanup();
    }
  });

  await test('新建前先查重：已经有相关条目就不新建，改成给它补一句（省得同一件事两条）', () => {
    const { kb, cleanup } = makeKb();
    try {
      const existing = kb.add({
        title: '《杀戮尖塔》',
        content: '《杀戮尖塔》是卡牌构筑 + Roguelike 的单机爬塔游戏，Steam 国区 88 元。',
        tags: '游戏'
      });
      const result = kb.applyCreate({
        title: '《杀戮尖塔》售价',
        content: '《杀戮尖塔》Steam 国区售价 88 元，常年打折。',
        tags: '游戏'
      });
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.created, false, '有相关条目就不该再新建一条');
      assert.strictEqual(result.merged, true, '应该合并进已有条目');
      assert.strictEqual(kb.size, 1, `库里应该还是 1 条，实际 ${kb.size}`);
      assert.ok(kb.get(existing.id).content.includes('常年打折'), '新内容要补进那条里');
      assert.ok(fs.existsSync(existing.file));
    } finally {
      cleanup();
    }
  });

  await test('你手动改的也留记录、也能撤销（手滑改错不是没救）', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '大肥鱼玩偶', content: '大肥鱼玩偶 39 元，下单送贴纸，库存 200 件。', tags: '商品' });
      kb.update(entry.id, { content: '大肥鱼玩偶 39 元（我改坏了这一行）。' });
      const edits = kb.listEdits();
      const manual = edits.find((item) => item.kind === 'manual');
      assert.ok(manual, `手动编辑也要留一条记录：${edits.map((e) => e.kind).join('/')}`);
      assert.strictEqual(kb.undoEdit(manual.id).ok, true);
      assert.strictEqual(kb.get(entry.id).content, '大肥鱼玩偶 39 元，下单送贴纸，库存 200 件。');
    } finally {
      cleanup();
    }
  });

  await test('锁定（只读）：写进 front-matter、读回来还在、统计里有数', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '只读条目', content: '这段不许模型改。', tags: '纪律', locked: true });
      assert.strictEqual(entry.locked, true);
      assert.ok(fs.readFileSync(entry.file, 'utf8').includes('locked: true'), 'front-matter 里要有 locked: true');
      // 重新扫盘（模拟重启）也要读得回来
      kb.load();
      assert.strictEqual(kb.get(entry.id).locked, true);
      assert.strictEqual(kb.stats().locked, 1);
      // 没锁的条目不许被无端写成 locked: false（老文件保持原样）
      const plain = kb.add({ title: '普通条目', content: '随便。' });
      assert.strictEqual(fs.readFileSync(plain.file, 'utf8').includes('locked'), false);
      assert.strictEqual(kb.isLocked(plain.id), false);
    } finally {
      cleanup();
    }
  });

  await test('锁定（只读）：模型改不动它，解锁之后才能改；并回收缩不做合并目标', () => {
    const { kb, cleanup } = makeKb();
    try {
      const locked = kb.add({ title: '大肥鱼玩偶价格', content: '大肥鱼玩偶 39 元，常年这个价。', tags: '商品', locked: true });
      // 她自己改（applyEdit）：锁着 → 拒绝，且**内容一个字都不动**
      const refused = kb.applyEdit(locked.id, { content: '大肥鱼玩偶 39 元，涨价到 45 元了。' });
      assert.strictEqual(refused.ok, false);
      assert.ok(/只读/.test(refused.reason), refused.reason);
      assert.strictEqual(kb.get(locked.id).content, '大肥鱼玩偶 39 元，常年这个价。');
      // 她记一条新知识时：命中的那条锁着 → 不许并进去（改成新建）
      const remembered = kb.applyCreate({ title: '大肥鱼玩偶', content: '大肥鱼玩偶 39 元，下单送贴纸。' });
      assert.strictEqual(remembered.ok, true, remembered.reason);
      assert.strictEqual(remembered.merged, false, '锁着的条目不能当合并目标');
      assert.strictEqual(kb.size, 2);
      // 解锁之后想怎么改就怎么改
      kb.update(locked.id, { locked: false });
      assert.strictEqual(kb.isLocked(locked.id), false);
      const edited = kb.applyEdit(locked.id, { content: '大肥鱼玩偶 39 元，涨价到 45 元了。' });
      assert.strictEqual(edited.ok, true, edited.reason);
      assert.ok(kb.get(locked.id).content.includes('45 元'));
    } finally {
      cleanup();
    }
  });

  await test('整理校对改库：改动记录里能认出 source=整理校对（撤销才有据可查）', () => {
    const { kb, cleanup } = makeKb();
    try {
      const entry = kb.add({ title: '大肥鱼玩偶价格', content: '大肥鱼玩偶 39 元。' });
      kb.update(entry.id, { content: '大肥鱼玩偶 39 元，小号 29 元。' }, { kind: 'review', reason: '补上小号价格', source: '整理校对' });
      const edits = kb.listEdits();
      const record = edits.find((item) => item.noteId === entry.id && item.source === '整理校对');
      assert.ok(record, `记录要带上来源：${JSON.stringify(edits[0])}`);
      assert.strictEqual(record.hasBackup, true);
      assert.ok(fs.existsSync(record.file));
    } finally {
      cleanup();
    }
  });

  // ------------------------------------------------ 待审草稿：通过 / 丢弃 / 批量

  await test('待审草稿：通过才进知识库；丢弃只删草稿；两种都留得下痕迹', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      const draft = kb.addPending({ title: '星轨杯', content: '星轨杯是本周的活动。', tags: '活动', engine: 'dsh' });
      assert.strictEqual(kb.listPending().length, 1);
      assert.ok(fs.existsSync(path.join(dir, 'pending', `${draft.id}.json`)));
      // 通过 → 进知识库 + 草稿消失 + 留一条「新建」记录（能撤销）
      const entry = kb.approvePending(draft.id, {});
      assert.ok(entry && entry.id, '通过要返回写进库的条目');
      assert.strictEqual(kb.listPending().length, 0, '通过之后草稿要删掉');
      assert.ok(kb.list().some((item) => item.title === '星轨杯'), '通过的内容要在知识库里');
      assert.ok(
        kb.listEdits().some((record) => record.noteId === entry.id && record.kind === 'create'),
        '通过要留一条 create 记录（事后能撤销）'
      );
      // 丢弃 → 知识库不动
      const draft2 = kb.addPending({ title: '不该进库的', content: '这条会被丢掉。', engine: 'dsh' });
      const sizeBefore = kb.size;
      assert.strictEqual(kb.rejectPending(draft2.id), true);
      assert.strictEqual(kb.listPending().length, 0);
      assert.strictEqual(kb.size, sizeBefore, '丢弃不能动知识库');
      // 不存在的草稿：通过要抛错（界面能显示原因），丢弃返回 false
      assert.throws(() => kb.approvePending('p-不存在'), /没有这条待审草稿/);
      assert.strictEqual(kb.rejectPending('p-不存在'), true, '删不存在的文件不算失败（rmSync force）');
    } finally {
      cleanup();
    }
  });

  await test('清空待审：草稿全删、知识库一条不动、失败会点名', () => {
    const { kb, dir, cleanup } = makeKb();
    try {
      kb.add({ title: '已有的知识', content: '这条本来就在库里。' });
      const drafts = [
        kb.addPending({ title: '草稿一', content: '内容一' }),
        kb.addPending({ title: '草稿二', content: '内容二' }),
        kb.addPending({ title: '草稿三', content: '内容三' })
      ];
      assert.strictEqual(kb.listPending().length, 3);
      const sizeBefore = kb.size;
      const result = kb.clearPending();
      assert.strictEqual(result.removed, 3, `三条都该删掉：${JSON.stringify(result)}`);
      assert.deepStrictEqual(result.failed, []);
      assert.strictEqual(kb.listPending().length, 0);
      assert.strictEqual(kb.size, sizeBefore, '清空待审不许碰知识库');
      assert.ok(kb.list().some((item) => item.title === '已有的知识'));
      assert.ok(!fs.existsSync(path.join(dir, 'pending', `${drafts[0].id}.json`)));
      // 目录里只该剩草稿文件被删掉这件事本身，别的文件（比如说明/笔记）不受影响
      const notes = fs.readdirSync(path.join(dir, 'notes'));
      assert.ok(notes.length >= 1, '知识库文件还在');
      // 再清一次：没有草稿时就是 0 条，不报错
      assert.deepStrictEqual(kb.clearPending(), { removed: 0, failed: [] });
    } finally {
      cleanup();
    }
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
