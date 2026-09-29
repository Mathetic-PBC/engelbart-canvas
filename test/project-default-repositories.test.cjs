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
const { buildContext } = require('../src/main/bart/context.cjs');
const history = require('../src/main/bart/history.cjs');
const { createFakeBart } = require('../src/main/bart/ask.cjs');
const { DEFAULT_MODELS } = require('../src/main/bart/models.cjs');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-default-repos-')));
const layout = ensureHome(root);
let ctx;
test.before(async () => { ctx = { homeDir: root, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) }; });
test.after(async () => db.closeAll());
const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { encoding: 'utf8' }).trim();
function external() {
  const directory = path.join(root, randomUUID()); fs.mkdirSync(directory);
  git(directory, 'init', '-q', '-b', 'main'); git(directory, 'commit', '--allow-empty', '-qm', 'First'); return directory;
}
const meta = p => readJson(path.join(p.dir, 'project.json'));
const wsMeta = (p, w) => readJson(path.join(projects.findWorkspace(ctx, p.id, w.id).workspace.dir, 'meta.json'));
const scene = async name => { const p = await projects.createProject(ctx, name); const w = await projects.createWorkspace(ctx, p.id, { name: 'Workspace' }); return { p, w }; };

test('one project code/ and initial commit; all nesting depths inherit and catalog can be rebuilt', async () => {
  const { p, w } = await scene('Inherited');
  const child = await projects.createWorkspace(ctx, p.id, { name: 'Child', parentId: w.id });
  const grand = await projects.createWorkspace(ctx, p.id, { name: 'Grand', parentId: child.id });
  const parent = repos.resolve(ctx, p.id, w.id);
  assert.equal(parent.directory, path.join(p.dir, 'code'));
  assert.equal(parent.repoId, meta(p).defaultRepoId); assert.notEqual(parent.repoId, parent.libraryId);
  assert.ok(git(parent.directory, 'rev-parse', 'HEAD')); assert.equal(git(parent.directory, 'ls-tree', '-r', 'HEAD'), '');
  for (const workspace of [w, child, grand]) {
    assert.equal(wsMeta(p, workspace).repoId, null);
    assert.equal(repos.resolve(ctx, p.id, workspace.id).repoId, parent.repoId);
    assert.equal(repos.resolve(ctx, p.id, workspace.id).inherited, true);
    assert.equal(fs.existsSync(path.join(projects.findWorkspace(ctx, p.id, workspace.id).workspace.dir, 'code')), false);
  }
  assert.equal(Object.keys(meta(p).repositories).length, 1);
  const file = path.join(p.dir, '.context/catalog.json'); fs.unlinkSync(file); await catalog.writeCatalogs(ctx);
  const index = readJson(file); assert.equal(index.version, 4); assert.equal(index.project.defaultRepoId, parent.repoId);
  assert.deepEqual(index.repositories[0].workspaces.map(row => row.path), ['Workspace', 'Workspace/Child', 'Workspace/Child/Grand']);
  assert.ok(index.workspaces.every(row => row.repoId === null && row.resolvedRepoId === parent.repoId && row.inherited));
});

test('existing default stays in place with dirty files untouched; explicit separate code is opt-in', async () => {
  const directory = external(), head = git(directory, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(directory, 'dirty.txt'), 'keep');
  const made = await projects.createProjectWithWelcome(ctx, { name: 'Existing', directory });
  const sibling = await projects.createWorkspace(ctx, made.project.id, { name: 'Sibling' });
  assert.equal(repos.resolve(ctx, made.project.id, sibling.id).directory, directory);
  assert.equal(fs.existsSync(path.join(made.project.dir, 'code')), false);
  const own = await projects.createWorkspace(ctx, made.project.id, { name: 'Independent', createDefault: true });
  assert.equal(repos.resolve(ctx, made.project.id, own.id).location, 'Independent/code');
  assert.ok(own.repoId); assert.equal(git(directory, 'rev-parse', 'HEAD'), head);
  assert.equal(git(directory, 'status', '--porcelain'), '?? dirty.txt');
});

test('default changes update inheritors only; use-project-default clears the override; context removal does not reconnect', async () => {
  const { p, w } = await scene('Switching');
  const override = await projects.createWorkspace(ctx, p.id, { name: 'Override', createDefault: true });
  const original = repos.resolve(ctx, p.id, w.id), separate = repos.resolve(ctx, p.id, override.id);
  const next = await repos.setDefault(ctx, p.id, { directory: external() });
  assert.equal(repos.resolve(ctx, p.id, w.id).repoId, next.id);
  assert.equal(repos.resolve(ctx, p.id, override.id).repoId, separate.repoId);
  await projects.unlinkFromWorkspace(ctx, p.id, override.id, separate.libraryId);
  assert.equal(repos.resolve(ctx, p.id, override.id).repoId, separate.repoId);
  await repos.connect(ctx, p.id, override.id, { useProjectDefault: true });
  assert.equal(wsMeta(p, override).repoId, null); assert.equal(repos.resolve(ctx, p.id, override.id).repoId, next.id);
  await repos.connect(ctx, p.id, override.id, { directory: separate.directory });
  assert.equal(repos.resolve(ctx, p.id, override.id).repoId, separate.repoId);
  assert.equal(Object.keys(meta(p).repositories).length, 3); assert.ok(fs.existsSync(original.directory));
});

test('missing explicit override (path, registry ID or archived) never falls back, including after ensure', async () => {
  const { p, w } = await scene('Unavailable');
  const code = external(); await repos.connect(ctx, p.id, w.id, { directory: code });
  fs.renameSync(code, `${code}-missing`); await repos.ensure(ctx, p.id);
  assert.throws(() => repos.resolve(ctx, p.id, w.id), /Repository unavailable/);
  const file = path.join(projects.findWorkspace(ctx, p.id, w.id).workspace.dir, 'meta.json');
  const id = randomUUID(); writeJson(file, { ...readJson(file), repoId: id });
  await repos.ensure(ctx, p.id); assert.equal(readJson(file).repoId, id);
  assert.throws(() => repos.resolve(ctx, p.id, w.id), /override is unavailable/);
  await repos.connect(ctx, p.id, w.id, { useProjectDefault: true });
  const data = meta(p); data.repositories[data.defaultRepoId].archived = true; writeJson(path.join(p.dir, 'project.json'), data);
  await repos.ensure(ctx, p.id); assert.throws(() => repos.resolve(ctx, p.id, w.id), /Choose a project default/);
});

test('a missing project default errors for inheritors but does not block an available override', async () => {
  const { p, w } = await scene('Missing default');
  const other = await projects.createWorkspace(ctx, p.id, { name: 'Other', directory: external() });
  const original = repos.resolve(ctx, p.id, w.id), held = repos.resolve(ctx, p.id, other.id);
  fs.renameSync(original.directory, original.directory + '-unavailable');
  await repos.ensure(ctx, p.id);
  assert.throws(() => repos.resolve(ctx, p.id, w.id), /Repository unavailable/);
  assert.equal(repos.resolve(ctx, p.id, other.id).repoId, held.repoId);
  await assert.rejects(repos.connect(ctx, p.id, other.id, { useProjectDefault: true }), /Repository unavailable/);
  assert.equal(wsMeta(p, other).repoId, held.repoId);
});

test('new-project provisioning recovers before and after the init marker and serializes concurrent loads', async () => {
  for (const interrupted of [false, true]) {
    const dir = path.join(ctx.dataRoot, `Interrupted-${interrupted}`), id = randomUUID();
    fs.mkdirSync(dir);
    writeJson(path.join(dir, 'project.json'), { id, name: `Interrupted ${interrupted}`, schemaVersion: 3, repositories: {}, defaultRepoId: null, repositoryDefaultsMigration: { version: 1, status: 'pending' } });
    const code = path.join(dir, 'code');
    if (interrupted) {
      writeJson(path.join(dir, '.repository-init.json'), { directory: code, repoName: 'Interrupted code' });
      fs.mkdirSync(code); git(code, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(code, 'user.txt'), 'Never auto-commit this'); git(code, 'add', 'user.txt');
    }
    await Promise.all([repos.ensure(ctx, id), repos.ensure(ctx, id)]);
    const p = projects.findProject(ctx, id), first = meta(p), head = git(code, 'rev-parse', 'HEAD');
    assert.equal(first.repositoryDefaultsMigration.status, 'complete');
    assert.equal(first.repositories[first.defaultRepoId].location, 'code');
    assert.equal(Object.keys(first.repositories).length, 1);
    assert.equal(git(code, 'ls-tree', '-r', 'HEAD'), '');
    if (interrupted) assert.match(git(code, 'status', '--porcelain'), /A  user.txt/);
    const catalogBefore = fs.readFileSync(path.join(dir, '.context/catalog.json'), 'utf8');
    await repos.ensure(ctx, id);
    assert.deepEqual(meta(p), first); assert.equal(git(code, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(dir, '.context/catalog.json'), 'utf8'), catalogBefore);
  }
});

test('a legacy project without a repository asks for a default without creating or moving folders', async () => {
  const dir = path.join(ctx.dataRoot, 'Unassigned'), id = randomUUID(), wid = randomUUID();
  fs.mkdirSync(path.join(dir, 'Workspace'), { recursive: true });
  writeJson(path.join(dir, 'project.json'), { id, name: 'Unassigned', schemaVersion: 2, repositories: {} });
  writeJson(path.join(dir, 'Workspace/meta.json'), { id: wid, schemaVersion: 2, repoId: null, custom: 'keep' });
  fs.writeFileSync(path.join(dir, 'Workspace/workspace.md'), 'My existing document');
  await repos.ensure(ctx, id); await repos.ensure(ctx, id);
  const p = projects.findProject(ctx, id);
  assert.equal(meta(p).repositoryDefaultsMigration.status, 'needs-selection');
  assert.throws(() => repos.resolve(ctx, id, wid), /Choose a project default/);
  assert.equal(fs.existsSync(path.join(dir, 'code')), false);
  assert.equal(fs.existsSync(path.join(dir, 'Workspace/code')), false);
  assert.equal(readJson(path.join(dir, 'Workspace/meta.json')).custom, 'keep');
  assert.equal(fs.readFileSync(path.join(dir, 'Workspace/workspace.md'), 'utf8'), 'My existing document');
  await repos.setDefault(ctx, id, { createDefault: true });
  assert.equal(repos.resolve(ctx, id, wid).inherited, true);
});

test('old explicit connections survive an ambiguous default migration and repeated runs do not rewrite files', async () => {
  const p = await projects.createProject(ctx, { name: 'Old connections', directory: external() });
  const w = await projects.createWorkspace(ctx, p.id, { name: 'Workspace' });
  await repos.connect(ctx, p.id, w.id, { createDefault: true });
  const child = await projects.createWorkspace(ctx, p.id, { name: 'Child', parentId: w.id, createDefault: true });
  const data = meta(p), oldDefault = data.defaultRepoId;
  delete data.repositories[oldDefault]; delete data.defaultRepoId; delete data.repositoryDefaultsMigration;
  data.schemaVersion = 2; data.extra = 'preserve'; writeJson(path.join(p.dir, 'project.json'), data);
  const before = [wsMeta(p, w), wsMeta(p, child)];
  await repos.ensure(ctx, p.id);
  assert.equal(meta(p).defaultRepoId, null); assert.equal(meta(p).repositoryDefaultsMigration.status, 'needs-selection');
  assert.deepEqual([wsMeta(p, w), wsMeta(p, child)], before); assert.equal(meta(p).extra, 'preserve');
  const saved = fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8');
  await repos.ensure(ctx, p.id); assert.equal(fs.readFileSync(path.join(p.dir, 'project.json'), 'utf8'), saved);
  await repos.setDefault(ctx, p.id, { repoId: child.repoId });
  assert.equal(repos.resolve(ctx, p.id, w.id).repoId, before[0].repoId);
  const next = await projects.createWorkspace(ctx, p.id, { name: 'Future' });
  assert.equal(repos.resolve(ctx, p.id, next.id).repoId, child.repoId);
});

test('unambiguous legacy project repository becomes default without weakening older overrides', async () => {
  const { p, w } = await scene('Legacy default'), code = external();
  const before = repos.resolve(ctx, p.id, w.id);
  await repos.connect(ctx, p.id, w.id, { repoId: before.repoId });
  const data = meta(p); delete data.defaultRepoId; delete data.repositoryDefaultsMigration; data.directory = code;
  writeJson(path.join(p.dir, 'project.json'), data);
  await repos.ensure(ctx, p.id);
  assert.equal(repos.absolute(p, meta(p).repositories[meta(p).defaultRepoId]), code);
  assert.equal(repos.resolve(ctx, p.id, w.id).repoId, before.repoId);
});

test('Bart freezes code context and durable question provenance across a default change', async () => {
  const { p, w } = await scene('Question snapshot');
  const repository = repos.resolve(ctx, p.id, w.id), ref = { kind: 'workspace', workspaceId: w.id };
  const input = { askId: 'captured-question', workspaceId: w.id, ref, text: 'Explain this code', repository };
  history.begin(ctx, p.id, input, repository);
  const bart = createFakeBart({ readModels: () => DEFAULT_MODELS, delayMs: 50 });
  const waiting = bart.ask(ctx, p.id, input);
  const next = await repos.setDefault(ctx, p.id, { directory: external() });
  const out = await waiting;
  history.finish(ctx, p.id, input.askId, 'answered');
  assert.equal(out.meta.repository.repoId, repository.repoId);
  assert.equal((await buildContext(ctx, p.id, input)).repository.repoId, repository.repoId);
  assert.equal((await buildContext(ctx, p.id, { ...input, repository: undefined })).repository.repoId, next.id);
  const saved = readJson(path.join(p.dir, '.bart/questions/captured-question.json'));
  assert.equal(saved.repository.directory, repository.directory); assert.equal(saved.status, 'answered');
  assert.match(out.lines.at(-1), /code: Question snapshot\*$/);
});
