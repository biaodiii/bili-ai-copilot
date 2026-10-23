'use strict';

/**
 * 「模型想查 / 想记」的待办队列，以及「查资料」的执行。
 *
 * ## 为什么要有这一层
 *
 * 主播要的是：模型能**主动**发现「这个东西值得记下来」，并且在真去查之前**问一声**。
 * 但直播中主播在忙，所以流程设计成三段，每段都可控：
 *
 * ```
 * 直播间里冒出「明日方舟」→ 模型在回复里藏一个 [待查:明日方舟]（观众看不到）
 *        ↓
 * 面板「模型想查/想记」卡片列出待办 → 主播点「去查」
 *        ↓
 * 联网查完 → 产出只进「待审草稿」→ 主播点通过才进知识库
 * ```
 *
 * 三段的用意：**花钱和写库这两件事都要主播点头**。
 * 标记解析在 `llm.js`（`extractResearchMarks`），执行在 `main.js`（IPC `research:*`），
 * 这里只负责「待办清单」和「查一次资料」。
 *
 * ## 三条查询引擎（主播在面板上选）
 *
 * - `builtin` + `searchMode: 'self'`（默认）：DeepSeek 的**自研搜索接口**
 *   `POST /v1/tools/search`，先拿结构化结果再让模型整理。实测 0.7 秒出结果、一次约 0.008 元。
 * - `builtin` + `searchMode: 'model'`：老办法，DeepSeek 的 Anthropic 兼容接口 +
 *   原生 `web_search` 服务端工具，模型一边搜一边写。实测 6~15 秒、一次约 0.03 元。
 * - `dsh`：交给本机的 DeepSeek Harness（能读文件、能联网），慢但能干更复杂的活。
 *
 * 前两条是**同一件事的两种走法**，产出格式完全一样；自研搜索失败时 `main.js` 会自动退回老办法。
 *
 * 实测数据（改这里前先看）：普通弹幕回复 ~1~2 秒、自研搜索 0.7+整理 ≈3 秒、
 * 老办法联网 6~15 秒、DSH 最简任务 ~51 秒。
 * 所以**查询永远是后台慢活**，绝不能插进直播实时链路。
 *
 * ⚠️ 计时算到「正文读完」为止（见 `searchWithDeepSeek` 里的注释）：`fetch` 在响应头回来时
 * 就 resolve 了，正文还要再等几秒 —— 早算会显示成「用时 0 秒」。
 */

const fs = require('fs');
const path = require('path');

/** 队列上限：到顶了就把最老的已处理项挤掉（待办项永远保留） */
const MAX_ITEMS = 50;
/** 同一条内容多久之内算重复（模型很容易连着几条都提同一件事） */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
/**
 * 待办的几种类型。前两种「只提议」，后面几种（P6/P7）会**真的动知识库**：
 *   lookup 想联网查一下 / note 想记一条 / edit 想改一条已有的 / expand 想给已有条目补内容 / remove 想删掉一条
 */
const KINDS = ['lookup', 'note', 'edit', 'expand', 'remove'];

function normaliseKind(kind) {
  const value = String(kind || '');
  return KINDS.includes(value) ? value : 'lookup';
}

function normaliseText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

class ResearchQueue {
  /**
   * @param {{file:string, logger?:object, now?:() => number}} options
   *   `file` 是队列的落盘位置（主进程传 `data/research.json`；测试传临时文件）
   */
  constructor({ file, logger, now } = {}) {
    this.file = file ? path.resolve(String(file)) : '';
    this.logger = logger || console;
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.items = [];
    this.load();
  }

  load() {
    this.items = [];
    if (!this.file) return this.items;
    try {
      if (!fs.existsSync(this.file)) return this.items;
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.items) ? parsed.items : [];
      this.items = list
        .filter((item) => item && typeof item === 'object' && item.id && item.text)
        .map((item) => ({
          id: String(item.id),
          kind: normaliseKind(item.kind),
          text: String(item.text).slice(0, 200),
          reason: String(item.reason || '').slice(0, 120),
          source: String(item.source || '').slice(0, 200),
          status: ['pending', 'running', 'done', 'ignored', 'failed'].includes(item.status) ? item.status : 'pending',
          createdAt: String(item.createdAt || ''),
          finishedAt: String(item.finishedAt || ''),
          draftIds: Array.isArray(item.draftIds) ? item.draftIds.map(String) : [],
          error: String(item.error || '').slice(0, 300),
          engine: String(item.engine || '').slice(0, 20),
          // 改库那两种类型要记下「动的是哪条知识」和「旧版本备份在哪」，面板才能给出撤销入口
          noteId: String(item.noteId || '').slice(0, 80),
          editId: String(item.editId || '').slice(0, 120),
          // 这条是**她自己动的手**（没等主播点头）：用来算「每小时最多改几次」和面板上区分显示
          auto: Boolean(item.auto)
        }));
    } catch (error) {
      this.logger.warn?.(`待办队列读不了（${error.message}），这次按空队列处理`);
    }
    return this.items;
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items: this.items }, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.logger.warn?.(`待办队列写不进去：${error.message}`);
    }
  }

  /** 待办优先、其余按时间倒序（界面直接照这个顺序画） */
  list() {
    const rank = { pending: 0, running: 1, failed: 2, done: 3, ignored: 4 };
    return [...this.items].sort((a, b) => {
      const byRank = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (byRank !== 0) return byRank;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
  }

  get(id) {
    return this.items.find((item) => item.id === String(id)) || null;
  }

  count() {
    return this.items.filter((item) => item.status === 'pending' || item.status === 'running').length;
  }

  /**
   * 加一条待办。重复的（同 kind + 同内容，且第一条还没处理完 / 十分钟内刚处理过）直接丢掉。
   * @returns {{ok:boolean, item?:object, duplicate?:boolean, reason?:string}}
   */
  add({ kind, text, reason, source, auto = false, noteId = '', editId = '' } = {}) {
    const value = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!value) return { ok: false, reason: '内容是空的' };
    const type = normaliseKind(kind);
    const key = normaliseText(value);
    const now = this.now();
    const duplicate = this.items.find(
      (item) =>
        item.kind === type &&
        normaliseText(item.text) === key &&
        (item.status === 'pending' ||
          item.status === 'running' ||
          (item.finishedAt && now - Date.parse(item.finishedAt) < DEDUPE_WINDOW_MS))
    );
    if (duplicate) return { ok: true, item: duplicate, duplicate: true };

    const item = {
      id: `r-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind: type,
      text: value,
      reason: String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      source: String(source || '').slice(0, 200),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      finishedAt: '',
      draftIds: [],
      error: '',
      engine: '',
      noteId: String(noteId || '').slice(0, 80),
      editId: String(editId || '').slice(0, 120),
      auto: Boolean(auto)
    };
    this.items.push(item);
    this._trim();
    this._save();
    return { ok: true, item, duplicate: false };
  }

  /** 超过上限时：先丢最老的已处理项；全是待办就丢最老的（宁可丢提醒，也不让文件无限长） */
  _trim() {
    while (this.items.length > MAX_ITEMS) {
      const doneIndex = this.items.findIndex((item) => item.status === 'done' || item.status === 'ignored');
      this.items.splice(doneIndex >= 0 ? doneIndex : 0, 1);
    }
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    if (patch.status && (patch.status === 'done' || patch.status === 'ignored' || patch.status === 'failed')) {
      item.finishedAt = item.finishedAt || new Date(this.now()).toISOString();
    }
    this._save();
    return item;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== String(id));
    if (this.items.length !== before) this._save();
    return this.items.length !== before;
  }

  /** 把「已处理」的清掉（界面上「清空已处理」按钮） */
  clearFinished() {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.status === 'pending' || item.status === 'running');
    const removed = before - this.items.length;
    if (removed) this._save();
    return removed;
  }
}

/**
 * 内置联网查询：走 DeepSeek 的 **Anthropic 兼容接口 + 原生 `web_search` 服务端工具**。
 *
 * 实测（同一个 API Key，不用买第三方搜索服务）：
 * `POST https://api.deepseek.com/anthropic/v1/messages` +
 * `tools: [{type:'web_search_20250305', name:'web_search', max_uses:3}]`
 * → **7~15 秒**（看服务端搜几次：跑过 7 秒/2 次搜索/20 条结果，也跑过 15 秒/4 次/30 条），
 * input 约 1.5 万 token（搜索结果会进上下文）。
 *
 * 失败一律变成返回值（不抛），让调用方决定怎么说给用户听。
 *
 * @returns {Promise<{ok:boolean, text:string, searches:number, ms:number, message?:string, status?:number}>}
 */
async function searchWithDeepSeek({ apiKey, baseUrl, model, query, timeoutMs = 120000, fetchImpl, logger } = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, text: '', searches: 0, ms: 0, message: '还没填 DeepSeek API Key' };
  const prompt = String(query || '').trim();
  if (!prompt) return { ok: false, text: '', searches: 0, ms: 0, message: '查询内容是空的' };
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, text: '', searches: 0, ms: 0, message: '这个环境没有 fetch' };

  const root = String(baseUrl || '').replace(/\/+$/, '') || 'https://api.deepseek.com';
  const url = `${root}/anthropic/v1/messages`;
  const started = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: String(model || 'deepseek-flash'),
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      }),
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) {
      const detail = String(await response.text().catch(() => '')).slice(0, 300);
      // 用时一律算到「正文读完」为止：`fetch` 在**响应头**回来时就 resolve 了，
      // 正文（联网搜索的结果）可能还要再等好几秒 —— 真机上就因此显示过「用时 0 秒」。
      return { ok: false, text: '', searches: 0, ms: Date.now() - started, status: response.status, message: `接口返回 ${response.status}：${detail}` };
    }
    const payload = await response.json();
    const ms = Date.now() - started;
    const blocks = Array.isArray(payload && payload.content) ? payload.content : [];
    let text = '';
    let searches = 0;
    let results = 0;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      // 服务端搜索的痕迹：`server_tool_use` 是「发起了一次搜索」，
      // `web_search_tool_result` 里是这次搜索的结果条数（只用来在日志里看花了多少）
      if (block.type === 'server_tool_use' && block.name === 'web_search') searches += 1;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) results += block.content.length;
    }
    return { ok: true, text: text.trim(), searches, results, ms };
  } catch (error) {
    const ms = Date.now() - started;
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
    logger?.warn?.(`内置联网查询失败：${error && error.message}`);
    return {
      ok: false,
      text: '',
      searches: 0,
      ms,
      message: aborted ? `超过 ${Math.round(timeoutMs / 1000)} 秒还没查完（已中止）` : String((error && error.message) || error)
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ==================================================================
 * 自研搜索接口（DeepSeek Search，2026-10-17 开放）
 *
 * 和上面那条老路的区别：老路是「模型一边搜一边写」，这一条是「先搜到结构化结果，
 * 再让模型照着结果整理」。实测同一条查询词：
 *
 * |            | 老路（web_search 工具） | 自研搜索 |
 * |------------|------------------------|----------|
 * | 用时       | 5598ms（搜了 2 次）     | 725ms    |
 * | token      | 输入 15736 / 输出 750   | 0（搜索不烧 token） |
 * | 费用       | ≈0.029 元（含 2 次搜索） | ≈0.008 元 |
 * | 额外好处   | 模型顺手把话说圆        | 每条结果带站点/日期/权威度/链接 |
 *
 * 所以：**默认走这一条**，老路留着兜底（`knowledge.searchMode` 里能换回去）。
 * 产出格式两边完全一样（`===知识条目===`），都走 `parseDrafts` → 待审草稿。
 * ================================================================== */

/** 一次要几条结果（接口允许 1~50）。8 条够挑了，请求按次计费，要多了不加钱但也没用 */
const SEARCH_COUNT = 8;
/** 真正塞给模型看的条数：接口长摘要每条 600~800 字，5 条就两三千字了 */
const SEARCH_FOR_MODEL = 5;
/** 单条摘要最多留多少字（防它偶尔返回一整篇正文） */
const SEARCH_SUMMARY_CHARS = 1200;
/** 接口限制：query 1~128 个 Unicode 字符，超了直接 400，所以自己先截 */
const SEARCH_QUERY_MAX = 128;
/** 权威度（0~4，-1 未知）：≥3 算「极权威」，排序时给一点加成 */
const AUTHORITY_GOOD = 3;

/**
 * 结果排序：相关度为主，权威度当加成。
 *
 * 为什么不干脆按权威度排：百度百科权威度也是 3，但「新版本什么时候上线」这种问题，
 * 百科页经常还是上一版的内容 —— `rerank_score`（0~3，≥1.5 算优质）才是
 * 「这条能不能回答这个问题」的主要信号，权威度只用来分个高下。
 */
function rankSearchResults(results) {
  const score = (item) => {
    const relevance = Number(item && item.rerank_score) || 0;
    const authority = Number(item && item.authority);
    return relevance + (Number.isFinite(authority) && authority >= AUTHORITY_GOOD ? 0.5 : 0);
  };
  return [...results].sort((a, b) => score(b) - score(a));
}

/** 把结果排成「给模型看的一段话」：标题 / 站点 + 日期 + 权威度 / 摘要 / 链接 */
function buildResultsBlock(results) {
  return results
    .map((item, index) => {
      const title = String((item && item.title) || '').trim() || '(无标题)';
      const site = String((item && item.site_name) || '').trim() || '未知站点';
      const date = String((item && item.date) || '').slice(0, 10);
      const authority = Number(item && item.authority);
      const summary = String((item && (item.summary || item.snippet)) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SEARCH_SUMMARY_CHARS);
      const meta = [site, date, Number.isFinite(authority) && authority >= 0 ? `权威度 ${authority}` : '']
        .filter(Boolean)
        .join(' · ');
      return `[${index + 1}] ${title}（${meta}）\n${summary}\n链接：${String((item && item.url) || '')}`;
    })
    .join('\n\n');
}

/**
 * 「整理」那一步挂了时的兜底：把摘要直接拼成条目格式。
 *
 * 宁可给主播一段粗摘要，也不能白搜一场（和 `parseDrafts` 的兜底同一个思路：
 * 格式不对就整段收下，让人自己删，绝不悄悄丢结果）。
 */
function buildSummaryDrafts(picked) {
  return picked
    .slice(0, 2)
    .map((item) => {
      const title = String((item && item.title) || '').trim() || '联网查到的内容';
      const site = String((item && item.site_name) || '').trim();
      const body = String((item && (item.summary || item.snippet)) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
      return ['===知识条目===', `标题：${title}`, `标签：${site}`, `正文：${body}`].join('\n');
    })
    .join('\n\n');
}

/**
 * 接口失败翻成人话。402 是最要命的那个（余额不足）：必须一眼看出来，
 * 否则主播会以为「搜索坏了」，反复点、一直失败。
 */
function describeSearchError(status, detail) {
  const body = String(detail || '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  if (status === 401) return 'API Key 不对或已失效（去「DeepSeek API」页重新填一个）';
  if (status === 402) return '账号余额不足 —— 先去 platform.deepseek.com 充值';
  if (status === 403) return '这次搜索被安全策略拒了（换个查询词再试）';
  if (status === 429) return '搜索请求太密了（每秒最多 5 次），等一秒再点一次';
  if (status === 408 || status >= 500) return `搜索服务暂时不可用（HTTP ${status}），过一会儿再点一次`;
  return `接口返回 ${status}${body ? `：${body}` : ''}`;
}

/**
 * 发一个 JSON POST，把「响应头回来」和「正文读完」一起算。
 * 失败不抛，一律返回结果对象 —— 调用方来决定怎么说给主播听。
 */
async function requestJson({ doFetch, url, key, payload, timeoutMs }) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });
    const raw = await response.text();
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch (_) {
      parsed = null;
    }
    return { ok: Boolean(response.ok), status: response.status, payload: parsed, raw };
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')));
    return { ok: false, status: 0, payload: null, raw: '', aborted, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 自研搜索：`POST /v1/tools/search` 搜一次 → 让模型照着结果整理成知识条目。
 *
 * 之所以要第二步：搜索引擎给的是「素材」（摘要 + 链接），我们要的是**能直接进知识库的条目**
 * （主播点「通过」就生效的那种）。第二步不开思考模式（`thinking: disabled`）——
 * 这就是个照抄+归纳的活，开着思考只是多花时间和输出 token。
 *
 * 第二步挂掉的降级：直接拿摘要拼条目（`degraded: true`，仍然算查到了）。
 *
 * @returns {Promise<{ok:boolean, text:string, searches:number, results:number, ms:number,
 *   sources:Array<object>, degraded?:boolean, kind?:string, status?:number, message?:string,
 *   stats?:object, usage?:object}>}
 */
/**
 * 只搜、不整理：`POST /v1/tools/search` 拿结构化结果。
 *
 * 抽出来是因为有第二个使用方：知识库的「联网校对」（`main.js` 的 review 流水线）
 * 要的是**原始资料**（标题 / 站点 / 日期 / 摘要 / 链接），自己拼提示词，
 * 而不是先让模型"整理"一遍（那会多花一次调用，还丢来源）。
 *
 * @returns {Promise<{ok:boolean, all?:Array<object>, results?:Array<object>, sources?:Array<object>,
 *   ms:number, kind?:string, status?:number, message?:string}>}
 *   `all` = 接口返回的全部结果；`results` = 排好序、截给模型看的前几条；`sources` = 给界面显示的摘要。
 */
async function searchRaw({
  apiKey,
  baseUrl,
  keyword,
  oriQuestion = '',
  count = SEARCH_COUNT,
  timeoutMs = 30000,
  fetchImpl,
  logger
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, ms: 0, kind: 'config', message: '还没填 DeepSeek API Key' };
  const word = String(keyword || '').replace(/\s+/g, ' ').trim();
  if (!word) return { ok: false, ms: 0, kind: 'config', message: '查询内容是空的' };
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return { ok: false, ms: 0, kind: 'config', message: '这个环境没有 fetch' };
  const root = String(baseUrl || '').replace(/\/+$/, '') || 'https://api.deepseek.com';
  const started = Date.now();
  const payload = {
    query: word.slice(0, SEARCH_QUERY_MAX),
    count: Math.min(50, Math.max(1, Number(count) || SEARCH_COUNT)),
    // 不要正文：长摘要够用，正文只会把 token 吃掉（真要看正文可以再走 Fetch）
    need_content: false
  };
  const original = String(oriQuestion || '').replace(/\s+/g, ' ').trim();
  if (original) payload.ori_question = original.slice(0, SEARCH_QUERY_MAX);

  const searched = await requestJson({ doFetch, url: `${root}/v1/tools/search`, key, payload, timeoutMs });
  const ms = Date.now() - started;
  if (!searched.ok) {
    const message = searched.aborted
      ? `搜索超过 ${Math.round(timeoutMs / 1000)} 秒没回（已中止）`
      : searched.status
        ? describeSearchError(searched.status, searched.raw)
        : `连不上搜索接口：${(searched.error && searched.error.message) || '未知错误'}`;
    logger?.warn?.(`自研搜索失败：${message}${searched.status ? `（HTTP ${searched.status}）` : ''}`);
    return { ok: false, ms, kind: 'search', status: searched.status, message };
  }
  const all = Array.isArray(searched.payload && searched.payload.results) ? searched.payload.results : [];
  if (!all.length) {
    // 空结果也计费（文档说 results 必须非空才计费，所以这里其实没花钱）
    return { ok: false, ms, kind: 'empty', message: '自研搜索没搜到结果（换个说法再查一次试试）' };
  }
  const results = rankSearchResults(all).slice(0, SEARCH_FOR_MODEL);
  const sources = results.map((item) => ({
    title: String((item && item.title) || '').slice(0, 120),
    url: String((item && item.url) || ''),
    site: String((item && item.site_name) || ''),
    date: String((item && item.date) || '').slice(0, 10),
    authority: Number(item && item.authority)
  }));
  return { ok: true, all, results, sources, ms, message: '' };
}

async function searchViaSearchApi({
  apiKey,
  baseUrl,
  model,
  keyword,
  oriQuestion = '',
  task = '',
  count = SEARCH_COUNT,
  timeoutMs = 30000,
  summarizeTimeoutMs = 60000,
  fetchImpl,
  logger
} = {}) {
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, text: '', searches: 0, results: 0, ms: 0, kind: 'config', message: '还没填 DeepSeek API Key' };
  const word = String(keyword || '').replace(/\s+/g, ' ').trim();
  if (!word) return { ok: false, text: '', searches: 0, results: 0, ms: 0, kind: 'config', message: '查询内容是空的' };
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, text: '', searches: 0, results: 0, ms: 0, kind: 'config', message: '这个环境没有 fetch' };
  }
  const root = String(baseUrl || '').replace(/\/+$/, '') || 'https://api.deepseek.com';
  const started = Date.now();
  const query = word.slice(0, SEARCH_QUERY_MAX);
  if (word.length > SEARCH_QUERY_MAX) {
    logger?.warn?.(`搜索词太长（${word.length} 字），截到 ${SEARCH_QUERY_MAX} 字再搜`);
  }
  const original = String(oriQuestion || '').replace(/\s+/g, ' ').trim();
  const wanted = Math.min(50, Math.max(1, Number(count) || SEARCH_COUNT));

  // ---- 1. 搜 ----
  const searched = await searchRaw({
    apiKey: key,
    baseUrl: root,
    keyword: query,
    oriQuestion: original,
    count: wanted,
    timeoutMs,
    fetchImpl: doFetch,
    logger
  });
  const searchMs = searched.ms;
  if (!searched.ok) {
    return {
      ok: false,
      text: '',
      searches: 0,
      results: 0,
      ms: searchMs,
      kind: searched.kind || 'search',
      status: searched.status,
      message: searched.message
    };
  }
  const results = searched.all;
  const picked = searched.results;
  const sources = searched.sources;

  // ---- 2. 整理 ----
  // 结果放在前面、任务（含输出格式要求）放在后面：模型最后看到的是「按这个格式写」。
  // 中间那句格式提醒不是废话：**实测**模型会把 `===知识条目===` 写成 `# 知识条目`、
  // 把 `标题：` 写成 `**标题：**`，解析就拆不出条目了（`parseDrafts` 那边也加了宽容度，双保险）。
  const formatNote =
    '【怎么输出】每条知识单独一行开头写 `===知识条目===`，然后一行「标题：」、一行「标签：」、一行「正文：」。' +
    '不要用 # 标题、不要加粗、不要在条目之外多写解释。';
  const prompt =
    `下面是刚联网搜到的 ${picked.length} 条结果，按相关度排好了。**回答只能依据这些内容**，没写的不要自己编；拿不准就说不确定。\n\n` +
    `${buildResultsBlock(picked)}\n\n${formatNote}\n\n---\n` +
    `${String(task || '').trim() || `查一下「${query}」，把它整理成 1~3 条直播时能用上的知识。`}`;
  const asked = await requestJson({
    doFetch,
    url: `${root}/chat/completions`,
    key,
    payload: {
      model: String(model || 'deepseek-flash'),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900,
      temperature: 0.3,
      // 这一步就是照抄+归纳，开思考只是多花时间（思考 token 也算输出，要付钱）
      thinking: { type: 'disabled' },
      stream: false
    },
    timeoutMs: summarizeTimeoutMs
  });
  const summarizeMs = Date.now() - started - searchMs;
  const ms = Date.now() - started;
  const usage = (asked.payload && asked.payload.usage) || {};
  const content =
    asked.ok && asked.payload && asked.payload.choices && asked.payload.choices[0] && asked.payload.choices[0].message
      ? String(asked.payload.choices[0].message.content || '').trim()
      : '';
  if (!content) {
    logger?.warn?.(
      `整理这一步没成（${asked.status ? `HTTP ${asked.status}` : (asked.error && asked.error.message) || '空回复'}），改成直接收摘要`
    );
    return {
      ok: true,
      text: buildSummaryDrafts(picked),
      searches: 1,
      results: results.length,
      ms,
      sources,
      degraded: true,
      stats: { searchMs, summarizeMs },
      message: ''
    };
  }
  return {
    ok: true,
    text: content,
    searches: 1,
    results: results.length,
    ms,
    sources,
    degraded: false,
    stats: { searchMs, summarizeMs },
    usage: {
      input: Number(usage.prompt_tokens || 0),
      output: Number(usage.completion_tokens || 0)
    }
  };
}

module.exports = {
  ResearchQueue,
  searchWithDeepSeek,
  searchViaSearchApi,
  searchRaw,
  MAX_ITEMS,
  DEDUPE_WINDOW_MS,
  SEARCH_QUERY_MAX
};
