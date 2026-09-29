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
const repos = require('../src/main/store/workspace-repositories.cjs');
const catalog = require('../src/main/context/catalog.cjs');
const builds = require('../src/main/build/store.cjs');
const local = require('../src/main/local-preview/files.cjs');
const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-workspace-repos-')));
const layout = ensureHome(homeDir);
let ctx;
test.before(async () => { ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => db.closeAll());
const sh = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
function gitRepo(name) { const dir = path.resolve(homeDir, name); fs.mkdirSync(dir, { recursive: true }); sh(dir, 'init', '-q', '-b', 'main'); sh(dir, 'commit', '--allow-empty', '-qm', 'Initial'); return dir; }
async function scene(name) { const project = await projects.createProject(ctx, name); const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Workspace', createDefault: true }); return { project, workspace }; }
function legacy(name, { directory = null } = {}) {
  const dir = path.join(ctx.dataRoot, name), id = randomUUID(), wid = randomUUID();
  fs.mkdirSync(path.join(dir, 'Workspace'), { recursive: true });
  writeJson(path.join(dir, 'project.json'), { id, name, custom: { preserve: true }, ...(directory ? { directory } : {}) });
  writeJson(path.join(dir, 'Workspace', 'meta.json'), { id: wid, status: 'open', custom: 'keep', context: [], archives: [] });
  fs.writeFileSync(path.join(dir, 'Workspace', 'workspace.md'), 'My document');
  return { id, dir, wid };
}

test('optional repository, first commit, nested isolation, library IDs and rebuildable catalog', async () => {
  const { project, workspace } = await scene('Default');
  const parent = repos.resolve(ctx, project.id, workspace.id);
  assert.equal(parent.displayPath, 'code/');
  assert.equal(parent.location, 'Workspace/code');
  assert.notEqual(parent.repoId, parent.libraryId);
  assert.ok(sh(parent.directory, 'rev-parse', 'HEAD'));
  assert.equal(sh(parent.directory, 'status', '--porcelain'), '');
  const child = await projects.createWorkspace(ctx, project.id, { name: 'Child', parentId: workspace.id, createDefault: true });
  const grand = await projects.createWorkspace(ctx, project.id, { name: 'Grand', parentId: child.id, createDefault: true });
  assert.notEqual(repos.resolve(ctx, project.id, child.id).repoId, parent.repoId);
  // Artifact files that happen to have Engelbart-looking metadata are not workspaces.
  writeJson(path.join(parent.directory, 'meta.json'), { id: randomUUID(), status: 'open' });
  const nested = path.join(parent.directory, 'Fake'); fs.mkdirSync(nested); writeJson(path.join(nested, 'meta.json'), { id: randomUUID(), status: 'open' });
  assert.equal(projects.flattenWorkspaces(project.dir).length, 3);
  await catalog.writeCatalogs(ctx);
  const file = path.join(project.dir, '.context', 'catalog.json'), first = readJson(file);
  assert.equal(first.version, 4);
  assert.equal(first.repositories.length, 4);
  assert.equal(first.repositories.find(repo => repo.id === grand.repoId).workspaces[0].path, 'Workspace/Child/Grand');
  assert.ok(first.entries.some(row => row.id === parent.libraryId));
  fs.unlinkSync(file); await catalog.writeCatalogs(ctx);
  assert.deepEqual(readJson(file).repositories, first.repositories);
});

test('supplied project repository and explicit workspace repositories are deduped, never committed or moved', async () => {
  const code = gitRepo('external'); fs.writeFileSync(path.join(code, 'untracked.txt'), 'Keep me');
  sh(code, 'remote', 'add', 'origin', 'git@github.com:example/interface.git');
  const head = sh(code, 'rev-parse', 'HEAD');
  const created = await projects.createProjectWithWelcome(ctx, { name: 'External', directory: code });
  const first = repos.resolve(ctx, created.project.id, created.workspaceId);
  assert.equal(first.directory, code); assert.equal(first.managed, false);
  assert.equal(first.githubUrl, 'https://github.com/example/interface');
  const child = await projects.createWorkspace(ctx, created.project.id, { name: 'Separate', createDefault: true });
  const previous = repos.resolve(ctx, created.project.id, child.id);
  assert.notEqual(previous.repoId, first.repoId);
  await repos.connect(ctx, created.project.id, child.id, { directory: code });
  assert.equal(repos.resolve(ctx, created.project.id, child.id).repoId, first.repoId);
  assert.ok(fs.existsSync(previous.directory));
  assert.equal(Object.keys(repos.registry(created.project)).length, 2);
  assert.equal(sh(code, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(code, 'status', '--porcelain'), '?? untracked.txt');
  await projects.unlinkFromWorkspace(ctx, created.project.id, child.id, first.libraryId);
  assert.equal(repos.resolve(ctx, created.project.id, child.id).repoId, first.repoId);
  assert.throws(() => repos.resolve(ctx, created.project.id, null), /Choose a workspace/);
});

test('legacy project directory registers in place and unavailable targets never fall back', async () => {
  const code = gitRepo('legacy-external'), prior = legacy('legacy', { directory: code });
  await repos.ensure(ctx, prior.id);
  const repo = repos.resolve(ctx, prior.id, prior.wid);
  assert.equal(repo.directory, code);
  assert.equal(repo.inherited, true);
  assert.equal(readJson(path.join(prior.dir, 'Workspace', 'meta.json')).repoId, null);
  assert.deepEqual(readJson(path.join(prior.dir, 'project.json')).custom, { preserve: true });
  assert.equal(readJson(path.join(prior.dir, 'Workspace', 'meta.json')).custom, 'keep');
  await repos.ensure(ctx, prior.id);
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).repoId, repo.repoId);
  fs.renameSync(code, code + '-unavailable');
  assert.throws(() => repos.resolve(ctx, prior.id, prior.wid), /unavailable.*Reconnect/i);
  assert.equal(fs.existsSync(path.join(prior.dir, 'Workspace', 'code')), false);
});

async function legacyApp(name, external = null) {
  const prior = legacy(name, { directory: external });
  const app = path.join(ctx.dataRoot, '.local-apps', prior.id, prior.wid, 'app');
  fs.mkdirSync(app, { recursive: true }); sh(app, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(app, 'index.html'), '<h1>Saved interface</h1>');
  writeJson(path.join(app, 'engelbart-preview.json'), { version: 1, kind: 'interface', command: 'node server.cjs {port}', cwd: '.', name: 'Saved interface' });
  sh(app, 'add', '.'); sh(app, 'commit', '-qm', 'Original interface');
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Saved interface', type: 'folder', tags: ['git'], folder_path: app });
  const stateFile = path.join(path.dirname(app), 'state.json');
  writeJson(stateFile, { id: `${prior.id}:${prior.wid}`, projectId: prior.id, workspaceId: prior.wid, directory: app, libraryId: row.id, name: 'Saved interface', recipe: { command: 'node server.cjs {port}' }, logs: ['history'], runId: 'old-run', status: 'stopped' });
  return { ...prior, app, stateFile, row };
}

test('unambiguous local app migration keeps source in place, Git, recipe, library and preview identity', async () => {
  const prior = await legacyApp('local-app');
  const head = sh(prior.app, 'rev-parse', 'HEAD');
  await repos.ensure(ctx, prior.id);
  const repo = repos.resolve(ctx, prior.id, prior.wid);
  assert.equal(repo.directory, prior.app);
  assert.equal(sh(repo.directory, 'rev-parse', 'HEAD'), head);
  assert.equal(repo.libraryId, prior.row.id);
  assert.equal((await ctx.libraryDb.get(prior.row.id)).folder_path, repo.directory);
  assert.equal(readJson(prior.stateFile).repoId, repo.repoId);
  assert.deepEqual(readJson(prior.stateFile).logs, ['history']);
  assert.equal(local.locations(ctx, prior.id, prior.wid).directory, repo.directory);
  const next = gitRepo('other-interface-target');
  await repos.connect(ctx, prior.id, prior.wid, { directory: next });
  await repos.ensure(ctx, prior.id);
  assert.equal(local.locations(ctx, prior.id, prior.wid).directory, repo.directory, 'saved interface does not follow connection changes');
  assert.equal(fs.existsSync(prior.app), true);
});

test('two workspace repositories remain ambiguous while the project repository is only a fallback', async () => {
  const external = gitRepo('conflict-external'), prior = await legacyApp('conflict', external);
  const code = gitRepo(path.join(prior.dir, 'Workspace', 'code')); fs.writeFileSync(path.join(code, 'precious'), 'untouched');
  const heads = [sh(code, 'rev-parse', 'HEAD'), sh(prior.app, 'rev-parse', 'HEAD')];
  await repos.ensure(ctx, prior.id); await repos.ensure(ctx, prior.id);
  assert.throws(() => repos.resolve(ctx, prior.id, prior.wid), /Several workspace repositories/);
  const described = repos.describe(ctx, prior.id, prior.wid);
  assert.deepEqual(described.issue.candidates, [prior.app, code]);
  assert.ok(described.issue.candidates.every(directory => described.repositories.some(repo => repo.directory === directory)), 'all candidates are selectable through the existing repository chooser');
  assert.equal(described.defaultRepository.location, external);
  assert.ok(fs.existsSync(prior.app)); assert.ok(fs.existsSync(external));
  assert.equal(fs.readFileSync(path.join(code, 'precious'), 'utf8'), 'untouched');
  assert.deepEqual([sh(code, 'rev-parse', 'HEAD'), sh(prior.app, 'rev-parse', 'HEAD')], heads);
  assert.equal(readJson(path.join(prior.dir, 'project.json')).repositoryMigration.status, 'needs-selection');
  await repos.connect(ctx, prior.id, prior.wid, { directory: prior.app });
  await repos.ensure(ctx, prior.id);
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).directory, prior.app);
  assert.equal(readJson(path.join(prior.dir, 'project.json')).repositoryMigration.status, 'complete');
});

test('nested relocation updates disconnected repositories, libraries, Build history and preview references', async () => {
  const { project, workspace } = await scene('Relocate');
  const child = await projects.createWorkspace(ctx, project.id, { parentId: workspace.id, name: 'Child', createDefault: true });
  const previous = repos.resolve(ctx, project.id, child.id);
  await repos.connect(ctx, project.id, child.id, { directory: gitRepo('relocate-external') });
  builds.writeTask(project, { id: 'aabbccdd00', projectId: project.id, workspaceId: child.id, repoId: previous.repoId, repo: previous.directory, sourceDirectory: previous.directory, worktree: path.join(ctx.dataRoot, 'worktrees', 'gone'), cwd: path.join(ctx.dataRoot, 'worktrees', 'gone'), status: 'accepted', messages: [{ role: 'agent', text: 'keep transcript' }], preview: { directory: previous.directory } });
  await projects.renameWorkspace(ctx, project.id, workspace.id, 'Renamed');
  const updated = repos.registry(project)[previous.repoId];
  assert.equal(updated.location, 'Renamed/Child/code');
  assert.equal((await ctx.libraryDb.get(previous.libraryId)).folder_path, path.join(project.dir, updated.location));
  assert.equal(builds.readTask(project, 'aabbccdd00').repo, path.join(project.dir, updated.location));
  const target = await projects.createWorkspace(ctx, project.id, { name: 'Target' });
  await projects.moveWorkspace(ctx, project.id, workspace.id, target.id);
  assert.equal(repos.registry(project)[previous.repoId].location, 'Target/Renamed/Child/code');
  const renamed = await projects.renameProject(ctx, project.id, 'Moved project');
  assert.ok(fs.existsSync(path.join(renamed.dir, 'Target/Renamed/Child/code/.git')));
  assert.equal(builds.readTask(renamed, 'aabbccdd00').preview.directory, path.join(renamed.dir, 'Target/Renamed/Child/code'));
});

test('busy moves and shared-contained deletion fail before files move; safe deletion retains repositories in trash', async () => {
  const { project, workspace } = await scene('Trash');
  const repo = repos.resolve(ctx, project.id, workspace.id);
  const other = await projects.createWorkspace(ctx, project.id, { name: 'Consumer', repoId: repo.repoId });
  await assert.rejects(projects.deleteWorkspace(ctx, project.id, workspace.id), /Consumer.*uses a repository/);
  assert.ok(fs.existsSync(repo.directory));
  ctx.repositoryBusy = () => 'Terminal is busy';
  await assert.rejects(projects.renameWorkspace(ctx, project.id, workspace.id, 'Cannot move'), /Terminal is busy/);
  assert.ok(fs.existsSync(repo.directory)); ctx.repositoryBusy = null;
  const external = gitRepo('trash-external');
  await repos.connect(ctx, project.id, other.id, { directory: external });
  builds.writeTask(project, { id: 'aabbccdd11', projectId: project.id, workspaceId: workspace.id, repoId: repo.repoId, repo: repo.directory, worktree: '/nonexistent/worktree', status: 'review', title: 'Unfinished' });
  await assert.rejects(projects.deleteWorkspace(ctx, project.id, workspace.id), /Finish or discard Build/);
  builds.writeTask(project, { ...builds.readTask(project, 'aabbccdd11'), status: 'discarded' });
  const deleted = await projects.deleteWorkspace(ctx, project.id, workspace.id);
  assert.ok(fs.existsSync(path.join(deleted.trashPath, 'code/.git')));
  assert.ok(readJson(path.join(deleted.trashPath, '.workspace-recovery.json')));
  assert.equal(repos.registry(project)[repo.repoId].archived, true);
  assert.ok(fs.existsSync(external));
  await projects.restoreWorkspace(ctx, project.id, workspace.id);
  assert.equal(repos.resolve(ctx, project.id, workspace.id).repoId, repo.repoId);
  assert.ok(fs.existsSync(repo.directory));
});

test('unfinished Git worktrees and a pending launch block relocation without touching source files', async () => {
  const { project, workspace } = await scene('Busy');
  const repo = repos.resolve(ctx, project.id, workspace.id);
  const release = repos.lease(ctx, project.id);
  await assert.rejects(projects.renameWorkspace(ctx, project.id, workspace.id, 'Changed'), /Work is starting/);
  release();
  const copy = path.join(homeDir, 'busy-worktree'); sh(repo.directory, 'worktree', 'add', '-qb', 'test-copy', copy);
  await assert.rejects(projects.renameWorkspace(ctx, project.id, workspace.id, 'Changed'), /Close Git worktrees/);
  assert.ok(fs.existsSync(repo.directory));
  sh(repo.directory, 'worktree', 'remove', copy);
  await projects.renameWorkspace(ctx, project.id, workspace.id, 'Changed');
  assert.ok(repos.resolve(ctx, project.id, workspace.id).directory.endsWith('/Changed/code'));
});

test('location-scoped leases protect affected work and shared repositories without blocking unrelated moves', async t => {
  const { project, workspace } = await scene('Scoped leases');
  const other = await projects.createWorkspace(ctx, project.id, { name: 'Other', createDefault: true });
  const otherRepo = repos.resolve(ctx, project.id, other.id);
  const working = repos.lease(ctx, project.id, otherRepo.directory, { workspaceId: other.id });
  t.after(working);
  await projects.renameWorkspace(ctx, project.id, workspace.id, 'Safe to rename');
  await assert.rejects(projects.renameWorkspace(ctx, project.id, other.id, 'Busy workspace'), /Work is starting/);
  await assert.rejects(projects.renameProject(ctx, project.id, 'Busy project'), /Work is starting/);
  working();

  // Session cwd is independent, even when its UI lives in the moved workspace.
  const terminal = repos.lease(ctx, project.id, homeDir, { independent: true, workspaceId: workspace.id });
  t.after(terminal);
  await projects.renameWorkspace(ctx, project.id, workspace.id, 'Independent terminal');
  terminal();
  const dependentTerminal = repos.lease(ctx, 'another-project', otherRepo.directory, { independent: true });
  t.after(dependentTerminal);
  await assert.rejects(projects.renameWorkspace(ctx, project.id, other.id, 'Busy terminal'), /Work is starting/);
  dependentTerminal();

  const shared = await projects.createProject(ctx, { name: 'Shared lease owner', directory: otherRepo.directory });
  const sharedSpace = await projects.createWorkspace(ctx, shared.id, { name: 'Question' });
  const bart = repos.lease(ctx, shared.id, otherRepo.directory, { workspaceId: sharedSpace.id });
  t.after(bart);
  await assert.rejects(projects.renameWorkspace(ctx, project.id, other.id, 'Busy shared repository'), /Work is starting/);
  bart();
  // Bart may read a repository as Context without using it as its working repo.
  const source = repos.lease(ctx, shared.id, repos.resolve(ctx, project.id, workspace.id).directory, { workspaceId: sharedSpace.id, paths: [otherRepo.directory] });
  t.after(source);
  await assert.rejects(projects.renameWorkspace(ctx, project.id, other.id, 'Busy context source'), /Work is starting/);
  source();
  await projects.renameWorkspace(ctx, project.id, other.id, 'Now available');
});

test('relocation fence rejects new affected starts while allowing independent terminal starts', async t => {
  const { project, workspace } = await scene('Relocation fence');
  const repo = repos.resolve(ctx, project.id, workspace.id);
  let began, finish;
  const entered = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const previousBusy = ctx.repositoryBusy;
  ctx.repositoryBusy = async () => { began(); await gate; return null; };
  t.after(() => { finish(); ctx.repositoryBusy = previousBusy; });
  const moving = projects.renameWorkspace(ctx, project.id, workspace.id, 'Moved safely');
  await entered;
  assert.throws(() => repos.lease(ctx, project.id, repo.directory, { workspaceId: workspace.id }), /moving/);
  assert.throws(() => repos.lease(ctx, 'other', repo.directory, { independent: true }), /moving/);
  const independent = repos.lease(ctx, project.id, homeDir, { independent: true });
  independent();
  finish(); await moving;
});

test('interrupted provisioning creates only an empty first commit, leaving user files untracked', async () => {
  const prior = legacy('interrupted-init'), code = path.join(prior.dir, 'Workspace', 'code');
  writeJson(path.join(prior.dir, 'Workspace', '.repository-init.json'), { directory: code, repoName: 'Recovered code' });
  fs.mkdirSync(code); sh(code, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(code, 'user.txt'), 'Not yours to commit');
  fs.writeFileSync(path.join(code, 'staged.txt'), 'Preserve the index too');
  sh(code, 'add', 'staged.txt');
  await repos.ensure(ctx, prior.id);
  assert.ok(sh(code, 'rev-parse', '--verify', 'HEAD'));
  assert.equal(sh(code, 'status', '--porcelain'), 'A  staged.txt\n?? user.txt');
  assert.equal(sh(code, 'ls-tree', '-r', 'HEAD'), '', 'the first commit contains no user files');
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).location, 'Workspace/code');
});

test('an existing workspace code/ repository is reused with its Git history, files, and identities', async () => {
  const prior = legacy('occupied-git'), code = path.join(prior.dir, 'Workspace', 'code');
  fs.mkdirSync(code); sh(code, 'init', '-q', '-b', 'main'); sh(code, 'commit', '--allow-empty', '-qm', 'Existing work');
  fs.writeFileSync(path.join(code, 'dirty.txt'), 'Preserve this');
  const registered = await repos.register(ctx, projects.findProject(ctx, prior.id), code);
  const workspaceFile = path.join(prior.dir, 'Workspace/meta.json'), projectFile = path.join(prior.dir, 'project.json');
  writeJson(workspaceFile, { ...readJson(workspaceFile), schemaVersion: 3, repoId: null, repositoryIssue: { code: 'REPOSITORY_CONFLICT', message: 'code/ is occupied', candidates: [code] } });
  writeJson(projectFile, { ...readJson(projectFile), repositoryMigration: { version: 1, status: 'complete' }, repositoryDefaultsMigration: { version: 1, status: 'needs-selection', issue: { message: 'Choose a project default' } } });
  const head = sh(code, 'rev-parse', 'HEAD');
  await repos.ensure(ctx, prior.id); await repos.ensure(ctx, prior.id);
  const resolved = repos.resolve(ctx, prior.id, prior.wid);
  assert.equal(resolved.repoId, registered.id); assert.equal(resolved.libraryId, registered.libraryId);
  assert.equal(resolved.inherited, false); assert.equal(resolved.directory, code);
  assert.equal(repos.describe(ctx, prior.id, prior.wid).issue, null);
  assert.equal(repos.describe(ctx, prior.id, prior.wid).defaultIssue, null);
  assert.equal(sh(code, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(code, 'status', '--porcelain'), '?? dirty.txt');
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).managed, false);
});

test('project repository plus one generated app preserves the app override and nested workspaces inherit', async () => {
  const external = gitRepo('fallback-external'), prior = await legacyApp('fallback-and-app', external);
  const childDir = path.join(prior.dir, 'Workspace', 'Child'), childId = randomUUID();
  fs.mkdirSync(childDir); writeJson(path.join(childDir, 'meta.json'), { id: childId, status: 'open' });
  fs.writeFileSync(path.join(childDir, 'workspace.md'), 'Nested document');
  const project = projects.findProject(ctx, prior.id);
  const registered = await repos.register(ctx, project, prior.app, { libraryId: prior.row.id });
  const historical = gitRepo('fallback-and-app-old-build');
  const task = builds.writeTask(project, { id: 'bb00112233', projectId: prior.id, workspaceId: prior.wid, repo: historical, worktree: '/missing/old-build', status: 'review', messages: [{ role: 'agent', text: 'Previous work' }], preview: { directory: '/missing/old-build', status: 'stopped' } });
  const state = readJson(prior.stateFile), head = sh(prior.app, 'rev-parse', 'HEAD');
  await repos.ensure(ctx, prior.id);
  const repo = repos.resolve(ctx, prior.id, prior.wid), child = repos.resolve(ctx, prior.id, childId);
  assert.equal(repo.directory, prior.app); assert.equal(repo.repoId, registered.id);
  assert.equal(repo.libraryId, prior.row.id); assert.equal(repo.inherited, false);
  assert.equal(child.directory, external); assert.equal(child.inherited, true);
  assert.equal(readJson(path.join(prior.dir, 'Workspace/meta.json')).repositoryIssue, null);
  assert.deepEqual(readJson(prior.stateFile), { ...state, repoId: repo.repoId, repositoryMigration: 1 });
  assert.equal(local.locations(ctx, prior.id, prior.wid).directory, prior.app);
  assert.equal(sh(prior.app, 'rev-parse', 'HEAD'), head);
  const savedTask = builds.readTask(project, task.id);
  assert.equal(savedTask.repo, historical); assert.equal(savedTask.worktree, task.worktree);
  assert.deepEqual(savedTask.messages, task.messages); assert.deepEqual(savedTask.preview, task.preview);
  assert.equal(fs.readFileSync(path.join(prior.app, 'index.html'), 'utf8'), '<h1>Saved interface</h1>');
  assert.equal(fs.existsSync(path.join(prior.dir, 'Workspace/code')), false);
  const index = readJson(path.join(prior.dir, '.context/catalog.json'));
  assert.equal(index.workspaces.find(row => row.id === prior.wid).repoId, repo.repoId);
  assert.equal(index.workspaces.find(row => row.id === childId).resolvedRepoId, child.repoId);
});

test('occupied non-repository code/ is untouched and neither competes with an app nor prevents inheritance', async () => {
  for (const app of [true, false]) {
    const external = gitRepo(`non-git-fallback-${app}`);
    const prior = app ? await legacyApp('non-git-with-app', external) : legacy('non-git-with-default', { directory: external });
    const code = path.join(prior.dir, 'Workspace/code'); fs.mkdirSync(code);
    fs.writeFileSync(path.join(code, 'precious.txt'), 'Preserve my folder');
    await repos.ensure(ctx, prior.id); await repos.ensure(ctx, prior.id);
    assert.equal(repos.resolve(ctx, prior.id, prior.wid).directory, app ? prior.app : external);
    assert.equal(repos.resolve(ctx, prior.id, prior.wid).inherited, !app);
    assert.deepEqual(fs.readdirSync(code), ['precious.txt']);
    assert.equal(fs.readFileSync(path.join(code, 'precious.txt'), 'utf8'), 'Preserve my folder');
    assert.ok(!Object.values(repos.registry(prior)).some(repo => repos.absolute(prior, repo) === code));
  }
});

test('stale issues are reevaluated after completed migration, and stay cleared after reopening', async () => {
  const external = gitRepo('stale-fallback'), prior = await legacyApp('stale-issues', external);
  const project = projects.findProject(ctx, prior.id);
  const fallback = await repos.register(ctx, project, external), app = await repos.register(ctx, project, prior.app, { libraryId: prior.row.id });
  const projectFile = path.join(prior.dir, 'project.json'), workspaceFile = path.join(prior.dir, 'Workspace/meta.json');
  writeJson(projectFile, { ...readJson(projectFile), schemaVersion: 3, defaultRepoId: fallback.id, repositoryMigration: { version: 1, status: 'complete' }, repositoryDefaultsMigration: { version: 1, status: 'complete', issue: null } });
  writeJson(workspaceFile, { ...readJson(workspaceFile), schemaVersion: 3, repoId: null, repositoryIssue: { code: 'REPOSITORY_CONFLICT', message: 'Several repositories may belong', candidates: [external, prior.app] } });
  const inheritedDir = path.join(prior.dir, 'Workspace/Child'), inheritedId = randomUUID();
  fs.mkdirSync(inheritedDir); fs.writeFileSync(path.join(inheritedDir, 'workspace.md'), 'Child');
  writeJson(path.join(inheritedDir, 'meta.json'), { id: inheritedId, schemaVersion: 3, repoId: null, repositoryIssue: { code: 'REPOSITORY_CONFLICT', message: 'Old conflict', candidates: [external] } });
  await projects.loadProject(ctx, prior.id);
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).repoId, app.id);
  assert.equal(repos.resolve(ctx, prior.id, inheritedId).inherited, true);
  assert.equal(readJson(workspaceFile).repositoryIssue, null);
  assert.equal(readJson(path.join(inheritedDir, 'meta.json')).repositoryIssue, null);
  const files = [projectFile, workspaceFile, path.join(inheritedDir, 'meta.json'), prior.stateFile, path.join(prior.dir, '.context/catalog.json')];
  const before = files.map(file => fs.readFileSync(file, 'utf8'));
  const rows = await ctx.libraryDb.list();
  await repos.ensure(ctx, prior.id);
  await db.closeAll(); ctx = { ...ctx, libraryDb: await db.openLibraryDb(layout.testRoot) };
  await projects.loadProject(ctx, prior.id); await repos.ensure(ctx, prior.id);
  assert.deepEqual(files.map(file => fs.readFileSync(file, 'utf8')), before);
  assert.deepEqual(await ctx.libraryDb.list(), rows);
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).repoId, app.id);
  assert.equal(local.locations(ctx, prior.id, prior.wid).directory, prior.app);
});

test('explicit connections win over new candidates and stale issues, including unavailable overrides', async () => {
  for (const missing of ['no', 'path', 'id', 'archived']) {
    const { project, workspace } = await scene(`Explicit-${missing}`), held = repos.resolve(ctx, project.id, workspace.id);
    const file = path.join(project.dir, 'Workspace/meta.json');
    if (missing === 'path') fs.renameSync(held.directory, held.directory + '-missing');
    const id = missing === 'id' ? randomUUID() : held.repoId;
    if (missing === 'archived') {
      const file = path.join(project.dir, 'project.json'), meta = readJson(file);
      meta.repositories[id].archived = true; writeJson(file, meta);
    }
    const meta = { ...readJson(file), repoId: id, repositoryIssue: { code: 'REPOSITORY_CONFLICT', message: 'Old ambiguity', candidates: [held.directory] } };
    writeJson(file, meta);
    await repos.ensure(ctx, project.id); await repos.ensure(ctx, project.id);
    assert.deepEqual(readJson(file), { ...meta, repositoryIssue: null });
    if (missing === 'no') assert.equal(repos.resolve(ctx, project.id, workspace.id).repoId, id);
    else assert.throws(() => repos.resolve(ctx, project.id, workspace.id), /unavailable/i);
    assert.equal(repos.registry(project)[held.repoId].libraryId, held.libraryId);
  }
});

test('historical Builds preserve recorded targets without choosing a workspace connection or implicit default', async () => {
  for (const scenario of ['default', 'none', 'missing-project-code']) {
    const hasDefault = scenario === 'default';
    const external = hasDefault ? gitRepo('historical-project-fallback') : null;
    const prior = legacy(`historical-only-${scenario}`, { directory: external }), project = projects.findProject(ctx, prior.id);
    const old = gitRepo(scenario === 'missing-project-code' ? path.join(prior.dir, 'code') : `historical-target-${scenario}`), worktree = '/missing/recorded-worktree';
    const head = sh(old, 'rev-parse', 'HEAD');
    if (scenario === 'missing-project-code') fs.renameSync(old, old + '-preserved');
    const record = builds.writeTask(project, { id: 'aa00112233', projectId: prior.id, workspaceId: prior.wid, repo: old, worktree, cwd: worktree, status: 'accepted', messages: [{ role: 'agent', text: 'Original answer' }], checkpoints: [{ sha: head }], preview: { directory: old, url: 'http://127.0.0.1:31234', status: 'stopped' } });
    await repos.ensure(ctx, prior.id);
    assert.equal(readJson(path.join(prior.dir, 'Workspace/meta.json')).repoId, null);
    const task = builds.readTask(project, record.id);
    assert.ok(task.repoId); assert.equal(task.sourceDirectory, old);
    for (const [key, value] of Object.entries(record)) if (key !== 'updated') assert.deepEqual(task[key], value, key);
    if (hasDefault) assert.equal(repos.resolve(ctx, prior.id, prior.wid).directory, external);
    else {
      assert.equal(readJson(path.join(prior.dir, 'project.json')).defaultRepoId, null);
      assert.throws(() => repos.resolve(ctx, prior.id, prior.wid), /Choose a project default/);
    }
    const before = fs.readFileSync(path.join(prior.dir, 'builds', record.id, 'task.json'), 'utf8');
    await repos.ensure(ctx, prior.id); await projects.loadProject(ctx, prior.id);
    assert.equal(fs.readFileSync(path.join(prior.dir, 'builds', record.id, 'task.json'), 'utf8'), before);
  }
});

test('interrupted relocation resumes idempotently from its journal', async () => {
  const { project, workspace } = await scene('Recovery');
  const repo = repos.resolve(ctx, project.id, workspace.id), from = path.dirname(repo.directory), to = path.join(project.dir, 'Recovered');
  writeJson(path.join(project.dir, '.repository-relocation.json'), { version: 1, from, to, projectFrom: project.dir, at: new Date().toISOString() });
  fs.renameSync(from, to); // simulate interruption immediately after rename
  await repos.ensure(ctx, project.id); await repos.ensure(ctx, project.id);
  assert.equal(repos.resolve(ctx, project.id, workspace.id).directory, path.join(to, 'code'));
  assert.equal((await ctx.libraryDb.get(repo.libraryId)).folder_path, path.join(to, 'code'));
  assert.equal(fs.existsSync(path.join(project.dir, '.repository-relocation.json')), false);
});

test('connections from another project follow relocation and prevent deletion from stranding their repository', async () => {
  const first = await scene('Cross-project owner');
  const repo = repos.resolve(ctx, first.project.id, first.workspace.id);
  const second = await scene('Cross-project consumer');
  await repos.connect(ctx, second.project.id, second.workspace.id, { directory: repo.directory });
  const otherRepo = repos.resolve(ctx, second.project.id, second.workspace.id);
  builds.writeTask(second.project, { id: 'aabbccdd22', projectId: second.project.id, workspaceId: second.workspace.id, repoId: otherRepo.repoId, repo: otherRepo.directory, sourceDirectory: otherRepo.directory, worktree: '/missing/final', status: 'accepted' });
  await assert.rejects(projects.deleteWorkspace(ctx, first.project.id, first.workspace.id), /uses a repository inside/);
  await projects.renameWorkspace(ctx, first.project.id, first.workspace.id, 'Renamed');
  const updated = repos.resolve(ctx, second.project.id, second.workspace.id);
  assert.equal(updated.repoId, otherRepo.repoId);
  assert.equal(updated.libraryId, repo.libraryId);
  assert.equal(updated.directory, path.join(first.project.dir, 'Renamed/code'));
  assert.equal(builds.readTask(second.project, 'aabbccdd22').repo, updated.directory);
  builds.writeTask(second.project, { ...builds.readTask(second.project, 'aabbccdd22'), status: 'review', title: 'Other project work' });
  await assert.rejects(projects.renameWorkspace(ctx, first.project.id, first.workspace.id, 'Cannot move'), /Finish or discard/);
});

test('partial project-rename reference updates recover the title, IDs and library path', async () => {
  const { project, workspace } = await scene('Partial project rename');
  const repo = repos.resolve(ctx, project.id, workspace.id), head = sh(repo.directory, 'rev-parse', 'HEAD');
  const update = ctx.libraryDb.updateRepo;
  ctx.libraryDb.updateRepo = async () => { throw new Error('Interrupted library update'); };
  try { await assert.rejects(projects.renameProject(ctx, project.id, 'Recovered project title'), /Interrupted library update/); }
  finally { ctx.libraryDb.updateRepo = update; }
  let moved = projects.findProject(ctx, project.id);
  assert.ok(fs.existsSync(path.join(moved.dir, '.repository-relocation.json')));
  await repos.ensure(ctx, project.id); await repos.ensure(ctx, project.id);
  moved = projects.findProject(ctx, project.id);
  const resolved = repos.resolve(ctx, project.id, workspace.id);
  assert.equal(moved.name, 'Recovered project title');
  assert.equal(resolved.repoId, repo.repoId);
  assert.equal(sh(resolved.directory, 'rev-parse', 'HEAD'), head);
  assert.equal((await ctx.libraryDb.get(repo.libraryId)).folder_path, resolved.directory);
  assert.equal(fs.existsSync(path.join(moved.dir, '.repository-relocation.json')), false);
});

test('interrupted deletion keeps recovery metadata and can be restored after the journal completes', async () => {
  const { project, workspace } = await scene('Partial deletion');
  const repo = repos.resolve(ctx, project.id, workspace.id);
  const update = ctx.libraryDb.updateRepo;
  ctx.libraryDb.updateRepo = async () => { throw new Error('Interrupted trash references'); };
  try { await assert.rejects(projects.deleteWorkspace(ctx, project.id, workspace.id), /Interrupted trash references/); }
  finally { ctx.libraryDb.updateRepo = update; }
  await repos.ensure(ctx, project.id);
  assert.equal(repos.registry(project)[repo.repoId].archived, true);
  const restored = await projects.restoreWorkspace(ctx, project.id, workspace.id);
  assert.equal(restored.id, workspace.id);
  assert.equal(repos.resolve(ctx, project.id, workspace.id).directory, repo.directory);
  assert.ok(fs.existsSync(path.join(repo.directory, '.git')));
});

test('a busy legacy interface is registered in place without relocating its running server', async () => {
  const prior = await legacyApp('busy-legacy-app');
  ctx.repositoryBusy = () => 'Stop the interface preview first';
  try { await repos.ensure(ctx, prior.id); }
  finally { ctx.repositoryBusy = null; }
  assert.ok(fs.existsSync(prior.app));
  assert.equal(readJson(prior.stateFile).directory, prior.app);
  assert.equal(repos.resolve(ctx, prior.id, prior.wid).directory, prior.app);
  await repos.ensure(ctx, prior.id); await repos.ensure(ctx, prior.id);
  const resolved = repos.resolve(ctx, prior.id, prior.wid);
  assert.equal(resolved.libraryId, prior.row.id);
  assert.equal(local.locations(ctx, prior.id, prior.wid).directory, resolved.directory);
  assert.equal(Object.keys(repos.registry(projects.findProject(ctx, prior.id))).length, 1);
});
