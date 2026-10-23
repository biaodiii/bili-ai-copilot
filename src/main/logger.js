'use strict';

/**
 * 极简日志器：内存环形缓冲 + 可选写文件 + 推送到控制面板
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { appRoot } = require('./app-paths');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 单个日志文件的上限：**超过 5MB 就轮转**成 `xxx.log.1`，只留一份旧的。
 *
 * 为什么必须有（2026-10-21 加）：`bootLog()` 和这里的 `appendFile()` 原来都是裸 `appendFileSync`，
 * 一路往后追加、没有上限。实测过一次异常刷屏（「观众记忆总结失败」死循环重试），
 * **一分钟写了 298MB**，把磁盘写满、CPU 打满，而且人完全不会收到提示。
 * 弹幕记录那边早就有 `maxFileMB` / `keepFiles` 的轮转，这里补齐同样的保护。
 * 轮转后旧内容在 `copilot.log.1` / `boot.log.1`，再往上就丢（日志不是账本）。
 */
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * 把 file 轮转成 file.1（file.1 → file.2 …），只保留 keepFiles 份旧的。
 * 任何一步失败都不抛：日志写不进去不该影响直播。
 */
function rotateLogFile(file, keepFiles = 1) {
  const keep = Math.min(5, Math.max(1, Number(keepFiles) || 1));
  for (let index = keep; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index - 1}`;
    const to = `${file}.${index}`;
    try {
      if (!fs.existsSync(from)) continue;
      fs.rmSync(to, { force: true });
      fs.renameSync(from, to);
    } catch (_) {
      /* 磁盘忙 / 文件被占用：这轮不轮转，下次再来 */
    }
  }
}

/**
 * 追加一行日志，超过上限先轮转。
 *
 * 每次写入都真 stat 一次：本进程内不缓存大小，这样**外部**把文件写大/清空也能立刻算对。
 * 代价可以忽略——这些日志每秒最多几十行，stat 一次是微秒级。
 *
 * @returns {boolean} 是否写成功（失败静默，调用方本来就忽略返回值）
 */
function appendWithRotation(file, text, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_LOG_BYTES;
  const keepFiles = Number(options.keepFiles) || 1;
  const line = String(text);
  const bytes = Buffer.byteLength(line, 'utf8');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    // 当前文件已经有内容、再加就超了 → 先轮转；空文件不轮转（单行就超限时也别把文件转走）
    if (size > 0 && size + bytes > maxBytes) rotateLogFile(file, keepFiles);
    fs.appendFileSync(file, line, 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 日志文件固定写到「程序根目录/data/copilot.log」（打包后 = exe 旁边）。
 * 不依赖 app.getPath('userData') 是否设置成功——否则一旦 userData 落在别处，
 * 排查问题时就会找不到日志。
 *
 * 路径必须走 `app-paths.appRoot()`：打包后 `__dirname` 在 `resources\app\src\main`，
 * 直接拼会落到安装包内部（打发布包时实测踩到，配置和日志都会藏进去）。
 */
function pickLogFile() {
  const candidates = [
    path.join(appRoot(), 'data', 'copilot.log')
  ];
  try {
    candidates.push(path.join(app.getPath('userData'), 'copilot.log'));
  } catch (_) {
    /* ignore */
  }
  for (const candidate of candidates) {
    try {
      fs.mkdirSync(path.dirname(candidate), { recursive: true });
      fs.accessSync(path.dirname(candidate), fs.constants.W_OK);
      return candidate;
    } catch (_) {
      /* 换下一个 */
    }
  }
  return candidates[0];
}

class Logger {
  constructor() {
    this.buffer = [];
    this.maxMemory = 500;
    this.writeFile = true;
    this.listeners = new Set();
    this.minLevel = LEVELS.debug;
    this.file = pickLogFile();
  }

  configure({ maxMemory, writeFile, minLevel }) {
    if (Number.isFinite(maxMemory)) this.maxMemory = Math.max(50, maxMemory);
    if (typeof writeFile === 'boolean') this.writeFile = writeFile;
    if (minLevel && LEVELS[minLevel]) this.minLevel = LEVELS[minLevel];
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  history() {
    return this.buffer.slice();
  }

  log(level, message, extra) {
    if ((LEVELS[level] || 20) < this.minLevel) return;
    const entry = {
      ts: Date.now(),
      level,
      message: String(message),
      extra: extra === undefined ? undefined : extra
    };
    this.buffer.push(entry);
    while (this.buffer.length > this.maxMemory) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (_) {
        /* ignore */
      }
    }
    const line = `[${new Date(entry.ts).toLocaleTimeString('zh-CN')}][${level}] ${entry.message}${
      entry.extra === undefined ? '' : ' ' + safeJson(entry.extra)
    }`;
    if (level === 'error') console.error(line);
    else console.log(line);
    if (this.writeFile) this.appendFile(line);
  }

  appendFile(line) {
    // 超过上限就轮转，见 DEFAULT_MAX_LOG_BYTES 那段说明（以前是裸 appendFileSync，没上限）
    appendWithRotation(this.file, line + '\n');
  }

  debug(msg, extra) {
    this.log('debug', msg, extra);
  }

  info(msg, extra) {
    this.log('info', msg, extra);
  }

  warn(msg, extra) {
    this.log('warn', msg, extra);
  }

  error(msg, extra) {
    this.log('error', msg, extra);
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

module.exports = { Logger, safeJson, appendWithRotation, rotateLogFile, DEFAULT_MAX_LOG_BYTES };
