'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const { parseBrowserUrl, isLoopback, boundsFrom, pdfAddress, pdfAsDownload, pdfName, createBrowserViews } = require('../src/main/browser/views.cjs');
const { cleanUserAgent, installBrowserUserAgent } = require('../src/main/browser/user-agent.cjs');

const address = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/address.js')).href);

test('addresses: local servers get http, the web gets https', async () => {
  const { kindOf } = await address();
  assert.deepEqual(kindOf(''), { kind: 'blank' });
  assert.deepEqual(kindOf('apple.com'), { kind: 'web', url: 'https://apple.com' });
  assert.deepEqual(kindOf('http://example.com/a'), { kind: 'web', url: 'http://example.com/a' });
  assert.deepEqual(kindOf('localhost:3000'), { kind: 'local', url: 'http://localhost:3000' });
  assert.deepEqual(kindOf('https://localhost:8443/x'), { kind: 'local', url: 'https://localhost:8443/x' });
  assert.deepEqual(kindOf('3000'), { kind: 'local', url: 'http://localhost:3000' });
  assert.deepEqual(kindOf(':5173/docs'), { kind: 'local', url: 'http://localhost:5173/docs' });
  assert.deepEqual(kindOf('0.0.0.0:8000/api'), { kind: 'local', url: 'http://localhost:8000/api' });
  assert.deepEqual(kindOf('127.0.0.1:8080'), { kind: 'local', url: 'http://127.0.0.1:8080' });
  assert.deepEqual(kindOf('[::1]:3000'), { kind: 'local', url: 'http://[::1]:3000' });
  assert.deepEqual(kindOf('192.168.1.20:3000'), { kind: 'local', url: 'http://192.168.1.20:3000' });
  assert.deepEqual(kindOf('app.localhost:3000'), { kind: 'local', url: 'http://app.localhost:3000' });
  assert.deepEqual(kindOf('printer.local'), { kind: 'local', url: 'http://printer.local' });
  assert.deepEqual(kindOf('devbox:8080'), { kind: 'local', url: 'http://devbox:8080' });
  assert.equal(kindOf('172.32.0.1').kind, 'web');
  assert.deepEqual(kindOf('./notes.md'), { kind: 'file', path: './notes.md' });
  assert.deepEqual(kindOf('sandbox:demo'), { kind: 'sandbox', name: 'demo' });
  assert.deepEqual(kindOf('file:///Users/h/a%20b.html#top'), { kind: 'disk', url: 'file:///Users/h/a%20b.html#top' });
});

test('addresses: words that are not an address are a Google search', async () => {
  const { kindOf, stripScheme } = await address();
  const search = (q) => ({ kind: 'web', url: `https://www.google.com/search?q=${q}` });
  assert.deepEqual(kindOf('transformers'), search('transformers'));
  assert.deepEqual(kindOf('how do birds fly'), search('how%20do%20birds%20fly'));
  assert.deepEqual(kindOf('what is apple.com'), search('what%20is%20apple.com'));
  assert.deepEqual(kindOf('c++ & rust?'), search('c%2B%2B%20%26%20rust%3F'));
  assert.deepEqual(kindOf('e.g.'), search('e.g.'));
  assert.deepEqual(kindOf('foo:bar'), search('foo%3Abar'));
  assert.deepEqual(kindOf('http://intranet'), { kind: 'web', url: 'http://intranet' }); // a scheme says address
  assert.equal(kindOf('apple.com/mac?x=1').url, 'https://apple.com/mac?x=1');
  assert.equal(kindOf('8.8.8.8').url, 'https://8.8.8.8');
  assert.equal(kindOf('xn--bcher-kva.example').url, 'https://xn--bcher-kva.example');
  assert.equal(stripScheme(kindOf('how do birds fly').url), 'www.google.com/search?q=how%20do%20birds%20fly');
});

test('addresses: the scheme is hidden only when typing the rest leads back to the same place', async () => {
  const { stripScheme } = await address();
  assert.equal(stripScheme('https://www.apple.com/'), 'www.apple.com');
  assert.equal(stripScheme('http://localhost:3000/'), 'localhost:3000');
  assert.equal(stripScheme('http://example.com/'), 'http://example.com/');
  assert.equal(stripScheme('https://localhost:8443/'), 'https://localhost:8443/');
  assert.equal(stripScheme('about:blank'), '');
  assert.equal(stripScheme('file:///Users/h/a%20b.html#top'), '/Users/h/a b.html#top'); // a page on disk reads as its path
});

test('main accepts http and https only', () => {
  assert.equal(parseBrowserUrl('http://0.0.0.0:3000/a').href, 'http://localhost:3000/a');
  assert.equal(parseBrowserUrl('https://www.apple.com').href, 'https://www.apple.com/');
  for (const bad of ['file:///etc/passwd', 'engelbart://app/index.html', 'javascript:alert(1)', 'chrome://gpu', '', 42]) {
    assert.throws(() => parseBrowserUrl(bad), TypeError);
  }
});

test('loopback, user agent and bounds helpers', () => {
  for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.8.9.1', '[::1]']) assert.equal(isLoopback(host), true, host);
  for (const host of ['192.168.1.2', 'localhost.evil.com', 'example.com', '']) assert.equal(isLoopback(host), false, host);
  assert.equal(
    cleanUserAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Engelbart/0.1.0 Chrome/150.0.0.0 Electron/44.4.1 Safari/537.36', 'Engelbart'),
    'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  );
  assert.deepEqual(boundsFrom({ x: 10.4, y: 20.6, width: 300.2, height: 0 }, 1.25), { x: 13, y: 26, width: 375, height: 1 });
  assert.throws(() => boundsFrom({ x: NaN, y: 0, width: 1, height: 1 }, 1), TypeError);
});

test('browser identity retains the native Chromium version and platform across startup', () => {
  const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7339.8 Safari/537.36';
  const app = { userAgentFallback: `${chrome} Engelbart.Test/0.1.0 Electron/44.4.1`, getName: () => 'Engelbart.Test' };
  installBrowserUserAgent(app);
  assert.equal(app.userAgentFallback, chrome);
  installBrowserUserAgent(app);
  assert.equal(app.userAgentFallback, chrome);
  assert.equal(cleanUserAgent(`${chrome} EngelbartXTest/1.0`, app.getName()), `${chrome} EngelbartXTest/1.0`);
});

function fakeElectron() {
  const made = [];
  class WebContentsView {
    constructor(options) {
      this.options = options;
      this.visible = true;
      this.bounds = null;
      const contents = options.webContents || new EventEmitter();
      Object.assign(contents, {
        loaded: [], closed: false, url: '', session: browsing,
        loadURL(url) { this.loaded.push(url); this.url = url; return Promise.resolve(); },
        getURL() { return this.url; }, getTitle: () => 'Title', isLoading: () => false, isDestroyed() { return this.closed; },
        close() { this.closed = true; }, reload() { this.reloaded = (this.reloaded || 0) + 1; }, stop() {},
        finds: [], findInPage(text, options) { this.finds.push([text, options]); return this.finds.length; }, stopFindInPage(action) { this.finds.push(['stop', action]); },
        focused: false, isFocused() { return this.focused; },
        setWindowOpenHandler(handler) { this.windowOpen = handler; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack() {}, goForward() {} },
      });
      this.webContents = contents;
      made.push(this);
    }
    setBackgroundColor() {}
    setVisible(value) { this.visible = value; }
    getVisible() { return this.visible; }
    setBounds(bounds) { this.bounds = bounds; }
  }
  const browsing = {
    flushed: 0, cookies: { on() {}, flushStore: async () => { browsing.flushed += 1; } }, ua: 'X Electron/44.4.1 Y', setUserAgent(value) { this.ua = value; }, getUserAgent() { return this.ua; }, setPermissionRequestHandler(handler) { this.permission = handler; },
    webRequest: { onHeadersReceived(filter, handler) { browsing.headersFilter = filter; browsing.headers = handler; } },
    on(name, handler) { browsing[name] = handler; },
  };
  const children = [];
  const questions = [];
  const handed = [];
  const dialog = { answer: 1, showMessageBox: async (_win, options) => { questions.push(options.message); return { response: dialog.answer }; } };
  const shell = { openExternal: async (url) => { handed.push(url); } };
  const win = {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 2, focus() { win.focused = (win.focused || 0) + 1; } },
    contentView: { addChildView: (view) => children.push(view), removeChildView: (view) => children.splice(children.indexOf(view), 1) },
  };
  return { made, browsing, children, win, dialog, questions, handed, electron: { WebContentsView, session: { fromPartition: () => browsing }, Menu: {}, clipboard: {}, dialog, shell } };
}

test('annotation popovers can refresh the hidden current tab snapshot without showing or resizing it', async () => {
  const fake = fakeElectron();
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send() {}, appName: 'Engelbart' });
  views.open('a', 'https://example.com/');
  views.open('b', 'https://other.example/');
  const [a, b] = fake.made;
  let frame = 'initial', captured = 0, captureOptions;
  a.webContents.capturePage = async (_rect, options) => { captured++; captureOptions = options; return { isEmpty: () => false, toJPEG: () => Buffer.from(frame) }; };
  b.webContents.capturePage = async () => { throw Error('Never capture another tab for this popover'); };
  views.show('a', { x: 10, y: 20, width: 300, height: 200 });
  const bounds = { ...a.bounds };
  assert.equal(await views.hide({ snapshot: true, tabId: 'a' }), `data:image/jpeg;base64,${Buffer.from(frame).toString('base64')}`);
  assert.equal(a.visible, false);
  frame = 'target located and scrolled into view';
  assert.equal(await views.hide({ snapshot: true, tabId: 'a' }), `data:image/jpeg;base64,${Buffer.from(frame).toString('base64')}`);
  assert.equal(captured, 2);
  assert.deepEqual(captureOptions, { stayHidden: true, stayAwake: true }, 'refreshing a hidden page cannot expose it over the popover');
  assert.equal(a.visible, false);
  assert.deepEqual(a.bounds, bounds);
  assert.equal(b.visible, false);
  assert.equal(await views.hide({ snapshot: true, tabId: 'missing' }), null);
  let finish;
  a.webContents.capturePage = () => new Promise(resolve => { finish = resolve; });
  const refreshing = views.hide({ snapshot: true, tabId: 'a' });
  views.show('b', { x: 10, y: 20, width: 300, height: 200 });
  finish({ isEmpty: () => false, toJPEG: () => Buffer.from('old page') });
  await refreshing;
  assert.equal(b.visible, true, 'switching tabs while a hidden snapshot is captured must not hide the new page');
  assert.equal(await views.hide(), null, 'ordinary hide behavior is unchanged');
  assert.equal(b.visible, false);
  views.closeAll();
});

test('views: one page shows at a time, pages stay locked down, windows become tabs', async () => {
  const fake = fakeElectron();
  const sent = [];
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, payload) => sent.push([channel, payload]), appName: 'Engelbart' });

  assert.throws(() => views.open('a', 'file:///etc/passwd'), TypeError);
  assert.equal(fake.made.length, 0);

  views.open('a', 'http://0.0.0.0:3000');
  views.open('b', 'https://www.apple.com');
  const [a, b] = fake.made;
  assert.deepEqual(a.webContents.loaded, ['http://localhost:3000/']);
  assert.deepEqual(a.options.webPreferences, { partition: 'persist:browser', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true,
    preload: path.join(__dirname, '../dist/catalog-preload.cjs') });
  assert.equal(fake.browsing.ua, 'X Electron/44.4.1 Y', 'Stage must inherit the process-wide identity without a session override');
  assert.equal(a.visible, false);

  views.show('a', { x: 10, y: 20, width: 300, height: 200 });
  views.show('b', { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(a.visible, false);
  assert.equal(b.visible, true);
  assert.deepEqual(b.bounds, { x: 20, y: 40, width: 600, height: 400 }); // the window's zoom factor
  assert.equal(await views.hide(), null);
  assert.equal(b.visible, false);

  // Permissions: the clipboard may be written; camera, location and the like ask once per site; the rest is refused.
  const permit = (permission, requestingUrl) => new Promise((resolve) => { fake.browsing.permission(a.webContents, permission, resolve, { requestingUrl }); });
  assert.equal(await permit('clipboard-sanitized-write', 'https://example.com/'), true);
  assert.equal(await permit('midiSysex', 'https://example.com/'), false);
  assert.equal(fake.questions.length, 0);
  assert.equal(await permit('media', 'http://localhost:3000/call'), false);
  fake.dialog.answer = 0;
  assert.equal(await permit('media', 'http://localhost:3000/again'), false); // already answered for this site
  assert.equal(await permit('media', 'https://meet.example.com/'), true);
  assert.deepEqual(fake.questions, ['Allow http://localhost:3000 to use the camera or microphone?', 'Allow https://meet.example.com to use the camera or microphone?']);

  // Navigation outside http(s) is stopped; a new window is a tab.
  const blocked = { prevented: false, preventDefault() { this.prevented = true; } };
  a.webContents.emit('will-navigate', blocked, 'file:///etc/passwd');
  assert.equal(blocked.prevented, true);
  assert.equal(fake.questions.length, 2); // file: is never offered to another app
  // A link into another app (the end of a desktop app's sign-in) is stopped here and offered to that app.
  const app = { prevented: false, preventDefault() { this.prevented = true; } };
  a.webContents.emit('will-navigate', app, 'slack://open?team=T1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.prevented, true);
  assert.deepEqual(fake.handed, ['slack://open?team=T1']);
  const fine = { prevented: false, preventDefault() { this.prevented = true; } };
  a.webContents.emit('will-navigate', fine, 'https://example.com/');
  assert.equal(fine.prevented, false);
  assert.deepEqual(a.webContents.windowOpen({ url: 'engelbart://app/index.html', disposition: 'new-window' }), { action: 'deny' });
  assert.deepEqual(a.webContents.windowOpen({ url: 'file:///etc/passwd', disposition: 'foreground-tab' }), { action: 'deny' });

  // Signing in: a popup is a real child window with its opener, locked down like a tab and never given the preload.
  const popupAnswer = a.webContents.windowOpen({ url: 'about:blank', disposition: 'new-window' });
  assert.equal(popupAnswer.action, 'allow');
  const { preload, ...popupPreferences } = a.options.webPreferences;
  assert.deepEqual(popupAnswer.overrideBrowserWindowOptions.webPreferences, popupPreferences);
  const popup = Object.assign(new EventEmitter(), { title: '', isDestroyed: () => false, setTitle(value) { this.title = value; }, destroy() { this.destroyed = true; } });
  popup.webContents = Object.assign(new EventEmitter(), { getURL: () => 'https://accounts.example.com/o/oauth2', getTitle: () => 'Sign in', setWindowOpenHandler() {} });
  a.webContents.emit('did-create-window', popup);
  popup.webContents.emit('did-navigate');
  assert.equal(popup.title, 'accounts.example.com — Sign in');
  const popupNav = { prevented: false, preventDefault() { this.prevented = true; } };
  popup.webContents.emit('will-navigate', popupNav, 'file:///etc/passwd');
  assert.equal(popupNav.prevented, true);

  // Any other new window is a tab built around the contents Chromium made, so window.opener survives.
  const tabAnswer = a.webContents.windowOpen({ url: 'https://example.com/new', disposition: 'foreground-tab' });
  assert.equal(tabAnswer.action, 'allow');
  const made = Object.assign(new EventEmitter(), { marker: 'chromium-made' });
  assert.equal(tabAnswer.createWindow({ webContents: made }), made);
  const opened = sent.at(-1);
  assert.equal(opened[0], 'browser:open-tab');
  assert.equal(opened[1].from, 'a');
  assert.equal(views.has(opened[1].id), true);
  assert.equal(fake.made.at(-1).webContents.marker, 'chromium-made');
  // window.close() from the page closes its tab.
  made.emit('destroyed');
  assert.equal(views.has(opened[1].id), false);
  assert.deepEqual(sent.at(-1), ['browser:closed', { id: opened[1].id }]);

  // HTTP authentication asks the person; no answer, or a malformed one, cancels.
  const given = [];
  a.webContents.emit('login', { preventDefault() {} }, {}, { host: 'staging.example.com', realm: 'Staging', isProxy: false }, (...args) => given.push(args));
  const asked1 = sent.at(-1);
  assert.deepEqual([asked1[0], asked1[1].host, asked1[1].realm], ['browser:login', 'staging.example.com', 'Staging']);
  assert.equal(views.answerLogin(asked1[1].requestId, { username: 'h', password: 'p' }), true);
  assert.equal(views.answerLogin(asked1[1].requestId, { username: 'h', password: 'p' }), false);
  a.webContents.emit('login', { preventDefault() {} }, {}, { host: 'staging.example.com' }, (...args) => given.push(args));
  views.answerLogin(sent.at(-1)[1].requestId, { username: 7 });
  assert.deepEqual(given, [['h', 'p'], []]);

  // Self-signed certificates: this machine only.
  const verdicts = [];
  const certEvent = () => ({ preventDefault() { verdicts.push('prevented'); } });
  a.webContents.emit('certificate-error', certEvent(), 'https://localhost:8443/', 'ERR_CERT', {}, (ok) => verdicts.push(ok));
  a.webContents.emit('certificate-error', certEvent(), 'https://example.com/', 'ERR_CERT', {}, (ok) => verdicts.push(ok));
  assert.deepEqual(verdicts, ['prevented', true]);

  // A failed load is reported and stays reported through a retry; aborted loads and subframes are not failures.
  a.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'http://localhost:3000/', true);
  a.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:3000/ad', false);
  assert.equal(sent.filter(([channel, payload]) => channel === 'browser:state' && payload.error).length, 0);
  a.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', 'http://localhost:3000/', true);
  assert.deepEqual(sent.at(-1)[1].error, { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:3000/' });
  assert.equal(sent.at(-1)[1].url, 'http://localhost:3000/');
  views.command('a', 'reload');
  assert.deepEqual(a.webContents.loaded, ['http://localhost:3000/', 'http://localhost:3000/']);
  a.webContents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].error.code, -102);
  a.webContents.emit('did-navigate');
  assert.equal(sent.at(-1)[1].error, null);
  // Before a page commits, the tab reports where it is headed, not the page before it.
  views.open('a', 'https://example.com/next');
  a.webContents.url = 'http://localhost:3000/';
  a.webContents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/next');
  a.webContents.emit('did-stop-loading');
  assert.equal(sent.at(-1)[1].url, 'http://localhost:3000/');

  views.close('a');
  assert.equal(a.webContents.closed, true);
  assert.equal(fake.children.length, 1);
  views.closeAll();
  assert.equal(b.webContents.closed, true);
  assert.equal(fake.children.length, 0);
  assert.equal(popup.destroyed, true);
  await views.flush();
  assert.equal(fake.browsing.flushed, 1);
  assert.equal(views.show('a', { x: 0, y: 0, width: 1, height: 1 }), false);
});

test('favicons follow the page; navigation and closing cancel stale results; E2B stays generic', async () => {
  const fake = fakeElectron(), sent = [];
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, value) => sent.push([channel, value]), appName: 'Engelbart' });
  views.open('a', 'https://example.com/');
  const wc = fake.made[0].webContents;
  const latest = () => sent.filter(([channel]) => channel === 'browser:state').at(-1)[1];
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const svg = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  wc.emit('did-navigate');
  wc.emit('page-favicon-updated', {}, [svg]); await tick();
  assert.equal(latest().favicon, svg);
  wc.emit('did-start-navigation', {}, 'https://example.com/frame', false, false);
  wc.emit('did-start-navigation', {}, 'https://example.com/#section', true, true);
  assert.equal(latest().favicon, svg, 'subframe and same-document navigation keep the icon');

  let resolveFetch, request;
  fake.browsing.fetch = (_url, options) => { request = options; return new Promise(resolve => { resolveFetch = resolve; }); };
  wc.emit('page-favicon-updated', {}, ['https://example.com/slow.png']); await tick();
  wc.emit('did-start-navigation', {}, 'https://other.example/', false, true);
  assert.equal(latest().favicon, null); assert.equal(request.signal.aborted, true);
  wc.url = 'https://other.example/'; wc.emit('did-navigate');
  resolveFetch(new Response('old image', { headers: { 'content-type': 'image/png' } })); await tick();
  assert.equal(latest().favicon, null, 'late image from the previous page cannot return');
  wc.emit('page-favicon-updated', {}, [svg]); await tick();
  assert.equal(latest().favicon, svg);
  wc.emit('page-favicon-updated', {}, []); await tick();
  assert.equal(latest().favicon, null);

  // Electron can omit the favicon event when reloading with an unchanged icon.
  wc.executeJavaScriptInIsolatedWorld = async () => [svg];
  wc.emit('did-start-navigation', {}, wc.url, false, true);
  wc.emit('did-navigate'); wc.emit('did-finish-load'); await tick();
  assert.equal(latest().favicon, svg, 'reload reads the committed document when no favicon event arrives');
  let finishReading;
  wc.executeJavaScriptInIsolatedWorld = () => new Promise(resolve => { finishReading = resolve; });
  wc.emit('did-start-navigation', {}, wc.url, false, true);
  wc.emit('did-navigate'); wc.emit('did-finish-load'); await tick();
  wc.emit('page-favicon-updated', {}, []);
  finishReading([svg]); await tick();
  assert.equal(latest().favicon, null, 'a late document read cannot override a newer favicon event');

  for (const url of ['https://3000-example.e2b.app/', 'https://3000-example.e2b.dev/']) {
    views.open('a', url); wc.emit('did-navigate');
    wc.emit('page-favicon-updated', {}, [svg]); await tick();
    assert.equal(latest().favicon, null, 'E2B never gets a site favicon');
  }
  views.open('a', 'https://example.com/'); wc.emit('did-navigate');
  wc.emit('page-favicon-updated', {}, ['https://example.com/slow.png']); await tick();
  views.close('a'); const count = sent.length;
  assert.equal(request.signal.aborted, true);
  resolveFetch(new Response('late image', { headers: { 'content-type': 'image/png' } })); await tick();
  assert.equal(sent.length, count, 'a closed tab receives no late favicon state');
});

test('repo thumbnails capture only the settled visible viewport and discard navigation or visibility races', async () => {
  const fake = fakeElectron();
  let saved = 0, dimensions, captured = 0;
  const bytes = Buffer.from([255, 216, 255, 224]);
  const image = { isEmpty: () => false, getSize: () => ({ width: 1600, height: 1200 }),
    resize(size) { dimensions = size; return { toJPEG: () => bytes }; } };
  const repoThumbnails = { capture: async (_url, take, current) => { const picture = await take(); if (picture && current()) { saved++; return true; } return false; } };
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send() {}, appName: 'Engelbart', repoThumbnails });
  views.open('a', 'https://3000-test.e2b.app/');
  const wc = fake.made[0].webContents;
  wc.capturePage = async () => { captured++; return image; };
  wc.emit('did-navigate', {}, wc.url, 200);
  assert.equal(await views.captureRepoThumbnail('a'), false, 'background pages are never captured');
  views.show('a', { x: 0, y: 0, width: 800, height: 600 });
  assert.equal(await views.captureRepoThumbnail('a'), true);
  assert.deepEqual(dimensions, { width: 640, height: 480, quality: 'good' });
  wc.isLoading = () => true;
  assert.equal(await views.captureRepoThumbnail('a'), false);
  wc.isLoading = () => false;
  wc.emit('did-navigate', {}, wc.url, 500);
  assert.equal(await views.captureRepoThumbnail('a'), false, 'HTTP error pages are not thumbnails');
  wc.emit('did-navigate', {}, wc.url, 200);
  let finish;
  wc.capturePage = () => new Promise(resolve => { finish = resolve; });
  const navigating = views.captureRepoThumbnail('a');
  wc.emit('did-start-navigation', {}, wc.url, false, true); // same URL reload still invalidates the frame
  wc.emit('did-navigate', {}, wc.url, 200);
  finish(image); assert.equal(await navigating, false);
  const hidden = views.captureRepoThumbnail('a');
  await views.hide(); finish(image); assert.equal(await hidden, false);
  views.show('a', { x: 0, y: 0, width: 800, height: 600 });
  const closed = views.captureRepoThumbnail('a');
  views.close('a'); finish(image); assert.equal(await closed, false);
  assert.equal(saved, 1); assert.equal(captured, 1);
});

test('views: a page on disk opens from inside the home directory only, and only a page on disk may link to another', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-pages-')));
  fs.writeFileSync(path.join(home, 'report.html'), '<h1>report</h1>');
  fs.symlinkSync('/etc/hosts', path.join(home, 'escape.html'));
  const inside = pathToFileURL(path.join(home, 'report.html')).href;
  const fake = fakeElectron();
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: () => {}, appName: 'Engelbart', fileRoot: () => home });

  views.open('a', `${inside}#results`);
  assert.deepEqual(fake.made[0].webContents.loaded, [`${inside}#results`]);
  assert.throws(() => views.open('a', 'file:///etc/hosts'), TypeError);
  assert.throws(() => views.open('a', pathToFileURL(path.join(home, 'escape.html')).href), TypeError); // a link out of the home directory
  assert.throws(() => views.open('a', 'file://server/share/x.html'), TypeError);

  const navigate = (contents, url) => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; contents.emit('will-navigate', event, url); return event.prevented; };
  const a = fake.made[0].webContents;
  assert.equal(navigate(a, pathToFileURL(path.join(home, 'next.html')).href), false); // from a page on disk to its neighbour
  assert.equal(navigate(a, 'file:///etc/hosts'), true);
  assert.equal(a.windowOpen({ url: inside, disposition: 'foreground-tab' }).action, 'allow');
  views.open('b', 'https://example.com/');
  const b = fake.made[1].webContents;
  assert.equal(navigate(b, inside), true); // the web never reaches the disk
  assert.deepEqual(b.windowOpen({ url: inside, disposition: 'foreground-tab' }), { action: 'deny' });
});

test('pdf helpers: a pdf answer becomes a download that keeps its file name', () => {
  assert.equal(pdfAddress('https://example.com/papers/a.PDF?x=1'), true);
  assert.equal(pdfAddress('https://arxiv.org/pdf/2310.05292'), false); // known only by its type, when it answers
  assert.equal(pdfAddress('not a url'), false);
  assert.equal(pdfAsDownload({ 'content-type': ['text/html'] }), null);
  assert.deepEqual(pdfAsDownload({ 'Content-Type': ['application/pdf'], 'x-a': ['1'] }), { 'Content-Type': ['application/pdf'], 'x-a': ['1'], 'Content-Disposition': ['attachment'] });
  assert.deepEqual(pdfAsDownload({ 'content-type': ['application/pdf; qs=0.001'], 'content-disposition': ['inline; filename="2310.05292v2.pdf"'] })['Content-Disposition'], ['attachment; filename="2310.05292v2.pdf"']);
  assert.equal(pdfName('2310.05292v2.pdf', 'https://arxiv.org/pdf/2310.05292'), '2310.05292v2');
  assert.equal(pdfName('', 'https://example.com/a%20b.pdf'), 'a b');
  assert.equal(pdfName('', 'https://example.com/'), 'pdf');
});

test('views: a tab\'s pdf is saved aside and sent to the viewer; other downloads, subframes and popups are left alone', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-pdfs-')));
  const pdfDir = path.join(home, 'tmp');
  const fake = fakeElectron();
  const sent = [];
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, payload) => sent.push([channel, payload]), appName: 'Engelbart', fileRoot: () => home, pdfDir });
  views.open('a', 'https://arxiv.org/abs/2310.05292');
  const a = fake.made[0].webContents;
  a.url = 'https://arxiv.org/abs/2310.05292';

  // The answer's headers: only a tab's main frame is turned into a download.
  assert.deepEqual(fake.browsing.headersFilter.types, ['mainFrame']);
  const headers = (details) => new Promise((resolve) => fake.browsing.headers({ resourceType: 'mainFrame', responseHeaders: { 'content-type': ['application/pdf'] }, ...details }, resolve));
  assert.deepEqual((await headers({ webContents: a })).responseHeaders['Content-Disposition'], ['attachment']);
  assert.deepEqual(await headers({ webContents: {} }), {}); // a popup's pdf is Chromium's
  assert.deepEqual(await headers({ webContents: a, resourceType: 'subFrame' }), {});
  assert.deepEqual(await headers({ webContents: a, responseHeaders: { 'content-type': ['text/html'] } }), {});

  const download = (url, mime, fileName) => Object.assign(new EventEmitter(), {
    getURL: () => url, getMimeType: () => mime, getFilename: () => fileName, getReceivedBytes: () => 12,
    setSavePath(file) { this.saved = file; }, cancel() { this.cancelled = true; },
  });
  const item = download('https://arxiv.org/pdf/2310.05292', 'application/pdf', '2310.05292v2.pdf');
  fake.browsing['will-download']({}, item, a);
  assert.ok(item.saved.startsWith(pdfDir + path.sep));
  assert.deepEqual(sent.at(-1), ['browser:pdf', { id: 'a', url: 'https://arxiv.org/pdf/2310.05292', name: '2310.05292v2', under: 'https://arxiv.org/abs/2310.05292', loading: true }]);
  fs.writeFileSync(item.saved, '%PDF-1.4 x');
  item.emit('done', {}, 'completed');
  const [channel, payload] = sent.at(-1);
  assert.equal(channel, 'browser:pdf');
  assert.equal(Buffer.from(payload.bytes).toString(), '%PDF-1.4 x');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(item.saved), false); // the temporary copy goes once read

  // Served as octet-stream, a .pdf address is still a pdf; a failed one says so.
  const octet = download('https://example.com/b.pdf', 'application/octet-stream', 'b.pdf');
  fake.browsing['will-download']({}, octet, a);
  octet.emit('done', {}, 'interrupted');
  assert.deepEqual(sent.at(-1)[1], { id: 'a', url: 'https://example.com/b.pdf', name: 'b', under: 'https://arxiv.org/abs/2310.05292', error: 'The pdf did not download' });
  // A zip, or a pdf from something that is not a tab, is Electron's to ask about.
  const zip = download('https://example.com/c.zip', 'application/zip', 'c.zip');
  fake.browsing['will-download']({}, zip, a);
  assert.equal(zip.saved, undefined);
  const stray = download('https://example.com/d.pdf', 'application/pdf', 'd.pdf');
  fake.browsing['will-download']({}, stray, {});
  assert.equal(stray.saved, undefined);

  // A pdf on disk is read, never loaded into the page: typed, or linked from a page on disk. Outside home: refused.
  fs.writeFileSync(path.join(home, 'paper.pdf'), '%PDF-1.4 disk');
  const disk = pathToFileURL(path.join(home, 'paper.pdf')).href;
  const before = a.loaded.length;
  views.open('a', disk);
  assert.equal(a.loaded.length, before);
  assert.equal(sent.at(-1)[1].name, 'paper');
  assert.equal(Buffer.from(sent.at(-1)[1].bytes).toString(), '%PDF-1.4 disk');
  views.open('a', pathToFileURL(path.join(home, 'missing.pdf')).href);
  assert.equal(sent.at(-1)[1].error, 'Nothing is at that path');
  assert.throws(() => views.open('a', 'file:///etc/x.pdf'), TypeError);
  views.open('b', pathToFileURL(path.join(home, 'index.html')).href);
  const b = fake.made[1].webContents;
  b.url = pathToFileURL(path.join(home, 'index.html')).href;
  const link = { prevented: false, preventDefault() { this.prevented = true; } };
  b.emit('will-navigate', link, disk);
  assert.equal(link.prevented, true);
  assert.deepEqual([sent.at(-1)[1].id, sent.at(-1)[1].url], ['b', disk]);
});

test('views: find in the page, and the keys a page cannot keep (⌘T, ⌘W; ⇧⌘W stays the window\'s)', () => {
  const fake = fakeElectron();
  const sent = [];
  const views = createBrowserViews({ electron: fake.electron, getWindow: () => fake.win, send: (channel, payload) => sent.push([channel, payload]), appName: 'Engelbart' });
  views.open('a', 'https://example.com/');
  const a = fake.made[0].webContents;

  views.find('a', 'hello');
  views.find('a', 'hello');
  views.find('a', 'hello', { backward: true });
  views.find('a', 'help');
  views.stopFind('a');
  views.find('a', 'help'); // after a stop, the same words start over
  views.find('a', '');
  assert.deepEqual(a.finds, [
    ['hello', { forward: true, findNext: true, matchCase: false }],
    ['hello', { forward: true, findNext: false, matchCase: false }],
    ['hello', { forward: false, findNext: false, matchCase: false }],
    ['help', { forward: true, findNext: true, matchCase: false }],
    ['stop', 'keepSelection'],
    ['help', { forward: true, findNext: true, matchCase: false }],
    ['stop', 'clearSelection'],
  ]);
  assert.throws(() => views.find('a', 'x'.repeat(1001)), TypeError);
  a.emit('found-in-page', {}, { requestId: 1, matches: 4, activeMatchOrdinal: 2, finalUpdate: true });
  assert.deepEqual(sent.at(-1), ['browser:found', { id: 'a', matches: 4, active: 2 }]);

  const key = (input) => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; a.emit('before-input-event', event, { type: 'keyDown', meta: process.platform === 'darwin', control: process.platform !== 'darwin', alt: false, shift: false, ...input }); return event.prevented; };
  assert.equal(key({ key: 't' }), true);
  assert.deepEqual(sent.at(-1), ['browser:shortcut', { name: 'new-tab', tab: 'a' }]);
  assert.equal(fake.win.focused, 1); // the address, in the app, takes the keyboard
  assert.equal(key({ key: 'w' }), true);
  assert.deepEqual(sent.at(-1), ['browser:shortcut', { name: 'close-tab', tab: 'a' }]);
  const count = sent.length;
  assert.equal(key({ key: 'W', shift: true }), false);
  assert.equal(key({ key: 'f' }), false); // the Edit menu's, after the page
  assert.equal(sent.length, count);

  // The Edit menu's Find names the tab whose page has the keyboard, else none.
  views.shortcut('find');
  assert.deepEqual(sent.at(-1), ['browser:shortcut', { name: 'find', tab: null }]);
  views.show('a', { x: 0, y: 0, width: 10, height: 10 });
  a.focused = true;
  views.shortcut('find-next');
  assert.deepEqual(sent.at(-1), ['browser:shortcut', { name: 'find-next', tab: 'a' }]);
});

test('GitHub webpages stay in Stage from direct loads, links, redirects and new tabs', () => {
  const f = fakeElectron();
  const sent = [];
  const views = createBrowserViews({ electron: f.electron, getWindow: () => f.win, send: (channel, payload) => sent.push([channel, payload]) });
  views.open('github', 'https://github.com/Mathetic-PBC/engelbart-canvas');
  assert.deepEqual(f.made[0].webContents.loaded, ['https://github.com/Mathetic-PBC/engelbart-canvas']);
  views.open('web', 'https://example.com');
  const contents = f.made[1].webContents;
  for (const event of ['will-navigate', 'will-redirect']) {
    let stopped = false;
    contents.emit(event, { preventDefault() { stopped = true; } }, 'https://github.com/login');
    assert.equal(stopped, false);
  }
  const tab = contents.windowOpen({ url: 'https://github.com/owner/app', disposition: 'foreground-tab' });
  assert.equal(tab.action, 'allow');
  const child = new EventEmitter();
  assert.equal(tab.createWindow({ webContents: child }), child);
  assert.equal(sent.at(-1)[0], 'browser:open-tab');
  assert.equal(views.has(sent.at(-1)[1].id), true);
  assert.equal(contents.windowOpen({ url: 'https://github.com/login', disposition: 'new-window' }).action, 'allow');
  views.open('lookalike', 'https://github.com.evil.example');
  assert.deepEqual(f.handed, [], 'Web navigation must not launch the personal browser');
  // Renderer entry points must also let GitHub reach these native Stage views.
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Stage.jsx'), 'utf8');
  assert.doesNotMatch(source, /isGithubPage/);
  assert.match(source, /Open in default browser/, 'The explicit external-browser menu action remains available');
});
