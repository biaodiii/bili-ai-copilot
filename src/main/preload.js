'use strict';

/**
 * 预加载脚本：向渲染进程暴露一个受限的 window.api
 */

const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => invoke('settings:get'),
    update: (partial) => invoke('settings:update', partial),
    reset: () => invoke('settings:reset'),
    openFolder: () => invoke('settings:openFolder'),
    defaultPersona: () => invoke('settings:defaultPersona')
  },
  overlay: {
    setClickThrough: (ignore) => invoke('overlay:setClickThrough', ignore),
    hitTest: (ignore) => invoke('overlay:hitTest', ignore),
    setFocusable: (value) => invoke('overlay:setFocusable', value),
    toggle: () => invoke('overlay:toggle'),
    isVisible: () => invoke('overlay:isVisible'),
    hide: () => invoke('overlay:hide'),
    reload: () => invoke('overlay:reload'),
    openDrawer: () => invoke('overlay:openDrawer'),
    testMessage: (payload) => invoke('overlay:testMessage', payload)
  },
  danmaku: {
    start: () => invoke('danmaku:start'),
    stop: () => invoke('danmaku:stop'),
    test: (roomId) => invoke('danmaku:test', roomId)
  },
  llm: {
    test: () => invoke('llm:test')
  },
  bili: {
    status: () => invoke('bili:loginStatus'),
    login: () => invoke('bili:loginOpen'),
    logout: () => invoke('bili:loginLogout'),
    verify: () => invoke('bili:loginVerify'),
    verifyManual: (text) => invoke('bili:verifyManualCookie', text),
    cookieHeader: () => invoke('bili:cookieHeader')
  },
  copilot: {
    talk: (text) => invoke('copilot:talk', text),
    replyRecent: (seconds) => invoke('copilot:replyRecent', seconds),
    clearHistory: () => invoke('copilot:clearHistory'),
    clearSelfNote: () => invoke('copilot:clearSelfNote'),
    selfNote: () => invoke('copilot:selfNote'),
    systemPrompt: () => invoke('copilot:systemPrompt'),
    history: () => invoke('copilot:history'),
    pause: (reason) => invoke('copilot:pause', reason),
    resume: () => invoke('copilot:resume'),
    warmup: () => invoke('copilot:warmup'),
    exportHistory: () => invoke('copilot:exportHistory'),
    status: () => invoke('copilot:status')
  },
  usage: {
    summary: () => invoke('usage:summary'),
    reset: (scope) => invoke('usage:reset', scope)
  },
  // 云端语音合成：一段文本换回 base64 音频（失败时 ok:false + message，界面据此降级）
  tts: {
    synthesize: (text) => invoke('tts:synthesize', text),
    status: () => invoke('tts:status'),
    clearCache: () => invoke('tts:clearCache')
  },
  mascot: {
    pickImages: () => invoke('mascot:pickImages')
  },
  app: {
    info: () => invoke('app:info')
  },
  /** 界面出错时把原因报给主进程（会写进 data/renderer-error.log） */
  debug: {
    report: (payload) => invoke('debug:report', payload)
  },
  log: {
    get: () => invoke('log:get'),
    clear: () => invoke('log:clear'),
    openFile: () => invoke('log:openFile')
  },
  /** 弹幕记录：把收到的每条弹幕逐条写的文件 */
  danmakuLog: {
    open: () => invoke('danmakuLog:open'),
    status: () => invoke('danmakuLog:status'),
    chooseDir: () => invoke('danmakuLog:chooseDir')
  },
  /**
   * 知识库：条目存在 data/knowledge/notes/*.md（一个条目一个文件）。
   * 界面只跟主进程要数据，不直接读盘——文件格式的细节留在主进程一处。
   */
  knowledge: {
    list: () => invoke('knowledge:list'),
    add: (payload) => invoke('knowledge:add', payload),
    update: (id, patch) => invoke('knowledge:update', id, patch),
    remove: (id) => invoke('knowledge:remove', id),
    search: (text, options) => invoke('knowledge:search', text, options),
    openFolder: () => invoke('knowledge:openFolder'),
    /** 待审草稿：通过（写进知识库）或丢弃 */
    approve: (id, patch) => invoke('knowledge:approve', id, patch),
    reject: (id) => invoke('knowledge:reject', id),
    clearPending: () => invoke('knowledge:clearPending'),
    /** 「知识库改动记录」：她改的 / 你改的 / 删除的都在里面，每条都能撤销 */
    edits: () => invoke('knowledge:edits'),
    undoEdit: (editId) => invoke('knowledge:undoEdit', editId),
    /**
     * 从文件导入资料（2026-10-19 加的）。
     *   pickImportFiles = 弹系统选文件框 → 读进来体检（编码/是否文本/大小），**不花钱**；
     *   importFiles     = 把刚选的那批切成片让模型整理 → 产出进「待审草稿」（不直接写库）。
     * 两步分开是为了让主播先看到「几个文件、多少字」再决定要不要花这笔钱。
     */
    pickImportFiles: () => invoke('knowledge:pickImportFiles'),
    importFiles: () => invoke('knowledge:importFiles'),
    /**
     * 整理 / 校对 / 更新（2026-10-19 加的）—— 模型用最高思考档检查已有知识：
     *   reviewState  = 读当前的「建议」列表 + 运行状态（界面初始化 / 广播都用它）
     *   reviewAudit  = 整理全库（找重复/冲突/过时，一次调用，几分钱）
     *   reviewVerify = 联网校对（逐条搜索 + 高思考，每条约 0.01 元；ids 给指定条目，limit 给条数）
     *   reviewApply / reviewApplyAll / reviewDiscard / reviewClear = 建议的生命周期
     *   reviewCancel = 中途叫停（正在飞的那次请求也会被中止）
     * ⚠️ 模型只出建议：**只有点应用才会动 notes/**；写之前自动备份，改动记录里能撤销。
     */
    reviewState: () => invoke('knowledge:reviewState'),
    reviewAudit: () => invoke('knowledge:reviewAudit'),
    reviewVerify: (options) => invoke('knowledge:reviewVerify', options),
    reviewApply: (itemId) => invoke('knowledge:reviewApply', itemId),
    reviewApplyAll: () => invoke('knowledge:reviewApplyAll'),
    reviewDiscard: (itemId) => invoke('knowledge:reviewDiscard', itemId),
    reviewClear: () => invoke('knowledge:reviewClear'),
    reviewCancel: () => invoke('knowledge:reviewCancel')
  },
  /**
   * 观众记忆（2026-10-21）：解决「清空对话上下文之后她就失忆了」。
   *   · 本场文档 `data/观众记忆/2026-10-21_20-15.md`：模型批量总结（观众说过什么、主播定过什么）；
   *   · 老观众名册 `data/观众记忆/老观众.md`：纯本地维护（谁发过弹幕、发了多少条），零模型成本。
   * 两份都在 `data/` 下、**不进知识库**；`state` 给界面画状态，其余是查看/清空。
   */
  memory: {
    state: () => invoke('memory:state'),
    flush: () => invoke('memory:flush'),
    openFolder: () => invoke('memory:openFolder'),
    openFile: (kind) => invoke('memory:openFile', kind),
    clearSession: () => invoke('memory:clearSession'),
    clearRoster: () => invoke('memory:clearRoster')
  },
  /**
   * 「模型想查 / 想记」的待办：模型只提议，花钱和写库都由主播在这儿点出来。
   *   note = 把「记一笔」记进知识库（不联网，留备份、能撤销）
   *   run  = 按类型办：查（内置联网 / DSH，产出进待审）/ 改 / 扩写（带备份改条目）
   */
  research: {
    list: () => invoke('research:list'),
    note: (id, patch) => invoke('research:note', id, patch),
    run: (id) => invoke('research:run', id),
    ignore: (id) => invoke('research:ignore', id),
    remove: (id) => invoke('research:remove', id),
    clearFinished: () => invoke('research:clearFinished')
  },
  /**
   * DSH（DeepSeek Harness）——可选的研究引擎。
   * 软件本身不带 DSH：先 `detect()` 看这台机器缺什么，检测通过才允许 `run()`。
   *
   * ⚠️ **已下线**（2026-10-19）：界面上那张「让 DSH 整理」卡已 `hidden`，没有任何界面入口
   * 会调这三个方法；主进程的通道也保留着，所以这里不动（删了 `test-ipc-contract.js`
   * 的「preload 与主进程通道一一对应」反而要改）。恢复步骤见交接文档 §6.16。
   */
  dsh: {
    detect: (options) => invoke('dsh:detect', options),
    run: (payload) => invoke('dsh:run', payload),
    cancel: () => invoke('dsh:cancel')
  },
  window: {
    openPanel: () => invoke('window:openPanel'),
    quit: () => invoke('window:quit'),
    setBounds: (bounds) => invoke('window:setBounds', bounds)
  },
  on: {
    settingsChanged: (handler) => on('settings:changed', handler),
    status: (handler) => on('status', handler),
    danmaku: (handler) => on('danmaku', handler),
    danmakuFiltered: (handler) => on('danmaku:filtered', handler),
    reply: (handler) => on('ai:reply', handler),
    thinking: (handler) => on('ai:thinking', handler),
    botState: (handler) => on('overlay:state', handler),
    overlayConfig: (handler) => on('overlay:config', handler),
    overlayRelayout: (handler) => on('overlay:relayout', handler),
    openDrawer: (handler) => on('overlay:openDrawer', handler),
    closeDrawer: (handler) => on('overlay:closeDrawer', handler),
    error: (handler) => on('app:error', handler),
    roomInfo: (handler) => on('room-info', handler),
    popularity: (handler) => on('popularity', handler),
    biliLogin: (handler) => on('bili:login', handler),
    selfNote: (handler) => on('ai:selfNote', handler),
    /** 「模型想查 / 想记」的待办变了（模型刚提了新需求 / 查完了） */
    research: (handler) => on('research:changed', handler),
    /** 知识库被改了（她自己改的 / 撤销了）：面板要重画「改动记录」和条目列表 */
    knowledgeChanged: (handler) => on('knowledge:changed', handler),
    /** 有草稿进「待审」了：面板弹一条能直接「全部通过」的提示（不用点进知识库页） */
    draftsReady: (handler) => on('drafts:ready', handler),
    /** 整理/校对的建议列表或运行进度变了（跑起来、跑完、应用/忽略一条都会发） */
    knowledgeReview: (handler) => on('knowledge:review', handler),
    /** 观众记忆的状态变了（开始/结束本场、总结完一批、清空）：面板刷新状态行 */
    memoryChanged: (handler) => on('memory:changed', handler),
    paused: (handler) => on('ai:paused', handler),
    usage: (handler) => on('usage', handler),
    log: (handler) => on('log', handler),
    logHistory: (handler) => on('log:history', handler)
  }
});
