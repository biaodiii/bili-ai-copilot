'use strict';

/**
 * 界面错误上报：放在所有界面脚本之前加载。
 *
 * 为什么需要它：如果界面脚本在初始化中途抛错，后面的按钮监听器就全都绑不上，
 * 表现是「界面能打开、hover 有动画，但点什么都没反应」——而错误只躺在 DevTools 里，
 * 普通使用者看不到。这个脚本会把错误直接显示在页面上，同时写进
 * data/renderer-error.log，方便一次性把问题发出来。
 */
(function bootstrapErrorReporter() {
  if (typeof window === 'undefined' || window.__errorReporterInstalled) return;
  window.__errorReporterInstalled = true;

  const label = document.title || '界面';

  function report(kind, message, extra = {}) {
    const payload = {
      label,
      kind,
      message: String(message || '（无描述）'),
      source: extra.source || '',
      line: extra.line || 0,
      column: extra.column || 0,
      stack: extra.stack || ''
    };
    showBanner(payload);
    try {
      if (window.api && window.api.debug && window.api.debug.report) {
        window.api.debug.report(payload);
      }
    } catch (_) {
      /* 上报失败就算了，界面上已经显示了 */
    }
  }

  function showBanner(payload) {
    try {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => showBanner(payload));
        return;
      }
      let banner = document.getElementById('__errorBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = '__errorBanner';
        banner.style.cssText = [
          'position:fixed',
          'left:0',
          'right:0',
          'top:0',
          'z-index:2147483647',
          'background:#7f1d1d',
          'color:#fff',
          'font:13px/1.6 "Microsoft YaHei",sans-serif',
          'padding:10px 14px',
          'max-height:45vh',
          'overflow:auto',
          'box-shadow:0 6px 20px rgba(0,0,0,.45)',
          'pointer-events:auto',
          'white-space:pre-wrap'
        ].join(';');
        const title = document.createElement('div');
        title.style.cssText = 'font-weight:700;margin-bottom:4px';
        title.textContent = '界面出错了（把这段发给开发者即可定位）';
        const body = document.createElement('div');
        body.id = '__errorBannerBody';
        const close = document.createElement('button');
        close.textContent = '知道了';
        close.style.cssText =
          'margin-top:8px;padding:4px 12px;border-radius:6px;border:1px solid #fca5a5;background:#991b1b;color:#fff;cursor:pointer';
        close.addEventListener('click', () => banner.remove());
        banner.appendChild(title);
        banner.appendChild(body);
        banner.appendChild(close);
        (document.body || document.documentElement).appendChild(banner);
      }
      const body = document.getElementById('__errorBannerBody');
      const at = payload.source ? `　(${payload.source}:${payload.line})` : '';
      body.textContent += `${body.textContent ? '\n' : ''}· [${payload.kind}] ${payload.message}${at}`;
    } catch (_) {
      /* ignore */
    }
  }

  window.addEventListener('error', (event) => {
    // 资源加载失败（img/script）也会触发 error 事件，但没有 message
    if (event && event.message) {
      report('脚本错误', event.message, {
        source: event.filename,
        line: event.lineno,
        column: event.colno,
        stack: event.error && event.error.stack ? event.error.stack : ''
      });
    } else if (event && event.target && event.target.tagName) {
      report('资源加载失败', `${event.target.tagName} ${event.target.src || event.target.href || ''}`);
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    report('未处理的 Promise 拒绝', (reason && (reason.message || reason)) || '未知原因', {
      stack: reason && reason.stack ? reason.stack : ''
    });
  });

  // 供界面脚本手动上报（比如初始化分步打点）
  window.__reportUiError = (kind, message, extra) => report(kind, message, extra || {});
})();
