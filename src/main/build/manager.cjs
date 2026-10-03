'use strict';

// Build's lifecycle (2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md). One manager for the
// app, holding what runs now; everything that must outlive the app is in the task records (./store.cjs).
//
//   start      the repository cloned first when it is not on this Mac, the record, the frozen context, then in the
//              background the worktree (git), its setup, the first turn. A post-it added to a workspace is a Build of it
//              whose task is the post-it, put in as an archived version
//   turn       a slot (three for Builds, one of its own for quick tasks), the agent (./runner.cjs) under its CLI's tool
//              lock, a checkpoint commit, the ending read (NEEDS YOU / ESCALATE / done), a reply that waited sent next
//   reply      the next turn in the same session; while a turn runs it waits, or (`interrupt`) the turn is cut short
//   run step   after a turn that ends in review (a Build, never a quick task): what the repository can run is found,
//              started and checked (./run-step.cjs), and runs in the background until Review opens it; the card waits
//              for it (no Review, no Accept) while it works. What it changed is a checkpoint of its own. The processes of
//              the last run step are stopped before the next, and everything it started on Discard and quit
//   review     the diff from where the Build started, as the worktree stands, the run steps' changes apart; what runs
//              comes first (the renderer). While a turn works it is sent to the card (`engelbart:build-diff`) after each
//              thing the agent does, and once more when the turn ends
//   accept     leftovers committed, everything squashed into one commit, replayed onto the person's current branch, the
//              checks, a fast-forward of their folder; then what the run step found is written to the repository's rows
//              (only here). Worktree and branch removed, unless something runs: then the copy stays, detached at what
//              landed, until its last runnable is stopped or Engelbart quits (a crash: swept when it starts). Refusals
//              change nothing. A conflict or failed checks go to the agent by themselves, and Accept runs again when its
//              turn is done: at most AUTO_FIXES times for one press (2026-09-29)
//   discard    stopped, worktree and branch removed
//   recovery   a record left working when the app closed is `interrupted`; Resume continues its session
// Git writes that touch the shared repository's worktrees (add, remove) and Accept run one at a time per repository.
//
// Where a Build works (2026-09-29): the repository chosen in the Build panel, else the project's default repo, which
// project.json keeps as a target (defaultTarget): the code directory ({ kind: 'project' }) or a library row ({ kind:
// 'library', id }); the person changes it in the panel's picker (Make default). A project with none gets one Engelbart
// makes: a folder in the code directory named after the project ("Port check" → port-check/), made with a history of
// its own when the first Build starts there, and then kept as its library row, so a rename never moves it. A folder of
// that name that is the person's own (not empty, no history of its own) is never taken: the next free name is
// (port-check-2/ …). When the default's row is deleted or its folder is gone, the code directory takes its place if it
// has a history, else a new folder is made as above. Nothing is ever git-initialised in a folder the person chose.
// project.json from before defaultTarget is converted once (migrateDefault). The others are the project folder when it
// is a repository itself, and the library's repositories: a local one as it is, a GitHub one (the kind that has a
// sandbox) once it is cloned into `repos/<name>` in the project folder, which its row then keeps.
//
// Which ones (2026-09-29, later): the picker lists the default repo and the git rows this project holds (made in it, or
// in one of its workspaces' context), never the whole library. The default repo is a library row of its own (a folder
// tagged git, made in the project) from its first Build on. A post-it's Build always works in the default repo.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const projects = require('../store/projects.cjs');
const { libraryForProject } = require('../store/library.cjs');
const archive = require('../store/archive.cjs');
const { readJson, slugify } = require('../store/home.cjs');
const { inspectRepository } = require('../tools/repository.cjs');
const { resolveBuildChoice } = require('../bart/models.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');
const { createFeed } = require('../bart/activity.cjs');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const store = require('./store.cjs');
const { freezeContext, replyMessage, freshMessage } = require('./context.cjs');
const { loadBuildPrompt, readEnding } = require('./prompt.cjs');
const { buildPolicy } = require('./policy.cjs');
const { githubRepo } = require('../sandbox/runs.cjs');
const { worktreePath } = require('./run-tools.cjs');
const { runnableStore } = require('./runnables.cjs');

const CLONES = 'repos';
const LIMITS = Object.freeze({ build: 3, quick: 1 });
const TURN_MS = Object.freeze({ build: 180 * 60_000, quick: 20 * 60_000 }); // a turn past this is stopped (its work saved); Resume goes on
const SHELL_MS = 10 * 60_000;
const QUIT_WAIT_MS = 20_000;
const MAX_ATTACH = 50;
const AUTO_FIXES = 2; // an Accept that is refused goes back to the agent this many times before the card says so
const DIFF_MS = 700; // after the agent does something, the card's diff is read again this long after
const CARD_PATCH = 400_000; // the most of a patch the card is sent
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fromEngelbart = (text) => `<from_engelbart>\n${text}\n</from_engelbart>`;
const tail = (text, n = 4000) => { const value = String(text || ''); return value.length > n ? `…${value.slice(-n)}` : value; };
// A failed test's line, in what the common runners print: node's TAP and spec, Jest, pytest.
const FAILED_LINE = /^\s*(not ok \d+ - |✖ |FAIL |FAILED |● )/;
/**
 * The last 4000 characters of a check's output, and first the names of what failed before them (2026-09-29): node's
 * TAP reports each failure where it happens, so a long run's failures scroll out of the tail and nobody sees which.
 */
function checkOutput(text, n = 4000) {
  const value = String(text || '');
  const failed = [...new Set(value.slice(0, Math.max(0, value.length - n)).split('\n').filter((line) => FAILED_LINE.test(line)).map((line) => line.trim().slice(0, 300)))].slice(0, 40);
  return `${failed.length ? `What failed, before what is shown below:\n${failed.join('\n')}\n\n` : ''}${tail(value, n)}`;
}
/** A post-it's title: its first line with words in it, without its markdown. */
const postItTitle = (text) => (String(text || '').split('\n').map((line) => line.replace(/^(#{1,3} |- \[[ xX]?\] |[-*] |> )/, '').trim()).find(Boolean) || 'Quick task').slice(0, 80);
/** A quick task's post-it, from its record or (a record from before 2026-09-27) from its frozen context. */
const postItOf = (task, context) => {
  if (typeof task.postIt === 'string') return task.postIt;
  const found = /<post-it>\n([\s\S]*?)\n<\/post-it>/.exec(String(context || ''));
  return found ? found[1] : task.title;
};

/** What the Build panel names: the default repo, the project folder, or a library row. */
function targetOf(input) {
  const value = input && typeof input === 'object' ? input : {};
  if (value.kind === 'project') return { kind: 'project' };
  if (value.kind === 'library' && typeof value.id === 'string' && UUID_RE.test(value.id)) return { kind: 'library', id: value.id };
  return { kind: 'default' };
}
const isRepo = (row) => !!row && Array.isArray(row.tags) && row.tags.includes('git');
const folderThere = (dir) => { try { return !!dir && fs.statSync(dir).isDirectory(); } catch { return false; } };
const ownRepository = (dir) => { try { return fs.statSync(path.join(dir, '.git')).isDirectory(); } catch { return false; } };
const emptyFolder = (dir) => { try { return fs.readdirSync(dir).every((name) => name === '.DS_Store'); } catch { return false; } };

const canonical = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
const sameFolder = (a, b) => !!a && !!b && canonical(a) === canonical(b);
const hasGit = (dir) => { try { return fs.existsSync(path.join(dir, '.git')); } catch { return false; } };

/**
 * A default repo Engelbart makes, for a project that has none: the first of <project name>, <name>-2 … in the code
 * directory that is missing, empty, or a repository of its own; never a folder of the person's with no history of its own.
 */
function newFolder(project) {
  const base = slugify(project.name) || 'repo';
  for (let n = 1; n < 100; n += 1) {
    const at = path.join(project.directory, n === 1 ? base : `${base}-${n}`);
    if (!fs.existsSync(at) || ownRepository(at) || emptyFolder(at)) return at;
  }
  throw new Error('No free folder for the default repository');
}

// What git says when GitHub turns a clone's credentials away (or hides a private repository behind "not found").
const REFUSED = /authentication failed|could not read (username|password)|repository not found|returned error: 40[134]|access denied|not found/i;
const cloneError = (name, error) => new Error(REFUSED.test(error.message)
  ? `${name} could not be cloned: GitHub refused (${error.message}). If it is private, Engelbart's GitHub App must be installed where it lives, with access to it.`
  : `${name} could not be cloned: ${error.message}`);

/** Where a GitHub repository is cloned for a Build: repos/<name> in the project folder, else repos/<name>-2 … */
function cloneFolder(project, url) {
  const parent = path.join(project.directory, CLONES);
  const name = githubRepo(url).name.replace(/\.git$/i, '') || 'repository';
  for (let n = 1; n < 100; n += 1) {
    const at = path.join(parent, n === 1 ? name : `${name}-${n}`);
    if (!fs.existsSync(at)) return at;
  }
  throw new Error('No free folder for the clone');
}

/** A shell command in the login shell (the PATH the terminal has), in `cwd`. `tools`: Engelbart's own Git goes first on PATH when it stands in. → { ok, output } */
function createShell({ environment = process.env, run = execFile, tools = null } = {}) {
  const shell = resolveShell(environment);
  return (command, cwd, { env = {}, timeoutMs = SHELL_MS, signal } = {}) => new Promise((resolve) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    const full = { ...base, CI: '1', ...(tools && tools.environment ? tools.environment() : {}), ...env };
    // `detached`: a session of its own, without Engelbart's controlling terminal (2026-09-29). Started from a terminal
    // (npm start), Engelbart has one, and an interactive zsh a check starts would read the keyboard of that terminal
    // instead of its own input: the project's tests of such shells failed only when Accept ran them.
    run(shell, loginShellArgs(shell, command, full), { cwd, env: full, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal, detached: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: checkOutput(`${stdout || ''}${stderr || ''}`), timedOut: !!(error && error.killed) });
    });
  });
}

// `githubToken`: the GitHub sign-in (github/connection.cjs token), for cloning a private library repository on a Mac
// whose Git has no GitHub credentials of its own (git.cjs clone). `libraryChanged()`: a library row was made or given a
// folder here (the sidebar reads the library again). `runStep`: ./run-step.cjs's, or null for no run step.
function createBuilds({ git, runner, readModels, notify = () => {}, tools = null, gitReady = () => true, runShell = createShell({ tools }), copyTree = null, githubToken = async () => null, libraryChanged = () => {}, runStep = null, limits = LIMITS, turnMs = TURN_MS, autoFixes = AUTO_FIXES, diffMs = DIFF_MS, now = () => new Date() }) {
  const live = new Map(); // id → { controller, stopping: null | 'stop' | 'quit', done: Promise }
  const active = { build: 0, quick: 0 };
  const waiting = { build: [], quick: [] };
  const chains = new Map(); // repository → the promise of its last git writer
  const stepping = new Map(); // id → its run step while it works (the agent, then its checkpoint)
  const reconciled = new Set();
  const keptCopies = new Map(); // id → { ctx, projectId }: accepted Builds whose copy stays while what they run is up
  const sweeps = new Set(); // kept copies an Engelbart that crashed left, being cleaned up
  let quitting = false;

  const emit = (task) => { try { notify('engelbart:build', store.publicTask(task)); } catch { /* a closed window */ } };
  const navChanged = () => { try { notify('engelbart:nav', {}); } catch { /* a closed window */ } };
  const say = (role, text, images) => store.message(role, text, now(), images);

  /**
   * A reply's pasted images ([{ n, id }] from the card; each saved as a library image, projects.saveImage) → [{ n, id,
   * path }] of those that are this project's images on disk. The rest are dropped.
   */
  async function pastedImages(ctx, projectId, images) {
    const project = projectOf(ctx, projectId);
    const out = [];
    for (const image of (Array.isArray(images) ? images : []).slice(0, MAX_ATTACH)) {
      if (!image || !Number.isInteger(image.n) || image.n < 1 || typeof image.id !== 'string' || !UUID_RE.test(image.id)) continue;
      const row = await ctx.libraryDb.get(image.id).catch(() => null);
      if (!row || row.type !== 'image' || !row.path || !path.resolve(row.path).startsWith(project.dir + path.sep) || !fs.existsSync(row.path)) continue;
      out.push({ n: image.n, id: row.id, path: path.resolve(row.path) });
    }
    return out;
  }
  const imageRefs = (images) => images.map(({ n, id }) => ({ n, id }));

  function projectOf(ctx, projectId) { return projects.findProject(ctx, projectId); }
  function read(ctx, projectId, id) {
    const task = store.readTask(projectOf(ctx, projectId), id);
    if (!task) throw new Error('Unknown Build');
    return task;
  }
  /** Read, change, write, announce — with no wait between the read and the write. */
  function save(ctx, projectId, id, change) {
    const project = projectOf(ctx, projectId);
    const held = store.readTask(project, id);
    if (!held) throw new Error('Unknown Build');
    const next = store.writeTask(project, { ...held, ...(typeof change === 'function' ? change(held) : change) }, now());
    emit(next);
    return next;
  }

  /** One git writer per repository at a time: worktree add and remove, and Accept. */
  function serial(repo, work) {
    const before = chains.get(repo) || Promise.resolve();
    const run = before.catch(() => {}).then(work);
    chains.set(repo, run.catch(() => {}));
    return run;
  }

  /** A turn's slot; it waits (queued) while the pool is full. → release, or null when stopped while waiting. */
  function slot(pool, signal) {
    if (active[pool] < limits[pool]) { active[pool] += 1; return Promise.resolve(release(pool)); }
    return new Promise((resolve) => {
      const entry = () => { active[pool] += 1; resolve(release(pool)); };
      waiting[pool].push(entry);
      signal.addEventListener('abort', () => { const at = waiting[pool].indexOf(entry); if (at >= 0) { waiting[pool].splice(at, 1); resolve(null); } }, { once: true });
    });
  }
  function release(pool) {
    let done = false;
    return () => { if (done) return; done = true; active[pool] -= 1; const next = waiting[pool].shift(); if (next) next(); };
  }

  function track(change) { try { change(); navChanged(); } catch { /* bookkeeping never stands in a Build's way */ } }

  /** The Build's diff as its worktree stands, sent to its card. Never fails a turn. */
  async function sendDiff(projectId, task, running) {
    if (!git.workingDiff) return;
    try {
      const d = await git.workingDiff(task.worktree, task.baseSha, { maxPatch: CARD_PATCH });
      notify('engelbart:build-diff', { projectId, id: task.id, ...d, running });
    } catch { /* the next one, or Review's */ }
  }
  /**
   * While a turn works: `poke()` after anything the agent does reads the diff again `diffMs` later (one read at a time;
   * pokes meanwhile make one more), so the card shows each edit soon after it is made. `end()` stops it.
   */
  function watchDiff(projectId, task) {
    let timer = null, reading = null, again = false, ended = false;
    const read = async () => {
      timer = null;
      if (reading) { again = true; return; }
      reading = sendDiff(projectId, task, true);
      await reading;
      reading = null;
      if (again && !ended) { again = false; timer = setTimeout(read, diffMs); }
    };
    return {
      poke() { if (!ended && !timer) timer = setTimeout(read, diffMs); },
      /** → once a read in flight is sent, so the turn's last diff comes after it */
      end() { ended = true; if (timer) clearTimeout(timer); timer = null; return reading || Promise.resolve(); },
    };
  }

  /* ------------------------------------------------------------------ preflight */

  /** Where a target is → { target: { kind, id, name }, folder, url }; `folder` is null for a library repository not on this Mac. */
  async function locate(ctx, project, input) {
    const target = targetOf(input);
    if (target.kind === 'default') {
      const mine = await defaultFolder(ctx, project.id);
      return mine && { target: { ...target, name: mine.name }, folder: mine.folder, url: null, fresh: mine.fresh };
    }
    if (target.kind === 'project') return { target: { ...target, name: path.basename(project.directory) }, folder: project.directory, url: null };
    const row = await ctx.libraryDb.get(target.id);
    if (!isRepo(row)) throw new Error('That repository is not in the library.');
    const github = githubRepo(row.url);
    return { target: { ...target, name: row.name }, folder: folderThere(row.folder_path) ? row.folder_path : null, url: github ? github.url : null };
  }

  /**
   * The repositories a Build can work in, for the panel's picker: the default repo first, then the code directory when
   * it is a repository, then the git rows this project holds; a folder is listed once (the default's is not again).
   */
  async function targets(ctx, projectId) {
    const project = projectOf(ctx, projectId);
    const mine = await defaultFolder(ctx, projectId);
    const list = mine ? [{ kind: 'default', name: mine.name, folder: mine.folder, place: 'default' }] : [];
    if (!project.directory) return list;
    const seen = new Set(mine ? [canonical(mine.folder)] : []);
    if (!seen.has(canonical(project.directory)) && inspectRepository(project.directory).repository) {
      list.push({ kind: 'project', name: path.basename(project.directory), folder: project.directory, place: 'project' });
      seen.add(canonical(project.directory));
    }
    for (const row of await libraryForProject(ctx, projectId)) {
      if (!isRepo(row)) continue;
      const folder = folderThere(row.folder_path) ? row.folder_path : null;
      const github = githubRepo(row.url);
      if ((!folder && !github) || (folder && seen.has(canonical(folder)))) continue;
      if (folder) seen.add(canonical(folder));
      list.push({ kind: 'library', id: row.id, name: row.name, folder, url: github ? github.url : null, place: folder ? 'local' : 'github' });
    }
    return list;
  }

  /** Whether the chosen repository (the default repo when none is) can take a Build, and what the panel should say. */
  async function preflight(ctx, projectId, input) {
    const project = projectOf(ctx, projectId);
    const noFolder = { ok: false, problems: [{ code: 'no-directory', message: 'This project has no code folder.' }], dirty: 0, canInit: false };
    // The default repo can be a library row somewhere else; anything else needs the code directory.
    if (!project.directory && targetOf(input).kind !== 'default') return noFolder;
    const where = await locate(ctx, project, input);
    if (!where) return noFolder;
    const base = { target: where.target, directory: where.folder };
    if (!gitReady()) return { ...base, ok: false, problems: [{ code: 'no-git', message: 'Git is not set up yet (Engelbart ▸ Set Up Tools…).' }], dirty: 0, canInit: false };
    if (!where.folder) {
      const problem = where.url ? `${where.target.name} is not on this Mac yet.` : `${where.target.name}'s folder is gone.`;
      return { ...base, ok: false, problems: [{ code: 'not-here', message: problem }], dirty: 0, canInit: false, canClone: !!where.url, cloneTo: where.url ? path.relative(project.directory, cloneFolder(project, where.url)) : null };
    }
    // A default repo Engelbart makes (the project has none, or its folder is gone): missing, or without a history of its
    // own, it is made when the Build starts. Never one the person chose (defaultTarget): that is checked as it is.
    const report = where.fresh && !ownRepository(where.folder) ? null : inspectRepository(where.folder);
    if (where.fresh && (!report || (report.problems.length === 1 && report.problems[0].code === 'no-commits'))) {
      return { ...base, ok: true, create: true, dirty: 0, problems: [], canInit: false };
    }
    const blocking = report.problems.filter((problem) => problem.code !== 'not-a-repository' && problem.code !== 'no-commits');
    const canInit = report.problems.length > 0 && !blocking.length;
    // A folder with no history of its own, or none saved yet, is not the person's to fix (2026-09-29): the Build gives it
    // one when it starts (git init and a first commit, as "Start history" did), and the panel says nothing about it. Not
    // the default repo the person chose (defaultTarget): that is never git-initialised; it says what is wrong instead.
    if (canInit && where.target.kind !== 'default') return { ...base, ok: true, init: true, top: report.top, branch: report.branch, dirty: 0, problems: [], canInit };
    let dirty = 0;
    if (report.repository && report.commits) { try { dirty = (await git.dirtyPaths(report.top)).length; } catch { dirty = 0; } }
    return { ...base, ok: !report.problems.length, top: report.top, branch: report.branch, dirty, problems: report.problems, canInit };
  }

  /** git init and a first commit in a folder that had none (B17's "Start history"; since 2026-09-29 start does it unasked). */
  async function initRepository(ctx, projectId, input) {
    const pre = await preflight(ctx, projectId, input);
    if (!pre.canInit) throw new Error(pre.problems.length ? pre.problems[0].message : 'This folder already has a history.');
    await serial(pre.directory, () => git.init(pre.directory));
    return preflight(ctx, projectId, input);
  }

  /** The default repo, made: its folder, and a history of its own with a first commit (never a parent repository's). */
  function makeDefault(folder) {
    return serial(folder, async () => {
      if (ownRepository(folder) && inspectRepository(folder).commits) return;
      fs.mkdirSync(folder, { recursive: true });
      await git.init(folder, { own: true });
    });
  }

  /** The default repo's library row: a folder tagged git, made in this project; one row per folder, never a second. → the row */
  function recordDefault(ctx, projectId, folder, name = null) {
    const at = canonical(folder);
    return serial(`library:${at}`, async () => {
      const held = await rowAt(ctx, folder);
      if (held) return held;
      const row = await ctx.libraryDb.insert({ id: randomUUID(), name: name || path.basename(folder), type: 'folder', tags: ['git'], folder_path: folder, project_id: projectId });
      libraryChanged();
      return row;
    });
  }

  /** The library row of a folder (a git row first; `preferred`, when it is that folder's) → the row, or null. */
  async function rowAt(ctx, folder, preferred = null) {
    if (preferred && UUID_RE.test(preferred)) {
      const row = await ctx.libraryDb.get(preferred);
      if (row && sameFolder(row.folder_path, folder)) return row;
    }
    const rows = (await ctx.libraryDb.list()).filter((row) => row.folder_path && sameFolder(row.folder_path, folder));
    return rows.find(isRepo) || rows[0] || null;
  }

  /* ---------------------------------------------------------------- the default repo */

  /**
   * project.json from before defaultTarget, converted once (while it has none; nothing is moved or deleted):
   *   a. defaultRepoId → repositories[id].location (another branch's registry; relative to the project's data folder),
   *      when that folder is a repository of its own: the code directory → { kind: 'project' }, else its library row
   *      (repositories[id].libraryId when it is that folder's; made when there is none). It wins over defaultRepo,
   *      which this branch may have written wrongly: a folder made from defaultRepo that is no longer the default is
   *      named in the project's builds/history.log, for the person to decide about.
   *   b. else defaultRepo (a folder name in the code directory, made by a Build) → its library row, made if missing.
   *   c. else nothing: the first Build makes one (defaultFolder, start).
   * → the project record, as it is afterwards
   */
  function migrateDefault(ctx, projectId) {
    const first = projectOf(ctx, projectId);
    if (first.defaultTarget) return Promise.resolve(first);
    return serial(`default:${first.dir}`, async () => {
      const project = projectOf(ctx, projectId);
      if (project.defaultTarget) return project;
      const meta = readJson(path.join(project.dir, 'project.json')) || {};
      const made = project.defaultRepo && project.directory ? path.join(project.directory, project.defaultRepo) : null;
      const registry = meta.repositories && typeof meta.repositories === 'object' ? meta.repositories : {};
      const registered = typeof meta.defaultRepoId === 'string' && registry[meta.defaultRepoId] && typeof registry[meta.defaultRepoId] === 'object' ? registry[meta.defaultRepoId] : null;
      let target = null;
      let note = null;
      if (registered && typeof registered.location === 'string' && registered.location && !registered.archived) {
        const at = path.resolve(project.dir, registered.location); // an absolute location stays as it is
        if (folderThere(at) && hasGit(at)) {
          if (project.directory && sameFolder(at, project.directory)) target = { kind: 'project' };
          else {
            const row = (await rowAt(ctx, at, registered.libraryId)) || (await recordDefault(ctx, projectId, at, typeof registered.name === 'string' && registered.name.trim() ? registered.name.trim().slice(0, 200) : null));
            target = { kind: 'library', id: row.id };
          }
          if (made && folderThere(made) && !sameFolder(made, at)) note = `The default repo for Builds is now ${at} (project.json → defaultRepoId). ${made} was made as the default repo before and is no longer used by Builds; nothing was moved or deleted.`;
        }
      }
      if (!target && made && folderThere(made) && hasGit(made)) target = { kind: 'library', id: (await recordDefault(ctx, projectId, made)).id };
      if (!target) return project;
      projects.setDefaultTarget(ctx, projectId, target);
      if (note) unused(project, note);
      return projectOf(ctx, projectId);
    });
  }

  /** One line for the person in the project's Build history (builds/history.log), and in the log. */
  function unused(project, line) {
    const text = `${now().toISOString()} ${line}`;
    try { fs.mkdirSync(path.join(project.dir, 'builds'), { recursive: true }); fs.appendFileSync(path.join(project.dir, 'builds', 'history.log'), `${text}\n`); } catch { /* the log below still has it */ }
    console.log(`Engelbart: ${project.name}: ${line}`);
  }

  /**
   * The default repo now → { folder, name, fresh, keep }, or null (no code directory and no default elsewhere).
   * defaultTarget first: the code directory, or its library row's folder. With none, a folder Engelbart makes (`fresh`:
   * start() makes it and keeps its row). When the default's row is deleted or its folder is gone: the code directory
   * when it has a history, else a new folder as for none. `keep`: what start() stores when it works there.
   */
  async function defaultFolder(ctx, projectId) {
    const project = await migrateDefault(ctx, projectId);
    const stored = project.defaultTarget;
    if (stored && stored.kind === 'project' && project.directory) return { folder: project.directory, name: path.basename(project.directory), fresh: false, keep: null };
    if (stored && stored.kind === 'library') {
      const row = await ctx.libraryDb.get(stored.id);
      if (row && row.folder_path && folderThere(row.folder_path)) return { folder: row.folder_path, name: row.name || path.basename(row.folder_path), fresh: false, keep: null };
    }
    if (!project.directory) return null;
    if (stored) {
      const code = inspectRepository(project.directory);
      if (code.repository && code.commits) return { folder: project.directory, name: path.basename(project.directory), fresh: false, keep: { kind: 'project' } };
    }
    const folder = newFolder(project);
    return { folder, name: path.basename(folder), fresh: true, keep: 'made' };
  }

  /** After a Build starts in the default repo: a default made or fallen back to is kept in project.json (a made one as its row). */
  async function keepDefault(ctx, projectId, folder) {
    const mine = await defaultFolder(ctx, projectId);
    if (!mine || !mine.keep || !sameFolder(mine.folder, folder)) return;
    const project = projectOf(ctx, projectId);
    const target = mine.keep === 'made' ? { kind: 'library', id: (await recordDefault(ctx, projectId, folder)).id } : mine.keep;
    await serial(`default:${project.dir}`, async () => { projects.setDefaultTarget(ctx, projectId, target); });
  }

  /**
   * The project's default repo, changed by the person (the picker's Make default): the code directory or a library row
   * that is on this Mac and can take a Build now. Only project.json changes; no folder is moved or deleted. → the picker's list
   */
  async function setDefault(ctx, projectId, input) {
    const target = input && (input.kind === 'project' || input.kind === 'library') ? targetOf(input) : null;
    if (!target || target.kind === 'default') throw new Error('Choose the code directory or a repository from the library.');
    const pre = await preflight(ctx, projectId, target);
    if (!pre.ok) throw new Error(pre.problems.length ? pre.problems[0].message : `${pre.target.name} cannot take a Build.`);
    // A folder a Build would give a history first (preflight's init) is not one yet: the default is never git-initialised.
    if (pre.init) throw new Error(inspectRepository(pre.directory).problems[0].message);
    const project = await migrateDefault(ctx, projectId);
    await serial(`default:${project.dir}`, async () => { projects.setDefaultTarget(ctx, projectId, target); });
    return targets(ctx, projectId);
  }

  /**
   * A project whose folder Engelbart made (onboarding's "Create a folder for me", 2026-09-29): its default repo, made
   * now, so the first Build finds a history waiting, and kept as the project's default (its row). Nothing while Git is
   * not ready: the first Build makes it then. A project whose default is already set (or converted) is left as it is.
   */
  async function prepareDefault(ctx, projectId) {
    const project = projectOf(ctx, projectId);
    if (!project.directory || !gitReady()) return null;
    const mine = await defaultFolder(ctx, projectId);
    if (!mine) return null;
    if (mine.fresh) await makeDefault(mine.folder);
    await keepDefault(ctx, projectId, mine.folder);
    return mine.folder;
  }

  /** A GitHub repository from the library, cloned into repos/<name> in the project folder; its row keeps the clone. */
  async function cloneRepository(ctx, projectId, input) {
    const project = projectOf(ctx, projectId);
    const pre = await preflight(ctx, projectId, input);
    if (!pre.canClone) throw new Error(pre.ok ? `${pre.target.name} is already on this Mac.` : pre.problems[0].message);
    await serial(`clone:${pre.target.id}`, async () => {
      const where = await locate(ctx, project, input);
      if (where.folder) return; // cloned meanwhile
      const into = cloneFolder(project, where.url);
      // The GitHub sign-in first (a private repository the App can read); if GitHub refuses it, the person's own Git
      // credentials, which may reach a repository the App is not installed for.
      const token = await Promise.resolve().then(githubToken).catch(() => null);
      try { await git.clone(where.url, into, { token }); }
      catch (error) {
        if (!token || !REFUSED.test(error.message)) throw cloneError(pre.target.name, error);
        try { await git.clone(where.url, into); } catch { throw cloneError(pre.target.name, error); }
      }
      const row = await ctx.libraryDb.get(pre.target.id);
      if (row) { await ctx.libraryDb.updateRepo(row.id, { name: row.name, url: row.url, folder_path: into, github_id: row.github_id || null }); libraryChanged(); }
    });
    return preflight(ctx, projectId, input);
  }

  /* ---------------------------------------------------------------------- start */

  async function start(ctx, projectId, input = {}) {
    reconcile(ctx);
    const kind = input.kind === 'quick' ? 'quick' : 'build';
    // A post-it's text: a quick task's, or a post-it added to a workspace (a Build of it whose task is the post-it).
    const postIt = kind === 'quick' || typeof input.text === 'string' ? String(input.text || '').trim() : null;
    if (postIt === '') throw new Error('The sticky is empty.');
    const wanted = postIt === null ? input.target : { kind: 'default' }; // a post-it's Build: always the default repo
    // A request typed after --build on an @bart line (2026-10-02): a post-it's Build in every way but three. It is not put
    // in as an archived version of the workspace, the workspace is not one of ⌘J's recent ones for it, and it is given
    // as <request> without the workspace's history (./context.cjs).
    const fromLine = kind === 'build' && postIt !== null && !!input.fromLine;
    let pre = await preflight(ctx, projectId, wanted);
    // A library repository that is not on this Mac (a sandbox's, from GitHub) is cloned into repos/<name> first, before
    // anything else: its row keeps the clone (cloneRepository), and the Build works there.
    if (!pre.ok && pre.canClone) pre = await cloneRepository(ctx, projectId, wanted);
    if (pre.ok && (pre.create || pre.init)) { // create: only a default Engelbart makes; init: a folder picked here with no history
      if (pre.create) await makeDefault(pre.directory);
      else await serial(pre.directory, () => git.init(pre.directory));
      pre = await preflight(ctx, projectId, wanted);
    }
    if (!pre.ok) throw new Error(pre.problems[0].message);
    if (pre.target.kind === 'default') await keepDefault(ctx, projectId, pre.directory); // a rename never moves it
    const project = projectOf(ctx, projectId);
    let workspaceId = null;
    let title;
    if (kind === 'build') {
      const { workspace } = projects.findWorkspace(ctx, projectId, input.workspaceId);
      workspaceId = workspace.id;
      title = postIt ? postItTitle(postIt) : workspace.name;
    } else {
      title = postItTitle(postIt);
    }
    const choice = resolveBuildChoice(readModels(), input);
    const at = await git.head(pre.top);
    if (!at.branch) throw new Error('The code folder is not on a branch.');
    const id = await store.freeId(project, (candidate) => git.branchExists(pre.top, `engelbart/${candidate}`));
    const worktree = path.join(ctx.dataRoot, 'worktrees', project.slug, id);
    const inside = path.relative(pre.top, pre.directory);
    const attach = [...new Set((Array.isArray(input.attach) ? input.attach : []).filter((value) => typeof value === 'string' && UUID_RE.test(value)))].slice(0, MAX_ATTACH);
    const task = {
      id, kind, projectId, workspaceId, postItId: postIt && typeof input.postItId === 'string' ? input.postItId : null, postIt, ...(fromLine ? { fromLine } : {}), version: null, title,
      ...choice, sessionId: null,
      target: pre.target, source: pre.directory,
      repo: pre.top, worktree, cwd: inside && !inside.startsWith('..') ? path.join(worktree, inside) : worktree,
      branch: `engelbart/${id}`, baseBranch: at.branch, baseSha: at.sha,
      status: 'setting-up', question: null, error: null, queued: null, turn: 0, checkpoints: [],
      messages: [say('engelbart', `Started on ${choice.modelName} ${choice.effort} in ${pre.target.name}, from ${at.branch} at ${at.sha.slice(0, 7)}${pre.dirty ? `; ${pre.dirty} uncommitted ${pre.dirty === 1 ? 'file' : 'files'} left out` : ''}.`)],
      attach, archive: null, checks: null, conflict: null, accepted: null, created: now().toISOString(), finished: null,
    };
    const frozen = await freezeContext(ctx, projectId, { task, workspaceId, attach, postIt, fromLine });
    task.archive = frozen.archive;
    // A post-it added to a workspace is put in as an archived version of it, after the one it is given as history.
    if (workspaceId && postIt && !fromLine) task.version = await archive.importTask(ctx, projectId, workspaceId, { text: postIt, buildId: id, now });
    store.writeContext(project, id, frozen.text);
    const saved = store.writeTask(project, task, now());
    if (workspaceId) {
      projects.addWorkspaceBuild(ctx, projectId, workspaceId, id);
      if (attach.length) await projects.linkToWorkspace(ctx, projectId, workspaceId, attach); // what was attached shows on the sidebar
      if (postIt && !fromLine) track(() => projects.recordEdit(ctx, projectId, workspaceId)); // ⌘J's recent workspaces
    }
    emit(saved);
    void prepare(ctx, projectId, id);
    return store.publicTask(saved);
  }

  /** The worktree and its setup, then the first turn. A Build discarded meanwhile is cleaned up instead. */
  async function prepare(ctx, projectId, id) {
    const project = projectOf(ctx, projectId);
    let task = store.readTask(project, id);
    try {
      if (!fs.existsSync(task.worktree)) await serial(task.repo, () => git.addWorktree(task.repo, task.worktree, task.branch, task.baseSha));
      await setupWorktree(project, task);
    } catch (error) {
      save(ctx, projectId, id, (held) => ({ status: 'failed', error: `The Build's copy could not be made: ${error.message}`, messages: [...held.messages, say('engelbart', `The Build's copy could not be made: ${error.message}`)] }));
      return;
    }
    task = store.readTask(project, id);
    if (!task || store.FINAL.has(task.status)) { if (task) await cleanUp(task); return; }
    await runTurn(ctx, projectId, id, { message: store.readContext(project, id) || '', fresh: true });
  }

  /** B8: ignored files a checkout lacks. `project.json → build.setup` replaces all of it when set. */
  async function setupWorktree(project, task) {
    const own = readJson(path.join(project.dir, 'project.json')) || {};
    const custom = own.build && typeof own.build.setup === 'string' ? own.build.setup.trim() : null;
    const source = task.source || project.directory; // the chosen repository's folder; a record from before 2026-09-29 has none
    for (const dir of [...new Set([task.repo, source])]) {
      const target = path.join(task.worktree, path.relative(task.repo, dir));
      let names = [];
      try { names = fs.readdirSync(dir).filter((name) => /^\.env(\..+)?$/.test(name)); } catch { names = []; }
      for (const name of names) {
        const to = path.join(target, name);
        try { if (!fs.existsSync(to) && fs.statSync(path.join(dir, name)).isFile()) fs.copyFileSync(path.join(dir, name), to); } catch { /* one file less */ }
      }
    }
    if (custom) {
      const out = await runShell(custom, task.cwd, { env: { ENGELBART_SOURCE_DIR: source } });
      if (!out.ok) throw new Error(`the setup command failed: ${out.output.split('\n').filter(Boolean).slice(-3).join(' ')}`);
      return;
    }
    if (custom === '') return;
    const modules = path.join(source, 'node_modules');
    const theirs = path.join(task.cwd, 'node_modules');
    if (fs.existsSync(modules) && !fs.existsSync(theirs)) await (copyTree || cloneTree)(modules, theirs);
  }

  /** A copy-on-write clone (APFS): instant, and the Build's installs never reach the person's copy. */
  function cloneTree(from, to) {
    return new Promise((resolve, reject) => {
      execFile('/bin/cp', ['-cR', from, to], { timeout: SHELL_MS }, (error) => (error ? reject(new Error(`node_modules could not be copied (${error.message.split('\n')[0]})`)) : resolve()));
    });
  }

  /* ---------------------------------------------------------------------- turns */

  async function runTurn(ctx, projectId, id, { message, fresh = false }) {
    const project = projectOf(ctx, projectId);
    let task = store.readTask(project, id);
    if (!task || store.FINAL.has(task.status) || live.has(id)) return;
    const pool = task.kind === 'quick' ? 'quick' : 'build';
    const controller = new AbortController();
    let settle;
    const entry = { controller, stopping: null, done: new Promise((resolve) => { settle = resolve; }) };
    live.set(id, entry);
    let free = null;
    try {
      await haltRunStep(id); // a run step still working ends (its changes a checkpoint) before the worktree is the agent's again
      if (active[pool] >= limits[pool]) save(ctx, projectId, id, { status: 'queued' });
      free = await slot(pool, controller.signal);
      if (!free) {
        save(ctx, projectId, id, (held) => ({ status: entry.stopping === 'quit' ? 'interrupted' : 'stopped', messages: [...held.messages, say('engelbart', 'Stopped before it started.')] }));
        return;
      }
      task = save(ctx, projectId, id, (held) => ({ status: 'running', error: null, question: null, turn: (held.turn || 0) + 1 }));
      track(() => projects.agentStarted(ctx, { id, kind: 'build', projectId, workspaceId: task.workspaceId, doc: task.workspaceId ? { kind: 'workspace', workspaceId: task.workspaceId } : null }));
      const feed = createFeed({ onProgress: (progress) => { try { notify('engelbart:build-progress', { projectId, id, ...progress }); } catch { /* closed */ } } });
      const diffs = watchDiff(projectId, task);
      let diffsDone = Promise.resolve();
      const system = loadBuildPrompt(ctx.dataRoot, { quick: task.kind === 'quick' });
      const policy = buildPolicy({ project, dataRoot: ctx.dataRoot });
      const agent = TOOL_OF[task.provider];
      const once = (session, text) => {
        feed.reset();
        // Each step, and whatever the model starts after one (a tool's result is in by then), reads the diff again.
        const onUpdate = (update) => { feed.take(update); if (update && (update.log || update.activity || update.textStart)) diffs.poke(); };
        const call = () => runner.turn({ task: { ...task, worktree: task.cwd }, message: text, session, system, policy, signal: controller.signal, timeoutMs: turnMs[pool], onUpdate });
        return tools ? tools.use(agent, call) : call();
      };
      let out = null;
      let failure = null;
      try {
        if (tools) await tools.ensure(agent);
        try {
          // No session to go on with (the first turn was cut short before one was named): everything again, and what was said.
          out = !fresh && !task.sessionId ? await once(null, freshMessage(store.readContext(project, id), task.messages, message)) : await once(fresh ? null : task.sessionId, message);
        } catch (error) {
          if (error.kind === 'stopped' || fresh || !task.sessionId) throw error;
          // A session that will not resume (its file is gone, the CLI changed): everything again, and what was said.
          out = await once(null, freshMessage(store.readContext(project, id), task.messages, message));
        }
      } catch (error) {
        failure = error;
      } finally {
        feed.end();
        diffsDone = diffs.end();
      }
      let sha = null;
      let kept = null;
      // A turn that was resolving a conflict and did not finish leaves no half-merge behind: the Build goes back to its conflict.
      const unresolved = !!failure && (await git.merging(task.worktree).catch(() => false));
      if (unresolved) await git.abortMerge(task.worktree).catch(() => false);
      else { try { sha = await git.concludeMerge(task.worktree, `Build ${task.title}: turn ${task.turn}`, await git.identity(task.repo)); } catch (error) { kept = error.message; } }
      const stopping = entry.stopping;
      task = save(ctx, projectId, id, (held) => {
        const next = { sessionId: (out && out.session) || (failure && failure.session) || held.sessionId, checkpoints: sha ? [...held.checkpoints, { sha, turn: held.turn, at: now().toISOString() }] : held.checkpoints };
        const notes = kept ? [say('engelbart', `The turn's work could not be saved as a checkpoint: ${kept}`)] : [];
        if (unresolved) {
          next.status = stopping === 'quit' ? 'interrupted' : 'conflict';
          next.messages = [...held.messages, say('engelbart', `${failure.kind === 'stopped' ? 'Stopped' : failure.message} The conflict was left as it was before.`)];
        } else if (failure && failure.kind === 'stopped' && stopping === 'reply' && held.queued) {
          next.status = 'running'; // cut short for the reply, which goes on at once in the same session: nothing to say
          next.messages = [...held.messages, ...notes];
        } else if (failure && failure.kind === 'stopped') {
          next.status = stopping === 'quit' ? 'interrupted' : 'stopped';
          next.messages = [...held.messages, ...notes, say('engelbart', stopping === 'quit' ? 'Engelbart closed while this turn was working. What it had done is saved.' : 'Stopped. What it had done is saved.')];
        } else if (failure) {
          next.status = 'failed';
          next.error = failure.message;
          next.messages = [...held.messages, ...notes, say('engelbart', failure.message)];
        } else {
          const end = readEnding(out.text, { quick: held.kind === 'quick' });
          next.messages = [...held.messages, ...notes, ...(end.text.trim() || end.ending === 'done' ? [say('agent', end.text || out.text)] : [])];
          next.status = end.ending === 'needs-you' ? 'needs-you' : end.ending === 'escalated' ? 'escalated' : 'review';
          next.question = end.ending === 'needs-you' ? end.question : null;
          next.escalation = end.ending === 'escalated' ? end.why || end.question || null : null;
        }
        return next;
      });
      track(() => projects.agentFinished(ctx, id));
      void diffsDone.then(() => sendDiff(projectId, task, false));
    } finally {
      if (free) free();
      live.delete(id);
      settle();
    }
    if (quitting) return;
    const after = store.readTask(project, id);
    if (!after || store.FINAL.has(after.status)) return;
    if (after.queued) {
      const text = after.queued, images = after.queuedImages || [];
      save(ctx, projectId, id, (held) => ({ queued: null, queuedImages: null, messages: [...held.messages, say('you', text, imageRefs(images))] }));
      void runTurn(ctx, projectId, id, { message: replyMessage(text, images) });
      return;
    }
    // An Accept that sent its refusal to the agent runs again once the agent is done; a turn that ended any other way
    // (a question, stopped, failed) leaves it to the person.
    if (after.landing) {
      if (after.status === 'review') void accept(ctx, projectId, id, { attempt: after.landing.attempt }).catch(() => {});
      else save(ctx, projectId, id, { landing: null });
      return;
    }
    // A quick task that finished cleanly lands by itself (B23); anything else waits for the person. A Build that finished
    // a turn gets its run step (never a quick task: Accept would remove its worktree under what it started).
    if (after.kind === 'quick' && after.status === 'review') void accept(ctx, projectId, id, { auto: true }).catch(() => {});
    else if (after.kind === 'build' && after.status === 'review') startRunStep(ctx, projectId, id);
  }

  /* ------------------------------------------------------------------- run step */

  /**
   * The library row of the repository a Build works in: the one it was started in (task.source), whatever the default is
   * now. The default repo's is made when it has none (the code directory's too, when that is the default); null: none.
   */
  async function repositoryRow(ctx, projectId, task) {
    const target = task.target || {};
    if (target.kind === 'library') return ctx.libraryDb.get(target.id);
    const at = task.source || task.repo;
    if (target.kind === 'default') return recordDefault(ctx, projectId, at);
    const row = await rowAt(ctx, at);
    return isRepo(row) ? row : null;
  }

  /** What a run step's runnables came to, in one line for the conversation. */
  function runLine(result, failure) {
    if (failure && failure.stopped) return 'Run step stopped.';
    const list = result ? result.runnables : [];
    const said = list.map((item) => `${item.name} (${item.type === 'ui' ? 'web UI' : item.type === 'app' ? 'desktop app' : 'terminal'}) ${item.status === 'running' ? (item.url ? `runs at ${item.url}` : 'runs') : 'did not run'}`);
    if (failure) return `Run step failed: ${failure.message}${said.length ? ` ${said.join('; ')}.` : ''}`;
    return said.length ? `Run step: ${said.join('; ')}.` : 'Run step: nothing here to run.';
  }

  /**
   * After a turn that ended in review: what the last run step left running is stopped, and the run step runs again in the
   * worktree, on the Build's model (Claude Code's default Build model for a Codex Build). Its changes are one checkpoint.
   */
  function startRunStep(ctx, projectId, id) {
    if (!runStep || quitting) return;
    const work = (async () => {
      await runStep.stop(id);
      const project = projectOf(ctx, projectId);
      const task = store.readTask(project, id);
      if (!task || task.status !== 'review' || live.has(id) || !fs.existsSync(task.worktree)) return;
      const row = await repositoryRow(ctx, projectId, task).catch(() => null);
      if (!row) {
        save(ctx, projectId, id, { runStep: { status: 'skipped', turn: task.turn, runnables: [], error: 'This repository is not in the library, so nothing it runs can be kept.' } });
        return;
      }
      const choice = task.provider === 'anthropic' ? { modelId: task.modelId, effort: task.effort } : resolveBuildChoice(readModels(), { provider: 'anthropic' });
      // What the Build changed since it started, as paths in the folder it works in: where the run step looks first.
      const diff = await git.exec(task.cwd, ['diff', '--name-only', '--no-renames', '--relative', task.baseSha, 'HEAD']).catch(() => null);
      const changed = diff ? diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 200) : [];
      const put = (change) => save(ctx, projectId, id, (held) => ({ runStep: { ...(held.runStep || {}), ...change } }));
      put({ status: 'running', turn: task.turn, started: now().toISOString(), finished: null, error: null, phase: 'Starting', runnables: [] });
      let result = null;
      let failure = null;
      try {
        result = await runStep.run({
          id, root: task.cwd, name: task.target ? task.target.name : path.basename(task.repo), libraryId: row.id, db: ctx.libraryDb, changed,
          model: choice.modelId, effort: choice.effort,
          onState: (state) => put(state),
        });
      } catch (error) {
        failure = error;
      }
      // What the run step changed: a checkpoint of its own, which Review shows apart from the Build's work.
      let sha = null;
      try { sha = await git.checkpoint(task.worktree, `Build ${task.title}: run step`, await git.identity(task.repo)); } catch { sha = null; }
      save(ctx, projectId, id, (held) => ({
        checkpoints: sha ? [...held.checkpoints, { sha, turn: held.turn, at: now().toISOString(), step: 'run' }] : held.checkpoints,
        runStep: { ...(held.runStep || {}), status: failure ? (failure.stopped ? 'stopped' : 'failed') : 'done', phase: null, error: failure && !failure.stopped ? failure.message : null, finished: now().toISOString(), changed: !!sha },
        messages: [...held.messages, say('engelbart', runLine(result, failure))],
      }));
    })().catch(() => {}).finally(() => { if (stepping.get(id) === work) stepping.delete(id); });
    stepping.set(id, work);
  }

  /** A run step that is working ends now: its agent stops, and its changes become its checkpoint. What passed keeps running. */
  async function haltRunStep(id) {
    const work = stepping.get(id);
    if (!work) return;
    if (runStep) await runStep.halt(id);
    await work;
  }

  /** Everything a Build's run steps started is stopped (Accept, Discard). */
  async function stopRunStep(id) {
    await haltRunStep(id);
    if (runStep) await runStep.stop(id);
  }
  /** The record's run step once what it started is stopped: nothing it lists runs any more. */
  const stoppedRunStep = (held) => (held.runStep ? { runStep: { ...held.runStep, runnables: (held.runStep.runnables || []).map((item) => (item.status === 'running' ? { ...item, status: 'stopped', sessionId: null, pid: null } : item)) } } : {});

  /**
   * What the Build's last run step found, written to the repository's rows once the Build is accepted (`commit`: what
   * landed, or the commit it ran on when nothing changed): a runnable that passed with its commands, verified at that
   * commit; one that failed with its last error. Only then: the stored commands are always ones an accepted Build ran.
   */
  async function recordRunnables(ctx, projectId, task, commit) {
    const list = ((task.runStep && task.runStep.runnables) || []).filter((item) => item.passed || item.status === 'failed');
    if (!list.length) return 0;
    const row = await repositoryRow(ctx, projectId, task);
    if (!row) return 0;
    const rows = runnableStore(ctx.libraryDb);
    for (const item of list) {
      const kept = await rows.declare(row.id, { folder: item.folder, name: item.name, type: item.type });
      if (item.passed) await rows.verify(kept.id, { install_command: item.install_command, run_command: item.run_command, commit });
      else await rows.fail(kept.id, item.error || 'It did not pass its check.');
    }
    return list.length;
  }

  /**
   * A runnable the run step got running, opened for the person (from Review; nothing is shown before): a UI in a Stage
   * tab, a terminal program in Engelbart's terminal (a session of its own, opened now when it has none open), a desktop
   * app's window brought to the front.
   */
  async function showRunnable(ctx, projectId, id, name) {
    const task = read(ctx, projectId, id);
    const item = ((task.runStep && task.runStep.runnables) || []).find((entry) => entry.name === name);
    if (!item || item.status !== 'running') throw new Error(`${name} is not running.`);
    if (item.type === 'ui' && item.url) { notify('engelbart:build-run', { projectId, id, kind: 'ui', name, url: item.url }); return true; }
    if (!runStep) throw new Error(`${name} cannot be opened here.`);
    if (item.type === 'app') {
      if (!(await runStep.focus(id, item))) throw new Error(`${name}'s window could not be brought to the front.`);
      return true;
    }
    if (!item.run_command) throw new Error(`${name} has no command to open.`);
    const session = runStep.terminal(id, { name, cwd: worktreePath(task.cwd, item.folder), command: item.run_command, sessionId: item.sessionId });
    if (session.id !== item.sessionId) {
      save(ctx, projectId, id, (held) => (held.runStep ? { runStep: { ...held.runStep, runnables: (held.runStep.runnables || []).map((entry) => (entry.name === name ? { ...entry, sessionId: session.id } : entry)) } } : {}));
    }
    notify('engelbart:build-run', { projectId, id, kind: 'terminal', name, session });
    return true;
  }

  /**
   * An accepted Build's kept copy goes (its last runnable stopped, Engelbart quitting): what its run steps started is
   * stopped, then its worktree and branch are removed.
   */
  async function releaseCopy(ctx, projectId, id, note) {
    keptCopies.delete(id);
    if (runStep) await runStep.stop(id);
    const task = store.readTask(projectOf(ctx, projectId), id);
    if (!task) return;
    await cleanUp(task).catch(() => {});
    save(ctx, projectId, id, (held) => ({ ...stoppedRunStep(held), keptCopy: false, messages: [...held.messages, say('engelbart', note)] }));
  }

  /**
   * On an accepted Build's card (its copy kept while something runs): one runnable stopped (`name`), or all of them
   * (null). The copy goes with the last one.
   */
  async function stopRunnable(ctx, projectId, id, name = null) {
    const task = read(ctx, projectId, id);
    if (task.status !== 'accepted' || !task.keptCopy) throw new Error('Nothing of this Build is running.');
    const runnables = (task.runStep && task.runStep.runnables) || [];
    const item = name === null ? null : runnables.find((entry) => entry.name === name && entry.status === 'running');
    if (name !== null && !item) throw new Error(`${name} is not running.`);
    if (item && runnables.some((entry) => entry !== item && entry.status === 'running')) {
      if (runStep) await runStep.stopOne(id, item);
      save(ctx, projectId, id, (held) => ({ runStep: { ...held.runStep, runnables: held.runStep.runnables.map((entry) => (entry.name === name ? { ...entry, status: 'stopped', sessionId: null, pid: null } : entry)) } }));
    } else {
      const names = runnables.filter((entry) => entry.status === 'running').map((entry) => entry.name);
      await releaseCopy(ctx, projectId, id, `Stopped ${names.join(', ')}. Nothing of it runs now, and its copy is removed.`);
    }
    return get(ctx, projectId, id);
  }

  /**
   * A copy an accepted Build kept when Engelbart closed without stopping it (it crashed): what it ran is stopped (a
   * process group only while it is still the one started there), then the copy goes.
   */
  async function sweepCopy(ctx, project, task) {
    const runnables = (task.runStep && task.runStep.runnables) || [];
    if (fs.existsSync(task.worktree)) {
      for (const item of runnables) if (item.pid && runStep) await runStep.stopLeftover(item.pid, task.worktree).catch(() => false);
      await cleanUp(task).catch(() => {});
    } else {
      await serial(task.repo, () => git.deleteBranch(task.repo, task.branch)).catch(() => false);
    }
    const held = store.readTask(project, task.id);
    if (held) emit(store.writeTask(project, { ...held, ...stoppedRunStep(held), keptCopy: false, messages: [...held.messages, say('engelbart', 'Engelbart closed without stopping what ran on it; it was stopped when Engelbart started again, and its copy removed.')] }, now()));
  }

  /** The run step that is working stops; what already passed keeps running. */
  async function stopRunning(ctx, projectId, id) {
    read(ctx, projectId, id);
    await haltRunStep(id);
    return get(ctx, projectId, id);
  }

  /**
   * The person's reply: the next turn now, or after the one running. With `interrupt` (the card's send, 2026-09-27: no
   * Stop & send to press) a turn that is running is cut short, its work saved, and the reply goes on in the same session.
   */
  async function reply(ctx, projectId, id, text, { interrupt = false, images: pasted = [] } = {}) {
    reconcile(ctx);
    const said = String(text || '').trim();
    const task = read(ctx, projectId, id);
    if (!said) return store.publicTask(task);
    if (store.FINAL.has(task.status)) throw new Error('This Build is closed.');
    if (task.status === 'accepting') throw new Error('It is being accepted; reply once that is done.');
    // only the images the reply still names (an [Attachment n] deleted from the text is not sent)
    const images = (await pastedImages(ctx, projectId, pasted)).filter((image) => said.includes(`[Attachment ${image.n}]`));
    // The person saying something takes over from an Accept that was fixing its refusal by itself.
    if (live.has(id) || task.status === 'setting-up') {
      const next = save(ctx, projectId, id, (held) => ({ landing: null, queued: held.queued ? `${held.queued}\n\n${said}` : said, queuedImages: [...(held.queuedImages || []), ...images] }));
      if (interrupt && task.status === 'running') stop(projectId, id, 'reply');
      return store.publicTask(next);
    }
    if (!fs.existsSync(task.worktree)) throw new Error('This Build\'s copy is gone; discard it.');
    const next = save(ctx, projectId, id, (held) => ({ landing: null, queued: null, queuedImages: null, error: null, messages: [...held.messages, say('you', said, imageRefs(images))] }));
    void runTurn(ctx, projectId, id, { message: replyMessage(said, images) });
    return store.publicTask(next);
  }

  function stop(projectId, id, why = 'stop') {
    const entry = live.get(id);
    if (!entry) return false;
    entry.stopping = entry.stopping || why;
    entry.controller.abort();
    return true;
  }

  /** An interrupted, stopped or failed Build goes on: its setup again when it never finished, else the same session. */
  async function resume(ctx, projectId, id) {
    reconcile(ctx);
    const task = read(ctx, projectId, id);
    if (store.FINAL.has(task.status) || live.has(id)) return store.publicTask(task);
    if (!fs.existsSync(task.worktree) || task.turn === 0) {
      save(ctx, projectId, id, { status: 'setting-up', error: null });
      void prepare(ctx, projectId, id);
      return store.publicTask(read(ctx, projectId, id));
    }
    const next = save(ctx, projectId, id, (held) => ({ error: null, messages: [...held.messages, say('engelbart', 'Resumed.')] }));
    void runTurn(ctx, projectId, id, { message: fromEngelbart('Your last turn was cut off (Engelbart closed, it was stopped, or it failed). Your work so far is committed in the working copy. Continue where you left off.') });
    return store.publicTask(next);
  }

  /* --------------------------------------------------------------------- review */

  async function review(ctx, projectId, id) {
    reconcile(ctx);
    const task = read(ctx, projectId, id);
    if (task.status === 'accepted' && task.accepted) {
      const d = await git.diff(task.repo, `${task.accepted.sha}^`, task.accepted.sha);
      return { ...d, from: task.baseBranch, sha: task.accepted.sha };
    }
    if (!fs.existsSync(task.worktree)) throw new Error('This Build\'s copy is gone.');
    const running = live.has(id);
    const base = { from: task.baseBranch, base: task.baseSha, running, stepping: stepping.has(id) };
    // The run steps' changes apart: the Build's own work is HEAD without them.
    const runs = (task.checkpoints || []).filter((checkpoint) => checkpoint.step === 'run').map((checkpoint) => checkpoint.sha);
    // While a turn works, or with no run step's changes: as the worktree stands, what the agent has not saved yet too;
    // nothing is committed for it (2026-09-29).
    if (running || (!runs.length && !stepping.has(id))) {
      const d = git.workingDiff ? await git.workingDiff(task.worktree, task.baseSha, { maxPatch: CARD_PATCH }) : await git.diff(task.worktree, task.baseSha, 'HEAD');
      return { ...d, ...base };
    }
    const d = await git.diff(task.worktree, task.baseSha, 'HEAD');
    if (!runs.length) return { ...d, ...base };
    const own = await git.treeWithout(task.worktree, runs).catch(() => null);
    if (own) return { ...(await git.diff(task.worktree, task.baseSha, own)), ...base, runStep: { ...(await git.diff(task.worktree, own, 'HEAD')), apart: true } };
    // A later turn changed the same lines: everything together, and each run step's own changes as it made them.
    const parts = await Promise.all(runs.map((sha) => git.diff(task.worktree, `${sha}^`, sha)));
    return { ...d, ...base, runStep: { files: parts.flatMap((part) => part.files), patch: parts.map((part) => part.patch).join('\n'), truncated: parts.some((part) => part.truncated), apart: false } };
  }

  /* --------------------------------------------------------------------- accept */

  function checkCommand(project, task) {
    const own = readJson(path.join(project.dir, 'project.json')) || {};
    if (own.build && typeof own.build.check === 'string') return own.build.check.trim() || null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(task.cwd, 'package.json'), 'utf8'));
      const test = pkg && pkg.scripts && pkg.scripts.test;
      if (typeof test === 'string' && test.trim() && !/no test specified/.test(test)) return 'npm test';
    } catch { /* no package.json */ }
    return null;
  }

  const lastSummary = (task) => { const said = [...task.messages].reverse().find((m) => m.role === 'agent'); return said ? said.text.trim().slice(0, 3000) : ''; };

  /**
   * `auto`: a quick task landing by itself. `attempt`: this is Accept run again after the agent's fix number `attempt`
   * (0: the person pressed it). A conflict or failed checks go to the agent while fixes are left (autoFixes).
   */
  async function accept(ctx, projectId, id, { auto = false, attempt = 0 } = {}) {
    reconcile(ctx);
    const project = projectOf(ctx, projectId);
    const task = read(ctx, projectId, id);
    if (store.FINAL.has(task.status)) return store.publicTask(task);
    if (live.has(id) || task.status === 'setting-up' || task.status === 'accepting') throw new Error('It is still working.');
    if (!fs.existsSync(task.worktree)) throw new Error('This Build\'s copy is gone; discard it.');
    await haltRunStep(id); // what a working run step changed is part of what is accepted
    const before = task.status;
    save(ctx, projectId, id, { status: 'accepting', error: null, conflict: null });
    try {
      return await serial(task.repo, async () => {
        const who = await git.identity(task.repo);
        await git.concludeMerge(task.worktree, `Build ${task.title}: before accept`, who);
        const target = await git.head(task.repo);
        if (!target.branch) throw new Error('Your code folder is not on a branch.');
        const base = await git.mergeBase(task.worktree, task.branch, target.sha);
        const tip = await git.revParse(task.worktree, task.branch);
        const turns = (task.checkpoints || []).length;
        const body = [lastSummary(task), `Engelbart Build ${task.id} · ${task.modelName} ${task.effort} · ${turns} ${turns === 1 ? 'turn' : 'turns'}`].filter(Boolean).join('\n\n');
        let sha = null;
        try {
          sha = tip === base ? null : await git.squashOnto(task.worktree, { branch: task.branch, base, onto: target.sha, message: `${task.title}\n\n${body}\n`, who });
        } catch (error) {
          if (error.code === 'conflict') error.message = `${target.branch} and this Build changed the same lines in ${error.files.join(', ')}.`;
          throw error;
        }
        let checks = null;
        if (sha) {
          // A conflict the agent left half resolved never lands: its markers send the Build back to its conflict.
          const marked = await git.markers(task.worktree, target.sha, sha);
          if (marked.length) {
            await git.checkoutBranch(task.worktree, task.branch);
            throw Object.assign(new Error(`${marked.join(', ')} still ${marked.length === 1 ? 'holds' : 'hold'} conflict markers.`), { code: 'conflict', files: marked, markers: true });
          }
          const command = checkCommand(project, task);
          if (command) {
            const ran = await runShell(command, task.cwd);
            checks = { command, ok: ran.ok, output: ran.output, at: now().toISOString() };
            if (!ran.ok) {
              await git.checkoutBranch(task.worktree, task.branch);
              throw Object.assign(new Error(`The checks failed (${command}).`), { checks });
            }
          }
          try {
            await git.fastForward(task.repo, { branch: target.branch, expected: target.sha, sha });
          } catch (error) {
            await git.checkoutBranch(task.worktree, task.branch);
            throw error;
          }
        }
        // It landed: what its run step found is the repository's now (its rows), at the commit that landed.
        const landed = store.readTask(project, id);
        let unkept = null;
        try { await recordRunnables(ctx, projectId, landed, sha || tip); } catch (error) { unkept = error.message; }
        // What runs stays up (2026-09-29): the copy stays, detached at what landed (squashOnto left it there), so the
        // preview is the code that landed, until its last runnable is stopped, Engelbart quits, or (after a crash) starts.
        const up = ((landed.runStep && landed.runStep.runnables) || []).filter((item) => item.status === 'running').map((item) => item.name);
        const keep = !!runStep && up.length > 0 && runStep.holds(id);
        if (keep) {
          if (!sha) await git.exec(task.worktree, ['checkout', '--quiet', '--detach']).catch(() => null);
          keptCopies.set(id, { ctx, projectId });
        } else {
          if (runStep) await runStep.stop(id); // what the run steps started runs in the worktree: stopped before it goes
          await removeCopy(task); // inside this repository's turn already: not cleanUp, which would wait for it
        }
        const done = save(ctx, projectId, id, (held) => ({
          ...(keep ? { keptCopy: true } : stoppedRunStep(held)),
          status: 'accepted', finished: now().toISOString(), checks, queued: null, landing: null,
          accepted: sha ? { sha, branch: target.branch, at: now().toISOString() } : null,
          messages: [...held.messages, say('engelbart', `${sha ? `Accepted onto ${target.branch} as ${sha.slice(0, 7)}${auto ? ' (a quick task that finished cleanly lands by itself)' : ''}.` : 'Nothing had changed, so there was nothing to accept.'}${keep ? ` ${up.join(', ')} ${up.length === 1 ? 'keeps' : 'keep'} running on it until you stop ${up.length === 1 ? 'it' : 'them'}.` : ''}${unkept ? ` What its run step found could not be kept: ${unkept}` : ''}`)],
        }));
        track(() => projects.agentStopped(ctx, id));
        return store.publicTask(done);
      });
    } catch (error) {
      const conflict = error && error.code === 'conflict';
      const fixable = conflict || !!error.checks;
      const again = !auto && fixable && attempt < autoFixes; // back to the agent, then Accept again
      const gaveUp = !auto && fixable && attempt > 0 && !again;
      const note = gaveUp ? ` Still refused after the agent's ${attempt === 1 ? 'fix' : `${attempt} fixes`}; press Accept to send it again.` : '';
      const next = save(ctx, projectId, id, (held) => ({
        status: conflict ? 'conflict' : ['accepting', 'conflict'].includes(before) ? 'review' : before,
        error: error.message,
        conflict: conflict ? { files: error.files || [], markers: !!error.markers } : null,
        checks: error.checks || held.checks || null,
        landing: again ? { attempt: attempt + 1 } : null,
        messages: [...held.messages, say('engelbart', `Not accepted: ${error.message}${note}`)],
      }));
      if (again) {
        try { return await sendFix(ctx, projectId, id); }
        catch (failure) {
          const left = save(ctx, projectId, id, (held) => ({ landing: null, error: failure.message, messages: [...held.messages, say('engelbart', `It could not be sent to the agent: ${failure.message}`)] }));
          if (attempt > 0) return store.publicTask(left);
          throw failure;
        }
      }
      if (auto || attempt > 0) return store.publicTask(next);
      throw error;
    }
  }

  /**
   * A refused Accept sent to the agent (by Accept itself since 2026-09-29; "Send to agent" before): for a conflict
   * Engelbart merges the person's branch into the Build's (the markers left in the files), for failed checks it passes
   * their output; either way the same session takes it up. A branch that merges in cleanly needs no turn: Accept runs
   * again at once when it was Accept that sent it.
   */
  async function fix(ctx, projectId, id) {
    reconcile(ctx);
    return sendFix(ctx, projectId, id);
  }
  async function sendFix(ctx, projectId, id) {
    const task = read(ctx, projectId, id);
    if (live.has(id)) return store.publicTask(task);
    let note;
    let summary;
    if (task.status === 'conflict') {
      const target = await git.head(task.repo);
      const files = await serial(task.repo, async () => git.mergeInto(task.worktree, target.sha, await git.identity(task.repo)));
      const left = task.conflict && task.conflict.markers ? task.conflict.files || [] : [];
      if (!files.length && !left.length) {
        await git.concludeMerge(task.worktree, `Build ${task.title}: ${target.branch} merged in`, await git.identity(task.repo));
        const merged = save(ctx, projectId, id, (held) => ({ status: 'review', conflict: null, error: null, messages: [...held.messages, say('engelbart', `${target.branch || 'Your branch'} merged in without conflicts.${held.landing ? '' : ' Accept again.'}`)] }));
        if (merged.landing) return accept(ctx, projectId, id, { attempt: merged.landing.attempt });
        return store.publicTask(merged);
      }
      if (files.length) {
        note = `To accept this Build, Engelbart merged ${target.branch || 'the person\'s branch'} (at ${target.sha.slice(0, 7)}) into your branch, and both sides had changed the same lines in ${files.join(', ')}. Those files now hold conflict markers. Resolve them so both changes survive, check the result, and reply as usual.`;
        summary = `Sent the conflict in ${files.join(', ')} to the agent.`;
      } else {
        await git.concludeMerge(task.worktree, `Build ${task.title}: ${target.branch} merged in`, await git.identity(task.repo));
        note = `${left.join(', ')} still ${left.length === 1 ? 'holds' : 'hold'} conflict markers (lines starting <<<<<<< or >>>>>>>) from an earlier merge with ${target.branch || 'the person\'s branch'}. Resolve them so both changes survive, check the result, and reply as usual.`;
        summary = `Sent the conflict markers left in ${left.join(', ')} to the agent.`;
      }
    } else if (task.checks && !task.checks.ok) {
      note = `The project's checks failed when this Build was about to be accepted:\n\n$ ${task.checks.command}\n${task.checks.output}\n\nFix what fails, run them again, and reply as usual.`;
      summary = `Sent the failed checks (${task.checks.command}) to the agent.`;
    } else {
      return store.publicTask(task);
    }
    const next = save(ctx, projectId, id, (held) => ({ conflict: null, error: null, messages: [...held.messages, say('engelbart', held.landing ? `${summary.replace(/\.$/, '')}; Accept runs again when it is done.` : summary)] }));
    void runTurn(ctx, projectId, id, { message: fromEngelbart(note) });
    return store.publicTask(next);
  }

  /* -------------------------------------------------------------------- discard */

  async function removeCopy(task) {
    await git.removeWorktree(task.repo, task.worktree);
    await git.deleteBranch(task.repo, task.branch);
  }
  const cleanUp = (task) => serial(task.repo, () => removeCopy(task));

  async function discard(ctx, projectId, id) {
    reconcile(ctx);
    const task = read(ctx, projectId, id);
    if (store.FINAL.has(task.status)) return store.publicTask(task);
    const entry = live.get(id);
    if (entry) { stop(projectId, id); await entry.done; }
    if (read(ctx, projectId, id).status === 'accepting') throw new Error('It is being accepted.');
    await stopRunStep(id); // everything its run steps started
    const next = save(ctx, projectId, id, (held) => ({ ...stoppedRunStep(held), status: 'discarded', queued: null, finished: now().toISOString(), messages: [...held.messages, say('engelbart', 'Discarded.')] }));
    track(() => projects.agentStopped(ctx, id));
    if (task.status !== 'setting-up') await cleanUp(task).catch(() => {}); // a Build still being set up is cleaned up when that ends
    return store.publicTask(next);
  }

  /**
   * A quick task that turned out big (B23): it becomes a Build of `workspaceId`, and the same session goes on. Its post-it
   * is put in as an archived version of the workspace (2026-09-27), and the workspace joins ⌘J's recent ones.
   */
  async function promote(ctx, projectId, id, workspaceId, picked = null) {
    reconcile(ctx);
    const task = read(ctx, projectId, id);
    if (task.kind !== 'quick' || store.FINAL.has(task.status) || live.has(id)) throw new Error('Only a quick task that is not working can become a Build.');
    const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
    // The post-it's "Needs you" card offers the model again, set to what the task ran on (2026-09-27). Another model of the
    // same provider goes on in the same session; another provider cannot, so its first turn gets everything again.
    const choice = picked ? resolveBuildChoice(readModels(), picked) : null;
    const moved = choice && choice.provider !== task.provider;
    const version = await archive.importTask(ctx, projectId, workspace.id, { text: postItOf(task, store.readContext(projectOf(ctx, projectId), id)), buildId: id, now });
    projects.addWorkspaceBuild(ctx, projectId, workspace.id, id);
    track(() => projects.recordEdit(ctx, projectId, workspace.id));
    const changed = choice && (choice.provider !== task.provider || choice.model !== task.model || choice.effort !== task.effort);
    const next = save(ctx, projectId, id, (held) => ({
      kind: 'build', workspaceId: workspace.id, version, escalation: null,
      ...(choice || {}), ...(moved ? { sessionId: null } : {}),
      messages: [...held.messages, say('engelbart', `Moved to the workspace "${workspace.name}" as a Build${changed ? ` on ${choice.modelName} ${choice.effort}` : ''}.`)],
    }));
    void runTurn(ctx, projectId, id, { message: fromEngelbart('This is now a full Build, not a quick task: larger changes are fine, and you may ask the person a question with NEEDS YOU. Go ahead with what the post-it asked for.') });
    return store.publicTask(next);
  }

  /* ------------------------------------------------------------------- recovery */

  /** Records left working by an app that closed are interrupted (B19); a Build whose copy is gone has failed. Once per data root. */
  function reconcile(ctx) {
    if (reconciled.has(ctx.dataRoot)) return;
    reconciled.add(ctx.dataRoot);
    const left = [];
    for (const project of projects.projectRecords(ctx)) {
      for (const task of store.listTasks(project)) {
        if (store.FINAL.has(task.status) && task.keptCopy && !keptCopies.has(task.id)) left.push({ project, task }); // Engelbart crashed while it ran
        if (store.FINAL.has(task.status) || live.has(task.id)) continue;
        const gone = task.status !== 'setting-up' && !fs.existsSync(task.worktree);
        const runStepLeft = task.runStep && task.runStep.status === 'running' ? { runStep: { ...task.runStep, status: 'stopped', phase: null } } : {}; // Engelbart closed during it
        if (gone) store.writeTask(project, { ...task, ...runStepLeft, status: 'failed', error: 'This Build\'s copy is gone.', messages: [...task.messages, say('engelbart', 'This Build\'s copy is gone; discard it.')] }, now());
        else if (store.WORKING.has(task.status)) store.writeTask(project, { ...task, ...runStepLeft, status: 'interrupted', landing: null, messages: [...task.messages, say('engelbart', 'Engelbart closed while this was working.')] }, now());
        else if (runStepLeft.runStep) store.writeTask(project, { ...task, ...runStepLeft }, now());
      }
    }
    for (const { project, task } of left) {
      const work = sweepCopy(ctx, project, task).catch(() => {}).finally(() => sweeps.delete(work));
      sweeps.add(work);
    }
  }

  function list(ctx, projectId) {
    reconcile(ctx);
    return store.listTasks(projectOf(ctx, projectId)).map((task) => ({ ...store.publicTask(task), working: live.has(task.id) }));
  }

  function get(ctx, projectId, id) {
    reconcile(ctx);
    return { ...store.publicTask(read(ctx, projectId, id)), working: live.has(id) };
  }

  /** The Builds of a project that are not closed: Clear keeps their lines in the blank document. */
  function openIds(ctx, projectId) {
    return new Set(store.listTasks(projectOf(ctx, projectId)).filter((task) => !store.FINAL.has(task.status)).map((task) => task.id));
  }

  /**
   * Quit: every turn is stopped and its checkpoint saved (at most QUIT_WAIT_MS), and becomes `interrupted`; what run steps
   * started is stopped, and the copies accepted Builds kept for it go.
   */
  async function stopAll() {
    quitting = true;
    const running = [...live.values()];
    for (const entry of running) { entry.stopping = 'quit'; entry.controller.abort(); }
    const kept = [...keptCopies.entries()];
    const steps = runStep ? [runStep.stopAll().then(() => Promise.all(kept.map(([id, where]) => releaseCopy(where.ctx, where.projectId, id, 'Engelbart closed: what ran on it was stopped, and its copy removed.').catch(() => {})))), ...stepping.values(), ...sweeps] : [];
    await Promise.race([Promise.all([...running.map((entry) => entry.done), ...steps]), new Promise((resolve) => { const timer = setTimeout(resolve, QUIT_WAIT_MS); if (timer.unref) timer.unref(); })]);
  }

  return { targets, setDefault, preflight, initRepository, prepareDefault, cloneRepository, start, reply, stop, resume, review, accept, fix, discard, promote, reconcile, list, get, openIds, stopAll, running: () => [...live.keys()], stepping: (id) => stepping.has(id), showRunnable, stopRunning, stopRunnable, sweeping: () => Promise.all([...sweeps]) };
}

module.exports = { createBuilds, createShell, checkOutput, LIMITS, TURN_MS, CLONES, AUTO_FIXES };
