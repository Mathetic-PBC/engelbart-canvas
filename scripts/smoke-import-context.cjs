'use strict';

// npm run build && npx electron scripts/smoke-import-context.cjs            (Let agents choose)
// npm run build && ENGELBART_SMOKE_MODE=manual npx electron scripts/smoke-import-context.cjs   (Choose sources myself)
// Import your context, round 3 (2026-10-13, docs/onboarding-round-3.md), walked in the real app, hidden, against a
// disposable home with stand-ins for this Mac: Connect's fake agents (ENGELBART_CONNECT_FAKE), Claude and Codex both
// subscribed (ENGELBART_PROVIDERS_FAKE=both: the provider asked), Arc the default browser with Chrome installed
// (ENGELBART_ONBOARDING_BROWSERS), Full Disk Access off until System Settings is "opened" (ENGELBART_DISK_ACCESS=denied,
// which grants it 2.5 s later), no browser whose cookies can be read (so every web app is signed out: a sign-in popup),
// Chrome holding the browser extension though the person's CLI does not let its agents use it yet
// (ENGELBART_BROWSER_AGENTS=ask).
//   welcome → Import your context (intro) → Import context → Which provider? (one click) → the browser's sign-ins, over
//   "What kind of work do you do?" (no subtext) → roles → "What are you working on?" (one line that grows, never resized)
//   → projects → How would you like to import context? (over the next screen, one click) →
//     auto:   Confirm your tools (no subtext; nothing ticked that the agent said is not used) → Import to Engelbart
//     manual: What should go in your library? (no For/Edit, no Sources bar, no subscription card; one group open at a
//             time; Specify context collapsed, its project pills, "Further specify", Choose a folder / Choose files) →
//             Import to Engelbart
//   → Allow Full Disk Access (one line) → Turn on → Let agents use Chrome? (one line) → the project opens → the status
//   (no subtext, no lines) and the sign-in popups, one at a time, "Continue in Arc." (Later; "Needs you" brings one back)
//   → Your imports are complete / have finished, with the logos of what came in.
// ENGELBART_IMPORT_SHOTS=<dir> saves pictures.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MODE = process.env.ENGELBART_SMOKE_MODE === 'manual' ? 'manual' : 'auto';
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
process.env.ENGELBART_PROVIDERS_FAKE = 'both';
process.env.ENGELBART_BROWSER_AGENTS = 'ask';
process.env.ENGELBART_ONBOARDING_BROWSERS = 'arc,chrome';
process.env.ENGELBART_DISK_ACCESS = 'denied';
process.env.ENGELBART_PICK_DIRECTORY = path.join(root, 'Notes', 'Research');
process.env.ENGELBART_PICK_PATHS = JSON.stringify([path.join(root, 'Notes', 'Research', 'Help-seeking.md')]);

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
// Text under a choice's name (the round's "get rid of all of this subtext under everything").
const subtext = (wc, selector) => js(wc, `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((el)=>{const s=el.querySelector('small');return s&&getComputedStyle(s).display!=='none'&&s.textContent.trim()}).length`);
const SHOTS = process.env.ENGELBART_IMPORT_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${MODE}-${name}.png`), picture.toPNG());
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

    /* the intro */
    await until(async () => { const f = await flow(wc); return f && f.dialog === 'intro'; }, 'Import your context, its intro');
    await shot(wc, '01-intro');
    assert.match(await text(wc, '[data-copy=privacy]'), /Remove anything at any time\.$/, 'the period after "time"');
    await press(wc, '[data-import-start]');
    /* both subscribed: asked which, choosing is continuing */
    await until(async () => (await flow(wc)).dialog === 'provider-choice', 'Which provider?');
    await shot(wc, '02-provider');
    await press(wc, '[data-onboarding-provider="anthropic"]');
    /* the browser's sign-ins, over the first work question */
    await until(async () => { const f = await flow(wc); return f.dialog === 'keychain' && f.screen === 'roles'; }, 'the browser\'s sign-ins over "What kind of work do you do?"');
    assert.match(await text(wc, '[role=dialog] h3'), /Arc sign-ins/, 'the default browser, Arc');
    assert.equal(await js(wc, 'document.querySelectorAll("[role=dialog] p").length'), 0, 'no text under the question (Attachment 1)');
    await shot(wc, '03-keychain');
    await press(wc, '[data-import-keychain-allow]');
    /* roles */
    await until(async () => { const f = await flow(wc); return f.screen === 'roles' && !f.dialog; }, 'What kind of work do you do?');
    assert.equal(await has(wc, '[data-work-role][aria-checked=true]'), false, 'no role ticked for them');
    assert.equal(await has(wc, '.work-head .work-back'), false, 'Back is at the lower left, not the top');
    assert.equal(await has(wc, '.work-foot .work-back'), true);
    await press(wc, '[data-work-role="Researcher"]');
    await shot(wc, '04-roles');
    await pressText(wc, '.work-foot', 'Continue');
    /* the work: one line that grows, never resized by hand */
    await until(async () => (await flow(wc)).screen === 'work', 'What are you working on?');
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("#work-description")).resize'), 'none', 'not expandable (Attachment 2)');
    assert.equal(await js(wc, 'document.querySelector("#work-description").placeholder'), 'Understanding the Memex...');
    assert.equal(await js(wc, '[...document.querySelectorAll(".work-foot button")].find((b)=>b.textContent.trim().startsWith("Continue")).disabled'), true, 'Continue waits for a description');
    const centred = await js(wc, '(()=>{const r=document.querySelector("#work-description").getBoundingClientRect();return Math.abs((r.left+r.right)/2-innerWidth/2)<4&&r.width<=400&&Math.abs((r.top+r.bottom)/2-innerHeight/2)<innerHeight*0.2})()');
    assert.equal(centred, true, 'a small box, centred in the window');
    const short = await js(wc, 'document.querySelector("#work-description").getBoundingClientRect().height');
    await type(wc, '#work-description', 'I study how students ask for help. '.repeat(20));
    const tall = await js(wc, 'document.querySelector("#work-description").getBoundingClientRect().height');
    assert.ok(tall > short && tall <= 141, `it grows to a point, then scrolls (${short} → ${tall})`);
    await type(wc, '#work-description', 'I study how students ask for help.');
    await shot(wc, '05-work');
    await pressText(wc, '.work-foot', 'Continue');
    /* projects */
    await until(async () => (await flow(wc)).screen === 'projects', 'What project do you want to work on first?');
    await until(() => has(wc, '[data-work-project]'), 'the projects the agent found');
    const titles = await js(wc, '[...document.querySelectorAll("[data-work-project] b")].map((b)=>b.textContent)');
    assert.ok(titles.length >= 2 && titles.length <= 5, `2-5 projects: ${titles.join(', ')}`);
    await js(wc, 'document.querySelectorAll("[data-work-project]")[0].click()');
    await js(wc, 'document.querySelectorAll("[data-work-project]")[1].click()');
    await pause(100);
    await shot(wc, '06-projects');
    await pressText(wc, '.work-foot', 'Continue');
    /* the method, after the projects, over the next screen */
    await until(async () => { const f = await flow(wc); return f.dialog === 'import-mode' && f.screen === 'picker'; }, 'How would you like to import context? (over the picker)');
    assert.equal(await js(wc, '[...document.querySelectorAll("[role=dialog] button")].some((b)=>b.textContent.trim()==="Continue")'), false, 'no Continue: choosing is continuing');
    await shot(wc, '07-method');

    let ticked = [];
    if (MODE === 'auto') {
      await press(wc, '[data-import-mode="auto"]');
      await until(async () => (await flow(wc)).screen === 'tools', 'Confirm your tools');
      await until(() => spot(wc, '[data-import-run]'), 'the tool agent\'s answer');
      await shot(wc, '08-tools');
      assert.equal(await subtext(wc, '[data-work-tool]'), 0, 'no subtext under the tools');
      ticked = await js(wc, '[...document.querySelectorAll("[data-work-tool][aria-checked=true]")].map((b)=>b.dataset.workTool)');
      assert.ok(ticked.includes('Obsidian'), 'Obsidian, found on this Mac, ticked');
      // Nothing ticked that the agent said is not used (Attachment 3: OneNote "Not detected" yet ticked).
      const said = await js(wc, 'window.engelbartAPI.importDiscovery().then((d)=>d.tools.results.tools)');
      for (const id of ticked) { const fact = said.find((tool) => tool.id === id); if (fact) assert.equal(fact.used, true, `${id} ticked though the agent said it is not used`); }
      await press(wc, '[data-import-run]');
    } else {
      await press(wc, '[data-import-mode="manual"]');
      await until(async () => { const f = await flow(wc); return f.screen === 'picker' && !f.dialog; }, 'What should go in your library?');
      assert.equal(await has(wc, '.project-scope-strip'), false, 'no For/Edit (Attachment 15)');
      assert.equal(await has(wc, '.bar'), false, 'no Sources / From / Select all (Attachment 16)');
      assert.equal(await has(wc, '.consent'), false, 'no subscription card (Attachment 17)');
      assert.equal(await subtext(wc, '[data-app]'), 0, 'no subtext under the sources');
      // One group open at a time (Attachment 20).
      assert.equal(await js(wc, 'document.querySelector("[data-group=notes]").getAttribute("aria-expanded")'), 'true', 'Notes open first');
      await press(wc, '[data-group="transcripts"]');
      assert.equal(await js(wc, 'document.querySelector("[data-group=notes]").getAttribute("aria-expanded")'), 'false', 'Notes folded when Meeting transcripts opens');
      await press(wc, '[data-group="notes"]');
      if (await js(wc, 'document.querySelector("[data-app=Obsidian]").getAttribute("aria-checked")') !== 'true') await press(wc, '[data-app="Obsidian"]');
      // Specify context: optional, collapsed, its chevron level with its words (Attachment 19).
      assert.equal(await has(wc, '.review-context'), false, 'Specify context starts collapsed');
      const level = await js(wc, '(()=>{const b=document.querySelector("[data-specify-context=Obsidian]");const t=b.getBoundingClientRect(),s=b.querySelector("svg").getBoundingClientRect();return Math.abs((t.top+t.bottom)/2-(s.top+s.bottom)/2)})()');
      assert.ok(level <= 2, `the chevron is level with "Specify context" (${level}px off)`);
      await press(wc, '[data-specify-context="Obsidian"]');
      await until(() => has(wc, '.review-context'), 'its context open');
      assert.match(await text(wc, '.review-projects-note'), /^Select all projects you want Engelbart to import from Obsidian\.$/);
      assert.equal(await text(wc, '.review-context-label'), 'Further specify');
      assert.equal(await js(wc, 'document.querySelectorAll(".review-project").length'), 2, 'a pill for each project picked');
      await js(wc, 'document.querySelector(".review-project").click()');
      await type(wc, '[data-scope-note="Obsidian"]', 'Only my notes about help-seeking');
      await pressText(wc, '.review-context .folder-upload', 'Choose a folder');
      await until(() => has(wc, '.selected-folder-list > div'), 'the folder chosen');
      await pressText(wc, '.review-context .folder-upload', 'Choose files');
      await until(() => js(wc, 'document.querySelectorAll(".selected-folder-list > div").length===2'), 'the file chosen');
      await shot(wc, '08-picker-context');
      // Another source in another group: Notes folds.
      await press(wc, '[data-group="chats"]');
      if (await js(wc, 'document.querySelector("[data-app=ChatGPT]").getAttribute("aria-checked")') !== 'true') await press(wc, '[data-app="ChatGPT"]');
      ticked = await js(wc, '[...document.querySelectorAll("[data-app][aria-checked=true]")].map((b)=>b.dataset.app)');
      await shot(wc, '08b-picker-chats');
      await press(wc, '[data-import-run]');
    }

    /* Full Disk Access: one line each */
    await until(async () => (await flow(wc)).dialog === 'folders', 'Allow Full Disk Access');
    assert.equal(await js(wc, 'document.querySelectorAll("[role=dialog] p").length'), 1, 'one line (Attachment 5)');
    await shot(wc, '09-disk');
    await press(wc, '[data-import-disk-open]');
    await until(async () => (await flow(wc)).dialog === 'disk-wait', 'waiting for the switch');
    await shot(wc, '10-disk-wait');
    /* agents in the person's browser, asked once, in a line */
    await until(async () => (await flow(wc)).dialog === 'browser-agents', 'Let agents use Chrome?', 1200);
    assert.equal(await js(wc, 'document.querySelector("[role=dialog] p").textContent'), 'They’ll read your selected sources in the background.');
    await shot(wc, '11-browser-agents');
    await pressText(wc, '[role=dialog] .mf', 'Allow');

    /* the project opens; the status, then the sign-in popups one at a time */
    await until(() => has(wc, '[data-need-popup], [data-import-status]'), 'the status or a sign-in popup over the workspace', 1200);
    await shot(wc, '12-after-run');
    const projects = await js(wc, 'window.engelbartAPI.listProjects()');
    for (const title of titles.slice(0, 2)) assert.ok(projects.some((project) => project.name === title), `a project named for ${title}`);
    const list = await js(wc, 'window.engelbartAPI.connectList()');
    const run = list.find((entry) => entry.direct);
    assert.ok(run, 'a direct session');
    // A catalog web app is never sent to the person's browser for being signed out of Engelbart's: a popup asks instead.
    // (The other tools the agent named — Linear here — may be, when their sign-ins can't be copied: none can, on this Mac.)
    assert.equal(run.jobs.some((job) => job.route === 'browser' && job.apps.length), false, 'no catalog web app in the person\'s browser');
    if (MODE === 'manual') {
      const obsidian = (await js(wc, `window.engelbartAPI.connectState(${JSON.stringify(run.id)})`)).jobs.find((job) => job.apps.includes('Obsidian'));
      assert.ok(obsidian, 'Obsidian imported');
    }
    // A signed-out web app: its popup, never Engelbart's window, never a pill in the status.
    const popupApp = await until(() => js(wc, '(document.querySelector("[data-need-popup]")||{}).dataset'), 'a sign-in popup', 1200);
    assert.ok(popupApp.needPopup);
    assert.equal(BrowserWindow.getAllWindows().filter((one) => one.isVisible() && one !== win).length, 0, 'no other Engelbart window shown');
    assert.match(await text(wc, '[data-need-popup] h3'), /^Sign in to /);
    assert.equal(await text(wc, '[data-need-popup] p'), 'Continue in Arc.');
    assert.equal(await text(wc, '[data-need-popup] [data-need-primary]'), 'Open Arc');
    await shot(wc, '13-signin-popup');
    // Later puts it away; the status shows the row first, with "Needs you" that brings it back.
    const first = await text(wc, '[data-need-popup] h3');
    await pressText(wc, '[data-need-popup] .mf', 'Later');
    await until(async () => (await text(wc, '[data-need-popup] h3')) !== first, 'the next popup, or none');
    while (await has(wc, '[data-need-popup]')) { await pressText(wc, '[data-need-popup] .mf', 'Later'); await pause(200); }
    if (!(await has(wc, '[data-import-status]'))) await js(wc, `document.querySelector("[data-connect-dock-open]") && document.querySelector("[data-connect-dock-open]").click()`);
    await until(() => has(wc, '[data-import-status]'), 'the status');
    await until(() => has(wc, '[data-need-open]'), 'a "Needs you" row');
    await shot(wc, '14-status');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-background-job]")].filter((row)=>getComputedStyle(row).borderBottomWidth!=="0px"||getComputedStyle(row).borderTopWidth!=="0px").length'), 0, 'no dividing lines');
    assert.equal(await subtext(wc, '[data-background-job]'), 0, 'no subtext under the rows');
    const order = await js(wc, '[...document.querySelectorAll("[data-background-job]")].map((row)=>!!row.querySelector("[data-need-open]"))');
    assert.ok(order.indexOf(false) === -1 || order.slice(order.indexOf(false)).every((needs) => !needs), `the ones that need you at the top (${order})`);
    assert.equal(await text(wc, '[data-import-status-close]'), 'Continue in Engelbart');
    await press(wc, '[data-need-open]');
    await until(() => has(wc, '[data-need-popup]'), 'its popup again');
    // Skip each sign-in (this Mac has no browser to sign in with): the run ends.
    for (let i = 0; i < 20; i++) {
      const open = await js(wc, `window.engelbartAPI.connectState(${JSON.stringify(run.id)}).then((s)=>s.needs.map((need)=>need.id))`);
      if (!open.length) break;
      await js(wc, `window.engelbartAPI.connectNeed(${JSON.stringify(run.id)}, ${JSON.stringify(open[0])}, 'skip')`);
      await pause(200);
    }
    await until(() => js(wc, 'window.engelbartAPI.connectList()').then((all) => { const s = all.find((entry) => entry.id === run.id); return s && s.jobs.filter((job) => job.kind !== 'memory' && job.kind !== 'redact').every((job) => ['done', 'failed', 'stopped'].includes(job.status)); }), 'every import ended', 1200);
    // The completion opens by itself, in place of the header's pill.
    await until(() => js(wc, '/Your imports (are complete!|have finished)/.test((document.querySelector("[data-import-status] h3")||{}).textContent||"")'), 'Your imports are complete!', 1200);
    await shot(wc, '15-complete');
    assert.equal(await text(wc, '[data-import-status-close]'), 'Open library');
    const logos = await js(wc, '[...document.querySelectorAll("[data-imported]")].map((el)=>el.dataset.imported)');
    assert.ok(logos.length >= 1, 'a tile for what came in');
    assert.equal(new Set(logos).size, logos.length, 'one tile a logo');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-import-status] .cb, [data-import-status] .review-logo > span").length'), 0, 'no checkmarks on the tiles');
    assert.doesNotMatch(await text(wc, '[data-import-status]'), /MEMORY/);
    assert.equal(await has(wc, '[data-connect-dock="done"]'), false, 'no Done pill in the header');
    /* library only: nothing in the workspace's context */
    const files = (dir, name, out = []) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory() && !['node_modules', 'worktrees'].includes(entry.name)) files(full, name, out); else if (entry.name === name) out.push(full); } return out; };
    const contexts = files(path.join(root, '.engelbart'), 'meta.json').flatMap((file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).context || []; } catch { return []; } }).flat(Infinity).filter((id) => typeof id === 'string');
    const md = (await js(wc, 'window.engelbartAPI.library()')).filter((row) => row.type === 'md' && !row.tags.includes('note')).map((row) => row.id);
    assert.equal(md.filter((id) => contexts.includes(id)).length, 0, 'what came in is in the library, not a workspace\'s context');
    await press(wc, '[data-import-status-close]');
    await until(() => js(wc, '!document.querySelector("[data-import-status]")'), 'Open library closes it');
    console.log(`smoke-import-context (${MODE}): ok (${titles.length} projects found, ${ticked.length} ${MODE === 'auto' ? 'tools' : 'sources'} ticked, ${logos.length} imported tiles)`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'failed'); console.error(await flow(wc)); } catch { /* none */ }
    app.exit(1);
  }
});
