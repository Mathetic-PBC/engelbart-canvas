'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');
const library = require('../src/main/store/library.cjs');

async function setup(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-shared-context-'));
  const store = createStore({ homeDir, fixturesDir: path.join(__dirname, '../fixtures') });
  const ctx = await store.context();
  const project = await projects.createProject(ctx, { name: 'Shared sources', directory: homeDir });
  const a = await projects.createWorkspace(ctx, project.id, { name: 'A' });
  const b = await projects.createWorkspace(ctx, project.id, { name: 'B' });
  t.after(async () => { await store.close(); fs.rmSync(homeDir, { recursive: true, force: true }); });
  const row = name => ctx.libraryDb.insert({ id: randomUUID(), name, type: 'website', url: `https://${name.toLowerCase()}.example` });
  const load = async () => (await projects.loadProject(await store.context(), project.id)).project;
  return { store, ctx, project, a, b, row, load };
}

test('legacy workspace context migrates to a shared project collection, retaining only items visible somewhere', async t => {
  const { store, ctx, project, a, b, row, load } = await setup(t);
  const child = await projects.createWorkspace(ctx, project.id, { name: 'Child', parentId: a.id });
  const [first, second, mentioned, hidden] = await Promise.all(['First', 'Second', 'Mentioned', 'Hidden'].map(row));
  const note = await projects.createNote(ctx, project.id, { name: 'Local note', workspaceId: a.id });
  const hiddenNote = await projects.createNote(ctx, project.id, { name: 'Removed note', workspaceId: b.id });
  const legacy = (workspace, context, removed = []) => {
    const file = path.join(projects.findWorkspace(ctx, project.id, workspace.id).workspace.dir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...meta, context, removed }));
  };
  legacy(a, [first.id, hidden.id], [hidden.id]);
  legacy(b, [first.id], [hiddenNote.id]);
  legacy(child, [second.id]);
  fs.writeFileSync(path.join(projects.findWorkspace(ctx, project.id, b.id).workspace.dir, 'workspace.md'), '@[Mentioned]');
  assert.equal(JSON.parse(fs.readFileSync(path.join(project.dir, 'project.json'), 'utf8')).sidebarContext, undefined);
  const loaded = await load();
  assert.deepEqual(new Set(loaded.context), new Set([first.id, second.id, mentioned.id, note.id]));
  assert.deepEqual(new Set(loaded.removedContext), new Set([hidden.id, hiddenNote.id]));
  assert.deepEqual(projects.findWorkspace(ctx, project.id, a.id).workspace.context, [first.id, hidden.id], 'migration preserves original workspace attachments');
  await store.close();
  assert.deepEqual((await load()).context, loaded.context, 'shared sources survive a fresh store');
  const other = await projects.createProject(await store.context(), 'Other project');
  assert.deepEqual((await projects.loadProject(await store.context(), other.id)).project.context, [], 'projects remain separate');
});

test('adding, removing and restoring from either workspace updates the same collection without deleting sources', async t => {
  const { ctx, project, a, b, row, load } = await setup(t);
  const [first, second] = await Promise.all(['First', 'Second'].map(row));
  await Promise.all([projects.linkToWorkspace(ctx, project.id, a.id, [first.id]), projects.linkToWorkspace(ctx, project.id, b.id, [second.id])]);
  assert.deepEqual(new Set((await load()).context), new Set([first.id, second.id]));
  await projects.unlinkFromWorkspace(ctx, project.id, b.id, first.id);
  assert.deepEqual((await load()).context, [second.id]);
  assert.deepEqual((await load()).context, [second.id], 'legacy links do not resurrect removed sources on reload');
  assert.ok(await ctx.libraryDb.get(first.id));
  assert.ok(!(await library.libraryForProject(ctx, project.id)).some(row => row.id === first.id));
  await projects.linkToWorkspace(ctx, project.id, b.id, [first.id, first.id]);
  assert.deepEqual((await load()).context, [second.id, first.id]);
  assert.deepEqual((await load()).removedContext, []);
});

test('shared sources survive removing the workspace that first attached them and renaming the project', async t => {
  const { ctx, project, a, row, load } = await setup(t);
  const source = await row('Reference');
  await projects.linkToWorkspace(ctx, project.id, a.id, [source.id]);
  await projects.deleteWorkspace(ctx, project.id, a.id);
  await projects.renameProject(ctx, project.id, 'Renamed project');
  assert.deepEqual((await load()).context, [source.id]);
  assert.ok((await library.libraryForProject(ctx, project.id)).some(row => row.id === source.id));
  assert.ok((await library.projectsForLibraryItem(ctx, source.id)).some(p => p.id === project.id));
});

test('saved mentions and images become shared context; autosaving a removed mention does not restore it', async t => {
  const { ctx, project, a, b, row, load } = await setup(t);
  const source = await row('Reference');
  const image = await projects.saveImage(ctx, project.id, { bytes: Buffer.from('fixture'), mime: 'image/png' });
  const ref = { kind: 'workspace', workspaceId: a.id };
  const text = `@[Reference]\n![Attachment](img:${image.id})`;
  await projects.writeDoc(ctx, project.id, ref, text);
  assert.deepEqual(new Set((await load()).context), new Set([source.id, image.id]));
  await projects.unlinkFromWorkspace(ctx, project.id, b.id, source.id);
  await projects.writeDoc(ctx, project.id, ref, text + '\nMore text');
  assert.deepEqual((await load()).context, [image.id]);
  assert.equal(await projects.readDoc(ctx, project.id, ref), text + '\nMore text', 'removing context never edits the document');
});
