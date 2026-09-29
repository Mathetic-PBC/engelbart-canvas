'use strict';

// Connections are execution targets, NOT context attachments. All consumers of a
// new Build use resolve(); running work keeps the resolved identity/path.
// Interactive terminals select their own working directory independently.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readJson, writeJson, uniqueName } = require('./home.cjs');
const codeWorkspaces = require('./code-workspaces.cjs');
const { findGitDir } = require('../tools/repository.cjs');
const { createGit } = require('../build/git.cjs');
const { affectedBy } = require('./repository-activity.cjs');
const run = promisify(execFile);
const VERSION = 1;
const queues = new Map();
const moving = new Set();
const movingRoots = new Map();
const leases = new Set();
const operationKey = (ctx, pid) => `${ctx.dataRoot}:${pid}`;
function lease(ctx, pid, directory = null, { workspaceId = null, paths = [], independent = false } = {}) {
  const project = !independent && pid ? projects().findProject(ctx, pid) : null;
  const workspace = project && workspaceId ? projects().findWorkspace(ctx, pid, workspaceId).workspace : null;
  const held = { projectId: pid, workspaceId: independent ? null : workspaceId, unscoped: !directory && !workspaceId && !paths.length,
    paths: [...paths, project?.dir, workspace?.dir, ...(independent ? [directory] : [])].filter(Boolean), repositories: independent ? [] : [directory].filter(Boolean) };
  for (const scope of movingRoots.values()) if (affectedBy(scope, held)) throw fail('This folder or repository is moving. Try again when the move finishes.', 'REPOSITORY_BUSY');
  leases.add(held);
  return () => leases.delete(held);
}
const projects = () => require('./projects.cjs');
const gitFor = ctx => ctx.repositoryGit || createGit();
async function gitCommand(ctx, directory, args) {
  const result = await gitFor(ctx).exec(directory, args);
  if (result.code !== 0) throw fail(`Git could not prepare this repository: ${result.stderr.trim() || 'Install Git in Set Up Tools, then try again.'}`);
  return result.stdout.trim();
}
const canonical = file => {
  const value = path.resolve(file);
  try { return fs.realpathSync(value); }
  catch { const parent = path.dirname(value); return parent === value ? value : path.join(canonical(parent), path.basename(value)); }
};
const contains = (root, file) => { const a = canonical(root), b = canonical(file); return b === a || b.startsWith(a + path.sep); };
const rebase = (file, from, to) => contains(from, file) ? to + canonical(file).slice(canonical(from).length) : file;
const location = (root, file) => contains(root, file) ? path.relative(canonical(root), canonical(file)) || '.' : canonical(file);
function assertNotMovingPath(directory) {
  for (const { from, to } of movingRoots.values()) if (contains(from, directory) || contains(to, directory)) throw fail('This repository is moving. Try again when the move finishes.', 'REPOSITORY_BUSY');
}
const absolute = (project, repo) => path.resolve(project.dir, repo.location);
const metaFile = project => path.join(project.dir, 'project.json');
const metadata = project => readJson(metaFile(project)) || {};
const fail = (message, code = 'REPOSITORY_UNAVAILABLE') => Object.assign(new Error(message), { code });
const serial = (ctx, pid, work) => {
  const key = `${ctx.dataRoot}:${pid}`;
  const job = (queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
  queues.set(key, job);
  job.finally(() => { if (queues.get(key) === job) queues.delete(key); }).catch(() => {});
  return job;
};

function registry(project) { return metadata(project).repositories || {}; }
function existing(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('Choose an existing local Git repository.');
  const target = canonical(file), found = findGitDir(target);
  if (!found || canonical(found.top) !== target) throw fail('Choose the root of an existing Git repository. No files have been changed.');
  return target;
}
// Migration needs a repository rooted here, not an ancestor's Git checkout or
// an occupied source folder. Unborn repositories still have a HEAD file.
function repositoryAt(directory) {
  const git = findGitDir(directory);
  try { return !!git && canonical(git.top) === canonical(directory) && fs.statSync(directory).isDirectory() && fs.statSync(git.gitDir).isDirectory() && fs.statSync(path.join(git.gitDir, 'HEAD')).isFile(); }
  catch { return false; }
}
function github(directory) {
  try {
    const value = require('./library.cjs').readCloneRemote(directory);
    const remote = require('./library.cjs').canonicalRemote(value);
    return typeof remote === 'string' && /^https:\/\/github\.com\//.test(remote) ? remote : null;
  } catch { return null; }
}

async function register(ctx, project, directory, { managed = false, libraryId = null, name = null, autoName = null } = {}) {
  const target = canonical(directory);
  let meta = metadata(project), records = meta.repositories || {};
  let record = Object.values(records).find(repo => canonical(absolute(project, repo)) === target);
  if (record) return record;
  const rows = await ctx.libraryDb.list(), url = github(target);
  let row = rows.find(row => (libraryId && row.id === libraryId) || (row.folder_path && canonical(row.folder_path) === target) || (!row.folder_path && url && row.url?.toLowerCase() === url.toLowerCase()));
  if (!row) row = await ctx.libraryDb.insert({ id: randomUUID(), name: name || path.basename(target), type: 'folder', tags: ['git'], folder_path: target, url, project_id: project.id });
  else if (row.folder_path !== target) row = await ctx.libraryDb.updateRepo(row.id, { name: row.name, url: row.url || url, folder_path: target, github_id: row.github_id });
  record = { id: randomUUID(), name: name || row.name || path.basename(target), location: location(project.dir, target), managed, libraryId: row.id, archived: false, ...(autoName ? { autoName } : {}) };
  // Re-read after asynchronous DB work; preserve unrelated project metadata.
  meta = metadata(project);
  writeJson(metaFile(project), { ...meta, schemaVersion: Math.max(2, meta.schemaVersion || 0), repositories: { ...meta.repositories, [record.id]: record } });
  return record;
}

async function defaultRepository(ctx, project, owner = project) {
  const projectOwned = owner.id === project.id;
  const directory = path.join(owner.dir, 'code');
  const marker = path.join(owner.dir, '.repository-init.json');
  let intent = readJson(marker);
  if (!intent) {
    if (fs.existsSync(directory)) throw fail('code/ is already occupied. Choose its repository or connect another folder; nothing was overwritten.', 'REPOSITORY_CONFLICT');
    intent = { directory, repoName: projectOwned ? owner.name : `${owner.name} code`, started: new Date().toISOString() };
    writeJson(marker, intent);
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // This marker only belongs to a directory Engelbart created. Never stage any
  // user files, even when resuming provisioning after an interrupted launch.
  if (!fs.existsSync(path.join(directory, '.git'))) await gitCommand(ctx, directory, ['init', '--initial-branch=main', '.']);
  if ((await gitFor(ctx).exec(directory, ['rev-parse', '--verify', 'HEAD'])).code !== 0) {
    const tree = await gitCommand(ctx, directory, ['mktree']);
    const commit = await gitCommand(ctx, directory, ['-c', 'user.name=Engelbart', '-c', 'user.email=engelbart@localhost', '-c', 'commit.gpgSign=false', 'commit-tree', tree, '-m', 'Initialize workspace repository']);
    await gitCommand(ctx, directory, ['update-ref', 'HEAD', commit, '0'.repeat(commit.length)]);
  }
  // A project provisioning marker is always generated by Engelbart. Older
  // interrupted markers may still contain the former "<project> code" label.
  const name = projectOwned ? owner.name : intent.repoName;
  const repo = await register(ctx, project, directory, { managed: true, name, autoName: projectOwned ? { kind: 'project', value: name } : null });
  return repo;
}

// Only project-owned code/ repositories follow the project title. A repository
// chosen from elsewhere (even one with a matching name) is never relabelled.
// Keep the last generated name so a later custom label opts out. The pending
// name journals the small registry/library update across an interrupted write.
async function syncProjectRepositoryNames(ctx, project) {
  const save = repo => {
    const meta = metadata(project);
    writeJson(metaFile(project), { ...meta, repositories: { ...meta.repositories, [repo.id]: repo } });
    return repo;
  };
  const projectName = metadata(project).name || project.name;
  for (let repo of Object.values(registry(project))) {
    if (!repo.managed || path.isAbsolute(repo.location) || path.normalize(repo.location) !== 'code'
      || canonical(absolute(project, repo)) !== path.join(canonical(project.dir), 'code')) continue;
    let row = await ctx.libraryDb.get(repo.libraryId);
    let naming = repo.autoName;
    if (naming === undefined && repo.name === `${projectName} code`) {
      naming = { kind: 'project', value: repo.name };
    }
    if (naming?.kind !== 'project') continue;
    // A pending update is retried before comparing against the current title;
    // the project may have been renamed again since the interrupted operation.
    if (naming.pending && repo.name === naming.value && (!row || row.name === naming.value || row.name === naming.pending)) {
      if (row && row.name !== naming.pending) row = await ctx.libraryDb.updateRepo(row.id, { ...row, name: naming.pending });
      repo = save({ ...repo, name: naming.pending, autoName: { kind: 'project', value: naming.pending } });
      naming = repo.autoName;
    }
    if (repo.name !== naming.value || row && row.name !== naming.value) {
      // Library rename is the existing custom-name UI. Retain that choice in
      // the resolver too, without letting later project renames undo it.
      const name = repo.name === naming.value && row ? row.name : repo.name;
      if (row && row.name === naming.value && row.name !== name) await ctx.libraryDb.updateRepo(row.id, { ...row, name });
      save({ ...repo, name, autoName: null });
      continue;
    }
    if (repo.name === projectName) continue;
    repo = save({ ...repo, autoName: { ...naming, pending: projectName } });
    if (row) await ctx.libraryDb.updateRepo(row.id, { ...row, name: projectName });
    save({ ...repo, name: projectName, autoName: { kind: 'project', value: projectName } });
  }
}

function associate(project, workspace, repo) {
  const file = path.join(workspace.dir, 'meta.json'), meta = readJson(file) || {};
  writeJson(file, { ...meta, schemaVersion: Math.max(3, meta.schemaVersion || 0), repoId: repo?.id || null, repositoryIssue: null });
  // Provisioning has finished only once HEAD, registry and association all exist.
  const marker = path.join(workspace.dir, '.repository-init.json');
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
}

function resolvedRecord(ctx, project, repoId, missing) {
  const repo = registry(project)[repoId];
  if (!repo || repo.archived) throw fail(missing, 'REPOSITORY_SELECTION_REQUIRED');
  const directory = absolute(project, repo);
  assertNotMovingPath(directory);
  const git = findGitDir(directory);
  if (!fs.existsSync(directory) || !git || canonical(git.top) !== canonical(directory)) throw fail(`Repository unavailable: ${directory}. Reconnect or restore it using Change repository.`);
  const displayPath = contains(project.dir, directory) ? location(project.dir, directory) : contains(ctx.homeDir, directory) ? `~/${path.relative(canonical(ctx.homeDir), canonical(directory))}` : directory;
  return { ...repo, repoId: repo.id, directory, projectId: project.id, displayPath: displayPath === 'code' ? 'code/' : displayPath, githubUrl: github(directory) };
}

function resolve(ctx, projectId, workspaceId) {
  if (moving.has(operationKey(ctx, projectId))) throw fail('This project is moving. Try again when the move finishes.', 'REPOSITORY_BUSY');
  if (!workspaceId) throw fail('Choose a workspace before starting work.', 'WORKSPACE_REQUIRED');
  const { project, workspace } = projects().findWorkspace(ctx, projectId, workspaceId);
  const meta = metadata(project), inherited = !workspace.repoId;
  if (inherited && workspace.repositoryIssue) throw fail(workspace.repositoryIssue.message, workspace.repositoryIssue.code);
  const repo = resolvedRecord(ctx, project, workspace.repoId || meta.defaultRepoId, inherited
    ? 'Choose a project default repository, or a repository for this workspace, before starting work.'
    : 'This workspace’s repository override is unavailable. Choose or restore its repository; the project default was not used.');
  return { ...repo, workspaceId, inherited, defaultRepoId: meta.defaultRepoId || null, overrideRepoId: workspace.repoId || null, displayPath: repo.directory === path.join(workspace.dir, 'code') ? 'code/' : repo.displayPath };
}

function describe(ctx, pid, wid) {
  const { project, workspace } = projects().findWorkspace(ctx, pid, wid);
  let connected = null, error = null;
  try { connected = resolve(ctx, pid, wid); } catch (failure) { error = failure.message; }
  const meta = metadata(project);
  return { connected, repoId: workspace.repoId || null, inherited: !workspace.repoId, defaultRepoId: meta.defaultRepoId || null, defaultRepository: registry(project)[meta.defaultRepoId] || null, defaultIssue: meta.repositoryDefaultsMigration?.issue || null, error, issue: workspace.repositoryIssue || null, repositories: Object.values(registry(project)).filter(repo => !repo.archived).map(repo => ({ ...repo, directory: absolute(project, repo) })) };
}

async function choose(ctx, project, input, owner = project) {
  let repo;
  if (input.repoId) {
    repo = registry(project)[input.repoId];
    if (!repo || repo.archived) throw fail('This repository is not available.');
    assertNotMovingPath(absolute(project, repo)); existing(absolute(project, repo));
  } else if (input.directory) { assertNotMovingPath(input.directory); repo = await register(ctx, project, existing(input.directory)); }
  else if (input.createDefault) repo = await defaultRepository(ctx, project, owner);
  else throw fail('Choose a repository.');
  if (repo.archived) throw fail('Restore the workspace from trash before connecting its archived repository.');
  return repo;
}

// Separate from a workspace override: affects inheriting workspaces and future work only.
async function setDefault(ctx, pid, input = {}) {
  return serial(ctx, pid, async () => {
    if (moving.has(operationKey(ctx, pid))) throw fail('Wait for the repository move to finish.', 'REPOSITORY_BUSY');
    const project = projects().findProject(ctx, pid), repo = await choose(ctx, project, input);
    const meta = metadata(project);
    const next = { ...meta, schemaVersion: Math.max(3, meta.schemaVersion || 0), defaultRepoId: repo.id, repositoryDefaultsMigration: { ...meta.repositoryDefaultsMigration, version: 1, status: 'complete', issue: null } };
    delete next.initialRepository;
    writeJson(metaFile(project), next);
    const marker = path.join(project.dir, '.repository-init.json');
    if (fs.existsSync(marker)) fs.unlinkSync(marker);
    await require('../context/catalog.cjs').writeCatalogs(ctx);
    return repo;
  });
}

async function connect(ctx, pid, wid, input = {}) {
  return serial(ctx, pid, async () => {
    if (moving.has(operationKey(ctx, pid))) throw fail('Wait for the repository move to finish.', 'REPOSITORY_BUSY');
    const { project, workspace } = projects().findWorkspace(ctx, pid, wid);
    const repo = input.useProjectDefault ? null : await choose(ctx, project, input, workspace);
    if (input.useProjectDefault) resolvedRecord(ctx, project, metadata(project).defaultRepoId, 'Choose a project default repository first.');
    associate(project, workspace, repo);
    await require('../context/catalog.cjs').writeCatalogs(ctx);
    return describe(ctx, pid, wid);
  });
}

// Check before even writing a rename intent. App-owned processes are checked by
// the coordinator; lsof also catches local-app servers from an earlier process.
async function assertIdle(ctx, project, roots, { deletingIds = [], repositoryDirectories = [] } = {}) {
  const allProjects = projects().projectRecords(ctx);
  const affected = file => file && roots.some(root => contains(root, file));
  const workspaceIds = [...new Set([...deletingIds, ...projects().flattenWorkspaces(project.dir).filter(workspace => affected(path.resolve(project.dir, workspace.path))).map(workspace => workspace.id)])];
  const scope = { projectId: project.id, roots, workspaceIds };
  if ([...leases].some(held => affectedBy(scope, held))) throw fail('Work is starting or running in this folder. Wait for it to finish before moving folders.', 'REPOSITORY_BUSY');
  for (const owner of allProjects) for (const task of require('../build/store.cjs').listTasks(owner)) {
    if ((!['accepted', 'discarded'].includes(task.status) && affectedBy(scope, { projectId: owner.id, workspaceId: task.workspaceId, paths: [owner.dir, task.worktree, task.cwd], repositories: [task.repo] })) || affected(task.worktree) && fs.existsSync(task.worktree)) throw fail(`Finish or discard Build “${task.title}” before moving this repository.`, 'REPOSITORY_BUSY');
  }
  const registered = allProjects.flatMap(owner => Object.values(registry(owner)).map(repo => ({ dir: absolute(owner, repo), name: repo.name })));
  // Compatibility may find a Git directory that predates the registry. Apply
  // the same worktree guard before moving it, without connecting it or committing.
  for (const { dir, name } of [...registered, ...repositoryDirectories.map(dir => ({ dir, name: path.basename(dir) }))]) {
    if (!affected(dir)) continue;
    const git = findGitDir(dir);
    if (git && (git.gitDir !== git.commonDir || fs.existsSync(path.join(git.commonDir, 'worktrees')) && fs.readdirSync(path.join(git.commonDir, 'worktrees')).length)) throw fail(`Close Git worktrees of “${name}” before moving it.`, 'REPOSITORY_BUSY');
  }
  const reason = await ctx.repositoryBusy?.(scope);
  if (reason) throw fail(reason, 'REPOSITORY_BUSY');
  for (const owner of allProjects) if (owner.id !== project.id && Object.values(registry(owner)).some(repo => affected(absolute(owner, repo)))) {
    const sharedReason = await ctx.repositoryBusy?.({ projectId: owner.id, roots, workspaceIds: [] });
    if (sharedReason) throw fail(sharedReason, 'REPOSITORY_BUSY');
  }
  if (process.platform === 'darwin') {
    let output = '';
    try { output = (await run('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-Fn'], { maxBuffer: 8 * 1024 * 1024, timeout: 10000 })).stdout; }
    catch (error) { if (error.code !== 1) throw fail('Could not check active processes. Close terminals/servers and try again.', 'REPOSITORY_BUSY'); output = error.stdout || ''; }
    if (output.split('\n').some(line => line.startsWith('n') && affected(line.slice(1)))) throw fail('A process is using this folder. Stop its agent/server or close its terminal before moving it.', 'REPOSITORY_BUSY');
  }
}

// Rewrite path-bearing values, never arbitrary user messages/documents. Build
// conversation/history remains byte-for-byte unchanged.
const PATH_KEYS = new Set(['directory', 'repo', 'sourceDirectory', 'worktree', 'cwd', 'folder_path', 'path', 'root', 'acceptedDirectory']);
function rewrite(value, from, to, key = '') {
  if (typeof value === 'string') return PATH_KEYS.has(key) && path.isAbsolute(value) ? rebase(value, from, to) : value;
  if (Array.isArray(value)) return value.map(item => rewrite(item, from, to, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, item]) => [k, rewrite(item, from, to, k)]));
  return value;
}
function localStates(ctx, pid) {
  const root = path.join(ctx.dataRoot, '.local-apps', pid);
  let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* none */ }
  return entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name, 'state.json')).filter(fs.existsSync);
}

async function finishRelocation(ctx, project, intent) {
  const { from, to, projectFrom = project.dir, archived = false } = intent;
  const meta = metadata(project), records = { ...meta.repositories };
  for (const [id, repo] of Object.entries(records)) {
    const old = path.resolve(projectFrom, repo.location);
    const next = rebase(old, from, to);
    records[id] = { ...repo, location: location(project.dir, next), ...(archived && contains(from, old) ? { archived: true, recovery: { location: repo.location, trashedAt: intent.at } } : {}), ...(intent.restoringIds?.includes(id) ? { archived: false, recovery: null } : {}) };
  }
  writeJson(metaFile(project), { ...rewrite(meta, from, to), ...(intent.projectName ? { name: intent.projectName } : {}), repositories: records });
  // Recovery data travels in the intent, so a crash after the filesystem rename
  // cannot leave a deleted workspace without enough information to restore it.
  if (intent.workspaceRecovery) writeJson(path.join(to, '.workspace-recovery.json'), intent.workspaceRecovery);
  // A repository may be connected in another project too. Those records are
  // independent IDs but must follow the same physical directory relocation.
  const allProjects = projects().projectRecords(ctx);
  for (const owner of allProjects) if (owner.id !== project.id) {
    const held = metadata(owner), registered = { ...held.repositories };
    let changed = false;
    for (const [id, repo] of Object.entries(registered)) {
      const old = absolute(owner, repo);
      if (!contains(from, old)) continue;
      changed = true;
      registered[id] = { ...repo, location: location(owner.dir, rebase(old, from, to)), ...(archived ? { archived: true, recovery: { location: repo.location, trashedAt: intent.at } } : {}), ...(intent.restoringIds?.length ? { archived: false, recovery: null } : {}) };
    }
    if (changed) writeJson(metaFile(owner), { ...rewrite(held, from, to), repositories: registered });
  }
  for (const row of await ctx.libraryDb.list()) {
    if (row.folder_path && contains(from, row.folder_path)) await ctx.libraryDb.updateRepo(row.id, { name: row.name, url: row.url, folder_path: rebase(row.folder_path, from, to), github_id: row.github_id });
    if (row.path && contains(from, row.path)) await ctx.libraryDb.updatePath(row.id, rebase(row.path, from, to));
  }
  const buildStore = require('../build/store.cjs');
  for (const owner of allProjects) for (const task of buildStore.listTasks(owner)) {
    const next = rewrite(task, from, to);
    if (JSON.stringify(next) !== JSON.stringify(task)) buildStore.writeTask(owner, next);
  }
  for (const owner of allProjects) for (const file of localStates(ctx, owner.id)) {
    const state = readJson(file);
    if (state) {
      const next = rewrite(state, from, to);
      if (next.directory && next.directory !== state.directory) {
        const repo = Object.values(registry(owner)).find(item => canonical(absolute(owner, item)) === canonical(next.directory));
        if (repo) { next.repoId = repo.id; next.repositoryMigration = VERSION; }
      }
      writeJson(file, next);
    }
  }
  const stateFile = path.join(ctx.dataRoot, 'state.json'), state = readJson(stateFile);
  if (state) writeJson(stateFile, rewrite(state, from, to));
  for (const expected of intent.heads || []) {
    const repo = records[expected.repoId], directory = repo && absolute(project, repo);
    if (!directory || !fs.existsSync(directory) || !findGitDir(directory)) throw fail('Repository move is awaiting recovery: the destination is unavailable.', 'REPOSITORY_CONFLICT');
    if (expected.head && await gitCommand(ctx, directory, ['rev-parse', '--verify', 'HEAD']) !== expected.head) throw fail('Repository move needs recovery: Git history at the destination does not match. No history has been overwritten.', 'REPOSITORY_CONFLICT');
    const row = await ctx.libraryDb.get(repo.libraryId);
    if (!row?.folder_path || canonical(row.folder_path) !== canonical(directory)) throw fail('Repository move needs recovery: its library path has not been updated.', 'REPOSITORY_CONFLICT');
  }
  await ctx.repositoryRelocated?.({ from, to, projectId: project.id });
  await syncProjectRepositoryNames(ctx, project);
  await require('../context/catalog.cjs').writeCatalogs(ctx);
}

async function relocate(ctx, project, from, to, options = {}) {
  const key = operationKey(ctx, project.id);
  if (moving.has(key)) throw fail('Another repository move is already in progress.', 'REPOSITORY_BUSY');
  const workspaceIds = projects().flattenWorkspaces(project.dir).filter(workspace => contains(from, path.resolve(project.dir, workspace.path))).map(workspace => workspace.id);
  moving.add(key);
  movingRoots.set(key, { from, to, projectId: project.id, roots: [from, to], workspaceIds });
  try {
  if (fs.existsSync(to)) throw fail(`Destination already exists: ${to}. Nothing was moved.`, 'REPOSITORY_CONFLICT');
  await assertIdle(ctx, project, [from], options);
  const intent = { version: 1, from, to, projectFrom: project.dir, at: new Date().toISOString(), ...options };
  intent.heads = [];
  for (const repo of Object.values(registry(project))) {
    const directory = absolute(project, repo);
    if (contains(from, directory) && fs.existsSync(directory) && findGitDir(directory)) {
      const head = await gitFor(ctx).exec(directory, ['rev-parse', '--verify', 'HEAD']);
      intent.heads.push({ repoId: repo.id, head: head.code === 0 ? head.stdout.trim() : null });
    }
  }
  const file = path.join(project.dir, '.repository-relocation.json');
  writeJson(file, intent);
  try { fs.renameSync(from, to); }
  catch (error) {
    // A refused rename (e.g. another filesystem) has changed nothing. Do not
    // leave a retry-on-load journal that would prevent opening the project.
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.unlinkSync(file);
    throw fail(`The folder could not be moved; its source is preserved. ${error.message}`, 'REPOSITORY_CONFLICT');
  }
  const nextProject = from === project.dir ? { ...project, dir: to, slug: path.basename(to) } : project;
  await finishRelocation(ctx, nextProject, intent);
  fs.unlinkSync(path.join(nextProject.dir, '.repository-relocation.json'));
  } finally { moving.delete(key); movingRoots.delete(key); }
}

async function recover(ctx, project) {
  const file = path.join(project.dir, '.repository-relocation.json'), intent = readJson(file);
  if (!intent) return project;
  const key = operationKey(ctx, project.id);
  if (moving.has(key)) throw fail('Another repository move is already in progress.', 'REPOSITORY_BUSY');
  moving.add(key);
  movingRoots.set(key, { from: intent.from, to: intent.to, projectId: project.id, roots: [intent.from, intent.to], workspaceIds: [] });
  try {
  const old = fs.existsSync(intent.from), next = fs.existsSync(intent.to);
  if (old && next || !old && !next) throw fail('A repository move needs recovery: both or neither path exists. Preserve both folders and choose a repository.', 'REPOSITORY_CONFLICT');
  if (old) { await assertIdle(ctx, project, [intent.from], intent); fs.renameSync(intent.from, intent.to); }
  const nextProject = intent.from === project.dir ? { ...project, dir: intent.to, slug: path.basename(intent.to) } : project;
  await finishRelocation(ctx, nextProject, intent);
  fs.unlinkSync(path.join(nextProject.dir, '.repository-relocation.json'));
  return nextProject;
  } finally { moving.delete(key); movingRoots.delete(key); }
}

async function ensure(ctx, pid) {
  return serial(ctx, pid, async () => {
    if (moving.has(operationKey(ctx, pid))) throw fail('Wait for the repository move to finish.', 'REPOSITORY_BUSY');
    const project = await recover(ctx, projects().findProject(ctx, pid));
    let meta = metadata(project);
    for (const repo of Object.values(meta.repositories || {})) {
      if (!(await ctx.libraryDb.get(repo.libraryId))) await ctx.libraryDb.insert({ id: repo.libraryId, name: repo.name, type: 'folder', tags: ['git'], folder_path: absolute(project, repo), project_id: project.id });
    }
    const buildStore = require('../build/store.cjs');
    let tasks = buildStore.listTasks(project);
    // Historical Builds always use their recorded repository, never today's connection.
    for (const task of tasks) if (!task.repoId && task.repo) {
      const repo = await register(ctx, project, task.repo);
      buildStore.writeTask(project, { ...task, schemaVersion: 2, repoId: repo.id, sourceDirectory: task.sourceDirectory || (task.cwd && task.worktree ? path.join(task.repo, path.relative(task.worktree, task.cwd)) : task.repo) });
    }
    // Project targets are fallbacks, not workspace-specific candidates.
    for (const directory of [meta.directory, meta.initialRepository].filter(Boolean)) await register(ctx, project, directory);
    await migrateCodeWorkspaces(ctx, project);
    meta = metadata(project);
    const projectMarker = path.join(project.dir, '.repository-init.json');
    // A newly created project may have stopped before its provisioning marker
    // was written. The pending intent still requests one project repository.
    if (meta.repositoryDefaultsMigration?.status === 'pending') {
      const repo = await choose(ctx, project, meta.initialRepository ? { directory: meta.initialRepository } : { createDefault: true });
      meta = metadata(project);
      const next = { ...meta, defaultRepoId: repo.id, repositoryDefaultsMigration: { version: 1, status: 'complete', issue: null } };
      delete next.initialRepository; writeJson(metaFile(project), next);
      if (fs.existsSync(projectMarker)) fs.unlinkSync(projectMarker);
      meta = next;
    }
    if ((!meta.repositoryDefaultsMigration || !meta.defaultRepoId) && repositoryAt(path.join(project.dir, 'code'))) await register(ctx, project, path.join(project.dir, 'code'));
    tasks = buildStore.listTasks(project);
    const workspaces = projects().flattenWorkspaces(project.dir);
    for (const entry of workspaces) {
      const workspace = projects().findWorkspace(ctx, pid, entry.id).workspace;
      // An explicit choice resolves migration ambiguity, even if that choice is
      // now unavailable. resolve() reports availability without changing its ID.
      const workspaceFile = path.join(workspace.dir, 'meta.json'), workspaceMeta = readJson(workspaceFile);
      if (workspace.repoId) {
        if (workspace.repositoryIssue) writeJson(workspaceFile, { ...workspaceMeta, repositoryIssue: null });
        continue;
      }
      // New schema-3 workspaces deliberately inherit. Saved issues, however,
      // must be reevaluated even when the project was already marked migrated.
      if (workspaceMeta.schemaVersion >= 3 && !workspace.repositoryIssue) continue;
      const localFile = path.join(ctx.dataRoot, '.local-apps', pid, workspace.id, 'state.json');
      const state = readJson(localFile);
      const savedRepo = state?.repoId && registry(project)[state.repoId];
      const localDir = savedRepo ? absolute(project, savedRepo) : state?.directory || path.join(path.dirname(localFile), 'app');
      const code = path.join(workspace.dir, 'code');
      const provisioning = fs.existsSync(path.join(workspace.dir, '.repository-init.json'));
      // Only workspace-owned repositories compete. A historical Build records
      // its own target; it is not evidence of today's workspace connection.
      // Non-repository folders stay untouched and do not prevent inheritance.
      const candidates = [...new Set([...(repositoryAt(localDir) ? [localDir] : []), ...(repositoryAt(code) || provisioning ? [code] : [])].map(canonical))];
      try {
        let repo;
        for (const candidate of candidates) if (repositoryAt(candidate)) await register(ctx, project, candidate, { libraryId: candidate === canonical(localDir) ? state?.libraryId : null, managed: candidate === canonical(localDir) || candidate === canonical(code) && provisioning, name: candidate === canonical(localDir) ? state?.name : null });
        if (candidates.length > 1) throw fail('Several workspace repositories were found. Choose one from the repository menu; all existing folders have been preserved.', 'REPOSITORY_CONFLICT');
        if (provisioning) repo = await defaultRepository(ctx, project, workspace);
        else if (candidates.length) {
          const candidate = candidates[0];
          repo = Object.values(registry(project)).find(item => canonical(absolute(project, item)) === candidate);
        }
        if (repo?.archived) throw fail('This workspace’s repository is archived. Restore it or explicitly choose another repository.');
        // Register generated interfaces in place. This migration never relocates
        // source, Git history, launch recipes, or an accepted/review preview.
        if (state && fs.existsSync(localFile)) {
          const current = readJson(localFile), held = Object.values(registry(project)).find(item => canonical(absolute(project, item)) === canonical(current.directory || localDir));
          if (held && !current.repoId) writeJson(localFile, { ...current, repoId: held.id, repositoryMigration: VERSION });
        }
        // Finish preview identity before marking the workspace resolved, so a
        // failed state-file write is retried instead of skipped on the next load.
        associate(project, workspace, repo);
      } catch (error) {
        const file = path.join(workspace.dir, 'meta.json'), value = readJson(file);
        const next = { ...value, repositoryIssue: { code: error.code || 'REPOSITORY_UNAVAILABLE', message: error.message, candidates } };
        if (JSON.stringify(next) !== JSON.stringify(value)) writeJson(file, next);
      }
    }
    meta = metadata(project);
    if (!meta.repositoryDefaultsMigration || !meta.defaultRepoId) {
      const historical = new Set(tasks.filter(task => task.repo).map(task => canonical(task.repo)));
      const connected = new Set(projects().flattenWorkspaces(project.dir).map(workspace => workspace.repoId).filter(Boolean));
      // Registering a historical target must not indirectly select it as the
      // sole project default. Independent project/workspace evidence is needed.
      const records = Object.values(registry(project)).filter(repo => !repo.archived);
      const current = records.filter(repo => !historical.has(canonical(absolute(project, repo))) || connected.has(repo.id));
      const explicit = [...new Set([meta.directory, meta.initialRepository].filter(Boolean).map(canonical))];
      const projectCode = repositoryAt(path.join(project.dir, 'code')) && records.find(repo => canonical(absolute(project, repo)) === canonical(path.join(project.dir, 'code')));
      const selected = meta.defaultRepoId || (explicit.length === 1 ? records.find(repo => canonical(absolute(project, repo)) === explicit[0])?.id
        : explicit.length ? null : projectCode?.id || (current.length === 1 ? current[0].id : null));
      const next = { ...meta, schemaVersion: Math.max(3, meta.schemaVersion || 0), defaultRepoId: selected || null,
        repositoryDefaultsMigration: { ...meta.repositoryDefaultsMigration, version: 1, status: selected ? 'complete' : 'needs-selection', issue: selected ? null : { code: 'PROJECT_REPOSITORY_SELECTION_REQUIRED', message: 'Choose the project default repository. Existing workspace connections and folders have been preserved.' } } };
      if (JSON.stringify(next) !== JSON.stringify(meta)) writeJson(metaFile(project), next);
      meta = metadata(project);
    }
    let complete = true;
    for (const workspace of projects().flattenWorkspaces(project.dir)) { try { resolve(ctx, pid, workspace.id); } catch { complete = false; } }
    const next = { ...meta, schemaVersion: Math.max(3, meta.schemaVersion || 0), repositoryMigration: { version: VERSION, status: complete ? 'complete' : 'needs-selection' } };
    if (complete && workspaces.length) delete next.initialRepository;
    if (JSON.stringify(next) !== JSON.stringify(meta)) writeJson(metaFile(project), next);
    await syncProjectRepositoryNames(ctx, project);
    await require('../context/catalog.cjs').writeCatalogs(ctx);
  });
}

// Always inspect, even if either of the older migrations says "complete". The
// old reserved-name filter may have hidden an entire subtree from those passes.
async function migrateCodeWorkspaces(ctx, project) {
  const record = patch => {
    const meta = metadata(project);
    const value = { version: 1, ...patch };
    if (JSON.stringify(meta.workspaceNameMigration) !== JSON.stringify(value)) writeJson(metaFile(project), { ...meta, workspaceNameMigration: value });
  };
  let pending;
  try {
    while (true) {
      const discoveredRepositories = [];
      const found = codeWorkspaces.inspect(project.dir, { onRepository: dir => discoveredRepositories.push(dir) });
      if (found.conflicts.length) {
        record({ status: 'needs-attention', conflicts: found.conflicts });
        throw fail(found.conflicts.map(item => item.message).join('\n'), 'WORKSPACE_NAME_CONFLICT');
      }
      pending = found.workspaces[0];
      if (!pending) break;
      record({ status: 'pending', conflicts: [] });
      // If an old goal/topic conversion is waiting, first promote the containing
      // topic through these same safeguards. Otherwise the synchronous converter
      // would move it a second time without updating repository/library paths.
      const from = pending.goalWorkspace || pending.dir;
      const parent = pending.goalWorkspace ? project.dir : path.dirname(from);
      const name = path.basename(from).toLowerCase() === 'code' ? 'Code workspace' : path.basename(from);
      const to = path.join(parent, uniqueName(parent, name));
      await relocate(ctx, project, from, to, { repositoryDirectories: discoveredRepositories.filter(dir => contains(from, dir)) });
      // Rescan after each parent move: nested Code workspaces now have new paths.
    }
    record({ status: 'complete', conflicts: [] });
  } catch (error) {
    if (error.code !== 'WORKSPACE_NAME_CONFLICT') record({ status: 'needs-attention', conflicts: [{ path: pending?.dir, workspaceId: pending?.id, code: error.code || 'WORKSPACE_NAME_MIGRATION_FAILED', message: error.message }] });
    throw error;
  }
}

async function provision(ctx, pid, wid, input = {}) {
  const { project, workspace } = projects().findWorkspace(ctx, pid, wid);
  if (input.repoId || input.directory || input.createDefault) return connect(ctx, pid, wid, input);
  associate(project, workspace, null);
  await require('../context/catalog.cjs').writeCatalogs(ctx);
  return describe(ctx, pid, wid);
}

module.exports = { VERSION, registry, absolute, existing, register, resolve, describe, connect, setDefault, provision, ensure, syncProjectRepositoryNames, assertIdle, relocate, contains, canonical, rewrite, localStates, lease };
