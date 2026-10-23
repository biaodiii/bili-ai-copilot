'use strict';

/**
 * DeepSeek 客户端（OpenAI 兼容的 chat/completions）
 */

// 状态表只有一份，放在 src/shared/emotions.js，界面和主进程共用。
// 以前这里另抄了一份 8 个状态的副本，加了新状态就会对不上（AI 写了也会被判无效丢掉）。
const sharedEmotions = require('../shared/emotions.js');

class DeepSeekError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.code = code;
    this.status = status;
  }
}

function normalizeBaseUrl(baseUrl) {
  const text = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(text)) return `https://${text}`;
  return text;
}

function friendlyError(status, bodyText) {
  let detail = bodyText;
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && parsed.error && parsed.error.message) detail = parsed.error.message;
  } catch (_) {
    /* ignore */
  }
  switch (status) {
    case 401:
      return 'API Key 无效或已过期（401），请到 platform.deepseek.com 重新复制';
    case 402:
      return '账户余额不足（402），请先充值';
    case 429:
      return '请求太频繁或额度用尽（429），请稍后再试或调大发送间隔';
    case 400:
      return `请求被拒绝（400）：${detail || '参数有误'}`;
    case 500:
    case 502:
    case 503:
      return `DeepSeek 服务暂时不可用（${status}），稍后会自动重试`;
    default:
      return `请求失败（HTTP ${status}）：${detail || '未知错误'}`;
  }
}

/**
 * 她能调用的软件功能（P7，最高权限下才生效）。
 *
 * 这张表是**唯一**的动作名清单：模型在回复里写 `[做:动作名]`，认不出来的一律不生效
 * （当普通方括号文本留在正文里，观众能看见）。加新功能必须同时改这里和 main.js 的分发，
 * `audit.js` 会核对两边对得上。
 */
const TOOL_ALIASES = {
  暂停: 'pause',
  停一下: 'pause',
  暂停回复: 'pause',
  pause: 'pause',
  恢复: 'resume',
  恢复回复: 'resume',
  resume: 'resume',
  静音: 'mute',
  mute: 'mute',
  取消静音: 'unmute',
  解除静音: 'unmute',
  unmute: 'unmute',
  开个话题: 'warmup',
  暖场: 'warmup',
  主动说话: 'warmup',
  warmup: 'warmup',
  清空对话: 'clear',
  清空记忆: 'clear',
  clear: 'clear',
  导出记录: 'export',
  导出对话: 'export',
  export: 'export'
};

class DeepSeekClient {
  /** 一条回复里最多认几条「想查/想记」（多了丢掉，防止模型刷屏式提需求） */
  static MAX_RESEARCH_MARKS = 3;
  /** 单条「想查/想记」正文的长度上限 */
  static MAX_RESEARCH_CHARS = 80;
  /**
   * 一条回复里最多认几条「改库」标记（改一下 / 扩写）。
   *
   * 为什么单独卡到 1：这两种标记会**真的动知识库**（改错一条会污染之后几十场直播）。
   * 就算主播把权限开成「直接改」，一次回复只让她动一条也够用了。
   */
  static MAX_EDIT_MARKS = 1;
  /**
   * 一条回复里最多认几个「工具调用」（P7）。
   *
   * 单独卡到 1：工具调用会**真的改软件状态**（暂停回复、静音…）。一次回复动一下已经够用，
   * 多出来的整条丢掉——不降级、不排队，免得她一口气把好几个开关都拨一遍。
   */
  static MAX_TOOL_CALLS = 1;
  /** 一条回复里最多认几条「改设定」（同上：一次改一处就够） */
  static MAX_SETTINGS_EDITS = 1;
  /** 改设定时正文的长度上限（人设可能是一整段，比别的标记长得多） */
  static MAX_SETTINGS_CHARS = 4000;

  constructor(getConfig, logger) {
    this.getConfig = getConfig;
    this.logger = logger || console;
  }

  _config() {
    const config = this.getConfig() || {};
    const apiKey = String(config.apiKey || '').trim();
    if (!apiKey) throw new DeepSeekError('还没有填写 DeepSeek API Key（设置 → DeepSeek API）');
    return {
      apiKey,
      baseUrl: normalizeBaseUrl(config.baseUrl),
      model: String(config.model || 'deepseek-flash').trim() || 'deepseek-flash',
      // 思考档位：off / low / high / max（DeepSeek 官方文档的 reasoning_effort）。
      // 注意这些值必须能从运行期配置里改，所以这里用 ?? 而不是 ||：
      // 以后如果加一个 '' 表示「跟随服务端默认」，用 || 会把它吃掉。
      thinking: ['off', 'low', 'high', 'max'].includes(config.thinking) ? config.thinking : 'low',
      temperature: Number.isFinite(config.temperature) ? config.temperature : 1.1,
      // 0 = 不限制（请求里不发 max_tokens）
      maxTokens: Number.isFinite(config.maxTokens) ? config.maxTokens : 0,
      timeoutSec: Number.isFinite(config.timeoutSec) ? config.timeoutSec : 45,
      // 默认关闭 JSON 输出模式：实测「json_object + 中文长系统提示词」这个组合下
      // DeepSeek 会返回纯空格（finish_reason 仍是 stop），8 次里空 7~8 次。
      // 情绪改用句末 `[情绪:xxx]` 标记表达，稳定性实测 8/8。
      useJsonFormat: config.useJsonFormat === true
    };
  }

  /**
   * @param {Array<{role:string,content:string}>} messages
   * @param {{signal?:AbortSignal, jsonMode?:boolean, maxTokens?:number, temperature?:number,
   *   thinking?:string, timeoutMs?:number}} options
   *   `timeoutMs` 只给"慢活"用（知识库整理/校对是 `max` 档思考，45 秒不够）；不传就用配置值。
   */
  async chat(messages, options = {}) {
    const config = this._config();
    const thinking = options.thinking ?? config.thinking;
    const body = {
      model: config.model,
      messages,
      temperature: options.temperature ?? config.temperature,
      stream: false
    };
    // max_tokens：0（或没给）表示**不限制**——干脆不发这个字段，用服务端默认上限。
    // 为什么不发而不是发个大数：发了就成了一道人为的墙，而思考内容也吃这个额度，
    // 墙一矮就会出现「思考把额度吃光、正文是空的」。正文本身由提示词约束在 40 字内。
    const maxTokens = options.maxTokens ?? config.maxTokens;
    if (Number.isFinite(maxTokens) && maxTokens > 0) body.max_tokens = maxTokens;
    // 思考档位：off 走官方的「关闭思考模式」，其余三档用 reasoning_effort。
    // 关掉时**不能**同时传 temperature 之外的东西，官方没有这个组合，所以二选一。
    if (thinking === 'off') body.thinking = { type: 'disabled' };
    else body.reasoning_effort = thinking;
    const wantJson = options.jsonMode ?? config.useJsonFormat;
    if (wantJson) body.response_format = { type: 'json_object' };

    const controller = new AbortController();
    // 超时：默认用配置里的「超时秒数」（普通回复用 45 秒够了）。
    // 但**开思考模式的慢活**（知识库整理/校对）必须能放宽：一次整理 20 条、`max` 档思考
    // 实测要 60 秒以上，按 45 秒卡就永远超时（2026-10-21 真踩过）。
    // 所以这里允许调用方传 `timeoutMs` 单独指定，不动全局配置。
    const callTimeoutMs =
      Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : config.timeoutSec * 1000;
    const timeout = setTimeout(() => controller.abort(), callTimeoutMs);
    const onAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
    }

    const startedAt = Date.now();
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) {
        throw new DeepSeekError(friendlyError(response.status, text), { status: response.status });
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        throw new DeepSeekError('返回内容不是合法 JSON，接口地址可能填错了');
      }
      const choice = (parsed.choices || [])[0] || {};
      const message = choice.message || {};
      const content = String(message.content || '').trim();
      // 有些模型/模式会返回空 content（推理内容却占满了 token），
      // 这里把它标出来交给上层决定是否重试，而不是直接当失败。
      const reasoning = String(message.reasoning_content || '').trim();
      if (!content) {
        return {
          content: '',
          empty: true,
          reasoning,
          finishReason: choice.finish_reason || '',
          usage: parsed.usage || null,
          latencyMs: Date.now() - startedAt,
          model: parsed.model || config.model
        };
      }
      return {
        content,
        empty: false,
        reasoning,
        finishReason: choice.finish_reason || '',
        usage: parsed.usage || null,
        latencyMs: Date.now() - startedAt,
        model: parsed.model || config.model
      };
    } catch (error) {
      if (error instanceof DeepSeekError) throw error;
      if (error.name === 'AbortError') {
        if (options.signal && options.signal.aborted) {
          throw new DeepSeekError('已取消（被新的请求打断）');
        }
        const seconds = callTimeoutMs / 1000;
        const label = seconds >= 1 ? `${Math.round(seconds)} 秒` : `${Math.round(callTimeoutMs)} 毫秒`;
        throw new DeepSeekError(`请求超时（超过 ${label}），检查网络或调大超时时间`);
      }
      throw new DeepSeekError(`网络错误: ${error.message}`);
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 带「空回复自动重试」的调用。
   *
   * 为什么需要：开启了 JSON 输出模式时，模型偶尔会返回空 content，
   * 这时直接当失败会让主播觉得「AI 不说话了」。实际只要再试一次就好，
   * 而且重试时关掉 JSON 模式（纯文本回复更容易成功），并把 token 上限放大一倍多，
   * 避免推理内容把额度占满导致正文为空。
   */
  async chatWithRetry(messages, options = {}) {
    const attempts = [];

    // 指定了「催问语」时直接走补救路径：用于「上一条回复崩了需重答」这类场景，
    // 不需要再白白跑一次正常调用。
    if (options.nudge) {
      const nudged = messages.concat([{ role: 'user', content: String(options.nudge) }]);
      const result = await this.chat(nudged, { ...options, nudge: undefined, jsonMode: false });
      attempts.push({ nudge: true, empty: Boolean(result.empty), finishReason: result.finishReason });
      if (!result.empty) return { ...result, attempts };
      const error = new DeepSeekError('模型在催问后仍然返回空内容');
      error.attempts = attempts;
      throw error;
    }

    // 第 1 次：按用户设置来
    let result = await this.chat(messages, options);
    attempts.push({ jsonMode: options.jsonMode, empty: Boolean(result.empty), finishReason: result.finishReason });
    if (!result.empty) return { ...result, attempts };

    // 第 2 次：关掉 JSON 模式 + 放大 token 上限
    const config = this._config();
    const baseTokens = Number(options.maxTokens) || Number(config.maxTokens) || 0;
    // 重试要把额度**真的放大**：以前是 Math.max(baseTokens, 400)，等于设置值超过 400 时
    // 一点没加。开了思考之后空回复的典型原因就是「思考把额度吃光了」（finish_reason=length），
    // 不加额度而只是重发，只会再撞一次同一堵墙。
    // baseTokens 为 0 表示用户选了「不限制」：那第一次就没有额度墙，重试保持不限制即可。
    const biggerTokens = baseTokens > 0 ? Math.min(393216, Math.max(Math.round(baseTokens * 2), 1200)) : 0;
    try {
      result = await this.chat(messages, { ...options, jsonMode: false, maxTokens: biggerTokens });
      attempts.push({ jsonMode: false, empty: Boolean(result.empty), finishReason: result.finishReason });
      if (!result.empty) return { ...result, attempts };
    } catch (error) {
      attempts.push({ jsonMode: false, error: error.message });
    }

    // 第 3 次：直接催它一句话，别再要 JSON 了
    try {
      const nudge = messages.concat([
        { role: 'user', content: '请直接用一句中文口语回答上面的弹幕，不要输出 JSON，不要空着。' }
      ]);
      result = await this.chat(nudge, { ...options, jsonMode: false, maxTokens: biggerTokens });
      attempts.push({ jsonMode: false, nudge: true, empty: Boolean(result.empty) });
      if (!result.empty) return { ...result, attempts };
    } catch (error) {
      attempts.push({ nudge: true, error: error.message });
    }

    const error = new DeepSeekError('模型连续返回空内容（已自动重试 3 次）');
    error.attempts = attempts;
    throw error;
  }

  /**
   * 把模型返回的文本解析成 {text, emotion, selfNote}。
   *
   * 支持三种形态，按优先级：
   *   1. 句末情绪标记：`抽卡嘛，非久必欧～[情绪:happy]`（当前默认，见 parseTaggedReply）
   *   2. JSON 对象：`{"reply":"...","emotion":"happy"}`（开启 JSON 输出模式时）
   *   3. 纯文本：整段当正文，情绪 idle
   *
   * 为什么要支持纯文本：实测 DeepSeek 在「response_format=json_object + 这套中文长
   * 系统提示词」的组合下会返回纯空格（completion_tokens 十几个、finish_reason 却是
   * stop），8 次里能空 7~8 次。所以默认不再强制 JSON，改用句末标记表达情绪。
   */
  static parseReply(content, options = {}) {
    const raw = String(content || '').trim();
    if (!raw) {
      return { text: '', emotion: 'idle', emotions: [], selfNote: '', triggerRules: [], research: [], viewerLookups: [] };
    }

    // 情绪标记 / 触发词规则 / 自我备注都在这一步拆开。
    // 有标记时以它为准；一个标记都没有（比如「记下了 规则: 开心=草」）也照样走这条，
    // 只要解析结果里真的有东西（正文非空，或者拿到了规则）。
    const structured = DeepSeekClient.parseEmotionScript(raw, options);
    const hasRule = structured.triggerRules.length > 0;
    if (structured.emotions.length || hasRule) return structured;

    let candidate = raw;
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) candidate = fence[1].trim();
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        const text = String(parsed.reply ?? parsed.text ?? parsed.content ?? '').trim();
        const emotion = String(parsed.emotion ?? parsed.mood ?? '').trim().toLowerCase();
        // 可选的“自我风格备注”：只在模型主动给出时才有值
        const selfNote = String(parsed.self_note ?? parsed.selfNote ?? parsed.note ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 120);
        if (text) {
          const key = normaliseEmotion(emotion, options.custom);
          const agent = DeepSeekClient.extractAgentMarks(text);
          const cleaned = DeepSeekClient.extractResearchMarks(agent.text);
          const lookup = DeepSeekClient.extractViewerLookups(cleaned.text);
          return {
            text: lookup.text,
            emotion: key,
            emotions: [{ key, at: 0 }],
            selfNote,
            triggerRules: [],
            research: cleaned.marks,
            tools: agent.calls,
            settingsEdits: agent.settingsEdits,
            viewerLookups: lookup.lookups
          };
        }
      } catch (_) {
        /* fallthrough */
      }
    }
    // 纯文本：也要摘「想查/想记/工具/改设定/查观众」标记（模型可能不加情绪标记）
    const agent = DeepSeekClient.extractAgentMarks(raw);
    const plain = DeepSeekClient.extractResearchMarks(agent.text);
    const lookup = DeepSeekClient.extractViewerLookups(plain.text);
    return {
      text: lookup.text,
      emotion: 'idle',
      emotions: [],
      selfNote: '',
      triggerRules: [],
      research: plain.marks,
      tools: agent.calls,
      settingsEdits: agent.settingsEdits,
      viewerLookups: lookup.lookups
    };
  }

  /**
   * 解析句末情绪标记，返回 null 表示这条回复里没有标记。
   *
   * 先做「有标记」的形状检查再匹配：正文里正常出现方括号（比如观众发的 `[doge]`）
   * 时不会被误判，情绪也不会被莫名其妙改成 idle。
   */
  static parseTaggedReply(raw, options = {}) {
    const script = DeepSeekClient.parseEmotionScript(raw, options);
    if (!script || !script.emotions.length) return null;
    return script;
  }

  /**
   * 把一条模型输出拆成「正文 + 情绪序列 + 自我备注 + 触发词规则」。
   *
   * 情绪标记不是必需的：主播让它记触发词时，它可能只回一句「记下了」加一条规则，
   * 一个 `[情绪:xxx]` 都没有——那种情况同样要能解析出正文和规则。
   *
   * 返回：`{ text, emotion, emotions: [{ key, at }], selfNote, triggerRules }`
   *   - `at` 是标记在**去掉标记后的正文**里的字符位置，只用来排序，界面上不做精确对时
   *   - `emotion` 保留成「最后一个标记」（没有标记时 `idle`）：老代码/老测试只认这个字段
   */
  static parseEmotionScript(raw, options = {}) {
    const original = String(raw || '');
    // 先把「工具调用 / 改设定」摘掉（P7），再把「想查 / 想记 / 改一下 / 扩写」摘掉（P4/P6），
    // 最后才走原来的情绪/规则/备注逻辑 —— 位置计算不会被这些标记干扰
    const agent = DeepSeekClient.extractAgentMarks(original);
    const { text: withoutResearch, marks: research } = DeepSeekClient.extractResearchMarks(agent.text);
    // 「查观众」也在算位置之前摘掉（否则方括号文本会被当成正文，还可能干扰情绪标记的偏移）
    const { text: source, lookups: viewerLookups } = DeepSeekClient.extractViewerLookups(withoutResearch);
    const pattern = /[[【]\s*(?:情绪|emotion)\s*[:：]\s*([^\]】]{1,20}?)\s*[\]】]/gi;
    const marks = [];
    if (/[[【]\s*(?:情绪|emotion)\s*[:：]/i.test(source)) {
      let match = pattern.exec(source);
      while (match) {
        marks.push({ raw: match[1], start: match.index, end: match.index + match[0].length });
        match = pattern.exec(source);
      }
    }

    // 触发词规则先处理：「备注:」的匹配是贪婪到行尾的，先摘规则就不会被它吞掉
    const ruleHit = DeepSeekClient.findTriggerRules(source, options);
    const triggerRules = ruleHit ? ruleHit.rules : [];
    // 正文到哪儿为止：规则的位置、最后一个情绪标记、或者整条
    const last = marks.length ? marks[marks.length - 1] : null;
    let bodyEnd = ruleHit ? ruleHit.start : source.length;
    if (last && last.end > bodyEnd) bodyEnd = last.end;

    // 「备注:xxx」只认正文末尾那一句（不超过规则的起点）
    const tail = source.slice(last ? last.end : 0, Math.max(last ? last.end : 0, bodyEnd));
    const noteMatch = tail.match(/备注\s*[:：]\s*(.+)$/);
    const selfNote = noteMatch ? noteMatch[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (noteMatch && last) bodyEnd = last.end + noteMatch.index;

    // 去掉所有标记（和备注、规则），把剩下的正文拼起来；位置按「已消耗的正文长度」累计
    const pieces = [];
    let cursor = 0;
    let textLength = 0;
    const emotions = [];
    for (const mark of marks) {
      const chunk = source.slice(cursor, mark.start);
      pieces.push(chunk);
      textLength += chunk.length;
      emotions.push({ key: normaliseEmotion(mark.raw, options.custom), at: textLength });
      cursor = mark.end;
    }
    pieces.push(source.slice(cursor, Math.max(cursor, bodyEnd)));
    let text = pieces.join('').replace(/\s+/g, ' ').trim();
    if (!text && !emotions.length && !ruleHit) {
      // 一个标记都没有、也没摘掉任何东西：整条当正文（正文里出现方括号也不会被误吃）
      text = source.replace(pattern, '').replace(/\s+/g, ' ').trim();
    }

    return {
      text,
      emotion: last ? normaliseEmotion(last.raw, options.custom) : 'idle',
      emotions,
      selfNote,
      triggerRules,
      research,
      // P7：工具调用（最高权限下才执行）与「改自己的设定」（只有开发者模式才算）
      tools: agent.calls,
      settingsEdits: agent.settingsEdits,
      // 观众记忆：模型想知道某个观众以前来过没有（主进程本地查，不花钱）
      viewerLookups
    };
  }

  /**
   * 摘出「模型想查 / 想记」的标记，并把它们从正文里去掉。
   *
   * 两种标记（观众看不到，程序摘掉；主播在面板里看到待办再决定）：
   *   - `[待查:明日方舟]`        直播间里冒出来的新东西，模型想联网查一下
   *   - `[待查:明日方舟|观众提到了新游戏]`  可以在 `|` 后面写一句为什么
   *   - `[记一笔:观众说下周有明日方舟联动]`  值得记下来的事实/梗（她自己就能记下来）
   *   - `[改一下:终末地|公测时间写错了]`   发现**已有**知识写错了，想改它（P6）
   *   - `[扩写:大肥鱼玩偶]`            已有知识太单薄，想给它补内容（P6）
   *   - `[删掉:过时的梗|早就没人提了]`   这条知识不该留了（P7，最高权限下才生效）
   *
   * 设计取舍：
   *   · **只认这几种明确写法**（中英文都要能认），不做「正文里出现问号就当成想查」这种模糊推断
   *     —— 误判会直接花掉主播的额度和注意力；
   *   · 一条回复里最多留 `MAX_RESEARCH_MARKS`（3）条，多了丢掉：防止模型刷屏式地提需求；
   *   · **「改库」那两种最多留 1 条**：它们会**真的动知识库**，一次改一条已经是能接受的极限；
   *   · 关键词/内容都做长度限制，避免把整段正文塞进标记里。
   *
   * @returns {{text:string, marks:Array<{kind:'lookup'|'note'|'edit'|'expand'|'remove', text:string, reason:string}>}}
   */
  static extractResearchMarks(raw) {
    const source = String(raw || '');
    const marks = [];
    let edits = 0;
    const pattern = /[[【]\s*(待查|想查|查一下|lookup|记一笔|记下|记住|note|改一下|改一改|修正|扩写|补充|edit|expand|删掉|删除|remove)\s*[:：]\s*([^\]】]{1,400}?)\s*[\]】]/gi;
    const text = source
      .replace(pattern, (whole, kind, body) => {
        if (marks.length >= DeepSeekClient.MAX_RESEARCH_MARKS) return '';
        const [main, ...rest] = String(body).split('|');
        const value = String(main || '').replace(/\s+/g, ' ').trim();
        if (!value) return '';
        const label = String(kind);
        const isLookup = /^(待查|想查|查一下|lookup)$/i.test(label);
        const isNote = /^(记一笔|记下|记住|note)$/i.test(label);
        const isEdit = /^(改一下|改一改|修正|edit)$/i.test(label);
        const isRemove = /^(删掉|删除|remove)$/i.test(label);
        const type = isLookup ? 'lookup' : isNote ? 'note' : isEdit ? 'edit' : isRemove ? 'remove' : 'expand';
        // 动库的三种（改 / 扩写 / 删）加起来一次只认 1 条：多出来的整条丢掉
        // （不是降级成普通待办——那反而更乱）
        const touchesLibrary = type === 'edit' || type === 'expand' || type === 'remove';
        if (touchesLibrary && edits >= DeepSeekClient.MAX_EDIT_MARKS) return '';
        if (touchesLibrary) edits += 1;
        marks.push({
          kind: type,
          text: value.slice(0, DeepSeekClient.MAX_RESEARCH_CHARS),
          reason: rest.join('|').replace(/\s+/g, ' ').trim().slice(0, 80)
        });
        return '';
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, marks };
  }

  /**
   * 把「查观众」标记摘出来（2026-10-21 加的观众记忆）。
   *
   * 写法：`[查观众:小明]` / `[观众查:小明]` / `[viewer:小明]`
   * 语义：模型想知道这个观众以前来过没有（名册 + 本场要点），主进程**本地查一下**、
   *      把结果塞进下一轮提示词（不联网、不花钱，也不打断这一句回复）。
   *
   * 为什么不用「问一句就查」的模糊判断：误判会让每句话都触发查询，白花 token 还拖慢回复。
   *
   * @returns {{text:string, lookups:Array<{name:string}>}}
   */
  static extractViewerLookups(raw) {
    const source = String(raw || '');
    const lookups = [];
    const pattern = /[[【]\s*(?:查观众|观众查|看看观众|viewer|whois)\s*[:：]\s*([^\]】|]{1,20})(?:\|[^\]】]{1,60})?\s*[\]】]/gi;
    const text = source
      .replace(pattern, (whole, rawName) => {
        if (lookups.length >= 2) return '';
        const name = String(rawName || '').replace(/\s+/g, ' ').trim();
        if (!name) return '';
        lookups.push({ name: name.slice(0, 20) });
        return '';
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, lookups };
  }

  /**
   * 把「工具调用」标记摘出来（P7）。
   *
   * 写法：`[做:暂停]` / `[做:暂停|30]` / `[做:静音]` / `[tool:resume]`
   * 动作名只认固定那几个（见 TOOL_ALIASES），模型自己发明的一律不认——
   * 认不出来的当普通方括号文本留在正文里（观众能看到），不会静默生效。
   *
   * @returns {{text:string, calls:Array<{name:string, arg:string}>}}
   */
  static extractToolCalls(raw) {
    const source = String(raw || '');
    const calls = [];
    const pattern = /[[【]\s*(?:做|工具|tool)\s*[:：]\s*([^\]】|]{1,20})(?:\|([^\]】]{1,40}))?\s*[\]】]/gi;
    const text = source
      .replace(pattern, (whole, rawName, rawArg) => {
        if (calls.length >= DeepSeekClient.MAX_TOOL_CALLS) return '';
        const key = String(rawName).trim();
        const name = TOOL_ALIASES[key] || TOOL_ALIASES[key.toLowerCase()];
        if (!name) return whole; // 认不出来就原样留着（还能在正文里看见）
        calls.push({ name, arg: String(rawArg || '').trim().slice(0, 40) });
        return '';
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, calls };
  }

  /**
   * 把「改自己的设定」标记摘出来（P7）。
   *
   * 写法：`[改设定:人设|新的人设全文]` / `[改设定:性格|…]` / `[persona|…]`
   * **只有开发者模式下的要求才算**（判定在 copilot 里做：观众和普通对话一律忽略）。
   *
   * 字段名认不出来时，整段当「人设」——模型漏写字段名是常事，别把内容丢了。
   *
   * @returns {{text:string, edits:Array<{field:string, label:string, text:string}>}}
   */
  static extractSettingsEdits(raw) {
    const source = String(raw || '');
    const edits = [];
    const pattern = /[[【]\s*(?:改设定|设定|改人设|人设|改性格|性格|persona|style)\s*[:：]\s*([^\]】]{1,4100}?)\s*[\]】]/gi;
    const text = source
      .replace(pattern, (whole, body) => {
        if (edits.length >= DeepSeekClient.MAX_SETTINGS_EDITS) return '';
        const value = String(body || '').trim();
        if (!value) return '';
        let field = 'systemPrompt';
        let label = '人设';
        let content = value;
        const split = value.indexOf('|');
        if (split > 0) {
          const head = value.slice(0, split).trim().toLowerCase();
          const tail = value.slice(split + 1).trim();
          if (/^(人设|persona|systemprompt|system)$/.test(head)) {
            field = 'systemPrompt';
            label = '人设';
            content = tail;
          } else if (/^(性格|style|stylenotes|style_notes)$/.test(head)) {
            field = 'styleNotes';
            label = '性格';
            content = tail;
          }
        }
        if (!content) return '';
        edits.push({ field, label, text: content.slice(0, DeepSeekClient.MAX_SETTINGS_CHARS) });
        return '';
      })
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text, edits };
  }

  /**
   * 把所有「程序要处理」的额外标记一次摘干净：工具调用 → 改设定。
   * 顺序有讲究：这两个的内容都可能夹着别的方括号，先摘它们，再交给情绪/规则那一套。
   */
  static extractAgentMarks(raw) {
    const tools = DeepSeekClient.extractToolCalls(raw);
    const settings = DeepSeekClient.extractSettingsEdits(tools.text);
    return { text: settings.text, calls: tools.calls, settingsEdits: settings.edits };
  }

  /**
   * 找出 AI 记下来的触发词规则，例如 `开心=草|笑尿, 惊讶=啊？`。
   *
   * 返回 `{ rules, start, end }`（`start` 用来把这段从正文里摘掉），没找到返回 null。
   *
   * **为什么要卡这么严**：正文里完全可能正常说出「规则:」这个词
   * （「这条规则: 谁说的算？」）。所以判定标准是「**把识别到的东西拼回去，必须和原文一模一样**」——
   * 只有整段都是「状态=词,状态=词」这种形状才认。看着绕，但它把误判堵死了。
   *
   * 字段都是**原始文本**：状态名认不认识、词合不合法由主进程用
   * `shared/emotions.js` 的 `strictEmotionKey()` / `normaliseTriggers()` 再过一遍。
   */
  static findTriggerRules(raw, options = {}) {
    const source = String(raw || '');
    const marker = /规则\s*[:：]/g;
    let found = null;
    let match = marker.exec(source);
    while (match) {
      // 取最后一个「规则:」：AI 要记规则的话会放在最末尾
      found = match;
      match = marker.exec(source);
    }
    if (!found) return null;

    const start = found.index;
    const body = source.slice(start + found[0].length).trim();
    if (!body) return null;

    const rules = [];
    // 规则之间用逗号 / 分号分隔（也容忍顿号）
    for (const piece of body.split(/[,，;；]+/)) {
      const segment = piece.trim();
      if (!segment) continue;
      const hit = segment.match(/^([^\s=＝:：]+)\s*[=＝:：]\s*(.+)$/);
      if (hit) {
        // 名字必须是认识的状态：不认识就**当成普通正文**（返回 null 表示「这里没有规则」），
        // 否则正文里正常说出「这条规则: 谁说的算？」会被当成配置，连正文都被截掉
        if (!sharedEmotions.strictEmotionKey(hit[1], options.custom)) return null;
        const words = hit[2]
          .split(/[|｜、/／\s]+/)
          .map((word) => word.trim())
          .filter(Boolean);
        if (!words.length) return null;
        rules.push({ emotion: hit[1].trim(), words });
        continue;
      }
      // 没有等号：只能是上一条规则多出来的词
      const last = rules[rules.length - 1];
      if (!last) return null;
      const extra = segment
        .split(/[|｜、/／\s]+/)
        .map((word) => word.trim())
        .filter(Boolean);
      if (!extra.length) return null;
      last.words.push(...extra);
    }
    if (!rules.length) return null;
    return { rules, start, end: source.length };
  }

  /** 只要规则本身（给测试和调用方用） */
  static parseTriggerRules(raw, options = {}) {
    const hit = DeepSeekClient.findTriggerRules(raw, options);
    return hit ? hit.rules : [];
  }

  /** 连通性自检 */
  async test() {
    const result = await this.chat(
      [
        { role: 'system', content: '你是一个连通性测试助手。' },
        {
          role: 'user',
          content: '请输出「连接成功」，并在末尾加上标记 [情绪:happy]，不要输出其他任何内容。'
        }
      ],
      { maxTokens: 60, temperature: 0 }
    );
    const parsed = DeepSeekClient.parseReply(result.content);
    return { ...result, reply: parsed.text, emotion: parsed.emotion };
  }
}

// 主进程侧只做转发，真相在 src/shared/emotions.js（界面、主进程、测试共用同一份）
const EMOTIONS = sharedEmotions.EMOTION_KEYS;
const normaliseEmotion = sharedEmotions.normaliseEmotion;

module.exports = { DeepSeekClient, DeepSeekError, normaliseEmotion, EMOTIONS, normalizeBaseUrl };
