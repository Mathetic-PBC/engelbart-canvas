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
  await store.setTestMode(false);
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
