'use strict';

/**
 * 界面脚本冒烟测试：在自制轻量 DOM 里真实执行渲染层脚本（不依赖 Electron / 浏览器）
 *   node scripts/test-ui.js
 *
 * 覆盖：
 *   - 控制面板 / 悬浮窗脚本能否正常初始化（不抛异常）
 *   - 悬浮窗：回复文本生成、观众原话显示、表情切图、拖动定位
 *   - 控制面板：页签切换、弹幕流渲染、过滤标记、日志渲染
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
// 状态表（12 个）——界面脚本用的是 window.SharedLogic，测试里直接 require 同一份
const { EMOTION_LIST } = require(path.join(root, 'src', 'shared', 'emotions.js'));
let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  pending.push({ name, fn });
}

async function runPending() {
  for (const { name, fn } of pending) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${name}\n      ${error.message}`);
    }
  }
  pending.length = 0;
}

/** 反复让出事件循环，直到没有新的微任务产生（用于等渲染层的 async init 跑完） */
async function drain(times = 12) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------- 迷你 DOM

/** HTML 里「只写名字就有意义」的属性：解析时要把空字符串转成 true */
const BOOLEAN_ATTRS = new Set(['hidden', 'disabled', 'checked', 'selected', 'readonly', 'multiple']);

/** 极简 HTML 解析器：还原 id / class / 父子结构 / 标签间文本，够迷你 DOM 用 */
function parseHtml(html, makeNode) {
  const rootNode = makeNode('html', '', '');
  const stack = [rootNode];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^>]*?)?)(\/?)>/g;
  const voidTags = ['br', 'img', 'input', 'meta', 'link', 'hr', 'source'];
  let match;
  let lastIndex = 0;

  while ((match = tagRe.exec(html))) {
    // 两个标签之间的文本 → 建成文本节点（按钮文案、label 文字都靠这个）
    const text = html.slice(lastIndex, match.index);
    lastIndex = tagRe.lastIndex;
    if (text.trim()) {
      const textNode = makeNode('#text', '', '', true);
      textNode._text = text.replace(/\s+/g, ' ').trim();
      stack[stack.length - 1].appendChild(textNode);
    }

    const slash = match[1];
    const tag = match[2].toLowerCase();
    const rawAttrs = match[3] || '';
    const selfClose = match[4];
    if (slash) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(rawAttrs))) {
      attrs[attrMatch[1]] = attrMatch[2] === undefined ? '' : attrMatch[2];
    }
    const node = makeNode(tag, attrs.id || '', attrs.class || '');
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class' || key === 'id') continue;
      // data-* 要进 dataset（真实 DOM 就是这样）：悬浮窗的缩放抓手靠 `data-dir` 认方向，
      // 不转的话测试里 `handle.dataset.dir` 永远是空的，拖拽逻辑根本进不去。
      if (key.startsWith('data-')) {
        const camel = key.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        node.dataset[camel] = value;
        continue;
      }
      // 布尔属性（HTML 里只写名字不写值）：真实 DOM 里 `el.hidden` 是 true，
      // 不是空字符串。不转的话 `if (!el.hidden)` 这种判断在测试里会反掉。
      node[key] = BOOLEAN_ATTRS.has(key) ? value !== 'false' : value;
    }
    stack[stack.length - 1].appendChild(node);
    if (!selfClose && !voidTags.includes(tag)) stack.push(node);
  }
  return rootNode;
}

function createDom(htmlFile) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  const nodes = new Map();
  const all = [];

  function makeNode(tag, id, classes, isText = false) {
    const listeners = new Map();
    const classSet = new Set(String(classes || '').split(/\s+/).filter(Boolean));
    const node = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: isText ? 3 : 1,
      isText,
      _text: '',
      id: id || '',
      className: classes || '',
      children: [],
      childNodes: [],
      parentNode: null,
      style: {
        // 迷你 DOM 的 style 也要支持自定义属性（--xxx 那类）
        setProperty(name, value) {
          this[name] = String(value);
        },
        removeProperty(name) {
          delete this[name];
        },
        getPropertyValue(name) {
          return this[name] === undefined ? '' : String(this[name]);
        }
      },
      dataset: {},
      value: '',
      checked: false,
      disabled: false,
      type: '',
      src: '',
      alt: '',
      title: '',
      offsetHeight: 40,
      offsetWidth: 100,
      offsetLeft: 0,
      offsetTop: 0,
      scrollTop: 0,
      scrollHeight: 100,
      clientWidth: 100,
      clientHeight: 40,
      /** 需要按区域大小算落点的逻辑会用到（迷你 DOM 里按 offset 尺寸给） */
      getBoundingClientRect() {
        return {
          left: node.offsetLeft || 0,
          top: node.offsetTop || 0,
          width: node.offsetWidth || 0,
          height: node.offsetHeight || 0,
          right: (node.offsetLeft || 0) + (node.offsetWidth || 0),
          bottom: (node.offsetTop || 0) + (node.offsetHeight || 0)
        };
      },
      classList: {
        add(name) {
          classSet.add(name);
          node.className = [...classSet].join(' ');
        },
        remove(name) {
          classSet.delete(name);
          node.className = [...classSet].join(' ');
        },
        toggle(name, force) {
          const want = force === undefined ? !classSet.has(name) : Boolean(force);
          if (want) classSet.add(name);
          else classSet.delete(name);
          node.className = [...classSet].join(' ');
        },
        contains(name) {
          return classSet.has(name);
        }
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners.get(type) || [];
        const index = list.indexOf(fn);
        if (index >= 0) list.splice(index, 1);
      },
      dispatch(type, event = {}) {
        for (const fn of listeners.get(type) || []) fn({ target: node, ...event });
      },
      hasListener(type) {
        return (listeners.get(type) || []).length > 0;
      },
      appendChild(child) {
        child.parentNode = node;
        node.children.push(child);
        node.childNodes.push(child);
        return child;
      },
      append(...items) {
        for (const item of items) node.appendChild(item);
      },
      removeChild(child) {
        const index = node.children.indexOf(child);
        if (index >= 0) node.children.splice(index, 1);
        const index2 = node.childNodes.indexOf(child);
        if (index2 >= 0) node.childNodes.splice(index2, 1);
        child.parentNode = null;
      },
      remove() {
        if (node.parentNode) node.parentNode.removeChild(node);
      },
      getBoundingClientRect() {
        const layout = node._layout || { left: 0, top: 0, width: 100, height: 40 };
        return {
          left: layout.left,
          top: layout.top,
          right: layout.left + layout.width,
          bottom: layout.top + layout.height,
          width: layout.width,
          height: layout.height,
          x: layout.left,
          y: layout.top
        };
      },
      querySelector(selector) {
        return node._queryAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        return node._queryAll(selector);
      },
      _queryAll(selector) {
        const text = String(selector || '').trim();
        const results = [];
        const matches = (candidate) => {
          if (candidate.isText) return false;
          if (text.startsWith('.')) {
            return String(candidate.className).split(/\s+/).includes(text.slice(1));
          }
          if (text.startsWith('#')) return candidate.id === text.slice(1);
          return candidate.tagName === text.toUpperCase();
        };
        const walkDescendants = (current) => {
          for (const child of current.children) {
            if (matches(child)) results.push(child);
            walkDescendants(child);
          }
        };
        walkDescendants(node);
        return results;
      },
      setAttribute(key, value) {
        if (key === 'src') node.src = value;
        else node[key] = value;
      },
      getAttribute(key) {
        return key === 'src' ? node.src || null : node[key];
      },
      removeAttribute(key) {
        if (key === 'src') node.src = '';
      },
      focus() {},
      click() {
        node.dispatch('click');
      },
      get firstElementChild() {
        return node.children[0] || null;
      },
      get childElementCount() {
        return node.children.length;
      }
    };

    // innerHTML：必须和真实 DOM 一样会清空子节点，
    // 否则「清空对话记录」这类逻辑在测试里看起来像是失效的
    Object.defineProperty(node, 'innerHTML', {
      get() {
        return node._innerHTML || '';
      },
      set(value) {
        const html = String(value == null ? '' : value);
        node._innerHTML = html;
        node.children = [];
        node.childNodes = [];
        node._text = html ? node._text || '' : '';
      }
    });

    // textContent：文本节点直接存取，元素节点聚合/清空所有后代文本
    Object.defineProperty(node, 'textContent', {
      get() {
        if (node.isText) return node._text;
        if (node.children.length === 0) return node._text || '';
        return node.children.map((child) => child.textContent).join('');
      },
      set(value) {
        const text = String(value == null ? '' : value);
        if (node.isText) {
          node._text = text;
          return;
        }
        node._text = text;
        node.children.forEach((child) => {
          child.parentNode = null;
        });
        node.children = [];
        node.childNodes = [];
        if (text) {
          const textNode = makeNode('#text', '', '', true);
          textNode._text = text;
          node.children.push(textNode);
          node.childNodes.push(textNode);
          textNode.parentNode = node;
        }
      }
    });

    // 记录布局用：getBoundingClientRect 读取 _layout
    all.push(node);
    return node;
  }

  // 用真正的 HTML 解析结果建立节点树（含嵌套元素，例如 <span class="pill"><span>…</span></span>）
  const htmlRoot = parseHtml(html, makeNode);
  const walk = (node) => {
    node._layout = { left: 10, top: 10, width: 100, height: 40 };
    if (node.id) nodes.set(node.id, node);
    for (const child of node.children) walk(child);
  };
  walk(htmlRoot);

  const collect = (tag) => all.filter((node) => node.tagName === tag.toUpperCase() && !node.isText);
  const tabs = collect('button').filter((node) => String(node.className).split(/\s+/).includes('tab'));
  const panels = [...nodes.values()].filter((node) => node.id.startsWith('tab-'));
  for (const tab of tabs) {
    tab.dataset = { tab: (tab.getAttribute && tab.getAttribute('data-tab')) || 'studio' };
  }
  const chips = all.filter((node) => String(node.className).split(/\s+/).includes('chip'));

  const documentListeners = new Map();
  const document = {
    _nodes: nodes,
    _listeners: documentListeners,
    emit(type, event) {
      for (const fn of documentListeners.get(type) || []) fn(event || {});
    },
    body: makeNode('body', '', ''),
    documentElement: htmlRoot,
    getElementById(id) {
      return nodes.get(id) || null;
    },
    createElement(tag) {
      return makeNode(tag, '', '');
    },
    createTextNode(text) {
      const node = makeNode('#text', '', '', true);
      node._text = String(text == null ? '' : text);
      return node;
    },
    querySelector(selector) {
      if (selector === '.tab.active') return tabs[0] || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.tab') return tabs;
      if (selector === '.panel') return panels;
      if (selector === '.chip') return chips;
      return [];
    },
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = documentListeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    }
  };

  const windowListeners = new Map();
  const window = {
    innerWidth: 1920,
    innerHeight: 1080,
    api: null,
    SharedLogic: null,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = windowListeners.get(type) || [];
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    /** 测试里触发窗口级事件（拖动时监听挂在 window 上） */
    emit(type, event = {}) {
      for (const fn of windowListeners.get(type) || []) fn(event);
    },
    hasListener(type) {
      return (windowListeners.get(type) || []).length > 0;
    }
  };

  return { document, window, nodes, tabs, all, html };
}

/** 把多个脚本按顺序在同一个沙箱里执行（模拟浏览器 <script> 串联） */
function runScripts(sandbox, files) {
  const context = vm.createContext(sandbox);
  for (const file of files) {
    const code = fs.readFileSync(path.join(root, file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return context;
}

function makeTimers() {
  const timers = [];
  let nextId = 1;
  const api = {};
  /**
   * 执行已注册的定时器回调（模拟时间流逝）。
   * `maxMs` 传数字表示「只跑时长不超过它的」，传函数表示「只跑这个函数挑中的那些」——
   * 后者用来在同一个界面里单独驱动某一类定时器（比如只跑表情那一步）。
   */
  api.flush = (limit = 50, maxMs = Infinity) => {
    const accept = typeof maxMs === 'function' ? maxMs : (timer) => (timer.ms || 0) <= maxMs;
    let ran = 0;
    for (let i = 0; i < limit; i += 1) {
      const index = timers.findIndex(accept);
      if (index === -1) break;
      const timer = timers.splice(index, 1)[0];
      timer.fn();
      ran += 1;
    }
    return ran;
  };
  /** 只跑时长不超过 ms 的定时器：用来只触发停留计时而不触发消失动画 */
  api.run = (ms) => api.flush(50, ms);
  api.setTimeout = (fn, ms) => {
    const id = nextId;
    nextId += 1;
    timers.push({ id, fn, ms });
    return id;
  };
  api.clearTimeout = (id) => {
    const index = timers.findIndex((timer) => timer.id === id);
    if (index !== -1) timers.splice(index, 1);
  };
  api.setInterval = api.setTimeout;
  api.clearInterval = api.clearTimeout;
  api.requestAnimationFrame = (fn) => {
    // 同步执行，让布局计算立即生效
    fn(0);
    return 1;
  };
  api.queueMicrotask = (fn) => fn();
  api.timers = timers;
  return api;
}

/** 造一个假的 speechSynthesis，记录被朗读的内容 */
function makeFakeSpeech(voices) {
  const spoken = [];
  const record = { spoken, cancelled: 0 };
  /** 「上一条念完了」：真实系统会回调 onend，界面靠它接着念下一条 */
  const finishLast = () => {
    const last = spoken[spoken.length - 1];
    if (!last) throw new Error('还没有念过任何内容，没法模拟念完');
    if (typeof last.onend === 'function') last.onend();
    return last;
  };
  class FakeUtterance {
    constructor(text) {
      this.text = text;
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.voice = null;
    }
  }
  const synth = {
    _listeners: {},
    getVoices: () => voices,
    speak(utterance) {
      spoken.push(utterance);
    },
    cancel() {
      record.cancelled += 1;
    },
    addEventListener(type, fn) {
      this._listeners[type] = fn;
    }
  };
  return { synth, FakeUtterance, record, finishLast };
}

// 云音色的默认配置（单独拎出来，测试想改其中一个字段时可以铺开再覆盖）
const BASE_CLOUD = {
  apiKey: 'sk-tts',
  baseUrl: 'https://dashscope.aliyuncs.com',
  model: 'qwen3-tts-flash',
  voice: 'Cherry',
  languageType: 'Chinese',
  timeoutMs: 15000,
  cacheSize: 100
};

/** 只改云音色里的某几个字段（baseSettings 是「按段浅合并」，整段替换会丢字段） */
function cloudSettings(patch = {}) {
  return baseSettings({ speech: { cloud: { ...BASE_CLOUD, ...patch } } });
}

function baseSettings(overrides = {}) {
  const base = {
    api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', thinking: 'low', temperature: 1.1, maxTokens: 0, timeoutSec: 45 },
    persona: {
      botName: '小助手',
      nickname: '小助手',
      systemPrompt: '人设',
      styleNotes: '',
      // 角色表：默认角色就是原本那套人设（主进程首次读配置时会自动补上这一条）
      roles: { default: { name: '小助手', emoji: '🐟', prompt: '人设', style: '' } },
      activeRole: 'default',
      contextRounds: 8,
      memoryMinutes: 20,
      useJsonFormat: true
    },
    overlay: {
      posXRatio: 0.5,
      posYRatio: 0.5,
      width: 400,
      height: 480,
      mascotWidth: 200,
      fontScale: 1,
      opacity: 1,
      clickThrough: true,
      alwaysOnTop: true,
      replySeconds: 20,
      showViewerMessage: true,
      hideInScreenshot: false,
      // 和正式默认值保持一致（这里原来是 true，但当时还没有这个配置项，等于一个孤儿键）
      locked: false
    },
    danmaku: { roomId: '1234567', autoStart: true, sessdata: '', useCookie: false, ignoreKeywords: '', maxLength: 120, minIntervalSec: 4, batchWindowMs: 1200, maxBatch: 8, blockedUsers: '', triggerMode: 'all' },
    // 主动搭话（2026-10-21 替换冷场暖场）：默认关着，界面要能回填 + 改写
    proactive: {
      enabled: false,
      idleSeconds: 180,
      maxPerHour: 6,
      chancePercent: 70,
      maxChars: 40,
      modes: ['topic', 'ask', 'follow'],
      useKnowledge: true,
      prompt: '别太刻意'
    },
    // 观众记忆（2026-10-21）：本场记录默认关着（靠 autoStart 在启动时打开），名册开着
    viewerMemory: {
      enabled: false,
      autoStart: true,
      rosterEnabled: true,
      batchSize: 20,
      intervalSec: 120,
      maxBatchesPerHour: 12,
      injectChars: 500,
      rosterMax: 2000
    },
    mascot: {
      images: {
        '默认.png': 'data:image/png;base64,DEFAULT',
        '开心.png': 'data:image/png;base64,HAPPY',
        '打招呼.png': 'data:image/png;base64,GREET',
        '睡觉.png': 'data:image/png;base64,SLEEP',
        '突然出现.png': 'data:image/png;base64,POP',
        '惊讶.png': 'data:image/png;base64,SURPRISED',
        '害羞.png': 'data:image/png;base64,SHY',
        '思考.png': 'data:image/png;base64,THINKING',
        '叹气.png': 'data:image/png;base64,SAD'
      },
      expressions: {
        idle: '默认.png',
        happy: '开心.png',
        greet: '打招呼.png',
        sleep: '睡觉.png',
        pop: '突然出现.png',
        surprised: '惊讶.png',
        shy: '害羞.png',
        thinking: '思考.png',
        sad: '叹气.png'
      },
      // 用户自定义的表情（2026-10-19）：默认没有
      customEmotions: [],
      fallbackEmoji: '🦊',
      animation: true
    },
    logging: { maxMemory: 500, writeFile: true },
    knowledge: {
      enabled: true,
      injectCount: 3,
      injectChars: 600,
      dir: '',
      engine: 'builtin',
      // 内置联网的走法：self = 自研搜索接口（新，默认），model = 模型联网（老办法）
      searchMode: 'self',
      dshMode: 'session',
      dshSessionName: '直播知识整理',
      dshSessionId: '',
      dshModel: 'deepseek-flash',
      dshCommand: '',
      dshNode: '',
      dshTimeoutSec: 300,
      dshWorkspaceNoticeSeen: false,
      requireReview: true,
      // 「她自己动库」的权限（P6）：默认直接改、一小时最多 10 次
      selfEdit: 'auto',
      selfEditPerHour: 10,
      // 一次联网校对跑几条（整理/校对，2026-10-19）
      reviewLimit: 5
    },    // 最高权限（P7）：默认关着
    agent: {
      maxPermissions: false,
      searchPerHour: 6,
      toolsPerHour: 30
    },
    speech: {
      enabled: false,
      muted: false,
      voiceURI: '',
      rate: 1.05,
      pitch: 1.05,
      volume: 1,
      readViewer: false,
      engine: 'system',
      fallbackToSystem: true,
      cloud: { ...BASE_CLOUD }
    },
    account: { loggedIn: false }
  };
  // 按段做浅合并，让测试可以覆盖某一小段配置
  for (const [section, value] of Object.entries(overrides)) {
    base[section] = { ...(base[section] || {}), ...(value || {}) };
  }
  return base;
}

// 主进程 tts:status 会给一份内置音色清单，界面拿它填下拉（这里放一小份够断言的）
const FAKE_VOICES = [
  { voice: 'Cherry', name: '芊悦', desc: '阳光积极、亲切自然的小姐姐' },
  { voice: 'Ethan', name: '晨煦', desc: '阳光温暖有活力（男）' },
  { voice: 'Chelsie', name: '千雪', desc: '二次元虚拟女友' }
];

// 语音模型清单：每个模型自带自己的音色清单（音色不能跨模型混用）
const FAKE_TTS_MODELS = [
  {
    id: 'qwen3-tts-flash',
    label: '千问3-TTS-Flash（默认）',
    price: '约 0.8 元/万字符',
    note: '最快最便宜',
    defaultVoice: 'Cherry',
    voices: FAKE_VOICES
  },
  {
    id: 'cosyvoice-v3-flash',
    label: 'CosyVoice-v3-Flash',
    price: '1 元/万字符',
    note: '支持声音复刻',
    defaultVoice: 'longanyang',
    voices: [{ voice: 'longanyang', name: '龙安洋', desc: '阳光大男孩（男）' }]
  }
];

/**
 * 假配置的合并，对齐主进程 `settings.patch` 的三个行为：
 *   1. 逐层深合并（浅合并会把没提到的字段吃掉，测试里就会看到「换音色把模型弄丢了」这种假故障）
 *   2. 整表替换的键（`mascot.images` / `persona.roles`）——不然测试里「删了又回来」，
 *      而线上是好的；反过来如果线上漏了这条，测试也发现不了
 *   3. 人设活字段同步进当前角色（`syncActiveRole`）——界面靠它做到「切角色不丢改动」
 * 真实实现见 src/main/settings.js（那边有对应的单元测试）。
 */
const FAKE_REPLACE_KEYS = ['mascot.images', 'persona.roles'];

function deepMergeSettings(target, patch, path = '') {
  for (const [key, value] of Object.entries(patch || {})) {
    const childPath = path ? `${path}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (FAKE_REPLACE_KEYS.includes(childPath)) {
        target[key] = JSON.parse(JSON.stringify(value));
      } else {
        target[key] = deepMergeSettings({ ...(target[key] || {}) }, value, childPath);
      }
    } else {
      target[key] = value;
    }
  }
  return target;
}

function syncActiveRoleSettings(data) {
  const persona = data && data.persona;
  if (!persona || !persona.roles || typeof persona.roles !== 'object') return;
  const role = persona.roles[persona.activeRole || 'default'];
  if (!role || typeof role !== 'object') return;
  role.name = persona.botName || role.name || '';
  role.prompt = persona.systemPrompt || '';
  role.style = persona.styleNotes || '';
}

/** 造一个 window.api，记录所有调用并支持事件触发 */
function makeApi(settings, hooks = null) {
  const handlers = {};
  const calls = [];
  // 测试可以改它来模拟云端语音失败：api._tts = { ok: false, message: '...' }
  const ttsBehaviour = { ok: true, voices: FAKE_VOICES, models: FAKE_TTS_MODELS };
  // 知识库的假数据：默认空库，测试可以往里塞条目 / 命中结果
  const knowledgeBehaviour = {
    items: [],
    pending: [],
    hits: [],
    preview: '',
    // 「知识库改动记录」（P6）：测试可以往 edits 里塞记录、用 undoResult 模拟撤销失败
    edits: [],
    undoResult: null,
    // 从文件导入（2026-10-19）：pickImportFiles 返回 picked，importFiles 返回 importResult
    picked: { ok: true, files: [], skipped: [] },
    importResult: { ok: true, count: 0, chars: 0, chunks: 0, droppedChars: 0, problems: [] },
    // 知识库根目录 = 软件目录下的「知识库」，它同时是 DSH 的工作区
    stats: {
      dir: 'D:\\demo\\知识库',
      notesDir: 'D:\\demo\\知识库\\notes',
      inboxDir: 'D:\\demo\\知识库\\inbox',
      pendingDir: 'D:\\demo\\知识库\\pending',
      count: 0,
      enabled: 0,
      pending: 0,
      chars: 0
    },
    // 整理/校对（2026-10-19）：形状和主进程的 reviewSnapshot() 一样，测试随便改
    review: {
      items: [],
      runs: [],
      limit: 5,
      running: '',
      progress: null,
      stats: { count: 0, locked: 0, enabled: 0 },
      maxMode: false
    }
  };
  /** 返回「整理/校对」的当前快照（主进程每次广播的就是它） */
  const reviewSnapshot = () => ({ ...knowledgeBehaviour.review });
  // 「模型想查 / 想记」的假待办：测试可以往 items 里塞条目、或让查询失败（fail）
  const researchBehaviour = { items: [], fail: '' };
  // 整理/校对的假结果：测试可以改 audit / verify / apply / cancel 来模拟各种结局
  const reviewBehaviour = {
    audit: { ok: true, mode: 'audit', notes: 3, locked: 0, found: 2, autoApplied: 0, ms: 15000, items: [] },
    verify: { ok: true, mode: 'verify', checked: 2, searched: 2, unchanged: 1, found: 1, autoApplied: 0, skippedLocked: 0, truncated: 0, problems: [], ms: 12000, items: [] },
    apply: null,
    applyAll: null,
    cancel: { ok: true }
  };
  // 观众记忆的假数据：默认「没在记录」；测试可以改成正在记录 / 改各接口结果
  const memoryBehaviour = {
    state: {
      enabled: false,
      rosterEnabled: true,
      dir: 'D:\\demo\\data\\观众记忆',
      recording: false,
      sessionFile: '',
      startedAt: 0,
      sessionViewers: 0,
      sessionPoints: 0,
      sessionBytes: 0,
      anchor: 0,
      rosterCount: 0,
      pendingLookup: false,
      config: {
        enabled: false,
        rosterEnabled: true,
        batchSize: 20,
        intervalSec: 120,
        maxBatchesPerHour: 12,
        injectChars: 500,
        rosterMax: 2000
      },
      buffered: 0,
      flushing: false,
      batchesThisHour: 0
    },
    flush: { ok: true, lines: 7, added: { viewers: 3, anchor: 1 } },
    open: { ok: true, file: 'D:\\demo\\data\\观众记忆\\老观众.md' },
    folder: 'D:\\demo\\data\\观众记忆',
    clearSession: { ok: true, state: null },
    clearRoster: { ok: true, state: null }
  };
  // DSH 的假数据：默认「环境检测通过」，测试可以改成不通过 / 跑任务失败
  const dshBehaviour = {    detect: {
      ok: true,
      checkedAt: '2026-10-15T02:00:00.000Z',
      node: { command: 'node', version: 'v24.21.0' },
      dsh: { binPath: 'C:\\npx\\dsh\\lib\\bin.js', version: '0.1.5-rc.1', source: 'npx 缓存' },
      checks: [
        { key: 'node', label: '系统 Node', ok: true, detail: 'node → v24.21.0' },
        { key: 'dsh', label: 'DSH 包', ok: true, detail: 'v0.1.5-rc.1（npx 缓存）' },
        { key: 'credentials', label: '调用凭证', ok: true, detail: '用软件里配的 DeepSeek Key' }
      ]
    },
    run: { ok: true, output: '===知识条目===\n标题：测试\n正文：内容', stderr: '', code: 0, ms: 51000, drafts: [{ id: 'p1', title: '测试' }] }
  };
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve(undefined);
  };
  const api = {
    _handlers: handlers,
    _calls: calls,
    _tts: ttsBehaviour,
    _knowledge: knowledgeBehaviour,
    _research: researchBehaviour,
    _dsh: dshBehaviour,
    _review: reviewBehaviour,
    _memory: memoryBehaviour,
    emit(name, payload) {
      for (const fn of handlers[name] || []) fn(payload);
    },
    settings: {
      get: () => Promise.resolve(settings),
      update: (patch) => {
        calls.push({ name: 'settings.update', args: [patch] });
        deepMergeSettings(settings, patch);
        syncActiveRoleSettings(settings);
        // 真实主进程落盘后会往两个窗口广播 settings:changed，面板靠它把
        // 「动态选项」（音色 / 角色下拉）和输入框重新画一遍。这里补上，
        // 不然测试里会看到「改了名字下拉没跟着变」这种线上不存在的问题。
        api.emit('settingsChanged', settings);
        return Promise.resolve(settings);
      },
      reset: () => Promise.resolve(settings),
      openFolder: record('settings.openFolder'),
      defaultPersona: () => Promise.resolve('默认人设')
    },
    overlay: {
      setClickThrough: (ignore) => {
        calls.push({ name: 'overlay.setClickThrough', args: [ignore] });
        return Promise.resolve(!ignore);
      },
      setFocusable: (value) => {
        calls.push({ name: 'overlay.setFocusable', args: [value] });
        return Promise.resolve(Boolean(value));
      },
      hitTest: record('overlay.hitTest'),
      toggle: () => Promise.resolve(true),
      isVisible: () => Promise.resolve(true),
      hide: () => {
        calls.push({ name: 'overlay.hide', args: [] });
        return Promise.resolve(false);
      },
      reload: record('overlay.reload'),
      openDrawer: record('overlay.openDrawer'),
      testMessage: (payload) => {
        calls.push({ name: 'overlay.testMessage', args: [payload] });
        return Promise.resolve(payload);
      }
    },
    danmaku: { start: record('danmaku.start'), stop: record('danmaku.stop'), test: () => Promise.resolve({ ok: true, data: { realRoomId: '1', hostCount: 6, liveStatus: 1, title: 'x' } }) },
    llm: { test: () => Promise.resolve({ ok: true, data: { latencyMs: 100, model: 'deepseek-flash', reply: '连接成功' } }) },
    // 云端语音：默认成功返回一段假 base64 音频；测试改 api._tts 就能模拟失败降级
    tts: {
      synthesize: (text) => {
        calls.push({ name: 'tts.synthesize', args: [text] });
        if (ttsBehaviour.ok) {
          return Promise.resolve({ ok: true, audio: ttsBehaviour.audio || 'RkFLRUFVRElP', mime: 'audio/wav', cached: false });
        }
        return Promise.resolve({
          ok: false,
          message: ttsBehaviour.message || '云端语音返回错误：Invalid API-key',
          code: 'HTTP'
        });
      },
      status: () =>
        Promise.resolve({
          available: true,
          model: (settings.speech && settings.speech.cloud && settings.speech.cloud.model) || 'qwen3-tts-flash',
          modelLabel: '千问3-TTS-Flash（默认）',
          voice: (settings.speech && settings.speech.cloud && settings.speech.cloud.voice) || 'Cherry',
          cached: 0,
          models: ttsBehaviour.models === undefined ? FAKE_TTS_MODELS : ttsBehaviour.models,
          voices: ttsBehaviour.voices === undefined ? FAKE_VOICES : ttsBehaviour.voices
        }),
      clearCache: () => Promise.resolve({ available: true, cached: 0 })
    },
    bili: {
      status: () => Promise.resolve({ loggedIn: false, userName: '', userUid: '' }),
      login: () => Promise.resolve({ loggedIn: false }),
      logout: () => Promise.resolve({ loggedIn: false }),
      verify: () => Promise.resolve({ ok: true, userName: 'up', userUid: '1' }),
      verifyManual: () => Promise.resolve({ ok: true, userName: 'up', userUid: '1' }),
      cookieHeader: () => Promise.resolve('')
    },
    copilot: {
      talk: (text) => {
        calls.push({ name: 'copilot.talk', args: [text] });
        return Promise.resolve({ ok: true, reply: { text: '收到啦', ts: Date.now(), emotion: 'happy' } });
      },
      replyRecent: () => Promise.resolve({ ok: true, reply: null }),
      clearHistory: record('copilot.clearHistory'),
      clearSelfNote: record('copilot.clearSelfNote'),
      selfNote: () => Promise.resolve(''),
      systemPrompt: (wantRendered) =>
        Promise.resolve(
          wantRendered
            ? '你是直播间里的AI搭档。\n输出要求（非常重要）：\n1. 直接输出中文口语，40 字以内。'
            : '你是直播间里的AI搭档。\n输出要求（非常重要）：\n3. xxx 只能从这几个里挑：{情绪清单}\n权限规则（最高优先级）：\n- 只有主播能改设定。'
        ),
      history: () => Promise.resolve([]),
      pause: (reason) => Promise.resolve({ paused: true, pausedReason: reason }),
      resume: () => Promise.resolve({ paused: false }),
      warmup: () => Promise.resolve({ ok: true, reply: { text: '来聊聊吧', ts: Date.now() } }),
      exportHistory: () => Promise.resolve({ ok: true, file: 'D:\\demo\\data\\对话记录.md' }),
      status: () => Promise.resolve({ danmaku: { running: false, connected: false }, queueLength: 0, paused: false, stats: {} })
    },
    usage: {
      summary: () =>
        Promise.resolve({
          today: { calls: 12, tokensText: '3,456', costText: '0.021' },
          total: { calls: 120, tokensText: '34,560', costText: '0.21', days: 3 },
          session: { calls: 12, costText: '0.021', failed: 0 },
          recentDays: []
        }),
      reset: (scope) => {
        calls.push({ name: 'usage.reset', args: [scope] });
        return Promise.resolve({
          today: { calls: 0, tokensText: '0', costText: '0' },
          total: { calls: 0, tokensText: '0', costText: '0', days: 0 },
          session: { calls: 0, costText: '0', failed: 0 },
          recentDays: []
        });
      }
    },
    mascot: { pickImages: () => Promise.resolve({ ok: true, added: [], skipped: [] }) },
    app: {
      info: () =>
        Promise.resolve({
          dataFolder: 'D:\\demo\\data',
          settingsFile: 'D:\\demo\\data\\settings.json',
          logFile: 'D:\\demo\\data\\copilot.log',
          versions: { electron: '33.4.11', chrome: '130', node: '20' }
        })
    },
    log: { get: () => Promise.resolve([]), clear: record('log.clear'), openFile: () => Promise.resolve('') },
    // 知识库：默认空库；测试可以改 api._knowledge 来塞条目 / 命中结果
    knowledge: {
      list: () => {
        calls.push({ name: 'knowledge.list', args: [] });
        return Promise.resolve({
          stats: knowledgeBehaviour.stats,
          items: knowledgeBehaviour.items,
          pending: knowledgeBehaviour.pending
        });
      },
      add: (payload) => {
        calls.push({ name: 'knowledge.add', args: [payload] });
        // 和主进程一样把 tags 规整成数组（界面传上来的是逗号分隔的字符串）
        const tags = Array.isArray(payload && payload.tags)
          ? payload.tags
          : String((payload && payload.tags) || '')
              .split(/[,，、\s]+/)
              .filter(Boolean);
        const entry = { id: 'k-new', enabled: true, source: '手动添加', ...payload, tags };
        knowledgeBehaviour.items = knowledgeBehaviour.items.concat([entry]);
        knowledgeBehaviour.stats = { ...knowledgeBehaviour.stats, count: knowledgeBehaviour.items.length };
        return Promise.resolve({ ok: true, entry, stats: knowledgeBehaviour.stats });
      },
      update: (id, patch) => {
        calls.push({ name: 'knowledge.update', args: [id, patch] });
        knowledgeBehaviour.items = knowledgeBehaviour.items.map((item) =>
          item.id === id ? { ...item, ...patch } : item
        );
        return Promise.resolve({ ok: true, stats: knowledgeBehaviour.stats });
      },
      remove: (id) => {
        calls.push({ name: 'knowledge.remove', args: [id] });
        knowledgeBehaviour.items = knowledgeBehaviour.items.filter((item) => item.id !== id);
        knowledgeBehaviour.stats = { ...knowledgeBehaviour.stats, count: knowledgeBehaviour.items.length };
        return Promise.resolve({ ok: true, stats: knowledgeBehaviour.stats });
      },
      search: (text, options) => {
        calls.push({ name: 'knowledge.search', args: [text, options] });
        return Promise.resolve({ hits: knowledgeBehaviour.hits, preview: knowledgeBehaviour.preview });
      },
      openFolder: () => {
        calls.push({ name: 'knowledge.openFolder', args: [] });
        return Promise.resolve(knowledgeBehaviour.stats.dir);
      },
      approve: (id, patch) => {
        calls.push({ name: 'knowledge.approve', args: [id, patch] });
        knowledgeBehaviour.pending = knowledgeBehaviour.pending.filter((item) => item.id !== id);
        return Promise.resolve({ ok: true, stats: knowledgeBehaviour.stats });
      },
      reject: (id) => {
        calls.push({ name: 'knowledge.reject', args: [id] });
        knowledgeBehaviour.pending = knowledgeBehaviour.pending.filter((item) => item.id !== id);
        return Promise.resolve({ ok: true, stats: knowledgeBehaviour.stats });
      },
      clearPending: () => {
        calls.push({ name: 'knowledge.clearPending', args: [] });
        const removed = knowledgeBehaviour.pending.length;
        knowledgeBehaviour.pending = [];
        return Promise.resolve({
          ok: true,
          removed,
          failed: [],
          stats: knowledgeBehaviour.stats,
          pending: []
        });
      },
      // 「知识库改动记录」（P6）：默认空，测试可以往 knowledgeBehaviour.edits 里塞
      edits: () => {
        calls.push({ name: 'knowledge.edits', args: [] });
        return Promise.resolve({
          edits: knowledgeBehaviour.edits,
          stats: knowledgeBehaviour.stats,
          selfEdit: (settings.knowledge || {}).selfEdit,
          selfEditPerHour: (settings.knowledge || {}).selfEditPerHour
        });
      },
      undoEdit: (editId) => {
        calls.push({ name: 'knowledge.undoEdit', args: [editId] });
        knowledgeBehaviour.edits = knowledgeBehaviour.edits.map((item) =>
          item.id === editId ? { ...item, undone: true } : item
        );
        if (knowledgeBehaviour.undoResult) return Promise.resolve(knowledgeBehaviour.undoResult);
        return Promise.resolve({ ok: true, edits: knowledgeBehaviour.edits, stats: knowledgeBehaviour.stats });
      },
      // 从文件导入（2026-10-19）：默认「没选文件」，测试往 knowledgeBehaviour.picked 里塞
      pickImportFiles: () => {
        calls.push({ name: 'knowledge.pickImportFiles', args: [] });
        return Promise.resolve(knowledgeBehaviour.picked);
      },
      importFiles: () => {
        calls.push({ name: 'knowledge.importFiles', args: [] });
        return Promise.resolve(knowledgeBehaviour.importResult);
      },
      // 整理 / 校对（2026-10-19）：主进程那边是「建议存 .review.json + 跑完推整份状态」，
      // 这里用 knowledgeBehaviour.review 模拟那整份快照，测试可以随意改它
      reviewState: () => {
        calls.push({ name: 'knowledge.reviewState', args: [] });
        return Promise.resolve(reviewSnapshot());
      },
      reviewAudit: () => {
        calls.push({ name: 'knowledge.reviewAudit', args: [] });
        // 测试可以让它挂住（`auditPending`）：验证"跑的时候有提示、跑完自己收掉"
        if (reviewBehaviour.auditPending) return reviewBehaviour.auditPending;
        const result = reviewBehaviour.audit;
        if (result && result.state) knowledgeBehaviour.review = result.state;
        return Promise.resolve(result);
      },
      reviewVerify: (options) => {
        calls.push({ name: 'knowledge.reviewVerify', args: [options] });
        if (reviewBehaviour.verifyPending) return reviewBehaviour.verifyPending;
        const result = reviewBehaviour.verify;
        if (result && result.state) knowledgeBehaviour.review = result.state;
        return Promise.resolve(result);
      },
      reviewApply: (itemId) => {
        calls.push({ name: 'knowledge.reviewApply', args: [itemId] });
        const result = reviewBehaviour.apply || { ok: true, title: itemId };
        return Promise.resolve(result);
      },
      reviewApplyAll: () => {
        calls.push({ name: 'knowledge.reviewApplyAll', args: [] });
        return Promise.resolve(reviewBehaviour.applyAll || { ok: true, applied: 0, results: [] });
      },
      reviewDiscard: (itemId) => {
        calls.push({ name: 'knowledge.reviewDiscard', args: [itemId] });
        knowledgeBehaviour.review = {
          ...knowledgeBehaviour.review,
          items: (knowledgeBehaviour.review.items || []).filter((item) => item.id !== itemId)
        };
        return Promise.resolve({ ok: true, state: reviewSnapshot() });
      },
      reviewClear: () => {
        calls.push({ name: 'knowledge.reviewClear', args: [] });
        knowledgeBehaviour.review = { ...knowledgeBehaviour.review, items: [] };
        return Promise.resolve({ ok: true, state: reviewSnapshot() });
      },
      reviewCancel: () => {
        calls.push({ name: 'knowledge.reviewCancel', args: [] });
        return Promise.resolve(reviewBehaviour.cancel);
      }
    },
    // 观众记忆：默认「没在记录、名册 0 人」，测试可以改 memoryBehaviour.state / 各结果
    memory: {
      state: () => {
        calls.push({ name: 'memory.state', args: [] });
        return Promise.resolve(memoryBehaviour.state);
      },
      flush: () => {
        calls.push({ name: 'memory.flush', args: [] });
        return Promise.resolve(memoryBehaviour.flush);
      },
      openFolder: () => {
        calls.push({ name: 'memory.openFolder', args: [] });
        return Promise.resolve(memoryBehaviour.folder);
      },
      openFile: (kind) => {
        calls.push({ name: 'memory.openFile', args: [kind] });
        return Promise.resolve(memoryBehaviour.open);
      },
      clearSession: () => {
        calls.push({ name: 'memory.clearSession', args: [] });
        return Promise.resolve(memoryBehaviour.clearSession);
      },
      clearRoster: () => {
        calls.push({ name: 'memory.clearRoster', args: [] });
        return Promise.resolve(memoryBehaviour.clearRoster);
      }
    },
    // DSH：默认「检测通过」，测试可以改 api._dsh.detect / .run 来模拟各种情况
    dsh: {
      detect: (options) => {
        calls.push({ name: 'dsh.detect', args: [options] });
        return Promise.resolve(dshBehaviour.detect);
      },
      run: (payload) => {
        calls.push({ name: 'dsh.run', args: [payload] });
        return Promise.resolve(dshBehaviour.run);
      },
      cancel: () => {
        calls.push({ name: 'dsh.cancel', args: [] });
        return Promise.resolve(dshBehaviour.cancel || { ok: true, cancelled: true, busy: true });
      }
    },
    // 「模型想查 / 想记」的待办：默认空队列，测试可以往 researchBehaviour.items 里塞
    research: {
      list: () => {
        calls.push({ name: 'research.list', args: [] });
        return Promise.resolve({ items: researchBehaviour.items, pending: researchBehaviour.items.length });
      },
      run: (id) => {
        calls.push({ name: 'research.run', args: [id] });
        if (researchBehaviour.fail) {
          return Promise.resolve({ ok: false, message: researchBehaviour.fail, items: researchBehaviour.items });
        }
        researchBehaviour.items = researchBehaviour.items.map((item) =>
          item.id === id ? { ...item, status: 'done' } : item
        );
        return Promise.resolve({ ok: true, drafts: [{ id: 'p-9' }], engine: 'builtin', ms: 15200, items: researchBehaviour.items });
      },
      note: (id) => {
        calls.push({ name: 'research.note', args: [id] });
        researchBehaviour.items = researchBehaviour.items.map((item) =>
          item.id === id ? { ...item, status: 'done' } : item
        );
        return Promise.resolve({ ok: true, draft: { id: 'p-8' }, items: researchBehaviour.items });
      },
      ignore: (id) => {
        calls.push({ name: 'research.ignore', args: [id] });
        researchBehaviour.items = researchBehaviour.items.map((item) =>
          item.id === id ? { ...item, status: 'ignored' } : item
        );
        return Promise.resolve({ ok: true, items: researchBehaviour.items });
      },
      remove: (id) => {
        calls.push({ name: 'research.remove', args: [id] });
        researchBehaviour.items = researchBehaviour.items.filter((item) => item.id !== id);
        return Promise.resolve({ ok: true, items: researchBehaviour.items });
      },
      clearFinished: () => {
        calls.push({ name: 'research.clearFinished', args: [] });
        researchBehaviour.items = researchBehaviour.items.filter((item) => item.status === 'pending');
        return Promise.resolve({ removed: 1, items: researchBehaviour.items });
      }
    },
    window: {
      openPanel: record('window.openPanel'),
      quit: () => {
        calls.push({ name: 'window.quit', args: [] });
        return Promise.resolve(true);
      },
      setBounds: (bounds) => {
        calls.push({ name: 'window.setBounds', args: [bounds] });
        // 让假窗口真的按主进程的规矩动起来（position:'keep' 只改大小、不动位置；
        // 'set' 才移动），否则「窗口被挪回旧位置」这类 bug 在测试里根本看不出来。
        if (hooks && typeof hooks.setBounds === 'function') hooks.setBounds(bounds);
        return Promise.resolve(true);
      }
    },
    on: {}
  };
  for (const name of [
    'settingsChanged',
    'status',
    'danmaku',
    'danmakuFiltered',
    'reply',
    'thinking',
    'botState',
    'overlayConfig',
    'overlayRelayout',
    'openDrawer',
    'closeDrawer',
    'error',
    'roomInfo',
    'popularity',
    'log',
    'logHistory',
    'biliLogin',
    'selfNote',
    'paused',
    'usage',
    'research',
    'knowledgeChanged',
    'knowledgeReview',
    'memoryChanged',
    'draftsReady'
  ]) {
    api.on[name] = (fn) => {
      if (!handlers[name]) handlers[name] = [];
      handlers[name].push(fn);
      return () => {};
    };
  }
  return api;
}

// ---------------------------------------------------------------- 悬浮窗测试

console.log('悬浮窗（在迷你 DOM 中真实执行 overlay.js）');

/**
 * 把 setBounds 落到「假窗口」上，规则和主进程的 `window:setBounds` 一致：
 *   · `position:'keep'` → 只改宽高，位置一个字节都不动；
 *   · `position:'set'`  → 按 x/y 移动。
 * 有了它，测试才能发现「改个高度窗口却跳回旧位置」这种事。
 */
function applyMockWindowBounds(win, bounds) {
  const keep = bounds.position === 'keep';
  const width = Math.max(200, Math.min(1600, Math.round(Number(bounds.width) || 460)));
  const height = Math.max(140, Math.min(1800, Math.round(Number(bounds.height) || 620)));
  if (!keep) {
    win.screenX = Math.round(Number(bounds.x) || 0);
    win.screenY = Math.round(Number(bounds.y) || 0);
  }
  win.innerWidth = width;
  win.outerWidth = width;
  win.innerHeight = height;
  win.outerHeight = height;
}

function bootOverlay(settingsOverrides = {}, voiceList = null, options = {}) {
  const dom = createDom('src/renderer/overlay/index.html');
  const settings = baseSettings(settingsOverrides);
  const api = makeApi(settings, {
    setBounds: (bounds) => applyMockWindowBounds(dom.window, bounds)
  });
  const timers = makeTimers();
  const sandbox = {
    window: dom.window,
    document: dom.document,
    console: { log() {}, warn() {}, error: (...a) => console.log('      [renderer error]', ...a) },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: timers.requestAnimationFrame,
    queueMicrotask: timers.queueMicrotask,
    Math,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Error,
    Promise,
    RegExp
  };
  sandbox.window.document = dom.document;
  sandbox.window.setTimeout = timers.setTimeout;
  sandbox.window.clearTimeout = timers.clearTimeout;
  sandbox.window.requestAnimationFrame = timers.requestAnimationFrame;
  // 假语音：默认给一个中文语音 + 一个英文语音，用来验证优先选中文
  const speech = makeFakeSpeech(
    voiceList || [
      { name: 'Microsoft Huihui', lang: 'zh-CN', voiceURI: 'huihui' },
      { name: 'Microsoft David', lang: 'en-US', voiceURI: 'david' }
    ]
  );
  if (!options.disableSpeech) {
    sandbox.window.speechSynthesis = speech.synth;
    sandbox.window.SpeechSynthesisUtterance = speech.FakeUtterance;
  }
  // 假 Audio：云端语音是「拿 base64 造一个 Audio 来播」，测试里要能记录 src
  // 并手动触发 onplay / onended
  const audios = [];
  class FakeAudio {
    constructor(src) {
      this.src = src;
      this.paused = false;
      this.onplay = null;
      this.onended = null;
      this.onerror = null;
      audios.push(this);
    }
    play() {
      this.paused = false;
      if (typeof this.onplay === 'function') this.onplay();
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
    /** 测试用：模拟播放结束 / 播放失败 */
    finish(error) {
      if (error) {
        if (typeof this.onerror === 'function') this.onerror();
      } else if (typeof this.onended === 'function') {
        this.onended();
      }
    }
  }
  sandbox.window.Audio = FakeAudio;
  dom.window.api = api;
  runScripts(sandbox, ['src/shared/emotions.js', 'src/renderer/overlay/overlay.js']);
  return { dom, api, settings, sandbox, timers, speech, audios, ready: () => drain(10) };
}

test('overlay.js 能在迷你 DOM 中初始化，不抛异常', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  if (!api._handlers.reply || !api._handlers.reply.length) throw new Error('没有订阅回复事件');
  if (!dom.nodes.get('mascotImg')) throw new Error('迷你 DOM 缺少 mascotImg');
});

test('初始化时把窗口尺寸和位置报给主进程', async () => {
  const { api, ready } = bootOverlay();
  await ready();
  const calls = api._calls.filter((c) => c.name === 'window.setBounds');
  if (!calls.length) throw new Error('初始化时没有上报窗口位置/尺寸');
  const bounds = calls[calls.length - 1].args[0];
  if (!(bounds.width >= 200 && bounds.width <= 1600)) throw new Error(`宽度不合理: ${bounds.width}`);
  if (!(bounds.height >= 140 && bounds.height <= 1800)) throw new Error(`高度不合理: ${bounds.height}`);
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) throw new Error('位置不是数字');
});














test('回复情绪会切换吉祥物图片', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '哈哈', emotion: 'happy', source: 'danmaku' });
  if (img.src !== 'data:image/png;base64,HAPPY') throw new Error(`应该切到开心图，实际 ${img.src}`);
});

test('认不出来的情绪会退回默认图', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  // 模型偶尔会写个表里没有的情绪词，不能让吉祥物的图空掉
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '...', emotion: '话痨', source: 'danmaku' });
  if (img.src !== 'data:image/png;base64,DEFAULT') throw new Error(`应该退回默认图，实际 ${img.src}`);
});

test('没有图片时显示 emoji 占位', async () => {
  const { dom, ready } = bootOverlay({
    mascot: { images: {}, expressions: {}, fallbackEmoji: '🐱', animation: true }
  });
  await ready();
  const emoji = dom.nodes.get('mascotEmoji');
  const img = dom.nodes.get('mascotImg');
  if (emoji.textContent !== '🐱') {
    throw new Error(
      `emoji 占位不正确: ${JSON.stringify(emoji.textContent)} | img.className=${JSON.stringify(
        img.className
      )} | img.src=${JSON.stringify(img.src)} | 子节点=${emoji.children.length}`
    );
  }
  if (!String(img.className).includes('hidden')) throw new Error('没有图片时应该隐藏 img');
});

test('悬浮窗：吉祥物下面不再有「小助手」那行名字牌（2026-10-19 主播要求去掉）', async () => {
  const overlay = bootOverlay();
  await overlay.ready();
  if (overlay.dom.nodes.get('nameTag')) throw new Error('名字牌的 DOM 还在（#nameTag 应该删掉）');
  const mascot = overlay.dom.nodes.get('mascot');
  if (mascot && String(mascot.textContent || '').includes('小助手')) {
    throw new Error(`吉祥物区域还在显示「小助手」：${mascot.textContent}`);
  }
  // 面板上对应的开关也一起删了：留一个点了没用的 checkbox 比不删更糟
  const panel = bootPanel();
  await panel.ready();
  if (panel.dom.nodes.get('showName')) throw new Error('面板里还留着「显示名字牌」开关');
});

test('快捷设置：勾了「回复气泡不自动消失」，到点也不淡出（2026-10-19 加的）', async () => {
  // 主播要的是：讲一段话的时候让最后那句一直挂在屏幕上，别 22 秒就没了。
  const { dom, api, timers, ready } = bootOverlay({ overlay: { replySeconds: 5, replyPersist: true } });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '这句话要一直留着', emotion: 'happy', source: 'danmaku' });
  // 把 5 秒（连同淡出动画那 400ms）都推过去
  timers.run(6000);
  const node = dom.nodes.get('replyBox').children[0];
  if (!node) throw new Error('回复节点不见了');
  if (node.hidden) throw new Error('开了「不自动消失」却还是藏起来了');
  if (String(node.className).includes('leaving')) throw new Error('还在淡出动画里');
  // 停留秒数那个滑杆这时候没用了：要禁用 + 右边写「常驻」
  if (!dom.nodes.get('replySeconds').disabled) throw new Error('开着的时候「回复停留秒数」应该被禁用');
  if (dom.nodes.get('replySecondsOut').textContent !== '常驻') {
    throw new Error(`滑杆右边应该写「常驻」：${dom.nodes.get('replySecondsOut').textContent}`);
  }
  // 勾选框本身要反映配置
  if (!dom.nodes.get('replyPersist').checked) throw new Error('勾选框没有按配置勾上');
});

test('快捷设置：不开「不自动消失」时，到点照旧淡出（对照）', async () => {
  const { dom, api, timers, ready } = bootOverlay({ overlay: { replySeconds: 5, replyPersist: false } });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '这条到了时间就该消失', emotion: 'happy', source: 'danmaku' });
  timers.run(6000);
  const node = dom.nodes.get('replyBox').children[0];
  if (!node) throw new Error('回复节点不见了');
  if (!node.hidden) throw new Error('没开「不自动消失」时，到点应该淡出藏起来');
  if (dom.nodes.get('replySeconds').disabled) throw new Error('没开的时候滑杆不该被禁用');
});

test('快捷设置：勾上「不自动消失」会立刻撤掉正在排队的隐藏', async () => {
  const { dom, timers, ready, api } = bootOverlay({ overlay: { replySeconds: 5, replyPersist: false } });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '刚说完这句', emotion: 'happy', source: 'danmaku' });
  // 只推到 1 秒，还没到 5 秒：这时勾上，之后再推 6 秒也不该消失
  timers.run(1000);
  const box = dom.nodes.get('replyPersist');
  box.checked = true;
  box.dispatch('change');
  await drain(8);
  timers.run(6000);
  const node = dom.nodes.get('replyBox').children[0];
  if (!node || node.hidden) throw new Error('勾上之后应该把当前这句留住');
});

// ---------------------------------------------------------------- 顶栏的置顶 / 锁定（2026-10-19）

test('顶栏：📌 置顶按钮能切 overlay.alwaysOnTop，状态跟着亮灭', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const pin = dom.nodes.get('pinBtn');
  if (!pin) throw new Error('顶栏没有置顶按钮');
  if (!String(pin.className).includes('active')) throw new Error('默认是置顶的，按钮该亮着');

  api._calls.length = 0;
  pin.dispatch('click');
  await drain(10);
  const saved = api._calls.filter((call) => call.name === 'settings.update').pop();
  if (!saved || !saved.args[0].overlay || saved.args[0].overlay.alwaysOnTop !== false) {
    throw new Error(`点置顶没把配置改成关：${JSON.stringify(saved && saved.args[0])}`);
  }
  // 主进程广播回来后：按钮灭掉、标题变成「点一下重新置顶」的说法
  if (String(dom.nodes.get('pinBtn').className).includes('active')) throw new Error('取消置顶后按钮该灭了');
  if (dom.nodes.get('pinBtn').getAttribute('aria-pressed') !== 'false') {
    throw new Error('aria-pressed 没跟着变');
  }
  // 再点一次又置顶
  api._calls.length = 0;
  dom.nodes.get('pinBtn').dispatch('click');
  await drain(10);
  const again = api._calls.filter((call) => call.name === 'settings.update').pop();
  if (!again || again.args[0].overlay.alwaysOnTop !== true) {
    throw new Error(`再点一次没置顶：${JSON.stringify(again && again.args[0])}`);
  }
});

test('顶栏：🔒 锁定后拖不动、双击也不复位，再点一下解锁', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const card = dom.nodes.get('copilot');
  const header = dom.nodes.get('header');
  if (String(card.className).includes('locked')) throw new Error('默认不该是锁定的');

  api._calls.length = 0;
  dom.nodes.get('lockBtn').dispatch('click');
  await drain(10);
  const saved = api._calls.filter((call) => call.name === 'settings.update').pop();
  if (!saved || saved.args[0].overlay.locked !== true) {
    throw new Error(`锁定没写进配置：${JSON.stringify(saved && saved.args[0])}`);
  }
  if (!String(card.className).includes('locked')) throw new Error('没给卡片加 locked 类（CSS 就关不掉拖动区）');
  if (dom.nodes.get('lockBtn').textContent !== '🔒') {
    throw new Error(`锁定后按钮该显示 🔒：${dom.nodes.get('lockBtn').textContent}`);
  }

  // 锁着的时候按标题栏不该进入「拖动中」的视觉状态
  api._calls.length = 0;
  header.dispatch('mousedown', { button: 0 });
  if (String(card.className).includes('dragging')) throw new Error('锁定了还摆出拖动状态');
  // 双击也不该复位位置（复位会写 posXRatio: 0.76）
  header.dispatch('dblclick');
  await drain(6);
  const resets = api._calls.filter(
    (call) => call.name === 'settings.update' && call.args[0].overlay && call.args[0].overlay.posXRatio !== undefined
  );
  if (resets.length) throw new Error('锁定时双击不该复位窗口位置');

  // 解锁
  api._calls.length = 0;
  dom.nodes.get('lockBtn').dispatch('click');
  await drain(10);
  const unlocked = api._calls.filter((call) => call.name === 'settings.update').pop();
  if (!unlocked || unlocked.args[0].overlay.locked !== false) throw new Error('解锁没写进配置');
  if (String(card.className).includes('locked')) throw new Error('解锁后 locked 类该去掉');
  // 解锁后双击恢复可用
  api._calls.length = 0;
  header.dispatch('dblclick');
  await drain(6);
  const resetAfter = api._calls.filter(
    (call) => call.name === 'settings.update' && call.args[0].overlay && call.args[0].overlay.posXRatio !== undefined
  );
  if (!resetAfter.length) throw new Error('解锁后双击应该能复位窗口位置');
});

test('悬浮窗：回复触发的重新布局只改大小、不动位置（position: keep）', async () => {
  // 主播报的 bug：把悬浮窗拖到屏幕外，来一条回复就被顶回屏幕里。
  // 根因是"自动布局"和"用户挪窗口"走同一条通道，坐标每次都被夹回屏幕。
  const { dom, api, ready } = bootOverlay();
  await ready();

  api._calls.length = 0;
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '这是一条比较长的回复，会让回复区变高一些。', emotion: 'happy', source: 'danmaku' });
  await drain(8);
  const bounds = api._calls.filter((call) => call.name === 'window.setBounds');
  if (!bounds.length) throw new Error('回复之后应该重新上报窗口尺寸');
  const last = bounds[bounds.length - 1].args[0];
  if (last.position !== 'keep') throw new Error(`自动布局必须用 position:'keep'，实际 ${last.position}`);
  if (last.clamp !== 'visible') throw new Error(`自动布局要用 clamp:'visible'（允许留在屏幕外），实际 ${last.clamp}`);

  // 双击复位是「用户明确要求回默认位置」：完整夹进屏幕
  // （注意：复位之后 settings.update 会再触发一次自动布局，那次是 keep，所以不能只看最后一条）
  api._calls.length = 0;
  dom.nodes.get('header').dispatch('dblclick');
  await drain(8);
  const resets = api._calls
    .filter((call) => call.name === 'window.setBounds')
    .map((call) => call.args[0])
    .filter((bounds) => bounds.position === 'set');
  if (!resets.length) throw new Error('双击复位应该真的重新定位窗口（position:set）');
  if (resets[0].clamp !== 'inside') throw new Error(`复位要完整夹进屏幕（clamp:'inside'），实际 ${resets[0].clamp}`);
});

// ---------------------------------------------------------------- 四边 / 四角缩放（2026-10-19）

test('缩放：四条边 + 四个角都有抓手，拖下边会变高并切成固定高度', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const card = dom.nodes.get('copilot');
  const handles = card.querySelectorAll('.resize-handle');
  if (handles.length !== 8) throw new Error(`应该有 8 个缩放抓手，实际 ${handles.length}`);
  const dirs = handles.map((handle) => handle.dataset.dir).sort().join(',');
  if (dirs !== 'e,n,ne,nw,s,se,sw,w') throw new Error(`抓手方向不全：${dirs}`);

  const baseline = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  const south = handles.find((handle) => handle.dataset.dir === 's');
  api._calls.length = 0;
  south.dispatch('mousedown', { button: 0, clientX: 200, clientY: 500 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 620 });
  await drain(6);
  const dragged = api._calls.filter((call) => call.name === 'window.setBounds').pop();
  if (!dragged) throw new Error('拖下边没有上报窗口尺寸');
  const bounds = dragged.args[0];
  if (bounds.height !== baseline.height + 120) {
    throw new Error(`下边拖 120px 高度应该 +120：${baseline.height} → ${bounds.height}`);
  }
  // 拖右下边不会改变窗口位置，所以必须用 'keep'（主进程那边一个字节都不动）。
  // 用 'set' 就要带 x/y，而 x/y 只要有一次是旧值，窗口就会"弹回原位"——这就是那个 bug 的来源。
  if (bounds.position !== 'keep') {
    throw new Error(`拖右下边不该重新定位窗口，实际 position=${bounds.position}`);
  }

  // 松手：把新高度写回配置，并切成「固定高度」（否则下一次布局又按内容改回去）
  api._calls.length = 0;
  dom.document.emit('mouseup', {});
  await drain(10);
  const saved = api._calls.filter((call) => call.name === 'settings.update').pop();
  const patch = saved && saved.args[0].overlay;
  if (!patch || patch.heightMode !== 'fixed') {
    throw new Error(`松手后应该切固定高度：${JSON.stringify(patch)}`);
  }
  if (patch.height !== baseline.height + 120) throw new Error(`高度没写回配置：${patch.height}`);
});

test('缩放：拖左边会改宽度并同步移动位置；只拖左右不改高度模式', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const card = dom.nodes.get('copilot');
  const handles = card.querySelectorAll('.resize-handle');
  const baseline = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  const west = handles.find((handle) => handle.dataset.dir === 'w');
  api._calls.length = 0;
  west.dispatch('mousedown', { button: 0, clientX: 100, clientY: 300 });
  dom.document.emit('mousemove', { clientX: 40, clientY: 300 }); // 往左拖 60px
  await drain(6);
  const bounds = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  if (bounds.width !== baseline.width + 60) throw new Error(`左边拖 60px 宽度应该 +60：${baseline.width} → ${bounds.width}`);
  if (bounds.x !== baseline.x - 60) throw new Error(`拖左边要同步左移：${baseline.x} → ${bounds.x}`);
  if (bounds.height !== baseline.height) throw new Error('只拖左右不该改高度');

  dom.document.emit('mouseup', {});
  await drain(10);
  const patch = (api._calls.filter((call) => call.name === 'settings.update').pop() || { args: [{}] }).args[0].overlay;
  if (!patch) throw new Error('松手后应该保存尺寸');
  if (patch.heightMode) throw new Error('只拖左右不该切成固定高度');
  if (patch.width !== baseline.width + 60) throw new Error(`宽度没写回配置：${patch.width}`);
});

test('缩放：锁定窗口位置时抓手完全失效', async () => {
  const { dom, api, ready } = bootOverlay({ overlay: { locked: true } });
  await ready();
  const handles = dom.nodes.get('copilot').querySelectorAll('.resize-handle');
  const south = handles.find((handle) => handle.dataset.dir === 's');
  api._calls.length = 0;
  south.dispatch('mousedown', { button: 0, clientX: 200, clientY: 500 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 620 });
  await drain(6);
  if (api._calls.some((call) => call.name === 'window.setBounds')) {
    throw new Error('锁定时拖抓手不该改窗口尺寸');
  }
});

test('固定高度模式：回复再长也不改窗口高度（内容在回复区里滚动）', async () => {
  const { dom, api, ready } = bootOverlay({ overlay: { heightMode: 'fixed', height: 700 } });
  await ready();
  const baseline = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  if (baseline.height !== 700) throw new Error(`固定高度应该是 700，实际 ${baseline.height}`);
  api._calls.length = 0;
  api.emit('reply', {
    id: 'r1',
    ts: Date.now(),
    text: '很长的回复'.repeat(30),
    emotion: 'happy',
    source: 'danmaku'
  });
  await drain(8);
  const after = api._calls.filter((call) => call.name === 'window.setBounds').pop();
  if (!after) throw new Error('回复之后应该重新上报尺寸');
  if (after.args[0].height !== 700) {
    throw new Error(`固定高度模式下不该被内容撑高：${after.args[0].height}`);
  }
  // 抽屉里要显示「固定 700px」并给出切回「跟随内容」的按钮
  if (!dom.nodes.get('heightModeHint').textContent.includes('固定')) {
    throw new Error(`高度提示不对：${dom.nodes.get('heightModeHint').textContent}`);
  }
  if (dom.nodes.get('resetHeightMode').hidden) throw new Error('固定模式下应该出现「恢复跟随内容」按钮');
});

/** 读某个节点的内联高度（px）；没有内联高度就返回 0 */
function inlineHeight(node) {
  const raw = String((node && node.style && node.style.height) || '').trim();
  return Math.round(Number(raw.replace(/px$/, '')) || 0);
}

/** 固定高度模式下，对话区应该拿到的高度 = 窗口高 - 顶栏 - 内边距 - 对话区 margin - 吉祥物 - 回复 */
function expectedChatHeight(dom, windowHeight, replyHeight = 0) {
  const mascotHeight = dom.nodes.get('mascot').offsetHeight || 160;
  return Math.round(windowHeight - 34 - 18 - 8 - mascotHeight - replyHeight);
}

test('固定高度模式：窗口拉高多少，对话区就跟着变高多少（回归：拉高但聊天框不动）', async () => {
  // 主播报的 bug：「高度改变时，聊天框并没有随着高度的改变而改变」。
  // 老逻辑里对话区高度只认设置里那个滑杆（overlay.chatHeight），窗口拉多高它都钉着不动，
  // 多出来的空间全空在卡片底部。现在固定高度模式下对话区**吃掉剩下的全部空间**。
  const { dom, api, ready } = bootOverlay({ overlay: { heightMode: 'fixed', height: 700, chatHeight: 240 } });
  await ready();
  const chatPanel = dom.nodes.get('chatPanel');
  const fixedAt700 = inlineHeight(chatPanel);
  if (fixedAt700 !== expectedChatHeight(dom, 700)) {
    throw new Error(`固定 700px 时对话区应该吃掉剩余空间：期望 ${expectedChatHeight(dom, 700)}，实际 ${fixedAt700}`);
  }
  // 关键：对话区不能再等于滑杆那个值，否则说明还是被钉死了
  if (fixedAt700 === 240) throw new Error('对话区还是等于滑杆的值（240），没跟着窗口高度走');

  // 主播从下边往下拖 200px
  const south = dom.nodes.get('copilot').querySelectorAll('.resize-handle').find((h) => h.dataset.dir === 's');
  south.dispatch('mousedown', { button: 0, clientX: 200, clientY: 500 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 700 });
  await drain(6);
  const during = inlineHeight(chatPanel);
  if (during - fixedAt700 !== 200) {
    throw new Error(`拖高 200px 对话区应该也 +200：${fixedAt700} → ${during}`);
  }

  // 松手 → 配置回写 → 布局重算，对话区要稳定在新高度，不能弹回去
  dom.document.emit('mouseup', {});
  await drain(10);
  const savedHeight = api._calls.filter((call) => call.name === 'settings.update').pop().args[0].overlay.height;
  if (savedHeight !== 900) throw new Error(`拖完应该存 900，实际 ${savedHeight}`);
  const settled = inlineHeight(chatPanel);
  if (settled !== expectedChatHeight(dom, 900)) {
    throw new Error(`松手之后对话区应该按 900 算：期望 ${expectedChatHeight(dom, 900)}，实际 ${settled}`);
  }
});

test('固定高度模式：把窗口往小拖，对话区跟着变矮但不小于滑杆下限', async () => {
  const { dom, api, ready } = bootOverlay({ overlay: { heightMode: 'fixed', height: 900, chatHeight: 240 } });
  await ready();
  const chatPanel = dom.nodes.get('chatPanel');
  const north = dom.nodes.get('copilot').querySelectorAll('.resize-handle').find((h) => h.dataset.dir === 'n');
  north.dispatch('mousedown', { button: 0, clientX: 200, clientY: 400 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 700 }); // 往下拖 300 → 高度 -300
  await drain(6);
  const shrunk = inlineHeight(chatPanel);
  if (shrunk !== expectedChatHeight(dom, 600)) {
    throw new Error(`窗口缩到 600 时对话区应该是 ${expectedChatHeight(dom, 600)}，实际 ${shrunk}`);
  }
  // 一直拖到极矮：对话区不许小于 120（滑杆下限），面板不能消失
  dom.document.emit('mousemove', { clientX: 200, clientY: 2000 });
  await drain(6);
  if (inlineHeight(chatPanel) !== 120) {
    throw new Error(`窗口再矮对话区也不该小于 120，实际 ${inlineHeight(chatPanel)}`);
  }
  dom.document.emit('mouseup', {});
  await drain(6);
});

test('对话区高度滑杆：切回「跟随内容」后立刻按滑杆生效', async () => {
  // 固定高度模式下窗口高度由主播拖出来、对话区吃剩余空间，滑杆就"没反应"了。
  // 动滑杆 = 想自己定对话区高度 → 顺手切回「跟随内容」（等同抽屉里那个按钮），滑杆立刻生效。
  const { dom, api, ready, timers } = bootOverlay({ overlay: { heightMode: 'fixed', height: 900, chatHeight: 240 } });
  await ready();
  const chatPanel = dom.nodes.get('chatPanel');
  if (inlineHeight(chatPanel) === 240) throw new Error('前置条件不成立：固定高度模式下滑杆值不该直接生效');

  api._calls.length = 0;
  dom.nodes.get('chatHeight').value = '360';
  dom.nodes.get('chatHeight').dispatch('input', { stopPropagation() {}, preventDefault() {} });
  // 不用等落盘，界面就得跟手（本地先乐观更新）
  if (inlineHeight(chatPanel) !== 360) {
    throw new Error(`滑杆拉到 360 对话区应该立刻变 360，实际 ${inlineHeight(chatPanel)}`);
  }
  // 防抖落盘 → 主进程广播新设置
  timers.run(200);
  await drain(4);
  const overlayPatch = (api._calls.filter((call) => call.name === 'settings.update').pop() || { args: [{}] }).args[0].overlay;
  if (!overlayPatch || overlayPatch.chatHeight !== 360) {
    throw new Error(`滑杆的值没写进配置：${JSON.stringify(overlayPatch)}`);
  }
  if (overlayPatch.heightMode !== 'content') {
    throw new Error(`动滑杆应该切回跟随内容：${JSON.stringify(overlayPatch)}`);
  }
  // 跟随内容模式下窗口高度 = 内容高度（34 + 18 + 8 + 吉祥物 + 回复 0 + 对话区 360）
  const bounds = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  const mascotHeight = dom.nodes.get('mascot').offsetHeight || 160;
  if (bounds.height !== 34 + 18 + 8 + mascotHeight + 360) {
    throw new Error(`窗口高度应该跟着对话区走：期望 ${34 + 18 + 8 + mascotHeight + 360}，实际 ${bounds.height}`);
  }
  if (!dom.nodes.get('heightModeHint').textContent.includes('跟随内容')) {
    throw new Error(`提示应该变回跟随内容：${dom.nodes.get('heightModeHint').textContent}`);
  }
});

test('缩放：拖动过程中窗口尺寸不会被布局改回旧值（回归：拉动时来回闪）', async () => {
  // 主播报的 bug：拉动边框时悬浮窗在原尺寸和拉动尺寸之间闪。
  // 根因：`window.addEventListener('resize', renderLayout)` —— 我们每次 setBounds 都会触发窗口 resize，
  // resize 又触发一次布局，而布局用的是**配置里还没更新**的旧宽高，于是把窗口改回旧尺寸，
  // 再触发 resize……一秒钟来回几十次。
  // 修法：拖动期间（以及松手等配置写回的那一小段）布局**只重排内容、不碰窗口尺寸**。
  const { dom, api, ready } = bootOverlay();
  await ready();
  const handles = dom.nodes.get('copilot').querySelectorAll('.resize-handle');
  const south = handles.find((handle) => handle.dataset.dir === 's');
  const baseline = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];

  api._calls.length = 0;
  south.dispatch('mousedown', { button: 0, clientX: 200, clientY: 500 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 620 });
  await drain(6);
  // 模拟「窗口被我们改大之后，浏览器抛 resize 事件」（真机上每帧都有）
  dom.window.emit?.('resize', {});
  await drain(6);
  const sizes = api._calls
    .filter((call) => call.name === 'window.setBounds')
    .map((call) => call.args[0].height);
  if (!sizes.length) throw new Error('拖动过程中应该上报过新尺寸');
  const stale = sizes.filter((size) => size === baseline.height);
  if (stale.length) {
    throw new Error(`拖动中窗口又被改回旧高度了（会来回闪）：${sizes.join(' → ')}`);
  }
  if (sizes[sizes.length - 1] !== baseline.height + 120) {
    throw new Error(`最后一次应该是拖动尺寸 ${baseline.height + 120}，实际 ${sizes[sizes.length - 1]}`);
  }
});

/** 模拟「主播用顶栏把窗口拖到了别处」：系统拖动只改窗口位置，页面收不到 mousemove */
async function dragWindowByHeader(dom, timers, x, y) {
  dom.nodes.get('header').dispatch('mousedown', { button: 0 });
  dom.window.screenX = x;
  dom.window.screenY = y;
  dom.nodes.get('header').dispatch('mouseup', {});
  timers.run(100); // rememberWindowPosition 的 60ms 兜底
  await drain(6);
}

test('拖过顶栏之后再拖下边改高度：窗口不会跳回原位置（回归：改高度就弹回一开始的位置）', async () => {
  // 主播报的 bug：把悬浮窗拖到别处之后，一改高度窗口就"立刻回到一开始的位置"并闪烁。
  // 根因：拖边缩放拿 `state.windowBounds` 当起点，而它只是**上一次布局时**记下的位置；
  // 拖完顶栏如果没再跑过布局（没来回复、没改设置），它就是老的 → 第一次 mousemove 把窗口摆回去；
  // 窗口一动，鼠标相对窗口的 clientY 又突变 → 高度跟着乱跳，看起来就是闪。
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  await dragWindowByHeader(dom, timers, 120, 90);
  if (dom.window.screenX !== 120 || dom.window.screenY !== 90) {
    throw new Error(`前置：窗口应该已经挪到 120/90，实际 ${dom.window.screenX}/${dom.window.screenY}`);
  }

  const south = dom.nodes.get('copilot').querySelectorAll('.resize-handle').find((h) => h.dataset.dir === 's');
  api._calls.length = 0;
  south.dispatch('mousedown', { button: 0, clientX: 200, clientY: 500, screenX: 320, screenY: 590 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 620, screenX: 320, screenY: 710 });
  await drain(6);
  if (dom.window.screenX !== 120 || dom.window.screenY !== 90) {
    throw new Error(`改高度不该移动窗口：期望还在 120/90，实际 ${dom.window.screenX}/${dom.window.screenY}`);
  }
  const bounds = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  if (bounds.position !== 'keep') {
    throw new Error(`拖下边只改大小，不该重新定位窗口：position=${bounds.position}`);
  }
});

test('顶栏拖动没收到 mouseup 时，改高度也不会弹回原位（真的复现主播那条 bug）', async () => {
  // `-webkit-app-region: drag` 的系统拖动经常吞掉页面里的 mouseup，
  // 于是 rememberWindowPosition 不跑、`state.windowBounds` 也就没机会更新。
  // 旧代码拖边时拿这份**过期**坐标当起点（position:'set' 带旧 x/y）→ 窗口一拖就弹回原位，
  // 窗口一动，鼠标相对窗口的 clientY 又突变 → 高度乱跳 = 主播看到的"闪烁"。
  const { dom, api, ready } = bootOverlay();
  await ready();
  const initial = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];

  // 系统把窗口挪到了 500/300，页面这边一个事件都没收到（只有 screenX/screenY 变了）
  dom.window.screenX = 500;
  dom.window.screenY = 300;

  const south = dom.nodes.get('copilot').querySelectorAll('.resize-handle').find((h) => h.dataset.dir === 's');
  api._calls.length = 0;
  south.dispatch('mousedown', { button: 0, clientX: 200, clientY: 400, screenX: 200, screenY: 640 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 520, screenX: 200, screenY: 760 });
  await drain(6);
  if (dom.window.screenX !== 500 || dom.window.screenY !== 300) {
    throw new Error(
      `改高度把窗口挪走了：期望还在 500/300，实际 ${dom.window.screenX}/${dom.window.screenY}（初始位置 ${initial.x}/${initial.y}）`
    );
  }
});

test('拖左边改宽度：起点是窗口当前位置，位移按屏幕坐标算（回归：位置弹回去 + 拖不动）', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  await dragWindowByHeader(dom, timers, 300, 200);
  const before = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];

  const west = dom.nodes.get('copilot').querySelectorAll('.resize-handle').find((h) => h.dataset.dir === 'w');
  api._calls.length = 0;
  west.dispatch('mousedown', { button: 0, clientX: 100, clientY: 300, screenX: 400, screenY: 500 });
  // 往左拖 60px：窗口跟着鼠标走，所以 clientX 几乎不变（这里干脆给同一个值），
  // 只有屏幕坐标变了 —— 用 clientX 算的话位移会是 0，也就是"拖不动"。
  dom.document.emit('mousemove', { clientX: 100, clientY: 300, screenX: 340, screenY: 500 });
  await drain(6);
  const bounds = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  if (bounds.position !== 'set') throw new Error(`拖左边必须重新定位窗口：position=${bounds.position}`);
  if (bounds.width !== before.width + 60) {
    throw new Error(`拖左边 60px 宽度应该 +60：${before.width} → ${bounds.width}`);
  }
  if (bounds.x !== 300 - 60) {
    throw new Error(`x 应该以窗口当前位置为起点：期望 ${300 - 60}，实际 ${bounds.x}`);
  }
  if (dom.window.screenX !== 240 || dom.window.screenY !== 200) {
    throw new Error(`窗口应该左移到 240、y 保持 200，实际 ${dom.window.screenX}/${dom.window.screenY}`);
  }
});

test('拖上边改高度：窗口跟着鼠标走时也能算对（用屏幕坐标，不用 clientY）', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  await dragWindowByHeader(dom, timers, 300, 260);
  const before = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];

  const north = dom.nodes.get('copilot').querySelectorAll('.resize-handle').find((h) => h.dataset.dir === 'n');
  api._calls.length = 0;
  north.dispatch('mousedown', { button: 0, clientX: 200, clientY: 300, screenX: 500, screenY: 560 });
  dom.document.emit('mousemove', { clientX: 200, clientY: 300, screenX: 500, screenY: 460 }); // 往上 100
  await drain(6);
  const bounds = api._calls.filter((call) => call.name === 'window.setBounds').pop().args[0];
  if (bounds.height !== before.height + 100) {
    throw new Error(`上边往上拖 100px 高度应该 +100：${before.height} → ${bounds.height}`);
  }
  if (bounds.y !== 260 - 100) {
    throw new Error(`y 应该跟着上移：期望 ${260 - 100}，实际 ${bounds.y}`);
  }
  if (dom.window.screenY !== 160 || dom.window.screenX !== 300) {
    throw new Error(`窗口应该上移到 y=160、x 保持 300，实际 ${dom.window.screenX}/${dom.window.screenY}`);
  }
});

test('刚打开悬浮窗时摆「程序启动」，随后自动回到「平常」', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  if (img.src !== 'data:image/png;base64,POP') throw new Error(`刚打开应该摆「程序启动」，实际 ${img.src}`);
  timers.run(900);
  if (img.src !== 'data:image/png;base64,DEFAULT') throw new Error(`蹦完应该回到平常，实际 ${img.src}`);
});

test('弹幕连上时打招呼，且不会一直重复打', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('status', { connected: false });
  api.emit('status', { connected: true, roomId: '1' });
  if (img.src !== 'data:image/png;base64,GREET') throw new Error(`连上应该打招呼，实际 ${img.src}`);
  // 再推几次状态（重连/心跳都会推）不能反复切回打招呼
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '在的', emotion: 'happy', source: 'danmaku' });
  api.emit('status', { connected: true, roomId: '1' });
  if (img.src !== 'data:image/png;base64,HAPPY') throw new Error(`重复推状态不该再切图，实际 ${img.src}`);
});

test('长时间没人说话会睡着', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  timers.run(1000); // 先让「程序启动」落回平常
  if (img.src !== 'data:image/png;base64,DEFAULT') throw new Error('前置条件不对：没回到平常');
  timers.run(120000); // 整整两分钟没人理它
  if (img.src !== 'data:image/png;base64,SLEEP') throw new Error(`两分钟没动静应该睡着，实际 ${img.src}`);
});

test('睡着后来弹幕会醒', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  timers.run(121000);
  if (img.src !== 'data:image/png;base64,SLEEP') throw new Error('前置条件不对：没睡着');
  api.emit('danmaku', { user: '小明', text: '醒醒', ts: Date.now() });
  if (img.src !== 'data:image/png;base64,DEFAULT') throw new Error(`来弹幕应该醒过来，实际 ${img.src}`);
  // 醒了之后重新计时：不到两分钟不该又睡
  timers.run(60000);
  if (img.src !== 'data:image/png;base64,DEFAULT') throw new Error('醒来后计时没重置，一分钟就睡回去了');
});

test('说话时不会睡着', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  timers.run(1000);
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '大家好', emotion: 'talking', source: 'danmaku' });
  timers.run(120000);
  if (img.src === 'data:image/png;base64,SLEEP') throw new Error('正在说话时不该睡着');
});

test('回复里的多个情绪标记会按顺序依次演', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  // 记下每一步切成了哪张图：迷你 DOM 的定时器是「一次跑完」，只能这样验证顺序
  const shots = [];
  let lastSrc = img.src;
  const record = () => {
    if (img.src !== lastSrc) {
      lastSrc = img.src;
      shots.push(String(img.src).replace('data:image/png;base64,', ''));
    }
  };
  api.emit('reply', {
    id: 'r1',
    ts: Date.now(),
    text: '嚯，这也能中？我看你是练过。',
    emotion: 'happy',
    emotions: [
      { key: 'surprised', at: 8 },
      { key: 'happy', at: 16 }
    ],
    source: 'danmaku'
  });
  record();
  if (img.src !== 'data:image/png;base64,SURPRISED') {
    throw new Error(`第一个表情应该是惊讶，实际 ${img.src}`);
  }
  // 迷你 DOM 的定时器是「跑预算内的一批」，直接 run 会把回复停留（20 秒）之类的一起跑掉。
  // 表情这一步的时长在 1.6~4 秒之间，按这个窗口挑一个跑，就能一步步驱动。
  // 注意：回复文本自己那个 1.2 秒的「闪一下」也落在这个窗口里，
  // 所以多驱动一次再断言，保证两步表情都演完。
  const runOneEmotionStep = () => timers.flush(1, (timer) => timer.ms >= 1000 && timer.ms <= 4000);
  runOneEmotionStep();
  record();
  runOneEmotionStep();
  record();
  runOneEmotionStep();
  record();
  const expected = ['SURPRISED', 'HAPPY', 'DEFAULT'];
  if (shots.join(' → ') !== expected.join(' → ')) {
    throw new Error(`表情顺序不对：${shots.join(' → ')}（期望 ${expected.join(' → ')}）`);
  }
});

test('新回复会打断上一轮还没演完的表情', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('reply', {
    id: 'r1',
    ts: Date.now(),
    text: '第一句',
    emotion: 'surprised',
    emotions: [{ key: 'surprised', at: 0 }, { key: 'shy', at: 4 }],
    source: 'danmaku'
  });
  api.emit('reply', {
    id: 'r2',
    ts: Date.now(),
    text: '第二句',
    emotion: 'sad',
    emotions: [{ key: 'sad', at: 0 }],
    source: 'danmaku'
  });
  if (img.src !== 'data:image/png;base64,SAD') {
    throw new Error(`应该直接演新回复的表情，实际 ${img.src}`);
  }
  // 旧队列必须清掉：等下去也不能冒出害羞
  timers.run(9000);
  if (img.src === 'data:image/png;base64,SHY') {
    throw new Error('被打断的旧表情又演出来了');
  }
});

test('开始思考时会打断正在演的表情', async () => {
  const { dom, api, ready, timers } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('reply', {
    id: 'r1',
    ts: Date.now(),
    text: '第一句',
    emotion: 'happy',
    emotions: [{ key: 'happy', at: 0 }, { key: 'shy', at: 4 }],
    source: 'danmaku'
  });
  api.emit('thinking', true);
  if (img.src !== 'data:image/png;base64,THINKING') {
    throw new Error(`思考时应该挂思考脸，实际 ${img.src}`);
  }
  timers.run(9000);
  if (img.src === 'data:image/png;base64,SHY') {
    throw new Error('思考打断了旧表情队列，但它又演出来了');
  }
});

test('回复里没有情绪标记时表情回到平常', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '嗯', emotion: 'happy', emotions: [], source: 'danmaku' });
  if (img.src !== 'data:image/png;base64,DEFAULT') throw new Error(`应该回平常，实际 ${img.src}`);
});

test('观众弹幕命中触发词就立刻切表情（不用等 AI 回复）', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('danmaku', { user: '小明', text: '今天主播好可爱啊', ts: Date.now() });
  if (img.src !== 'data:image/png;base64,SHY') {
    throw new Error(`「可爱」应该触发害羞，实际 ${img.src}`);
  }
  api.emit('danmaku', { user: '小红', text: '哈哈哈哈哈', ts: Date.now() });
  if (img.src !== 'data:image/png;base64,HAPPY') {
    throw new Error(`「哈哈」应该触发开心，实际 ${img.src}`);
  }
  // 没命中触发词的弹幕不改表情
  api.emit('danmaku', { user: '小刚', text: '这是普通的一句话', ts: Date.now() });
  if (img.src !== 'data:image/png;base64,HAPPY') {
    throw new Error(`没命中触发词不该换表情，实际 ${img.src}`);
  }
});

test('触发词可以在配置里改：配过的用配置的，没配的用默认', async () => {
  const { dom, api, ready } = bootOverlay({
    mascot: {
      images: {
        '默认.png': 'data:image/png;base64,DEFAULT',
        '开心.png': 'data:image/png;base64,HAPPY',
        '睡觉.png': 'data:image/png;base64,SLEEP'
      },
      expressions: { idle: '默认.png', happy: '开心.png', sleep: '睡觉.png' },
      // 开心改成认「草」；睡觉显式关掉
      triggers: { happy: ['草'], sleep: [] },
      fallbackEmoji: '🦊',
      animation: true
    }
  });
  await ready();
  const img = dom.nodes.get('mascotImg');
  api.emit('danmaku', { user: '小明', text: '草', ts: Date.now() });
  if (img.src !== 'data:image/png;base64,HAPPY') throw new Error(`「草」应该触发开心，实际 ${img.src}`);
  // 原来的默认词被替换掉了
  api.emit('danmaku', { user: '小明', text: '哈哈哈哈', ts: Date.now() });
  if (img.src !== 'data:image/png;base64,HAPPY') throw new Error('前置状态被改动了');
  // 睡觉被显式关掉：发「晚安」不该睡（此刻应该还停在开心）
  api.emit('danmaku', { user: '小明', text: '晚安', ts: Date.now() });
  if (img.src === 'data:image/png;base64,SLEEP') throw new Error('睡觉的触发词被配成空数组，不该触发');
});

test('鼠标移动不会切换穿透（否则按钮会点不动）', async () => {
  // 这是一个真实踩过的 bug：曾经按鼠标位置切换穿透，
  // 结果鼠标移到窗口顶部（⚙ ✕ 就在那一行）时整个窗口被设成忽略鼠标事件，按钮点不动。
  // 现在穿透只由主进程按设置决定，界面任何时候都不应该去改它。
  const { sandbox, api, ready } = bootOverlay();
  await ready();
  api._calls.length = 0;
  for (const point of [
    { clientX: 0, clientY: 0 },
    { clientX: 5, clientY: 2 },
    { clientX: 300, clientY: 1 },
    { clientX: 200, clientY: 200 },
    { clientX: 459, clientY: 619 }
  ]) {
    sandbox.document.emit('mousemove', point);
  }
  await drain(3);
  const calls = api._calls.filter((c) => c.name === 'overlay.setClickThrough');
  if (calls.length) {
    throw new Error(`界面不应该改穿透状态，实际调用: ${JSON.stringify(calls.map((c) => c.args[0]))}`);
  }
});

test('顶部按钮在窗口最边缘也能点到（回归测试）', async () => {
  const { dom, api, sandbox, ready } = bootOverlay();
  await ready();
  api._calls.length = 0;
  // 模拟鼠标先移动到最上面一行（按钮所在位置），再点击
  sandbox.document.emit('mousemove', { clientX: 420, clientY: 8 });
  await drain(2);
  if (api._calls.some((c) => c.name === 'overlay.setClickThrough' && c.args[0] === true)) {
    throw new Error('鼠标移到顶部按钮位置时不应该把窗口设成穿透');
  }
  dom.nodes.get('gearBtn').dispatch('click');
  await drain(2);
  if (!String(dom.nodes.get('drawer').className).includes('open')) {
    throw new Error('点设置按钮应该能展开快捷设置');
  }
  dom.nodes.get('closeBtn').dispatch('click');
  await drain(2);
  if (!api._calls.some((c) => c.name === 'overlay.hide')) {
    throw new Error('点关闭按钮应该能关掉悬浮窗');
  }
});

test('思考状态会加上 thinking 类', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const copilot = dom.nodes.get('copilot');
  api.emit('thinking', true);
  if (!copilot.classList.contains('thinking')) throw new Error('thinking 类没有加上');
  api.emit('thinking', false);
  if (copilot.classList.contains('thinking')) throw new Error('thinking 类没有移除');
});

test('顶部标题栏显示搭档名字，拖动区已接线', async () => {
  const { dom, ready } = bootOverlay();
  await ready();
  const title = dom.nodes.get('headerTitle');
  if (!title) throw new Error('缺少标题栏文字');
  if (title.textContent !== '小助手') throw new Error(`标题栏应显示搭档名字，实际「${title.textContent}」`);
  const header = dom.nodes.get('header');
  if (!header) throw new Error('缺少拖动栏');
  // 拖动由系统接管（-webkit-app-region: drag），这里确认按下/松开都有处理
  header.dispatch('mousedown', { button: 0 });
  header.dispatch('mouseup', {});
  if (!String(dom.nodes.get('copilot').className).includes('copilot')) {
    throw new Error('拖动后卡片结构异常');
  }
});

// 说明：这里没有「最多同时显示几条回复」这类测试了。
// 回复文本只有一块，不排队，新回复直接覆盖旧的（见上面那批测试）。

test('语音朗读：开启后会把回复念出来', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: '', rate: 1.05, pitch: 1.05, volume: 1, readViewer: false }
  });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '大家好呀', emotion: 'happy', source: 'danmaku' });
  if (speech.record.spoken.length !== 1) throw new Error(`应该朗读 1 条，实际 ${speech.record.spoken.length} 条`);
  if (speech.record.spoken[0].text !== '大家好呀') throw new Error(`朗读内容不对: ${speech.record.spoken[0].text}`);
});

test('语音朗读：关闭时完全不读', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { enabled: false, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: false }
  });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '不该被念', emotion: 'happy', source: 'danmaku' });
  if (speech.record.spoken.length !== 0) throw new Error('关闭后不应朗读');
});

test('语音朗读：静音后不读，取消静音后恢复', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { enabled: true, muted: true, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: false }
  });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '静音中', emotion: 'happy', source: 'danmaku' });
  if (speech.record.spoken.length !== 0) throw new Error('静音时不应朗读');
  if (speech.record.cancelled === 0) throw new Error('静音时应停止正在朗读的内容');
});

test('语音朗读：优先选择中文语音', async () => {
  const { api, speech, ready } = bootOverlay(
    { speech: { enabled: true, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: false } },
    [
      { name: 'Microsoft David', lang: 'en-US', voiceURI: 'david' },
      { name: 'Microsoft Huihui', lang: 'zh-CN', voiceURI: 'huihui' }
    ]
  );
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '中文优先', emotion: 'happy', source: 'danmaku' });
  const used = speech.record.spoken[0].voice;
  if (!used || used.voiceURI !== 'huihui') throw new Error(`应该选中文语音，实际 ${used && used.voiceURI}`);
});

test('语音朗读：指定语音时按指定的来', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: 'david', rate: 1, pitch: 1, volume: 1, readViewer: false }
  });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '用英文音色', emotion: 'happy', source: 'danmaku' });
  const used = speech.record.spoken[0].voice;
  if (!used || used.voiceURI !== 'david') throw new Error(`应该用指定的语音，实际 ${used && used.voiceURI}`);
});

test('语音朗读：语速音调音量会按设置生效', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: '', rate: 1.6, pitch: 0.8, volume: 0.5, readViewer: false }
  });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '参数测试', emotion: 'happy', source: 'danmaku' });
  const utterance = speech.record.spoken[0];
  if (utterance.rate !== 1.6) throw new Error(`语速不对: ${utterance.rate}`);
  if (utterance.pitch !== 0.8) throw new Error(`音调不对: ${utterance.pitch}`);
  if (utterance.volume !== 0.5) throw new Error(`音量不对: ${utterance.volume}`);
});

test('语音朗读：连观众原话时，念完原话停 0.5 秒再念回复', async () => {
  const { api, speech, ready, timers } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: true }
  });
  await ready();
  speech.record.spoken.length = 0;
  api.emit('danmaku', { user: '小明', text: '你好', ts: Date.now() });
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '你好呀', emotion: 'happy', source: 'danmaku' });

  // 第一步：只念观众原话，不把回复也念出来
  if (speech.record.spoken.length !== 1) {
    throw new Error(`应该先只念观众原话，实际念了 ${speech.record.spoken.length} 条`);
  }
  if (speech.record.spoken[0].text !== '小明说：你好') {
    throw new Error(`第一条应该只念观众原话: ${speech.record.spoken[0].text}`);
  }

  // 第二步：原话念完 → 等 0.5 秒（差 1 毫秒都不该念）
  speech.finishLast();
  // speak() 现在是异步的（云端引擎要 await 音频），让它把这轮的续接排完再驱动定时器
  await ready();
  timers.run(499);
  if (speech.record.spoken.length !== 1) {
    throw new Error(`不到 0.5 秒就念回复了，间隔没生效`);
  }

  // 第三步：到点才念回复
  timers.flush();
  await ready();
  if (speech.record.spoken.length !== 2) {
    throw new Error(`0.5 秒后应该念回复，实际念了 ${speech.record.spoken.length} 条`);
  }
  if (speech.record.spoken[1].text !== '你好呀') {
    throw new Error(`第二条应该是回复正文: ${speech.record.spoken[1].text}`);
  }
});

test('语音朗读：没开「连观众原话一起念」时，不念原话也不等待', async () => {
  const { api, speech, ready, timers } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: false }
  });
  await ready();
  speech.record.spoken.length = 0;
  api.emit('danmaku', { user: '小明', text: '你好', ts: Date.now() });
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '你好呀', emotion: 'happy', source: 'danmaku' });
  // 回复要立刻念出来，不能因为「先念原话」那条路径而多等这半秒
  if (speech.record.spoken.length !== 1) {
    throw new Error(`应该直接念回复，实际念了 ${speech.record.spoken.length} 条`);
  }
  if (speech.record.spoken[0].text !== '你好呀') {
    throw new Error(`念的内容不对: ${speech.record.spoken[0].text}`);
  }
  timers.flush();
  if (speech.record.spoken.length !== 1) throw new Error('没开原话朗读时不该再多念一条');
});

test('语音朗读：等停顿的期间被打断，旧回复不会突然念出来', async () => {
  const { api, speech, ready, timers } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: true }
  });
  await ready();
  speech.record.spoken.length = 0;
  api.emit('danmaku', { user: '小明', text: '第一句', ts: Date.now() });
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '回复一', emotion: 'happy', source: 'danmaku' });
  speech.finishLast(); // 原话念完，进入停顿等待
  await ready();

  // 停顿还没到就来下一条回复：旧的那次朗读必须作废
  api.emit('danmaku', { user: '小红', text: '第二句', ts: Date.now() });
  api.emit('reply', { id: 'r2', ts: Date.now(), text: '回复二', emotion: 'happy', source: 'danmaku' });
  speech.finishLast(); // 新的原话念完，也进入它自己的停顿等待
  await ready();
  timers.flush();
  await ready();

  const texts = speech.record.spoken.map((item) => item.text);
  if (texts.includes('回复一')) {
    throw new Error(`被打断的那次朗读不该把旧回复念出来: ${texts.join(' / ')}`);
  }
  // 最后念的必须是新的这一条链（旧的原话已经被 cancel 掉了）
  if (speech.record.spoken[speech.record.spoken.length - 1].text !== '回复二') {
    throw new Error(`最后念的应该是新回复: ${texts.join(' / ')}`);
  }
  // 旧的那个停顿计时器如果没清掉，这里还会再冒出一条旧回复
  const before = speech.record.spoken.length;
  timers.flush();
  if (speech.record.spoken.length !== before) {
    const now = speech.record.spoken.map((item) => item.text).join(' / ');
    throw new Error(`旧回复的等待计时器没被清掉: ${now}`);
  }
});

test('语音朗读：新回复会打断正在念的内容', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { enabled: true, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: false }
  });
  await ready();
  // 开启瞬间会先念一句确认语，先清掉这笔记录
  speech.record.spoken.length = 0;
  speech.record.cancelled = 0;
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '第一句', emotion: 'happy', source: 'danmaku' });
  api.emit('reply', { id: 'r2', ts: Date.now(), text: '第二句', emotion: 'happy', source: 'danmaku' });
  if (speech.record.spoken.length !== 2) throw new Error(`两条都应该朗读，实际 ${speech.record.spoken.length}`);
  // 每次朗读前会 cancel 掉上一条
  if (speech.record.cancelled < 2) throw new Error(`新回复应先取消旧朗读，cancel 次数 ${speech.record.cancelled}`);
  if (speech.record.spoken[1].text !== '第二句') throw new Error('最后念的应该是新回复');
});

test('语音不可用时不会报错，界面仍然正常', async () => {
  const { dom, api, ready } = bootOverlay(
    { speech: { enabled: true, muted: false, voiceURI: '', rate: 1, pitch: 1, volume: 1, readViewer: false } },
    null,
    { disableSpeech: true }
  );
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '没有语音也要能显示', emotion: 'happy', source: 'danmaku' });
  const replyBox = dom.nodes.get('replyBox');
  if (!replyBox || replyBox.children.length !== 1) {
    throw new Error('语音不可用时回复文本仍应正常显示');
  }
  if (!dom.nodes.get('speechEnabled').disabled) throw new Error('语音不可用时开关应置灰');
});

// ---------------------------------------------------------------- 悬浮窗对话区

test('对话区默认显示，并给出空状态提示', async () => {
  const { dom, ready } = bootOverlay();
  await ready();
  const copilot = dom.nodes.get('copilot');
  if (!String(copilot.className).includes('chat-on')) throw new Error('对话区应默认开启（chat-on 类没加上）');
  const log = dom.nodes.get('chatLog');
  const empty = log.children.find((c) => c.className === 'chat-empty');
  if (!empty) throw new Error('空状态提示没有显示');
});

/** 在节点子树里按类名找元素（结构多包了一层也不会写死） */
function findIn(node, className) {
  const hits = [];
  const walk = (current) => {
    for (const child of current.children || []) {
      if (String(child.className || '').split(/\s+/).includes(className)) hits.push(child);
      walk(child);
    }
  };
  walk(node);
  return hits;
}

test('收到的弹幕会出现在对话区', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  api.emit('danmaku', { id: 'dm1', user: '菲***', text: '补点糖分', ts: Date.now() });
  const log = dom.nodes.get('chatLog');
  const item = log.children.find((c) => c.className === 'chat-item viewer');
  if (!item) throw new Error('弹幕没有进入对话区');
  const who = findIn(item, 'chat-who')[0];
  const text = findIn(item, 'chat-text')[0];
  if (!who || who.textContent !== '菲***') throw new Error(`观众名不对: ${who && who.textContent}`);
  if (!text || text.textContent !== '补点糖分') throw new Error(`内容不对: ${text && text.textContent}`);
});

test('默认不在对话区显示弹幕 id / uid（要排查时才打开）', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  api.emit('danmaku', { id: '1791644566', user: '菲尼尔--缀', text: 'ciallo', ts: Date.now(), uid: 1791644087 });
  const item = dom.nodes.get('chatLog').children.find((c) => c.className === 'chat-item viewer');
  if (!item) throw new Error('弹幕没有进入对话区');
  if (findIn(item, 'chat-id').length) throw new Error('默认不该显示 id 标签');
});

test('开启「显示 id / uid」后，对话区里能对照弹幕记录文件', async () => {
  const { dom, api, ready } = bootOverlay({ overlay: { chatShowIds: true } });
  await ready();
  api.emit('danmaku', { id: '1791644566', user: '菲尼尔--缀', text: 'ciallo', ts: Date.now(), uid: 1791644087 });
  const item = dom.nodes.get('chatLog').children.find((c) => c.className === 'chat-item viewer');
  const idNode = findIn(item, 'chat-id')[0];
  if (!idNode) throw new Error('开了开关却没有显示 id');
  if (!idNode.textContent.includes('1791644566')) throw new Error(`id 不对：${idNode.textContent}`);
  if (!idNode.textContent.includes('1791644087')) throw new Error(`uid 不对：${idNode.textContent}`);
  // 正文必须是干净的，不能把 id 混进正文
  const text = findIn(item, 'chat-text')[0];
  if (text.textContent !== 'ciallo') throw new Error(`正文被污染了：${text.textContent}`);
});

test('弹幕没有 id 时不显示 id 那行（不留空标签）', async () => {
  const { dom, api, ready } = bootOverlay({ overlay: { chatShowIds: true } });
  await ready();
  api.emit('danmaku', { id: '', user: '甲', text: '没有 id 的弹幕', ts: Date.now() });
  const item = dom.nodes.get('chatLog').children.find((c) => c.className === 'chat-item viewer');
  const idNode = findIn(item, 'chat-id')[0];
  if (idNode) throw new Error(`不该有 id 标签，实际内容：${idNode.textContent}`);
});

test('AI 回复不带 id 标签（只有观众弹幕才显示 id）', async () => {
  const { dom, api, ready } = bootOverlay({ overlay: { chatShowIds: true } });
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '好嘞', emotion: 'happy', source: 'danmaku' });
  const item = dom.nodes.get('chatLog').children.find((c) => c.className === 'chat-item ai');
  const idNode = findIn(item, 'chat-id')[0];
  if (idNode) throw new Error(`AI 回复不该显示 id，实际：${idNode.textContent}`);
});

test('同一条弹幕不会重复出现', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const event = { id: 'dm1', user: '甲', text: '你好', ts: Date.now() };
  api.emit('danmaku', event);
  api.emit('danmaku', event);
  const items = dom.nodes.get('chatLog').children.filter((c) => c.className === 'chat-item viewer');
  if (items.length !== 1) throw new Error(`应该只出现 1 条，实际 ${items.length} 条`);
});


test('在悬浮窗输入文字并回车，会以「我」的身份发出', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const input = dom.nodes.get('chatInput');
  input.value = '帮我聊聊刚才那个话题';
  input.dispatch('keydown', {
    key: 'Enter',
    shiftKey: false,
    isComposing: false,
    preventDefault() {},
    stopPropagation() {}
  });
  await drain(6);

  const talked = api._calls.filter((c) => c.name === 'copilot.talk');
  if (talked.length !== 1) throw new Error(`应该调用 copilot.talk 一次，实际 ${talked.length} 次`);
  if (talked[0].args[0] !== '帮我聊聊刚才那个话题') throw new Error(`传出去的文本不对: ${talked[0].args[0]}`);

  const mine = dom.nodes.get('chatLog').children.find((c) => c.className === 'chat-item me');
  if (!mine) throw new Error('自己的话没有显示在对话区');
  const who = findIn(mine, 'chat-who')[0];
  if (!who || who.textContent !== '我') throw new Error(`说话人应该是「我」: ${who && who.textContent}`);
  if (input.value !== '') throw new Error('发送后输入框应该清空');
});

test('Shift+Enter 不发送（换行）', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const input = dom.nodes.get('chatInput');
  input.value = '换行用';
  let prevented = false;
  input.dispatch('keydown', {
    key: 'Enter',
    shiftKey: true,
    isComposing: false,
    preventDefault() {
      prevented = true;
    },
    stopPropagation() {}
  });
  await drain(3);
  if (api._calls.some((c) => c.name === 'copilot.talk')) throw new Error('Shift+Enter 不应该发送');
  if (prevented) throw new Error('Shift+Enter 不应该阻止默认换行');
});

test('输入中文拼音时（isComposing）回车不发送', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const input = dom.nodes.get('chatInput');
  input.value = 'ni hao';
  input.dispatch('keydown', {
    key: 'Enter',
    shiftKey: false,
    isComposing: true,
    preventDefault() {},
    stopPropagation() {}
  });
  await drain(3);
  if (api._calls.some((c) => c.name === 'copilot.talk')) throw new Error('输入法组字期间不应该发送');
});

test('点「发送」按钮也能发出去', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  dom.nodes.get('chatInput').value = '按钮发送';
  dom.nodes.get('chatSend').dispatch('click');
  await drain(6);
  const talked = api._calls.filter((c) => c.name === 'copilot.talk');
  if (talked.length !== 1 || talked[0].args[0] !== '按钮发送') throw new Error('按钮发送失败');
});

test('空内容不会发送', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  dom.nodes.get('chatInput').value = '   ';
  dom.nodes.get('chatSend').dispatch('click');
  await drain(4);
  if (api._calls.some((c) => c.name === 'copilot.talk')) throw new Error('空内容不应该发送');
});

// 说明：曾经有一条「鼠标进出对话区会切换窗口可聚焦」的测试。
// 那个行为本身就是闪动 bug 的来源（focus/blur 反复切换），已经删掉，
// 现在由「鼠标进出与聚焦不会反复抢焦点」这条测试守着相反的行为。

test('关掉对话区后不再接收内容，也不显示面板', async () => {
  const { dom, api, ready } = bootOverlay({
    overlay: { ...baseSettings().overlay, chatEnabled: false }
  });
  await ready();
  const copilot = dom.nodes.get('copilot');
  if (String(copilot.className).includes('chat-on')) throw new Error('关掉后不应有 chat-on 类');
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '不该进对话区', emotion: 'happy', source: 'danmaku' });
  const items = dom.nodes.get('chatLog').children.filter((c) => String(c.className).includes('chat-item'));
  if (items.length !== 0) throw new Error('关掉对话区后不应该再记录内容');
});

test('可以只关弹幕显示，AI 回复仍然记录', async () => {
  const { dom, api, ready } = bootOverlay({
    overlay: { ...baseSettings().overlay, chatShowDanmaku: false }
  });
  await ready();
  api.emit('danmaku', { id: 'dm1', user: '甲', text: '不该显示', ts: Date.now() });
  api.emit('reply', { id: 'r1', ts: Date.now(), text: 'AI 的话要显示', emotion: 'happy', source: 'danmaku' });
  const log = dom.nodes.get('chatLog');
  const viewers = log.children.filter((c) => c.className === 'chat-item viewer');
  const ais = log.children.filter((c) => c.className === 'chat-item ai');
  if (viewers.length !== 0) throw new Error('弹幕应该被隐藏');
  if (ais.length !== 1) throw new Error('AI 回复应该照常显示');
});

test('「清空」按钮会清掉对话记录', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  api.emit('danmaku', { id: 'dm1', user: '甲', text: '你好', ts: Date.now() });
  if (!dom.nodes.get('chatLog').children.length) throw new Error('准备数据失败');
  dom.nodes.get('chatClear').dispatch('click');
  const log = dom.nodes.get('chatLog');
  // chat-empty 里也含 "chat-item" 子串，这里按类名精确判断
  const items = log.children.filter((c) =>
    String(c.className)
      .split(/\s+/)
      .some((name) => name === 'chat-item')
  );
  if (items.length !== 0) {
    const detail = log.children.map((c) => `[${c.className}] ${c.textContent}`).join(' / ');
    throw new Error(`清空后不应该还有记录，实际 ${items.length} 条 → ${detail}`);
  }
});

test('超过上限时只保留最近的记录', async () => {
  const { dom, api, ready } = bootOverlay({
    overlay: { ...baseSettings().overlay, chatMaxItems: 12 }
  });
  await ready();
  for (let i = 0; i < 30; i += 1) {
    api.emit('danmaku', { id: `dm${i}`, user: '甲', text: `第${i}条`, ts: Date.now() });
  }
  const items = dom.nodes.get('chatLog').children.filter((c) => String(c.className).includes('chat-item'));
  if (items.length > 12) throw new Error(`最多保留 12 条，实际 ${items.length} 条`);
  const texts = items.map((c) => c.textContent).join('|');
  if (texts.includes('第0条')) throw new Error('最旧的记录应该被移除');
});

test('启动时会把已有对话记录拉回来显示', async () => {
  const { dom, ready, api } = bootOverlay();
  // 在 init 之前替换 history 返回值
  api.copilot.history = () =>
    Promise.resolve([
      { role: 'user', who: '菲***', text: '补点糖分' },
      { role: 'assistant', who: '小助手', text: '好嘞' }
    ]);
  await ready();
  const log = dom.nodes.get('chatLog');
  const items = log.children.filter((c) => String(c.className).includes('chat-item'));
  if (items.length < 2) throw new Error(`历史记录应该被拉回来，实际 ${items.length} 条`);
});

// ---------------------------------------------------------------- 对话区滚动

/** 给迷你 DOM 的对话区设定真实的滚动尺寸 */
function setScrollBox(dom, { scrollHeight, clientHeight, scrollTop, fromUser = true }) {
  const log = dom.nodes.get('chatLog');
  log.scrollHeight = scrollHeight;
  log.clientHeight = clientHeight;
  log.scrollTop = scrollTop;
  // 真实浏览器里用户滚动一定会派发 scroll 事件，程序靠它判断「用户还想不想跟随」
  if (fromUser) log.dispatch('scroll');
  return log;
}

test('贴在底部时，新消息会自动滚到最下面', async () => {
  // 真实踩过的 bug：判断「在不在底部」是在把新消息加进去「之后」做的，
  // 读到的是重排前的旧值，条件永远不成立 → 新消息不会自动往下滚。
  const { dom, api, ready } = bootOverlay();
  await ready();
  const log = setScrollBox(dom, { scrollHeight: 400, clientHeight: 200, scrollTop: 200 });

  api.emit('danmaku', { id: 'dm1', user: '甲', text: '第一条', ts: Date.now() });
  log.scrollHeight = 460; // 新消息让内容变高了
  api.emit('danmaku', { id: 'dm2', user: '乙', text: '第二条', ts: Date.now() });

  if (log.scrollTop !== log.scrollHeight) {
    throw new Error(`应该滚到底（${log.scrollHeight}），实际 ${log.scrollTop}`);
  }
});

test('用户翻旧记录时，新消息不会把视线拽回底部', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const log = setScrollBox(dom, { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });

  api.emit('danmaku', { id: 'dm1', user: '甲', text: '新消息', ts: Date.now() });

  if (log.scrollTop !== 0) throw new Error(`不该动滚动位置，实际 ${log.scrollTop}`);
  const jump = dom.nodes.get('chatJump');
  if (!jump.classList.contains('show')) throw new Error('翻旧记录时应该提示「有新消息」');
  if (!jump.textContent.includes('1')) throw new Error(`提示应该带条数，实际「${jump.textContent}」`);
});

test('点「有新消息」会跳回最新并收起提示', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const log = setScrollBox(dom, { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });
  api.emit('danmaku', { id: 'dm1', user: '甲', text: '一', ts: Date.now() });
  api.emit('danmaku', { id: 'dm2', user: '乙', text: '二', ts: Date.now() });
  log.scrollHeight = 700;

  dom.nodes.get('chatJump').dispatch('click');

  if (log.scrollTop !== log.scrollHeight) throw new Error('点了之后应该跳到最下面');
  const jump = dom.nodes.get('chatJump');
  if (jump.classList.contains('show')) throw new Error('跳过去之后提示应该收起');
});

test('自己滚回底部后，后续消息继续自动跟随', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const log = setScrollBox(dom, { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });
  api.emit('danmaku', { id: 'dm1', user: '甲', text: '翻记录时来的', ts: Date.now() });
  if (log.scrollTop !== 0) throw new Error('前置条件不成立：不该滚动');

  // 用户自己滚到底（会派发 scroll 事件）
  log.scrollTop = log.scrollHeight;
  log.dispatch('scroll');
  log.scrollTop = log.scrollHeight; // 程序可能补滚一次，效果一样
  if (dom.nodes.get('chatJump').classList.contains('show')) {
    throw new Error('滚到底之后提示应该收起');
  }

  log.scrollHeight = 700;
  api.emit('danmaku', { id: 'dm2', user: '乙', text: '回到跟随状态', ts: Date.now() });
  if (log.scrollTop !== log.scrollHeight) {
    throw new Error(`回到跟随状态后应该继续自动滚，实际 ${log.scrollTop}`);
  }
});

test('对话区高度变化后，原来贴底的记录仍贴在底部', async () => {
  const { dom, api, ready } = bootOverlay(undefined, null, { chatHeight: 200 });
  await ready();
  const log = setScrollBox(dom, { scrollHeight: 400, clientHeight: 200, scrollTop: 200 });
  api.emit('danmaku', { id: 'dm1', user: '甲', text: '一句话', ts: Date.now() });
  // 用户把对话区拉高（可视区变大），滚动位置需要重新贴底
  log.clientHeight = 320;
  log.scrollHeight = 520;
  log.scrollTop = 200;
  dom.nodes.get('chatHeight').value = '360';
  dom.nodes.get('chatHeight').dispatch('input', { stopPropagation() {}, preventDefault() {} });
  // 保存是防抖的，等它落地再检查
  await new Promise((resolve) => setTimeout(resolve, 30));

  if (log.scrollTop !== log.scrollHeight) {
    throw new Error(`拉高之后应该重新贴底（${log.scrollHeight}），实际 ${log.scrollTop}`);
  }
});

test('「清空」之后重新从底部开始跟随', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const log = setScrollBox(dom, { scrollHeight: 600, clientHeight: 200, scrollTop: 0 });
  api.emit('danmaku', { id: 'dm1', user: '甲', text: '旧消息', ts: Date.now() });
  dom.nodes.get('chatClear').dispatch('click');

  if (dom.nodes.get('chatJump').classList.contains('show')) {
    throw new Error('清空后不该还提示有新消息');
  }
  log.scrollHeight = 300;
  api.emit('danmaku', { id: 'dm2', user: '乙', text: '清空后的第一条', ts: Date.now() });
  if (log.scrollTop !== log.scrollHeight) throw new Error('清空后应该重新自动滚到底');
});

// ---------------------------------------------------------------- 焦点与闪动

test('鼠标进出与聚焦不会反复抢焦点（避免切窗口时闪动）', async () => {
  // 真实踩过的 bug：曾经在 mouseenter/mouseleave 和输入框 focus/blur 里
  // 调用「可聚焦 / 不可聚焦」，导致点过输入框再切到别的程序时窗口不停闪动。
  // 现在界面不应该再因为鼠标或焦点变化去动窗口焦点。
  const { dom, sandbox, api, ready } = bootOverlay();
  await ready();
  api._calls.length = 0;

  const panel = dom.nodes.get('chatPanel');
  const input = dom.nodes.get('chatInput');
  panel.dispatch('mouseenter');
  panel.dispatch('mouseleave');
  input.dispatch('focus');
  input.dispatch('blur');
  sandbox.document.emit('mousemove', { clientX: 100, clientY: 300 });
  sandbox.document.emit('mousemove', { clientX: 300, clientY: 400 });
  await drain(4);

  const focusCalls = api._calls.filter((c) => c.name === 'overlay.setFocusable');
  if (focusCalls.length) {
    throw new Error(`界面不应该在鼠标/焦点事件里改窗口焦点，实际调用 ${focusCalls.length} 次`);
  }
  const clickThrough = api._calls.filter((c) => c.name === 'overlay.setClickThrough');
  if (clickThrough.length) {
    throw new Error('界面不应该改鼠标穿透状态');
  }
});

// ---------------------------------------------------------------- 悬浮窗顶部按钮

test('顶部有「设置」和「关闭」两个按钮', async () => {
  const { dom, ready } = bootOverlay();
  await ready();
  const gear = dom.nodes.get('gearBtn');
  const close = dom.nodes.get('closeBtn');
  if (!gear || !String(gear.title || '').includes('设置')) {
    throw new Error(`缺少设置按钮，实际 title: ${gear && gear.title}`);
  }
  if (!close || !String(close.title || '').includes('关闭')) {
    throw new Error(`缺少关闭按钮，实际 title: ${close && close.title}`);
  }
});

test('点「关闭」会关掉悬浮窗（只关悬浮窗，不退出程序）', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  api._calls.length = 0;
  dom.nodes.get('closeBtn').dispatch('click');
  await drain(4);
  if (!api._calls.some((c) => c.name === 'overlay.hide')) {
    throw new Error('点关闭应该调用 overlay.hide');
  }
});

test('点「设置」会展开快捷设置，再点收起', async () => {
  const { dom, ready } = bootOverlay();
  await ready();
  const drawer = dom.nodes.get('drawer');
  // 默认应该是收起的
  if (String(drawer.className).includes('open')) {
    throw new Error('快捷设置默认不应该展开');
  }
  dom.nodes.get('gearBtn').dispatch('click');
  if (!String(drawer.className).includes('open')) throw new Error('点设置应展开快捷设置');
  dom.nodes.get('gearBtn').dispatch('click');
  if (String(drawer.className).includes('open')) throw new Error('再点应收起快捷设置');
});

test('主进程要求收起时，快捷设置会被收起', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const drawer = dom.nodes.get('drawer');
  api.emit('openDrawer', true);
  if (!String(drawer.className).includes('open')) throw new Error('应该能通过事件展开');
  api.emit('closeDrawer', true);
  if (String(drawer.className).includes('open')) throw new Error('应该能通过事件收起');
});

test('快捷设置里有「关闭悬浮窗」和「退出整个程序」', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  api._calls.length = 0;
  dom.nodes.get('hideBtn').dispatch('click');
  await drain(3);
  if (!api._calls.some((c) => c.name === 'overlay.hide')) throw new Error('「关闭悬浮窗」按钮无效');

  api._calls.length = 0;
  dom.nodes.get('quitAppBtn').dispatch('click');
  await drain(3);
  if (!api._calls.some((c) => c.name === 'window.quit')) throw new Error('「退出整个程序」按钮无效');
});
















test('鼠标移动不影响按钮点击（回归测试）', async () => {
  const { dom, sandbox, api, ready } = bootOverlay();
  await ready();

  // 鼠标先划到窗口各处（含顶部边缘），再点按钮——都应该正常
  for (const point of [
    { clientX: 0, clientY: 0 },
    { clientX: 460, clientY: 619 },
    { clientX: 230, clientY: 5 },
    { clientX: 230, clientY: 300 }
  ]) {
    sandbox.document.emit('mousemove', point);
  }
  api._calls.length = 0;
  dom.nodes.get('chatInput').value = '边缘测试';
  dom.nodes.get('chatSend').dispatch('click');
  await drain(4);
  if (!api._calls.some((c) => c.name === 'copilot.talk')) {
    throw new Error('鼠标划过边缘后，按钮应该仍然可点');
  }
});

// ---------------------------------------------------------------- 控制面板测试

function bootPanel(settingsOverrides = {}) {
  if (!bootPanel.announced) {
    bootPanel.announced = true;
    console.log('\n控制面板（在迷你 DOM 中真实执行 panel.js）');
  }
  const dom = createDom('src/renderer/panel/index.html');
  const settings = baseSettings(settingsOverrides);
  const api = makeApi(settings);
  const timers = makeTimers();
  // 真实的面板渲染进程是有 speechSynthesis 的（Chromium 自带），
  // 所以这里也要给一个假的：不给的话「系统语音那一段」在测试里整块不会执行，
  // 界面上的语音相关 bug 就测不出来（云音色那次就是这样漏掉的）
  const panelSpeech = makeFakeSpeech([
    { name: 'Microsoft Huihui', lang: 'zh-CN', voiceURI: 'huihui' },
    { name: 'Microsoft David', lang: 'en-US', voiceURI: 'david' }
  ]);
  const sandbox = {
    window: dom.window,
    document: dom.document,
    console: { log() {}, warn() {}, error: (...a) => console.log('      [renderer error]', ...a) },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    requestAnimationFrame: timers.requestAnimationFrame,
    queueMicrotask: timers.queueMicrotask,
    prompt: () => null,
    confirm: () => false,
    alert: () => {},
    Math,
    Date,
    JSON,
    Number,
    String,
    Object,
    Array,
    Boolean,
    Error,
    Promise,
    RegExp
  };
  sandbox.window.document = dom.document;
  sandbox.window.prompt = sandbox.prompt;
  sandbox.window.confirm = sandbox.confirm;
  sandbox.window.requestAnimationFrame = timers.requestAnimationFrame;
  sandbox.window.speechSynthesis = panelSpeech.synth;
  sandbox.window.SpeechSynthesisUtterance = panelSpeech.FakeUtterance;
  dom.window.api = api;
  runScripts(sandbox, ['src/shared/emotions.js', 'src/renderer/panel/panel.js']);
  return { dom, api, settings, sandbox, timers, speech: panelSpeech, ready: () => drain(10) };
}

test('panel.js 能初始化并填好设置值', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const roomInput = dom.nodes.get('roomId');
  if (roomInput.value !== '1234567') throw new Error(`房间号没有回填: "${roomInput.value}"`);
  const model = dom.nodes.get('model');
  if (model.value !== 'deepseek-flash') throw new Error(`模型没有回填: "${model.value}"`);
});

test('多行文本设置（人设）能回填', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  if (dom.nodes.get('systemPrompt').value !== '人设') throw new Error('人设没有回填');
});

/** 面板里改某个输入框，等防抖落地，返回最后一次 settings.update 的补丁 */
async function panelPatch(dom, api, timers, id, value) {
  const node = dom.nodes.get(id);
  api._calls.length = 0;
  node.value = String(value);
  node.dispatch('input', { stopPropagation() {}, preventDefault() {} });
  timers.run(400); // 面板的保存防抖是 250ms
  await drain(4);
  const call = api._calls.filter((item) => item.name === 'settings.update').pop();
  return call ? call.args[0] : null;
}

test('面板：固定高度模式下改「对话区高度」会顺手切回跟随内容', async () => {
  // 悬浮窗被拖成「固定高度」之后，对话区吃的是剩余空间、不再认这个数字；
  // 在面板里动它 = 想自己定高度 → 一起把 heightMode 改回 content，否则看着像"改了没反应"。
  const { dom, api, timers, ready } = bootPanel({ overlay: { heightMode: 'fixed', height: 900, chatHeight: 240 } });
  await ready();
  const patch = await panelPatch(dom, api, timers, 'chatHeight', 300);
  const overlay = (patch && patch.overlay) || {};
  if (overlay.chatHeight !== 300) throw new Error(`对话区高度没存下来：${JSON.stringify(patch)}`);
  if (overlay.heightMode !== 'content') throw new Error(`应该顺手切回跟随内容：${JSON.stringify(patch)}`);
});

test('面板：跟随内容模式下改「对话区高度」不会多写 heightMode', async () => {
  const { dom, api, timers, ready } = bootPanel({ overlay: { chatHeight: 240 } });
  await ready();
  const patch = await panelPatch(dom, api, timers, 'chatHeight', 260);
  const overlay = (patch && patch.overlay) || {};
  if (overlay.chatHeight !== 260) throw new Error(`对话区高度没存下来：${JSON.stringify(patch)}`);
  if (overlay.heightMode !== undefined) throw new Error(`跟随内容模式不该写 heightMode：${JSON.stringify(patch)}`);
});

test('收到弹幕会渲染到弹幕流', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('danmaku', { user: '菲***', text: '补点糖分', ts: Date.now() });
  const feed = dom.nodes.get('danmakuFeed');
  if (feed.children.length !== 1) throw new Error(`弹幕流条目应为 1，实际 ${feed.children.length}`);
  const who = feed.children[0].children.find((c) => c.className === 'who');
  if (!who || who.textContent !== '菲***') throw new Error('弹幕流用户名不正确');
  const txt = feed.children[0].children.find((c) => c.className === 'txt');
  if (!txt || txt.textContent !== '补点糖分') throw new Error('弹幕流内容不正确');
});

test('弹幕流里也会显示 id 和 uid', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('danmaku', { id: '1791644566', uid: 1791644087, user: '菲***', text: 'ciallo', ts: Date.now() });
  const item = dom.nodes.get('danmakuFeed').children[0];
  const tag = item.children.find((c) => c.className === 'dm-tag');
  if (!tag) throw new Error('弹幕流没有显示 id');
  if (!tag.textContent.includes('1791644566')) throw new Error(`id 不对：${tag.textContent}`);
  if (!tag.textContent.includes('1791644087')) throw new Error(`uid 不对：${tag.textContent}`);
  // 正文不能把 id 混进去
  const txt = item.children.find((c) => c.className === 'txt');
  if (txt.textContent !== 'ciallo') throw new Error(`正文被污染：${txt.textContent}`);
});

test('被过滤的弹幕会标注原因', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('danmakuFiltered', { event: { user: '小明', text: '打卡', ts: Date.now() }, reason: '命中屏蔽词「打卡」' });
  const item = dom.nodes.get('danmakuFeed').children[0];
  if (!String(item.className).includes('filtered')) throw new Error('没有加上 filtered 样式');
  const reason = item.children.find((c) => c.className === 'reason');
  if (!reason || !reason.textContent.includes('打卡')) throw new Error('没有显示过滤原因');
});

test('收到 AI 回复会渲染到回复列表', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '好嘞', emotion: 'happy', source: 'danmaku', latencyMs: 300 });
  const list = dom.nodes.get('replyFeed');
  if (list.children.length !== 1) throw new Error(`回复条目应为 1，实际 ${list.children.length}`);
});

test('日志会渲染', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('log', { ts: Date.now(), level: 'info', message: '弹幕监听已就绪' });
  const list = dom.nodes.get('logList');
  if (list.children.length !== 1) throw new Error(`日志条目应为 1，实际 ${list.children.length}`);
});

test('连接状态会更新顶栏徽标', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('status', {
    danmaku: { running: true, connected: true, realRoomId: '1234567' },
    queueLength: 2,
    stats: {}
  });
  const pill = dom.nodes.get('danmakuPill');
  const label = pill.children.find((c) => c.tagName === 'SPAN');
  if (!label || !label.textContent.includes('1234567')) throw new Error(`徽标文案不正确: ${label && label.textContent}`);
  const queue = dom.nodes.get('queuePill');
  const queueSpan = queue.children.find((c) => c.tagName === 'SPAN');
  if (!queueSpan || queueSpan.textContent !== '队列 2') throw new Error(`队列显示不正确: ${queueSpan && queueSpan.textContent}`);
});

test('房间信息（主播名/标题）会显示在标题栏', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('roomInfo', {
    realRoomId: '1234567',
    anchorName: '测试观众',
    title: '今晚八点开播真的假的，卧槽真开播了',
    areaText: '生活 / 生活杂谈',
    liveStatus: 1
  });
  const label = dom.nodes.get('roomLabel').textContent;
  if (!label.includes('测试观众') || !label.includes('今晚八点开播')) throw new Error(`标题栏信息不完整: ${label}`);
});

test('未登录时账号卡片显示未登录', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  if (dom.nodes.get('accountName').textContent !== '未登录') throw new Error('账号卡片没有显示未登录');
});

test('数据目录显示真实路径', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const text = dom.nodes.get('dataFolder').textContent;
  if (!text.includes('settings.json')) throw new Error(`没有显示配置文件路径: ${text}`);
});

test('用量统计会显示今日/累计/本次运行', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const today = dom.nodes.get('usageTodayCost').textContent;
  const total = dom.nodes.get('usageTotalCost').textContent;
  const session = dom.nodes.get('usageSessionCalls').textContent;
  if (today !== '￥0.021') throw new Error(`今日费用显示不对: ${today}`);
  if (total !== '￥0.21') throw new Error(`累计费用显示不对: ${total}`);
  if (session !== '12 次') throw new Error(`本次运行显示不对: ${session}`);
  const tokens = dom.nodes.get('usageTodayTokens').textContent;
  if (!tokens.includes('3,456')) throw new Error(`token 数显示不对: ${tokens}`);
});

test('收到用量推送会刷新数字', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('usage', {
    today: { calls: 99, tokensText: '9,999', costText: '1.23' },
    total: { calls: 99, tokensText: '9,999', costText: '1.23', days: 1 },
    session: { calls: 99, costText: '1.23', failed: 2 },
    recentDays: []
  });
  const today = dom.nodes.get('usageTodayCost').textContent;
  if (today !== '￥1.23') throw new Error(`推送后没有刷新: ${today}`);
  const session = dom.nodes.get('usageSessionCost').textContent;
  if (!session.includes('失败 2')) throw new Error(`失败次数没有显示: ${session}`);
});

test('自动暂停会更新状态徽标', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('paused', { paused: true, reason: '连续 3 次调用失败：API Key 无效' });
  const pill = dom.nodes.get('aiPill');
  const label = pill.children.find((c) => c.tagName === 'SPAN');
  if (!label || label.textContent !== '已暂停回复') throw new Error(`徽标没有显示暂停: ${label && label.textContent}`);
  api.emit('paused', { paused: false, reason: '' });
  if (label.textContent !== 'AI 待机') throw new Error(`恢复后徽标不对: ${label.textContent}`);
});

test('登录后账号卡片显示昵称', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('biliLogin', { loggedIn: true, userName: '测试观众', userUid: '10001', avatar: '' });
  const name = dom.nodes.get('accountName').textContent;
  if (name !== '测试观众') throw new Error(`账号名显示不正确: ${name}`);
  const sub = dom.nodes.get('accountSub').textContent;
  if (!sub.includes('10001')) throw new Error(`uid 没有显示: ${sub}`);
});

test('修改输入框会触发设置保存（带防抖）', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  const roomInput = dom.nodes.get('roomId');
  roomInput.value = '99999';
  roomInput.dispatch('input');
  // 防抖：执行挂起的定时器回调
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(4);
  const saved = api._calls.filter((c) => c.name === 'settings.update');
  if (!saved.length) throw new Error('没有触发设置保存');
  const patch = saved[saved.length - 1].args[0];
  if (!patch.danmaku || patch.danmaku.roomId !== '99999') throw new Error(`保存内容不正确: ${JSON.stringify(patch)}`);
});

test('表情映射：给新状态选图会立刻保存（回归：选完又变回未指定）', async () => {
  // 真实 bug：惊讶/害羞/无奈/打招呼/睡觉/吃白饭/突然出现 这 7 个状态选了图不生效。
  // 根因不在界面，而是主进程清洗配置时按「默认值里有哪些键」筛，把这 7 个键整条丢了。
  // 这里守住界面这一半：选完必须真的提交出去，并且要用刚回来的设置重绘。
  const images = {};
  for (const name of ['平常', '害羞', '慌张', '打招呼', '睡觉', '吃白饭', '突然出现']) {
    images[name] = `data:${name}`;
  }
  const { dom, api, ready } = bootPanel({
    mascot: { images, expressions: { idle: '平常' }, fallbackEmoji: '🦊', animation: true }
  });
  await ready();
  api._calls.length = 0;

  const grid = dom.nodes.get('expressionGrid');
  const rows = grid.children.filter((node) => node.className === 'expression-row');
  if (rows.length !== 12) throw new Error(`表情映射应该有 12 行，实际 ${rows.length} 行`);

  // 迷你 DOM 的 innerHTML 只存字符串、拿不到行标题文字，所以按**行序**定位：
  // renderExpressions 是按 EMOTION_LIST 的顺序生成行的，和界面上看到的一致。
  const selectOf = (row) => row.children.flatMap((c) => c.children).find((node) => node.tagName === 'SELECT');
  const shyIndex = EMOTION_LIST.findIndex((item) => item.key === 'shy');
  const sleepIndex = EMOTION_LIST.findIndex((item) => item.key === 'sleep');
  if (shyIndex < 0 || sleepIndex < 0) throw new Error('状态表里缺 shy / sleep，测试作废');

  const select = selectOf(rows[shyIndex]);
  if (!select) throw new Error('害羞那一行没有下拉框');
  if (select.value !== '') throw new Error(`害羞一开始应该是未指定，实际 ${select.value}`);
  const options = select.children.map((option) => option.value);
  if (!options.includes('害羞')) throw new Error(`下拉里没有「害羞」这张图: ${options.join(',')}`);
  // 对照一行：睡觉那一行的下拉里也该有「睡觉」这张图（12 张都在候选里）
  const sleepOptions = selectOf(rows[sleepIndex]).children.map((option) => option.value);
  if (!sleepOptions.includes('睡觉')) throw new Error('睡觉那一行选不到「睡觉」这张图');

  select.value = '害羞';
  select.dispatch('change');
  await drain(6);

  const saved = api._calls.filter((c) => c.name === 'settings.update');
  if (!saved.length) throw new Error('给害羞选图之后没有提交设置');
  const patch = saved[saved.length - 1].args[0];
  if (!patch.mascot || !patch.mascot.expressions || patch.mascot.expressions.shy !== '害羞') {
    throw new Error(`提交的内容不对: ${JSON.stringify(patch)}`);
  }
  // 提交之后要用返回的设置重绘：那一行不能再显示成「未指定」
  const rowsAfter = grid.children.filter((node) => node.className === 'expression-row');
  const selectAfter = selectOf(rowsAfter[shyIndex]);
  if (selectAfter.value !== '害羞') throw new Error(`重绘之后又变回未指定了: ${selectAfter.value}`);
});

test('回复列表会显示这次调用的 token 消耗（含思考）', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('reply', {
    id: 'r1',
    ts: Date.now(),
    text: '这波不亏',
    emotion: 'happy',
    source: 'danmaku',
    latencyMs: 1013,
    tokens: { prompt: 720, completion: 46, reasoning: 31, total: 766 }
  });
  const list = dom.nodes.get('replyFeed');
  const item = list.children[list.children.length - 1];
  const meta = item.children.find((c) => c.className === 'who').children.find((c) => c.className === 'meta');
  if (!meta.textContent.includes('720 + 46 tokens')) {
    throw new Error(`token 消耗没显示出来: ${meta.textContent}`);
  }
  if (!meta.textContent.includes('思考 31')) throw new Error(`思考 token 没单独标出来: ${meta.textContent}`);
  // 没有 tokens 字段（老数据 / 别的来源）时不能崩，只是不显示这一段
  api.emit('reply', { id: 'r2', ts: Date.now(), text: '没带用量', emotion: 'idle', source: 'danmaku' });
  const last = list.children[list.children.length - 1];
  const meta2 = last.children.find((c) => c.className === 'who').children.find((c) => c.className === 'meta');
  if (meta2.textContent.includes('tokens')) throw new Error(`没带用量时不该显示 tokens: ${meta2.textContent}`);
});

test('模型下拉里没有已停用的旧模型名', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const select = dom.nodes.get('model');
  const values = select.children.map((option) => option.value);
  if (values.includes('deepseek-chat') || values.includes('deepseek-reasoner')) {
    throw new Error(`已停用的模型名不该还能选：${values.join(', ')}`);
  }
  if (!values.includes('deepseek-flash')) throw new Error(`缺少 deepseek-flash：${values.join(', ')}`);
});

test('中转站的自定义模型名会显示出来（不会变成空白）', async () => {
  const { dom, ready } = bootPanel({ api: { apiKey: 'sk-x', baseUrl: 'https://my-proxy.example.com', model: 'my-custom-model', temperature: 1.1, maxTokens: 0, timeoutSec: 45 } });
  await ready();
  const select = dom.nodes.get('model');
  if (select.value !== 'my-custom-model') {
    throw new Error(`配置里的模型名没显示出来，select.value = ${JSON.stringify(select.value)}`);
  }
  const option = select.children.find((o) => o.value === 'my-custom-model');
  if (!option) throw new Error('应该临时补一个选项把当前模型名显示出来');
  if (!String(option.textContent).includes('当前配置')) throw new Error(`补充的选项文案不对: ${option.textContent}`);
  // 不能重复追加
  const again = dom.nodes.get('model');
  const matches = again.children.filter((o) => o.value === 'my-custom-model');
  if (matches.length !== 1) throw new Error(`重复补了选项: ${matches.length} 个`);
});

test('完整提示词：能展开看到模板、改完能存、能恢复默认', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  const box = dom.nodes.get('fullPromptBox');
  const button = dom.nodes.get('showFullPrompt');
  if (box.hidden !== true) throw new Error('编辑区默认应该是收起的');

  button.dispatch('click');
  await drain(6);
  if (box.hidden) throw new Error('点了按钮编辑区没展开');
  const editor = dom.nodes.get('fullPromptText');
  if (!String(editor.value).includes('{情绪清单}')) {
    throw new Error(`编辑器里应该是带占位符的模板: ${String(editor.value).slice(0, 60)}`);
  }
  if (!String(editor.value).includes('权限规则')) throw new Error('模板里应该有权限规则那一段');

  // 改一段再保存 → 配置里应该出现 systemPromptOverride
  api._calls.length = 0;
  editor.value = String(editor.value).replace('权限规则（最高优先级）：', '权限规则（我改过的）：');
  dom.nodes.get('saveFullPrompt').dispatch('click');
  await drain(6);
  const saved = api._calls.filter((c) => c.name === 'settings.update');
  if (!saved.length) throw new Error('点保存没有提交设置');
  const patch = saved[saved.length - 1].args[0];
  if (!patch.persona || !String(patch.persona.systemPromptOverride || '').includes('我改过的')) {
    throw new Error(`提交的内容不对: ${JSON.stringify(patch).slice(0, 120)}`);
  }

  // 恢复默认 → 提交空字符串
  api._calls.length = 0;
  dom.nodes.get('resetFullPrompt').dispatch('click');
  await drain(6);
  const reset = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!reset || reset.args[0].persona.systemPromptOverride !== '') {
    throw new Error(`恢复默认应该提交空字符串: ${JSON.stringify(reset && reset.args[0])}`);
  }
});

test('完整提示词：空内容不让保存（避免把提示词清空发出去）', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  dom.nodes.get('showFullPrompt').dispatch('click');
  await drain(6);
  api._calls.length = 0;
  dom.nodes.get('fullPromptText').value = '   ';
  dom.nodes.get('saveFullPrompt').dispatch('click');
  await drain(4);
  const saved = api._calls.filter((c) => c.name === 'settings.update');
  if (saved.length) throw new Error('空内容不该提交设置');
});

test('开发者模式：对话区里会标出「我 · 开发者模式」，发出去的仍是原话', async () => {
  const { dom, api, ready } = bootOverlay();
  await ready();
  const log = dom.nodes.get('chatLog');
  // 名字外面还包了一层 .chat-who-wrap（右边要挂 id 小字），所以用子树查找
  const lastRow = () => {
    const rows = log.children.filter((node) => String(node.className || '').includes('chat-item'));
    return rows[rows.length - 1];
  };
  const findInRow = (row, className) => {
    const hits = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (String(child.className || '').split(/\s+/).includes(className)) hits.push(child);
        walk(child);
      }
    };
    if (row) walk(row);
    return hits;
  };

  dom.nodes.get('chatInput').value = '[开发者模式] 以后回复结尾加个喵';
  api._calls.length = 0;
  dom.nodes.get('chatSend').dispatch('click');
  await drain(6);

  // 发出去的必须是原文：前缀要留给主进程识别
  const talk = api._calls.find((c) => c.name === 'copilot.talk');
  if (!talk) throw new Error('没有调用 copilot.talk');
  if (talk.args[0] !== '[开发者模式] 以后回复结尾加个喵') {
    throw new Error(`发送内容被改掉了: ${talk.args[0]}`);
  }

  const who = findInRow(lastRow(), 'chat-who')[0];
  if (!who || !String(who.textContent).includes('开发者模式')) {
    throw new Error(`对话区没标出开发者模式: ${who && who.textContent}`);
  }
  const body = findInRow(lastRow(), 'chat-text')[0];
  if (String(body.textContent).includes('[开发者模式]')) {
    throw new Error(`气泡里不该重复显示前缀: ${body.textContent}`);
  }

  // 普通说话仍然显示「我」
  dom.nodes.get('chatInput').value = '普通聊天';
  dom.nodes.get('chatSend').dispatch('click');
  await drain(6);
  const lastWho = findInRow(lastRow(), 'chat-who')[0];
  if (String(lastWho.textContent) !== '我') throw new Error(`普通说话的名字不对: ${lastWho.textContent}`);
});

test('云端语音：engine=cloud 时向主进程要音频并用 Audio 播放', async () => {
  const { api, speech, audios, ready, sandbox } = bootOverlay({
    speech: { ...baseSettings().speech, enabled: true, engine: 'cloud' }
  });
  await ready();
  audios.length = 0;
  api._calls.length = 0;
  sandbox.window.__speakTrace = [];
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '你好呀', emotion: 'happy', source: 'danmaku' });
  await ready();

  const asked = api._calls.filter((c) => c.name === 'tts.synthesize');
  if (asked.length !== 1) throw new Error(`应该向主进程要一次音频，实际 ${asked.length} 次`);
  if (asked[0].args[0] !== '你好呀') throw new Error(`请求的文本不对: ${asked[0].args[0]}`);
  if (audios.length !== 1) {
    throw new Error(`应该创建一个 Audio 来播，实际 ${audios.length} 个｜trace: ${(sandbox.window.__speakTrace || []).join(' | ')}`);
  }
  if (!String(audios[0].src).startsWith('data:audio/wav;base64,')) {
    throw new Error(`音频 dataURL 不对: ${audios[0].src}`);
  }
  // 云端模式不该再去动系统语音
  if (speech.record.spoken.length) throw new Error('云端模式不该调用系统语音');
});

test('云端语音：失败时按设置退回系统语音（默认退）', async () => {
  const { api, speech, audios, ready } = bootOverlay({
    speech: { ...baseSettings().speech, enabled: true, engine: 'cloud' }
  });
  await ready();
  speech.record.spoken.length = 0;
  audios.length = 0;
  api._tts.ok = false;
  api._tts.message = '云端语音返回错误：Invalid API-key';
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '退回系统语音', emotion: 'happy', source: 'danmaku' });
  await ready();

  if (audios.length) throw new Error('云端失败了不该还建 Audio');
  if (speech.record.spoken.length !== 1) {
    throw new Error(`应该退回系统语音念一次，实际 ${speech.record.spoken.length} 次`);
  }
  if (speech.record.spoken[0].text !== '退回系统语音') {
    throw new Error(`念的内容不对: ${speech.record.spoken[0].text}`);
  }
});

test('云端语音：关掉「退回系统语音」后失败就安静（不出声也不报错）', async () => {
  const { api, speech, audios, ready } = bootOverlay({
    speech: { ...baseSettings().speech, enabled: true, engine: 'cloud', fallbackToSystem: false }
  });
  await ready();
  speech.record.spoken.length = 0;
  audios.length = 0;
  api._tts.ok = false;
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '不该有声音', emotion: 'happy', source: 'danmaku' });
  await ready();
  if (audios.length || speech.record.spoken.length) throw new Error('关掉降级后不该有任何声音');
});

test('系统语音模式不会去请求云端（省流量也省钱）', async () => {
  const { api, speech, ready } = bootOverlay({
    speech: { ...baseSettings().speech, enabled: true, engine: 'system' }
  });
  await ready();
  speech.record.spoken.length = 0;
  api._calls.length = 0;
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '走系统语音', emotion: 'happy', source: 'danmaku' });
  await ready();
  if (api._calls.some((c) => c.name === 'tts.synthesize')) throw new Error('系统语音模式不该请求云端');
  if (speech.record.spoken.length !== 1) throw new Error('应该用系统语音念一次');
});

test('云端语音：静音后不再出声（打断已经排上的朗读）', async () => {
  const { api, speech, audios, ready } = bootOverlay({
    speech: { ...baseSettings().speech, enabled: true, engine: 'cloud' }
  });
  await ready();
  // 第一条正常出声（先确认前置条件成立）
  audios.length = 0;
  speech.record.spoken.length = 0;
  api.emit('reply', { id: 'r1', ts: Date.now(), text: '第一句', emotion: 'happy', source: 'danmaku' });
  await ready();
  if (audios.length !== 1) throw new Error('前置条件不成立：第一条语音没播出来');

  // 点静音：正在播的要停掉，之后来的也不能再出声
  api.emit('settingsChanged', {
    ...baseSettings(),
    speech: { ...baseSettings().speech, enabled: true, engine: 'cloud', muted: true }
  });
  await ready();
  if (!audios[0].paused) throw new Error('静音时应该把正在播的音频暂停掉');

  const before = audios.length;
  api.emit('reply', { id: 'r2', ts: Date.now(), text: '第二句', emotion: 'happy', source: 'danmaku' });
  await ready();
  if (audios.length !== before) throw new Error(`静音后不该再播语音，新建了 ${audios.length - before} 个 Audio`);
  if (speech.record.spoken.length) throw new Error('静音后也不该退回系统语音');
});

test('语音页：引擎单选会写进设置，云音色字段能显示当前值', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  // 默认是系统语音
  if (!dom.nodes.get('speechEngineSystem').checked) throw new Error('默认应该选系统语音');
  if (dom.nodes.get('speechEngineCloud').checked) throw new Error('默认不该选云音色');
  if (!dom.nodes.get('speechFallback').checked) throw new Error('默认应该勾上「云端失败退回系统语音」');

  api._calls.length = 0;
  const cloud = dom.nodes.get('speechEngineCloud');
  cloud.checked = true;
  cloud.dispatch('change');
  await drain(6);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || !saved.args[0].speech || saved.args[0].speech.engine !== 'cloud') {
    throw new Error(`切换引擎没有保存: ${JSON.stringify(saved && saved.args[0])}`);
  }

  // 云音色的输入框应该显示配置里的值
  if (dom.nodes.get('ttsVoice').value !== 'Cherry') {
    throw new Error(`音色没回填: ${dom.nodes.get('ttsVoice').value}`);
  }
  if (dom.nodes.get('ttsModel').value !== 'qwen3-tts-flash') {
    throw new Error(`模型没回填: ${dom.nodes.get('ttsModel').value}`);
  }
});

test('语音页：音色下拉用主进程给的清单填，内置音色不用手打', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const select = dom.nodes.get('ttsVoice');
  const values = Array.from(select.children).map((option) => option.value);
  for (const item of FAKE_VOICES) {
    if (!values.includes(item.voice)) throw new Error(`下拉里缺音色 ${item.voice}：${values.join(',')}`);
  }
  if (values.length !== FAKE_VOICES.length) throw new Error(`下拉项数不对：${values.join(',')}`);
  // 文案要带中文名，光一个英文 ID 用户不知道谁是谁；特点写在下面那行小字里
  const ethan = Array.from(select.children).find((option) => option.value === 'Ethan');
  if (!ethan.textContent.includes('晨煦')) throw new Error(`选项文案没有中文名: ${ethan.textContent}`);
  if (ethan.textContent.length > 24) throw new Error(`选项文案太长，下拉里会被截断: ${ethan.textContent}`);
  if (!dom.nodes.get('ttsVoiceDesc').textContent.includes('阳光积极')) {
    throw new Error(`音色说明没显示当前音色的特点: ${dom.nodes.get('ttsVoiceDesc').textContent}`);
  }
  if (select.value !== 'Cherry') throw new Error(`下拉应该选中配置里的音色，实际 ${select.value}`);
  // 配置里是内置音色时，自定义输入框应该是空的
  if (dom.nodes.get('ttsVoiceCustom').value !== '') {
    throw new Error(`内置音色不该占着自定义框: ${dom.nodes.get('ttsVoiceCustom').value}`);
  }
});

test('语音页：配置里是自定义音色时下拉补一项、并显示在自定义框里', async () => {
  const { dom, ready } = bootPanel(cloudSettings({ voice: 'my-voice-001' }));
  await ready();
  const select = dom.nodes.get('ttsVoice');
  const values = Array.from(select.children).map((option) => option.value);
  if (!values.includes('my-voice-001')) throw new Error(`自定义音色没补进下拉：${values.join(',')}`);
  if (select.value !== 'my-voice-001') throw new Error(`下拉没选中自定义音色: ${select.value}`);
  const custom = Array.from(select.children).find((option) => option.value === 'my-voice-001');
  if (!custom.textContent.includes('自定义')) throw new Error(`自定义项应该有标注: ${custom.textContent}`);
  if (dom.nodes.get('ttsVoiceCustom').value !== 'my-voice-001') {
    throw new Error(`自定义框没回填: ${dom.nodes.get('ttsVoiceCustom').value}`);
  }
  // 小字要提醒「这个 ID 不在内置清单里」，不然用户会以为是列表坏了
  if (!dom.nodes.get('ttsVoiceDesc').textContent.includes('自定义音色 ID')) {
    throw new Error(`说明行没标出自定义音色: ${dom.nodes.get('ttsVoiceDesc').textContent}`);
  }
});

test('语音页：模型/音色清单都读不到时，两个下拉留提示且不崩', async () => {
  const { dom, api, ready } = bootPanel();
  api._tts.models = [];
  await ready();
  // 模型清单为空但配置里有模型名 → 补一项显示出来，别变成空白
  const modelSelect = dom.nodes.get('ttsModel');
  if (modelSelect.value !== 'qwen3-tts-flash') {
    throw new Error(`模型清单为空时下拉不该是空白: ${modelSelect.value}`);
  }
  // 音色同理：清单里的音色拿不到，就退化成「自定义音色」，至少让用户看得见当前用的是谁
  const voiceSelect = dom.nodes.get('ttsVoice');
  if (voiceSelect.value !== 'Cherry') throw new Error(`清单为空时音色下拉不该是空白: ${voiceSelect.value}`);
  if (dom.nodes.get('ttsVoiceCustom').value !== 'Cherry') {
    throw new Error('清单为空时应该把当前音色放进自定义框，好让用户能看到');
  }
});

test('语音页：模型下拉用主进程给的清单填，并显示价格与说明', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const select = dom.nodes.get('ttsModel');
  const values = Array.from(select.children).map((option) => option.value);
  for (const item of FAKE_TTS_MODELS) {
    if (!values.includes(item.id)) throw new Error(`模型下拉里缺 ${item.id}：${values.join(',')}`);
  }
  if (values.length !== FAKE_TTS_MODELS.length) throw new Error(`模型项数不对：${values.join(',')}`);
  const label = Array.from(select.children).find((option) => option.value === 'cosyvoice-v3-flash');
  if (!label.textContent.includes('CosyVoice')) throw new Error(`模型选项文案不对: ${label.textContent}`);
  if (select.value !== 'qwen3-tts-flash') throw new Error(`模型下拉应该选中配置里的模型: ${select.value}`);
  const hint = dom.nodes.get('ttsModelHint').textContent;
  if (!hint.includes('0.8') || !hint.includes('最快最便宜')) {
    throw new Error(`模型提示行没显示价格和说明: ${hint}`);
  }
});

test('语音页：换模型会把音色换成新模型认的（音色不能跨模型混用）', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  // 前置：当前是 qwen3-tts-flash + Cherry，换成 cosyvoice（只认 longanyang）
  api._calls.length = 0;
  const modelSelect = dom.nodes.get('ttsModel');
  modelSelect.value = 'cosyvoice-v3-flash';
  modelSelect.dispatch('change');
  await drain(8);

  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('换模型没有保存');
  if (saved.args[0].speech.cloud.model !== 'cosyvoice-v3-flash') {
    throw new Error(`模型没保存: ${JSON.stringify(saved.args[0])}`);
  }
  // 关键：不能只换模型不换音色，否则线上就是 Invalid voice specified
  if (saved.args[0].speech.cloud.voice !== 'longanyang') {
    throw new Error(`音色没跟着换: ${JSON.stringify(saved.args[0])}`);
  }
  // 界面上的音色下拉要整份换成新模型的清单
  const voiceSelect = dom.nodes.get('ttsVoice');
  const voices = Array.from(voiceSelect.children).map((option) => option.value);
  if (voices.length !== 1 || voices[0] !== 'longanyang') {
    throw new Error(`音色下拉没跟着模型换: ${voices.join(',')}`);
  }
  if (voiceSelect.value !== 'longanyang') throw new Error(`音色下拉没选中新音色: ${voiceSelect.value}`);
  // 换模型不该自动出声（试听要用户自己点）
  if (api._calls.some((c) => c.name === 'tts.synthesize')) throw new Error('换模型不该自动合成');
});

test('语音页：换模型时如果音色新模型也认，就不动音色', async () => {
  const { dom, api, ready } = bootPanel();
  // 两个模型共用 Cherry —— 这种时候换模型不该顺手改音色（用户的选择要保留）
  api._tts.models = [
    {
      id: 'qwen3-tts-flash',
      label: '甲',
      price: '1 元',
      note: '甲',
      defaultVoice: 'Cherry',
      voices: [{ voice: 'Cherry', name: '芊悦', desc: 'a' }]
    },
    {
      id: 'other-model',
      label: '乙',
      price: '2 元',
      note: '乙',
      defaultVoice: 'Cherry',
      voices: [{ voice: 'Cherry', name: '芊悦', desc: 'a' }]
    }
  ];
  await ready();
  api._calls.length = 0;
  const modelSelect = dom.nodes.get('ttsModel');
  modelSelect.value = 'other-model';
  modelSelect.dispatch('change');
  await drain(8);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('换模型没有保存');
  if (saved.args[0].speech.cloud.model !== 'other-model') throw new Error('模型没保存');
  if ('voice' in saved.args[0].speech.cloud) {
    throw new Error(`音色通用时不该动它: ${JSON.stringify(saved.args[0])}`);
  }
});

test('语音页：换音色会保存，选了内置音色会清掉自定义框', async () => {
  const { dom, api, ready } = bootPanel(cloudSettings({ voice: 'my-voice-001' }));
  await ready();
  if (dom.nodes.get('ttsVoiceCustom').value !== 'my-voice-001') throw new Error('前置条件不对');

  api._calls.length = 0;
  const select = dom.nodes.get('ttsVoice');
  select.value = 'Ethan';
  select.dispatch('change');
  await drain(8);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].speech.cloud.voice !== 'Ethan') {
    throw new Error(`换音色没有保存: ${JSON.stringify(saved && saved.args[0])}`);
  }
  if (dom.nodes.get('ttsVoiceCustom').value !== '') throw new Error('选了内置音色后自定义框应该清空');
  if (api._calls.some((c) => c.name === 'tts.synthesize')) throw new Error('换音色不该自动合成，试听要用户自己点');
});

test('语音页：直接填自定义音色 ID 会保存（防抖）', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  const custom = dom.nodes.get('ttsVoiceCustom');
  custom.value = 'qwen-voice-abc';
  custom.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(8);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].speech.cloud.voice !== 'qwen-voice-abc') {
    throw new Error(`自定义音色没有保存: ${JSON.stringify(saved && saved.args[0])}`);
  }
  // 保存完下拉要跟上，不然界面显示的还是旧音色
  const select = dom.nodes.get('ttsVoice');
  if (select.value !== 'qwen-voice-abc') throw new Error(`下拉没跟到自定义音色: ${select.value}`);

  // 清空输入框 = 「不改」，不能把配置里的音色抹掉
  api._calls.length = 0;
  custom.value = '';
  custom.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(8);
  if (api._calls.some((c) => c.name === 'settings.update' && c.args[0].speech && c.args[0].speech.cloud && !c.args[0].speech.cloud.voice)) {
    throw new Error('清空自定义框不该把音色存成空字符串');
  }
});

test('语音页：Key 输入是防窥的，能点开看', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const key = dom.nodes.get('ttsApiKey');
  if (key.type !== 'password') throw new Error('API Key 默认应该是密码框');
  dom.nodes.get('toggleTtsKey').dispatch('click');
  if (key.type !== 'text') throw new Error('点显示后应该变成明文');
  dom.nodes.get('toggleTtsKey').dispatch('click');
  if (key.type !== 'password') throw new Error('再点一次应该变回密码框');
});

test('角色：下拉列出所有角色，默认角色标出来，图标与名字都显示', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const select = dom.nodes.get('roleSelect');
  const values = Array.from(select.children).map((option) => option.value);
  if (values.length !== 1 || values[0] !== 'default') throw new Error(`角色下拉不对：${values.join(',')}`);
  const option = select.children[0];
  if (!option.textContent.includes('小助手')) throw new Error(`角色名没显示: ${option.textContent}`);
  if (!option.textContent.includes('默认')) throw new Error(`默认角色要标出来: ${option.textContent}`);
  if (select.value !== 'default') throw new Error(`下拉应该选中当前角色: ${select.value}`);
  if (dom.nodes.get('roleEmoji').value !== '🐟') throw new Error(`图标没回填: ${dom.nodes.get('roleEmoji').value}`);
});

test('角色：新建角色会复制当前内容、切过去，并出现在下拉里', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  dom.nodes.get('newRole').dispatch('click');
  await drain(8);

  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('新建角色没有保存');
  const persona = saved.args[0].persona;
  const id = persona.activeRole;
  if (!id || id === 'default') throw new Error(`新角色 id 不对: ${id}`);
  if (!persona.roles[id]) throw new Error('新角色没进角色表');
  // 新角色要复制当前内容，用户才好「基于现在这个改一个」
  if (persona.roles[id].prompt !== '人设') throw new Error(`新角色没复制当前人设: ${persona.roles[id].prompt}`);
  if (persona.roles.default === undefined) throw new Error('默认角色不能被新角色顶掉');
  if (persona.systemPrompt !== '人设') throw new Error('活字段应该是新角色的内容');

  // 界面上：下拉选中新角色，角色表里两条
  const select = dom.nodes.get('roleSelect');
  const values = Array.from(select.children).map((option) => option.value);
  if (values.length !== 2 || !values.includes(id)) throw new Error(`下拉没跟上：${values.join(',')}`);
  if (select.value !== id) throw new Error(`下拉没选中新角色: ${select.value}`);
});

test('角色：切换角色会把名字 / 人设 / 性格整份换掉', async () => {
  const settings = baseSettings();
  settings.persona.roles.cat = { name: '猫娘', emoji: '🐱', prompt: '你是猫娘', style: '句尾加喵' };
  const { dom, api, ready } = bootPanel(settings);
  await ready();
  // 前置：当前是默认角色
  if (dom.nodes.get('systemPrompt').value !== '人设') throw new Error('前置条件不对');

  api._calls.length = 0;
  const select = dom.nodes.get('roleSelect');
  select.value = 'cat';
  select.dispatch('change');
  await drain(8);

  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('切角色没有保存');
  const persona = saved.args[0].persona;
  if (persona.activeRole !== 'cat') throw new Error('activeRole 没切');
  if (persona.botName !== '猫娘' || persona.nickname !== '猫娘') throw new Error(`名字没换: ${persona.botName}`);
  if (persona.systemPrompt !== '你是猫娘') throw new Error(`人设没换: ${persona.systemPrompt}`);
  if (persona.styleNotes !== '句尾加喵') throw new Error(`性格没换: ${persona.styleNotes}`);
  // 界面上的输入框也要跟着变（不然用户看到的还是旧角色的内容）
  if (dom.nodes.get('systemPrompt').value !== '你是猫娘') throw new Error('人设框没刷新');
  if (dom.nodes.get('styleNotes').value !== '句尾加喵') throw new Error('性格框没刷新');
  if (dom.nodes.get('botName').value !== '猫娘') throw new Error('名字框没刷新');
});

test('角色：改了人设再切回来，改动还在（自动存进当前角色）', async () => {
  const settings = baseSettings();
  settings.persona.roles.cat = { name: '猫娘', emoji: '🐱', prompt: '你是猫娘', style: '' };
  const { dom, timers, ready } = bootPanel(settings);
  await ready();

  // 在默认角色下改人设（走绑定表的防抖保存，模拟用户打字）
  const prompt = dom.nodes.get('systemPrompt');
  prompt.value = '改过的默认人设';
  prompt.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(8);

  // 切到猫娘，再切回来
  const select = dom.nodes.get('roleSelect');
  select.value = 'cat';
  select.dispatch('change');
  await drain(8);
  select.value = 'default';
  select.dispatch('change');
  await drain(8);

  if (dom.nodes.get('systemPrompt').value !== '改过的默认人设') {
    throw new Error(`切回来改动丢了: ${dom.nodes.get('systemPrompt').value}`);
  }
});

test('角色：名字 / 性格改动会存进当前角色', async () => {
  const { dom, timers, ready } = bootPanel();
  await ready();
  const name = dom.nodes.get('botName');
  name.value = '小鱼';
  name.dispatch('input');
  const style = dom.nodes.get('styleNotes');
  style.value = '傲娇毒舌';
  style.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(8);

  const select = dom.nodes.get('roleSelect');
  if (!Array.from(select.children).some((option) => option.textContent.includes('小鱼'))) {
    throw new Error('角色下拉没跟着名字变');
  }
});

test('角色：默认角色删不掉，其它角色删掉后回到默认', async () => {
  const settings = baseSettings();
  settings.persona.roles.cat = { name: '猫娘', emoji: '🐱', prompt: '你是猫娘', style: '' };
  const { dom, api, sandbox, ready } = bootPanel(settings);
  await ready();

  // 1) 当前是默认角色 → 不让删（连确认框都不该弹）
  api._calls.length = 0;
  dom.nodes.get('deleteRole').dispatch('click');
  await drain(6);
  if (api._calls.some((c) => c.name === 'settings.update')) throw new Error('默认角色不该被删掉');

  // 2) 切到猫娘再删（确认框在测试里默认返回 false，先模拟点「取消」）
  const select = dom.nodes.get('roleSelect');
  select.value = 'cat';
  select.dispatch('change');
  await drain(8);
  api._calls.length = 0;
  dom.nodes.get('deleteRole').dispatch('click');
  await drain(6);
  if (api._calls.some((c) => c.name === 'settings.update' && c.args[0].persona && c.args[0].persona.roles)) {
    throw new Error('点了取消不该真删');
  }

  // 3) 点「确定」才删（走应用内确认框，不用原生 confirm）
  api._calls.length = 0;
  dom.nodes.get('deleteRole').dispatch('click');
  await drain(8);
  if (dom.nodes.get('modalMask').hidden) throw new Error('删角色也该弹应用内确认框');
  dom.nodes.get('modalOk').dispatch('click');
  await drain(10);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('确认后应该真的删');
  if (saved.args[0].persona.roles.cat) throw new Error('猫娘没被删掉');
  if (saved.args[0].persona.activeRole !== 'default') throw new Error('删完应该回默认角色');
  if (saved.args[0].persona.systemPrompt !== '人设') throw new Error('活字段应该换回默认角色的内容');
  const values = Array.from(dom.nodes.get('roleSelect').children).map((option) => option.value);
  if (values.includes('cat')) throw new Error(`删完下拉里还有猫娘：${values.join(',')}`);
});

test('角色：角色表空的也不崩（老配置没迁移时）', async () => {
  const settings = baseSettings();
  settings.persona.roles = {};
  settings.persona.activeRole = 'default';
  const { dom, ready } = bootPanel(settings);
  await ready();
  const select = dom.nodes.get('roleSelect');
  if (select.children.length < 1) throw new Error('角色表为空时下拉不该完全没有内容');
  if (dom.nodes.get('roleEmoji').value !== '') throw new Error('没有角色时图标应该是空的');
});

// ---------------------------------------------------------------- 知识库页

test('知识库：空库时给出引导，不报错', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const stats = dom.nodes.get('knowledgeStats').textContent;
  if (!stats.includes('还是空的')) throw new Error(`空库提示不对: ${stats}`);
  if (!dom.nodes.get('knowledgeList').children.length) throw new Error('空库也该有一行提示');
});

test('知识库：条目能画出来（标题 / 标签 / 停用标记 / 来源）', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.items = [
    {
      id: 'k1',
      title: '商品：大肥鱼玩偶',
      content: '39 元，下单送贴纸',
      tags: ['商品', '价格'],
      source: '手动添加',
      updated: '2026-10-15T01:20:00.000Z',
      enabled: true
    },
    { id: 'k2', title: '口播稿开场', content: '大家好', tags: [], source: '文件', updated: '2026-10-14T10:00:00.000Z', enabled: false }
  ];
  api._knowledge.stats = { ...api._knowledge.stats, count: 2, enabled: 1, chars: 20, notesDir: 'D:\\demo\\notes' };
  const { ready: ready2 } = { ready: null };
  void ready2;
  // 重新渲染：模拟点「重新读取」
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);
  const box = dom.nodes.get('knowledgeList');
  const text = box.children.map((row) => row.textContent).join(' || ');
  if (!text.includes('商品：大肥鱼玩偶')) throw new Error(`没画出标题: ${text}`);
  if (!text.includes('#商品')) throw new Error(`没画出标签: ${text}`);
  if (!text.includes('已停用')) throw new Error(`没标出停用: ${text}`);
  if (!text.includes('来源：文件')) throw new Error(`没画出来源: ${text}`);
  if (!dom.nodes.get('knowledgeStats').textContent.includes('共 2 条')) {
    throw new Error(`统计行不对: ${dom.nodes.get('knowledgeStats').textContent}`);
  }
});

test('知识库：统计行里给出「知识库」文件夹的位置（空库时也要说）', async () => {
  // 这个目录既是主播自己放资料的地方，也是 DSH 的工作区：
  // 界面上任何时候都得能看出它在哪，不能只有「打开文件夹」一个按钮。
  const { dom, ready } = bootPanel();
  await ready();
  const empty = dom.nodes.get('knowledgeStats').textContent;
  if (!empty.includes('D:\\demo\\知识库')) throw new Error(`空库时也该说出目录：${empty}`);

  const { dom: dom2, api, ready: ready2 } = bootPanel();
  api._knowledge.stats = { ...api._knowledge.stats, count: 2, enabled: 2, chars: 12 };
  await ready2();
  dom2.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);
  const filled = dom2.nodes.get('knowledgeStats').textContent;
  if (!filled.includes('D:\\demo\\知识库')) throw new Error(`有条目时也要说出目录：${filled}`);
});

test('知识库：新增和编辑都走对应接口，保存后清空表单', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  dom.nodes.get('knowledgeTitle').value = '商品：大肥鱼玩偶';
  dom.nodes.get('knowledgeTags').value = '商品,价格';
  dom.nodes.get('knowledgeContent').value = '39 元';
  dom.nodes.get('knowledgeSave').dispatch('click');
  await drain(10);
  const added = api._calls.filter((c) => c.name === 'knowledge.add').pop();
  if (!added) throw new Error('没有调用新增接口');
  if (added.args[0].title !== '商品：大肥鱼玩偶') throw new Error(`标题没传对: ${JSON.stringify(added.args[0])}`);
  if (added.args[0].content !== '39 元') throw new Error('正文没传对');
  if (dom.nodes.get('knowledgeTitle').value !== '') throw new Error('保存后表单该清空');

  // 编辑：先点条目上的「编辑」，再改标题保存 → 走 update
  api._calls.length = 0;
  const firstRow = dom.nodes.get('knowledgeList').children[0];
  if (!firstRow) throw new Error('列表里应该有刚才新增的条目');
  const buttons = [];
  const walk = (node) => {
    if (node.textContent === '编辑') buttons.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(firstRow);
  if (!buttons.length) throw new Error('条目上没有「编辑」按钮');
  buttons[0].dispatch('click');
  await drain(8);
  if (dom.nodes.get('knowledgeTitle').value !== '商品：大肥鱼玩偶') throw new Error('编辑没有回填表单');
  if (dom.nodes.get('knowledgeEditHint').textContent !== '正在编辑：商品：大肥鱼玩偶') {
    throw new Error(`编辑提示不对: ${dom.nodes.get('knowledgeEditHint').textContent}`);
  }
  dom.nodes.get('knowledgeTitle').value = '商品：大肥鱼玩偶（改）';
  dom.nodes.get('knowledgeSave').dispatch('click');
  await drain(10);
  const updated = api._calls.filter((c) => c.name === 'knowledge.update').pop();
  if (!updated) throw new Error('没有调用更新接口');
  if (updated.args[1].title !== '商品：大肥鱼玩偶（改）') throw new Error(`更新内容不对: ${JSON.stringify(updated.args)}`);
});

test('知识库：删除走应用内确认框（回归：不再用原生 confirm，它会让整个界面打不了字）', async () => {
  const { dom, api, sandbox, ready } = bootPanel();
  api._knowledge.items = [
    { id: 'k9', title: '待删条目', content: 'x', tags: [], source: '手动添加', updated: '2026-10-15T00:00:00.000Z', enabled: true }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);

  const findButton = (label) => {
    const found = [];
    const walk = (node) => {
      if (node.textContent === label) found.push(node);
      for (const child of node.children || []) walk(child);
    };
    for (const row of dom.nodes.get('knowledgeList').children) walk(row);
    return found[0];
  };

  // 钉住这个 bug：一旦有人把原生 confirm 用回来，这里就会红
  let nativeConfirmCalls = 0;
  sandbox.confirm = () => {
    nativeConfirmCalls += 1;
    return true;
  };
  sandbox.window.confirm = sandbox.confirm;

  // 1) 点删除 → 出应用内弹窗，此时还没删
  api._calls.length = 0;
  findButton('删除').dispatch('click');
  await drain(8);
  if (dom.nodes.get('modalMask').hidden) throw new Error('应该弹出确认框');
  if (!dom.nodes.get('modalText').textContent.includes('待删条目')) {
    throw new Error(`确认框没说清删的是哪条：${dom.nodes.get('modalText').textContent}`);
  }
  if (api._calls.some((c) => c.name === 'knowledge.remove')) throw new Error('还没确认就删了');

  // 2) 点「取消」→ 不删，弹窗收掉
  dom.nodes.get('modalCancel').dispatch('click');
  await drain(8);
  if (api._calls.some((c) => c.name === 'knowledge.remove')) throw new Error('点取消不该删');
  if (!dom.nodes.get('modalMask').hidden) throw new Error('取消后遮罩必须收掉（否则整个界面都被挡住）');

  // 3) 再点删除 → 这次点「确定」
  api._calls.length = 0;
  findButton('删除').dispatch('click');
  await drain(8);
  dom.nodes.get('modalOk').dispatch('click');
  await drain(10);
  const removed = api._calls.filter((c) => c.name === 'knowledge.remove').pop();
  if (!removed || removed.args[0] !== 'k9') throw new Error(`删除参数不对: ${JSON.stringify(removed && removed.args)}`);
  if (!dom.nodes.get('modalMask').hidden) throw new Error('确定后遮罩也要收掉');

  if (nativeConfirmCalls !== 0) {
    throw new Error(`不该再用原生 confirm（调用了 ${nativeConfirmCalls} 次）——它正是"界面点不动打不了字"的根因`);
  }
});

test('确认框：Esc 和点遮罩都算取消，且遮罩一定会收掉', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.items = [
    { id: 'k1', title: '一条', content: 'x', tags: [], source: '手动', updated: '2026-10-15T00:00:00.000Z', enabled: true }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);

  const findButton = (label) => {
    const found = [];
    const walk = (node) => {
      if (node.textContent === label) found.push(node);
      for (const child of node.children || []) walk(child);
    };
    for (const row of dom.nodes.get('knowledgeList').children) walk(row);
    return found[0];
  };

  // Esc = 取消
  findButton('删除').dispatch('click');
  await drain(8);
  if (dom.nodes.get('modalMask').hidden) throw new Error('前置条件：弹窗该开着');
  dom.document.emit('keydown', { key: 'Escape' });
  await drain(8);
  if (!dom.nodes.get('modalMask').hidden) throw new Error('按 Esc 之后遮罩没收掉');
  api._calls.length = 0;

  // 点遮罩空白处 = 取消
  findButton('删除').dispatch('click');
  await drain(8);
  dom.nodes.get('modalMask').dispatch('click', { target: dom.nodes.get('modalMask') });
  await drain(8);
  if (!dom.nodes.get('modalMask').hidden) throw new Error('点遮罩之后遮罩没收掉');
  if (api._calls.some((c) => c.name === 'knowledge.remove')) throw new Error('点遮罩不该当成确定');
});

test('知识库：检索预览区分「会注入」和「弱命中」', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.hits = [
    { id: 'k1', title: '商品：大肥鱼玩偶', score: 1.57, strong: true, matchedTokens: 2 },
    { id: 'k2', title: '口播稿开场', score: 0.25, strong: false, matchedTokens: 1 }
  ];
  dom.nodes.get('knowledgeQuery').value = '大肥鱼多少钱';
  api._calls.length = 0;
  dom.nodes.get('knowledgeSearchBtn').dispatch('click');
  await drain(10);
  const asked = api._calls.filter((c) => c.name === 'knowledge.search').pop();
  if (!asked || asked.args[0] !== '大肥鱼多少钱') throw new Error('检索没带上查询词');
  const out = dom.nodes.get('knowledgeSearchOut').textContent;
  if (!out.includes('✅ 会注入')) throw new Error(`强命中没标出来: ${out}`);
  if (!out.includes('⬜ 弱命中')) throw new Error(`弱命中没标出来: ${out}`);
  if (!out.includes('商品：大肥鱼玩偶')) throw new Error(`没列出命中的标题: ${out}`);
});

test('知识库：没命中时说清楚「不会带资料」', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.hits = [];
  dom.nodes.get('knowledgeQuery').value = '今天天气怎么样';
  dom.nodes.get('knowledgeSearchBtn').dispatch('click');
  await drain(10);
  const out = dom.nodes.get('knowledgeSearchOut').textContent;
  if (!out.includes('一条都没命中')) throw new Error(`没命中的提示不对: ${out}`);
});

test('知识库：开关 / 条数 / 字数会存进设置', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  const enabled = dom.nodes.get('knowledgeEnabled');
  if (!enabled.checked) throw new Error('默认应该是开启的');
  enabled.checked = false;
  enabled.dispatch('change');
  // 数字框走的是 input 事件（绑定表里只有 range/check/select 用 change）
  dom.nodes.get('knowledgeInjectCount').value = '5';
  dom.nodes.get('knowledgeInjectCount').dispatch('input');
  dom.nodes.get('knowledgeInjectChars').value = '900';
  dom.nodes.get('knowledgeInjectChars').dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(10);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('没有保存设置');
  const k = saved.args[0].knowledge;
  if (!k || k.enabled !== false || k.injectCount !== 5 || k.injectChars !== 900) {
    throw new Error(`知识库设置没存对: ${JSON.stringify(saved.args[0])}`);
  }
});

test('语音页：重启后要按配置显示引擎（回归：以前永远显示系统语音）', async () => {
  // 主播用云音色时关掉软件，下次打开界面必须还勾着「云音色」——
  // 以前 initSpeechPanel 在读配置之前就画了一次单选，之后再没人重画，
  // 界面上永远显示「系统语音」，但实际发声的还是云音色（悬浮窗读的是配置）
  const { dom, ready } = bootPanel(baseSettings({ speech: { engine: 'cloud', fallbackToSystem: false } }));
  await ready();
  if (!dom.nodes.get('speechEngineCloud').checked) throw new Error('配置是云音色，界面却没勾上');
  if (dom.nodes.get('speechEngineSystem').checked) throw new Error('配置是云音色，却还勾着系统语音');
  if (dom.nodes.get('speechFallback').checked) throw new Error('关掉的「失败退回系统语音」被勾回来了');
});

test('语音页：系统语音的音色下拉也要按配置回填（同一类 bug）', async () => {
  // 音色列表是在「读配置」之前填的，那时 state.settings 还是空，选中项会被设成「自动」；
  // 之后如果没人再同步一次，界面显示「自动」而悬浮窗用的是配置里那个语音
  const { dom, ready } = bootPanel(baseSettings({ speech: { voiceURI: 'david' } }));
  await ready();
  const select = dom.nodes.get('speechVoice');
  if (select.value !== 'david') throw new Error(`音色下拉没回填配置里的值，实际是「${select.value}」`);
});

test('语音页：设置从别处改了，引擎单选也要跟着变', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  if (!dom.nodes.get('speechEngineSystem').checked) throw new Error('前置条件：默认应该是系统语音');
  // 模拟别的地方改了配置（主进程广播 settings:changed）
  api.emit('settingsChanged', baseSettings({ speech: { engine: 'cloud', fallbackToSystem: true } }));
  await drain(8);
  if (!dom.nodes.get('speechEngineCloud').checked) throw new Error('配置改了，界面没跟着变');
});

// ---------------------------------------------------------------- 联网怎么查（两条路可选）

test('联网怎么查：默认选自研搜索，单选和提示行都要说明白', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  if (!dom.nodes.get('searchModeSelf').checked) throw new Error('默认应该选自研搜索接口');
  if (dom.nodes.get('searchModeModel').checked) throw new Error('默认不该选老办法');
  const line = dom.nodes.get('searchModeLine').textContent;
  if (!line.includes('自研搜索')) throw new Error(`提示行没说明现在走哪条：${line}`);
});

test('联网怎么查：配置选了老办法，界面要跟着勾（重启后别显示错）', async () => {
  const { dom, ready } = bootPanel(baseSettings({ knowledge: { searchMode: 'model' } }));
  await ready();
  if (!dom.nodes.get('searchModeModel').checked) throw new Error('配置是模型联网，界面却没勾上');
  if (dom.nodes.get('searchModeSelf').checked) throw new Error('配置是老办法，却还勾着自研搜索');
  if (!dom.nodes.get('searchModeLine').textContent.includes('模型联网')) {
    throw new Error(`提示行没跟着变：${dom.nodes.get('searchModeLine').textContent}`);
  }
});

test('联网怎么查：换挡会存进配置，两条路随时能切回来', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  const model = dom.nodes.get('searchModeModel');
  model.checked = true;
  model.dispatch('change');
  await drain(6);
  const saved = api._calls.filter((call) => call.name === 'settings.update').pop();
  if (!saved || !saved.args[0].knowledge || saved.args[0].knowledge.searchMode !== 'model') {
    throw new Error(`换挡没有保存: ${JSON.stringify(saved && saved.args[0])}`);
  }
});

test('联网怎么查：主进程广播配置改了，单选也要跟着变', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  if (!dom.nodes.get('searchModeSelf').checked) throw new Error('前置条件：默认应该是自研搜索');
  api.emit('settingsChanged', baseSettings({ knowledge: { searchMode: 'model' } }));
  await drain(8);
  if (!dom.nodes.get('searchModeModel').checked) throw new Error('配置改了，界面没跟着变');
});

// ---------------------------------------------------------------- DSH 已下线（只藏不删）

test('DSH 已下线：那张卡必须是收起来的（引擎钉死 builtin，露出来就是骗人）', async () => {
  // 2026-10-19 的下线方式：不删代码，只把 #dshCard 加 hidden、把 main.js 的 engine 钉成 builtin。
  // 这条守着「没被谁顺手把 hidden 去掉」——一旦去掉，面板上会出现一张点了没反应的卡。
  // 真要恢复 DSH：删掉这条测试 + 交接文档 §6.16 的清单（audit.js 里也有对应断言）。
  const { dom, ready } = bootPanel();
  await ready();
  const card = dom.nodes.get('dshCard');
  if (!card) throw new Error('index.html 里找不到 #dshCard（DSH 卡连壳都没了？）');
  if (card.hidden !== true) throw new Error('DSH 卡没有收起（hidden 被去掉了？）');
  // 里面的按钮还在 DOM 里（只是看不见）——这是「只藏不删」的预期形状
  if (!dom.nodes.get('dshRun') || !dom.nodes.get('dshDetect')) {
    throw new Error('DSH 卡里的控件被删了（保留它们是为了将来恢复时不用重写界面逻辑）');
  }
});

// ---------------------------------------------------------------- DSH 环境门禁
test('DSH：没检测过时不让开始任务', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  if (!dom.nodes.get('dshRun').disabled) throw new Error('还没检测就让点「开始整理」了');
  if (!dom.nodes.get('dshStatusLine').textContent.includes('还没检测')) {
    throw new Error(`状态行没说清楚：${dom.nodes.get('dshStatusLine').textContent}`);
  }
  if (dom.nodes.get('dshCancel').hidden !== true) throw new Error('没在跑任务时不该显示「中止」');
});

test('DSH：检测不通过时逐项说明缺什么、怎么补，并且拒绝开始', async () => {
  const { dom, api, ready } = bootPanel();
  api._dsh.detect = {
    ok: false,
    checkedAt: '2026-10-15T02:00:00.000Z',
    checks: [
      { key: 'node', label: '系统 Node', ok: true, detail: 'node → v24.21.0' },
      {
        key: 'dsh',
        label: 'DSH 包',
        ok: false,
        detail: '没找到 @deepseek-ai/dsh',
        hint: '命令行执行一次：npm i -g @deepseek-ai/dsh（装完重开软件）'
      }
    ]
  };
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  const checks = dom.nodes.get('dshChecks').children.map((row) => row.textContent).join(' | ');
  if (!checks.includes('✅ 系统 Node')) throw new Error(`没画出通过的项：${checks}`);
  if (!checks.includes('❌ DSH 包')) throw new Error(`没画出不通过的项：${checks}`);
  if (!checks.includes('怎么补')) throw new Error(`没给出补救办法：${checks}`);
  if (!dom.nodes.get('dshRun').disabled) throw new Error('环境不通过时不该允许开始任务');
  if (!dom.nodes.get('dshStatusLine').textContent.includes('还不完整')) {
    throw new Error(`状态行没说清楚：${dom.nodes.get('dshStatusLine').textContent}`);
  }
});

test('DSH：检测通过后才解锁「开始整理」，并且会把任务发给主进程', async () => {
  // 前置：工作区说明已确认过（「第一次先告知」那条流程另有专门用例）
  const { dom, api, ready } = bootPanel(baseSettings({ knowledge: { dshWorkspaceNoticeSeen: true } }));
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  if (dom.nodes.get('dshRun').disabled) throw new Error('检测通过了还是不让开始');
  if (!dom.nodes.get('dshStatusLine').textContent.includes('环境没问题')) {
    throw new Error(`状态行不对：${dom.nodes.get('dshStatusLine').textContent}`);
  }
  if (!dom.nodes.get('dshStatusLine').textContent.includes('0.1.5-rc.1')) {
    throw new Error('状态行应该带上 DSH 版本，方便排查');
  }

  api._calls.length = 0;
  dom.nodes.get('dshTask').value = '把 inbox 里的清单整理成知识';
  dom.nodes.get('dshRun').dispatch('click');
  await drain(12);
  const asked = api._calls.filter((c) => c.name === 'dsh.run').pop();
  if (!asked || asked.args[0].task !== '把 inbox 里的清单整理成知识') {
    throw new Error(`任务没发对：${JSON.stringify(asked && asked.args)}`);
  }
  if (!dom.nodes.get('dshOutput').textContent.includes('跑完了')) {
    throw new Error(`没显示跑完的摘要：${dom.nodes.get('dshOutput').textContent}`);
  }
});

test('DSH：任务内容为空时本地就拦住，不打扰主进程', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  api._calls.length = 0;
  dom.nodes.get('dshTask').value = '   ';
  dom.nodes.get('dshRun').dispatch('click');
  await drain(8);
  if (api._calls.some((c) => c.name === 'dsh.run')) throw new Error('空任务不该发出去');
});

test('DSH：改了路径就让上一次检测作废（免得按钮亮着但其实环境变了）', async () => {
  const { dom, timers, ready } = bootPanel();
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  if (dom.nodes.get('dshRun').disabled) throw new Error('前置条件：检测应已通过');

  const nodePath = dom.nodes.get('dshNode');
  nodePath.value = 'D:\\nodejs\\node.exe';
  nodePath.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(8);
  if (!dom.nodes.get('dshRun').disabled) throw new Error('路径改了还让点开始，会出现"检测过了"的错觉');
  if (!dom.nodes.get('dshStatusLine').textContent.includes('重新点一次')) {
    throw new Error(`状态行没提示重新检测：${dom.nodes.get('dshStatusLine').textContent}`);
  }
});

// ---------------------------------------------------------------- DSH 工作区（限定在「知识库」）

test('DSH 工作区：界面直接写明它被关在哪个文件夹里，并能一键打开', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  const path = dom.nodes.get('dshWorkspacePath').textContent;
  if (!path.includes('D:\\demo\\知识库')) throw new Error(`工作区路径没显示出来：${path}`);
  const hint = dom.nodes.get('dshWorkspaceHint').textContent;
  if (!hint.includes('只能')) throw new Error(`没说清 DSH 只能在那个文件夹里读写：${hint}`);
  if (!hint.includes('沙箱')) throw new Error(`该说清楚是谁在拦（DSH 自己的沙箱），免得以为只是界面限制：${hint}`);

  api._calls.length = 0;
  dom.nodes.get('dshOpenWorkspace').dispatch('click');
  await drain(8);
  if (!api._calls.some((c) => c.name === 'knowledge.openFolder')) {
    throw new Error('「打开工作区」没走打开文件夹的接口');
  }
});

test('DSH 工作区：第一次开始整理先告知工作区，确认了才真的跑', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  api._calls.length = 0;
  dom.nodes.get('dshTask').value = '整理一下资料';
  dom.nodes.get('dshRun').dispatch('click');
  await drain(8);

  if (dom.nodes.get('modalMask').hidden) throw new Error('第一次用 DSH 该先告诉用户工作区被限定在哪');
  const said = dom.nodes.get('modalText').textContent;
  if (!said.includes('D:\\demo\\知识库')) throw new Error(`告知里要给出具体路径：${said}`);
  if (api._calls.some((c) => c.name === 'dsh.run')) throw new Error('还没确认就把任务发出去了');

  // 取消 = 什么都不做
  dom.nodes.get('modalCancel').dispatch('click');
  await drain(8);
  if (api._calls.some((c) => c.name === 'dsh.run')) throw new Error('取消之后不该跑');
  if (!dom.nodes.get('modalMask').hidden) throw new Error('取消后遮罩必须收掉（不然界面被挡住）');

  // 再来一次：确认后既要记住，也要接着把任务跑起来
  dom.nodes.get('dshRun').dispatch('click');
  await drain(8);
  if (dom.nodes.get('modalMask').hidden) throw new Error('没确认过就该再告知一次');
  dom.nodes.get('modalOk').dispatch('click');
  await drain(16);

  const saved = api._calls
    .filter((c) => c.name === 'settings.update')
    .map((c) => c.args[0].knowledge)
    .filter(Boolean)
    .pop();
  if (!saved || saved.dshWorkspaceNoticeSeen !== true) throw new Error(`确认后要记住，实际存了 ${JSON.stringify(saved)}`);
  if (!api._calls.some((c) => c.name === 'dsh.run')) throw new Error('确认之后应该接着跑，而不是让用户再点一次');
});

test('DSH 工作区：告知过一次就不再拦（别每次都弹）', async () => {
  const { dom, api, ready } = bootPanel(baseSettings({ knowledge: { dshWorkspaceNoticeSeen: true } }));
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  api._calls.length = 0;
  dom.nodes.get('dshTask').value = '整理一下资料';
  dom.nodes.get('dshRun').dispatch('click');
  await drain(16);
  if (!dom.nodes.get('modalMask').hidden) throw new Error('看过之后就不要再弹了');
  if (!api._calls.some((c) => c.name === 'dsh.run')) throw new Error('看过之后应该直接跑');
});

test('她自己动库的权限：档位和次数按配置回填，改了会存进设置', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  if (dom.nodes.get('selfEdit').value !== 'auto') {
    throw new Error(`档位没回填默认值（应该是「直接改」）：${dom.nodes.get('selfEdit').value}`);
  }
  if (String(dom.nodes.get('selfEditPerHour').value) !== '10') {
    throw new Error(`次数上限没回填：${dom.nodes.get('selfEditPerHour').value}`);
  }
  api._calls.length = 0;
  const select = dom.nodes.get('selfEdit');
  select.value = 'ask';
  select.dispatch('change');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(10);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].knowledge.selfEdit !== 'ask') {
    throw new Error(`档位没存对：${JSON.stringify(saved && saved.args[0])}`);
  }

  api._calls.length = 0;
  const perHour = dom.nodes.get('selfEditPerHour');
  perHour.value = '3';
  perHour.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(10);
  const saved2 = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved2 || Number(saved2.args[0].knowledge.selfEditPerHour) !== 3) {
    throw new Error(`次数没存对：${JSON.stringify(saved2 && saved2.args[0])}`);
  }
});

test('知识库改动记录：默认折叠，标题旁给摘要；点「展开」才铺开', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.edits = [
    { id: 'e-1/2026', noteId: 'k-1', title: '终末地', kind: 'edit', chars: 20, afterChars: 46, reason: '', savedAt: '2026-10-16T14:05:17.485Z', hasBackup: true, undone: false },
    { id: 'e-2/2026', noteId: 'k-2', title: '甲', kind: 'create', chars: 0, afterChars: 24, reason: '', savedAt: '2026-10-16T14:05:18.000Z', hasBackup: false, undone: true }
  ];
  await ready();

  // 默认收着：整块内容不占地方，但标题旁要能看出「有几条」
  if (dom.nodes.get('editsBody').hidden !== true) throw new Error('改动记录默认应该是折叠的');
  // ⚠️ 光看 `hidden` 属性不够：`.form{display:flex}` 会把 `[hidden]` 的 display:none 顶掉，
  // 真机上就出现过「按钮变「展开」了、记录还摆在那儿」。所以还要看真正的样式
  if (dom.nodes.get('editsBody').style.display !== 'none') {
    throw new Error(`折叠时应该真的隐藏（display:none），实际 display="${dom.nodes.get('editsBody').style.display}"`);
  }
  if (dom.nodes.get('editsToggle').textContent !== '展开') {
    throw new Error(`折叠时按钮应该写「展开」：${dom.nodes.get('editsToggle').textContent}`);
  }
  if (!dom.nodes.get('editsSummary').textContent.includes('2 次改动')) {
    throw new Error(`摘要要写清有几条：${dom.nodes.get('editsSummary').textContent}`);
  }
  if (!dom.nodes.get('editsSummary').textContent.includes('1 条已撤销')) {
    throw new Error(`摘要要标出已撤销的：${dom.nodes.get('editsSummary').textContent}`);
  }

  // 点「展开」：内容出来、按钮变「收起」
  dom.nodes.get('editsToggle').dispatch('click');
  await drain(14);
  if (dom.nodes.get('editsBody').hidden !== false) throw new Error('点了展开还是收着');
  if (dom.nodes.get('editsBody').style.display === 'none') throw new Error('展开后不该还带 display:none');
  if (dom.nodes.get('editsToggle').textContent !== '收起') {
    throw new Error(`展开后按钮应该写「收起」：${dom.nodes.get('editsToggle').textContent}`);
  }
  if (!dom.nodes.get('editsList').textContent.includes('终末地')) {
    throw new Error(`展开后应该重读并画出记录：${dom.nodes.get('editsList').textContent}`);
  }

  // 再点一下收回去
  dom.nodes.get('editsToggle').dispatch('click');
  await drain(8);
  if (dom.nodes.get('editsBody').hidden !== true) throw new Error('再点一下应该收回去');
  if (dom.nodes.get('editsToggle').textContent !== '展开') throw new Error('收回去后按钮该变回「展开」');
});

test('知识库改动记录：她改的 / 新建的都画出来，点撤销走 knowledge.undoEdit', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.edits = [
    {
      id: 'k-1/2026',
      noteId: 'k-1',
      title: '终末地',
      kind: 'edit',
      chars: 20,
      afterChars: 46,
      reason: '公测时间写错了',
      savedAt: '2026-10-16T14:05:17.485Z',
      hasBackup: true,
      undone: false
    },
    { id: 'k-2/2026', noteId: 'k-2', title: '下周六联动', kind: 'create', chars: 0, afterChars: 24, reason: '', savedAt: '2026-10-16T14:05:18.000Z', hasBackup: false, undone: false }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(14);

  const text = dom.nodes.get('editsList').textContent;
  if (!text.includes('✏️ 改错：终末地')) throw new Error(`没画出改错记录：${text}`);
  if (!text.includes('🆕 新建：下周六联动')) throw new Error(`没画出新建记录：${text}`);
  if (!text.includes('20 → 46 字')) throw new Error(`该显示字数变化：${text}`);
  if (!text.includes('公测时间写错了')) throw new Error(`该显示她为什么改：${text}`);
  if (!dom.nodes.get('editsHint').textContent.includes('.history')) {
    throw new Error(`提示该说清备份在哪：${dom.nodes.get('editsHint').textContent}`);
  }

  api._calls.length = 0;
  const firstRow = dom.nodes.get('editsList').children[0];
  const actions = firstRow.children.find((child) => child.className === 'actions');
  actions.children[0].dispatch('click');
  await drain(16);
  const call = api._calls.find((c) => c.name === 'knowledge.undoEdit');
  if (!call || call.args[0] !== 'k-1/2026') throw new Error(`没走 knowledge.undoEdit：${JSON.stringify(call && call.args)}`);
  const toastText = dom.nodes.get('toastWrap') ? dom.nodes.get('toastWrap').textContent : '';
  if (!toastText.includes('恢复')) throw new Error(`该提示恢复成功：${toastText}`);
  if (!dom.nodes.get('editsList').textContent.includes('已撤销')) {
    throw new Error(`撤销后按钮该变成「已撤销」：${dom.nodes.get('editsList').textContent}`);
  }
});

test('知识库改动记录：撤销失败要把原因说出来', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.edits = [
    { id: 'k-9/2026', noteId: 'k-9', title: '甲', kind: 'manual', chars: 10, afterChars: 12, reason: '', savedAt: '2026-10-16T14:05:19.000Z', hasBackup: true, undone: false }
  ];
  api._knowledge.undoResult = { ok: false, reason: '备份读不出来（文件没了）' };
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(14);
  const row = dom.nodes.get('editsList').children[0];
  row.children.find((child) => child.className === 'actions').children[0].dispatch('click');
  await drain(16);
  const toastText = dom.nodes.get('toastWrap') ? dom.nodes.get('toastWrap').textContent : '';
  if (!toastText.includes('备份读不出来')) throw new Error(`该把失败原因说出来：${toastText}`);
});

test('最高权限：开关和两个上限按配置回填，提示语分得清「开着 / 关着」', async () => {
  const { dom, api, timers, ready } = bootPanel(
    baseSettings({ agent: { maxPermissions: true, searchPerHour: 3, toolsPerHour: 8 } })
  );
  await ready();
  if (!dom.nodes.get('maxPermissions').checked) throw new Error('开关没回填（配置里是开的）');
  if (String(dom.nodes.get('maxSearchPerHour').value) !== '3') {
    throw new Error(`联网上限没回填：${dom.nodes.get('maxSearchPerHour').value}`);
  }
  if (String(dom.nodes.get('maxToolsPerHour').value) !== '8') {
    throw new Error(`工具上限没回填：${dom.nodes.get('maxToolsPerHour').value}`);
  }
  if (!dom.nodes.get('maxPermHint').textContent.includes('已开启')) {
    throw new Error(`开着的时候提示语要说清：${dom.nodes.get('maxPermHint').textContent}`);
  }
  // 卡片上要写清她能做什么、以及任何档位都不给什么
  const detail = dom.nodes.get('maxPermDetail').textContent;
  for (const need of ['自己决定', '自己写进知识库', '软件功能', '删掉', '弹幕', '只读']) {
    if (!detail.includes(need)) throw new Error(`说明里少了「${need}」：${detail}`);
  }
  // 它现在挂在「DeepSeek API」页（跟模型设置放一起），不在知识库页
  const card = dom.nodes.get('maxPermissions');
  let page = null;
  let node = card;
  while (node && !page) {
    if (node.id === 'tab-api' || node.id === 'tab-knowledge') page = node.id;
    node = node.parentNode;
  }
  if (page !== 'tab-api') throw new Error(`「最高权限」该在 DeepSeek API 页里，实际在：${page}`);

  api._calls.length = 0;
  const box = dom.nodes.get('maxPermissions');
  box.checked = false;
  box.dispatch('change');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(10);
  if (!dom.nodes.get('maxPermHint').textContent.includes('默认关着')) {
    throw new Error(`关掉之后提示语要变：${dom.nodes.get('maxPermHint').textContent}`);
  }
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].agent.maxPermissions !== false) {
    throw new Error(`开关没存对：${JSON.stringify(saved && saved.args[0])}`);
  }
});

test('待办：想删的那条也画出来，按钮是「让她删」', async () => {
  const { dom, api, ready } = bootPanel();
  api._research.items = [
    { id: 'r1', kind: 'remove', text: '早就过时的梗', reason: '没人提了', source: '来自 主播 的要求', status: 'pending' }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(12);
  const text = dom.nodes.get('researchList').textContent;
  if (!text.includes('🗑 想删：早就过时的梗')) throw new Error(`没画出「想删」：${text}`);
  const row = dom.nodes.get('researchList').children[0];
  const actions = row.children.find((child) => child.className === 'actions');
  const button = actions.children.find((child) => child.textContent === '让她删');
  if (!button) throw new Error(`想删那条要有「让她删」按钮：${actions.children.map((b) => b.textContent).join('/')}`);
  api._calls.length = 0;
  button.dispatch('click');
  await drain(14);
  if (!api._calls.some((c) => c.name === 'research.note' && c.args[0] === 'r1')) {
    throw new Error('「让她删」也该走 research.note（按类型分派在主进程）');
  }
});

test('快捷提示：待办弹出带按钮的提示，点「去查」直接办、点「不用管」直接忽略', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api._research.items = [{ id: 'r-q', kind: 'lookup', text: '星轨杯', reason: '', source: '', status: 'pending' }];
  api.emit('research', api._research.items);
  await drain(10);

  const wrap = dom.nodes.get('toastWrap');
  const actionToasts = wrap.querySelectorAll('.toast-action');
  if (actionToasts.length !== 1) throw new Error(`应该弹一条能点的提示，实际 ${actionToasts.length}`);
  const buttons = actionToasts[0].querySelectorAll('.btn');
  const labels = buttons.map((b) => b.textContent);
  if (!labels.includes('去查') || !labels.includes('不用管')) {
    throw new Error(`提示上的按钮不对：${labels.join('/')}`);
  }

  api._calls.length = 0;
  buttons.find((b) => b.textContent === '去查').dispatch('click');
  await drain(18);
  if (!api._calls.some((c) => c.name === 'research.run' && c.args[0] === 'r-q')) {
    throw new Error('点了「去查」没走 research.run');
  }
  // 收掉提示走的是「淡出 320ms 再移除」，测试里要把定时器推一下
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(6);
  if (wrap.querySelectorAll('.toast-action').length !== 0) throw new Error('点完按钮后提示应该收掉');
});

test('快捷提示：点「不用管」= ignore 掉那条待办', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._research.items = [{ id: 'r-n', kind: 'note', text: '下周六联动', reason: '', source: '', status: 'pending' }];
  api.emit('research', api._research.items);
  await drain(10);
  const toastNode = dom.nodes.get('toastWrap').querySelectorAll('.toast-action')[0];
  if (!toastNode) throw new Error('没弹出快捷提示');
  const labels = toastNode.querySelectorAll('.btn').map((b) => b.textContent);
  if (!labels.includes('记进知识库')) throw new Error(`想记的提示该给「记进知识库」：${labels.join('/')}`);
  api._calls.length = 0;
  toastNode.querySelectorAll('.btn').find((b) => b.textContent === '不用管').dispatch('click');
  await drain(14);
  if (!api._calls.some((c) => c.name === 'research.ignore' && c.args[0] === 'r-n')) {
    throw new Error('点了「不用管」没走 research.ignore');
  }
});

test('快捷提示：查完弹出「全部通过」，一次把待审草稿都通过掉', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.pending = [
    { id: 'p1', title: '星轨杯', content: 'x', tags: [], source: '', engine: 'builtin' },
    { id: 'p2', title: '无限机兵', content: 'y', tags: [], source: '', engine: 'builtin' }
  ];
  api.emit('draftsReady', { count: 2, titles: ['星轨杯', '无限机兵'], source: 'query', autoApproved: 0 });
  await drain(10);

  const toastNode = dom.nodes.get('toastWrap').querySelectorAll('.toast-action')[0];
  if (!toastNode) throw new Error('没弹出「有草稿进待审」的提示');
  const text = toastNode.textContent;
  if (!text.includes('2 条')) throw new Error(`提示要说清几条：${text}`);
  if (!text.includes('星轨杯')) throw new Error(`提示里带个标题更好认：${text}`);

  api._calls.length = 0;
  toastNode.querySelectorAll('.btn').find((b) => b.textContent === '全部通过').dispatch('click');
  await drain(22);
  const approved = api._calls.filter((c) => c.name === 'knowledge.approve').map((c) => c.args[0]);
  if (approved.length !== 2 || !approved.includes('p1') || !approved.includes('p2')) {
    throw new Error(`应该通过这两条草稿，实际：${approved.join('/')}`);
  }
});

test('快捷提示：最高权限开着时只提示、不弹按钮（她会自己办，别重复点）', async () => {
  const { dom, api, ready } = bootPanel(baseSettings({ agent: { maxPermissions: true } }));
  await ready();
  api.emit('research', [{ id: 'r-m', kind: 'lookup', text: '星轨杯', reason: '', source: '', status: 'pending' }]);
  await drain(10);
  const wrap = dom.nodes.get('toastWrap');
  if (wrap.querySelectorAll('.toast-action').length !== 0) throw new Error('最高权限开着时不该弹按钮');
  if (!wrap.textContent.includes('最高权限')) throw new Error(`该说明她自己会办：${wrap.textContent}`);
});

test('快捷提示：带按钮的提示不会自己消失（4 秒后还在）', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api.emit('draftsReady', { count: 1, titles: ['甲'], source: 'query', autoApproved: 0 });
  await drain(8);
  // 把所有到点的定时器都推一遍（普通 toast 会在这里消失）
  for (let round = 0; round < 3; round += 1) {
    for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
    await drain(4);
  }
  const left = dom.nodes.get('toastWrap').querySelectorAll('.toast-action');
  if (left.length !== 1) throw new Error(`能点的提示不该自动消失，实际剩 ${left.length} 条`);
});

test('待审草稿：查完的草稿要自己冒出来（回归：弹窗能点通过，面板里却看不到）', async () => {
  // 主播报的问题：她在对话里回「查」之后，右下角弹窗能点「全部通过」，说明草稿确实写进去了；
  // 但知识库页的「待审草稿」一直是空的。原因：`drafts:ready` 的处理函数当时**只弹提示**，
  // 没有重新读一次待审列表 —— 只有「从面板点去查」那条路会顺带刷新（`runResearchAsync` 里刷的）。
  const { dom, api, ready } = bootPanel();
  await ready();
  if (dom.nodes.get('pendingList').textContent.includes('星轨杯')) {
    throw new Error('前置条件：待审草稿里不该已经有它');
  }
  // 主进程那边刚写好一条草稿
  api._knowledge.pending = [
    { id: 'p1', title: '星轨杯', content: '社区赛事，奖金 5 万。', tags: ['赛事'], source: '联网查 · 星轨杯', engine: '自研搜索' }
  ];
  api.emit('draftsReady', { count: 1, titles: ['星轨杯'], source: 'query', autoApproved: 0 });
  await drain(14);
  const text = dom.nodes.get('pendingList').textContent;
  if (!text.includes('星轨杯')) throw new Error(`待审草稿没跟着刷新，面板上还是：${text || '(空)'}`);
  if (!dom.nodes.get('pendingHint').textContent.includes('1 条')) {
    throw new Error(`提示行也该变成 1 条：${dom.nodes.get('pendingHint').textContent}`);
  }
});

test('DSH：模型字段按配置回填，改了会存进设置（默认 4.1 Flash）', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  if (dom.nodes.get('dshModel').value !== 'deepseek-flash') {
    throw new Error(`模型字段没回填默认值：${dom.nodes.get('dshModel').value}`);
  }
  // 超时字段（顺手补上的，以前只能在配置里改）
  if (dom.nodes.get('dshTimeoutSec').value !== '300') {
    throw new Error(`超时字段没回填：${dom.nodes.get('dshTimeoutSec').value}`);
  }
  api._calls.length = 0;
  const input = dom.nodes.get('dshModel');
  input.value = 'deepseek-v4-pro';
  input.dispatch('input');
  // 文本字段是防抖保存的，测试里要把定时器推一下
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(10);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].knowledge.dshModel !== 'deepseek-v4-pro') {
    throw new Error(`模型没存对：${JSON.stringify(saved && saved.args[0])}`);
  }
});

test('DSH：会话 id 存下来后小字里能对上（ACP 的 id 由 DSH 生成）', async () => {
  const { dom, ready } = bootPanel(
    baseSettings({ knowledge: { dshSessionId: '0f0a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b' } })
  );
  await ready();
  const hint = dom.nodes.get('dshSessionHint').textContent;
  if (!hint.includes('0f0a1b2c-3d4e-5f60-7a8b-9c0d1e2f3a4b')) {
    throw new Error(`小字里该显示当前会话 id（用户拿它去 DSH Web 里对）：${hint}`);
  }
  if (!hint.includes('第一句话')) {
    throw new Error(`该说明「名字会作为新会话第一句话的开头」：${hint}`);
  }
  if (!hint.includes('重启')) {
    // DSH 只在启动时读工作区登记表，正在开着的 Web 看不到新归组 —— 必须提示重启，
    // 否则用户会以为「会话没归到工作区」（真发生过）
    throw new Error(`该提示「正在开着的 DSH Web 要重启才看得到归组」：${hint}`);
  }
});

test('DSH：中止走 ACP 的取消（会话留着），提示里说清后果', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  dom.nodes.get('dshCancel').dispatch('click');
  await drain(10);
  if (!api._calls.some((c) => c.name === 'dsh.cancel')) throw new Error('中止按钮没走取消接口');
  const toastText = dom.nodes.get('toastWrap') ? dom.nodes.get('toastWrap').textContent : '';
  if (!toastText.includes('会话留着')) {
    throw new Error(`提示该说清「会话留着，可以直接再发一条」：${toastText}`);
  }
});

test('DSH：被拒绝的越界操作会在输出里说明（不然用户以为它坏了）', async () => {
  const { dom, api, ready } = bootPanel(baseSettings({ knowledge: { dshWorkspaceNoticeSeen: true } }));
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  api._dsh.run = { ok: true, output: '整理好了', ms: 1000, mode: 'session', sessionId: 's-1', drafts: [], denied: 2 };
  dom.nodes.get('dshTask').value = '读一下我桌面上的表格';
  dom.nodes.get('dshRun').dispatch('click');
  await drain(16);
  const text = dom.nodes.get('dshOutput').textContent;
  if (!text.includes('被拒绝')) throw new Error(`该说明有操作被拒：${text}`);
  if (!text.includes('工作区被限定')) throw new Error(`该顺带说明原因：${text}`);
});

// ---------------------------------------------------------------- 模型想查 / 想记

test('待办：模型提的「想查 / 想记」会画出来，并按类型给不同按钮', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.items = [];
  api._research.items = [
    { id: 'r1', kind: 'lookup', text: '明日方舟', reason: '观众提到了新游戏', source: '来自 小明 的消息', status: 'pending' },
    { id: 'r2', kind: 'note', text: '下周有明日方舟联动', reason: '', source: '来自 主播 的消息', status: 'pending' }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(12);

  const text = dom.nodes.get('researchList').textContent;
  if (!text.includes('🔎 想查：明日方舟')) throw new Error(`没画出「想查」：${text}`);
  if (!text.includes('📝 想记：下周有明日方舟联动')) throw new Error(`没画出「想记」：${text}`);
  if (!text.includes('观众提到了新游戏')) throw new Error(`没画出「为什么」：${text}`);
  const buttons = dom.nodes.get('researchList').children.map((row) =>
    (row.children || []).filter((child) => child.className === 'actions').map((box) => box.children.map((b) => b.textContent))
  );
  const flat = buttons.flat(3);
  if (!flat.includes('去查')) throw new Error(`想查那条要有「去查」按钮，实际：${flat.join('/')}`);
  if (!flat.includes('记进知识库')) throw new Error(`想记那条要有「记进知识库」按钮，实际：${flat.join('/')}`);
  if (!flat.includes('不用管')) throw new Error(`每条都该有「不用管」：${flat.join('/')}`);
  if (!dom.nodes.get('researchHint').textContent.includes('点「去查」才会真去联网查')) {
    throw new Error(`提示要说清「点了才会花钱查」：${dom.nodes.get('researchHint').textContent}`);
  }
  // 她会主动在对话里问一句，回「查」/「记」就去办 —— 这条得写在提示里，
  // 不然主播只会盯着卡片，不知道可以直接回话
  if (!dom.nodes.get('researchHint').textContent.includes('回「查」')) {
    throw new Error(`提示要说清「直接回她一句就行」：${dom.nodes.get('researchHint').textContent}`);
  }
  // 主播也能自己点名（「查一下 XXX」），提示里同样要说
  if (!dom.nodes.get('researchHint').textContent.includes('查一下')) {
    throw new Error(`提示要说清「可以直接在输入框点名让她查」：${dom.nodes.get('researchHint').textContent}`);
  }
});

test('待办：点「去查」真的走 research.run，查完提示去待审里点通过', async () => {
  const { dom, api, ready } = bootPanel();
  api._research.items = [{ id: 'r1', kind: 'lookup', text: '明日方舟', reason: '', source: '', status: 'pending' }];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(12);
  api._calls.length = 0;

  const row = dom.nodes.get('researchList').children[0];
  const actions = row.children.find((child) => child.className === 'actions');
  const runBtn = actions.children.find((child) => child.textContent === '去查');
  runBtn.dispatch('click');
  await drain(16);

  const asked = api._calls.filter((c) => c.name === 'research.run').pop();
  if (!asked || asked.args[0] !== 'r1') throw new Error(`没走 research.run：${JSON.stringify(asked && asked.args)}`);
  const toastText = dom.nodes.get('toastWrap') ? dom.nodes.get('toastWrap').textContent : '';
  if (!toastText.includes('待审草稿')) throw new Error(`该提示结果进了待审：${toastText}`);
  if (!dom.nodes.get('researchList').textContent.includes('已完成')) {
    throw new Error(`查完要刷新状态：${dom.nodes.get('researchList').textContent}`);
  }
});

test('待办：「记进知识库」不联网（走 research.note），「不用管」走 ignore', async () => {
  const { dom, api, ready } = bootPanel();
  api._research.items = [
    { id: 'r1', kind: 'note', text: '下周有联动', reason: '', source: '', status: 'pending' },
    { id: 'r2', kind: 'lookup', text: '别的游戏', reason: '', source: '', status: 'pending' }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(12);
  api._calls.length = 0;

  const rows = dom.nodes.get('researchList').children;
  const noteActions = rows[0].children.find((child) => child.className === 'actions');
  noteActions.children.find((child) => child.textContent === '记进知识库').dispatch('click');
  await drain(14);
  if (!api._calls.some((c) => c.name === 'research.note' && c.args[0] === 'r1')) {
    throw new Error('「记进知识库」没走 research.note');
  }
  if (api._calls.some((c) => c.name === 'research.run')) throw new Error('「记一笔」不该联网查');

  api._calls.length = 0;
  const lookupActions = dom.nodes.get('researchList').children[1].children.find((child) => child.className === 'actions');
  lookupActions.children.find((child) => child.textContent === '不用管').dispatch('click');
  await drain(12);
  if (!api._calls.some((c) => c.name === 'research.ignore' && c.args[0] === 'r2')) {
    throw new Error('「不用管」没走 research.ignore');
  }
});

test('待办：模型刚提新需求时，面板冒提示（不然主播注意不到它在「申请」）', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api.emit('research', [
    { id: 'r-new', kind: 'lookup', text: '明日方舟', reason: '观众提到了新游戏', source: '', status: 'pending' }
  ]);
  await drain(10);
  const toastText = dom.nodes.get('toastWrap') ? dom.nodes.get('toastWrap').textContent : '';
  if (!toastText.includes('明日方舟')) throw new Error(`提示里要带上内容：${toastText}`);
  if (!dom.nodes.get('researchList').textContent.includes('明日方舟')) {
    throw new Error('事件到了要立刻画出来');
  }
});

// ---------------------------------------------------------------- 待审草稿

test('待审：草稿会列出来，通过 / 丢弃各走各的接口', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.pending = [
    { id: 'p1', title: '大肥鱼玩偶价格', content: '49 元，下单送贴纸', tags: ['商品'], source: 'DSH 整理', engine: 'dsh' },
    { id: 'p2', title: '直播间的梗', content: '吃白饭 = 调侃主播', tags: [], source: 'DSH 整理', engine: 'dsh' }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);

  const rows = dom.nodes.get('pendingList').children;
  const text = rows.map((row) => row.textContent).join(' | ');
  if (!text.includes('大肥鱼玩偶价格') || !text.includes('[dsh]')) {
    throw new Error(`草稿没画对：${text}`);
  }
  if (!dom.nodes.get('pendingHint').textContent.includes('2 条')) {
    throw new Error(`待审数量没显示：${dom.nodes.get('pendingHint').textContent}`);
  }

  const findButton = (label) => {
    const found = [];
    const walk = (node) => {
      if (node.textContent === label) found.push(node);
      for (const child of node.children || []) walk(child);
    };
    // ⚠️ 每次都重新取 children：渲染会 innerHTML='' 重建，抓着旧数组会点到上一轮的行
    for (const row of dom.nodes.get('pendingList').children) walk(row);
    return found[0];
  };
  api._calls.length = 0;
  findButton('通过').dispatch('click');
  await drain(10);
  const approved = api._calls.filter((c) => c.name === 'knowledge.approve').pop();
  if (!approved || approved.args[0] !== 'p1') throw new Error(`通过没走对接口：${JSON.stringify(approved && approved.args)}`);
  if (dom.nodes.get('pendingList').textContent.includes('大肥鱼玩偶价格')) {
    throw new Error('通过后该从待审列表里消失');
  }

  api._calls.length = 0;
  findButton('丢弃').dispatch('click');
  await drain(10);
  const rejected = api._calls.filter((c) => c.name === 'knowledge.reject').pop();
  if (!rejected || rejected.args[0] !== 'p2') throw new Error(`丢弃没走对接口：${JSON.stringify(rejected && rejected.args)}`);
});

test('待审：没有草稿时给一句提示，不空着', async () => {
  const { dom, ready } = bootPanel();
  await ready();
  const text = dom.nodes.get('pendingList').textContent;
  if (!text.includes('没有待审草稿')) throw new Error(`空的时候该有提示：${text}`);
});

test('待审：顶上「全部通过」要先确认，确认后一条条走 approve（每条都留新建记录）', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.pending = [
    { id: 'pa', title: '草稿 A', content: '内容 A', tags: [], source: '', engine: 'dsh' },
    { id: 'pb', title: '草稿 B', content: '内容 B', tags: [], source: '', engine: 'dsh' }
  ];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);
  const btn = dom.nodes.get('pendingApproveAll');
  if (!btn) throw new Error('没有「全部通过」按钮');
  if (btn.disabled) throw new Error('有草稿时「全部通过」不该灰着');

  // 取消 → 一条都不许动
  api._calls.length = 0;
  btn.dispatch('click');
  await drain(10);
  if (dom.nodes.get('modalMask').hidden) throw new Error('批量通过要先确认');
  dom.nodes.get('modalCancel').dispatch('click');
  await drain(10);
  if (api._calls.some((call) => call.name === 'knowledge.approve')) throw new Error('取消了还去通过');
  if (!dom.nodes.get('pendingHint').textContent.includes('2 条')) throw new Error('取消后草稿该原样都在');

  // 确认 → 每条都走 knowledge.approve（不是一次性覆盖），过完按钮变灰
  btn.dispatch('click');
  await drain(10);
  dom.nodes.get('modalOk').dispatch('click');
  await drain(20);
  const ids = api._calls.filter((call) => call.name === 'knowledge.approve').map((call) => call.args[0]);
  if (!ids.includes('pa') || !ids.includes('pb')) throw new Error(`两条都要走 approve：${JSON.stringify(ids)}`);
  if (!dom.nodes.get('toastWrap').textContent.includes('已通过')) {
    throw new Error(`要有结果提示：${dom.nodes.get('toastWrap').textContent}`);
  }
  if (!dom.nodes.get('pendingApproveAll').disabled) throw new Error('没有草稿时按钮要灰着');
  if (!dom.nodes.get('pendingHint').textContent.includes('先出现在这里')) {
    throw new Error(`过完要回到空状态：${dom.nodes.get('pendingHint').textContent}`);
  }
});

test('待审：顶上「清空待审」要先确认，且要说清知识库没动', async () => {
  const { dom, api, ready } = bootPanel();
  api._knowledge.pending = [{ id: 'p1', title: '草稿一', content: '内容', tags: [], source: '', engine: 'dsh' }];
  await ready();
  dom.nodes.get('knowledgeReload').dispatch('click');
  await drain(10);
  const btn = dom.nodes.get('pendingClear');
  if (!btn) throw new Error('没有「清空待审」按钮');

  // 取消 → 不清
  api._calls.length = 0;
  btn.dispatch('click');
  await drain(10);
  if (dom.nodes.get('modalMask').hidden) throw new Error('清空待审要先确认');
  dom.nodes.get('modalCancel').dispatch('click');
  await drain(10);
  if (api._calls.some((call) => call.name === 'knowledge.clearPending')) throw new Error('取消了还清空');

  btn.dispatch('click');
  await drain(10);
  dom.nodes.get('modalOk').dispatch('click');
  await drain(15);
  if (!api._calls.some((call) => call.name === 'knowledge.clearPending')) throw new Error('没走 knowledge.clearPending');
  if (!dom.nodes.get('toastWrap').textContent.includes('知识库没动')) {
    throw new Error(`要说清知识库没动：${dom.nodes.get('toastWrap').textContent}`);
  }
  if (dom.nodes.get('pendingList').textContent.includes('草稿一')) throw new Error('清完列表要空');
});

test('DSH：跑法单选按配置回填，切换会存进设置并改小字', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  // 默认是会话模式（能看见过程的那条）
  if (!dom.nodes.get('dshModeSession').checked) throw new Error('默认该是会话模式');
  if (dom.nodes.get('dshModeHeadless').checked) throw new Error('不该勾一次性模式');
  if (!dom.nodes.get('dshSessionHint').textContent.includes('还没建会话')) {
    throw new Error(`会话小字没说明「还没建会话」：${dom.nodes.get('dshSessionHint').textContent}`);
  }

  api._calls.length = 0;
  const headless = dom.nodes.get('dshModeHeadless');
  headless.checked = true;
  headless.dispatch('change');
  await drain(8);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].knowledge.dshMode !== 'headless') {
    throw new Error(`跑法没存对：${JSON.stringify(saved && saved.args[0])}`);
  }
  if (!dom.nodes.get('dshSessionHint').textContent.includes('一次性模式')) {
    throw new Error(`小字没跟着变：${dom.nodes.get('dshSessionHint').textContent}`);
  }
});

test('DSH：会话名改了会存进设置，小字跟着变', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  const input = dom.nodes.get('dshSessionName');
  input.value = 'my-kb';
  input.dispatch('input');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(8);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || saved.args[0].knowledge.dshSessionName !== 'my-kb') {
    throw new Error(`会话名没存对：${JSON.stringify(saved && saved.args[0])}`);
  }
  if (!dom.nodes.get('dshSessionHint').textContent.includes('my-kb')) {
    throw new Error(`小字没跟上：${dom.nodes.get('dshSessionHint').textContent}`);
  }
});

test('DSH：会话模式跑完后提示里带上会话名', async () => {
  // 前置：工作区说明已确认过（那条流程另有专门用例）
  const { dom, api, ready } = bootPanel(baseSettings({ knowledge: { dshWorkspaceNoticeSeen: true } }));
  await ready();
  dom.nodes.get('dshDetect').dispatch('click');
  await drain(10);
  api._dsh.run = { ok: true, output: 'ok', ms: 51000, mode: 'session', sessionId: 's', drafts: [{ id: 'p1' }] };
  dom.nodes.get('dshTask').value = '整理 inbox';
  dom.nodes.get('dshRun').dispatch('click');
  await drain(12);
  const text = dom.nodes.get('dshOutput').textContent;
  if (!text.includes('跑完了')) throw new Error(`没显示结果摘要：${text}`);
  // 状态行/输出里能看出它跑在会话模式（方便主播去 Web 找）
  if (!text.includes('秒')) throw new Error(`摘要里没写耗时：${text}`);
});

test('吉祥物：重命名走应用内输入框（回归：原来用原生 prompt，同样会卡死输入）', async () => {
  const { dom, api, sandbox, ready } = bootPanel();
  await ready();
  const grid = dom.nodes.get('imageGrid');
  if (!grid.children.length) throw new Error('前置条件：默认配置里应该有吉祥物图片');

  let nativePromptCalls = 0;
  sandbox.prompt = () => {
    nativePromptCalls += 1;
    return '新名字';
  };
  sandbox.window.prompt = sandbox.prompt;

  const findButton = (root, label) => {
    const found = [];
    const walk = (node) => {
      if (node.textContent === label) found.push(node);
      for (const child of node.children || []) walk(child);
    };
    walk(root);
    return found[0];
  };

  const tile = grid.children[0];
  findButton(tile, '重命名').dispatch('click');
  await drain(8);
  if (dom.nodes.get('modalMask').hidden) throw new Error('应该弹出应用内输入框');
  if (dom.nodes.get('modalInput').hidden) throw new Error('重命名要显示输入框');
  if (!dom.nodes.get('modalText').textContent.includes('起个名字')) {
    throw new Error(`提示文案不对：${dom.nodes.get('modalText').textContent}`);
  }

  api._calls.length = 0;
  dom.nodes.get('modalInput').value = '开心鱼';
  dom.nodes.get('modalOk').dispatch('click');
  await drain(10);
  if (!dom.nodes.get('modalMask').hidden) throw new Error('确定后遮罩要收掉');
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved || !saved.args[0].mascot || !saved.args[0].mascot.images || !saved.args[0].mascot.images['开心鱼']) {
    throw new Error(`重命名没生效：${JSON.stringify(saved && saved.args[0])}`);
  }
  if (nativePromptCalls !== 0) throw new Error('不该再用原生 prompt');
});

test('语音页：云音色试听会走 tts 接口，失败时给提示', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  dom.nodes.get('ttsTest').dispatch('click');
  await drain(8);
  const asked = api._calls.filter((c) => c.name === 'tts.synthesize');
  if (asked.length !== 1) throw new Error(`试听应该请求一次合成，实际 ${asked.length} 次`);
  if (!String(asked[0].args[0]).includes('云音色')) throw new Error(`试听文本不对: ${asked[0].args[0]}`);

  // 失败路径：不该抛出去，界面要给提示（这里只验证按钮恢复可用）
  api._tts.ok = false;
  api._calls.length = 0;
  dom.nodes.get('ttsTest').dispatch('click');
  await drain(8);
  if (dom.nodes.get('ttsTest').disabled) throw new Error('试听失败后按钮应该恢复可用');
});

// ---------------------------------------------------------------- 自定义表情（2026-10-19）

/** 迷你 DOM 里动态创建的节点不在 dom.nodes 里，只能走树找 */
function walkTree(root, visit) {
  if (!root) return;
  visit(root);
  for (const child of root.children || []) walkTree(child, visit);
}
function findInTree(root, predicate) {
  let found = null;
  walkTree(root, (node) => {
    if (!found && predicate(node)) found = node;
  });
  return found;
}

test('自定义表情：能加一个、能改「什么时候用」和别名', async () => {
  // 主播要的：内置 12 个不动，但能自己再加几个（生气、吃瓜…）
  const { dom, api, ready } = bootPanel();
  await ready();

  const addBtn = findInTree(dom.nodes.get('expressionGrid'), (node) => node.id === 'addEmotion');
  if (!addBtn) throw new Error('表情映射底下没有「添加自定义表情」按钮');
  if (addBtn.disabled) throw new Error('一个都没加时就该能点');
  if (!addBtn.textContent.includes(`0/${shared_MAX()}`)) {
    throw new Error(`按钮文案要带进度（0/上限）：${addBtn.textContent}`);
  }

  addBtn.dispatch('click');
  await drain(6);
  if (dom.nodes.get('modalMask').hidden) throw new Error('添加应该弹应用内输入框（不许用原生 prompt）');
  if (dom.nodes.get('modalInput').hidden) throw new Error('添加要用输入框模式');
  dom.nodes.get('modalInput').value = '生气';
  dom.nodes.get('modalOk').dispatch('click');
  await drain(12);

  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  const custom = saved && saved.args[0].mascot && saved.args[0].mascot.customEmotions;
  if (!Array.isArray(custom) || custom.length !== 1 || custom[0].key !== '生气') {
    throw new Error(`没把自定义表情存进配置：${JSON.stringify(saved && saved.args[0])}`);
  }

  // 那一行画出来了吗（自定义行带 data-custom 标记）
  const rows = dom.nodes
    .get('expressionGrid')
    .children.filter((node) => String(node.className || '').includes('expression-row'));
  const customRow = rows.find((node) => node.dataset && node.dataset.custom === '生气');
  if (!customRow) throw new Error('自定义表情那一行没画出来');

  const whenInput = findInTree(customRow, (node) => String(node.placeholder || '').includes('什么时候用'));
  if (!whenInput) throw new Error('自定义行缺「什么时候用」输入框');
  api._calls.length = 0;
  whenInput.value = '被怼、明显不耐烦时';
  whenInput.dispatch('change');
  await drain(12);
  const savedWhen = api._calls.filter((c) => c.name === 'settings.update').pop();
  const afterWhen = savedWhen && savedWhen.args[0].mascot && savedWhen.args[0].mascot.customEmotions;
  if (!afterWhen || afterWhen[0].when !== '被怼、明显不耐烦时') {
    throw new Error(`「什么时候用」没存上：${JSON.stringify(afterWhen)}`);
  }

  const aliasInput = findInTree(customRow, (node) => String(node.placeholder || '').includes('别名'));
  if (!aliasInput) throw new Error('自定义行缺「别名」输入框');
  api._calls.length = 0;
  aliasInput.value = '恼火';
  aliasInput.dispatch('change');
  await drain(12);
  const savedAlias = api._calls.filter((c) => c.name === 'settings.update').pop();
  const afterAlias = savedAlias && savedAlias.args[0].mascot && savedAlias.args[0].mascot.customEmotions;
  if (!afterAlias || afterAlias[0].alias !== '恼火') throw new Error(`别名没存上：${JSON.stringify(afterAlias)}`);
  if (afterAlias[0].when !== '被怼、明显不耐烦时') throw new Error('改别名把「什么时候用」弄丢了');
});

/** 上限值从面板里拿不到（闭包里的），测试里按需求固定断言：主播定的是 8 */
function shared_MAX() {
  return 8;
}

test('自定义表情：删掉之后映射和触发词一起清干净', async () => {
  const { dom, api, ready } = bootPanel({
    mascot: {
      images: { 生气: 'data:angry' },
      customEmotions: [{ key: '生气', when: '被怼时' }],
      expressions: { 生气: '生气' },
      triggers: { 生气: ['无语'] }
    }
  });
  await ready();
  const del = findInTree(dom.nodes.get('expressionGrid'), (node) => node.id === 'delEmotion-生气');
  if (!del) throw new Error('自定义表情那一行没有删除按钮（内置的才不该有）');

  del.dispatch('click');
  await drain(8);
  if (dom.nodes.get('modalMask').hidden) throw new Error('删除要先确认（应用内弹窗）');
  api._calls.length = 0;
  dom.nodes.get('modalOk').dispatch('click');
  await drain(14);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  const mascot = saved && saved.args[0].mascot;
  if (!mascot) throw new Error('删除没有保存配置');
  if ((mascot.customEmotions || []).length !== 0) {
    throw new Error(`自定义表情没删掉：${JSON.stringify(mascot.customEmotions)}`);
  }
  if ('生气' in (mascot.expressions || {})) throw new Error('映射表里还留着已删的表情（死配置）');
  if ('生气' in (mascot.triggers || {})) throw new Error('触发词表里还留着已删的表情（死配置）');
});

test('自定义表情：到 8 个上限后按钮变灰，行数 = 12 内置 + 8 自定义', async () => {
  const eight = Array.from({ length: 8 }, (_, i) => ({ key: `表情${i}` }));
  const { dom, ready } = bootPanel({ mascot: { customEmotions: eight } });
  await ready();
  const grid = dom.nodes.get('expressionGrid');
  const btn = findInTree(grid, (node) => node.id === 'addEmotion');
  if (!btn) throw new Error('没有添加按钮');
  if (!btn.disabled) throw new Error('到上限了还能加');
  if (!btn.textContent.includes('上限')) throw new Error(`按钮要说明到了上限：${btn.textContent}`);
  const rows = grid.children.filter((node) => String(node.className || '').includes('expression-row'));
  if (rows.length !== 20) throw new Error(`应该是 12 内置 + 8 自定义 = 20 行，实际 ${rows.length}`);
});

// ---------------------------------------------------------------- 从文件导入资料（2026-10-19）

test('导入文件：选文件 → 确认代价 → 才真的让模型整理', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.picked = { ok: true, files: [{ name: '资料.md', chars: 1234, encoding: 'utf-8' }], skipped: [] };
  api._knowledge.importResult = { ok: true, count: 3, chars: 1234, chunks: 1, droppedChars: 0, problems: [] };
  api._calls.length = 0;

  dom.nodes.get('knowledgeImport').dispatch('click');
  await drain(10);
  // ① 选完先弹确认框，把「几个文件、多少字、要不要花钱」说清楚
  if (dom.nodes.get('modalMask').hidden) throw new Error('选完文件应该先弹确认框（不许直接花主播的钱）');
  const message = dom.nodes.get('modalText').textContent;
  if (!message.includes('资料.md')) throw new Error(`确认框要说清是哪个文件：${message}`);
  if (!message.includes('1,234')) throw new Error(`确认框要说清多少字：${message}`);
  if (!message.includes('待审')) throw new Error(`确认框要说清产出进待审：${message}`);
  if (api._calls.some((call) => call.name === 'knowledge.importFiles')) {
    throw new Error('还没确认就把文件发去整理了');
  }

  // ② 点「开始整理」才真的跑
  dom.nodes.get('modalOk').dispatch('click');
  await drain(24);
  if (!api._calls.some((call) => call.name === 'knowledge.importFiles')) {
    throw new Error('确认之后没有真的去整理');
  }
  if (!dom.nodes.get('knowledgeImportList').textContent.includes('3 条')) {
    throw new Error(`提示行要报告结果：${dom.nodes.get('knowledgeImportList').textContent}`);
  }
  if (dom.nodes.get('knowledgeImport').disabled) throw new Error('跑完之后按钮要恢复可点');
});

test('导入文件：取消确认就不花钱；一个文件都没选时说清原因', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();

  // 取消
  api._knowledge.picked = { ok: true, files: [{ name: 'a.txt', chars: 100 }], skipped: [] };
  api._calls.length = 0;
  dom.nodes.get('knowledgeImport').dispatch('click');
  await drain(10);
  dom.nodes.get('modalCancel').dispatch('click');
  await drain(14);
  if (api._calls.some((call) => call.name === 'knowledge.importFiles')) {
    throw new Error('点了取消却还是把文件发去整理了');
  }
  if (!dom.nodes.get('knowledgeImportList').textContent.includes('取消')) {
    throw new Error(`取消后要给句话：${dom.nodes.get('knowledgeImportList').textContent}`);
  }

  // 一个都没选（用户在选择框里点了取消）
  api._knowledge.picked = { ok: true, files: [], skipped: [] };
  api._calls.length = 0;
  dom.nodes.get('knowledgeImport').dispatch('click');
  await drain(10);
  if (!dom.nodes.get('modalMask').hidden) throw new Error('没选文件不该弹确认框');
  if (!dom.nodes.get('knowledgeImportList').textContent.includes('没选文件')) {
    throw new Error(`要说清没选文件：${dom.nodes.get('knowledgeImportList').textContent}`);
  }
  if (api._calls.some((call) => call.name === 'knowledge.importFiles')) {
    throw new Error('没选文件不该去整理');
  }
});

test('待审草稿 / 全部条目：能收起能展开，收起时摘要照样更新', async () => {
  // 2026-10-19 主播提的：知识库页越来越长，这两块也要能收。
  // 和改动记录同一个坑：光设 `hidden` 会被 `.form { display:flex }` 顶掉，
  // 所以这里断言的是 **inline display**，不是只有 hidden 属性。
  const { dom, api, ready } = bootPanel();
  await ready();
  if (dom.nodes.get('pendingBody').hidden) throw new Error('待审草稿默认应该是展开的（日常要看）');
  if (dom.nodes.get('entriesBody').hidden) throw new Error('全部条目默认应该是展开的');
  if (dom.nodes.get('pendingToggle').textContent !== '收起') {
    throw new Error(`展开时按钮该写「收起」：${dom.nodes.get('pendingToggle').textContent}`);
  }

  // 收起待审草稿
  dom.nodes.get('pendingToggle').dispatch('click');
  await drain(10);
  const pendingBody = dom.nodes.get('pendingBody');
  if (pendingBody.hidden !== true) throw new Error('点了收起还没藏起来');
  if (pendingBody.style.display !== 'none') {
    throw new Error(`收起必须真的 display:none，实际 "${pendingBody.style.display}"`);
  }
  if (dom.nodes.get('pendingToggle').textContent !== '展开') throw new Error('收起后按钮该写「展开」');

  // 收起「全部条目」
  dom.nodes.get('entriesToggle').dispatch('click');
  await drain(10);
  if (dom.nodes.get('entriesBody').hidden !== true) throw new Error('全部条目收起没生效');
  if (dom.nodes.get('entriesBody').style.display !== 'none') {
    throw new Error('全部条目收起要真的 display:none');
  }

  // 收起状态下摘要行照样要能更新（不然收着就啥也不知道了）
  api._knowledge.pending = [
    { id: 'p-a', title: '星轨杯', content: 'x', tags: [] },
    { id: 'p-b', title: '无限机兵', content: 'y', tags: [] }
  ];
  api.emit('knowledgeChanged', { reason: 'drafts' });
  await drain(12);
  if (!dom.nodes.get('pendingHint').textContent.includes('2 条')) {
    throw new Error(`收起后摘要行要照样更新：${dom.nodes.get('pendingHint').textContent}`);
  }
  if (dom.nodes.get('pendingBody').style.display !== 'none') {
    throw new Error('刷新数据后不该自己展开');
  }

  // 再点一次展开
  dom.nodes.get('pendingToggle').dispatch('click');
  await drain(12);
  if (dom.nodes.get('pendingBody').hidden !== false) throw new Error('展开没生效');
  if (dom.nodes.get('pendingBody').style.display === 'none') throw new Error('展开后 display 要恢复');
  if (dom.nodes.get('pendingToggle').textContent !== '收起') throw new Error('展开后按钮该写「收起」');
});

test('整理与校对：条目行能勾选、能锁定成只读，全选/清空会改按钮文案', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.items = [
    { id: 'k-a', title: '茶区划分', content: '四大茶区', tags: ['茶'], source: '手动添加', updated: '2026-10-01T00:00:00.000Z', enabled: true },
    { id: 'k-b', title: '价格表', content: '大肥鱼 39', tags: [], source: '手动添加', updated: '2026-10-02T00:00:00.000Z', enabled: true }
  ];
  api._knowledge.stats = { ...api._knowledge.stats, count: 2, enabled: 2, locked: 0 };
  api._calls.length = 0;
  api.emit('knowledgeChanged', { reason: 'test' });
  await drain(12);

  const picks = dom.nodes.get('knowledgeList').querySelectorAll('.knowledge-pick');
  if (picks.length !== 2) throw new Error(`每条都要有勾选框，实际 ${picks.length}`);

  // 勾一条 → 校对按钮文案带上数量
  picks[0].checked = true;
  picks[0].dispatch('change');
  await drain(4);
  if (!dom.nodes.get('reviewVerify').textContent.includes('(1)')) {
    throw new Error(`勾选之后按钮要说清几条：${dom.nodes.get('reviewVerify').textContent}`);
  }

  // 全选 / 清空
  dom.nodes.get('entriesSelectAll').dispatch('click');
  await drain(4);
  if (!dom.nodes.get('reviewVerify').textContent.includes('(2)')) {
    throw new Error(`全选之后应该是 2 条：${dom.nodes.get('reviewVerify').textContent}`);
  }
  dom.nodes.get('entriesSelectNone').dispatch('click');
  await drain(10);
  if (dom.nodes.get('reviewVerify').textContent.includes('(')) {
    throw new Error(`清空选择之后不该再带数量：${dom.nodes.get('reviewVerify').textContent}`);
  }

  // 锁定 = 只读
  api._calls.length = 0;
  const lockBtn = dom.nodes
    .get('knowledgeList')
    .querySelectorAll('.btn')
    .find((btn) => String(btn.textContent || '').includes('锁定'));
  if (!lockBtn) throw new Error('条目行上没有「锁定」按钮');
  lockBtn.dispatch('click');
  await drain(12);
  const patch = api._calls.filter((call) => call.name === 'knowledge.update').pop();
  if (!patch || !patch.args[1] || patch.args[1].locked !== true) {
    throw new Error(`点锁定应该写 locked:true：${JSON.stringify(patch && patch.args)}`);
  }
});

test('整理与校对：点「整理全库」会真的跑，跑完把建议画出来', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.items = [
    { id: 'k-a', title: '茶区划分', content: '四大茶区', tags: [], source: '手动添加', updated: '2026-10-01T00:00:00.000Z', enabled: true }
  ];
  api._knowledge.innerReview = null;
  api._knowledge.review = {
    items: [],
    runs: [],
    limit: 5,
    running: '',
    progress: null,
    stats: { count: 1, locked: 0, enabled: 1 },
    maxMode: false
  };
  api._review.audit = {
    ok: true,
    mode: 'audit',
    notes: 1,
    locked: 0,
    found: 1,
    autoApplied: 0,
    ms: 15000,
    state: {
      items: [
        {
          id: 'rv-1',
          kind: 'rewrite',
          noteIds: ['k-a'],
          dropIds: [],
          before: { title: '茶区划分', content: '四大茶区', tags: [] },
          after: { title: '中国茶区划分', content: '中国分四大茶区：江北、江南、西南、华南。', tags: ['茶'] },
          reason: '原文写得太简略',
          sources: [],
          mode: 'audit',
          createdAt: '2026-10-19T00:00:00.000Z',
          change: '标题；正文 4 → 21 字'
        }
      ],
      runs: [{ id: 'run-1', mode: 'audit', startedAt: '2026-10-19T00:00:00.000Z', notes: 1, found: 1 }],
      limit: 5,
      running: '',
      progress: null,
      stats: { count: 1, locked: 0, enabled: 1 },
      maxMode: false
    }
  };
  api._calls.length = 0;
  dom.nodes.get('reviewAudit').dispatch('click');
  await drain(20);
  if (!api._calls.some((call) => call.name === 'knowledge.reviewAudit')) {
    throw new Error('点「整理全库」没真的去跑');
  }
  const list = dom.nodes.get('reviewList').textContent;
  if (!list.includes('中国茶区划分')) throw new Error(`建议列表没画出来：${list}`);
  if (!list.includes('原文写得太简略')) throw new Error(`建议要带理由：${list}`);
  if (!dom.nodes.get('reviewSummary').textContent.includes('上次整理')) {
    throw new Error(`摘要行要说清上次跑过：${dom.nodes.get('reviewSummary').textContent}`);
  }
  // 有建议时「清空建议」按钮要露出来
  if (dom.nodes.get('reviewClear').hidden) throw new Error('有建议时应该出现「清空建议」按钮');
});

test('整理与校对：应用 / 忽略一条建议各走各的接口；应用失败要说清原因', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.review = {
    items: [
      {
        id: 'rv-1',
        kind: 'rewrite',
        noteIds: ['k-a'],
        dropIds: [],
        before: { title: '茶区划分', content: '四大茶区', tags: [] },
        after: { title: '中国茶区划分', content: '中国分四大茶区。', tags: [] },
        reason: '写简略了',
        sources: [{ title: '百科', url: 'https://example.com/tea' }],
        mode: 'verify',
        createdAt: '2026-10-19T00:00:00.000Z',
        change: '标题；正文 4 → 8 字'
      }
    ],
    runs: [],
    limit: 5,
    running: '',
    progress: null,
    stats: { count: 1, locked: 0, enabled: 1 },
    maxMode: false
  };
  api._calls.length = 0;
  api.emit('knowledgeReview', api._knowledge.review);
  await drain(10);
  const list = dom.nodes.get('reviewList');
  if (!list.textContent.includes('https://example.com/tea')) {
    throw new Error(`建议要带上联网依据：${list.textContent}`);
  }
  const applyBtn = list.querySelectorAll('.btn').find((btn) => btn.textContent === '应用');
  if (!applyBtn) throw new Error('建议行上没有「应用」按钮');
  applyBtn.dispatch('click');
  await drain(12);
  const applied = api._calls.filter((call) => call.name === 'knowledge.reviewApply').pop();
  if (!applied || applied.args[0] !== 'rv-1') {
    throw new Error(`点应用应该走 reviewApply(rv-1)：${JSON.stringify(applied && applied.args)}`);
  }

  // 应用失败（比如条目被锁了 / 被手改过）要把原因说出来
  api._review.apply = { ok: false, message: '这条知识在你生成建议之后被改过了' };
  api.emit('knowledgeReview', api._knowledge.review);
  await drain(10);
  const applyBtn2 = dom.nodes.get('reviewList').querySelectorAll('.btn').find((btn) => btn.textContent === '应用');
  applyBtn2.dispatch('click');
  await drain(12);
  if (!dom.nodes.get('toastWrap').textContent.includes('没法应用')) {
    throw new Error(`应用失败要说清：${dom.nodes.get('toastWrap').textContent}`);
  }

  // 忽略
  api._calls.length = 0;
  const discardBtn = dom.nodes.get('reviewList').querySelectorAll('.btn').find((btn) => btn.textContent === '忽略');
  if (!discardBtn) throw new Error('建议行上没有「忽略」按钮');
  discardBtn.dispatch('click');
  await drain(12);
  if (!api._calls.some((call) => call.name === 'knowledge.reviewDiscard')) {
    throw new Error('点忽略应该走 reviewDiscard');
  }
});

test('整理与校对：跑起来能看到进度、按钮禁用、能取消', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.review = {
    items: [],
    runs: [],
    limit: 5,
    running: 'verify',
    progress: { mode: 'verify', done: 1, total: 3, title: '茶区划分' },
    stats: { count: 3, locked: 0, enabled: 3 },
    maxMode: false
  };
  api.emit('knowledgeReview', api._knowledge.review);
  await drain(10);
  const progress = dom.nodes.get('reviewProgress');
  if (progress.hidden) throw new Error('跑起来之后要显示进度');
  if (!progress.textContent.includes('2/3')) throw new Error(`进度要说清第几条：${progress.textContent}`);
  if (!progress.textContent.includes('茶区划分')) throw new Error(`进度要带上正在看的标题：${progress.textContent}`);
  if (!dom.nodes.get('reviewVerify').disabled) throw new Error('跑的时候校对按钮要禁用');
  if (!dom.nodes.get('reviewAudit').disabled) throw new Error('跑的时候整理按钮要禁用');
  if (dom.nodes.get('reviewCancel').hidden) throw new Error('跑的时候要出现「取消」');

  api._calls.length = 0;
  dom.nodes.get('reviewCancel').dispatch('click');
  await drain(8);
  if (!api._calls.some((call) => call.name === 'knowledge.reviewCancel')) {
    throw new Error('点取消应该走 reviewCancel');
  }
});

test('整理与校对：「正在整理…」的提示跑完必须自己收掉（回归：右下角一直挂着那句话）', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  api._knowledge.items = [
    { id: 'k-a', title: '茶区划分', content: '四大茶区', tags: [], source: '手动添加', updated: '2026-10-01T00:00:00.000Z', enabled: true }
  ];
  api._knowledge.review = {
    items: [],
    runs: [],
    limit: 5,
    running: '',
    progress: null,
    stats: { count: 1, locked: 0, enabled: 1 },
    maxMode: false
  };
  // 让"整理"挂住：这样才看得到"正在整理"那条提示
  let release = null;
  api._review.auditPending = new Promise((resolve) => {
    release = resolve;
  });
  dom.nodes.get('reviewAudit').dispatch('click');
  await drain(10);
  const wrap = dom.nodes.get('toastWrap');
  if (!wrap.textContent.includes('正在整理全库')) {
    throw new Error(`点完就该有「正在整理」的提示：${wrap.textContent}`);
  }

  // 跑完：先把挂住的调用放行，再让淡出（320ms）的定时器跑完
  api._review.auditPending = null;
  release({ ok: true, notes: 1, locked: 0, found: 0, autoApplied: 0, ms: 60000 });
  await drain(12);
  timers.run(400);
  await drain(4);
  const after = wrap.textContent;
  if (after.includes('正在整理全库')) {
    throw new Error(`跑完了「正在整理」还挂着（主播报的就是这个）：${after}`);
  }
  if (!after.includes('整理完了')) throw new Error(`结果提示要在：${after}`);
});

test('整理与校对：联网校对先确认再花钱；最高权限时会提醒她自动应用', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._knowledge.items = [
    { id: 'k-a', title: '茶区划分', content: '四大茶区', tags: [], source: '手动添加', updated: '2026-10-01T00:00:00.000Z', enabled: true }
  ];
  api._knowledge.review = {
    items: [],
    runs: [],
    limit: 5,
    running: '',
    progress: null,
    stats: { count: 1, locked: 0, enabled: 1 },
    maxMode: true
  };
  api.emit('knowledgeReview', api._knowledge.review);
  await drain(10);
  if (!dom.nodes.get('reviewSummary').textContent.includes('最高权限')) {
    throw new Error(`最高权限要提醒她会自动应用：${dom.nodes.get('reviewSummary').textContent}`);
  }

  dom.nodes.get('reviewVerify').dispatch('click');
  await drain(10);
  if (dom.nodes.get('modalMask').hidden) throw new Error('联网校对要先弹确认框（要花钱）');
  const message = dom.nodes.get('modalText').textContent;
  if (!message.includes('0.01')) throw new Error(`确认框要说清大概多少钱：${message}`);
  if (!message.includes('应用')) throw new Error(`确认框要说清产出只是建议：${message}`);
  if (api._calls.some((call) => call.name === 'knowledge.reviewVerify')) {
    throw new Error('还没确认就去联网校对了');
  }

  // 确认之后才真的跑，并把「没勾选」的情况说清楚
  dom.nodes.get('modalOk').dispatch('click');
  await drain(20);
  const call = api._calls.filter((item) => item.name === 'knowledge.reviewVerify').pop();
  if (!call) throw new Error('确认之后要真的去跑');
  if (call.args[0].ids.length !== 0) throw new Error('没勾选时不该传 ids');
  if (call.args[0].limit !== 5) throw new Error(`没勾选时按配置条数跑，实际 ${call.args[0].limit}`);
});


test('主动搭话：卡片按配置回填，标题旁的摘要说清「什么时候说、说多少」', async () => {
  const { dom, ready } = bootPanel({ proactive: { enabled: true, idleSeconds: 120, maxPerHour: 3, chancePercent: 50 } });
  await ready();
  if (dom.nodes.get('proactiveEnabled').checked !== true) throw new Error('开关没回填');
  if (dom.nodes.get('proactiveIdleSeconds').value !== '120') throw new Error(`秒数没回填：${dom.nodes.get('proactiveIdleSeconds').value}`);
  if (dom.nodes.get('proactiveMaxPerHour').value !== '3') throw new Error('每小时次数没回填');
  if (dom.nodes.get('proactiveChanceOut').textContent !== '50%') {
    throw new Error(`概率输出不对：${dom.nodes.get('proactiveChanceOut').textContent}`);
  }
  if (dom.nodes.get('proactivePrompt').value !== '别太刻意') throw new Error('搭话规矩没回填');
  for (const id of ['proactiveModeTopic', 'proactiveModeAsk', 'proactiveModeFollow']) {
    if (dom.nodes.get(id).checked !== true) throw new Error(`${id} 没勾上（默认三种都允许）`);
  }
  const hint = dom.nodes.get('proactiveHint').textContent;
  if (!hint.includes('120 秒') || !hint.includes('3 次/小时') || !hint.includes('50%')) {
    throw new Error(`摘要要说明白：${hint}`);
  }

  // 关着的时候摘要要直说（不能显示一堆数字让人以为开着）
  const off = bootPanel();
  await off.ready();
  if (!off.dom.nodes.get('proactiveHint').textContent.includes('关着')) {
    throw new Error(`关着时摘要不对：${off.dom.nodes.get('proactiveHint').textContent}`);
  }
});

test('主动搭话：取消一种方式会写回 modes；三种全关会提醒', async () => {
  const { dom, api, ready } = bootPanel({ proactive: { enabled: true, modes: ['topic', 'ask', 'follow'] } });
  await ready();
  api._calls.length = 0;
  dom.nodes.get('proactiveModeAsk').checked = false;
  dom.nodes.get('proactiveModeAsk').dispatch('change');
  await drain(10);
  const patch = api._calls.filter((call) => call.name === 'settings.update').pop();
  const modes = patch && patch.args[0] && patch.args[0].proactive && patch.args[0].proactive.modes;
  if (!Array.isArray(modes) || modes.join(',') !== 'topic,follow') {
    throw new Error(`取消 ask 之后应该是 topic,follow：${JSON.stringify(patch && patch.args[0])}`);
  }

  // 再把剩下两个也关掉：要提示「等于不会搭话」
  api._calls.length = 0;
  for (const id of ['proactiveModeTopic', 'proactiveModeFollow']) {
    dom.nodes.get(id).checked = false;
    dom.nodes.get(id).dispatch('change');
    // eslint-disable-next-line no-await-in-loop
    await drain(6);
  }
  const last = api._calls.filter((call) => call.name === 'settings.update').pop();
  const lastModes = last && last.args[0] && last.args[0].proactive && last.args[0].proactive.modes;
  if (!Array.isArray(lastModes) || lastModes.length !== 0) {
    throw new Error(`三种全关应该写空数组：${JSON.stringify(lastModes)}`);
  }
  if (!dom.nodes.get('toastWrap').textContent.includes('不会主动搭话')) {
    throw new Error(`全关要提醒：${dom.nodes.get('toastWrap').textContent}`);
  }
  if (!dom.nodes.get('proactiveHint').textContent.includes('三种方式都关了')) {
    throw new Error(`摘要也要标出来：${dom.nodes.get('proactiveHint').textContent}`);
  }
});

test('主动搭话：「让她现在搭一句」会调 copilot.warmup，说了什么 / 失败原因都要报出来', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  api._calls.length = 0;
  api.copilot.warmup = () => {
    api._calls.push({ name: 'copilot.warmup', args: [] });
    return Promise.resolve({ ok: true, reply: { text: '来聊聊今天玩什么吧', ts: Date.now() } });
  };
  dom.nodes.get('proactiveNow').dispatch('click');
  await drain(12);
  if (!api._calls.some((call) => call.name === 'copilot.warmup')) {
    throw new Error('按钮没走 copilot.warmup');
  }
  if (!dom.nodes.get('toastWrap').textContent.includes('来聊聊今天玩什么吧')) {
    throw new Error(`要说清她说了什么：${dom.nodes.get('toastWrap').textContent}`);
  }
  if (dom.nodes.get('proactiveNow').disabled) throw new Error('跑完按钮要恢复可点');

  // 失败（比如正在回复上一条）：把原因原样告诉主播
  api.copilot.warmup = () => Promise.resolve({ ok: false, message: '正在回复上一条，等它说完再点', reply: null });
  dom.nodes.get('proactiveNow').dispatch('click');
  await drain(12);
  if (!dom.nodes.get('toastWrap').textContent.includes('正在回复上一条')) {
    throw new Error(`失败原因要说出来：${dom.nodes.get('toastWrap').textContent}`);
  }
});

test('观众记忆：状态行按主进程的状态画，按钮各走各的接口', async () => {
  const { dom, api, ready } = bootPanel({ viewerMemory: { enabled: true, rosterEnabled: true } });
  await ready();
  api._memory.state = {
    enabled: true,
    rosterEnabled: true,
    dir: 'D:\\demo\\data\\观众记忆',
    recording: true,
    sessionFile: 'D:\\demo\\data\\观众记忆\\2026-10-21_20-15-32.md',
    startedAt: new Date(2026, 9, 21, 20, 15).getTime(),
    sessionViewers: 3,
    sessionPoints: 7,
    sessionBytes: 4096,
    anchor: 1,
    rosterCount: 12,
    pendingLookup: false,
    config: {
      enabled: true,
      rosterEnabled: true,
      batchSize: 20,
      intervalSec: 120,
      maxBatchesPerHour: 12,
      injectChars: 500,
      rosterMax: 2000
    },
    buffered: 4,
    flushing: false,
    batchesThisHour: 2
  };
  api.emit('memoryChanged', api._memory.state);
  await drain(10);
  const status = dom.nodes.get('memoryStatus').textContent;
  if (!status.includes('正在记录')) throw new Error(`状态行要说在记录：${status}`);
  if (!status.includes('3 个观众')) throw new Error(`状态行要带观众数：${status}`);
  if (!status.includes('20:15')) throw new Error(`状态行要带开始时间：${status}`);
  if (!status.includes('12 人')) throw new Error(`状态行要带名册人数：${status}`);
  if (!status.includes('4 条')) throw new Error(`状态行要带"本批攒着"：${status}`);
  if (dom.nodes.get('memoryFlush').disabled) throw new Error('在记录时「现在总结一批」该可点');

  // 三个查看按钮
  api._calls.length = 0;
  dom.nodes.get('memoryOpenFile').dispatch('click');
  dom.nodes.get('memoryOpenRoster').dispatch('click');
  dom.nodes.get('memoryOpenFolder').dispatch('click');
  await drain(10);
  const kinds = api._calls.filter((call) => call.name === 'memory.openFile').map((call) => call.args[0]);
  if (!kinds.includes('session') || !kinds.includes('roster')) {
    throw new Error(`查看按钮要分别打开本场和名册：${JSON.stringify(kinds)}`);
  }
  if (!api._calls.some((call) => call.name === 'memory.openFolder')) throw new Error('没走打开文件夹');

  // 手动总结
  api._calls.length = 0;
  dom.nodes.get('memoryFlush').dispatch('click');
  await drain(12);
  if (!api._calls.some((call) => call.name === 'memory.flush')) throw new Error('没走 memory.flush');
  if (!dom.nodes.get('toastWrap').textContent.includes('总结完了')) {
    throw new Error(`总结完要报结果：${dom.nodes.get('toastWrap').textContent}`);
  }
});

test('观众记忆：清空本场 / 清空名册都要先确认；关着时状态行直说', async () => {
  const { dom, api, ready } = bootPanel();
  await ready();
  if (!dom.nodes.get('memoryStatus').textContent.includes('关着')) {
    throw new Error(`默认关着时状态行要直说：${dom.nodes.get('memoryStatus').textContent}`);
  }
  if (!dom.nodes.get('memoryStatus').textContent.includes('下次启动自动开始')) {
    throw new Error(`要告诉主播下次启动会自动开始：${dom.nodes.get('memoryStatus').textContent}`);
  }

  // 清空本场：先弹确认，取消就不动
  api._calls.length = 0;
  dom.nodes.get('memoryClearSession').dispatch('click');
  await drain(10);
  if (dom.nodes.get('modalMask').hidden) throw new Error('清空本场要先确认');
  dom.nodes.get('modalCancel').dispatch('click');
  await drain(10);
  if (api._calls.some((call) => call.name === 'memory.clearSession')) throw new Error('取消了还清空');

  // 确认后才真的清
  dom.nodes.get('memoryClearSession').dispatch('click');
  await drain(10);
  dom.nodes.get('modalOk').dispatch('click');
  await drain(12);
  if (!api._calls.some((call) => call.name === 'memory.clearSession')) throw new Error('确认后没清空本场');

  // 清空名册同理
  api._calls.length = 0;
  dom.nodes.get('memoryClearRoster').dispatch('click');
  await drain(10);
  dom.nodes.get('modalOk').dispatch('click');
  await drain(12);
  if (!api._calls.some((call) => call.name === 'memory.clearRoster')) throw new Error('确认后没清空名册');
});

test('观众记忆：「每次启动自动记录」默认勾着，取消勾选会存进配置（只影响下次启动）', async () => {
  const { dom, api, timers, ready } = bootPanel();
  await ready();
  const box = dom.nodes.get('memoryAutoStart');
  if (!box) throw new Error('面板上没有「每次启动自动记录」这个勾选框');
  if (!box.checked) throw new Error('默认值应该是勾上的（每次启动自动记录）');
  if (dom.nodes.get('memoryEnabled').checked) throw new Error('「本场记录」是运行开关，默认仍是关的');

  api._calls.length = 0;
  box.checked = false;
  box.dispatch('change');
  for (const timer of timers.timers) if (typeof timer.fn === 'function') timer.fn();
  await drain(10);
  const saved = api._calls.filter((c) => c.name === 'settings.update').pop();
  if (!saved) throw new Error('取消勾选没有保存');
  if (!saved.args[0].viewerMemory || saved.args[0].viewerMemory.autoStart !== false) {
    throw new Error(`没存成 viewerMemory.autoStart=false：${JSON.stringify(saved.args[0])}`);
  }
  // 取消勾选不能顺手把「本场记录」关掉（这一场照记）
  if (saved.args[0].viewerMemory.enabled !== undefined) {
    throw new Error(`取消自动记录不该动本场开关：${JSON.stringify(saved.args[0].viewerMemory)}`);
  }
});

runPending().then(() => {
  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
});
