'use strict';

// reMarkable (2026-10-31): the notebooks in the reMarkable app's library on this Mac, mirrored as files of a library
// folder (src/main/remarkable/sync.cjs, ./convert.cjs). The app's library is played by a copy of the bridge's fixture
// notebook (packages/remarkable-bridge/test/fixtures/xochitl: one 12-page notebook, Apache-2.0, from notable), with
// folders and a trash made around it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRemarkableSync, placeAll, safeName, mirrorDir, libraryDir } = require('../src/main/remarkable/sync.cjs');
const { convertDocument } = require('../src/main/remarkable/convert.cjs');

const FIXTURE = path.join(__dirname, '..', 'packages', 'remarkable-bridge', 'test', 'fixtures', 'xochitl');
const NOTEBOOK = 'f63a4691-25eb-43c5-95b0-a20c2dbeb80b';
const tmp = (name) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `remarkable-${name}-`)));
const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)).map((f) => `${e.name}/${f}`) : [e.name])).sort() : []);

/** A reMarkable app library: the fixture notebook, plus `extra` [{ id, name, type, parent }] metadata-only items. */
function appLibrary(extra = []) {
  const dir = tmp('app');
  fs.cpSync(FIXTURE, dir, { recursive: true });
  fs.rmSync(path.join(dir, 'LICENSE-notable'), { force: true });
  for (const item of extra) fs.writeFileSync(path.join(dir, `${item.id}.metadata`), JSON.stringify({ visibleName: item.name, type: item.type || 'CollectionType', parent: item.parent || '', lastModified: '1786022558398' }));
  return dir;
}
const setParent = (dir, id, parent, name) => {
  const file = path.join(dir, `${id}.metadata`);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...meta, parent, ...(name ? { visibleName: name } : {}) }));
};

/** A sync over `dir` into a fresh data root, converting inline (no worker), counting conversions. */
function syncOver(dir, { convert = convertDocument } = {}) {
  const dataRoot = tmp('data');
  const converted = [];
  const changes = [];
  const remarkable = createRemarkableSync({
    root: () => mirrorDir(dataRoot),
    findLibrary: async () => dir,
    convert: async (job) => { converted.push(job.id); return convert(job); },
    onChange: (s) => changes.push(s.state),
  });
  return { remarkable, dataRoot, converted, changes, library: () => libraryDir(mirrorDir(dataRoot)) };
}
const settle = async (remarkable) => { await remarkable.sync(); };

test('names: safe for a file, unique in a folder whatever the case, kept by whoever had them', () => {
  assert.equal(safeName('a/b: c'), 'a-b- c');
  assert.equal(safeName('  .hidden'), 'hidden');
  assert.equal(safeName(''), 'Untitled');
  const entries = [
    { id: 'f1', kind: 'folder', name: 'Work', parent: '', lastModified: 1 },
    { id: 'd1', kind: 'document', name: 'Notes', parent: 'f1', lastModified: 2 },
    { id: 'd2', kind: 'document', name: 'notes', parent: 'f1', lastModified: 1 },
    { id: 'd3', kind: 'document', name: 'Work', parent: '', lastModified: 1 },
    { id: 'd4', kind: 'document', name: 'Lost', parent: 'gone', lastModified: 1 },
  ];
  const first = placeAll(entries, {});
  assert.deepEqual(first.f1, { dir: '', base: 'Work' });
  assert.deepEqual(first.d3, { dir: '', base: 'Work' }, 'a folder and a document may share a name');
  assert.deepEqual([first.d2.base, first.d1.base], ['notes', 'Notes (2)'], 'the older one gets the plain name');
  assert.deepEqual(first.d4, { dir: '', base: 'Lost' }, 'a parent that is not there is the top');
  const again = placeAll(entries, { d1: { base: 'Notes' } });
  assert.equal(again.d1.base, 'Notes', 'whoever had the name keeps it');
});

test('connecting mirrors the notebook as a PDF of its pages and its typed text', async () => {
  const dir = appLibrary();
  const { remarkable, library, converted } = syncOver(dir);
  const status = await remarkable.connect();
  assert.equal(status.connected, true);
  await settle(remarkable);
  assert.deepEqual(walk(library()), ['Test.md', 'Test.pdf']);
  assert.match(fs.readFileSync(path.join(library(), 'Test.pdf'), 'latin1'), /^%PDF-/);
  assert.match(fs.readFileSync(path.join(library(), 'Test.md'), 'utf8'), /^# Test\n/);
  assert.deepEqual(converted, [NOTEBOOK]);
  const s = remarkable.status();
  assert.equal(s.state, 'synced');
  assert.equal(s.documents, 1);
  assert.equal(s.library, library());
});

test('an unchanged library converts nothing; a changed notebook is converted again', async () => {
  const dir = appLibrary();
  const { remarkable, converted } = syncOver(dir);
  await remarkable.connect();
  await settle(remarkable);
  await remarkable.sync();
  assert.equal(converted.length, 1, 'nothing changed');
  const page = path.join(dir, NOTEBOOK, fs.readdirSync(path.join(dir, NOTEBOOK))[0]);
  fs.writeFileSync(page, fs.readFileSync(page));
  fs.utimesSync(page, new Date(), new Date(Date.now() + 5000));
  await remarkable.sync();
  assert.equal(converted.length, 2);
});

test('folders become folders; moving, renaming and trashing on the tablet follow', async () => {
  const work = '0a000000-0000-4000-8000-000000000001';
  const sub = '0a000000-0000-4000-8000-000000000002';
  const dir = appLibrary([{ id: work, name: 'Work' }, { id: sub, name: 'Meetings', parent: work }]);
  setParent(dir, NOTEBOOK, sub);
  const { remarkable, library } = syncOver(dir);
  await remarkable.connect();
  await settle(remarkable);
  assert.deepEqual(walk(library()), ['Work/Meetings/Test.md', 'Work/Meetings/Test.pdf']);

  setParent(dir, NOTEBOOK, work, 'Standup');
  await remarkable.sync();
  assert.deepEqual(walk(library()), ['Work/Standup.md', 'Work/Standup.pdf'], 'moved and renamed; the empty folder went');

  setParent(dir, work, 'trash');
  await remarkable.sync();
  assert.deepEqual(walk(library()), [], 'a folder in the trash takes what is in it along');
  assert.equal(remarkable.status().documents, 0);
});

test('a notebook that cannot be converted keeps its files, is not retried on every sync, and is when it changes', async () => {
  const dir = appLibrary();
  let broken = false;
  const { remarkable, library, converted } = syncOver(dir, { convert: (job) => (broken ? Promise.reject(Object.assign(new Error('page 3 is damaged'), { code: 'format' })) : convertDocument(job)) });
  await remarkable.connect();
  await settle(remarkable);
  broken = true;
  const page = path.join(dir, NOTEBOOK, fs.readdirSync(path.join(dir, NOTEBOOK))[0]);
  const touch = (s) => fs.utimesSync(page, new Date(), new Date(Date.now() + s * 1000));
  touch(5);
  await remarkable.sync();
  assert.deepEqual(walk(library()), ['Test.md', 'Test.pdf'], 'the files from before stay');
  assert.deepEqual(remarkable.status().problems, [{ name: 'Test', error: 'page 3 is damaged' }]);
  await remarkable.sync();
  assert.equal(converted.length, 2, 'not tried again while nothing changed');
  assert.deepEqual(remarkable.status().problems, [{ name: 'Test', error: 'page 3 is damaged' }], 'still said');
  broken = false;
  touch(10);
  await remarkable.sync();
  assert.equal(converted.length, 3, 'tried again once it changed');
  assert.deepEqual(remarkable.status().problems, []);
});

test('a failure is tried once more in a later run of the app', async () => {
  const dir = appLibrary();
  const dataRoot = tmp('data');
  const failing = (job) => Promise.reject(Object.assign(new Error('nope'), { code: 'format' }));
  const first = createRemarkableSync({ root: () => mirrorDir(dataRoot), findLibrary: async () => dir, convert: failing });
  await first.connect();
  await first.sync();
  assert.equal(first.status().problems.length, 1);
  const ran = [];
  const later = createRemarkableSync({ root: () => mirrorDir(dataRoot), findLibrary: async () => dir, convert: (job) => { ran.push(job.id); return convertDocument(job); } });
  await later.sync();
  assert.deepEqual(ran, [NOTEBOOK]);
  assert.deepEqual(later.status().problems, []);
});

test('without the reMarkable app, connecting says so and stays disconnected', async () => {
  const dataRoot = tmp('data');
  const remarkable = createRemarkableSync({
    root: () => mirrorDir(dataRoot),
    findLibrary: async () => { throw Object.assign(new Error('not found'), { code: 'unavailable' }); },
  });
  const status = await remarkable.connect();
  assert.equal(status.connected, false);
  assert.equal(status.code, 'unavailable');
  assert.match(status.error, /reMarkable app isn’t on this Mac/);
  assert.equal(fs.existsSync(mirrorDir(dataRoot)), false);
  remarkable.stop();
});

test('disconnecting deletes the mirror and never touches the app’s library', async () => {
  const dir = appLibrary();
  const before = walk(dir);
  const { remarkable, dataRoot } = syncOver(dir);
  await remarkable.connect();
  await settle(remarkable);
  await remarkable.disconnect();
  assert.equal(fs.existsSync(mirrorDir(dataRoot)), false);
  assert.equal(remarkable.status().connected, false);
  assert.deepEqual(walk(dir), before);
});

test('the worker converts the same as the inline converter', async () => {
  const dir = appLibrary();
  const dataRoot = tmp('data');
  const remarkable = createRemarkableSync({ root: () => mirrorDir(dataRoot), findLibrary: async () => dir });
  await remarkable.connect();
  await remarkable.sync();
  assert.deepEqual(walk(libraryDir(mirrorDir(dataRoot))), ['Test.md', 'Test.pdf']);
  remarkable.stop();
});

// The library's rows (src/main/remarkable/rows.cjs): one per document, the same row through renames and moves.
const { reconcileRows, removeRows } = require('../src/main/remarkable/rows.cjs');

/** The library database, in memory: what rows.cjs uses of it. */
function memoryLibrary(rows = []) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    table,
    libraryDb: {
      list: async () => [...table.values()].map((r) => ({ ...r })),
      insert: async (row) => { table.set(row.id, { ...row }); return { ...row }; },
      rename: async (id, name) => { table.get(id).name = name; return { ...table.get(id) }; },
      updatePath: async (id, p) => { table.get(id).path = p; return { ...table.get(id) }; },
      remove: async (id) => table.delete(id),
    },
  };
}

test('each document is a row of the library: added, renamed and moved with the tablet, the same row throughout', async () => {
  const work = '0a000000-0000-4000-8000-000000000001';
  const dir = appLibrary([{ id: work, name: 'Work' }]);
  const { remarkable, dataRoot } = syncOver(dir);
  const root = mirrorDir(dataRoot);
  const ctx = memoryLibrary([{ id: 'old-folder', name: 'reMarkable', type: 'folder', folder_path: libraryDir(root), path: null }]);
  await remarkable.connect();
  await settle(remarkable);
  const first = await reconcileRows(ctx, root);
  assert.deepEqual(first, { added: 1, changed: 0, removed: 1 }, 'the notebook added; the old folder row taken away');
  const [row] = [...ctx.table.values()];
  assert.equal(row.name, 'Test');
  assert.equal(row.type, 'pdf');
  assert.equal(row.categorized, null, 'read for whether it is a paper, as any pdf added');
  assert.ok(row.path.endsWith('/.remarkable/library/Test.pdf') && fs.existsSync(row.path));

  assert.deepEqual(await reconcileRows(ctx, root), { added: 0, changed: 0, removed: 0 }, 'nothing changed, nothing done');

  setParent(dir, NOTEBOOK, work, 'Standup');
  await remarkable.sync();
  await reconcileRows(ctx, root);
  assert.equal(ctx.table.size, 1);
  const moved = ctx.table.get(row.id);
  assert.equal(moved.name, 'Standup', 'the same row, renamed');
  assert.ok(moved.path.endsWith('/library/Work/Standup.pdf') && fs.existsSync(moved.path));

  await ctx.libraryDb.rename(row.id, 'My standup');
  await remarkable.sync();
  await reconcileRows(ctx, root);
  assert.equal(ctx.table.get(row.id).name, 'My standup', 'a name given in Engelbart stays while the tablet keeps its own');

  setParent(dir, NOTEBOOK, 'trash');
  await remarkable.sync();
  assert.deepEqual(await reconcileRows(ctx, root), { added: 0, changed: 0, removed: 1 }, 'in the tablet’s trash: its row goes');
  assert.equal(ctx.table.size, 0);
});

test('disconnecting takes every reMarkable row away, and nothing else', async () => {
  const dir = appLibrary();
  const { remarkable, dataRoot } = syncOver(dir);
  const root = mirrorDir(dataRoot);
  const ctx = memoryLibrary([{ id: 'mine', name: 'My paper', type: 'pdf', path: '/elsewhere/paper.pdf' }]);
  await remarkable.connect();
  await settle(remarkable);
  await reconcileRows(ctx, root);
  assert.equal(ctx.table.size, 2);
  assert.equal(await removeRows(ctx, root), 1);
  assert.deepEqual([...ctx.table.keys()], ['mine']);
});

test('a notebook the app stops listing (reMarkable keeps 50 days without Connect) is kept, as itself', async () => {
  const dir = appLibrary();
  const { remarkable, dataRoot, library } = syncOver(dir);
  const root = mirrorDir(dataRoot);
  const ctx = memoryLibrary();
  await remarkable.connect();
  await settle(remarkable);
  await reconcileRows(ctx, root);
  const [row] = [...ctx.table.values()];
  // It leaves the app's library without going through the trash: its files moved away, as an aged-out document's are.
  const away = tmp('away');
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith(NOTEBOOK))) fs.renameSync(path.join(dir, name), path.join(away, name));
  // A new notebook takes the same name meanwhile.
  const other = '0b000000-0000-4000-8000-000000000001';
  fs.cpSync(path.join(away, NOTEBOOK), path.join(dir, other), { recursive: true });
  fs.writeFileSync(path.join(dir, `${other}.metadata`), JSON.stringify({ visibleName: 'Test', type: 'DocumentType', parent: '', lastModified: '1786022558398' }));
  fs.copyFileSync(path.join(away, `${NOTEBOOK}.content`), path.join(dir, `${other}.content`));
  await remarkable.sync();
  await reconcileRows(ctx, root);
  assert.deepEqual(walk(library()), ['Test (2).md', 'Test (2).pdf', 'Test.md', 'Test.pdf'], 'kept, and the new one does not write over it');
  assert.ok(ctx.table.has(row.id), 'its row stays');
  assert.equal(remarkable.status().kept, 1);
  // Listed again: the same document, the same row, nothing kept.
  for (const name of fs.readdirSync(away)) fs.renameSync(path.join(away, name), path.join(dir, name));
  await remarkable.sync();
  await reconcileRows(ctx, root);
  assert.ok(ctx.table.has(row.id));
  assert.equal(remarkable.status().kept, 0);
  assert.equal(ctx.table.size, 2);
});

test('an empty listing (the reMarkable app signed out) deletes nothing', async () => {
  const dir = appLibrary();
  const { remarkable, library } = syncOver(dir);
  await remarkable.connect();
  await settle(remarkable);
  for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  await remarkable.sync();
  assert.deepEqual(walk(library()), ['Test.md', 'Test.pdf']);
});

// From the review (2026-10-31): names from the tablet never leave the mirror, and the disk's idea of a name rules.
test('a tablet name of dots never becomes a path out of the mirror', async () => {
  assert.equal(safeName('. ..'), 'Untitled');
  assert.equal(safeName('..'), 'Untitled');
  assert.equal(safeName('. .'), 'Untitled');
  assert.equal(safeName('..secret'), 'secret');
  const a = '0c000000-0000-4000-8000-000000000001', b = '0c000000-0000-4000-8000-000000000002';
  const dir = appLibrary([{ id: a, name: '. ..' }, { id: b, name: '. ..', parent: a }]);
  setParent(dir, NOTEBOOK, b, 'Thesis');
  const { remarkable, dataRoot, library } = syncOver(dir);
  await remarkable.connect();
  await settle(remarkable);
  assert.deepEqual(walk(library()), ['Untitled/Untitled/Thesis.md', 'Untitled/Untitled/Thesis.pdf']);
  assert.equal(fs.existsSync(path.join(dataRoot, '.engelbart', 'Thesis.pdf')) || fs.existsSync(path.join(dataRoot, 'Thesis.pdf')), false);
});

test('a rename that only changes case keeps the file; names that differ only in Unicode form or case get their own', async () => {
  const dir = appLibrary();
  setParent(dir, NOTEBOOK, '', 'notes');
  const { remarkable, library } = syncOver(dir);
  await remarkable.connect();
  await settle(remarkable);
  setParent(dir, NOTEBOOK, '', 'Notes');
  await remarkable.sync();
  assert.deepEqual(walk(library()).filter((f) => f.endsWith('.pdf')), ['Notes.pdf'], 'still there after the case-only rename, spelled anew');
  assert.ok(remarkable.status().documents === 1);
  const places = placeAll([
    { id: 'n1', kind: 'document', name: 'Résumé', parent: '', lastModified: 1 },
    { id: 'n2', kind: 'document', name: 'Résumé', parent: '', lastModified: 2 },
    { id: 'f1', kind: 'folder', name: 'X.pdf', parent: '', lastModified: 1 },
    { id: 'd1', kind: 'document', name: 'X', parent: '', lastModified: 2 },
  ], {});
  assert.notEqual(places.n1.base.normalize('NFC').toLowerCase(), places.n2.base.normalize('NFC').toLowerCase(), 'NFC and NFD forms of one name are one file on the disk');
  assert.equal(places.d1.base, 'X (2)', 'a document X would write X.pdf, which the folder X.pdf is');
});

test('a rename and a new document of the old name in one sync: two documents, two rows', async () => {
  const dir = appLibrary();
  const { remarkable, dataRoot } = syncOver(dir);
  const root = mirrorDir(dataRoot);
  const ctx = memoryLibrary();
  await remarkable.connect();
  await settle(remarkable);
  await reconcileRows(ctx, root);
  const [first] = [...ctx.table.values()];
  setParent(dir, NOTEBOOK, '', 'Old Test');
  const other = '0d000000-0000-4000-8000-000000000001';
  fs.cpSync(path.join(dir, NOTEBOOK), path.join(dir, other), { recursive: true });
  fs.copyFileSync(path.join(dir, `${NOTEBOOK}.content`), path.join(dir, `${other}.content`));
  fs.writeFileSync(path.join(dir, `${other}.metadata`), JSON.stringify({ visibleName: 'Test', type: 'DocumentType', parent: '', lastModified: '1786022558399' }));
  await remarkable.sync();
  await reconcileRows(ctx, root);
  assert.equal(ctx.table.size, 2);
  assert.equal(ctx.table.get(first.id).name, 'Old Test', 'the renamed one keeps its row');
  const map = JSON.parse(fs.readFileSync(path.join(root, 'rows.json'), 'utf8'));
  assert.notEqual(map[NOTEBOOK].row, map[other].row);
});

test('an unreadable mirror state takes no rows away', async () => {
  const dir = appLibrary();
  const { remarkable, dataRoot } = syncOver(dir);
  const root = mirrorDir(dataRoot);
  const ctx = memoryLibrary();
  await remarkable.connect();
  await settle(remarkable);
  await reconcileRows(ctx, root);
  fs.writeFileSync(path.join(root, 'state.json'), '{ half wri');
  assert.deepEqual(await reconcileRows(ctx, root), { added: 0, changed: 0, removed: 0 });
  assert.equal(ctx.table.size, 1);
});

test('disconnecting while a sync converts: nothing is written after, no rows are left', async () => {
  const dir = appLibrary();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { remarkable, dataRoot } = syncOver(dir, { convert: async (job) => { await gate; return convertDocument(job); } });
  const root = mirrorDir(dataRoot);
  await remarkable.connect();
  const halting = remarkable.halt();
  release();
  await halting;
  await remarkable.disconnect();
  assert.equal(fs.existsSync(root), false, 'the conversion under way finished before the mirror went');
});

test('disconnecting as the app does (stop, then the rows, then the copies) leaves no row behind', async () => {
  const dir = appLibrary();
  const dataRoot = tmp('data');
  const root = mirrorDir(dataRoot);
  const ctx = memoryLibrary();
  let release;
  const gate = new Promise((r) => { release = r; });
  const remarkable = createRemarkableSync({ root: () => root, findLibrary: async () => dir, convert: async (job) => { await gate; return convertDocument(job); }, onSynced: () => reconcileRows(ctx, root) });
  await remarkable.connect(); // a sync starts, held in its conversion
  const halting = remarkable.halt();
  release();
  await halting;
  await removeRows(ctx, root);
  await remarkable.disconnect();
  assert.equal(ctx.table.size, 0);
  assert.equal(fs.existsSync(root), false);
  remarkable.stop();
});
