'use strict';

// Whether a project's code directory can take a Build (2026-09-23; design D17). Read from the .git
// folder itself, without running git, so it answers even while Git is missing or busy. Nothing calls it
// until Build exists; it is here so Build starts from every case Bart listed:
// not a repository, no commit yet, a detached HEAD, a merge/rebase/cherry-pick/revert/bisect under
// way, a lock left by a crashed git, submodules, Git LFS, and the free space a worktree will need.

const fs = require('node:fs');
const path = require('node:path');

const OPERATIONS = [
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['BISECT_LOG', 'bisect'],
];
const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const exists = (file) => { try { fs.statSync(file); return true; } catch { return false; } };
const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

/** The folder holding the repository's files for `dir`, and the working tree's top: walks up like git does. */
function findGitDir(dir) {
  let at = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(at, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { stat = null; }
    if (stat && stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit, top: at };
    if (stat && stat.isFile()) {
      // A linked worktree or a submodule: ".git" is a file naming the real one.
      const named = /^gitdir:\s*(.+)$/m.exec(read(dotGit) || '');
      if (named) {
        const gitDir = path.resolve(at, named[1].trim());
        const common = read(path.join(gitDir, 'commondir'));
        return { gitDir, commonDir: common ? path.resolve(gitDir, common.trim()) : gitDir, top: at };
      }
    }
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

function refExists(commonDir, ref) {
  if (exists(path.join(commonDir, ref))) return true;
  const packed = read(path.join(commonDir, 'packed-refs')) || '';
  return packed.split(/\r?\n/).some((line) => line.endsWith(` ${ref}`));
}

function freeBytes(dir) {
  try { const stats = fs.statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return null; }
}

/**
 * → { repository, top, branch, detached, commits, operation, locked, submodules, lfs, freeBytes, problems }
 * `problems`: what stands in Build's way, each { code, message }, in the order to fix them.
 */
function inspectRepository(dir) {
  const found = findGitDir(dir);
  const free = freeBytes(dir);
  if (!found) {
    return { repository: false, top: null, branch: null, detached: false, commits: false, operation: null, locked: false, submodules: false, lfs: false, freeBytes: free, problems: [{ code: 'not-a-repository', message: 'This folder has no history yet.' }] };
  }
  const { gitDir, commonDir, top } = found;
  const head = (read(path.join(gitDir, 'HEAD')) || '').trim();
  const symbolic = /^ref:\s*(refs\/\S+)$/.exec(head);
  const detached = !symbolic && SHA_RE.test(head);
  const branch = symbolic ? symbolic[1].replace(/^refs\/heads\//, '') : null;
  const commits = detached || (symbolic ? refExists(commonDir, symbolic[1]) : false);
  const operation = (OPERATIONS.find(([name]) => exists(path.join(gitDir, name))) || [null, null])[1];
  const locked = exists(path.join(gitDir, 'index.lock'));
  const submodules = exists(path.join(top, '.gitmodules'));
  const attributes = read(path.join(top, '.gitattributes')) || '';
  const lfs = /filter=lfs/.test(attributes) || exists(path.join(commonDir, 'lfs'));
  const problems = [];
  if (!commits) problems.push({ code: 'no-commits', message: 'Nothing has been saved in this folder’s history yet.' });
  if (detached) problems.push({ code: 'detached', message: 'The folder is not on a branch.' });
  if (operation) problems.push({ code: 'operation', message: `A ${operation} is not finished in this folder.` });
  if (locked) problems.push({ code: 'locked', message: 'Git left a lock file (.git/index.lock), usually after a crash.' });
  return { repository: true, top, branch, detached, commits, operation, locked, submodules, lfs, freeBytes: free, problems };
}

module.exports = { inspectRepository, findGitDir };
