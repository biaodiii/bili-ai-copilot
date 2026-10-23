'use strict';

/**
 * 主动搭话（proactive）：直播间冷场时，让搭档自己先开口。
 *
 * 主播原话：*「我觉得要做成高度可定制，并且可以写进提示词里的」*。
 * 所以这里把「什么时候搭」「搭什么」「多久一次」全拆成配置，最后一段**自由提示词**
 * 会原样拼进提示词里——主播想加什么规矩都能写。
 *
 * ⚠️ **没有「进场招呼」了**（2026-10-21 删的）：实测 B 站这条连接**收不到进场事件**
 *    （INTERACT_WORD 不来），所以「有人进场就招呼一句」永远不会触发，留着就是死功能。
 *    想招呼某个观众，主播自己在输入框说一句就行。
 *
 * 本文件只放**纯函数**（提示词、解析、选方式、限频判断），方便单测；
 * 真正的定时器、调模型、发回复在 `copilot.js` 的 `scheduleProactive/triggerProactive` 里。
 *
 * 设计上的三条底线：
 *   1. **不抢话**：只在安静了 N 秒之后才搭；搭话期间来了新弹幕就这条作废（不花钱也不刷屏）；
 *   2. **不刷屏**：每小时最多 N 次 + 每次冷场只有 X% 概率真的开口（不够自然就别硬搭）；
 *   3. **不重复**：最近说过的那几句会喂回给模型，让它换着说；三种方式也尽量轮换。
 */

/** 三种搭话方式（顺序就是界面上的顺序） */
const MODES = ['topic', 'ask', 'follow'];
const MODE_LABELS = { topic: '开话题', ask: '问观众', follow: '接话' };

const DEFAULT_IDLE_SECONDS = 180;
const MIN_IDLE_SECONDS = 30;
const MAX_IDLE_SECONDS = 1800;
const DEFAULT_MAX_PER_HOUR = 6;
const MAX_PER_HOUR_LIMIT = 60;
const DEFAULT_CHANCE = 70;
const DEFAULT_MAX_CHARS = 40;
const MIN_MAX_CHARS = 20;
const MAX_MAX_CHARS = 120;
/** 两句话之间至少隔这么久（别刚说完又被抽签抽中再来一句） */
const MIN_GAP_MS = 60 * 1000;
const MAX_RECENT_UTTERANCES = 5;
const MAX_RECENT_LINES = 6;
const HOUR_MS = 3600 * 1000;

const DEFAULT_PROMPT = '别太刻意，像随口聊天一样；不要连着两次用同一种方式；有人说话的时候不要抢话。';

/** 只留合法的搭话方式；给了数组就按数组来（空数组 = 一种都不许，等于关掉） */
function normaliseModes(raw) {
  if (!Array.isArray(raw)) return MODES.slice();
  const out = [];
  for (const mode of MODES) {
    if (raw.includes(mode)) out.push(mode);
  }
  return out;
}

/** 最近一小时说过几次（`times` 是毫秒时间戳数组） */
function countRecent(times, now = Date.now(), windowMs = HOUR_MS) {
  if (!Array.isArray(times)) return 0;
  return times.filter((ts) => Number.isFinite(ts) && now - ts < windowMs && ts <= now).length;
}

/**
 * 这次冷场要不要真的开口。
 *
 * 返回 `{ok:false, reason}` 时**什么都不做**（不调模型、不花钱）：
 *   off      = 开关关着；rate = 这一小时说够了；chance = 这次抽签没过；
 *   gap      = 离上一句太近；nomode = 三种方式全被关掉了
 */
function shouldSpeak({ config = {}, now = Date.now(), times = [], lastSpokeAt = 0, random = Math.random } = {}) {
  const enabled = config.enabled === true;
  if (!enabled) return { ok: false, reason: 'off' };
  const maxPerHour = Number(config.maxPerHour);
  if (Number.isFinite(maxPerHour) && maxPerHour > 0 && countRecent(times, now) >= maxPerHour) {
    return { ok: false, reason: 'rate' };
  }
  const gap = lastSpokeAt && now - lastSpokeAt < MIN_GAP_MS;
  if (gap) return { ok: false, reason: 'gap' };
  const modes = normaliseModes(config.modes);
  if (!modes.length) return { ok: false, reason: 'nomode' };
  const chance = Number(config.chancePercent);
  const percent = Number.isFinite(chance) ? Math.max(0, Math.min(100, chance)) : DEFAULT_CHANCE;
  if (percent < 100 && random() * 100 >= percent) return { ok: false, reason: 'chance' };
  return { ok: true };
}

/** 这次用哪种方式：尽量和上一次不同（三种轮着来才不像机器人） */
function chooseMode({ modes, lastMode = '', random = Math.random } = {}) {
  const list = normaliseModes(modes);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  const others = list.filter((mode) => mode !== lastMode);
  const pool = others.length ? others : list;
  const index = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return pool[index];
}

const MODE_HINTS = {
  topic:
    '开一个新话题：聊游戏、聊直播内容、聊轻松的日常都行。' +
    '如果下面有「可以聊的料」，挑一条用你自己的话说出来，**不要照念原文**。',
  ask: '问观众一个**容易回答**的小问题（一句话），最好和刚才聊的东西有关，别问需要长篇大论的。',
  follow: '顺着最近观众说过、但没人接下去的那句话，往下问一句，把话头接上。'
};

/**
 * 拼这次「主动搭话」的提示词。
 *
 * @param {object} input
 *   mode           = topic / ask / follow
 *   config         = settings.proactive
 *   idleSeconds    = 这次安静了多久（用来告诉模型"真的很安静"）
 *   recentLines    = 最近几条弹幕 / 她说的话（纯文本数组，已截断）
 *   lastUtterances = 最近几次主动搭话说过的话（防重复）
 *   knowledgeBlock = 从知识库挑的「可以聊的料」（可为空）
 * @returns {{text:string, history:string, mode:string, historyLine:string}}
 *   `text` 会作为这条 user 消息发给模型；`history` 是**存进对话记忆**的那句（简短，不带资料）
 */
function buildProactivePrompt({
  mode = 'topic',
  config = {},
  idleSeconds = 0,
  recentLines = [],
  lastUtterances = [],
  knowledgeBlock = ''
} = {}) {
  const maxChars = Math.max(
    MIN_MAX_CHARS,
    Math.min(MAX_MAX_CHARS, Number(config.maxChars) || DEFAULT_MAX_CHARS)
  );
  const head = `【直播间很安静】距离上一条弹幕/回复已经过了 ${Math.max(1, Math.round(idleSeconds))} 秒。`;
  const task = '现在由你主动开口，说一句话把话题带起来。';
  const lines = [
    head,
    task,
    '',
    `【这次的方式】${MODE_LABELS[mode] || MODE_LABELS.topic}：${MODE_HINTS[mode] || MODE_HINTS.topic}`,
    '',
    '【硬要求】',
    `1. 说出口的只有一句话，不超过 ${maxChars} 字；像真人顺口搭话，不要客服腔、不要旁白、不要解释你为什么要说话。`,
    '2. 不要自称 AI、不要提模型或厂商。',
    '3. 别重复「最近你已经主动说过」里的话，也别重复问同一件事。',
    '4. **如果你判断现在确实不该开口，就只输出 `[跳过]` 四个字**（比如按下面的规矩这个场合不合适）。'
  ];
  const custom = String(config.prompt || '').trim();
  if (custom) {
    lines.push('', '【主播给你定的搭话规矩】（优先遵守）', custom);
  }
  const recent = (Array.isArray(recentLines) ? recentLines : [])
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-MAX_RECENT_LINES);
  if (recent.length) {
    lines.push('', '【最近聊过的】', recent.map((line) => `· ${line.slice(0, 120)}`).join('\n'));
  }
  const said = (Array.isArray(lastUtterances) ? lastUtterances : [])
    .map((line) => String(line || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-MAX_RECENT_UTTERANCES);
  if (said.length) {
    lines.push('', '【最近你已经主动说过】（别重复这些）', said.map((line) => `· ${line.slice(0, 120)}`).join('\n'));
  }
  if (knowledgeBlock) {
    lines.push('', '【可以聊的料】（有就挑一条用，没有就不用）', String(knowledgeBlock).trim());
  }
  const history = '（直播间没人说话，你自己开口搭了一句）';
  return { text: lines.join('\n'), history, mode, historyLine: history };
}

/** 去掉模型爱加的壳：代码块、引号、「」、开头的“答：” */
function cleanProactiveText(raw) {
  let text = String(raw || '')
    .replace(/^```[a-zA-Z]*\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim();
  text = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0] || '';
  text = text.replace(/^(?:搭话|回答|答|台词)\s*[:：]\s*/, '').trim();
  text = text.replace(/^["“「『]+/, '').replace(/["”」』]+$/, '').trim();
  return text;
}

/**
 * 解析模型对「主动搭话」的回答。
 *
 * @returns {{skip:boolean, reason:string, text:string, problem?:string}}
 *   - `[跳过]` → skip=true（这次不开口，也不计入次数）
 *   - 空 / 太长 / 像在念提示词 → problem（调用方记日志、这条不发）
 */
function parseProactiveAnswer(raw, { maxChars = DEFAULT_MAX_CHARS } = {}) {
  const source = String(raw || '').trim();
  const skipMatch = source.match(/\[跳过\](?:\s*[:：]\s*([^\n]{0,80}))?/);
  if (skipMatch) return { skip: true, reason: String(skipMatch[1] || '').trim(), text: '' };
  const text = cleanProactiveText(source);
  if (!text) return { skip: false, reason: '', text: '', problem: '模型没给正文' };
  const limit = Math.max(MIN_MAX_CHARS, Math.min(MAX_MAX_CHARS, Number(maxChars) || DEFAULT_MAX_CHARS));
  if (text.length > limit * 2) {
    return { skip: false, reason: '', text: '', problem: `太长了（${text.length} 字，上限约 ${limit} 字）` };
  }
  // 把提示词抄回来了 / 在加旁白 —— 这种话发出去就露馅了
  // 提示词里的段落都用【】包着（【硬要求】【这次的方式】…），正常说话不会这么开头。
  if (/【[^】]{1,12}】/.test(text) || /^[（(]/.test(text)) {
    return { skip: false, reason: '', text: '', problem: '像是把提示词抄回来了' };
  }
  return { skip: false, reason: '', text };
}

/** 给界面/日志用的一句话：「主动搭话（问观众）：xxx」 */
function describeUtterance(mode, text) {
  const label = MODE_LABELS[mode] || '主动搭话';
  return `主动搭话（${label}）：${String(text || '').slice(0, 60)}`;
}

module.exports = {
  MODES,
  MODE_LABELS,
  MODE_HINTS,
  DEFAULT_IDLE_SECONDS,
  MIN_IDLE_SECONDS,
  MAX_IDLE_SECONDS,
  DEFAULT_MAX_PER_HOUR,
  MAX_PER_HOUR_LIMIT,
  DEFAULT_CHANCE,
  DEFAULT_MAX_CHARS,
  MIN_MAX_CHARS,
  MAX_MAX_CHARS,
  MIN_GAP_MS,
  MAX_RECENT_UTTERANCES,
  MAX_RECENT_LINES,
  HOUR_MS,
  DEFAULT_PROMPT,
  normaliseModes,
  countRecent,
  shouldSpeak,
  chooseMode,
  buildProactivePrompt,
  parseProactiveAnswer,
  cleanProactiveText,
  describeUtterance
};
