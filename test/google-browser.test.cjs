'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createGoogleBrowser } = require('../src/main/google/browser-connection.cjs');
const { searchUrl, dateWindow, queryFor, driveUrl } = require('../src/main/google/browser-reader.cjs');
const crypt = { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const account = { id: 'reader@example.com', email: 'reader@example.com', name: 'Reader' };
const doc = { id: 'test-doc-123456', name: 'Recent notes', url: 'https://docs.google.com/document/d/test-doc-123456/edit?authuser=reader%40example.com', modifiedTime: null };
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-browser-'));
  const file = path.join(root, 'google-browser.json');
  const opened = [], calls = [], changes = [], clock = { time: Date.now() };
  const reader = {
    searchUrl,
    stageAccount: async () => ({ account, user: '1' }),
    read: async options => { calls.push(options); return { account, user: options.user, since: options.since, documents: [doc], incomplete: false }; },
  };
  const opts = { file, crypt, reader, openStage: (url, requestKey) => opened.push({ url, requestKey }), onChange: value => changes.push(value), now: () => clock.time, pollMs: 100000, ...extra };
  const google = createGoogleBrowser(opts);
  t.after(() => { google.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { google, reader, opened, calls, changes, clock, file, opts };
}
async function connected(f) { await f.google.connect(); await f.google.documents(true); }

test('Drive search uses the seven-day local calendar and only the Drive host', () => {
  const time = new Date(2026, 8, 27, 14, 40).getTime();
  assert.equal(dateWindow(time), '2026-09-20');
  const url = new URL(searchUrl('1', dateWindow(time)));
  assert.equal(url.pathname, '/drive/u/1/search');
  assert.equal(url.searchParams.get('q'), 'type:document after:2026-09-20');
  assert.equal(url.searchParams.get('hl'), 'en');
  assert.equal(driveUrl('https://drive.google.com.evil.test/drive/u/0/search', 'https://drive.google.com'), false);
});

test('explicit Connect uses Stage without OAuth, reuses pending tab and follows the selected account', async t => {
  const f = fixture(t);
  assert.equal(f.google.status().configured, true); assert.equal(f.google.status().connected, false);
  assert.equal(f.calls.length, 0); assert.equal(f.opened.length, 0);
  await f.google.connect(); await f.google.connect();
  assert.equal(f.opened.length, 2); assert.equal(f.opened[0].requestKey, f.opened[1].requestKey);
  assert.equal(new URL(f.opened[0].url).pathname, '/drive/u/1/search');
  const list = await f.google.documents();
  assert.equal(list.accountId, account.id); assert.equal(list.dateFiltered, true);
  assert.equal(list.documents[0].modifiedTime, null, 'never invent timestamps absent from the grid');
  assert.equal(f.google.status().pending, null); assert.equal(f.google.status().connected, true);
  f.google.openDocument(doc.id); assert.equal(f.opened.at(-1).url, doc.url);
  assert.throws(() => f.google.openDocument('unknown-id'), /no longer/);
});

test('encrypted local metadata survives a new connection instance; refresh rolls the cutoff forward', async t => {
  const f = fixture(t); await connected(f);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /reader@example|Recent notes|test-doc/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  f.google.close();
  const restored = createGoogleBrowser(f.opts); t.after(() => restored.close());
  assert.equal(restored.status().account.id, account.id);
  assert.equal((await restored.documents()).documents.length, 1);
  const prior = f.calls.length;
  f.clock.time += 86400000;
  await restored.documents();
  assert.equal(f.calls.length, prior + 1); assert.equal(f.calls.at(-1).since, dateWindow(f.clock.time));
  assert.equal(f.opened.length, 1, 'refresh/restart does not open a visible tab');
});

test('concurrent refreshes share one reader and a complete empty list replaces stale links', async t => {
  const f = fixture(t); await connected(f);
  const next = deferred(); let reads = 0;
  f.reader.read = () => { reads++; return next.promise; };
  const a = f.google.documents(true), b = f.google.documents(true); await settle();
  assert.equal(reads, 1);
  next.resolve({ account, user: '1', since: dateWindow(), documents: [], incomplete: false });
  assert.equal((await a).documents.length, 0); assert.deepEqual(await a, await b);
});

test('initial listing failure stops polling and an explicit retry clears the error and connects', async t => {
  const f = fixture(t, { pollMs: 5 });
  let reads = 0;
  const first = deferred();
  const original = f.reader.read;
  f.reader.read = async options => { reads++; if (reads === 1) return first.promise; return original(options); };
  await f.google.connect();
  for (let i = 0; i < 100 && !reads; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.google.status().loading, true);
  assert.ok(f.google.status().pending);
  first.reject(Object.assign(new Error('Drive timed out'), { code: 'timeout' }));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(reads, 1, 'no repeated hidden reads after the first failure');
  assert.equal(f.google.status().loading, false);
  assert.equal(f.google.status().error, 'Drive timed out');
  const retry = f.google.documents(true);
  assert.equal(f.google.status().error, '');
  assert.equal(f.google.status().loading, true);
  await retry;
  assert.equal(reads, 2); assert.equal(f.google.status().connected, true);
  assert.equal(f.google.status().pending, null); assert.equal(f.google.status().loading, false);
});

test('cancel during account discovery and disconnect during read cannot resurrect the connection', async t => {
  const f = fixture(t), stage = deferred();
  f.reader.stageAccount = () => stage.promise;
  const connecting = f.google.connect(); f.google.cancel(); stage.resolve({ account, user: '1' }); await connecting;
  assert.equal(f.opened.length, 0); assert.equal(f.google.status().connected, false);
  f.reader.stageAccount = async () => ({ account, user: '1' });
  await connected(f);
  const later = deferred(); let signal;
  f.reader.read = options => { signal = options.signal; return later.promise; };
  const read = f.google.documents(true); await settle(); f.google.disconnect();
  assert.equal(signal.aborted, true);
  later.resolve({ account, user: '1', since: dateWindow(), documents: [doc] });
  await assert.rejects(read, /cancelled/);
  assert.equal(f.google.status().connected, false); assert.equal(fs.existsSync(f.file), false);
  assert.throws(() => f.google.openDocument(doc.id), /Connect/);
  assert.equal(createGoogleBrowser(f.opts).status().connected, false);
});

test('signed-out browser clears links; temporary failures retain the cached list and report an error', async t => {
  const f = fixture(t); await connected(f);
  f.reader.read = async () => { throw Object.assign(new Error('Drive changed its layout'), { code: 'layout' }); };
  await assert.rejects(f.google.documents(true), /layout/);
  assert.equal(f.google.status().connected, true); assert.match(f.google.status().error, /layout/);
  f.reader.read = async () => { throw Object.assign(new Error('Sign in in Stage'), { code: 'login' }); };
  await assert.rejects(f.google.documents(true), /Sign in/);
  assert.equal(f.google.status().connected, false); assert.equal(f.google.status().account, null);
  assert.equal(createGoogleBrowser(f.opts).status().account, null);
});

test('account switches replace the entire list and unavailable encryption stores no metadata', async t => {
  const f = fixture(t, { crypt: { available: () => false } }); await connected(f);
  assert.equal(f.google.status().persisted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { v: 1, enabled: true, encrypted: null });
  const next = { id: 'other@example.com', email: 'other@example.com', name: 'Other' };
  f.reader.stageAccount = async () => ({ account: next, user: '2' });
  f.reader.read = async options => ({ account: next, user: options.user, since: options.since, documents: [], incomplete: false });
  const value = await f.google.documents(true);
  assert.equal(value.accountId, next.id); assert.deepEqual(value.documents, []);
  assert.equal(f.google.status().account.id, next.id);
});
