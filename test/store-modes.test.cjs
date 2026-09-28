'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { readConfig } = require('../src/main/store/home.cjs');
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
  const store = createStore({ homeDir, fixturesDir: fixtures, testMode: true });
  assert.equal(store.config().mode, 'normal', 'a new install starts on ~/.engelbart');
  assert.equal((await store.setTestMode(true)).mode, 'test');
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

  // "Start as a new user": the same wipe, and the library stays empty as a new install has it, until a plain reset.
  await projects.createProject(fresh, { name: 'Left over' });
  const anew = await store.resetTestData({ fresh: true });
  assert.equal(anew.mode, 'test');
  const empty = await store.context();
  assert.deepEqual(await projects.listProjects(empty), []);
  assert.equal((await empty.libraryDb.list()).length, 0, 'no sample library for a new user');
  await store.resetTestData();
  assert.equal((await (await store.context()).libraryDb.list()).length, 4, 'a plain reset seeds again');
  assert.ok(fs.existsSync(path.join(store.layout.root, 'real', 'project.json')));
  await store.close();
});

// What ships (2026-09-28): src/main/developer.cjs decides; the store and its handlers are tested here.
test('a copy without test mode is on ~/.engelbart whatever config.json says, never makes the test root, and switches and resets nothing', async () => {
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-shipped-'));
  const first = createStore({ homeDir: fresh, fixturesDir: fixtures });
  const ctx = await first.context();
  assert.equal(ctx.dataRoot, first.layout.root);
  assert.equal((await ctx.libraryDb.list()).length, 0, 'no sample library');
  assert.ok(!fs.existsSync(first.layout.testRoot), 'no ~/.engelbart/test');
  assert.equal(readConfig(first.layout.root).testMode, false);
  await first.close();

  // A developer's copy on the same Mac left test mode on: the shipped copy still uses ~/.engelbart, and leaves the setting.
  const developer = createStore({ homeDir: fresh, fixturesDir: fixtures, testMode: true });
  await developer.setTestMode(true);
  await developer.close();
  const store = createStore({ homeDir: fresh, fixturesDir: fixtures });
  const config = store.config();
  assert.deepEqual([config.testModeAvailable, config.testMode, config.mode, config.dataRoot], [false, false, 'normal', store.layout.root]);
  assert.equal((await store.context()).dataRoot, store.layout.root);
  await assert.rejects(() => store.setTestMode(false), /only in developer builds/);
  await assert.rejects(() => store.resetTestData(), /only in developer builds/);
  assert.equal(readConfig(store.layout.root).testMode, true, "the developer's copy keeps its setting");

  // The renderer's calls are refused before anything is closed or a confirmation is shown.
  const handlers = new Map();
  const calls = [];
  registerEngelbartIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    trustedHandler: (handler) => (_event, ...args) => handler(...args),
    store,
    notify: () => {},
    confirmReset: async () => { calls.push('confirm'); return true; },
    beforeContextChange: async () => { calls.push('before'); },
  });
  await assert.rejects(() => handlers.get('engelbart:set-test-mode')({}, true), /only in developer builds/);
  await assert.rejects(() => handlers.get('engelbart:reset-test-data')({}), /only in developer builds/);
  assert.deepEqual(calls, []);
  assert.equal((await handlers.get('engelbart:config')({})).testModeAvailable, false);
  await store.close();
});

// The library as an install from before 2026-09-21 has it (test/db.test.cjs holds the whole conversion).
const OLD_LIBRARY = `
create table library (id uuid primary key, name text not null, type text not null check (type in ('note','paper','git_repo','dataset','website','image')), path text, url text, folder_path text, project_id uuid, created timestamptz not null default now(), last_edited timestamptz not null default now());
alter table library add column summary text; alter table library add column summary_edited timestamptz; alter table library add column char_count integer; alter table library add column github_id text;
insert into library (id, name, type, path, summary, summary_edited, last_edited) values ('11111111-1111-4111-8111-111111111111', 'A paper', 'paper', '/PDFS/attention.pdf', 'Its abstract.', '2026-09-10T00:00:00Z', '2026-09-09T00:00:00Z');
insert into library (id, name, type, path, summary, summary_edited, last_edited) values ('22222222-2222-4222-8222-222222222222', 'A receipt', 'paper', '/PDFS/receipt.pdf', 'A model wrote this.', '2026-09-10T00:00:00Z', '2026-09-09T00:00:00Z');
insert into library (id, name, type, url) values ('33333333-3333-4333-8333-333333333333', 'arXiv 2310.05292', 'website', 'https://arxiv.org/abs/2310.05292');
`;

test('an installed library opens already re-categorized: the first read sees the final types and tags, and the summaries it had', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const installed = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-installed-'));
  const pdfs = path.join(installed, 'pdfs');
  fs.mkdirSync(pdfs);
  for (const name of ['attention.pdf', 'receipt.pdf']) fs.writeFileSync(path.join(pdfs, name), 'x');
  const store = createStore({ homeDir: installed, fixturesDir: fixtures, inspectPdf: async (file) => (/attention/.test(file) ? ['paper'] : []) });
  await store.close();
  const old = new PGlite(path.join(store.layout.root, 'library.pglite'));
  await old.waitReady;
  await old.exec('drop table if exists library;' + OLD_LIBRARY.replaceAll('/PDFS', pdfs));
  await old.close();

  const upgraded = createStore({ homeDir: installed, fixturesDir: fixtures, inspectPdf: async (file) => (/attention/.test(file) ? ['paper'] : []) });
  const rows = await (await upgraded.context()).libraryDb.list(); // the first thing anyone reads
  assert.deepEqual(rows.map((row) => [row.name, row.type, row.tags, row.summary, row.summary_edited, row.last_edited.slice(0, 10)]), [
    ['A paper', 'pdf', ['paper'], 'Its abstract.', '2026-09-10T00:00:00.000Z', '2026-09-09'],
    ['A receipt', 'pdf', [], 'A model wrote this.', '2026-09-10T00:00:00.000Z', '2026-09-09'],
    ['arXiv 2310.05292', 'website', ['paper'], null, null, rows[2].last_edited.slice(0, 10)],
  ]);
  assert.ok(rows.every((row) => row.categorized >= 1));
  await upgraded.close();
});
