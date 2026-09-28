'use strict';
// Real Electron + local fixtures only; never uses the person's tabs or data.
const { app, BrowserWindow, nativeImage, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-favicons-smoke-'));
app.setPath('userData', path.join(root, 'electron'));
Object.assign(process.env, { ENGELBART_HOME_DIR: root, ENGELBART_SUMMARIES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_BART_FAKE: '1', ENGELBART_HEADLESS: '1' });
const events = [];
app.on('web-contents-created', (_event, contents) => {
  for (const name of ['did-start-navigation', 'did-navigate', 'did-stop-loading', 'page-favicon-updated']) contents.on(name, (_e, ...args) => {
    if (/^https?:/.test(contents.getURL())) events.push({ name, url: contents.getURL(), args });
  });
});
require('../src/main/index.cjs');
const pause = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
const js = (wc, source) => wc.executeJavaScript(source, true);
async function until(check, name) {
  for (let i = 0; i < 160; i++) { const result = await check(); if (result) return result; await pause(75); }
  throw new Error(`Timed out: ${name}`);
}
const png = nativeImage.createFromBitmap(Buffer.from(Array(16 * 16).fill([64, 150, 65, 255]).flat()), { width: 16, height: 16 }).toPNG();
const directory = Buffer.alloc(22);
directory.writeUInt16LE(1, 2); directory.writeUInt16LE(1, 4); directory[6] = 16; directory[7] = 16;
directory.writeUInt16LE(1, 10); directory.writeUInt16LE(32, 12); directory.writeUInt32LE(png.length, 14); directory.writeUInt32LE(22, 18);
const ico = Buffer.concat([directory, png]);
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect x="2" y="2" width="28" height="28" rx="6" fill="#315dbe"/></svg>';
const slow = [], requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/icon.svg') { res.setHeader('content-type', 'image/svg+xml'); res.end(svg); return; }
  if (req.url === '/icon.png') { res.setHeader('content-type', 'image/png'); res.end(png); return; }
  if (req.url === '/icon.ico') { res.setHeader('content-type', 'image/x-icon'); res.end(ico); return; }
  if (req.url === '/bad.png') { res.setHeader('content-type', 'image/png'); res.end('not an image'); return; }
  if (req.url === '/slow.svg') { slow.push(() => { res.setHeader('content-type', 'image/svg+xml'); res.end(svg); }); return; }
  if (req.url === '/favicon.ico') { res.statusCode = 404; res.end(); return; }
  const icon = { '/svg': '/icon.svg', '/png': '/icon.png', '/ico': '/icon.ico', '/broken': '/bad.png', '/slow': '/slow.svg' }[req.url];
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>${req.url.slice(1) || 'none'} favicon</title>${icon ? `<link rel="icon" href="${icon}">` : ''}<h1>Favicon check</h1><p>${req.url}</p>`);
});

app.whenReady().then(async () => {
  let win;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    // .app enforces HTTPS. Serve this hostname inside the isolated test session;
    // no real E2B sandbox, certificate override, or external network is needed.
    await session.fromPartition('persist:browser').protocol.handle('https', request => {
      const url = new URL(request.url);
      if (url.hostname !== 'canvas-favicon.e2b.app') return new Response(null, { status: 404 });
      return new Response(`<!doctype html><title>E2B preview</title><link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}"><h1>E2B fallback check</h1>`, { headers: { 'content-type': 'text/html' } });
    });
    win = await until(() => BrowserWindow.getAllWindows()[0], 'window');
    win.setFocusable(false); win.setSize(1450, 940); win.showInactive();
    const wc = win.webContents;
    await until(() => js(wc, '!!window.engelbartAPI').catch(() => false), 'app bridge');
    await js(wc, `window.engelbartAPI.createProjectWithWelcome({name:'Favicons',directory:${JSON.stringify(root)}})`);
    wc.reload();
    await until(() => js(wc, '!!document.querySelector("[data-stage]")').catch(() => false), 'Stage');
    await js(wc, 'window.__states={};window.engelbartAPI.onBrowserState(s=>window.__states[s.id]=s);true');
    const open = async url => {
      await js(wc, `window.dispatchEvent(new CustomEvent('engelbart:open-in-browser',{detail:{url:${JSON.stringify(url)}}}))`);
      return until(() => js(wc, `Object.values(window.__states).find(s=>s.url===${JSON.stringify(url)}&&!s.loading)`), `load ${url}`);
    };
    const icon = id => js(wc, `(()=>{const img=document.querySelector('[data-stage-tab="${id}"] [data-stage-favicon]');return img&&img.complete&&img.naturalWidth>0?img.src:null})()`);
    const navigate = async (id, url) => {
      await js(wc, `window.engelbartAPI.browserOpen(${JSON.stringify(id)},${JSON.stringify(url)})`);
      await until(() => js(wc, `window.__states[${JSON.stringify(id)}]?.url===${JSON.stringify(url)}&&!window.__states[${JSON.stringify(id)}].loading`), 'navigation');
    };

    const a = await open(origin + '/svg');
    assert.match(await until(() => icon(a.id), 'SVG favicon'), /^data:image\/svg\+xml/);
    const view = win.contentView.children.find(v => v.webContents?.getURL() === origin + '/svg');
    await js(view.webContents, 'document.querySelector("link").href="/icon.png"');
    await until(async () => (await icon(a.id))?.startsWith('data:image/png'), 'dynamic favicon update');

    await navigate(a.id, origin + '/none'); await pause(500);
    assert.equal(await icon(a.id), null, 'site without a favicon keeps the globe, not the previous image');
    await navigate(a.id, origin + '/broken');
    await until(() => js(wc, `!!window.__states[${JSON.stringify(a.id)}]?.favicon`), 'broken bytes reached the tab');
    await pause(250);
    assert.equal(await js(wc, `!!document.querySelector('[data-stage-tab="${a.id}"] [data-stage-favicon]')`), false, 'bad images fall back without a broken-image glyph');
    assert.ok(await js(wc, `!!document.querySelector('[data-stage-tab="${a.id}"] svg')`), 'fallback glyph is visible');

    await navigate(a.id, origin + '/slow');
    await until(() => slow.length, 'delayed icon request');
    await navigate(a.id, origin + '/none');
    for (const reply of slow.splice(0)) reply();
    await pause(400);
    assert.equal(await icon(a.id), null, 'late old-page favicon cannot reappear');
    await navigate(a.id, origin + '/ico');
    assert.match(await until(() => icon(a.id), 'ICO favicon'), /^data:image\/x-icon/);
    await js(wc, `window.engelbartAPI.browserCommand(${JSON.stringify(a.id)},'reload')`);
    await pause(200);
    await until(() => icon(a.id), 'favicon after reload');

    const b = await open(origin + '/png');
    assert.match(await until(() => icon(b.id), 'PNG favicon'), /^data:image\/png/);
    const c = await open('https://canvas-favicon.e2b.app/svg');
    assert.equal(c.error, null);
    await pause(500);
    assert.equal(await icon(c.id), null, 'E2B preview stays on the globe despite having a favicon');
    assert.equal(await js(wc, `window.__states[${JSON.stringify(c.id)}].favicon`), null);
    assert.ok(await icon(a.id), 'background tab keeps its own favicon');
    assert.ok(await icon(b.id), 'second background tab keeps its own favicon');
    fs.writeFileSync(path.join(root, 'favicons.png'), (await wc.capturePage()).toPNG());
    console.log(JSON.stringify({ ok: true, root, requests: requests.length, checks: ['SVG/PNG/ICO', 'dynamic icon', 'missing/broken fallback', 'navigation clears old icon', 'late response ignored', 'reload', 'E2B fallback', 'background tabs'] }));
    server.closeAllConnections(); server.close(); app.exit(0);
  } catch (error) {
    console.error(error); console.error('Artifacts:', root);
    fs.writeFileSync(path.join(root, 'events.json'), JSON.stringify({ events, requests }, null, 2));
    if (win) fs.writeFileSync(path.join(root, 'failure.png'), (await win.webContents.capturePage()).toPNG());
    server.closeAllConnections(); server.close(); app.exit(1);
  }
});
