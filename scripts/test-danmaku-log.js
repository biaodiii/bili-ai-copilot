'use strict';

/**
 * 弹幕记录器测试（不联网、不碰真实 data 目录，全部在临时目录里跑）：
 * 验证「收到的每条弹幕都落盘」「被去重丢掉的也落盘」「按格式能直接读」
 * 「文件超限会归档且有份数上限」「磁盘写不进去也不能影响收弹幕」。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DanmakuRecorder } = require('../src/main/danmaku-log');
const { defaultDanmakuLogDir } = require('../src/main/settings');

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

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dm-log-test-'));
}

function makeRecorder(config, dir) {
  return new DanmakuRecorder({ dir: dir || tempDir(), config });
}

function readLines(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

console.log('弹幕记录器');

test('默认关闭，开启后才写文件', () => {
  const recorder = makeRecorder({ enabled: false });
  const result = recorder.record({ messageId: '1', user: '甲', text: '你好' });
  assert.strictEqual(result.written, false);
  assert.strictEqual(fs.existsSync(recorder.filePath), false, '关闭时不该创建文件');
  assert.strictEqual(recorder.status().enabled, false);
});

test('开启后每条弹幕一行，id / 昵称 / 正文 / 处理结果都在', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true }, dir);
  recorder.record({ messageId: '1791620118', user: '菲尼尔', text: '今天天气不错' });
  const lines = readLines(recorder.filePath);
  assert.strictEqual(lines.length, 1, `应该有 1 行，实际 ${lines.length} 行`);
  assert.ok(lines[0].includes('1791620118'), '要包含弹幕 id');
  assert.ok(lines[0].includes('菲尼尔'), '要包含昵称');
  assert.ok(lines[0].includes('今天天气不错'), '要包含正文');
  assert.ok(lines[0].includes('[正常]'), '要标注处理结果');
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s/, '要以可读时间开头');
});

test('被去重丢掉的弹幕也要落盘（这是排查漏弹幕的关键）', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true }, dir);
  recorder.record({ messageId: '1791620118', user: '菲尼尔', text: '同一条', duplicate: true });
  recorder.record({ messageId: '', user: '小明', text: '没id的重复', duplicate: true, noId: true });
  const lines = readLines(recorder.filePath);
  assert.strictEqual(lines.length, 2);
  assert.ok(lines[0].includes('[重复·同id]'), `实际：${lines[0]}`);
  assert.ok(lines[1].includes('[重复·无id]'), `实际：${lines[1]}`);
  assert.ok(lines[1].includes('(无id)'), '没有 id 时要标出来');
});

test('解析失败的报文也会记录，并留下报文摘要', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true }, dir);
  recorder.record({ unparsed: true, raw: '{"cmd":"DANMU_MSG","info":[]}' });
  const lines = readLines(recorder.filePath);
  assert.strictEqual(lines.length, 1);
  assert.ok(lines[0].includes('[解析失败]'), `实际：${lines[0]}`);
  assert.ok(lines[0].includes('DANMU_MSG'), '要留下报文摘要');
});

test('正文里的换行不会破坏「一行一条」', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true }, dir);
  recorder.record({ messageId: '1', user: '甲', text: '第一行\n第二行\t带制表符' });
  const lines = readLines(recorder.filePath);
  assert.strictEqual(lines.length, 1, '换行必须被压掉，否则一条弹幕会占好几行');
  assert.ok(lines[0].includes('第一行 第二行 带制表符'));
});

test('超长正文按配置截断，并计数', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true, maxTextLength: 20 }, dir);
  recorder.record({ messageId: '1', user: '甲', text: '字'.repeat(200) });
  const lines = readLines(recorder.filePath);
  assert.ok(lines[0].includes('…'), '截断要有省略号标记');
  assert.strictEqual(recorder.status().stats.truncated, 1);
});

test('文件写满上限会归档，归档份数有上限', () => {
  const dir = tempDir();
  // 上限设成 0.1MB（配置下限），写够 200KB 就会触发至少一次轮转
  const recorder = makeRecorder({ enabled: true, maxFileMB: 0.1, keepFiles: 2 }, dir);
  const payload = '填'.repeat(300);
  for (let index = 0; index < 1200; index += 1) {
    recorder.record({ messageId: String(index), user: '甲', text: payload });
  }
  const status = recorder.status();
  assert.ok(status.stats.rotations >= 1, `应该至少归档 1 次，实际 ${status.stats.rotations} 次`);
  const archived = fs.readdirSync(recorder.dirPath).filter((name) => name.startsWith('danmaku.log.'));
  assert.ok(archived.length <= 2, `归档最多留 2 份，实际 ${archived.length} 份: ${archived.join(',')}`);
  assert.ok(archived.length >= 1, '应该存在归档文件');
});

test('配置里的非法数值会被夹到安全范围', () => {
  const recorder = makeRecorder({ enabled: true, maxFileMB: 0, keepFiles: -5, maxTextLength: 1 });
  const config = recorder.configure({});
  assert.ok(config.maxFileMB >= 0.1, `maxFileMB 不能是 0，实际 ${config.maxFileMB}`);
  assert.ok(config.keepFiles >= 1, `keepFiles 不能是负数，实际 ${config.keepFiles}`);
  assert.ok(config.maxTextLength >= 20, `maxTextLength 太小，实际 ${config.maxTextLength}`);
});

test('目录不可写时只计数、不抛错（不能因为记日志而丢弹幕）', () => {
  // 用一个「父路径是文件」的目录，制造创建目录必然失败的情况
  const base = tempDir();
  const blocker = path.join(base, 'blocked');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');
  const recorder = new DanmakuRecorder({ dir: blocker, logger: silentLogger, config: { enabled: true } });
  const result = recorder.record({ messageId: '1', user: '甲', text: '会写失败' });
  assert.strictEqual(result.written, false, '应该报告写入失败');
  assert.ok(recorder.status().stats.failed >= 1, '失败要计数');
  assert.ok(recorder.status().lastError, '要保留最后一次错误原因');
});

test('运行中开关立即生效，无需重建实例', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: false }, dir);
  recorder.record({ messageId: '1', user: '甲', text: '关着的时候' });
  recorder.configure({ enabled: true });
  recorder.record({ messageId: '2', user: '甲', text: '开着的时候' });
  recorder.configure({ enabled: false });
  recorder.record({ messageId: '3', user: '甲', text: '又关了' });
  const lines = readLines(recorder.filePath);
  assert.strictEqual(lines.length, 1, `只该记下中间那条，实际 ${lines.length} 条`);
  assert.ok(lines[0].includes('开着的时候'));
});

test('status() 能给出面板需要的全部字段', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true }, dir);
  recorder.record({ messageId: '1', user: '甲', text: '你好' });
  const status = recorder.status();
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.file, recorder.filePath);
  assert.ok(status.fileSize > 0, '要能报出文件大小');
  assert.strictEqual(status.stats.lines, 1);
  assert.ok(status.lastWriteAt > 0, '要记录最后写入时间');
  assert.strictEqual(status.maxFileMB, 2, '默认 2MB');
});

test('configure 里的 dir 能改存放位置，并立刻换目录', () => {
  const first = tempDir();
  const second = tempDir();
  const recorder = makeRecorder({ enabled: true, dir: first });
  recorder.record({ messageId: '1', user: '甲', text: '写在第一个目录' });
  assert.strictEqual(recorder.filePath, path.join(first, 'danmaku', 'danmaku.log'));

  recorder.configure({ dir: second });
  assert.strictEqual(recorder.filePath, path.join(second, 'danmaku', 'danmaku.log'), '换目录后路径要跟着变');
  recorder.record({ messageId: '2', user: '甲', text: '写在第二个目录' });

  const oldLines = readLines(path.join(first, 'danmaku', 'danmaku.log'));
  const newLines = readLines(recorder.filePath);
  assert.strictEqual(oldLines.length, 1, '旧目录里应该只有换之前那条');
  assert.ok(oldLines[0].includes('写在第一个目录'));
  assert.strictEqual(newLines.length, 1, '新目录里应该只有换之后那条');
  assert.ok(newLines[0].includes('写在第二个目录'));
});

test('dir 配空字符串时退回构造时给的目录', () => {
  const dir = tempDir();
  const recorder = new DanmakuRecorder({ dir, config: { enabled: true, dir: '   ' } });
  assert.strictEqual(recorder.filePath, path.join(dir, 'danmaku', 'danmaku.log'));
});

test('默认存放位置不在程序目录里（避开清理软件扫 .log）', () => {
  const dir = defaultDanmakuLogDir();
  if (!dir) {
    // 极少数环境没有「我的文档」，这时只能退回程序目录，不算失败
    assert.ok(true);
    return;
  }
  assert.ok(dir.includes('直播AI搭档'), `默认目录应该带程序名，实际：${dir}`);
  assert.ok(path.isAbsolute(dir), `必须是绝对路径，实际：${dir}`);
  const programData = path.join(__dirname, '..', 'data');
  assert.ok(
    !dir.toLowerCase().startsWith(programData.toLowerCase()),
    `默认目录不能落在程序目录的 data 下，实际：${dir}`
  );
  assert.ok(fs.existsSync(dir.split(path.sep).slice(0, -2).join(path.sep)), '父目录应该真实存在');
});

test('记录顺序与收包顺序一致（写入是同步的，不会乱序）', () => {
  const dir = tempDir();
  const recorder = makeRecorder({ enabled: true }, dir);
  for (let index = 0; index < 50; index += 1) {
    recorder.record({ messageId: `id-${index}`, user: '甲', text: `第${index}条` });
  }
  const lines = readLines(recorder.filePath);
  assert.strictEqual(lines.length, 50);
  lines.forEach((line, index) => {
    assert.ok(line.includes(`id-${index}`), `第 ${index} 行顺序不对：${line}`);
  });
});

console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
process.exit(failed ? 1 : 0);
