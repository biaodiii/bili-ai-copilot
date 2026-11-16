'use strict';

/**
 * 打「发布 / 分享版」——便携文件夹形态（2026-10-21；2026-11-16 改成固定目录）。
 *
 *   node scripts/build-release.js                 # 输出到 <项目上一级>\发布包\直播AI搭档-win64
 *   node scripts/build-release.js --out E:\发布     # 换输出位置
 *   node scripts/build-release.js --clean         # 连 data / 知识库 一起清空（恢复出厂）
 *   node scripts/build-release.js --skip-audit    # 跳过静态审计（不推荐）
 *   node scripts/build-release.js --no-smoke      # 跳过产物冒烟验证（不推荐）
 *
 * ⚠️ 产物**默认不放项目文件夹里**（主播 2026-10-21 要求）：几百 MB 的东西混在源码目录里，
 *    备份/同步/看代码都碍事。默认丢到项目上一层的 `发布包\`，想换位置用 `--out`。
 *
 * ⚠️ **目录名不再带版本号**（2026-11-16 主播反馈「覆盖新版后 API Key / 人设丢了」）：
 *    以前产物叫 `直播AI搭档-0.2.0-win64`，换版本就是一个新文件夹；用户"覆盖"时
 *    要么新开一个目录（旧配置留在旧目录）、要么删旧目录重建 → 配置全丢。
 *    现在固定输出 `直播AI搭档-win64`，而且**构建只替换程序文件、保留 data/知识库**；
 *    另出一个「升级包.zip」（只含程序文件），解压到旧文件夹覆盖即可。
 *
 * 为什么不用 electron-builder：这个项目只有一个运行时依赖（ws），Electron 运行时本来就在
 * node_modules/electron/dist 里躺着了。直接复用它 = **不装额外工具、不联网、不签名**，
 * 产出一个「解压后双击 exe 就能用」的文件夹。代价是 exe 图标还是 Electron 默认图标
 * （改图标需要 rcedit 之类的工具，以后要做安装包时再说）。
 *
 * 产物长这样（数据在 exe 旁边，拷走整个文件夹就带走全部配置和笔记）：
 *
 *   直播AI搭档-win64/            ← 固定目录：以后覆盖同一个目录，配置不会丢
 *     直播AI搭档.exe            ← 由 electron.exe 改名
 *     使用说明.txt
 *     data/                     ← 你的配置/日志/观众记忆/语音存档（构建不碰）
 *     知识库/                    ← 你的知识笔记（构建不碰）
 *     resources/app/            ← 我们的源码 + ws
 *     locales/                  ← 只留中文/英文（省约 38MB）
 *
 *   直播AI搭档-0.2.0-升级包.zip  ← 只含程序文件（没有 data/知识库），解压覆盖用
 *
 * 三条硬性要求（发错一条就泄露主播隐私）：
 *   1. **绝不**打包真实的 `data/`、`知识库/`、`data/观众记忆/`；
 *   2. 打完**扫描整个产物**，发现主播的 DeepSeek Key / B 站 Cookie / 阿里云 Key 就报错退出；
 *   3. 默认先跑 `audit.js`，再跑一次产物自己的 `--smoke-test`，都通过才算打完。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const product = String(pkg.productName || pkg.name || '直播AI搭档');
const version = String(pkg.version || '0.0.0');
const exeName = `${product}.exe`;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index > 0 ? String(process.argv[index + 1] || '') : '';
}

// 默认输出到项目**上一级**的 发布包\：产物不进项目目录（主播 2026-10-21 要求）
const outRoot = path.resolve(argValue('--out') || path.join(root, '..', '发布包'));
/** 固定发布目录（2026-11-16）：**不带版本号**，覆盖同一目录时 data 不会被换走 */
const outDir = path.join(outRoot, `${product}-win64`);
/** 构建先落在临时目录：验证通过后再同步，失败也不会碰用户的 data/知识库 */
const stageDir = path.join(outRoot, `._build-${process.pid}`);
/** 升级包：只含程序文件，不含 data/知识库；解压到旧文件夹覆盖即可 */
const updateZip = path.join(outRoot, `${product}-${version}-升级包.zip`);
const cleanData = process.argv.includes('--clean');
const skipAudit = process.argv.includes('--skip-audit');
const skipSmoke = process.argv.includes('--no-smoke');

const SKIP_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);
/** 只留这两个语言包：全部 locales 有 40MB，中文用户用不到其他语言 */
const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak'];
/** 这两个目录属于用户，构建时永远保留（除非 --clean） */
const USER_DIRS = new Set(['data', '知识库']);

let step = 0;
const startedAt = Date.now();

function log(message) {
  console.log(message);
}

function stepLog(title) {
  step += 1;
  console.log(`\n=== ${step}. ${title} ===`);
}

function fail(message) {
  console.error(`\n[X] ${message}`);
  console.error('打包中止。上面打过的东西留在原处，方便你看一眼问题出在哪。');
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function mb(bytes) {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function dirSize(dir) {
  return walk(dir).reduce((sum, file) => {
    try {
      return sum + fs.statSync(file).size;
    } catch (_) {
      return sum;
    }
  }, 0);
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** 复制目录；filter(相对路径) 返回 false 就跳过 */
function copyDir(from, to, filter) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const relative = path.relative(from, source).split(path.sep).join('/');
    if (filter && !filter(relative, entry)) continue;
    if (entry.isDirectory()) copyDir(source, target, filter);
    else copyFile(source, target);
  }
}

/** 复制「一个顶层条目」（文件或目录） */
function copyEntry(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) copyDir(from, to);
  else copyFile(from, to);
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Node 的 writeFileSync 默认就是无 BOM 的 UTF-8；这里显式写成 CRLF，老记事本也能正常看
  fs.writeFileSync(file, String(text).replace(/\r?\n/g, '\r\n'), 'utf8');
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// ---------------------------------------------------------------- 0. 前置检查

stepLog('前置检查');
assert(fs.existsSync(path.join(electronDist, 'electron.exe')), `没找到 Electron 运行时：${electronDist}
  先在项目根目录跑「安装依赖.bat」（或 npm install），装好再打包。`);
const wsDir = path.join(root, 'node_modules', 'ws');
assert(fs.existsSync(path.join(wsDir, 'index.js')), '没找到 ws 依赖（node_modules/ws）；先 npm install');

// 只允许动「看起来就是我们自己产物」的目录，防止 --out 写错把别人的东西删了
assert(path.basename(outDir) === `${product}-win64`, `发布目录名不对劲，拒绝写入：${outDir}`);
assert(path.dirname(stageDir) === outRoot, `临时构建目录不对劲，拒绝写入：${stageDir}`);
log(`产品：${product}  版本：${version}`);
log(`发布目录：${outDir}（固定目录，覆盖不丢 data / 知识库）`);
log(`临时构建：${stageDir}`);
log(`Electron：${electronDist}`);

// ---------------------------------------------------------------- 1. 静态审计

if (skipAudit) {
  log('\n[!] 已跳过静态审计（--skip-audit）');
} else {
  stepLog('静态审计（audit.js）');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'audit.js')], {
    cwd: root,
    stdio: 'inherit'
  });
  assert(result.status === 0, '静态审计没过，先修好再打包（--skip-audit 可以跳过，但别习惯性跳过）');
}

// ---------------------------------------------------------------- 2. 准备临时构建目录
//
// 为什么先构建到临时目录：同步到固定目录时只替换程序文件、保留 data/知识库；
// 万一审计/冒烟/压缩失败，用户正在用的目录一个字节都不会被碰。

stepLog('准备临时构建目录');
if (fs.existsSync(stageDir)) {
  fs.rmSync(stageDir, { recursive: true, force: true });
  log(`已清掉上次残留的 ${path.basename(stageDir)}`);
}
fs.mkdirSync(stageDir, { recursive: true });

// ---------------------------------------------------------------- 3. 复制 Electron 运行时

stepLog('复制 Electron 运行时');
for (const entry of fs.readdirSync(electronDist, { withFileTypes: true })) {
  if (SKIP_NAMES.has(entry.name)) continue;
  if (entry.isDirectory()) continue; // locales / resources 单独处理
  copyFile(path.join(electronDist, entry.name), path.join(stageDir, entry.name));
}
const localesDir = path.join(electronDist, 'locales');
if (fs.existsSync(localesDir)) {
  fs.mkdirSync(path.join(stageDir, 'locales'), { recursive: true });
  for (const name of KEEP_LOCALES) {
    const file = path.join(localesDir, name);
    if (fs.existsSync(file)) copyFile(file, path.join(stageDir, 'locales', name));
  }
}
// electron 自带的 default_app.asar 是「没有 app 时」的兜底，进产物毫无意义
const defaultApp = path.join(stageDir, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp, { force: true });
log(`运行时文件：${fs.readdirSync(stageDir).filter((n) => fs.statSync(path.join(stageDir, n)).isFile()).length} 个（已裁掉多余语言包）`);

// ---------------------------------------------------------------- 4. 复制应用源码

stepLog('复制应用源码');
const appDir = path.join(stageDir, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });

// package.json 重新生成：去掉 devDependencies / scripts，只留运行时需要的
const shippedPkg = {
  name: pkg.name,
  productName: product,
  version,
  description: pkg.description,
  main: pkg.main || 'src/main/main.js',
  private: true,
  dependencies: { ws: (pkg.dependencies && pkg.dependencies.ws) || '^8.18.0' }
};
writeText(path.join(appDir, 'package.json'), `${JSON.stringify(shippedPkg, null, 2)}\n`);

copyDir(path.join(root, 'src'), path.join(appDir, 'src'));
copyDir(wsDir, path.join(appDir, 'node_modules', 'ws'));

// 内置默认吉祥物素材（2026-10-21）：放在 exe 旁边，用户能看见；
// 程序第一次启动会把它们导进设置当默认吉祥物（main.js 的 seedBundledMascot）。
const mascotSrc = path.join(root, '默认素材图片');
if (fs.existsSync(mascotSrc)) {
  copyDir(mascotSrc, path.join(stageDir, '默认素材图片'));
  const mascotFiles = walk(path.join(stageDir, '默认素材图片')).length;
  log(`默认吉祥物素材：${mascotFiles} 个文件（第一次启动自动导入）`);
} else {
  log('[!] 没找到 默认素材图片\\：这个包不会有内置吉祥物（用户得自己导入）');
}

// 空的 data / 知识库：这里只是给第一次安装的人建目录，同步时不会覆盖旧目录里的内容
fs.mkdirSync(path.join(stageDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(stageDir, '知识库'), { recursive: true });

// electron.exe → 直播AI搭档.exe
const originalExe = path.join(stageDir, 'electron.exe');
assert(fs.existsSync(originalExe), 'electron.exe 没复制过来？');
fs.renameSync(originalExe, path.join(stageDir, exeName));
log(`可执行文件：${exeName}（由 electron.exe 改名）`);

const srcFiles = walk(path.join(appDir, 'src')).length;
log(`源码：${srcFiles} 个文件 + ws 依赖`);

// ---------------------------------------------------------------- 5. 使用说明

stepLog('写使用说明');
const guide = `直播AI搭档 ${version} · 使用说明
================================================

一、这是什么
  一个给 B 站直播间用的 AI 搭档：读弹幕 → 用 DeepSeek 生成回复 → 显示在悬浮窗上
  （可选语音朗读、知识库、观众记忆）。需要你自己的 DeepSeek API Key。

二、怎么开始（三步）
  1. 双击本文件夹里的「${exeName}」。
  2. 控制面板 →「DeepSeek API」：填 API Key（在 platform.deepseek.com 申请）。
     想改名字 / 人设 / 上下文，去「人设」页（角色、系统提示词、记忆轮数、主播称呼都在那儿）。
  3. 控制面板 →「弹幕设置」：填直播间房间号 → 点「开启弹幕监听」。
     再点「显示悬浮窗」，直播时把悬浮窗拖到画面边上就行。

  想要更干净：托盘右键 →「无边框模式（只留吉祥物和回复）」，或「悬浮窗」页勾「无边框模式」。
  开启后只剩吉祥物和回复气泡、自动置顶；按住吉祥物就能拖动，再切一次恢复原样。

三、你的数据在哪（重要）
  全都在**本文件夹内**，拷走整个文件夹 = 带走全部配置和笔记：
    data\\settings.json     配置（含 API Key / Cookie，**别把这个文件夹发给别人**）
    data\\观众记忆\\        本场记录 + 老观众名册
    data\\语音存档\\        语音页「念一段话」保存下来的 wav + 同名 txt（txt 里记着用的语气）
    知识库\\                你的知识条目（一个条目一个 .md，能直接用记事本改）
    data\\boot.log          排查问题的日志（超过 5MB 会自动轮转）
  另外弹幕记录默认写在：我的文档\\直播AI搭档\\弹幕记录\\

  语音语气：「念一段话」可以选语气（自然/开心/温柔/撒娇/激动/生气/难过/认真/耳语）或自己写要求；
  只有 Qwen-Audio-3.1/3.0 这几款云模型认语气，默认的 qwen3-tts-flash 会把语气下拉置灰。

  吉祥物：第一次启动会自动导入 默认素材图片\\ 里那 12 张表情（平常/喜欢/害羞/睡觉/打招呼/
  疑惑/慌张/叹气/聆听/说话/突然出现/吃白饭）。想换图就在面板「吉祥物」页导入自己的；
  删掉的图不会再自己长回来。

四、Windows 提示 / 杀软
  这是没有代码签名的自编译程序，第一次运行 Windows 可能提示「已保护你的电脑」：
  点「更多信息」→「仍要运行」。个别杀软会误报（Electron 程序常见），需要加白名单。

五、出问题了怎么办
  1. 先看 data\\boot.log（只看最后几十行）；界面报错也会写 data\\renderer-error.log。
  2. 想要一份体检报告：在这个文件夹按住 Shift + 右键 →「在此处打开 PowerShell」，
     运行：.\\${exeName} --smoke-test
     然后把 data\\smoke-test.log 发出来。
  3. 想恢复出厂：关掉软件，删掉 data 文件夹（知识库别删），再打开会自动重建默认配置。

六、怎么更新到新版本（不会丢配置）
  从 0.2.0 起，发布目录名固定为「${product}-win64」，不再随版本号变化。

  方式一（推荐）：把新版本里的 ${exeName}、resources\\、locales\\、默认素材图片\\、
                  使用说明.txt 复制进本文件夹，覆盖同名文件。
  方式二：把新版本附带的「${product}-<版本>-升级包.zip」解压到本文件夹，覆盖同名文件。

  **无论哪种方式，都不要删本文件夹里的 data\\ 和 知识库\\**——
  你的 API Key、人设、音色、观众记忆、知识笔记全在里面。

  如果你现在用的还是旧版带版本号的文件夹（例如 ${product}-0.1.0-win64）：
  第一次升级时，把旧文件夹里的 data\\ 和 知识库\\ 整个复制到新文件夹，再启动新程序。

七、安全提醒
  API Key 目前以明文保存在 data\\settings.json（只在本机使用）。
  不要把 data 文件夹、截图里的 Key、或者整个软件文件夹随便发给别人。
`;
writeText(path.join(stageDir, '使用说明.txt'), guide);

// ---------------------------------------------------------------- 6. 隐私扫描

stepLog('隐私扫描（主播的 Key / Cookie 绝不能进包）');
const secrets = [];
try {
  const real = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
  const push = (label, value) => {
    const text = String(value || '').trim();
    if (text.length >= 12) secrets.push({ label, value: text });
  };
  push('DeepSeek API Key', real.api && real.api.apiKey);
  push('B 站 Cookie(SESSDATA)', real.danmaku && real.danmaku.sessdata);
  push('阿里云语音 Key', real.speech && real.speech.cloud && real.speech.cloud.apiKey);
} catch (_) {
  log('（没有可读的 data/settings.json，跳过真实配置比对——这也是正常情况）');
}
const TEXT_EXT = new Set(['.js', '.json', '.md', '.txt', '.html', '.css', '.mjs', '.yml', '.yaml', '.ini', '.bat', '.ps1']);
const leaks = [];
for (const file of walk(stageDir)) {
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    continue;
  }
  for (const secret of secrets) {
    if (text.includes(secret.value)) leaks.push(`${secret.label} → ${path.relative(stageDir, file)}`);
  }
}
if (secrets.length === 0) log('真实配置里没有可扫描的密钥（或读不到），本次只做了空包检查');
if (leaks.length) fail(`产物里发现了主播的私人密钥，绝不能再分享：\n  ${leaks.join('\n  ')}`);
log(`扫描了 ${walk(stageDir).length} 个文件，没有发现真实 Key / Cookie`);

// ---------------------------------------------------------------- 7. 冒烟验证

if (skipSmoke) {
  log('\n[!] 已跳过产物冒烟验证（--no-smoke）——不推荐：等于没验证过这个包能起来');
} else {
  stepLog('冒烟验证（真跑一遍产物自己的 --smoke-test）');
  const exePath = path.join(stageDir, exeName);
  /**
   * ⚠️ 必须清掉 `ELECTRON_RUN_AS_NODE`：
   * 从某些宿主环境（例如 Electron 里起的终端 / 自检工具）跑打包时，这个变量会继承给子进程，
   * 产物 exe 会**按 Node 解释器启动**，于是 `--smoke-test` 被当成 Node 参数 → 报
   * `bad option: --smoke-test`（退出码 9），看着像包坏了，其实只是环境变量没清。
   * 2026-10-21 实测踩到。
   */
  const smokeEnv = { ...process.env };
  delete smokeEnv.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(exePath, ['--smoke-test'], {
    cwd: stageDir,
    stdio: 'inherit',
    timeout: 120000,
    windowsHide: true,
    env: smokeEnv
  });
  assert(result.status === 0, `产物冒烟测试没过（退出码 ${result.status}）。看 ${path.join(stageDir, 'data', 'smoke-test.log')}`);
  const smokeLog = path.join(stageDir, 'data', 'smoke-test.log');
  assert(fs.existsSync(smokeLog), '冒烟测试跑完却没有 smoke-test.log？');
  const smokeText = fs.readFileSync(smokeLog, 'utf8');
  assert(!smokeText.includes('[FAIL]'), `冒烟测试里有失败项：\n${smokeText.slice(-800)}`);
  log('产物能正常启动（--smoke-test 通过）');

  // 冒烟在 data 里留下了日志/配置，清干净再进包（仍然保留空的 data、知识库 目录）
  const cleanDir = (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  };
  cleanDir(path.join(stageDir, 'data'));
  cleanDir(path.join(stageDir, '知识库'));

  // 回归守卫：如果配置/日志跑进了 resources/app 里（说明 APP_ROOT 没生效），
  // 这个包绝对不能发——用户会在安装包内部找配置，装到 Program Files 还会写不进去。
  const strayDirs = [path.join(appDir, 'data'), path.join(appDir, '知识库')].filter((dir) => fs.existsSync(dir));
  assert(
    strayDirs.length === 0,
    `冒烟测试把数据写进了安装包内部：${strayDirs.join('、')}
  说明 src/main/app-paths.js 的 appRoot() 没被 settings.js / logger.js 用上，
  修好再打包（真实用户会找不到配置，装到 Program Files 还会因为不可写直接丢配置）。`
  );
  log('已清掉冒烟测试产生的临时文件（data / 知识库 保持空的，且确认没写进 resources/app）');
}

// ---------------------------------------------------------------- 8. 同步到固定发布目录（保留用户数据）
//
// ⚠️ 这一步是 2026-11-16 修复「覆盖新版丢配置」的核心：
//    只替换程序文件，**data / 知识库 原样保留**（除非 --clean）。
//    用户以后直接把新版程序文件复制进来覆盖，API Key / 人设 / 知识笔记都不会丢。

stepLog('同步到固定发布目录（保留 data / 知识库）');
let keptFiles = 0;
if (fs.existsSync(outDir)) {
  for (const entry of fs.readdirSync(outDir, { withFileTypes: true })) {
    const target = path.join(outDir, entry.name);
    if (USER_DIRS.has(entry.name)) {
      keptFiles += walk(target).length;
      continue;
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
} else {
  fs.mkdirSync(outDir, { recursive: true });
}
for (const entry of fs.readdirSync(stageDir, { withFileTypes: true })) {
  if (USER_DIRS.has(entry.name)) continue; // 不拿临时目录里的空目录覆盖用户的
  copyEntry(path.join(stageDir, entry.name), path.join(outDir, entry.name));
}
fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(outDir, '知识库'), { recursive: true });

if (cleanData) {
  for (const name of USER_DIRS) {
    const dir = path.join(outDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  log('[--clean] 已清空 data / 知识库（恢复出厂）');
} else if (keptFiles > 0) {
  log(`保留了原来的 data / 知识库（${keptFiles} 个文件，未被覆盖）`);
} else {
  log('data / 知识库 是空的（第一次安装或之前没填过配置）');
}

// ---------------------------------------------------------------- 9. 生成升级包（不含用户数据）

stepLog('生成升级包（只含程序文件，解压覆盖用）');
const updateStage = path.join(outRoot, `._update-${process.pid}`);
fs.rmSync(updateStage, { recursive: true, force: true });
fs.mkdirSync(updateStage, { recursive: true });
for (const entry of fs.readdirSync(stageDir, { withFileTypes: true })) {
  if (USER_DIRS.has(entry.name)) continue;
  copyEntry(path.join(stageDir, entry.name), path.join(updateStage, entry.name));
}
const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
// 用系统自带的 tar.exe（bsdtar）打 zip：
//   · Windows 10 1803+ / 11 自带，不装任何工具；
//   · 条目分隔符是标准的 `/`（PowerShell 5.1 的 Compress-Archive / ZipFile 会写成 `\`，
//     放在别的解压工具/系统上会解出一堆带反斜杠的文件名）；
//   · 中文文件名会带 UTF-8 标记，资源管理器正常显示。
// 老系统没有 tar.exe 时退回 Compress-Archive（能用，但分隔符可能不标准）。
fs.rmSync(updateZip, { force: true });
const topEntries = fs.readdirSync(updateStage);
let zipResult = spawnSync('tar.exe', ['-a', '-c', '-f', updateZip, '-C', updateStage, ...topEntries], {
  stdio: 'inherit',
  windowsHide: true
});
if (zipResult.error && zipResult.error.code === 'ENOENT') {
  log('[!] 系统没有 tar.exe，退回 Compress-Archive（条目分隔符可能不是标准 /）');
  const zipCommand = `Compress-Archive -Path ${quote(path.join(updateStage, '*'))} -DestinationPath ${quote(updateZip)} -Force`;
  zipResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', zipCommand], {
    stdio: 'inherit',
    windowsHide: true
  });
}
assert(zipResult.status === 0, `生成升级包失败（退出码 ${zipResult.status}）：${updateZip}`);
fs.rmSync(updateStage, { recursive: true, force: true });
assert(fs.existsSync(updateZip), '升级包没有生成出来？');
log(`升级包：${updateZip}（${mb(fs.statSync(updateZip).size)}，不含 data / 知识库）`);

// ---------------------------------------------------------------- 10. 汇总

stepLog('打包完成');
const total = dirSize(stageDir);
const files = walk(stageDir).length;
const exeFile = path.join(stageDir, exeName);
const seconds = Math.round((Date.now() - startedAt) / 1000);
log(`发布目录：${outDir}`);
log(`升级包：${updateZip}`);
log(`本次程序：${mb(total)}（${files} 个文件，压缩前）`);
if (fs.existsSync(exeFile)) {
  log(`主程序：${exeName}（${mb(fs.statSync(exeFile).size)}）`);
  log(`SHA-256：${sha256(exeFile)}`);
}
log(`耗时：${seconds} 秒`);
log('');
log('分享前自查：');
log(`  · 发布目录固定为 ${path.basename(outDir)}，以后覆盖同一目录不会丢 data / 知识库。`);
log('  · 升级包只有程序文件；对方解压到旧文件夹覆盖即可，data / 知识库 原样保留。');
log(`  · data 和 知识库 现在是${cleanData ? '空的' : keptFiles > 0 ? '对方自己的（已保留）' : '空的'}，不会带出你的东西。`);
log('  · 对方解压/放好后双击 exe；第一次会提示没有 API Key，填上就能用。');

// 临时构建目录用完就删（失败时保留，方便排查）
try {
  fs.rmSync(stageDir, { recursive: true, force: true });
} catch (_) {
  /* 删不掉不影响结果 */
}
