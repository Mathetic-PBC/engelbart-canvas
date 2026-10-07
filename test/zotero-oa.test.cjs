'use strict';

// MATH-65 build 3: a free copy of a Zotero item with no pdf of its own (src/main/zotero/oa.cjs), found through a fake
// OpenAlex and fake publishers on loopback: kept when it really is a pdf, a page passed over for the next address, a
// miss remembered for 7 days, a timeout. Then what a chip does (the paper viewer, or the default browser), and the
// <zotero_item> Bart is given with the copy found.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { createZoteroSync, writeViews } = require('../src/main/zotero/sync.cjs');
const { createOpenAccess, cleanDoi, pdfName, candidates, MISS_MS } = require('../src/main/zotero/oa.cjs');
const mirror = require('../src/main/zotero/mirror.cjs');
const { expandMentions } = require('../src/main/context/expand-mentions.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');

const KEY = 'Zk3yN0tToB3S3ntAnywh3r3';
const USER_ID = '475425';
const DAY = 24 * 60 * 60_000;

const doc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const zoteroModel = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/zotero.js')).href);

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `zotero-oa-${name}-`));

/** A mirror as a sync leaves it: Smith (DOI, no attachment), Lee (DOI, its own pdf in storage), Page (URL only). */
function mirrorOf(root, storage) {
  const items = {
    SMITH001: { key: 'SMITH001', itemType: 'journalArticle', title: 'Learning to Learn: A Survey of Methods', creators: [{ creatorType: 'author', firstName: 'Ann', lastName: 'Smith' }], date: '2020', DOI: '10.1016/j.cell.2020.01.001', url: 'https://www.sciencedirect.com/science/article/pii/S0092867420300015', abstractNote: 'We learn to learn.', dateAdded: '2020-01-01' },
    NOCOPY01: { key: 'NOCOPY01', itemType: 'journalArticle', title: 'Closed Paper', creators: [{ creatorType: 'author', lastName: 'Shut' }], date: '2019', DOI: 'https://doi.org/10.1016/closed.1', dateAdded: '2020-01-02' },
    LEE00001: { key: 'LEE00001', itemType: 'journalArticle', title: 'Own Copy', creators: [{ creatorType: 'author', lastName: 'Lee' }], date: '2021', DOI: '10.1/own', dateAdded: '2020-01-03' },
    ATTLEE01: { key: 'ATTLEE01', itemType: 'attachment', parentItem: 'LEE00001', linkMode: 'imported_file', contentType: 'application/pdf', filename: 'lee.pdf' },
    PAGE0001: { key: 'PAGE0001', itemType: 'webpage', title: 'A Page', url: 'https://example.org/page', creators: [], dateAdded: '2020-01-04' },
  };
  fs.mkdirSync(root, { recursive: true });
  writeViews(root, { collections: {}, items, bib: {} });
  fs.mkdirSync(path.join(storage, 'ATTLEE01'), { recursive: true });
  fs.writeFileSync(path.join(storage, 'ATTLEE01', 'lee.pdf'), '%PDF own');
}

/**
 * OpenAlex and two publishers. `works[doi]`: the work OpenAlex answers (null: 404). The publisher answers its paths:
 * /blocked (Elsevier's bot check, as HTML), /fake.pdf (says pdf, is a page), /hang (never answers), /paper.pdf (a pdf).
 */
async function world(t, works) {
  const seen = { openalex: [], publisher: [] };
  const publisher = await serve(t, (req, res) => {
    seen.publisher.push(req.url);
    if (req.url === '/hang') return; // never answered
    if (req.url === '/blocked') { res.setHeader('content-type', 'text/html; charset=utf-8'); return res.end('<html><body>There was a problem providing the content you requested</body></html>'); }
    if (req.url === '/fake.pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('<html>Please sign in</html>'); }
    if (req.url === '/paper.pdf') { res.setHeader('content-type', 'application/pdf'); return res.end('%PDF-1.7 the free copy'); }
    res.statusCode = 404; res.end();
  });
  const openalex = await serve(t, (req, res) => {
    seen.openalex.push({ url: req.url, method: req.method, key: req.headers['zotero-api-key'] || null });
    if (works.hang) return;
    const m = /^\/works\/doi:(.+)$/.exec(req.url.split('?')[0]);
    const doi = m ? decodeURIComponent(m[1]) : '';
    const work = typeof works[doi] === 'function' ? works[doi](publisher) : works[doi];
    if (!work) { res.statusCode = 404; return res.end('{}'); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(work));
  });
  // Build 4: Semantic Scholar and arXiv after OpenAlex; here they know nothing (test/zotero-downloads.test.cjs has them).
  const scholar = await serve(t, (req, res) => { seen.scholar = (seen.scholar || 0) + 1; if (works.hang) return; res.statusCode = 404; res.end('{}'); });
  const arxiv = await serve(t, (req, res) => { seen.arxiv = (seen.arxiv || 0) + 1; if (works.hang) return; res.setHeader('content-type', 'application/atom+xml'); res.end('<feed></feed>'); });
  return { openalex, publisher, seen, scholar, arxiv, sources: { api: openalex, semanticScholar: scholar, arxivApi: arxiv, arxiv }, syncSources: { openAlex: openalex, semanticScholar: scholar, arxivApi: arxiv, arxiv } };
}
const work = (best, ...rest) => (base) => ({ best_oa_location: best ? { pdf_url: `${base}${best}` } : null, locations: rest.map((p) => ({ pdf_url: p ? `${base}${p}` : null })) });

test('helpers: the DOI cleaned, the name of the copy, the addresses in order and once each', () => {
  assert.equal(cleanDoi('https://doi.org/10.1/ABC'), '10.1/ABC');
  assert.equal(cleanDoi('doi: 10.1000/x.y'), '10.1000/x.y');
  assert.equal(cleanDoi('not a doi'), '');
  assert.equal(pdfName({ key: 'K', title: 'Learning to Learn: A Survey of Methods', year: '2020', creators: [{ type: 'author', name: 'Ann Smith', last: 'Smith' }] }), 'Smith 2020 Learning to Learn.pdf');
  assert.equal(pdfName({ key: 'K', title: 'a/b: c', year: '', creators: [] }), 'a b.pdf');
  assert.equal(pdfName({ key: 'K0000001', title: '', creators: [] }), 'K0000001.pdf');
  assert.deepEqual(candidates({ best_oa_location: { pdf_url: 'https://a/x.pdf' }, locations: [{ pdf_url: 'https://a/x.pdf' }, { pdf_url: null }, { pdf_url: 'ftp://no' }, { pdf_url: 'https://b/y.pdf' }] }), ['https://a/x.pdf', 'https://b/y.pdf']);
});

test('a free copy found: the first address that really is a pdf, saved under the item and recorded; a page is passed over', async (t) => {
  const root = path.join(tmp('found'), '.zotero');
  const storage = tmp('storage');
  mirrorOf(root, storage);
  const w = await world(t, { '10.1016/j.cell.2020.01.001': work('/blocked', '/blocked', '/fake.pdf', '/paper.pdf') });
  const told = [];
  const clock = Date.parse('2026-10-06T12:00:00Z');
  const oa = createOpenAccess({ ...w.sources, root, now: () => clock, onFinding: (key, busy) => told.push([key, busy]) });
  const item = mirror.itemOf(root, 'SMITH001');
  const [found, again] = await Promise.all([oa.find(item), oa.find(item)]);
  const file = path.join(root, 'files', 'SMITH001', 'Smith 2020 Learning to Learn.pdf');
  assert.deepEqual(found, { path: file, url: `${w.publisher}/paper.pdf`, foundAt: '2026-10-06T12:00:00.000Z', source: 'open access', via: 'OpenAlex' });
  assert.deepEqual(again, found, 'asked twice at once: one lookup');
  assert.equal(w.seen.openalex.length, 1);
  assert.equal(w.seen.openalex[0].url, '/works/doi:10.1016/j.cell.2020.01.001');
  assert.equal(w.seen.openalex[0].method, 'GET');
  assert.equal(w.seen.openalex[0].key, null, 'no Zotero key goes to OpenAlex');
  assert.deepEqual(w.seen.publisher, ['/blocked', '/fake.pdf', '/paper.pdf'], 'best first, each address once; the bot check and the page that says pdf are passed over');
  assert.equal(fs.readFileSync(file, 'utf8'), '%PDF-1.7 the free copy');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'items', 'SMITH001', 'open-access.json'), 'utf8'));
  assert.deepEqual(record, { v: 1, source: 'OpenAlex', found: true, url: `${w.publisher}/paper.pdf`, file, checkedAt: '2026-10-06T12:00:00.000Z' });
  assert.deepEqual(told, [['SMITH001', true], ['SMITH001', false]]);

  // Kept: not asked again, and a sync leaves it alone.
  assert.deepEqual(await oa.find(item), found);
  assert.equal(w.seen.openalex.length, 1);
  writeViews(root, { collections: {}, items: { SMITH001: { key: 'SMITH001', itemType: 'journalArticle', title: 'Learning to Learn: A Survey of Methods', creators: [], DOI: '10.1016/j.cell.2020.01.001' } }, bib: {} });
  assert.ok(fs.existsSync(path.join(root, 'items', 'SMITH001', 'open-access.json')), 'a sync keeps the record');
  assert.deepEqual(oa.kept('SMITH001'), found);

  // Its file deleted: looked for again.
  fs.rmSync(file);
  assert.equal(oa.kept('SMITH001'), null);
  assert.ok((await oa.find(item)).path === file);
  assert.equal(w.seen.openalex.length, 2);

  // An item with a DOI but no address that is a pdf, or no DOI at all: none.
  assert.equal(await oa.find({ key: 'NODOI001', title: 'x', creators: [] }), null);
  assert.equal(w.seen.openalex.length, 2, 'no DOI: OpenAlex is not asked');
});

test('no free copy: none, never an error, and the miss remembered for 7 days', async (t) => {
  const root = path.join(tmp('miss'), '.zotero');
  mirrorOf(root, tmp('storage'));
  const w = await world(t, { '10.1016/closed.1': work(null, null, '/blocked') });
  let clock = Date.parse('2026-10-06T12:00:00Z');
  const oa = createOpenAccess({ ...w.sources, root, now: () => clock });
  const item = mirror.itemOf(root, 'NOCOPY01');
  assert.equal(await oa.find(item), null);
  assert.equal(w.seen.openalex[0].url, '/works/doi:10.1016/closed.1', 'the DOI as OpenAlex takes it, from https://doi.org/…');
  const record = JSON.parse(fs.readFileSync(path.join(root, 'items', 'NOCOPY01', 'open-access.json'), 'utf8'));
  assert.deepEqual(record, { v: 1, found: false, sources: ['OpenAlex', 'Semantic Scholar', 'arXiv'], checkedAt: '2026-10-06T12:00:00.000Z', until: '2026-10-13T12:00:00.000Z' });
  assert.ok(!fs.existsSync(path.join(root, 'files', 'NOCOPY01')), 'nothing saved');

  clock += 6 * DAY;
  assert.equal(await oa.find(item), null);
  assert.equal(w.seen.openalex.length, 1, 'within 7 days: not asked again');
  // A new OpenAlex (another launch) reads the miss from disk.
  assert.equal(await createOpenAccess({ ...w.sources, root, now: () => clock }).find(item), null);
  assert.equal(w.seen.openalex.length, 1);

  clock = Date.parse('2026-10-06T12:00:00Z') + MISS_MS + 1;
  assert.equal(await oa.find(item), null);
  assert.equal(w.seen.openalex.length, 2, 'after 7 days: asked again');

  // A DOI OpenAlex does not know (404) is a miss too.
  const unknown = { ...item, key: 'UNKNOWN1', doi: '10.9/unknown' };
  assert.equal(await oa.find(unknown), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'items', 'UNKNOWN1', 'open-access.json'), 'utf8')).found, false);
});

test('a timeout: a pdf address that hangs is passed over for the next; OpenAlex hanging is "no pdf", not a week-long miss', async (t) => {
  const root = path.join(tmp('timeout'), '.zotero');
  mirrorOf(root, tmp('storage'));
  const w = await world(t, { '10.1016/j.cell.2020.01.001': work('/hang', '/paper.pdf') });
  let clock = Date.parse('2026-10-06T12:00:00Z');
  const oa = createOpenAccess({ ...w.sources, root, now: () => clock, timeoutMs: 150 });
  const started = Date.now();
  const found = await oa.find(mirror.itemOf(root, 'SMITH001'));
  assert.equal(found.url, `${w.publisher}/paper.pdf`);
  assert.ok(Date.now() - started < 3000, 'the hanging address given up on its timeout');

  const hanging = await world(t, { hang: true });
  const stuck = createOpenAccess({ ...hanging.sources, root, now: () => clock, timeoutMs: 150 });
  const item = mirror.itemOf(root, 'NOCOPY01');
  assert.equal(await stuck.find(item), null, 'no pdf, no error');
  assert.ok(!fs.existsSync(path.join(root, 'items', 'NOCOPY01', 'open-access.json')), 'not remembered on disk: offline costs no week');
  assert.equal(await stuck.find(item), null);
  assert.equal(hanging.seen.openalex.length, 1, 'left alone for a while');
  clock += 61 * 60_000;
  assert.equal(await stuck.find(item), null);
  assert.equal(hanging.seen.openalex.length, 2, 'asked again after an hour');
});

test('the chip: a pdf (its own or a free copy) opens in the paper viewer, no pdf opens its DOI in the default browser', async (t) => {
  const root = path.join(tmp('chip'), '.zotero');
  const storage = tmp('storage');
  mirrorOf(root, storage);
  const w = await world(t, { '10.1016/j.cell.2020.01.001': work('/paper.pdf') });
  const zoteroApi = await serve(t, (req, res) => { res.statusCode = 404; res.end('{}'); }); // Zotero has no copy of any file
  const finding = [];
  const library = createZoteroSync({ api: zoteroApi, root, ...w.syncSources, account: () => ({ userID: USER_ID, key: KEY }), sleep: async () => {}, storageDir: storage, onFinding: (key, busy) => finding.push([key, busy]) });
  const zotero = { status: () => ({ configured: true, connected: true, username: 'r', userID: USER_ID, persisted: true, pending: null, error: '' }) };
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => async (event, ...args) => fn(...args), zotero, zoteroLibrary: library });
  const open = (key) => handlers.get('engelbart:zotero-open')({}, key);
  const { zoteroChipAction } = await zoteroModel();

  const smith = await open('SMITH001');
  assert.deepEqual(smith, { path: path.join(root, 'files', 'SMITH001', 'Smith 2020 Learning to Learn.pdf'), source: 'open access' });
  assert.deepEqual(zoteroChipAction(smith), { pdf: smith.path }, 'the free copy: the paper viewer');
  assert.deepEqual(finding, [['SMITH001', true], ['SMITH001', false]], 'the chip is told while the lookup runs');

  const lee = await open('LEE00001');
  assert.deepEqual(lee, { path: path.join(storage, 'ATTLEE01', 'lee.pdf'), source: 'storage' });
  assert.deepEqual(zoteroChipAction(lee), { pdf: lee.path }, 'its own pdf: the paper viewer');
  assert.equal(w.seen.openalex.length, 1, 'an item with its own pdf is never looked up');

  const closed = await open('NOCOPY01');
  assert.deepEqual(closed, { url: 'https://doi.org/10.1016/closed.1', external: true }, 'no copy: its DOI page, not the publisher URL in the Stage');
  assert.deepEqual(zoteroChipAction(closed), { external: 'https://doi.org/10.1016/closed.1' });
  assert.deepEqual(zoteroChipAction(await open('PAGE0001')), { external: 'https://example.org/page' }, 'no DOI: its URL, in the default browser');
  assert.match(zoteroChipAction({ error: 'gone' }).error, /gone/);

  // Workspace: a pdf to the Stage's openFile (the paper viewer, ink kept by its path), an address to openExternal.
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  const body = workspace.slice(workspace.indexOf('const openZotero'), workspace.indexOf('const openZotero') + 900);
  assert.match(body, /zoteroChipAction\(await api\.zoteroOpen\(key\)/);
  assert.match(body, /stageRef\.current\.openFile\(action\.pdf/);
  assert.match(body, /api\.openExternal\(action\.external\)/);
  assert.doesNotMatch(body, /openLink|openInput/, 'never the Stage for an address');
  // Nothing went to Zotero but reads: no writes.
});

test('the chip says "Finding a free copy…" while main looks', async (t) => {
  const filename = path.join(__dirname, '__DocEditor-zotero-oa-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  const DocEditor = compiled.exports.default;
  const chip = (key) => {
    const attrs = new Set();
    return { dataset: { mention: 'T', zotero: key }, hasAttribute: (n) => attrs.has(n), toggleAttribute: (n, on) => { if (on) attrs.add(n); else attrs.delete(n); }, attrs };
  };
  const a = chip('SMITH001'), b = chip('LEE00001');
  const editor = new DocEditor({ docKey: 'k', text: '', zoteroFinding: new Set(['SMITH001']) });
  editor.props = { docKey: 'k', text: '', zoteroFinding: new Set(['SMITH001']) };
  editor.editorEl = () => ({ querySelectorAll: (sel) => (sel === '[data-zotero]' ? [a, b] : []) });
  editor.markFinding();
  assert.deepEqual([a.attrs.has('data-finding'), b.attrs.has('data-finding')], [true, false]);
  editor.props = { ...editor.props, zoteroFinding: new Set() };
  editor.markFinding();
  assert.equal(a.attrs.has('data-finding'), false, 'done: the words go');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx'), 'utf8');
  assert.match(source, /\[data-zotero\]\[data-finding\]::after\{content:" · Finding a free copy…"/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  assert.match(preload, /onZoteroFinding: \(callback\) => subscribe\('engelbart:zotero-finding', callback\)/);
});

test('<zotero_item> with the free copy: its pdf path with source="open access", its folder granted; the prompt says to open it', async (t) => {
  const root = path.join(tmp('bart'), '.zotero');
  const storage = tmp('storage');
  mirrorOf(root, storage);
  const w = await world(t, { '10.1016/j.cell.2020.01.001': work('/paper.pdf') });
  const clock = Date.parse('2026-10-06T12:00:00Z');
  const library = createZoteroSync({ api: 'http://127.0.0.1:9', root, ...w.syncSources, account: () => ({ userID: USER_ID, key: KEY }), sleep: async () => {}, storageDir: storage, now: () => clock });
  const { zoteroMention } = await doc();
  const source = { find: () => null, image: () => null, zotero: (key, name) => mirror.itemBlock(root, key, name, { storageDir: storage, download: library.download, openAccess: library.openAccess }) };
  const seen = new Set();
  const out = await expandMentions(`Read ${zoteroMention('Learning to Learn', 'SMITH001')} and ${zoteroMention('Closed Paper', 'NOCOPY01')}`, source, seen);
  const body = out.lines.join('\n');
  const file = path.join(root, 'files', 'SMITH001', 'Smith 2020 Learning to Learn.pdf');
  assert.ok(body.includes('attachment: none'), body);
  assert.ok(body.includes(`pdf: ${file} (source="open access": found through OpenAlex at ${w.publisher}/paper.pdf on 2026-10-06)`), body);
  assert.ok(seen.has(`zfile:${file}`), 'its folder is granted to Bart');
  const closed = body.slice(body.indexOf('<zotero_item key="NOCOPY01"'));
  assert.doesNotMatch(closed.slice(0, closed.indexOf('</zotero_item>')), /^pdf:/m, 'no copy: no pdf line');
  // An item with its own pdf: its attachment, no open-access line.
  const own = await mirror.itemBlock(root, 'LEE00001', 'Own Copy', { storageDir: storage, openAccess: library.openAccess });
  assert.ok(own.lines.includes(`attachment: ${path.join(storage, 'ATTLEE01', 'lee.pdf')} (application/pdf)`));
  assert.ok(!own.lines.some((line) => line.startsWith('pdf:')));
  assert.match(BART_SYSTEM_PROMPT, /"pdf:" line when the item has no file of its own/);
  assert.match(BART_SYSTEM_PROMPT, /source="open access" for a free copy/);
  assert.match(BART_SYSTEM_PROMPT, /When the question needs more than the abstract/);
});

test('a sync never looks for free copies, and nothing is written back to Zotero', async (t) => {
  const w = await world(t, { '10.1/x': work('/paper.pdf') });
  const methods = [];
  const zoteroApi = await serve(t, (req, res) => {
    methods.push(req.method);
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json'); res.setHeader('last-modified-version', '5');
    if (url.pathname.endsWith('/items') && !url.searchParams.get('itemKey')) return res.end(JSON.stringify([{ key: 'DOI00001', version: 5, data: { key: 'DOI00001', version: 5, itemType: 'journalArticle', title: 'X', creators: [], DOI: '10.1/x' } }]));
    if (url.pathname.endsWith('/fulltext')) return res.end('{}');
    res.end('[]');
  });
  const root = path.join(tmp('nosync'), '.zotero');
  const library = createZoteroSync({ api: zoteroApi, root, ...w.syncSources, account: () => ({ userID: USER_ID, key: KEY }), sleep: async () => {} });
  assert.equal((await library.sync()).items, 1);
  assert.equal(w.seen.openalex.length, 0, 'not during a sync');
  assert.ok((await library.openAccess(mirror.itemOf(root, 'DOI00001'))).path, 'only when asked');
  assert.equal(w.seen.openalex.length, 1);
  assert.ok(methods.every((m) => m === 'GET'), 'Zotero is only read');
});
