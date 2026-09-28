'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { accountConfig, paperOf, readLibraryPage } = require('../src/main/zotero/library-page.cjs');
const { createZoteroBrowser } = require('../src/main/zotero/browser-connection.cjs');
const { createZoteroReader, zoteroUrl } = require('../src/main/zotero/browser-reader.cjs');
const { readPage } = require('../src/main/zotero/page-reader.cjs');
const config = { userId: 1234, userSlug: 'reader', apiKey: 'fixtureZoteroKey123456789' };
const account = { id: '1234', name: 'reader' };
const item = { key: 'ABCD1234', data: { title: '<i>Research</i> paper', itemType: 'journalArticle', creators: [{ firstName: 'A', lastName: 'Author' }], date: '2024', dateAdded: '2024-04-01T00:00:00Z' } };
const doc = (value = config) => ({ getElementById: () => ({ textContent: JSON.stringify(value) }), querySelector: () => null });
const origin = 'https://www.zotero.org';
const response = (items, headers = {}, status = 200) => new Response(JSON.stringify(items), { status, headers });

test('Zotero account metadata excludes website credentials and public-library configs', async () => {
  assert.equal(accountConfig(doc({ ...config, apiKey: undefined })), null);
  assert.equal(accountConfig(doc({ ...config, userId: '../other' })), null);
  const result = await readLibraryPage({ start: null, origin }, { doc: doc(), locationUrl: `${origin}/reader/library`, fetcher: () => assert.fail('account probe must not fetch') });
  assert.deepEqual(result, { kind: 'account', account });
  assert.doesNotMatch(JSON.stringify(result), /fixtureZoteroKey/);
});
test('only Zotero or the loopback test origin can read a library', async () => {
  const noFetch = () => assert.fail('wrong origin must not fetch');
  assert.deepEqual(await readLibraryPage({ start: 0, origin }, { doc: doc(), locationUrl: 'https://www.zotero.org.evil.test/', fetcher: noFetch }), { kind: 'unavailable' });
  assert.throws(() => createZoteroReader({ origin: 'https://evil.test' }), /Invalid Zotero/);
  assert.equal(zoteroUrl('https://www.zotero.org.evil.test/', origin), false);
});
test('read-only library request uses a fixed API endpoint and exposes only paper metadata', async () => {
  let sent;
  const value = await readLibraryPage({ start: 0, origin }, { doc: doc(), locationUrl: `${origin}/reader/library`, fetcher: async (url, options) => {
    sent = { url: new URL(url), options };
    return response([item, { key: 'NOTE1234', data: { title: 'Private note', itemType: 'note' } },
      { key: 'FILE1234', data: { title: 'Child PDF', itemType: 'attachment', parentItem: item.key, contentType: 'application/pdf' } }], { 'Total-Results': '3' });
  } });
  assert.equal(sent.url.origin, 'https://api.zotero.org'); assert.equal(sent.url.pathname, '/users/1234/items/top');
  assert.equal(sent.url.searchParams.get('sort'), 'dateAdded'); assert.equal(sent.url.searchParams.get('limit'), '100');
  assert.equal(sent.options.method, 'GET'); assert.equal(sent.options.redirect, 'error');
  assert.equal(sent.options.headers['Zotero-API-Key'], config.apiKey); assert.ok(!sent.url.href.includes(config.apiKey));
  assert.equal(value.papers.length, 1); assert.equal(value.papers[0].name, 'Research paper');
  assert.equal(value.papers[0].authors, 'A Author'); assert.equal(value.papers[0].url, `${origin}/reader/items/ABCD1234/library`);
  assert.equal(value.next, null); assert.doesNotMatch(JSON.stringify(value), /fixtureZoteroKey|Private note/);
});
test('standalone PDFs are papers, child attachments and notes are not duplicated', () => {
  assert.ok(paperOf({ key: 'PDFD1234', data: { title: 'Saved PDF', itemType: 'attachment', contentType: 'application/pdf' } }, account));
  assert.equal(paperOf({ ...item, data: { ...item.data, deleted: 1 } }, account), null);
  assert.equal(paperOf({ ...item, key: '../evil' }, account), null);
});
test('pagination follows total results and next links without trusting returned URLs', async () => {
  const options = { doc: doc(), locationUrl: `${origin}/reader/library`, fetcher: async () => response([item], { 'Total-Results': '101', Link: '<https://evil.test/leak>; rel="next"' }) };
  const value = await readLibraryPage({ start: 100, origin }, options);
  assert.equal(value.next, 101);
  options.fetcher = async () => response([], { 'Total-Results': '101' });
  assert.equal((await readLibraryPage({ start: 100, origin }, options)).kind, 'error');
});
test('expired access, throttling, invalid payloads and concurrent account changes are explicit failures', async () => {
  const options = { doc: doc(), locationUrl: `${origin}/reader/library` };
  assert.equal((await readLibraryPage({ start: 0, origin }, { ...options, fetcher: async () => response({}, {}, 403) })).kind, 'login');
  assert.deepEqual(await readLibraryPage({ start: 0, origin }, { ...options, fetcher: async () => response({}, { 'Retry-After': '90' }, 429) }), { kind: 'rate-limit', backoff: 90 });
  assert.equal((await readLibraryPage({ start: 0, origin }, { ...options, fetcher: async () => response({ error: config.apiKey }) })).kind, 'error');
  const changing = { ...config };
  assert.equal((await readLibraryPage({ start: 0, origin }, { ...options, doc: { getElementById: () => ({ textContent: JSON.stringify(changing) }) }, fetcher: async () => { changing.userId = 555; return response([item]); } })).kind, 'login');
});
test('IPC accepts only a matching request from the requested top frame', async () => {
  const page = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send(channel, request) { this.request = request; } });
  const pending = readPage(page, null, origin);
  page.emit('ipc-message', { senderFrame: {} }, 'zotero:library', page.request.id, { wrong: true });
  page.emit('ipc-message', { senderFrame: page.mainFrame }, 'zotero:library', 'wrong', { wrong: true });
  page.emit('ipc-message', { senderFrame: page.mainFrame }, 'zotero:library', page.request.id, { kind: 'account', account });
  assert.deepEqual(await pending, { kind: 'account', account }); assert.equal(page.listenerCount('ipc-message'), 0);
  const abort = new AbortController(), cancelled = readPage(page, 0, origin, { signal: abort.signal });
  abort.abort(); assert.equal((await cancelled).kind, 'unavailable'); assert.equal(page.listenerCount('destroyed'), 0);
});
function fixture(t, more = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-test-')), opened = [], changes = [];
  const crypt = { available: () => true, encrypt: s => Buffer.from(s).toString('base64'), decrypt: s => Buffer.from(s, 'base64').toString() };
  const reader = { libraryUrl: () => `${origin}/mylibrary`, stageAccount: async () => ({ account }), read: async () => ({ account, papers: [paperOf(item, account)], incomplete: false }) };
  const options = { file: path.join(root, 'catalog.json'), reader, crypt, pollMs: 100000, openStage: (url, key) => opened.push({ url, key }), onChange: value => changes.push(value), ...more };
  const connection = createZoteroBrowser(options);
  t.after(() => { connection.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { connection, reader, options, opened, changes };
}
test('connecting is explicit, reopening preserves the sign-in tab, and cached metadata survives restart', async t => {
  const f = fixture(t);
  assert.equal(f.opened.length, 0); assert.equal(f.connection.status().connected, false);
  await f.connection.connect(); await f.connection.connect();
  assert.equal(f.opened[0].key, f.opened[1].key);
  await f.connection.papers(true); assert.equal(f.connection.status().connected, true);
  f.connection.openPaper(item.key); assert.equal(f.opened.at(-1).url, `${origin}/reader/items/ABCD1234/library`);
  assert.throws(() => f.connection.openPaper('BADKEY00'), /no longer/);
  const saved = fs.readFileSync(f.options.file, 'utf8'); assert.doesNotMatch(saved, /Research|reader|fixtureZoteroKey/);
  const restored = createZoteroBrowser(f.options); t.after(() => restored.close());
  assert.deepEqual(restored.status().account, account); assert.equal((await restored.papers()).papers.length, 1);
});
test('late requests cannot restore a disconnected account or cache', async t => {
  const f = fixture(t); await f.connection.connect();
  let finish; f.reader.read = () => new Promise(resolve => { finish = resolve; });
  const reading = f.connection.papers(true);
  f.connection.disconnect(); finish({ account, papers: [paperOf(item, account)] });
  await assert.rejects(reading, /cancelled/); assert.equal(f.connection.status().connected, false);
  assert.equal(fs.existsSync(f.options.file), false);
});
test('expired sessions clear paper metadata, and switching accounts replaces it', async t => {
  const f = fixture(t); await f.connection.connect(); await f.connection.papers(true);
  f.reader.read = async () => { throw Object.assign(new Error('Sign in again'), { code: 'login' }); };
  await assert.rejects(f.connection.papers(true), /Sign in/);
  assert.equal(f.connection.status().account, null); assert.throws(() => f.connection.openPaper(item.key), /Connect/);
  f.reader.read = async () => ({ account: { id: '555', name: 'other' }, papers: [], incomplete: false });
  const list = await f.connection.papers(true); assert.equal(list.accountId, '555'); assert.deepEqual(list.papers, []);
});
test('cache is not written in plaintext when encryption is unavailable', async t => {
  const f = fixture(t, { crypt: { available: () => false } }); await f.connection.connect(); await f.connection.papers(true);
  assert.equal(f.connection.status().persisted, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.options.file)), { v: 1, enabled: true, encrypted: null });
});
