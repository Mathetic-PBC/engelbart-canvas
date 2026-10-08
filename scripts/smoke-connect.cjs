'use strict';

// npm run build && npx electron scripts/smoke-connect.cjs
// Runs the real app, hidden, against disposable data in the normal library (test mode off, as the app people download
// runs it: Connect left test mode on 2026-10-08) with Connect your library's fake agents
// (ENGELBART_CONNECT_FAKE), and walks a new user's onboarding through it (src/renderer/screens/ConnectLibrary.jsx,
// src/main/connect): no tools screen (both agents signed in), Connect in place of Add to your library and Custom
// instructions ("2 of 4"); the choose screen starts with Notes ticked (a vault Obsidian knows), ChatGPT ticked by hand,
// the permissions card naming it; Refine opens the chat, whose question is a card with one option per line; ChatGPT's
// survey hands the person its sign-in (ENGELBART_CONNECT_FAKE_NEEDS), Done gives it back; the librarian waits for the
// survey, then offers what it found; Import lights up once nothing is left to ask; the working view follows every import,
// MEMORY.md is saved without its planted secrets, Continue moves on, and the project made at the end holds the vault's
// notes, with the chip in the top right saying the library is connected. ENGELBART_CONNECT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-smoke-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ git: '2.50.0', claude: '2.1.300', codex: '0.160.0' }); // both signed in: no tools screen
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_CONNECT_FAKE_MS = '150';
process.env.ENGELBART_CONNECT_FAKE_NEEDS = 'ChatGPT';
process.env.ENGELBART_CONNECT_APPLICATIONS = ''; // this Mac's /Applications is not the disposable one's
process.env.ENGELBART_HEADLESS = '1';

// Test mode off, and a vault Obsidian knows, in the disposable home.
const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: false });
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
const attr = (wc, selector, name) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{getAttribute:()=>null}).getAttribute(${JSON.stringify(name)})`);
const text = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
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
    win.setSize(1280, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    await press(wc, '[data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'connect', 'Connect your library, after the welcome (test mode off, both agents signed in)');

    /* ------------------------------------------------ choose: Notes ticked where Obsidian was found, ChatGPT by hand */
    await until(() => has(wc, '[data-connect-library="choose"] [data-connect-app="Obsidian"]'), 'the choose screen, Notes open');
    assert.equal(await attr(wc, '[data-connect-app=Obsidian] [role=checkbox]', 'aria-checked'), 'true', 'Obsidian ticked: its vault was found');
    assert.equal(await attr(wc, '[data-connect-source=papers] [role=checkbox]', 'aria-checked'), 'false', 'nothing found for papers');
    assert.match(await text(wc, '[data-onboarding-step-of]'), /^2 of 4$/, 'welcome, connect, create, context: Add to your library and Custom instructions are gone');
    assert.match(await text(wc, '[data-connect-provider]'), /^Claude Code$/);
    assert.match(await text(wc, '[data-connect-chip]'), /Sonnet · High/, 'the pinned model, shown and not offered');
    await press(wc, '[data-connect-source="chats"] button[aria-expanded]');
    await press(wc, '[data-connect-app="ChatGPT"]');
    assert.equal(await attr(wc, '[data-connect-app=ChatGPT] [role=checkbox]', 'aria-checked'), 'true');
    // Each a line with no subtext under it (2026-10-08).
    assert.match(await text(wc, '[data-connect-permissions]'), /Agents do all of this for you[\s\S]*Use my accounts in the background\s*✓?\s*Ask ChatGPT what it remembers about my research\s*$/);
    await shot(wc, '1-choose');
    // Code: onboarding's own repository list, roomy (here GitHub is not set up, so its sign-in shows in its place).
    await press(wc, '[data-connect-source="code"] button[aria-expanded]');
    await until(() => has(wc, '[data-connect-github]'), 'the repository list under Code');
    const github = JSON.parse(await js(wc, 'JSON.stringify(document.querySelector("[data-connect-github]").getBoundingClientRect())'));
    assert.ok(github.height >= 300, `the repository list has room: ${github.height}`);
    await js(wc, 'document.querySelector("[data-connect-permissions]").scrollIntoView({block:"center"})');
    await pause(200);
    await shot(wc, '1b-permissions');
    await press(wc, '[data-connect-source="code"] button[aria-expanded]');

    /* ------------------------------------------------ refine: a card with one option per line, the needs-you card, the survey's findings */
    await press(wc, '[data-connect-library="choose"] [data-connect-send]');
    await until(() => has(wc, '[data-connect-card="live"] [data-connect-option="Everything"]'), 'the notes question, as a card');
    assert.equal(await attr(wc, '[data-connect-import]', 'data-ready'), '0', 'Import is not lit while questions remain');
    await shot(wc, '2-card');
    await press(wc, '[data-connect-card="live"] [data-connect-option="Everything"]');
    await press(wc, '[data-connect-card="live"] [data-connect-submit]');
    await until(() => has(wc, '[data-connect-need="signin"]'), 'ChatGPT\'s survey handing over its sign-in');
    // One Log in button and Skip (2026-10-08). The run is hidden, so there is no window to sign in in: the window being
    // closed is what says it is done, as main's windowClosed does.
    assert.match(await text(wc, '[data-connect-need="signin"]'), /ChatGPT needs you to sign in[\s\S]*Skip\s*Log in/);
    assert.equal(await has(wc, '[data-connect-need-done]'), false, 'no Done');
    assert.equal(await has(wc, '[data-connect-need-signins]'), false, 'nothing brought over from Chrome');
    await shot(wc, '3-needs-you');
    await js(wc, `window.engelbartAPI.connectList().then(async (list) => { const s = list[0]; await window.engelbartAPI.connectNeed(s.id, s.needs[0].id, 'done'); })`);
    await until(() => has(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]'), 'the survey\'s findings, one per line', 400);
    assert.equal(await attr(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]', 'role'), 'checkbox', 'several can be picked');
    await pause(400); // the chat scrolls to its newest message first
    await press(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]');
    await press(wc, '[data-connect-card="live"] [data-connect-submit]');
    await until(async () => (await attr(wc, '[data-connect-import]', 'data-ready')) === '1', 'Import lit: nothing more to ask', 400);
    await pause(500); // the button's colour fades in
    await shot(wc, '4-chat-done');

    /* ------------------------------------------------ Import: the working view, MEMORY.md */
    await press(wc, '[data-connect-import]');
    await until(() => has(wc, '[data-connect-library="working"]'), 'the working view');
    await until(async () => (await attr(wc, '[data-connect-memory]', 'data-connect-memory')) === 'saved', 'MEMORY.md saved', 600);
    const progress = await text(wc, '[data-connect-progress]');
    assert.match(progress, /✓ 4 added/, 'the vault\'s four notes');
    assert.match(progress, /✓ remembered/, 'what ChatGPT remembers');
    assert.match(progress, /Saved · 1 secret masked/);
    assert.doesNotMatch(progress, /Activity/, 'no activity log');
    const memoryFile = fs.readFileSync(path.join(root, '.engelbart', 'MEMORY.md'), 'utf8');
    assert.equal(fs.existsSync(path.join(root, '.engelbart', 'test', 'MEMORY.md')), false, 'the normal library\'s, not test mode\'s');
    assert.doesNotMatch(memoryFile, /hunter2|sk-test/, 'MEMORY.md without its secrets');
    await shot(wc, '5-working');
    await press(wc, '[data-connect-done]');
    await until(async () => (await step(wc)) === 'create', 'Create a new project next');

    /* ------------------------------------------------ the rest of onboarding: what came in is the library's files, the chip */
    await fill(wc, '[data-onboarding-name]', 'Connect smoke');
    await press(wc, '[data-onboarding-continue] button');
    await press(wc, '[data-onboarding-skip]');
    await press(wc, '[data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'context', 'Project context');
    await press(wc, '[data-onboarding-open] button');
    await until(() => js(wc, '!document.querySelector("[data-onboarding]")'), 'the project open', 400);
    const names = await js(wc, `window.engelbartAPI.library().then((rows)=>rows.filter((row)=>row.type==='md'&&!row.project_id&&/[\\/]assets[\\/]md[\\/]/.test(row.path||'')).map((row)=>row.name).sort())`);
    assert.deepEqual(names, ['2026-10-01', 'ChatGPT fake note', 'Help-seeking', 'Tools for thought', 'Tutoring'], 'Markdown files of the library, in assets/md');
    await until(() => has(wc, '[data-connect-dock="done"]'), 'the chip: the library is connected');
    assert.match(await text(wc, '[data-connect-dock]'), /^Library ✓/);
    assert.equal(await attr(wc, '[data-connect-dock-open]', 'data-connect-dock-text'), 'Library connected · 5 added · MEMORY.md saved');
    const chip = await js(wc, 'JSON.stringify(document.querySelector("[data-connect-dock]").getBoundingClientRect())');
    assert.ok(JSON.parse(chip).width < 170, `the chip stays small beside the bell: ${chip}`);
    assert.equal(await has(wc, '[data-connect-popup]'), false, 'no offer: this person connected their library in onboarding');
    assert.equal(await text(wc, '[data-sb-count="inbox"]'), '1', 'the sidebar\'s Inbox says the library is connected');
    await shot(wc, '6-project');
    await press(wc, '[data-connect-dock-open]');
    await until(() => has(wc, '[data-connect-popup="session"] [data-connect-library="working"]'), 'the chip opens it again');
    await shot(wc, '7-popup');
    await press(wc, '[data-connect-close]');
    await until(() => js(wc, '!document.querySelector("[data-connect-popup]")'), 'closed again');
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
