'use strict';

// Every git command a Build runs (2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md B5-B17).
// Nothing here is shown to the person as git: the manager turns results into Build states. Engelbart's own commands run
// with hooks off (the repository's hooks are the person's rules for their own commits and checkouts), no prompts, no
// pager, English messages (a few are read, e.g. which files a fast-forward would overwrite). Values reach git as
// arguments, never through a shell. `gitPath()` is the git the tool check found (../tools); tests pass the one on PATH.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const FALLBACK_NAME = 'Engelbart';
const FALLBACK_EMAIL = 'build@engelbart.local';
const TIMEOUT_MS = 120_000;
const LONG_MS = 600_000;

class GitError extends Error {
  constructor(message, { code = 'failed', files = [], output = '' } = {}) {
    super(message);
    this.name = 'GitError';
    this.code = code; // 'failed' | 'conflict' | 'overwrite' | 'moved' | 'missing'
    this.files = files;
    this.output = output;
  }
}

const firstLine = (text) => String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';

// A clone's credential helper for the GitHub sign-in (clone): it answers `get` for https://github.com alone, from
// ENGELBART_GITHUB_TOKEN, and ignores `store` and `erase`. An empty credential.helper first leaves the person's own
// helpers out of that command (their keychain would otherwise be asked to store the token). Config through
// GIT_CONFIG_COUNT (Git 2.31+) keeps it off the command line; an older Git ignores it and uses the person's own.
const GITHUB_HELPER = '!f() { test "$1" = get || exit 0; protocol=; host=; while IFS== read -r key value; do test -z "$key" && break; case "$key" in protocol) protocol=$value ;; host) host=$value ;; esac; done; test "$protocol" = https && test "$host" = github.com && test -n "$ENGELBART_GITHUB_TOKEN" || exit 0; printf \'username=x-access-token\\npassword=%s\\n\' "$ENGELBART_GITHUB_TOKEN"; }; f';
const credentialEnv = () => ({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: GITHUB_HELPER });

function createGit({ gitPath = () => 'git', run = execFile, environment = process.env } = {}) {
  const env = () => {
    const base = { ...environment };
    for (const key of Object.keys(base)) if (/^GIT_/.test(key)) delete base[key]; // an outer git's GIT_DIR / GIT_INDEX_FILE would redirect everything
    return { ...base, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_PAGER: 'cat', PAGER: 'cat', LC_MESSAGES: 'C', LANGUAGE: 'en' };
  };

  /** → { code, stdout, stderr }; never throws. `extra`: environment for this one command. */
  function exec(cwd, args, { timeout = TIMEOUT_MS, input = null, env: extra = {} } = {}) {
    return new Promise((resolve) => {
      const child = run(gitPath(), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.quotepath=off', '-c', 'advice.detachedHead=false', ...args], { cwd, env: { ...env(), ...extra }, timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: !!(error && error.code === 'ENOENT') });
      });
      if (child && child.stdin) { if (input != null) child.stdin.end(input); else child.stdin.end(); }
    });
  }

  /** The same, throwing a GitError with git's first line when it fails. */
  async function must(cwd, args, options) {
    const out = await exec(cwd, args, options);
    if (out.missing) throw new GitError('Git was not found.', { code: 'missing' });
    if (out.code !== 0) throw new GitError(firstLine(out.stderr) || firstLine(out.stdout) || `git ${args[0]} failed`, { output: `${out.stdout}${out.stderr}`.slice(-4000) });
    return out.stdout;
  }

  const trim = async (cwd, args) => (await must(cwd, args)).trim();

  /** The working tree's top folder. */
  const top = (dir) => trim(dir, ['rev-parse', '--show-toplevel']);

  /** → { sha, branch } (branch null when HEAD is detached). */
  async function head(dir) {
    const sha = await trim(dir, ['rev-parse', 'HEAD']);
    const named = await exec(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    return { sha, branch: named.code === 0 ? named.stdout.trim() : null };
  }

  const revParse = (dir, ref) => trim(dir, ['rev-parse', '--verify', `${ref}^{commit}`]);

  /** What `git status` lists as changed or new (ignored files are not), as paths. */
  async function dirtyPaths(dir) {
    const out = await must(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const paths = [];
    const parts = out.split('\0');
    for (let i = 0; i < parts.length; i += 1) {
      const entry = parts[i];
      if (!entry) continue;
      paths.push(entry.slice(3));
      if (/^R|^C/.test(entry)) i += 1; // a rename carries its old path next
    }
    return paths;
  }

  /** The person's own name and email when their git has them, else Engelbart's. */
  async function identity(dir) {
    const name = (await exec(dir, ['config', 'user.name'])).stdout.trim();
    const email = (await exec(dir, ['config', 'user.email'])).stdout.trim();
    return name && email ? { name, email, own: true } : { name: FALLBACK_NAME, email: FALLBACK_EMAIL, own: false };
  }
  const as = (who) => ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`];

  const branchExists = async (repo, branch) => (await exec(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;

  /** A new branch at `startSha`, checked out in `dir` (which must not exist yet); a branch left by an earlier try is reused. */
  async function addWorktree(repo, dir, branch, startSha) {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    await exec(repo, ['worktree', 'prune']);
    const args = (await branchExists(repo, branch)) ? ['worktree', 'add', '--quiet', dir, branch] : ['worktree', 'add', '--quiet', '-b', branch, dir, startSha];
    await must(repo, args, { timeout: LONG_MS });
  }

  /** The folder and git's record of it go; a folder already gone is only pruned. */
  async function removeWorktree(repo, dir) {
    if (fs.existsSync(dir)) {
      const out = await exec(repo, ['worktree', 'remove', '--force', '--force', dir], { timeout: LONG_MS });
      if (out.code !== 0 && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    await exec(repo, ['worktree', 'prune']);
  }

  async function deleteBranch(repo, branch) {
    const out = await exec(repo, ['branch', '-D', branch]);
    return out.code === 0;
  }

  /** A merge started by mergeInto and not yet concluded. */
  async function merging(dir) {
    const gitDir = (await exec(dir, ['rev-parse', '--git-dir'])).stdout.trim();
    return !!gitDir && fs.existsSync(path.resolve(dir, gitDir, 'MERGE_HEAD'));
  }
  const abortMerge = async (dir) => (await exec(dir, ['merge', '--abort'])).code === 0;

  /** Everything in the worktree as it stands, committed. → the new commit, or null when nothing changed. */
  async function checkpoint(dir, message, who) {
    await must(dir, ['add', '-A']);
    const staged = await exec(dir, ['diff', '--cached', '--quiet']);
    if (staged.code === 0) return null;
    await must(dir, [...as(who), 'commit', '--quiet', '--no-verify', '-m', message]);
    return trim(dir, ['rev-parse', 'HEAD']);
  }

  /**
   * What changed since `from` (committed; the manager checkpoints first): the files with their counts, and the patch.
   * → { files: [{ path, status, adds, dels, binary }], patch, truncated }
   */
  async function diff(dir, from, to = 'HEAD', { maxPatch = 2_000_000 } = {}) {
    const names = await must(dir, ['diff', '--name-status', '-z', '--find-renames', from, to]);
    const numbers = await must(dir, ['diff', '--numstat', '-z', '--find-renames', from, to]);
    const counts = new Map();
    const numParts = numbers.split('\0');
    for (let i = 0; i < numParts.length; i += 1) {
      const entry = numParts[i];
      if (!entry) continue;
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(entry);
      if (!m) continue;
      let file = m[3];
      if (!file) { file = numParts[i + 2]; i += 2; } // a rename: "adds\tdels\t" then old, new
      counts.set(file, { adds: m[1] === '-' ? 0 : Number(m[1]), dels: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
    }
    const files = [];
    const parts = names.split('\0');
    for (let i = 0; i < parts.length; i += 1) {
      const status = parts[i];
      if (!status) continue;
      let file = parts[i + 1];
      let was = null;
      if (/^[RC]/.test(status)) { was = parts[i + 1]; file = parts[i + 2]; i += 2; } else i += 1;
      files.push({ path: file, was, status: status[0], ...(counts.get(file) || { adds: 0, dels: 0, binary: false }) });
    }
    const patch = await must(dir, ['diff', '--find-renames', '--no-color', '--no-ext-diff', from, to]);
    return { files, patch: patch.length > maxPatch ? patch.slice(0, maxPatch) : patch, truncated: patch.length > maxPatch };
  }

  const mergeBase = (dir, a, b) => trim(dir, ['merge-base', a, b]);
  const isAncestor = async (dir, a, b) => (await exec(dir, ['merge-base', '--is-ancestor', a, b])).code === 0;
  const conflicted = async (dir) => (await exec(dir, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').map((line) => line.trim()).filter(Boolean);

  /**
   * Accept's first half, on a detached HEAD in the Build's worktree (its branch is untouched): everything since `base` as
   * one commit, then that commit replayed onto `onto`. → the commit. A conflict undoes the replay and throws with the
   * files; the worktree goes back to its branch either way.
   */
  async function squashOnto(dir, { branch, base, onto, message, who }) {
    await must(dir, ['checkout', '--quiet', '--detach']);
    try {
      await must(dir, ['reset', '--quiet', '--soft', base]);
      const empty = (await exec(dir, ['diff', '--cached', '--quiet'])).code === 0;
      if (empty) return null;
      await must(dir, [...as(who), 'commit', '--quiet', '--no-verify', '-F', '-'], { input: message });
      if (base !== onto) {
        const replay = await exec(dir, [...as(who), 'rebase', '--quiet', onto], { timeout: LONG_MS });
        if (replay.code !== 0) {
          const files = await conflicted(dir);
          await exec(dir, ['rebase', '--abort']);
          throw new GitError(files.length ? `Your branch changed the same lines in ${files.join(', ')}.` : firstLine(replay.stderr) || 'The Build could not be replayed onto your branch.', { code: files.length ? 'conflict' : 'failed', files, output: `${replay.stdout}${replay.stderr}`.slice(-4000) });
        }
      }
      return await trim(dir, ['rev-parse', 'HEAD']);
    } catch (error) {
      await exec(dir, ['checkout', '--quiet', '--force', branch]);
      throw error;
    }
  }

  /** Back on the Build's branch (after Accept's checks, or a failure). */
  const checkoutBranch = (dir, branch) => must(dir, ['checkout', '--quiet', '--force', branch]);

  /**
   * The person's branch moves to `sha`, their files with it: only by fast-forward, only while their folder is still on
   * `branch` at `expected`. Their uncommitted edits to files the Build changed make git refuse; those files are named.
   */
  async function fastForward(repo, { branch, expected, sha }) {
    const now = await head(repo);
    if (now.branch !== branch || now.sha !== expected) throw new GitError('Your folder moved while this was being accepted.', { code: 'moved' });
    const out = await exec(repo, ['merge', '--ff-only', '--quiet', sha], { timeout: LONG_MS });
    if (out.code === 0) return;
    const text = `${out.stdout}${out.stderr}`;
    const listed = (pattern) => { const m = pattern.exec(text); return m ? m[1].split('\n').map((line) => line.trim()).filter(Boolean) : null; };
    const untracked = listed(/untracked working tree files would be (?:overwritten|removed) by merge:\n([\s\S]*?)\n(?:Please|Aborting)/);
    if (untracked) throw new GitError(`Files the Build adds already exist, uncommitted, in your folder: ${untracked.join(', ')}. Move them, then Accept again.`, { code: 'overwrite', files: untracked, output: text.slice(-4000) });
    const edited = listed(/local changes to the following files would be overwritten by merge:\n([\s\S]*?)\n(?:Please|Aborting)/);
    if (edited) throw new GitError(`You have uncommitted edits to ${edited.join(', ')}. Commit or discard them, then Accept again.`, { code: 'overwrite', files: edited, output: text.slice(-4000) });
    throw new GitError(firstLine(out.stderr) || 'Your branch could not be moved forward.', { output: text.slice(-4000) });
  }

  /** The person's branch brought into the Build's, conflicts left in the files for the agent (a merge in progress). → conflicted files */
  async function mergeInto(dir, ref, who) {
    const out = await exec(dir, [...as(who), 'merge', '--no-ff', '--no-edit', '--quiet', ref], { timeout: LONG_MS });
    if (out.code === 0) return [];
    const files = await conflicted(dir);
    if (!files.length) throw new GitError(firstLine(out.stderr) || 'Your branch could not be merged in.', { output: `${out.stdout}${out.stderr}`.slice(-4000) });
    return files;
  }

  /** Finishes a merge the agent resolved (or any merge in progress): everything added and committed. */
  async function concludeMerge(dir, message, who) {
    const gitDir = await trim(dir, ['rev-parse', '--git-dir']);
    const merging = fs.existsSync(path.resolve(dir, gitDir, 'MERGE_HEAD'));
    await must(dir, ['add', '-A']);
    if (merging) {
      await must(dir, [...as(who), 'commit', '--quiet', '--no-verify', '-m', message]);
      return trim(dir, ['rev-parse', 'HEAD']);
    }
    return checkpoint(dir, message, who);
  }

  /** A folder with no history gets one: git init, a .gitignore when there is none, and everything in a first commit. */
  /** `own`: `dir` gets a repository of its own even inside another one (the default repo, never a parent's commit). */
  async function init(dir, { own = false } = {}) {
    const inside = own ? { code: fs.existsSync(path.join(dir, '.git')) ? 0 : 1 } : await exec(dir, ['rev-parse', '--is-inside-work-tree']);
    if (inside.code !== 0) await must(dir, ['init', '--quiet']);
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, 'node_modules/\n.env\n.env.*\n.DS_Store\n');
    const who = await identity(dir);
    await must(dir, ['add', '-A'], { timeout: LONG_MS });
    await must(dir, [...as(who), 'commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'First snapshot (Engelbart)'], { timeout: LONG_MS });
    return head(dir);
  }

  /**
   * `url` cloned into `dir` (which must not exist yet), never with a prompt. With `token` (the GitHub sign-in), GitHub's
   * request for a password is answered by GITHUB_HELPER, the only credential helper of this one command: the token is in
   * its environment, never on a command line, and nothing is kept (not in the clone's config, whose remote is the plain
   * address, nor in the person's keychain, whose helper is left out). Without it, the person's own Git credentials.
   */
  async function clone(url, dir, { token = null } = {}) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const extra = token ? { ...credentialEnv(), ENGELBART_GITHUB_TOKEN: token } : {};
    await must(path.dirname(dir), ['clone', '--quiet', '--', url, dir], { timeout: LONG_MS, env: extra });
  }

  const message = (dir, sha = 'HEAD') => trim(dir, ['log', '-1', '--format=%B', sha]);

  /** Files whose added lines still hold a conflict marker between two commits (a merge left half resolved). */
  async function markers(dir, from, to) {
    const out = await must(dir, ['diff', '--no-color', '--no-ext-diff', '-U0', from, to]);
    const files = new Set();
    let file = null;
    for (const line of out.split('\n')) {
      if (line.startsWith('+++ ')) { file = line.replace(/^\+\+\+ (b\/)?/, ''); continue; }
      if (file && /^\+(<{7}|>{7})( |$)/.test(line)) files.add(file);
    }
    return [...files];
  }

  return { exec, top, head, revParse, dirtyPaths, identity, addWorktree, removeWorktree, deleteBranch, branchExists, merging, abortMerge, checkpoint, diff, mergeBase, isAncestor, conflicted, squashOnto, checkoutBranch, fastForward, mergeInto, concludeMerge, init, clone, message, markers };
}

module.exports = { createGit, GitError, GITHUB_HELPER, credentialEnv, FALLBACK_NAME, FALLBACK_EMAIL };
