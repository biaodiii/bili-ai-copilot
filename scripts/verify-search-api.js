'use strict';

/**
 * 实测「查资料」两条路的差别：老的 Anthropic 兼容 + 服务端 web_search
 * vs 2026-10-17 新开放的自研 Search / Fetch 接口。
 *
 * 为什么要这个脚本：换不换路不能拍脑袋 —— 用时、花了多少 token、
 * 结果里有没有权威度和日期，都得用真 Key 跑一遍看数。跑完不留痕，
 * 只打印（**不会**打印 API Key）。
 *
 * 用法：
 *   node scripts\verify-search-api.js                 # 用默认查询词
 *   node scripts\verify-search-api.js "终末地 干员 祀"  # 指定查询词
 *
 * 计费提醒：Search / Fetch 每次成功 0.005 元，同一条查询词跑一遍约 0.01~0.03 元。
 */

const fs = require('fs');
const path = require('path');

const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');

/** 价格（元 / 百万 token、元 / 千次），高峰时段是空闲的两倍，这里按空闲算，宁可少估 */
const PRICE = { input: 1, output: 4, perSearch: 5 / 1000 };

let api = {};
try {
  const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  api = data.api || {};
} catch (error) {
  console.error(`读不到 ${settingsPath}：${error.message}`);
  process.exit(1);
}

const key = String(api.apiKey || '').trim();
const root = String(api.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
const model = String(api.model || 'deepseek-flash');
if (!key) {
  console.error('配置里没有 api.apiKey，先到面板的「DeepSeek API」页填一个');
  process.exit(1);
}

const query = String(process.argv[2] || '明日方舟 终末地 干员 祀').trim();

function ms(started) {
  return Date.now() - started;
}

function line(char = '-') {
  console.log(char.repeat(64));
}

/** 1. 自研 Search 接口 */
async function probeSearch() {
  console.log(`\n【1】自研 Search 接口  POST /v1/tools/search`);
  const started = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
  try {
    const response = await fetch(`${root}/v1/tools/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, count: 5, ori_question: query, need_content: false }),
      signal: controller ? controller.signal : undefined
    });
    const text = await response.text();
    const elapsed = ms(started);
    if (!response.ok) {
      console.log(`  ✗ HTTP ${response.status}（${elapsed}ms）：${text.slice(0, 200)}`);
      return null;
    }
    const payload = JSON.parse(text);
    const results = Array.isArray(payload.results) ? payload.results : [];
    console.log(`  ✓ HTTP ${response.status}，用时 ${elapsed}ms，结果 ${results.length} 条`);
    results.forEach((item, index) => {
      const title = String(item.title || '(无标题)').slice(0, 40);
      const site = String(item.site_name || '-');
      const date = String(item.date || '-').slice(0, 10);
      const summary = String(item.summary || '');
      console.log(
        `  ${index + 1}. ${title}\n     站点=${site} 日期=${date} 权威=${item.authority} 排序=${item.rerank_score} 长摘要=${summary.length}字`
      );
      console.log(`     ${String(item.url || '')}`);
    });
    if (results.length) {
      console.log(`  第一条长摘要：${String(results[0].summary || '').slice(0, 120)}…`);
    }
    return { elapsed, results, billable: results.length > 0 };
  } catch (error) {
    console.log(`  ✗ 失败（${ms(started)}ms）：${error.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 2. 自研 Fetch 接口（拿上一步第一条的链接） */
async function probeFetch(url) {
  console.log(`\n【2】自研 Fetch 接口  POST /v1/tools/fetch`);
  if (!url) {
    console.log('  - 跳过（上一步没拿到链接）');
    return null;
  }
  const started = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
  try {
    const response = await fetch(`${root}/v1/tools/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ url }),
      signal: controller ? controller.signal : undefined
    });
    const text = await response.text();
    const elapsed = ms(started);
    if (!response.ok) {
      console.log(`  ✗ HTTP ${response.status}（${elapsed}ms）：${text.slice(0, 200)}`);
      return null;
    }
    const payload = JSON.parse(text);
    const content = String(payload.content || '');
    console.log(`  ✓ HTTP ${response.status}，用时 ${elapsed}ms，标题「${String(payload.title || '')}」`);
    console.log(`  正文 ${content.length} 字，开头：${content.slice(0, 120).replace(/\s+/g, ' ')}…`);
    return { elapsed, length: content.length, billable: content.length > 0 };
  } catch (error) {
    console.log(`  ✗ 失败（${ms(started)}ms）：${error.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 3. 现在在用的那条路：Anthropic 兼容 + 服务端 web_search */
async function probeLegacy() {
  console.log(`\n【3】现在在用的路  POST /anthropic/v1/messages + web_search 工具`);
  const started = Date.now();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 180000) : null;
  try {
    const response = await fetch(`${root}/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        authorization: `Bearer ${key}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: `请联网查一下「${query}」，然后用两三句话把查到的关键事实说清楚，不确定的地方要说明。`
          }
        ],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }]
      }),
      signal: controller ? controller.signal : undefined
    });
    const text = await response.text();
    const elapsed = ms(started);
    if (!response.ok) {
      console.log(`  ✗ HTTP ${response.status}（${elapsed}ms）：${text.slice(0, 200)}`);
      return null;
    }
    const payload = JSON.parse(text);
    const blocks = Array.isArray(payload.content) ? payload.content : [];
    let out = '';
    let searches = 0;
    let results = 0;
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') out += block.text;
      if (block.type === 'server_tool_use' && block.name === 'web_search') searches += 1;
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) results += block.content.length;
    }
    const usage = payload.usage || {};
    console.log(`  ✓ HTTP ${response.status}，用时 ${elapsed}ms，服务端搜索 ${searches} 次 / 拿到 ${results} 条`);
    console.log(
      `  用量：输入 ${usage.input_tokens || 0} token，输出 ${usage.output_tokens || 0} token，缓存命中 ${usage.cache_read_input_tokens || 0} token`
    );
    console.log(`  回答：${out.replace(/\s+/g, ' ').trim().slice(0, 160)}…`);
    return { elapsed, usage, searches, billable: out.trim().length > 0 };
  } catch (error) {
    console.log(`  ✗ 失败（${ms(started)}ms）：${error.message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cost(tokensIn, tokensOut) {
  return (tokensIn / 1e6) * PRICE.input + (tokensOut / 1e6) * PRICE.output;
}

/**
 * 4. 软件里真正跑的那条函数（自研搜索 + 一步整理），端到端验证。
 *
 * 前面几段只是「接口能不能调通」，这一段才是「面板上点『去查』会发生什么」：
 * 搜索 → 整理 → `parseDrafts` 能不能拆出知识条目。拆不出来，前面再绿也白搭。
 */
async function probeSelfPath() {
  console.log('\n【4】软件里的那条路  searchViaSearchApi()  （面板默认走这条）');
  const { searchViaSearchApi } = require('../src/main/research');
  const { parseDrafts } = require('../src/main/dsh');
  const started = Date.now();
  const result = await searchViaSearchApi({
    apiKey: key,
    baseUrl: root,
    model,
    keyword: query,
    oriQuestion: query,
    task:
      `查一下「${query}」，把它整理成 1~3 条直播时能用上的知识。只写确定的信息，不确定的宁可不写。` +
      '\n===知识条目===\n标题：<一句话标题>\n标签：<逗号分隔，可以留空>\n正文：<这条知识的内容，2~5 句，写清楚就够>',
    logger: { warn: (message) => console.log(`  ⚠ ${message}`) }
  });
  const elapsed = ms(started);
  if (!result.ok) {
    console.log(`  ✗ 没跑通（${elapsed}ms）：${result.message}`);
    return null;
  }
  console.log(
    `  ✓ 跑通：${elapsed}ms（搜索 ${result.stats.searchMs}ms + 整理 ${result.stats.summarizeMs}ms）` +
      `${result.degraded ? ' ⚠ 整理那步降级了，收的是摘要' : ''}`
  );
  console.log(`  搜索到 ${result.results} 条，用时 ${result.stats.searchMs}ms；整理用量：输入 ${result.usage.input} / 输出 ${result.usage.output} token`);
  for (const source of result.sources.slice(0, 3)) {
    console.log(`    · ${source.site} · ${source.date} · 权威 ${source.authority} · ${source.title.slice(0, 30)}`);
  }
  const drafts = parseDrafts(result.text, { source: `联网查 · ${query}`, engine: '自研搜索' });
  console.log(`  解析成 ${drafts.length} 条待审草稿：`);
  for (const draft of drafts) {
    console.log(`    [${draft.title}] ${draft.content.replace(/\s+/g, ' ').slice(0, 100)}…`);
  }
  const summarizeCost = cost(result.usage.input, result.usage.output);
  console.log(
    `  这一条合计约 ${(PRICE.perSearch + summarizeCost).toFixed(4)} 元（搜索 ${PRICE.perSearch} + 整理 ${summarizeCost.toFixed(4)}）`
  );
  return { elapsed, drafts: drafts.length, degraded: result.degraded };
}

async function main() {
  console.log(`查询词：${query}`);
  console.log(`接口：${root}    模型：${model}`);

  const search = await probeSearch();
  const fetchResult = await probeFetch(search && search.results[0] && search.results[0].url);
  const legacy = await probeLegacy();
  const selfPath = await probeSelfPath();

  line('=');
  console.log('结论（按空闲时段单价估，只算这一次查询）：');
  if (search) {
    const searchCost = search.billable ? PRICE.perSearch : 0;
    console.log(`  搜索接口：一条 ${search.elapsed}ms，计费 ${searchCost} 元`);
  } else {
    console.log('  搜索接口：这次没跑通');
  }
  if (selfPath) {
    console.log(
      `  新路（自研搜索 + 整理）：${selfPath.elapsed}ms 出 ${selfPath.drafts} 条草稿` +
        `${selfPath.degraded ? '（整理降级了）' : ''}`
    );
  } else {
    console.log('  新路：这次没跑通');
  }
  if (legacy) {
    const usage = legacy.usage || {};
    const tokensIn = Number(usage.input_tokens || 0);
    const tokensOut = Number(usage.output_tokens || 0);
    const tokenCost = cost(tokensIn, tokensOut);
    const searchCost = legacy.searches * PRICE.perSearch;
    console.log(
      `  老路（模型联网）：一次做完 ${legacy.elapsed}ms，token ${tokenCost.toFixed(4)} 元（输入 ${tokensIn} / 输出 ${tokensOut}）` +
        ` + 服务端搜索 ${legacy.searches} 次 ${searchCost.toFixed(4)} 元（11 月 1 日前不计费）` +
        ` ≈ ${(tokenCost + searchCost).toFixed(4)} 元`
    );
  } else {
    console.log('  老路：这次没跑通');
  }
  if (fetchResult) {
    console.log(`  Fetch：${fetchResult.elapsed}ms，正文 ${fetchResult.length} 字，计费 ${fetchResult.billable ? PRICE.perSearch : 0} 元`);
  }
  line('=');
}

main().catch((error) => {
  console.error(`跑挂了：${error && error.stack}`);
  process.exit(1);
});
