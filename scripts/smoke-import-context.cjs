'use strict';

// npm run build && npx electron scripts/smoke-import-context.cjs
// Import your context (2026-10-13, the "Onboarding" workspace), walked in the real app, hidden, against a disposable home
// with stand-ins for this Mac: Connect's fake agents (ENGELBART_CONNECT_FAKE), Claude alone subscribed
// (ENGELBART_PROVIDERS_FAKE=claude: no provider question), Arc the default browser with Chrome installed
// (ENGELBART_ONBOARDING_BROWSERS), Full Disk Access off until System Settings is "opened" (ENGELBART_DISK_ACCESS=denied, which
// grants it 2.5 s later), and no browser whose cookies can be read (so ChatGPT stays signed out and its import waits on a card).
//   welcome → Import your context (intro over the sources) → Import context → How would you like to import context?
//   (Let agents choose) → Allow Engelbart to use your Arc sign-ins? (Allow) → roles → What are you working on? →
//   the projects the fake project agent found → Confirm your tools (the fake tool agent's) → Run in background →
//   Allow Full Disk Access → Switch on Engelbart (granted) → a project for each project picked, the first open →
//   Imports in progress over the workspace, ChatGPT's sign-in card; Skip; the run ends; the Agent trace has every turn.
// ENGELBART_IMPORT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-import-smoke-')));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS_FAKE = JSON.stringify({ git: '2.50.0', claude: '2.1.300', codex: '0.160.0' });
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_SANDBOXES = 'off';
process.env.ENGELBART_UPDATES = 'off';
process.env.ENGELBART_CONNECT_FAKE = '1';
process.env.ENGELBART_CONNECT_FAKE_MS = '150';
process.env.ENGELBART_CONNECT_APPLICATIONS = '';
process.env.ENGELBART_HEADLESS = '1';
process.env.ENGELBART_INSTALLED_BROWSERS = '';
process.env.ENGELBART_PROVIDERS_FAKE = 'claude';
process.env.ENGELBART_ONBOARDING_BROWSERS = 'arc,chrome';
process.env.ENGELBART_DISK_ACCESS = 'denied';

const home = require('../src/main/store/home.cjs');
home.writeConfig(home.ensureHome(root).root, { testMode: false });
const write = (rel, text) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
// A vault Obsidian knows, and Claude Code sessions in two project folders: what the project agent reads.
write('Notes/.obsidian/daily-notes.json', JSON.stringify({ folder: 'Daily' }));
write('Notes/Research/Help-seeking.md', 'Novices rarely ask. See [[Tutoring]].\n');
write('Library/Application Support/obsidian/obsidian.json', JSON.stringify({ vaults: { v: { path: path.join(root, 'Notes'), ts: Date.now(), open: true } } }));
const session = (dir, id, prompt) => write(`.claude/projects/-${dir.replace(/\//g, '-')}/${id}.jsonl`, `${JSON.stringify({ type: 'user', entrypoint: 'cli', cwd: path.join(root, dir), message: { role: 'user', content: prompt } })}\n`);
session('tutoring-study', '11111111-1111-4111-8111-111111111111', 'Plan the help-seeking analysis');
session('tutoring-study', '22222222-2222-4222-8222-222222222222', 'Write the methods section');
session('reading-guide', '33333333-3333-4333-8333-333333333333', 'Summarize VanLehn 2011');
fs.mkdirSync(path.join(root, 'tutoring-study'), { recursive: true });

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
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const pressText = async (wc, scope, words) => {
  const at = await until(() => js(wc, `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b)=>!b.disabled&&b.textContent.trim().startsWith(${JSON.stringify(words)}));if(!el)return null;el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`), `"${words}"`);
  await click(wc, at);
};
const has = (wc, selector) => js(wc, `!!document.querySelector(${JSON.stringify(selector)})`);
const flow = (wc) => js(wc, '(()=>{const el=document.querySelector("[data-import-flow]");return el?{screen:el.dataset.screen,dialog:el.dataset.dialog}:null})()');
const SHOTS = process.env.ENGELBART_IMPORT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    win.setSize(1280, 900);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!document.querySelector("[data-onboarding=new]")').catch(() => false), 'a new user\'s onboarding');
    await press(wc, '[data-onboarding-continue] button');

    /* intro over the sources */
    await until(async () => { const f = await flow(wc); return f && f.dialog === 'intro'; }, 'Import your context, its intro');
    await shot(wc, '01-intro');
    assert.match(await js(wc, 'document.querySelector(".intro-modal h1").textContent'), /^Import your context$/);
    await press(wc, '[data-import-start]');
    /* Claude alone subscribed: no provider question; the method, the project agent already started */
    await until(async () => (await flow(wc)).dialog === 'import-mode', 'How would you like to import context?');
    await until(() => js(wc, 'window.engelbartAPI.importDiscovery().then((d)=>d.projects.status)').then((status) => status === 'running' || status === 'done'), 'the project agent, started before the method is chosen');
    await shot(wc, '02-mode');
    await press(wc, '[data-import-mode="auto"]');
    await press(wc, '[data-import-mode-continue]');
    /* Arc's sign-ins */
    await until(async () => (await flow(wc)).dialog === 'keychain', 'the browser\'s sign-ins');
    assert.match(await js(wc, 'document.querySelector("[role=dialog] h3").textContent'), /Arc sign-ins/, 'the default browser, Arc');
    await shot(wc, '03-keychain');
    await press(wc, '[data-import-keychain-allow]');
    /* roles, work, projects */
    await until(async () => (await flow(wc)).screen === 'roles', 'What kind of work do you do?');
    await press(wc, '[data-work-role="Researcher"]');
    await shot(wc, '04-roles');
    await pressText(wc, '.work-foot', 'Continue');
    await until(async () => (await flow(wc)).screen === 'work', 'What are you working on?');
    await js(wc, '(()=>{const el=document.querySelector("#work-description");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(el,"I study how students ask for help.");el.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await pressText(wc, '.work-foot', 'Continue');
    await until(async () => (await flow(wc)).screen === 'projects', 'What project do you want to work on first?');
    await until(() => has(wc, '[data-work-project]'), 'the projects the agent found');
    await shot(wc, '05-projects');
    const titles = await js(wc, '[...document.querySelectorAll("[data-work-project] b")].map((b)=>b.textContent)');
    assert.ok(titles.length >= 1 && titles.length <= 5, `1-5 projects: ${titles.join(', ')}`);
    await press(wc, '[data-work-project]');
    await pressText(wc, '.work-foot', 'Continue');
    /* tools */
    await until(async () => (await flow(wc)).screen === 'tools', 'Confirm your tools');
    await until(() => spot(wc, '[data-import-run]'), 'the tool agent\'s answer (Run in background live)');
    await shot(wc, '06-tools');
    const ticked = await js(wc, '[...document.querySelectorAll("[data-work-tool][aria-checked=true]")].map((b)=>b.dataset.workTool)');
    assert.ok(ticked.includes('Obsidian'), 'Obsidian, found on this Mac, ticked');
    if (!ticked.includes('ChatGPT')) { await pressText(wc, '.tool-list-actions', 'Show all'); await press(wc, '[data-work-tool="ChatGPT"]'); }
    await press(wc, '[data-import-run]');
    /* Full Disk Access */
    await until(async () => (await flow(wc)).dialog === 'folders', 'Allow Full Disk Access');
    await shot(wc, '07-disk');
    await press(wc, '[data-import-disk-open]');
    await until(async () => (await flow(wc)).dialog === 'disk-wait', 'waiting for the switch');
    await shot(wc, '08-disk-wait');
    /* the run: a project made and opened, the status over it */
    await until(() => js(wc, '!!document.querySelector("[data-import-status]")').catch(() => false), 'Imports in progress over the workspace', 1200);
    await shot(wc, '09-status');
    const projects = await js(wc, 'window.engelbartAPI.listProjects()');
    assert.ok(projects.some((project) => project.name === titles[0]), `a project named for the one picked (${titles[0]})`);
    const list = await js(wc, 'window.engelbartAPI.connectList()');
    const run = list.find((entry) => entry.direct);
    assert.ok(run, 'a direct session');
    assert.deepEqual(run.direct.projects, [titles[0]]);
    assert.ok(run.jobs.some((job) => job.kind === 'import' && job.apps.includes('Obsidian')), 'Obsidian imported');
    const card = run.needs.find((need) => need.app === 'ChatGPT');
    assert.ok(card, 'ChatGPT signed out: its card, not left out');
    assert.ok(await has(wc, '[data-import-need="ChatGPT"]'), 'its card in the modal');
    await pressText(wc, '[data-import-need="ChatGPT"]', 'Skip');
    // Every other sign-in card skipped too (the fake tool agent ticks more web apps than ChatGPT): Done needs none waiting.
    for (let i = 0; i < 12; i++) {
      const open = await js(wc, '[...document.querySelectorAll("[data-import-need]")].map((el)=>el.dataset.importNeed)');
      if (!open.length) { const still = await js(wc, `window.engelbartAPI.connectState(${JSON.stringify(run.id)}).then((s)=>s.needs.length)`); if (!still) break; await pause(300); continue; }
      await pressText(wc, `[data-import-need="${open[0]}"]`, 'Skip');
      await pause(300);
    }
    await until(() => js(wc, 'window.engelbartAPI.connectList()').then((all) => { const s = all.find((entry) => entry.id === run.id); return s && s.jobs.filter((job) => job.kind !== 'memory' && job.kind !== 'redact').every((job) => ['done', 'failed', 'stopped'].includes(job.status)); }), 'every import ended', 1200);
    await until(() => js(wc, '(document.querySelector("[data-import-status-close]")||{}).textContent==="Done"'), 'Done once everything has ended');
    await shot(wc, '10-done');
    /* library only: nothing in the workspace's context */
    const files = (dir, name, out = []) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory() && !['node_modules', 'worktrees'].includes(entry.name)) files(full, name, out); else if (entry.name === name) out.push(full); } return out; };
    const contexts = files(path.join(root, '.engelbart'), 'meta.json').flatMap((file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).context || []; } catch { return []; } }).flat(Infinity).filter((id) => typeof id === 'string');
    const md = (await js(wc, 'window.engelbartAPI.library()')).filter((row) => row.type === 'md' && !row.tags.includes('note')).map((row) => row.id);
    assert.equal(md.filter((id) => contexts.includes(id)).length, 0, 'what came in is in the library, not a workspace\'s context');
    /* the trace */
    const traceFiles = files(path.join(root, '.engelbart'), `${new Date().toISOString().slice(0, 10)}.jsonl`).filter((file) => file.includes(`${path.sep}trace${path.sep}`));
    assert.ok(traceFiles.length, 'the trace written in the data root');
    const entries = traceFiles.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)));
    const kinds = new Set(entries.filter((entry) => entry.type === 'turn').map((entry) => entry.kind));
    for (const kind of ['projects', 'import']) assert.ok(kinds.has(kind), `a ${kind} turn traced`);
    assert.ok(entries.some((entry) => entry.type === 'event' && entry.kind === 'dispatch'), 'dispatching traced');
    assert.ok(entries.some((entry) => entry.type === 'turn' && entry.system && entry.message), 'with its prompt and input');
    console.log(`smoke-import-context: ok (${titles.length} projects found, ${ticked.length} tools ticked, ${entries.length} trace entries)`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'failed'); console.error(await flow(wc)); } catch { /* none */ }
    app.exit(1);
  }
});
