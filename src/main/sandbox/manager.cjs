'use strict';

const { githubRepo, runStore, KINDS } = require('./runs.cjs');
const { repoPath, HINT_LIMIT } = require('./local-tools.cjs');
const { readSandboxEnv } = require('./config.cjs');
const { launchWorker } = require('./transport.cjs');
const { safePreview, MISSING_KEY } = require('./worker.cjs');
const { environmentStore, redact, redactEvent } = require('./environment.cjs');
const { EXPIRE_MS, EXPIRED, expiredRun } = require('../../shared/sandbox-sleep.cjs');
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// A ready preview sleeps after 10 minutes without a ping from the Stage (touch; worker.cjs's IDLE). Pings closer together
// than TOUCH_EVERY change nothing.
const IDLE_MS = 10 * 60_000;
const TOUCH_EVERY = 30_000;
const ASLEEP = 'Paused after 10 minutes unused';
const TERMINAL_READY = 'Terminal ready';
const QUIT_ASLEEP = 'Paused when Engelbart quit';
const EXPIRED_MESSAGE = 'Stopped after 7 days unopened';
const notFound = (error) => error?.name === 'NotFoundError' || error?.name === 'SandboxNotFoundError' || error?.status === 404;

// `e2bKey`: the E2B API key for whoever is signed in to GitHub (src/main/github/e2b-key.cjs), and the only one a worker
// gets: an E2B_API_KEY in .env.local, ~/.engelbart/sandbox.env or the environment (readEnv) is dropped. `githubLogin`
// names that account in each new sandbox's metadata. `repoAccess` (src/main/github/repo-access.cjs) reads the repository
// with the GitHub sign-in: whether it is private and wants Docker before the sandbox is made, and for a private one a
// download link for its code, made when the sandbox is ready to use it and handed over with the worker's ack. The
// sign-in itself never reaches the worker or the sandbox.
// `claudeReady` throws, saying what to do, while Claude Code is not installed or not signed in to a subscription
// (local-claude.cjs's prepareLocalClaude). Every new run's setup is Claude Code's (there is no API-key fallback since
// 2026-10-03), so on a new Mac, where onboarding saves a repository before Claude Code is installed and signed in, the
// run waits for it as it waits for the E2B key.
// `Sandbox`: E2B's, for touch's one call from this process (every other E2B call is a worker's, or a sandbox
// terminal's: pty.cjs).
// `terminals` (terminals.cjs): the shells open in ready sandboxes, { open(spec) → session, close(libraryId),
// closeAll() }. A run's go when its sandbox is stopped, replaced or released.
function createSandboxManager({ notify, launch = launchWorker, readEnv = readSandboxEnv, secure, e2bKey = async () => null, githubLogin = () => '', repoAccess = null, claudeReady = async () => {}, Sandbox = null, terminals = null, now = Date.now }) {
  const workers = new Map();
  const contexts = new Map();
  const locks = new Map();
  const messages = new Map();
  const prepared = new Set();
  const touched = new Map();
  let closing = false;
  let polling = false;
  let pollDone = Promise.resolve();

  function exclusive(key, action) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  }
  // A worker's environment: the rest of readEnv, and the signed-in key. Throws when there is none to give.
  async function environmentFor(ctx) {
    const env = { ...readEnv(ctx.root) };
    delete env.E2B_API_KEY;
    let key;
    try { key = await e2bKey(); }
    catch (error) { throw new Error(`Could not get the E2B key for your GitHub sign-in: ${error.message}`); }
    if (!key) throw new Error(MISSING_KEY);
    return { ...env, E2B_API_KEY: key };
  }
  // A run whose sandbox is being stopped, replaced or forgotten: its terminals close with it (the sandbox itself is
  // the caller's). Never fails the caller.
  async function closeTerminals(libraryId) {
    try { await terminals?.close(libraryId); } catch { /* the session is gone already */ }
  }
  // A terminal has no app to watch and no preview to check: its sandbox is healthy unless it is gone.
  const terminalOnly = (run) => run.status === 'ready' && run.kind === 'terminal';
  const keeps = (run, state) => ['ready', 'paused'].includes(state) || (terminalOnly(run) && state !== 'gone');
  function publish(ctx, run, extra = {}) {
    if (!run) return;
    if (extra.message) messages.set(run.id, extra.message);
    notify({ dataRoot: ctx.dataRoot, run, message: messages.get(run.id) || '', ...extra });
  }
  async function control(ctx, command, run) {
    let result;
    const worker = launch({ command, run_id: run.id, sandbox_id: run.sandbox_id, preview_url: run.preview_url, port: run.port, ...(run.kind ? { kind: run.kind } : {}) }, await environmentFor(ctx), async (event) => {
      if (event.event === 'failed') throw new Error(event.error || 'Sandbox check failed');
      if (event.event === 'result') result = event;
    });
    await worker.done;
    if (!result) throw new Error('Sandbox worker returned no result');
    return result;
  }
  // `extra`: what is published with it; its `message` is also recorded, with `data` when there is some.
  async function update(ctx, run, fields, extra) {
    const { data, ...rest } = extra || {};
    let next = await runStore(ctx.libraryDb).update(run.id, fields);
    if (next && rest.message) next = await runStore(ctx.libraryDb).record(next.id, rest.message, data ? { data } : {});
    if (next) publish(ctx, next, rest);
    return next || run;
  }
  async function end(ctx, run, status, error = null) {
    await closeTerminals(run.library_id);
    return update(ctx, run, { status, error, finished_at: new Date().toISOString() }, { message: error || 'Sandbox stopped' });
  }
  // `result`: the probe pollOnce already made, if it did.
  async function reconcile(ctx, run, result = null) {
    if (workers.has(run.id)) return run;
    if (!result) result = await control(ctx, 'probe', run);
    const { state } = result;
    if (!run.sandbox_id && result.sandbox_id) run = await update(ctx, run, { sandbox_id: result.sandbox_id });
    // Asleep is as good as live: the next request to its preview (or its terminal) wakes it.
    if (run.status === 'ready' && keeps(run, state)) return run;
    if (state === 'unreachable') throw new Error('The preview is temporarily unreachable. Retry the check or stop the run before starting another.');
    if (state !== 'gone') await control(ctx, 'kill', run);
    return end(ctx, run, run.status === 'starting' ? 'failed' : 'stopped', run.status === 'starting' ? 'Setup was interrupted. Retry to start a new run.' : null);
  }
  async function receive(ctx, runId, event) {
    const store = runStore(ctx.libraryDb);
    const run = await store.get(runId);
    if (!run || !['starting', 'ready'].includes(run.status)) return;
    if (event.event === 'progress') {
      const message = String(event.message || '').slice(-2000);
      const details = {};
      if (['status', 'command', 'stdout', 'stderr', 'error'].includes(event.kind)) details.kind = event.kind;
      if (event.data && typeof event.data === 'object' && !Array.isArray(event.data)) details.data = event.data;
      // Claude said how the repository is used (local-setup.cjs): kept on the run, for its build details, as it is said.
      if (details.data?.phase === 'kind' && KINDS.includes(details.data.kind) && run.status === 'starting') {
        await store.update(run.id, { kind: details.data.kind, kind_reason: String(details.data.reason || '').slice(0, 500) || null });
      }
      publish(ctx, await store.record(run.id, message, details), { message });
    } else if (event.event === 'sandbox_created') {
      if (typeof event.sandbox_id !== 'string' || !/^[\w-]{1,200}$/.test(event.sandbox_id)) throw new Error('Invalid sandbox identifier');
      await update(ctx, run, { sandbox_id: event.sandbox_id }, { message: 'Sandbox created' });
    } else if (event.event === 'ready') {
      // { kind, preview_url?, port?, terminal?: { cwd, hint } }. A restart's says nothing of its kind: the run keeps its own.
      const kind = event.kind === undefined ? run.kind || 'interface' : event.kind;
      if (!run.sandbox_id || !KINDS.includes(kind)) throw new Error('Invalid ready event');
      const preview = kind !== 'terminal';
      if (preview && (!Number.isInteger(event.port) || event.port < 1 || event.port > 65535)) throw new Error('Invalid ready event');
      const terminal = kind === 'interface' ? null : event.terminal === undefined && event.kind === undefined ? run.terminal : readyTerminal(event.terminal);
      if (kind !== 'interface' && !terminal) throw new Error('Invalid ready event');
      // Completion is an inbox notification, never a navigation request. Ignore
      // duplicates so the persisted completion time/read state stays stable.
      if (run.status === 'ready') return;
      await update(ctx, run, { status: 'ready', kind, terminal, preview_url: preview ? safePreview(event.preview_url) : null, port: preview ? event.port : null },
        preview ? { message: 'Preview ready', notification: 'preview-ready' } : { message: TERMINAL_READY, data: { phase: 'ready', kind }, notification: 'preview-ready' });
    } else if (event.event === 'paused') {
      // Asleep, not stopped: the run stays ready, and its worker leaves (worker.cjs's asleep).
      if (run.status !== 'ready') return;
      publish(ctx, await store.record(run.id, ASLEEP, { data: { lifecycle: 'paused' } }), { message: ASLEEP });
    } else if (event.event === 'failed' || event.event === 'stopped') {
      await end(ctx, run, event.event, event.event === 'failed' ? String(event.error || 'Setup failed').slice(0, 4000) : null);
    } else throw new Error('Unknown sandbox event');
  }
  // `env` was resolved by the caller before anything was recorded or interrupted (environmentFor).
  function attach(ctx, run, repo, environment, restart, env, access = null) {
    let worker;
    const held = { ctx, libraryId: run.library_id, detaching: false };
    const login = String(githubLogin() || '');
    const request = {
      command: restart ? 'restart' : 'start', run_id: run.id, github_url: repo.url, sandbox_id: run.sandbox_id, port: run.port, environment,
      ...(GITHUB_LOGIN.test(login) ? { github_login: login } : {}),
      ...(access && typeof access.docker === 'boolean' ? { docker: access.docker } : {}),
    };
    // The ack after sandbox_created is the worker's go-ahead to fetch the code: a private repository's download link
    // goes with it, made now because it lasts minutes.
    const onEvent = async (event) => {
      if (held.detaching) return undefined;
      if (event.event === 'paused') held.asleep = true; // its exit, next, is not a failure
      await receive(ctx, run.id, redactEvent(event, Object.values(environment.values)));
      if (event.event !== 'sandbox_created' || !access || !access.private || held.detaching) return undefined;
      return { archive_url: await repoAccess.archive(repo), ...(access.branch ? { branch: access.branch } : {}) };
    };
    try {
      worker = launch(request, env, onEvent);
    } catch (error) { return end(ctx, run, 'failed', error.message); }
    held.worker = worker;
    workers.set(run.id, held);
    const finish = async (error) => {
      if (held.detaching || held.asleep) return;
      const current = await runStore(ctx.libraryDb).get(run.id);
      // A ready terminal's worker leaves once it is ready (worker.cjs): its sandbox stays, asleep when unused.
      if (current && terminalOnly(current) && !error) return;
      if (current && ['starting', 'ready'].includes(current.status)) {
        let cleanup = '';
        if (current.sandbox_id && !restart) {
          try { await control(ctx, 'kill', current); } catch (failure) { cleanup = ` Sandbox cleanup failed: ${failure.message}`; }
        }
        await end(ctx, current, 'failed', redact(`${error?.message || 'Worker exited before reporting completion'}${cleanup}`, Object.values(environment.values)));
      }
    };
    const finished = worker.done.then(() => finish(), finish).catch((error) => {
      publish(ctx, run, { message: `Could not save worker result: ${error.message}` });
    }).finally(() => workers.delete(run.id));
    workers.get(run.id).finished = finished;
    return Promise.resolve(run);
  }
  // `waitForClaude`: a start that comes from saving a repository or linking it to a workspace (ipc.cjs), not from asking
  // for the preview: until Claude Code is signed in it waits as automatic preparation does, instead of failing the save
  // with the sign-in message (onboarding saves repositories before its sign-in, 2026-10-02).
  async function start(ctx, libraryId, { automatic = false, waitForClaude = false } = {}) {
    contexts.set(ctx.dataRoot, ctx);
    const key = `${ctx.dataRoot}:${libraryId}`;
    return exclusive(key, async () => {
      if (closing) throw new Error('Sandbox workers are shutting down');
      const row = await ctx.libraryDb.get(libraryId);
      const repo = githubRepo(row?.url);
      if (!repo) return null;
      const store = runStore(ctx.libraryDb);
      // Prepare once per app session. Refreshes must not undo Stop or loop on failures.
      if (automatic && prepared.has(key)) return (await store.latest()).find((item) => item.library_id === libraryId) || null;
      // A preview the sweep ended (pollOnce) is built again when it is opened, not by a new session's preparation.
      if (automatic) {
        const latest = (await store.latest()).find((item) => item.library_id === libraryId);
        if (expiredRun(latest)) return latest;
      }
      // The key comes first: without one (signed out of GitHub, mathetic.com unreachable) nothing is recorded.
      // Automatic preparation waits quietly and runs once there is one; an explicit start says why it cannot.
      let env;
      try { env = await environmentFor(ctx); }
      catch (error) {
        if (automatic) return (await store.latest()).find((item) => item.library_id === libraryId) || null;
        throw error;
      }
      prepared.add(key);
      let run = await store.active(libraryId);
      if (run) {
        // A local worker proves setup is active. Ready runs still need a live preview check.
        if (run.status === 'ready') {
          const { state } = await control(ctx, 'probe', run);
          if (state === 'paused') { publish(ctx, run, { message: `Paused; opening the ${run.kind === 'terminal' ? 'terminal' : 'preview'} wakes it` }); return run; }
          if (keeps(run, state)) { publish(ctx, run, { message: terminalOnly(run) ? TERMINAL_READY : 'Preview ready' }); return run; }
          if (state === 'unreachable') throw new Error('The preview is temporarily unreachable. Stop the run or retry the check.');
          await stopRun(ctx, run.id);
        } else if (workers.has(run.id)) { publish(ctx, run); return run; }
        else run = await reconcile(ctx, run);
      }
      // Setup is the local Claude subscription's (worker.cjs), so it is signed in first. Automatic preparation waits
      // quietly, and runs once it is (the renderer prepares again when Claude Code's sign-in changes), as does a save's;
      // Start says why it cannot.
      try { await claudeReady(); }
      catch (error) {
        if (!automatic && !waitForClaude) throw error;
        prepared.delete(key);
        return (await store.latest()).find((item) => item.library_id === libraryId) || null;
      }
      // Cleanup may have failed on a previous attempt; retain and use that handle.
      const previous = (await store.latest()).find((item) => item.library_id === libraryId);
      const environment = await environmentStore(ctx.libraryDb, secure).read(libraryId);
      await closeTerminals(libraryId);
      if (previous?.sandbox_id && ['failed', 'stopped'].includes(previous.status)) await control(ctx, 'kill', previous);
      run = await store.create(libraryId);
      if (!run) return store.active(libraryId);
      run = await store.update(run.id, { env_revision: environment.revision });
      run = await store.record(run.id, 'Starting repository setup');
      publish(ctx, run, { message: 'Starting repository setup' });
      let access = null;
      if (repoAccess) {
        try { access = await repoAccess.describe(repo); }
        catch (error) { return end(ctx, run, 'failed', error.message); }
      }
      return attach(ctx, run, repo, environment, false, env, access);
    });
  }
  const envStore = (ctx) => environmentStore(ctx.libraryDb, secure);
  async function environment(ctx, libraryId) { return envStore(ctx).describe(libraryId); }
  async function saveEnvironment(ctx, libraryId, changes, revision) {
    return exclusive(`${ctx.dataRoot}:${libraryId}`, async () => {
      if (closing) throw new Error('Sandbox workers are shutting down');
      return envStore(ctx).save(libraryId, changes, revision);
    });
  }
  async function restart(ctx, libraryId) {
    contexts.set(ctx.dataRoot, ctx);
    return exclusive(`${ctx.dataRoot}:${libraryId}`, async () => {
      if (closing) throw new Error('Sandbox workers are shutting down');
      const repo = githubRepo((await ctx.libraryDb.get(libraryId))?.url);
      const values = await envStore(ctx).read(libraryId);
      const store = runStore(ctx.libraryDb);
      let run = (await store.latest()).find((row) => row.library_id === libraryId);
      if (!run?.sandbox_id || !['ready', 'failed'].includes(run.status)) throw new Error('Wait for a ready preview before restarting the application. Saved values will be used by the next build.');
      // A terminal has no app to restart: its shell is. The open one closes, and the next one opened has the saved values.
      if (terminalOnly(run)) {
        await closeTerminals(libraryId);
        const message = 'Saved environment applies to the next terminal opened';
        return update(ctx, run, { env_revision: values.revision }, { message });
      }
      // The key, then confirmation that the same machine can relaunch, before interrupting anything.
      const env = await environmentFor(ctx);
      await control(ctx, 'can_restart', run);
      const held = workers.get(run.id);
      if (held) {
        held.detaching = true;
        try { await held.worker.detach(); await held.finished; }
        catch { held.detaching = false; throw new Error('Could not release the current worker. The sandbox has not been rebuilt.'); }
      }
      run = await store.reopen(run.id, values.revision);
      run = await store.record(run.id, 'Restarting app with saved environment (same sandbox)', { data: { phase: 'setup', status: 'reusing', lifecycle: 'restart' } });
      publish(ctx, run, { message: 'Restarting app with saved environment (same sandbox)' });
      return attach(ctx, run, repo, values, true, env);
    });
  }
  async function stopRun(ctx, id) {
    const run = await runStore(ctx.libraryDb).get(id);
    if (!run) throw new Error('Unknown sandbox run');
    await closeTerminals(run.library_id);
    const held = workers.get(id);
    if (held) {
      await held.worker.stop().catch(() => {});
      await held.finished;
    }
    const latest = await runStore(ctx.libraryDb).get(id);
    // Retry cleanup even for a failed run whose sandbox may still exist.
    if (latest.sandbox_id) await control(ctx, 'kill', latest);
    if (['starting', 'ready'].includes(latest.status)) return end(ctx, latest, 'stopped');
    if (latest.status === 'failed') {
      const stopped = await runStore(ctx.libraryDb).stoppedAfterFailure(latest.id);
      publish(ctx, stopped, { message: 'Sandbox stopped' });
      return stopped;
    }
    return latest;
  }
  async function list(ctx) {
    contexts.set(ctx.dataRoot, ctx);
    const runs = await runStore(ctx.libraryDb).latest();
    for (const run of runs) publish(ctx, run);
    return runs.map((run) => ({ run, message: messages.get(run.id) || run.build_log?.at(-1)?.message || '' }));
  }
  // The preview in front of a focused window (the Stage's ping, about once a minute): its sandbox's sleep goes back to
  // 10 minutes away, by one call from here rather than a worker, and the run is marked opened for the sweep. Pings closer
  // than 30 seconds apart change nothing. Asleep or gone, E2B says it was not found, and the next poll tells which; a ping
  // never wakes it.
  async function touch(ctx, libraryId) {
    const run = await runStore(ctx.libraryDb).active(libraryId);
    if (run?.status !== 'ready' || !run.sandbox_id) return;
    const at = now();
    if (at - (touched.get(run.id) || 0) < TOUCH_EVERY) return;
    touched.set(run.id, at);
    await runStore(ctx.libraryDb).update(run.id, { last_opened_at: new Date(at).toISOString() });
    let env;
    try { env = await environmentFor(ctx); } catch { return; } // signed out: it sleeps at its time
    try { await (Sandbox || require('e2b').Sandbox).setTimeout(run.sandbox_id, IDLE_MS, { apiKey: env.E2B_API_KEY, requestTimeoutMs: 10_000 }); }
    catch (error) { if (!notFound(error)) throw error; }
  }
  // The sweep (pollOnce): a ready preview asleep and not opened for 7 days ends, marked so that opening it builds it again.
  const unopened = (run) => now() - Date.parse(run.last_opened_at || run.created_at) > EXPIRE_MS;
  async function expire(ctx, run) {
    await closeTerminals(run.library_id);
    await control(ctx, 'kill', run);
    const stopped = await runStore(ctx.libraryDb).update(run.id, { status: 'stopped', finished_at: new Date(now()).toISOString() });
    if (!stopped) return;
    publish(ctx, await runStore(ctx.libraryDb).record(stopped.id, EXPIRED_MESSAGE, { data: { lifecycle: EXPIRED } }), { message: EXPIRED_MESSAGE });
  }
  async function pollOnce() {
    if (closing || polling) return;
    polling = true;
    try {
      for (const ctx of contexts.values()) {
        let keyed = null;
        for (const run of await runStore(ctx.libraryDb).latest()) {
          if (closing) return;
          if (!['starting', 'ready'].includes(run.status)) continue;
          // Every check needs the key: signed out, they wait instead of repeating the sign-in message every 15 seconds.
          if (keyed === null) keyed = await environmentFor(ctx).then(() => true, () => false);
          if (!keyed) break;
          await exclusive(`${ctx.dataRoot}:${run.library_id}`, async () => {
            const current = await runStore(ctx.libraryDb).get(run.id);
            if (!['starting', 'ready'].includes(current.status)) return;
            try {
              if (workers.has(current.id)) {
                // Setup still running, or a ready app its worker watches. Asleep ('paused'), that worker is on its way out.
                if (current.status !== 'ready') return;
                const result = await control(ctx, 'probe', current);
                if (result.state === 'gone' || (result.state === 'inactive' && !terminalOnly(current))) await stopRun(ctx, current.id);
                else if (result.state === 'unreachable') publish(ctx, current, { message: 'Preview currently unreachable; checking again shortly' });
              } else {
                const result = await control(ctx, 'probe', current);
                if (result.state === 'paused' && current.status === 'ready' && unopened(current)) await expire(ctx, current);
                else await reconcile(ctx, current, result);
              }
            } catch (error) { publish(ctx, current, { message: error.message }); }
          });
        }
      }
    } finally { polling = false; }
  }
  function poll() { if (polling) return pollDone; pollDone = pollOnce(); return pollDone; }
  const timer = setInterval(() => poll().catch(() => {}), 15_000);
  timer.unref?.();
  async function close() {
    closing = true;
    try {
      await pollDone;
      await Promise.allSettled([...locks.values()]);
      // Shells first, while their sandboxes are still awake: ending one later would wake a sandbox put to sleep below.
      try { await terminals?.closeAll(); } catch { /* sessions are going with the app */ }
      // A terminal event reaches the UI before its worker finishes exiting/cleanup.
      // Drain those workers too, before the caller closes or replaces the database.
      // A ready preview's worker lets go of it instead of stopping it: it goes to sleep below.
      for (const [id, held] of [...workers.entries()]) {
        const run = await runStore(held.ctx.libraryDb).get(id);
        if (run?.status === 'ready' && run.sandbox_id) {
          held.detaching = true;
          await held.worker.detach().catch(() => {}); // fails only when it is already leaving
        } else await held.worker.stop().catch(() => {});
        await held.finished;
      }
      for (const ctx of contexts.values()) {
        for (const run of await runStore(ctx.libraryDb).latest()) {
          if (run.status === 'ready' && run.sandbox_id) await sleep(ctx, run);
          else if (['starting', 'ready'].includes(run.status)) await stopRun(ctx, run.id);
        }
      }
      contexts.clear(); messages.clear(); prepared.clear(); touched.clear();
    } finally { closing = false; }
  }
  // Quitting puts a ready preview to sleep, to wake when it is next opened. One that cannot be put to sleep now (offline,
  // signed out) sleeps by itself within 10 minutes of its last ping.
  async function sleep(ctx, run) {
    let result;
    try { result = await control(ctx, 'pause', run); } catch { return; }
    if (result.paused) publish(ctx, await runStore(ctx.libraryDb).record(run.id, QUIT_ASLEEP, { data: { lifecycle: 'paused' } }), { message: QUIT_ASLEEP });
  }
  const stop = async (ctx, id) => {
    const run = await runStore(ctx.libraryDb).get(id);
    if (!run) throw new Error('Unknown sandbox run');
    return exclusive(`${ctx.dataRoot}:${run.library_id}`, () => stopRun(ctx, id));
  };
  // Before a library item itself is deleted (onboarding's untick): its sandbox is stopped and confirmed gone first,
  // then its run history goes with it. A cleanup that cannot be confirmed keeps both, and the item.
  async function release(ctx, libraryId) {
    return exclusive(`${ctx.dataRoot}:${libraryId}`, async () => {
      if (closing) throw new Error('Sandbox workers are shutting down');
      const runs = await ctx.libraryDb.query('select * from sandbox_runs where library_id = $1 order by created_at, id', [libraryId]);
      for (const run of runs) {
        if (['starting', 'ready'].includes(run.status) || (run.status === 'failed' && run.sandbox_id)) await stopRun(ctx, run.id);
      }
      await ctx.libraryDb.query('delete from sandbox_runs where library_id = $1', [libraryId]);
      for (const run of runs) messages.delete(run.id);
      prepared.delete(`${ctx.dataRoot}:${libraryId}`);
    });
  }
  // Signed out of GitHub: each live run is stopped by its own worker, which still holds the key it started with (the
  // manager has none now). A run without a live worker is asleep, or will be at its timeout, and waits there at no
  // charge for the next sign-in's Stop or sweep.
  async function signedOut() {
    await Promise.allSettled([...workers.entries()].map(([id, held]) => exclusive(`${held.ctx.dataRoot}:${held.libraryId}`, async () => {
      if (workers.get(id) !== held || held.detaching) return;
      const run = await runStore(held.ctx.libraryDb).get(id);
      if (run && ['starting', 'ready'].includes(run.status)) {
        publish(held.ctx, await runStore(held.ctx.libraryDb).record(id, 'Stopping: signed out of GitHub'), { message: 'Stopping: signed out of GitHub' });
      }
      await held.worker.stop().catch(() => {});
      await held.finished;
    })));
  }
  // A shell in a ready run's sandbox (`sandboxTerminal`, ipc.cjs): the one already open for it, woken if it slept, else
  // a new one in the directory Claude chose, with the repository's saved environment values (never on a command line).
  // Opening it counts as opening the run, for the 7-day sweep. → the session's snapshot (terminals.cjs)
  async function terminal(ctx, libraryId) {
    if (!terminals) throw new Error('Sandbox terminals are unavailable');
    contexts.set(ctx.dataRoot, ctx);
    return exclusive(`${ctx.dataRoot}:${libraryId}`, async () => {
      if (closing) throw new Error('Sandbox workers are shutting down');
      const repo = githubRepo((await ctx.libraryDb.get(libraryId))?.url);
      if (!repo) throw new Error('Choose a saved GitHub repository.');
      const run = await runStore(ctx.libraryDb).active(libraryId);
      if (run?.status !== 'ready' || !run.sandbox_id || !['terminal', 'both'].includes(run.kind) || !run.terminal) throw new Error('This repository has no sandbox terminal yet.');
      await environmentFor(ctx); // signed out: say so now, not when the shell connects
      const environment = await envStore(ctx).read(libraryId);
      await runStore(ctx.libraryDb).update(run.id, { last_opened_at: new Date(now()).toISOString() });
      return terminals.open({
        libraryId, sandboxId: run.sandbox_id, title: `${repo.owner}/${repo.name} (sandbox)`,
        cwd: repoPath(run.terminal.cwd || '.'), envs: environment.values, hint: run.terminal.hint || '',
        apiKey: async () => (await environmentFor(ctx)).E2B_API_KEY,
      });
    });
  }
  return { start, list, stop, touch, terminal, environment, saveEnvironment, restart, release, signedOut, close, poll, dispose: async () => { clearInterval(timer); await close(); } };
}

// A ready event's terminal ({ cwd, hint }, local-tools.cjs's terminal_ready), checked again here: a path inside the
// repository and one line of plain text. Null when it is not one.
function readyTerminal(value) {
  if (!value || typeof value !== 'object' || typeof value.cwd !== 'string' || typeof value.hint !== 'string') return null;
  if (value.hint.length > HINT_LIMIT || /[\u0000-\u001f\u007f-\u009f]/.test(value.hint)) return null;
  try { repoPath(value.cwd); } catch { return null; }
  return { cwd: value.cwd, hint: value.hint };
}

module.exports = { createSandboxManager };
