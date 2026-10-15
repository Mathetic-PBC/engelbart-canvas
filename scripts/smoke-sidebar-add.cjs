'use strict';

// npm run build && npx electron scripts/smoke-sidebar-add.cjs
// The sidebar's add picker (Sources ▸ +) as Hudson's latest mockup has it (2026-10-15, desktop
// engelbart-sidebar-mockup.html, now design/sidebar-mockup/Sidebar.html): "Upload URL or path" open at once, several links
// or paths pasted together, the picker staying open with what was added listed under the field, what could not be added
// left in the field saying why, Add from GitHub and "Upload or add files" (no New note), no dividing line. Walked in the
// real app, hidden, against a disposable home: onboarding skipped into an empty project. ENGELBART_SIDEBAR_SHOTS=<dir>.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sidebar-add-')));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, {
  ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_TOOLS_FAKE: JSON.stringify({ git: '2.50.0', claude: '2.1.300', codex: '0.160.0' }),
  ENGELBART_WEB_PDFS: 'off', ENGELBART_SANDBOXES: 'off', ENGELBART_UPDATES: 'off', ENGELBART_CONNECT_FAKE: '1', ENGELBART_CONNECT_APPLICATIONS: '',
  ENGELBART_HEADLESS: '1', ENGELBART_INSTALLED_BROWSERS: '', ENGELBART_PROVIDERS_FAKE: 'both', ENGELBART_ONBOARDING_BROWSERS: 'arc,chrome',
});
const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: false });
fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes', 'idea.md'), '# An idea\n\nTrails between documents.\n');
fs.writeFileSync(path.join(root, 'notes', 'plan.md'), '# A plan\n\nRead As We May Think.\n');
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 400) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const text = (wc, selector) => js(wc, `((document.querySelector(${JSON.stringify(selector)})||{}).textContent||'').trim()`);
const click = (wc, selector) => js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
const clickText = (wc, scope, words) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b)=>b.textContent.trim()===${JSON.stringify(words)}).click()`);
const type = (wc, selector, value) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const SHOTS = process.env.ENGELBART_SIDEBAR_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1280, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    /* onboarding skipped into an empty project */
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'onboarding');
    await click(wc, '[data-onboarding-continue] button');
    await until(() => has(wc, '.intro-page .scratch-link'), 'Import your context');
    await click(wc, '.intro-page .scratch-link');
    await until(() => has(wc, '[data-dialog="scratch-confirm"]'), 'Are you sure?');
    await clickText(wc, '[role=dialog] .mf', 'Skip');
    await until(() => has(wc, '#project-name'), 'Create a new project');
    await type(wc, '#project-name', 'Sidebar test');
    await clickText(wc, '[role=dialog] .mf', 'Create project');
    await until(() => has(wc, '[data-sb-add-sources]'), 'the project, its Sources +', 600);

    /* the add picker */
    await click(wc, '[data-sb-add-sources]');
    await until(() => has(wc, '[data-add-picker]'), 'Add sources');
    assert.equal(await has(wc, '[data-add-value]'), true, '"Upload URL or path" open at once');
    assert.equal(await js(wc, 'document.querySelector("[data-add-value]").placeholder'), 'Upload URL or path');
    assert.equal(await has(wc, '[data-add-upload], [data-add-note], [data-add-disk]'), false, 'no "Upload URL or path" to press, no New note, no Choose from disk');
    assert.equal(await text(wc, '[data-add-files]'), 'Upload or add files');
    assert.equal(await has(wc, '[data-add-github]'), true);
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-add-picker] div")].filter((el)=>{const r=el.getBoundingClientRect();return r.height>0&&r.height<=1.5&&r.width>40;}).length'), 0, 'no dividing line');
    assert.equal(await has(wc, '[data-add-link]'), false, 'no Add button until something can be added');
    await shot(wc, '01-picker');

    /* several pasted at once; what is not a link or a path stays, saying why */
    await type(wc, '[data-add-value]', '~/notes/idea.md, ~/notes/plan.md notes.md');
    await until(() => has(wc, '[data-add-link]'), 'Add sources');
    assert.equal(await text(wc, '[data-add-link]'), 'Add sources');
    await click(wc, '[data-add-link]');
    await until(() => js(wc, 'document.querySelectorAll("[data-add-added-row]").length===2'), 'both listed under the field', 600);
    assert.equal(await has(wc, '[data-add-picker]'), true, 'still open');
    assert.equal(await js(wc, 'document.querySelector("[data-add-value]").value'), 'notes.md');
    assert.equal(await text(wc, '[data-add-error]'), '"notes.md" is not a link or a path');
    await shot(wc, '02-added');
    const library = await js(wc, 'window.engelbartAPI.library()');
    for (const file of ['idea.md', 'plan.md']) assert.ok(library.some((row) => String(row.path || '').endsWith(`/notes/${file}`)), `${file} in the library`);
    console.log('smoke-sidebar-add: ok');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { await shot(BrowserWindow.getAllWindows()[0].webContents, 'failed'); } catch { /* none */ }
    app.exit(1);
  }
});
