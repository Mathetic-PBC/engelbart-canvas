'use strict';

// npm run build && ENGELBART_SMOKE_SCENARIO=<scenario> npx electron scripts/smoke-provider-connect.cjs
// Connecting Claude Code or Codex for Import your context (2026-10-14, a beta tester on a fresh Mac: "Finding projects was
// broken … it said try again but it like didnt work ever"; "it says installing claude code, even if it is already
// installed. it should say connecting instead"; "maybe if they dont hit connect it doesnt work but fails silently"). The real
// app, hidden, on a disposable home, with a pretend Mac's Claude Code and Codex (ENGELBART_TOOLS_FAKE) whose fake agents
// fail as the real CLIs do when they can't run (ENGELBART_CONNECT_FAKE_CLI: "Not logged in · Please run /login"). The
// provider is the tool check's answer (no ENGELBART_PROVIDERS_FAKE). Scenarios:
//   unknown   Claude Code whose sign-in check never answers (signedIn null), no Codex: Import context asks to connect it
//             (it used to count as signed in, and every agent failed); Connect signs in, and the flow goes on by itself.
//   fresh     neither CLI (a fresh Mac): Engelbart installs Claude Code at launch; its row says "Connecting…", never
//             "Installing"; then it is signed in and the projects are found.
//   refused   both signed in, Claude Code's account turned away ("Credit balance is too low"): the projects line says it
//             couldn't reach Claude Code and offers to connect it; Try again never re-runs it as it is; Codex finds them.
//   blocked   onboarded with Claude Code, which is signed out before the run: the project opens, "Connect Claude Code"
//             over the workspace; Connect signs in and the imports go on by themselves.
// ENGELBART_IMPORT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCENARIO = process.env.ENGELBART_SMOKE_SCENARIO || 'unknown';
const MACHINES = {
  unknown: { git: '2.50.0', claude: '2.1.300 unknown', codex: 'missing' },
  fresh: { git: '2.50.0', claude: 'missing', codex: 'missing' },
  refused: { git: '2.50.0', claude: '2.1.300', codex: '0.160.0' },
  blocked: { git: '2.50.0', claude: '2.1.300', codex: 'missing' },
};
assert.ok(MACHINES[SCENARIO], `no scenario ${SCENARIO}`);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `engelbart-provider-smoke-${SCENARIO}-`)));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify(MACHINES[SCENARIO]);
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_CONNECT_FAKE_CLI = '1';
process.env.ENGELBART_CONNECT_FAKE_MS = '150';
if (SCENARIO === 'refused') process.env.ENGELBART_CONNECT_FAKE_REFUSE = 'claude';
process.env.ENGELBART_CONNECT_APPLICATIONS = '';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = '';
process.env.ENGELBART_DISK_ACCESS = 'granted';
delete process.env.ENGELBART_PROVIDERS_FAKE;

const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: false });
const write = (rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
write('Notes/.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
write('Notes/Research/Help-seeking.md', 'Novices rarely ask.\n');
write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { v: { path: path.join(root, 'Notes'), ts: Date.now(), open: true } } }));
const session = (dir, id, prompt) => write(`.claude/projects/-${dir.replace(/\//g, '-')}/${id}.jsonl`, `${JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: path.join(root, dir), message: { role: 'user', content: prompt } })}\n`);
session('tutoring-study', '11111111-1111-4111-8111-111111111111', 'Plan the help-seeking analysis');

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
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const pressText = async (wc, scope, words) => {
  const at = await until(() => js(wc, `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b)=>!b.disabled&&b.textContent.trim().startsWith(${JSON.stringify(words)}));if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`), `"${words}"`);
  await click(wc, at);
};
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const text = (wc, selector) => js(wc, `(document.querySelector(${JSON.stringify(selector)})||{}).textContent||''`);
const flow = (wc) => js(wc, '(()=>{const el=document.querySelector("[data-import-flow]");return el?{screen:el.dataset.screen,dialog:el.dataset.dialog}:null})()');
const type = (wc, selector, value) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event("input",{bubbles:true}))})()`);
const tools = (wc) => js(wc, 'window.engelbartAPI.tools()');
const SHOTS = process.env.ENGELBART_IMPORT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `connect-${SCENARIO}-${name}.png`), picture.toPNG());
}
// The connect dialog's Claude Code / Codex rows: { anthropic: { state, label, buttons } }.
const rows = (wc) => js(wc, '(()=>{const out={};for(const row of document.querySelectorAll("[data-provider-row]"))out[row.dataset.providerRow]={state:row.dataset.providerState,label:(row.querySelector("small")||{}).textContent||"",buttons:[...row.querySelectorAll("button")].map((b)=>b.textContent.trim())};return out})()');
// No horizontal dividing line in what is shown (Hudson: "I never want horizontal dividing lines").
const dividers = (wc, scope) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${scope} *`)})].filter((el)=>{const s=getComputedStyle(el);return (parseFloat(s.borderTopWidth)>0&&s.borderTopStyle!=='none')||(parseFloat(s.borderBottomWidth)>0&&s.borderBottomStyle!=='none')}).filter((el)=>!el.matches('button,input,textarea,.btn')).length`);

async function walkToProjects(wc) {
  await until(async () => { const f = await flow(wc); return f && f.screen === 'roles' && !f.dialog; }, 'What kind of work do you do?');
  await press(wc, '[data-work-role="Researcher"]');
  await pressText(wc, '.work-foot', 'Continue');
  await until(async () => (await flow(wc)).screen === 'work', 'What are you interested in researching right now?');
  await type(wc, '#work-description', 'I study how students ask for help.');
  await pressText(wc, '.work-foot', 'Continue');
  await until(async () => (await flow(wc)).screen === 'projects', 'the projects screen');
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
    await press(wc, '[data-onboarding-continue] button');

    if (SCENARIO === 'fresh') {
      /* the tools screen while Claude Code installs at launch: "Connecting…" */
      await until(() => has(wc, '[data-tool-row="claude"]'), 'the tools screen');
      const state = await until(async () => { const t = await text(wc, '[data-tool-row="claude"] [data-tool-state]'); return t || null; }, 'Claude Code\'s state');
      await shot(wc, '01-tools-installing');
      assert.equal(state, 'Connecting…', `Claude Code being installed reads "Connecting…" (${state})`);
      assert.doesNotMatch(await text(wc, '[data-onboarding-tools]'), /Installing/, 'never "Installing"');
      // Installed: its sign-in is the step (Continue waits for it).
      await until(() => has(wc, '[data-tool-row="claude"] [data-tool-action="sign-in"] button'), 'Claude Code installed, waiting for its sign-in', 600);
      assert.equal((await tools(wc)).tools.claude.status, 'signed-out');
      await press(wc, '[data-tool-row="claude"] [data-tool-action="sign-in"] button');
      await until(() => tools(wc).then((snap) => snap.tools.claude.signedIn === true), 'signed in', 600);
      await pressText(wc, '[data-screen-label="02 Tools"]', 'Continue');
    }

    /* the intro → Import context */
    await until(async () => { const f = await flow(wc); return f && f.screen === 'intro' && !f.dialog; }, 'Import your context');
    await press(wc, '[data-import-start]');

    if (SCENARIO === 'unknown') {
      // Before: Claude Code counted as signed in, the project agent ran and failed "Not logged in", and Try again re-ran it.
      await until(async () => (await flow(wc)).dialog === 'tools-setup', 'Connect Claude Code or Codex (asked, not run)');
      const before = await rows(wc);
      await shot(wc, '01-connect-dialog');
      assert.equal(before.anthropic.state, 'not-connected', JSON.stringify(before));
      assert.deepEqual(before.anthropic.buttons, ['Connect']);
      assert.equal(await text(wc, '[role=dialog] h3'), 'Connect Claude Code or Codex');
      assert.doesNotMatch(await text(wc, '[role=dialog]'), /Install/, 'no "Install" for one the person has');
      assert.equal(await dividers(wc, '[role=dialog] .tool-list'), 0, 'no dividing lines');
      const discovery = await js(wc, 'window.engelbartAPI.importDiscovery()');
      assert.notEqual(discovery.projects.status, 'failed', 'nothing ran on a CLI that could not');
      await press(wc, '[data-provider-connect="anthropic"]');
      await until(async () => { const r = await rows(wc); return r.anthropic && ['connecting', 'signing-in'].includes(r.anthropic.state); }, 'Connecting… / Finish in your browser');
      await shot(wc, '02-connecting');
      // Signed in: on with the flow by itself, no Continue pressed.
      await walkToProjects(wc);
    }

    if (SCENARIO === 'fresh' || SCENARIO === 'blocked') await walkToProjects(wc);

    if (SCENARIO === 'refused') {
      // Claude Code has the subscription (Codex's sign-in file names no plan on this pretend Mac): picked without asking.
      const f = await until(async () => { const now = await flow(wc); return now && (now.dialog === 'provider-choice' || now.screen === 'roles') ? now : null; }, 'the provider picked');
      if (f.dialog === 'provider-choice') await press(wc, '[data-onboarding-provider="anthropic"]');
      await walkToProjects(wc);
      // Claude Code turned the agent away: the line says so and offers to connect it (no dead Try again).
      await until(() => has(wc, '[data-discovery-connect="anthropic"]'), 'Couldn’t reach Claude Code · Connect Claude Code');
      assert.match(await text(wc, '[data-discovery-status]'), /^Couldn’t reach Claude Code\.Connect Claude Code$/);
      assert.equal(await has(wc, '[data-discovery-again]'), false, 'no Try again that would run it as it is');
      await shot(wc, '01-refused-line');
      const runsBefore = (await js(wc, 'window.engelbartAPI.importDiscovery()')).projects;
      assert.equal(runsBefore.connect, 'anthropic');
      await press(wc, '[data-discovery-connect="anthropic"]');
      await until(async () => (await flow(wc)).dialog === 'tools-setup', 'Connect Claude Code or Codex');
      const shown = await rows(wc);
      await shot(wc, '02-refused-dialog');
      assert.equal(shown.anthropic.state, 'refused', JSON.stringify(shown));
      assert.match(shown.anthropic.label, /Credit balance is too low/, 'its line says why');
      assert.equal(shown.openai.state, 'ready');
      // Not re-run on its own while it would be turned away again.
      await pause(600);
      assert.equal((await flow(wc)).dialog, 'tools-setup', 'it waits for the person');
      await pressText(wc, '[role=dialog] .mf', 'Continue');
      await until(async () => !(await flow(wc)).dialog, 'the dialog closed');
    }

    /* the projects found */
    await until(() => has(wc, '[data-work-project]'), 'the projects the agent found', 800);
    const found = await js(wc, 'window.engelbartAPI.importDiscovery()');
    assert.equal(found.projects.status, 'done');
    if (SCENARIO === 'refused') assert.equal(found.projects.provider, 'openai', 'found with Codex');
    await shot(wc, '03-projects');

    if (SCENARIO === 'blocked') {
      /* onboarded with Claude Code; signed out before the run */
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
      await js(wc, 'window.engelbartAPI.toolsSignOut("claude")');
      await until(() => tools(wc).then((snap) => snap.tools.claude.signedIn === false), 'Claude Code signed out');
      await press(wc, '[data-import-run]');
      // How should Engelbart import your sources? In the background, understood (From Amitav, 2026-10-15).
      await until(async () => (await flow(wc)).dialog === 'import-method', 'How should Engelbart import your sources?');
      await press(wc, '[data-import-method="agents"]');
      await until(async () => (await flow(wc)).dialog === 'agents-consent', 'Import context using background agents');
      await press(wc, '[data-import-understood]');
      for (let i = 0; i < 40 && !(await has(wc, '[data-provider-popup]')); i++) {
        const f = await flow(wc);
        if (f && f.dialog === 'organize') { if (await has(wc, '[data-organize-connect]')) await press(wc, '[data-organize-connect]'); else if (await has(wc, '[data-organize-continue]:not([disabled])')) await press(wc, '[data-organize-continue]'); }
        await pause(150);
      }
      await until(() => has(wc, '[data-provider-popup="anthropic"]'), '"Connect Claude Code" over the workspace', 800);
      const run = (await js(wc, 'window.engelbartAPI.connectList()')).find((entry) => entry.direct);
      assert.equal(run.blocked.provider, 'anthropic');
      assert.equal(run.jobs.some((job) => job.status === 'failed'), false, 'nothing failed: it waits');
      assert.equal(await text(wc, '[data-provider-popup] h3'), 'Connect Claude Code');
      assert.equal(await text(wc, '[data-provider-line]'), 'Your imports are waiting for Claude Code.');
      assert.equal(await js(wc, 'document.querySelectorAll("[data-provider-popup] .need-modal p").length'), 1, 'one line');
      assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-provider-popup] .need-modal")).backgroundColor'), 'rgb(255, 255, 255)', 'a white card');
      assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-provider-popup] h3")).color'), 'rgb(23, 23, 23)', '#171717 ink');
      assert.equal(await dividers(wc, '[data-provider-popup] .need-modal'), 0, 'no dividing lines');
      assert.equal(await has(wc, '[data-import-status]'), false, 'one popup at a time');
      await shot(wc, '04-workspace-connect');
      await press(wc, '[data-provider-connect="anthropic"]');
      await until(() => js(wc, '(document.querySelector("[data-provider-popup]")||{dataset:{}}).dataset.providerState'), 'connecting');
      await shot(wc, '05-workspace-connecting');
      await until(async () => !(await has(wc, '[data-provider-popup]')), 'the popup gone once connected', 800);
      const after = await until(async () => { const s = (await js(wc, 'window.engelbartAPI.connectList()')).find((entry) => entry.id === run.id); return s && !s.blocked && s.jobs.filter((job) => job.kind === 'import').every((job) => job.status === 'done') ? s : null; }, 'the imports done', 800);
      assert.ok(after.jobs.some((job) => job.kind === 'import' && job.apps.includes('Obsidian')));
      await shot(wc, '06-after');
    }
    console.log(`smoke-provider-connect (${SCENARIO}): ok`);
    app.exit(0);
  } catch (error) {
    console.error(`smoke-provider-connect (${SCENARIO}) failed:`, error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'zz-failure'); console.error(await js(wc, 'document.body.innerText.slice(0,1500)')); } catch { /* none */ }
    app.exit(1);
  }
});
