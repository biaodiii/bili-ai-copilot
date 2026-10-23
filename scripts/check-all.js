'use strict';

/**
 * 一键跑完全部自检并给出汇总
 *   node scripts/check-all.js
 *
 * 覆盖后端全链路：弹幕协议、AI 调用、界面脚本、主进程、IPC 契约。
 * 不联网、不需要 API Key、不消耗额度。
 *
 * 说明：默认用子进程跑每个测试（互不干扰）；某些受限环境禁止创建子进程
 * （spawn EPERM），这时会自动退回「同一个进程里顺序执行」。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');

const SUITES = [
  { file: 'test.js', label: '纯逻辑（解析/过滤/提示词/签名/表情/配置清洗）' },
  { file: 'test-danmaku.js', label: '弹幕链路回归（真实抓包报文）' },
  { file: 'test-danmaku-log.js', label: '弹幕记录器（落盘 / 归档 / 失败不影响收弹幕）' },
  { file: 'test-ui.js', label: '界面脚本（轻量 DOM 真跑两个界面）' },
  { file: 'test-llm.js', label: 'DeepSeek 调用链路（本地假接口）' },
  { file: 'test-tts.js', label: '云端语音合成（本地假接口：缓存 / 降级 / 报错）' },
  { file: 'test-knowledge.js', label: '知识库（md 存储 / 检索质量 / 注入上限）' },
  { file: 'test-dsh.js', label: 'DSH 对接（环境检测 / 跑任务 / 待审，假 spawn）' },
  { file: 'test-dsh-acp.js', label: 'DSH 会话模式（ACP：新建 / 续用 / 取消 / 权限，假 spawn）' },
  { file: 'test-dsh-store.js', label: 'DSH 会话库（工作区登记 / 会话清理，临时目录）' },
  { file: 'test-research.js', label: '「模型想查/想记」待办队列 + 内置联网查询（假接口）' },
  { file: 'test-review.js', label: '知识库整理/校对（提示词 / 建议解析 / 选目标 / 应用前校验）' },
  { file: 'test-proactive.js', label: '主动搭话（提示词 / 解析 / 选方式 / 限频判断）' },
  { file: 'test-viewer-memory.js', label: '观众记忆（本场文档 / 名册 / 摘要 / 清洗与上限）' },
  { file: 'test-pipeline.js', label: '完整链路集成（报文 → 回复事件 + 通用性）' },
  { file: 'test-features.js', label: '用量统计 / 安全暂停 / 主动搭话 / 导出', needsIsolation: true },
  {
    file: 'test-electron-main.js',
    label: '主进程运行时（假 electron 真跑 main.js）',
    needsIsolation: true
  },
  {
    file: 'test-bili-login.js',
    label: '账号登录模块（扫码抓 Cookie 全流程）',
    needsIsolation: true
  },
  {
    file: 'test-ipc-contract.js',
    label: 'IPC 契约（preload 与主进程双向对齐）',
    needsIsolation: true
  },
  { file: 'test-scope.js', label: '界面脚本共存（等价浏览器整页解析，防全局重名）' },
  { file: 'verify-scope-guard.js', label: '重名守护有效性（自检：该抓的能抓到、不误报）' },
  { file: 'audit.js', label: '静态一致性审计（DOM id / 通道 / 配置 / 语法）' }
];

function parseResult(output, status) {
  const summary = output.match(/结果：通过 (\d+) 项，失败 (\d+) 项/);
  const auditSummary = output.match(/结果：(\d+) 项通过，(\d+) 项问题/);
  let passed = 0;
  let failed = 0;
  if (summary) {
    passed = Number(summary[1]);
    failed = Number(summary[2]);
  } else if (auditSummary) {
    passed = Number(auditSummary[1]);
    failed = Number(auditSummary[2]);
  } else {
    failed = 1;
  }
  if (status !== 0 && failed === 0) failed = 1;
  const failures = [...output.matchAll(/✗ (.+)\n\s+(.+)/g)].map((match) => ({
    name: match[1].trim(),
    detail: match[2].trim()
  }));
  return { passed, failed, failures, output };
}

/** 用子进程跑一个测试；返回 null 表示该环境不允许创建子进程 */
function runInChildProcess(suite) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite.file)], {
    encoding: 'utf8',
    cwd: root,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error && result.error.code === 'EPERM') return null;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return parseResult(output, result.status === null ? 1 : result.status);
}

/** 受限环境下的退路：在同一个进程里按顺序执行测试脚本，并接管它们的 process.exit */
async function runInProcess(suite) {
  const target = path.join(__dirname, suite.file);
  let output = '';
  const originalLog = console.log;
  const originalError = console.error;
  const capture = (...args) => {
    output += `${args.map((item) => (typeof item === 'string' ? item : String(item))).join(' ')}\n`;
  };

  let exitCode = 0;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = Number(code) || 0;
    // 不真的退出，交回给调用方继续跑下一个测试
    throw new ExitSignal();
  };
  // 测试脚本内部是异步的，它调用 process.exit 时可能落在 Promise 链里，
  // 这里把由此产生的「未处理拒绝」吃掉，避免只有 ExitSignal 时中断整个自检。
  const swallow = (reason) => {
    if (reason instanceof ExitSignal) return;
    throw reason;
  };
  process.on('unhandledRejection', swallow);

  delete require.cache[require.resolve(target)];
  console.log = capture;
  console.error = capture;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    require(target);
    // 测试脚本内部是异步的，等它自己调用 process.exit（被我们接管）
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (exitCode !== 0 || output.includes('结果：') || output.includes('===== 结果')) {
          clearInterval(timer);
          resolve();
        }
      }, 30);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 60000);
    });
  } catch (error) {
    if (!(error instanceof ExitSignal)) {
      output += `\n脚本异常: ${error && error.message}\n`;
      exitCode = 1;
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exit = originalExit;
    process.removeListener('unhandledRejection', swallow);
  }
  return parseResult(output, exitCode);
}

class ExitSignal extends Error {}

(async () => {
  console.log('===== 直播 AI 搭档 · 全量自检 =====\n');

  // 先探测能不能建子进程
  const probe = spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' });
  const canSpawn = !(probe.error && probe.error.code === 'EPERM');
  if (!canSpawn) {
    console.log('（当前环境禁止创建子进程，改为在同一进程内顺序执行）\n');
  }

  const results = [];
  const skipped = [];
  for (const suite of SUITES) {
    if (!canSpawn && suite.needsIsolation) {
      // 这些测试会替换 electron 模块，必须独占进程；同进程跑会互相污染
      skipped.push(suite);
      console.log(`跳过 ${suite.file}（需要独立进程）`);
      continue;
    }
    process.stdout.write(`运行 ${suite.file} … `);
    let result = canSpawn ? runInChildProcess(suite) : null;
    if (!result) {
      // eslint-disable-next-line no-await-in-loop
      result = await runInProcess(suite);
    }
    results.push({ suite, ...result });
    console.log(result.failed ? `✗ ${result.failed} 项失败` : `✓ ${result.passed} 项通过`);
  }

  const totalPassed = results.reduce((sum, item) => sum + item.passed, 0);
  const totalFailed = results.reduce((sum, item) => sum + item.failed, 0);

  console.log('\n----- 汇总 -----');
  for (const result of results) {
    const mark = result.failed ? '✗' : '✓';
    console.log(`${mark} ${String(result.passed).padStart(3)} 项  ${result.suite.file.padEnd(24)} ${result.suite.label}`);
  }
  for (const suite of skipped) {
    console.log(`-   ——   ${suite.file.padEnd(24)} ${suite.label}`);
  }

  if (skipped.length) {
    console.log('\n当前环境禁止创建子进程，以下测试需要独立进程，请逐个手动执行：');
    for (const suite of skipped) console.log(`  node scripts\\${suite.file}`);
  }

  const failedSuites = results.filter((item) => item.failed);
  if (failedSuites.length) {
    console.log('\n----- 失败详情 -----');
    for (const result of failedSuites) {
      console.log(`\n[${result.suite.file}]`);
      for (const failure of result.failures) {
        console.log(`  ✗ ${failure.name}`);
        console.log(`      ${failure.detail}`);
      }
      if (!result.failures.length) {
        console.log(result.output.split('\n').slice(-12).join('\n'));
      }
    }
  }

  console.log(`\n===== 结果：通过 ${totalPassed} 项，失败 ${totalFailed} 项 =====`);
  if (totalFailed) {
    console.log('提示：把上面的「失败详情」整段发给我即可定位问题。');
    process.exitCode = 1;
    return;
  }
  console.log('全部通过，可以放心启动程序。');

  // ⚠️ 只有「同进程退路」这一条路需要显式退出。
  //
  // 为什么：正常环境里每个套件是**独立子进程**，套件自己 `process.exit()`，check-all 跟着就结束；
  // 而退路模式把套件的 `process.exit` 接管了（不能真退，否则后面套件跑不了），
  // 于是套件里留下的定时器 / 假接口 server 句柄会把事件循环撑着 —— 汇总打印完了却**永远不退出**
  // （沙箱里真踩过：日志写完了，命令却一直挂着，还被误当成「失败」）。
  if (!canSpawn) {
    process.exit(0);
  }
})();
