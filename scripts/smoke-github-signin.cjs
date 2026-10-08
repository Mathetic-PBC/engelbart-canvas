'use strict';
// npm run build && npx electron scripts/smoke-github-signin.cjs
// Real hidden Electron + loopback callback. Only the OS browser launch and remote GitHub are fixtures.
const { app, BrowserWindow, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash } = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-github-ui-'));
const pause = (ms = 50) => new Promise(r => setTimeout(r, ms));
const js = (contents, source) => contents.executeJavaScript(source, true);
async function until(check, label) {
  for (let i = 0; i < 240; i++) { const value = await check(); if (value) return value; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const opened = [];
shell.openExternal = async url => { opened.push(url); };
let origin, challenge;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
  if (url.pathname === '/api/github/start') {
    challenge = url.searchParams.get('challenge');
    res.setHeader('content-type', 'text/html');
    res.end('<h1>Authorize Engelbart</h1>'); return;
  }
  if (url.pathname === '/api/github/token') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(createHash('sha256').update(body.verifier).digest('base64url'), challenge);
    return json({ access_token: 'ghu_test', refresh_token: 'ghr_test', expires_in: 28800 });
  }
  if (url.pathname === '/user') return json({ login: 'test-user', id: 42 });
  if (url.pathname === '/user/installations') return json({ installations: [{ id: 1, account: { login: 'test-user' } }] });
  if (url.pathname === '/user/installations/1/repositories') return json({ repositories: [{ id: 2, full_name: 'test-user/example', pushed_at: '2026-01-01', private: true }] });
  res.statusCode = 404; res.end();
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_TOOLS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1', ENGELBART_GITHUB_BROKER: origin, ENGELBART_GITHUB_WEB: origin });
  require('../src/main/index.cjs');
  await app.whenReady();
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.webContents.setBackgroundThrottling(false);
    let returned = 0;
    win.show = () => { returned++; }; win.focus = () => {};
    await until(() => js(win.webContents, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'ready');
    await js(win.webContents, `window.engelbartAPI.createProjectWithWelcome({name:'GitHub smoke',directory:${JSON.stringify(root)}})`);
    win.webContents.reload();
    await until(() => js(win.webContents, '!!document.querySelector("[data-sb-fixed-row=add]")').catch(() => false), 'workspace');
    await js(win.webContents, 'document.querySelector("[data-sb-fixed-row=add]").click()'); // the sidebar's Add sources
    await until(() => js(win.webContents, '!!document.querySelector("[data-add-github]")'), 'GitHub menu');
    await js(win.webContents, 'document.querySelector("[data-add-github]").click()');
    await until(() => js(win.webContents, '!!document.querySelector("[data-github-waiting]")'), 'waiting in app');
    assert.equal(opened.length, 1);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(win.isVisible(), false);
    assert.equal(await js(win.webContents, '!!document.querySelector("[data-github-code], [data-github-paste]")'), false);
    // Cancel the first attempt, then retry from the same menu.
    await js(win.webContents, 'document.querySelector("[data-github-cancel]").click()');
    await until(() => js(win.webContents, '!!document.querySelector("[data-github-signin]")'), 'cancelled');
    await js(win.webContents, 'document.querySelector("[data-github-signin]").click()');
    await until(() => opened.length === 2, 'second browser request');
    await js(win.webContents, 'document.querySelector("[data-github-window]").click()');
    await until(() => opened.length === 3, 'reopen browser');
    assert.equal(opened[1], opened[2], 'reopen keeps the same attempt');
    const authorize = new URL(opened[1]);
    await fetch(authorize); // simulate the external browser reaching the service
    const callback = new URL(`http://127.0.0.1:${authorize.searchParams.get('port')}/oauth/github/callback`);
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'one-time-code', ticket: 'test-ticket' });
    const response = await fetch(callback);
    assert.equal(response.status, 200);
    await until(() => js(win.webContents, `!!document.querySelector('[data-github-repo="test-user/example"]')`), 'authorized repository picker');
    assert.equal(returned, 1, 'successful auth returns focus to Engelbart');
    await js(win.webContents, 'document.querySelector("[data-github-install]").click()');
    await until(() => opened.some(url => url.endsWith('/installations/new')), 'repository permissions use browser');
    await js(win.webContents, 'window.engelbartAPI.browserOpen("github-test", "https://github.com/test-user/example")');
    assert.equal(opened.at(-1), 'https://github.com/test-user/example');
    assert.ok(!win.contentView.children.some(v => v.webContents?.getURL().includes('github.com')));
    const shot = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    fs.writeFileSync(path.join(root, 'connected.png'), shot.toPNG());
    await js(win.webContents, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
    console.log(JSON.stringify({ ok: true, screenshot: path.join(root, 'connected.png'), checks: ['external browser handoff', 'no code entry', 'cancel/retry/reopen', 'PKCE callback', 'automatic app return', 'repository picker', 'external install and website navigation'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Fixture:', root);
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})();
