'use strict';

/**
 * 「模型想查 / 想记」的待办队列 + 内置联网查询
 *   node scripts/test-research.js
 *
 * 全是本地假接口/临时文件，不联网、不花钱。覆盖：
 *   · 队列：增删改、去重、上限、状态流转、落盘往返
 *   · 联网查询（老办法，模型联网）：成功（抽正文/数搜索次数）、HTTP 报错、超时中止、没 Key
 *   · 自研搜索（新接口）：两段请求的形状、排序、搜索词截断、402/429/401/断网、空结果、
 *     以及「整理那步挂了也要能落成草稿」的降级
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ResearchQueue, searchWithDeepSeek, searchViaSearchApi, MAX_ITEMS, SEARCH_QUERY_MAX } = require('../src/main/research');
const { parseDrafts } = require('../src/main/dsh');

let passed = 0;
let failed = 0;

/**
 * 自研搜索接口的假后端：按 URL 分派（搜索 / 整理），并把发出去的东西留下。
 * `search` / `summary` 可以是数组、字符串、Error 或函数，方便造各种失败。
 */
function fakeSearchApi({ search = null, summary = '===知识条目===\n标题：祀\n标签：明日方舟\n正文：六星寒冷辅助。' } = {}) {
  const calls = [];
  const wrap = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  const fail = (status, body) => ({ ok: false, status, text: async () => body });
  const fetchImpl = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ url, body, headers: (init && init.headers) || {} });
    if (url.endsWith('/v1/tools/search')) {
      if (search instanceof Error) throw search;
      if (typeof search === 'function') return search(body);
      return wrap({ results: search || fakeResults() });
    }
    if (url.endsWith('/chat/completions')) {
      if (summary instanceof Error) throw summary;
      if (typeof summary === 'function') return summary(body);
      return wrap({ choices: [{ message: { content: summary } }], usage: { prompt_tokens: 2100, completion_tokens: 190 } });
    }
    throw new Error(`意外的请求：${url}`);
  };
  return { fetchImpl, calls, fail };
}

/** 假搜索结果：默认 5 条、权威度 3、相关度递减 */
function fakeResults(count = 5) {
  return Array.from({ length: count }, (_, i) => ({
    rerank_score: 2.4 - i * 0.1,
    title: `结果${i + 1}`,
    url: `https://e${i + 1}.com/a`,
    snippet: `第${i + 1}条短摘要`,
    summary: `第${i + 1}条的长摘要内容`,
    site_name: `站点${i + 1}`,
    date: '2026-10-16T00:00:00+00:00',
    authority: 3
  }));
}

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

function makeQueue() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-'));
  const file = path.join(dir, 'research.json');
  const queue = new ResearchQueue({ file, logger: { warn() {}, info() {} } });
  return { queue, file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** 一个假的 Anthropic 风格响应（正文块 + 服务端搜索痕迹） */
function fakeSearchResponse({ text = '查到了：明日方舟是塔防。', searches = 2, results = 30 } = {}) {
  const content = [
    { type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'x' } },
    { type: 'web_search_tool_result', tool_use_id: 'st1', content: Array.from({ length: results }, (_, i) => ({ type: 'web_search_result', url: `https://e${i}.com` })) },
    { type: 'text', text: '（思考）' },
    { type: 'text', text }
  ];
  if (searches > 1) content.push({ type: 'server_tool_use', id: 'st2', name: 'web_search', input: { query: 'y' } });
  return { ok: true, status: 200, json: async () => ({ content }) };
}

(async () => {
  console.log('「模型想查 / 想记」待办队列 + 联网查询\n');

  await test('加一条待办：落盘、能读回来、默认 pending', () => {
    const { queue, file, cleanup } = makeQueue();
    try {
      const added = queue.add({ kind: 'lookup', text: '明日方舟', reason: '观众提到了新游戏', source: '来自 小明 的消息' });
      assert.strictEqual(added.ok, true);
      assert.strictEqual(added.duplicate, false);
      assert.strictEqual(added.item.kind, 'lookup');
      assert.strictEqual(added.item.status, 'pending');
      assert.ok(fs.existsSync(file), '要落盘');
      const again = new ResearchQueue({ file, logger: { warn() {} } });
      assert.strictEqual(again.list().length, 1);
      assert.strictEqual(again.list()[0].text, '明日方舟');
      assert.strictEqual(again.list()[0].reason, '观众提到了新游戏');
    } finally {
      cleanup();
    }
  });

  await test('去重：同一条内容在没处理完之前只留一条；处理完 10 分钟内也不再重复', () => {
    const { queue, cleanup } = makeQueue();
    try {
      const first = queue.add({ kind: 'lookup', text: '明日方舟' });
      const same = queue.add({ kind: 'lookup', text: ' 明日  方舟 ' });
      assert.strictEqual(same.duplicate, true, '空格差异也算同一条');
      assert.strictEqual(same.item.id, first.item.id);
      assert.strictEqual(queue.list().length, 1);

      // 处理完之后 10 分钟内还是算重复
      queue.update(first.item.id, { status: 'done' });
      const afterDone = queue.add({ kind: 'lookup', text: '明日方舟' });
      assert.strictEqual(afterDone.duplicate, true);

      // 「想查」和「想记」是两回事，不互相去重
      const note = queue.add({ kind: 'note', text: '明日方舟' });
      assert.strictEqual(note.duplicate, false);
    } finally {
      cleanup();
    }
  });

  await test('空内容不收；状态流转会记 finishedAt', () => {
    const { queue, cleanup } = makeQueue();
    try {
      assert.strictEqual(queue.add({ kind: 'lookup', text: '   ' }).ok, false);
      const item = queue.add({ kind: 'note', text: '下周有联动' }).item;
      queue.update(item.id, { status: 'running' });
      assert.strictEqual(queue.get(item.id).status, 'running');
      assert.strictEqual(queue.get(item.id).finishedAt, '', '跑的时候还不算完成');
      queue.update(item.id, { status: 'done', draftIds: ['p-1'] });
      assert.ok(queue.get(item.id).finishedAt, '完成后要有时间');
      assert.deepStrictEqual(queue.get(item.id).draftIds, ['p-1']);
      assert.strictEqual(queue.count(), 0, '处理完就不算待办');
    } finally {
      cleanup();
    }
  });

  await test('上限：待办永远保留，先挤掉最老的已处理项', () => {
    const { queue, cleanup } = makeQueue();
    try {
      for (let i = 0; i < MAX_ITEMS; i += 1) {
        const item = queue.add({ kind: 'lookup', text: `旧${i}` }).item;
        queue.update(item.id, { status: 'done' });
      }
      const fresh = queue.add({ kind: 'lookup', text: '新的' }).item;
      assert.strictEqual(queue.list().length, MAX_ITEMS, `不该超过 ${MAX_ITEMS} 条`);
      assert.ok(queue.get(fresh.id), '新的要在');
      assert.ok(!queue.list().some((item) => item.text === '旧0'), '最老的已处理项要先被挤掉');
    } finally {
      cleanup();
    }
  });

  await test('清空已处理：待办（pending/running）都留着', () => {
    const { queue, cleanup } = makeQueue();
    try {
      const a = queue.add({ kind: 'lookup', text: '甲' }).item;
      const b = queue.add({ kind: 'lookup', text: '乙' }).item;
      queue.update(a.id, { status: 'done' });
      const removed = queue.clearFinished();
      assert.strictEqual(removed, 1);
      assert.deepStrictEqual(queue.list().map((item) => item.text), ['乙']);
      assert.ok(queue.get(b.id));
      assert.strictEqual(queue.remove(b.id), true);
      assert.strictEqual(queue.list().length, 0);
    } finally {
      cleanup();
    }
  });

  await test('落盘文件坏掉：按空队列处理，不影响软件启动', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-bad-'));
    const file = path.join(dir, 'research.json');
    const warns = [];
    try {
      fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
      const queue = new ResearchQueue({ file, logger: { warn: (m) => warns.push(m) } });
      assert.strictEqual(queue.list().length, 0);
      assert.ok(warns.some((m) => /读不了/.test(m)), `要留下警告：${warns.join(' / ')}`);
      // 坏文件之后还能继续用
      assert.strictEqual(queue.add({ kind: 'lookup', text: '甲' }).ok, true);
      assert.strictEqual(queue.list().length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('联网查询：抽出正文、数出搜索次数与结果条数', async () => {
    let sent = null;
    const result = await searchWithDeepSeek({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      query: '查一下明日方舟',
      fetchImpl: async (url, init) => {
        sent = { url, init, body: JSON.parse(init.body) };
        return fakeSearchResponse({ searches: 2, results: 30 });
      }
    });
    assert.strictEqual(result.ok, true, result.message);
    assert.ok(result.text.includes('明日方舟'), `正文没抽出来：${result.text}`);
    assert.strictEqual(result.searches, 2);
    assert.strictEqual(result.results, 30);
    // 请求形状：Anthropic 兼容接口 + 原生 web_search 工具
    assert.strictEqual(sent.url, 'https://api.deepseek.com/anthropic/v1/messages');
    assert.strictEqual(sent.init.headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(sent.init.headers['x-api-key'], 'sk-test');
    assert.deepStrictEqual(sent.body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]);
    assert.strictEqual(sent.body.messages[0].role, 'user');
  });

  await test('联网查询：用时算的是「整份回复读完」，不是「响应头回来」', async () => {
    // 真机上踩过：`fetch` 在**响应头**回来时就 resolve，正文还要再等几秒（联网搜索尤其慢）。
    // 旧代码在 fetch 之后立刻算 ms，于是日志里显示「用时 0 秒」，看着像没查就出结果了。
    const started = Date.now();
    const result = await searchWithDeepSeek({
      apiKey: 'sk-test',
      query: '查一下明日方舟',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: () => new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: 'text', text: '查到了' }] }), 150))
      })
    });
    const elapsed = Date.now() - started;
    assert.strictEqual(result.ok, true, result.message);
    assert.ok(result.ms >= 120, `ms 应包含读正文的时间（实测 elapsed=${elapsed}ms、result.ms=${result.ms}ms）`);
  });

  await test('联网查询：HTTP 报错/超时/没 Key 都变成可读的理由，不抛异常', async () => {
    const http = await searchWithDeepSeek({
      apiKey: 'sk-test',
      query: 'x',
      fetchImpl: async () => ({ ok: false, status: 402, text: async () => 'Insufficient Balance' })
    });
    assert.strictEqual(http.ok, false);
    assert.ok(/402/.test(http.message) && /Insufficient/.test(http.message), http.message);

    const timeout = await searchWithDeepSeek({
      apiKey: 'sk-test',
      query: 'x',
      timeoutMs: 10,
      fetchImpl: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
    });
    assert.strictEqual(timeout.ok, false);
    assert.ok(/超过|中止/.test(timeout.message), timeout.message);

    const noKey = await searchWithDeepSeek({ apiKey: '', query: 'x' });
    assert.strictEqual(noKey.ok, false);
    assert.ok(/API Key/.test(noKey.message), noKey.message);

    const empty = await searchWithDeepSeek({ apiKey: 'sk-test', query: '   ' });
    assert.strictEqual(empty.ok, false);
  });

  // ---------------------------------------------------- 自研搜索（2026-10-17 开放的新接口）

  await test('自研搜索：搜一次 → 让模型照着结果整理，两段请求的形状都对', async () => {
    const { fetchImpl, calls } = fakeSearchApi();
    const result = await searchViaSearchApi({
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      keyword: '明日方舟 终末地 祀',
      oriQuestion: '观众问祀什么时候出',
      task: '查一下「祀」，整理成 1~3 条知识\n===知识条目===',
      fetchImpl
    });
    assert.strictEqual(result.ok, true, result.message);
    assert.strictEqual(result.degraded, false);
    assert.ok(result.text.includes('祀'), `整理结果没拿到：${result.text}`);
    assert.strictEqual(result.searches, 1);
    assert.strictEqual(result.results, 5);
    assert.strictEqual(result.sources.length, 5);
    assert.strictEqual(result.sources[0].site, '站点1');
    assert.strictEqual(result.sources[0].date, '2026-10-16');
    assert.strictEqual(calls.length, 2);

    const searchCall = calls[0];
    assert.strictEqual(searchCall.url, 'https://api.deepseek.com/v1/tools/search');
    assert.strictEqual(searchCall.headers.authorization, 'Bearer sk-test');
    assert.strictEqual(searchCall.body.query, '明日方舟 终末地 祀');
    assert.strictEqual(searchCall.body.ori_question, '观众问祀什么时候出');
    assert.strictEqual(searchCall.body.need_content, false, '不要正文：长摘要够用，正文只会白烧 token');
    assert.ok(searchCall.body.count >= 1 && searchCall.body.count <= 50, `count 越界：${searchCall.body.count}`);

    const askCall = calls[1];
    assert.strictEqual(askCall.url, 'https://api.deepseek.com/chat/completions');
    assert.strictEqual(askCall.body.thinking.type, 'disabled', '整理这一步不该开思考模式');
    assert.ok(!('reasoning_effort' in askCall.body), '关思考时不能再传 reasoning_effort');
    assert.ok(!askCall.body.tools, '整理这一步不需要工具');
    assert.ok(askCall.body.messages[0].content.includes('第1条的长摘要内容'), '摘要要进提示词');
    assert.ok(askCall.body.messages[0].content.includes('站点1 · 2026-10-16 · 权威度 3'), '站点/日期/权威度要带上，模型才好判断');
  });

  await test('自研搜索：权威度高的结果排前面（相关度为主，权威度加成）', async () => {
    const { fetchImpl, calls } = fakeSearchApi({
      search: [
        { ...fakeResults(1)[0], title: '一般站', rerank_score: 2.0, authority: 0 },
        { ...fakeResults(1)[0], title: '权威站', rerank_score: 1.9, authority: 4 }
      ]
    });
    await searchViaSearchApi({ apiKey: 'sk-test', keyword: 'x', fetchImpl });
    const prompt = calls[1].body.messages[0].content;
    const first = prompt.indexOf('[1] 权威站');
    const second = prompt.indexOf('[2] 一般站');
    assert.ok(first >= 0 && second >= 0, `顺序不对：${prompt.slice(0, 200)}`);
    assert.ok(first < second, '权威度 4 的那条应该排第 1');
  });

  await test('自研搜索：搜索词超 128 字先截断（接口超了直接 400）', async () => {
    const { fetchImpl, calls } = fakeSearchApi();
    const long = '明日方舟'.repeat(40); // 160 字
    const warns = [];
    await searchViaSearchApi({ apiKey: 'sk-test', keyword: long, fetchImpl, logger: { warn: (m) => warns.push(m) } });
    assert.ok(calls[0].body.query.length <= SEARCH_QUERY_MAX, `没截断：${calls[0].body.query.length} 字`);
    assert.ok(warns.some((m) => /太长/.test(m)), `要留一句警告：${warns.join(' / ')}`);
  });

  await test('自研搜索：402 余额不足翻成人话（最要命的那种，必须一眼看出来）', async () => {
    const { fetchImpl, fail } = fakeSearchApi({ search: () => fail(402, '{"error":{"message":"Insufficient Balance"}}') });
    const result = await searchViaSearchApi({ apiKey: 'sk-test', keyword: 'x', fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'search');
    assert.ok(/余额不足/.test(result.message) && /充值/.test(result.message), result.message);
  });

  await test('自研搜索：429 限速 / 401 没 Key / 连不上 都是可读理由，不抛异常', async () => {
    const limited = await searchViaSearchApi({
      apiKey: 'sk-test',
      keyword: 'x',
      fetchImpl: fakeSearchApi({ search: () => ({ ok: false, status: 429, text: async () => 'too many' }) }).fetchImpl
    });
    assert.ok(/太密|每秒/.test(limited.message), limited.message);

    const denied = await searchViaSearchApi({
      apiKey: 'sk-test',
      keyword: 'x',
      fetchImpl: fakeSearchApi({ search: () => ({ ok: false, status: 401, text: async () => 'bad key' }) }).fetchImpl
    });
    assert.ok(/API Key/.test(denied.message), denied.message);

    const offline = await searchViaSearchApi({
      apiKey: 'sk-test',
      keyword: 'x',
      fetchImpl: fakeSearchApi({ search: new Error('getaddrinfo ENOTFOUND api.deepseek.com') }).fetchImpl
    });
    assert.strictEqual(offline.ok, false);
    assert.ok(/连不上/.test(offline.message), offline.message);
  });

  await test('自研搜索：空结果算「没搜到」，不算查成功（也好让上层去兜底）', async () => {
    const { fetchImpl } = fakeSearchApi({ search: [] });
    const result = await searchViaSearchApi({ apiKey: 'sk-test', keyword: '随便什么', fetchImpl });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.kind, 'empty');
    assert.ok(/没搜到/.test(result.message), result.message);
  });

  await test('自研搜索：没 Key / 空查询直接拒，不发请求', async () => {
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      throw new Error('不该发请求');
    };
    assert.strictEqual((await searchViaSearchApi({ apiKey: '', keyword: 'x', fetchImpl })).ok, false);
    assert.strictEqual((await searchViaSearchApi({ apiKey: 'sk-test', keyword: '   ', fetchImpl })).ok, false);
    assert.strictEqual(called, 0, '没 Key / 空查询时不该真的发请求');
  });

  await test('自研搜索：整理那步挂了 → 直接收摘要，仍然是「查到了」', async () => {
    const { fetchImpl } = fakeSearchApi({ summary: () => ({ ok: false, status: 500, text: async () => 'boom' }) });
    const result = await searchViaSearchApi({ apiKey: 'sk-test', keyword: '祀', fetchImpl, logger: { warn() {} } });
    assert.strictEqual(result.ok, true, '整理失败不能算整条查询失败');
    assert.strictEqual(result.degraded, true);
    assert.ok(result.text.includes('===知识条目==='), `降级也要能进待审：${result.text}`);
    // 关键：降级输出必须能被 parseDrafts 拆成草稿，否则主播还是白等一场
    const drafts = parseDrafts(result.text, { source: '联网查 · 祀', engine: '自研搜索' });
    assert.strictEqual(drafts.length, 2, `降级输出应拆成 2 条，实际 ${drafts.length}`);
    assert.ok(drafts[0].content.includes('第1条的长摘要内容'), drafts[0].content);
    assert.strictEqual(drafts[0].tags, '站点1');
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();

