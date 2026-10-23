'use strict';

/**
 * 语音模型 / 音色真机验证：拿真实 API Key，把 `tts.js` 里注册的
 * **每一个音色**都真合成一遍，确认没有写错 ID、没有跨模型混用。
 *
 * 为什么需要它：
 *   · 音色 ID 大小写敏感、命名规则很乱（long / loong、_v3 / _v3.1 / _v3.6），
 *     光靠抄文档很容易错一个字母，而错一个字母线上就是 `Invalid voice specified`；
 *   · 音色**不能跨模型混用**，只有真调一次才知道某个 ID 属于哪个模型。
 *
 * 跑一次大约 100 多条请求、每条 2 个字 ≈ 几分钱。默认**只读**配置里的 Key，不写任何文件。
 *   node scripts/verify-tts-voices.js                    验证全部
 *   node scripts/verify-tts-voices.js cosyvoice-v3-flash  只验证某个模型
 *   node scripts/verify-tts-voices.js --concurrency 2     并发数（默认 2）
 *   node scripts/verify-tts-voices.js --delay 500         每个请求之间的间隔毫秒（默认 400）
 *
 * ⚠️ 为什么默认这么慢：百炼的语音合成 **RPM 上限是 180**，一口气并发打过去会收到
 * `Requests rate limit exceeded`。那种失败**不是音色的问题**，但会污染结论，
 * 所以这里既限速、又把限流单独识别出来重试。
 */

const fs = require('fs');
const path = require('path');
const { TtsClient, TTS_MODELS } = require('../src/main/tts');

const args = process.argv.slice(2);
let concurrency = 2;
let delayMs = 400;
const only = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--concurrency') {
    concurrency = Math.max(1, Number(args[i + 1]) || 2);
    i += 1;
  } else if (args[i] === '--delay') {
    delayMs = Math.max(0, Number(args[i + 1]) || 400);
    i += 1;
  } else if (!args[i].startsWith('--')) {
    only.push(args[i]);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isRateLimit = (message) => /rate limit|Throttling|QPS|429/i.test(String(message));

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
let cloud = {};
try {
  cloud = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).speech.cloud || {};
} catch (error) {
  console.error(`读不到 ${settingsPath}：${error.message}`);
  process.exit(1);
}
if (!String(cloud.apiKey || '').trim()) {
  console.error('配置里没有 speech.cloud.apiKey，先到面板的「语音」页填一个');
  process.exit(1);
}

const PROBE_TEXT = '你好'; // 2 个字：够触发合成，又几乎不花钱

const cases = [];
for (const model of TTS_MODELS) {
  if (only.length && !only.includes(model.id)) continue;
  for (const item of model.voices) cases.push({ model: model.id, voice: item.voice, name: item.name });
}

if (!cases.length) {
  console.error(`没有匹配的模型：${only.join(', ') || '（全部）'}`);
  process.exit(1);
}

console.log(`准备验证 ${cases.length} 个（模型 × 音色）组合，并发 ${concurrency}，间隔 ${delayMs}ms\n`);

let done = 0;
const failures = [];
const skipped = [];

async function probeOne(item) {
  // 每个音色单独一个 client：配置不同、也不要互相污染缓存
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const client = new TtsClient({
      getConfig: () => ({ ...cloud, model: item.model, voice: item.voice }),
      logger: { warn() {}, info() {}, error() {} }
    });
    try {
      const result = await client.synthesize(PROBE_TEXT);
      if (!result.audio) throw new Error('返回了空音频');
      done += 1;
      process.stdout.write(`  ✓ ${item.model} / ${item.voice}（${(result.audio.length / 1024).toFixed(0)}KB）\n`);
      return null;
    } catch (error) {
      if (isRateLimit(error.message) && attempt < 4) {
        // 限流不是音色的问题：退避重试，别把它记成「这个音色不能用」
        process.stdout.write(`  … ${item.model} / ${item.voice} 被限流，${attempt * 2}s 后重试\n`);
        // eslint-disable-next-line no-await-in-loop
        await sleep(attempt * 2000);
        continue;
      }
      done += 1;
      const rateLimited = isRateLimit(error.message);
      process.stdout.write(`  ✗ ${item.model} / ${item.voice}\n      ${error.message}\n`);
      return { ...item, message: error.message, code: error.code, rateLimited };
    }
  }
  return null;
}

(async () => {
  const queue = cases.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      // eslint-disable-next-line no-await-in-loop
      const failure = await probeOne(item);
      if (failure && failure.rateLimited) skipped.push(failure);
      else if (failure) failures.push(failure);
      // eslint-disable-next-line no-await-in-loop
      if (delayMs) await sleep(delayMs);
    }
  });
  await Promise.all(workers);

  console.log(`\n----- 结果：${cases.length - failures.length - skipped.length}/${cases.length} 个音色确认可用 -----`);
  console.log(`实际计费字符数：约 ${cases.length * PROBE_TEXT.length} 个`);
  if (skipped.length) {
    console.log(`\n被限流没能测完的（不是音色问题，隔一会儿再跑一遍即可，共 ${skipped.length} 个）：`);
    for (const item of skipped) console.log(`  ${item.model} / ${item.voice}`);
  }
  if (failures.length) {
    console.log(`\n真的不可用（要从 tts.js 的注册表里删掉或改正，共 ${failures.length} 个）：`);
    for (const item of failures) {
      console.log(`  ${item.model} / ${item.voice}（${item.name}）→ ${item.code || ''} ${item.message}`);
    }
    process.exit(1);
  }
  console.log('没有发现「音色写错」的问题。');
})();
