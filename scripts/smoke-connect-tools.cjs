'use strict';

// npm run build && npx electron scripts/smoke-connect-tools.cjs
// "signing into claude code and/or codex must be done before this step", since 2026-10-16 (the onboarding beta's S3) a
// popup over Welcome, not a screen: the real app, hidden, in test mode on disposable data, on a pretend Mac
// (ENGELBART_TOOLS_FAKE) where Claude Code is installed but signed out and Codex is missing; which can run is the tool
// check's answer (ENGELBART_CONNECT_FAKE_CLI). Welcome has no pager (no tools screen to count); Continue opens "Use Claude
// Code, Codex, or both?" over Welcome, nothing chosen and its button waiting; no subtext, no version anywhere, Skip plain
// text far left. Codex installs as soon as it is chosen ("Connecting…", never "Installing"), then "Connect to ChatGPT";
// Claude Code reads "Connect to Claude", both "Connect to Claude and ChatGPT". Claude Code's Connect (the fake's sign-in,
// which ends by itself) makes it ready, and the popup closes by itself onto Import your context, whose Import context then
// asks nothing.
// ENGELBART_CONNECT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-connect-tools-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ git: '2.50.0', claude: '2.1.300 signed-out', codex: 'missing' });
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_CONNECT_FAKE_CLI = '1';
process.env.ENGELBART_CONNECT_FAKE_MS = '150';
process.env.ENGELBART_CONNECT_APPLICATIONS = '';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = '';
delete process.env.ENGELBART_PROVIDERS_FAKE;
const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: true });
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => {
  const { x, y } = await until(() => spot(wc, selector), selector);
  wc.focus();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(150);
};
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const text = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const step = (wc) => js(wc, 'document.querySelector("[data-onboarding]") && document.querySelector("[data-onboarding]").dataset.step');
const flow = (wc) => js(wc, '(()=>{const el=document.querySelector("[data-import-flow]");return el?{screen:el.dataset.screen,dialog:el.dataset.dialog}:null})()');
const tools = (wc) => js(wc, 'window.engelbartAPI.tools()');
// The popup's button: { label, action, disabled }.
const primary = (wc) => js(wc, '(()=>{const b=document.querySelector("[data-agent-popup] [data-agent-primary]");return b?{label:b.textContent.trim(),action:b.dataset.agentPrimary,disabled:b.disabled}:null})()');
const labelIs = (wc, label, tries) => until(async () => { const b = await primary(wc); return b && b.label === label && !b.disabled ? b : null; }, `"${label}"`, tries);
// No version, no subtext, Skip in plain text at the far left (S3), whatever the popup shows.
async function plain(wc, when) {
  const words = await text(wc, '[data-agent-popup] .modal');
  assert.doesNotMatch(words, /\d+\.\d+/, `no version in the popup (${when}): ${words}`);
  assert.doesNotMatch(words, /Installing|Skip for now/, `never "Installing", nor "Skip for now" (${when})`);
  assert.equal(await js(wc, 'document.querySelectorAll("[data-agent-popup] small, [data-agent-popup] .modal h3 + p").length'), 0, `no subtext (${when})`);
  const skip = await js(wc, '(()=>{const s=document.querySelector("[data-agent-skip]");const m=document.querySelector("[data-agent-popup] .modal").getBoundingClientRect();const r=s.getBoundingClientRect();const c=getComputedStyle(s);const rows=[...document.querySelectorAll("[data-agent-choice]")].map((b)=>b.getBoundingClientRect().left);return{text:s.textContent.trim(),plain:c.backgroundColor==="rgba(0, 0, 0, 0)"&&parseFloat(c.borderTopWidth)===0,left:r.left-m.left,rows:Math.min(...rows)-m.left,others:[...document.querySelectorAll("[data-agent-popup] .mf button")].every((b)=>b===s||b.getBoundingClientRect().left>r.right)}})()');
  assert.equal(skip.text, 'Skip');
  assert.equal(skip.plain, true, `Skip is plain text (${when})`);
  assert.ok(skip.others && Math.abs(skip.left - skip.rows) <= 2, `Skip at the far left, level with the rows (${when}): ${JSON.stringify(skip)}`);
}
const SHOTS = process.env.ENGELBART_CONNECT_SHOTS;
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
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    await until(() => tools(wc).then((snap) => snap && snap.checked), 'the launch check');
    // The pager counts only screens that exist: Welcome is the only one of its own now (it read "1 of 3", then "2 of 4").
    assert.equal(await has(wc, '[data-onboarding-step-of]'), false, `no pager on Welcome: ${await text(wc, '[data-onboarding-step-of]')}`);
    await press(wc, '[data-onboarding-continue] button');

    /* the popup over Welcome, in place of the tools screen */
    await until(() => has(wc, '[data-agent-popup] [data-agent-choice]'), 'Use Claude Code, Codex, or both? over Welcome');
    assert.equal(await step(wc), 'welcome', 'over Welcome, no screen of its own');
    assert.equal(await has(wc, '[data-tool-row], [data-onboarding-tools]'), false, 'no tools screen');
    assert.equal(await text(wc, '[data-agent-popup] h3'), 'Use Claude Code, Codex, or both?');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-agent-choice]")].map((b)=>b.textContent.trim())'), ['Claude Code', 'Codex', 'Both']);
    assert.equal(await js(wc, 'document.querySelectorAll("[data-agent-choice][aria-checked=true]").length'), 0, 'nothing chosen for them');
    assert.equal((await primary(wc)).disabled, true, 'its button waits for a choice');
    await plain(wc, 'nothing chosen');
    await shot(wc, 'tools-1-popup');

    /* Codex: installed at once on choosing it ("Connecting…"), then its sign-in */
    await press(wc, '[data-agent-choice="codex"]');
    await until(() => tools(wc).then((snap) => snap.tools.codex.busy && snap.tools.codex.busy.action === 'install'), 'Codex installing on its choice');
    const installing = await primary(wc);
    assert.deepEqual([installing.label, installing.disabled], ['Connecting…', true], `Codex being installed reads "Connecting…": ${JSON.stringify(installing)}`);
    assert.equal(await js(wc, 'document.querySelector("[data-agent-popup] .agent-setup").dataset.agentState'), 'waiting');
    await plain(wc, 'Codex installing');
    await shot(wc, 'tools-2-codex-installing');
    await labelIs(wc, 'Connect to ChatGPT', 600);
    assert.equal((await tools(wc)).tools.codex.status, 'signed-out', 'installed, waiting for its sign-in');
    assert.equal((await primary(wc)).action, 'sign-in');
    await plain(wc, 'Codex installed');
    /* the label per choice */
    await press(wc, '[data-agent-choice="claude"]');
    await labelIs(wc, 'Connect to Claude');
    await press(wc, '[data-agent-choice="both"]');
    await labelIs(wc, 'Connect to Claude and ChatGPT');
    await plain(wc, 'both');
    await shot(wc, 'tools-3-both');

    /* Claude Code's Connect: its own sign-in; once it runs the popup closes by itself */
    await press(wc, '[data-agent-choice="claude"]');
    await labelIs(wc, 'Connect to Claude');
    await shot(wc, 'tools-4-claude');
    await press(wc, '[data-agent-popup] [data-agent-primary="sign-in"]');
    await until(() => tools(wc).then((snap) => snap.tools.claude.busy && snap.tools.claude.busy.action === 'sign-in'), 'Claude Code\'s sign-in');
    assert.equal((await tools(wc)).tools.codex.busy, null, 'only the one chosen signs in');
    await until(async () => !(await has(wc, '[data-agent-popup]')), 'the popup gone once Claude Code runs, no Continue pressed', 400);
    assert.equal((await tools(wc)).tools.claude.signedIn, true);

    /* on to Import your context, which asks nothing more */
    await until(async () => { const f = await flow(wc); return f && f.screen === 'intro' && !f.dialog; }, 'Import your context next');
    await shot(wc, 'tools-5-intro');
    await press(wc, '[data-import-start]');
    const after = await until(async () => { const f = await flow(wc); return f && (f.dialog || f.screen !== 'intro') ? f : null; }, 'Import context goes on');
    assert.notEqual(after.dialog, 'tools-setup', `Claude Code runs: no popup asking again (${JSON.stringify(after)})`);
    assert.equal(await has(wc, '[data-agent-choice]'), false, 'no agent popup');
    console.log(`Connect tools smoke passed. Data: ${root}`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    const wc = BrowserWindow.getAllWindows()[0] && BrowserWindow.getAllWindows()[0].webContents;
    if (wc) { console.error(await js(wc, 'document.body.innerText').catch(() => '')); await shot(wc, 'tools-failed').catch(() => {}); }
    app.exit(1);
  }
});
