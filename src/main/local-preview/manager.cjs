'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { locations, readState, saveState, readRecipe, installKey } = require('./files.cjs');
const { createProcesses, ownsListener } = require('./process.cjs');
const { replyLines } = require('../bart/reply.cjs');
const projects = require('../store/projects.cjs');
const library = require('../store/library.cjs');

const ACTIVE = new Set(['planning', 'confirming', 'building', 'installing', 'starting', 'checking', 'repairing']);
const cancelled = () => Object.assign(new Error('Stopped.'), { kind: 'stopped' });
const check = signal => { if (signal.aborted) throw cancelled(); };
const clean = text => String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(-6000);

async function freePort(preferred) {
  const reserve = port => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { const found = server.address().port; server.close(error => error ? reject(error) : resolve(found)); });
  });
  if (Number.isInteger(preferred) && preferred > 1023 && preferred < 65536) { try { return await reserve(preferred); } catch { /* choose another; never kill its owner */ } }
  return reserve(0);
}

function createLocalPreviews({ agent, planner, verify, processes = createProcesses(), confirm = null, notify = () => {}, listener = ownsListener, readyTimeoutMs = 60_000 } = {}) {
  const entries = new Map();
  const keyOf = (ctx, pid, wid) => `${ctx.dataRoot}:${pid}:${wid}`;
  let closing = false;
  function entry(ctx, pid, wid, create = false) {
    projects.findWorkspace(ctx, pid, wid);
    const key = keyOf(ctx, pid, wid);
    if (entries.has(key)) return entries.get(key);
    const where = locations(ctx, pid, wid, create);
    const saved = readState(where);
    if (!saved && !create) return null;
    // A recipe and files survive a restart. A process never does: stale state is
    // explicitly stopped, never blindly reattached or started during app launch.
    const state = saved ? { ...saved, status: saved.status === 'failed' ? 'failed' : 'stopped', url: null, activity: '', askId: null, approval: null }
      : { id: where.id, projectId: pid, workspaceId: wid, directory: where.directory, name: where.name, workspaceName: where.name, status: 'stopped', recipe: null, logs: [], url: null, libraryId: null };
    if (Array.isArray(saved?.plan?.steps)) state.plan = { ...saved.plan, steps: saved.plan.steps.map(row => row.status === 'running' ? { ...row, status: 'stopped', detail: 'Interrupted when Canvas closed' } : row) };
    const held = { where, ctx, state, server: null, controller: null, work: null, progress: null, timer: null };
    entries.set(key, held);
    return held;
  }
  function publish(held, patch = {}) {
    held.state = { ...held.state, ...patch, updatedAt: new Date().toISOString() };
    saveState(held.where, held.state);
    notify({ preview: { ...held.state }, dataRoot: held.ctx.dataRoot });
    return { ...held.state };
  }
  function log(held, text) {
    const line = clean(text).trim();
    if (!line) return;
    held.state = { ...held.state, logs: [...held.state.logs, line].slice(-80) };
    if (!held.timer) held.timer = setTimeout(() => { held.timer = null; publish(held); }, 150);
  }
  function phase(held, status, activity) {
    log(held, activity);
    held.progress?.({ activity, log: true });
    publish(held, { status, activity });
  }
  function step(held, idOrPhase, status, detail = '') {
    if (!held.state.plan) return;
    const at = new Date().toISOString();
    publish(held, { plan: { ...held.state.plan, steps: held.state.plan.steps.map(row => row.id === idOrPhase || row.phase === idOrPhase ? { ...row, status, detail, ...(status === 'running' ? { startedAt: at, finishedAt: null } : { finishedAt: at }) } : row) } });
  }
  async function requestApproval(held, signal, kind) {
    check(signal);
    // Tests may supply a decision directly. Production waits for a trusted UI
    // reply bound to this exact request, not a persisted permission or ask id.
    if (confirm) return confirm({ ...held.state }, { signal });
    const approval = {
      id: randomUUID(), workspaceId: held.state.workspaceId, kind,
      message: kind === 'build' ? held.state.plan.summary : 'Run this interface on your computer again?',
      detail: kind === 'build' ? 'Build locally creates files and runs commands on your computer. Your selected coding agent receives the workspace context and Claude’s plan.' : 'This runs the saved app’s install/start commands on your computer.',
      label: kind === 'build' ? 'Build locally' : 'Run locally',
    };
    let finish;
    const decision = new Promise(resolve => { finish = resolve; });
    const abort = () => finish(false);
    held.approval = { id: approval.id, finish };
    signal.addEventListener('abort', abort, { once: true });
    try {
      publish(held, { approval, activity: 'Waiting for your reply' });
      held.progress?.({ buildApproval: approval, activity: 'Waiting for your reply' });
      return await decision;
    } finally {
      signal.removeEventListener('abort', abort);
      held.approval = null;
      publish(held, { approval: null });
      held.progress?.({ buildApproval: null, activity: '' });
    }
  }
  async function stopServer(held) {
    const server = held.server;
    held.server = null;
    if (server) await server.stop();
  }
  async function launch(held, signal, buildId = null) {
    check(signal);
    locations(held.ctx, held.state.projectId, held.state.workspaceId); // reject folders replaced with symlinks since the last run
    const recipe = readRecipe(held.where.directory);
    if (buildId && recipe.buildId !== buildId) throw new Error('The agent did not produce an interface launch recipe for this build. The existing app is not a new build result.');
    publish(held, { recipe, name: recipe.name, url: null });
    const cwd = path.join(held.where.directory, recipe.cwd);
    const fingerprint = installKey(held.where.directory, recipe);
    const needsInstall = recipe.install && (held.state.installed !== fingerprint || !fs.existsSync(path.join(cwd, 'node_modules')));
    if (needsInstall) {
      step(held, 'install', 'running');
      phase(held, 'installing', 'Installing dependencies');
      await processes.run(recipe.install, { cwd, signal, timeout: 10 * 60_000, env: { CI: '1', npm_config_cache: path.join(held.where.root, 'npm-cache') }, onData: data => log(held, data) });
      check(signal);
      publish(held, { installed: installKey(held.where.directory, recipe) });
      step(held, 'install', 'done');
    } else step(held, 'install', 'skipped', recipe.install ? 'Existing dependencies reused' : 'No dependencies to install');
    if (recipe.build) {
      step(held, 'compile', 'running');
      phase(held, 'building', 'Compiling the local interface');
      await processes.run(recipe.build, { cwd, signal, timeout: 10 * 60_000, env: { CI: '1' }, onData: data => log(held, data) });
      check(signal);
      step(held, 'compile', 'done');
    } else step(held, 'compile', 'skipped', 'No separate compilation needed');
    const port = await freePort(held.state.port);
    check(signal);
    const url = `http://127.0.0.1:${port}${recipe.path}`;
    const command = recipe.command.replaceAll('{port}', String(port));
    step(held, 'start', 'running');
    phase(held, 'starting', 'Starting the local server');
    publish(held, { recipe, name: recipe.name, port, url: null });
    const server = processes.start(command, { cwd, signal, env: { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' }, onData: data => log(held, data) });
    held.server = server;
    server.done.then(async result => {
      if (held.server !== server) return;
      if (held.state.status === 'ready') publish(held, { status: 'failed', url: null, error: `The local server exited (${result.code ?? result.error?.message ?? 'unknown'}). Restart it to try again.`, activity: '' });
      await stopServer(held);
    });
    let reachable = false;
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      check(signal);
      if (server.exited) throw new Error(`The preview command exited before the interface was ready.\n${held.state.logs.slice(-10).join('\n')}`);
      if (await listener(server, port)) {
        try {
          let target = url;
          for (let redirects = 0; redirects < 4; redirects++) {
            const response = await fetch(target, { signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]), redirect: 'manual' });
            reachable = response.ok && /text\/html/i.test(response.headers.get('content-type') || '');
            const location = response.headers.get('location');
            await response.body?.cancel();
            if (reachable || !location || response.status < 300 || response.status >= 400) break;
            const next = new URL(location, target);
            if (next.origin !== new URL(url).origin) break;
            target = next.href;
          }
          if (reachable) break;
        } catch { /* the server can still be compiling */ }
      }
      await delay(250, undefined, { signal });
    }
    if (!reachable) throw new Error('No HTML interface responded on the owned loopback port. Check the command, {port}, and 127.0.0.1 binding.');
    step(held, 'start', 'done');
    step(held, 'verify', 'running');
    phase(held, 'checking', 'Checking the rendered interface');
    const rendered = await verify(url, { signal });
    check(signal);
    if (held.server !== server || !(await listener(server, port))) throw new Error('The local server stopped during its browser check.');
    // Link before announcing ready, so the Stage handoff already has stable source
    // identity. Failure to index an otherwise live app is visible in its logs.
    try { await link(held); } catch (error) { log(held, `Could not add the app folder to Context: ${error.message}`); }
    check(signal);
    if (held.server !== server || server.exited) throw new Error('The local server stopped before its preview could open.');
    step(held, 'verify', 'done');
    return publish(held, { status: 'ready', activity: '', error: null, url, title: rendered?.title || recipe.name, readyAt: new Date().toISOString() });
  }
  async function link(held) {
    let row;
    try { row = await library.addItem(held.ctx, held.where.directory, { name: held.state.name }); }
    catch (error) { if (error.code !== 'EXISTS' || !error.row) throw error; row = error.row; }
    await projects.linkToWorkspace(held.ctx, held.state.projectId, held.state.workspaceId, [row.id]);
    publish(held, { libraryId: row.id });
    notify({ libraryChanged: true });
  }
  function startWork(held, fn) {
    if (closing) throw new Error('Local previews are shutting down.');
    if (held.work) throw new Error('This workspace already has a local build running. Stop it first.');
    const controller = new AbortController();
    const previous = { ...held.state };
    held.mutating = false;
    held.controller = controller;
    held.work = Promise.resolve().then(() => fn(controller.signal)).catch(async error => {
      const stopped = controller.signal.aborted || error.kind === 'stopped';
      for (const current of held.state.plan?.steps || []) if (current.status === 'running') step(held, current.id, stopped ? 'stopped' : 'failed', stopped ? 'Stopped' : clean(error.message));
      if (!held.mutating) {
        if (stopped) publish(held, previous);
        else publish(held, { status: held.server ? 'ready' : 'failed', activity: '', error: clean(error.message), approval: null });
      }
      else {
        await stopServer(held);
        publish(held, { status: stopped ? 'stopped' : 'failed', url: null, activity: '', error: stopped ? null : clean(error.message) });
      }
      if (stopped) throw cancelled();
      throw error;
    }).finally(() => {
      clearTimeout(held.timer); held.timer = null;
      held.work = null; held.progress = null;
      publish(held, { askId: null });
    });
    return held.work;
  }
  function build(ctx, pid, input, { onProgress = () => {} } = {}) {
    const held = entry(ctx, pid, input.workspaceId, true);
    return startWork(held, async signal => {
      held.progress = onProgress;
      publish(held, { status: 'planning', runId: randomUUID(), askId: input.askId, startedAt: new Date().toISOString(), readyAt: null, logs: [], error: null, plan: null, approval: null });
      onProgress({ localBuild: { id: held.state.id }, lines: [] });
      phase(held, 'planning', 'Claude is preparing the build plan');
      if (!planner) throw new Error('The Claude build planner is not available.');
      const plan = await planner(ctx, pid, input, { directory: held.where.directory, signal, onProgress: update => { onProgress(update); if (update.activity) log(held, update.activity); } });
      check(signal);
      // Validate even injected planners; only known phases can reach execution.
      const validated = require('./plan.cjs').normalizePlan(plan);
      publish(held, { plan: { ...validated, by: plan.by || 'Claude', model: plan.model || null }, name: validated.name, status: 'confirming', activity: 'Review the build plan in Notifications' });
      if (!(await requestApproval(held, signal, 'build'))) throw cancelled();
      check(signal);
      held.mutating = true;
      locations(ctx, pid, input.workspaceId, true);
      await stopServer(held);
      phase(held, 'building', 'Preparing the local repository');
      if (!fs.existsSync(path.join(held.where.directory, '.git'))) await processes.run('git init --quiet', { cwd: held.where.directory, signal, timeout: 15_000 });
      let out;
      const codeSteps = held.state.plan.steps.filter(row => row.phase === 'code');
      const progress = update => { onProgress(update); if (update.activity) { log(held, update.activity); held.state.activity = update.activity; } };
      for (const currentStep of codeSteps) {
        check(signal);
        step(held, currentStep.id, 'running');
        phase(held, 'building', currentStep.title);
        out = await agent(ctx, pid, input, { directory: held.where.directory, signal, approved: true, plan: held.state.plan, currentStep, finalCodeStep: currentStep.id === codeSteps.at(-1).id, onProgress: progress });
        check(signal);
        step(held, currentStep.id, 'done');
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        check(signal);
        try { await launch(held, signal, input.askId); break; }
        catch (error) {
          await stopServer(held);
          check(signal);
          for (const current of held.state.plan.steps) if (current.status === 'running') step(held, current.id, 'failed', clean(error.message));
          if (attempt) throw error;
          const repair = `${error.message}\n${held.state.logs.slice(-10).join('\n')}`;
          log(held, repair);
          phase(held, 'repairing', 'Repairing the launch failure');
          out = await agent(ctx, pid, input, { directory: held.where.directory, signal, approved: true, plan: held.state.plan, finalCodeStep: true, repair, onProgress: progress });
          check(signal);
          publish(held, { plan: { ...held.state.plan, steps: held.state.plan.steps.map(row => row.phase === 'code' ? row : { ...row, status: 'pending', detail: '', startedAt: null, finishedAt: null }) } });
        }
      }
      check(signal);
      const summary = `${out.text}\n\n[Open live preview](${held.state.url})\n\nBuild steps, files and run command: **Notifications**.`;
      return { lines: replyLines(summary, out.meta), meta: out.meta, preview: { ...held.state } };
    });
  }
  async function stop(ctx, pid, wid) {
    const held = entry(ctx, pid, wid);
    if (!held) return null;
    held.mutating = true;
    held.controller?.abort();
    await stopServer(held);
    await held.work?.catch(() => {});
    return publish(held, { status: 'stopped', url: null, activity: '', error: null });
  }
  function restart(ctx, pid, wid) {
    const held = entry(ctx, pid, wid);
    if (!held?.state.recipe) throw new Error('Build an interface before starting its preview.');
    return startWork(held, async signal => {
      // Local files may have changed outside Canvas: authorization is explicit on
      // restart too, not inferred from a persisted recipe or an old process id.
      phase(held, 'confirming', 'Awaiting permission to restart locally');
      if (!(await requestApproval(held, signal, 'restart'))) throw cancelled();
      check(signal);
      held.mutating = true;
      await stopServer(held);
      publish(held, { runId: randomUUID(), startedAt: new Date().toISOString(), readyAt: null, logs: [], error: null });
      if (held.state.plan) publish(held, { plan: { ...held.state.plan, steps: held.state.plan.steps.map(row => ({ ...row, status: row.phase === 'code' ? 'skipped' : 'pending', detail: row.phase === 'code' ? 'Using the saved app files' : '', startedAt: null, finishedAt: null })) } });
      return launch(held, signal);
    });
  }
  return {
    build, stop, restart,
    approve(ctx, pid, wid, approvalId, approved) {
      if (typeof approved !== 'boolean') throw new TypeError('Approval must be true or false.');
      const held = entry(ctx, pid, wid);
      if (!held?.approval || held.approval.id !== approvalId || held.controller?.signal.aborted) throw new Error('This build request is no longer waiting for a reply.');
      const { finish } = held.approval;
      held.approval = null; // consume exactly once, before resolving the waiting run
      finish(approved);
      return true;
    },
    get(ctx, pid, wid) { const held = entry(ctx, pid, wid); return held ? { ...held.state } : null; },
    async list(ctx) {
      const rows = [];
      for (const project of await projects.listProjects(ctx)) for (const workspace of projects.flattenWorkspaces(project.dir)) {
        try { const held = entry(ctx, project.id, workspace.id); if (held && (held.state.runId || held.state.recipe)) rows.push({ ...held.state }); }
        catch { /* deleted workspace or invalid saved state is not an active notification */ }
      }
      return rows;
    },
    stopAsk(id) { for (const held of entries.values()) if (held.work && held.state.askId === id) { held.controller.abort(); return true; } return false; },
    async close() {
      closing = true;
      try {
        for (const held of entries.values()) { held.mutating = true; held.controller?.abort(); }
        await Promise.all([...entries.values()].map(async held => {
          await stopServer(held); await held.work?.catch(() => {});
          clearTimeout(held.timer); held.timer = null;
          publish(held, { status: 'stopped', url: null, activity: '', askId: null });
        }));
        await processes.close();
        entries.clear();
      } finally { closing = false; }
    },
  };
}

module.exports = { createLocalPreviews, freePort, ACTIVE };
