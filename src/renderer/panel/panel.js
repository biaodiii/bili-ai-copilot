'use strict';

/**
 * 控制面板渲染层
 */

// 表情清单和自动匹配逻辑来自 shared/emotions.js（与悬浮窗共用）
const shared = window.SharedLogic;
// 注意：**这里故意没有 `EMOTIONS` 这种常量**。2026-10-19 加了自定义表情之后，
// 界面要用的表是「内置 + 用户自定义」，一律走下面的 `currentEmotions()`。
// 谁图省事又拿 `shared.EMOTION_LIST` 直接遍历，用户新加的表情就不会出现在面板上
// （`audit.js` 会盯着 `currentEmotions()` 这张表在不在）。

/** 内置 12 个 + 用户自定义的表（顺序：内置在前，优先级也是它先） */
function currentEmotions() {
  const custom = (state.settings && state.settings.mascot && state.settings.mascot.customEmotions) || [];
  return shared.emotionList(custom);
}

const state = {
  settings: null,
  feedOnlyReply: false,
  feed: [],
  logFilter: 'all',
  logs: [],
  ttsModels: [] // 可选的语音模型清单（每个模型自带它的音色清单）
};

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ 小工具

/**
 * 右下角飘一条提示。
 *
 * 第 4 个参数 `actions` 让它变成**能点的提示**（直播中少一次「点进知识库页再找那条」）：
 *   toast('查完了：3 条进了待审', 'ok', 0, [
 *     { label: '全部通过', primary: true, onClick: async () => {...} },
 *     { label: '先放着', onClick: async () => {} }
 *   ]);
 * 约定：
 *   · **带按钮的提示不自动消失**（`ms` 传 0）——主播可能正看着游戏，4 秒就没了等于没提示；
 *   · 点任意按钮都会把这条收掉（`keepOpen: true` 可保留），按钮在请求期间自动禁用防连点；
 *   · 最多同时留 3 条，多了先挤掉最早的那条，免得右下角堆成一堵墙。
 */
const MAX_ACTION_TOASTS = 3;

function toast(message, kind = '', ms = 4200, actions = null) {
  const wrap = $('toastWrap');
  const node = document.createElement('div');
  const hasActions = Array.isArray(actions) && actions.length > 0;
  node.className = `toast ${kind}${hasActions ? ' toast-action' : ''}`;

  const text = document.createElement('div');
  text.className = 'toast-text';
  text.textContent = message;
  node.appendChild(text);

  const close = () => {
    if (!node.parentNode) return;
    node.style.opacity = '0';
    node.style.transition = 'opacity .3s ease';
    setTimeout(() => node.remove(), 320);
  };

  if (hasActions) {
    const row = document.createElement('div');
    row.className = 'toast-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.className = `btn tiny${action.primary ? ' primary' : ''}`;
      button.textContent = action.label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await action.onClick();
        } catch (error) {
          toast(`操作失败：${error && error.message ? error.message : error}`, 'err', 8000);
        }
        if (!action.keepOpen) close();
        else button.disabled = false;
      });
      row.appendChild(button);
    }
    node.appendChild(row);
    // 带按钮的先挤掉最早的那条
    const existing = [...wrap.querySelectorAll('.toast-action')];
    while (existing.length >= MAX_ACTION_TOASTS) {
      const oldest = existing.shift();
      oldest.remove();
    }
  }

  wrap.appendChild(node);
  const life = Number(ms);
  if (life > 0) {
    setTimeout(close, life);
  }
  // 让调用方能手动收掉这条（**常驻提示必须收**：`ms=0` 的"正在整理…"跑完还挂着，
  // 右下角就永远停在那句话上——主播报过这个）。见下面的 dismissToast。
  node._closeToast = close;
  return node;
}

/**
 * 手动收掉一条提示。
 * 场景：长任务开始时飘一条「正在整理…」（`ms=0` 不自动消失），
 * 任务结束（成功 / 失败 / 取消）必须把它收掉，只留下结果那一条。
 */
function dismissToast(node) {
  if (node && typeof node._closeToast === 'function') node._closeToast();
}

// ------------------------------------------------------------ 应用内确认框
//
// ⚠️ **不要用系统原生的 confirm() / prompt()**。
// 主播报过一个 bug：在知识库删掉一条之后，**整个页面的输入框都不能选、不能打字**，
// 要重启软件才好。那条路径上唯一和别处不同的东西就是原生 `confirm()`——
// 原生弹窗在 Electron/Windows 上关掉之后，渲染层有可能卡在「模态还在」的状态里，
// 于是所有鼠标/键盘事件都被吞掉（界面还照常显示，所以看着像"卡住"）。
//
// 这个自绘弹窗：纯 DOM、能 await、**无论走哪条路都会收掉遮罩**（不会留一层挡着界面），
// 也能被测试直接点按钮验证。

/** 当前打开着的弹窗的收尾函数（同时只允许一个） */
let closeModal = null;

/**
 * 打开一个弹窗。
 * @param {{message:string, defaultValue?:string|null, okText?:string, cancelText?:string}} options
 *   `defaultValue` 不是 null 时是「输入框」模式（相当于原来的 prompt）
 * @returns {Promise<boolean|string|null>} 确认=true/输入值，取消=false/null
 */
function openModal({ message, defaultValue = null, okText = '确定', cancelText = '取消' } = {}) {
  const isPrompt = defaultValue !== null;
  const cancelled = isPrompt ? null : false;
  const mask = $('modalMask');
  const text = $('modalText');
  const input = $('modalInput');
  const ok = $('modalOk');
  const cancel = $('modalCancel');
  // 界面里没有弹窗元素（老界面/极端情况）→ 当成「取消」，
  // 绝不因为找不到弹窗就默认执行危险操作
  if (!mask || !text || !input || !ok || !cancel) return Promise.resolve(cancelled);

  // 已经有一个开着就先把它当取消收掉，避免两个弹窗叠着谁也关不掉
  if (typeof closeModal === 'function') closeModal(cancelled);

  text.textContent = message;
  ok.textContent = okText;
  cancel.textContent = cancelText;
  input.hidden = !isPrompt;
  input.value = isPrompt ? String(defaultValue) : '';
  mask.hidden = false;

  const doc = typeof document.addEventListener === 'function' ? document : null;
  return new Promise((resolve) => {
    const finish = (value) => {
      // ⚠️ 无论从哪条路结束，都必须把遮罩收掉并摘掉监听：
      // 忘了收 → 整个界面被一层看不见的东西挡住（这正是我们要修的那类 bug）
      mask.hidden = true;
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      if (doc) doc.removeEventListener('keydown', onKey);
      closeModal = null;
      resolve(value);
    };
    const onOk = () => finish(isPrompt ? input.value : true);
    const onCancel = () => finish(cancelled);
    const onMask = (event) => {
      if (event.target === mask) onCancel();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel();
      else if (event.key === 'Enter') onOk();
    };
    closeModal = (value) => finish(value === undefined ? cancelled : value);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    if (doc) doc.addEventListener('keydown', onKey);
    const focusTarget = isPrompt ? input : ok;
    if (typeof focusTarget.focus === 'function') focusTarget.focus();
  });
}

/** 确认框（替代原生 confirm） */
function confirmDialog(message, options = {}) {
  return openModal({ message, ...options }).then((value) => value === true);
}

/** 输入框弹窗（替代原生 prompt）；取消时返回 null */
function promptDialog(message, defaultValue = '', options = {}) {
  return openModal({ message, defaultValue, ...options });
}

function shortName(name) {
  return shared.shortName(name);
}

function timeText(ts) {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ------------------------------------------------------------ 设置绑定

function getPath(object, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (typeof cursor[keys[i]] !== 'object' || cursor[keys[i]] === null) cursor[keys[i]] = {};
    cursor = cursor[keys[i]];
  }
  cursor[keys[keys.length - 1]] = value;
}

let saveTimer = null;
const pendingPatch = {};

function queueSave(path, value) {
  setPath(pendingPatch, path, value);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 250);
}

async function flushSave() {
  const patch = JSON.parse(JSON.stringify(pendingPatch));
  for (const key of Object.keys(pendingPatch)) delete pendingPatch[key];
  if (!Object.keys(patch).length) return;
  const settings = await window.api.settings.update(patch);
  state.settings = settings;
}

/** 把界面上所有控件绑定到 settings 的某个路径 */
function bindAll() {
  const map = {
    apiKey: { path: 'api.apiKey', type: 'text' },
    baseUrl: { path: 'api.baseUrl', type: 'text' },
    model: { path: 'api.model', type: 'select' },
    thinking: { path: 'api.thinking', type: 'select' },
    timeoutSec: { path: 'api.timeoutSec', type: 'number' },
    temperature: { path: 'api.temperature', type: 'range', out: 'temperatureOut', fmt: (v) => Number(v).toFixed(2) },
    maxTokens: { path: 'api.maxTokens', type: 'number' },
    botName: { path: 'persona.botName', type: 'text' },
    styleNotes: { path: 'persona.styleNotes', type: 'text' },
    contextRounds: { path: 'persona.contextRounds', type: 'number' },
    memoryMinutes: { path: 'persona.memoryMinutes', type: 'number' },
    systemPrompt: { path: 'persona.systemPrompt', type: 'text' },
    // 说明：原「强制 JSON 输出模式」开关已停用——实测它会让 DeepSeek 返回纯空格
    // （8 次里空 7~8 次），情绪改用句末 [情绪:xxx] 标记表达。配置项保留仅供兼容。
    anchorName: { path: 'persona.anchorName', type: 'text' },
    sendStreamTitle: { path: 'persona.sendStreamTitle', type: 'check' },
    selfTuning: { path: 'persona.selfTuning', type: 'check' },

    autoPauseOnError: { path: 'safety.autoPauseOnError', type: 'check' },
    maxConsecutiveFailures: { path: 'safety.maxConsecutiveFailures', type: 'number' },
    // 主动搭话（2026-10-21 替换原来的冷场暖场）。「允许的方式」是数组，单独在
    // renderProactiveModes / wireProactiveModes 里处理，不走这张表。
    proactiveEnabled: { path: 'proactive.enabled', type: 'check' },
    proactiveIdleSeconds: { path: 'proactive.idleSeconds', type: 'number' },
    proactiveMaxPerHour: { path: 'proactive.maxPerHour', type: 'number' },
    proactiveMaxChars: { path: 'proactive.maxChars', type: 'number' },
    proactiveChance: {
      path: 'proactive.chancePercent',
      type: 'range',
      out: 'proactiveChanceOut',
      fmt: (value) => `${Math.round(Number(value) || 0)}%`
    },
    proactiveUseKnowledge: { path: 'proactive.useKnowledge', type: 'check' },
    proactivePrompt: { path: 'proactive.prompt', type: 'text' },

    speechEnabled: { path: 'speech.enabled', type: 'check' },
    speechReadViewer: { path: 'speech.readViewer', type: 'check' },
    // 云音色（存起来下次打开还在；模型/音色两个下拉是动态选项、引擎单选框和试听按钮
    // 都在 bindSpeechEngine 里单独接线）
    ttsApiKey: { path: 'speech.cloud.apiKey', type: 'text' },
    ttsBaseUrl: { path: 'speech.cloud.baseUrl', type: 'text' },
    speechRate: { path: 'speech.rate', type: 'range', out: 'speechRateOut', fmt: (v) => `${Number(v).toFixed(2)}×` },
    speechPitch: { path: 'speech.pitch', type: 'range', out: 'speechPitchOut', fmt: (v) => Number(v).toFixed(2) },
    speechVolume: {
      path: 'speech.volume',
      type: 'range',
      out: 'speechVolumeOut',
      fmt: (v) => `${Math.round(Number(v) * 100)}%`
    },

    roomId: { path: 'danmaku.roomId', type: 'text' },
    sessdata: { path: 'danmaku.sessdata', type: 'text' },
    autoStart: { path: 'danmaku.autoStart', type: 'check' },
    triggerMode: { path: 'danmaku.triggerMode', type: 'select' },
    minIntervalSec: { path: 'danmaku.minIntervalSec', type: 'number' },
    batchWindowMs: { path: 'danmaku.batchWindowMs', type: 'number' },
    maxBatch: { path: 'danmaku.maxBatch', type: 'number' },
    maxLength: { path: 'danmaku.maxLength', type: 'number' },
    ignoreKeywords: { path: 'danmaku.ignoreKeywords', type: 'text' },
    blockedUsers: { path: 'danmaku.blockedUsers', type: 'text' },
    danmakuLogEnabled: { path: 'danmakuLog.enabled', type: 'check' },
    danmakuLogMaxFileMB: { path: 'danmakuLog.maxFileMB', type: 'number' },
    danmakuLogKeepFiles: { path: 'danmakuLog.keepFiles', type: 'number' },

    // 观众记忆（2026-10-21）：三个开关 + 四个参数；状态行/按钮在 wireMemory 里单独接
    memoryAutoStart: { path: 'viewerMemory.autoStart', type: 'check' },
    memoryEnabled: { path: 'viewerMemory.enabled', type: 'check' },
    memoryRosterEnabled: { path: 'viewerMemory.rosterEnabled', type: 'check' },
    memoryBatchSize: { path: 'viewerMemory.batchSize', type: 'number' },
    memoryIntervalSec: { path: 'viewerMemory.intervalSec', type: 'number' },
    memoryMaxBatches: { path: 'viewerMemory.maxBatchesPerHour', type: 'number' },
    memoryInjectChars: { path: 'viewerMemory.injectChars', type: 'number' },
    memoryRosterMax: { path: 'viewerMemory.rosterMax', type: 'number' },

    // 知识库的三个开关走绑定表；条目本身是动态列表，由 renderKnowledge 自己画
    knowledgeEnabled: { path: 'knowledge.enabled', type: 'check' },
    // 整理/校对：一次联网校对跑几条（1~20，主进程按 1~20 收敛）
    reviewLimit: { path: 'knowledge.reviewLimit', type: 'number' },
    knowledgeInjectCount: { path: 'knowledge.injectCount', type: 'number' },
    knowledgeInjectChars: { path: 'knowledge.injectChars', type: 'number' },
    // DSH 的两个路径 + 跑法 + 会话名（留空 = 自动探测）
    dshNode: { path: 'knowledge.dshNode', type: 'text' },
    dshCommand: { path: 'knowledge.dshCommand', type: 'text' },
    dshSessionName: { path: 'knowledge.dshSessionName', type: 'text' },
    // 会话模式用哪个模型（软件会在会话上直接指定；留空 = 用 DSH 自己的默认）
    dshModel: { path: 'knowledge.dshModel', type: 'text' },
    dshTimeoutSec: { path: 'knowledge.dshTimeoutSec', type: 'number' },
    // 最高权限（P7）：她自己查 / 自己入库 / 自己调软件功能 / 自己删条目
    maxPermissions: { path: 'agent.maxPermissions', type: 'check' },
    maxSearchPerHour: { path: 'agent.searchPerHour', type: 'number' },
    maxToolsPerHour: { path: 'agent.toolsPerHour', type: 'number' },
    // 「她自己动库」的权限（P6）：改错 / 扩写 / 记新的，她是直接动手还是先问一句
    selfEdit: { path: 'knowledge.selfEdit', type: 'select' },
    selfEditPerHour: { path: 'knowledge.selfEditPerHour', type: 'number' },

    posX: { path: 'overlay.posXRatio', type: 'range', out: 'posXOut', fmt: (v) => `${Math.round(v * 100)}%`, scale: 100 },
    posY: { path: 'overlay.posYRatio', type: 'range', out: 'posYOut', fmt: (v) => `${Math.round(v * 100)}%`, scale: 100 },
    width: { path: 'overlay.width', type: 'range', out: 'widthOut', fmt: (v) => `${v}px` },
    mascotWidth: { path: 'overlay.mascotWidth', type: 'range', out: 'mascotWidthOut', fmt: (v) => `${v}px` },
    fontScale: { path: 'overlay.fontScale', type: 'range', out: 'fontScaleOut', fmt: (v) => `${Number(v).toFixed(2)}×` },
    opacity: { path: 'overlay.opacity', type: 'range', out: 'opacityOut', fmt: (v) => `${Math.round(v * 100)}%` },
    replySeconds: { path: 'overlay.replySeconds', type: 'range', out: 'replySecondsOut', fmt: (v) => `${v}s` },
    alwaysOnTop: { path: 'overlay.alwaysOnTop', type: 'check' },
    // 锁定窗口位置（2026-10-19 加的）：和悬浮窗顶栏那个 🔒 按钮是**同一个配置**
    locked: { path: 'overlay.locked', type: 'check' },
    showViewerMessage: { path: 'overlay.showViewerMessage', type: 'check' },
    // 回复气泡不自动消失（2026-10-19 加的）：和悬浮窗快捷设置里那个勾选框是**同一个配置**
    replyPersist: { path: 'overlay.replyPersist', type: 'check' },
    hideInScreenshot: { path: 'overlay.hideInScreenshot', type: 'check' },
    overlayAutoShow: { path: 'overlay.autoShow', type: 'check' },
    overlayAutoOpenDrawer: { path: 'overlay.autoOpenDrawer', type: 'check' },
    chatEnabled: { path: 'overlay.chatEnabled', type: 'check' },
    chatShowDanmaku: { path: 'overlay.chatShowDanmaku', type: 'check' },
    chatShowIds: { path: 'overlay.chatShowIds', type: 'check' },
    chatHeight: { path: 'overlay.chatHeight', type: 'number' },

    fallbackEmoji: { path: 'mascot.fallbackEmoji', type: 'text' },
    animation: { path: 'mascot.animation', type: 'check' }
  };
  state.bindingMap = map;

  for (const [id, config] of Object.entries(map)) {
    const node = $(id);
    if (!node) continue;
    const eventName = config.type === 'range' || config.type === 'check' || config.type === 'select' ? 'change' : 'input';
    node.addEventListener(eventName, () => {
      const value = readControl(node, config);
      queueSave(config.path, value);
      // 「对话区高度」只在跟随内容模式下说了算：固定高度模式下窗口高度是主播拖出来的、
      // 对话区吃剩余空间，光改这个数字在悬浮窗里不会有任何反应。
      // 动了它就等于「我想自己定对话区高度」→ 顺便切回跟随内容（和悬浮窗 ⚙ 里动滑杆同一个效果）。
      if (id === 'chatHeight' && (getPath(state.settings || {}, 'overlay.heightMode') || 'content') === 'fixed') {
        queueSave('overlay.heightMode', 'content');
      }
      updateOutputs();
    });
    if (config.type === 'range') {
      node.addEventListener('input', updateOutputs);
    }
  }
}

function readControl(node, config) {
  if (config.type === 'check') return node.checked;
  if (config.type === 'range') return config.scale ? Number(node.value) / config.scale : Number(node.value);
  if (config.type === 'number') {
    const raw = Number(node.value);
    if (config.percent) return Math.min(1, Math.max(0, raw / 100));
    return config.scale ? raw / config.scale : raw;
  }
  return node.value;
}

function writeControls() {
  const settings = state.settings;
  // 模型下拉里只有官方那两个名字。用中转站的人填的是自己的模型名，
  // 直接赋值会给 select 一个不存在的值 → 界面上显示成空白，看起来像"配置丢了"。
  // 所以遇到列表里没有的值，临时补一个选项把它显示出来（不写回配置，只为了看得见）。
  ensureSelectOption('model', settings.api && settings.api.model);
  for (const [id, config] of Object.entries(state.bindingMap || {})) {
    const node = $(id);
    if (!node) continue;
    const value = getPath(settings, config.path);
    if (config.type === 'check') node.checked = Boolean(value);
    else if (config.percent) node.value = String(Math.round((Number(value) || 0) * 1000) / 10);
    else if (config.scale) node.value = String(Number(value ?? 0) * config.scale);
    else node.value = value === undefined || value === null ? '' : String(value);
  }
  // 模型和音色是动态列表（选项来自主进程），不走绑定表，这里单独回填
  fillModelOptions();
  fillVoiceOptions();
  // 角色表也是动态的（用户自己建），同样单独回填
  fillRoleOptions();
  // 语音引擎的单选、系统语音的音色下拉：都是「读配置之前画过一次」的，必须再同步一遍
  renderSpeechEngine();
  syncSpeechVoiceSelect();
  // DSH 的跑法单选、会话名小字同理
  renderDshRunMode();
  renderDshSessionHint();
  renderMaxPermHint();
  // 「联网怎么查」的单选也是读配置前画过一次的，这里再同步
  renderSearchMode();
  // 主动搭话的方式勾选框（数组）和标题旁摘要同理
  renderProactive();
  // 观众记忆的状态行（开关/上限可能刚被改过，重读一次主进程的真实状态）
  void refreshMemory();
  updateOutputs();
}

/**
 * 给下拉框补一个「列表里没有、但配置里正在用」的选项。
 * 场景：模型下拉只列了官方两个模型名，用中转站的人填的是自己的名字，
 * 不补的话 select.value 赋一个不存在的值 → 界面显示空白，看着像设置丢了。
 */
function ensureSelectOption(selectId, value) {
  const select = $(selectId);
  const text = value === undefined || value === null ? '' : String(value);
  if (!select || !text) return;
  const exists = Array.from(select.children).some((option) => option.value === text);
  if (exists) return;
  const option = document.createElement('option');
  option.value = text;
  option.textContent = `${text}（当前配置）`;
  select.appendChild(option);
}

/**
 * 当前选中的语音模型（认识就返回清单里那一条，不认识返回 null）
 */
function currentTtsModel() {
  const cloud = ((state.settings || {}).speech || {}).cloud || {};
  const id = cloud.model || '';
  return (state.ttsModels || []).find((item) => item.id === id) || null;
}

/**
 * 重画「模型」下拉。
 * 数据来源是主进程 status().models（唯一真相），界面只负责展示。
 */
function fillModelOptions() {
  const select = $('ttsModel');
  if (!select) return;
  const models = state.ttsModels || [];
  const cloud = ((state.settings || {}).speech || {}).cloud || {};
  const current = cloud.model || '';
  const known = models.some((item) => item.id === current);

  select.innerHTML = '';
  for (const item of models) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.label}`;
    select.appendChild(option);
  }
  if (current && !known) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = `${current}（不在列表里）`;
    select.appendChild(option);
  }
  if (!models.length && !current) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '（模型列表没读到）';
    select.appendChild(option);
  }
  select.value = current;

  const hint = $('ttsModelHint');
  if (hint) {
    const item = models.find((entry) => entry.id === current);
    if (item) hint.textContent = `${item.price}｜${item.note}`;
    else if (current) hint.textContent = `「${current}」不在可选模型里，可能要手动确认它是否还存在`;
    else hint.textContent = '换模型会自动把音色换成那个模型认的（音色不能跨模型混用）。';
  }
}

/**
 * 重画「音色」下拉。
 * ⚠️ 音色是**跟着模型走**的：每个模型只认自己那份清单，混用服务端会回
 * `Invalid voice specified`。所以这里只画当前模型的音色。
 * 数据来源是主进程 status().models（唯一真相）。
 */
function fillVoiceOptions() {
  const select = $('ttsVoice');
  if (!select) return;
  const model = currentTtsModel();
  const voices = (model && model.voices) || [];
  const cloud = ((state.settings || {}).speech || {}).cloud || {};
  const current = cloud.voice || '';
  const known = voices.some((item) => item.voice === current);

  select.innerHTML = '';
  for (const item of voices) {
    const option = document.createElement('option');
    option.value = item.voice;
    // 下拉收起后长文案会被截断，所以这里只放「ID · 中文名」，特点写到下面那行小字里
    option.textContent = `${item.voice} · ${item.name}`;
    select.appendChild(option);
  }
  if (current && !known) {
    const option = document.createElement('option');
    option.value = current;
    option.textContent = `${current}（自定义音色）`;
    select.appendChild(option);
  }
  if (current) select.value = current;
  // 自定义 ID 输入框只在「当前用的不是内置音色」时才有内容
  const custom = $('ttsVoiceCustom');
  if (custom) custom.value = known ? '' : current;

  const desc = $('ttsVoiceDesc');
  if (desc) {
    const item = voices.find((entry) => entry.voice === current);
    if (item) desc.textContent = `当前：${item.voice} · ${item.name} —— ${item.desc}`;
    else if (current) desc.textContent = `当前：自定义音色 ID「${current}」（不在内置清单里，确认它对这个模型有效）`;
    else desc.textContent = '还没选音色';
  }
}

function updateOutputs() {
  for (const [id, config] of Object.entries(state.bindingMap || {})) {
    if (!config.out) continue;
    const node = $(id);
    const out = $(config.out);
    if (!node || !out) continue;
    const raw = Number(node.value);
    const value = config.scale ? raw / config.scale : raw;
    out.textContent = config.fmt ? config.fmt(value) : String(value);
  }
}

// ------------------------------------------------------------ 主动搭话（2026-10-21）
//
// 「允许的搭话方式」是**数组**（proactive.modes），没法走 bindAll 那张"一个控件 → 一个字段"的表，
// 所以单独画、单独接线；其余字段（开关/秒数/次数/概率/字数/规矩）都在绑定表里。

const PROACTIVE_MODE_FIELDS = [
  { id: 'proactiveModeTopic', mode: 'topic' },
  { id: 'proactiveModeAsk', mode: 'ask' },
  { id: 'proactiveModeFollow', mode: 'follow' }
];

function readProactiveModes() {
  return PROACTIVE_MODE_FIELDS.filter((item) => {
    const node = $(item.id);
    return Boolean(node && node.checked);
  }).map((item) => item.mode);
}

/** 回填勾选框 + 卡片标题旁那句摘要（开关关着/三种全关时要说得明白） */
function renderProactive() {
  const config = (state.settings && state.settings.proactive) || {};
  const modes = Array.isArray(config.modes) ? config.modes : [];
  for (const item of PROACTIVE_MODE_FIELDS) {
    const node = $(item.id);
    if (node) node.checked = modes.includes(item.mode);
  }
  const hint = $('proactiveHint');
  if (!hint) return;
  if (config.enabled !== true) {
    hint.textContent = '关着：她自己不会主动开口（右边按钮仍可手动试）';
    return;
  }
  const bits = [
    `安静 ${Number(config.idleSeconds) || 0} 秒后搭话`,
    `最多 ${Number(config.maxPerHour) || 0} 次/小时`,
    `每次 ${Number(config.chancePercent) || 0}% 概率`
  ];
  if (!modes.length) bits.push('⚠️ 三种方式都关了，等于不会搭话');
  hint.textContent = bits.join(' · ');
}

function wireProactive() {
  for (const item of PROACTIVE_MODE_FIELDS) {
    const node = $(item.id);
    if (!node) continue;
    node.addEventListener('change', async () => {
      const modes = readProactiveModes();
      if (!modes.length) toast('三种方式都关了 = 不会主动搭话', 'warn', 6000);
      await window.api.settings.update({ proactive: { modes } });
      renderProactive();
    });
  }
  const nowBtn = $('proactiveNow');
  if (nowBtn) {
    nowBtn.addEventListener('click', async () => {
      nowBtn.disabled = true;
      try {
        const result = await window.api.copilot.warmup();
        if (result && result.ok === false) toast(result.message, 'warn', 9000);
        else if (result && result.reply) {
          toast(`她搭了一句：${String(result.reply.text || '').slice(0, 40)}`, 'ok', 8000);
        } else toast('这次没搭上，看看运行日志', 'warn', 7000);
      } catch (error) {
        toast(`让她搭话失败：${error.message}`, 'err', 9000);
      } finally {
        nowBtn.disabled = false;
        renderProactive();
      }
    });
  }
  renderProactive();
}

// ------------------------------------------------------------ 观众记忆（2026-10-21）
//
// 开关和参数都在绑定表里；这一块只画「状态行」和处理四个按钮（查看 / 打开文件夹 / 清空）。
// 状态由主进程推 `memory:changed`（开始/结束本场、总结完一批、清空），面板照着画就行。

let memoryCache = null;

function formatClock(ts) {
  if (!ts) return '';
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderMemory(state) {
  memoryCache = state || null;
  const status = $('memoryStatus');
  if (!status) return;
  const config = (state && state.config) || {};
  const roster = Number(state && state.rosterCount) || 0;
  const rosterText = config.rosterEnabled === false ? '老观众名册：关着' : `老观众名册：${roster} 人`;
  if (!state || !state.recording) {
    // 关着的时候要说清楚**下次启动会不会自己开**，不然主播分不清「我关了」和「它坏了」
    const willAutoStart = config.autoStart !== false ? '（下次启动自动开始）' : '';
    status.textContent = `本场记录：关着${willAutoStart} · ${rosterText}`;
  } else {
    const start = formatClock(state.startedAt);
    const sizeKb = state.sessionBytes ? `${Math.max(1, Math.round(state.sessionBytes / 1024))}KB` : '0KB';
    const parts = [
      `正在记录（${start} 开始）`,
      `${Number(state.sessionViewers) || 0} 个观众 / ${Number(state.sessionPoints) || 0} 条要点`,
      sizeKb,
      `${rosterText}`
    ];
    if (state.buffered) parts.push(`本批攒着 ${state.buffered} 条`);
    const cap = Number(config.maxBatchesPerHour) || 0;
    if (cap > 0) parts.push(`这小时已总结 ${Number(state.batchesThisHour) || 0}/${cap} 次`);
    if (state.flushing) parts.push('正在总结…');
    status.textContent = parts.join(' · ');
  }
  const flush = $('memoryFlush');
  if (flush) flush.disabled = !state || !state.recording || Boolean(state && state.flushing);
  const openSession = $('memoryOpenFile');
  if (openSession) openSession.disabled = !state || !state.recording;
}

async function refreshMemory() {
  if (!window.api || !window.api.memory) return;
  try {
    renderMemory(await window.api.memory.state());
  } catch (error) {
    const status = $('memoryStatus');
    if (status) status.textContent = `读不到观众记忆状态：${error.message}`;
  }
}

function wireMemory() {
  const openSession = $('memoryOpenFile');
  if (openSession) {
    openSession.addEventListener('click', async () => {
      const result = await window.api.memory.openFile('session');
      if (!result || !result.ok) toast((result && result.message) || '打不开本场文档', 'warn', 8000);
    });
  }
  const openRoster = $('memoryOpenRoster');
  if (openRoster) {
    openRoster.addEventListener('click', async () => {
      const result = await window.api.memory.openFile('roster');
      if (!result || !result.ok) toast((result && result.message) || '打不开名册', 'warn', 8000);
    });
  }
  const openFolder = $('memoryOpenFolder');
  if (openFolder) {
    openFolder.addEventListener('click', async () => {
      try {
        const dir = await window.api.memory.openFolder();
        toast(`观众记忆目录：${dir}`, 'ok', 7000);
      } catch (error) {
        toast(`打开文件夹失败：${error.message}`, 'err', 8000);
      }
    });
  }
  const flush = $('memoryFlush');
  if (flush) {
    flush.addEventListener('click', async () => {
      flush.disabled = true;
      try {
        const result = await window.api.memory.flush();
        if (result && result.ok) {
          toast(`总结完了：看了 ${result.lines} 条，新增 ${result.added ? result.added.viewers : 0} 条要点`, 'ok', 8000);
        } else {
          toast((result && result.message) || '这次没总结成', 'warn', 8000);
        }
      } catch (error) {
        toast(`总结失败：${error.message}`, 'err', 9000);
      } finally {
        await refreshMemory();
      }
    });
  }
  const clearSession = $('memoryClearSession');
  if (clearSession) {
    clearSession.addEventListener('click', async () => {
      const ok = await confirmDialog('清空本场观众记忆？文件会删掉，然后重新开始记。', { okText: '清空本场' });
      if (!ok) return;
      const result = await window.api.memory.clearSession();
      renderMemory(result && result.state);
      toast('本场观众记忆已清空', 'ok');
    });
  }
  const clearRoster = $('memoryClearRoster');
  if (clearRoster) {
    clearRoster.addEventListener('click', async () => {
      const ok = await confirmDialog('清空老观众名册？之后所有人都算「第一次来」。', { okText: '清空名册' });
      if (!ok) return;
      const result = await window.api.memory.clearRoster();
      renderMemory(result && result.state);
      toast('老观众名册已清空', 'ok');
    });
  }
  window.api.on.memoryChanged((state) => renderMemory(state));
  renderMemory(null);
  void refreshMemory();
}

// ------------------------------------------------------------ 语音：引擎与音色回填

/**
 * 画「语音引擎」的单选状态（系统语音 / 云音色）和「云端失败退回」的勾选。
 *
 * ⚠️ 为什么必须由 `writeControls()` 也调一次：
 * `initSpeechPanel()` 跑在**读配置之前**（init 的第 5 步，配置是第 6 步才读），
 * 那时 `state.settings` 还是 null，画出来永远是「系统语音」。
 * 以前只有绑定时画这一次，于是主播用云音色关掉软件、下次打开界面永远显示系统语音，
 * 而实际发声的悬浮窗读的是配置 → **界面和行为对不上**（主播报的就是这个 bug）。
 */
function renderSpeechEngine() {
  const speech = (state.settings && state.settings.speech) || {};
  const engine = speech.engine === 'cloud' ? 'cloud' : 'system';
  const system = $('speechEngineSystem');
  const cloud = $('speechEngineCloud');
  if (system) system.checked = engine === 'system';
  if (cloud) cloud.checked = engine === 'cloud';
  const fallback = $('speechFallback');
  if (fallback) fallback.checked = speech.fallbackToSystem !== false;
}

/**
 * 把「系统语音的音色」下拉同步成配置里的值。
 * 同一类 bug：选项列表是 initSpeechPanel 早期填的（那时还没读配置），
 * 列表填完设的选中项是「自动」，之后没人再同步 → 界面显示自动、实际用的是配置里那个。
 * 选项还没建出来时（getVoices 为空）赋值会静默失败，所以这里先确认选项存在。
 */
function syncSpeechVoiceSelect() {
  const select = $('speechVoice');
  if (!select) return;
  const wanted = ((state.settings && state.settings.speech) || {}).voiceURI || '';
  const exists = Array.from(select.children || []).some((option) => option.value === wanted);
  if (exists || !wanted) select.value = wanted;
}

// ------------------------------------------------------------ 角色切换

/** 配置里的一整套人设活字段 = 当前角色的内容 */
function personaFields(role) {
  const name = String((role && role.name) || '').trim() || '小助手';
  return {
    botName: name,
    // 「称呼」在界面上没有单独入口，跟着角色名字走，免得 {称呼} 一直卡在旧名字上
    nickname: name,
    systemPrompt: String((role && role.prompt) || ''),
    styleNotes: String((role && role.style) || '')
  };
}

/** 当前角色 id（指向了不存在的角色就回默认，和主进程的兜底保持一致） */
function currentRoleId() {
  const persona = (state.settings || {}).persona || {};
  const roles = persona.roles || {};
  const id = String(persona.activeRole || 'default');
  return roles[id] ? id : 'default';
}

/** 重画角色下拉（数据来自配置，界面只负责画） */
function fillRoleOptions() {
  const select = $('roleSelect');
  const persona = (state.settings || {}).persona || {};
  const roles = persona.roles || {};
  const active = currentRoleId();
  const entries = Object.entries(roles);
  if (select) {
    select.innerHTML = '';
    for (const [id, role] of entries) {
      const option = document.createElement('option');
      option.value = id;
      option.textContent = `${role.emoji ? `${role.emoji} ` : ''}${role.name || id}${id === 'default' ? '（默认）' : ''}`;
      select.appendChild(option);
    }
    if (!entries.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '（还没有角色）';
      select.appendChild(option);
    }
    select.value = active;
  }
  const emoji = $('roleEmoji');
  if (emoji) emoji.value = (roles[active] && roles[active].emoji) || '';
  const hint = $('roleHint');
  if (hint) {
    hint.textContent = entries.length
      ? `共 ${entries.length} 个角色 · 名字 / 人设 / 性格改动会自动存进当前角色`
      : '切换角色会同时换掉下面的名字、人设、性格。';
  }
}

/** 把某个角色的内容铺到界面的活字段上，并切过去（一次 patch，避免中间态） */
async function applyRole(roleId, { toastText } = {}) {
  const persona = (state.settings || {}).persona || {};
  const roles = { ...(persona.roles || {}) };
  const role = roles[roleId];
  if (!role) {
    toast('这个角色已经不在了，刷新一下看看', 'warn');
    return;
  }
  state.settings = await window.api.settings.update({
    persona: { activeRole: roleId, ...personaFields(role) }
  });
  writeControls();
  if (toastText) toast(toastText, 'ok');
}

function nextRoleName(roles) {
  const names = new Set(Object.values(roles).map((role) => String(role.name || '')));
  if (!names.has('新角色')) return '新角色';
  for (let i = 2; i < 999; i += 1) {
    if (!names.has(`新角色 ${i}`)) return `新角色 ${i}`;
  }
  return `新角色 ${Date.now()}`;
}

function newRoleId(roles) {
  const base = `role-${Date.now().toString(36)}`;
  let id = base;
  let n = 1;
  while (roles[id]) {
    n += 1;
    id = `${base}-${n}`;
  }
  return id;
}

// ------------------------------------------------------------ 知识库

/** 正在编辑的条目 id（空 = 新增模式） */
let editingKnowledgeId = '';

/** 「联网校对」勾选了哪几条（条目行上的勾选框；不勾就跑"最久没更新"的前 N 条） */
const selectedKnowledgeIds = new Set();
/** 最近一次从主进程拿到的「整理/校对」状态（建议列表 + 运行进度） */
let reviewCache = null;

function knowledgeEl(id) {
  return $(id);
}

/** 画统计行 + 条目列表 */
async function renderKnowledge() {
  const listBox = knowledgeEl('knowledgeList');
  const hint = knowledgeEl('knowledgeStats');
  try {
    const data = await window.api.knowledge.list();
    const stats = data.stats || {};
    // 知识库根目录同时就是 DSH 的工作区：读一次，两处都用它
    setDshWorkspace(stats.dir);
    if (hint) {
      const lockedNote = stats.locked ? `，其中 ${stats.locked} 条只读` : '';
      hint.textContent = stats.count
        ? `共 ${stats.count} 条（启用 ${stats.enabled} 条${lockedNote}，约 ${stats.chars} 字）· 目录：${stats.dir}`
        : `还是空的（目录：${stats.dir}）。下面加一条试试，或者点右上角「打开文件夹」直接把 .md 放进 notes\\ 里。`;
    }
    renderPending(data.pending);
    // 勾选框对应的条目可能已经被删/锁了：先把失效的选择清掉，免得「校对选中的」跑到幽灵条目上
    const aliveIds = new Set((Array.isArray(data.items) ? data.items : []).map((item) => item.id));
    for (const id of [...selectedKnowledgeIds]) {
      if (!aliveIds.has(id)) selectedKnowledgeIds.delete(id);
    }
    // 「整理与校对」的建议列表和运行进度：跟知识库一起刷新（同一个页签）
    await renderReview();
    // 「模型想查 / 想记」的待办：和知识库一起刷新（它们在同一个页签里）
    await renderResearchList();
    // 「知识库改动记录」也一样（她刚改过的条目就在这儿，能直接撤销）
    await renderEditsList();
    const listHint = knowledgeEl('knowledgeListHint');
    if (listHint) listHint.textContent = stats.count ? `${stats.count} 条` : '';
    if (!listBox) return;
    listBox.innerHTML = '';
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = '还没有知识条目。';
      listBox.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'knowledge-row';

      const head = document.createElement('div');
      head.className = 'knowledge-row-head';
      // 勾选框：给「联网校对」选目标用（不勾就按"最久没更新"优先）
      const pick = document.createElement('input');
      pick.type = 'checkbox';
      pick.className = 'knowledge-pick';
      pick.checked = selectedKnowledgeIds.has(item.id);
      pick.setAttribute('data-id', item.id);
      pick.title = '勾上之后可以在「整理与校对」里只校对这一条';
      pick.addEventListener('change', () => {
        if (pick.checked) selectedKnowledgeIds.add(item.id);
        else selectedKnowledgeIds.delete(item.id);
        renderReviewControls();
      });
      head.appendChild(pick);
      const title = document.createElement('b');
      title.textContent = item.title;
      head.appendChild(title);
      if (item.locked === true) {
        const lockTag = document.createElement('span');
        lockTag.className = 'hint';
        lockTag.textContent = '（🔒 只读）';
        head.appendChild(lockTag);
      }
      if (item.enabled === false) {
        const off = document.createElement('span');
        off.className = 'hint';
        off.textContent = '（已停用）';
        head.appendChild(off);
      }
      if (item.tags && item.tags.length) {
        const tags = document.createElement('span');
        tags.className = 'hint';
        // 主进程回来的 tags 一定是数组；这里再兜一层，界面不该因为一个字段类型就整块画不出来
        const list = Array.isArray(item.tags) ? item.tags : String(item.tags).split(/[,，、\s]+/).filter(Boolean);
        tags.textContent = list.length ? ` #${list.join(' #')}` : '';
        if (tags.textContent) head.appendChild(tags);
      }
      row.appendChild(head);

      const body = document.createElement('div');
      body.className = 'knowledge-row-body';
      const text = String(item.content || '');
      body.textContent = text.length > 140 ? `${text.slice(0, 140)}…` : text;
      row.appendChild(body);

      const meta = document.createElement('div');
      meta.className = 'hint';
      meta.textContent = `来源：${item.source || '—'} · 更新：${String(item.updated || '').slice(0, 16).replace('T', ' ')}`;
      row.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn tiny';
      editBtn.textContent = '编辑';
      editBtn.addEventListener('click', () => startEditKnowledge(item));
      actions.appendChild(editBtn);

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn tiny';
      toggleBtn.textContent = item.enabled === false ? '启用' : '停用';
      toggleBtn.addEventListener('click', async () => {
        await window.api.knowledge.update(item.id, { enabled: item.enabled === false });
        await renderKnowledge();
        toast(item.enabled === false ? '已启用这条知识' : '已停用（还会留着，只是不再带进回复）', 'ok');
      });
      actions.appendChild(toggleBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn tiny';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', async () => {
        if (!await confirmDialog(`删除「${item.title}」？文件会一起删掉。`)) return;
        await window.api.knowledge.remove(item.id);
        if (editingKnowledgeId === item.id) cancelEditKnowledge();
        selectedKnowledgeIds.delete(item.id);
        await renderKnowledge();
        toast('已删除', 'ok');
      });
      actions.appendChild(delBtn);

      // 锁定 = 只读：模型（改库 / 整理 / 校对 / 删）全都不许动它，人照常能改
      const lockBtn = document.createElement('button');
      lockBtn.className = 'btn tiny';
      lockBtn.textContent = item.locked === true ? '解锁' : '🔒 锁定';
      lockBtn.title =
        item.locked === true
          ? '解锁之后模型才能改/删这一条'
          : '锁成只读：模型不能改也不能删，但仍然会参与回复检索';
      lockBtn.addEventListener('click', async () => {
        try {
          await window.api.knowledge.update(item.id, { locked: item.locked !== true });
          await renderKnowledge();
          toast(
            item.locked === true ? '已解锁，模型可以改这一条了' : '已锁定：模型不能改/删这一条（仍参与检索）',
            'ok'
          );
        } catch (error) {
          toast(`改锁定状态失败：${error.message}`, 'err', 8000);
        }
      });
      actions.appendChild(lockBtn);
      row.appendChild(actions);

      listBox.appendChild(row);
    }
  } catch (error) {
    if (hint) hint.textContent = `读取知识库失败：${error.message}`;
  }
}

function startEditKnowledge(item) {
  editingKnowledgeId = item.id;
  if (knowledgeEl('knowledgeTitle')) knowledgeEl('knowledgeTitle').value = item.title || '';
  if (knowledgeEl('knowledgeTags')) knowledgeEl('knowledgeTags').value = (item.tags || []).join(',');
  if (knowledgeEl('knowledgeContent')) knowledgeEl('knowledgeContent').value = item.content || '';
  if (knowledgeEl('knowledgeEditHint')) knowledgeEl('knowledgeEditHint').textContent = `正在编辑：${item.title}`;
  if (knowledgeEl('knowledgeCancelEdit')) knowledgeEl('knowledgeCancelEdit').hidden = false;
  knowledgeEl('knowledgeTitle')?.focus?.();
  toast('改完点「保存条目」', 'ok');
}

function cancelEditKnowledge() {
  editingKnowledgeId = '';
  if (knowledgeEl('knowledgeTitle')) knowledgeEl('knowledgeTitle').value = '';
  if (knowledgeEl('knowledgeTags')) knowledgeEl('knowledgeTags').value = '';
  if (knowledgeEl('knowledgeContent')) knowledgeEl('knowledgeContent').value = '';
  if (knowledgeEl('knowledgeEditHint')) knowledgeEl('knowledgeEditHint').textContent = '正在新增';
  if (knowledgeEl('knowledgeCancelEdit')) knowledgeEl('knowledgeCancelEdit').hidden = true;
}

async function saveKnowledge() {
  const title = String(knowledgeEl('knowledgeTitle')?.value || '').trim();
  const content = String(knowledgeEl('knowledgeContent')?.value || '').trim();
  const tags = String(knowledgeEl('knowledgeTags')?.value || '').trim();
  if (!title && !content) {
    toast('标题和正文至少写一个', 'warn');
    return;
  }
  try {
    if (editingKnowledgeId) {
      await window.api.knowledge.update(editingKnowledgeId, { title, content, tags });
      toast('已保存修改', 'ok');
    } else {
      await window.api.knowledge.add({ title, content, tags, source: '手动添加' });
      toast('已加入知识库', 'ok');
    }
    cancelEditKnowledge();
    await renderKnowledge();
    // 存完顺手把检索预览也刷一下，能立刻看到「这条会不会被用上」
    if (knowledgeEl('knowledgeQuery')?.value) await runKnowledgeSearch();
  } catch (error) {
    toast(`保存失败：${error.message}`, 'err', 8000);
  }
}

async function runKnowledgeSearch() {
  const out = knowledgeEl('knowledgeSearchOut');
  const query = String(knowledgeEl('knowledgeQuery')?.value || '').trim();
  if (!out) return;
  if (!query) {
    out.textContent = '先输一句话。';
    return;
  }
  try {
    const result = await window.api.knowledge.search(query, { limit: 5 });
    const hits = Array.isArray(result.hits) ? result.hits : [];
    if (!hits.length) {
      out.textContent = '一条都没命中 —— 这句话不会带任何资料回答。';
      return;
    }
    const lines = hits.map(
      (hit) =>
        `${hit.strong ? '✅ 会注入' : '⬜ 弱命中（不会注入）'}  ${hit.title}（${hit.score}，命中 ${hit.matchedTokens} 个词）`
    );
    out.textContent = lines.join('\n');
  } catch (error) {
    out.textContent = `检索失败：${error.message}`;
  }
}

function wireKnowledge() {
  const save = knowledgeEl('knowledgeSave');
  if (save) save.addEventListener('click', saveKnowledge);
  const cancel = knowledgeEl('knowledgeCancelEdit');
  if (cancel) cancel.addEventListener('click', cancelEditKnowledge);
  const searchBtn = knowledgeEl('knowledgeSearchBtn');
  if (searchBtn) searchBtn.addEventListener('click', runKnowledgeSearch);
  const query = knowledgeEl('knowledgeQuery');
  if (query) {
    query.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runKnowledgeSearch();
    });
  }
  const reload = knowledgeEl('knowledgeReload');
  if (reload) {
    reload.addEventListener('click', async () => {
      await renderKnowledge();
      toast('已重新读取知识库目录', 'ok');
    });
  }
  const openFolder = knowledgeEl('knowledgeOpenFolder');
  if (openFolder) {
    openFolder.addEventListener('click', async () => {
      const dir = await window.api.knowledge.openFolder();
      toast(`知识库目录：${dir}`, 'ok', 7000);
    });
  }
  wireDsh();
  wireResearch();
  wireSearchMode();
  wireImportFiles();
  // 待审草稿的批量操作（2026-10-21 主播要的）：一条条点太烦，但批量**必须先确认**
  const approveAll = knowledgeEl('pendingApproveAll');
  if (approveAll) {
    approveAll.addEventListener('click', async () => {
      const data = await window.api.knowledge.list();
      const pending = data && Array.isArray(data.pending) ? data.pending : [];
      if (!pending.length) {
        toast('已经没有待审草稿了', 'ok', 5000);
        return;
      }
      const ok = await confirmDialog(
        `把这 ${pending.length} 条草稿全部写进知识库？每条都会留一条「新建」记录，事后能在「改动记录」里撤销。`,
        { okText: `通过 ${pending.length} 条` }
      );
      if (!ok) return;
      approveAll.disabled = true;
      try {
        await approveAllDraftsAsync();
      } finally {
        // 刷新后 renderPending 会按真实条数重新决定灰不灰，这里只是兜底
        await renderKnowledge();
      }
    });
  }
  const clearPending = knowledgeEl('pendingClear');
  if (clearPending) {
    clearPending.addEventListener('click', async () => {
      const data = await window.api.knowledge.list();
      const pending = data && Array.isArray(data.pending) ? data.pending : [];
      if (!pending.length) {
        toast('没有待审草稿可清空', 'ok', 5000);
        return;
      }
      const ok = await confirmDialog(
        `丢掉这 ${pending.length} 条草稿？只删草稿，知识库里**已有的条目一个字都不会动**。`,
        { okText: '全部丢掉' }
      );
      if (!ok) return;
      clearPending.disabled = true;
      try {
        const result = await window.api.knowledge.clearPending();
        const removed = Number(result && result.removed) || 0;
        const failed = (result && result.failed) || [];
        if (failed.length) {
          toast(`丢掉 ${removed} 条，${failed.length} 条没删掉：${failed.slice(0, 2).join('、')}`, 'err', 11000);
        } else {
          toast(`已丢掉 ${removed} 条待审草稿（知识库没动）`, 'ok', 8000);
        }
      } catch (error) {
        toast(`清空待审失败：${error.message}`, 'err', 9000);
      } finally {
        await renderKnowledge();
        clearPending.disabled = false;
      }
    });
  }
  const editsReload = knowledgeEl('editsReload');
  if (editsReload) editsReload.addEventListener('click', renderEditsList);
  const editsToggle = knowledgeEl('editsToggle');
  if (editsToggle) editsToggle.addEventListener('click', () => setEditsCollapsed());
  // 待审草稿 / 全部条目也能收起（2026-10-19 加的）：知识库页越来越长，
  // 但这两块默认是**展开**的——它们是日常要看的东西，一进来就收着会吓人。
  for (const name of ['pending', 'entries']) {
    const toggle = knowledgeEl(COLLAPSE_SECTIONS[name].toggle);
    if (toggle) toggle.addEventListener('click', () => setCollapsed(name));
    setCollapsed(name, readCollapsed(name));
  }
  // 改动记录的初值：默认折叠（这一块只增不减，展开着太占地方）
  setEditsCollapsed(readEditsCollapsed());
  wireReview();
}

// ------------------------------------------------------------ 整理 / 校对 / 更新（2026-10-19）

/** 界面上的建议列表 = 主进程存的 `.review.json`；跑起来之后靠 `knowledge:review` 事件刷新 */
async function renderReview(state) {
  const box = knowledgeEl('reviewList');
  const summary = knowledgeEl('reviewSummary');
  const progress = knowledgeEl('reviewProgress');
  if (!box && !summary) return;
  let data = state;
  if (!data) {
    try {
      data = await window.api.knowledge.reviewState();
    } catch (error) {
      if (summary) summary.textContent = `读不到整理状态：${error.message}`;
      return;
    }
  }
  reviewCache = data;
  const items = Array.isArray(data.items) ? data.items : [];
  const stats = data.stats || {};
  const running = Boolean(data.running);
  const lastRun = Array.isArray(data.runs) && data.runs.length ? data.runs[data.runs.length - 1] : null;
  if (summary) {
    const parts = [`共 ${stats.count || 0} 条知识`, stats.locked ? `${stats.locked} 条只读` : '没有只读条目'];
    parts.push(items.length ? `${items.length} 条建议等你拍板` : '没有待处理的建议');
    if (lastRun) {
      const when = String(lastRun.startedAt || '').slice(0, 16).replace('T', ' ');
      const mode = lastRun.mode === 'audit' ? '整理' : '联网校对';
      parts.push(`上次${mode}：${when}（看了 ${lastRun.notes || 0} 条，给出 ${lastRun.found || 0} 条建议）`);
    }
    if (data.maxMode) parts.push('最高权限开着：她会直接应用建议（有记录、可撤销）');
    summary.textContent = `${parts.join(' · ')}。`;
  }
  if (progress) {
    if (running && data.progress) {
      const p = data.progress;
      const total = Math.max(1, Number(p.total) || 1);
      const done = Math.min(Number(p.done) || 0, total);
      progress.hidden = false;
      progress.textContent =
        p.mode === 'audit'
          ? '正在整理全库…（最高思考档，通常 1~2 分钟，别关面板）'
          : `正在联网校对：第 ${Math.min(done + 1, total)}/${total} 条「${p.title || ''}」…（每条约 10~30 秒）`;
    } else {
      progress.hidden = true;
      progress.textContent = '';
    }
  }
  renderReviewControls();
  if (!box) return;
  box.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = running ? '跑完就会出现在这里。' : '还没有建议。点上面的「整理全库」或勾几条再「联网校对」。';
    box.appendChild(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'knowledge-row';

    const head = document.createElement('div');
    head.className = 'knowledge-row-head';
    const badge = document.createElement('span');
    badge.className = 'hint';
    badge.textContent =
      item.kind === 'merge' ? '合并' : item.kind === 'delete' ? '删除' : item.mode === 'verify' ? '联网核对' : '改写';
    head.appendChild(badge);
    const title = document.createElement('b');
    title.textContent = (item.after && item.after.title) || (item.before && item.before.title) || item.noteIds.join('、');
    head.appendChild(title);
    if (item.kind === 'merge' && item.noteIds.length > 1) {
      const mergeNote = document.createElement('span');
      mergeNote.className = 'hint';
      const titles = Array.isArray(item.dropTitles) && item.dropTitles.length ? `（删掉「${item.dropTitles.join('」「')}」）` : '';
      mergeNote.textContent = `（由 ${item.noteIds.length} 条合成，会删掉其余 ${item.dropIds.length} 条${titles}）`;
      head.appendChild(mergeNote);
    }
    row.appendChild(head);

    const change = document.createElement('div');
    change.className = 'hint';
    change.textContent = item.change || '';
    row.appendChild(change);

    if (item.kind !== 'delete' && item.after && item.after.content) {
      const body = document.createElement('div');
      body.className = 'knowledge-row-body';
      const text = String(item.after.content || '');
      body.textContent = text.length > 220 ? `${text.slice(0, 220)}…` : text;
      row.appendChild(body);
    }
    if (item.reason) {
      const reason = document.createElement('div');
      reason.className = 'hint';
      reason.textContent = `理由：${item.reason}`;
      row.appendChild(reason);
    }
    if (Array.isArray(item.sources) && item.sources.length) {
      const sources = document.createElement('div');
      sources.className = 'hint';
      sources.textContent = `依据：${item.sources
        .slice(0, 3)
        .map((source) => (source && source.title ? `「${source.title}」` : '') + (source && source.url ? ` ${source.url}` : ''))
        .filter(Boolean)
        .join('；')}`;
      row.appendChild(sources);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn tiny primary';
    applyBtn.textContent = '应用';
    applyBtn.disabled = running;
    applyBtn.addEventListener('click', () => applyReviewItemAsync(item.id));
    actions.appendChild(applyBtn);
    const discardBtn = document.createElement('button');
    discardBtn.className = 'btn tiny';
    discardBtn.textContent = '忽略';
    discardBtn.disabled = running;
    discardBtn.addEventListener('click', async () => {
      const result = await window.api.knowledge.reviewDiscard(item.id);
      await renderReview(result && result.state);
      toast('已忽略这条建议', 'ok');
    });
    actions.appendChild(discardBtn);
    row.appendChild(actions);

    box.appendChild(row);
  }
}

/** 按钮可用性 / 文案：跑起来的时候全都禁掉，否则会互相抢 `.review.json` */
function renderReviewControls() {
  const running = Boolean(reviewCache && reviewCache.running);
  const items = reviewCache && Array.isArray(reviewCache.items) ? reviewCache.items : [];
  const count = selectedKnowledgeIds.size;
  const verifyBtn = knowledgeEl('reviewVerify');
  if (verifyBtn) {
    verifyBtn.textContent = count ? `联网校对选中的 (${count})` : '联网校对';
    verifyBtn.disabled = running;
    verifyBtn.title = count
      ? `只校对勾选这 ${count} 条（每条约 10~30 秒、约 0.01~0.03 元）`
      : '不勾选就按「最久没更新」优先，跑配置里那几条';
  }
  const auditBtn = knowledgeEl('reviewAudit');
  if (auditBtn) auditBtn.disabled = running;
  const cancelBtn = knowledgeEl('reviewCancel');
  if (cancelBtn) cancelBtn.hidden = !running;
  const clearBtn = knowledgeEl('reviewClear');
  if (clearBtn) {
    clearBtn.hidden = !items.length || running;
    clearBtn.textContent = `清空建议（${items.length}）`;
  }
  const selectAll = knowledgeEl('entriesSelectAll');
  if (selectAll) selectAll.disabled = running;
  const selectNone = knowledgeEl('entriesSelectNone');
  if (selectNone) selectNone.disabled = running || !count;
}

/** 跑一次「整理全库」 */
async function runReviewAuditAsync() {
  const auditBtn = knowledgeEl('reviewAudit');
  if (auditBtn) auditBtn.disabled = true;
  // 干活的提示是**常驻**的（ms=0：1~2 分钟里主播可能在别的页签），
  // 所以跑完必须自己收掉——否则「正在整理…」会永远挂在右下角（主播报过）。
  const pending = toast('正在整理全库（最高思考档，可能要 1~2 分钟，别关面板）…', 'ok', 0);
  try {
    const result = await window.api.knowledge.reviewAudit();
    await renderReview(result && result.state);
    await renderKnowledge();
    if (!result || !result.ok) {
      toast(`整理没成：${(result && result.message) || '看日志'}`, 'err', 12000);
      return;
    }
    const auto = result.autoApplied ? `，最高权限已自动应用 ${result.autoApplied} 条` : '';
    const locked = result.locked ? `（跳过 ${result.locked} 条只读）` : '';
    toast(
      result.found
        ? `整理完了：看了 ${result.notes} 条${locked}，给出 ${result.found} 条建议${auto}`
        : `整理完了：看了 ${result.notes} 条${locked}，没发现问题`,
      result.found ? 'ok' : 'warn',
      12000
    );
  } catch (error) {
    toast(`整理失败：${error.message}`, 'err', 12000);
  } finally {
    dismissToast(pending);
    if (auditBtn) auditBtn.disabled = false;
    renderReviewControls();
  }
}

/** 跑一次「联网校对」（勾了就只跑勾的；没勾按最久没更新优先） */
async function runReviewVerifyAsync() {
  const ids = [...selectedKnowledgeIds];
  const limit = Number(reviewCache && reviewCache.limit) || 5;
  const count = ids.length || limit;
  const scope = ids.length ? `勾选的 ${ids.length} 条` : `最久没更新的前 ${limit} 条`;
  const ok = await confirmDialog(
    `联网校对${scope}？\n每条约 10~30 秒、大约 0.01~0.03 元（一次搜索 + 一次最高思考档调用）。\n` +
      `跑完会给建议，你点「应用」才改库。`,
    { okText: `开始校对 ${count} 条` }
  );
  if (!ok) return;
  const verifyBtn = knowledgeEl('reviewVerify');
  if (verifyBtn) verifyBtn.disabled = true;
  // 同整理：干活提示常驻，跑完（成功/失败/取消）自己收掉
  const pending = toast(`正在联网校对 ${count} 条（每条约 10~30 秒，别关面板）…`, 'ok', 0);
  try {
    const result = await window.api.knowledge.reviewVerify({ ids, limit });
    await renderReview(result && result.state);
    await renderKnowledge();
    if (!result || !result.ok) {
      toast(`校对没成：${(result && result.message) || '看日志'}`, 'err', 12000);
      return;
    }
    const bits = [];
    bits.push(`查了 ${result.searched} 条`);
    if (result.unchanged) bits.push(`${result.unchanged} 条没发现问题`);
    if (result.found) bits.push(`${result.found} 条建议`);
    if (result.autoApplied) bits.push(`最高权限已自动应用 ${result.autoApplied} 条`);
    if (result.skippedLocked) bits.push(`跳过 ${result.skippedLocked} 条只读`);
    if (result.truncated) bits.push(`还有 ${result.truncated} 条这次没跑`);
    toast(`联网校对完了：${bits.join('，')}`, result.found ? 'ok' : 'warn', 14000);
  } catch (error) {
    toast(`校对失败：${error.message}`, 'err', 12000);
  } finally {
    dismissToast(pending);
    if (verifyBtn) verifyBtn.disabled = false;
    renderReviewControls();
  }
}

async function applyReviewItemAsync(itemId) {
  const result = await window.api.knowledge.reviewApply(itemId);
  await renderReview(result && result.state);
  await renderKnowledge();
  if (!result || !result.ok) {
    toast(`没法应用：${(result && result.message) || '看日志'}`, 'err', 14000);
    return;
  }
  toast(`已应用：「${result.title}」（改动记录里能撤销）`, 'ok', 10000);
}

/** 接线：整理与校对的四个按钮 + 条目列表的全选/清空 */
function wireReview() {
  const auditBtn = knowledgeEl('reviewAudit');
  if (auditBtn) auditBtn.addEventListener('click', runReviewAuditAsync);
  const verifyBtn = knowledgeEl('reviewVerify');
  if (verifyBtn) verifyBtn.addEventListener('click', runReviewVerifyAsync);
  const cancelBtn = knowledgeEl('reviewCancel');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const result = await window.api.knowledge.reviewCancel();
      toast(result && result.ok ? '正在取消…（当前这条跑完就停）' : (result && result.message) || '现在没在跑', 'warn');
    });
  }
  const clearBtn = knowledgeEl('reviewClear');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const items = (reviewCache && reviewCache.items) || [];
      if (!items.length) return;
      const ok = await confirmDialog(`清空这 ${items.length} 条建议？（只是丢掉建议，知识库不会被改）`, {
        okText: '清空'
      });
      if (!ok) return;
      const result = await window.api.knowledge.reviewClear();
      await renderReview(result && result.state);
      toast('已清空建议', 'ok');
    });
  }
  const selectAll = knowledgeEl('entriesSelectAll');
  if (selectAll) {
    selectAll.addEventListener('click', () => {
      const rows = knowledgeEl('knowledgeList');
      if (!rows) return;
      const boxes = rows.querySelectorAll('.knowledge-pick');
      for (const input of boxes) {
        input.checked = true;
        const id = (input.dataset && input.dataset.id) || input.getAttribute('data-id') || '';
        if (id) selectedKnowledgeIds.add(id);
      }
      renderReviewControls();
      toast(`已勾选 ${selectedKnowledgeIds.size} 条（点「联网校对选中的」开始）`, 'ok', 6000);
    });
  }
  const selectNone = knowledgeEl('entriesSelectNone');
  if (selectNone) {
    selectNone.addEventListener('click', () => {
      selectedKnowledgeIds.clear();
      renderKnowledge();
    });
  }
  renderReviewControls();
}

// ------------------------------------------------------------ 从文件导入资料（2026-10-19）

/**
 * 「添加/编辑条目」卡片里的「从文件导入…」。
 *
 * 两段式，而且**先看到代价再花钱**：
 *   ① 选文件 → 主进程读进来体检（编码 / 是不是纯文本 / 多大），界面上报「几个文件、多少字」；
 *   ② 弹一个确认框（说清楚要分几段、大概花多少），点了才真的让模型整理。
 * 整理结果一律进「待审草稿」——不直接写库，和项目里所有"模型产出"的规矩一致。
 */
function wireImportFiles() {
  const button = knowledgeEl('knowledgeImport');
  if (!button) return;
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const picked = await window.api.knowledge.pickImportFiles();
      const files = (picked && picked.files) || [];
      const skipped = (picked && picked.skipped) || [];
      if (skipped.length) toast(`这些没导入：${skipped.join('、')}`, 'warn', 9000);
      if (!files.length) {
        setImportHint(files.length ? '' : '没选文件。');
        return;
      }
      const totalChars = files.reduce((sum, file) => sum + Number(file.chars || 0), 0);
      // 粗算：每 5000 字一段、每段约 4 千输入 token + 一千输出，折几分钱
      const chunks = Math.max(1, Math.min(6, Math.ceil(totalChars / 5000)));
      setImportHint(
        `选了 ${files.length} 个文件，共 ${totalChars.toLocaleString('zh-CN')} 字：` +
          files.map((file) => `${file.name}（${file.chars} 字）`).join('、')
      );
      const ok = await openModal({
        message:
          `要用这些文件更新知识库？\n` +
          `${files
            .slice(0, 5)
            .map((file) => `${file.name}（${Number(file.chars).toLocaleString('zh-CN')} 字）`)
            .join('、')}${files.length > 5 ? ` 等 ${files.length} 个文件` : ''}\n` +
          `共 ${totalChars.toLocaleString('zh-CN')} 字，会分成约 ${chunks} 段让模型整理（预计几分钱）。\n` +
          '整理出来的内容先进「待审草稿」，你点通过才真的进知识库。',
        okText: '开始整理'
      });
      if (!ok) {
        setImportHint('取消了这个文件的导入。');
        return;
      }
      button.disabled = true;
      setImportHint(`正在整理 ${files.length} 个文件…（这一步要跑一会儿，别关面板）`);
      const result = await window.api.knowledge.importFiles();
      if (result && result.ok) {
        const extra = result.droppedChars
          ? `；另有 ${result.droppedChars} 字超出单次上限没处理，切小一点再导一次`
          : '';
        setImportHint(`整理出 ${result.count} 条，已放进「待审草稿」${extra}`);
        toast(`整理出 ${result.count} 条知识，去「待审草稿」里点通过`, 'ok', 10000);
      } else {
        setImportHint((result && result.message) || '整理失败，看日志');
        toast(`导入没成功：${(result && result.message) || '看日志'}`, 'err', 12000);
      }
      await renderKnowledge();
    } catch (error) {
      toast(`导入失败：${error.message}`, 'err', 12000);
      setImportHint(`导入失败：${error.message}`);
    } finally {
      button.disabled = false;
    }
  });
}

function setImportHint(text) {
  const hint = knowledgeEl('knowledgeImportList');
  if (hint) hint.textContent = text || '';
}

// ------------------------------------------------------------ 「联网怎么查」（两条内置搜索）

/**
 * 内置联网的两条走法（2026-10 起 DeepSeek 有了自研搜索接口，老办法照旧留着）：
 *   self  = 自研搜索接口 `POST /v1/tools/search`：快、便宜
 *   model = 模型联网（Anthropic 兼容 + 服务端 web_search）：慢、贵，但一直能用
 * 界面上是单选，选了立刻存配置；**主进程才是真正决定走哪条的地方**（`runResearchQuery`）。
 */
const SEARCH_MODE_LABEL = {
  self: '自研搜索',
  model: '模型联网'
};

function currentSearchMode() {
  return ((state.settings || {}).knowledge || {}).searchMode === 'model' ? 'model' : 'self';
}

/** 按配置画单选（和语音引擎一样：读配置前可能已经画过一次，writeControls 要再同步一遍） */
function renderSearchMode() {
  const mode = currentSearchMode();
  const self = knowledgeEl('searchModeSelf');
  const model = knowledgeEl('searchModeModel');
  if (self) self.checked = mode === 'self';
  if (model) model.checked = mode === 'model';
  const line = knowledgeEl('searchModeLine');
  if (line) {
    line.textContent =
      mode === 'self'
        ? '现在走自研搜索接口：实测不到 1 秒出结果，失败自动退回老办法。'
        : '现在走模型联网（老办法）：实测 6~15 秒，慢但接口一直可用。';
  }
}

function wireSearchMode() {
  for (const id of ['searchModeSelf', 'searchModeModel']) {
    const node = knowledgeEl(id);
    if (!node) continue;
    node.addEventListener('change', async () => {
      if (!node.checked) return;
      const mode = node.value === 'model' ? 'model' : 'self';
      state.settings = await window.api.settings.update({ knowledge: { searchMode: mode } });
      renderSearchMode();
      toast(
        mode === 'self'
          ? '联网改用自研搜索接口：快了约 8 倍，也便宜了（失败会自动退回老办法）'
          : '联网改回模型联网（老办法）：慢一点、贵一点，但接口一直可用',
        'ok',
        8000
      );
    });
  }
  renderSearchMode();
}

// ------------------------------------------------------------ DSH（可选研究引擎，**已下线**）

/*
 * ⚠️ 这一整段是「让 DSH 整理」那张卡的界面逻辑，**2026-10-19 起已下线**：
 *    index.html 里 `#dshCard` 加了 `hidden`，界面上看不到也点不到；
 *    main.js 那边把 `runResearchQuery` 的 engine 钉成了 'builtin'，所以 DSH 不会被调用。
 *
 * 为什么这些函数**一行没删**（主播选的「只藏不删」）：
 *    · 卡片还在 DOM 里（只是隐藏），这些 id 全都还找得到，删了反而会让
 *      `audit.js` 的「面板引用了不存在的 id」检查变红；
 *    · 想恢复只要去掉 index.html 里那个 `hidden`，界面逻辑一行都不用重写。
 *
 * 它原来干什么：`#dshDetect`/`#dshDeepDetect` 检测本机 Node + @deepseek-ai/dsh 环境并把
 * 缺什么逐条列出来；检测通过才允许 `#dshRun` 开始整理；整理中能 `#dshCancel`；
 * 还管「跑法（会话/一次性）」「会话名」「模型」三个输入，以及工作区（= 知识库目录）的告知。
 * 下线原因、恢复步骤、相关的三个 audit 检查见交接文档 §6.16。
 */

/** 上一次环境检测的结果：null = 还没测过。界面据此决定能不能点「开始整理」 */
let dshState = { checked: false, ok: false, running: false };

/**
 * DSH 的工作区（= 知识库根目录）。
 * 由主进程给（`knowledge:list` 的 stats.dir / `dsh:detect` 的 workspace），
 * 界面只负责显示——**路径不能由界面自己拼**，否则两边说不一致就没人知道 DSH 到底能碰哪儿。
 */
let dshWorkspace = '';

/** 画「工作区」那一块：告诉用户 DSH 被关在哪个文件夹里，并给一个打开它的按钮 */
function renderDshWorkspace() {
  const pathEl = knowledgeEl('dshWorkspacePath');
  if (pathEl) pathEl.textContent = dshWorkspace || '正在读取…';
}

/** 把工作区路径统一收进来（主进程说什么就是什么） */
function setDshWorkspace(value) {
  const text = String(value || '').trim();
  if (text) dshWorkspace = text;
  renderDshWorkspace();
}

/**
 * 第一次用 DSH 之前，先把「它只能在知识库文件夹里读写」这件事说清楚。
 * 只说一次（记在配置里）：这事需要用户知道，但每次跑都弹会烦人。
 * @returns {Promise<boolean>} 用户确认了没有
 */
async function ensureDshWorkspaceNotice() {
  const knowledge = (state.settings || {}).knowledge || {};
  if (knowledge.dshWorkspaceNoticeSeen) return true;
  const where = dshWorkspace || '软件目录下的「知识库」文件夹';
  const ok = await confirmDialog(
    `DSH 的工作区被限定在这个文件夹里：\n\n${where}\n\n` +
      '它只能在这个文件夹里读写文件（由 DSH 自己的沙箱强制，越界会被拒绝），读不到你电脑上的其它东西。\n' +
      '整理出来的东西也只会进「待审草稿」，你点了通过才会变成知识。',
    { okText: '知道了，开始整理', cancelText: '先不跑' }
  );
  if (!ok) return false;
  state.settings = await window.api.settings.update({ knowledge: { dshWorkspaceNoticeSeen: true } });
  return true;
}

/**
 * 门禁：只有「检测过 且 通过」才允许点「开始整理」。
 * 单独抽出来是因为**清空检测结果时也要重新上锁**——
 * 否则改一下路径、结果被清掉了，按钮却还亮着，用户会以为环境没问题。
 */
function applyDshGate() {
  const runBtn = knowledgeEl('dshRun');
  const hint = knowledgeEl('dshRunHint');
  const ready = dshState.checked && dshState.ok;
  if (runBtn) runBtn.disabled = !ready || dshState.running;
  if (hint) {
    if (ready) hint.textContent = '可以开始了。跑一次大约半分钟到几分钟，结果会进「待审草稿」。';
    else if (dshState.checked) hint.textContent = '环境没配好，暂时不能用这个功能。';
    else hint.textContent = '先点「检测环境」。';
  }
}

/** 画环境检测结果：每项一行「✅/❌ 名称 → 说明」，不过的下面再补一句怎么修 */
function renderDshChecks(result) {
  const box = knowledgeEl('dshChecks');
  const line = knowledgeEl('dshStatusLine');
  if (!box) return;
  box.innerHTML = '';
  if (!result) {
    if (line) line.textContent = '还没检测过。';
    applyDshGate();
    return;
  }
  for (const check of result.checks || []) {
    const row = document.createElement('div');
    row.className = 'hint';
    row.textContent = `${check.ok ? '✅' : '❌'} ${check.label}：${check.detail || ''}`;
    box.appendChild(row);
    if (!check.ok && check.hint) {
      const fix = document.createElement('div');
      fix.className = 'hint';
      fix.textContent = `　　↳ 怎么补：${check.hint}`;
      box.appendChild(fix);
    }
  }
  if (line) {
    const time = String(result.checkedAt || '').slice(11, 19);
    line.textContent = result.ok
      ? `环境没问题（${time} 检测）${result.dsh ? `，DSH v${result.dsh.version}` : ''}`
      : `环境还不完整（${time} 检测），按上面的「怎么补」处理完再点一次检测。`;
  }
  applyDshGate();
}

async function detectDsh({ deep = false } = {}) {
  const line = knowledgeEl('dshStatusLine');
  if (line) line.textContent = deep ? '正在深度检测（真跑一次，约 1 分钟）…' : '正在检测…';
  try {
    const result = await window.api.dsh.detect({ deep });
    dshState = { checked: true, ok: Boolean(result.ok), running: dshState.running };
    // 主进程顺手把工作区告诉了我们，用它校准界面上的路径
    setDshWorkspace(result.workspace);
    renderDshChecks(result);
    toast(result.ok ? '环境没问题，可以用 DSH 了' : '环境还不完整，看下面每一项的说明', result.ok ? 'ok' : 'warn', 9000);
    return result;
  } catch (error) {
    if (line) line.textContent = `检测失败：${error.message}`;
    return null;
  }
}

/** 画待审草稿列表 */
/**
 * 画「模型想查 / 想记」的待办清单。
 *
 * 这些条目是模型**自己提**的（它在回复里藏了 `[待查:…]` / `[记一笔:…]` 标记，观众看不到），
 * 这里给主播两个按钮：`lookup` 类型点「去查」才真联网查；`note` 类型点「存成草稿」直接进待审。
 * 两种都不需要主播打字 —— 直播中根本没空打字。
 */
/** 待办的主按钮文案（查 / 记 / 改 / 扩写 / 删） */
function researchPrimaryLabel(kind) {
  return kind === 'lookup'
    ? '去查'
    : kind === 'note'
      ? '记进知识库'
      : kind === 'edit'
        ? '让她改'
        : kind === 'expand'
          ? '让她扩写'
          : '让她删';
}

/**
 * 真去办一条待办 —— **卡片按钮和右下角快捷提示共用这一段**。
 * 返回 `{ok, ...}`；失败/成功的提示也在这里统一说。
 */
async function runResearchAsync(item) {
  const isLookup = item.kind === 'lookup';
  let result = null;
  try {
    result = isLookup ? await window.api.research.run(item.id) : await window.api.research.note(item.id);
  } catch (error) {
    toast(`调用失败：${error.message}`, 'err', 9000);
    return { ok: false, message: error.message };
  }
  if (result && result.ok) {
    if (isLookup) {
      // 说清「走的哪条路、用了多久」：两条路差一个数量级，主播要能对上号
      const how = [
        result.engineLabel || SEARCH_MODE_LABEL[currentSearchMode()],
        result.ms ? `${Math.max(1, Math.round(Number(result.ms) / 1000))} 秒` : '',
        result.fellBackFrom ? '自研搜索没成，已退回老办法' : '',
        result.degraded ? '整理那步没成，直接收的摘要' : ''
      ].filter(Boolean);
      toast(
        `查完了（${how.join(' · ')}），${(result.drafts || []).length} 条进了「待审草稿」`,
        result.degraded ? 'warn' : 'ok',
        9000
      );
    } else if (item.kind === 'note') {
      toast(result.created === false ? '已经有相关条目了，新内容并进去了' : '已记进知识库（改动记录里能撤销）', 'ok', 9000);
    } else if (item.kind === 'remove') {
      toast('已删掉（删除前备份过，「改动记录」里能恢复）', 'ok', 9000);
    } else {
      toast(result.changed ? '改好了，旧版本留着，「改动记录」里能撤销' : '看了一遍，不用改', 'ok', 9000);
    }
  } else {
    toast(`没成功：${(result && result.message) || '看日志'}`, 'err', 12000);
  }
  renderResearch(result && result.items);
  await renderKnowledge();
  return result || { ok: false };
}

/** 「不用管」一条待办（待处理的忽略掉；已处理的删记录） */
async function dismissResearchAsync(item) {
  const result =
    item.status === 'pending'
      ? await window.api.research.ignore(item.id)
      : await window.api.research.remove(item.id);
  renderResearch(result && result.items);
  return result;
}

/**
 * 把「待审草稿」**全部通过**（右下角快捷提示用）。
 * 一条条走 `knowledge.approve`：这样每条都会留一条「新建」记录，事后还能撤销。
 */
async function approveAllDraftsAsync() {
  const data = await window.api.knowledge.list();
  const pending = Array.isArray(data && data.pending) ? data.pending : [];
  if (!pending.length) {
    toast('已经没有待审草稿了', 'ok', 5000);
    return { ok: true, approved: 0 };
  }
  let approved = 0;
  const failed = [];
  for (const draft of pending) {
    try {
      await window.api.knowledge.approve(draft.id, {});
      approved += 1;
    } catch (error) {
      failed.push(`${draft.title}（${error.message}）`);
    }
  }
  if (failed.length) {
    toast(`通过了 ${approved} 条，${failed.length} 条没成：${failed.slice(0, 2).join('；')}`, 'err', 12000);
  } else {
    toast(`已通过 ${approved} 条，「改动记录」里能撤销`, 'ok', 9000);
  }
  await renderKnowledge();
  return { ok: failed.length === 0, approved };
}

function renderResearch(items) {
  const box = knowledgeEl('researchList');
  const hint = knowledgeEl('researchHint');
  if (!box) return;
  box.innerHTML = '';
  const list = Array.isArray(items) ? items : [];
  const pending = list.filter((item) => item.status === 'pending' || item.status === 'running').length;
  if (hint) {
    // 「去查」要等多久，取决于面板上选的哪条路（自研搜索约 3 秒，老办法 6~15 秒）
    const wait = currentSearchMode() === 'self' ? '约 3 秒' : '约 10 秒';
    hint.textContent = list.length
      ? `${pending} 条待办 / 共 ${list.length} 条记录。${
          pending
            ? `她会主动在对话里问你一句——回「查」/「记」/「改」她就去办；也可以直接在输入框说「查一下 XXX」。点「去查」才会真去联网查（${wait}、花一点额度），不点就不花钱。`
            : '都处理完了。'
        }`
      : '还没读到。等它在回复里提需求，或者点「重新读取」。';
  }
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '模型还没提过要查或要记的东西。';
    box.appendChild(empty);
    return;
  }
  for (const item of list) {
    const row = document.createElement('div');
    row.className = 'knowledge-row';

    const head = document.createElement('div');
    head.className = 'knowledge-row-head';
    const kind = document.createElement('b');
    kind.textContent = `${RESEARCH_KIND_LABEL[item.kind] || '🔎 想查'}：${item.text}`;
    head.appendChild(kind);
    const meta = document.createElement('span');
    meta.className = 'hint';
    const statusText =
      item.status === 'pending'
        ? '待处理'
        : item.status === 'running'
          ? item.runningLabel || '正在办…'
          : item.status === 'done'
            ? item.auto
              ? '已完成（她自己办的）'
              : '已完成'
            : item.status === 'failed'
              ? '失败'
              : '已忽略';
    meta.textContent = ` [${statusText}]${item.reason ? ` · ${item.reason}` : ''}${item.source ? ` · ${item.source}` : ''}`;
    head.appendChild(meta);
    row.appendChild(head);

    if (item.error) {
      const error = document.createElement('div');
      error.className = 'hint';
      error.textContent = `失败原因：${item.error}`;
      row.appendChild(error);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';
    if (item.status === 'pending' || item.status === 'failed') {
      const main = document.createElement('button');
      main.className = 'btn tiny primary';
      const isLookup = item.kind === 'lookup';
      main.textContent = isLookup
        ? '去查'
        : item.kind === 'note'
          ? '记进知识库'
          : item.kind === 'edit'
            ? '让她改'
            : item.kind === 'expand'
              ? '让她扩写'
              : '让她删';
      main.addEventListener('click', async () => {
        main.disabled = true;
        main.textContent = isLookup ? '正在查…（约 10 秒）' : '正在办…';
        try {
          await runResearchAsync(item);
        } finally {
          main.disabled = false;
          main.textContent = researchPrimaryLabel(item.kind);
        }
      });
      actions.appendChild(main);
    }
    const ignore = document.createElement('button');
    ignore.className = 'btn tiny';
    ignore.textContent = item.status === 'pending' ? '不用管' : '删掉记录';
    ignore.addEventListener('click', () => dismissResearchAsync(item));
    actions.appendChild(ignore);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function renderResearchList() {
  try {
    const data = await window.api.research.list();
    renderResearch(data && data.items);
  } catch (error) {
    const hint = knowledgeEl('researchHint');
    if (hint) hint.textContent = `待办读不出来：${error.message}`;
  }
}

function wireResearch() {
  const reload = knowledgeEl('researchReload');
  if (reload) reload.addEventListener('click', renderResearchList);
  const clear = knowledgeEl('researchClear');
  if (clear) {
    clear.addEventListener('click', async () => {
      const result = await window.api.research.clearFinished();
      renderResearch(result && result.items);
      toast(`清掉了 ${(result && result.removed) || 0} 条已处理记录`, 'ok');
    });
  }
}

/**
 * 「最高权限」那张卡上的一句话状态提示。
 * 大段说明是固定的（她能做到什么 / 绝不做什么），这里只把「现在到底是哪种行为」写清楚——
 * 关着和开着的行为差得很远，不能只靠一个勾选框。
 */
function renderMaxPermHint() {
  const hint = $('maxPermHint');
  if (!hint) return;
  const box = $('maxPermissions');
  const on = Boolean(box && box.checked);
  hint.textContent = on
    ? '⚠️ 已开启：她自己联网查、自己把产出写进知识库、自己调用软件功能、自己删条目——每一步都留记录、能撤销。'
    : '默认关着：她只提议，花钱和写库都要你点头。';
}

// ---------------------------------------------------------------- 知识库改动记录//
// 她改的 / 你改的 / 删掉的条目都在这儿排着，每条都能一键撤销：
//   改过的 → 回到改动前的原文；她新建的 → 整条删掉；删掉的 → 按备份恢复。

const EDIT_KIND_LABEL = {
  create: '🆕 新建',
  edit: '✏️ 改错',
  expand: '📖 扩写',
  manual: '🖐 你手动改的',
  remove: '🗑 删除'
};

/** 待办卡片的类型标签（五种：查 / 记 / 改 / 扩写 / 删） */
const RESEARCH_KIND_LABEL = {
  lookup: '🔎 想查',
  note: '📝 想记',
  edit: '✏️ 想改',
  expand: '📖 想扩写',
  remove: '🗑 想删'
};

/**
 * 「知识库改动记录」的折叠状态。
 *
 * 为什么默认折叠：这一块会越攒越长（她每改一次留一条），展开着占掉大半个知识库页，
 * 而主播平时只需要知道「有几条、能不能撤」——所以默认收起来，标题旁边留一行摘要。
 * 状态记在 localStorage（纯界面偏好，不进配置：配置是给程序读的，别混）。
 */
const EDITS_COLLAPSED_KEY = 'bili-ai-copilot.editsCollapsed';

/**
 * 「知识库」页三段可折叠区域：改动记录 / 待审草稿 / 全部条目。
 *
 * 为什么做成一张表：三段的开关逻辑一模一样，只有 id、localStorage 键和「默认折不折」不同。
 * 分开写三份的话，`style.display` 那道双保险漏一个就复现「按钮变了、东西还在」的老 bug
 * （改动记录那次就是这么被主播抓到的）。
 *
 * `defaultCollapsed`：改动记录默认收起（它只增不减，最长）；待审草稿和全部条目默认展开
 * ——这两块是主播日常要看的东西，一进来就收着会让人以为「我的东西没了」。
 * 想改默认值只动这里。
 */
const COLLAPSE_SECTIONS = {
  edits: { body: 'editsBody', toggle: 'editsToggle', key: EDITS_COLLAPSED_KEY, defaultCollapsed: true },
  pending: { body: 'pendingBody', toggle: 'pendingToggle', key: 'bili-ai-copilot.pendingCollapsed', defaultCollapsed: false },
  entries: { body: 'entriesBody', toggle: 'entriesToggle', key: 'bili-ai-copilot.entriesCollapsed', defaultCollapsed: false }
};

function readCollapsed(name) {
  const section = COLLAPSE_SECTIONS[name];
  if (!section) return false;
  try {
    const saved = window.localStorage && window.localStorage.getItem(section.key);
    return saved === null || saved === undefined ? section.defaultCollapsed : saved === '1';
  } catch (_) {
    return section.defaultCollapsed; // 读不到就用默认值，不影响功能
  }
}

/** 收起 / 展开某一段（`collapsed` 不给就切换）；返回收起后的状态 */
function setCollapsed(name, collapsed) {
  const section = COLLAPSE_SECTIONS[name];
  if (!section) return false;
  const body = knowledgeEl(section.body);
  const toggle = knowledgeEl(section.toggle);
  if (!body) return false;
  const next = typeof collapsed === 'boolean' ? collapsed : !body.hidden;
  // 「是不是用户点的」：初始化时也会调这个函数（带 boolean），那时候不该顺手重读一遍，
  // 否则每次打开面板都多刷两次知识库。只有用户点「展开」才补一次刷新。
  const byToggle = typeof collapsed !== 'boolean';
  body.hidden = next;
  // ⚠️ 光设 `hidden` 属性不够：`.form { display:flex }` 的优先级比浏览器默认的
  // `[hidden]{display:none}` 高，于是「按钮已经变『展开』了，内容还摆在那儿」——
  // 主播就是这么报上来的。这里再显式写一次 inline display，等于加了双保险
  // （CSS 里另有 `[hidden]{display:none !important}` 兜底，两处一起才彻底）。
  body.style.display = next ? 'none' : '';
  if (toggle) toggle.textContent = next ? '展开' : '收起';
  try {
    if (window.localStorage) window.localStorage.setItem(section.key, next ? '1' : '0');
  } catch (_) {
    /* 存不了就算了，下次回到默认 */
  }
  // 用户点「展开」时顺手重读一次：收起期间她可能又改过库 / 又冒出新的待审草稿
  if (!next && byToggle) {
    if (name === 'edits') renderEditsList();
    else void renderKnowledge();
  }
  return next;
}

/** 兼容老调用点：改动记录那段以前是单独的 readEditsCollapsed / setEditsCollapsed */
function readEditsCollapsed() {
  return readCollapsed('edits');
}

function setEditsCollapsed(collapsed) {
  return setCollapsed('edits', collapsed);
}

function renderEdits(payload) {
  const box = knowledgeEl('editsList');
  const hint = knowledgeEl('editsHint');
  const summary = knowledgeEl('editsSummary');
  if (!box) return;
  box.innerHTML = '';
  const edits = (payload && Array.isArray(payload.edits) ? payload.edits : []).slice(0, 30);
  const pending = edits.filter((edit) => !edit.undone).length;
  // 标题旁边那一行摘要：折叠着也看得见「有几条、能不能撤」
  if (summary) {
    summary.textContent = edits.length
      ? `最近 ${edits.length} 次改动${pending < edits.length ? `（${edits.length - pending} 条已撤销）` : ''}`
      : '还没有改动记录';
  }
  if (hint) {
    hint.textContent = edits.length
      ? `最近 ${edits.length} 次改动。备份都在「知识库\\.history\\」里，撤销不动别的改动。`
      : '还没有改动记录。她自己改库、你手动编辑、删条目都会在这里留一条。';
  }
  if (!edits.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '没有改动记录。';
    box.appendChild(empty);
    return;
  }
  for (const edit of edits) {
    const row = document.createElement('div');
    row.className = 'knowledge-row';

    const head = document.createElement('div');
    head.className = 'knowledge-row-head';
    const title = document.createElement('b');
    title.textContent = `${EDIT_KIND_LABEL[edit.kind] || edit.kind}：${edit.title || edit.noteId}`;
    head.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'hint';
    const size = edit.kind === 'create'
      ? `${edit.afterChars || edit.chars || 0} 字`
      : edit.kind === 'remove'
        ? `删掉时有 ${edit.chars || 0} 字`
        : `${edit.chars || 0} → ${edit.afterChars || edit.chars || 0} 字`;
    meta.textContent = ` ${size}${edit.reason ? ` · ${edit.reason}` : ''} · ${timeText(edit.savedAt)}${edit.undone ? ' · 已撤销' : ''}`;
    head.appendChild(meta);
    row.appendChild(head);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const undo = document.createElement('button');
    undo.className = 'btn tiny';
    undo.textContent = edit.undone ? '已撤销' : edit.kind === 'create' ? '撤销（删掉这条）' : '撤销这次改动';
    undo.disabled = Boolean(edit.undone);
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        const result = await window.api.knowledge.undoEdit(edit.id);
        if (result && result.ok) {
          toast(
            edit.kind === 'create' ? `已经把「${edit.title}」删掉了` : `已经把「${edit.title}」恢复成改动前的样子`,
            'ok',
            9000
          );
        } else {
          toast(`撤销失败：${(result && result.reason) || '看日志'}`, 'err', 9000);
        }
        renderEdits(result);
        await renderKnowledge();
      } catch (error) {
        toast(`撤销失败：${error.message}`, 'err', 9000);
      }
    });
    actions.appendChild(undo);
    row.appendChild(actions);
    box.appendChild(row);
  }
}

async function renderEditsList() {
  try {
    const data = await window.api.knowledge.edits();
    renderEdits(data);
  } catch (error) {
    const hint = knowledgeEl('editsHint');
    if (hint) hint.textContent = `改动记录读不出来：${error.message}`;
  }
}

function renderPending(drafts) {
  const box = knowledgeEl('pendingList');
  const hint = knowledgeEl('pendingHint');
  if (!box) return;
  box.innerHTML = '';
  const list = Array.isArray(drafts) ? drafts : [];
  if (hint) {
    hint.textContent = list.length
      ? `${list.length} 条等着你拍板。通过 = 写进知识库；丢弃 = 删掉草稿（顶上能一次全过或全清）。`
      : '整理出来的内容先出现在这里，点「通过」才真正进知识库。';
  }
  // 没有草稿时两个批量按钮要灰着：点下去没反应比灰着更让人困惑
  for (const id of ['pendingApproveAll', 'pendingClear']) {
    const btn = knowledgeEl(id);
    if (btn) btn.disabled = list.length === 0;
  }
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '没有待审草稿。';
    box.appendChild(empty);
    return;
  }
  for (const draft of list) {
    const row = document.createElement('div');
    row.className = 'knowledge-row';

    const head = document.createElement('div');
    head.className = 'knowledge-row-head';
    const title = document.createElement('b');
    title.textContent = draft.title;
    head.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'hint';
    meta.textContent = ` ${draft.engine ? `[${draft.engine}]` : ''}${draft.source || ''}`;
    head.appendChild(meta);
    row.appendChild(head);

    const body = document.createElement('div');
    body.className = 'knowledge-row-body';
    const text = String(draft.content || '');
    body.textContent = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    row.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn tiny primary';
    okBtn.textContent = '通过';
    okBtn.addEventListener('click', async () => {
      await window.api.knowledge.approve(draft.id);
      await renderKnowledge();
      toast(`已收进知识库：${draft.title}`, 'ok');
    });
    actions.appendChild(okBtn);

    const noBtn = document.createElement('button');
    noBtn.className = 'btn tiny';
    noBtn.textContent = '丢弃';
    noBtn.addEventListener('click', async () => {
      await window.api.knowledge.reject(draft.id);
      await renderKnowledge();
      toast('已丢弃这条草稿', 'ok');
    });
    actions.appendChild(noBtn);
    row.appendChild(actions);

    box.appendChild(row);
  }
}

async function runDshTask() {
  const task = String(knowledgeEl('dshTask')?.value || '').trim();
  if (!task) {
    toast('先写清楚要让 DSH 做什么', 'warn');
    return;
  }
  if (!dshState.ok) {
    toast('环境还没检测通过，先点「检测环境」', 'warn');
    return;
  }
  // 第一次跑之前先把「工作区被限定在知识库」说清楚（只说一次，确认了才继续）
  if (!(await ensureDshWorkspaceNotice())) return;
  dshState.running = true;
  const runBtn = knowledgeEl('dshRun');
  const cancelBtn = knowledgeEl('dshCancel');
  const out = knowledgeEl('dshOutput');
  const line = knowledgeEl('dshStatusLine');
  if (runBtn) runBtn.disabled = true;
  if (cancelBtn) cancelBtn.hidden = false;
  if (out) {
    out.hidden = false;
    out.textContent = 'DSH 正在跑…（实测最简任务约 50 秒，整理任务更久。它在自己的进程里干活，直播不受影响）';
  }
  if (line) line.textContent = '任务进行中…';
  try {
    const result = await window.api.dsh.run({ task });
    // 它想动知识库外面的东西时我们一律拒绝（见 dsh-acp.js）——要让用户知道，
    // 否则会看到「它说做不了」却不知道为什么
    const deniedNote = result && result.denied
      ? `\n\n⚠️ 有 ${result.denied} 次「知识库文件夹以外的操作」被拒绝了：DSH 的工作区被限定在知识库里，越界的读写会被它自己的沙箱拒掉。`
      : '';
    if (out) {
      out.textContent = result.ok
        ? `跑完了（${Math.round(result.ms / 1000)} 秒）：\n${String(result.output || '').slice(0, 4000)}${deniedNote}`
        : `没跑成：${result.message}\n\n${String(result.output || result.stderr || '').slice(0, 2000)}${deniedNote}`;
    }
    if (line) line.textContent = result.ok ? `上一次任务成功（${Math.round(result.ms / 1000)} 秒）` : `上一次任务失败：${result.message || ''}`;
    if (!result.ok && /环境没配好/.test(String(result.message || ''))) {
      dshState.ok = false;
      renderDshChecks(await window.api.dsh.detect());
    }
    if (result.ok) {
      const count = Array.isArray(result.drafts) ? result.drafts.length : 0;
      await renderKnowledge();
      const sessionName = ((state.settings || {}).knowledge || {}).dshSessionName || '直播知识整理';
      const where = result.mode === 'session' ? `（跑在会话「${sessionName}」里，能在 DSH Web 打开看过程）` : '';
      toast(
        count
          ? `DSH 跑完了，整理出 ${count} 条草稿，去「待审草稿」里点通过${where}`
          : `DSH 跑完了，但没解析出条目——输出在下面，可以自己复制到「添加条目」里${where}`,
        count ? 'ok' : 'warn',
        12000
      );
    } else {
      toast(`DSH 任务失败：${result.message || '看输出'}`.slice(0, 300), 'err', 12000);
    }
  } catch (error) {
    if (out) out.textContent = `调用失败：${error.message}`;
  } finally {
    dshState.running = false;
    if (cancelBtn) cancelBtn.hidden = true;
    const run = knowledgeEl('dshRun');
    if (run) run.disabled = !dshState.ok;
  }
}

function wireDsh() {
  const detect = knowledgeEl('dshDetect');
  if (detect) detect.addEventListener('click', () => detectDsh({ deep: false }));
  const deep = knowledgeEl('dshDeepDetect');
  if (deep) deep.addEventListener('click', () => detectDsh({ deep: true }));
  // 打开工作区：和知识库那个「打开文件夹」是同一个目录（就是知识库根目录）
  const openWorkspace = knowledgeEl('dshOpenWorkspace');
  if (openWorkspace) {
    openWorkspace.addEventListener('click', async () => {
      const dir = await window.api.knowledge.openFolder();
      setDshWorkspace(dir);
      toast(`工作区（知识库）已打开：${dir || dshWorkspace}`, 'ok', 8000);
    });
  }
  const run = knowledgeEl('dshRun');
  if (run) run.addEventListener('click', runDshTask);
  const cancel = knowledgeEl('dshCancel');
  if (cancel) {
    cancel.addEventListener('click', async () => {
      const result = await window.api.dsh.cancel();
      toast(
        result && result.cancelled
          ? '已请求中止：这一轮会停下来，会话留着（可以直接再发一条接着干）。⚠️ 如果它当时正在联网/读文件，那个调用会在会话里留一条「结果未知」的告警——这是 DSH 的自我保护，去 Web 里发一句「继续」它会接着做（只读操作重试是安全的）'
          : '没在跑任务，已把 DSH 进程收掉（下次会自动重起）',
        'warn',
        12000
      );
    });
  }
  // 跑法：会话模式 / 一次性
  for (const id of ['dshModeSession', 'dshModeHeadless']) {
    const node = knowledgeEl(id);
    if (!node) continue;
    node.addEventListener('change', async () => {
      if (!node.checked) return;
      state.settings = await window.api.settings.update({ knowledge: { dshMode: node.value } });
      renderDshSessionHint();
      toast(node.value === 'session' ? '会话模式：结果会落进指定会话，能在 DSH Web 里看' : '一次性模式：跑完就退，过程看不到', 'ok');
    });
  }
  // 路径 / 会话名改了先作废上一次检测结果——不然会出现「填了新路径但按钮还是禁着/还亮着」的错觉
  for (const id of ['dshNode', 'dshCommand']) {
    const node = knowledgeEl(id);
    if (!node) continue;
    node.addEventListener('input', () => {
      if (!dshState.checked) return;
      dshState.ok = false;
      renderDshChecks(null);
      const line = knowledgeEl('dshStatusLine');
      if (line) line.textContent = '路径改了，重新点一次「检测环境」。';
    });
  }
  const sessionName = knowledgeEl('dshSessionName');
  if (sessionName) {
    sessionName.addEventListener('input', () => {
      clearTimeout(sessionName._saveTimer);
      sessionName._saveTimer = setTimeout(async () => {
        state.settings = await window.api.settings.update({
          knowledge: { dshSessionName: sessionName.value.trim() }
        });
        renderDshSessionHint();
      }, 500);
    });
  }
  renderDshRunMode();
  renderDshSessionHint();
  renderDshWorkspace();
}

/** 画「怎么跑」的单选（配置里的 dshMode） */
function renderDshRunMode() {
  const mode = ((state.settings || {}).knowledge || {}).dshMode === 'headless' ? 'headless' : 'session';
  const session = knowledgeEl('dshModeSession');
  const headless = knowledgeEl('dshModeHeadless');
  if (session) session.checked = mode === 'session';
  if (headless) headless.checked = mode === 'headless';
}

/**
 * 会话名下面那行小字：说明「名字」和「会话」的关系。
 *
 * ACP 的会话 id 是 DSH 自己生成的（uuid），不跟着名字走，所以这里要讲清三件事：
 *   · 名字是软件这边的标注，会作为新会话第一句话的开头（DSH 用它生成会话标题）；
 *   · 软件会**记住并续用**同一个会话（重启也接着用），续不上才新建；
 *   · 想知道到底在用哪个会话，看这行给出的 id，去 DSH Web 里对上。
 */
function renderDshSessionHint() {
  const hint = knowledgeEl('dshSessionHint');
  if (!hint) return;
  const knowledge = (state.settings || {}).knowledge || {};
  const name = String(knowledge.dshSessionName || '').trim() || '直播知识整理';
  const mode = knowledge.dshMode === 'headless' ? 'headless' : 'session';
  if (mode === 'headless') {
    hint.textContent = '现在是一次性模式：会话名用不上，跑完只留下结果。';
    return;
  }
  const id = String(knowledge.dshSessionId || '').trim();
  const where = id ? `当前会话：${id}` : '还没建会话（第一次点「开始整理」时建，之后一直用它）';
  // ⚠️ 这条不是啰嗦：DSH 只在**启动时**读一次工作区登记表（会话存储没有文件监听，
  // 只有 settings/credentials/skills 是热加载的），所以正在开着的 DSH Web 看不到新登记；
  // 另外被「归档」的会话在 Web 里哪儿都不显示，软件登记时会顺手放开。
  // 因为软件固定复用一个会话，这些都是一次性的事。
  const reload =
    '（会话会登记进「知识库」工作区、被归档过也会自动放开；如果你此刻正开着 DSH Web，' +
    '得重启一次它才看得到——DSH 只在启动时读工作区列表）';
  hint.textContent = `「${name}」会作为新会话第一句话的开头（DSH 拿它生成会话标题，你在 Web 里好认）。${where}${reload}`;
}

// ------------------------------------------------------------ 悬浮窗开关

/** 同步顶部「显示/隐藏悬浮窗」按钮的文案 */
async function refreshOverlayButton() {
  try {
    const visible = await window.api.overlay.isVisible();
    const top = $('toggleOverlayTop');
    if (top) top.textContent = visible ? '隐藏悬浮窗' : '显示悬浮窗';
    const inner = $('toggleOverlayVisible');
    if (inner) inner.textContent = visible ? '隐藏悬浮窗' : '显示悬浮窗';
  } catch (_) {
    /* ignore */
  }
}

async function toggleOverlayFromPanel() {
  const visible = await window.api.overlay.toggle();
  await refreshOverlayButton();
  toast(visible ? '悬浮窗已显示' : '悬浮窗已隐藏', 'ok');
}

// ------------------------------------------------------------ 语音朗读

function initSpeechPanel() {
  // 引擎选择 / 云音色这两块和「系统语音能不能用」无关，所以放在最前面初始化。
  // （以前这段写在系统语音的提前 return 之后，环境里没有 speechSynthesis 时整块都不会执行）
  bindSpeechEngine();

  const status = $('speechStatus');
  const select = $('speechVoice');
  const synth = window.speechSynthesis;
  if (!synth || !window.SpeechSynthesisUtterance) {
    if (status) status.textContent = '当前环境不支持系统语音，语音朗读不可用（其余功能不受影响）。';
    if (select) select.disabled = true;
    $('speechTest').disabled = true;
    return;
  }

  const fill = () => {
    const voices = Array.from(synth.getVoices() || []);
    if (!voices.length) {
      if (status) status.textContent = '正在等待系统语音列表…';
      return;
    }
    const current = (state.settings && state.settings.speech && state.settings.speech.voiceURI) || '';
    select.innerHTML = '';
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = '自动（优先中文语音）';
    select.appendChild(auto);
    // 中文语音排在前面，方便找
    const isChinese = (voice) => /zh|chinese|中文|普通话/i.test(`${voice.lang || ''} ${voice.name || ''}`);
    const sorted = voices.slice().sort((a, b) => Number(isChinese(b)) - Number(isChinese(a)));
    for (const voice of sorted) {
      const option = document.createElement('option');
      option.value = voice.voiceURI || voice.name;
      option.textContent = `${voice.name}${voice.lang ? `（${voice.lang}）` : ''}`;
      select.appendChild(option);
    }
    select.value = current;
    const chineseCount = voices.filter(isChinese).length;
    if (status) {
      status.textContent = `检测到 ${voices.length} 个语音${chineseCount ? `（其中中文 ${chineseCount} 个）` : ''}${
        chineseCount ? '' : '，未发现中文语音，可能需要在 Windows 设置里添加中文语音包'
      }。`;
    }
  };

  fill();
  // 和悬浮窗一样：首次可能拿不到列表，要等这个事件
  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', fill);
  } else {
    setTimeout(fill, 800);
  }

  select.addEventListener('change', () => {
    window.api.settings.update({ speech: { voiceURI: select.value } });
    toast(select.value ? '已切换语音，点「试听一句」确认' : '已设为自动选择语音', 'ok');
  });

  $('speechTest').addEventListener('click', () => {
    // 走悬浮窗发声：那边是真正在念回复的地方，试听它才有意义
    // （控制面板是另一个渲染进程，speechSynthesis 各有一份）
    speakInPanel('你好呀，我是你的直播搭档，这是试听效果。');
  });
}

/**
 * 引擎选择 + 云音色配置的接线。
 * 单独拆出来是因为它不依赖系统语音：就算环境里没有 speechSynthesis，
 * 云端音色照样该能配、能试听。
 */
function bindSpeechEngine() {
  // ---- 引擎选择：系统语音 / 云音色 ----
  // 画法在 renderSpeechEngine()（writeControls 也会调它，见那边的说明）
  for (const id of ['speechEngineSystem', 'speechEngineCloud']) {
    const node = $(id);
    if (!node) continue;
    node.addEventListener('change', async () => {
      if (!node.checked) return;
      state.settings = await window.api.settings.update({ speech: { engine: node.value } });
      renderSpeechEngine();
      toast(node.value === 'cloud' ? '已切换到云音色（失败会按设置退回系统语音）' : '已切换到系统语音', 'ok');
    });
  }
  const fallbackNode = $('speechFallback');
  if (fallbackNode) {
    fallbackNode.addEventListener('change', async () => {
      state.settings = await window.api.settings.update({
        speech: { fallbackToSystem: fallbackNode.checked }
      });
      toast(fallbackNode.checked ? '云端失败时会退回系统语音' : '云端失败时不会出声', 'ok');
    });
  }
  renderSpeechEngine();

  // ---- 云音色 ----
  // 模型清单和音色清单都从主进程拿（那份是唯一真相，改一处就行）。
  // 拿回来之后之前填的下拉要重画，所以刷完立刻把两个下拉都重画。
  const loadModels = async () => {
    try {
      const status = await window.api.tts.status();
      if (Array.isArray(status.models) && status.models.length) state.ttsModels = status.models;
    } catch (_) {
      /* 拿不到就退化成「右边手填音色 ID」，不影响系统语音 */
    }
    fillModelOptions();
    fillVoiceOptions();
  };

  const renderTts = async () => {
    try {
      const status = await window.api.tts.status();
      const info = $('ttsCacheInfo');
      if (info) {
        info.textContent = status.available
          ? `云端可用 · ${status.modelLabel || status.model} · 音色 ${status.voice} · 已缓存 ${status.cached} 条（命中 ${status.hits} 次）`
          : '还没填 API Key，云音色暂时不可用（系统语音不受影响）';
      }
      const hint = $('ttsStatus');
      if (hint) {
        hint.textContent = status.available
          ? `云端语音已就绪：${status.modelLabel || status.model} / ${status.voice}`
          : '云端语音没配好（缺 API Key）——选「云音色」时会自动退回系统语音';
      }
    } catch (error) {
      const info = $('ttsCacheInfo');
      if (info) info.textContent = `读取云端语音状态失败：${error.message}`;
    }
  };
  renderTts();
  loadModels();

  // 模型 / 音色两个下拉的选项都是动态的（主进程给），所以不进绑定表，自己接线
  const modelSelect = $('ttsModel');
  if (modelSelect) {
    modelSelect.addEventListener('change', async () => {
      const value = modelSelect.value;
      if (!value) return;
      const model = (state.ttsModels || []).find((item) => item.id === value);
      const cloud = ((state.settings || {}).speech || {}).cloud || {};
      const oldVoice = cloud.voice || '';
      const usable = Boolean(model) && model.voices.some((item) => item.voice === oldVoice);
      const patch = { model: value };
      // ⚠️ 音色不能跨模型混用，不换音色下一秒就是 `Invalid voice specified`。
      // 老音色在新模型上不认（含「原来是自己复刻的音色」这种情况）→ 换成新模型的默认音色。
      if (!usable) patch.voice = (model && model.defaultVoice) || (model && model.voices[0] && model.voices[0].voice) || '';
      state.settings = await window.api.settings.update({ speech: { cloud: patch } });
      const custom = $('ttsVoiceCustom');
      if (custom) custom.value = '';
      fillModelOptions();
      fillVoiceOptions();
      renderTts();
      toast(
        usable
          ? `模型已切到 ${model ? model.label : value}，音色不用换`
          : `模型已切到 ${model ? model.label : value}，音色也换成了 ${patch.voice}（原来的「${oldVoice}」这个模型不认）`,
        'ok',
        8000
      );
    });
  }

  const voiceSelect = $('ttsVoice');
  if (voiceSelect) {
    voiceSelect.addEventListener('change', async () => {
      const value = voiceSelect.value;
      if (!value) return;
      state.settings = await window.api.settings.update({ speech: { cloud: { voice: value } } });
      const custom = $('ttsVoiceCustom');
      if (custom) custom.value = ''; // 选了内置音色，自定义 ID 就让位
      fillVoiceOptions();
      renderTts();
      toast(`音色已切到 ${value}，点「试听」听一下`, 'ok');
    });
  }
  const voiceCustom = $('ttsVoiceCustom');
  if (voiceCustom) {
    // 自定义音色 ID（以后自己设计 / 复刻出来的）优先级最高：填了就覆盖下拉的选择
    voiceCustom.addEventListener('input', () => {
      clearTimeout(voiceCustom._saveTimer);
      voiceCustom._saveTimer = setTimeout(async () => {
        const text = voiceCustom.value.trim();
        if (!text) return; // 清空当成「不改」，免得误删配置
        state.settings = await window.api.settings.update({ speech: { cloud: { voice: text } } });
        fillVoiceOptions();
        renderTts();
        toast(`音色已改成自定义 ID「${text}」`, 'ok');
      }, 500);
    });
  }

  const ttsKey = $('ttsApiKey');
  if (ttsKey) {
    // 密码框用 input 事件防抖保存（绑定表里那条管回填，这里管写入）
    ttsKey.addEventListener('input', () => {
      clearTimeout(ttsKey._saveTimer);
      ttsKey._saveTimer = setTimeout(async () => {
        state.settings = await window.api.settings.update({ speech: { cloud: { apiKey: ttsKey.value.trim() } } });
        renderTts();
      }, 500);
    });
  }
  const toggleTts = $('toggleTtsKey');
  if (toggleTts && ttsKey) {
    toggleTts.addEventListener('click', () => {
      const show = ttsKey.type === 'password';
      ttsKey.type = show ? 'text' : 'password';
      toggleTts.textContent = show ? '隐藏' : '显示';
    });
  }
  for (const id of ['ttsModel', 'ttsBaseUrl']) {
    const node = $(id);
    if (!node) continue;
    node.addEventListener('change', async () => {
      // 值由绑定表按路径回填；这里只负责在改完后刷新状态行
      renderTts();
      toast('已保存云音色设置', 'ok');
    });
  }
  const ttsTest = $('ttsTest');
  if (ttsTest) {
    ttsTest.addEventListener('click', async () => {
      ttsTest.disabled = true;
      ttsTest.textContent = '正在合成…';
      try {
        const result = await window.api.tts.synthesize('你好呀，我是你的直播搭档，这就是云音色的效果。');
        if (!result.ok) {
          toast(`云端语音失败：${result.message}`, 'err', 9000);
          return;
        }
        const audio = new Audio(`data:${result.mime || 'audio/wav'};base64,${result.audio}`);
        await audio.play();
        toast(result.cached ? '试听中（这次用的是缓存）' : '试听中', 'ok');
      } catch (error) {
        toast(`试听失败：${error.message}`, 'err', 9000);
      } finally {
        ttsTest.disabled = false;
        ttsTest.textContent = '用云音色试听一句';
        renderTts();
      }
    });
  }
  const ttsClear = $('ttsClearCache');
  if (ttsClear) {
    ttsClear.addEventListener('click', async () => {
      await window.api.tts.clearCache();
      await renderTts();
      toast('语音缓存已清空（下次会重新合成）', 'ok');
    });
  }
}

function speakInPanel(text) {
  const synth = window.speechSynthesis;
  if (!synth) return;
  const settings = (state.settings && state.settings.speech) || {};
  try {
    synth.cancel();
    const utterance = new window.SpeechSynthesisUtterance(text);
    const voices = Array.from(synth.getVoices() || []);
    const wanted = settings.voiceURI;
    let voice = wanted ? voices.find((item) => item.voiceURI === wanted || item.name === wanted) : null;
    if (!voice) {
      voice = voices.find((item) => /zh|chinese|中文|普通话/i.test(`${item.lang || ''} ${item.name || ''}`)) || voices[0];
    }
    if (voice) utterance.voice = voice;
    utterance.rate = Math.min(2, Math.max(0.5, Number(settings.rate) || 1));
    utterance.pitch = Math.min(2, Math.max(0, Number(settings.pitch) || 1));
    utterance.volume = Math.min(1, Math.max(0, settings.volume === undefined ? 1 : Number(settings.volume)));
    synth.speak(utterance);
  } catch (error) {
    toast(`试听失败：${error.message}`, 'err');
  }
}

// ------------------------------------------------------------ 用量统计

function renderUsage(summary) {
  if (!summary) return;
  state.usage = summary;
  const set = (id, text) => {
    const node = $(id);
    if (node) node.textContent = text;
  };
  set('usageTodayCalls', String(summary.today.calls));
  set('usageTodayTokens', `${summary.today.tokensText} tokens`);
  set('usageTodayCost', `￥${summary.today.costText}`);
  set('usageTotalCost', `￥${summary.total.costText}`);
  set('usageTotalDays', `${summary.total.days} 天 · ${summary.total.tokensText} tokens`);
  set('usageSessionCalls', `${summary.session.calls} 次`);
  set('usageSessionCost', `￥${summary.session.costText}${summary.session.failed ? ` · 失败 ${summary.session.failed}` : ''}`);
}

function wireUsage() {
  $('resetUsageToday').addEventListener('click', async () => {
    if (!await confirmDialog('清空今日用量统计？')) return;
    renderUsage(await window.api.usage.reset('today'));
    toast('已清空今日统计', 'ok');
  });
  $('resetUsageAll').addEventListener('click', async () => {
    if (!await confirmDialog('清空全部用量统计（含历史）？')) return;
    renderUsage(await window.api.usage.reset('all'));
    toast('已清空全部统计', 'ok');
  });
  $('exportHistory').addEventListener('click', async () => {
    const result = await window.api.copilot.exportHistory();
    if (result && result.ok) toast(`已导出到 ${result.file}`, 'ok', 7000);
    else toast((result && result.message) || '导出失败', 'warn');
  });
}

// ------------------------------------------------------------ 账号登录

function renderAccount(status) {
  if (!status) return;
  state.account = status;
  const avatar = $('accountAvatar');
  const name = $('accountName');
  const sub = $('accountSub');
  $('biliLogoutBtn').disabled = !status.loggedIn;
  $('biliVerifyBtn').disabled = !status.loggedIn;

  if (status.loggedIn) {
    if (status.avatar) {
      avatar.textContent = '';
      avatar.style.backgroundImage = `url("${status.avatar}")`;
      avatar.classList.add('has-image');
    } else {
      avatar.style.backgroundImage = '';
      avatar.classList.remove('has-image');
      avatar.textContent = '👤';
    }
    name.textContent = status.userName || '已登录';
    const when = status.loginAt ? new Date(status.loginAt).toLocaleString('zh-CN') : '';
    sub.textContent = `uid ${status.userUid || '未知'}${when ? ` · 登录于 ${when}` : ''} · 弹幕里可以看到观众真实昵称`;
    $('biliLoginBtn').textContent = '重新登录';
  } else {    avatar.style.backgroundImage = '';
    avatar.classList.remove('has-image');
    avatar.textContent = '👤';
    name.textContent = '未登录';
    sub.textContent = '未登录时 B 站会隐藏观众昵称（显示为 ***），弹幕内容本身不受影响。';
    $('biliLoginBtn').textContent = '登录 B 站账号';
  }
}

function wireAccount() {
  $('biliLoginBtn').addEventListener('click', async () => {
    toast('已打开 B 站登录窗口，请在新窗口里扫码或登录', 'ok', 6000);
    const status = await window.api.bili.login();
    renderAccount(status);
  });

  $('biliLogoutBtn').addEventListener('click', async () => {
    if (!await confirmDialog('退出登录会清除已保存的 Cookie，确定吗？')) return;
    const status = await window.api.bili.logout();
    renderAccount(status);
    toast('已退出登录', 'ok');
  });

  $('biliVerifyBtn').addEventListener('click', async () => {
    const result = await window.api.bili.verify();
    if (result.ok) {
      toast(`登录有效：${result.userName}（uid ${result.userUid}）`, 'ok');
      renderAccount({ ...state.account, loggedIn: true, userName: result.userName, userUid: result.userUid });
    } else {
      toast(`登录已失效或校验失败：${result.message}`, 'err', 7000);
    }
  });

  $('verifyManualCookie').addEventListener('click', async () => {
    const out = $('manualCookieResult');
    out.className = 'test-result';
    out.textContent = '正在校验…';
    await flushSave();
    const result = await window.api.bili.verifyManual($('sessdata').value);
    if (result.ok) {
      out.className = 'test-result ok';
      out.textContent = `✅ Cookie 有效：${result.userName}（uid ${result.userUid}）`;
    } else {
      out.className = 'test-result err';
      out.textContent = `❌ ${result.message}`;
    }
  });

  $('applyManualCookie').addEventListener('click', async () => {
    await flushSave();
    state.settings = await window.api.settings.update({ danmaku: { useCookie: true } });
    const status = await window.api.copilot.status();
    if (status.danmaku && status.danmaku.running) {
      await window.api.danmaku.stop();
      await window.api.danmaku.start();
      toast('已用这段 Cookie 重新连接弹幕', 'ok');
    } else {
      toast('已保存，点「开始监听弹幕」时就会带上这段 Cookie', 'ok');
    }
  });
}

// ------------------------------------------------------------ 弹幕流

function addFeedItem(payload) {
  const { kind, event, filtered, reason } = payload;
  state.feed.push(payload);
  while (state.feed.length > 300) state.feed.shift();
  if (state.feedOnlyReply && (filtered || kind !== 'danmaku')) return;

  const list = $('danmakuFeed');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();

  const node = document.createElement('div');
  node.className = `dm kind-${kind}${filtered ? ' filtered' : ''}`;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = event.user || '观众';
  const txt = document.createElement('span');
  txt.className = 'txt';
  // 现在只有观众弹幕进这一栏（礼物 / 上舰 / 进场 2026-10-21 删了：这条连接收不到）
  txt.textContent = event.text;

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = timeText(event.ts);

  node.append(who, txt, meta);
  // 弹幕 id / uid 单独挂一行小字：出问题时可以和弹幕记录文件逐条对照
  if (kind === 'danmaku' && (event.id || event.uid !== undefined)) {
    const tag = document.createElement('span');
    tag.className = 'dm-tag';
    const bits = [];
    if (event.id) bits.push(`id ${event.id}`);
    if (event.uid !== undefined && event.uid !== null) bits.push(`uid ${event.uid}`);
    tag.textContent = bits.join(' · ');
    node.appendChild(tag);
  }
  if (filtered && reason) {
    const why = document.createElement('span');
    why.className = 'reason';
    why.textContent = `已忽略：${reason}`;
    node.appendChild(why);
  }
  list.appendChild(node);
  while (list.childElementCount > 200) list.removeChild(list.firstElementChild);
  list.scrollTop = list.scrollHeight;
}

function addReplyItem(reply) {
  const list = $('replyFeed');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const node = document.createElement('div');
  node.className = 'reply-item';
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent =
    reply.source === 'operator'
      ? '回应你的话'
      : reply.source === 'test'
        ? '测试回复'
        : String(reply.source || '').startsWith('research-')
          ? '待办提醒（她主动问你的）'
          : '回应弹幕';
  const meta = document.createElement('span');
  meta.className = 'meta';
  // 每条回复后面带上这次调用的消耗：输入 + 输出（思考单独标出来），
  // 这样主播能一眼看出「思考档位调高之后多花了多少」。
  const tokens = reply.tokens || null;
  const tokenText = tokens
    ? ` · ${tokens.prompt} + ${tokens.completion} tokens${tokens.reasoning ? `（思考 ${tokens.reasoning}）` : ''}`
    : '';
  meta.textContent = `${timeText(reply.ts)}${reply.latencyMs ? ` · ${reply.latencyMs}ms` : ''}${tokenText}`;
  who.appendChild(meta);
  const text = document.createElement('div');
  text.textContent = reply.text;
  node.append(who, text);
  list.appendChild(node);
  while (list.childElementCount > 120) list.removeChild(list.firstElementChild);
  list.scrollTop = list.scrollHeight;
}

function renderFeed() {
  const list = $('danmakuFeed');
  list.innerHTML = '';
  for (const payload of state.feed) {
    if (state.feedOnlyReply && (payload.filtered || payload.kind !== 'danmaku')) continue;
    addFeedItem(payload);
  }
}

// ------------------------------------------------------------ 吉祥物

function renderMascot() {
  const images = state.settings.mascot.images || {};
  const names = Object.keys(images);
  const grid = $('imageGrid');
  grid.innerHTML = '';

  if (!names.length) {
    const empty = document.createElement('div');
    empty.className = 'mascot-empty';
    empty.textContent = '还没有图片。点右上角「上传图片」选择几张（建议默认/开心/思考各一张）。';
    grid.appendChild(empty);
  }

  for (const name of names) {
    const tile = document.createElement('div');
    tile.className = 'mascot-tile';
    const img = document.createElement('img');
    img.src = images[name];
    img.alt = name;
    const label = document.createElement('div');
    label.className = 'tile-name';
    label.textContent = shortName(name);
    const actions = document.createElement('div');
    actions.className = 'tile-actions';

    const renameBtn = document.createElement('button');
    renameBtn.textContent = '重命名';
    renameBtn.addEventListener('click', async () => {
      const next = await promptDialog('给这张图起个名字（用于自动匹配表情）', shortName(name));
      if (!next || next === name) return;
      await renameImage(name, next.trim());
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', async () => {
      if (!await confirmDialog(`确定删除「${shortName(name)}」吗？`)) return;
      const nextImages = { ...state.settings.mascot.images };
      delete nextImages[name];
      const nextExpressions = { ...state.settings.mascot.expressions };
      for (const [emotion, target] of Object.entries(nextExpressions)) {
        if (target === name) nextExpressions[emotion] = '';
      }
      state.settings = await window.api.settings.update({
        mascot: { images: nextImages, expressions: nextExpressions }
      });
      renderMascot();
    });

    actions.append(renameBtn, deleteBtn);
    tile.append(img, label, actions);
    grid.appendChild(tile);
  }

  renderExpressions();
}

async function renameImage(oldName, newName) {
  const images = state.settings.mascot.images || {};
  const nextImages = {};
  for (const [key, value] of Object.entries(images)) {
    nextImages[key === oldName ? newName : key] = value;
  }
  const nextExpressions = { ...state.settings.mascot.expressions };
  for (const [emotion, target] of Object.entries(nextExpressions)) {
    if (target === oldName) nextExpressions[emotion] = newName;
  }
  state.settings = await window.api.settings.update({
    mascot: { images: nextImages, expressions: nextExpressions }
  });
  renderMascot();
}

function renderExpressions() {
  const images = state.settings.mascot.images || {};
  const expressions = state.settings.mascot.expressions || {};
  const names = Object.keys(images);
  const grid = $('expressionGrid');
  grid.innerHTML = '';
  const emotions = currentEmotions();
  const customList = emotions.filter((item) => item.custom);

  for (const emotion of emotions) {
    const row = document.createElement('div');
    row.className = 'expression-row';
    if (emotion.custom) row.dataset.custom = emotion.key;

    const current = expressions[emotion.key] || '';
    if (current && images[current]) {
      const img = document.createElement('img');
      img.src = images[current];
      img.alt = emotion.label;
      row.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'ph';
      placeholder.textContent = '＋';
      row.appendChild(placeholder);
    }

    const right = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'expression-name';
    // 标一下谁能触发这个状态：AI 自己会用的 / 程序自动切的 / 整活彩蛋 / 用户自定义
    const tag = emotion.custom
      ? '自定义'
      : emotion.trigger === 'auto'
        ? '程序自动'
        : emotion.trigger === 'rare'
          ? '彩蛋'
          : 'AI 会用';
    title.innerHTML = `${emotion.label}<small>${emotion.key} · ${tag}${
      emotion.alias ? ` · 别名「${emotion.alias}」` : ''
    } · ${emotion.when || '（没写什么时候用，模型自己判断）'}</small>`;

    const select = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（未指定 → 自动匹配）';
    select.appendChild(none);
    for (const name of names) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = shortName(name);
      select.appendChild(option);
    }
    select.value = current && images[current] ? current : '';
    select.addEventListener('change', async () => {
      state.settings = await window.api.settings.update({
        mascot: { expressions: { [emotion.key]: select.value } }
      });
      renderExpressions();
    });

    // 触发词：观众弹幕里出现这些词，吉祥物立刻切到这个状态（不用等 AI 回复）
    const triggers = state.settings.mascot.triggers || {};
    const own = triggers[emotion.key];
    const fallback = shared.DEFAULT_TRIGGERS[emotion.key] || [];
    const words = Array.isArray(own) ? own : fallback;
    const triggerInput = document.createElement('input');
    triggerInput.type = 'text';
    triggerInput.className = 'trigger-input';
    triggerInput.value = words.join('、');
    triggerInput.placeholder = '观众发这些词就切（用、或,分隔）';
    triggerInput.addEventListener('change', async () => {
      const next = shared.normaliseTriggers(
        {
          ...triggers,
          [emotion.key]: String(triggerInput.value || '')
            .split(/[、,，\s]+/)
            .map((word) => word.trim())
            .filter(Boolean)
        },
        state.settings.mascot.customEmotions
      );
      state.settings = await window.api.settings.update({ mascot: { triggers: next } });
      renderExpressions();
    });

    right.append(title, select, triggerInput);

    // 「什么时候用」和「别名」只有自定义表情才有（内置的由程序定义，改不了）
    if (emotion.custom) {
      const whenInput = document.createElement('input');
      whenInput.type = 'text';
      whenInput.className = 'trigger-input';
      whenInput.value = emotion.when || '';
      whenInput.placeholder = '什么时候用？会原样写进提示词（例：被怼、明显不耐烦时）';
      whenInput.maxLength = shared.MAX_CUSTOM_WHEN;
      whenInput.addEventListener('change', async () => {
        state.settings = await window.api.settings.update({
          mascot: { customEmotions: saveCustomEmotions({ when: whenInput.value }, emotion.key) }
        });
        renderExpressions();
      });

      const aliasInput = document.createElement('input');
      aliasInput.type = 'text';
      aliasInput.className = 'trigger-input';
      aliasInput.value = emotion.alias || '';
      aliasInput.placeholder = '别名（可选）：模型用这个说法也认它';
      aliasInput.maxLength = shared.MAX_CUSTOM_ALIAS;
      aliasInput.addEventListener('change', async () => {
        state.settings = await window.api.settings.update({
          mascot: { customEmotions: saveCustomEmotions({ alias: aliasInput.value }, emotion.key) }
        });
        renderExpressions();
      });

      right.append(whenInput, aliasInput);

      const del = document.createElement('button');
      del.className = 'btn tiny danger-ghost';
      del.id = `delEmotion-${emotion.key}`;
      del.textContent = '删掉这个表情';
      del.addEventListener('click', async () => {
        const ok = await openModal({
          message:
            `删掉自定义表情「${emotion.key}」？\n` +
            '它配的图、触发词会一起清掉（图片本身还留在「吉祥物图片」里，想用还能再指定）。'
        });
        if (!ok) return;
        const nextList = (state.settings.mascot.customEmotions || []).filter(
          (item) => shared.normaliseCustomEmotions([item])[0]?.key !== emotion.key
        );
        const nextExpressions = { ...expressions };
        const nextTriggers = { ...(state.settings.mascot.triggers || {}) };
        delete nextExpressions[emotion.key];
        delete nextTriggers[emotion.key];
        state.settings = await window.api.settings.update({
          mascot: { customEmotions: nextList, expressions: nextExpressions, triggers: nextTriggers }
        });
        renderExpressions();
        toast(`已删掉表情「${emotion.key}」`, 'ok');
      });
      right.appendChild(del);
    }

    row.appendChild(right);
    grid.appendChild(row);
  }

  // 底部：还能加就显示「添加」，到上限了就说清上限在哪
  const add = document.createElement('button');
  add.className = 'btn tiny';
  add.id = 'addEmotion';
  const atLimit = customList.length >= shared.MAX_CUSTOM_EMOTIONS;
  add.textContent = atLimit
    ? `自定义表情已达上限（${shared.MAX_CUSTOM_EMOTIONS} 个）`
    : `＋ 添加自定义表情（${customList.length}/${shared.MAX_CUSTOM_EMOTIONS}）`;
  add.disabled = atLimit;
  add.addEventListener('click', addCustomEmotion);
  grid.appendChild(add);
}

/**
 * 改一个自定义表情的字段（`when` / `alias`），返回**新的完整数组**（settings.update 是整体替换数组）。
 * 用 normaliseCustomEmotions 过一遍再发出去，界面永远只提交干净数据。
 */
function saveCustomEmotions(patch, key) {
  const list = (state.settings.mascot.customEmotions || []).map((item) => {
    const name = shared.normaliseCustomEmotions([item])[0];
    if (!name || name.key !== key) return item;
    return { key: name.key, when: name.when, alias: name.alias, ...patch };
  });
  return shared.normaliseCustomEmotions(list);
}

/** 「＋ 添加自定义表情」：先问名字，再让用户在那一行里填「什么时候用」和别名 */
async function addCustomEmotion() {
  const custom = (state.settings.mascot.customEmotions || []).filter(
    (item) => shared.normaliseCustomEmotions([item])[0]
  );
  if (custom.length >= shared.MAX_CUSTOM_EMOTIONS) {
    toast(`最多 ${shared.MAX_CUSTOM_EMOTIONS} 个自定义表情`, 'warn');
    return;
  }
  const name = await openModal({
    message:
      `新表情叫什么？（${shared.MIN_CUSTOM_NAME}~${shared.MAX_CUSTOM_NAME} 个字，别跟内置的 12 个重名）\n` +
      '加完在那一行里填「什么时候用」，模型才会知道该在什么时候用它。',
    defaultValue: '',
    okText: '添加'
  });
  if (name === null) return;
  const cleaned = shared.normaliseCustomEmotions([{ key: String(name) }]);
  if (!cleaned.length) {
    toast(
      `名字不合格：要 ${shared.MIN_CUSTOM_NAME}~${shared.MAX_CUSTOM_NAME} 个字，且不能跟内置状态或内置别名重名`,
      'warn',
      8000
    );
    return;
  }
  const key = cleaned[0].key;
  if (custom.some((item) => shared.normaliseCustomEmotions([item])[0].key === key)) {
    toast(`已经有「${key}」这个表情了`, 'warn');
    return;
  }
  const next = [...custom, { key, when: '', alias: '' }];
  state.settings = await window.api.settings.update({
    mascot: { customEmotions: shared.normaliseCustomEmotions(next) }
  });
  renderExpressions();
  toast(`已添加表情「${key}」：给它选张图、填上什么时候用`, 'ok', 8000);
}

async function pickImages() {
  const result = await window.api.mascot.pickImages();
  if (!result.ok) {
    toast('选择图片失败', 'err');
    return;
  }
  if (!result.added.length) {
    if (result.skipped && result.skipped.length) {
      toast(`这些图片没加上：${result.skipped.join('、')}`, 'warn', 7000);
    }
    return;
  }
  const images = { ...state.settings.mascot.images };
  const addedNames = [];
  for (const item of result.added) {
    let key = shortName(item.name) || 'mascot';
    let suffix = 2;
    while (images[key]) {
      key = `${shortName(item.name)}-${suffix}`;
      suffix += 1;
    }
    images[key] = item.dataUrl;
    addedNames.push(key);
  }
  const expressions = { ...state.settings.mascot.expressions };
  if (!Object.keys(state.settings.mascot.images || {}).length) {
    expressions.idle = addedNames[0];
  }
  state.settings = await window.api.settings.update({ mascot: { images, expressions } });
  renderMascot();
  toast(`已添加 ${addedNames.length} 张图片`, 'ok');
  if (result.skipped && result.skipped.length) {
    toast(`跳过了：${result.skipped.join('、')}`, 'warn', 7000);
  }
}

async function autoMap() {
  const images = state.settings.mascot.images || {};
  if (!Object.keys(images).length) {
    toast('还没有图片可以匹配', 'warn');
    return;
  }
  const { expressions, matched } = shared.autoMapExpressions(state.settings.mascot);
  state.settings = await window.api.settings.update({ mascot: { expressions } });
  renderExpressions();
  toast(`自动匹配了 ${matched} 个表情，可手动微调`, 'ok');
}

async function previewEmotions() {
  const images = state.settings.mascot.images || {};
  const expressions = state.settings.mascot.expressions || {};
  // 自定义表情也要能预览（用 currentEmotions()，不是内置那 12 个）
  const list = currentEmotions().filter((emotion) => expressions[emotion.key] && images[expressions[emotion.key]]);
  if (!list.length) {
    toast('先去下面指定至少一个表情', 'warn');
    return;
  }
  for (const emotion of list) {
    // eslint-disable-next-line no-await-in-loop
    await window.api.overlay.testMessage({
      text: `表情预览：${emotion.label}`,
      emotion: emotion.key
    });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

// ------------------------------------------------------------ 日志

function addLogLine(entry) {
  state.logs.push(entry);
  while (state.logs.length > 800) state.logs.shift();
  if (!logVisible(entry)) return;
  const list = $('logList');
  const node = document.createElement('div');
  node.className = `log-line ${entry.level}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = timeText(entry.ts);
  const lv = document.createElement('span');
  lv.className = 'lv';
  lv.textContent = entry.level.toUpperCase();
  const m = document.createElement('span');
  m.className = 'm';
  m.textContent = entry.message;
  node.append(t, lv, m);
  list.appendChild(node);
  while (list.childElementCount > 600) list.removeChild(list.firstElementChild);
  list.scrollTop = list.scrollHeight;
}

function logVisible(entry) {
  if (state.logFilter === 'all') return true;
  const order = { debug: 0, info: 1, warn: 2, error: 3 };
  return order[entry.level] >= order[state.logFilter === 'info' ? 'info' : state.logFilter];
}

function renderLogs() {
  const list = $('logList');
  list.innerHTML = '';
  for (const entry of state.logs) addLogLine(entry);
}

// ------------------------------------------------------------ 状态栏

function applyStatus(status) {
  if (!status) return;
  const danmaku = status.danmaku || {};
  const pill = $('danmakuPill');
  const label = pill.querySelector('span');
  pill.classList.remove('on', 'busy', 'err');
  if (danmaku.connected) {
    pill.classList.add('on');
    label.textContent = `弹幕已连接 · ${danmaku.realRoomId || danmaku.roomIdInput}`;
  } else if (danmaku.running) {
    pill.classList.add('busy');
    label.textContent = '弹幕连接中…';
  } else if (danmaku.lastError) {
    pill.classList.add('err');
    label.textContent = '弹幕未连接';
  } else {
    label.textContent = '弹幕未连接';
  }
  $('toggleDanmaku').textContent = danmaku.running ? '停止监听弹幕' : '开始监听弹幕';
  $('toggleDanmaku').classList.toggle('primary', !danmaku.running);
  $('queuePill').querySelector('span').textContent = `队列 ${status.queueLength || 0}`;
  if (danmaku.lastError) {
    $('roomLabel').textContent = `弹幕提示：${danmaku.lastError}`;
  } else if (state.settings && state.settings.danmaku.roomId) {
    $('roomLabel').textContent = `直播间：${danmaku.realRoomId || state.settings.danmaku.roomId}`;
  }
  renderDanmakuStats(status);
}

/** 收包统计：一眼看出是「没收到」还是「被规则忽略」 */
function renderDanmakuStats(status) {
  const danmaku = (status && status.danmaku) || {};
  const packetStats = danmaku.stats || {};
  const copilotStats = (status && status.stats) || {};
  const reasons = (status && status.filterReasons) || {};

  const received = Number(copilotStats.received) || 0;
  const filtered = Number(copilotStats.filtered) || 0;
  const replied = Number(copilotStats.replied) || 0;
  const unparsed = Number(packetStats.unparsed) || 0;
  const duplicate = Number(packetStats.duplicate) || 0;
  const decompress = Number(packetStats.decompressFailed) || 0;
  const truncated = Number(packetStats.truncated) || 0;
  const queueDropped = Number(copilotStats.dropped) || 0;
  const idCollision = Number(packetStats.idCollision) || 0;

  const set = (id, text) => {
    const node = $(id);
    if (node) node.textContent = text;
  };
  set('dmReceived', String(received));
  set('dmPackets', `数据包 ${packetStats.packets || 0} · 命令 ${packetStats.commands || 0}`);
  set('dmFiltered', String(filtered));
  const reasonText = Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(' · ');
  set('dmFilterReasons', reasonText || '（暂无忽略）');
  set('dmReplied', String(replied));
  const queued = Number(copilotStats.garbled) || 0;
  const droppedGarbled = Number(copilotStats.droppedGarbled) || 0;
  const queueText = `队列 ${status.queueLength || 0}`;
  set('dmQueue', status.paused ? `${queueText} · 已暂停` : queueText);
  set('dmGarbled', String(queued));
  set(
    'dmGarbledSub',
    queued ? `${droppedGarbled ? `其中 ${droppedGarbled} 条没发出来` : '都已重答成功'}` : '回复正常'
  );
  set('dmDropped', String(unparsed + duplicate + decompress + truncated + queueDropped));
  set(
    'dmDroppedDetail',
    `解析失败 ${unparsed} · 重复 ${duplicate} · 解压失败 ${decompress} · 断包 ${truncated} · 队列溢出 ${queueDropped}`
  );
  set('dmIdCollision', String(idCollision));
  set(
    'dmIdCollisionSub',
    idCollision > 0 ? `已全部正常显示` : '同 id 不同弹幕'
  );
  // 弹幕流里也提示一下忽略原因，方便逐条核对
  const feedCount = $('dmFeedCount');
  if (feedCount) feedCount.textContent = `收到 ${received} · 忽略 ${filtered} · 已回 ${replied}`;
  renderDanmakuLog(status && status.danmakuLog);
}

/** 弹幕记录文件的状态：开了没、写到哪个文件、写了多少条 */
function renderDanmakuLog(info) {
  const node = $('danmakuLogStatus');
  if (!node) return;
  if (!info || !info.enabled) {
    node.value = '未开启（所有弹幕都不会被记录）';
    node.title = '';
    return;
  }
  const stats = info.stats || {};
  // 路径直接显示在输入框里（方便复制），统计信息放进悬停提示
  node.value = info.file || '';
  const parts = [`已记录 ${stats.lines || 0} 条`, `文件 ${info.fileSize ? `${(info.fileSize / 1024).toFixed(1)}KB` : '0KB'}`];
  if (stats.rotations) parts.push(`归档 ${stats.rotations} 次`);
  if (stats.failed) parts.push(`写入失败 ${stats.failed} 次`);
  if (stats.truncated) parts.push(`超长截断 ${stats.truncated} 条`);
  node.title = parts.join(' · ');
}

function setAiPill(mode, text) {
  const pill = $('aiPill');
  pill.classList.remove('on', 'busy', 'err');
  if (mode) pill.classList.add(mode);
  pill.querySelector('span').textContent = text;
}

// ------------------------------------------------------------ 事件接线

function wire() {
  // 页签
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      for (const panel of document.querySelectorAll('.panel')) {
        panel.classList.toggle('active', panel.id === `tab-${tab.dataset.tab}`);
      }
    });
  }

  wireProactive();
  wireMemory();

  window.api.on.settingsChanged((settings) => {
    state.settings = settings;
    writeControls();
    renderMascot();
  });

  // 模型刚提了新待办（或查完了）：立刻画出来 + 冒一条**能点的**提示 ——
  // 直播中主播看的是面板，不提示就注意不到它在「申请」；而点进知识库页再找那条太麻烦，
  // 所以提示上直接给「去查 / 记进知识库 / 不用管」按钮（和卡片上是同一段逻辑）。
  window.api.on.research((items) => {
    renderResearch(items);
    const fresh = (Array.isArray(items) ? items : []).filter((item) => item.status === 'pending');
    if (!fresh.length) return;
    // 最高权限开着时她自己会办，这里只提示一声，不给按钮（点了反而重复办）
    const maxMode = Boolean((state.settings.agent || {}).maxPermissions);
    for (const item of fresh.slice(0, MAX_ACTION_TOASTS)) {
      const what =
        item.kind === 'lookup'
          ? '查'
          : item.kind === 'note'
            ? '记'
            : item.kind === 'edit'
              ? '改'
              : item.kind === 'expand'
                ? '扩写'
                : '删';
      if (maxMode) {
        toast(`它想${what}一下「${item.text}」——最高权限开着，她自己会办，办完在「改动记录」里能撤销`, 'ok', 10000);
        continue;
      }
      toast(`它想${what}一下「${item.text}」`, 'ok', 0, [
        { label: researchPrimaryLabel(item.kind), primary: true, onClick: () => runResearchAsync(item) },
        { label: '不用管', onClick: () => dismissResearchAsync(item) }
      ]);
    }
  });

  // 查完 / 整理完：草稿进了「待审」——**直接在提示上通过**，不用点进知识库页
  window.api.on.draftsReady((payload) => {
    const count = Number((payload && payload.count) || 0);
    if (!count) return;
    // ⚠️ 必须顺手重读一次知识库：这条事件是所有「有草稿进待审」的统一入口，
    // 但**发起的不是面板**（对话里回「查」、最高权限下她自己查、DSH 整理）时，
    // 面板没有任何别的地方会去刷新待审列表 —— 主播当时看到的就是「弹窗能通过、面板里空空的」。
    //（从面板点「去查」那条路另有 runResearchAsync 里的刷新，不冲突。）
    void renderKnowledge();
    const titles = Array.isArray(payload.titles) ? payload.titles : [];
    const preview = titles.slice(0, 2).map((title) => `「${title}」`).join('、');
    const more = titles.length > 2 ? ` 等 ${count} 条` : '';
    const auto = Number(payload.autoApproved || 0);
    toast(
      `${payload.source === 'dsh' ? '整理' : '查'}完了：${count} 条进了「待审草稿」${preview ? `（${preview}${more}）` : ''}` +
        `${auto ? `，另有 ${auto} 条她已经自己入库了` : ''}`,
      'ok',
      0,
      [
        { label: '全部通过', primary: true, onClick: () => approveAllDraftsAsync() },
        { label: '先放着', onClick: async () => {} }
      ]
    );
  });

  // 知识库被改了（她自己改的 / 撤销了 / 记了新的）：条目列表和改动记录都要重画
  window.api.on.knowledgeChanged(() => {
    renderKnowledge();
  });

  // 整理/校对：跑起来、每条进度、跑完、应用/忽略都会推整份状态（界面只管照着画）
  window.api.on.knowledgeReview((state) => {
    void renderReview(state);
  });

  // 最高权限开关一改，提示语要跟着变（不然主播不知道现在是哪种行为）
  const maxPermBox = $('maxPermissions');
  if (maxPermBox) maxPermBox.addEventListener('change', () => renderMaxPermHint());

  window.api.on.danmaku((event) => addFeedItem({ kind: 'danmaku', event }));
  window.api.on.danmakuFiltered(({ event, reason }) =>
    addFeedItem({ kind: 'danmaku', event, filtered: true, reason })
  );
  window.api.on.reply((reply) => addReplyItem(reply));
  window.api.on.thinking((value) => setAiPill(value ? 'busy' : '', value ? '正在思考…' : 'AI 待机'));
  window.api.on.status((status) => applyStatus(status));
  window.api.on.error((payload) => {
    if (payload && payload.message) toast(payload.message, 'err', 7000);
  });
  window.api.on.roomInfo((info) => {
    if (!info) return;
    state.roomInfo = info;
    const parts = [];
    if (info.anchorName) parts.push(`主播 ${info.anchorName}`);
    parts.push(`房间 ${info.realRoomId}`);
    if (info.liveStatus === 0) parts.push('未开播');
    if (info.title) parts.push(`《${info.title}》`);
    if (info.areaText) parts.push(info.areaText);
    $('roomLabel').textContent = parts.join(' · ');
  });
  window.api.on.selfNote((note) => {
    const view = $('selfNoteView');
    if (view) view.value = note || '';
    if (note) toast(`AI 调整了自己的风格：${note}`, 'ok', 6000);
  });

  window.api.on.usage((summary) => renderUsage(summary));

  window.api.on.paused(({ paused, reason }) => {
    setAiPill(paused ? 'err' : '', paused ? '已暂停回复' : 'AI 待机');
    if (paused) {
      toast(`已自动暂停回复：${reason}\n（修好后点控制台里的「恢复回复」）`, 'err', 12000);
      const button = $('toggleDanmaku');
      if (button) button.dataset.paused = '1';
    } else {
      toast('已恢复回复', 'ok');
      const button = $('toggleDanmaku');
      if (button) delete button.dataset.paused;
    }
  });

  window.api.on.log((entry) => addLogLine(entry));
  window.api.on.biliLogin((status) => {
    renderAccount(status);
    if (status && status.loggedIn) toast(`已登录：${status.userName}，弹幕昵称将正常显示`, 'ok', 6000);
  });
  window.api.on.logHistory((entries) => {
    state.logs = Array.isArray(entries) ? entries.slice() : [];
    renderLogs();
  });

  // 顶栏
  $('toggleDanmaku').addEventListener('click', async () => {
    const status = await window.api.copilot.status();
    if (status.danmaku && status.danmaku.running) {
      await window.api.danmaku.stop();
      toast('已停止监听弹幕');
    } else {
      const result = await window.api.danmaku.start();
      if (result && result.error) toast(result.error, 'err', 7000);
      else toast('开始监听弹幕', 'ok');
    }
  });

  const openDrawer = () => window.api.overlay.openDrawer();
  $('openDrawer').addEventListener('click', openDrawer);
  $('openDrawer2').addEventListener('click', openDrawer);

  $('toggleOverlayTop').addEventListener('click', toggleOverlayFromPanel);

  // 控制台
  $('clearFeed').addEventListener('click', () => {
    state.feed = [];
    $('danmakuFeed').innerHTML = '<p class="empty">已清屏。</p>';
  });
  $('clearReplies').addEventListener('click', () => {
    $('replyFeed').innerHTML = '<p class="empty">已清屏。</p>';
  });
  $('feedOnlyReply').addEventListener('change', (event) => {
    state.feedOnlyReply = event.target.checked;
    renderFeed();
  });

  $('sendOperator').addEventListener('click', sendOperator);
  $('operatorInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendOperator();
    }
  });
  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      $('operatorInput').value = chip.dataset.quick;
      sendOperator();
    });
  }

  $('replyRecent').addEventListener('click', async () => {
    const result = await window.api.copilot.replyRecent(30);
    if (result && result.ok === false) toast(result.message, 'err', 7000);
    else if (result && !result.reply) toast('最近 30 秒没有收到弹幕', 'warn');
  });

  $('warmupNow').addEventListener('click', async () => {
    toast('正在让她主动搭一句…', 'ok', 3000);
    const result = await window.api.copilot.warmup();
    if (result && result.ok === false) toast(result.message, 'err', 8000);
    else if (result && !result.reply) toast('没有生成搭话，看看日志里的报错', 'warn', 7000);
  });

  $('pauseToggle').addEventListener('click', async () => {
    const status = await window.api.copilot.status();
    if (status.paused) {
      await window.api.copilot.resume();
    } else {
      await window.api.copilot.pause('手动暂停');
    }
  });

  $('testReply').addEventListener('click', () => {
    window.api.overlay.testMessage({ text: '测试一下悬浮窗显示效果～', emotion: 'happy' });
  });

  $('clearHistory').addEventListener('click', async () => {
    await window.api.copilot.clearHistory();
    toast('已清空对话记忆', 'ok');
  });

  $('clearSelfNote').addEventListener('click', async () => {
    await window.api.copilot.clearSelfNote();
    $('selfNoteView').value = '';
    toast('已清除 AI 的风格备注', 'ok');
  });

  // 完整系统提示词：上面那个输入框只是「人设」那一段，实际发出去的还有程序追加的
  // 身份 / 聊天原则 / 权限规则 / 输出要求。这里给的是**完整模板**，可以改、可以存。
  const setPromptState = (text) => {
    const node = $('fullPromptState');
    if (node) node.textContent = text || '';
  };
  const loadFullPrompt = async () => {
    const template = await window.api.copilot.systemPrompt();
    $('fullPromptText').value = template;
    const saved = Boolean(String((state.settings.persona || {}).systemPromptOverride || '').trim());
    setPromptState(saved ? '当前用的是你保存过的自定义提示词。' : '当前用的是程序默认模板，改完点保存才会生效。');
  };

  $('showFullPrompt').addEventListener('click', async () => {
    const box = $('fullPromptBox');
    const button = $('showFullPrompt');
    if (!box.hidden) {
      box.hidden = true;
      button.textContent = '查看 / 修改完整提示词';
      return;
    }
    try {
      await loadFullPrompt();
      box.hidden = false;
      button.textContent = '收起完整提示词';
    } catch (error) {
      toast(`读取提示词失败：${(error && error.message) || error}`, 'err');
    }
  });

  $('saveFullPrompt').addEventListener('click', async () => {
    const text = String($('fullPromptText').value || '').trim();
    if (!text) {
      toast('提示词不能是空的；想恢复默认请点「恢复默认模板」', 'warn', 6000);
      return;
    }
    state.settings = await window.api.settings.update({ persona: { systemPromptOverride: text } });
    setPromptState('已保存，下一次回复就用这份提示词。');
    toast('完整提示词已保存', 'ok');
  });

  $('previewFullPrompt').addEventListener('click', async () => {
    const box = $('fullPromptPreview');
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    // 先存再预览：这样看到的就是「点保存之后真正会发出去的东西」
    const text = String($('fullPromptText').value || '').trim();
    if (!text) {
      toast('提示词不能是空的', 'warn');
      return;
    }
    state.settings = await window.api.settings.update({ persona: { systemPromptOverride: text } });
    const rendered = await window.api.copilot.systemPrompt(true);
    const length = String(rendered || '').length;
    box.textContent = `${rendered}\n\n—— 共 ${length} 字符（约 ${Math.round(length * 0.6)} 输入 token）——`;
    box.hidden = false;
    setPromptState('已保存，下面就是实际会发出去的文本。');
  });

  $('resetFullPrompt').addEventListener('click', async () => {
    state.settings = await window.api.settings.update({ persona: { systemPromptOverride: '' } });
    await loadFullPrompt();
    $('fullPromptPreview').hidden = true;
    toast('已恢复默认模板', 'ok');
  });

  // API
  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('testLlm').addEventListener('click', async () => {
    const out = $('llmResult');
    out.className = 'test-result';
    out.textContent = '正在测试…';
    await flushSave();
    const result = await window.api.llm.test();
    if (result.ok) {
      out.className = 'test-result ok';
      out.textContent = `✅ 连接成功（${result.data.latencyMs}ms，模型 ${result.data.model}）：${result.data.reply}`;
    } else {
      out.className = 'test-result err';
      out.textContent = `❌ ${result.message}`;
    }
  });

  $('restorePersona').addEventListener('click', async () => {
    if (!await confirmDialog('把人设恢复成默认内容？其它设置不受影响。')) return;
    const defaultPersona = await window.api.settings.defaultPersona();
    $('systemPrompt').value = defaultPersona;
    state.settings = await window.api.settings.update({ persona: { systemPrompt: defaultPersona } });
    toast('已恢复默认人设', 'ok');
  });

  // ---- 角色切换 ----
  const roleSelect = $('roleSelect');
  if (roleSelect) {
    roleSelect.addEventListener('change', async () => {
      const id = roleSelect.value;
      if (!id || id === currentRoleId()) return;
      const role = ((state.settings.persona || {}).roles || {})[id];
      await applyRole(id, { toastText: `已切换到角色「${(role && role.name) || id}」` });
    });
  }
  const roleEmoji = $('roleEmoji');
  if (roleEmoji) {
    // 图标只是个标记，改完自动存进当前角色（和名字/人设一样的规矩）
    roleEmoji.addEventListener('input', () => {
      clearTimeout(roleEmoji._saveTimer);
      roleEmoji._saveTimer = setTimeout(async () => {
        const persona = state.settings.persona || {};
        const roles = { ...(persona.roles || {}) };
        const id = currentRoleId();
        if (!roles[id]) return;
        roles[id] = { ...roles[id], emoji: roleEmoji.value.trim().slice(0, 8) };
        state.settings = await window.api.settings.update({ persona: { roles } });
        fillRoleOptions();
      }, 400);
    });
  }
  const newRoleBtn = $('newRole');
  if (newRoleBtn) {
    newRoleBtn.addEventListener('click', async () => {
      // 先把手上的改动落盘，否则「新建」复制的可能是 250ms 之前的旧内容
      await flushSave();
      const persona = state.settings.persona || {};
      const roles = { ...(persona.roles || {}) };
      const id = newRoleId(roles);
      const name = nextRoleName(roles);
      roles[id] = {
        name,
        emoji: '🎭',
        // 复制当前内容：多数时候是「在这个角色基础上改一个」
        prompt: String(persona.systemPrompt || ''),
        style: String(persona.styleNotes || '')
      };
      state.settings = await window.api.settings.update({
        persona: { roles, activeRole: id, ...personaFields(roles[id]) }
      });
      writeControls();
      toast(`已新建角色「${name}」：内容复制自刚才那个角色，直接改下面的名字 / 人设 / 性格就行（自动保存）`, 'ok', 9000);
    });
  }
  const deleteRoleBtn = $('deleteRole');
  if (deleteRoleBtn) {
    deleteRoleBtn.addEventListener('click', async () => {
      const persona = state.settings.persona || {};
      const roles = { ...(persona.roles || {}) };
      const id = currentRoleId();
      if (id === 'default') {
        toast('默认角色删不掉（它是你原本配的那个人设，删了就没退路了）', 'warn', 7000);
        return;
      }
      const role = roles[id] || {};
      if (!await confirmDialog(`删除角色「${role.name || id}」？删了就找不回来了。`)) return;
      delete roles[id];
      state.settings = await window.api.settings.update({
        persona: { roles, activeRole: 'default', ...personaFields(roles.default) }
      });
      writeControls();
      toast(`已删除角色「${role.name || id}」，回到默认角色`, 'ok');
    });
  }

  // 弹幕
  $('testDanmaku').addEventListener('click', async () => {
    const out = $('danmakuTestResult');
    out.textContent = '正在测试…';
    await flushSave();
    const result = await window.api.danmaku.test($('roomId').value.trim());
    if (result.ok) {
      const d = result.data;
      out.textContent = `✅ 真实房间号 ${d.realRoomId}，弹幕服务器 ${d.hostCount} 台，${
        d.liveStatus ? '正在直播' : '当前未开播（未开播也能连，开播后才有弹幕）'
      }${d.title ? `，标题：${d.title}` : ''}`;
    } else {
      out.textContent = `❌ ${result.message}`;
    }
  });

  // 悬浮窗
  $('toggleOverlayVisible').addEventListener('click', toggleOverlayFromPanel);
  $('reloadOverlay').addEventListener('click', async () => {
    await window.api.overlay.reload();
    toast('悬浮窗已重载', 'ok');
  });
  $('sendTestReply').addEventListener('click', () => {
    window.api.overlay.testMessage({
      text: `这是 ${state.settings.persona.botName} 的测试回复，看到就说明悬浮窗正常。`,
      emotion: 'talking'
    });
  });

  // 吉祥物
  $('pickImages').addEventListener('click', pickImages);
  $('autoMap').addEventListener('click', autoMap);
  $('previewEmotions').addEventListener('click', previewEmotions);

  // 日志
  $('logLevel').addEventListener('change', (event) => {
    state.logFilter = event.target.value;
    renderLogs();
  });
  $('openLogFile').addEventListener('click', async () => {
    const file = await window.api.log.openFile();
    if (!file) toast('日志文件还没生成', 'warn');
  });
  $('clearLogs').addEventListener('click', async () => {
    await window.api.log.clear();
    state.logs = [];
    renderLogs();
  });
  $('openDataFolder').addEventListener('click', () => window.api.settings.openFolder());
  $('danmakuLogOpenBtn').addEventListener('click', async () => {
    const target = await window.api.danmakuLog.open();
    if (target) toast(`已打开：${target}`, 'ok', 5000);
    else toast('记录文件还没生成，先开始监听弹幕', 'warn');
  });
  $('danmakuLogChooseBtn').addEventListener('click', async () => {
    const result = await window.api.danmakuLog.chooseDir();
    if (!result || !result.changed) return;
    toast(`弹幕记录已改到：${result.dir}`, 'ok', 7000);
    renderDanmakuLog(result.status);
  });
  $('resetSettings').addEventListener('click', async () => {
    if (!await confirmDialog('恢复出厂设置会清掉 API Key、人设、图片等所有配置，确定吗？')) return;
    state.settings = await window.api.settings.reset();
    state.feed = [];
    renderFeed();
    writeControls();
    renderMascot();
    toast('已恢复默认设置', 'ok');
  });
}

async function sendOperator() {
  const input = $('operatorInput');
  const text = input.value.trim();
  if (!text) {
    toast('先说点什么吧', 'warn');
    return;
  }
  input.value = '';
  // 开发者模式：气泡里不重复那串前缀，改成「（你 · 开发者模式）」，
  // 让主播一眼看出这条是以指令身份发出去的
  const devMode = /^[\[【]\s*开发者模式\s*[\]】]/.test(text);
  addReplyItem({
    text: devMode ? `（你 · 开发者模式）${text.replace(/^[\[【]\s*开发者模式\s*[\]】]\s*[:：]?\s*/, '')}` : `（你）${text}`,
    ts: Date.now(),
    source: 'me'
  });
  const result = await window.api.copilot.talk(text);
  if (result && result.ok === false) {
    toast(result.message, 'err', 8000);
    return;
  }
  if (!result.reply) toast('搭档没有给出回复，看看日志里的报错', 'warn', 7000);
}

// ------------------------------------------------------------ 启动

async function init() {
  // 分步执行：任一步失败都能精确知道是哪一步，并把原因显示到页面上
  const steps = [
    ['绑定设置控件', () => bindAll()],
    ['绑定事件', () => wire()],
    ['绑定账号模块', () => wireAccount()],
    ['绑定用量模块', () => wireUsage()],
    ['初始化语音模块', () => initSpeechPanel()],
    ['初始化知识库模块', () => wireKnowledge()],
    [
      '读取设置',
      async () => {
        state.settings = await window.api.settings.get();
      }
    ],
    ['回填设置', () => writeControls()],
    ['渲染吉祥物', () => renderMascot()],
    ['读取知识库', () => renderKnowledge()],
    [
      '读取登录状态',
      async () => {
        renderAccount(await window.api.bili.status());
      }
    ],
    [
      '读取用量',
      async () => {
        renderUsage(await window.api.usage.summary());
      }
    ],
    [
      '读取风格备注',
      async () => {
        const selfNote = await window.api.copilot.selfNote();
        if (selfNote) $('selfNoteView').value = selfNote;
      }
    ],
    [
      '读取运行状态',
      async () => {
        applyStatus(await window.api.copilot.status());
      }
    ],
    [
      '读取日志',
      async () => {
        const logs = await window.api.log.get();
        state.logs = Array.isArray(logs) ? logs.slice() : [];
        renderLogs();
      }
    ],
    ['读取应用信息', () => renderAppInfo()],
    ['同步悬浮窗按钮', () => refreshOverlayButton()]
  ];

  for (const [name, run] of steps) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await run();
    } catch (error) {
      const message = `初始化在「${name}」这一步失败：${error && error.message ? error.message : error}`;
      // eslint-disable-next-line no-console
      console.error(message, error);
      if (typeof window.__reportUiError === 'function') {
        window.__reportUiError('初始化失败', message, { stack: error && error.stack ? error.stack : '' });
      }
    }
  }
}

/** 「运行日志」页里的数据目录信息，显示真实路径，方便排查 */
async function renderAppInfo() {
  try {
    const info = await window.api.app.info();
    const target = $('dataFolder');
    if (target && info) {
      target.textContent = `配置：${info.settingsFile}　日志：${info.logFile}　（Electron ${info.versions.electron} / Chromium ${info.versions.chrome}）`;
    }
  } catch (_) {
    /* ignore */
  }
}

init();
