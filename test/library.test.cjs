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
  ctx = { homeDir, root: layout.root, testRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('seedIfEmpty inserts the four fixtures once', async () => {
  assert.equal(await library.seedIfEmpty(ctx, fixtures), 4);
  assert.equal(await library.seedIfEmpty(ctx, fixtures), 0);
  const rows = await library.listLibrary(ctx);
  assert.deepEqual(rows.map((row) => row.type).sort(), ['dataset', 'git_repo', 'paper', 'website']);
  const paper = rows.find((row) => row.type === 'paper');
  assert.equal(paper.path, path.join(layout.testRoot, 'seed', 'hypocompass.pdf'));
  assert.ok(fs.existsSync(paper.path));
});

test('readLibraryFile returns pdf bytes and refuses other files', async () => {
  const rows = await library.listLibrary(ctx);
  const paper = rows.find((row) => row.type === 'paper');
  const file = await library.readLibraryFile(ctx, paper.id);
  assert.equal(file.name, paper.name);
  assert.equal(Buffer.from(file.bytes).toString('utf8'), '%PDF-1.4 test');
  const dataset = rows.find((row) => row.type === 'dataset');
  await assert.rejects(() => library.readLibraryFile(ctx, dataset.id), /Only downloaded pdf/);
  const site = rows.find((row) => row.type === 'website');
  await assert.rejects(() => library.readLibraryFile(ctx, site.id), /no local file/);
  await assert.rejects(() => library.readLibraryFile(ctx, '../etc'), TypeError);
});

test('annotations round-trip per library id', async () => {
  const id = randomUUID();
  assert.equal(await library.readAnnotations(ctx, id), null);
  const marks = { 1: [{ id: 'm1', rects: [{ x: 1, y: 2, w: 3, h: 4 }], side: 'left', y: 2, note: 'hi', text: 'sel', pos: null }] };
  assert.equal(await library.writeAnnotations(ctx, id, marks), true);
  assert.deepEqual(await library.readAnnotations(ctx, id), marks);
  await assert.rejects(() => library.writeAnnotations(ctx, 'bad', {}), TypeError);
});
