'use strict';

/**
 * B 站直播弹幕客户端（直连官方 WebSocket，不依赖任何插件）
 *
 * 协议要点（来自 bilibili-API-collect 与 blivedm 实现）：
 *   包头 16 字节：packetLen(4) headerLen(2) protover(2) operation(4) sequence(4)，均为大端
 *   operation: 2=心跳 3=心跳回复(人气值) 5=消息 7=认证 8=认证回复
 *   protover: 0/1=JSON明文 2=zlib压缩 3=brotli压缩（Node 内置 zlib 即可解）
 *   getDanmuInfo 需要 WBI 签名（w_rid + wts），-352 表示触发风控
 */

const { EventEmitter } = require('events');
const zlib = require('zlib');
const crypto = require('crypto');

const HEADER_LEN = 16;
const OP_HEARTBEAT = 2;
const OP_HEARTBEAT_REPLY = 3;
const OP_MESSAGE = 5;
const OP_AUTH = 7;
const OP_AUTH_REPLY = 8;

const API = {
  roomInit: 'https://api.live.bilibili.com/room/v1/Room/room_init',
  roomInfo: 'https://api.live.bilibili.com/room/v1/Room/get_info',
  anchorInfo: 'https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room',
  danmuInfo: 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  fingerprint: 'https://api.bilibili.com/x/frontend/finger/spi',
  history: 'https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory'
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BASE_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  Referer: 'https://live.bilibili.com/',
  Origin: 'https://live.bilibili.com'
};

// WBI 混淆表
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42,
  19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60,
  51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback = 0) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** 取命令行（去掉 DANMU_MSG:4:0:2:2:2:0 这类后缀，统一成 DANMU_MSG） */
function cmdName(cmd) {
  return String(cmd || '').split(':')[0].trim();
}

function md5(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function getMixinKey(imgKey, subKey) {
  const raw = String(imgKey || '') + String(subKey || '');
  if (raw.length < 64) throw new Error('WBI key 长度不足，B 站接口可能已变更');
  return MIXIN_KEY_ENC_TAB.map((index) => raw[index]).join('').slice(0, 32);
}

function encodeWbi(params, mixinKey) {
  const signed = {};
  for (const [key, value] of Object.entries(params)) {
    signed[key] = String(value).replace(/[!'()*]/g, '');
  }
  signed.wts = String(Math.floor(Date.now() / 1000));
  const query = Object.keys(signed)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(signed[key])}`)
    .join('&');
  signed.w_rid = md5(query + mixinKey);
  return signed;
}

/** 解析用户填写的 Cookie：支持 "SESSDATA=xxx; bili_jct=yyy" 或只填 SESSDATA 的值 */
function parseCookieInput(input) {
  const text = String(input || '').trim();
  const cookies = {};
  if (!text) return cookies;
  if (!text.includes('=')) {
    cookies.SESSDATA = text;
    return cookies;
  }
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

/** 解析 DANMU_MSG 的 info 数组，返回 null 表示结构不认识 */
function parseDanmakuInfo(info) {
  // 结构校验要严格一点：info[1] 是文本、info[2] 是发送者数组，缺一不可
  if (!Array.isArray(info) || info.length < 3) return null;
  if (typeof info[1] !== 'string') return null;
  if (!Array.isArray(info[2])) return null;
  const userInfo = info[2];
  const medalInfo = Array.isArray(info[3]) ? info[3] : [];
  const uidValue = userInfo[0];
  // info[0][5] 才是这条弹幕唯一的 id；info[0][0] 恒为 0，绝对不能拿来兜底
  // （否则所有消息共用同一个 id，去重会把真弹幕成片丢掉）。没有 id 时留空，
  // 由 _onDanmaku 走「内容 + 时间戳」的兜底去重。
  const rawId = Array.isArray(info[0]) ? info[0][5] : undefined;
  const hasId = rawId !== undefined && rawId !== null && String(rawId) !== '' && String(rawId) !== '0';
  const meta = Array.isArray(info[0]) ? info[0] : [];
  return {
    text: info[1],
    user: String(userInfo[1] || '观众'),
    uid: Number.isFinite(Number(uidValue)) ? Number(uidValue) : 0,
    guardLevel: toInt(userInfo[7], 0),
    medal: medalInfo.length >= 2 ? String(medalInfo[1] || '') : '',
    messageId: hasId ? String(rawId) : '',
    // 只在 id 缺失时用于兜底去重的原始字段
    rawTs: toInt(meta[4], 0),
    rawFlags: `${toInt(meta[1], 0)}:${toInt(meta[2], 0)}:${toInt(meta[3], 0)}`
  };
}

/**
 * 极短字符串散列：只给「没有 id 的弹幕」做兜底去重，不参与业务逻辑，
 * 所以不需要抗碰撞强度，只需要稳定。
 */
function shortHash(input) {
  const text = String(input);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

/** 精简的弹幕事件 */
function makeEvent(type, fields) {
  // 注意 uid 可能是 0（未登录时服务端下发的 uid 就是 0），
  // 不能用 `fields.uid || ''` 这种写法，否则 0 会被吞成空字符串。
  const uidValue = Number(fields.uid);
  return {
    type,
    id: fields.id || '',
    ts: Date.now(),
    user: fields.user || '',
    uid: Number.isFinite(uidValue) ? uidValue : 0,
    text: fields.text || '',
    medal: fields.medal || '',
    guardLevel: fields.guardLevel || 0,
    amount: fields.amount,
    raw: fields.raw
  };
}

class BilibiliDanmakuClient extends EventEmitter {
  /**
   * @param {{roomId:number|string, sessdata?:string, useCookie?:boolean, cookieHeader?:string, logger?:object, recorder?:object}} options
   *   recorder 是 DanmakuRecorder（可选）：把每条收到的弹幕逐条落文件，含被去重丢掉的
   */
  constructor(options = {}) {
    super();
    this.roomIdInput = options.roomId;
    this.sessdata = options.sessdata || '';
    this.useCookie = Boolean(options.useCookie);
    this.cookieHeader = options.cookieHeader || '';
    this.logger = options.logger || console;
    this.recorder = options.recorder || null;
    // 原始 DANMU_MSG 留痕（每次启动第一条）：用来区分「弹幕没到」和「到了没解析出来」
    this.recordRawCommands = options.recordRawCommands !== false;

    this.realRoomId = null;
    this.uid = 0;
    this.token = '';
    this.hosts = [];
    this.cookies = {};
    this.ws = null;
    this.running = false;
    this.connected = false;
    this.stopping = false;
    this.attempt = 0;
    this._rawCommandLogged = false;

    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._wbiCache = null;
    this._fpCached = null;
    this._seen = new Map();
    // 每条弹幕 id 最近一次的指纹（id → { fingerprint, text, ts }），用来发现服务端 id 复用
    this._seenText = new Map();
    this._lastError = '';
    // 收包统计：用来定位「有些弹幕没读到」到底丢在哪一步
    this.stats = {
      packets: 0, // op=5 数据包数
      commands: 0, // 解出来的命令总数
      danmaku: 0, // 成功解析并抛出的弹幕
      unparsed: 0, // 结构不认识、跳过的 DANMU_MSG
      duplicate: 0, // 判定为重复而丢掉的
      idCollision: 0 // 同一个 id 对应了不同弹幕（服务端 id 复用，只按 id 去重会漏弹幕）
    };
  }

  log(level, message, extra) {
    const fn = this.logger[level];
    if (typeof fn === 'function') fn.call(this.logger, `[弹幕] ${message}`, extra);
  }

  status() {
    return {
      running: this.running,
      connected: this.connected,
      roomIdInput: this.roomIdInput ? String(this.roomIdInput) : '',
      realRoomId: this.realRoomId ? String(this.realRoomId) : '',
      hostCount: this.hosts.length,
      attempt: this.attempt,
      lastError: this._lastError,
      // 收包统计：定位「弹幕没读到」时看这里
      stats: { ...this.stats }
    };
  }

  _emitStatus() {
    this.emit('status', this.status());
  }

  async start() {
    if (this.running) return this.status();
    if (!this.roomIdInput) throw new Error('请先填写直播间房间号');
    this.running = true;
    this.stopping = false;
    this.attempt = 0;
    this._lastError = '';
    this._emitStatus();
    this._loop().catch((error) => {
      this.log('error', `监听循环异常退出: ${error.message}`);
    });
    return this.status();
  }

  async stop() {
    this.stopping = true;
    this.running = false;
    clearInterval(this._heartbeatTimer);
    clearTimeout(this._reconnectTimer);
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this.connected = false;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {
        /* ignore */
      }
      this.ws = null;
    }
    this._emitStatus();
  }

  async _loop() {
    while (this.running) {
      try {
        await this._fetchDanmuInfo();
        await this._connectOnce();
        this.attempt = 0;
        // 正常断开（服务端主动踢）也要留出间隔，避免高频重连被限流
        if (this.running && !this.stopping) await sleep(1500);
      } catch (error) {
        if (!this.running) break;
        this._lastError = error.message || String(error);
        this.attempt += 1;
        const delay = Math.min(60000, 3000 * Math.pow(1.8, Math.min(this.attempt, 6)));
        this.log('warn', `连接失败(${error.message})，${Math.round(delay / 1000)}s 后重连`);
        this._emitStatus();
        await sleep(delay);
      }
    }
  }

  async _connectOnce() {
    const host = this.hosts[0];
    if (!host) throw new Error('未获取到弹幕服务器地址');
    const url = `wss://${host.host}:${host.wssPort}/sub`;
    this.log('info', `正在连接弹幕服务器 ${host.host}:${host.wssPort}`);

    await new Promise((resolve, reject) => {
      const WS = require('ws');
      const ws = new WS(url, {
        headers: {
          'User-Agent': UA,
          Origin: 'https://live.bilibili.com',
          Referer: `https://live.bilibili.com/${this.realRoomId}`
        },
        handshakeTimeout: 15000
      });
      this.ws = ws;
      let settled = false;

      const done = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      ws.on('open', () => {
        this.log('info', 'WebSocket 已连接，发送认证包');
        this._sendAuth();
      });

      ws.on('message', (data) => {
        try {
          this._handlePacket(Buffer.isBuffer(data) ? data : Buffer.from(data));
        } catch (error) {
          this.log('debug', `解析数据包失败: ${error.message}`);
        }
      });

      ws.on('close', (code) => {
        clearInterval(this._heartbeatTimer);
        this._heartbeatTimer = null;
        const wasConnected = this.connected;
        this.connected = false;
        this._emitStatus();
        if (this.running && !this.stopping) {
          this.log('warn', `弹幕连接已断开(code=${code})${wasConnected ? '，准备重连' : ''}`);
        }
        done(null);
      });

      ws.on('error', (error) => {
        this._lastError = error.message;
        this.log('warn', `WebSocket 错误: ${error.message}`);
        done(error);
      });
    });
  }

  _sendAuth() {
    // 未登录（游客）时必须用 uid=0：实测填真实 uid（room_init 返回的是主播 uid）会被
    // 服务端直接断开（close code 1006，收不到 op=8 认证回复）。
    // buvid（来自 getDanmuInfo 同一 context 的设备指纹）则要带上，
    // 否则拿到的连接处于受限状态，收不到弹幕。
    const payload = {
      uid: this.usingLogin && this.uid ? this.uid : 0,
      roomid: this.realRoomId,
      protover: 3,
      platform: 'web',
      type: 2,
      key: this.token
    };
    if (this.cookies.buvid3) payload.buvid = this.cookies.buvid3;
    this._send(OP_AUTH, payload);
  }

  _send(operation, body) {
    if (!this.ws || this.ws.readyState !== 1) return;
    const json = Buffer.from(JSON.stringify(body), 'utf8');
    const header = Buffer.alloc(HEADER_LEN);
    header.writeUInt32BE(HEADER_LEN + json.length, 0);
    header.writeUInt16BE(HEADER_LEN, 4);
    header.writeUInt16BE(1, 6);
    header.writeUInt32BE(operation, 8);
    header.writeUInt32BE(1, 12);
    this.ws.send(Buffer.concat([header, json]));
  }

  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    const beat = () => this._send(OP_HEARTBEAT, {});
    beat();
    this._heartbeatTimer = setInterval(beat, 25000);
  }

  _handlePacket(buffer, depth = 0) {
    let offset = 0;
    while (offset + HEADER_LEN <= buffer.length) {
      const packetLen = buffer.readUInt32BE(offset);
      const headerLen = buffer.readUInt16BE(offset + 4);
      const protover = buffer.readUInt16BE(offset + 6);
      const operation = buffer.readUInt32BE(offset + 8);
      if (packetLen < HEADER_LEN || offset + packetLen > buffer.length) {
        // 包长对不上说明数据被截断：记下来，不然会莫名其妙丢消息
        this.stats.truncated = (this.stats.truncated || 0) + 1;
        this.log('warn', `数据包长度异常，已跳过剩余部分（累计 ${this.stats.truncated} 次）`);
        break;
      }
      const body = buffer.subarray(offset + headerLen, offset + packetLen);
      offset += packetLen;

      if (operation === OP_MESSAGE) {
        this.stats.packets += 1;
        if (protover === 2) {
          try {
            this._handlePacket(zlib.inflateSync(body), depth + 1);
          } catch (error) {
            this.stats.decompressFailed = (this.stats.decompressFailed || 0) + 1;
            this.log('warn', `zlib 解压失败（累计 ${this.stats.decompressFailed} 次）: ${error.message}`);
          }
        } else if (protover === 3) {
          try {
            this._handlePacket(zlib.brotliDecompressSync(body), depth + 1);
          } catch (error) {
            this.stats.decompressFailed = (this.stats.decompressFailed || 0) + 1;
            this.log('warn', `brotli 解压失败（累计 ${this.stats.decompressFailed} 次）: ${error.message}`);
          }
        } else {
          this._handleJsonBody(body);
        }
      } else if (operation === OP_AUTH_REPLY) {
        this._handleAuthReply(body);
      } else if (operation === OP_HEARTBEAT_REPLY) {
        const popularity = body.length >= 4 ? body.readUInt32BE(0) : 0;
        this.emit('popularity', popularity);
      }
    }
  }

  _handleAuthReply(body) {
    let data = {};
    try {
      data = JSON.parse(body.toString('utf8'));
    } catch (_) {
      /* ignore */
    }
    if (data.code === 0) {
      this.connected = true;
      this._lastError = '';
      this._startHeartbeat();
      this.log('info', `认证成功，开始接收弹幕（房间 ${this.realRoomId} 人气值 ${data.data ? data.data : ''}）`.trim());
      this.emit('open', this.status());
      this._emitStatus();
    } else {
      const message = `认证失败 code=${data.code} ${data.message || ''}`;
      this._lastError = message;
      this.log('error', message);
      try {
        this.ws.close();
      } catch (_) {
        /* ignore */
      }
      this._emitStatus();
    }
  }

  _handleJsonBody(body) {
    const text = body.toString('utf8').replace(/\0+$/, '');
    if (!text) return;
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_) {
      return;
    }
    this._dispatch(payload);
  }

  _dispatch(payload) {
    if (!payload || !payload.cmd) return;
    const cmd = cmdName(payload.cmd);
    const data = payload.data || {};
    this.stats.commands += 1;

    switch (cmd) {
      case 'DANMU_MSG':
        // 注意：DANMU_MSG 的正文在命令根对象的 info 字段上，不在 payload.data 里
        return this._onDanmaku(payload);
      case 'WATCHED_CHANGE':
        return this.emit('watched', { count: toInt(data.num, 0) });
      // 2026-10-21 删了礼物 / 上舰 / 醒目留言 / 进场这四类：
      //   `SEND_GIFT` / `GUARD_BUY` / `SUPER_CHAT_MESSAGE(_DELETE)` / `INTERACT_WORD(_V2)`。
      // 为什么删：实测**这条连接根本收不到这些命令**（直播间正常有礼物时也一条不来），
      // 解析分支永远不会触发；留着只会让人以为「勾上就会回应礼物」，还把设置页撑出两个假开关。
      // 想恢复：把下面这四行加回来，再照旧接 copilot 的 onEventMessage + 面板那两个勾
      //   （交接文档 §6.32 存了当时的实现说明，别只加开关不加解析）。
      // 现在它们统一落到 default：只 emit raw，由日志/探针脚本自己看，不影响回复链路。
      default:
        this.emit('raw', payload);
    }
  }

  _onDanmaku(data) {
    // 兼容两种承载方式：新版把 info 放在 data 里，老版直接放在命令根对象上
    const info = (data && data.info) || (data && data.data && data.data.info) || (data && data.raw && data.raw.info);
    const parsed = parseDanmakuInfo(info);
    if (!parsed) {
      // 结构不认识时不要静默吞掉：记进统计并打日志，方便按真实数据修正解析
      this.stats.unparsed += 1;
      const summary = JSON.stringify(data).slice(0, 300);
      this.log('warn', `有弹幕结构无法解析，已跳过（累计 ${this.stats.unparsed} 条）：${summary}`);
      // 解析失败的报文也要落进弹幕记录：不然"漏了哪条"正好查不到
      this._recordDanmaku({ unparsed: true, raw: summary });
      return;
    }
    // 原始命令留痕（每次启动只写第一条）：用来区分「弹幕没到程序」和「到了但解析错了」。
    // 排查「我明明发了某条弹幕却没抓到」时，先看这一行在不在：不在就是没收到，
    // 收了却没进记录文件才是程序的问题。默认开，关掉可以少占一点文件体积。
    if (this.recordRawCommands) this._recordRawCommand(info);
    // 去重原则：宁可重复显示一条，也绝不漏掉真弹幕。key 只由「同一条消息重发时
    // 必然稳定」的字段组成，这样既能挡住服务端重发，又不会把不同弹幕误杀。
    //
    //   · 有 id：用「id + 该条自带的发送时间戳 + 正文散列」做指纹，TTL 给足 5 分钟——
    //     实测有 id 在 5 分钟内重复出现 10 次，只认 id 会把真弹幕成片吞掉。
    //     观众用同样的话连发两条时，发送时间戳必然不同，所以不会被误判成重复。
    //     若这个 id 出现过两个不同指纹，说明服务端存在 id 复用，计入 idCollision 报警。
    //   · 没有 id（极少见）：退回「谁 + 说了什么 + 时间戳」，TTL 15 秒。
    const bodyHash = shortHash(parsed.text);
    const fingerprint = parsed.rawTs ? `${parsed.messageId}:${parsed.rawTs}:${bodyHash}:${parsed.uid || 0}` : '';
    const dupKey = parsed.messageId
      ? `dmi:${parsed.rawTs ? fingerprint : `${parsed.messageId}:${bodyHash}:${parsed.uid || 0}`}`
      : `dmt:${parsed.uid || 0}:${bodyHash}:${parsed.rawTs}:${parsed.rawFlags}`;
    // 没有发送时间戳时只敢用短 TTL，免得把同一观众先后发的同样内容误杀
    const dupTtl = parsed.messageId ? (parsed.rawTs ? 300000 : 30000) : 15000;
    if (this._isDuplicate(dupKey, dupTtl)) {
      this.stats.duplicate += 1;
      // 把 id、发送时间戳、正文一起打出来：这样才能分辨「服务端重发」和「不同弹幕撞了同一个 id」
      this.log(
        'debug',
        `重复弹幕已忽略（累计 ${this.stats.duplicate} 条）：id=${parsed.messageId || '无'} ts=${parsed.rawTs || '无'} 用户=${parsed.user} 正文=${parsed.text}`
      );
      // 被丢掉的更要记下来——「漏了哪条」正是靠这个查的
      this._recordDanmaku({ ...parsed, duplicate: true, noId: !parsed.messageId });
      return;
    }
    if (parsed.messageId) {
      // 同一个 id 出现不同指纹 → 服务端 id 复用，单独统计出来（说明"只按 id 去重"会漏弹幕）
      const previous = this._seenText.get(parsed.messageId);
      if (previous && previous.fingerprint !== fingerprint) {
        this.stats.idCollision = (this.stats.idCollision || 0) + 1;
        this.log(
          'warn',
          `弹幕 id 复用（累计 ${this.stats.idCollision} 次）：id=${parsed.messageId} 上一条是「${previous.text}」，本条是「${parsed.text}」`
        );
      }
      this._seenText.set(parsed.messageId, { fingerprint, text: parsed.text, ts: Date.now() });
      // 只留最近 3 分钟见过的 id，避免长直播里无限增长
      if (this._seenText.size > 2000) {
        const cutoff = Date.now() - 180000;
        for (const [id, entry] of this._seenText) {
          if (entry.ts < cutoff) this._seenText.delete(id);
        }
      }
    }
    this.stats.danmaku += 1;
    this._recordDanmaku(parsed);
    this.emit(
      'danmaku',
      makeEvent('danmaku', {
        id: parsed.messageId || `${Date.now()}-${Math.random()}`,
        user: parsed.user,
        uid: parsed.uid,
        text: parsed.text,
        medal: parsed.medal,
        guardLevel: parsed.guardLevel,
        raw: data
      })
    );
  }

  /**
   * 把一条弹幕写进「弹幕记录」文件（如果开了）。
   * 记录本身绝不能影响收弹幕，所以这里把一切异常都吞掉。
   */
  _recordDanmaku(parsed) {
    if (!this.recorder || typeof this.recorder.record !== 'function') return;
    try {
      this.recorder.record({
        messageId: parsed.messageId || '',
        user: parsed.user || '',
        uid: parsed.uid || 0,
        text: parsed.text || '',
        duplicate: Boolean(parsed.duplicate),
        noId: Boolean(parsed.noId),
        unparsed: Boolean(parsed.unparsed),
        raw: parsed.raw || ''
      });
    } catch (error) {
      this.log('debug', `弹幕记录写入异常（已忽略）: ${error.message}`);
    }
  }

  /**
   * 每次连接只留一条「原始命令长什么样」的记录。
   *
   * 为什么需要它：用户说「我明明发了一条，软件没抓到」时，只有两种可能——
   *   1. 服务端没把这条推给我们（网络 / 风控 / 房间关键词过滤）
   *   2. 推来了，但程序没解析出来
   * 这两种情况在记录文件里都是「什么都没有」，光看记录分不清。
   * 有了这条原始命令，就能判断连接确实在收弹幕、以及报文的真实结构长什么样。
   * 只记第一条，避免把文件撑大。默认开，可用 options.recordRawCommands = false 关掉。
   */
  _recordRawCommand(info) {
    if (this._rawCommandLogged) return;
    if (!this.recorder || typeof this.recorder.record !== 'function') return;
    this._rawCommandLogged = true;
    try {
      this.recorder.record({
        messageId: '',
        user: '原始报文样张',
        uid: 0,
        text: JSON.stringify(info).slice(0, 400),
        raw: true,
        rawSample: true
      });
    } catch (_) {
      /* ignore */
    }
  }

  // 礼物（_onGift）/ 上舰（_onGuard）/ 醒目留言（_onSuperChat）/ 进场（_onInteract）
  // 2026-10-21 整块删掉：这条连接收不到那些命令，解析没有意义（见 _dispatch 里的说明）。
  // 当时每个解析器都带一份「去重键 + 金额换算 + 粉丝牌」，删掉之后少 85 行死代码。

  /**
   * 去重：只用来挡「同一条消息被服务端重复下发」。
   * 注意两个要点：
   *   1. 键里必须带消息唯一的 id，不能只用「谁说了什么」——观众重复发同样的话是正常的；
   *   2. TTL 要短（这里 15 秒），否则长时间直播里相似的消息会被误杀。
   */
  _isDuplicate(key, ttlMs = 15000) {
    if (!key || key.endsWith(':')) return false;
    const now = Date.now();
    const last = this._seen.get(key);
    if (last && now - last < ttlMs) return true;
    this._seen.set(key, now);
    if (this._seen.size > 800) {
      for (const [k, ts] of this._seen) {
        if (now - ts > ttlMs) this._seen.delete(k);
      }
    }
    return false;
  }

  // ---------- HTTP 部分 ----------

  async _fetchDanmuInfo() {
    await this._prepareCookies();
    const roomInit = await this._getJson(API.roomInit, { id: this.roomIdInput });
    if (roomInit.code !== 0) {
      throw new Error(`房间信息获取失败: code=${roomInit.code} ${roomInit.message || ''}`.trim());
    }
    const roomData = roomInit.data || {};
    this.realRoomId = toInt(roomData.room_id, toInt(this.roomIdInput, 0));
    this.uid = toInt(roomData.uid, 0);

    // 房间标题 / 分区 / 主播昵称：让 AI 知道自己在谁的直播间、播什么
    const detail = await this._fetchRoomDetail();
    this.roomInfo = {
      realRoomId: String(this.realRoomId),
      liveStatus: detail.liveStatus,
      title: detail.title,
      areaText: detail.areaText,
      anchorName: detail.anchorName,
      anchorUid: detail.anchorUid,
      online: detail.online,
      liveTime: toInt(roomData.live_time, 0)
    };
    this.emit('room', this.roomInfo);

    const mixinKey = await this._getMixinKey();
    const params = encodeWbi({ id: this.realRoomId, type: 0 }, mixinKey);
    const info = await this._getJson(API.danmuInfo, params);
    if (info.code !== 0) {
      if (info.code === -352) {
        throw new Error(
          'getDanmuInfo 被风控(-352)：请稍等几分钟重试，或在设置里填写浏览器 Cookie(SESSDATA) 后重连'
        );
      }
      if (info.code === -403) {
        throw new Error('getDanmuInfo 被拒绝(-403)：房间号可能不存在或未开播');
      }
      throw new Error(`获取弹幕服务器失败: code=${info.code} ${info.message || ''}`.trim());
    }
    const data = info.data || {};
    this.token = String(data.token || '');
    const hostList = Array.isArray(data.host_list) ? data.host_list : [];
    this.hosts = hostList
      .map((item) => ({
        host: String(item.host || ''),
        // 实测：wss_port(2245) 能通过认证但收不到消息流，必须走 443。
        // 443 握手、认证、推送弹幕都正常，所以优先用 443。
        wssPort: 443,
        wsPort: toInt(item.ws_port, 2244)
      }))
      .filter((item) => item.host);
    if (!this.hosts.length) throw new Error('弹幕服务器列表为空');
    // 保持官方返回的顺序（第一台最稳）。不要随机打散：
    // 频繁换服务器重连会被服务端判定为异常并直接断开。
    this.log('debug', `已获取 ${this.hosts.length} 个弹幕服务器，使用 ${this.hosts[0].host}`);
  }

  /** 房间标题 / 分区 / 主播昵称（拿不到也不影响收弹幕，所以全部容错） */
  async _fetchRoomDetail() {
    const detail = { liveStatus: 0, title: '', areaText: '', anchorName: '', anchorUid: 0, online: 0 };
    try {
      const info = await this._getJson(API.roomInfo, { room_id: this.realRoomId });
      if (info.code === 0 && info.data) {
        detail.title = String(info.data.title || '');
        detail.liveStatus = toInt(info.data.live_status, 0);
        detail.online = toInt(info.data.online, 0);
        const parent = String(info.data.parent_area_name || '');
        const area = String(info.data.area_name || '');
        detail.areaText = parent && area && parent !== area ? `${parent} / ${area}` : parent || area;
      }
    } catch (error) {
      this.log('debug', `房间标题获取失败: ${error.message}`);
    }
    try {
      const anchor = await this._getJson(API.anchorInfo, { roomid: this.realRoomId });
      const base = anchor.data && anchor.data.info ? anchor.data.info : anchor.data || {};
      if (base.uname) {
        detail.anchorName = String(base.uname);
        detail.anchorUid = toInt(base.uid, 0);
      }
    } catch (error) {
      this.log('debug', `主播昵称获取失败: ${error.message}`);
    }
    return detail;
  }

  async _prepareCookies() {
    this.cookies = {};
    // 优先使用完整的 Cookie 串（来自软件内登录，能看到观众昵称）
    if (this.cookieHeader) {
      this.cookies = parseCookieInput(this.cookieHeader);
    }
    if ((!this.cookies || !this.cookies.SESSDATA) && this.useCookie && this.sessdata) {
      this.cookies = parseCookieInput(this.sessdata);
    }
    if (!this.cookies) this.cookies = {};
    this.usingLogin = Boolean(this.cookies.SESSDATA);
    if (this.usingLogin) this.log('info', '将使用登录身份连接（可以看到观众昵称）');
    if (!this.cookies.buvid3) {
      // 官方文档：getDanmuInfo 从 2025-06-27 起要求 Cookie 中 buvid3 不为空。
      // 缺了它拿到的连接会处于受限状态（收不到弹幕等消息）。
      const fp = await this._fetchFingerprint();
      if (fp.buvid3) this.cookies.buvid3 = fp.buvid3;
      if (fp.buvid4 && !this.cookies.buvid4) this.cookies.buvid4 = fp.buvid4;
      if (fp.b_nut) this.cookies.b_nut = fp.b_nut;
      if (this.cookies.buvid3) this.log('debug', '已获取 buvid3（用于弹幕接口认证）');
      else this.log('warn', '未能获取 buvid3，弹幕连接可能受限');
    }
  }

  /** 设备指纹（buvid3/buvid4/b_nut），进程内缓存，context 变化时失效 */
  async _fetchFingerprint() {
    if (this._fpCached) return this._fpCached;
    try {
      const spi = await this._getJson(API.fingerprint, {});
      const data = spi.data || {};
      this._fpCached = {
        buvid3: data.b_3 ? String(data.b_3) : '',
        buvid4: data.b_4 ? String(data.b_4) : '',
        b_nut: data.b_nut ? String(data.b_nut) : String(Math.floor(Date.now() / 1000))
      };
    } catch (error) {
      this.log('debug', `获取 buvid 失败: ${error.message}`);
      this._fpCached = { buvid3: '', buvid4: '', b_nut: '' };
    }
    return this._fpCached;
  }

  async _getMixinKey() {
    if (this._wbiCache && Date.now() - this._wbiCache.ts < 3600000) return this._wbiCache.key;
    const nav = await this._getJson(API.nav, {});
    const wbi = (nav.data && nav.data.wbi_img) || {};
    const pick = (url) => String(url || '').split('/').pop().split('.')[0];
    const key = getMixinKey(pick(wbi.img_url), pick(wbi.sub_url));
    this._wbiCache = { key, ts: Date.now() };
    return key;
  }

  async _getJson(url, params) {
    // 注意：不要额外添加 `_` 时间戳之类的查询参数。
    // getDanmuInfo 的参数参与 WBI 签名校验，多一个参数就会返回 -352（风控）。
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      query.set(key, String(value));
    }
    const headers = { ...BASE_HEADERS };
    if (Object.keys(this.cookies).length) headers.Cookie = cookieHeader(this.cookies);
    if (this.uid) headers['X-Uid'] = String(this.uid);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(`${url}?${query.toString()}`, {
        headers,
        signal: controller.signal
      });
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (_) {
        throw new Error(`接口返回非 JSON（HTTP ${response.status}）`);
      }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error(`请求超时: ${url}`);
      throw new Error(`请求失败: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 读取最近的历史弹幕（用于测试/补漏，不需要 WebSocket） */
  async fetchHistory(limit = 20) {
    if (!this.realRoomId) {
      const roomInit = await this._getJson(API.roomInit, { id: this.roomIdInput });
      if (roomInit.code === 0) this.realRoomId = toInt((roomInit.data || {}).room_id, 0);
    }
    const result = await this._getJson(API.history, { roomid: this.realRoomId, room_type: 0 });
    if (result.code !== 0) throw new Error(`历史弹幕获取失败: code=${result.code}`);
    const rows = ((result.data || {}).room || []).slice(-limit);
    return rows.map((row) => ({
      user: String(row.nickname || '观众'),
      text: String(row.text || ''),
      ts: Date.parse(String(row.timeline || '').replace(' ', 'T')) || Date.now()
    }));
  }
}

module.exports = {
  BilibiliDanmakuClient,
  parseCookieInput,
  encodeWbi,
  getMixinKey,
  parseDanmakuInfo,
  cmdName
};
