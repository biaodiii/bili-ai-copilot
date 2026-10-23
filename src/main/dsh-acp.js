'use strict';

/**
 * ⚠️ **已下线（2026-10-19），本模块保留、不再接新活**
 *
 * 这是 DSH 的**会话模式**客户端（长驻 `dsh --profile acp` + 可续用会话）。
 * DSH 研究引擎停用后，面板入口藏了、`runResearchQuery` 钉死了 builtin，
 * 所以没有人会再调它（`ensureStarted()` 才会起进程，构造函数不起）。
 * 想恢复 / 想知道当初为什么这么写：见本文件下面的原说明 + 交接文档 §6.16。
 *
 * ---------- 以下是原说明（仍然准确）----------
 *
 * DSH 的会话客户端（走官方的 **ACP** profile）。
 *
 * 为什么不继续用 `--profile sdk`：那个协议只有
 * `initialize / session/prompt / shutdown` 三个方法，而且服务端取会话的逻辑是
 * **只会 create、不会 open**：
 *
 * ```js
 * async getOrCreateSession(sessionId) {
 *   const existing = this.sessions.get(sessionId);  // 只看进程内存
 *   if (existing) return existing;
 *   return this.createSession(sessionId);           // 磁盘上已存在 → 抛 already exists
 * }
 * ```
 *
 * 更麻烦的是它的 store 是**全库视角**（`listArtifacts()` 会遍历 `$DSH_HOME/sessions`
 * 下**所有**工作区目录），所以只要这个 id 曾经建过一次，**换个工作区也照样撞**：
 *
 * > 没跑成：任务没送出去：session "~76F4~64AD~77E5~8BC6~6574~7406" already exists
 *
 * 也就是说：固定 id 在 SDK 协议下走不通（第一次能跑，重启软件后再跑必炸）。
 *
 * 官方给外部程序准备的、**能 list / resume / close 已有会话**的接口是 ACP
 * （`dsh --profile acp`，标准 Agent Client Protocol，stdio + 换行分隔 JSON-RPC 2.0）：
 *
 * ```
 * initialize          → {protocolVersion, agentCapabilities:{sessionCapabilities:{list,resume,close}}}
 * session/new  {cwd, mcpServers}              → {sessionId}       ← id 由服务端生成
 * session/resume {sessionId, cwd, mcpServers} → {configOptions}   ← 续用已有会话
 * session/prompt {sessionId, prompt:[{type:'text',text}]} → {stopReason}
 *   ← 通知 session/update {sessionId, update:{sessionUpdate:'agent_message_chunk', …}}
 * session/cancel {sessionId}                                      ← 通知，真正的取消
 * ```
 *
 * 所以：**会话 id 由 DSH 生成、我们存进配置**，下次启动先 resume，续不上才 new。
 * `dshSessionName`（用户起的名字）作为**新会话第一句话的前缀**，这样 DSH Web 里
 * 自动生成的标题也能认出是哪个会话。
 *
 * ## 工作区 = DSH 沙箱的写入根
 *
 * `session/new` / `session/resume` 都要绝对路径 `cwd`，而它**就是沙箱根**
 * （`dsh-sandbox-policy`: `workspaceRoot = resolveWorkspaceRoot(session.header.cwd)`，
 * base 档给新会话钉的是 `workspace-write`）。我们一律传知识库目录。
 *
 * ## 它会反过来要权限（必须应答，否则一直等）
 *
 * 沙箱是 `workspace-write + ask`：想动工作区**外面**的东西时会发
 * `session/request_permission` 给客户端，等我们选 allow / reject。我们的策略是
 * **一律拒绝**（`reject-once`）——用户要的就是把它关在知识库里，
 * 而不是每次弹「要不要让它动你别的文件」。拒绝次数记进返回值的 `denied`。
 */

const os = require('os');
const { spawn } = require('child_process');

/** ACP 协议版本（`@agentclientprotocol/sdk` 的 `PROTOCOL_VERSION`，v1 就是 1） */
const ACP_PROTOCOL_VERSION = 1;
/** 没配置超时时的兜底（沿用原来的 300 秒） */
const DEFAULT_SESSION_TIMEOUT_SEC = 300;
/** 攒在内存里的助手正文上限（agent 能刷屏，不设限会吃内存） */
const MAX_REPLY_CHARS = 200000;

/**
 * 从一条 `session/update` 通知里取出助手正文片段。
 * ACP 的形状是 `{sessionUpdate:'agent_message_chunk', content:{type:'text', text}}`；
 * 「思考」是 `agent_thought_chunk`，**不算正文**（和 headless 那边同一个口径）。
 */
function extractAcpChunk(update) {
  if (!update || typeof update !== 'object') return '';
  if (update.sessionUpdate !== 'agent_message_chunk') return '';
  const content = update.content;
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (typeof content.text === 'string') return content.text;
  return '';
}

/** `session/update` 里的工具活动（用于给界面报进度，不影响正文） */
function describeAcpToolCall(update) {
  if (!update || typeof update !== 'object') return '';
  if (update.sessionUpdate !== 'tool_call') return '';
  return String(update.title || update.kind || '工具').trim();
}

/** 模型选项在 ACP 里的固定 id（`dsh-acp` 的 `MODEL_CONFIG_ID`） */
const MODEL_CONFIG_ID = 'model';

/** ACP 的模型选项 value 是 `JSON.stringify([provider, model])`，不是 "provider/model" */
function parseModelValue(value) {
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed) && parsed.length >= 2) return { provider: String(parsed[0]), model: String(parsed[1]) };
  } catch (_) {
    /* 不是 JSON 就当作没解析出来 */
  }
  return { provider: '', model: '' };
}

/** 从 configOptions 里取「模型」这一项 */
function findModelOption(configOptions) {
  return (Array.isArray(configOptions) ? configOptions : []).find((item) => item && item.id === MODEL_CONFIG_ID) || null;
}

/** 这一组 configOptions 里当前选中的模型名（解析不出来就返回空） */
function currentModelName(configOptions) {
  const option = findModelOption(configOptions);
  return option ? parseModelValue(option.currentValue).model : '';
}

/** 把 configOptions 里所有可选的模型摊平：`[{provider, model, value}]` */
function listModelChoices(configOptions) {
  const option = findModelOption(configOptions);
  const out = [];
  for (const group of (option && option.options) || []) {
    for (const entry of (group && group.options) || []) {
      const parsed = parseModelValue(entry && entry.value);
      out.push({ provider: parsed.provider || String(group.group || ''), model: parsed.model, value: String(entry.value), name: String(entry.name || '') });
    }
  }
  return out;
}

/**
 * 把用户配的模型名（`deepseek-flash` / `deepseek-official/deepseek-flash` / 完整 value）
 * 解析成目录里**那一个** value 字符串；找不到就返回空（调用方只警告、不打断任务）。
 */
function resolveModelValue(configOptions, wanted) {
  const text = String(wanted || '').trim();
  if (!text) return '';
  const choices = listModelChoices(configOptions);
  if (!choices.length) return '';
  if (text.startsWith('[')) {
    const exact = choices.find((choice) => choice.value === text);
    return exact ? exact.value : '';
  }
  const [maybeProvider, maybeModel] = text.includes('/') ? text.split('/') : ['', text];
  const model = (maybeModel || text).trim();
  const hit =
    choices.find((choice) => choice.model === model && (!maybeProvider || choice.provider === maybeProvider.trim())) ||
    choices.find((choice) => choice.model === model);
  return hit ? hit.value : '';
}

class DshSessionRunner {
  /**
   * @param {object} options
   *   getConfig()  `{sessionName, sessionId, timeoutSec, apiKey, cwd}`（跟着设置走，改完立刻生效）
   *   logger
   *   spawnImpl    可注入（测试用假 spawn；沙箱里不允许真的创建子进程）
   *   env          子进程环境（会注入 DEEPSEEK_API_KEY）
   *   resolve()    复用 DshRunner 的探测结果（node 命令 + bin.js 路径）
   *   onSession(id) 会话 id 变化回调：新建/续用成功给 id，忘掉旧会话给空字符串
   */
  constructor({ getConfig, logger, spawnImpl, env = process.env, resolve, onSession } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.logger = logger || console;
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    this.env = env;
    this.resolve = typeof resolve === 'function' ? resolve : async () => ({ ok: false, checks: [] });
    this.onSession = typeof onSession === 'function' ? onSession : () => {};
    this.child = null;
    this.buffer = '';
    this.pending = new Map();
    this.seq = 0;
    /** {nodeCommand, binPath, version, sessionId, workspace, server} */
    this.info = null;
    this.startedAt = 0;
    /** 正在跑的任务（{startedAt, sessionId}）——退出时据此提醒「会打断工具调用」 */
    this.currentRun = null;
    this.listeners = new Set();
    /** 本次跑被我们拒掉的越界操作次数 */
    this.deniedCount = 0;
  }

  _config() {
    const raw = this.getConfig() || {};
    return {
      sessionName: String(raw.sessionName || '').trim() || '直播知识整理',
      sessionId: String(raw.sessionId || '').trim(),
      /** 想让 DSH 用哪个模型（空 = 不指定，用 DSH 自己的默认 / 会话记着的那个） */
      model: String(raw.model || '').trim(),
      timeoutSec: Number(raw.timeoutSec) > 0 ? Number(raw.timeoutSec) : DEFAULT_SESSION_TIMEOUT_SEC,
      apiKey: String(raw.apiKey || '').trim(),
      cwd: String(raw.cwd || '').trim()
    };
  }

  /** 这次会话实际在用的模型（跑过一次才有；跑之前报配置里想要的那个） */
  get model() {
    return (this.info && this.info.model) || this._config().model || '';
  }

  /**
   * 这次会话的 id。三种情况：
   *   · 进程里已经建好/续好 → 用它（真值来源）
   *   · 还没起进程，但配置里存着上次的 → 先用它显示（一会儿 resume 会验证）
   *   · 都没有（第一次用）→ 空字符串，界面显示「还没建」
   */
  get sessionId() {
    return (this.info && this.info.sessionId) || this._config().sessionId || '';
  }

  /**
   * 这次会话的工作区（= 知识库目录）。
   * DSH 的沙箱根就是它，所以这里报出来的目录就是「DSH 被关在哪个文件夹里」的答案。
   */
  get workspace() {
    return (this.info && this.info.workspace) || this._config().cwd || os.tmpdir();
  }

  get running() {
    return Boolean(this.child);
  }

  /** 当前有没有任务在跑（决定退出时要不要提醒「会打断工具调用」） */
  get busy() {
    return Boolean(this.currentRun);
  }

  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (_) {
        /* ignore */
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _write(message) {
    if (!this.child || !this.child.stdin) throw new Error('DSH 会话进程不在');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs) {
    const id = `req_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超过 ${Math.round(timeoutMs / 1000)} 秒没回应`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** 通知：没有 id，也不需要回应（`session/cancel` 就是通知） */
  notify(method, params) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  /**
   * 处理一行输入：响应 / 服务端发来的请求 / 通知。
   *
   * ⚠️ 服务端发来的**请求必须回**（`session/request_permission` 就是这类），
   * 不回它就一直等在那儿，整轮任务看着像卡死。
   */
  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      return; // 非协议行（启动日志之类），忽略
    }
    if (!message || typeof message !== 'object') return;

    if (message.id !== undefined && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'DSH 返回错误'));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === 'string') {
      this._answerRequest(message);
      return;
    }
    if (typeof message.method === 'string') {
      this._emit({ method: message.method, params: message.params || {} });
      return;
    }
    // 响应但没人等（超时后被丢弃）→ 忽略
  }

  /**
   * 回服务端的请求。
   *   · `session/request_permission`：**一律拒绝**（用户要的是「关在知识库里」，
   *     不是每次弹窗问要不要放它出去）；
   *   · 其它未知方法：回 -32601，让它别等（宁可它报错，也不要卡住）。
   */
  _answerRequest(message) {
    const method = message.method;
    const reply = (payload) => {
      try {
        this._write({ jsonrpc: '2.0', id: message.id, ...payload });
      } catch (_) {
        /* 进程没了就算了 */
      }
    };
    if (method === 'session/request_permission') {
      this.deniedCount += 1;
      const options = ((message.params || {}).options || []).map((item) => String(item && item.optionId || ''));
      const reject = options.find((id) => /reject/i.test(id)) || 'reject-once';
      this.logger.warn?.(`DSH 想动知识库外面的东西，已拒绝（${reject}）`);
      reply({ result: { outcome: { outcome: 'selected', optionId: reject } } });
      return;
    }
    this.logger.warn?.(`DSH 发来一个我们没实现的请求：${method}（已回「不支持」）`);
    reply({ error: { code: -32601, message: `客户端不支持 ${method}` } });
  }

  _consume(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';
    for (const line of lines) if (line.trim()) this._handleLine(line.trim());
  }

  _fail(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  /** 起进程 + initialize + 拿到会话（已经起来就直接复用） */
  async ensureStarted() {
    // 进程活着、会话也建好了 → 直接用（长驻的意义就在这儿）
    if (this.child && this.info && this.info.sessionId) return this.info;
    // 进程活着但上次没建成会话（session/new 超时之类）→ 复用进程补一次，
    // 不然会拿着空 sessionId 去发任务，报出来的错莫名其妙
    if (this.child && this.info) {
      await this.ensureSession();
      return this.info;
    }
    const status = await this.resolve();
    if (!status || !status.ok) {
      const missing = ((status && status.checks) || []).filter((item) => !item.ok).map((item) => item.label);
      throw new Error(`环境没配好（缺：${missing.join('、') || '未知'}），先点「检测环境」`);
    }
    const config = this._config();
    const nodeCommand = (status.node && status.node.command) || 'node';
    const binPath = status.dsh && status.dsh.binPath;
    if (!binPath) throw new Error('没找到 DSH 的 lib/bin.js');
    const env = { ...this.env };
    if (config.apiKey) env.DEEPSEEK_API_KEY = config.apiKey;
    const workspace = config.cwd || os.tmpdir();

    const child = this.spawnImpl(nodeCommand, [binPath, '--profile', 'acp'], {
      // 进程 cwd 和会话的 cwd 用同一个目录：DSH 拿它当工作区 / 沙箱根，
      // 两边不一致会让「工作区到底在哪」说不清
      cwd: workspace,
      env,
      windowsHide: true
    });
    this.child = child;
    this.buffer = '';
    this.startedAt = Date.now();
    this.info = { nodeCommand, binPath, version: (status.dsh && status.dsh.version) || '', sessionId: '', workspace, server: null };

    if (child.stdout) child.stdout.on('data', (chunk) => this._consume(String(chunk)));
    if (child.stderr) child.stderr.on('data', (chunk) => this.logger.debug?.(`[dsh-acp] ${String(chunk).trim()}`));
    child.on('error', (error) => this._fail(new Error(`启动 DSH 会话失败：${(error && error.message) || error}`)));
    child.on('close', (code) => {
      const wasRunning = Boolean(this.child);
      this.child = null;
      this.info = null;
      this._fail(new Error(`DSH 会话进程退出了（code ${code}）`));
      if (wasRunning) this.logger.warn?.(`DSH 会话进程退出：code ${code}`);
    });

    const init = await this.request(
      'initialize',
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        // 我们不当文件系统代理：DSH 自带文件工具，不需要通过客户端读写
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
      },
      60000
    );
    this.info.server = init && init.agentInfo ? init.agentInfo : null;
    const capabilities = (init && init.agentCapabilities) || {};
    if (!capabilities.sessionCapabilities || !capabilities.sessionCapabilities.resume) {
      this.logger.warn?.('这个 DSH 的 ACP 不支持 resume：每次都会新开一个会话');
    }
    await this.ensureSession();
    this.logger.info?.(
      `DSH 会话已就绪：${this.info.server ? `${this.info.server.name} ${this.info.server.version}` : 'acp'}，` +
        `会话 id = ${this.info.sessionId || '(新建失败)'}，工作区 ${workspace}`
    );
    return this.info;
  }

  /**
   * 拿到一个能用的会话：先试**续用**上次那个，不行再新建。
   * 新建成功后把 id 交回主进程存进配置（下次就能续）。
   */
  async ensureSession() {
    if (this.info && this.info.sessionId) return this.info.sessionId;
    const config = this._config();
    const cwd = config.cwd || os.tmpdir();

    if (config.sessionId) {
      try {
        const resumed = await this.request('session/resume', { sessionId: config.sessionId, cwd, mcpServers: [] }, 120000);
        this.info.sessionId = config.sessionId;
        this.logger.info?.(`续用已有会话：${config.sessionId}`);
        await this.applyModelPreference(config.sessionId, resumed && resumed.configOptions);
        return this.info.sessionId;
      } catch (error) {
        // 续不上很常见（会话被删了 / 软件目录搬了）——不打扰用户，直接新建
        this.logger.warn?.(`续用会话失败（${error.message}），改开一个新会话`);
        this.onSession('');
      }
    }

    const created = await this.request('session/new', { cwd, mcpServers: [] }, 120000);
    const sessionId = String((created && created.sessionId) || '').trim();
    if (!sessionId) throw new Error('DSH 没给回会话 id');
    this.info.sessionId = sessionId;
    // 新会话：下一句话前面加个【名字】，DSH 会用第一句话自动生成会话标题，
    // 这样主播在 DSH Web 的列表里能一眼认出是哪个会话（名字是我们给的，id 是它生成的）
    this.info.fresh = true;
    this.onSession(sessionId);
    await this.applyModelPreference(sessionId, created && created.configOptions);
    return sessionId;
  }

  /**
   * 把会话的模型钉到配置里指定的那个（`knowledge.dshModel`，默认 4.1 Flash）。
   *
   * 为什么走 ACP 的 `session/set_config_option` 而不是改 DSH 的配置文件：
   *   · 这是协议给客户端的能力，不用去动用户的 `~/.dsh`（软件的原则是「不碰用户的环境」）；
   *   · `acp` 档默认是 `deepseek-v4-flash`、headless 档吃 `settings.yaml` 的 v4-pro，
   *     两条路不一致；会话模式由我们明确指定，行为才可预测。
   *
   * ⚠️ 两个细节都是踩过才知道的：
   *   · value 不是 `"provider/model"`，而是 `JSON.stringify([provider, model])`；
   *   · **钉不住也不能让任务失败**——只在日志里说明，这一轮照跑（用的就是会话原本的模型）。
   *
   * @returns {Promise<string>} 钉好之后的模型名（没钉/失败返回空）
   */
  async applyModelPreference(sessionId, configOptions) {
    try {
      return await this._applyModelPreference(sessionId, configOptions);
    } catch (error) {
      // 指定模型失败**不能影响这一轮任务**：DSH 那头可能不认这个模型名 / 请求超时，
      // 那就用它原本的模型继续干，只把原因写进日志
      this.logger.warn?.(`指定模型失败（${error.message}），这次用会话自己的默认模型`);
      this.info.model = currentModelName(configOptions);
      return '';
    }
  }

  /** 真正干活的实现（异常由上面那层兜住） */
  async _applyModelPreference(sessionId, configOptions) {
    const wanted = this._config().model;
    if (!wanted) {
      // 留空 = 不指定：用 DSH 自己的默认（会话记住的路由）
      this.info.model = currentModelName(configOptions);
      if (this.info.model) this.logger.info?.(`DSH 用会话自己的模型：${this.info.model}`);
      return '';
    }
    const value = resolveModelValue(configOptions, wanted);
    if (!value) {
      this.logger.warn?.(`DSH 的模型清单里没有「${wanted}」，这次用会话自己的默认模型`);
      this.info.model = currentModelName(configOptions);
      return '';
    }
    const current = currentModelName(configOptions);
    if (current && parseModelValue(value).model === current) {
      this.info.model = current;
      this.logger.info?.(`DSH 模型：${current}（已经是配置里指定的那个）`);
      return current;
    }
    const result = await this.request('session/set_config_option', { sessionId, configId: MODEL_CONFIG_ID, value }, 60000);
    const applied = currentModelName(result && result.configOptions) || parseModelValue(value).model;
    this.info.model = applied;
    this.logger.info?.(`DSH 模型已指定为 ${applied}（原 ${current || '未知'}）`);
    return applied;
  }

  /** 忘掉当前会话（下次 prompt 会新建一个）；主进程那边也会清掉存的 id */
  resetSession() {
    this.info = this.info ? { ...this.info, sessionId: '' } : this.info;
    this.onSession('');
    return true;
  }

  /**
   * 往会话里发一条任务，等它干完，返回助手最后说的话。
   * @returns {Promise<{ok:boolean, output:string, ms:number, sessionId:string, message?:string, events:number, denied:number}>}
   */
  async prompt(text, { timeoutMs, onOutput } = {}) {
    const config = this._config();
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : config.timeoutSec * 1000;
    const started = Date.now();
    const body = String(text || '').trim();
    this.deniedCount = 0;
    if (!body) return { ok: false, output: '', ms: 0, sessionId: this.sessionId, message: '任务内容是空的', denied: 0 };

    let info;
    try {
      info = await this.ensureStarted();
    } catch (error) {
      return { ok: false, output: '', ms: 0, sessionId: this.sessionId, message: error.message, denied: 0 };
    }

    let output = '';
    let events = 0;
    let finished = false;
    let settle = () => {};
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const listener = (event) => {
      if (event.method !== 'session/update') return;
      const params = event.params || {};
      const sessionId = String(params.sessionId || '');
      // 同一个进程里可能有别的会话（子代理）→ 只认自己这条
      if (sessionId && info.sessionId && sessionId !== info.sessionId) return;
      events += 1;
      const update = params.update || {};
      const chunk = extractAcpChunk(update);
      if (chunk) {
        output = (output + chunk).slice(0, MAX_REPLY_CHARS);
        if (typeof onOutput === 'function') onOutput({ text: chunk });
        return;
      }
      const tool = describeAcpToolCall(update);
      if (tool) this._emit({ method: 'session/tool', params: { title: tool } });
    };
    const finish = (payload) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      this.listeners.delete(listener);
      this.currentRun = null;
      settle(payload);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          message:
            `超过 ${Math.round(limit / 1000)} 秒还没跑完。**它没有被杀掉**，还在会话里继续跑 —— ` +
            `去 DSH Web 打开这个会话就能看进度，跑完的内容也可以直接复制过来。`
        }),
      limit
    );
    this.listeners.add(listener);
    this.currentRun = { startedAt: Date.now(), sessionId: info.sessionId };

    // ⚠️ 一条链路上只能有**一个**时间上限（这条踩过坑：请求自己的超时压过用户设置，
    // 界面 1 秒就报超时、内部却还在干等 60 秒）。真正收尾的是上面的 timer，
    // 这里的超时只是兜底。
    // 新会话的第一句话带个名字前缀：DSH 拿第一句话生成会话标题，Web 里好认
    const firstBody = info.fresh ? `【${config.sessionName}】\n${body}` : body;
    if (info.fresh) info.fresh = false;
    this.request(
      'session/prompt',
      { sessionId: info.sessionId, prompt: [{ type: 'text', text: firstBody }] },
      limit * 2 + 5000
    )
      .then((result) => {
        const stopReason = String((result && result.stopReason) || '');
        if (stopReason === 'cancelled') finish({ ok: false, message: '这一轮被中止了（会话留着，可以直接再发一条）' });
        else finish({ ok: true, stopReason });
      })
      .catch((error) => finish({ ok: false, message: `任务没送出去：${error.message}` }));

    const settled = await done;
    const ms = Date.now() - started;
    const sessionId = info.sessionId;
    if (!settled.ok) return { ok: false, output, ms, sessionId, events, message: settled.message || 'DSH 没给出结果', denied: this.deniedCount };
    if (!output) {
      return { ok: false, output: '', ms, sessionId, events, message: 'DSH 跑完了但没抓到正文（去 Web 里看那个会话）', denied: this.deniedCount };
    }
    return { ok: true, output, ms, sessionId, events, denied: this.deniedCount };
  }

  /**
   * 中止当前这一轮：发 `session/cancel` 通知（ACP 里是真的取消，不用杀进程）。
   * 这一轮会以 `stopReason: 'cancelled'` 收尾。
   */
  cancel() {
    const sessionId = this.sessionId;
    if (!this.child || !sessionId) return false;
    try {
      this.notify('session/cancel', { sessionId });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 停掉会话进程。
   *
   * ACP 没有 shutdown 方法，优雅收尾的办法是**关掉 stdin**：
   * SDK/ACP profile 都把 stdin EOF 绑到「收尾后退出」，所以先 EOF、等一小会儿，
   * 再动手杀。这样会话日志是写干净的，不会留下「工具调用有记录、结果没落盘」。
   *
   * @param {{graceful?:boolean, timeoutMs?:number}} options
   */
  async stop({ graceful = true, timeoutMs = 3000 } = {}) {
    if (!this.child) return false;
    const child = this.child;
    if (graceful) {
      try {
        if (child.stdin && !child.stdin.destroyed) child.stdin.end();
        await new Promise((resolve) => setTimeout(resolve, Math.min(800, timeoutMs)));
      } catch (_) {
        /* 关不掉也没关系，下面照样杀 */
      }
    }
    if (this.child !== child) return true; // 期间已经自己退出了
    this.child = null;
    this.info = null;
    try {
      child.kill();
    } catch (_) {
      return false;
    }
    this._fail(new Error('会话已被中止'));
    return true;
  }
}

module.exports = {
  DshSessionRunner,
  extractAcpChunk,
  describeAcpToolCall,
  parseModelValue,
  resolveModelValue,
  currentModelName,
  listModelChoices,
  ACP_PROTOCOL_VERSION,
  MODEL_CONFIG_ID,
  DEFAULT_SESSION_TIMEOUT_SEC,
  MAX_REPLY_CHARS
};
