'use strict';

/**
 * 主进程运行时测试：用假的 electron 模块把 src/main/main.js 真正加载并启动一遍。
 *   node scripts/test-electron-main.js
 *
 * 这个测试能覆盖到「沙箱里打不开 GUI」而漏掉的部分：
 *   - app.whenReady 后的完整启动流程有没有抛错
 *   - 控制面板 / 悬浮窗 / 托盘 / 屏幕事件是否都被正确接线
 *   - 事件转发（弹幕、AI 回复、思考状态、日志、登录状态）能不能真的送到窗口
 *   - --smoke-test 自检模式能否走通并正常退出
 *   - 窗口创建时设置项是否被正确应用（点击穿透、内容保护、置顶）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- 假 electron

function createFakeElectron(record) {
  const ipcHandlers = new Map();
  const appListeners = new Map();
  let readyCallback = null;

  class FakeBrowserWindow {
    constructor(options = {}) {
      this.options = options;
      this.id = record.windows.length + 1;
      this.destroyed = false;
      this.visible = false;
      this.sent = [];
      this.listeners = new Map();
      this.ignoreMouse = null;
      this.alwaysOnTop = [];
      this.contentProtection = false;
      this.workspaces = null;
      this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width || 800, height: options.height || 600 };
      this.webContents = {
        openDevTools() {},
        send: (channel, payload) => {
          this.sent.push({ channel, payload });
          record.sent.push({ id: this.id, title: options.title, channel, payload });
        },
        on(event, fn) {
          this._devToolsHandlers = this._devToolsHandlers || {};
          this._devToolsHandlers[event] = fn;
        }
      };
      record.windows.push(this);
    }

    loadFile(file) {
      this.loadedFile = file;
      record.loadedFiles.push(file);
      return Promise.resolve();
    }

    loadURL(url) {
      this.loadedUrl = url;
      record.loadedFiles.push(url);
      return Promise.resolve();
    }

    /**
     * 支持多个监听器（真实 Electron 就是多监听器，这里之前只存一个会互相覆盖）。
     * 注意：不在这里自动触发 ready-to-show——那会和测试自己的时序控制打架，
     * 变成偶发失败。由调用方（boot / 各个用例）显式 emit。
     */
    once(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(fn);
    }

    on(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(fn);
    }

    emit(event, ...args) {
      const list = this.listeners.get(event) || [];
      // once 语义：触发后清空该事件的监听器
      this.listeners.set(event, []);
      for (const fn of list) fn(...args);
    }

    show() {
      this.visible = true;
    }

    hide() {
      this.visible = false;
    }

    showInactive() {
      this.visible = true;
    }

    focus() {
      this.focused = true;
    }

    isVisible() {
      return this.visible;
    }

    isDestroyed() {
      return this.destroyed;
    }

    setAlwaysOnTop(value, level) {
      this.alwaysOnTop.push({ value, level });
    }

    setVisibleOnAllWorkspaces(value) {
      this.workspaces = value;
    }

    setIgnoreMouseEvents(ignore, options) {
      this.ignoreMouse = ignore;
      record.ignoreMouseCalls.push({ id: this.id, ignore, options });
    }

    setContentProtection(value) {
      this.contentProtection = value;
    }

    setFocusable(value) {
      this.focusable = value;
      record.focusableCalls.push({ id: this.id, value });
    }

    focus() {
      this.focused = true;
    }

    blur() {
      this.focused = false;
    }

    setBounds(bounds) {
      this.bounds = { ...this.bounds, ...bounds };
    }

    getBounds() {
      return { ...this.bounds };
    }

    /** 模拟用户点窗口右上角的关闭按钮，触发 close 事件 */
    close() {
      this.emit('close');
    }

    /** 真正销毁（配合 close 里的 quitApp 逻辑） */
    destroy() {
      record.destroyed.push({ title: this.options.title, id: this.id });
      this.destroyed = true;
      this.emit('closed');
    }

    setTitle() {}

    reload() {
      record.reloads += 1;
    }

    capturePage() {
      return Promise.resolve({ toPNG: () => Buffer.from('') });
    }
  }

  const electron = {
    app: {
      isReady: () => record.appReady,
      whenReady: () => {
        record.whenReadyCalled = true;
        return new Promise((resolve) => {
          readyCallback = resolve;
        });
      },
      on: (event, fn) => {
        appListeners.set(event, fn);
      },
      getAppPath: () => root,
      // 模拟真实 Electron：setPath 之后 getPath 要返回被改过的值，
      // 否则配置/日志会落到别的地方，和真实运行时不一致。
      getPath: (name) => record.paths[name] || record.userDataDir,
      setPath: (name, value) => {
        const previous = record.paths[name];
        record.paths[name] = value;
        record.setPathCalls.push({ name, value, previous });
      },
      quit: () => {
        record.quitCalled = true;
      },
      exit: (code) => {
        record.exitCode = code;
      }
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, fn) => {
        ipcHandlers.set(channel, fn);
      },
      listenerCount: (channel) => (ipcHandlers.has(channel) ? 1 : 0)
    },
    screen: {
      getAllDisplays: () => [
        { bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
        { bounds: { x: 1920, y: 0, width: 1280, height: 720 } }
      ],
      getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
      on: (event, fn) => {
        record.screenEvents.set(event, fn);
      }
    },
    dialog: {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showErrorBox: (title, content) => {
        record.errorBoxes.push({ title, content });
      }
    },
    shell: { openPath: () => Promise.resolve(''), showItemInFolder: () => {} },
    Menu: { buildFromTemplate: (template) => ({ template }) },
    Tray: class {
      constructor(icon) {
        this.icon = icon;
        record.trayCreated = true;
      }
      setToolTip() {}
      setContextMenu(menu) {
        this.menu = menu;
      }
      on() {}
      destroy() {
        record.trayDestroyed = true;
      }
    },
    nativeImage: {
      createFromDataURL: (url) => ({ url, isEmpty: () => false })
    },
    session: {
      fromPartition: () => ({
        setUserAgent() {},
        cookies: { get: () => Promise.resolve([]), remove: () => Promise.resolve() },
        clearStorageData: () => Promise.resolve()
      })
    },
    _ipcHandlers: ipcHandlers,
    _appListeners: appListeners,
    _resolveReady: () => readyCallback && readyCallback()
  };
  return electron;
}

/** 在隔离环境里加载 main.js（electron 被替换成假模块） */
function loadMain(options = {}) {
  const record = {
    windows: [],
    sent: [],
    loadedFiles: [],
    ignoreMouseCalls: [],
    focusableCalls: [],
    screenEvents: new Map(),
    setPathCalls: [],
    errorBoxes: [],
    reloads: 0,
    appReady: false,
    trayCreated: false,
    trayDestroyed: false,
    destroyed: [],
    userDataDir: options.userDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-data-')),
    paths: {}
  };
  record.paths.userData = record.userDataDir;

  // 注意：main.js 实际用的是「app.getAppPath()/data」（即项目下的 data），
  // 所以种子配置必须写到这里，而且要在加载 main.js 之前写好（配置是加载时读取的）。
  // 每次启动都从干净配置开始，避免上一个测试的设置串味。
  const realSettings = path.join(DATA_DIR, 'settings.json');
  try {
    fs.rmSync(realSettings, { force: true });
    const seed = { ...(options.settings || {}) };
    if (options.autoShow) {
      seed.overlay = { ...(seed.overlay || {}), autoShow: true };
    }
    // 「每次启动自动记录」默认是开的，但那会让**每个**用例都悄悄开始记一场
    // （多出总结调用 / 缓冲 / 日志），把测别的东西的断言搅乱。
    // 所以测试环境默认关掉它；专测这个开关的用例自己传 `autoStart: true`。
    seed.viewerMemory = { autoStart: false, ...(seed.viewerMemory || {}) };
    if (Object.keys(seed).length) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(realSettings, JSON.stringify(seed, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn(`  ! 写入测试配置失败：${error.message}`);
  }
  const electron = createFakeElectron(record);

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[require.resolve(path.join(root, 'src/main/main.js'))];

  const argvBackup = process.argv.slice();
  process.argv = ['electron', root, ...(options.argv || [])];
  let exported;
  try {
    exported = require(path.join(root, 'src/main/main.js'));
  } finally {
    Module._load = originalLoad;
    process.argv = argvBackup;
  }

  return { record, electron, exported };
}

/** 启动主进程并等待 ready 回调、窗口 ready-to-show 等异步流程跑完 */
async function boot(options = {}) {
  const loaded = loadMain(options);
  const { record, electron } = loaded;
  record.appReady = true;
  electron._resolveReady();

  const settle = async (rounds = 30) => {
    // setImmediate 让出事件循环（顺带触发 real 定时器），多次往复确保链式异步都跑完
    for (let i = 0; i < rounds; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  await settle();
  // 如果窗口还没走完 ready-to-show，手动触发一次（模拟 Electron 的加载完成事件）
  for (const win of record.windows) {
    if (!win.visible) win.emit('ready-to-show');
  }
  await settle(5);
  return loaded;
}

/**
 * 测试隔离：
 * main.js 会把数据目录设成「app.getAppPath()/data」，也就是项目目录下的 data。
 * 如果放任它读写，测试就会污染（甚至清掉）你真实使用的 settings.json。
 * 所以这里把真实的配置文件临时挪走，测试结束再放回去。
 */
const DATA_DIR = path.join(root, 'data');
const SETTINGS_BACKUP = path.join(root, 'data', 'settings.json.test-backup');
let settingsBackedUp = false;
/**
 * 「模型想查 / 想记」的待办队列也是主播的真数据（他正在等着处理的待办）。
 * 这条链路的新用例会真的入队 / 改状态，所以和 settings.json 一样：跑之前挪走、跑完原样放回。
 */
const RESEARCH_FILE = path.join(root, 'data', 'research.json');
const RESEARCH_BACKUP = path.join(root, 'data', 'research.json.test-backup');
let researchBackedUp = false;
/**
 * 知识库目录：main.js 一启动就会建「软件目录/知识库」（含 notes / pending / inbox 和一份说明），
 * 并且会把老位置 `data/knowledge` 里的东西搬进去。
 *
 * ⚠️ 两件事都必须处理：
 *   · 「知识库」本来不存在 → 跑完整个收掉（里面只有测试生成的骨架）；
 *   · 老目录里有主播的真数据 → **跑之前整个挪走**，不然 main.js 会真的去搬它。
 *     搬走的那份一个字都不动，跑完原样放回来。
 */
const KNOWLEDGE_DIR = path.join(root, '知识库');
const LEGACY_KNOWLEDGE_DIR = path.join(DATA_DIR, 'knowledge');
const LEGACY_KNOWLEDGE_HOLD = path.join(DATA_DIR, 'knowledge.test-hold');
let knowledgeDirExisted = false;
let legacyKnowledgeHeld = false;
/**
 * 观众记忆目录（`data/观众记忆/`）：本场文档 + 老观众名册。
 * 这是主播的真实直播记录，测试**绝不能**往里写：跑之前整个挪走，跑完原样放回。
 */
const MEMORY_DIR = path.join(DATA_DIR, '观众记忆');
const MEMORY_BACKUP = path.join(DATA_DIR, 'viewer-memory.test-hold');
let memoryBackedUp = false;

function isolateRealData() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    knowledgeDirExisted = fs.existsSync(KNOWLEDGE_DIR);
    const real = path.join(DATA_DIR, 'settings.json');
    if (fs.existsSync(real)) {
      fs.renameSync(real, SETTINGS_BACKUP);
      settingsBackedUp = true;
    }
    if (fs.existsSync(RESEARCH_FILE)) {
      fs.rmSync(RESEARCH_BACKUP, { force: true });
      fs.renameSync(RESEARCH_FILE, RESEARCH_BACKUP);
      researchBackedUp = true;
    }
    // 老位置先藏起来：迁移逻辑只该在真实启动时跑，测试里绝不能动真数据
    if (fs.existsSync(LEGACY_KNOWLEDGE_DIR)) {
      fs.rmSync(LEGACY_KNOWLEDGE_HOLD, { recursive: true, force: true });
      fs.renameSync(LEGACY_KNOWLEDGE_DIR, LEGACY_KNOWLEDGE_HOLD);
      legacyKnowledgeHeld = true;
    }
    // 观众记忆也是真数据（主播的直播记录）：整个挪走，跑完放回
    if (fs.existsSync(MEMORY_DIR)) {
      fs.rmSync(MEMORY_BACKUP, { recursive: true, force: true });
      fs.renameSync(MEMORY_DIR, MEMORY_BACKUP);
      memoryBackedUp = true;
    }
    // 顺手清掉本次运行会产生的东西（含轮转出来的 .1，别留在真实 data 目录里）
    for (const name of ['copilot.log', 'copilot.log.1', 'boot.log', 'boot.log.1', 'crash.log', 'usage.json', 'renderer-error.log']) {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    }
  } catch (error) {
    console.warn(`  ! 无法隔离真实数据目录：${error.message}`);
  }
}

function restoreRealData() {
  try {
    const real = path.join(DATA_DIR, 'settings.json');
    fs.rmSync(real, { force: true });
    if (settingsBackedUp && fs.existsSync(SETTINGS_BACKUP)) {
      fs.renameSync(SETTINGS_BACKUP, real);
    }
    // 待办队列同理：测试期间它被整个挪走过（没挪过就说明本来没有，跑出来的删掉）
    fs.rmSync(RESEARCH_FILE, { force: true });
    if (researchBackedUp && fs.existsSync(RESEARCH_BACKUP)) {
      fs.renameSync(RESEARCH_BACKUP, RESEARCH_FILE);
      researchBackedUp = false;
    }
    for (const name of ['copilot.log', 'copilot.log.1', 'boot.log', 'boot.log.1', 'crash.log', 'usage.json', 'renderer-error.log']) {
      fs.rmSync(path.join(DATA_DIR, name), { force: true });
    }
    // 老位置原样放回来（测试期间它被整个挪走过）
    if (legacyKnowledgeHeld) {
      fs.rmSync(LEGACY_KNOWLEDGE_DIR, { recursive: true, force: true });
      if (fs.existsSync(LEGACY_KNOWLEDGE_HOLD)) fs.renameSync(LEGACY_KNOWLEDGE_HOLD, LEGACY_KNOWLEDGE_DIR);
      legacyKnowledgeHeld = false;
    }
    // 观众记忆：测试产生的整个删掉，主播原来那份放回来
    fs.rmSync(MEMORY_DIR, { recursive: true, force: true });
    if (memoryBackedUp && fs.existsSync(MEMORY_BACKUP)) {
      fs.renameSync(MEMORY_BACKUP, MEMORY_DIR);
      memoryBackedUp = false;
    }
    // 本次跑出来的「知识库」目录收掉（本来不存在才收；已存在的话那是主播的真库）
    fs.rmSync(`${KNOWLEDGE_DIR}.migrating`, { recursive: true, force: true });
    if (!knowledgeDirExisted) fs.rmSync(KNOWLEDGE_DIR, { recursive: true, force: true });
  } catch (error) {
    console.warn(`  ! 恢复真实数据目录失败：${error.message}`);
  }
}

// ---------------------------------------------------------------- 测试

/** 读主进程日志（写到 程序目录/data/copilot.log） */
function readLog() {
  const file = path.join(root, 'data', 'copilot.log');
  if (!fs.existsSync(file)) return '';
  // 只取本次运行的最后一段，避免历史内容干扰断言
  const text = fs.readFileSync(file, 'utf8');
  return text.slice(-4000);
}

(async () => {
  console.log('主进程运行时（假 electron 模块，真实执行 main.js）');
  isolateRealData();

  await test('启动流程不抛错，并创建了悬浮窗和控制面板', async () => {
    const { record } = await boot({ autoShow: true });
    assert(record.whenReadyCalled, 'app.whenReady 没有被调用');
    assert(record.windows.length >= 2, `应创建至少 2 个窗口，实际 ${record.windows.length}`);
    const titles = record.windows.map((w) => w.options.title);
    assert(
      titles.some((t) => String(t).includes('悬浮窗')),
      `没有找到悬浮窗，实际标题: ${titles.join(' / ')}`
    );
    assert(
      titles.some((t) => String(t).includes('控制面板')),
      `没有找到控制面板，实际标题: ${titles.join(' / ')}`
    );
  });

  await test('用户数据目录被指到程序目录下的 data/', async () => {
    const { record } = await boot({ autoShow: true });
    const call = record.setPathCalls.find((item) => item.name === 'userData');
    assert(call, '没有调用 app.setPath("userData", ...)');
    assert(call.value.endsWith('data'), `userData 应指向 data 目录，实际 ${call.value}`);
  });

  await test('悬浮窗按设置应用了置顶 / 穿透 / 全工作区可见', async () => {
    const { record } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');
    assert(overlay.options.transparent === true, '悬浮窗应开启透明');
    assert(overlay.options.frame === false, '悬浮窗应无边框');
    assert(overlay.alwaysOnTop.some((item) => item.value === true), '悬浮窗应设置为置顶');
    assert(overlay.workspaces === true, '悬浮窗应设置为所有工作区可见');

    // 悬浮窗默认收起快捷设置，此时鼠标必须可用（否则按钮点不动）。
    // 关键点：悬浮窗绝不能处于「忽略鼠标事件」状态。
    const ignored = record.ignoreMouseCalls.filter((item) => item.id === overlay.id && item.ignore === true);
    assert(ignored.length === 0, `悬浮窗不应该被设成鼠标穿透，实际 ${ignored.length} 次`);
  });

  await test('收到的弹幕会转发给悬浮窗（对话区靠它显示观众的话）', async () => {
    // 真实踩过的 bug：copilot 的 danmaku 事件只 send 给了控制面板，
    // 悬浮窗的对话区因此永远收不到观众弹幕，只显示 AI 自己的回复。
    const { record, exported } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');
    assert(exported && exported.copilot, 'main.js 应该导出 copilot 供测试触发事件');

    const before = record.sent.length;
    exported.copilot.emit('danmaku', {
      id: '1791644566',
      ts: Date.now(),
      user: '菲尼尔--缀',
      uid: 1791644087,
      text: 'ciallo'
    });
    const sent = record.sent.slice(before);

    const toPanel = sent.filter((item) => item.channel === 'danmaku');
    assert(toPanel.length >= 1, '控制面板应该收到弹幕事件');
    const toOverlay = sent.filter(
      (item) => item.id === overlay.id && item.channel === 'danmaku'
    );
    assert(toOverlay.length === 1, `悬浮窗也应该收到弹幕事件，实际 ${toOverlay.length} 次`);
    // 转发过去的必须是完整事件（id / uid / 正文都要有，界面才有东西可显示）
    const payload = toOverlay[0].payload;
    assert(payload && payload.id === '1791644566', `弹幕 id 没带过去：${JSON.stringify(payload)}`);
    assert(payload.text === 'ciallo', '弹幕正文没带过去');
    assert(payload.uid === 1791644087, 'uid 没带过去');
  });

  await test('悬浮窗没开时，来弹幕也不会把窗口凭空创建出来', async () => {
    const { record, exported } = await boot({ autoShow: false });
    assert(!record.windows.some((w) => String(w.options.title).includes('悬浮窗')), '前置条件：不该有悬浮窗');

    exported.copilot.emit('danmaku', { id: 'x1', ts: Date.now(), user: '甲', uid: 1, text: '你好' });
    await new Promise((resolve) => setImmediate(resolve));

    assert(
      !record.windows.some((w) => String(w.options.title).includes('悬浮窗')),
      '只是收到一条弹幕，不应该把悬浮窗创建出来'
    );
  });

  await test('只创建控制面板和悬浮窗两个窗口（没有多余的窗口）', async () => {
    const { record } = await boot({ autoShow: true });
    const titles = record.windows.map((w) => String(w.options.title));
    assert(titles.length <= 2, `不该有额外的窗口，实际：${titles.join(' / ')}`);
    assert(titles.some((title) => title.includes('悬浮窗')), '悬浮窗应该还在');
  });

  await test('悬浮窗默认收起快捷设置，并且恒定可交互/可聚焦', async () => {
    const { record } = await boot({ settings: { overlay: { autoShow: true } } });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');

    // 默认（autoOpenDrawer 未开）应该主动收起快捷设置，避免「有时候一打开就弹设置」
    const opened = record.sent.some((item) => item.id === overlay.id && item.channel === 'overlay:openDrawer');
    assert(!opened, '默认不应该自动展开快捷设置');
    const closed = record.sent.some((item) => item.id === overlay.id && item.channel === 'overlay:closeDrawer');
    assert(closed, '应该显式通知悬浮窗收起快捷设置');

    // 关键：绝不能被设成「忽略鼠标事件」——悬浮窗只有卡片这么大，
    // 设了穿透就会出现「按钮点不动」这种问题
    const ignored = record.ignoreMouseCalls.filter((item) => item.id === overlay.id && item.ignore === true);
    assert(ignored.length === 0, `悬浮窗不应该被设成鼠标穿透，实际调用了 ${ignored.length} 次`);
    assert(overlay.ignoreMouse === false || overlay.ignoreMouse === null, '悬浮窗应保持可交互');
  });

  await test('打开「自动展开快捷设置」开关后才会展开', async () => {
    const { record } = await boot({
      settings: { overlay: { autoShow: true, autoOpenDrawer: true } }
    });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    const opened = record.sent.some((item) => item.id === overlay.id && item.channel === 'overlay:openDrawer');
    assert(opened, '打开开关后应该自动展开快捷设置');
  });

  await test('悬浮窗始终可聚焦，且不会因为界面请求而改焦点（避免闪动）', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');
    assert(overlay.options.focusable === true, '窗口创建时就应该是可聚焦的');

    // 兼容通道：界面早期会请求临时改焦点，那套逻辑会导致切换窗口时闪动，
    // 现在这个通道必须是无副作用的（不 focus 也不 blur、绝不设成不可聚焦）。
    const setFocusable = electron._ipcHandlers.get('overlay:setFocusable');
    await setFocusable(null, true);
    await setFocusable(null, false);
    const calls = record.focusableCalls.filter((item) => item.id === overlay.id);
    assert(
      calls.every((item) => item.value === true),
      `不应该把悬浮窗设成不可聚焦，实际调用: ${JSON.stringify(calls)}`
    );
    assert(overlay.focused !== true, '不应该因为界面请求去抢焦点');
  });

  await test('默认不自动显示悬浮窗，只有控制面板一个窗口', async () => {
    const { record } = await boot();
    const titles = record.windows.map((w) => w.options.title);
    assert(record.windows.length === 1, `默认应只有控制面板一个窗口，实际 ${record.windows.length} 个: ${titles.join(' / ')}`);
    assert(String(titles[0]).includes('控制面板'), `应只创建控制面板，实际 ${titles.join(' / ')}`);
    assert(!record.loadedFiles.some((f) => f.includes(path.join('overlay', 'index.html'))), '不应加载悬浮窗界面');
  });

  await test('点控制面板的按钮能打开悬浮窗，也能再关掉', async () => {
    const { record, electron } = await boot();
    assert(record.windows.length === 1, '起始应该只有控制面板');

    const toggle = electron._ipcHandlers.get('overlay:toggle');
    const hide = electron._ipcHandlers.get('overlay:hide');
    const isVisible = electron._ipcHandlers.get('overlay:isVisible');
    assert(!(await isVisible()), '一开始悬浮窗不可见');

    await toggle();
    // 新建的悬浮窗要等自己的 ready-to-show 才会显示；真实 Electron 由加载完成触发，
    // 这里显式模拟一次（不再依赖定时器，避免时序竞争导致偶发失败）。
    const settle = async (rounds = 10) => {
      for (let i = 0; i < rounds; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    await settle();
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '应该已经创建悬浮窗窗口');
    if (!overlay.visible) overlay.emit('ready-to-show');
    await settle();

    const findOverlay = () => record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(findOverlay(), `点按钮后应创建悬浮窗，实际 ${record.windows.length} 个窗口`);
    assert(await isVisible(), '点按钮后悬浮窗应该可见');

    await hide();
    assert(!(await isVisible()), '调 hide 之后悬浮窗应不可见');
    assert(findOverlay(), 'hide 只是隐藏，不应销毁窗口（下次打开更快）');
  });

  await test('悬浮窗覆盖全部显示器（虚拟桌面尺寸）', async () => {
    const { record } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    // 两个显示器横向排列：0..3200
    assert(overlay.bounds.width === 3200, `悬浮窗宽度应为 3200，实际 ${overlay.bounds.width}`);
    assert(overlay.bounds.height === 1080, `悬浮窗高度应为 1080，实际 ${overlay.bounds.height}`);
  });

  await test('两个窗口都加载了正确的界面文件', async () => {
    const { record } = await boot({ autoShow: true });
    const panel = record.loadedFiles.find((f) => f.includes(path.join('panel', 'index.html')));
    const overlay = record.loadedFiles.find((f) => f.includes(path.join('overlay', 'index.html')));
    assert(panel, `没有加载控制面板界面，实际: ${record.loadedFiles.join(' / ')}`);
    assert(overlay, `没有加载悬浮窗界面，实际: ${record.loadedFiles.join(' / ')}`);
  });

  await test('IPC 关键通道都注册了处理函数', async () => {
    const { electron } = await boot({ autoShow: true });
    const channels = [
      'settings:get',
      'settings:update',
      'settings:reset',
      'settings:openFolder',
      'settings:defaultPersona',
      'app:info',
      'overlay:setClickThrough',
      'overlay:setFocusable',
      'overlay:toggle',
      'overlay:testMessage',
      'overlay:openDrawer',
      'danmaku:start',
      'danmaku:stop',
      'danmaku:test',
      'llm:test',
      'copilot:talk',
      'copilot:replyRecent',
      'copilot:clearHistory',
      'copilot:history',
      'copilot:status',
      'bili:loginStatus',
      'bili:loginOpen',
      'bili:loginLogout',
      'bili:loginVerify',
      'bili:verifyManualCookie',
      'bili:cookieHeader',
      'mascot:pickImages',
      'log:get',
      'log:clear',
      'log:openFile',
      'window:openPanel',
      'window:quit'
    ];
    const missing = channels.filter((channel) => !electron._ipcHandlers.has(channel));
    assert(missing.length === 0, `缺少通道: ${missing.join(', ')}`);
  });

  await test('知识库落在软件目录的「知识库」里，DSH 的工作区就是它', async () => {
    const { electron } = await boot({ autoShow: true });
    // ① 目录：软件目录下的「知识库」（不是藏在 data/ 里的那个），骨架自动建好
    const listed = await electron._ipcHandlers.get('knowledge:list')();
    assert(listed.stats.dir === KNOWLEDGE_DIR, `知识库目录不对：${listed.stats.dir}`);
    assert(listed.stats.notesDir === path.join(KNOWLEDGE_DIR, 'notes'), `notes 目录不对：${listed.stats.notesDir}`);
    assert(listed.stats.inboxDir === path.join(KNOWLEDGE_DIR, 'inbox'), `inbox 目录不对：${listed.stats.inboxDir}`);
    for (const name of ['notes', 'pending', 'inbox']) {
      assert(fs.existsSync(path.join(KNOWLEDGE_DIR, name)), `${name} 目录没建好`);
    }
    assert(fs.existsSync(path.join(KNOWLEDGE_DIR, '说明.txt')), '应该写一份人能看懂的说明');
    // 启动日志也要说清楚库在哪（排查问题时全靠它）
    const bootLogFile = path.join(DATA_DIR, 'boot.log');
    const bootText = fs.existsSync(bootLogFile) ? fs.readFileSync(bootLogFile, 'utf8') : '';
    assert(bootText.includes('知识库'), `启动日志里应该写知识库位置：${bootText.slice(-400)}`);

    // ② DSH 的工作区必须和知识库是同一个目录：
    //    不一致的话「工作区被限定在知识库文件夹里」就是句空话
    const detected = await electron._ipcHandlers.get('dsh:detect')(null, {});
    assert(detected.workspace === listed.stats.dir, `DSH 工作区与知识库目录不一致：${detected.workspace}`);
    assert(detected.workspaceNoticeSeen === false, '默认该是「还没告知过工作区」');

    // ③ 「打开文件夹」打开的必须是知识库根目录（notes / pending / inbox 都在这儿）
    const opened = await electron._ipcHandlers.get('knowledge:openFolder')();
    assert(opened === KNOWLEDGE_DIR, `打开的不是知识库根目录：${opened}`);
  });

  await test('设置读写通道真的能读写配置', async () => {
    const { electron, record } = await boot({ autoShow: true });
    const get = electron._ipcHandlers.get('settings:get');
    const update = electron._ipcHandlers.get('settings:update');
    const before = await get();
    assert(typeof before === 'object' && before.api, 'settings:get 返回结构不对');
    const after = await update(null, { danmaku: { roomId: '1234567' } });
    assert(after.danmaku.roomId === '1234567', 'settings:update 没有写入房间号');
    const info = await electron._ipcHandlers.get('app:info')();
    assert(info.settingsFile.endsWith('settings.json'), `app:info 配置路径不对: ${info.settingsFile}`);
    // 主进程把 userData 指向了「程序目录/data」，所以配置和日志都应在那里
    const dataDir = path.join(root, 'data');
    assert(info.dataFolder === dataDir, `app:info 数据目录应为 ${dataDir}，实际 ${info.dataFolder}`);
    assert(
      info.dataFolder === path.dirname(info.settingsFile),
      `app:info 的数据目录与配置文件目录不一致: ${info.dataFolder} / ${info.settingsFile}`
    );
    // 说明：在纯 Node 里 process.versions.electron 是 undefined，
    // 这三个版本字段在真实 Electron 里才会有值，所以这里只检查字段存在。
    assert(info.versions && typeof info.versions === 'object', 'app:info 缺少版本信息');
    for (const key of ['electron', 'chrome', 'node']) {
      assert(key in info.versions, `app:info 版本信息缺少 ${key}`);
    }
    // 配置应该真的落盘了
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    assert(saved.danmaku.roomId === '1234567', '配置没有写入文件');
    void record;
  });

  await test('copilot:systemPrompt 给模板、渲染结果，且能保存自定义提示词', async () => {
    const { electron } = await boot();
    const handler = electron._ipcHandlers.get('copilot:systemPrompt');
    const update = electron._ipcHandlers.get('settings:update');
    assert(handler, '缺少 copilot:systemPrompt 通道');

    // 不带参数 = 可编辑的模板（带占位符）
    const template = await handler(null);
    assert(typeof template === 'string' && template.length > 200, `模板太短: ${String(template).length}`);
    for (const marker of ['{人设}', '{搭档名字}', '{当前时间}', '{情绪清单}', '{主播称呼}']) {
      assert(String(template).includes(marker), `模板里缺少占位符 ${marker}`);
    }
    for (const marker of ['权限规则', '输出要求', '[情绪:', '规则:']) {
      assert(String(template).includes(marker), `模板里缺少「${marker}」这一段`);
    }

    // 带 true = 渲染后的最终文本：不该再残留任何占位符
    const rendered = await handler(null, true);
    assert(!/\{[^}]+\}/.test(String(rendered)), `渲染后仍有占位符: ${String(rendered).match(/\{[^}]+\}/g)}`);
    assert(String(rendered).includes('聊天原则'), '渲染结果里应该有聊天原则');

    // 保存一份自定义提示词 → 渲染结果应该跟着变
    await update(null, { persona: { systemPromptOverride: '你是一个只回答"喵"的猫娘。{当前时间}' } });
    const custom = await handler(null, true);
    assert(String(custom).startsWith('你是一个只回答'), `自定义提示词没生效: ${String(custom).slice(0, 40)}`);
    assert(!String(custom).includes('{当前时间}'), '自定义模板里的占位符也该被渲染');

    // 恢复默认 → 又回到内置模板
    await update(null, { persona: { systemPromptOverride: '' } });
    const back = await handler(null, true);
    assert(String(back).includes('权限规则'), '恢复默认后应该回到内置模板');
  });

  await test('settings:update 能删掉吉祥物图片（回归：删除曾经完全无效）', async () => {
    const { electron } = await boot({ autoShow: true });
    const update = electron._ipcHandlers.get('settings:update');
    // 先放两张图进去（模拟上传）
    await update(null, {
      mascot: {
        images: { '平常.png': 'data:plain', '开心.png': 'data:happy' },
        expressions: { idle: '平常.png', happy: '开心.png' }
      }
    });
    let now = await electron._ipcHandlers.get('settings:get')();
    assert(Object.keys(now.mascot.images).length === 2, '前置条件不对：两张图没写进去');

    // 再照「删除」按钮的做法提交：只给剩下的图
    const nextImages = { ...now.mascot.images };
    delete nextImages['开心.png'];
    const nextExpressions = { ...now.mascot.expressions };
    for (const [emotion, target] of Object.entries(nextExpressions)) {
      if (target === '开心.png') nextExpressions[emotion] = '';
    }
    await update(null, { mascot: { images: nextImages, expressions: nextExpressions } });

    now = await electron._ipcHandlers.get('settings:get')();
    assert(!('开心.png' in now.mascot.images), `删除没生效，图片表还是: ${Object.keys(now.mascot.images).join(',')}`);
    assert(now.mascot.expressions.happy === '', '指向被删图片的映射没有清掉');
    // 落盘的配置也要是真的删了（不能只在内存里生效）
    const info = await electron._ipcHandlers.get('app:info')();
    const saved = JSON.parse(fs.readFileSync(info.settingsFile, 'utf8'));
    assert(!('开心.png' in saved.mascot.images), '配置文件里那张图还在');
  });

  await test('点击穿透通道会作用到悬浮窗上', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    record.ignoreMouseCalls.length = 0;
    // 模拟渲染层报告「鼠标移出吉祥物」→ 需要穿透
    await electron._ipcHandlers.get('overlay:setClickThrough')(null, true);
    // 模拟「鼠标移到吉祥物上」→ 需要交互
    await electron._ipcHandlers.get('overlay:setClickThrough')(null, false);
    const values = record.ignoreMouseCalls.map((c) => c.ignore);
    assert(values.includes(false), `没有把穿透关掉，实际调用: ${JSON.stringify(values)}`);
    assert(overlay.ignoreMouse === false, '最终状态应为可交互');
  });

  await test('回复会同时推给悬浮窗和控制面板', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const testMessage = electron._ipcHandlers.get('overlay:testMessage');
    record.sent.length = 0;
    const reply = await testMessage(null, { text: '这是一条测试回复', emotion: 'happy' });
    assert(reply.text === '这是一条测试回复', '返回值不对');
    const delivered = record.sent.filter((item) => item.channel === 'ai:reply');
    assert(delivered.length >= 1, `ai:reply 没有送达任何窗口，实际: ${JSON.stringify(record.sent.map((s) => s.channel))}`);
    assert(
      delivered.some((item) => item.payload.text === '这是一条测试回复'),
      '送达的回复内容不对'
    );
  });

  await test('弹幕事件会被转发到控制面板', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const copilot = electron._ipcHandlers.get('copilot:status');
    assert(copilot, '没有 copilot:status 通道');
    // 通过主进程内部服务触发一条弹幕，检查是否送到窗口
    record.sent.length = 0;
    const start = electron._ipcHandlers.get('danmaku:start');
    // 没填房间号时应该返回错误而不是抛异常
    const result = await start();
    assert(result && (result.error || result.danmaku), `danmaku:start 返回异常: ${JSON.stringify(result)}`);
  });

  await test('界面加载失败 / 渲染进程崩溃都有处理', async () => {
    const { record } = await boot({ autoShow: true });
    const missing = [];
    for (const win of record.windows) {
      // 健康检查挂在 webContents 上（真实 Electron 也是这个层级）
      const handlers = win.webContents._devToolsHandlers || {};
      for (const event of ['did-fail-load', 'render-process-gone', 'unresponsive']) {
        if (!handlers[event]) missing.push(`${win.options.title}:${event}`);
      }
    }
    assert(
      missing.length === 0,
      `缺少处理: ${missing.join(', ')}；窗口共有: ${record.windows.map((w) => w.options.title).join(' / ')}`
    );

    // 触发一次加载失败，应该写进 crash.log 并弹错误提示
    const crashLog = path.join(root, 'data', 'crash.log');
    const before = fs.existsSync(crashLog) ? fs.statSync(crashLog).size : 0;
    const panel = record.windows.find((w) => String(w.options.title).includes('控制面板'));
    panel.webContents._devToolsHandlers['did-fail-load'](null, -6, 'ERR_FILE_NOT_FOUND', 'file:///nope/index.html');
    const after = fs.existsSync(crashLog) ? fs.statSync(crashLog).size : 0;
    assert(after > before, `加载失败没有写入 ${crashLog}`);
    assert(record.errorBoxes.length >= 1, '加载失败没有弹出错误提示');
  });

  await test('悬浮窗位置/尺寸由渲染层上报，并会被限制在屏幕内', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');
    const setBounds = electron._ipcHandlers.get('window:setBounds');
    assert(setBounds, '没有注册 window:setBounds');

    // 正常范围
    await setBounds(null, { x: 800, y: 300, width: 460, height: 620 });
    assert(overlay.bounds.width === 460, `宽度没生效: ${overlay.bounds.width}`);
    assert(overlay.bounds.height === 620, `高度没生效: ${overlay.bounds.height}`);
    assert(overlay.bounds.x === 800 && overlay.bounds.y === 300, '位置没生效');

    // 给出屏幕外的坐标，应该被夹回可见区域
    await setBounds(null, { x: 99999, y: 99999, width: 460, height: 620 });
    const union = { width: 3200, height: 1080 };
    assert(overlay.bounds.x + overlay.bounds.width <= union.width, `窗口不该跑出屏幕右侧: ${overlay.bounds.x}`);
    assert(overlay.bounds.y + overlay.bounds.height <= union.height, `窗口不该跑出屏幕底部: ${overlay.bounds.y}`);

    // 尺寸也应该被限制在合理范围
    await setBounds(null, { x: 10, y: 10, width: 99999, height: 99999 });
    assert(overlay.bounds.width <= 1600, `宽度应被限制，实际 ${overlay.bounds.width}`);
    assert(overlay.bounds.height <= 1800, `高度应被限制，实际 ${overlay.bounds.height}`);
  });

  await test('悬浮窗：自动布局只改大小、不动位置（回归：拖到屏幕外会被拽回来）', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');
    const setBounds = electron._ipcHandlers.get('window:setBounds');
    const union = { x: 0, y: 0, width: 3200, height: 1080 };

    // 主播把窗口拖到左上角外面（真实拖动就是会出负数坐标）
    await setBounds(null, { x: -260, y: -80, width: 460, height: 620, position: 'set', clamp: 'visible' });
    assert(
      overlay.bounds.x === -260 && overlay.bounds.y === -80,
      `可见夹取不该挪动这个位置：${overlay.bounds.x},${overlay.bounds.y}`
    );

    // 来一条回复 → 渲染层重算高度（position:'keep'）→ 位置必须一动不动
    await setBounds(null, { x: 0, y: 0, width: 460, height: 700, position: 'keep', clamp: 'visible' });
    assert(
      overlay.bounds.x === -260 && overlay.bounds.y === -80,
      `自动布局把窗口移走了：${overlay.bounds.x},${overlay.bounds.y}`
    );
    assert(overlay.bounds.height === 700, `高度没跟着变：${overlay.bounds.height}`);

    // 拖到远远在屏幕外 → 保底留 48px 可见（不然抓不住、拖不回来）
    await setBounds(null, { x: -99999, y: 99999, width: 460, height: 620, position: 'set', clamp: 'visible' });
    assert(overlay.bounds.x + 460 >= union.x + 48, `左侧至少留 48px 可见：${overlay.bounds.x}`);
    assert(overlay.bounds.y <= union.y + union.height - 48, `顶部至少留 48px 可见：${overlay.bounds.y}`);

    // 首次定位 / 重置仍然要完整夹进屏幕
    await setBounds(null, { x: 99999, y: 99999, width: 460, height: 620, position: 'set', clamp: 'inside' });
    assert(
      overlay.bounds.x + 460 <= union.x + union.width && overlay.bounds.y + 620 <= union.y + union.height,
      `完整夹取没生效：${overlay.bounds.x},${overlay.bounds.y}`
    );
  });

  await test('显示器变化时不会把悬浮窗改成整块虚拟屏（回归：换分辨率后窗口突然跳到左上角）', async () => {
    const { record, electron } = await boot({ autoShow: true });
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '没有悬浮窗');
    const setBounds = electron._ipcHandlers.get('window:setBounds');
    await setBounds(null, { x: 800, y: 300, width: 460, height: 620 });
    const before = overlay.getBounds();
    assert(before.x === 800 && before.y === 300, `前置：窗口应该摆在 800/300，实际 ${before.x}/${before.y}`);

    const onDisplayChange = record.screenEvents.get('display-metrics-changed');
    assert(onDisplayChange, '没有监听 display-metrics-changed');
    // 主播换了分辨率 / 拔了显示器：这里以前会 `setBounds(整块虚拟屏)`，
    // 窗口瞬间变全屏、再被渲染层改回大小，位置却已经落到虚拟屏左上角。
    onDisplayChange({}, { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, ['scaleFactor']);
    const after = overlay.getBounds();
    assert(
      after.width === before.width && after.height === before.height,
      `显示器变化不该改窗口尺寸：${before.width}x${before.height} → ${after.width}x${after.height}`
    );
    assert(
      after.x === before.x && after.y === before.y,
      `显示器变化不该挪窗口：${before.x}/${before.y} → ${after.x}/${after.y}`
    );
  });

  await test('后台广播不会把悬浮窗「顺便」创建出来（回归测试）', async () => {
    // 真实发生过的现象：启动后弹幕自动连接 → 广播状态 → 悬浮窗自己冒出来了。
    // 原因是 broadcast 会顺手创建悬浮窗。现在只有用户主动打开才会创建。
    const { record, electron } = await boot();
    assert(record.windows.length === 1, '起始只有控制面板');

    // 模拟弹幕连接过程中的状态广播
    await electron._ipcHandlers.get('copilot:status')();
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
    const created = record.windows.filter((w) => String(w.options.title).includes('悬浮窗'));
    assert(created.length === 0, `后台广播不应该创建悬浮窗，实际创建了 ${created.length} 个`);

    // 用户主动点「显示悬浮窗」时才创建
    await electron._ipcHandlers.get('overlay:toggle')();
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setImmediate(resolve));
    }
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(overlay, '用户主动打开后应该创建悬浮窗');
    if (!overlay.visible) overlay.emit('ready-to-show');
    assert(await electron._ipcHandlers.get('overlay:isVisible')(), '用户主动打开后应该可见');

    // 关掉之后，后台广播同样不能再把它拉起来
    await electron._ipcHandlers.get('overlay:hide')();
    await electron._ipcHandlers.get('copilot:status')();
    assert(!(await electron._ipcHandlers.get('overlay:isVisible')()), '关闭后不应该因为广播又显示出来');
  });

  await test('关掉控制面板会退出整个程序（悬浮窗、托盘一起收掉）', async () => {
    const { record } = await boot({ autoShow: true });
    const panel = record.windows.find((w) => String(w.options.title).includes('控制面板'));
    const overlay = record.windows.find((w) => String(w.options.title).includes('悬浮窗'));
    assert(panel && overlay, '应该同时存在控制面板和悬浮窗');
    assert(!record.quitCalled, '启动后不应该已经退出');

    // 模拟用户点面板右上角的关闭按钮
    panel.close();

    assert(record.quitCalled, '关闭控制面板后应该调用 app.quit()');
    const destroyedTitles = record.destroyed.map((item) => item.title).join(' / ');
    assert(
      record.destroyed.some((item) => String(item.title).includes('悬浮窗')),
      `悬浮窗应该被销毁，实际销毁了: ${destroyedTitles || '（无）'}`
    );
    assert(
      record.destroyed.some((item) => String(item.title).includes('控制面板')),
      `控制面板应该被销毁，实际销毁了: ${destroyedTitles || '（无）'}`
    );
    assert(record.trayDestroyed, '托盘图标应该被销毁（否则任务栏残留图标）');
  });

  await test('窗口被其它途径关光时也会兜底退出，不留无窗口进程', async () => {
    const { record, electron } = await boot({ autoShow: true });
    // 直接触发 window-all-closed
    const handler = electron._appListeners.get('window-all-closed');
    assert(handler, '没有注册 window-all-closed 处理');
    handler();
    assert(record.quitCalled, '所有窗口关闭后应该退出程序');
  });

  await test('托盘创建成功，菜单项齐全', async () => {
    const { record, electron } = await boot({ autoShow: true });
    assert(record.trayCreated, '托盘没有创建');
    void electron;
  });

  await test('显示器变化会重新布局悬浮窗', async () => {
    const { record } = await boot({ autoShow: true });
    assert(record.screenEvents.has('display-metrics-changed'), '没有监听显示器变化');
    assert(record.screenEvents.has('display-added'), '没有监听显示器新增');
    assert(record.screenEvents.has('display-removed'), '没有监听显示器移除');
  });

  await test('自检模式：不创建窗口、以退出码 0 结束、结果写进日志', async () => {
    const { record } = await boot({ argv: ['--smoke-test'] });
    assert(record.exitCode === 0, `自检应以 0 退出，实际 ${record.exitCode}`);
    assert(record.windows.length === 0, '自检模式不应创建窗口');
    const logText = readLog();
    assert(logText.includes('启动自检通过'), `日志里应记录自检结果，实际末尾: ${logText.slice(-160)}`);
  });

  await test('主播在对话里回一句「查」→ 真跑一次查询、产出进待审、面板收到她的回话', async () => {
    // 知识库指到临时目录：这几条用例会真的写「待审草稿」，绝不能写进主播自己的知识库
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-research-'));
    const { record, exported, electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    // 只把「网络那一跳」换掉：从待办到待审草稿的整条路都是真的（真 main.js、真知识库、真队列）
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '===知识条目===\n标题：星轨杯\n内容：一个线上比赛。\n标签：比赛' }]
      })
    });
    try {
      // 模拟模型提了一条「想查」（走的是真入队 + 真通知主进程那条路）
      const [item] = exported.copilot.queueResearch(
        [{ kind: 'lookup', text: '星轨杯', reason: '观众提到的比赛' }],
        [{ type: 'danmaku', nickname: '路人', text: '你听说过星轨杯吗' }]
      );
      assert(item, '待办没进队列');

      // 她要主动开口问（测试里不等那几秒延迟，直接推到「问出口」）
      exported.copilot.enqueueResearchAsk(item);
      const askReply = exported.copilot.pumpResearchAsk();
      assert(askReply && askReply.text.includes('星轨杯'), `她该问一句：${askReply && askReply.text}`);
      assert(
        record.sent.some((entry) => entry.channel === 'ai:reply' && String(entry.payload.text || '').includes('星轨杯')),
        '这句问话要送达到窗口（面板 / 悬浮窗）'
      );

      record.sent.length = 0;
      await exported.copilot.talk('查'); // 主播一句话同意
      // 查询是异步的：等她把结果说出来
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (record.sent.some((entry) => entry.channel === 'ai:reply' && entry.payload.source === 'research-result')) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const result = record.sent.find((entry) => entry.channel === 'ai:reply' && entry.payload.source === 'research-result');
      assert(result, `她该把结果告诉主播，实际发出去的：${record.sent.map((s) => s.channel).join(',')}`);
      assert(/待审/.test(result.payload.text), `结果里要说清进哪儿了：${result.payload.text}`);

      const listed = await electron._ipcHandlers.get('knowledge:list')();
      assert(
        listed.pending.length === 1,
        `产出应该进「待审草稿」，实际 ${listed.pending.length} 条；她的回话：${result.payload.text}`
      );
      assert(listed.pending[0].title.includes('星轨杯'), `草稿标题不对：${listed.pending[0].title}`);
      assert(listed.items.length === 0, '没点通过之前绝不能进知识库');

      assert(
        record.sent.some((entry) => entry.channel === 'research:changed'),
        '面板的待办卡片要刷新'
      );
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('主播说「记下来」→ 直接记进知识库（不联网、留改动记录、能撤销）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-note-'));
    const { exported, electron } = await boot({ autoShow: true, settings: { knowledge: { dir: tempKb } } });
    const originalFetch = global.fetch;
    let fetched = 0;
    global.fetch = async () => {
      fetched += 1;
      return { ok: true, status: 200, json: async () => ({ content: [] }) };
    };
    try {
      const [item] = exported.copilot.queueResearch(
        [{ kind: 'note', text: '下周六晚八点联动直播' }],
        [{ type: 'danmaku', nickname: '路人', text: '下周六晚上八点联动' }]
      );
      exported.copilot.enqueueResearchAsk(item);
      exported.copilot.pumpResearchAsk();
      await exported.copilot.talk('记下来');

      const deadline = Date.now() + 3000;
      let listed = null;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        listed = await electron._ipcHandlers.get('knowledge:list')();
        if (listed.items.length) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(listed.items.length === 1, `应该直接进知识库，实际 ${listed.items.length} 条`);
      assert(listed.items[0].title.includes('联动'), `条目标题不对：${listed.items[0].title}`);
      assert(listed.pending.length === 0, 'P6 之后不再走「待审草稿」（主播把写库权限交给她了）');
      assert(fetched === 0, '「记一笔」不该联网（这条事实是直播间里说出来的）');

      const edits = await electron._ipcHandlers.get('knowledge:edits')();
      const created = edits.edits.find((entry) => entry.kind === 'create');
      assert(created, `要留一条 create 记录：${edits.edits.map((e) => e.kind).join('/')}`);

      const undone = await electron._ipcHandlers.get('knowledge:undoEdit')(null, created.id);
      assert(undone.ok, undone.reason);
      assert(undone.stats.count === 0, '撤销「她记的」之后库里就没有这条了');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('她自己发现写错了就直接改：改前留备份、她告诉主播、面板能撤销', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-selfedit-'));
    const { record, exported, electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb, selfEdit: 'auto', selfEditPerHour: 10 },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    // 先放一条「写错了」的知识进去（走真实的 knowledge:add）
    await electron._ipcHandlers.get('knowledge:add')(null, {
      title: '终末地',
      content: '终末地是 2025 年公测的 3D 续作。',
      tags: '游戏'
    });

    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/chat/completions')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              model: 'deepseek-flash',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '终末地是 2026 年 1 月公测的 3D 续作，玩法是四人小队实时战斗。' },
                  finish_reason: 'stop'
                }
              ],
              usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 }
            })
        };
      }
      throw new Error(`不该请求这个地址：${url}`);
    };
    try {
      record.sent.length = 0;
      // 模型在回复里提了「改一下」→ onResearch 看到她有直接改的权限，于是她自己动手
      exported.copilot.queueResearch(
        [{ kind: 'edit', text: '终末地', reason: '公测时间写错了' }],
        [{ type: 'danmaku', nickname: '路人', text: '终末地是 2026 年才公测的' }]
      );

      const deadline = Date.now() + 4000;
      let listed = null;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        listed = await electron._ipcHandlers.get('knowledge:list')();
        if (listed.items[0] && listed.items[0].content.includes('2026')) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert(calls.some((url) => url.includes('/chat/completions')), '应该调了一次模型来重写正文');
      assert(listed.items[0].content.includes('2026 年 1 月'), `知识没被改：${listed.items[0].content}`);
      assert(listed.items[0].content.includes('四人小队'), '新内容要写进去');

      const edits = await electron._ipcHandlers.get('knowledge:edits')();
      const change = edits.edits.find((entry) => entry.kind === 'edit');
      assert(change, `要留一条 edit 记录：${edits.edits.map((e) => e.kind).join('/')}`);
      assert(change.hasBackup, '改之前必须备份（不然撤销无从谈起）');

      // 她得把这件事告诉主播（不能偷偷改）
      const told = record.sent.find((entry) => entry.channel === 'ai:reply' && entry.payload.source === 'research-result');
      assert(told, '她要回报一声');
      assert(/改好|补好|撤销/.test(told.payload.text), `回报要把「改了 + 能撤销」说清：${told.payload.text}`);

      const undone = await electron._ipcHandlers.get('knowledge:undoEdit')(null, change.id);
      assert(undone.ok, undone.reason);
      const after = await electron._ipcHandlers.get('knowledge:list')();
      assert(after.items[0].content.includes('2025 年公测'), `撤销之后要回到旧版本：${after.items[0].content}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('「每小时最多几次」到顶了就攒着不办（她不会一直改）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cap-'));
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb, selfEdit: 'auto', selfEditPerHour: 1 },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const originalFetch = global.fetch;
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: { role: 'assistant', content: '甲这条改完之后的正文，长度足够，不会被「太短」那条规则拦下来。' },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
          })
      };
    };
    try {
      // 先清掉之前用例留下的已完成待办：计数是按「最近一小时自动改了几次」算的，
      // 不清的话这条用例会被上一个用例的记录顶掉（同一个 data 目录被多次 boot 复用）
      await electron._ipcHandlers.get('research:clearFinished')();
      await electron._ipcHandlers.get('knowledge:add')(null, {
        title: '甲',
        content: '甲这条内容挺长的，足够用来测改库的下限判断逻辑。',
        tags: ''
      });
      await electron._ipcHandlers.get('knowledge:add')(null, {
        title: '乙',
        content: '乙这条内容也挺长的，足够用来测改库的次数上限。',
        tags: ''
      });
      // 第一条：额度够，应该真改
      const [first] = exported.copilot.queueResearch([{ kind: 'edit', text: '甲', reason: '测试' }], []);
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const q = await electron._ipcHandlers.get('research:list')();
        if (q.items.find((entry) => entry.id === first.id && entry.status === 'done')) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const callsAfterFirst = calls;
      assert(callsAfterFirst >= 1, '第一条应该真的走过模型');

      // 第二条：到顶了 → 只挂着，不再调模型
      const [second] = exported.copilot.queueResearch([{ kind: 'edit', text: '乙', reason: '测试' }], []);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert(calls === callsAfterFirst, `到顶之后不该再调模型，实际又多调了 ${calls - callsAfterFirst} 次`);
      const q = await electron._ipcHandlers.get('research:list')();
      const waiting = q.items.find((entry) => entry.id === second.id);
      assert(waiting && waiting.status === 'pending', `超限的那条要留在待办里等主播点，实际 ${waiting && waiting.status}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('主播在输入框里直接让她查 → 真的查了、进待审、她回报结果', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-ask-'));
    const { record, exported, electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: '===知识条目===\n标题：空洞骑士：丝之歌\n内容：2025 年发售的续作。\n标签：游戏' }]
      })
    });
    try {
      record.sent.length = 0;
      await exported.copilot.talk('帮我查一下《空洞骑士：丝之歌》');
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        if (record.sent.some((entry) => entry.channel === 'ai:reply' && entry.payload.source === 'research-result')) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      const listed = await electron._ipcHandlers.get('knowledge:list')();
      assert(listed.pending.length === 1, `产出应该进「待审草稿」，实际 ${listed.pending.length} 条`);
      const result = record.sent.find((entry) => entry.channel === 'ai:reply' && entry.payload.source === 'research-result');
      assert(result, '她该回报结果');
      assert(/待审/.test(result.payload.text), `结果里要说清进哪儿了：${result.payload.text}`);

      // 待办队列里也要留下这一条，并标成「主播自己在对话里要求的」。
      // 注意：同一个 data 目录会被这轮测试里多次 boot 反复用，队列里可能还有别的用例留下的条目，
      // 所以只挑我们关心的那条断言，不数总数。
      const queue = await electron._ipcHandlers.get('research:list')();
      const mine = queue.items.find((item) => String(item.text).includes('空洞骑士'));
      assert(mine, `待办队列里应该有这一条：${queue.items.map((item) => item.text).join(' / ')}`);
      assert(mine.status === 'done', `状态应为已完成，实际 ${mine.status}`);
      assert(/主播/.test(mine.source), `要记清是谁要的：${mine.source}`);

      // 「查完了」要推一条 drafts:ready 给面板 —— 面板靠它在右下角弹「全部通过」的快捷提示
      // （主播要的：别每次都点进知识库页再一条条点通过）
      const draftsEvent = record.sent.find((entry) => entry.channel === 'drafts:ready');
      assert(draftsEvent, `该推 drafts:ready，实际发出去的：${[...new Set(record.sent.map((s) => s.channel))].join(',')}`);
      assert(draftsEvent.payload.count >= 1, `drafts:ready 里要带上数量：${JSON.stringify(draftsEvent.payload)}`);
      assert(
        Array.isArray(draftsEvent.payload.titles) && draftsEvent.payload.titles.length >= 1,
        `drafts:ready 里要带上标题（提示上要显示）：${JSON.stringify(draftsEvent.payload)}`
      );
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('最高权限：`[待查:]` 她自己就查了，产出也她自己通过掉（留记录、能撤销）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-max-'));
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        agent: { maxPermissions: true, searchPerHour: 6, toolsPerHour: 30 },
        knowledge: { dir: tempKb, selfEditPerHour: 10 },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const originalFetch = global.fetch;
    let searched = 0;
    global.fetch = async (url) => {
      if (String(url).includes('/anthropic/v1/messages')) {
        searched += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [
              { type: 'text', text: '===知识条目===\n标题：星轨杯\n内容：一个线上比赛。\n标签：比赛' }
            ]
          })
        };
      }
      throw new Error(`不该请求这个地址：${url}`);
    };
    try {
      await electron._ipcHandlers.get('research:clearFinished')();
      exported.copilot.queueResearch(
        [{ kind: 'lookup', text: '星轨杯', reason: '观众提到的比赛' }],
        [{ type: 'danmaku', nickname: '路人', text: '你听说过星轨杯吗' }]
      );

      const deadline = Date.now() + 5000;
      let listed = null;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        listed = await electron._ipcHandlers.get('knowledge:list')();
        if (listed.items.length) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(searched >= 1, '最高权限下她应该自己发起联网查询（没调接口）');
      assert(listed.items.length === 1, `产出应该由她自己写进知识库，实际 ${listed.items.length} 条`);
      assert(listed.pending.length === 0, '最高权限下不该再堆「待审草稿」');
      assert(listed.items[0].title.includes('星轨杯'), `条目不对：${listed.items[0].title}`);

      const edits = await electron._ipcHandlers.get('knowledge:edits')();
      const created = edits.edits.find((entry) => entry.kind === 'create');
      assert(created, `自动通过也要留一条记录（不然没法撤销）：${edits.edits.map((e) => e.kind).join('/')}`);
      const undone = await electron._ipcHandlers.get('knowledge:undoEdit')(null, created.id);
      assert(undone.ok, undone.reason);
      assert(undone.stats.count === 0, '撤销之后这条应该没了');

      // 待办本身也要记成「她自己办的」，才能算进 searchPerHour
      const queue = await electron._ipcHandlers.get('research:list')();
      const item = queue.items.find((entry) => entry.text.includes('星轨杯'));
      assert(item && item.status === 'done', `待办状态不对：${item && item.status}`);
      assert(item.auto === true, '要标成「她自己办的」（次数上限靠这个统计）');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('最高权限：她点的软件功能真执行（静音），没打开时一动不动', async () => {
    // ① 打开最高权限：`[做:静音]` → 语音静音真的生效
    const tempKb1 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tool1-'));
    const first = await boot({
      autoShow: true,
      settings: { agent: { maxPermissions: true }, knowledge: { dir: tempKb1 } }
    });
    try {
      const before = await first.electron._ipcHandlers.get('settings:get')();
      assert((before.speech || {}).muted !== true, '前提：默认没静音');
      first.exported.copilot.handleToolCalls([{ name: 'mute', arg: '' }]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = await first.electron._ipcHandlers.get('settings:get')();
      assert(after.speech.muted === true, '最高权限下她应该真的把自己静音了');
      const bootText = fs.existsSync(path.join(DATA_DIR, 'boot.log'))
        ? fs.readFileSync(path.join(DATA_DIR, 'boot.log'), 'utf8')
        : '';
      assert(/她自己操作了软件/.test(bootText.slice(-2000)), `启动日志里要留痕：${bootText.slice(-300)}`);
    } finally {
      fs.rmSync(tempKb1, { recursive: true, force: true });
    }

    // ② 没打开：同一个调用什么都不做（但日志里说明被忽略了）
    const tempKb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-tool2-'));
    const second = await boot({ autoShow: true, settings: { knowledge: { dir: tempKb2 } } });
    try {
      second.exported.copilot.handleToolCalls([{ name: 'mute', arg: '' }]);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const after = await second.electron._ipcHandlers.get('settings:get')();
      assert((after.speech || {}).muted !== true, '没开最高权限时，她动不了软件状态');
      assert(/最高权限没开/.test(readLog()), '要说明为什么没执行');
    } finally {
      fs.rmSync(tempKb2, { recursive: true, force: true });
    }
  });

  await test('最高权限：她删条目也会先备份，面板能一键恢复', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-del-'));
    const { exported, electron } = await boot({
      autoShow: true,
      settings: { agent: { maxPermissions: true }, knowledge: { dir: tempKb, selfEdit: 'auto' } }
    });
    try {
      await electron._ipcHandlers.get('knowledge:add')(null, {
        title: '早就过时的梗',
        content: '这个梗 2023 年就没人提了，留着只会误导观众。',
        tags: '梗'
      });
      const [item] = exported.copilot.queueResearch([{ kind: 'remove', text: '早就过时的梗' }], []);
      assert(item, '删条目的待办没进队列');
      const deadline = Date.now() + 3000;
      let listed = null;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        listed = await electron._ipcHandlers.get('knowledge:list')();
        if (!listed.items.length) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(listed.items.length === 0, `她应该把这条删掉了，实际还剩 ${listed.items.length} 条`);

      const edits = await electron._ipcHandlers.get('knowledge:edits')();
      const removed = edits.edits.find((entry) => entry.kind === 'remove');
      assert(removed, `删除要留记录：${edits.edits.map((e) => e.kind).join('/')}`);
      const undone = await electron._ipcHandlers.get('knowledge:undoEdit')(null, removed.id);
      assert(undone.ok, undone.reason);
      const back = await electron._ipcHandlers.get('knowledge:list')();
      assert(back.items.length === 1 && back.items[0].title === '早就过时的梗', '撤销之后条目要回来');
    } finally {
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('开发者模式改设定：只有开发者模式算，改之前留一份旧的', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-persona-'));
    const historyDir = path.join(DATA_DIR, 'settings-history');
    const before = fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : [];
    const { exported, electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    const originalFetch = global.fetch;
    // 让模型每次都回「我改好了 + 改设定标记」
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: '好，我改好了喵～[改设定:人设|你是直播间的猫娘搭档，说话每句结尾带喵。]' },
              finish_reason: 'stop'
            }
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        })
    });
    try {
      // ① 普通对话里说 → **不许改**，而且要把「我没动」说出来（不然她会骗主播）
      await exported.copilot.talk('以后你的人设是猫娘，每句带喵');
      const afterNormal = await electron._ipcHandlers.get('settings:get')();
      assert(afterNormal.persona.systemPrompt !== '你是直播间的猫娘搭档，说话每句结尾带喵。', '普通对话里不该改设定');

      // ② 开发者模式里说 → 真的改
      await exported.copilot.talk('[开发者模式] 以后你的人设是猫娘，每句带喵');
      const afterDev = await electron._ipcHandlers.get('settings:get')();
      assert(
        afterDev.persona.systemPrompt === '你是直播间的猫娘搭档，说话每句结尾带喵。',
        `开发者模式下应该真的改了：${afterDev.persona.systemPrompt}`
      );
      const nowFiles = fs.existsSync(historyDir) ? fs.readdirSync(historyDir) : [];
      const added = nowFiles.filter((name) => !before.includes(name));
      assert(added.length >= 1, `改设定要先把旧值存一份：${historyDir}`);
      const saved = JSON.parse(fs.readFileSync(path.join(historyDir, added[added.length - 1]), 'utf8'));
      assert(saved.before !== saved.after, '备份里要有旧值和新值');
      assert(/猫娘/.test(saved.after), `备份里的新值不对：${saved.after}`);
      const bootText = fs.existsSync(path.join(DATA_DIR, 'boot.log'))
        ? fs.readFileSync(path.join(DATA_DIR, 'boot.log'), 'utf8')
        : '';
      assert(/开发者模式下改了自己的/.test(bootText.slice(-2000)), `启动日志里要留下「谁改了什么」：${bootText.slice(-300)}`);
    } finally {
      global.fetch = originalFetch;
      // 测试自己造的改设定记录删掉，别留在主播的数据目录里
      if (fs.existsSync(historyDir)) {
        for (const name of fs.readdirSync(historyDir)) {
          if (!before.includes(name)) fs.rmSync(path.join(historyDir, name), { force: true });
        }
        if (!before.length) fs.rmSync(historyDir, { recursive: true, force: true });
      }
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('最高权限：自动联网有次数上限（到顶就攒着等你点）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-cap2-'));
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        agent: { maxPermissions: true, searchPerHour: 1 },
        // 这条测的是「次数上限」，所以钉死在老办法上：一次查询只发一个请求，计数才对得上
        // （自研搜索那条路是「搜索 + 整理」两个请求，失败还会退回老办法再发一个）
        knowledge: { dir: tempKb, searchMode: 'model' },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const originalFetch = global.fetch;
    let searched = 0;
    global.fetch = async () => {
      searched += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: '===知识条目===\n标题：甲\n内容：甲的说明。' }] })
      };
    };
    try {
      await electron._ipcHandlers.get('research:clearFinished')();
      exported.copilot.queueResearch([{ kind: 'lookup', text: '甲游戏', reason: '测试' }], []);
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const q = await electron._ipcHandlers.get('research:list')();
        if (q.items.some((entry) => entry.kind === 'lookup' && entry.status === 'done')) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert(searched === 1, `第一条应该自己查（实际调了 ${searched} 次）`);

      const [second] = exported.copilot.queueResearch([{ kind: 'lookup', text: '乙游戏', reason: '测试' }], []);
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert(searched === 1, `到顶之后不该再自己查（又多查了 ${searched - 1} 次）`);
      const q = await electron._ipcHandlers.get('research:list')();
      const waiting = q.items.find((entry) => entry.id === second.id);
      assert(waiting && waiting.status === 'pending', `超限的要留在待办里：${waiting && waiting.status}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ 联网的两条路（主播可选的）
  // 这两条守的是「两种方法都兼容」：默认走自研搜索，接口挂了必须还能退回老办法。

  await test('联网两条路：默认走自研搜索接口（搜索 + 整理），产出照旧进待审', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-selfsearch-'));
    const { record, exported, electron } = await boot({
      autoShow: true,
      settings: {
        // 不写 searchMode：走默认值（默认就该是 self）
        knowledge: { dir: tempKb },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const originalFetch = global.fetch;
    const calls = [];
    const fakeResults = Array.from({ length: 3 }, (_, i) => ({
      rerank_score: 2.2 - i * 0.1,
      title: `结果${i + 1}`,
      url: `https://e${i + 1}.com/a`,
      summary: `第${i + 1}条的摘要`,
      site_name: '站点',
      date: '2026-10-16T00:00:00+00:00',
      authority: 3
    }));
    global.fetch = async (url, init) => {
      const target = String(url);
      calls.push({ url: target, body: init && init.body ? JSON.parse(init.body) : {} });
      if (target.includes('/v1/tools/search')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: fakeResults }) };
      }
      if (target.includes('/chat/completions')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [{ message: { content: '===知识条目===\n标题：星轨杯\n标签：赛事\n正文：星轨杯是社区赛事，奖金池 5 万。' } }],
              usage: { prompt_tokens: 2000, completion_tokens: 120 }
            })
        };
      }
      throw new Error(`不该请求这个地址：${target}`);
    };
    try {
      // 查询词带个本次运行独有的后缀：待办队列有「10 分钟内同一条不重复入队」的去重，
      // 用固定词的话，10 分钟内连跑两次这套测试，第二次会入队失败（假红）。
      const keyword = `星轨杯${Date.now().toString(36)}`;
      const [item] = exported.copilot.queueResearch([{ kind: 'lookup', text: keyword, reason: '观众问' }], []);
      const before = record.sent.length;
      const result = await electron._ipcHandlers.get('research:run')(null, item.id);
      assert(result.ok, `去查失败了：${result.message}`);
      // 主播报过的 bug：草稿写进去了、右下角弹窗能点通过，但面板的「待审草稿」一直空着。
      // 根因是这条链路只在「最高权限自己通过掉」时才广播 knowledge:changed。
      const sentChannels = record.sent.slice(before).map((entry) => entry.channel);
      assert(
        sentChannels.includes('knowledge:changed'),
        `查完必须广播 knowledge:changed（面板靠它刷新待审列表），实际发了：${sentChannels.join('、')}`
      );
      assert(sentChannels.includes('drafts:ready'), `也要发 drafts:ready（右下角弹窗靠它）：${sentChannels.join('、')}`);
      assert(result.searchMode === 'self', `本该走自研搜索，实际是 ${result.searchMode}`);
      assert(result.engineLabel === '自研搜索', `标签不对：${result.engineLabel}`);
      assert(calls.length === 2, `自研搜索应该只发两个请求（搜索 + 整理），实际 ${calls.length}`);
      assert(calls[0].url.includes('/v1/tools/search'), `第一个请求该打搜索接口：${calls[0].url}`);
      assert(calls[0].body.query === keyword, `搜索词不对：${calls[0].body.query}`);
      assert(calls[1].url.includes('/chat/completions'), `第二个请求该打对话接口：${calls[1].url}`);
      assert(calls[1].body.thinking && calls[1].body.thinking.type === 'disabled', '整理这步要关思考模式');
      const listed = await electron._ipcHandlers.get('knowledge:list')();
      assert(listed.pending.length === 1, `应该进 1 条待审，实际 ${listed.pending.length}`);
      assert(listed.pending[0].title.includes('星轨杯'), listed.pending[0].title);
      assert(String(listed.pending[0].engine).includes('自研搜索'), `草稿上要标出走哪条路：${listed.pending[0].engine}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('联网两条路：自研搜索失败会自动退回老办法（别让「去查」整个失效）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fallback-'));
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url) => {
      const target = String(url);
      calls.push(target);
      if (target.includes('/v1/tools/search')) {
        // 402 = 余额不足；真机上也可能 404（账号没开这个接口）/ 断网
        return { ok: false, status: 402, text: async () => '{"error":{"message":"Insufficient Balance"}}' };
      }
      if (target.includes('/anthropic/v1/messages')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: 'text', text: '===知识条目===\n标题：星轨杯\n正文：社区赛事的说明。' }] })
        };
      }
      throw new Error(`不该请求这个地址：${target}`);
    };
    try {
      // 同样带独有后缀，避免 10 分钟内的去重把这次入队吃掉
      const [item] = exported.copilot.queueResearch([{ kind: 'lookup', text: `泥潭杯${Date.now().toString(36)}` }], []);
      const result = await electron._ipcHandlers.get('research:run')(null, item.id);
      assert(result.ok, `退回老办法之后应该还是查成功：${result.message}`);
      assert(result.fellBackFrom === 'self', `没有记下「退回老办法」这件事：${result.fellBackFrom}`);
      assert(calls.length === 2, `应该是「先搜索、失败后退回」，实际 ${calls.length} 个请求`);
      assert(calls[0].includes('/v1/tools/search') && calls[1].includes('/anthropic/v1/messages'), calls.join(' → '));
      const listed = await electron._ipcHandlers.get('knowledge:list')();
      assert(listed.pending.length === 1, `退回后也要产出草稿，实际 ${listed.pending.length}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  // ------------------------------------------------------------ 从文件导入资料（2026-10-19）

  await test('从文件导入：txt 交给模型整理 → 进待审草稿（不直接写库）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-'));
    const tempFile = path.join(os.tmpdir(), `import-${Date.now()}.md`);
    fs.writeFileSync(tempFile, '# 大肥鱼玩偶\n39 元一个，下单送贴纸。\n\n直播间常用梗：吃白饭。', 'utf8');
    const { electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    // 假的选择文件框：直接返回我们准备好的那个 md
    electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [tempFile] });
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : {} });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '===知识条目===\n标题：大肥鱼玩偶的价格\n标签：商品,价格\n正文：39 元一个，下单送贴纸。\n\n' +
                    '===知识条目===\n标题：直播间的梗：吃白饭\n标签：梗\n正文：观众调侃主播白拿工资时用，回一句自嘲就好。'
                }
              }
            ],
            usage: { prompt_tokens: 900, completion_tokens: 120 }
          })
      };
    };
    try {
      const picked = await electron._ipcHandlers.get('knowledge:pickImportFiles')();
      assert(picked.ok && picked.files.length === 1, `选文件失败：${JSON.stringify(picked)}`);
      assert(picked.files[0].name.endsWith('.md'), picked.files[0].name);
      assert(picked.files[0].chars > 10, `字数不对：${picked.files[0].chars}`);

      const result = await electron._ipcHandlers.get('knowledge:importFiles')();
      assert(result.ok, `导入失败：${result.message}`);
      assert(result.count === 2, `应该整理出 2 条，实际 ${result.count}`);
      assert(calls.length === 1, `一个文件一段只该调一次模型，实际 ${calls.length} 次`);
      assert(String(calls[0].body.messages[0].content).includes('只写资料里明确写了的东西'), '系统提示词要求不能编');

      // 关键：进的是「待审草稿」，notes 里一条都不能有（模型产出不能直接写库）
      const listed = await electron._ipcHandlers.get('knowledge:list')();
      assert(listed.pending.length === 2, `待审草稿数不对：${listed.pending.length}`);
      assert(listed.items.length === 0, `没点通过之前不该进知识库：${listed.items.length}`);
      assert(listed.pending.some((draft) => String(draft.title).includes('大肥鱼')), '标题没解析对');

      // 缓存用完要清掉：再点一次「导入」应该明确报错，而不是拿旧文件偷偷再跑一遍
      const again = await electron._ipcHandlers.get('knowledge:importFiles')();
      assert(again.ok === false && /没有选中/.test(again.message), `二次导入应该报错：${JSON.stringify(again)}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempFile, { force: true });
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('从文件导入：二进制文件在选文件那一步就被挡掉（不喂给模型）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-import-bin-'));
    const fakeDocx = path.join(os.tmpdir(), `import-${Date.now()}.docx`);
    // docx 其实是 zip：开头 PK\x03\x04，里面有大量 NUL
    fs.writeFileSync(fakeDocx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0x41, 0x42]));
    const { electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeDocx] });
    const originalFetch = global.fetch;
    let called = 0;
    global.fetch = async () => {
      called += 1;
      throw new Error('不该调用模型');
    };
    try {
      const picked = await electron._ipcHandlers.get('knowledge:pickImportFiles')();
      assert(picked.files.length === 0, '二进制文件不该被当成资料');
      assert(picked.skipped.length === 1 && /不是纯文本/.test(picked.skipped[0]), JSON.stringify(picked.skipped));
      const result = await electron._ipcHandlers.get('knowledge:importFiles')();
      assert(result.ok === false, '没有可用文件时不该跑');
      assert(called === 0, '被挡掉的文件绝不能发去模型');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(fakeDocx, { force: true });
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('整理全库：锁定的条目不进提示词，建议落盘，应用后写库并留备份', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-audit-'));
    const { electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb, reviewLimit: 5 },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const addNote = (payload) => electron._ipcHandlers.get('knowledge:add')(null, payload);
    const notes = electron._ipcHandlers.get('knowledge:list');
    // 两条：一条普通、一条锁成只读
    const plain = await addNote({ title: '茶区划分', content: '中国分四大茶区。', tags: '茶', source: '手动添加' });
    const locked = await addNote({ title: '主播的私货', content: '这段不许模型动。', tags: '', source: '手动添加' });
    await electron._ipcHandlers.get('knowledge:update')(null, locked.entry.id, { locked: true });
    assert((await notes()).stats.locked === 1, '锁定状态要能存下来');

    const originalFetch = global.fetch;
    const bodies = [];
    let sentPrompt = '';
    global.fetch = async (url, init) => {
      bodies.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : {} });
      sentPrompt = String(((bodies[bodies.length - 1].body.messages || [])[1] || {}).content || '');
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [
              {
                message: {
                  content: [
                    '===建议===',
                    '类型：改写',
                    `条目：${plain.entry.id}`,
                    '标题：中国茶区划分',
                    '标签：茶,地理',
                    '正文：中国分四大茶区：江北、江南、西南、华南。',
                    '理由：原文太简略，主播念之前还要自己想'
                  ].join('\n')
                }
              }
            ],
            usage: { prompt_tokens: 900, completion_tokens: 120 }
          })
      };
    };
    try {
      const result = await electron._ipcHandlers.get('knowledge:reviewAudit')();
      assert(result.ok, `整理应该成功：${result.message}`);
      assert(result.found === 1, `应该给出 1 条建议，实际 ${result.found}`);
      // 最高思考档：reasoning_effort 必须是 max
      assert(bodies[0].body.reasoning_effort === 'max', `思考档位要是 max，实际 ${bodies[0].body.reasoning_effort}`);
      // 而且**不许**给 max_tokens 设上限：思考也算这个额度，设了就会出现"思考吃满、正文空"
      //（2026-10-21 真踩过：20 条知识那次设 4000 → 正文空 → 界面报"整理失败"）
      assert(
        bodies[0].body.max_tokens === undefined,
        `整理调用不该带 max_tokens（思考会吃满额度），实际 ${bodies[0].body.max_tokens}`
      );
      // 锁定的条目**不许进提示词**
      assert(sentPrompt.includes('茶区划分'), '普通条目要进提示词');
      assert(!sentPrompt.includes('主播的私货'), `锁定的条目不进提示词：${sentPrompt.slice(0, 120)}`);
      // 建议落盘在知识库根的 .review.json
      const reviewFile = path.join(tempKb, '.review.json');
      assert(fs.existsSync(reviewFile), '建议要落盘（面板关了再开会话也能看到）');
      const saved = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
      assert(saved.items.length === 1, `盘上应该有 1 条建议，实际 ${saved.items.length}`);

      // 应用：真写库 + 备份 + 建议消失
      const applied = await electron._ipcHandlers.get('knowledge:reviewApply')(null, saved.items[0].id);
      assert(applied.ok, `应用应该成功：${applied.message}`);
      const after = await notes();
      const updated = after.items.find((item) => item.id === plain.entry.id);
      assert(updated.content.includes('江北'), `知识库没更新：${updated.content}`);
      assert(updated.tags.includes('地理'), '标签也要跟着建议走');
      const historyDir = path.join(tempKb, '.history', plain.entry.id);
      assert(fs.existsSync(historyDir) && fs.readdirSync(historyDir).length >= 2, '改之前必须备份到 .history');
      const left = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
      assert(left.items.length === 0, '应用过的建议要消失');
      const edits = await electron._ipcHandlers.get('knowledge:edits')();
      const record = edits.edits.find((entry) => entry.noteId === plain.entry.id && entry.source === '整理校对');
      assert(record, `改动记录里要能认出这是整理校对改的：${JSON.stringify(edits.edits.slice(0, 1))}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('整理全库：模型只回了思考、正文是空的 → 报错要能指向"思考吃满额度"', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-empty-'));
    const { electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    await electron._ipcHandlers.get('knowledge:add')(null, { title: '价格表', content: '大肥鱼 39 元。', tags: '', source: '手动添加' });
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: '想了一堆但是没写结论'.repeat(20) }, finish_reason: 'length' }]
        })
    });
    try {
      const result = await electron._ipcHandlers.get('knowledge:reviewAudit')();
      assert(!result.ok, '空正文要当失败');
      assert(/没给正文/.test(result.message), `报错要说清是"没给正文"：${result.message}`);
      assert(/思考/.test(result.message), `要指向思考内容：${result.message}`);
      assert(/finish=length/.test(result.message), `要带上 finish 原因：${result.message}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('整理全库：模型说「没什么要改的」也算一次运行（界面要能显示"上次整理"）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-clean-'));
    const { electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    await electron._ipcHandlers.get('knowledge:add')(null, { title: '价格表', content: '大肥鱼 39 元。', tags: '', source: '手动添加' });
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '库里很干净，没有需要改的。' } }] })
    });
    try {
      const result = await electron._ipcHandlers.get('knowledge:reviewAudit')();
      assert(result.ok, `整理应该成功：${result.message}`);
      assert(result.found === 0, `应该没有建议，实际 ${result.found}`);
      const saved = JSON.parse(fs.readFileSync(path.join(tempKb, '.review.json'), 'utf8'));
      assert(saved.items.length === 0, '没有建议');
      assert(saved.runs.length === 1, `这次运行要记下来（不然界面不知道跑过）：${JSON.stringify(saved.runs)}`);
      assert(saved.runs[0].notes === 1, `runs 里要写看了几条：${JSON.stringify(saved.runs[0])}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('整理校对：建议生成之后条目被改过 / 被锁上，都不许应用（免得盖掉主播的手改）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-guard-'));
    const { electron } = await boot({
      autoShow: true,
      settings: { knowledge: { dir: tempKb }, api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    const addNote = (payload) => electron._ipcHandlers.get('knowledge:add')(null, payload);
    const note = await addNote({ title: '价格表', content: '大肥鱼玩偶 39 元。', tags: '', source: '手动添加' });
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [
            {
              message: {
                content: `===建议===\n类型：改写\n条目：${note.entry.id}\n标题：价格表\n正文：大肥鱼玩偶 39 元，小号的 29 元。\n理由：补上小号价格`
              }
            }
          ]
        })
    });
    try {
      const result = await electron._ipcHandlers.get('knowledge:reviewAudit')();
      assert(result.ok && result.found === 1, `应该有一条建议：${JSON.stringify(result)}`);
      const saved = JSON.parse(fs.readFileSync(path.join(tempKb, '.review.json'), 'utf8'));
      const itemId = saved.items[0].id;

      // ① 主播自己手改了内容 → 这条建议作废
      await electron._ipcHandlers.get('knowledge:update')(null, note.entry.id, { content: '大肥鱼玩偶 45 元（涨价了）。' });
      const refused = await electron._ipcHandlers.get('knowledge:reviewApply')(null, itemId);
      assert(!refused.ok, '条目被改过之后不该应用');
      assert(/改过/.test(refused.message), `要说清为什么：${refused.message}`);

      // ② 主播把它锁成只读 → 也不许应用（哪怕快照对得上）
      const saved2 = JSON.parse(fs.readFileSync(path.join(tempKb, '.review.json'), 'utf8'));
      await electron._ipcHandlers.get('knowledge:update')(null, note.entry.id, { locked: true });
      // 把快照改成"和现在一致"，确保拦下它的是锁、不是快照校验
      saved2.items[0].before = { title: '价格表', content: '大肥鱼玩偶 45 元（涨价了）。', tags: [] };
      fs.writeFileSync(path.join(tempKb, '.review.json'), JSON.stringify(saved2, null, 2), 'utf8');
      const refusedByLock = await electron._ipcHandlers.get('knowledge:reviewApply')(null, itemId);
      assert(!refusedByLock.ok, '锁定的条目不许被模型改');
      assert(/只读/.test(refusedByLock.message), `要说清是锁导致的：${refusedByLock.message}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('联网校对：逐条搜索 + 最高思考档核对，建议带依据；合并会删掉多余条目', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-review-verify-'));
    const { electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb, reviewLimit: 5 },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const addNote = (payload) => electron._ipcHandlers.get('knowledge:add')(null, payload);
    const a = await addNote({ title: '大肥鱼玩偶', content: '39 元。', tags: '', source: '手动添加' });
    const b = await addNote({ title: '大肥鱼玩偶价格', content: '39 元一个。', tags: '', source: '手动添加' });

    const originalFetch = global.fetch;
    const seen = [];
    global.fetch = async (url, init) => {
      const target = String(url);
      const body = init && init.body ? JSON.parse(init.body) : {};
      seen.push({ url: target, body });
      if (target.includes('/v1/tools/search')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              results: [
                { rerank_score: 2.4, title: '官方周边价格', url: 'https://shop.example.com/a', summary: '大肥鱼玩偶 39 元。', site_name: '官方店', date: '2026-10-17T00:00:00+00:00', authority: 4 }
              ]
            })
        };
      }
      if (target.includes('/chat/completions')) {
        // 模型：把两条并成一条
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: [
                      '===建议===',
                      '类型：合并',
                      `条目：${a.entry.id},${b.entry.id}`,
                      '标题：大肥鱼玩偶',
                      '标签：商品',
                      '正文：大肥鱼玩偶 39 元一个（官方店价格）。',
                      '理由：两条说的是同一件事'
                    ].join('\n')
                  }
                }
              ]
            })
        };
      }
      throw new Error(`不该请求这个地址：${target}`);
    };
    try {
      const result = await electron._ipcHandlers.get('knowledge:reviewVerify')(null, { ids: [a.entry.id, b.entry.id] });
      assert(result.ok, `校对应该成功：${result.message}`);
      assert(result.searched === 2, `应该逐条搜了 2 次，实际 ${result.searched}`);
      const chatCalls = seen.filter((call) => call.url.includes('/chat/completions'));
      assert(chatCalls.length === 2, `应该每条约一次模型调用，实际 ${chatCalls.length}`);
      assert(chatCalls[0].body.reasoning_effort === 'max', `校对的思考档位要是 max`);
      assert(result.found === 1, `应该给出 1 条合并建议，实际 ${result.found}`);

      const saved = JSON.parse(fs.readFileSync(path.join(tempKb, '.review.json'), 'utf8'));
      const item = saved.items[0];
      assert(item.kind === 'merge', `建议类型应是 merge：${item.kind}`);
      assert(item.sources.length >= 1 && /example\.com/.test(item.sources[0].url), '建议要带上网依据');

      const applied = await electron._ipcHandlers.get('knowledge:reviewApply')(null, item.id);
      assert(applied.ok, `应用合并应该成功：${applied.message}`);
      const after = await electron._ipcHandlers.get('knowledge:list')();
      assert(after.items.length === 1, `合并之后应该只剩 1 条，实际 ${after.items.length}`);
      assert(after.items[0].content.includes('39 元一个'), `主条目要变成合并后的内容：${after.items[0].content}`);
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('锁成只读之后：她自己改库 / 删库都会被拦下（但仍照常参与检索）', async () => {
    const tempKb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-lock-'));
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        knowledge: { dir: tempKb, selfEdit: 'auto', selfEditPerHour: 10 },
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' }
      }
    });
    const note = await electron._ipcHandlers.get('knowledge:add')(null, {
      title: '终末地',
      content: '终末地是 2025 年公测的。',
      tags: '',
      source: '手动添加'
    });
    await electron._ipcHandlers.get('knowledge:update')(null, note.entry.id, { locked: true });

    const originalFetch = global.fetch;
    let modelCalls = 0;
    global.fetch = async () => {
      modelCalls += 1;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '改写后的正文' } }] }) };
    };
    try {
      // 锁着的条目照样能被检索到（"只读"不是"藏起来"）
      const hits = await electron._ipcHandlers.get('knowledge:search')(null, '终末地');
      assert(hits.hits.length >= 1, '锁定的条目仍然要参与检索');

      // 她要求在回复里「改一下」→ 走到改库流水线 → 被锁拦下
      const [item] = exported.copilot.queueResearch(
        [{ kind: 'edit', text: '终末地', reason: '公测时间写错了' }],
        [{ type: 'danmaku', nickname: '路人', text: '终末地明明是 2026 年公测' }]
      );
      const done = await electron._ipcHandlers.get('research:run')(null, item.id);
      assert(!done.ok, `锁定的条目不该被改：${JSON.stringify(done)}`);
      assert(/只读/.test(done.message), `要说清是被锁住的：${done.message}`);
      assert(modelCalls === 0, '被锁住的条目连模型都不该调（省得白花钱）');
      const listed = await electron._ipcHandlers.get('knowledge:list')();
      const target = listed.items.find((one) => one.id === note.entry.id);
      assert(target.content.includes('2025 年公测'), '内容不许被改');

      // 删也一样
      const [removeItem] = exported.copilot.queueResearch(
        [{ kind: 'remove', text: '终末地', reason: '过时了' }],
        [{ type: 'danmaku', nickname: '路人', text: '这个没用了' }]
      );
      const removed = await electron._ipcHandlers.get('research:run')(null, removeItem.id);
      assert(!removed.ok, '锁定的条目不该被删');
      assert(/只读/.test(removed.message), removed.message);
      assert((await electron._ipcHandlers.get('knowledge:list')()).items.some((one) => one.id === note.entry.id), '条目还在');
    } finally {
      global.fetch = originalFetch;
      fs.rmSync(tempKb, { recursive: true, force: true });
    }
  });

  await test('主动搭话：面板按钮走 IPC，回复标成 proactive；暂停时拒绝并说明原因', async () => {
    const { record, exported, electron } = await boot({
      autoShow: true,
      settings: {
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
        // 打开主动搭话、三种方式只留「问观众」，方便断言
        proactive: { enabled: true, chancePercent: 100, modes: ['ask'], prompt: '问个轻松的小问题' }
      }
    });
    const originalFetch = global.fetch;
    const bodies = [];
    global.fetch = async (url, init) => {
      bodies.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : {} });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            model: 'deepseek-flash',
            choices: [{ index: 0, message: { role: 'assistant', content: '你们今天都在玩什么游戏呀' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 800, completion_tokens: 20, total_tokens: 820 }
          })
      };
    };
    try {
      const warmup = electron._ipcHandlers.get('copilot:warmup');
      assert(warmup, '没有注册 copilot:warmup');
      const result = await warmup();
      assert(result.ok, `手动搭话应该成功：${result.message}`);
      assert(result.reply && result.reply.source === 'proactive', `回复要标成 proactive：${JSON.stringify(result.reply && result.reply.source)}`);
      assert(result.reply.text === '你们今天都在玩什么游戏呀', `回复内容不对：${result.reply.text}`);
      // 提示词要带主播的规矩 + "这次的方式"
      const last = bodies[bodies.length - 1].body;
      const content = JSON.stringify(last.messages);
      assert(/主动开口/.test(content), `搭话提示词没发出去：${content.slice(0, 160)}`);
      assert(/问个轻松的小问题/.test(content), '主播写的规矩要带进提示词');
      assert(/问观众/.test(content), '要说明这次的方式');
      // 回复也要广播到界面（悬浮窗/面板靠这条显示）
      assert(
        record.sent.some((entry) => entry.channel === 'ai:reply' && entry.payload.source === 'proactive'),
        '要送到界面，而且带 proactive 标记'
      );

      // 暂停之后，按钮应该被拒绝，并把原因说清（不是静默无声）
      exported.copilot.pause('测试暂停');
      const refused = await warmup();
      assert(!refused.ok, '暂停时手动搭话应该失败');
      assert(/暂停/.test(refused.message), `要说清是暂停：${refused.message}`);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await test('观众记忆：攒够一批就让模型总结成文档、名册本地记，回复里带摘要（清空上下文也在）', async () => {
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
        danmaku: { minIntervalSec: 0, batchWindowMs: 100 },
        viewerMemory: { enabled: true, rosterEnabled: true, batchSize: 5, intervalSec: 600, maxBatchesPerHour: 10 }
      }
    });
    const originalFetch = global.fetch;
    const requests = [];
    const json = (data) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(data)
    });
    global.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      const text = JSON.stringify(body.messages || []);
      requests.push({ url: String(url), body, text });
      if (text.includes('【新内容】')) {
        // 观众记忆的总结调用：只给要点 patch
        return json({
          choices: [
            {
              message: {
                content:
                  '{"viewers":[{"name":"小明","points":["问过大肥鱼玩偶价格"]}],"anchor":["22:00 抽奖"]}'
              }
            }
          ],
          usage: { prompt_tokens: 300, completion_tokens: 60 }
        });
      }
      return json({ choices: [{ message: { content: '39 元一个' } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    };
    try {
      const stateHandler = () => electron._ipcHandlers.get('memory:state')();
      let state = await stateHandler();
      assert(state.recording === true, `开关开着就该开始记录：${JSON.stringify(state)}`);

      // 攒 5 条（batchSize=5）→ 触发一次总结
      for (let index = 0; index < 5; index += 1) {
        exported.copilot.enqueue({ type: 'danmaku', user: '小明', text: `大肥鱼多少钱（第 ${index} 次问）`, ts: Date.now() });
      }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        state = await stateHandler();
        if (state.sessionPoints > 0) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(state.sessionPoints > 0, `总结没生效：${JSON.stringify(state)}`);

      const files = fs.readdirSync(MEMORY_DIR).filter((name) => name.endsWith('.md') && name !== '老观众.md');
      assert(files.length >= 1, `没写本场文档：${files.join(',')}`);
      const sessionText = fs.readFileSync(path.join(MEMORY_DIR, files[0]), 'utf8');
      assert(sessionText.includes('小明'), sessionText);
      assert(sessionText.includes('问过大肥鱼玩偶价格'), '模型给的要点要写进文档');
      assert(sessionText.includes('22:00 抽奖'), '主播安排要写进文档');
      const rosterText = fs.readFileSync(path.join(MEMORY_DIR, '老观众.md'), 'utf8');
      assert(rosterText.includes('小明'), `名册没记上：${rosterText}`);

      // 再来一条：回复的提示词里要带「观众印象」摘要 + 「老观众」标注
      requests.length = 0;
      exported.copilot.enqueue({ type: 'danmaku', user: '小明', text: '还记得我吗', ts: Date.now() });
      const replyDeadline = Date.now() + 5000;
      while (Date.now() < replyDeadline) {
        if (requests.some((item) => !item.text.includes('【新内容】') && item.text.includes('【观众印象】'))) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const replyRequest = requests.find((item) => item.text.includes('【观众印象】'));
      assert(replyRequest, `回复请求里没有观众印象：${requests.map((item) => item.text.slice(0, 80)).join(' / ')}`);
      assert(replyRequest.text.includes('问过大肥鱼玩偶价格'), '摘要里要带本场要点');
      assert(replyRequest.text.includes('老观众'), '昵称后面要标「老观众」');

      // 清空对话上下文之后，摘要**照样**带（这才是这功能的意义）
      exported.copilot.clearHistory();
      requests.length = 0;
      exported.copilot.enqueue({ type: 'danmaku', user: '小明', text: '我是谁', ts: Date.now() });
      const afterDeadline = Date.now() + 5000;
      while (Date.now() < afterDeadline) {
        if (requests.some((item) => item.text.includes('【观众印象】'))) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(
        requests.some((item) => item.text.includes('【观众印象】')),
        '清空上下文之后摘要必须还在'
      );

      // 关掉本场记录 → 收尾（文件里写「本场结束」）；再打开 → 新的一份
      await electron._ipcHandlers.get('settings:update')(null, { viewerMemory: { enabled: false } });
      state = await stateHandler();
      assert(state.recording === false, '关掉之后不该还在记录');
      const endedText = fs.readFileSync(path.join(MEMORY_DIR, files[0]), 'utf8');
      assert(endedText.includes('本场结束'), endedText);
      await electron._ipcHandlers.get('settings:update')(null, { viewerMemory: { enabled: true } });
      state = await stateHandler();
      const files2 = fs.readdirSync(MEMORY_DIR).filter((name) => name.endsWith('.md') && name !== '老观众.md');
      assert(files2.length >= 2, `再开一次应该是新文件：${files2.join(',')}`);
      assert(state.recording === true, '重新打开要重新开始记');
    } finally {
      global.fetch = originalFetch;
      try {
        exported.copilot.pause('测试收尾');
      } catch (_) {
        /* ignore */
      }
    }
  });

  await test('观众记忆：开着「每次启动自动记录」→ 一启动就自动开一场（不用手点）', async () => {
    const { electron } = await boot({
      settings: {
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
        // 故意只写 autoStart:true + enabled:false（模拟主播上次手动关掉了）：
        // 启动时该替她把本场记录打开
        viewerMemory: { autoStart: true, enabled: false }
      }
    });
    const state = await electron._ipcHandlers.get('memory:state')();
    assert(state.config && state.config.autoStart === true, `状态里要带「每次启动自动记录」：${JSON.stringify(state.config)}`);
    assert(
      state.recording === true,
      `配置里没写 enabled，但默认 autoStart 开着，启动就该开始记：${JSON.stringify(state)}`
    );
    const files = fs.readdirSync(MEMORY_DIR).filter((name) => name.endsWith('.md') && name !== '老观众.md');
    assert(files.length >= 1, `启动后要真的建了本场文件：${files.join(',')}`);
    // 替主播打开的结果要落盘，不然她重启面板看到的是「关着」
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
    assert(
      saved.viewerMemory && saved.viewerMemory.enabled === true,
      `自动打开要写回配置：${JSON.stringify(saved.viewerMemory)}`
    );

    // 直播中手动关掉 → 只结束这一场；autoStart 不能立刻又给打开（那就成了跟主播抢开关）
    await electron._ipcHandlers.get('settings:update')(null, { viewerMemory: { enabled: false } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await electron._ipcHandlers.get('memory:state')();
    assert(after.recording === false, `手动关掉就该停，不能被自动重新打开：${JSON.stringify(after)}`);
  });

  await test('观众记忆：关掉「每次启动自动记录」就是纯手动；运行中打开它会立刻开一场', async () => {
    const { electron } = await boot({
      settings: {
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
        viewerMemory: { enabled: false, autoStart: false }
      }
    });
    let state = await electron._ipcHandlers.get('memory:state')();
    assert(state.config && state.config.autoStart === false, `关掉之后状态要如实：${JSON.stringify(state.config)}`);
    assert(state.recording === false, `关掉自动记录 + 本场没开 → 启动不该记：${JSON.stringify(state)}`);

    // 运行中勾上「每次启动自动记录」→ 这一场现在就开始，不用等下次启动（否则点了像没反应）
    await electron._ipcHandlers.get('settings:update')(null, { viewerMemory: { autoStart: true } });
    state = await electron._ipcHandlers.get('memory:state')();
    assert(state.recording === true, `打开自动记录要立刻开始记：${JSON.stringify(state)}`);
    assert(state.config.enabled === true, '顺手要把「本场记录」打开（界面上两个勾要一致）');
  });

  await test('观众记忆：总结失败要退避，不能立刻重试（回归：以前死循环写满日志 / CPU 打满）', async () => {
    const { exported, electron } = await boot({
      settings: {
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
        danmaku: { minIntervalSec: 0, batchWindowMs: 100 },
        viewerMemory: { enabled: true, rosterEnabled: false, batchSize: 5, intervalSec: 600, maxBatchesPerHour: 0 }
      }
    });
    const originalFetch = global.fetch;
    let flushAttempts = 0;
    /** 只数观众记忆的总结调用（回复调用也走 fetch，不能混在一起数） */
    const isMemoryCall = (init) => {
      try {
        const body = init && init.body ? JSON.parse(init.body) : {};
        return JSON.stringify(body.messages || []).includes('【新内容】');
      } catch (_) {
        return false;
      }
    };
    global.fetch = async (url, init) => {
      if (isMemoryCall(init)) {
        flushAttempts += 1;
        if (flushAttempts > 10) {
          // 真没退避的话这里会被追着打几百次；直接炸出来，免得整个测试跑死
          throw new Error(`总结失败后没有退避：已经被调用 ${flushAttempts} 次`);
        }
      }
      // 模拟坏响应（真实世界：网关返回 HTML / 被代理拦掉 / 直接给个没有 text() 的东西）
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      for (let index = 0; index < 6; index += 1) {
        exported.copilot.enqueue({ type: 'danmaku', user: '小明', text: `第 ${index} 条`, ts: Date.now() });
      }
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert(flushAttempts >= 1, '应该真的试着总结过一批');
      assert(flushAttempts <= 2, `失败后要退避，0.7 秒里只该试 1 次，实际 ${flushAttempts} 次`);
      const bootText = fs.existsSync(path.join(DATA_DIR, 'boot.log'))
        ? fs.readFileSync(path.join(DATA_DIR, 'boot.log'), 'utf8')
        : '';
      assert(bootText.includes('30 秒后再试'), `要让主播知道会退避：${bootText.slice(-300)}`);

      let state = await electron._ipcHandlers.get('memory:state')();
      assert(state.buffered > 0, `失败的那批要留着，不能丢：${JSON.stringify(state.buffered)}`);

      // 手动「现在总结一批」是主播主动要试，不该被退避拦住
      global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: '{"viewers":[{"name":"小明","points":["问过价格"]}],"anchor":[]}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          })
      });
      const manual = await electron._ipcHandlers.get('memory:flush')();
      assert(manual && manual.ok, `手动总结该成功：${JSON.stringify(manual)}`);
      state = await electron._ipcHandlers.get('memory:state')();
      assert(state.buffered === 0, `成功后缓冲要清空：${JSON.stringify(state.buffered)}`);
    } finally {
      global.fetch = originalFetch;
      try {
        exported.copilot.pause('测试收尾');
      } catch (_) {
        /* ignore */
      }
    }
  });

  await test('观众记忆：`[查观众:]` 标记不会露给观众，结果下一轮才带上（不联网）', async () => {
    const { exported, electron } = await boot({
      autoShow: true,
      settings: {
        api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' },
        danmaku: { minIntervalSec: 0, batchWindowMs: 100 },
        viewerMemory: { enabled: true, rosterEnabled: true, batchSize: 60, intervalSec: 1800 }
      }
    });
    const originalFetch = global.fetch;
    const requests = [];
    let markerPending = false;
    global.fetch = async (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : {};
      const text = JSON.stringify(body.messages || []);
      requests.push({ url: String(url), body, text });
      // 只在明确要测「查观众」的那一次回标记，免得被别的调用吃掉
      const content = markerPending ? '哈哈他来啦[查观众:路人甲]' : '嗯嗯';
      markerPending = false;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 80, completion_tokens: 10 } })
      };
    };
    try {
      // 先让「路人甲」发一条弹幕：名册里就有他了（等它那条回复跑完，免得抢走标记）
      exported.copilot.enqueue({ type: 'danmaku', user: '路人甲', text: '我来了', ts: Date.now() });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 500));
      const rosterText = fs.readFileSync(path.join(MEMORY_DIR, '老观众.md'), 'utf8');
      assert(rosterText.includes('路人甲'), `名册里要有这个人：${rosterText}`);

      // 第一句话让模型「查观众」：标记必须从正文里摘掉
      markerPending = true;
      const first = await exported.copilot.talk('这是谁呀');
      assert(first, '第一句要有回复');
      assert(!String(first.text).includes('查观众'), `标记不能露给观众：${first.text}`);
      assert(!String(first.text).includes('[查观众'), first.text);

      // 下一轮：提示词里要带上查到的名册信息
      requests.length = 0;
      await exported.copilot.talk('他常来吗');
      const withLookup = requests.find((item) => item.text.includes('【查到的观众信息】'));
      assert(withLookup, `下一轮没带上查询结果：${requests.map((item) => item.text.slice(0, 80)).join(' / ')}`);
      assert(withLookup.text.includes('路人甲'), withLookup.text.slice(0, 300));
      assert(withLookup.text.includes('累计'), '要带上累计弹幕数');
      assert(!withLookup.text.includes('[查观众'), '协议标记不该出现在提示词里');
    } finally {
      global.fetch = originalFetch;
      try {
        exported.copilot.pause('测试收尾');
      } catch (_) {
        /* ignore */
      }
    }
  });

  await test('待审草稿：一次清空只删草稿，知识库一条不动', async () => {
    const { electron } = await boot({
      settings: { api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } }
    });
    const listHandler = electron._ipcHandlers.get('knowledge:list');
    const before = await listHandler();
    const pendingDir = before.stats.pendingDir;
    // pending/ 是 DSH 和我们自己都往里写草稿的地方，直接放两条进去最省事
    fs.mkdirSync(pendingDir, { recursive: true });
    for (const id of ['p-test-a', 'p-test-b']) {
      fs.writeFileSync(
        path.join(pendingDir, `${id}.json`),
        JSON.stringify({ id, title: `草稿 ${id}`, content: `内容 ${id}`, tags: [], engine: 'dsh', createdAt: new Date().toISOString() }),
        'utf8'
      );
    }
    const mid = await listHandler();
    assert(mid.pending.length >= 2, `准备的两条草稿要能读到：${mid.pending.length}`);
    const countBefore = mid.stats.count;
    assert(countBefore > 0, '这个用例需要库里本来就有知识（否则"没动"没法验）');

    const clear = electron._ipcHandlers.get('knowledge:clearPending');
    assert(clear, '没有注册 knowledge:clearPending');
    const result = await clear();
    assert(result && result.ok, `清空要成功：${JSON.stringify(result)}`);
    assert(result.removed >= 2, `至少删掉两条：${result.removed}`);
    assert(Array.isArray(result.pending) && result.pending.length === 0, '清完待审要空');
    assert(result.stats.count === countBefore, `知识库条目数不能变：${result.stats.count} vs ${countBefore}`);
    assert(
      fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length === 0,
      '草稿文件要真的从磁盘上删掉'
    );
  });

  await test('日志上限：启动前留一份超大的 boot.log，启动后立刻轮转（防刷屏把磁盘写满）', async () => {
    const bootFile = path.join(DATA_DIR, 'boot.log');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.rmSync(`${bootFile}.1`, { force: true });
    // 6MB 的「旧日志」：模拟以前异常刷屏写大的那种文件（真实事故是一分钟 298MB）
    fs.writeFileSync(bootFile, `${'x'.repeat(1023)}\n`.repeat(6000), 'utf8');
    const big = fs.statSync(bootFile).size;
    assert(big > 5 * 1024 * 1024, `准备的文件要超过 5MB：${big}`);

    await boot({ settings: { api: { apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com' } } });

    assert(fs.existsSync(`${bootFile}.1`), '旧内容要轮转到 boot.log.1（不然和没加一样）');
    const now = fs.statSync(bootFile).size;
    assert(now < 5 * 1024 * 1024, `新版 boot.log 要变小：${now}`);
    assert(now > 0, '轮转之后新日志还得继续写');
    assert(fs.statSync(`${bootFile}.1`).size >= big, '.1 里是轮转前那份大文件');
    assert(!fs.existsSync(`${bootFile}.2`), '只留一份旧的（日志不是账本）');
  });

  await test('打包版路径：程序根目录决定 data / 知识库 放哪（exe 旁边，不落进 resources/app）', async () => {
    // 打包后 exe 所在目录才是根目录。这里用 DSH_APP_ROOT 模拟（真打包的冒烟由 build-release.js 验）：
    // 一旦有人把 appRoot() 改回 __dirname 拼法，配置就会跑进 resources/app，这条会红。
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'packed-root-'));
    const backup = process.env.DSH_APP_ROOT;
    process.env.DSH_APP_ROOT = tempRoot;
    let exported = null;
    try {
      const booted = await boot();
      exported = booted.exported;
      const info = await booted.electron._ipcHandlers.get('app:info')();
      const norm = (value) => path.resolve(String(value)).toLowerCase();
      assert(norm(info.settingsFile).startsWith(norm(tempRoot)), `配置要落在程序根目录下：${info.settingsFile}`);
      assert(norm(info.logFile).startsWith(norm(tempRoot)), `日志要落在程序根目录下：${info.logFile}`);
      assert(
        norm(info.dataFolder) === norm(path.join(tempRoot, 'data')),
        `data 目录应该是 <根>/data：${info.dataFolder}`
      );
      assert(fs.existsSync(path.join(tempRoot, 'data')), 'data 目录要真的建好');
      assert(fs.existsSync(path.join(tempRoot, '知识库')), '知识库要建在程序根目录下（不是 resources/app）');
      assert(!fs.existsSync(path.join(tempRoot, 'resources')), '不该在根目录里造出 resources');
    } finally {
      try {
        if (exported) exported.copilot.pause('测试收尾');
      } catch (_) {
        /* ignore */
      }
      if (backup === undefined) delete process.env.DSH_APP_ROOT;
      else process.env.DSH_APP_ROOT = backup;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await test('内置吉祥物：第一次启动自动导入 默认素材图片，并按文件名配好表情', async () => {
    // 「默认素材图片放在发布包里，并且设为默认吉祥物」——用 DSH_APP_ROOT 模拟发布包结构
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-root-'));
    const backup = process.env.DSH_APP_ROOT;
    process.env.DSH_APP_ROOT = tempRoot;
    let exported = null;
    try {
      const sub = path.join(tempRoot, '默认素材图片', '吉祥物大肥鱼');
      fs.mkdirSync(sub, { recursive: true });
      // 1x1 透明 PNG：程序只读字节转 base64，不解析图像
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
        'base64'
      );
      fs.writeFileSync(path.join(sub, '平常.png'), png);
      fs.writeFileSync(path.join(sub, '打招呼.png'), png);

      const booted = await boot();
      exported = booted.exported;
      const settings = await booted.electron._ipcHandlers.get('settings:get')();
      assert(settings.mascot.bundledSeeded === true, '要记下「内置素材种过了」');
      const names = Object.keys(settings.mascot.images);
      assert(names.length === 2, `应该导入两张图：${names.join(',')}`);
      assert(
        String(settings.mascot.images['平常.png']).startsWith('data:image/png;base64,'),
        `要存成 dataURL：${String(settings.mascot.images['平常.png']).slice(0, 40)}`
      );
      // 真正当默认吉祥物用：不写 expressions，靠文件名也能配上
      const shared = require(path.join(root, 'src', 'shared', 'emotions.js'));
      assert(
        shared.pickMascotImage(settings.mascot, 'idle') === settings.mascot.images['平常.png'],
        'idle（平常）要配上「平常.png」'
      );
      assert(
        shared.pickMascotImage(settings.mascot, 'greet') === settings.mascot.images['打招呼.png'],
        'greet（打招呼）要配上「打招呼.png」'
      );
      // 要落盘：重启之后还是这套图
      const saved = JSON.parse(fs.readFileSync(path.join(tempRoot, 'data', 'settings.json'), 'utf8'));
      assert(
        saved.mascot.bundledSeeded === true && Object.keys(saved.mascot.images).length === 2,
        `要写回配置：${JSON.stringify(saved.mascot.bundledSeeded)}`
      );
    } finally {
      try {
        if (exported) exported.copilot.pause('测试收尾');
      } catch (_) {
        /* ignore */
      }
      if (backup === undefined) delete process.env.DSH_APP_ROOT;
      else process.env.DSH_APP_ROOT = backup;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  await test('内置吉祥物：种过之后把图删光，下次启动不会又长回来', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mascot-root-'));
    const backup = process.env.DSH_APP_ROOT;
    process.env.DSH_APP_ROOT = tempRoot;
    let exported = null;
    try {
      const sub = path.join(tempRoot, '默认素材图片', '吉祥物大肥鱼');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, '平常.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      // 模拟主播已经在界面上把图全删了（bundledSeeded 仍是 true）
      fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(tempRoot, 'data', 'settings.json'),
        JSON.stringify({ mascot: { bundledSeeded: true, images: {} } }),
        'utf8'
      );

      const booted = await boot();
      exported = booted.exported;
      const settings = await booted.electron._ipcHandlers.get('settings:get')();
      assert(settings.mascot.bundledSeeded === true, '种过了的标记要保留');
      assert(
        Object.keys(settings.mascot.images).length === 0,
        `删掉的图不能被自动加回来：${Object.keys(settings.mascot.images).join(',')}`
      );
    } finally {
      try {
        if (exported) exported.copilot.pause('测试收尾');
      } catch (_) {
        /* ignore */
      }
      if (backup === undefined) delete process.env.DSH_APP_ROOT;
      else process.env.DSH_APP_ROOT = backup;
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  cleanup();
  restoreRealData();
  process.exit(failed ? 1 : 0);
})();

/** 测试会往 程序目录/data 里写日志和 crash.log，跑完清掉，别污染真实使用环境 */
function cleanup() {
  const targets = [
    path.join(root, 'data', 'crash.log'),
    path.join(root, 'data', 'copilot.log'),
    path.join(root, 'data', 'copilot.log.1'),
    path.join(root, 'data', 'boot.log'),
    path.join(root, 'data', 'boot.log.1'),
    path.join(root, 'data', 'smoke-test.log'),
    // 极端情况下（app.getPath 不可用）会落到程序目录
    path.join(root, 'crash.log')
  ];
  for (const target of targets) {
    try {
      fs.rmSync(target, { force: true });
    } catch (_) {
      /* ignore */
    }
  }
}
