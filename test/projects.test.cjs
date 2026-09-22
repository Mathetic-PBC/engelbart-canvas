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

test('workspaces nest to any depth; docs, status, context and renames work at every level', async () => {
  const project = await projects.createProject(ctx, 'Nesting');
  const top = await projects.createWorkspace(ctx, project.id, { name: 'User Interface' });
  const child = await projects.createWorkspace(ctx, project.id, { name: 'Terminal', parentId: top.id });
  const grandchild = await projects.createWorkspace(ctx, project.id, { name: 'History', parentId: child.id });
  assert.ok(fs.existsSync(path.join(project.dir, 'User Interface', 'Terminal', 'History', 'meta.json')));
  assert.ok(fs.existsSync(path.join(project.dir, 'User Interface', 'Terminal', 'History', 'workspace.md')));

  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: grandchild.id }, '# deep\n');
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: grandchild.id }), '# deep\n');
  assert.equal((await projects.setWorkspaceStatus(ctx, project.id, child.id, 'progress')).status, 'progress');
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
  assert.deepEqual(tree.workspaces.map((workspace) => [workspace.id, workspace.name, workspace.status]), [[ui, 'User Interface', 'open'], [other, 'User Interface 2', 'done']]);
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

  for (const not of ['notes.txt', 'missing.html', 'apple.com', 'example.com/index.html', '/etc/hosts', 'My Workspace']) {
    assert.equal(await projects.resolvePageFile(ctx, project.id, not), null, not);
  }
  fs.symlinkSync('/etc/hosts', path.join(project.dir, 'escape.html'));
  assert.equal(await projects.resolvePageFile(ctx, project.id, 'escape.html'), null);
  assert.equal((await projects.readProjectTextFile(ctx, project.id, 'notes.txt')).text, 'text');
});
