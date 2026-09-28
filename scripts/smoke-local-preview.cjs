'use strict';
// Isolated full Canvas UI + IPC + real process manager + real browser verification.
// Only the model is scripted; no subscription, real workspace, or E2B is used.
// npm run build && electron scripts/smoke-local-preview.cjs
const { app, BrowserWindow, webContents, dialog, shell } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-local-preview-ui-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_BART_FAKE: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off' });
let manager;
const builds = [], nativeDialogs = [];
const revealed = [];
shell.showItemInFolder = file => revealed.push(file);
const managerModule = require('../src/main/local-preview/manager.cjs');
const createManager = managerModule.createLocalPreviews;
managerModule.createLocalPreviews = options => { manager = createManager(options); return manager; };
dialog.showMessageBox = async (_parent, options) => { nativeDialogs.push(options || _parent); return { response: 1 }; };
require('../src/main/local-preview/plan.cjs').createBuildPlanner = () => async () => require('../test/fixtures/local-build-plan.cjs')(2);
const bartModule = require('../src/main/bart/ask.cjs'), createFakeBart = bartModule.createFakeBart;
bartModule.createFakeBart = options => {
  const bart = createFakeBart(options), ask = bart.ask;
  bart.ask = async (ctx, pid, input, callbacks) => /^Can you make/.test(input.text) ? { buildProposal: { name: 'Timer', request: 'Create a timer using the workspace context' } } : ask(ctx, pid, input, callbacks);
  return bart;
};
require('../src/main/local-preview/agent.cjs').createBuildAgent = () => async (ctx, pid, input, { directory, signal, onProgress }) => {
  const context = await require('../src/main/bart/context.cjs').buildContext(ctx, pid, input);
  builds.push({ directory, text: input.text, context });
  onProgress({ activity: 'Writing the test interface', log: true });
  await delay(input.text.includes('slow') ? 2000 : 250, undefined, { signal });
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><title>Workspace timer</title><style>body{font:16px system-ui;margin:0;background:#fafafa;color:#242424}main{margin:70px auto;max-width:340px;padding:32px;background:white;border:1px solid #e6e6e6;border-radius:12px}h1{font-size:25px;margin:0 0 12px}p{color:#737373}button{padding:10px 18px;border:1px solid #d5d5d5;border-radius:7px;background:white;cursor:pointer}</style><main><h1>Workspace timer</h1><p>Built from the workspace context.</p><button onclick="this.textContent='Running'">${builds.length > 1 ? 'Start updated timer' : 'Start timer'}</button></main>`);
  fs.writeFileSync(path.join(directory, 'server.cjs'), `const http=require('node:http'),fs=require('node:fs');http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fs.readFileSync('index.html'))}).listen(Number(process.argv[2]),'127.0.0.1');`);
  fs.writeFileSync(path.join(directory, 'engelbart-preview.json'), JSON.stringify({ version: 1, kind: 'interface', buildId: input.askId, name: 'Workspace timer', command: 'node server.cjs {port}', install: null }));
  return { text: 'Built a local timer using the workspace context.' };
};

const js = (wc, code) => wc.executeJavaScript(code, true);
async function until(check, label, limit = 150) {
  for (let n = 0; n < limit; n++) { const value = await check(); if (value) return value; await delay(80); }
  throw new Error(`Timed out: ${label}`);
}
async function click(wc, selector) {
  await until(() => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`), selector);
  await js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
}
async function sendQuestion(wc) {
  await until(() => js(wc, `!!document.querySelector('[data-editor] [data-raw^="@bart "]')`).catch(() => false), 'build request');
  await js(wc, `(() => {
    const send = document.querySelector('[data-act=ask]');
    if (send) { send.click(); return; }
    const editor = document.querySelector('[data-editor]');
    const text = editor.querySelector('[data-raw^="@bart "] .t');
    editor.focus();
    const range = document.createRange(); range.selectNodeContents(text); range.collapse(false);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    editor.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter',bubbles:true,cancelable:true}));
  })()`);
}
const replyReady = wc => until(() => js(wc, `!document.querySelector('[data-pending]') && !!document.querySelector('[data-follow-input], [data-act=reply]')`), 'answer saved');
async function follow(wc, text) {
  await replyReady(wc);
  await js(wc, `(() => { if (!document.querySelector('[data-follow-input]')) [...document.querySelectorAll('[data-act=reply]')].at(-1)?.click(); })()`);
  await until(() => js(wc, `!!document.querySelector('[data-follow-input]')`), 'follow-up');
  await js(wc, `(()=>{const input=document.querySelector('[data-follow-input]');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-act=sendfollow]').click()})()`);
}
async function notifications(wc, open = true) {
  const expanded = await js(wc, 'document.querySelector(".notification-bell")?.getAttribute("aria-expanded") === "true"');
  if (expanded !== open) await click(wc, '.notification-bell');
}
async function approve(wc) {
  await click(wc, '[data-act=showbuild]');
  await click(wc, '[data-build-approve]');
  await notifications(wc, false);
}
let win, outsider;
const errors = [];
const deadline = setTimeout(() => { console.error('Local preview smoke timed out'); void cleanup(1); }, 120_000);
async function cleanup(code) {
  clearTimeout(deadline);
  try { await manager?.close(); } catch (error) { console.error(error); }
  outsider?.closeAllConnections(); outsider?.close();
  app.exit(code);
}

(async () => {
  try {
    require('../src/main/index.cjs');
    await app.whenReady();
    win = await until(() => BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('engelbart://')), 'Canvas window');
    win.setFocusable(false); win.setSize(1420, 860); win.showInactive();
    win.show = () => {}; win.focus = () => {};
    const wc = win.webContents;
    wc.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Local interface builds',directory:${JSON.stringify(root)}})`);
    const pid = made.project.id, wid = made.workspaceId;
    const qpid = JSON.stringify(pid), qwid = JSON.stringify(wid);
    const secondWorkspace = await js(wc, `window.engelbartAPI.createWorkspace(${qpid},{name:'Another workspace',parentId:${qwid}})`);
    const doc = '# Build a timer\n\nKeep this interface restrained and easy to use.\n\n@bart Can you make a timer using the workspace context\n';
    await js(wc, `window.engelbartAPI.writeDoc(${qpid},{kind:'workspace',workspaceId:${qwid}},${JSON.stringify(doc)})`);
    await js(wc, `window.engelbartAPI.setLastOpen({projectId:${qpid},workspaceId:${qwid}})`);
    wc.reload();
    await sendQuestion(wc);
    const read = () => js(wc, `window.engelbartAPI.localPreview(${qpid},${qwid})`);
    await click(wc, '[data-act=showbuild]');
    await until(() => js(wc, '!!document.querySelector(".notification-panel [data-build-approval]")'), 'notification approval');
    assert.equal(builds.length, 0, 'no coding before approval');
    const approvalText = await js(wc, 'document.querySelector("[data-build-approval]").textContent');
    assert.match(approvalText, /Build a small timer/);
    assert.match(approvalText, /coding agent receives the workspace context/);
    assert.equal(await js(wc, 'document.querySelectorAll(".notification-panel [data-build-step]").length'), 6);
    assert.equal(await js(wc, `!!document.querySelector('[aria-label="Right pane"] [data-local-preview]')`), false, 'no build strip in Stage');
    assert.ok(!approvalText.includes(root), 'no filesystem path in the conversational prompt');
    fs.writeFileSync(path.join(root, 'approval.png'), (await win.capturePage()).toPNG());
    await click(wc, '[data-build-decline]');
    await notifications(wc, false);
    await until(() => js(wc, '!document.querySelector("[data-pending]")'), 'declining clears the pending reply');
    assert.equal(builds.length, 0);
    await sendQuestion(wc);
    await approve(wc);
    const switchWorkspace = async (id, name) => {
      await click(wc, '[data-switch-workspace]');
      await js(wc, `(()=>{const input=document.querySelector('[data-workspace-search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await click(wc, `[data-workspace-item="${id}"]`);
    };
    const first = await until(async () => { const preview = await read(); if (preview?.status === 'failed') throw new Error(preview.error); return preview?.status === 'ready' && preview; }, 'first live preview');
    assert.match(builds[0].context.documents, /Keep this interface restrained/);
    assert.ok(fs.existsSync(path.join(first.directory, '.git')));
    const stagePage = await until(() => webContents.getAllWebContents().find(page => page.getURL() === first.url), 'Stage navigated to verified preview');
    const stageView = await until(() => win.contentView.children.find(view => view.webContents === stagePage && view.getVisible() && view.getBounds().width > 100), 'Stage native view is visible and sized');
    assert.equal(await js(stagePage, 'typeof window.engelbartAPI'), 'undefined');
    await js(stagePage, 'document.querySelector("button").click()');
    assert.equal(await js(stagePage, 'document.querySelector("button").textContent'), 'Running');
    await until(async () => (await read())?.libraryId, 'library association');
    await replyReady(wc);
    const tabCount = await js(wc, 'document.querySelectorAll("[data-stage-tab]").length');
    fs.writeFileSync(path.join(root, 'live.png'), (await win.capturePage()).toPNG());
    fs.writeFileSync(path.join(root, 'page.png'), (await stagePage.capturePage()).toPNG());

    await follow(wc, '--build Update the timer button');
    await approve(wc);
    const updated = await until(async () => { const p = await read(); return p?.status === 'ready' && p.runId !== first.runId && p; }, 'updated app');
    await replyReady(wc);
    assert.equal(updated.directory, first.directory);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-stage-tab]").length'), tabCount, 'updates reuse the Stage tab');
    await until(() => js(stagePage, 'document.querySelector("button")?.textContent').then(text => text === 'Start updated timer'), 'Stage reloads new files');

    const count = builds.length;
    await follow(wc, 'Explain the timer');
    await until(() => js(wc, 'document.body.textContent.includes("FAKE ANSWER")'), 'read-only follow-up');
    assert.equal(builds.length, count, 'follow-up did not inherit write permission');
    assert.equal(nativeDialogs.length, 0, 'no system dialogs');

    await notifications(wc);
    await click(wc, '[data-local-preview] .local-preview-actions button:nth-child(2)');
    await until(async () => (await read())?.status === 'stopped', 'Stop control');
    await assert.rejects(fetch(updated.url));
    outsider = http.createServer((_req, res) => res.end('An unrelated server'));
    await new Promise(resolve => outsider.listen(updated.port, '127.0.0.1', resolve));
    await click(wc, '[data-local-preview] .local-preview-actions button:first-child');
    await click(wc, '[data-restart-approval] button:last-child');
    await until(async () => (await read())?.status === 'stopped', 'declined restart stays stopped');
    assert.equal(await js(wc, '!!document.querySelector(".local-preview-error")'), false, 'declining is not an error');
    await click(wc, '[data-local-preview] .local-preview-actions button:first-child');
    await click(wc, '[data-restart-approval] button:first-child');
    const restarted = await until(async () => { const p = await read(); return p?.status === 'ready' && p; }, 'Restart control');
    assert.notEqual(restarted.port, updated.port);
    assert.equal(await (await fetch(updated.url)).text(), 'An unrelated server');
    await until(() => webContents.getAllWebContents().some(page => page.getURL() === restarted.url), 'Stage changed to the new port');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-stage-tab]").length'), tabCount);
    await click(wc, '[data-local-preview] .local-preview-actions button:last-child');
    assert.match(await js(wc, 'document.querySelector(".local-preview-details").textContent'), /node server.cjs/);
    fs.writeFileSync(path.join(root, 'logs.png'), (await win.capturePage()).toPNG());
    await click(wc, '.local-preview-folder');
    await until(() => revealed.length === 1, 'reveal local app folder');
    assert.equal(revealed[0], first.directory);
    await notifications(wc, false);
    const slot = await js(wc, `(()=>{const r=document.querySelector('[data-browser-slot]').getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`);
    await until(() => stageView.getBounds().y === slot.y, 'native page follows expanded logs');

    // Actual browser verifier rejection, not merely a fake health response.
    const verify = require('../src/main/local-preview/verify.cjs').createBrowserVerifier({ BrowserWindow });
    await assert.rejects(verify(updated.url, { timeoutMs: 800 }), /interface|HTML/);
    // A build finishing in another workspace must never navigate the page in front.
    await follow(wc, '--build Make a slow update');
    await approve(wc);
    await until(async () => (await read())?.status === 'building', 'background build started');
    await switchWorkspace(secondWorkspace.id, 'Another workspace');
    await click(wc, 'button[aria-label="New tab"]');
    await until(async () => { const p = await read(); return p?.status === 'ready' && p.runId !== restarted.runId; }, 'background build completed');
    await delay(200);
    assert.equal(await js(wc, 'document.querySelector("[data-stage-address] input").value'), '', 'background completion leaves the active blank tab alone');
    assert.equal(await js(wc, '!!document.querySelector("[data-local-preview]")'), false, 'other workspace has no stale build controls');
    await switchWorkspace(wid, 'Getting started');
    await notifications(wc);
    await until(() => js(wc, 'document.querySelector("[data-local-preview]")?.dataset.localPreview === "ready"'), 'return to saved app notification');
    await notifications(wc, false);
    await follow(wc, '--build Make another slow update');
    await approve(wc);
    await until(async () => (await read())?.status === 'building', 'cancellable build');
    await notifications(wc);
    await until(() => js(wc, '!!document.querySelector("[data-step-status=running]")'), 'actual running step');
    await click(wc, '[data-local-preview] .local-preview-actions button:first-child');
    await until(async () => (await read())?.status === 'stopped', 'build cancellation');
    await until(() => js(wc, `![...document.querySelectorAll('[data-raw]')].some(row=>row.dataset.raw.startsWith('bart~>'))`), 'cancelled pending reply removed');
    assert.ok(!errors.some(message => /ReferenceError|TypeError|Uncaught/.test(message)), errors.join('\n'));
    assert.equal(nativeDialogs.length, 0);
    console.log(JSON.stringify({ ok: true, root, builds: builds.length, nativeDialogs: nativeDialogs.length, checks: ['natural request proposal', 'notification approval', 'planned steps', 'no coding before approval', 'Not now', 'no system dialogs', 'workspace context', 'local git repo', 'real server', 'browser verification', 'Stage handoff', 'page interaction', 'library association', 'same-folder update', 'same-tab update', 'read-only follow-up', 'Stop', 'notification Restart approval and cancellation', 'occupied-port preservation', 'new-port navigation', 'logs', 'folder reveal', 'non-interface rejection', 'workspace-scoped completion', 'cancelled pending reply cleanup'] }));
    await cleanup(0);
  } catch (error) { console.error(error); console.error({ root, errors }); await cleanup(1); }
})();
