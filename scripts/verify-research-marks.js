'use strict';

/**
 * 真机验证：模型到底会不会**主动提需求**（「想查 / 想记」）。
 *   node scripts/verify-research-marks.js            跑 4 种典型弹幕（4 次普通回复调用）
 *   node scripts/verify-research-marks.js --search   额外把第一条「想查」真查一次（多花一次联网的钱）
 *
 * 为什么需要这个脚本：`test-research.js` / `test-pipeline.js` 能证明
 * 「标记解析 → 入队 → 从正文里摘掉」这几段代码是对的，但证明不了**真模型会不会照提示词提需求** ——
 * 那取决于第 9 条提示词写得够不够清楚、模型听不听话。所以这里用主播自己
 * `data/settings.json` 里的 Key / 模型 / 人设，真跑几次「弹幕 → 回复」，打印：
 *   · 模型原话（含标记）、摘出来的标记、进队列的待办；
 *   · 观众看到的正文里**有没有**漏出标记（漏了就是 bug：观众会看到 `[待查:…]`）；
 *   · 纯闲聊会不会乱提（乱提 = 面板里堆一堆没用的待办，还诱导主播点「去查」白花钱）。
 *
 * ⚠️ 全程只读：不写 `data/`、不碰真知识库（待办队列落在系统临时目录，跑完就删）。
 * ⚠️ 会花钱：默认 4 次短回复（每次约 1~2 千输入 token），加 `--search` 再多一次联网调用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Copilot } = require('../src/main/copilot');
const { BilibiliDanmakuClient } = require('../src/main/danmaku');
const { ResearchQueue, searchWithDeepSeek } = require('../src/main/research');
const { parseDrafts } = require('../src/main/dsh');
const { sanitize } = require('../src/main/settings');

const WITH_SEARCH = process.argv.includes('--search');
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');

/** 四种典型弹幕。`expect` 是「期望的行为」，不是硬断言（模型有判断权，硬断言只会天天误报） */
const SCENARIOS = [
  {
    id: 'lookup-price',
    title: '问到「它不可能知道」的实时信息 → 期望提「想查」',
    text: '《无限机兵》现在多少钱？',
    expect: 'lookup'
  },
  {
    id: 'lookup-unknown',
    title: '提到一个它没准没听过的比赛 → 期望提「想查」',
    text: '你听说过「星轨杯」这个比赛吗',
    expect: 'lookup'
  },
  {
    id: 'note-fact',
    title: '出现以后回答观众会用到的安排 → 期望提「想记」（不提也算合格，但值得看一眼）',
    text: '下周六晚上八点我们要和隔壁联动直播',
    expect: 'note-or-none'
  },
  {
    id: 'chat-only',
    title: '纯闲聊 → 期望**一条都不提**（这是不白花钱的关键）',
    text: '哈哈哈哈主播太逗了',
    expect: 'none'
  }
];

// ---------------------------------------------------------------- 真机报文

/** 真实抓包格式的弹幕命令（未登录，uid=0）——和 test-pipeline.js 用的是同一份形状 */
function realDanmakuCmd(text, name, idSeed = 1) {
  return {
    cmd: 'DANMU_MSG',
    dm_v2: '',
    info: [
      [
        0, 1, 25, 16777215, 1791561665953, 1791561665000 + idSeed, 0, '26187a4d', 0, 0, 0, '', 0, '{}', '{}',
        {
          extra: JSON.stringify({ content: text }),
          mode: 0,
          user: { base: { name, is_mystery: false }, uid: 0, wealth: { level: 9 } }
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

/** 把真实报文喂给一个弹幕客户端，取出 danmaku 事件（走真实解析路径） */
function parseViaClient(payload, counter) {
  const client = new BilibiliDanmakuClient({
    roomId: '1234567',
    logger: { debug() {}, info() {}, warn() {}, error() {} }
  });
  const events = [];
  client.on('danmaku', (event) => events.push(event));
  client._dispatch(payload);
  const event = events[0] || {};
  return { ...event, id: event.id || `probe-${counter}`, ts: Date.now() };
}

const MARK_LEAK = /[[【]\s*(待查|想查|查一下|lookup|记一笔|记下|记住|note)\s*[:：]/;

// ---------------------------------------------------------------- 读配置

let realSettings = {};
try {
  realSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (error) {
  console.error(`读不到 ${SETTINGS_PATH}：${error.message}`);
  process.exit(1);
}
const settings = sanitize(realSettings);
const apiKey = String((settings.api || {}).apiKey || '').trim();
if (!apiKey) {
  console.error('配置里没有 DeepSeek Key，先到「DeepSeek API」页填一个再跑');
  process.exit(1);
}

// 只把「过滤/频率」改成不会互相干扰的值，其余（Key / 模型 / 人设 / 性格）全用主播真实的配置
const probeSettings = {
  ...settings,
  danmaku: {
    ...settings.danmaku,
    triggerMode: 'all',
    ignoreKeywords: '',
    blockedUsers: '',
    maxLength: 200,
    minIntervalSec: 0,
    batchWindowMs: 1,
    maxBatch: 8
  }
};
const store = { get: () => probeSettings, patch: () => {} };

const logs = [];
const logger = {
  debug: (m) => logs.push(`[debug] ${m}`),
  info: (m) => logs.push(`[info] ${m}`),
  warn: (m) => logs.push(`[warn] ${m}`),
  error: (m) => logs.push(`[error] ${m}`)
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-research-'));
const queueFile = path.join(tempDir, 'research.json');
const queue = new ResearchQueue({ file: queueFile, logger });

(async () => {
  console.log('「模型会不会主动提需求」真机验证\n');
  console.log(`模型：${settings.api.model}`);
  console.log(`接口：${settings.api.baseUrl}`);
  console.log(`搭档：${settings.persona.botName}（主播称呼「${settings.persona.anchorName || '主播'}」）`);
  console.log(`待办队列（临时，跑完删）：${queueFile}`);
  console.log(`联网那一步：${WITH_SEARCH ? '会真查一次（多花一次钱）' : '跳过（加 --search 才真查）'}\n`);

  const results = [];
  let leaked = false;

  for (let index = 0; index < SCENARIOS.length; index += 1) {
    const scenario = SCENARIOS[index];
    console.log(`[${index + 1}/${SCENARIOS.length}] ${scenario.title}`);
    console.log(`  弹幕：${scenario.text}`);

    const copilot = new Copilot({ store, logger, research: queue, onResearch: () => {} });
    // 抓住模型原话：`ask()` 在「只有标记没有正文」时返回 null，光看事件会漏掉这种情况
    const raws = [];
    const original = copilot.llm.chatWithRetry.bind(copilot.llm);
    copilot.llm.chatWithRetry = async (...args) => {
      const result = await original(...args);
      raws.push(result);
      return result;
    };
    const visible = [];
    copilot.on('reply', (payload) => visible.push(String((payload && payload.text) || '')));
    // 「她主动问 → 主播回一句 → 去办」这一段不花钱：问话和判定都是本地的
    const approved = [];
    copilot.on('research-approve', (payload) => approved.push(payload));

    if (index === 0) {
      const prompt = copilot.buildSystemPrompt();
      const hasRule = prompt.includes('[待查:') && prompt.includes('[记一笔:');
      console.log(`  ${hasRule ? '✓' : '✗'} 系统提示词里有第 9 条标记说明（${prompt.length} 字符）`);
      if (!hasRule) {
        console.log('  ! 提示词里没有标记说明：主播可能整份改过系统提示词（systemPromptOverride），这条链路不会生效');
      }
    }

    const before = new Set(queue.list().map((item) => item.id));
    const started = Date.now();
    let error = '';
    try {
      await copilot.ask([parseViaClient(realDanmakuCmd(scenario.text, '试弹幕', index + 1), index + 1)]);
    } catch (problem) {
      error = problem.message || String(problem);
    }
    const ms = Date.now() - started;

    const added = queue.list().filter((item) => !before.has(item.id));
    const raw = raws.map((item) => String(item.content || '')).join(' ⏎ ');
    const usage = (raws[0] && raws[0].usage) || {};
    const text = visible.join(' / ') || '(没有可见回复)';
    const hasLeak = MARK_LEAK.test(text);
    if (hasLeak) leaked = true;

    console.log(`  模型原话：${raw ? raw.replace(/\s+/g, ' ').slice(0, 200) : '(空)'}`);
    console.log(`  观众看到：${text}`);
    console.log(`  摘出的待办：${added.length ? added.map((item) => `${item.kind === 'lookup' ? '🔎想查' : '📝想记'}「${item.text}」${item.reason ? `（${item.reason}）` : ''}`).join('，') : '（没有）'}`);
    if (added.length) console.log(`  来源标注：${added[0].source}`);
    console.log(
      `  ${ms} 毫秒${usage.total_tokens ? `，${usage.total_tokens} token` : ''}${
        raws.length > 1 ? `，调用了 ${raws.length} 次（首次空回复后重试）` : ''
      }${error ? `，✗ 出错：${error}` : ''}`
    );
    console.log(`  ${hasLeak ? '✗ 正文里漏出了标记（观众会看到）' : '✓ 正文里没有标记'}`);

    // 她不光收进待办：还会**主动开口问一句**，然后主播回一句话就办（这一段全在本地，不花钱）
    if (added.length) {
      const item = added[0];
      copilot.enqueueResearchAsk(item);
      const asked = copilot.pumpResearchAsk();
      console.log(`  她会问：${asked ? asked.text : '(没问出口)'}`);
      const answer = scenario.expect === 'note-or-none' ? '记下来' : '查';
      const callsBefore = raws.length;
      const ack = await copilot.talk(answer); // eslint-disable-line no-await-in-loop
      const ok = approved.length > 0 && ack && ack.text;
      console.log(
        `  ${ok ? '✓' : '✗'} 主播回「${answer}」→ ${ack ? ack.text : '(没有应答)'}` +
          `${raws.length === callsBefore ? '（没有多花一次模型调用）' : '（⚠️ 又调了一次模型）'}`
      );
      if (ok) {
        // 这条已经同意过了，后面统计「一共提了几条」时把它算上
        item.__approved = true;
      }
    }
    console.log('');

    results.push({ scenario, added, text, raw, ms, error, leak: hasLeak, usage });
  }

  // -------------------------------------------------------------- 联网那一步
  let searchReport = null;
  const firstLookup = results.flatMap((item) => item.added).find((item) => item.kind === 'lookup');
  if (WITH_SEARCH && firstLookup) {
    console.log('[5/5] 真去联网查一次（走软件里那条内置引擎）…');
    const task =
      `查一下「${firstLookup.text}」，把它整理成 1~3 条直播时能用上的知识。` +
      '只写确定的信息（版本、类型、玩法/看点、价格这类），不确定的宁可不写。';
    const found = await searchWithDeepSeek({
      apiKey,
      baseUrl: settings.api.baseUrl,
      model: settings.api.model,
      query: task,
      timeoutMs: Math.max(30000, Number(settings.knowledge.dshTimeoutSec || 300) * 1000),
      logger
    });
    if (!found.ok) {
      console.log(`  ✗ 查询失败：${found.message}\n`);
    } else {
      const drafts = parseDrafts(found.text, { source: `联网查 · ${firstLookup.text}`, engine: 'builtin' });
      console.log(
        `  ✓ ${Math.round(found.ms / 1000)} 秒，${found.searches} 次服务端搜索，${found.results} 条结果，` +
          `解析出 ${drafts.length} 条待审草稿（**没有写入知识库**，这里只是展示会写成什么）`
      );
      for (const draft of drafts) console.log(`    · ${draft.title}：${String(draft.content).replace(/\s+/g, ' ').slice(0, 80)}…`);
      console.log('');
      searchReport = { ok: true, ms: found.ms, searches: found.searches, results: found.results, drafts: drafts.length };
    }
  } else if (WITH_SEARCH) {
    console.log('· 模型这次没提「想查」，跳过联网那一步（--search 需要有「想查」待办才有意义）\n');
  }

  // -------------------------------------------------------------- 汇总
  const lookupHits = results.filter((item) => item.scenario.expect === 'lookup' && item.added.some((x) => x.kind === 'lookup'));
  const chat = results.find((item) => item.scenario.expect === 'none');
  const chatNoisy = Boolean(chat && chat.added.length);
  const anyError = results.filter((item) => item.error);

  console.log('===== 结果 =====');
  console.log(`  ${lookupHits.length ? '✓' : '✗'} 「该提」的场景里提了 ${lookupHits.length} 次（共 2 次机会）`);
  console.log(`  ${chatNoisy ? '✗' : '✓'} 纯闲聊${chatNoisy ? `也提了 ${chat.added.length} 条（会白花钱，提示词要收紧）` : '一条都没提'}`);
  console.log(`  ${leaked ? '✗' : '✓'} 观众可见的正文里${leaked ? '漏出了标记' : '没有标记'}`);
  const askedAll = results.filter((item) => item.added.length);
  const approvedAll = askedAll.filter((item) => item.added[0].__approved);
  console.log(
    `  ${askedAll.length && approvedAll.length === askedAll.length ? '✓' : askedAll.length ? '✗' : '·'} ` +
      `她主动问 + 主播一句话同意：${approvedAll.length}/${askedAll.length} 条走通（判定全在本地，不花模型调用）`
  );
  const noteCase = results.find((item) => item.scenario.expect === 'note-or-none');
  if (noteCase && !noteCase.added.length) console.log('  · 「值得记的事实」那条这次没提（合格，但可以看看是不是提示词偏保守）');
  if (anyError.length) for (const item of anyError) console.log(`  ✗ ${item.scenario.id} 调用出错：${item.error}`);
  if (searchReport && searchReport.ok) {
    console.log(`  ✓ 内置联网查询可用：${Math.round(searchReport.ms / 1000)} 秒、${searchReport.results} 条结果、${searchReport.drafts} 条待审草稿`);
  }
  console.log(`\n队列文件里留下的记录（临时目录，跑完删除）：${queue.list().length} 条`);

  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    /* 临时目录删不掉不影响结论 */
  }

  const failed = leaked || chatNoisy || lookupHits.length === 0 || anyError.length > 0;
  if (failed) {
    console.log('\n✗ 有需要改的地方，看上面标 ✗ 的那几行（模型原话都打出来了，方便判断是提示词问题还是解析问题）');
    process.exit(1);
  }
  console.log('\n✓ 模型会照提示词主动提需求：该提的提了、闲聊不乱提、观众看不到标记');
})().catch((error) => {
  console.error(`\n跑不下去：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
