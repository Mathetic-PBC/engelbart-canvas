'use strict';

// Real Electron/rrweb, isolated data and local fixtures; never touches active previews.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const restoreAt = process.argv.indexOf('--restore');
const restoreRoot = restoreAt >= 0 ? process.argv[restoreAt + 1] : null;
const root = restoreRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-recordings-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1' });
require('../src/main/index.cjs');
const pause = (ms = 50) => new Promise(r => setTimeout(r, ms));
const js = (wc, code) => wc.executeJavaScript(code, true).catch(error => { console.error('Script:', code.slice(0, 300)); throw error; });
async function until(fn, label) {
  for (let i = 0; i < 160; i++) { const value = await fn(); if (value) return value; await pause(75); }
  throw new Error(`Timed out: ${label}`);
}
const click = (wc, selector) => js(wc, `document.querySelector(${JSON.stringify(selector)}).click()`);
const editFields = wc => js(wc, `(() => {
  const values = { typed: 'Notes 123 café', number: '42.75', multiline: 'First line 123\\nSecond line', cleared: '',
    password: 'private-password-edited', masked: 'private-masked-edited', blocked: 'private-blocked-edited' };
  for (const [id, value] of Object.entries(values)) {
    const input = document.getElementById(id); input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  document.getElementById('editable').textContent = 'Edited rich text 456';
  document.getElementById('maskedText').textContent = 'private-rich-edited';
})()`);
const replayFields = replay => replay.executeJavaScript(`(() => {
  const doc = document.querySelector('.replayer-wrapper iframe').contentDocument;
  return { text: doc.getElementById('typed').value, number: doc.getElementById('number').value,
    multiline: doc.getElementById('multiline').value, cleared: doc.getElementById('cleared').value,
    editable: doc.getElementById('editable').textContent, password: doc.getElementById('password').value,
    masked: doc.getElementById('masked').value };
})()`);
let origin, requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{margin:28px;background:#f8f8f7;color:#202020;font:15px/1.5 system-ui}h1{font-size:26px}button{border:1px solid #bbb;background:white;border-radius:5px;padding:8px 12px}canvas{display:block;margin:12px 0;border:1px solid #ddd}iframe{border:1px solid #ddd;width:80%;height:130px}input{margin:8px}'); return; }
  if (req.url === '/image.svg') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="60" height="30"><rect width="60" height="30" fill="#39734f"/></svg>'); return; }
  if (req.url === '/frame') { res.end('<!doctype html><p>Embedded drawing</p><canvas id="nestedCanvas" width="160" height="35"></canvas><iframe src="/deep" height="40"></iframe><script>const c=document.querySelector("canvas").getContext("2d");c.fillStyle="#614f89";c.fillRect(0,0,160,35)</script>'); return; }
  if (req.url === '/deep') { res.end('<!doctype html><button id="deep">Nested control</button>'); return; }
  res.end(`<!doctype html><link rel="stylesheet" href="/style.css"><h1>Local recording review</h1><p>Record → interact → stop → replay.</p><button id="add">Add shape</button><p>Shapes: <span id="count">0</span></p><canvas id="drawing" width="400" height="80"></canvas><img src="/image.svg" width="60" height="30">
    <p><input id="typed" value="Initial text 123"><input id="number" type="number" step="any" value="12.5"><input id="password" type="password" value="private-password-initial"></p>
    <textarea id="multiline">Initial multiline</textarea><input id="cleared" value="Clear me"><div id="editable" contenteditable>Initial rich text</div>
    <div class="rr-mask"><input id="masked" value="private-masked-initial"><div id="maskedText" contenteditable>private-rich-initial</div></div><div data-private><input id="blocked" value="private-blocked-initial"></div>
    <iframe id="same" src="/frame"></iframe><iframe id="cross" src="${origin?.replace('127.0.0.1', 'localhost')}/deep"></iframe><script>window.clicks=0;const ctx=document.querySelector('#drawing').getContext('2d');ctx.fillStyle='#639b76';ctx.fillRect(10,10,80,60);document.querySelector('#add').onclick=()=>{document.querySelector('#count').textContent=++window.clicks;ctx.fillStyle='#ba8751';ctx.fillRect(110,10,80,60);};</script>`);
});

app.whenReady().then(async () => {
  let win;
  try {
    await new Promise(r => server.listen(0, '0.0.0.0', r));
    origin = `http://127.0.0.1:${server.address().port}`;
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1450, 940); win.showInactive();
    const wc = win.webContents;
    wc.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('Renderer:', ...args); });
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'app bridge');
    if (restoreRoot) {
      await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'restored Stage');
      const projects = await js(wc, 'window.engelbartAPI.listProjects()');
      const rows = await js(wc, `window.engelbartAPI.recordingList(${JSON.stringify(projects[0].id)})`);
      const library = await js(wc, 'window.engelbartAPI.library()');
      assert.equal(rows.length, 2);
      assert.ok(rows.every(recording => library.some(row => row.id === recording.libraryId)), 'every recording retains its library source after restart');
      await click(wc, '[aria-label="More"]'); await click(wc, '[data-recordings-browse]');
      await until(() => js(wc, 'document.querySelector(".recording-empty")?.textContent.includes("Open a website")'), 'blank Stage has no website recordings');
      assert.equal(await js(wc, 'document.querySelectorAll(".recording-row").length'), 0);
      await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(rows[0].url)}}}))`);
      await until(() => js(wc, 'document.querySelectorAll(".recording-row").length===1'), 'only restored website recordings');
      await click(wc, '.recording-row');
      await until(() => js(wc, `document.querySelector('[aria-label="Play recording"]') && !document.querySelector('[aria-label="Play recording"]').disabled`), 'playback after full restart');
      assert.equal(await js(wc, '!!document.querySelector(".recording-source")'), false);
      fs.writeFileSync(path.join(root, 'restored-recording.png'), (await wc.capturePage()).toPNG());
      console.log(JSON.stringify({ ok: true, root, checks: ['full Electron restart', 'recording library links', 'site-filtered recordings', 'offline playback after restart'] }));
      server.closeAllConnections(); server.close(); app.exit(0); return;
    }
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Recording review',directory:${JSON.stringify(root)}})`);
    const projectId = made.project.id;
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'Stage');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(origin)}}}))`);
    const view = await until(() => win.contentView.children.find(v => v.webContents?.getURL().startsWith(origin)), 'page');
    const page = view.webContents;
    page.on('preload-error', (_event, file, error) => console.error('Preload:', file, error));
    page.on('console-message', (_event, ...args) => { if (args[0] === 3) console.error('Page:', ...args); });
    await until(() => js(page, '!!document.querySelector("#add")').catch(() => false), 'fixture');
    await until(() => js(wc, '!!document.querySelector("[data-record-toggle]") && !document.querySelector("[data-record-toggle]").disabled'), 'record button');
    assert.equal(await js(wc, 'document.querySelector("[data-record-toggle]").textContent.trim()'), '', 'Record is icon-only');
    assert.equal(await js(wc, 'document.querySelector("[data-record-toggle]").getAttribute("aria-label")'), 'Record page');
    assert.equal(await js(wc, '!!document.querySelector("[data-record-toggle] svg circle")'), true, 'idle action uses a record-circle icon');
    assert.equal(await js(wc, 'document.querySelectorAll("[data-record-toggle] svg circle").length'), 1, 'same single outline circle as Engelbart Web');
    await click(wc, '[aria-label="More"]');
    await click(wc, '[data-preview-size]');
    const settings = await js(wc, 'document.querySelector("[data-recordings-browse]").closest("[data-overlay]").textContent');
    for (const control of ['Fit panel', 'iPhone SE', 'iPhone 12 Pro', 'iPhone 15 Pro Max', 'Pixel 8', 'iPad mini']) assert.ok(settings.includes(control), `${control} is available`);
    assert.ok(!settings.includes('Device preset'), 'device heading is removed');
    assert.ok(!settings.includes('Custom width'), 'custom-width row is removed');
    assert.equal(await js(wc, `!!document.querySelector('[aria-label="Custom width"]')`), false, 'custom-width input is removed');
    for (const action of ['Annotations', 'Recordings', 'Open in default browser', 'Developer tools']) assert.ok(settings.includes(action), `${action} remains available`);
    assert.equal(await js(wc, 'document.querySelector("[data-browser-slot]").style.width'), '100%', 'page continues to fit the panel');
    await pause(300);
    fs.writeFileSync(path.join(root, 'website-settings.png'), (await win.webContents.capturePage()).toPNG());
    const tabsBefore = await js(wc, '[...document.querySelectorAll("[data-stage-tab]")].map(el=>el.dataset.stageTab)');
    const beforeBounds = view.getBounds();
    assert.equal(await js(wc, '!!document.querySelector("[data-annotation-markers]")'), false, 'marker preference is removed');
    await click(wc, '[data-annotations-browse]');
    await until(() => js(wc, '!!document.querySelector(".ia-browser")'), 'annotations popover');
    const annotationBox = await js(wc, '(()=>{const p=document.querySelector(".ia-browser"),r=p.getBoundingClientRect(),s=getComputedStyle(p);return{left:r.left,top:r.top,width:r.width,padding:s.padding,borderRadius:s.borderRadius,maxHeight:s.maxHeight}})()');
    await click(wc, '[aria-label="Close annotations"]');
    await click(wc, '[aria-label="More"]'); await click(wc, '[data-recordings-browse]');
    await until(() => js(wc, '!!document.querySelector(".recordings-popover")'), 'Recordings opens from website settings');
    const recordingBox = await js(wc, '(()=>{const p=document.querySelector(".recordings-popover"),r=p.getBoundingClientRect(),s=getComputedStyle(p);return{left:r.left,top:r.top,width:r.width,padding:s.padding,borderRadius:s.borderRadius,maxHeight:s.maxHeight}})()');
    assert.deepEqual(recordingBox, annotationBox, 'recordings shares annotation placement and surface styles');
    assert.deepEqual(await js(wc, '[...document.querySelectorAll("[data-stage-tab]")].map(el=>el.dataset.stageTab)'), tabsBefore);
    assert.deepEqual(view.getBounds(), beforeBounds, 'floating list never resizes the website');
    await until(() => !view.getVisible(), 'popover hides native view');
    await until(() => js(wc, '!!document.querySelector("[data-browser-slot] img")'), 'page snapshot remains behind the list');
    wc.focus(); wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => js(wc, '!document.querySelector(".recordings-popover")'), 'Escape closes recordings');
    await until(() => view.getVisible(), 'dismissal restores native page');
    await click(wc, '[aria-label="More"]'); await click(wc, '[data-recordings-browse]');
    await until(() => js(wc, '!!document.querySelector(".recordings-popover")'), 'recordings reopened');
    await js(wc, 'document.querySelector("[data-browser-slot]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await until(() => js(wc, '!document.querySelector(".recordings-popover")'), 'outside press dismisses recordings');
    await click(wc, '[aria-label="More"]'); await click(wc, '[data-recordings-browse]');
    await click(wc, '[aria-label="Close recordings"]');
    await until(() => js(wc, '!document.querySelector("[data-recordings]")'), 'close returns to page');
    await click(wc, '[aria-label="More"]');
    console.log('PASS shared annotations/recordings popover, snapshot, full viewport, Escape/outside/close dismissal');
    await click(wc, '[data-preview-size]');
    await js(wc, `Array.from(document.querySelectorAll('[data-overlay] span')).find(el => el.textContent === 'iPhone 12 Pro').parentElement.click()`);
    await until(() => js(page, 'innerWidth === 390'), 'device preset resizes the live page');
    await click(wc, '[aria-label="More"]');
    await click(wc, '[data-preview-size]');
    await js(wc, `Array.from(document.querySelectorAll('[data-overlay] span')).find(el => el.textContent === 'Fit panel').parentElement.click()`);
    await until(() => js(page, 'innerWidth > 520'), 'fit panel restores the live page width');
    await click(wc, '[data-record-toggle]');
    const recording = await until(() => js(wc, 'window.engelbartAPI.recordingCurrent().then(r=>r?.status==="recording"&&r)'), 'recording acknowledgement');
    await until(() => js(wc, 'document.querySelector("[data-record-toggle]").getAttribute("aria-label")==="Stop recording"'), 'record icon becomes stop');
    assert.equal(await js(wc, 'document.querySelector("[data-record-toggle]").textContent.trim()'), '', 'active recording stays icon-only');
    assert.equal(await js(wc, '!!document.querySelector("[data-record-toggle] svg rect")'), true);
    assert.equal(await js(wc, 'document.querySelector("[data-record-toggle]").getAttribute("aria-pressed")'), 'true');
    assert.equal(await js(wc, 'document.querySelector("[data-record-toggle]").getBoundingClientRect().width'), 26, 'recording does not expand the toolbar');
    const recordPoint = await js(wc, '(()=>{const r=document.querySelector("[data-record-toggle]").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    wc.sendInputEvent({ type: 'mouseMove', ...recordPoint });
    await until(() => js(wc, '!!document.querySelector("[role=tooltip][data-overlay]")'), 'recording hover label');
    assert.match(await js(wc, 'document.querySelector("[role=tooltip][data-overlay]").textContent'), /Stop recording · \d+:\d{2}/, 'elapsed time remains in the hover label');
    wc.sendInputEvent({ type: 'mouseMove', x: recordPoint.x - 50, y: recordPoint.y });
    await until(() => js(wc, '!document.querySelector("[role=tooltip][data-overlay]")'), 'recording tooltip clears');
    assert.equal(await js(page, 'typeof window.engelbartAPI'), 'undefined');
    assert.equal(await js(page, 'typeof require'), 'undefined');
    await click(page, '#add');
    await editFields(page);
    // A password-reveal toggle must not turn a previously password field public.
    await js(page, 'document.getElementById("password").type = "text"');
    await pause(50);
    await js(page, '(()=>{const el=document.getElementById("password");el.value="private-password-revealed";el.dispatchEvent(new Event("input",{bubbles:true}))})()');
    await pause(900);
    fs.writeFileSync(path.join(root, 'recording.png'), (await win.webContents.capturePage()).toPNG());
    page.reload();
    await until(() => js(page, '!!document.querySelector("#add")').catch(() => false), 'page after reload');
    await pause(700);
    await click(page, '#add');
    await editFields(page);
    await pause(900);
    // A different Stage tab must not take over the recording.
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(origin + '/other')}}}))`);
    await pause(350);
    assert.equal((await js(wc, 'window.engelbartAPI.recordingCurrent()')).tabId, recording.tabId);
    await click(wc, '[data-record-toggle]');
    await until(() => js(wc, '!!document.querySelector(".recording-row")'), 'saved recordings');
    assert.equal(await js(wc, 'document.querySelector(".recordings-popover strong").textContent'), 'Recordings', 'heading has no count');
    assert.equal(await js(wc, 'document.querySelectorAll(".recording-row .recording-detail").length'), 1, 'row has only its website line, without bottom metadata');
    assert.ok(await js(wc, 'document.querySelector(".recording-row .recording-name").textContent.trim()'), 'recording title is preserved');
    assert.match(await js(wc, 'document.querySelector(".recording-row .recording-duration").textContent'), /^\d+:\d{2}$/, 'duration is preserved');
    assert.equal(await js(wc, 'document.querySelector(".recording-list").textContent.includes("Recordings stay on this computer")'), false, 'no explanatory footer in the recordings list');
    assert.equal(await js(wc, 'getComputedStyle(document.querySelector(".recording-row")).borderBottomWidth'), '0px', 'recording entries have no dividing lines');
    fs.writeFileSync(path.join(root, 'recordings.png'), (await win.webContents.capturePage()).toPNG());
    const data = await js(wc, `window.engelbartAPI.recordingRead(${JSON.stringify(projectId)},${JSON.stringify(recording.id)})`);
    assert.equal(data.metadata.status, 'saved');
    assert.ok(new Set(data.batches.map(b => b.documentId)).size >= 2, 'reload retains both document segments');
    assert.ok(data.batches.flatMap(b => b.events).filter(e => e.type === 2).length >= 2, 'new document gets its own full snapshot');
    assert.ok(data.batches.flatMap(b => b.canvas).length >= 4, 'top and nested drawings captured');
    assert.ok(data.batches.flatMap(b => b.assets).length, 'visual assets saved');
    const serialized = JSON.stringify(data);
    for (const privateValue of ['private-password-initial', 'private-password-edited', 'private-password-revealed', 'private-masked-initial', 'private-masked-edited', 'private-rich-initial', 'private-rich-edited', 'private-blocked-initial', 'private-blocked-edited']) {
      assert.ok(!serialized.includes(privateValue), `${privateValue} is not persisted`);
    }
    const inputEvents = data.batches.flatMap(b => b.events).filter(e => e.type === 3 && e.data.source === 5);
    assert.ok(inputEvents.some(e => e.data.text === 'Notes 123 café'), 'ordinary text edits are captured');
    assert.ok(inputEvents.some(e => e.data.text === '42.75'), 'number edits are captured');
    assert.ok(inputEvents.some(e => e.data.text === 'First line 123\nSecond line'), 'multiline edits are captured');
    assert.ok(data.metadata.warnings.some(w => /embedded frames/.test(w)), 'inaccessible frame is reported');
    const noActionsBeforePlayback = await js(page, 'window.clicks');
    const requestsBefore = requests;
    let replayRequests = 0;
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => { replayRequests++; callback({}); });
    await new Promise(r => server.close(r)); // Playback must work after the source is gone.
    await click(wc, '.recording-row');
    await until(() => js(wc, `!!document.querySelector('[aria-label="Play recording"]')&&!document.querySelector('[aria-label="Play recording"]').disabled`), 'replayer ready');
    assert.equal(page.isDestroyed(), false, 'opening replay does not tear down the live page');
    await click(wc, '[aria-label="Back to recordings"]');
    await until(() => js(wc, '!!document.querySelector(".recordings-popover") && !document.querySelector(".recording-screen")'), 'Back returns to compact list');
    win.setSize(980, 740); await pause(250);
    const narrow = await js(wc, '(()=>{const p=document.querySelector(".recordings-popover").getBoundingClientRect(),s=document.querySelector("[data-browser-slot]").getBoundingClientRect();return{inside:p.left>=s.left&&p.right<=s.right&&p.top>=s.top&&p.bottom<=s.bottom,width:p.width,height:p.height}})()');
    assert.ok(narrow.inside && narrow.width <= 300 && narrow.height <= 420, 'recordings stays within a narrow Stage');
    fs.writeFileSync(path.join(root, 'recordings-narrow.png'), (await wc.capturePage()).toPNG());
    win.setSize(1450, 940); await pause(250);
    await click(wc, '.recording-row');
    await until(() => js(wc, `!!document.querySelector('[aria-label="Play recording"]')&&!document.querySelector('[aria-label="Play recording"]').disabled`), 'replayer ready after Back');
    const replay = await until(() => wc.mainFrame.frames.find(f => f.url.includes('recording-player.html')), 'isolated replay frame');
    assert.equal(await replay.executeJavaScript('typeof window.engelbartAPI'), 'undefined');
    assert.equal(await replay.executeJavaScript('!!document.querySelector(".replayer-wrapper iframe")'), true);
    assert.equal(await replay.executeJavaScript('document.querySelector(".replayer-wrapper iframe").getAttribute("sandbox").includes("allow-scripts")'), false);
    assert.match(await replay.executeJavaScript('document.querySelector(".replayer-wrapper iframe").contentDocument.body.textContent'), /Local recording review/);
    assert.equal(await replay.executeJavaScript('(()=>{const f=document.querySelector(".replayer-wrapper iframe");return f.contentWindow.getComputedStyle(f.contentDocument.body).backgroundColor})()'), 'rgb(248, 248, 247)', 'stylesheet survives offline');
    assert.ok(await replay.executeJavaScript('document.querySelector(".replayer-wrapper iframe").contentDocument.querySelector("img").src.startsWith("data:image/")'), 'image bytes survive offline');
    assert.deepEqual(await replayFields(replay), { text: 'Initial text 123', number: '12.5', multiline: 'Initial multiline', cleared: 'Clear me', editable: 'Initial rich text', password: '•••', masked: '•••' }, 'initial snapshot preserves ordinary input and masks private fields');
    await click(wc, '[aria-label="Play recording"]'); await pause(500);
    await click(wc, '[aria-label="Pause recording"]');
    const seekPoint = await js(wc, `(()=>{const r=document.querySelector('[aria-label="Position in recording"]').getBoundingClientRect();return{x:Math.round(r.right-3),y:Math.round(r.y+r.height/2)}})()`);
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...seekPoint });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...seekPoint });
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...seekPoint });
    wc.debugger.detach();
    await pause(350);
    const seekState = await js(wc, `(()=>{const e=document.querySelector('[aria-label="Position in recording"]');return {value:Number(e.value),max:Number(e.max)}})()`);
    assert.ok(seekState.value > seekState.max - 250, `scrubbing keeps the selected paused position: ${JSON.stringify(seekState)}`);
    assert.deepEqual(await replayFields(replay), { text: 'Notes 123 café', number: '42.75', multiline: 'First line 123\nSecond line', cleared: '', editable: 'Edited rich text 456', password: '•••', masked: '•••' }, 'edited inputs replay exactly, including numbers, newlines and cleared fields');
    assert.ok(await replay.executeJavaScript('document.querySelector(".replayer-wrapper iframe").contentDocument.querySelectorAll("img[data-engelbart-frame]").length'), 'canvas bitmaps appear in playback');
    assert.equal(requests, requestsBefore, 'playback made no requests to the source');
    assert.equal(replayRequests, 0, 'replay attempted no network access');
    fs.writeFileSync(path.join(root, 'playback.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(980, 740); await pause(350);
    fs.writeFileSync(path.join(root, 'playback-narrow.png'), (await win.webContents.capturePage()).toPNG());
    await click(wc, '[aria-label="Return to page"]');
    assert.equal(await js(page, 'window.clicks'), noActionsBeforePlayback, 'playback never re-executed app actions');
    // Explicit tab close flushes the final batch before destroying its view.
    await new Promise(r => server.listen(0, '0.0.0.0', r));
    const nextOrigin = `http://127.0.0.1:${server.address().port}`;
    origin = nextOrigin;
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(nextOrigin)}}}))`);
    await until(() => win.contentView.children.find(v => v.webContents?.getURL().startsWith(nextOrigin) && !v.webContents.isLoading()), 'next page loaded');
    await until(() => js(wc, '!!document.querySelector("[data-record-toggle]")&&!document.querySelector("[data-record-toggle]").disabled'), 'next record button');
    await click(wc, '[data-record-toggle]');
    const closing = await until(() => js(wc, 'window.engelbartAPI.recordingCurrent().then(r=>r?.status==="recording"&&r)'), 'recording to close');
    await pause(400);
    await click(wc, `[data-stage-tab="${closing.tabId}"] [aria-label="Close tab"]`);
    await until(() => js(wc, 'window.engelbartAPI.recordingCurrent().then(r=>!r)'), 'tab close flush');
    const closed = await js(wc, `window.engelbartAPI.recordingRead(${JSON.stringify(projectId)},${JSON.stringify(closing.id)})`);
    assert.equal(closed.metadata.status, 'saved');
    assert.equal(closed.batches.at(-1).end, 'stop');
    // Both sites retain their captures, but each Stage tab sees only its own.
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(nextOrigin)}}}))`);
    await click(wc, '[aria-label="More"]'); await click(wc, '[data-recordings-browse]');
    await until(() => js(wc, 'document.querySelectorAll(".recording-row").length===1'), 'only second site recording');
    assert.equal(await js(wc, 'document.querySelector(".recording-row .recording-detail").title'), closed.metadata.url);
    await click(wc, '.recording-row');
    await until(() => js(wc, '!!document.querySelector(".recording-screen iframe")'), 'second site replay');
    await js(wc, `document.querySelector('[data-stage-tab="${recording.tabId}"] > div').dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`);
    await until(() => js(wc, 'document.querySelectorAll(".recording-row").length===1 && !document.querySelector(".recording-screen")'), 'tab switch clears playback and shows first site list');
    assert.equal(await js(wc, 'document.querySelector(".recording-row .recording-detail").title'), data.metadata.url);
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(nextOrigin.replace('127.0.0.1', 'localhost'))}}}))`);
    await until(() => js(wc, 'document.querySelector(".recording-empty")?.textContent.includes("No recordings for this website")'), 'unrecorded website has an empty collection');
    assert.equal(await js(wc, 'document.querySelectorAll(".recording-row").length'), 0);
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'reloaded test app');
    const rows = await js(wc, `window.engelbartAPI.recordingList(${JSON.stringify(projectId)})`);
    assert.equal(rows.length, 2, 'filtering did not delete recordings');
    assert.ok(rows.some(r => r.id === recording.id && r.status === 'saved'));
    await click(wc, '[aria-label="More"]'); await click(wc, '[data-recordings-browse]');
    await until(() => js(wc, 'document.querySelector(".recording-empty")?.textContent.includes("Open a website")'), 'blank Stage has no website recordings');
    assert.equal(await js(wc, 'document.querySelectorAll(".recording-row").length'), 0);
    console.log('PASS site-filtered recordings, tab switching, cleared playback, empty website and blank Stage');
    console.log(JSON.stringify({ ok: true, root, recording: data.metadata, batches: data.batches.length }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    console.error('Artifacts:', root);
    server.close(); app.exit(1);
  }
});
