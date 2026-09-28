'use strict';

// Engelbart's own Git (src/main/tools/bundled-git.cjs, scripts/fetch-git.mjs; 2026-09-28). The second test runs the
// real one when `node scripts/fetch-git.mjs` has put it in vendor/git, and is skipped otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findBundledGit, LAUNCHER } = require('../src/main/tools/bundled-git.cjs');
const { createGit } = require('../src/main/build/git.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-bundled-git-'));
const ROOT = path.join(__dirname, '..');

test('findBundledGit: the app\'s Resources first, then a checkout\'s vendor/git for this architecture; only a launcher that runs', () => {
  const resources = temp();
  const appRoot = temp();
  assert.equal(findBundledGit({ resourcesPath: resources, appRoot, platform: 'darwin', override: '' }), null, 'neither');
  const inCheckout = path.join(appRoot, 'vendor', 'git', 'darwin-arm64', LAUNCHER);
  fs.mkdirSync(path.dirname(inCheckout), { recursive: true });
  fs.writeFileSync(inCheckout, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(findBundledGit({ resourcesPath: resources, appRoot, arch: 'arm64', platform: 'darwin', override: '' }), inCheckout);
  assert.equal(findBundledGit({ resourcesPath: resources, appRoot, arch: 'x64', platform: 'darwin', override: '' }), null, 'the other architecture\'s is not used');
  const inApp = path.join(resources, 'git', LAUNCHER);
  fs.mkdirSync(path.dirname(inApp), { recursive: true });
  fs.writeFileSync(inApp, '#!/bin/sh\n', { mode: 0o644 });
  assert.equal(findBundledGit({ resourcesPath: resources, appRoot, arch: 'arm64', platform: 'darwin', override: '' }), inCheckout, 'not executable: passed over');
  fs.chmodSync(inApp, 0o755);
  assert.equal(findBundledGit({ resourcesPath: resources, appRoot, arch: 'arm64', platform: 'darwin', override: '' }), inApp);
  assert.equal(findBundledGit({ resourcesPath: resources, appRoot, arch: 'arm64', platform: 'win32', override: '' }), null, 'Macs only, for now');
});

const real = findBundledGit({ resourcesPath: null, appRoot: ROOT, override: '' });

test('the real one: Build\'s git commands run on it with nothing set in the environment (its launcher names its helpers and templates)', { skip: !real && 'run `node scripts/fetch-git.mjs` to test the Git that ships with the app' }, async () => {
  const clean = { PATH: '/usr/bin:/bin', HOME: temp() }; // no GIT_EXEC_PATH, and a HOME without a .gitconfig
  const version = execFileSync(real, ['--version'], { env: clean, encoding: 'utf8' });
  assert.match(version, /^git version 2\.\d+/);
  const execPath = execFileSync(real, ['--exec-path'], { env: clean, encoding: 'utf8' }).trim();
  assert.ok(execPath.startsWith(path.dirname(path.dirname(real))), execPath);
  const git = createGit({ gitPath: () => real, environment: clean });
  const repo = temp();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  const first = await git.init(repo);
  assert.match(first.sha, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(repo, '.git', 'hooks')), 'templates were found');
  const worktree = path.join(temp(), 'wt');
  await git.addWorktree(repo, worktree, 'engelbart/test', first.sha);
  fs.writeFileSync(path.join(worktree, 'a.txt'), 'two\n');
  const sha = await git.checkpoint(worktree, 'turn 1', { name: 'Engelbart', email: 'build@engelbart.local' });
  const diff = await git.diff(worktree, first.sha, sha);
  assert.deepEqual(diff.files.map((file) => [file.path, file.adds, file.dels]), [['a.txt', 1, 1]]);
  await git.removeWorktree(repo, worktree);
  assert.ok(await git.deleteBranch(repo, 'engelbart/test'));
});
