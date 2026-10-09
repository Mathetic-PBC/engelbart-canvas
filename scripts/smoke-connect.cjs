'use strict';

// npm run build && npx electron scripts/smoke-connect.cjs
// Runs the real app, hidden, against disposable data in the normal library (test mode off, as the app people download
// runs it: Connect left test mode on 2026-10-08) with Connect your library's fake agents
// (ENGELBART_CONNECT_FAKE), and walks a new user's onboarding through it (src/renderer/screens/ConnectLibrary.jsx,
// src/main/connect): no tools screen (both agents signed in), Connect in place of Add to your library and Custom
// instructions, and no Project context ("2 of 3", 2026-10-09); the choose screen starts with Notes ticked (a vault
// Obsidian knows), ChatGPT ticked by hand, the permissions card naming it; Refine opens the chat, its first line said at
// once, whose question is a card with one option per line; ChatGPT, signed in nowhere this disposable home can read, gets
// its sign-in card before its survey starts, in the strip above Reply and not in the chat; Done gives it back and the
// survey runs; the librarian waits for it, then offers what it found; the connect step's Continue is a filled button once
// the session has started; Import lights up once nothing is left to ask; the working view follows every import, MEMORY.md
// is saved without its planted secrets, Continue moves on, Create has no folder part and its Skip opens the project, which
// holds the vault's notes, with the chip in the top right saying the library is connected. ENGELBART_CONNECT_SHOTS=<dir>
// saves pictures.
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
    assert.match(await text(wc, '[data-onboarding-step-of]'), /^2 of 3$/, 'welcome, connect, create: Add to your library, Custom instructions and Project context are gone');
    assert.ok(await has(wc, '[data-onboarding-skip]'), 'Skip for now before a session');
    assert.equal(await has(wc, '[data-onboarding-continue]'), false, 'no Continue before a session');
    assert.match(await text(wc, '[data-connect-provider]'), /^Claude Code$/);
    assert.match(await text(wc, '[data-connect-chip]'), /Sonnet · High/, 'the pinned model, shown and not offered');
    await press(wc, '[data-connect-source="chats"] button[aria-expanded]');
    await press(wc, '[data-connect-app="ChatGPT"]');
    assert.equal(await attr(wc, '[data-connect-app=ChatGPT] [role=checkbox]', 'aria-checked'), 'true');
    // MATH-114: asking ChatGPT what it remembers is ticking it; one checkbox, naming the provider, for the rest.
    assert.match(await text(wc, '[data-connect-app=ChatGPT]'), /asks what it remembers/);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-connect-permission]").length'), 1, 'one consent checkbox');
    assert.match(await text(wc, '[data-connect-permission]'), /^✓?Use my Claude Code subscription to read these/);
    assert.match(await text(wc, '[data-connect-permission]'), /macOS may ask before Engelbart reads some of these\.$/);
    assert.doesNotMatch(await text(wc, '[data-connect-permissions]'), /what (it|they) remembers?/, 'no "Ask … remember" row');
    assert.match(await text(wc, '[data-connect-reassure]'), /Stored only on your Mac in ~\/\.engelbart\. Claude Code reads it through your account\. Mathetic never sees it\./);
    const buttons = await js(wc, 'JSON.stringify([...document.querySelectorAll("[data-connect-library=choose] button")].map((el) => el.textContent.trim()))');
    assert.equal(JSON.parse(buttons).some((label) => /^(Sign in…|Allow…)$/.test(label)), false, 'no Sign in… or Allow… buttons: ticking is the consent');
    // One column, stacked (2026-10-09): no custom instructions box.
    assert.equal(await has(wc, '[data-connect-column]'), true, 'the choose screen is one column');
    assert.equal(await has(wc, '[data-connect-custom]'), false, 'no custom instructions box');
    await shot(wc, '1-choose');
    // Code: GitHub's row opens onboarding's own repository list, roomy (here GitHub is not set up, so its sign-in shows in its place).
    await press(wc, '[data-connect-source="code"] button[aria-expanded]');
    await until(() => has(wc, '[data-connect-row-open="GitHub"]'), 'Code\'s rows: GitHub and Local repos');
    assert.ok(await has(wc, '[data-connect-app="Local repos"]'), 'Local repos under Code');
    await press(wc, '[data-connect-row-open="GitHub"]');
    await until(() => has(wc, '[data-connect-github]'), 'the repository list under Code');
    const github = JSON.parse(await js(wc, 'JSON.stringify(document.querySelector("[data-connect-github]").getBoundingClientRect())'));
    assert.ok(github.height >= 300, `the repository list has room: ${github.height}`);
    await js(wc, 'document.querySelector("[data-connect-permissions]").scrollIntoView({block:"center"})');
    await pause(200);
    await shot(wc, '1b-permissions');
    await press(wc, '[data-connect-source="code"] button[aria-expanded]');

    /* ------------------------------------------------ refine: a card with one option per line, the needs-you card, the survey's findings */
    await press(wc, '[data-connect-library="choose"] [data-connect-send]');
    // No opening line (2026-10-09): the dots in the middle until the librarian says something, then never again.
    await until(async () => (await has(wc, '[data-connect-chat] [data-connect-starting]')) || has(wc, '[data-connect-chat] [data-connect-agent]'), 'the dots, or the librarian already');
    assert.doesNotMatch(await text(wc, '[data-connect-chat]'), /Looking at what you picked|Found \d/, 'no opening line in the chat');
    // One clear Continue on the connect step once a session exists: filled, by the pager; Skip for now gone.
    await until(() => has(wc, '[data-onboarding-continue] button'), 'the connect step\'s Continue');
    assert.equal(await has(wc, '[data-onboarding-skip]'), false, 'no Skip for now with a session');
    const filled = await js(wc, '(()=>{const b=document.querySelector("[data-onboarding-continue] button");const c=getComputedStyle(b).backgroundColor;return c!=="rgba(0, 0, 0, 0)"&&c!=="transparent"&&c!=="rgb(255, 255, 255)"})()');
    assert.equal(filled, true, 'Continue is a filled button');
    // ChatGPT's sign-in, sorted before its survey: its card in the strip above Reply, not in the chat.
    await until(() => has(wc, '[data-connect-needs] [data-connect-need="signin"]'), 'ChatGPT\'s sign-in card, before the run asks');
    assert.equal(await has(wc, '[data-connect-chat] [data-connect-need]'), false, 'no sign-in card inside the chat');
    const above = await js(wc, '(()=>{const strip=document.querySelector("[data-connect-needs]").getBoundingClientRect();const reply=document.querySelector("[data-connect-draft]").getBoundingClientRect();return strip.bottom<=reply.top})()');
    assert.equal(above, true, 'the strip sits above Reply');
    await until(() => has(wc, '[data-connect-card="live"] [data-connect-option="Everything"]'), 'the notes question, as a card');
    assert.equal(await attr(wc, '[data-connect-import]', 'data-ready'), '0', 'Import is not lit while questions remain');
    await shot(wc, '2-card');
    await press(wc, '[data-connect-card="live"] [data-connect-option="Everything"]');
    await press(wc, '[data-connect-card="live"] [data-connect-submit]');
    // One Log in button and Skip (2026-10-08). The run is hidden and no browser can be read here: Done is given through
    // the API, as main's windowClosed would.
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
    // No folder part: ~/<name> by default, "Use an existing folder…" under the name for another; no Project context.
    assert.match(await text(wc, '[data-onboarding-use-folder]'), /^Use an existing folder…$/);
    assert.equal(await has(wc, '[data-onboarding-folder]'), false, 'no folder part');
    await fill(wc, '[data-onboarding-name]', 'Connect smoke');
    await press(wc, '[data-onboarding-continue] button');
    await until(() => has(wc, '[data-onboarding-desc]'), 'the description');
    assert.match(await text(wc, '[data-onboarding-continue] button'), /Open project/);
    await press(wc, '[data-onboarding-skip]');
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
