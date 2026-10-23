'use strict';

/**
 * 打「发布 / 分享版」——便携文件夹形态（2026-10-21）。
 *
 *   node scripts/build-release.js                 # 默认输出到 <项目上一级>\发布包\直播AI搭档-<版本>-win64
 *   node scripts/build-release.js --out E:\发布     # 换输出位置
 *   node scripts/build-release.js --skip-audit    # 跳过静态审计（不推荐）
 *   node scripts/build-release.js --no-smoke      # 跳过产物冒烟验证（不推荐）
 *
 * ⚠️ 产物**默认不放项目文件夹里**（主播 2026-10-21 要求）：几百 MB 的东西混在源码目录里，
 *    备份/同步/看代码都碍事。默认丢到项目上一层的 `发布包\`，想换位置用 `--out`。
 *
 * 为什么不用 electron-builder：这个项目只有一个运行时依赖（ws），Electron 运行时本来就在
 * node_modules/electron/dist 里躺着了。直接复用它 = **不装额外工具、不联网、不签名**，
 * 产出一个「解压后双击 exe 就能用」的文件夹。代价是 exe 图标还是 Electron 默认图标
 * （改图标需要 rcedit 之类的工具，以后要做安装包时再说）。
 *
 * 产物长这样（数据在 exe 旁边，拷走整个文件夹就带走全部配置和笔记）：
 *
 *   直播AI搭档-0.1.0-win64/
 *     直播AI搭档.exe          ← 由 electron.exe 改名
 *     使用说明.txt
 *     data/                   ← 空目录；配置/日志/观众记忆第一次启动后落这里
 *     知识库/                  ← 空目录；首次启动自动建 notes/pending/inbox
 *     resources/app/          ← 我们的源码 + ws
 *     locales/                ← 只留中文/英文（省约 38MB）
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
const outDir = path.join(outRoot, `${product}-${version}-win64`);
const skipAudit = process.argv.includes('--skip-audit');
const skipSmoke = process.argv.includes('--no-smoke');

const SKIP_NAMES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);
/** 只留这两个语言包：全部 locales 有 40MB，中文用户用不到其他语言 */
const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak'];

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

// 只允许删「看起来就是我们自己产物」的目录，防止 --out 写错把别人的东西删了
const safeToDelete = outDir.includes(`${product}-`) && path.basename(outDir).endsWith('-win64');
assert(safeToDelete, `输出目录名不对劲，拒绝删除：${outDir}`);
log(`产品：${product}  版本：${version}`);
log(`输出：${outDir}`);
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

// ---------------------------------------------------------------- 2. 准备空目录

stepLog('准备输出目录');
if (fs.existsSync(outDir)) {
  fs.rmSync(outDir, { recursive: true, force: true });
  log(`已清掉旧的 ${path.basename(outDir)}`);
}
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------- 3. 复制 Electron 运行时

stepLog('复制 Electron 运行时');
for (const entry of fs.readdirSync(electronDist, { withFileTypes: true })) {
  if (SKIP_NAMES.has(entry.name)) continue;
  if (entry.isDirectory()) continue; // locales / resources 单独处理
  copyFile(path.join(electronDist, entry.name), path.join(outDir, entry.name));
}
const localesDir = path.join(electronDist, 'locales');
if (fs.existsSync(localesDir)) {
  fs.mkdirSync(path.join(outDir, 'locales'), { recursive: true });
  for (const name of KEEP_LOCALES) {
    const file = path.join(localesDir, name);
    if (fs.existsSync(file)) copyFile(file, path.join(outDir, 'locales', name));
  }
}
// electron 自带的 default_app.asar 是「没有 app 时」的兜底，进产物毫无意义
const defaultApp = path.join(outDir, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp, { force: true });
log(`运行时文件：${fs.readdirSync(outDir).filter((n) => fs.statSync(path.join(outDir, n)).isFile()).length} 个（已裁掉多余语言包）`);

// ---------------------------------------------------------------- 4. 复制应用源码

stepLog('复制应用源码');
const appDir = path.join(outDir, 'resources', 'app');
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
  copyDir(mascotSrc, path.join(outDir, '默认素材图片'));
  const mascotFiles = walk(path.join(outDir, '默认素材图片')).length;
  log(`默认吉祥物素材：${mascotFiles} 个文件（第一次启动自动导入）`);
} else {
  log('[!] 没找到 默认素材图片\\：这个包不会有内置吉祥物（用户得自己导入）');
}

// 空的数据目录（真实 data / 知识库 绝不复制——那是主播的配置和笔记）
fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
fs.mkdirSync(path.join(outDir, '知识库'), { recursive: true });

// electron.exe → 直播AI搭档.exe
const originalExe = path.join(outDir, 'electron.exe');
assert(fs.existsSync(originalExe), 'electron.exe 没复制过来？');
fs.renameSync(originalExe, path.join(outDir, exeName));
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
  3. 控制面板 →「弹幕设置」：填直播间房间号 → 点「开启弹幕监听」。
     再点「显示悬浮窗」，直播时把悬浮窗拖到画面边上就行。

三、你的数据在哪（重要）
  全都在**本文件夹内**，拷走整个文件夹 = 带走全部配置和笔记：
    data\\settings.json     配置（含 API Key / Cookie，**别把这个文件夹发给别人**）
    data\\观众记忆\\        本场记录 + 老观众名册
    知识库\\                你的知识条目（一个条目一个 .md，能直接用记事本改）
    data\\boot.log          排查问题的日志（超过 5MB 会自动轮转）
  另外弹幕记录默认写在：我的文档\\直播AI搭档\\弹幕记录\\

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

六、怎么更新到新版本
  拿新版本里的 ${exeName}、resources\\、locales\\ 覆盖进来，
  **保留你自己的 data\\ 和 知识库\\**，配置和笔记都不会丢。

七、安全提醒
  API Key 目前以明文保存在 data\\settings.json（只在本机使用）。
  不要把 data 文件夹、截图里的 Key、或者整个软件文件夹随便发给别人。
`;
writeText(path.join(outDir, '使用说明.txt'), guide);

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
for (const file of walk(outDir)) {
  if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    continue;
  }
  for (const secret of secrets) {
    if (text.includes(secret.value)) leaks.push(`${secret.label} → ${path.relative(outDir, file)}`);
  }
}
if (secrets.length === 0) log('真实配置里没有可扫描的密钥（或读不到），本次只做了空包检查');
if (leaks.length) fail(`产物里发现了主播的私人密钥，绝不能再分享：\n  ${leaks.join('\n  ')}`);
log(`扫描了 ${walk(outDir).length} 个文件，没有发现真实 Key / Cookie`);

// ---------------------------------------------------------------- 7. 冒烟验证

if (skipSmoke) {
  log('\n[!] 已跳过产物冒烟验证（--no-smoke）——不推荐：等于没验证过这个包能起来');
} else {
  stepLog('冒烟验证（真跑一遍产物自己的 --smoke-test）');
  const exePath = path.join(outDir, exeName);
  const result = spawnSync(exePath, ['--smoke-test'], {
    cwd: outDir,
    stdio: 'inherit',
    timeout: 120000,
    windowsHide: true
  });
  assert(result.status === 0, `产物冒烟测试没过（退出码 ${result.status}）。看 ${path.join(outDir, 'data', 'smoke-test.log')}`);
  const smokeLog = path.join(outDir, 'data', 'smoke-test.log');
  assert(fs.existsSync(smokeLog), '冒烟测试跑完却没有 smoke-test.log？');
  const smokeText = fs.readFileSync(smokeLog, 'utf8');
  assert(!smokeText.includes('[FAIL]'), `冒烟测试里有失败项：\n${smokeText.slice(-800)}`);
  log('产物能正常启动（--smoke-test 通过）');

  // 冒烟在 data 里留下了日志/配置，清干净再发出去（仍然保留空的 data、知识库 目录）
  const cleanDir = (dir) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  };
  cleanDir(path.join(outDir, 'data'));
  cleanDir(path.join(outDir, '知识库'));

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

// ---------------------------------------------------------------- 8. 汇总

stepLog('打包完成');
const total = dirSize(outDir);
const files = walk(outDir).length;
const exeFile = path.join(outDir, exeName);
const seconds = Math.round((Date.now() - startedAt) / 1000);
log(`产物：${outDir}`);
log(`大小：${mb(total)}（${files} 个文件，压缩前）`);
if (fs.existsSync(exeFile)) {
  log(`主程序：${exeName}（${mb(fs.statSync(exeFile).size)}）`);
  log(`SHA-256：${sha256(exeFile)}`);
}
log(`耗时：${seconds} 秒`);
log('');
log('分享前自查：');
log(`  · 产物在项目外面（${outRoot}），不会混进源码目录；整文件夹发出去 / 拷 U 盘都可以。`);
log('  · data 和 知识库 现在是空的，不会带出你的东西。');
log('  · 对方解压/放好后双击 exe；第一次会提示没有 API Key，填上就能用。');
log('  · 以后更新只覆盖 exe + resources + locales，**保留对方的 data 和 知识库**。');
