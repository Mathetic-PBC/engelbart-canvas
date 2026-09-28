'use strict';
// Real workspace switching against a disposable local app/library.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-shared-context-ui-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_HEADLESS: '1', ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1' });
require('../src/main/index.cjs');
const js = (wc, code) => wc.executeJavaScript(code, true);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, name) {
  for (let n = 0; n < 150; n++) { const value = await fn(); if (value) return value; await pause(80); }
  throw new Error(`Timed out: ${name}`);
}
const click = (wc, selector) => js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
const rows = async wc => {
  await js(wc, `document.querySelectorAll('[data-rail-section-toggle][aria-expanded="false"]').forEach(button=>button.click())`);
  return js(wc, '[...document.querySelectorAll("[data-rail-row]")].map(row=>row.dataset.railRow)');
};
async function switchTo(wc, workspace) {
  await click(wc, '[data-switch-workspace]');
  await until(() => js(wc, `!!document.querySelector('[data-workspace-item="${workspace.id}"]')`), 'workspace menu');
  await click(wc, `[data-workspace-item="${workspace.id}"]`);
  await until(() => js(wc, `document.querySelector('[data-workspace-name]')?.textContent===${JSON.stringify(workspace.name)}`), 'workspace switched');
}
async function addFromSearch(wc, row) {
  wc.focus();
  await js(wc, `document.querySelector('[data-rail-search] input').focus()`);
  await until(() => js(wc, `document.activeElement?.getAttribute('aria-label')==='Search the library'`), 'library search focused');
  await wc.insertText(row.name);
  await until(() => js(wc, `!!document.querySelector('[data-result="${row.id}"]')`), 'source search result');
  await click(wc, `[data-result="${row.id}"]`);
  await until(async () => (await rows(wc)).includes(row.id), 'source linked through sidebar');
}
app.whenReady().then(async () => {
  let win;
  try {
    win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); win.setSize(1460, 940); win.showInactive();
    const wc = win.webContents;
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'app bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Shared context review',directory:${JSON.stringify(root)}})`);
    const pid = made.project.id, a = { id: made.workspaceId, name: 'Getting started' };
    const b = await js(wc, `window.engelbartAPI.createWorkspace(${JSON.stringify(pid)},{name:'Second workspace'})`);
    const files = ['Reference Alpha', 'Reference Beta', 'Reference Gamma'].map(name => {
      const file = path.join(root, `${name}.md`); fs.writeFileSync(file, `# ${name}\nFixture source`); return file;
    });
    const sources = [];
    for (const file of files) sources.push(await js(wc, `window.engelbartAPI.addLibraryItem(${JSON.stringify(file)})`));
    await js(wc, `window.engelbartAPI.linkToWorkspace(${JSON.stringify(pid)},${JSON.stringify(a.id)},[${JSON.stringify(sources[0].id)}])`);
    await js(wc, `window.engelbartAPI.linkToWorkspace(${JSON.stringify(pid)},${JSON.stringify(b.id)},[${JSON.stringify(sources[1].id)}])`);
    await js(wc, `window.engelbartAPI.writeDoc(${JSON.stringify(pid)},{kind:'workspace',workspaceId:${JSON.stringify(a.id)}},'Alpha workspace document')`);
    await js(wc, `window.engelbartAPI.writeDoc(${JSON.stringify(pid)},{kind:'workspace',workspaceId:${JSON.stringify(b.id)}},'Beta workspace document')`);
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-switch-workspace]")').catch(() => false), 'workspace UI');
    const expected = [made.noteId, sources[0].id, sources[1].id];
    await until(async () => { const shown = await rows(wc); return expected.every(id => shown.includes(id)); }, 'all project sources in workspace A');
    assert.equal((await rows(wc)).includes(sources[2].id), false, 'unattached global library entries stay out of project context');
    await switchTo(wc, b);
    await until(() => js(wc, 'document.querySelector("[data-editor]")?.textContent.includes("Beta workspace document")'), 'independent workspace document');
    for (const id of expected) assert.ok((await rows(wc)).includes(id), 'all source rows stay visible after switching');
    await addFromSearch(wc, sources[2]);
    await switchTo(wc, a);
    await until(() => js(wc, 'document.querySelector("[data-editor]")?.textContent.includes("Alpha workspace document")'), 'original workspace document restored');
    assert.ok((await rows(wc)).includes(sources[2].id), 'source added in B is visible in A');
    await click(wc, `[data-rail-remove="${sources[0].id}"]`);
    await until(async () => !(await rows(wc)).includes(sources[0].id), 'source removed from shared collection');
    await switchTo(wc, b);
    assert.equal((await rows(wc)).includes(sources[0].id), false, 'removal follows workspace switches');
    await addFromSearch(wc, sources[0]);
    await switchTo(wc, a);
    assert.equal((await rows(wc)).filter(id => id === sources[0].id).length, 1, 'readding restores exactly one source');
    wc.reload();
    await until(async () => { try { const shown = await rows(wc); return [...expected, sources[2].id].every(id => shown.includes(id)); } catch { return false; } }, 'shared context after renderer restart');
    await switchTo(wc, b);
    for (const id of expected) assert.ok((await rows(wc)).includes(id));
    fs.writeFileSync(path.join(root, 'shared-context.png'), (await wc.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, root, checks: ['A to B to A', 'independent workspace documents', 'add in either workspace', 'shared removal', 're-add without duplication', 'renderer restart'] }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win && !win.isDestroyed()) {
      console.error(await js(win.webContents, `JSON.stringify({active:document.activeElement?.outerHTML?.slice(0,500),inputs:[...document.querySelectorAll('input')].map(i=>({label:i.getAttribute('aria-label'),value:i.value,rect:i.getBoundingClientRect().toJSON(),disabled:i.disabled}))})`).catch(String));
      fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    }
    console.error('Artifacts:', root); app.exit(1);
  }
});
