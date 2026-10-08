const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { environmentStore, validateChanges, redact, redactOutput, redactEvent } = require('../src/main/sandbox/environment.cjs');
const { runStore } = require('../src/main/sandbox/runs.cjs');

function secure() {
  const key = crypto.randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decryptString(bytes) {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
    },
  };
}

test('environment values are encrypted, names-only over IPC, revisioned, and removals survive reopening', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-env-'));
  const database = await db.openLibraryDb(root);
  t.after(() => database.close());
  const id = crypto.randomUUID();
  await database.insert({ id, name: 'owner/app', type: 'website', url: 'https://github.com/owner/app' });
  const vault = secure();
  const env = environmentStore(database, vault);
  const value = ' secret "$value"\nwith-newline ';
  const saved = await env.save(id, [{ name: 'APP_SECRET', value }, { name: 'EMPTY', value: '' }], null);
  assert.deepEqual(saved.names, ['APP_SECRET', 'EMPTY']);
  assert.equal(JSON.stringify(saved).includes(value), false);
  assert.equal((await env.read(id)).values.APP_SECRET, value, 'whitespace and dollars are not altered');
  const raw = JSON.stringify(await database.query('select * from sandbox_environments'));
  assert.equal(raw.includes('secret'), false);
  assert.equal(raw.includes('APP_SECRET'), false);
  await assert.rejects(env.save(id, [], null), /changed elsewhere/);
  const removed = await env.save(id, [{ name: 'APP_SECRET', value: null }], saved.revision);
  const reloaded = environmentStore(database, vault);
  assert.deepEqual(await reloaded.describe(id), removed);
  assert.deepEqual((await reloaded.read(id)).values, { EMPTY: '' });
  assert.deepEqual(removed.removed, ['APP_SECRET']);
  const restored = await reloaded.save(id, [{ name: 'APP_SECRET', value: 'new' }], removed.revision);
  assert.deepEqual(restored.removed, []);
  await assert.rejects(environmentStore(database, { isEncryptionAvailable: () => false }).read(id), /Secure storage/);
  await assert.rejects(environmentStore(database, { ...vault, getSelectedStorageBackend: () => 'basic_text' }).read(id), /Secure storage/);
  await assert.rejects(environmentStore(database, secure()).read(id), /could not be unlocked/);
});

test('bounded, application-only names and values; nested secret redaction handles escaped strings', () => {
  for (const name of ['BAD-NAME', '1KEY', '__proto__', 'HC_ENV_FILE', 'HUMAN_COMPACT_HOME', 'ENGELBART_CANVAS_PORT']) assert.throws(() => validateChanges([{ name, value: 'x' }]));
  assert.throws(() => validateChanges([{ name: 'A', value: 'x\0y' }]));
  assert.throws(() => validateChanges([{ name: 'A', value: 'a' }, { name: 'A', value: 'b' }]));
  const secret = 'hello"\nsecret';
  assert.deepEqual(redact({ data: { text: `got ${secret}` } }, [secret]), { data: { text: 'got [redacted]' } });
  assert.equal(redactOutput('token=abcdef', ['abcdefghij']).includes('abcdef'), false);
  assert.equal(redactOutput('ghij done', ['abcdefghij']).includes('ghij'), false);
  assert.equal(redactEvent({ event: 'ready', sandbox_id: 'app-id', preview_url: 'https://app.example', message: 'app' }, ['app']).preview_url, 'https://app.example');
});

test('discovered fields survive trimmed logs, app restarts, and an unscanned retry', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-env-report-'));
  let database = await db.openLibraryDb(root);
  t.after(() => database.close());
  const id = crypto.randomUUID();
  await database.insert({ id, name: 'owner/app', type: 'website', url: 'https://github.com/owner/app' });
  const vault = secure();
  let store = runStore(database), env = environmentStore(database, vault);
  assert.equal((await env.describe(id)).report, null);
  const first = await store.create(id);
  const event = { phase: 'environment', variables: [
    { name: 'OPENAI_API_KEY', status: 'missing', requirement: 'required', group: 'required' },
    { name: 'DATABASE_URL', status: 'local', requirement: 'required', group: 'required' },
  ], skipped: ['OPENAI_API_KEY'] };
  const updated = await store.record(first.id, 'Environment scanned', { data: event });
  assert.deepEqual(updated.env_report.variables.map((v) => v.name), ['OPENAI_API_KEY', 'DATABASE_URL']);
  const saved = await env.save(id, [{ name: 'OPENAI_API_KEY', value: 'supplied-secret' }], null);
  assert.deepEqual(saved.names, ['OPENAI_API_KEY'], 'detected names do not save blank values over the sandbox configuration');
  assert.equal(JSON.stringify(saved).includes('supplied-secret'), false);
  await database.query('update sandbox_runs set build_log = build_log || $2::jsonb where id = $1', [first.id,
    JSON.stringify(Array.from({ length: 299 }, () => ({ time: new Date().toISOString(), message: 'Build output' }))) ]);
  const trimmed = await store.record(first.id, 'More build output');
  assert.equal(trimmed.build_log.length, 300);
  assert.equal(trimmed.build_log.some((e) => e.data?.phase === 'environment'), false);
  assert.deepEqual(trimmed.env_report, updated.env_report);
  await store.update(first.id, { status: 'failed' });
  await database.close();
  database = await db.openLibraryDb(root);
  store = runStore(database); env = environmentStore(database, vault);
  const second = await store.create(id);
  assert.deepEqual((await env.describe(id)).report, updated.env_report);
  await store.record(second.id, 'Scan unavailable', { data: { phase: 'environment', warning: 'Unavailable' } });
  assert.equal((await env.describe(id)).report.runId, first.id);
  await store.record(second.id, 'Environment scanned', { data: { phase: 'environment', variables: [] } });
  assert.deepEqual((await env.describe(id)).report.variables, []);
  assert.equal((await env.describe(id)).report.runId, second.id);
  const other = crypto.randomUUID();
  await database.insert({ id: other, name: 'owner/other', type: 'website', url: 'https://github.com/owner/other' });
  assert.equal((await env.describe(other)).report, null, 'reports belong to the selected repository');
});

test('existing databases recover discovered fields from logs when the report column is added', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-env-upgrade-'));
  let database = await db.openLibraryDb(root);
  t.after(() => database.close());
  const id = crypto.randomUUID(), runId = crypto.randomUUID();
  await database.insert({ id, name: 'owner/legacy', type: 'website', url: 'https://github.com/owner/legacy' });
  await database.query('alter table sandbox_runs drop column env_report');
  await database.query('insert into sandbox_runs (id, library_id, build_log) values ($1, $2, $3)', [runId, id, JSON.stringify([
    { time: '2026-09-22T21:00:00.000Z', data: { phase: 'environment', variables: [{ name: 'EXISTING_KEY', status: 'missing' }] } },
  ])]);
  await database.close();
  database = await db.openLibraryDb(root);
  const described = await environmentStore(database, secure()).describe(id);
  assert.equal(described.report.variables[0].name, 'EXISTING_KEY');
  assert.equal(described.report.runId, runId);
  assert.deepEqual(described.names, []);
});
