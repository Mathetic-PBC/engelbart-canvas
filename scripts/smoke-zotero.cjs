'use strict';
// Full app + native Stage + sandboxed preload against disposable Zotero-shaped
// pages. No live credentials, accounts, or library writes.
const { app, BrowserWindow, shell, session, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { PARTITION } = require('../src/main/browser/views.cjs');
const { createZoteroBrowser } = require('../src/main/zotero/browser-connection.cjs');
const { createZoteroReader } = require('../src/main/zotero/browser-reader.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-zotero-ui-'));
let origin, mode = 'normal', user = '1234', count = 3, pendingResponse, phase = 'startup';
const requests = [], external = [];
shell.openExternal = async url => external.push(url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (wc, code) => wc.executeJavaScript(code, true);
async function until(check, label) {
  phase = label;
  for (let i = 0; i < 220; i++) { if (await check()) return; await pause(50); }
  throw new Error(`Timed out: ${label}`);
}
const click = async (wc, selector) => {
  await until(() => js(wc, `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`), selector);
  return js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin); requests.push(url.pathname + url.search);
  res.setHeader('Content-Type', 'text/html');
  if (url.pathname === '/favicon.ico') { res.statusCode = 404; return res.end(); }
  if (url.pathname === '/user/login') return res.end('<input id="username"><button id="sign-in">Sign in to fixture Zotero</button><script>document.querySelector("button").onclick=async()=>{await fetch("/session");location.href="/mylibrary"}</script>');
  if (url.pathname === '/session') { res.setHeader('Set-Cookie', 'zotero-session=fixture; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/'); return res.end('ok'); }
  if (url.pathname.startsWith('/users/')) {
    res.setHeader('Content-Type', 'application/json');
    assert.equal(req.method, 'GET'); assert.equal(req.headers['zotero-api-key'], 'fixtureZoteroKey123456789');
    assert.equal(url.searchParams.get('sort'), 'dateAdded'); assert.equal(url.searchParams.get('direction'), 'desc');
    assert.equal(url.searchParams.has('key'), false);
    if (mode === 'pending') { pendingResponse = () => res.end('[]'); return; }
    if (mode === 'error') { res.statusCode = 503; return res.end('{}'); }
    if (mode === 'expired') { res.statusCode = 403; return res.end('{}'); }
    const start = Number(url.searchParams.get('start'));
    const rows = Array.from({ length: count }, (_, i) => ({ key: `P${String(i).padStart(7, '0')}`, data: { title: i ? `Research paper ${i}` : 'Understanding how people learn with AI', itemType: 'journalArticle', creators: [{ firstName: 'Ada', lastName: 'Researcher' }], date: '2026', dateAdded: new Date(Date.now() - i * 1000).toISOString() } }));
    // Child notes/attachments cannot turn into duplicate papers in the sidebar.
    rows.push({ key: 'NOTE0000', data: { title: 'Private note', itemType: 'note' } });
    res.setHeader('Total-Results', rows.length); res.setHeader('Last-Modified-Version', '1');
    if (start + 100 < rows.length) res.setHeader('Link', `<${origin}/users/${user}/items/top?start=${start + 100}>; rel="next"`);
    return res.end(JSON.stringify(rows.slice(start, start + 100)));
  }
  if (url.pathname === '/mylibrary') {
    if (!req.headers.cookie?.includes('zotero-session=fixture')) { res.statusCode = 302; res.setHeader('Location', '/user/login'); return res.end(); }
    const config = { userId: user, userSlug: user === '1234' ? 'researcher' : 'other-reader', apiKey: 'fixtureZoteroKey123456789' };
    return res.end(`<h1>My Library</h1><script type="application/json" id="zotero-web-library-config">${JSON.stringify(config)}</script>`);
  }
  res.statusCode = 404; res.end();
});
setTimeout(() => { console.error('Stalled:', phase, root); app.exit(1); }, 60000).unref();
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_BART_FAKE: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_ZOTERO_TEST_ORIGIN: origin });
  require('../src/main/index.cjs'); await app.whenReady();
  let win;
  try {
    await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('engelbart:')); return !!win; }, 'main window');
    win.setFocusable(false); win.setSize(1420, 860); win.showInactive(); win.show = () => {}; win.focus = () => {};
    const wc = win.webContents; wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const project = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Zotero research',directory:${JSON.stringify(root)}})`);
    const second = await js(wc, `window.engelbartAPI.createWorkspace(${JSON.stringify(project.project.id)},{name:'Another workspace',parentId:${JSON.stringify(project.workspaceId)}})`);
    wc.reload();
    const entry = '[data-rail-connections] button', action = name => `[data-zotero-action="${name}"]`;
    const browse = async () => {
      if (await js(wc, '!!document.querySelector("[data-connections-panel]")')) await click(wc, '[aria-label="Close connections"]');
      if (!await js(wc, '!!document.querySelector("[data-source-browser=zotero]")')) await click(wc, '[data-browse-source=zotero]');
    };
    const refresh = async () => {
      if (!await js(wc, '!!document.querySelector("[data-connections-panel]")')) await click(wc, entry);
      await click(wc, '[data-zotero-actions]'); await click(wc, action('retry')); await browse();
    };
    const paperCount = () => js(wc, 'document.querySelectorAll("[data-zotero-paper]").length');
    const pages = () => win.contentView.children.map(v => v.webContents).filter(p => p && !p.isDestroyed());
    const screenshot = async name => fs.writeFileSync(path.join(root, `${name}.png`), (await win.capturePage()).toPNG());
    await until(() => js(wc, `!!document.querySelector('${entry}')`).catch(() => false), 'sidebar');
    await click(wc, '[data-rail-section-toggle=Papers]');
    const before = await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())');
    await click(wc, entry); await click(wc, action('connect'));
    let login;
    await until(() => { login = pages().find(p => p.getURL() === `${origin}/user/login`); return !!login; }, 'sign-in in Stage');
    await until(() => js(login, '!!document.querySelector("#username")').catch(() => false), 'login form');
    await js(login, 'document.querySelector("#username").value="reader"');
    await click(wc, action('reopen'));
    assert.equal(pages().filter(p => p.getURL() === `${origin}/user/login`).length, 1);
    assert.equal(await js(login, 'document.querySelector("#username").value'), 'reader');
    await click(wc, action('cancel'));
    assert.equal(await js(wc, 'window.engelbartAPI.zoteroStatus().then(s=>s.connected)'), false);
    await click(wc, action('connect'));
    await until(() => { login = pages().find(p => p.getURL() === `${origin}/user/login`); return !!login; }, 'reconnect sign-in');
    mode = 'error'; await click(login, '#sign-in');
    await until(() => js(wc, `!!document.querySelector('${action('retry')}')`), 'initial error offers retry');
    assert.equal(await js(wc, 'document.querySelector("[data-connection=zotero]").textContent.includes("Waiting for Zotero")'), false);
    await screenshot('retry');
    mode = 'normal'; await click(wc, action('retry')); await browse();
    await until(async () => await paperCount() === 3, 'papers populate after Stage sign-in');
    const stagePage = pages().find(p => p.getURL() === `${origin}/mylibrary`);
    assert.equal(await js(stagePage, 'typeof window.engelbartAPI'), 'undefined');
    assert.equal(await js(stagePage, 'typeof require'), 'undefined');
    assert.equal(await js(stagePage, 'document.cookie.includes("zotero-session")'), false);
    const cache = path.join(root, '.engelbart/zotero-browser.json');
    assert.doesNotMatch(fs.readFileSync(cache, 'utf8'), /researcher|Understanding|fixtureZoteroKey/);
    await screenshot('connected');
    await click(wc, entry); await click(wc, '[data-zotero-actions]');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-zotero-actions-menu] button")].map(e=>e.textContent)'), ['Open Zotero', 'Refresh papers', 'Disconnect']);
    // Refreshed papers are available the next time Browse is opened.
    count = 135; await click(wc, action('retry')); await browse();
    await until(async () => await paperCount() === 135, 'all pages load and connection refresh updates sidebar');
    assert.ok(requests.some(url => url.includes('start=100')));
    assert.equal(await js(wc, '!!document.querySelector("[data-source-browser=zotero] [data-zotero-paper]")'), true, 'Zotero papers are listed under Papers');
    assert.equal(await js(wc, '!!document.querySelector("[data-zotero-refresh]") || document.querySelector("[data-zotero-account]").textContent.includes("Recently added")'), false, 'Zotero list has no recently-added caption or refresh control');
    await screenshot('paper-list');
    await js(wc, `(()=>{const e=document.querySelector('[aria-label="Search Zotero"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'paper 134');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await until(async () => await paperCount() === 1, 'paper search');
    await js(wc, `(()=>{const e=document.querySelector('[aria-label="Search Zotero"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    let opened;
    const send = wc.send.bind(wc);
    wc.send = (channel, payload) => { if (channel === 'browser:open-tab' && payload.url.startsWith('https://www.zotero.org/')) { opened = payload.url; return; } return send(channel, payload); };
    await click(wc, '[data-zotero-paper="P0000000"]');
    await until(() => !!opened, 'paper opens in Stage');
    assert.equal(opened, 'https://www.zotero.org/researcher/items/P0000000/library');
    assert.equal(stagePage.getURL(), `${origin}/mylibrary`, 'refresh leaves visible Stage pages unchanged');
    await click(wc, '[data-rail-section-toggle=Workspaces]');
    await click(wc, `[data-rail-row="${second.id}"]`);
    await until(() => js(wc, 'document.querySelector("[data-workspace-header]")?.textContent.includes("Another workspace")'), 'workspace switch');
    await browse();
    await until(async () => await paperCount() === 135, 'papers remain across workspaces');
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-rail-section-toggle=Papers]")').catch(() => false), 'sidebar after reload');
    assert.equal(await js(wc, 'document.querySelector("[data-rail-section-toggle=Papers]").getAttribute("aria-expanded")'), 'false');
    await click(wc, '[data-rail-section-toggle=Papers]');
    await browse();
    await until(async () => await paperCount() === 135, 'papers restored when Browse is opened after reload');
    const crypt = { available: () => safeStorage.isEncryptionAvailable(), encrypt: s => safeStorage.encryptString(s).toString('base64'), decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')) };
    const restored = createZoteroBrowser({ file: cache, crypt, openStage: () => {}, reader: createZoteroReader({ BrowserWindow, getSession: () => session.fromPartition(PARTITION), origin, pollMs: 50 }) });
    assert.equal(restored.status().account.id, '1234'); assert.equal((await restored.papers(true)).papers.length, 135); restored.close();
    count = 0; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-zotero-account]")?.textContent.includes("No papers")'), 'empty library');
    count = 3; user = '5678'; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-zotero-account]")?.dataset.zoteroAccount === "5678"'), 'account switch');
    await until(async () => await paperCount() === 3, 'new account papers');
    mode = 'expired'; await refresh();
    await until(() => js(wc, 'window.engelbartAPI.zoteroStatus().then(s=>!s.connected)'), 'expired sign-in');
    assert.equal(await paperCount(), 0, 'expired sign-in clears papers');
    mode = 'normal'; await click(wc, entry); await click(wc, action('connect'));
    await until(() => js(wc, 'window.engelbartAPI.zoteroStatus().then(s=>s.connected)'), 'existing Stage session reconnects');
    await browse();
    await until(async () => await paperCount() === 3, 'reconnect');
    win.setSize(1000, 650); await pause(150); await click(wc, entry);
    assert.equal(await js(wc, '(()=>{const r=document.querySelector("[data-connections-panel]").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), true);
    await screenshot('compact');
    mode = 'pending'; await refresh();
    await until(() => !!pendingResponse, 'pending refresh');
    await click(wc, entry); await click(wc, '[data-zotero-actions]'); await click(wc, action('disconnect')); pendingResponse(); await pause(150);
    assert.equal(await paperCount(), 0); assert.equal(fs.existsSync(cache), false);
    assert.ok((await session.fromPartition(PARTITION).cookies.get({ url: origin })).some(c => c.name === 'zotero-session'));
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), before);
    assert.deepEqual(external, []);
    await js(wc, 'window.terminalAPI.bootstrap().then(state=>Promise.all(state.sessions.map(s=>window.terminalAPI.closeSession(s.id))))');
    console.log(JSON.stringify({ ok: true, root, checks: ['Stage sign-in and tab reuse', 'failure and retry', 'isolated preload', 'encrypted cache restoration', '135 papers over multiple pages', 'search', 'open paper in Stage', 'refresh from menu', 'workspace switch and reload', 'empty library', 'account switching', 'expired session', 'disconnect cancels in-flight reads', 'Stage cookies retained', 'no automatic library imports'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})();
