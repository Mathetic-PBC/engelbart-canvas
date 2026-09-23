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
  assert.equal(runs[1].build_log[0].message, 'Preview ready');
  assert.deepEqual(runs[1].build_log[0].data, { phase: 'ready' });
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
