'use strict';

/**
 * ⚠️ **已下线（2026-10-19），本模块保留、不再接新活**
 *
 * 它原来负责两件 DSH 专属的杂事：① 把 ACP 建出来的会话**登记进「知识库」工作区**
 * （不登记在 DSH Web 里会显示「未分组」）；② 清理测试会话（`scripts/dsh-sessions.js`
 * 和 `verify-dsh-session.js` 用）。
 *
 * DSH 研究引擎停用后，`main.js` 仍然 require 它（`attachSessionToWorkspace`），
 * 但那是会话建好后才会走到的回调 —— 而会话已经不会再建了，所以它实际上不会被调用。
 * 保留它的另一个原因是 `scripts/dsh-sessions.js` 还在（手动清理 DSH 会话的小工具）。
 * 想恢复 DSH：见交接文档 §6.16。
 *
 * ---------- 以下是原说明（仍然准确）----------
 *
 * DSH 会话库里那点「会话之外」的状态：**工作区登记表**和**会话清理**。
 *
 * ## 为什么需要它：不登记就进「未分组」
 *
 * DSH Web 的侧边栏**只按工作区登记表里的显式 `sessionIds` 分组**：
 *
 * ```js
 * function owningGroupKey(workspaces, sessionId) {
 *   return workspaces.find((w) => w.sessionIds.includes(sessionId))?.workspaceId ?? "";
 * }
 * ```
 *
 * 不在任何工作区 `sessionIds` 里的会话，全部落到「未分组」。而工作区的成员关系**不是**
 * 按路径自动推出来的——`dsh-workspace` 只在两处建立成员：① 从 Web 界面新建会话（cwd =
 * 工作区路径）；② 首次初始化时的历史导入（`initialized: false` 那次）。我们用 ACP
 * （`session/new`）建的会话**两条都不沾**，所以哪怕会话头里的 cwd 就是知识库目录，
 * 在 Web 里照样显示成「未分组」。
 *
 * 所以软件在会话建好之后，**顺手把它登记进工作区**：找到（或新建）path = 知识库目录的
 * 工作区记录，把这个 sessionId 放进它的 `sessionIds`。记录落在
 * `$DSH_HOME/storages/workspace.json`（`defineDomain({name:'workspace', version:2})` 的
 * 持久化形式：`{unit, global:{workspaceIds, archivedSessionIds}, tables:{workspaces}}`）。
 *
 * ## 为什么敢直接写这个文件（三条自我保护）
 *
 * 1. **格式不对就不写**：文件名/版本号不是 `workspace`/`2`、JSON 坏了、字段形状变了、
 *    或者有 `pendingMutation`（说明 DSH 正在改这张表）→ 直接返回失败、**一个字节都不动**；
 * 2. **只动该动的字段**：只加一条工作区记录、只往 `sessionIds` 里追加，其余原样保留；
 * 3. **原子落盘 + 一次性备份**：先写 `.tmp-<pid>-<时间>` 再 `rename`（同盘原子），
 *    并在第一次写之前留一份 `workspace.json.app-backup`。
 *
 * 另外：登记是**幂等**的，每次会话建好/续用都会再登记一次。所以万一 DSH Web 正好在跑、
 * 用它内存里的旧状态把文件覆盖回去，下一次整理就会自动补上。
 *
 * ## 删除会话
 *
 * 一次删干净三处：会话日志目录 `$DSH_HOME/sessions/<项目>/<会话 id>/`、
 * 工作区登记表里的引用（`sessionIds` 与 `archivedSessionIds`）、
 * 投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<id>.json`。
 * 路径都做了前缀校验：**只允许删 `$DSH_HOME/sessions` 下面的一层目录**，防手滑。
 *
 * ⚠️ 不要在这里用 `zlib.zstd*`：软件跑在 Electron 自带的 Node 20 上，没有 zstd。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

/** 认得的存储格式（`defineDomain({name, version})`） */
const WORKSPACE_DOMAIN = { name: 'workspace', version: 2 };

/** `$DSH_HOME`（空/空白视为没设），默认 `~/.dsh` */
function resolveDshHome(env = process.env, homeDir = os.homedir()) {
  const fromEnv = String((env && env.DSH_HOME) || '').trim();
  return fromEnv ? path.resolve(fromEnv) : path.join(homeDir, '.dsh');
}

function workspaceFile(home) {
  return path.join(home, 'storages', 'workspace.json');
}

function sessionsRoot(home) {
  return path.join(home, 'sessions');
}

/** 目录的规范写法（Windows 下顺便统一盘符大小写），拿不到就用 resolve */
function canonicalDir(dir) {
  try {
    return fs.realpathSync.native(dir);
  } catch (_) {
    return path.resolve(String(dir));
  }
}

/**
 * 读工作区登记表。**任何不确定的情况都返回 ok:false**（调用方据此放弃写入）。
 * @returns {{ok:boolean, reason?:string, file:string, data?:object}}
 */
function readWorkspaceRegistry(home) {
  const file = workspaceFile(home);
  if (!fs.existsSync(file)) return { ok: false, reason: '没有 workspace.json（DSH 还没初始化过工作区）', file };
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: `workspace.json 读不了：${error.message}`, file };
  }
  const unit = data && data.unit;
  if (!unit || unit.name !== WORKSPACE_DOMAIN.name || unit.version !== WORKSPACE_DOMAIN.version) {
    return { ok: false, reason: `工作区存储格式不认识（${unit && unit.name}/${unit && unit.version}）`, file };
  }
  const global = data.global;
  if (!global || !Array.isArray(global.workspaceIds) || !data.tables || typeof data.tables.workspaces !== 'object') {
    return { ok: false, reason: 'workspace.json 字段形状和预期不一样', file };
  }
  if (global.pendingMutation !== undefined && global.pendingMutation !== null) {
    return { ok: false, reason: 'DSH 正在改工作区表（pendingMutation），这次不动它', file };
  }
  return { ok: true, file, data };
}

/** 落盘：先写临时文件再改名（同盘原子），顺手留一份一次性备份 */
function writeWorkspaceRegistry(file, data, { backup = true } = {}) {
  if (backup) {
    const bak = `${file}.app-backup`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 把这个会话登记进「cwd 对应的工作区」，找不到这样的工作区就新建一条。
 * 顺手**取消归档**（被归档的会话在 DSH Web 里哪儿都不显示，见 unarchiveSession 的说明）。
 * 幂等：已经在名单里、也没被归档，就什么都不做（不写盘）。
 *
 * @param {{home?:string, sessionId:string, cwd:string, title?:string, env?:object, backup?:boolean}} options
 * @returns {{ok:boolean, changed:boolean, workspaceId?:string, created?:boolean, unarchived?:boolean, pruned?:string[], reason?:string, file?:string}}
 */
function attachSessionToWorkspace({ home, sessionId, cwd, title, env = process.env, backup = true } = {}) {
  const root = home || resolveDshHome(env);
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, changed: false, reason: '没有会话 id' };
  if (!cwd) return { ok: false, changed: false, reason: '没有工作区目录' };
  const canonical = canonicalDir(cwd);

  const registry = readWorkspaceRegistry(root);
  if (!registry.ok) return { ok: false, changed: false, reason: registry.reason, file: registry.file };
  const { file, data } = registry;
  const workspaces = data.tables.workspaces;

  // ① 先处理归档：被归档的会话在 Web 里看不见，等于「工作区分组是空的」
  const archiveFix = unarchiveSession(data, { sessionId: id, exists: (cid) => Boolean(findSessionDir(root, cid)) });

  // ② 找 path 一致的工作区（多个就都算，全部登记）
  const matches = Object.entries(workspaces).filter(([, record]) => record && canonicalDir(record.path || '') === canonical);
  const listed = matches.length > 0 && matches.every(([, record]) => Array.isArray(record.sessionIds) && record.sessionIds.includes(id));
  if (listed && !archiveFix.changed) {
    return { ok: true, changed: false, workspaceId: matches[0][0], created: false, unarchived: false, pruned: [], file };
  }

  const now = new Date().toISOString();
  if (matches.length) {
    for (const [, record] of matches) {
      if (!Array.isArray(record.sessionIds)) record.sessionIds = [];
      if (!record.sessionIds.includes(id)) record.sessionIds.push(id);
      record.updatedAt = now;
    }
    writeWorkspaceRegistry(file, data, { backup });
    return {
      ok: true,
      changed: true,
      workspaceId: matches[0][0],
      created: false,
      unarchived: archiveFix.unarchived,
      pruned: archiveFix.pruned,
      file
    };
  }

  // ② 没有就新建一条（DSH 自己新建时是**插到最前面**的，跟着它）
  const workspaceId = crypto.randomUUID();
  workspaces[workspaceId] = {
    path: canonical,
    title: String(title || path.basename(canonical) || '知识库').slice(0, 80),
    sessionIds: [id],
    createdAt: now,
    updatedAt: now
  };
  data.global.workspaceIds.unshift(workspaceId);
  writeWorkspaceRegistry(file, data, { backup });
  return {
    ok: true,
    changed: true,
    workspaceId,
    created: true,
    unarchived: archiveFix.unarchived,
    pruned: archiveFix.pruned,
    file
  };
}

/**
 * 把会话从「已归档」里放出来，并清掉已经删掉的会话留下的归档残项。
 *
 * 为什么必须做：被归档的会话在 DSH Web 里**哪儿都不显示**
 * （`sessionVisible()`：`session.origin !== 'subagent' && !archived.has(session.id) && …`，
 * 注释原文「archived sessions are visible nowhere」），于是工作区分组在、里面却是空的——
 * 主播真以为是坏了（真踩过：会话被右键「归档会话」之后，组是空白的）。
 *
 * @param {object} data 登记表（就地修改）
 * @param {{sessionId?:string, exists?:(id:string)=>boolean}} options
 *        `exists` 判断归档项指向的会话还在不在（不在、也没挂在工作区名单里，就顺手清掉）
 * @returns {{changed:boolean, unarchived:boolean, pruned:string[]}}
 */
function unarchiveSession(data, { sessionId, exists } = {}) {
  const id = String(sessionId || '').trim();
  const result = { changed: false, unarchived: false, pruned: [] };
  const global = data && data.global;
  if (!global || !Array.isArray(global.archivedSessionIds)) return result;

  if (id && global.archivedSessionIds.includes(id)) {
    global.archivedSessionIds = global.archivedSessionIds.filter((item) => item !== id);
    result.unarchived = true;
    result.changed = true;
  }
  if (typeof exists === 'function') {
    const kept = global.archivedSessionIds.filter((item) => {
      const inWorkspace = Object.values((data.tables && data.tables.workspaces) || {}).some(
        (record) => record && Array.isArray(record.sessionIds) && record.sessionIds.includes(item)
      );
      if (inWorkspace || exists(item)) return true;
      result.pruned.push(item);
      return false;
    });
    if (kept.length !== global.archivedSessionIds.length) {
      global.archivedSessionIds = kept;
      result.changed = true;
    }
  }
  return result;
}

/** 从登记表里摘掉这个会话（所有工作区的 sessionIds 与 archivedSessionIds） */
function detachSessionFromRegistry(data, sessionId) {
  const id = String(sessionId || '').trim();
  let changed = false;
  for (const record of Object.values((data.tables && data.tables.workspaces) || {})) {
    if (!record || !Array.isArray(record.sessionIds)) continue;
    const next = record.sessionIds.filter((item) => item !== id);
    if (next.length !== record.sessionIds.length) {
      record.sessionIds = next;
      record.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (data.global && Array.isArray(data.global.archivedSessionIds)) {
    const next = data.global.archivedSessionIds.filter((item) => item !== id);
    if (next.length !== data.global.archivedSessionIds.length) {
      data.global.archivedSessionIds = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 会话 id → DSH 的目录名。**必须和 DSH 的 `encodeSegment()` 一致**：
 * 安全字符 `[A-Za-z0-9._-]` 原样，其余按 UTF-16 码元转义成 `~XXXX`（大写十六进制）。
 *
 * 为什么需要它：非 ASCII 的 id 在磁盘上是转义过的
 * （`~76F4~64AD…` → 目录 `~007E76F4~007E64AD…`），
 * 不按转义名找就会把**真实存在的会话**误判成「已删除」——
 * 这个 bug 真犯过：清理归档名单时把一个还在的会话的归档项当成僵尸删掉了。
 */
function encodeSessionDirName(sessionId) {
  const raw = String(sessionId || '');
  if (!raw) return '';
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return out;
}

/**
 * 把会话登记进「已归档」（相当于在 Web 里右键「归档会话」）：它在侧边栏里就哪儿都不显示了。
 * 幂等；格式不认识就不写。
 *
 * @returns {{ok:boolean, changed:boolean, reason?:string, file?:string}}
 */
function archiveSession({ home, sessionId, env = process.env, backup = true } = {}) {
  const root = home || resolveDshHome(env);
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, changed: false, reason: '没有会话 id' };
  const registry = readWorkspaceRegistry(root);
  if (!registry.ok) return { ok: false, changed: false, reason: registry.reason, file: registry.file };
  const { file, data } = registry;
  if (!Array.isArray(data.global.archivedSessionIds)) return { ok: false, changed: false, reason: '登记表里没有归档名单', file };
  if (data.global.archivedSessionIds.includes(id)) return { ok: true, changed: false, file };
  data.global.archivedSessionIds.push(id);
  writeWorkspaceRegistry(file, data, { backup });
  return { ok: true, changed: true, file };
}

/** 会话日志目录（按 id 找：原名和转义名都试，找不到返回空字符串） */
function findSessionDir(home, sessionId) {
  const id = String(sessionId || '').trim();
  const root = sessionsRoot(home);
  if (!id || !fs.existsSync(root)) return '';
  const names = [id, encodeSessionDirName(id)].filter((name, index, list) => name && list.indexOf(name) === index);
  for (const project of fs.readdirSync(root)) {
    for (const name of names) {
      const candidate = path.join(root, project, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    }
  }
  return '';
}

/**
 * 删掉一个会话：日志目录 + 登记表引用 + 投影缓存。
 * 只允许删 `$DSH_HOME/sessions/<项目>/<会话 id>` 这一层，别的路径一律拒绝。
 *
 * @returns {{ok:boolean, removed?:string[], reason?:string}}
 */
function deleteSession({ home, sessionId, env = process.env, backup = true } = {}) {
  const root = home || resolveDshHome(env);
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, reason: '没有会话 id' };
  const removed = [];
  const rootDir = sessionsRoot(root);

  const dir = findSessionDir(root, id);
  if (dir) {
    // 安全校验：必须正好是 sessions/<项目>/<目录名>，且目录名就是 id 或它的转义形式
    const relative = path.relative(rootDir, dir);
    const parts = relative.split(path.sep).filter(Boolean);
    const allowed = [id, encodeSessionDirName(id)];
    if (parts.length !== 2 || !allowed.includes(parts[1])) return { ok: false, reason: `路径不在会话库里，拒绝删除：${dir}` };
    fs.rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
    // 项目目录空了就一起收掉（DSH 会自己重建）
    const projectDir = path.dirname(dir);
    try {
      if (fs.readdirSync(projectDir).length === 0) {
        fs.rmdirSync(projectDir);
        removed.push(projectDir);
      }
    } catch (_) {
      /* 收不掉就算了 */
    }
  }

  const projection = path.join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  if (fs.existsSync(projection)) {
    fs.rmSync(projection, { force: true });
    removed.push(projection);
  }

  const registry = readWorkspaceRegistry(root);
  if (registry.ok && detachSessionFromRegistry(registry.data, id)) {
    writeWorkspaceRegistry(registry.file, registry.data, { backup });
    removed.push(`${registry.file}（登记表引用）`);
  }

  if (!removed.length) return { ok: false, reason: `没找到这个会话：${id}` };
  return { ok: true, removed };
}

/**
 * 列出会话（只读目录信息，不解压日志——软件跑在 Node 20 上，没有 zstd）。
 * @returns {Array<{id:string, dir:string, project:string, bytes:number, updatedAt:string}>}
 */
function listSessions({ home, env = process.env } = {}) {
  const root = home || resolveDshHome(env);
  const out = [];
  if (!fs.existsSync(sessionsRoot(root))) return out;
  for (const project of fs.readdirSync(sessionsRoot(root))) {
    const projectDir = path.join(sessionsRoot(root), project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const id of fs.readdirSync(projectDir)) {
      const dir = path.join(projectDir, id);
      if (!fs.statSync(dir).isDirectory()) continue;
      let bytes = 0;
      for (const name of fs.readdirSync(dir)) {
        try {
          bytes += fs.statSync(path.join(dir, name)).size;
        } catch (_) {
          /* 忽略 */
        }
      }
      out.push({
        id,
        dir,
        project,
        bytes,
        updatedAt: fs.statSync(dir).mtime.toISOString()
      });
    }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

module.exports = {
  WORKSPACE_DOMAIN,
  resolveDshHome,
  workspaceFile,
  sessionsRoot,
  canonicalDir,
  readWorkspaceRegistry,
  writeWorkspaceRegistry,
  attachSessionToWorkspace,
  unarchiveSession,
  archiveSession,
  encodeSessionDirName,
  detachSessionFromRegistry,
  findSessionDir,
  deleteSession,
  listSessions
};
