'use strict';

// Main's side of the scanner process (./scan-child.cjs): `run(job, args)` → a promise of the job's answer. `fork()`
// makes the process (Electron's utilityProcess.fork in the app); without one (the tests, plain Node) the job runs here.
// The process is started on the first job and started again if it ends; a job that takes over `timeoutMs` fails. A
// process that has not started within `spawnMs` is given up on for the rest of the run, its jobs and every later one
// done here (slower to the window, never stuck).

function createScanner({ fork = null, timeoutMs = 120_000, spawnMs = 5000, local = () => require('./scan-child.cjs') } = {}) {
  let child = null;
  let spawned = false;
  let broken = !fork;
  let seq = 0;
  const waiting = new Map();

  const settle = (id, fn) => { const one = waiting.get(id); if (!one) return; waiting.delete(id); clearTimeout(one.timer); fn(one); };
  const here = (job, args) => new Promise((resolve, reject) => {
    setImmediate(() => {
      const out = local().answer({ id: 0, job, args });
      if (out.ok) resolve(out.value); else reject(new Error(out.error));
    });
  });

  function start() {
    spawned = false;
    child = fork();
    const mine = child;
    if (typeof mine.once === 'function') mine.once('spawn', () => { spawned = true; });
    mine.on('message', (message) => {
      spawned = true;
      if (!message || message.id == null) return;
      settle(message.id, (one) => (message.ok ? one.resolve(message.value) : one.reject(new Error(message.error || 'The scan failed'))));
    });
    mine.on('exit', () => {
      if (child === mine) child = null;
      for (const id of [...waiting.keys()]) settle(id, (one) => one.reject(new Error('The scanner stopped')));
    });
    // Never started: every job it holds is done here instead, and so is every later one.
    setTimeout(() => {
      if (spawned || child !== mine) return;
      broken = true;
      child = null;
      try { mine.kill(); } catch { /* never started */ }
      for (const id of [...waiting.keys()]) settle(id, (one) => here(one.job, one.args).then(one.resolve, one.reject));
    }, spawnMs).unref?.();
  }

  function run(job, args = {}) {
    if (broken) return here(job, args);
    if (!child) {
      try { start(); } catch { broken = true; return here(job, args); }
    }
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id, (one) => one.reject(new Error(`The scan (${job}) took too long`))), timeoutMs);
      waiting.set(id, { resolve, reject, timer, job, args });
      try { child.postMessage({ id, job, args }); } catch (error) { settle(id, (one) => one.reject(error)); }
    });
  }

  function stop() { if (child) { try { child.kill(); } catch { /* gone */ } child = null; } }

  return { run, stop };
}

/** What a folder guard (./folder-access.cjs guard) is made of, for the scanner process to make it again. */
const accessSpec = (guard, dataRoot) => (guard ? { dataRoot: dataRoot || null, answers: guard.answers || null } : null);

module.exports = { createScanner, accessSpec };
