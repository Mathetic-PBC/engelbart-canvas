'use strict';

// Build's lifecycle (2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md). One manager for the
// app, holding what runs now; everything that must outlive the app is in the task records (./store.cjs).
//
//   start      the record, the frozen context, then in the background the worktree (git), its setup, the first turn. A
//              post-it added to a workspace is a Build of it whose task is the post-it, put in as an archived version
//   turn       a slot (three for Builds, one of its own for quick tasks), the agent (./runner.cjs) under its CLI's tool
//              lock, a checkpoint commit, the ending read (NEEDS YOU / ESCALATE / done), a reply that waited sent next
//   reply      the next turn in the same session; while a turn runs it waits, or (`interrupt`) the turn is cut short
//   review     the diff from where the Build started
//   accept     leftovers committed, everything squashed into one commit, replayed onto the person's current branch, the
//              checks, a fast-forward of their folder; worktree and branch removed. Refusals change nothing
//   discard    stopped, worktree and branch removed
//   recovery   a record left working when the app closed is `interrupted`; Resume continues its session
// Git writes that touch the shared repository's worktrees (add, remove) and Accept run one at a time per repository.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const projects = require('../store/projects.cjs');
const archive = require('../store/archive.cjs');
const { readJson } = require('../store/home.cjs');
const { inspectRepository } = require('../tools/repository.cjs');
const { resolveBuildChoice } = require('../bart/models.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');
const { createFeed } = require('../bart/activity.cjs');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const store = require('./store.cjs');
const { freezeContext, replyMessage, freshMessage } = require('./context.cjs');
const { loadBuildPrompt, readEnding } = require('./prompt.cjs');
const { buildPolicy } = require('./policy.cjs');

const LIMITS = Object.freeze({ build: 3, quick: 1 });
const TURN_MS = Object.freeze({ build: 180 * 60_000, quick: 20 * 60_000 }); // a turn past this is stopped (its work saved); Resume goes on
const SHELL_MS = 10 * 60_000;
const QUIT_WAIT_MS = 20_000;
const MAX_ATTACH = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fromEngelbart = (text) => `<from_engelbart>\n${text}\n</from_engelbart>`;
const tail = (text, n = 4000) => { const value = String(text || ''); return value.length > n ? `…${value.slice(-n)}` : value; };
/** A post-it's title: its first line with words in it, without its markdown. */
const postItTitle = (text) => (String(text || '').split('\n').map((line) => line.replace(/^(#{1,3} |- \[[ xX]?\] |[-*] |> )/, '').trim()).find(Boolean) || 'Quick task').slice(0, 80);
/** A quick task's post-it, from its record or (a record from before 2026-09-27) from its frozen context. */
const postItOf = (task, context) => {
  if (typeof task.postIt === 'string') return task.postIt;
  const found = /<post-it>\n([\s\S]*?)\n<\/post-it>/.exec(String(context || ''));
  return found ? found[1] : task.title;
};

/** A shell command in the login shell (the PATH the terminal has), in `cwd`. → { ok, output } */
function createShell({ environment = process.env, run = execFile } = {}) {
  const shell = resolveShell(environment);
  const args = (command) => (path.basename(shell) === 'fish' ? ['--login', '--interactive', '--command', command] : ['-ilc', command]);
  return (command, cwd, { env = {}, timeoutMs = SHELL_MS, signal } = {}) => new Promise((resolve) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    run(shell, args(command), { cwd, env: { ...base, CI: '1', ...env }, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: tail(`${stdout || ''}${stderr || ''}`), timedOut: !!(error && error.killed) });
    });
  });
}

function createBuilds({ git, runner, readModels, notify = () => {}, tools = null, previews = null, gitReady = () => true, runShell = createShell(), copyTree = null, limits = LIMITS, turnMs = TURN_MS, now = () => new Date() }) {
  const live = new Map(); // id → { controller, stopping: null | 'stop' | 'quit', done: Promise }
  const active = { build: 0, quick: 0 };
  const waiting = { build: [], quick: [] };
  const chains = new Map(); // repository → the promise of its last git writer
  const reconciled = new Set();
  const preparing = new Map();
  const opening = new Map();
  const discarding = new Set();
  let quitting = false;

  const emit = (task) => { try { notify('engelbart:build', store.publicTask(task)); } catch { /* a closed window */ } };
  const navChanged = () => { try { notify('engelbart:nav', {}); } catch { /* a closed window */ } };
  const say = (role, text) => store.message(role, text, now());

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

  /* ------------------------------------------------------------------ preflight */

  /** Whether the project's code folder can take a Build, and what the dialog should say. */
  async function preflight(ctx, projectId) {
    const project = projectOf(ctx, projectId);
    if (!project.directory) return { ok: false, problems: [{ code: 'no-directory', message: 'This project has no code folder.' }], dirty: 0, canInit: false };
    if (!gitReady()) return { ok: false, directory: project.directory, problems: [{ code: 'no-git', message: 'Git is not set up yet (Engelbart ▸ Set Up Tools…).' }], dirty: 0, canInit: false };
    const report = inspectRepository(project.directory);
    const blocking = report.problems.filter((problem) => problem.code !== 'not-a-repository' && problem.code !== 'no-commits');
    const canInit = report.problems.length > 0 && !blocking.length;
    let dirty = 0;
    if (report.repository && report.commits) { try { dirty = (await git.dirtyPaths(report.top)).length; } catch { dirty = 0; } }
    return { ok: !report.problems.length, directory: project.directory, top: report.top, branch: report.branch, dirty, problems: report.problems, canInit };
  }

  /** "Start history": git init and a first commit in a folder that had none (B17). */
  async function initRepository(ctx, projectId) {
    const pre = await preflight(ctx, projectId);
    if (!pre.canInit) throw new Error(pre.problems.length ? pre.problems[0].message : 'This folder already has a history.');
    await serial(pre.directory, () => git.init(pre.directory));
    return preflight(ctx, projectId);
  }

  /* ---------------------------------------------------------------------- start */

  async function start(ctx, projectId, input = {}) {
    if (quitting) throw new Error('Builds are shutting down.');
    reconcile(ctx);
    const pre = await preflight(ctx, projectId);
    if (!pre.ok) throw new Error(pre.problems[0].message);
    const project = projectOf(ctx, projectId);
    const kind = input.kind === 'quick' ? 'quick' : 'build';
    // A post-it's text: a quick task's, or a post-it added to a workspace (a Build of it whose task is the post-it).
    const postIt = kind === 'quick' || typeof input.text === 'string' ? String(input.text || '').trim() : null;
    if (postIt === '') throw new Error('The post-it is empty.');
    let workspaceId = null;
    let title;
    if (kind === 'build' || input.workspaceId) {
      const { workspace } = projects.findWorkspace(ctx, projectId, input.workspaceId);
      workspaceId = workspace.id;
      title = postIt ? postItTitle(postIt) : input.interfaceIntent?.plan?.name || workspace.name;
    } else {
      title = postItTitle(postIt);
    }
    const choice = resolveBuildChoice(readModels(), input);
    const at = await git.head(pre.top);
    if (!at.branch) throw new Error('The code folder is not on a branch.');
    const id = await store.freeId(project, (candidate) => git.branchExists(pre.top, `engelbart/${candidate}`));
    const worktree = path.join(ctx.dataRoot, 'worktrees', project.slug, id);
    const inside = path.relative(pre.top, project.directory);
    const attach = [...new Set((Array.isArray(input.attach) ? input.attach : []).filter((value) => typeof value === 'string' && UUID_RE.test(value)))].slice(0, MAX_ATTACH);
    const task = {
      id, kind, projectId, workspaceId, postItId: postIt && typeof input.postItId === 'string' ? input.postItId : null, postIt, version: null, title,
      ...choice, sessionId: null,
      repo: pre.top, worktree, cwd: inside && !inside.startsWith('..') ? path.join(worktree, inside) : worktree,
      branch: `engelbart/${id}`, baseBranch: at.branch, baseSha: at.sha,
      status: 'setting-up', question: null, error: null, queued: null, turn: 0, checkpoints: [],
      messages: [say('engelbart', `Started on ${choice.modelName} ${choice.effort} from ${at.branch} at ${at.sha.slice(0, 7)}${pre.dirty ? `; ${pre.dirty} uncommitted ${pre.dirty === 1 ? 'file' : 'files'} left out` : ''}.`)],
      attach, archive: null, checks: null, conflict: null, accepted: null, created: now().toISOString(), finished: null,
      interfaceIntent: input.interfaceIntent || null, preview: null,
    };
    const frozen = await freezeContext(ctx, projectId, { task, workspaceId, attach, postIt });
    task.archive = frozen.archive;
    // A post-it added to a workspace is put in as an archived version of it, after the one it is given as history.
    if (workspaceId && postIt && kind === 'build') task.version = await archive.importTask(ctx, projectId, workspaceId, { text: postIt, buildId: id, now });
    store.writeContext(project, id, frozen.text);
    const saved = store.writeTask(project, task, now());
    if (workspaceId) {
      projects.addWorkspaceBuild(ctx, projectId, workspaceId, id);
      if (attach.length) await projects.linkToWorkspace(ctx, projectId, workspaceId, attach); // what was attached shows on the sidebar
      if (postIt) track(() => projects.recordEdit(ctx, projectId, workspaceId)); // ⌘J's recent workspaces
    }
    emit(saved);
    beginPrepare(ctx, projectId, id);
    return store.publicTask(saved);
  }

  function beginPrepare(ctx, projectId, id) {
    if (preparing.has(id) || quitting || discarding.has(id)) return;
    const controller = new AbortController();
    const done = prepare(ctx, projectId, id, controller.signal).catch(error => {
      const task = read(ctx, projectId, id);
      if (!store.FINAL.has(task.status)) save(ctx, projectId, id, { status: quitting ? 'interrupted' : 'failed', error: error.message });
    }).finally(() => preparing.delete(id));
    preparing.set(id, { controller, done });
  }

  /** The worktree and its setup, then the first turn. A Build discarded meanwhile is cleaned up instead. */
  async function prepare(ctx, projectId, id, signal) {
    const project = projectOf(ctx, projectId);
    let task = store.readTask(project, id);
    try {
      if (!fs.existsSync(task.worktree)) await serial(task.repo, () => git.addWorktree(task.repo, task.worktree, task.branch, task.baseSha));
      signal.throwIfAborted();
      await setupWorktree(project, task, signal);
    } catch (error) {
      if (discarding.has(id) || store.FINAL.has(read(ctx, projectId, id).status)) return;
      if (signal.aborted) { save(ctx, projectId, id, { status: quitting ? 'interrupted' : 'stopped' }); return; }
      save(ctx, projectId, id, (held) => ({ status: 'failed', error: `The Build's copy could not be made: ${error.message}`, messages: [...held.messages, say('engelbart', `The Build's copy could not be made: ${error.message}`)] }));
      return;
    }
    task = store.readTask(project, id);
    if (!task || store.FINAL.has(task.status)) { if (task) await cleanUp(task); return; }
    if (discarding.has(id)) return;
    if (quitting || signal.aborted) { save(ctx, projectId, id, { status: quitting ? 'interrupted' : 'stopped' }); return; }
    await runTurn(ctx, projectId, id, { message: store.readContext(project, id) || '', fresh: true });
  }

  /** B8: ignored files a checkout lacks. `project.json → build.setup` replaces all of it when set. */
  async function setupWorktree(project, task, signal) {
    const own = readJson(path.join(project.dir, 'project.json')) || {};
    const custom = own.build && typeof own.build.setup === 'string' ? own.build.setup.trim() : null;
    const source = project.directory;
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
      const out = await runShell(custom, task.cwd, { env: { ENGELBART_SOURCE_DIR: source }, signal });
      if (!out.ok) throw new Error(`the setup command failed: ${out.output.split('\n').filter(Boolean).slice(-3).join(' ')}`);
      return;
    }
    if (custom === '') return;
    const modules = path.join(source, 'node_modules');
    const theirs = path.join(task.cwd, 'node_modules');
    if (fs.existsSync(modules) && !fs.existsSync(theirs)) await (copyTree || cloneTree)(modules, theirs, signal);
  }

  /** A copy-on-write clone (APFS): instant, and the Build's installs never reach the person's copy. */
  function cloneTree(from, to, signal) {
    return new Promise((resolve, reject) => {
      execFile('/bin/cp', ['-cR', from, to], { timeout: SHELL_MS, signal }, (error) => (error ? reject(new Error(`node_modules could not be copied (${error.message.split('\n')[0]})`)) : resolve()));
    });
  }

  /* ---------------------------------------------------------------------- turns */

  async function runTurn(ctx, projectId, id, { message, fresh = false }) {
    const project = projectOf(ctx, projectId);
    let task = store.readTask(project, id);
    if (!task || store.FINAL.has(task.status) || live.has(id) || quitting || discarding.has(id)) return;
    const pool = task.kind === 'quick' ? 'quick' : 'build';
    const controller = new AbortController();
    let settle;
    const entry = { controller, stopping: null, done: new Promise((resolve) => { settle = resolve; }) };
    live.set(id, entry);
    let free = null;
    try {
      if (active[pool] >= limits[pool]) save(ctx, projectId, id, { status: 'queued' });
      free = await slot(pool, controller.signal);
      if (!free) {
        save(ctx, projectId, id, (held) => ({ status: entry.stopping === 'quit' ? 'interrupted' : 'stopped', messages: [...held.messages, say('engelbart', 'Stopped before it started.')] }));
        return;
      }
      task = save(ctx, projectId, id, (held) => ({ status: 'running', error: null, question: null, turn: (held.turn || 0) + 1 }));
      track(() => projects.agentStarted(ctx, { id, kind: 'build', projectId, workspaceId: task.workspaceId, doc: task.workspaceId ? { kind: 'workspace', workspaceId: task.workspaceId } : null }));
      const feed = createFeed({ onProgress: (progress) => { try { notify('engelbart:build-progress', { projectId, id, ...progress }); } catch { /* closed */ } } });
      const system = loadBuildPrompt(ctx.dataRoot, { quick: task.kind === 'quick' });
      const policy = buildPolicy({ project, dataRoot: ctx.dataRoot });
      const agent = TOOL_OF[task.provider];
      const once = (session, text) => {
        feed.reset();
        const call = () => runner.turn({ task: { ...task, worktree: task.cwd }, message: text, session, system, policy, signal: controller.signal, timeoutMs: turnMs[pool], onUpdate: feed.take });
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
      if (previews && task.status === 'review' && !task.queued && !quitting) {
        try {
          const preview = await previews.review(task, { signal: controller.signal, progress: activity => notify('engelbart:build-progress', { projectId, id, activity, log: true }) });
          task = save(ctx, projectId, id, { preview });
        } catch (error) {
          task = save(ctx, projectId, id, { preview: { mode: 'review', status: 'failed', url: null, error: error.message.slice(-2000) } });
        }
      }
      track(() => projects.agentFinished(ctx, id));
    } finally {
      if (free) free();
      live.delete(id);
      settle();
    }
    if (quitting || discarding.has(id)) return;
    const after = store.readTask(project, id);
    if (!after || store.FINAL.has(after.status)) return;
    if (after.queued) {
      const text = after.queued;
      save(ctx, projectId, id, (held) => ({ queued: null, messages: [...held.messages, say('you', text)] }));
      void runTurn(ctx, projectId, id, { message: replyMessage(text) });
      return;
    }
    // A quick task that finished cleanly lands by itself (B23); anything else waits for the person.
    if (after.kind === 'quick' && after.status === 'review') void accept(ctx, projectId, id, { auto: true }).catch(() => {});
  }

  /**
   * The person's reply: the next turn now, or after the one running. With `interrupt` (the card's send, 2026-09-27: no
   * Stop & send to press) a turn that is running is cut short, its work saved, and the reply goes on in the same session.
   */
  async function reply(ctx, projectId, id, text, { interrupt = false } = {}) {
    if (quitting || discarding.has(id)) throw new Error('This Build is stopping.');
    reconcile(ctx);
    const said = String(text || '').trim();
    const task = read(ctx, projectId, id);
    if (!said) return store.publicTask(task);
    if (store.FINAL.has(task.status)) throw new Error('This Build is closed.');
    if (task.status === 'accepting') throw new Error('It is being accepted; reply once that is done.');
    if (live.has(id) || task.status === 'setting-up') {
      const next = save(ctx, projectId, id, (held) => ({ queued: held.queued ? `${held.queued}\n\n${said}` : said }));
      if (interrupt && task.status === 'running') stop(projectId, id, 'reply');
      return store.publicTask(next);
    }
    if (!fs.existsSync(task.worktree)) throw new Error('This Build\'s copy is gone; discard it.');
    const next = save(ctx, projectId, id, (held) => ({ queued: null, error: null, messages: [...held.messages, say('you', said)] }));
    void runTurn(ctx, projectId, id, { message: replyMessage(said) });
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
    if (quitting || discarding.has(id)) throw new Error('This Build is stopping.');
    reconcile(ctx);
    const task = read(ctx, projectId, id);
    if (store.FINAL.has(task.status) || live.has(id) || preparing.has(id)) return store.publicTask(task);
    if (!fs.existsSync(task.worktree) || task.turn === 0) {
      save(ctx, projectId, id, { status: 'setting-up', error: null });
      beginPrepare(ctx, projectId, id);
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
    if (!live.has(id) && task.status !== 'accepting') {
      try { await git.concludeMerge(task.worktree, `Build ${task.title}: before review`, await git.identity(task.repo)); } catch { /* shown as it stands */ }
    }
    const d = await git.diff(task.worktree, task.baseSha, 'HEAD');
    return { ...d, from: task.baseBranch, base: task.baseSha, running: live.has(id) };
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

  async function accept(ctx, projectId, id, { auto = false } = {}) {
    if (quitting || discarding.has(id)) throw new Error('This Build is stopping.');
    reconcile(ctx);
    const project = projectOf(ctx, projectId);
    const task = read(ctx, projectId, id);
    if (store.FINAL.has(task.status)) return store.publicTask(task);
    if (live.has(id) || opening.has(id) || task.status === 'setting-up' || task.status === 'accepting') throw new Error('It is still working.');
    if (!fs.existsSync(task.worktree)) throw new Error('This Build\'s copy is gone; discard it.');
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
        // Git has landed. A preview/cleanup error must not turn this into a
        // misleading "Not accepted" (or permit a second Accept of the same code).
        let preview = null, cleanupError = null;
        try {
          preview = previews ? await previews.accept(task) : null;
          await removeCopy(task); // already inside this repository's serial turn
        } catch (error) { cleanupError = `Accepted, but temporary-copy cleanup needs attention: ${error.message}`; }
        const done = save(ctx, projectId, id, (held) => ({
          status: 'accepted', finished: now().toISOString(), checks, queued: null,
          preview, error: cleanupError,
          accepted: sha ? { sha, branch: target.branch, at: now().toISOString() } : null,
          messages: [...held.messages, say('engelbart', sha ? `Accepted onto ${target.branch} as ${sha.slice(0, 7)}${auto ? ' (a quick task that finished cleanly lands by itself)' : ''}.` : 'Nothing had changed, so there was nothing to accept.')],
        }));
        track(() => projects.agentStopped(ctx, id));
        return store.publicTask(done);
      });
    } catch (error) {
      const conflict = error && error.code === 'conflict';
      const next = save(ctx, projectId, id, (held) => ({
        status: conflict ? 'conflict' : ['accepting', 'conflict'].includes(before) ? 'review' : before,
        error: error.message,
        conflict: conflict ? { files: error.files || [], markers: !!error.markers } : null,
        checks: error.checks || held.checks || null,
        messages: [...held.messages, say('engelbart', `Not accepted: ${error.message}`)],
      }));
      if (auto) return store.publicTask(next);
      throw error;
    }
  }

  /**
   * "Send to agent" after a refused Accept: for a conflict Engelbart merges the person's branch into the Build's (the
   * markers left in the files), for failed checks it passes their output; either way the same session takes it up.
   */
  async function fix(ctx, projectId, id) {
    reconcile(ctx);
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
        return store.publicTask(save(ctx, projectId, id, (held) => ({ status: 'review', conflict: null, error: null, messages: [...held.messages, say('engelbart', `${target.branch || 'Your branch'} merged in without conflicts. Accept again.`)] })));
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
    const next = save(ctx, projectId, id, (held) => ({ conflict: null, error: null, messages: [...held.messages, say('engelbart', summary)] }));
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
    if (task.status === 'accepting') throw new Error('It is being accepted.');
    if (discarding.has(id)) throw new Error('It is already being discarded.');
    discarding.add(id); // prevents a queued reply or quick-task auto-Accept from racing cleanup
    try {
      const entry = live.get(id), setup = preparing.get(id), launch = opening.get(id);
      setup?.controller.abort(); launch?.controller.abort();
      if (entry) stop(projectId, id);
      await Promise.all([entry?.done, setup?.done, launch?.done.catch(() => {})]);
      const preview = previews ? await previews.discard(task) : null;
      const next = save(ctx, projectId, id, (held) => ({ status: 'discarded', preview, queued: null, finished: now().toISOString(), messages: [...held.messages, say('engelbart', 'Discarded.')] }));
      track(() => projects.agentStopped(ctx, id));
      try { await cleanUp(task); }
      catch (error) { return store.publicTask(save(ctx, projectId, id, { error: `Discarded, but temporary-copy cleanup needs attention: ${error.message}` })); }
      return store.publicTask(next);
    } finally { discarding.delete(id); }
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
    for (const project of projects.projectRecords(ctx)) {
      for (const task of store.listTasks(project)) {
        if (task.preview?.url) { task.preview = { ...task.preview, status: 'stopped', url: null }; store.writeTask(project, task, now()); }
        if (store.FINAL.has(task.status) || live.has(task.id)) continue;
        const gone = task.status !== 'setting-up' && !fs.existsSync(task.worktree);
        if (gone) store.writeTask(project, { ...task, status: 'failed', error: 'This Build\'s copy is gone.', messages: [...task.messages, say('engelbart', 'This Build\'s copy is gone; discard it.')] }, now());
        else if (store.WORKING.has(task.status)) store.writeTask(project, { ...task, status: 'interrupted', messages: [...task.messages, say('engelbart', 'Engelbart closed while this was working.')] }, now());
      }
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

  /** Quit: stop launches/setup too, checkpoint turns, then close previews. Never close storage with a writer still live. */
  async function stopAll() {
    quitting = true;
    const running = [...live.values()];
    for (const entry of running) { entry.stopping = 'quit'; entry.controller.abort(); }
    const pending = [...preparing.values(), ...opening.values()];
    for (const entry of pending) entry.controller.abort();
    let timer;
    try {
      await Promise.race([
        Promise.all([...running, ...pending].map(entry => entry.done.catch(() => {}))),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Builds are still stopping. Try quitting again once their processes finish.')), QUIT_WAIT_MS); timer.unref?.(); }),
      ]);
    } finally { clearTimeout(timer); }
    await Promise.all([...chains.values()]);
    if (previews) await previews.close();
    quitting = false; // also used when switching the isolated test-data context
  }

  async function preview(ctx, projectId, id) {
    if (!previews) throw new Error('Build previews are unavailable.');
    if (quitting || discarding.has(id)) throw new Error('This Build is stopping.');
    const task = read(ctx, projectId, id);
    if (live.has(id) || preparing.has(id) || opening.has(id) || task.status === 'accepting') throw new Error('The Build is still working.');
    const controller = new AbortController();
    const done = previews.open(task, { signal: controller.signal }).then(value => {
      controller.signal.throwIfAborted();
      return store.publicTask(save(ctx, projectId, id, { preview: value }));
    }).finally(() => opening.delete(id));
    opening.set(id, { controller, done });
    return done;
  }

  return { preflight, initRepository, start, reply, stop, resume, review, preview, accept, fix, discard, promote, reconcile, list, get, openIds, stopAll, running: () => [...live.keys()] };
}

module.exports = { createBuilds, createShell, LIMITS, TURN_MS };
