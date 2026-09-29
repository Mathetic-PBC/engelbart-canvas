'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { createSandboxManager } = require('../src/main/sandbox/manager.cjs');
const { runStore } = require('../src/main/sandbox/runs.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-run-manager-'));
  const ctx = { root, dataRoot: root, libraryDb: await db.openLibraryDb(root) };
  const events = [], starts = [], controls = [];
  let probe = { state: 'ready' };
  const manager = createSandboxManager({ secure: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }, notify: (event) => events.push(event), readEnv: () => ({}), launch(request, env, receive) {
    if (!['start', 'restart'].includes(request.command)) {
      controls.push(request);
      const done = Promise.resolve().then(() => {
        if (probe instanceof Error && ['probe', 'can_restart'].includes(request.command)) throw probe;
        return receive({ run_id: request.run_id, event: 'result', ...(request.command === 'kill' ? { state: 'gone' } : probe) });
      });
      return { done, stop: () => done };
    }
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const worker = { request, receive: (event) => receive({ run_id: request.run_id, ...event }), finish, done, async detach() { finish(); }, async stop() { await this.receive({ event: 'stopped' }); finish(); } };
    starts.push(worker);
    return worker;
  } });
  t.after(async () => { await manager.dispose(); await ctx.libraryDb.close(); });
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), name: 'owner/app', type: 'website', url: 'https://github.com/owner/app', tags: ['git'] });
  return { ctx, manager, events, starts, controls, repo, store: runStore(ctx.libraryDb), setProbe(value) { probe = value; } };
}

test('duplicate starts reuse one run; progress, persistence, ready and stop preserve library row', async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.manager.start(f.ctx, f.repo.id), f.manager.start(f.ctx, f.repo.id)]);
  assert.equal(a.id, b.id);
  assert.equal(f.starts.length, 1);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-123' });
  await f.starts[0].receive({ event: 'progress', message: 'Installing dependencies', kind: 'command', data: { phase: 'stage', stage: 'install', command: 'npm ci' } });
  assert.deepEqual((await f.store.get(a.id)).build_log.at(-1).data, { phase: 'stage', stage: 'install', command: 'npm ci' });
  assert.equal(f.events.at(-1).run.build_log.at(-1).kind, 'command');
  assert.equal((await f.store.get(a.id)).sandbox_id, 'sb-123');
  await f.starts[0].receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  assert.equal((await f.store.get(a.id)).status, 'ready');
  assert.equal(f.events.at(-1).notification, 'preview-ready', 'completion notifies without changing the active pane');
  assert.equal(f.events.some((event) => event.open), false);
  assert.deepEqual((await f.store.get(a.id)).build_log.map((entry) => entry.message), ['Starting repository setup', 'Sandbox created', 'Installing dependencies', 'Preview ready']);
  await f.manager.start(f.ctx, f.repo.id);
  assert.equal(f.starts.length, 1, 'ready run is probed and reused');
  assert.ok(f.controls.some((request) => request.command === 'probe'));
  await f.manager.stop(f.ctx, a.id);
  await f.starts[0].receive({ event: 'ready', preview_url: 'https://late.example/', port: 3000 });
  assert.equal((await f.store.get(a.id)).status, 'stopped', 'late events cannot revive a stopped run');
  assert.deepEqual(await f.ctx.libraryDb.get(f.repo.id), f.repo);
});

test('environment restart hands off the same sandbox, applies removals, and notifies about its new preview', async (t) => {
  const f = await fixture(t);
  const first = await f.manager.saveEnvironment(f.ctx, f.repo.id, [{ name: 'KEY', value: 'old-secret' }], null);
  const run = await f.manager.start(f.ctx, f.repo.id);
  assert.equal(f.starts[0].request.environment.values.KEY, 'old-secret');
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'retained-sandbox' });
  await f.starts[0].receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  const saved = await f.manager.saveEnvironment(f.ctx, f.repo.id, [{ name: 'KEY', value: null }, { name: 'NEXT', value: 'new-secret' }], first.revision);
  const restarted = await f.manager.restart(f.ctx, f.repo.id);
  assert.equal(restarted.id, run.id);
  assert.equal(restarted.sandbox_id, 'retained-sandbox');
  assert.equal(restarted.status, 'starting');
  assert.equal(restarted.env_revision, saved.revision);
  assert.equal(f.starts[1].request.command, 'restart');
  assert.deepEqual(f.starts[1].request.environment.values, { NEXT: 'new-secret' });
  assert.deepEqual(f.starts[1].request.environment.removed, ['KEY']);
  assert.ok(!f.controls.some((command) => command.command === 'kill'));
  await f.starts[0].receive({ event: 'failed', error: 'old worker' });
  assert.equal((await f.store.get(run.id)).status, 'starting');
  await f.starts[1].receive({ event: 'progress', message: 'new-secret', data: { text: 'new-secret' } });
  assert.ok(!JSON.stringify(f.events).includes('new-secret'));
  await f.starts[1].receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  assert.equal(f.events.at(-1).notification, 'preview-ready');
  assert.equal(f.events.some((event) => event.open), false);
  assert.equal((await f.ctx.libraryDb.query('select * from sandbox_runs')).length, 1);
});

test('restart preflight failures leave the old preview alone; failed restarts can retry or stop', async (t) => {
  const f = await fixture(t);
  const run = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'same-machine' });
  await f.starts[0].receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  f.setProbe(new Error('Cannot confirm launch plan'));
  await assert.rejects(f.manager.restart(f.ctx, f.repo.id), /Cannot confirm/);
  assert.equal((await f.store.get(run.id)).status, 'ready');
  assert.equal(f.starts.length, 1);
  f.setProbe({ state: 'ready' });
  await f.manager.restart(f.ctx, f.repo.id);
  await f.starts[1].receive({ event: 'failed', error: 'Bad configuration' });
  f.starts[1].finish();
  await f.manager.restart(f.ctx, f.repo.id);
  assert.equal(f.starts[2].request.sandbox_id, 'same-machine');
  await f.starts[2].receive({ event: 'failed', error: 'Still bad' });
  f.starts[2].finish();
  await f.manager.stop(f.ctx, run.id);
  assert.equal((await f.store.get(run.id)).status, 'stopped');
});

test('automatic preparation runs once per session and respects Stop and failures until restart', async (t) => {
  const f = await fixture(t);
  const [first, duplicate] = await Promise.all([
    f.manager.start(f.ctx, f.repo.id, { automatic: true }),
    f.manager.start(f.ctx, f.repo.id, { automatic: true }),
  ]);
  assert.equal(first.id, duplicate.id);
  assert.equal(f.starts.length, 1);
  await f.manager.stop(f.ctx, first.id);
  assert.equal((await f.manager.start(f.ctx, f.repo.id, { automatic: true })).status, 'stopped');
  assert.equal(f.starts.length, 1);
  const retry = await f.manager.start(f.ctx, f.repo.id);
  assert.notEqual(retry.id, first.id);
  await f.starts[1].receive({ event: 'failed', error: 'Build failed' });
  f.starts[1].finish();
  assert.equal((await f.manager.start(f.ctx, f.repo.id, { automatic: true })).id, retry.id);
  assert.equal(f.starts.length, 2);
});

test('automatic builds notify once on completion without opening previews on completion, replay or refresh', async (t) => {
  const f = await fixture(t);
  const run = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  const worker = f.starts[0];
  await worker.receive({ event: 'sandbox_created', sandbox_id: 'sb-auto' });
  await worker.receive({ event: 'progress', message: 'Checking preview' });
  assert.equal(f.events.some((event) => event.open), false);
  const ready = { event: 'ready', preview_url: 'https://preview.example/', port: 3000 };
  await worker.receive(ready);
  assert.equal(f.events.at(-1).notification, 'preview-ready');
  assert.equal(f.events.at(-1).run.preview_url, ready.preview_url);
  assert.equal((await f.store.get(run.id)).status, 'ready');
  await worker.receive(ready);
  await f.manager.list(f.ctx);
  await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(f.events.filter((event) => event.notification === 'preview-ready').length, 1);
  assert.equal(f.events.some((event) => event.open), false);
  assert.equal((await f.store.get(run.id)).build_log.filter((entry) => entry.message === 'Preview ready').length, 1);
  await f.manager.start(f.ctx, f.repo.id);
  assert.equal(f.events.some((event) => event.open), false, 'reusing a ready repo does not navigate either');
});

test('failed attempts stay in history and a retry creates a new run', async (t) => {
  const f = await fixture(t);
  const first = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'failed', error: 'Install failed' });
  f.starts[0].finish();
  const retry = await f.manager.start(f.ctx, f.repo.id);
  assert.notEqual(retry.id, first.id);
  assert.equal((await f.store.get(first.id)).error, 'Install failed');
  assert.ok((await f.store.get(first.id)).finished_at);
  assert.equal((await f.ctx.libraryDb.query('select * from sandbox_runs')).length, 2);
});

test('startup automatically rebuilds saved stopped and failed runs', async (t) => {
  const f = await fixture(t);
  for (const status of ['stopped', 'failed']) {
    const previous = await f.store.create(f.repo.id);
    await f.store.update(previous.id, { status });
    const run = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
    assert.notEqual(run.id, previous.id);
    assert.equal(run.status, 'starting');
    await f.manager.close();
  }
  assert.equal(f.starts.length, 2);
});

test('startup reuses a live saved preview without switching panes', async (t) => {
  const f = await fixture(t);
  const saved = await f.store.create(f.repo.id);
  await f.store.update(saved.id, { status: 'ready', sandbox_id: 'sb-live', preview_url: 'https://preview.example/', port: 3000 });
  const resumed = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(resumed.id, saved.id);
  assert.equal(f.starts.length, 0);
  assert.equal(!!f.events.at(-1).open, false);
});

test('startup rebuilds an interrupted run but leaves uncertain remote state intact', async (t) => {
  const f = await fixture(t);
  const saved = await f.store.create(f.repo.id);
  await f.store.update(saved.id, { sandbox_id: 'sb-old' });
  f.setProbe(new Error('Network timeout'));
  await assert.rejects(f.manager.start(f.ctx, f.repo.id, { automatic: true }), /Network timeout/);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.get(saved.id)).status, 'starting');
  // A new session gets another preparation attempt.
  await f.manager.close();
  const interrupted = await f.store.create(f.repo.id);
  await f.store.update(interrupted.id, { sandbox_id: 'sb-interrupted' });
  f.setProbe({ state: 'interrupted' });
  const rebuilt = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.notEqual(rebuilt.id, interrupted.id);
  assert.equal((await f.store.get(interrupted.id)).status, 'failed');
  assert.equal(f.starts.length, 1);
});

test('uncertain sandbox checks never create a duplicate; confirmed stale runs can be retried', async (t) => {
  const f = await fixture(t);
  const stale = await f.store.create(f.repo.id);
  await f.store.update(stale.id, { sandbox_id: 'sb-old' });
  f.setProbe(new Error('Network timeout'));
  await assert.rejects(() => f.manager.start(f.ctx, f.repo.id), /Network timeout/);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.get(stale.id)).status, 'starting');
  f.setProbe({ state: 'interrupted' });
  const retry = await f.manager.start(f.ctx, f.repo.id);
  assert.notEqual(retry.id, stale.id);
  assert.equal((await f.store.get(stale.id)).status, 'failed');
  assert.ok(f.controls.some((request) => request.command === 'kill' && request.sandbox_id === 'sb-old'));
});

test('non-GitHub entries do not create a run; database rejects a second active attempt', async (t) => {
  const f = await fixture(t);
  const other = await f.ctx.libraryDb.insert({ id: randomUUID(), name: 'site', type: 'website', url: 'https://example.org/' });
  assert.equal(await f.manager.start(f.ctx, other.id), null);
  await f.manager.start(f.ctx, f.repo.id);
  assert.equal(await f.store.create(f.repo.id), null);
  await assert.rejects(() => f.ctx.libraryDb.query('insert into sandbox_runs (id, library_id) values ($1, $2)', [randomUUID(), f.repo.id]), { code: '23505' });
});

test('worker launch errors are saved as failures', async (t) => {
  const f = await fixture(t);
  const manager = createSandboxManager({ notify() {}, readEnv: () => ({}), launch() { throw new Error('Cannot launch worker'); } });
  const run = await manager.start(f.ctx, f.repo.id);
  assert.equal(run.status, 'failed');
  assert.equal((await f.store.get(run.id)).error, 'Cannot launch worker');
  await manager.dispose();
});

test('recovery persists an orphan sandbox handle before cleaning it up', async (t) => {
  const f = await fixture(t);
  const stale = await f.store.create(f.repo.id);
  f.setProbe({ state: 'interrupted', sandbox_id: 'sb-recovered' });
  await f.manager.start(f.ctx, f.repo.id);
  const previous = await f.store.get(stale.id);
  assert.equal(previous.sandbox_id, 'sb-recovered');
  assert.equal(previous.status, 'failed');
  assert.ok(f.controls.some((request) => request.command === 'kill' && request.sandbox_id === 'sb-recovered'));
});

test('shutdown waits for workers even after their terminal event was saved', async (t) => {
  const f = await fixture(t);
  const run = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'failed', error: 'Failed before process exit' });
  await f.manager.close();
  await f.starts[0].done;
  assert.equal((await f.store.get(run.id)).status, 'failed');
});

test('release stops a live sandbox and forgets its runs so the library row can be deleted', async (t) => {
  const f = await fixture(t);
  const run = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-release' });
  await assert.rejects(() => f.ctx.libraryDb.remove(f.repo.id), /violates RESTRICT/, 'runs hold the library row');
  await f.manager.release(f.ctx, f.repo.id);
  assert.ok(f.controls.some((request) => request.command === 'kill' && request.sandbox_id === 'sb-release'));
  assert.equal(await f.store.get(run.id), null);
  assert.equal(await f.ctx.libraryDb.remove(f.repo.id), true);
});

test('release keeps the runs, and the row, when the sandbox cannot be confirmed stopped', async (t) => {
  const f = await fixture(t);
  const run = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-stuck' });
  await f.starts[0].receive({ event: 'failed', error: 'Setup failed' });
  f.starts[0].finish();
  // A second manager over the same library whose kill fails.
  const manager = createSandboxManager({ notify() {}, readEnv: () => ({}), launch(request, env, receive) {
    const done = Promise.resolve().then(() => receive({ run_id: request.run_id, event: 'failed', error: 'E2B unreachable' }));
    return { done, stop: () => done };
  } });
  t.after(() => manager.dispose());
  await assert.rejects(() => manager.release(f.ctx, f.repo.id), /E2B unreachable/);
  assert.equal((await f.store.get(run.id)).sandbox_id, 'sb-stuck');
  await assert.rejects(() => f.ctx.libraryDb.remove(f.repo.id), /violates RESTRICT/);
});
