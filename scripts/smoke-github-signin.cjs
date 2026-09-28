'use strict';
// npm run build && npx electron scripts/smoke-github-signin.cjs
// Real hidden Electron + Stage + loopback callback. Remote GitHub is a local fixture.
const { app, BrowserWindow, shell, session } = require('electron');
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
const visited = [];
shell.openExternal = async url => { opened.push(url); };
let origin, challenge;
const firstRepo = { id: 2, full_name: 'test-user/example', pushed_at: '2026-01-01', private: true };
let repositories = [firstRepo], repoError = false, holdRepos = false, releaseRepos;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  visited.push(url.href);
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
  if (url.pathname === '/user/installations/1/repositories') {
    if (holdRepos) await new Promise(resolve => { releaseRepos = resolve; });
    if (repoError) { res.statusCode = 503; return json({ message: 'Repository service unavailable' }); }
    return json({ repositories });
  }
  if (url.pathname.endsWith('/installations/new') || url.pathname === '/repository') { res.setHeader('content-type', 'text/html'); res.end('<h1>GitHub fixture</h1>'); return; }
  res.statusCode = 404; res.end();
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_TOOLS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1', ENGELBART_GITHUB_BROKER: origin, ENGELBART_GITHUB_WEB: origin });
  require('../src/main/index.cjs');
  await app.whenReady();
  await session.fromPartition('persist:browser').protocol.handle('https', () => new Response('<title>Repository fixture</title><h1>Repository fixture</h1>', { headers: { 'content-type': 'text/html' } }));
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.webContents.setBackgroundThrottling(false);
    let returned = 0;
    win.show = () => { returned++; }; win.focus = () => {};
    await until(() => js(win.webContents, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'ready');
    const made = await js(win.webContents, `window.engelbartAPI.createProjectWithWelcome({name:'GitHub smoke',directory:${JSON.stringify(root)}})`);
    const originalIds = await js(win.webContents, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())');
    win.webContents.reload();
    await until(() => js(win.webContents, '!!document.querySelector("[data-rail-add]")').catch(() => false), 'workspace');
    await js(win.webContents, 'document.querySelector("[data-rail-add] > button").click()');
    await until(() => js(win.webContents, '!!document.querySelector("[data-add-github]")'), 'GitHub menu');
    await js(win.webContents, 'document.querySelector("[data-add-github]").click()');
    await until(() => js(win.webContents, '!!document.querySelector("[data-github-waiting]")'), 'waiting in app');
    const starts = () => visited.filter(url => new URL(url).pathname === '/api/github/start');
    await until(() => starts().length === 1, 'sign-in loaded in Stage');
    assert.equal(opened.length, 0);
    assert.equal(await js(win.webContents, 'document.querySelector("[data-stage]").style.display!=="none"'), true);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(win.isVisible(), false);
    assert.equal(await js(win.webContents, '!!document.querySelector("[data-github-code], [data-github-paste]")'), false);
    // Cancel the first attempt, then retry from the same menu.
    await js(win.webContents, 'document.querySelector("[data-github-cancel]").click()');
    await until(() => js(win.webContents, '!!document.querySelector("[data-github-signin]")'), 'cancelled');
    await js(win.webContents, 'document.querySelector("[data-github-signin]").click()');
    await until(() => starts().length === 2, 'second Stage sign-in');
    const count = await js(win.webContents, 'document.querySelectorAll("[data-stage-tab]").length');
    await js(win.webContents, 'document.querySelector("[data-github-window]").click()');
    await pause(150);
    assert.equal(starts().length, 2, 'reopen keeps the same attempt without reloading');
    assert.equal(await js(win.webContents, 'document.querySelectorAll("[data-stage-tab]").length'), count);
    const authorize = new URL(starts()[1]);
    const callback = new URL(`http://127.0.0.1:${authorize.searchParams.get('port')}/oauth/github/callback`);
    callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), code: 'one-time-code', ticket: 'test-ticket' });
    const signIn = win.contentView.children.find(view => view.webContents?.getURL() === authorize.href).webContents;
    await signIn.loadURL(callback.href);
    await until(() => js(win.webContents, `!!document.querySelector('[data-github-repo="test-user/example"]')`), 'authorized repository picker');
    assert.equal(returned, 1, 'successful auth returns focus to Engelbart');
    await js(win.webContents, 'document.querySelector("[data-github-install]").click()');
    await until(() => win.contentView.children.some(view => view.webContents?.getURL().endsWith('/installations/new')), 'repository permissions open in Stage');
    assert.deepEqual(opened, [], 'no personal-browser handoff');

    // The connected-account subsection browses live GitHub metadata without library imports or builds.
    const wc = win.webContents;
    const click = selector => js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
    const row = '[data-github-account-repo="test-user/example"]';
    await until(() => js(wc, `!!document.querySelector('${row}')`), 'account repositories in sidebar');
    assert.equal(await js(wc, `!!document.querySelector('[data-rail-section="GitHub"] ${row}')`), true);
    assert.equal(await js(wc, `!!document.querySelector('${row} [aria-label="Private repository"]')`), true);
    await js(wc, 'document.querySelector("[data-editor]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true}))');
    await until(() => js(wc, '!document.querySelector("[data-github-pane]")'), 'picker dismissed');
    await click('[data-right-mode="terminal"]');
    await click(row);
    await until(() => win.contentView.children.some(view => view.webContents?.getURL() === 'https://github.com/test-user/example'), 'repository opens in Stage');
    assert.equal(await js(wc, 'document.querySelector("[data-stage]").style.display!=="none"'), true);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), originalIds);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.sandboxRuns()'), [], 'browsing creates no sandbox run');

    await click('[data-github-account-toggle]');
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-github-account-toggle]")').catch(() => false), 'signed-in account after reload');
    assert.equal(await js(wc, 'document.querySelector("[data-github-account-toggle]").getAttribute("aria-expanded")'), 'false');
    assert.equal(await js(wc, '!!document.querySelector("[data-github-account-repo]")'), false);
    await click('[data-github-account-toggle]');
    await until(() => js(wc, `!!document.querySelector('${row}')`), 'reopening restores catalog');
    const second = await js(wc, `window.engelbartAPI.createWorkspace(${JSON.stringify(made.project.id)},{name:'Second workspace'})`);
    await js(wc, `window.engelbartAPI.setLastOpen({projectId:${JSON.stringify(made.project.id)},workspaceId:${JSON.stringify(second.id)}})`);
    wc.reload();
    await until(() => js(wc, `document.querySelector('[data-workspace-name]')?.textContent==='Second workspace'&&!!document.querySelector('${row}')`).catch(() => false), 'account catalog in another workspace');

    const refresh = () => click('[data-github-account-refresh]');
    await until(() => js(wc, '!document.querySelector("[data-github-account-refresh]").disabled'), 'initial repository load finished');
    repoError = true; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-github-account] [role=alert]")?.textContent.includes("Repository service unavailable")'), 'repository error shown');
    repoError = false; repositories = []; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-github-account] [role=status]")?.textContent.includes("No repositories shared")'), 'empty access list');
    assert.equal(await js(wc, '!!document.querySelector("[data-github-account-manage]")'), true);
    await click('[data-github-account-manage]');
    await until(() => win.contentView.children.some(view => view.webContents?.getURL().endsWith('/installations/new')), 'sidebar access management');
    repositories = [firstRepo, ...Array.from({ length: 10 }, (_, i) => ({ id: i + 3, full_name: `test-org/project-${i}`, pushed_at: '2026-01-01', private: false }))];
    await refresh();
    await until(() => js(wc, 'document.querySelectorAll("[data-github-account-repo]").length===11'), 'full account catalog');
    await js(wc, `(()=>{const field=document.querySelector('[aria-label="Search your repositories"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'project-9');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => js(wc, 'document.querySelectorAll("[data-github-account-repo]").length===1'), 'repository search');
    assert.equal(await js(wc, 'document.querySelector("[data-github-account-repo]").dataset.githubAccountRepo'), 'test-org/project-9');
    await js(wc, `(()=>{const field=document.querySelector('[aria-label="Search your repositories"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'');field.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => js(wc, 'document.querySelectorAll("[data-github-account-repo]").length===11'), 'cleared repository search');
    const shot = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    fs.writeFileSync(path.join(root, 'connected.png'), shot.toPNG());
    holdRepos = true; await refresh();
    await until(() => releaseRepos, 'in-flight repository request');
    await js(wc, 'window.engelbartAPI.githubDisconnect()');
    await until(() => js(wc, '!document.querySelector("[data-github-account]")'), 'sign-out removes account catalog');
    releaseRepos(); await pause(150);
    assert.equal(await js(wc, '!!document.querySelector("[data-github-account]")'), false, 'late response cannot restore signed-out repos');
    assert.equal(await js(wc, '!!document.querySelector("[data-rail-section=GitHub]")'), true, 'GitHub heading remains');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), originalIds);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.sandboxRuns()'), [], 'catalog load, navigation, reload and refresh never build');
    await js(win.webContents, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
    console.log(JSON.stringify({ ok: true, screenshot: path.join(root, 'connected.png'), checks: ['Stage sign-in', 'no code entry', 'cancel/retry/reopen', 'PKCE callback from Stage', 'automatic app return', 'repository picker', 'account management in Stage', 'sidebar account catalog', 'private and organization repos', 'browse without importing or building', 'reload and workspace switching', 'collapse persistence', 'search', 'empty/error/retry', 'sign-out during fetch', 'no external browser'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Fixture:', root);
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})();
