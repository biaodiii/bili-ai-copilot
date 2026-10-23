'use strict';

/**
 * 弹幕记录器：把「收到的每一条弹幕」逐条落到文件里，包括被去重丢掉的那些。
 *
 * 存在的理由：主线日志（copilot.log）只记录程序解析出的事件和 AI 回复，
 * 弹幕正文从来不进去。一旦出现「有些弹幕不显示」，就没有任何东西可以拿来
 * 对照——既看不出漏的是哪条，也分不清是服务端重发还是不同弹幕撞了同一个 id。
 *
 * 格式（一行一条，正文放最后，所以正文里有空格也不影响按列阅读）：
 *   2026-10-10 16:52:40  1791620118  菲尼尔  今天天气不错  [正常]
 *   2026-10-10 16:52:41  1791620118  菲尼尔  今天天气不错  [重复/同id]
 * 方括号里是处理结果：正常 / 重复·无id / 重复·同id / 解析失败
 *
 * 落盘失败（磁盘满、文件被占用、权限问题）只计数，绝不抛错——
 * 记录日志这件事永远不能影响收弹幕。
 */

const fs = require('fs');
const path = require('path');

/** 结果列：一眼看出这条是被放过了还是被丢了 */
const OUTCOME = {
  ok: '正常',
  dupId: '重复·同id',
  dupText: '重复·无id',
  unparsed: '解析失败',
  // 每次连接的第一条原始报文样张：用来证明「连接确实在收弹幕」，
  // 从而把「弹幕没到程序」和「到了但没解析出来」区分开
  rawSample: '原始报文'
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

function stamp(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

/** 正文里的换行/制表符会破坏「一行一条」，统一压成空格 */
function flatten(value, limit) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (limit > 0 && text.length > limit) return `${text.slice(0, limit)}…`;
  return text;
}

class DanmakuRecorder {
  /**
   * @param {object} options
   * @param {string} options.dir      记录目录；给空则只用 config.dir
   * @param {object} options.logger   主线日志器，可选
   * @param {object} options.config   { enabled, dir, maxFileMB, keepFiles, maxTextLength }
   */
  constructor({ dir, logger, config } = {}) {
    this.fallbackDir = dir || path.join(__dirname, '..', '..', 'data');
    this.logger = logger || null;
    this.enabled = false;
    this.dir = this.fallbackDir;
    this.config = { enabled: false, dir: '', maxFileMB: 2, keepFiles: 5, maxTextLength: 300 };
    this.stats = {
      lines: 0, // 本次运行写进去多少条
      bytes: 0, // 本次运行写了多少字节
      rotations: 0, // 轮转过多少次
      failed: 0, // 落盘失败次数（磁盘满/被占用等）
      truncated: 0 // 正文过长被截断的条数
    };
    this.lastError = '';
    this.lastWriteAt = 0;
    if (config) this.configure(config);
  }

  /** 记录文件所在的子目录，免得和别的文件混在一起 */
  get dirPath() {
    return path.join(this.dir, 'danmaku');
  }

  get filePath() {
    return path.join(this.dirPath, 'danmaku.log');
  }

  configure(config = {}) {
    const next = { ...this.config };
    for (const key of Object.keys(this.config)) {
      if (config[key] !== undefined && config[key] !== null) next[key] = config[key];
    }
    // 数值兜底：手改配置写出 0 或负数时不能让日志无限涨
    const size = Number(next.maxFileMB);
    next.maxFileMB = Number.isFinite(size) ? Math.min(100, Math.max(0.1, size)) : 2;
    const keep = Number(next.keepFiles);
    next.keepFiles = Number.isFinite(keep) ? Math.min(50, Math.max(1, Math.floor(keep))) : 5;
    const textLimit = Number(next.maxTextLength);
    next.maxTextLength = Number.isFinite(textLimit) ? Math.min(5000, Math.max(20, Math.floor(textLimit))) : 300;
    next.enabled = Boolean(next.enabled);
    next.dir = typeof next.dir === 'string' ? next.dir.trim() : '';

    const wasEnabled = this.enabled;
    const dirChanged = this.dir !== (next.dir || this.fallbackDir);
    this.dir = next.dir || this.fallbackDir;
    this.config = next;
    this.enabled = next.enabled;
    // 换了位置要重新确认目录能写（旧目录可能已经不存在了）
    if (this.enabled && (!wasEnabled || dirChanged)) this._ensureDir();
    return this.config;
  }

  _ensureDir() {
    try {
      fs.mkdirSync(this.dirPath, { recursive: true });
      return true;
    } catch (error) {
      this.stats.failed += 1;
      this.lastError = `创建记录目录失败: ${error.message}`;
      return false;
    }
  }

  /**
   * 写入一条弹幕记录。永不抛错。
   * @param {object} entry
   * @param {string} [entry.messageId]
   * @param {string} [entry.user]
   * @param {number} [entry.uid]
   * @param {string} [entry.text]
   * @param {boolean} [entry.duplicate]
   * @param {boolean} [entry.unparsed]
   * @param {boolean} [entry.noId]      是否是无 id 的兜底去重路径
   * @param {string} [entry.raw]        解析失败时留原始报文的摘要
   * @param {boolean} [entry.rawSample] 是否是「原始报文样张」那一行（不是真弹幕）
   * @returns {{written: boolean, reason?: string}}
   */
  record(entry = {}) {
    if (!this.enabled) return { written: false, reason: '已关闭' };

    let outcome = OUTCOME.ok;
    if (entry.rawSample) outcome = OUTCOME.rawSample;
    else if (entry.unparsed) outcome = OUTCOME.unparsed;
    else if (entry.duplicate) outcome = entry.noId ? OUTCOME.dupText : OUTCOME.dupId;

    const time = stamp(new Date());
    const id = entry.messageId ? String(entry.messageId) : '(无id)';
    let text = flatten(entry.text, 0);
    if (this.config.maxTextLength > 0 && text.length > this.config.maxTextLength) {
      text = `${text.slice(0, this.config.maxTextLength)}…`;
      this.stats.truncated += 1;
    }
    if (!text && entry.raw) text = flatten(entry.raw, this.config.maxTextLength);
    const user = flatten(entry.user, 40) || '观众';
    const line = `${time}  ${id.padEnd(12)}  ${user.padEnd(16)}  ${text}  [${outcome}]`;

    const result = this._append(line);
    if (result.written) {
      this.stats.lines += 1;
      this.stats.bytes += Buffer.byteLength(line, 'utf8') + 1;
      this.lastWriteAt = Date.now();
    }
    return result;
  }

  _append(line) {
    if (!this._ensureDir()) return { written: false, reason: '目录不可写' };
    const target = this.filePath;
    try {
      this._rotateIfNeeded(target);
      fs.appendFileSync(target, `${line}\n`, 'utf8');
      this.lastError = '';
      return { written: true };
    } catch (error) {
      this.stats.failed += 1;
      this.lastError = error.message;
      // 落盘失败不能影响收弹幕，所以这里只记账
      if (this.logger && this.logger.warn) {
        this.logger.warn(`[弹幕记录] 写入失败（累计 ${this.stats.failed} 次）: ${error.message}`);
      }
      return { written: false, reason: error.message };
    }
  }

  _rotateIfNeeded(target) {
    const maxBytes = Math.round(this.config.maxFileMB * 1024 * 1024);
    let size = 0;
    try {
      size = fs.statSync(target).size;
    } catch (_) {
      return; // 文件还不存在，不用轮转
    }
    if (size < maxBytes) return;

    // 归档成 danmaku.log.1（越老编号越大），再删掉超出保留份数的
    for (let index = this.config.keepFiles - 1; index >= 1; index -= 1) {
      const from = index === 1 ? target : `${target}.${index - 1}`;
      const to = `${target}.${index}`;
      try {
        if (fs.existsSync(from)) {
          fs.rmSync(to, { force: true });
          fs.renameSync(from, to);
        }
      } catch (_) {
        /* 归档失败就继续用当前文件，下一条再试 */
      }
    }
    this.stats.rotations += 1;
    if (this.logger && this.logger.info) {
      this.logger.info(`[弹幕记录] 文件超过 ${this.config.maxFileMB}MB，已归档（累计 ${this.stats.rotations} 次）`);
    }
  }

  status() {
    let fileSize = 0;
    if (this.enabled) {
      try {
        fileSize = fs.statSync(this.filePath).size;
      } catch (_) {
        fileSize = 0;
      }
    }
    return {
      enabled: this.enabled,
      file: this.filePath,
      dir: this.dirPath,
      baseDir: this.dir,
      fileSize,
      maxFileMB: this.config.maxFileMB,
      keepFiles: this.config.keepFiles,
      lastWriteAt: this.lastWriteAt,
      lastError: this.lastError,
      stats: { ...this.stats }
    };
  }
}

module.exports = { DanmakuRecorder, OUTCOME, flatten, stamp };
