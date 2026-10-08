'use strict';

// Pdfs saved as links become saved pdfs, in the background, checked every time a library opens (2026-09-23).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const library = require('../src/main/store/library.cjs');
const webPdfs = require('../src/main/store/web-pdfs.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-webpdf-'));
const layout = ensureHome(homeDir);
let ctx;
const PDF = new Uint8Array(Buffer.from('%PDF-1.7 saved'));
const page = (name, url, tags = []) => ({ id: randomUUID(), name, type: 'website', url, tags, categorized: library.CATEGORY_RULES });

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => { await db.closeAll(); });

test('candidate: page rows only; arXiv reads its pdf address; .pdf addresses are sure; repositories and files never', () => {
  assert.deepEqual(webPdfs.candidate({ id: 'a', type: 'website', url: 'https://arxiv.org/abs/2310.05292', tags: ['paper'] }), { id: 'a', url: 'https://arxiv.org/abs/2310.05292', from: 'https://arxiv.org/pdf/2310.05292', sure: true });
  assert.equal(webPdfs.candidate({ id: 'b', type: 'website', url: 'https://x.org/a/B.PDF', tags: [] }).sure, true);
  assert.equal(webPdfs.candidate({ id: 'c', type: 'website', url: 'https://openreview.net/pdf?id=1', tags: [] }).sure, false);
  assert.equal(webPdfs.candidate({ id: 'd', type: 'website', url: 'https://github.com/o/r', tags: ['git'] }), null);
  assert.equal(webPdfs.candidate({ id: 'e', type: 'pdf', url: 'https://x.org/a.pdf', path: '/p.pdf', tags: [] }), null);
  assert.equal(webPdfs.candidate({ id: 'f', type: 'html', url: 'file:///Users/h/a.html', path: '/Users/h/a.html', tags: [] }), null);
});

test('readPdfResponse: a pdf by its type or its bytes; a page is dropped after its first chunk; an HTTP error throws', async () => {
  const bytes = await webPdfs.readPdfResponse(new Response(PDF, { headers: { 'content-type': 'application/octet-stream' } }));
  assert.equal(Buffer.from(bytes).toString(), '%PDF-1.7 saved');
  assert.equal(await webPdfs.readPdfResponse(new Response('<html>hi</html>', { headers: { 'content-type': 'text/html' } })), null);
  await assert.rejects(() => webPdfs.readPdfResponse(new Response('no', { status: 404 })), /404/);
  await assert.rejects(() => webPdfs.readPdfResponse(new Response(PDF), { max: 4 }), /larger/);
});

test('the checker: pdfs become saved pdfs (same row), pages are asked once, failures are tried again and then left', async () => {
  const saved = await ctx.libraryDb.insert(page('Retrieval', 'https://papers.example.org/retrieval.pdf'));
  const arxiv = await ctx.libraryDb.insert(page('arXiv 1706.03762', 'https://arxiv.org/abs/1706.03762', ['paper']));
  const plain = await ctx.libraryDb.insert(page('Blog', 'https://blog.example.org/post'));
  const flaky = await ctx.libraryDb.insert(page('Flaky', 'https://down.example.org/x.pdf'));
  await library.writeAnnotations(ctx, arxiv.id, { 1: [] });
  const asked = [];
  const fetchPdf = async (url) => {
    asked.push(url);
    if (url.startsWith('https://down.')) throw new Error('offline');
    return url.startsWith('https://blog.') ? null : PDF;
  };
  let changes = 0;
  const first = await webPdfs.checkWebPdfs(ctx, { fetchPdf, inspectPdf: async () => ['paper'], onChange: () => { changes += 1; } });
  assert.deepEqual(first, { pending: 4, saved: 2, pages: 1, failed: 1 });
  assert.equal(changes, 2);
  // the sure ones are asked first
  assert.deepEqual(asked.slice(0, 3).sort(), ['https://arxiv.org/pdf/1706.03762', 'https://down.example.org/x.pdf', 'https://papers.example.org/retrieval.pdf']);
  for (const id of [saved.id, arxiv.id]) {
    const row = await ctx.libraryDb.get(id);
    assert.equal(row.type, 'pdf');
    assert.equal(row.path, path.join(layout.testRoot, 'assets', 'pdfs', `${id}.pdf`));
    assert.equal(fs.readFileSync(row.path, 'utf8'), '%PDF-1.7 saved');
    assert.deepEqual(row.tags, ['paper']);
  }
  assert.equal((await ctx.libraryDb.get(arxiv.id)).url, 'https://arxiv.org/abs/1706.03762');
  assert.equal((await ctx.libraryDb.get(arxiv.id)).name, 'arXiv 1706.03762');
  assert.deepEqual(await library.readAnnotations(ctx, arxiv.id), { 1: [] }, 'ink kept by id');
  assert.equal((await ctx.libraryDb.get(plain.id)).type, 'website');
  // the next launch: only the failure is asked again
  asked.length = 0;
  const second = await webPdfs.checkWebPdfs(ctx, { fetchPdf });
  assert.deepEqual([second.pending, asked], [1, ['https://down.example.org/x.pdf']]);
  for (let i = 2; i < webPdfs.MAX_ATTEMPTS; i += 1) await webPdfs.checkWebPdfs(ctx, { fetchPdf });
  assert.equal(webPdfs.readRecord(ctx).rows[flaky.id].attempts, webPdfs.MAX_ATTEMPTS);
  asked.length = 0;
  assert.equal((await webPdfs.checkWebPdfs(ctx, { fetchPdf })).pending, 0);
  assert.deepEqual(asked, []);
  // an address that changes is asked again
  await ctx.libraryDb.updateRepo(plain.id, { name: 'Blog', url: 'https://blog.example.org/post.pdf', folder_path: null, github_id: null });
  assert.equal((await webPdfs.checkWebPdfs(ctx, { fetchPdf: async () => PDF })).saved, 1);
});

test('a docx is a library type of its own (2026-09-23)', async () => {
  const file = path.join(homeDir, 'Report.docx');
  fs.writeFileSync(file, 'PK');
  const row = await library.addItem(ctx, file);
  assert.deepEqual([row.type, row.name, row.path], ['docx', 'Report.docx', fs.realpathSync(file)]);
});

test('`again`: a row added while a run is at work is checked by one more run after it; adds meanwhile share that run', async () => {
  const first = await ctx.libraryDb.insert(page('First', 'https://slow.example.org/first.pdf'));
  let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = new Promise((resolve) => { reached = resolve; });
  const fetchPdf = async (url) => { if (url.includes('/first.pdf')) { reached(); await gate; } return PDF; };
  const running = webPdfs.checkWebPdfs(ctx, { fetchPdf });
  await asked; // the run has read the library: what is added now is not in it
  const second = await ctx.libraryDb.insert(page('Second', 'https://slow.example.org/second.pdf'));
  assert.equal(webPdfs.checkWebPdfs(ctx, { fetchPdf }), running, 'without `again`, the run at work answers');
  const again = webPdfs.checkWebPdfs(ctx, { fetchPdf, again: true });
  const third = await ctx.libraryDb.insert(page('Third', 'https://slow.example.org/third.pdf'));
  assert.equal(webPdfs.checkWebPdfs(ctx, { fetchPdf, again: true }), again, 'one run follows, however many adds');
  release();
  assert.deepEqual(await running, { pending: 1, saved: 1, pages: 0, failed: 0 });
  assert.deepEqual(await again, { pending: 2, saved: 2, pages: 0, failed: 0 });
  for (const row of [first, second, third]) assert.equal((await ctx.libraryDb.get(row.id)).type, 'pdf', row.name);
  // With nothing at work, `again` is a run like any other.
  assert.equal((await webPdfs.checkWebPdfs(ctx, { fetchPdf, again: true })).pending, 0);
});

// The app's wiring (2026-10-02): add-library-item (ipc.cjs) runs the check straight away through store.recheck, so a
// paper saved by its address is kept without the library being opened again.
test('adding an arXiv paper or a .pdf address checks it at once: the row becomes a saved pdf, a second add during the run too', async (t) => {
  const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-webpdf-add-'));
  let release, reached, changed = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const asked = new Promise((resolve) => { reached = resolve; });
  const fetched = [];
  const fetchPdf = async (url) => { fetched.push(url); if (url === 'https://arxiv.org/pdf/2205.04561') { reached(); await gate; } return url.startsWith('https://blog.') ? null : PDF; };
  const afterOpen = (context, { again = false } = {}) => webPdfs.checkWebPdfs(context, { fetchPdf, again, onChange: () => changed() });
  const store = createStore({ homeDir: home, testMode: true, afterOpen });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, describe: async () => null, identifyRepo: async () => null });
  const add = handlers.get('engelbart:add-library-item');
  const library = await store.context();
  const saved = (count) => new Promise((resolve) => { let n = 0; changed = () => { n += 1; if (n === count) resolve(); }; });
  const both = saved(2);
  const arxiv = await add('https://arxiv.org/pdf/2205.04561', { name: 'Scim: Intelligent Skimming Support' });
  assert.equal(arxiv.type, 'website', 'added as its address, answered at once');
  await asked;
  const pdf = await add('https://papers.example.org/citesee.pdf', { name: 'CiteSee' });
  release();
  await both;
  for (const [row, name] of [[arxiv, 'Scim: Intelligent Skimming Support'], [pdf, 'CiteSee']]) {
    const now = await library.libraryDb.get(row.id);
    assert.deepEqual([now.type, now.name, now.url], ['pdf', name, row.url]);
    assert.equal(fs.readFileSync(now.path, 'utf8'), '%PDF-1.7 saved');
  }
  assert.deepEqual(fetched, ['https://arxiv.org/pdf/2205.04561', 'https://papers.example.org/citesee.pdf']);
  // A repository is no page to ask; a page that is not a pdf stays a page.
  await add('https://github.com/o/r');
  const blog = await add('https://blog.example.org/post', { name: 'Post' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await library.libraryDb.get(blog.id)).type, 'website');
  assert.ok(!fetched.some((url) => url.includes('github.com')));
});

// MATH-29 (2026-10-05): a pdf that comes in through either add asks the sweeper to read its text now (ipc.cjs's
// pdfAdded; index.cjs points it at sweeper.sweepSoon, and at a page row that became a pdf through checkWebPdfs' onChange).
test('adding a pdf from disk or saving one from the web calls pdfAdded; adding anything else does not', async (t) => {
  const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-webpdf-told-'));
  const store = createStore({ homeDir: home, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  let told = 0;
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, describe: async () => null, identifyRepo: async () => null, pdfAdded: () => { told += 1; } });
  const file = path.join(home, 'From disk.pdf');
  fs.writeFileSync(file, PDF);
  assert.equal((await handlers.get('engelbart:add-library-item')(file)).type, 'pdf');
  assert.equal(told, 1);
  await handlers.get('engelbart:add-library-item')('https://blog.example.org/post', { name: 'Post' });
  assert.equal(told, 1, 'a page is not a pdf');
  assert.equal((await handlers.get('engelbart:add-library-pdf')('https://papers.example.org/saved.pdf', PDF, { name: 'Saved' })).type, 'pdf');
  assert.equal(told, 2);
});
