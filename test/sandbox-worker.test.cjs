'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntime, safePreview } = require('../src/main/sandbox/worker.cjs');
const { launchWorker } = require('../src/main/sandbox/transport.cjs');

test('worker waits for persisted sandbox ID, streams split JSON events, verifies preview and cleans up', async () => {
  const events = [], commands = [];
  let ack = false, kills = 0, finish;
  const exited = new Promise((resolve) => { finish = resolve; });
  const sandbox = {
    sandboxId: 'sb-test', getHost: () => 'preview.example', kill: async () => { kills++; finish(); },
    files: { write: async () => {} },
    commands: { async run(command, options) {
      assert.ok(ack, 'sandbox must be persisted before any commands');
      commands.push(command);
      if (command.includes('/launch.py') && !command.includes('--stop') && !command.includes('--check')) {
        options.onStdout('{"phase":"stage","stage":"install","command":"npm ci","status":"installing"}\n{"phase":"rea');
        options.onStdout('dy","port":3000,"url":"http://localhost:3000/app"}\n');
        return { wait: () => exited };
      }
      return { exitCode: 0 };
    } },
  };
  const runtime = createRuntime({
    Sandbox: { create: async (_template, options) => {
      assert.equal(options.metadata.canvasRunId, 'run-test');
      assert.equal(options.metadata.runId, undefined, 'web worker must not adopt or sweep Canvas sandboxes');
      return sandbox;
    } }, env: { E2B_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', ENGELBART_SANDBOX_SETUP: 'api' },
    detectDocker: async () => false, waitForAck: async () => { assert.equal(events.at(-1).event, 'sandbox_created'); ack = true; },
    checkPreview: async (url) => { assert.equal(url, 'https://preview.example/app'); return true; },
    emit(event) { events.push(event); if (event.event === 'ready') finish(); },
  });
  await runtime.run({ run_id: 'run-test', github_url: 'https://github.com/owner/app' });
  assert.deepEqual(events.filter((event) => ['sandbox_created', 'ready', 'stopped'].includes(event.event)).map((event) => event.event), ['sandbox_created', 'ready', 'stopped']);
  assert.ok(commands[0].startsWith('git clone'));
  assert.ok(commands.some((command) => command.includes('/opt/engelbart/proxy.mjs')));
  assert.equal(kills, 1);
  const install = events.find((event) => event.kind === 'command');
  assert.equal(install.message, 'npm ci');
  assert.equal(install.data.stage, 'install');
  assert.equal(install.data.phase, 'stage');
  assert.ok(events.some((event) => event.data?.lifecycle === 'cloned'));
  assert.ok(events.some((event) => event.data?.phase === 'check'));
});

test('restart reconnects without cloning/installing; configuration failures keep the sandbox', async () => {
  const commands = [], files = [], events = [];
  let kills = 0;
  const sandbox = { sandboxId: 'existing', setTimeout: async () => {}, kill: async () => { kills++; },
    files: { write: async (name, value) => files.push({ name, value }) },
    commands: { async run(command, options) {
      commands.push(command);
      if (command.includes('--restart')) {
        options.onStdout('{"phase":"error","message":"Invalid app settings"}\n');
        return { wait: async () => {} };
      }
      return { exitCode: 0 };
    } },
  };
  const runtime = createRuntime({ Sandbox: { connect: async (id) => { assert.equal(id, 'existing'); return sandbox; }, create: () => assert.fail('must reuse sandbox') },
    env: { E2B_API_KEY: 'test' }, emit: (event) => events.push(event),
    prepareClaude: () => assert.fail('environment restart must not check Claude sign-in'),
    localSetup: () => assert.fail('environment restart must not run setup'),
  });
  await runtime.run({ command: 'restart', sandbox_id: 'existing', run_id: 'run-test', github_url: 'https://github.com/owner/app', environment: { values: { NEW: 'new' }, removed: ['OLD'] } });
  assert.equal(kills, 0);
  assert.ok(!commands.some((command) => /git clone|npm install/.test(command)));
  assert.ok(commands.findIndex((command) => command.includes('--stop')) < commands.findIndex((command) => command.includes('--restart')));
  assert.deepEqual(JSON.parse(files.find((file) => file.name.endsWith('environment.json')).value), { values: { NEW: 'new' }, removed: ['OLD'] });
  assert.equal(events.at(-1).event, 'failed');
  await runtime.stop();
  assert.equal(kills, 0, 'disconnect after a failed restart must not kill the retained sandbox');
});

test('clone failure kills the sandbox and reports failure', async () => {
  const events = [];
  let killed = false;
  const runtime = createRuntime({
    Sandbox: { create: async () => ({ sandboxId: 'sb-test', kill: async () => { killed = true; }, commands: { run: async () => { throw new Error('Repository not found'); } } }) },
    env: { E2B_API_KEY: 'test', ANTHROPIC_API_KEY: 'test', ENGELBART_SANDBOX_SETUP: 'api' }, detectDocker: async () => false, emit: (event) => events.push(event),
  });
  await runtime.run({ run_id: 'run-test', github_url: 'https://github.com/owner/missing' });
  assert.equal(killed, true);
  assert.equal(events.at(-1).event, 'failed');
  assert.match(events.at(-1).error, /Repository not found/);
});

test('probe distinguishes missing sandboxes from network failures', async () => {
  const runtime = createRuntime({ Sandbox: { getInfo: async () => { throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  assert.deepEqual(await runtime.probe({ sandbox_id: 'gone' }), { state: 'gone' });
  const offline = createRuntime({ Sandbox: { getInfo: async () => { throw new Error('timeout'); } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  await assert.rejects(() => offline.probe({ sandbox_id: 'maybe' }), /timeout/);
  assert.throws(() => safePreview('file:///etc/passwd'));
});

test('probe recovers a sandbox created before its ID reached the database', async () => {
  const runtime = createRuntime({ Sandbox: { list(options) {
    assert.deepEqual(options.query.metadata, { canvasRunId: 'interrupted-run', app: 'engelbart-canvas' });
    return { nextItems: async () => [{ sandboxId: 'sb-recovered' }] };
  } }, env: { E2B_API_KEY: 'test' }, emit() {} });
  assert.deepEqual(await runtime.probe({ run_id: 'interrupted-run' }), { state: 'interrupted', sandbox_id: 'sb-recovered' });
});

test('real worker transport delivers configuration failure without network or secrets', async () => {
  const events = [];
  const worker = launchWorker({ run_id: 'no-credentials', command: 'start', github_url: 'https://github.com/owner/app' }, {}, (event) => events.push(event));
  await worker.done;
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'failed');
  assert.match(events[0].error, /E2B_API_KEY/);
});
