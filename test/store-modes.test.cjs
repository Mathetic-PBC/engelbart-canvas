'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');
const db = require('../src/main/store/db.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-modes-'));
const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-modes-fixtures-'));
fs.writeFileSync(path.join(fixtures, 'hypocompass.pdf'), '%PDF-1.4 test');
fs.writeFileSync(path.join(fixtures, 'problems.csv'), 'a,b\n');

test.after(async () => {
  await db.closeAll();
});

test('test mode and normal mode use different roots, libraries and project lists', async () => {
  const store = createStore({ homeDir, fixturesDir: fixtures });
  assert.equal(store.config().mode, 'test');
  const testCtx = await store.context();
  assert.equal(testCtx.dataRoot, store.layout.testRoot);
  assert.equal((await testCtx.libraryDb.list()).length, 4, 'the test library is seeded');
  const made = await projects.createProjectWithWelcome(testCtx, { name: 'Scratch' });
  assert.ok(fs.existsSync(path.join(store.layout.testRoot, 'scratch', 'Welcome!.md')));

  const off = await store.setTestMode(false);
  assert.equal(off.mode, 'normal');
  assert.equal(off.dataRoot, store.layout.root);
  const normalCtx = await store.context();
  assert.equal(normalCtx.dataRoot, store.layout.root);
  assert.equal((await normalCtx.libraryDb.list()).length, 0, 'the normal library is not seeded');
  assert.deepEqual(await projects.listProjects(normalCtx), [], 'test projects are invisible from the normal root');
  const real = await projects.createProject(normalCtx, { name: 'Real work', path: 'real' });
  assert.ok(fs.existsSync(path.join(store.layout.root, 'real', 'project.json')));
  assert.ok(fs.existsSync(path.join(store.layout.root, 'library.pglite')));
  assert.equal((await projects.listProjects(normalCtx)).length, 1);
  assert.equal(real.slug, 'real');

  await assert.rejects(() => store.resetTestData(), /Test mode is off/);
  const on = await store.setTestMode(true);
  assert.equal(on.mode, 'test');
  const again = await store.context();
  assert.equal((await projects.listProjects(again)).length, 1, 'the test project is back');
  assert.equal((await projects.listProjects(again))[0].id, made.project.id);

  const reset = await store.resetTestData();
  assert.equal(reset.mode, 'test');
  assert.ok(!fs.existsSync(path.join(store.layout.testRoot, 'scratch')));
  const fresh = await store.context();
  assert.deepEqual(await projects.listProjects(fresh), []);
  assert.equal((await fresh.libraryDb.list()).length, 4, 'reseeded after the reset');
  assert.ok(fs.existsSync(path.join(store.layout.root, 'real', 'project.json')), 'the normal root is untouched by a test reset');
  await store.close();
});
