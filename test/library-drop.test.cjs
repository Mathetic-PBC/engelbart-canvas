'use strict';

// What is dragged onto the library or a workspace (MATH-19, 2026-10-05; src/main/store/library.cjs): bytes with no path
// kept as a copy (addFileCopy), and a link read first (addFromUrl): a picture or a pdf kept as a copy, anything else
// added as + Add adds it. Then the two IPC channels the renderer calls (ipc.cjs add-library-file, add-library-url).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const library = require('../src/main/store/library.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-drop-')));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

const bytesOf = (text) => new Uint8Array(Buffer.from(text, 'latin1'));
const PNG = bytesOf('\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR picture');
const JPEG = bytesOf('\xff\xd8\xff\xe0 photo');
const PDF = bytesOf('%PDF-1.7 dropped');
const imagesDir = () => path.join(layout.testRoot, 'assets', 'images');
const kept = () => (fs.existsSync(imagesDir()) ? fs.readdirSync(imagesDir()) : []);

test('addFileCopy: a png is kept in assets/images and is an image row of the library, named and with its address', async () => {
  const row = await library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', name: 'Figure 3.png' });
  assert.deepEqual([row.type, row.name, row.tags, row.project_id, row.url], ['image', 'Figure 3.png', [], null, null]);
  assert.equal(row.path, path.join(layout.testRoot, 'assets', 'images', `${row.id}.png`));
  assert.deepEqual(Buffer.from(fs.readFileSync(row.path)), Buffer.from(PNG));
  // with an address: kept on the row, the name its last part when none is given, else "Image"
  const cat = await library.addFileCopy(ctx, { bytes: JPEG, mime: 'image/jpeg', url: 'https://cdn.example.org/pets/Sleepy%20cat.jpg' });
  assert.deepEqual([cat.type, cat.name, cat.url], ['image', 'Sleepy cat.jpg', 'https://cdn.example.org/pets/Sleepy%20cat.jpg']);
  assert.ok(cat.path.endsWith('.jpg'));
  const plain = await library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', url: 'https://cdn.example.org/' });
  assert.equal(plain.name, 'Image');
  assert.equal((await library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png' })).name, 'Image');
  // its format is what its bytes are: a webp said to be a png is kept as a webp
  const webp = await library.addFileCopy(ctx, { bytes: bytesOf('RIFF\x10\x00\x00\x00WEBPVP8 '), mime: 'image/png', name: 'w' });
  assert.ok(webp.path.endsWith('.webp'));
  // a file inside a GitHub repository is that file, not the repository
  const raw = await library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', url: 'https://github.com/o/r/raw/main/docs/shot.png' });
  assert.deepEqual([raw.type, raw.name, raw.tags], ['image', 'shot.png', []]);
});

test('addFileCopy: a pdf is a pdf row, kept in assets/pdfs and read for whether it is a paper', async () => {
  const row = await library.addFileCopy(ctx, { bytes: PDF, mime: 'application/pdf', name: 'Retrieval Study.pdf' }, { inspectPdf: async () => ['paper'] });
  assert.deepEqual([row.type, row.name, row.tags, row.project_id, row.url], ['pdf', 'Retrieval Study', ['paper'], null, null]);
  assert.equal(row.path, path.join(layout.testRoot, 'assets', 'pdfs', `${row.id}.pdf`));
  assert.equal(fs.readFileSync(row.path, 'latin1'), '%PDF-1.7 dropped');
  // an arXiv pdf is the paper its abstract page names, as addPdfCopy has it
  const arxiv = await library.addFileCopy(ctx, { bytes: PDF, mime: 'application/pdf', url: 'https://arxiv.org/pdf/1706.03762v7' });
  assert.deepEqual([arxiv.type, arxiv.url, arxiv.tags], ['pdf', 'https://arxiv.org/abs/1706.03762', ['paper']]);
});

test('addFileCopy: refuses another type, bytes that are not what they say, too much, a duplicate address and a bad one', async () => {
  const before = kept().length;
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: bytesOf('<html>'), mime: 'text/html' }), /Only png, jpeg, gif and webp images and pdfs/);
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: bytesOf('<svg/>'), mime: 'image/svg+xml' }), /Only png/);
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: bytesOf('<html>'), mime: 'image/png' }), /not a png, jpeg, gif or webp image/);
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: PNG, mime: 'application/pdf' }), /not a pdf/);
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: new Uint8Array(0), mime: 'image/png' }), /empty/);
  const big = new Uint8Array(library.MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: big, mime: 'image/png' }), /larger than 20 MB/);
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', url: 'file:///etc/hosts' }), /from the web/);
  // the same address, spelled another way, is the same thing
  const first = await library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', url: 'https://images.example.org/a/b.png' });
  const count = kept().length;
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', url: 'http://www.images.example.org/a/b.png#top' }), (error) => error.code === 'EXISTS' && error.row.id === first.id);
  assert.equal(kept().length, count, 'nothing written for a duplicate');
  assert.equal(kept().length, before + 1);
});

test('addFileCopy: a row that cannot be written leaves no file behind', async (t) => {
  const before = kept();
  t.mock.method(ctx.libraryDb, 'insert', async () => { throw new Error('disk full'); });
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: PNG, mime: 'image/png', name: 'lost' }), /disk full/);
  const pdfs = fs.readdirSync(path.join(layout.testRoot, 'assets', 'pdfs')).length;
  await assert.rejects(() => library.addFileCopy(ctx, { bytes: PDF, mime: 'application/pdf', name: 'lost' }), /disk full/);
  t.mock.restoreAll();
  assert.deepEqual(kept(), before);
  assert.equal(fs.readdirSync(path.join(layout.testRoot, 'assets', 'pdfs')).length, pdfs);
  assert.ok(!(await ctx.libraryDb.list()).some((row) => row.name === 'lost'));
});

/** A fetch that answers each address from `pages` ({ status, type, body, length }), and records what it was asked. */
function stubFetch(pages) {
  const asked = [];
  const fetch = async (url, init) => {
    asked.push({ url, accept: init && init.headers && init.headers.accept, signal: !!(init && init.signal) });
    const page = pages[url];
    if (!page) throw new TypeError('fetch failed');
    const headers = { ...(page.type ? { 'content-type': page.type } : {}), ...(page.length ? { 'content-length': String(page.length) } : {}) };
    return new Response(page.body ?? null, { status: page.status || 200, headers });
  };
  return { fetch, asked };
}

test('addFromUrl: a picture is kept as an image row with its address; an ordinary page is a website row', async () => {
  const { fetch, asked } = stubFetch({
    'https://cdn.example.org/cats/tabby.png': { type: 'image/png; charset=binary', body: PNG },
    'https://blog.example.org/post': { type: 'text/html; charset=utf-8', body: '<title>A post</title>' },
  });
  const describe = async () => ({ title: 'A post', description: 'About things.' });
  const image = await library.addFromUrl(ctx, ' https://cdn.example.org/cats/tabby.png ', { fetch, describe });
  assert.deepEqual([image.type, image.name, image.url, image.project_id], ['image', 'tabby.png', 'https://cdn.example.org/cats/tabby.png', null]);
  assert.deepEqual(Buffer.from(fs.readFileSync(image.path)), Buffer.from(PNG));
  const page = await library.addFromUrl(ctx, 'https://blog.example.org/post', { fetch, describe });
  assert.deepEqual([page.type, page.name, page.url, page.path, page.summary], ['website', 'A post', 'https://blog.example.org/post', null, 'About things.']);
  assert.ok(asked.every((call) => call.signal && /image\/png/.test(call.accept)), 'within a time limit, asking for the pictures kept here');
  // dropped again: already there, either way
  await assert.rejects(() => library.addFromUrl(ctx, 'https://cdn.example.org/cats/tabby.png', { fetch }), (error) => error.code === 'EXISTS');
  await assert.rejects(() => library.addFromUrl(ctx, 'https://blog.example.org/post', { fetch }), (error) => error.code === 'EXISTS');
});

test('addFromUrl: a pdf, or an answer that does not say what it is, is told by its bytes; one that cannot be read is a website row', async () => {
  const { fetch } = stubFetch({
    'https://papers.example.org/download?id=7': { type: 'application/octet-stream', body: PDF },
    'https://papers.example.org/typed.pdf': { type: 'application/pdf', body: PDF },
    'https://files.example.org/blob': { body: JPEG },
    'https://files.example.org/data.bin': { type: 'application/octet-stream', body: bytesOf('just bytes') },
    'https://gone.example.org/missing.png': { status: 404, type: 'text/html', body: 'Not found' },
  });
  const told = await library.addFromUrl(ctx, 'https://papers.example.org/download?id=7', { fetch, inspectPdf: async () => ['paper'] });
  assert.deepEqual([told.type, told.name, told.tags], ['pdf', 'download', ['paper']]);
  assert.equal((await library.addFromUrl(ctx, 'https://papers.example.org/typed.pdf', { fetch })).name, 'typed');
  assert.equal((await library.addFromUrl(ctx, 'https://files.example.org/blob', { fetch })).type, 'image');
  assert.equal((await library.addFromUrl(ctx, 'https://files.example.org/data.bin', { fetch })).type, 'website');
  assert.equal((await library.addFromUrl(ctx, 'https://gone.example.org/missing.png', { fetch })).type, 'website');
  assert.equal((await library.addFromUrl(ctx, 'https://offline.example.org/a.png', { fetch })).type, 'website', 'no answer at all');
});

test('addFromUrl: only http(s); a picture larger than the library keeps is refused', async () => {
  const { fetch, asked } = stubFetch({
    'https://cdn.example.org/huge.png': { type: 'image/png', length: library.MAX_IMAGE_BYTES + 1, body: PNG },
    'https://cdn.example.org/liar.png': { type: 'image/png', body: new Uint8Array(library.MAX_IMAGE_BYTES + 10) },
  });
  for (const input of ['file:///etc/hosts', 'ftp://example.org/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
    await assert.rejects(() => library.addFromUrl(ctx, input, { fetch }), /Only http\(s\) links/, input);
  }
  await assert.rejects(() => library.addFromUrl(ctx, 'not a link', { fetch }), /not a valid address/);
  assert.equal(asked.length, 0, 'nothing was asked of the network');
  await assert.rejects(() => library.addFromUrl(ctx, 'https://cdn.example.org/huge.png', { fetch }), /larger than 20 MB/);
  await assert.rejects(() => library.addFromUrl(ctx, 'https://cdn.example.org/liar.png', { fetch }), /larger than 20 MB/);
  assert.ok(!(await ctx.libraryDb.list()).some((row) => /huge|liar/.test(row.url || '')));
});

test('ipc: add-library-file and add-library-url make rows, tell the other windows, and call pdfAdded for a pdf', async (t) => {
  const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-drop-ipc-'));
  const store = createStore({ homeDir: home, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  const announced = [];
  let told = 0;
  const { fetch } = stubFetch({ 'https://cdn.example.org/dog.png': { type: 'image/png', body: PNG }, 'https://papers.example.org/p.pdf': { type: 'application/pdf', body: PDF } });
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, describe: async () => null, identifyRepo: async () => null, pdfAdded: () => { told += 1; }, fetchUrl: fetch, announce: (channel) => announced.push(channel) });
  const addFile = handlers.get('engelbart:add-library-file');
  const addUrl = handlers.get('engelbart:add-library-url');
  const picture = await addFile(PNG, { mime: 'image/png', name: 'Pasted.png' });
  assert.deepEqual([picture.type, picture.name], ['image', 'Pasted.png']);
  assert.equal(told, 0);
  assert.equal((await addFile(PDF, { mime: 'application/pdf', name: 'Dropped.pdf' })).type, 'pdf');
  assert.equal(told, 1);
  assert.equal((await addUrl('https://cdn.example.org/dog.png')).type, 'image');
  assert.equal((await addUrl('https://papers.example.org/p.pdf')).type, 'pdf');
  assert.equal(told, 2);
  assert.equal(announced.filter((channel) => channel === 'engelbart:library-changed').length, 4);
  await assert.rejects(async () => addFile('not bytes', { mime: 'image/png' }), /bytes are missing/);
  await assert.rejects(async () => addFile(PNG, {}), /mime must be a string/);
  await assert.rejects(async () => addUrl(42), /link must be a string/);
});
