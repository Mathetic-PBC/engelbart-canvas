'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime } = require('../src/main/sandbox/worker.cjs');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');

// Setup is the local Claude Code subscription's, and nothing else's (2026-10-03): no Anthropic API key, no hc setup.
const STATE = '/home/user/.engelbart-canvas';
const REQUEST = { run_id: 'provider-test', github_url: 'https://github.com/owner/app', environment: { values: { APP_SECRET: 'app-secret' }, removed: ['OLD'] } };
const HC_SETUP = `python3 -u ${STATE}/launch.py`;

function fixture({ env = {}, prepare, setup, onEvent } = {}) {
  const events = [], commands = [];
  const counts = { create: 0, kill: 0, prepare: 0, local: 0 };
  let finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sandbox = {
    sandboxId: 'same-sandbox', getHost: () => 'preview.example', setTimeout: async () => {},
    kill: async () => { counts.kill++; finish(); },
    files: { write: async () => {} },
    commands: { run: async (command) => { commands.push(command); return { exitCode: 0 }; } },
  };
  const runtime = createRuntime({
    Sandbox: { create: async () => { counts.create++; return sandbox; } },
    env: { E2B_API_KEY: 'e2b-secret', ...env },
    prepareClaude: async () => { counts.prepare++; return prepare ? prepare() : { file: 'claude', env: {} }; },
    localSetup: async (args) => {
      counts.local++;
      assert.equal(args.sandbox, sandbox);
      return setup ? setup({ ...args, done }) : { preview_url: 'https://preview.example/', port: 3000, done };
    },
    detectDocker: async () => false, checkPreview: async () => true, audit: async () => {},
    emit: (event) => { events.push(event); onEvent?.(event); if (event.event === 'ready') finish(); },
  });
  const hc = () => commands.filter((command) => command.startsWith(HC_SETUP));
  return { runtime, events, commands, counts, hc };
}

test('setup is always the Claude subscription\'s, even with an Anthropic key or the old provider setting around', async () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: 'api-secret' }, { ENGELBART_SANDBOX_SETUP: 'api', ANTHROPIC_API_KEY: 'api-secret' }]) {
    const f = fixture({ env });
    await f.runtime.run(REQUEST);
    assert.deepEqual(f.counts, { prepare: 1, local: 1, create: 1, kill: 1 });
    assert.deepEqual(f.hc(), []);
    assert.equal(f.events.find((event) => event.message === 'Preview verified').data.provider, 'claude-local');
    assert.ok(!JSON.stringify(f.events).includes('api-secret'));
    assert.equal(f.events.at(-1).event, 'stopped');
  }
});

test('the sandbox configuration no longer reads an Anthropic key, a provider choice or hc model settings', () => {
  const values = readSandboxEnv('/nonexistent-engelbart-root', { ANTHROPIC_API_KEY: 'sk-ant', ENGELBART_SANDBOX_SETUP: 'api', HC_SETUP_MODEL: 'x', HC_SETUP_BUDGET_USD: '1',
    E2B_TEMPLATE: 'engelbart-runner', ENGELBART_SANDBOX_CLAUDE_MODEL: 'claude-sonnet-5-5' });
  assert.equal(values.ANTHROPIC_API_KEY, undefined);
  assert.equal(values.ENGELBART_SANDBOX_SETUP, undefined);
  assert.equal(values.HC_SETUP_MODEL, undefined);
  assert.equal(values.E2B_TEMPLATE, 'engelbart-runner');
  assert.equal(values.ENGELBART_SANDBOX_CLAUDE_MODEL, 'claude-sonnet-5-5');
});

test('Claude Code missing, outdated or signed out fails before any sandbox is made, with what to do', async () => {
  for (const reason of ['Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it).', 'Update Claude Code to 2.1.248 or newer for restricted sandbox setup.',
    'Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in).']) {
    const f = fixture({ env: { ANTHROPIC_API_KEY: 'api-secret' }, prepare: async () => { throw new Error(reason); } });
    await f.runtime.run(REQUEST);
    assert.deepEqual(f.counts, { prepare: 1, local: 0, create: 0, kill: 0 });
    assert.deepEqual([f.events.at(-1).event, f.events.at(-1).error], ['failed', reason]);
    assert.ok(!f.events.some((event) => event.data?.status === 'fallback'));
  }
});

test('a local setup failure ends the run failed, short, with the sandbox killed, and never starts hc', async () => {
  const f = fixture({ env: { ANTHROPIC_API_KEY: 'api-secret' }, setup: async () => { throw new Error('Claude finished without a verified web preview. app-secret e2b-secret'); } });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.counts, { prepare: 1, local: 1, create: 1, kill: 1 });
  assert.deepEqual(f.hc(), []);
  assert.ok(!f.commands.some((command) => command.includes('--reset-local')));
  assert.equal(f.events.at(-1).event, 'failed');
  assert.equal(f.events.at(-1).error, 'Claude finished without a verified web preview. [redacted] [redacted] Retry from build details.');
  assert.ok(!f.events.some((event) => event.data?.status === 'fallback'));
  assert.deepEqual(f.events.filter((event) => event.event !== 'progress').map((event) => event.event), ['sandbox_created', 'failed']);
});

test('Stop during sign-in or local setup stops; it never becomes another setup', async () => {
  for (const stage of ['prepare', 'setup']) {
    let f;
    f = fixture({ [stage]: async () => { await f.runtime.stop(); throw new Error('Interrupted'); } });
    await f.runtime.run(REQUEST);
    assert.equal(f.counts.create, stage === 'prepare' ? 0 : 1);
    assert.deepEqual(f.hc(), []);
    assert.equal(f.events.at(-1).event, 'stopped');
  }
});

test('failure after a local preview is ready does not start another setup', async () => {
  let reject;
  const done = new Promise((_, no) => { reject = no; });
  const f = fixture({ setup: async () => ({ preview_url: 'https://preview.example/', port: 3000, done }),
    onEvent: (event) => { if (event.event === 'ready') reject(new Error('App exited')); } });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.hc(), []);
  assert.equal(f.counts.local, 1);
  assert.match(f.events.at(-1).error, /App exited/);
});

test('early readiness is emitted once and a late summary failure leaves the app alone', async () => {
  const f = fixture({ setup: async ({ onReady, done }) => {
    onReady({ preview_url: 'https://preview.example/', port: 3000, done });
    throw new Error('Late summary failed');
  } });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.hc(), []);
  assert.equal(f.events.filter(e => e.event === 'ready').length, 1);
  assert.equal(f.events.at(-1).event, 'stopped');
});

test('early-ready app exit interrupts Claude finalization and still reports the application failure', async () => {
  let fail;
  const done = new Promise((_, reject) => { fail = reject; });
  const f = fixture({ setup: async ({ onReady, signal }) => {
    onReady({ preview_url: 'https://preview.example/', port: 3000, done });
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    signal.throwIfAborted();
  }, onEvent: e => { if (e.event === 'ready') fail(new Error('App crashed while finalizing')); } });
  await f.runtime.run(REQUEST);
  assert.deepEqual(f.hc(), []);
  assert.match(f.events.at(-1).error, /App crashed while finalizing/);
});
