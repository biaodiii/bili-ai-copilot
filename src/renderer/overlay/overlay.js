'use strict';

/**
 * 悬浮窗渲染层：
 *  - 吉祥物按表情切换图片
 *  - AI 回复文本显示在吉祥物上方，到时间自动淡出
 *  - 对话区显示观众弹幕 / AI 回复 / 主播自己的发言
 *  - 拖动定位由顶部那一行交给系统处理，位置用比例保存在设置里
 */

const el = {
  copilot: document.getElementById('copilot'),
  header: document.getElementById('header'),
  headerTitle: document.getElementById('headerTitle'),
  headerStatus: document.getElementById('headerStatus'),
  replyBox: document.getElementById('replyBox'),
  mascot: document.getElementById('mascot'),
  mascotImg: document.getElementById('mascotImg'),
  mascotEmoji: document.getElementById('mascotEmoji'),
  drawer: document.getElementById('drawer'),
  drawerClose: document.getElementById('drawerClose'),
  testBtn: document.getElementById('testBtn'),
  speechEnabled: document.getElementById('speechEnabled'),
  muteBtn: document.getElementById('muteBtn'),
  chatPanel: document.getElementById('chatPanel'),
  chatLog: document.getElementById('chatLog'),
  chatJump: document.getElementById('chatJump'),
  chatInput: document.getElementById('chatInput'),
  chatSend: document.getElementById('chatSend'),
  chatClear: document.getElementById('chatClear'),
  chatStatus: document.getElementById('chatStatus'),
  chatEnabled: document.getElementById('chatEnabled'),
  chatShowDanmaku: document.getElementById('chatShowDanmaku'),
  chatShowIds: document.getElementById('chatShowIds'),
  chatHeight: document.getElementById('chatHeight'),
  gearBtn: document.getElementById('gearBtn'),
  pinBtn: document.getElementById('pinBtn'),
  lockBtn: document.getElementById('lockBtn'),
  closeBtn: document.getElementById('closeBtn'),
  hideBtn: document.getElementById('hideBtn'),
  quitAppBtn: document.getElementById('quitAppBtn')
};

const sliders = {
  posX: document.getElementById('posX'),
  posY: document.getElementById('posY'),
  mascotWidth: document.getElementById('mascotWidth'),
  fontScale: document.getElementById('fontScale'),
  opacity: document.getElementById('opacity'),
  replySeconds: document.getElementById('replySeconds')
};

const outputs = {
  posX: document.getElementById('posXOut'),
  posY: document.getElementById('posYOut'),
  mascotWidth: document.getElementById('mascotWidthOut'),
  fontScale: document.getElementById('fontScaleOut'),
  opacity: document.getElementById('opacityOut'),
  replySeconds: document.getElementById('replySecondsOut')
};

const showViewerCheckbox = document.getElementById('showViewerMessage');
/** 「回复气泡不自动消失」的勾选框（2026-10-19 加） */
const replyPersistCheckbox = document.getElementById('replyPersist');

// 表情 → 图片名关键词等纯逻辑放在 shared/emotions.js 里，面板和悬浮窗共用
const shared = window.SharedLogic;

const state = {
  settings: null,
  emotion: 'idle',
  botState: 'idle',
  thinking: false,
  speakingTimer: null,
  // 「先念观众原话、停一下再念回复」之间那个等待计时器
  speakGapTimer: null,
  // 每次朗读递增：云端是异步的，回来时 token 变了说明已经被打断
  speakToken: 0,
  // 正在播的云端音频（静音 / 打断时要能暂停它）
  cloudAudio: null,
  // 长时间没人说话就睡着
  sleepTimer: null,
  greeted: false,
  // 回复里那串情绪标记：按顺序演，演完回平常
  emotionQueue: [],
  emotionTimer: null,
  emotionIdleTimer: null,
  latestViewer: null,
  // 回复文本（吉祥物上方那一块）
  replyNode: null,
  replyToken: 0,
  replyIdleTimer: null,
  replyHideTimer: null,
  dragging: false,
  drawerOpen: false,
  chat: [],
  chatSeen: new Set(),
  // 对话区滚动状态：翻旧记录时不要被新消息拽回底部
  chatPinBottom: true,
  chatUnread: 0,
  snapToken: 0,
  selfScroll: false,
  sending: false,
  status: null
};

// ------------------------------------------------------------ 对话区

/**
 * 悬浮窗里的对话区：显示收到的弹幕 + AI 的回复，并且可以直接在这里打字和搭档说话。
 * 记录只保留最近若干条（`overlay.chatMaxItems`），避免长时间直播把内存撑大。
 *
 * @param {string} kind             viewer / ai / me / sys
 * @param {string} who              显示用的名字
 * @param {string} text             正文
 * @param {object} [options]
 * @param {string} [options.dedup]  去重用的内部键（和要显示的 id 不是一回事）
 * @param {string} [options.id]     要显示给主播看的弹幕 id（B 站下发的 messageId）
 * @param {number} [options.uid]    发送者 uid（uid=0 表示未登录时看不到真实 uid）
 */
function chatAdd(kind, who, text, { dedup, id, uid } = {}) {
  const overlay = (state.settings && state.settings.overlay) || {};
  if (overlay.chatEnabled === false) return null;
  // 弹幕可以单独关掉显示（AI 回复与你自己的发言仍然显示）
  if (kind === 'viewer' && overlay.chatShowDanmaku === false) return null;
  const content = String(text || '').trim();
  if (!content) return null;

  if (dedup) {
    // 同一条内容不要重复显示（面板和悬浮窗两条通道可能都推过来）
    if (state.chatSeen.has(dedup)) return null;
    state.chatSeen.add(dedup);
    if (state.chatSeen.size > 400) state.chatSeen.clear();
  }

  const item = {
    kind,
    who: String(who || ''),
    text: content,
    id: id ? String(id) : '',
    uid: Number.isFinite(Number(uid)) ? Number(uid) : null,
    ts: Date.now()
  };
  state.chat.push(item);
  const max = Math.max(10, Number(overlay.chatMaxItems) || 60);
  while (state.chat.length > max) {
    state.chat.shift();
    if (el.chatLog && el.chatLog.firstElementChild) el.chatLog.removeChild(el.chatLog.firstElementChild);
  }

  if (!el.chatLog) return item;
  const empty = el.chatLog.querySelector('.chat-empty');
  if (empty) empty.remove();

  const node = document.createElement('div');
  node.className = `chat-item ${kind}`;
  const whoNode = document.createElement('span');
  whoNode.className = 'chat-who';
  // 用 item.who（而不是固定的「我」）：开发者模式会把名字标成「我 · 开发者模式」，
  // 让主播一眼看出这条是以指令身份发出去的
  whoNode.textContent = kind === 'me' ? item.who || '我' : kind === 'sys' ? '' : item.who;
  const body = document.createElement('span');
  body.className = 'chat-text';
  body.textContent = kind === 'sys' ? `— ${content}` : content;

  // 名字右侧挂一行小字：弹幕 id（+ uid）。默认不显示，
  // 排查「某条弹幕是不是没收到」时才打开——出问题时能和弹幕记录文件逐条对照。
  const tagBits = [];
  if (overlay.chatShowIds === true) {
    if (item.id) tagBits.push(`id ${item.id}`);
    if (item.uid !== null && kind === 'viewer') tagBits.push(`uid ${item.uid}`);
  }

  if (whoNode.textContent) {
    const whoWrap = document.createElement('span');
    whoWrap.className = 'chat-who-wrap';
    whoWrap.appendChild(whoNode);
    if (tagBits.length) {
      const tag = document.createElement('span');
      tag.className = 'chat-id';
      tag.textContent = tagBits.join(' · ');
      whoWrap.appendChild(tag);
      // 小字放不下就整条显示在悬停提示里
      whoWrap.title = `${item.who}${item.id ? ` · id ${item.id}` : ''}${item.uid !== null ? ` · uid ${item.uid}` : ''}`;
    }
    node.appendChild(whoWrap);
  }
  node.appendChild(body);

  // 关键：是否在底部必须在这一条「加进去之前」判断。
  // 加完之后再读 scrollHeight 拿到的是重排前的旧值，条件会一直不成立——
  // 这正是「有新消息却不往下滚」的根因。判断结果存在 state 里，滚动也据此决定。
  const stick = chatIsAtBottom();

  el.chatLog.appendChild(node);

  if (stick) state.chatUnread = 0;
  else state.chatUnread += 1;
  renderChatJump();
  // 交给下一帧统一滚：这条动画、对话区高度、窗口高度都可能变，立刻滚会滚不到底
  scheduleChatSnap({ force: stick });
  renderLayout();
  return item;
}

/** 当前是否贴在对话区底部（留 40px 容差，避免像素误差把状态判反） */
function chatIsAtBottom(slack = 40) {
  if (!el.chatLog) return true;
  const distance = el.chatLog.scrollHeight - el.chatLog.scrollTop - el.chatLog.clientHeight;
  if (!Number.isFinite(distance)) return true;
  return distance <= slack;
}

/**
 * 滚到最新一条。
 *
 * 必须等重排完成再滚，所以走 requestAnimationFrame；另外加了 snapToken：
 * 同一帧里连着来好几条消息时，只有最后一次的滚动算数，避免动画互相打架。
 */
function scheduleChatSnap({ force = false } = {}) {
  if (!el.chatLog) return;
  const token = ++state.snapToken;
  const run = () => {
    if (token !== state.snapToken || !el.chatLog) return;
    if (!force && !state.chatPinBottom) return;
    // 这个标记很重要：程序自己改 scrollTop 也会触发 scroll 事件，
    // 不区分的话 handleChatScroll 会把「程序滚到底」误判成「用户滚到底」，
    // 于是又调度一次贴底，来回自反馈。
    state.selfScroll = true;
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => {
      state.selfScroll = false;
    });
    else state.selfScroll = false;
    state.chatPinBottom = true;
    state.chatUnread = 0;
    renderChatJump();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 16);
}

/** 用户滚到哪就记到哪：离底部近就继续跟随，翻上去了就停下等他自己回来 */
function handleChatScroll() {
  if (!el.chatLog) return;
  // 程序自己滚出来的事件不算「用户意图」
  if (state.selfScroll) return;
  const wasPinned = state.chatPinBottom;
  state.chatPinBottom = chatIsAtBottom();
  if (state.chatPinBottom && state.chatUnread) {
    state.chatUnread = 0;
    renderChatJump();
  }
  // 用户自己滚回底部 → 补一次贴底，顺手清掉提示
  if (!wasPinned && state.chatPinBottom) scheduleChatSnap({ force: true });
}

/** 「有新消息 ↓」按钮的显隐与计数 */
function renderChatJump() {
  if (!el.chatJump) return;
  const show = !state.chatPinBottom && state.chatUnread > 0;
  el.chatJump.classList.toggle('show', show);
  if (show) el.chatJump.textContent = state.chatUnread > 99 ? '↓ 99+ 条新消息' : `↓ ${state.chatUnread} 条新消息`;
}

/** 菜单/按钮点「跳到最新」 */
function chatJumpToLatest() {
  if (!el.chatLog) return;
  state.chatUnread = 0;
  scheduleChatSnap({ force: true });
}

/**
 * 布局变化（改高度、开抽屉、切对话区开关）之后补一次贴底。
 * 只对「本来就在底部」的情况生效，正在翻记录时不动。
 */
function chatRepinAfterLayout() {
  if (!el.chatLog) return;
  if (!state.chatPinBottom && state.chatUnread > 0) return;
  scheduleChatSnap({ force: true });
}

function chatClear() {
  state.chat = [];
  state.chatSeen.clear();
  state.chatUnread = 0;
  state.chatPinBottom = true;
  if (el.chatLog) {
    el.chatLog.innerHTML = '';
    chatEmptyHint();
  }
  renderChatJump();
  renderLayout();
}

/** 空对话时的说明文字 */

function chatEmptyHint() {
  if (!el.chatLog) return;
  const empty = document.createElement('div');
  empty.className = 'chat-empty';
  empty.textContent = '观众的弹幕和搭档的回复会出现在这里；也可以在下面直接打字找我说话。';
  el.chatLog.appendChild(empty);
}

/**
 * 对测试开放的接口（轻量 DOM 里能直接调，不需要真窗口）。
 * 只读 + 触发重算，不会改动业务数据。
 * layout 是最近一次算出来的布局（卡片尺寸 / 回复区高度），
 * 迷你 DOM 里 offsetHeight 是常量，所以测试要量布局就看这里。
 */
window.OverlayChatScroll = {
  isAtBottom: chatIsAtBottom,
  handleScroll: handleChatScroll,
  jumpToLatest: chatJumpToLatest,
  repinAfterLayout: chatRepinAfterLayout,
  snap: scheduleChatSnap,
  computeLayout,
  getLayout: () => state.layout,
  state
};

function renderChatStatus(extra) {
  if (!el.chatStatus) return;
  if (extra) {
    el.chatStatus.textContent = extra;
    return;
  }
  const status = state.status || {};
  const danmaku = status.danmaku || {};
  if (danmaku.connected) {
    el.chatStatus.textContent = `弹幕已连接 · 房间 ${danmaku.realRoomId || danmaku.roomIdInput || ''}`;
  } else if (danmaku.running) {
    el.chatStatus.textContent = '弹幕连接中…';
  } else {
    el.chatStatus.textContent = '还没有连接弹幕（可在控制面板开始监听）';
  }
}

async function sendChat() {
  if (!el.chatInput || !el.chatSend) return;
  const text = el.chatInput.value.trim();
  if (!text) return;
  if (state.sending) return;
  state.sending = true;
  el.chatSend.disabled = true;
  el.chatInput.value = '';
  autoGrowInput();
  // 开发者模式（[开发者模式] 开头）= 配置指令，不是闲聊。
  // 对话区里标成「我 · 开发者模式」，免得和普通说话混淆。
  if (/^[\[【]\s*开发者模式\s*[\]】]/.test(text)) {
    chatAdd('me', '我 · 开发者模式', text.replace(/^[\[【]\s*开发者模式\s*[\]】]\s*[:：]?\s*/, ''));
  } else {
    chatAdd('me', '我', text);
  }

  try {
    const result = await window.api.copilot.talk(text);
    if (result && result.ok === false) {
      chatAdd('sys', '', `发送失败：${result.message}`);
    } else if (result && !result.reply) {
      chatAdd('sys', '', '搭档这次没有回复，可以在控制面板看日志');
    }
  } catch (error) {
    chatAdd('sys', '', `发送失败：${error.message}`);
  } finally {
    state.sending = false;
    if (el.chatSend) el.chatSend.disabled = false;
    // 只有在用户本来就还在输入框里时才把焦点放回去，避免抢走你正在用的其它软件
    if (document.activeElement === el.chatInput) el.chatInput.focus();
  }
}

function autoGrowInput() {
  if (!el.chatInput) return;
  el.chatInput.style.height = 'auto';
  el.chatInput.style.height = `${Math.min(84, el.chatInput.scrollHeight)}px`;
}

function bindChat() {
  if (!el.chatSend || !el.chatInput) return;

  el.chatSend.addEventListener('click', () => sendChat());

  el.chatInput.addEventListener('keydown', (event) => {
    // Enter 发送，Shift+Enter 换行
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendChat();
    }
    event.stopPropagation();
  });

  el.chatInput.addEventListener('input', autoGrowInput);

  // 注意：这里「不要」在鼠标进出 / 输入框聚焦时去 focus() 或 blur() 窗口。
  // 曾经这么写过，结果是：点过输入框后切到别的程序，Windows 让悬浮窗失焦，
  // 我们又在 blur/focus 之间来回切，窗口不停闪动。
  // 窗口现在就是一个普通小窗口，焦点交给系统处理即可。

  if (el.chatClear) {
    el.chatClear.addEventListener('click', () => {
      chatClear();
      // 提示放在状态栏，保持聊天记录真的是空的
      renderChatStatus('对话记录已清空');
      setTimeout(() => renderChatStatus(), 2000);
    });
  }

  // 用户一滚就重新判定「跟不跟随」，这样往上翻记录不会被新消息拽回底部
  if (el.chatLog) el.chatLog.addEventListener('scroll', handleChatScroll, { passive: true });
  if (el.chatJump) el.chatJump.addEventListener('click', () => chatJumpToLatest());
}

// ------------------------------------------------------------ 语音朗读

/**
 * 用系统语音把回复念出来（Electron 内置 Chromium，Windows 走系统语音）。
 * 注意两个已知点：
 *   1. getVoices() 第一次可能返回空，要等 voiceschanged 事件；
 *   2. 同一时刻只念一条，新回复直接打断旧的（直播里宁可打断也不要排队滞后）。
 */
function getSpeech() {
  return state.speech && state.speech.synth ? state.speech : null;
}

function selectVoice() {
  const { voices, synth } = state.speech;
  if (!synth || !voices.length) return;
  const wanted = (state.settings && state.settings.speech && state.settings.speech.voiceURI) || '';
  const list = state.speech.voices;
  const nameOf = (voice) => `${voice.name || ''} ${voice.voiceURI || ''}`.toLowerCase();

  let voice = wanted ? list.find((item) => item.voiceURI === wanted || item.name === wanted) : null;
  if (!voice) {
    // 没指定就优先挑中文语音
    voice = list.find((item) => /zh[-_]?cn|chinese|中文|普通话|xiaoxiao|huihui|kangkang|yaoyao/i.test(nameOf(item)));
  }
  if (!voice) voice = list.find((item) => String(item.lang || '').toLowerCase().startsWith('zh'));
  if (!voice) voice = list[0];
  state.speech.voice = voice || null;
}

function refreshVoices() {
  const speech = getSpeech();
  if (!speech || !speech.synth) return [];
  const list = speech.synth.getVoices() || [];
  state.speech.voices = Array.from(list);
  selectVoice();
  return state.speech.voices;
}

function voiceSummary() {
  const voice = state.speech.voice;
  const count = state.speech.voices.length;
  if (!count) return '没有检测到系统语音';
  return `${voice ? voice.name : '默认语音'}（共 ${count} 个可用）`;
}

function stopSpeech() {
  // 连「等停顿结束再念回复」那个待命计时器一起清掉，
  // 否则静音/打断之后它还会到点把回复念出来
  if (state.speakGapTimer) {
    clearTimeout(state.speakGapTimer);
    state.speakGapTimer = null;
  }
  // 云端播放中的音频也要停
  if (state.cloudAudio) {
    try {
      state.cloudAudio.pause();
    } catch (_) {
      /* ignore */
    }
    state.cloudAudio = null;
  }
  const speech = getSpeech();
  if (speech && speech.synth && typeof speech.synth.cancel === 'function') {
    try {
      speech.synth.cancel();
    } catch (_) {
      /* ignore */
    }
  }
  el.copilot.classList.remove('speaking');
}

/** 念的时候让吉祥物跳一下；停下来的延迟清理交给各自的结束回调 */
function markSpeaking() {
  el.copilot.classList.add('speaking');
  if (state.speakingTimer) clearTimeout(state.speakingTimer);
}

function unmarkSpeaking() {
  if (state.speakingTimer) clearTimeout(state.speakingTimer);
  state.speakingTimer = setTimeout(() => el.copilot.classList.remove('speaking'), 250);
}

/** 现在该用哪个引擎：'system'（默认）或 'cloud' */
function speechEngine() {
  const config = (state.settings && state.settings.speech) || {};
  return config.engine === 'cloud' ? 'cloud' : 'system';
}

/**
 * 系统语音朗读（原来的实现，一行没改逻辑，只是包进 Promise 好和云端共用调用方）。
 * @returns {Promise<boolean>} 是否真的念了
 */
function speakWithSystem(content, config) {
  return new Promise((resolve) => {
    const speech = getSpeech();
    if (!speech || !speech.synth) {
      resolve(false);
      return;
    }
    if (!speech.voices.length) refreshVoices();
    try {
      speech.synth.cancel();
      const utterance = new speech.SpeechSynthesisUtterance(content);
      if (speech.voice) utterance.voice = speech.voice;
      utterance.rate = Math.min(2, Math.max(0.5, Number(config.rate) || 1));
      utterance.pitch = Math.min(2, Math.max(0, Number(config.pitch) || 1));
      utterance.volume = Math.min(1, Math.max(0, config.volume === undefined ? 1 : Number(config.volume)));

      utterance.onstart = () => markSpeaking();
      // onend / onerror 都可能触发，用标记保证只结算一次
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        unmarkSpeaking();
        resolve(true);
      };
      utterance.onend = settle;
      // 合成失败（比如系统没装那个音色）也要放行，不然「念完再接回复」会永远卡住
      utterance.onerror = settle;
      speech.synth.speak(utterance);
    } catch (error) {
      console.warn('[overlay] 系统语音朗读失败:', error && error.message);
      resolve(false);
    }
  });
}

/**
 * 云端语音朗读：向主进程要一段音频来播。
 * 任何一步失败（没配 Key / 网络错 / 拿不到音频）都返回 false，交给调用方决定降级。
 * @param {string} content 要念的文本
 * @param {number} token   本次朗读的 token：请求回来发现 token 变了说明已被打断
 * @returns {Promise<boolean>} 是否真的念了
 */
async function speakWithCloud(content, token) {
  if (!window.api || !window.api.tts || typeof window.api.tts.synthesize !== 'function') return false;
  let result = null;
  try {
    result = await window.api.tts.synthesize(content);
  } catch (error) {
    console.warn('[overlay] 云端语音请求异常:', error && error.message);
    return false;
  }
  if (!result || result.ok !== true || !result.audio) {
    console.warn('[overlay] 云端语音失败:', (result && result.message) || '没有返回音频');
    return false;
  }
  // 请求期间可能已经被打断（静音 / 新回复 / 关掉了语音），这时别再出声
  if (state.speakToken !== token) return false;

  return new Promise((resolve) => {
    // 走 window.Audio：脚本是整页共存的，用裸 Audio 在测试环境（vm 沙箱）里解析不到，
    // 走 window 上的属性最稳，也是浏览器里更明确的写法
    const AudioCtor = window.Audio;
    if (typeof AudioCtor !== 'function') {
      console.warn('[overlay] 当前环境没有 Audio，无法播放云端语音');
      resolve(false);
      return;
    }
    let audio;
    try {
      audio = new AudioCtor(`data:${result.mime || 'audio/wav'};base64,${result.audio}`);
    } catch (error) {
      console.warn('[overlay] 云端音频无法播放:', error && error.message);
      resolve(false);
      return;
    }
    state.cloudAudio = audio;
    let settled = false;
    const settle = (played) => {
      if (settled) return;
      settled = true;
      if (state.cloudAudio === audio) state.cloudAudio = null;
      unmarkSpeaking();
      resolve(played);
    };
    audio.onplay = () => markSpeaking();
    audio.onended = () => settle(true);
    audio.onerror = () => {
      console.warn('[overlay] 云端音频播放失败');
      settle(false);
    };
    try {
      const started = audio.play();
      // 浏览器可能返回 Promise（自动播放策略），失败就当没念
      if (started && typeof started.catch === 'function') started.catch(() => settle(false));
    } catch (error) {
      console.warn('[overlay] 云端音频播放异常:', error && error.message);
      settle(false);
    }
  });
}

/**
 * 念一段文字。
 *
 * 引擎按设置走：'cloud' 先试云端，失败（或没配 Key）再按 `fallbackToSystem`
 * 决定要不要退回系统语音——**直播里宁可音色差一点，也不能突然变哑巴**。
 *
 * @returns {Promise<boolean>} 是否真的念了
 */
async function speak(text, { force = false } = {}) {
  const config = (state.settings && state.settings.speech) || {};
  if (!force && config.enabled === false) return false;
  if (!force && config.muted) {
    // 静音状态下顺便把可能正在念的内容停掉，避免「点了静音还在说」
    stopSpeech();
    return false;
  }
  const content = String(text || '').trim();
  if (!content) return false;

  // 每次朗读换一个 token：云端是异步的，回来时发现 token 变了说明已经被打断
  state.speakToken = (state.speakToken || 0) + 1;
  const speakTokenAtStart = state.speakToken;

  if (speechEngine() === 'cloud') {
    const played = await speakWithCloud(content, speakTokenAtStart);
    if (played) return true;
    if (config.fallbackToSystem === false) return false;
    // 打断过就别再补一句系统语音了
    if (state.speakToken !== speakTokenAtStart) return false;
    console.warn('[overlay] 云端语音不可用，本次退回系统语音');
  }
  return speakWithSystem(content, config);
}

function initSpeech() {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  const Utterance = typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : null;
  if (!synth || !Utterance) {
    state.speech = { synth: null, voices: [], voice: null, available: false };
    return;
  }
  state.speech = { synth, SpeechSynthesisUtterance: Utterance, voices: [], voice: null, available: true };
  refreshVoices();
  // 首次拿到的列表可能是空的，语音加载完会触发这个事件
  if (typeof synth.addEventListener === 'function') {
    synth.addEventListener('voiceschanged', () => {
      refreshVoices();
      if (state.drawerOpen) renderSpeechRow();
    });
  }
}

function renderSpeechRow() {
  const speech = state.settings && state.settings.speech;
  if (!el.speechEnabled) return;
  el.speechEnabled.checked = Boolean(speech && speech.enabled);
  el.speechEnabled.disabled = !state.speech || !state.speech.available;
  if (el.muteBtn) {
    const muted = Boolean(speech && speech.muted);
    el.muteBtn.textContent = muted ? '🔇 已静音' : '🔊 开启';
    el.muteBtn.classList.toggle('muted', muted);
    el.muteBtn.disabled = !state.speech || !state.speech.available;
  }
  document.title = state.speech && state.speech.available ? `直播AI搭档-悬浮窗 · ${voiceSummary()}` : '直播AI搭档-悬浮窗';
}

// ------------------------------------------------------------ 工具

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function shortName(name) {
  return String(name || '').replace(/\.[a-z0-9]+$/i, '').trim();
}

// ------------------------------------------------------------ 吉祥物

function pickMascotImage(emotion) {
  const mascot = (state.settings && state.settings.mascot) || {};
  return shared.pickMascotImage(mascot, emotion);
}

function renderMascot() {
  const mascot = (state.settings && state.settings.mascot) || {};
  const image = pickMascotImage(state.emotion);

  if (image) {
    if (el.mascotImg.getAttribute('src') !== image) el.mascotImg.setAttribute('src', image);
    el.mascotImg.classList.remove('hidden');
    el.mascotEmoji.classList.add('hidden');
  } else {
    el.mascotImg.removeAttribute('src');
    el.mascotImg.classList.add('hidden');
    el.mascotEmoji.classList.remove('hidden');
    el.mascotEmoji.textContent = mascot.fallbackEmoji || '🦊';
  }

  // 吉祥物下面那行名字牌（原来显示 persona.botName）在 2026-10-19 按主播要求整个去掉了：
  // 悬浮窗上只留吉祥物本身。她的名字在「对话区」里还照常显示（每条 AI 回复的作者名）。
  el.copilot.classList.toggle('no-animation', mascot.animation === false);
}

function setEmotion(emotion) {
  state.emotion = emotion || 'idle';
  renderMascot();
}

// ------------------------------------------------------------ 按回复里的标记演表情
//
// AI 的回复里可以插若干 `[情绪:xxx]` 标记（句首、句中、句末都行），
// 这里按标记出现的先后顺序**依次**切换表情，让「先惊讶再开心」这种语气变化看得出来。
// 一个标记演多久跟回复长度挂钩：短回复 2.2 秒一个，长回复最多 4 秒一个。

/** 每个表情大概演多久（毫秒），会按回复长度微调 */
function emotionHoldMs(text) {
  const length = String(text || '').length;
  return Math.max(1600, Math.min(4000, 1200 + length * 40));
}

/** 停掉正在演的表情序列（新回复来了、睡着、开始思考时都要清） */
function stopEmotionScript() {
  if (state.emotionTimer) {
    clearTimeout(state.emotionTimer);
    state.emotionTimer = null;
  }
  if (state.emotionIdleTimer) {
    clearTimeout(state.emotionIdleTimer);
    state.emotionIdleTimer = null;
  }
  state.emotionQueue = [];
}

/** 演第 index 个表情，演完接着演下一个，全部演完就回平常 */
function playEmotionStep(text, index) {
  const queue = state.emotionQueue;
  if (!queue.length || index >= queue.length) {
    state.emotionTimer = null;
    setEmotion('idle');
    return;
  }
  const key = queue[index];
  // 说话中就别抢了：talking 更该显示
  if (key && key !== 'talking') setEmotion(key);
  state.emotionTimer = setTimeout(() => playEmotionStep(text, index + 1), emotionHoldMs(text));
}

/**
 * 演一串表情（回复里标记的顺序）。
 *
 * @param {{text?:string, emotion?:string, emotions?:Array<{key:string}>}} reply
 */
function playEmotionScript(reply) {
  stopEmotionScript();
  // 以 emotions 数组为准（它是主进程解析出来的完整顺序）。
  // 只有在**完全没有这个字段**时才退回单个 emotion —— 比如测试或旧版本推进来的事件；
  // 空数组是「模型没给标记」的明确信号，这时应该回平常，不能再拿 emotion 顶上。
  let list = [];
  if (Array.isArray(reply.emotions)) {
    list = reply.emotions.map((item) => (item && item.key) || '').filter(Boolean);
  } else if (reply.emotion) {
    list = [reply.emotion];
  }
  if (!list.length) {
    // 模型没给标记：让表情回到平常，不要挂在上一轮的表情上
    setEmotion('idle');
    return;
  }
  state.emotionQueue = list;
  playEmotionStep(reply.text, 0);
}

// ------------------------------------------------------------ 状态的自动切换
//
// 12 个状态里，`pop`（突然出现）只由程序切：刚打开悬浮窗时蹦一下。
// `greet` / `sleep` 是 AI 能用、程序也在特定时机自动切的：
//   · 弹幕连接成功 → 打招呼
//   · 一段时间没人说话 → 睡着；来弹幕 / 有回复 → 醒过来

/** 多久没人说话就睡着 */
const SLEEP_AFTER_IDLE_MS = 120000;

/** 来动静了：醒过来，并重新开始算「多久没人理它」 */
function markActivity({ wake = true } = {}) {
  if (wake && state.emotion === 'sleep') {
    setEmotion('idle');
    // 醒过来时把上一轮没演完的表情清掉，免得睡着前的尾巴又冒出来
    stopEmotionScript();
  }
  if (state.sleepTimer) clearTimeout(state.sleepTimer);
  state.sleepTimer = setTimeout(() => {
    state.sleepTimer = null;
    // 已经睡着的不用重复切；正在说话 / 刚收到回复时也别打断
    if (state.emotion === 'sleep' || state.emotion === 'talking') return;
    if (state.emotionTimer || state.emotionQueue.length) return;
    setEmotion('sleep');
    renderMascot();
  }, SLEEP_AFTER_IDLE_MS);
}

/** 连接成功时打个招呼（只在「从没连上 → 连上」这一次切，重连时不反复打） */
function greetOnce() {
  if (state.greeted) return;
  state.greeted = true;
  setEmotion('greet');
}

/**
 * 观众弹幕里命中了触发词 → 立刻切表情，不用等 AI 回复。
 *
 * 触发词表在配置里（`mascot.triggers`），内置了一套默认词，
 * 主播可以在控制面板改，也可以直接跟 AI 说「以后谁发『草』你就笑」让它记下来。
 *
 * 顺序很重要：先 `markActivity()`（会清掉睡眠状态并顺带清掉上一轮没演完的表情），
 * 再切触发词的状态——反过来的话刚切的表情会立刻被 markActivity 冲掉。
 */
function applyTriggerEmotion(text) {
  const mascot = (state.settings && state.settings.mascot) || {};
  // 第三个参数是用户自定义的表情表：没有它，「生气」这类自定义状态的触发词永远命中不了
  const key = shared.findDanmakuEmotion(mascot.triggers, text, mascot.customEmotions);
  if (!key) return false;
  markActivity();
  setEmotion(key);
  return true;
}

function applyBotState(value) {
  state.botState = value || 'idle';
  el.copilot.classList.toggle('thinking', state.thinking || state.botState === 'thinking');
  if (!state.thinking) {
    const map = { listening: 'listening', idle: 'idle' };
    // 正在演回复里的表情时不要被 bot-state 抢走（否则刚切的表情立刻被冲掉）
    if (map[state.botState] && !state.emotionTimer && !state.emotionQueue.length) {
      setEmotion(map[state.botState]);
    }
  }
}

function flashSpeaking() {
  el.copilot.classList.add('speaking');
  clearTimeout(state.speakingTimer);
  state.speakingTimer = setTimeout(() => el.copilot.classList.remove('speaking'), 600);
}

// ------------------------------------------------------------ 回复文本
//
// 吉祥物上方那一块，显示 AI 刚说的话（可选带上观众原话）。
// 只有一个，不排队：新回复覆盖旧回复，换内容闪一下，
// 超过「回复停留」时间没有新内容就淡出。

/** 搭档的名字（回复文本里的主语） */
function botName() {
  return (state.settings && state.settings.persona && state.settings.persona.botName) || '小助手';
}

function ensureReplyNode() {
  if (state.replyNode || !el.replyBox) return state.replyNode;
  const node = document.createElement('div');
  node.className = 'reply';
  node.hidden = true;

  const viewer = document.createElement('div');
  viewer.className = 'reply-viewer';
  viewer.hidden = true;
  const text = document.createElement('div');
  text.className = 'reply-text';
  node.append(viewer, text);
  el.replyBox.appendChild(node);
  state.replyNode = node;
  return node;
}

/**
 * 显示 / 更新回复文本。
 * @param {{text:string, emotion?:string, viewerText?:string}} payload
 */
function showReply(payload) {
  const node = ensureReplyNode();
  if (!node) return null;
  const overlay = (state.settings && state.settings.overlay) || {};
  const text = String((payload && payload.text) || '').trim();
  if (!text) return null;

  // 新内容作废上一轮排下的停留计时与淡出动作
  state.replyToken += 1;
  cancelReplyHide();

  const textNode = node.querySelector('.reply-text');
  const viewerNode = node.querySelector('.reply-viewer');
  const viewerText = String((payload && payload.viewerText) || '');
  const wantViewerCaption = Boolean(viewerText) && overlay.showViewerMessage !== false;

  const changed =
    textNode.textContent !== text ||
    (viewerNode.hidden ? '' : viewerNode.textContent) !== (wantViewerCaption ? viewerText : '');

  textNode.textContent = text;
  if (wantViewerCaption) {
    viewerNode.textContent = viewerText;
    viewerNode.hidden = false;
  } else {
    viewerNode.textContent = '';
    viewerNode.hidden = true;
  }

  if (node.hidden) {
    node.hidden = false;
    node.classList.remove('leaving');
  }
  if (changed) {
    node.classList.remove('reply-flash');
    void node.offsetWidth; // 强制重排，好让动画能重新触发
    node.classList.add('reply-flash');
  }

  restartReplyIdleTimer();
  renderLayout({ chat: false });
  return node;
}

/** 隐藏回复文本（保留节点复用） */
function hideReply() {
  const node = state.replyNode;
  if (!node || node.hidden) return;
  node.classList.add('leaving');
  clearTimeout(state.replyHideTimer);
  // 记下「这次隐藏针对的是哪一代内容」：动画跑完时如果内容已经换代，
  // 就说明中间来了新回复，这次隐藏作废——否则刚写进去的回复会被藏掉。
  const token = state.replyToken;
  state.replyHideTimer = setTimeout(() => {
    state.replyHideTimer = null;
    if (token !== state.replyToken) return;
    node.hidden = true;
    node.classList.remove('leaving', 'reply-flash');
    renderLayout({ chat: false });
  }, 400);
  renderLayout({ chat: false });
}

/** 取消正在进行的隐藏（有新内容要显示时必须先调它） */
function cancelReplyHide() {
  clearTimeout(state.replyHideTimer);
  state.replyHideTimer = null;
  if (state.replyNode) state.replyNode.classList.remove('leaving');
}

/** 每次换内容都重新计时：一段时间没有新内容就淡出 */
function restartReplyIdleTimer() {
  clearTimeout(state.replyIdleTimer);
  if (!state.replyNode) return;
  const overlay = (state.settings && state.settings.overlay) || {};
  // 开了「回复气泡不自动消失」就压根不排这个计时器：
  // 内容会一直留着，等下一条回复把它顶掉（主播要的就是这个）。
  if (overlay.replyPersist === true) {
    state.replyIdleTimer = null;
    return;
  }
  const seconds = Math.min(600, Math.max(3, Number(overlay.replySeconds) || 22));
  const token = state.replyToken;
  state.replyIdleTimer = setTimeout(() => {
    state.replyIdleTimer = null;
    if (token !== state.replyToken) return; // 上一轮内容排下的计时，中途有新内容就作废
    hideReply();
  }, seconds * 1000);
}

/**
 * 「回复气泡不自动消失」的界面联动（2026-10-19 加的）。
 *
 * 开着的时候「回复停留秒数」那个滑杆其实没用了，所以把它**禁用**并改成灰的——
 * 留一个能拖但完全没效果的滑杆，比不给还让人困惑。滑杆右边那行也改成「常驻」。
 */
function applyReplyPersistUi(overlay) {
  const on = (overlay || {}).replyPersist === true;
  if (replyPersistCheckbox) replyPersistCheckbox.checked = on;
  if (sliders.replySeconds) {
    sliders.replySeconds.disabled = on;
    sliders.replySeconds.classList.toggle('dimmed', on);
  }
  if (outputs.replySeconds) {
    outputs.replySeconds.textContent = on ? '常驻' : `${sliders.replySeconds.value}s`;
  }
}

/**
 * 念一条回复：先念观众原话（如果开了「连观众原话一起念」），
 * **停 0.5 秒**再念 AI 的回复。
 *
 * 为什么要留这一点停顿：两句话连在一起念，观众听不出哪句是弹幕、哪句是搭档，
 * 断一下才有「先有人说话、然后搭档接话」的感觉。
 * （原先给的是 1 秒，主播实测觉得太长，改成 0.5 秒。）
 *
 * 串成两条 utterance 而不是拼成一句文本，是因为拼接后中间那个停顿只能是标点，
 * 控不了具体多长。
 */
const VIEWER_REPLY_SPEECH_GAP_MS = 500;

async function speakViewerThenReply(viewerText, replyText) {
  const replyContent = String(replyText || '').trim();
  const viewerContent = String(viewerText || '').trim();

  // 静音/关了语音时 speak 会返回 false；这时不去拆分朗读，
  // 保持原来「一次念完」的判断路径，免得静音状态下的行为跟着变
  if (viewerContent && replyContent) {
    const started = await speak(viewerContent);
    if (started) {
      if (state.speakGapTimer) clearTimeout(state.speakGapTimer);
      state.speakGapTimer = setTimeout(() => {
        state.speakGapTimer = null;
        speak(replyContent);
      }, VIEWER_REPLY_SPEECH_GAP_MS);
      return;
    }
  }
  speak([viewerContent, replyContent].filter(Boolean).join(' '));
}

/** AI 回复来了：显示文本 + 切表情 + 进对话区 + 念出来 */
function onReply(reply) {
  const overlay = (state.settings && state.settings.overlay) || {};
  let viewerText = '';
  if (overlay.showViewerMessage !== false && state.latestViewer && reply.source !== 'operator') {
    viewerText = `${state.latestViewer.user}说：${state.latestViewer.text}`;
  }
  showReply({ text: reply.text || '', viewerText });

  flashSpeaking();
  // 有回复说明人还在，先醒过来再按情绪切图（睡着时不该继续挂着睡觉的图）
  markActivity();
  // 按回复里标记的先后顺序演表情（一个都没有时回到平常）
  playEmotionScript(reply);
  // 回复文本会淡出，对话区可以往回翻
  chatAdd('ai', botName(), reply.text, {
    dedup: `ai:${reply.id || `${reply.ts}:${reply.text}`}`
  });

  // 念出来：默认只念 AI 的话；开了「连观众原话一起念」就先念原话、停一下再念回复。
  // 先 stopSpeech 一下：除了打断上一条，也要清掉上一条还没到点的那个停顿等待，
  // 否则两条回复的朗读会叠在一起
  stopSpeech();
  const speechConfig = (state.settings && state.settings.speech) || {};
  const viewerLine =
    speechConfig.readViewer && state.latestViewer && reply.source !== 'operator'
      ? `${state.latestViewer.user}说：${state.latestViewer.text}`
      : '';
  speakViewerThenReply(viewerLine, reply.text);
}

// ------------------------------------------------------------ 布局与窗口尺寸
//
// 悬浮窗本身就是一个小窗口（只有卡片这么大）：
//   · 只有卡片区域会接收鼠标，天然不会挡住别的软件
//   · 拖动由系统处理（顶部那一行是拖动区），不需要自己算坐标
//   · 窗口高度跟着内容走：回复文本区 + 吉祥物 + 对话区

const HEADER_HEIGHT = 34;
// 对话区高度的上下限，和抽屉里那个滑杆的 min/max 一致（settings.js 也按 120~520 收敛）
const CHAT_MIN_HEIGHT = 120;
const CHAT_MAX_HEIGHT = 560;

/**
 * 正在拖边缩放时，「窗口该多大」由**鼠标**说了算，不归布局算。
 *
 * ⚠️ 这个函数就是「拉动时在原尺寸和拉动尺寸之间闪烁」的根因补丁：
 * `window.addEventListener('resize', renderLayout)` 会在每次窗口变化时重算布局，
 * 而布局用的是配置里**还没更新**的裸高/宽 → 它把窗口改回旧尺寸 → 又触发 resize → 再改回去……
 * 一秒来回几十次，肉眼看到的就是闪。
 *
 * 所以：拖动期间（以及松手后等配置写回的那一小会儿）布局只重排内容，**不许碰窗口尺寸**。
 */
function activeSizeOverride() {
  if (resizeState && resizeState.latest) return resizeState.latest;
  return pendingResize;
}

function computeLayout() {
  const overlay = (state.settings && state.settings.overlay) || {};
  // 拖动中/刚松手：尺寸以鼠标拖出来的为准（见 activeSizeOverride 的说明）
  const override = activeSizeOverride();
  const width = clamp(Number((override && override.width) || overlay.width) || 460, 220, 1400);
  // `overlay.height` 既是"内容最多长到多高"，也是"固定高度模式下就是多高"
  const heightCap = clamp(Number((override && override.height) || overlay.height) || 620, 200, 1600);
  const fixedHeight = Boolean(override) || overlay.heightMode === 'fixed';
  const mascotWidth = clamp(Number(overlay.mascotWidth) || 200, 60, width);

  el.copilot.style.fontSize = `${clamp(Number(overlay.fontScale) || 1, 0.5, 2.5) * 15}px`;
  el.copilot.style.opacity = String(clamp(Number(overlay.opacity) || 1, 0.1, 1));
  el.mascot.style.width = `${mascotWidth}px`;

  const chatOn = overlay.chatEnabled !== false;
  el.copilot.classList.toggle('chat-on', chatOn);
  // 设置里那个"对话区高度"（滑杆）是**期望值**，只在「跟随内容」模式里直接生效；
  // 「固定高度」模式里对话区吃剩下的空间（见下面 chatHeight 的算法）。
  const chatPreferred = chatOn
    ? clamp(Math.round(Number(overlay.chatHeight) || 210), CHAT_MIN_HEIGHT, CHAT_MAX_HEIGHT)
    : 0;

  const mascotHeight = el.mascot.offsetHeight || 160;
  const bodyPadding = 18;
  // 对话区自己的 margin-top（见 overlay.css 的 .chat-panel），算高度时不能漏，否则会差 8px 被裁掉
  const chatMargin = chatOn ? 8 : 0;
  const maxReplyHeight = Math.max(
    40,
    heightCap - HEADER_HEIGHT - mascotHeight - chatPreferred - chatMargin - bodyPadding
  );
  // 回复文本区高度 = 实际内容高度（隐藏时是 0），并且不许超过卡片能给的上限
  const rawReplyHeight = state.replyNode ? state.replyNode.offsetHeight || 0 : 0;
  const replyHeight = Math.round(Math.min(rawReplyHeight, maxReplyHeight));
  if (state.replyNode) state.replyNode.style.maxHeight = `${maxReplyHeight}px`;

  // 对话区高度：
  //   跟随内容 = 就用设置里的值（窗口按内容长，滑杆说了算）；
  //   固定高度 = 窗口高 - 顶栏 - 吉祥物 - 回复 - 内边距，也就是**把剩下的空间全部吃掉**。
  // 2026-10-19 主播反馈：「高度改变时，聊天框并没有随着高度改变」。
  // 以前两种模式都把对话区钉死在设置值上，多出来的空间全堆在卡片底部（看着像聊天空着一块）；
  // 现在固定高度模式下窗口拉多高、对话区就有多高——回复区已经预留了 chatPreferred，
  // 所以 leftoverChat 永远 ≥ chatPreferred，拉高窗口的增量 100% 落到对话区。
  const leftoverChat = Math.round(
    heightCap - HEADER_HEIGHT - bodyPadding - chatMargin - mascotHeight - replyHeight
  );
  const chatHeight = chatOn
    ? fixedHeight
      ? Math.max(CHAT_MIN_HEIGHT, leftoverChat)
      : chatPreferred
    : 0;
  if (el.chatPanel) el.chatPanel.style.height = `${chatHeight}px`;

  const contentHeight = Math.round(
    HEADER_HEIGHT + bodyPadding + mascotHeight + replyHeight + chatMargin + chatHeight
  );
  // 两种高度模式（见 settings.js 的 heightMode）：
  //   content = 跟着内容走（回复长了窗口变高），最高 heightCap；
  //   fixed   = 就是 heightCap，回复再长也在回复区里滚动（用户从四边拖过高度就会切到这个）。
  const height = fixedHeight
    ? Math.round(heightCap)
    : clamp(contentHeight, HEADER_HEIGHT + 60, heightCap);

  state.layout = { width, height, chatHeight, mascotHeight, replyHeight };
  // 内容算出来的尺寸 → **只改大小，不动位置**：主播把窗口拖到哪就待在哪，
  // 不能因为来了一条回复就把它拽回屏幕里（2026-10-19 修的这个 bug）。
  // 拖动中则连尺寸都别改（否则和鼠标抢，见 activeSizeOverride）。
  if (!override) applyWindowBounds({ position: 'keep', clamp: 'visible' });
  return state.layout;
}
/** 窗口当前的真实位置（屏幕坐标）；拿不到就返回 null */
function liveWindowPosition() {
  const x = Number(window.screenX);
  const y = Number(window.screenY);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 把 `state.windowBounds` 的**位置**对齐到窗口真实位置（尺寸沿用缓存/布局值）。
 *
 * `state.windowBounds` 是「渲染层上次告诉主进程的窗口框」，位置只在每次布局时顺手读一次
 * `window.screenX/screenY`。主播用顶栏把窗口拖走之后，如果那之后没再跑过布局
 * （没来回复、没改设置），缓存里就还是**旧位置**——拖边缩放拿它当起点，
 * 第一次 mousemove 就会把窗口摆回旧位置，鼠标相对窗口的坐标同时突变 → 又弹又闪
 * （2026-10-19 主播报的 bug：“拖到其它位置后再改高度会立刻回到一开始的位置并闪烁”）。
 */
function syncWindowBoundsPosition() {
  const live = liveWindowPosition();
  if (!live) return false;
  const known = state.windowBounds || {};
  const layout = state.layout || {};
  state.windowBounds = {
    x: live.x,
    y: live.y,
    width: Number(known.width) || Number(layout.width) || 460,
    height: Number(known.height) || Number(layout.height) || 620
  };
  return true;
}

/**
 * 调整窗口位置 / 大小。
 *
 * @param {{position?:'keep'|'set', clamp?:'visible'|'inside'}} [options]
 *   `position: 'keep'` = 只改宽高，位置一个字节都不动（自动布局用这个）；
 *   `position: 'set'`  = 按 `x/y` 定位（首次定位 / 重置 / 用户拖动结束）。
 *   `clamp: 'visible'` 只保证至少留 48px 在屏幕内，允许大半在屏幕外；
 *   `clamp: 'inside'`  完整夹进屏幕（首次定位和重置用，免得把窗口丢到看不见的地方）。
 */
function applyWindowBounds({ anchorTop = true, position = 'set', clamp: clampMode = 'inside' } = {}) {
  if (!window.api || !window.api.window || !window.api.window.setBounds) return;
  // 拖动缩放期间窗口尺寸归鼠标管：这里要是也调 setBounds，就会和鼠标抢 →
  // 「原尺寸 / 拉动尺寸」来回闪（resize 事件 → 布局 → 改回旧尺寸 → 又 resize）。
  if (activeSizeOverride()) return;
  const overlay = (state.settings && state.settings.overlay) || {};
  const layout = state.layout || {};
  const width = layout.width || 460;
  const height = layout.height || 620;

  // 首次定位用比例；之后以窗口当前实际位置为准（用户拖动过就跟着用户）
  const live = liveWindowPosition();
  const useCurrent = state.windowPositioned && Boolean(live);
  // 第一次定位必须真的把窗口放进去（否则「比例」白配了），后面才轮到 keep
  const effectivePosition = state.windowPositioned ? position : 'set';
  const effectiveClamp = effectivePosition === 'keep' ? clampMode : useCurrent ? clampMode : 'inside';
  const screenWidth = window.screen ? window.screen.availWidth || 1920 : 1920;
  const screenHeight = window.screen ? window.screen.availHeight || 1080 : 1080;
  const cached = state.windowBounds || {};
  let x;
  let y;
  if (useCurrent) {
    x = live.x;
    y = live.y;
  } else if (effectivePosition === 'keep' && Number.isFinite(cached.x) && Number.isFinite(cached.y)) {
    // 自动布局（只改大小）又读不到真实位置：位置照旧。
    // 千万不能退回「按比例现算」——那等于把主播摆好的窗口挪走。
    x = cached.x;
    y = cached.y;
  } else {
    x = Math.round(clamp(Number(overlay.posXRatio) || 0.76, 0, 1) * screenWidth - width / 2);
    y = Math.round(clamp(Number(overlay.posYRatio) || 0.55, 0, 1) * screenHeight - height);
  }

  state.windowPositioned = true;
  // 记下"我们最后告诉主进程的窗口框"：拖边缩放时要拿它当起点。
  // 不能用 window.screenX 当唯一来源——它可能滞后，或者在某些环境下根本取不到。
  state.windowBounds = { x, y, width, height };
  window.api.window.setBounds({
    x,
    y,
    width,
    height,
    anchorTop,
    position: effectivePosition,
    clamp: effectiveClamp,
    screenWidth,
    screenHeight
  });
}

/**
 * 重算布局。
 * @param {{chat?: boolean}} [options] chat=false 时不动对话区的滚动位置。
 * 回复文本换内容也会触发布局重算，那时把对话区拽回底部会打断正在翻旧记录的观众。
 */
function renderLayout(options = {}) {
  const repinChat = options.chat !== false;
  requestAnimationFrame(() => {
    computeLayout();
    // 窗口高度/对话区高度可能变了，原来贴在底部的要重新贴一次
    if (repinChat) chatRepinAfterLayout();
  });
}

// ------------------------------------------------------------ 拖动（交给系统）
//
// 顶部那一行用 -webkit-app-region: drag 让系统接管拖动，所以不用自己算坐标。
// 拖动结束后把新位置换算成比例存起来，下次启动还在原地。
//
// 2026-10-19 加了「锁定窗口位置」（顶栏 🔒）：锁定时给卡片加 `.locked` 类，
// CSS 把顶栏的 app-region 改成 no-drag —— 位置就拖不动了。这里只负责读写状态。

/** 窗口位置是不是锁着（主播点过 🔒） */
function isWindowLocked() {
  const overlay = (state.settings && state.settings.overlay) || {};
  return overlay.locked === true;
}

/**
 * 顶栏两个开关按钮的样子：置顶 📌 / 锁定 🔒，亮着 = 开着。
 * 标题也一起改，不然光看图标分不清「现在是置顶还是点了才置顶」。
 */
function renderWindowChrome() {
  const overlay = (state.settings && state.settings.overlay) || {};
  const pinned = overlay.alwaysOnTop !== false; // 默认是开着的
  const locked = overlay.locked === true;
  if (el.pinBtn) {
    el.pinBtn.classList.toggle('active', pinned);
    el.pinBtn.title = pinned ? '已置顶（点一下取消）' : '置顶（永远显示在最前面）';
    el.pinBtn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  }
  if (el.lockBtn) {
    el.lockBtn.classList.toggle('active', locked);
    el.lockBtn.textContent = locked ? '🔒' : '🔓';
    el.lockBtn.title = locked ? '窗口位置已锁定（点一下解锁）' : '锁定窗口位置（防止拖动）';
    el.lockBtn.setAttribute('aria-pressed', locked ? 'true' : 'false');
  }
  if (el.copilot) el.copilot.classList.toggle('locked', locked);
}

/**
 * 抽屉里那行「窗口高度」（2026-10-19）。
 *
 * 从四条边拖过高度之后会自动切到「固定」——所以必须给一个切回「跟随内容」的入口，
 * 否则主播拖了一次就再也回不到「回复长了窗口自己变高」的老行为，还以为功能坏了。
 */
function renderHeightModeUi(overlay) {
  const fixed = (overlay || {}).heightMode === 'fixed';
  const hint = document.getElementById('heightModeHint');
  const button = document.getElementById('resetHeightMode');
  if (hint) hint.textContent = fixed ? `固定 ${Math.round(Number(overlay.height) || 620)}px` : '跟随内容';
  if (button) button.hidden = !fixed;
}

function rememberWindowPosition() {
  // 锁定的唯一目的就是「别让它动」，所以这时候也别因为别的操作把位置写回配置
  if (isWindowLocked()) return;
  const live = liveWindowPosition();
  if (!live) return;
  // 顺手把缓存的窗口框对齐到真实位置：拖边缩放靠它算起点，过期了就会"弹回原位"
  syncWindowBoundsPosition();
  const screenWidth = window.screen ? window.screen.availWidth || 1920 : 1920;
  const screenHeight = window.screen ? window.screen.availHeight || 1080 : 1080;
  const posXRatio = clamp(live.x / screenWidth, 0, 1);
  const posYRatio = clamp(live.y / screenHeight, 0, 1);
  syncSliders({ posXRatio, posYRatio });
  window.api.settings.update({ overlay: { posXRatio, posYRatio } });
}

function resetWindowPosition() {
  state.windowPositioned = false;
  // 重置是「用户明确要求回到默认位置」：完整夹进屏幕，别又留在半屏幕外
  applyWindowBounds({ position: 'set', clamp: 'inside' });
  if (window.api && window.api.settings) {
    window.api.settings.update({ overlay: { posXRatio: 0.76, posYRatio: 0.55 } });
  }
  syncSliders({ posXRatio: 0.76, posYRatio: 0.55 });
}

// ------------------------------------------------------------ 缩放（四条边 + 四个角，2026-10-19）

/**
 * 拖边角改窗口大小。
 *
 * 为什么不用 CSS / 系统的 `resizable`：
 *   · 无边框窗口用系统边框拖：Windows 上边框只有一两像素，几乎点不中；
 *   · 也不能用 CSS `resize`：它是改元素尺寸，不会带动 Electron 窗口。
 * 所以自己做抓手 + 自己算新尺寸，再通过 `window:setBounds` 把窗口改掉。
 *
 * 三个细节：
 *   1. **指针捕获**（`setPointerCapture`）：鼠标拖出窗口外也要继续收到 mousemove，
 *      否则边框一拖快就"断掉"、松手都不知道；
 *   2. **锁定窗口位置时整组禁用**（CSS + JS 双保险）：主播要的是"锁上就别动"，
 *      这时候还能改大小就自相矛盾了；
 *   3. 拖完**切到固定高度模式**（`heightMode='fixed'`）：不然松手那一刻
 *      `computeLayout` 又按内容高度把窗口改回去，主播会觉得"拖了个寂寞"。
 */
const RESIZE_MIN_WIDTH = 260;
const RESIZE_MIN_HEIGHT = 220;

let resizeState = null;
/** 松手后等配置写回的这段时间里，临时记住拖出来的尺寸（见 activeSizeOverride） */
let pendingResize = null;

function bindResizeHandles() {
  // 用卡片节点查（不是 document）：抓手就在卡片里面，
  // 而且这样 `test-ui.js` 的迷你 DOM 也能真的取到这 8 个抓手来做测试。
  const root = el.copilot || (typeof document !== 'undefined' ? document.body : null);
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const handles = root.querySelectorAll('.resize-handle');
  for (const handle of handles) {
    handle.addEventListener('mousedown', (event) => startResize(handle, event));
  }
}

function startResize(handle, event) {
  if (!event || event.button !== 0) return;
  if (isWindowLocked()) return; // 🔒 锁着的时候抓手不可用
  const dir = String((handle.dataset && handle.dataset.dir) || '');
  if (!dir) return;
  event.preventDefault?.();

  // 起点坐标以窗口**真实位置**为准：`state.windowBounds` 只是上次布局时记下的，
  // 主播用顶栏拖过窗口之后它可能已经过期 —— 拿过期坐标当起点，一拖边框窗口就"弹回原位"。
  syncWindowBoundsPosition();
  const layout = state.layout || {};
  const known = state.windowBounds || {};
  const screenX = Number(event.screenX);
  const screenY = Number(event.screenY);
  const start = {
    x: Number.isFinite(known.x) ? known.x : 0,
    y: Number.isFinite(known.y) ? known.y : 0,
    width: Number(known.width) || Number(layout.width) || 460,
    height: Number(known.height) || Number(layout.height) || 620,
    cursorX: Number(event.clientX) || 0,
    cursorY: Number(event.clientY) || 0,
    // 鼠标的**屏幕**坐标：拖动时窗口会跟着鼠标走，clientX/clientY（相对窗口）几乎不变，
    // 只有屏幕坐标才是"鼠标真的移动了多少"。
    cursorScreenX: Number.isFinite(screenX) ? screenX : null,
    cursorScreenY: Number.isFinite(screenY) ? screenY : null
  };
  resizeState = { dir, start, latest: null, raf: null };

  if (typeof handle.setPointerCapture === 'function' && event.pointerId !== undefined) {
    try {
      handle.setPointerCapture(event.pointerId);
    } catch (_) {
      /* 拿不到捕获就退回 document 监听，能拖多少算多少 */
    }
  }
  if (typeof document.addEventListener !== 'function') return;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd, { once: true });
}

function onResizeMove(event) {
  if (!resizeState) return;
  const { dir, start } = resizeState;
  // 位移用**屏幕坐标**算：拖左/上边时窗口跟着鼠标走，`clientX/clientY`（相对窗口）几乎不变，
  // 用它算出来的位移永远是 0（拖不动）；而且窗口一被主进程夹回屏幕内，clientY 又会突变 → 高度乱跳。
  const screenX = Number(event.screenX);
  const screenY = Number(event.screenY);
  const dx =
    start.cursorScreenX !== null && Number.isFinite(screenX)
      ? screenX - start.cursorScreenX
      : (Number(event.clientX) || 0) - start.cursorX;
  const dy =
    start.cursorScreenY !== null && Number.isFinite(screenY)
      ? screenY - start.cursorScreenY
      : (Number(event.clientY) || 0) - start.cursorY;

  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;

  if (dir.includes('e')) width = start.width + dx;
  if (dir.includes('w')) {
    width = start.width - dx;
    x = start.x + dx;
  }
  if (dir.includes('s')) height = start.height + dy;
  if (dir.includes('n')) {
    height = start.height - dy;
    y = start.y + dy;
  }

  // 缩到最小尺寸时，拖左/上边的情况要把 x/y 钉住（否则窗口会往反方向跑）
  if (width < RESIZE_MIN_WIDTH) {
    if (dir.includes('w')) x = start.x + (start.width - RESIZE_MIN_WIDTH);
    width = RESIZE_MIN_WIDTH;
  }
  if (height < RESIZE_MIN_HEIGHT) {
    if (dir.includes('n')) y = start.y + (start.height - RESIZE_MIN_HEIGHT);
    height = RESIZE_MIN_HEIGHT;
  }

  const bounds = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
  resizeState.latest = bounds;
  // 用 rAF 节流：mousemove 一帧可能来好几次，每次都 setBounds 会闪。
  // ⚠️ 先把标记置上、再排队（而不是 `state.raf = rAF(cb)`）：有些环境（测试里的假 rAF）是**同步**回调的，
  // 那样 cb 里清完标记之后，外面这行赋值又把标记写回去了，从此再也不更新（拖第二次就不动）。
  if (resizeState.raf) return;
  resizeState.raf = true;
  const applyOnce = () => {
    if (!resizeState) return;
    resizeState.raf = false;
    applyResizeBounds();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(applyOnce);
  else applyOnce();
}

function applyResizeBounds() {
  if (!resizeState || !resizeState.latest) return;
  const bounds = resizeState.latest;
  // 只有拖了**左/上边**才需要移动窗口；拖右/下边（最常见的就是"改高度"）位置一个字节都不该变。
  // 所以右/下边用 position:'keep'：主进程那边连 x/y 都不看，窗口想被挪回旧位置都没机会——
  // 这正是「拖过悬浮窗之后再改高度会弹回原位」的根治办法（2026-10-19 主播报的 bug）。
  const movesPosition = resizeState.dir.includes('w') || resizeState.dir.includes('n');
  const known = state.windowBounds || {};
  const x = movesPosition ? bounds.x : Number.isFinite(known.x) ? known.x : bounds.x;
  const y = movesPosition ? bounds.y : Number.isFinite(known.y) ? known.y : bounds.y;
  state.layout = { ...(state.layout || {}), width: bounds.width, height: bounds.height };
  state.windowPositioned = true;
  state.windowBounds = { x, y, width: bounds.width, height: bounds.height };
  // `clamp:'visible'`：允许主播把窗口拖到屏幕边缘之外，只保证还留 48px 能抓住
  window.api.window.setBounds({
    x,
    y,
    width: bounds.width,
    height: bounds.height,
    position: movesPosition ? 'set' : 'keep',
    clamp: 'visible'
  });
  // 顺便按新尺寸重排一次内容（回复区能用的高度跟着变）。
  // ⚠️ 这时 `activeSizeOverride()` 有值，所以 computeLayout 只重排、**不会**再调 setBounds。
  computeLayout();
}

function onResizeEnd() {
  const finished = resizeState;
  resizeState = null;
  if (typeof document.removeEventListener === 'function') document.removeEventListener('mousemove', onResizeMove);
  if (!finished || !finished.latest) return;
  const { width, height } = finished.latest;
  const vertical = finished.dir.includes('n') || finished.dir.includes('s');
  const patch = { width, height };
  // 拖了上下边 = 主播想要这个高度，那就锁定高度（不然下一次布局又按内容改回去）
  if (vertical) patch.heightMode = 'fixed';
  // 松手到配置写回之间还有一小段时间：这段也用 pendingResize 把尺寸定住，
  // 否则这期间的 resize 事件会让窗口先跳回旧尺寸、再跳回来（松手时闪一下）。
  pendingResize = { width, height };
  Promise.resolve(window.api.settings.update({ overlay: patch }))
    .catch(() => {})
    .then(() => {
      pendingResize = null;
      computeLayout();
    });
  // 拖左上边会连带改位置，顺手记一次（和拖动顶栏是同一套比例存储）
  setTimeout(rememberWindowPosition, 60);
}

function bindDragArea() {
  if (!el.header) return;
  // 系统拖动结束后 mouseup 会回到这里，用它来记住位置
  el.header.addEventListener('mouseup', () => {
    state.dragging = false;
    el.copilot.classList.remove('dragging');
    setTimeout(rememberWindowPosition, 60);
  });
  el.header.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    // 锁定位置时不要摆出"在拖"的样子（真正的拖动由 CSS 的 app-region 关掉）
    if (isWindowLocked()) return;
    state.dragging = true;
    el.copilot.classList.add('dragging');
  });
  // 双击标题栏回到默认位置（锁定时也不许：主播可能只是双击想选中文字）
  el.header.addEventListener('dblclick', () => {
    if (isWindowLocked()) return;
    resetWindowPosition();
  });

  // 注意：这里「不要」根据鼠标位置切换鼠标穿透。
  // 窗口现在就只有卡片这么大，不存在挡住桌面其它软件的问题；
  // 而按位置切换会让鼠标移到窗口边缘（比如顶部那一行的按钮）时把整个窗口
  // 设成忽略鼠标事件，导致按钮点不动。穿透只由主进程按设置统一决定。
}


// ------------------------------------------------------------ 设置同步

function applySettings(settings, { fromMain = false } = {}) {
  const before = (state.settings && state.settings.speech) || {};
  state.settings = settings;
  const overlay = settings.overlay || {};
  const after = settings.speech || {};

  // 从设置里关掉语音 / 点静音 / 切换引擎时，正在念的内容要立刻停掉。
  // 以前只有点悬浮窗那个 🔊 按钮会停，从控制面板改设置不会——云端音频更明显（能播好几秒）。
  if (
    (before.enabled !== false && after.enabled === false) ||
    (before.muted !== true && after.muted === true) ||
    (before.engine || 'system') !== (after.engine || 'system')
  ) {
    stopSpeech();
  }

  // 语音设置可能刚刚才加载/被改动，这里重新挑一次音色
  if (state.speech && state.speech.available) selectVoice();

  sliders.posX.value = String(Math.round((overlay.posXRatio ?? 0.76) * 100));
  sliders.posY.value = String(Math.round((overlay.posYRatio ?? 0.55) * 100));
  sliders.mascotWidth.value = String(overlay.mascotWidth ?? 200);
  sliders.fontScale.value = String(overlay.fontScale ?? 1);
  sliders.opacity.value = String(overlay.opacity ?? 1);
  sliders.replySeconds.value = String(overlay.replySeconds ?? 22);
  showViewerCheckbox.checked = overlay.showViewerMessage !== false;
  applyReplyPersistUi(overlay);
  renderHeightModeUi(overlay);
  renderWindowChrome();
  updateOutputs();

  renderMascot();
  renderLayout();
  renderSpeechRow();
  renderChatUi();
  renderHeader();
}

/** 顶栏：显示搭档名字和当前状态 */
function renderHeader() {
  const settings = state.settings || {};
  const botName = (settings.persona && settings.persona.botName) || '搭档';
  if (el.headerTitle) el.headerTitle.textContent = botName;
  if (el.headerStatus) {
    const status = state.status || {};
    const danmaku = status.danmaku || {};
    if (status.paused) el.headerStatus.textContent = '已暂停';
    else if (danmaku.connected) el.headerStatus.textContent = '弹幕已连接';
    else if (danmaku.running) el.headerStatus.textContent = '连接中…';
    else el.headerStatus.textContent = '';
  }
}

/** 对话区的显示开关与高度 */
function renderChatUi() {
  const overlay = (state.settings && state.settings.overlay) || {};
  const chatOn = overlay.chatEnabled !== false;
  el.copilot.classList.toggle('chat-on', chatOn);
  // ⚠️ 这里**不再**直接写 el.chatPanel.style.height：
  // 高度由 computeLayout() 统一算（跟随内容 = 设置值，固定高度 = 剩下的空间），
  // 两处都写的话，设置一回写就把「固定高度模式下吃掉剩余空间」的结果盖回旧值。
  if (el.chatEnabled) el.chatEnabled.checked = chatOn;
  if (el.chatShowDanmaku) el.chatShowDanmaku.checked = overlay.chatShowDanmaku !== false;
  if (el.chatShowIds) el.chatShowIds.checked = overlay.chatShowIds === true;
  if (el.chatHeight) el.chatHeight.value = String(overlay.chatHeight || 210);
  const out = document.getElementById('chatHeightOut');
  if (out) out.textContent = `${overlay.chatHeight || 210}px`;
  if (chatOn && el.chatLog && !el.chatLog.childElementCount) chatEmptyHint();
  renderChatStatus();
  // 对话区刚被打开（display 从 none 变 flex）时滚一次，否则会停在最上面
  if (chatOn) chatRepinAfterLayout();
}

function updateOutputs() {
  outputs.posX.textContent = `${sliders.posX.value}%`;
  outputs.posY.textContent = `${sliders.posY.value}%`;
  outputs.mascotWidth.textContent = `${sliders.mascotWidth.value}px`;
  outputs.fontScale.textContent = `${Number(sliders.fontScale.value).toFixed(2)}×`;
  outputs.opacity.textContent = `${Math.round(Number(sliders.opacity.value) * 100)}%`;
  // 开了「回复气泡不自动消失」时，停留秒数没有意义，直接显示「常驻」
  const persist = Boolean(state.settings && state.settings.overlay && state.settings.overlay.replyPersist === true);
  outputs.replySeconds.textContent = persist ? '常驻' : `${sliders.replySeconds.value}s`;
}

function syncSliders(patch) {
  if (patch.posXRatio !== undefined) sliders.posX.value = String(Math.round(patch.posXRatio * 100));
  if (patch.posYRatio !== undefined) sliders.posY.value = String(Math.round(patch.posYRatio * 100));
  updateOutputs();
}

let saveTimer = null;
function saveSliderPatch(patch) {
  // 乐观更新：拖滑块要立刻看到效果，不能等「写设置 → 广播回来」这一整个往返
  if (state.settings && state.settings.overlay) Object.assign(state.settings.overlay, patch);
  updateOutputs();
  computeLayout();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.api.settings.update({ overlay: patch }), 120);
}

function bindSlider(slider, key, transform) {
  slider.addEventListener('input', () => {
    const raw = Number(slider.value);
    saveSliderPatch({ [key]: transform ? transform(raw) : raw });
  });
}

function bindUi() {
  bindSlider(sliders.posX, 'posXRatio', (value) => value / 100);
  bindSlider(sliders.posY, 'posYRatio', (value) => value / 100);
  bindSlider(sliders.mascotWidth, 'mascotWidth');
  bindSlider(sliders.fontScale, 'fontScale');
  bindSlider(sliders.opacity, 'opacity');
  bindSlider(sliders.replySeconds, 'replySeconds');

  showViewerCheckbox.addEventListener('change', () => {
    window.api.settings.update({ overlay: { showViewerMessage: showViewerCheckbox.checked } });
  });

  // 顶栏两个开关（2026-10-19 加的）。
  // 都是「改配置 → 主进程应用并广播回来 → applySettings 重画按钮」这一条路，
  // 这样面板上对应的勾选框也会同步（同一个配置，不是两套状态）。
  if (el.pinBtn) {
    el.pinBtn.addEventListener('click', () => {
      const overlay = (state.settings && state.settings.overlay) || {};
      const next = overlay.alwaysOnTop === false; // 现在是关的才置顶
      window.api.settings.update({ overlay: { alwaysOnTop: next } });
    });
  }
  if (el.lockBtn) {
    el.lockBtn.addEventListener('click', () => {
      const next = !isWindowLocked();
      window.api.settings.update({ overlay: { locked: next } });
    });
  }

  // 「回复气泡不自动消失」：勾上的瞬间就把正在排队的隐藏撤掉，
  // 否则已经在淡出的那一句会照样消失（主播会觉得"勾了没用，下一条才生效"）。
  if (replyPersistCheckbox) {
    replyPersistCheckbox.addEventListener('change', () => {
      const on = replyPersistCheckbox.checked;
      window.api.settings.update({ overlay: { replyPersist: on } });
      if (on) {
        clearTimeout(state.replyIdleTimer);
        state.replyIdleTimer = null;
        cancelReplyHide();
      } else {
        restartReplyIdleTimer();
      }
    });
  }

  el.testBtn.addEventListener('click', () => {
    const samples = [
      { text: '这条是测试回复，看看字号和显示位置合不合适～', emotion: 'happy' },
      { text: '收到收到，我这边显示很正常。', emotion: 'talking' }
    ];
    const sample = samples[Math.floor(Math.random() * samples.length)];
    window.api.overlay.testMessage(sample);
  });

  const resetBtn = document.getElementById('resetPosBtn');
  if (resetBtn) resetBtn.addEventListener('click', () => resetWindowPosition());

  // 「恢复跟随内容」：把高度模式切回 content（拖过边之后才出现这个按钮）
  const heightBtn = document.getElementById('resetHeightMode');
  if (heightBtn) {
    heightBtn.addEventListener('click', () => {
      window.api.settings.update({ overlay: { heightMode: 'content' } });
    });
  }

  // 顶部那一行是系统拖动区
  bindDragArea();
  // 四条边 + 四个角拖拽改大小（2026-10-19）
  bindResizeHandles();

  if (el.speechEnabled) {
    el.speechEnabled.addEventListener('change', () => {
      window.api.settings.update({ speech: { enabled: el.speechEnabled.checked } });
      if (!el.speechEnabled.checked) stopSpeech();
      else speak('语音朗读已开启，这就是我的声音', { force: true });
    });
  }

  if (el.muteBtn) {
    el.muteBtn.addEventListener('click', () => {
      const speech = (state.settings && state.settings.speech) || {};
      const muted = !speech.muted;
      window.api.settings.update({ speech: { muted, enabled: speech.enabled !== false } });
      if (muted) stopSpeech();
      else speak('声音恢复了', { force: true });
    });
  }

  el.drawerClose.addEventListener('click', () => toggleDrawer(false));

  // 顶部工具栏：打开快捷设置 / 直接关闭悬浮窗
  if (el.gearBtn) el.gearBtn.addEventListener('click', () => toggleDrawer(!state.drawerOpen));
  if (el.closeBtn) {
    el.closeBtn.addEventListener('click', () => {
      stopSpeech();
      window.api.overlay.hide();
    });
  }
  if (el.hideBtn) {
    el.hideBtn.addEventListener('click', () => {
      stopSpeech();
      window.api.overlay.hide();
    });
  }
  if (el.quitAppBtn) {
    el.quitAppBtn.addEventListener('click', () => {
      stopSpeech();
      window.api.window.quit();
    });
  }

  // 对话区相关开关（和面板里的设置是同一份数据，两边同步）
  if (el.chatEnabled) {
    el.chatEnabled.addEventListener('change', () => {
      window.api.settings.update({ overlay: { chatEnabled: el.chatEnabled.checked } });
      renderLayout();
    });
  }
  if (el.chatShowDanmaku) {
    el.chatShowDanmaku.addEventListener('change', () => {
      window.api.settings.update({ overlay: { chatShowDanmaku: el.chatShowDanmaku.checked } });
    });
  }
  if (el.chatShowIds) {
    el.chatShowIds.addEventListener('change', () => {
      window.api.settings.update({ overlay: { chatShowIds: el.chatShowIds.checked } });
    });
  }
  if (el.chatHeight) {
    let saveTimer = null;
    el.chatHeight.addEventListener('input', () => {
      const height = clamp(Math.round(Number(el.chatHeight.value) || 210), CHAT_MIN_HEIGHT, CHAT_MAX_HEIGHT);
      const out = document.getElementById('chatHeightOut');
      if (out) out.textContent = `${height}px`;
      // 乐观更新本地配置，界面立刻跟手（设置回写后是同一个值，不会打架）；
      // 不直接写 style.height —— 高度只由 computeLayout() 算，否则又会出现"两处都写"的问题。
      if (!state.settings) state.settings = {};
      state.settings.overlay = { ...(state.settings.overlay || {}), chatHeight: height };
      // 固定高度模式下窗口高度由主播拖出来，对话区吃剩余空间，这个滑杆就"没反应"了；
      // 动滑杆 = 想自己定对话区高度 → 顺手切回「跟随内容」，滑杆立刻生效（和抽屉里的按钮同一个效果）。
      const wasFixed = (state.settings.overlay.heightMode || 'content') === 'fixed';
      const patch = { chatHeight: height };
      if (wasFixed) {
        patch.heightMode = 'content';
        state.settings.overlay.heightMode = 'content';
      }
      computeLayout();
      // 可视区变高了，原来贴在底部的记录要重新贴一次，否则会停在半空
      chatRepinAfterLayout();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => window.api.settings.update({ overlay: patch }), 120);
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toggleDrawer(false);
    if (event.key.toLowerCase() === 's' && event.altKey) toggleDrawer(!state.drawerOpen);
  });

  window.addEventListener('resize', renderLayout);
}

function toggleDrawer(open) {
  state.drawerOpen = open === undefined ? !state.drawerOpen : Boolean(open);
  el.drawer.classList.toggle('open', state.drawerOpen);
  // 不做任何焦点操作：抢焦点会导致切换窗口时闪动（见 bindChat 里的说明）
  renderLayout();
}

/** 收起快捷设置（显示悬浮窗时会调用，保证每次都是收起状态） */
function closeDrawer() {
  if (state.drawerOpen) toggleDrawer(false);
  else el.drawer.classList.remove('open');
}

// ------------------------------------------------------------ 事件接线

function wire() {
  window.api.on.settingsChanged((settings) => applySettings(settings, { fromMain: true }));

  window.api.on.reply((reply) => {
    onReply(reply);
  });

  window.api.on.thinking((value) => {
    state.thinking = Boolean(value);
    el.copilot.classList.toggle('thinking', state.thinking);
    if (state.thinking) {
      // 开始思考 = AI 正在组织这一轮的回复，上一轮的表情序列作废
      stopEmotionScript();
      setEmotion('thinking');
    } else if (!state.emotionTimer && !state.emotionQueue.length) {
      // 回复已经接手的话就别抢（回复会自己演表情），否则才回平常
      setEmotion('idle');
    }
  });

  window.api.on.botState((value) => applyBotState(value));

  window.api.on.danmaku((event) => {
    state.latestViewer = { user: event.user, text: event.text };
    // 有弹幕进来就醒过来、并重新开始算睡眠时间
    markActivity();
    // 命中触发词的话，这里就把表情切了（markActivity 之后调，见函数注释）
    applyTriggerEmotion(event.text);
    // 收到的弹幕也进对话区，这样在悬浮窗里就能看到观众说了什么。
    // 括号里那一长串只是内部去重键（通道重推时用）。
    chatAdd('viewer', event.user, event.text, {
      dedup: `dm:${event.id || `${event.ts}:${event.user}:${event.text}`}`,
      id: event.id || '',
      uid: event.uid
    });
  });

  window.api.on.status((status) => {
    const wasConnected = Boolean(state.status && state.status.connected);
    state.status = status;
    if (!wasConnected && status && status.connected) greetOnce();
    renderChatStatus();
    renderHeader();
  });

  window.api.on.overlayRelayout(() => renderLayout());

  window.api.on.openDrawer(() => toggleDrawer(true));
  window.api.on.closeDrawer(() => toggleDrawer(false));

  window.api.on.error((payload) => {
    if (!payload || !payload.message) return;
    if (payload.scope === 'llm') {
      showReply({ text: `⚠️ ${payload.message}` });
    }
  });
}

async function init() {
  try {
    bindUi();
    bindChat();
    wire();
    initSpeech();
    const settings = await window.api.settings.get();
    applySettings(settings, { fromMain: true });
    // 拉一次历史记录，这样刚启动也能看到之前的对话
    try {
      const history = await window.api.copilot.history();
      for (const item of Array.isArray(history) ? history : []) {
        chatAdd(item.role === 'assistant' ? 'ai' : 'viewer', item.who, item.text);
      }
    } catch (_) {
      /* 历史拿不到不影响使用 */
    }
    const visible = await window.api.overlay.isVisible();
    if (!visible) window.api.overlay.toggle();
    // 刚打开先蹦一下，然后开始算「多久没人理它」，久了就睡着
    setEmotion('pop');
    setTimeout(() => {
      if (state.emotion === 'pop') setEmotion('idle');
    }, 900);
    markActivity({ wake: false });
    renderLayout();
    setTimeout(renderLayout, 300);
    setTimeout(renderLayout, 1200);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('悬浮窗初始化失败:', error);
    if (typeof window.__reportUiError === 'function') {
      window.__reportUiError('悬浮窗初始化失败', (error && error.message) || String(error), {
        stack: error && error.stack ? error.stack : ''
      });
    }
  }
}

init();
