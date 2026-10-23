'use strict';

/**
 * 守护有效性验证：证明 test-scope.js / audit.js 用的「脚本拼接后整体编译」
 * 手法确实能抓到「同一全局作用域里两个 const 同名」这个真实 bug。
 *
 * 这个 bug 的真实形态：src/shared/emotions.js 曾用 `const api = {...}` 往外导出，
 * 而 panel.js / overlay.js 里都有 `const api = window.api`。浏览器报
 *   Uncaught SyntaxError: Identifier 'api' has already been declared (emotions.js:1)
 * 结果整个文件解析失败、界面所有按钮点不动。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let failed = 0;
let passed = 0;

function check(label, code, shouldFail) {
  try {
    // 与审计脚本完全相同的检查手法
    // eslint-disable-next-line no-new-func
    new Function(code);
    if (shouldFail) {
      console.log(`✗ ${label}：应该报错但没报 → 守护无效`);
      failed += 1;
    } else {
      passed += 1;
      console.log(`✓ ${label}：正常通过`);
    }
  } catch (error) {
    if (shouldFail) {
      passed += 1;
      console.log(`✓ ${label}：被正确抓到 → ${error.message}`);
    } else {
      console.log(`✗ ${label}：不该报错却报错 → ${error.message}`);
      failed += 1;
    }
  }
}

// 修复前的共享脚本（用 const api 导出）
const sharedBroken = [
  "'use strict';",
  'const EMOTION_LIST = [];',
  'const api = { EMOTION_LIST, shortName() {} };',
  'window.SharedLogic = api;'
].join('\n');

// 界面脚本的真实开头
const pageScript = ['const api = window.api;', 'const shared = window.SharedLogic;'].join('\n');

// 修复后的共享脚本（IIFE + 只暴露 SharedLogic）
const sharedFixed = fs.readFileSync(path.join(root, 'src/shared/emotions.js'), 'utf8');

console.log('===== 全局重名守护的有效性验证 =====\n');
check('修复前的形态（共享脚本 const api + 页面脚本 const api）', `${sharedBroken}\n${pageScript}`, true);
check('修复后的形态（IIFE 只暴露 SharedLogic）', `${sharedFixed}\n${pageScript}`, false);
check('对照：两个 const 同名', 'const dup = 1;\nconst dup = 2;', true);
check('对照：const 与 function 同名（也是冲突）', 'const dup2 = 1;\nfunction dup2() {}', true);
check('对照：不同名（不该报错）', 'const a1 = 1;\nfunction b1() {}', false);

console.log('');
if (failed) {
  console.log(`===== 结果：通过 ${passed} 项，失败 ${failed} 项 =====`);
  process.exit(1);
}
console.log(`===== 结果：通过 ${passed} 项，失败 0 项 =====`);
