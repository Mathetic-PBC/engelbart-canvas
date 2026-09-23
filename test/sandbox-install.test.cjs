'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { installPlan, satisfies, createDependencyInstall } = require('../src/main/sandbox/local-install.cjs');
const { createSandboxTools, validateTool } = require('../src/main/sandbox/local-tools.cjs');
const { runLocalSetup } = require('../src/main/sandbox/local-setup.cjs');

const FACTS = { package: { name: 'app', engines: { node: '>=20' }, scripts: { dev: 'vite' } }, lockfiles: ['package-lock.json'], versions: { node: 'v22.15.0', npm: '10.9.0' } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture({ facts = FACTS, stopError, stopGate, signal } = {}) {
  const events = [], calls = [], files = new Map(), jobs = [];
  const sandbox = {
    files: { write: async (file, value) => files.set(file, value), read: async () => new Response('# Read this while installing').body },
    commands: { run: async (command, options) => {
      calls.push(command);
      if (command.endsWith(' inspect')) return { exitCode: 0, stdout: JSON.stringify(facts) };
      if (command.includes('install-job.py list')) return { exitCode: 0, stdout: JSON.stringify({ entries: [{ name: 'README.md', type: 'file' }] }) };
      if (command.includes('install-job.py stop')) {
        await stopGate?.promise;
        if (stopError) throw new Error(stopError);
        return { exitCode: 0 };
      }
      if (command.includes('install-job.py run')) {
        const end = deferred();
        const job = { ...end, options, command, disconnected: false };
        jobs.push(job);
        return { wait: () => end.promise, disconnect: async () => { job.disconnected = true; end.reject(new Error('Stream disconnected')); } };
      }
      return { exitCode: 0, stdout: '' };
    } },
  };
  const install = createDependencyInstall({ sandbox, signal, onEvent: (event) => events.push(event), environment: { APP_KEY: 'secret-value' }, secrets: ['secret-value'] });
  return { sandbox, install, events, calls, files, jobs };
}

test('automatic plans respect one lockfile, package-manager pins and available versions', () => {
  assert.deepEqual(installPlan(FACTS), { status: 'planned', command: 'npm ci', cwd: '.', manager: 'npm' });
  for (const [lock, manager, version, command] of [
    ['pnpm-lock.yaml', 'pnpm', '9.15.0', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn', '1.22.22', 'yarn install --frozen-lockfile'],
    ['yarn.lock', 'yarn', '4.5.0', 'yarn install --immutable'],
    ['bun.lock', 'bun', '1.2.3', 'bun install --frozen-lockfile'],
    ['npm-shrinkwrap.json', 'npm', '10.9.0', 'npm ci'],
  ]) {
    const plan = installPlan({ ...FACTS, lockfiles: [lock], package: { ...FACTS.package, packageManager: `${manager}@${version}` }, versions: { node: '22.15.0', [manager]: version } });
    assert.equal(plan.command, command);
  }
});

test('ambiguous layouts, scripts, configuration, versions and absent manifests defer without guessing', () => {
  for (const change of [
    { package: undefined }, { lockfiles: [] }, { lockfiles: ['yarn.lock', 'package-lock.json'] }, { versions: {} },
    { nestedManifests: ['client/package.json'] }, { scanTruncated: true }, { files: { truncated: true } },
    { customFiles: ['.npmrc'] }, { runtimeFiles: { '.nvmrc': '18' } }, { runtimeFiles: { '.node-version': 'lts/*' } },
    ...[{ workspaces: ['packages/*'] }, { devEngines: {} }, { scripts: { postinstall: 'node bootstrap.js' } },
      { packageManager: 'pnpm@9.15.0' }, { packageManager: 'npm@9.0.0' }, { packageManager: 'npm@latest' },
      { engines: { node: '^18' } }, { engines: { npm: '>=11' } }, { volta: { node: '20.0.0' } }].map((packageChange) => ({ package: { ...FACTS.package, ...packageChange } })),
  ]) assert.equal(installPlan({ ...FACTS, ...change }).status, 'needs_agent', JSON.stringify(change));
});

test('runtime matching is conservative and handles common supported semver ranges', () => {
  for (const [version, range, expected] of [
    ['22.15.0', '>=20', true], ['22.15.0', '>=18 <23', true], ['22.15.0', '^22.0.0', true],
    ['22.15.0', '~22.14.0', false], ['22.15.0', '22.x', true], ['22.15.0', '18 || >=20', true],
    ['22.15.0', '22.15.0', true], ['22.15.0', '20', false], ['22.15.0', '<=22', true],
    ['22.15.0', '>22', false], ['0.2.5', '^0.2.0', true], ['0.3.0', '^0.2.0', false],
    ['0.0.4', '^0.0.3', false], ['22.15.0', 'lts/*', false], ['22.15.0', '', false],
    ['22.15.0', '>=20; echo unsafe', false], ['22.15.0-beta', '>=20', false],
  ]) assert.equal(satisfies(version, range), expected, `${version} ${range}`);
});

test('managed installation starts before agent work, streams redacted logs and leaves read-only tools available', async () => {
  const f = fixture();
  const initial = await f.install.prepare();
  assert.equal(initial.install.status, 'running');
  assert.equal(f.jobs.length, 1);
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {}, startApp: async () => 'started' });
  try {
    assert.match((await tools('read_file', { path: 'README.md' })).content, /while installing/);
    assert.equal((await tools('list_files', {})).entries[0].name, 'README.md');
    for (const [name, args] of [['run_command', { command: 'npm ci' }], ['write_file', { path: 'package.json', content: '{}' }], ['start_app', { command: 'npm start', port: 3000 }]]) {
      await assert.rejects(tools(name, args), /installation is running/);
    }
    f.jobs[0].options.onStdout('install secret-value\rprogress\n');
    assert.match(f.install.status().output, /\[redacted\]/);
    assert.equal(f.jobs[0].options.envs.APP_KEY, 'secret-value');
    assert.equal(f.jobs[0].options.envs.ANTHROPIC_API_KEY, undefined);
    assert.ok(f.jobs[0].options.envs.ENGELBART_CANVAS_INSTALL_JOB);
    const waiting = tools('dependency_install', { action: 'status', wait_seconds: 1 });
    f.jobs[0].resolve({ exitCode: 0 });
    assert.equal((await waiting).status, 'succeeded');
    assert.equal(await tools('start_app', { command: 'npm start', port: 3000 }), 'started');
    assert.ok(f.events.some((event) => event.install_status === 'succeeded' && event.exit_code === 0));
    assert.ok(!JSON.stringify(f.events).includes('secret-value'));
  } finally { await tools.close(); await f.install.close(); }
});

test('an inconclusive preflight does not install; the agent can start a custom job or explicitly skip', async () => {
  const f = fixture({ facts: {} });
  assert.equal((await f.install.prepare()).install.status, 'needs_agent');
  assert.equal(f.jobs.length, 0);
  assert.throws(() => f.install.assertReady(), /has not succeeded/);
  const started = await f.install.control({ action: 'start', command: 'python3 -m pip install -r requirements.txt', cwd: 'server' });
  assert.equal(started.cwd, '/home/user/repository/server');
  assert.equal(started.status, 'running');
  await assert.rejects(f.install.control({ action: 'skip', reason: 'not needed' }), /installation is running/);
  await f.install.control({ action: 'stop' });
  assert.throws(() => f.install.assertReady(), /has not succeeded/);
  const skipped = await f.install.control({ action: 'skip', reason: 'Verified preinstalled dependencies' });
  assert.equal(skipped.previous_status, 'stopped');
  f.install.assertReady();
  await f.install.close();
});

test('replacement installation waits for confirmed stop, then starts exactly one new job', async () => {
  const gate = deferred(), f = fixture({ stopGate: gate });
  await f.install.prepare();
  const replacing = f.install.control({ action: 'start', command: 'npm ci --ignore-scripts' });
  await tick();
  assert.equal(f.install.status().status, 'stopping');
  assert.equal(f.jobs.length, 1);
  assert.throws(() => f.install.assertIdle(), /stopping/);
  gate.resolve();
  assert.equal((await replacing).status, 'running');
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[0].disconnected, true);
  assert.ok(f.calls.findIndex((call) => call.includes('install-job.py stop')) < f.calls.findLastIndex((call) => call.includes('install-job.py run')));
  await f.install.close();
});

test('unconfirmed stop blocks replacement and all mutations instead of pretending the install ended', async () => {
  const f = fixture({ stopError: 'remote process still running' });
  await f.install.prepare();
  await assert.rejects(f.install.control({ action: 'start', command: 'npm ci' }), /still running/);
  assert.equal(f.jobs.length, 1);
  assert.equal(f.install.status().status, 'blocked');
  assert.throws(() => f.install.assertIdle(), /blocked/);
  await assert.rejects(f.install.close(), /still running/);
});

test('failed and timed-out installs retain output and require retry or an explicit skip before preview', async () => {
  for (const error of [Object.assign(new Error('Install failed: secret-value'), { exitCode: 1 }), new Error('Command timed out')]) {
    const f = fixture();
    await f.install.prepare();
    f.jobs[0].options.onStderr('meaningful error\n');
    f.jobs[0].reject(error);
    const result = await f.install.control({ action: 'status', wait_seconds: 1 });
    assert.equal(result.status, 'failed');
    assert.match(result.output, /meaningful error/);
    assert.ok(!result.error.includes('secret-value'));
    assert.throws(() => f.install.assertReady(), /has not succeeded/);
    f.install.assertIdle();
    assert.ok(f.events.some((event) => event.status === 'failed' && event.install_status === 'failed'));
    await f.install.close();
  }
});

test('abort interrupts a status wait and cleanup confirms remote stop without launching a replacement', async () => {
  const abort = new AbortController(), f = fixture({ signal: abort.signal });
  await f.install.prepare();
  const waiting = f.install.control({ action: 'status', wait_seconds: 180 });
  abort.abort();
  await waiting;
  await f.install.close();
  assert.equal(f.install.status().status, 'stopped');
  assert.equal(f.jobs[0].disconnected, true);
  assert.equal(f.jobs.length, 1);
  await assert.rejects(f.install.control({ action: 'start', command: 'npm ci' }), /closed/);
});

test('install tools validate action-specific fields, paths and bounded waits', () => {
  for (const args of [
    { action: 'shell' }, { action: 'start' }, { action: 'start', command: 'npm ci', cwd: '/etc' },
    { action: 'start', command: 'npm ci', timeout_seconds: 601 }, { action: 'status', wait_seconds: 181 },
    { action: 'status', command: 'rm something' }, { action: 'skip', reason: ' ' }, { action: 'stop', reason: 'unused' },
  ]) assert.throws(() => validateTool('dependency_install', args));
  assert.throws(() => validateTool('list_files', { path: '../../etc' }));
  assert.equal(validateTool('dependency_install', { action: 'start', command: 'npm ci' }).action, 'start');
});

test('real setup starts managed install before Claude, allows parallel reads over MCP, and stops it before returning failure', async () => {
  const f = fixture();
  let readWhileRunning = false;
  await assert.rejects(runLocalSetup({ sandbox: f.sandbox, auth: {}, environment: { values: {}, removed: [] }, onEvent() {}, checkPreview: async () => true,
    runAgent: async ({ bridge, prompt }) => {
      assert.equal(f.jobs.length, 1);
      assert.match(prompt, /"status":"running"/);
      const call = async (name, args) => (await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name, args }) })).json();
      assert.equal((await call('read_file', { path: 'README.md' })).isError, undefined);
      assert.equal((await call('list_files', {})).isError, undefined);
      assert.equal((await call('write_file', { path: 'package.json', content: '{}' })).isError, true);
      readWhileRunning = !f.jobs[0].disconnected;
      throw new Error('Agent stopped');
    },
  }), /Agent stopped/);
  assert.equal(readWhileRunning, true);
  assert.equal(f.jobs[0].disconnected, true);
  assert.ok(f.calls.some((call) => call.includes('install-job.py stop')));
});

test('remote helper bounds inspection, fences delayed starts and confirms owned process-tree termination', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'sandbox_install_check.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
