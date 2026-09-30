'use strict';

// What runs in a repository (library.pglite → repo_runnables; src/main/build/runnables.cjs): one row per folder and name
// of a library repository, gone with it; commands written only by a passing check, a UI's with {port} in it, never a
// fixed port; a failure keeps the commands that last worked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { runnableStore, runnableFolder, runnableCommand, withPort } = require('../src/main/build/runnables.cjs');

test.after(async () => { await db.closeAll(); });

async function library() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-runnables-'));
  const lib = await db.openLibraryDb(root);
  const repo = await lib.insert({ id: randomUUID(), name: 'app', type: 'folder', tags: ['git'], folder_path: path.join(root, 'app') });
  return { lib, repo, runnables: runnableStore(lib) };
}

test('a runnable belongs to a library repository, one per folder and name, and goes with it', async () => {
  const { lib, repo, runnables } = await library();
  const web = await runnables.declare(repo.id, { folder: 'web/', name: 'web', type: 'ui' });
  assert.deepEqual([web.folder, web.name, web.type, web.status, web.install_command, web.run_command, web.last_error, web.verified_commit], ['web', 'web', 'ui', 'pending', null, null, null, null]);
  const again = await runnables.declare(repo.id, { folder: './web', name: 'web', type: 'ui' });
  assert.equal(again.id, web.id, 'the same folder and name is the same runnable');
  const cli = await runnables.declare(repo.id, { name: 'cli', type: 'terminal' });
  assert.equal(cli.folder, '.', 'the root');
  assert.deepEqual((await runnables.list(repo.id)).map((row) => `${row.folder}:${row.name}`), ['.:cli', 'web:web']);
  await assert.rejects(runnables.declare(randomUUID(), { name: 'x', type: 'ui' }), { code: '23503' }, 'an unknown repository');
  await assert.rejects(() => lib.query("insert into repo_runnables (id, library_id, name, type) values ($1, $2, 'x', 'server')", [randomUUID(), repo.id]), { code: '23514' }, 'ui, app or terminal only');
  await assert.rejects(() => lib.query("insert into repo_runnables (id, library_id, name, type, run_command) values ($1, $2, 'x', 'ui', 'npm start')", [randomUUID(), repo.id]), { code: '23514' }, 'a UI\'s command holds {port}');
  assert.equal(await lib.remove(repo.id), true);
  assert.deepEqual(await lib.query('select * from repo_runnables'), [], 'gone with its repository');
});

test('only a passing check writes commands; a failure keeps the ones that last worked; another type starts over', async () => {
  const { repo, runnables } = await library();
  const web = await runnables.declare(repo.id, { folder: 'web', name: 'web', type: 'ui' });
  await assert.rejects(runnables.verify(web.id, { run_command: 'npm run dev -- --port 5173', commit: 'abc1234' }), /must hold \{port\}/, 'never a fixed port');
  const ok = await runnables.verify(web.id, { install_command: 'npm ci', run_command: 'npm run dev -- --port {port}', commit: 'abc1234' });
  assert.deepEqual([ok.status, ok.install_command, ok.run_command, ok.verified_commit, ok.last_error], ['verified', 'npm ci', 'npm run dev -- --port {port}', 'abc1234', null]);
  const bad = await runnables.fail(web.id, 'Error: Cannot find module vite');
  assert.deepEqual([bad.status, bad.run_command, bad.verified_commit, bad.last_error], ['failed', 'npm run dev -- --port {port}', 'abc1234', 'Error: Cannot find module vite']);
  const kept = await runnables.declare(repo.id, { folder: 'web', name: 'web', type: 'ui' });
  assert.deepEqual([kept.status, kept.run_command], ['failed', 'npm run dev -- --port {port}'], 'naming it again changes nothing');
  const moved = await runnables.declare(repo.id, { folder: 'web', name: 'web', type: 'app' });
  assert.deepEqual([moved.status, moved.install_command, moved.run_command], ['pending', null, null]);
  const app = await runnables.verify(moved.id, { run_command: 'npm start', commit: 'not a sha' });
  assert.deepEqual([app.status, app.install_command, app.verified_commit], ['verified', null, null], 'an app needs no port; a bad commit is not kept');
});

test('folders stay inside the repository; {port} is where the port goes', () => {
  assert.equal(runnableFolder(''), '.');
  assert.equal(runnableFolder('apps//desktop/'), 'apps/desktop');
  for (const bad of ['/etc', '..', '../x', 'a/../../b', 'a\\b']) assert.throws(() => runnableFolder(bad), /folder must be/, bad);
  assert.throws(() => runnableCommand('  '), /required/);
  assert.equal(runnableCommand(null, { optional: true }), null);
  assert.equal(withPort('PORT={port} node server.js --port {port}', 5301), 'PORT=5301 node server.js --port 5301');
});
