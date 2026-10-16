'use strict';

// Connect your library's choose screen, after a second test run of onboarding (2026-10-12): a browser's sign-ins turned
// down (Not now, Deny at macOS's prompt) opens Engelbart's sign-in window by itself, one sign-in group after another, until
// a window is closed; a row's sign-in label only while it is ticked; no Gmail line; the consent card under the Code row,
// in the sources' list; no line moving through the jobs on the starting screen. src/renderer/model/connect.js signInChain,
// signInWindows, shownSignIn; src/renderer/screens/ConnectLibrary.jsx. (The screen itself: scripts/smoke-connect.cjs.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const model = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/connect.js')).href);
const screen = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/ConnectLibrary.jsx'), 'utf8');

/** The choose screen's picks with `rows` ([id, app]) ticked. */
async function picksWith(m, rows) {
  let state = m.initialPicks({ apps: {} });
  for (const [id, app] of rows) state = m.tickRow(state, id, app, true);
  return state;
}

test('signInChain: one window per sign-in group, in the order turned down, the ticked and not signed in only; none with the consent off', async () => {
  const m = await model();
  const rows = [{ id: 'chats', app: 'Claude' }, { id: 'notes', app: 'Google Docs' }, { id: 'email', app: 'Gmail' }, { id: 'chats', app: 'Gemini' }, { id: 'chats', app: 'Grok' }];
  const state = await picksWith(m, rows.map((row) => [row.id, row.app]));
  assert.deepEqual(m.signInChain(rows, { state }).map((row) => row.app), ['Claude', 'Google Docs', 'Grok'], 'Gmail and Gemini share Google Drive\'s window');
  assert.deepEqual(m.signInChain(rows, { state, signIns: { Gmail: { status: 'signed-in', browser: '' } } }).map((row) => row.app), ['Claude', 'Grok'], 'Google signed in: no Google window');
  assert.deepEqual(m.signInChain(rows, { state: m.tickRow(state, 'chats', 'Claude', false) }).map((row) => row.app), ['Google Docs', 'Grok'], 'unticked meanwhile: left out');
  assert.deepEqual(m.signInChain(rows, { state, consent: false }), [], 'nothing opens while the consent is off');
  assert.deepEqual(m.signInChain([], { state }), []);
});

/** signInWindows with windows the test answers: open(row) waits until `answer(app, status)`. */
function chainOf(m, { signIns = {}, state = null, consent = () => true } = {}) {
  const opened = [];
  const waiting = new Map();
  const turnedDown = m.signInWindows({
    pick: (rows) => m.signInChain(rows, { signIns, state, consent: consent() }),
    open: (row) => new Promise((resolve) => { opened.push(row.app); waiting.set(row.app, resolve); }),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const answer = async (app, status) => {
    if (status === 'signed-in') for (const other of m.sharesSignIn(app)) signIns[other] = { status: 'signed-in', browser: '' };
    waiting.get(app)(status);
    await settle();
  };
  return { turnedDown, opened, answer, settle };
}

test('Not now: the first app turned down gets its window by itself; signed in, the next; then none is left', async () => {
  const m = await model();
  const rows = [{ id: 'chats', app: 'Claude' }, { id: 'notes', app: 'Google Docs' }, { id: 'email', app: 'Gmail' }];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows.map((row) => [row.id, row.app])) });
  const done = turnedDown(rows);
  await settle();
  assert.deepEqual(opened, ['Claude'], 'one window at a time');
  await answer('Claude', 'signed-in');
  assert.deepEqual(opened, ['Claude', 'Google Docs']);
  await answer('Google Docs', 'signed-in');
  await done;
  assert.deepEqual(opened, ['Claude', 'Google Docs'], 'Gmail signed in with Google Drive: no window of its own');
});

test('Deny at macOS\'s prompt: apps turned down while a window is open wait their turn; a site turning it away moves on too', async () => {
  const m = await model();
  const rows = [['chats', 'Perplexity'], ['chats', 'Grok'], ['notes', 'Google Docs'], ['chats', 'Gemini']];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows) });
  const first = turnedDown([{ id: 'chats', app: 'Perplexity' }]);
  await settle();
  void turnedDown([{ id: 'chats', app: 'Grok' }]); // a check refused a moment later
  void turnedDown([{ id: 'chats', app: 'Perplexity' }]); // the one open now: not again
  await settle();
  assert.deepEqual(opened, ['Perplexity']);
  await answer('Perplexity', 'signed-in');
  assert.deepEqual(opened, ['Perplexity', 'Grok']);
  void turnedDown([{ id: 'notes', app: 'Google Docs' }, { id: 'chats', app: 'Gemini' }]);
  await answer('Grok', 'rejected'); // Google or X turning it away is not the person closing it
  assert.deepEqual(opened, ['Perplexity', 'Grok', 'Google Docs']);
  await answer('Google Docs', 'signed-in');
  await first;
  assert.deepEqual(opened, ['Perplexity', 'Grok', 'Google Docs']);
});

test('a window closed without signing in stops the chain: the rest never open, and a later Not now starts afresh', async () => {
  const m = await model();
  const rows = [{ id: 'chats', app: 'Claude' }, { id: 'chats', app: 'Grok' }, { id: 'chats', app: 'ChatGPT' }];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows.map((row) => [row.id, row.app])) });
  const done = turnedDown(rows);
  await settle();
  await answer('Claude', 'closed');
  await done;
  await settle();
  assert.deepEqual(opened, ['Claude'], 'Grok\'s and ChatGPT\'s windows never open; their rows keep Sign in');
  const again = turnedDown([{ id: 'chats', app: 'ChatGPT' }]);
  await settle();
  assert.deepEqual(opened, ['Claude', 'ChatGPT'], 'not the old ones: only what was turned down now');
  await answer('ChatGPT', 'signed-in');
  await again;
});

test('the consent off: nothing opens, and turned off mid-chain, the next does not open', async () => {
  const m = await model();
  let on = false;
  const rows = [{ id: 'chats', app: 'Claude' }, { id: 'chats', app: 'Grok' }];
  const { turnedDown, opened, answer, settle } = chainOf(m, { state: await picksWith(m, rows.map((row) => [row.id, row.app])), consent: () => on });
  await turnedDown(rows);
  assert.deepEqual(opened, []);
  on = true;
  const done = turnedDown(rows);
  await settle();
  on = false;
  await answer('Claude', 'signed-in');
  await done;
  assert.deepEqual(opened, ['Claude']);
});

test('a window that fails to open counts as closed', async () => {
  const m = await model();
  const opened = [];
  const turnedDown = m.signInWindows({ pick: (rows) => m.signInChain(rows), open: async (row) => { opened.push(row.app); throw new Error('gone'); } });
  await turnedDown([{ id: 'chats', app: 'Claude' }, { id: 'chats', app: 'Grok' }]);
  assert.deepEqual(opened, ['Claude']);
});

test('the screen opens the chain after a new tick not signed in, Not now, Deny at a check, at Continue\'s unlock and at the browser route, and nowhere else', () => {
  const calls = [...screen.matchAll(/void turnedDown\(([^)]*)\)/g)].map((match) => match[1]);
  assert.deepEqual(calls, ['[{ id, app }]', 'viaBrowser', 'rows', '[{ id, app }]'], 'checkSignIn\'s refusal or new tick not signed in (opensSignIn), allowSignIns\' refused unlock, declineSignIns, browserSignIn\'s refusal in the chain');
  assert.match(screen, /if \(opensSignIn\(out\.status, \{ fresh: open, consent: consentRef\.current, still: ticked\(picksRef\.current, id, app\) \}\)\) void turnedDown\(\[\{ id, app \}\]\)/);
  assert.match(screen, /const declineSignIns = [\s\S]*?void turnedDown\(rows\);\n    answerChain\(rows, 'declined'\);\n  \};/);
  assert.match(screen, /if \(out && out\.status === 'refused'\) \{\n[^\n]*status: 'refused'[^\n]*\n\s*void turnedDown\(viaBrowser\);/);
  assert.match(screen, /consent: consentRef\.current/, 'the chain reads the consent as it is when each window would open');
});

test('a row\'s sign-in label only while it is ticked: Google Drive signed in, an unticked Gmail says nothing of it, ticked it says ✓ at once', async () => {
  const m = await model();
  const signIns = Object.fromEntries(m.sharesSignIn('Google Docs').map((app) => [app, { status: 'signed-in', browser: '' }]));
  assert.ok(signIns.Gmail && signIns['Google Meet'] && signIns.Gemini, 'one Google sign-in signs them all in, and is kept');
  const found = { apps: { Gmail: { found: true }, 'Google Docs': { found: true } } };
  const drive = await picksWith(m, [['notes', 'Google Docs']]);
  const label = (state, id, app) => m.rowLabel(app, { found, signIn: m.shownSignIn(state, id, app, signIns) });
  assert.deepEqual(label(drive, 'notes', 'Google Docs'), { text: '✓ Signed in', tone: 'ok' });
  assert.equal(m.shownSignIn(drive, 'email', 'Gmail', signIns), null);
  assert.deepEqual(label(drive, 'email', 'Gmail'), m.rowLabel('Gmail', { found, signIn: null }), 'unticked: what it says with no sign-in');
  assert.doesNotMatch(label(drive, 'email', 'Gmail').text, /Signed in/);
  assert.deepEqual(label(m.tickRow(drive, 'email', 'Gmail', true), 'email', 'Gmail'), { text: '✓ Signed in', tone: 'ok' }, 'ticked later: ✓ at once');
  // The rest of signInLabel's words too: "Waiting for macOS…", "macOS didn't allow it"…, only while ticked.
  const waiting = { ChatGPT: { status: 'checking', browser: '' }, Claude: { status: 'refused', browser: 'Chrome' } };
  const none = m.initialPicks({ apps: {} });
  assert.equal(m.shownSignIn(none, 'chats', 'ChatGPT', waiting), null);
  assert.equal(m.shownSignIn(none, 'chats', 'Claude', waiting), null, 'an unticked refused row too');
  assert.deepEqual(m.shownSignIn(m.tickRow(none, 'chats', 'Claude', true), 'chats', 'Claude', waiting), waiting.Claude);
  assert.match(screen, /const signInOf = \(id, app\) => shownSignIn\(picks, id, app, signIns\);/, 'the screen\'s rows use it');
});

test('no Gmail line, and the consent card directly under the Code row, in the sources\' list', async () => {
  const m = await model();
  assert.equal(m.gmailConsent, undefined);
  assert.doesNotMatch(screen, /gmailConsent|data-connect-gmail-consent|Engelbart searches your Gmail/);
  // Other follows Code since 2026-10-16 (Linear's category): the card still comes right after the list.
  assert.deepEqual(m.SOURCES.slice(-2).map((source) => source.id), ['code', 'other'], 'Code, then Other, are the last sources');
  const box = screen.slice(screen.indexOf('<div data-connect-sources-box="1"'));
  assert.match(box, /^<div data-connect-sources-box="1"[^\n]*>\n\s*\{sourcesList\}\n\s*<div data-connect-consent-at="after-code"[^\n]*>\{consentCard\}<\/div>/, 'right after the sources, inside their scrolling box');
  assert.equal(screen.match(/\{consentCard\}/g).length, 1, 'not pinned above the foot as well');
});

test('the starting screen: the dots and the title, no count and no line moving through the jobs', async () => {
  const m = await model();
  assert.equal(m.startingLines, undefined);
  assert.equal(m.STARTING_LINE_MS, undefined);
  assert.doesNotMatch(screen, /CyclingLine|startingLines|STARTING_LINE_MS|data-connect-starting-line/);
  const starting = screen.slice(screen.indexOf('function Starting('), screen.indexOf('\n}\n', screen.indexOf('function Starting(')));
  assert.match(starting, /<ThinkingDots/);
  assert.match(starting, /Getting to know your library/);
  // The count is gone (2026-10-13, the Onboarding workspace: "Remove the 'looked at' counter").
  assert.doesNotMatch(starting, /looked at/);
});

// Engelbart's sign-in window closed without signing in (2026-10-12, third run): a no. The app and every ticked app
// sharing its sign-in are unticked, not left ticked with a Sign in that Bring these in asks for again; the rest keep theirs.
// src/renderer/model/connect.js signInWindowClosed; src/renderer/screens/ConnectLibrary.jsx signInWindowHere.

test('closed without signing in: the window\'s app and every ticked app sharing its sign-in are unticked, the others not', async () => {
  const m = await model();
  const state = await picksWith(m, [['notes', 'Google Docs'], ['email', 'Gmail'], ['chats', 'Gemini'], ['chats', 'Claude']]);
  const signIns = {
    'Google Docs': { status: 'signing', browser: '', was: { status: 'refused', browser: 'Chrome' } },
    Gmail: { status: 'refused', browser: 'Chrome' },
    Gemini: { status: 'declined', browser: '' },
    Claude: { status: 'declined', browser: '' },
  };
  const out = m.signInWindowClosed(state, 'Google Docs', signIns);
  for (const [id, app] of [['notes', 'Google Docs'], ['email', 'Gmail'], ['chats', 'Gemini']]) assert.equal(m.ticked(out.state, id, app), false, `${app} unticked`);
  assert.equal(m.ticked(out.state, 'chats', 'Claude'), true, 'another sign-in keeps its tick');
  assert.equal(m.ticked(out.state, 'transcripts', 'Google Meet'), false, 'one not ticked stays unticked');
  // Nothing stale: the window's row goes back as afterSignInWindowClosed says, the others' old failures to plain Sign in.
  assert.deepEqual(out.signIns['Google Docs'], { status: 'signed-out', browser: '' }, 'not "macOS didn\'t allow it"');
  assert.deepEqual(out.signIns.Gmail, { status: 'signed-out', browser: '' });
  assert.deepEqual(out.signIns.Gemini, signIns.Gemini);
  assert.deepEqual(out.signIns.Claude, signIns.Claude, 'another sign-in\'s state is its own');
  for (const [id, app] of [['notes', 'Google Docs'], ['email', 'Gmail']]) assert.equal(m.shownSignIn(out.state, id, app, out.signIns), null, `${app} unticked says nothing`);
  assert.deepEqual(state, await picksWith(m, [['notes', 'Google Docs'], ['email', 'Gmail'], ['chats', 'Gemini'], ['chats', 'Claude']]), 'the state given is not changed');
  // Nothing before the window: no sign-in left for it.
  const fresh = m.signInWindowClosed(await picksWith(m, [['chats', 'ChatGPT']]), 'ChatGPT', { ChatGPT: { status: 'signing', browser: '' } });
  assert.equal(fresh.signIns.ChatGPT, undefined);
  assert.equal(m.ticked(fresh.state, 'chats', 'ChatGPT'), false);
});

test('ticked again after the window was closed: its sign-in starts again, and the row says plain Sign in meanwhile', async () => {
  const m = await model();
  const state = await picksWith(m, [['chats', 'Perplexity']]);
  const out = m.signInWindowClosed(state, 'Perplexity', { Perplexity: { status: 'signing', browser: '', was: { status: 'refused', browser: 'Chrome' } } });
  const again = m.tickRow(out.state, 'chats', 'Perplexity', true);
  assert.deepEqual(m.newlyTickedWeb(out.state, again), [{ id: 'chats', app: 'Perplexity' }], 'a newly ticked web app: the screen checks its sign-in, as any tick does');
  assert.deepEqual(m.signInsToCheck(true, m.newlyTickedWeb(out.state, again)), [{ id: 'chats', app: 'Perplexity' }]);
  const label = m.rowLabel('Perplexity', { found: { apps: { Perplexity: { found: true } } }, signIn: m.shownSignIn(again, 'chats', 'Perplexity', out.signIns) });
  assert.deepEqual(label, { text: '', tone: '', signIn: true }, 'Sign in, not "macOS didn\'t allow it"');
  // The screen: ticking a web app checks it (toggleApp), and a check refused opens the window again (checkSignIn).
  assert.match(screen, /const toggleApp = [\s\S]*?else if \(spec\.reach === 'web'\) checkTicked\(\[\{ id, app \}\]\);/);
});

test('the chain: a closed window unticks its own sign-in group only; apps waiting their turn keep their tick and Sign in', async () => {
  const m = await model();
  const rows = [{ id: 'notes', app: 'Google Docs' }, { id: 'email', app: 'Gmail' }, { id: 'chats', app: 'Grok' }, { id: 'chats', app: 'ChatGPT' }];
  let state = await picksWith(m, rows.map((row) => [row.id, row.app]));
  let signIns = Object.fromEntries(rows.map((row) => [row.app, { status: 'declined', browser: '' }]));
  const opened = [];
  let close;
  // As the screen's window does: 'signing' while open; closed, signInWindowClosed.
  const turnedDown = m.signInWindows({
    pick: (more) => m.signInChain(more, { signIns, state }),
    open: (row) => new Promise((resolve) => {
      opened.push(row.app);
      signIns = { ...signIns, [row.app]: { status: 'signing', browser: '', was: signIns[row.app] } };
      close = () => { ({ state, signIns } = m.signInWindowClosed(state, row.app, signIns)); resolve('closed'); };
    }),
  });
  const done = turnedDown(rows);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, ['Google Docs']);
  close();
  await done;
  assert.deepEqual(opened, ['Google Docs'], 'the chain still stops at a closed window');
  assert.equal(m.ticked(state, 'notes', 'Google Docs'), false);
  assert.equal(m.ticked(state, 'email', 'Gmail'), false, 'Gmail shares the window\'s sign-in: unticked with it');
  const found = { apps: Object.fromEntries(rows.map((row) => [row.app, { found: true }])) };
  for (const app of ['Grok', 'ChatGPT']) {
    assert.equal(m.ticked(state, 'chats', app), true, `${app}, waiting its turn, keeps its tick`);
    assert.deepEqual(m.rowLabel(app, { found, signIn: m.shownSignIn(state, 'chats', app, signIns) }), { text: '', tone: '', signIn: true }, `${app} keeps Sign in`);
  }
});

test('signed in stays ticked with ✓, and Google refusing the sign-in stays ticked with Try again: only closed unticks', async () => {
  const m = await model();
  const found = { apps: { Gmail: { found: true }, 'Google Docs': { found: true } } };
  const state = await picksWith(m, [['notes', 'Google Docs'], ['email', 'Gmail']]);
  const signedIn = Object.fromEntries(m.sharesSignIn('Google Docs').map((app) => [app, { status: 'signed-in', browser: '' }]));
  assert.deepEqual(m.rowLabel('Gmail', { found, signIn: m.shownSignIn(state, 'email', 'Gmail', signedIn) }), { text: '✓ Signed in', tone: 'ok' });
  const rejected = Object.fromEntries(m.sharesSignIn('Google Docs').map((app) => [app, { status: 'rejected', browser: '' }]));
  assert.deepEqual(m.rowLabel('Google Docs', { found, signIn: m.shownSignIn(state, 'notes', 'Google Docs', rejected) }), { text: 'Google refused this sign-in', tone: 'error', retry: true });
  // The screen's window: signed in and rejected return, ticked, before the closed branch's unticking.
  const here = screen.match(/const signInWindowHere = async \(id, app\) => \{[\s\S]*?\n  \};/)[0];
  const at = (pattern) => here.search(pattern);
  assert.ok(at(/setRow\(id, app, true\);/) >= 0, 'opening it ticks the row');
  assert.ok(at(/return 'signed-in';/) >= 0 && at(/return 'rejected';/) >= 0);
  assert.ok(at(/return 'signed-in';/) < at(/signInWindowClosed\(/) && at(/return 'rejected';/) < at(/signInWindowClosed\(/), 'signed in and rejected never reach the unticking');
  assert.equal((here.match(/setPicks\(/g) || []).length, 1, 'one place unticks: the person closing the window');
  assert.match(here, /setPicks\(\(now\) => signInWindowClosed\(now, app\)\.state\);\n\s*setSignIns\(\(now\) => signInWindowClosed\(null, app, now\)\.signIns\);\n\s*return 'closed';/);
});
