'use strict';

// npx electron scripts/check-signin-popup.cjs
// Connect your library's sign-in window (src/main/connect/signin-window.cjs) with real Electron windows and fake sites
// (2026-10-12): claude.ai's "Continue with Google" opens Google in a pop-up that answers through window.opener. Here a
// fake claude.ai/login opens a fake accounts.google.com pop-up, which posts a token back to its opener; the opener sets
// claude.ai's sign-in cookie. The check: the pop-up opened as a child of the sign-in window, on the same session, with the
// same user agent; the message reached the opener; the cookie landed in the shared session, so the window's poll saw it
// and open() answered signed-in; the pop-up was closed with its parent; an http pop-up was refused. Nothing leaves this
// Mac: every https request on the check's session is answered here.

const { app, BrowserWindow, session: electronSession } = require('electron');
const assert = require('node:assert/strict');
const { createSignInWindow } = require('../src/main/connect/signin-window.cjs');

const LOGIN = `<!doctype html><title>Claude</title><button id="google">Continue with Google</button><p id="said"></p>
<script>
document.getElementById('google').onclick = () => {
  window.open('https://accounts.google.com/o/oauth2/v2/auth?client_id=check', 'google', 'width=480,height=600');
  window.open('http://example.com/', 'plain');
};
window.addEventListener('message', (event) => {
  if (event.origin !== 'https://accounts.google.com' || !event.data || !event.data.token) return;
  document.cookie = 'sessionKey=' + event.data.token + '; Secure; Path=/; Max-Age=600';
  document.getElementById('said').textContent = 'got ' + event.data.token + ' from ' + event.origin;
});
</script>`;
const POPUP = `<!doctype html><title>Google</title><script>
window.opener.postMessage({ token: 'sk-check-1' }, 'https://claude.ai');
</script>`;

app.on('window-all-closed', () => {}); // the check ends the app itself, after the windows have closed
app.whenReady().then(async () => {
  const ses = electronSession.fromPartition('check-signin-popup'); // in memory: gone when the check ends
  const served = [];
  ses.protocol.handle('https', (request) => {
    const url = new URL(request.url);
    served.push(`${url.hostname}${url.pathname}`);
    const page = url.hostname === 'claude.ai' ? LOGIN : url.hostname === 'accounts.google.com' ? POPUP : '';
    return new Response(page, { status: page ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  ses.protocol.handle('http', () => new Response('no', { status: 404 }));

  const signedIn = async () => (await ses.cookies.get({ domain: 'claude.ai' })).some((cookie) => cookie.name === 'sessionKey');
  const made = [];
  class Watched extends BrowserWindow { constructor(options) { super(options); made.push(this); } }
  const signIn = createSignInWindow({ BrowserWindow: Watched, getSession: () => ses, userAgent: (ua) => ua.replace(/ Electron\/\S+/, '').replace(/ engelbart\/\S+/i, ''), signedIn, headless: true, pollMs: 200 });

  let popup = null;
  let seen = null;
  let opener = null;
  const popups = [];
  app.on('browser-window-created', (event, win) => { if (made.length && win !== made[0]) popups.push(win); });
  try {
    const result = signIn.open('Claude');
    const [win] = made;
    win.webContents.on('did-create-window', (child) => {
      popup = child;
      seen = { parent: child.getParentWindow() === win, session: child.webContents.session === ses, ua: child.webContents.getUserAgent(), parentUa: win.webContents.getUserAgent() };
    });
    await new Promise((resolve) => { win.webContents.once('did-finish-load', resolve); });
    opener = win.webContents;
    await opener.executeJavaScript("document.getElementById('google').click()", true);
    const answer = await Promise.race([result, new Promise((resolve) => { setTimeout(() => resolve({ status: 'timed out' }), 15_000); })]);

    assert.ok(popup, 'the https pop-up opened');
    assert.equal(popups.length, 1, 'only the https pop-up opened (the http one was refused)');
    assert.equal(seen.parent, true, 'a child of the sign-in window');
    assert.equal(seen.session, true, 'the same session');
    assert.doesNotMatch(seen.ua, /Electron\//, 'a user agent with no Electron in it');
    assert.equal(seen.ua, seen.parentUa, 'the same user agent as the sign-in window');
    assert.deepEqual(answer, { status: 'signed-in' }, 'the cookie the opener set landed in the shared session');
    for (let n = 0; n < 40 && !(popup.isDestroyed() && win.isDestroyed()); n += 1) await new Promise((resolve) => { setTimeout(resolve, 50); }); // close() is asynchronous
    assert.equal(popup.isDestroyed(), true, 'closed with its parent');
    assert.equal(win.isDestroyed(), true);
    assert.ok(served.includes('accounts.google.com/o/oauth2/v2/auth'), 'the pop-up loaded the page');
    assert.ok(!served.some((entry) => entry.startsWith('example.com')), 'the http pop-up never loaded');
    console.error('check-signin-popup: ok (pop-up opened as a child on the same session, posted to its opener, signed in, closed with its parent; http pop-up refused)');
    app.exit(0);
  } catch (error) {
    console.error('check-signin-popup: FAILED', error);
    console.error('served:', served);
    app.exit(1);
  }
});
