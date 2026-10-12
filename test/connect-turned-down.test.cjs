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

test('the screen opens the chain after Not now, after Deny at a check, and after Deny at Continue\'s unlock, and nowhere else', () => {
  const calls = [...screen.matchAll(/void turnedDown\(([^)]*)\)/g)].map((match) => match[1]);
  assert.deepEqual(calls, ['[{ id, app }]', 'viaBrowser', 'rows'], 'checkSignIn\'s refusal, allowSignIns\' refused unlock, declineSignIns');
  assert.match(screen, /if \(out\.status === 'refused'\) void turnedDown\(\[\{ id, app \}\]\)/);
  assert.match(screen, /const declineSignIns = [\s\S]*?void turnedDown\(rows\);\n  \};/);
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
  assert.equal(m.SOURCES[m.SOURCES.length - 1].id, 'code', 'Code is the last source');
  const box = screen.slice(screen.indexOf('<div data-connect-sources-box="1"'));
  assert.match(box, /^<div data-connect-sources-box="1"[^\n]*>\n\s*\{sourcesList\}\n\s*<div data-connect-consent-at="after-code"[^\n]*>\{consentCard\}<\/div>/, 'right after the sources, inside their scrolling box');
  assert.equal(screen.match(/\{consentCard\}/g).length, 1, 'not pinned above the foot as well');
});

test('the starting screen: the dots, the title and the count, no line moving through the jobs', async () => {
  const m = await model();
  assert.equal(m.startingLines, undefined);
  assert.equal(m.STARTING_LINE_MS, undefined);
  assert.doesNotMatch(screen, /CyclingLine|startingLines|STARTING_LINE_MS|data-connect-starting-line/);
  const starting = screen.slice(screen.indexOf('function Starting('), screen.indexOf('\n}\n', screen.indexOf('function Starting(')));
  assert.match(starting, /<ThinkingDots/);
  assert.match(starting, /Getting to know your library/);
  assert.match(starting, /looked at/);
});
