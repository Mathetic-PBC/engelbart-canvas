'use strict';

// Build's git layer (src/main/build/git.cjs) against real repositories in a temp folder: the commands Accept and Discard
// depend on, and the refusals the person sees. The global git config is hidden (HOME is a temp folder), so the identity
// fallback is what a machine without a git name would get.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createGit, GitError, FALLBACK_NAME, credentialEnv } = require('../src/main/build/git.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-build-git-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
const environment = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
const git = createGit({ environment });
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Person', '-c', 'user.email=p@example.com', ...args], { cwd, env: environment, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
let n = 0;

function repo() {
  n += 1;
  const dir = path.join(root, `repo${n}`);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  write(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  write(path.join(dir, 'b.txt'), 'bee\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

async function build(dir, id = `t${n}`) {
  const start = await git.head(dir);
  const worktree = path.join(root, 'worktrees', `${path.basename(dir)}-${id}`);
  await git.addWorktree(dir, worktree, `engelbart/${id}`, start.sha);
  return { worktree, branch: `engelbart/${id}`, base: start.sha, target: start.branch };
}

test('head, uncommitted paths and the identity fallback', async () => {
  const dir = repo();
  const at = await git.head(dir);
  assert.equal(at.branch, 'main');
  assert.match(at.sha, /^[0-9a-f]{40}$/);
  write(path.join(dir, 'a.txt'), 'changed\n');
  write(path.join(dir, 'new dir', 'c.txt'), 'new\n');
  assert.deepEqual((await git.dirtyPaths(dir)).sort(), ['a.txt', 'new dir/c.txt']);
  assert.deepEqual(await git.identity(dir), { name: FALLBACK_NAME, email: 'build@engelbart.local', own: false });
  sh(dir, 'config', 'user.name', 'Hudson');
  sh(dir, 'config', 'user.email', 'h@example.com');
  assert.deepEqual(await git.identity(dir), { name: 'Hudson', email: 'h@example.com', own: true });
});

test('a worktree on its own branch: checkpoints, a diff from the start, the person\'s folder untouched', async () => {
  const dir = repo();
  write(path.join(dir, 'b.txt'), 'the person is mid-edit\n');
  const b = await build(dir);
  assert.equal(fs.readFileSync(path.join(b.worktree, 'b.txt'), 'utf8'), 'bee\n', 'the build starts from the last commit, not from uncommitted edits');
  const who = await git.identity(b.worktree);
  assert.equal(await git.checkpoint(b.worktree, 'nothing', who), null, 'no change, no commit');
  write(path.join(b.worktree, 'a.txt'), 'one\nTWO\nthree\n');
  write(path.join(b.worktree, 'docs', 'new.md'), '# new\n');
  const first = await git.checkpoint(b.worktree, 'Build t: turn 1', who);
  assert.match(first, /^[0-9a-f]{40}$/);
  fs.renameSync(path.join(b.worktree, 'b.txt'), path.join(b.worktree, 'bee.txt'));
  await git.checkpoint(b.worktree, 'Build t: turn 2', who);
  const d = await git.diff(b.worktree, b.base);
  assert.deepEqual(d.files.map((f) => `${f.status} ${f.path}${f.was ? ` < ${f.was}` : ''}`).sort(), ['A docs/new.md', 'M a.txt', 'R bee.txt < b.txt']);
  assert.deepEqual(d.files.find((f) => f.path === 'a.txt').adds, 1);
  assert.match(d.patch, /-two\n\+TWO/);
  assert.equal(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'the person is mid-edit\n');
  assert.equal((await git.head(dir)).branch, 'main');
});

test('Accept: one commit on the person\'s branch, replayed past what they committed meanwhile, then a fast-forward', async () => {
  const dir = repo();
  const b = await build(dir);
  const who = await git.identity(b.worktree);
  write(path.join(b.worktree, 'a.txt'), 'one\nTWO\nthree\n');
  await git.checkpoint(b.worktree, 'turn 1', who);
  write(path.join(b.worktree, 'c.txt'), 'see\n');
  await git.checkpoint(b.worktree, 'turn 2', who);
  // the person commits something else in the meantime, and keeps an unrelated uncommitted edit
  write(path.join(dir, 'b.txt'), 'bee and more\n');
  sh(dir, 'commit', '-qam', 'theirs');
  write(path.join(dir, 'notes.txt'), 'scratch\n');
  const target = await git.head(dir);
  const base = await git.mergeBase(b.worktree, b.branch, target.sha);
  const sha = await git.squashOnto(b.worktree, { branch: b.branch, base, onto: target.sha, message: 'Build title\n\nWhat the agent said.', who });
  await git.fastForward(dir, { branch: 'main', expected: target.sha, sha });
  const log = sh(dir, 'log', '--format=%s', '-3').split('\n');
  assert.deepEqual(log, ['Build title', 'theirs', 'init'], 'the two checkpoints are one commit, on top of theirs');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\nTWO\nthree\n');
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'see\n');
  assert.equal(fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8'), 'scratch\n', 'an unrelated uncommitted file is left alone');
  assert.equal(sh(dir, 'log', '-1', '--format=%B'), 'Build title\n\nWhat the agent said.');
  await git.removeWorktree(dir, b.worktree);
  assert.ok(await git.deleteBranch(dir, b.branch));
  assert.ok(!fs.existsSync(b.worktree));
  assert.equal(await git.branchExists(dir, b.branch), false);
});

test('Accept refuses, and changes nothing, on a conflict, on the person\'s overlapping edits, and when their folder moved', async () => {
  const dir = repo();
  const b = await build(dir);
  const who = await git.identity(b.worktree);
  write(path.join(b.worktree, 'a.txt'), 'one\nBUILD\nthree\n');
  const tip = await git.checkpoint(b.worktree, 'turn 1', who);
  write(path.join(dir, 'a.txt'), 'one\nPERSON\nthree\n');
  sh(dir, 'commit', '-qam', 'theirs');
  const target = await git.head(dir);
  const base = await git.mergeBase(b.worktree, b.branch, target.sha);
  await assert.rejects(git.squashOnto(b.worktree, { branch: b.branch, base, onto: target.sha, message: 'm', who }), (error) => error instanceof GitError && error.code === 'conflict' && error.files.join() === 'a.txt');
  assert.equal((await git.head(b.worktree)).branch, b.branch, 'the worktree is back on its branch');
  assert.equal((await git.head(b.worktree)).sha, tip, 'with its checkpoints');

  // the agent resolves it: the person's branch merged in, the markers left for it, then concluded
  const files = await git.mergeInto(b.worktree, target.sha, who);
  assert.deepEqual(files, ['a.txt']);
  assert.match(fs.readFileSync(path.join(b.worktree, 'a.txt'), 'utf8'), /<<<<<<<[\s\S]*BUILD[\s\S]*PERSON|<<<<<<<[\s\S]*PERSON[\s\S]*BUILD/);
  write(path.join(b.worktree, 'a.txt'), 'one\nBUILD AND PERSON\nthree\n');
  await git.concludeMerge(b.worktree, 'resolved', who);
  const base2 = await git.mergeBase(b.worktree, b.branch, target.sha);
  assert.equal(base2, target.sha, 'the branch now holds theirs');
  const sha = await git.squashOnto(b.worktree, { branch: b.branch, base: base2, onto: target.sha, message: 'resolved build', who });

  // their uncommitted edit to the same file: git refuses and names it
  write(path.join(dir, 'a.txt'), 'uncommitted by the person\n');
  await assert.rejects(git.fastForward(dir, { branch: 'main', expected: target.sha, sha }), (error) => error.code === 'overwrite' && error.files.join() === 'a.txt');
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'uncommitted by the person\n');
  sh(dir, 'checkout', '-q', '--', 'a.txt');
  // their folder moved on in between
  write(path.join(dir, 'b.txt'), 'moved\n');
  sh(dir, 'commit', '-qam', 'moved');
  await assert.rejects(git.fastForward(dir, { branch: 'main', expected: target.sha, sha }), (error) => error.code === 'moved');
});

test('a file the Build adds that already sits untracked in the person\'s folder is named', async () => {
  const dir = repo();
  const b = await build(dir);
  const who = await git.identity(b.worktree);
  write(path.join(b.worktree, 'report.md'), 'from the build\n');
  await git.checkpoint(b.worktree, 'turn 1', who);
  write(path.join(dir, 'report.md'), 'the person\'s own\n');
  const target = await git.head(dir);
  const sha = await git.squashOnto(b.worktree, { branch: b.branch, base: target.sha, onto: target.sha, message: 'm', who });
  await assert.rejects(git.fastForward(dir, { branch: 'main', expected: target.sha, sha }), (error) => error.code === 'overwrite' && error.files.join() === 'report.md');
});

test('a folder with no history gets one', async () => {
  const dir = path.join(root, 'plain');
  write(path.join(dir, 'index.js'), 'console.log(1)\n');
  write(path.join(dir, 'node_modules', 'x', 'i.js'), 'x\n');
  const at = await git.init(dir);
  assert.match(at.sha, /^[0-9a-f]{40}$/);
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n')[0], 'node_modules/');
  assert.deepEqual(sh(dir, 'ls-files').split('\n').sort(), ['.gitignore', 'index.js']);
  assert.deepEqual(await git.dirtyPaths(dir), []);
});

test('a clone with the GitHub sign-in: its helper answers https://github.com alone, the person\'s own helpers are left out, and nothing is kept (2026-09-29)', async () => {
  // A helper of the person's own (their keychain, say) that would answer anything.
  const theirs = path.join(root, 'their-helper.sh');
  write(theirs, '#!/bin/sh\ntest "$1" = get && printf "username=person\\npassword=their-password\\n"\n');
  fs.chmodSync(theirs, 0o755);
  fs.writeFileSync(path.join(home, '.gitconfig'), `[credential]\n\thelper = ${theirs.split(path.sep).join('/')}\n`); // a config's \ is an escape
  const fill = (host, extra) => {
    try { return execFileSync('git', ['credential', 'fill'], { input: `protocol=https\nhost=${host}\n\n`, env: { ...environment, GIT_TERMINAL_PROMPT: '0', ...extra }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 }); } catch { return null; }
  };
  const signedIn = { ...credentialEnv(), ENGELBART_GITHUB_TOKEN: 'ghu_test_token' };
  assert.match(fill('github.com', signedIn), /username=x-access-token\npassword=ghu_test_token\n/);
  assert.equal(fill('example.com', signedIn), null, 'the sign-in goes to github.com alone, and their helper is not asked');
  assert.match(fill('example.com', {}), /password=their-password/, 'without the sign-in, their own helper as always');
  fs.rmSync(path.join(home, '.gitconfig'));

  // The clone itself: the token only in that command's environment, the clone's config without it.
  const origin = repo();
  const seen = [];
  const spy = createGit({ environment, run: (file, args, options, done) => { seen.push({ args, env: options.env }); return require('node:child_process').execFile(file, args, options, done); } });
  const into = path.join(root, 'clones', 'app');
  await spy.clone(origin, into, { token: 'ghu_test_token' });
  assert.ok(fs.existsSync(path.join(into, 'a.txt')));
  assert.ok(!seen[0].args.join(' ').includes('ghu_test_token'), 'never on the command line');
  assert.equal(seen[0].env.ENGELBART_GITHUB_TOKEN, 'ghu_test_token');
  assert.ok(!fs.readFileSync(path.join(into, '.git', 'config'), 'utf8').includes('ghu_test_token'), 'never kept in the clone');
  assert.ok(!fs.readFileSync(path.join(into, '.git', 'config'), 'utf8').includes('helper'));
  await spy.clone(origin, path.join(root, 'clones', 'plain'));
  assert.equal(seen.at(-1).env.ENGELBART_GITHUB_TOKEN, undefined, 'signed out: nothing of it');
});
