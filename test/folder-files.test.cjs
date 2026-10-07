'use strict';

// MATH-22 (2026-10-06): the files inside a library folder, listed live for the @ menu and found again for a mention. No
// dotfiles, no node_modules, only the formats the library knows; a symlink is followed only while it stays inside the
// folder, and a path that leaves it is refused.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { listFolder, folderFile, folderFiles, fileInRow, MAX_ENTRIES } = require('../src/main/store/folder-files.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-folder-files-'));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) }; });
test.after(async () => { await db.closeAll(); });

const write = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
async function folderRow(dir, fields = {}) {
  const id = randomUUID();
  await ctx.libraryDb.insert({ id, name: path.basename(dir), project_id: null, tags: [], type: 'folder', folder_path: dir, ...fields });
  return id;
}

test('a level lists subfolders first, then the files the library knows; hidden, node_modules, .git and unknown types are left out', async () => {
  const dir = fs.mkdtempSync(path.join(homeDir, 'papers-'));
  write(path.join(dir, 'b paper.pdf'));
  write(path.join(dir, 'A notes.md'));
  write(path.join(dir, 'data.CSV'));
  write(path.join(dir, 'script.sh'));
  write(path.join(dir, 'no-extension'));
  write(path.join(dir, '.hidden.pdf'));
  write(path.join(dir, '.DS_Store'));
  write(path.join(dir, '.git', 'config'));
  write(path.join(dir, 'node_modules', 'x', 'index.md'));
  write(path.join(dir, '.secret', 'a.pdf'));
  write(path.join(dir, 'Zeta', 'deep.pdf'));
  write(path.join(dir, 'alpha', 'x.md'));
  const id = await folderRow(dir);
  const level = await listFolder(ctx, id, '');
  assert.equal(level.missing, false);
  assert.deepEqual(level.entries.map((e) => [e.name, e.dir, e.type, e.rel]), [
    ['alpha', true, 'folder', 'alpha'], ['Zeta', true, 'folder', 'Zeta'],
    ['A notes.md', false, 'md', 'A notes.md'], ['b paper.pdf', false, 'pdf', 'b paper.pdf'], ['data.CSV', false, 'csv', 'data.CSV'],
  ]);
  assert.equal(level.total, 5);
  const deeper = await listFolder(ctx, id, 'Zeta');
  assert.deepEqual(deeper.entries.map((e) => e.rel), ['Zeta/deep.pdf'], 'one level at a time, its paths from the folder\'s top');
});

test('a symlink is followed only inside the folder; a path that leaves the folder is refused', async () => {
  const outside = fs.mkdtempSync(path.join(homeDir, 'outside-'));
  write(path.join(outside, 'private.pdf'));
  const dir = fs.mkdtempSync(path.join(homeDir, 'linked-'));
  write(path.join(dir, 'real', 'in.pdf'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
  fs.symlinkSync(path.join(dir, 'real', 'in.pdf'), path.join(dir, 'shortcut.pdf'));
  fs.symlinkSync(outside, path.join(dir, 'escape'));
  fs.symlinkSync(path.join(outside, 'private.pdf'), path.join(dir, 'escape.pdf'));
  fs.symlinkSync(path.join(dir, 'nowhere.pdf'), path.join(dir, 'broken.pdf'));
  const id = await folderRow(dir);
  assert.deepEqual((await listFolder(ctx, id, '')).entries.map((e) => [e.name, e.dir]), [['alias', true], ['real', true], ['shortcut.pdf', false]]);
  await assert.rejects(listFolder(ctx, id, 'escape'), /leaves its folder/);
  await assert.rejects(listFolder(ctx, id, '../outside'), /inside its folder/);
  await assert.rejects(listFolder(ctx, id, '/etc'), /relative/);
  await assert.rejects(folderFile(ctx, id, 'escape.pdf'), /leaves its folder/);
  await assert.rejects(folderFile(ctx, id, 'real/../../x.pdf'), /inside its folder/);
  const shortcut = await folderFile(ctx, id, 'shortcut.pdf');
  assert.deepEqual([shortcut.exists, shortcut.path], [true, path.join(fs.realpathSync(dir), 'real', 'in.pdf')]);
  assert.deepEqual(await folderFiles(ctx, [{ folderId: id, rel: 'escape.pdf' }, { folderId: id, rel: 'alias/in.pdf' }, { folderId: 'nope', rel: 'x' }]), [
    { folderId: id, rel: 'escape.pdf', exists: false, dir: false },
    { folderId: id, rel: 'alias/in.pdf', exists: true, dir: false },
    { folderId: 'nope', rel: 'x', exists: false, dir: false },
  ], 'many at once, a failure as not there');
});

test('a folder that is gone lists as missing; a file renamed away is not there, and nothing throws', async () => {
  const dir = fs.mkdtempSync(path.join(homeDir, 'moving-'));
  write(path.join(dir, 'Smith (2024) #1 é.pdf'));
  const id = await folderRow(dir);
  const found = await folderFile(ctx, id, 'Smith (2024) #1 é.pdf');
  assert.deepEqual([found.exists, found.dir, found.type, found.folder], [true, false, 'pdf', path.basename(dir)]);
  fs.renameSync(path.join(dir, 'Smith (2024) #1 é.pdf'), path.join(dir, 'renamed.pdf'));
  assert.equal((await folderFile(ctx, id, 'Smith (2024) #1 é.pdf')).exists, false);
  assert.deepEqual(await listFolder(ctx, id, 'no such level'), { id, name: path.basename(dir), rel: 'no such level', missing: true, entries: [], total: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal((await listFolder(ctx, id, '')).missing, true);
  assert.equal((await folderFile(ctx, id, 'renamed.pdf')).exists, false);
  const outsideHome = await folderRow(fs.mkdtempSync(path.join(os.tmpdir(), 'not-home-')));
  assert.equal((await listFolder(ctx, outsideHome, '')).missing, true, 'a folder outside the home directory is not read');
  const notFolder = randomUUID();
  await ctx.libraryDb.insert({ id: notFolder, name: 'A paper', project_id: null, tags: [], type: 'pdf', path: path.join(homeDir, 'a.pdf') });
  await assert.rejects(listFolder(ctx, notFolder, ''), /not a folder/);
  await assert.rejects(listFolder(ctx, 'bad id!', ''), /invalid/);
});

test('a git-tagged folder is browsed the same way, a level at a time; a very large level says how many there were', async () => {
  const dir = fs.mkdtempSync(path.join(homeDir, 'repo-'));
  write(path.join(dir, '.git', 'HEAD'));
  write(path.join(dir, 'docs', 'guide.md'));
  for (let i = 0; i < MAX_ENTRIES + 5; i++) write(path.join(dir, 'many', `f${String(i).padStart(4, '0')}.md`));
  const id = await folderRow(dir, { tags: ['git'] });
  assert.deepEqual((await listFolder(ctx, id, '')).entries.map((e) => e.name), ['docs', 'many']);
  const many = await listFolder(ctx, id, 'many');
  assert.deepEqual([many.entries.length, many.total], [MAX_ENTRIES, MAX_ENTRIES + 5]);
  assert.equal(fileInRow({ id, name: 'repo', folder_path: dir }, 'docs/guide.md', homeDir).exists, true);
});
