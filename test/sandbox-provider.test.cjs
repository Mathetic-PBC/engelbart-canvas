'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../src/main/sandbox/worker.cjs');

const STATE = '/home/user/.engelbart-canvas';
const REQUEST = { run_id: 'provider-test', github_url: 'https://github.com/owner/app', environment: { values: { APP_SECRET: 'app-secret' }, removed: ['OLD'] } };

function fixture({ env = {}, prepare, setup, cleanup, apiError, onEvent } = {}) {
  const events = [], commands = [], files = new Map();
  const counts = { create: 0, kill: 0, prepare: 0, local: 0, api: 0 };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sandbox = {
    sandboxId: 'same-sandbox', getHost: () => 'preview.example',
    kill: async () => { counts.kill++; finish(); },
    files: { write: async (file, value) => files.set(file, value) },
    commands: { run: async (command, options) => {
      commands.push(command);
      if (command.includes('--reset-local')) {
        assert.ok(command.includes('--stop'));
        await cleanup?.();
        files.delete(`${STATE}/recipe.json`);
      }
      if (command === `python3 -u ${STATE}/launch.py`) {
        counts.api++;
        assert.equal(options.envs.ANTHROPIC_API_KEY, 'api-secret');
        assert.equal(files.has(`${STATE}/recipe.json`), false, 'old local recipe must not hijack API setup');
        assert.deepEqual(JSON.parse(files.get(`${STATE}/environment.json`)), REQUEST.environment, 'restore the app environment before API setup');
        options.onStdout(JSON.stringify(apiError ? { phase: 'error', message: apiError } : { phase: 'ready', port: 3000 }) + '\n');
        return { wait: () => done };
      }
      return { exitCode: 0 };
    } },
  };
  const runtime = createRuntime({
    Sandbox: { create: async () => { counts.create++; return sandbox; } },
    env: { E2B_API_KEY: 'e2b-secret', ANTHROPIC_API_KEY: 'api-secret', ...env },
    prepareClaude: async () => { counts.prepare++; return prepare ? prepare() : { file: 'claude', env: {} }; },
    localSetup: async (args) => {
      counts.local++;
      assert.equal(args.sandbox, sandbox);
      return setup ? setup({ ...args, files, done }) : { preview_url: 'https://preview.example/', port: 3000, done };
    },
    detectDocker: async () => false, checkPreview: async () => true,
    emit: (event) => { events.push(event); onEvent?.(event); if (event.event === 'ready') finish(); },
  });
  return { runtime, events, commands, counts, files };
}

test('default and explicit auto prefer the Claude subscription even when a fallback key exists', async () => {
  for (const env of [{}, { ENGELBART_SANDBOX_SETUP: 'auto' }, { ANTHROPIC_API_KEY: '' }]) {
    const f = fixture({ env });
    await f.runtime.run(REQUEST);
    assert.deepEqual(f.counts, { prepare: 1, local: 1, api: 0, create: 1, kill: 1 });
    assert.equal(f.events.find((event) => event.message === 'Preview verified').data.provider, 'claude-local');
    assert.equal(f.events.at(-1).event, 'stopped');
  }
});

test('default falls back before provisioning when Claude is missing, outdated or signed out', async () => {
  for (const reason of ['Claude Code not found', 'Claude Code needs an update', 'Subscription signed out']) {
    const f = fixture({ prepare: async () => { throw new Error(reason); } });
    await f.runtime.run(REQUEST);
    assert.deepEqual(f.counts, { prepare: 1, local: 0, api: 1, create: 1, kill: 1 });
    const fallback = f.events.findIndex((event) => event.data?.status === 'fallback');
    assert.ok(fallback < f.events.findIndex((event) => event.event === 'sandbox_created'));
    assert.match(f.events[fallback].message, /Falling back.*billed separately/);
    assert.equal(f.events[fallback].data.provider, 'api');
    assert.equal(f.events.at(-1).event, 'stopped');
  }
});

test('unavailable subscription without a fallback key fails before creating a VM', async () => {
  const f = fixture({ env: { ANTHROPIC_API_KEY: '' }, prepare: async () => { throw new Error('Subscription signed out'); } });
  await f.runtime.run(REQUEST);
  assert.equal(f.counts.create, 0);
  assert.equal(f.counts.api, 0);
  assert.match(f.events.at(-1).error, /Subscription signed out.*No ANTHROPIC_API_KEY/);
});

test('API override bypasses local Claude; it requires its own key', async () => {
  const f = fixture({ env: { ENGELBART_SANDBOX_SETUP: 'api' } });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.counts, { prepare: 0, local: 0, api: 1, create: 1, kill: 1 });
  const missing = fixture({ env: { ENGELBART_SANDBOX_SETUP: 'api', ANTHROPIC_API_KEY: '' } });
  await missing.runtime.run(REQUEST);
  assert.equal(missing.counts.create, 0);
  assert.equal(missing.counts.prepare, 0);
  assert.match(missing.events.at(-1).error, /Set ANTHROPIC_API_KEY/);
});

test('local setup failure switches once to API in the same VM, clears the recipe and restores env', async () => {
  let signal;
  const f = fixture({ setup: async (args) => {
    signal = args.signal;
    args.files.set(`${STATE}/recipe.json`, JSON.stringify({ kind: 'claude-local' }));
    args.files.delete(`${STATE}/environment.json`); // the first launch consumed it
    throw new Error('Usage limit reached: api-secret app-secret e2b-secret');
  } });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.counts, { prepare: 1, local: 1, api: 1, create: 1, kill: 1 });
  assert.equal(signal.aborted, true);
  assert.equal(f.commands.filter((command) => command.startsWith('git clone')).length, 1);
  assert.ok(f.commands.findIndex((command) => command.includes('--reset-local')) < f.commands.indexOf(`python3 -u ${STATE}/launch.py`));
  assert.equal(f.events.filter((event) => event.data?.status === 'fallback').length, 1);
  for (const secret of ['api-secret', 'app-secret', 'e2b-secret']) assert.ok(!JSON.stringify(f.events).includes(secret));
  assert.deepEqual(f.events.filter((event) => event.event !== 'progress').map((event) => event.event), ['sandbox_created', 'ready', 'stopped']);
});

test('failed cleanup blocks API handoff and stops the VM', async () => {
  const f = fixture({ setup: async () => { throw new Error('Local setup failed'); }, cleanup: async () => { throw new Error('Could not confirm app stopped'); } });
  await f.runtime.run(REQUEST);
  assert.equal(f.counts.api, 0);
  assert.equal(f.counts.kill, 1);
  assert.match(f.events.at(-1).error, /Could not confirm app stopped/);
});

test('strict local override or missing fallback key never invoke API after a local failure', async () => {
  for (const env of [{ ENGELBART_SANDBOX_SETUP: 'claude-local' }, { ANTHROPIC_API_KEY: '' }]) {
    const f = fixture({ env, setup: async () => { throw new Error('Subscription limit reached'); } });
    await f.runtime.run(REQUEST);
    assert.equal(f.counts.api, 0);
    assert.equal(f.counts.kill, 1);
    assert.equal(f.events.at(-1).event, 'failed');
    assert.match(f.events.at(-1).error, /Subscription limit reached/);
    assert.ok(!f.events.some((event) => event.data?.status === 'fallback'));
  }
});

test('Stop during sign-in or local setup does not fall back', async () => {
  for (const stage of ['prepare', 'setup']) {
    let f;
    f = fixture({ [stage]: async () => { await f.runtime.stop(); throw new Error('Interrupted'); } });
    await f.runtime.run(REQUEST);
    assert.equal(f.counts.api, 0);
    assert.equal(f.counts.create, stage === 'prepare' ? 0 : 1);
    assert.ok(!f.events.some((event) => event.data?.status === 'fallback'));
    assert.equal(f.events.at(-1).event, 'stopped');
  }
});

test('Stop during fallback cleanup prevents the API attempt', async () => {
  const f = fixture({ setup: async () => { throw new Error('Local failure'); }, cleanup: async () => f.runtime.stop() });
  await f.runtime.run(REQUEST);
  assert.equal(f.counts.api, 0);
  assert.equal(f.events.at(-1).event, 'stopped');
});

test('failure after a local preview is ready does not start API setup', async () => {
  let reject;
  const done = new Promise((_, no) => { reject = no; });
  const f = fixture({ setup: async () => ({ preview_url: 'https://preview.example/', port: 3000, done }),
    onEvent: (event) => { if (event.event === 'ready') reject(new Error('App exited')); } });
  await f.runtime.run(REQUEST);
  assert.equal(f.counts.api, 0);
  assert.match(f.events.at(-1).error, /App exited/);
});

test('failed API fallback ends the run without looping back to Claude', async () => {
  const f = fixture({ setup: async () => { throw new Error('Local failed'); }, apiError: 'API setup failed' });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.counts, { prepare: 1, local: 1, api: 1, create: 1, kill: 1 });
  assert.match(f.events.at(-1).error, /API setup failed/);
});
