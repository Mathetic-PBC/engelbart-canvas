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
