'use strict';

// What the redone sidebar (2026-10-13, the "Sidebar" project) keeps on disk: projects nest four levels deep (the switcher's
// top-level project, then three under it), the top-level project's page, and the person's folders, the same in every
// project.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sidebar-store-'));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('projects nest four levels deep: three under the top-level project, then no more', async () => {
  const top = await projects.createProject(ctx, 'Depth');
  const two = await projects.createWorkspace(ctx, top.id, { name: 'Two' });
  const three = await projects.createWorkspace(ctx, top.id, { name: 'Three', parentId: two.id });
  const four = await projects.createWorkspace(ctx, top.id, { name: 'Four', parentId: three.id });
  assert.ok(four.id);
  await assert.rejects(projects.createWorkspace(ctx, top.id, { name: 'Five', parentId: four.id }), /four levels deep/);
  const sibling = await projects.createWorkspace(ctx, top.id, { name: 'Also four', parentId: three.id });
  assert.ok(sibling.id, 'the fourth level still takes siblings');
});

test('the project page: made with the project from its description, read and written as a document', async () => {
  const made = await projects.createProject(ctx, { name: 'Paged', description: 'What this project is for.' });
  assert.equal(fs.readFileSync(path.join(made.dir, projects.PROJECT_PAGE), 'utf8'), 'What this project is for.\n');
  assert.equal(await projects.readDoc(ctx, made.id, { kind: 'project' }), 'What this project is for.\n');
  await projects.writeDoc(ctx, made.id, { kind: 'project' }, 'Every agent here reads this first.\n');
  assert.equal(await projects.readDoc(ctx, made.id, { kind: 'project' }), 'Every agent here reads this first.\n');
  const listed = (await projects.loadProject(ctx, made.id)).workspaces;
  assert.deepEqual(listed, [], 'the page is no workspace');
});

test('a project made before the page existed gets one on first read, from its description; a note never takes its name', async () => {
  const made = await projects.createProject(ctx, { name: 'Older', description: 'Described at onboarding.' });
  fs.rmSync(path.join(made.dir, projects.PROJECT_PAGE));
  assert.equal(await projects.readDoc(ctx, made.id, { kind: 'project' }), 'Described at onboarding.\n');
  assert.ok(fs.existsSync(path.join(made.dir, projects.PROJECT_PAGE)));
  const note = await projects.createNote(ctx, made.id, { name: '.project' });
  assert.notEqual(note.path, projects.PROJECT_PAGE);
});

test('folders: made, renamed, filled, emptied and deleted; the same list wherever it is read; bad ids refused', async () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const { folder } = projects.createFolder(ctx, '  References  ');
  assert.equal(folder.name, 'References');
  projects.createFolder(ctx, 'Reading');
  projects.addToFolder(ctx, folder.id, [a, b, a]);
  let held = projects.readFolders(ctx);
  assert.deepEqual(held.map((one) => one.name), ['References', 'Reading']);
  assert.deepEqual(held[0].items, [a, b], 'once each, in the order added');
  projects.removeFromFolder(ctx, folder.id, a);
  projects.renameFolder(ctx, folder.id, 'Refs');
  held = projects.readFolders(ctx);
  assert.deepEqual([held[0].name, held[0].items], ['Refs', [b]]);
  assert.throws(() => projects.createFolder(ctx, '   '), /needs a name/);
  assert.throws(() => projects.addToFolder(ctx, '33333333-3333-4333-8333-333333333333', [a]), /Unknown folder/);
  projects.deleteFolder(ctx, folder.id);
  assert.deepEqual(projects.readFolders(ctx).map((one) => one.name), ['Reading']);
  const state = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, 'state.json'), 'utf8'));
  assert.ok(Array.isArray(state.folders), 'kept in state.json beside the rest');
});

test('a picture outside the home folder is kept as a copy instead of refused; other files there still are', async () => {
  const library = require('../src/main/store/library.cjs');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-outside-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const shot = path.join(outside, 'Screenshot 2026-10-13.png');
  fs.writeFileSync(shot, png);
  const row = await library.addItem(ctx, shot, {});
  assert.equal(row.type, 'image');
  assert.equal(row.name, 'Screenshot 2026-10-13.png');
  assert.ok(row.path.startsWith(ctx.dataRoot), 'the copy lives in Engelbart\'s own folder');
  fs.rmSync(shot);
  assert.ok(fs.existsSync(row.path), 'and outlives the original');
  const text = path.join(outside, 'notes.md');
  fs.writeFileSync(text, '# hi');
  await assert.rejects(library.addItem(ctx, text, {}), /home directory/);
});
