'use strict';

/**
 * 真实弹幕捕获：连上指定直播间，把收到的一切打印出来
 * 用法：node scripts/capture.js <房间号> [秒数]
 */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { BilibiliDanmakuClient, encodeWbi, getMixinKey } = require('../src/main/danmaku');

// 用法：
//   node scripts/capture.js <房间号> [秒数] [--cookie] [--sessdata=xxxx]
//   --cookie          读取 data/settings.json 里的 danmaku.sessdata
//   --sessdata=xxxx   直接用命令行传入的 SESSDATA（方便快速做登录态对比测试）
const USE_COOKIE = process.argv.includes('--cookie');
const SESSDATA_ARG = (process.argv.find((item) => item.startsWith('--sessdata=')) || '').split('=')[1] || '';
let SETTINGS = {};
try {
  SETTINGS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'settings.json'), 'utf8'));
} catch (_) {
  SETTINGS = {};
}
const SESSDATA = SESSDATA_ARG || (SETTINGS.account && SETTINGS.account.sessdata) ||
  (SETTINGS.danmaku && SETTINGS.danmaku.sessdata) || '';
const USE_LOGIN = USE_COOKIE || Boolean(SESSDATA_ARG) || Boolean(SETTINGS.account && SETTINGS.account.loggedIn);

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

function stamp() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
    d.getSeconds()
  ).padStart(2, '0')}`;
}

(async () => {
  const roomInput = process.argv[2];
  const seconds = Number(process.argv[3] || 60);
  if (!roomInput) {
    console.log('用法: node scripts/capture.js <房间号> [秒数]');
    process.exit(1);
  }

  const room = await get('https://api.live.bilibili.com/room/v1/Room/room_init', { id: roomInput });
  if (room.code !== 0) {
    console.log(`房间信息获取失败: code=${room.code} ${room.message || ''}`);
    process.exit(1);
  }
  const realRoomId = room.data.room_id;
  console.log(
    `${stamp()} 房间 ${roomInput} -> 真实房间号 ${realRoomId}，直播状态 ${room.data.live_status}（1=直播中）`
  );

  const nav = await get('https://api.bilibili.com/x/web-interface/nav');
  const pick = (url) => String(url).split('/').pop().split('.')[0];
  const mixinKey = getMixinKey(pick(nav.data.wbi_img.img_url), pick(nav.data.wbi_img.sub_url));
  const info = await get(
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
    encodeWbi({ id: realRoomId, type: 0 }, mixinKey)
  );
  if (info.code !== 0) {
    console.log(`getDanmuInfo 失败 code=${info.code} ${info.message || ''}`);
    process.exit(1);
  }

  const client = new BilibiliDanmakuClient({
    roomId: realRoomId,
    sessdata: SESSDATA,
    useCookie: USE_LOGIN && Boolean(SESSDATA),
    logger: {
      debug: (m) => console.log(`${stamp()} · ${m}`),
      info: (m) => console.log(`${stamp()} ✓ ${m}`),
      warn: (m) => console.log(`${stamp()} ! ${m}`),
      error: (m) => console.log(`${stamp()} ✗ ${m}`)
    }
  });
  console.log(
    `${stamp()} 连接身份：${USE_LOGIN && SESSDATA ? `已登录（Cookie 长度 ${SESSDATA.length}）` : '游客（未登录）'}`
  );

  const seen = { danmaku: 0, other: 0 };
  const rawSamples = [];
  client.on('danmaku', (event) => {
    seen.danmaku += 1;
    console.log(`${stamp()} 【弹幕 #${seen.danmaku}】${event.user}（uid ${event.uid}）：${event.text}`);
    if (rawSamples.length < 3) {
      rawSamples.push(event.raw);
      const info = (event.raw && event.raw.info) || [];
      console.log(
        `${stamp()}   └ 原始字段：info[2]=${JSON.stringify(info[2])} info[3]=${JSON.stringify(info[3])}`
      );
      console.log(`${stamp()}   └ info[0][15]=${JSON.stringify((info[0] || [])[15])}`);
    }
  });
  // 礼物 / 上舰 / 醒目留言 / 进场：2026-10-21 删了（这条连接收不到那些命令，解析也删了）。
  // 真收到的话会在下面的「未识别命令」里打出来，那时候再按真实报文补解析。
  client.on('popularity', (value) => console.log(`${stamp()} 【人气】${value}`));

  // 把无法识别的新协议消息也统计出来，便于按真实数据修正解析
  const unknown = {};
  client.on('raw', (payload) => {
    const cmd = String(payload.cmd || '');
    const dataType = typeof payload.data;
    const key = `${cmd}(${dataType})`;
    unknown[key] = (unknown[key] || 0) + 1;
    seen.other += 1;
    if (unknown[key] === 1) {
      const sample = JSON.stringify(payload).slice(0, 400);
      console.log(`${stamp()} 【未处理的消息】${key} 首次样本: ${sample}`);
    }
  });

  // 把内层压缩包解开后也统计一次命令，验证 brotli 解包
  const cmdCount = {};
  const original = client._dispatch.bind(client);
  client._dispatch = function patched(payload) {
    const cmd = String((payload && payload.cmd) || '').split(':')[0];
    cmdCount[cmd] = (cmdCount[cmd] || 0) + 1;
    // 弹幕结构变化排查用：把原始 DANMU_MSG 打印出来
    if (cmd === 'DANMU_MSG' && rawSamples.length < 3) {
      rawSamples.push(payload);
      console.log(`${stamp()} 【DANMU_MSG 原始结构 #${rawSamples.length}】`);
      console.log(JSON.stringify(payload).slice(0, 2000));
      console.log('');
    }
    return original(payload);
  };

  await client.start();
  console.log(`${stamp()} 已开始监听 ${seconds} 秒，请在直播间发几条弹幕…\n`);

  const ticker = setInterval(() => {
    console.log(`${stamp()} … 仍在监听（已收到弹幕 ${seen.danmaku} 条）`);
  }, 15000);

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(ticker);
  await client.stop();

  console.log(`\n${stamp()} 结束统计：弹幕 ${seen.danmaku} 条，其他事件 ${seen.other} 条`);
  console.log(`${stamp()} 命令统计：${JSON.stringify(cmdCount)}`);
  console.log(`${stamp()} 未处理消息统计：${JSON.stringify(unknown)}`);
  process.exit(0);
})();
