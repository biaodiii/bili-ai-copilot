'use strict';

/**
 * 知识库：直播间自己的资料库（梗、商品信息、口播稿、常见问题……）。
 *
 * ## 为什么一条知识就是一个 markdown 文件
 *
 * 存储格式是这个功能里最重要的决定，选了「一个条目 = 一个 .md 文件（带 front-matter）」：
 *
 *   · **人能直接看、直接改**：出问题主播自己用记事本就能修，不用求程序；
 *   · **能被外部工具共用**：以后让 DSH（DeepSeek Harness）来整理知识时，它自带文件工具，
 *     直接读写这些 md 就行，不需要理解我们的私有格式；
 *   · **能备份、能同步**：一个目录拷走就是全部数据，不进数据库、不锁格式。
 *
 * 代价：检索要在内存里建索引（启动扫一遍目录）。几千条以内完全够用。
 *
 * ## 检索为什么是「2-gram + IDF」而不是向量
 *
 * 中文没有空格，分词是个大坑；而弹幕短、口语化、还全是梗，分词器切错反而更糟。
 * 这里用最朴素也最稳的办法：中文切成 2 字组（「直播间」→ 直播/播间/间…），
 * 英文数字按词，然后用 IDF 给稀有词加权、用长度归一化防止长条目霸榜。
 * 零依赖、可解释、几百条到几千条都是毫秒级。
 * 真的不够用了再上向量（那是另一件事，接口留在 `search()` 上）。
 */

const fs = require('fs');
const path = require('path');

/** front-matter：文件开头 `---` 包起来的那一段 */
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** 单个条目正文的上限（防止有人把一本书粘进来把提示词撑爆） */
const MAX_CONTENT_CHARS = 20000;
const MAX_TITLE_CHARS = 80;
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 20;

/** 标题和标签命中一次算几次（正文命中算 1 次） */
const TITLE_WEIGHT = 3;
const TAG_WEIGHT = 3;

/**
 * 注入提示词时那段附注的起始标记。
 * copilot.js 显示对话时也按它把资料切掉（只给模型看，不给观众看），
 * 所以这个字符串全项目只能有一处定义，别在别处再写一遍。
 */
const KNOWLEDGE_MARKER = '【知识库参考】';

/**
 * 软件目录里那个知识库文件夹的名字。
 * 用中文是为了「打开软件目录就能一眼看到」——它同时是 DSH 的工作区，
 * 主播得能自己打开、自己放文件进去。
 */
const KNOWLEDGE_DIR_NAME = '知识库';

/** 放在知识库根目录的说明文件（不是条目：条目只从 notes/ 读） */
const KB_README_FILE = '说明.txt';

const KB_README = `这里是「直播AI搭档」的知识库
================================

notes\\    一条知识 = 一个 .md 文件（带 front-matter），直接用记事本就能改。
pending\\  待审草稿：DSH 整理出来的东西先放这里，在软件里点「通过」才会进 notes\\。
inbox\\    要整理的资料丢这里（txt / md 都行），再让 DSH 去读。

备份 = 把整个「知识库」文件夹拷走；换电脑时拷回来即可。

⚠ 用 DSH 整理时，DSH 的工作区就被限定在这个文件夹里：
   它只能在这里读写文件，越界的读写会被 DSH 自己的沙箱拒绝。
`;

/** 软件目录 → 默认知识库目录（软件目录 = 放 data/ 的那一层） */
function defaultKnowledgeDir(appRoot) {
  return path.join(path.resolve(String(appRoot || '.')), KNOWLEDGE_DIR_NAME);
}

/** 目录里数得出东西吗（notes/pending/inbox 里任意一个文件都算） */
function dirHasContent(dir) {
  try {
    for (const name of ['notes', 'pending', 'inbox']) {
      const sub = path.join(dir, name);
      if (!fs.existsSync(sub)) continue;
      if (fs.readdirSync(sub).length) return true;
    }
    // 根目录下直接放的 md 也算（有人习惯把文件丢在最外层）
    return fs.readdirSync(dir).some((entry) => entry.toLowerCase().endsWith('.md'));
  } catch (_) {
    return false;
  }
}

/**
 * 把老位置（`data/knowledge`）里的东西搬进新的「知识库」目录。
 *
 * 三条规矩，都是拿数据安全换来的：
 *   · **不覆盖**：新目录里已经有条目就什么都不做（用户可能已经在新位置写过东西了）；
 *   · **不半途而废**：先拷进中转目录 `<新目录>.migrating`，全部成功才改名过去；
 *     任何一个文件失败就把中转目录整个删掉，让调用方继续用老目录；
 *   · **不删数据**：搬完把老目录改名成 `<老目录>.old-<时间戳>` 留着，让用户自己确认后删。
 *
 * @param {{from:string, to:string, logger?:object, copyFile?:Function, now?:Date}} options
 * @returns {{ok:boolean, migrated:boolean, copied:number, reason?:string, from:string, to:string, backup?:string}}
 */
function migrateKnowledgeDir({ from, to, logger, copyFile, now } = {}) {
  const source = path.resolve(String(from || ''));
  const target = path.resolve(String(to || ''));
  const copy = typeof copyFile === 'function' ? copyFile : fs.copyFileSync;
  const stamp = (now instanceof Date ? now : new Date()).toISOString().replace(/[:.]/g, '-');
  const result = { ok: true, migrated: false, copied: 0, from: source, to: target };

  let exists = false;
  try {
    exists = fs.existsSync(source) && fs.statSync(source).isDirectory();
  } catch (_) {
    exists = false;
  }
  if (!exists || !dirHasContent(source)) {
    result.reason = 'legacy-empty';
    return result;
  }
  if (dirHasContent(target)) {
    result.reason = 'target-not-empty';
    logger?.info?.(`知识库：老位置还有内容，但新位置已经有条目了，这次不搬（${target}）`);
    return result;
  }

  const staging = `${target}.migrating`;
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const name of ['notes', 'pending', 'inbox']) {
      const sub = path.join(source, name);
      if (!fs.existsSync(sub)) continue;
      const targetSub = path.join(staging, name);
      fs.mkdirSync(targetSub, { recursive: true });
      for (const file of fs.readdirSync(sub)) {
        const src = path.join(sub, file);
        if (!fs.statSync(src).isFile()) continue;
        copy(src, path.join(targetSub, file));
        result.copied += 1;
      }
    }
    // 全部成功才让新目录出现（改名在同一卷上是原子的）
    fs.renameSync(staging, target);
  } catch (error) {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch (_) {
      /* 清不掉也不影响：它只是带 .migrating 后缀的临时目录 */
    }
    result.ok = false;
    result.reason = `copy-failed: ${error.message}`;
    logger?.warn?.(`知识库：迁移失败（${error.message}），继续用老目录 ${source}`);
    return result;
  }

  // 搬完了：老目录改名留着（不删——万一用户想核对）
  try {
    const backup = `${source}.old-${stamp}`;
    fs.renameSync(source, backup);
    result.backup = backup;
  } catch (error) {
    logger?.warn?.(`知识库：老目录改名失败（${error.message}），内容已确认搬完，可以手工删掉 ${source}`);
  }
  result.migrated = true;
  return result;
}

function normaliseTags(tags) {
  const list = Array.isArray(tags)
    ? tags
    : String(tags == null ? '' : tags)
        .split(/[,，、\s]+/)
        .filter(Boolean);
  const out = [];
  for (const item of list) {
    const text = String(item).trim().slice(0, MAX_TAG_CHARS);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** 把标题变成能当文件名用的 slug（中文保留，去掉路径非法字符） */
function slugify(title, fallback = 'note') {
  const text = String(title || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 30);
  return text || fallback;
}

/** 极简的 front-matter 解析：`key: value`，值里的换行用 `|` 折行写法也支持 */
function parseNote(text) {
  const source = String(text || '');
  const match = source.match(FRONT_MATTER_RE);
  const meta = {};
  let body = source;
  if (match) {
    body = source.slice(match[0].length);
    let lastKey = '';
    for (const rawLine of match[1].split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      if (!line.trim()) continue;
      const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (kv) {
        lastKey = kv[1];
        meta[lastKey] = kv[2].trim();
      } else if (lastKey) {
        // 折行续写
        meta[lastKey] = `${meta[lastKey]} ${line.trim()}`.trim();
      }
    }
  }
  return { meta, body: body.replace(/^\r?\n+/, '').trimEnd() };
}

/** 写回文件时的序列化（值里如果有换行，压成空格） */
function serialiseNote(entry) {
  const oneLine = (value) => String(value == null ? '' : value).replace(/\s*\r?\n\s*/g, ' ').trim();
  const lines = [
    '---',
    `id: ${oneLine(entry.id)}`,
    `title: ${oneLine(entry.title)}`,
    `tags: ${oneLine((entry.tags || []).join(','))}`,
    `source: ${oneLine(entry.source)}`,
    `created: ${oneLine(entry.created)}`,
    `updated: ${oneLine(entry.updated)}`,
    `enabled: ${entry.enabled === false ? 'false' : 'true'}`,
    // 只读（模型不能改/删，但仍照常参与检索）：只在锁上时才写这一行，
    // 保证没锁的条目和以前一模一样（老文件、老测试都不用动）。
    ...(entry.locked === true ? ['locked: true'] : []),
    '---',
    '',
    String(entry.content || '').replace(/\r\n/g, '\n').trim(),
    ''
  ];
  return lines.join('\n');
}

class KnowledgeBase {
  /**
   * @param {{dir?:string, logger?:object}} options
   *   `dir` 不给就用调用方指定的默认值（main.js 会传 `data/knowledge`）
   */
  constructor({ dir, logger, historyDir } = {}) {
    this.dir = dir ? path.resolve(String(dir)) : '';
    this.logger = logger || console;
    // 改库备份放这儿（点号开头，不会被当成知识条目扫进来）。
    // 默认放在知识库根下：**主播拿文件管理器也能自己捞回来**，不用信软件。
    this.historyRoot = historyDir ? path.resolve(String(historyDir)) : '';
    /** @type {Array<object>} 内存里的条目（按 updated 倒序） */
    this.items = [];
    /** 每个 token 出现在多少个条目里（算 IDF 用） */
    this.df = new Map();
    /** id → 条目 */
    this.byId = new Map();
    this.loadedAt = 0;
  }

  get notesDir() {
    return path.join(this.dir, 'notes');
  }

  /** 她自己改过的旧版本放这儿（`.history/<条目 id>/<时间>.md` + 同名 `.json` 说明） */
  get historyDir() {
    return this.historyRoot || path.join(this.dir, '.history');
  }

  /** 「要整理的资料」放这儿（DSH 会来读） */
  get inboxDir() {
    return path.join(this.dir, 'inbox');
  }

  /**
   * 建好目录骨架：notes / pending / inbox + 一份给人看的说明。
   * 每次 load 都跑一遍（幂等、很便宜）：用户手滑删掉 inbox 也能自己长回来。
   */
  ensureLayout() {
    if (!this.dir) return;
    for (const dir of [this.notesDir, this.pendingDir, this.inboxDir]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        this.logger.warn?.(`知识库目录建不出来（${error.message}）：${dir}`);
      }
    }
    const readme = path.join(this.dir, KB_README_FILE);
    try {
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, KB_README, 'utf8');
    } catch (error) {
      this.logger.warn?.(`知识库说明写不进去（${error.message}）：${readme}`);
    }
  }

  /** 扫目录重建内存索引。目录不存在就当作空库。 */
  load() {
    this.items = [];
    this.df = new Map();
    this.byId = new Map();
    this.loadedAt = Date.now();
    if (!this.dir) return this.items;
    this.ensureLayout();
    let files = [];
    try {
      fs.mkdirSync(this.notesDir, { recursive: true });
      files = fs.readdirSync(this.notesDir).filter((name) => name.toLowerCase().endsWith('.md'));
    } catch (error) {
      this.logger.warn?.(`知识库目录读不了（${error.message}），这次按空库处理`);
      return this.items;
    }
    for (const name of files) {
      const file = path.join(this.notesDir, name);
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const { meta, body } = parseNote(raw);
        const id = String(meta.id || '').trim() || path.basename(name, '.md');
        this.items.push({
          id,
          title: String(meta.title || path.basename(name, '.md')).slice(0, MAX_TITLE_CHARS),
          content: body.slice(0, MAX_CONTENT_CHARS),
          tags: normaliseTags(meta.tags),
          source: String(meta.source || ''),
          created: String(meta.created || ''),
          updated: String(meta.updated || meta.created || ''),
          enabled: String(meta.enabled || 'true') !== 'false',
          // 只读：主播在面板上勾了「锁定」，模型就不能改/删这条（人仍然可以改）
          locked: String(meta.locked || 'false') === 'true',
          file
        });
      } catch (error) {
        this.logger.warn?.(`知识条目读不了，已跳过：${name}（${error.message}）`);
      }
    }
    this._buildIndex();
    return this.items;
  }

  /** 需要时自动加载（进程刚起来 / 目录被外部改过） */
  ensureLoaded() {
    if (!this.loadedAt) this.load();
    return this.items;
  }

  _buildIndex() {
    this.byId = new Map();
    this.df = new Map();
    for (const item of this.items) {
      this.byId.set(item.id, item);
      item._tokens = this._tokenize(item.title, TAG_WEIGHT, item.tags.join(' '), TAG_WEIGHT, item.content, 1);
      item._length = Object.values(item._tokens).reduce((sum, n) => sum + n, 0) || 1;
      for (const token of Object.keys(item._tokens)) {
        this.df.set(token, (this.df.get(token) || 0) + 1);
      }
    }
    this.items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }

  /**
   * 切词 + 计频。中文切成 2 字组，英文数字按词。
   * 同一段文本出现多个不同权重时，取**最高**的那个（标题里的词比正文里的更有分量）。
   */
  _tokenize(...groups) {
    const counts = new Map();
    const bump = (token, weight) => {
      counts.set(token, Math.max(counts.get(token) || 0, weight));
    };
    for (let i = 0; i + 1 < groups.length; i += 2) {
      const text = String(groups[i] == null ? '' : groups[i]).toLowerCase();
      const weight = Number(groups[i + 1]) || 1;
      if (!text) continue;
      for (const match of text.matchAll(/[a-z0-9_]{2,}/g)) bump(match[0], weight);
      for (const match of text.matchAll(/[\u4e00-\u9fff]+/g)) {
        const seg = match[0];
        if (seg.length === 1) bump(seg, weight);
        for (let j = 0; j + 1 < seg.length; j += 1) bump(seg.slice(j, j + 2), weight);
      }
    }
    return Object.fromEntries(counts);
  }

  /** 库里有没有东西 */
  get size() {
    return this.ensureLoaded().length;
  }

  list() {
    return this.ensureLoaded().map((item) => ({ ...item, _tokens: undefined, _length: undefined }));
  }

  get(id) {
    this.ensureLoaded();
    return this.byId.get(String(id)) || null;
  }

  /**
   * 检索：query 的每个 token 在条目里出现就加分（出现次数 × IDF），再按条目长度归一化。
   * 返回的分数只用来排序，没有绝对意义。
   *
   * ⚠️ 两个「别乱命中」的规矩（都来自自测踩的坑）：
   *   1. **相对阈值**：只保留分数达到最佳命中 30% 以上的条目。
   *      否则库里只要有一条含「今天」的稿子，问「今天天气怎么样」就会被它命中。
   *   2. 每条命中会带 `strong` 标记：命中 ≥2 个词，或者命中标题/标签才算「强命中」。
   *      `context()` 只注入强命中——单个常用 2 字组撞上不算证据。
   *      所以「检索预览」会显示弱命中但不注入，正好用来看库里的词够不够、准不准。
   */
  search(query, { limit = 5, includeDisabled = false, minRatio = 0.3 } = {}) {
    this.ensureLoaded();
    const text = String(query || '').trim();
    if (!text) return [];
    const queryTokens = this._tokenize(text, 1);
    const total = this.items.length || 1;
    const scored = [];
    for (const item of this.items) {
      if (!includeDisabled && item.enabled === false) continue;
      let score = 0;
      let matchedTokens = 0;
      let titleHit = false;
      for (const [token, weight] of Object.entries(queryTokens)) {
        const tf = item._tokens[token];
        if (!tf) continue;
        matchedTokens += 1;
        // 标题/标签里的词权重更高（TITLE_WEIGHT），命中它们算强证据
        if (tf >= TITLE_WEIGHT) titleHit = true;
        const df = this.df.get(token) || 1;
        const idf = Math.log(1 + total / df);
        score += tf * weight * idf;
      }
      if (score <= 0) continue;
      scored.push({
        entry: item,
        score: score / Math.sqrt(item._length),
        matchedTokens,
        titleHit,
        strong: matchedTokens >= 2 || titleHit
      });
    }
    scored.sort((a, b) => b.score - a.score);
    const best = scored.length ? scored[0].score : 0;
    return scored.filter((hit, index) => index === 0 || hit.score >= best * minRatio).slice(0, Math.max(0, limit));
  }

  /**
   * 给提示词用的上下文片段。
   * 只注入「强命中」（见 `search()` 的说明），塞不下的条目直接丢掉。
   *
   * ⚠️ `maxChars` 是**整段**的上限，附注那一行也算在里面——界面上写的是「总字数上限」，
   * 要是只算正文，用户设 300 却看到 400 字的注入，那这个设置就是骗人的。
   *
   * @returns {{text:string, hits:Array<{id:string,title:string,score:number}>}}
   */
  context(query, { maxEntries = 3, maxChars = 600 } = {}) {
    const hits = this.search(query, { limit: maxEntries }).filter((hit) => hit.strong);
    if (!hits.length) return { text: '', hits: [] };
    const header = `${KNOWLEDGE_MARKER}以下资料只在确实相关时使用；不相关就别提，也别说「根据知识库」。`;
    const lines = [header];
    let used = header.length;
    const usedHits = [];
    for (let i = 0; i < hits.length; i += 1) {
      const { entry, score } = hits[i];
      const body = String(entry.content || '').replace(/\s*\n\s*/g, ' ').trim();
      const head = `${i + 1}. ${entry.title}：`;
      const room = maxChars - used - head.length;
      if (room < 20) break; // 剩下的塞不下了
      const clipped = body.length > room ? `${body.slice(0, room)}…` : body;
      lines.push(`${head}${clipped}`);
      used += head.length + clipped.length;
      usedHits.push({ id: entry.id, title: entry.title, score: Math.round(score * 1000) / 1000 });
    }
    if (!usedHits.length) return { text: '', hits: [] };
    return { text: lines.join('\n'), hits: usedHits };
  }

  _writeEntry(entry) {
    if (!this.dir) throw new Error('知识库目录没设置');
    const now = new Date().toISOString();
    if (!entry.created) entry.created = now;
    entry.updated = now;
    const file = entry.file || path.join(this.notesDir, `${slugify(entry.title)}--${entry.id}.md`);
    fs.mkdirSync(this.notesDir, { recursive: true });
    fs.writeFileSync(file, serialiseNote(entry), 'utf8');
    entry.file = file;
    return entry;
  }

  add({ title, content, tags, source, enabled = true, locked = false } = {}) {
    if (!this.dir) throw new Error('知识库目录没设置');
    this.ensureLoaded();
    const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_CHARS);
    const cleanContent = String(content || '').trim().slice(0, MAX_CONTENT_CHARS);
    if (!cleanTitle && !cleanContent) throw new Error('标题和正文不能都是空的');
    const id = `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this._writeEntry({
      id,
      title: cleanTitle || cleanContent.slice(0, 20),
      content: cleanContent,
      tags: normaliseTags(tags),
      source: String(source || '手动添加').slice(0, 300),
      created: '',
      updated: '',
      enabled: enabled !== false,
      locked: locked === true,
      file: ''
    });
    // ⚠️ 写完必须重新 load()：内存索引是从 this.items 建的，不重读的话
    // 新条目要等下次启动才看得见（这个 bug 写完第一次自测就撞上了）。
    // 「磁盘是唯一真相」也让「用别的工具改了 md」这种情况自动生效。
    this.load();
    return this.get(id);
  }

  update(id, patch = {}, { record = true, kind = 'manual', reason = '', source = '' } = {}) {
    this.ensureLoaded();
    const entry = this.byId.get(String(id));
    if (!entry) throw new Error(`没有这条知识：${id}`);
    // 改之前留一份原文：「改错了想撤回」对**主播手滑**同样成立
    let backup = null;
    if (record) {
      try {
        backup = this._saveHistory(entry, { kind, reason, source, afterChars: String(patch.content === undefined ? entry.content : patch.content).length });
      } catch (error) {
        this.logger.warn?.(`改之前备份失败（${error.message}），这次仍然按主播的操作写下去`);
      }
    }
    if (patch.title !== undefined) entry.title = String(patch.title).trim().slice(0, MAX_TITLE_CHARS) || entry.title;
    if (patch.content !== undefined) entry.content = String(patch.content).slice(0, MAX_CONTENT_CHARS);
    if (patch.tags !== undefined) entry.tags = normaliseTags(patch.tags);
    if (patch.source !== undefined) entry.source = String(patch.source).slice(0, 300);
    if (patch.enabled !== undefined) entry.enabled = patch.enabled !== false;
    if (patch.locked !== undefined) entry.locked = patch.locked === true;
    this._writeEntry(entry);
    this.load();
    return this.get(id);
  }

  /** 这条是不是被主播锁成只读了（模型的改/删都要先问一句） */
  isLocked(id) {
    this.ensureLoaded();
    const entry = this.byId.get(String(id));
    return Boolean(entry && entry.locked);
  }

  remove(id) {
    this.ensureLoaded();
    const entry = this.byId.get(String(id));
    if (!entry) return false;
    try {
      // 删除也先留一份备份：删错了（含她自己改坏之后主播手一抖）还能从「她自己改过的」里捞回来
      this._saveHistory(entry, { kind: 'remove', reason: '条目被删掉了（删除前自动备份）' });
      if (entry.file) fs.rmSync(entry.file, { force: true });
    } catch (error) {
      this.logger.warn?.(`删知识条目文件失败：${error.message}`);
      return false;
    }
    this.load();
    return true;
  }

  // ---------------------------------------------------------------- 她自己改库
  //
  // P6：主播希望「她可以自己改错，也可以自己扩写」。这是**唯一一条允许机器直接写 notes/ 的路**，
  // 所以规矩定得很死：
  //   · 只改**已有**条目（不许新建、不许删除——新建仍然走待审）；
  //   · 改之前**一定**先备份原文到 `.history/`（主播拿文件管理器也能捞回来）；
  //   · 正文不许明显变短（那等于偷偷把知识删了）；
  //   · 每次改动都留一条记录，面板上能一键撤销。
  // 谁有权触发它：main.js 的改库流水线（`runKnowledgeEdit`）。copilot 依旧不许碰知识库。

  /** 备份当前文件（含 front-matter 的原文），返回这条备份的信息 */
  _saveHistory(entry, meta = {}) {
    if (!this.dir) throw new Error('知识库目录没设置');
    const raw = entry.file && fs.existsSync(entry.file) ? fs.readFileSync(entry.file, 'utf8') : serialiseNote(entry);
    return this._writeEditRecord(entry, meta, raw);
  }

  /**
   * 写一条改动记录。
   * @param {string|null} raw 旧版本的原文；`null` 表示这次没有旧版本可备份（比如「她新建了一条」）
   */
  _writeEditRecord(entry, meta = {}, raw = null) {
    if (!this.dir) throw new Error('知识库目录没设置');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(this.historyDir, entry.id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp}.md`);
    if (raw !== null) fs.writeFileSync(file, raw, 'utf8');
    const info = {
      id: `${entry.id}/${stamp}`,
      noteId: entry.id,
      title: entry.title,
      file,
      hasBackup: raw !== null,
      savedAt: new Date().toISOString(),
      chars: String(entry.content || '').length,
      kind: 'edit',
      reason: '',
      source: '',
      undone: false,
      undoneAt: '',
      ...meta
    };
    fs.writeFileSync(path.join(dir, `${stamp}.json`), JSON.stringify(info, null, 2), 'utf8');
    return info;
  }

  /**
   * 她自己改一条已有知识的正文（**只有改库流水线会调它**）。
   *
   * @returns {{ok:boolean, changed:boolean, entry?:object, backup?:object, reason?:string}}
   */
  applyEdit(id, { title, content, tags, reason = '', source = '她自己改的', kind = 'edit' } = {}) {
    if (!this.dir) return { ok: false, changed: false, reason: '知识库目录没设置' };
    this.ensureLoaded();
    const entry = this.byId.get(String(id));
    if (!entry) return { ok: false, changed: false, reason: `知识库里没找到这条：${id}` };
    // 只读：主播锁成只读的条目，模型不许改（连"她自己改错"也不行）。
    // 放在最前面拦：既有的改库流水线 / 新的校对流水线都会走到这里，一道闸门就够。
    if (entry.locked) {
      return { ok: false, changed: false, reason: `「${entry.title}」被主播锁成只读了，这次不改` };
    }

    const nextTitle = title === undefined ? entry.title : String(title).trim().slice(0, MAX_TITLE_CHARS) || entry.title;
    const nextContent = String(content === undefined ? entry.content : content).trim().slice(0, MAX_CONTENT_CHARS);
    if (!nextContent) return { ok: false, changed: false, reason: '改完的正文是空的，这次不写' };
    // 明显变短 = 把知识删掉了。允许缩，但不能缩到原来的 60% 以下（真删是主播自己的事）
    const beforeChars = String(entry.content || '').length;
    if (beforeChars >= 20 && nextContent.length < beforeChars * 0.6) {
      return { ok: false, changed: false, reason: `改完太短了（${beforeChars} → ${nextContent.length} 字），像是把内容删掉了，这次不写` };
    }
    if (nextTitle === entry.title && nextContent === String(entry.content || '').trim()) {
      return { ok: true, changed: false, entry, reason: '内容没变化' };
    }

    let backup = null;
    try {
      backup = this._saveHistory(entry, { kind, reason, source, afterChars: nextContent.length });
    } catch (error) {
      // 备份都写不出来就**绝对不许改**：宁可不改，也不能让旧版本无处可回
      this.logger.warn?.(`改库前备份失败，这次不改（${error.message}）`);
      return { ok: false, changed: false, reason: `备份写不出来（${error.message}），为了安全这次不改` };
    }
    try {
      this.update(entry.id, { title: nextTitle, content: nextContent, tags }, { record: false });
    } catch (error) {
      return { ok: false, changed: false, backup, reason: `写入失败：${error.message}` };
    }
    this.logger.info?.(`她自己改了「${nextTitle}」（${beforeChars} → ${nextContent.length} 字，${kind}，旧版本已备份）`);
    return { ok: true, changed: true, entry: this.get(entry.id), backup };
  }

  /**
   * 她自己**新建**一条知识（P6 放开的那一档：主播选了「她也放开」）。
   *
   * 两条规矩：
   *   · **先查重**：库里已经有说得上相关的条目，就不新建，改成把这句话补进那条（免得同一件事两条，
   *     检索时互相抢位置）；
   *   · 新建也留一条 `create` 记录：面板上点「撤销」= 把这条删掉。
   *
   * @returns {{ok:boolean, created?:boolean, merged?:boolean, entry?:object, edit?:object, reason?:string}}
   */
  applyCreate({ title, content, tags, reason = '', source = '她自己记的', mergeScore = 0.6 } = {}) {
    if (!this.dir) return { ok: false, reason: '知识库目录没设置' };
    const clean = String(content || '').trim().slice(0, MAX_CONTENT_CHARS);
    const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_CHARS) || clean.slice(0, 20);
    if (!clean) return { ok: false, reason: '内容是空的，这次不记' };
    this.ensureLoaded();

    // ① 已经有相关条目 → 别新建，补进那一条（和「扩写」走同一条带备份的路）
    let hit = null;
    try {
      hit = this.search(`${cleanTitle} ${clean}`, { limit: 1 })[0] || null;
    } catch (_) {
      hit = null;
    }
    // 命中的那条被锁成只读 → 不并进去（并进去就是"模型改了只读条目"），改成新建一条
    if (hit && hit.entry && hit.entry.locked) hit = null;
    if (hit && hit.score >= mergeScore && hit.entry.enabled !== false) {
      const merged = `${String(hit.entry.content || '').trim()}\n\n${clean}`.trim();
      const result = this.applyEdit(hit.entry.id, {
        content: merged,
        kind: 'expand',
        reason: reason || '她记了一句新的，合并进已有条目',
        source
      });
      if (result.ok) return { ...result, created: false, merged: true };
      return { ok: false, reason: result.reason };
    }

    // ② 真的新建
    let entry;
    try {
      entry = this.add({ title: cleanTitle, content: clean, tags, source: `${source}${reason ? ` · ${reason}` : ''}` });
    } catch (error) {
      return { ok: false, reason: `新建失败：${error.message}` };
    }
    let edit = null;
    try {
      // 新建没有「旧版本」可备份，所以只写一条记录（撤销 = 删掉这条）
      edit = this._writeEditRecord(entry, { kind: 'create', reason, source, afterChars: clean.length }, null);
    } catch (error) {
      this.logger.warn?.(`新建记录写不进去（${error.message}），条目本身已经建好了`);
    }
    this.logger.info?.(`她自己记了一条新知识：「${entry.title}」（${clean.length} 字）`);
    return { ok: true, created: true, merged: false, entry, edit };
  }

  /** 她改过的记录（最新在前）。界面拿它画「她自己改过的」卡片 */
  listEdits({ limit = 30 } = {}) {
    if (!this.dir) return [];
    const out = [];
    let noteDirs = [];
    try {
      noteDirs = fs.readdirSync(this.historyDir, { withFileTypes: true }).filter((item) => item.isDirectory());
    } catch (_) {
      return out;
    }
    for (const dir of noteDirs) {
      const full = path.join(this.historyDir, dir.name);
      let files = [];
      try {
        files = fs.readdirSync(full).filter((name) => name.endsWith('.json'));
      } catch (_) {
        continue;
      }
      for (const name of files) {
        try {
          const info = JSON.parse(fs.readFileSync(path.join(full, name), 'utf8'));
          if (!info || !info.noteId) continue;
          out.push({
            id: String(info.id || `${info.noteId}/${name.replace(/\.json$/, '')}`),
            noteId: String(info.noteId),
            title: String(info.title || ''),
            file: String(info.file || path.join(full, name.replace(/\.json$/, '.md'))),
            hasBackup: info.hasBackup !== false,
            savedAt: String(info.savedAt || ''),
            chars: Number(info.chars) || 0,
            afterChars: Number(info.afterChars) || 0,
            kind: String(info.kind || 'edit'),
            reason: String(info.reason || ''),
            source: String(info.source || ''),
            undone: Boolean(info.undone)
          });
        } catch (error) {
          this.logger.warn?.(`改库记录读不了，已跳过：${name}（${error.message}）`);
        }
      }
    }
    return out.sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt))).slice(0, Math.max(1, limit));
  }

  /**
   * 撤销一次改动：
   *   · 「她新建的」（`kind: 'create'`）→ 把那条删掉；
   *   · 其余 → 把备份的原文写回去（条目被删了就按备份重建）。
   * @param {string} editId `listEdits()` 里的 id
   */
  undoEdit(editId) {
    const edit = this.listEdits({ limit: 500 }).find((item) => item.id === String(editId));
    if (!edit) return { ok: false, reason: `没有这条修改记录：${editId}` };
    if (edit.undone) return { ok: false, reason: '这次修改已经撤销过了' };
    this.ensureLoaded();

    if (edit.kind === 'create') {
      // 她新建的：撤销 = 删掉这条（只删她建的那一条，别的不动）
      const entry = this.byId.get(edit.noteId);
      try {
        if (entry && entry.file) fs.rmSync(entry.file, { force: true });
      } catch (error) {
        return { ok: false, reason: `删不掉这条：${error.message}` };
      }
      this._markUndone(edit);
      this.load();
      this.logger.info?.(`已撤销一次「她新建的知识」：「${edit.title}」已删除`);
      return { ok: true, noteId: edit.noteId, removed: true, entry: null };
    }

    let raw = '';
    try {
      raw = fs.readFileSync(edit.file, 'utf8');
    } catch (error) {
      return { ok: false, reason: `备份读不出来（${error.message}）` };
    }
    const entry = this.byId.get(edit.noteId);
    try {
      if (entry) {
        // 条目还在：文件内容整个换回备份（连带 front-matter 一起，一个字都不差）
        fs.writeFileSync(entry.file, raw, 'utf8');
      } else {
        // 条目被删了：按备份重建
        const { meta } = parseNote(raw);
        const title = String(meta.title || edit.title || '恢复的条目');
        const file = path.join(this.notesDir, `${slugify(title)}--${edit.noteId}.md`);
        fs.mkdirSync(this.notesDir, { recursive: true });
        fs.writeFileSync(file, raw, 'utf8');
      }
    } catch (error) {
      return { ok: false, reason: `恢复失败：${error.message}` };
    }
    this._markUndone(edit);
    this.load();
    this.logger.info?.(`已撤销一次改库：「${edit.title}」回到 ${edit.savedAt}`);
    return { ok: true, noteId: edit.noteId, entry: this.get(edit.noteId) || null };
  }

  /** 在记录里标一笔「已撤销」（备份文件留在原地，方便再看/再恢复） */
  _markUndone(edit) {
    try {
      const sidecar = `${edit.file.replace(/\.md$/, '')}.json`;
      const info = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
      info.undone = true;
      info.undoneAt = new Date().toISOString();
      fs.writeFileSync(sidecar, JSON.stringify(info, null, 2), 'utf8');
    } catch (error) {
      this.logger.warn?.(`撤销标记写不进去（${error.message}）`);
    }
  }

  stats() {
    const items = this.ensureLoaded();
    return {
      dir: this.dir,
      notesDir: this.notesDir,
      pendingDir: this.pendingDir,
      inboxDir: this.inboxDir,
      count: items.length,
      enabled: items.filter((item) => item.enabled !== false).length,
      locked: items.filter((item) => item.locked === true).length,
      pending: this.listPending().length,
      chars: items.reduce((sum, item) => sum + String(item.content || '').length, 0)
    };
  }

  // ---------------------------------------------------------------- 待审草稿
  //
  // 为什么要有这一层：整理资料是「机器提议、人来拍板」。
  // 不管是 DSH 还是以后的内置引擎，产出都只写进 `pending/`，
  // 主播点「通过」才落到 `notes/` 变成真正的知识——写错一条知识会污染之后几十场直播，
  // 而直播中根本没空去核对。

  get pendingDir() {
    return path.join(this.dir, 'pending');
  }

  listPending() {
    if (!this.dir) return [];
    let files = [];
    try {
      fs.mkdirSync(this.pendingDir, { recursive: true });
      files = fs.readdirSync(this.pendingDir).filter((name) => name.endsWith('.json'));
    } catch (_) {
      return [];
    }
    const out = [];
    for (const name of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.pendingDir, name), 'utf8'));
        if (!raw || typeof raw !== 'object') continue;
        out.push({
          id: String(raw.id || path.basename(name, '.json')),
          title: String(raw.title || '').slice(0, MAX_TITLE_CHARS),
          content: String(raw.content || '').slice(0, MAX_CONTENT_CHARS),
          tags: normaliseTags(raw.tags),
          source: String(raw.source || ''),
          engine: String(raw.engine || ''),
          createdAt: String(raw.createdAt || '')
        });
      } catch (error) {
        this.logger.warn?.(`待审草稿读不了，已跳过：${name}（${error.message}）`);
      }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  addPending({ title, content, tags, source, engine } = {}) {
    if (!this.dir) throw new Error('知识库目录没设置');
    const cleanTitle = String(title || '').trim().slice(0, MAX_TITLE_CHARS);
    const cleanContent = String(content || '').trim().slice(0, MAX_CONTENT_CHARS);
    if (!cleanTitle && !cleanContent) throw new Error('草稿的标题和正文不能都是空的');
    const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const draft = {
      id,
      title: cleanTitle || cleanContent.slice(0, 20),
      content: cleanContent,
      tags: normaliseTags(tags),
      source: String(source || '').slice(0, 300),
      engine: String(engine || '').slice(0, 40),
      createdAt: new Date().toISOString()
    };
    fs.mkdirSync(this.pendingDir, { recursive: true });
    fs.writeFileSync(path.join(this.pendingDir, `${id}.json`), JSON.stringify(draft, null, 2), 'utf8');
    return draft;
  }

  /**
   * 通过一条草稿：写进知识库，然后把草稿删掉（可以顺手改标题/正文）。
   *
   * P7 起会**留一条记录**：她在最高权限下自动通过的草稿，主播得能一键撤销
   * （`record: false` 可以关掉，给不需要留痕的调用方）。
   */
  approvePending(id, patch = {}, { record = true, reason = '' } = {}) {
    const draft = this.listPending().find((item) => item.id === String(id));
    if (!draft) throw new Error(`没有这条待审草稿：${id}`);
    const entry = this.add({
      title: patch.title !== undefined ? patch.title : draft.title,
      content: patch.content !== undefined ? patch.content : draft.content,
      tags: patch.tags !== undefined ? patch.tags : draft.tags,
      source: `待审通过 · ${draft.source || draft.engine || '未标注'}`
    });
    if (record) {
      try {
        // 新建没有「旧版本」可备份，所以只写一条记录（撤销 = 删掉这条）
        this._writeEditRecord(entry, { kind: 'create', reason: reason || '通过了一条待审草稿', source: '待审通过' }, null);
      } catch (error) {
        this.logger.warn?.(`通过记录写不进去（${error.message}）`);
      }
    }
    this.rejectPending(id);
    return entry;
  }

  /** 丢弃一条草稿（只删草稿文件，不碰知识库） */
  rejectPending(id) {
    const file = path.join(this.pendingDir, `${String(id)}.json`);
    try {
      fs.rmSync(file, { force: true });
      return true;
    } catch (error) {
      this.logger.warn?.(`删待审草稿失败：${error.message}`);
      return false;
    }
  }

  /**
   * 丢弃**全部**待审草稿（2026-10-21 主播要的「清空待审」）。
   *
   * 只删 `pending/*.json`，**知识库一个字都不动**；单条删不掉不耽误其他条。
   * 逐个走 `rejectPending`，这样失败时能说出是哪一条。
   */
  clearPending() {
    const drafts = this.listPending();
    let removed = 0;
    const failed = [];
    for (const draft of drafts) {
      if (this.rejectPending(draft.id)) removed += 1;
      else failed.push(draft.title || draft.id);
    }
    return { removed, failed };
  }
}

module.exports = {
  KnowledgeBase,
  parseNote,
  serialiseNote,
  normaliseTags,
  slugify,
  KNOWLEDGE_MARKER,
  KNOWLEDGE_DIR_NAME,
  KB_README_FILE,
  KB_README,
  defaultKnowledgeDir,
  migrateKnowledgeDir,
  MAX_CONTENT_CHARS,
  MAX_TITLE_CHARS
};
