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
