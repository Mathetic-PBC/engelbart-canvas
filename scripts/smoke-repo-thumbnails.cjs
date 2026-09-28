'use strict';
// Actual Canvas + local preview, isolated home. No real worker, agent, or E2B call.
const { app, BrowserWindow, nativeImage, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID, createHash } = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-repo-thumbnails-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1' });
const manager = require('../src/main/sandbox/manager.cjs'), original = manager.createSandboxManager;
manager.createSandboxManager = options => original({ ...options, readEnv: () => ({}), launch(request, _env, emit) {
  assert.equal(request.command, 'probe', 'test must never build or stop a real sandbox');
  return { done: Promise.resolve().then(() => emit({ event: 'result', state: 'ready' })) };
} });
const thumbnailReads = [];
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, channel === 'engelbart:repo-thumbnail'
  ? (...args) => { thumbnailReads.push(args[1]); return listener(...args); } : listener);
require('../src/main/index.cjs');
const db = require('../src/main/store/db.cjs');
const projects = require('../src/main/store/projects.cjs');
const thumbnails = require('../src/main/store/repo-thumbnails.cjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = (wc, code) => wc.executeJavaScript(code, true);
async function until(check, name) {
  for (let i = 0; i < 160; i++) { const result = await check(); if (result) return result; await pause(75); }
  throw Error(`Timed out: ${name}`);
}
let requests = 0;
const server = http.createServer((req, res) => {
  requests++;
  if (req.url === '/favicon.ico') { res.writeHead(404).end(); return; }
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Research board</title><style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6f3;color:#23342b;font:15px/1.5 system-ui}
    header{background:#e4ede6;padding:24px 28px;border-bottom:1px solid #d3ded5}small{letter-spacing:2px;font-size:10px}
    h1{font-size:27px;font-weight:600;margin:8px 0}p{color:#65786b;margin:0}main{padding:24px}
    article{margin-bottom:16px;background:white;border:1px solid #dce5de;border-radius:8px;padding:18px}
    h2{margin:0 0 10px;font-size:17px}.line{height:7px;background:#edf1ed;border-radius:4px;margin:10px 0;width:80%}
    button{background:#436e53;color:white;border:0;border-radius:5px;padding:8px 13px}</style>
    <header><small>WORKSPACE</small><h1>Research board</h1><p>Your ideas, in one place.</p></header><main>
    <article><h2>Today's notes</h2><p>Explore, collect, and connect.</p><div class="line"></div><div class="line" style="width:56%"></div></article>
    <article><h2>In progress</h2><p>A place to develop your next idea.</p><div class="line"></div><button>New note</button></article></main>`);
});

app.whenReady().then(async () => {
  let win;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1450, 940); win.showInactive();
    const wc = win.webContents;
    wc.setBackgroundThrottling(false);
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'bridge');
    const made = await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Thumbnail review',directory:${JSON.stringify(root)}})`);
    const config = await js(wc, 'window.engelbartAPI.config()');
    const libraryDb = await db.openLibraryDb(config.dataRoot);
    const ctx = { homeDir: root, root: config.home, dataRoot: config.dataRoot, libraryDb };
    const repo = await libraryDb.insert({ id: randomUUID(), name: 'example/research-board', type: 'website', tags: ['git'], url: 'https://github.com/example/research-board' });
    const empty = await libraryDb.insert({ id: randomUUID(), name: 'example/not-opened', type: 'website', tags: ['git'], url: 'https://github.com/example/not-opened' });
    const runId = randomUUID();
    await libraryDb.query("insert into sandbox_runs (id, library_id, status, preview_url) values ($1,$2,'ready',$3),($4,$5,'ready',$6)", [runId, repo.id, url, randomUUID(), empty.id, 'https://unused-thumbnail.e2b.app/']);
    await projects.linkToWorkspace(ctx, made.project.id, made.workspaceId, [repo.id, empty.id]);
    wc.reload();
    const row = `[data-rail-row="${repo.id}"]`, emptyRow = `[data-rail-row="${empty.id}"]`;
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(row)})`).catch(() => false), 'repo in sidebar');
    const expand = () => js(wc, `(()=>{const b=document.querySelector('[data-rail-section="GitHub"] button');if(b.getAttribute('aria-expanded')!=='true')b.click()})()`);
    await expand();
    await pause(1500);
    assert.equal((await libraryDb.get(repo.id)).thumbnail_path, null, 'ready alone does not launch a hidden capture');
    await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(url)}}}))`);
    const saved = await until(async () => { const r = await libraryDb.get(repo.id); return r.thumbnail_path && r; }, 'automatic first-visit capture');
    assert.equal(saved.thumbnail_run_id, runId); assert.equal(saved.url, repo.url); assert.equal(saved.last_edited, repo.last_edited);
    const file = path.join(config.dataRoot, saved.thumbnail_path), photo = nativeImage.createFromPath(file);
    assert.equal(photo.isEmpty(), false);
    assert.ok(photo.getSize().width <= 640 && photo.getSize().height <= 480);
    fs.copyFileSync(file, path.join(root, 'captured-viewport.jpg'));
    const hash = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const page = win.contentView.children.find(view => view.webContents?.getURL() === url).webContents;
    await js(page, 'document.querySelector("h1").textContent="Edited after capture"');
    await pause(4500);
    assert.equal((await libraryDb.get(repo.id)).thumbnail_captured_at, saved.thumbnail_captured_at, 'later user activity is not recaptured');
    assert.equal(createHash('sha256').update(fs.readFileSync(file)).digest('hex'), hash);
    const hover = async selector => {
      const rect = await js(wc, `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+80),y:Math.round(r.top+r.height/2)}})()`);
      wc.sendInputEvent({ type: 'mouseMove', ...rect });
    };
    const imageReady = id => js(wc, `(()=>{const i=document.querySelector('[data-repo-thumbnail="${id}"] img');return i&&i.complete&&i.naturalWidth>0})()`);
    const geometry = () => js(wc, `(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();const img=document.querySelector('[data-repo-thumbnail] img');return {
      frame:rect('[data-repo-thumbnail]'),row:rect(${JSON.stringify(row)}),sidebar:rect('aside[aria-label="Sidebar"]'),
      fit:getComputedStyle(img).objectFit,position:getComputedStyle(img).objectPosition,view:{width:innerWidth,height:innerHeight}
    }})()`);
    const checkFrame = layout => {
      assert.equal(layout.frame.width, 320); assert.equal(layout.frame.height, 210);
      assert.equal(layout.frame.left, layout.sidebar.right + 8, 'frame stays beside the sidebar across its hoverable gap');
      assert.equal(layout.frame.top, Math.max(8, Math.min(layout.row.top, layout.view.height - 218)), 'row-aligned unless clamped at the viewport edge');
      assert.ok(layout.frame.right <= layout.view.width - 8 && layout.frame.bottom <= layout.view.height - 8);
      assert.equal(layout.fit, 'cover'); assert.equal(layout.position, '50% 0%');
    };
    await hover(row);
    await until(() => imageReady(repo.id), 'hover image');
    const source = await js(wc, `document.querySelector('[data-repo-thumbnail="${repo.id}"] img').src`);
    assert.equal(createHash('sha256').update(Buffer.from(source.split(',')[1], 'base64')).digest('hex'), hash);
    assert.equal(await js(wc, `document.querySelector('[data-rail-peek]').innerText.trim()`), '', 'repository hover contains only the saved image, not the old metadata card');
    checkFrame(await geometry());
    assert.equal(thumbnailReads.filter(id => id === repo.id).length, 1, 'prefetch and visible frame share one read');
    fs.writeFileSync(path.join(root, 'hover.png'), (await wc.capturePage()).toPNG());
    // Moving into the preview across the gap must not dismiss it.
    const frame = (await geometry()).frame;
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(frame.left - 4), y: Math.round(frame.top + 12) });
    await pause(250);
    assert.equal(await imageReady(repo.id), true);
    wc.sendInputEvent({ type: 'mouseMove', x: Math.round(frame.left + 30), y: Math.round(frame.top + 30) });
    await pause(250);
    assert.equal(await imageReady(repo.id), true);
    await hover(emptyRow); await pause(500);
    assert.equal(await js(wc, '!!document.querySelector("[data-repo-thumbnail]")'), false, 'no image means no empty card');
    assert.equal(await js(wc, '!!document.querySelector("[data-rail-peek]")'), false, 'a repository with no saved image has no metadata fallback');
    assert.equal((await libraryDb.get(empty.id)).thumbnail_path, null);
    const beforeHover = requests;
    await hover(row); await pause(500);
    assert.equal(requests, beforeHover, 'hover reads only the saved local file');
    assert.equal(thumbnailReads.filter(id => id === repo.id).length, 1, 'repeat hover reuses the cached image without IPC');
    assert.equal(thumbnailReads.includes(empty.id), false, 'no saved path means no image request');

    // Exercise live positioning without a second mouse-enter or a renderer reload.
    await js(wc, `document.querySelector('aside[aria-label="Sidebar"]').style.width='250px'`);
    await until(async () => (await geometry()).frame.left === 258, 'sidebar resize updates the anchor');
    checkFrame(await geometry());
    await js(wc, `document.querySelector('aside[aria-label="Sidebar"]').style.width='300px'`);
    await until(async () => (await geometry()).frame.left === 308, 'sidebar width restored');
    await js(wc, `document.querySelector('[data-rail-section="GitHub"]').style.marginTop='96px'`);
    win.setSize(1080, 640);
    await until(async () => { const layout = await geometry(); return layout.view.height < 700 && layout.frame.top === layout.view.height - 218; }, 'shorter window and repositioned frame');
    checkFrame(await geometry());
    assert.ok((await geometry()).frame.top < (await geometry()).row.top, 'low row actually exercises the bottom-edge clamp');
    fs.writeFileSync(path.join(root, 'edge-hover.png'), (await wc.capturePage()).toPNG());
    await js(wc, `document.querySelector('[data-rail-section="GitHub"]').style.marginTop=''`);
    win.setSize(1450, 940);
    await until(async () => { const layout = await geometry(); return layout.view.height > 700 && layout.frame.top === layout.row.top; }, 'window and row alignment restored');

    // A later captured path must replace the cached source while still hovering.
    // This landscape fixture uses the top of our local test page, not real user data.
    await libraryDb.query("update sandbox_runs set status='stopped' where id=$1", [runId]);
    const nextRun = randomUUID(), fixtureUrl = 'https://replacement-thumbnail.e2b.app/';
    await libraryDb.query("insert into sandbox_runs (id, library_id, status, preview_url) values ($1,$2,'ready',$3)", [nextRun, repo.id, fixtureUrl]);
    const landscape = photo.crop({ x: 0, y: 0, width: photo.getSize().width, height: Math.round(photo.getSize().width * 210 / 320) }).toJPEG(70);
    const replacement = await thumbnails.save(ctx, await thumbnails.target(ctx, fixtureUrl), landscape);
    wc.send('engelbart:library-changed', {});
    await until(async () => await js(wc, `document.querySelector('[data-repo-thumbnail="${repo.id}"] img')?.src`) !== source && await imageReady(repo.id), 'new thumbnail replaces the cached version');
    checkFrame(await geometry());
    assert.equal(thumbnailReads.filter(id => id === repo.id).length, 2, 'new path reads exactly once');
    const replacementSource = await js(wc, `document.querySelector('[data-repo-thumbnail="${repo.id}"] img').src`);
    assert.equal(createHash('sha256').update(Buffer.from(replacementSource.split(',')[1], 'base64')).digest('hex'), createHash('sha256').update(landscape).digest('hex'));
    fs.writeFileSync(path.join(root, 'landscape-hover.png'), (await wc.capturePage()).toPNG());
    await hover(emptyRow); await pause(250); await hover(row);
    await until(() => imageReady(repo.id), 'cached replacement');
    assert.equal(thumbnailReads.filter(id => id === repo.id).length, 2);
    await libraryDb.query("update sandbox_runs set status='stopped' where id=$1", [nextRun]);
    server.closeAllConnections(); server.close();
    wc.reload();
    await until(() => js(wc, `!!document.querySelector(${JSON.stringify(row)})`).catch(() => false), 'sidebar after renderer restart');
    await expand(); await hover(row);
    await until(() => imageReady(repo.id), 'persisted offline thumbnail');
    checkFrame(await geometry());
    assert.equal((await libraryDb.get(repo.id)).thumbnail_path, replacement.thumbnail_path);
    fs.writeFileSync(path.join(root, 'offline-hover.png'), (await wc.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, root, thumbnail: replacement.thumbnail_path, size: photo.getSize(), checks: ['no capture before Stage visit', 'automatic viewport capture', 'library reference', 'bounded image', 'once per run', 'fixed frame for portrait and landscape images', 'row-aligned hover', 'hoverable gap', 'cached reads', 'cache invalidation', 'sidebar and window resize', 'viewport edge clamp', 'missing image', 'offline after stop and renderer reload'] }));
    app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    if (win) fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
});
