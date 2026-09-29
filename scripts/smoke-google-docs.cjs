'use strict';
// Disposable full-app check: real Stage cookies, DOM reader, IPC and renderer;
// local Drive-shaped pages only, no Google account or OAuth registration.
const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { readPage } = require('../src/main/google/page-reader.cjs');
const { createGoogleBrowser } = require('../src/main/google/browser-connection.cjs');
const { createDriveReader, searchUrl, dateWindow, queryFor } = require('../src/main/google/browser-reader.cjs');
const { PARTITION } = require('../src/main/browser/views.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-google-stage-ui-'));
require('node:child_process').execFileSync('git', ['init', '--quiet', root]);
const external = [], requests = [];
let phase = 'startup';
setTimeout(() => { console.error(`Smoke test stalled during: ${phase}`); console.error('Artifacts:', root); app.exit(1); }, 60000).unref();
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
let origin, mode = 'normal', email = 'reader@example.com', pendingResponse;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, origin); requests.push(url.pathname);
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/favicon.ico') { res.statusCode = 404; return res.end(); }
  // Drive's background preload frames can remain unfinished while the main
  // document has usable results. They must not block the metadata reader.
  if (url.pathname === '/preload') { res.write('<html><body>Loading'); return; }
  if (url.pathname === '/session') {
    res.setHeader('set-cookie', 'drive-session=fixture; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/'); return res.end('ok');
  }
  if (url.pathname === '/login') return res.end(`<button id="sign-in">Sign in to fixture Google</button><script>document.querySelector('button').onclick=async()=>{await fetch('/session');location.href=${JSON.stringify(url.searchParams.get('continue'))}}</script>`);
  if (!url.pathname.includes('/drive/')) { res.statusCode = 404; return res.end('Missing'); }
  if (!req.headers.cookie?.includes('drive-session=fixture')) {
    res.statusCode = 302; res.setHeader('location', `/login?continue=${encodeURIComponent(url.pathname + url.search)}`); return res.end();
  }
  if (mode === 'pending') { pendingResponse = () => res.end('<p>Late response</p>'); return; }
  const count = mode === 'many' ? 35 : 3;
  const rows = Array.from({ length: count }, (_, i) => `<div role="gridcell" data-id="fixture-doc-${String(i).padStart(4, '0')}" aria-label="${i ? `Document ${i}` : 'Recent research notes'} Google Docs More info (Option + →)" style="height:70px"><div data-tooltip="${i ? `Document ${i}` : 'Recent research notes'} Google Docs">${i ? `Document ${i}` : 'Recent research notes'}</div></div>`);
  // A cold Drive load turns the URL's operators into chips and clears the input.
  const common = `<a role="button" aria-label="Google Account: Reader (${escape(email)})">Account</a><input role="combobox" aria-label="Search in Drive" value=""><button>Documents filter applied</button><button>Last 7 days filter applied</button><div role="progressbar" aria-label="Storage used"></div>`;
  if (mode === 'empty') return res.end(`${common}<main><h2>No results found</h2></main>`);
  if (mode === 'unknown') return res.end(`${common}<main>Google changed its markup</main>`);
  const word = '<div role="gridcell" data-id="word-file-12345" aria-label="A Word document Microsoft Word More info"><div data-tooltip="A Word document Microsoft Word">A Word document</div></div>';
  res.end(`${common}<div id="scroll" style="height:310px;overflow:auto"><div role="grid" id="grid">${rows.slice(0, 6).join('')}${mode === 'normal' ? word : ''}</div></div><script>
  const all=${JSON.stringify(rows)}, grid=document.querySelector('#grid'), scroller=document.querySelector('#scroll');let loaded=6;
  scroller.addEventListener('scroll',()=>{if(scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-5&&loaded<all.length){grid.insertAdjacentHTML('beforeend',all.slice(loaded,loaded+6).join(''));loaded+=6}});
  </script><iframe src="/preload" hidden></iframe>`);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  app.setPath('userData', path.join(root, 'electron'));
  Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_BART_FAKE: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_GOOGLE_TEST_ORIGIN: origin });
  require('../src/main/index.cjs'); await app.whenReady();
  let win;
  try {
    await until(() => { win = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('engelbart:')); return !!win; }, 'main window');
    win.setFocusable(false); win.setSize(1420, 860); win.showInactive();
    win.show = () => {}; win.focus = () => {};
    const wc = win.webContents; wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Google Docs research',directory:${JSON.stringify(root)}})`);
    const second = await js(wc, `window.engelbartAPI.createWorkspace(${JSON.stringify(made.project.id)},{name:'Second workspace',parentId:${JSON.stringify(made.workspaceId)}})`);
    wc.reload();
    const entry = '[data-rail-connections] button', action = name => `[data-google-action="${name}"]`;
    const browse = async () => {
      if (await js(wc, '!!document.querySelector("[data-connections-panel]")')) await click(wc, '[aria-label="Close connections"]');
      if (!await js(wc, '!!document.querySelector("[data-projects-list=google]")')) await click(wc, '[data-projects-toggle=google]');
    };
    const refresh = async () => {
      await click(wc, entry); await click(wc, '[data-google-actions]');
      await click(wc, action('retry')); await click(wc, '[aria-label="Close connections"]'); await browse();
    };
    const count = () => js(wc, 'document.querySelectorAll("[data-google-doc]").length');
    const shot = async name => fs.writeFileSync(path.join(root, `${name}.png`), (await win.capturePage()).toPNG());
    const stage = () => win.contentView.children.map(v => v.webContents).filter(c => c && !c.isDestroyed());
    await until(() => js(wc, `!!document.querySelector('${entry}')`).catch(() => false), 'Connections');
    await click(wc, '[data-rail-section-toggle=Documents]');
    const ids = await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())');
    await click(wc, entry);
    await until(() => js(wc, `!!document.querySelector('${action('connect')}')&&!document.querySelector('${action('connect')}').disabled`), 'Google ready without setup');
    assert.equal(requests.length, 0, 'opening Connections does not read Google');
    await click(wc, action('connect'));
    let login;
    await until(() => { login = stage().find(c => c.getURL().startsWith(`${origin}/login`)); return !!login; }, 'sign-in appears in Stage');
    const loginId = login.id;
    await click(wc, action('reopen'));
    assert.equal(stage().filter(c => c.getURL().startsWith(`${origin}/login`)).length, 1, 'pending tab is reused');
    assert.equal(stage().find(c => c.getURL().startsWith(`${origin}/login`)).id, loginId);
    await click(wc, action('cancel'));
    assert.equal(await js(wc, 'window.engelbartAPI.googleStatus().then(s=>s.connected)'), false);
    await click(wc, action('connect'));
    await until(() => { login = stage().find(c => c.getURL().startsWith(`${origin}/login`)); return !!login; }, 'sign-in reopened');
    await click(wc, '[aria-label="Close connections"]');
    mode = 'unknown';
    await click(login, '#sign-in');
    await click(wc, entry);
    await until(() => js(wc, 'document.querySelector("[data-connection=google-docs]")?.textContent.includes("Connecting…")'), 'connection progress stays inline while documents load');
    await until(() => js(wc, `!!document.querySelector('${action('retry')}')`), 'failed initial listing has a visible retry');
    assert.equal(await js(wc, 'document.querySelector("[data-connection=google-docs]").textContent.includes("Waiting for Google")'), false);
    assert.equal(await js(wc, `document.querySelector('${action('reopen')}').getAttribute('aria-label')`), 'Open Google Docs sign-in in Stage');
    await until(() => js(wc, '(()=>{const r=document.querySelector("[data-connections-panel]").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), 'retry panel stays within the viewport after growing');
    await shot('initial-retry');
    mode = 'normal'; login.reload();
    await click(wc, action('retry'));
    await click(wc, '[aria-label="Close connections"]'); await browse();
    await until(async () => await count() === 3, 'Docs populate after browser sign-in; Word excluded');
    await shot('connected');
    assert.equal(await js(wc, '!!document.querySelector("[data-google-refresh]")'), false);
    assert.equal(await js(wc, 'document.querySelector("[data-google-account]").textContent.includes("Modified in the past 7 days")'), false);
    const drivePage = stage().find(c => c.getURL().includes('/drive/'));
    const beforeUrl = drivePage.getURL();
    assert.equal(await js(drivePage, 'document.cookie.includes("drive-session")'), false, 'HttpOnly cookie is never exposed to page script');
    assert.equal(await js(drivePage, 'typeof require === "undefined" && typeof window.engelbartAPI === "undefined"'), true, 'preload exposes no Node or Canvas API to Drive');
    const cache = path.join(root, '.engelbart/google-browser.json');
    assert.doesNotMatch(fs.readFileSync(cache, 'utf8'), /reader@example|Recent research|drive-session/);
    assert.equal(await js(wc, 'window.engelbartAPI.googleStatus().then(s=>s.method)'), 'stage');
    // Verify both grid and list-shaped rows with the real isolated DOM reader.
    const list = await readPage(drivePage, queryFor(dateWindow()), false, origin);
    assert.equal(list.kind, 'ready'); assert.equal(list.documents.length, 3);
    assert.equal(await js(drivePage, 'document.querySelector("input").value'), '', 'Drive converts search text to filters');
    assert.equal(drivePage.isLoading(), true, 'unfinished preload does not block listing extraction');
    assert.equal((await readPage(drivePage, 'type:document after:1999-01-01', false, origin)).kind, 'loading', 'different URL query is never read');
    await js(drivePage, 'document.querySelectorAll("[role=gridcell]").forEach(e=>e.setAttribute("role","row"))');
    assert.equal((await readPage(drivePage, queryFor(dateWindow()), false, origin)).documents.length, 3);
    assert.equal(await js(wc, '!!document.querySelector("[data-projects-list=google] [data-google-doc] [data-document-provider=google-docs]")'), true, 'Google Docs appear with their provider icon under Documents');
    await click(wc, '[data-rail-section-toggle=Documents]'); wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-rail-section-toggle=Documents]")').catch(() => false), 'restored sidebar');
    assert.equal(await js(wc, 'document.querySelector("[data-rail-section-toggle=Documents]").getAttribute("aria-expanded")'), 'false');
    await click(wc, '[data-rail-section-toggle=Documents]'); await browse();
    await until(async () => await count() === 3, 'metadata after renderer reload');
    await click(wc, '[aria-label="Switch workspace"]');
    await click(wc, `[data-workspace-item="${second.id}"]`);
    await until(() => js(wc, 'document.querySelector("[data-workspace-header]")?.textContent.includes("Second workspace")'), 'workspace switch');
    await browse();
    await until(async () => await count() === 3, 'Docs across workspaces');
    // A new controller + reader restores encrypted metadata and uses the same
    // persistent browser session, without any account-token file or registration.
    const crypt = { available: () => true, encrypt: s => require('electron').safeStorage.encryptString(s).toString('base64'), decrypt: s => require('electron').safeStorage.decryptString(Buffer.from(s, 'base64')) };
    const restored = createGoogleBrowser({ file: cache, crypt, openStage: () => {}, reader: createDriveReader({ BrowserWindow, getSession: () => session.fromPartition(PARTITION), origin, pollMs: 70 }) });
    assert.equal(restored.status().account.email, email);
    assert.equal((await restored.documents(true)).documents.length, 3); restored.close();
    mode = 'many'; await refresh();
    await until(async () => await count() === 35, 'scrolling loads all virtualized batches');
    assert.ok(stage().every(c => c.getURL() === beforeUrl || !c.getURL().includes('/drive/')), 'refresh never navigates visible Stage pages');
    await js(wc, `(()=>{const e=document.querySelector('[aria-label="Search Google Docs"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Document 34');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await until(async () => await count() === 1, 'search');
    await js(wc, `(()=>{const e=document.querySelector('[aria-label="Search Google Docs"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    mode = 'empty'; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-google-account]")?.textContent.includes("No Google Docs modified")'), 'explicit empty state');
    mode = 'unknown'; await refresh();
    await until(() => js(wc, '!!document.querySelector("[data-google-account] [role=alert]")'), 'unrecognized page yields an error, not empty success');
    mode = 'normal'; email = 'other@example.com'; await refresh();
    await until(() => js(wc, 'document.querySelector("[data-google-account]")?.dataset.googleAccount === "other@example.com"'), 'account change');
    await until(async () => await count() === 3, 'new account list');
    // Capture real browser-open event without making an internet request to Docs.
    let opened;
    const send = win.webContents.send.bind(win.webContents);
    win.webContents.send = (channel, payload) => {
      if (channel === 'browser:open-tab' && payload.url.startsWith('https://docs.google.com/')) { opened = payload.url; return; }
      return send(channel, payload);
    };
    await click(wc, '[data-google-doc="fixture-doc-0000"]');
    await until(() => !!opened, 'document opens in Stage');
    assert.equal(new URL(opened).searchParams.get('authuser'), email);
    assert.equal(new URL(opened).pathname, '/document/d/fixture-doc-0000/edit');
    win.setSize(960, 650); await pause(180); await click(wc, entry); await pause(100);
    assert.equal(await js(wc, '(()=>{const r=document.querySelector("[data-connections-panel]").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()'), true);
    assert.equal(await js(wc, 'document.querySelector("[data-connection=google-docs]").textContent.includes("Uses your Google sign-in")'), false);
    assert.equal(await js(wc, '!!document.querySelector("[data-google-action=reopen], [data-google-action=disconnect]")'), false, 'connected actions stay in the options menu');
    await shot('compact');
    await click(wc, '[data-google-actions]');
    await until(() => js(wc, 'document.activeElement?.dataset.googleAction === "reopen"'), 'Google options focus first action');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-google-actions-menu] button")].map(button=>button.textContent)'), ['Open Google Drive', 'Refresh documents', 'Disconnect']);
    await shot('google-options');
    await js(wc, 'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => js(wc, '!document.querySelector("[data-google-actions-menu]") && !!document.querySelector("[data-connections-panel]")'), 'Escape closes only Google options');
    await click(wc, '[aria-label="Close connections"]');
    mode = 'pending'; await refresh();
    await until(() => !!pendingResponse, 'pending refresh');
    await click(wc, entry); await click(wc, '[data-google-actions]'); await click(wc, action('disconnect')); pendingResponse(); await pause(180);
    assert.equal(await count(), 0); assert.equal(fs.existsSync(cache), false);
    const cookies = await session.fromPartition(PARTITION).cookies.get({ url: origin });
    assert.ok(cookies.some(cookie => cookie.name === 'drive-session'), 'disconnect leaves Stage sign-in alone');
    mode = 'normal'; await click(wc, action('connect'));
    await until(() => js(wc, 'window.engelbartAPI.googleStatus().then(s=>s.connected)'), 'existing Stage session reconnects');
    await session.fromPartition(PARTITION).clearStorageData({ storages: ['cookies'] });
    await click(wc, '[aria-label="Close connections"]'); await refresh();
    await until(() => js(wc, 'window.engelbartAPI.googleStatus().then(s=>!s.connected)'), 'expired browser session clears catalog');
    assert.equal(await count(), 0);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), ids);
    assert.equal(await js(wc, `window.engelbartAPI.sandboxRuns(${JSON.stringify(made.project.id)}).then(r=>r.length)`), 0);
    assert.deepEqual(external, []); assert.ok(!requests.some(p => /token|oauth|api\//.test(p)));
    console.log(JSON.stringify({ ok: true, root, checks: ['no setup or OAuth', 'Stage sign-in and tab reuse', 'initial timeout and visible retry', 'filter chips with empty search input', 'unfinished preload frames', 'narrow isolated preload without page APIs', 'shared HttpOnly browser session', 'grid/list DOM extraction', 'Word files excluded', 'scrolling and search', 'encrypted cache restoration', 'workspace/reload persistence', 'empty/layout-error/retry', 'account switching', 'Stage document opening', 'compact and growing error panel', 'disconnect race and cookie preservation', 'expired login clears links', 'no external browser, imports, content extraction or builds'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})().catch(error => { console.error(error); app.exit(1); });
