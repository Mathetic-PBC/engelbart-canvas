'use strict';
// Real app, IPC, Git worktrees, native views and local servers; only model output
// and tool discovery are scripted. All data stays in a disposable profile.
const { app, BrowserWindow, webContents } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-build-integration-'));
const code = path.join(root, 'code');
fs.mkdirSync(code);
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_BUILD_FAKE: '1', ENGELBART_TOOLS_FAKE: '{}' });
const git = (...args) => execFileSync('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', ...args], { cwd: code, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
fs.writeFileSync(path.join(code, 'README.md'), 'Accepted code\n');
git('add', 'README.md'); git('commit', '-qm', 'Initial code');
let builds, previews, dataStore, turns = 0, failAcceptedLaunch = false;
const buildModule = require('../src/main/build/manager.cjs'), createBuilds = buildModule.createBuilds;
buildModule.createBuilds = options => (builds = createBuilds(options));
const ipc = require('../src/main/ipc.cjs'), createStore = ipc.createStore;
ipc.createStore = options => (dataStore = createStore(options));
const previewModule = require('../src/main/build/interfaces.cjs'), createInterfaces = previewModule.createInterfaceBuilds;
previewModule.createInterfaceBuilds = options => (previews = createInterfaces(options));
const serverPreviews = require('../src/main/build/previews.cjs'), createPreviews = serverPreviews.createBuildPreviews;
serverPreviews.createBuildPreviews = options => createPreviews({ ...options, verify: async (...args) => {
  if (failAcceptedLaunch) throw new Error('Fixture accepted preview failed to launch');
  return options.verify(...args);
} });
require('../src/main/local-preview/plan.cjs').createBuildPlanner = () => async () => require('../test/fixtures/local-build-plan.cjs')(2);
const server = `const http=require('node:http'),fs=require('node:fs');http.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(fs.readFileSync('index.html'));}).listen(Number(process.argv[2]),'127.0.0.1');`;
require('../src/main/build/runner.cjs').createFakeRunner = () => ({ turn: async ({ task, message, session, onUpdate }) => {
  if (task.kind === 'quick' && message.includes('escalate')) return { text: 'ESCALATE: needs a full Build', session: 'smoke' };
  turns++;
  onUpdate({ activity: 'Writing fixture interface', log: true });
  fs.writeFileSync(path.join(task.worktree, 'server.cjs'), server);
  fs.writeFileSync(path.join(task.worktree, 'index.html'), `<title>Build ${turns}</title><h1>Version ${turns}</h1><button onclick="this.textContent='Clicked'">Try it</button>`);
  fs.writeFileSync(path.join(task.worktree, 'engelbart-preview.json'), JSON.stringify({ version: 1, kind: 'interface', buildId: task.id, name: 'Build interface', command: 'node server.cjs {port}', install: null }));
  return { text: 'Built and checked the fixture interface.', session: session || 'smoke' };
} });
const js = (wc, source) => wc.executeJavaScript(source, true);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 240; i++) { const value = await fn(); if (value) return value; await pause(80); } throw new Error(`Timed out: ${label}`); }
const click = (wc, selector) => js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
let win;
async function finish(status) { clearTimeout(deadline); await previews?.close(); await builds?.stopAll(); if (win && !win.isDestroyed()) await js(win.webContents, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))').catch(() => {}); app.exit(status); }
const deadline = setTimeout(() => { console.error('Build integration timed out', root); void finish(1); }, 180_000);

(async () => {
  try {
    require('../src/main/index.cjs');
    await app.whenReady();
    win = await until(() => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('engelbart://')), 'app window');
    win.setFocusable(false); win.setSize(1460, 940); win.showInactive(); win.show = () => {}; win.focus = () => {};
    const wc = win.webContents, errors = [];
    wc.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const call = (name, ...args) => js(wc, `window.engelbartAPI.${name}(...${JSON.stringify(args)})`);
    const made = await call('createProjectWithWelcome', { name: 'Combined Build', directory: code });
    const pid = made.project.id, wid = made.workspaceId;
    const other = await call('createWorkspace', pid, { name: 'Other workspace', createDefault: true });
    const ref = { kind: 'workspace', workspaceId: wid };
    await call('writeDoc', pid, ref, '@bart --build Make a tiny interface\n');
    await call('setLastOpen', { projectId: pid, workspaceId: wid });
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-editor]")').catch(() => false), 'workspace');
    await until(() => js(wc, '!!document.querySelector("[data-code-context]")'), 'Bart code context');
    assert.equal(await js(wc, '!!document.querySelector("[data-workspace-repository]")'), false, 'no repository row beneath the title');
    assert.equal(await js(wc, '!!document.querySelector("[data-directory-gate]")'), false);
    fs.writeFileSync(path.join(root, 'workspace-repository.png'), (await wc.capturePage()).toPNG());
    // Natural proposal approval shares these same controls; explicit --build also
    // requires approval and cannot invoke the retired local coding agent.
    await js(wc, `(()=>{const send=document.querySelector('[data-act=ask]');if(send){send.click();return;}const el=document.querySelector('[data-raw^="@bart "] .t');el.focus();const r=document.createRange();r.selectNodeContents(el);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);document.querySelector('[data-editor]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
    await until(() => js(wc, '!!document.querySelector("[data-act=showbuild]")'), 'proposal');
    await click(wc, '[data-act=showbuild]');
    await until(() => js(wc, '!!document.querySelector("[data-build-approve]")'), 'notification approval');
    assert.equal((await call('buildList', pid)).length, 0);
    assert.equal(turns, 0);
    await click(wc, '[data-build-approve]');
    await click(wc, '.notification-bell');
    const ready = async id => until(async () => {
      const tasks = await call('buildList', pid), task = id ? tasks.find(row => row.id === id) : tasks[0];
      if (task?.preview?.error) throw new Error(task.preview.error);
      return task?.preview?.url && !task.working && task;
    }, 'worktree preview');
    const first = await ready();
    await until(() => js(wc, `!!document.querySelector('[data-build="${first.id}"] [data-build-input]')`), 'Build card');
    let page = await until(() => webContents.getAllWebContents().find(w => w.getURL() === first.preview.url), 'Stage review page');
    assert.equal(await js(page, 'document.querySelector("h1").textContent'), 'Version 1');
    await js(page, 'document.querySelector("button").click()');
    assert.equal(await js(page, 'document.querySelector("button").textContent'), 'Clicked');
    assert.equal(fs.existsSync(path.join(code, 'index.html')), false);
    await js(wc, `(()=>{const el=document.querySelector('[data-build-input="${first.id}"]');el.value='Refine the interface';el.dispatchEvent(new Event('input',{bubbles:true}));el.setSelectionRange(4,10);el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',shiftKey:true,bubbles:true}));document.querySelector('[data-act=buildsend][data-build-id="${first.id}"]').click();})()`);
    await until(async () => (await call('buildGet', pid, first.id)).turn === 2, 'reply continues Build');
    const refined = await ready(first.id);
    await pause(250);
    fs.writeFileSync(path.join(root, 'review.png'), (await wc.capturePage()).toPNG());
    page = await until(() => webContents.getAllWebContents().find(w => w.getURL() === refined.preview.url), 'updated preview page');
    assert.equal(await js(page, 'document.querySelector("h1").textContent'), 'Version 2');
    // An occluded native view can refuse GPU capture in a headless smoke run;
    // the window screenshot and live DOM checks still verify this transition.
    try { fs.writeFileSync(path.join(root, 'preview-page.png'), (await page.capturePage()).toPNG()); }
    catch (error) { if (!String(error).includes('UnknownVizError')) throw error; console.warn('Native preview capture unavailable (occluded); continuing DOM checks.'); }
    await call('setProjectDefaultRepository', pid, { repoId: other.repoId });
    assert.equal((await call('workspaceRepository', pid, wid)).connected.repoId, other.repoId);
    await click(wc, `[data-act=buildaccept][data-build-id="${first.id}"]`);
    const accepted = await until(async () => { const task = await call('buildGet', pid, first.id); return task.status === 'accepted' && task; }, 'Accept');
    await until(() => webContents.getAllWebContents().find(w => w.getURL() === accepted.preview.url), 'Stage accepted page');
    assert.equal(fs.existsSync(first.worktree), false);
    assert.equal(accepted.repoId, first.repoId);
    assert.ok(fs.existsSync(path.join(code, 'index.html')), 'Accept lands in the recorded repository after a default change');
    await call('setProjectDefaultRepository', pid, { repoId: first.repoId });
    const second = await call('buildStart', pid, { workspaceId: wid });
    let review = await ready(second.id);
    await until(() => webContents.getAllWebContents().find(w => w.getURL() === review.preview.url), 'second review page');
    const stoppedReviewUrl = review.preview.url;
    await call('buildStopPreview', pid, second.id, review.preview.serverId);
    await until(() => !webContents.getAllWebContents().some(w => w.getURL() === stoppedReviewUrl), 'stopped review tab closes');
    assert.ok((await fetch(accepted.preview.url)).ok, 'Stop on review leaves the shared accepted server running');
    assert.equal((await call('buildGet', pid, first.id)).preview.status, 'ready');
    await call('buildPreview', pid, second.id);
    review = await ready(second.id);
    await until(() => webContents.getAllWebContents().find(w => w.getURL() === review.preview.url), 'reopened review page');
    fs.writeFileSync(path.join(code, 'index.html'), '<h1>User edit</h1>');
    await assert.rejects(call('buildAccept', pid, second.id));
    assert.equal((await call('buildGet', pid, second.id)).preview.url, review.preview.url);
    assert.match(await (await fetch(review.preview.url)).text(), /Version 3/);
    await call('buildDiscard', pid, second.id);
    await until(() => js(wc, `document.querySelector('[data-stage-address] input')?.value.includes(${JSON.stringify(new URL(accepted.preview.url).host)})`), 'Discard returns to accepted Stage preview');
    await assert.rejects(fetch(review.preview.url));
    fs.writeFileSync(path.join(code, 'index.html'), git('show', 'HEAD:index.html')); // restore the fixture's own edit
    const third = await call('buildStart', pid, { workspaceId: wid });
    const thirdReview = await ready(third.id);
    await until(() => webContents.getAllWebContents().find(w => w.getURL() === thirdReview.preview.url), 'third review page');
    failAcceptedLaunch = true;
    const landed = await call('buildAccept', pid, third.id);
    assert.equal(landed.status, 'accepted');
    assert.equal(landed.preview.status, 'failed');
    await until(() => js(wc, `document.querySelector('[data-stage-address] input')?.value.includes(${JSON.stringify(new URL(accepted.preview.url).host)})`), 'accepted-server failure restores the previous Stage preview');
    await assert.rejects(fetch(thirdReview.preview.url));
    failAcceptedLaunch = false;
    const fourth = await call('buildStart', pid, { workspaceId: wid });
    await ready(fourth.id);
    const replacement = await call('buildAccept', pid, fourth.id);
    await until(() => !webContents.getAllWebContents().some(w => w.getURL() === accepted.preview.url), 'every old accepted Stage URL replaced');
    await until(() => webContents.getAllWebContents().some(w => w.getURL() === replacement.preview.url), 'replacement accepted Stage page');
    assert.equal((await call('buildGet', pid, first.id)).preview.serverId, replacement.preview.serverId);
    await click(wc, `[data-act=buildstoppreview][data-build-id="${first.id}"]`);
    await until(() => !webContents.getAllWebContents().some(w => w.getURL() === replacement.preview.url), 'shared Stop closes all accepted Stage tabs');
    assert.equal((await call('buildGet', pid, fourth.id)).preview.status, 'stopped');
    await assert.rejects(fetch(replacement.preview.url));
    // Clear/Archive is a middle-panel surface and does not replace the connector rail.
    await click(wc, '[data-clear-doc]');
    await until(() => js(wc, '!!document.querySelector("[data-rail-section-toggle=Archived]")'), 'Archived heading');
    await click(wc, '[data-rail-section-toggle=Archived]');
    await until(() => js(wc, '!!document.querySelector("[data-rail-row^=archive]")'), 'Archived section');
    await click(wc, '[data-rail-row^=archive]');
    await until(() => js(wc, '!!document.querySelector("[data-editor][contenteditable=false]")'), 'read-only archived document');
    // A post-it popup owns its native-view occlusion and lets the person change destination.
    await call('postItsCreate', pid);
    const card = await until(() => webContents.getAllWebContents().find(w => w.getURL() === 'engelbart://app/post-it.html'), 'post-it');
    await js(card, 'window.postItAPI.ready()');
    await js(card, `window.postItAPI.edit('Please escalate this quick task')`);
    await js(card, 'window.postItAPI.build({x:100,y:150,width:50,height:25})');
    await until(() => js(wc, '!!document.querySelector("[data-build-destination]")'), 'post-it Build popup');
    assert.equal(await js(wc, 'document.querySelector("[data-build-destination]").value'), wid);
    await js(wc, `(()=>{const el=document.querySelector('[data-build-destination]');el.value=${JSON.stringify(other.id)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await pause(250);
    fs.writeFileSync(path.join(root, 'post-it-build.png'), (await wc.capturePage()).toPNG());
    await click(wc, '[data-build-send]');
    const quick = await until(async () => (await call('buildList', pid)).find(task => task.kind === 'quick' && task.status === 'escalated'), 'quick task');
    assert.equal(quick.workspaceId, other.id);
    assert.equal(quick.repoId, (await call('workspaceRepository', pid, other.id)).connected.repoId);
    assert.notEqual(quick.repoId, first.repoId);
    await call('buildDiscard', pid, quick.id);
    assert.deepEqual(errors, [], 'renderer errors');
    console.log(JSON.stringify({ ok: true, root, checks: ['notification approval before code', 'Hudson task card', 'Build reply input', 'real worktree preview and page interaction', 'Accept switches Stage using its original repository after default changes', 'review Stop preserves accepted server', 'shared replacement/Stop synchronizes cards and Stage tabs', 'failed Accept retains preview', 'Discard restores accepted Stage', 'accepted-server failure fallback', 'archive opens read-only in middle', 'post-it popup and destination'] }));
    await finish(0);
  } catch (error) {
    console.error(error);
    if (win && !win.isDestroyed()) { fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG()); console.error(await js(win.webContents, 'document.body.innerText.slice(-2500)').catch(String)); }
    console.error('Artifacts:', root); await finish(1);
  }
})();
