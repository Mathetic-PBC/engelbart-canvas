'use strict';
// Real app + real browser input. All data and screenshots go to a disposable home.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { WORLD } = require('../src/main/browser/annotation-page.cjs');
const restoreAt = process.argv.indexOf('--restore');
const restoreRoot = restoreAt >= 0 ? process.argv[restoreAt + 1] : null;
const root = restoreRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-annotations-smoke-'));
if (!restoreRoot) require('node:child_process').execFileSync('git', ['init', '--quiet', root]);
const restoreNotes = restoreRoot ? fs.readdirSync(path.join(root, '.engelbart', 'annotations', 'interface')).filter(name => name.endsWith('.json')).flatMap(name => JSON.parse(fs.readFileSync(path.join(root, '.engelbart', 'annotations', 'interface', name), 'utf8')).notes) : [];
const restorePage = restoreNotes.find(note => new URL(note.url).hostname === '127.0.0.1');
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1' });
require('../src/main/index.cjs');
const pause = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const js = (wc, code) => wc.executeJavaScript(code, true).catch((error) => { console.error('Executing:', code.slice(0, 500)); throw error; });
async function until(fn, label) {
  for (let i = 0; i < 200; i++) { const value = await fn(); if (value) return value; await pause(); }
  throw new Error(`Timed out: ${label}`);
}
async function click(wc, selector) {
  const p = await js(wc, `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing '+${JSON.stringify(selector)});const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  wc.focus();
  if (wc.debugger.isAttached()) {
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p });
  } else {
    wc.sendInputEvent({ type: 'mouseMove', ...p });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
  }
  await pause(100);
}
async function button(wc, text) {
  await js(wc, `(()=>{const b=[...document.querySelectorAll('.interface-annotations button')].find(e=>e.textContent===${JSON.stringify(text)});if(!b)throw Error('Missing button '+${JSON.stringify(text)});b.click()})()`);
}
async function fill(wc, value, selector = '.ia-editor textarea') {
  await js(wc, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
}
async function browse(wc) {
  await click(wc, '[aria-label="More"]');
  await click(wc, '[data-annotations-browse]');
  // The current local UI restores the last-open annotation. Explicitly return
  // to its collection when the test needs to browse the list.
  await until(() => js(wc, '!!document.querySelector(\'.ia-list[aria-busy="false"],.ia-note .ia-back,.ia-chat [aria-label="All annotations"]\')'), 'annotation collection or restored conversation');
  if (await js(wc, '!!document.querySelector(\'.ia-note .ia-back,.ia-chat [aria-label="All annotations"]\')')) await allNotes(wc);
  await until(() => js(wc, '!!document.querySelector(\'.ia-list[aria-busy="false"]\')'), 'notes browser');
}
async function allNotes(wc) {
  await click(wc, '[aria-label="All annotations"]');
  await until(() => js(wc, '!!document.querySelector(\'.ia-list[aria-busy="false"]\')'), 'return to notes list');
}
async function assertPopover(wc, kind) {
  const geometry = await js(wc, `(()=>{const p=document.querySelector('.ia-${kind}'),s=document.querySelector('[data-browser-slot]');return{popup:p.getBoundingClientRect().toJSON(),slot:s.getBoundingClientRect().toJSON(),fixed:getComputedStyle(p).position,portal:p.parentElement===document.body}})()`);
  const { popup, slot } = geometry;
  assert.equal(geometry.fixed, 'fixed'); assert.equal(geometry.portal, true);
  assert.ok(popup.width <= 300 && popup.width > 100);
  assert.ok(popup.left >= slot.left && popup.right <= slot.right && popup.top >= slot.top && popup.bottom <= slot.bottom, `${kind} stays inside the full-width page`);
  if (kind === 'browser') assert.ok(popup.height <= 420);
}
async function select(wc, page) {
  await click(wc, '[data-annotate-toggle]');
  await until(() => js(wc, 'document.querySelector("[data-annotate-toggle]")?.getAttribute("aria-pressed")==="true"'), 'selection toolbar state');
  assert.equal(await js(wc, 'document.querySelector("[data-annotate-toggle]").textContent.trim()'), '', 'active annotation remains icon-only');
  await until(() => js(page, '!!document.querySelector("[data-engelbart-annotations]")'), 'picker installed');
  await pause(300);
  assert.equal(await js(wc, '!!document.querySelector("aside.interface-annotations")'), false, 'selecting never opens the notes sidebar');
}
async function overlay(page) {
  // DevTools DOM access lets the test inspect our closed shadow overlay without
  // adding a production escape hatch or exposing it to the website's JS.
  const { root: doc } = await page.debugger.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
  const find = (node) => node.attributes?.includes('data-engelbart-annotations') ? node : [...(node.children || []), ...(node.shadowRoots || []), ...(node.contentDocument ? [node.contentDocument] : [])].map(find).find(Boolean);
  const host = find(doc), children = host?.shadowRoots?.[0]?.children || [];
  const attributes = (node) => Object.fromEntries((node?.attributes || []).reduce((pairs, value, i, all) => i % 2 ? pairs : [...pairs, [value, all[i + 1]]], []));
  return { covers: children[0]?.children?.map(attributes), outline: attributes(children[1]).style || '', overlayCount: children.length, markers: (children[2]?.children || []).map(node => ({ nodeId: node.nodeId, ...attributes(node) })) };
}
async function hover(page, selector) {
  const point = await js(page, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await pause(150);
}
async function escape(wc) {
  wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await pause(300);
}
let origin;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Security-Policy', "script-src 'self'; style-src 'self'");
  if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(`window.clicks=0;document.querySelector('#publish').onclick=()=>{window.clicks++;document.querySelector('#count').textContent=window.clicks};const host=document.querySelector('#shadow');host.attachShadow({mode:'open'}).innerHTML='<button data-testid="shadow-action">Shadow action</button>';`); return; }
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{margin:24px;font:15px/1.5 system-ui;color:#172033;background:#f7f8fa}main{max-width:650px}button{padding:12px;border:1px solid #cbd5e1;background:white;border-radius:7px}section{padding:20px;background:white;border:1px solid #e2e8f0;border-radius:12px;margin:18px 0}iframe{width:90%;height:80px;border:1px solid #ddd}input{padding:8px}h1{font-size:26px}.spacer{height:1500px}'); return; }
  if (req.url === '/frame') { res.end('<!doctype html><button id="inside">Embedded action</button><iframe id="nested" src="/inner" width="220" height="45"></iframe>'); return; }
  if (req.url === '/inner') { res.end('<!doctype html><button id="deep">Nested action</button>'); return; }
  res.end(`<!doctype html><link rel="stylesheet" href="/style.css"><main><h1>Prototype review</h1><p>Select an element and leave a note for the next iteration.</p><section><h2>Draft workspace</h2><button id="publish" data-testid="publish"><span>Publish draft</span></button><p>Published: <span id="count">0</span></p><input id="private" type="password" value="do-not-capture"><div id="shadow"></div></section><iframe id="same" src="/frame"></iframe><iframe id="cross" src="${origin?.replace('127.0.0.1', 'localhost')}/frame"></iframe><div class="spacer"></div></main><script src="/app.js"></script>`);
});
app.whenReady().then(async () => {
  let win;
  try {
    await new Promise((r) => server.listen(restorePage ? Number(new URL(restorePage.url).port) : 0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1500, 980); win.webContents.setBackgroundThrottling(false); win.showInactive();
    const wc = win.webContents;
    wc.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('App console:', ...args); });
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'bootstrap');
    if (restoreRoot) {
      await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'restored Stage');
      assert.equal(await js(wc, '!!document.querySelector("[data-saved-annotations]")'), false, 'blank Stage has no site count');
      const rows = await js(wc, 'window.engelbartAPI.library()');
      assert.ok(restoreNotes.every(note => rows.some(row => row.id === note.libraryId)), 'every annotation retains its library link');
      await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(restorePage.url)}}}))`);
      await until(() => js(wc, '!!document.querySelector("[data-annotate-toggle]") && !document.querySelector("[data-annotate-toggle]").disabled'), 'restored website toolbar');
      assert.equal(await js(wc, '!!document.querySelector("[data-saved-annotations]")'), false, 'saved notes do not add a toolbar shortcut');
      await browse(wc);
      await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1'), 'only current website notes after restart');
      await click(wc, '.ia-row');
      await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'marker restored after full app restart');
      fs.writeFileSync(path.join(root, 'restored-process.png'), (await wc.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, root, checks: ['full Electron process restart', 'current website saved notes', 'persisted library links', 'reopened website and restored marker'] }));
      server.closeAllConnections(); server.close(); app.exit(0); return;
    }
    const created = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Interface review',directory:${JSON.stringify(root)}})`);
    const pid = created.project.id;
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'workspace');
    await js(wc, 'window.engelbartAPI.onBrowserAnnotation(e=>{if(e.type==="picked")window.__lastAnnotation=e;if(e.type==="status")window.__annotationStatus=e;if(e.type==="located"||e.type==="marker")window.__lastPlacement=e});true');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(origin + '/editor')}}}))`);
    const browser = await until(() => win.contentView.children.find((v) => v.webContents?.getURL().startsWith(origin)), 'browser');
    const page = browser.webContents; page.setBackgroundThrottling(false);
    page.debugger.attach('1.3');
    page.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('Page console:', ...args); });
    await until(() => js(page, '!!document.querySelector("#publish")').catch(() => false), 'fixture');
    await until(() => js(wc, '!!document.querySelector("[data-annotate-toggle]")'), 'annotate control');
    const toolbarIcons = await js(wc, `['[data-annotate-toggle]','[data-record-toggle]'].map(selector=>{const b=document.querySelector(selector);return{text:b.textContent.trim(),icon:!!b.querySelector('svg[aria-hidden="true"]'),label:b.getAttribute('aria-label'),width:b.getBoundingClientRect().width}})`);
    assert.deepEqual(toolbarIcons.map(b => b.text), ['', '']);
    assert.deepEqual(toolbarIcons.map(b => b.icon), [true, true]);
    assert.deepEqual(toolbarIcons.map(b => b.label), ['Annotate page', 'Record page']);
    assert.deepEqual(toolbarIcons.map(b => b.width), [26, 26]);
    assert.equal(await js(wc, '!!document.querySelector("[data-saved-annotations]")'), false);
    fs.writeFileSync(path.join(root, 'toolbar-icons.png'), (await wc.capturePage()).toPNG());
    const hoverToolbar = async selector => {
      const point = await js(wc, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      wc.sendInputEvent({ type: 'mouseMove', ...point });
    };
    for (const [selector, name] of [['[data-annotate-toggle]', 'Annotate'], ['[data-record-toggle]', 'Record']]) {
      await hoverToolbar(selector);
      await until(() => js(wc, `document.querySelector('[role="tooltip"][data-overlay]')?.textContent===${JSON.stringify(name)}`), `${name} hover label`);
      assert.equal(await js(wc, `(()=>{const b=document.querySelector(${JSON.stringify(selector)});return document.getElementById(b.getAttribute('aria-describedby'))?.textContent})()`), name);
      fs.writeFileSync(path.join(root, `${name.toLowerCase()}-tooltip.png`), (await wc.capturePage()).toPNG());
    }
    await hoverToolbar('[aria-label="More"]');
    await until(() => js(wc, '!document.querySelector("[role=tooltip][data-overlay]")'), 'hover labels clear');
    console.log('PASS Web icons, visible hover labels and toolbar cleanup');

    // Reproduce the lost-world cleanup error through the real IPC handler. Only
    // this fixture's isolated world is touched; no saved notes are involved.
    const tabId = await js(wc, 'document.querySelector("[data-stage-tab]").dataset.stageTab');
    const annotate = message => js(wc, `window.engelbartAPI.browserAnnotate(${JSON.stringify(tabId)},${JSON.stringify(message)})`);
    const inPicker = code => page.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
    await annotate({ type: 'clear' });
    assert.equal(await inPicker('typeof globalThis.__engelbartAnnotations'), 'undefined', 'cleanup on an untouched page installs nothing');
    await annotate({ type: 'mode', on: true });
    assert.equal(await js(page, '!!document.querySelector("[data-engelbart-annotations]")'), true);
    await inPicker('globalThis.__engelbartAnnotations.command({type:"clear"}); delete globalThis.__engelbartAnnotations; true');
    await annotate({ type: 'clear' });
    assert.equal(await inPicker('typeof globalThis.__engelbartAnnotations'), 'undefined', 'lost helper cleanup is a no-op');
    await annotate({ type: 'mode', on: true });
    assert.equal(await js(page, 'document.querySelectorAll("[data-engelbart-annotations]").length'), 1, 'next action restores exactly one overlay');
    await inPicker('globalThis.__engelbartAnnotations.command({type:"clear"}); delete globalThis.__engelbartAnnotations; true');
    await until(() => inPicker('typeof globalThis.__engelbartAnnotations?.command === "function"'), 'poll repairs a missing helper');
    await annotate({ type: 'clear' });
    await new Promise(resolve => { page.once('did-finish-load', resolve); page.reload(); });
    await until(() => js(wc, '!document.querySelector("[data-annotate-toggle]")?.disabled'), 'page ready after lifecycle test reload');
    await annotate({ type: 'clear' });
    assert.equal(await inPicker('typeof globalThis.__engelbartAnnotations'), 'undefined', 'cleanup after reload does not recreate the controller');
    console.log('PASS absent/lost helper cleanup, next-action and poll recovery, real-page reload');

    const originalBounds = browser.getBounds();
    await select(wc, page);
    assert.deepEqual(browser.getBounds(), originalBounds, 'selection does not resize or shift the page');
    assert.equal(await js(wc, '!!document.querySelector(".ia-composer")'), false);
    await hover(page, '#publish span');
    assert.equal(await js(page, 'getComputedStyle(document.querySelector("#publish span")).cursor'), 'pointer');
    const appearance = await overlay(page);
    assert.equal(appearance.overlayCount, 3, 'only blockers, outline and markers; no label box');
    assert.match(appearance.outline, /1px solid rgb\(82, 82, 82\)/);
    fs.writeFileSync(path.join(root, 'hover.png'), (await page.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await js(page, `(()=>{const b=document.createElement('button');b.id='edge';b.textContent='Action';b.setAttribute('aria-label','A readable name that is longer than the available space beside this element');Object.assign(b.style,{position:'fixed',right:'0',bottom:'0'});document.body.append(b)})()`);
    await hover(page, '#edge');
    assert.match((await overlay(page)).outline, /display: block/);
    await js(page, 'document.querySelector("#edge").remove()');
    await escape(page);
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'Escape removes the page overlay');
    assert.equal(await js(page, 'document.querySelector("#publish span").hasAttribute("style")'), false, 'temporary cursor attribute is removed');
    assert.equal(await js(wc, 'document.querySelector("[data-annotate-toggle]").getAttribute("aria-label")'), 'Annotate page');
    await select(wc, page); await escape(wc);
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'Escape from toolbar also exits');
    await select(wc, page);
    await click(page, '#publish span');
    await until(() => js(wc, '!!document.querySelector(".ia-editor textarea")'), 'note editor');
    await until(() => js(wc, 'document.activeElement?.getAttribute("aria-label")==="Question or note"'), 'composer focuses the shared text box');
    assert.equal(await js(wc, 'document.querySelectorAll(".ia-composer textarea").length'), 1, 'one shared text box');
    assert.equal(await js(wc, '!!document.querySelector(".ia-intent")'), false, 'no action-switching tabs');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll(".ia-composer button")].map(b=>b.textContent)'), ['Cancel', 'Add note', 'Ask Bart'], 'only the three footer actions, without duplicate Cancel or Save');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll(".ia-composer .ia-actions button")].map(b=>b.disabled)'), [false, true, true], 'empty text cannot be sent or saved');
    assert.ok(await js(wc, '(()=>{const t=document.querySelector(".ia-composer textarea").getBoundingClientRect(),[cancel,note,ask]=[...document.querySelectorAll(".ia-composer .ia-actions button")].map(b=>b.getBoundingClientRect());return Math.abs(t.left-cancel.left)<1&&Math.abs(t.right-ask.right)<1&&cancel.top>t.bottom&&cancel.top===note.top&&note.top===ask.top&&note.left-cancel.right>ask.left-note.right})()'), 'Cancel sits at the left edge, with Add note and Ask Bart grouped at the right below the text box');
    assert.equal(await js(wc, '!!document.querySelector("aside.interface-annotations")'), false);
    assert.deepEqual(browser.getBounds(), originalBounds, 'composing also keeps the original browser width');
    assert.equal(await js(wc, 'document.querySelector(".ia-composer .ia-target").textContent'), 'Publish draft');
    assert.equal(await js(page, 'window.clicks'), 0, 'picking never activates the app');
    assert.equal(await js(page, 'typeof window.engelbartAPI'), 'undefined');
    assert.equal(await js(page, 'typeof window.__engelbartAnnotations'), 'undefined', 'picker is invisible to main-world JavaScript');
    await fill(wc, 'Make the publish action clearer before release.');
    await pause(300);
    fs.writeFileSync(path.join(root, 'composer.png'), (await wc.capturePage()).toPNG());
    await button(wc, 'Add note');
    await until(() => js(wc, '!document.querySelector(".ia-composer") && document.querySelector("[data-annotate-toggle]").getAttribute("aria-pressed")==="false"'), 'save exits annotation mode');
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'save clears selection overlays');
    let saved = await js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`);
    assert.equal(saved.notes[0].anchor.element.tag, 'button');
    assert.equal(saved.notes[0].anchor.element.testid, 'publish');
    assert.equal(saved.notes[0].body, 'Make the publish action clearer before release.', 'Add note directly saves the shared draft');
    const linkedWebsite = await js(wc, `window.engelbartAPI.library().then(rows=>rows.find(row=>row.id===${JSON.stringify(saved.notes[0].libraryId)}))`);
    assert.equal(linkedWebsite.url, origin + '/editor', 'annotating an unsaved page creates its local library source');
    assert.ok(!JSON.stringify(saved).includes('do-not-capture'));
    assert.equal(saved.notes[0].anchor.bounds, undefined);
    console.log('PASS no sidebar/resize, outline-only hover, pointer, Escape cleanup, contextual composer, click interception, isolation, saved note');

    const contextReader = require('../src/main/browser/annotations.cjs').createAnnotations(page, () => {});
    try {
      await js(page, `(()=>{const f=document.createElement('form');f.id='context-test';f.method='post';f.action='/join?token=omit-url-token';f.innerHTML='<h2>Join study</h2><label>Participant ID <input name="participant" value="omit-input"></label><label>Nickname <textarea>omit-textarea</textarea></label><input type="hidden" value="omit-hidden"><div data-private>omit-private</div><div class="rr-mask">omit-mask</div><div id="context-hidden">omit-css-hidden</div><div contenteditable>omit-editable</div><button id="context-submit" onclick="doNotCapture()">Submit</button>';f.querySelector('#context-hidden').style.display='none';document.body.append(f)})()`);
      const target = { element: { tag: 'button', selector: '#context-submit', id: 'context-submit', text: 'Submit' }, ancestors: [], frames: [], route: '/editor' };
      const captured = await contextReader.snapshot(target);
      assert.equal(captured.status, 'available');
      assert.equal(captured.element.attributes.type, 'submit');
      assert.match(captured.surroundingText, /Participant ID.*Nickname.*Submit/);
      assert.equal(captured.form.action, origin + '/join');
      assert.equal(captured.form.method, 'post');
      assert.doesNotMatch(JSON.stringify(captured), /omit-|onclick|doNotCapture/);
      assert.equal(await js(page, '!!document.querySelector("[data-engelbart-annotations]")'), false, 'reading context does not create markers or a selection overlay');
      await js(page, 'document.querySelector("#context-test").remove()');
      assert.equal((await contextReader.snapshot(target)).status, 'unavailable', 'missing controls have an explicit fallback');
      const nested = await contextReader.snapshot({ element: { tag: 'button', selector: '#deep', text: 'Nested action' }, ancestors: [], frames: ['#same', '#nested'], route: '/editor' });
      assert.equal(nested.element.text, 'Nested action');
      const shadow = await contextReader.snapshot({ element: { tag: 'button', selector: '#shadow >>> button', text: 'Shadow action' }, ancestors: [], frames: [], route: '/editor' });
      assert.equal(shadow.element.text, 'Shadow action');
      const cross = await contextReader.snapshot({ element: { tag: 'button', selector: '#inside' }, ancestors: [], frames: ['#cross'], route: '/editor' });
      assert.equal(cross.status, 'unavailable');
      assert.match(cross.reason, /inaccessible/);
    } finally { contextReader.dispose(); }
    console.log('PASS live DOM context, form semantics, private/value filtering, same-origin frames, shadow DOM, and inaccessible/missing-element fallback');

    await browse(wc);
    await until(() => !browser.getVisible(), 'list uses the existing Stage snapshot overlay');
    assert.deepEqual(browser.getBounds(), originalBounds, 'browsing saved notes never narrows the page');
    await assertPopover(wc, 'browser');
    assert.equal(await js(wc, 'document.querySelector(".ia-heading strong").textContent'), 'Annotations', 'heading has no count');
    assert.ok(saved.notes[0].sourceName, 'saved note has a website name');
    assert.equal(await js(wc, 'document.querySelector(".ia-row-target").textContent'), saved.notes[0].sourceName, 'list identifies the website rather than the component');
    assert.equal(await js(wc, 'document.querySelector(".ia-number").textContent'), '1', 'row keeps its corresponding page marker number');
    assert.equal(await js(wc, '!!document.querySelector(".ia-pick,aside.interface-annotations")'), false);
    fs.writeFileSync(path.join(root, 'floating-annotations.png'), (await wc.capturePage()).toPNG());
    await click(wc, '.ia-row');
    await until(() => js(wc, '!!window.__lastPlacement?.bounds && !!document.querySelector(".ia-note")'), 'saved note has target placement');
    await pause(250); await assertPopover(wc, 'note');
    assert.deepEqual(browser.getBounds(), originalBounds, 'reading a saved note never narrows the page');
    assert.equal(await js(wc, 'document.querySelectorAll(".ia-row").length'), 0, 'note details replace the compact list');
    fs.writeFileSync(path.join(root, 'contextual-saved-note.png'), (await wc.capturePage()).toPNG());
    await allNotes(wc); await assertPopover(wc, 'browser');
    await escape(wc);
    await until(() => !browser.getVisible() ? false : js(wc, '!document.querySelector(".ia-popover")'), 'Escape dismisses saved notes and restores the page');
    await browse(wc);
    await click(wc, '[data-browser-slot]');
    await until(() => js(wc, '!document.querySelector(".ia-popover")'), 'outside click dismisses the floating list');
    await until(() => browser.getVisible(), 'outside dismissal restores the native page');
    assert.equal(await js(page, 'window.clicks'), 0, 'dismissal does not click through to website controls');
    console.log('PASS floating list, contextual saved note, full-width page, semantic row labels, Back, Escape and outside dismissal');

    await browse(wc);
    const longNotes = await js(wc, `(async()=>{const ids=[];for(let i=0;i<10;i++){const note=await window.engelbartAPI.createInterfaceAnnotation({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}},{body:'Review detail '+i+' — '+('A longer saved note should stay readable without filling the whole Stage. '.repeat(i===9?35:3)),anchor:${JSON.stringify(saved.notes[0].anchor)}});ids.push(note.id)}return ids})()`);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===11 && !!document.querySelector(\'.ia-list[aria-busy="false"]\')'), 'long annotation collection');
    await assertPopover(wc, 'browser');
    assert.ok(await js(wc, '(()=>{const p=document.querySelector(".ia-browser");p.scrollTop=p.scrollHeight;return p.scrollTop>0&&p.scrollHeight>p.clientHeight})()'), 'long list scrolls internally');
    await click(wc, '.ia-row:last-child');
    await until(() => js(wc, 'document.querySelector(".ia-note .ia-body")?.textContent.startsWith("Review detail 9")'), 'long note opens');
    await pause(250); await assertPopover(wc, 'note');
    assert.ok(await js(wc, '(()=>{const p=document.querySelector(".ia-note");return p.getBoundingClientRect().height<=420&&p.scrollTop===0&&p.scrollHeight>p.clientHeight})()'), 'long note is bounded, internally scrollable, and starts at its heading');
    fs.writeFileSync(path.join(root, 'long-saved-note.png'), (await wc.capturePage()).toPNG());
    await escape(wc);
    for (const id of longNotes) await js(wc, `window.engelbartAPI.deleteInterfaceAnnotation({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}},${JSON.stringify(id)})`);
    await until(() => browser.getVisible(), 'page restored after long-note dismissal');
    console.log('PASS bounded long list and long note, internal scrolling, heading reset, and fixture-only cleanup');

    await js(wc, 'localStorage.setItem("engelbart:annotation-markers-visible","true")');
    await browse(wc);
    await until(async () => (await overlay(page)).markers.length === 1, 'markers appear while browsing annotations');
    await click(wc, '[aria-label="Close annotations"]');
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'closing annotations clears markers despite the old preference');
    await until(() => browser.getVisible(), 'closing annotations restores page interaction');
    await click(page, '#publish span');
    assert.equal(await js(page, 'window.clicks'), 1, 'dismissed annotations leave normal page controls usable');
    await click(wc, '[aria-label="More"]');
    assert.equal(await js(wc, '!!document.querySelector("[data-annotation-markers]")'), false, 'marker preference has been removed');
    await click(wc, '[aria-label="More"]');
    console.log('PASS annotation marker cleanup, ignored old preference, and unchanged page interaction');

    await select(wc, page); await click(page, '#publish span');
    await until(() => js(wc, 'document.querySelector(".ia-editor textarea")?.getAttribute("aria-label")==="Question or note"'), 'new selection opens the shared editor');
    await fill(wc, 'Why does this publish control look unclear?');
    await pause(300);
    fs.writeFileSync(path.join(root, 'ask-bart.png'), (await wc.capturePage()).toPNG());
    const workspaceBeforeAsk = await js(wc, `window.engelbartAPI.readDoc(${JSON.stringify(pid)},{kind:'workspace',workspaceId:${JSON.stringify(created.workspaceId)}})`);
    const composerBounds = await js(wc, 'document.querySelector(".ia-composer").getBoundingClientRect().toJSON()');
    await button(wc, 'Ask Bart');
    await until(() => js(wc, '!!document.querySelector(".ia-chat [data-annotation-reply]") && !document.querySelector(".ia-composer")'), 'Ask Bart continues in an anchored chat');
    const chatBounds = await js(wc, 'document.querySelector(".ia-chat").getBoundingClientRect().toJSON()');
    assert.ok(Math.abs(chatBounds.left - composerBounds.left) < 1 && Math.abs(chatBounds.top - composerBounds.top) < 1, 'sending keeps the conversation at the selected element');
    assert.equal(await js(wc, 'document.activeElement?.getAttribute("aria-label")'), 'Message Bart', 'follow-up input receives focus');
    assert.equal(await js(wc, 'document.querySelector(".ia-body").textContent'), 'Why does this publish control look unclear?');
    assert.equal(await js(wc, 'document.querySelector("main")?.textContent.includes("Why does this publish control look unclear?")'), false, 'question never enters the workspace');
    await until(() => js(wc, 'document.querySelector(\'.ia-chat [data-annotation-reply][aria-busy="true"]\')?.textContent.includes("FAKE ANSWER")'), 'partial answer renders before completion');
    assert.ok(await js(wc, 'document.querySelector(".ia-chat [role=status]")?.textContent.includes("Writing")'), 'the popup shows live progress');
    fs.writeFileSync(path.join(root, 'annotation-streaming.png'), (await wc.capturePage()).toPNG());
    await click(wc, '[data-browser-slot]');
    await until(() => js(wc, '!document.querySelector(".ia-chat")'), 'outside click dismisses the conversation');
    const readNotes = () => js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`);
    await until(async () => (await readNotes()).notes.some(n => n.reply?.status === 'complete'), 'answer persists while the dropdown is closed');
    assert.equal((await readNotes()).notes.length, 2, 'Ask Bart saves its question and selected element');
    await browse(wc); await js(wc, 'document.querySelector(".ia-row:last-child").click()');
    await until(() => js(wc, 'document.querySelector("[data-annotation-reply]")?.textContent.includes("FAKE ANSWER")'), 'scripted Bart response appears only in Annotations');
    assert.equal(await js(wc, 'document.querySelectorAll(".ia-chat-user").length'), 1, 'reopening keeps the first message');
    const reopenedBounds = await js(wc, 'document.querySelector(".ia-chat").getBoundingClientRect().toJSON()');
    await fill(wc, 'Which label would you recommend, and why?', '.ia-chat-compose textarea');
    await click(wc, '[aria-label="Send message"]');
    await until(() => js(wc, 'document.querySelectorAll(".ia-chat-user").length === 2'), 'follow-up appends to the same thread');
    await until(() => js(wc, 'document.querySelector(\'.ia-chat [data-annotation-reply][aria-busy="true"]\')?.textContent.includes("FAKE ANSWER")'), 'follow-up streams too');
    await js(wc, 'document.querySelector(".ia-chat-messages").scrollTop=0');
    await pause(100);
    await until(() => js(wc, '[...document.querySelectorAll("[data-annotation-reply]")].at(-1)?.getAttribute("aria-busy")==="false"'), 'follow-up answer finishes');
    const threadState = await js(wc, '(()=>{const p=document.querySelector(".ia-chat"),m=p.querySelector(".ia-chat-messages"),f=p.querySelector(".ia-chat-compose"),r=p.getBoundingClientRect(),c=f.getBoundingClientRect();return{left:r.left,top:r.top,scrolls:m.scrollHeight>m.clientHeight,readerAtTop:m.scrollTop===0,inputInside:c.bottom<=r.bottom&&c.top>=r.top,outerScroll:p.scrollTop}})()');
    assert.ok(Math.abs(threadState.left-reopenedBounds.left)<1 && Math.abs(threadState.top-reopenedBounds.top)<1, 'answers keep the chat anchored');
    assert.ok(threadState.scrolls && threadState.readerAtTop && threadState.inputInside && threadState.outerScroll===0, 'messages scroll independently, preserve reading position, and leave the input visible');
    fs.writeFileSync(path.join(root, 'annotation-answer.png'), (await wc.capturePage()).toPNG());
    assert.equal(await js(wc, 'document.querySelector("main")?.textContent.includes("FAKE ANSWER")'), false);
    await click(wc, '[aria-label="Close annotations"]');
    await browse(wc); await js(wc, 'document.querySelector(".ia-row:last-child").click()');
    await until(() => js(wc, 'document.querySelectorAll(".ia-chat-user").length === 2'), 'closing and reopening preserves the entire thread');
    await fill(wc, 'Make that recommendation shorter.', '.ia-chat-compose textarea');
    await js(wc, '(()=>{const t=document.querySelector(".ia-chat-compose textarea");t.focus();t.setSelectionRange(t.value.length,t.value.length)})()');
    wc.focus();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
    await until(() => js(wc, 'document.querySelector(".ia-chat-compose textarea").value.endsWith("\\n")'), 'Shift+Enter adds a newline');
    assert.equal(await js(wc, 'document.querySelectorAll(".ia-chat-user").length'), 2, 'a newline does not send a message');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until(() => js(wc, 'document.querySelectorAll(".ia-chat-user").length === 3 && [...document.querySelectorAll("[data-annotation-reply]")].at(-1)?.getAttribute("aria-busy")==="false"'), 'Enter sends a follow-up in the same chat');
    fs.writeFileSync(path.join(root, 'annotation-followup.png'), (await wc.capturePage()).toPNG());
    await click(wc, '[aria-label="Close annotations"]');
    await select(wc, page); await click(page, '#publish span');
    await until(() => js(wc, '!!document.querySelector(".ia-editor textarea")'), 'keyboard shortcut editor');
    await fill(wc, 'Suggest a clearer label for this control.');
    wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['meta'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['meta'] });
    await until(() => js(wc, 'document.querySelector(".ia-chat .ia-body")?.textContent === "Suggest a clearer label for this control."'), 'Cmd+Enter starts an anchored conversation');
    await until(() => js(wc, 'document.querySelector("[data-annotation-reply]")?.getAttribute("aria-busy")==="false"'), 'keyboard question answered');
    assert.deepEqual(await js(wc, `window.engelbartAPI.readDoc(${JSON.stringify(pid)},{kind:'workspace',workspaceId:${JSON.stringify(created.workspaceId)}})`), workspaceBeforeAsk, 'both asks leave the workspace document unchanged');
    await click(wc, '[aria-label="Close annotations"]');
    const askedNotes = (await readNotes()).notes.filter(n => n.reply);
    assert.equal(askedNotes.length, 2);
    for (const note of askedNotes) await js(wc, `window.engelbartAPI.deleteInterfaceAnnotation({projectId:${JSON.stringify(pid)}},${JSON.stringify(note.id)})`);
    console.log('PASS anchored chat, follow-ups, fixed composer, internal scroll, outside dismissal, persisted conversation, unchanged workspace document');

    await select(wc, page);
    await js(page, 'document.querySelector("#private").style.setProperty("cursor","text","important")');
    await hover(page, '#private');
    assert.equal(await js(page, 'getComputedStyle(document.querySelector("#private")).cursor'), 'pointer');
    await click(page, '#private');
    await until(() => js(wc, 'window.__lastAnnotation?.anchor.element.tag==="input"'), 'input selected');
    const privatePick = await js(wc, 'window.__lastAnnotation.anchor');
    assert.equal(privatePick.element.text || '', '');
    assert.ok(!JSON.stringify(privatePick).includes('do-not-capture'));
    assert.equal(await js(page, 'document.querySelector("#private").style.getPropertyValue("cursor")'), 'text');
    assert.equal(await js(page, 'document.querySelector("#private").style.getPropertyPriority("cursor")'), 'important');
    await fill(wc, 'Discard this draft.');
    await button(wc, 'Cancel');
    assert.equal((await js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`)).notes.length, 1, 'Cancel does not save the draft');
    await select(wc, page);
    await js(page, 'document.querySelector("#shadow").shadowRoot.querySelector("button").click()');
    await until(() => js(wc, 'window.__lastAnnotation?.anchor.element.testid==="shadow-action"'), 'open shadow root selected');
    assert.match(await js(wc, 'window.__lastAnnotation.anchor.element.selector'), / >>> /);
    await button(wc, 'Cancel');
    await select(wc, page);
    // Native input also exercises Chromium's frame routing after the composer
    // has hidden and restored this WebContentsView.
    const cp = await js(page, '(()=>{const r=document.querySelector("#cross").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    page.focus();
    page.sendInputEvent({ type: 'mouseMove', ...cp });
    page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...cp });
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...cp });
    await until(() => js(wc, 'window.__lastAnnotation?.anchor.element.id==="cross"'), 'cross-origin frame itself selected').catch(async (error) => {
      console.error('Cross-frame diagnostic:', browser.getVisible(), await js(wc, '({pick:window.__lastAnnotation,status:window.__annotationStatus})'), await overlay(page), await js(page, '({width:innerWidth,height:innerHeight,box:document.querySelector("#cross").getBoundingClientRect().toJSON()})'));
      fs.writeFileSync(path.join(root, 'frame-failure.png'), (await page.capturePage()).toPNG());
      throw error;
    });
    await button(wc, 'Cancel');
    await browse(wc);
    await js(wc, 'document.querySelector(".ia-row").click()');
    console.log('PASS private input exclusion, open shadow roots, cross-origin frame selection');

    await button(wc, 'Edit'); await fill(wc, 'Edited: make this action clearer.'); await button(wc, 'Save note');
    await until(() => js(wc, 'document.querySelector(".ia-body")?.textContent==="Edited: make this action clearer."'), 'edit saved');
    await new Promise((resolve) => { page.once('did-finish-load', resolve); page.reload(); });
    await pause(300);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !!document.querySelector(\'.ia-list[aria-busy="false"]\')').catch(() => false), 'notes after reload');
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'element found after reload');
    await js(page, 'document.querySelector("#publish span").textContent="Release draft"');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Closest match")'), 'changed element marked approximate');
    await js(page, 'document.querySelector("#publish").remove()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element not found")'), 'missing element not guessed');
    console.log('PASS editing, reload persistence, changed and missing targets');

    // Same-origin frame: actual pointer input is delivered into the child document.
    await select(wc, page);
    const fp = await js(page, `(()=>{const f=document.querySelector('#same'),a=f.getBoundingClientRect(),b=f.contentDocument.querySelector('button').getBoundingClientRect();return {x:Math.round(a.x+f.clientLeft+b.x+b.width/2),y:Math.round(a.y+f.clientTop+b.y+b.height/2)}})()`);
    page.focus(); page.sendInputEvent({ type: 'mouseMove', ...fp });
    await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...fp });
    await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...fp });
    await until(() => js(wc, 'document.querySelector(".ia-editor")?.textContent.includes("Embedded action")'), 'frame selection');
    await fill(wc, 'Frame note'); await button(wc, 'Add note');
    await until(() => js(wc, '!document.querySelector(".ia-composer")'), 'frame composer saved');
    await browse(wc);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===2'), 'frame note saved');
    saved = await js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`);
    assert.deepEqual(saved.notes[1].anchor.frames, ['#same']);
    assert.ok((await js(wc, 'window.__annotationStatus')).unavailable > 0, 'bridge still records inaccessible frames without cluttering the saved-notes list');
    await select(wc, page);
    const np = await js(page, `(()=>{const f=document.querySelector('#same'),n=f.contentDocument.querySelector('#nested'),b=n.contentDocument.querySelector('#deep');b.scrollIntoView();n.scrollIntoView();f.scrollIntoView();const a=f.getBoundingClientRect(),c=n.getBoundingClientRect(),d=b.getBoundingClientRect();return{x:Math.round(a.x+f.clientLeft+c.x+n.clientLeft+d.x+d.width/2),y:Math.round(a.y+f.clientTop+c.y+n.clientTop+d.y+d.height/2)}})()`);
    await pause(300);
    page.focus(); page.sendInputEvent({ type: 'mouseMove', ...np });
    await pause(100);
    assert.equal(await js(page, 'getComputedStyle(document.querySelector("#same").contentDocument.querySelector("#nested").contentDocument.querySelector("#deep")).cursor'), 'pointer');
    page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...np });
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...np });
    await until(() => js(wc, 'window.__lastAnnotation?.anchor.element.id==="deep"'), 'nested frame picked');
    assert.deepEqual(await js(wc, 'window.__lastAnnotation.anchor.frames'), ['#same', '#nested']);
    await fill(wc, 'Nested frame note'); await button(wc, 'Add note');
    await until(() => js(wc, '!document.querySelector(".ia-composer")'), 'nested composer saved');
    await browse(wc);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===3'), 'nested note persisted');
    await js(wc, 'document.querySelector(".ia-row:last-child").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'nested target restored');
    await assertPopover(wc, 'note');
    assert.ok((await js(wc, 'window.__lastPlacement')).bounds, 'nested-frame target provides top-level placement');
    fs.writeFileSync(path.join(root, 'nested-saved-note.png'), (await wc.capturePage()).toPNG());
    await button(wc, 'Delete');
    await js(wc, 'document.querySelector(".ia-delete button:last-child").click()');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===2 && !document.querySelector(".ia-row:last-child").disabled'), 'nested test note removed');
    await js(wc, 'document.querySelector(".ia-row:last-child").click()');
    console.log('PASS same-origin and nested-frame selection/restoration and saved-note placement, inaccessible frame tracking');

    await button(wc, 'Ask Bart');
    await until(() => js(wc, 'document.querySelector(".ia-chat-send")?.getAttribute("aria-label")==="Stop response"'), 'saved note becomes a chat while Bart responds');
    await click(wc, '[aria-label="Stop response"]');
    await until(() => js(wc, 'document.querySelector(".ia-chat-messages")?.textContent.includes("Response stopped.")'), 'response can be stopped within the chat');
    await button(wc, 'Try again');
    await until(() => js(wc, '[...document.querySelectorAll("[data-annotation-reply]")].at(-1)?.getAttribute("aria-busy")==="false" && !document.querySelector("[aria-label=\\"Delete conversation\\"]").disabled'), 'saved annotation receives its complete answer');
    await click(wc, '[aria-label="Delete conversation"]');
    await js(wc, `document.querySelector('.ia-chat-delete button:last-child')?.click()`);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !document.querySelector("[aria-label=\\"Close annotations\\"]").disabled'), 'delete persisted');
    await click(wc, '[aria-label="Close annotations"]');
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'overlay removed');
    await new Promise((resolve) => { page.once('did-finish-load', resolve); page.reload(); });
    await pause(300);
    await click(page, '#publish');
    assert.equal(await js(page, 'window.clicks'), 1, 'normal interaction is restored');
    await browse(wc);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1'), 'reopen stored note');
    await click(wc, '.ia-row');
    await js(page, 'window.scrollTo(0,650)');
    await pause(350);
    await allNotes(wc);
    const scrolledSnapshot = await js(wc, 'document.querySelector("[data-browser-slot] img")?.src');
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(page, 'scrollY<500'), 'locate scrolls back to the saved element');
    await until(() => js(wc, `!!document.querySelector('[data-browser-slot] img') && document.querySelector('[data-browser-slot] img').src !== ${JSON.stringify(scrolledSnapshot)}`), 'locate refreshes the already-hidden page snapshot');
    await js(page, 'history.pushState({},"","/other")');
    await until(() => js(wc, 'document.querySelector("[data-stage] input")?.value.endsWith("/other")').catch(() => false), 'in-page navigation');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !!document.querySelector(\'.ia-list[aria-busy="false"]\')'), 'notes on another route');
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Written on") && document.querySelector(".ia-detail")?.textContent.includes("/editor")'), 'notes do not attach to the wrong route');
    await button(wc, 'Open page');
    await until(() => page.getURL().endsWith('/editor'), 'return to annotated route');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !!document.querySelector(\'.ia-list[aria-busy="false"]\')'), 'saved note ready after returning');
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'anchor found on original route');
    await pause(400);
    const screenshot = path.join(root, 'annotations.png');
    fs.writeFileSync(screenshot, (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await page.capturePage(undefined, { stayHidden: true, stayAwake: true }).then((image) => fs.writeFileSync(path.join(root, 'page.png'), image.toPNG())).catch(() => {});
    // Other websites must never enter this site's collection or count.
    const otherUrl = origin.replace('127.0.0.1', 'localhost') + '/editor';
    const other = await js(wc, `window.engelbartAPI.createInterfaceAnnotation({projectId:${JSON.stringify(pid)},url:${JSON.stringify(otherUrl)}},{body:'A note on another website',anchor:${JSON.stringify(saved.notes[0].anchor)}})`);
    await until(() => js(wc, `window.__annotationStatus?.resolutions && !Object.hasOwn(window.__annotationStatus.resolutions,${JSON.stringify(other.id)})`), 'other website has no marker in this page');
    await allNotes(wc);
    assert.equal(await js(wc, 'document.querySelectorAll(".ia-row").length'), 1, 'other site excluded from collection');
    assert.equal(await js(wc, '!!document.querySelector("[data-saved-annotations]")'), false, 'saving notes does not bring back the removed shortcut');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(otherUrl)}}}))`);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && document.querySelector(".ia-row").textContent.includes("A note on another website")'), 'collection follows the other site');
    assert.equal(await js(wc, '!!document.querySelector(".ia-detail")'), false, 'previous site selection is cleared');
    const originalTab = await js(wc, `window.__lastAnnotation.tabId`);
    await js(wc, `document.querySelector('[data-stage-tab="${originalTab}"] > div').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && document.querySelector(".ia-row").textContent.includes("Edited: make this action clearer.")'), 'switching tabs restores the first site collection');
    // Close the collection before restarting: a deliberately open collection
    // is otherwise restored, even when its former tab is no longer available.
    await click(wc, '[aria-label="Close annotations"]');
    await until(() => js(wc, `window.engelbartAPI.sessionUI().then(state=>state[${JSON.stringify(`stage:${pid}:panel`)}]==null)`), 'closed collection saved before restart');
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'fresh Stage');
    // Renderer reload now restores Stage tabs. Open an actual blank tab rather
    // than relying on the older behavior that discarded the browser session.
    await click(wc, '[aria-label="New tab"]');
    assert.equal(await js(wc, '!!document.querySelector("[data-saved-annotations]")'), false, 'blank Stage has no site count');
    await click(wc, '[aria-label="More"]'); await click(wc, '[data-annotations-browse]');
    await until(() => js(wc, 'document.querySelector(".ia-list")?.textContent.includes("Open a website")'), 'blank Stage has an empty site collection');
    assert.equal(await js(wc, 'document.querySelectorAll(".ia-row").length'), 0);
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(origin + '/editor')}}}))`);
    const reopenedPage = await until(() => win.contentView.children.find(v => v.webContents?.getURL() === origin + '/editor')?.webContents, 'saved website reopened');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !!document.querySelector(\'.ia-list[aria-busy="false"]\')'), 'only reopened site notes visible');
    await click(wc, '.ia-row');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'saved marker restored on reopened site');
    fs.writeFileSync(path.join(root, 'restored-annotations.png'), (await wc.capturePage()).toPNG());
    assert.ok(reopenedPage);
    console.log('PASS site-specific list/count, tab switching, cleared selection, blank Stage, persistence and reopened website');
    reopenedPage.debugger.attach('1.3');
    await click(wc, '[aria-label="Close annotations"]');
    await browse(wc);
    await until(async () => (await overlay(reopenedPage)).markers.length === 1, 'annotation marker visible before reloading');
    await new Promise(resolve => { reopenedPage.once('did-finish-load', resolve); reopenedPage.reload(); });
    await until(async () => (await overlay(reopenedPage)).markers.length === 1, 'browsing restores marker on page reload');
    await js(reopenedPage, 'history.pushState({},"","/other")');
    await until(async () => (await overlay(reopenedPage)).markers.length === 0, 'no marker on a different route');
    await js(reopenedPage, 'history.pushState({},"","/editor")');
    await until(async () => (await overlay(reopenedPage)).markers.length === 1, 'marker returns on its own route');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(otherUrl)}}}))`);
    const otherPage = await until(() => win.contentView.children.find(v => v.webContents?.getURL() === otherUrl)?.webContents, 'other website tab');
    otherPage.debugger.attach('1.3');
    await until(async () => (await overlay(otherPage)).markers.length === 1, 'only the other website marker appears');
    await until(() => js(reopenedPage, '!document.querySelector("[data-engelbart-annotations]")'), 'old tab overlays are removed');
    await click(wc, '[aria-label="Close annotations"]');
    await until(() => js(wc, `window.engelbartAPI.sessionUI().then(state=>state[${JSON.stringify(`stage:${pid}:panel`)}]==null)`), 'dismissed markers saved before renderer restart');
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'fresh Stage');
    await click(wc, '[aria-label="More"]');
    assert.equal(await js(wc, '!!document.querySelector("[data-annotation-markers]")'), false, 'marker preference stays removed after restart');
    await click(wc, '[aria-label="More"]');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(origin + '/editor')}}}))`);
    const restoredPage = await until(() => win.contentView.children.find(v => v.webContents?.getURL() === origin + '/editor')?.webContents, 'restored page');
    if (!restoredPage.debugger.isAttached()) restoredPage.debugger.attach('1.3');
    assert.equal(await js(restoredPage, '!!document.querySelector("[data-engelbart-annotations]")'), false, 'old preference does not restore markers');
    await browse(wc);
    await until(async () => (await overlay(restoredPage)).markers.length === 1, 'browsing restores saved markers after renderer restart');
    assert.equal(await js(wc, '!!document.querySelector("aside.interface-annotations")'), false);
    console.log('PASS annotation markers across reload/routes/sites/tabs; removed preference stays inactive after restart');
    await js(wc, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
    win.hide();
    assert.equal(win.isVisible(), false);
    console.log(JSON.stringify({ ok: true, screenshot, root, checks: ['full-width selection and browsing', 'floating list and contextual saved note', 'bounded long lists/notes and internal scrolling', 'Back/Escape/outside dismissal', 'snapshot refresh after locate', 'neutral overlay', 'no selection label box', 'pointer/reset', 'Escape in page and toolbar', 'contextual composer', 'single text box', 'Cancel on the left, Add note/Ask Bart grouped on the right', 'Ask Bart click and Cmd+Enter save to Annotations', 'answer persists with dropdown closed', 'workspace document unchanged', 'save/cancel cleanup', 'save', 'edit', 'reload', 'resolve', 'approximate', 'missing', 'frames/nested frames', 'shadow roots', 'privacy', 'Ask Bart from saved note', 'delete', 'cleanup', 'reopen', 'scroll', 'in-page navigation', 'open original route'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Fixture:', root);
    if (win) {
      console.error(await js(win.webContents, 'document.querySelector(".interface-annotations")?.textContent').catch(() => 'no panel'));
      fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    }
    server.closeAllConnections(); server.close(); app.exit(1);
  }
});
