'use strict';

/**
 * 悬浮窗与控制面板共用的纯逻辑：
 *  - 12 个吉祥物状态（表情）的定义
 *  - 表情 → 图片名关键词自动匹配
 *  - 情绪名归一化
 * 这些函数不依赖 DOM，方便直接用 Node 跑测试，也能被主进程 require
 * （`module.exports` 那行在浏览器里不生效，浏览器走 IIFE 暴露的 window.SharedLogic）。
 *
 * ⚠️ 整个文件被包在一个 IIFE 里，只往 window 暴露一个 SharedLogic。
 * 原因：界面脚本（error-reporter.js / emotions.js / panel.js / overlay.js）在浏览器里
 * 共享同一个全局作用域。如果这里用顶层声明（const shortName = ... / function pickMascotImage() {}），
 * 就会和 panel.js、overlay.js 里的同名函数撞车，报
 * "Identifier 'xxx' has already been declared"，导致整个文件解析失败、界面全部按钮失效。
 *
 * ⚠️ 这份状态表是唯一的真相来源：主进程（copilot.js / llm.js）也 require 它来校验
 * AI 输出的情绪标记。以前主进程另写了一份 8 个状态的副本，加了新状态会对不上。
 */

const SharedLogic = (() => {
  /**
   * 12 个状态。
   *
   * `trigger` 表示谁来切到这个状态：
   *   - 'ai'   : AI 在回复末尾写 [情绪:xxx] 时可能用到的状态
   *   - 'auto' : 只由程序自己切（刚打开悬浮窗蹦一下），AI 不参与
   *   - 'rare' : 整活彩蛋，平时不用，只在特定情况出现
   *
   * 顺序有意义：`autoMapExpressions()` 按这个顺序认领图片，
   * 所以 AI 能用的状态排在前面，彩蛋排在最后。
   */
  const EMOTION_LIST = [
    { key: 'idle', label: '平常', trigger: 'ai', when: '没有特别情绪、待机时（自动回到这个状态）' },
    { key: 'talking', label: '说话中', trigger: 'ai', when: '正在说话、讲解、念回复' },
    { key: 'happy', label: '开心', trigger: 'ai', when: '被夸、聊得开心、兴奋' },
    { key: 'thinking', label: '思考', trigger: 'ai', when: '想事情、疑惑、答不上来（程序也在思考时自动切）' },
    { key: 'listening', label: '倾听', trigger: 'ai', when: '刚收到弹幕、在听观众说话' },
    { key: 'surprised', label: '惊讶', trigger: 'ai', when: '听到离谱发言、震惊' },
    { key: 'shy', label: '害羞', trigger: 'ai', when: '被夸得不好意思、脸红' },
    { key: 'sad', label: '无奈', trigger: 'ai', when: '被怼、委屈、叹气' },
    { key: 'greet', label: '打招呼', trigger: 'ai', when: '问候观众、被问好（连接成功时程序也会自动切）' },
    { key: 'sleep', label: '睡觉', trigger: 'ai', when: '观众道晚安、没人理它很久、无聊' },
    { key: 'blank', label: '吃白饭', trigger: 'rare', when: '整活彩蛋：装傻、干饭、被观众 cue 到「吃白饭」时' },
    { key: 'pop', label: '程序启动', trigger: 'auto', when: '软件启动 / 悬浮窗刚打开时蹦一下（程序自动）' }
  ];

  /**
   * 文件名关键词：点「按文件名自动匹配」时按这些词认图。
   *
   * 踩过的坑（改这里务必小心）：
   *   1. 匹配用的是**子串包含**，单字关键词很容易误伤。'平常' 曾经就是漏词，
   *      导致 `平常.png` 匹配不到 idle，被兜底逻辑顶替成了别的图。
   *   2. 别加 '觉'、'觉' 这类字：'睡觉' 会因此匹配到 '察觉'、'感觉' 之类。
   *      宁可多写几个完整词，也别放单字。
   */
  const EMOTION_KEYWORDS = {
    idle: ['default', 'normal', 'idle', 'base', '平常', '普通', '默认', '平静', '待机'],
    talking: ['talk', 'speak', '说话', '讲解'],
    happy: ['happy', 'joy', 'smile', 'fun', '开心', '高兴', '喜欢', '笑', '兴奋'],
    thinking: ['think', 'confus', 'question', '思考', '沉思', '疑惑', '疑问', '想'],
    listening: ['listen', 'ear', '倾听', '聆听', '听', '注意'],
    surprised: ['surprise', 'shock', 'wow', '惊讶', '震惊', '惊', '慌张', '慌乱'],
    shy: ['shy', 'blush', '害羞', '脸红', '羞'],
    sad: ['sad', 'cry', 'sorry', '难过', '哭', '无奈', '委屈', '叹气'],
    greet: ['greet', 'hello', 'hi', '打招呼', '问候', '招手', '招手问好'],
    sleep: ['sleep', 'zzz', '睡觉', '晚安', '打盹'],
    blank: ['blank', 'rice', '吃白饭', '白饭', '干饭', '摸鱼'],
    // ⚠️ 2026-10-19 主播把 `pop` 的显示名从「突然出现」改成了「程序启动」。
    // 下面这两处**都保留旧词**，是因为它们不是给人看的名字：
    //   · 关键词表是给**图片文件名**用的——默认素材里那张图就叫 `突然出现.png`，删了就对不上了；
    //   · 别名表是给**模型输出/手改配置**用的——留着旧的也能认出来，不丢东西。
    pop: ['pop', 'appear', '突然出现', '蹦出来', '登场', '程序启动', '启动']
  };

  /**
   * 别名：AI（或手改配置）写出来的各种说法 → 状态 key。
   *
   * 匹配时**先长后短**：'睡觉' 必须排在 '睡' 前面，否则「睡觉」会被 '睡' 抢先命中，
   * 更长的词就永远轮不到。所以下面这个表用长度排序，不要随手打乱。
   */
  const EMOTION_ALIAS = {
    开心: 'happy',
    高兴: 'happy',
    兴奋: 'happy',
    喜欢: 'happy',
    疑惑: 'thinking',
    思考: 'thinking',
    沉思: 'thinking',
    普通: 'idle',
    默认: 'idle',
    平静: 'idle',
    平常: 'idle',
    待机: 'idle',
    说话: 'talking',
    讲话: 'talking',
    惊讶: 'surprised',
    震惊: 'surprised',
    慌张: 'surprised',
    慌乱: 'surprised',
    害羞: 'shy',
    脸红: 'shy',
    难过: 'sad',
    无奈: 'sad',
    委屈: 'sad',
    叹气: 'sad',
    倾听: 'listening',
    聆听: 'listening',
    打招呼: 'greet',
    问候: 'greet',
    招手: 'greet',
    睡觉: 'sleep',
    晚安: 'sleep',
    打盹: 'sleep',
    困了: 'sleep',
    吃白饭: 'blank',
    干饭: 'blank',
    摸鱼: 'blank',
    发呆: 'blank',
    突然出现: 'pop',
    程序启动: 'pop',
    蹦出来: 'pop',
    登场: 'pop',
    neutral: 'idle',
    normal: 'idle',
    excited: 'happy',
    confused: 'thinking',
    angry: 'surprised',
    hello: 'greet',
    hi: 'greet',
    bye: 'greet',
    sleep: 'sleep',
    sleepyy: 'sleep',
    blank: 'blank',
    pop: 'pop',
    appear: 'pop'
  };

  const EMOTION_KEYS = EMOTION_LIST.map((item) => item.key);

  // ---------------------------------------------------------------- 自定义表情（2026-10-19 加）
  //
  // 主播要的是「能自己再加几个表情」：内置那 12 个是程序定的（连接时打招呼、思考时切 thinking
  // 这些行为绑在状态上），但「生气」「吃瓜」「比心」这类只跟他直播内容有关的表情，
  // 光靠 12 个槽装不下。于是给一份**用户自定义状态表**：
  //
  //   mascot.customEmotions = [{ key: '生气', when: '被怼、明显不耐烦时用', alias: '恼火' }]
  //
  // 三条设计约束（都是主播拍过板的）：
  //   1. **最多 8 个**：每个都要进提示词（"生气(生气)：被怼时用"），十几个会让模型选择困难、更容易乱标；
  //   2. **内置的 12 个不能删**：内置状态被主流程引用（连上→greet、思考→thinking、开窗→pop），
  //      删了会出现「该切的表情切不到」；用户可以清空它们的触发词、换图；
  //   3. **名字 2~6 个字**：单字（例如「气」）会子串误伤一切含这个字的句子，
  //      所以比内置状态更严格——内置状态名字够长，靠别名表兜住。
  //
  // ⚠️ 数据结构没变：自定义状态直接进 `mascot.expressions` / `mascot.triggers` 的键，
  //    所以老配置、老界面逻辑都不用迁移。

  /** 最多几个自定义表情 */
  const MAX_CUSTOM_EMOTIONS = 8;
  /** 自定义表情名字的长度范围（单字太容易误伤，见上面第 3 条） */
  const MIN_CUSTOM_NAME = 2;
  const MAX_CUSTOM_NAME = 6;
  /** 「什么时候用」这句会原样进提示词，别让它把提示词撑爆 */
  const MAX_CUSTOM_WHEN = 40;
  /** 别名（模型用别的说法也能命中它） */
  const MAX_CUSTOM_ALIAS = 8;

  /** 内置状态名 + 内置别名，自定义表情不许跟它们撞车（撞了会抢走内置状态） */
  const RESERVED_EMOTION_WORDS = (() => {
    const words = new Set(EMOTION_KEYS.map((key) => key.toLowerCase()));
    for (const word of Object.keys(EMOTION_ALIAS)) words.add(word.toLowerCase());
    return words;
  })();

  /**
   * 清洗自定义表情表：修剪、限长、去重、挡掉跟内置撞车的、最多留 8 个。
   *
   * 宽容度：接受 `['生气', ...]`（只有名字）和 `[{key,when,alias}, ...]` 两种形状，
   * 因为手改配置文件的人多半会直接写字符串。
   *
   * @returns {Array<{key:string,label:string,when:string,alias:string,custom:true,trigger:'ai'}>}
   */
  function normaliseCustomEmotions(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const out = [];
    const seen = new Set();
    for (const item of list) {
      const source = typeof item === 'string' ? { key: item } : item && typeof item === 'object' ? item : null;
      if (!source) continue;
      const key = String(source.key || source.name || source.label || '')
        .replace(/\s+/g, '')
        .slice(0, MAX_CUSTOM_NAME)
        .trim();
      if (key.length < MIN_CUSTOM_NAME) continue;
      const lower = key.toLowerCase();
      if (RESERVED_EMOTION_WORDS.has(lower)) continue; // 跟内置状态/别名撞车：整条丢掉
      if (seen.has(lower)) continue;
      const aliasRaw = String(source.alias || source.别名 || '')
        .replace(/\s+/g, '')
        .slice(0, MAX_CUSTOM_ALIAS)
        .trim();
      // 别名跟内置撞车、或者跟别的自定义表情撞车 → 直接不要这个别名（名字本身仍然有效）
      const alias =
        aliasRaw && !RESERVED_EMOTION_WORDS.has(aliasRaw.toLowerCase()) && !seen.has(aliasRaw.toLowerCase())
          ? aliasRaw
          : '';
      out.push({
        key,
        label: key,
        when: String(source.when || source.什么时候用 || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_CUSTOM_WHEN),
        alias,
        custom: true,
        trigger: 'ai'
      });
      seen.add(lower);
      if (alias) seen.add(alias.toLowerCase());
      if (out.length >= MAX_CUSTOM_EMOTIONS) break;
    }
    return out;
  }

  /**
   * 内置 12 个 + 用户自定义 = 界面上/提示词里真正要用的那张表。
   * 内置永远在前（顺序 = `matchTrigger` 的优先级），自定义按用户排的顺序追加。
   */
  function emotionList(custom) {
    const extra = normaliseCustomEmotions(custom);
    return extra.length ? [...EMOTION_LIST, ...extra] : EMOTION_LIST.slice();
  }

  /** 从自定义表里找命中项（名字/别名精确匹配） */
  function findCustomByWord(extra, word) {
    const target = String(word || '').toLowerCase().trim();
    if (!target) return null;
    for (const item of extra) {
      if (item.key.toLowerCase() === target) return item;
      if (item.alias && item.alias.toLowerCase() === target) return item;
    }
    return null;
  }

  function shortName(name) {
    return String(name || '').replace(/\.[a-z0-9]+$/i, '').trim();
  }

  /**
   * 情绪名归一到状态 key。
   * @param {string} emotion 模型/配置里写的情绪名
   * @param {Array} [custom] 用户自定义表情表（`mascot.customEmotions`）
   */
  function normaliseEmotion(emotion, custom) {
    const text = String(emotion || '').toLowerCase().trim();
    if (!text) return 'idle';
    if (EMOTION_KEYS.includes(text)) return text;
    const extra = normaliseCustomEmotions(custom);
    // 自定义状态先按「名字/别名精确匹配」认：这是用户明确指定过的词，优先级高于内置别名表
    const exact = findCustomByWord(extra, text);
    if (exact) return exact.key;
    // 先长后短：不然 '睡觉' 会被表里的 '睡' 抢先命中
    const pairs = Object.entries(EMOTION_ALIAS).sort((a, b) => b[0].length - a[0].length);
    for (const [key, value] of pairs) {
      if (text.includes(key.toLowerCase())) return value;
    }
    // 最后才是自定义的「包含匹配」（模型写「生气地说」也认得）
    for (const item of extra) {
      if (text.includes(item.key.toLowerCase())) return item.key;
      if (item.alias && text.includes(item.alias.toLowerCase())) return item.key;
    }
    return 'idle';
  }

  /**
   * 选出一张该情绪该用的图片（返回 dataURL 或 null）
   * @param {{images?:object, expressions?:object, customEmotions?:Array}} mascot
   * @param {string} emotion
   */
  function pickMascotImage(mascot, emotion) {
    const config = mascot || {};
    const images = config.images || {};
    const names = Object.keys(images);
    if (!names.length) return null;

    const custom = normaliseCustomEmotions(config.customEmotions);
    const key = normaliseEmotion(emotion, custom);
    const mapped = (config.expressions || {})[key];
    if (mapped && images[mapped]) return images[mapped];
    if (images[key]) return images[key];

    let keywords = EMOTION_KEYWORDS[key] || [];
    if (!keywords.length) {
      // 自定义表情没有内置关键词表：拿它自己的名字/别名当文件名关键词
      // （图片叫「生气.png」时，即使没手动指定也能对上）
      const own = custom.find((item) => item.key === key);
      if (own) keywords = [own.key, own.alias].filter(Boolean);
    }
    for (const name of names) {
      const lower = shortName(name).toLowerCase();
      if (keywords.some((keyword) => lower.includes(String(keyword).toLowerCase()))) return images[name];
    }

    const idleName = (config.expressions || {}).idle;
    if (idleName && images[idleName]) return images[idleName];
    for (const name of names) {
      const lower = shortName(name).toLowerCase();
      if (EMOTION_KEYWORDS.idle.some((keyword) => lower.includes(String(keyword).toLowerCase()))) {
        return images[name];
      }
    }
    // 实在认不出来（图片名全是 `1.png`、`2.png` 这种）才随便挑一张，至少别空着
    return images[names[0]];
  }

  /**
   * 默认触发词：观众弹幕里出现这些词，吉祥物立刻切到对应状态
   * （不用等 AI 回复，看到「哈哈哈」就笑）。
   *
   * 和 EMOTION_KEYWORDS 是两回事，别混：
   *   - EMOTION_KEYWORDS：给**图片文件名**用的，决定「哪张图是开心」
   *   - 这张表：给**观众弹幕内容**用的，决定「观众说什么会让它换表情」
   *
   * 主播可以在控制面板里改，也可以直接跟 AI 说「以后谁发『草』你就笑」让它记下来。
   */
  const DEFAULT_TRIGGERS = {
    happy: ['哈哈', '哈哈哈', '笑死', '草', '乐', '好耶', 'nice'],
    surprised: ['卧槽', '我超', '啊？', '真的假的', '牛的', '666'],
    sad: ['呜呜', '难受', '寄了', '崩了'],
    shy: ['可爱', '喜欢你', '好萌'],
    greet: ['你好', 'hi', '在吗', '主播好'],
    sleep: ['晚安', '睡了', '下班']
  };

  /** 触发词最多留多少个（防止 AI 记一堆把配置撑大） */
  const MAX_TRIGGERS_PER_EMOTION = 40;
  /** 单个触发词最长几个字 */
  const MAX_TRIGGER_LENGTH = 12;
  /** 数量上限：**能配触发词的状态**最多几个（内置 12 个 + 自定义 8 个 = 20） */
  const MAX_TRIGGER_EMOTIONS = EMOTION_LIST.length + MAX_CUSTOM_EMOTIONS;

  /**
   * 清洗一份触发词表：只留认识的状态、去掉空白/重复/过长的词。
   * AI 记下来的规则和界面提交的改动都走这里，免得把脏数据写进配置。
   *
   * 注意这里**不能用 normaliseEmotion 兜底**：它对不认识的词会返回 'idle'，
   * 于是 AI 或主播写错的「乱写的: [x]」会变成「平常的触发词 x」——静默变成一条奇怪的规则。
   * 这张表要严格：认识的状态才留，不认识的整条丢掉。
   *
   * @param {object} raw `{状态: [词...]}`
   * @param {Array} [custom] 用户自定义表情表（不传 = 只认内置 12 个）
   */
  function normaliseTriggers(raw, custom) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    const extra = normaliseCustomEmotions(custom);
    let emotions = 0;
    for (const [emotion, words] of Object.entries(raw)) {
      const key = strictEmotionKey(emotion, extra);
      if (!key) continue;
      const list = (Array.isArray(words) ? words : [words])
        .map((word) => String(word == null ? '' : word).trim().slice(0, MAX_TRIGGER_LENGTH))
        .filter(Boolean);
      const unique = [...new Set(list)].slice(0, MAX_TRIGGERS_PER_EMOTION);
      if (!unique.length) {
        // 允许显式清空某个状态：留个空数组，界面上看得出来「这个状态被手动清过了」
        if (Array.isArray(words)) out[key] = [];
        continue;
      }
      if (emotions >= MAX_TRIGGER_EMOTIONS) continue;
      out[key] = unique;
      emotions += 1;
    }
    return out;
  }

  /**
   * 严格取状态 key：认识才返回，不认识返回 null（不做 idle 兜底）
   * @param {string} emotion
   * @param {Array} [custom] 用户自定义表情表
   */
  function strictEmotionKey(emotion, custom) {
    const text = String(emotion || '').toLowerCase().trim();
    if (!text) return null;
    if (EMOTION_KEYS.includes(text)) return text;
    const extra = normaliseCustomEmotions(custom);
    const exact = findCustomByWord(extra, text);
    if (exact) return exact.key;
    const pairs = Object.entries(EMOTION_ALIAS).sort((a, b) => b[0].length - a[0].length);
    for (const [word, key] of pairs) {
      if (text.includes(word.toLowerCase())) return key;
    }
    for (const item of extra) {
      if (text.includes(item.key.toLowerCase())) return item.key;
      if (item.alias && text.includes(item.alias.toLowerCase())) return item.key;
    }
    return null;
  }

  /**
   * 观众这条弹幕命中了哪个状态？没命中返回 null。
   *
   * 按 `emotionList()`（内置 12 个 + 自定义）的顺序挑**第一个**命中的：状态表顺序就是优先级
   * （比如「晚安」既像打招呼又像睡觉，睡觉排在后面，但触发词表里只有 sleep 有它，
   * 所以不会冲突；真冲突时以状态表顺序为准，行为可预测）。
   * 自定义表情永远排在内置后面 → 内置触发词优先，用户新加的表情不会抢走「哈哈→开心」。
   */
  function matchTrigger(triggers, text, custom) {
    const content = String(text || '').toLowerCase();
    if (!content) return null;
    const table = triggers && typeof triggers === 'object' ? triggers : {};
    for (const item of emotionList(custom)) {
      const words = table[item.key];
      if (!Array.isArray(words) || !words.length) continue;
      for (const word of words) {
        const needle = String(word).trim().toLowerCase();
        if (needle && content.includes(needle)) return item.key;
      }
    }
    return null;
  }

  /**
   * 合并成「实际生效」的触发词表：**内置默认词打底，用户配的覆盖上去**。
   * 某个状态配成空数组 = 显式关掉这个状态的触发词（默认词也不生效）。
   */
  function effectiveTriggers(userTriggers) {
    const out = {};
    for (const [key, words] of Object.entries(DEFAULT_TRIGGERS)) out[key] = [...words];
    if (userTriggers && typeof userTriggers === 'object') {
      for (const [key, words] of Object.entries(userTriggers)) {
        if (Array.isArray(words)) out[key] = words.map((word) => String(word));
      }
    }
    return out;
  }

  /** 观众这条弹幕该切哪个状态？没命中返回 null */
  function findDanmakuEmotion(userTriggers, text, custom) {
    return matchTrigger(effectiveTriggers(userTriggers), text, custom);
  }

  /**
   * 按文件名给每个状态自动配图，返回新的 expressions。
   *
   * 注意：**不再兜底把第一个文件塞给 idle**。以前那么干，文件夹里第一个是 `叹气.png`
   * 时，「平常」就被顶替成了叹气——看起来像「自动匹配坏了」。
   * 认不出来就留空，让主播在界面上自己挑，比认错强。
   *
   * 自定义表情也一起认：图片名里含它的名字/别名就算命中。
   */
  function autoMapExpressions(mascot) {
    const images = (mascot && mascot.images) || {};
    const names = Object.keys(images);
    const expressions = { ...((mascot && mascot.expressions) || {}) };
    const custom = normaliseCustomEmotions(mascot && mascot.customEmotions);
    const used = new Set();
    let matched = 0;
    for (const emotion of emotionList(custom)) {
      const keywords = EMOTION_KEYWORDS[emotion.key] || (emotion.custom ? [emotion.key, emotion.alias].filter(Boolean) : []);
      const hit = names.find(
        (name) =>
          !used.has(name) &&
          keywords.some((keyword) => shortName(name).toLowerCase().includes(String(keyword).toLowerCase()))
      );
      if (hit) {
        expressions[emotion.key] = hit;
        used.add(hit);
        matched += 1;
      }
    }
    return { expressions, matched };
  }

  return {
    EMOTION_LIST,
    EMOTION_KEYWORDS,
    EMOTION_ALIAS,
    EMOTION_KEYS,
    DEFAULT_TRIGGERS,
    MAX_TRIGGERS_PER_EMOTION,
    MAX_TRIGGER_LENGTH,
    MAX_TRIGGER_EMOTIONS,
    MAX_CUSTOM_EMOTIONS,
    MIN_CUSTOM_NAME,
    MAX_CUSTOM_NAME,
    MAX_CUSTOM_WHEN,
    MAX_CUSTOM_ALIAS,
    shortName,
    normaliseEmotion,
    normaliseCustomEmotions,
    emotionList,
    normaliseTriggers,
    strictEmotionKey,
    matchTrigger,
    effectiveTriggers,
    findDanmakuEmotion,
    pickMascotImage,
    autoMapExpressions
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SharedLogic;
} else {
  window.SharedLogic = SharedLogic;
}
