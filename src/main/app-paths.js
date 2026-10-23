'use strict';

/**
 * 程序根目录（放 `data/` 和 `知识库/` 的那一层）—— 打包发布的关键一块（2026-10-21）。
 *
 *   · 开发时（`npm start` / `electron .`）：项目根，和以前一样；
 *   · 打包后（`直播AI搭档.exe` 双击）：**exe 所在目录**。
 *     为什么不让它落进 `resources/app`：那里是安装包内部，用户翻不到；
 *     而且装到 `Program Files` 时根本不可写（只能退回 %APPDATA%，配置就"消失"了）。
 *     放 exe 旁边 → 便携：拷走整个文件夹就带走全部配置和笔记，正是分享版要的样子。
 *   · `DSH_APP_ROOT` 环境变量可以强制指定（测试用，也方便把数据放移动硬盘）。
 *
 * ⚠️ 这个模块**故意不缓存**结果：每次调用都按当前环境算。
 *    否则测试里改了环境变量/换了 exe 路径，模块缓存会给出上一条结论（踩过类似的坑）。
 */

const path = require('path');

/** 拿到 electron 的 app 对象（非 Electron 环境，比如纯 node 单测，返回 null） */
function electronApp() {
  try {
    // eslint-disable-next-line global-require
    const electron = require('electron');
    return electron && electron.app ? electron.app : null;
  } catch (_) {
    return null;
  }
}

/** 是不是打包版（开发时跑的是 node_modules 里的 electron.exe） */
function isPackaged() {
  const app = electronApp();
  if (!app || typeof app.isPackaged !== 'boolean') return false;
  return app.isPackaged;
}

/** 程序根目录（绝对路径） */
function appRoot() {
  const override = String(process.env.DSH_APP_ROOT || '').trim();
  if (override) return path.resolve(override);
  if (isPackaged()) return path.dirname(process.execPath);
  return path.join(__dirname, '..', '..');
}

module.exports = { appRoot, isPackaged };
