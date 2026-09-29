'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { runNpmAudit } = require('../src/main/sandbox/npm-audit.cjs');
const { createRuntime } = require('../src/main/sandbox/worker.cjs');
const deferred = () => { let resolve; const promise = new Promise((yes) => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('background audit streams split structured reports without raw npm output or configuration writes', async () => {
  const events = [], files = [], controller = new AbortController();
  await runNpmAudit({ signal: controller.signal, onEvent: (event) => events.push(event), sandbox: {
    files: { write: async (name) => files.push(name) },
    commands: { run: async (command, options) => {
      assert.match(command, /npm-audit\.py$/);
      assert.equal(options.timeoutMs, 120_000);
      assert.equal(options.signal, controller.signal);
      options.onStdout('{"phase":"audit","status":"find');
      options.onStdout('ings","message":"npm audit: 2 high vulnerabilities"}\n');
      return { exitCode: 0 };
    } },
  } });
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith('/npm-audit.py'));
  assert.equal(events[0].status, 'findings');
  controller.abort();
  await assert.rejects(runNpmAudit({ signal: controller.signal, sandbox: {}, onEvent() {} }), /abort/i);
});

for (const provider of ['claude-local', 'api']) for (const failure of [false, true]) {
  test(`${provider}: deferred audit ${failure ? 'failure' : 'findings'} cannot delay or fail a verified preview`, async () => {
    const events = [], done = deferred(), auditStarted = deferred(), releaseAudit = deferred();
    let auditCalls = 0, auditSignal, kills = 0;
    const sandbox = {
      sandboxId: 'audit-test', getHost: () => 'preview.example', files: { write: async () => {} },
      kill: async () => { kills++; done.resolve(); },
      commands: { run: async (command, options) => {
        if (command.includes('python3 -u') && command.endsWith('/launch.py')) {
          assert.equal(options.envs.npm_config_audit, 'false');
          options.onStdout('{"phase":"ready","port":3000}\n');
          return { wait: () => done.promise };
        }
        return { exitCode: 0 };
      } },
    };
    const runtime = createRuntime({ Sandbox: { create: async () => sandbox },
      env: { E2B_API_KEY: 'fixture-api-key', ANTHROPIC_API_KEY: 'fixture-anthropic-key', ENGELBART_SANDBOX_SETUP: provider },
      detectDocker: async () => false, checkPreview: async () => true, prepareClaude: async () => ({}),
      localSetup: async () => {
        assert.equal(auditCalls, 0);
        return { preview_url: 'https://preview.example/', port: 3000, done: done.promise };
      }, emit: (event) => events.push(event),
      audit: async ({ signal, onEvent }) => {
        auditSignal = signal; auditCalls++;
        assert.equal(events.at(-1).event, 'ready');
        auditStarted.resolve();
        await releaseAudit.promise;
        if (failure) throw new Error('private registry failure fixture-api-key');
        onEvent({ phase: 'audit', status: 'findings', message: 'npm audit: 1 high vulnerability fixture-api-key' });
      },
    });
    const running = runtime.run({ run_id: 'audit-test', github_url: 'https://github.com/owner/app' });
    await auditStarted.promise;
    assert.ok(events.some((event) => event.event === 'ready'), 'readiness precedes even an unfinished audit');
    assert.equal(kills, 0);
    releaseAudit.resolve();
    await tick();
    const report = events.find((event) => event.data?.phase === 'audit');
    assert.equal(report.data.status, failure ? 'unavailable' : 'findings');
    assert.ok(!JSON.stringify(events).includes('fixture-api-key'));
    assert.ok(!events.some((event) => event.event === 'failed'));
    assert.equal(kills, 0);
    await runtime.stop();
    await running;
    assert.equal(auditSignal.aborted, true);
    assert.equal(auditCalls, 1);
  });
}

test('npm audit discovery, vulnerability exit codes, limits and non-mutating commands', () => {
  const result = spawnSync('python3', [path.join(__dirname, 'sandbox_audit_check.py')], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
