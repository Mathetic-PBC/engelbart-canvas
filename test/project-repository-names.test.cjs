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
const { buildContext } = require('../src/main/bart/context.cjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-repository-names-')));
const layout = ensureHome(root);
let ctx;
test.before(async () => { ctx = { homeDir: root, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => db.closeAll());
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
const meta = project => readJson(path.join(project.dir, 'project.json'));
const scene = async input => {
  const p = await projects.createProject(ctx, input);
  const w = await projects.createWorkspace(ctx, p.id, { name: 'Workspace' });
  return { p, w, repo: repos.resolve(ctx, p.id, w.id) };
};
async function labels(p, w, repo, name) {
  const current = repos.resolve(ctx, p.id, w.id);
  assert.equal(current.repoId, repo.repoId); assert.equal(current.libraryId, repo.libraryId);
  assert.equal(current.name, name);
  assert.equal(meta(p).repositories[repo.repoId].name, name);
  const row = await ctx.libraryDb.get(repo.libraryId);
  assert.equal(row.name, name); assert.equal(row.folder_path, current.directory);
  const index = readJson(path.join(p.dir, '.context/catalog.json'));
  assert.equal(index.repositories.find(item => item.id === repo.repoId).name, name);
  assert.equal(index.entries.find(item => item.id === repo.libraryId).name, name);
  assert.equal(repos.describe(ctx, p.id, w.id).connected.name, name, 'both selectors use the same resolved name');
  assert.equal((await buildContext(ctx, p.id, { workspaceId: w.id, ref: { kind: 'workspace', workspaceId: w.id }, text: 'Explain this code' })).repository.name, name);
}
async function legacyLabel(p, repo, name = `${p.name} code`) {
  const saved = meta(p), record = saved.repositories[repo.repoId];
  record.name = name; delete record.autoName;
  saved.customMetadata = { untouched: true };
  writeJson(path.join(p.dir, 'project.json'), saved);
  const row = await ctx.libraryDb.get(repo.libraryId);
  await ctx.libraryDb.updateRepo(row.id, { ...row, name });
  await catalog.writeCatalogs(ctx);
}

test('automatic project repository is named after the project; nested overrides keep their names and connections', async () => {
  const { p, w, repo } = await scene('Engelbart');
  assert.equal(repo.directory, path.join(p.dir, 'code'));
  assert.equal(repo.displayPath, 'code/');
  assert.deepEqual(meta(p).repositories[repo.repoId].autoName, { kind: 'project', value: 'Engelbart' });
  assert.equal(git(repo.directory, 'ls-tree', '-r', 'HEAD'), '');
  await labels(p, w, repo, 'Engelbart');
  const child = await projects.createWorkspace(ctx, p.id, { parentId: w.id, name: 'Child' });
  assert.equal(repos.resolve(ctx, p.id, child.id).repoId, repo.repoId);
  const override = await projects.createWorkspace(ctx, p.id, { parentId: w.id, name: 'Charts', createDefault: true });
  const held = repos.resolve(ctx, p.id, override.id);
  assert.equal(held.name, 'Charts code'); assert.equal(held.autoName, undefined);
  await repos.ensure(ctx, p.id);
  assert.equal(repos.resolve(ctx, p.id, override.id).repoId, held.repoId);
  assert.equal(repos.resolve(ctx, p.id, override.id).name, 'Charts code');
});

test('completed legacy projects upgrade only identifiable generated labels; history, files and identities survive reopening', async () => {
  const { p, w, repo } = await scene('Legacy');
  await legacyLabel(p, repo);
  fs.writeFileSync(path.join(repo.directory, 'source.txt'), 'Uncommitted work');
  const head = git(repo.directory, 'rev-parse', 'HEAD');
  const task = builds.writeTask(p, { id: 'aabbccddee', projectId: p.id, workspaceId: w.id, repoId: repo.repoId, repo: repo.directory, sourceDirectory: repo.directory, repositoryName: 'Legacy code', status: 'accepted', messages: [{ role: 'agent', text: 'Keep history' }], preview: { directory: repo.directory, url: 'http://localhost:4321/' } });
  const previewFile = path.join(ctx.dataRoot, '.local-apps', p.id, w.id, 'state.json');
  fs.mkdirSync(path.dirname(previewFile), { recursive: true });
  writeJson(previewFile, { repoId: repo.repoId, directory: repo.directory, name: 'Existing interface', recipe: { command: 'node server.cjs {port}' } });
  const previewBefore = fs.readFileSync(previewFile, 'utf8');
  const workspaceBefore = fs.readFileSync(path.join(p.dir, 'Workspace/meta.json'), 'utf8');
  await projects.loadProject(ctx, p.id);
  await labels(p, w, repo, 'Legacy');
  assert.deepEqual(meta(p).customMetadata, { untouched: true });
  assert.equal(meta(p).defaultRepoId, repo.repoId);
  assert.equal(git(repo.directory, 'rev-parse', 'HEAD'), head);
  assert.equal(git(repo.directory, 'status', '--porcelain'), '?? source.txt');
  assert.equal(fs.readFileSync(path.join(repo.directory, 'source.txt'), 'utf8'), 'Uncommitted work');
  assert.deepEqual(builds.readTask(p, task.id), task);
  assert.equal(fs.readFileSync(previewFile, 'utf8'), previewBefore);
  assert.equal(fs.readFileSync(path.join(p.dir, 'Workspace/meta.json'), 'utf8'), workspaceBefore);
  const json = fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8');
  const index = fs.readFileSync(path.join(p.dir, '.context/catalog.json'), 'utf8');
  const row = await ctx.libraryDb.get(repo.libraryId);
  await repos.ensure(ctx, p.id); await db.closeAll(); ctx.libraryDb = await db.openLibraryDb(ctx.dataRoot);
  await projects.loadProject(ctx, p.id);
  assert.equal(fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8'), json);
  assert.equal(fs.readFileSync(path.join(p.dir, '.context/catalog.json'), 'utf8'), index);
  assert.deepEqual(await ctx.libraryDb.get(repo.libraryId), row);
});

test('project rename updates automatic labels with both slug-following and custom project paths', async () => {
  for (const customPath of [false, true]) {
    const { p, w, repo } = await scene({ name: `Before ${customPath}`, ...(customPath ? { path: 'fixed-project-folder' } : {}) });
    const override = await projects.createWorkspace(ctx, p.id, { name: 'Override', createDefault: true });
    const held = repos.resolve(ctx, p.id, override.id);
    const head = git(repo.directory, 'rev-parse', 'HEAD');
    const renamed = await projects.renameProject(ctx, p.id, `After ${customPath}`);
    assert.equal(renamed.dir === p.dir, customPath);
    await labels(renamed, w, repo, `After ${customPath}`);
    assert.equal(git(path.join(renamed.dir, 'code'), 'rev-parse', 'HEAD'), head);
    assert.equal(repos.resolve(ctx, p.id, override.id).repoId, held.repoId);
    assert.equal(repos.resolve(ctx, p.id, override.id).name, held.name);
    assert.equal(meta(renamed).defaultRepoId, repo.repoId);
  }
});

test('custom names, including library-only edits, opt out of automatic project naming', async () => {
  for (const variant of ['legacy', 'library-only', 'registry-only', 'legacy-library-only']) {
    const { p, w, repo } = await scene({ name: `Custom ${variant}`, path: `custom-${variant}` });
    if (variant.startsWith('legacy')) await legacyLabel(p, repo, variant === 'legacy' ? 'My chosen repository' : undefined);
    if (variant.endsWith('library-only')) await ctx.libraryDb.rename(repo.libraryId, 'My chosen repository');
    if (variant === 'registry-only') {
      const saved = meta(p); saved.repositories[repo.repoId].name = 'My chosen repository'; writeJson(path.join(p.dir, 'project.json'), saved);
    }
    await repos.ensure(ctx, p.id);
    await labels(p, w, repo, 'My chosen repository');
    const renamed = await projects.renameProject(ctx, p.id, `Renamed ${variant}`);
    await labels(renamed, w, repo, 'My chosen repository');
    assert.notEqual(meta(renamed).repositories[repo.repoId].autoName?.kind, 'project');
  }
});

test('external engelbart-canvas and matching-looking external labels are never renamed or replaced', async () => {
  for (const name of ['engelbart-canvas', 'Engelbart code']) {
    const directory = path.join(root, randomUUID(), name); fs.mkdirSync(directory, { recursive: true });
    git(directory, 'init', '-q', '-b', 'main'); git(directory, 'commit', '--allow-empty', '-qm', 'Existing history');
    fs.writeFileSync(path.join(directory, 'dirty.txt'), 'Keep external files');
    const head = git(directory, 'rev-parse', 'HEAD');
    const { p, w, repo } = await scene({ name: 'Engelbart', directory, path: randomUUID() });
    const row = await ctx.libraryDb.get(repo.libraryId), record = meta(p).repositories[repo.repoId];
    await repos.ensure(ctx, p.id); const renamed = await projects.renameProject(ctx, p.id, 'Renamed external project');
    await labels(renamed, w, repo, name);
    assert.deepEqual(meta(renamed).repositories[repo.repoId], record);
    assert.deepEqual(await ctx.libraryDb.get(repo.libraryId), row);
    assert.equal(repos.resolve(ctx, p.id, w.id).directory, directory);
    assert.equal(fs.existsSync(path.join(renamed.dir, 'code')), false);
    assert.equal(git(directory, 'rev-parse', 'HEAD'), head);
    assert.equal(git(directory, 'status', '--porcelain'), '?? dirty.txt');
  }
});

test('generated-name migration never claims an unmanaged code/ or a code/ symlink to external source', async () => {
  for (const kind of ['unmanaged', 'symlink']) {
    const { p, w, repo } = await scene({ name: `Preserve ${kind}`, path: `fixed-preserve-${kind}` });
    await legacyLabel(p, repo);
    if (kind === 'unmanaged') {
      const saved = meta(p); saved.repositories[repo.repoId].managed = false; writeJson(path.join(p.dir, 'project.json'), saved);
    } else {
      const external = path.join(root, `external-${kind}`);
      fs.renameSync(repo.directory, external); fs.symlinkSync(external, repo.directory, 'dir');
    }
    const record = meta(p).repositories[repo.repoId], row = await ctx.libraryDb.get(repo.libraryId);
    await repos.ensure(ctx, p.id);
    const renamed = await projects.renameProject(ctx, p.id, `Another ${kind} title`);
    assert.deepEqual(meta(renamed).repositories[repo.repoId], record);
    assert.deepEqual(await ctx.libraryDb.get(repo.libraryId), row);
    assert.equal(repos.resolve(ctx, p.id, w.id).repoId, repo.repoId);
  }
});

test('switching the default to an external repository does not transfer automatic naming or alter overrides', async () => {
  const { p, w, repo } = await scene({ name: 'Previously default', path: 'keep-project-directory' });
  await legacyLabel(p, repo);
  const other = await projects.createWorkspace(ctx, p.id, { name: 'Still uses generated', repoId: repo.repoId });
  const directory = path.join(root, 'next-external'); fs.mkdirSync(directory);
  git(directory, 'init', '-q', '-b', 'main'); git(directory, 'commit', '--allow-empty', '-qm', 'External history');
  const external = await repos.setDefault(ctx, p.id, { directory });
  await repos.ensure(ctx, p.id);
  const renamed = await projects.renameProject(ctx, p.id, 'New project title');
  assert.equal(meta(renamed).defaultRepoId, external.id);
  assert.equal(repos.resolve(ctx, p.id, w.id).name, 'next-external');
  assert.equal(repos.resolve(ctx, p.id, w.id).directory, directory);
  await labels(renamed, other, repo, 'New project title');
  assert.equal(repos.resolve(ctx, p.id, other.id).inherited, false);
  assert.equal(repos.resolve(ctx, p.id, other.id).directory, repo.directory);
});

test('migration recovers registry/library writes before or after a library commit', async () => {
  for (const committed of [false, true]) {
    const { p, w, repo } = await scene(`Recovery ${committed}`);
    await legacyLabel(p, repo);
    const update = ctx.libraryDb.updateRepo;
    ctx.libraryDb.updateRepo = async (...args) => { if (committed) await update(...args); throw new Error('Simulated interruption'); };
    try { await assert.rejects(repos.ensure(ctx, p.id), /Simulated interruption/); }
    finally { ctx.libraryDb.updateRepo = update; }
    assert.equal(meta(p).repositories[repo.repoId].autoName.pending, p.name);
    await repos.ensure(ctx, p.id); await repos.ensure(ctx, p.id);
    await labels(p, w, repo, p.name);
    assert.deepEqual(meta(p).repositories[repo.repoId].autoName, { kind: 'project', value: p.name });
  }
});

test('interrupted project rename recovers labels after metadata changes with and without relocation', async () => {
  for (const customPath of [false, true]) {
    const { p, w, repo } = await scene({ name: `Rename recovery ${customPath}`, ...(customPath ? { path: 'recovery-fixed' } : {}) });
    const update = ctx.libraryDb.updateRepo;
    ctx.libraryDb.updateRepo = async (id, value) => { if (value.name === 'Recovered title') throw new Error('Interrupted rename label'); return update(id, value); };
    try { await assert.rejects(projects.renameProject(ctx, p.id, 'Recovered title'), /Interrupted rename label/); }
    finally { ctx.libraryDb.updateRepo = update; }
    await repos.ensure(ctx, p.id);
    const reopened = (await projects.loadProject(ctx, p.id)).project;
    await labels(reopened, w, repo, 'Recovered title');
    assert.equal(fs.existsSync(path.join(reopened.dir, '.repository-relocation.json')), false);
  }
});
