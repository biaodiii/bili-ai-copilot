'use strict';

/**
 * 静态一致性审计（不启动界面也能发现大部分低级错误）
 *   node scripts/audit.js
 *
 * 检查项：
 *   1. 渲染层用到的每个 DOM id，HTML 里是否真的存在（拼错会静默失效）
 *   1b. 设置绑定表里的控件 id / 输出位 id 在 HTML 里是否真的存在（绑定会静默失效）
 *   2. preload 暴露的每个 invoke 通道，主进程是否有 ipcMain.handle
 *   3. preload 订阅的每个事件通道，主进程是否真的会 send
 *   4. HTML 里声明的 id 是否有重复
 *   5. HTML 引用的 css / js 文件是否存在
 *   6. 一个界面引用的所有脚本能否共存（防全局重名）、设置绑定是否有默认值
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let problems = 0;
let checks = 0;

function fail(message) {
  problems += 1;
  console.log(`  ✗ ${message}`);
}

function ok(message) {
  checks += 1;
  console.log(`  ✓ ${message}`);
}

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function unique(list) {
  return [...new Set(list)];
}

// ---------------------------------------------------------------- 1. DOM id

function checkDomIds({ name, htmlFile, jsFiles }) {
  console.log(`\n[${name}] DOM id 一致性`);
  const html = read(htmlFile);
  const declared = new Set((html.match(/\bid="([^"]+)"/g) || []).map((m) => m.replace(/.*id="([^"]+)"/, '$1')));

  const duplicates = [];
  const seen = new Set();
  for (const match of html.match(/\bid="([^"]+)"/g) || []) {
    const id = match.replace(/.*id="([^"]+)"/, '$1');
    if (seen.has(id)) duplicates.push(id);
    seen.add(id);
  }
  if (duplicates.length) fail(`HTML 里有重复 id: ${unique(duplicates).join(', ')}`);
  else ok(`HTML 共 ${declared.size} 个 id，无重复`);

  const referenced = new Map();
  for (const file of jsFiles) {
    const source = read(file);
    for (const match of source.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
      referenced.set(match[1], file);
    }
    for (const match of source.matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
      referenced.set(match[1], file);
    }
    // 知识库页用的是 knowledgeEl('…')（它是 $(…) 的别名，但上面的正则扫不到）
    for (const match of source.matchAll(/knowledgeEl\(\s*'([^']+)'\s*\)/g)) {
      referenced.set(match[1], file);
    }
  }

  const missing = [...referenced.entries()].filter(([id]) => !declared.has(id));
  if (missing.length) {
    for (const [id, file] of missing) fail(`${file} 引用了不存在的 id: #${id}`);
  } else {
    ok(`${referenced.size} 个被引用的 id 全部存在`);
  }

  // 设置绑定表：键是控件 id、out 是显示数值的元素 id。
  // 它们不是通过 $('…') 取的，所以上面那圈扫不到——曾经把「气泡」页从 HTML 里删掉后，
  // 绑定表里还留着那几个键，绑定静默失效（不报错、控件永远不写值），没人发现。
  for (const file of jsFiles) {
    const source = read(file);
    const block = source.match(/const map = \{([\s\S]*?)\n  \};/);
    if (!block) continue;
    const dead = [];
    for (const entry of block[1].matchAll(/^\s{4}([A-Za-z0-9_]+):\s*\{([^}]*)\}/gm)) {
      if (!declared.has(entry[1])) dead.push(`#${entry[1]}`);
      const out = entry[2].match(/out:\s*'([^']+)'/);
      if (out && !declared.has(out[1])) dead.push(`#${out[1]}（${entry[1]} 的显示位）`);
    }
    if (dead.length) fail(`${file} 的设置绑定指向 HTML 里不存在的元素: ${unique(dead).join(', ')}`);
    else ok(`${file} 的设置绑定全部能在 HTML 里找到对应元素`);
  }

  // HTML 引用的资源
  const assets = [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((url) => !url.startsWith('http') && !url.startsWith('data:') && !url.startsWith('#'));
  const baseDir = path.dirname(htmlFile);
  for (const asset of assets) {
    const target = path.join(root, baseDir, asset);
    if (!fs.existsSync(target)) fail(`${htmlFile} 引用的资源不存在: ${asset}`);
  }
  if (assets.length) ok(`引用的 ${assets.length} 个本地资源都存在`);

  // CSP 必须放行「data: 图片」和「data: 音频」。
  // 踩过的坑：云端语音合成返回的是一段 base64 wav，界面用 `new Audio('data:audio/...;base64,...')`
  // 播放——而这两个界面的 CSP 里原本**没有 media-src**，于是回落到 `default-src 'none'`，
  // 音频被直接拒绝，界面只报一句 `Failed to load because no supported source was found`。
  // 图片之所以一直没事，是因为 `img-src` 里早就写了 `data:`。这条检查就是防止它再被删掉。
  const cspTag = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/);
  if (cspTag) {
    const csp = cspTag[1];
    const directive = (name) => {
      const hit = csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
      return hit ? hit.slice(name.length).trim() : '';
    };
    const imgSrc = directive('img-src');
    if (!imgSrc.includes('data:')) {
      fail(`${name} 的 CSP 里 img-src 少了 data:（吉祥物图片是 dataURL，会显示不出来）`);
    }
    const mediaSrc = directive('media-src');
    if (!mediaSrc) {
      fail(
        `${name} 的 CSP 里没有 media-src，会回落到 default-src 'none' → ` +
          `云端语音的 data: 音频播不了（报 Failed to load because no supported source was found）`
      );
    } else if (!mediaSrc.includes('data:')) {
      fail(`${name} 的 CSP 里 media-src 少了 data:（云端语音音频是 dataURL）`);
    } else {
      ok(`${name}：CSP 放行了 data: 图片和 data: 音频`);
    }
  }

  // 引用的每个界面脚本都要能通过语法校验（路径对了但内容有语法错同样致命）
  for (const asset of assets) {
    if (!asset.endsWith('.js')) continue;
    const target = path.join(root, baseDir, asset);
    if (!fs.existsSync(target)) continue;
    try {
      // eslint-disable-next-line no-new-func
      new Function(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      fail(`${htmlFile} 引用的脚本 ${asset} 有语法错误: ${error.message}`);
    }
  }
}

// ---------------------------------------------------------------- 2/3. IPC

function checkIpc() {
  console.log('\n[IPC] 通道一致性');
  const main = read('src/main/main.js');
  // broadcast() 是 send() 的封装，先在源码里展开，便于统一扫描
  const mainExpanded = main.replace(/broadcast\(/g, 'sendBoth(');
  const preload = read('src/main/preload.js');

  const handled = new Set(
    (main.match(/ipcMain\.handle\(\s*'([^']+)'/g) || []).map((m) => m.replace(/.*'([^']+)'.*/, '$1'))
  );
  const sent = new Set(
    [
      ...[...mainExpanded.matchAll(/send\(\s*[A-Za-z0-9_.]+,\s*'([^']+)'/g)].map((m) => m[1]),
      ...[...mainExpanded.matchAll(/sendBoth\(\s*'([^']+)'/g)].map((m) => m[1])
    ]
  );

  const invoked = new Map();
  for (const match of preload.matchAll(/invoke\(\s*'([^']+)'/g)) invoked.set(match[1], true);
  const subscribed = new Set(
    [...preload.matchAll(/\bon\(\s*'([^']+)'/g)].map((m) => m[1])
  );

  const missingHandlers = [...invoked.keys()].filter((channel) => !handled.has(channel));
  if (missingHandlers.length) {
    for (const channel of missingHandlers) fail(`preload 调用了 '${channel}'，但主进程没有 ipcMain.handle`);
  } else {
    ok(`${invoked.size} 个 invoke 通道都有主进程处理器`);
  }

  const missingSenders = [...subscribed].filter((channel) => !sent.has(channel));
  if (missingSenders.length) {
    for (const channel of missingSenders) fail(`preload 订阅了 '${channel}'，但主进程从不 send 这个通道`);
  } else {
    ok(`${subscribed.size} 个订阅事件都有对应的发送方`);
  }

  const unusedHandlers = [...handled].filter((channel) => !invoked.has(channel) && channel !== 'mascot:pickImages');
  if (unusedHandlers.length) {
    console.log(`  · 提示：这些主进程处理器暂时没有渲染层调用（可能是预留）：${unusedHandlers.join(', ')}`);
  }

  // 渲染层用到的 window.api 方法必须在 preload 里存在
  const apiMethods = new Set();
  for (const file of ['src/renderer/panel/panel.js', 'src/renderer/overlay/overlay.js']) {
    const source = read(file);
    for (const match of source.matchAll(/window\.api\.([A-Za-z0-9_.]+)/g)) apiMethods.add(match[1]);
  }
  const missingApi = [];
  for (const method of apiMethods) {
    const parts = method.split('.');
    if (parts.length === 1) continue;
    const [group, fn] = parts;
    if (group === 'on') {
      if (!new RegExp(`${fn}\\s*:`).test(preload)) missingApi.push(`window.api.on.${fn}`);
      continue;
    }
    const groupBlock = preload.split(`${group}: {`)[1] || '';
    if (!new RegExp(`${fn}\\s*:`).test(groupBlock)) missingApi.push(`window.api.${method}`);
  }
  if (missingApi.length) {
    for (const item of missingApi) fail(`渲染层使用了 ${item}，但 preload 没暴露`);
  } else {
    ok(`渲染层用到的 ${apiMethods.size} 个 window.api 方法都已暴露`);
  }
}

// ---------------------------------------------------------------- 4. 设置项

function checkSettingsKeys() {
  console.log('\n[设置] 界面绑定与默认配置一致性 + 自定义表情的规矩');
  const panel = read('src/renderer/panel/panel.js');
  const settings = read('src/main/settings.js');
  const emotions = read('src/shared/emotions.js');
  const copilot = stripComments(read('src/main/copilot.js'));
  const problems = [];

  const paths = [...panel.matchAll(/path:\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
  const defaults = settings;
  const missing = [];
  for (const item of unique(paths)) {
    const [section, key] = item.split('.');
    const sectionBlock = defaults.split(`${section}: {`)[1];
    if (!sectionBlock) {
      missing.push(`${item}（没有 ${section} 这一段）`);
      continue;
    }
    if (key && !new RegExp(`\\b${key}\\s*:`).test(sectionBlock.split('\n    },')[0])) {
      missing.push(item);
    }
  }
  for (const item of missing) problems.push(`界面绑定了默认配置里不存在的项: ${item}`);

  // ---- 自定义表情（2026-10-19）的四条不变量 ----
  // ① 上限是主播定的 8 个；② 状态表仍然只有 shared/emotions.js 一份；
  // ③ 配置层必须清洗（手改配置写坏了不能让界面炸）；
  // ④ 提示词里的情绪清单必须是**函数**现拼 —— 写成模块级常量的话，新加的表情要重启软件才生效。
  if (!/MAX_CUSTOM_EMOTIONS = 8\b/.test(emotions)) problems.push('emotions.js 里自定义表情上限不是 8');
  if (!/function normaliseCustomEmotions/.test(emotions)) problems.push('emotions.js 没有 normaliseCustomEmotions');
  if (!/customEmotions:\s*\[\]/.test(settings)) problems.push('settings.js 默认配置里没有 mascot.customEmotions');
  if (!/normaliseCustomEmotions\(out\.mascot\.customEmotions\)/.test(settings)) {
    problems.push('settings.js 没有清洗 mascot.customEmotions（手改配置会带脏数据进来）');
  }
  if (!/function buildEmotionHint/.test(stripComments(copilot))) {
    problems.push('copilot.js 的情绪清单不是函数（自定义表情会要重启才生效）');
  }
  if (/const EMOTION_HINT =/.test(copilot)) problems.push('copilot.js 里又出现了模块级 EMOTION_HINT 常量');
  // 面板里必须用「内置 + 自定义」那张表：只遍历内置 EMOTION_LIST 的话，新加的表情根本不显示
  if (!/function currentEmotions\(\)/.test(panel)) problems.push('panel.js 没有 currentEmotions()（自定义表情不会显示在面板上）');

  if (problems.length) fail(`设置/表情配置有问题：${problems.join('；')}`);
  else ok(`${unique(paths).length} 个界面绑定项都有默认值；自定义表情上限 8、配置会清洗、提示词清单是现拼的`);
}

// ---------------------------------------------------------------- 5. 语法

function checkSyntax() {
  console.log('\n[语法] 所有 JS 文件');
  const files = [
    'src/main/main.js',
    'src/main/preload.js',
    'src/main/settings.js',
    'src/main/logger.js',
    'src/main/danmaku.js',
    'src/main/llm.js',
    'src/main/copilot.js',
    'src/main/stats.js',
    'src/main/bili-login.js',
    'src/shared/emotions.js',
    'src/shared/error-reporter.js',
    'src/renderer/panel/panel.js',
    'src/renderer/overlay/overlay.js'
  ];
  let bad = 0;
  for (const file of files) {
    try {
      // 用 new Function 做语法检查，避免 spawn 子进程（受限环境会 EPERM）
      // eslint-disable-next-line no-new-func
      new Function(read(file));
    } catch (error) {
      bad += 1;
      fail(`${file} 语法错误: ${error.message}`);
    }
  }
  if (!bad) ok(`${files.length} 个文件语法都正确`);
}

// ---------------------------------------------------------------- 6. 全局作用域冲突

/**
 * 把每个界面引用的所有脚本拼在一起编译一次，等价于浏览器的「整页脚本共同解析」。
 *
 * 为什么必须这么做：界面脚本在浏览器里共享同一个全局作用域，两个文件都写
 * `const api = ...` 就会报 "Identifier 'api' has already been declared"，
 * 导致整个文件解析失败、界面全部按钮失效——而逐个文件单独检查语法是发现不了的。
 */
function checkGlobalScopeConflicts() {
  console.log('\n[作用域] 界面脚本能否共存');
  const pages = [
    { name: '控制面板', htmlFile: 'src/renderer/panel/index.html' },
    { name: '悬浮窗', htmlFile: 'src/renderer/overlay/index.html' }
  ];

  for (const page of pages) {
    const html = read(page.htmlFile);
    const baseDir = path.dirname(page.htmlFile);
    const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
    if (!scripts.length) {
      fail(`${page.name} 没有引用任何脚本`);
      continue;
    }
    const sources = [];
    let missing = false;
    for (const asset of scripts) {
      const target = path.join(root, baseDir, asset);
      if (!fs.existsSync(target)) {
        fail(`${page.name} 引用的脚本不存在: ${asset}`);
        missing = true;
        continue;
      }
      sources.push(fs.readFileSync(target, 'utf8'));
    }
    if (missing) continue;

    // 拼成一段脚本后整体编译：浏览器里的同名冲突会在这里暴露
    const combined = sources
      .map((code, index) => `// ==== ${scripts[index]} ====\n${code}`)
      .join('\n');
    try {
      // eslint-disable-next-line no-new-func
      new Function(combined);
      ok(`${page.name}：${scripts.length} 个脚本可共存（无全局重名/语法冲突）`);
    } catch (error) {
      const which = combined.slice(0, combined.indexOf('\n')).replace('// ==== ', '').replace(' ====', '');
      fail(`${page.name} 的脚本无法共存（当前检查到 ${which}）：${error.message}`);
    }

    // 顺带确认共享逻辑确实挂到了 window 上（界面靠它取 EMOTION_LIST）
    if (sources.some((code) => code.includes('window.SharedLogic'))) {
      ok(`${page.name}：共享逻辑 SharedLogic 已就绪`);
    } else if (scripts.some((asset) => asset.includes('emotions'))) {
      fail(`${page.name} 引用了 emotions.js 但没有把共享逻辑挂到 window.SharedLogic`);
    }
  }
}

// ---------------------------------------------------------------- 界面弹窗

/** 去掉注释：说明文字里会写 `confirm()`，不去掉会把自己的文档当成违规代码 */
function stripComments(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * 界面脚本里**不许出现原生 confirm / alert / prompt**。
 *
 * 为什么：主播报过一个 bug —— 在知识库删掉一条之后，**整个页面的输入框都不能选、不能打字**，
 * 要重启软件才好。那条路径上唯一和别处不同的就是原生 `confirm()`：
 * 原生弹窗在 Electron/Windows 上关掉之后，渲染层可能卡在「模态还开着」的状态，
 * 于是所有鼠标/键盘事件都被吞掉（界面照常显示，所以看着像卡住）。
 * 现在一律用自绘的 `confirmDialog()` / `promptDialog()`（见 panel.js），这条检查守住它。
 */
function checkNativeDialogs() {
  console.log('\n[界面] 不使用系统原生弹窗');
  const files = ['src/renderer/panel/panel.js', 'src/renderer/overlay/overlay.js'];
  const bad = [];
  for (const file of files) {
    if (!fs.existsSync(path.join(root, file))) continue;
    const source = stripComments(read(file));
    for (const match of source.matchAll(/(?<![\w$])(confirm|alert|prompt)\s*\(/g)) {
      const line = source.slice(0, match.index).split('\n').length;
      bad.push(`${file}:${line} 用了原生 ${match[1]}()`);
    }
  }
  if (bad.length) {
    fail(`界面里出现了原生弹窗，会让整个界面卡住输入：${unique(bad).join('；')}（改用 confirmDialog / promptDialog）`);
  } else {
    ok(`${files.length} 个界面脚本都没有原生弹窗`);
  }
}

// ---------------------------------------------------------------- 配置安全

/**
 * 脚本里 `new SettingsStore()` 必须显式给路径。
 *
 * 为什么要有这条检查：SettingsStore 的构造函数原来是**不收参数**的，
 * 于是测试和一次性脚本里写的 `new SettingsStore(tmpFile)` 被静默忽略，
 * 直接读写了主播真实用的 `data/settings.json` —— 真发生过，
 * 把主播的人设覆盖成了测试字符串。现在构造函数收参数了，这条检查守住它。
 */
function checkSettingsStoreSafety() {
  console.log('\n[配置安全] 脚本不会误写真实配置');
  const files = fs
    .readdirSync(path.join(root, 'scripts'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `scripts/${name}`);

  const bad = [];
  for (const file of files) {
    // 跳过自己：下面那几句提示文案里就写着 new SettingsStore()，扫自己必然误报
    if (file === 'scripts/audit.js') continue;
    const source = read(file);
    for (const match of source.matchAll(/new SettingsStore\(\s*([^)]*)\)/g)) {
      const arg = match[1].trim();
      if (!arg || arg === 'undefined') bad.push(`${file} new SettingsStore()（没给路径）`);
    }
  }
  if (bad.length) {
    fail(`这些地方会直接读写真实配置 data/settings.json，必须显式传临时路径: ${unique(bad).join('；')}`);
  } else {
    ok(`${files.length} 个脚本里没有裸的 new SettingsStore()`);
  }

  // 真实配置是否被误改过（留下一份 .damaged / .broken 备份就是线索）
  const dataDir = path.join(root, 'data');
  const leftovers = fs.existsSync(dataDir)
    ? fs.readdirSync(dataDir).filter((name) => /^settings\.json\.(damaged|broken)/.test(name))
    : [];
  if (leftovers.length) {
    console.log(`  ! data/ 里有配置备份（说明出过事，看一眼再删）：${leftovers.join(', ')}`);
  }
}

/**
 * 会话要登记进工作区，测试会话要能删干净。
 *
 * 背景（主播报的两个问题）：
 *   1. 调用 DSH 时会话在 Web 里显示成「未分组」——因为 DSH Web **只按工作区登记表里的
 *      显式 `sessionIds` 分组**，不登记就落到「未分组」；
 *   2. 验证脚本跑一次建一个会话，会话库里堆了一堆「只回复两个字：可以」的测试会话。
 *
 * 这两条破了都不会让测试变红（要真机 + 肉眼看 Web 才发现），所以静态守住。
 */
function checkDshSessionRegistry() {
  console.log('\n[DSH] 已下线（卡片藏着、引擎钉死），会话登记与清理的规矩仍然在');
  // ⚠️ `main` 是**去掉注释**之后的源码：所以「钉成 builtin」要断言代码本身，不能断言注释
  const mainRaw = read('src/main/main.js');
  const main = stripComments(mainRaw);
  const store = read('src/main/dsh-store.js');
  const verify = read('scripts/verify-dsh-session.js');
  const html = read('src/renderer/panel/index.html');
  const problems = [];

  // ⓪ 离线状态（2026-10-19 主播定的「只藏不删」）：
  //    这张卡必须一直被 hidden 收着，否则它会重新出现在知识库页上，
  //    而引擎那边已经钉死了 builtin —— 主播点了「开始整理」也不会有任何反应，纯属骗人。
  //    ⚠️ 真要恢复 DSH：这三条断言连同 hidden / engine 一起改（交接文档 §6.16 有清单）。
  const cardMatch = html.match(/<div[^>]*id="dshCard"[^>]*>/);
  if (!cardMatch) {
    problems.push('面板里找不到 #dshCard（DSH 卡去哪了？删掉的话记得连离线断言一起改）');
  } else if (!/\shidden(\s|>)/.test(cardMatch[0])) {
    problems.push('#dshCard 没有 hidden —— DSH 已下线，卡片不该再出现（恢复请见交接文档 §6.16）');
  }
  if (!/const engine = 'builtin';/.test(main)) {
    problems.push("main.js 的 runResearchQuery 没有把 engine 钉成 'builtin'（DSH 已下线，手改配置也不该拉起它）");
  }
  for (const [file, label] of [
    ['src/main/main.js', 'main.js'],
    ['src/main/dsh-store.js', 'dsh-store.js'],
    ['src/main/dsh-acp.js', 'dsh-acp.js'],
    ['src/main/dsh.js', 'dsh.js']
  ]) {
    if (!/已下线/.test(read(file))) problems.push(`${label} 顶部缺少「已下线」说明（后来的人会以为它还在用）`);
  }

  // ① 主进程建完会话要登记进工作区
  if (!/require\('\.\/dsh-store'\)/.test(main)) problems.push('main.js 没有引入 dsh-store');
  if (!/attachSessionToWorkspace\(/.test(main)) problems.push('main.js 没有调用 attachSessionToWorkspace（会话会落在「未分组」）');
  // ② 登记必须幂等：已经登记过就别再写盘
  if (!/changed: false/.test(store)) problems.push('dsh-store.js 的登记不是幂等的（每次都会写盘）');
  // ③ 写别人的存储前必须验格式，且不许在 DSH 正在改表时插一脚
  if (!/WORKSPACE_DOMAIN/.test(store) || !/pendingMutation/.test(store)) {
    problems.push('dsh-store.js 没有校验工作区存储格式 / pendingMutation（可能写坏 DSH 的登记表）');
  }
  // ④ 落盘要原子（先写 tmp 再 rename）
  if (!/renameSync\(/.test(store)) problems.push('dsh-store.js 落盘不是原子的（没有 tmp + rename）');
  // ⑤ 验证脚本默认要清理自己建的会话
  if (!/deleteSession\(/.test(verify)) problems.push('verify-dsh-session.js 没有清理自己建的会话（会留测试会话）');
  if (!/--keep/.test(verify)) problems.push('verify-dsh-session.js 没有 --keep 开关（想留着看的人没退路）');

  if (problems.length) fail(`DSH 相关规矩有问题：${problems.join('；')}`);
  else ok('DSH 卡片收着、引擎钉死 builtin、模块顶上写了「已下线」；会话登记仍幂等 + 验格式 + 原子写');
}

// ---------------------------------------------------------------- 「模型主动记知识」这条链路

/**
 * 「模型主动更新知识库」的三条不变量。
 *
 * 主播要的是「模型自己发现值得记的东西、主动问一声、查完归档」。这条链路最容易走偏的地方是
 * **把「提议」和「执行」混在一起**：一旦 copilot 自己就去联网、自己就写知识库，
 * 就变成了「模型花你的钱、写你的库，还不问你」。所以：
 *   ① 模型只能提议（copilot 里不许出现联网/写库调用）；
 *   ② 真去查、真入库只能在 main.js 的 IPC 里（主播点出来的）；
 *   ③ 提示词里得教它这两个标记，否则它永远不会提。
 */
function checkResearchPipeline() {
  console.log('\n[知识库] 模型只能提议，花钱和写库由主播点');
  const copilot = stripComments(read('src/main/copilot.js'));
  const main = stripComments(read('src/main/main.js'));
  const research = read('src/main/research.js');
  const llmSrc = stripComments(read('src/main/llm.js'));
  const problems = [];

  // ① copilot 不许自己联网 / 写库
  for (const [pattern, why] of [
    [/searchWithDeepSeek/, 'copilot 自己联网查了（应该只进待办队列）'],
    [/addPending\(/, 'copilot 自己写待审草稿了（应该由主播点了才写）'],
    [/new ResearchQueue/, 'copilot 自己建队列了（队列归 main.js 管）']
  ]) {
    if (pattern.test(copilot)) problems.push(why);
  }
  if (!/queueResearch\(/.test(copilot)) problems.push('copilot 没有把模型提的标记收进队列');
  // ② 执行必须在 main.js 的 IPC 里，两条引擎都要在
  if (!/research:run/.test(main)) problems.push('main.js 没有 research:run 通道');
  if (!/searchWithDeepSeek\(/.test(main)) problems.push('main.js 没有走内置联网查询');
  if (!/addPending\(/.test(main)) problems.push('main.js 没把查询结果送进待审');
  // ③ 提示词里要有标记的写法
  if (!/\[待查:/.test(copilot)) problems.push('系统提示词里没教 [待查:…] 标记');
  if (!/\[记一笔:/.test(copilot)) problems.push('系统提示词里没教 [记一笔:…] 标记');
  if (!/\[改一下:/.test(copilot)) problems.push('系统提示词里没教 [改一下:…] 标记（P6：她能自己改错）');
  if (!/\[扩写:/.test(copilot)) problems.push('系统提示词里没教 [扩写:…] 标记（P6：她能自己扩写）');
  // ④ 联网查询必须带原生 web_search 工具，且失败不抛（要给用户可读理由）
  if (!/web_search_20250305/.test(research)) problems.push('内置查询没有带 web_search 工具');
  if (!/AbortController/.test(research)) problems.push('内置查询没有超时保护');
  // ⑤ 主播在对话里回一句「查」也算点头，但**执行必须还是 main.js 里那段**：
  //    如果哪天在 copilot 里直接查了，「模型只能提议、花钱由主播点头」这条就名存实亡了
  if (!/copilot\.on\('research-approve'/.test(main)) problems.push('main.js 没接「主播在对话里同意」这个事件');
  const approveAt = main.indexOf("copilot.on('research-approve'");
  if (approveAt >= 0 && !/runResearchItem\(|noteResearchItem\(/.test(main.slice(approveAt, approveAt + 1500))) {
    problems.push('对话里同意之后没有走 main.js 那段执行代码');
  }
  if (/runResearchItem|noteResearchItem/.test(copilot)) {
    problems.push('copilot 里出现了执行函数（执行只能待在 main.js）');
  }
  // ⑦ P6：她能自己动库了，但**写库只许在 main.js 里发生**，而且改之前必须先备份
  if (/applyEdit\(|applyCreate\(/.test(copilot)) {
    problems.push('copilot 里出现 applyEdit / applyCreate（改库只能待在 main.js）');
  }
  const knowledgeSrc = read('src/main/knowledge.js');
  if (!/applyEdit\(/.test(knowledgeSrc)) problems.push('knowledge.js 没有 applyEdit（她自己改错要靠它）');
  if (!/applyCreate\(/.test(knowledgeSrc)) problems.push('knowledge.js 没有 applyCreate（她自己记新的要靠它）');
  // 备份必须排在写盘前面：先 `_saveHistory` 再 `this.update(...)`，反了就成了「改完才备份」
  const applyEditBody = knowledgeSrc.slice(knowledgeSrc.indexOf('applyEdit('), knowledgeSrc.indexOf('applyCreate('));
  const backupAt = applyEditBody.indexOf('_saveHistory(');
  const writeAt = applyEditBody.indexOf('this.update(');
  if (backupAt < 0 || writeAt < 0 || backupAt > writeAt) {
    problems.push('applyEdit 没有「先备份再写」（改错了就没法撤销）');
  }
  if (!/listEdits\(|undoEdit\(/.test(knowledgeSrc)) problems.push('knowledge.js 没有 listEdits / undoEdit（面板没法撤销）');
  // 改库流水线必须在 main.js，而且得走 applyEdit
  if (!/runKnowledgeEdit\(/.test(main)) problems.push('main.js 没有改库流水线 runKnowledgeEdit');
  if (!/knowledge\.applyEdit\(/.test(main)) problems.push('main.js 没有调用 knowledge.applyEdit');
  // ⑨ 从文件导入（2026-10-19）：模型整理出来的内容只能进「待审草稿」，
  //    绝不能直接 add 进 notes —— 和「模型不能自己写库」是同一条规矩。
  const importSrc = read('src/main/import-file.js');
  if (!/knowledge:pickImportFiles/.test(main) || !/knowledge:importFiles/.test(main)) {
    problems.push('main.js 没有「从文件导入」的两个通道（pickImportFiles / importFiles）');
  }
  const importAt = main.indexOf("ipcMain.handle('knowledge:importFiles'");
  const importNext = importAt >= 0 ? main.indexOf('ipcMain.handle(', importAt + 10) : -1;
  const importTail = importAt >= 0 ? main.slice(importAt, importNext > 0 ? importNext : importAt + 8000) : '';
  if (!/knowledge\.addPending\(/.test(importTail)) problems.push('导入没有把结果送进待审草稿');
  if (/knowledge\.add\(/.test(importTail)) problems.push('导入直接写进了知识库（模型产出必须先待审）');
  if (!/looksBinary|prepareImport/.test(main)) problems.push('导入没有做文件体检（二进制会被当成资料喂给模型）');
  if (!/function decodeText/.test(importSrc) || !/new TextDecoder\('gbk'\)/.test(importSrc)) {
    problems.push('import-file.js 没有 GBK 兜底（中文 txt 一半是 GBK，按 UTF-8 解会整篇乱码）');
  }
  if (!/===知识条目===/.test(importSrc)) problems.push('import-file.js 的提示词没有要求用待审草稿那套格式');
  // ⑧ P7 最高权限：工具白名单两边必须对得上，而且执行只能在 main.js
  const agentToolsMatch = main.match(/const AGENT_TOOLS = \[([^\]]+)\]/);
  if (!agentToolsMatch) {
    problems.push('main.js 里没有 AGENT_TOOLS 白名单（她能调用的软件功能必须是显式清单）');
  } else {
    const allowed = agentToolsMatch[1]
      .split(',')
      .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    // 只看 TOOL_ALIASES 那张表里的值（别把 llm.js 里别的字符串也扫进来）
    const aliasBlock = llmSrc.match(/const TOOL_ALIASES = \{([\s\S]*?)\n\};/);
    if (!aliasBlock) problems.push('llm.js 里没有 TOOL_ALIASES（工具标记的动作名清单）');
    const aliases = aliasBlock ? [...aliasBlock[1].matchAll(/:\s*'([a-z]+)'/g)].map((match) => match[1]) : [];
    const unknown = [...new Set(aliases)].filter((name) => !allowed.includes(name));
    if (unknown.length) problems.push(`llm.js 里有 main.js 白名单之外的动作名：${unknown.join('、')}`);
    if (!aliases.length) problems.push('TOOL_ALIASES 一个动作名都没有（她写了标记也没人认）');
    // 死死守住：她的工具表里不许出现「开始/停止监听」这类会断直播的动作
    for (const forbidden of ['listen', 'start', 'stop', 'danmaku', 'send']) {
      if (allowed.includes(forbidden)) problems.push(`工具白名单里不许有 ${forbidden}（会动直播链路）`);
    }
  }
  if (!/handleToolCalls\(/.test(copilot)) problems.push('copilot 没有 handleToolCalls（工具调用得先过权限判定）');
  if (!/agent\.maxPermissions/.test(copilot)) problems.push('copilot 里没有「最高权限」的判定');
  if (!/copilot\.on\('tool-call'/.test(main)) problems.push('main.js 没接「她调用软件功能」这个事件');
  if (!/runToolCalls\(/.test(main)) problems.push('main.js 没有 runToolCalls（工具执行只能在这儿）');
  if (!/AGENT_TOOLS\.includes\(/.test(main)) problems.push('main.js 分发工具时没有查白名单');
  // ⑨ 改自己的设定：门槛是开发者模式；改之前必须留一份旧的
  if (!/handleSettingsEdits\(/.test(copilot)) problems.push('copilot 没有 handleSettingsEdits');
  if (!/copilot\.on\('settings-edit'/.test(main)) problems.push('main.js 没接「改自己的设定」这个事件');
  if (!/applySelfSettingsEdit\(/.test(main)) problems.push('main.js 没有 applySelfSettingsEdit');
  if (!/settings-history/.test(main)) problems.push('改设定前没有把旧值备份到 data/settings-history（后悔了就找不回来）');
  // ⑩ 最高权限默认必须是**关**的：不能一装上就全自动
  const defaultsSrc = read('src/main/settings.js');
  if (!/maxPermissions:\s*false/.test(defaultsSrc)) problems.push('agent.maxPermissions 默认值不是 false（装好就该是关着的）');
  // ⑪ 「最高权限」那张卡要待在 DeepSeek API 页里（主播要求的位置：和模型设置放一起）
  const html = read('src/renderer/panel/index.html');
  const apiTabAt = html.indexOf('id="tab-api"');
  const knowledgeTabAt = html.indexOf('id="tab-knowledge"');
  const maxCardAt = html.indexOf('最高权限（全自动）');
  if (maxCardAt < 0) {
    problems.push('面板里找不到「最高权限（全自动）」那张卡');
  } else if (!(maxCardAt > apiTabAt && (knowledgeTabAt < 0 || maxCardAt < knowledgeTabAt))) {
    problems.push('「最高权限」卡片不在 DeepSeek API 页里（它该跟模型设置放一起）');
  }
  // ⑥ 主播在输入框里点名「查一下 X」也要走同一段执行代码
  if (!/copilot\.on\('research-request'/.test(main)) problems.push('main.js 没接「主播点名要查」这个事件');
  const requestAt = main.indexOf("copilot.on('research-request'");
  if (requestAt >= 0 && !/runResearchItem\(|noteResearchItem\(/.test(main.slice(requestAt, requestAt + 2000))) {
    problems.push('主播点名要查之后没有走 main.js 那段执行代码');
  }
  // ⑫ 联网的两条走法都得留着（主播要能在面板上选），而且互相兜底。
  //    这是主播明确要求过的：「用户可以自行选择老的搜索方式和新的搜索方式，并且两种方法都兼容」——
  //    所以任何一条被顺手删掉/悄悄改成写死，都算把选择权拿走了。
  if (!/searchWithDeepSeek\(/.test(main)) problems.push('main.js 里没有模型联网（老办法）——主播要能选回去');
  if (!/searchViaSearchApi\(/.test(main)) problems.push('main.js 里没有自研搜索接口（新的那条）');
  if (!/function searchViaSearchApi/.test(research)) problems.push('research.js 里没有 searchViaSearchApi');
  if (!/\/v1\/tools\/search/.test(research)) problems.push('自研搜索没有打到 /v1/tools/search');
  if (!/fellBackFrom/.test(main)) problems.push('自研搜索失败后没有自动退回老办法（接口一挂「去查」就废了）');
  if (!/searchMode:\s*'self'/.test(defaultsSrc)) problems.push('knowledge.searchMode 默认值不是 self');
  if (!/includes\(out\.knowledge\.searchMode\)/.test(defaultsSrc)) {
    problems.push('settings.js 没有清洗 knowledge.searchMode（手写坏值会让「去查」永远失败）');
  }
  for (const id of ['searchModeSelf', 'searchModeModel']) {
    if (!html.includes(`id="${id}"`)) problems.push(`面板里没有 ${id} 这个单选（两条路必须都能选）`);
  }
  if (!/function renderSearchMode/.test(read('src/renderer/panel/panel.js'))) {
    problems.push('面板没有 renderSearchMode（重启后单选不会按配置回填）');
  }

  if (problems.length) fail(`模型主动记知识这条链路有问题：${problems.join('；')}`);
  else ok('模型只提议（联网/写库都在 IPC 里），提示词教了标记，查询有工具与超时保护');
}

// ---------------------------------------------------------------- 编码

/**
 * 文本文件必须是真的 UTF-8，且不含替换字符（U+FFFD）。
 *
 * 为什么要有这条：**真出过事**。用 PowerShell 的 `Get-Content -Raw` + `Set-Content -Encoding utf8`
 * 改带中文的文件时，PowerShell 会按 ANSI（本机是 GBK）解码再按 UTF-8 写回，
 * 于是整篇中文变成乱码（`一个在直播时陪你…` → `涓€涓湪鐩存挱鏃堕櫔浣?..`），
 * 而且**新行也会被吞掉**（交接文档从 ~1400 行塌成 847 行）。
 * 逆变换只能救回 ~97%，剩下的字和换行永久丢失——所以要在"写坏的那一刻"就报出来。
 *
 * 结论：改中文文件只用编辑工具（edit/write），**永远不要**用 PowerShell 的
 * Get-Content/Set-Content 往返。
 */
const DAMAGED_DOCS = [
  // 2026-10-16：README.md / 交接文档.md 被 PowerShell 的 Get-Content|Set-Content 往返写坏，
  // 已按主播要求删除、改从旧备份恢复，所以这里不再需要豁免名单。
  // 恢复回来后，这两个文件会自动重新受这条检查保护（不是合法 UTF-8 或含 U+FFFD 就报错）。
];

function checkEncoding() {
  console.log('\n[编码] 文本文件是真 UTF-8，且没有替换字符');
  const files = [];
  const collect = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        collect(rel);
      } else if (/\.(js|json|md|html|css|txt|yml|yaml|bat)$/i.test(entry.name)) {
        files.push(rel);
      }
    }
  };
  for (const dir of ['src', 'scripts']) collect(dir);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(md|json|bat)$/i.test(entry.name)) files.push(entry.name);
  }

  const bad = [];
  const skipped = [];
  for (const file of files) {
    if (DAMAGED_DOCS.includes(file)) {
      skipped.push(file);
      continue;
    }
    const buf = fs.readFileSync(path.join(root, file));
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (_) {
      bad.push(`${file}（不是合法 UTF-8）`);
      continue;
    }
    if (text.includes('\uFFFD')) bad.push(`${file}（含替换字符 U+FFFD）`);
    if (/[\u00c3\u00e5\u00e6][\u0080-\u00bf]/.test(text)) bad.push(`${file}（像是被按拉丁/GBK 误解码过）`);
    // .bat 必须 CRLF：cmd 对**裸 LF** 的批处理会错位解析，把下一行开头几个字符当成命令名
    // （真事：主播双击「安装依赖.bat」报 `'ipts' 不是内部命令` —— `--ignore-scripts` 被啃成了 `ipts`）
    if (/\.bat$/i.test(file) && /[^\r]\n/.test(text)) {
      bad.push(`${file}（是 LF 换行，必须改成 CRLF，否则 cmd 会把行首吃掉）`);
    }
  }
  if (bad.length) {
    fail(`这些文件编码坏了（改中文文件别用 PowerShell 的 Get-Content/Set-Content 往返）：${unique(bad).join('；')}`);
  } else {
    ok(`${files.length} 个文本文件编码正常${skipped.length ? `（跳过已知受损：${skipped.join('、')}）` : ''}`);
  }
}

// ---------------------------------------------------------------- 主流程

/**
 * 会话模式必须走 ACP，而且必须「记得住会话」。
 *
 * 背景（主播实际报的故障）：
 * > 没跑成：任务没送出去：session "~76F4~64AD…" already exists
 *
 * 根因：旧的 `--profile sdk`（dsh-sdk-jsonrpc-server）**只会 create、不会 open**，
 * 而且它的 store 是全库视角，所以固定 id 第二次跑必撞。ACP 才有 `session/resume`。
 * 这几条一旦退回去都不会在测试里立刻炸（要真机第二次运行才暴露），所以静态守住。
 */
function checkDshSessionProtocol() {
  console.log('\n[DSH] 会话模式走 ACP + 记得住会话');
  const acp = read('src/main/dsh-acp.js');
  const main = stripComments(read('src/main/main.js'));
  const panel = stripComments(read('src/renderer/panel/panel.js'));
  const all = ['src/main/main.js', 'src/main/dsh.js', 'src/main/dsh-acp.js'].map((file) => read(file)).join('\n');
  const problems = [];

  // ① 不许再回到 sdk profile（它就是 already exists 的根源）
  if (/--profile'\s*,\s*'sdk'/.test(main) || /'--profile',\s*'sdk'/.test(all) || /profile['"]?,\s*['"]sdk['"]/.test(all)) {
    problems.push('又用回 --profile sdk 了（它只能 create，第二次跑会 already exists）');
  }
  // ② 必须真的起 acp
  if (!/--profile'\s*,\s*'acp'/.test(acp)) problems.push('dsh-acp.js 没有用 --profile acp 起进程');
  // ③ 会话要能续：resume + 新建两条路都得在
  if (!/session\/resume/.test(acp)) problems.push('dsh-acp.js 没有 session/resume（会话就续不上了）');
  if (!/session\/new/.test(acp)) problems.push('dsh-acp.js 没有 session/new');
  // ④ 服务端要权限时必须应答（不回它就一直等，看着像卡死）
  if (!/session\/request_permission/.test(acp)) problems.push('dsh-acp.js 没有处理 session/request_permission');
  if (!/reject/.test(acp)) problems.push('dsh-acp.js 对越界操作没有拒绝策略');
  // ⑤ 模型要由软件在会话上指定（默认 4.1 Flash），不然会跟着 acp 档自带的 v4-flash 跑
  if (!/['"]session\/set_config_option['"]/.test(acp)) problems.push('dsh-acp.js 没有 session/set_config_option（模型就指定不了）');
  if (!/dshModel/.test(main)) problems.push('main.js 没把 dshModel 交给会话执行器');
  if (!/dshModel/.test(panel)) problems.push('panel.js 里没有 DSH 模型这一项（配置改了界面也看不到）');
  // ⑤ 主进程要把会话 id 存进去、下次接着用
  if (!/sessionId:\s*store\.get\(\)\.knowledge\.dshSessionId/.test(main)) {
    problems.push('main.js 没把存下来的会话 id 交给会话执行器（等于每次都新开）');
  }
  if (!/onSession:/.test(main)) problems.push('main.js 没有 onSession 回调（新建的会话 id 存不下来）');

  if (problems.length) fail(`DSH 会话协议有问题：${problems.join('；')}`);
  else ok('会话走 ACP（能 resume），越界有拒绝策略，id 会存下来续用');
}

/**
 * DSH 的工作区必须是知识库目录，而且用之前必须告诉用户。
 *
 * 为什么值得静态查一遍：这两条一旦破了都**不会报错**——
 * 工作区写成软件目录，DSH 就能读写整个程序目录（包括配置和密钥），跑起来一切正常；
 * 忘了告知，用户根本不知道有个 AI 在他硬盘上干活。只有代码检查能提前拦住。
 */
function checkDshWorkspace() {
  console.log('\n[DSH] 工作区限定在知识库目录 + 用前告知');
  const main = stripComments(read('src/main/main.js'));
  const panel = stripComments(read('src/renderer/panel/panel.js'));
  const problems = [];

  // ① 工作区只能是知识库目录：软件目录 / 进程目录 / appRoot 一律不行
  for (const [pattern, why] of [
    [/cwd:\s*process\.cwd\(\)/, '用了 process.cwd()（= 软件目录）'],
    [/cwd:\s*app\.getAppPath\(\)/, '用了 app.getAppPath()（= 软件目录）'],
    [/cwd:\s*appRoot\b/, '用了 appRoot（= 软件目录）'],
    [/cwd:\s*path\.join\(knowledge\.dir,\s*'inbox'\)/, '用了知识库的子目录（工作区应是知识库根目录）']
  ]) {
    if (pattern.test(main)) problems.push(`main.js ${why}`);
  }

  // ② 两个入口都要把工作区说清楚：会话模式 + 一次性模式
  if (!/cwd:\s*knowledge\.dir\b/.test(main)) problems.push('main.js 会话模式的 cwd 不是 knowledge.dir');
  if (!/const workspace = knowledge\.dir;/.test(main)) problems.push('main.js 没有把工作区固定成 knowledge.dir');
  if (!/cwd:\s*workspace\b/.test(main)) problems.push('main.js 一次性模式没用 workspace 当工作区');
  // 界面要知道工作区在哪，否则没法显示、也没法告知
  if (!/workspace:\s*knowledge\.dir/.test(main)) problems.push('main.js dsh:detect 没有回报工作区');

  // ③ 界面：跑之前必须走「先告知工作区」那道门
  const runTask = panel.match(/async function runDshTask\([\s\S]*?\n\}/);
  if (!runTask) {
    problems.push('panel.js 找不到 runDshTask（检查逻辑要跟着改）');
  } else if (!/ensureDshWorkspaceNotice\(\)/.test(runTask[0])) {
    problems.push('panel.js runDshTask 里没有先告知工作区（ensureDshWorkspaceNotice）');
  }
  // 告知里必须给出真实路径，不能只说「某个文件夹」
  if (!/dshWorkspace/.test(panel)) problems.push('panel.js 没有用主进程给的工作区路径');

  if (problems.length) {
    fail(`DSH 工作区/告知有问题：${problems.join('；')}`);
  } else {
    ok('工作区只来自 knowledge.dir，且用前会告知用户');
  }
}

/**
 * 界面里靠 `hidden` 属性收起来的东西，必须真的能收起来。
 *
 * 背景（真踩过三次）：`[hidden]` 的 `display:none` 来自浏览器默认样式表，**优先级极低**；
 * 目标元素只要有一条 `display` 规则（`.form{display:flex}`、`.modal-mask{display:flex}`…）
 * 就能把它顶掉 —— 于是「属性设成 true 了，东西还明晃晃摆在那儿」。
 * 主播报的第 N 次：知识库改动记录的折叠按钮变成「展开」了，记录还在。
 *
 * 静态检查两件事：① 面板 CSS 里有全局兜底 `[hidden]{display:none !important}`；
 * ② 每个用 `.hidden =` 切换的元素，CSS 里要么有兜底、要么自己写了 `[hidden]` 规则
 *    （有全局兜底时后半条自动满足，所以这条主要是防「有人把兜底删了」）。
 */
function checkHiddenToggles() {
  console.log('\n[界面] 用 hidden 收起来的东西能真的收起来');
  const css = read('src/renderer/panel/panel.css');
  const panel = stripComments(read('src/renderer/panel/panel.js'));
  const html = read('src/renderer/panel/index.html');
  const problems = [];

  const globalFallback = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css);
  if (!globalFallback) {
    problems.push('panel.css 里没有 `[hidden]{display:none !important}` 兜底（display 规则会把它顶掉）');
  }
  // 用 hidden 切显示隐藏的地方至少要有几处（没有这个 API 说明代码被改得面目全非）
  if (!/\.hidden\s*=\s*(true|false|!)/.test(panel)) {
    problems.push('panel.js 里找不到 `.hidden =` 的用法（检查逻辑要跟着改）');
  }
  // 折叠函数必须**同时**写 inline display：`[hidden]` 是浏览器默认样式，优先级最低，
  // `.form { display:flex }` 一顶就废（历史上踩过三次：modal-mask / modal-input / 改动记录）。
  if (!/body\.style\.display\s*=\s*next\s*\?\s*'none'/.test(panel)) {
    problems.push('折叠函数没有显式写 inline `style.display`（只设 hidden 会被 .form 的 display:flex 顶掉）');
  }
  // 三块可折叠区域（改动记录 / 待审草稿 / 全部条目）都必须有「内容体 + 开关按钮」
  for (const pair of [
    ['editsBody', 'editsToggle'],
    ['pendingBody', 'pendingToggle'],
    ['entriesBody', 'entriesToggle']
  ]) {
    for (const id of pair) {
      if (!html.includes(`id="${id}"`)) problems.push(`面板里没有 #${id}（可折叠区域被改坏了）`);
    }
  }
  // 已知「自己写了 [hidden] 规则」的老地方：留着是为了万一哪天删了全局兜底还能对上
  const specificRules = [...css.matchAll(/\.([a-z][\w-]*)\[hidden\]\s*\{/gi)].map((match) => match[1]);
  void specificRules;

  if (problems.length) fail(`隐藏/折叠有问题：${problems.join('；')}`);
  else ok('面板有全局 [hidden] 兜底 + inline display 双保险，三处折叠区（记录/待审/全部条目）都在');
}

/**
 * 悬浮窗四边/四角缩放的不变量（2026-10-19）。
 *
 * 这个功能拆在三个文件里，少一处就出问题，而且**都不会让测试变红**（要真鼠标拖才发现）：
 *   · HTML 里 8 个抓手（四条边 + 四个角，靠 `data-dir` 认方向）；
 *   · CSS 里锁定时整组 `pointer-events: none`（不然锁了还能改大小，自相矛盾）；
 *   · JS 里 `startResize` 先判 `isWindowLocked()`（CSS 之外的硬保险，也方便测试）；
 *   · 拖完上下边要切 `heightMode: 'fixed'`（不切的话松手那一刻又被"内容高度"覆盖回去）。
 */
function checkOverlayResize() {
  console.log('\n[悬浮窗] 四边/四角缩放：抓手、锁定禁用、固定高度');
  const html = read('src/renderer/overlay/index.html');
  const css = read('src/renderer/overlay/overlay.css');
  const overlay = stripComments(read('src/renderer/overlay/overlay.js'));
  const settings = read('src/main/settings.js');
  const problems = [];

  const handles = [...html.matchAll(/class="resize-handle"\s+data-dir="([a-z]{1,2})"/g)].map((match) => match[1]);
  const expected = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];
  for (const dir of expected) {
    if (!handles.includes(dir)) problems.push(`悬浮窗里少了 ${dir} 方向的缩放抓手`);
  }
  if (handles.length !== expected.length) problems.push(`缩放抓手数量不对：${handles.length} 个（应该 8 个）`);

  if (!/\.copilot\.locked\s+\.resize-handle\s*\{[^}]*pointer-events:\s*none/.test(css)) {
    problems.push('CSS 里没有「锁定时抓手失效」（`.copilot.locked .resize-handle { pointer-events: none }`）');
  }
  if (!/if \(isWindowLocked\(\)\) return;/.test(overlay)) {
    problems.push('overlay.js 的缩放没先判 isWindowLocked（锁了还能拖大小）');
  }
  if (!/heightMode = 'fixed'/.test(overlay) && !/patch\.heightMode = 'fixed'/.test(overlay)) {
    problems.push('拖完上下边没有切固定高度（松手就被内容高度覆盖回去）');
  }
  // 拖动期间布局不许再动窗口尺寸：`resize` 事件 → 布局 → 改回旧尺寸 → 又 resize 的来回闪烁
  if (!/function activeSizeOverride/.test(overlay)) {
    problems.push('overlay.js 没有 activeSizeOverride（拖动时布局会和鼠标抢窗口尺寸 → 拉动时来回闪）');
  }
  if (!/if \(activeSizeOverride\(\)\) return;/.test(overlay)) {
    problems.push('applyWindowBounds 没有在拖动期间直接返回（会把窗口改回旧尺寸）');
  }
  if (!/if \(!override\) applyWindowBounds/.test(overlay)) {
    problems.push('computeLayout 拖动期间仍在调 applyWindowBounds（会一帧帧把窗口拽回旧尺寸）');
  }
  if (!/function bindResizeHandles/.test(overlay)) problems.push('overlay.js 没有 bindResizeHandles');
  if (!/heightMode:\s*'content'/.test(settings)) problems.push('settings.js 里没有 overlay.heightMode 默认值');
  if (!/\['content', 'fixed'\]\.includes\(out\.overlay\.heightMode\)/.test(settings)) {
    problems.push('settings.js 没有清洗 overlay.heightMode（手写坏值会让窗口算不出高度）');
  }

  if (problems.length) fail(`缩放功能有问题：${problems.join('；')}`);
  else ok('八个抓手都在（四边+四角），锁定时抓手与 JS 双双失效，拖完上下边会切固定高度');
}

function checkKnowledgeReview() {
  console.log('\n[知识库] 整理/校对：最高思考档、只出建议、锁定是硬闸门');
  const main = stripComments(read('src/main/main.js'));
  const review = stripComments(read('src/main/review.js'));
  const knowledge = stripComments(read('src/main/knowledge.js'));
  const preload = read('src/main/preload.js');
  const html = read('src/renderer/panel/index.html');
  const panel = stripComments(read('src/renderer/panel/panel.js'));
  const settings = read('src/main/settings.js');
  const problems = [];

  // 1) 思考档位：用户要的是"最高的思考等级"
  if (!/const REVIEW_THINKING = 'max'/.test(review)) problems.push('review.js 的思考档位不是 max');
  if (!/thinking: REVIEW_THINKING/.test(main)) problems.push('main.js 没有用 REVIEW_THINKING 调模型（整理/校对会降档）');
  // 思考也算 max_tokens：给上限就会出现"思考吃满、正文空"（2026-10-21 真踩过）
  if (/\{ thinking: REVIEW_THINKING, maxTokens: [1-9]/.test(main)) {
    problems.push('整理/校对给 max_tokens 设了上限（思考会吃满额度 → 正文空、界面报"整理失败"）');
  }
  // 慢活要自带超时：普通回复的 45 秒会直接把整理掐断（同一天第二次踩到）
  const reviewCalls = [...main.matchAll(/\{ thinking: REVIEW_THINKING[^}]*\}/g)].map((match) => match[0]);
  if (reviewCalls.length < 2) problems.push(`整理/校对里只找到 ${reviewCalls.length} 处 max 档调用（应该 2 处）`);
  for (const call of reviewCalls) {
    if (!/timeoutMs: \d{5,}/.test(call)) {
      problems.push(`整理/校对调用没放宽超时（会卡在 45 秒）：${call.slice(0, 60)}`);
      break;
    }
  }
  // 2) 两条流水线都在
  for (const fn of ['runKnowledgeAudit', 'runKnowledgeVerify']) {
    if (!new RegExp(`async function ${fn}`).test(main)) problems.push(`main.js 里没有 ${fn}`);
  }
  // 3) 只出建议：整理/校对本身**不许**直接写 notes/（只有 applyReviewItem 能写）
  for (const fn of ['runKnowledgeAudit', 'runKnowledgeVerify']) {
    const start = main.indexOf(`async function ${fn}`);
    if (start < 0) continue;
    const body = main.slice(start, start + 6000);
    if (/knowledge\.(update|add|remove)\(/.test(body)) {
      problems.push(`${fn} 直接改了知识库（模型产出只能进建议，等主播点应用）`);
    }
  }
  if (!/function applyReviewItem/.test(main)) problems.push('main.js 里没有 applyReviewItem（建议没法应用）');
  // 4) 锁定是硬闸门：三处都要拦（改库 / 删库 / 应用建议）
  if (!/if \(entry\.locked\)/.test(knowledge)) problems.push('knowledge.applyEdit 没拦 locked（模型还能改只读条目）');
  if (!/if \(before\.locked\)/.test(main)) problems.push('runKnowledgeEdit 没拦 locked（锁了还会白调一次模型）');
  if (!/if \(entry\.locked\)/.test(main)) problems.push('runKnowledgeRemove 没拦 locked（模型还能删只读条目）');
  if (!/knowledge\.isLocked\(id\)/.test(main)) problems.push('applyReviewItem 没在应用时复查锁定状态');
  // 5) 应用前比对快照（防止盖掉主播手改）
  if (!/noteChangedSince\(item\.before, target\)/.test(main)) problems.push('applyReviewItem 没比对快照（会盖掉主播手改）');
  // 6) 通道与界面
  for (const channel of [
    'knowledge:reviewState',
    'knowledge:reviewAudit',
    'knowledge:reviewVerify',
    'knowledge:reviewApply',
    'knowledge:reviewDiscard',
    'knowledge:reviewCancel'
  ]) {
    if (!main.includes(`ipcMain.handle('${channel}'`)) problems.push(`main.js 没注册 ${channel}`);
    if (!preload.includes(`invoke('${channel}'`)) problems.push(`preload.js 没暴露 ${channel}`);
  }
  for (const id of ['reviewAudit', 'reviewVerify', 'reviewList', 'reviewSummary', 'reviewProgress', 'reviewLimit']) {
    if (!html.includes(`id="${id}"`)) problems.push(`面板 HTML 少了 #${id}`);
  }
  if (!/on\.knowledgeReview\(/.test(panel)) problems.push('面板没有订阅 knowledge:review（跑起来看不到进度）');
  // 7) 锁定按钮 + 勾选框真的在界面里
  if (!/knowledge-pick/.test(panel)) problems.push('条目行没有勾选框（联网校对没法选目标）');
  if (!/locked: item\.locked !== true/.test(panel)) problems.push('条目行没有锁定按钮（只读只能改配置）');
  // 8) 配置项
  if (!/reviewLimit: 5/.test(settings)) problems.push('settings.js 里没有 knowledge.reviewLimit 默认值');
  if (!/clampNumber\(out\.knowledge, 'reviewLimit'/.test(settings)) problems.push('settings.js 没有清洗 reviewLimit');

  if (problems.length) fail(`整理/校对有问题：${problems.join('；')}`);
  else ok('最高思考档 + 只出建议 + 三处锁定拦截 + 快照校验 + 7 个通道 + 面板入口齐全');
}

function checkProactive() {
  console.log('\n[主动搭话] 可定制、会防重复、不抢话（DeepSeek API 页那张卡片）');
  const proactive = stripComments(read('src/main/proactive.js'));
  const copilot = stripComments(read('src/main/copilot.js'));
  const settings = read('src/main/settings.js');
  const main = stripComments(read('src/main/main.js'));
  const html = read('src/renderer/panel/index.html');
  const panel = stripComments(read('src/renderer/panel/panel.js'));
  const problems = [];

  // 1) 纯函数模块在，且关键能力都有
  for (const fn of ['buildProactivePrompt', 'parseProactiveAnswer', 'shouldSpeak', 'chooseMode']) {
    if (!new RegExp(`function ${fn}`).test(proactive)) problems.push(`proactive.js 里没有 ${fn}`);
  }
  if (!/\[跳过\]/.test(proactive)) problems.push('proactive.js 没有「[跳过]」的判定（模型说跳过就必须真的不发）');
  // 2) copilot 真的用上了：定时器、触发、限频、抢话判定、来源标记
  for (const [pattern, label] of [
    [/scheduleProactive\s*\(/, '定时器 scheduleProactive'],
    [/async triggerProactive\s*\(/, '触发 triggerProactive'],
    [/countRecent\(this\.proactiveTimes/, '每小时上限'],
    [/activityAfter/, '「搭话期间有人说话就作废」的判定'],
    [/proactiveSaid/, '防重复（把最近说过的喂回模型）'],
    [/source: .*'proactive'/, '回复的 source 标记'],
    [/emit\('proactive'/, 'proactive 事件（面板日志/统计要用）']
  ]) {
    if (!pattern.test(copilot)) problems.push(`copilot.js 缺 ${label}`);
  }
  // 3) 配置：新段落 + 迁移 + 清洗，老键不再当默认值
  if (!/proactive: \{/.test(settings)) problems.push('settings.js 里没有 proactive 默认段');
  if (!/function migrateLegacyWarmup/.test(settings)) problems.push('settings.js 没有老「冷场暖场」的迁移函数');
  if (!/migrateLegacyWarmup\(parsed\)/.test(settings)) problems.push('SettingsStore.load 没跑迁移');
  if (!/clampNumber\(out\.proactive/.test(settings)) problems.push('settings.js 没清洗 proactive 的数值');
  if (!/normaliseModes\(out\.proactive\.modes\)/.test(settings)) problems.push('settings.js 没清洗搭话方式表');
  if (/autoWarmup:\s*(true|false)/.test(settings)) {
    problems.push('settings.js 默认值里还留着 autoWarmup（升级后会绑到不存在的控件）');
  }
  // 4) 界面：新控件的 id 都在，老控件不许再出现
  for (const id of [
    'proactiveEnabled',
    'proactiveIdleSeconds',
    'proactiveMaxPerHour',
    'proactiveChance',
    'proactiveChanceOut',
    'proactiveMaxChars',
    'proactiveModeTopic',
    'proactiveModeAsk',
    'proactiveModeFollow',
    'proactiveUseKnowledge',
    'proactivePrompt',
    'proactiveNow',
    'proactiveHint'
  ]) {
    if (!html.includes(`id="${id}"`)) problems.push(`面板 HTML 少了 #${id}`);
  }
  // 「进场招呼」删了（收不到 INTERACT_WORD）：两处都不许再冒出来
  if (html.includes('proactiveGreetEnter') || panel.includes('proactiveGreetEnter')) {
    problems.push('面板里还留着「进场招呼」的开关（这条连接收不到进场事件，功能永远不会触发）');
  }
  if (/'proactive\.greetEnter'/.test(panel)) problems.push('panel.js 还绑着 proactive.greetEnter');
  if (/\bgreetEnter\b/.test(settings)) problems.push('settings.js 还留着 proactive.greetEnter（删掉的功能不该留在默认配置里）');
  for (const old of ['autoWarmup', 'warmupQuietSeconds', 'warmupPrompt']) {
    if (html.includes(`id="${old}"`)) problems.push(`面板 HTML 里还留着老控件 #${old}`);
    if (panel.includes(old)) problems.push(`panel.js 里还绑着老字段 ${old}`);
  }
  for (const path of [
    'proactive.enabled',
    'proactive.idleSeconds',
    'proactive.maxPerHour',
    'proactive.chancePercent',
    'proactive.maxChars',
    'proactive.useKnowledge',
    'proactive.prompt'
  ]) {
    if (!panel.includes(`'${path}'`)) problems.push(`panel.js 没有绑定 ${path}`);
  }
  if (!/PROACTIVE_MODE_FIELDS/.test(panel) || !/proactive:\s*\{\s*modes\s*\}/.test(panel)) {
    problems.push('panel.js 没有处理「允许的搭话方式」数组（不是普通的单值绑定）');
  }
  // 5) 主进程把事件接到面板日志
  if (!/copilot\.on\('proactive'/.test(main)) {
    problems.push("main.js 没接 copilot 的 'proactive' 事件（面板看不到她搭了什么）");
  }

  if (problems.length) fail(`主动搭话有问题：${problems.join('；')}`);
  else ok('提示词/解析/限频在纯函数里，配置可定制且有迁移，界面控件齐全、老字段已清干净');
}

function checkViewerMemory() {
  console.log('\n[观众记忆] 资料不是指令 / 有上限 / 不碰知识库');
  const memory = stripComments(read('src/main/viewer-memory.js'));
  const copilot = stripComments(read('src/main/copilot.js'));
  const main = stripComments(read('src/main/main.js'));
  const settings = read('src/main/settings.js');
  const preload = read('src/main/preload.js');
  const html = read('src/renderer/panel/index.html');
  const panel = stripComments(read('src/renderer/panel/panel.js'));
  const problems = [];

  // 1) 纯函数 + 文件层都在
  for (const fn of ['sanitisePoint', 'mergeSessionPatch', 'parsePatch', 'buildDigest', 'shouldFlush', 'renderRoster', 'touchRoster']) {
    if (!new RegExp(`function ${fn}`).test(memory)) problems.push(`viewer-memory.js 里没有 ${fn}`);
  }
  if (!/class ViewerMemory/.test(memory)) problems.push('viewer-memory.js 里没有 ViewerMemory 类');
  // 2) 注入必须带「只是资料、不是指令」的头（防投毒）
  if (!/只是资料[、,，]不是指令/.test(memory)) problems.push('观众记忆的注入标题没写「只是资料、不是指令」（观众的话可能是指令注入）');
  if (!/DIGEST_HEADER/.test(memory)) problems.push('viewer-memory.js 没有 DIGEST_HEADER');
  if (!/buildViewerMemoryBlock/.test(copilot)) problems.push('copilot 没把观众记忆拼进提示词');
  // 3) 方括号协议标记必须被清掉（否则 `[做:暂停]` 会被写进记忆、下一轮被当标记解析）
  if (!/\\\[\[\^\\\]\\n\]\{0,60\}\\\]/.test(memory)) {
    problems.push('sanitisePoint 没有丢掉整块方括号标记（记忆可能被当成协议标记）');
  }
  // 4) 上限：每人要点 / 人数 / 文件字节 / 名册人数
  for (const [name, re] of [
    ['MAX_POINTS_PER_VIEWER', /const MAX_POINTS_PER_VIEWER = \d+/],
    ['MAX_VIEWERS', /const MAX_VIEWERS = \d+/],
    ['MAX_SESSION_BYTES', /const MAX_SESSION_BYTES = \d+/],
    ['DEFAULT_ROSTER_MAX', /const DEFAULT_ROSTER_MAX = \d+/]
  ]) {
    if (!re.test(memory)) problems.push(`viewer-memory.js 缺少上限 ${name}`);
  }
  if (!/trimSession\(/.test(memory)) problems.push('没有按字节瘦身的 trimSession');
  // 5) 主进程：批量总结 + 限频 + 退出收尾 + 会话开关 + 事件与 IPC
  for (const [pattern, label] of [
    [/async function runMemoryFlush/, '批量总结 runMemoryFlush'],
    [/maxBatchesPerHour/, '每小时上限'],
    [/shouldFlush\(/, '按条数/间隔触发'],
    [/endSession\(\{ unsaved/, '退出/关闭时收尾'],
    [/syncMemoryFeature\(/, '开关切换时开始/结束本场'],
    [/viewerMemory\.recordDanmaku/, '名册本地记'],
    [/copilot\.on\('viewer-line'/, '订阅观众弹幕'],
    [/copilot\.on\('operator-line'/, '订阅主播的话'],
    [/copilot\.on\('viewer-lookup'/, '处理 [查观众:]'],
    [/send\(panelWindow, 'memory:changed'/, '状态变化广播'],
    [/thinking: 'off'/, '总结用关思考（省钱）']
  ]) {
    if (!pattern.test(main)) problems.push(`main.js 缺 ${label}`);
  }
  // 6) 文件绝不能建在知识库里（进检索、被整理校对改写）
  if (!/path\.join\(app\.getPath\('userData'\), viewerMemoryShared\.DIR_NAME\)/.test(main)) {
    problems.push('观众记忆目录不是 data/观众记忆（必须是 userData 下的独立目录）');
  }
  if (/knowledge\.dir[\s\S]{0,40}观众记忆/.test(main)) problems.push('观众记忆目录别放进知识库（会被检索和整理校对碰到）');
  // 7) IPC / preload / 界面
  for (const channel of [
    'memory:state',
    'memory:flush',
    'memory:openFolder',
    'memory:openFile',
    'memory:clearSession',
    'memory:clearRoster'
  ]) {
    if (!main.includes(`ipcMain.handle('${channel}'`)) problems.push(`main.js 没注册 ${channel}`);
    if (!preload.includes(`invoke('${channel}'`)) problems.push(`preload.js 没暴露 ${channel}`);
  }
  if (!/memoryChanged: \(handler\) => on\('memory:changed'/.test(preload)) problems.push('preload 没暴露 memory:changed');
  for (const id of [
    'memoryStatus',
    'memoryAutoStart',
    'memoryEnabled',
    'memoryRosterEnabled',
    'memoryBatchSize',
    'memoryIntervalSec',
    'memoryMaxBatches',
    'memoryInjectChars',
    'memoryRosterMax',
    'memoryFlush',
    'memoryOpenFile',
    'memoryOpenRoster',
    'memoryOpenFolder',
    'memoryClearSession',
    'memoryClearRoster'
  ]) {
    if (!html.includes(`id="${id}"`)) problems.push(`面板 HTML 少了 #${id}`);
  }
  for (const path of [
    'viewerMemory.autoStart',
    'viewerMemory.enabled',
    'viewerMemory.rosterEnabled',
    'viewerMemory.batchSize',
    'viewerMemory.intervalSec',
    'viewerMemory.maxBatchesPerHour',
    'viewerMemory.injectChars',
    'viewerMemory.rosterMax'
  ]) {
    if (!panel.includes(`'${path}'`)) problems.push(`panel.js 没有绑定 ${path}`);
  }
  // 8) 配置：段存在 + 清洗
  if (!/viewerMemory: \{/.test(settings)) problems.push('settings.js 里没有 viewerMemory 默认段');
  if (!/clampNumber\(out\.viewerMemory/.test(settings)) problems.push('settings.js 没清洗 viewerMemory 的数值');
  if (!/autoStart: true/.test(settings)) problems.push('settings.js 里 autoStart 默认不是 true（主播要的「默认打开」）');
  if (!/out\.viewerMemory\.autoStart = out\.viewerMemory\.autoStart !== false/.test(settings)) {
    problems.push('settings.js 没清洗 autoStart（只有明确写 false 才关）');
  }
  // 9) 「每次启动自动记录」只许在启动那一段动手：塞进 syncMemoryFeature 会跟主播手动关掉抢开关
  const bootMemory = (main.match(/function bootViewerMemory\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (!bootMemory) problems.push('main.js 没有 bootViewerMemory（启动时按 autoStart 自动开一场）');
  else {
    if (!/config\.autoStart !== false/.test(bootMemory)) problems.push('bootViewerMemory 没看 autoStart');
    if (!/enabled: true/.test(bootMemory)) problems.push('bootViewerMemory 没替主播把本场记录打开');
  }
  const syncMemory = (main.match(/function syncMemoryFeature\(\) \{[\s\S]*?\n\}/) || [''])[0];
  if (/autoStart/.test(syncMemory)) {
    problems.push('autoStart 不许写进 syncMemoryFeature（主播直播中手动关掉会被立刻重新打开）');
  }
  if (!/^\s*bootViewerMemory\(\);/m.test(main)) problems.push('启动流程没调 bootViewerMemory');
  // 10) 老观众标注在 copilot 里真的用了
  if (!/this\.viewerMemory\.tagFor/.test(copilot)) problems.push('copilot 没用老观众标注（tagFor）');

  if (problems.length) fail(`观众记忆有问题：${problems.join('；')}`);
  else ok('资料不是指令 + 方括号清洗 + 上限齐全 + 批量/限频/收尾都在 + 「每次启动自动记录」不跟手动开关抢 + 界面与配置对得上');
}

/**
 * 删掉的「礼物 / 上舰 / 醒目留言 / 进场」（2026-10-21）不许留残迹。
 *
 * 为什么单独查：这条连接**根本收不到** SEND_GIFT / GUARD_BUY / SUPER_CHAT / INTERACT_WORD，
 * 所以解析、事件入口、设置项、界面上的两个勾全删了。以后要是又看到 `showGift` 这类键，
 * 八成是有人"补回来一个开关"却没补解析——那正是要防的状态：界面有开关、实际永不触发。
 */
function checkRemovedLiveEvents() {
  console.log('\n[礼物/进场] 删掉的功能不留残迹');
  const problemsBefore = problems;
  const html = read('src/renderer/panel/index.html');
  const panel = read('src/renderer/panel/panel.js');
  const settings = read('src/main/settings.js');
  const danmaku = read('src/main/danmaku.js');
  const copilot = read('src/main/copilot.js');
  const main = read('src/main/main.js');
  const preload = read('src/main/preload.js');

  for (const id of ['showGift', 'showSuperChat', 'showEnter']) {
    if (html.includes(`id="${id}"`)) {
      problems.push(`面板还有 #${id}（这条连接收不到礼物/进场，勾了也不会触发）`);
    }
  }
  for (const key of ['danmaku.showGift', 'danmaku.showSuperChat', 'danmaku.showEnter']) {
    if (panel.includes(`'${key}'`)) problems.push(`panel.js 还绑着 ${key}`);
  }
  for (const key of ['showGift', 'showSuperChat', 'showEnter']) {
    if (new RegExp(`\\b${key}\\s*:`).test(settings)) problems.push(`settings.js 默认配置里还留着 ${key}`);
  }
  // 注释里提到这些命令名是允许的（说明为什么删），这里只挡"真的还在干活"的代码
  for (const [pattern, label] of [
    [/case 'SEND_GIFT'/, 'SEND_GIFT 解析分支'],
    [/case 'GUARD_BUY'/, 'GUARD_BUY 解析分支'],
    [/case 'SUPER_CHAT_MESSAGE'/, '醒目留言解析分支'],
    [/case 'INTERACT_WORD'/, '进场解析分支'],
    [/_onGift\(|_onGuard\(|_onSuperChat\(|_onInteract\(/, '礼物/进场解析器'],
    [/emit\(\s*'(gift|guard|superchat|enter)'/, '礼物/进场事件 emit']
  ]) {
    if (pattern.test(danmaku)) problems.push(`danmaku.js 还在为「${label}」干活`);
  }
  if (/^\s{2}onEventMessage\(/m.test(copilot)) problems.push('copilot.js 还留着 onEventMessage（事件入口已删）');
  if (/copilot\.on\('live-event'/.test(main)) problems.push("main.js 还转发 'live-event'");
  if (/liveEvent:/.test(preload)) problems.push('preload.js 还暴露 liveEvent 通道');
  if (/on\.liveEvent/.test(panel)) problems.push('panel.js 还订阅 liveEvent');
  // 「为什么删」必须写在代码里，不然下一个人只会看到"功能怎么没了"
  if (!/收不到/.test(danmaku)) problems.push('danmaku.js 没写清「为什么删」（这条连接收不到这类命令）');

  if (problems === problemsBefore) ok('解析 / 事件 / 两个勾选框都清干净了，且留了「为什么删」的说明');
}

/**
 * 日志上限（2026-10-21 加）：boot.log / copilot.log 必须走**带轮转**的写入。
 *
 * 以前两处都是裸 `appendFileSync`，一路追加没有上限。实测一次异常刷屏
 * （「观众记忆总结失败」死循环重试）**一分钟写了 298MB**，磁盘写满、CPU 打满。
 * 这条检查防的就是"谁又把它改回裸 append"。
 */
function checkLogRotation() {
  console.log('\n[日志] 单文件封顶 + 轮转');
  const problemsBefore = problems;
  const logger = read('src/main/logger.js');
  const main = read('src/main/main.js');
  if (!/const DEFAULT_MAX_LOG_BYTES = 5 \* 1024 \* 1024/.test(logger)) {
    problems.push('logger.js 没有 5MB 上限（DEFAULT_MAX_LOG_BYTES）');
  }
  if (!/function appendWithRotation/.test(logger) || !/function rotateLogFile/.test(logger)) {
    problems.push('logger.js 没有轮转实现（appendWithRotation / rotateLogFile）');
  }
  if (!/appendWithRotation\(this\.file, line \+ '\\n'\)/.test(logger)) {
    problems.push('Logger.appendFile 没走轮转');
  }
  if (/fs\.appendFileSync\(this\.file/.test(logger)) problems.push('Logger.appendFile 又回到裸 append（无上限）');
  if (!/appendWithRotation\(BOOT_LOG/.test(main)) problems.push('bootLog 没走轮转');
  if (/fs\.appendFileSync\(BOOT_LOG/.test(main)) problems.push('bootLog 又回到裸 append（无上限）');
  if (problems === problemsBefore) ok('bootLog / copilot.log 都走轮转，单文件封顶 5MB、留一份 .1');
}

/**
 * 待审草稿的批量入口（2026-10-21 加）：顶部「全部通过」和「清空待审」。
 * 两个都是**破坏性操作**，必须：① 先确认；② 通过走逐条 approve（每条留 create 记录，能撤销）；
 * ③ 清空只删 pending，绝不碰知识库。
 */
function checkPendingBatch() {
  console.log('\n[待审] 批量通过 / 清空待审');
  const problemsBefore = problems;
  const knowledge = read('src/main/knowledge.js');
  const main = read('src/main/main.js');
  const preload = read('src/main/preload.js');
  const panel = read('src/renderer/panel/panel.js');
  const html = read('src/renderer/panel/index.html');

  if (!/clearPending\(\)\s*\{/.test(knowledge)) problems.push('knowledge.js 没有 clearPending');
  if (!/ipcMain\.handle\('knowledge:clearPending'/.test(main)) problems.push('main.js 没注册 knowledge:clearPending');
  if (!/invoke\('knowledge:clearPending'\)/.test(preload)) problems.push('preload 没暴露 knowledge:clearPending');
  for (const id of ['pendingApproveAll', 'pendingClear']) {
    if (!html.includes(`id="${id}"`)) problems.push(`面板少了 #${id}`);
  }
  // 「全部通过」必须复用逐条 approve 的那段（否则一次性写库就没有每条的新建记录，撤不回来）
  if (!/approveAllDraftsAsync\(\)/.test(panel)) problems.push('panel 没复用 approveAllDraftsAsync（会丢掉可撤销的记录）');
  if (!/knowledge\.clearPending\(\)/.test(panel)) problems.push('panel 没调用 knowledge.clearPending');
  const approveBlock = (panel.match(/pendingApproveAll'\);[\s\S]{0,1600}/) || [''])[0];
  const clearBlock = (panel.match(/pendingClear'\);[\s\S]{0,1600}/) || [''])[0];
  if (!/confirmDialog\(/.test(approveBlock)) problems.push('「全部通过」没有二次确认');
  if (!/confirmDialog\(/.test(clearBlock)) problems.push('「清空待审」没有二次确认');
  if (problems === problemsBefore) {
    ok('两个批量入口都在、都先确认，通过走逐条 approve（有记录可撤销），清空只删草稿');
  }
}

/**
 * 打包发布（2026-10-21 加）：程序根目录必须由 `app-paths.appRoot()` 统一决定。
 *
 * 打包后 Electron 的源码在 `resources/app/src/main`，`__dirname/../../data` 会指向
 * **安装包内部**——用户翻不到，装到 Program Files 还根本写不进去。
 * 这条检查盯三件事：
 *   1. 只有 app-paths.js 能算根目录，别处不许再拼 `__dirname/..` 的 data；
 *   2. settings / logger / main 三处都必须用 appRoot()；
 *   3. 构建脚本必须排除真实数据、扫描密钥、并在冒烟后确认没写进 resources/app。
 */
function checkPackaging() {
  console.log('\n[打包] 发布包里数据放哪 + 隐私守卫');
  const problemsBefore = problems;
  const html = '';
  void html;
  const main = read('src/main/main.js');
  const settings = read('src/main/settings.js');
  const logger = read('src/main/logger.js');
  const paths = read('src/main/app-paths.js');
  const build = read('scripts/build-release.js');
  const gitignore = read('.gitignore');

  // 1) 根目录只在 app-paths.js 里算
  if (!/function appRoot\(\)/.test(paths)) problems.push('app-paths.js 没有 appRoot()');
  if (!/app\.isPackaged/.test(paths) || !/process\.execPath/.test(paths)) {
    problems.push('app-paths.js 没按「打包版 = exe 目录」判断（app.isPackaged / process.execPath）');
  }
  if (!/DSH_APP_ROOT/.test(paths)) problems.push('app-paths.js 不支持 DSH_APP_ROOT 覆盖（测试和换盘都要它）');
  // 2) 三处消费者
  if (!/appRoot\(\)/.test(settings)) problems.push('settings.js 没用 appRoot() 定位配置文件（打包后会写进 resources/app）');
  if (!/appRoot\(\)/.test(logger)) problems.push('logger.js 没用 appRoot() 定位日志文件');
  if (!/const APP_ROOT = appRoot\(\)/.test(main)) problems.push('main.js 的 APP_ROOT 不是从 app-paths 取的');
  // 3) 不许再有「从 __dirname 拼 data」的老写法（就是这次踩的坑）
  for (const [name, text] of [
    ['main.js', main],
    ['settings.js', settings],
    ['logger.js', logger]
  ]) {
    if (/__dirname,\s*'\.\.',\s*'\.\.',\s*'data'/.test(text)) {
      problems.push(`${name} 还在用 __dirname 拼 data（打包后会落进 resources/app）`);
    }
  }
  // 4) 构建脚本的硬性守卫
  for (const [pattern, label] of [
    [/secret|apiKey/, '密钥扫描'],
    [/strayDirs/, '「数据写进 resources/app」的回归守卫'],
    [/electron\.exe/, '复用 Electron 运行时'],
    [/renameSync\(originalExe/, '把 electron.exe 改成产品名'],
    [/KEEP_LOCALES/, '裁掉多余语言包'],
    [/使用说明\.txt/, '生成使用说明'],
    [/--smoke-test/, '产物冒烟验证']
  ]) {
    if (!pattern.test(build)) problems.push(`build-release.js 缺少${label}`);
  }
  if (!/copyDir\(path\.join\(root, 'src'\)/.test(build)) problems.push('build-release.js 没把 src 复制进产物');
  if (/copyDir\([^\n]*'data'/.test(build) || /copyDir\([^\n]*知识库/.test(build)) {
    problems.push('build-release.js 居然在复制真实 data / 知识库（绝对不能进分享包）');
  }
  // 5) 产物目录不能进版本库
  if (!/发布包\//.test(gitignore)) problems.push('.gitignore 没排除 发布包/（几百 MB 别进 git）');
  // 6) 内置默认吉祥物素材（2026-10-21）：素材要在、要进包、第一次启动要能种进配置
  const mascotDefaults = read('src/main/mascot-defaults.js');
  if (!/function findMascotFolder/.test(mascotDefaults)) problems.push('mascot-defaults.js 没有 findMascotFolder');
  if (!/function loadMascotImages/.test(mascotDefaults)) problems.push('mascot-defaults.js 没有 loadMascotImages');
  if (!/MASCOT_DIR_NAME/.test(mascotDefaults)) problems.push('mascot-defaults.js 没定义素材目录名');
  if (!/seedBundledMascot\(\)/.test(main)) problems.push('main.js 没调用 seedBundledMascot()（装上就没有默认吉祥物）');
  if (!/bundledSeeded/.test(main)) problems.push('main.js 没有「内置素材只种一次」的标记（删掉的图会长回来）');
  if (!/copyDir\(mascotSrc/.test(build)) problems.push('build-release.js 没把 默认素材图片 复制进发布包');
  let mascotFiles = [];
  try {
    mascotFiles = fs
      .readdirSync(path.join(root, '默认素材图片', '吉祥物大肥鱼'))
      .filter((name) => /\.(png|jpe?g|webp|gif)$/i.test(name));
  } catch (_) {
    mascotFiles = [];
  }
  if (mascotFiles.length < 8) {
    problems.push(`默认素材图片 里只有 ${mascotFiles.length} 张图（12 个表情至少要 8 张才够配）`);
  }
  // 7) 吉祥物状态与素材名要对得上（不然「自动按文件名匹配」会有一半空着）
  const emotions = read('src/shared/emotions.js');
  const missing = mascotFiles
    .map((name) => name.replace(/\.[^.]+$/, ''))
    .filter((label) => !emotions.includes(`'${label}'`));
  if (missing.length) problems.push(`这些素材名在 emotions.js 里找不到对应词（配不上图）：${missing.join('、')}`);

  if (problems === problemsBefore) {
    ok('根目录统一由 app-paths 决定（打包后 = exe 旁边），默认吉祥物素材进包并只种一次，构建脚本带密钥扫描和冒烟守卫');
  }
}

console.log('===== 静态一致性审计 =====');
checkDomIds({ name: '控制面板', htmlFile: 'src/renderer/panel/index.html', jsFiles: ['src/renderer/panel/panel.js'] });
checkDomIds({ name: '悬浮窗', htmlFile: 'src/renderer/overlay/index.html', jsFiles: ['src/renderer/overlay/overlay.js'] });
checkGlobalScopeConflicts();
checkIpc();
checkSettingsKeys();
checkSyntax();
checkSettingsStoreSafety();
checkNativeDialogs();
checkDshWorkspace();
checkDshSessionProtocol();
checkDshSessionRegistry();
checkResearchPipeline();
checkHiddenToggles();
checkOverlayResize();
checkKnowledgeReview();
checkProactive();
checkRemovedLiveEvents();
checkViewerMemory();
checkLogRotation();
checkPendingBatch();
checkPackaging();
checkEncoding();

console.log(`\n===== 结果：${checks} 项通过，${problems} 项问题 =====`);
process.exit(problems ? 1 : 0);
