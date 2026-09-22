'use strict';

// npm run build && npx electron scripts/smoke-post-its.cjs
// Runs the real app against disposable project/user data and a local interactive page.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = process.env.ENGELBART_POST_IT_SMOKE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-postit-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
process.env.ENGELBART_HOME_DIR = root;
process.env.ENGELBART_SUMMARIES = 'off';
process.env.ENGELBART_BART_FAKE = '1';
process.env.ENGELBART_HEADLESS = '1';
require('../src/main/index.cjs');
const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { const result = await fn(); if (result) return result; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
const cards = (win) => win.contentView.children.filter((view) => view.webContents?.getURL() === 'engelbart://app/post-it.html');
const js = (wc, expression) => wc.executeJavaScript(expression, true);
const closeTerminals = (win) => js(win.webContents, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
const click = async (wc, x, y) => {
  wc.focus();
  await pause();
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x, y });
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x, y });
  await pause();
};
async function drag(view, dx, dy, start = { x: 150, y: 180 }) {
  view.webContents.focus();
  await pause();
  const original = view.getBounds();
  const viewport = BrowserWindow.getAllWindows()[0].getContentBounds();
  const target = { x: original.x + start.x + dx, y: original.y + start.y + dy };
  view.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...start, globalX: viewport.x + original.x + start.x, globalY: viewport.y + original.y + start.y });
  await pause();
  for (let step = 1; step <= 8; step++) {
    const b = view.getBounds();
    const px = Math.round(original.x + start.x + dx * step / 8), py = Math.round(original.y + start.y + dy * step / 8);
    view.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', modifiers: ['leftbuttondown'], x: px - b.x, y: py - b.y, globalX: viewport.x + px, globalY: viewport.y + py });
    await pause(25);
  }
  const b = view.getBounds();
  view.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: Math.round(target.x - b.x), y: Math.round(target.y - b.y), globalX: Math.round(viewport.x + target.x), globalY: Math.round(viewport.y + target.y) });
  await pause(150);
}

app.whenReady().then(async () => {
  const server = http.createServer((_req, res) => res.end('<!doctype html><html><body style="height:3000px"><button onclick="this.textContent=Number(this.textContent)+1">0</button><p>Live browser under post-its</p></body></html>'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const win = await until(() => BrowserWindow.getAllWindows()[0], 'app window');
    win.setFocusable(false); // synthetic input only; do not capture the user's typing
    assert.equal(win.isVisible(), false, 'smoke tests must not show a desktop window');
    await until(() => js(win.webContents, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'app bootstrap');
    if (process.env.ENGELBART_POST_IT_SMOKE_RESTORE === '1') {
      const expected = JSON.parse(fs.readFileSync(path.join(root, 'post-it-expected.json'), 'utf8'));
      await until(() => cards(win).length === 8, 'all cards restored after quit');
      const db = await require('../src/main/store/db.cjs').openNotesDb(expected.projectDir);
      const rows = await db.postIts.list();
      assert.equal(rows.length, 8);
      assert.equal(rows.find((row) => row.id === expected.id).text, 'last keystroke before quit');
      assert.equal(rows.some((row) => row.id === expected.deletedId), false);
      console.log('PASS full process relaunch: final text persisted, eight cards restored, deleted card absent');
      await closeTerminals(win);
      server.closeAllConnections(); server.close();
      app.quit();
      return;
    }
    const created = await js(win.webContents, `window.engelbartAPI.createProjectWithWelcome({name:'Post-it smoke', directory:${JSON.stringify(root)}})`);
    win.webContents.reload();
    await until(() => js(win.webContents, '!!document.querySelector("[data-add-post-it]")').catch(() => false), 'post-it icon');
    await pause(300);
    const button = await js(win.webContents, '(()=>{const r=document.querySelector("[data-add-post-it]").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');
    await click(win.webContents, Math.round(button.x), Math.round(button.y));
    let card = await until(() => cards(win)[0], 'native card creation');
    await until(() => js(card.webContents, '!!document.querySelector("[data-editor]")'), 'card editor');
    assert.equal(await js(card.webContents, 'typeof window.engelbartAPI'), 'undefined', 'card has no general app bridge');
    const hostFont = await js(win.webContents, 'getComputedStyle(document.querySelector("[data-editor]")).font');
    const cardFont = await js(card.webContents, 'getComputedStyle(document.querySelector("[data-editor]")).font');
    assert.equal(cardFont, hostFont);
    await card.webContents.insertText('**shared markdown**');
    await pause();
    card.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    card.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await pause();
    await card.webContents.insertText('second line');
    await pause(150);
    await click(card.webContents, 280, 100);
    win.webContents.focus();
    await pause();
    assert.equal(await js(card.webContents, '!!document.querySelector("[data-editor] strong")'), true, 'same inline markdown compiler');
    const before = card.getBounds();
    await drag(card, 280, 80);
    const moved = card.getBounds();
    assert.ok(Math.abs(moved.x - before.x - 280) <= 1 && Math.abs(moved.y - before.y - 80) <= 1, `blank-area drag: ${JSON.stringify({ before, moved })}`);
    const boundsBeforeText = card.getBounds();
    await click(card.webContents, 32, 65);
    await drag(card, 70, 0, { x: 32, y: 65 });
    assert.deepEqual(card.getBounds(), boundsBeforeText, 'text drag selects without moving card');
    assert.ok(await js(card.webContents, 'getSelection().toString().length > 0'), 'text remains selectable');
    await drag(card, 80, 50, { x: card.getBounds().width - 10, y: card.getBounds().height - 10 });
    const sized = card.getBounds();
    assert.deepEqual([sized.width, sized.height], [380, 290], 'corner resize');
    console.log('PASS create, font, markdown, blank drag, text selection, resize');

    await js(win.webContents, 'document.querySelector("button[aria-label=Settings]").click()');
    await until(() => !card.getVisible(), 'card yields to real settings menu');
    await js(win.webContents, 'document.querySelector("button[aria-label=Settings]").click()');
    await until(() => card.getVisible(), 'card returns after settings close');
    await js(win.webContents, 'document.querySelector("input[aria-label=Name]").parentElement.parentElement.dispatchEvent(new MouseEvent("mouseover",{bubbles:true,relatedTarget:document.body}))');
    await until(() => !card.getVisible(), 'card yields to workspace switcher');
    await js(win.webContents, 'document.querySelector("input[aria-label=Name]").parentElement.parentElement.dispatchEvent(new MouseEvent("mouseout",{bubbles:true,relatedTarget:document.body}))');
    await until(() => card.getVisible(), 'card returns after workspace switcher');
    await js(win.webContents, '[...document.querySelectorAll("button")].find(b=>b.textContent === "Terminal").click()');
    await until(() => js(win.webContents, '!!document.querySelector("[data-agent-menu]")'), 'terminal menu button');
    await js(win.webContents, 'document.querySelector("[data-agent-menu]").click()');
    await until(() => !card.getVisible(), 'card yields to terminal menu');
    await js(win.webContents, 'document.querySelector("[data-agent-menu]").click()');
    await until(() => card.getVisible(), 'card returns after terminal menu');
    await js(win.webContents, '[...document.querySelectorAll("button")].find(b=>b.textContent === "Browser").click()');
    console.log('PASS settings, workspace, and terminal menus yield and restore cards');

    const url = `http://127.0.0.1:${server.address().port}`;
    await js(win.webContents, `window.engelbartAPI.browserOpen('smoke-browser',${JSON.stringify(url)})`);
    await js(win.webContents, `window.engelbartAPI.browserShow('smoke-browser',{x:750,y:100,width:600,height:700})`);
    const browser = await until(() => win.contentView.children.find((v) => v.webContents?.getURL().startsWith(url)), 'live browser');
    browser.webContents.setBackgroundThrottling(false);
    await until(() => js(browser.webContents, 'document.readyState === "complete" && !!document.querySelector("button")'), 'browser ready');
    assert.equal(win.contentView.children.at(-1), card, 'new browser stays below existing card');
    browser.webContents.debugger.attach('1.3');
    await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: 20, y: 18 });
    await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 20, y: 18 });
    assert.equal(await js(browser.webContents, 'document.querySelector("button").textContent'), '1');
    await browser.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 500, y: 300, deltaY: 300, deltaX: 0 });
    await until(() => js(browser.webContents, 'scrollY > 0'), 'page scroll');
    await js(win.webContents, `window.engelbartAPI.browserOpen('smoke-tab-two',${JSON.stringify(url + '/two')})`);
    await js(win.webContents, `window.engelbartAPI.browserShow('smoke-tab-two',{x:750,y:100,width:600,height:700})`);
    assert.equal(win.contentView.children.at(-1), card, 'tab changes keep card on top');
    await js(win.webContents, '(()=>{const el=document.createElement("div");el.dataset.overlay="1";el.id="smoke-modal";el.style="position:fixed;inset:0";document.body.append(el)})()');
    await until(() => !card.getVisible(), 'card yields to modal');
    await js(win.webContents, 'document.getElementById("smoke-modal").remove()');
    await until(() => card.getVisible(), 'card restored after modal');
    console.log('PASS live browser interaction, scrolling, tab stacking, modal suspension');

    const db = await require('../src/main/store/db.cjs').openNotesDb(created.project.dir);
    await until(async () => (await db.postIts.list())[0]?.width === 380, 'saved geometry');
    const saved = (await db.postIts.list())[0];
    win.setSize(900, 560);
    await pause(100);
    assert.ok(card.getBounds().x + card.getBounds().width <= win.getContentBounds().width);
    win.setSize(1440, 900);
    await pause(100);
    assert.deepEqual(card.getBounds(), sized, 'larger window restores preferred layout');
    win.webContents.setZoomFactor(1.25);
    await pause(200);
    assert.equal(card.getBounds().width, 475, 'native bounds follow host zoom');
    win.webContents.setZoomFactor(1);
    await pause(150);
    await js(win.webContents, 'window.engelbartAPI.postItsActivate(null)');
    assert.equal(cards(win).length, 0);
    await js(win.webContents, `window.engelbartAPI.postItsActivate(${JSON.stringify(created.project.id)})`);
    card = await until(() => cards(win)[0], 'project restore');
    await until(() => js(card.webContents, '!!document.querySelector("[data-editor]")'), 'restored editor');
    assert.equal((await db.postIts.list())[0].text, '**shared markdown**\nsecond line');
    assert.deepEqual(card.getBounds(), sized);
    const other = await js(win.webContents, `window.engelbartAPI.createProject({name:'Other',directory:${JSON.stringify(root)}})`);
    await js(win.webContents, `window.engelbartAPI.postItsActivate(${JSON.stringify(other.id)})`);
    assert.equal(cards(win).length, 0, 'other project has no cards');
    await js(win.webContents, `window.engelbartAPI.postItsActivate(${JSON.stringify(created.project.id)})`);
    card = await until(() => cards(win)[0], 'restore after project switch');
    await until(() => js(card.webContents, '!!document.querySelector("[data-editor]")'), 'restored editor');
    console.log('PASS window resize, zoom, saved content/layout, project isolation');

    // Multiple native editors remain usable, then release their renderers on deletion.
    for (let i = 0; i < 7; i++) await js(win.webContents, `window.engelbartAPI.postItsCreate(${JSON.stringify(created.project.id)})`);
    await until(() => cards(win).length === 8, 'eight cards');
    await until(async () => (await Promise.all(cards(win).map((v) => js(v.webContents, '!!document.querySelector("[data-editor]")')))).every(Boolean), 'eight editors');
    const b = card.getBounds(), vp = win.getContentBounds();
    await drag(card, 50 - b.x - 150, vp.height - 40 - b.y - 180);
    await until(() => cards(win).length === 7, 'trash drop removes native view');
    assert.equal((await db.postIts.list()).some((row) => row.id === saved.id), false, 'trash drop deletes stored card');
    console.log('PASS eight cards and drag-to-trash deletion');
    console.log(`Renderer working sets (KB): ${app.getAppMetrics().filter((m) => m.type === 'Tab').map((m) => m.memory.workingSetSize).join(', ')}`);
    await js(win.webContents, 'window.engelbartAPI.postItsActivate(null)');
    assert.equal(cards(win).length, 0, 'all card views cleaned up');
    console.log('PASS cleanup');
    await js(win.webContents, `window.engelbartAPI.postItsActivate(${JSON.stringify(created.project.id)})`);
    const finalId = await js(win.webContents, `window.engelbartAPI.postItsCreate(${JSON.stringify(created.project.id)})`);
    const finalCard = await until(async () => {
      for (const v of cards(win)) if (await js(v.webContents, 'document.querySelector("[data-editor]") ? window.postItAPI.ready().then(c=>c.id) : null') === finalId) return v;
      return null;
    }, 'last card before quit');
    await until(() => js(finalCard.webContents, 'document.activeElement === document.querySelector("[data-editor]")'), 'last card focus');
    fs.writeFileSync(path.join(root, 'post-it-expected.json'), JSON.stringify({ id: finalId, deletedId: saved.id, projectDir: created.project.dir }));
    await finalCard.webContents.insertText('last keystroke before quit');
    await closeTerminals(win);
    await js(win.webContents, 'window.engelbartAPI.browserCloseAll()');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    console.log(`PASS quit checkpoint: ${root}`);
    app.quit();
  } catch (error) {
    console.error(error);
    server.close();
    app.exit(1);
  }
});
