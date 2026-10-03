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

async function fixture(t, { readEnv = () => ({}), e2bKey = async () => 'e2b_signed_in', githubLogin = () => 'octocat', repoAccess = null, claudeReady = async () => {}, Sandbox = null, now = Date.now } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-run-manager-'));
  const ctx = { root, dataRoot: root, libraryDb: await db.openLibraryDb(root) };
  const events = [], starts = [], controls = [], envs = [];
  let probe = { state: 'ready' };
  const manager = createSandboxManager({ secure: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() }, notify: (event) => events.push(event), readEnv, e2bKey, githubLogin, repoAccess, claudeReady, Sandbox, now, launch(request, env, receive) {
    envs.push({ command: request.command, env });
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
  return { ctx, manager, events, starts, controls, envs, repo, store: runStore(ctx.libraryDb), setProbe(value) { probe = value; } };
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
  const manager = createSandboxManager({ notify() {}, readEnv: () => ({}), e2bKey: async () => 'k', launch() { throw new Error('Cannot launch worker'); } });
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

test('the signed-in key is the only one a worker gets: a configured E2B_API_KEY is dropped, for start and for checks', async (t) => {
  const f = await fixture(t, { readEnv: () => ({ E2B_API_KEY: 'e2b_configured', E2B_TEMPLATE: 'custom' }), e2bKey: async () => 'e2b_from_github' });
  await f.manager.start(f.ctx, f.repo.id);
  assert.deepEqual(f.envs[0], { command: 'start', env: { E2B_TEMPLATE: 'custom', E2B_API_KEY: 'e2b_from_github' } });
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-key' });
  const run = (await f.store.latest())[0];
  await f.manager.stop(f.ctx, run.id);
  const kill = f.envs.find((entry) => entry.command === 'kill');
  assert.equal(kill.env.E2B_API_KEY, 'e2b_from_github');
  assert.ok(!f.envs.some((entry) => entry.env.E2B_API_KEY === 'e2b_configured'));
});

test('an explicit start without a key records nothing and says why', async (t) => {
  const signedOut = await fixture(t, { readEnv: () => ({ E2B_API_KEY: 'e2b_configured' }), e2bKey: async () => null });
  await assert.rejects(signedOut.manager.start(signedOut.ctx, signedOut.repo.id), /^Error: Sign in to GitHub in Engelbart to use sandboxes\.$/);
  assert.equal(signedOut.starts.length, 0);
  assert.equal((await signedOut.store.latest()).length, 0);
  const refused = await fixture(t, { e2bKey: async () => { throw new Error('E2B key request failed (401)'); } });
  await assert.rejects(refused.manager.start(refused.ctx, refused.repo.id), /Could not get the E2B key for your GitHub sign-in: E2B key request failed \(401\)/);
  assert.equal(refused.starts.length, 0);
  assert.equal((await refused.store.latest()).length, 0);
});

test('a restart without a key interrupts nothing', async (t) => {
  let key = 'e2b_signed_in';
  const f = await fixture(t, { e2bKey: async () => key });
  const run = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-restart' });
  await f.starts[0].receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  key = null;
  await assert.rejects(f.manager.restart(f.ctx, f.repo.id), /Sign in to GitHub/);
  assert.ok(!f.controls.some((request) => request.command === 'can_restart'));
  assert.equal(f.starts.length, 1);
  assert.equal((await f.store.get(run.id)).status, 'ready');
});

test('the start message names the signed-in GitHub login, and only a valid one', async (t) => {
  const f = await fixture(t);
  await f.manager.start(f.ctx, f.repo.id);
  assert.equal(f.starts[0].request.github_login, 'octocat');
  for (const login of ['', 'not a login', '-leading-dash', 'x'.repeat(40)]) {
    const g = await fixture(t, { githubLogin: () => login });
    await g.manager.start(g.ctx, g.repo.id);
    assert.equal('github_login' in g.starts[0].request, false, login);
  }
});

test('background checks wait while signed out instead of repeating the sign-in message', async (t) => {
  let key = 'e2b_signed_in';
  const f = await fixture(t, { e2bKey: async () => key });
  await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-poll' });
  await f.starts[0].receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  await f.manager.poll();
  const probes = f.controls.filter((request) => request.command === 'probe').length;
  assert.ok(probes >= 1, 'signed in, a ready run is checked');
  key = null;
  const published = f.events.length;
  await f.manager.poll();
  assert.equal(f.controls.filter((request) => request.command === 'probe').length, probes);
  assert.ok(!f.events.slice(published).some((event) => /Sign in to GitHub/.test(event.message)));
});

test('signing out stops each live run through its own worker, without asking for a key', async (t) => {
  let asked = 0, key = 'e2b_signed_in';
  const f = await fixture(t, { e2bKey: async () => { asked++; return key; } });
  const run = await f.manager.start(f.ctx, f.repo.id);
  await f.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-signed-out' });
  key = null;
  asked = 0;
  await f.manager.signedOut();
  const stopped = await f.store.get(run.id);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.sandbox_id, 'sb-signed-out');
  assert.ok(stopped.build_log.some((entry) => entry.message === 'Stopping: signed out of GitHub'));
  assert.ok(!f.controls.some((request) => request.command === 'kill'), 'the worker stopped its own sandbox');
  assert.equal(asked, 0);
  await f.manager.signedOut(); // nothing live: a repeat does nothing
  assert.equal(f.controls.length, 0);
});

test('automatic preparation waits for a key instead of failing every saved repository', async (t) => {
  let key = null;
  const f = await fixture(t, { readEnv: () => ({}), e2bKey: async () => key });
  assert.equal(await f.manager.start(f.ctx, f.repo.id, { automatic: true }), null);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.latest()).length, 0, 'no failed run is recorded while signed out');
  key = 'e2b_from_github';
  const run = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(run.status, 'starting');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].request.command, 'start');
  await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(f.starts.length, 1, 'still once per session after the key arrived');
});

test('automatic preparation waits for Claude Code to be signed in instead of failing on a missing ANTHROPIC_API_KEY', async (t) => {
  let ready = false;
  const f = await fixture(t, { claudeReady: async () => { if (!ready) throw new Error('Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in).'); } });
  assert.equal(await f.manager.start(f.ctx, f.repo.id, { automatic: true }), null);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.latest()).length, 0, 'no failed run is recorded while Claude Code is signed out');
  ready = true;
  const run = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(run.status, 'starting');
  assert.equal(f.starts.length, 1);
  await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(f.starts.length, 1, 'still once per session after the sign-in');
});

test('an explicit start before Claude Code is signed in records nothing and says why', async (t) => {
  const f = await fixture(t, { claudeReady: async () => { throw new Error('Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it).'); } });
  await assert.rejects(f.manager.start(f.ctx, f.repo.id), /^Error: Claude Code is not installed yet/);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.latest()).length, 0);
});

test('saving or linking a repository before Claude Code is signed in waits instead of failing the save', async (t) => {
  let ready = false;
  const f = await fixture(t, { claudeReady: async () => { if (!ready) throw new Error('Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in).'); } });
  assert.equal(await f.manager.start(f.ctx, f.repo.id, { waitForClaude: true }), null);
  assert.equal(f.starts.length, 0);
  assert.equal((await f.store.latest()).length, 0);
  ready = true;
  const run = await f.manager.start(f.ctx, f.repo.id, { automatic: true });
  assert.equal(run.status, 'starting', 'the preparation that follows the sign-in starts it');
  assert.equal(f.starts.length, 1);
});

test('Claude Code sign-in is asked for only when the subscription is what sets up', async (t) => {
  const cases = [
    [{}, 1], // auto, nothing to fall back to
    [{ ANTHROPIC_API_KEY: 'sk-ant-fallback' }, 0], // auto falls back to the key
    [{ ENGELBART_SANDBOX_SETUP: 'api', ANTHROPIC_API_KEY: 'sk-ant-api' }, 0],
    [{ ENGELBART_SANDBOX_SETUP: 'claude-local', ANTHROPIC_API_KEY: 'sk-ant-unused' }, 1], // never falls back
  ];
  for (const [env, asks] of cases) {
    let asked = 0;
    const f = await fixture(t, { readEnv: () => env, claudeReady: async () => { asked++; } });
    await f.manager.start(f.ctx, f.repo.id);
    assert.equal(asked, asks, JSON.stringify(env));
    assert.equal(f.starts.length, 1);
  }
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
  const manager = createSandboxManager({ notify() {}, readEnv: () => ({}), e2bKey: async () => 'k', launch(request, env, receive) {
    const done = Promise.resolve().then(() => receive({ run_id: request.run_id, event: 'failed', error: 'E2B unreachable' }));
    return { done, stop: () => done };
  } });
  t.after(() => manager.dispose());
  await assert.rejects(() => manager.release(f.ctx, f.repo.id), /E2B unreachable/);
  assert.equal((await f.store.get(run.id)).sandbox_id, 'sb-stuck');
  await assert.rejects(() => f.ctx.libraryDb.remove(f.repo.id), /violates RESTRICT/);
});

test('a private repository: the sandbox gets a one-archive link with the ack, made then, and never the sign-in (2026-09-29)', async (t) => {
  const asked = [];
  const LINK = 'https://codeload.github.com/owner/app/legacy.tar.gz/refs/heads/main?token=AAAAONEARCHIVEONLYTOKEN';
  const repoAccess = {
    async describe(repo) { asked.push(['describe', repo.url]); return { private: true, branch: 'main', docker: true }; },
    async archive(repo) { asked.push(['archive', repo.url]); return LINK; },
  };
  const f = await fixture(t, { repoAccess });
  const run = await f.manager.start(f.ctx, f.repo.id);
  const worker = f.starts[0];
  assert.equal(worker.request.docker, true, 'Docker is decided with the sign-in, before the sandbox is made');
  assert.deepEqual(asked, [['describe', 'https://github.com/owner/app']], 'no link before the sandbox can use it');
  assert.ok(!JSON.stringify(worker.request).includes('ghu_') && !('archive_url' in worker.request));
  const reply = await worker.receive({ event: 'sandbox_created', sandbox_id: 'sb-private' });
  assert.deepEqual(reply, { archive_url: LINK, branch: 'main' });
  assert.deepEqual(asked.at(-1), ['archive', 'https://github.com/owner/app']);
  assert.equal(await worker.receive({ event: 'progress', message: 'Cloning repository' }), undefined, 'only the ack carries it');
  assert.ok(!JSON.stringify((await f.store.get(run.id)).build_log).includes(LINK), 'the link is never recorded');
  assert.ok(!f.events.some((event) => JSON.stringify(event).includes(LINK)), 'nor announced');
});

test('a public repository gets no link; one GitHub will not show fails with what to do, and no sandbox is made (2026-09-29)', async (t) => {
  let archives = 0;
  const pub = await fixture(t, { repoAccess: { describe: async () => ({ private: false, branch: 'main', docker: false }), archive: async () => { archives += 1; return 'x'; } } });
  await pub.manager.start(pub.ctx, pub.repo.id);
  assert.equal(pub.starts[0].request.docker, false);
  assert.equal(await pub.starts[0].receive({ event: 'sandbox_created', sandbox_id: 'sb-public' }), undefined);
  assert.equal(archives, 0);
  const hidden = await fixture(t, { repoAccess: { describe: async () => { throw new Error("Engelbart's GitHub App cannot see owner/app."); }, archive: async () => 'x' } });
  const run = await hidden.manager.start(hidden.ctx, hidden.repo.id);
  assert.deepEqual([run.status, run.error], ['failed', "Engelbart's GitHub App cannot see owner/app."]);
  assert.equal(hidden.starts.length, 0);
});

// A ready preview sleeps instead of ending (2026-10-02; worker.cjs). The run stays ready throughout, and a request to the
// preview wakes the sandbox.
async function readyRun(f, repo = f.repo, sandboxId = 'sb-sleepy') {
  const run = await f.manager.start(f.ctx, repo.id);
  const worker = f.starts.at(-1);
  await worker.receive({ event: 'sandbox_created', sandbox_id: sandboxId });
  await worker.receive({ event: 'ready', preview_url: 'https://preview.example/', port: 3000 });
  return { run, worker };
}
const anotherRepo = (f, name = 'owner/other') => f.ctx.libraryDb.insert({ id: randomUUID(), name, type: 'website', url: `https://github.com/${name}`, tags: ['git'] });

test('a sandbox gone to sleep keeps its run ready: its worker leaves without a kill, and checks leave it alone', async (t) => {
  const f = await fixture(t);
  const { run, worker } = await readyRun(f);
  f.setProbe({ state: 'paused' });
  await f.manager.poll(); // asleep while its worker is still leaving
  assert.equal((await f.store.get(run.id)).status, 'ready');
  await worker.receive({ event: 'paused' });
  worker.finish();
  await worker.done;
  await new Promise((resolve) => setImmediate(resolve));
  const asleep = await f.store.get(run.id);
  assert.equal(asleep.status, 'ready');
  assert.equal(asleep.build_log.at(-1).message, 'Paused after 10 minutes unused');
  assert.equal(f.events.at(-1).message, 'Paused after 10 minutes unused');
  await f.manager.poll(); // asleep, no worker
  assert.equal((await f.store.get(run.id)).status, 'ready');
  assert.ok(!f.controls.some((request) => request.command === 'kill'));
  assert.ok(!f.events.some((event) => /unreachable|failed/i.test(event.message)));
  assert.equal((await f.manager.start(f.ctx, f.repo.id)).id, run.id, 'opening it again reuses it');
  assert.equal(f.starts.length, 1);
});

test('touch puts a ready sandbox\'s sleep 10 minutes away, marks it opened, and is throttled to once per 30 seconds', async (t) => {
  let clock = Date.parse('2026-10-02T12:00:00Z');
  const calls = [];
  let answer = null;
  const Sandbox = { async setTimeout(id, ms, options) { calls.push({ id, ms, key: options.apiKey }); if (answer) throw answer; } };
  const f = await fixture(t, { Sandbox, now: () => clock });
  await f.manager.touch(f.ctx, f.repo.id);
  assert.equal(calls.length, 0, 'no run');
  const { run } = await readyRun(f);
  await f.manager.touch(f.ctx, f.repo.id);
  assert.deepEqual(calls, [{ id: 'sb-sleepy', ms: 600_000, key: 'e2b_signed_in' }]);
  assert.equal((await f.store.get(run.id)).last_opened_at, '2026-10-02T12:00:00.000Z');
  clock += 20_000;
  await f.manager.touch(f.ctx, f.repo.id);
  assert.equal(calls.length, 1, 'throttled');
  assert.equal((await f.store.get(run.id)).last_opened_at, '2026-10-02T12:00:00.000Z');
  clock += 15_000;
  await f.manager.touch(f.ctx, f.repo.id);
  assert.equal(calls.length, 2);
  assert.equal((await f.store.get(run.id)).last_opened_at, '2026-10-02T12:00:35.000Z');
  // Asleep or gone, E2B says not found: the ping says nothing, and the next poll tells which.
  answer = Object.assign(new Error('Sandbox sb-sleepy not found'), { name: 'SandboxNotFoundError' });
  clock += 60_000;
  await f.manager.touch(f.ctx, f.repo.id);
  assert.equal(calls.length, 3);
  assert.equal((await f.store.get(run.id)).status, 'ready');
  assert.ok(!f.controls.some((request) => request.command === 'kill'));
  assert.equal(f.starts.length, 1, 'no worker for a ping');
});

test('quitting puts ready previews to sleep instead of killing them, and still stops one being set up', async (t) => {
  const f = await fixture(t);
  const { run: ready } = await readyRun(f);
  const other = await anotherRepo(f);
  const starting = await f.manager.start(f.ctx, other.id);
  await f.starts[1].receive({ event: 'sandbox_created', sandbox_id: 'sb-starting' });
  f.setProbe({ state: 'paused', paused: true });
  await f.manager.close();
  assert.deepEqual(f.controls.filter((request) => ['pause', 'kill'].includes(request.command)).map((request) => [request.command, request.sandbox_id]),
    [['pause', 'sb-sleepy']]);
  const asleep = await f.store.get(ready.id);
  assert.equal(asleep.status, 'ready');
  assert.equal(asleep.build_log.at(-1).message, 'Paused when Engelbart quit');
  assert.equal((await f.store.get(starting.id)).status, 'stopped', 'its own worker stopped it');
});

test('the sweep ends a sandbox asleep and unopened for 7 days; newer, awake and recently opened ones stay', async (t) => {
  const f = await fixture(t);
  const ago = (days) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const { run: stale } = await readyRun(f);
  const fresh = await anotherRepo(f, 'owner/fresh');
  const { run: recent } = await readyRun(f, fresh, 'sb-fresh');
  const old = await anotherRepo(f, 'owner/old');
  const { run: neverOpened } = await readyRun(f, old, 'sb-old');
  for (const held of f.starts) { await held.receive({ event: 'paused' }); held.finish(); }
  await Promise.all(f.starts.map((held) => held.done));
  await new Promise((resolve) => setImmediate(resolve));
  await f.ctx.libraryDb.query('update sandbox_runs set last_opened_at = $2 where id = $1', [stale.id, ago(8)]);
  await f.ctx.libraryDb.query('update sandbox_runs set last_opened_at = $2, created_at = $3 where id = $1', [recent.id, ago(6), ago(30)]);
  await f.ctx.libraryDb.query('update sandbox_runs set created_at = $2 where id = $1', [neverOpened.id, ago(8)]);
  f.setProbe({ state: 'paused' });
  await f.manager.poll();
  const ended = await f.store.get(stale.id);
  assert.equal(ended.status, 'stopped');
  assert.equal(ended.error, null);
  assert.equal(ended.build_log.at(-1).message, 'Stopped after 7 days unopened');
  assert.equal(ended.build_log.at(-1).data.lifecycle, 'expired');
  assert.equal((await f.store.get(neverOpened.id)).status, 'stopped', 'never opened: counted from its creation');
  assert.equal((await f.store.get(recent.id)).status, 'ready');
  assert.deepEqual(f.controls.filter((request) => request.command === 'kill').map((request) => request.sandbox_id).sort(), ['sb-old', 'sb-sleepy']);
  // Awake, an old one is in use: it stays.
  const awake = await anotherRepo(f, 'owner/awake');
  const { run: awakeRun } = await readyRun(f, awake, 'sb-awake');
  await f.ctx.libraryDb.query('update sandbox_runs set created_at = $2 where id = $1', [awakeRun.id, ago(9)]);
  f.setProbe({ state: 'ready' });
  await f.manager.poll();
  assert.equal((await f.store.get(awakeRun.id)).status, 'ready');
});

test('a preview ended by the sweep is not rebuilt by a new session\'s preparation, only when it is opened', async (t) => {
  const f = await fixture(t);
  const { run, worker } = await readyRun(f);
  await worker.receive({ event: 'paused' });
  worker.finish();
  await worker.done;
  await new Promise((resolve) => setImmediate(resolve));
  await f.ctx.libraryDb.query("update sandbox_runs set last_opened_at = now() - interval '8 days' where id = $1", [run.id]);
  f.setProbe({ state: 'paused' });
  await f.manager.poll();
  assert.equal((await f.store.get(run.id)).status, 'stopped');
  await f.manager.close(); // a new session
  assert.equal((await f.manager.start(f.ctx, f.repo.id, { automatic: true })).id, run.id);
  assert.equal(f.starts.length, 1);
  const rebuilt = await f.manager.start(f.ctx, f.repo.id);
  assert.notEqual(rebuilt.id, run.id);
  assert.equal(rebuilt.status, 'starting');
  assert.equal(f.starts.length, 2);
});
