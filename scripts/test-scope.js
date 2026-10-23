'use strict';

/**
 * 「整个程序一起编译」验证脚本
 *
 * 复刻浏览器加载界面的真实方式：把 HTML 里引用的脚本按顺序拼成一段，整体编译。
 * 这样能抓到「两个脚本在同一全局作用域里声明同名变量」这类致命问题——
 * 它会让整个文件解析失败，表现是界面能打开但所有按钮都点不动。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pages = [
  { name: '控制面板', file: 'src/renderer/panel/index.html' },
  { name: '悬浮窗', file: 'src/renderer/overlay/index.html' }
];

let failed = 0;
let passed = 0;

function combinedSource(htmlFile) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  const baseDir = path.dirname(htmlFile);
  const scripts = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
  const parts = [];
  for (const asset of scripts) {
    const target = path.join(root, baseDir, asset);
    if (!fs.existsSync(target)) throw new Error(`引用的脚本不存在: ${asset}`);
    parts.push(`// ==== ${asset} ====\n${fs.readFileSync(target, 'utf8')}`);
  }
  return { combined: parts.join('\n'), scripts };
}

console.log('===== 界面脚本共存检查（等价于浏览器整页解析）=====\n');

/** 找出所有顶层声明（行首无缩进的 const/let/var/class/function） */
function topLevelDeclarations(code) {
  const names = [];
  for (const line of code.split('\n')) {
    const match = line.match(/^(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/);
    if (match) names.push(match[1]);
  }
  return names;
}

for (const page of pages) {
  const { combined, scripts } = combinedSource(page.file);

  // 1) 正常情况下应能编译
  let compiles = true;
  try {
    // eslint-disable-next-line no-new-func
    new Function(combined);
    passed += 1;
    console.log(`✓ ${page.name}：${scripts.length} 个脚本可共存`);
  } catch (error) {
    compiles = false;
    failed += 1;
    console.log(`✗ ${page.name}：脚本无法共存 → ${error.message}`);
  }

  // 2) 逐个列出顶层声明，重复的必须报错（可变声明重名会直接让整个文件解析失败）
  const seen = new Map();
  const duplicates = [];
  for (let index = 0; index < scripts.length; index += 1) {
    const code = fs.readFileSync(path.join(root, path.dirname(page.file), scripts[index]), 'utf8');
    for (const name of topLevelDeclarations(code)) {
      if (seen.has(name)) duplicates.push(`「${name}」在 ${seen.get(name)} 与 ${scripts[index]} 中都声明了`);
      else seen.set(name, scripts[index]);
    }
  }
  if (duplicates.length) {
    failed += 1;
    for (const item of duplicates) console.log(`✗ ${page.name}：顶层重名 → ${item}`);
  } else if (compiles) {
    passed += 1;
    console.log(`✓ ${page.name}：${seen.size} 个顶层声明无重名`);
  }

  // 3) 守护有效性自检：动态取一个真实存在的顶层名字注入重复声明，必须被抓到
  const firstDecl = topLevelDeclarations(combined)[0];
  if (!firstDecl) {
    failed += 1;
    console.log(`✗ ${page.name}：取不到顶层声明，无法验证守护是否有效`);
  } else {
    try {
      // eslint-disable-next-line no-new-func
      new Function(`var ${firstDecl} = 1;\n${combined}`);
      failed += 1;
      console.log(`✗ ${page.name}：守护无效（注入重复的 ${firstDecl} 后仍能编译）`);
    } catch (error) {
      if (/already been declared|redeclaration/i.test(error.message)) {
        passed += 1;
        console.log(`✓ ${page.name}：守护有效（重复声明 ${firstDecl} 会被抓到）`);
      } else {
        failed += 1;
        console.log(`✗ ${page.name}：守护报错信息异常 → ${error.message}`);
      }
    }
  }
}

console.log('');
if (failed) {
  console.log(`===== 结果：通过 ${passed} 项，失败 ${failed} 项 =====`);
  process.exit(1);
}
console.log(`===== 结果：通过 ${passed} 项，失败 0 项 =====`);
