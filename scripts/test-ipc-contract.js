'use strict';

/**
 * IPC 契约测试：在真实（假的）electron 环境里执行 preload.js，
 * 把渲染层真正拿到的 window.api 与主进程注册的通道对起来。
 *   node scripts/test-ipc-contract.js
 *
 * 这是界面与主进程之间唯一的接缝：
 *   - preload 报错 → 渲染层 window.api 缺失 → 整个界面失效
 *   - 通道名拼错 → 点了没反应（这种错最难查）
 * 所以这里逐个方法真的调用一遍，确认主进程那边都能接住。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Module = require('module');

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

// ---------------------------------------------------------------- 加载 preload

/** 在假 electron 里执行 preload.js，返回它暴露的 window.api */
function loadPreload({ onInvoke, channels }) {
  const exposed = {};
  const listeners = new Map();
  const invoked = [];

  const electron = {
    contextBridge: {
      exposeInMainWorld: (key, value) => {
        exposed[key] = value;
      }
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invoked.push({ channel, args });
        if (channels && !channels.has(channel)) {
          return Promise.reject(new Error(`没有注册的通道: ${channel}`));
        }
        return Promise.resolve(onInvoke ? onInvoke(channel, args) : undefined);
      },
      on: (channel, handler) => {
        listeners.set(channel, handler);
      },
      removeListener: () => {}
    }
  };

  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve(path.join(root, 'src/main/preload.js'))];
    require(path.join(root, 'src/main/preload.js'));
  } finally {
    Module._load = originalLoad;
  }

  return { api: exposed.api, invoked, listeners, exposed };
}

// ---------------------------------------------------------------- 收集主进程通道

/** 从 main.js 源码里抽出所有 ipcMain.handle 的通道名（静态分析，不需要启动主进程） */
function collectMainChannels() {
  const source = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const handled = new Set(
    [...source.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)].map((match) => match[1])
  );
  const sent = new Set([
    ...[...source.matchAll(/send\(\s*[A-Za-z0-9_.]+,\s*'([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/broadcast\(\s*'([^']+)'/g)].map((match) => match[1]),
    ...[...source.matchAll(/sendToOverlay\(\s*'([^']+)'/g)].map((match) => match[1])
  ]);
  return { handled, sent };
}

/** 把所有叶子方法收集成 [{ path, fn }] */
function collectMethods(object, prefix = '', out = []) {
  for (const [key, value] of Object.entries(object)) {
    const label = prefix ? `${prefix}.${key}` : key;
    if (key === 'on') {
      for (const [event, fn] of Object.entries(value)) out.push({ path: `on.${event}`, fn });
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectMethods(value, label, out);
      continue;
    }
    if (typeof value === 'function') out.push({ path: label, fn: value });
  }
  return out;
}

// ---------------------------------------------------------------- 测试

(async () => {
  console.log('IPC 契约（真实执行 preload.js）');

  const { handled, sent } = collectMainChannels();

  await test('preload.js 语法正确（语法错会导致 window.api 整个不存在）', async () => {
    // 这条专门守一个真实的坑：preload 里少写一个 `},` 就会整个文件语法错误，
    // 结果是 window.api 完全不存在、界面按钮全部点不动。
    const source = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf8');
    // 先做真正的语法校验（不是正则比对）
    // eslint-disable-next-line no-new-func
    new Function('require', 'module', 'exports', '__dirname', source);
    assert(source.includes('exposeInMainWorld'), 'preload 里应该调用 contextBridge.exposeInMainWorld');
  });

  await test('preload.js 能执行并暴露 window.api', async () => {
    const { api, exposed } = loadPreload({});
    assert(exposed.api, 'preload 没有通过 contextBridge 暴露 api');
    assert(api && typeof api === 'object', 'window.api 不是对象');
    const methods = collectMethods(api);
    assert(methods.length >= 30, `暴露的方法太少（${methods.length} 个），可能漏了分组`);
  });

  await test('渲染层实际调用的通道都在主进程注册过', async () => {
    const { api } = loadPreload({ channels: handled, onInvoke: () => undefined });
    // 逐个方法真实调用一遍，参数不合法也没关系，只关心通道名
    for (const method of collectMethods(api)) {
      if (method.path.startsWith('on.')) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await method.fn('测试参数');
      } catch (error) {
        if (/没有注册的通道/.test(error.message)) {
          throw new Error(`${method.path} 调用了未注册的通道: ${error.message}`);
        }
      }
    }
  });

  await test('双向契约：界面调用的通道都存在，注册的通道界面都会用到', async () => {
    const { api, invoked } = loadPreload({ channels: handled, onInvoke: () => undefined });
    for (const method of collectMethods(api)) {
      if (method.path.startsWith('on.')) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await method.fn();
      } catch (_) {
        /* 参数不合法无所谓，这里只关心它调用了哪个通道 */
      }
    }
    const used = new Set(invoked.map((item) => item.channel));

    const notRegistered = [...used].filter((channel) => !handled.has(channel));
    assert(notRegistered.length === 0, `界面调用了主进程没注册的通道: ${notRegistered.join(', ')}`);

    const neverUsed = [...handled].filter((channel) => !used.has(channel));
    assert(neverUsed.length === 0, `主进程注册了但界面从不调用的通道: ${neverUsed.join(', ')}`);

    assert(used.size >= 30, `实际用到的通道偏少（${used.size} 个），可能漏了方法`);
  });

  await test('渲染层订阅的每个事件都真的会被主进程发送', async () => {
    const { api, listeners } = loadPreload({});
    assert(Object.keys(api.on).length >= 15, `订阅事件太少（${Object.keys(api.on).length} 个）`);
    // 逐个订阅一次，收集它们真正监听的通道名
    for (const fn of Object.values(api.on)) fn(() => {});
    const missing = [...listeners.keys()].filter((channel) => !sent.has(channel));
    assert(missing.length === 0, `这些事件界面订阅了但主进程从不发送: ${missing.join(', ')}`);
  });

  await test('每个订阅方法都返回可用于取消订阅的函数', async () => {
    const { api } = loadPreload({});
    for (const [name, fn] of Object.entries(api.on)) {
      const off = fn(() => {});
      assert(typeof off === 'function', `on.${name} 没有返回取消订阅函数（组件卸载时会泄漏监听）`);
    }
  });

  await test('事件回调能收到主进程发来的 payload', async () => {
    const { api, listeners } = loadPreload({});
    const got = [];
    api.on.reply((payload) => got.push(payload));
    const handler = listeners.get('ai:reply');
    assert(handler, '没有注册 ai:reply 监听');
    // 模拟主进程发送（Electron 会带上 event 作为第一个参数）
    handler({ sender: 'main' }, { text: '你好', emotion: 'happy' });
    assert(got.length === 1, '回调没有被调用');
    assert(got[0].text === '你好', 'payload 没有透传');
  });

  await test('invoke 的返回值能透传给渲染层', async () => {
    const { api } = loadPreload({
      channels: handled,
      onInvoke: (channel) => (channel === 'copilot:status' ? { queueLength: 7 } : undefined)
    });
    const status = await api.copilot.status();
    assert(status && status.queueLength === 7, `invoke 返回值没有透传: ${JSON.stringify(status)}`);
  });

  await test('参数会原样传给主进程', async () => {
    const { api, invoked } = loadPreload({ channels: handled, onInvoke: () => undefined });
    await api.settings.update({ danmaku: { roomId: '123' } });
    const call = invoked.find((item) => item.channel === 'settings:update');
    assert(call, '没有调用 settings:update');
    assert(call.args[0].danmaku.roomId === '123', `参数没有透传: ${JSON.stringify(call.args)}`);
  });

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
})();
