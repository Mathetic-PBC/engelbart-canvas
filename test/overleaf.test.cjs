'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotOverleaf } = require('../src/main/overleaf/project-page.cjs');
const { createOverleafBrowser } = require('../src/main/overleaf/browser-connection.cjs');
const { projectPage } = require('../src/main/overleaf/browser-reader.cjs');
const origin = 'https://www.overleaf.com';
const account = { id: '0123456789abcdef01234567', email: 'reader@example.com' };
const project = (id = 1, extra = {}) => ({ id: id.toString(16).padStart(24, '0'), name: `Project ${id}`, lastUpdated: '2026-09-20T10:00:00.000Z', archived: false, trashed: false, ...extra });
function snapshot(projects, extra = {}, location = {}, accountOnly = false) {
  const metas = { 'ol-user_id': JSON.stringify(account.id), 'ol-usersEmail': account.email,
    'ol-prefetchedProjectsBlob': JSON.stringify({ totalSize: projects.length, projects }), ...extra };
  const result = vm.runInNewContext(`(${snapshotOverleaf.toString()})(${accountOnly})`, {
    location: { origin, pathname: '/project', search: '', ...location },
    document: { querySelector: selector => { const name = selector.match(/name="([^"]+)"/)[1]; return metas[name] === undefined ? null : { content: metas[name] }; } },
  });
  return JSON.parse(JSON.stringify(result));
}
test('Overleaf catalog includes old, shared and archived projects, excludes trash, and sorts newest first', () => {
  const value = snapshot([project(1, { owner: { email: 'collaborator@example.com' }, privateExtra: 'never export' }),
    project(2, { lastUpdated: '2026-09-26T10:00:00.000Z' }), project(3, { archived: true }), project(4, { trashed: true })]);
  assert.equal(value.kind, 'ready'); assert.deepEqual(value.account, account);
  assert.deepEqual(value.projects.map(p => p.id), [2, 1, 3].map(id => project(id).id));
  assert.doesNotMatch(JSON.stringify(value), /collaborator|never export|owner/);
  assert.equal(snapshot([]).kind, 'ready');
  assert.equal(snapshot(Array.from({ length: 75 }, (_, i) => project(i + 1))).projects.length, 75, 'not limited to the visible website rows');
});
test('incomplete or malformed metadata never becomes a successful empty list', () => {
  assert.equal(snapshot([], { 'ol-prefetchedProjectsBlob': undefined }).kind, 'loading');
  assert.equal(snapshot([], { 'ol-prefetchedProjectsBlob': '{' }).kind, 'layout');
  assert.equal(snapshot([], { 'ol-prefetchedProjectsBlob': JSON.stringify({ totalSize: 2, projects: [project()] }) }).kind, 'incomplete');
  assert.equal(snapshot([project(1), project(1)]).kind, 'layout');
  assert.equal(snapshot([project(1, { lastUpdated: 'yesterday' })]).kind, 'layout');
  assert.equal(snapshot([project(1, { id: '../other' })]).kind, 'layout');
});
test('account-only detection and exact origin/path checks isolate listing reads', () => {
  assert.equal(snapshot([], {}, {}, true).kind, 'account');
  assert.equal(snapshot([], {}, { origin: 'https://www.overleaf.com.evil.test' }).kind, 'unavailable');
  assert.equal(snapshot([], {}, { pathname: `/project/${project().id}` }).kind, 'unavailable');
  assert.equal(snapshot([], {}, { pathname: `/project/${project().id}` }, true).kind, 'account');
  assert.equal(snapshot([], {}, { search: '?search=partial' }).kind, 'unavailable');
  assert.equal(snapshot([], { 'ol-user_id': '' }).kind, 'loading');
  assert.equal(snapshot([], { 'ol-user_id': '123456789012345678901234' }, {}, true).account.id, '123456789012345678901234');
  assert.equal(projectPage('https://www.overleaf.com.evil.test/project', origin), false);
});

const crypt = { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'overleaf-'));
  const file = path.join(root, 'catalog.json'), opened = [], clock = { now: Date.now() };
  const item = { ...project(), url: `${origin}/project/${project().id}` };
  const reader = { projectsUrl: () => `${origin}/project`, stageAccount: async () => ({ account }), read: async () => ({ account, projects: [item] }) };
  const opts = { file, crypt, reader, openStage: (url, key) => opened.push({ url, key }), now: () => clock.now, pollMs: 100000, ...extra };
  const connection = createOverleafBrowser(opts);
  t.after(() => { connection.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { connection, reader, file, opts, opened, clock, item };
}
async function connect(f) { await f.connection.connect(); return f.connection.projects(true); }
test('Stage connection reuses sign-in tab, caches locally and restores across instances', async t => {
  const f = fixture(t);
  assert.equal(f.opened.length, 0);
  await f.connection.connect(); await f.connection.reopen();
  assert.equal(f.opened[0].key, f.opened[1].key);
  await f.connection.projects(true);
  assert.equal(f.connection.status().connected, true);
  f.connection.openProject(f.item.id); assert.equal(f.opened.at(-1).url, f.item.url);
  assert.throws(() => f.connection.openProject('unknown'), /no longer/);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /reader@example|Project 1/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const restored = createOverleafBrowser(f.opts); t.after(() => restored.close());
  assert.equal(restored.status().account.id, account.id);
  assert.equal((await restored.projects()).projects.length, 1);
});
test('late reads cannot resurrect cancelled or disconnected connections; requests deduplicate', async t => {
  const f = fixture(t); await f.connection.connect();
  const delayed = deferred(); let reads = 0, signal;
  f.reader.read = options => { reads++; signal = options.signal; return delayed.promise; };
  const a = f.connection.projects(true), b = f.connection.projects(true);
  assert.equal(reads, 1);
  f.connection.cancel(); assert.equal(signal.aborted, true);
  delayed.resolve({ account, projects: [f.item] });
  await assert.rejects(a, /cancelled/); await assert.rejects(b, /cancelled/);
  assert.equal(f.connection.status().connected, false); assert.equal(fs.existsSync(f.file), false);
  f.reader.read = async () => ({ account, projects: [f.item] }); await connect(f);
  const next = deferred(); f.reader.read = () => next.promise;
  const pending = f.connection.projects(true); f.connection.disconnect(); next.resolve({ account, projects: [f.item] });
  await assert.rejects(pending, /cancelled/);
  assert.equal(f.connection.status().connected, false); assert.equal(fs.existsSync(f.file), false);
});
test('failed reads keep the cache; account switches replace it; expired sign-in clears it', async t => {
  const f = fixture(t); await connect(f);
  f.reader.read = async () => { throw Object.assign(new Error('Unrecognized listing'), { code: 'layout' }); };
  await assert.rejects(f.connection.projects(true), /Unrecognized/);
  assert.equal((await f.connection.projects()).projects.length, 1);
  const next = { id: 'fedcba987654321001234567', email: 'other@example.com' };
  f.reader.read = async () => ({ account: next, projects: [] });
  assert.equal((await f.connection.projects(true)).accountId, next.id);
  f.reader.read = async () => { throw Object.assign(new Error('Sign in'), { code: 'login' }); };
  await assert.rejects(f.connection.projects(true), /Sign in/);
  assert.equal(f.connection.status().connected, false); assert.equal(f.connection.status().account, null);
});
test('without encryption only opt-in persists, and first-load errors allow retry', async t => {
  const f = fixture(t, { crypt: { available: () => false } });
  await f.connection.connect();
  const original = f.reader.read; f.reader.read = async () => { throw new Error('Temporary failure'); };
  await assert.rejects(f.connection.projects(true), /Temporary/); assert.ok(f.connection.status().pending);
  f.reader.read = original; await f.connection.projects(true);
  assert.equal(f.connection.status().error, ''); assert.equal(f.connection.status().pending, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { v: 1, enabled: true, encrypted: null });
});

test('old cached projects appear immediately after restart even when refresh fails', async t => {
  const f = fixture(t); await connect(f); f.connection.close();
  f.clock.now += 24 * 60 * 60 * 1000;
  const refresh = deferred(); f.reader.read = () => refresh.promise;
  const restored = createOverleafBrowser(f.opts); t.after(() => restored.close());
  assert.equal((await restored.projects()).projects.length, 1);
  assert.equal(restored.status().loading, true);
  refresh.reject(new Error('Offline'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.status().connected, true);
  assert.equal(restored.status().error, 'Offline');
});

test('cancelling while Stage account discovery is pending never starts a read', async t => {
  const discovered = deferred(), started = deferred(); let reads = 0;
  const f = fixture(t, { pollMs: 1 });
  f.reader.stageAccount = () => { started.resolve(); return discovered.promise; };
  f.reader.read = async () => { reads++; return { account, projects: [] }; };
  await f.connection.connect();
  // Keep the event loop alive while waiting for the controller's unref'd poll.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await started.promise; f.connection.cancel(); discovered.resolve({ account }); await new Promise(resolve => setImmediate(resolve)); }
  finally { clearTimeout(keepAlive); }
  assert.equal(reads, 0); assert.equal(f.connection.status().connected, false);
});
