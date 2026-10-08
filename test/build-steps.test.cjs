const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../src/renderer/model/canvas-build.js');
const at = (seconds) => new Date(Date.UTC(2026, 8, 21, 12, 0, seconds)).toISOString();
const entry = (seconds, message, data, kind = 'status') => ({ time: at(seconds), message, data, kind });
const base = { id: 'run', status: 'starting', sandbox_id: 'sandbox', build_log: [] };
const { collectBuildMilestones } = require('../src/shared/build-history.cjs');

test('time to live uses end-to-end wall time and freezes at the first verified preview', async () => {
  const { timeToLive } = await load();
  const run = { ...base, status: 'ready', created_at: at(0), updated_at: at(900), build_log: [
    entry(1, 'Starting repository setup'),
    entry(4, 'npm ci', { phase: 'stage', stage: 'install' }, 'command'),
    entry(6, 'Starting agent', { phase: 'agent', status: 'starting' }),
    entry(55, 'Preview verified', { phase: 'check', status: 'ok' }),
    entry(56, 'Preview ready'),
    entry(70, 'Agent finished', { phase: 'agent', status: 'done', elapsed_ms: 64000 }),
    entry(120, 'Preview ready'),
    entry(900, 'Application healthy', { phase: 'app_status' }),
  ] };
  assert.equal(timeToLive(run), 56000, 'neither overlapping step times nor final agent narration are added');
  run.status = 'stopped'; run.finished_at = at(1000);
  assert.equal(timeToLive(run), 56000, 'shutdown is not time to live');
  run.status = 'failed'; run.error = 'App exited after becoming live';
  assert.equal(timeToLive(run), 56000, 'retain the historical measurement after runtime failure');
});

test('time to live survives log rotation using durable lifecycle milestones', async () => {
  const { timeToLive } = await load();
  const history = [entry(0, 'Starting repository setup'), entry(84, 'Preview ready')];
  const run = { ...base, status: 'ready', created_at: at(0), build_milestones: collectBuildMilestones(history),
    build_log: [entry(900, 'Application output', { phase: 'log' }, 'stdout')] };
  assert.equal(timeToLive(run), 84000);
  delete run.created_at;
  assert.equal(timeToLive(run), 84000, 'an explicit setup-start event is also evidence');
});

test('time to live measures only the latest restart and stays hidden until that attempt is ready', async () => {
  const { timeToLive } = await load();
  const history = [entry(0, 'Starting repository setup'), entry(84, 'Preview ready'),
    entry(300, 'Restarting app', { lifecycle: 'restart', phase: 'setup', status: 'reusing' }),
  ];
  const run = { ...base, created_at: at(0), build_log: history };
  assert.equal(timeToLive(run), null);
  history.push(entry(307, 'Preview ready', { phase: 'ready' }));
  run.status = 'ready';
  assert.equal(timeToLive(run), 7000);
  run.build_milestones = collectBuildMilestones(history);
  run.build_log = [entry(900, 'App output')];
  assert.equal(timeToLive(run), 7000);
  run.status = 'starting';
  assert.equal(timeToLive(run), null, 'reopening a run must not briefly show an old measurement');
});

test('time to live never guesses from heartbeat/shutdown times, partial logs, or invalid timestamps', async () => {
  const { timeToLive } = await load();
  assert.equal(timeToLive(), null);
  const run = { ...base, status: 'ready', created_at: at(0), updated_at: at(900), finished_at: at(910) };
  assert.equal(timeToLive(run), null);
  assert.equal(timeToLive({ ...run, build_log: [entry(9, 'Preview verified', { phase: 'check', status: 'ok' })] }), null);
  assert.equal(timeToLive({ ...run, created_at: null, build_log: [entry(4, 'npm ci'), entry(9, 'Preview ready')] }), null);
  assert.equal(timeToLive({ ...run, created_at: 'invalid', build_log: [entry(9, 'Preview ready')] }), null);
  assert.equal(timeToLive({ ...run, created_at: at(10), build_log: [entry(9, 'Preview ready')] }), null);
  assert.equal(timeToLive({ ...run, build_log: [
    { time: null, message: 'Restarting', data: { lifecycle: 'restart' } }, entry(9, 'Preview ready'),
  ] }), null, 'a restart with no timestamp must not fall back to original creation');
  assert.equal(timeToLive({ ...run, build_log: [entry(0, 'Preview ready')] }), 0, 'a valid zero duration is not missing');
});

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

test('post-ready audit findings and unavailable reports remain readable logs, not build failures', async () => {
  const { canvasBuildSteps, buildEvents } = await load();
  const { terminalLines } = await import('../src/renderer/model/build-events.js');
  for (const status of ['findings', 'complete', 'unavailable', 'skipped']) {
    const run = { ...base, status: 'ready', preview_url: 'https://preview.example', build_log: [
      entry(0, 'npm ci', { stage: 'install' }, 'command'), entry(3, 'Preview ready'),
      entry(4, `npm audit: ${status}`, { phase: 'audit', status, message: `npm audit: ${status}` }),
    ] };
    const steps = canvasBuildSteps(run);
    assert.equal(steps[7].state, 'done');
    assert.equal(steps[7].summary, 'Preview ready');
    assert.ok(steps.every((step) => !step.error));
    assert.ok(buildEvents(run).some((event) => event.data.phase === 'audit'));
    assert.ok(terminalLines(buildEvents(run)).some((line) => line.text === `npm audit: ${status}`));
  }
});

test('build milestones survive a rolling tail full of live process snapshots', async () => {
  const { canvasBuildSteps, buildEvents } = await load();
  const { stepDuration } = await import('../src/renderer/model/run-steps.js');
  const history = [
    entry(0, 'Creating sandbox'), entry(2, 'Repository cloned', { lifecycle: 'cloned' }),
    entry(3, 'Discovering launch facts with Railpack', { phase: 'plan', source: 'railpack', status: 'running' }),
    entry(5, 'Launch hints discovered', { phase: 'plan', source: 'railpack', status: 'ok', elapsed_ms: 2000 }),
    entry(6, 'Using local Claude', { phase: 'setup', status: 'starting' }),
    entry(7, 'npm ci', { phase: 'stage', stage: 'install' }, 'command'),
    entry(20, 'Dependency installation succeeded', { phase: 'setup', stage: 'install', status: 'working', install_status: 'succeeded' }),
    entry(24, 'npm run dev', { phase: 'stage', stage: 'start' }, 'command'),
    entry(27, 'Checking preview', { phase: 'check', status: 'checking' }),
    entry(29, 'Preview verified', { phase: 'check', status: 'ok' }), entry(30, 'Preview ready'),
    entry(32, 'The app is ready', { phase: 'setup', status: 'working' }),
  ];
  const run = { ...base, status: 'ready', preview_url: 'https://preview.example', build_log: history,
    build_milestones: collectBuildMilestones(history) };
  const before = canvasBuildSteps(run, 'owner/app');
  assert.equal(buildEvents(run).length, history.length, 'milestone/log copies appear only once');
  run.build_log = Array.from({ length: 300 }, (_, i) => entry(50 + i, 'Application healthy · 9 owned processes', { phase: 'app_status', status: 'healthy' }));
  const after = canvasBuildSteps(run, 'owner/app');
  for (const index of [0, 1, 5, 6, 7]) {
    assert.equal(after[index].state, 'done');
    assert.equal(after[index].summary, before[index].summary);
    assert.equal(stepDuration(after[index], +new Date(at(500))), stepDuration(before[index], +new Date(at(40))));
    assert.equal(after[index].since, null, 'completed steps never keep ticking');
  }
  assert.equal(after[1].summary, 'Launch hints ready');
  assert.equal(after[1].elapsed, 2000);
  assert.equal(after[5].summary, 'Repository prepared');
  assert.equal(after[6].summary, 'The check passed');
  assert.equal(after[0].events.some(e => e.data.phase === 'app_status'), false);
  assert.equal(after[7].events.filter(e => e.data.phase === 'app_status').length, 300);
  assert.equal(after[7].events.some(e => e.text === 'The app is ready'), true);
});

test('old snapshot-only histories show unknown steps without fabricated durations or skipped work', async () => {
  const { canvasBuildSteps } = await load();
  const { stepDuration } = await import('../src/renderer/model/run-steps.js');
  const steps = canvasBuildSteps({ ...base, status: 'ready', updated_at: at(900), preview_url: 'https://preview.example',
    build_log: Array.from({ length: 300 }, (_, i) => entry(50 + i, 'Application healthy', { phase: 'app_status', status: 'healthy' })) });
  for (const step of steps.slice(0, 7)) {
    assert.equal(step.summary, 'Not recorded');
    assert.equal(step.events.length, 0);
    assert.equal(stepDuration(step, +new Date(at(1000))), null);
  }
  assert.equal(steps[7].summary, 'Preview ready');
  assert.equal(stepDuration(steps[7], +new Date(at(1000))), null, 'updated_at is not the ready timestamp');
});

test('Railpack discovery can run alongside installation without completing or interrupting its row', async () => {
  const { canvasBuildSteps } = await load();
  for (const installFirst of [false, true]) {
    const history = [
      entry(installFirst ? 0 : 1, 'npm ci', { phase: 'stage', stage: 'install' }, 'command'),
      entry(installFirst ? 1 : 0, 'Discovering launch facts', { phase: 'plan', source: 'railpack', status: 'running' }),
    ].sort((a, b) => a.time.localeCompare(b.time));
    const active = canvasBuildSteps({ ...base, build_log: history });
    assert.equal(active[1].state, 'active');
    assert.equal(active[5].state, 'active');
    history.push(entry(3, 'Launch hints discovered', { phase: 'plan', source: 'railpack', status: 'ok', elapsed_ms: 2100 }));
    const planned = canvasBuildSteps({ ...base, build_log: history });
    assert.equal(planned[1].state, 'done');
    assert.equal(planned[1].elapsed, 2100);
    assert.equal(planned[5].state, 'active');
    assert.equal(planned[5].since, at(installFirst ? 0 : 1));
  }
});

test('an unavailable Railpack hint is not a successful or failed build step', async () => {
  const { canvasBuildSteps } = await load();
  const steps = canvasBuildSteps({ ...base, status: 'ready', build_log: [
    entry(0, 'Discovery', { phase: 'plan', source: 'railpack', status: 'running' }),
    entry(2, 'Unavailable', { phase: 'plan', source: 'railpack', status: 'unavailable', elapsed_ms: 2000 }),
    entry(3, 'Using local Claude', { phase: 'setup', status: 'starting' }), entry(30, 'Preview ready'),
  ] });
  assert.equal(steps[1].state, 'skipped');
  assert.equal(steps[1].summary, 'Launch hints unavailable');
  assert.equal(steps[1].error, null);
});

test('restart milestones keep the current attempt boundary after its marker leaves the log tail', async () => {
  const { canvasBuildSteps, buildEvents } = await load();
  const history = [entry(0, 'Preview ready'),
    entry(20, 'Restarting app', { phase: 'setup', lifecycle: 'restart', status: 'reusing' }),
    entry(21, 'Starting saved command', { phase: 'stage', stage: 'start' }, 'command'),
    entry(24, 'Preview verified', { phase: 'check', status: 'ok' }), entry(25, 'Preview ready'),
  ];
  const run = { ...base, status: 'ready', build_milestones: collectBuildMilestones(history),
    build_log: [entry(60, 'Application healthy', { phase: 'app_status', status: 'healthy' })] };
  const steps = canvasBuildSteps(run);
  assert.equal(buildEvents(run).some(e => e.at === at(0)), false);
  assert.equal(steps[0].summary, 'Same sandbox and working files');
  assert.equal(steps[5].title, 'Restart application');
  assert.equal(steps[5].summary, 'Application restarted');
  assert.equal(steps[5].state, 'done');
});

test('milestone merging preserves repeated legacy output chunks and same-millisecond event order', async () => {
  const { buildEvents } = await load();
  const output = entry(0, 'chunk', { phase: 'log' }, 'stdout');
  assert.equal(buildEvents({ ...base, build_log: [output, output] }).length, 2);
  const events = [
    { ...entry(0, 'Creating sandbox'), id: 'a', seq: 1 },
    { ...entry(0, 'Repository cloned', { lifecycle: 'cloned' }), id: 'b', seq: 2 },
    { ...entry(0, 'Preview verified', { phase: 'check', status: 'ok' }), id: 'c', seq: 3 },
    { ...entry(0, 'Preview ready'), id: 'd', seq: 4 },
  ];
  const saved = Object.fromEntries(Object.entries(collectBuildMilestones(events)).reverse());
  const merged = buildEvents({ ...base, build_log: events.slice(-1), build_milestones: saved });
  assert.deepEqual(merged.map(e => e.text), ['creating', 'cloned', 'Preview verified', 'Preview ready']);
});

test('legacy string-only lifecycle events are also retained on upgrade', async () => {
  const { canvasBuildSteps } = await load();
  const history = [entry(0, 'Creating sandbox'), entry(1, 'trail · none'),
    entry(2, 'plan · done'), entry(3, 'setup · starting'), entry(20, 'setup · done'),
    entry(21, 'check · ok'), entry(22, 'Preview ready')];
  const saved = collectBuildMilestones(history);
  const steps = canvasBuildSteps({ ...base, status: 'ready', build_log: [], build_milestones: saved });
  assert.equal(steps[2].state, 'done');
  assert.equal(steps[5].summary, 'Repository prepared');
  assert.equal(steps[6].summary, 'The check passed');
  assert.equal(steps[7].summary, 'Ready');
});
