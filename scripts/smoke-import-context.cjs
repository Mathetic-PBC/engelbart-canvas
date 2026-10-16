'use strict';

// npm run build && npx electron scripts/smoke-import-context.cjs            (in the background with agents)
// npm run build && ENGELBART_SMOKE_MODE=manual npx electron scripts/smoke-import-context.cjs   (manually: the librarian)
// Import your context (round 3, 2026-10-13, docs/onboarding-round-3.md; From Amitav, 2026-10-15), walked in the real app,
// hidden, against a disposable home with stand-ins for this Mac: Connect's fake agents (ENGELBART_CONNECT_FAKE), Claude
// and Codex both subscribed (ENGELBART_PROVIDERS_FAKE=both: the provider asked), Arc the default browser with Chrome
// installed (ENGELBART_ONBOARDING_BROWSERS), Full Disk Access off until System Settings is "opened"
// (ENGELBART_DISK_ACCESS=denied, which grants it 2.5 s later), no browser whose cookies can be read (so every web app is
// signed out: a sign-in popup), Chrome holding the browser extension though the person's CLI does not let its agents use
// it yet (ENGELBART_BROWSER_AGENTS=ask).
//   welcome → Import your context (intro) → Import context → Which provider? (one click) → the browser's sign-ins, over
//   "What kind of work do you do?" (no subtext) → roles → "What are you interested in researching right now?" (one line
//   that grows) → projects → What should go in your library? (the categories, what the tool agent found ticked, its extra
//   tools in theirs with no icon; Gmail paused; one group open at a time; a category's Specify context with no projects, a
//   tool's with every project ticked until narrowed) → Import to Engelbart → How should Engelbart import your sources?
//     auto:   Import context using background agents (Back, Import manually, I understand) → Allow Full Disk Access →
//             Turn on → the project opens → the status (no subtext, no lines) and the sign-in popups, one at a time, no
//             line under them (Skip; "Needs you" brings one back) → Your imports are complete, with the logos
//     manual: the librarian's chat (its Back to the tools screen, no dividing lines), what was specified told to it; put
//             away, the projects are made and the first opens
//   → Import context from Settings: the tools screen at once, nothing ticked.
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
    await until(async () => { const f = await flow(wc); return f && f.screen === 'intro' && !f.dialog; }, 'Import your context, a screen of its own');
    await shot(wc, '01-intro');
    // From Amitav (2026-10-15): every supported app's logo with no "+12", fitted to the window; no "Remove anything at any
    // time. Learn more"; Skip, not Start from scratch; no notifications or settings in the top right while onboarding.
    assert.equal(await has(wc, '[data-copy=privacy]'), false, 'no "Remove anything at any time."');
    assert.equal(await js(wc, '[...document.querySelectorAll(".intro-page .ic")].some((ic)=>/^\\+\\d/.test(ic.textContent.trim()))'), false, 'no +12');
    assert.ok(await js(wc, 'document.querySelectorAll(".intro-page .ic img").length') > 8, 'every supported app, not the first eight');
    for (const [w, h] of [[1280, 900], [900, 560]]) {
      win.setSize(w, h);
      await pause(200);
      const fits = await js(wc, '(()=>{const r=[...document.querySelectorAll(".intro-page h1, .intro-page .ic, .intro-page .actions>*")].map((e)=>e.getBoundingClientRect());return r.every((b)=>b.left>=0&&b.right<=innerWidth&&b.top>=0&&b.bottom<=innerHeight)&&document.scrollingElement.scrollHeight<=innerHeight})()');
      assert.equal(fits, true, `the logos and the buttons fit a ${w}×${h} window, nothing to scroll`);
      assert.equal(await js(wc, 'Math.abs(document.querySelector(".intro-page .scratch-link").getBoundingClientRect().left-document.querySelector(".intro-page .ic").getBoundingClientRect().left)<=1'), true, 'Skip lines up with the logos');
      await shot(wc, `01-intro-${w}x${h}`);
    }
    win.setSize(1280, 900);
    await pause(150);
    assert.equal(await text(wc, '.intro-page .scratch-link'), 'Skip');
    assert.equal(await has(wc, '.notification-bell, .settings-gear'), false, 'no notifications or settings in onboarding');
    await press(wc, '[data-import-start]');
    /* both subscribed: asked which, choosing is continuing */
    await until(async () => { const f = await flow(wc); return f.dialog === 'provider-choice' && f.screen === 'intro'; }, 'Which provider? (over the intro)');
    await shot(wc, '02-provider');
    await press(wc, '[data-onboarding-provider="anthropic"]');
    /* the browser's sign-ins, over the first work question */
    // 2026-10-14: the intro stays behind its popups ("the background should never change when a new popup comes").
    await until(async () => { const f = await flow(wc); return f.dialog === 'keychain' && f.screen === 'intro'; }, 'the browser\'s sign-ins, over the intro');
    // From Amitav (2026-10-15): no question mark, no key, no Don't allow (they have to allow, so no "Are you sure?" after
    // it either), and one line saying where it all stays.
    assert.equal(await text(wc, '[role=dialog] h3'), 'Allow Engelbart to use your Arc sign-ins', 'the default browser, Arc; no question mark');
    assert.equal(await text(wc, '[role=dialog] h3 + p'), 'Everything is stored locally on your own device.');
    assert.equal(await has(wc, '[role=dialog] .key'), false, 'no key icon');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[role=dialog] button")].map((b)=>b.textContent.trim())'), ['Use another browser', 'Allow']);
    await shot(wc, '03-keychain');
    await press(wc, '[data-import-keychain-allow]');
    /* roles */
    await until(async () => { const f = await flow(wc); return f.screen === 'roles' && !f.dialog; }, 'What kind of work do you do?');
    assert.equal(await has(wc, '[data-work-role][aria-checked=true]'), false, 'no role ticked for them');
    assert.equal(await has(wc, '.work-head .work-back'), false, 'Back is at the lower left, not the top');
    assert.equal(await has(wc, '.work-foot .work-back'), true);
    await press(wc, '[data-work-role="Researcher"]');
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-work-role=Researcher]")).borderColor'), 'rgb(23, 23, 23)', 'what is chosen is outlined in black (From Amitav)');
    await shot(wc, '04-roles');
    await pressText(wc, '.work-foot', 'Continue');
    /* the work: one line that grows, never resized by hand */
    await until(async () => (await flow(wc)).screen === 'work', 'What are you interested in researching right now?');
    assert.equal(await text(wc, '.work-head h1'), 'What are you interested in researching?');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-import-screen=work] p, [data-import-screen=work] small").length'), 0, 'no line about the keys');
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector("#work-description")).resize'), 'none', 'not expandable (Attachment 2)');
    assert.equal(await js(wc, 'document.querySelector("#work-description").placeholder'), 'Understanding the Memex...');
    assert.equal(await js(wc, '[...document.querySelectorAll(".work-foot button")].find((b)=>b.textContent.trim().startsWith("Continue")).disabled'), true, 'Continue waits for a description');
    // The onboarding beta's one fluid scale (S2, 2026-10-16): sizes are the design's times --ix-scale.
    const scale = await js(wc, 'parseFloat(getComputedStyle(document.querySelector(".ix")).getPropertyValue("--ix-scale"))||1');
    const centred = await js(wc, `(()=>{const r=document.querySelector("#work-description").getBoundingClientRect();return Math.abs((r.left+r.right)/2-innerWidth/2)<4&&r.width<=400*${scale}+2&&Math.abs((r.top+r.bottom)/2-innerHeight/2)<innerHeight*0.25})()`);
    assert.equal(centred, true, 'a small box (at the window\'s scale), centred in the window');
    const short = await js(wc, 'document.querySelector("#work-description").getBoundingClientRect().height');
    await type(wc, '#work-description', 'I study how students ask for help. '.repeat(20));
    const tall = await js(wc, 'document.querySelector("#work-description").getBoundingClientRect().height');
    assert.ok(tall > short && tall <= 141 * scale + 2, `it grows to a point, then scrolls (${short} → ${tall})`);
    await type(wc, '#work-description', 'I study how students ask for help.');
    await shot(wc, '05-work');
    // Shift+Enter is a new paragraph; Enter continues.
    await js(wc, 'document.querySelector("#work-description").focus()');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
    wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
    await pause(150);
    assert.equal((await flow(wc)).screen, 'work', 'Shift+Enter stays');
    assert.match(await js(wc, 'document.querySelector("#work-description").value'), /\n$/, 'Shift+Enter, a new line');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    /* projects */
    await until(async () => (await flow(wc)).screen === 'projects', 'What project do you want to work on first?');
    await until(() => has(wc, '[data-work-project]'), 'the projects the agent found');
    const titles = await js(wc, '[...document.querySelectorAll("[data-work-project] b")].map((b)=>b.textContent)');
    assert.ok(titles.length >= 2 && titles.length <= 5, `2-5 projects: ${titles.join(', ')}`);
    await js(wc, 'document.querySelectorAll("[data-work-project]")[0].click()');
    await js(wc, 'document.querySelectorAll("[data-work-project]")[1].click()');
    await pause(100);
    await shot(wc, '06-projects');
    // From Amitav (2026-10-15): no project icons; Add a project the size of a project, still a popup, its hints the Memex.
    assert.equal(await has(wc, '[data-import-screen=projects] .project-symbol'), false, 'no project icons');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-work-project]")].every((row)=>{const when=row.querySelector(".project-recency");if(!when)return true;const box=row.lastElementChild.getBoundingClientRect(),at=when.getBoundingClientRect();return at.width<=100&&box.left-at.right<=24})'), true, 'when a project was worked on stays beside its circle');
    const sizes = await js(wc, '(()=>{const rows=[...document.querySelectorAll("[data-work-project]")].map((e)=>e.getBoundingClientRect().height);return {row:Math.min(...rows),add:document.querySelector("[data-import-screen=projects] .add-project").getBoundingClientRect().height}})()');
    assert.ok(Math.abs(sizes.row - sizes.add) <= 1, `Add a project is a project's size (${sizes.add} vs ${sizes.row})`);
    await press(wc, '[data-import-screen=projects] .add-project');
    await until(async () => (await flow(wc)).dialog === 'work-add-project', 'Add a project, a popup');
    assert.equal(await js(wc, 'document.querySelector("#custom-project-title").placeholder'), 'Memex');
    assert.equal(await js(wc, 'document.querySelector("#custom-project-description").placeholder'), 'Understanding the history of the Memex');
    await shot(wc, '06b-add-project');
    await pressText(wc, '[role=dialog]', 'Cancel');
    await until(async () => !(await flow(wc)).dialog, 'Add a project closed');
    await pressText(wc, '.work-foot', 'Continue');
    /* one tools screen (From Amitav, 2026-10-15): the categories, with what the tool agent found ticked and its extra tools
       added in theirs, no icon */
    await until(async () => { const f = await flow(wc); return f.screen === 'picker' && !f.dialog; }, 'What should go in your library?, at once');
    await until(async () => !(await has(wc, '[data-tools-status]')), 'the tool agent\'s answer', 1200);
    await pause(400); // the flow is saved 300 ms after it changes
    const saved = await js(wc, 'window.engelbartAPI.importFlow()');
    let ticked = saved.picks;
    assert.equal(await has(wc, '[data-group=email], [data-app=Gmail]'), false, 'Gmail is paused');
    assert.equal(await has(wc, '.project-scope-strip'), false, 'no For/Edit (Attachment 15)');
    assert.equal(await has(wc, '.bar'), false, 'no Sources / From / Select all (Attachment 16)');
    assert.equal(await has(wc, '.consent'), false, 'no subscription card (Attachment 17)');
    assert.equal(await subtext(wc, '[data-app]'), 0, 'no subtext under the sources');
    assert.ok(ticked.includes('Obsidian'), 'Obsidian, found on this Mac, ticked');
    // Nothing ticked that the agent said is not used (Attachment 3: OneNote "Not detected" yet ticked).
    const said = await js(wc, 'window.engelbartAPI.importDiscovery().then((d)=>d.tools.results)');
    for (const id of ticked) { const fact = said.tools.find((tool) => tool.id === id); if (fact) assert.equal(fact.used, true, `${id} ticked though the agent said it is not used`); }
    // Its extra tools, each in a category the picker has (Other when none fits), ticked when in use, with no icon.
    for (const extra of said.additional) {
      const id = `custom:${extra.name.toLowerCase()}`;
      assert.ok(ticked.includes(id), `${extra.name}, found in use, ticked`);
      await press(wc, `[data-group="${extra.category || 'other'}"]`);
      await until(() => has(wc, `[data-app="${id}"]`), `${extra.name} under ${extra.category || 'other'}`);
      assert.deepEqual(await js(wc, `(()=>{const row=document.querySelector('[data-app="${id}"]');return {logo:!!row.querySelector('.no-logo'),drawn:row.querySelectorAll('img, svg').length - row.querySelectorAll('.cb svg').length}})()`), { logo: false, drawn: 0 }, `${extra.name}: no icon, and no room kept for one (S7)`);
    }
    assert.equal(await has(wc, '[data-add-tool]'), true, '+ Add a tool');
    await press(wc, '[data-group="notes"]');
    await shot(wc, '07-tools');
    // 2026-10-16 (S6): every category open, with no chevron, and no "Specify context for all {category}"; a source's own
    // stays closed until its row's Specify context is clicked.
    assert.equal(await has(wc, '.group-head .expand, [data-specify-group], [data-context-panel^="group:"]'), false, 'no category-level fold or Specify context');
    assert.equal(await has(wc, '[data-app="Obsidian"]') && await has(wc, '[data-app="Granola"]'), true, 'every category open');
    assert.equal(await has(wc, '[data-context-panel="Obsidian"]'), false, 'Obsidian\'s own stays closed');
    const level = await js(wc, '(()=>{const b=document.querySelector("[data-specify-context=Obsidian]");const t=b.getBoundingClientRect(),s=b.querySelector("svg").getBoundingClientRect();return Math.abs((t.top+t.bottom)/2-(s.top+s.bottom)/2)})()');
    assert.ok(level <= 2, `the chevron is level with "Specify context" (${level}px off)`);
    // A tool's own: every project picked ticked until it is narrowed, never none.
    await press(wc, '[data-specify-context="Obsidian"]');
    await until(() => has(wc, '[data-context-panel="Obsidian"]'), 'Obsidian\'s own context open');
    assert.match(await text(wc, '[data-context-panel="Obsidian"] .review-projects-note'), /^Select all projects you want Engelbart to import from Obsidian\.$/);
    assert.equal(await text(wc, '[data-context-panel="Obsidian"] .review-context-label'), 'Specific things to import from Obsidian (optional)');
    const pills = () => js(wc, '[...document.querySelectorAll("[data-context-panel=Obsidian] .review-project")].map((b)=>b.getAttribute("aria-checked"))');
    assert.deepEqual(await pills(), ['true', 'true'], 'every project picked, ticked from the start');
    if (MODE === 'manual') {
      await js(wc, 'document.querySelector("[data-context-panel=Obsidian] .review-project").click()');
      await pause(100);
      assert.deepEqual(await pills(), ['false', 'true'], 'narrowed to one');
      await js(wc, 'document.querySelectorAll("[data-context-panel=Obsidian] .review-project")[1].click()');
      await pause(100);
      assert.deepEqual(await pills(), ['false', 'true'], 'the last one stays: a source is for one project at least');
      await type(wc, '[data-scope-note="Obsidian"]', 'Only my notes about help-seeking');
      // One Choose files; Obsidian's opens a picker over its vaults.
      assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-context-panel=Obsidian] .folder-upload button")].map((b)=>b.textContent)'), ['Choose files']);
      await press(wc, '[data-choose-files="Obsidian"]');
      await until(async () => (await flow(wc)).dialog === 'obsidian-picker', 'Choose from Obsidian');
      await until(() => has(wc, '[data-obsidian-path$="/Research"]'), 'the vault\'s folders');
      await shot(wc, '08a-obsidian-picker');
      await js(wc, 'document.querySelector("[data-obsidian-path$=\'/Research\'] .ob-box").click()');
      await press(wc, '[data-obsidian-add]');
      await until(() => has(wc, '.selected-folder-list > div'), 'the folder chosen');
      await shot(wc, '08-picker-context');
      // Saved websites from Obsidian, under Websites.
      await press(wc, '[data-group="sites"]');
      await until(() => has(wc, '[data-app="links:Obsidian"]'), 'Saved websites from Obsidian');
      assert.equal(await text(wc, '[data-app="links:Obsidian"] .app-text'), 'Saved websites from Obsidian');
      if (await js(wc, 'document.querySelector("[data-app=\'links:Obsidian\']").getAttribute("aria-checked")') !== 'true') await press(wc, '[data-app="links:Obsidian"]');
      await shot(wc, '08c-websites');
      await pause(400);
      ticked = (await js(wc, 'window.engelbartAPI.importFlow()')).picks;
    }

    /* Import to Engelbart: how (From Amitav, 2026-10-15), choosing is continuing */
    await press(wc, '[data-import-run]');
    await until(async () => (await flow(wc)).dialog === 'import-method', 'How should Engelbart import your sources?');
    assert.equal(await text(wc, '[role=dialog] h3'), 'How should Engelbart import your sources?');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-import-method] b")].map((b)=>b.textContent)'), [await js(wc, 'document.querySelector("[data-import-method=agents] b").dataset.recommended === "1"') ? 'Import in the background with agents (recommended)' : 'Import in the background with agents', 'Import manually with fine-grained permissions']);
    assert.equal(await js(wc, '[...document.querySelectorAll("[role=dialog] button")].some((b)=>b.textContent.trim()==="Continue")'), false, 'no Continue: choosing is continuing');
    await shot(wc, '09-method');
    if (MODE === 'auto') {
      await press(wc, '[data-import-method="agents"]');
      await until(async () => (await flow(wc)).dialog === 'agents-consent', 'Import context using background agents');
      assert.equal(await text(wc, '[role=dialog] h3'), 'Import context using background agents');
      assert.equal(await text(wc, '[role=dialog] p'), 'Engelbart will use Claude Code and your signed-in Arc to find and import context from the sources you selected. Agents run in the background, and imported files are saved locally on your device. Content the agents read may be sent to Anthropic for processing.');
      assert.deepEqual(await js(wc, '[...document.querySelectorAll("[role=dialog] .mf button")].map((b)=>b.textContent.trim())'), ['Back', 'Import manually', 'I understand']);
      assert.equal(await js(wc, 'getComputedStyle(document.querySelector("[data-import-manually]")).backgroundColor'), 'rgba(0, 0, 0, 0)', 'Import manually: a pill with no fill');
      await shot(wc, '10-agents-consent');
      // Back goes to the question; the second time, I understand.
      await pressText(wc, '[role=dialog] .mf', 'Back');
      await until(async () => (await flow(wc)).dialog === 'import-method', 'back to the question');
      await press(wc, '[data-import-method="agents"]');
      await until(async () => (await flow(wc)).dialog === 'agents-consent', 'the consent again');
      await press(wc, '[data-import-understood]');
    } else {
      await press(wc, '[data-import-method="manual"]');
    }

    /* two projects picked: which one opens (2026-10-14) */
    await until(async () => (await flow(wc)).dialog === 'first-project', 'Which project do you want to start with?');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-first-project]").length'), 2);
    assert.equal(await has(wc, '[role=dialog] .project-symbol'), false, 'no project icons here either');
    await shot(wc, '08d-first-project');
    await js(wc, 'document.querySelectorAll("[data-first-project]")[1].click()');
    const startWith = await js(wc, 'document.querySelectorAll("[data-first-project]")[1].textContent');
    await press(wc, '[data-first-project-open]');

    /* Allow Engelbart to organize your research (2026-10-15, in place of Full Disk Access), either way */
    await until(async () => (await flow(wc)).dialog === 'organize', 'Allow Engelbart to organize your research');
    assert.equal(await text(wc, '[role=dialog] h3'), 'Allow Engelbart to organize your research');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-organize-row] > span:first-child")].map((s)=>s.textContent)'), ['View my files locally', 'Analyze using agents']);
    assert.equal(await text(wc, '[data-organize-connect]'), 'Connect desktop');
    assert.equal(await text(wc, '[data-organize-enabled="agents"]'), 'Enabled');
    assert.equal(await js(wc, 'document.querySelector("[data-organize-continue]").disabled'), true, 'Continue once the folders were asked about');
    assert.doesNotMatch(await js(wc, 'document.body.innerText'), /Full Disk Access|System Settings/);
    await shot(wc, '10-organize');
    await press(wc, '[data-organize-connect]');
    await until(() => has(wc, '[data-organize-enabled="files"]'), 'View my files locally: Enabled');
    await shot(wc, '10b-organize-enabled');
    await press(wc, '[data-organize-continue]');

    if (MODE === 'manual') {
      /* Import manually: the librarian's chat (Connect your library's page) on the same choices; no Full Disk Access */
      await until(async () => (await flow(wc)).screen === 'librarian', 'the librarian\'s chat', 1200);
      // The librarian asks once, first (2026-10-16, in place of a popup per app): one message, every app unticked, Select
      // all beside a Grant access that waits for a tick; nothing of them runs, and the librarian waits, until it is answered.
      await until(() => has(wc, '[data-connect-grant="live"]'), 'Allow Engelbart to access the following apps:', 1200);
      const firstChat = (await js(wc, 'window.engelbartAPI.connectList()')).find((entry) => !entry.direct && !entry.stopped);
      assert.equal(await has(wc, '[data-need-popup]'), false, 'no popup per app');
      const asked = await js(wc, '[...document.querySelectorAll("[data-connect-grant-app]")].map((el)=>el.dataset.connectGrantApp)');
      assert.ok(asked.length >= 2, `a row for each web app, connector and tool: ${asked.join(', ')}`);
      assert.equal(await js(wc, 'document.querySelectorAll("[data-connect-grant-app][aria-checked=true]").length'), 0, 'every one unticked');
      assert.equal(await js(wc, 'document.querySelector("[data-connect-grant-go]").disabled'), true, 'Grant access waits for a tick');
      assert.equal(await text(wc, '[data-connect-grant-all]'), 'Select all');
      assert.equal(await has(wc, '[data-connect-draft]'), false, 'no Reply box on the onboarding page');
      const webJobs = async () => (await js(wc, `window.engelbartAPI.connectState(${JSON.stringify(firstChat.id)})`)).jobs.filter((job) => job.apps.some((app) => asked.includes(app)));
      assert.deepEqual(await webJobs(), [], 'nothing of them runs before Grant access');
      await pause(500); // the message's rise
      await shot(wc, '11-librarian-grant');
      const first = asked[0];
      await press(wc, `[data-connect-grant-app="${first}"]`);
      assert.equal(await js(wc, 'document.querySelector("[data-connect-grant-go]").disabled'), false);
      await press(wc, '[data-connect-grant-go]');
      await until(async () => (await js(wc, `window.engelbartAPI.connectState(${JSON.stringify(firstChat.id)})`)).log.some((entry) => /^Allowed Engelbart to access /.test(entry.text)), `${first} allowed`);
      await until(() => has(wc, '[data-connect-grant="answered"]'), 'the grant folded to one line');
      await until(() => has(wc, '[data-connect-agent]'), 'the librarian\'s first words, after the grant', 1200);
      assert.deepEqual((await webJobs()).filter((job) => !job.apps.includes(first)), [], 'what was left out never ran');
      await shot(wc, '11b-librarian-asked');
      // Its back arrow stops that chat and brings back the tools screen, not Connect your library's own choose screen.
      await press(wc, 'button.bart-ic[aria-label="Back"]');
      await until(async () => { const f = await flow(wc); return f && f.screen === 'picker' && !f.dialog; }, 'the tools screen again');
      await until(() => js(wc, `window.engelbartAPI.connectState(${JSON.stringify(firstChat.id)}).then((s)=>s.stopped)`), 'that chat stopped');
      await press(wc, '[data-import-run]');
      await until(async () => (await flow(wc)).dialog === 'import-method', 'How should Engelbart import your sources?, again');
      await press(wc, '[data-import-method="manual"]');
      await until(async () => (await flow(wc)).screen === 'librarian', 'the librarian\'s chat, again', 1200);
      await until(() => has(wc, '[data-connect-grant="live"]'), 'the grant, again', 1200);
      // Select all reads Deselect all once every one is ticked.
      await press(wc, '[data-connect-grant-all]');
      assert.equal(await text(wc, '[data-connect-grant-all]'), 'Deselect all');
      await press(wc, '[data-connect-grant-go]');
      await until(() => has(wc, '[data-connect-agent]'), 'the librarian\'s first words, again', 1200);
      assert.equal(await js(wc, '[...document.querySelectorAll("[data-connect-library] *")].filter((el)=>{const c=getComputedStyle(el);return (parseFloat(c.borderTopWidth)>0&&c.borderTopStyle!=="none"&&el.getBoundingClientRect().width>200&&parseFloat(c.borderLeftWidth)===0)||(parseFloat(c.borderBottomWidth)>0&&c.borderBottomStyle!=="none"&&el.getBoundingClientRect().width>200&&parseFloat(c.borderLeftWidth)===0)}).length'), 0, 'no dividing lines in the chat');
      const chat = (await js(wc, 'window.engelbartAPI.connectList()')).find((entry) => !entry.direct && !entry.stopped);
      assert.ok(chat, 'a librarian session, not a background run');
      const choices = JSON.parse(fs.readFileSync(path.join(root, '.engelbart', '.connect', chat.id, 'session.json'), 'utf8')).choices;
      assert.ok(choices.sources.notes.apps.includes('Obsidian'));
      // What was specified, its saved websites' line among it, for the librarian.
      assert.match(choices.custom, /- Obsidian: Only my notes about help-seeking\. Also bring in the web links saved in these notes.*; only these folders and files: .*Research; only for these of the projects: /, choices.custom);
      assert.equal(await js(wc, '/Your answer/.test(document.body.innerText)'), false, 'nothing says Your answer');
      // The librarian's question stays answerable whatever Engelbart adds under it (a step, a line about an app): M2.
      await until(() => has(wc, '[data-connect-card="live"]'), 'the librarian\'s question, live', 1200);
      assert.equal(await has(wc, '[data-connect-dock-open]'), false, 'no chip for a chat that is on screen, nor for the one Back stopped');
      await pause(500);
      await shot(wc, '11c-librarian-chat');
      // Finish in background (no arrow): Import, then straight on; the projects are made and the first opens.
      assert.equal(await text(wc, '[data-connect-import]'), 'Finish in background');
      await press(wc, '[data-connect-import]');
      await until(() => js(wc, '!document.querySelector("[data-import-flow]")'), 'the project open', 1200);
      const made = await js(wc, 'window.engelbartAPI.listProjects()');
      for (const title of titles.slice(0, 2)) assert.ok(made.some((project) => project.name === title), `a project named for ${title}`);
      await shot(wc, '12-after-librarian');
    }

    let logos = [];
    if (MODE === 'auto') {
    // No "Let agents use Chrome?" any more: I understand said it (From Amitav, 2026-10-15).

    /* the project opens; the status, then the sign-in popups one at a time */
    await until(() => has(wc, '[data-need-popup], [data-import-status]'), 'the status or a sign-in popup over the workspace', 1200);
    await shot(wc, '12-after-run');
    assert.doesNotMatch(await js(wc, 'document.body.innerText'), /still in beta/, 'no "still in beta" line on the welcome page (2026-10-15)');
    const projects = await js(wc, 'window.engelbartAPI.listProjects()');
    for (const title of titles.slice(0, 2)) assert.ok(projects.some((project) => project.name === title), `a project named for ${title}`);
    const list = await js(wc, 'window.engelbartAPI.connectList()');
    const run = list.find((entry) => entry.direct);
    assert.ok(run, 'a direct session');
    // A catalog web app is never sent to the person's browser for being signed out of Engelbart's: a popup asks instead.
    // (The other tools the agent named — Linear here — may be, when their sign-ins can't be copied: none can, on this Mac.)
    assert.equal(run.jobs.some((job) => job.route === 'browser' && job.apps.length), false, 'no catalog web app in the person\'s browser');
    // A signed-out web app: its popup, never Engelbart's window, never a pill in the status.
    const popupApp = await until(() => js(wc, '(document.querySelector("[data-need-popup]")||{}).dataset'), 'a sign-in popup', 1200);
    assert.ok(popupApp.needPopup);
    assert.equal(BrowserWindow.getAllWindows().filter((one) => one.isVisible() && one !== win).length, 0, 'no other Engelbart window shown');
    // A connector nothing reaches (Granola, when the tool agent names it) is held on a Connect popup of its own first
    // (2026-10-14: its import used to start without the connection, and could never use one made mid-run); it opens the
    // default browser, so it names none. A web app's sign-in continues in Arc.
    if (/^Connect /.test(await text(wc, '[data-need-popup] h3'))) {
      assert.equal(await has(wc, '[data-need-popup] .need-modal > p'), false, 'no line under a Connect popup');
      assert.equal(await text(wc, '[data-need-popup] [data-need-primary]'), 'Connect');
      await shot(wc, '13a-connect-popup');
      await pressText(wc, '[data-need-popup] .mf', 'Skip');
      // A signed-out web app's card comes once its quiet copies have failed (recover: about half a minute).
      await until(async () => /^Sign in to /.test(await text(wc, '[data-need-popup] h3')), 'the next popup: a sign-in brought back', 4000);
    }
    // The overlay is the scrim (the whole window), so native views step aside for it, and a click on Skip lands on Skip.
    assert.equal(await js(wc, '(()=>{const s=document.querySelector("[data-need-popup] .scrim");const r=s.getBoundingClientRect();const l=document.querySelector("[data-need-later]").getBoundingClientRect();return s.dataset.overlay==="1"&&r.width===innerWidth&&r.height===innerHeight&&document.elementFromPoint(l.x+l.width/2,l.y+l.height/2)===document.querySelector("[data-need-later]")})()'), true, 'the scrim is the overlay, Later on top');
    assert.match(await text(wc, '[data-need-popup] h3'), /^Sign in to /);
    assert.equal(await has(wc, '[data-need-popup] .need-modal > p'), false, 'no "Continue in Arc." (From Amitav, 2026-10-15)');
    // Signed out of every browser here: the sign-in brought back is one card (2026-10-16), signed in inside Engelbart, or
    // for Google's in Arc.
    assert.match(await text(wc, '[data-need-popup] [data-need-primary]'), /^Sign in (inside Engelbart|in Arc)$/);
    await shot(wc, '13-signin-popup');
    // Skip (Later until From Amitav, 2026-10-15) puts the step away for good: skipped, no "Needs you" left anywhere.
    const first = await text(wc, '[data-need-popup] h3');
    const firstId = await js(wc, 'document.querySelector("[data-need-popup]").dataset.needPopup');
    await pressText(wc, '[data-need-popup] .mf', 'Skip');
    await until(async () => (await text(wc, '[data-need-popup] h3')) !== first, 'the next popup, or none');
    await until(() => js(wc, `window.engelbartAPI.connectState(${JSON.stringify(run.id)}).then((s)=>!s.needs.some((need)=>need.id===${JSON.stringify(firstId)}))`), 'Skip skipped it');
    while (await has(wc, '[data-need-popup]')) { await pressText(wc, '[data-need-popup] .mf', 'Skip'); await pause(200); }
    if (!(await has(wc, '[data-import-status]'))) await js(wc, `document.querySelector("[data-connect-dock-open]") && document.querySelector("[data-connect-dock-open]").click()`);
    await until(() => has(wc, '[data-import-status]'), 'the status');
    await shot(wc, '14-status');
    assert.equal(await has(wc, '[data-need-open]'), false, 'no "Needs you" row once every step was put away');
    assert.equal(await js(wc, '[...document.querySelectorAll("[data-background-job]")].filter((row)=>getComputedStyle(row).borderBottomWidth!=="0px"||getComputedStyle(row).borderTopWidth!=="0px").length'), 0, 'no dividing lines');
    assert.equal(await subtext(wc, '[data-background-job]'), 0, 'no subtext under the rows');
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
    logos = await js(wc, '[...document.querySelectorAll("[data-imported]")].map((el)=>el.dataset.imported)');
    // 2026-10-15: what came in as a list, an icon and a name a row, each logo once, and nothing about the rest.
    assert.ok(logos.length >= 1, 'a row for what came in');
    assert.equal(new Set(logos).size, logos.length, 'one row a logo');
    assert.equal(await js(wc, '(()=>{const rows=[...document.querySelectorAll("[data-import-status] .imported-row")].map((r)=>r.getBoundingClientRect());return rows.every((r,i)=>i===0||r.top>=rows[i-1].bottom-1)})()'), true, 'stacked');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-import-status] .review-logo, [data-import-status] .missed-line").length'), 0, 'no tiles, no lines about the rest');
    assert.doesNotMatch(await text(wc, '[data-import-status]'), /MEMORY|Nothing came in/);
    assert.equal(await has(wc, '[data-connect-dock="done"]'), false, 'no Done pill in the header');
    /* the Welcome project's folder: everything that came in */
    const files = (dir, name, out = []) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory() && !['node_modules', 'worktrees'].includes(entry.name)) files(full, name, out); else if (entry.name === name) out.push(full); } return out; };
    const contexts = files(path.join(root, '.engelbart'), 'meta.json').flatMap((file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).context || []; } catch { return []; } }).flat(Infinity).filter((id) => typeof id === 'string');
    const md = (await js(wc, 'window.engelbartAPI.library()')).filter((row) => row.type === 'md' && !row.tags.includes('note')).map((row) => row.id);
    // 2026-10-14: the Welcome project's folder holds everything the run brought in.
    assert.ok(md.length > 0 && md.every((id) => contexts.includes(id)), 'what came in is in the Welcome project\'s folder');
    await press(wc, '[data-import-status-close]');
    await until(() => js(wc, '!document.querySelector("[data-import-status]")'), 'Open library closes it');
    }
    /* Import context from Settings, inside the project (2026-10-14): straight to the source picker, nothing ticked */
    await js(wc, 'window.dispatchEvent(new CustomEvent("engelbart:guided-setup"))'); // Settings ▸ Import context ▸ Start
    await until(() => js(wc, '!!document.querySelector("[data-import-flow=modal]")'), 'Import context over the project');
    const modal = await js(wc, '(()=>{const el=document.querySelector("[data-import-flow=modal]");return {screen:el.dataset.screen,dialog:el.dataset.dialog,ticked:document.querySelectorAll("[data-import-flow=modal] [data-app][aria-checked=true]").length}})()');
    assert.deepEqual(modal, { screen: 'picker', dialog: '', ticked: 0 }, `the picker at once, nothing ticked: ${JSON.stringify(modal)}`);
    await shot(wc, '16-settings-import');
    console.log(`smoke-import-context (${MODE}): ok (${titles.length} projects found, ${ticked.length} sources ticked, ${MODE === 'auto' ? `${logos.length} imported tiles` : 'the librarian\'s chat put away'})`);
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; await shot(wc, 'failed'); console.error(await flow(wc)); } catch { /* none */ }
    app.exit(1);
  }
});
