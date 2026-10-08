'use strict';

// npm run build && npx electron scripts/smoke-connect.cjs
// Runs the real app, hidden, against disposable data in test mode with Connect your library's fake agents
// (ENGELBART_CONNECT_FAKE), and walks a new user's onboarding through it (src/renderer/screens/ConnectLibrary.jsx,
// src/main/connect): the choose screen starts with Notes ticked (a vault Obsidian knows), Refine opens the chat, a chip
// answers the librarian, the import it starts runs in the background, Import and Done move on, and the project made at the
// end holds the vault's notes. ENGELBART_CONNECT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-smoke-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ git: '2.50.0', claude: '2.1.300', codex: '0.160.0' }); // nothing to install: no tools screen
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_CONNECT_FAKE_MS = '150';
process.env.ENGELBART_HEADLESS = '1';

// Test mode on, and a vault Obsidian knows, in the disposable home.
const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: true });
const write = (rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write('Notes/.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
write('Notes/Research/Help-seeking.md', 'Novices rarely ask. See [[Tutoring]].\n');
write('Notes/Research/Tutoring.md', 'VanLehn 2011.\n');
write('Notes/Essays/Tools for thought.md', 'A draft.\n');
write('Notes/Daily/2026-10-01.md', 'standup\n');
write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { v: { path: path.join(root, 'Notes'), ts: Date.now(), open: true } } }));
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(150);
};
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const step = (wc) => js(wc, 'document.querySelector("[data-onboarding]") && document.querySelector("[data-onboarding]").dataset.step');
// A field's value set as typing would set it.
const fill = (wc, selector, value) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));return el.value})()`);
const SHOTS = process.env.ENGELBART_CONNECT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke runs must not show a desktop window');
    win.setSize(1280, 860);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    await press(wc, '[data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'connect', 'Connect your library, after the welcome (test mode)');

    /* ------------------------------------------------ choose: Notes ticked where Obsidian was found */
    await until(() => has(wc, '[data-connect-library="choose"] [data-connect-app="Obsidian"]'), 'the choose screen, Notes open');
    assert.equal(await js(wc, 'document.querySelector("[data-connect-app=Obsidian] [role=checkbox]").getAttribute("aria-checked")'), 'true', 'Obsidian ticked: its vault was found');
    assert.equal(await js(wc, 'document.querySelector("[data-connect-source=notes] [role=checkbox]").getAttribute("aria-checked")'), 'true');
    assert.equal(await js(wc, 'document.querySelector("[data-connect-source=papers] [role=checkbox]").getAttribute("aria-checked")'), 'false', 'nothing found for papers');
    assert.match(await js(wc, 'document.querySelector("[data-onboarding-step-of]").textContent'), /^2 of 6$/, 'welcome, connect, import, instructions, create, context');
    await shot(wc, '1-choose');

    /* ------------------------------------------------ refine: the librarian asks, a chip answers, the import starts */
    await press(wc, '[data-connect-library="choose"] [data-connect-send]');
    await until(() => has(wc, '[data-connect-library="chat"] [data-connect-option="Everything"]'), 'the librarian\'s question');
    await shot(wc, '2-chat');
    await press(wc, '[data-connect-option="Everything"]');
    await until(() => js(wc, '!!document.querySelector("[data-connect-jobs]") && /✓/.test(document.querySelector("[data-connect-jobs]").textContent)'), 'the notes import finished, under the header');
    await until(() => js(wc, '[...document.querySelectorAll("[data-connect-agent]")].some((el)=>/everything/i.test(el.textContent))'), 'the librarian done');
    await shot(wc, '3-chat-imported');

    /* ------------------------------------------------ Import, the progress list, Done */
    await press(wc, '[data-connect-import]');
    await until(() => has(wc, '[data-connect-library="sent"] [data-connect-job="done"]'), 'the progress list');
    assert.match(await js(wc, 'document.querySelector("[data-connect-progress]").textContent'), /✓ 4 added/, 'the vault\'s four notes');
    await shot(wc, '4-sent');
    await press(wc, '[data-connect-done]');
    await until(async () => (await step(wc)) === 'import', 'Add to your library next');

    /* ------------------------------------------------ the rest of onboarding: the notes go into the project */
    for (let i = 0; i < 4 && (await step(wc)) !== 'create'; i += 1) { await press(wc, '[data-onboarding-skip]'); await pause(200); }
    await until(async () => (await step(wc)) === 'create', 'Create a new project');
    await fill(wc, '[data-onboarding-name]', 'Connect smoke');
    await press(wc, '[data-onboarding-continue] button');
    await press(wc, '[data-onboarding-skip]');
    await press(wc, '[data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'context', 'Project context');
    await press(wc, '[data-onboarding-open] button');
    await until(() => js(wc, '!document.querySelector("[data-onboarding]")'), 'the project open', 400);
    const names = await js(wc, `window.engelbartAPI.library().then((rows)=>{const project=rows.find((row)=>row.name==='Welcome!');return rows.filter((row)=>row.project_id===project.project_id&&row.tags.includes('note')).map((row)=>row.name).sort()})`);
    assert.deepEqual(names, ['2026-10-01', 'Help-seeking', 'Tools for thought', 'Tutoring', 'Welcome!'], 'the staged notes went into the new project');
    await shot(wc, '5-project');
    console.log(`Connect your library smoke passed. Data: ${root}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    const wc = BrowserWindow.getAllWindows()[0] && BrowserWindow.getAllWindows()[0].webContents;
    if (wc) {
      console.error(await js(wc, '(document.querySelector("[data-connect-library]")||document.body).innerText').catch(() => ''));
      await shot(wc, 'failed').catch(() => {});
    }
    app.exit(1);
  }
});
