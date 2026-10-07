'use strict';

// MATH-65 build 5: group libraries. Each group the person is in (/users/<id>/groups) is mirrored as My Library is, in
// <mirror>/groups/<groupID>/ (src/main/zotero/sync.cjs), read for the @ menu, a mention's chip and Bart
// (src/main/zotero/mirror.cjs), against a fake api.zotero.org on loopback that holds My Library and two groups. Item
// keys are only unique within a library: a group's item is `zotero:g<groupID>:<key>`, and `zotero:<key>` stays My
// Library's, as every mention written before.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const { createZoteroSync } = require('../src/main/zotero/sync.cjs');
const mirror = require('../src/main/zotero/mirror.cjs');
const { expandMentions, INLINE: MAIN_INLINE } = require('../src/main/context/expand-mentions.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const KEY = 'Zk3yN0tToB3S3ntAnywh3r3';
const USER_ID = '475425';
const LAB = '1001'; // "Lab Readings"
const CLUB = '2002'; // "Journal Club"

const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const rail = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);
const connections = () => {
  const { buildSync } = require('esbuild');
  const Module = require('node:module');
  const filename = path.join(__dirname, '__Connections-groups-unit.cjs');
  const out = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/Connections.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(__dirname);
  const previous = global.window;
  global.window = { engelbartAPI: {} };
  try { m._compile(out.outputFiles[0].text, filename); } finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return m.exports;
};

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `zotero-groups-${name}-`));
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/* ------------------------------------------------------------------------------------------------ the fake libraries */

// One library: collections and items with versions, what was deleted, indexed text.
function library(start = 10) {
  let version = start;
  const lib = { collections: new Map(), items: new Map(), deleted: [], fulltext: new Map(), version: () => version };
  lib.bump = () => (version += 1);
  lib.collection = (data) => lib.collections.set(data.key, { key: data.key, version: lib.bump(), data: { ...data, version } });
  lib.item = (data) => lib.items.set(data.key, { key: data.key, version: lib.bump(), data: { relations: {}, tags: [], collections: [], ...data, version } });
  lib.text = (key, content) => lib.fulltext.set(key, { content, version: lib.bump() });
  return lib;
}

/**
 * My Library and two groups. SAME0001 is a key in My Library and in Lab Readings, each a different paper; so is
 * ATTSAME1, each its own pdf.
 */
function world() {
  const mine = library(10);
  mine.collection({ key: 'COLLMINE', name: 'Reading', parentCollection: false });
  mine.item({ key: 'SAME0001', itemType: 'journalArticle', title: 'My Own Paper', creators: [{ creatorType: 'author', lastName: 'Mine' }], date: '2020', collections: ['COLLMINE'], dateAdded: '2020-01-01' });
  mine.item({ key: 'ATTSAME1', itemType: 'attachment', parentItem: 'SAME0001', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'mine.pdf' });

  const lab = library(500);
  lab.collection({ key: 'COLLLAB1', name: 'Methods', parentCollection: false });
  lab.item({ key: 'SAME0001', itemType: 'journalArticle', title: 'The Lab Paper', creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lab' }], date: '2023', publicationTitle: 'Lab Journal', abstractNote: 'What the lab found.', collections: ['COLLLAB1'], dateAdded: '2023-01-01' });
  lab.item({ key: 'ATTSAME1', itemType: 'attachment', parentItem: 'SAME0001', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'lab.pdf' });
  lab.item({ key: 'NOTELAB1', itemType: 'note', parentItem: 'SAME0001', note: '<p>Shared note from the lab.</p>' });
  lab.item({ key: 'ANNLAB01', itemType: 'annotation', parentItem: 'ATTSAME1', annotationType: 'highlight', annotationText: 'a lab claim', annotationComment: 'check this', annotationPageLabel: '4' });
  lab.text('ATTSAME1', 'The full text of the lab paper.');
  // No pdf of its own, a DOI: a free copy is looked for (build 3), its download waited for (build 4).
  lab.item({ key: 'FREELAB1', itemType: 'journalArticle', title: 'Behavioral Context for Adaptive Tutoring', creators: [{ creatorType: 'author', lastName: 'Barron' }], date: '2026', DOI: '10.5555/lab.free', dateAdded: '2023-01-02' });
  lab.item({ key: 'SHUTLAB1', itemType: 'journalArticle', title: 'Closed Group Paper', creators: [{ creatorType: 'author', lastName: 'Shut' }], date: '2019', DOI: '10.5555/lab.closed', dateAdded: '2023-01-03' });

  const club = library(900);
  club.item({ key: 'CLUB0001', itemType: 'book', title: 'Club Book', creators: [{ creatorType: 'author', lastName: 'Reader' }], date: '2001', dateAdded: '2021-01-01' });

  const groups = new Map([[LAB, { name: 'Lab Readings', lib: lab }], [CLUB, { name: 'Journal Club', lib: club }]]);
  return { mine, groups, lab, club };
}

/**
 * api.zotero.org for `w`: /users/<id>/… is My Library, /users/<id>/groups the groups (pages of `limit`), /groups/<id>/…
 * each group's. `trouble(url)` may answer instead. Every request recorded, with its method.
 */
async function fakeApi(t, w, { trouble = () => null, files = null } = {}) {
  const seen = [];
  const base = await serve(t, async (req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['zotero-api-key'], unless: req.headers['if-modified-since-version'] || null });
    if (req.headers['zotero-api-key'] !== KEY) { res.statusCode = 403; return res.end('{}'); }
    const special = trouble(url);
    if (special) { res.statusCode = special.status; return res.end(special.body || ''); }
    const start = Number(url.searchParams.get('start') || 0), limit = Number(url.searchParams.get('limit') || 25);
    if (url.pathname === `/users/${USER_ID}/groups`) {
      const list = [...w.groups].map(([id, g]) => ({ id: Number(id), version: 3, data: { id: Number(id), name: g.name, type: 'Private', libraryReading: 'members' } }));
      res.setHeader('content-type', 'application/json'); res.setHeader('total-results', String(list.length));
      return res.end(JSON.stringify(list.slice(start, start + limit)));
    }
    let lib = null, route = '';
    let m = /^\/users\/(\d+)(\/.*)$/.exec(url.pathname);
    if (m && m[1] === USER_ID) { lib = w.mine; route = m[2]; }
    m = /^\/groups\/(\d+)(\/.*)$/.exec(url.pathname);
    if (m) { if (!w.groups.has(m[1])) { res.statusCode = 404; return res.end('Not found'); } lib = w.groups.get(m[1]).lib; route = m[2]; }
    if (!lib) { res.statusCode = 404; return res.end('{}'); }
    const json = (value, headers = {}) => { res.setHeader('content-type', 'application/json'); res.setHeader('last-modified-version', String(lib.version())); for (const [k, v] of Object.entries(headers)) res.setHeader(k, v); res.end(JSON.stringify(value)); };
    const unless = req.headers['if-modified-since-version'];
    if (unless && Number(unless) >= lib.version()) { res.statusCode = 304; res.setHeader('last-modified-version', String(lib.version())); return res.end(); }
    const since = Number(url.searchParams.get('since') || 0);
    const page = (list) => json(list.slice(start, start + limit), { 'total-results': String(list.length) });
    if (route === '/collections') return page([...lib.collections.values()].filter((c) => c.version > since));
    if (route === '/items' && url.searchParams.get('itemKey')) {
      const keys = url.searchParams.get('itemKey').split(',');
      return json(keys.filter((k) => lib.items.has(k)).map((k) => ({ key: k, bibtex: `@article{zotero_${k.toLowerCase()},\n\ttitle = {${lib.items.get(k).data.title}}\n}\n` })));
    }
    if (route === '/items') return page([...lib.items.values()].filter((i) => i.version > since));
    if (route === '/deleted') {
      const out = { collections: [], items: [], searches: [], tags: [], settings: [] };
      for (const d of lib.deleted) if (d.version > since) out[d.kind].push(d.key);
      return json(out);
    }
    if (route === '/fulltext') return json(Object.fromEntries([...lib.fulltext].filter(([, v]) => v.version > since).map(([k, v]) => [k, v.version])));
    m = /^\/items\/(\w+)\/fulltext$/.exec(route);
    if (m) return lib.fulltext.has(m[1]) ? json({ content: lib.fulltext.get(m[1]).content }) : (res.statusCode = 404, res.end());
    m = /^\/items\/(\w+)\/file$/.exec(route);
    if (m && files) { res.statusCode = 302; res.setHeader('location', `${files.base}/s3${url.pathname}`); return res.end(); }
    res.statusCode = 404; return res.end('{}');
  });
  return { base, seen };
}

/** Where Zotero keeps files: the bytes say which library's file was asked for. */
async function fakeFiles(t) {
  const files = { seen: [] };
  files.base = await serve(t, (req, res) => {
    files.seen.push({ path: req.url, key: req.headers['zotero-api-key'] || null });
    res.setHeader('content-type', 'application/pdf');
    res.end(`%PDF-1.4 ${req.url}`);
  });
  return files;
}

function syncer(base, root, extra = {}) {
  return createZoteroSync({ api: base, root, account: () => ({ userID: USER_ID, key: KEY }), sleep: async () => {}, storageDir: tmp('nostorage'), ...extra });
}

/* ------------------------------------------------------------------------------------------------------------ sync */

test('the groups are listed on each sync, every page of them, and each is mirrored beside My Library with the same files', async (t) => {
  const w = world();
  for (let i = 0; i < 120; i++) w.groups.set(String(5000 + i), { name: `Big ${String(i).padStart(3, '0')}`, lib: library(1) }); // empty groups, over a page
  const api = await fakeApi(t, w);
  const root = path.join(tmp('mirror'), '.zotero');
  const sync = syncer(api.base, root);
  const done = await sync.sync();
  assert.equal(done.state, 'synced');
  assert.deepEqual(done.problems, []);
  assert.equal(done.groups, 122);
  assert.equal(done.items, 1 + 3 + 1, 'every library\'s items: 1 of mine, 3 of the lab, 1 of the club');
  const listed = api.seen.filter((r) => r.path === `/users/${USER_ID}/groups`);
  assert.deepEqual(listed.map((r) => [r.query.limit, r.query.start]), [['100', '0'], ['100', '100']], 'GET /users/<id>/groups, every page');
  assert.ok(api.seen.every((r) => r.method === 'GET'), 'read only: nothing is ever written back to Zotero');

  // My Library where it always was; each group in groups/<id>/, with the same files.
  assert.equal(readJson(path.join(root, 'items.json')).map((i) => i.title).join(), 'My Own Paper');
  const lab = path.join(root, 'groups', LAB);
  for (const file of ['state.json', 'raw.json', 'collections.json', 'items.json', 'library.bib', 'items/SAME0001/item.bib', 'items/SAME0001/children.json', 'items/SAME0001/fulltext-ATTSAME1.txt']) assert.ok(fs.existsSync(path.join(lab, file)), file);
  assert.deepEqual(readJson(path.join(lab, 'items.json')).map((i) => i.key).sort(), ['FREELAB1', 'SAME0001', 'SHUTLAB1']);
  assert.deepEqual(readJson(path.join(lab, 'collections.json')).map((c) => c.path), ['Methods']);
  assert.deepEqual(readJson(path.join(lab, 'items', 'SAME0001', 'children.json')).annotations.map((a) => [a.text, a.comment, a.page]), [['a lab claim', 'check this', '4']]);
  assert.equal(fs.readFileSync(path.join(lab, 'items', 'SAME0001', 'fulltext-ATTSAME1.txt'), 'utf8'), 'The full text of the lab paper.');
  assert.match(fs.readFileSync(path.join(lab, 'library.bib'), 'utf8'), /title = \{The Lab Paper\}/);
  const state = readJson(path.join(lab, 'state.json'));
  assert.deepEqual([state.groupID, state.name, state.userID, state.version, state.items], [LAB, 'Lab Readings', USER_ID, w.lab.version(), 3]);
  assert.equal(readJson(path.join(root, 'groups', CLUB, 'items.json'))[0].title, 'Club Book');
  assert.ok(api.seen.some((r) => r.path === `/groups/${LAB}/items` && r.query.since === '0'), 'a group\'s items from /groups/<id>/items');
  for (const file of walk(root)) assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY), `${file} does not hold the key`);

  // The next sync: each library asks only for what changed since its own version; an unchanged one costs one 304.
  w.lab.item({ key: 'NEWLAB01', itemType: 'report', title: 'New in the lab', creators: [], dateAdded: '2024-01-01' });
  w.groups.set(CLUB, { name: 'Journal Club (renamed)', lib: w.club });
  api.seen.length = 0;
  const again = await sync.sync();
  assert.equal(again.items, 6);
  const first = (prefix) => api.seen.find((r) => r.path.startsWith(prefix) && r.path.endsWith('/collections'));
  assert.equal(first(`/users/${USER_ID}`).unless, String(w.mine.version()), 'My Library: If-Modified-Since-Version');
  assert.equal(first(`/groups/${LAB}`).unless, String(state.version), 'the lab: its own version');
  assert.equal(first(`/groups/${CLUB}`).unless, String(w.club.version()));
  assert.deepEqual(api.seen.filter((r) => r.path.startsWith(`/groups/${CLUB}/`)).length, 1, 'the club unchanged: one 304');
  assert.deepEqual(api.seen.filter((r) => r.path === `/groups/${LAB}/items` && !r.query.itemKey).map((r) => r.query.since), [String(state.version)], 'the lab: only what changed since');
  assert.ok(readJson(path.join(lab, 'items.json')).some((i) => i.key === 'NEWLAB01'));
  assert.equal(readJson(path.join(root, 'groups', CLUB, 'state.json')).name, 'Journal Club (renamed)', 'a renamed group takes its new name, unchanged or not');
});

test('a group I leave, or lose access to, has its mirror deleted; signing out deletes them all', async (t) => {
  const w = world();
  let refuse = '';
  const api = await fakeApi(t, w, { trouble: (url) => (refuse && url.pathname.startsWith(`/groups/${refuse}/`) ? { status: 403, body: 'Forbidden' } : null) });
  const root = path.join(tmp('gone'), '.zotero');
  const sync = syncer(api.base, root);
  await sync.sync();
  assert.ok(fs.existsSync(path.join(root, 'groups', LAB, 'items.json')) && fs.existsSync(path.join(root, 'groups', CLUB, 'items.json')));
  fs.mkdirSync(path.join(root, 'groups', LAB, 'files', 'ATTSAME1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'groups', LAB, 'files', 'ATTSAME1', 'lab.pdf'), '%PDF');

  // Left the club: no longer listed.
  w.groups.delete(CLUB);
  let done = await sync.sync();
  assert.ok(!fs.existsSync(path.join(root, 'groups', CLUB)), 'its mirror is gone');
  assert.ok(fs.existsSync(path.join(root, 'groups', LAB, 'files', 'ATTSAME1', 'lab.pdf')), 'the lab is left as it was');
  assert.deepEqual([done.state, done.groups, done.problems], ['synced', 1, []]);
  assert.match(mirror.listLibraries(root, '').entries.map((e) => e.name).join('|'), /^My Library\|Lab Readings\|/);
  assert.deepEqual(mirror.listLibraries(root, 'Journal Club'), { missing: true });

  // Access to the lab lost: listed still, but it answers 403.
  refuse = LAB;
  done = await sync.sync();
  assert.ok(!fs.existsSync(path.join(root, 'groups', LAB)), 'a group that refuses access goes, its downloads with it');
  assert.deepEqual([done.state, done.groups, done.problems], ['synced', 0, []]);
  assert.ok(fs.existsSync(path.join(root, 'items.json')), 'My Library stays');

  // When the list of groups cannot be had, nothing is deleted.
  refuse = '';
  await sync.sync();
  assert.ok(fs.existsSync(path.join(root, 'groups', LAB, 'items.json')), 'access back: mirrored again');
  const broken = syncer(api.base, root, { fetch: async (url, init) => (/\/groups\?/.test(String(url)) ? new Response('{}', { status: 400 }) : fetch(url, init)) });
  done = await broken.sync();
  assert.equal(done.state, 'synced');
  assert.match(done.problems.map((p) => p.error).join(), /list of your groups could not be had/);
  assert.ok(fs.existsSync(path.join(root, 'groups', LAB, 'items.json')), 'the groups\' mirrors are left as they are');

  // Signing out deletes everything, the groups too.
  sync.clear();
  assert.ok(!fs.existsSync(root));
});

test('one group failing does not stop My Library or the other group, and the row says which', async (t) => {
  const w = world();
  const api = await fakeApi(t, w, { trouble: (url) => (url.pathname.startsWith(`/groups/${LAB}/`) ? { status: 500, body: 'oops' } : null) });
  const root = path.join(tmp('fail'), '.zotero');
  const sync = syncer(api.base, root);
  const done = await sync.sync();
  assert.equal(done.state, 'synced', 'My Library synced');
  assert.deepEqual(done.problems, [{ name: 'Lab Readings', error: 'Zotero is not answering right now. Try again later.' }]);
  assert.ok(fs.existsSync(path.join(root, 'items.json')));
  assert.ok(fs.existsSync(path.join(root, 'groups', CLUB, 'items.json')), 'the club, after the lab, still synced');
  assert.ok(!fs.existsSync(path.join(root, 'groups', LAB)), 'nothing half-written for the lab, and not deleted as gone: it was never there');
  assert.equal(api.seen.filter((r) => r.path === `/groups/${LAB}/collections`).length, 5, 'retried as any 5xx is, then given up');

  const { zoteroSyncLine } = connections();
  const line = zoteroSyncLine(done);
  assert.equal(line.text, 'Synced · 2 items · 1 group');
  assert.equal(line.error, false);
  assert.equal(line.groups, 'Lab Readings: Zotero is not answering right now. Try again later.');
  assert.equal(zoteroSyncLine({ state: 'synced', items: 3, groups: 0, problems: [] }).groups, '', 'no group, nothing more said');
  assert.equal(zoteroSyncLine({ state: 'synced', items: 1204 }).text, 'Synced · 1204 items', 'without groups, as before');

  // My Library failing (a 4xx of its own) is the row's error; the groups still sync.
  const mineDown = await fakeApi(t, world(), { trouble: (url) => (url.pathname === `/users/${USER_ID}/collections` ? { status: 400, body: 'bad' } : null) });
  const other = path.join(tmp('mine-down'), '.zotero');
  const failed = await syncer(mineDown.base, other).sync();
  assert.equal(failed.state, 'error');
  assert.match(failed.error, /Zotero answered 400/);
  assert.ok(fs.existsSync(path.join(other, 'groups', LAB, 'items.json')) && fs.existsSync(path.join(other, 'groups', CLUB, 'items.json')));

  // A key Zotero refuses ends it all, as before: no group is asked, none deleted.
  const refused = createZoteroSync({ api: api.base, root, account: () => ({ userID: USER_ID, key: 'wrong' }), sleep: async () => {} });
  api.seen.length = 0;
  const no = await refused.sync();
  assert.match(no.error, /refused the key/);
  assert.deepEqual(api.seen.map((r) => r.path), [`/users/${USER_ID}/collections`]);
  assert.ok(fs.existsSync(path.join(root, 'groups', CLUB, 'items.json')));
});

/* ------------------------------------------------------------------------------------------ the same key, two libraries */

test('the same item key in two libraries: two items, two mentions, two chips, two files, two <zotero_item>s', async (t) => {
  const w = world();
  const files = await fakeFiles(t);
  const api = await fakeApi(t, w, { files });
  const root = path.join(tmp('same'), '.zotero');
  const sync = syncer(api.base, root);
  await sync.sync();
  const { zoteroMention, zoteroMentionOf, ZOTERO_MENTION_RE, INLINE, inlineHtml, tokShown } = await doc();

  // The @ menu: My Library then each group, by name, each browsable by collection.
  const top = mirror.listLibraries(root, '');
  assert.deepEqual(top.entries.filter((e) => e.dir).map((e) => [e.name, e.rel]), [['My Library', 'My Library'], ['Journal Club', 'Journal Club'], ['Lab Readings', 'Lab Readings']]);
  const both = top.entries.filter((e) => ['My Own Paper', 'The Lab Paper'].includes(e.name)).map((e) => [e.name, e.zotero, e.hint]);
  assert.deepEqual(both, [['My Own Paper', 'SAME0001', 'Mine · 2020'], ['The Lab Paper', `g${LAB}:SAME0001`, 'Lab · 2023 · Lab Readings']], 'at the top every item, a group\'s saying its group');
  assert.deepEqual(mirror.listLibraries(root, 'Lab Readings').entries.map((e) => [e.name, e.rel, e.zotero || null]).slice(0, 1), [['Methods', 'Lab Readings/Methods', null]]);
  assert.deepEqual(mirror.listLibraries(root, 'Lab Readings/Methods').entries.map((e) => [e.name, e.zotero]), [['The Lab Paper', `g${LAB}:SAME0001`]]);
  assert.deepEqual(mirror.listLibraries(root, 'My Library/Reading').entries.map((e) => [e.name, e.zotero]), [['My Own Paper', 'SAME0001']]);
  const { folderRows, ZOTERO_ROW, mentionedIds } = await rail();
  const typed = folderRows({ browse: { row: ZOTERO_ROW, rel: '' }, listing: top, query: 'lab readings' });
  assert.ok(typed.some((m) => m.zotero === `g${LAB}:SAME0001`), 'a group\'s name finds its items');

  // The mention names its library; My Library's is as it always was.
  const labToken = zoteroMention('The Lab Paper', `g${LAB}:SAME0001`);
  const mineToken = zoteroMention('My Own Paper', 'SAME0001');
  assert.equal(labToken, `@[The Lab Paper](zotero:g${LAB}:SAME0001)`);
  assert.equal(mineToken, '@[My Own Paper](zotero:SAME0001)');
  assert.match(labToken, ZOTERO_MENTION_RE);
  assert.deepEqual(zoteroMentionOf(labToken), { name: 'The Lab Paper', key: `g${LAB}:SAME0001`, group: LAB });
  assert.deepEqual(zoteroMentionOf(mineToken), { name: 'My Own Paper', key: 'SAME0001', group: '' });
  assert.deepEqual(`a ${labToken}, b`.split(INLINE).filter(Boolean), ['a ', labToken, ', b']);
  assert.deepEqual(`a ${labToken}, b`.split(MAIN_INLINE).filter(Boolean), ['a ', labToken, ', b'], 'main splits it as the editor does');
  assert.equal(tokShown(labToken).shown, '@The Lab Paper');
  assert.match(inlineHtml(`x ${labToken}`), new RegExp(`data-zotero="g${LAB}:SAME0001"`));
  assert.equal(mentionedIds(labToken, [{ id: 'row-1', name: 'The Lab Paper' }]).size, 0, 'no library row is linked by it');
  assert.equal(mirror.parseRef('g12:../x'), null);
  assert.equal(mirror.parseRef(`g${LAB}:SAME0001`).group, LAB);

  // Each chip opens its own file, downloaded from its own library into its own folder.
  const zotero = { status: () => ({ configured: true, connected: true, username: 'r', userID: USER_ID, persisted: true, pending: null, error: '' }) };
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, trustedHandler: (fn) => async (event, ...args) => fn(...args), zotero, zoteroLibrary: sync });
  const call = (n, ...args) => handlers.get(`engelbart:${n}`)({}, ...args);
  const labFile = path.join(root, 'groups', LAB, 'files', 'ATTSAME1', 'lab.pdf');
  const mineFile = path.join(root, 'files', 'ATTSAME1', 'mine.pdf');
  assert.deepEqual(await call('zotero-open', `g${LAB}:SAME0001`), { path: labFile, source: 'downloaded' });
  assert.deepEqual(await call('zotero-open', 'SAME0001'), { path: mineFile, source: 'downloaded' });
  assert.equal(fs.readFileSync(labFile, 'utf8'), `%PDF-1.4 /s3/groups/${LAB}/items/ATTSAME1/file`, 'from /groups/<id>/items/<key>/file');
  assert.equal(fs.readFileSync(mineFile, 'utf8'), `%PDF-1.4 /s3/users/${USER_ID}/items/ATTSAME1/file`);
  assert.ok(files.seen.every((r) => r.key === null), 'where files are kept never gets the key');
  assert.match((await call('zotero-open', `g${CLUB}:SAME0001`)).error, /no longer in the Zotero group "Journal Club"/);
  assert.match((await call('zotero-open', 'g9999:SAME0001')).error, /group you are no longer in/);
  await assert.rejects(async () => call('zotero-open', 'g1:../x'), /invalid/);
  assert.equal((await call('zotero-list', 'Lab Readings/Methods')).entries[0].zotero, `g${LAB}:SAME0001`);

  // Bart: each mention its own block, saying its library.
  const source = { find: () => null, image: () => null, zotero: (ref, name) => mirror.mentionBlock(root, ref, name, sync) };
  const seen = new Set();
  const out = await expandMentions(`Compare ${mineToken} with ${labToken}.\nAnd ${zoteroMention('Gone', `g${CLUB}:GONE0001`)}`, source, seen);
  const body = out.lines.join('\n');
  assert.equal(out.files, 2, 'two items, though they share a key');
  for (const line of [
    '<zotero_item key="SAME0001" cite="mine2020my" library="My Library">', 'title: My Own Paper', "library: My Library (the person's own Zotero library)",
    `<zotero_item key="SAME0001" cite="lab2023lab" library="Lab Readings" group="${LAB}">`, 'title: The Lab Paper', `library: Lab Readings (Zotero group ${LAB})`,
    `attachment: ${labFile} (application/pdf)`, `full text: ${path.join(root, 'groups', LAB, 'items', 'SAME0001', 'fulltext-ATTSAME1.txt')}`,
    '<note>\nShared note from the lab.\n</note>', '<quote>\na lab claim\n</quote>', `folder: ${path.join(root, 'groups', LAB, 'items', 'SAME0001')}`,
    `<zotero_item key="GONE0001" title="Gone" library="Journal Club" group="${CLUB}" missing="true" />`,
  ]) assert.ok(body.includes(line), `has: ${line}\n${body}`);
  assert.ok(seen.has(`zfile:${labFile}`) && seen.has(`zfile:${mineFile}`));

  // The line every @bart turn carries names each library's folder; the prompt says what they are.
  const pointer = mirror.pointerLine(root).split('\n');
  assert.equal(pointer.length, 3);
  assert.match(pointer[0], /^zotero library: .* \(My Library, 1 items;/);
  assert.equal(pointer[2], `zotero group: ${path.join(root, 'groups', LAB)} ("Lab Readings", group ${LAB}, 3 items; the same files)`);
  assert.match(BART_SYSTEM_PROMPT, /"zotero group:" line/);
  assert.match(BART_SYSTEM_PROMPT, /library="My Library"/);
});

test('an old-style mention, written before groups, is still My Library\'s item: its chip, and Bart', async (t) => {
  const w = world();
  const files = await fakeFiles(t);
  const api = await fakeApi(t, w, { files });
  const db = require('../src/main/store/db.cjs');
  const { ensureHome } = require('../src/main/store/home.cjs');
  const projects = require('../src/main/store/projects.cjs');
  const { buildContext } = require('../src/main/bart/context.cjs');
  const homeDir = tmp('home');
  const layout = ensureHome(homeDir);
  const root = mirror.mirrorDir(layout.root);
  const sync = syncer(api.base, root);
  await sync.sync();
  const ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root), zotero: () => sync };
  t.after(() => db.closeAll());
  const project = await projects.createProject(ctx, { name: 'Groups' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Reading' });
  // Written by build 2, 3 or 4: no library in it.
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, `About @[My Own Paper](zotero:SAME0001) and @[The Lab Paper](zotero:g${LAB}:SAME0001)\n@bart compare them\nbart~> z1\n`);
  const c = await buildContext(ctx, project.id, { ref: { kind: 'workspace', workspaceId: workspace.id }, workspaceId: workspace.id, askId: 'z1', agent: 'bart' });
  assert.match(c.documents, /<zotero_item key="SAME0001" cite="mine2020my" library="My Library">\ntitle: My Own Paper/);
  assert.match(c.documents, new RegExp(`<zotero_item key="SAME0001" cite="lab2023lab" library="Lab Readings" group="${LAB}">\\ntitle: The Lab Paper`));
  assert.match(c.head, /zotero library: .*My Library, 1 items/);
  assert.match(c.head, new RegExp(`zotero group: .*"Lab Readings", group ${LAB}, 3 items`));

  const zotero = { status: () => ({ configured: true, connected: true, username: 'r', userID: USER_ID, persisted: true, pending: null, error: '' }) };
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, trustedHandler: (fn) => async (event, ...args) => fn(...args), zotero, zoteroLibrary: sync });
  assert.deepEqual(await handlers.get('engelbart:zotero-open')({}, 'SAME0001'), { path: path.join(root, 'files', 'ATTSAME1', 'mine.pdf'), source: 'downloaded' });

  // A mirror from before build 5 (no groups/ yet, no groupID in its state) is synced on, not started over.
  const fresh = path.join(tmp('old'), '.zotero');
  const old = syncer(api.base, fresh);
  w.groups.clear();
  await old.sync();
  const state = readJson(path.join(fresh, 'state.json'));
  assert.equal(state.groupID, undefined);
  w.groups = world().groups;
  api.seen.length = 0;
  await old.sync();
  assert.equal(api.seen.find((r) => r.path === `/users/${USER_ID}/collections`).unless, String(state.version), 'My Library from its kept version');
  assert.ok(fs.existsSync(path.join(fresh, 'groups', LAB, 'items.json')));
});

/* ------------------------------------------------------------------------------------ builds 3 and 4 for a group item */

test('a group item: its free copy, its download from the browser and a pdf dropped on its chip go to its group', async (t) => {
  const w = world();
  const api = await fakeApi(t, w);
  // OpenAlex has a free copy of the lab's FREELAB1 only.
  const publisher = await serve(t, (req, res) => { res.setHeader('content-type', 'application/pdf'); res.end('%PDF-1.7 the free copy'); });
  const openalex = await serve(t, (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.includes('10.5555/lab.free')) return res.end(JSON.stringify({ best_oa_location: { pdf_url: `${publisher}/paper.pdf` } }));
    res.statusCode = 404; res.end('{}');
  });
  const nothing = await serve(t, (req, res) => { res.statusCode = 404; res.end('{}'); });
  const downloads = tmp('downloads');
  const events = { finding: [], waiting: [], downloaded: [] };
  const root = path.join(tmp('oa'), '.zotero');
  const sync = syncer(api.base, root, {
    openAlex: openalex, semanticScholar: nothing, arxivApi: nothing, arxiv: nothing,
    downloadsDir: () => downloads, downloadPollMs: 20, readPdfText: async (file) => fs.readFileSync(file, 'utf8'),
    onFinding: (ref, on) => events.finding.push([ref, on]), onWaiting: (ref, on) => events.waiting.push([ref, on]), onDownloaded: (ref, copy) => events.downloaded.push([ref, copy.path]),
    now: () => Date.parse('2026-10-07T12:00:00Z'),
  });
  t.after(() => sync.stopWatching());
  await sync.sync();
  const zotero = { status: () => ({ configured: true, connected: true, username: 'r', userID: USER_ID, persisted: true, pending: null, error: '' }) };
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (n, fn) => handlers.set(n, fn) }, trustedHandler: (fn) => async (event, ...args) => fn(...args), zotero, zoteroLibrary: sync });
  const call = (n, ...args) => handlers.get(`engelbart:${n}`)({}, ...args);
  const lab = path.join(root, 'groups', LAB);

  // Build 3: a free copy, kept in the group's folder, the chip told by its ref.
  const free = await call('zotero-open', `g${LAB}:FREELAB1`);
  const copy = path.join(lab, 'files', 'FREELAB1', 'Barron 2026 Behavioral Context for Adaptive Tutoring.pdf');
  assert.deepEqual(free, { path: copy, source: 'open access' });
  assert.equal(fs.readFileSync(copy, 'utf8'), '%PDF-1.7 the free copy');
  assert.equal(readJson(path.join(lab, 'items', 'FREELAB1', 'open-access.json')).source, 'OpenAlex');
  assert.deepEqual(events.finding, [[`g${LAB}:FREELAB1`, true], [`g${LAB}:FREELAB1`, false]]);
  assert.ok(!fs.existsSync(path.join(root, 'files', 'FREELAB1')) && !fs.existsSync(path.join(root, 'items', 'FREELAB1')), 'nothing in My Library\'s folder');
  const block = await mirror.mentionBlock(root, `g${LAB}:FREELAB1`, 'x', sync);
  assert.ok(block.lines.some((line) => line.startsWith(`pdf: ${copy} (source="open access"`)), block.lines.join('\n'));

  // Build 4: no free copy, its page in the browser, its download waited for by its ref and copied into the group.
  const shut = await call('zotero-open', `g${LAB}:SHUTLAB1`);
  assert.deepEqual(shut, { url: 'https://doi.org/10.5555/lab.closed', external: true, waiting: true });
  assert.deepEqual(await call('zotero-waiting'), [`g${LAB}:SHUTLAB1`]);
  fs.writeFileSync(path.join(downloads, 'closed.pdf'), '%PDF-1.4\nClosed Group Paper\nShut, 2019');
  for (let i = 0; i < 200 && !events.downloaded.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const got = path.join(lab, 'files', 'SHUTLAB1', 'Shut 2019 Closed Group Paper.pdf');
  assert.deepEqual(events.downloaded, [[`g${LAB}:SHUTLAB1`, got]]);
  assert.deepEqual(events.waiting, [[`g${LAB}:SHUTLAB1`, true], [`g${LAB}:SHUTLAB1`, false]]);
  assert.equal(readJson(path.join(lab, 'items', 'SHUTLAB1', 'open-access.json')).source, 'downloaded in browser');
  assert.deepEqual(await call('zotero-open', `g${LAB}:SHUTLAB1`), { path: got, source: 'downloaded in browser' });

  // A pdf dropped on a group item's chip.
  const chosen = path.join(tmp('chosen'), 'mine.pdf');
  fs.writeFileSync(chosen, '%PDF-1.4 chosen');
  const dropped = path.join(lab, 'files', 'FREELAB1', 'Barron 2026 Behavioral Context for Adaptive Tutoring.pdf');
  assert.deepEqual(await call('zotero-attach', `g${LAB}:FREELAB1`, chosen), { path: dropped, source: 'added by hand' });
  assert.equal(readJson(path.join(lab, 'items', 'FREELAB1', 'open-access.json')).source, 'added by hand');
  assert.match((await call('zotero-attach', `g${CLUB}:FREELAB1`, chosen)).error, /no longer in that Zotero group/);
  assert.ok(api.seen.every((r) => r.method === 'GET'), 'nothing written back to Zotero');
});
