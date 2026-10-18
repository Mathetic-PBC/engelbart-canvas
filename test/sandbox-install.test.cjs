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

function fixture({ facts = FACTS, parallelFacts = FACTS, planError, stopError, stopGate, signal } = {}) {
  const events = [], calls = [], files = new Map(), jobs = [];
  const sandbox = {
    files: { write: async (file, value) => files.set(file, value), read: async () => new Response('# Read this while installing').body },
    commands: { run: async (command, options) => {
      calls.push(command);
      if (command.endsWith(' inspect')) return { exitCode: 0, stdout: JSON.stringify(facts) };
      if (command.includes('install-job.py plan')) {
        if (planError) throw Object.assign(new Error('Command exited with code 1'), { stderr: planError });
        return { exitCode: 0, stdout: JSON.stringify({ npmFacts: parallelFacts }) };
      }
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
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {}, startApp: async () => ({ started: true }) });
  try {
    assert.match((await tools('read_file', { path: 'README.md' })).content, /while installing/);
    assert.equal((await tools('list_files', {})).entries[0].name, 'README.md');
    for (const [name, args] of [['run_command', { command: 'npm ci' }], ['write_file', { path: 'package.json', content: '{}' }], ['start_app', { command: 'npm start', port: 3000 }]]) {
      await assert.rejects(tools(name, args), /installation is running/);
    }
    f.jobs[0].options.onStdout('install secret-value\rprogress\n');
    assert.match(f.install.status().output, /\[redacted\]/);
    assert.equal(f.jobs[0].options.envs.APP_KEY, 'secret-value');
    assert.equal(f.jobs[0].options.envs.npm_config_audit, 'false');
    assert.equal(f.jobs[0].options.envs.ANTHROPIC_API_KEY, undefined);
    assert.ok(f.jobs[0].options.envs.ENGELBART_CANVAS_INSTALL_JOB);
    const waiting = tools('dependency_install', { action: 'status', wait_seconds: 1 });
    f.jobs[0].resolve({ exitCode: 0 });
    assert.equal((await waiting).status, 'succeeded');
    assert.equal((await tools('start_app', { command: 'npm start', port: 3000 })).started, true);
    assert.ok(f.events.some((event) => event.install_status === 'succeeded' && event.exit_code === 0));
    assert.ok(!JSON.stringify(f.events).includes('secret-value'));
  } finally { await tools.close(); await f.install.close(); }
});

test('reads report installation finishing during inspection and permit an immediate guarded launch without another status call', async () => {
  const f = fixture();
  const initial = await f.install.prepare();
  let launches = 0;
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {},
    appState: () => ({ app: { status: 'idle', running: false } }),
    startApp: async () => { launches++; return { ready: true }; },
  });
  try {
    const listing = await tools('list_files', {});
    assert.equal(listing.dependency_install.status, 'running');
    assert.equal(listing.dependency_install.id, initial.install.id);
    f.sandbox.files.read = async () => {
      f.jobs[0].options.onStdout('secret-value dependency output');
      f.jobs[0].resolve({ exitCode: 0 });
      await tick();
      return new Response('launch instructions').body;
    };
    const read = await tools('read_file', { path: 'README.md' });
    assert.equal(read.content, 'launch instructions');
    assert.equal(read.app.status, 'idle');
    assert.equal(read.dependency_install.status, 'succeeded');
    assert.equal(read.dependency_install.exitCode, 0);
    assert.ok(read.dependency_install.finished_at);
    assert.equal(read.dependency_install.output, undefined, 'Do not repeat install output in every tool reply');
    assert.ok(!JSON.stringify(read).includes('secret-value'));
    assert.equal((await tools('start_app', { command: 'npm start', port: 3000 })).ready, true);
    assert.equal(launches, 1);
  } finally { await tools.close(); await f.install.close(); }
});

test('fresh failed-install snapshots do not relax the launch gate or hide the failure', async () => {
  const f = fixture();
  await f.install.prepare();
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {},
    startApp: () => assert.fail('A failed install must never launch'),
  });
  try {
    f.jobs[0].resolve({ exitCode: 1 });
    await tick();
    const read = await tools('read_file', { path: 'README.md' });
    assert.equal(read.dependency_install.status, 'failed');
    assert.equal(read.dependency_install.exitCode, 1);
    await assert.rejects(tools('start_app', { command: 'npm start', port: 3000 }), (error) => {
      assert.match(error.message, /has not succeeded/);
      assert.equal(error.dependency_install.status, 'failed');
      return true;
    });
  } finally { await tools.close(); await f.install.close(); }
});

test('a prepared launch waits for confirmed install success and starts in the same tool call', async () => {
  const f = fixture();
  await f.install.prepare();
  const launches = [];
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {},
    startApp: async (recipe) => { f.install.assertReady(); launches.push(recipe); return { ready: true }; },
  });
  try {
    const pending = tools('start_app', { command: 'npm start', cwd: '.', port: 3000, wait_for_install: true });
    await tick();
    assert.equal(launches.length, 0, 'The install must finish first');
    f.jobs[0].resolve({ exitCode: 0 });
    const result = await pending;
    assert.equal(result.ready, true);
    assert.equal(result.dependency_install.status, 'succeeded');
    assert.deepEqual(launches, [{ command: 'npm start', cwd: '.', port: 3000 }]);
  } finally { await tools.close(); await f.install.close(); }
});

test('a prepared launch never starts after install failure or unconfirmed cleanup', async () => {
  for (const stopError of [undefined, 'Install process still running']) {
    const f = fixture({ stopError });
    await f.install.prepare();
    const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {},
      startApp: () => assert.fail('No app may start after failure or incomplete cleanup'),
    });
    try {
      const pending = tools('start_app', { command: 'npm start', port: 3000, wait_for_install: true });
      const rejected = assert.rejects(pending, (error) => {
        assert.equal(error.dependency_install.status, stopError ? 'blocked' : 'failed');
        return true;
      });
      await tick();
      f.jobs[0].resolve({ exitCode: stopError ? 0 : 1 });
      await rejected;
    } finally {
      await tools.close();
      if (stopError) await assert.rejects(f.install.close(), /still running/);
      else await f.install.close();
    }
  }
});

test('stopping or aborting an install wait cancels the prepared launch', async () => {
  for (const abortWait of [false, true]) {
    const controller = new AbortController(), f = fixture({ signal: controller.signal });
    await f.install.prepare();
    const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, signal: controller.signal, onEvent() {},
      startApp: () => assert.fail('Stopped or aborted installs must not launch'),
    });
    try {
      const pending = tools('start_app', { command: 'npm start', port: 3000, wait_for_install: true });
      const rejected = assert.rejects(pending, abortWait ? /abort/i : /has not succeeded/);
      await tick();
      if (abortWait) controller.abort();
      else await f.install.control({ action: 'stop' });
      await rejected;
    } finally { await tools.close(); await f.install.close(); }
  }
});

test('an expired install wait leaves no delayed launch, even if installation later succeeds', async () => {
  let status = 'running', launches = 0;
  const install = {
    status: () => ({ status }),
    control: async (args) => { assert.deepEqual(args, { action: 'status', wait_seconds: 30 }); return { status }; },
    assertReady: () => { assert.equal(status, 'succeeded'); },
  };
  const tools = createSandboxTools({ sandbox: {}, install, onEvent() {}, startApp: async () => { launches++; return { ready: true }; } });
  try {
    await assert.rejects(tools('start_app', { command: 'npm start', port: 3000, wait_for_install: true }), /no app was started or queued/);
    status = 'succeeded';
    await tick();
    assert.equal(launches, 0);
    assert.equal((await tools('start_app', { command: 'npm start', port: 3000, wait_for_install: true })).ready, true);
    assert.equal(launches, 1);
  } finally { await tools.close(); }
});

test('closing tools while waiting prevents a prepared launch when installation finishes', async () => {
  const f = fixture();
  await f.install.prepare();
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {},
    startApp: () => assert.fail('Closed tools must not launch'),
  });
  const pending = tools('start_app', { command: 'npm start', port: 3000, wait_for_install: true });
  const rejected = assert.rejects(pending, /closed; no app was started/);
  await tick();
  const closed = tools.close();
  f.jobs[0].resolve({ exitCode: 0 });
  await Promise.all([rejected, closed]);
  await f.install.close();
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
  const pair = [{ manager: 'npm', cwd: 'frontend' }, { manager: 'pip', cwd: 'backend' }];
  for (const args of [
    { action: 'shell' }, { action: 'start' }, { action: 'start', command: 'npm ci', cwd: '/etc' },
    { action: 'start', command: 'npm ci', timeout_seconds: 601 }, { action: 'status', wait_seconds: 181 },
    { action: 'status', command: 'rm something' }, { action: 'skip', reason: ' ' }, { action: 'stop', reason: 'unused' },
    ...[null, {}, [], [pair[0]], [pair[0], pair[0]], [{ ...pair[0], cwd: '/etc' }, pair[1]],
      [{ ...pair[0], command: 'arbitrary shell' }, pair[1]]].map((parallel) => ({ action: 'start', parallel })),
    { action: 'start', parallel: pair, command: 'npm ci' }, { action: 'start', parallel: pair, cwd: '.' },
  ]) assert.throws(() => validateTool('dependency_install', args));
  assert.throws(() => validateTool('list_files', { path: '../../etc' }));
  assert.equal(validateTool('dependency_install', { action: 'start', command: 'npm ci' }).action, 'start');
  assert.deepEqual(validateTool('dependency_install', { action: 'start', parallel: pair }).parallel, pair);
});

test('parallel installs remain one managed job, with one readiness gate and confirmed replacement cleanup', async () => {
  const f = fixture({ facts: {} });
  await f.install.prepare();
  const pair = [{ manager: 'npm', cwd: 'frontend' }, { manager: 'pip', cwd: 'backend' }];
  const tools = createSandboxTools({ sandbox: f.sandbox, install: f.install, onEvent() {}, startApp: async () => ({ started: true }) });
  try {
    const started = await tools('dependency_install', { action: 'start', parallel: pair });
    assert.equal(started.status, 'running');
    assert.deepEqual(started.parallel, pair);
    assert.deepEqual(JSON.parse(f.files.get(`/home/user/.engelbart-canvas/install-${started.id}.json`)), { parallel: pair });
    assert.equal(f.jobs.length, 1);
    f.jobs[0].options.onStdout('[pip backend] Finished (exit 0)\n');
    assert.throws(() => f.install.assertReady(), /running/, 'one child finishing is not aggregate success');
    assert.match((await tools('read_file', { path: 'README.md' })).content, /while installing/);
    const replacement = await tools('dependency_install', { action: 'start', command: 'npm ci', cwd: 'frontend' });
    assert.notEqual(replacement.id, started.id);
    assert.equal(f.jobs[0].disconnected, true);
    assert.equal(f.jobs.length, 2);
    f.jobs[1].resolve({ exitCode: 0 });
    assert.equal((await tools('dependency_install', { action: 'status', wait_seconds: 1 })).status, 'succeeded');
  } finally { await tools.close(); await f.install.close(); }
});

test('parallel plan reuses runtime/script/workspace guards before launching either child', async () => {
  for (const packageChange of [{ workspaces: ['packages/*'] }, { engines: { node: '^18' } }, { scripts: { postinstall: 'custom bootstrap' } }]) {
    const f = fixture({ facts: {}, parallelFacts: { ...FACTS, package: { ...FACTS.package, ...packageChange } } });
    await f.install.prepare();
    const result = await f.install.control({ action: 'start', parallel: [{ manager: 'npm', cwd: 'frontend' }, { manager: 'pip', cwd: 'backend' }] });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /sequential agent inspection/);
    assert.equal(f.jobs.length, 0);
    assert.throws(() => f.install.assertReady(), /has not succeeded/);
    await f.install.close();
  }
});

test('remote parallel validation returns its specific reason with credentials redacted', async () => {
  const f = fixture({ facts: {}, planError: 'Shared parent manifests need inspection secret-value' });
  await f.install.prepare();
  const result = await f.install.control({ action: 'start', parallel: [{ manager: 'npm', cwd: 'frontend' }, { manager: 'pip', cwd: 'backend' }] });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Shared parent manifests/);
  assert.ok(!JSON.stringify(result).includes('secret-value'));
  assert.equal(f.jobs.length, 0);
  await f.install.close();
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

test('remote helper bounds inspection, fences delayed starts and confirms owned process-tree termination', { skip: process.platform === 'win32' && 'E2B sandbox helper: it runs in the sandbox\'s Linux, never on Windows, and needs POSIX Python (fcntl, os.killpg)' }, () => {
  const result = spawnSync('python3', [path.join(__dirname, 'sandbox_install_check.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
