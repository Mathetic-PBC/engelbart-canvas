'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { ensureHome, readJson, writeJson } = require('../src/main/store/home.cjs');
const db = require('../src/main/store/db.cjs');
const projects = require('../src/main/store/projects.cjs');
const repositories = require('../src/main/store/workspace-repositories.cjs');
const { migrateProjectDir } = require('../src/main/store/migrate.cjs');
const codeWorkspaces = require('../src/main/store/code-workspaces.cjs');
const builds = require('../src/main/build/store.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-code-workspaces-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => db.closeAll());
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
// Older projects had no project-root code/. Keep the fixture compatible with
// case-insensitive filesystems when it later adds a genuine legacy Code folder.
async function legacyProject(ctx, name) {
  const directory = path.join(homeDir, randomUUID()); fs.mkdirSync(directory);
  git(directory, 'init', '-q', '-b', 'main'); git(directory, 'commit', '--allow-empty', '-qm', 'Existing project');
  return projects.createProject(ctx, { name, directory });
}
function workspace(dir, patch = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const meta = { id: randomUUID(), status: 'open', context: [], created: '2026-09-17T03:47:32.035Z', custom: { retain: true }, ...patch };
  writeJson(path.join(dir, 'meta.json'), meta);
  fs.writeFileSync(path.join(dir, 'workspace.md'), `Document for ${meta.id}\n`);
  return { ...meta, dir };
}
async function repository(project, owner, name = 'code') {
  const dir = path.join(owner.dir, name);
  fs.mkdirSync(dir); git(dir, 'init', '-q', '-b', 'main'); git(dir, 'commit', '--allow-empty', '-qm', 'History to preserve');
  const repo = await repositories.register(ctx, project, dir, { managed: true, name: `${owner.id} source` });
  writeJson(path.join(owner.dir, 'meta.json'), { ...readJson(path.join(owner.dir, 'meta.json')), repoId: repo.id });
  return { ...repo, dir, head: git(dir, 'rev-parse', 'HEAD') };
}

test('root Code survives already-complete migrations with IDs, documents, children, archives and path references intact', async () => {
  // createProject also populates the older in-memory "migrated" set.
  const project = await legacyProject(ctx, 'Legacy root Code');
  const top = workspace(path.join(project.dir, 'Code'));
  const child = workspace(path.join(top.dir, 'Child'));
  const repo = await repository(project, top), childRepo = await repository(project, child);
  const archive = '2026-09-17T03-47-32Z';
  fs.mkdirSync(path.join(top.dir, '.archive'));
  fs.writeFileSync(path.join(top.dir, '.archive', `${archive}.md`), 'Preserved archived conversation');
  writeJson(path.join(top.dir, 'meta.json'), { ...readJson(path.join(top.dir, 'meta.json')), archives: [{ file: archive, title: 'Before clear', clearedAt: '2026-09-17T03:47:32Z' }], builds: ['aabbccdd11'] });
  builds.writeTask(project, { id: 'aabbccdd11', projectId: project.id, workspaceId: child.id, status: 'accepted', repoId: childRepo.id, repo: childRepo.dir, sourceDirectory: childRepo.dir, worktree: '/missing/old-worktree', cwd: '/missing/old-worktree', preview: { directory: childRepo.dir }, messages: [{ role: 'agent', text: 'Historical reply' }] });
  const attachment = path.join(top.dir, 'reference.txt'); fs.writeFileSync(attachment, 'Original attachment');
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Reference', type: 'md', path: attachment, project_id: project.id });
  const saved = path.join(ctx.dataRoot, '.local-apps', project.id, top.id, 'state.json');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  writeJson(saved, { projectId: project.id, workspaceId: top.id, repoId: repo.id, directory: repo.dir, libraryId: repo.libraryId, status: 'stopped', logs: ['old preview'] });
  projects.writeLastOpen(ctx, { projectId: project.id, workspaceId: child.id });
  projects.writeView(ctx, project.id, top.id, { active: 'ws', tabs: [{ id: row.id, kind: 'source', path: attachment, title: 'Reference' }], positions: { [`ws:${top.id}`]: { top: 50 } } });
  assert.equal(readJson(path.join(project.dir, 'project.json')).repositoryMigration.status, 'complete');

  const tree = await projects.loadProject(ctx, project.id);
  const renamed = tree.workspaces[0], dir = path.join(project.dir, 'Code workspace');
  assert.equal(renamed.id, top.id); assert.equal(renamed.name, 'Code workspace');
  assert.equal(renamed.repoId, repo.id); assert.equal(renamed.children[0].id, child.id);
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: top.id }), `Document for ${top.id}\n`);
  assert.equal(fs.readFileSync(path.join(dir, '.archive', `${archive}.md`), 'utf8'), 'Preserved archived conversation');
  assert.deepEqual(readJson(path.join(dir, 'meta.json')).custom, { retain: true });
  assert.deepEqual(renamed.builds, ['aabbccdd11']); assert.equal(renamed.archives[0].file, archive);
  assert.equal(git(path.join(dir, 'code'), 'rev-parse', 'HEAD'), repo.head);
  assert.equal(git(path.join(dir, 'Child/code'), 'rev-parse', 'HEAD'), childRepo.head);
  assert.equal(repositories.registry(project)[repo.id].location, 'Code workspace/code');
  assert.equal((await ctx.libraryDb.get(repo.libraryId)).folder_path, path.join(dir, 'code'));
  assert.equal((await ctx.libraryDb.get(row.id)).path, path.join(dir, 'reference.txt'));
  const task = builds.readTask(project, 'aabbccdd11');
  assert.equal(task.repoId, childRepo.id); assert.equal(task.repo, path.join(dir, 'Child/code'));
  assert.equal(task.preview.directory, task.repo); assert.deepEqual(task.messages, [{ role: 'agent', text: 'Historical reply' }]);
  assert.equal(readJson(saved).directory, path.join(dir, 'code')); assert.deepEqual(readJson(saved).logs, ['old preview']);
  assert.equal(projects.readLastOpen(ctx).workspaceId, child.id);
  assert.equal(projects.readViews(ctx, project.id)[top.id].tabs[0].path, path.join(dir, 'reference.txt'));
  const catalog = readJson(path.join(project.dir, '.context/catalog.json'));
  assert.equal(catalog.workspaces.find(row => row.id === child.id).path, 'Code workspace/Child');
  assert.equal(catalog.repositories.find(row => row.id === repo.id).libraryId, repo.libraryId);
});

for (const name of ['code', 'Code', 'CODE']) test(`nested ${name} workspace and its reserved-name child migrate, repeatably`, async () => {
  const project = await legacyProject(ctx, `Nested ${name}`);
  const parent = await projects.createWorkspace(ctx, project.id, { name: 'Parent', createDefault: true });
  // Parent's real code/ is elsewhere; release that name for a legacy child.
  const parentRepo = repositories.resolve(ctx, project.id, parent.id);
  fs.renameSync(parentRepo.directory, path.join(project.dir, 'parent-source'));
  const meta = readJson(path.join(project.dir, 'project.json'));
  meta.repositories[parentRepo.repoId].location = 'parent-source'; writeJson(path.join(project.dir, 'project.json'), meta);
  const legacy = workspace(path.join(project.dir, 'Parent', name));
  const deep = workspace(path.join(legacy.dir, 'cOdE'));
  // Hudson-era workspace records need not have status.
  const value = readJson(path.join(deep.dir, 'meta.json')); delete value.status; writeJson(path.join(deep.dir, 'meta.json'), value);
  await projects.loadProject(ctx, project.id);
  const result = projects.flattenWorkspaces(project.dir);
  assert.equal(result.find(row => row.id === legacy.id).path, 'Parent/Code workspace');
  assert.equal(result.find(row => row.id === deep.id).path, 'Parent/Code workspace/Code workspace');
  const first = readJson(path.join(project.dir, 'project.json')), catalog = readJson(path.join(project.dir, '.context/catalog.json'));
  await repositories.ensure(ctx, project.id); await projects.loadProject(ctx, project.id);
  assert.deepEqual(readJson(path.join(project.dir, 'project.json')), first);
  assert.deepEqual(readJson(path.join(project.dir, '.context/catalog.json')), catalog);
  assert.equal(first.workspaceNameMigration.status, 'complete');
});

test('Code workspace destination collisions preserve files and choose the next available name', async () => {
  const project = await legacyProject(ctx, 'Collision');
  const top = workspace(path.join(project.dir, 'Code'));
  const other = workspace(path.join(project.dir, 'Code workspace'));
  fs.writeFileSync(path.join(project.dir, 'Code workspace 2'), 'Do not overwrite this file');
  const tree = await projects.loadProject(ctx, project.id);
  assert.equal(tree.workspaces.find(row => row.id === top.id).name, 'Code workspace 3');
  assert.equal(tree.workspaces.find(row => row.id === other.id).name, 'Code workspace');
  assert.equal(fs.readFileSync(path.join(project.dir, 'Code workspace 2'), 'utf8'), 'Do not overwrite this file');
});

test('registered and unregistered actual code repositories never expose or modify workspace-looking source files', async () => {
  const project = await legacyProject(ctx, 'Real source');
  const parent = await projects.createWorkspace(ctx, project.id, { name: 'Parent', createDefault: true });
  const repo = repositories.resolve(ctx, project.id, parent.id);
  const fake = workspace(repo.directory, { context: [{ id: randomUUID(), name: 'Source data', children: [] }] });
  workspace(path.join(repo.directory, 'Child')); workspace(path.join(repo.directory, 'CODE'));
  const sourceMeta = fs.readFileSync(path.join(repo.directory, 'meta.json'), 'utf8');
  // A root repository that is not registered yet is still source, not a workspace.
  const unregistered = path.join(project.dir, 'CODE'); fs.mkdirSync(unregistered); git(unregistered, 'init', '-q');
  const fakeRoot = workspace(unregistered); workspace(path.join(unregistered, 'Code'));
  assert.deepEqual(codeWorkspaces.inspect(project.dir), { workspaces: [], conflicts: [] });
  assert.equal(migrateProjectDir(project.dir), null, 'the older converter does not flatten source context');
  await repositories.ensure(ctx, project.id);
  assert.deepEqual(projects.flattenWorkspaces(project.dir).map(row => row.id), [parent.id]);
  assert.equal(fs.readFileSync(path.join(repo.directory, 'meta.json'), 'utf8'), sourceMeta);
  assert.equal(readJson(path.join(unregistered, 'meta.json')).id, fakeRoot.id);
  assert.ok(fs.existsSync(path.join(repo.directory, 'CODE/workspace.md')));
  const catalog = readJson(path.join(project.dir, '.context/catalog.json'));
  assert.ok(!catalog.workspaces.some(row => [fake.id, fakeRoot.id].includes(row.id)));
});

test('ambiguous Code metadata preserves the tree and reports a durable actionable conflict', async () => {
  const project = await legacyProject(ctx, 'Ambiguous Code');
  const dir = path.join(project.dir, 'Code'); fs.mkdirSync(dir);
  writeJson(path.join(dir, 'meta.json'), { id: randomUUID(), status: 'open' }); // lost/missing document, not safe to infer
  const bytes = fs.readFileSync(path.join(dir, 'meta.json'), 'utf8');
  assert.equal(migrateProjectDir(project.dir).deferred, true);
  await assert.rejects(projects.loadProject(ctx, project.id), { code: 'WORKSPACE_NAME_CONFLICT' });
  const migration = readJson(path.join(project.dir, 'project.json')).workspaceNameMigration;
  assert.equal(migration.status, 'needs-attention'); assert.equal(migration.conflicts[0].path, dir);
  assert.match(migration.conflicts[0].message, /files were preserved/);
  assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'), bytes);
  assert.equal(fs.existsSync(path.join(project.dir, 'Code workspace')), false);
  // Restoring the missing document is an explicit repair; a later load retries.
  fs.writeFileSync(path.join(dir, 'workspace.md'), 'Recovered document');
  await repositories.ensure(ctx, project.id);
  assert.equal(readJson(path.join(project.dir, 'project.json')).workspaceNameMigration.status, 'complete');
});

test('repository records conflicting with a prior workspace catalog are not silently renamed or reclassified', async () => {
  const project = await legacyProject(ctx, 'Conflicting records');
  const source = workspace(path.join(project.dir, 'Code')); git(source.dir, 'init', '-q');
  const repo = await repositories.register(ctx, project, source.dir);
  fs.mkdirSync(path.join(project.dir, '.context'), { recursive: true });
  writeJson(path.join(project.dir, '.context/catalog.json'), { workspaces: [{ id: source.id, path: 'Code' }] });
  await require('../src/main/context/catalog.cjs').writeCatalogs(ctx);
  assert.equal(readJson(path.join(project.dir, '.context/catalog.json')).workspaces[0].id, source.id, 'a background rebuild before migration cannot erase evidence either');
  await assert.rejects(repositories.ensure(ctx, project.id), { code: 'WORKSPACE_NAME_CONFLICT' });
  await require('../src/main/context/catalog.cjs').writeCatalogs(ctx);
  await assert.rejects(repositories.ensure(ctx, project.id), { code: 'WORKSPACE_NAME_CONFLICT' }, 'rebuilding the catalog cannot erase a recorded conflict');
  assert.equal(repositories.registry(project)[repo.id].location, 'Code');
  assert.ok(fs.existsSync(path.join(source.dir, '.git')));
});

test('busy compatibility renames move nothing and retry through the existing relocation safeguards', async () => {
  const project = await legacyProject(ctx, 'Busy Code'), top = workspace(path.join(project.dir, 'Code'));
  ctx.repositoryBusy = () => 'Close the active terminal before moving';
  try { await assert.rejects(repositories.ensure(ctx, project.id), { code: 'REPOSITORY_BUSY' }); }
  finally { ctx.repositoryBusy = null; }
  assert.ok(fs.existsSync(top.dir));
  assert.equal(projects.findWorkspace(ctx, project.id, top.id).workspace.name, 'Code', 'genuine legacy documents remain identifiable while waiting');
  await repositories.ensure(ctx, project.id);
  assert.equal(projects.findWorkspace(ctx, project.id, top.id).workspace.name, 'Code workspace');
});

test('unregistered code repositories with linked worktrees also prevent compatibility relocation', async () => {
  const project = await legacyProject(ctx, 'Unregistered worktree'), top = workspace(path.join(project.dir, 'Code'));
  const source = path.join(top.dir, 'code'); fs.mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main'); git(source, 'commit', '--allow-empty', '-qm', 'Original');
  const linked = path.join(homeDir, 'linked-review'); git(source, 'worktree', 'add', '-qb', 'review', linked);
  await assert.rejects(repositories.ensure(ctx, project.id), /Close Git worktrees/);
  assert.ok(fs.existsSync(top.dir)); assert.equal(git(linked, 'rev-parse', 'HEAD'), git(source, 'rev-parse', 'HEAD'));
  git(source, 'worktree', 'remove', linked);
  await repositories.ensure(ctx, project.id);
  assert.equal(projects.findWorkspace(ctx, project.id, top.id).workspace.name, 'Code workspace');
});

test('an interrupted compatibility relocation completes path updates before marking migration complete', async () => {
  const project = await legacyProject(ctx, 'Interrupted Code'), top = workspace(path.join(project.dir, 'Code'));
  const repo = await repository(project, top);
  const update = ctx.libraryDb.updateRepo;
  ctx.libraryDb.updateRepo = async () => { throw new Error('Simulated interruption'); };
  try { await assert.rejects(repositories.ensure(ctx, project.id), /Simulated interruption/); }
  finally { ctx.libraryDb.updateRepo = update; }
  assert.ok(fs.existsSync(path.join(project.dir, '.repository-relocation.json')));
  assert.equal(readJson(path.join(project.dir, 'project.json')).workspaceNameMigration.status, 'needs-attention');
  await repositories.ensure(ctx, project.id); await repositories.ensure(ctx, project.id);
  const target = path.join(project.dir, 'Code workspace', 'code');
  assert.equal((await ctx.libraryDb.get(repo.libraryId)).folder_path, target);
  assert.equal(repositories.resolve(ctx, project.id, top.id).repoId, repo.id);
  assert.equal(git(target, 'rev-parse', 'HEAD'), repo.head);
  assert.equal(fs.existsSync(path.join(project.dir, '.repository-relocation.json')), false);
  assert.equal(readJson(path.join(project.dir, 'project.json')).workspaceNameMigration.status, 'complete');
});

test('a journal interrupted before the filesystem rename resumes to its original chosen destination', async () => {
  const project = await legacyProject(ctx, 'Intent recovery'), top = workspace(path.join(project.dir, 'CODE'));
  const repo = await repository(project, top);
  const to = path.join(project.dir, 'Code workspace');
  writeJson(path.join(project.dir, '.repository-relocation.json'), { version: 1, from: top.dir, to, projectFrom: project.dir, at: new Date().toISOString(), heads: [{ repoId: repo.id, head: repo.head }] });
  await repositories.ensure(ctx, project.id); await repositories.ensure(ctx, project.id);
  assert.equal(projects.findWorkspace(ctx, project.id, top.id).workspace.dir, to);
  assert.equal(repositories.registry(project)[repo.id].location, 'Code workspace/code');
  assert.equal(fs.existsSync(path.join(project.dir, 'Code workspace 2')), false);
});

test('the older goal/topic converter defers a genuine Code topic to safe relocation', async () => {
  const project = await legacyProject(ctx, 'Goal compatibility');
  const goal = path.join(project.dir, 'Goal'); fs.mkdirSync(goal);
  writeJson(path.join(goal, 'meta.json'), { id: randomUUID(), box: 'current' });
  const top = workspace(path.join(goal, 'Code'));
  const repo = await repository(project, top);
  const report = migrateProjectDir(project.dir);
  assert.equal(report.deferred, true);
  assert.ok(fs.existsSync(top.dir));
  await repositories.ensure(ctx, project.id);
  assert.equal(projects.findWorkspace(ctx, project.id, top.id).workspace.name, 'Code workspace');
  assert.equal(repositories.resolve(ctx, project.id, top.id).directory, path.join(project.dir, 'Code workspace/code'));
  assert.equal((await ctx.libraryDb.get(repo.libraryId)).folder_path, path.join(project.dir, 'Code workspace/code'));
  assert.equal(git(path.join(project.dir, 'Code workspace/code'), 'rev-parse', 'HEAD'), repo.head);
});

test('a Code child within an old goal topic follows the topic promotion without losing repository paths', async () => {
  const project = await legacyProject(ctx, 'Deep goal compatibility');
  const goal = path.join(project.dir, 'Goal'); fs.mkdirSync(goal);
  writeJson(path.join(goal, 'meta.json'), { id: randomUUID(), box: 'current' });
  const topic = workspace(path.join(goal, 'Topic'));
  const child = workspace(path.join(topic.dir, 'CODE'));
  const repo = await repository(project, child);
  await projects.loadProject(ctx, project.id);
  const result = projects.flattenWorkspaces(project.dir);
  assert.equal(result.find(row => row.id === topic.id).path, 'Topic');
  assert.equal(result.find(row => row.id === child.id).path, 'Topic/Code workspace');
  assert.equal((await ctx.libraryDb.get(repo.libraryId)).folder_path, path.join(project.dir, 'Topic/Code workspace/code'));
});
