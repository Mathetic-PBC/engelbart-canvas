'use strict';

const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const PAGE_CHECK = `(() => {
  if (!document.body || !/html/i.test(document.contentType)) return {ok:false, reason:'Not an HTML interface'};
  const text = document.body.innerText.trim();
  const error = document.querySelector('vite-error-overlay') || /(?:failed to compile|build error|internal server error|application error: a client-side exception)/i.test(text.slice(0,2000));
  if (error) return {ok:false, reason:'The page is showing a build/runtime error'};
  const visible = element => {
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  };
  const elements = [...document.body.querySelectorAll('h1,h2,h3,p,button,input,textarea,select,a,nav,main,section,img,svg,canvas,[role=button]')];
  const content = elements.some(el => visible(el) && (el.textContent.trim() || /^(INPUT|TEXTAREA|SELECT|IMG|SVG|CANVAS)$/i.test(el.tagName)));
  const onlyRaw = document.body.children.length === 1 && /^(PRE|SCRIPT)$/i.test(document.body.firstElementChild?.tagName || '');
  return {ok:content && !onlyRaw, reason:onlyRaw ? 'The server returned raw data, not an interface' : 'The page has no visible interface yet', title:document.title.slice(0,200)};
})()`;

function createBrowserVerifier({ BrowserWindow }) {
  return async function verify(url, { signal, timeoutMs = 12_000 } = {}) {
    const origin = new URL(url).origin;
    const win = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: `local-preview-check-${randomUUID()}` } });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    wc.session.setPermissionCheckHandler(() => false);
    const navigation = (event, target) => { if (new URL(target).origin !== origin) event.preventDefault(); };
    wc.on('will-navigate', navigation);
    wc.on('will-redirect', navigation);
    let timer;
    const destroy = () => { if (!win.isDestroyed()) win.destroy(); };
    const abort = () => destroy();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new Error('Stopped.');
      const check = async () => {
        await wc.loadURL(url);
        let good = 0, reason = 'The interface did not render.';
        const until = Date.now() + timeoutMs;
        while (Date.now() < until && !signal?.aborted) {
          if (new URL(wc.getURL()).origin !== origin) throw new Error('The app redirected away from its local preview.');
          const result = await wc.executeJavaScript(PAGE_CHECK);
          reason = result.reason;
          good = result.ok ? good + 1 : 0;
          if (good >= 2) return { title: result.title };
          await delay(250, undefined, { signal });
        }
        throw new Error(reason);
      };
      return await Promise.race([check(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The local page did not render a working interface in time.')), timeoutMs); })]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); destroy(); }
  };
}

module.exports = { createBrowserVerifier, PAGE_CHECK };
