'use strict';
// Real app + real browser input. All data and screenshots go to a disposable home.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-annotations-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1' });
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
async function fill(wc, value) {
  await js(wc, `(()=>{const e=document.querySelector('.ia-editor textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
}
async function browse(wc) {
  await click(wc, '[aria-label="More"]');
  await click(wc, '[data-annotations-browse]');
  await until(() => js(wc, '!!document.querySelector(".ia-pick") && !document.querySelector(".ia-pick").disabled'), 'notes browser');
}
async function select(wc, page) {
  await click(wc, '[data-annotate-toggle]');
  await until(() => js(wc, 'document.querySelector("[data-annotate-toggle]")?.getAttribute("aria-pressed")==="true"'), 'selection toolbar state');
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
  const chipBox = children[2] && await page.debugger.sendCommand('DOM.getBoxModel', { nodeId: children[2].nodeId }).then(({ model }) => model.border).catch(() => null);
  return { covers: children[0]?.children?.map(attributes), outline: attributes(children[1]).style || '', chip: attributes(children[2]).style || '', chipBox, label: children[2]?.children?.map((n) => n.nodeValue || '').join('') || '' };
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
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1500, 980); win.webContents.setBackgroundThrottling(false); win.showInactive();
    const wc = win.webContents;
    wc.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('App console:', ...args); });
    await until(() => js(wc, '!!window.engelbartAPI && !!document.querySelector("button")').catch(() => false), 'bootstrap');
    const created = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Interface review',directory:${JSON.stringify(root)}})`);
    const pid = created.project.id;
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'workspace');
    await js(wc, 'window.engelbartAPI.onBrowserAnnotation(e=>{if(e.type==="picked")window.__lastAnnotation=e;if(e.type==="status")window.__annotationStatus=e});true');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(origin + '/editor')}}}))`);
    const browser = await until(() => win.contentView.children.find((v) => v.webContents?.getURL().startsWith(origin)), 'browser');
    const page = browser.webContents; page.setBackgroundThrottling(false);
    page.debugger.attach('1.3');
    page.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('Page console:', ...args); });
    await until(() => js(page, '!!document.querySelector("#publish")').catch(() => false), 'fixture');
    await until(() => js(wc, '!!document.querySelector("[data-annotate-toggle]")'), 'annotate control');
    const originalBounds = browser.getBounds();
    await select(wc, page);
    assert.deepEqual(browser.getBounds(), originalBounds, 'selection does not resize or shift the page');
    assert.equal(await js(wc, '!!document.querySelector(".ia-composer")'), false);
    await hover(page, '#publish span');
    assert.equal(await js(page, 'getComputedStyle(document.querySelector("#publish span")).cursor'), 'pointer');
    const appearance = await overlay(page);
    assert.equal(appearance.label, 'Publish draft');
    assert.match(appearance.outline, /1px solid rgb\(82, 82, 82\)/);
    assert.match(appearance.chip, /background: rgb\(250, 250, 250\)/);
    assert.doesNotMatch(appearance.label, /button|\d+×\d+|#publish/);
    fs.writeFileSync(path.join(root, 'hover.png'), (await page.capturePage()).toPNG());
    await js(page, `(()=>{const b=document.createElement('button');b.id='edge';b.textContent='Action';b.setAttribute('aria-label','A readable name that is longer than the available space beside this element');Object.assign(b.style,{position:'fixed',right:'0',bottom:'0'});document.body.append(b)})()`);
    await hover(page, '#edge');
    const edge = await overlay(page), viewport = await js(page, '({width:innerWidth,height:innerHeight})');
    assert.match(edge.label, /^A readable name/, 'ARIA name takes precedence over control text');
    assert.ok(edge.chipBox && edge.chipBox.filter((_, i) => i % 2 === 0).every((x) => x >= 0 && x <= viewport.width));
    assert.ok(edge.chipBox.filter((_, i) => i % 2 === 1).every((y) => y >= 0 && y <= viewport.height), 'label remains inside the viewport');
    await js(page, 'document.querySelector("#edge").remove()');
    await escape(page);
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'Escape removes the page overlay');
    assert.equal(await js(page, 'document.querySelector("#publish span").hasAttribute("style")'), false, 'temporary cursor attribute is removed');
    assert.equal(await js(wc, 'document.querySelector("[data-annotate-toggle]").textContent'), 'Annotate');
    await select(wc, page); await escape(wc);
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'Escape from toolbar also exits');
    await select(wc, page);
    await click(page, '#publish span');
    await until(() => js(wc, '!!document.querySelector(".ia-editor textarea")'), 'note editor');
    await until(() => js(wc, 'document.activeElement?.getAttribute("aria-label")==="Question for Bart"'), 'composer defaults to asking Bart and focuses the question');
    assert.equal(await js(wc, 'document.querySelector(".ia-intent [aria-pressed=true]").textContent'), 'Ask Bart');
    assert.equal(await js(wc, 'document.querySelector(".ia-actions .ia-primary").disabled'), true, 'empty questions cannot be sent');
    assert.equal(await js(wc, '!!document.querySelector("aside.interface-annotations")'), false);
    assert.deepEqual(browser.getBounds(), originalBounds, 'composing also keeps the original browser width');
    assert.equal(await js(wc, 'document.querySelector(".ia-composer .ia-target").textContent'), 'Publish draft');
    assert.equal(await js(page, 'window.clicks'), 0, 'picking never activates the app');
    assert.equal(await js(page, 'typeof window.engelbartAPI'), 'undefined');
    assert.equal(await js(page, 'typeof window.__engelbartAnnotations'), 'undefined', 'picker is invisible to main-world JavaScript');
    await fill(wc, 'Make the publish action clearer before release.');
    await button(wc, 'Add note');
    assert.equal(await js(wc, 'document.querySelector(".ia-editor textarea").value'), 'Make the publish action clearer before release.', 'switching actions preserves the draft');
    assert.equal(await js(wc, 'document.querySelector(".ia-editor textarea").getAttribute("aria-label")'), 'Annotation note');
    await pause(300);
    fs.writeFileSync(path.join(root, 'composer.png'), (await wc.capturePage()).toPNG());
    await button(wc, 'Save note');
    await until(() => js(wc, '!document.querySelector(".ia-composer") && document.querySelector("[data-annotate-toggle]").textContent==="Annotate"'), 'save exits annotation mode');
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'save clears selection overlays');
    let saved = await js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`);
    assert.equal(saved.notes[0].anchor.element.tag, 'button');
    assert.equal(saved.notes[0].anchor.element.testid, 'publish');
    assert.ok(!JSON.stringify(saved).includes('do-not-capture'));
    assert.equal(saved.notes[0].anchor.bounds, undefined);
    console.log('PASS no sidebar/resize, neutral semantic hover, pointer, Escape cleanup, contextual composer, click interception, isolation, saved note');

    await select(wc, page); await click(page, '#publish span');
    await until(() => js(wc, 'document.querySelector(".ia-editor textarea")?.getAttribute("aria-label")==="Question for Bart"'), 'new selection defaults back to Ask Bart');
    await fill(wc, 'Why does this publish control look unclear?');
    await pause(300);
    fs.writeFileSync(path.join(root, 'ask-bart.png'), (await wc.capturePage()).toPNG());
    wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['meta'] }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['meta'] });
    await until(() => js(wc, '!document.querySelector(".ia-composer") && document.querySelector("main")?.textContent.includes("Why does this publish control look unclear?")'), 'Cmd+Enter sends the default question to the existing Bart flow');
    await until(() => js(page, '!document.querySelector("[data-engelbart-annotations]")'), 'asking clears the selection');
    assert.equal((await js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`)).notes.length, 1, 'asking does not implicitly save a note');
    await until(() => js(wc, 'document.querySelector("main")?.textContent.includes("FAKE ANSWER")'), 'scripted Bart response');
    assert.equal(await js(wc, 'document.querySelector("main").textContent.includes("Annotation id: undefined")'), false);
    console.log('PASS Ask Bart default/reset, mode switching preserves draft, Cmd+Enter handoff, no implicit note, scripted response');

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
    await button(wc, 'Cancel');
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
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !document.querySelector(".ia-pick").disabled').catch(() => false), 'notes after reload');
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
    await button(wc, 'Add note'); await fill(wc, 'Frame note'); await button(wc, 'Save note');
    await until(() => js(wc, '!document.querySelector(".ia-composer")'), 'frame composer saved');
    await browse(wc);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===2'), 'frame note saved');
    saved = await js(wc, `window.engelbartAPI.interfaceAnnotations({projectId:${JSON.stringify(pid)},url:${JSON.stringify(origin + '/editor')}})`);
    assert.deepEqual(saved.notes[1].anchor.frames, ['#same']);
    await until(() => js(wc, 'document.querySelector(".interface-annotations").textContent.includes("cannot be inspected")'), 'cross-origin frame warning');
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
    await button(wc, 'Add note'); await fill(wc, 'Nested frame note'); await button(wc, 'Save note');
    await until(() => js(wc, '!document.querySelector(".ia-composer")'), 'nested composer saved');
    await browse(wc);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===3'), 'nested note persisted');
    await js(wc, 'document.querySelector(".ia-row:last-child").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'nested target restored');
    await button(wc, 'Delete');
    await js(wc, 'document.querySelector(".ia-delete button:last-child").click()');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===2'), 'nested test note removed');
    await js(wc, 'document.querySelector(".ia-row:last-child").click()');
    console.log('PASS same-origin and nested-frame selection/restoration, inaccessible frame feedback');

    await button(wc, 'Ask Bart');
    await until(() => js(wc, 'document.querySelector("main")?.textContent.includes("interface annotation")'), 'annotation reaches workspace question');
    await button(wc, 'Delete');
    await js(wc, `document.querySelector('.ia-delete button:last-child')?.click()`);
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1'), 'delete persisted');
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
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(page, 'scrollY<500'), 'locate scrolls back to the saved element');
    await js(page, 'history.pushState({},"","/other")');
    await until(() => js(wc, 'document.querySelector("[data-stage] input")?.value.endsWith("/other")').catch(() => false), 'in-page navigation');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !document.querySelector(".ia-pick").disabled'), 'notes on another route');
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Written on /editor")'), 'notes do not attach to the wrong route');
    await button(wc, 'Open page');
    await until(() => page.getURL().endsWith('/editor'), 'return to annotated route');
    await until(() => js(wc, 'document.querySelectorAll(".ia-row").length===1 && !document.querySelector(".ia-pick").disabled'), 'saved note ready after returning');
    await js(wc, 'document.querySelector(".ia-row").click()');
    await until(() => js(wc, 'document.querySelector(".ia-detail")?.textContent.includes("Element found")'), 'anchor found on original route');
    await pause(400);
    const screenshot = path.join(root, 'annotations.png');
    fs.writeFileSync(screenshot, (await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG());
    await page.capturePage(undefined, { stayHidden: true, stayAwake: true }).then((image) => fs.writeFileSync(path.join(root, 'page.png'), image.toPNG())).catch(() => {});
    await js(wc, 'window.terminalAPI.bootstrap().then(s=>Promise.all(s.sessions.map(t=>window.terminalAPI.closeSession(t.id))))');
    win.hide();
    assert.equal(win.isVisible(), false);
    console.log(JSON.stringify({ ok: true, screenshot, root, checks: ['full-width selection', 'neutral overlay', 'semantic label', 'pointer/reset', 'Escape in page and toolbar', 'contextual composer', 'Ask Bart default', 'Ask/Add note draft switching', 'Cmd+Enter asks without saving a note', 'save/cancel cleanup', 'save', 'edit', 'reload', 'resolve', 'approximate', 'missing', 'frames/nested frames', 'shadow roots', 'privacy', 'Ask Bart from saved note', 'delete', 'cleanup', 'reopen', 'scroll', 'in-page navigation', 'open original route'] }));
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
