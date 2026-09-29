'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');
const { redactOutput } = require('./environment.cjs');

// A local process boundary. Attach listeners before handing the worker any work.
function launchWorker(request, env, onEvent) {
  // Only the local Claude process needs this user context. Do not inherit the
  // rest of Electron's environment (including provider credentials).
  const local = Object.fromEntries(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR']
    .filter((key) => typeof process.env[key] === 'string').map((key) => [key, process.env[key]]));
  const child = fork(path.join(__dirname, 'worker.cjs'), [], {
    env: { ...local, PATH: process.env.PATH, ...env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  let chain = Promise.resolve();
  let failed = null;
  child.stderr.on('data', (chunk) => { stderr = (stderr + redactOutput(chunk, [env.E2B_API_KEY, env.ANTHROPIC_API_KEY, ...Object.values(request.environment?.values || {})])).slice(-4000); });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    chain = chain.then(async () => {
      if (line.length > 256_000) throw new Error('Worker event is too large');
      const event = JSON.parse(line);
      if (event.run_id !== request.run_id) throw new Error('Worker run id does not match');
      const reply = await onEvent(event);
      // A private repository's download link rides on the ack (manager.cjs); nothing else does.
      const source = reply && typeof reply.archive_url === 'string' ? { archive_url: reply.archive_url, ...(typeof reply.branch === 'string' ? { branch: reply.branch } : {}) } : {};
      if (event.event === 'sandbox_created' && child.connected) child.send({ command: 'ack', ...source });
    }).catch((error) => {
      failed = error;
      if (child.connected) child.send({ command: 'stop' });
    });
  });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      chain.then(() => {
        if (failed) reject(failed);
        else if (code !== 0) reject(new Error(stderr || `Sandbox worker exited (${code})`));
        else resolve();
      });
    });
  });
  child.send(request);
  return {
    done,
    async detach() {
      if (!child.connected) throw new Error('Worker is no longer connected');
      child.send({ command: 'detach' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      try { await done; } finally { clearTimeout(timer); }
    },
    async stop() {
      if (child.connected) child.send({ command: 'stop' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      try { await done; } finally { clearTimeout(timer); }
    },
  };
}

module.exports = { launchWorker };
