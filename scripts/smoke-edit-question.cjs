'use strict';

// npm run build && npx electron scripts/smoke-edit-question.cjs
// Runs the real app, hidden, against disposable project/user data and the fake @bart, and drives Edit under an answered
// question (src/renderer/workspace/DocEditor.jsx, 2026-10-03) with real (synthetic) input: a thread of three turns is
// asked by typing, then the second question is edited and asked again, undone, cancelled with Escape, with a click on
// another line and with a click on another turn's button, and left unchanged with Enter. ENGELBART_EDIT_SHOTS=<dir> saves
// pictures of the window at the moments worth seeing.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-edit-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS = 'off';
process.env.ENGELBART_WEB_PDFS = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_BUILD_FAKE = '1'; // no real agent, whatever is typed
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
// The document as the editor holds it: every line is a row with its source in data-raw.
const rows = (wc) => js(wc, `[...document.querySelectorAll(${JSON.stringify(`${ED} [data-line]`)})].map((d) => d.dataset.raw)`);
// The centre of what `selector` finds, scrolled into view first.
const spot = (wc, selector) => js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:Math.round(r.x+Math.min(r.width/2,40)),y:Math.round(r.y+r.height/2)}})()`);
const press = async (wc, selector) => { const at = await until(() => spot(wc, selector), selector); await click(wc, at); };
const settled = (wc) => until(async () => !(await rows(wc)).some((line) => /^bart~> /.test(line)), 'the runs answer', 400);
const SHOTS = process.env.ENGELBART_EDIT_SHOTS;
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
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Edit smoke', directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(ED)})`).catch(() => false), 'the workspace document');
    await pause(400);

    /* ------------------------------------------------ a thread of three turns, asked by typing */
    await press(wc, `${ED} [data-line="0"] .t`);
    await key(wc, 'A', { modifiers: ['meta'] });
    await key(wc, 'Backspace');
    await until(async () => (await rows(wc)).join('\n').trim() === '', 'an empty document');
    await typeKeys(wc, 'Notes\n@bart first question\n');
    await settled(wc);
    for (const words of ['second question', 'third question']) {
      await press(wc, '[data-follow-input]');
      await typeKeys(wc, `${words}\n`);
      await settled(wc);
    }
    const before = await rows(wc);
    const q2 = before.indexOf('@bart second question'), q1 = before.indexOf('@bart first question'), q3 = before.indexOf('@bart third question');
    assert.ok(q1 > 0 && q2 > q1 && q3 > q2, `three turns in one thread: ${JSON.stringify(before)}`);
    assert.equal(await js(wc, `document.querySelectorAll('${ED} [data-act="editturn"]').length`), 3, 'an Edit in each answered turn\'s foot');
    console.log('PASS a thread of three answered turns, each with Edit');

    /* ------------------------------------------------ Edit: the line opens, the answer dims */
    await press(wc, `[data-act="editturn"][data-turn="${q2}"]`);
    const open = await until(() => js(wc, `(()=>{const row=document.querySelector('${ED} [data-line="${q2}"]'),s=getSelection();return row&&row.dataset.editing==='1'?{editable:row.getAttribute('contenteditable')!=='false',focused:document.activeElement===document.querySelector('${ED}'),inRow:!!s.rangeCount&&row.contains(s.anchorNode),atEnd:s.rangeCount&&s.isCollapsed&&row.querySelector('.t').textContent.length===(()=>{const r=document.createRange();r.selectNodeContents(row.querySelector('.t'));r.setEnd(s.anchorNode,s.anchorOffset);return r.toString().length})(),chip:!!row.querySelector('[data-act="pick"]'),send:!!row.querySelector('[data-act="ask"]'),dim:document.querySelectorAll('${ED} [data-dim]').length,opacity:getComputedStyle(document.querySelector('${ED} [data-dim] > *')).opacity}:null})()`), 'edit mode');
    assert.deepEqual(open, { editable: true, focused: true, inRow: true, atEnd: true, chip: true, send: true, dim: open.dim, opacity: '0.45' });
    assert.ok(open.dim >= 2, 'the answer\'s lines and its foot are dimmed');
    await shot(wc, '1-editing');
    console.log('PASS Edit opens the question with the caret at its end, its chip and send back, its answer dimmed');

    /* ------------------------------------------------ Shift+Enter adds nothing; Enter asks the new words again */
    await key(wc, 'Enter', { ch: '\r', modifiers: ['shift'] });
    assert.deepEqual(await rows(wc), before, 'Shift+Enter adds no line');
    await typeKeys(wc, ' reworded');
    assert.equal((await rows(wc))[q2], '@bart second question reworded');
    await shot(wc, '2-typed');
    await key(wc, 'Enter', { ch: '\r' });
    const asked = await rows(wc);
    assert.equal(asked[q2], '@bart second question reworded');
    assert.match(asked[q2 + 1], /^bart~> /, 'a pending run in place of the old answer');
    assert.ok(!asked.includes('@bart third question'), 'the later turn is gone');
    assert.deepEqual(asked.slice(0, q2), before.slice(0, q2), 'the turn before is untouched');
    await shot(wc, '3-asked');
    await settled(wc);
    const answered = await rows(wc);
    assert.ok(answered.some((line) => line.includes('FAKE ANSWER to "second question reworded"')), 'the run was asked the new words');
    const conversation = answered.find((line) => /earlier turn|the same session/.test(line));
    console.log(`PASS Enter asks the new words in place of the answer; the later turn went (the run says: ${conversation ? conversation.replace(/^bart> - /, '') : 'nothing about its conversation'})`);

    /* ------------------------------------------------ one undo brings back the question, its answer and the later turn */
    await press(wc, `${ED} [data-line="${q1 - 1}"] .t`);
    await key(wc, 'Z', { modifiers: ['meta'] });
    await until(async () => JSON.stringify(await rows(wc)) === JSON.stringify(before), 'undo back to the three turns');
    console.log('PASS one undo puts back the old question, its answer and the later turn');

    /* ------------------------------------------------ Escape, a click on another line, a click on another turn's button */
    await press(wc, `[data-act="editturn"][data-turn="${q1}"]`);
    await typeKeys(wc, ' xyz');
    assert.equal((await rows(wc))[q1], '@bart first question xyz');
    await key(wc, 'Escape');
    await until(async () => JSON.stringify(await rows(wc)) === JSON.stringify(before), 'Escape puts it back');
    assert.equal(await js(wc, `!!document.querySelector('${ED} [data-editing]')`), false);
    console.log('PASS Escape puts the question back, the answer as it was');

    await press(wc, `[data-act="editturn"][data-turn="${q3}"]`);
    await typeKeys(wc, ' abc');
    await press(wc, `${ED} [data-line="${q1 - 1}"] .t`);
    await until(async () => JSON.stringify(await rows(wc)) === JSON.stringify(before), 'a click on another line puts it back');
    assert.equal(await js(wc, `!!document.querySelector('${ED} [data-editing]')`), false);
    console.log('PASS a click on another line puts the question back');

    await press(wc, `[data-act="editturn"][data-turn="${q1}"]`);
    await typeKeys(wc, ' zzz');
    await press(wc, `[data-act="fold"][data-turn="${q3}"]`);
    const folded = await until(async () => { const now = await rows(wc); return now.some((line) => line.startsWith('bart+>')) ? now : null; }, 'the third answer folds');
    assert.equal(folded[q1], '@bart first question', 'the click put the question back before it acted');
    assert.equal(folded.filter((line) => line.startsWith('bart+>')).length, before.slice(q3 + 1).filter((line) => line.startsWith('bart>')).length, 'and folded the third answer');
    await press(wc, `[data-act="fold"][data-turn="${q3}"]`);
    await until(async () => JSON.stringify(await rows(wc)) === JSON.stringify(before), 'expanded again');
    console.log('PASS a click on another turn\'s Collapse puts the question back, then collapses that turn');

    /* ------------------------------------------------ Enter with nothing changed asks nothing */
    await press(wc, `[data-act="editturn"][data-turn="${q2}"]`);
    await until(() => js(wc, `!!document.querySelector('${ED} [data-editing]')`), 'edit mode');
    await key(wc, 'Enter', { ch: '\r' });
    await until(() => js(wc, `!document.querySelector('${ED} [data-editing]')`), 'edit mode ends');
    await pause(300);
    assert.deepEqual(await rows(wc), before, 'no run, nothing changed');
    assert.equal(await js(wc, `document.querySelector('${ED} [data-line="${q2}"]').getAttribute('contenteditable')`), 'false', 'locked again');
    console.log('PASS Enter with nothing changed locks the line again without asking');

    /* ------------------------------------------------ no Edit on a run at work, a Build line or an @brainstorm card */
    // Each typed on a line of its own after an empty one, at the end, so it starts a thread of its own. (A Build line with
    // nothing after --build is left pending as it stands: Workspace.jsx places its "No Build" before the pending line is
    // there. So the request here names something; the fake Build agent takes it, or preflight refuses it.)
    const atEnd = async () => press(wc, `${ED} [data-line="${(await rows(wc)).length - 1}"] .t`);
    await atEnd();
    await typeKeys(wc, '\n@bart --build a page\n');
    await settled(wc);
    await atEnd();
    await typeKeys(wc, '\n@brainstorm\n\n'); // the first Enter picks Brainstorm in the @ menu, the second asks
    const pending = await rows(wc), pq = pending.findIndex((line) => /^@brainstorm/i.test(line));
    assert.match(pending[pq + 1], /^bart~> /);
    assert.equal(await js(wc, `!!document.querySelector('[data-act="editturn"][data-turn="${pq}"]')`), false, 'none while it runs');
    await settled(wc);
    const after = await rows(wc), bq = after.indexOf('@bart --build a page'), sq = after.findIndex((line) => /^@brainstorm/i.test(line));
    assert.ok(/^build> |No Build/.test(after[bq + 1]), `the Build line started a Build or was refused: ${after[bq + 1]}`);
    assert.equal(await js(wc, `!document.querySelector('[data-act="editturn"][data-turn="${bq}"]')`), true, 'a Build line has no Edit');
    console.log(`     (the Build line: ${after[bq + 1].slice(0, 90)})`);
    assert.equal(await js(wc, `!!document.querySelector('[data-card="${sq}"]') && !!document.querySelector('[data-act="regen"][data-turn="${sq}"]') && !document.querySelector('[data-act="editturn"][data-turn="${sq}"]')`), true, 'an @brainstorm card has Regenerate but no Edit');
    await shot(wc, '4-no-edit');
    console.log('PASS no Edit on a run at work, a Build line or an @brainstorm card');
    console.log('SMOKE OK');
  } catch (error) {
    console.error(error);
    const wc = BrowserWindow.getAllWindows()[0]?.webContents;
    if (wc) console.error('The document then:', JSON.stringify(await rows(wc).catch(() => null), null, 1));
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});
