'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGoogle, WEEK, DOC } = require('../src/main/google/connection.cjs');
const { readGoogleSettings } = require('../src/main/google/settings.cjs');

const credentials = { clientId: 'test.apps.googleusercontent.com', clientSecret: 'registration' };
const crypt = { available: () => true, encrypt: s => Buffer.from([...s].reverse().join('')).toString('base64'), decrypt: s => [...Buffer.from(s, 'base64').toString()].reverse().join('') };
const reply = (status, data) => ({ ok: status === 200, status, json: async () => data });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await settle(); } throw new Error('Did not settle'); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); promise.catch(() => {}); return { promise, resolve, reject }; }
const tokens = { access: 'private-access', refresh: 'private-refresh', expiresIn: 3600 };
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'google-connection-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const flow = deferred(), opened = [], changes = [], calls = [];
  const clock = { time: Date.parse('2026-09-27T12:00:00Z') };
  const auth = { start: async () => ({ url: 'https://accounts.google.com/authorize', result: flow.promise, cancel: () => flow.reject(new Error('cancelled')) }), refresh: async () => ({ ...tokens, access: 'renewed-access' }) };
  const opts = { settings: () => credentials, file: path.join(root, 'google.json'), crypt, auth, now: () => clock.time,
    openExternal: url => opened.push(url), onChange: status => changes.push(status),
    fetch: async (url, init) => {
      calls.push({ url: new URL(url), init });
      if (new URL(url).pathname.endsWith('/about')) return reply(200, { user: { permissionId: 'account-1', emailAddress: 'user@example.com', displayName: 'User' } });
      return extra.list ? extra.list(new URL(url), init) : reply(200, { files: [] });
    }, ...extra };
  delete opts.list;
  const google = createGoogle(opts); t.after(() => google.close());
  return { google, opts, flow, opened, changes, calls, clock, root, file: opts.file, auth };
}
async function connect(f) { await f.google.connect(); f.flow.resolve(tokens); await until(() => f.google.status().connected); }

test('configuration accepts a Desktop client file and explicit env overrides, never a web registration', t => {
  const f = fixture(t), file = path.join(f.root, 'google-client.json');
  assert.equal(readGoogleSettings(f.root, {}).clientId, '');
  fs.writeFileSync(file, JSON.stringify({ installed: { client_id: credentials.clientId, client_secret: credentials.clientSecret, token_uri: 'https://attacker.test' } }));
  assert.deepEqual(readGoogleSettings(f.root, {}), credentials);
  assert.deepEqual(readGoogleSettings('/missing', { ENGELBART_GOOGLE_CLIENT_FILE: file }), credentials);
  assert.equal(readGoogleSettings(f.root, { ENGELBART_GOOGLE_CLIENT_ID: 'override.apps.googleusercontent.com' }).clientId, 'override.apps.googleusercontent.com');
  fs.writeFileSync(file, JSON.stringify({ web: { client_id: credentials.clientId } }));
  assert.equal(readGoogleSettings(f.root, {}).clientId, '');
});

test('no automatic auth; explicit connection persists encrypted and restores after restart without signing in', async t => {
  const f = fixture(t);
  assert.equal(f.google.status().connected, false); assert.equal(f.opened.length, 0);
  await Promise.all([f.google.connect(), f.google.connect()]);
  assert.equal(f.opened.length, 1);
  assert.deepEqual(f.google.status().pending, { kind: 'browser' });
  await f.google.reopen(); assert.equal(f.opened.length, 2);
  f.flow.resolve(tokens); await until(() => f.google.status().connected);
  assert.equal(f.google.status().account.email, 'user@example.com');
  assert.equal(f.google.status().persisted, true);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /private-access|private-refresh|user@example/);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(f.changes), /private-access|private-refresh|registration/);
  const restarted = createGoogle(f.opts);
  assert.equal(restarted.status().account.id, 'account-1');
  await restarted.documents(); assert.equal(f.opened.length, 2);
  restarted.disconnect();
  assert.equal(fs.existsSync(f.file), false);
  assert.equal(createGoogle(f.opts).status().connected, false);
});

test('recent Docs query paginates empty pages, filters stale/wrong/trashed records, deduplicates and sorts', async t => {
  const recent = new Date(Date.parse('2026-09-27T12:00:00Z') - 1000).toISOString();
  const f = fixture(t, { list: url => {
    const page = url.searchParams.get('pageToken');
    if (!page) return reply(200, { files: [], nextPageToken: 'next' });
    if (page === 'next') return reply(200, { files: [
      { id: 'new', name: 'Newest', mimeType: DOC, modifiedTime: recent, resourceKey: 'resource' },
      { id: 'old', name: 'Too old', mimeType: DOC, modifiedTime: '2026-09-01T00:00:00Z' },
      { id: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: recent },
      { id: 'trash', mimeType: DOC, trashed: true, modifiedTime: recent },
      { id: '../evil', mimeType: DOC, modifiedTime: recent },
    ], nextPageToken: 'last' });
    return reply(200, { files: [
      { id: 'new', name: 'Newest', mimeType: DOC, modifiedTime: recent, resourceKey: 'resource' },
      { id: 'edge', name: 'Boundary', mimeType: DOC, modifiedTime: '2026-09-20T12:00:00Z' },
    ] });
  } });
  await connect(f);
  const list = await f.google.documents();
  assert.deepEqual(list.documents.map(doc => doc.id), ['new', 'edge']);
  assert.equal(list.incomplete, false);
  assert.equal(list.documents[0].url, 'https://docs.google.com/document/d/new/edit?resourcekey=resource');
  const queries = f.calls.filter(call => call.url.pathname.endsWith('/files'));
  assert.equal(queries.length, 3);
  assert.equal(queries[0].url.searchParams.get('q'), `trashed = false and mimeType = '${DOC}' and modifiedTime >= '2026-09-20T12:00:00.000Z'`);
  assert.equal(queries[0].url.searchParams.get('orderBy'), 'modifiedTime desc');
  assert.equal(queries[0].url.searchParams.get('includeItemsFromAllDrives'), 'true');
  assert.equal(queries[0].init.headers.authorization, 'Bearer private-access');
  f.clock.time += WEEK;
  assert.equal((await f.google.documents()).documents.length, 0, 'the cutoff rolls forward');
});

test('empty lists, partial results, repeated page tokens, rate limits and API permissions are explicit', async t => {
  let mode = 'empty', calls = 0;
  const f = fixture(t, { list: () => { calls++; return mode === 'empty' ? reply(200, { files: [] }) : mode === 'loop' ? reply(200, { files: [], nextPageToken: 'same' }) : mode === 'partial' ? reply(200, { files: [], incompleteSearch: true }) : reply(Number(mode), {}); } });
  await connect(f);
  assert.deepEqual((await f.google.documents()).documents, []);
  mode = 'loop'; calls = 0; assert.equal((await f.google.documents()).incomplete, true); assert.equal(calls, 2);
  mode = 'partial'; assert.equal((await f.google.documents()).incomplete, true);
  mode = '403'; await assert.rejects(f.google.documents(), /Drive API/);
  mode = '429'; await assert.rejects(f.google.documents(), /too many/);
  mode = '503'; await assert.rejects(f.google.documents(), /Check your connection/);
  assert.equal(f.google.status().connected, true, 'transient failures retain the account');
});

test('expired access refreshes once for concurrent lists; restart uses the encrypted refresh token', async t => {
  const f = fixture(t); await connect(f);
  let refreshes = 0;
  f.auth.refresh = async (_credentials, refresh) => { refreshes++; assert.equal(refresh, tokens.refresh); await settle(); return { ...tokens, access: 'fresh', refresh: null }; };
  f.clock.time += 3600000;
  const restarted = createGoogle(f.opts);
  await Promise.all([restarted.documents(), restarted.documents()]);
  assert.equal(refreshes, 1);
  const data = JSON.parse(crypt.decrypt(JSON.parse(fs.readFileSync(f.file)).encrypted));
  assert.equal(data.refresh, tokens.refresh);
  assert.equal(data.access, 'fresh');
});

test('401 retries with refresh; revoked refresh clears credentials and asks to reconnect', async t => {
  const f = fixture(t, { list: (_url, init) => init.headers.authorization === 'Bearer private-access' ? reply(401, {}) : reply(200, { files: [] }) });
  await connect(f);
  await f.google.documents();
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/files')).length, 2);
  f.auth.refresh = async () => { throw Object.assign(new Error('revoked'), { code: 'invalid_grant' }); };
  f.clock.time += 3600000;
  await assert.rejects(f.google.documents(), /revoked/);
  assert.equal(f.google.status().connected, false);
  assert.match(f.google.status().error, /Connect again/);
  assert.equal(fs.existsSync(f.file), false);
});

test('cancel during auth start or account lookup and disconnect during list/refresh reject stale results', async t => {
  const starting = deferred(), f = fixture(t, { auth: { start: () => starting.promise } });
  let cancelled = false;
  const connecting = f.google.connect(); f.google.cancel();
  starting.resolve({ cancel: () => { cancelled = true; } }); await connecting;
  assert.equal(cancelled, true); assert.equal(f.opened.length, 0);

  const profile = deferred(), p = fixture(t, { fetch: () => profile.promise });
  await p.google.connect(); p.flow.resolve(tokens); await settle(); p.google.cancel();
  profile.resolve(reply(200, { user: { permissionId: 'late', emailAddress: 'late@example.com' } })); await settle();
  assert.equal(p.google.status().connected, false); assert.equal(fs.existsSync(p.file), false);

  const listing = deferred(), d = fixture(t, { list: () => listing.promise }); await connect(d);
  const list = d.google.documents(); await settle(); d.google.disconnect();
  listing.resolve(reply(200, { files: [] })); await assert.rejects(list, /Connect Google/);

  const refreshing = deferred(), r = fixture(t); await connect(r);
  r.auth.refresh = () => refreshing.promise; r.clock.time += 3600000;
  const read = r.google.documents(); await settle(); r.google.disconnect();
  refreshing.resolve(tokens); await assert.rejects(read, /Connect Google/);
  assert.equal(r.google.status().connected, false); assert.equal(fs.existsSync(r.file), false);
});

test('missing registration, unavailable keychain, corrupt storage and browser errors have honest states', async t => {
  const unconfigured = fixture(t, { settings: () => ({}) });
  assert.equal(unconfigured.google.status().configured, false);
  await assert.rejects(unconfigured.google.connect(), /not configured/);
  assert.equal(unconfigured.opened.length, 0);
  const memory = fixture(t, { crypt: { available: () => false } }); await connect(memory);
  assert.equal(memory.google.status().persisted, false); assert.equal(fs.existsSync(memory.file), false);
  const broken = fixture(t); fs.writeFileSync(broken.file, 'corrupt');
  assert.equal(broken.google.status().connected, false);
  const browser = fixture(t, { openExternal: () => { throw new Error('OS failed'); } });
  await browser.google.connect();
  assert.equal(browser.google.status().pending, null); assert.match(browser.google.status().error, /open your browser/);
});
