'use strict';

const { githubRepo, runStore } = require('./runs.cjs');
const { readSandboxEnv } = require('./config.cjs');
const { launchWorker } = require('./transport.cjs');
const { safePreview } = require('./worker.cjs');
const { environmentStore, redact, redactEvent } = require('./environment.cjs');

function createSandboxManager({ notify, launch = launchWorker, readEnv = readSandboxEnv, secure }) {
  const workers = new Map();
  const contexts = new Map();
  const locks = new Map();
  const messages = new Map();
  const prepared = new Set();
  let closing = false;
  let polling = false;
  let pollDone = Promise.resolve();

  function exclusive(key, action) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    locks.set(key, next);
    return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
  }
  function publish(ctx, run, extra = {}) {
    if (!run) return;
    if (extra.message) messages.set(run.id, extra.message);
    notify({ dataRoot: ctx.dataRoot, run, message: messages.get(run.id) || '', ...extra });
  }
  async function control(ctx, command, run) {
    let result;
    const worker = launch({ command, run_id: run.id, sandbox_id: run.sandbox_id, preview_url: run.preview_url, port: run.port }, readEnv(ctx.root), async (event) => {
      if (event.event === 'failed') throw new Error(event.error || 'Sandbox check failed');
      if (event.event === 'result') result = event;
    });
    await worker.done;
    if (!result) throw new Error('Sandbox worker returned no result');
    return result;
  }
  async function update(ctx, run, fields, extra) {
    let next = await runStore(ctx.libraryDb).update(run.id, fields);
    if (next && extra?.message) next = await runStore(ctx.libraryDb).record(next.id, extra.message);
    if (next) publish(ctx, next, extra);
    return next || run;
  }
  async function end(ctx, run, status, error = null) {
    return update(ctx, run, { status, error, finished_at: new Date().toISOString() }, { message: error || 'Sandbox stopped' });
  }
  async function reconcile(ctx, run) {
    if (workers.has(run.id)) return run;
    const result = await control(ctx, 'probe', run);
    const { state } = result;
    if (!run.sandbox_id && result.sandbox_id) run = await update(ctx, run, { sandbox_id: result.sandbox_id });
    if (state === 'ready' && run.status === 'ready') return run;
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
      publish(ctx, await store.record(run.id, message, details), { message });
    } else if (event.event === 'sandbox_created') {
      if (typeof event.sandbox_id !== 'string' || !/^[\w-]{1,200}$/.test(event.sandbox_id)) throw new Error('Invalid sandbox identifier');
      await update(ctx, run, { sandbox_id: event.sandbox_id }, { message: 'Sandbox created' });
    } else if (event.event === 'ready') {
      if (!run.sandbox_id || !Number.isInteger(event.port) || event.port < 1 || event.port > 65535) throw new Error('Invalid ready event');
      // Completion is an inbox notification, never a navigation request. Ignore
      // duplicates so the persisted completion time/read state stays stable.
      if (run.status === 'ready') return;
      await update(ctx, run, { status: 'ready', preview_url: safePreview(event.preview_url), port: event.port }, { message: 'Preview ready', notification: 'preview-ready' });
    } else if (event.event === 'failed' || event.event === 'stopped') {
      await end(ctx, run, event.event, event.event === 'failed' ? String(event.error || 'Setup failed').slice(0, 4000) : null);
    } else throw new Error('Unknown sandbox event');
  }
  function attach(ctx, run, repo, environment, restart = false) {
    let worker;
    const held = { ctx, detaching: false };
    try {
      worker = launch({ command: restart ? 'restart' : 'start', run_id: run.id, github_url: repo.url, sandbox_id: run.sandbox_id, port: run.port, environment }, readEnv(ctx.root), (event) => held.detaching ? undefined : receive(ctx, run.id, redactEvent(event, Object.values(environment.values))));
    } catch (error) { return end(ctx, run, 'failed', error.message); }
    held.worker = worker;
    workers.set(run.id, held);
    const finish = async (error) => {
      if (held.detaching) return;
      const current = await runStore(ctx.libraryDb).get(run.id);
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
  async function start(ctx, libraryId, { automatic = false } = {}) {
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
      prepared.add(key);
      let run = await store.active(libraryId);
      if (run) {
        // A local worker proves setup is active. Ready runs still need a live preview check.
        if (run.status === 'ready') {
          const { state } = await control(ctx, 'probe', run);
          if (state === 'ready') { publish(ctx, run, { message: 'Preview ready' }); return run; }
          if (state === 'unreachable') throw new Error('The preview is temporarily unreachable. Stop the run or retry the check.');
          await stopRun(ctx, run.id);
        } else if (workers.has(run.id)) { publish(ctx, run); return run; }
        else run = await reconcile(ctx, run);
      }
      // Cleanup may have failed on a previous attempt; retain and use that handle.
      const previous = (await store.latest()).find((item) => item.library_id === libraryId);
      const environment = await environmentStore(ctx.libraryDb, secure).read(libraryId);
      if (previous?.sandbox_id && ['failed', 'stopped'].includes(previous.status)) await control(ctx, 'kill', previous);
      run = await store.create(libraryId);
      if (!run) return store.active(libraryId);
      run = await store.update(run.id, { env_revision: environment.revision });
      run = await store.record(run.id, 'Starting repository setup');
      publish(ctx, run, { message: 'Starting repository setup' });
      return attach(ctx, run, repo, environment);
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
      // Confirm that the same machine can relaunch before interrupting anything.
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
      return attach(ctx, run, repo, values, true);
    });
  }
  async function stopRun(ctx, id) {
    const run = await runStore(ctx.libraryDb).get(id);
    if (!run) throw new Error('Unknown sandbox run');
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
  async function pollOnce() {
    if (closing || polling) return;
    polling = true;
    try {
      for (const ctx of contexts.values()) {
        for (const run of await runStore(ctx.libraryDb).latest()) {
          if (closing) return;
          if (!['starting', 'ready'].includes(run.status)) continue;
          await exclusive(`${ctx.dataRoot}:${run.library_id}`, async () => {
            const current = await runStore(ctx.libraryDb).get(run.id);
            if (!['starting', 'ready'].includes(current.status)) return;
            try {
              if (current.status === 'ready' && workers.has(current.id)) {
                const result = await control(ctx, 'probe', current);
                if (['gone', 'inactive'].includes(result.state)) await stopRun(ctx, current.id);
                else if (result.state === 'unreachable') publish(ctx, current, { message: 'Preview currently unreachable; checking again shortly' });
              } else await reconcile(ctx, current);
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
      // A terminal event reaches the UI before its worker finishes exiting/cleanup.
      // Drain those workers too, before the caller closes or replaces the database.
      for (const held of [...workers.values()]) {
        await held.worker.stop().catch(() => {});
        await held.finished;
      }
      for (const ctx of contexts.values()) {
        for (const run of await runStore(ctx.libraryDb).latest()) {
          if (['starting', 'ready'].includes(run.status)) await stopRun(ctx, run.id);
        }
      }
      contexts.clear(); messages.clear(); prepared.clear();
    } finally { closing = false; }
  }
  const stop = async (ctx, id) => {
    const run = await runStore(ctx.libraryDb).get(id);
    if (!run) throw new Error('Unknown sandbox run');
    return exclusive(`${ctx.dataRoot}:${run.library_id}`, () => stopRun(ctx, id));
  };
  return { start, list, stop, environment, saveEnvironment, restart, close, poll, dispose: async () => { clearInterval(timer); await close(); } };
}

module.exports = { createSandboxManager };
