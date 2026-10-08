'use strict';

// The project's default repo (src/main/build/manager.cjs, 2026-09-29): project.json keeps it as a target (defaultTarget:
// the code directory or a library row); project.json from before it is converted once, the other branch's registry
// (defaultRepoId → repositories[id].location) first, then this branch's defaultRepo; nothing is moved or deleted. Make
// default changes it; post-its follow it; a default whose row or folder is gone falls back to the code directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome, readJson } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { createGit } = require('../src/main/build/git.cjs');
const { createBuilds } = require('../src/main/build/manager.cjs');
const store = require('../src/main/build/store.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-default-'));
const layout = ensureHome(homeDir);
const environment = { PATH: process.env.PATH, HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), SHELL: '/bin/zsh' };
const git = createGit({ environment });
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Person', '-c', 'user.email=p@example.com', ...args], { cwd, env: environment, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const MODELS = normalizeModels(null);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => { await db.closeAll(); });

let n = 0;
/** A folder with a history: one commit of `files`. */
function repository(dir, files = { 'README.md': 'x\n' }) {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) write(path.join(dir, name), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}
/** A project whose code directory is (`history`) a repository with a commit, or a plain folder; a workspace; `meta` in project.json. */
async function scene({ history = true, meta = {} } = {}) {
  n += 1;
  const code = path.join(homeDir, `code${n}`);
  if (history) repository(code, { 'a.txt': 'a\n' }); else fs.mkdirSync(code);
  const made = await projects.createProject(ctx, { name: `Default ${n}`, directory: code });
  const file = path.join(made.dir, 'project.json');
  fs.writeFileSync(file, JSON.stringify({ ...readJson(file), ...(typeof meta === 'function' ? meta(made) : meta) }, null, 2));
  const workspace = await projects.createWorkspace(ctx, made.id, { name: 'Feature' });
  await projects.writeDoc(ctx, made.id, { kind: 'workspace', workspaceId: workspace.id }, 'Build it.');
  return { code, project: projects.findProject(ctx, made.id), workspace, slug: `default-${n}` };
}
const recordOf = (project) => projects.findProject(ctx, project.id);
const metaOf = (project) => readJson(path.join(project.dir, 'project.json'));
const rowsAt = (folder) => ctx.libraryDb.query('select * from library where folder_path = $1', [folder]);
const historyLog = (project) => { try { return fs.readFileSync(path.join(project.dir, 'builds', 'history.log'), 'utf8'); } catch { return ''; } };
/** What is in a folder, one level down: to show nothing was made, moved or deleted. */
const listing = (dir) => { try { return fs.readdirSync(dir).sort(); } catch { return null; } };

function scripted(steps) {
  return {
    async turn(input) {
      const step = steps.shift();
      if (!step) throw Object.assign(new Error('no more steps'), { kind: 'failed' });
      const out = typeof step === 'function' ? await step(input) : step;
      return { text: out, session: input.session || 'session' };
    },
  };
}
const manager = (runner = scripted([]), extra = {}) => createBuilds({ git, runner, readModels: () => MODELS, runShell: async () => ({ ok: true, output: '' }), ...extra });

async function settled(project, id, not = ['setting-up', 'queued', 'running', 'accepting']) {
  for (let i = 0; i < 500; i += 1) {
    const task = store.readTask(recordOf(project), id);
    if (task && !not.includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the Build never settled');
}

/* ----------------------------------------------------------------------------- migration */

test('defaultRepoId naming the code directory: it is the default, and nothing is made (the registry is left as it was)', async () => {
  const registry = (made) => ({ schemaVersion: 3, defaultRepoId: 'r1', repositories: { r1: { id: 'r1', name: 'code', location: path.join(homeDir, `code${n}`), managed: false, libraryId: null, archived: false } } });
  const { code, project, workspace } = await scene({ meta: registry });
  const before = listing(code);
  const builds = manager(scripted([({ task }) => { write(path.join(task.worktree, 'b.txt'), 'b\n'); return 'Added b.txt.'; }]));
  const list = await builds.targets(ctx, project.id);
  assert.deepEqual(list.map((item) => [item.kind, item.folder, item.place]), [['default', code, 'default']], 'the code directory is not listed again as the project');
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'project' });
  assert.deepEqual([metaOf(project).defaultRepoId, Object.keys(metaOf(project).repositories)], ['r1', ['r1']], 'the registry is untouched');
  const pre = await builds.preflight(ctx, project.id, { kind: 'default' });
  assert.deepEqual([pre.ok, !!pre.create, pre.top], [true, false, code]);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await settled(project, started.id);
  assert.deepEqual([task.status, task.repo, task.source, task.target], ['review', code, code, { kind: 'default', name: path.basename(code) }]);
  await builds.accept(ctx, project.id, task.id);
  assert.equal(fs.readFileSync(path.join(code, 'b.txt'), 'utf8'), 'b\n', 'it lands in the code directory');
  assert.deepEqual(listing(code), [...before, 'b.txt'].sort(), 'no folder named after the project');
  assert.deepEqual(await rowsAt(code), [], 'and no library row');
  assert.equal(historyLog(project), '');
});

test('defaultRepoId naming a location relative to the project\'s data folder: its library row (the registry\'s libraryId) is the default', async () => {
  const location = 'Testing Bart Build/Untitled Workspace 1/code';
  let rowId = null;
  const { code, project, workspace } = await scene({ meta: (made) => { repository(path.join(made.dir, location)); rowId = randomUUID(); return { defaultRepoId: 'r2', repositories: { r2: { id: 'r2', name: 'Untitled Workspace 1 code', location, managed: true, libraryId: rowId, archived: false } } }; } });
  const managed = path.join(project.dir, location);
  const other = await ctx.libraryDb.insert({ id: randomUUID(), name: 'same folder, added first', type: 'folder', tags: ['git'], folder_path: managed });
  const row = await ctx.libraryDb.insert({ id: rowId, name: 'Untitled Workspace 1 code', type: 'folder', tags: ['git'], folder_path: managed, project_id: project.id });
  const builds = manager(scripted([({ task }) => { write(path.join(task.worktree, 'm.txt'), 'm\n'); return 'Added m.txt.'; }]));
  const list = await builds.targets(ctx, project.id);
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'library', id: row.id }, 'the registry\'s own row, not another with the same folder');
  assert.deepEqual(list.map((item) => [item.kind, item.name, item.folder]), [['default', 'Untitled Workspace 1 code', managed], ['project', path.basename(code), code]]);
  assert.ok(!list.some((item) => item.id === row.id || item.id === other.id), 'its folder is listed once');
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await settled(project, started.id);
  assert.deepEqual([task.repo, task.target.name], [managed, 'Untitled Workspace 1 code']);
  await builds.accept(ctx, project.id, task.id);
  assert.ok(fs.existsSync(path.join(managed, 'm.txt')) && !fs.existsSync(path.join(code, 'm.txt')));
  assert.equal(listing(code).includes(`default-${n}`), false);

  // With no row for it yet, one is made (named as the registry names it), the project's.
  const { project: bare } = await scene({ meta: (made) => { repository(path.join(made.dir, 'code')); return { defaultRepoId: 'r3', repositories: { r3: { id: 'r3', name: 'test', location: 'code', managed: true, libraryId: randomUUID(), archived: false } } }; } });
  await manager().targets(ctx, bare.id);
  const [made] = await rowsAt(path.join(bare.dir, 'code'));
  assert.deepEqual([made.name, made.tags, made.project_id], ['test', ['git'], bare.id]);
  assert.deepEqual(recordOf(bare).defaultTarget, { kind: 'library', id: made.id });
});

test('defaultRepo only (a folder this branch made): its library row, made when it has none; converted once', async () => {
  const { code, project } = await scene();
  const folder = repository(path.join(code, 'made-by-build'));
  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...metaOf(project), defaultRepo: 'made-by-build' }, null, 2));
  const builds = manager();
  const [first] = await builds.targets(ctx, project.id);
  const rows = await rowsAt(folder);
  assert.equal(rows.length, 1);
  assert.deepEqual([first.kind, first.folder, recordOf(project).defaultTarget], ['default', folder, { kind: 'library', id: rows[0].id }]);
  assert.equal(metaOf(project).defaultRepo, 'made-by-build', 'the old field stays; defaultTarget is read first');
  await builds.targets(ctx, project.id);
  assert.equal((await rowsAt(folder)).length, 1, 'no second row');

  // A row already there is the one used.
  const { code: code2, project: second } = await scene();
  const folder2 = repository(path.join(code2, 'mine'));
  const theirs = await ctx.libraryDb.insert({ id: randomUUID(), name: 'named by hand', type: 'folder', tags: ['git'], folder_path: folder2 });
  fs.writeFileSync(path.join(second.dir, 'project.json'), JSON.stringify({ ...metaOf(second), defaultRepo: 'mine' }, null, 2));
  assert.deepEqual((await manager().targets(ctx, second.id))[0].name, 'named by hand');
  assert.deepEqual(recordOf(second).defaultTarget, { kind: 'library', id: theirs.id });
});

test('both fields: defaultRepoId wins; the folder defaultRepo made is left where it is and named in the project\'s Build history', async () => {
  const { code, project } = await scene();
  const nested = repository(path.join(code, 'nested'));
  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...metaOf(project), defaultRepo: 'nested', defaultRepoId: 'r4', repositories: { r4: { id: 'r4', name: 'code', location: code, managed: false, archived: false } } }, null, 2));
  const inside = listing(nested);
  const list = await manager().targets(ctx, project.id);
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'project' });
  assert.deepEqual(list[0].folder, code);
  assert.deepEqual(listing(nested), inside, 'nothing moved or deleted');
  const log = historyLog(project).trim().split('\n');
  assert.equal(log.length, 1);
  assert.match(log[0], new RegExp(`^\\S+ The default repo for Builds is now ${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*${nested.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was made as the default repo before and is no longer used by Builds; nothing was moved or deleted\\.$`));
  assert.deepEqual((await rowsAt(nested)).length, 0, 'no row made for the folder that is no longer the default');
  await manager().targets(ctx, project.id);
  assert.equal(historyLog(project).trim().split('\n').length, 1, 'converted once');

  // A registry location that is not a repository of its own does not win: defaultRepo is used.
  const { code: code2, project: second } = await scene();
  const kept = repository(path.join(code2, 'kept'));
  fs.mkdirSync(path.join(second.dir, 'plain'));
  fs.writeFileSync(path.join(second.dir, 'project.json'), JSON.stringify({ ...metaOf(second), defaultRepo: 'kept', defaultRepoId: 'r5', repositories: { r5: { id: 'r5', location: 'plain' } } }, null, 2));
  assert.equal((await manager().targets(ctx, second.id))[0].folder, kept);
  assert.equal(historyLog(second), '');
});

test('a new project with neither: <name> is made by the first Build, once, and kept as its row; the next Build goes there too', async () => {
  const { code, project, workspace, slug } = await scene();
  const builds = manager(scripted(['One.', 'Two.']));
  assert.equal(recordOf(project).defaultTarget, null, 'asking stores nothing');
  const pre = await builds.preflight(ctx, project.id, { kind: 'default' });
  assert.deepEqual([pre.ok, pre.create, pre.directory], [true, true, path.join(code, slug)]);
  const first = await settled(project, (await builds.start(ctx, project.id, { workspaceId: workspace.id })).id);
  const [row] = await rowsAt(path.join(code, slug));
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'library', id: row.id });
  await projects.renameProject(ctx, project.id, 'Renamed');
  const second = await settled(project, (await builds.start(ctx, project.id, { workspaceId: workspace.id })).id);
  assert.deepEqual([first.repo, second.repo], [path.join(code, slug), path.join(code, slug)]);
  assert.deepEqual(listing(code).filter((name) => name.startsWith('default-') || name.startsWith('renamed')), [slug], 'made once, and a rename never moves it');
  assert.equal(sh(path.join(code, slug), 'log', '--format=%s'), 'First snapshot (Engelbart)');
});

/* ---------------------------------------------------------------------------- Make default */

test('Make default: the code directory or a library row on this Mac that can take a Build; refused otherwise, and only project.json changes', async () => {
  const { code, project, workspace, slug } = await scene();
  const lib = repository(path.join(homeDir, `lib-${n}`));
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'lib', type: 'folder', tags: ['git'], folder_path: lib, project_id: project.id });
  const builds = manager(scripted([({ task }) => { write(path.join(task.worktree, 'l.txt'), 'l\n'); return 'Added l.txt.'; }, 'Done.']));
  const before = [listing(code), listing(lib)];

  let list = await builds.setDefault(ctx, project.id, { kind: 'library', id: row.id });
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'library', id: row.id });
  assert.deepEqual(list.map((item) => [item.kind, item.folder]), [['default', lib], ['project', code]], 'the row is listed once, as the default');
  assert.deepEqual([listing(code), listing(lib)], before, 'nothing made, moved or deleted');
  assert.equal(fs.existsSync(path.join(code, slug)), false);
  // Everything that goes to the default follows it: the preflight the panel asks, a Build without a pick, a post-it.
  assert.equal((await builds.preflight(ctx, project.id, { kind: 'default' })).top, lib);
  const quick = await builds.start(ctx, project.id, { kind: 'quick', text: 'fix the typo' });
  const landed = await settled(project, quick.id, ['setting-up', 'queued', 'running', 'review', 'accepting']);
  assert.deepEqual([landed.status, landed.repo, landed.target], ['accepted', lib, { kind: 'default', name: 'lib' }]);
  assert.ok(fs.existsSync(path.join(lib, 'l.txt')), 'the post-it\'s Build landed in the new default');

  list = await builds.setDefault(ctx, project.id, { kind: 'project' });
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'project' });
  assert.deepEqual(list.map((item) => [item.kind, item.id || null, item.folder]), [['default', null, code], ['library', row.id, lib]]);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: 'a post-it added to the workspace' });
  assert.equal((await settled(project, started.id)).repo, code, 'a workspace post-it follows it too');
  // A Build already started keeps where it works.
  assert.equal(store.readTask(recordOf(project), quick.id).repo, lib);

  const refusedAs = async (target, pattern) => {
    await assert.rejects(builds.setDefault(ctx, project.id, target), pattern);
    assert.deepEqual(recordOf(project).defaultTarget, { kind: 'project' }, 'unchanged');
  };
  const github = await ctx.libraryDb.insert({ id: randomUUID(), name: 'example/away', type: 'website', tags: ['git'], url: 'https://github.com/example/away', project_id: project.id });
  await refusedAs({ kind: 'library', id: github.id }, /example\/away is not on this Mac yet\./);
  const plain = path.join(homeDir, `plain-${n}`);
  write(path.join(plain, 'notes.txt'), 'no history\n');
  const noHistory = await ctx.libraryDb.insert({ id: randomUUID(), name: 'plain', type: 'folder', tags: ['git'], folder_path: plain, project_id: project.id });
  await refusedAs({ kind: 'library', id: noHistory.id }, /This folder has no history yet\./);
  assert.equal(fs.existsSync(path.join(plain, '.git')), false, 'never git-initialised');
  const gone = await ctx.libraryDb.insert({ id: randomUUID(), name: 'gone', type: 'folder', tags: ['git'], folder_path: path.join(homeDir, 'nowhere'), project_id: project.id });
  await refusedAs({ kind: 'library', id: gone.id }, /gone's folder is gone\./);
  await refusedAs({ kind: 'library', id: randomUUID() }, /not in the library/);
  await refusedAs({ kind: 'default' }, /Choose the code directory or a repository from the library/);
  await refusedAs(null, /Choose the code directory or a repository from the library/);

  const { project: flat } = await scene({ history: false });
  await assert.rejects(manager().setDefault(ctx, flat.id, { kind: 'project' }), /This folder has no history yet\./);
  assert.equal(recordOf(flat).defaultTarget, null);
});

/* ------------------------------------------------------------------------------- fallback */

test('a default whose row is deleted or whose folder is gone: the code directory when it has a history (kept once a Build starts), else a new folder', async () => {
  const { code, project, workspace, slug } = await scene();
  const lib = repository(path.join(homeDir, `lib-${n}`));
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'lib', type: 'folder', tags: ['git'], folder_path: lib, project_id: project.id });
  const builds = manager(scripted(['Done.', 'Done again.']));
  await builds.setDefault(ctx, project.id, { kind: 'library', id: row.id });
  await ctx.libraryDb.remove(row.id);
  const list = await builds.targets(ctx, project.id);
  assert.deepEqual(list.map((item) => [item.kind, item.folder]), [['default', code]]);
  const pre = await builds.preflight(ctx, project.id, { kind: 'default' });
  assert.deepEqual([pre.ok, !!pre.create, pre.top], [true, false, code]);
  const task = await settled(project, (await builds.start(ctx, project.id, { workspaceId: workspace.id })).id);
  assert.equal(task.repo, code);
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'project' }, 'the fallback is kept');
  assert.equal(fs.existsSync(path.join(code, slug)), false);

  // No history in the code directory: a folder is made as for a new project, and kept.
  const { code: flat, project: second, workspace: ws2, slug: slug2 } = await scene({ history: false });
  const away = repository(path.join(homeDir, `away-${n}`));
  const row2 = await ctx.libraryDb.insert({ id: randomUUID(), name: 'away', type: 'folder', tags: ['git'], folder_path: away, project_id: second.id });
  await builds.setDefault(ctx, second.id, { kind: 'library', id: row2.id });
  fs.renameSync(away, `${away}-moved`); // its folder is gone
  const pre2 = await builds.preflight(ctx, second.id, { kind: 'default' });
  assert.deepEqual([pre2.ok, pre2.create, pre2.directory], [true, true, path.join(flat, slug2)]);
  const task2 = await settled(second, (await builds.start(ctx, second.id, { workspaceId: ws2.id })).id);
  assert.equal(task2.repo, path.join(flat, slug2));
  const [made] = await rowsAt(path.join(flat, slug2));
  assert.deepEqual(recordOf(second).defaultTarget, { kind: 'library', id: made.id });
  assert.ok(fs.existsSync(`${away}-moved`) && !fs.existsSync(path.join(`${away}-moved`, slug2)), 'the moved folder is left alone');
});

test('a default the person chose is never git-initialised: a folder that lost its history is refused, as any other repository would be', async () => {
  const { project, workspace } = await scene();
  const lib = repository(path.join(homeDir, `lib-${n}`));
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'lib', type: 'folder', tags: ['git'], folder_path: lib, project_id: project.id });
  const builds = manager(scripted([]));
  await builds.setDefault(ctx, project.id, { kind: 'library', id: row.id });
  fs.rmSync(path.join(lib, '.git'), { recursive: true, force: true });
  const pre = await builds.preflight(ctx, project.id, { kind: 'default' });
  assert.deepEqual([pre.ok, !!pre.create, pre.problems[0].code], [false, false, 'not-a-repository']);
  await assert.rejects(builds.start(ctx, project.id, { workspaceId: workspace.id }), /This folder has no history yet\./);
  assert.equal(fs.existsSync(path.join(lib, '.git')), false);
  // Picked in the panel instead, it is given a history when the Build starts, as any folder picked there is (2026-09-29).
  const picked = await manager(scripted(['Looked.'])).start(ctx, project.id, { workspaceId: workspace.id, target: { kind: 'library', id: row.id } });
  assert.equal((await settled(project, picked.id)).repo, lib);
  assert.match(sh(lib, 'log', '-1', '--format=%s'), /First snapshot \(Engelbart\)/);
  assert.deepEqual(recordOf(project).defaultTarget, { kind: 'library', id: row.id }, 'the default is unchanged');
});
