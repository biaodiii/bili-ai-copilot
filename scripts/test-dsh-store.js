'use strict';

/**
 * DSH 会话库周边状态测试（工作区登记 / 会话删除）
 *   node scripts/test-dsh-store.js
 *
 * 全部在临时目录里跑：**绝不碰真实的 `~/.dsh`**（那是主播的会话库）。
 *
 * 背景：DSH Web 只按工作区登记表里的显式 `sessionIds` 分组，不在名单里的会话会落到
 * 「未分组」。所以软件建完会话要顺手登记；测试会话（比如验证脚本建的）则要能删干净。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveDshHome,
  workspaceFile,
  attachSessionToWorkspace,
  deleteSession,
  listSessions,
  findSessionDir,
  readWorkspaceRegistry,
  encodeSessionDirName,
  archiveSession
} = require('../src/main/dsh-store');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}\n      ${error.message}`);
  }
}

/** 造一个假 DSH_HOME：带 workspace.json、一个已有工作区、一个已有会话 */
function makeHome({ withRegistry = true, registry } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-home-'));
  const knowledge = path.join(home, '知识库');
  fs.mkdirSync(knowledge, { recursive: true });
  fs.mkdirSync(path.join(home, 'sessions', '--D-demo--', 'session-old'), { recursive: true });
  fs.writeFileSync(path.join(home, 'sessions', '--D-demo--', 'session-old', 'session.v3.jsonl.zstd'), 'x', 'utf8');
  fs.mkdirSync(path.join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  if (withRegistry) {
    const data = registry || {
      unit: { name: 'workspace', version: 2 },
      global: {
        initialized: true,
        workspaceIds: ['ws-workspace'],
        // 注意：这里必须放一个**磁盘上真存在**的会话（session-old）。
        // 放不存在的 id 会被新的「清僵尸归档项」逻辑剪掉，测不出「别的引用不能动」。
        archivedSessionIds: ['session-old']
      },
      tables: {
        workspaces: {
          'ws-workspace': {
            path: 'D:\\projects',
            title: 'workspace',
            sessionIds: ['session-old'],
            createdAt: '2026-09-12T07:18:16.790Z',
            updatedAt: '2026-10-10T19:52:12.456Z'
          }
        }
      }
    };
    fs.writeFileSync(workspaceFile(home), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
  return { home, knowledge, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

const read = (home) => JSON.parse(fs.readFileSync(workspaceFile(home), 'utf8'));

(async () => {
  console.log('DSH 会话库周边状态测试\n');

  await test('DSH_HOME 解析：设了就用它，没设/空白就退 ~/.dsh', () => {
    assert.strictEqual(resolveDshHome({ DSH_HOME: 'C:\\tmp\\dsh' }, 'C:\\Users\\x'), 'C:\\tmp\\dsh');
    assert.strictEqual(resolveDshHome({ DSH_HOME: '   ' }, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'));
    assert.strictEqual(resolveDshHome({}, 'C:\\Users\\x'), path.join('C:\\Users\\x', '.dsh'));
  });

  await test('知识库目录还没有工作区记录：新建一条，并把它排在最前面（和 DSH 一样）', () => {
    const { home, knowledge, cleanup } = makeHome();
    try {
      const result = attachSessionToWorkspace({ home, sessionId: 's-new', cwd: knowledge, title: '知识库' });
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.created, true);
      assert.strictEqual(result.changed, true);
      const data = read(home);
      assert.strictEqual(data.global.workspaceIds[0], result.workspaceId, '新工作区要插到最前面');
      const record = data.tables.workspaces[result.workspaceId];
      assert.ok(record, '应该真的写进表里');
      assert.strictEqual(record.title, '知识库');
      assert.deepStrictEqual(record.sessionIds, ['s-new']);
      assert.ok(record.createdAt && record.updatedAt, '要有时间戳');
      // 别的工作区、归档名单都不能被动
      assert.ok(data.tables.workspaces['ws-workspace'], '原有工作区要留着');
      assert.deepStrictEqual(data.global.archivedSessionIds, ['session-old'], '别的归档项不能被动');
      // 一次性备份
      assert.ok(fs.existsSync(`${workspaceFile(home)}.app-backup`), '第一次写之前要留一份备份');
    } finally {
      cleanup();
    }
  });

  await test('已经有这个目录的工作区：只往 sessionIds 里追加', () => {
    const { home, knowledge, cleanup } = makeHome();
    try {
      const first = attachSessionToWorkspace({ home, sessionId: 's-1', cwd: knowledge });
      const second = attachSessionToWorkspace({ home, sessionId: 's-2', cwd: knowledge });
      assert.strictEqual(first.workspaceId, second.workspaceId, '同一个目录要用同一个工作区');
      assert.strictEqual(second.created, false);
      const record = read(home).tables.workspaces[second.workspaceId];
      assert.deepStrictEqual(record.sessionIds, ['s-1', 's-2']);
      assert.strictEqual(Object.keys(read(home).tables.workspaces).length, 2, '不该多造工作区');
    } finally {
      cleanup();
    }
  });

  await test('幂等：同一个会话登记两次，第二次不写盘', () => {
    const { home, knowledge, cleanup } = makeHome();
    try {
      attachSessionToWorkspace({ home, sessionId: 's-1', cwd: knowledge });
      const before = fs.readFileSync(workspaceFile(home), 'utf8');
      const again = attachSessionToWorkspace({ home, sessionId: 's-1', cwd: knowledge });
      assert.strictEqual(again.ok, true);
      assert.strictEqual(again.changed, false, '已经登记过就不该再改');
      assert.strictEqual(fs.readFileSync(workspaceFile(home), 'utf8'), before, '文件内容不该变');
    } finally {
      cleanup();
    }
  });

  await test('格式不认识 / JSON 坏了 / DSH 正在改表：一个字节都不动', () => {
    const cases = [
      { name: '版本不对', registry: { unit: { name: 'workspace', version: 3 }, global: { workspaceIds: [] }, tables: { workspaces: {} } }, reason: /格式不认识/ },
      { name: '名字不对', registry: { unit: { name: 'other', version: 2 }, global: { workspaceIds: [] }, tables: { workspaces: {} } }, reason: /格式不认识/ },
      { name: '字段缺', registry: { unit: { name: 'workspace', version: 2 }, global: { workspaceIds: [] } }, reason: /形状/ },
      {
        name: '正在改表',
        registry: {
          unit: { name: 'workspace', version: 2 },
          global: { workspaceIds: [], pendingMutation: { kind: 'create' } },
          tables: { workspaces: {} }
        },
        reason: /pendingMutation/
      }
    ];
    for (const item of cases) {
      const { home, knowledge, cleanup } = makeHome({ registry: item.registry });
      try {
        const before = fs.readFileSync(workspaceFile(home), 'utf8');
        const result = attachSessionToWorkspace({ home, sessionId: 's-x', cwd: knowledge });
        assert.strictEqual(result.ok, false, `${item.name}：应该拒绝`);
        assert.ok(item.reason.test(result.reason), `${item.name}：理由要说清楚，实际「${result.reason}」`);
        assert.strictEqual(fs.readFileSync(workspaceFile(home), 'utf8'), before, `${item.name}：文件不该被改`);
      } finally {
        cleanup();
      }
    }
    // JSON 坏掉那种单独测（上面的 fixture 写不出坏 JSON）
    const { home, knowledge, cleanup } = makeHome({ withRegistry: false });
    try {
      fs.writeFileSync(workspaceFile(home), '{ 这不是 JSON', 'utf8');
      const result = attachSessionToWorkspace({ home, sessionId: 's-x', cwd: knowledge });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(fs.readFileSync(workspaceFile(home), 'utf8'), '{ 这不是 JSON');
    } finally {
      cleanup();
    }
  });

  await test('没有 workspace.json（DSH 还没初始化）→ 拒绝，不自己造一个', () => {
    const { home, knowledge, cleanup } = makeHome({ withRegistry: false });
    try {
      const result = attachSessionToWorkspace({ home, sessionId: 's-x', cwd: knowledge });
      assert.strictEqual(result.ok, false);
      assert.ok(/还没初始化/.test(result.reason), result.reason);
      assert.strictEqual(fs.existsSync(workspaceFile(home)), false, '不该凭空造文件');
    } finally {
      cleanup();
    }
  });

  await test('删除会话：日志目录 + 登记表引用 + 投影缓存，一次清干净', () => {
    const { home, knowledge, cleanup } = makeHome();
    try {
      const attached = attachSessionToWorkspace({ home, sessionId: 's-del', cwd: knowledge });
      const dir = path.join(home, 'sessions', '--D-knowledge--', 's-del');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'log', 'utf8');
      const projection = path.join(home, 'storages', 'session_projcache', 'sessions', 's-del.json');
      fs.writeFileSync(projection, '{}', 'utf8');
      // 顺便让它也出现在归档名单里
      const data = read(home);
      data.global.archivedSessionIds.push('s-del');
      fs.writeFileSync(workspaceFile(home), JSON.stringify(data, null, 2), 'utf8');

      assert.strictEqual(findSessionDir(home, 's-del'), dir);
      const result = deleteSession({ home, sessionId: 's-del' });
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(fs.existsSync(dir), false, '日志目录要删掉');
      assert.strictEqual(fs.existsSync(projection), false, '投影缓存要删掉');
      const after = read(home);
      assert.ok(!after.tables.workspaces[attached.workspaceId].sessionIds.includes('s-del'), '登记表里的引用要摘掉');
      assert.ok(!after.global.archivedSessionIds.includes('s-del'), '归档名单里的引用也要摘掉');
      assert.deepStrictEqual(after.global.archivedSessionIds, ['session-old'], '别的归档项不能动');
      assert.ok(fs.existsSync(path.join(home, 'sessions', '--D-demo--', 'session-old')), '别的会话不能碰');
    } finally {
      cleanup();
    }
  });

  await test('删除会话：找不到会说清楚；带 ../ 的 id 不能穿出会话库', () => {
    const { home, cleanup } = makeHome();
    try {
      const missing = deleteSession({ home, sessionId: 'no-such-session' });
      assert.strictEqual(missing.ok, false);
      assert.ok(/没找到/.test(missing.reason), missing.reason);

      // 路径穿越：id 里带 ../，指向会话库外面（真的造一个目录，确认它不会被删）
      // `sessions/<项目>/../../evil` = `<home>/evil`，所以要造在 home 下面
      const outside = path.join(home, 'evil');
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep', 'utf8');
      const traversal = deleteSession({ home, sessionId: path.join('..', '..', 'evil') });
      assert.strictEqual(traversal.ok, false, '不能让 id 里的 ../ 把会话库外面的目录删掉');
      assert.ok(/拒绝删除/.test(traversal.reason), traversal.reason);
      assert.ok(fs.existsSync(path.join(outside, 'keep.txt')), '拒绝之后那个目录必须原样还在');
    } finally {
      cleanup();
    }
  });

  await test('被归档的会话：登记时顺手取消归档（归档的会话在 Web 里哪儿都不显示）', () => {
    const { home, knowledge, cleanup } = makeHome();
    try {
      // 造一个「已归档」的会话（用户在 Web 里右键「归档会话」过）
      const dir = path.join(home, 'sessions', '--D-knowledge--', 's-arch');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'log', 'utf8');
      const data = read(home);
      data.global.archivedSessionIds.push('s-arch', 'session-old');
      fs.writeFileSync(workspaceFile(home), `${JSON.stringify(data, null, 2)}\n`, 'utf8');

      const result = attachSessionToWorkspace({ home, sessionId: 's-arch', cwd: knowledge });
      assert.strictEqual(result.ok, true, result.reason);
      assert.strictEqual(result.unarchived, true, '要把这个会话从归档里放出来');
      const after = read(home);
      assert.ok(!after.global.archivedSessionIds.includes('s-arch'), '归档名单里不该再有它');
      assert.ok(after.global.archivedSessionIds.includes('session-old'), '别的归档项不能动');
      assert.ok(after.tables.workspaces[result.workspaceId].sessionIds.includes('s-arch'), '同时要登记进工作区');

      // 已经取消过归档、也在名单里 → 再登记一次不该写盘
      const before = fs.readFileSync(workspaceFile(home), 'utf8');
      const again = attachSessionToWorkspace({ home, sessionId: 's-arch', cwd: knowledge });
      assert.strictEqual(again.changed, false, '无事可做就不该写盘');
      assert.strictEqual(fs.readFileSync(workspaceFile(home), 'utf8'), before);
    } finally {
      cleanup();
    }
  });

  await test('归档名单里的「僵尸项」会被清掉（会话已经删了）', () => {
    const { home, knowledge, cleanup } = makeHome();
    try {
      const data = read(home);
      data.global.archivedSessionIds = ['gone-1', 'session-old']; // gone-1 磁盘上没有，session-old 存在
      fs.writeFileSync(workspaceFile(home), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      const result = attachSessionToWorkspace({ home, sessionId: 's-new', cwd: knowledge });
      assert.ok(result.pruned.includes('gone-1'), `僵尸归档项要清掉：${JSON.stringify(result.pruned)}`);
      const after = read(home);
      assert.ok(!after.global.archivedSessionIds.includes('gone-1'));
      assert.ok(after.global.archivedSessionIds.includes('session-old'), '真还在的会话不能被清');
    } finally {
      cleanup();
    }
  });

  await test('非 ASCII 的会话 id：目录名是转义过的，不能被当成「已删除」', () => {
    const { home, cleanup } = makeHome();
    try {
      // DSH 把 `~76F4…` 这样的 id 转义成目录名 `~007E76F4…`
      const id = '~76F4~64AD~77E5~8BC6~6574~7406';
      const dirName = encodeSessionDirName(id);
      assert.strictEqual(dirName, '~007E76F4~007E64AD~007E77E5~007E8BC6~007E6574~007E7406');
      const dir = path.join(home, 'sessions', '--D-knowledge--', dirName);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), 'log', 'utf8');
      assert.strictEqual(findSessionDir(home, id), dir, '要能按转义名找到目录');

      // 归档项指向一个真存在的会话 → 不能被当僵尸清掉
      const data = read(home);
      data.global.archivedSessionIds = [id];
      fs.writeFileSync(workspaceFile(home), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      const result = attachSessionToWorkspace({ home, sessionId: 's-x', cwd: path.join(home, '知识库') });
      assert.deepStrictEqual(result.pruned, [], '真存在的会话不能被当僵尸清掉');
      assert.ok(read(home).global.archivedSessionIds.includes(id), '它的归档状态要保持');

      // 删除也要认这个转义目录
      const deleted = deleteSession({ home, sessionId: id });
      assert.strictEqual(deleted.ok, true, deleted.reason);
      assert.strictEqual(fs.existsSync(dir), false);
    } finally {
      cleanup();
    }
  });

  await test('归档会话（相当于在 Web 里右键「归档会话」）', () => {
    const { home, cleanup } = makeHome();
    try {
      const first = archiveSession({ home, sessionId: 's-arch-me' });
      assert.strictEqual(first.ok, true, first.reason);
      assert.strictEqual(first.changed, true);
      assert.ok(read(home).global.archivedSessionIds.includes('s-arch-me'));
      const again = archiveSession({ home, sessionId: 's-arch-me' });
      assert.strictEqual(again.changed, false, '归档是幂等的');
    } finally {
      cleanup();
    }
  });

  await test('列会话：能列出 id / 目录 / 大小 / 时间（不解压日志）', () => {
    const { home, cleanup } = makeHome();
    try {
      fs.mkdirSync(path.join(home, 'sessions', '--D-knowledge--', 's-2'), { recursive: true });
      fs.writeFileSync(path.join(home, 'sessions', '--D-knowledge--', 's-2', 'session.v3.jsonl.zstd'), 'abcd', 'utf8');
      const rows = listSessions({ home });
      const ids = rows.map((row) => row.id).sort();
      assert.deepStrictEqual(ids, ['s-2', 'session-old']);
      const second = rows.find((row) => row.id === 's-2');
      assert.strictEqual(second.bytes, 4);
      assert.ok(second.updatedAt, '要有时间');
    } finally {
      cleanup();
    }
  });

  await test('读登记表：能读到就用，读不到给理由（调用方据此放弃写入）', () => {
    const { home, cleanup } = makeHome();
    try {
      const ok = readWorkspaceRegistry(home);
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(ok.data.unit.version, 2);
    } finally {
      cleanup();
    }
    const { home: home2, cleanup: cleanup2 } = makeHome({ withRegistry: false });
    try {
      const missing = readWorkspaceRegistry(home2);
      assert.strictEqual(missing.ok, false);
      assert.ok(/没有 workspace\.json/.test(missing.reason));
    } finally {
      cleanup2();
    }
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
