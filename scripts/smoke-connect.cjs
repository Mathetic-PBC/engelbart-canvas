'use strict';

// npm run build && npx electron scripts/smoke-connect.cjs
// Runs the real app, hidden, against disposable data in the normal library (test mode off, as the app people download
// runs it: Connect left test mode on 2026-10-08) with Connect your library's fake agents
// (ENGELBART_CONNECT_FAKE), and walks a new user's onboarding through it (src/renderer/screens/ConnectLibrary.jsx,
// src/main/connect): no tools screen (both agents signed in), Create before Connect (2026-10-10: its name and description
// filled first, no folder part), Connect in place of Add to your library and Custom instructions, and no Project context
// (welcome, create, connect: Connect "3 of 3"); the choose screen starts with Notes ticked (a vault
// Obsidian knows), ChatGPT ticked by hand, the permissions card naming it; Refine opens the chat, its first line said at
// once, whose question is a card with one option per line; ChatGPT, signed in nowhere this disposable home can read, has
// Sign in on its row (2026-10-11); Google Drive and Gmail, whose sign-in is made in the person's browser, say Google needs
// Chrome, Brave or Firefox (none here), and never offer Engelbart's window;
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
    // The intro (2026-10-11, David's mockup): why Engelbart asks, where the data goes, the apps on a belt; then Connect.
    await until(async () => (await step(wc)) === 'intro', 'the intro, after Create');
    assert.match(await text(wc, '[data-connect-intro] h1'), /^All your context in one place$/);
    assert.match(await text(wc, '[data-onboarding-step-of]'), /^3 of 4$/);
    assert.match(await text(wc, '[data-connect-intro-a="where"]'), /^It’s saved only on this Mac\./, 'the first question open');
    assert.ok(await has(wc, '[data-connect-intro-belt]'), 'Connects to, on a belt');
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
    await press(wc, '[data-connect-source="chats"] button[aria-expanded]');
    await press(wc, '[data-connect-app="ChatGPT"]');
    assert.equal(await attr(wc, '[data-connect-app=ChatGPT] [role=checkbox]', 'aria-checked'), 'true');
    // No browser here holds its sign-in (2026-10-11): Sign in on its row, not "You'll sign in after you start".
    await until(() => has(wc, '[data-connect-signin="ChatGPT"]'), 'ChatGPT\'s Sign in');
    assert.doesNotMatch(await text(wc, '[data-connect-app=ChatGPT]'), /after you start|Needs Chrome/);
    // Google Drive and Gmail share one Google sign-in, made in the person's browser (2026-10-12: Google refuses Engelbart's
    // window). No browser whose sign-ins can be read is installed here (as with Safari only), so both rows say what Google
    // needs, with no Sign in and never Engelbart's window. (The hand-off itself opens a real browser and reaches Google, so
    // it is test/connect.test.cjs's and test/connect-web-signin.test.cjs's, on fixtures.)
    await press(wc, '[data-connect-app="Google Docs"]');
    await press(wc, '[data-connect-source="email"] button[aria-expanded]');
    await press(wc, '[data-connect-app="Gmail"]');
    const googleNeeds = /Google needs Chrome, Brave or Firefox\./;
    await until(async () => googleNeeds.test(await text(wc, '[data-connect-app="Google Docs"]')) && googleNeeds.test(await text(wc, '[data-connect-app="Gmail"]')), 'what Google needs, on both rows');
    assert.equal(await has(wc, '[data-connect-signin="Google Docs"]'), false, 'no Sign in on Google Drive: its window is not offered');
    assert.equal(await has(wc, '[data-connect-signin="Gmail"]'), false, 'no Sign in on Gmail');
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'no sign-in window');
    await shot(wc, '1-sign-in-rows');
    const agentsBrowser = electronSession.fromPartition(stagePartition(false));
    await press(wc, '[data-connect-app="Google Docs"]');
    await press(wc, '[data-connect-app="Gmail"]');
    await press(wc, '[data-connect-source="email"] button[aria-expanded]');
    // MATH-114: asking ChatGPT what it remembers is ticking it; one checkbox, naming the provider, for the rest.
    assert.doesNotMatch(await text(wc, '[data-connect-app=ChatGPT]'), /asks what it remembers/, 'that is for the refine chat');
    // Now-3a-Fix: no summary beside a section's name, and a line under an app only when it needs something.
    assert.equal(await has(wc, '[data-connect-summary]'), false, 'no summary beside the section names');
    assert.equal((await text(wc, '[data-connect-app=Obsidian]')).replace('✓', ''), 'Obsidian', 'a folder found says nothing under the name');
    assert.ok(await js(wc, '!!document.querySelector("[data-connect-app=Obsidian] [title]") && /~/.test(document.querySelector("[data-connect-app=Obsidian] [title]").title)'), 'the folder is in its tooltip');
    assert.match(await text(wc, '[data-connect-app=Notion]'), /Needs sign-in$/);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-connect-permission]").length'), 1, 'one consent checkbox');
    assert.equal(await js(wc, '!!document.querySelector("[data-connect-sources-box] [data-connect-permissions]")'), false, 'the consent card is above the sources now (2026-10-11), not under them');
    assert.equal(await js(wc, 'document.querySelector("[data-connect-permissions]").compareDocumentPosition(document.querySelector("[data-connect-sources-box]")) & Node.DOCUMENT_POSITION_FOLLOWING'), 4, 'the consent first');
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
    // What an option covers (2026-10-11): an ⓘ on the recommended item (its detail: title, kind, date; MATH-122 took
    // "Everything" away from a survey's items), none on an option without one;
    // hovering opens a popover in the card, inside the window; a click on it changes nothing; Escape closes it.
    const info = '[data-connect-card="live"] [data-connect-option-info="ChatGPT item 1"]';
    assert.equal(await has(wc, info), true, 'an ⓘ on the option with a detail');
    assert.equal(await has(wc, '[data-connect-card="live"] [data-connect-option-info="ChatGPT item 2"]'), false, 'no ⓘ without a detail');
    const infoAt = await until(() => spot(wc, info), info);
    wc.sendInputEvent({ type: 'mouseMove', x: infoAt.x, y: infoAt.y });
    await until(() => js(wc, '(()=>{const p=document.querySelector("[data-connect-card=\\"live\\"] [data-connect-option-detail=\\"ChatGPT item 1\\"]");return !!p&&getComputedStyle(p).visibility==="visible"})()'), 'the popover, on hover');
    assert.match(await text(wc, '[data-connect-option-detail="ChatGPT item 1"]'), /ChatGPT item 1 · doc · 2026-10-01/);
    const inside = await js(wc, '(()=>{const r=document.querySelector("[data-connect-option-detail]").getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.width>0})()');
    assert.equal(inside, true, 'the popover is inside the window');
    await shot(wc, '3b-option-detail');
    await click(wc, infoAt);
    assert.equal(await attr(wc, '[data-connect-card="live"] [data-connect-option="ChatGPT item 1"]', 'aria-checked'), 'true', 'the recommendation comes ticked, and clicking its ⓘ leaves it so');
    assert.equal(await has(wc, '[data-connect-card="live"]'), true, 'nor submits');
    await js(wc, 'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(async () => !(await has(wc, '[data-connect-option-detail]')), 'Escape closes it');
    // Skip and Submit pinned to the bottom of the chat while the card is live.
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-connect-card=\\"live\\"] [data-connect-card-actions]")).position'), 'sticky');
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
    assert.equal(await has(wc, '[data-guided-offer]'), false, 'nor the guided setup\'s: their onboarding was it');
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
