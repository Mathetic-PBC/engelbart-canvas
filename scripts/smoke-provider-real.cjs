'use strict';

// npm run build && npx electron scripts/smoke-provider-real.cjs
// The agent popup (2026-10-16, the onboarding beta's S3) against this Mac's REAL Claude Code and Codex, for detection
// only: the app hidden, on a disposable home, the real CLIs pointed at empty scratch config dirs for the whole run
// (CLAUDE_CONFIG_DIR, CODEX_HOME), so both are really signed out and the person's own sign-ins are never read or changed.
// Nothing is installed, updated, signed in or out: the tool manager's install/update actions, its sign-in and its
// sign-out are stand-ins that only count (patched before the app loads), Engelbart's updates are 'ask', the CLIs' own
// updaters are off (DISABLE_AUTOUPDATER, Codex's check_for_update_on_startup), and a real login through node-pty is
// refused outright. No agent runs: nothing can.
//   the launch check: both real CLIs installed and signed out, neither subscribed: nothing to run on.
//   Welcome ▸ Continue: the popup over Welcome, not straight on; no version anywhere (the real ones least of all), no
//   subtext, Skip plain text far left; "Connect to Claude", "Connect to ChatGPT", "Connect to Claude and ChatGPT" per
//   choice; Connect to Claude asks for Claude Code's own sign-in, with the real CLI's path (the stand-in ends it unsigned:
//   the popup stays, asking again). Skip goes on to Import your context, whose Import context asks again in the same
//   popup, nothing run.
// ENGELBART_IMPORT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-provider-real-')));
const emptyClaude = path.join(root, 'scratch-claude-config');
const emptyCodex = path.join(root, 'scratch-codex-home');
fs.mkdirSync(emptyClaude); fs.mkdirSync(emptyCodex);
fs.writeFileSync(path.join(emptyCodex, 'config.toml'), 'check_for_update_on_startup = false\n');
// Signed out for the whole run, never unset: the person's ~/.claude and ~/.codex are not where the CLIs look.
process.env.CLAUDE_CONFIG_DIR = emptyClaude;
process.env.CODEX_HOME = emptyCodex;
process.env.DISABLE_AUTOUPDATER = '1';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_APPLICATIONS = '';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = '';
process.env.ENGELBART_DISK_ACCESS = 'granted';
process.env.ENGELBART_BROWSER_AGENTS = 'none';
for (const key of ['ENGELBART_TOOLS_FAKE', 'ENGELBART_PROVIDERS_FAKE', 'ENGELBART_CONNECT_FAKE', 'ENGELBART_CONNECT_FAKE_CLI', 'ENGELBART_BART_FAKE']) delete process.env[key];

// Stand-ins for everything that would change the person's installs or sign-ins (src/main/index.cjs reads these when it
// loads, so they are replaced first): each only counts.
const asked = { install: [], update: [], signIn: [], signOut: [], realLogin: 0 };
const install = require('../src/main/tools/install.cjs');
install.createActions = () => ({
  installGit: async () => { asked.install.push('git'); return { ok: false, kind: 'other', error: 'Installs are refused in this smoke.' }; },
  installAgent: async (name) => { asked.install.push(name); return { ok: false, kind: 'other', error: 'Installs are refused in this smoke.' }; },
  updateAgent: async (name) => { asked.update.push(name); return { ok: false, kind: 'other', error: 'Updates are refused in this smoke.' }; },
  updateGit: async () => { asked.update.push('git'); return { ok: false, kind: 'other', error: 'Updates are refused in this smoke.' }; },
});
// An update's rollback mark and rollback (tools/install.cjs) write beside the real install: never.
install.markRollback = () => null;
install.rollback = () => false;
const signing = require('../src/main/tools/sign-in.cjs');
signing.createSignInProcess = () => (name, file) => { asked.signIn.push({ name, file }); return { done: Promise.resolve({ code: 1, output: 'A real sign-in is refused in this smoke.' }), kill: () => {} }; };
signing.createSignOutProcess = () => async (name) => { asked.signOut.push(name); return { code: 1, output: 'A real sign-out is refused in this smoke.' }; };
// And never a real sign-in through a terminal either: it would open the person's browser on their account.
const pty = require('node-pty');
const spawn = pty.spawn;
pty.spawn = (file, args, options) => {
  if (/"\$ENGELBART_TOOL" (?:auth )?log(?:in|out)\b/.test((args || []).join(' '))) { asked.realLogin += 1; throw new Error('A real sign-in is refused in this smoke'); }
  return spawn(file, args, options);
};

const home = require('../src/main/store/home.cjs');
// Updates asked for, never run.
home.writeConfig(home.ensureHome(root).root, { testMode: false, tools: { updates: 'ask' } });

require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 400) {
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
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector, tries) => { const at = await until(() => spot(wc, selector), selector, tries); await click(wc, at); };
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const text = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const flow = (wc) => js(wc, '(()=>{const el=document.querySelector("[data-import-flow]");return el?{screen:el.dataset.screen,dialog:el.dataset.dialog}:null})()');
const tools = (wc) => js(wc, 'window.engelbartAPI.tools()');
const discovery = (wc) => js(wc, 'window.engelbartAPI.importDiscovery()');
const AGENT = '.agent-setup';
const primary = (wc) => js(wc, `(()=>{const b=document.querySelector(${JSON.stringify(`${AGENT} [data-agent-primary]`)});return b?{label:b.textContent.trim(),action:b.dataset.agentPrimary,disabled:b.disabled}:null})()`);
const labelIs = (wc, label, tries) => until(async () => { const b = await primary(wc); return b && b.label === label && !b.disabled ? b : null; }, `"${label}"`, tries);
const SHOTS = process.env.ENGELBART_IMPORT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `real-${name}.png`), picture.toPNG());
}
const log = (line) => console.log(`  · ${line}`);
const untouched = (when) => assert.deepEqual({ install: asked.install, update: asked.update, signOut: asked.signOut, realLogin: asked.realLogin }, { install: [], update: [], signOut: [], realLogin: 0 }, `nothing installed, updated, signed out or really signed in (${when})`);

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1280, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    const launch = await until(() => tools(wc).then((snap) => (snap && snap.checked ? snap : null)), 'the launch check', 1200);

    /* the launch check: both real CLIs signed out */
    assert.deepEqual([launch.tools.claude.installed, launch.tools.claude.status, launch.tools.claude.signedIn], [true, 'signed-out', false], `the real Claude Code, signed out: ${JSON.stringify(launch.tools.claude)}`);
    assert.deepEqual([launch.tools.codex.installed, launch.tools.codex.status, launch.tools.codex.signedIn], [true, 'signed-out', false], `the real Codex, signed out: ${JSON.stringify(launch.tools.codex)}`);
    const providers = await js(wc, 'window.engelbartAPI.importProviders(true)');
    assert.equal(providers.decision.setup, true, 'nothing to run on');
    assert.deepEqual(providers.providers.map((one) => [one.id, one.signedIn, one.subscribed]), [['anthropic', false, false], ['openai', false, false]], 'neither signed in nor subscribed');
    const versions = [launch.tools.claude.version, launch.tools.codex.version].filter(Boolean);
    log(`launch: the real Claude Code and Codex, both signed out (${versions.join(', ')})`);

    /* Welcome ▸ Continue: neither qualifies, so the popup */
    await press(wc, '[data-onboarding-continue] button');
    await until(() => has(wc, '[data-agent-popup] [data-agent-choice]'), 'Use Claude Code, Codex, or both? over Welcome', 1200);
    assert.equal(await js(wc, 'document.querySelector("[data-onboarding]").dataset.step'), 'welcome', 'over Welcome, not straight on');
    assert.equal(await has(wc, '[data-tool-row], [data-onboarding-tools]'), false, 'no tools screen');
    const plain = async (when) => {
      const words = await text(wc, AGENT);
      for (const version of versions) assert.equal(words.includes(version), false, `the real version ${version} is not shown (${when})`);
      assert.doesNotMatch(words, /\d+\.\d+/, `no version (${when}): ${words}`);
      assert.equal(await js(wc, `document.querySelectorAll(${JSON.stringify(`${AGENT} small, ${AGENT} h3 + p`)}).length`), 0, `no subtext (${when})`);
      const skip = await js(wc, `(()=>{const s=document.querySelector(${JSON.stringify(`${AGENT} [data-agent-skip]`)});const c=getComputedStyle(s);const r=s.getBoundingClientRect();const rows=Math.min(...[...document.querySelectorAll(${JSON.stringify(`${AGENT} [data-agent-choice]`)})].map((b)=>b.getBoundingClientRect().left));return{text:s.textContent.trim(),plain:c.backgroundColor==="rgba(0, 0, 0, 0)"&&parseFloat(c.borderTopWidth)===0,left:Math.abs(r.left-rows)<=2}})()`);
      assert.deepEqual(skip, { text: 'Skip', plain: true, left: true }, `Skip, plain text far left (${when})`);
    };
    await plain('nothing chosen');
    await shot(wc, '01-welcome-popup');
    for (const [choice, label] of [['codex', 'Connect to ChatGPT'], ['both', 'Connect to Claude and ChatGPT'], ['claude', 'Connect to Claude']]) {
      await press(wc, `[data-agent-choice="${choice}"]`);
      const shown = await labelIs(wc, label, 1200);
      assert.equal(shown.action, 'sign-in', `${choice}: installed and up to date, so its sign-in`);
      await plain(choice);
    }
    untouched('choosing');
    log('the popup: Connect to ChatGPT / Claude and ChatGPT / Claude, no version shown');
    await shot(wc, '02-claude-chosen');

    /* Connect to Claude: Claude Code's own sign-in, with the real CLI (the stand-in refuses it) */
    await press(wc, `${AGENT} [data-agent-primary="sign-in"]`);
    await until(() => asked.signIn.length > 0, 'Claude Code\'s sign-in asked for');
    await until(() => tools(wc).then((snap) => !snap.tools.claude.busy), 'the sign-in over, checked again', 1200);
    assert.deepEqual(asked.signIn.map((one) => one.name), ['claude'], 'only the one chosen');
    assert.equal(asked.signIn[0].file, launch.tools.claude.path, 'the real Claude Code\'s own sign-in');
    assert.equal((await tools(wc)).tools.claude.signedIn, false, 'still signed out (really)');
    assert.equal(await has(wc, '[data-agent-popup]'), true, 'the popup stays while neither runs');
    await labelIs(wc, 'Connect to Claude', 1200);
    await plain('after the sign-in');
    log(`Connect to Claude asked for ${asked.signIn[0].file}'s sign-in (refused here)`);

    /* Skip: on to Import your context, which asks again */
    await press(wc, '[data-agent-popup] [data-agent-skip]');
    await until(async () => { const f = await flow(wc); return f && f.screen === 'intro' && !f.dialog; }, 'Import your context');
    await press(wc, '[data-import-start]');
    await until(async () => (await flow(wc)).dialog === 'tools-setup', 'the agent popup again', 1200);
    await until(() => has(wc, `[role=dialog] ${AGENT} [data-agent-choice]`), 'the same popup in Import your context');
    await plain('Import context');
    await shot(wc, '03-import-popup');
    const found = (await discovery(wc)).projects;
    assert.ok(!['running', 'failed'].includes(found.status), `no agent ran: ${JSON.stringify(found)}`);
    untouched('the end');
    assert.equal(asked.signIn.length, 1, 'one sign-in asked for, by the one press');
    console.log('smoke-provider-real: ok');
    app.exit(0);
  } catch (error) {
    console.error('smoke-provider-real failed:', error);
    console.error('asked:', JSON.stringify(asked));
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'zz-failure'); console.error(await js(wc, 'document.body.innerText.slice(0,1500)')); } catch { /* none */ }
    app.exit(1);
  }
});
