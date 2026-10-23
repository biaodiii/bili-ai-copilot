'use strict';

/**
 * 知识库的「整理 / 校对 / 更新」—— **纯函数层**（2026-10-19 加，主播要的）。
 *
 * 两条腿：
 *   ① `audit`：把全库的「标题 + 标签 + 正文摘要」一次给模型，找**重复 / 冲突 / 过时 / 太散**，
 *      产出「合并 / 改写 / 删除」建议。不联网，一次调用，几厘钱。
 *   ② `verify`：逐条笔记联网查证（每条一次搜索 + 一次高思考调用），产出「改哪句 / 为什么 / 依据」。
 *
 * 这个文件**只放纯函数**（提示词、解析、选目标、判改动），方便单测；
 * 真正的网络调用、写盘、锁校验都在 `main.js` 的 review 流水线里。
 *
 * ⚠️ 两条铁律（和项目其它地方一致）：
 *   · 模型的产出只是**建议**，必须主播点「应用」才写库（最高权限除外，且同样留记录可撤销）；
 *   · 被锁成只读的条目**不进提示词、也不许被建议改动** —— 锁是硬闸门，不是界面装饰。
 */

/** 用户要求：整理/校对用**最高**思考档（llm.js 里 reasoning_effort: off/low/high/max） */
const REVIEW_THINKING = 'max';
/** 整理时每条正文最多给模型看多少字（只看摘要省 token，找重复够用） */
const AUDIT_EXCERPT_CHARS = 300;
/** 一次整理最多塞多少条（提示词会太长；16 条实测很轻松） */
const MAX_AUDIT_NOTES = 80;
/** 校对时给模型看几条搜索结果（接口一次返回 8 条，取前 5） */
const VERIFY_RESULTS = 5;
/** 一次最多攒多少条建议（防止模型一口气吐出上百条，界面也没法看） */
const MAX_REVIEW_ITEMS = 40;
/** 一次联网校对最多跑几条（面板上可调，0 = 用这个默认值） */
const DEFAULT_VERIFY_LIMIT = 5;
/** 建议正文上限（和 knowledge.js 的 MAX_CONTENT_CHARS 一致） */
const MAX_CONTENT_CHARS = 20000;

const KINDS = ['merge', 'rewrite', 'delete'];
const KIND_LABELS = { merge: '合并', rewrite: '改写', delete: '删除' };

/** 模型给的「类型」→ 内部 kind（容错：中英文、全半角都认） */
function normaliseKind(raw, noteIds = [], content = '') {
  const text = String(raw || '').trim();
  if (/合并|merge/i.test(text)) return 'merge';
  if (/删除|删掉|delete/i.test(text)) return 'delete';
  if (/改写|更新|修正|rewrite|update/i.test(text)) return 'rewrite';
  // 没写类型就按内容猜：多条 id = 合并；没有正文 = 删除；其余当改写
  if (noteIds.length > 1) return 'merge';
  if (!String(content || '').trim()) return 'delete';
  return 'rewrite';
}

/** 每条笔记给模型的「摘要卡」 */
function briefNote(note, { maxChars = AUDIT_EXCERPT_CHARS } = {}) {
  const content = String((note && note.content) || '').replace(/\s+/g, ' ').trim();
  const tags = Array.isArray(note && note.tags) ? note.tags.join(',') : String((note && note.tags) || '');
  return {
    id: String((note && note.id) || ''),
    title: String((note && note.title) || '').trim(),
    tags,
    excerpt: content.length > maxChars ? `${content.slice(0, maxChars)}…` : content,
    chars: content.length,
    updated: String((note && note.updated) || ''),
    locked: Boolean(note && note.locked)
  };
}

/** 整理只看没锁的条目（锁了的不许被建议改动，所以干脆不给模型看） */
function auditNotes(notes) {
  return (Array.isArray(notes) ? notes : []).filter((note) => note && note.id && !note.locked);
}

const AUDIT_SYSTEM_PROMPT = [
  '你是直播知识库的整理助手。主播把每场直播能用上的知识存成一条条笔记，',
  '现在请你只看「标题 + 标签 + 正文摘要」，找出问题并给出**改动建议**。',
  '',
  '只允许三种建议：',
  '  · 合并：两条（或多条）说的是同一件事 → 合成一条，其余删掉；',
  '  · 改写：一条内部有错、过时、重复表达、太长或太散 → 重写它的正文（必要时也改标题/标签）；',
  '  · 删除：一条完全没用，或者已被另一条完整覆盖 → 删掉。',
  '',
  '硬要求：',
  '1. **只依据给你的条目内容判断**，不要引入外部知识，不要编。',
  '2. 合并/改写后的正文要**保留原条目里写对的全部信息**（数字、名字、时间、价格），不许丢。',
  '3. 正文写成主播直播时能直接照着说的口吻，一条不超过 300 字。',
  '4. 没有值得改的条目就**不要输出任何建议块**（宁缺毋滥）。',
  '5. 只输出下面格式的内容，不要解释、不要代码块、不要用 # 标题或加粗：',
  '',
  '===建议===',
  '类型：合并（或 改写 / 删除）',
  '条目：k-abc（合并时写多条，用逗号隔开，**第一条是合并后的主条目**）',
  '标题：改写后的标题（删除时可以不写）',
  '标签：逗号分隔（可以留空）',
  '正文：改写后的正文（删除时可以不写）',
  '理由：一句话说清为什么改'
].join('\n');

/**
 * 全库整理的提示词。
 * @returns {{system:string, user:string}}
 */
function buildAuditPrompt(notes, { today = '' } = {}) {
  const list = auditNotes(notes).slice(0, MAX_AUDIT_NOTES).map((note) => briefNote(note));
  const body = list
    .map(
      (note, index) =>
        `[${index + 1}] id：${note.id}\n标题：${note.title}\n标签：${note.tags || '（无）'}\n摘要：${note.excerpt}`
    )
    .join('\n\n');
  const user = [
    today ? `今天是 ${today}。` : '',
    `共 ${list.length} 条知识（同一件事的两条笔记在这里会重复出现，请留意）。`,
    '',
    body,
    '',
    '【怎么输出】每条建议用一行 `===建议===` 开头，然后依次一行「类型：」「条目：」「标题：」「标签：」「正文：」「理由：」。',
    '没有任何建议就什么都不要输出。'
  ]
    .filter((line, index) => index > 0 || line)
    .join('\n');
  return { system: AUDIT_SYSTEM_PROMPT, user };
}

const VERIFY_SYSTEM_PROMPT = [
  '你在核对一条直播知识是不是**正确而且没过时**。下面会给你这条笔记，和刚联网搜到的资料。',
  '',
  '先判断有没有问题，再决定要不要改：',
  '  · 资料和笔记一致（只是措辞不同）→ 输出「无需改动」；',
  '  · 资料表明笔记写错了 / 过时了 / 缺了关键信息 → 输出一条改动建议。',
  '',
  '硬要求：',
  '1. **只能依据「笔记」和「资料」**。资料没写的一律不许猜、不许补。',
  '2. 资料之间互相矛盾、或者资料明显是别的东西 → 判「无需改动」，理由里说明有冲突。',
  '3. 要改时**只改该改的地方，其余照抄**；保留数字 / 名字 / 时间；正文不超过 300 字，',
  '   保持主播直播时能直接念的口吻。',
  '4. 只输出下面两种格式之一，不要解释、不要代码块：',
  '',
  '===结论===',
  '结果：无需改动',
  '理由：一句话',
  '',
  '===建议===',
  '类型：改写（如果资料说明这条该并到别处才用 合并；完全不该留用 删除）',
  '条目：这条的 id',
  '标题：改完的标题',
  '标签：逗号分隔',
  '正文：改完的正文',
  '理由：一句话说清改了什么、依据是哪条资料'
].join('\n');

/**
 * 逐条校对的提示词。
 * @param {{note:object, results:Array<object>, today?:string}} input
 *   results = 搜索结果（title / site_name / date / authority / summary / url）
 * @returns {{system:string, user:string}}
 */
function buildVerifyPrompt({ note, results = [], today = '' } = {}) {
  const item = briefNote(note, { maxChars: MAX_CONTENT_CHARS });
  const blocks = (Array.isArray(results) ? results : []).slice(0, VERIFY_RESULTS).map((result, index) => {
    const title = String((result && result.title) || '').trim() || '(无标题)';
    const site = String((result && (result.site_name || result.site)) || '').trim() || '未知站点';
    const date = String((result && result.date) || '').slice(0, 10);
    const summary = String((result && (result.summary || result.snippet)) || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1200);
    const meta = [site, date].filter(Boolean).join(' · ');
    return `[${index + 1}] ${title}（${meta}）\n${summary}\n链接：${String((result && result.url) || '')}`;
  });
  const user = [
    today ? `今天是 ${today}。` : '',
    `【要核对的笔记】id：${item.id}`,
    `标题：${item.title}`,
    `标签：${item.tags || '（无）'}`,
    '正文：',
    String((note && note.content) || '').trim(),
    '',
    `【刚联网搜到的 ${blocks.length} 条资料】`,
    blocks.join('\n\n') || '（没搜到资料）',
    '',
    '【怎么输出】没问题就输出 `===结论===` +「结果：无需改动」+「理由：」；',
    '要改就输出 `===建议===` +「类型：」「条目：」「标题：」「标签：」「正文：」「理由：」。'
  ]
    .filter((line, index) => index > 0 || line)
    .join('\n');
  return { system: VERIFY_SYSTEM_PROMPT, user };
}

// ---------------------------------------------------------------- 解析

/** 去掉模型爱加的那些壳：`**类型：**`、`# 类型：`、`- 类型:`、全角空格 */
function cleanKeyLine(line) {
  return String(line || '')
    // 先去掉加粗标记：`**类型：**合并` 去完是 `类型：合并`。
    // 不能只按"行首是列表符号"那条去 `*`：`**` 的开头也是 `*`，先去一个会留下 `*类型：`。
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*[-*+#]+\s*/, '')
    .replace(/\u3000/g, ' ')
    .trim();
}

/** 一行是不是块分隔（`===建议===` / `===结论===`，容错空格和井号） */
function blockMarker(line) {
  const text = cleanKeyLine(line).replace(/\s+/g, '');
  if (/^=+建议=+$/.test(text)) return 'suggest';
  if (/^=+结论=+$/.test(text)) return 'verdict';
  return '';
}

/** 把一段文本拆成「建议块 / 结论块」 */
function splitBlocks(raw) {
  const blocks = [];
  let current = null;
  for (const rawLine of String(raw || '').split(/\r?\n/)) {
    const marker = blockMarker(rawLine);
    if (marker) {
      current = { type: marker, lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(rawLine);
  }
  return blocks;
}

const FIELD_KEYS = ['类型', '条目', '标题', '标签', '正文', '理由', '结果'];

/**
 * 解析一个块里的「键：值」。正文允许换行：一直收到下一个键为止。
 * 这个宽容度是必须的：真机上模型会把 `标题：` 写成 `**标题：**`、把正文写成好几行。
 */
function parseFields(lines) {
  const fields = {};
  let lastKey = '';
  for (const rawLine of lines) {
    const line = cleanKeyLine(rawLine);
    if (!line) {
      if (lastKey) fields[lastKey] = `${fields[lastKey]}\n`.trimEnd().length ? `${fields[lastKey]}\n` : fields[lastKey];
      continue;
    }
    const match = line.match(/^([^:：]{1,6})\s*[:：]\s*([\s\S]*)$/);
    const key = match ? match[1].trim() : '';
    if (match && FIELD_KEYS.includes(key)) {
      lastKey = key;
      fields[key] = match[2].trim();
    } else if (lastKey) {
      fields[lastKey] = `${fields[lastKey]}\n${line}`.trim();
    }
  }
  return fields;
}

/** 「条目：k-a、k-b」→ ['k-a','k-b']（全角逗号、空格、分号都认） */
function parseIdList(raw) {
  return String(raw || '')
    .split(/[,，、;；\s]+/)
    .map((id) => id.replace(/^id[:：]?/i, '').trim())
    .filter(Boolean);
}

/**
 * 把模型输出解析成建议条目。
 *
 * @param {string} raw 模型原文
 * @param {{knownIds?:string[]}} [options] `knownIds` 给了就**丢掉指向不存在条目的建议**
 *   （模型偶尔会把 id 抄错；宁可不显示，也不能应用时才发现）
 * @returns {Array<{kind:string, noteIds:string[], title:string, tags:string, content:string, reason:string}>}
 */
function parseReviewItems(raw, { knownIds = null } = {}) {
  const known = Array.isArray(knownIds) ? new Set(knownIds.map(String)) : null;
  const out = [];
  for (const block of splitBlocks(raw)) {
    if (block.type !== 'suggest') continue;
    const fields = parseFields(block.lines);
    const noteIds = parseIdList(fields['条目']).filter((id) => (known ? known.has(id) : true));
    if (!noteIds.length) continue;
    const content = String(fields['正文'] || '').trim().slice(0, MAX_CONTENT_CHARS);
    const kind = normaliseKind(fields['类型'], noteIds, content);
    if (kind !== 'delete' && !content) continue; // 说改写却没给正文 → 没法应用，丢掉
    out.push({
      kind,
      noteIds,
      title: String(fields['标题'] || '').trim(),
      tags: String(fields['标签'] || '').trim(),
      content: kind === 'delete' ? '' : content,
      reason: String(fields['理由'] || '').trim()
    });
  }
  return out;
}

/**
 * 解析「单条校对」的回答。
 * @returns {{verdict:'unchanged'|'changed', reason:string, item:object|null}}
 */
function parseVerifyAnswer(raw, { noteId = '', knownIds = null } = {}) {
  const blocks = splitBlocks(raw);
  const verdictBlock = blocks.find((block) => block.type === 'verdict');
  if (verdictBlock) {
    const fields = parseFields(verdictBlock.lines);
    const result = String(fields['结果'] || '').trim();
    if (/无需|不用|没(有)?(问题|改动)|unchanged|ok/i.test(result)) {
      return { verdict: 'unchanged', reason: String(fields['理由'] || '').trim(), item: null };
    }
  }
  const items = parseReviewItems(raw, { knownIds: knownIds || (noteId ? [noteId] : null) });
  const item = items[0] || null;
  if (!item) {
    return { verdict: 'unchanged', reason: '', item: null };
  }
  return { verdict: 'changed', reason: item.reason, item };
}

// ---------------------------------------------------------------- 选目标 / 判改动

/**
 * 选这次要联网校对的条目。
 *
 * 规则（宁可少跑，也不许悄悄多花钱）：
 *   · 只选**没锁**的（锁了的不许改，查了也白查）；
 *   · 指定了 ids 就按指定顺序来，指定了不存在的 id 记进 `missing`；
 *   · 没指定就按「最久没更新」优先（老知识更可能过时）；
 *   · 超出 `limit` 的部分记进 `truncated`，界面要如实说「还有 N 条这次没跑」。
 */
function selectVerifyTargets({ notes = [], ids = null, limit = DEFAULT_VERIFY_LIMIT } = {}) {
  const list = (Array.isArray(notes) ? notes : []).filter((note) => note && note.id);
  const byId = new Map(list.map((note) => [String(note.id), note]));
  const skippedLocked = [];
  const missing = [];
  let pool;
  if (Array.isArray(ids) && ids.length) {
    pool = [];
    for (const id of ids) {
      const note = byId.get(String(id));
      if (!note) {
        missing.push(String(id));
        continue;
      }
      if (note.locked) {
        skippedLocked.push(note);
        continue;
      }
      if (!pool.includes(note)) pool.push(note);
    }
  } else {
    pool = [...list]
      .filter((note) => {
        if (note.locked) {
          skippedLocked.push(note);
          return false;
        }
        return true;
      })
      .sort((a, b) => String(a.updated || '').localeCompare(String(b.updated || '')));
  }
  const max = Math.max(1, Number(limit) || DEFAULT_VERIFY_LIMIT);
  const targets = pool.slice(0, max);
  const truncated = Math.max(0, pool.length - targets.length);
  return { targets, skippedLocked, missing, truncated, total: pool.length };
}

/** 这条笔记在「生成建议之后」被改过吗（改过就别应用，免得盖掉主播的手改） */
function noteChangedSince(before, note) {
  if (!before || !note) return true;
  const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
  const tagsOf = (value) =>
    (Array.isArray(value) ? value : String(value || '').split(/[,，、\s]+/)).filter(Boolean).join(',');
  return !(
    same(before.title, note.title) &&
    same(before.content, note.content) &&
    tagsOf(before.tags) === tagsOf(note.tags)
  );
}

/** 给界面看的一句「改了什么」：标题/标签/正文分别变了没 */
function describeChange(item) {
  if (!item) return '';
  const before = item.before || {};
  const after = item.after || {};
  const parts = [];
  if (String(before.title || '') !== String(after.title || '')) parts.push('标题');
  const tagsOf = (value) =>
    (Array.isArray(value) ? value : String(value || '').split(/[,，、\s]+/)).filter(Boolean).join(',');
  if (tagsOf(before.tags) !== tagsOf(after.tags)) parts.push('标签');
  if (String(before.content || '').trim() !== String(after.content || '').trim()) {
    parts.push(`正文 ${String(before.content || '').length} → ${String(after.content || '').length} 字`);
  }
  if (item.kind === 'merge' && item.dropIds && item.dropIds.length) {
    parts.push(`并入 ${item.noteIds.length} 条、删掉 ${item.dropIds.length} 条`);
  }
  if (item.kind === 'delete') parts.push('删掉这条');
  return parts.join('；') || '内容没变化';
}

module.exports = {
  REVIEW_THINKING,
  AUDIT_EXCERPT_CHARS,
  MAX_AUDIT_NOTES,
  VERIFY_RESULTS,
  MAX_REVIEW_ITEMS,
  DEFAULT_VERIFY_LIMIT,
  KINDS,
  KIND_LABELS,
  normaliseKind,
  briefNote,
  auditNotes,
  buildAuditPrompt,
  buildVerifyPrompt,
  parseReviewItems,
  parseVerifyAnswer,
  parseFields,
  parseIdList,
  selectVerifyTargets,
  noteChangedSince,
  describeChange,
  AUDIT_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT
};
