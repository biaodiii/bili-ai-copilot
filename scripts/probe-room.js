'use strict';

/**
 * 临时诊断 9：在自己的直播间里同时用裸连接和内置客户端收包，
 * 并把 DANMU_MSG 的原始结构打印出来，用于校正解析。
 * 用法：node scripts/probe-room.js <房间号> [秒数]
 */

const zlib = require('zlib');
const { BilibiliDanmakuClient, encodeWbi, getMixinKey } = require('../src/main/danmaku');
const WS = require('ws');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const response = await fetch(`${url}?${qs}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Referer: 'https://live.bilibili.com/',
      Origin: 'https://live.bilibili.com'
    }
  });
  return response.json();
}

function parseBody(buffer, protover, onCmd) {
  if (protover === 3) return parseBody(zlib.brotliDecompressSync(buffer), 0, onCmd);
  if (protover === 2) return parseBody(zlib.inflateSync(buffer), 0, onCmd);
  const text = buffer.toString('utf8').replace(/\0+$/, '');
  if (!text) return;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    return;
  }
  onCmd(payload);
}

(async () => {
  const roomInput = process.argv[2];
  const seconds = Number(process.argv[3] || 45);
  const room = await get('https://api.live.bilibili.com/room/v1/Room/room_init', { id: roomInput });
  const realRoomId = room.data.room_id;
  console.log(`房间 ${roomInput} -> ${realRoomId}，直播状态 ${room.data.live_status}`);

  const history = await get('https://api.live.bilibili.com/xlive/web-room/v1/dM/gethistory', {
    roomid: realRoomId,
    room_type: 0
  });
  const rows = (history.data && history.data.room) || [];
  console.log(`服务端历史弹幕：${rows.length} 条`);
  rows.slice(-5).forEach((row) => console.log(`   [历史] ${row.nickname}: ${row.text} @ ${row.timeline}`));

  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  const pick = (url) => String(url).split('/').pop().split('.')[0];
  const mixinKey = getMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));
  const info = await get(
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
    encodeWbi({ id: realRoomId, type: 0 }, mixinKey)
  );
  const token = info.data.token;
  const host = info.data.host_list[0].host;
  console.log(`使用服务器 ${host}，token 长度 ${token.length}\n`);

  // ---------------- 裸连接 ----------------
  const raw = { op5: 0, cmds: {}, danmaku: [], samples: [] };
  const rawDone = new Promise((resolve) => {
    const ws = new WS(`wss://${host}:443/sub`, {
      headers: {
        'User-Agent': UA,
        Origin: 'https://live.bilibili.com',
        Referer: `https://live.bilibili.com/${realRoomId}`
      },
      perMessageDeflate: false
    });
    ws.on('open', () => {
      const body = Buffer.from(
        JSON.stringify({ uid: 0, roomid: realRoomId, protover: 3, platform: 'web', type: 2, key: token })
      );
      const header = Buffer.alloc(16);
      header.writeUInt32BE(16 + body.length, 0);
      header.writeUInt16BE(16, 4);
      header.writeUInt16BE(1, 6);
      header.writeUInt32BE(7, 8);
      header.writeUInt32BE(1, 12);
      ws.send(Buffer.concat([header, body]));
      // 心跳
      const beat = setInterval(() => {
        const hb = Buffer.alloc(16);
        hb.writeUInt32BE(16, 0);
        hb.writeUInt16BE(16, 4);
        hb.writeUInt16BE(1, 6);
        hb.writeUInt32BE(2, 8);
        hb.writeUInt32BE(1, 12);
        try {
          ws.send(hb);
        } catch (_) {
          /* ignore */
        }
      }, 25000);
      ws.on('close', () => clearInterval(beat));
    });
    ws.on('message', (data) => {
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let offset = 0;
      while (offset + 16 <= buffer.length) {
        const packetLen = buffer.readUInt32BE(offset);
        const headerLen = buffer.readUInt16BE(offset + 4);
        const protover = buffer.readUInt16BE(offset + 6);
        const operation = buffer.readUInt32BE(offset + 8);
        if (packetLen < 16 || offset + packetLen > buffer.length) break;
        const body = buffer.subarray(offset + headerLen, offset + packetLen);
        offset += packetLen;
        if (operation !== 5) continue;
        raw.op5 += 1;
        try {
          parseBody(body, protover, (payload) => {
            const cmd = String(payload.cmd || '').split(':')[0];
            raw.cmds[cmd] = (raw.cmds[cmd] || 0) + 1;
            if (cmd === 'DANMU_MSG') {
              raw.danmaku.push(payload);
              if (raw.samples.length < 2) {
                raw.samples.push(payload);
                console.log(`[裸连接] 收到 DANMU_MSG，原始结构：`);
                console.log(JSON.stringify(payload).slice(0, 1400));
                console.log('');
              }
            }
          });
        } catch (error) {
          raw.cmds[`解包错误:${error.message}`] = 1;
        }
      }
    });
    ws.on('error', (error) => console.log('[裸连接] 错误:', error.message));
    setTimeout(() => {
      try {
        ws.terminate();
      } catch (_) {
        /* ignore */
      }
      resolve();
    }, seconds * 1000);
  });

  // ---------------- 内置客户端 ----------------
  const clientStat = { danmaku: 0, op5: 0, cmds: {} };
  const client = new BilibiliDanmakuClient({
    roomId: realRoomId,
    logger: {
      debug: (m) => console.log('  [client]', m),
      info: (m) => console.log('  [client]', m),
      warn: (m) => console.log('  [client]', m),
      error: (m) => console.log('  [client]', m)
    }
  });
  client.on('danmaku', (event) => {
    clientStat.danmaku += 1;
    console.log(`  [client 弹幕 #${clientStat.danmaku}] ${event.user}: ${event.text}`);
  });
  client.on('raw', (payload) => {
    const cmd = String(payload.cmd || '').split(':')[0];
    clientStat.cmds[cmd] = (clientStat.cmds[cmd] || 0) + 1;
  });
  const original = client._handlePacket.bind(client);
  client._handlePacket = function patched(buffer, depth = 0) {
    let offset = 0;
    while (offset + 16 <= buffer.length) {
      const packetLen = buffer.readUInt32BE(offset);
      const operation = buffer.readUInt32BE(offset + 8);
      if (packetLen < 16 || offset + packetLen > buffer.length) break;
      offset += packetLen;
      if (operation === 5) clientStat.op5 += 1;
    }
    return original(buffer, depth);
  };

  await client.start();
  console.log(`\n开始监听 ${seconds} 秒…\n`);
  await rawDone;
  await client.stop();

  console.log(`\n裸连接:     op5 包=${raw.op5} 弹幕=${raw.danmaku.length} 命令=${JSON.stringify(raw.cmds)}`);
  console.log(`内置客户端: op5 包=${clientStat.op5} 弹幕=${clientStat.danmaku} 其他=${JSON.stringify(clientStat.cmds)}`);
  process.exit(0);
})();
