'use strict';

// npm run build && npx electron scripts/smoke-connect.cjs
// Runs the real app, hidden, against disposable data in the normal library (test mode off, as the app people download
// runs it: Connect left test mode on 2026-10-08) with Connect your library's fake agents
// (ENGELBART_CONNECT_FAKE), and walks a new user's onboarding through it (src/renderer/screens/ConnectLibrary.jsx,
// src/main/connect): no tools screen (both agents signed in), Create before Connect (2026-10-10: its name and description
// filled first, no folder part), Connect in place of Add to your library and Custom instructions, and no Project context
// (welcome, create, connect: Connect "3 of 3"); the choose screen starts with Notes ticked (a vault
// Obsidian knows), ChatGPT ticked by hand, the permissions card naming it; Refine opens the chat, its first line said at
// once, whose question is a card with one option per line; Google Drive, ticked with no browser here whose sign-ins
// Engelbart can read (as with Safari only), opens Engelbart's own sign-in window on the tick (2026-10-12), with no Keychain
// modal; ChatGPT and Gmail ticked meanwhile wait their turn, and closing the window stops the chain, ChatGPT keeping Sign in;
// Bring these in asks for ChatGPT's sign-in in a modal first, so the refine chat has no sign-in card; its survey runs, the
// librarian waits for it, then offers what it found; the connect step's Continue is a filled button once
// the session has started; Import lights up once nothing is left to ask; the working view follows every import, MEMORY.md
// is saved without its planted secrets, and Continue ends onboarding: the project is made then, after Connect, and holds the
// vault's notes, with the chip in the top right saying the library is connected. ENGELBART_CONNECT_SHOTS=<dir>
// saves pictures.
const { app, BrowserWindow, session: electronSession } = require('electron');
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
process.env.ENGELBART_CONNECT_APPLICATIONS = ''; // this Mac's /Applications is not the disposable one's
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = ''; // no browser installed: this Mac's apps are never asked about or opened

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
// Stand-ins for some of main's answers to the renderer, for the turned-down part below (2026-10-12): a channel with a
// stand-in that answers something other than undefined answers that; otherwise main does.
const { ipcMain } = require('electron');
const standIns = {};
const realHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => realHandle(channel, (event, ...args) => {
  const standIn = standIns[channel.replace(/^engelbart:/, '')];
  const out = standIn ? standIn(...args) : undefined;
  return out !== undefined ? out : fn(event, ...args);
});
require('../src/main/index.cjs');
const { stagePartition } = require('../src/main/browser/views.cjs');

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
    await until(async () => (await step(wc)) === 'create', 'Create a new project, after the welcome (test mode off, both agents signed in)');

    /* ------------------------------------------------ Create, before Connect: a name, then a description; no project yet */
    // No folder part: ~/<name> by default, "Use an existing folder…" under the name for another; no Project context.
    await until(() => has(wc, '[data-onboarding-name]'), 'the project\'s name');
    assert.match(await text(wc, '[data-onboarding-step-of]'), /^2 of 4$/, 'welcome, create, intro, connect');
    assert.match(await text(wc, '[data-onboarding-use-folder]'), /^Use an existing folder…$/);
    assert.equal(await has(wc, '[data-onboarding-folder]'), false, 'no folder part');
    await fill(wc, '[data-onboarding-name]', 'Connect smoke');
    await press(wc, '[data-onboarding-continue] button');
    await until(() => has(wc, '[data-onboarding-desc]'), 'the description');
    assert.match(await text(wc, '[data-onboarding-continue] button'), /^Continue›?$/, 'Continue, not Open project: the project is made after Connect');
    await fill(wc, '[data-onboarding-desc]', 'How novices ask for help with tutoring tools.');
    await press(wc, '[data-onboarding-continue] button');
    // The intro (2026-10-11, David's mockup): why Engelbart asks, where the data goes, the apps it works with; then Connect.
    await until(async () => (await step(wc)) === 'intro', 'the intro, after Create');
    assert.match(await text(wc, '[data-connect-intro] h1'), /^All your context in one place$/);
    assert.match(await text(wc, '[data-onboarding-step-of]'), /^3 of 4$/);
    assert.match(await text(wc, '[data-connect-intro-a="where"]'), /^It’s saved only on this Mac\./, 'the first question open');
    assert.ok(await has(wc, '[data-connect-intro-apps]'), 'Works with, and the apps');
    // In the middle of the window's height (2026-10-12; its scroll area has 24px above and 64px below), the foot where it was.
    await pause(250); // the screen rises in
    const intro = JSON.parse(await js(wc, `JSON.stringify((()=>{const r=(q)=>document.querySelector(q).getBoundingClientRect();const area=r('[data-connect-intro-scroll]'),block=r('[data-connect-intro-block]'),foot=r('[data-connect-intro] [data-connect-foot]');return {area:{top:area.top,bottom:area.bottom},block:{top:block.top,bottom:block.bottom},foot:{bottom:foot.bottom},win:innerHeight,gap:getComputedStyle(document.querySelector('[data-connect-intro-block]')).rowGap}})())`));
    assert.ok(intro.area.bottom - intro.area.top > intro.block.bottom - intro.block.top, `the block fits: ${JSON.stringify(intro)}`);
    assert.ok(Math.abs((intro.block.top - intro.area.top) - (intro.area.bottom - intro.block.bottom - 40)) <= 2, `centered in its height: ${JSON.stringify(intro)}`);
    assert.ok(intro.block.top - intro.area.top > 40, `not at the top: ${JSON.stringify(intro)}`);
    assert.ok(intro.win - intro.foot.bottom < 60, `the foot at the bottom of the window: ${JSON.stringify(intro)}`);
    await shot(wc, '0-intro');
    await press(wc, '[data-connect-intro] [data-onboarding-continue] button');
    await until(async () => (await step(wc)) === 'connect', 'Connect your library, after the intro');
    assert.deepEqual(await js(wc, 'window.engelbartAPI.listProjects().then((list)=>list.length)'), 0, 'no project until the end of onboarding');

    /* ------------------------------------------------ choose: Notes ticked where Obsidian was found, ChatGPT by hand */
    await until(() => has(wc, '[data-connect-library="choose"] [data-connect-app="Obsidian"]'), 'the choose screen, Notes open');
    assert.equal(await attr(wc, '[data-connect-app=Obsidian] [role=checkbox]', 'aria-checked'), 'true', 'Obsidian ticked: its vault was found');
    assert.equal(await attr(wc, '[data-connect-source=papers] [role=checkbox]', 'aria-checked'), 'false', 'nothing found for papers');
    assert.match(await text(wc, '[data-onboarding-step-of]'), /^4 of 4$/, 'welcome, create, intro, connect: Add to your library, Custom instructions and Project context are gone');
    assert.ok(await has(wc, '[data-onboarding-skip]'), 'Skip for now before a session');
    assert.equal(await has(wc, '[data-onboarding-continue]'), false, 'no Continue before a session');
    // David's mockup (2026-10-09): the agent picked inside the consent line, "Bring these in" by the pager, no Refine chip.
    assert.match(await text(wc, '[data-connect-provider]'), /^Claude Code$/);
    assert.ok(await has(wc, '[data-connect-permission] [data-connect-pick-provider]'), 'the agent, inside "Read with your … subscription"');
    assert.equal(await has(wc, '[data-connect-library="choose"] [data-connect-chip]'), false, 'no Refine chip');
    assert.match(await text(wc, '[data-connect-foot] [data-connect-bring]'), /^Bring these in$/);
    assert.match(await text(wc, '[data-connect-foot]'), /Skip for now[\s\S]*4 of 4[\s\S]*Bring these in/);
    // Ticked and not signed in, a web app's sign-in opens by itself (2026-10-12): no Sign in to click. Google Drive first. No
    // browser whose sign-ins can be read is installed here (as with Safari only), so its check finds no sign-in and Engelbart's
    // own window opens on the tick: no Keychain modal, no waiting line. (The browser hand-off opens a real browser and reaches
    // Google, so it is test/connect.test.cjs's and test/connect-web-signin.test.cjs's, on fixtures.)
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'no sign-in window before a tick');
    await press(wc, '[data-connect-app="Google Docs"]');
    const googleWindow = await until(() => BrowserWindow.getAllWindows().find((other) => other !== win), 'Engelbart\'s sign-in window, for Google, on the tick');
    assert.equal(await has(wc, '[data-connect-keychain]'), false, 'no Keychain modal');
    assert.equal(await has(wc, '[data-connect-here]'), false, 'no browser waited on, so no "Sign in here instead"');
    // ChatGPT and Gmail ticked while it is open: one popup at a time, and Gmail shares Google's.
    await press(wc, '[data-connect-source="chats"] button[aria-expanded]');
    await press(wc, '[data-connect-app="ChatGPT"]');
    assert.equal(await attr(wc, '[data-connect-app=ChatGPT] [role=checkbox]', 'aria-checked'), 'true');
    await press(wc, '[data-connect-source="email"] button[aria-expanded]');
    await press(wc, '[data-connect-app="Gmail"]');
    await until(() => has(wc, '[data-connect-signin="ChatGPT"]'), 'ChatGPT checked: not signed in, waiting its turn');
    assert.doesNotMatch(await text(wc, '[data-connect-app=ChatGPT]'), /after you start|Needs Chrome/);
    assert.equal(await has(wc, '[data-connect-gmail-consent]'), false, 'no Gmail line with Gmail ticked (2026-10-12, second test run)');
    assert.doesNotMatch(await text(wc, '[data-connect-library="choose"]'), /Engelbart searches your Gmail/);
    assert.doesNotMatch(await text(wc, '[data-connect-app="Google Docs"]'), /Google needs|Chrome, Brave or Firefox/);
    await pause(400);
    assert.equal(BrowserWindow.getAllWindows().length, 2, 'one sign-in window at a time: ChatGPT waits, Gmail has Google\'s');
    await shot(wc, '1-sign-in-rows');
    // Closed without signing in (2026-10-12, third run): a no, so Google Drive and Gmail, which share its sign-in, are
    // unticked, and say nothing of it; not left ticked with a Sign in that Bring these in would ask for again. The chain
    // stops there: ChatGPT's window never opens, and ChatGPT keeps its tick and Sign in.
    googleWindow.close();
    await until(async () => (await attr(wc, '[data-connect-app="Google Docs"] [role=checkbox]', 'aria-checked')) === 'false', 'Google Drive unticked, after the window is closed');
    assert.equal(await attr(wc, '[data-connect-app="Gmail"] [role=checkbox]', 'aria-checked'), 'false', 'Gmail, sharing its sign-in, unticked too');
    assert.equal(await has(wc, '[data-connect-signin="Google Docs"]'), false, 'no Sign in on an unticked row');
    assert.equal(await has(wc, '[data-connect-signin="Gmail"]'), false);
    await pause(500);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'the chain stopped: no window for ChatGPT');
    assert.equal(await attr(wc, '[data-connect-app=ChatGPT] [role=checkbox]', 'aria-checked'), 'true', 'ChatGPT, another sign-in, keeps its tick');
    assert.ok(await has(wc, '[data-connect-signin="ChatGPT"]'), 'and its Sign in');
    const agentsBrowser = electronSession.fromPartition(stagePartition(false));

    /* ------------------------------------------------ turned down: Engelbart's sign-in windows open by themselves, in turn */
    // 2026-10-12, second test run. macOS would ask for Chrome's sign-ins for Claude and Google Drive (main's answers stood
    // in for: no browser is installed here), so the Keychain modal asks; Not now opens Engelbart's window for Claude by
    // itself, then, once it signs in, Google's. Signed in, Google Drive is ✓ and Gmail, unticked, says nothing of it until
    // ticked. Then Deny at macOS's prompt for Perplexity's and Grok's checks: Perplexity's window opens by itself, and closed
    // without signing in, the chain stops there: Perplexity is unticked (2026-10-12, third run), Grok's window never opens
    // and Grok keeps its tick and Sign in. Ticked again, Perplexity's sign-in starts again.
    const windows = [];
    standIns['connect-signin-note'] = (app) => (['Claude', 'Google Docs'].includes(app) ? { browser: 'Chrome', note: 'macOS will ask for Chrome\'s sign-ins.', profiles: [] } : ['Perplexity', 'Grok'].includes(app) ? { browser: '', note: '', profiles: [] } : undefined);
    standIns['connect-signin-check'] = (app) => (['Perplexity', 'Grok'].includes(app) ? { status: 'refused', browser: 'Chrome' } : undefined);
    standIns['connect-signin-window'] = (app) => new Promise((resolve) => windows.push({ app, resolve }));
    const tickNow = (app) => js(wc, `document.querySelector(${JSON.stringify(`[data-connect-app="${app}"]`)}).click()`); // through the Keychain modal's cover
    const signedInText = /✓ Signed in/;
    await tickNow('Claude');
    await tickNow('Google Docs');
    await until(() => has(wc, '[data-connect-signin-not-now="Chrome"]'), 'the Keychain modal, Not now');
    await pause(300);
    assert.equal(windows.length, 0, 'no window before Not now');
    await press(wc, '[data-connect-signin-not-now="Chrome"]');
    await until(() => windows.length === 1, 'Claude\'s window, by itself');
    assert.equal(windows[0].app, 'Claude');
    await pause(300);
    assert.equal(windows.length, 1, 'one window at a time');
    windows[0].resolve({ status: 'signed-in' });
    await until(() => windows.length === 2, 'the next window, for Google, by itself');
    assert.equal(windows[1].app, 'Google Docs');
    assert.match(await text(wc, '[data-connect-app="Claude"]'), signedInText);
    windows[1].resolve({ status: 'signed-in' });
    await until(async () => signedInText.test(await text(wc, '[data-connect-app="Google Docs"]')), 'Google Drive ✓');
    await pause(300);
    assert.equal(windows.length, 2, 'none left: no more windows');
    await until(() => has(wc, '[data-connect-app="Gmail"]'), 'Gmail\'s row (Email still open)');
    assert.equal(await attr(wc, '[data-connect-app=Gmail] [role=checkbox]', 'aria-checked'), 'false');
    assert.doesNotMatch(await text(wc, '[data-connect-app="Gmail"]'), /Signed in|Sign in/, 'unticked Gmail says nothing of Google\'s sign-in');
    await tickNow('Gmail');
    await until(async () => signedInText.test(await text(wc, '[data-connect-app="Gmail"]')), 'ticked, Gmail ✓ at once (the sign-in was kept)');
    await tickNow('Gmail');
    await until(async () => !/Signed in/.test(await text(wc, '[data-connect-app="Gmail"]')), 'unticked again, no ✓');
    await press(wc, '[data-connect-source="email"] button[aria-expanded]');
    await tickNow('Perplexity');
    await until(() => windows.length === 3, 'Perplexity\'s window, by itself after macOS\'s Deny');
    assert.equal(windows[2].app, 'Perplexity');
    await tickNow('Grok');
    await pause(400);
    assert.equal(windows.length, 3, 'Grok waits its turn');
    windows[2].resolve({ status: 'closed' });
    await until(async () => (await attr(wc, '[data-connect-app="Perplexity"] [role=checkbox]', 'aria-checked')) === 'false', 'Perplexity unticked: its window was closed');
    assert.equal(await has(wc, '[data-connect-signin="Perplexity"]'), false, 'no Sign in on its unticked row');
    await pause(400);
    assert.equal(windows.length, 3, 'closed without signing in: the chain stops, Grok\'s window never opens');
    assert.equal(await attr(wc, '[data-connect-app="Grok"] [role=checkbox]', 'aria-checked'), 'true', 'Grok, waiting its turn, keeps its tick');
    assert.ok(await has(wc, '[data-connect-signin="Grok"]'), 'Grok keeps its Sign in');
    assert.match(await text(wc, '[data-connect-app="Claude"]'), signedInText, 'signed in: still ticked, with ✓');
    await tickNow('Perplexity');
    await until(() => windows.length === 4, 'ticked again, Perplexity\'s sign-in starts again (Deny, then its window)');
    assert.equal(windows[3].app, 'Perplexity');
    windows[3].resolve({ status: 'closed' });
    await until(async () => (await attr(wc, '[data-connect-app="Perplexity"] [role=checkbox]', 'aria-checked')) === 'false', 'closed again: unticked again');
    for (const app of ['Claude', 'Google Docs', 'Grok']) await tickNow(app);
    for (const name of Object.keys(standIns)) delete standIns[name];
    for (const app of ['Claude', 'Google Docs', 'Perplexity', 'Grok']) assert.equal(await attr(wc, `[data-connect-app="${app}"] [role=checkbox]`, 'aria-checked'), 'false', `${app} unticked again`);
    // MATH-114: asking ChatGPT what it remembers is ticking it; one checkbox, naming the provider, for the rest.
    assert.doesNotMatch(await text(wc, '[data-connect-app=ChatGPT]'), /asks what it remembers/, 'that is for the refine chat');
    // Now-3a-Fix: no summary beside a section's name, and a line under an app only when it needs something.
    assert.equal(await has(wc, '[data-connect-summary]'), false, 'no summary beside the section names');
    assert.equal((await text(wc, '[data-connect-app=Obsidian]')).replace('✓', ''), 'Obsidian', 'a folder found says nothing under the name');
    assert.ok(await js(wc, '!!document.querySelector("[data-connect-app=Obsidian] [title]") && /~/.test(document.querySelector("[data-connect-app=Obsidian] [title]").title)'), 'the folder is in its tooltip');
    assert.match(await text(wc, '[data-connect-app=Notion]'), /Needs sign-in$/);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-connect-permission]").length'), 1, 'one consent checkbox');
    // The consent card directly under the Code row, inside the sources' scrolling list (2026-10-12, second test run), not
    // pinned above the foot: no source row after it.
    assert.equal(await js(wc, '!!document.querySelector("[data-connect-sources-box] [data-connect-permissions]")'), true, 'the consent card is in the sources\' scrolling box');
    const after = (a, b) => js(wc, `!!(document.querySelector(${JSON.stringify(a)}).compareDocumentPosition(document.querySelector(${JSON.stringify(b)})) & Node.DOCUMENT_POSITION_FOLLOWING)`);
    assert.equal(await after('[data-connect-source="code"]', '[data-connect-permissions]'), true, 'after the Code row');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-connect-source]")].pop().dataset.connectSource'), 'code', 'Code is the last source');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-connect-source],[data-connect-app]")].some((el)=>!!(document.querySelector("[data-connect-permissions]").compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))'), false, 'no source or row under it');
    assert.equal(await js(wc, '(()=>{const c=document.querySelector("[data-connect-permissions]").getBoundingClientRect();const r=[...document.querySelectorAll("[data-connect-source]")].pop().getBoundingClientRect();return c.top>=r.bottom-1&&c.top-r.bottom<40})()'), true, 'drawn just under the Code row');
    assert.equal(await attr(wc, '[data-connect-permission]', 'role'), 'switch');
    assert.match(await text(wc, '[data-connect-permission]'), /^Read with your Claude Code subscription/);
    assert.match(await text(wc, '[data-connect-permission]'), /What leaves my Mac\?$/, 'one card: the reassurance under the words');
    assert.doesNotMatch(await text(wc, '[data-connect-permissions]'), /what (it|they) remembers?/, 'no "Ask … remember" row');
    assert.match(await text(wc, '[data-connect-reassure]'), /^Uses the plan you already have, so there's no API key to set up\. Saved only on your Mac, and Mathetic never receives it\. What leaves my Mac\?$/);
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
    assert.equal(await after('[data-connect-github]', '[data-connect-permissions]'), true, 'Code open: the card after its rows');
    const github = JSON.parse(await js(wc, 'JSON.stringify(document.querySelector("[data-connect-github]").getBoundingClientRect())'));
    assert.ok(github.height >= 300, `the repository list has room: ${github.height}`);
    await js(wc, 'document.querySelector("[data-connect-permissions]").scrollIntoView({block:"center"})');
    await pause(200);
    await shot(wc, '1b-permissions');
    await press(wc, '[data-connect-source="code"] button[aria-expanded]');

    /* ------------------------------------------------ Bring these in: ChatGPT is not signed in, so a modal asks first */
    await press(wc, '[data-connect-library="choose"] [data-connect-bring]');
    await until(() => has(wc, '[data-connect-signin-gate="ask"]'), 'the sign-in modal, before the run');
    assert.match(await text(wc, '[data-connect-signin-gate]'), /ChatGPT needs you to sign in[\s\S]*Leave it out\s*Sign in$/);
    await shot(wc, '1d-sign-in-first');
    await press(wc, '[data-connect-signin-go]');
    await until(() => has(wc, '[data-connect-signin-gate="signing"]'), 'signing in, in the window');
    await agentsBrowser.cookies.set({ url: 'https://chatgpt.com/', domain: '.chatgpt.com', name: '__Secure-next-auth.session-token', value: 'smoke', secure: true });

    /* ------------------------------------------------ refine: a card with one option per line, no sign-in card, the survey's findings */
    // No opening line (2026-10-09): the dots in the middle until the librarian says something, then never again.
    await until(async () => (await has(wc, '[data-connect-chat] [data-connect-starting]')) || has(wc, '[data-connect-chat] [data-connect-agent]'), 'the dots, or the librarian already');
    if (await has(wc, '[data-connect-chat] [data-connect-starting]')) {
      // The starting view: the dots and how far (2026-10-09), and the line under the chat waits for it to go.
      assert.match(await text(wc, '[data-connect-starting]'), /Getting to know your library/);
      assert.equal(await has(wc, '[data-connect-starting-now]'), false, 'not what each agent is doing');
      assert.equal(await has(wc, '[data-connect-starting-line]'), false, 'no line moving through the jobs (2026-10-12, second test run)');
      await shot(wc, '1c-starting');
    } else assert.doesNotMatch(await text(wc, '[data-connect-chat]'), /Looking at what you picked|Found \d/, 'no opening line in the chat');
    // One button by the pager once a session exists (2026-10-09, David's mockup): "Skip the rest"; Skip for now gone.
    // Quiet while it says so (2026-10-11): white, a hairline, grey words, so Submit is the loudest thing on the screen.
    await until(() => has(wc, '[data-connect-foot] [data-connect-import]'), 'the chat\'s button by the pager');
    assert.match(await text(wc, '[data-connect-import]'), /^Skip the rest$/);
    assert.equal(await has(wc, '[data-onboarding-skip]'), false, 'no Skip for now with a session');
    const footLook = () => js(wc, '(()=>{const s=getComputedStyle(document.querySelector("[data-connect-import]"));return [s.backgroundColor,s.borderTopColor,s.color].join(" | ")})()');
    assert.equal(await footLook(), 'rgb(255, 255, 255) | rgb(234, 234, 234) | rgb(77, 77, 77)', 'Skip the rest stays quiet');
    await until(() => has(wc, '[data-connect-card="live"] [data-connect-option="Everything"]'), 'the notes question, as a card');
    assert.equal(await attr(wc, '[data-connect-import]', 'data-ready'), '0', 'Import is not lit while questions remain');
    await shot(wc, '2-card');
    await press(wc, '[data-connect-card="live"] [data-connect-option="Everything"]');
    await press(wc, '[data-connect-card="live"] [data-connect-submit]');
    await until(() => has(wc, '[data-connect-answered]'), 'the answered question, folded to one line');
    assert.match(await text(wc, '[data-connect-answered]'), /What from notes\?/);
    assert.equal(await has(wc, '[data-connect-need-done]'), false, 'no Done');
    assert.equal(await has(wc, '[data-connect-need-signins]'), false, 'nothing brought over from Chrome');
    // Signed in before the run (2026-10-11): no sign-in card on the refine screen.
    assert.equal(await has(wc, '[data-connect-needs]'), false, 'no sign-in card in the chat');
    assert.equal(await js(wc, 'window.engelbartAPI.connectList().then((list) => list[0].needs.length)'), 0);
    await until(() => has(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]'), 'the survey\'s findings, one per line', 400);
    assert.equal(await attr(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]', 'role'), 'checkbox', 'several can be picked');
    await pause(400); // the chat scrolls to its newest message first
    // An option (2026-10-12): its label and its why, never cut off. Its detail stays in the data but is not shown (no
    // detail line, no ⓘ, no popover). Nothing comes ticked, and no option is tagged "Recommended".
    const item1 = '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]';
    assert.equal(await has(wc, '[data-connect-option-detail], .cx-opt-detail'), false, 'no detail line');
    assert.doesNotMatch(await text(wc, item1), /ChatGPT item 1 · doc · 2026-10-01/, 'the detail\'s text is not shown');
    assert.match(await text(wc, `${item1} .cx-opt-label`), /^ChatGPT item 1$/);
    const uncut = await js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(item1 + ' .cx-opt-label')});return el.getBoundingClientRect().width>0&&el.scrollWidth<=el.clientWidth+1&&getComputedStyle(el).textOverflow!=='ellipsis'})()`);
    assert.equal(uncut, true, 'the label is not cut off');
    assert.equal(await has(wc, '[data-connect-option-info], .cx-info, [role="tooltip"]'), false, 'no ⓘ and no popover');
    assert.equal(await has(wc, '[data-connect-option-recommended]'), false, 'no "Recommended" tag');
    assert.doesNotMatch(await text(wc, '[data-connect-card="live"]'), /Recommended/);
    await shot(wc, '3b-option');
    assert.equal(await attr(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]', 'aria-checked'), 'false', 'the recommendation comes unticked');
    assert.equal(await js(wc, 'document.querySelector("[data-connect-card=\\"live\\"] [data-connect-submit]").disabled'), true, 'Submit waits for a tick');
    // Skip and Submit pinned to the bottom of the chat while the card is live.
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-connect-card=\\"live\\"] [data-connect-card-actions]")).position'), 'sticky');
    await press(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]');
    assert.equal(await attr(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]', 'aria-checked'), 'true', 'the recommendation ticked');
    assert.equal(await js(wc, 'document.querySelector("[data-connect-card=\\"live\\"] [data-connect-submit]").disabled'), false, 'Submit ready once one is ticked');
    await press(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 2"]');
    assert.equal(await attr(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 2"]', 'aria-checked'), 'true', 'a second one ticked beside it');
    await press(wc, '[data-connect-card="live"] [data-connect-submit]');
    await until(async () => (await attr(wc, '[data-connect-import]', 'data-ready')) === '1', 'nothing more to ask', 400);
    assert.match(await text(wc, '[data-connect-import]'), /^Bring these in$/);
    assert.equal(await footLook(), 'rgb(23, 23, 23) | rgb(23, 23, 23) | rgb(255, 255, 255)', 'Bring these in is the main button');
    assert.match(await text(wc, '[data-connect-foot-status]'), /^(Bringing in .+|Looking through your apps|Everything’s in|Everything's in)/, 'what is coming in, at the foot (MATH-146: names, not a count)');
    await pause(500); // the button's colour fades in
    await shot(wc, '4-chat-done');

    /* ------------------------------------------------ Import: the working view, MEMORY.md */
    await press(wc, '[data-connect-import]');
    await until(() => has(wc, '[data-connect-library="working"]'), 'the working view');
    assert.match(await text(wc, '[data-connect-progress] h1'), /^(Bringing everything in|Your library is connected)$/);
    assert.ok(await has(wc, '[data-connect-progress] [data-connect-done]'), 'Continue at its foot');
    await shot(wc, '5a-bringing');
    await until(async () => (await attr(wc, '[data-connect-memory]', 'data-connect-memory')) === 'saved', 'MEMORY.md saved', 600);
    const progress = await text(wc, '[data-connect-progress]');
    assert.match(progress, /✓ 4 added/, 'the vault\'s four notes');
    assert.match(progress, /Summary of your library\s*Saved as MEMORY\.md\s*Saved · 1 secret masked/);
    assert.doesNotMatch(progress, /Activity/, 'no activity log');
    const memoryFile = fs.readFileSync(path.join(root, '.engelbart', 'MEMORY.md'), 'utf8');
    assert.equal(fs.existsSync(path.join(root, '.engelbart', 'test', 'MEMORY.md')), false, 'the normal library\'s, not test mode\'s');
    assert.doesNotMatch(memoryFile, /hunter2|sk-test/, 'MEMORY.md without its secrets');
    await shot(wc, '5-working');
    await press(wc, '[data-connect-done]');

    /* ------------------------------------------------ the end of onboarding: the project made, what came in is the library's files, the chip */
    await until(() => js(wc, '!document.querySelector("[data-onboarding]")'), 'the project made and open, after Connect', 400);
    assert.deepEqual(await js(wc, 'window.engelbartAPI.listProjects().then((list)=>list.map((p)=>p.name))'), ['Connect smoke'], 'the project Create named');
    const names = await js(wc, `window.engelbartAPI.library().then((rows)=>rows.filter((row)=>row.type==='md'&&!row.project_id&&/[\\/]assets[\\/]md[\\/]/.test(row.path||'')).map((row)=>row.name).sort())`);
    assert.deepEqual(names, ['2026-10-01', 'ChatGPT fake note', 'Help-seeking', 'Tools for thought', 'Tutoring'], 'Markdown files of the library, in assets/md');
    await until(() => has(wc, '[data-connect-dock="done"]'), 'the chip: the library is connected');
    assert.match(await text(wc, '[data-connect-dock]'), /^Library ✓/);
    assert.equal(await attr(wc, '[data-connect-dock-open]', 'data-connect-dock-text'), 'Library connected · 5 added · MEMORY.md saved');
    const chip = await js(wc, 'JSON.stringify(document.querySelector("[data-connect-dock]").getBoundingClientRect())');
    assert.ok(JSON.parse(chip).width < 170, `the chip stays small beside the bell: ${chip}`);
    assert.equal(await has(wc, '[data-connect-popup]'), false, 'no offer: this person connected their library in onboarding');
    assert.equal(await has(wc, '[data-import-offer]'), false, 'nor Import Context: their library is imported (MEMORY.md)');
    assert.equal(await text(wc, '[data-sb-count="inbox"]'), '1', 'the sidebar\'s Inbox says the library is connected');
    await shot(wc, '6-project');
    await press(wc, '[data-connect-dock-open]');
    await until(() => has(wc, '[data-connect-popup="session"] [data-connect-library="working"]'), 'the chip opens it again');
    await shot(wc, '7-popup');
    await press(wc, '[data-connect-close]');
    await until(() => js(wc, '!document.querySelector("[data-connect-popup]")'), 'closed again');

    /* ------------------- the Welcome walkthrough (2026-10-09): the Library's tabs, @brainstorm, @discover */
    await until(() => has(wc, '[data-getting-started]'), 'Get started under the Welcome workspace\'s title');
    assert.equal(await js(wc, 'document.querySelector("[data-doc-title]").value'), 'Welcome');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-getting-started-step]").length'), 3, 'three steps');
    assert.match(await text(wc, '[data-getting-started-step="2"] [data-getting-started-title]'), /Brainstorm what to do next/);
    assert.match(await text(wc, '[data-getting-started-step="3"] [data-getting-started-title]'), /Find prior work/);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-getting-started-line]").length'), 2, 'the line from each circle down to the next');
    assert.equal(await attr(wc, '[data-getting-started-step="1"]', 'data-open'), '1', 'the first step open');
    assert.ok(await has(wc, '[data-getting-started-row^="1:"]'), 'the Library\'s tabs, under step 1');
    assert.ok(await has(wc, '[data-editor][data-empty-hint]'), '"Write your thoughts…" on the empty line');
    assert.match(await text(wc, '[data-getting-started] h2'), /^Get started$/);
    await shot(wc, '8-welcome');
    const project = await js(wc, 'window.engelbartAPI.listProjects().then((list)=>list[0].id)');
    await press(wc, '[data-getting-started-row^="1:"]');
    await until(async () => (await attr(wc, '[data-getting-started-step="1"]', 'data-done')) === '1', 'opening the Library ticks step 1');
    await until(async () => (await attr(wc, '[data-library-chip="notes"]', 'aria-pressed')) === 'true', 'the Library open on the Notes tab');
    await until(async () => (await attr(wc, '[data-getting-started-step="2"]', 'data-open')) === '1', 'step 2 opens next');
    await js(wc, 'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    assert.ok(await has(wc, '[data-getting-started-row="2:brainstorm"]'), '@brainstorm under step 2');
    assert.deepEqual((await js(wc, `window.engelbartAPI.gettingStarted(${JSON.stringify(project)})`)).ticked, [1]);
    await press(wc, '[data-getting-started-title="3"]');
    await until(() => has(wc, '[data-getting-started-row="3:discover"]'), '@discover under step 3');
    await shot(wc, '8b-steps');
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
