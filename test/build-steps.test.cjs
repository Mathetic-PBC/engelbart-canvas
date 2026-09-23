const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/renderer/model/canvas-build.js');
const at = (seconds) => new Date(Date.UTC(2026, 8, 21, 12, 0, seconds)).toISOString();
const entry = (seconds, message, data, kind = 'status') => ({ time: at(seconds), message, data, kind });
const base = { id: 'run', status: 'starting', sandbox_id: 'sandbox', build_log: [] };

test('web build rows follow pipeline stages and expose only their own output', async () => {
  const { canvasBuildSteps } = await load();
  const run = { ...base, build_log: [
    entry(0, 'Creating sandbox'), entry(2, 'Repository cloned', { lifecycle: 'cloned' }),
    entry(3, 'Analyze', { phase: 'trail', status: 'none' }),
    entry(4, 'Plan', { phase: 'plan', source: 'railpack', start: 'npm start' }),
    entry(5, 'Services', { phase: 'supabase', status: 'skipped' }),
    entry(6, 'Environment', { phase: 'environment', variables: [], skipped: [] }),
    entry(7, 'npm ci', { phase: 'stage', stage: 'install' }, 'command'),
    entry(9, 'installed 10 packages', { phase: 'log', stage: 'install' }, 'stdout'),
  ] };
  const steps = canvasBuildSteps(run, 'owner/app');
  assert.deepEqual(steps.map((s) => s.title), ['Sandbox', 'Railpack', 'Run Plan', 'Services', 'Environment', 'Install and start', 'Health and repair', 'Live']);
  assert.match(steps[0].summary, /cloned owner\/app/);
  assert.match(steps[2].summary, /Runs npm start/);
  assert.equal(steps[3].state, 'skipped');
  assert.equal(steps[5].state, 'active');
  assert.deepEqual(steps[5].events.map((e) => e.kind), ['command', 'stdout']);
  assert.equal(steps[5].since, at(7));
  assert.equal(steps[6].state, 'waiting');
});

test('repair revisits activate and fail the actual current stage, and stop its clock', async () => {
  const { canvasBuildSteps } = await load();
  const run = { ...base, build_log: [
    entry(0, 'Plan', { phase: 'plan' }),
    entry(10, 'npm ci', { stage: 'install' }, 'command'),
    entry(20, 'Repairing', { phase: 'patch', status: 'starting' }),
    entry(30, 'npm ci', { stage: 'install' }, 'command'),
  ] };
  let steps = canvasBuildSteps(run);
  assert.equal(steps[5].state, 'active');
  assert.equal(steps[6].state, 'done');
  assert.equal(steps[5].elapsed, 10000);
  run.status = 'failed'; run.error = 'Dependency unavailable';
  run.build_log.push(entry(35, run.error, undefined, 'error'));
  steps = canvasBuildSteps(run);
  assert.equal(steps[5].state, 'failed');
  assert.match(steps[5].error, /Dependency unavailable/);
  assert.equal(steps[5].elapsed, 15000);
  assert.ok(steps.every((s) => !s.since));
});

test('preview checking is pending, ready becomes Live, and stopped never claims live', async () => {
  const { canvasBuildSteps } = await load();
  const run = { ...base, build_log: [entry(0, 'Verifying live preview', { phase: 'check', status: 'checking' })] };
  let steps = canvasBuildSteps(run);
  assert.equal(steps[6].summary, 'Verifying live preview…');
  assert.equal(steps[6].state, 'active');
  run.status = 'ready'; run.preview_url = 'https://preview.example';
  run.build_log.push(entry(2, 'Preview ready'));
  steps = canvasBuildSteps(run);
  assert.equal(steps[7].state, 'done');
  assert.equal(steps[7].summary, 'Preview ready');
  assert.equal(steps[6].summary, 'The check passed');
  run.status = 'stopped'; run.build_log.push(entry(10, 'Sandbox stopped'));
  steps = canvasBuildSteps(run);
  assert.equal(steps[7].summary, 'Stopped');
  assert.ok(steps.every((s) => !s.since));
});

test('restart timeline does not reuse the previous Live state or claim another install', async () => {
  const { canvasBuildSteps } = await load();
  const run = { ...base, build_log: [entry(0, 'Preview ready'), entry(3, 'Restarting app', { phase: 'setup', lifecycle: 'restart', status: 'reusing' })] };
  const steps = canvasBuildSteps(run);
  assert.equal(steps[7].state, 'waiting');
  assert.equal(steps[5].title, 'Restart application');
  assert.equal(steps[0].summary, 'Same sandbox and working files');
  assert.equal(run.build_log.length, 2, 'the persisted history is kept');
});

test('pending, legacy, and truncated builds remain readable without inventing evidence', async () => {
  const { canvasBuildSteps } = await load();
  assert.ok(canvasBuildSteps().every((s) => s.state === 'waiting'));
  const legacy = { ...base, status: 'ready', build_log: [entry(0, 'Installing dependencies…'), entry(3, 'Preview ready')] };
  const steps = canvasBuildSteps(legacy);
  assert.equal(steps[5].events.length, 1);
  assert.equal(steps[2].summary, 'Not recorded');
  assert.equal(steps[6].summary, 'Not recorded');
  const failed = canvasBuildSteps({ ...base, status: 'failed', error: 'Missing credentials' });
  assert.equal(failed[0].state, 'failed');
  assert.match(failed[0].error, /Missing credentials/);
  const ready = canvasBuildSteps({ ...base, status: 'ready', updated_at: at(10), preview_url: 'https://preview.example' });
  assert.equal(ready[7].summary, 'Preview ready');
  assert.equal(ready[7].state, 'done');
});

test('a failed setup remains a warning after a later health check recovers the run', async () => {
  const { canvasBuildSteps } = await load();
  const run = { ...base, status: 'ready', preview_url: 'https://preview.example', build_log: [
    entry(0, 'Starting setup', { phase: 'setup', status: 'starting' }),
    entry(109, 'Setup failed', { phase: 'setup', status: 'failed', reason: 'Missing package: example' }),
    entry(110, 'Repairing', { phase: 'patch', status: 'starting' }),
    entry(111, 'Application did not start', { phase: 'start', status: 'failed', reason: 'Port unavailable' }),
    entry(112, 'Preview verified', { phase: 'check', status: 'ok' }),
    entry(113, 'Preview ready'),
  ] };
  const steps = canvasBuildSteps(run);
  assert.equal(steps[5].state, 'warned');
  assert.equal(steps[5].summary, 'Initial setup failed');
  assert.equal(steps[5].error, 'Missing package: example');
  assert.equal(steps[6].state, 'done');
  assert.equal(steps[6].summary, 'The check passed');
  assert.equal(steps[7].state, 'done');
  assert.equal(steps[7].summary, 'Preview ready');
  assert.equal(run.preview_url, 'https://preview.example');
});

test('a successful retry does not erase the recorded setup failure', async () => {
  const { canvasBuildSteps } = await load();
  const steps = canvasBuildSteps({ ...base, status: 'ready', build_log: [
    entry(0, 'Failed', { phase: 'setup', status: 'failed', output: 'Dependency missing' }),
    entry(2, 'Done', { phase: 'setup', status: 'done' }), entry(3, 'Preview ready'),
  ] });
  assert.equal(steps[5].state, 'warned');
  assert.equal(steps[5].summary, 'Recovered after setup failure');
  assert.equal(steps[5].error, 'Dependency missing');
});

test('working, restart, fallback, and unknown setup statuses never fabricate failure', async () => {
  const { canvasBuildSteps } = await load();
  for (const status of ['starting', 'working', 'reusing', 'replaying', 'fallback', 'unknown']) {
    const steps = canvasBuildSteps({ ...base, build_log: [entry(0, 'Setup activity', { phase: 'setup', status })] });
    assert.equal(steps[5].state, 'active', status);
    assert.doesNotMatch(steps[5].summary, /failed/i, status);
    assert.equal(steps[5].error, null);
  }
});

test('explicit setup errors stay on their own failed step; stderr alone is not an outcome', async () => {
  const { canvasBuildSteps } = await load();
  const steps = canvasBuildSteps({ ...base, status: 'failed', error: 'Install failed', build_log: [
    entry(0, 'Setup', { phase: 'setup', status: 'starting' }),
    entry(3, 'Install failed', { phase: 'error', step: 'setup' }, 'error'),
  ] });
  assert.equal(steps[5].state, 'failed');
  assert.equal(steps[6].state, 'waiting');
  const ready = canvasBuildSteps({ ...base, status: 'ready', build_log: [
    entry(0, 'npm ci', { stage: 'install' }, 'command'),
    entry(1, 'npm WARN optional dependency skipped', { phase: 'log', stage: 'install' }, 'stderr'),
    entry(3, 'Preview ready'),
  ] });
  assert.equal(ready[5].state, 'done');
  assert.equal(ready[5].error, null);
});

test('latest health outcome takes precedence without treating unknown checks as failures', async () => {
  const { canvasBuildSteps } = await load();
  for (const [last, expected] of [['ok', 'The check passed'], ['checking', 'Verifying live preview…'], ['unrecognized', 'Verifying live preview…']]) {
    const steps = canvasBuildSteps({ ...base, build_log: [
      entry(0, 'Failed', { phase: 'start', status: 'failed' }),
      entry(1, 'Check', { phase: 'check', status: last }),
    ] });
    assert.equal(steps[6].state, 'active');
    assert.equal(steps[6].summary, expected);
  }
});

test('later pipeline stages do not give success checks to unresolved explicit plan or health failures', async () => {
  const { canvasBuildSteps } = await load();
  const steps = canvasBuildSteps({ ...base, status: 'ready', preview_url: 'https://preview.example', build_log: [
    entry(0, 'Plan rejected', { phase: 'error', step: 'plan' }, 'error'),
    entry(1, 'Preparing', { phase: 'setup', status: 'starting' }),
    entry(2, 'Health repair failed', { phase: 'error', step: 'run' }, 'error'),
    entry(3, 'Preview ready'),
  ] });
  assert.equal(steps[2].state, 'warned');
  assert.equal(steps[2].error, 'Plan rejected');
  assert.equal(steps[6].state, 'warned');
  assert.equal(steps[6].error, 'Health repair failed');
  assert.equal(steps[7].state, 'done');
});
