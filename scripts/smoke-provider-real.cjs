'use strict';

// npm run build && npx electron scripts/smoke-provider-real.cjs
// Connecting Claude Code and Codex against this Mac's REAL CLIs (2026-10-14): the app hidden, on a disposable home, its
// agents the real `claude -p` / `codex exec` (run with --no-session-persistence / --ephemeral, so nothing lands in the
// person's history). "Signed out" is the real CLI pointed at an empty scratch config dir (CLAUDE_CONFIG_DIR, CODEX_HOME);
// "signing in" is simulated by unsetting it again, so the person's own sign-in answers: no account is changed, and a real
// sign-in (which would open their browser) is refused outright by this script.
//   A  both CLIs signed out at launch: the tools screen asks to sign in; signed in (simulated), the real Claude Code finds
//      the projects. Codex stays signed out: one of the two is enough.
//   B  Claude Code signed out while the project agent starts (a real "Not logged in · Please run /login"): the line says
//      "Couldn’t reach Claude Code" with Connect Claude Code, not a dead Try again; Connect (after signing in) runs it again.
//   C  signed out again before the import: the real import agent fails "Not logged in", the run waits, "Connect Claude
//      Code" comes over the workspace; signed in, Connect, and the import goes on by itself and brings the note in.
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
const signOut = () => { process.env.CLAUDE_CONFIG_DIR = emptyClaude; };
const signIn = () => { delete process.env.CLAUDE_CONFIG_DIR; };
signOut();
process.env.CODEX_HOME = emptyCodex;
delete process.env.ANTHROPIC_API_KEY;
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
for (const key of ['ENGELBART_TOOLS_FAKE', 'ENGELBART_PROVIDERS_FAKE', 'ENGELBART_CONNECT_FAKE', 'ENGELBART_BART_FAKE']) delete process.env[key];

// Never a real sign-in from here: it would open the person's browser on their account.
const pty = require('node-pty');
const spawn = pty.spawn;
let refusedSignIns = 0;
pty.spawn = (file, args, options) => {
  if (/"\$ENGELBART_TOOL" (?:auth )?login/.test((args || []).join(' '))) { refusedSignIns += 1; throw new Error('A real sign-in is refused in this smoke'); }
  return spawn(file, args, options);
};

const home = require('../src/main/store/home.cjs');
// Updates asked for, never run: nothing here touches the person's installs.
home.writeConfig(home.ensureHome(root).root, { testMode: false, tools: { updates: 'ask' } });
const write = (rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write('Notes/.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
write('Notes/Research/Help-seeking.md', '# Help-seeking\n\nNovices in CS1 rarely ask for help; an AI tutor that asks them first might change that.\n');
write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { v: { path: path.join(root, 'Notes'), ts: Date.now(), open: true } } }));
const session = (dir, id, prompt) => write(`.claude/projects/-${dir.replace(/\//g, '-')}/${id}.jsonl`, `${JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: path.join(root, dir), timestamp: new Date().toISOString(), message: { role: 'user', content: prompt } })}\n`);
session('help-seeking-study', '11111111-1111-4111-8111-111111111111', 'Plan the help-seeking analysis for the CS1 tutoring RCT');
session('help-seeking-study', '22222222-2222-4222-8222-222222222222', 'Write the methods section of the help-seeking paper');
fs.mkdirSync(path.join(root, 'help-seeking-study'), { recursive: true });

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
const pressText = async (wc, scope, words) => {
  const at = await until(() => js(wc, `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b)=>!b.disabled&&b.textContent.trim().startsWith(${JSON.stringify(words)}));if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`), `"${words}"`);
  await click(wc, at);
};
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const text = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const flow = (wc) => js(wc, '(()=>{const el=document.querySelector("[data-import-flow]");return el?{screen:el.dataset.screen,dialog:el.dataset.dialog}:null})()');
const type = (wc, selector, value) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event("input",{bubbles:true}))})()`);
const tools = (wc) => js(wc, 'window.engelbartAPI.tools()');
const discovery = (wc) => js(wc, 'window.engelbartAPI.importDiscovery()');
const SHOTS = process.env.ENGELBART_IMPORT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `real-${name}.png`), picture.toPNG());
}
const log = (line) => console.log(`  · ${line}`);

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1280, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    const launch = await until(() => tools(wc).then((snap) => (snap && snap.checked ? snap : null)), 'the launch check', 1200);

    /* A: both real CLIs signed out */
    assert.deepEqual([launch.tools.claude.installed, launch.tools.claude.status, launch.tools.claude.signedIn], [true, 'signed-out', false], `the real Claude Code, signed out: ${JSON.stringify(launch.tools.claude)}`);
    assert.deepEqual([launch.tools.codex.installed, launch.tools.codex.status, launch.tools.codex.signedIn], [true, 'signed-out', false], `the real Codex, signed out: ${JSON.stringify(launch.tools.codex)}`);
    assert.equal((await js(wc, 'window.engelbartAPI.importProviders(true)')).decision.setup, true, 'nothing to run on');
    log(`A launch: Claude Code ${launch.tools.claude.version} and Codex ${launch.tools.codex.version}, both signed out`);
    await press(wc, '[data-onboarding-continue] button');
    await until(() => has(wc, '[data-tool-row="claude"] [data-tool-action="sign-in"]'), 'the tools screen asks to sign in');
    assert.equal(await text(wc, '[data-tool-row="claude"] [data-tool-state]'), 'Not signed in');
    await shot(wc, 'A1-tools');
    signIn(); // the person signs in to Claude Code (simulated: their own sign-in answers again)
    await js(wc, 'window.engelbartAPI.toolsCheck()'); // what the end of a sign-in runs
    await until(() => tools(wc).then((snap) => snap.tools.claude.signedIn === true), 'Claude Code signed in');
    await pressText(wc, '[data-screen-label="02 Tools"]', 'Continue');
    await until(async () => { const f = await flow(wc); return f && f.screen === 'intro' && !f.dialog; }, 'Import your context');
    await press(wc, '[data-import-start]');
    await until(async () => { const f = await flow(wc); return f && f.screen === 'roles' && !f.dialog; }, 'on with Claude Code (Codex, signed out, not needed)');
    await press(wc, '[data-work-role="Researcher"]');
    await pressText(wc, '.work-foot', 'Continue');
    await until(async () => (await flow(wc)).screen === 'work', 'the work');
    await type(wc, '#work-description', 'I study how students ask for help in CS1.');
    await pressText(wc, '.work-foot', 'Continue');
    await until(async () => (await flow(wc)).screen === 'projects', 'the projects screen');
    const firstRun = await until(() => discovery(wc).then((d) => (d.projects.status === 'done' || d.projects.status === 'failed' ? d.projects : null)), 'the real project agent', 3600);
    assert.equal(firstRun.status, 'done', `the real Claude Code found the projects: ${JSON.stringify(firstRun)}`);
    assert.equal(firstRun.provider, 'anthropic');
    log(`A projects by the real Claude Code: ${firstRun.projects.map((project) => project.title).join(', ')}`);
    await until(() => has(wc, '[data-work-project]'), 'the projects shown');
    await shot(wc, 'A2-projects');

    /* B: signed out while the agent starts: the real "Not logged in" */
    const started = await js(wc, 'window.engelbartAPI.importDiscoverProjects({ provider: "anthropic", again: true })');
    assert.equal(started.projects.status, 'running', 'signed in when it started');
    signOut(); // signed out in a terminal while it runs
    const failed = await until(() => discovery(wc).then((d) => (d.projects.status !== 'running' ? d.projects : null)), 'the agent\'s answer', 1200);
    assert.deepEqual([failed.status, failed.connect, failed.error], ['failed', 'anthropic', 'Not logged in · Please run /login'], JSON.stringify(failed));
    await until(() => has(wc, '[data-discovery-connect="anthropic"]'), 'Connect Claude Code on the line');
    assert.match(await text(wc, '[data-discovery-status]'), /^Couldn’t reach Claude Code\./);
    assert.equal(await has(wc, '[data-discovery-again]'), false, 'no Try again that runs it as it is');
    await shot(wc, 'B1-line');
    log('B the real CLI said "Not logged in · Please run /login": the line asks to connect Claude Code');
    await press(wc, '[data-discovery-connect="anthropic"]');
    await until(async () => (await flow(wc)).dialog === 'tools-setup', 'Connect Claude Code or Codex');
    await until(() => js(wc, '(document.querySelector("[data-provider-row=anthropic]")||{dataset:{}}).dataset.providerState==="not-connected"'), 'Claude Code: Not connected');
    await shot(wc, 'B2-dialog');
    signIn();
    await press(wc, '[data-provider-connect="anthropic"]'); // checked first: signed in, so no browser sign-in
    await until(async () => !(await flow(wc)).dialog, 'on by itself once connected', 1200);
    const again = await until(() => discovery(wc).then((d) => (d.projects.status === 'done' && d.projects.ended !== failed.ended ? d.projects : null)), 'the projects found again', 3600);
    log(`B connected: found again (${again.projects.length})`);
    assert.equal(refusedSignIns, 0, 'no real sign-in was started');

    /* C: signed out before the import: "Connect Claude Code" over the workspace */
    await until(() => has(wc, '[data-work-project]'), 'the projects shown');
    await js(wc, 'document.querySelectorAll("[data-work-project]")[0].click()');
    await pressText(wc, '.work-foot', 'Continue');
    await until(async () => { const f = await flow(wc); return f.screen === 'picker' && !f.dialog; }, 'the picker');
    // Obsidian alone: the tools screen ticks what the tool agent found (From Amitav, 2026-10-15), and a connector's step
    // (Granola's) would come before the provider's popup.
    for (const group of await js(wc, '[...document.querySelectorAll("[data-group]")].map((b)=>b.dataset.group)')) {
      if (await js(wc, `document.querySelector('[data-group="${group}"]').getAttribute('aria-expanded')`) !== 'true') await press(wc, `[data-group="${group}"]`);
      await js(wc, '[...document.querySelectorAll("[data-app][aria-checked=true]")].filter((b)=>b.dataset.app!=="Obsidian").forEach((b)=>b.click())');
    }
    if (await js(wc, 'document.querySelector("[data-group=notes]").getAttribute("aria-expanded")') !== 'true') await press(wc, '[data-group="notes"]');
    if (await js(wc, 'document.querySelector("[data-app=Obsidian]").getAttribute("aria-checked")') !== 'true') await press(wc, '[data-app="Obsidian"]');
    signOut(); // no check: Engelbart still thinks it can run, as when a sign-in lapses
    await press(wc, '[data-import-run]');
    // How should Engelbart import your sources? In the background, understood (From Amitav, 2026-10-15).
    await until(async () => (await flow(wc)).dialog === 'import-method', 'How should Engelbart import your sources?');
    await press(wc, '[data-import-method="agents"]');
    await until(async () => (await flow(wc)).dialog === 'agents-consent', 'Import context using background agents');
    await press(wc, '[data-import-understood]');
    // Allow Engelbart to organize your research (2026-10-15): Connect desktop, then Continue.
    for (let i = 0; i < 80 && !(await has(wc, '[data-provider-popup]')); i++) {
      const f = await flow(wc);
      if (f && f.dialog === 'organize') { if (await has(wc, '[data-organize-connect]')) await press(wc, '[data-organize-connect]'); else if (await has(wc, '[data-organize-continue]:not([disabled])')) await press(wc, '[data-organize-continue]'); }
      await pause(150);
    }
    await until(() => has(wc, '[data-provider-popup="anthropic"]'), '"Connect Claude Code" over the workspace', 3600);
    const run = (await js(wc, 'window.engelbartAPI.connectList()')).find((entry) => entry.direct);
    assert.equal(run.blocked.provider, 'anthropic');
    assert.equal(run.blocked.error, 'Not logged in · Please run /login', 'the real CLI\'s words');
    assert.equal(run.jobs.some((job) => job.status === 'failed'), false, 'nothing failed: the run waits');
    await until(() => js(wc, 'document.querySelector("[data-provider-popup]").dataset.providerState==="not-connected"'), 'its line once the check has run', 1200);
    assert.equal(await text(wc, '[data-provider-line]'), 'Your imports are waiting for Claude Code.');
    await shot(wc, 'C1-workspace');
    log('C the real import agent said "Not logged in": the run waits, "Connect Claude Code" over the workspace');
    signIn();
    await press(wc, '[data-provider-connect="anthropic"]');
    await until(async () => !(await has(wc, '[data-provider-popup]')), 'the popup gone once connected', 1200);
    const done = await until(async () => { const s = (await js(wc, 'window.engelbartAPI.connectList()')).find((entry) => entry.id === run.id); const imports = s ? s.jobs.filter((job) => job.kind === 'import') : []; return imports.length && imports.every((job) => ['done', 'failed', 'stopped'].includes(job.status)) ? s : null; }, 'the real import ended', 12000);
    const obsidian = done.jobs.find((job) => job.kind === 'import' && job.apps.includes('Obsidian'));
    assert.equal(obsidian.status, 'done', `the import ran on the real Claude Code: ${JSON.stringify(obsidian)}`);
    log(`C connected: the import went on (${obsidian.notes} notes: ${obsidian.summary.slice(0, 120)})`);
    await shot(wc, 'C2-after');
    assert.equal(refusedSignIns, 0, 'no real sign-in was started');
    console.log('smoke-provider-real: ok');
    app.exit(0);
  } catch (error) {
    console.error('smoke-provider-real failed:', error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'zz-failure'); console.error(await js(wc, 'document.body.innerText.slice(0,1500)')); } catch { /* none */ }
    app.exit(1);
  }
});
