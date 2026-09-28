'use strict';
// Disposable full app with a local Overleaf-shaped site; no real account,
// project edits, external browser, or network dependencies.
const { app, BrowserWindow, shell, session, safeStorage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { readPage } = require('../src/main/browser/page-reader.cjs');
const { createOverleafBrowser } = require('../src/main/overleaf/browser-connection.cjs');
const { createOverleafReader } = require('../src/main/overleaf/browser-reader.cjs');
const { PARTITION } = require('../src/main/browser/views.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-overleaf-ui-'));
const external = [], requests = [];
let phase = 'startup';
setTimeout(() => { console.error(`Smoke test stalled: ${phase}`); console.error('Artifacts:', root); app.exit(1); }, 60000).unref();
shell.openExternal = async url => { external.push(url); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async (wc, code) => {
  phase = code.slice(0, 180);
  try { return await (wc.getURL().startsWith('engelbart:') ? wc : wc.mainFrame).executeJavaScript(code, true); }
  catch (error) { console.error('Fixture expression:', code); throw error; }
};
async function until(check, label) { for (let n = 0; n < 220; n++) { if (await check()) return; await pause(60); } throw new Error(`Timed out: ${label}`); }
const click = async (wc, selector) => {
  await until(() => js(wc, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.disabled})()`), `enabled control: ${selector}`);
  return js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
};
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const projectId = n => n.toString(16).padStart(24, '0');
let origin, mode = 'normal', email = 'reader@example.com', accountId = 'a'.repeat(24), pendingResponse;
const catalog = () => Array.from({ length: 36 }, (_, i) => ({
  id: projectId(i + 1), name: i === 0 ? 'Research notes' : `Project ${i}`,
  lastUpdated: new Date(Date.UTC(2020, 0, i + 1)).toISOString(),
  archived: i === 0, trashed: i === 35, accessLevel: i % 2 ? 'readOnly' : 'owner',
  owner: { email: 'collaborator@example.com' }, lastUpdatedBy: { email: 'collaborator@example.com' },
}));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin); requests.push(url.pathname);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/favicon.ico') { res.statusCode = 404; return res.end(); }
  if (url.pathname === '/preload') { res.write('<html><body>Loading'); return; }
  if (url.pathname === '/session') {
    res.setHeader('set-cookie', 'overleaf-session=fixture; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/'); return res.end('ok');
  }
  if (url.pathname === '/login') return res.end('<button id="sign-in">Sign in to fixture Overleaf</button><script>document.querySelector("button").onclick=async()=>{await fetch("/session");location.href="/project"}</script>');
  if (url.pathname !== '/project') { res.statusCode = 404; return res.end('Missing'); }
  if (!req.headers.cookie?.includes('overleaf-session=fixture')) {
    res.statusCode = 302; res.setHeader('location', '/login'); return res.end();
  }
  if (mode === 'pending') { pendingResponse = () => res.end('<p>Late response</p>'); return; }
  const projects = mode === 'empty' ? [] : catalog();
  const blob = { totalSize: projects.length + (mode === 'partial' ? 10 : 0), projects };
  res.end(`<meta name="ol-user_id" content="${accountId}"><meta name="ol-usersEmail" content="${escape(email)}">
    ${mode === 'unknown' ? '' : `<meta name="ol-prefetchedProjectsBlob" data-type="json" content="${escape(JSON.stringify(blob))}">`}
    <h1>All projects</h1><table aria-label="Projects list"><tbody>${projects.slice(0, 20).map(p => `<tr><td><a href="/project/${p.id}">${p.name}</a></td></tr>`).join('')}</tbody></table>
    <p>Showing ${Math.min(20, projects.length)} out of ${projects.length} projects.</p><iframe src="/preload" hidden></iframe>`);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_BART_FAKE: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_OVERLEAF_TEST_ORIGIN: origin });
  require('../src/main/index.cjs'); await app.whenReady();
  let win;
  try {
    await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('engelbart:')); return !!win; }, 'main window');
    win.setFocusable(false); win.setSize(1420, 860); win.showInactive(); win.show = () => {}; win.focus = () => {};
    const wc = win.webContents; wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Overleaf research',directory:${JSON.stringify(root)}})`);
    const second = await js(wc, `window.engelbartAPI.createWorkspace(${JSON.stringify(made.project.id)},{name:'Second workspace',parentId:${JSON.stringify(made.workspaceId)}})`);
    wc.reload();
    const entry = '[data-rail-connections] button', action = name => `[data-overleaf-action="${name}"]`;
    const browse = async () => {
      if (await js(wc, '!!document.querySelector("[data-connections-panel]")')) await click(wc, '[aria-label="Close connections"]');
      if (!await js(wc, '!!document.querySelector("[data-source-browser=overleaf]")')) await click(wc, '[data-browse-source=overleaf]');
    };
    const refresh = async () => {
      await click(wc, entry); await click(wc, '[data-overleaf-actions]');
      await click(wc, action('retry')); await click(wc, '[aria-label="Close connections"]'); await browse();
    };
    const count = () => js(wc, 'document.querySelectorAll("[data-overleaf-project]").length');
    const shot = async name => fs.writeFileSync(path.join(root, `${name}.png`), (await win.capturePage()).toPNG());
    const stage = () => win.contentView.children.map(v => v.webContents).filter(c => c && !c.isDestroyed());
    await until(() => js(wc, `!!document.querySelector('${entry}')`).catch(() => false), 'Connections');
    await click(wc, '[data-rail-section-toggle=Overleaf]');
    const ids = await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())');
    await click(wc, entry);
    await until(() => js(wc, `!!document.querySelector('${action('connect')}')&&!document.querySelector('${action('connect')}').disabled`), 'Overleaf ready without setup');
    assert.equal(requests.length, 0, 'no Overleaf reads before Connect');
    await click(wc, action('connect'));
    let login;
    await until(() => { login = stage().find(c => c.getURL() === `${origin}/login`); return !!login; }, 'sign-in in Stage');
    const loginId = login.id;
    await click(wc, action('reopen'));
    assert.equal(stage().filter(c => c.getURL() === `${origin}/login`).length, 1);
    assert.equal(stage().find(c => c.getURL() === `${origin}/login`).id, loginId, 'sign-in tab is reused');
    await click(wc, action('cancel'));
    assert.equal(await js(wc, 'window.engelbartAPI.overleafStatus().then(s=>s.connected)'), false);
    await click(wc, action('connect'));
    await until(() => { login = stage().find(c => c.getURL() === `${origin}/login`); return !!login; }, 'sign-in reopened');
    await click(wc, '[aria-label="Close connections"]');
    mode = 'unknown'; await click(login, '#sign-in'); await click(wc, entry);
    await until(() => js(wc, `!!document.querySelector('${action('retry')}')`), 'initial timeout offers Retry');
    await until(() => js(wc, '(()=>{const r=document.querySelector("[data-connections-panel]").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), 'error panel fits');
    await shot('initial-retry');
    mode = 'normal'; login.reload(); await click(wc, action('retry'));
    await click(wc, '[aria-label="Close connections"]'); await browse();
    await until(async () => await count() === 35, 'all projects beyond first 20, archived included, trash excluded');
    assert.equal(await js(wc, 'document.querySelector("[data-overleaf-project]").textContent'), 'Project 34', 'most recently updated first');
    await shot('connected');
    const page = stage().find(c => c.getURL() === `${origin}/project`);
    assert.equal(await js(page, 'document.cookie.includes("overleaf-session")'), false, 'HttpOnly cookie stays hidden');
    assert.equal(await js(page, 'typeof require === "undefined" && typeof window.engelbartAPI === "undefined"'), true, 'no Node/Canvas API exposed');
    const snapshot = await readPage(page, 'all', false, origin, { provider: 'overleaf' });
    assert.equal(snapshot.kind, 'ready'); assert.equal(snapshot.projects.length, 35);
    assert.equal(page.isLoading(), true, 'unfinished subframe does not block extraction');
    assert.doesNotMatch(JSON.stringify(snapshot), /collaborator|lastUpdatedBy|accessLevel/);
    const cache = path.join(root, '.engelbart/overleaf-browser.json');
    assert.doesNotMatch(fs.readFileSync(cache, 'utf8'), /reader@example|Research notes|overleaf-session/);
    const crypt = { available: () => true, encrypt: s => safeStorage.encryptString(s).toString('base64'), decrypt: s => safeStorage.decryptString(Buffer.from(s, 'base64')) };
    const restored = createOverleafBrowser({ file: cache, crypt, openStage: () => {}, reader: createOverleafReader({ BrowserWindow, getSession: () => session.fromPartition(PARTITION), origin, pollMs: 70 }) });
    assert.equal(restored.status().account.email, email);
    assert.equal((await restored.projects()).projects.length, 35);
    assert.equal((await restored.projects(true)).projects.length, 35); restored.close();
    assert.equal(await js(wc, '!!document.querySelector("[data-source-browser=overleaf] [data-overleaf-project] [data-document-provider=overleaf]")'), true, 'Overleaf projects appear with their provider icon under Overleaf');
    await click(wc, '[data-rail-section-toggle=Overleaf]'); wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-rail-section-toggle=Overleaf]")').catch(() => false), 'restored sidebar');
    assert.equal(await js(wc, 'document.querySelector("[data-rail-section-toggle=Overleaf]").getAttribute("aria-expanded")'), 'false');
    await click(wc, '[data-rail-section-toggle=Overleaf]'); await browse(); await until(async () => await count() === 35, 'metadata after reload');
    await click(wc, '[data-rail-section-toggle=Workspaces]');
    await click(wc, `[data-rail-row="${second.id}"]`);
    await until(() => js(wc, 'document.querySelector("[data-workspace-header]")?.textContent.includes("Second workspace")'), 'workspace switch');
    await browse();
    await until(async () => await count() === 35, 'projects across workspaces');
    assert.equal(await js(wc, `!!document.querySelector('[aria-label="Search Overleaf projects"], [data-overleaf-refresh]')`), false);
    assert.equal(await js(wc, 'document.querySelector("[data-overleaf-account]").textContent.includes("Recently updated")'), false);
    mode = 'partial'; await refresh();
    await until(() => js(wc, '!!document.querySelector("[data-overleaf-account] [role=alert]")'), 'partial catalog is an error');
    assert.equal(await count(), 35, 'temporary errors retain previous projects');
    mode = 'empty'; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-overleaf-account]")?.textContent.includes("No Overleaf projects yet")'), 'confirmed empty catalog clears links');
    await click(wc, entry); await click(wc, '[data-overleaf-actions]');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-overleaf-actions-menu] button")].map(e=>e.textContent)'), ['Open Overleaf', 'Refresh projects', 'Disconnect']);
    mode = 'normal'; await click(wc, action('retry'));
    await click(wc, '[aria-label="Close connections"]'); await browse();
    await until(async () => await count() === 35, 'menu refresh updates sidebar immediately for same account');
    accountId = 'b'.repeat(24); email = 'other@example.com'; await refresh();
    await until(() => js(wc, `document.querySelector('[data-overleaf-account]')?.dataset.overleafAccount === '${accountId}'`), 'account change');
    await until(async () => await count() === 35, 'new account catalog');
    let opened;
    const send = wc.send.bind(wc);
    wc.send = (channel, payload) => {
      if (channel === 'browser:open-tab' && payload.url.startsWith('https://www.overleaf.com/project/')) { opened = payload.url; return; }
      return send(channel, payload);
    };
    await click(wc, `[data-overleaf-project="${projectId(1)}"]`); await until(() => !!opened, 'project opens in Stage');
    assert.equal(opened, `https://www.overleaf.com/project/${projectId(1)}`);
    win.setSize(960, 650); await pause(180); await click(wc, entry); await pause(100);
    await click(wc, '[data-overleaf-actions]'); await shot('compact-options');
    await js(wc, 'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js(wc, '!document.querySelector("[data-overleaf-actions-menu]") && !!document.querySelector("[data-connections-panel]")'), 'Escape closes options only');
    await click(wc, '[aria-label="Close connections"]');
    mode = 'pending'; await refresh(); await until(() => !!pendingResponse, 'pending read');
    await click(wc, entry); await click(wc, '[data-overleaf-actions]'); await click(wc, action('disconnect')); pendingResponse(); await pause(150);
    assert.equal(await count(), 0); assert.equal(fs.existsSync(cache), false);
    assert.ok((await session.fromPartition(PARTITION).cookies.get({ url: origin })).some(c => c.name === 'overleaf-session'), 'disconnect preserves Stage sign-in');
    mode = 'normal'; await click(wc, action('connect'));
    await until(() => js(wc, 'window.engelbartAPI.overleafStatus().then(s=>s.connected)'), 'existing Stage session reconnects');
    await session.fromPartition(PARTITION).clearStorageData({ storages: ['cookies'] });
    await click(wc, '[aria-label="Close connections"]'); await refresh();
    await until(() => js(wc, 'window.engelbartAPI.overleafStatus().then(s=>!s.connected)'), 'expired sign-in clears catalog');
    assert.equal(await count(), 0);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), ids);
    assert.equal(await js(wc, `window.engelbartAPI.sandboxRuns(${JSON.stringify(made.project.id)}).then(r=>r.length)`), 0);
    assert.deepEqual(external, []); assert.ok(!requests.some(p => /token|oauth|api\//.test(p)));
    console.log(JSON.stringify({ ok: true, root, checks: ['explicit Stage sign-in', 'cancel/reopen/tab reuse', 'initial timeout/retry', 'full catalog beyond rendered rows', 'all ages/shared/archived, excluding trash', 'newest first', 'minimal metadata', 'isolated preload', 'shared HttpOnly session', 'unfinished subframe', 'encrypted cache restoration', 'workspace/reload persistence', 'plain project list', 'partial failure preserves cache', 'empty state', 'menu refresh updates sidebar', 'account changes', 'Stage links', 'compact options', 'disconnect race and cookie preservation', 'expired login', 'no external browser, imports or builds'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})().catch(error => { console.error(error); app.exit(1); });
