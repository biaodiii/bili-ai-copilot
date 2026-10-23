'use strict';

/**
 * DeepSeek 调用链路测试：起一个本地假接口，验证请求格式、回复解析、错误提示
 *   node scripts/test-llm.js
 *
 * 不需要真实 API Key，也不会消耗额度。
 */

const http = require('http');
const assert = require('assert');
const { DeepSeekClient } = require('../src/main/llm');

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

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

/** 假 DeepSeek 服务：记录请求，按脚本返回不同结果 */
function startFakeServer(handler) {
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
      const result = handler(parsed, req, received.length);
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

function okReply(reply, emotion = 'happy') {
  return {
    json: {
      id: 'chatcmpl-test',
      model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ reply, emotion }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 }
    }
  };
}

(async () => {
  console.log('DeepSeek 调用链路（本地假接口）');

  await testAsync('正常调用：请求格式正确、回复能解析', async () => {
    const fake = await startFakeServer(() => okReply('好嘞，这就来'));
    const client = new DeepSeekClient(() => ({
      apiKey: 'sk-test-123',
      baseUrl: fake.baseUrl,
      model: 'deepseek-chat',
      temperature: 1.2,
      maxTokens: 200,
      timeoutSec: 10,
      useJsonFormat: true
    }));

    const result = await client.chat([
      { role: 'system', content: '人设' },
      { role: 'user', content: '【观众 小明】你好' }
    ]);

    const sent = fake.received[0];
    assert.strictEqual(sent.url, '/chat/completions', `请求路径应为 /chat/completions，实际 ${sent.url}`);
    assert.strictEqual(sent.headers.authorization, 'Bearer sk-test-123', 'Authorization 头不正确');
    assert.strictEqual(sent.body.model, 'deepseek-chat');
    assert.strictEqual(sent.body.stream, false);
    assert.deepStrictEqual(sent.body.response_format, { type: 'json_object' }, 'JSON 模式没有开启');
    assert.strictEqual(sent.body.messages.length, 2);
    assert.strictEqual(sent.body.temperature, 1.2);
    assert.strictEqual(sent.body.max_tokens, 200);

    const parsed = DeepSeekClient.parseReply(result.content);
    assert.strictEqual(parsed.text, '好嘞，这就来');
    assert.strictEqual(parsed.emotion, 'happy');
    fake.server.close();
  });

  await testAsync('接口地址结尾带 / 或 /v1 都能正确拼接', async () => {
    const fake = await startFakeServer(() => okReply('hi'));
    // 官方地址结尾不带 /v1；用中转站时用户可能填成 .../v1，此时路径应保留 /v1
    const cases = [
      { suffix: '', expect: '/chat/completions' },
      { suffix: '/', expect: '/chat/completions' },
      { suffix: '/v1', expect: '/v1/chat/completions' }
    ];
    for (const item of cases) {
      const client = new DeepSeekClient(() => ({
        apiKey: 'sk-x',
        baseUrl: `${fake.baseUrl}${item.suffix}`,
        model: 'deepseek-chat',
        useJsonFormat: true
      }));
      // eslint-disable-next-line no-await-in-loop
      await client.chat([{ role: 'user', content: 'hi' }]);
      const sent = fake.received[fake.received.length - 1];
      assert.strictEqual(sent.url, item.expect, `baseUrl 结尾为「${item.suffix}」时路径应为 ${item.expect}，实际 ${sent.url}`);
    }
    fake.server.close();
  });

  await testAsync('401 给出「Key 无效」的明确提示', async () => {
    const fake = await startFakeServer(() => ({ status: 401, json: { error: { message: 'Authentication Fails' } } }));
    const client = new DeepSeekClient(() => ({ apiKey: 'bad', baseUrl: fake.baseUrl, useJsonFormat: false }));
    let message = '';
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /API Key 无效/, `提示不明确: ${message}`);
    fake.server.close();
  });

  await testAsync('402 提示余额不足，429 提示太频繁', async () => {
    const fake = await startFakeServer((body, req, count) =>
      count === 1
        ? { status: 402, json: { error: { message: 'Insufficient Balance' } } }
        : { status: 429, json: { error: { message: 'Rate limit' } } }
    );
    const client = new DeepSeekClient(() => ({ apiKey: 'k', baseUrl: fake.baseUrl, useJsonFormat: false }));
    const messages = [];
    for (let i = 0; i < 2; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.chat([{ role: 'user', content: 'hi' }]);
      } catch (error) {
        messages.push(error.message);
      }
    }
    assert.match(messages[0], /余额不足/);
    assert.match(messages[1], /太频繁/);
    fake.server.close();
  });

  await testAsync('超时会给出超时提示', async () => {
    const server = http.createServer(() => {
      /* 故意不回应 */
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new DeepSeekClient(() => ({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutSec: 1,
      useJsonFormat: false
    }));
    let message = '';
    const started = Date.now();
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /超时/, `应该提示超时，实际: ${message}`);
    assert.ok(Date.now() - started < 5000, '超时没有按时中断');
    server.close();
  });

  await testAsync('单次调用可以自带超时（慢活用：知识库整理/校对是 max 档思考，45 秒不够）', async () => {
    // 100ms 才回：配置的 1 秒超时能过，但显式把超时压到 50ms 就该断
    const server = http.createServer((req) => {
      setTimeout(() => {
        req.resume();
        req.on('end', () => {
          /* noop */
        });
        req.socket.destroy();
      }, 100);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = new DeepSeekClient(() => ({
      apiKey: 'k',
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      timeoutSec: 5,
      useJsonFormat: false
    }));
    let message = '';
    const started = Date.now();
    try {
      await client.chat([{ role: 'user', content: 'hi' }], { timeoutMs: 50 });
    } catch (error) {
      message = error.message;
    }
    const took = Date.now() - started;
    assert.ok(took < 400, `timeoutMs 没生效（用了 ${took}ms）`);
    assert.match(message, /超时/, `应该报超时，实际: ${message}`);
    assert.match(message, /毫秒|秒/, `提示里要带上实际用的超时时间：${message}`);
    server.close();
  });

  await testAsync('没填 API Key 时立刻报错，不发请求', async () => {
    const client = new DeepSeekClient(() => ({ apiKey: '', baseUrl: 'http://127.0.0.1:1' }));
    let message = '';
    try {
      await client.chat([{ role: 'user', content: 'hi' }]);
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /API Key/);
  });

  await testAsync('测试连接：能返回模型名和回复', async () => {
    const fake = await startFakeServer(() => okReply('连接成功'));
    const client = new DeepSeekClient(() => ({ apiKey: 'k', baseUrl: fake.baseUrl, useJsonFormat: true }));
    const result = await client.test();
    assert.strictEqual(result.reply, '连接成功');
    assert.strictEqual(result.model, 'deepseek-chat');
    assert.ok(typeof result.latencyMs === 'number');
    fake.server.close();
  });

  await testAsync('空回复会自动重试：第 2 次成功', async () => {
    // 注意：call 是服务端累计计数，用 base 记录本次测试的起点
    const fake = await startFakeServer((body, req, count) => {
      if (count === 1) {
        // 第一次返回空 content（真实遇到过：JSON 模式下偶尔为空）
        return { json: { model: 'deepseek-flash', choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] } };
      }
      return okReply('第二次有内容了');
    });
    const client = new DeepSeekClient(() => ({
      apiKey: 'k',
      baseUrl: fake.baseUrl,
      useJsonFormat: true,
      maxTokens: 200
    }));
    const result = await client.chatWithRetry([{ role: 'user', content: '你好' }]);
    assert.strictEqual(result.content.includes('第二次有内容了'), true, `重试后应拿到内容: ${result.content}`);
    assert.strictEqual(fake.received.length, 2, `应该恰好发起 2 次请求，实际 ${fake.received.length} 次`);
    // 请求体在 .body 里
    const first = fake.received[0].body;
    const second = fake.received[1].body;
    assert.ok(first.response_format, '第一次应该按设置开启 JSON 模式');
    assert.strictEqual(second.response_format, undefined, '重试时应关掉 JSON 模式');
    assert.ok(second.max_tokens >= 400, `重试应放大 token 上限，实际 ${second.max_tokens}`);
    fake.server.close();
  });

  await testAsync('空回复会自动重试：第 3 次（加催问）成功', async () => {
    const fake = await startFakeServer((body, req, count) => {
      if (count <= 2) {
        return { json: { choices: [{ message: { role: 'assistant', content: '   ' } }] } };
      }
      return okReply('第三次终于说话了');
    });
    const client = new DeepSeekClient(() => ({ apiKey: 'k', baseUrl: fake.baseUrl, useJsonFormat: true }));
    const result = await client.chatWithRetry([{ role: 'user', content: '在吗' }]);
    assert.strictEqual(fake.received.length, 3, `应该发起 3 次请求，实际 ${fake.received.length} 次`);
    assert.ok(result.content.includes('第三次终于说话了'));
    // 第三次应带上催问
    const lastMessages = fake.received[2].body.messages;
    assert.ok(
      lastMessages.some((m) => String(m.content).includes('不要输出 JSON')),
      '第三次应加一句催问，要求直接口语回答'
    );
    fake.server.close();
  });

  await testAsync('连续空回复会明确报错，而不是静默什么都不说', async () => {
    const fake = await startFakeServer(() => ({
      json: { choices: [{ message: { role: 'assistant', content: '', reasoning_content: '想了很多但没输出' } }] }
    }));
    const client = new DeepSeekClient(() => ({ apiKey: 'k', baseUrl: fake.baseUrl, useJsonFormat: true }));
    let message = '';
    try {
      await client.chatWithRetry([{ role: 'user', content: '你好' }]);
    } catch (error) {
      message = error.message;
    }
    assert.match(message, /空内容/, `应给出明确错误，实际: ${message}`);
    assert.strictEqual(fake.received.length, 3, `应该重试到 3 次，实际 ${fake.received.length} 次`);
    fake.server.close();
  });

  console.log('\n纯解析相关');
  test('模型返回带代码块的 JSON 也能解析', () => {
    const parsed = DeepSeekClient.parseReply('```json\n{"reply":"收到","emotion":"thinking"}\n```');
    assert.strictEqual(parsed.text, '收到');
    assert.strictEqual(parsed.emotion, 'thinking');
  });

  test('模型返回纯文本时不会丢内容', () => {
    const parsed = DeepSeekClient.parseReply('就是一句普通的话');
    assert.strictEqual(parsed.text, '就是一句普通的话');
  });

  console.log('\n句末情绪标记（当前默认格式）');
  test('句末 [情绪:xxx] 能解析出正文和情绪', () => {
    const parsed = DeepSeekClient.parseReply('抽卡这玩意儿玄学，说不定下一发就欧了。[情绪:happy]');
    assert.strictEqual(parsed.text, '抽卡这玩意儿玄学，说不定下一发就欧了。');
    assert.strictEqual(parsed.emotion, 'happy');
  });

  test('标记用全角括号、中文冒号、英文 emotion 都认', () => {
    assert.strictEqual(DeepSeekClient.parseReply('好嘞～【情绪：开心】').emotion, 'happy');
    assert.strictEqual(DeepSeekClient.parseReply('好嘞～[emotion:shy]').emotion, 'shy');
    assert.strictEqual(DeepSeekClient.parseReply('好嘞～[emotion：thinking]').text, '好嘞～');
  });

  test('自定义表情：[情绪:生气] 认得出；没配自定义表时仍然退回 idle', () => {
    // 2026-10-19 加的自定义表情：解析器要认识用户自己加的状态，否则加了也用不上
    const custom = [{ key: '生气', when: '被怼时', alias: '恼火' }];
    const parsed = DeepSeekClient.parseReply('哼，行吧行吧。[情绪:生气]', { custom });
    assert.strictEqual(parsed.emotion, '生气');
    assert.strictEqual(parsed.text, '哼，行吧行吧。');
    assert.strictEqual(DeepSeekClient.parseReply('哼。[情绪:恼火]', { custom }).emotion, '生气', '别名也要认');
    // 另一个自定义表情的状态不能被误认成别的
    assert.strictEqual(DeepSeekClient.parseReply('哇。[情绪:吃瓜]', { custom: [{ key: '吃瓜' }] }).emotion, '吃瓜');
    // 没传自定义表（老调用方）→ 还是老行为：不认识就 idle
    assert.strictEqual(DeepSeekClient.parseReply('哼。[情绪:生气]').emotion, 'idle');
  });

  test('自定义表情：对话式「规则: 生气=无语」也能记给它', () => {
    const custom = [{ key: '生气', when: '被怼时' }];
    const parsed = DeepSeekClient.parseReply('记住啦[情绪:happy]规则: 生气=无语|草', { custom });
    assert.deepStrictEqual(parsed.triggerRules, [{ emotion: '生气', words: ['无语', '草'] }]);
    // 没配这个自定义表情时，这条规则不算数（当成正文，不能把正文截掉）
    assert.deepStrictEqual(DeepSeekClient.parseReply('记住啦[情绪:happy]规则: 生气=无语').triggerRules, []);
  });

  test('标记在正文中间时也会被摘掉，正文保留', () => {
    const parsed = DeepSeekClient.parseReply('前半句[情绪:sad]后半句');
    assert.ok(!parsed.text.includes('情绪'), `正文里不该残留标记：${parsed.text}`);
    assert.ok(parsed.text.includes('前半句') && parsed.text.includes('后半句'), `正文被吃掉了：${parsed.text}`);
    assert.strictEqual(parsed.emotion, 'sad');
  });

  test('标记后面的「备注:」被摘成 selfNote，不混进正文', () => {
    const parsed = DeepSeekClient.parseReply('行。[情绪:happy]备注:观众爱接梗，可以更活跃');
    assert.strictEqual(parsed.text, '行。');
    assert.strictEqual(parsed.emotion, 'happy');
    assert.strictEqual(parsed.selfNote, '观众爱接梗，可以更活跃');
  });

  test('正文里的普通方括号不会被误当成标记', () => {
    // 观众发的 [doge]、程序自己标记的 ⚠️ 都可能出现在上下文里，不能让情绪被改掉
    const parsed = DeepSeekClient.parseReply('哈哈哈[doge]这个真可以');
    assert.strictEqual(parsed.text, '哈哈哈[doge]这个真可以');
    assert.strictEqual(parsed.emotion, 'idle');
    assert.strictEqual(DeepSeekClient.parseTaggedReply('哈哈哈[doge]这个真可以'), null);
  });

  test('情绪写得不认识时退回 idle，正文不丢', () => {
    const parsed = DeepSeekClient.parseReply('好耶！[情绪:非常激动]');
    assert.strictEqual(parsed.text, '好耶！');
    assert.strictEqual(parsed.emotion, 'idle');
  });

  test('没有标记的纯口语回复仍然原样返回（模型不听话时的兜底）', () => {
    const parsed = DeepSeekClient.parseReply('这波不亏啊，考场蒙题可比十连实在多了。');
    assert.strictEqual(parsed.text, '这波不亏啊，考场蒙题可比十连实在多了。');
  });

  console.log('\n正文里可以插多个情绪标记（按顺序演表情）');
  test('一句话里的多个标记会按先后顺序列出来', () => {
    const parsed = DeepSeekClient.parseReply('嚯，这也能中？[情绪:surprised]我看你是练过。[情绪:happy]');
    assert.strictEqual(parsed.text, '嚯，这也能中？我看你是练过。');
    assert.deepStrictEqual(
      parsed.emotions.map((item) => item.key),
      ['surprised', 'happy']
    );
    // 位置要递增，界面按这个顺序演
    assert.ok(parsed.emotions[0].at < parsed.emotions[1].at, '标记位置没有递增');
    // emotion 字段保留成最后一个（老代码只认这个字段）
    assert.strictEqual(parsed.emotion, 'happy');
  });

  test('标记在句首也能认出来', () => {
    const parsed = DeepSeekClient.parseReply('[情绪:thinking]让我想想……好像是这样。');
    assert.strictEqual(parsed.text, '让我想想……好像是这样。');
    assert.deepStrictEqual(parsed.emotions.map((item) => item.key), ['thinking']);
  });

  test('三个标记也照单全收，顺序不乱', () => {
    const parsed = DeepSeekClient.parseReply('呃[情绪:thinking]这也行？[情绪:surprised]服了。[情绪:sad]');
    assert.deepStrictEqual(
      parsed.emotions.map((item) => item.key),
      ['thinking', 'surprised', 'sad']
    );
    assert.strictEqual(parsed.text, '呃这也行？服了。');
  });

  test('多个标记 + 备注：备注仍然只算最后一个标记后面的', () => {
    const parsed = DeepSeekClient.parseReply('[情绪:thinking]想好了。[情绪:happy]备注:观众爱接梗');
    assert.strictEqual(parsed.text, '想好了。');
    assert.strictEqual(parsed.selfNote, '观众爱接梗');
    assert.deepStrictEqual(parsed.emotions.map((item) => item.key), ['thinking', 'happy']);
  });

  test('没有标记时 emotions 是空数组（界面据此回平常）', () => {
    const parsed = DeepSeekClient.parseReply('就是一句普通的对话');
    assert.deepStrictEqual(parsed.emotions, []);
    assert.strictEqual(parsed.emotion, 'idle');
  });

  console.log('\n触发词规则（主播让它「看到某个词就换表情」）');
  /** 从「规则:」后面切出来的规则 */
  const rulesOf = (raw) => DeepSeekClient.parseTriggerRules(raw);

  test('基本格式：一个状态配多个词', () => {
    assert.deepStrictEqual(rulesOf('规则: 开心=草|笑尿'), [{ emotion: '开心', words: ['草', '笑尿'] }]);
  });

  test('多个状态用逗号隔开', () => {
    assert.deepStrictEqual(rulesOf('规则: 惊讶=啊？, 开心=哈哈、好耶'), [
      { emotion: '惊讶', words: ['啊？'] },
      { emotion: '开心', words: ['哈哈', '好耶'] }
    ]);
  });

  test('词用逗号并列也算（逗号后面没有等号就是词）', () => {
    assert.deepStrictEqual(rulesOf('规则: 开心=哈哈, 笑死'), [{ emotion: '开心', words: ['哈哈', '笑死'] }]);
  });

  test('等号两边有空格、全角等号都认', () => {
    assert.deepStrictEqual(rulesOf('规则: 开心 ＝ 哈哈'), [{ emotion: '开心', words: ['哈哈'] }]);
    assert.deepStrictEqual(rulesOf('规则: 开心 = 哈哈， 睡觉 = 晚安'), [
      { emotion: '开心', words: ['哈哈'] },
      { emotion: '睡觉', words: ['晚安'] }
    ]);
  });

  test('规则会从正文里摘掉，回复内容里看不到它', () => {
    const parsed = DeepSeekClient.parseReply('好嘞，记下了！[情绪:happy]规则: 开心=草|笑尿');
    assert.strictEqual(parsed.text, '好嘞，记下了！');
    assert.deepStrictEqual(parsed.triggerRules, [{ emotion: '开心', words: ['草', '笑尿'] }]);
    assert.deepStrictEqual(parsed.emotions.map((item) => item.key), ['happy']);
  });

  test('没有情绪标记、只有规则时也能解析出来', () => {
    const parsed = DeepSeekClient.parseReply('规则: 睡觉=晚安');
    assert.deepStrictEqual(parsed.triggerRules, [{ emotion: '睡觉', words: ['晚安'] }]);
    assert.strictEqual(parsed.text, '');
  });

  test('规则和备注同时出现时互不干扰', () => {
    const parsed = DeepSeekClient.parseReply('记住了～[情绪:happy]备注:观众爱接梗 规则: 睡觉=晚安|下班');
    assert.strictEqual(parsed.selfNote, '观众爱接梗');
    assert.deepStrictEqual(parsed.triggerRules, [{ emotion: '睡觉', words: ['晚安', '下班'] }]);
    assert.strictEqual(parsed.text, '记住了～');
  });

  // ---- 「模型想查 / 想记」的标记（观众看不到，主播在面板里决定做不做） ----

  test('想查标记：正文干净、带出关键词和「为什么」', () => {
    const parsed = DeepSeekClient.parseReply('咦，明日方舟？我回头问问主人要不要查。[待查:明日方舟|观众提到了新游戏][情绪:thinking]');
    assert.strictEqual(parsed.text, '咦，明日方舟？我回头问问主人要不要查。');
    assert.strictEqual(parsed.emotion, 'thinking');
    assert.deepStrictEqual(parsed.research, [{ kind: 'lookup', text: '明日方舟', reason: '观众提到了新游戏' }]);
  });

  test('想记标记：写成 note，英文写法也认', () => {
    const cn = DeepSeekClient.parseReply('[记一笔:下周有明日方舟联动][情绪:happy]');
    assert.deepStrictEqual(cn.research, [{ kind: 'note', text: '下周有明日方舟联动', reason: '' }]);
    const en = DeepSeekClient.parseReply('好。[lookup:ss14][note:有联动]');
    assert.deepStrictEqual(
      en.research.map((item) => item.kind),
      ['lookup', 'note']
    );
    assert.strictEqual(en.text, '好。');
  });

  test('标记有上限（一条回复最多 3 条），且长度会截断', () => {
    const many = DeepSeekClient.parseReply('正文[待查:一][待查:二][待查:三][待查:四][待查:五]');
    assert.strictEqual(many.research.length, 3, `最多留 3 条，实际 ${many.research.length}`);
    assert.strictEqual(many.text, '正文');
    const long = DeepSeekClient.parseReply(`[待查:${'长'.repeat(300)}]`);
    assert.strictEqual(long.research[0].text.length, DeepSeekClient.MAX_RESEARCH_CHARS);
  });

  test('普通对话 / 观众的表情文本不会被误判成待办', () => {
    assert.deepStrictEqual(DeepSeekClient.parseReply('哈哈哈[doge]这个真可以').research, []);
    assert.deepStrictEqual(DeepSeekClient.parseReply('这个游戏我查过，挺好玩的。').research, []);
    // 只有标记、没有正文 → 正文为空但待办要留下（调用方据此决定「不显示回复也不丢需求」）
    const only = DeepSeekClient.parseReply('[待查:明日方舟]');
    assert.strictEqual(only.text, '');
    assert.strictEqual(only.research.length, 1);
  });

  test('改库标记：`[改一下:条目|哪儿不对]` 和 `[扩写:条目]` 都认，正文照样干净', () => {
    const edit = DeepSeekClient.parseReply('啊对，我记岔了，我改一下～[情绪:shy][改一下:终末地|公测时间写错了]');
    assert.strictEqual(edit.text, '啊对，我记岔了，我改一下～');
    assert.deepStrictEqual(edit.research, [{ kind: 'edit', text: '终末地', reason: '公测时间写错了' }]);

    const expand = DeepSeekClient.parseReply('这条我记得太少了，我补一补。[扩写:大肥鱼玩偶]');
    assert.strictEqual(expand.text, '这条我记得太少了，我补一补。');
    assert.deepStrictEqual(expand.research, [{ kind: 'expand', text: '大肥鱼玩偶', reason: '' }]);

    // 英文写法
    const en = DeepSeekClient.parseReply('ok[expand:slay the spire]');
    assert.deepStrictEqual(en.research, [{ kind: 'expand', text: 'slay the spire', reason: '' }]);

    // 一条回复里最多 1 个「改库」标记：她要是同时想改三条，多出来的整条丢掉
    // （不降级成普通待办——那样反而更乱，见 llm.js 里 MAX_EDIT_MARKS 的说明）
    const many = DeepSeekClient.parseReply('[改一下:甲|错][改一下:乙|错][扩写:丙]');
    assert.strictEqual(many.research.length, 1, `改库标记最多留 1 个，实际：${JSON.stringify(many.research)}`);
    assert.strictEqual(many.research[0].kind, 'edit');
    assert.strictEqual(many.research[0].text, '甲');
    // 但「想查 / 想记」不受这个限制（它们不动库）
    const mixed = DeepSeekClient.parseReply('[改一下:甲|错][待查:乙][记一笔:丙]');
    assert.deepStrictEqual(
      mixed.research.map((item) => item.kind),
      ['edit', 'lookup', 'note']
    );
  });

  test('「查观众」标记（观众记忆）：摘出来、正文里不出现、一条最多两个', () => {
    const one = DeepSeekClient.parseReply('哈哈他来啦[情绪:happy][查观众:小明]');
    assert.strictEqual(one.text, '哈哈他来啦');
    assert.deepStrictEqual(one.viewerLookups, [{ name: '小明' }]);

    // 纯文本（没有情绪标记）也要认；`|` 后面可以写为什么
    const plain = DeepSeekClient.parseReply('那是谁呀[查观众:小红|想认认人]');
    assert.strictEqual(plain.text, '那是谁呀');
    assert.deepStrictEqual(plain.viewerLookups, [{ name: '小红' }]);

    // JSON 输出模式下也认
    const json = DeepSeekClient.parseReply('{"reply":"来啦[查观众:小明]","emotion":"happy"}');
    assert.strictEqual(json.text, '来啦');
    assert.deepStrictEqual(json.viewerLookups, [{ name: '小明' }]);

    // 一条回复最多两个（别让它刷屏式地查人）
    const many = DeepSeekClient.parseReply('嗯[查观众:甲][查观众:乙][查观众:丙]');
    assert.strictEqual(many.viewerLookups.length, 2);

    // 普通的方括号文本不会被误判成查观众
    assert.deepStrictEqual(DeepSeekClient.parseReply('哈哈哈[doge]这个真可以').viewerLookups, []);
  });

  test('工具标记（最高权限才生效）：`[做:暂停|30]`、`[做:静音]` 都认，正文照样干净', () => {
    const pause = DeepSeekClient.parseReply('行，那我先闭嘴半小时。[情绪:idle][做:暂停|30]');
    assert.strictEqual(pause.text, '行，那我先闭嘴半小时。');
    assert.deepStrictEqual(pause.tools, [{ name: 'pause', arg: '30' }]);

    const mute = DeepSeekClient.parseReply('好，我静音啦～[做:静音]');
    assert.deepStrictEqual(mute.tools, [{ name: 'mute', arg: '' }]);
    assert.strictEqual(mute.text, '好，我静音啦～');

    // 英文写法
    assert.deepStrictEqual(DeepSeekClient.parseReply('ok[tool:resume]').tools, [{ name: 'resume', arg: '' }]);
    // 一条回复最多认 1 个工具调用（多出来的整条丢掉）
    const many = DeepSeekClient.parseReply('好[做:静音][做:暂停|10]');
    assert.strictEqual(many.tools.length, 1, `最多 1 个工具调用，实际 ${JSON.stringify(many.tools)}`);
    assert.strictEqual(many.tools[0].name, 'mute');
    // 认不出来的动作名不算（免得模型自己发明一个）
    assert.deepStrictEqual(DeepSeekClient.parseReply('好玩[doge]').tools, []);
    assert.deepStrictEqual(DeepSeekClient.parseReply('[做:把主播的号删了]').tools, []);
  });

  test('改设定标记（只有开发者模式才生效）：`[改设定:人设|…]`、`[改设定:性格|…]`', () => {
    const persona = DeepSeekClient.parseReply('好，我改好了。[改设定:人设|你是直播间里的猫娘搭档，说话带「喵」。]');
    assert.strictEqual(persona.text, '好，我改好了。');
    assert.strictEqual(persona.settingsEdits.length, 1);
    assert.strictEqual(persona.settingsEdits[0].field, 'systemPrompt');
    assert.strictEqual(persona.settingsEdits[0].text, '你是直播间里的猫娘搭档，说话带「喵」。');

    const style = DeepSeekClient.parseReply('记住了。[改设定:性格|每句话结尾都要加个喵]');
    assert.strictEqual(style.settingsEdits[0].field, 'styleNotes');
    assert.strictEqual(style.settingsEdits[0].text, '每句话结尾都要加个喵');

    // 没写字段名时，整段当人设（模型漏写字段也得认）
    const loose = DeepSeekClient.parseReply('[改设定:新的人设内容]');
    assert.strictEqual(loose.settingsEdits[0].field, 'systemPrompt');
    assert.strictEqual(loose.settingsEdits[0].text, '新的人设内容');

    // 人设里带竖线也不能被剪断
    const piped = DeepSeekClient.parseReply('[改设定:人设|说话要短|像这样]');
    assert.strictEqual(piped.settingsEdits[0].text, '说话要短|像这样');
    // 一次只认一条设定改动
    const many = DeepSeekClient.parseReply('[改设定:人设|甲][改设定:性格|乙]');
    assert.strictEqual(many.settingsEdits.length, 1, `最多 1 条设定改动，实际 ${many.settingsEdits.length}`);
  });

  test('状态名不认识就不算规则（正文照旧留给观众看）', () => {
    // 这是最容易出事的一条：正文里正常说出「规则:」的时候不能被当成配置
    const parsed = DeepSeekClient.parseReply('这条规则: 谁说的算？[情绪:idle]');
    const direct = DeepSeekClient.parseTriggerRules('这条规则: 谁说的算？');
    assert.ok(
      Array.isArray(parsed.triggerRules) && parsed.triggerRules.length === 0,
      `不该解析出规则，实际：${JSON.stringify(parsed.triggerRules)}`
    );
    assert.ok(
      Array.isArray(direct) && direct.length === 0,
      `不该解析出规则，实际：${JSON.stringify(direct)}`
    );
    assert.ok(parsed.text.includes('谁说的算'), `正文被吃掉了：${parsed.text}`);
    assert.strictEqual(DeepSeekClient.findTriggerRules('这条规则: 谁说的算？'), null);
  });

  test('没有「规则:」时不会凭空造出规则', () => {
    assert.deepStrictEqual(rulesOf('哈哈哈[doge]这个真可以'), []);
    assert.deepStrictEqual(rulesOf(''), []);
  });

  console.log('\n模型与思考档位（DeepSeek 2026-09 之后的新参数）');
  await testAsync('思考档位会按设置发出去（low/high/max → reasoning_effort）', async () => {
    for (const level of ['low', 'high', 'max']) {
      const fake = await startFakeServer(() => okReply('好'));
      const client = new DeepSeekClient(() => ({
        apiKey: 'sk-test',
        baseUrl: fake.baseUrl,
        model: 'deepseek-flash',
        thinking: level,
        temperature: 1.1,
        maxTokens: 2000,
        timeoutSec: 10
      }));
      await client.chat([{ role: 'user', content: 'hi' }]);
      const body = fake.received[0].body;
      assert.strictEqual(body.model, 'deepseek-flash');
      assert.strictEqual(body.reasoning_effort, level, `档位 ${level} 没发对`);
      assert.strictEqual(body.thinking, undefined, `档位 ${level} 不该带 thinking 字段`);
      fake.server.close();
    }
  });

  await testAsync('off 档走「关闭思考模式」，不再发 reasoning_effort', async () => {
    const fake = await startFakeServer(() => okReply('好'));
    const client = new DeepSeekClient(() => ({
      apiKey: 'sk-test',
      baseUrl: fake.baseUrl,
      model: 'deepseek-flash',
      thinking: 'off',
      maxTokens: 2000,
      timeoutSec: 10
    }));
    await client.chat([{ role: 'user', content: 'hi' }]);
    const body = fake.received[0].body;
    assert.deepStrictEqual(body.thinking, { type: 'disabled' }, 'off 档应该发 thinking.type=disabled');
    assert.strictEqual(body.reasoning_effort, undefined, 'off 档不该再发 reasoning_effort');
    fake.server.close();
  });

  await testAsync('档位写错时回落到 low，不会把脏值发给 API', async () => {
    const fake = await startFakeServer(() => okReply('好'));
    const client = new DeepSeekClient(() => ({
      apiKey: 'sk-test',
      baseUrl: fake.baseUrl,
      model: 'deepseek-flash',
      thinking: '乱写的',
      maxTokens: 2000,
      timeoutSec: 10
    }));
    await client.chat([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(fake.received[0].body.reasoning_effort, 'low');
    fake.server.close();
  });

  await testAsync('不限制 token 时请求里干脆不带 max_tokens 字段', async () => {
    const fake = await startFakeServer(() => okReply('好'));
    const client = new DeepSeekClient(() => ({
      apiKey: 'sk-test',
      baseUrl: fake.baseUrl,
      model: 'deepseek-flash',
      thinking: 'low',
      maxTokens: 0,
      timeoutSec: 10
    }));
    await client.chat([{ role: 'user', content: 'hi' }]);
    const body = fake.received[0].body;
    assert.strictEqual('max_tokens' in body, false, `不限制时不该发 max_tokens，实际 ${JSON.stringify(body.max_tokens)}`);
    assert.strictEqual(body.reasoning_effort, 'low');
    fake.server.close();
  });

  await testAsync('设了上限时正常发出去；空回复重试会放大它', async () => {
    let call = 0;
    const fake = await startFakeServer(() => {
      call += 1;
      // 第 1 次给空内容（模拟「思考把额度吃光」），第 2 次正常
      if (call === 1) {
        return {
          json: {
            id: 'x',
            choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 50, completion_tokens: 500 }
          }
        };
      }
      return okReply('第二次成功了');
    });
    const client = new DeepSeekClient(() => ({
      apiKey: 'sk-test',
      baseUrl: fake.baseUrl,
      model: 'deepseek-flash',
      thinking: 'low',
      maxTokens: 500,
      timeoutSec: 10
    }));
    const result = await client.chatWithRetry([{ role: 'user', content: 'hi' }]);
    assert.strictEqual(fake.received[0].body.max_tokens, 500, '第一次应该用设置值');
    assert.ok(fake.received[1].body.max_tokens > 500, `重试应该放大额度，实际 ${fake.received[1].body.max_tokens}`);
    // 假接口返回的是 JSON 字符串（okReply 的格式），解析后才是正文
    assert.strictEqual(DeepSeekClient.parseReply(result.content).text, '第二次成功了');
    fake.server.close();
  });

  console.log('\nJSON 输出模式已停用（防回归）');
  test('默认不再强制 JSON 模式', () => {
    // 实测：json_object + 中文长系统提示词 → DeepSeek 返回纯空格，
    // completion_tokens 十几个而 finish_reason 是 stop，8 次里空 7~8 次。
    // 所以这里必须是 false，谁改回 true 谁就把「AI 偶尔不说话」带回来。
    const client = new DeepSeekClient(() => ({ apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:1' }));
    const config = client._config();
    assert.strictEqual(config.useJsonFormat, false, '默认必须是 false');
  });

  test('设置里存了 true 也会被强制关掉（老配置迁移）', () => {
    const { sanitize, defaultSettings, deepMerge } = require('../src/main/settings');
    const merged = deepMerge(defaultSettings(), { persona: { useJsonFormat: true } });
    assert.strictEqual(sanitize(merged).persona.useJsonFormat, false, '老配置里的 true 必须被迁移掉');
  });

  test('联网走法只认 self / model：写错了按默认来，选过的要留住', () => {
    // 这两条路都是「去查」的入口，配置写错不能让它永远失败；也不能把主播选的覆盖掉
    const { sanitize, defaultSettings } = require('../src/main/settings');
    assert.strictEqual(defaultSettings().knowledge.searchMode, 'self', '默认走自研搜索接口');
    assert.strictEqual(sanitize({ knowledge: { searchMode: 'gpt-4' } }).knowledge.searchMode, 'self', '写错了要退回默认');
    assert.strictEqual(sanitize({ knowledge: { searchMode: 'model' } }).knowledge.searchMode, 'model', '选老办法也得留住');
    // 老配置里没有这个字段 → 补默认，不能是 undefined（否则主进程会当成 model）
    assert.strictEqual(sanitize({ knowledge: {} }).knowledge.searchMode, 'self', '老配置要补上默认值');
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
