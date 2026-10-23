'use strict';

/**
 * 弹幕链路端到端测试（不联网）：
 * 用真实抓包报文验证「数据包 → 事件」这条链路，
 * 专门防止曾经出现过的 bug：DANMU_MSG 的正文在命令根对象上，
 * 被误当成 payload.data 读取导致弹幕被静默丢弃。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BilibiliDanmakuClient } = require('../src/main/danmaku');
const { DanmakuRecorder } = require('../src/main/danmaku-log');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

function makeClient() {
  return new BilibiliDanmakuClient({
    roomId: 1234567,
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
}

/** 真实抓包报文（未登录状态，昵称被打码，uid=0）；seed 用来生成不同的消息 id */
function realDanmaku(text, name, seed = 1) {
  return {
    cmd: 'DANMU_MSG',
    dm_v2: '',
    info: [
      [
        // info[0][5] 是这条消息的唯一 id（不同消息必须不同，否则会被当成重复）
        0, 1, 25, 16777215, 1791561665953, 1791561665597 + seed, 0, '26187a4d', 0, 0, 0, '', 0, '{}', '{}',
        {
          extra: JSON.stringify({ content: text }),
          mode: 0,
          show_player_type: 0,
          user: {
            base: { face: 'https://i1.hdslb.com/bfs/face/x.jpg', is_mystery: false, name },
            uid: 0,
            wealth: { level: 9 }
          }
        },
        { activity_identity: '', activity_source: 0, not_show: 0 },
        0
      ],
      text,
      [0, name, 0, 0, 0, 10000, 1, ''],
      [],
      [0, 0, 9868950, '>50000', 0],
      ['', ''],
      0, 0, null,
      { ts: 1791561665, ct: '113C4255' },
      0, 0, null, null, 0, 7
    ]
  };
}

console.log('弹幕链路（真实报文）');

test('DANMU_MSG 能解析出用户名和内容', () => {
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  client._dispatch(realDanmaku('测试', '牢***'));
  assert.strictEqual(events.length, 1, '应该产生 1 个弹幕事件');
  assert.strictEqual(events[0].text, '测试');
  assert.strictEqual(events[0].user, '牢***');
  assert.strictEqual(events[0].uid, 0);
});

test('带冒号后缀的 cmd 也能识别（DANMU_MSG:4:0:2:2:2:0）', () => {
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  const payload = realDanmaku('带后缀', '小明');
  payload.cmd = 'DANMU_MSG:4:0:2:2:2:0';
  client._dispatch(payload);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].text, '带后缀');
});

test('同一条消息重复下发会被去重', () => {
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  const payload = realDanmaku('重复', '小明');
  client._dispatch(payload);
  client._dispatch(payload);
  assert.strictEqual(events.length, 1, '同一条消息（同 id）应该只抛一次');
  assert.strictEqual(client.stats.duplicate, 1, '应该记一次重复统计');
});

test('观众连发两条同样的弹幕，都要能收到（回归测试）', () => {
  // 真实踩过的 bug：去重键是「谁说了什么」，观众刷同样的话会被误杀。
  // 现在键里带消息 id，两条不同的消息都能通过。
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  client._dispatch(realDanmaku('哈哈', '小明', 1));
  client._dispatch(realDanmaku('哈哈', '小明', 2));
  assert.strictEqual(events.length, 2, `连发两条相同弹幕应该都收到，实际 ${events.length} 条`);
  assert.strictEqual(client.stats.danmaku, 2);
  assert.strictEqual(client.stats.duplicate, 0, '这是两条不同的消息，不该算重复');
});

test('统计能反映「收到 / 解析失败 / 重复」', () => {
  const client = makeClient();
  client.on('danmaku', () => {});
  client._dispatch(realDanmaku('正常', '甲', 1));
  client._dispatch({ cmd: 'DANMU_MSG', info: [] }); // 结构不认识
  client._dispatch(realDanmaku('重复', '乙', 2));
  client._dispatch(realDanmaku('重复', '乙', 2));
  assert.strictEqual(client.stats.danmaku, 2, `应解析出 2 条，实际 ${client.stats.danmaku}`);
  assert.strictEqual(client.stats.unparsed, 1, `应记录 1 条解析失败，实际 ${client.stats.unparsed}`);
  assert.strictEqual(client.stats.duplicate, 1, `应记录 1 条重复，实际 ${client.stats.duplicate}`);
  // 统计要能通过 status() 取到（面板靠它显示）
  const status = client.status();
  assert.ok(status.stats && typeof status.stats.danmaku === 'number', 'status 里应该带统计');
});

test('info[0][5] 缺失时也不能吞弹幕（回归测试）', () => {
  // 真实踩过的 bug：缺 id 时兜底用 info[0][0]，而它恒为 0，
  // 于是所有弹幕共用同一个 id，15 秒内从第二条起全被当成重复丢掉。
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  for (let index = 0; index < 5; index += 1) {
    const payload = realDanmaku(`第${index}条`, '小明', index + 1);
    payload.info[0][5] = 0; // 服务端没给 id
    payload.info[0][4] = 1791561665900 + index * 1000; // 各条时间戳不同
    client._dispatch(payload);
  }
  assert.strictEqual(events.length, 5, `5 条不同弹幕都该收到，实际 ${events.length} 条`);
  assert.strictEqual(client.stats.duplicate, 0, '不该有任何一条被误判为重复');
});

test('同一条无 id 弹幕重复下发仍然会被去重', () => {
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  const payload = realDanmaku('重复且无 id', '小明');
  payload.info[0][5] = 0;
  payload.info[0][4] = 1791561665900;
  client._dispatch(payload);
  client._dispatch(payload);
  assert.strictEqual(events.length, 1, '内容与时间戳完全一致才判为重复');
  assert.strictEqual(client.stats.duplicate, 1);
});

test('uid=0（未登录）时不同观众的弹幕互不影响', () => {
  // 未登录状态下服务端下发的 uid 全是 0，去重键绝不能只靠 uid
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  client._dispatch(realDanmaku('一', '牢***', 1));
  client._dispatch(realDanmaku('二', '牢***', 2));
  client._dispatch(realDanmaku('三', '牢***', 3));
  assert.strictEqual(events.length, 3, `uid 都是 0 也要都收到，实际 ${events.length} 条`);
  assert.deepStrictEqual(events.map((item) => item.uid), [0, 0, 0]);
});

test('同一个 id 但正文/时间戳不同，必须都放过（真实日志复刻）', () => {
  // 真实日志里 5 分钟内出现过同一个 id=1791620118 共 10 次。
  // 若只按 id 去重，这些都算「重复」被丢掉 → 表现就是「有时候弹幕不显示」。
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  const texts = ['这', '是', '十', '条', '不', '同', '的', '弹', '幕', '了'];
  texts.forEach((text, index) => {
    const payload = realDanmaku(text, '菲尼尔', 7);
    payload.info[0][5] = 1791620118; // 服务端复用同一个 id
    payload.info[0][4] = 1791561665900 + index * 1000; // 发送时间戳各不相同
    client._dispatch(payload);
  });
  assert.strictEqual(events.length, 10, `10 条不同弹幕都该放过，实际只放过 ${events.length} 条`);
  assert.strictEqual(client.stats.duplicate, 0, '不该有任何一条被当成重复');
  assert.strictEqual(client.stats.idCollision, 9, `应记录 9 次 id 复用，实际 ${client.stats.idCollision}`);
});

test('同一个 id 且时间戳正文全同，才算重发被去重', () => {
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  const payload = realDanmaku('服务端重发', '菲尼尔');
  payload.info[0][5] = 1791620118;
  client._dispatch(payload);
  client._dispatch(payload);
  client._dispatch(payload);
  assert.strictEqual(events.length, 1, '完全是同一条，只该放过一次');
  assert.strictEqual(client.stats.duplicate, 2);
  assert.strictEqual(client.stats.idCollision, 0, '指纹相同不算 id 复用');
});

test('观众先后发两条完全相同的话，不能被误判为重复', () => {
  // 发送时间戳不同 → 指纹不同 → 都放过（只按 id 去重的写法在这里会漏掉第二条）
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  const first = realDanmaku('哈哈', '小明');
  first.info[0][5] = 1791620118;
  first.info[0][4] = 1791561665900;
  const second = realDanmaku('哈哈', '小明');
  second.info[0][5] = 1791620118;
  second.info[0][4] = 1791561667000; // 过了 1100ms 又发了一条一样的
  client._dispatch(first);
  client._dispatch(second);
  assert.strictEqual(events.length, 2, `两条都该放过，实际 ${events.length} 条`);
});

test('所有收到和丢掉的弹幕都进了记录文件（端到端）', () => {
  // 「有的弹幕没显示」这类问题只能靠这个文件事后对照，所以链路必须真的通到文件
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-e2e-'));
  const recorder = new DanmakuRecorder({ dir, config: { enabled: true } });
  const client = new BilibiliDanmakuClient({
    roomId: 1234567,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    recorder
  });
  const events = [];
  client.on('danmaku', (event) => events.push(event));

  // 1 条正常 + 1 条同 id 重发 + 1 条解析失败
  const good = realDanmaku('正常弹幕', '菲尼尔', 3);
  client._dispatch(good);
  client._dispatch(good);
  client._dispatch({ cmd: 'DANMU_MSG', info: [] });

  assert.strictEqual(events.length, 1, '只有第一条该被抛出去');
  const lines = fs
    .readFileSync(recorder.filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  // 第 1 行是「原始报文样张」：用来证明连接确实在收弹幕，
  // 把「弹幕没到程序」和「到了但没解析出来」区分开（见 _recordRawCommand）
  assert.strictEqual(lines.length, 4, `样张 + 三条都要落盘，实际 ${lines.length} 条：\n${lines.join('\n')}`);
  assert.ok(lines[0].includes('[原始报文]'), `第 1 行应该是原始报文样张：${lines[0]}`);
  assert.ok(lines[0].includes('正常弹幕'), `样张里应该能看到真实报文字段：${lines[0]}`);
  assert.ok(lines[1].includes('正常弹幕') && lines[1].includes('[正常]'), `第 2 行：${lines[1]}`);
  assert.ok(lines[2].includes('[重复·同id]'), `第 3 行：${lines[2]}`);
  assert.ok(lines[3].includes('[解析失败]'), `第 4 行：${lines[3]}`);

  // 样张每次连接只写一条，不能每来一条弹幕就写一次
  client._dispatch(realDanmaku('又来一条', '菲尼尔', 4));
  const after = fs
    .readFileSync(recorder.filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  const samples = after.filter((line) => line.includes('[原始报文]'));
  assert.strictEqual(samples.length, 1, `样张应该只写一条，实际 ${samples.length} 条`);
});

test('结构异常的弹幕不会抛错', () => {
  const client = makeClient();
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  client._dispatch({ cmd: 'DANMU_MSG', info: [] });
  client._dispatch({ cmd: 'DANMU_MSG' });
  client._dispatch({ cmd: 'DANMU_MSG', info: [1, 2, 3] });
  assert.strictEqual(events.length, 0);
});

test('礼物 / 上舰 / 醒目留言 / 进场：不再产出事件，也不会崩（这条连接收不到）', () => {
  // 2026-10-21 主播同意删掉：实测这条连接收不到 SEND_GIFT / GUARD_BUY / SUPER_CHAT / INTERACT_WORD，
  // 解析分支永远不会触发。现在这些命令统一落到 default → 只 emit raw。
  const client = makeClient();
  const kinds = [];
  for (const kind of ['gift', 'guard', 'superchat', 'superchat-delete', 'enter']) {
    client.on(kind, () => kinds.push(kind));
  }
  const raws = [];
  client.on('raw', (payload) => raws.push(payload && payload.cmd));
  client._dispatch({ cmd: 'SEND_GIFT' });
  client._dispatch({ cmd: 'GUARD_BUY' });
  client._dispatch({ cmd: 'SUPER_CHAT_MESSAGE', data: { id: 1, message: '醒目留言' } });
  client._dispatch({ cmd: 'SUPER_CHAT_MESSAGE_DELETE', data: { message_id: 1 } });
  client._dispatch({ cmd: 'INTERACT_WORD', data: { uid: 1, uname: '路人甲' } });
  client._dispatch({
    cmd: 'INTERACT_WORD_V2',
    data: { dmscore: 4, pb: 'EgboirEqKioiAQEoATD9+NviBjien6TWBkCOg5SLkjRiAHjHt9W88/m57hiaAQCyAV0=' }
  });
  assert.deepStrictEqual(kinds, [], '删掉的功能不许再产出事件');
  assert.deepStrictEqual(raws, [
    'SEND_GIFT',
    'GUARD_BUY',
    'SUPER_CHAT_MESSAGE',
    'SUPER_CHAT_MESSAGE_DELETE',
    'INTERACT_WORD',
    'INTERACT_WORD_V2'
  ], '要老老实实当未识别命令交给 raw（方便探针脚本看真实报文）');
  // 没有 data 字段也不许崩（以前 SEND_GIFT 少 data 会走到解析里炸）
  client._dispatch({ cmd: 'SEND_GIFT' });
  client._dispatch({ cmd: 'WATCHED_CHANGE' });
});

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
