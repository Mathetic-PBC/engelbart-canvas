'use strict';

// Connect your library's choose screen (2026-10-12): a web app ticked and not signed in opens its sign-in by itself, with
// no Sign in to click (ticking is the consent). The check's answer decides (opensSignIn); the sign-in chain opens each
// through signInHere (Engelbart's window, or Google's route on the Mac), one at a time, one per sign-in group, waiting for
// a window or the Keychain modal and not for a sign-in left waiting in the browser; only a window closed by the person
// stops it. A check reads "Checking…", "Waiting for macOS…" only when the modal's Continue started it.
// src/renderer/model/connect.js opensSignIn, signInChain, signInWindows, rowLabel; src/renderer/screens/ConnectLibrary.jsx.
// (The screen itself: scripts/smoke-connect.cjs.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const model = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
const screen = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx'), 'utf8');

async function picksWith(m, rows) {
  let state = m.initialPicks({ apps: {} });
  for (const [id, app] of rows) state = m.tickRow(state, id, app, true);
  return state;
}

/**
 * signInWindows with open(row) as the screen's signInHere would go: on the Mac a Google row not turned down takes the
 * browser route, every other row Engelbart's window. The test answers each: `answer(app, status)`.
 */
function chainOf(m, { signIns = {}, state = null, consent = () => true, platform = 'darwin' } = {}) {
  const opened = [];
  const waiting = new Map();
  const turnedDown = m.signInWindows({
    pick: (rows) => m.signInChain(rows, { signIns, state, consent: consent() }),
    open: (row) => new Promise((resolve) => {
      opened.push(`${row.app} ${m.signsInViaBrowser(row.app, signIns[row.app], platform) ? 'browser' : 'window'}`);
      waiting.set(row.app, resolve);
    }),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const answer = async (app, status) => {
    const shown = { 'signed-in': 'signed-in', browser: 'browser', declined: 'declined' }[status];
    if (shown) for (const other of m.sharesSignIn(app)) signIns[other] = { status: shown, browser: '' };
    waiting.get(app)(status);
    await settle();
    await settle();
  };
  return { turnedDown, opened, answer, settle };
}

test('opensSignIn: a web app just ticked comes back signed-out or no-browser → its sign-in opens; signed-in, a failed check, Try again and the run never', async () => {
  const m = await model();
  assert.equal(m.opensSignIn('signed-out', { fresh: true }), true, 'not signed in in any browser: Engelbart\'s window, no click');
  assert.equal(m.opensSignIn('no-browser', { fresh: true }), true, 'Safari only, or no browser: the window too');
  assert.equal(m.opensSignIn('signed-in', { fresh: true }), false, 'signed in: nothing opens');
  assert.equal(m.opensSignIn('', { fresh: true }), false, 'a failed or cleared check: nothing');
  assert.equal(m.opensSignIn(undefined, { fresh: true }), false);
  assert.equal(m.opensSignIn('signed-out', { fresh: true, consent: false }), false, 'consent off: nothing opens');
  assert.equal(m.opensSignIn('signed-out', { fresh: true, still: false }), false, 'unticked while it was checked: nothing');
  assert.equal(m.opensSignIn('signed-out'), false, 'Try again, the run\'s checks: nothing opens');
  assert.equal(m.opensSignIn('no-browser', { fresh: false }), false);
  assert.equal(m.opensSignIn('refused'), true, 'macOS refusing it opens the window, as before');
});

test('the screen: only a new tick\'s check (checkTicked, and Continue after it) opens the sign-in; Try again does not; rows ticked from the start are not checked on load', () => {
  assert.match(screen, /const checkSignIn = \(\{ id, app \}, \{ retry = false, open = false \} = \{\}\) => \{/);
  assert.match(screen, /api\.connectSignInCheck\(app, retry\)/);
  const opens = [...screen.matchAll(/checkSignIn\(([^)]*)\)/g)].map((match) => match[1]).filter((args) => !/^\{ id, app \}/.test(args));
  assert.deepEqual(opens, ['row, { open: true }', 'row, { open: true }', 'row, { retry: true }'], 'checkTicked, allowSignIns, retrySignIn');
  assert.match(screen, /const toggleApp = [\s\S]*?else if \(spec\.reach === 'web'\) checkTicked\(\[\{ id, app \}\]\);/);
  assert.match(screen, /const toggleGroup = [^\n]*checkTicked\(newlyTickedWeb\(picks, next\)\)/);
  assert.match(screen, /const toggleAll = [^\n]*checkTicked\(newlyTickedWeb\(picks, next\)\)/);
  assert.doesNotMatch(screen, /A web app not signed in stays ticked, with Sign in on its row/, 'the old comment is gone');
});

test('the chain opens through signInHere: Google on the Mac takes the browser route, the rest (and anything off the Mac, or turned down) Engelbart\'s window', async () => {
  const m = await model();
  assert.match(screen, /open: async \(row\) => \{ await rendered\(\); const out = await hereRef\.current\(row\.id, row\.app, true\); await rendered\(\); return out; \}/);
  assert.match(screen, /hereRef\.current = signInHere;/);
  assert.doesNotMatch(screen, /windowHere/, 'no longer straight to the window');
  const out = { status: 'signed-out', browser: '' };
  assert.equal(m.signsInViaBrowser('Google Docs', out, 'darwin'), true);
  assert.equal(m.signsInViaBrowser('Gmail', { status: 'no-browser', browser: '' }, 'darwin'), false, 'Safari only: the window');
  assert.equal(m.signsInViaBrowser('Google Docs', { status: 'declined', browser: '' }, 'darwin'), false, 'Not now: the window');
  assert.equal(m.signsInViaBrowser('Google Docs', { status: 'refused', browser: 'Chrome' }, 'darwin'), false, 'Deny: the window');
  assert.equal(m.signsInViaBrowser('Google Docs', out, 'win32'), false, 'off the Mac: the window');
  assert.equal(m.signsInViaBrowser('ChatGPT', out, 'darwin'), false);
});

test('Google Drive ticked on the Mac with Chrome not asked yet: the Keychain modal holds the chain; after Continue, the next app\'s window opens while Google waits in the browser', async () => {
  const m = await model();
  const rows = [['notes', 'Google Docs'], ['chats', 'ChatGPT']];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows) });
  const done = turnedDown([{ id: 'notes', app: 'Google Docs' }]);
  await settle();
  void turnedDown([{ id: 'chats', app: 'ChatGPT' }]); // ticked meanwhile: waits its turn
  await settle();
  assert.deepEqual(opened, ['Google Docs browser'], 'the browser route (its modal), no window, and ChatGPT not yet');
  await answer('Google Docs', 'browser'); // Continue: the sign-in waits in the browser
  assert.deepEqual(opened, ['Google Docs browser', 'ChatGPT window'], 'the wait in the browser does not hold the chain');
  await answer('ChatGPT', 'signed-in');
  await done;
  // The screen: signInInBrowser waits for the modal's answer when the chain opened it, and never for the browser.
  assert.match(screen, /const answer = chained \? new Promise\(\(resolve\) => \{ modalAnswer\.current = \{ group: sharesSignIn\(app\), resolve \}; \}\) : 'asked';/);
  assert.match(screen, /if \(!chained\) return browserSignIn\(id, app, said\.opens \|\| ''\);\n\s*void browserSignIn\(id, app, said\.opens \|\| '', true\);\n\s*return 'browser';/);
  assert.match(screen, /viaBrowser\.forEach\(\(row\) => \{ void browserSignIn\(row\.id, row\.app, '', true\); \}\);\n\s*answerChain\(viaBrowser, 'browser'\);/, 'Continue answers it once the browser route is on');
});

test('the Keychain modal\'s Not now (or Deny after Continue): that group gets Engelbart\'s window next, and the chain goes on', async () => {
  const m = await model();
  const rows = [['notes', 'Google Docs'], ['email', 'Gmail'], ['chats', 'Claude']];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows) });
  const done = turnedDown([{ id: 'notes', app: 'Google Docs' }, { id: 'chats', app: 'Claude' }]);
  await settle();
  void turnedDown([{ id: 'email', app: 'Gmail' }]); // its own group: not again
  await answer('Google Docs', 'declined');
  assert.deepEqual(opened, ['Google Docs browser', 'Google Docs window'], 'Not now does not stop it: the window, for Drive and Gmail together');
  await answer('Google Docs', 'signed-in');
  assert.deepEqual(opened, ['Google Docs browser', 'Google Docs window', 'Claude window']);
  await answer('Claude', 'signed-in');
  await done;
  assert.match(screen, /const declineSignIns = [\s\S]*?void turnedDown\(rows\);\n\s*answerChain\(rows, 'declined'\);/);
  assert.match(screen, /void turnedDown\(viaBrowser\);\n\s*answerChain\(viaBrowser, 'declined'\);/, 'Deny at Continue\'s unlock');
});

test('Select all with ChatGPT, Claude, Google Drive and Gmail not signed in: one popup at a time, one for Drive and Gmail together', async () => {
  const m = await model();
  const rows = [['chats', 'ChatGPT'], ['chats', 'Claude'], ['notes', 'Google Docs'], ['email', 'Gmail']];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows), platform: 'linux' });
  // Each check answers in its own time; each not signed in joins the chain.
  const done = turnedDown([{ id: 'chats', app: 'ChatGPT' }]);
  for (const [id, app] of rows.slice(1)) void turnedDown([{ id, app }]);
  await settle();
  assert.deepEqual(opened, ['ChatGPT window']);
  await answer('ChatGPT', 'signed-in');
  assert.deepEqual(opened, ['ChatGPT window', 'Claude window']);
  await answer('Claude', 'rejected');
  assert.deepEqual(opened, ['ChatGPT window', 'Claude window', 'Google Docs window']);
  await answer('Google Docs', 'signed-in');
  await done;
  assert.deepEqual(opened, ['ChatGPT window', 'Claude window', 'Google Docs window'], 'Gmail signed in with Drive');
});

test('a window closed without signing in stops the chain; a window replaced by another, or a modal gone unanswered, does not', async () => {
  const m = await model();
  const rows = [['chats', 'ChatGPT'], ['chats', 'Claude'], ['chats', 'Grok'], ['chats', 'Perplexity']];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows) });
  const done = turnedDown(rows.map(([id, app]) => ({ id, app })));
  await settle();
  await answer('ChatGPT', 'replaced');
  await answer('Claude', 'dropped');
  assert.deepEqual(opened, ['ChatGPT window', 'Claude window', 'Grok window']);
  await answer('Grok', 'closed');
  await done;
  assert.deepEqual(opened, ['ChatGPT window', 'Claude window', 'Grok window'], 'Perplexity keeps its tick and Sign in');
  // The screen: the person's close unticks that group (signInWindowClosed); a replaced window answers 'replaced'.
  assert.match(screen, /if \(lastWindow\.current !== ours\) \{\n[^\n]*\n\s*return 'replaced';\n\s*\}/);
  assert.match(screen, /setPicks\(\(now\) => signInWindowClosed\(now, app\)\.state\);\n\s*setSignIns\(\(now\) => signInWindowClosed\(null, app, now\)\.signIns\);\n\s*return 'closed';/);
});

test('one sign-in per group: an app whose group\'s window or browser wait is open already is not opened again', async () => {
  const m = await model();
  const rows = [{ id: 'notes', app: 'Google Docs' }, { id: 'email', app: 'Gmail' }, { id: 'chats', app: 'Claude' }];
  const state = await picksWith(m, rows.map((row) => [row.id, row.app]));
  assert.deepEqual(m.signInChain(rows, { state, signIns: { 'Google Docs': { status: 'browser', browser: 'Chrome' } } }).map((row) => row.app), ['Claude']);
  assert.deepEqual(m.signInChain(rows, { state, signIns: { 'Google Docs': { status: 'signing', browser: '' } } }).map((row) => row.app), ['Claude']);
  assert.match(screen, /const rows = ticks\.filter\(\(row\) => !\['signed-in', 'signing', 'browser'\]\.includes\(\(signIns\[row\.app\] \|\| \{\}\)\.status\)\);/, 'ticked while it waits: shows the wait, not checked again');
});

test('the consent off: nothing opens, and a modal the chain waits on is let go', async () => {
  const m = await model();
  const rows = [{ id: 'chats', app: 'ChatGPT' }];
  const { turnedDown, opened } = chainOf(m, { state: await picksWith(m, [['chats', 'ChatGPT']]), consent: () => false });
  await turnedDown(rows);
  assert.deepEqual(opened, []);
  assert.match(screen, /if \(!on && modalAnswer\.current\) answerChain\(groupRows\(modalAnswer\.current\.group\[0\]\), 'dropped'\);/);
});

test('"Checking…" while a check runs on its own; "Waiting for macOS…" only when the Keychain modal\'s Continue started it', async () => {
  const m = await model();
  const found = { apps: { ChatGPT: { found: true } } };
  const checking = { status: 'checking', browser: '' };
  assert.deepEqual(m.rowLabel('ChatGPT', { found, signIn: checking }), { text: 'Checking…', tone: 'busy' });
  assert.deepEqual(m.rowLabel('ChatGPT', { found, signIn: checking, keychain: true }), { text: 'Waiting for macOS…', tone: 'busy' });
  assert.match(screen, /const keychainApps = keychainRun \? keychainRun\.rows\.flatMap\(\(row\) => sharesSignIn\(row\.app\)\) : \[\];/);
  assert.match(screen, /signIn: id \? signInOf\(id, app\) : null, keychain: keychainApps\.includes\(app\),/);
});
