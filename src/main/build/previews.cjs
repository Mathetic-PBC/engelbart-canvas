'use strict';

// Build only owns the code in its Git worktree. This adapter owns the processes
// serving it, using the same recipes, loopback checks and renderer verification
// as saved .local-apps. No repository associations or library rows are created.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { readRecipe, installKey } = require('../local-preview/files.cjs');
const { createProcesses, ownsListener } = require('../local-preview/process.cjs');
const { freePort } = require('../local-preview/manager.cjs');
const { canonical } = require('../store/workspace-repositories.cjs');
const { affectedBy } = require('../store/repository-activity.cjs');

function createBuildPreviews({ verify, processes = createProcesses(), listener = ownsListener, readyTimeoutMs = 60_000 } = {}) {
  const reviews = new Map();
  const accepted = new Map();
  const pending = new Map();
  const installed = new Map();
  const launching = new Set();
  const stopping = new Set();
  const listeners = new Set();
  let closing = false;
  const check = signal => { if (signal.aborted) throw Object.assign(new Error('Preview stopped.'), { kind: 'stopped' }); };
  const publicPreview = held => held ? { serverId: held.revision, mode: held.mode, status: held.server.exited || stopping.has(held) ? 'stopped' : 'ready', url: held.server.exited || stopping.has(held) ? null : held.url, revision: held.revision, directory: held.directory, name: held.recipe.name } : null;
  const acceptedDirectory = task => path.join(task.repo, path.relative(task.worktree, task.cwd));
  const repositoryKey = task => canonical(task.repo);
  const stoppedPreview = held => ({ ...publicPreview(held), status: 'stopped', url: null, replacesUrl: held.url, revision: randomUUID() });
  function changed(previous, preview) {
    for (const listener of listeners) listener({ previous: { ...publicPreview(previous), url: previous.url }, preview: { ...preview, replacesUrl: previous.url, background: true } });
  }
  function watch(held, map, key) {
    held.server.done?.then(async () => {
      if (map.get(key) !== held || stopping.has(held)) return; // replaced/explicitly stopped elsewhere
      held.stopping = true;
      await stopHeld(held); // reap any remaining children before worktree cleanup
      if (map.get(key) !== held) return;
      map.delete(key);
      changed(held, stoppedPreview(held));
    }).catch(error => console.warn('[build-preview] Could not reconcile stopped preview:', error.message));
  }

  async function stopHeld(held) {
    if (!held) return;
    stopping.add(held);
    try { held.controller.abort(); await held.server.stop(); }
    finally { stopping.delete(held); }
  }
  async function stopReview(id) {
    const running = pending.get(id);
    if (running) { running.controller.abort(); await running.done.catch(() => {}); }
    const held = reviews.get(id);
    if (held) {
      await stopHeld(held);
      if (reviews.get(id) === held) reviews.delete(id);
    }
  }

  async function launch(task, directory, mode, signal, progress) {
    const recipe = readRecipe(directory);
    if (mode === 'review' && task.interfaceIntent && recipe.buildId !== task.id) throw new Error('The launch recipe was not updated for this Build. Ask the Build agent to finish it.');
    const cwd = path.join(directory, recipe.cwd);
    const activity = { projectId: task.projectId, workspaceId: task.workspaceId, repositories: [task.repo], paths: [directory] };
    launching.add(activity);
    const controller = new AbortController();
    const aborted = () => controller.abort();
    signal.addEventListener('abort', aborted, { once: true });
    let server;
    const logs = [];
    const onData = data => { logs.push(String(data).slice(-2000)); if (logs.length > 12) logs.shift(); };
    try {
      check(signal);
      const fingerprint = installKey(directory, recipe);
      if (recipe.install && (installed.get(directory) !== fingerprint || !fs.existsSync(path.join(cwd, 'node_modules')))) {
        progress('Installing preview dependencies');
        await processes.run(recipe.install, { cwd, signal: controller.signal, timeout: 10 * 60_000, env: { CI: '1' }, onData });
        installed.set(directory, installKey(directory, recipe));
      }
      if (recipe.build) {
        progress('Compiling the preview');
        await processes.run(recipe.build, { cwd, signal: controller.signal, timeout: 10 * 60_000, env: { CI: '1' }, onData });
      }
      check(signal);
      const port = await freePort();
      const url = `http://127.0.0.1:${port}${recipe.path}`;
      progress('Starting the preview');
      server = processes.start(recipe.command.replaceAll('{port}', String(port)), { cwd, signal: controller.signal, env: { PORT: String(port), HOST: '127.0.0.1', BROWSER: 'none' }, onData });
      let reachable = false;
      const deadline = Date.now() + readyTimeoutMs;
      while (Date.now() < deadline) {
        check(signal);
        if (server.exited) throw new Error(`The preview server exited before it was ready. ${logs.join('\n')}`);
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
          } catch { /* compiling */ }
        }
        if (reachable) break;
        await delay(150, undefined, { signal });
      }
      if (!reachable) throw new Error('No HTML interface responded on the owned loopback port.');
      progress('Checking the rendered preview');
      await verify(url, { signal });
      check(signal);
      if (server.exited || !(await listener(server, port))) throw new Error('The preview server stopped during verification.');
      return { taskId: task.id, projectId: task.projectId, workspaceId: task.workspaceId, repo: task.repo, directory, mode, recipe, url, revision: randomUUID(), server, controller };
    } catch (error) {
      controller.abort();
      if (server) await server.stop();
      throw error;
    } finally { launching.delete(activity); signal.removeEventListener('abort', aborted); }
  }

  async function review(task, { signal = new AbortController().signal, progress = () => {} } = {}) {
    if (closing) throw new Error('Previews are shutting down.');
    await stopReview(task.id);
    if (!fs.existsSync(path.join(task.cwd, 'engelbart-preview.json')) && !task.interfaceIntent) return null;
    const controller = new AbortController();
    const aborted = () => controller.abort();
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) controller.abort();
    const done = launch(task, task.cwd, 'review', controller.signal, progress);
    pending.set(task.id, { controller, done });
    try {
      const held = await done;
      reviews.set(task.id, held);
      watch(held, reviews, task.id);
      return publicPreview(held);
    } finally { pending.delete(task.id); signal.removeEventListener('abort', aborted); }
  }

  // Only called after Git accepted the changes. A launch failure must not make
  // a successful fast-forward look like a failed Accept. Always stop the review
  // server before its worktree is removed; keep the previous accepted server
  // until its replacement passes verification.
  async function accept(task, { signal = new AbortController().signal } = {}) {
    if (closing) throw new Error('Previews are shutting down.');
    let next = null;
    try {
      const directory = acceptedDirectory(task);
      if (fs.existsSync(path.join(directory, 'engelbart-preview.json'))) {
        const held = await launch(task, directory, 'accepted', signal, () => {});
        const key = repositoryKey(task), previous = accepted.get(key);
        accepted.set(key, held);
        watch(held, accepted, key);
        await stopHeld(previous);
        next = publicPreview(held);
        if (previous) changed(previous, next);
      }
    } catch (error) { next = { mode: 'accepted', status: 'failed', url: null, previousUrl: publicPreview(accepted.get(repositoryKey(task)))?.url || null, error: error.message.slice(-2000), revision: randomUUID() }; }
    await stopReview(task.id);
    return next;
  }
  async function discard(task) {
    await stopReview(task.id);
    return { ...(publicPreview(accepted.get(repositoryKey(task))) || {}), mode: 'restored', revision: randomUUID() };
  }
  async function open(task, options) {
    if (task.status === 'discarded') return null;
    const held = publicPreview(task.status === 'accepted' ? accepted.get(repositoryKey(task)) : reviews.get(task.id));
    if (held?.status === 'ready') return held;
    return task.status === 'accepted' ? accept(task, options) : review(task, options);
  }
  async function close() {
    closing = true;
    try {
      for (const running of pending.values()) running.controller.abort();
      await Promise.all([...pending.values()].map(row => row.done.catch(() => {})));
      const held = [...reviews.values(), ...accepted.values()];
      reviews.clear(); accepted.clear();
      await Promise.all(held.map(async row => { await stopHeld(row); changed(row, stoppedPreview(row)); }));
      await processes.close();
      reviews.clear(); accepted.clear(); installed.clear();
    } finally { closing = false; }
  }
  function busy(projectId, roots, workspaceIds = []) {
    const scope = { projectId, roots, workspaceIds };
    if ([...launching].some(activity => affectedBy(scope, activity))) return true;
    return [...new Set([...reviews.values(), ...accepted.values(), ...stopping])].some(held =>
      (!held.server.exited || held.stopping || stopping.has(held))
      && affectedBy(scope, { projectId: held.projectId, workspaceId: held.workspaceId, repositories: [held.repo], paths: [held.directory] }));
  }
  async function stopTask(task, expectedId = null) {
    // The card's preview identifies one server. A review never owns the shared
    // accepted server merely because both were built in the same repository.
    const shared = ['accepted', 'restored'].includes(task.preview?.mode);
    const map = shared ? accepted : reviews, key = shared ? repositoryKey(task) : task.id;
    const held = map.get(key);
    if (!held || expectedId && expectedId !== held.revision || (task.preview?.serverId ? task.preview.serverId !== held.revision : task.preview?.url !== held.url)) return;
    await stopHeld(held);
    if (map.get(key) === held) map.delete(key);
    changed(held, stoppedPreview(held));
  }
  return { review, accept, discard, open, stopReview, stopTask, close, busy, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

module.exports = { createBuildPreviews };
