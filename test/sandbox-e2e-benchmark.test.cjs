'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAgentMetrics, phaseSummary } = require('../scripts/sandbox-diagnostics/agent-metrics.cjs');
const { safeSdk, verifyPublic, trial } = require('../scripts/benchmark-sandbox-e2e.cjs');
const { unionDuration } = require('../scripts/sandbox-diagnostics/summarize-e2e.cjs');

test('agent metrics retain timing/usage but never raw credentials, text, arguments or tool results', () => {
  let clock = 100;
  const metrics = createAgentMetrics(() => clock);
  const push = (event) => metrics.push(JSON.stringify(event) + '\n');
  push({ type: 'system', subtype: 'init', model: 'test-model', apiKey: 'SECRET', mcp_servers: [{ token: 'SECRET' }] });
  push({ type: 'assistant', message: { id: 'a', content: [
    { type: 'text', text: 'SECRET' }, { type: 'tool_use', id: 't', name: 'mcp__canvas__read_file', input: { token: 'SECRET' } },
  ] } });
  clock = 250;
  push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'SECRET' }] } });
  push({ type: 'result', subtype: 'success', result: 'SECRET', duration_ms: 150, duration_api_ms: 99,
    num_turns: 1, usage: { input_tokens: 10, output_tokens: 4, private: 'SECRET' } });
  metrics.finish();
  assert.equal(metrics.result.assistant_messages, 1);
  assert.deepEqual(metrics.result.models, ['test-model']);
  assert.equal(metrics.result.tool_calls[0].elapsed_ms, 150);
  assert.equal(metrics.result.cli_result.duration_api_ms, 99);
  assert.equal(JSON.stringify(metrics.result).includes('SECRET'), false);
});

test('phase summaries retain overlapping agent and install durations without inventing missing timestamps', () => {
  const events = [
    { elapsed_ms: 0, message: 'Checking local Claude subscription sign-in' },
    { elapsed_ms: 5, message: 'Creating sandbox' },
    { elapsed_ms: 20, event: 'sandbox_created' },
    { elapsed_ms: 21, message: 'Cloning repository' },
    { elapsed_ms: 50, data: { lifecycle: 'cloned' } },
    { elapsed_ms: 100, data: { phase: 'stage', stage: 'install', job_id: 'j', command: 'npm ci' } },
    { elapsed_ms: 200, data: { job_id: 'j', install_status: 'succeeded', duration_ms: 100, exit_code: 0 } },
    { elapsed_ms: 250, event: 'ready' },
  ];
  const summary = phaseSummary(events, { started_ms: 60, wall_ms: 185 });
  assert.equal(summary.auth_ms, 5);
  assert.equal(summary.clone_ms, 29);
  assert.equal(summary.installs[0].elapsed_ms, 100);
  assert.equal(summary.agent_wall_ms, 185);
  assert.equal(summary.first_start_to_ready_ms, null);
  assert.match(summary.note, /overlaps/);
});

test('simultaneous tool calls are counted as a union, not additive wall time', () => {
  assert.equal(unionDuration([[10,20],[15,30],[40,45],[undefined,50]]),25);
  assert.equal(unionDuration([]),0);
});

test('diagnostic SDK refuses existing-sandbox operations', () => {
  const sdk = safeSdk(() => 'fresh');
  assert.equal(sdk.create(), 'fresh');
  assert.throws(() => sdk.connect(), /existing/);
  assert.throws(() => sdk.list(), /user sandboxes/);
  assert.throws(() => sdk.kill(), /owned/);
});

test('independent public check requires successful HTML, not merely a responding error or JSON', async () => {
  assert.equal((await verifyPublic('https://fixture.example', async () => new Response('<!doctype html><html>OK</html>'))).ok, true);
  assert.equal((await verifyPublic('https://fixture.example', async () => new Response('{}'))).ok, false);
  assert.equal((await verifyPublic('https://fixture.example', async () => new Response('<html>Error</html>', { status: 500 }))).ok, false);
});

test('end-to-end harness cleans up only its new test sandbox on failure and passes no provider setting', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-e2e-unit-'));
  let killed = 0, createOptions;
  try {
    const result = await trial({ template: 'engelbart-runner', round: 1, directory, environment: { E2B_API_KEY: 'fixture' }, onCreated() {},
      signal: new AbortController().signal,
      sandboxApi: { create: async (_name, options) => {
        createOptions = options;
        return { sandboxId: 'test-owned-only', commands: { run: async () => { throw new Error('Test clone failure'); } },
          getInfo: async () => ({ cpuCount: 8, memoryMB: 8192, templateId: 'test' }),
          kill: async () => { killed++; } };
      } },
      runtimeFactory: ({ Sandbox, emit, env }) => {
        assert.equal(env.ENGELBART_SANDBOX_SETUP, undefined);
        assert.equal(env.E2B_TEMPLATE, 'engelbart-runner');
        let owned;
        return { run: async () => { owned = await Sandbox.create(env.E2B_TEMPLATE, {}); emit({ event: 'failed', error: 'Test clone failure' }); },
          stop: async () => { if (owned) { await owned.kill(); owned = null; } } };
      },
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.cleaned_up, true);
    assert.equal(killed, 1);
    assert.equal(createOptions.metadata.app, 'engelbart-e2e-benchmark');
    assert.equal(createOptions.metadata.runId, undefined);
    assert.equal(createOptions.metadata.canvasRunId, undefined);
    assert.equal(createOptions.timeoutMs, 20 * 60_000);
  } finally {
    for (const file of ['measurement.json', 'events.jsonl']) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  }
});
