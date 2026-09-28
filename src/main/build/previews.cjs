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

function createBuildPreviews({ verify, processes = createProcesses(), listener = ownsListener, readyTimeoutMs = 60_000 } = {}) {
  const reviews = new Map();
  const accepted = new Map();
  const pending = new Map();
  const installed = new Map();
  let closing = false;
  const check = signal => { if (signal.aborted) throw Object.assign(new Error('Preview stopped.'), { kind: 'stopped' }); };
  const publicPreview = held => held ? { mode: held.mode, status: held.server.exited ? 'stopped' : 'ready', url: held.server.exited ? null : held.url, revision: held.revision, directory: held.directory, name: held.recipe.name } : null;
  const acceptedDirectory = task => path.join(task.repo, path.relative(task.worktree, task.cwd));

  async function stopHeld(held) {
    if (held) { held.controller.abort(); await held.server.stop(); }
  }
  async function stopReview(id) {
    const running = pending.get(id);
    if (running) { running.controller.abort(); await running.done.catch(() => {}); }
    const held = reviews.get(id);
    if (held) { await stopHeld(held); reviews.delete(id); }
  }

  async function launch(task, directory, mode, signal, progress) {
    const recipe = readRecipe(directory);
    if (mode === 'review' && task.interfaceIntent && recipe.buildId !== task.id) throw new Error('The launch recipe was not updated for this Build. Ask the Build agent to finish it.');
    const cwd = path.join(directory, recipe.cwd);
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
      return { taskId: task.id, projectId: task.projectId, directory, mode, recipe, url, revision: randomUUID(), server, controller };
    } catch (error) {
      controller.abort();
      if (server) await server.stop();
      throw error;
    } finally { signal.removeEventListener('abort', aborted); }
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
        const previous = accepted.get(task.repo);
        accepted.set(task.repo, held);
        await stopHeld(previous);
        next = publicPreview(held);
      }
    } catch (error) { next = { mode: 'accepted', status: 'failed', url: null, previousUrl: publicPreview(accepted.get(task.repo))?.url || null, error: error.message.slice(-2000), revision: randomUUID() }; }
    await stopReview(task.id);
    return next;
  }
  async function discard(task) {
    await stopReview(task.id);
    return { ...(publicPreview(accepted.get(task.repo)) || {}), mode: 'restored', revision: randomUUID() };
  }
  async function open(task, options) {
    if (task.status === 'discarded') return null;
    const held = publicPreview(task.status === 'accepted' ? accepted.get(task.repo) : reviews.get(task.id));
    if (held?.status === 'ready') return held;
    return task.status === 'accepted' ? accept(task, options) : review(task, options);
  }
  async function close() {
    closing = true;
    try {
      for (const running of pending.values()) running.controller.abort();
      await Promise.all([...pending.values()].map(row => row.done.catch(() => {})));
      await Promise.all([...reviews.values(), ...accepted.values()].map(stopHeld));
      await processes.close();
      reviews.clear(); accepted.clear(); installed.clear();
    } finally { closing = false; }
  }
  return { review, accept, discard, open, stopReview, close };
}

module.exports = { createBuildPreviews };
