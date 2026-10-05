'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { migrateProjectDir } = require('../src/main/store/migrate.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-projects-'));
const layout = ensureHome(homeDir);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => {
  await db.closeAll();
});

test('projects: create, list, rename moves the directory and rewrites note paths', async () => {
  const created = await projects.createProject(ctx, 'Thesis/2026');
  assert.equal(created.name, 'Thesis-2026');
  assert.equal(created.slug, 'thesis-2026');
  assert.equal(created.directory, null);
  assert.ok(fs.statSync(path.join(layout.testRoot, 'thesis-2026', 'notes.pglite')).isDirectory());
  const note = await projects.createNote(ctx, created.id, { name: 'First' });
  const renamed = await projects.renameProject(ctx, created.id, 'Dissertation');
  assert.equal(renamed.slug, 'dissertation');
  assert.equal((await ctx.libraryDb.get(note.id)).path, path.join(layout.testRoot, 'dissertation', 'First.md'));
  assert.ok((await projects.listProjects(ctx)).some((project) => project.id === created.id && project.workspaceCount === 0));
});

test('a custom project path keeps its directory through renames', async () => {
  const created = await projects.createProject(ctx, { name: 'Reading Group', path: 'rg-2026' });
  assert.equal(created.slug, 'rg-2026');
  assert.equal((await projects.renameProject(ctx, created.id, 'Reading Circle')).slug, 'rg-2026');
});

test('the code directory: stored in project.json, must be an absolute existing directory', async () => {
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-code-'));
  const created = await projects.createProject(ctx, { name: 'With Code', directory: code });
  assert.equal(created.directory, code);
  assert.equal(JSON.parse(fs.readFileSync(path.join(created.dir, 'project.json'), 'utf8')).directory, code);
  const bare = await projects.createProject(ctx, 'No Code Yet');
  assert.equal(bare.directory, null);
  await assert.rejects(projects.setProjectDirectory(ctx, bare.id, 'relative/path'), /absolute/);
  await assert.rejects(projects.setProjectDirectory(ctx, bare.id, path.join(code, 'missing')), /does not exist/);
  assert.equal((await projects.setProjectDirectory(ctx, bare.id, code)).directory, code);
  assert.equal((await projects.loadProject(ctx, bare.id)).project.directory, code);
  fs.rmSync(code, { recursive: true });
  const gone = (await projects.loadProject(ctx, bare.id)).project;
  assert.deepEqual([gone.directory, gone.directoryMissing], [null, code], 'a directory that vanished counts as not chosen, and is named');
});

test('createProjectWithWelcome makes a first workspace and a Welcome! note in its context', async () => {
  const made = await projects.createProjectWithWelcome(ctx, { name: 'Welcome Test' });
  const tree = await projects.loadProject(ctx, made.project.id);
  assert.equal(tree.workspaces.length, 1);
  assert.equal(tree.workspaces[0].name, 'Getting started');
  assert.deepEqual(tree.workspaces[0].context, [made.noteId]);
  assert.equal(tree.notes[0].workspaceId, made.workspaceId);
  assert.ok(fs.existsSync(path.join(made.project.dir, 'Getting started', 'workspace.md')));
  assert.ok(fs.existsSync(path.join(made.project.dir, 'Welcome!.md')));
});

test('workspaces nest to any depth; docs, context and renames work at every level', async () => {
  const project = await projects.createProject(ctx, 'Nesting');
  const top = await projects.createWorkspace(ctx, project.id, { name: 'User Interface' });
  const child = await projects.createWorkspace(ctx, project.id, { name: 'Terminal', parentId: top.id });
  const grandchild = await projects.createWorkspace(ctx, project.id, { name: 'History', parentId: child.id });
  assert.ok(fs.existsSync(path.join(project.dir, 'User Interface', 'Terminal', 'History', 'meta.json')));
  assert.ok(fs.existsSync(path.join(project.dir, 'User Interface', 'Terminal', 'History', 'workspace.md')));

  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: grandchild.id }, '# deep\n');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: grandchild.id }), '# deep\n');
  assert.equal(projects.setWorkspaceStatus, undefined, 'workspaces have no status to set (2026-09-25)');
  assert.equal('status' in (await projects.renameWorkspace(ctx, project.id, child.id, 'Terminal')), false);
  const note = await projects.createNote(ctx, project.id, { name: 'Reading', workspaceId: grandchild.id });
  assert.ok(fs.existsSync(path.join(project.dir, 'Reading.md')), 'notes stay flat in the project');
  assert.deepEqual((await projects.setWorkspaceContext(ctx, project.id, grandchild.id, [note.id])).context, [note.id]);

  const renamed = await projects.renameWorkspace(ctx, project.id, child.id, 'Shell');
  assert.equal(renamed.name, 'Shell');
  assert.ok(fs.existsSync(path.join(project.dir, 'User Interface', 'Shell', 'History', 'workspace.md')), 'children travel with a renamed parent');
  assert.equal((await projects.createWorkspace(ctx, project.id, { name: 'assets' })).name, 'assets workspace');

  const tree = await projects.loadProject(ctx, project.id);
  const ui = tree.workspaces.find((workspace) => workspace.id === top.id);
  assert.equal(ui.children[0].name, 'Shell');
  assert.equal(ui.children[0].children[0].id, grandchild.id);
  assert.equal((await projects.listProjects(ctx)).find((candidate) => candidate.id === project.id).workspaceCount, 4);
  await assert.rejects(projects.createWorkspace(ctx, project.id, { name: 'x', parentId: '00000000-0000-4000-8000-000000000000' }), /Unknown workspace/);
});

test('delete puts a workspace and what is nested in it in the trash; restore puts it back; a week later it is purged (2026-09-30)', async () => {
  const project = await projects.createProject(ctx, 'Trash Can');
  const top = await projects.createWorkspace(ctx, project.id, { name: 'Plans' });
  const child = await projects.createWorkspace(ctx, project.id, { name: 'Draft', parentId: top.id });
  const grandchild = await projects.createWorkspace(ctx, project.id, { name: 'Notes', parentId: child.id });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: child.id }, 'kept\n');

  assert.deepEqual(projects.trashWorkspace(ctx, project.id, child.id), { id: child.id, name: 'Draft' });
  let tree = await projects.loadProject(ctx, project.id);
  assert.deepEqual(tree.workspaces.find((workspace) => workspace.id === top.id).children, [], 'gone from the tree');
  assert.throws(() => projects.findWorkspace(ctx, project.id, grandchild.id), /Unknown workspace/, 'what was nested in it went too');
  assert.equal((await projects.listProjects(ctx)).find((candidate) => candidate.id === project.id).workspaceCount, 1);
  assert.equal(tree.trash.length, 1);
  assert.deepEqual([tree.trash[0].id, tree.trash[0].name, tree.trash[0].nested], [child.id, 'Draft', 1]);

  // A new workspace takes its name meanwhile: the restored one comes back beside it, under its old parent.
  await projects.createWorkspace(ctx, project.id, { name: 'Draft', parentId: top.id });
  const back = projects.restoreWorkspace(ctx, project.id, child.id);
  assert.equal(back.name, 'Draft 2');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: grandchild.id }), '');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: child.id }), 'kept\n');
  assert.equal('trashed' in JSON.parse(fs.readFileSync(path.join(project.dir, 'Plans', 'Draft 2', 'meta.json'), 'utf8')), false);
  assert.deepEqual(projects.trashedWorkspaces(ctx, project.id), []);
  assert.throws(() => projects.restoreWorkspace(ctx, project.id, child.id), /no longer in the trash/);

  // Its parent deleted too: it comes back at the top. And a week on, the trash forgets it.
  projects.trashWorkspace(ctx, project.id, child.id);
  projects.trashWorkspace(ctx, project.id, top.id);
  assert.equal(projects.restoreWorkspace(ctx, project.id, child.id).name, 'Draft 2');
  assert.ok(fs.existsSync(path.join(project.dir, 'Draft 2', 'Notes', 'meta.json')));
  assert.equal(projects.trashedWorkspaces(ctx, project.id, Date.now() + 8 * 24 * 60 * 60 * 1000).length, 0);
  assert.equal(fs.readdirSync(path.join(project.dir, '.trash')).length, 0, 'purged from disk');
});

/* ------------------------------------------------------------ project trash */

const buildStore = require('../src/main/build/store.cjs');
const WEEK = 7 * 24 * 60 * 60 * 1000;
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const metaAt = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
const stateFile = () => JSON.parse(fs.readFileSync(path.join(layout.testRoot, 'state.json'), 'utf8'));
/** Every file under a folder with its bytes: what "untouched" is checked against. */
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).sort().map((name) => [name, fs.statSync(path.join(dir, name)).isFile() ? fs.readFileSync(path.join(dir, name), 'utf8') : '/']));

/** A project with a code folder, a workspace with a document, a note, a pasted image and a view in state.json. */
async function trashable(name) {
  const code = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-trash-code-'));
  fs.writeFileSync(path.join(code, 'main.py'), 'print(1)\n');
  const project = await projects.createProject(ctx, { name, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Plans' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'the plan\n');
  const note = await projects.createNote(ctx, project.id, { name: 'Ideas', workspaceId: workspace.id, text: 'an idea\n' });
  const image = await projects.saveImage(ctx, project.id, { bytes: PNG, mime: 'image/png', name: 'Sketch' });
  projects.writeView(ctx, project.id, workspace.id, { active: note.id, tabs: [{ id: note.id, title: 'Ideas' }], positions: {} });
  projects.writeStage(ctx, project.id, { active: 0, tabs: [{ address: 'https://example.org/', title: 'Example' }] });
  return { code, project, workspace, note, image, before: snapshot(code) };
}

/** A Build record in a project folder, as build/store.cjs keeps it (status, worktree, cwd). */
function record(project, id, { status = 'review', worktree = path.join(layout.testRoot, 'worktrees', project.slug, id), inside = '' } = {}) {
  return buildStore.writeTask({ dir: project.dir }, { id, kind: 'build', projectId: project.id, status, title: 'T', repo: '/nowhere', worktree, cwd: path.join(worktree, inside), branch: `engelbart/${id}`, messages: [], created: new Date().toISOString() });
}

test('delete: a project goes into <dataRoot>/.trash with its notes and images; Restore brings it back as it was; the code folder is never touched (2026-10-03)', async () => {
  const { code, project, workspace, note, image, before } = await trashable('Old Thesis');
  const stopped = [];
  assert.deepEqual(await projects.trashProject(ctx, project.id, { stopBuilds: async (id) => { stopped.push(id); } }), { id: project.id, name: 'Old Thesis' });
  assert.deepEqual(stopped, [project.id], 'its Builds were stopped first');
  const into = path.join(layout.testRoot, '.trash', project.slug);
  assert.ok(!fs.existsSync(project.dir) && fs.existsSync(path.join(into, 'Plans', 'workspace.md')));
  assert.ok(!(await projects.listProjects(ctx)).some((candidate) => candidate.id === project.id), 'gone from the list');
  assert.throws(() => projects.findProject(ctx, project.id), /Unknown project/);
  assert.equal((await ctx.libraryDb.get(note.id)).path, path.join(into, 'Ideas.md'), 'the note row points into the trash');
  assert.equal((await ctx.libraryDb.get(image.id)).path, path.join(into, 'assets', path.basename(image.path)), 'and the image row');
  const { trashed } = metaAt(into);
  assert.deepEqual([trashed.slug, trashed.name, Number.isNaN(Date.parse(trashed.at))], [project.slug, project.slug, false]);
  const listed = await projects.trashedProjects(ctx);
  const mine = listed.find((entry) => entry.id === project.id);
  assert.deepEqual([mine.name, mine.workspaceCount, Date.parse(mine.expires) - Date.parse(mine.deleted)], ['Old Thesis', 1, WEEK]);
  assert.deepEqual(snapshot(code), before, 'the code folder is untouched');

  const back = await projects.restoreProject(ctx, project.id);
  assert.deepEqual([back.id, back.slug, back.dir, back.directory, back.workspaceCount], [project.id, project.slug, project.dir, code, 1]);
  assert.ok((await projects.listProjects(ctx)).some((candidate) => candidate.id === project.id));
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }), 'the plan\n');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'note', id: note.id }), 'an idea\n');
  assert.deepEqual((await projects.loadProject(ctx, project.id)).notes.map((row) => row.id), [note.id], 'its notes database opens again');
  assert.equal((await ctx.libraryDb.get(note.id)).path, path.join(project.dir, 'Ideas.md'));
  assert.equal((await ctx.libraryDb.get(image.id)).path, image.path);
  assert.equal((await projects.readImage(ctx, image.id)).bytes.length, PNG.length);
  assert.equal('trashed' in metaAt(project.dir), false);
  assert.ok(!(await projects.trashedProjects(ctx)).some((entry) => entry.id === project.id));
  assert.ok(projects.readViews(ctx, project.id)[workspace.id], 'its views were kept');
  assert.equal(projects.readStage(ctx, project.id).tabs.length, 1, 'and its Stage tabs');
  assert.deepEqual(snapshot(code), before);
  await assert.rejects(projects.restoreProject(ctx, project.id), /no longer in the trash/);
  await assert.rejects(projects.restoreProject(ctx, '99999999-9999-4999-8999-999999999999'), /no longer in the trash/);
});

test('restore when the folder name is taken: the next free one, its open Builds\' worktrees follow it, a copy that cannot move is discarded (2026-10-03)', async () => {
  const { code, project, note, before } = await trashable('Taken');
  for (const id of ['aaaaaaaaa1', 'aaaaaaaaa2', 'aaaaaaaaa3', 'aaaaaaaaa4']) fs.mkdirSync(path.join(layout.testRoot, 'worktrees', project.slug, id), { recursive: true });
  record(project, 'aaaaaaaaa1', { inside: 'app' });
  record(project, 'aaaaaaaaa2', { status: 'accepted' });
  record(project, 'aaaaaaaaa3', { status: 'stopped' });
  record(project, 'aaaaaaaaa4', { worktree: path.join(layout.testRoot, 'worktrees', project.slug, 'gone-away') }); // nothing there to move
  await projects.trashProject(ctx, project.id);
  const other = await projects.createProject(ctx, 'Taken');
  assert.equal(other.slug, project.slug, 'a new project took the folder name meanwhile');

  const moves = [];
  const removed = [];
  const moveWorktree = async (task, to) => {
    if (task.id === 'aaaaaaaaa3') throw new Error('locked');
    moves.push([task.id, to]);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(task.worktree, to);
  };
  const back = await projects.restoreProject(ctx, project.id, { moveWorktree, removeWorktrees: async (tasks) => { removed.push(...tasks.map((task) => task.id)); } });
  assert.equal(back.slug, `${project.slug} 2`);
  assert.equal(back.name, 'Taken');
  const at = (id) => path.join(layout.testRoot, 'worktrees', back.slug, id);
  assert.deepEqual(moves, [['aaaaaaaaa1', at('aaaaaaaaa1')]], 'only open Builds move');
  const tasks = Object.fromEntries(buildStore.listTasks({ dir: back.dir }).map((task) => [task.id, task]));
  assert.deepEqual([tasks.aaaaaaaaa1.worktree, tasks.aaaaaaaaa1.cwd, tasks.aaaaaaaaa1.status], [at('aaaaaaaaa1'), path.join(at('aaaaaaaaa1'), 'app'), 'review']);
  assert.equal(tasks.aaaaaaaaa2.worktree, path.join(layout.testRoot, 'worktrees', project.slug, 'aaaaaaaaa2'), 'an accepted one stays as it was');
  assert.deepEqual([tasks.aaaaaaaaa3.status, removed], ['discarded', ['aaaaaaaaa3']]);
  assert.match(tasks.aaaaaaaaa3.messages.at(-1).text, /could not be moved .*locked.*discarded/);
  assert.equal(tasks.aaaaaaaaa4.worktree, at('aaaaaaaaa4'), 'a copy that is gone is made again where it now belongs (Resume)');
  assert.equal((await ctx.libraryDb.get(note.id)).path, path.join(back.dir, 'Ideas.md'));
  assert.equal(projects.findProject(ctx, other.id).dir, project.dir, 'the other project keeps its folder');
  assert.deepEqual(snapshot(code), before);
});

test('the trash purges a project a week after it went in: its folder, its library rows, its Builds\' worktrees, its views (2026-10-03)', async () => {
  const { code, project, workspace, note, image, before } = await trashable('Short Lived');
  record(project, 'bbbbbbbbb1');
  record(project, 'bbbbbbbbb2', { status: 'discarded' });
  record(project, 'bbbbbbbbb3', { status: 'accepted' });
  buildStore.writeTask({ dir: project.dir }, { ...buildStore.readTask({ dir: project.dir }, 'bbbbbbbbb3'), keptCopy: true }); // a crash left its copy
  projects.recordEdit(ctx, project.id, workspace.id);
  const kept = await projects.createProject(ctx, 'Not deleted');
  const keptNote = await projects.createNote(ctx, kept.id, { name: 'Stays' });
  await projects.trashProject(ctx, project.id);

  const removed = [];
  const removeWorktrees = async (tasks) => { removed.push(...tasks.map((task) => task.id)); };
  assert.ok((await projects.trashedProjects(ctx, Date.now() + WEEK - 60_000, { removeWorktrees })).some((entry) => entry.id === project.id), 'not yet a week');
  assert.deepEqual(removed, []);
  const later = await projects.trashedProjects(ctx, Date.now() + WEEK + 60_000, { removeWorktrees });
  assert.ok(!later.some((entry) => entry.id === project.id));
  assert.ok(!fs.existsSync(path.join(layout.testRoot, '.trash', project.slug)), 'its folder is gone');
  assert.deepEqual(removed.sort(), ['bbbbbbbbb1', 'bbbbbbbbb3'], 'the worktrees of open Builds, and of an accepted one whose copy was kept');
  assert.equal(await ctx.libraryDb.get(note.id), null);
  assert.equal(await ctx.libraryDb.get(image.id), null);
  assert.equal((await ctx.libraryDb.list()).filter((row) => row.project_id === project.id).length, 0);
  assert.ok(await ctx.libraryDb.get(keptNote.id), 'another project\'s rows stay');
  const state = stateFile();
  assert.equal(project.id in (state.views || {}), false);
  assert.equal(project.id in (state.stages || {}), false, 'its Stage tabs are forgotten');
  assert.deepEqual(projects.readStage(ctx, project.id), { active: 0, tabs: [] });
  assert.equal((state.recent || []).some((entry) => entry.projectId === project.id), false);
  assert.deepEqual(snapshot(code), before, 'the code folder is untouched');
  await assert.rejects(projects.restoreProject(ctx, project.id), /no longer in the trash/, 'a purged project cannot be restored');
});

test('a delete or a restore cut short is finished as restored the next time the trash is read; a code folder inside the project refuses (2026-10-03)', async () => {
  // Restore cut short after the folder moved back: the rows still point into the trash, project.json still has `trashed`.
  const first = await trashable('Half Back');
  await projects.trashProject(ctx, first.project.id);
  fs.renameSync(path.join(layout.testRoot, '.trash', first.project.slug), first.project.dir);
  assert.match((await ctx.libraryDb.get(first.note.id)).path, /\.trash/);
  assert.ok(!(await projects.trashedProjects(ctx)).some((entry) => entry.id === first.project.id));
  assert.equal((await ctx.libraryDb.get(first.note.id)).path, path.join(first.project.dir, 'Ideas.md'));
  assert.equal('trashed' in metaAt(first.project.dir), false);
  // Running restore again repairs as well, and changes nothing more.
  const meta = metaAt(first.project.dir);
  fs.writeFileSync(path.join(first.project.dir, 'project.json'), JSON.stringify({ ...meta, trashed: { at: new Date().toISOString(), slug: first.project.slug, name: first.project.slug } }));
  assert.equal((await projects.restoreProject(ctx, first.project.id)).dir, first.project.dir);
  assert.equal('trashed' in metaAt(first.project.dir), false);
  assert.equal((await ctx.libraryDb.get(first.note.id)).path, path.join(first.project.dir, 'Ideas.md'));

  // A code folder inside the project's Engelbart folder would go into the trash with it: refused, nothing moves.
  const odd = await projects.createProject(ctx, 'Code Inside');
  fs.mkdirSync(path.join(odd.dir, 'src'));
  await projects.setProjectDirectory(ctx, odd.id, path.join(odd.dir, 'src'));
  let stopped = false;
  await assert.rejects(projects.trashProject(ctx, odd.id, { stopBuilds: async () => { stopped = true; } }), /code folder is inside/);
  assert.ok(!stopped && fs.existsSync(path.join(odd.dir, 'src')));
});

test('workspace context is a flat list: folders sent by an old client are flattened, bad entries rejected', async () => {
  const project = await projects.createProject(ctx, 'Folders');
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'W' });
  const note = await projects.createNote(ctx, project.id, { name: 'N', workspaceId: workspace.id });
  const other = await projects.createNote(ctx, project.id, { name: 'O', workspaceId: workspace.id });
  const folder = { id: '11111111-1111-4111-8111-111111111111', name: 'Reading', children: [note.id] };
  assert.deepEqual((await projects.setWorkspaceContext(ctx, project.id, workspace.id, [folder, other.id, note.id])).context, [note.id, other.id]);
  await assert.rejects(projects.setWorkspaceContext(ctx, project.id, workspace.id, [42]), /id or a folder/);
});

test('pasted images: bytes land in <project>/assets, the library gets an image row, and only images are accepted', async () => {
  const project = await projects.createProject(ctx, 'Images');
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const row = await projects.saveImage(ctx, project.id, { bytes: png, mime: 'image/png', name: 'Attachment 1' });
  assert.equal(row.type, 'image');
  assert.equal(row.project_id, project.id);
  assert.equal(row.path, path.join(project.dir, 'assets', `${row.id}.png`));
  assert.deepEqual(fs.readFileSync(row.path), png);
  const read = await projects.readImage(ctx, row.id);
  assert.equal(read.mime, 'image/png');
  assert.deepEqual(Buffer.from(read.bytes), png);
  await assert.rejects(projects.saveImage(ctx, project.id, { bytes: png, mime: 'image/svg+xml' }), /png, jpeg, gif and webp/);
  await assert.rejects(projects.saveImage(ctx, project.id, { bytes: Buffer.alloc(0), mime: 'image/png' }), /empty/);
  assert.equal((await projects.loadProject(ctx, project.id)).workspaces.length, 0, 'assets is not a workspace');
});

test('the goal/topic layout converts in place: topics become workspaces, ids and notes survive, nothing is deleted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-legacy-'));
  const legacyLayout = ensureHome(root);
  const legacyCtx = { homeDir: root, root: legacyLayout.root, dataRoot: legacyLayout.root, libraryDb: await db.openLibraryDb(legacyLayout.root) };
  const dir = path.join(legacyLayout.root, 'engelbart');
  const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const pid = '21f92f4d-0358-4154-850a-751be41113db';
  const ui = '712e0e1d-0715-49f8-b47f-ed08b8cb3c9b';
  const other = '69ee72b1-7963-4f83-8a7b-05d4a9e61d24';
  write(path.join(dir, 'project.json'), { id: pid, name: 'Engelbart', created: '2026-09-17T03:46:45.017Z' });
  write(path.join(dir, 'First steps', 'meta.json'), { id: 'cc48c423-574b-4bff-85f6-53b2bc44b5ac', box: 'current', created: '2026-09-17T03:46:45.503Z' });
  write(path.join(dir, 'First steps', 'future.md'), '- later\n');
  const held = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
  write(path.join(dir, 'First steps', 'User Interface', 'meta.json'), { id: ui, status: 'open', context: [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Reading', children: [held[0]] }, held[1]], created: '2026-09-17T03:47:32.035Z' });
  write(path.join(dir, 'First steps', 'User Interface', 'workspace.md'), 'ui notes\n');
  write(path.join(dir, 'Second', 'meta.json'), { id: 'dd48c423-574b-4bff-85f6-53b2bc44b5ac', box: 'past', created: '2026-09-17T04:00:00.000Z' });
  write(path.join(dir, 'Second', 'User Interface', 'meta.json'), { id: other, status: 'done', context: [], created: '2026-09-17T04:01:00.000Z' });
  write(path.join(dir, 'Second', 'User Interface', 'workspace.md'), 'same name, other goal\n');

  const preview = migrateProjectDir(dir, { dryRun: true });
  assert.deepEqual(preview.moved.map((move) => move.to), ['User Interface', 'User Interface 2']);
  assert.ok(fs.existsSync(path.join(dir, 'First steps', 'User Interface', 'workspace.md')), 'a dry run moves nothing');

  const tree = await projects.loadProject(legacyCtx, pid); // the store converts on first touch
  assert.deepEqual(tree.workspaces.map((workspace) => [workspace.id, workspace.name]), [[ui, 'User Interface'], [other, 'User Interface 2']]);
  assert.equal(await projects.readDoc(legacyCtx, pid, { kind: 'workspace', workspaceId: ui }), 'ui notes\n');
  assert.deepEqual(tree.workspaces[0].context, held, 'what the context folder held stays, flat and in order');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'User Interface', 'meta.json'), 'utf8')).context, held);
  assert.equal(fs.readFileSync(path.join(dir, '.legacy', 'First steps', 'future.md'), 'utf8'), '- later\n');
  const backups = fs.readdirSync(path.join(legacyLayout.root, '.backups'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(legacyLayout.root, '.backups', backups[0], 'First steps', 'User Interface', 'workspace.md'), 'utf8'), 'ui notes\n');
  assert.equal(migrateProjectDir(dir), null, 'already converted');
  assert.equal((await projects.listProjects(legacyCtx)).length, 1, 'dot directories are not projects');
});

test('last-open state: stored per data root, stale ids become null, files from the topic era still read', async () => {
  const project = await projects.createProject(ctx, 'Reopen');
  const written = projects.writeLastOpen(ctx, { projectId: project.id, workspaceId: 'nope', extra: 1 });
  assert.deepEqual(written, { projectId: project.id, workspaceId: null });
  assert.deepEqual(projects.readLastOpen(ctx), written);
  fs.writeFileSync(path.join(layout.testRoot, 'state.json'), JSON.stringify({ projectId: project.id, goalId: project.id, topicId: project.id }));
  assert.deepEqual(projects.readLastOpen(ctx), { projectId: project.id, workspaceId: project.id });
});

test('views: each workspace keeps its tabs, the document in front and its scroll positions; last-open keeps them (2026-09-22)', async () => {
  const project = await projects.createProject(ctx, 'Views');
  const other = await projects.createProject(ctx, 'Views elsewhere');
  const ws = '11111111-1111-4111-8111-111111111111', ws2 = '22222222-2222-4222-8222-222222222222';
  const note = '33333333-3333-4333-8333-333333333333', gone = '44444444-4444-4444-8444-444444444444';
  projects.writeLastOpen(ctx, { projectId: project.id, workspaceId: ws });
  const saved = projects.writeView(ctx, project.id, ws, {
    active: note,
    tabs: [{ id: note, title: 'Middle Canvas' }, { id: note, title: 'twice' }, { id: 'not-an-id', title: 'x' }],
    positions: { [`ws:${ws}`]: { top: 120.4, line: 7, offset: 12.6, hash: 'abc12' }, [`note:${note}`]: { top: 900 }, 'bad:key': { top: 1 }, [`note:${gone}`]: { top: 'x' } },
    extra: true,
  });
  assert.deepEqual(saved, { active: note, tabs: [{ id: note, title: 'Middle Canvas' }], positions: { [`ws:${ws}`]: { top: 120, line: 7, offset: 13, hash: 'abc12' }, [`note:${note}`]: { top: 900 } } });
  projects.writeView(ctx, project.id, ws2, { active: gone, tabs: [] });
  projects.writeView(ctx, other.id, ws, { active: 'ws', tabs: [], positions: {} });
  const views = projects.readViews(ctx, project.id);
  assert.deepEqual(views[ws], saved);
  assert.deepEqual(views[ws2], { active: 'ws', tabs: [], positions: {} }, 'a document in front that is not one of its tabs falls back to the workspace');
  assert.deepEqual(Object.keys(projects.readViews(ctx, other.id)), [ws], 'views are per project');
  assert.deepEqual(projects.readLastOpen(ctx), { projectId: project.id, workspaceId: ws }, 'saving a view keeps where the app reopens');
  projects.writeLastOpen(ctx, { projectId: other.id, workspaceId: ws2 });
  assert.deepEqual(projects.readViews(ctx, project.id)[ws], saved, 'moving to another workspace keeps every view');
  assert.deepEqual(projects.readViews(ctx, 'nope'), {});
  assert.throws(() => projects.writeView(ctx, project.id, 'nope', {}), /workspace id/);
  assert.throws(() => projects.writeView(ctx, project.id, ws, null), /invalid/);
  // Another workspace's document open as a tab keeps its kind; any other kind is dropped (2026-09-23).
  const withWs = projects.writeView(ctx, project.id, ws, { active: ws2, tabs: [{ id: note, title: 'n', kind: 'note?' }, { id: ws2, title: 'Child', kind: 'workspace' }], positions: {} });
  assert.deepEqual(withWs.tabs, [{ id: note, title: 'n' }, { id: ws2, title: 'Child', kind: 'workspace' }]);
  assert.equal(withWs.active, ws2);
});

test('cleanStage: a library row or a place, once each, at most 15, a title of 200 characters; active follows what was kept (MATH-10)', () => {
  const row = '55555555-5555-4555-8555-555555555555', other = '66666666-6666-4666-8666-666666666666';
  assert.equal(projects.cleanStage(null), null);
  assert.equal(projects.cleanStage([]), null);
  assert.deepEqual(projects.cleanStage({}), { active: 0, tabs: [] });
  const clean = projects.cleanStage({
    active: 6,
    tabs: [
      { item: row, title: 'ColBERT' },
      { item: 'not-an-id', title: 'x' }, // no row id, no address
      { address: 'about:blank', title: 'blank' },
      { address: 'ABOUT:srcdoc' },
      { address: 'x'.repeat(10) }, // neither a URL nor an absolute path
      { address: `https://example.org/${'a'.repeat(2048)}` }, // too long
      { address: 'http://www.example.org/a/', title: 'Example' },
      { address: 'https://example.org/a#top', title: 'the same page' },
      { item: row, title: 'twice' },
      { address: '/Users/h/notes.md', title: 'notes.md' },
      { address: 'file:///Users/h/notes.md', title: 'the same file' },
      { address: 'javascript:alert(1)' },
      { address: 42 },
      null,
      'https://example.org',
      { address: '  https://other.org/p  ', title: 'T'.repeat(300), extra: true, bytes: [1, 2] },
      { item: other, address: 'https://ignored.org' },
    ],
  });
  assert.deepEqual(clean.tabs, [
    { item: row, title: 'ColBERT' },
    { address: 'http://www.example.org/a/', title: 'Example' },
    { address: '/Users/h/notes.md', title: 'notes.md' },
    { address: 'https://other.org/p', title: 'T'.repeat(200) },
    { item: other, title: '' },
  ]);
  assert.equal(clean.active, 1, 'the page in front is where it was kept');
  assert.equal(projects.cleanStage({ active: 7, tabs: clean.tabs.concat([]) }).active, 4, 'past the end: the last');
  assert.equal(projects.cleanStage({ active: 1, tabs: [{ address: 'https://a.org' }, { address: 'https://a.org/' }] }).active, 0, 'a duplicate in front: the one it repeats');
  assert.equal(projects.cleanStage({ active: -3, tabs: [{ address: 'https://a.org' }] }).active, 0);
  assert.equal(projects.cleanStage({ active: '2', tabs: [{ address: 'https://a.org' }] }).active, 0);
  assert.deepEqual(projects.cleanStage({ active: 2, tabs: [] }), { active: 0, tabs: [] });

  const many = Array.from({ length: 20 }, (_, i) => ({ address: `https://s${i}.org`, title: `s${i}` }));
  const capped = projects.cleanStage({ active: 18, tabs: many });
  assert.equal(capped.tabs.length, 15);
  assert.deepEqual(capped.tabs.map((tab) => tab.title), many.slice(0, 15).map((tab) => tab.title));
  assert.equal(capped.active, 14, 'a tab in front past 15 is clamped to the last kept');
});

test('Stage tabs: kept per project in state.json beside the views, windows and recent workspaces, which writing them keeps (MATH-10)', async () => {
  const project = await projects.createProject(ctx, 'Stage kept');
  const other = await projects.createProject(ctx, 'Stage elsewhere');
  const ws = await projects.createWorkspace(ctx, project.id, { name: 'Plans' });
  projects.writeLastOpen(ctx, { projectId: project.id, workspaceId: ws.id });
  const view = projects.writeView(ctx, project.id, ws.id, { active: 'ws', tabs: [], positions: {} });
  const windows = projects.writeWindows(ctx, [{ projectId: project.id, workspaceId: ws.id, bounds: { x: 0, y: 0, width: 800, height: 600 } }]);
  const heldRecent = stateFile().recent; // put back at the end: the next test counts the recent workspaces
  projects.recordEdit(ctx, project.id, ws.id);
  const recent = stateFile().recent;

  assert.deepEqual(projects.readStage(ctx, project.id), { active: 0, tabs: [] }, 'nothing kept yet');
  const saved = projects.writeStage(ctx, project.id, { active: 1, tabs: [{ address: 'https://example.org', title: 'Example' }, { address: '/Users/h/a.pdf', title: 'a' }] });
  assert.deepEqual(saved, { active: 1, tabs: [{ address: 'https://example.org', title: 'Example' }, { address: '/Users/h/a.pdf', title: 'a' }] });
  projects.writeStage(ctx, other.id, { active: 0, tabs: [{ address: 'https://other.org', title: 'Other' }] });
  assert.deepEqual(projects.readStage(ctx, project.id), saved, 'each project its own');
  assert.equal(projects.readStage(ctx, other.id).tabs[0].title, 'Other');

  const state = stateFile();
  assert.deepEqual(state.views[project.id][ws.id], view, 'the views are kept');
  assert.deepEqual(state.windows, windows, 'and the windows');
  assert.deepEqual(state.recent, recent, 'and the recent workspaces');
  assert.deepEqual([state.projectId, state.workspaceId], [project.id, ws.id], 'and where the app reopens');
  projects.writeView(ctx, project.id, ws.id, { active: 'ws', tabs: [], positions: {} });
  assert.deepEqual(projects.readStage(ctx, project.id), saved, 'writing a view keeps the Stage');

  projects.writeStage(ctx, project.id, { active: 0, tabs: [] });
  assert.deepEqual(projects.readStage(ctx, project.id), { active: 0, tabs: [] }, 'every tab closed is kept too');
  assert.deepEqual(projects.readStage(ctx, 'nope'), { active: 0, tabs: [] });
  assert.throws(() => projects.writeStage(ctx, 'nope', { tabs: [] }), /project id/);
  assert.throws(() => projects.writeStage(ctx, project.id, null), /invalid/);
  // What another version wrote by hand is read through cleanStage.
  fs.writeFileSync(path.join(layout.testRoot, 'state.json'), JSON.stringify({ ...stateFile(), recent: heldRecent, stages: { [project.id]: { active: 9, tabs: [{ address: 'about:blank' }, { address: 'https://a.org' }] } } }));
  assert.deepEqual(projects.readStage(ctx, project.id), { active: 0, tabs: [{ address: 'https://a.org', title: '' }] });
});

test('where to next: state.json keeps the last three workspaces written in and the agents, beside the views; stale rows are not read (2026-09-22)', async () => {
  const project = await projects.createProject(ctx, 'Next place');
  const a = await projects.createWorkspace(ctx, project.id, { name: 'Alpha' });
  const b = await projects.createWorkspace(ctx, project.id, { name: 'Beta' });
  const c = await projects.createWorkspace(ctx, project.id, { name: 'Gamma', parentId: b.id });
  const d = await projects.createWorkspace(ctx, project.id, { name: 'Delta' });
  projects.writeLastOpen(ctx, { projectId: project.id, workspaceId: a.id });
  projects.writeView(ctx, project.id, a.id, { active: 'ws', tabs: [], positions: {} });

  for (const workspace of [a, b, c, a, d]) projects.recordEdit(ctx, project.id, workspace.id);
  let nav = projects.readNav(ctx);
  assert.deepEqual(nav.recent.map((entry) => entry.name), ['Delta', 'Alpha', 'Gamma', 'Beta'], 'newest first, once each; every one written in the last thirty minutes');
  assert.deepEqual([nav.recent[2].path, nav.recent[2].projectName], ['Beta/Gamma', 'Next place']);
  assert.ok(nav.recent.every((entry) => !Number.isNaN(Date.parse(entry.at))));
  assert.throws(() => projects.recordEdit(ctx, project.id, '99999999-9999-4999-8999-999999999999'), /Unknown workspace/);

  projects.agentStarted(ctx, { id: 'ask-1', kind: 'bart', projectId: project.id, workspaceId: b.id, doc: { kind: 'workspace', workspaceId: b.id } });
  projects.agentStarted(ctx, { id: 'ask-2', kind: 'bart', projectId: project.id, workspaceId: c.id, doc: { kind: 'note', id: 'not-an-id' } });
  nav = projects.readNav(ctx);
  assert.deepEqual(nav.agents.map((agent) => [agent.id, agent.status, agent.name]), [['ask-1', 'running', 'Beta'], ['ask-2', 'running', 'Gamma']]);
  assert.deepEqual(nav.agents[1].doc, null, 'a document reference that is not one is dropped, the agent kept');
  projects.agentFinished(ctx, 'ask-1');
  projects.agentStopped(ctx, 'ask-2');
  nav = projects.readNav(ctx);
  assert.deepEqual(nav.agents.map((agent) => [agent.id, agent.status]), [['ask-1', 'waiting']], 'a stopped agent leaves nothing waiting');
  assert.ok(nav.agents[0].finished);
  assert.equal(projects.seenAgents(ctx, project.id, a.id), 0, 'looking elsewhere sees nothing');
  assert.equal(projects.seenAgents(ctx, project.id, b.id), 1);
  assert.deepEqual(projects.readNav(ctx).agents, []);

  const file = path.join(layout.testRoot, 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([state.projectId, state.workspaceId], [project.id, a.id], 'where the app reopens is kept');
  assert.ok(state.views[project.id][a.id], 'and every view');
  assert.equal(state.recent.length, 4);
  projects.writeView(ctx, project.id, b.id, { active: 'ws', tabs: [], positions: {} });
  projects.writeLastOpen(ctx, { projectId: project.id, workspaceId: b.id });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recent.length, 4, 'saving a view or where the app reopens keeps the recent ones');

  // A running row written by an earlier run of the app (its id not live here), a waiting one whose workspace is gone, junk.
  fs.writeFileSync(file, JSON.stringify({ ...state, agents: [
    { id: 'old-run', kind: 'bart', projectId: project.id, workspaceId: a.id, status: 'running', started: '2026-09-21T10:00:00.000Z' },
    { id: 'gone', kind: 'bart', projectId: project.id, workspaceId: '99999999-9999-4999-8999-999999999999', status: 'waiting', finished: '2026-09-21T10:00:00.000Z' },
    { id: 'kept', kind: 'bart', projectId: project.id, workspaceId: d.id, status: 'waiting', finished: '2026-09-21T10:00:00.000Z' },
    { id: 'odd', kind: 'robot', projectId: project.id, workspaceId: d.id, status: 'waiting' },
    'nonsense',
  ], recent: [...state.recent, { projectId: project.id, workspaceId: 'nope', at: 'x' }] }));
  nav = projects.readNav(ctx);
  assert.deepEqual(nav.agents.map((agent) => agent.id), ['kept']);
  assert.equal(nav.recent.length, 4);

  // Older than thirty minutes: only the newest three stay, however many there were (2026-09-23).
  const old = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
  fs.writeFileSync(file, JSON.stringify({ ...state, agents: [], recent: [
    { projectId: project.id, workspaceId: d.id, at: old(5) },
    { projectId: project.id, workspaceId: a.id, at: old(40) },
    { projectId: project.id, workspaceId: c.id, at: old(50) },
    { projectId: project.id, workspaceId: b.id, at: old(60) },
  ] }));
  assert.deepEqual(projects.readNav(ctx).recent.map((entry) => entry.name), ['Delta', 'Alpha', 'Gamma'], 'the last three when fewer than three are fresh');
  fs.writeFileSync(file, JSON.stringify({ ...state, agents: [], recent: [
    { projectId: project.id, workspaceId: d.id, at: old(1) },
    { projectId: project.id, workspaceId: a.id, at: old(2) },
    { projectId: project.id, workspaceId: c.id, at: old(3) },
    { projectId: project.id, workspaceId: b.id, at: old(29) },
  ] }));
  assert.equal(projects.readNav(ctx).recent.length, 4, 'all four when all four are fresh');
  projects.recordEdit(ctx, project.id, a.id);
  assert.deepEqual(projects.readNav(ctx).recent.map((entry) => entry.name), ['Alpha', 'Delta', 'Gamma', 'Beta']);
});

test('read-text-file: project-relative, ~/ and absolute paths inside the home directory only', async () => {
  const project = await projects.createProject(ctx, 'Browser');
  fs.writeFileSync(path.join(project.dir, 'notes.txt'), 'hello\nworld\n');
  assert.equal((await projects.readProjectTextFile(ctx, project.id, 'notes.txt')).text, 'hello\nworld\n');
  assert.equal((await projects.readProjectTextFile(ctx, project.id, './notes.txt')).kind, 'file');
  const viaHome = await projects.readProjectTextFile(ctx, project.id, `~/${path.relative(homeDir, path.join(project.dir, 'notes.txt'))}`);
  assert.equal(viaHome.text, 'hello\nworld\n');
  const dir = await projects.readProjectTextFile(ctx, project.id, project.dir);
  assert.equal(dir.kind, 'directory');
  assert.ok(dir.text.split('\n').includes('notes.txt'));
  await assert.rejects(projects.readProjectTextFile(ctx, project.id, '/etc/hosts'), /inside your home directory/);
  await assert.rejects(projects.readProjectTextFile(ctx, project.id, 'missing.txt'));
  fs.writeFileSync(path.join(project.dir, 'big.txt'), 'x'.repeat(25000));
  const big = await projects.readProjectTextFile(ctx, project.id, 'big.txt');
  assert.equal(big.text.length, 20000);
  assert.equal(big.truncated, true);
});

test('stage-file: a missing path is "Nothing is at that path", one macOS refuses says so (2026-10-02)', async (t) => {
  const { BLOCKED } = require('../src/main/stage/files.cjs');
  const project = await projects.createProject(ctx, 'Stage Paths');
  const kept = path.join(project.dir, 'kept.md');
  fs.writeFileSync(kept, '# kept');
  await assert.rejects(projects.readStageFile(ctx, project.id, path.join(project.dir, 'missing.md')), { message: 'Nothing is at that path' });
  const real = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', function (target, ...rest) {
    if (target === kept) throw Object.assign(new Error(`EPERM: operation not permitted, lstat '${target}'`), { code: 'EPERM' });
    return real.call(fs, target, ...rest);
  });
  await assert.rejects(projects.readStageFile(ctx, project.id, kept), { message: BLOCKED });
  t.mock.restoreAll();
  assert.equal((await projects.readStageFile(ctx, project.id, kept)).text, '# kept');
});

test('resolve-page-file: an html file by full path, or relative to the project, the engelbart folder or the code directory', async () => {
  const code = path.join(homeDir, 'code-pages');
  fs.mkdirSync(path.join(code, 'docs'), { recursive: true });
  const project = await projects.createProject(ctx, { name: 'Pages', directory: code });
  fs.mkdirSync(path.join(project.dir, 'My Workspace'), { recursive: true });
  fs.writeFileSync(path.join(project.dir, 'My Workspace', 'report.html'), '<h1>r</h1>');
  fs.writeFileSync(path.join(project.dir, 'notes.txt'), 'text');
  fs.writeFileSync(path.join(code, 'docs', 'index.htm'), '<h1>d</h1>');
  const real = (file) => fs.realpathSync(file);
  const { pathToFileURL } = require('node:url');

  const report = real(path.join(project.dir, 'My Workspace', 'report.html'));
  const found = await projects.resolvePageFile(ctx, project.id, 'My Workspace/report.html');
  assert.deepEqual(found, { path: report, url: pathToFileURL(report).href });
  assert.equal((await projects.resolvePageFile(ctx, project.id, report)).path, report);
  assert.equal((await projects.resolvePageFile(ctx, project.id, `~/${path.relative(homeDir, report)}`)).path, report);
  assert.equal((await projects.resolvePageFile(ctx, project.id, pathToFileURL(report).href)).path, report);
  assert.equal((await projects.resolvePageFile(ctx, project.id, `${path.basename(project.dir)}/My Workspace/report.html`)).path, report); // from the engelbart folder
  assert.equal((await projects.resolvePageFile(ctx, project.id, 'docs/index.htm')).path, real(path.join(code, 'docs', 'index.htm'))); // from the code directory
  assert.equal((await projects.resolvePageFile(ctx, project.id, 'My Workspace/report.html#results?x')).url, `${pathToFileURL(report).href}#results?x`);
  fs.writeFileSync(path.join(project.dir, 'My Workspace', 'paper.pdf'), '%PDF-1.4');
  assert.equal((await projects.resolvePageFile(ctx, project.id, 'My Workspace/paper.pdf')).url, pathToFileURL(real(path.join(project.dir, 'My Workspace', 'paper.pdf'))).href); // not printed as text

  for (const not of ['notes.txt', 'missing.html', 'apple.com', 'example.com/index.html', '/etc/hosts', 'My Workspace']) {
    assert.equal(await projects.resolvePageFile(ctx, project.id, not), null, not);
  }
  fs.symlinkSync('/etc/hosts', path.join(project.dir, 'escape.html'));
  assert.equal(await projects.resolvePageFile(ctx, project.id, 'escape.html'), null);
  assert.equal((await projects.readProjectTextFile(ctx, project.id, 'notes.txt')).text, 'text');
});

test('ipc: trash-project stops the project\'s running @bart asks and its Builds first; trashed-projects and restore-project; the preload names all three (2026-10-03)', async (t) => {
  const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const store = createStore({ homeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-trash-ipc-')), testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  const asks = [];
  const stopped = [];
  const builds = { stopProject: async (_, pid) => { stopped.push(pid); }, removeWorktrees: async () => {}, moveWorktree: async () => {} };
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, bart: { stop: (id) => { asks.push(id); return true; } }, builds });
  const h = (name) => handlers.get(`engelbart:${name}`);
  const own = await store.context();
  const project = await h('create-project')({ name: 'Gone Soon' });
  const other = await h('create-project')({ name: 'Staying' });
  const ws = await h('create-workspace')(project.id, { name: 'W' });
  const ws2 = await h('create-workspace')(other.id, { name: 'W' });
  projects.agentStarted(own, { id: 'ask-here', kind: 'bart', projectId: project.id, workspaceId: ws.id });
  projects.agentStarted(own, { id: 'ask-there', kind: 'discover', projectId: other.id, workspaceId: ws2.id });

  assert.deepEqual(await h('trash-project')(project.id), { id: project.id, name: 'Gone Soon' });
  assert.deepEqual([asks, stopped], [['ask-here'], [project.id]]);
  assert.deepEqual((await h('trashed-projects')()).map((entry) => entry.name), ['Gone Soon']);
  assert.deepEqual((await h('list-projects')()).map((entry) => entry.name), ['Staying']);
  assert.equal((await h('restore-project')(project.id)).name, 'Gone Soon');
  assert.deepEqual(await h('trashed-projects')(), []);
  await assert.rejects(h('restore-project')(project.id), /no longer in the trash/);
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  for (const [name, channel] of [['trashProject', 'trash-project'], ['restoreProject', 'restore-project'], ['trashedProjects', 'trashed-projects']]) assert.ok(preload.includes(`${name}: invoke('${channel}')`), name);
});
