'use strict';

// npm run build && npx electron scripts/smoke-post-its.cjs
// Runs the real app, hidden, against disposable project/user data and a local interactive page, and drives the
// post-its with real (synthetic) input: the 2026-09-22 round — flat face, fit instead of scroll, Enter keeps the caret,
// hover previews leave cards alone, crumpling into the trash, the trash panel and Restore, +Note, Copy.
// --startup-only checks the restricted renderer, editing, show/hide, and reopening without the drag/clipboard checks.
const { app, BrowserWindow, clipboard } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = process.env.ENGELBART_POST_IT_SMOKE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-postit-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_TOOLS = 'off'; // no tool check or setup dialog over the cards (src/main/tools)
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 200) {
  for (let i = 0; i < tries; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
// A hidden window's views are throttled: a card would never hear that its view was resized. Real windows are visible.
const cards = (win) => win.contentView.children.filter((view) => view.webContents?.getURL() === 'engelbart://app/post-it.html').map((view) => { view.webContents.setBackgroundThrottling(false); return view; });
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const closeTerminals = (win) => js(win.webContents, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
const click = async (wc, x, y) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause();
};
const key = (wc, keyCode, ch) => { wc.sendInputEvent({ type: 'keyDown', keyCode }); if (ch) wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode }); };
const typeKeys = async (wc, text) => { for (const ch of text) { if (ch === '\n') key(wc, 'Enter', '\r'); else key(wc, ch === ' ' ? 'Space' : ch, ch); await pause(8); } await pause(120); };
const center = (wc, selector) => js(wc, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
// A pointer drag inside a card: `path` is a list of window-content points the pointer passes through (DIPs).
async function dragThrough(view, start, points, { release = true, stepPause = 25 } = {}) {
  const win = BrowserWindow.getAllWindows()[0];
  view.webContents.focus();
  await pause();
  const vp = win.getContentBounds(), b0 = view.getBounds();
  view.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start, globalX: vp.x + b0.x + start.x, globalY: vp.y + b0.y + start.y });
  await pause();
  let last = null;
  for (const p of points) {
    const b = view.getBounds();
    view.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: Math.round(p.x - b.x), y: Math.round(p.y - b.y), globalX: Math.round(vp.x + p.x), globalY: Math.round(vp.y + p.y) });
    last = p;
    await pause(stepPause);
  }
  if (!release) return;
  const b = view.getBounds();
  view.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(last.x - b.x), y: Math.round(last.y - b.y), globalX: Math.round(vp.x + last.x), globalY: Math.round(vp.y + last.y) });
  await pause(150);
}
const line = (from, to, steps = 10) => Array.from({ length: steps }, (_, i) => ({ x: from.x + (to.x - from.x) * (i + 1) / steps, y: from.y + (to.y - from.y) * (i + 1) / steps }));
async function drag(view, dx, dy, start = { x: 150, y: 150 }) {
  const b = view.getBounds();
  const from = { x: b.x + start.x, y: b.y + start.y };
  await dragThrough(view, start, line(from, { x: from.x + dx, y: from.y + dy }, 8));
}
// ENGELBART_POST_IT_SHOTS=<dir>: pictures of the card and the window at the moments worth seeing.
const SHOTS = process.env.ENGELBART_POST_IT_SHOTS;
async function shot(contents, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  contents.setBackgroundThrottling(false);
  const picture = await contents.capturePage(undefined, { stayHidden: true, stayAwake: true });
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), picture.toPNG());
}
const readyCard = async (win, id) => until(async () => {
  for (const v of cards(win)) if (await js(v.webContents, 'document.querySelector("[data-editor]") ? window.postItAPI.ready().then(c=>c.id) : null').catch(() => null) === id) return v;
  return null;
}, `card ${id}`);

app.whenReady().then(async () => {
  const server = http.createServer((_req, res) => res.end('<!doctype html><html><body style="height:3000px"><button onclick="this.textContent=Number(this.textContent)+1">0</button><p>Live browser under post-its</p></body></html>'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke tests must not show a desktop window');
    await until(() => js(win.webContents, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    const created = await js(win.webContents, "window.engelbartAPI.createProjectWithWelcome({name:'Post-it smoke'})");
    const pid = created.project.id;
    win.webContents.reload();
    await until(() => js(win.webContents, '!!document.querySelector("[data-add-post-it]") && !!document.querySelector("main [data-editor]")').catch(() => false), 'post-it icon and document');
    await pause(300);
    const db = await require('../src/main/store/db.cjs').openNotesDb(created.project.dir);

    /* ------------------------------------------------ face, font, markdown, Enter */
    const button = await center(win.webContents, '[data-add-post-it]');
    await click(win.webContents, button.x, button.y);
    let card = await until(() => cards(win)[0], 'native card creation');
    await until(() => js(card.webContents, '!!document.querySelector("[data-editor]") && document.activeElement === document.querySelector("[data-editor]")'), 'card editor focused');
    assert.equal(card.getVisible(), true, 'the restricted post-it renderer starts and becomes visible');
    assert.deepEqual([card.getBounds().width, card.getBounds().height], [260, 260], 'a new card is square');
    assert.equal(await js(card.webContents, 'getComputedStyle(document.querySelector(".postit-face")).backgroundColor'), 'rgb(255, 242, 160)', 'flat yellow face');
    assert.equal(await js(card.webContents, 'getComputedStyle(document.querySelector(".postit-face")).boxShadow'), 'none');
    assert.equal(await js(card.webContents, '!!document.querySelector(".postit-face image, .post-paper")'), false, 'no sticky-note artwork on the card');
    assert.equal(await js(card.webContents, 'typeof window.engelbartAPI'), 'undefined', 'card has no general app bridge');
    assert.equal(await js(card.webContents, 'getComputedStyle(document.querySelector("[data-editor]")).font'), await js(win.webContents, 'getComputedStyle(document.querySelector("main [data-editor]")).font'), 'same font as notes');
    await typeKeys(card.webContents, '**shared markdown**\n- first\nsecond');
    assert.equal(await js(card.webContents, 'document.activeElement === document.querySelector("[data-editor]")'), true, 'Enter keeps the caret in the card');
    await until(async () => (await db.postIts.list())[0]?.text === '**shared markdown**\n- first\n- second', 'list continues after Enter');
    await click(card.webContents, 200, 6); // the head strip: leaves the line, so the markdown renders
    await until(() => js(card.webContents, '!!document.querySelector("[data-editor] strong")'), 'same inline markdown compiler');
    console.log('PASS square flat face, notes font, inline markdown, Enter continues a list');
    const cardId = (await db.postIts.list())[0].id;

    if (!process.argv.includes('--startup-only')) {
    /* ------------------------------------------------ raise() leaves a correct stack alone */
    const url = `http://127.0.0.1:${server.address().port}`;
    await js(win.webContents, `window.engelbartAPI.browserOpen('smoke-browser',${JSON.stringify(url)})`);
    await js(win.webContents, `window.engelbartAPI.browserShow('smoke-browser',{x:900,y:100,width:500,height:700})`);
    const browser = await until(() => win.contentView.children.find((v) => v.webContents?.getURL().startsWith(url)), 'live browser');
    assert.equal(win.contentView.children.at(-1), card, 'a new browser view stays below the card');
    const realAdd = win.contentView.addChildView.bind(win.contentView);
    let readds = 0;
    win.contentView.addChildView = (view, ...rest) => { if (view === card) readds += 1; return realAdd(view, ...rest); };
    for (let i = 0; i < 5; i++) await js(win.webContents, `window.engelbartAPI.browserShow('smoke-browser',{x:${900 + i},y:100,width:500,height:700})`);
    win.contentView.addChildView = realAdd;
    assert.equal(readds, 0, 'placing the page again does not re-add (and unfocus) the card');
    browser.webContents.setBackgroundThrottling(false);
    await until(() => js(browser.webContents, 'document.readyState === "complete" && !!document.querySelector("button")'), 'browser ready');
    // The workspace's own Browser pane may have put its page in front meanwhile (one page shows at a time).
    await js(win.webContents, `window.engelbartAPI.browserShow('smoke-browser',{x:900,y:100,width:500,height:700})`);
    await until(() => browser.getVisible(), 'smoke page in front');
    browser.webContents.debugger.attach('1.3');
    await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 20, y: 18 });
    await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 20, y: 18 });
    await until(() => js(browser.webContents, 'document.querySelector("button").textContent === "1"'), 'the page beside the card stays live', 40);
    await js(win.webContents, 'window.engelbartAPI.browserHide()');
    console.log('PASS live page beside the card; browser placement never re-stacks a correctly stacked card');

    /* ------------------------------------------------ no scroll: grow, then smaller type */
    const fits = () => js(card.webContents, '(()=>{const b=document.querySelector(".postit-body"),f=document.querySelector(".postit-fit");return f.getBoundingClientRect().height<=b.clientHeight+1})()');
    const zoomOf = () => js(card.webContents, 'Number(document.querySelector(".postit-fit").style.zoom||1)');
    await click(card.webContents, 200, 6);
    await js(card.webContents, 'window.__editor=document.querySelector("[data-editor]");1');
    const editorEnd = await js(card.webContents, '(()=>{const r=document.querySelector("[data-editor]").getBoundingClientRect();return{x:Math.round(r.left+4),y:Math.round(r.bottom-6)}})()');
    await click(card.webContents, editorEnd.x, editorEnd.y);
    await typeKeys(card.webContents, '\nthree\nfour\nfive\nsix\nseven');
    await until(() => card.getBounds().height > 260, 'card grows with its text');
    await until(fits, 'grown card fits its text');
    assert.equal(await zoomOf(), 1, 'growing keeps full-size type');
    assert.equal(await js(card.webContents, 'getComputedStyle(document.querySelector(".postit-body")).overflowY'), 'hidden', 'the card never scrolls');
    const grip = await center(card.webContents, '[data-resize-post-it]');
    await drag(card, -40, -(card.getBounds().height - 200), grip);
    await until(async () => (await zoomOf()) < 1, 'shrinking by hand makes the type smaller');
    await until(fits, 'shrunk card still shows all its text');
    await drag(card, 0, 400, await center(card.webContents, '[data-resize-post-it]'));
    await until(async () => (await zoomOf()) === 1, 'enlarging brings the type back');
    console.log('PASS no scroll: the card grows with its text, and a card made smaller gets smaller type');

    /* ------------------------------------------------ hover previews leave cards alone; menus over a card move it aside */
    await js(win.webContents, '(()=>{const el=document.createElement("div");el.dataset.overlay="1";el.dataset.hover="1";el.id="smoke-hover";el.style="position:fixed;inset:0";document.body.append(el)})()');
    await pause(250);
    assert.equal(card.getVisible(), true, 'a hover preview, even one over the card, leaves it showing');
    await js(win.webContents, 'document.getElementById("smoke-hover").remove()');
    await js(win.webContents, '(()=>{const el=document.createElement("div");el.dataset.overlay="1";el.id="smoke-menu";el.style="position:fixed;left:0;top:0;width:20px;height:20px";document.body.append(el)})()');
    await pause(250);
    assert.equal(card.getVisible(), true, 'a menu elsewhere leaves the card showing');
    const cb = card.getBounds();
    await js(win.webContents, `document.getElementById("smoke-menu").style="position:fixed;left:${cb.x + 10}px;top:${cb.y + 10}px;width:40px;height:40px"`);
    await until(() => !card.getVisible(), 'a menu over the card moves it aside');
    await js(win.webContents, 'document.getElementById("smoke-menu").remove()');
    await until(() => card.getVisible(), 'the card comes back when the menu closes');
    console.log('PASS hover previews never hide cards; only a menu or dialog over a card does');

    /* ------------------------------------------------ crumple into the trash, the panel, Restore */
    const can = await js(win.webContents, '(()=>{const r=document.querySelector("[data-trash]").getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,right:r.right}})()');
    const b1 = card.getBounds(), start = { x: 130, y: 6 };
    const from = { x: b1.x + start.x, y: b1.y + start.y };
    await dragThrough(card, start, line(from, { x: can.x, y: can.y }, 16), { release: false });
    await pause(120);
    const crumpled = card.getBounds();
    assert.ok(crumpled.width < 120, `crumpled over the can: ${JSON.stringify(crumpled)}`);
    assert.ok(crumpled.x >= can.right, 'the crumpled card sits clear of the can');
    assert.equal(await js(win.webContents, 'document.querySelector("[data-trash]").dataset.trashOver'), '1', 'the can shows it will take the card');
    await shot(card.webContents, 'crumpled-card');
    await shot(win.webContents, 'crumpled-window');
    assert.equal(await js(card.webContents, 'document.querySelector(".post-card").dataset.crumpled'), '1');
    const bNow = card.getBounds();
    const vp = win.getContentBounds();
    card.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(can.x - bNow.x), y: Math.round(can.y - bNow.y), globalX: Math.round(vp.x + can.x), globalY: Math.round(vp.y + can.y) });
    await until(() => cards(win).length === 0, 'the thrown card goes');
    await until(() => js(win.webContents, 'document.querySelector("[data-trash]").dataset.trash === "full"'), 'the can shows it holds something');
    assert.equal((await db.postIts.trashed())[0].id, cardId, 'thrown away = in the trash, not deleted');
    await js(win.webContents, 'document.querySelector("[data-trash]").click()');
    await until(() => js(win.webContents, `!!document.querySelector('[data-restore-post-it="${cardId}"]')`), 'the trash panel lists it');
    assert.match(await js(win.webContents, 'document.querySelector("[data-trash-panel]").textContent'), /deleted in 7 days/);
    await pause(200);
    await shot(win.webContents, 'trash-panel');
    await js(win.webContents, `document.querySelector('[data-restore-post-it="${cardId}"]').click()`);
    card = await readyCard(win, cardId);
    await until(() => js(win.webContents, '!document.querySelector("[data-restore-post-it]")'), 'the panel empties');
    await js(win.webContents, 'document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape"}))');
    assert.equal((await db.postIts.list())[0].text.split('\n').length > 3, true, 'restored with its text');
    console.log('PASS crumples near the can, the can lights up, thrown = trashed, panel lists it, Restore brings it back');

    /* ------------------------------------------------ +Note */
    const noteButton = await center(card.webContents, '[data-note-post-it]');
    await click(card.webContents, noteButton.x, noteButton.y);
    const tabName = await until(() => js(win.webContents, '[...document.querySelectorAll("[data-doc-tab]")].map(t=>t.textContent).find(t=>/shared markdown/.test(t))'), 'the note opens as a tab');
    assert.equal(tabName.replace('×', '').trim(), 'shared markdown');
    const notePath = path.join(created.project.dir, 'shared markdown.md');
    assert.equal(fs.readFileSync(notePath, 'utf8'), (await db.postIts.list())[0].text, 'the note holds all of the card');
    const noteRow = (await db.list()).find((row) => row.name === 'shared markdown');
    assert.equal(noteRow.topic_id, null, 'the note is in no workspace');
    assert.equal(cards(win).length, 1, 'the card stays');
    await js(win.webContents, '[...document.querySelectorAll("[data-doc-tab]")].find(t=>t.dataset.docTab==="ws").click()');
    await pause(200);
    console.log('PASS +Note: a note of its own, in no workspace, opened as a tab; the card stays');

    /* ------------------------------------------------ Copy (the clipboard is put back as it was) */
    const lastText = (await db.postIts.list())[0].text;
    const before = await clipboard.readText(); // a promise in this Electron
    try {
      const copyButton = await center(card.webContents, '[data-copy-post-it]');
      const face = await js(card.webContents, '(()=>{const r=document.querySelector(".postit-face").getBoundingClientRect();return{x:r.left,bottom:r.bottom}})()');
      assert.ok(copyButton.x < face.x + 40 && copyButton.y > face.bottom - 30, 'Copy sits at the lower left');
      await click(card.webContents, copyButton.x, copyButton.y);
      await until(async () => (await clipboard.readText()) === lastText, 'the card is on the clipboard', 40);
      await shot(card.webContents, 'card-copied');
    } finally {
      await clipboard.writeText(typeof before === 'string' ? before : '');
    }
    assert.equal(cards(win).length, 1, 'copying leaves the card');
    console.log('PASS Copy: the card’s markdown on the clipboard, from the lower left');
    }

    /* ------------------------------------------------ native visibility: out of sight and back, nothing written */
    const lastText = (await db.postIts.list())[0].text;
    const rowsNow = async () => JSON.stringify([await db.postIts.list(), await db.postIts.trashed()]);
    const hide = (hidden) => js(win.webContents, `window.engelbartAPI.postItsHide(${hidden})`);
    const saved = await rowsNow(), count = cards(win).length;
    await hide(true);
    await until(() => cards(win).every((v) => !v.getVisible()), 'hide takes every card out of sight');
    await pause(300);
    assert.equal(await rowsNow(), saved, 'hiding writes, creates and deletes nothing');
    assert.equal(cards(win).length, count, 'hidden cards keep their views');
    await shot(win.webContents, 'post-its-hidden');
    await js(win.webContents, 'window.engelbartAPI.postItsActivate(null)');
    await js(win.webContents, `window.engelbartAPI.postItsActivate(${JSON.stringify(pid)})`);
    card = await readyCard(win, cardId);
    await pause(200);
    assert.equal(card.getVisible(), false, 'still hidden after the project is reopened');
    const reopened = await rowsNow(); // closing a project flushes each card's text, which stamps last_edited
    await hide(false);
    await until(() => cards(win).every((v) => v.getVisible()), 'show brings every card back');
    await pause(300);
    assert.equal(await rowsNow(), reopened, 'showing writes, creates and deletes nothing');
    await hide(true);
    await until(() => !card.getVisible(), 'hidden again');
    const add = await center(win.webContents, '[data-add-post-it]');
    await click(win.webContents, add.x, add.y);
    await until(() => cards(win).length === count + 1 && cards(win).every((v) => v.getVisible()), 'making a post-it while hidden shows them all');
    console.log('PASS show/hide: every card out of sight and back, no row touched; a new post-it shows them again');

    /* ------------------------------------------------ persistence across project switches and the week-old purge */
    await js(win.webContents, 'window.engelbartAPI.postItsActivate(null)');
    assert.equal(cards(win).length, 0);
    await js(win.webContents, `window.engelbartAPI.postItsActivate(${JSON.stringify(pid)})`);
    card = await readyCard(win, cardId);
    assert.equal(card.getVisible(), true, 'reopening the project restores a visible sticky note');
    assert.equal(await js(card.webContents, 'window.postItAPI.ready().then(c=>c.text)'), lastText, 'reopened note keeps its saved text');
    console.log(`Renderer working sets (KB): ${app.getAppMetrics().filter((m) => m.type === 'Tab').map((m) => m.memory.workingSetSize).join(', ')}`);
    await closeTerminals(win);
    await js(win.webContents, 'window.engelbartAPI.browserCloseAll()');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log(`PASS all: ${root}`);
    app.quit();
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
});
