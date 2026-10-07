'use strict';

// MATH-65 build 2: the Zotero library mirrored on disk (src/main/zotero/sync.cjs), read for the @ menu, a mention's chip
// and Bart (src/main/zotero/mirror.cjs), against a fake api.zotero.org on loopback, and a second server standing in for
// where Zotero keeps files (a download is redirected there, and must arrive without the key).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createZoteroSync, scheduleSyncs, citeKeys, madeKey, rekeyed, noteText } = require('../src/main/zotero/sync.cjs');
const mirror = require('../src/main/zotero/mirror.cjs');
const { expandMentions, INLINE: MAIN_INLINE } = require('../src/main/context/expand-mentions.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');

const KEY = 'Zk3yN0tToB3S3ntAnywh3r3';
const USER_ID = '475425';

const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); original.apply(console, args); };
}

const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const rail = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `zotero-${name}-`));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

/* ------------------------------------------------------------------------------------------------- the fake library */

// One library: collections and items with versions, what was deleted at which version, indexed text and BibTeX.
function library() {
  let version = 10;
  const lib = { collections: new Map(), items: new Map(), deleted: [], fulltext: new Map(), version: () => version };
  lib.bump = () => (version += 1);
  lib.collection = (data) => lib.collections.set(data.key, { key: data.key, version: lib.bump(), data: { ...data, version } });
  lib.item = (data) => lib.items.set(data.key, { key: data.key, version: lib.bump(), data: { relations: {}, tags: [], collections: [], ...data, version } });
  lib.remove = (key) => { lib.items.delete(key); lib.deleted.push({ key, kind: 'items', version: lib.bump() }); };
  lib.text = (key, content) => lib.fulltext.set(key, { content, version: lib.bump() });
  return lib;
}

/** The library the tests start from: what each case below is built to check. */
function seed() {
  const lib = library();
  lib.collection({ key: 'COLL0001', name: 'Reading', parentCollection: false });
  lib.collection({ key: 'COLL0002', name: 'Methods/Tools', parentCollection: 'COLL0001' });
  lib.collection({ key: 'COLL0003', name: 'Old', parentCollection: false, deleted: true });
  // Better BibTeX's key in Extra; a pdf, a note and an annotation on the pdf.
  lib.item({ key: 'SMITH001', itemType: 'journalArticle', title: 'Learning to Learn', creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Smith' }, { creatorType: 'author', firstName: 'Bo', lastName: 'Ng' }], date: '2020-03-01', publicationTitle: 'Journal of Learning', DOI: '10.1/abc', url: 'https://example.org/smith', abstractNote: 'We learn to learn.', extra: 'Citation Key: smithLearning2020', tags: [{ tag: 'meta' }], collections: ['COLL0001'], dateAdded: '2020-01-01T00:00:00Z' });
  lib.item({ key: 'ATTPDF01', itemType: 'attachment', parentItem: 'SMITH001', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'smith.pdf', title: 'Full Text PDF' });
  lib.item({ key: 'NOTE0001', itemType: 'note', parentItem: 'SMITH001', note: '<p>Read <b>section 3</b> &amp; compare.</p><p>Second&nbsp;line</p>' });
  lib.item({ key: 'ANNOT001', itemType: 'annotation', parentItem: 'ATTPDF01', annotationType: 'highlight', annotationText: 'learning is recursive', annotationComment: 'key claim', annotationPageLabel: '3', annotationColor: '#ffd400' });
  lib.text('ATTPDF01', 'The full text of Smith and Ng.');
  // The citationKey field.
  lib.item({ key: 'JONES001', itemType: 'book', title: 'A Book', creators: [{ creatorType: 'editor', name: 'Jones' }], date: '1999', publisher: 'Press', citationKey: 'jonesField', collections: ['COLL0002'], dateAdded: '2020-01-02T00:00:00Z' });
  // Two made keys that clash: the one added first keeps the plain key.
  lib.item({ key: 'LEE00002', itemType: 'journalArticle', title: 'Graph Other', creators: [{ creatorType: 'author', firstName: 'Kim', lastName: 'Lee' }], date: '2021', dateAdded: '2021-05-01T00:00:00Z' });
  lib.item({ key: 'LEE00001', itemType: 'journalArticle', title: 'The Graph Thing', creators: [{ creatorType: 'author', firstName: 'Kim', lastName: 'Lee' }], date: 'June 2021', dateAdded: '2021-01-01T00:00:00Z' });
  // In the trash: left out, and its child with it.
  lib.item({ key: 'TRASH001', itemType: 'journalArticle', title: 'Thrown Away', creators: [], deleted: 1 });
  // A web page with no file.
  lib.item({ key: 'WEB00001', itemType: 'webpage', title: 'A Page', url: 'https://example.org/page', creators: [] });
  return lib;
}

/** Enough more items for three pages of collections+items (100 a page). */
function filler(lib, n) {
  for (let i = 0; i < n; i++) lib.item({ key: `FILL${String(i).padStart(4, '0')}`, itemType: 'report', title: `Filler ${i}`, creators: [{ creatorType: 'author', lastName: 'Filler' }], date: '2010', dateAdded: `2010-01-01T00:00:${String(i % 60).padStart(2, '0')}Z` });
}

/** api.zotero.org for `lib`: every request recorded. `trouble(url)` may answer instead (429, Backoff…). */
async function fakeApi(t, lib, { files = null, trouble = () => null, hold = null } = {}) {
  const seen = [];
  const busy = { now: 0, most: 0 }; // requests being answered at once
  const base = await serve(t, async (req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['zotero-api-key'], apiVersion: req.headers['zotero-api-version'], unless: req.headers['if-modified-since-version'] || null });
    busy.now += 1; busy.most = Math.max(busy.most, busy.now);
    res.on('finish', () => { busy.now -= 1; });
    if (hold) await hold(url);
    const json = (status, value, headers = {}) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('last-modified-version', String(lib.version())); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(JSON.stringify(value)); };
    if (req.headers['zotero-api-key'] !== KEY || req.headers['zotero-api-version'] !== '3') return json(403, { error: 'forbidden' });
    // If-Modified-Since-Version: the library unchanged since that version → 304, nothing else.
    const unless = req.headers['if-modified-since-version'];
    if (unless && Number(unless) >= lib.version()) { res.statusCode = 304; res.setHeader('last-modified-version', String(lib.version())); return res.end(); }
    const special = trouble(url, seen.length);
    if (special) { res.statusCode = special.status; for (const [k, v] of Object.entries(special.headers || {})) res.setHeader(k, v); return res.end(special.body || ''); }
    const prefix = `/users/${USER_ID}`;
    if (!url.pathname.startsWith(prefix)) return json(404, {});
    const route = url.pathname.slice(prefix.length);
    const since = Number(url.searchParams.get('since') || 0);
    const page = (list) => {
      const start = Number(url.searchParams.get('start') || 0), limit = Number(url.searchParams.get('limit') || 25);
      return json(200, list.slice(start, start + limit), { 'total-results': String(list.length) });
    };
    if (route === '/collections') return page([...lib.collections.values()].filter((c) => c.version > since));
    if (route === '/items' && url.searchParams.get('itemKey')) {
      const keys = url.searchParams.get('itemKey').split(',');
      assert.ok(keys.length <= 50, 'at most 50 keys a batch');
      assert.equal(url.searchParams.get('include'), 'bibtex');
      return json(200, keys.filter((k) => lib.items.has(k)).map((k) => ({ key: k, version: lib.items.get(k).version, bibtex: `\n@article{zotero_${k.toLowerCase()},\n\ttitle = {${lib.items.get(k).data.title}}\n}\n` })));
    }
    if (route === '/items') {
      const list = [...lib.items.values()].filter((i) => i.version > since && (url.searchParams.get('includeTrashed') === '1' || !i.data.deleted));
      return page(list);
    }
    if (route === '/deleted') {
      const out = { collections: [], items: [], searches: [], tags: [], settings: [] };
      for (const d of lib.deleted) if (d.version > since) out[d.kind].push(d.key);
      return json(200, out);
    }
    if (route === '/fulltext') return json(200, Object.fromEntries([...lib.fulltext].filter(([, v]) => v.version > since).map(([k, v]) => [k, v.version])));
    let m = /^\/items\/(\w+)\/fulltext$/.exec(route);
    if (m) return lib.fulltext.has(m[1]) ? json(200, { content: lib.fulltext.get(m[1]).content, indexedPages: 1, totalPages: 1 }) : json(404, {});
    m = /^\/items\/(\w+)\/file$/.exec(route);
    if (m && files) { res.statusCode = 302; res.setHeader('location', `${files.base}/s3/${m[1]}?signature=x`); return res.end(); }
    return json(404, {});
  });
  return { base, seen, busy };
}

/** Where Zotero keeps files: answers any path with bytes, and records whether the key came along. */
async function fakeFiles(t) {
  const files = { seen: [] };
  files.base = await serve(t, (req, res) => {
    files.seen.push({ path: req.url, key: req.headers['zotero-api-key'] || null });
    res.setHeader('content-type', 'application/pdf');
    res.end('%PDF-1.4 downloaded');
  });
  return files;
}

function syncer(base, root, extra = {}) {
  const waits = [];
  const sync = createZoteroSync({ api: base, root, account: () => ({ userID: USER_ID, key: KEY }), sleep: async (ms) => { waits.push(ms); }, ...extra });
  return { sync, waits };
}

/* ----------------------------------------------------------------------------------------------------------- sync */

test('a first sync mirrors collections, items, children, text and BibTeX; the trash is left out; nothing holds the key', async (t) => {
  const lib = seed();
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('first'), 'zotero');
  const changes = [];
  const { sync } = syncer(api.base, root, { onChange: (s) => changes.push(s.state) });
  const done = await sync.sync();
  assert.equal(done.state, 'synced');
  assert.equal(done.items, 5, 'five top-level items, the trashed one left out');
  assert.deepEqual(changes, ['syncing', 'synced']);
  assert.ok(api.seen.every((r) => r.key === KEY && r.apiVersion === '3'), 'every request carries the key and API version 3');
  assert.deepEqual(api.seen.filter((r) => r.path.endsWith('/items') && !r.query.itemKey).map((r) => [r.query.since, r.query.includeTrashed]), [['0', '1']]);

  const items = JSON.parse(fs.readFileSync(path.join(root, 'items.json'), 'utf8'));
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.deepEqual(Object.keys(by).sort(), ['JONES001', 'LEE00001', 'LEE00002', 'SMITH001', 'WEB00001'], 'no attachment, note or annotation is an item, nor anything in the trash');
  const smith = by.SMITH001;
  assert.deepEqual([smith.title, smith.year, smith.publication, smith.doi, smith.url, smith.abstractNote, smith.tags, smith.collections, smith.citeKey], ['Learning to Learn', '2020', 'Journal of Learning', '10.1/abc', 'https://example.org/smith', 'We learn to learn.', ['meta'], ['COLL0001'], 'smithLearning2020']);
  assert.deepEqual(smith.creators.map((c) => c.name), ['Ann Smith', 'Bo Ng']);
  assert.deepEqual(smith.attachments, [{ key: 'ATTPDF01', title: 'Full Text PDF', contentType: 'application/pdf', filename: 'smith.pdf', linkMode: 'imported_file' }]);
  assert.equal(by.JONES001.citeKey, 'jonesField', 'the citationKey field');
  assert.equal(by.JONES001.publication, 'Press');
  assert.deepEqual([by.LEE00001.citeKey, by.LEE00002.citeKey], ['lee2021graph', 'lee2021grapha'], 'made keys: the one added first keeps the plain key');

  const collections = JSON.parse(fs.readFileSync(path.join(root, 'collections.json'), 'utf8'));
  assert.deepEqual(collections.map((c) => [c.key, c.path]), [['COLL0001', 'Reading'], ['COLL0002', 'Reading / Methods/Tools']], 'the trashed collection is left out');

  const children = JSON.parse(fs.readFileSync(path.join(root, 'items', 'SMITH001', 'children.json'), 'utf8'));
  assert.deepEqual(children.notes, [{ key: 'NOTE0001', text: 'Read section 3 & compare.\nSecond line' }]);
  assert.deepEqual(children.annotations, [{ key: 'ANNOT001', type: 'highlight', text: 'learning is recursive', comment: 'key claim', page: '3', color: '#ffd400', attachment: 'ATTPDF01' }]);
  assert.equal(fs.readFileSync(path.join(root, 'items', 'SMITH001', 'fulltext-ATTPDF01.txt'), 'utf8'), 'The full text of Smith and Ng.');

  const bib = fs.readFileSync(path.join(root, 'items', 'SMITH001', 'item.bib'), 'utf8');
  assert.match(bib, /^@article\{smithLearning2020,\n\ttitle = \{Learning to Learn\}\n\}\n$/, 'its BibTeX under its citation key');
  assert.match(fs.readFileSync(path.join(root, 'items', 'LEE00002', 'item.bib'), 'utf8'), /^@article\{lee2021grapha,/);
  const all = fs.readFileSync(path.join(root, 'library.bib'), 'utf8');
  for (const key of ['smithLearning2020', 'jonesField', 'lee2021graph', 'lee2021grapha']) assert.match(all, new RegExp(`@article\\{${key},`));
  const batches = api.seen.filter((r) => r.query.itemKey);
  assert.equal(batches.length, 1, 'BibTeX in one batch for five items');
  assert.ok(!batches[0].query.itemKey.split(',').includes('ATTPDF01'), 'BibTeX only for top-level items');

  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  assert.equal(state.version, lib.version());
  for (const file of walk(root)) assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY), `${path.basename(file)} does not hold the key`);
});

test('the next sync asks only for what changed since, and applies a change, a deletion and a move to the trash', async (t) => {
  const lib = seed();
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('again'), 'zotero');
  const { sync } = syncer(api.base, root);
  await sync.sync();
  const at = lib.version();
  api.seen.length = 0;

  lib.item({ ...lib.items.get('LEE00001').data, title: 'The Graph Thing, Revised' });
  lib.remove('JONES001');
  lib.item({ ...lib.items.get('WEB00001').data, deleted: 1 });
  lib.item({ key: 'NEW00001', itemType: 'preprint', title: 'Fresh', creators: [{ creatorType: 'author', lastName: 'Smith' }], date: '2020', dateAdded: '2022-01-01T00:00:00Z' });
  lib.text('ATTPDF01', 'Indexed again.');
  const done = await sync.sync();
  assert.equal(done.items, 4);
  const since = (route) => api.seen.filter((r) => r.path === `/users/${USER_ID}${route}` && !r.query.itemKey).map((r) => r.query.since);
  for (const route of ['/collections', '/items', '/deleted', '/fulltext']) assert.deepEqual(since(route), [String(at)], `${route} asks since the version kept`);
  const keys = api.seen.find((r) => r.query.itemKey).query.itemKey.split(',').sort();
  assert.deepEqual(keys, ['LEE00001', 'NEW00001'], 'BibTeX again only for what changed');

  const items = JSON.parse(fs.readFileSync(path.join(root, 'items.json'), 'utf8'));
  const by = Object.fromEntries(items.map((i) => [i.key, i]));
  assert.equal(by.LEE00001.title, 'The Graph Thing, Revised');
  assert.equal(by.LEE00001.citeKey, 'lee2021graph', 'its key stays');
  assert.ok(!by.JONES001 && !by.WEB00001, 'the deleted and the trashed are gone');
  assert.ok(!fs.existsSync(path.join(root, 'items', 'JONES001')) && !fs.existsSync(path.join(root, 'items', 'WEB00001')), 'and their folders');
  assert.equal(by.SMITH001.citeKey, 'smithLearning2020');
  assert.equal(by.NEW00001.citeKey, 'smith2020fresh');
  assert.match(fs.readFileSync(path.join(root, 'items', 'LEE00001', 'item.bib'), 'utf8'), /Revised/);
  assert.equal(fs.readFileSync(path.join(root, 'items', 'SMITH001', 'fulltext-ATTPDF01.txt'), 'utf8'), 'Indexed again.');
  assert.ok(!/jonesField/.test(fs.readFileSync(path.join(root, 'library.bib'), 'utf8')));

  // Nothing changed: one question, answered 304 (build 3, If-Modified-Since-Version).
  api.seen.length = 0;
  await sync.sync();
  assert.deepEqual(api.seen.map((r) => [r.path.split('/').pop(), r.unless]), [['collections', String(lib.version())]]);
});

test('pages of 100, until Total-Results', async (t) => {
  const lib = seed();
  filler(lib, 230);
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('pages'), 'zotero');
  const { sync } = syncer(api.base, root);
  const done = await sync.sync();
  assert.equal(done.items, 235);
  const pages = api.seen.filter((r) => r.path.endsWith('/items') && !r.query.itemKey).map((r) => [r.query.limit, r.query.start]);
  assert.deepEqual(pages, [['100', '0'], ['100', '100'], ['100', '200']], `${lib.items.size} items in three pages`);
  assert.equal(api.seen.filter((r) => r.query.itemKey).length, 5, '235 items of BibTeX in batches of 50');
});

test('Backoff holds the next request, and a 429 or 503 waits its Retry-After and tries again', async (t) => {
  const lib = seed();
  let collectionsTries = 0, itemsTries = 0;
  const api = await fakeApi(t, lib, {
    trouble: (url) => {
      if (url.pathname.endsWith('/collections') && collectionsTries++ === 0) return { status: 429, headers: { 'retry-after': '2' } };
      if (url.pathname.endsWith('/items') && !url.searchParams.get('itemKey') && itemsTries++ === 0) return { status: 503, headers: { 'retry-after': '7' } };
      return null;
    },
  });
  // Backoff on the deleted-and-fulltext step: answered by a wrapper that adds the header to the collections' answer.
  const root = path.join(tmp('backoff'), 'zotero');
  let clock = 1_000_000;
  const waits = [];
  const fetchWithBackoff = async (url, init) => {
    const response = await fetch(url, init);
    if (/\/collections\?/.test(url) && response.status === 200) {
      const headers = new Headers(response.headers); headers.set('backoff', '5');
      return new Response(await response.arrayBuffer(), { status: 200, headers });
    }
    return response;
  };
  const sync = createZoteroSync({ api: api.base, root, fetch: fetchWithBackoff, account: () => ({ userID: USER_ID, key: KEY }), now: () => clock, sleep: async (ms) => { waits.push(ms); clock += ms; } });
  const done = await sync.sync();
  assert.equal(done.state, 'synced');
  assert.deepEqual(waits, [2000, 5000, 7000], 'Retry-After 2 s, then the Backoff of 5 s before the next request, then Retry-After 7 s');
  assert.equal(collectionsTries, 2);

  // A 429 that never ends: the sync gives up with words, and the mirror's earlier state is kept.
  const stuck = await fakeApi(t, seed(), { trouble: () => ({ status: 429 }) });
  const other = syncer(stuck.base, path.join(tmp('stuck'), 'zotero'));
  const failed = await other.sync.sync();
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /slow down/);
  assert.ok(!failed.error.includes(KEY));
});

test('a key Zotero refuses says so; signing out stops a sync and deletes the mirror', async (t) => {
  const lib = seed();
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('refused'), 'zotero');
  const refused = createZoteroSync({ api: api.base, root, account: () => ({ userID: USER_ID, key: 'wrong' }), sleep: async () => {} });
  const answer = await refused.sync();
  assert.equal(answer.state, 'error');
  assert.match(answer.error, /refused the key/);

  const { sync } = syncer(api.base, root);
  await sync.sync();
  fs.mkdirSync(path.join(root, 'files', 'ATTPDF01'), { recursive: true });
  fs.writeFileSync(path.join(root, 'files', 'ATTPDF01', 'smith.pdf'), '%PDF');
  sync.clear();
  assert.ok(!fs.existsSync(root), 'the mirror and its downloads are gone');
  assert.equal(sync.status().state, 'idle');

  // Another account's mirror is not built on: the next sync starts from version 0.
  await sync.sync();
  const state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8'));
  fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ ...state, userID: '999' }));
  api.seen.length = 0;
  await sync.sync();
  assert.equal(api.seen.find((r) => r.path.endsWith('/items')).query.since, '0');
});

test('the IPC: status carries the mirror, Sync now syncs, Disconnect deletes the mirror, list and open read it', async (t) => {
  const lib = seed();
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('ipc'), 'zotero');
  let connected = true;
  const zotero = { status: () => ({ configured: true, connected, username: 'r', userID: USER_ID, persisted: true, pending: null, error: '' }), disconnect: async () => { connected = false; return zotero.status(); }, connect: async () => zotero.status(), cancel: () => zotero.status() };
  const library = createZoteroSync({ api: api.base, root, account: () => (connected ? { userID: USER_ID, key: KEY } : null), sleep: async () => {}, storageDir: tmp('nostorage') });
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => async (event, ...args) => fn(...args), zotero, zoteroLibrary: library });
  const call = (name, ...args) => handlers.get(`engelbart:${name}`)({}, ...args);
  assert.deepEqual((await call('zotero-status')).sync, { state: 'idle', items: 0, syncedAt: '', error: '' });
  assert.equal((await call('zotero-list', '')).error, 'Your Zotero library is still syncing…');
  const started = await call('zotero-sync');
  assert.equal(started.sync.state, 'syncing', 'answers at once');
  await library.sync();
  const status = await call('zotero-status');
  assert.equal(status.sync.state, 'synced');
  assert.equal(status.sync.items, 5);
  const top = await call('zotero-list', '');
  assert.deepEqual(top.entries.slice(0, 1).map((e) => [e.name, e.dir, e.rel]), [['Reading', true, 'Reading']]);
  assert.deepEqual((await call('zotero-list', 'Reading')).entries.map((e) => e.name), ['Methods∕Tools', 'Learning to Learn']);
  assert.deepEqual((await call('zotero-list', 'Reading/Methods∕Tools')).entries.map((e) => e.name), ['A Book']);
  assert.deepEqual(await call('zotero-list', 'Nope'), { missing: true });
  assert.deepEqual(await call('zotero-open', 'WEB00001'), { url: 'https://example.org/page', external: true });
  assert.match((await call('zotero-open', 'GONE0001')).error, /no longer in your Zotero library/);
  await assert.rejects(async () => call('zotero-open', '../x'), /invalid/);
  const out = await call('zotero-disconnect');
  assert.equal(out.sync, null);
  assert.ok(!fs.existsSync(root), 'disconnecting deletes the mirror');
  assert.equal((await call('zotero-list', '')).error, 'Zotero is not connected');
  for (const [name] of handlers) assert.ok(!/key/i.test(name.replace('engelbart:', '').replace('zotero-', '')) || !/zotero/.test(name), name);
});

/* ------------------------------------------------------------------------------------- syncing while the app is open */

test('a later sync sends If-Modified-Since-Version: an unchanged library costs one 304, a changed one syncs', async (t) => {
  const lib = seed();
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('304'), 'zotero');
  let clock = Date.parse('2026-10-06T10:00:00Z');
  const { sync } = syncer(api.base, root, { now: () => clock });
  await sync.sync();
  assert.equal(api.seen[0].unless, null, 'the first sync asks for everything, unconditionally');
  const before = fs.readFileSync(path.join(root, 'items.json'), 'utf8');

  api.seen.length = 0;
  clock += 10 * 60_000;
  const done = await sync.autoSync();
  assert.equal(api.seen.length, 1, 'one request');
  assert.deepEqual([api.seen[0].path, api.seen[0].unless], [`/users/${USER_ID}/collections`, String(lib.version())]);
  assert.equal(done.state, 'synced');
  assert.equal(done.syncedAt, new Date(clock).toISOString(), 'checked now');
  assert.equal(sync.lastSyncAt(), clock);
  assert.equal(fs.readFileSync(path.join(root, 'items.json'), 'utf8'), before, 'the mirror as it was');

  lib.item({ key: 'NEW00001', itemType: 'journalArticle', title: 'Fresh', creators: [], date: '2026' });
  api.seen.length = 0;
  await sync.autoSync();
  assert.ok(api.seen.length > 1, 'changed: the whole incremental sync');
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'items.json'), 'utf8')).some((i) => i.key === 'NEW00001'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).version, lib.version());
});

test('every 10 minutes and on coming to the front after 2: never two syncs at once, none while signed out', async (t) => {
  const lib = seed();
  let release = null;
  const held = { on: false };
  const api = await fakeApi(t, lib, { hold: async () => { if (held.on) await new Promise((resolve) => { release = resolve; }); } });
  const root = path.join(tmp('clock'), 'zotero');
  let clock = Date.parse('2026-10-06T10:00:00Z');
  const { sync } = syncer(api.base, root, { now: () => clock });
  let tick = null, every = 0, stopped = false;
  let connected = true;
  const schedule = scheduleSyncs(sync, {
    connected: () => connected, now: () => clock,
    setInterval: (fn, ms) => { tick = fn; every = ms; return 7; }, clearInterval: (id) => { stopped = id === 7; },
  });
  assert.equal(every, 10 * 60_000, 'every 10 minutes');

  // No sync yet: coming to the front syncs.
  schedule.focus();
  await sync.autoSync();
  const first = api.seen.length;
  assert.ok(first > 1);

  // Back to the front within 2 minutes: nothing.
  clock += 60_000;
  schedule.focus();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(api.seen.length, first, 'synced a minute ago: left alone');

  // A slow sync from the clock; the clock again, the window to the front and autoSync while it runs start nothing more.
  clock += 3 * 60_000;
  api.seen.length = 0; api.busy.most = 0;
  held.on = true;
  tick();
  const running = sync.autoSync();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  tick(); schedule.focus(); tick();
  assert.equal(sync.status().state, 'syncing');
  held.on = false;
  release();
  await running;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(api.seen.length, 1, 'one sync, one request: the 304');
  assert.equal(api.busy.most, 1, 'never two requests at once');

  // Signed out: the clock does nothing.
  connected = false;
  clock += 20 * 60_000;
  api.seen.length = 0;
  tick(); schedule.focus();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(api.seen.length, 0);
  schedule.stop();
  assert.ok(stopped);
});

/* ---------------------------------------------------------------------------------------------------- attachments */

test("an attachment is opened from Zotero's storage folder, or its linked path, before anything is downloaded", async (t) => {
  const lib = seed();
  const linked = path.join(tmp('linked'), 'mine.pdf');
  fs.writeFileSync(linked, '%PDF linked');
  lib.item({ key: 'LINK0001', itemType: 'report', title: 'Linked', creators: [] });
  lib.item({ key: 'ATTLNK01', itemType: 'attachment', parentItem: 'LINK0001', linkMode: 'linked_file', contentType: 'application/pdf', path: linked, title: 'mine.pdf' });
  lib.item({ key: 'SNAP0001', itemType: 'webpage', title: 'Snap', url: 'https://example.org/snap', creators: [] });
  lib.item({ key: 'ATTHTML1', itemType: 'attachment', parentItem: 'SNAP0001', linkMode: 'imported_url', contentType: 'text/html', filename: 'snap.html', url: 'https://example.org/snap' });
  const files = await fakeFiles(t);
  const api = await fakeApi(t, lib, { files });
  const root = path.join(tmp('attach'), 'zotero');
  const storage = tmp('storage');
  const { sync } = syncer(api.base, root, { storageDir: storage });
  await sync.sync();
  api.seen.length = 0;
  const options = { storageDir: storage, download: sync.download };

  // In the storage folder: opened from there, nothing fetched.
  fs.mkdirSync(path.join(storage, 'ATTPDF01'));
  fs.writeFileSync(path.join(storage, 'ATTPDF01', 'smith.pdf'), '%PDF stored');
  assert.deepEqual(await mirror.openTarget(root, 'SMITH001', options), { path: path.join(storage, 'ATTPDF01', 'smith.pdf'), source: 'storage' });
  assert.deepEqual(await mirror.openTarget(root, 'LINK0001', options), { path: linked, source: 'linked' }, 'a linked file at its own path');
  assert.equal(api.seen.length, 0, 'no download');

  // Not there: downloaded once, into files/, the redirect followed without the key.
  fs.rmSync(path.join(storage, 'ATTPDF01'), { recursive: true });
  const fetched = await mirror.openTarget(root, 'SMITH001', options);
  assert.deepEqual(fetched, { path: path.join(root, 'files', 'ATTPDF01', 'smith.pdf'), source: 'downloaded' });
  assert.equal(fs.readFileSync(fetched.path, 'utf8'), '%PDF-1.4 downloaded');
  assert.deepEqual(api.seen.map((r) => r.path), [`/users/${USER_ID}/items/ATTPDF01/file`]);
  assert.deepEqual(files.seen, [{ path: '/s3/ATTPDF01?signature=x', key: null }], 'where the file is kept never gets the key');
  await mirror.openTarget(root, 'SMITH001', options);
  assert.equal(api.seen.length, 1, 'the copy is kept: not fetched again');

  // A saved web page is an attachment too; a linked file that is gone is not downloaded, and the item falls back to its URL.
  fs.mkdirSync(path.join(storage, 'ATTHTML1'));
  fs.writeFileSync(path.join(storage, 'ATTHTML1', 'snap.html'), '<p>snap</p>');
  assert.deepEqual(await mirror.openTarget(root, 'SNAP0001', options), { path: path.join(storage, 'ATTHTML1', 'snap.html'), source: 'storage' });
  fs.rmSync(linked);
  assert.match((await mirror.openTarget(root, 'LINK0001', options)).error, /no file or address/);
  assert.equal(api.seen.length, 1);
  // Nothing is fetched while only listing or syncing.
  await sync.sync();
  assert.ok(!api.seen.some((r) => r.path.endsWith('/file') && api.seen.indexOf(r) > 0));
});

/* ---------------------------------------------------------------------------------------------------- the @ menu */

test('the @ menu: a Zotero row while connected, opened like a folder, items filtered by title or author', async (t) => {
  const { mentionRows, folderRows, isFolderRow, ZOTERO_ROW, firstPick } = await rail();
  const { folderPath } = await doc();
  const none = mentionRows({ query: '', library: [] });
  assert.ok(!none.some((m) => m.key === 'zotero'), 'not while signed out');
  const rows = mentionRows({ query: '', library: [], zotero: true });
  const row = rows.find((m) => m.key === 'zotero');
  assert.ok(row && isFolderRow(row), 'opens like a library folder');
  assert.ok(mentionRows({ query: 'zot', library: [], zotero: true }).some((m) => m.key === 'zotero'));
  assert.ok(!mentionRows({ query: 'paper', library: [], zotero: true }).some((m) => m.key === 'zotero'));
  assert.equal(folderPath(ZOTERO_ROW.name, ''), '@Zotero/');
  assert.equal(folderPath(ZOTERO_ROW.name, 'Reading/Methods∕Tools'), '@Zotero/Reading/Methods∕Tools/');

  const lib = seed();
  const api = await fakeApi(t, lib);
  const root = path.join(tmp('menu'), 'zotero');
  await syncer(api.base, root).sync.sync();
  assert.ok(!mirror.mirrorDir('/data').endsWith('/zotero'), 'never where a project named Zotero would be');
  const listing = mirror.listLevel(root, '');
  const browse = { row: ZOTERO_ROW, rel: '' };
  const top = folderRows({ browse, listing, query: '' });
  assert.deepEqual(top.map((m) => m.kind).slice(0, 2), ['back', 'entry'], 'no "Mention this folder" for Zotero');
  assert.equal(top[firstPick(top)].name, 'Reading');
  const byAuthor = folderRows({ browse, listing, query: 'smith' });
  assert.deepEqual(byAuthor.map((m) => [m.name, m.zotero, m.hint]), [['Learning to Learn', 'SMITH001', 'Smith and Ng · 2020']]);
  assert.deepEqual(folderRows({ browse, listing, query: 'graph' }).map((m) => m.name), ['Graph Other', 'The Graph Thing']);
  assert.deepEqual(folderRows({ browse, listing, query: '2021' }).map((m) => m.zotero).sort(), ['LEE00001', 'LEE00002']);
  assert.deepEqual(folderRows({ browse: { row: ZOTERO_ROW, rel: 'Gone' }, listing: { missing: true }, query: '' }).pop().name, 'This collection is no longer in Zotero');
});

test('a mention token round-trips, stays one token, draws as a chip, and main reads it as the editor does', async () => {
  const { zoteroMention, zoteroMentionOf, ZOTERO_MENTION_RE, INLINE, tokShown, inlineHtml } = await doc();
  for (const title of ['Learning to Learn', 'A [draft] (2020): what? #1', 'Ünïcödé — 論文', '  spaced\nout  ']) {
    const token = zoteroMention(title, 'SMITH001');
    assert.match(token, ZOTERO_MENTION_RE);
    const read = zoteroMentionOf(token);
    assert.equal(read.key, 'SMITH001');
    assert.equal(read.name, title.replace(/[[\]\n]/g, '').replace(/\s+/g, ' ').trim());
    assert.deepEqual(`see ${token}, then **b**`.split(INLINE).filter(Boolean), ['see ', token, ', then ', '**b**'], title);
    assert.deepEqual(`see ${token}, then **b**`.split(MAIN_INLINE).filter(Boolean), ['see ', token, ', then ', '**b**'], `${title}: main splits it the same`);
    assert.equal(tokShown(token).shown, `@${read.name}`);
  }
  const html = inlineHtml(`x ${zoteroMention('Learning to Learn', 'SMITH001')} y`);
  assert.match(html, /data-zotero="SMITH001"/);
  assert.match(html, /<svg[^>]*>.*<\/svg>Learning to Learn<\/span>/);
  const { mentionedIds } = await rail();
  assert.equal(mentionedIds(zoteroMention('Learning to Learn', 'SMITH001'), [{ id: 'row-1', name: 'Learning to Learn' }]).size, 0, 'no library row of the same name is linked by it');
});

/* -------------------------------------------------------------------------------------------------------- Bart */

test('a mentioned item is a <zotero_item> under its line: metadata, BibTeX, notes, annotations and its file', async (t) => {
  const lib = seed();
  const files = await fakeFiles(t);
  const api = await fakeApi(t, lib, { files });
  const root = path.join(tmp('bart'), 'zotero');
  const storage = tmp('bart-storage');
  const { sync } = syncer(api.base, root, { storageDir: storage });
  await sync.sync();
  const { zoteroMention } = await doc();
  const source = { find: () => null, image: () => null, zotero: (key, name) => mirror.itemBlock(root, key, name, { storageDir: storage, download: sync.download }) };
  const text = `Compare ${zoteroMention('Learning to Learn', 'SMITH001')} with ${zoteroMention('Gone', 'GONE0001')}.\nAgain ${zoteroMention('Learning to Learn', 'SMITH001')}`;
  const seen = new Set();
  const out = await expandMentions(text, source, seen);
  const body = out.lines.join('\n');
  assert.equal(out.files, 1);
  assert.equal(out.missing, 1);
  assert.equal(body.match(/<zotero_item key="SMITH001"/g).length, 1, 'once, at its first mention');
  const file = path.join(root, 'files', 'ATTPDF01', 'smith.pdf');
  for (const line of [
    '<zotero_item key="SMITH001" cite="smithLearning2020">',
    'title: Learning to Learn', 'creators: Ann Smith; Bo Ng', 'year: 2020', 'type: journalArticle', 'publication: Journal of Learning',
    'doi: 10.1/abc', 'url: https://example.org/smith', 'tags: meta', 'collection: Reading',
    `attachment: ${file} (application/pdf)`, `full text: ${path.join(root, 'items', 'SMITH001', 'fulltext-ATTPDF01.txt')}`,
    '<abstract>\nWe learn to learn.\n</abstract>',
    '<bibtex>\n@article{smithLearning2020,\n\ttitle = {Learning to Learn}\n}\n</bibtex>',
    '<notes>\n<note>\nRead section 3 & compare.\nSecond line\n</note>\n</notes>',
    '<annotations>\n<annotation type="highlight" page="3">\n<quote>\nlearning is recursive\n</quote>\n<comment>\nkey claim\n</comment>\n</annotation>\n</annotations>',
    '<zotero_item key="GONE0001" title="Gone" missing="true" />',
  ]) assert.ok(body.includes(line), `has: ${line}`);
  assert.ok(body.indexOf('<zotero_item key="SMITH001"') > body.indexOf('Compare') && body.indexOf('<zotero_item key="SMITH001"') < body.indexOf('Again'), 'under the line that mentions it');
  assert.ok(fs.existsSync(file), 'mentioned: its file is downloaded now');
  assert.ok(seen.has(`zfile:${file}`), 'and kept, for its folder to be granted');
  assert.ok(!body.includes(KEY));

  // The line every @bart turn carries.
  assert.equal(mirror.pointerLine(root), `zotero library: ${root} (5 items; items.json, collections.json, library.bib, and items/<key>/ with item.bib, children.json and fulltext-*.txt)`);
  assert.equal(mirror.pointerLine(tmp('empty')), '');
});

test("Bart's context: the mirror's line in <engelbart>, the item under its line, its file's folder granted; the prompt says so", async (t) => {
  const db = require('../src/main/store/db.cjs');
  const { ensureHome } = require('../src/main/store/home.cjs');
  const projects = require('../src/main/store/projects.cjs');
  const { buildContext } = require('../src/main/bart/context.cjs');
  const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
  const homeDir = tmp('home');
  const layout = ensureHome(homeDir);
  const lib = seed();
  const api = await fakeApi(t, lib);
  const storage = tmp('ctx-storage');
  fs.mkdirSync(path.join(storage, 'ATTPDF01'));
  fs.writeFileSync(path.join(storage, 'ATTPDF01', 'smith.pdf'), '%PDF');
  const { sync } = syncer(api.base, mirror.mirrorDir(layout.root), { storageDir: storage });
  await sync.sync();
  const ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root), zotero: () => sync };
  t.after(() => db.closeAll());
  const project = await projects.createProject(ctx, { name: 'Zotero' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Reading' });
  const { zoteroMention } = await doc();
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, `About ${zoteroMention('Learning to Learn', 'SMITH001')}\n@bart what is the key claim?\nbart~> z1\n`);
  const c = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'z1', agent: 'bart' });
  assert.match(c.head, new RegExp(`zotero library: ${mirror.mirrorDir(layout.root).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} \\(5 items`));
  assert.match(c.documents, /<zotero_item key="SMITH001" cite="smithLearning2020">/);
  assert.ok(c.documents.includes(`attachment: ${path.join(storage, 'ATTPDF01', 'smith.pdf')} (application/pdf)`));
  assert.ok(c.dirs.includes(path.join(storage, 'ATTPDF01')), 'the attachment\'s folder may be read');
  assert.match(BART_SYSTEM_PROMPT, /"zotero library:" line/);
  assert.match(BART_SYSTEM_PROMPT, /<zotero_item>/);
  const brainstorm = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'z1', agent: 'brainstorm' });
  assert.doesNotMatch(brainstorm.head, /zotero library:/, '@brainstorm reads this workspace alone');
});

/* --------------------------------------------------------------------------------------------- keys and helpers */

test('citation keys: Better BibTeX first, then author, year and first word, with letters for clashes', () => {
  assert.equal(madeKey({ title: 'The Ünïcödé Way', creators: [{ creatorType: 'author', lastName: 'Ölsen-Berg' }], date: '2019-02-03' }), 'olsenberg2019unicode');
  assert.equal(madeKey({ title: '', creators: [], date: '' }), 'anonnd');
  assert.equal(madeKey({ title: 'Notes', creators: [{ creatorType: 'editor', name: 'World Health Organization' }], date: 'n.d.' }), 'organizationndnotes');
  const keys = citeKeys([
    { key: 'A', title: 'X', creators: [{ lastName: 'Doe' }], date: '2000', dateAdded: '2000-01-03' },
    { key: 'B', title: 'X', creators: [{ lastName: 'Doe' }], date: '2000', dateAdded: '2000-01-01' },
    { key: 'C', title: 'X', creators: [{ lastName: 'Doe' }], date: '2000', dateAdded: '2000-01-02', extra: 'tex.foo: 1\nCitation Key: doe2000x' },
  ]);
  assert.deepEqual([keys.get('C'), keys.get('B'), keys.get('A')], ['doe2000x', 'doe2000xa', 'doe2000xb'], "Better BibTeX's key is kept; made ones step around it");
  assert.equal(rekeyed('\n@book{zotero_x,\n title={T}\n}', 'mine2020'), '@book{mine2020,\n title={T}\n}');
  assert.equal(noteText('<ul><li>one</li><li>two &#x2014; &#8212;</li></ul>'), '- one\n- two — —');
});

test('nothing logged held the key, and the Zotero modules log nothing', () => {
  assert.ok(!logged.some((line) => line.includes(KEY)));
  const sources = ['sync.cjs', 'mirror.cjs', 'oa.cjs'].map((name) => fs.readFileSync(path.join(__dirname, '../src/main/zotero', name), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /console\./);
});
