'use strict';

// Only processes started by this controller are stopped. Never kill a process merely
// because it holds a port, and never restore a PID from disk after an app restart.
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION } = require('../context/summarizer.cjs');
const exec = promisify(execFile);

function environmentFor(source = process.env) {
  const env = sanitizeEnvironment(scrubAgentSession(source));
  for (const key of Object.keys(env)) {
    if (NOT_THE_SUBSCRIPTION.includes(key) || /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL|COOKIE|AUTH|DATABASE_URL)/i.test(key)) delete env[key];
  }
  delete env.CODEX_HOME;
  return env;
}

function createProcesses({ environment = process.env } = {}) {
  const owned = new Set();
  const terminateOnExit = () => { for (const proc of owned) if (proc.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* already exited */ } } };
  const shell = resolveShell(environment);
  function start(command, { cwd, env = {}, signal, timeout = 0, onData = () => {} } = {}) {
    if (signal?.aborted) throw Object.assign(new Error('Stopped.'), { kind: 'stopped' });
    const args = path.basename(shell) === 'fish' ? ['--login', '--interactive', '--command', command] : ['-ilc', command];
    const child = spawn(shell, args, { cwd, env: { ...environmentFor(environment), ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', exited = false, timer, stopPromise;
    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const send = sig => { if (child.pid) { try { process.kill(-child.pid, sig); } catch (error) { if (error.code !== 'ESRCH') throw error; } } };
    const proc = {
      pid: child.pid, done,
      get exited() { return exited; },
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          send('SIGTERM');
          // A shell can exit before its children. Keep the group owned until the
          // grace period ends, then remove any remaining children as well.
          await new Promise(resolve => setTimeout(resolve, 250));
          send('SIGKILL');
          await done;
          owned.delete(proc);
          if (!owned.size) process.removeListener('exit', terminateOnExit);
        })();
        return stopPromise;
      },
    };
    const abort = () => { void proc.stop(); };
    if (!owned.size) process.once('exit', terminateOnExit);
    owned.add(proc);
    const finish = (code, error = null) => {
      if (exited) return;
      exited = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolveDone({ code, error, stdout, stderr });
    };
    child.stdout.on('data', data => { const text = data.toString(); stdout = (stdout + text).slice(-2_000_000); onData(text, 'stdout'); });
    child.stderr.on('data', data => { const text = data.toString(); stderr = (stderr + text).slice(-100_000); onData(text, 'stderr'); });
    child.once('error', error => finish(null, error));
    child.once('close', code => finish(code));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeout) timer = setTimeout(() => { stderr += '\nCommand timed out.'; abort(); }, timeout);
    return proc;
  }
  async function run(command, options) {
    const proc = start(command, options);
    const result = await proc.done;
    await proc.stop();
    if (options?.signal?.aborted) throw Object.assign(new Error('Stopped.'), { kind: 'stopped' });
    if (result.error || result.code !== 0) {
      const error = new Error(result.error?.message || result.stderr.trim().slice(-3000) || `Command exited with status ${result.code}.`);
      error.stdout = result.stdout; // the agent adapter reads structured failures; never send raw JSON to the UI
      throw error;
    }
    return result;
  }
  return { start, run, close: () => Promise.all([...owned].map(proc => proc.stop())) };
}

// macOS (and Linux with lsof): check both ownership and loopback binding. This
// prevents mistaking another app's healthy page for the interface we just built.
async function ownsListener(proc, port) {
  if (!proc?.pid || proc.exited) return false;
  let listeners, groups;
  try {
    [{ stdout: listeners }, { stdout: groups }] = await Promise.all([
      exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpn'], { timeout: 3000 }),
      exec('ps', ['-axo', 'pid=,pgid='], { timeout: 3000 }),
    ]);
  } catch { return false; }
  const members = new Set(groups.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(([, group]) => group === proc.pid).map(([pid]) => pid));
  let pid = null, found = false;
  for (const line of listeners.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n')) continue;
    if (!members.has(pid) || !new RegExp(`^(?:127\\.0\\.0\\.1|\\[::1\\]):${port}$`).test(line.slice(1))) return false;
    found = true;
  }
  return found;
}

module.exports = { createProcesses, environmentFor, ownsListener };
