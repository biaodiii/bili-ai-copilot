'use strict';

/**
 * 命令行自检：不打开界面，直接验证 B 站弹幕链路和 DeepSeek Key 是否可用
 * 用法：
 *   node scripts/selfcheck.js                只测弹幕（房间号取自 data/settings.json）
 *   node scripts/selfcheck.js 1234567        指定房间号测弹幕
 *   node scripts/selfcheck.js --llm         额外测试 DeepSeek 连接
 */

const fs = require('fs');
const path = require('path');

const { BilibiliDanmakuClient } = require('../src/main/danmaku');
const { DeepSeekClient } = require('../src/main/llm');

const dataFile = path.join(__dirname, '..', 'data', 'settings.json');
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
} catch (_) {
  settings = {};
}

const logger = {
  debug: (msg) => console.log('  ·', msg),
  info: (msg) => console.log('  ✓', msg),
  warn: (msg) => console.log('  !', msg),
  error: (msg) => console.log('  ✗', msg)
};

async function testDanmaku(roomId) {
  console.log(`\n[1/2] 测试弹幕链路，房间号 = ${roomId}`);
  const client = new BilibiliDanmakuClient({
    roomId,
    sessdata: settings.danmaku ? settings.danmaku.sessdata : '',
    useCookie: settings.danmaku ? settings.danmaku.useCookie : false,
    logger
  });

  await client._prepareCookies();
  const roomInit = await client._getJson('https://api.live.bilibili.com/room/v1/Room/room_init', {
    id: roomId
  });
  if (roomInit.code !== 0) throw new Error(`room_init 失败 code=${roomInit.code}`);
  client.realRoomId = roomInit.data.room_id;

  const mixinKey = await client._getMixinKey();
  const { encodeWbi } = require('../src/main/danmaku');
  const info = await client._getJson(
    'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo',
    encodeWbi({ id: client.realRoomId, type: 0 }, mixinKey)
  );
  console.log(`  ✓ 真实房间号 ${client.realRoomId}，开播状态 ${roomInit.data.live_status}`);
  if (info.code !== 0) {
    console.log(`  ✗ getDanmuInfo 失败: code=${info.code} ${info.message || ''}`);
    return false;
  }
  console.log(`  ✓ 拿到 ${(info.data.host_list || []).length} 台弹幕服务器，token ${info.data.token ? '有' : '无'}`);

  const history = await client.fetchHistory(3).catch((error) => {
    console.log(`  ! 历史弹幕读取失败: ${error.message}`);
    return [];
  });
  console.log(`  ✓ 最近历史弹幕 ${history.length} 条`);
  for (const item of history) console.log(`      ${item.user}: ${item.text}`);

  // 真连一次 WebSocket，等 8 秒看看有没有数据包
  console.log('  · 尝试真实连接 8 秒（未开播时可能没有弹幕，能连上即算成功）…');
  const events = [];
  client.on('danmaku', (event) => {
    events.push(event);
    console.log(`      [弹幕] ${event.user}: ${event.text}`);
  });
  client.on('popularity', (value) => console.log(`      [人气] ${value}`));
  await client.start();
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const connected = client.connected;
  await client.stop();
  console.log(`  ${connected ? '✓' : '✗'} WebSocket ${connected ? '认证成功' : '未认证成功'}，收到 ${events.length} 条弹幕`);
  return connected;
}

async function testLlm() {
  console.log('\n[2/2] 测试 DeepSeek 连接');
  const api = settings.api || {};
  if (!api.apiKey) {
    console.log('  ! 没填 API Key，跳过（在控制面板里填好后再测）');
    return false;
  }
  const client = new DeepSeekClient(() => api, logger);
  const result = await client.test();
  console.log(`  ✓ 连接成功：${result.reply}（${result.latencyMs}ms，模型 ${result.model}）`);
  return true;
}

(async () => {
  const args = process.argv.slice(2);
  const wantLlm = args.includes('--llm');
  const roomId = args.find((item) => /^\d+$/.test(item)) || (settings.danmaku && settings.danmaku.roomId);

  if (!roomId) {
    console.log('请给出房间号：node scripts/selfcheck.js 1234567');
  } else {
    await testDanmaku(roomId).catch((error) => console.log(`  ✗ 弹幕测试失败: ${error.message}`));
  }
  if (wantLlm) {
    await testLlm().catch((error) => console.log(`  ✗ DeepSeek 测试失败: ${error.message}`));
  } else if (settings.api && settings.api.apiKey) {
    await testLlm().catch((error) => console.log(`  ✗ DeepSeek 测试失败: ${error.message}`));
  }
  console.log('\n自检结束。');
  process.exit(0);
})();
