'use strict';

/**
 * 主进程：窗口管理 + IPC + 事件转发
 *
 * 两个窗口：
 *   1) 控制面板 panel   —— 普通窗口，用来配置 API、人设、看弹幕流、主动说话
 *   2) 悬浮窗   overlay —— 透明、无边框、置顶，显示吉祥物 + AI 回复文本
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, dialog, shell, Menu, Tray, nativeImage } = require('electron');

/**
 * 程序根目录 = 放 `data/` 和 `知识库/` 的那一层（2026-10-21 为打包发布加的）。
 * 规则和测试都在 `src/main/app-paths.js` 里，这里只取一次：
 *   · 开发时 = 项目根；· 打包后 = **exe 所在目录**（不是 `resources/app`）；
 *   · `DSH_APP_ROOT` 环境变量可强制指定（测试 / 把数据放到别的盘）。
 *
 * ⚠️ 这个常量必须在任何写文件之前算好：`boot.log` 就靠它定位。
 */
const { appRoot, isPackaged } = require('./app-paths');
const APP_ROOT = appRoot();
const IS_PACKAGED = isPackaged();
const mascotDefaults = require('./mascot-defaults');

/**
 * 启动兜底记录：不依赖配置、不依赖 userData 路径，
 * 只要主进程跑起来就先留下痕迹。排查「日志文件不存在」这类问题全靠它。
 */
const BOOT_LOG = path.join(APP_ROOT, 'data', 'boot.log');
const SMOKE_LOG = path.join(APP_ROOT, 'data', 'smoke-test.log');
function bootLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true });
    // 一律走带轮转的写入：以前是裸 appendFileSync，异常刷屏能一分钟写几百 MB（见 logger.js）
    appendWithRotation(BOOT_LOG, line);
  } catch (_) {
    /* 连这个都写不了就没办法了 */
  }
}
bootLog(
  `进程启动 pid=${process.pid} electron=${process.versions.electron || '(非 Electron)'} argv=${JSON.stringify(
    process.argv.slice(1)
  )}`
);

// 早期错误兜底：无论在哪一步炸掉，都要留下可查的痕迹（写在程序目录下）
process.on('uncaughtException', (error) => {
  reportEarlyCrash('未捕获异常', error);
});
process.on('unhandledRejection', (reason) => {
  reportEarlyCrash('未处理的 Promise 拒绝', reason);
});

/**
 * 崩溃日志固定写在「程序目录/data/crash.log」。
 * 这里做足防御：整个程序都崩掉的时候，写日志这一步绝不能再抛错。
 */
function crashLogPath() {
  try {
    return path.join(app.getPath('userData'), 'crash.log');
  } catch (_) {
    return path.join(APP_ROOT, 'data', 'crash.log');
  }
}

function reportEarlyCrash(label, error) {
  const text = `[${new Date().toLocaleString('zh-CN')}] ${label}\n${
    error && error.stack ? error.stack : String(error)
  }\n\n`;
  try {
    const target = crashLogPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, text, 'utf8');
  } catch (_) {
    /* ignore */
  }
  console.error(text);
  if (app.isReady()) {
    try {
      dialog.showErrorBox('直播 AI 搭档 出错了', `${label}：${(error && error.message) || error}\n\n详情见程序目录下的 data/crash.log`);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * 界面加载失败 / 渲染进程崩溃 / 界面里的报错，都要留下痕迹。
 * 渲染层的错误如果看不到，排查就只能靠猜——所以这里统一落到 data/renderer-error.log。
 */
function watchWindowHealth(win, label) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;

  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const message = `${label} 界面加载失败：${errorDescription}（code=${errorCode}）URL=${validatedURL}`;
    logger.error(message);
    reportEarlyCrash(`${label} 界面加载失败`, new Error(message));
  });

  wc.on('render-process-gone', (_event, details) => {
    const message = `${label} 渲染进程退出：${details && details.reason ? details.reason : '未知原因'}`;
    logger.error(message);
    reportEarlyCrash(`${label} 渲染进程退出`, new Error(message));
  });

  wc.on('unresponsive', () => {
    logger.warn(`${label} 界面无响应`);
  });

  // 界面里的 JS 报错（这是排查「按钮点不动」最关键的信息）
  wc.on('console-message', (...args) => {
    // Electron 版本不同，回调签名不同：新版是 (event, level, message, line, sourceId, frame)
    let level = 0;
    let message = '';
    let line = 0;
    let source = '';
    if (args.length >= 5 && typeof args[1] === 'number') {
      [, level, message, line, source] = args;
    } else {
      const details = args[0] || {};
      level = details.level;
      message = details.message;
      line = details.lineNumber;
      source = details.sourceId;
    }
    const isError = level === 3 || level === 'error';
    const isWarning = level === 2 || level === 'warning';
    const text = String(message || '').trim();
    if (!text) return;
    if (isError || isWarning) {
      appendRendererError(`${label} [${isError ? '错误' : '警告'}] ${text}\n    at ${source}:${line}`);
      logger[isError ? 'error' : 'warn'](`[界面] ${text}`);
    }
  });

  wc.on('preload-error', (_event, preloadPath, error) => {
    const message = `${label} 预加载脚本出错：${preloadPath}\n${error && error.stack ? error.stack : error}`;
    appendRendererError(message);
    logger.error(message);
  });
}

/** 界面错误单独记一份，方便一次性发给开发者（固定写程序目录，不依赖 userData） */
function appendRendererError(text) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${text}\n`;
  const targets = [path.join(APP_ROOT, 'data', 'renderer-error.log')];
  try {
    targets.push(path.join(app.getPath('userData'), 'renderer-error.log'));
  } catch (_) {
    /* ignore */
  }
  for (const target of targets) {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.appendFileSync(target, line, 'utf8');
    } catch (_) {
      /* ignore */
    }
  }
  bootLog(`[界面错误] ${text.split('\n')[0]}`);
}

const { SettingsStore, DEFAULT_PERSONA } = require('./settings');
const { Logger, appendWithRotation } = require('./logger');
const { Copilot } = require('./copilot');
const { DeepSeekClient } = require('./llm');
const { DanmakuRecorder } = require('./danmaku-log');
const { KnowledgeBase, defaultKnowledgeDir, migrateKnowledgeDir } = require('./knowledge');
// 从文件导入资料（txt/md → 模型整理成待审草稿）：纯函数都在那里面，见文件头的说明
const {
  prepareImport,
  planImportJobs,
  buildImportPrompt,
  IMPORT_SYSTEM_PROMPT,
  TEXT_EXTENSIONS,
  MAX_FILE_BYTES
} = require('./import-file');
const { ResearchQueue, searchWithDeepSeek, searchViaSearchApi, searchRaw } = require('./research');
// 知识库「整理 / 校对 / 更新」：提示词和解析是纯函数（见 review.js 文件头）
const {
  REVIEW_THINKING,
  DEFAULT_VERIFY_LIMIT,
  MAX_REVIEW_ITEMS,
  buildAuditPrompt,
  buildVerifyPrompt,
  parseReviewItems,
  parseVerifyAnswer,
  selectVerifyTargets,
  noteChangedSince,
  describeChange
} = require('./review');

const { BiliLogin } = require('./bili-login');
const { UsageTracker } = require('./stats');
const { TtsClient } = require('./tts');
const { DshRunner, DshSessionRunner, buildTaskPrompt, parseDrafts } = require('./dsh');
const { attachSessionToWorkspace } = require('./dsh-store');
// 观众记忆：本场文档 + 老观众名册（纯函数 + 文件层，见模块头注释）
const viewerMemoryShared = require('./viewer-memory');

/**
 * 自己记一笔「哪些 IPC 通道注册过」。
 *
 * 为什么需要：Electron **没有公开 API** 能查 `ipcMain.handle()` 注册了哪些通道 ——
 * `ipcMain.listenerCount(channel)` / `listeners()` 只数 `on()/once()` 注册的**事件监听**，
 * 而 `handle()` 走的是内部 handler 表，永远数出来是 0。
 * 早先的启动自检就是拿 `listenerCount` 判断的，于是「IPC 通道已注册」这一项**永远是 FAIL**
 * （还被另一个 bug 掩盖了：`ok` 在检查之前就算好了，所以自检从来不会失败 —— 主播那台设备上
 * 「自检报失败但能正常启动」就是这么来的）。
 * 现在包一层 `handle`，把通道名收进集合，自检就查这个集合。
 */
const INVOKE_CHANNELS = new Set();
const rawIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => {
  INVOKE_CHANNELS.add(String(channel));
  return rawIpcHandle(channel, listener);
};

const IS_DEV = process.argv.includes('--dev');
// 启动自检：只做初始化和接口注册，不开窗口，跑完立刻退出。
// 用来在真正开界面之前确认「读配置 / 装配服务 / 注册 IPC」这条路是通的。
const IS_SMOKE = process.argv.includes('--smoke-test');

// 让数据落在程序目录旁边的 data/ 下，方便查找，也避免写到系统盘被权限拦住。
// 打包后 `APP_ROOT` = exe 所在目录（见文件顶部），所以分享版的数据就在软件文件夹里。
const portableData = path.join(APP_ROOT, 'data');
try {
  fs.mkdirSync(portableData, { recursive: true });
  fs.accessSync(portableData, fs.constants.W_OK);
  app.setPath('userData', portableData);
  bootLog(`userData 已指向程序目录: ${portableData}`);
} catch (error) {
  // 落回系统默认目录（装到 Program Files 这类不可写位置时会走到这里）
  bootLog(`无法把 userData 指向程序目录（${error.message}），改用系统默认目录`);
}
bootLog(`程序根目录 APP_ROOT = ${APP_ROOT}${IS_PACKAGED ? '（打包版）' : '（开发版）'}`);
bootLog(`app.getAppPath() = ${app.getAppPath()}`);
bootLog(`app.getPath('userData') = ${(() => {
  try {
    return app.getPath('userData');
  } catch (error) {
    return `(读取失败: ${error.message})`;
  }
})()}`);

const logger = new Logger();
bootLog(`日志文件路径 = ${logger.file}`);
const store = new SettingsStore();
bootLog(`配置文件路径 = ${store.file}`);
// 弹幕记录器：把收到的每条弹幕（含被去重丢掉的）逐条写文件。
// 默认写到「我的文档\直播AI搭档\弹幕记录」——故意不写程序目录的 data：
// 实测那里的 .log 会被清理类软件扫掉，记录跟着一起没就白记了。
const danmakuRecorder = new DanmakuRecorder({
  dir: store.get().danmakuLog.dir || (store.file ? `${path.dirname(store.file)}` : app.getPath('userData')),
  logger,
  config: store.get().danmakuLog
});
bootLog(`弹幕记录 = ${danmakuRecorder.enabled ? danmakuRecorder.filePath : '已关闭'}`);
const usage = new UsageTracker({
  store,
  logger,
  file: path.join(app.getPath('userData'), 'usage.json')
});

/**
 * 第一次启动时把**内置默认吉祥物素材**导进配置（2026-10-21 主播要求）：
 * 「默认吉祥物素材放在发布包里，并且设为默认的吉祥物」——装上就有那只大肥鱼，
 * 不用让收包的人自己去文件夹里一张张导入。
 *
 * 只种一次（`mascot.bundledSeeded`）：
 *   · 已经有图（老用户 / 自己导过）→ 只补个「种过了」的标记，**不覆盖**他的图；
 *   · 种过之后主播故意删图 → 下次启动不会又冒出来；
 *   · 找不到素材目录（只拷了 exe、或者开发者删了资源）→ 什么都不做，照旧用 emoji 兜底。
 *
 * 素材目录 = `<程序根目录>\默认素材图片\`（打包后就在 exe 旁边，用户能看见也能自己换）。
 */
function seedBundledMascot() {
  const mascot = store.get().mascot || {};
  if (mascot.bundledSeeded === true) return;
  if (mascot.images && Object.keys(mascot.images).length) {
    store.patch({ mascot: { bundledSeeded: true } });
    bootLog('吉祥物：已经有自定义图片，只记下「内置素材种过了」（不覆盖你的图）');
    return;
  }
  const folder = mascotDefaults.findMascotFolder(APP_ROOT);
  if (!folder) {
    bootLog(`吉祥物：没找到内置素材目录（${path.join(APP_ROOT, mascotDefaults.MASCOT_DIR_NAME)}），先用 emoji 兜底`);
    return;
  }
  const { images, bytes, skipped } = mascotDefaults.loadMascotImages(folder);
  const names = Object.keys(images);
  if (!names.length) {
    bootLog(`吉祥物：素材目录里没有能用的图片（${folder}）`);
    return;
  }
  store.patch({ mascot: { images, bundledSeeded: true } });
  bootLog(
    `吉祥物：已导入内置默认素材 ${names.length} 张（${Math.round(bytes / 1024)}KB，来自 ${folder}）` +
      (skipped.length ? `；跳过 ${skipped.length} 个（${skipped[0].name}：${skipped[0].reason}）` : '')
  );
}
seedBundledMascot();
/**
 * 知识库：条目就是「软件目录/知识库/notes/*.md」（一个条目一个文件，带 front-matter）。
 *
 * 三个决定：
 *   · **选「纯文件」而不是数据库**：主播能直接用记事本改、能整个目录备份；
 *   · **放在软件目录里、名字就叫「知识库」**：一眼看得见，不用去 data/ 那堆
 *     Chromium 缓存里翻（以前在 data/knowledge，用户根本找不到）；
 *   · **它同时是 DSH 的工作区**：DSH 的沙箱以会话 cwd 为根，只放行这个目录下的写操作，
 *     所以「让 AI 整理知识」和「别让它乱动我电脑」是同一件事。
 *
 * ⚠️ `knowledge.dir` 一旦被写死成绝对路径，换台电脑就指到别人家去了，
 * 所以默认值永远是空 + 现算（`defaultKnowledgeDir`）。
 */
const dataRoot = (() => {
  if (!store.file) return app.getPath('userData');
  const dir = path.dirname(store.file); // 正常是 <软件目录>/data
  return path.basename(dir).toLowerCase() === 'data' ? path.dirname(dir) : dir;
})();
const legacyKnowledgeDir = path.join(dataRoot, 'data', 'knowledge');
let knowledgeDir = store.get().knowledge.dir
  ? path.resolve(String(store.get().knowledge.dir))
  : defaultKnowledgeDir(dataRoot);
// 老版本把知识库放在 data/knowledge：第一次启动搬过来；搬不动就继续用老目录（绝不半途而废）
if (!store.get().knowledge.dir) {
  const migrated = migrateKnowledgeDir({ from: legacyKnowledgeDir, to: knowledgeDir, logger });
  if (migrated.migrated) {
    bootLog(
      `知识库搬到 ${knowledgeDir}（${migrated.copied} 个文件）` +
        `${migrated.backup ? `，老目录改名为 ${migrated.backup}，确认没问题可以删` : ''}`
    );
  } else if (!migrated.ok) {
    knowledgeDir = legacyKnowledgeDir;
    bootLog(`知识库迁移失败（${migrated.reason}），这次仍用老目录 ${knowledgeDir}`);
  }
}
const knowledge = new KnowledgeBase({
  dir: knowledgeDir,
  logger
});
try {
  knowledge.load();
  bootLog(`知识库 = ${knowledge.stats().notesDir}（${knowledge.stats().count} 条）`);
} catch (error) {
  bootLog(`知识库读取失败（不影响直播）：${error.message}`);
}
/**
 * 「从文件导入」的会话状态（2026-10-19）。
 *
 * `pickedImports` 是「刚在选文件框里挑过的文件」→ 已解码的正文。
 * 它同时是**白名单**：`knowledge:importFiles` 只处理这份缓存里的文件，
 * 所以界面（或将来某个坏掉的渲染进程）没法塞一个任意路径进来读你电脑上的东西。
 * 选完文件不导入、或者导入跑完，这份缓存就清空。
 */
const pickedImports = new Map();
/** 同一时间只许跑一批导入（不然两次并发会把模型调用和草稿搅在一起） */
const importState = { running: false };
/**
 * 「模型想查 / 想记」的待办队列（`data/research.json`）。
 *
 * 模型在回复里藏 `[待查:明日方舟]` / `[记一笔:…]` 标记（观众看不到），这里收下来变成待办；
 * 主播在面板点「去查」才真的联网查，查完的产出照旧只进「待审草稿」。
 * 换句话说：**模型可以提议，但花钱和写库都得主播点头**。
 */
const researchQueue = new ResearchQueue({
  file: store.file ? path.join(path.dirname(store.file), 'research.json') : '',
  logger
});
/**
 * 观众记忆（2026-10-21）：本场文档 + 老观众名册，文件都在 `data/观众记忆/`。
 * 这里只负责**持有实例**；攒批量、调模型、写盘都在下面 `runMemoryFlush` 那一节。
 * copilot 拿到的只是只读接口（注入摘要 / 标老观众 / 取查询结果）。
 */
const viewerMemory = new viewerMemoryShared.ViewerMemory({
  dir: path.join(app.getPath('userData'), viewerMemoryShared.DIR_NAME),
  logger,
  now: () => Date.now()
});
viewerMemory.configure(store.get().viewerMemory || {});
try {
  viewerMemory.loadRoster();
} catch (error) {
  bootLog(`老观众名册读取失败（不影响直播）：${error.message}`);
}
const copilot = new Copilot({
  store,
  logger,
  recorder: danmakuRecorder,
  knowledge,
  research: researchQueue,
  // 观众记忆：copilot 只读它（注入摘要、标「老观众」、取 `[查观众:]` 的结果）
  viewerMemory,
  onResearch: (items) => {
    // 面板就是常驻窗口（关掉它软件会退出），所以待办只需要通知面板：
    // 它会画进「模型想查 / 想记」卡片，并冒一个提示——直播中主播才注意得到它在「申请」
    if (items && items.length) bootLog(`模型提了待办：${items.map((item) => `${item.kind}:${item.text}`).join('，')}`);
    send(panelWindow, 'research:changed', researchQueue.list());
    for (const item of items || []) {
      // 「去查」：默认是「她问一句、主播点头」——联网花钱这件事不替主播决定。
      // **最高权限打开时**她才自己查（花钱的那部分，所以单独有 `agent.searchPerHour` 上限）。
      if (item.kind === 'lookup') {
        const maxMode = Boolean(store.get().agent && store.get().agent.maxPermissions);
        const cap = Number(store.get().agent.searchPerHour) || 0;
        if (!maxMode) {
          copilot.enqueueResearchAsk(item);
        } else if (cap > 0 && selfSearchCountLastHour() >= cap) {
          bootLog(`她一小时内已经自己查过 ${cap} 次了，这条先攒着：${item.text}`);
          copilot.say(`我这一小时查得有点多了，这条先攒着——你点一下我就查～`, 'research-result', { emotion: 'helpless' });
        } else {
          bootLog(`最高权限：她自己去查「${item.text}」`);
          // 先应一声（因为她正文里可能没说），再去查
          copilot.say(`这个我不太清楚，我去查一下「${item.text}」，查完就记下来～`, 'research-ack', { emotion: 'thinking' });
          runResearchItem(item.id, { via: 'auto', auto: true }).then((result) => {
            if (!result || result.ok) return;
            copilot.say(`「${item.text}」没查成：${result.message}`, 'research-result', { emotion: 'helpless' });
          });
        }
        continue;
      }
      // 「记 / 改 / 扩写 / 删」按「她自己动库」那一档走（P6；删条目只在最高权限下放行）
      copilot.handleSelfEdit(item);
    }
  },
  cookieProvider: () => biliLogin.currentCookieHeader(),
  // AI 自己记下的触发词规则要立刻广播给两个界面（走和界面提交设置同一条路）
  applySettings: (partial) => applySettingsPatch(partial),
  onUsage: (event) => {
    if (event.ok) usage.recordSuccess(event.result);
    else usage.recordFailure();
    send(panelWindow, 'usage', usage.summary());
  }
});
/**
 * 「她自己改库」专用客户端：同一个 Key / 接口 / 模型，但**关掉思考**——
 * 改错和扩写是「照着改」的活，不需要推理（省钱也快），温度也压低，让它老实照抄该照抄的部分。
 * 单独一个实例是为了不干扰直播回复那一条链路（各自的调用互不影响）。
 */
const editLlm = new DeepSeekClient(() => ({ ...(store.get().api || {}), thinking: 'off' }), logger);

// ---------------------------------------------------------------- 观众记忆（2026-10-21）
//
// 三件事，分开看：
//   ① **老观众名册**：每条真实弹幕本地记一笔（谁发过、几次、首次/最近），零模型成本；
//   ② **本场文档**：攒够 N 条或过了 T 秒，发一次模型做一次总结（模型只给要点 patch，
//      合并/裁剪/清洗都在 viewer-memory.js 里，模型无权整篇重写）；
//   ③ **注入**：copilot 每轮读摘要 + 老观众标注（它只读，写都在这里）。
//
// 开关语义（主播定的）：「本场记录」打开 → 新建一份文件；关掉 / 退出程序 → 收尾。
// 退出**不等网络**（等网络会卡住关不掉）：没总结完的缓冲直接丢掉，文件末尾如实写「有 N 条没来得及总结」。

/**
 * 这一轮还没总结的内容（观众 / 主播 / 我自己的回复）
 *
 * ⚠️ `nextTryAt` 不是可选项：总结失败时缓冲**不会被清空**（留着下次再试），
 *    于是「攒够一批」这个条件一直成立。要是失败后立刻重试，就是死循环——
 *    2026-10-21 实测：假接口返回坏响应时 `finally` 又调 `scheduleMemoryFlush()`，
 *    一分钟写满 298MB 日志、CPU 打满，真实直播里一次网络抖动也会这样。
 *    所以失败后必须退避一段时间（就算手动点「现在总结一批」也不拦，那是主播主动要试）。
 */
const MEMORY_RETRY_DELAY_MS = 30 * 1000;

const memoryRuntime = {
  buffer: [],
  flushing: false,
  flushTimer: null,
  /** 连续失败后下一次允许自动重试的时间（0 = 随时可以） */
  nextTryAt: 0,
  /** 最近一小时真正总结过的时间戳（限频用） */
  batches: [],
  /** 每小时上限撞到了只提醒一次，免得每条弹幕都写一行日志 */
  capNotifiedAt: 0
};

function memoryConfig() {
  return store.get().viewerMemory || {};
}

/** 界面读的状态（数量/文件/缓冲区） */
function memoryStatus() {
  const config = memoryConfig();
  const now = Date.now();
  return {
    ...viewerMemory.state(),
    config: {
      enabled: config.enabled === true,
      autoStart: config.autoStart !== false,
      rosterEnabled: config.rosterEnabled !== false,
      batchSize: Number(config.batchSize) || viewerMemoryShared.DEFAULT_BATCH_SIZE,
      intervalSec: Number(config.intervalSec) || viewerMemoryShared.DEFAULT_INTERVAL_SEC,
      maxBatchesPerHour: Number(config.maxBatchesPerHour) || 0,
      injectChars: Number(config.injectChars) || viewerMemoryShared.DEFAULT_INJECT_CHARS,
      rosterMax: Number(config.rosterMax) || viewerMemoryShared.DEFAULT_ROSTER_MAX
    },
    buffered: memoryRuntime.buffer.length,
    flushing: memoryRuntime.flushing,
    batchesThisHour: memoryRuntime.batches.filter((ts) => now - ts < 3600 * 1000).length
  };
}

function broadcastMemory() {
  send(panelWindow, 'memory:changed', memoryStatus());
}

/** 收到一条「有新内容」：观众弹幕 / 主播的话 / 我自己的回复 */
function queueMemoryLine(line) {
  if (!line || !line.kind) return;
  const config = memoryConfig();
  // 名册是本地维护的：本场记录关着也照样记（只要名册那个开关开着）
  if (line.kind === 'viewer' && config.rosterEnabled !== false) {
    viewerMemory.recordDanmaku(line.name, line.ts);
  }
  if (config.enabled !== true || !viewerMemory.isRecording()) return;
  memoryRuntime.buffer.push({
    kind: line.kind,
    name: String(line.name || ''),
    text: String(line.text || ''),
    ts: Number(line.ts) || Date.now()
  });
  // 内存里最多留 400 条：刷屏时宁可丢最旧的，也不把内存吃掉
  while (memoryRuntime.buffer.length > 400) memoryRuntime.buffer.shift();
  scheduleMemoryFlush();
}

/** 够一批就立刻总结；不够就按间隔挂个定时器 */
function scheduleMemoryFlush() {
  const config = memoryConfig();
  if (config.enabled !== true || !viewerMemory.isRecording()) return;
  if (memoryRuntime.flushing || memoryRuntime.flushTimer) return;
  if (!memoryRuntime.buffer.length) return;
  // 上一批失败了（缓冲没清空、「够一批」的条件仍然成立）：等退避时间到了再试。
  // 这里必须先拦他，否则 finally → scheduleMemoryFlush → runMemoryFlush → 又失败，死循环。
  const backoff = (memoryRuntime.nextTryAt || 0) - Date.now();
  if (backoff > 0) {
    memoryRuntime.flushTimer = setTimeout(() => {
      memoryRuntime.flushTimer = null;
      void runMemoryFlush('retry');
    }, backoff);
    return;
  }
  const should = viewerMemoryShared.shouldFlush({
    buffered: memoryRuntime.buffer.length,
    lastFlushAt: viewerMemory.lastFlushAt,
    now: Date.now(),
    config
  });
  if (should) {
    void runMemoryFlush('batch');
    return;
  }
  const interval = Math.max(
    viewerMemoryShared.MIN_INTERVAL_SEC,
    Math.min(viewerMemoryShared.MAX_INTERVAL_SEC, Number(config.intervalSec) || viewerMemoryShared.DEFAULT_INTERVAL_SEC)
  );
  const wait = Math.max(5000, interval * 1000 - (Date.now() - (viewerMemory.lastFlushAt || 0)));
  memoryRuntime.flushTimer = setTimeout(() => {
    memoryRuntime.flushTimer = null;
    void runMemoryFlush('interval');
  }, wait);
}

/**
 * 真去总结一批。
 * @param {'batch'|'interval'|'manual'} reason
 * @returns {Promise<{ok:boolean, message?:string, lines?:number}>}
 */
async function runMemoryFlush(reason = 'interval') {
  if (memoryRuntime.flushing) return { ok: false, message: '上一批还在总结' };
  const config = memoryConfig();
  if (config.enabled !== true) return { ok: false, message: '本场记录没开' };
  if (!viewerMemory.isRecording()) return { ok: false, message: '现在没有在记录' };
  if (!memoryRuntime.buffer.length) return { ok: false, message: '没有新内容要总结' };
  const now = Date.now();
  memoryRuntime.batches = memoryRuntime.batches.filter((ts) => now - ts < 3600 * 1000);
  const cap = Number(config.maxBatchesPerHour) || 0;
  if (cap > 0 && memoryRuntime.batches.length >= cap) {
    if (now - memoryRuntime.capNotifiedAt > 5 * 60 * 1000) {
      memoryRuntime.capNotifiedAt = now;
      bootLog(`观众记忆：这一小时已经总结 ${cap} 次（上限），新内容先攒着`);
    }
    return { ok: false, message: `这一小时已经总结 ${cap} 次了，先攒着` };
  }

  const lines = memoryRuntime.buffer.slice();
  memoryRuntime.flushing = true;
  try {
    const prompt = viewerMemoryShared.buildUpdatePrompt({ session: viewerMemory.session, lines });
    const result = await editLlm.chat(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user }
      ],
      // 关思考（这就是抄要点，开思考只是多花钱）；不限 max_tokens；30 秒够
      { thinking: 'off', maxTokens: 0, temperature: 0.2, timeoutMs: 30000 }
    );
    const patch = viewerMemoryShared.parsePatch(result && result.content);
    const applied = viewerMemory.applyPatch(patch);
    // 只清掉这一批（总结期间新来的留着）
    memoryRuntime.buffer = memoryRuntime.buffer.slice(lines.length);
    memoryRuntime.batches.push(Date.now());
    viewerMemory.lastFlushAt = Date.now();
    // 成功了就允许下一次照常（上一轮失败留下的退避作废）
    memoryRuntime.nextTryAt = 0;
    bootLog(
      `观众记忆：总结了 ${lines.length} 条新内容` +
        `（新增 ${applied.added.viewers} 条观众要点 / ${applied.added.anchor} 条主播安排）`
    );
    broadcastMemory();
    return { ok: true, lines: lines.length, ...applied };
  } catch (error) {
    // 失败后**必须**退避：缓冲没清空，攒够一批的条件仍然成立，
    // 立刻重试就是死循环（见 MEMORY_RETRY_DELAY_MS 那段注释）
    memoryRuntime.nextTryAt = Date.now() + MEMORY_RETRY_DELAY_MS;
    bootLog(
      `观众记忆总结失败（这批留着，${Math.round(MEMORY_RETRY_DELAY_MS / 1000)} 秒后再试）：${error.message}`
    );
    return { ok: false, message: error.message };
  } finally {
    memoryRuntime.flushing = false;
    if (memoryRuntime.buffer.length) scheduleMemoryFlush();
  }
}

/** 开关变化 / 启动时同步：开 → 新建一份本场文件；关 → 收尾 */
function syncMemoryFeature() {
  const config = memoryConfig();
  viewerMemory.configure(config);
  if (config.enabled === true && !viewerMemory.isRecording()) {
    const file = viewerMemory.startSession();
    bootLog(`观众记忆：开始记录本场（${file}）`);
  } else if (config.enabled !== true && viewerMemory.isRecording()) {
    const unsaved = memoryRuntime.buffer.length;
    const file = viewerMemory.endSession({ unsaved });
    memoryRuntime.buffer = [];
    memoryRuntime.nextTryAt = 0;
    clearTimeout(memoryRuntime.flushTimer);
    memoryRuntime.flushTimer = null;
    bootLog(`观众记忆：本场结束（${file}）${unsaved ? `，有 ${unsaved} 条没来得及总结` : ''}`);
  }
  broadcastMemory();
}

/**
 * 启动时装配观众记忆。
 *
 * 「每次启动自动记录」(`autoStart`，默认开) **只在启动这一刻**说了算：
 *   开着 → 先把 `enabled` 打开，再开一场，主播不用每天手点；
 *   关着 → 完全按 `enabled` 上次的值来（纯手动）。
 *
 * ⚠️ 这段**不能塞进 `syncMemoryFeature()`**：主播直播中手动关掉「本场记录」时，
 *    `applySettingsPatch` 也会调到那个函数，放进去就会「刚关掉又被打开」，跟主播抢开关。
 *    只有这里（启动）才允许替主播把 `enabled` 打开。
 */
function bootViewerMemory() {
  const config = memoryConfig();
  if (config.autoStart !== false && config.enabled !== true) {
    store.patch({ viewerMemory: { enabled: true } });
    bootLog('观众记忆：启动时自动开始记录（设置里「启动时自动记录」是开的）');
  }
  syncMemoryFeature();
}

/** 从 copilot 收三类内容 + 处理 `[查观众:]` */
function wireViewerMemory() {
  copilot.on('viewer-line', (line) => queueMemoryLine({ kind: 'viewer', ...line }));
  copilot.on('operator-line', (line) => queueMemoryLine({ kind: 'anchor', text: line.text, ts: line.ts }));
  copilot.on('reply', (reply) => {
    if (!reply || !reply.text) return;
    queueMemoryLine({ kind: 'reply', text: reply.text, ts: reply.ts });
  });
  copilot.on('viewer-lookup', ({ name }) => {
    const text = viewerMemory.resolveLookup(name);
    if (text) bootLog(`她想查观众「${name}」的资料（下一轮回复会带上）`);
  });
}
/**
 * DSH（DeepSeek Harness）跑腿：把「读文件 / 联网 / 整理资料」这类慢活交给本机的 DSH。
 *
 * ```
 * ⚠️ 已下线（2026-10-19，主播选的「只藏不删」）—— 下面这两个实例仍然会被创建，
 *    但界面上那张「让 DSH 整理」卡已经 `hidden`，而且 runResearchQuery 里把 engine
 *    钉成了 'builtin'，**没有任何正常路径会调到它们**。构造函数是懒的（不起进程、不联网），
 *    所以留着不花钱。
 *    为什么下线：使用率太低（配置里 engine 一直是 builtin、会话只建过一次），
 *    而且「查资料」已经被自研搜索顶掉了（3 秒 / 0.010 元，DSH 要几十秒）。
 *    想恢复：去掉 index.html 里 #dshCard 的 hidden + 把 runResearchQuery 的 engine 改回来，
 *    细节见交接文档 §6.16。
 * ```
 *
 * 三个刻意的决定（恢复时仍然成立）：
 *   · **软件不带 DSH、也不带 Node**：想用这个功能的人自己装，我们只负责**检测**环境、
 *     把缺什么和怎么补告诉用户（`dsh.detect()`），检测不过就拒绝跑任务。
 *   · **用系统 Node**：实测 Electron 自带的 Node 跑 DSH 会静默失败（没有任何输出），
 *     所以老老实实调系统 `node`。
 *   · **产出只进待审**：DSH 说出来的东西一律写成草稿，主播点通过才进知识库。
 */
const dsh = new DshRunner({
  getConfig: () => ({ ...store.get().knowledge, apiKey: store.get().api.apiKey }),
  logger,
  appPath: app.getAppPath()
});
/**
 * 「看得见的」跑法：长驻一个 `dsh --profile acp` 进程，用一个**能续用的会话**干活。
 * 会话落在 DSH 自己的会话库里 → 主播能在 DSH Web 的会话列表里打开它、看它一步步干、
 * 随时接手；**会话 id 由 DSH 生成、存在配置里**（`knowledge.dshSessionId`），
 * 下次启动先 `session/resume` 续用同一个会话（这条是 ACP 才有的能力，
 * 旧的 SDK stdio 路线只会 create，第二次用就报 already exists）。
 * 复用 `dsh.detect()` 的探测结果（node 命令 + bin.js 路径），不重复实现。
 *
 * ⚠️ **已下线**（2026-10-19）：面板入口已隐藏、`runResearchQuery` 固定走内置联网，
 * 所以这个实例不会再被 prompt。保留它是因为「只藏不删」——想恢复看 §6.16。
 */
const dshSession = new DshSessionRunner({
  getConfig: () => ({
    sessionName: store.get().knowledge.dshSessionName,
    sessionId: store.get().knowledge.dshSessionId,
    // 会话模式由我们**在会话上指定模型**（默认 4.1 Flash），
    // 这样就不用去改用户的 DSH 配置，也不受 acp 档自带默认值影响
    model: store.get().knowledge.dshModel,
    timeoutSec: store.get().knowledge.dshTimeoutSec,
    apiKey: store.get().api.apiKey,
    cwd: knowledge.dir
  }),
  logger,
  // 新建/续用成功后把 id 存进配置（下次 resume），续不上时清掉旧的；
  // 顺手把会话**登记进「知识库」工作区**——不登记的话它在 DSH Web 里会落到「未分组」
  // （Web 只按工作区登记表里的显式 sessionIds 分组，见 dsh-store.js 的说明）
  onSession: (id) => {
    const next = String(id || '');
    if (next && next !== store.get().knowledge.dshSessionId) {
      applySettingsPatch({ knowledge: { dshSessionId: next } });
      bootLog(`DSH 会话已记录：${next}`);
    } else if (!next) {
      bootLog('DSH 会话已作废（下次会新建一个）');
    }
    attachDshSession(next);
  },
  resolve: () => dsh.detect()
});

/**
 * 她自己调用软件功能（P7）的**唯一白名单**。
 *
 * 名字必须和 `llm.js` 的 `TOOL_ALIASES` 对得上（`audit.js` 会核对两边）；
 * 她写 `[做:…]` 时只认这里列的动作，别的一律不生效。
 *
 * 刻意**不在这张表里**的东西（任何档位都不给）：
 *   · 向直播间发送任何内容（弹幕 / 点赞 / 关注）—— 这个软件对 B 站始终只读；
 *   · 开始 / 停止弹幕监听（会直接断掉直播）；
 *   · 改人设 / 角色 / API Key / 房间号（改人设走「开发者模式」那条单独的门）。
 */
const AGENT_TOOLS = ['pause', 'resume', 'mute', 'unmute', 'warmup', 'clear', 'export'];

/** 她自己暂停回复时用的定时器（到点了自动恢复） */
let agentPauseTimer = null;

/** 最近一小时她自己联网查了几次（用来卡 `agent.searchPerHour`） */
function selfSearchCountLastHour() {
  const since = Date.now() - 3600 * 1000;
  return researchQueue
    .list()
    .filter((item) => item.kind === 'lookup' && item.auto && item.status === 'done' && Date.parse(item.finishedAt || 0) >= since)
    .length;
}

/** 最近一小时她自己调了几次工具（用来卡 `agent.toolsPerHour`） */
let toolCallLog = [];
function toolCountLastHour() {
  const since = Date.now() - 3600 * 1000;
  toolCallLog = toolCallLog.filter((at) => at >= since);
  return toolCallLog.length;
}

/**
 * 执行她点的软件功能（最高权限下才会走到这儿，见 `copilot.handleToolCalls`）。
 *
 * 每个动作都要**能撤销或无害**，并且写进运行日志；会改状态的顺手告诉她（她多半已经在正文里
 * 说过了，所以这里只在失败时插话，别把对话刷屏）。
 */
async function runToolCalls(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const done = [];
  for (const call of list) {
    const name = String((call && call.name) || '');
    if (!AGENT_TOOLS.includes(name)) {
      bootLog(`她想调用不存在的功能「${name}」，已忽略`);
      continue;
    }
    const cap = Number(store.get().agent.toolsPerHour) || 0;
    if (cap > 0 && toolCountLastHour() >= cap) {
      bootLog(`她一小时内已经调用过 ${cap} 次软件功能了，这次先不办：${name}`);
      copilot.say(`我这一小时动软件动得有点多，先停一下手（你自己操作吧）～`, 'tool-result', { emotion: 'helpless' });
      break;
    }
    toolCallLog.push(Date.now());
    try {
      if (name === 'pause') {
        const minutes = Math.max(0, Math.min(180, Number(call.arg) || 0));
        copilot.pause(minutes ? `她自己暂停的（${minutes} 分钟后自动恢复）` : '她自己暂停的');
        clearTimeout(agentPauseTimer);
        if (minutes) {
          agentPauseTimer = setTimeout(() => {
            agentPauseTimer = null;
            copilot.resume('刚才说好的暂停时间到了');
            bootLog(`她自己暂停的时间到了，已自动恢复回复`);
          }, minutes * 60 * 1000);
        }
        done.push(minutes ? `暂停回复 ${minutes} 分钟` : '暂停回复');
      } else if (name === 'resume') {
        clearTimeout(agentPauseTimer);
        agentPauseTimer = null;
        copilot.resume('她自己恢复的');
        done.push('恢复回复');
      } else if (name === 'mute' || name === 'unmute') {
        applySettingsPatch({ speech: { muted: name === 'mute' } });
        done.push(name === 'mute' ? '静音' : '取消静音');
      } else if (name === 'warmup') {
        await copilot.warmupNow();
        done.push('主动开了个话题');
      } else if (name === 'clear') {
        copilot.clearHistory();
        done.push('清空对话记忆');
      } else if (name === 'export') {
        const text = copilot.exportHistory();
        if (!text || (!text.includes('弹幕/主播') && !text.includes('搭档'))) throw new Error('还没有对话可以导出');
        const target = path.join(app.getPath('userData'), `对话记录-${new Date().toISOString().slice(0, 10)}.md`);
        fs.writeFileSync(target, text, 'utf8');
        done.push(`导出对话记录到 ${target}`);
      }
    } catch (error) {
      bootLog(`她自己调用「${name}」失败：${error.message}`);
      copilot.say(`我想${name === 'export' ? '导出记录' : '操作一下软件'}，但没成功：${error.message}`, 'tool-result', {
        emotion: 'helpless'
      });
    }
  }
  if (done.length) bootLog(`她自己操作了软件：${done.join('、')}`);
  send(panelWindow, 'research:changed', researchQueue.list());
  return done;
}

/**
 * 主播在开发者模式下让她改自己的设定（P7）：`[改设定:人设|…]` / `[改设定:性格|…]`。
 *
 * 门槛在 copilot 里判（必须是主播本人 + 开发者模式），这里只管**安全地写下去**：
 *   · 先把旧值存一份到 `data/settings-history/<时间>.json`（后悔了能翻出来）；
 *   · 记一条运行日志（旧 → 新，截断显示）；
 *   · 走 `applySettingsPatch` 写进配置并广播给两个界面。
 */
function applySelfSettingsEdit(edits) {
  const list = Array.isArray(edits) ? edits : [];
  const persona = store.get().persona || {};
  const applied = [];
  for (const edit of list) {
    const field = edit.field === 'styleNotes' ? 'styleNotes' : 'systemPrompt';
    const value = String(edit.text || '').trim();
    if (!value) continue;
    const before = String(persona[field] || '');
    if (before === value) continue;
    // ① 备份旧值（整个 persona 一起存，方便对照）
    try {
      const dir = path.join(app.getPath('userData'), 'settings-history');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      fs.writeFileSync(
        file,
        JSON.stringify({ at: new Date().toISOString(), field, before, after: value, persona }, null, 2),
        'utf8'
      );
    } catch (error) {
      bootLog(`改设定前的备份没写成（${error.message}），这次仍然按主播的要求改`);
    }
    // ② 真改
    applySettingsPatch({ persona: { [field]: value } });
    bootLog(
      `她在开发者模式下改了自己的${edit.label || field}：` +
        `「${before.slice(0, 40) || '(空)'}」→「${value.slice(0, 40)}」（旧值备份在 data/settings-history/）`
    );
    applied.push(edit.label || field);
  }
  if (applied.length) {
    copilot.say(`好，我把自己的${applied.join('、')}改了（旧的存了一份，你随时能改回来）～`, 'settings-result', {
      emotion: 'happy'
    });
  }
  return applied;
}

/**
 * 她自己动知识库的流水线（P6）。
 *
 * 主播明确要了这一档权限：**她可以自己改错、也可以自己扩写、还可以自己记一条新的**。
 * 所以我们把「她能写库」这条路打开了，但每一步都留了退路：
 *   · 改之前**一定**先备份旧版本（`知识库/.history/`，拿文件管理器也能捞回来）；
 *   · 每次改动在面板「知识库改动记录」里留一条，**一键撤销**（新建的撤销 = 删掉它）；
 *   · 模型返回的正文先过一遍校验（空 / 拒绝回答 / 抄提示词 / 扩写没变长 / 太短 / 太长都不写）；
 *   · 一小时最多动几次由主播定（`knowledge.selfEditPerHour`，0 = 不限）。
 *
 * ⚠️ 这里是**唯一**能改 `notes/` 的地方（和 `runResearchItem` 一样），copilot 永远不碰知识库。
 */
const EDIT_SYSTEM_PROMPT =
  '你在维护一个直播间知识库里的条目正文。只输出正文本身：不要解释、不要 front-matter、不要代码块围栏、不要客套话。';

/** 让模型重写正文时用的提示词（改错 / 扩写两种） */
function buildEditPrompt(entry, item) {
  const head = `【现在这条】\n标题：${entry.title}\n正文：\n${entry.content}`;
  if (item.kind === 'expand') {
    return (
      `${head}\n\n【任务】把这条知识**扩写**得更完整：补上以后回答观众会用到的点` +
      `（玩法 / 价格 / 注意事项 / 常见误解这类），原来写对的信息照旧保留。\n\n【硬要求】\n` +
      `1. 只输出扩写后的正文（不要标题行、不要 front-matter、不要代码块）\n` +
      `2. 要比原来更长、更具体；**不许编造**——不确定的宁可不写\n` +
      `3. 中文，600 字以内`
    );
  }
  return (
    `${head}\n\n【要改的地方】${item.reason || '这条知识里有写错或过时的地方，请改正'}\n\n【硬要求】\n` +
    `1. 只输出改完的正文（不要标题行、不要 front-matter、不要代码块）\n` +
    `2. **只改该改的地方，其余照抄**，改动越小越好\n` +
    `3. 不许编造；确实不确定的部分可以整句删掉\n` +
    `4. 中文，400 字以内`
  );
}

/**
 * 校验模型改完的正文。不合格就**这次不改**（宁可不动，也不能把一条知识改坏）。
 * @returns {{ok:boolean, text?:string, reason?:string}}
 */
function checkEditedBody(raw, before, kind) {
  let text = String(raw || '').trim();
  if (!text) return { ok: false, reason: '模型返回了空内容' };
  // 去代码块围栏
  text = text.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  // 模型有时会连着标题一起回：把「正文：」后面的部分取出来
  const bodyMatch = text.match(/^\s*(?:正文|content)\s*[:：]\s*([\s\S]*)$/im);
  if (bodyMatch) text = bodyMatch[1].trim();
  if (!text) return { ok: false, reason: '去掉壳之后是空的' };
  if (/【现在这条】|【硬要求】|【任务】|【要改的地方】/.test(text)) {
    return { ok: false, reason: '模型把我的提示词抄回来了，这次不写' };
  }
  if (/(抱歉|对不起|无法(完成|修改|提供)|作为.{0,6}(AI|人工智能)|我不能)/.test(text)) {
    return { ok: false, reason: '模型没给内容（它在拒绝），这次不写' };
  }
  const beforeChars = String(before || '').length;
  if (kind === 'expand' && text.length < Math.max(beforeChars + 60, beforeChars * 1.1)) {
    return { ok: false, reason: `扩写之后没变长（${beforeChars} → ${text.length} 字），这次不写` };
  }
  if (text.length > 4000) return { ok: false, reason: `改完太长了（${text.length} 字，上限 4000），这次不写` };
  return { ok: true, text };
}

/** 最近一小时她自己动了几次**知识库**（改/扩写/记/删；联网查不算，那有单独的上限） */
function selfEditCountLastHour() {
  const since = Date.now() - 3600 * 1000;
  return researchQueue
    .list()
    .filter(
      (item) =>
        ['note', 'edit', 'expand', 'remove'].includes(item.kind) &&
        item.auto &&
        item.status === 'done' &&
        Date.parse(item.finishedAt || 0) >= since
    ).length;
}

/** 她改 / 扩写一条已有知识：找条目 → 让模型重写 → 校验 → 带备份落盘 → 回报 */
async function runKnowledgeEdit(item, { via = 'panel', auto = false } = {}) {
  const id = item.id;
  if (!item || !id) return { ok: false, message: '没有这条待办' };
  if (item.status === 'running') return { ok: false, message: '这条正在办了' };
  if (item.status === 'done') return { ok: false, message: '这条已经办过了', items: researchQueue.list() };

  // ① 先找出她说的是哪条知识（它可能只记得个大概）
  const hits = knowledge.search(item.text, { limit: 3 });
  const hit = hits.find((entry) => entry.strong) || hits[0];
  if (!hit) {
    const message = `知识库里没找到「${item.text}」这条——可能是名字差得太多，你手动改一下？`;
    researchQueue.update(id, { status: 'failed', error: message });
    bootLog(`她想改「${item.text}」但没找到这条知识`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message, items: researchQueue.list() };
  }
  const before = hit.entry;
  // 只读：锁成只读的条目连模型都不该调（省得白花一次钱，最后还被 applyEdit 拦下）
  if (before.locked) {
    const message = `「${before.title}」被主播锁成只读了，这次不改`;
    researchQueue.update(id, { status: 'failed', error: message });
    bootLog(`她想改「${before.title}」但那条是只读的，没调模型`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message, items: researchQueue.list(), noteId: before.id };
  }

  researchQueue.update(id, { status: 'running', engine: 'self-edit', error: '' });
  send(panelWindow, 'research:changed', researchQueue.list());
  bootLog(
    `她自己要${item.kind === 'expand' ? '扩写' : '改'}「${before.title}」（${before.content.length} 字）` +
      `${item.reason ? `：${item.reason}` : ''}`
  );

  // ② 让模型重写正文（thinking 关掉：这是改写活儿，不需要思考，省钱也快）
  let raw = '';
  try {
    const result = await editLlm.chat(
      [
        { role: 'system', content: EDIT_SYSTEM_PROMPT },
        { role: 'user', content: buildEditPrompt(before, item) }
      ],
      { maxTokens: 2000, temperature: 0.3 }
    );
    raw = result.content;
  } catch (error) {
    const message = `让模型改的时候失败了：${error.message}`;
    researchQueue.update(id, { status: 'failed', error: message.slice(0, 300) });
    bootLog(`改库失败（${before.title}）：${error.message}`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message, items: researchQueue.list() };
  }

  // ③ 校验 + 落盘（applyEdit 自己会先备份）
  const checked = checkEditedBody(raw, before.content, item.kind);
  if (!checked.ok) {
    researchQueue.update(id, { status: 'failed', error: checked.reason.slice(0, 300) });
    bootLog(`改库被拦下（${before.title}）：${checked.reason}`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message: checked.reason, items: researchQueue.list(), noteId: before.id };
  }
  const applied = knowledge.applyEdit(before.id, {
    content: checked.text,
    kind: item.kind,
    reason: item.reason || (auto ? '她自己发现的' : '主播让她改的'),
    source: auto ? '她自己改的' : '按主播要求改的'
  });
  if (!applied.ok) {
    researchQueue.update(id, { status: 'failed', error: String(applied.reason || '写入失败').slice(0, 300) });
    bootLog(`改库没写成（${before.title}）：${applied.reason}`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message: applied.reason, items: researchQueue.list() };
  }

  researchQueue.update(id, {
    status: 'done',
    noteId: before.id,
    editId: applied.backup ? applied.backup.id : '',
    auto,
    error: ''
  });
  bootLog(
    `改库完成（${item.kind === 'expand' ? '扩写' : '改错'}）：「${before.title}」` +
      `${applied.changed ? `${before.content.length} → ${checked.text.length} 字` : '内容没变化'}` +
      `${applied.backup ? '，旧版本已备份' : ''}`
  );
  send(panelWindow, 'research:changed', researchQueue.list());
  send(panelWindow, 'knowledge:changed', { reason: 'edit', noteId: before.id });
  return {
    ok: true,
    changed: applied.changed,
    noteId: before.id,
    title: applied.entry ? applied.entry.title : before.title,
    beforeChars: before.content.length,
    afterChars: checked.text.length,
    editId: applied.backup ? applied.backup.id : '',
    items: researchQueue.list()
  };
}

/** 她自己记一条新知识（`[记一笔:]`）：先查重，已有相关条目就补进那条 */
function runKnowledgeCreate(item, { via = 'panel', auto = false, patch = null } = {}) {
  const id = item.id;
  if (!item || !id) return { ok: false, message: '没有这条待办' };
  if (item.status === 'done') return { ok: false, message: '这条已经办过了', items: researchQueue.list() };
  const content = String((patch && patch.content) || item.text).trim();
  const result = knowledge.applyCreate({
    title: String((patch && patch.title) || item.text),
    content,
    tags: (patch && patch.tags) || '',
    reason: item.reason || (auto ? '她自己记的' : '主播让记的'),
    source: auto ? '她自己记的' : '直播记录'
  });
  if (!result.ok) {
    researchQueue.update(id, { status: 'failed', error: String(result.reason || '没记成').slice(0, 300) });
    bootLog(`记一条知识没成功：${result.reason}`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message: result.reason, items: researchQueue.list() };
  }
  researchQueue.update(id, {
    status: 'done',
    noteId: result.entry ? result.entry.id : '',
    editId: result.edit ? result.edit.id : '',
    auto,
    error: ''
  });
  bootLog(
    result.created
      ? `她自己记了一条新知识：「${result.entry.title}」（${content.length} 字，可撤销）`
      : `她把新内容并进了已有条目「${result.entry.title}」`
  );
  send(panelWindow, 'research:changed', researchQueue.list());
  send(panelWindow, 'knowledge:changed', { reason: result.created ? 'create' : 'merge', noteId: result.entry.id });
  return {
    ok: true,
    created: Boolean(result.created),
    merged: Boolean(result.merged),
    noteId: result.entry.id,
    title: result.entry.title,
    afterChars: String(result.entry.content || '').length,
    editId: result.edit ? result.edit.id : '',
    items: researchQueue.list()
  };
}

/**
 * 办完之后她该怎么跟主播说。
 * 四种类型各说各的，但都要说清三件事：**做了什么 / 进哪儿了 / 能不能撤销**。
 */
function reportResearchResult(item, result, { auto = false } = {}) {
  const kind = item.kind;
  if (!result || !result.ok) {
    const why = (result && result.message) || '看日志';
    if (kind === 'lookup') return `「${item.text}」没查成：${why}`;
    if (kind === 'note') return `「${item.text}」没记成：${why}`;
    return `「${item.text}」这次没改：${why}`;
  }
  if (kind === 'lookup') {
    return `查完了：「${item.text}」整理了 ${(result.drafts || []).length} 条，都在「待审草稿」里，点通过就进知识库～`;
  }
  if (kind === 'note') {
    if (result.created === false) return `这条我没新建——已经有「${result.title}」了，我把新内容并进去了～`;
    return auto
      ? `我顺手记了一条：「${result.title}」（${result.afterChars} 字），记错了随时能在面板撤销～`
      : `记好了：「${result.title}」（${result.afterChars} 字），面板上能撤销～`;
  }
  if (!result.changed) return `「${result.title}」我看了一遍，不用改～`;
  const arrow = `${result.beforeChars} → ${result.afterChars} 字`;
  return kind === 'expand'
    ? `我给「${result.title}」补好了（${arrow}），旧版本留着，面板上能撤销～`
    : `我把「${result.title}」改好了（${arrow}），旧版本留着，面板上能撤销～`;
}

/**
 * 「记一笔」→ 直接变成知识库里的一条（P6 起她有权直接写）。
 * 以前是先落「待审草稿」等主播点通过；现在主播把权限交给她了，所以直接入库，
 * 但和改库一样：**留一条改动记录、一键能撤销**（新建的撤销 = 删掉这条）。
 * 想先审再入库，就把「她自己动库」设成「先问我」或「不自动改」。
 */
function noteResearchItem(id, { patch, via = 'panel' } = {}) {
  const item = researchQueue.get(id);
  if (!item) return { ok: false, message: `没有这条待办：${id}` };
  return runKnowledgeCreate(item, { via, patch });
}

/**
 * 她自己删掉一条知识（P7，只在最高权限下才走到这儿）。
 * `knowledge.remove()` 自己会**先备份再删**，改动记录里能一键恢复。
 */
function runKnowledgeRemove(item, { via = 'panel', auto = false } = {}) {
  const id = item.id;
  if (!item || !id) return { ok: false, message: '没有这条待办' };
  if (item.status === 'done') return { ok: false, message: '这条已经办过了', items: researchQueue.list() };
  const hits = knowledge.search(item.text, { limit: 3 });
  const hit = hits.find((entry) => entry.strong) || hits[0];
  if (!hit) {
    const message = `知识库里没找到「${item.text}」这条，没删`;
    researchQueue.update(id, { status: 'failed', error: message });
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message, items: researchQueue.list() };
  }
  const entry = hit.entry;
  // 只读：主播锁成只读的条目模型不许删（锁 = 模型完全不能改/删，但仍参与检索）
  if (entry.locked) {
    const message = `「${entry.title}」被主播锁成只读了，这条不删`;
    researchQueue.update(id, { status: 'failed', error: message });
    bootLog(`她想删「${entry.title}」但那条是只读的，没删`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message, items: researchQueue.list() };
  }
  const ok = knowledge.remove(entry.id);
  if (!ok) {
    researchQueue.update(id, { status: 'failed', error: '删除失败（看日志）' });
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message: '删除失败', items: researchQueue.list() };
  }
  researchQueue.update(id, { status: 'done', noteId: entry.id, auto, error: '' });
  bootLog(`她删掉了一条知识：「${entry.title}」（删除前已备份，能恢复）`);
  send(panelWindow, 'research:changed', researchQueue.list());
  send(panelWindow, 'knowledge:changed', { reason: 'remove', noteId: entry.id });
  return { ok: true, removed: true, title: entry.title, noteId: entry.id, items: researchQueue.list() };
}

/**
 * 办一条待办（**所有入口都走这里**：面板按钮 / 对话里同意 / 主播点名 / 她自己动手）。
 * 按类型分派：查 → 联网；记 → 建条目；改 / 扩写 → 改条目；删 → 删条目。
 */
async function runResearchItem(id, { via = 'panel', auto = false, patch = null } = {}) {
  const item = researchQueue.get(id);
  if (!item) return { ok: false, message: `没有这条待办：${id}` };
  copilot.clearResearchAsk(id);
  if (item.kind === 'note') return runKnowledgeCreate(item, { via, auto, patch });
  if (item.kind === 'edit' || item.kind === 'expand') return runKnowledgeEdit(item, { via, auto });
  if (item.kind === 'remove') return runKnowledgeRemove(item, { via, auto });
  return runResearchQuery(item, { via, auto });
}

/**
 * 「去查」→ 真去联网查一次，产出进「待审」。
 *
 * 走哪条路跟着设置（面板上能选，都保留、随时能换）：
 *   · `engine: 'builtin'`（默认）再看 `searchMode`：
 *       - `self`（默认）：**自研搜索接口** `POST /v1/tools/search` 搜一次 → 模型照着结果整理。
 *         实测 0.7 秒出结果、整条约 3 秒、约 0.008 元。**失败会自动退回下面那条。**
 *       - `model`：老办法，Anthropic 兼容接口 + 服务端 web_search，模型一边搜一边写，
 *         实测 6~15 秒、约 0.03 元（11 月 1 日起服务端搜索另按 0.005 元/次计费）。
 *   · `engine: 'dsh'`：交给本机的 DeepSeek Harness（能读文件、能联网），慢但能干更复杂的活。
 * 三条路产出格式完全一样：**只进待审**；失败只影响这一条待办。
 *
 * `via` 只用于日志：面板点按钮 还是 主播在对话里回了一句「查」。
 */
async function runResearchQuery(item, { via = 'panel', auto = false } = {}) {
  const id = item.id;
  if (item.status === 'running') return { ok: false, message: '这条正在查了' };
  if (item.status === 'done') return { ok: false, message: '这条已经办过了', items: researchQueue.list() };
  // 主播自己动手了：她等着的那句问话作废，别再等他回答
  copilot.clearResearchAsk(id);
  const settings = store.get();
  // ⚠️ DSH 研究引擎已下线（2026-10-19）：这里**固定走内置联网**。
  //   即使配置里还写着 `engine: 'dsh'` 也不再调 DSH —— 否则有人手改配置就会悄悄拉起
  //   一个 dsh 进程、等上几十秒。想恢复：把这行改回
  //   `const engine = settings.knowledge.engine === 'dsh' ? 'dsh' : 'builtin';`
  const engine = 'builtin';
  const searchMode = settings.knowledge.searchMode === 'model' ? 'model' : 'self';
  // 面板和日志上要一眼看出这次是哪条路办的（三条路的用时差一个数量级）
  const engineLabel = engine === 'dsh' ? 'DSH' : searchMode === 'self' ? '自研搜索' : '模型联网';
  // `auto` 记在待办上：`agent.searchPerHour`（她自己查的次数上限）就是数这个
  researchQueue.update(id, { status: 'running', engine, error: '', auto });
  send(panelWindow, 'research:changed', researchQueue.list());
  const task = buildTaskPrompt(
    `查一下「${item.text}」，把它整理成 1~3 条直播时能用上的知识` +
      `${item.reason ? `（为什么查：${item.reason}）` : ''}。` +
      `只写确定的信息（版本、类型、玩法/看点、价格这类），不确定的宁可不写。`
  );
  bootLog(`去查资料（${engineLabel}${via === 'chat' ? '，主播在对话里同意的' : ''}）：${item.text.slice(0, 60)}`);
  const apiConfig = {
    apiKey: settings.api.apiKey,
    baseUrl: settings.api.baseUrl,
    model: settings.api.model,
    logger
  };
  // 两条内置联网都沿用同一个超时设置（原本是给 DSH 用的 `dshTimeoutSec`，
  // 顺手兼职成联网查询的超时；DSH 下线后这个键就只剩这一个用途，但改名会动到老配置，先留着）
  const legacyTimeoutMs = Math.max(30000, Number(settings.knowledge.dshTimeoutSec || 300) * 1000);
  let result;
  if (engine === 'dsh') {
    // ⚠️ 死代码（2026-10-19 起的「DSH 已下线」）：engine 被上面钉成 'builtin' 之后这里进不来。
    //    保留它是恢复 DSH 时唯一要改的地方之一（另两处：index.html 的 hidden、本函数开头的 engine 赋值）。
    const mode = settings.knowledge.dshMode === 'headless' ? 'headless' : 'session';
    result =
      mode === 'session' ? await dshSession.prompt(task) : await dsh.runTask({ task, cwd: knowledge.dir });
    if (result.ok) attachDshSession(dshSession.sessionId);
  } else if (searchMode === 'self') {
    result = await searchViaSearchApi({
      ...apiConfig,
      keyword: item.text,
      // 主播原话 → ori_question：搜索引擎知道「到底在问什么」才排得准
      oriQuestion: item.reason || item.text,
      task,
      timeoutMs: 30000
    });
    if (!result.ok) {
      // 自研搜索没成（接口没开 / 网络 / 余额 / 空结果）→ 退回老办法再试一次。
      // 失败的那次搜索不计费，所以这条兜底基本不额外花钱。
      bootLog(`自研搜索没成（${result.message}），退回模型联网再试一次`);
      result = { ...(await searchWithDeepSeek({ ...apiConfig, query: task, timeoutMs: legacyTimeoutMs })), fellBackFrom: 'self' };
    }
  } else {
    result = await searchWithDeepSeek({ ...apiConfig, query: task, timeoutMs: legacyTimeoutMs });
  }
  if (!result.ok) {
    researchQueue.update(id, { status: 'failed', error: String(result.message || '查询失败').slice(0, 300) });
    bootLog(`查资料失败：${result.message}`);
    send(panelWindow, 'research:changed', researchQueue.list());
    return { ok: false, message: result.message || '查询失败', items: researchQueue.list(), engine, searchMode };
  }
  const drafts = [];
  for (const draft of parseDrafts(result.output || result.text || '', { source: `联网查 · ${item.text}`, engine: engineLabel })) {
    try {
      drafts.push(knowledge.addPending(draft));
    } catch (error) {
      bootLog(`草稿存不下来：${error.message}`);
    }
  }
  // 最高权限：她自己把这些产出通过掉（每条都留记录，面板上能撤销）
  const autoApproved = autoApproveDrafts(drafts, { reason: `她自己查「${item.text}」查到的` });
  researchQueue.update(id, {
    status: drafts.length ? 'done' : 'failed',
    draftIds: drafts.map((draft) => draft.id),
    error: drafts.length ? '' : '查到了内容，但没能解析成条目'
  });
  bootLog(
    `查资料完成（${engineLabel}）：${drafts.length} 条草稿进待审，用时 ${Math.round(Number(result.ms || 0) / 1000)} 秒` +
      `${result.degraded ? '（整理那步没成，直接收的摘要）' : ''}` +
      `${result.searches ? `，${result.searches} 次搜索 / ${result.results || 0} 条结果` : ''}` +
      `${autoApproved.approved.length ? `，其中 ${autoApproved.approved.length} 条她自己写进知识库了` : ''}`
  );
  send(panelWindow, 'research:changed', researchQueue.list());
  if (autoApproved.approved.length) send(panelWindow, 'knowledge:changed', { reason: 'auto-approve' });
  // 「查完了」也告诉面板一声：它在右下角弹一条**带按钮**的提示（全部通过 / 先放着），
  // 省得主播再点进知识库页一条条点通过。`kept` 是「还留在待审里的」：
  // 没开最高权限时是全部草稿，开了之后是超额剩下的那些。
  announceDrafts(autoApproved.kept, { source: 'query', autoApproved: autoApproved.approved.length });
  return {
    ok: drafts.length > 0,
    drafts,
    engine,
    searchMode,
    engineLabel,
    fellBackFrom: result.fellBackFrom || '',
    degraded: Boolean(result.degraded),
    sources: Array.isArray(result.sources) ? result.sources : [],
    ms: Number(result.ms || 0),
    searches: Number(result.searches || 0),
    items: researchQueue.list(),
    message: drafts.length ? '' : '查到了内容，但没能解析成条目——输出在日志里，可以自己复制进「添加条目」'
  };
}

/**
 * 最高权限下，把刚产生的草稿**她自己通过掉**（P7）。
 *
 * 三条克制：
 *   · 只有 `agent.maxPermissions` 打开时才做（没打开就照旧留在「待审」等主播点）；
 *   · 沿用 `knowledge.selfEditPerHour` 的次数上限——到顶就停下，剩下的留在待审里；
 *   · 每条都会写一条「新建」记录（撤销 = 删掉那条），所以通过错了也能退回。
 */
function autoApproveDrafts(drafts, { reason = '' } = {}) {
  const list = Array.isArray(drafts) ? drafts : [];
  const maxMode = Boolean(store.get().agent && store.get().agent.maxPermissions);
  const approved = [];
  const kept = [];
  if (!maxMode || !list.length) return { approved, kept: list, auto: false };
  const cap = Number(store.get().knowledge.selfEditPerHour) || 0;
  let used = selfEditCountLastHour();
  for (const draft of list) {
    if (cap > 0 && used >= cap) {
      kept.push(draft);
      continue;
    }
    try {
      const entry = knowledge.approvePending(draft.id, {}, { record: true, reason: reason || '她自己查到的' });
      approved.push(entry);
      used += 1;
    } catch (error) {
      bootLog(`自动通过草稿失败（${error.message}），留在待审里`);
      kept.push(draft);
    }
  }
  if (kept.length && approved.length) bootLog(`改库次数到顶，剩下 ${kept.length} 条留在待审里等主播点`);
  return { approved, kept, auto: true };
}

/**
 * 告诉面板「有草稿进待审了」，让它在右下角弹一条**带按钮**的提示（全部通过 / 先放着）。
 *
 * 主播的原话：查完只在角落提示一句「放在待办了」，还得点进知识库页再一条条点通过，太麻烦。
 * 所以这里把「有 N 条待审草稿」连同标题一起推给界面，界面上直接给「全部通过」按钮。
 * `autoApproved` > 0 表示有一部分她已经自己入库了（最高权限），提示里要说明白。
 */
function announceDrafts(drafts, { source = 'query', autoApproved = 0 } = {}) {
  const list = Array.isArray(drafts) ? drafts.filter((draft) => draft && draft.id) : [];
  if (!list.length && !autoApproved) return;
  // 草稿一进待审，知识库就算变了：**必须广播 `knowledge:changed`**。
  // 曾经只在「最高权限自己通过掉」时才发，于是「对话里回一句查」出来的草稿在面板上
  // 一直不显示（弹窗能点通过、面板里的待审列表是空的）—— 主播报的就是这个。
  send(panelWindow, 'knowledge:changed', { reason: 'drafts', count: list.length });
  send(panelWindow, 'drafts:ready', {
    count: list.length,
    titles: list.map((draft) => String(draft.title || '').slice(0, 40)).filter(Boolean),
    source,
    autoApproved
  });
}

/**
 * 云端语音合成。放在主进程：密钥不进界面进程、没有 CORS、缓存两个界面共用。
 * 配置直接读 store，改了设置立刻生效（不用重建客户端）。
 */
const tts = new TtsClient({
  getConfig: () => store.get().speech.cloud || {},
  logger
});
const biliLogin = new BiliLogin({
  store,
  logger,
  onChanged: (status) => {
    broadcast('bili:login', status);
    // 登录状态变化时，如果正在监听弹幕，自动用新身份重连（这样就能看到昵称了）
    if (status && status.loggedIn && copilot.client && copilot.client.running) {
      logger.info('检测到账号登录，正在用登录身份重连弹幕服务器…');
      copilot.stopDanmaku().then(() => copilot.startDanmaku()).catch(() => {});
    }
  }
});

let panelWindow = null;
let overlayWindow = null;
let tray = null;
let quitting = false;

// ---------------------------------------------------------------- 悬浮窗

/**
 * 窗口被允许留在屏幕外时，**至少**要留多少像素在屏幕里。
 *
 * 48 的来历：顶栏高 34px、右侧那几个按钮 24px 宽——留 48×48 够把鼠标放上去按住拖回来。
 * 再小就会出现「窗口还在，但抓不住」的情况。
 */
const MIN_VISIBLE = 48;

function computeVirtualBounds() {
  const displays = screen.getAllDisplays();
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const display of displays) {
    left = Math.min(left, display.bounds.x);
    top = Math.min(top, display.bounds.y);
    right = Math.max(right, display.bounds.x + display.bounds.width);
    bottom = Math.max(bottom, display.bounds.y + display.bounds.height);
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, width: 1280, height: 800 };
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const bounds = computeVirtualBounds();
  overlayWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    // 悬浮窗现在只有卡片那么大，所以按普通窗口处理：
    // 可以聚焦（否则在 Windows 上收不到正常鼠标消息，按钮点不动、也拖不动）、
    // 但用户不能手动拉边框改大小（尺寸由内容决定）。
    focusable: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    title: '直播AI搭档-悬浮窗',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWindow.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
  watchWindowHealth(overlayWindow, '悬浮窗');
  overlayWindow.once('ready-to-show', () => {
    overlayWindow.showInactive();
    overlayWindow.setFocusable(true);
    applyOverlayConfig(store.get().overlay);
    // 每次显示悬浮窗都从「收起快捷设置」的状态开始，
    // 避免因为上次没关而出现「有时候一打开就弹设置」的情况。
    if (store.get().overlay.autoOpenDrawer === true) {
      send(overlayWindow, 'overlay:openDrawer', true);
    } else {
      send(overlayWindow, 'overlay:closeDrawer', true);
    }
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });
  if (IS_DEV) overlayWindow.webContents.openDevTools({ mode: 'detach' });
  return overlayWindow;
}

function applyOverlayConfig(overlay) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayWindow.setAlwaysOnTop(Boolean(overlay.alwaysOnTop), 'screen-saver');
  if (typeof overlayWindow.setContentProtection === 'function') {
    overlayWindow.setContentProtection(Boolean(overlay.hideInScreenshot));
  }
  // 悬浮窗现在就只有卡片这么大，不存在「挡住整个桌面」的问题，
  // 所以恒定为可交互——否则会出现按钮点不动的情况。
  setOverlayIgnoreMouse(false);
  send(overlayWindow, 'overlay:config', overlay);
}

let ignoreMouseState = null;
function setOverlayIgnoreMouse(ignore) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  ignoreMouseState = ignore;
  // 不要用 { forward: true }：forward 是把鼠标消息转发给页面而不是正常处理，
  // 那是「覆盖全屏的透明窗」才需要的模式。现在悬浮窗只有卡片这么大，
  // 用普通模式才能正常点击 / 拖动。
  overlayWindow.setIgnoreMouseEvents(ignore);
}

// ---------------------------------------------------------------- 控制面板

function createPanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.show();
    panelWindow.focus();
    return panelWindow;
  }
  const { panelWidth, panelHeight } = store.get().window;
  panelWindow = new BrowserWindow({
    width: panelWidth || 1040,
    height: panelHeight || 760,
    minWidth: 900,
    minHeight: 620,
    title: '直播 AI 搭档 · 控制面板',
    backgroundColor: '#12141c',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  panelWindow.loadFile(path.join(__dirname, '..', 'renderer', 'panel', 'index.html'));
  watchWindowHealth(panelWindow, '控制面板');
  panelWindow.once('ready-to-show', () => {
    panelWindow.show();
    pushLogHistory();
    send(panelWindow, 'settings:changed', publicSettings());
    send(panelWindow, 'status', copilot.status());
  });
  // 关闭控制面板 = 退出整个程序（悬浮窗和托盘一起收掉）。
  // 用户期望「软件关掉，悬浮窗也别留」，所以这里不再最小化到托盘。
  panelWindow.on('close', () => {
    if (!quitting) quitApp();
  });
  panelWindow.on('closed', () => {
    panelWindow = null;
  });
  if (IS_DEV) panelWindow.webContents.openDevTools({ mode: 'detach' });
  return panelWindow;
}

/** 退出程序：先收掉托盘和悬浮窗，再退出（避免托盘图标残留） */
function quitApp() {
  if (quitting) return;
  quitting = true;
  logger.info('正在退出程序');
  bootLog('开始退出：收掉托盘与悬浮窗');
  // 观众记忆：退出时**不等网络**（等网络会卡住关不掉），直接把本场收尾、名册落盘，
  // 没来得及总结的条数如实写在文件末尾。
  try {
    const unsaved = memoryRuntime.buffer.length;
    if (viewerMemory.isRecording()) {
      viewerMemory.endSession({ unsaved });
      bootLog(`观众记忆：本场收尾${unsaved ? `（有 ${unsaved} 条没来得及总结）` : ''}`);
    } else {
      viewerMemory.flushRoster();
    }
  } catch (error) {
    bootLog(`观众记忆退出时收尾失败：${error.message}`);
  }
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch (error) {
    bootLog(`销毁托盘失败: ${error.message}`);
  }
  try {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  } catch (error) {
    bootLog(`销毁悬浮窗失败: ${error.message}`);
  }
  try {
    if (panelWindow && !panelWindow.isDestroyed()) panelWindow.destroy();
  } catch (error) {
    bootLog(`销毁控制面板失败: ${error.message}`);
  }
  app.quit();
}

function createTray() {
  try {
    const icon = buildTrayIcon();
    tray = new Tray(icon);
    tray.setToolTip('直播 AI 搭档');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开控制面板', click: () => createPanelWindow() },
        { label: '显示/隐藏悬浮窗', click: () => toggleOverlay() },
        { type: 'separator' },
        {
          label: '开始监听弹幕',
          click: () => copilot.startDanmaku().catch(() => {})
        },
        {
          label: '停止监听弹幕',
          click: () => copilot.stopDanmaku().catch(() => {})
        },
        { type: 'separator' },
        {
          label: '退出程序',
          click: () => quitApp()
        }
      ])
    );
    tray.on('double-click', () => createPanelWindow());
  } catch (error) {
    logger.warn(`托盘创建失败（不影响使用）: ${error.message}`);
  }
}

function toggleOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) {
    // 用户主动打开：标记为「需要」，这样后续崩溃自愈才有意义
    overlayWanted = true;
    createOverlayWindow();
    overlayWindow.once('ready-to-show', () => applyOverlayConfig(store.get().overlay));
    return true;
  }
  if (overlayWindow.isVisible()) {
    overlayWindow.hide();
    overlayWanted = false;
    return false;
  }
  overlayWanted = true;
  overlayWindow.showInactive();
  applyOverlayConfig(store.get().overlay);
  return true;
}

// ---------------------------------------------------------------- 工具

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/**
 * 悬浮窗「是否被需要」。
 * 为 false 时，任何后台广播（弹幕状态、回复等）都不应该把它创建/显示出来——
 * 这是「启动默认不显示悬浮窗」的关键：以前 broadcast 会顺手创建窗口，
 * 弹幕一连上就冒出悬浮窗，看起来像是「有时候自己打开了」。
 */
let overlayWanted = false;

/** 悬浮窗被意外关掉（崩溃/被系统清理）时自动重建，但只在「本来就在用」的情况下 */
function ensureOverlay() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return true;
  if (quitting || !overlayWanted) return false;
  logger.warn('悬浮窗不存在，正在重建');
  createOverlayWindow();
  return false;
}

/** 推给悬浮窗：不存在就创建（仅在确实需要显示时） */
function sendToOverlay(channel, payload) {
  ensureOverlay();
  send(overlayWindow, channel, payload);
}

/** 推给悬浮窗：不存在就算了，不要因为一条状态广播就把窗口创建出来 */
function sendToOverlayIfExists(channel, payload) {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  send(overlayWindow, channel, payload);
}

function broadcast(channel, payload) {
  send(panelWindow, channel, payload);
  sendToOverlayIfExists(channel, payload);
}

/**
 * 把 DSH 会话登记进「知识库」工作区。
 *
 * 为什么必须做：DSH Web 的侧边栏**只按工作区登记表里的显式 `sessionIds` 分组**
 * （`dsh-client-ui-workspace` 的 `owningGroupKey()`），不登记就一律显示成「未分组」。
 * 登记是幂等的，失败也只记日志——分组不好看不能影响整理本身。
 */
function attachDshSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return;
  try {
    const result = attachSessionToWorkspace({ sessionId: id, cwd: knowledge.dir, title: path.basename(knowledge.dir) });
    if (result.changed) {
      bootLog(`DSH 会话已登记进工作区「${path.basename(knowledge.dir)}」${result.created ? '（新建工作区）' : ''}`);
    } else if (!result.ok) {
      bootLog(`DSH 会话没能登记进工作区（${result.reason}），Web 里可能显示在「未分组」`);
    }
  } catch (error) {
    bootLog(`DSH 会话登记出错（不影响整理）：${error.message}`);
  }
}

/**
 * 把一份设置改动落盘并广播给两个界面（界面提交、AI 自己记规则都走这里）。
 * 为什么不复用 `settings:update` 那个 handler：那边是 IPC 入口，签名不一样，
 * 而且这里要能被主进程内部直接调用。
 */
function applySettingsPatch(partial) {
  const before = store.get();
  const next = store.patch(partial || {});
  logger.configure({
    maxMemory: next.logging.maxMemory,
    writeFile: next.logging.writeFile
  });
  if (JSON.stringify(before.danmakuLog) !== JSON.stringify(next.danmakuLog)) {
    danmakuRecorder.configure(next.danmakuLog);
    bootLog(`弹幕记录${danmakuRecorder.enabled ? `已开启: ${danmakuRecorder.filePath}` : '已关闭'}`);
  }
  if (JSON.stringify(before.overlay) !== JSON.stringify(next.overlay)) {
    applyOverlayConfig(next.overlay);
  }
  // 观众记忆的开关/参数变了：开 → 新建本场文件，关 → 收尾（并广播状态给面板）
  if (JSON.stringify(before.viewerMemory) !== JSON.stringify(next.viewerMemory)) {
    syncMemoryFeature();
    // 直播中把「启动时自动记录」打开、而这一场没在记 → 现在就开始（不然要等下次启动，
    // 点了像没反应）。只在它**从关变开**时动手：主播手动关掉本场时 autoStart 没变，
    // 不能又替她打开（那是「下次启动」的事）。
    const turnedOn = before.viewerMemory.autoStart === false && next.viewerMemory.autoStart !== false;
    if (turnedOn && !viewerMemory.isRecording()) {
      store.patch({ viewerMemory: { enabled: true } });
      syncMemoryFeature();
      bootLog('观众记忆：打开「启动时自动记录」，这一场现在就开始记');
    }
  }
  send(overlayWindow, 'settings:changed', next);
  send(panelWindow, 'settings:changed', next);
  return next;
}

function publicSettings() {
  return store.get();
}

function pushLogHistory() {
  send(panelWindow, 'log:history', logger.history());
}

// ---------------------------------------------------------------- 事件转发

function wireEvents() {
  logger.onChange((entry) => send(panelWindow, 'log', entry));

  copilot.on('status', (status) => broadcast('status', status));
  // 弹幕要同时推给控制面板和悬浮窗——悬浮窗的对话区靠它显示观众说了什么。
  // 这里用 sendToOverlayIfExists 而不是 broadcast：悬浮窗没开的时候，
  // 不能因为来了一条弹幕就把窗口凭空创建出来。
  copilot.on('danmaku', (event) => {
    send(panelWindow, 'danmaku', event);
    sendToOverlayIfExists('danmaku', event);
  });
  copilot.on('filtered', (payload) => send(panelWindow, 'danmaku:filtered', payload));
  // 礼物 / 上舰 / 进场那条 `live-event` 通道 2026-10-21 一并删了（连同解析一起，见 danmaku.js）。
  copilot.on('reply', (reply) => {
    broadcast('ai:reply', reply);
    if (reply.source === 'operator') send(panelWindow, 'ai:reply', reply);
  });
  copilot.on('self-note', (note) => send(panelWindow, 'ai:selfNote', note));
  // 她开口问了主播一句「要不要去查 / 记」：记一笔启动日志（面板靠 research:changed + 她的那句话看到）
  copilot.on('research-ask', (payload) =>
    bootLog(`问她要不要${payload.kind === 'lookup' ? '去查' : '记下来'}「${payload.item}」：${payload.said}`)
  );
  // 主播在对话里同意：**真去办**（和面板点按钮走同一段代码），办完再跟他说一声。
  // 「模型只能提议」这条不变量没变：提议归模型，动手归主播点头 —— 这里点头的就是主播。
  copilot.on('research-approve', async (payload) => {
    const item = payload && payload.item;
    if (!item || !item.id) return;
    const result = await runResearchItem(item.id, { via: 'chat' });
    copilot.say(reportResearchResult(item, result), 'research-result', {
      emotion: result.ok ? 'happy' : 'helpless'
    });
  });
  // 她自己动手（selfEdit=auto）：改错 / 扩写 / 记一条。
  // 限额由主播定（`knowledge.selfEditPerHour`，0 = 不限）；超了就攒着等他在面板点。
  copilot.on('knowledge-edit', async (payload) => {
    const item = payload && payload.item;
    if (!item || !item.id) return;
    const cap = Number(store.get().knowledge.selfEditPerHour) || 0;
    if (cap > 0 && selfEditCountLastHour() >= cap) {
      bootLog(`她已经自己动过 ${cap} 次库了，这条先攒着：${item.text}`);
      copilot.say(
        `我已经自己动过 ${cap} 次知识库了，这条先攒着——你在面板点一下我就办～`,
        'research-result',
        { emotion: 'helpless' }
      );
      return;
    }
    const result = await runResearchItem(item.id, { via: 'auto', auto: true });
    copilot.say(reportResearchResult(item, result, { auto: true }), 'research-result', {
      emotion: result.ok ? 'happy' : 'helpless'
    });
  });
  // 她自己调用软件功能（P7，最高权限下 copilot 才放行）：执行全在这边
  copilot.on('tool-call', (payload) => {
    runToolCalls(payload && payload.calls).catch((error) => bootLog(`她调用软件功能出错：${error.message}`));
  });
  // 主播在开发者模式下让她改自己的设定（P7）：留一份旧值再改
  copilot.on('settings-edit', (payload) => applySelfSettingsEdit(payload && payload.edits));
  // 主播说先不办：把这条待办标成「已忽略」，别让它一直挂在卡片上
  copilot.on('research-refuse', (payload) => {
    const item = payload && payload.item;
    if (!item || !item.id) return;
    researchQueue.update(item.id, { status: 'ignored' });
    send(panelWindow, 'research:changed', researchQueue.list());
    bootLog(`主播说先不办：${item.text}`);
  });
  // 主播在输入框里**点名**要她查 / 记 / 扩写：不用再问一遍，直接办。
  // 还是同一段执行代码（runResearchItem），只是"点头"换成了他自己开口。
  copilot.on('research-request', async (payload) => {
    const kind = ['note', 'edit', 'expand'].includes(payload && payload.kind) ? payload.kind : 'lookup';
    const text = String((payload && payload.text) || '').trim();
    if (!text) return;
    // 队列自己去重：十分钟内提过的同一条会拿回原来那条，不会又建一条
    const added = researchQueue.add({ kind, text, reason: '主播在对话里直接要求的', source: '来自 主播 的要求' });
    if (!added.ok || !added.item) {
      copilot.say(`「${text}」我记不下来（${added.reason || '队列出问题了'}），你看一眼日志？`, 'research-result', { emotion: 'helpless' });
      return;
    }
    const item = added.item;
    copilot.clearResearchAsk(item.id);
    send(panelWindow, 'research:changed', researchQueue.list());
    if (item.status === 'running') {
      copilot.say(`「${text}」正在办了，稍等一下～`, 'research-result');
      return;
    }
    if (item.status === 'done') {
      copilot.say(`「${text}」刚办过了，结果在「待审草稿」/ 知识库里～`, 'research-result');
      return;
    }
    bootLog(`主播点名要${kind === 'lookup' ? '查' : kind === 'note' ? '记' : kind === 'edit' ? '改' : '扩写'}：${text}`);
    const result = await runResearchItem(item.id, { via: 'chat' });
    copilot.say(reportResearchResult(item, result), 'research-result', {
      emotion: result.ok ? 'happy' : 'helpless'
    });
  });
  copilot.on('paused', ({ paused, reason }) => {
    broadcast('ai:paused', { paused, reason });
    send(panelWindow, 'log', {
      ts: Date.now(),
      level: paused ? 'warn' : 'info',
      message: paused ? `已自动暂停回复：${reason}` : '已恢复回复'
    });
  });
  // 主动搭话（2026-10-21 替换原来的「冷场暖场」）：面板日志要看得出是哪一种、说了什么
  copilot.on('proactive', ({ mode, label, text }) => {
    send(panelWindow, 'log', {
      ts: Date.now(),
      level: 'info',
      message: `主动搭话（${label || mode || '主动'}）：${String(text || '').slice(0, 40)}`
    });
  });
  copilot.on('thinking', (value) => broadcast('ai:thinking', value));
  copilot.on('bot-state', (value) => send(overlayWindow, 'overlay:state', value));
  copilot.on('error', (payload) => {
    broadcast('app:error', payload);
    send(panelWindow, 'log', { ts: Date.now(), level: 'error', message: payload.message });
  });
  copilot.on('room-info', (info) => broadcast('room-info', info));
  copilot.on('popularity', (value) => send(panelWindow, 'popularity', value));
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('settings:get', () => publicSettings());

  ipcMain.handle('settings:update', (_event, partial) => applySettingsPatch(partial || {}));

  ipcMain.handle('settings:reset', () => {
    const next = store.reset();
    danmakuRecorder.configure(next.danmakuLog);
    applyOverlayConfig(next.overlay);
    send(overlayWindow, 'settings:changed', next);
    send(panelWindow, 'settings:changed', next);
    return next;
  });

  ipcMain.handle('settings:defaultPersona', () => DEFAULT_PERSONA);

  ipcMain.handle('settings:openFolder', async () => {
    const folder = store.file ? path.dirname(store.file) : app.getPath('userData');
    await shell.openPath(folder);
    return folder;
  });

  ipcMain.handle('app:info', () => ({
    dataFolder: store.file ? path.dirname(store.file) : app.getPath('userData'),
    settingsFile: store.file || '',
    logFile: logger.file || '',
    appPath: app.getAppPath(),
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }));

  // ---- 悬浮窗 ----
  ipcMain.handle('overlay:setClickThrough', (_event, ignore) => {
    // 保留这个通道只是为了兼容旧界面；现在悬浮窗恒定为可交互
    void ignore;
    setOverlayIgnoreMouse(false);
    return false;
  });
  ipcMain.handle('overlay:hitTest', (_event, ignore) => {
    void ignore;
    setOverlayIgnoreMouse(false);
    return true;
  });
  /**
   * 兼容通道：界面早期会在这里请求「临时可聚焦 / 不可聚焦」。
   * 那套动态焦点管理会导致切换窗口时闪动（focus/blur 反复切换），已经去掉了。
   * 悬浮窗保持恒定可聚焦，焦点完全交给系统处理，所以这里只回一个状态。
   */
  ipcMain.handle('overlay:setFocusable', () => true);
  ipcMain.handle('overlay:toggle', () => toggleOverlay());
  ipcMain.handle('overlay:isVisible', () =>
    Boolean(overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible())
  );
  // 从悬浮窗里关闭自己：只关悬浮窗，程序继续在托盘/面板里运行
  ipcMain.handle('overlay:hide', () => {
    // 标记为「不再需要」：这样后台广播不会又把它创建出来
    overlayWanted = false;
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      // 把焦点还回去，避免关掉之后键盘输入还留在已隐藏的窗口上
      try {
        if (typeof overlayWindow.blur === 'function') overlayWindow.blur();
      } catch (_) {
        /* ignore */
      }
      overlayWindow.hide();
      logger.info('悬浮窗已关闭（可在控制面板重新打开）');
    }
    return false;
  });
  ipcMain.handle('overlay:reload', () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.reload();
    return true;
  });
  ipcMain.handle('overlay:openDrawer', () => {
    // 这是用户主动要求打开设置，等于要显示悬浮窗
    overlayWanted = true;
    if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
    overlayWindow.showInactive();
    setOverlayIgnoreMouse(false);
    send(overlayWindow, 'overlay:openDrawer', true);
    return true;
  });

  // ---- B 站账号登录 ----
  ipcMain.handle('bili:loginStatus', () => biliLogin.status());
  ipcMain.handle('bili:loginOpen', async () => {
    await biliLogin.open();
    return biliLogin.status();
  });
  ipcMain.handle('bili:loginLogout', async () => biliLogin.logout());
  ipcMain.handle('bili:loginVerify', async () => {
    try {
      return await biliLogin.verify();
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('bili:verifyManualCookie', async (_event, text) => {
    try {
      return await biliLogin.verifyManual(text);
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('bili:cookieHeader', () => biliLogin.currentCookieHeader());

  // ---- 弹幕 ----
  ipcMain.handle('danmaku:start', async () => {
    try {
      return await copilot.startDanmaku();
    } catch (error) {
      return { error: error.message };
    }
  });
  ipcMain.handle('danmaku:stop', async () => {
    await copilot.stopDanmaku();
    return copilot.status();
  });
  ipcMain.handle('danmaku:test', async (_event, roomId) => {
    try {
      return { ok: true, data: await copilot.testDanmaku(roomId) };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });

  // ---- AI ----
  ipcMain.handle('llm:test', async () => {
    try {
      return { ok: true, data: await copilot.testLLM() };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('copilot:talk', async (_event, text) => {
    try {
      const reply = await copilot.talk(text);
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('copilot:replyRecent', async (_event, seconds) => {
    try {
      const reply = await copilot.replyRecent(seconds || 30);
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('copilot:clearHistory', () => {
    copilot.clearHistory();
    return true;
  });
  ipcMain.handle('copilot:clearSelfNote', () => {
    copilot.clearSelfNote();
    return true;
  });
  ipcMain.handle('copilot:selfNote', () => store.get().persona.selfNote || '');
  // 完整系统提示词（含程序追加的规则）：界面上要能看、能改。
  // 不带参数 = 给模板（带占位符，可编辑）；带 true = 给渲染后的最终文本（预览用）。
  ipcMain.handle('copilot:systemPrompt', (_event, wantRendered) =>
    wantRendered ? copilot.buildSystemPrompt() : copilot.buildSystemPromptTemplate()
  );

  // ---- 云端语音合成 ----
  // 返回 { ok: true, audio, mime } 或 { ok: false, message }（界面据此决定要不要退回系统语音）。
  // 刻意不 reject：IPC 抛错在界面侧只能拿到一句 "Error invoking remote method"，
  // 把真实原因（Key 无效 / 超时 / 没额度）放在 message 里，界面才能提示到点上。
  ipcMain.handle('tts:synthesize', async (_event, text) => {
    try {
      const result = await tts.synthesize(text);
      return { ok: true, audio: result.audio, mime: result.mime, cached: result.cached };
    } catch (error) {
      logger.warn(`云端语音合成失败（将按设置决定是否退回系统语音）：${error.message}`);
      return { ok: false, message: error.message, code: error.code || '' };
    }
  });
  ipcMain.handle('tts:status', () => tts.status());
  ipcMain.handle('tts:clearCache', () => {
    tts.clearCache();
    return tts.status();
  });
  ipcMain.handle('copilot:history', () => copilot.recentHistory(20));

  // ---- 用量统计 / 安全机制 ----
  ipcMain.handle('usage:summary', () => usage.summary());
  ipcMain.handle('usage:reset', (_event, scope) => usage.reset(scope === 'today' ? 'today' : 'all'));
  ipcMain.handle('copilot:pause', (_event, reason) => copilot.pause(reason || '手动暂停'));
  ipcMain.handle('copilot:resume', () => copilot.resume('手动恢复'));
  // 「让她主动搭一句」（面板「直播控制台」的按钮 / 悬浮窗那边也一样）：
  // 走的是强制路径：不看开关、不抽签，但**暂停中 / 正在生成**时什么都不会发生（如实告诉界面为什么）。
  ipcMain.handle('copilot:warmup', async () => {
    try {
      if (copilot.paused) return { ok: false, message: '现在暂停着（先恢复回复）', reply: null };
      if (copilot.inFlight) return { ok: false, message: '正在回复上一条，等它说完再点', reply: null };
      const reply = await copilot.warmupNow();
      if (!reply) return { ok: false, message: '这次没搭上（模型可能说要跳过，或者按规矩现在不该开口）', reply: null };
      return { ok: true, reply };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('copilot:exportHistory', async () => {
    const text = copilot.exportHistory();
    if (!text.includes('弹幕/主播') && !text.includes('搭档')) {
      return { ok: false, message: '还没有对话可以导出' };
    }
    const target = path.join(app.getPath('userData'), `对话记录-${new Date().toISOString().slice(0, 10)}.md`);
    try {
      fs.writeFileSync(target, text, 'utf8');
      shell.showItemInFolder(target);
      return { ok: true, file: target };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('copilot:status', () => copilot.status());

  // ---- 悬浮窗测试 ----
  ipcMain.handle('overlay:testMessage', (_event, payload) => {
    const message = typeof payload === 'string' ? { text: payload } : payload || {};
    const reply = {
      id: `test-${Date.now()}`,
      ts: Date.now(),
      text: message.text || '这是一条测试回复，用来检查悬浮窗显示效果。',
      emotion: message.emotion || 'happy',
      source: 'test',
      latencyMs: 0
    };
    // 点了「发送测试回复」说明用户就是想看悬浮窗，这时允许把它打开
    overlayWanted = true;
    sendToOverlay('ai:reply', reply);
    return reply;
  });

  // ---- 吉祥物图片 ----
  ipcMain.handle('mascot:pickImages', async () => {
    const result = await dialog.showOpenDialog(panelWindow || undefined, {
      title: '选择吉祥物图片（可多选，建议 PNG 透明底）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'apng', 'bmp'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: true, added: [] };
    const added = [];
    const skipped = [];
    for (const filePath of result.filePaths) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 4 * 1024 * 1024) {
          skipped.push(`${path.basename(filePath)}（超过 4MB）`);
          continue;
        }
        const buffer = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = ext === 'jpg' ? 'jpeg' : ext === 'apng' ? 'png' : ext;
        added.push({
          name: path.basename(filePath, path.extname(filePath)),
          ext,
          size: stat.size,
          dataUrl: `data:image/${mime};base64,${buffer.toString('base64')}`
        });
      } catch (error) {
        skipped.push(`${path.basename(filePath)}（${error.message}）`);
      }
    }
    return { ok: true, added, skipped };
  });

  // ---- 日志 ----
  ipcMain.handle('log:get', () => logger.history());
  // 界面自己报上来的错误（脚本异常 / 未处理的 Promise 拒绝）
  ipcMain.handle('debug:report', (_event, payload) => {
    const item = payload || {};
    const text = `${item.label || '界面'} ${item.kind || '错误'}: ${item.message || ''}${
      item.source ? `\n    at ${item.source}:${item.line || 0}:${item.column || 0}` : ''
    }${item.stack ? `\n${item.stack}` : ''}`;
    appendRendererError(text);
    logger.error(`[界面自报] ${item.message || ''}`);
    return true;
  });
  ipcMain.handle('log:clear', () => {
    logger.buffer = [];
    send(panelWindow, 'log:history', []);
    return true;
  });
  ipcMain.handle('log:openFile', async () => {
    if (!fs.existsSync(logger.file)) return '';
    shell.showItemInFolder(logger.file);
    return logger.file;
  });
  // 打开弹幕记录：优先定位到文件本身，还没生成就打开所在目录
  ipcMain.handle('danmakuLog:open', async () => {
    const file = danmakuRecorder.filePath;
    if (fs.existsSync(file)) {
      shell.showItemInFolder(file);
      return file;
    }
    try {
      fs.mkdirSync(danmakuRecorder.dirPath, { recursive: true });
    } catch (_) {
      /* ignore */
    }
    await shell.openPath(danmakuRecorder.dirPath);
    return danmakuRecorder.dirPath;
  });
  ipcMain.handle('danmakuLog:status', () => danmakuRecorder.status());
  // 换一个存放位置：让用户自己挑父目录，程序在下面建固定子目录，避免散落
  ipcMain.handle('danmakuLog:chooseDir', async () => {
    const current = store.get().danmakuLog.dir || danmakuRecorder.dir;
    const result = await dialog.showOpenDialog(panelWindow || undefined, {
      title: '选择弹幕记录的存放位置',
      defaultPath: current || undefined,
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '用这个文件夹'
    });
    if (result.canceled || !result.filePaths || !result.filePaths[0]) {
      return { changed: false, status: danmakuRecorder.status() };
    }
    const picked = path.join(result.filePaths[0], '直播AI搭档');
    const next = store.patch({ danmakuLog: { dir: picked } });
    danmakuRecorder.configure(next.danmakuLog);
    bootLog(`弹幕记录位置已改为 ${danmakuRecorder.filePath}`);
    send(panelWindow, 'settings:changed', next);
    send(overlayWindow, 'settings:changed', next);
    return { changed: true, dir: danmakuRecorder.dirPath, status: danmakuRecorder.status() };
  });

  // ---- 知识库 ----
  // 界面拿到的永远是「条目 + 统计」，检索也走主进程：
  // 知识库是文件，只有主进程碰它，界面不直接读盘。
  ipcMain.handle('knowledge:list', () => ({
    stats: knowledge.stats(),
    items: knowledge.list(),
    pending: knowledge.listPending()
  }));
  ipcMain.handle('knowledge:add', (_event, payload) => {
    const entry = knowledge.add(payload || {});
    return { ok: true, entry, stats: knowledge.stats() };
  });
  ipcMain.handle('knowledge:update', (_event, id, patch) => {
    const entry = knowledge.update(id, patch || {});
    return { ok: true, entry, stats: knowledge.stats() };
  });
  ipcMain.handle('knowledge:remove', (_event, id) => ({ ok: knowledge.remove(id), stats: knowledge.stats() }));
  // 检索预览：界面上输入一句话，看看实际会命中/注入什么（调库最有效的工具）
  ipcMain.handle('knowledge:search', (_event, text, options) => {
    const limit = Math.min(20, Math.max(1, Number((options || {}).limit) || 5));
    const hits = knowledge.search(String(text || ''), { limit });
    return {
      hits: hits.map((hit) => ({
        id: hit.entry.id,
        title: hit.entry.title,
        tags: hit.entry.tags,
        score: Math.round(hit.score * 1000) / 1000,
        strong: hit.strong,
        matchedTokens: hit.matchedTokens
      })),
      preview: knowledge.context(String(text || ''), { maxEntries: limit, maxChars: 600 }).text
    };
  });
  ipcMain.handle('knowledge:openFolder', async () => {
    try {
      knowledge.ensureLayout();
    } catch (_) {
      /* 建不出来就算了，下面 openPath 会报 */
    }
    // 打开的是知识库**根目录**（notes / pending / inbox 都在里面）：
    // 它同时是 DSH 的工作区，用户要能看到「它被关在哪儿」的全貌
    await shell.openPath(knowledge.dir);
    return knowledge.dir;
  });

  // ---- 观众记忆（本场文档 + 老观众名册）----
  ipcMain.handle('memory:state', () => memoryStatus());
  ipcMain.handle('memory:flush', () => runMemoryFlush('manual'));
  ipcMain.handle('memory:openFolder', async () => {
    viewerMemory.ensureLayout();
    await shell.openPath(viewerMemory.dirPath);
    return viewerMemory.dirPath;
  });
  // 用系统默认程序打开：本场文档 / 老观众名册（主播放记事本里就能改）
  ipcMain.handle('memory:openFile', async (_event, kind) => {
    const target =
      kind === 'roster'
        ? path.join(viewerMemory.dirPath, viewerMemoryShared.ROSTER_FILE)
        : viewerMemory.sessionFile;
    if (!target) return { ok: false, message: '现在没有本场记录（先打开「本场记录」）' };
    try {
      if (!fs.existsSync(target)) {
        viewerMemory.ensureLayout();
        if (kind === 'roster') viewerMemory.flushRoster(true);
        else viewerMemory.writeSession();
      }
      const error = await shell.openPath(target);
      if (error) return { ok: false, message: error };
      return { ok: true, file: target };
    } catch (error) {
      return { ok: false, message: error.message };
    }
  });
  ipcMain.handle('memory:clearSession', () => {
    const old = viewerMemory.clearSession();
    memoryRuntime.buffer = [];
    memoryRuntime.nextTryAt = 0;
    clearTimeout(memoryRuntime.flushTimer);
    memoryRuntime.flushTimer = null;
    bootLog(`观众记忆：清空本场（${old || '还没有记录'}）`);
    broadcastMemory();
    return { ok: true, state: memoryStatus() };
  });
  ipcMain.handle('memory:clearRoster', () => {
    const file = viewerMemory.clearRoster();
    bootLog(`观众记忆：清空老观众名册（${file}）`);
    broadcastMemory();
    return { ok: true, state: memoryStatus() };
  });
  // 待审草稿：通过 = 写进知识库 + 删掉草稿；丢弃 = 只删草稿
  ipcMain.handle('knowledge:approve', (_event, id, patch) => {
    const entry = knowledge.approvePending(id, patch || {});
    return { ok: true, entry, stats: knowledge.stats() };
  });
  ipcMain.handle('knowledge:reject', (_event, id) => ({
    ok: knowledge.rejectPending(id),
    stats: knowledge.stats()
  }));
  // 「清空待审」：一次丢掉所有草稿（待审攒到十几条时逐条点太烦）。
  // ⚠️ 只删草稿，**知识库一个字不动**；界面上必须先确认再调这里。
  ipcMain.handle('knowledge:clearPending', () => {
    const result = knowledge.clearPending();
    bootLog(
      `清空待审草稿：丢掉 ${result.removed} 条` +
        (result.failed.length ? `，${result.failed.length} 条没删掉（${result.failed.slice(0, 2).join('、')}）` : '')
    );
    return { ok: result.failed.length === 0, ...result, stats: knowledge.stats(), pending: knowledge.listPending() };
  });

  // ---- 「模型想查 / 想记」的待办 ----
  // 模型只在队列里**提议**；花钱（联网查）和写库（存草稿）都由主播点头。
  // 点头有两个入口，走的是**同一段代码**（`runResearchItem` / `noteResearchItem`）：
  //   ① 面板卡片上点「去查」/「存成草稿」；
  //   ② 在对话里回她一句「查」/「记」（她在待办进来时会主动问一句）。
  ipcMain.handle('research:list', () => ({ items: researchQueue.list(), pending: researchQueue.count() }));
  ipcMain.handle('research:ignore', (_event, id) => {
    const item = researchQueue.update(id, { status: 'ignored' });
    copilot.clearResearchAsk(id);
    return { ok: Boolean(item), items: researchQueue.list() };
  });
  ipcMain.handle('research:remove', (_event, id) => {
    copilot.clearResearchAsk(id);
    return { ok: researchQueue.remove(id), items: researchQueue.list() };
  });
  ipcMain.handle('research:clearFinished', () => ({
    removed: researchQueue.clearFinished(),
    items: researchQueue.list()
  }));
  ipcMain.handle('research:note', (_event, id, patch) => runResearchItem(id, { via: 'panel', patch }));
  ipcMain.handle('research:run', async (_event, id) => runResearchItem(id, { via: 'panel' }));
  // ---- 「知识库改动记录」：她改的 / 你改的 / 删除的都在这里，每条都能撤销 ----
  ipcMain.handle('knowledge:edits', () => ({
    edits: knowledge.listEdits({ limit: 30 }),
    stats: knowledge.stats(),
    selfEdit: store.get().knowledge.selfEdit,
    selfEditPerHour: store.get().knowledge.selfEditPerHour
  }));
  ipcMain.handle('knowledge:undoEdit', (_event, editId) => {
    const result = knowledge.undoEdit(editId);
    bootLog(result.ok ? `撤销了一次知识库改动：${editId}` : `撤销失败：${result.reason}`);
    if (result.ok) send(panelWindow, 'knowledge:changed', { reason: 'undo', noteId: result.noteId });
    return { ...result, edits: knowledge.listEdits({ limit: 30 }), stats: knowledge.stats() };
  });

  // ---- 从文件导入资料 → 模型整理成知识（2026-10-19 加）----
  //
  // 两段：
  //   ① `knowledge:pickImportFiles`：弹系统选文件框、**把内容读进来并做体检**（编码/是否文本/大小），
  //      结果缓存在内存里（`pickedImports`），界面上先看到「几个文件、多少字」再决定要不要花这笔钱；
  //   ② `knowledge:importFiles`：把缓存的资料切成片、逐片让模型整理成 `===知识条目===`，
  //      解析成**待审草稿**（不直接写库 —— 和「模型整理出来的东西一律先进待审」是同一条规矩）。
  ipcMain.handle('knowledge:pickImportFiles', async () => {
    const result = await dialog.showOpenDialog(panelWindow || undefined, {
      title: '选择要导入知识库的资料（可多选，纯文本）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '文本资料', extensions: TEXT_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    pickedImports.clear();
    if (result.canceled || !result.filePaths.length) return { ok: true, files: [], skipped: [] };
    const files = [];
    const skipped = [];
    for (const filePath of result.filePaths) {
      const name = path.basename(filePath);
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > MAX_FILE_BYTES) {
          skipped.push(`${name}（超过 ${Math.round(MAX_FILE_BYTES / 1024)}KB）`);
          continue;
        }
        const prepared = prepareImport({ path: filePath, name, buffer: fs.readFileSync(filePath) });
        if (!prepared.ok) {
          skipped.push(`${name}（${prepared.reason}）`);
          continue;
        }
        // 只把**刚选过的**文件留在这里：`knowledge:importFiles` 只认这份缓存，
        // 界面没法随便传个路径来读你电脑上的别的文件
        pickedImports.set(filePath, { name, text: prepared.text, chars: prepared.chars, encoding: prepared.encoding, path: filePath });
        files.push({ name, chars: prepared.chars, encoding: prepared.encoding, path: filePath });
      } catch (error) {
        skipped.push(`${name}（${error.message}）`);
      }
    }
    if (files.length) bootLog(`选了 ${files.length} 个文件要导入知识库：${files.map((file) => `${file.name}(${file.chars}字)`).join('、')}`);
    for (const item of skipped) bootLog(`导入跳过：${item}`);
    return { ok: true, files, skipped };
  });

  ipcMain.handle('knowledge:importFiles', async () => {
    if (importState.running) return { ok: false, message: '上一批文件还在整理，等它跑完' };
    const files = [...pickedImports.values()];
    if (!files.length) return { ok: false, message: '没有选中的文件（先点「选择文件」）' };
    const plan = planImportJobs(files);
    if (!plan.jobs.length) return { ok: false, message: '这些文件里没有能整理的内容' };

    importState.running = true;
    const started = Date.now();
    bootLog(`开始从文件导入知识：${plan.jobs.length} 段 / 共 ${plan.chars} 字`);
    const drafts = [];
    const problems = [];
    try {
      for (const job of plan.jobs) {
        // 一片一次调用：某一片失败只影响这一片，不连坐
        let raw = '';
        try {
          const result = await editLlm.chat(
            [
              { role: 'system', content: IMPORT_SYSTEM_PROMPT },
              { role: 'user', content: buildImportPrompt({ name: job.name, chunk: job.chunk, index: job.index, total: job.total }) }
            ],
            { maxTokens: 1600, temperature: 0.3 }
          );
          raw = String((result && result.content) || '');
        } catch (error) {
          problems.push(`${job.name} 第 ${job.index}/${job.total} 段：${error.message}`);
          bootLog(`导入失败（${job.name} 第 ${job.index} 段）：${error.message}`);
          continue;
        }
        const parsed = parseDrafts(raw, { source: `导入文件 · ${job.name}`, engine: '文件导入' });
        if (!parsed.length) {
          problems.push(`${job.name} 第 ${job.index}/${job.total} 段：没解析出条目`);
          continue;
        }
        for (const draft of parsed) {
          try {
            drafts.push(knowledge.addPending(draft));
          } catch (error) {
            problems.push(`${job.name}：草稿存不下来（${error.message}）`);
          }
        }
      }
    } finally {
      importState.running = false;
      pickedImports.clear();
    }

    const ms = Date.now() - started;
    bootLog(
      `文件导入完成：${drafts.length} 条草稿进待审，用时 ${Math.round(ms / 1000)} 秒` +
        `${plan.droppedChars ? `，另有 ${plan.droppedChars} 字超出单次上限没处理` : ''}` +
        `${problems.length ? `，${problems.length} 段有问题` : ''}`
    );
    if (drafts.length) {
      send(panelWindow, 'knowledge:changed', { reason: 'import', count: drafts.length });
      announceDrafts(drafts, { source: 'import' });
    }
    return {
      ok: drafts.length > 0,
      drafts,
      count: drafts.length,
      chars: plan.chars,
      droppedChars: plan.droppedChars,
      droppedFiles: plan.droppedFiles,
      chunks: plan.jobs.length,
      ms,
      problems,
      message: drafts.length
        ? ''
        : problems.length
          ? `整理没成功：${problems.slice(0, 2).join('；')}`
          : '模型没给出能用的条目（可以去日志里看原始输出）'
    };
  });

  // ================================================================
  // 知识库「整理 / 校对 / 更新」（2026-10-19 加）
  //
  // 主播要的是：让模型用**最高思考档 + 联网**去检查已有知识，指出错的、过时的、
  // 重复的，给出改法；再让他点「应用」。另外每条知识可以**锁成只读**，模型连碰都不许碰。
  //
  // 三道硬规矩（写在这里，改代码前先读）：
  //   ① **模型只出建议**：产出写进 `知识库\.review.json`，主播点「应用」才动 notes/；
  //      最高权限（`agent.maxPermissions`）开着时她自动应用，但同样留记录、可撤销、受次数上限约束；
  //   ② **锁是硬闸门**：锁定条目不进提示词、不许被建议、应用时再校验一次，锁了就整条跳过；
  //   ③ **应用前比快照**：建议生成之后条目被改过（或锁了）就不许应用——宁可让主播重跑，
  //      也不能拿旧内容盖掉他刚手改的东西。
  // ================================================================
  const reviewState = {
    /** '' | 'audit' | 'verify'：同一时间只跑一件事（不然两个循环抢着写 .review.json） */
    running: '',
    /** 主播点了取消：循环在下一条之前退出（正在飞的那次请求也会被 abort） */
    cancel: false,
    /** 正在跑哪条（界面显示进度用） */
    progress: null,
    controller: null
  };

  /** 建议文件放知识库根下（点号开头，不会被当成条目扫进来；主播自己也能看/删） */
  function reviewFilePath() {
    return knowledge.dir ? path.join(knowledge.dir, '.review.json') : '';
  }

  function readReview() {
    const empty = { items: [], runs: [] };
    const file = reviewFilePath();
    if (!file) return empty;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const items = Array.isArray(raw && raw.items) ? raw.items : [];
      return {
        items: items
          .filter((item) => item && item.id && Array.isArray(item.noteIds) && item.noteIds.length)
          .map((item) => ({
            ...item,
            before: item.before || null,
            after: item.after || null,
            sources: Array.isArray(item.sources) ? item.sources : []
          }))
          .slice(0, MAX_REVIEW_ITEMS),
        runs: Array.isArray(raw && raw.runs) ? raw.runs.slice(-10) : []
      };
    } catch (_) {
      // 文件坏了就当没有建议（下次运行会重写）：绝不因为一个坏 json 让整页打不开
      return empty;
    }
  }

  function writeReview(data) {
    const file = reviewFilePath();
    if (!file) throw new Error('知识库目录没设置');
    const payload = {
      updatedAt: new Date().toISOString(),
      items: (Array.isArray(data.items) ? data.items : []).slice(0, MAX_REVIEW_ITEMS),
      runs: (Array.isArray(data.runs) ? data.runs : []).slice(-10)
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    return payload;
  }

  /** 把一条模型建议变成可应用的条目（带 before 快照 + 合并时要删的 id） */
  function buildReviewItem({ kind, noteIds, title, tags, content, reason, mode, sources = [], notesById }) {
    const targetId = String(noteIds[0] || '');
    const target = notesById.get(targetId);
    if (!target) return null;
    const cleanTags = String(tags || '')
      .split(/[,，、\s]+/)
      .filter(Boolean);
    const before = {
      title: String(target.title || ''),
      content: String(target.content || ''),
      tags: Array.isArray(target.tags) ? target.tags.slice() : []
    };
    const after = {
      title: String(title || '').trim() || before.title,
      content: kind === 'delete' ? '' : String(content || '').trim() || before.content,
      tags: cleanTags.length ? cleanTags : before.tags.slice()
    };
    const dropIds = kind === 'merge' ? noteIds.slice(1).filter((id) => notesById.has(String(id))) : [];
    // 删除 / 合并要真能删（锁着的不能被删）——在应用时还会再查一次，这里先挡掉明显的
    if (dropIds.some((id) => (notesById.get(String(id)) || {}).locked)) return null;
    if (before.title === after.title && before.content === after.content) return null; // 模型说了个"没变化"
    return {
      id: `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      kind,
      noteIds: noteIds.map(String),
      dropIds,
      // 界面要能说清"会删掉哪几条"，只给 id 主播看不懂
      dropTitles: dropIds.map((id) => String((notesById.get(String(id)) || {}).title || '')).filter(Boolean).slice(0, 5),
      before,
      after,
      reason: String(reason || '').slice(0, 500),
      sources: (Array.isArray(sources) ? sources : []).slice(0, 5).map((item) => ({
        title: String((item && item.title) || '').slice(0, 120),
        url: String((item && item.url) || '')
      })),
      mode,
      createdAt: new Date().toISOString()
    };
  }

  /** 建议的"身份"：同一种改法 + 同一组条目 = 同一条建议（模型换个顺序说同一件事不要存两遍） */
  function reviewSignature(item) {
    const ids = (Array.isArray(item && item.noteIds) ? item.noteIds : []).map(String).sort().join(',');
    return `${(item && item.kind) || ''}|${ids}`;
  }

  /** 存建议 + 广播。同类型同主条目的后到覆盖先到；同一组条目的重复建议直接丢掉 */
  function saveReviewItems(items, run) {
    // 没有建议也要落下这次运行（`runs`）：界面要靠它显示"上次整理：几点，看了几条，没发现问题"
    if (!items.length && !run) return readReview();
    const current = readReview();
    const merged = [...current.items];
    for (const item of items) {
      const signature = reviewSignature(item);
      const index = merged.findIndex(
        (old) =>
          reviewSignature(old) === signature || String(old.noteIds[0]) === String(item.noteIds[0])
      );
      if (index >= 0) merged[index] = item;
      else merged.push(item);
    }
    const saved = writeReview({
      items: merged.slice(-MAX_REVIEW_ITEMS),
      runs: run ? [...current.runs, run] : current.runs
    });
    send(panelWindow, 'knowledge:review', saved);
    return saved;
  }

  /** 知识库「整理/校对」的当前状态（界面初始化 / 跑完都读它） */
  function reviewSnapshot() {
    const stats = knowledge.stats();
    const data = readReview();
    return {
      items: data.items.map((item) => ({ ...item, change: describeChange(item) })),
      runs: data.runs,
      limit: Number(store.get().knowledge.reviewLimit) || DEFAULT_VERIFY_LIMIT,
      running: reviewState.running,
      progress: reviewState.progress,
      stats: { count: stats.count, locked: stats.locked, enabled: stats.enabled },
      maxMode: Boolean(store.get().agent && store.get().agent.maxPermissions)
    };
  }

  function announceReview() {
    send(panelWindow, 'knowledge:review', reviewSnapshot());
  }

  /**
   * 应用一条建议。
   * @returns {{ok:boolean, message?:string, noteId?:string, title?:string, auto?:boolean}}
   */
  function applyReviewItem(itemId, { auto = false } = {}) {
    const data = readReview();
    const item = data.items.find((one) => one.id === String(itemId));
    if (!item) return { ok: false, message: '这条建议已经不在了（可能刚被应用或忽略过）' };
    const target = knowledge.get(item.noteIds[0]);
    if (!target) return { ok: false, message: '原条目已经不在了，这条建议作废' };
    // ② 锁是硬闸门：生成建议之后主播又把它锁了，也照样不许应用
    const involved = [item.noteIds[0], ...(item.dropIds || [])];
    for (const id of involved) {
      if (knowledge.isLocked(id)) {
        return { ok: false, message: `「${(knowledge.get(id) || {}).title || id}」被锁成只读了，模型不能动它` };
      }
    }
    // ③ 应用前比快照：条目在这期间被改过就不许应用
    if (item.before && noteChangedSince(item.before, target)) {
      return { ok: false, message: '这条知识在你生成建议之后被改过了，为了不盖掉手改，这条不应用（重新校对一次就好）' };
    }
    const title = String(item.after && item.after.title ? item.after.title : target.title);
    try {
      if (item.kind === 'delete') {
        const ok = knowledge.remove(target.id);
        if (!ok) return { ok: false, message: '删除失败（看日志）' };
      } else {
        knowledge.update(
          target.id,
          {
            title: item.after.title,
            content: item.after.content,
            tags: item.after.tags
          },
          {
            record: true,
            kind: 'review',
            reason: item.reason || '按整理/校对的建议改的',
            source: '整理校对'
          }
        );
      }
      for (const id of item.dropIds || []) {
        if (id === target.id) continue;
        knowledge.remove(id);
      }
    } catch (error) {
      return { ok: false, message: `应用失败：${error.message}` };
    }
    const rest = data.items.filter((one) => one.id !== item.id);
    writeReview({ items: rest, runs: data.runs });
    bootLog(
      `知识库整理/校对：${auto ? '（最高权限）自动' : ''}应用了一条建议「${title}」（${item.kind}，改动已备份）`
    );
    send(panelWindow, 'knowledge:changed', { reason: 'review', noteId: target.id });
    announceReview();
    return { ok: true, noteId: target.id, title, kind: item.kind, followed: Number(item.noteIds.length) };
  }

  /** 最高权限：她跑完直接应用（留记录、可撤销、受 selfEditPerHour 约束） */
  function autoApplyReview(items) {
    if (!(store.get().agent && store.get().agent.maxPermissions)) return 0;
    const cap = Number(store.get().knowledge.selfEditPerHour) || 0;
    let used = reviewEditsLastHour();
    let applied = 0;
    for (const item of items) {
      if (cap > 0 && used >= cap) break;
      const result = applyReviewItem(item.id, { auto: true });
      if (result.ok) {
        applied += 1;
        used += 1;
      } else {
        bootLog(`自动应用建议失败（${item.id}）：${result.message}`);
      }
    }
    return applied;
  }

  /** 最近一小时「整理/校对」自动改了几条（和 `knowledge.selfEditPerHour` 共用一个上限） */
  function reviewEditsLastHour() {
    const since = Date.now() - 3600 * 1000;
    try {
      return knowledge
        .listEdits({ limit: 200 })
        .filter(
          (record) =>
            record &&
            record.source === '整理校对' &&
            Date.parse(record.savedAt || record.createdAt || 0) >= since
        ).length;
    } catch (_) {
      return 0;
    }
  }

  /** 跑「整理全库」：只看没锁的条目，一次调用，产出合并/改写/删除建议 */
  async function runKnowledgeAudit() {
    if (reviewState.running) return { ok: false, message: '上一次整理/校对还没跑完' };
    const all = knowledge.list();
    const notes = all.filter((note) => !note.locked);
    if (!notes.length) return { ok: false, message: all.length ? '所有条目都被锁成只读了，没有可整理的' : '知识库是空的' };
    reviewState.running = 'audit';
    reviewState.cancel = false;
    reviewState.progress = { mode: 'audit', done: 0, total: 1, title: '正在让模型通读全库…' };
    announceReview();
    const started = Date.now();
    const notesById = new Map(all.map((note) => [String(note.id), note]));
    const prompt = buildAuditPrompt(notes, { today: new Date().toISOString().slice(0, 10) });
    const controller = new AbortController();
    reviewState.controller = controller;
    let raw = '';
    let failure = '';
    let usage = null;
    try {
      const result = await editLlm.chat(
        [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user }
        ],
        // 最高思考档：整理要判断"两条是不是同一件事"，低档位实测会把不同东西合并。
        // ⚠️ **绝不能给 max_tokens 设上限**（2026-10-21 真踩过）：思考内容也算这个额度，
        //    设成 4000 时 20 条知识那次的思考把额度吃光、正文是空的，界面就报「整理失败」。
        //    `maxTokens: 0` = 不限制 = 请求里干脆不发这个字段（llm.js 里就是这么处理的）。
        // 超时也要单独放宽：`max` 档思考 + 20 条知识实测要 60 秒以上，主播配的 45 秒（普通回复用）
        // 会直接把整理掐断（2026-10-21 真踩过：`请求超时（超过 45 秒）`）。这里给 4 分钟，随时能点「取消」。
        { thinking: REVIEW_THINKING, maxTokens: 0, temperature: 0.3, timeoutMs: 240000, signal: controller.signal }
      );
      raw = String(result.content || '');
      usage = result.usage || null;
      if (!raw) {
        // 说清是哪一种"空"：思考吃满（finish=length / 有 reasoning 没正文）还是模型真的没说话
        const reason = result.reasoning ? `思考用了 ${String(result.reasoning).length} 字` : '没有思考内容';
        failure = `模型没给正文（${reason}，finish=${result.finishReason || '未知'}）——再点一次通常就好，连续失败就把思考档降一档`;
      }
      if (usage) {
        bootLog(`整理调用用量：输入 ${Number(usage.prompt_tokens || 0)} / 输出 ${Number(usage.completion_tokens || 0)} token`);
      }
    } catch (error) {
      // 只留原因本身：日志前缀已经是「知识库整理失败：」，界面那边是「整理没成：」
      failure = error.message;
    } finally {
      reviewState.running = '';
      reviewState.controller = null;
      reviewState.progress = null;
    }
    if (failure) {
      bootLog(`知识库整理失败：${failure}`);
      announceReview();
      return { ok: false, message: failure };
    }
    const suggestions = parseReviewItems(raw, { knownIds: [...notesById.keys()] });
    const items = [];
    const seen = new Set();
    for (const suggestion of suggestions) {
      const item = buildReviewItem({ ...suggestion, mode: 'audit', notesById });
      if (!item) continue;
      const signature = reviewSignature(item);
      if (seen.has(signature)) continue;
      seen.add(signature);
      items.push(item);
    }
    const ms = Date.now() - started;
    const run = {
      id: `run-${Date.now().toString(36)}`,
      mode: 'audit',
      startedAt: new Date(started).toISOString(),
      ms,
      notes: notes.length,
      found: items.length,
      locked: all.length - notes.length
    };
    const saved = saveReviewItems(items, run);
    const autoApplied = autoApplyReview(items);
    bootLog(
      `知识库整理完成：看了 ${notes.length} 条（跳过锁定 ${run.locked} 条），` +
        `给出 ${items.length} 条建议${autoApplied ? `，最高权限自动应用 ${autoApplied} 条` : ''}（${Math.round(ms / 1000)} 秒）`
    );
    announceReview();
    return {
      ok: true,
      mode: 'audit',
      notes: notes.length,
      locked: run.locked,
      found: items.length,
      autoApplied,
      ms,
      items: saved.items.map((item) => ({ ...item, change: describeChange(item) }))
    };
  }

  /**
   * 跑「联网校对」：逐条查证 → 给出改法。
   * @param {{ids?:string[], limit?:number}} options
   */
  async function runKnowledgeVerify(options = {}) {
    if (reviewState.running) return { ok: false, message: '上一次整理/校对还没跑完' };
    const api = store.get().api || {};
    if (!String(api.apiKey || '').trim()) return { ok: false, message: '还没填 DeepSeek API Key（联网校对要用它）' };
    const all = knowledge.list();
    if (!all.length) return { ok: false, message: '知识库是空的' };
    const limit = Math.max(1, Number(options.limit) || Number(store.get().knowledge.reviewLimit) || DEFAULT_VERIFY_LIMIT);
    const plan = selectVerifyTargets({ notes: all, ids: options.ids, limit });
    if (!plan.targets.length) {
      return {
        ok: false,
        message: plan.skippedLocked.length ? '选中的条目都被锁成只读了' : '没有可校对的条目',
        skippedLocked: plan.skippedLocked.length
      };
    }
    reviewState.running = 'verify';
    reviewState.cancel = false;
    reviewState.progress = { mode: 'verify', done: 0, total: plan.targets.length, title: '' };
    announceReview();
    const started = Date.now();
    const notesById = new Map(all.map((note) => [String(note.id), note]));
    const baseUrl = String(api.baseUrl || '').trim();
    const controller = new AbortController();
    reviewState.controller = controller;
    const items = [];
    const seen = new Set();
    const problems = [];
    let unchanged = 0;
    let searched = 0;
    try {
      for (let index = 0; index < plan.targets.length; index += 1) {
        if (reviewState.cancel) break;
        const note = plan.targets[index];
        reviewState.progress = { mode: 'verify', done: index, total: plan.targets.length, title: note.title };
        announceReview();
        // ① 联网查这条知识的关键词（标题最准；正文太长，接口只吃 128 字）
        const searchedResult = await searchRaw({
          apiKey: api.apiKey,
          baseUrl,
          keyword: note.title,
          oriQuestion: note.title,
          count: 8,
          timeoutMs: 30000,
          logger
        });
        if (!searchedResult.ok) {
          problems.push(`${note.title}：搜索失败（${searchedResult.message || '未知原因'}）`);
          continue;
        }
        searched += 1;
        if (reviewState.cancel) break;
        // ② 让模型拿「笔记 + 资料」判有没有问题（最高思考档）
        const prompt = buildVerifyPrompt({
          note,
          results: searchedResult.results,
          today: new Date().toISOString().slice(0, 10)
        });
        let answer = '';
        try {
          const result = await editLlm.chat(
            [
              { role: 'system', content: prompt.system },
              { role: 'user', content: prompt.user }
            ],
            // 同上：不预设 max_tokens（思考也算额度，设了上限就会出现"思考吃满、正文空"）；
            // 单条校对的超时给 2 分钟（`max` 档 + 5 条资料，实测十几~几十秒）
            { thinking: REVIEW_THINKING, maxTokens: 0, temperature: 0.3, timeoutMs: 120000, signal: controller.signal }
          );
          answer = String(result.content || '');
          if (!answer) {
            problems.push(
              `${note.title}：模型没给正文（${result.reasoning ? `思考用了 ${String(result.reasoning).length} 字` : '没有思考内容'}，finish=${result.finishReason || '未知'}）`
            );
            continue;
          }
        } catch (error) {
          if (reviewState.cancel) break;
          problems.push(`${note.title}：让模型核对时失败（${error.message}）`);
          continue;
        }
        // 已知 id 给全库：模型可能建议"这条并进那条"（合并），只给当前 id 会把另一条 id 当成抄错丢掉
        const parsed = parseVerifyAnswer(answer, { noteId: note.id, knownIds: [...notesById.keys()] });
        if (parsed.verdict !== 'changed' || !parsed.item) {
          unchanged += 1;
          continue;
        }
        // 建议必须是针对"正在核对这条"的（模型跑题就丢掉）
        if (!parsed.item.noteIds.map(String).includes(String(note.id))) {
          problems.push(`${note.title}：模型的建议没提到这条知识，已忽略`);
          continue;
        }
        const item = buildReviewItem({
          ...parsed.item,
          mode: 'verify',
          sources: searchedResult.sources,
          notesById
        });
        if (!item) {
          problems.push(`${note.title}：模型建议的内容没法应用（格式没解析对）`);
          continue;
        }
        // 两条笔记各自被问到「要不要合并」时，模型会把同一件事说明两遍：按"条目组"去重
        const signature = reviewSignature(item);
        if (seen.has(signature)) continue;
        seen.add(signature);
        items.push(item);
      }
    } finally {
      const wasCancelled = reviewState.cancel;
      reviewState.running = '';
      reviewState.cancel = false;
      reviewState.controller = null;
      reviewState.progress = null;
      if (wasCancelled) bootLog('知识库联网校对被主播取消了');
    }
    const ms = Date.now() - started;
    const run = {
      id: `run-${Date.now().toString(36)}`,
      mode: 'verify',
      startedAt: new Date(started).toISOString(),
      ms,
      notes: plan.targets.length,
      searched,
      unchanged,
      found: items.length,
      problems: problems.slice(0, 5)
    };
    const saved = items.length || plan.targets.length ? saveReviewItems(items, run) : readReview();
    const autoApplied = autoApplyReview(items);
    bootLog(
      `知识库联网校对完成：查了 ${searched} 条（没变化 ${unchanged} 条，建议改 ${items.length} 条）` +
        `${autoApplied ? `，最高权限自动应用 ${autoApplied} 条` : ''}（${Math.round(ms / 1000)} 秒）` +
        `${plan.truncated ? `，还有 ${plan.truncated} 条这次没跑` : ''}`
    );
    announceReview();
    return {
      ok: true,
      mode: 'verify',
      checked: plan.targets.length,
      searched,
      unchanged,
      found: items.length,
      autoApplied,
      skippedLocked: plan.skippedLocked.length,
      truncated: plan.truncated,
      problems,
      ms,
      items: saved.items.map((item) => ({ ...item, change: describeChange(item) }))
    };
  }

  ipcMain.handle('knowledge:reviewState', () => reviewSnapshot());
  ipcMain.handle('knowledge:reviewAudit', () => runKnowledgeAudit().catch((error) => ({ ok: false, message: error.message })));
  ipcMain.handle('knowledge:reviewVerify', (_event, options) =>
    runKnowledgeVerify(options || {}).catch((error) => ({ ok: false, message: error.message }))
  );
  ipcMain.handle('knowledge:reviewApply', (_event, itemId) => {
    const result = applyReviewItem(itemId);
    return { ...result, state: reviewSnapshot() };
  });
  ipcMain.handle('knowledge:reviewApplyAll', () => {
    const data = readReview();
    const results = [];
    for (const item of data.items) {
      const result = applyReviewItem(item.id);
      results.push({ id: item.id, ok: result.ok, message: result.message || '', title: result.title || '' });
    }
    return {
      ok: results.some((result) => result.ok),
      applied: results.filter((result) => result.ok).length,
      results,
      state: reviewSnapshot()
    };
  });
  ipcMain.handle('knowledge:reviewDiscard', (_event, itemId) => {
    const data = readReview();
    writeReview({ items: data.items.filter((item) => item.id !== String(itemId)), runs: data.runs });
    announceReview();
    return { ok: true, state: reviewSnapshot() };
  });
  ipcMain.handle('knowledge:reviewClear', () => {
    const data = readReview();
    writeReview({ items: [], runs: data.runs });
    announceReview();
    return { ok: true, state: reviewSnapshot() };
  });
  ipcMain.handle('knowledge:reviewCancel', () => {
    if (!reviewState.running) return { ok: false, message: '现在没在跑' };
    reviewState.cancel = true;
    try {
      reviewState.controller?.abort();
    } catch (_) {
      /* 中止失败也无所谓：循环会在下一条之前退出 */
    }
    return { ok: true };
  });

  // ---- DSH（可选的研究引擎）----
  // ⚠️ **已下线（2026-10-19）**：界面上那张「让 DSH 整理」卡已经 `hidden`，所以这三个通道
  //    **没有任何界面入口**；保留它们是为了「只藏不删」——恢复时不用重写主进程这一层。
  //    唯一还在用的地方是 `test-electron-main.js` 的一条断言（它顺带验证「工作区 = 知识库目录」）。
  // 环境检测：逐项告诉用户缺什么、怎么补。跑任务之前主进程自己还会再检一遍，
  // 所以「界面按钮置灰」只是体验，真正的门在这里。
  ipcMain.handle('dsh:detect', async (_event, options) => {
    const status = await dsh.detect({ deep: Boolean(options && options.deep) });
    // 顺带把「用哪个会话、工作区在哪」告诉界面，省得再开一个通道。
    // workspace 必须是知识库目录：DSH 的沙箱就以它为根，界面要把它显示出来。
    return {
      ...status,
      workspace: knowledge.dir,
      workspaceNoticeSeen: Boolean(store.get().knowledge.dshWorkspaceNoticeSeen),
      session: {
        mode: store.get().knowledge.dshMode,
        name: store.get().knowledge.dshSessionName,
        // 会话 id 由 DSH 生成、存在配置里；空 = 还没建过（第一次跑会新建）
        id: store.get().knowledge.dshSessionId || '',
        // 实际在用的模型：跑过一次就是 DSH 回报的那个，否则是配置里想指定的
        model: dshSession.model || store.get().knowledge.dshModel || '',
        running: dshSession.running
      }
    };
  });
  ipcMain.handle('dsh:run', async (_event, payload) => {
    const task = String((payload && payload.task) || '').trim();
    if (!task) return { ok: false, message: '先写清楚要让 DSH 做什么' };
    // 工作区永远是知识库目录（两种跑法共用同一条规矩）：
    // 会话模式的 cwd 在 DshSessionRunner 里也是它，所以「它会动哪儿」只有一个答案。
    try {
      knowledge.ensureLayout();
    } catch (_) {
      /* 建不出来就让 DSH 用临时目录（runner 自己会兜底） */
    }
    const workspace = knowledge.dir;
    const mode = store.get().knowledge.dshMode === 'headless' ? 'headless' : 'session';
    bootLog(`交给 DSH 整理（${mode === 'session' ? '会话模式' : '一次性模式'}，工作区 ${workspace}）：${task.slice(0, 80)}`);
    // 任务文本后面会自动附上输出格式要求，这样返回的内容能被解析成知识条目
    const result =
      mode === 'session'
        ? await dshSession.prompt(buildTaskPrompt(task))
        : await dsh.runTask({ task: buildTaskPrompt(task), cwd: workspace });
    // 续用的会话也再登记一次：万一 DSH Web 那会儿在跑、把登记表覆盖回去了，这里补上
    if (mode === 'session') attachDshSession(dshSession.sessionId);
    let drafts = [];
    if (result.ok) {
      // 产出默认**只进待审**：DSH 说出来的东西先写成草稿，主播点通过才落库。
      // 最高权限打开时由 `autoApproveDrafts` 直接通过掉（每条留记录、能撤销、受次数上限约束）。
      for (const draft of parseDrafts(result.output)) {
        try {
          drafts.push(knowledge.addPending(draft));
        } catch (error) {
          bootLog(`草稿存不下来：${error.message}`);
        }
      }
      const autoApproved = autoApproveDrafts(drafts, { reason: 'DSH 整理出来的' });
      bootLog(
        `DSH 跑完：${drafts.length} 条草稿进待审（用时 ${Math.round(result.ms / 1000)} 秒` +
          `${result.sessionId ? `，会话 ${result.sessionId}` : ''}）` +
          `${autoApproved.approved.length ? `，其中 ${autoApproved.approved.length} 条她自己写进知识库了` : ''}`
      );
      if (autoApproved.approved.length) send(panelWindow, 'knowledge:changed', { reason: 'auto-approve' });
      // 整理完也让面板弹一条能直接「全部通过」的提示
      announceDrafts(autoApproved.kept, { source: 'dsh', autoApproved: autoApproved.approved.length });
    } else {
      bootLog(`DSH 跑完：失败（${result.message}），用时 ${Math.round(result.ms / 1000)} 秒`);
    }
    return { ...result, drafts, mode, workspace };
  });
  ipcMain.handle('dsh:cancel', async () => {
    const busy = dshSession.busy;
    dsh.cancel();
    // 会话模式现在有**真正的取消**（ACP 的 session/cancel 通知）：这一轮收尾，
    // 进程和会话都留着 —— 比原来「杀掉常驻进程」温和得多，也不用重新起（起一次要几十秒）。
    // 注意：如果它当时正在联网/读文件，那个工具调用仍会在会话里留一条「结果未知」的告警
    // （DSH 的自我保护，不是坏了）。
    const cancelled = dshSession.cancel();
    if (!cancelled) {
      // 没在跑就没得取消，顺手把常驻进程收掉（下次重新起）
      await dshSession.stop({ graceful: true });
    }
    return { ok: cancelled || true, busy, cancelled };
  });

  // ---- 窗口 ----
  ipcMain.handle('window:openPanel', () => {
    createPanelWindow();
    return true;
  });
  ipcMain.handle('window:quit', () => {
    quitApp();
    return true;
  });
  /**
   * 悬浮窗不再是「覆盖全屏 + 手动模拟拖动」，而是一个真正的小窗口：
   * 渲染层算好内容高度后，通过这里把窗口挪到指定位置并调整大小。
   */
  /**
   * 渲染层算好内容高度后，通过这里把窗口挪到指定位置并调整大小。
   *
   * ⚠️ **「自动布局」和「用户挪窗口」必须分开**（2026-10-19 修的一个真 bug）：
   * 主播把悬浮窗拖到屏幕外，来一条回复 → 渲染层重算内容高度 → 这里把坐标夹回屏幕内 →
   * 窗口「啪」地跳回屏里。根因就是这条通道把两件事混在一起了。
   *
   * 所以现在有两个参数：
   *   · `position: 'keep'`：**一个字节都不动位置**，只改宽高（自动布局走这个）；
   *     `'set'`：按 `x/y` 定位（首次定位、重置、用户拖动结束时走这个）。
   *   · `clamp: 'visible'`：只保证时**至少留 MIN_VISIBLE 像素**在屏幕内（允许大半在屏幕外）；
   *     `'inside'`：完整夹进屏幕（首次定位/重置用，保证不会把窗口丢到看不见的地方）。
   *
   * 不传这两个字段时按老行为（'set' + 'inside'）——老界面/老测试不会因此坏掉。
   */
  ipcMain.handle('window:setBounds', (_event, bounds) => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !bounds) return false;
    const union = computeVirtualBounds();
    const width = Math.max(200, Math.min(1600, Math.round(Number(bounds.width) || 460)));
    const height = Math.max(140, Math.min(1800, Math.round(Number(bounds.height) || 620)));
    const keepPosition = bounds.position === 'keep';
    const visibleOnly = bounds.clamp === 'visible';
    const current = overlayWindow.getBounds();

    let x;
    let y;
    if (keepPosition) {
      // 自动布局：位置完全不动。窗口可能本来就有一半在屏幕外，那是主播自己摆的，不归我们管。
      x = current.x;
      y = current.y;
    } else {
      x = Math.round(Number(bounds.x) || 0);
      y = Math.round(Number(bounds.y) || 0);
      if (visibleOnly) {
        // 至少留一块能抓住的区域（48px），不整个丢到看不见的地方
        const minX = union.x - width + MIN_VISIBLE;
        const maxX = union.x + union.width - MIN_VISIBLE;
        const minY = union.y - height + MIN_VISIBLE;
        const maxY = union.y + union.height - MIN_VISIBLE;
        x = Math.min(Math.max(minX, x), Math.max(minX, maxX));
        y = Math.min(Math.max(minY, y), Math.max(minY, maxY));
      } else {
        // 完整夹进屏幕
        const maxX = union.x + union.width - width - 4;
        const maxY = union.y + union.height - height - 4;
        x = Math.min(Math.max(union.x + 4, x), Math.max(union.x + 4, maxX));
        y = Math.min(Math.max(union.y + 4, y), Math.max(union.y + 4, maxY));
      }
    }

    if (current.x !== x || current.y !== y || current.width !== width || current.height !== height) {
      overlayWindow.setBounds({ x, y, width, height });
    }
    return true;
  });
}

// ---------------------------------------------------------------- 启动

/**
 * 托盘图标：**直接内嵌 base64，不带图片文件**（分享版拷走一个目录就能跑）。
 *
 * ⚠️ 2026-10-19 的坑（主播报的）：托盘里**没有图标**，右键却能出菜单。
 *    根因是原来那张 16×16 PNG 解出来 **256 个像素 alpha 全是 0**（还带坏掉的 zlib 校验）——
 *    一张全透明的图，Windows 画得出来，只是什么都看不见。菜单来自 `setContextMenu`，跟图标无关，
 *    所以「没图标但有菜单」这个组合非常迷惑人。
 *
 * 现在的做法：16×16 给 100% 缩放、32×32 给高 DPI（Windows 按缩放比自己挑，不会糊成一片），
 * 画的是品牌色圆盘（`--brand #5b83ff` → `--brand-2 #3f63d8`）+ 白色小鱼。
 *
 * **别手写 base64**：改图标跑 `node scripts\make-tray-icon.js`（会把形状打成 ASCII 给你肉眼验收，
 * 再打印 base64），加 `--write` 可以直接写回这里；`test.js` 还会解码校验它不是透明图。
 */
const TRAY_ICON_16 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABo0lEQVR42pWTzUoCYRSG5yZm5x10E/YjYkTYn5bMIsI0LEwiImyqUVrWImghrVpPFBQRFUVUFEVQ0M7MKCSryZqydEzFN86YgjA29sIDB773+VbnMIxGHMEC6wgWOEewIPxCM8vopVvIGXoCebEnkEcVROpoyvap7zr7dFayT2ehg0TdCrmLVwxdvCLZJhXUAnXJKX/Q4f8SOydSIAbn0ljazGLrNKdCs28+rb75QwpKPXJUuW38g20fT8LGJ7F7nkW1HF/lkHgvYHEtA+oT5DLWMZmzjsk4virKm3vX4AaX8VfWDjMgh1ymdfRV6JuRy49nFzF4+Q3oZecsg27+TWBaRiShN5DAf7N9qsDmfxGYZt8T1+x7wtGlUrO8uv8FcshlLN44a/E+oHUkjq2TVFXp8CKNFzmPBfEd1C8SL26neSgmmodiIHqFOEIrMtYPPlVo7p95VN+GZ59R6pFT3gOT595g8txJJs8dakQip2IbmwZu6xrdUanRHYUOEnU176HBdWOod0XE+v4INHFFROroXqXRGWaNzjBndIaFX2jWPOcfyxplbAKfUr4AAAAASUVORK5CYII=';
const TRAY_ICON_32 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADcUlEQVR42tWXSW9SURiG3XXHL2DrypVbEyPYuVU7D1CMmkJnaY1WSycorcPCITZho6iJcaEkmqqNRV1o2jgtrHFApbVoB0FtK5xymS7Da065DG2hAwWTfskTEu753ucjuZd7zrZtW6XE6gBPrA5IxOqAVqwOGKp6A4iGfsddo2t4SROLenx8UY9fI+rxE3GPH+uBrg32+PibkleqvNUilY+IVD4kCKEZGxZXKNm0SiWrq1R6kRxYHc1cl7y825NW0e3RV3R7kGT0NHvtAbrcuvIuN1KEblV5WaezuqzThdTijH1PlHY4+KUdDlLa4cBqNF1w4djlCPHWiZTOeNeoY+XTUdLOaEraGSznyGkHbj324JPJB9aLmGWc9OPecxaN5x3hvqHXLHpvuBArk7qWyIsVC7xihZ0UK+wIIVHZMfSKjSuNVy8/eCE7x+DFB+9i79mbLkTnchDqDA9Q1EYkRW0EIeQXGVjm/Ei0CBNY0n9lwIXofA5JeIDCUzZt4SkbKIfUBDYmsCTwzeg05J2DGNB/SXiou8/cCDk4tOEBCk5aDQUnraC8eM+uaN6ZqcH2XZcWmbc6Ex7i0Us3StuDHuoMD3Cg9S8oB1XWmI27C68uynfs6Yed8WAzNWpkUaII+iIDnJgDpe/6QsymyRkr+q+9wruPZiSjvv7wQqKMGmD/8VlQeq8R/I/68oNFVfd8ZIB9x/6AUtU1m3L5268eFLUGfeEB8lt+GfJbfoEy8s6VMvngiAOFJ36Dc0Vuwrxmizav2QKKqOM3bHZ/0uV3njIIOTgij2Gu3CzJlZsRovbMH5hnvQnL6A+I7tfobIjO54j8EeXIf/Jyjs6QnKMzCFHcasbDYQasN7Ah+fCoE5Iuy+In7VVdmUN0LgehziXvg+ymaU120zSWU972E9fv2/B+zB13mM8mD24/WcARlSXc92DYjnbNLGJlUteKt2FW4xQ/q3GKZDVOYTUOq8yQ9VnCxFuX3xw3gzpib1YzGyarMxsmkWJW36Rm1H/XZdR/R4rQrbknzKgzpaXXmfTpdSYkGT3NXtfOOL12Ii29dkK3t3YCyYBm0cwNnw/21nyrFtaME2HNOBKE0IxNnY6EsnG+UDamEcrGiFA2hnVCgj3j/KSdEQVSI08gNUoEUqNWIDUaBFIjlmHgrtE1vC1z6v4Hdv0VvV65u4IAAAAASUVORK5CYII=';

/**
 * 拼成 Tray 能用的 NativeImage。
 *
 * 两个细节：
 *   · `addRepresentation` 要判存在——`test-electron-main.js` 里那个假 `nativeImage` 只有
 *     `createFromDataURL`，不判会直接抛；
 *   · `isEmpty()` 必须喊一声：**空图标不会报错**，只会在任务栏上「隐形」（这次就是），
 *     留一条启动日志，下次别又靠肉眼发现。
 */
function buildTrayIcon() {
  const image = nativeImage.createFromDataURL(TRAY_ICON_16);
  if (typeof image.addRepresentation === 'function') {
    image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 });
  }
  if (typeof image.isEmpty === 'function' && image.isEmpty()) {
    bootLog('⚠️ 托盘图标解不出来（任务栏里会是「看不见的图标」）：检查 main.js 的 TRAY_ICON_16 是不是有效 PNG');
  }
  return image;
}

app.whenReady().then(() => {
  logger.configure({
    maxMemory: store.get().logging.maxMemory,
    writeFile: store.get().logging.writeFile
  });
  logger.info('直播 AI 搭档启动');
  bootLog('app ready，开始装配');
  wireEvents();
  wireViewerMemory();
  registerIpc();
  bootLog('事件与 IPC 已注册');
  // 记忆开关如果上次是开着的，现在就开一份新文件（每次启动算新的一场）；
  // 设置里「启动时自动记录」开着的话，这里也会替主播把它打开（默认就是开的）
  bootViewerMemory();

  if (IS_SMOKE) {
    runSmokeTest();
    return;
  }

  try {
    // 默认不自动显示悬浮窗，由用户点控制面板的按钮打开。
    // 注意：只有这里（或用户操作 / overlay:openDrawer）才会创建悬浮窗，
    // 后台的状态广播不会再顺手把它创建出来。
    if (store.get().overlay.autoShow) {
      overlayWanted = true;
      createOverlayWindow();
      bootLog('悬浮窗已创建（设置里开启了启动时显示）');
    } else {
      bootLog('未自动显示悬浮窗（可在控制面板点「显示悬浮窗」打开）');
    }
    createPanelWindow();
    bootLog('控制面板已创建');
    createTray();
    bootLog('托盘已创建');
  } catch (error) {
    bootLog(`创建窗口失败: ${error && error.message}`);
    reportEarlyCrash('创建窗口失败', error);
  }

  screen.on('display-metrics-changed', relayoutOverlay);
  screen.on('display-added', relayoutOverlay);
  screen.on('display-removed', relayoutOverlay);

  if (store.get().danmaku.autoStart && store.get().danmaku.roomId) {
    setTimeout(() => {
      copilot.startDanmaku().catch(() => {});
    }, 1500);
  }
});

function relayoutOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const union = computeVirtualBounds();
  // ⚠️ 这里以前是 `overlayWindow.setBounds(computeVirtualBounds())`——「悬浮窗铺满整个桌面」
  // 那套老做法留下的。现在悬浮窗是个**小窗口**，尺寸和位置都由渲染层算，把窗口改成整块虚拟屏
  // 只会瞬间变成全屏、再被渲染层按 `position:'keep'` 改回大小；而位置已经落到虚拟屏左上角，
  // 主播看到的就是「悬浮窗突然跳回一开始的位置」（换分辨率 / 拔显示器 / 改缩放比时会触发）。
  // 现在只在窗口**完全跑到屏幕外**时把它拉回来一点，其余一律不动。
  const current = overlayWindow.getBounds();
  const x = Math.min(
    Math.max(current.x, union.x - current.width + MIN_VISIBLE),
    Math.max(union.x - current.width + MIN_VISIBLE, union.x + union.width - MIN_VISIBLE)
  );
  const y = Math.min(
    Math.max(current.y, union.y - current.height + MIN_VISIBLE),
    Math.max(union.y - current.height + MIN_VISIBLE, union.y + union.height - MIN_VISIBLE)
  );
  if (x !== current.x || y !== current.y) {
    overlayWindow.setBounds({ ...current, x, y });
  }
  // 让渲染层重排一次内容（它自己会按新尺寸调 window:setBounds，用 'keep' 不动位置）
  send(overlayWindow, 'overlay:relayout', union);
}

/**
 * 启动自检：把关键环节都试一遍，输出结果到控制台/日志/crash.log。
 *
 * 每个检查分两档：
 *   · **必须修**（fatal）：真出问题软件就用不了（配置写不进去、日志写不进去、界面文件缺、ws 没装…）
 *     → 判定为「自检失败」，退出码 1，`启动.bat` 会让主播看日志；
 *   · **只是提醒**（fatal:false）：跟这台机器的环境有关，不影响用。
 *     典型就是「读不到屏幕尺寸」——远程桌面、没接显示器、显卡驱动异常时会这样，
 *     界面照样能开、弹幕照收，不该因此把人吓一跳（真踩过：另一台设备上自检报失败，但能正常启动）。
 */
function runSmokeTest() {
  const report = [];
  let failed = 0;
  let warned = 0;
  /**
   * @param {string} name 检查项名字（`启动.bat`/`诊断.bat` 会把 [FAIL] 那几行直接打出来）
   * @param {Function} fn 具体检查，抛异常即失败
   * @param {{fatal?:boolean, hint?:string}} options `hint` 是「怎么修」，失败时跟在后面
   */
  const check = (name, fn, { fatal = true, hint = '' } = {}) => {
    try {
      const detail = fn();
      report.push(`  [OK]   ${name}${detail ? ` — ${detail}` : ''}`);
    } catch (error) {
      const suffix = hint ? `｜怎么修：${hint}` : '';
      if (fatal) {
        failed += 1;
        report.push(`  [FAIL] ${name} — ${error.message}${suffix}`);
      } else {
        warned += 1;
        report.push(`  [WARN] ${name} — ${error.message}（不影响使用）${suffix}`);
      }
    }
  };

  check(
    '读取配置',
    () => {
      const settings = store.get();
      return `配置文件 ${store.file}，房间号「${settings.danmaku.roomId || '未填'}」，API Key ${settings.api.apiKey ? '已填' : '未填'}`;
    },
    { hint: 'data\\settings.json 读不出来；改名成 settings.json.bak 再启动一次会重建默认配置' }
  );
  check(
    '配置可写',
    () => {
      store.patch({});
      return store.file;
    },
    {
      hint: '软件是不是已经开着了（关掉再试）？或文件夹是只读 / 装在 Program Files / 被杀毒软件锁住——把整个软件目录挪到「桌面」这类可写的位置'
    }
  );
  check(
    '日志可写',
    () => {
      logger.info('[自检] 日志写入测试');
      return logger.file;
    },
    { hint: '同上：data 目录必须可写（别装在 Program Files 或受保护的盘）' }
  );
  check(
    '弹幕客户端可实例化',
    () => {
      const { BilibiliDanmakuClient } = require('./danmaku');
      const client = new BilibiliDanmakuClient({ roomId: '1', logger });
      return `状态 ${JSON.stringify(client.status().running)}`;
    },
    { hint: '多半是依赖没装全：双击「安装依赖.bat」重装一次（缺 ws 时会走到这里）' }
  );
  check('DeepSeek 客户端可实例化', () => {
    const { DeepSeekClient } = require('./llm');
    const client = new DeepSeekClient(() => store.get().api, logger);
    return `解析测试「${DeepSeekClient.parseReply('{"reply":"ok","emotion":"happy"}').text}」`;
  });
  check('登录模块可用', () => `登录状态 ${JSON.stringify(biliLogin.status().loggedIn)}`);
  check(
    '界面文件存在',
    () => {
      const files = [
        path.join(__dirname, '..', 'renderer', 'panel', 'index.html'),
        path.join(__dirname, '..', 'renderer', 'panel', 'panel.js'),
        path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'),
        path.join(__dirname, '..', 'renderer', 'overlay', 'overlay.js'),
        path.join(__dirname, '..', 'shared', 'emotions.js')
      ];
      const missing = files.filter((file) => !fs.existsSync(file));
      if (missing.length) throw new Error(`缺少文件: ${missing.join(', ')}`);
      return `${files.length} 个文件都在`;
    },
    { hint: '解压不完整：把压缩包重新解压一次（别只拷一半文件）' }
  );
  check(
    'IPC 通道已注册',
    () => {
      const channels = [
        'settings:get',
        'settings:update',
        'danmaku:start',
        'danmaku:stop',
        'llm:test',
        'copilot:talk',
        'bili:loginOpen',
        'mascot:pickImages',
        'app:info'
      ];
      const missing = channels.filter((channel) => !INVOKE_CHANNELS.has(channel));
      if (missing.length) throw new Error(`未注册: ${missing.join(', ')}`);
      return `${channels.length} 个关键通道都在`;
    },
    { hint: '这是程序自身的问题（不是环境），把这一行连同 data\\boot.log 发给我' }
  );
  check(
    '虚拟屏幕尺寸可读',
    () => {
      const bounds = computeVirtualBounds();
      return `${bounds.width}x${bounds.height}`;
    },
    { fatal: false, hint: '远程桌面 / 没接显示器时会这样：悬浮窗位置可能放不准，其他功能照常' }
  );
  // ⚠️ `ok` 必须算在所有检查**之后**：以前写在前面，`failed` 还是 0，于是自检永远不会失败
  // （主播那台设备上「自检报失败」其实来自 Electron 自己的退出码，不是这个汇总）
  const ok = failed === 0;

  const summary = failed
    ? `存在问题（${failed} 项要修${warned ? `，另有 ${warned} 项只是提醒` : ''}）`
    : warned
      ? `全部通过（${warned} 项环境提醒，不影响使用）`
      : '全部通过';
  const text = `\n===== 启动自检 =====\n${report.join('\n')}\n===== 结果：${summary} =====\n`;
  process.stdout.write(text);
  logger.info(`启动自检${ok ? '通过' : '失败'}${warned ? `（${warned} 项环境提醒）` : ''}`);
  // 自检结果固定写一份到程序目录，不依赖 userData 能不能写
  try {
    fs.mkdirSync(path.dirname(SMOKE_LOG), { recursive: true });
    fs.writeFileSync(SMOKE_LOG, text, 'utf8');
  } catch (_) {
    /* ignore */
  }
  bootLog(`启动自检${ok ? '通过' : '失败'}${warned ? `（${warned} 项提醒）` : ''}`);
  // 自检失败时额外写一份 crash.log，方便直接把文件发给开发者
  if (!ok) {
    reportEarlyCrash('启动自检失败', new Error('详见 data/boot.log 与 data/smoke-test.log'));
  }
  app.exit(ok ? 0 : 1);
}

app.on('window-all-closed', () => {
  // 关掉控制面板就应该整个退出（悬浮窗也不再留着）。
  // 正常路径由 quitApp() 处理，这里是兜底：万一窗口被别的途径关光，也别留下无窗口的进程。
  if (!quitting) quitApp();
});

app.on('before-quit', () => {
  quitting = true;
  logger.info('程序退出');
  bootLog('程序退出');
  if (copilot.client) copilot.stopDanmaku().catch(() => {});
  // DSH 会话进程是常驻的，退出时必须收掉，不然会留下一个孤儿进程。
  // 先走优雅退出（发 shutdown 让服务端把会话日志写干净）——直接杀会打断正在跑的工具调用，
  // 会话里会留下「结果未知」的告警。
  // ⚠️ DSH 已下线（2026-10-19）：正常情况下这里没有任何东西要收（从没起过进程），
  //    但这段必须留着 —— 万一以后恢复、或者有人从旧版本会话里接手，漏了就会留孤儿进程。
  if (dshSession.busy) {
    bootLog('⚠️ 退出时有个 DSH 任务正在跑：正在让它优雅收尾；如果它正在调工具，那个调用会留成「结果未知」');
  }
  dshSession.stop({ graceful: true }).catch(() => {});
  dsh.cancel();
});

app.on('activate', () => {
  createPanelWindow();
});

/**
 * 测试出口：暴露 copilot 事件总线与配置，让测试可以真的触发一次「收到弹幕」、
 * 或临时改一下开关跑一遍。
 * 不影响运行，也没有对外接口能碰到它。
 */
module.exports = { copilot, wireEvents, store, applyOverlayConfig };
