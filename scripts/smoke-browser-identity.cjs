'use strict';
// Local network regression for sign-in verification frames. No external sites,
// account credentials, or CAPTCHA interaction. --session-override reproduces the
// old setup for comparison and should fail if it sends conflicting identities.
const { app, BrowserWindow, session } = require('electron');
const { cleanUserAgent, installBrowserUserAgent } = require('../src/main/browser/user-agent.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const legacy = process.argv.includes('--session-override');
const expected = cleanUserAgent(app.userAgentFallback, app.getName());
if (!legacy) installBrowserUserAgent(app);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-browser-identity-')));
const requests = [];
let frameOrigin;
const probes = `
  async function probe(scope) {
    const values = [navigator.userAgent];
    await fetch('/probe/' + scope + '-fetch');
    await new Promise((resolve, reject) => { const xhr = new XMLHttpRequest(); xhr.open('GET', '/probe/' + scope + '-xhr'); xhr.onload = resolve; xhr.onerror = reject; xhr.send(); });
    await new Promise(resolve => { const image = new Image(); image.onload = image.onerror = resolve; image.src = '/probe/' + scope + '-image'; });
    values.push(await new Promise((resolve, reject) => { const worker = new Worker('/worker.js?scope=' + scope); worker.onmessage = e => { resolve(e.data); worker.terminate(); }; worker.onerror = reject; }));
    return values;
  }
`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  requests.push({ path: url.pathname + url.search, ua: req.headers['user-agent'] });
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/worker.js') {
    res.setHeader('Content-Type', 'application/javascript');
    return res.end(`fetch('/probe/${url.searchParams.get('scope')}-worker').then(() => postMessage(navigator.userAgent));`);
  }
  res.setHeader('Content-Type', 'text/html');
  if (url.pathname === '/') return res.end(`<!doctype html><script>${probes}
    window.frameResult = new Promise(resolve => addEventListener('message', e => { if (e.origin === ${JSON.stringify(frameOrigin)}) resolve(e.data); }));
    window.probeResult = Promise.all([probe('top'), window.frameResult]);
    </script><iframe src="${frameOrigin}/frame"></iframe>`);
  if (url.pathname === '/frame') return res.end(`<!doctype html><script>${probes}probe('frame').then(values => parent.postMessage(values, '*'));</script>`);
  res.end('ok');
});

setTimeout(() => { console.error('Browser identity smoke timed out', requests); app.exit(1); }, 20000).unref();
(async () => {
  try {
    await app.whenReady();
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;
    frameOrigin = `http://localhost:${port}`;
    const browsing = session.fromPartition('identity-fixture');
    if (legacy) browsing.setUserAgent(expected);
    const win = new BrowserWindow({ show: false, webPreferences: { session: browsing, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
    await win.loadURL(`http://127.0.0.1:${port}/`);
    const reported = (await win.webContents.executeJavaScript('window.probeResult')).flat();
    const required = ['/', '/frame', ...['top', 'frame'].flatMap(scope => ['fetch', 'xhr', 'image', 'worker'].map(type => `/probe/${scope}-${type}`))];
    for (const url of required) assert.ok(requests.some(r => r.path === url), `Missing request: ${url}`);
    const mismatches = requests.filter(r => r.ua !== expected);
    console.log(JSON.stringify({ mode: legacy ? 'old session override' : 'startup fallback', requests: requests.length, distinctNetworkIdentities: new Set(requests.map(r => r.ua)).size, mismatchedPaths: mismatches.map(r => r.path) }));
    assert.deepEqual(mismatches, [], 'Every actual HTTP request must carry the same browser identity');
    assert.equal(reported.length, 4, 'Top page, cross-origin frame, and both workers report their identities');
    for (const ua of reported) assert.equal(ua, expected, 'JavaScript and network identities agree');
    win.destroy();
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); server.closeAllConnections(); server.close(); app.exit(1);
  }
})();
