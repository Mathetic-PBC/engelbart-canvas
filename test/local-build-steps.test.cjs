const test = require('node:test');
const assert = require('node:assert/strict');
const { collectBuildMilestones } = require('../src/shared/build-history.cjs');
const load = () => import('../src/renderer/model/canvas-build.js');
const at = seconds => new Date(Date.UTC(2026, 8, 24, 12, 0, seconds)).toISOString();
const event = (seconds, message, data, kind = 'status') => ({ id: `e${seconds}`, time: at(seconds), message, data, kind });
const base = { id: 'run', status: 'starting', sandbox_id: 'box' };
const history = () => [
  event(0, 'Creating sandbox'), event(2, 'Repository cloned', { lifecycle: 'cloned' }),
  event(3, 'npm ci', { phase: 'stage', stage: 'install' }, 'command'),
  event(4, 'Starting setup agent', { phase: 'agent', status: 'starting', provider: 'claude-local' }),
  event(5, 'Reading README.md', { phase: 'agent', status: 'working', tool: 'read_file' }),
  event(6, 'Planning the launch while installation runs.', { phase: 'agent', status: 'working' }),
];
const app = { status: 'healthy', running: true, process_count: 2,
  processes: [{ pid: 101, name: 'node' }, { pid: 102, name: 'node' }],
  listeners: [{ address: '0.0.0.0', port: 5173, ownership: 'owned', pids: [101] },
    { address: '::', port: 3001, ownership: 'owned', pids: [102] }],
  health: { ok: true, current: true, http_status: 200 } };
const byId = steps => Object.fromEntries(steps.map(step => [step.id, step]));

test('agent inspection stays active alongside installation without interrupting its clock', async () => {
  const { canvasBuildSteps } = await load();
  const rows = byId(canvasBuildSteps({ ...base, build_log: history() }));
  assert.equal(rows.plan, undefined, 'replace the empty legacy placeholder, not add an empty extra step');
  assert.equal(rows.agent.title, 'Setup agent');
  assert.equal(rows.agent.state, 'active');
  assert.equal(rows.agent.since, at(4));
  assert.equal(rows.start.state, 'active');
  assert.equal(rows.start.since, at(3));
  assert.deepEqual(rows.start.events.map(e => e.text), ['npm ci']);
  assert.deepEqual(rows.agent.events.map(e => e.text), history().slice(3).map(e => e.message));
  assert.equal(rows.services.summary, 'Not observed yet');
  assert.equal(rows.environment.summary, 'Requirements not scanned');
});

test('agent command output belongs to its details, not install output or Live', async () => {
  const { canvasBuildSteps } = await load();
  const log = [...history(),
    event(10, 'npm run generate', { phase: 'stage', stage: 'setup', actor: 'setup-agent' }, 'command'),
    event(11, 'Generated files\n', { phase: 'log', actor: 'setup-agent' }, 'stdout'),
    event(12, 'npm run dev', { phase: 'stage', stage: 'start' }, 'command'),
    event(15, 'Preview verified', { phase: 'check', status: 'ok' }), event(16, 'Preview ready'),
    event(18, 'The preview is ready.', { phase: 'agent', status: 'working' }),
    event(19, 'Setup agent finished', { phase: 'agent', status: 'done', elapsed_ms: 15000 }),
  ];
  const rows = byId(canvasBuildSteps({ ...base, status: 'ready', preview_url: 'https://preview.example', build_log: log }));
  assert.equal(rows.agent.state, 'done');
  assert.equal(rows.agent.elapsed, 15000);
  assert.equal(rows.agent.since, null);
  for (const message of ['npm run generate', 'Generated files\n', 'The preview is ready.']) {
    assert.ok(rows.agent.events.some(e => e.text === message));
    assert.ok(!rows.start.events.some(e => e.text === message));
    assert.ok(!rows.live.events.some(e => e.text === message));
  }
  assert.equal(rows.start.elapsed, 12000, 'agent narration does not steal elapsed time from install/start');
});

test('live preview does not fabricate agent completion or keep its timer running after a recorded outcome', async () => {
  const { canvasBuildSteps } = await load();
  const run = { ...base, status: 'ready', build_log: [...history(), event(10, 'Preview ready')] };
  let rows = byId(canvasBuildSteps(run));
  assert.equal(rows.agent.state, 'active');
  assert.equal(rows.agent.summary, 'Finishing setup summary…');
  run.build_log.push(event(20, 'Final summary unavailable', { phase: 'agent', status: 'summary_unavailable', elapsed_ms: 16000 }));
  rows = byId(canvasBuildSteps(run));
  assert.equal(rows.agent.state, 'warned');
  assert.equal(rows.agent.since, null);
  assert.equal(rows.agent.elapsed, 16000);
  assert.equal(rows.live.state, 'done');
});

test('agent failure is preserved during API fallback and does not replace the real API plan', async () => {
  const { canvasBuildSteps } = await load();
  const log = [...history(), event(10, 'Claude failed', { phase: 'agent', status: 'failed', elapsed_ms: 6000 })];
  let rows = byId(canvasBuildSteps({ ...base, status: 'failed', error: 'Claude failed', build_log: log }));
  assert.equal(rows.agent.state, 'failed');
  assert.equal(rows.agent.error, 'Claude failed');
  assert.equal(rows.start.state, 'skipped', 'agent failure is not evidence of a dependency-install failure');
  assert.equal(rows.start.durationUnknown, true);
  log.push(event(11, 'Using API fallback', { phase: 'setup', status: 'fallback', provider: 'api' }),
    event(12, 'API plan', { phase: 'plan', start: 'npm start' }), event(13, 'API setup', { phase: 'setup', status: 'working' }));
  rows = byId(canvasBuildSteps({ ...base, build_log: log }));
  assert.equal(rows.agent.state, 'warned');
  assert.equal(rows.plan.title, 'Run Plan');
  assert.ok(rows.start.events.some(e => e.text === 'API setup'));
  assert.ok(!rows.agent.events.some(e => e.text === 'API setup'));
});

test('valid service observations show ports/health without inventing service coverage or durations', async () => {
  const { canvasBuildSteps } = await load();
  const { stepDuration } = await import('../src/renderer/model/run-steps.js');
  const log = [...history(), event(10, 'Processes checked', { phase: 'app_status', app }), event(11, 'Preview ready')];
  const run = { ...base, status: 'ready', build_log: log };
  let rows = byId(canvasBuildSteps(run));
  assert.equal(rows.services.summary, '2 listening ports · Preview responding');
  assert.equal(rows.services.state, 'done');
  assert.equal(stepDuration(rows.services, Date.now()), null);
  const output = rows.services.events.map(e => e.text).join('\n');
  assert.match(output, /Process 101: node/);
  assert.match(output, /TCP 0\.0\.0\.0:5173 · owned by app/);
  assert.match(output, /3001/);
  assert.match(output, /not a complete service inventory/);
  run.status = 'stopped';
  rows = byId(canvasBuildSteps(run));
  assert.equal(rows.services.state, 'skipped');
  assert.match(rows.services.summary, /^Last observed:/);
  run.status = 'ready';
  log.push(event(15, 'Unhealthy', { phase: 'app_status', app: { ...app, status: 'unhealthy', health: { ok: false, current: true } } }));
  rows = byId(canvasBuildSteps(run));
  assert.equal(rows.services.state, 'warned');
  assert.match(rows.services.summary, /Preview not responding/);
});

test('unowned listeners and historical HTTP results never claim service readiness', async () => {
  const { canvasBuildSteps } = await load();
  const rows = byId(canvasBuildSteps({ ...base, build_log: [...history(), event(10, 'Conflict', { phase: 'app_status',
    app: { ...app, listeners: [{ address: '::', port: 5173, ownership: 'unowned' }], health: { ok: true, current: false } } })] }));
  assert.equal(rows.services.state, 'active');
  assert.doesNotMatch(rows.services.summary, /Preview responding|1 listening/);
  assert.match(rows.services.events[0].text, /not owned by app/);
});

test('applied environment names are not presented or persisted as a requirement scan', async () => {
  const { canvasBuildSteps } = await load();
  const { environmentReport } = require('../src/shared/environment.cjs');
  const data = { phase: 'environment', source: 'claude-local', status: 'applied', requirements_scan: 'not_run',
    provided_names: ['API_KEY', 'PORT'], removed_names: ['OLD_KEY'] };
  const rows = byId(canvasBuildSteps({ ...base, status: 'ready', build_log: [...history(), event(12, 'Saved values applied', data), event(15, 'Preview ready')] }));
  assert.equal(rows.environment.state, 'skipped');
  assert.equal(rows.environment.summary, '2 saved applied · Requirements not scanned');
  assert.match(rows.environment.events[0].text, /API_KEY, PORT/);
  assert.match(rows.environment.events[0].text, /OLD_KEY/);
  assert.equal(environmentReport(data, base.id, at(12)), null, 'injection must not overwrite a real requirement scan report');
});

test('legacy local-agent messages are regrouped conservatively and cannot claim an unrecorded outcome', async () => {
  const { canvasBuildSteps } = await load();
  const rows = byId(canvasBuildSteps({ ...base, status: 'ready', build_log: [
    event(1, 'Local Claude subscription', { phase: 'setup', status: 'starting', provider: 'claude-local' }),
    event(2, 'Reading launch files', { phase: 'setup', status: 'working' }),
    event(3, 'Installed', { phase: 'setup', stage: 'install', install_status: 'succeeded', status: 'working' }),
    event(4, 'Preview ready'), event(5, 'Ready to use', { phase: 'setup', status: 'working' }),
  ] }));
  assert.equal(rows.agent.state, 'skipped');
  assert.match(rows.agent.summary, /completion not recorded/);
  assert.equal(rows.agent.durationUnknown, true);
  assert.ok(rows.agent.events.some(e => e.text === 'Ready to use'));
  assert.deepEqual(rows.start.events.map(e => e.text), ['Installed']);
});

test('agent history, latest service evidence and environment application survive log rotation, then reset on restart', async () => {
  const { canvasBuildSteps, buildEvents } = await load();
  const log = [...history(),
    event(11, 'Applied', { phase: 'environment', source: 'claude-local', status: 'applied', provided_names: ['API_KEY'] }),
    event(12, 'Observed services', { phase: 'app_status', app }), event(13, 'Preview ready'),
    event(14, 'Agent finished', { phase: 'agent', status: 'done', elapsed_ms: 10000 }),
  ];
  const run = { ...base, status: 'ready', build_milestones: collectBuildMilestones(log), build_log: log };
  assert.equal(buildEvents(run).length, log.length, 'activity/milestone copies are deduplicated');
  run.build_log = [event(99, 'Routine app output', { phase: 'log' }, 'stdout')];
  let rows = byId(canvasBuildSteps(run));
  assert.equal(rows.agent.events.length, 4);
  assert.equal(rows.agent.state, 'done');
  assert.equal(rows.services.summary, '2 listening ports · Preview responding');
  assert.match(rows.environment.summary, /^1 saved applied/);
  run.status = 'starting';
  run.build_log.push(event(100, 'Restarting', { phase: 'setup', lifecycle: 'restart', status: 'reusing' }));
  rows = byId(canvasBuildSteps(run));
  assert.equal(rows.agent, undefined, 'restart does not run the setup agent again');
  assert.equal(rows.start.title, 'Restart application');
  assert.ok(!rows.environment.events.length);
});
