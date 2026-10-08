'use strict';

// What a Build's agent may reach (2026-10-07, "Bart build agents"; src/main/build/policy.cjs): the git ban enforced
// (git-guard.cjs, git.cjs holdBranch), the library's files put back after a turn (keep.cjs), and Engelbart's own tools
// for saving, duplicating and moving files into the library (engelbart-tools.cjs), against real git and a real library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { prepareGitGuard, gitCommonDir, guardEnvironment, guardPath } = require('../src/main/build/git-guard.cjs');
const { createGit } = require('../src/main/build/git.cjs');
const { keepLibrary } = require('../src/main/build/keep.cjs');
const { createEngelbartTools, validateEngelbartTool, ENGELBART_TOOLS } = require('../src/main/build/engelbart-tools.cjs');
const { openToolBridge } = require('../src/main/sandbox/local-tools.cjs');

const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-reach-')));
const layout = ensureHome(homeDir);
const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/.test(key)));
const who = { GIT_AUTHOR_NAME: 'Person', GIT_AUTHOR_EMAIL: 'p@example.com', GIT_COMMITTER_NAME: 'Person', GIT_COMMITTER_EMAIL: 'p@example.com' };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...plainEnv, ...who }, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => { await db.closeAll(); });

/** A repository (the person's folder) with one commit, a Build's worktree of it on its own branch, another repository. */
function repositories(name) {
  const base = path.join(homeDir, name);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'a.txt'), 'a\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-qm', 'one');
  sh(repo, 'config', 'core.hooksPath', '.husky'); // a repository's own hooks folder, as husky sets it
  sh(repo, 'config', 'alias.ci', 'commit');
  const worktree = path.join(base, 'wt');
  sh(repo, 'worktree', 'add', '-q', '-b', 'engelbart/abc', worktree);
  const other = path.join(base, 'other');
  fs.mkdirSync(other);
  sh(other, 'init', '-q', '-b', 'main');
  return { repo, worktree, other };
}

/* --------------------------------------------------------------------- the git ban */

test('the git guard: history, branches, stashes, settings and pushes of the Build\'s repository are refused; reading, files and other repositories are not', () => {
  const { repo, worktree, other } = repositories('guard');
  const guard = prepareGitGuard(path.join(homeDir, 'guard-files'));
  const gitDir = gitCommonDir(worktree);
  assert.equal(gitDir, fs.realpathSync(path.join(repo, '.git')), 'the worktree\'s shared git folder, read from its files');
  assert.equal(gitCommonDir(repo), gitDir);
  assert.equal(gitCommonDir(homeDir), null);
  const env = { ...plainEnv, ...who, PATH: `${guard.bin}:${plainEnv.PATH}`, ...guardEnvironment(guard, gitDir, plainEnv) };
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  const refused = (out) => out.status !== 0 && /Engelbart: /.test(out.stderr);
  assert.equal(spawnSync('/bin/sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).stdout.trim(), path.join(guard.bin, 'git'), 'first on PATH');
  write(path.join(worktree, 'b.txt'), 'b\n');
  // reading and file commands
  for (const args of [['status', '--short'], ['diff'], ['log', '--oneline', '-1'], ['add', 'b.txt'], ['branch'], ['branch', '--show-current'], ['config', 'user.name'], ['config', '--get', 'core.hooksPath'], ['remote', '-v'], ['stash', 'list'], ['tag', '-l'], ['reset', '--', 'b.txt'], ['checkout', '--', 'a.txt'], ['reset', '--hard'], ['--version']]) {
    const out = git(worktree, ...args);
    assert.equal(out.status, 0, `git ${args.join(' ')}: ${out.stderr}`);
  }
  // what writes history, refs or settings, from the worktree, the person's folder, or through an alias
  write(path.join(worktree, 'b.txt'), 'b\n');
  for (const [cwd, args] of [[worktree, ['commit', '-am', 'x']], [worktree, ['ci', '-m', 'x']], [worktree, ['checkout', '-b', 'other']], [worktree, ['switch', 'main']], [worktree, ['branch', 'new']], [worktree, ['stash']], [worktree, ['config', 'user.name', 'Bob']], [worktree, ['remote', 'add', 'o', 'https://example.com/r.git']], [worktree, ['reset', 'HEAD~1']], [worktree, ['tag', 'v1']], [worktree, ['merge', 'main']], [worktree, ['rebase', 'main']], [worktree, ['fetch']], [worktree, ['-C', repo, 'commit', '--allow-empty', '-m', 'x']], [repo, ['commit', '--allow-empty', '-m', 'x']]]) {
    assert.ok(refused(git(cwd, ...args)), `git ${args.join(' ')} in ${path.basename(cwd)}`);
  }
  assert.ok(refused(git(other, 'push')), 'nothing is pushed from a Build, from any repository');
  assert.equal(sh(worktree, 'rev-parse', 'HEAD'), sh(repo, 'rev-parse', 'main'), 'no commit was made');
  assert.equal(spawnSync('git', ['config', '--local', 'user.name'], { cwd: repo, encoding: 'utf8', env: plainEnv }).stdout, '', 'the repository\'s settings are as they were');
  // a git that is not the guard (an absolute path, a PATH rebuilt by a startup file) meets the hooks instead
  const real = spawnSync('/bin/sh', ['-c', 'command -v git'], { env: plainEnv, encoding: 'utf8' }).stdout.trim();
  for (const args of [['commit', '--allow-empty', '-m', 'x'], ['branch', 'new'], ['-c', 'alias.c=commit', 'c', '--allow-empty', '-m', 'x']]) {
    const out = spawnSync(real, args, { cwd: worktree, env, encoding: 'utf8' });
    assert.ok(out.status !== 0 && /Engelbart: refs\/heads\/\S+ cannot change/.test(out.stderr), `${real} ${args.join(' ')}: ${out.stderr}`);
  }
  assert.equal(spawnSync(real, ['reset', '-q', '--hard'], { cwd: worktree, env }).status, 0, 'a ref written as it was is not a change');
  const pushed = spawnSync(real, ['push', '--no-verify', 'https://example.com/nobody/none.git', 'HEAD'], { cwd: other, env, encoding: 'utf8' });
  assert.ok(pushed.status !== 0 && /engelbart-no-push/.test(pushed.stderr), 'a push to the network fails everywhere, --no-verify or not');
  // another repository works as it always did: commits, settings, its own hooks
  write(path.join(other, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho own-hook-ran >&2\n');
  fs.chmodSync(path.join(other, '.git', 'hooks', 'pre-commit'), 0o755);
  const own = git(other, 'commit', '--allow-empty', '-m', 'mine');
  assert.equal(own.status, 0, own.stderr);
  assert.match(own.stderr, /own-hook-ran/, 'its own hooks run');
  assert.equal(git(other, 'config', 'user.name', 'Bob').status, 0);
  assert.equal(guardPath('/bin/zsh'), 'PATH="$ENGELBART_BUILD_GUARD:$PATH"; ');
  assert.equal(guardPath('/opt/homebrew/bin/fish'), 'set -gx PATH $ENGELBART_BUILD_GUARD $PATH; ');
  assert.match(guardEnvironment(guard, gitDir, { GIT_CONFIG_PARAMETERS: "'their.key'='v'" }).GIT_CONFIG_PARAMETERS, / 'their\.key'='v'$/, 'the person\'s own come after');
});

test('holdBranch: a worktree its agent moved is put back on its branch where the turn started, its files kept for the checkpoint', async () => {
  const { worktree } = repositories('hold');
  const git = createGit({ environment: plainEnv });
  const start = sh(worktree, 'rev-parse', 'HEAD');
  assert.deepEqual(await git.holdBranch(worktree, 'engelbart/abc', start), { branch: false, commits: false }, 'nothing to put right');
  write(path.join(worktree, 'c.txt'), 'c\n');
  sh(worktree, 'add', 'c.txt');
  sh(worktree, 'commit', '-qm', 'the agent\'s own');
  sh(worktree, 'checkout', '-q', '-b', 'elsewhere');
  write(path.join(worktree, 'd.txt'), 'd\n');
  assert.deepEqual(await git.holdBranch(worktree, 'engelbart/abc', start), { branch: true, commits: true });
  assert.equal(sh(worktree, 'symbolic-ref', '--short', 'HEAD'), 'engelbart/abc');
  assert.equal(sh(worktree, 'rev-parse', 'HEAD'), start);
  const sha = await git.checkpoint(worktree, 'Build: turn 1', { name: 'Engelbart', email: 'build@engelbart.local' });
  assert.equal(sh(worktree, 'rev-parse', `${sha}^`), start, 'the checkpoint sits on where the turn started');
  assert.deepEqual(sh(worktree, 'show', '--name-only', '--format=', sha).split('\n').sort(), ['c.txt', 'd.txt'], 'and holds what the agent did');
  // a merge it was given to conclude (a conflict sent to the agent) and concluded is kept
  sh(worktree, 'checkout', '-q', '-b', 'side', start);
  write(path.join(worktree, 'e.txt'), 'e\n');
  sh(worktree, 'add', 'e.txt');
  sh(worktree, 'commit', '-qm', 'side');
  sh(worktree, 'checkout', '-q', 'engelbart/abc');
  const before = sh(worktree, 'rev-parse', 'HEAD');
  sh(worktree, 'merge', '-q', '--no-ff', '--no-commit', 'side');
  sh(worktree, 'commit', '-qm', 'merged by the agent');
  assert.deepEqual(await git.holdBranch(worktree, 'engelbart/abc', before, { merging: true }), { branch: false, commits: false });
  assert.notEqual(sh(worktree, 'rev-parse', 'HEAD'), before);
});

/* ------------------------------------------------------------------- papers kept */

test('keepLibrary: a library file the agent deleted, and a paper it changed, are put back; a note it edited, and what the person removed meanwhile, are not', async () => {
  const project = await projects.createProject(ctx, { name: 'Keep' });
  const saved = path.join(ctx.dataRoot, 'assets', 'pdfs', 'saved.pdf');
  const downloaded = path.join(homeDir, 'Downloads', 'paper.pdf');
  write(saved, PDF);
  write(downloaded, PDF);
  const rows = {
    saved: await ctx.libraryDb.insert({ id: '7a000000-0000-4000-8000-000000000001', name: 'Saved paper', type: 'pdf', path: saved }),
    downloaded: await ctx.libraryDb.insert({ id: '7a000000-0000-4000-8000-000000000002', name: 'Downloaded paper', type: 'pdf', path: downloaded }),
    gone: await ctx.libraryDb.insert({ id: '7a000000-0000-4000-8000-000000000003', name: 'Removed by the person', type: 'pdf', path: path.join(homeDir, 'Downloads', 'gone.pdf') }),
  };
  write(rows.gone.path, PDF);
  const edited = await projects.createNote(ctx, project.id, { name: 'Edited note', text: 'before' });
  const deleted = await projects.createNote(ctx, project.id, { name: 'Deleted note', text: 'keep me' });
  const ink = path.join(ctx.dataRoot, 'annotations', `${rows.saved.id}.json`);
  write(ink, '{"marks":[]}');
  const dir = path.join(homeDir, 'keep-1');
  const keeping = await keepLibrary(ctx, { dir, kept: [path.join(ctx.dataRoot, 'assets')] });
  assert.ok(keeping.count >= 6);
  assert.ok(keeping.papers.includes(downloaded) && !keeping.papers.includes(saved), 'papers outside the saved copies, for the edit tools\' rules');
  // the agent's turn
  fs.rmSync(saved);
  fs.writeFileSync(`${downloaded}.new`, 'not a paper any more');
  fs.renameSync(`${downloaded}.new`, downloaded); // replaced, as most programs write a file
  const editedFile = path.join(project.dir, 'Edited note.md');
  fs.writeFileSync(editedFile, 'after');
  fs.rmSync(path.join(project.dir, 'Deleted note.md'));
  fs.rmSync(ink);
  fs.rmSync(rows.gone.path);
  // meanwhile the person removed a row
  await ctx.libraryDb.remove(rows.gone.id);
  const back = await keeping.restore();
  assert.deepEqual(back.map((entry) => `${entry.how} ${entry.name}`).sort(), ['changed Downloaded paper', 'deleted Deleted note', 'deleted Saved paper', 'deleted highlights and notes']);
  assert.deepEqual(fs.readFileSync(saved), PDF);
  assert.deepEqual(fs.readFileSync(downloaded), PDF);
  assert.equal(fs.readFileSync(path.join(project.dir, 'Deleted note.md'), 'utf8'), 'keep me');
  assert.equal(fs.readFileSync(editedFile, 'utf8'), 'after', 'a note the agent edited is its work');
  assert.equal(fs.readFileSync(ink, 'utf8'), '{"marks":[]}');
  assert.ok(!fs.existsSync(rows.gone.path), 'a row the person removed is not put back');
  assert.ok(!fs.existsSync(dir), 'nothing kept stays');
  assert.ok(edited.id && deleted.id);
});

/* --------------------------------------------------------------- into Engelbart */

test('Engelbart\'s tools: save_file, duplicate_file and move_file_into_engelbart make library items linked to the Build\'s workspace', async () => {
  const project = await projects.createProject(ctx, { name: 'Tools' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  const { repo, worktree } = repositories('tools');
  const task = { workspaceId: workspace.id, worktree, cwd: worktree, repo, source: repo };
  const added = [];
  const call = createEngelbartTools({ ctx, projectId: project.id, task, onAdded: (row) => added.push(row.id) });
  const linked = () => projects.findWorkspace(ctx, project.id, workspace.id).workspace.context;
  assert.deepEqual(ENGELBART_TOOLS.map((tool) => tool.name), ['save_file', 'duplicate_file', 'move_file_into_engelbart']);
  assert.throws(() => validateEngelbartTool('save_file', { name: 'x' }), /Invalid tool arguments/);
  assert.throws(() => validateEngelbartTool('save_file', { name: 'x', content: 'y', format: 'exe' }), /format must be one of/);
  assert.throws(() => validateEngelbartTool('delete_file', {}), /Unknown/);
  // save_file: a note, and a dataset
  const note = await call('save_file', { name: 'Findings', content: '# Findings\n' });
  assert.equal(note.type, 'md');
  assert.equal(fs.readFileSync(note.path, 'utf8'), '# Findings\n');
  assert.equal(path.dirname(note.path), project.dir, 'a note of the project');
  const table = await call('save_file', { name: 'Results', content: 'a,b\n1,2\n', format: 'csv' });
  assert.equal(table.type, 'csv');
  assert.ok(table.path.startsWith(path.join(ctx.dataRoot, 'assets', 'files') + path.sep) && table.path.endsWith('Results.csv'));
  // duplicate_file: by id, by path
  const copy = await call('duplicate_file', { item: note.id });
  assert.deepEqual([copy.name, fs.readFileSync(copy.path, 'utf8')], ['Findings copy', '# Findings\n']);
  const tableCopy = await call('duplicate_file', { item: table.path, name: 'Results again' });
  assert.notEqual(tableCopy.path, table.path);
  await assert.rejects(call('duplicate_file', { item: path.join(worktree, 'a.txt') }), /not an item of the library/);
  // move_file_into_engelbart: a paper the agent downloaded into its copy is moved; one in the person's folder is copied
  write(path.join(worktree, 'downloads', 'paper.pdf'), PDF);
  const paper = await call('move_file_into_engelbart', { path: 'downloads/paper.pdf', name: 'A paper' });
  assert.deepEqual([paper.type, paper.name, paper.original], ['pdf', 'A paper', 'removed']);
  assert.ok(paper.path.startsWith(path.join(ctx.dataRoot, 'assets', 'pdfs')));
  assert.deepEqual(fs.readFileSync(paper.path), PDF);
  assert.ok(!fs.existsSync(path.join(worktree, 'downloads', 'paper.pdf')));
  write(path.join(repo, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const figure = await call('move_file_into_engelbart', { path: path.join(repo, 'figure.svg') });
  assert.equal(figure.original, 'kept: it is in the person\'s own folder');
  assert.ok(fs.existsSync(path.join(repo, 'figure.svg')));
  write(path.join(homeDir, 'Desktop', 'notes.md'), 'from the desktop');
  const kept = await call('move_file_into_engelbart', { path: '~/Desktop/notes.md', keep_original: true });
  assert.deepEqual([kept.type, kept.original], ['md', 'kept, as asked']);
  await assert.rejects(call('move_file_into_engelbart', { path: paper.path }), /already in the library as “A paper”/);
  await assert.rejects(call('move_file_into_engelbart', { path: path.join(worktree, 'a.txt') }), /does not keep \.txt/);
  // every item is in the library, linked to the workspace, and announced
  const ids = [note, table, copy, tableCopy, paper, figure, kept].map((row) => row.id);
  for (const id of ids) assert.ok(await ctx.libraryDb.get(id));
  assert.ok(ids.every((id) => linked().includes(id)));
  assert.deepEqual(added, ids);
  // through the bridge, as the MCP server reaches it
  const bridge = await openToolBridge(call);
  try {
    const response = await fetch(bridge.connection.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'save_file', args: { name: 'Over the bridge', content: 'hi' } }) });
    const out = await response.json();
    assert.equal(JSON.parse(out.content[0].text).name, 'Over the bridge');
  } finally {
    await bridge.close();
  }
});
