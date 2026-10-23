'use strict';

/**
 * 账号登录模块测试：用假 electron session 模拟「用户在登录窗口完成扫码」
 *   node scripts/test-bili-login.js
 *
 * 覆盖：轮询抓 Cookie → 校验 → 保存账号 → 退出登录清理 → 手动 Cookie 校验
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const http = require('http');

const root = path.join(__dirname, '..');
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------- 假 electron

function loadLoginModule({ cookies, userInfo }) {
  const record = { cleared: 0, closed: 0, opened: [] };

  class FakeWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      record.opened.push(options);
    }
    loadURL(url) {
      this.url = url;
    }
    on() {}
    close() {
      this.destroyed = true;
      record.closed += 1;
    }
    isDestroyed() {
      return this.destroyed;
    }
    focus() {}
  }

  const fakeSession = {
    setUserAgent() {},
    cookies: {
      get: () => Promise.resolve(cookies),
      remove: () => Promise.resolve()
    },
    clearStorageData: () => {
      record.cleared += 1;
      return Promise.resolve();
    }
  };

  const electron = {
    BrowserWindow: FakeWindow,
    session: { fromPartition: () => fakeSession }
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(path.join(root, 'src/main/bili-login.js'))];
  let mod;
  try {
    mod = require(path.join(root, 'src/main/bili-login.js'));
  } finally {
    Module._load = originalLoad;
  }

  const store = {
    data: { account: { loggedIn: false, sessdata: '' }, danmaku: { sessdata: '' } },
    get() {
      return this.data;
    },
    patch(partial) {
      this.data = { ...this.data, ...partial };
      return this.data;
    }
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };

  const login = new mod.BiliLogin({ store, logger, onChanged: () => {} });
  login._test = { record, store, userInfo };
  return login;
}

/** 起一个假 B 站 nav 接口，返回登录信息 */
function startFakeNav(handler) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handler(req)));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  console.log('账号登录模块');

  await test('未登录时状态为未登录，且没有可用 Cookie', async () => {
    const login = loadLoginModule({ cookies: [], userInfo: null });
    assert(login.status().loggedIn === false, '初始状态应为未登录');
    assert(login.currentCookies() === null, '未登录时不应返回 Cookie');
    assert(login.currentCookieHeader() === '', '未登录且没手填时 Cookie 串应为空');
  });

  await test('打开登录窗口后，抓到 Cookie 就会保存账号并自动关窗', async () => {
    // 先起假接口，把 nav 地址指过去
    const fake = await startFakeNav(() => ({
      code: 0,
      data: { isLogin: true, uname: '测试观众', mid: 10001, face: 'https://i1.hdslb.com/face.jpg' }
    }));

    const cookies = [
      { name: 'SESSDATA', value: 'sess-value-123' },
      { name: 'bili_jct', value: 'jct-456' },
      { name: 'DedeUserID', value: '10001' },
      { name: 'buvid3', value: 'buvid-789' }
    ];
    const login = loadLoginModule({ cookies, userInfo: null });

    // 把校验地址改到假接口（模块内部用的是常量，这里通过覆盖 fetch 实现）
    const realFetch = global.fetch;
    global.fetch = (url, options) =>
      realFetch(String(url).replace('https://api.bilibili.com', `http://127.0.0.1:${fake.port}`), options);

    try {
      await login.open();
      assert(login.window !== null, '登录窗口应该被打开');
      // 等轮询抓到 Cookie（轮询间隔 1.2s）
      for (let i = 0; i < 40 && !login.status().loggedIn; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      const status = login.status();
      assert(status.loggedIn === true, '应该完成登录');
      assert(status.userName === '测试观众', `昵称不对: ${status.userName}`);
      assert(status.userUid === '10001', `uid 不对: ${status.userUid}`);
      assert(login.currentCookies().SESSDATA === 'sess-value-123', '保存的 SESSDATA 不对');
      assert(login.currentCookieHeader().includes('bili_jct=jct-456'), 'Cookie 串应包含 bili_jct');

      const account = login._test.store.data.account;
      assert(account.loggedIn === true, '账号状态没有写入配置');
      assert(account.biliJct === 'jct-456', 'bili_jct 没有保存');
      assert(account.loginAt > 0, '登录时间没有记录');
    } finally {
      global.fetch = realFetch;
      fake.server.close();
    }
  });

  await test('Cookie 里没有 SESSDATA 时不会误判为已登录', async () => {
    const cookies = [{ name: 'buvid3', value: 'only-buvid' }];
    const login = loadLoginModule({ cookies, userInfo: null });
    await login.open();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert(login.status().loggedIn === false, '只有 buvid 不应判定登录成功');
    login.polling = false;
  });

  await test('退出登录会清空凭据并清理登录会话', async () => {
    const cookies = [{ name: 'SESSDATA', value: 'sess-value-123' }];
    const login = loadLoginModule({ cookies, userInfo: null });
    login._test.store.patch({
      account: { loggedIn: true, sessdata: 'sess-value-123', userName: '测试观众', userUid: '10001' }
    });
    assert(login.currentCookies().SESSDATA === 'sess-value-123', '准备数据不对');

    const status = await login.logout();
    assert(status.loggedIn === false, '退出后应为未登录');
    assert(login.currentCookies() === null, '退出后不应还有 Cookie');
    assert(login._test.store.data.account.sessdata === '', '配置里的 SESSDATA 没有清掉');
    assert(login._test.record.cleared === 1, '没有清理登录会话的存储');
  });

  await test('手动填写的 Cookie 会被拼成请求串（兼容只填值）', async () => {
    const login = loadLoginModule({ cookies: [], userInfo: null });
    login._test.store.data.danmaku = { sessdata: 'just-the-value' };
    assert(login.currentCookieHeader() === 'SESSDATA=just-the-value', `只填值时应补上键名: ${login.currentCookieHeader()}`);

    login._test.store.data.danmaku = { sessdata: 'SESSDATA=a; bili_jct=b' };
    assert(login.currentCookieHeader() === 'SESSDATA=a; bili_jct=b', '整段 Cookie 应原样使用');

    login._test.store.data.danmaku = { sessdata: '' };
    assert(login.currentCookieHeader() === '', '空值时不应拼出内容');
  });

  await test('登录状态下优先使用账号 Cookie，而不是手填的', async () => {
    const login = loadLoginModule({ cookies: [], userInfo: null });
    login._test.store.data.account = { loggedIn: true, sessdata: 'from-login' };
    login._test.store.data.danmaku = { sessdata: 'from-manual' };
    assert(login.currentCookieHeader().includes('from-login'), '应优先使用登录保存的 Cookie');
    assert(!login.currentCookieHeader().includes('from-manual'), '不应混入手填 Cookie');
  });

  await test('校验手填 Cookie：无效时给出明确原因', async () => {
    const fake = await startFakeNav(() => ({ code: -101, message: '账号未登录' }));
    const login = loadLoginModule({ cookies: [], userInfo: null });
    const realFetch = global.fetch;
    global.fetch = (url, options) =>
      realFetch(String(url).replace('https://api.bilibili.com', `http://127.0.0.1:${fake.port}`), options);
    try {
      const result = await login.verifyManual('SESSDATA=bad-value');
      assert(result.ok === false, '无效 Cookie 不应通过校验');
      assert(String(result.message).length > 0, '应给出失败原因');
    } finally {
      global.fetch = realFetch;
      fake.server.close();
    }
  });

  await test('校验手填 Cookie：有效时返回昵称和 uid', async () => {
    const fake = await startFakeNav(() => ({
      code: 0,
      data: { isLogin: true, uname: '菲***', mid: 999, face: '' }
    }));
    const login = loadLoginModule({ cookies: [], userInfo: null });
    const realFetch = global.fetch;
    global.fetch = (url, options) =>
      realFetch(String(url).replace('https://api.bilibili.com', `http://127.0.0.1:${fake.port}`), options);
    try {
      const result = await login.verifyManual('SESSDATA=good-value');
      assert(result.ok === true, '有效 Cookie 应通过校验');
      assert(result.userName === '菲***', `昵称不对: ${result.userName}`);
      assert(result.userUid === '999', `uid 不对: ${result.userUid}`);
    } finally {
      global.fetch = realFetch;
      fake.server.close();
    }
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  fs.rmSync(path.join(os.tmpdir(), 'unused'), { force: true });
  process.exit(failed ? 1 : 0);
})();
