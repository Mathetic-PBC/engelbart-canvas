'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { redact, redactOutput } = require('./environment.cjs');
const ROOT = '/home/user/repository';
const STATE = '/home/user/.engelbart-canvas';
const HELPER = `${STATE}/install-job.py`;
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const active = new Set(['starting', 'running', 'stopping', 'blocked']);

// Conservative semver subset, not a guess: unsupported syntax defers to Claude.
function satisfies(version, range) {
  if (typeof version !== 'string' || !/^v?\d+\.\d+\.\d+$/.test(version) || typeof range !== 'string') return false;
  const actual = version.replace(/^v/, '').split('.').map(Number);
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  return range.split('||').some((alternative) => {
    const tokens = alternative.trim().replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1').split(/\s+/);
    return tokens.length > 0 && tokens.every((token) => {
      if (token === '*') return true;
      const match = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(token);
      if (!match) return false;
      const [, op = '', major, minor, patch] = match;
      const count = minor === undefined || /[x*]/i.test(minor) ? 1 : patch === undefined || /[x*]/i.test(patch) ? 2 : 3;
      if (count === 1 && patch !== undefined) return false;
      const low = [Number(major), count >= 2 ? Number(minor) : 0, count === 3 ? Number(patch) : 0];
      const high = count === 1 ? [low[0] + 1, 0, 0] : [low[0], low[1] + 1, 0];
      const diff = compare(actual, low);
      if (op === '>=') return diff >= 0;
      if (op === '>') return count === 3 ? diff > 0 : compare(actual, high) >= 0;
      if (op === '<') return diff < 0;
      if (op === '<=') return count === 3 ? diff <= 0 : compare(actual, high) < 0;
      if (op === '^') {
        const upper = low[0] || count === 1 ? [low[0] + 1, 0, 0] : low[1] || count === 2 ? [0, low[1] + 1, 0] : [0, 0, low[2] + 1];
        return diff >= 0 && compare(actual, upper) < 0;
      }
      if (op === '~') return diff >= 0 && compare(actual, high) < 0;
      return count === 3 ? diff === 0 : diff >= 0 && compare(actual, high) < 0;
    });
  });
}

function installPlan(facts) {
  const defer = (reason) => ({ status: 'needs_agent', reason });
  const pkg = facts.package;
  if (!pkg) return defer('No root Node manifest; choose the appropriate install directory and command.');
  if (pkg.workspaces || pkg.devEngines || facts.nestedManifests?.length || facts.scanTruncated || facts.files?.truncated) return defer('Workspace or multi-package layout needs agent inspection.');
  if (facts.customFiles?.length) return defer(`Custom setup/configuration needs inspection: ${facts.customFiles.join(', ')}.`);
  if (['preinstall', 'install', 'postinstall', 'prepare'].some((key) => pkg.scripts?.[key])) return defer('Root install lifecycle scripts may have prerequisites; inspect them before installing.');
  const managers = { 'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm', 'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun' };
  if (facts.lockfiles?.length !== 1) return defer('A single unambiguous lockfile is required for automatic installation.');
  const manager = managers[facts.lockfiles[0]];
  if (!manager) return defer('Unknown lockfile.');
  const versions = facts.versions || {};
  if (!versions.node || !versions[manager]) return defer('Required runtime or package manager is unavailable.');
  if (pkg.packageManager !== undefined) {
    const declared = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?$/i.exec(pkg.packageManager);
    if (!declared || declared[1] !== manager || !satisfies(versions[manager], declared[2])) return defer('Declared package manager/version does not match the available tool and lockfile.');
  }
  const runtime = [pkg.engines?.node, pkg.volta?.node, ...Object.values(facts.runtimeFiles || {})].filter((value) => value !== undefined);
  if (runtime.some((requirement) => !satisfies(versions.node, requirement))) return defer('Node runtime requirements need to be resolved before installing.');
  for (const requirement of [pkg.engines?.[manager], pkg.volta?.[manager]].filter((value) => value !== undefined)) {
    if (!satisfies(versions[manager], requirement)) return defer('Package-manager runtime requirements need to be resolved before installing.');
  }
  const command = { npm: 'npm ci', pnpm: 'pnpm install --frozen-lockfile',
    yarn: Number(versions.yarn?.replace(/^v/, '').split('.')[0]) >= 2 ? 'yarn install --immutable' : 'yarn install --frozen-lockfile',
    bun: 'bun install --frozen-lockfile' }[manager];
  return { status: 'planned', command, cwd: '.', manager };
}

function createDependencyInstall({ sandbox, environment = {}, secrets = [], signal, onEvent = () => {} }) {
  let current = null, initial = { status: 'needs_agent', reason: 'Preflight has not run.' }, facts = {}, closed = false;
  const emit = (event) => { if (!closed && !signal?.aborted) onEvent(redact(event, secrets)); };
  const snapshot = () => redact(current ? { id: current.id, status: current.status, command: current.command, cwd: current.cwd,
    ...(current.parallel ? { parallel: current.parallel } : {}),
    started_at: current.started_at, finished_at: current.finished_at || null, exitCode: current.exitCode ?? null,
    error: current.error || null, output: current.output } : initial, secrets);
  const event = (job) => emit({ phase: 'setup', status: ['failed', 'blocked'].includes(job.status) ? 'failed' : 'working', stage: 'install', job_id: job.id, install_status: job.status,
    exit_code: job.exitCode ?? null, duration_ms: Date.now() - job.startedMs, message: `Dependency installation ${job.status}${job.exitCode == null ? '' : ` (exit ${job.exitCode})`}${job.error ? `: ${job.error}` : ''}` });
  async function cleanup(job) {
    if (!job.cleanup) {
      job.cleanup = sandbox.commands.run(`python3 ${HELPER} stop ${job.id}`, { timeoutMs: 15_000, requestTimeoutMs: 20_000 })
        .then((result) => { if (result.exitCode !== 0) throw new Error('Could not confirm the dependency install stopped'); })
        .catch((error) => { job.cleanup = null; throw error; });
    }
    await job.cleanup;
  }
  function finish(job, status, error) {
    job.status = status; job.error = error ? redact(String(error.message || error), secrets).slice(-2000) : null;
    job.finished_at = status === 'blocked' ? null : new Date().toISOString();
    event(job); job.resolve();
  }
  async function completed(job, result, error) {
    if (!active.has(job.status) || job.stopping) return;
    job.exitCode = result?.exitCode ?? (Number.isInteger(error?.exitCode) ? error.exitCode : null);
    try {
      await cleanup(job); // also clears any orphaned package-manager children
      if (!job.stopping) finish(job, job.exitCode === 0 ? 'succeeded' : 'failed', error);
    } catch (failure) { if (!job.stopping) finish(job, 'blocked', failure); }
  }
  async function stop() {
    const job = current;
    if (!job || !active.has(job.status)) return snapshot();
    job.stopping = true; job.status = 'stopping';
    try {
      await cleanup(job);
      await job.handle?.disconnect().catch(() => {});
      finish(job, 'stopped');
    } catch (error) { finish(job, 'blocked', error); throw error; }
    return snapshot();
  }
  async function start({ command, cwd = '.', parallel, timeout_seconds = 600 }) {
    if (closed) throw new Error('Dependency installer is closed');
    signal?.throwIfAborted();
    if (parallel) {
      if (command !== undefined || cwd !== '.' || !Array.isArray(parallel) || parallel.length !== 2 ||
          parallel.some((item) => !item || typeof item.cwd !== 'string' || !['npm', 'pip'].includes(item.manager)) ||
          new Set(parallel.map((item) => item.manager)).size !== 2) throw new Error('Invalid parallel dependency install plan');
      command = `Parallel dependency installs: ${parallel.map((item) => `${item.manager} (${item.cwd})`).join(' + ')}`;
    }
    const target = path.posix.resolve(ROOT, cwd);
    if ((target !== ROOT && !target.startsWith(`${ROOT}/`)) || typeof command !== 'string' || !command.trim() || command.length > 8000 || command.includes('\0') || !Number.isInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 600) throw new Error('Invalid dependency install plan');
    await stop(); // a replacement is forbidden until its predecessor is gone
    signal?.throwIfAborted();
    const job = { id: randomUUID(), status: 'starting', command, cwd: target, parallel, output: '', startedMs: Date.now(), started_at: new Date().toISOString() };
    job.done = new Promise((resolve) => { job.resolve = resolve; });
    current = job;
    emit({ phase: 'stage', stage: 'install', status: 'running', job_id: job.id, command });
    try {
      const spec = `${STATE}/install-${job.id}.json`;
      await sandbox.files.write(spec, JSON.stringify(parallel ? { parallel } : { command, cwd: target }));
      await sandbox.commands.run(`chmod 600 ${spec}`, { timeoutMs: 10_000 });
      if (parallel) {
        let result;
        try { result = await sandbox.commands.run(`python3 ${HELPER} plan ${job.id}`, { timeoutMs: 20_000 }); }
        catch (error) { throw new Error(`Parallel install needs sequential agent inspection: ${String(error.stderr || error.message).slice(-2000)}`); }
        if (result.exitCode !== 0 || result.stdout.length > 64_000) throw new Error('Parallel install needs sequential agent inspection');
        const plan = installPlan(JSON.parse(result.stdout).npmFacts);
        if (plan.status !== 'planned' || plan.manager !== 'npm') throw new Error(`Parallel install needs sequential agent inspection: ${plan.reason || 'npm lockfile required'}`);
      }
      signal?.throwIfAborted();
      const receive = (stream) => (chunk) => {
        const safe = redactOutput(chunk, secrets);
        job.output = (job.output + safe).slice(-32_000);
        emit({ phase: 'log', stage: 'install', job_id: job.id, stream, text: safe.slice(-2000) });
      };
      job.handle = await sandbox.commands.run(`python3 -u ${HELPER} run ${job.id}`, {
        background: true, timeoutMs: timeout_seconds * 1000, requestTimeoutMs: 20_000,
        envs: { ...environment, npm_config_audit: 'false', ENGELBART_CANVAS_LOCAL_TOOL: '1', ENGELBART_CANVAS_INSTALL_JOB: job.id },
        onStdout: receive('stdout'), onStderr: receive('stderr'),
      });
      job.status = 'running';
      job.handle.wait().then((result) => completed(job, result), (error) => completed(job, null, error)).catch((error) => finish(job, 'blocked', error));
    } catch (error) { await completed(job, null, error); }
    return snapshot();
  }
  async function status(wait_seconds = 0) {
    const job = current;
    if (job && active.has(job.status) && wait_seconds) {
      let timer, abort;
      try {
        await Promise.race([job.done, new Promise((resolve) => {
          timer = setTimeout(resolve, wait_seconds * 1000);
          abort = resolve; signal?.addEventListener('abort', abort, { once: true });
        })]);
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }
    return snapshot();
  }
  function assertIdle() {
    if (current && active.has(current.status)) throw new Error(`Dependency installation is ${current.status}. Use read_file/list_files to inspect in parallel, or dependency_install action=stop before commands or file edits.`);
  }
  function assertReady() {
    assertIdle();
    if (!['succeeded', 'skipped'].includes(snapshot().status)) throw new Error('Dependency installation has not succeeded. Use dependency_install to start/retry it, or explicitly skip it with a reason after verifying no install is needed.');
  }
  async function prepare() {
    await sandbox.files.write(HELPER, fs.readFileSync(path.join(__dirname, 'install-job.py'), 'utf8'));
    try {
      const result = await sandbox.commands.run(`python3 ${HELPER} inspect`, { timeoutMs: 20_000 });
      if (result.exitCode !== 0 || result.stdout.length > 64_000) throw new Error('Preflight needs agent inspection');
      facts = JSON.parse(result.stdout);
      initial = installPlan(facts);
    } catch { initial = { status: 'needs_agent', reason: 'Automatic preflight was inconclusive; inspect the repository and choose an install plan.' }; }
    signal?.throwIfAborted();
    if (initial.status === 'planned') await start(initial);
    else emit({ phase: 'setup', status: 'working', message: initial.reason });
    return redact({ install: snapshot(), repository: facts }, secrets);
  }
  async function list(value = '.') {
    const result = await sandbox.commands.run(`python3 ${HELPER} list ${quote(value)}`, { timeoutMs: 10_000, signal });
    if (result.exitCode !== 0 || result.stdout.length > 64_000) throw new Error('Could not list repository files');
    return redact(JSON.parse(result.stdout), secrets);
  }
  async function control(args) {
    if (args.action === 'start') return start(args);
    if (args.action === 'stop') return stop();
    if (args.action === 'status') return status(args.wait_seconds);
    assertIdle();
    initial = { status: 'skipped', reason: args.reason, previous_status: snapshot().status }; current = null;
    emit({ phase: 'setup', status: 'working', stage: 'install', message: `Dependency installation skipped: ${args.reason}` });
    return snapshot();
  }
  return { prepare, control, list, assertIdle, assertReady, status: snapshot,
    async close() { closed = true; await stop(); } };
}

module.exports = { satisfies, installPlan, createDependencyInstall };
