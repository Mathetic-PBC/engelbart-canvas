'use strict';

// Connect your library's sign-in window (src/main/connect/signin-window.cjs, 2026-10-11): a web app's sign-in page in
// Engelbart's own browser, with a fake BrowserWindow, a fake session and fake timers.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSignInWindow } = require('../src/main/connect/signin-window.cjs');

function fakes({ held = new Set() } = {}) {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.loaded = [];
      this.focused = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        ua: 'Mozilla/5.0 Electron/38',
        getUserAgent: () => this.webContents.ua,
        setUserAgent: (ua) => { this.webContents.ua = ua; },
        setWindowOpenHandler: (fn) => { this.webContents.openHandler = fn; },
      });
      windows.push(this);
    }
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    show() {}
    focus() { this.focused += 1; }
    close() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
  }
  const ticks = new Set();
  const timers = { setInterval: (fn) => { ticks.add(fn); return fn; }, clearInterval: (fn) => { ticks.delete(fn); } };
  const tick = async () => { for (const fn of [...ticks]) await fn(); await new Promise((resolve) => setImmediate(resolve)); };
  const jar = [];
  const removed = [];
  const session = {
    name: 'persist:browser',
    cookies: {
      get: async ({ domain }) => jar.filter((cookie) => cookie.domain.replace(/^\./, '').endsWith(domain)),
      remove: async (url, name) => { removed.push([url, name]); const at = jar.findIndex((cookie) => cookie.name === name && url.includes(cookie.domain.replace(/^\./, ''))); if (at >= 0) jar.splice(at, 1); },
    },
  };
  const looked = [];
  const signedIn = async (app) => { looked.push(app); return held.has(app); };
  const signIn = createSignInWindow({ BrowserWindow, getSession: () => session, userAgent: (ua) => ua.replace(/ Electron\/\S+/, ''), signedIn, timers, headless: true });
  return { signIn, windows, tick, ticks, held, session, looked, jar, removed };
}

test('the sign-in window: on the agents\' session, a normal user agent, the app\'s sign-in page; signed in, it closes itself', async () => {
  const { signIn, windows, tick, ticks, held, session } = fakes();
  const result = signIn.open('ChatGPT');
  const [win] = windows;
  assert.equal(win.options.webPreferences.session, session, 'the session webSignIn.signedIn reads');
  assert.deepEqual([win.options.width, win.options.height, win.options.show], [460, 720, false]);
  assert.deepEqual([win.options.webPreferences.contextIsolation, win.options.webPreferences.sandbox, win.options.webPreferences.nodeIntegration], [true, true, false]);
  assert.equal(win.webContents.ua, 'Mozilla/5.0', 'sites see a normal browser');
  assert.deepEqual(win.loaded, ['https://chatgpt.com/auth/login']);
  await tick();
  assert.equal(win.destroyed, false, 'not signed in yet: still open');
  held.add('ChatGPT');
  await tick();
  assert.deepEqual(await result, { status: 'signed-in' });
  assert.equal(win.destroyed, true, 'closed by itself');
  assert.equal(ticks.size, 0, 'no longer looking');
  assert.equal(signIn.isOpen(), false);
});

test('the sign-in window closed by the person first: closed', async () => {
  const { signIn, windows, ticks } = fakes();
  const result = signIn.open('Claude');
  assert.deepEqual(windows[0].loaded, ['https://claude.ai/login']);
  windows[0].close();
  assert.deepEqual(await result, { status: 'closed' });
  assert.equal(ticks.size, 0);
  // close() from the choose screen (Leave out, or the screen gone) is the same.
  const again = signIn.open('Claude');
  signIn.close();
  assert.deepEqual(await again, { status: 'closed' });
  assert.equal(windows[1].destroyed, true);
});

test('one window: a second open() for an app sharing the Google sign-in focuses it and shares its answer', async () => {
  const { signIn, windows, tick, held } = fakes();
  const drive = signIn.open('Google Docs');
  const gmail = signIn.open('Gmail');
  assert.equal(windows.length, 1, 'the same window');
  assert.equal(windows[0].focused, 1);
  assert.deepEqual(windows[0].loaded, ['https://accounts.google.com/']);
  held.add('Google Docs');
  await tick();
  assert.deepEqual(await Promise.all([drive, gmail]), [{ status: 'signed-in' }, { status: 'signed-in' }]);
  // Another sign-in replaces it: the first answers closed.
  const chat = signIn.open('ChatGPT');
  const claude = signIn.open('Claude');
  assert.equal(windows.length, 3);
  assert.deepEqual(await chat, { status: 'closed' });
  assert.equal(windows[1].destroyed, true);
  signIn.close();
  assert.deepEqual(await claude, { status: 'closed' });
});

test('the sign-in window loads any https page, opens an https pop-up as its child on the same session, and blocks anything else', async () => {
  const { signIn, windows, session, tick, held } = fakes();
  const result = signIn.open('Claude');
  const [win] = windows;
  // claude.ai's "Continue with Google" (2026-10-12): Google opens in a pop-up and answers through window.opener.
  const allowed = win.webContents.openHandler({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' });
  assert.equal(allowed.action, 'allow');
  const options = allowed.overrideBrowserWindowOptions;
  assert.equal(options.parent, win, 'a child of the sign-in window');
  assert.equal(options.webPreferences.session, session, 'the same session: the sign-in lands where the window looks for it');
  assert.deepEqual([options.webPreferences.contextIsolation, options.webPreferences.sandbox, options.webPreferences.nodeIntegration, options.show], [true, true, false, false]);
  assert.deepEqual(win.loaded, ['https://claude.ai/login'], 'the sign-in window keeps its own page (and its window.opener)');
  assert.deepEqual(win.webContents.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  assert.deepEqual(win.webContents.openHandler({ url: 'http://example.com/' }), { action: 'deny' }, 'https only');
  // Electron makes the pop-up (as it would for 'allow') and says so: same user agent, the same guards.
  const BrowserWindow = win.constructor;
  const popup = new BrowserWindow(options);
  popup.webContents.ua = 'Mozilla/5.0 Electron/38';
  win.webContents.emit('did-create-window', popup, { url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' });
  assert.equal(popup.webContents.ua, 'Mozilla/5.0', 'the same user agent sites see');
  assert.equal(typeof popup.webContents.openHandler, 'function', 'its own pop-ups follow the same rule');
  assert.equal(popup.webContents.openHandler({ url: 'https://accounts.google.com/x' }).overrideBrowserWindowOptions.parent, popup);
  const navigate = (contents, url) => { let prevented = false; contents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, url); return prevented; };
  assert.equal(navigate(win.webContents, 'https://login.microsoftonline.com/'), false);
  assert.equal(navigate(win.webContents, 'http://example.com/'), true);
  assert.equal(navigate(win.webContents, 'javascript:alert(1)'), true);
  assert.equal(navigate(popup.webContents, 'http://example.com/'), true, 'the pop-up is guarded too');
  // Google answered claude.ai through the opener: the cookie lands in the shared session and the parent's poll sees it.
  held.add('Claude');
  await tick();
  assert.deepEqual(await result, { status: 'signed-in' });
  assert.equal(popup.destroyed, true, 'closed with its parent');
  assert.equal(win.destroyed, true);
});

test('a pop-up still open when the person closes the sign-in window closes with it; open() answers closed (the choose screen unticks the row)', async () => {
  const { signIn, windows } = fakes();
  const result = signIn.open('Claude');
  const [win] = windows;
  const popup = new win.constructor(win.webContents.openHandler({ url: 'https://accounts.google.com/x' }).overrideBrowserWindowOptions);
  win.webContents.emit('did-create-window', popup, {});
  win.close();
  assert.deepEqual(await result, { status: 'closed' });
  assert.equal(popup.destroyed, true);
});

test('Google refuses the sign-in: its stale cookies are cleared, the window closes, and open() answers rejected', async () => {
  const { signIn, windows, ticks, jar, removed } = fakes();
  jar.push(
    { domain: '.google.com', path: '/', name: '__Secure-1PSIDTS' },
    { domain: '.google.com', path: '/', name: 'NID' },
    { domain: 'accounts.google.com', path: '/', name: '__Host-GAPS' },
    { domain: 'accounts.google.com', path: '/', name: 'OTZ' },
    { domain: 'mail.google.com', path: '/mail', name: '__Host-GMAIL_SCH' },
    { domain: '.google.com', path: '/', name: 'AEC' },
    { domain: 'drive.google.com', path: '/', name: '__Secure-ENID' },
  );
  const result = signIn.open('Gmail');
  const [win] = windows;
  win.webContents.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn');
  assert.equal(win.destroyed, false, 'an ordinary sign-in page');
  win.webContents.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/rejected?continue=x');
  assert.deepEqual(await result, { status: 'rejected' });
  assert.equal(win.destroyed, true, 'closed');
  assert.equal(ticks.size, 0);
  assert.deepEqual(removed.map(([url, name]) => `${url} ${name}`).sort(), [
    'https://accounts.google.com/ OTZ',
    'https://accounts.google.com/ __Host-GAPS',
    'https://google.com/ NID',
    'https://google.com/ __Secure-1PSIDTS',
    'https://mail.google.com/mail __Host-GMAIL_SCH',
  ]);
  assert.deepEqual(jar.map((cookie) => cookie.name).sort(), ['AEC', '__Secure-ENID'], 'other cookies, and other Google hosts, are kept');
  // The next try opens a new window.
  void signIn.open('Gmail');
  assert.equal(windows.length, 2);
  signIn.close();
});
