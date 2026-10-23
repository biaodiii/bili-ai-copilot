'use strict';

/**
 * 真机验证：DSH「会话模式」（ACP）端到端跑一遍，重点是**会话能不能续用**。
 *   node scripts/verify-dsh-session.js            走一遍：检测 → 新建/续用 → 发一句最简任务
 *   node scripts/verify-dsh-session.js --handshake 只握手 + 建会话，不调模型（不花钱）
 *   node scripts/verify-dsh-session.js --keep      跑完**保留**会话（默认会把自己建的会话删掉）
 *
 * ⚠️ 默认会清理：这个脚本每跑一次就新建一个会话，验证完就把它删掉
 * （日志目录 + 工作区登记引用 + 投影缓存），不在主播的会话库里留一堆「只回复两个字」的测试会话。
 * 想留着去 DSH Web 里看，就加 `--keep`。
 *
 * 为什么这个脚本存在：会话模式从 SDK stdio 换成 ACP，就是因为旧协议**只会 create、
 * 不会 open** —— 固定会话 id 第二次跑必炸：
 *   session "…" already exists
 * ACP 才有 `session/resume`。所以这里要验证的是：
 *   1. `dsh --profile acp` 能起、握手正常（返回的 agentCapabilities 里要有 resume）；
 *   2. 第一次跑会 `session/new` 拿到一个 id；
 *   3. **再跑一次会用 `session/resume` 续上同一个会话**（不是又新建一个）；
 *   4. 会话落在知识库工作区里（DSH Web 里按工作区分组能看到）。
 *
 * 需要本机装好 Node + @deepseek-ai/dsh（软件里的「检测环境」能过就行）。
 * 不加 --handshake 时会花一点点模型钱（一句「只回复两个字：可以」）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { DshRunner, DshSessionRunner } = require('../src/main/dsh');
const { defaultKnowledgeDir, KnowledgeBase } = require('../src/main/knowledge');
const { sanitize } = require('../src/main/settings');
const { deleteSession } = require('../src/main/dsh-store');

/**
 * 从 DSH 的会话日志里读出这次会话**实际记下的模型**。
 *
 * 为什么要读盘核实：`session/set_config_option` 只说明服务端收下了，
 * 而会话日志的 `request/header` 是它自己落的记录（`selectionFor()` 就是读它来恢复路由的）。
 * 日志是 zstd 压缩、而且是**多帧追加**（一帧一批），所以要按魔数切开逐帧解。
 *
 * @returns {string} 形如 `deepseek-official/deepseek-flash`；读不出来返回空字符串
 */
function readLoggedModel(sessionsRoot, sessionId) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const findDir = (dir, depth = 0) => {
    if (depth > 3) return '';
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return '';
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === sessionId) return path.join(dir, entry.name);
      const found = findDir(path.join(dir, entry.name), depth + 1);
      if (found) return found;
    }
    return '';
  };
  const sessionDir = findDir(sessionsRoot);
  if (!sessionDir) return '';
  const logName = fs.readdirSync(sessionDir).find((name) => name.endsWith('.jsonl.zstd'));
  if (!logName) return '';
  const raw = fs.readFileSync(path.join(sessionDir, logName));
  const offsets = [];
  for (let i = 0; i + 4 <= raw.length; i += 1) {
    if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) offsets.push(i);
  }
  let text = '';
  for (let i = 0; i < offsets.length; i += 1) {
    const slice = raw.subarray(offsets[i], i + 1 < offsets.length ? offsets[i + 1] : raw.length);
    try {
      text += zlib.zstdDecompressSync(slice).toString('utf8');
    } catch (_) {
      /* 末尾可能是不完整的帧 */
    }
  }
  for (const line of text.split('\n')) {
    if (!line.includes('"request/header"')) continue;
    try {
      const record = JSON.parse(line);
      // 记录形状：{type:'request/header', seq, time, data:{header:{config:{provider,model,…}}}}
      const config = (record && record.data && record.data.header && record.data.header.config) || {};
      if (config.model) return `${config.provider || '?'}/${config.model}`;
    } catch (_) {
      /* 跳过坏行 */
    }
  }
  return '';
}

const HANDSHAKE_ONLY = process.argv.includes('--handshake');
const KEEP = process.argv.includes('--keep');
const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch (error) {
  console.error(`读不到 ${settingsPath}：${error.message}`);
  process.exit(1);
}
// 用软件那套清洗/默认值算一遍：脚本要和软件跑出来的行为一致
// （比如 dshModel 还没写进配置文件时，软件会用默认的 deepseek-flash）
const knowledge = sanitize(settings).knowledge || {};
const apiKey = String((settings.api || {}).apiKey || '').trim();
if (!apiKey) {
  console.error('配置里没有 DeepSeek Key，先到「DeepSeek API」页填一个（DSH 会用它调用模型）');
  process.exit(1);
}

const sessionName = String(knowledge.dshSessionName || '').trim() || '直播知识整理';
// 和软件里同一条规矩：工作区 = 软件目录下的「知识库」
const appRoot = path.join(__dirname, '..');
const knowledgeDir = knowledge.dir ? path.resolve(knowledge.dir) : defaultKnowledgeDir(appRoot);
// 工作区得先存在（软件正常启动时也会建好它：notes / pending / inbox + 一份说明）
try {
  new KnowledgeBase({ dir: knowledgeDir, logger: { warn() {}, info() {}, error() {} } }).load();
} catch (error) {
  console.error(`建不出工作区 ${knowledgeDir}：${error.message}`);
  process.exit(1);
}

const logger = {
  info: (message) => console.log(`  · ${message}`),
  warn: (message) => console.log(`  ! ${message}`),
  error: (message) => console.log(`  ✗ ${message}`),
  debug: (message) => console.log(`  · [dsh] ${message}`)
};

(async () => {
  console.log('DSH 会话模式（ACP）验证\n');
  console.log(`会话名称（软件内标注）：${sessionName}`);
  console.log(`工作区（= 沙箱写入根）：${knowledgeDir}`);
  console.log(`模式：${HANDSHAKE_ONLY ? '只握手（不调用模型、不花钱）' : '完整跑一句最简任务（花一点点钱）'}\n`);

  const detectRunner = new DshRunner({
    getConfig: () => ({ ...knowledge, apiKey }),
    logger,
    appPath: appRoot
  });

  console.log('[1/4] 检测环境…');
  const status = await detectRunner.detect();
  for (const check of status.checks) {
    console.log(`  ${check.ok ? '✓' : '✗'} ${check.label}：${check.detail || ''}`);
    if (!check.ok && check.hint) console.log(`      ↳ ${check.hint}`);
  }
  if (!status.ok) {
    console.log('\n环境没过，先把上面标 ✗ 的补上再跑一次。');
    process.exit(1);
  }

  /** 每一轮都用一个**独立的 runner**，模拟「关掉软件再打开」 */
  const makeRunner = (sessionId) => {
    const runner = new DshSessionRunner({
      getConfig: () => ({
        sessionName,
        sessionId,
        model: String(knowledge.dshModel || '').trim(),
        timeoutSec: Number(knowledge.dshTimeoutSec) || 300,
        apiKey,
        cwd: knowledgeDir
      }),
      logger,
      onSession: (id) => console.log(`  · 软件记下会话 id：${id || '(清空)'}`),
      resolve: () => detectRunner.detect()
    });
    runner.onEvent(({ method }) => {
      if (method === 'session/update') return; // 太吵
      process.stdout.write(`  · 收到事件 ${method}\n`);
    });
    return runner;
  };

  console.log('\n[2/4] 第一轮：起 `dsh --profile acp` 并新建会话…');
  const first = makeRunner('');
  const started = Date.now();
  let info;
  try {
    info = await first.ensureStarted();
  } catch (error) {
    console.log(`  ✗ 起不来：${error.message}`);
    process.exit(1);
  }
  console.log(
    `  ✓ 已就绪：${info.server ? `${info.server.name} ${info.server.version}` : 'acp'}（${Math.round(
      (Date.now() - started) / 1000
    )} 秒）`
  );
  console.log(`  DSH 版本 ${info.version}，用来跑：${info.binPath}`);
  const sessionId = first.sessionId;
  if (!sessionId) {
    console.log('  ✗ 没拿到会话 id（session/new 没成功）');
    process.exit(1);
  }
  console.log(`  ✓ 会话 id：${sessionId}`);
  console.log(`  ✓ 模型：${first.model || '(DSH 自己的默认)'}${knowledge.dshModel ? `（配置里指定 ${knowledge.dshModel}）` : '（配置里没指定）'}`);

  if (!HANDSHAKE_ONLY) {
    console.log('\n[3/4] 往会话里发一句最简任务…');
    const result = await first.prompt('只回复两个字：可以', { timeoutMs: 240000 });
    console.log(`  ${result.ok ? '✓' : '✗'} ${result.ok ? `拿到回复：${result.output}` : result.message}`);
    console.log(`  耗时 ${Math.round(result.ms / 1000)} 秒，收到 ${result.events} 个事件，拒绝越界 ${result.denied} 次`);
  } else {
    console.log('\n[3/4] 跳过发任务（--handshake）');
  }
  await first.stop({ graceful: true });

  console.log('\n[4/4] 第二轮：模拟「关掉软件再打开」——应该**续用**同一个会话…');
  const second = makeRunner(sessionId);
  try {
    await second.ensureStarted();
  } catch (error) {
    console.log(`  ✗ 起不来：${error.message}`);
    process.exit(1);
  }
  const resumed = second.sessionId === sessionId;
  console.log(`  ${resumed ? '✓' : '✗'} ${resumed ? '续上了同一个会话' : `换成了新会话：${second.sessionId}`}`);
  if (!HANDSHAKE_ONLY && resumed) {
    const again = await second.prompt('只回复两个字：好的', { timeoutMs: 240000 });
    console.log(`  ${again.ok ? '✓' : '✗'} 第二轮回复：${again.ok ? again.output : again.message}`);
  }
  await second.stop({ graceful: true });

  console.log('\n===== 结果 =====');
  if (!resumed) {
    console.log('没续上（会话模式的核心能力就是续用）。把上面的输出原文发出来即可定位。');
  }
  const sessionsRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
  const logged = readLoggedModel(sessionsRoot, sessionId);
  console.log(
    `  ${logged ? '✓' : '·'} 会话日志里实际记的模型：${logged || '（这次没发任务，所以没有记录；不加 --handshake 才有）'}`
  );

  // 收尾：默认把这次建的会话删掉（主播的会话库里不该留一堆「只回复两个字」的测试会话）
  if (KEEP) {
    console.log(`\n（--keep：会话留着，可以去 DSH Web 里看）${sessionId}`);
  } else {
    const removed = deleteSession({ sessionId });
    console.log(`\n${removed.ok ? '✓ 已删除这次的测试会话（想留着加 --keep）' : '! 测试会话没删掉'}：${removed.ok ? sessionId : removed.reason}`);
    if (removed.ok) for (const item of removed.removed) console.log(`    ${item}`);
  }

  if (!resumed) process.exit(1);
  console.log(`\n✓ 整条链路通了，而且**重启后能续用同一个会话**：${sessionId}`);
  console.log(`  会话库位置：${sessionsRoot}`);
  if (KEEP) {
    console.log(`  去 DSH Web 的会话列表里找它（按工作区分组，工作区名就是「${path.basename(knowledgeDir)}」）：`);
    console.log('    · 列表里会有一条标题来自第一句话的会话（我们会把「' + sessionName + '」放在第一句话开头）');
    console.log('    · 打开后能看到刚才那两句任务和回复');
  } else {
    console.log('  （这个会话已经按默认行为删掉了；想留着去 Web 里看，加 --keep 重跑一次）');
  }
  console.log('\n⚠️ 注意：同一个会话别两边同时发消息（软件在跑的时候你也在 Web 里发，会抢）。');
})();
