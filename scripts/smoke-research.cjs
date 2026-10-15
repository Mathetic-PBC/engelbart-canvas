'use strict';

// npm run build && npx electron scripts/smoke-research.cjs
// Runs the real app, hidden, against disposable project/user data and the fake agents (src/main/bart/ask.cjs and
// route.cjs), and drives @discover by typing (2026-10-14): an empty @discover line asks "What would you like to
// research?" on a card of the workspace's themes, with no search, and a theme picked there is searched in a box; a broad topic gets one question back, a reply that answers it stays with Discover (by rule),
// and once the direction is settled a research box goes under Discover's reply and searches by itself; the conversation is
// named from that direction. A clear request gets its box at once. A reply asking about a guide goes to Chat, no new box.
// ENGELBART_RESEARCH_SHOTS=<dir> saves pictures of the window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-research-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_CONNECT_OFFER = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');

const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 300) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const ED = 'main [data-editor]';
const click = async (wc, { x, y }) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause(150);
};
const key = async (wc, keyCode, { ch = null, modifiers = [] } = {}) => {
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await pause(30);
};
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') await key(wc, 'Enter', { ch: '\r' }); else await key(wc, ch === ' ' ? 'Space' : ch, { ch }); } await pause(150); };
const rows = (wc) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} [data-line]`)})].map((d) => d.dataset.raw)`);
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+Math.min(r.width/2,40)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const settled = async (wc) => until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the answers', 600);
const SHOTS = process.env.ENGELBART_RESEARCH_SHOTS;
async function shot(wc, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const picture = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
// The reply field is shut until Reply opens it (2026-10-13).
// The last conversation's Reply: the one being talked to here.
// Into the last conversation's reply field: open already once its answer came in (2026-10-15), else through its Reply.
const reply = async (wc, text) => {
  const last = (sel) => `(()=>{const all=document.querySelectorAll(${JSON.stringify(sel)});all.forEach((b)=>b.removeAttribute('data-last'));const b=all[all.length-1];if(b)b.setAttribute('data-last','1');return b?b.dataset.act||'field':''})()`;
  if (await js(wc, last(`${ED} [data-act="reply"], ${ED} [data-follow-input]`)) === 'reply') await press(wc, `${ED} [data-act="reply"][data-last]`);
  await js(wc, last(`${ED} [data-follow-input]`));
  await press(wc, `${ED} [data-follow-input][data-last]`);
  await typeKeys(wc, `${text}\n`);
};

app.whenReady().then(async () => {
  try {
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false);
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Research smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ an empty @discover: a card of themes, no search; a pick is searched */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    // The first Enter takes the agent from the menu ("@Discover "), the second asks the line.
    await typeKeys(wc, 'Notes\n@discover\n');
    await typeKeys(wc, '\n');
    await until(async () => (await rows(wc)).some((l) => /^bart~> /.test(l)), 'asked');
    await settled(wc);
    let ls = await rows(wc);
    const q = ls.findIndex((l) => /^@discover\s*$/i.test(l));
    assert.ok(q > 0, JSON.stringify(ls));
    assert.match(ls[q - 1], /^bart# \[discover [^\]]+\] ?(?:New conversation)?$/, 'its title waits for the direction');
    assert.ok(!ls.some((l) => l.includes('--research')), 'no box: nothing to search yet');
    const shown = await js(wc, `document.querySelector('${ED}').innerText`);
    assert.ok(shown.includes('What would you like to research?'), 'the card asks it');
    assert.ok(!/Discover is looking|Searching/.test(shown), 'nothing says it is searching');
    const options = await js(wc, `[...document.querySelectorAll('${ED} [data-act="cardopt"]')].map((b)=>b.querySelector('.dv-label').innerText.trim())`);
    assert.equal(options.length, 3, JSON.stringify(options));
    assert.deepEqual(options, ['Fake theme one', 'Fake theme two', 'Fake theme three']);
    assert.equal(await js(wc, `document.querySelectorAll('${ED} [data-followup]').length`), 0, 'no @bart field under it: its own field is in the card');
    await shot(wc, '1-card');
    await press(wc, `${ED} [data-act="cardopt"][data-opt="1"]`);
    assert.equal(await js(wc, `document.querySelector('${ED} [data-act="cardopt"][data-opt="1"]').getAttribute('aria-checked')`), 'true', 'picked, waiting for Submit');
    assert.ok(!(await rows(wc)).some((l) => /^bart~> /.test(l)), 'nothing asked on a pick');
    await shot(wc, '1a-picked');
    await press(wc, `${ED} .dv-submit`);
    // A pick says where the interest is, not what they want to learn (2026-10-15): one short question first, no box.
    await until(async () => (await rows(wc)).includes('bart> FAKE DISCOVER: What are you hoping to understand about fake theme two?'), 'the pick\'s question');
    await settled(wc);
    assert.ok(!(await rows(wc)).some((l) => l.includes('--research')), 'no box before the question is answered');
    await shot(wc, '1b-asked');
    await reply(wc, 'when being brief starts hurting understanding');
    const picked = '@discover --research Fake theme two; when being brief starts hurting understanding';
    await until(async () => (await rows(wc)).includes(picked), 'the pick\'s box');
    await settled(wc);
    ls = await rows(wc);
    assert.ok(ls.slice(ls.indexOf(picked)).some((l) => /^bart> ## Start here/.test(l)), 'the guide is in the box');
    await until(async () => (await rows(wc)).some((l) => /^bart#\+? \[discover [^\]]+\] Fake theme two/i.test(l)), 'named from the pick');
    await shot(wc, '1c-picked');
    // Another theme picked on the answered card (2026-10-15, David): the restart is asked first; Cancel leaves it as it was.
    const asIs = (await rows(wc)).join('\n');
    await press(wc, `${ED} [data-act="cardrepick"][data-opt="2"]`);
    await until(() => js(wc, `!!document.querySelector('${ED} [data-repick-confirm]')`), 'the restart asked');
    assert.match(await js(wc, `document.querySelector('${ED} [data-repick-confirm]').innerText`), /Pick Fake theme three instead\? Everything after this will be asked again from that pick\.[\s\S]*Cancel[\s\S]*Restart from here/);
    await shot(wc, '1d-repick');
    await press(wc, `${ED} [data-act="cardrepickno"]`);
    await until(() => js(wc, `!document.querySelector('${ED} [data-repick-confirm]')`), 'cancelled');
    assert.equal((await rows(wc)).join('\n'), asIs, 'nothing changed');
    console.log('PASS an empty @discover asks "What would you like to research?" on a card of themes; a pick gets one question, and the answer is searched in its box');

    /* ------------------------------------------------ a new conversation under it */
    const below = (await rows(wc)).length - 1;
    await press(wc, `${ED} [data-line="${below}"]`);
    await typeKeys(wc, '\n@discover tutors\n');
    await until(async () => (await rows(wc)).includes('@discover tutors'), 'typed');
    await settled(wc);
    ls = await rows(wc);
    assert.equal(ls[ls.indexOf('@discover tutors') + 1], 'bart> FAKE DISCOVER: What are you hoping the research will help you figure out?', 'a broad topic: a question back');

    /* ------------------------------------------------ a broad topic: one question; the answer settles it, and the box searches */
    await reply(wc, 'how they notice struggle');
    await until(async () => (await rows(wc)).some((l) => /^@discover --research tutors/.test(l)), 'the research box');
    await settled(wc);
    ls = await rows(wc);
    const said = ls.indexOf('@bart how they notice struggle'), box = ls.findIndex((l) => /^@discover --research tutors/.test(l));
    assert.ok(said > 0 && box > said, JSON.stringify(ls));
    assert.equal(ls[box], '@discover --research tutors; how they notice struggle', 'the direction kept on the box\'s line');
    assert.match(ls[said + 1], /^bart> FAKE DISCOVER will look for work on/);
    assert.ok(!ls.some((l) => l.includes('<research>')), 'the tag is never in the document');
    assert.match(ls[box - 1], /^bart> \*Discover · /, 'the reply closes as Discover\'s');
    assert.ok(ls.slice(box + 1).some((l) => /^bart> ## Start here/.test(l)), 'the guide is in the box');
    const head = await js(wc, `(()=>{const h=[...document.querySelectorAll('${ED} [data-research]')].pop();return h?{text:h.innerText.replace(/\\s+/g,' ').trim(),editable:h.getAttribute('contenteditable')}:null})()`);
    assert.ok(head && /^Research · Standard/.test(head.text) && head.editable === 'false', JSON.stringify(head));
    const title = await until(async () => (await rows(wc)).find((l) => /^bart#\+? \[discover [^\]]+\] Tutors/i.test(l)), 'the title from the direction');
    assert.ok(!/New conversation/.test(title), title);
    assert.equal((await rows(wc)).filter((l) => /^bart#/.test(l)).length, 2, 'two conversations');
    await shot(wc, '2-searched');
    console.log(`PASS a broad topic gets one question; the answer settles it and the box searches by itself (title: ${title})`);

    /* ------------------------------------------------ a reply about the guide is Chat's: no new box */
    await reply(wc, 'which one is the most cited');
    await settled(wc);
    ls = await rows(wc);
    assert.equal(ls.filter((l) => l.includes('--research')).length, 2, 'no new box');
    assert.match(ls[ls.indexOf('@bart which one is the most cited') + 1], /^bart> FAKE ANSWER/);
    console.log('PASS a reply asking about the guide goes to Chat, with no new search');

    /* ------------------------------------------------ a clear request: the box at once */
    const end = (await rows(wc)).length - 1;
    await press(wc, `${ED} [data-line="${end}"]`);
    await typeKeys(wc, '\n@discover find papers on why coding agents retry\n');
    await until(async () => (await rows(wc)).includes('@discover --research find papers on why coding agents retry'), 'its box');
    // Its steps, opened, are told as its trace (2026-10-15): by part, each saying what came back.
    await press(wc, `${ED} [data-act="asklog"]`);
    const told = await until(() => js(wc, `(()=>{const g=[...document.querySelectorAll('${ED} [data-trace-group]')];return g.length>=3&&/Found 3/.test(g[2].innerText)&&g.map((d)=>d.innerText.trim())})()`), 'the trace, by part');
    await shot(wc, '3-trace');
    assert.match(told[0], /^Starting papers\n(?:Found “[^”]+” in your library|Looked up “[^”]+”)\nSearched for papers close to your problem\nPicked “A fake paper close to the problem”, the closest of 12$/);
    assert.match(told[1], /^Papers they cite\nListed the 14 papers “[^”]+” cites\nListed the 22 papers “A fake paper close to the problem” cites$/);
    assert.match(told[2], /^Newer papers that cite them\nFound 3 newer papers that cite “[^”]+”$/);
    console.log('PASS a search\'s steps are told by part of the trace, each saying what came back');
    await settled(wc);
    ls = await rows(wc);
    const clear = ls.indexOf('@discover find papers on why coding agents retry');
    assert.match(ls[clear + 1], /^bart> FAKE DISCOVER will look for work on/);
    assert.ok(ls.slice(ls.indexOf('@discover --research find papers on why coding agents retry')).some((l) => /^bart> ## Start here/.test(l)));
    await shot(wc, '3-clear');
    console.log('PASS a clear request is settled at once and searched in its box');

    /* ------------------------------------------------ Refine: the new direction waits in its box until Restart research */
    const refines = await js(wc, `document.querySelectorAll('${ED} [data-act="refine"]').length`);
    assert.equal(refines, 3, 'Refine on each reply that said what it will look for: a Discover conversation collapses nothing, Tutors\' with Chat\'s turn under it too (2026-10-15)');
    await js(wc, `(()=>{const all=document.querySelectorAll('${ED} [data-act="refine"]');all[all.length-1].setAttribute('data-last','1')})()`);
    await press(wc, `${ED} [data-act="refine"][data-last]`);
    const field = await until(() => js(wc, `(()=>{const f=[...document.querySelectorAll('${ED} [data-follow-input]')].pop();return f&&f.getAttribute('placeholder')})()`), 'the Refine field');
    assert.equal(field, 'Correct or develop the direction…');
    await shot(wc, '4-refine-field');
    await press(wc, `${ED} [data-follow-input]`);
    await typeKeys(wc, 'only studies of open source agents\n');
    const waiting = '@discover --research only studies of open source agents';
    await until(async () => (await rows(wc)).includes(waiting), 'the refined direction');
    await settled(wc);
    ls = await rows(wc);
    const refined = ls.indexOf('@discover --refine only studies of open source agents');
    assert.ok(refined > 0 && ls.indexOf(waiting) > refined, JSON.stringify(ls));
    assert.equal(ls[refined + 1], 'bart> FAKE DISCOVER will now look for work on “only studies of open source agents”.');
    assert.ok(!ls.slice(ls.indexOf(waiting) + 1).some((l) => /^bart.?> ## Start here/.test(l)), 'nothing searched yet');
    const before = ls.indexOf('@discover --research find papers on why coding agents retry');
    assert.ok(ls.slice(before + 1, refined).some((l) => /^bart> ## Start here/.test(l)), 'the earlier guide stays, open: nothing collapses (2026-10-15)');
    const start = await js(wc, `(()=>{const b=document.querySelector('${ED} [data-act="startresearch"]');return b&&b.innerText.trim()})()`);
    assert.equal(start, 'Restart research');
    await shot(wc, '4-refined');
    await press(wc, `${ED} [data-act="startresearch"]`);
    await until(async () => (await rows(wc)).slice((await rows(wc)).indexOf(waiting) + 1).some((l) => /^bart> ## /.test(l)), 'the restarted search', 600);
    assert.equal(await js(wc, `document.querySelectorAll('${ED} [data-act="startresearch"]').length`), 0, 'started: no button');
    await shot(wc, '4-restarted');
    console.log('PASS Refine settles a new direction that waits in its box; Restart research searches it, the earlier guide still open');
    app.exit(0);
  } catch (error) {
    console.error(error);
    try { const wc = BrowserWindow.getAllWindows()[0].webContents; console.error('The document then:', JSON.stringify(await rows(wc))); } catch { /* none */ }
    app.exit(1);
  }
});
