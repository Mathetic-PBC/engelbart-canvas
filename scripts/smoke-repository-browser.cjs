'use strict';
// Real Canvas/IPC/Stage with a local account catalog and disposable app data.
// No real GitHub account, imports, credentials, or sandbox activity.
const { app, BrowserWindow, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-repository-browser-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_BART_FAKE: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off' });
const external = [];
shell.openExternal = async url => external.push(url);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async (wc, code) => {
  try { return await wc.executeJavaScript(code, true); }
  catch (error) { console.error('Fixture expression:', code); throw error; }
};
async function until(check, label) {
  for (let n = 0; n < 150; n++) { const result = await check(); if (result) return result; await pause(80); }
  throw Error(`Timed out: ${label}`);
}
let origin, reads = 0, launches = 0, mode = 'normal', connected = true;
let announce;
const names = ['engelbart-canvas', 'berkeley-research', 'berkeley-research-tools', 'landing', 'engelbart-litellm', 'engelbart', 'research-notes', 'examples', 'reference'];
const catalog = () => names.map((name, i) => ({ id: String(i + 1), owner: 'Mathetic-PBC', fullName: `Mathetic-PBC/${name}`, private: i % 3 !== 1, description: i === 6 ? 'Collected reading' : '', url: `${origin}/repos/${i + 1}` }));
const status = () => ({ configured: true, connected, login: connected ? 'researcher' : '', pending: null, persisted: true, error: '', installUrl: `${origin}/installations/new` });
require('../src/main/github/connection.cjs').createGithub = options => {
  announce = () => options.onChange(status());
  return { status, authHeaders: async () => ({}), repos: async () => {
    reads++; await pause(80);
    if (mode === 'error') throw Error('Repository catalog unavailable.');
    return { repos: mode === 'empty' ? [] : catalog(), accounts: [] };
  }, disconnect: () => { connected = false; announce(); return status(); }, connect: () => { throw Error('Unexpected sign-in'); }, cancel: status };
};
const manager = require('../src/main/sandbox/manager.cjs'), originalManager = manager.createSandboxManager;
manager.createSandboxManager = options => originalManager({ ...options, readEnv: () => ({}), launch(request, _env, emit) {
  if (request.command !== 'probe') { launches++; throw Error('Unexpected sandbox launch'); }
  return { done: Promise.resolve().then(() => emit({ event: 'result', state: 'ready' })) };
} });
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Repository fixture</title><h1>Repository fixture</h1>'); });

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  require('../src/main/index.cjs');
  await app.whenReady();
  let win;
  try {
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1420, 860); win.showInactive();
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Repository browser review',directory:${JSON.stringify(root)}})`);
    const config = await js(wc, 'window.engelbartAPI.config()');
    const libraryDb = await require('../src/main/store/db.cjs').openLibraryDb(config.dataRoot);
    const ctx = { homeDir: root, root: config.home, dataRoot: config.dataRoot, libraryDb };
    const saved = [];
    for (const name of ['mqo00/rope', 'kfjeng/cocoa-canvas', 'mqo00/hypocompass']) {
      const row = await libraryDb.insert({ id: randomUUID(), name, type: 'website', tags: ['git'], url: `https://github.com/${name}` });
      saved.push(row);
      // These represent already-running workspace context, not fresh imports.
      // Their readiness checks are local stubs; no real sandbox is contacted.
      await libraryDb.query("insert into sandbox_runs (id,library_id,status,preview_url) values ($1,$2,'ready',$3)", [randomUUID(), row.id, `https://${row.id}.fixture.e2b.app/`]);
    }
    await require('../src/main/store/projects.cjs').linkToWorkspace(ctx, made.project.id, made.workspaceId, saved.map(row => row.id));
    wc.reload();
    const click = async selector => {
      await until(() => js(wc, `(()=>{const element=document.querySelector(${JSON.stringify(selector)});return !!element&&!element.disabled})()`), `enabled control: ${selector}`);
      return js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const exists = selector => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
    const toggle = '[data-browse-source=github]', panel = '[data-source-browser=github]', connections = '[data-rail-connections] button';
    const shot = async name => fs.writeFileSync(path.join(root, `${name}.png`), (await win.capturePage()).toPNG());
    const loaded = () => until(() => exists('[data-github-account-repo]'), 'catalog loaded');
    const closed = () => until(async () => !await exists(panel), 'browser closes');
    const escape = () => js(wc, 'document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    const input = text => js(wc, `(()=>{const e=document.querySelector('[aria-label="Search repositories"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
    await until(() => exists('[data-rail-section-toggle=GitHub]').catch(() => false), 'sidebar');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-rail-section-toggle]")].every(e=>e.getAttribute("aria-expanded")==="false")'), true);
    assert.equal(reads, 0, 'initial closed groups never request the repository catalog');
    const originalIds = await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())');
    const originalRuns = await js(wc, 'window.engelbartAPI.sandboxRuns()');
    await shot('all-collapsed');
    await click('[data-rail-section-toggle=GitHub]');
    for (const row of saved) assert.equal(await exists(`[data-rail-row="${row.id}"]`), true, 'saved repositories appear directly under GitHub');
    assert.equal(await exists('[data-rail-subsection]'), false);
    assert.equal(await js(wc, `document.querySelector('${toggle}').textContent`), 'Browse repositories…');
    assert.equal(reads, 0, 'opening GitHub does not fetch the account catalog');
    await shot('flat-repositories');
    const width = await js(wc, 'document.querySelector("[data-stage]").getBoundingClientRect().width');
    await click(toggle); await loaded();
    assert.equal(await js(wc, 'document.querySelector("[data-github-repo-name]").textContent'), 'engelbart-canvas');
    assert.equal(await js(wc, 'document.querySelector("[data-github-repo-owner]").textContent'), 'Mathetic-PBC');
    assert.equal(await js(wc, 'document.querySelector("[data-stage]").getBoundingClientRect().width'), width);
    await input('Collected reading');
    await until(() => js(wc, 'document.querySelectorAll("[data-github-account-repo]").length===1'), 'description search');
    await js(wc, 'document.querySelector("[data-source-browser] input").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    assert.equal(await js(wc, 'document.activeElement.dataset.githubAccountRepo'), 'Mathetic-PBC/research-notes');
    await escape(); await closed();
    assert.equal(await js(wc, 'document.activeElement.dataset.browseSource'), 'github');
    const beforeClosed = reads;
    await js(wc, 'window.dispatchEvent(new Event("focus"))'); await pause(120);
    assert.equal(reads, beforeClosed, 'closed browser does not fetch');
    await click(toggle); await loaded(); await shot('browse-repositories');
    await click('[data-github-account-repo="Mathetic-PBC/berkeley-research"]');
    await until(() => win.contentView.children.some(view => view.webContents?.getURL() === `${origin}/repos/2`), 'repository opens in Stage');
    await closed();
    await click(toggle); await loaded(); await click(connections);
    await until(() => exists('[data-connections-panel]'), 'Connections opens'); await closed();
    mode = 'empty'; const beforeRefresh = reads;
    await click('[data-github-actions]'); await click('[data-connection-action="refresh"]');
    await until(() => reads > beforeRefresh, 'Connections refreshes account');
    await click('[data-github-actions]'); await click('[data-connection-action="manage"]');
    await until(() => win.contentView.children.some(view => view.webContents?.getURL() === `${origin}/installations/new`), 'Repository access opens in Stage');
    await click('[aria-label="Close connections"]'); await click(toggle);
    await until(() => js(wc, `document.querySelector('${panel}')?.textContent.includes('No repositories shared')`), 'empty account');
    await escape(); mode = 'normal'; await click(toggle); await loaded();
    await click('[data-rail-section-toggle=GitHub]'); await closed();
    await click('[data-rail-section-toggle=GitHub]');
    assert.equal(await exists(panel), false, 'reopening section does not reopen browser');
    await click(toggle); await loaded(); await click('[data-rail-add] > button');
    await until(() => exists('[data-add-github]'), 'Add context remains available'); await closed(); await escape();
    // Every provider uses the same single Browse entry; switching closes the old popup.
    for (const [section, provider, label] of [['Papers','zotero','Browse Zotero…'],['Overleaf','overleaf','Browse projects…'],['Documents','google','Browse Google Docs…']]) {
      await click(`[data-rail-section-toggle=${section}]`);
      assert.equal(await js(wc, `document.querySelector('[data-browse-source=${provider}]').textContent`), label);
      await click(`[data-browse-source=${provider}]`);
      await until(() => exists(`[data-source-browser=${provider}]`), `${provider} browser`);
      assert.equal(await js(wc, 'document.querySelectorAll("[data-source-browser]").length'), 1);
      await escape();
    }
    win.setSize(1080, 640); await pause(200);
    await js(wc, `document.querySelector('${toggle}').scrollIntoView({block:'center'})`);
    await click(toggle); await loaded();
    await until(() => js(wc, `(()=>{const r=document.querySelector('${panel}').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()`), 'browser stays inside compact viewport');
    await shot('compact-browser');
    mode = 'error'; await js(wc, 'window.dispatchEvent(new Event("focus"))');
    await until(() => exists(`${panel} [role="alert"]`), 'catalog error visible');
    assert.equal(await exists('[data-github-account-repo]'), true, 'temporary failure retains existing repositories');
    connected = false; announce();
    await until(() => js(wc, `document.querySelector('${panel}')?.textContent.includes('Connect GitHub')`), 'sign-out clears catalog');
    assert.equal(await exists('[data-github-account-repo]'), false);
    for (const row of saved) assert.equal(await exists(`[data-rail-row="${row.id}"]`), true, 'sign-out retains workspace context');
    await js(wc, 'localStorage.setItem("engelbart.rail.shut",JSON.stringify({GitHub:false,GithubAccount:false}))');
    wc.reload();
    await until(() => exists('[data-rail-section-toggle=GitHub]').catch(() => false), 'sidebar restored');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-rail-section-toggle]")].every(e=>e.getAttribute("aria-expanded")==="false")'), true, 'all groups reset closed on reload');
    assert.equal(await exists('[data-browse-source], [data-source-browser]'), false);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.library().then(rows=>rows.map(row=>row.id).sort())'), originalIds);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.sandboxRuns()'), originalRuns);
    assert.equal(launches, 0, 'browsing and account controls never start a build');
    assert.deepEqual(external, []);
    console.log(JSON.stringify({ ok: true, root, checks: ['flat saved repositories', 'one Browse entry for every connected source', 'all groups and browsers closed on startup and reload', 'name-first rows', 'search and keyboard navigation', 'Stage navigation closes browser', 'no panel-width shift', 'Connections refresh', 'Repository access in Stage', 'parent folding', 'Add context preserved', 'compact viewport', 'empty/error states', 'sign-out retains context', 'no imports or builds'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
})();
