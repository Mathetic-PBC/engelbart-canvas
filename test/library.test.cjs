'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const library = require('../src/main/store/library.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-library-'));
const layout = ensureHome(homeDir);
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-fixtures-'));
fs.writeFileSync(path.join(fixtures, 'hypocompass.pdf'), '%PDF-1.4 test');
fs.writeFileSync(path.join(fixtures, 'problems.csv'), 'a,b\n');
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('seedIfEmpty inserts the four fixtures once', async () => {
  assert.equal(await library.seedIfEmpty(ctx, fixtures), 4);
  assert.equal(await library.seedIfEmpty(ctx, fixtures), 0);
  const rows = await library.listLibrary(ctx);
  assert.deepEqual(rows.map((row) => [row.type, row.tags]).sort(), [['csv', []], ['pdf', []], ['website', ['git']], ['website', ['paper']]]);
  const paper = rows.find((row) => row.type === 'pdf');
  assert.equal(paper.path, path.join(layout.testRoot, 'seed', 'hypocompass.pdf'));
  assert.ok(fs.existsSync(paper.path));
});

test('readLibraryFile returns pdf bytes and refuses other files', async () => {
  const rows = await library.listLibrary(ctx);
  const paper = rows.find((row) => row.type === 'pdf');
  const file = await library.readLibraryFile(ctx, paper.id);
  assert.equal(file.name, paper.name);
  assert.equal(Buffer.from(file.bytes).toString('utf8'), '%PDF-1.4 test');
  const dataset = rows.find((row) => row.type === 'csv');
  await assert.rejects(() => library.readLibraryFile(ctx, dataset.id), /Only downloaded pdf/);
  const site = rows.find((row) => row.type === 'website' && row.tags.includes('paper'));
  await assert.rejects(() => library.readLibraryFile(ctx, site.id), /no local file/);
  await assert.rejects(() => library.readLibraryFile(ctx, '../etc'), TypeError);
});

test('readLibraryFile: a pdf macOS refuses to stat or read says so and where to allow it (2026-10-02)', async (t) => {
  const { BLOCKED } = require('../src/main/stage/files.cjs');
  const paper = (await library.listLibrary(ctx)).find((row) => row.type === 'pdf');
  for (const [method, code] of [['statSync', 'EPERM'], ['readFileSync', 'EPERM'], ['readFileSync', 'EACCES']]) {
    const real = fs[method];
    t.mock.method(fs, method, function (target, ...rest) {
      if (target === paper.path) throw Object.assign(new Error(`${code}: operation not permitted, ${method} '${target}'`), { code });
      return real.call(fs, target, ...rest);
    });
    await assert.rejects(() => library.readLibraryFile(ctx, paper.id), { message: BLOCKED }, `${method} ${code}`);
    t.mock.restoreAll();
  }
  assert.equal(Buffer.from((await library.readLibraryFile(ctx, paper.id)).bytes).toString('utf8'), '%PDF-1.4 test', 'read again once allowed');
  const gone = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Gone', type: 'pdf', tags: [], path: path.join(homeDir, 'gone.pdf') });
  await assert.rejects(() => library.readLibraryFile(ctx, gone.id), { message: 'Nothing is at that path' });
});

test('annotations round-trip per library id', async () => {
  const id = randomUUID();
  assert.equal(await library.readAnnotations(ctx, id), null);
  const marks = { 1: [{ id: 'm1', rects: [{ x: 1, y: 2, w: 3, h: 4 }], side: 'left', y: 2, note: 'hi', text: 'sel', pos: null }] };
  assert.equal(await library.writeAnnotations(ctx, id, marks), true);
  assert.deepEqual(await library.readAnnotations(ctx, id), marks);
  await assert.rejects(() => library.writeAnnotations(ctx, 'bad', {}), TypeError);
});

test('ink on a pdf in the Browser pane: the row\'s when the library holds it, else by address until a row is added', async () => {
  const { pathToFileURL } = require('node:url');
  const ink = (note) => ({ 1: [{ id: note, rects: [], side: null, y: 0, note, text: '', pos: { x: 0, y: 0 } }] });
  const rows = await library.listLibrary(ctx);
  // A pdf on disk the library holds shares the Paper pane's ink.
  const paper = rows.find((row) => row.type === 'pdf');
  await library.writePageAnnotations(ctx, pathToFileURL(paper.path).href, ink('disk'));
  assert.deepEqual(await library.readAnnotations(ctx, paper.id), ink('disk'));
  // arXiv's pdf is the paper its abstract page names.
  const arxiv = rows.find((row) => row.url === 'https://arxiv.org/abs/2310.05292');
  await library.writePageAnnotations(ctx, 'https://arxiv.org/pdf/2310.05292v2', ink('arxiv'));
  assert.deepEqual(await library.readAnnotations(ctx, arxiv.id), ink('arxiv'));
  // A pdf the library does not hold keeps its ink by address (a place in it is the same pdf), and a row added later finds it.
  assert.equal(await library.readPageAnnotations(ctx, 'https://example.com/a.pdf'), null);
  await library.writePageAnnotations(ctx, 'https://example.com/a.pdf#page=2', ink('web'));
  assert.deepEqual(await library.readPageAnnotations(ctx, 'https://example.com/a.pdf'), ink('web'));
  const added = await library.addItem(ctx, 'https://example.com/a.pdf');
  assert.deepEqual(await library.readAnnotations(ctx, added.id), ink('web'));
  await library.writePageAnnotations(ctx, 'https://example.com/a.pdf', ink('after'));
  assert.deepEqual(await library.readAnnotations(ctx, added.id), ink('after'));
});

test('a web pdf saved as a copy (2026-09-23): the file under assets/pdfs, the address kept, found by it, ink carried, no twice', async () => {
  const ink = (note) => ({ 1: [{ id: note, rects: [], side: null, y: 0, note, text: '', pos: { x: 0, y: 0 } }] });
  const bytes = new Uint8Array(Buffer.from('%PDF-1.7 copy'));
  await library.writePageAnnotations(ctx, 'https://papers.example.org/files/Retrieval%20Study.pdf', ink('before'));
  const row = await library.addPdfCopy(ctx, 'https://papers.example.org/files/Retrieval%20Study.pdf', bytes, { inspectPdf: async () => ['paper'] });
  assert.equal(row.type, 'pdf');
  assert.equal(row.name, 'Retrieval Study');
  assert.equal(row.url, 'https://papers.example.org/files/Retrieval%20Study.pdf');
  assert.equal(row.path, path.join(layout.testRoot, 'assets', 'pdfs', `${row.id}.pdf`));
  assert.deepEqual(row.tags, ['paper']);
  assert.equal(fs.readFileSync(row.path, 'utf8'), '%PDF-1.7 copy');
  assert.deepEqual(await library.readAnnotations(ctx, row.id), ink('before'));
  assert.equal(Buffer.from((await library.readLibraryFile(ctx, row.id)).bytes).toString(), '%PDF-1.7 copy');
  // the address answers for the row: the Save button reads ✓ / + Workspace, and ink on the page goes to the row
  assert.equal((await library.lookupItem(ctx, 'http://www.papers.example.org/files/Retrieval%20Study.pdf')).row.id, row.id);
  await library.writePageAnnotations(ctx, 'https://papers.example.org/files/Retrieval%20Study.pdf', ink('after'));
  assert.deepEqual(await library.readAnnotations(ctx, row.id), ink('after'));
  await assert.rejects(() => library.addPdfCopy(ctx, 'https://papers.example.org/files/Retrieval%20Study.pdf', bytes), (error) => error.code === 'EXISTS');
  await assert.rejects(() => library.addPdfCopy(ctx, 'https://x.example.org/b.pdf', new Uint8Array(Buffer.from('<html>'))), /not a pdf/);
  await assert.rejects(() => library.addPdfCopy(ctx, '/Users/h/a.pdf', bytes), /from the web/);
  // an arXiv pdf is the paper its abstract page names
  const arxiv = await library.addPdfCopy(ctx, 'https://arxiv.org/pdf/1706.03762v7', bytes, { name: 'Attention' });
  assert.deepEqual([arxiv.name, arxiv.url, arxiv.tags], ['Attention', 'https://arxiv.org/abs/1706.03762', ['paper']]);
});

/* ------------------------------------------------------- a web page saved from the Stage (MATH-17) */

const pagesDir = () => path.join(layout.testRoot, 'assets', 'pages');
const pageFolders = () => { try { return fs.readdirSync(pagesDir()).sort(); } catch { return []; } };
const PAGE_HTML = '<html><head><title>A Post</title><meta name="description" content="What the post is about."></head><body><img src="index_files/a.png"></body></html>';

/** A stand-in for the tab's webContents.savePage: index.html and its files folder, then what the tab shows. */
function fakeSave(url, { title = 'A Post', html = PAGE_HTML } = {}) {
  const calls = [];
  const save = async (dir) => {
    calls.push(dir);
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.mkdirSync(path.join(dir, 'index_files'));
    fs.writeFileSync(path.join(dir, 'index_files', 'a.png'), 'png');
    return { file: path.join(dir, 'index.html'), url, title };
  };
  return { save, calls };
}

test('a web page saved as a copy: one html row with its file and its address, found by either, never twice', async () => {
  const url = 'https://blog.example.org/posts/kept?id=2';
  const { save, calls } = fakeSave(url);
  const row = await library.addPageCopy(ctx, url, save, { name: '  My   post ' });
  const dir = path.join(fs.realpathSync(pagesDir()), row.id);
  assert.deepEqual(calls, [dir]);
  assert.deepEqual([row.type, row.tags, row.name, row.url, row.project_id, row.categorized], ['html', [], 'My post', url, null, library.CATEGORY_RULES]);
  assert.equal(row.path, path.join(dir, 'index.html'));
  assert.equal(fs.readFileSync(row.path, 'utf8'), PAGE_HTML);
  assert.ok(fs.statSync(path.join(dir, 'index_files')).isDirectory(), 'its files folder');
  assert.equal(row.summary, 'What the post is about.', 'described by the copy, as addItem asks a page');
  // the address answers for it (the Save button's ✓), and so does the copy open in the Stage
  assert.equal((await library.lookupItem(ctx, 'http://www.blog.example.org/posts/kept/?id=2#top')).row.id, row.id);
  assert.equal((await library.lookupItem(ctx, row.path)).row.id, row.id);
  // a second save of the same page is refused before anything is written
  const before = pageFolders();
  const again = fakeSave(url);
  await assert.rejects(() => library.addPageCopy(ctx, url, again.save), (error) => error.code === 'EXISTS' && error.row.id === row.id);
  assert.equal(again.calls.length, 0);
  assert.deepEqual(pageFolders(), before);
  // recategorizing leaves it as it is
  await library.recategorize(ctx);
  const kept = await ctx.libraryDb.get(row.id);
  assert.deepEqual([kept.type, kept.tags], ['html', []]);
});

test('a page copy: named after the page\'s title, else its address', async () => {
  const titled = await library.addPageCopy(ctx, 'https://news.example.org/a', fakeSave('https://news.example.org/a', { title: '  The   Headline ' }).save);
  assert.equal(titled.name, 'The Headline');
  const long = await library.addPageCopy(ctx, 'https://news.example.org/b', fakeSave('https://news.example.org/b', { title: 'x'.repeat(300) }).save, { name: '   ' });
  assert.equal(long.name, 'x'.repeat(200));
  const untitled = await library.addPageCopy(ctx, 'https://news.example.org/c/', fakeSave('https://news.example.org/c/', { title: '', html: '<p>no head</p>' }).save);
  assert.equal(untitled.name, 'news.example.org/c');
  assert.equal(untitled.summary, null);
});

test('a page copy that cannot be saved or written leaves no folder and no row', async (t) => {
  const count = async () => (await ctx.libraryDb.list()).length;
  const rows = await count();
  const folders = pageFolders();
  await assert.rejects(() => library.addPageCopy(ctx, 'https://fail.example.org/a', async (dir) => { fs.writeFileSync(path.join(dir, 'index.html'), 'half'); throw new Error('The page is still loading'); }), /still loading/);
  // the tab went on to another page meanwhile: what it saved is not this address's
  await assert.rejects(() => library.addPageCopy(ctx, 'https://fail.example.org/b', fakeSave('https://fail.example.org/elsewhere').save), /changed before it was saved/);
  await assert.rejects(() => library.addPageCopy(ctx, 'https://fail.example.org/c', async (dir) => ({ file: path.join(dir, 'index.html'), url: 'https://fail.example.org/c', title: '' })), /not saved/);
  t.mock.method(ctx.libraryDb, 'insert', async () => { throw new Error('the database is closed'); });
  await assert.rejects(() => library.addPageCopy(ctx, 'https://fail.example.org/d', fakeSave('https://fail.example.org/d').save), /database is closed/);
  t.mock.restoreAll();
  assert.deepEqual(pageFolders(), folders);
  assert.equal(await count(), rows);
});

test('a page copy takes the ink drawn on the page while it was only an address', async () => {
  const ink = (note) => ({ 1: [{ id: note, rects: [], side: null, y: 0, note, text: '', pos: { x: 0, y: 0 } }] });
  const url = 'https://essays.example.org/inked';
  await library.writePageAnnotations(ctx, `${url}#part-2`, ink('before'));
  const row = await library.addPageCopy(ctx, url, fakeSave(url).save);
  assert.ok(fs.existsSync(path.join(layout.testRoot, 'annotations', `${row.id}.json`)), 'the row has ink of its own');
  assert.deepEqual(await library.readAnnotations(ctx, row.id), ink('before'));
  await library.writePageAnnotations(ctx, url, ink('after'));
  assert.deepEqual(await library.readAnnotations(ctx, row.id), ink('after'));
});

test('repositories and papers never reach addPageCopy: the Stage adds them by address, as before', async () => {
  const { savesPageCopy } = await import(require('node:url').pathToFileURL(path.join(__dirname, '../src/renderer/model/stage.js')).href);
  const page = { input: '', tabId: 'tab-1', webPage: true, bytes: null };
  const found = async (input) => (await library.lookupItem(ctx, input)).found;
  assert.equal(savesPageCopy({ ...page, input: 'https://blog.example.org/new' }, await found('https://blog.example.org/new')), true);
  for (const input of ['https://github.com/karpathy/micrograd', 'https://gitlab.com/group/tool.git', 'https://arxiv.org/abs/2310.05292', 'https://doi.org/10.1145/3544548.3580919']) {
    assert.equal(savesPageCopy({ ...page, input }, await found(input)), false, input);
    const { save, calls } = fakeSave(input);
    await assert.rejects(() => library.addPageCopy(ctx, input, save), /plain web page/, input);
    assert.equal(calls.length, 0, input);
  }
  // nor does anything that is not a web page in a tab: a pdf's bytes, a file, a page with no tab, no answer yet
  assert.equal(savesPageCopy({ ...page, bytes: new Uint8Array(1) }, await found('https://blog.example.org/new')), false);
  assert.equal(savesPageCopy({ ...page, webPage: false }, await found('https://blog.example.org/new')), false);
  assert.equal(savesPageCopy({ ...page, tabId: null }, await found('https://blog.example.org/new')), false);
  assert.equal(savesPageCopy(page, null), false);
  await assert.rejects(() => library.addPageCopy(ctx, path.join(homeDir, 'page.html'), fakeSave('').save), /from the web/);
});

test('ipc: add-library-page saves the calling window\'s tab into the library\'s folder and tells the other windows', async (t) => {
  const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-page-ipc-'));
  const store = createStore({ homeDir: home, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  const announced = [];
  const asked = [];
  const caller = { id: 7 };
  const savePageFor = async (win, tabId, dir) => {
    asked.push([win, tabId, dir]);
    fs.writeFileSync(path.join(dir, 'index.html'), PAGE_HTML);
    return { file: path.join(dir, 'index.html'), url: 'https://blog.example.org/ipc', title: 'From the tab' };
  };
  const ipcMain = { handle: (name, fn) => handlers.set(name, fn) };
  registerEngelbartIpc({ store, ipcMain, trustedHandler: (fn) => fn, windowHandler: (fn) => (...args) => fn(caller, ...args), describe: async () => null, identifyRepo: async () => null, savePageFor, announce: (channel, _payload, options) => announced.push([channel, options && options.except]) });
  const addPage = handlers.get('engelbart:add-library-page');
  const row = await addPage('tab-3', 'https://blog.example.org/ipc', { name: 'Named' });
  assert.deepEqual([row.type, row.name, row.url], ['html', 'Named', 'https://blog.example.org/ipc']);
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].slice(0, 2), [caller, 'tab-3']);
  assert.equal(path.dirname(row.path), asked[0][2]);
  assert.ok(row.path.startsWith(fs.realpathSync(home)), 'under the data root');
  assert.deepEqual(announced, [['engelbart:library-changed', caller]]);
  await assert.rejects(async () => addPage(42, 'https://blog.example.org/x'), /tab id must be a string/);
  await assert.rejects(async () => addPage('tab-3', null), /address must be a string/);
  await assert.rejects(async () => addPage('tab-3', 'https://blog.example.org/ipc'), (error) => error.code === 'EXISTS');
  assert.equal(asked.length, 1, 'nothing was saved for a refusal');
  // a copy without the browser's views cannot save a page
  const bare = new Map();
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => bare.set(name, fn) }, trustedHandler: (fn) => fn, describe: async () => null, identifyRepo: async () => null });
  await assert.rejects(async () => bare.get('engelbart:add-library-page')('tab-3', 'https://blog.example.org/y'), /cannot be saved here/);
});
