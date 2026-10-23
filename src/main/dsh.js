'use strict';

/**
 * ⚠️⚠️ **已下线（2026-10-19），本模块保留、不再接新活** ⚠️⚠️
 *
 * 状态：DSH 研究引擎（`knowledge.engine = 'dsh'`）已经停用。面板上那张「让 DSH 整理」卡
 * 被 `hidden` 藏了起来，`runResearchQuery` 里的 engine 也被钉成 `'builtin'`，
 * 所以 **DshRunner / DshSessionRunner 不会再被调用**（构造函数是懒的，不花钱）。
 *
 * 为什么下线（主播拍的板）：
 *   · 使用率太低 —— 他自己的配置里 `engine` 一直是 `builtin`，`dshSessionId` 只建过一次；
 *   · 它的主要用途「联网查资料」已经被自研搜索接口顶掉了（实测 3 秒 / 0.010 元 vs 它几十秒）；
 *   · 还要用户先装 Node + DSH，分享版门槛高。
 *
 * ⚠️ **但有两个东西仍然在被别处使用，不要跟着删**：
 *   1. `parseDrafts()` —— 查资料那条链路（自研搜索 / 模型联网）全靠它把模型输出拆成待审草稿；
 *   2. `buildTaskPrompt()` —— 那两句任务 + 输出格式要求，同样是查资料在拼（`main.js` 里用）。
 *   这两个函数放在本文件是因为历史原因（当初是给 DSH 写的），**跟 DSH 是否下线无关**。
 *   真要清理 DSH，先把它们搬去独立模块（比如 `drafts.js`）再动这里 —— 否则「去查」直接崩。
 *
 * 想恢复 DSH：见交接文档 §6.16（去掉面板 hidden + 改回 engine 赋值 + 去掉 audit 的离线断言）。
 *
 * ---------- 以下是原说明（仍然准确，恢复时照它来）----------
 *
 * DSH（DeepSeek Harness）对接：把「读文件 / 联网 / 整理资料」这类慢活交给本机的 DSH 去干。
 *
 * ## 这个模块的设计前提（都是实测出来的，别凭想象改）
 *
 * 1. **软件本身不带 DSH，也不带 Node**。想用这个功能的人，机器上得先有：
 *    · 一个能用的 **系统 Node**（`node -v` 能跑）
 *    · **@deepseek-ai/dsh** 这个包（全局装、npx 缓存里留着的、或者项目里装的都行）
 *    所以本模块的第一件事是 `detect()`：**逐项检测、逐项告诉用户缺什么、怎么补**。
 *    检测不过就不允许跑任务（`runTask()` 自己也会再拦一道，不只靠界面禁用按钮）。
 *
 * 2. **必须用系统 Node，不能用 Electron 自带的那个**。
 *    实测（Windows / Electron 33 / 内置 Node v20）：
 *    `ELECTRON_RUN_AS_NODE=1 electron.exe <dsh>/lib/bin.js --version` **静默失败**
 *    ——没有任何输出、也没有错误，排查不了。而系统 Node v24 跑同一个命令正常返回版本号。
 *    所以这里老老实实用系统 Node；好处是用户自己 `node -v` 就能复现我们的报错。
 *
 * 3. **不用 shell**。args 以数组形式直接交给 `spawn`（`shell: false`），
 *    所以任务文本里带引号、`&`、`|` 都不会变成命令注入——这是刻意的。
 *    也因此这里**不去调 `dsh.cmd`**（Windows 上跑 .cmd 必须经过 cmd.exe，那就得面对引号地狱）。
 *
 * 4. **任务是"一次性"的**：`dsh --profile headless "任务"` → 跑完打印结果 → 退出。
 *    实测最简任务约 51 秒，所以默认超时给 5 分钟，并且只当后台慢活，绝不进直播链路。
 *
 * 5. **输出只当"草稿"**：DSH 说什么我们都只写进「待审」，
 *    主播点通过才进知识库。它有能力直接改文件，但我们不把知识库目录交给它写。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
// 会话模式走 ACP（官方给外部程序用的协议，能 list / resume / close 已有会话）：
// 它必须「只会 create」的 SDK stdio 路线区分开，实现单独放在 dsh-acp.js
const { DshSessionRunner } = require('./dsh-acp');

/** 默认超时：实测最简任务 ~51 秒，整理任务会更久 */
const DEFAULT_TIMEOUT_MS = 300000;
/** 输出上限：headless 会把思考过程写进 stderr，不设限能把内存吃光 */
const MAX_OUTPUT_BYTES = 1024 * 1024;
/** 包内可执行入口（相对包目录） */
const BIN_RELATIVE = path.join('lib', 'bin.js');
const PACKAGE_NAME = path.join('@deepseek-ai', 'dsh');

/** 把命令路径规整：既接受 bin.js，也接受包目录、以及 .cmd/.exe 这类可执行文件 */
function normalizeDshPath(given) {
  const text = String(given || '').trim().replace(/^"|"$/g, '');
  if (!text) return '';
  // 直接给了 bin.js
  if (/bin\.js$/i.test(text)) return text;
  // 给了包目录（里面有 package.json 和 lib/bin.js）
  const asPackage = path.join(text, BIN_RELATIVE);
  if (fs.existsSync(asPackage)) return asPackage;
  // 给了 node_modules 目录
  const asModules = path.join(text, PACKAGE_NAME, BIN_RELATIVE);
  if (fs.existsSync(asModules)) return asModules;
  // 其它情况原样返回（可能是 .cmd/.exe，下面的探测会告诉我们能不能跑）
  return text;
}

/**
 * 列出「去哪找 dsh」的候选位置，按优先级从高到低。
 * 每一轮探测都会重新算一遍——用户很可能在我们开着的时候才去装 DSH。
 */
function candidateDshPaths({ explicit, env = process.env, appPath = '' } = {}) {
  const out = [];
  const push = (source, value) => {
    const binPath = normalizeDshPath(value);
    if (binPath && !out.some((item) => item.binPath === binPath)) out.push({ source, binPath });
  };

  push('你指定的路径', explicit);

  // 全局 npm 安装（Windows 在 %APPDATA%\npm\node_modules，类 Unix 在 /usr/local/lib/node_modules 等）
  const globalRoots = [];
  if (env.APPDATA) globalRoots.push(path.join(env.APPDATA, 'npm', 'node_modules'));
  if (env.npm_config_prefix) globalRoots.push(path.join(env.npm_config_prefix, 'lib', 'node_modules'));
  globalRoots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');
  for (const root of globalRoots) push('全局 npm 安装', path.join(root, PACKAGE_NAME));

  // npx 缓存：`npx @deepseek-ai/dsh` 跑过就会在这里留一份（目录名是哈希）
  const npxRoots = [];
  if (env.LOCALAPPDATA) npxRoots.push(path.join(env.LOCALAPPDATA, 'npm-cache', '_npx'));
  if (env.HOME) npxRoots.push(path.join(env.HOME, '.npm', '_npx'));
  for (const root of npxRoots) {
    for (const dir of listDirs(root)) {
      push('npx 缓存', path.join(root, dir, 'node_modules', PACKAGE_NAME));
    }
  }

  // 跟着软件一起装的（如果以后决定随包分发）
  if (appPath) push('软件目录', path.join(appPath, 'node_modules', PACKAGE_NAME));
  return out;
}

/** 读一个目录下的子目录名（读不到就返回空数组） */
function listDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (_) {
    return [];
  }
}

/** `node -v` 的输出形如 `v24.21.0` */
function parseNodeVersion(text) {
  const match = String(text || '').match(/v?(\d+)\.(\d+)\.(\d+)/);
  return match ? { text: match[0].startsWith('v') ? match[0] : `v${match[0]}`, major: Number(match[1]) } : null;
}

/** dsh --version 的输出就是一行版本号 */
function parseDshVersion(text) {
  const match = String(text || '').match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
  return match ? match[0] : '';
}

/**
 * 附加给 DSH 的输出格式要求。
 *
 * 为什么要硬性规定格式：DSH 是个 agent，它会聊天式地回答「我整理好了，共 3 条……」，
 * 而我们要的是**能自动变成知识条目的结构化文本**。让它在最后按固定标记输出，
 * 我们就能解析成待审草稿，主播只用点「通过」。
 *
 * 标记故意写得不像 markdown（`===知识条目===`），免得和正文里的分隔线混在一起。
 */
const OUTPUT_FORMAT_HINT = [
  '',
  '【输出格式要求（很重要）】',
  '做完之后，把你整理好的知识按下面的格式输出。**不要用代码块包起来**，每条之间空一行：',
  '',
  '===知识条目===',
  '标题：<一句话标题>',
  '标签：<逗号分隔，可以留空>',
  '正文：<这条知识的内容，2~5 句，写清楚就够>',
  '',
  '可以输出多条（每条的标记和字段都一样）。除了这些条目以外，**不要输出别的解释或总结**。'
].join('\n');

/** 把用户写的任务 + 格式要求拼成真正发给 DSH 的任务文本 */
function buildTaskPrompt(task) {
  return `${String(task || '').trim()}\n${OUTPUT_FORMAT_HINT}`;
}

/**
 * 把模型/DSH 的输出解析成知识草稿。
 * 解析很宽容：格式对就拆成多条；一条都拆不出来时，**整段当成一条草稿**，
 * 绝不把跑了几分钟的结果丢掉（宁可让主播自己删）。
 *
 * ⚠️ 为什么分隔行和字段名要认那么多写法：**实测**（2026-10-18，走自研搜索那条路）
 * 模型照样会把 `===知识条目===` 写成 `# 知识条目`、把 `标题：` 写成 `**标题：**`。
 * 旧实现只认严格写法，于是整段输出被兜底成「一条草稿」，标题还是「知识条目」四个字——
 * 单元测试用的是手写的规范输出，所以一直是绿的。这里的宽容度就是为了让真模型的输出也能落成条目。
 */
function parseDrafts(output, { source = 'DSH 整理', engine = 'dsh' } = {}) {
  const text = String(output || '').replace(/\r\n/g, '\n');
  // 分隔行：`===知识条目===` / `# 知识条目` / `【知识条目】` 都认
  const blocks = text.split(/^\s*(?:={2,}\s*知识条目\s*={2,}|#{1,6}\s*知识条目|【\s*知识条目\s*】)\s*$/m).slice(1);
  const drafts = [];
  // 字段名前后可能挂着 markdown 装修（`#`、`**`、`-`、`>`），冒号后也可能跟一个 `**`
  const DECOR = '[\\s#>*\\-]*';
  const field = (block, name) => {
    const match = block.match(
      new RegExp(`^${DECOR}${name}${DECOR}[：:]${DECOR}([\\s\\S]*?)(?=\\n${DECOR}(?:标题|标签|正文)${DECOR}[：:]|$)`, 'm')
    );
    return match ? match[1].replace(/^\*+|\*+$/g, '').trim() : '';
  };
  for (const block of blocks) {
    const title = field(block, '标题');
    const content = field(block, '正文');
    const tags = field(block, '标签');
    if (!title && !content) continue;
    drafts.push({
      title: title || content.slice(0, 20),
      content: content || title,
      tags,
      source,
      engine
    });
  }
  if (drafts.length) return drafts;

  // 兜底：没按格式输出，就把整段当一条草稿
  const trimmed = text.trim();
  if (!trimmed) return [];
  const firstLine = trimmed.split('\n').find((line) => line.trim()) || 'DSH 整理结果';
  return [
    {
      title: firstLine.replace(/^#+\s*/, '').slice(0, 40),
      content: trimmed,
      tags: '',
      source: `${source}（未按格式输出，整段收下）`,
      engine
    }
  ];
}



class DshRunner {
  /**
   * @param {object} options
   *   getConfig()   返回 `{ nodePath, dshCommand, timeoutSec }`（跟着设置走，改完立刻生效）
   *   logger
   *   spawnImpl     可注入（测试用假 spawn；沙箱里不允许真的创建子进程）
   *   env/appPath   探测用
   */
  constructor({ getConfig, logger, spawnImpl, env = process.env, appPath = '' } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : () => ({});
    this.logger = logger || console;
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    this.env = env;
    this.appPath = appPath;
    /** 正在跑的任务（用于中止） */
    this.child = null;
    this.lastDetect = null;
  }

  _config() {
    const raw = this.getConfig() || {};
    return {
      nodePath: String(raw.nodePath || '').trim(),
      dshCommand: String(raw.dshCommand || '').trim(),
      timeoutSec: Number(raw.timeoutSec) > 0 ? Number(raw.timeoutSec) : DEFAULT_TIMEOUT_MS / 1000,
      // 软件里配的 DeepSeek Key：检测时算「凭证有着落」，跑任务时注入子进程环境
      apiKey: String(raw.apiKey || '').trim()
    };
  }

  /**
   * 跑一个短命令，拿回 stdout/stderr/退出码。
   * 探测专用：任何失败都变成返回值，不抛异常（探测本来就要「失败也是一种结果」）。
   */
  _probe(command, args, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(command, args, { windowsHide: true, env: this.env });
      } catch (error) {
        resolve({ ok: false, code: null, stdout: '', stderr: String(error && error.message) });
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch (_) {
          /* ignore */
        }
        finish({ ok: false, code: null, stdout, stderr: `${stderr}\n(超时 ${timeoutMs}ms)`.trim() });
      }, timeoutMs);
      if (child.stdout) child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
      if (child.stderr) child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
      child.on('error', (error) =>
        finish({ ok: false, code: null, stdout, stderr: String((error && error.message) || error) })
      );
      child.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr }));
    });
  }

  /**
   * 环境检测：逐项检查，每项都给出「缺什么、怎么补」。
   * @param {{deep?:boolean}} options deep=true 时额外真跑一次最简任务（约 1 分钟）
   */
  async detect({ deep = false } = {}) {
    const config = this._config();
    const checks = [];

    // ① 系统 Node
    const nodeCommand = config.nodePath || 'node';
    const nodeProbe = await this._probe(nodeCommand, ['-v']);
    const nodeVersion = parseNodeVersion(nodeProbe.stdout) || parseNodeVersion(nodeProbe.stderr);
    if (nodeProbe.ok && nodeVersion) {
      checks.push({
        key: 'node',
        label: '系统 Node',
        ok: true,
        detail: `${nodeCommand} → ${nodeVersion.text}`
      });
    } else {
      checks.push({
        key: 'node',
        label: '系统 Node',
        ok: false,
        detail: nodeProbe.stderr ? String(nodeProbe.stderr).split('\n')[0].slice(0, 200) : '找不到 node 命令',
        hint: '去 nodejs.org 装 Node.js LTS，装完**重开软件**（PATH 才会生效）。装的时候别取消勾选「Add to PATH」。'
      });
    }

    // ② DSH 包
    const candidates = candidateDshPaths({
      explicit: config.dshCommand,
      env: this.env,
      appPath: this.appPath
    });
    let dsh = null;
    let dshError = '';
    if (!candidates.length) {
      dshError = '没找到 @deepseek-ai/dsh';
    } else if (nodeVersion) {
      for (const candidate of candidates) {
        if (!fs.existsSync(candidate.binPath)) {
          dshError = `路径不存在：${candidate.binPath}`;
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const probe = await this._probe(nodeCommand, [candidate.binPath, '--version'], 30000);
        const version = parseDshVersion(probe.stdout) || parseDshVersion(probe.stderr);
        if (probe.ok && version) {
          dsh = { binPath: candidate.binPath, version, source: candidate.source };
          break;
        }
        dshError = `${candidate.binPath} 跑不起来：${String(probe.stderr || probe.stdout).split('\n')[0].slice(0, 200)}`;
      }
    } else {
      dshError = '先装好 Node 才能验证 DSH';
    }
    if (dsh) {
      checks.push({
        key: 'dsh',
        label: 'DSH 包',
        ok: true,
        detail: `v${dsh.version}（${dsh.source}）`
      });
    } else {
      checks.push({
        key: 'dsh',
        label: 'DSH 包',
        ok: false,
        detail: dshError || '没找到',
        hint: '命令行执行一次：npm i -g @deepseek-ai/dsh（装完重开软件）。也可以用 npx 先跑一次留个缓存，或在上面的「自己指定路径」里填 lib/bin.js 的完整路径。'
      });
    }

    // ③ 凭证：我们把自己的 DeepSeek Key 传给 DSH 子进程，所以正常情况下这项一定过
    const ownKey = String(config.apiKey || '').trim();
    const envKey = String(this.env.DEEPSEEK_API_KEY || '').trim();
    const credentialsFile = path.join(this.env.DSH_HOME || path.join(os.homedir(), '.dsh'), '.credentials.yaml');
    let credentialsOk = false;
    let credentialsDetail = '';
    if (ownKey || envKey) {
      credentialsOk = true;
      credentialsDetail = ownKey ? '用软件里配的 DeepSeek Key' : '用系统环境变量 DEEPSEEK_API_KEY';
    } else if (fs.existsSync(credentialsFile)) {
      credentialsOk = true;
      credentialsDetail = `用 DSH 自己的凭证文件 ${credentialsFile}`;
    } else {
      credentialsDetail = '软件里没填 DeepSeek Key，DSH 也没有凭证文件';
    }
    checks.push({
      key: 'credentials',
      label: '调用凭证',
      ok: credentialsOk,
      detail: credentialsDetail,
      hint: credentialsOk ? '' : '到「DeepSeek API」页把 Key 填上（软件会自动传给 DSH，不用单独配）。'
    });

    // ④（可选）真跑一次：验证插件体系能起来
    if (deep && dsh && nodeVersion) {
      const probe = await this._probe(
        nodeCommand,
        [dsh.binPath, '--profile', 'headless', '只回复两个字：可以'],
        180000
      );
      const text = String(probe.stdout || '').trim();
      checks.push({
        key: 'run',
        label: '实跑一次',
        ok: probe.ok && Boolean(text),
        detail: probe.ok ? `返回：${text.slice(0, 60)}` : String(probe.stderr || '').split('\n')[0].slice(0, 200),
        hint: probe.ok ? '' : '这次的输出能帮上忙：多半是 DSH 首次启动要初始化配置、或者网络/凭证有问题，把上面那行原文搜一下。'
      });
    }

    const result = {
      ok: checks.filter((item) => item.key !== 'run').every((item) => item.ok),
      checks,
      node: nodeVersion ? { command: nodeCommand, version: nodeVersion.text } : null,
      dsh,
      checkedAt: new Date().toISOString()
    };
    this.lastDetect = result;
    this.logger.info?.(
      `DSH 环境检测：${result.ok ? '通过' : '未通过'}（${checks.map((c) => `${c.label}${c.ok ? '✓' : '✗'}`).join(' ')}）`
    );
    return result;
  }

  /** 现在能不能跑（界面据此决定按钮是否可点、主进程据此决定要不要拒绝） */
  async ready() {
    const result = await this.detect();
    return result;
  }

  /**
   * 跑一次整理任务。
   *
   * @param {{task:string, cwd?:string, timeoutMs?:number, onOutput?:Function}} options
   * @returns {Promise<{ok:boolean, output:string, stderr:string, code:number|null, ms:number, message?:string}>}
   */
  async runTask({ task, cwd, timeoutMs, onOutput } = {}) {
    const text = String(task || '').trim();
    if (!text) return { ok: false, output: '', stderr: '', code: null, ms: 0, message: '任务内容是空的' };
    if (this.child) return { ok: false, output: '', stderr: '', code: null, ms: 0, message: '已经有一个任务在跑了' };

    // 主进程自己再拦一道：不能只靠界面把按钮置灰
    const status = await this.detect();
    if (!status.ok) {
      const missing = status.checks.filter((item) => !item.ok).map((item) => item.label).join('、');
      return {
        ok: false,
        output: '',
        stderr: '',
        code: null,
        ms: 0,
        message: `环境没配好（缺：${missing}），先点「检测环境」看看怎么补`,
        detect: status
      };
    }

    const config = this._config();
    const nodeCommand = config.nodePath || 'node';
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : config.timeoutSec * 1000;
    const env = { ...this.env };
    // 把软件里的 Key 交给 DSH（DSH 的规则是「继承的环境变量优先」），
    // 这样用户不用再去 DSH 里配一遍凭证。⚠️ 只进子进程环境，绝不写日志、绝不落盘。
    if (String(config.apiKey || '').trim()) env.DEEPSEEK_API_KEY = String(config.apiKey).trim();

    const started = Date.now();
    return new Promise((resolve) => {
      let child;
      try {
        child = this.spawnImpl(nodeCommand, [status.dsh.binPath, '--profile', 'headless', text], {
          cwd: cwd || os.tmpdir(),
          env,
          windowsHide: true
        });
      } catch (error) {
        resolve({ ok: false, output: '', stderr: String(error.message), code: null, ms: 0, message: error.message });
        return;
      }
      this.child = child;
      let output = '';
      let stderr = '';
      let truncated = false;
      let done = false;
      const append = (target, chunk) => {
        const text2 = String(chunk);
        if (target.length + text2.length > MAX_OUTPUT_BYTES) {
          truncated = true;
          return target.slice(0, MAX_OUTPUT_BYTES);
        }
        return target + text2;
      };
      const finish = (payload) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.child = null;
        resolve({
          ...payload,
          output,
          stderr,
          ms: Date.now() - started,
          truncated,
          dshVersion: status.dsh ? status.dsh.version : ''
        });
      };
      const timer = setTimeout(() => {
        this.logger.warn?.(`DSH 任务超过 ${Math.round(limit / 1000)} 秒，正在中止`);
        try {
          child.kill();
        } catch (_) {
          /* ignore */
        }
        finish({
          ok: false,
          code: null,
          message: `超过 ${Math.round(limit / 1000)} 秒还没跑完，已中止（可以在设置里把超时调大）`
        });
      }, limit);

      if (child.stdout)
        child.stdout.on('data', (chunk) => {
          output = append(output, chunk);
          if (typeof onOutput === 'function') onOutput({ stream: 'stdout', text: String(chunk) });
        });
      if (child.stderr)
        child.stderr.on('data', (chunk) => {
          stderr = append(stderr, chunk);
          if (typeof onOutput === 'function') onOutput({ stream: 'stderr', text: String(chunk) });
        });
      child.on('error', (error) =>
        finish({ ok: false, code: null, message: `启动 DSH 失败：${(error && error.message) || error}` })
      );
      child.on('close', (code) => {
        const text2 = String(output || '').trim();
        if (code === 0 && text2) finish({ ok: true, code });
        else if (code === 0) finish({ ok: false, code, message: 'DSH 跑完了但没输出内容' });
        else
          finish({
            ok: false,
            code,
            message: `DSH 退出码 ${code}${stderr ? `：${String(stderr).trim().split('\n').slice(-1)[0].slice(0, 200)}` : ''}`
          });
      });
    });
  }

  /** 中止正在跑的任务（用户点「中止」、或软件要退出时用） */
  cancel() {
    if (!this.child) return false;
    try {
      this.child.kill();
    } catch (_) {
      return false;
    }
    return true;
  }
}

module.exports = {
  DshRunner,
  DshSessionRunner,
  candidateDshPaths,
  normalizeDshPath,
  parseNodeVersion,
  parseDshVersion,
  buildTaskPrompt,
  parseDrafts,
  OUTPUT_FORMAT_HINT,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_BYTES
};
