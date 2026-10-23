'use strict';

/**
 * 云端 TTS 客户端测试（本地假接口，不联网、不消耗额度）
 *   node scripts/test-tts.js
 */

const assert = require('assert');
const http = require('http');
const {
  TtsClient,
  TtsError,
  normalizeText,
  repairWavHeader,
  wavHeaderLooksBroken,
  BUILTIN_VOICES,
  TTS_MODELS
} = require('../src/main/tts');

let passed = 0;
let failed = 0;

/**
 * 这个套件里**不要往 stderr 写东西**。
 *
 * 为什么：`TtsClient` 不传 logger 时会用 console，预期内的告警（「wav 头已自动修正」）就走 stderr；
 * 而在 PowerShell 里 `node scripts\check-all.js 2>&1` 会把 stderr 当成 NativeCommandError，
 * 于是**整条自检报告退出码 1，看着像失败**（实际 0 失败，真踩过）。
 * 所以这里把 console.warn 转到 stdout：消息照样看得见，但不再污染退出码。
 * 断言里要知道告警内容的话，自己传 logger 收着（见下面「坏头被修好」那条用例）。
 */
console.warn = (...args) => console.log('  ·', ...args.map((item) => String(item)));

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

/** 起一个假的 DashScope 接口，记录收到的请求 */
function startFakeTts(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch (_) {
        /* ignore */
      }
      received.push({ url: req.url, headers: req.headers, body: parsed });
      const result = handler(parsed, received.length);
      res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.json));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, received, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function okTts(base64 = 'ZmFrZS1hdWRpbw==', characters = 12) {
  return {
    json: {
      status_code: 200,
      output: { audio: { data: base64, url: '', id: 'audio_x', expires_at: 0 } },
      usage: { characters }
    }
  };
}

/**
 * 造一个「只给 url 不给 data」的假接口 + 一个能下载音频的假 OSS。
 * 这是**真实情况**：实测北京地域非流式返回的就是 url。
 */
function startFakeTtsWithUrl(audioBytes = Buffer.from('RIFFfake-wav-bytes')) {
  const downloads = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/audio/')) {
        downloads.push(req.url);
        res.writeHead(200, { 'Content-Type': 'audio/x-wav' });
        res.end(audioBytes);
        return;
      }
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        const port = server.address().port;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status_code: 200,
            output: {
              audio: { data: '', url: `http://127.0.0.1:${port}/audio/x.wav`, id: 'a1', expires_at: 0 }
            },
            usage: { characters: 9 }
          })
        );
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, downloads, baseUrl: `http://127.0.0.1:${server.address().port}`, audioBytes });
    });
  });
}

(async () => {
  console.log('云端语音合成（本地假接口）');

  await test('文本会被规整：空白压缩、首尾去掉', () => {
    assert.strictEqual(normalizeText('  你好   呀 \n '), '你好 呀');
    assert.strictEqual(normalizeText(null), '');
  });

  await test('没配 Key 时不可用，且明确报错（不静默失败）', async () => {
    const client = new TtsClient({ getConfig: () => ({ apiKey: '' }) });
    assert.strictEqual(client.available(), false);
    await assert.rejects(() => client.synthesize('你好'), (error) => {
      assert.ok(error instanceof TtsError);
      assert.strictEqual(error.code, 'NO_API_KEY');
      return true;
    });
  });

  await test('正常合成：请求格式、音色、语种都对，返回 base64', async () => {
    const fake = await startFakeTts(() => okTts('QUJD', 20));
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, voice: 'Cherry', model: 'qwen3-tts-flash' })
    });
    const result = await client.synthesize('你好呀，欢迎来到直播间');
    assert.strictEqual(result.audio, 'QUJD');
    assert.strictEqual(result.cached, false);
    assert.strictEqual(result.characters, 20);

    const sent = fake.received[0];
    assert.strictEqual(sent.url, '/api/v1/services/aigc/multimodal-generation/generation');
    assert.strictEqual(sent.headers.authorization, 'Bearer sk-test');
    assert.strictEqual(sent.body.model, 'qwen3-tts-flash');
    assert.strictEqual(sent.body.input.text, '你好呀，欢迎来到直播间');
    assert.strictEqual(sent.body.input.voice, 'Cherry');
    assert.strictEqual(sent.body.input.language_type, 'Chinese');
    fake.server.close();
  });

  await test('同一句话第二次直接吃缓存，不再发请求', async () => {
    const fake = await startFakeTts(() => okTts());
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    await client.synthesize('你好呀');
    const second = await client.synthesize('你好呀');
    assert.strictEqual(second.cached, true, '第二次应该命中缓存');
    assert.strictEqual(fake.received.length, 1, `不该再发请求，实际发了 ${fake.received.length} 次`);
    assert.strictEqual(client.status().hits, 1);
    fake.server.close();
  });

  await test('换了音色就不能复用缓存（缓存键含音色）', async () => {
    const fake = await startFakeTts(() => okTts());
    let voice = 'Cherry';
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, voice }) });
    await client.synthesize('你好呀');
    voice = 'Ethan';
    await client.synthesize('你好呀');
    assert.strictEqual(fake.received.length, 2, '换音色后应该重新合成');
    assert.strictEqual(fake.received[1].body.input.voice, 'Ethan');
    fake.server.close();
  });

  await test('同一句话并发请求只发一次 HTTP（预热 + 真播不会打两次）', async () => {
    const fake = await startFakeTts(() => okTts());
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    const [a, b] = await Promise.all([client.synthesize('同一句'), client.synthesize('同一句')]);
    assert.strictEqual(fake.received.length, 1, `应该只发一次，实际 ${fake.received.length} 次`);
    assert.strictEqual(a.audio, b.audio);
    fake.server.close();
  });

  await test('缓存有上限，超出后丢掉最久没用过的', async () => {
    const fake = await startFakeTts(() => okTts());
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, cacheSize: 2 })
    });
    await client.synthesize('第一句');
    await client.synthesize('第二句');
    await client.synthesize('第三句');
    assert.strictEqual(client.cache.size, 2, `缓存应该只剩 2 条，实际 ${client.cache.size}`);
    // 第一句应该被挤掉了 → 再请求会重新发 HTTP
    fake.received.length = 0;
    await client.synthesize('第一句');
    assert.strictEqual(fake.received.length, 1, '被挤掉的句子应该重新合成');
    fake.server.close();
  });

  await test('返回结构不对时报错，绝不返回空音频', async () => {
    const fake = await startFakeTts(() => ({ json: { status_code: 200, output: { audio: { data: '' } } } }));
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    await assert.rejects(() => client.synthesize('你好'), (error) => {
      assert.strictEqual(error.code, 'NO_AUDIO');
      return true;
    });
    fake.server.close();
  });

  await test('只给 url 不给 data 时，会下载音频再转 base64（真实情况）', async () => {
    const fake = await startFakeTtsWithUrl();
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    const result = await client.synthesize('你好呀');
    // 应该是下载下来的音频的 base64，而不是空字符串
    assert.strictEqual(result.audio, fake.audioBytes.toString('base64'));
    assert.strictEqual(fake.downloads.length, 1, '应该下载一次音频');
    assert.strictEqual(result.characters, 9);
    fake.server.close();
  });

  await test('url 下载失败时明确报错（不静默返回空音频）', async () => {
    // 指向一个不存在的端口，模拟 OSS 不可达
    const fake = await startFakeTts(() => ({
      json: { status_code: 200, output: { audio: { data: '', url: 'http://127.0.0.1:1/audio/x.wav' } } }
    }));
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, timeoutMs: 800 })
    });
    await assert.rejects(() => client.synthesize('你好'), (error) => {
      assert.strictEqual(error.code, 'DOWNLOAD');
      assert.ok(error.message.includes('下载云端音频失败'), error.message);
      return true;
    });
    fake.server.close();
  });

  await test('url 下载的音频也会进缓存（第二次不再下载）', async () => {
    const fake = await startFakeTtsWithUrl();
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    await client.synthesize('同一句');
    const second = await client.synthesize('同一句');
    assert.strictEqual(second.cached, true);
    assert.strictEqual(fake.downloads.length, 1, `第二次不该再下载，实际下载了 ${fake.downloads.length} 次`);
    fake.server.close();
  });

  console.log('\nwav 头修复（服务端长度字段是占位符，浏览器会拒绝加载）');

  /** 造一段「头里长度全是 0x7FFFFFFF」的 wav —— 和百炼真实返回的一样 */
  const brokenWav = (payloadBytes = 2000) => {
    const buffer = Buffer.alloc(44 + payloadBytes, 0);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(0x7fffffff, 4); // 占位符
    buffer.write('WAVE', 8, 'ascii');
    buffer.write('fmt ', 12, 'ascii');
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(24000, 24);
    buffer.write('data', 36, 'ascii');
    buffer.writeUInt32LE(0x7fffffff, 40); // 占位符
    for (let i = 44; i < buffer.length; i += 1) buffer[i] = (i * 7) % 256;
    return buffer;
  };

  await test('修 wav 头：把 0x7FFFFFFF 的占位符改成真实长度', async () => {
    const broken = brokenWav();
    assert.strictEqual(wavHeaderLooksBroken(broken), true);
    const fixed = repairWavHeader(broken);
    assert.strictEqual(fixed.readUInt32LE(4), fixed.length - 8, 'RIFF 大小应该是文件长度 - 8');
    assert.strictEqual(fixed.readUInt32LE(40), fixed.length - 44, 'data 大小应该是剩余字节数');
    assert.strictEqual(wavHeaderLooksBroken(fixed), false);
    // 音频数据一个字都不能动
    assert.deepStrictEqual(fixed.subarray(44), broken.subarray(44), '不能改动音频数据');
    // 不该改动调用方传进来的那份
    assert.strictEqual(broken.readUInt32LE(4), 0x7fffffff);
  });

  await test('头本来就正常的 wav 原样返回（不白复制一遍）', async () => {
    const good = brokenWav();
    good.writeUInt32LE(good.length - 8, 4);
    good.writeUInt32LE(good.length - 44, 40);
    assert.strictEqual(wavHeaderLooksBroken(good), false);
    assert.strictEqual(repairWavHeader(good), good, '正常文件应该原样返回同一个 Buffer');
  });

  await test('不是 wav / 太短的内容不会被动（避免改坏别的格式）', async () => {
    const mp3 = Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00abcdefghijklmnopqrstuvwxyz');
    assert.strictEqual(repairWavHeader(mp3), mp3);
    const tiny = Buffer.from('RIFF');
    assert.strictEqual(repairWavHeader(tiny), tiny);
  });

  await test('走完整链路：坏头的音频下载后会被修好再交给界面', async () => {
    const payload = 1500;
    const broken = brokenWav(payload);
    const fake = await startFakeTtsWithUrl(broken);
    // ⚠️ 一定要传 logger：不传的话 TtsClient 会用 console，而「已自动修正」这句告警会写到 **stderr**，
    // 于是 PowerShell 把它当成 NativeCommandError —— 整条 check-all 看着像失败（退出码 1、其实 0 失败）。
    const warnings = [];
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }),
      logger: { debug() {}, info() {}, warn: (m) => warnings.push(String(m)), error() {} }
    });
    const result = await client.synthesize('念这一句');
    const out = Buffer.from(result.audio, 'base64');
    assert.strictEqual(out.length, broken.length, '长度不该变');
    assert.strictEqual(wavHeaderLooksBroken(out), false, '交给界面的音频必须是修好的');
    assert.strictEqual(client.status().repaired, 1, '应该记一笔「修过头」');
    assert.ok(
      warnings.some((line) => /wav 头/.test(line)),
      `修头这件事要留下告警（方便排查），实际：${warnings.join(' / ')}`
    );
    fake.server.close();
  });

  await test('服务端报错时把错误信息带出来（方便界面提示）', async () => {
    const fake = await startFakeTts(() => ({
      status: 401,
      json: { code: 'InvalidApiKey', message: 'Invalid API-key provided.' }
    }));
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-bad', baseUrl: fake.baseUrl }) });
    await assert.rejects(() => client.synthesize('你好'), (error) => {
      assert.strictEqual(error.code, 'HTTP');
      assert.strictEqual(error.status, 401);
      assert.ok(error.message.includes('Invalid API-key'), `错误信息丢了: ${error.message}`);
      return true;
    });
    fake.server.close();
  });

  await test('网络不通时报可读的错误（供界面降级）', async () => {
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: 'http://127.0.0.1:1', timeoutMs: 800 })
    });
    await assert.rejects(() => client.synthesize('你好'), (error) => {
      assert.strictEqual(error.code, 'NETWORK');
      assert.ok(error.message.includes('云端语音请求失败'), error.message);
      return true;
    });
  });

  await test('空文本不发请求', async () => {
    const fake = await startFakeTts(() => okTts());
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    await assert.rejects(() => client.synthesize('   '), (error) => {
      assert.strictEqual(error.code, 'EMPTY_TEXT');
      return true;
    });
    assert.strictEqual(fake.received.length, 0);
    fake.server.close();
  });

  await test('统计能反映请求数、缓存命中、字符数', async () => {
    const fake = await startFakeTts(() => okTts('QQ==', 5));
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl }) });
    await client.synthesize('一二三四五');
    await client.synthesize('一二三四五');
    const status = client.status();
    assert.strictEqual(status.requests, 1);
    assert.strictEqual(status.hits, 1);
    assert.strictEqual(status.characters, 5);
    assert.strictEqual(status.available, true);
    client.clearCache();
    assert.strictEqual(client.status().cached, 0);
    fake.server.close();
  });

  // 界面上的音色下拉靠这条数据，掉了下拉就只剩一个空框
  await test('status() 会带上内置音色清单（界面下拉的数据源）', async () => {
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test' }) });
    const voices = client.status().voices;
    assert.ok(Array.isArray(voices) && voices.length >= 10, `音色清单太短: ${voices && voices.length}`);
    const cherry = voices.find((item) => item.voice === 'Cherry');
    assert.ok(cherry, '清单里应该有默认音色 Cherry');
    assert.ok(cherry.name && cherry.desc, `每个音色都要有中文名和描述: ${JSON.stringify(cherry)}`);
    for (const item of voices) {
      assert.ok(item.voice && item.name && item.desc, `音色条目不完整: ${JSON.stringify(item)}`);
    }
    // 导出给测试/脚本看的常量要和 status 里的是同一份
    assert.strictEqual(BUILTIN_VOICES.length, voices.length);
  });

  // ---------------------------------------------------------- 多模型（换模型 = 换接口路径 + 换音色清单）

  await test('模型清单自洽：id 不重复、默认音色在清单里、路径是已知的那两条', async () => {
    assert.ok(TTS_MODELS.length >= 4, `可选的模型太少: ${TTS_MODELS.length}`);
    const seen = new Set();
    for (const model of TTS_MODELS) {
      assert.ok(model.id && !seen.has(model.id), `模型 id 重复或为空: ${model.id}`);
      seen.add(model.id);
      assert.ok(
        model.path === '/api/v1/services/aigc/multimodal-generation/generation' ||
          model.path === '/api/v1/services/audio/tts/SpeechSynthesizer',
        `${model.id} 的接口路径不是已知的那两条: ${model.path}`
      );
      assert.ok(model.label, `${model.id} 缺中文名（界面下拉要用）`);
      assert.ok(model.voices.length > 0, `${model.id} 一个音色都没有，选了必然报错`);
      assert.ok(
        model.voices.some((item) => item.voice === model.defaultVoice),
        `${model.id} 的默认音色「${model.defaultVoice}」不在它自己的音色清单里——换过去就会报 Invalid voice specified`
      );
    }
  });

  await test('status() 会把每个模型连同它的音色一起给界面', async () => {
    const client = new TtsClient({ getConfig: () => ({ apiKey: 'sk-test', model: 'cosyvoice-v3-flash' }) });
    const status = client.status();
    assert.strictEqual(status.model, 'cosyvoice-v3-flash');
    assert.ok(status.modelLabel, '要带一个给人看的模型名');
    assert.strictEqual(status.models.length, TTS_MODELS.length);
    const cosy = status.models.find((item) => item.id === 'cosyvoice-v3-flash');
    assert.ok(cosy.voices.length >= 1, 'cosyvoice 的音色要一起给出来');
    assert.ok(cosy.price && cosy.note, '界面要显示价格和说明');
    // 当前模型的音色（老字段）也要跟着模型走
    assert.strictEqual(status.voices.length, cosy.voices.length);
  });

  await test('qwen3-tts-flash 走多模态路径，报文里带 language_type', async () => {
    const fake = await startFakeTts(() => okTts());
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, model: 'qwen3-tts-flash', voice: 'Cherry' })
    });
    await client.synthesize('你好');
    const request = fake.received[0];
    assert.strictEqual(request.url, '/api/v1/services/aigc/multimodal-generation/generation');
    assert.strictEqual(request.body.model, 'qwen3-tts-flash');
    assert.strictEqual(request.body.input.voice, 'Cherry');
    assert.strictEqual(request.body.input.language_type, 'Chinese');
    assert.strictEqual(request.body.input.format, undefined, '这条路不该带 format');
    fake.server.close();
  });

  await test('cosyvoice / qwen-audio 走 SpeechSynthesizer 路径，报文里带 format 与 sample_rate', async () => {
    for (const model of ['cosyvoice-v3-flash', 'qwen-audio-3.1-tts-flash']) {
      const fake = await startFakeTts(() => okTts());
      const client = new TtsClient({
        getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, model })
      });
      // eslint-disable-next-line no-await-in-loop
      await client.synthesize('你好');
      const request = fake.received[0];
      assert.strictEqual(
        request.url,
        '/api/v1/services/audio/tts/SpeechSynthesizer',
        `${model} 的路径不对: ${request.url}`
      );
      assert.strictEqual(request.body.model, model);
      assert.strictEqual(request.body.input.format, 'wav');
      assert.strictEqual(request.body.input.sample_rate, 24000);
      assert.strictEqual(request.body.input.language_type, undefined, '这条路不该带 language_type');
      // 没填音色时要自动落到这个模型的默认音色，而不是留空报错
      assert.ok(request.body.input.voice, `${model} 应该自动补上默认音色`);
      fake.server.close();
    }
  });

  await test('不认识的模型：直接报错说清楚，不发请求', async () => {
    const fake = await startFakeTts(() => okTts());
    const client = new TtsClient({
      getConfig: () => ({ apiKey: 'sk-test', baseUrl: fake.baseUrl, model: 'gpt-4o-tts' })
    });
    await assert.rejects(
      () => client.synthesize('你好'),
      (error) => {
        assert.strictEqual(error.code, 'UNKNOWN_MODEL');
        assert.ok(/gpt-4o-tts/.test(error.message), `错误信息要带上模型名: ${error.message}`);
        return true;
      }
    );
    assert.strictEqual(fake.received.length, 0, '不认识的模型不该发请求（白花钱）');
    fake.server.close();
  });

  await test('音色不属于当前模型时，错误信息要告诉用户怎么办', async () => {
    const fake = await startFakeTts(() => ({
      status: 400,
      json: {
        code: 'InvalidParameter',
        message: 'Invalid voice specified, the requested voice does not exist or is not licensed for use'
      }
    }));
    const client = new TtsClient({
      getConfig: () => ({
        apiKey: 'sk-test',
        baseUrl: fake.baseUrl,
        model: 'qwen3-tts-flash',
        voice: 'longanyang'
      })
    });
    await assert.rejects(
      () => client.synthesize('你好'),
      (error) => {
        assert.ok(/longanyang/.test(error.message), `要指出是哪个音色: ${error.message}`);
        assert.ok(/不属于模型/.test(error.message), `要给出怎么修: ${error.message}`);
        return true;
      }
    );
    fake.server.close();
  });

  console.log('');
  console.log(`结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
