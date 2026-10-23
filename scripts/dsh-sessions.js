'use strict';

/**
 * DSH 会话库管理（给人和给排错用）
 *   node scripts/dsh-sessions.js list                     列出所有会话（id / 项目 / 大小 / 时间）
 *   node scripts/dsh-sessions.js delete <id> [<id>…]      删掉会话（日志 + 工作区登记引用 + 投影缓存）
 *   node scripts/dsh-sessions.js attach <id> [--cwd DIR]  把会话登记进某个目录对应的工作区
 *                                                         （不登记的话 DSH Web 里会显示在「未分组」）
 *   node scripts/dsh-sessions.js archive <id> [<id>…]     归档会话（Web 侧边栏里不再显示）
 *   node scripts/dsh-sessions.js unarchive <id> [<id>…]   取消归档 + 登记进知识库工作区
 *
 * 会话库位置：`$DSH_HOME`（默认 `~/.dsh`）下的 `sessions/`。
 * 这个脚本**直接用系统 Node 跑**（软件本体不需要它）。
 *
 * `attach` 还会**取消归档**：被归档的会话在 DSH Web 里哪儿都不显示
 * （`sessionVisible()`：`!archived.has(session.id)`），于是工作区分组在、里面却是空的。
 * 顺手也会清掉「会话已经删了、归档名单里还留着」的僵尸项。
 */

const path = require('path');
const { resolveDshHome, listSessions, deleteSession, attachSessionToWorkspace, archiveSession, sessionsRoot } = require('../src/main/dsh-store');
const { defaultKnowledgeDir } = require('../src/main/knowledge');

const args = process.argv.slice(2);
const command = args[0] || 'list';
const home = resolveDshHome(process.env);

function human(bytes) {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

if (command === 'list') {
  const rows = listSessions({ home });
  console.log(`会话库：${sessionsRoot(home)}（共 ${rows.length} 个）\n`);
  for (const row of rows) {
    console.log(`${row.id}`);
    console.log(`   ${row.project}  ${human(row.bytes)}  ${row.updatedAt}`);
  }
} else if (command === 'delete') {
  const ids = args.slice(1).filter((item) => !item.startsWith('--'));
  if (!ids.length) {
    console.error('用法：node scripts/dsh-sessions.js delete <会话 id> [<会话 id>…]');
    process.exit(1);
  }
  for (const id of ids) {
    const result = deleteSession({ home, sessionId: id });
    if (result.ok) {
      console.log(`✓ 已删除 ${id}`);
      for (const item of result.removed) console.log(`    ${item}`);
    } else {
      console.log(`✗ ${id}：${result.reason}`);
    }
  }
} else if (command === 'attach') {
  const ids = args.slice(1).filter((item) => !item.startsWith('--'));
  const cwdFlag = args.indexOf('--cwd');
  const cwd = cwdFlag >= 0 && args[cwdFlag + 1] ? path.resolve(args[cwdFlag + 1]) : defaultKnowledgeDir(path.join(__dirname, '..'));
  if (!ids.length) {
    console.error('用法：node scripts/dsh-sessions.js attach <会话 id> [--cwd 目录]');
    process.exit(1);
  }
  for (const id of ids) {
    const result = attachSessionToWorkspace({ sessionId: id, cwd, title: path.basename(cwd) });
    if (result.ok) {
      const what = result.created ? '新建了工作区记录' : result.changed ? '已登记' : '本来就在名单里';
      const extra = [
        result.unarchived ? '顺手取消了归档' : '',
        result.pruned && result.pruned.length ? `清掉 ${result.pruned.length} 个僵尸归档项` : ''
      ]
        .filter(Boolean)
        .join('，');
      console.log(`✓ ${id} → 工作区 ${path.basename(cwd)}（${what}${extra ? `，${extra}` : ''}）`);
      if (result.changed || result.unarchived) {
        console.log('    提示：正在开着的 DSH Web 要重启一次才会看到（它只在启动时读工作区表）');
      }
    } else {
      console.log(`✗ ${id}：${result.reason}`);
    }
  }
} else if (command === 'archive' || command === 'unarchive') {
  const ids = args.slice(1).filter((item) => !item.startsWith('--'));
  if (!ids.length) {
    console.error(`用法：node scripts/dsh-sessions.js ${command} <会话 id> [<会话 id>…]`);
    process.exit(1);
  }
  for (const id of ids) {
    const result =
      command === 'archive'
        ? archiveSession({ home, sessionId: id })
        : attachSessionToWorkspace({ sessionId: id, cwd: defaultKnowledgeDir(path.join(__dirname, '..')) });
    if (result.ok) {
      console.log(`✓ ${id}：${command === 'archive' ? '已归档（Web 里不再显示）' : '已取消归档并登记进工作区'}`);
      console.log('    提示：正在开着的 DSH Web 要重启一次才会同步（它只在启动时读工作区表）');
    } else {
      console.log(`✗ ${id}：${result.reason}`);
    }
  }
} else {
  console.error(`不认识这个命令：${command}（可用：list / delete / attach / archive / unarchive）`);
  process.exit(1);
}
