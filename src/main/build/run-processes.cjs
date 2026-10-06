'use strict';

// The processes a Build's run step starts (2026-09-29; ./run-step.cjs): Engelbart's, never the agent's. Each runs in the
// person's login shell (the PATH the terminal has) as the leader of a process group of its own, so stopping it stops
// everything it started; what it prints is kept (the last 32 KB) for the agent to read when a check fails. The checks are
// Engelbart's own, and the same every time:
//   ui        answers on the port Engelbart gave it (../sandbox/worker.cjs respondsAt, on 127.0.0.1 or ::1)
//   app       still running 10 seconds after it started
//   terminal  exits 0
// A UI's port is a free one on this Mac, found at each start.
//
// Windows (2026-10-05, docs/windows-port.md) has no process groups: a process and everything it started (its tree) are
// stopped with `taskkill /T /F`, each descendant named (found through Git Bash's ps too: /T alone left npm's server
// running on CI), and what only needs ps or lsof (a leftover after a crash, an app's window to the front) is skipped.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { respondsAt } = require('../sandbox/worker.cjs');

const OUTPUT_BYTES = 32_000;
const APP_ALIVE_MS = 10_000;
const UI_READY_MS = 90_000;
const STOP_WAIT_MS = 5_000;

const pause = (ms, signal) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** A port nothing listens on now, on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** The processes of a process group now (its leader's pid), from ps. None on Windows. */
function groupPids(pgid, { run = execFile, platform = process.platform } = {}) {
  if (platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => run('/bin/ps', ['-A', '-o', 'pid=,pgid='], { timeout: 5000 }, (error, stdout) => {
    if (error) { resolve([]); return; }
    resolve(String(stdout).split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid, group]) => group === pgid && Number.isInteger(pid)).map(([pid]) => pid));
  }));
}

/**
 * A desktop app's window to the front: the first of `pids` that is an app with a Dock icon is activated (macOS AppKit,
 * NSRunningApplication; it asks for no permission). → whether there was one
 */
function focusApp(pids, { run = execFile } = {}) {
  const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (process.platform !== 'darwin' || !list.length) return Promise.resolve(false);
  const script = `ObjC.import('AppKit'); var done = false; [${list.join(',')}].forEach(function (pid) { if (done) return; var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid); if (!app.isNil() && app.activationPolicy == 0) { app.activateWithOptions(3); done = true; } }); done ? 'yes' : 'no'`;
  return new Promise((resolve) => run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, (error, stdout) => resolve(!error && String(stdout).trim() === 'yes')));
}

/** On Windows: every process's pid and its parent's, from PowerShell's CIM (tasklist has no parents). → [[pid, parent]] */
function processParents({ run = execFile } = {}) {
  const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  return new Promise((resolve) => run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? [] : String(stdout || '').split(/\r?\n/).map((line) => line.trim().split(/\s+/).map(Number)).filter(([pid, parent]) => Number.isInteger(pid) && Number.isInteger(parent)));
  }));
}

/**
 * On Windows: Git Bash's own processes, from its ps (it knows their parents when Windows doesn't: its exec starts a new
 * Windows process and the one that started it exits). `shell`: Git Bash's bin\bash.exe. → [[pid, parent pid, Windows pid]]
 */
function gitBashProcesses(shell, { run = execFile } = {}) {
  const ps = path.win32.join(path.win32.dirname(shell), '..', 'usr', 'bin', 'ps.exe');
  return new Promise((resolve) => run(ps, ['-e'], { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    resolve(error ? [] : String(stdout || '').split(/\r?\n/).map((line) => /^\s*[A-Z]?\s*(\d+)\s+(\d+)\s+\d+\s+(\d+)\s/.exec(line)).filter(Boolean).map((m) => m.slice(1, 4).map(Number)));
  }));
}

/**
 * On Windows: `pid` and every process it started, stopped. Its descendants are listed first, through Windows' parents and
 * Git Bash's (`shell`), and each named to taskkill: /T alone, which follows Windows' parents only, left npm's server
 * running when Git Bash had started npm. → when taskkill has finished
 */
async function killTree(pid, { run = execFile, shell = null } = {}) {
  const [pairs, bash] = await Promise.all([processParents({ run }), shell ? gitBashProcesses(shell, { run }) : []]);
  const tree = [pid];
  const own = [];
  for (let size = -1; size !== tree.length + own.length;) {
    size = tree.length + own.length;
    for (let i = 0; i < tree.length; i += 1) for (const [child, parent] of pairs) if (parent === tree[i] && child !== parent && !tree.includes(child)) tree.push(child);
    for (const [id, , winpid] of bash) if (tree.includes(winpid) && !own.includes(id)) own.push(id);
    for (let i = 0; i < own.length; i += 1) for (const [id, parent, winpid] of bash) if (parent === own[i] && !own.includes(id)) { own.push(id); if (!tree.includes(winpid)) tree.push(winpid); }
  }
  const args = ['/T', '/F', ...tree.flatMap((each) => ['/PID', String(each)])];
  await new Promise((resolve) => run('taskkill', args, { timeout: 10_000, windowsHide: true }, () => resolve()));
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/**
 * A process group an Engelbart that closed without stopping it left behind (it crashed): stopped only while its leader
 * is still the process that was started, a group leader whose folder is inside `within` (the Build's copy), so a pid used
 * again since is never touched. → whether it was stopped
 */
async function stopLeftover(pgid, within, { run = execFile, waitMs = STOP_WAIT_MS, platform = process.platform } = {}) {
  if (platform === 'win32') return false; // no lsof to tell whether the pid is still that process
  if (!Number.isInteger(pgid) || pgid <= 1 || !alive(pgid)) return false;
  let base;
  try { base = fs.realpathSync(within); } catch { return false; }
  const cwd = await new Promise((resolve) => run('/usr/sbin/lsof', ['-a', '-p', String(pgid), '-d', 'cwd', '-Fn'], { timeout: 5000 }, (error, stdout) => {
    const line = error ? null : String(stdout).split('\n').find((entry) => entry.startsWith('n'));
    resolve(line ? line.slice(1) : null);
  }));
  if (!cwd || !(cwd === base || cwd.startsWith(`${base}${path.sep}`))) return false;
  if (!(await groupPids(pgid, { run })).includes(pgid)) return false;
  try { process.kill(-pgid, 'SIGTERM'); } catch { return false; }
  for (const until = Date.now() + waitMs; alive(pgid) && Date.now() < until;) await pause(100);
  try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
  return true;
}

/**
 * `environment`: what every process starts from (the app's, less what only the app or an agent session should have).
 * `extraEnvironment()`: added at each start (Engelbart's own Git while it stands in).
 */
function createProcesses({ environment = process.env, extraEnvironment = () => ({}), spawnProcess = spawn, fetcher = fetch, appAliveMs = APP_ALIVE_MS, uiReadyMs = UI_READY_MS, platform = process.platform, run = execFile } = {}) {
  const shell = resolveShell(environment);
  const owned = new Map(); // key → record

  function envFor(extra = {}) {
    // BROWSER=none: a dev server opens no browser of its own; the Stage shows it.
    return { ...sanitizeEnvironment(scrubAgentSession(environment)), ...extraEnvironment(), BROWSER: 'none', ...extra };
  }

  /** `command` started in `cwd` as `key`'s process (one running per key: an earlier one is stopped first). → the record */
  async function start(key, command, cwd, { env = {}, input = false } = {}) {
    await stop(key);
    const full = envFor(env);
    // Windows: a second command, so Git Bash forks the first as its child instead of becoming it (its exec leaves the
    // new process no parent, in Windows' list or its own), and the stop finds it under the shell (killTree).
    const line = platform === 'win32' ? `${command}\nexit $?` : command;
    const child = spawnProcess(shell, loginShellArgs(shell, line, full), { cwd, env: full, detached: true, windowsHide: true, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const record = { key, command, cwd, child, pid: child.pid, output: '', running: true, code: null, signal: null, startedAt: Date.now() };
    const take = (chunk) => { record.output = (record.output + chunk.toString()).slice(-OUTPUT_BYTES); };
    if (child.stdout) child.stdout.on('data', take);
    if (child.stderr) child.stderr.on('data', take);
    record.exited = new Promise((resolve) => {
      const done = (code, signal) => { if (!record.running) return; record.running = false; record.code = code; record.signal = signal || null; resolve(); };
      child.once('exit', done);
      child.once('error', (error) => { take(`\n${error.message}\n`); done(-1, null); });
    });
    owned.set(key, record);
    return record;
  }

  const kill = (record, signal) => { try { process.kill(-record.pid, signal); } catch { try { record.child.kill(signal); } catch { /* gone */ } } };

  /** Its whole process group stopped, and confirmed gone. → whether there was one running */
  async function stop(key) {
    const record = owned.get(key);
    if (!record) return false;
    owned.delete(key);
    if (!record.running) return false;
    if (platform === 'win32') { // its tree at once: once it has exited, its pid may be another process's
      if (record.pid) await killTree(record.pid, { run, shell });
      await Promise.race([record.exited, pause(STOP_WAIT_MS)]);
      return true;
    }
    kill(record, 'SIGTERM');
    const gone = await Promise.race([record.exited.then(() => true), pause(STOP_WAIT_MS).then(() => false)]);
    if (!gone) { kill(record, 'SIGKILL'); await Promise.race([record.exited, pause(2000)]); }
    kill(record, 'SIGKILL'); // what the leader left behind in its group
    return true;
  }

  const stopAll = async () => { await Promise.all([...owned.keys()].map((key) => stop(key))); };

  /** What the agent is shown of a process. */
  function status(key) {
    const record = owned.get(key);
    if (!record) return { running: false };
    return { running: record.running, pid: record.pid, exit_code: record.code, signal: record.signal, seconds: Math.round((Date.now() - record.startedAt) / 1000), output: record.output.slice(-8000) };
  }

  /** `command` run to its end (an install, a build, a terminal program's check): Engelbart's while it runs. → { code, output, timedOut } */
  async function runToExit(key, command, cwd, { timeoutMs = 120_000, signal, env = {} } = {}) {
    const record = await start(key, command, cwd, { env });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stop(key); }, timeoutMs);
    const abort = () => { void stop(key); };
    if (signal) signal.addEventListener('abort', abort, { once: true });
    try { await record.exited; } finally { clearTimeout(timer); if (signal) signal.removeEventListener('abort', abort); }
    if (owned.get(key) === record) owned.delete(key);
    return { code: timedOut ? null : record.code, output: record.output, timedOut };
  }

  /**
   * The check for a runnable just started as `key`. → { ok, url?, failed_check?, output } (`url`: where a UI is shown).
   * A terminal program is checked by running it (runToExit), not here.
   */
  async function check(key, type, { port = null, signal } = {}) {
    const record = owned.get(key);
    if (!record) return { ok: false, failed_check: 'The process is not running.', output: '' };
    if (type === 'app') {
      await Promise.race([record.exited, pause(appAliveMs, signal)]);
      if (signal && signal.aborted) return { ok: false, failed_check: 'Stopped.', output: record.output };
      if (!record.running) return { ok: false, failed_check: `It exited within ${appAliveMs / 1000} seconds (exit code ${record.code}${record.signal ? `, ${record.signal}` : ''}); a desktop app keeps running while its window is open.`, output: record.output };
      return { ok: true, output: record.output };
    }
    const until = Date.now() + uiReadyMs;
    while (Date.now() < until) {
      if (signal && signal.aborted) return { ok: false, failed_check: 'Stopped.', output: record.output };
      if (!record.running) return { ok: false, failed_check: `It exited (exit code ${record.code}${record.signal ? `, ${record.signal}` : ''}) before it answered on port ${port}.`, output: record.output };
      for (const host of ['127.0.0.1', '[::1]']) {
        if (await respondsAt(`http://${host}:${port}/`, fetcher).catch(() => false)) return { ok: true, url: `http://localhost:${port}/`, output: record.output };
      }
      await pause(500, signal);
    }
    return { ok: false, failed_check: `Nothing answered on port ${port} within ${uiReadyMs / 1000} seconds. It must listen on the port Engelbart gives it ({port} in its command), on localhost.`, output: record.output };
  }

  /** A running app's window brought to the front (`focus`: focusApp, or a stand-in). → whether one was */
  async function bringForward(key, focus = focusApp) {
    const record = owned.get(key);
    if (!record || !record.running) return false;
    return focus(await groupPids(record.pid));
  }

  return { start, stop, stopAll, status, runToExit, check, bringForward, running: (key) => !!(owned.get(key) && owned.get(key).running) };
}

module.exports = { createProcesses, freePort, focusApp, groupPids, killTree, stopLeftover, APP_ALIVE_MS, UI_READY_MS };
