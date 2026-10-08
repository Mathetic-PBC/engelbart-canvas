'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { runStore } = require('../src/main/sandbox/runs.cjs');

test.after(async () => {
  await db.closeAll();
});

test('sandbox runs belong to an existing library item and survive reopening', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sandbox-runs-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({
    id: randomUUID(), name: 'owner/app', type: 'website',
    url: 'https://github.com/owner/app', tags: ['git'],
  });
  assert.deepEqual(await library.query('select * from sandbox_runs'), [], 'adding a repo does not start a run');

  const insert = (libraryId) => library.query(
    'insert into sandbox_runs (id, library_id) values ($1, $2) returning *',
    [randomUUID(), libraryId],
  );
  await assert.rejects(() => insert(randomUUID()), { code: '23503' }, 'unknown library id');
  await assert.rejects(() => insert(null), { code: '23502' }, 'library id is required');
  const [first] = await insert(repo.id);
  assert.equal(first.status, 'starting');
  for (const key of ['sandbox_id', 'preview_url', 'port', 'error', 'finished_at']) assert.equal(first[key], null);
  assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.updated_at, first.created_at);

  await library.query(
    "update sandbox_runs set status = 'failed', error = 'Setup failed', updated_at = now(), finished_at = now() where id = $1",
    [first.id],
  );
  const [retry] = await insert(repo.id);
  await library.query(
    "update sandbox_runs set sandbox_id = 'sandbox-example', status = 'ready', preview_url = 'https://preview.example', port = 3000, updated_at = now() where id = $1",
    [retry.id],
  );
  await runStore(library).record(retry.id, 'Preview ready', { kind: 'status', data: { phase: 'ready' } });
  const runs = await library.query('select * from sandbox_runs order by created_at, id');
  const recorded = runs.find(run => run.id === retry.id);
  assert.equal(recorded.build_log[0].message, 'Preview ready');
  assert.deepEqual(recorded.build_log[0].data, { phase: 'ready' });
  assert.equal(runs.length, 2, 'multiple attempts can reference the same repository');
  assert.ok(runs.every((run) => run.library_id === repo.id));
  assert.deepEqual(await library.get(repo.id), repo, 'run changes do not edit the repository');
  await assert.rejects(() => library.remove(repo.id), /sandbox_runs_library_id_fkey/, 'deleting a repository must not silently discard sandbox handles');

  await library.close();
  const reopened = await db.openLibraryDb(root);
  assert.deepEqual(await reopened.query('select * from sandbox_runs order by created_at, id'), runs);
  assert.deepEqual(await reopened.get(repo.id), repo);
});

test('sandbox runs reject unsupported statuses and invalid ports', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sandbox-constraints-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'] });
  const insert = (status, port) => library.query(
    'insert into sandbox_runs (id, library_id, status, port) values ($1, $2, $3, $4)',
    [randomUUID(), repo.id, status, port],
  );
  await assert.rejects(() => insert('unknown', 3000), { code: '23514' });
  await assert.rejects(() => insert(null, 3000), { code: '23502' });
  for (const port of [0, -1, 65536]) await assert.rejects(() => insert('starting', port), { code: '23514' });
  for (const [status, port] of [['starting', null], ['ready', 1], ['failed', 65535], ['stopped', 3000]]) {
    await insert(status, port);
    await library.query("update sandbox_runs set status = 'stopped' where library_id = $1", [repo.id]);
  }
});

test('opening a library without sandbox_runs adds the table without changing existing items', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-sandbox-upgrade-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({
    id: randomUUID(), name: 'owner/existing', type: 'website',
    url: 'https://github.com/owner/existing', github_id: '123456789', tags: ['git'], categorized: 1,
  });
  // This isolated test database now has the schema used before sandbox runs were added.
  await library.query('drop table sandbox_runs');
  await library.close();

  const upgraded = await db.openLibraryDb(root);
  assert.deepEqual(await upgraded.get(repo.id), repo);
  assert.deepEqual(await upgraded.query('select * from sandbox_runs'), []);
  const indexes = await upgraded.query("select indexdef from pg_indexes where tablename = 'sandbox_runs'");
  assert.ok(indexes.some(({ indexdef }) => indexdef.includes('(library_id, created_at DESC)')));
  await assert.rejects(
    () => upgraded.query('insert into sandbox_runs (id, library_id) values ($1, $2)', [randomUUID(), randomUUID()]),
    { code: '23503' },
  );
});

test('lifecycle milestones persist independently of 300 runtime messages, including across restart and reopen', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-build-history-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'] });
  const store = runStore(library);
  const run = await store.create(repo.id);
  const record = (message, data, kind = 'status') => store.record(run.id, message, { data, kind });
  await record('Creating sandbox');
  await record('Repository cloned', { lifecycle: 'cloned' });
  await record('Discovering launch hints', { phase: 'plan', source: 'railpack', status: 'running' });
  await record('Launch hints ready', { phase: 'plan', source: 'railpack', status: 'ok', elapsed_ms: 2345 });
  await record('npm ci', { phase: 'stage', stage: 'install' }, 'command');
  await record('Dependency installation failed', { phase: 'setup', stage: 'install', status: 'failed', install_status: 'failed' });
  await record('npm ci --legacy-peer-deps', { phase: 'stage', stage: 'install' }, 'command');
  await record('Dependency installation succeeded', { phase: 'setup', stage: 'install', status: 'working', install_status: 'succeeded' });
  await record('Preview verified', { phase: 'check', status: 'ok' });
  await store.update(run.id, { status: 'ready', sandbox_id: 'test-sandbox', preview_url: 'https://preview.example', port: 3000 });
  const ready = await record('Preview ready');
  const milestones = ready.build_milestones;
  let latest;
  for (let i = 0; i < 310; i++) latest = await record('Application healthy', { phase: 'app_status', status: 'healthy' });
  assert.equal(latest.build_log.length, 300);
  assert.ok(latest.build_log.every(e => e.data.phase === 'app_status'));
  assert.deepEqual(latest.build_milestones, milestones);
  assert.equal(latest.build_log.at(-1).seq, ready.build_log.at(-1).seq + 310);
  const { canvasBuildSteps } = await import('../src/renderer/model/canvas-build.js');
  const steps = canvasBuildSteps(latest, repo.name);
  assert.equal(steps[0].summary, 'Sandbox running · cloned owner/app');
  assert.equal(steps[1].summary, 'Launch hints ready');
  assert.equal(steps[1].elapsed, 2345);
  assert.equal(steps[5].state, 'warned', 'the initial failure is not erased by success or log rotation');
  assert.equal(steps[6].state, 'done');
  assert.equal(steps[7].summary, 'Preview ready');
  assert.ok(steps.slice(0, 7).every(s => !s.events.some(e => e.data.phase === 'app_status')));

  await library.close();
  const reopened = await db.openLibraryDb(root);
  assert.deepEqual((await runStore(reopened).get(run.id)).build_milestones, milestones);
  await runStore(reopened).reopen(run.id, null);
  assert.deepEqual((await runStore(reopened).get(run.id)).build_milestones, {});
  await runStore(reopened).record(run.id, 'Restarting application', { data: { lifecycle: 'restart', phase: 'setup', status: 'reusing' } });
  await runStore(reopened).record(run.id, 'Restarted', { data: { phase: 'check', status: 'ok' } });
  await runStore(reopened).update(run.id, { status: 'ready' });
  await runStore(reopened).record(run.id, 'Preview ready');
  const restarted = canvasBuildSteps(await runStore(reopened).get(run.id));
  assert.equal(restarted[5].title, 'Restart application');
  assert.equal(restarted[5].state, 'done');
  assert.equal(restarted[5].error, null, 'a previous attempt failure does not taint its restart');
});

test('upgrade preserves available legacy milestones once without inventing discarded history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-build-history-upgrade-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'] });
  const run = await runStore(library).create(repo.id);
  const log = [
    { time: '2026-09-24T00:00:00Z', message: 'Preview verified', kind: 'status', data: { phase: 'check', status: 'ok' } },
    { time: '2026-09-24T00:00:01Z', message: 'Preview ready' },
    { time: '2026-09-24T00:00:02Z', message: 'Application healthy', data: { phase: 'app_status', status: 'healthy' } },
  ];
  await library.query('update sandbox_runs set build_log = $2::jsonb where id = $1', [run.id, JSON.stringify(log)]);
  await library.query('alter table sandbox_runs drop column build_milestones');
  await library.close();
  const upgraded = await db.openLibraryDb(root);
  const migrated = await runStore(upgraded).get(run.id);
  assert.deepEqual(migrated.build_log, log);
  assert.equal(Object.keys(migrated.build_milestones).length, 2);
  assert.equal(migrated.updated_at, run.updated_at);
  assert.deepEqual(await upgraded.get(repo.id), repo);
  await upgraded.close();
  const again = await db.openLibraryDb(root);
  assert.deepEqual(await runStore(again).get(run.id), migrated, 'backfill is idempotent');
});

test('repeated lifecycle messages retain bounded first/latest evidence and atomic sequence numbers', async () => {
  const { collectBuildMilestones } = require('../src/shared/build-history.cjs');
  const messages = Array.from({ length: 1000 }, (_, index) => ({ time: new Date(index).toISOString(), message: `Thinking ${index}`, data: { phase: 'setup', status: 'working' } }));
  const slots = Object.values(collectBuildMilestones(messages));
  assert.equal(slots.length, 1);
  assert.equal(slots[0].first.message, 'Thinking 0');
  assert.equal(slots[0].last.message, 'Thinking 999');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-build-history-sequence-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'] });
  const store = runStore(library);
  const run = await store.create(repo.id);
  await Promise.all(messages.slice(0, 20).map(e => store.record(run.id, e.message, { data: e.data })));
  const saved = await store.get(run.id);
  assert.deepEqual(saved.build_log.map(e => e.seq), Array.from({ length: 20 }, (_, i) => i + 1));
  const [slot] = Object.values(saved.build_milestones);
  assert.equal(slot.first.seq, 1);
  assert.equal(slot.last.seq, 20);
});

test('agent activity and valid service observations survive runtime output without an unbounded transcript', async () => {
  const { AGENT_LOG_LIMIT, collectBuildMilestones } = require('../src/shared/build-history.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-agent-history-'));
  const library = await db.openLibraryDb(root);
  const repo = await library.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'] });
  const store = runStore(library);
  const run = await store.create(repo.id);
  const record = (message, data, kind = 'status') => store.record(run.id, message, { data, kind });
  await record('Starting setup agent', { phase: 'agent', status: 'starting', provider: 'claude-local' });
  let latest;
  for (let i = 0; i < AGENT_LOG_LIMIT + 5; i++) latest = await record(`Agent activity ${i}`, { phase: 'agent', status: 'working' });
  assert.equal(latest.build_milestones['agent:activity'].entries.length, AGENT_LOG_LIMIT);
  assert.equal(latest.build_milestones['agent:activity'].entries[0].message, 'Agent activity 5');
  await record('Setup output\n', { phase: 'log', actor: 'setup-agent' }, 'stdout');
  await record('Agent finished', { phase: 'agent', status: 'done', elapsed_ms: 1200 });
  await record('Saved names applied', { phase: 'environment', source: 'claude-local', status: 'applied', provided_names: ['APP_KEY'] });
  await record('Services observed', { phase: 'app_status', app: { running: true, listeners: [{ port: 3000, ownership: 'owned' }] } });
  await record('Services checked again', { phase: 'app_status', app: { running: true, listeners: [{ port: 3000, ownership: 'owned' }, { port: 3001, ownership: 'owned' }] } });
  for (let i = 0; i < 301; i++) latest = await record(`App output ${i}\n`, { phase: 'log' }, 'stdout');
  assert.equal(latest.build_log.length, 300);
  const activity = latest.build_milestones['agent:activity'].entries;
  assert.equal(activity.length, AGENT_LOG_LIMIT);
  assert.equal(activity.at(-1).message, 'Agent finished');
  assert.equal(activity.at(-2).message, 'Setup output\n');
  assert.equal(latest.build_milestones['services:observed'].last.data.app.listeners.length, 2);
  assert.equal(latest.env_report, null, 'injection metadata is not a requirement scan');
  assert.ok(Object.values(latest.build_milestones).some(slot => slot.first?.message === 'Starting setup agent'));
  const collected = collectBuildMilestones(activity);
  assert.deepEqual(collected['agent:activity'].entries, activity);
  await library.close();
  const reopened = runStore(await db.openLibraryDb(root));
  assert.deepEqual((await reopened.get(run.id)).build_milestones, latest.build_milestones);
  await reopened.update(run.id, { status: 'ready' });
  await reopened.reopen(run.id, null);
  assert.deepEqual((await reopened.get(run.id)).build_milestones, {});
});
