'use strict';

/**
 * B 站账号登录
 *
 * 做法：在软件里打开官方登录页（login.bilibili.com，支持扫码/密码/短信），
 * 用户在真实的 B 站页面上完成登录，程序轮询该会话的 Cookie，
 * 拿到 SESSDATA 等凭据后校验并保存到本地配置。
 *
 * 安全说明：
 *  - 凭据只保存在本机 data/settings.json，不会外发；
 *  - 只用于「以登录身份连接弹幕服务器」（能看到观众昵称），不会用于发言、点赞等任何写操作；
 *  - 程序从不自动发送弹幕。
 */

const { BrowserWindow, session } = require('electron');

const PARTITION = 'persist:bili-login';
const LOGIN_URL = 'https://passport.bilibili.com/login';
const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const LOGIN_COOKIE_KEYS = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4'
];

function getLoginSession() {
  return session.fromPartition(PARTITION);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 读取登录会话里的 B 站 Cookie */
async function readCookies() {
  const ses = getLoginSession();
  const domains = ['https://www.bilibili.com', 'https://passport.bilibili.com', 'https://live.bilibili.com'];
  const collected = {};
  for (const url of domains) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const list = await ses.cookies.get({ url });
      for (const cookie of list) {
        if (!cookie || !cookie.name) continue;
        if (cookie.value) collected[cookie.name] = cookie.value;
      }
    } catch (_) {
      /* ignore */
    }
  }
  return collected;
}

/** 用给定 Cookie 调 nav 接口，拿到登录状态和昵称 */
async function fetchAccountInfo(cookies) {
  const cookieHeader = Object.entries(cookies)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(NAV_URL, {
      headers: {
        'User-Agent': UA,
        Referer: 'https://www.bilibili.com/',
        Accept: 'application/json',
        Cookie: cookieHeader
      },
      signal: controller.signal
    });
    const data = await response.json();
    if (data.code === 0 && data.data && data.data.isLogin) {
      return {
        ok: true,
        userName: String(data.data.uname || ''),
        userUid: String(data.data.mid || ''),
        avatar: String(data.data.face || '')
      };
    }
    return { ok: false, message: data.message || `code=${data.code}` };
  } catch (error) {
    return { ok: false, message: error.name === 'AbortError' ? '校验超时' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 把登录会话里的 Cookie 拼成请求用字符串 */
function cookieHeaderFrom(cookies) {
  return Object.entries(cookies || {})
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

class BiliLogin {
  /**
   * @param {{store:object, logger:object, onChanged?:Function}} options
   */
  constructor({ store, logger, onChanged }) {
    this.store = store;
    this.logger = logger;
    this.onChanged = onChanged || (() => {});
    this.window = null;
    this.polling = false;
  }

  status() {
    const account = this.store.get().account || {};
    return {
      loggedIn: Boolean(account.loggedIn && account.sessdata),
      userName: account.userName || '',
      userUid: account.userUid || '',
      avatar: account.avatar || '',
      loginAt: account.loginAt || 0,
      windowOpen: Boolean(this.window && !this.window.isDestroyed())
    };
  }

  /** 当前可用于连接弹幕的 Cookie（已登录返回登录 Cookie，否则返回手动填写的） */
  currentCookies() {
    const settings = this.store.get();
    const account = settings.account || {};
    if (account.loggedIn && account.sessdata) {
      const cookies = { SESSDATA: account.sessdata };
      if (account.biliJct) cookies.bili_jct = account.biliJct;
      if (account.dedeUserId) cookies.DedeUserID = account.dedeUserId;
      if (account.buvid3) cookies.buvid3 = account.buvid3;
      return cookies;
    }
    return null;
  }

  currentCookieHeader() {
    const cookies = this.currentCookies();
    if (cookies) return cookieHeaderFrom(cookies);
    const manual = String((this.store.get().danmaku || {}).sessdata || '').trim();
    if (!manual) return '';
    if (!manual.includes('=')) return `SESSDATA=${manual}`;
    return manual;
  }

  /** 打开登录窗口并等待登录完成 */
  async open() {
    if (this.window && !this.window.isDestroyed()) {
      this.window.focus();
      return this.status();
    }
    const ses = getLoginSession();
    ses.setUserAgent(UA);

    this.window = new BrowserWindow({
      width: 480,
      height: 700,
      title: '登录 B 站账号（仅用于读取弹幕，不会发言）',
      parent: undefined,
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        // 让官方登录页正常工作的最小必要设置
        webSecurity: true
      }
    });

    this.window.on('closed', () => {
      this.window = null;
      this.polling = false;
      this.onChanged(this.status());
    });

    this.window.loadURL(LOGIN_URL);
    this.logger.info('已打开 B 站登录窗口');
    this.pollCredentials();
    return this.status();
  }

  /** 轮询登录结果 */
  async pollCredentials() {
    if (this.polling) return;
    this.polling = true;
    const startedAt = Date.now();
    const timeoutMs = 5 * 60 * 1000;

    while (this.polling && Date.now() - startedAt < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(1200);
      if (!this.window || this.window.isDestroyed()) break;
      // eslint-disable-next-line no-await-in-loop
      const cookies = await readCookies();
      if (!cookies.SESSDATA) continue;

      // eslint-disable-next-line no-await-in-loop
      const info = await fetchAccountInfo(cookies);
      if (!info.ok) {
        this.logger.warn(`Cookie 校验未通过：${info.message}`);
        continue;
      }

      const account = {
        loggedIn: true,
        sessdata: cookies.SESSDATA || '',
        biliJct: cookies.bili_jct || '',
        dedeUserId: cookies.DedeUserID || '',
        buvid3: cookies.buvid3 || '',
        userName: info.userName,
        userUid: info.userUid,
        avatar: info.avatar,
        loginAt: Date.now()
      };
      this.store.patch({ account });
      this.logger.info(`B 站账号登录成功：${info.userName}（uid ${info.userUid}）`);
      this.polling = false;
      if (this.window && !this.window.isDestroyed()) this.window.close();
      this.window = null;
      this.onChanged(this.status());
      return;
    }
    this.polling = false;
  }

  /** 退出登录：清掉保存的凭据和登录会话 */
  async logout() {
    this.polling = false;
    this.store.patch({
      account: {
        loggedIn: false,
        sessdata: '',
        biliJct: '',
        dedeUserId: '',
        buvid3: '',
        userName: '',
        userUid: '',
        avatar: '',
        loginAt: 0
      }
    });
    try {
      await getLoginSession().clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage', 'serviceworkers']
      });
    } catch (error) {
      this.logger.warn(`清理登录会话失败: ${error.message}`);
    }
    this.logger.info('已退出 B 站账号');
    this.onChanged(this.status());
    return this.status();
  }

  /** 用已保存的凭据校验一次，返回账号信息 */
  async verify() {
    const cookies = this.currentCookies();
    if (!cookies) return { ok: false, message: '还没有登录' };
    const info = await fetchAccountInfo(cookies);
    if (info.ok) return { ok: true, ...info };
    return { ok: false, message: info.message || '校验失败' };
  }

  /** 手动填写的 Cookie 也校验一下（用于「手填 Cookie」入口） */
  async verifyManual(text) {
    const raw = String(text || '').trim();
    if (!raw) return { ok: false, message: '请先粘贴 Cookie' };
    const cookies = {};
    if (!raw.includes('=')) cookies.SESSDATA = raw;
    else {
      for (const part of raw.split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
      }
    }
    const info = await fetchAccountInfo(cookies);
    if (!info.ok) return { ok: false, message: info.message || 'Cookie 无效或已过期' };
    return { ok: true, ...info, cookies };
  }
}

module.exports = { BiliLogin, LOGIN_COOKIE_KEYS, getLoginSession, cookieHeaderFrom };
