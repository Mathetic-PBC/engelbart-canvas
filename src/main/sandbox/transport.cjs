'use strict';

const { fork } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { redactOutput } = require('./environment.cjs');

// A local process boundary. Attach listeners before handing the worker any work.
//
// A worker that dies at once (2026-10-14: the app's own bundle was moved away while it ran — another macOS account
// installed Engelbart over it — so every fork of worker.cjs exited before reading) must not become an "Uncaught
// Exception: write EPIPE" dialog every 15 seconds: each send goes through `post`, whose failure ends `done` instead of
// throwing, and the worker's 'error' is listened to for its whole life, not once.
/** Whether the app's own bundle is gone from under it (its app.asar moved or deleted while it runs): no worker can start. */
function bundleGone(file = __dirname) {
  const at = file.indexOf('.asar');
  if (at < 0) return false;
  try { return !require('original-fs').existsSync(file.slice(0, at + 5)); } catch { return !fs.existsSync(file.slice(0, at + 5)); }
}
const MOVED = 'Engelbart was moved or replaced while it was open. Quit it and open it again.';

function launchWorker(request, env, onEvent, { workerPath = path.join(__dirname, 'worker.cjs') } = {}) {
  // Nothing to fork from: said once per check, plainly, instead of a worker that dies at once.
  if (bundleGone(workerPath)) {
    const done = Promise.reject(new Error(MOVED));
    done.catch(() => {});
    return { done, async detach() { throw new Error(MOVED); }, async stop() {} };
  }
  // Only the local Claude process needs this user context. Do not inherit the
  // rest of Electron's environment (including provider credentials).
  const local = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR']
    .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
  const child = fork(workerPath, [], {
    env: { ...local, PATH: process.env.PATH, ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let chain = Promise.resolve();
  let failed = null;
  let broken = null; // the pipe to the worker failed (EPIPE, ERR_IPC_CHANNEL_CLOSED): it is gone
  const post = (message) => {
    if (!child.connected) return false;
    try {
      child.send(message, (error) => { if (error && !broken) { broken = error; try { child.kill('SIGKILL'); } catch { /* gone */ } } });
      return true;
    } catch (error) {
      if (!broken) broken = error;
      return false;
    }
  };
  child.stderr.on('data', (chunk) => { stderr = (stderr + redactOutput(chunk, [env.E2B_API_KEY, ...Object.values(request.environment?.values || {})])).slice(-4000); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    chain = chain.then(async () => {
      if (line.length > 256_000) throw new Error('Worker event is too large');
      const event = JSON.parse(line);
      if (event.run_id !== request.run_id) throw new Error('Worker run id does not match');
      const reply = await onEvent(event);
      // A private repository's download link rides on the ack (manager.cjs); nothing else does.
      const source = reply && typeof reply.archive_url === 'string' ? { archive_url: reply.archive_url, ...(typeof reply.branch === 'string' ? { branch: reply.branch } : {}) } : {};
      if (event.event === 'sandbox_created') post({ command: 'ack', ...source });
    }).catch((error) => {
      failed = error;
      post({ command: 'stop' });
    });
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', (error) => { if (!broken) broken = error; reject(error); });
    child.once('close', (code) => {
      chain.then(() => {
        if (failed) reject(failed);
        else if (broken && code !== 0) reject(new Error(`Sandbox worker could not start${stderr ? `: ${stderr.trim().split('\n').pop()}` : ''}`));
        else if (code !== 0) reject(new Error(stderr || `Sandbox worker exited (${code})`));
        else resolve();
      });
    });
  });
  post(request);
  return {
    done,
    async detach() {
      if (!post({ command: 'detach' })) throw new Error('Worker is no longer connected');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { await done; } finally { clearTimeout(timer); }
    },
    async stop() {
      post({ command: 'stop' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      try { await done; } finally { clearTimeout(timer); }
    },
  };
}

module.exports = { launchWorker, bundleGone, MOVED };
