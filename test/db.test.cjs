'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-db-'));

test.after(async () => {
  await db.closeAll();
});

test('library: schema, insert, type constraint, list order', async () => {
  const library = await db.openLibraryDb(root);
  const id = randomUUID();
  const row = await library.insert({ id, name: 'A paper', type: 'pdf', path: '/tmp/a.pdf' });
  assert.equal(row.id, id);
  assert.equal(row.type, 'pdf');
  assert.equal(row.url, null);
  assert.match(row.created, /^\d{4}-\d{2}-\d{2}T/);
  await assert.rejects(() => library.insert({ id: randomUUID(), name: 'x', type: 'chat' }), /Unknown library type/);
  // what a row is called is what it is on disk or on the web; the names that said what it was for are gone
  for (const type of ['paper', 'dataset', 'git_repo', 'note']) await assert.rejects(() => library.insert({ id: randomUUID(), name: 'x', type }), /Unknown library type/, type);
  await library.insert({ id: randomUUID(), name: 'Site', type: 'website', url: 'https://example.com' });
  const rows = await library.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'A paper');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['categorized', 'char_count', 'created', 'folder_path', 'github_id', 'id', 'last_edited', 'name', 'path', 'project_id', 'summary', 'summary_edited', 'tags', 'type', 'url']);
  assert.deepEqual([rows[0].summary, rows[0].summary_edited, rows[0].char_count], [null, null, null], 'the catalog columns default to null');
  assert.deepEqual([rows[0].tags, rows[0].categorized], [[], null], 'no tags until something is inferred, and no category rules have been applied to it');
});

test('library: tags are a closed set beside the type, note is for md only, and which category rules a row has had is recorded', async () => {
  const library = await db.openLibraryDb(root);
  assert.deepEqual(db.LIBRARY_TAGS, ['paper', 'git', 'note']);
  const link = await library.insert({ id: randomUUID(), name: 'arXiv 1706.03762', type: 'website', url: 'https://arxiv.org/abs/1706.03762', tags: ['paper', 'paper'] });
  assert.deepEqual(link.tags, ['paper'], 'once each');
  await assert.rejects(() => library.insert({ id: randomUUID(), name: 'x', type: 'pdf', tags: ['website'] }), /Unknown library tag/);
  await assert.rejects(() => library.insert({ id: randomUUID(), name: 'x', type: 'pdf', tags: 'paper' }), /tags/);
  await assert.rejects(() => library.insert({ id: randomUUID(), name: 'x', type: 'pdf', path: '/tmp/x.pdf', tags: ['note'] }), /only a note/i);
  await assert.rejects(() => library.query("insert into library (id, name, type, tags) values ($1, 'x', 'pdf', array['note'])", [randomUUID()]), /library_note_is_md/, 'the database holds the line too');

  // `categorized` is the version of the category rules a row has had applied (null: none). A row behind the
  // current version is what re-categorizing an installed library goes through; notes and images have nothing to infer.
  const pdf = await library.insert({ id: randomUUID(), name: 'Unread', type: 'pdf', path: '/tmp/unread.pdf' });
  const settled = await library.insert({ id: randomUUID(), name: 'Settled', type: 'csv', path: '/tmp/s.csv', categorized: 1 });
  const note = await library.insert({ id: randomUUID(), name: 'A note', type: 'md', tags: ['note'], path: '/tmp/n.md' });
  const image = await library.insert({ id: randomUUID(), name: 'Attachment 1', type: 'image', path: '/tmp/1.png' });
  const behind = async (rules) => (await library.uncategorized(rules)).map((row) => row.id);
  assert.deepEqual([(await behind(1)).includes(pdf.id), (await behind(1)).includes(settled.id), (await behind(2)).includes(settled.id)], [true, false, true], 'a newer set of rules makes every row due again');
  assert.equal(await library.settleUninferable(1), 2, 'the note and the image');
  assert.deepEqual([(await library.get(note.id)).categorized, (await library.get(image.id)).categorized, (await behind(1)).includes(note.id)], [1, 1, false]);

  await library.setSummary(pdf.id, 'What it says.', new Date('2026-09-01T00:00:00Z'));
  const before = await library.get(pdf.id);
  const tagged = await library.setCategory(pdf.id, { type: 'pdf', tags: ['paper'] }, 1);
  assert.deepEqual([tagged.tags, tagged.categorized], [['paper'], 1]);
  assert.deepEqual([tagged.last_edited, tagged.summary, tagged.summary_edited, tagged.char_count], [before.last_edited, before.summary, before.summary_edited, before.char_count], 'categorizing is not an edit and leaves the summary alone');
  assert.equal((await behind(1)).includes(pdf.id), false);
  const unread = await library.setCategory(pdf.id, { type: 'pdf', tags: ['paper'] }, null);
  assert.equal(unread.categorized, 1, 'null leaves the mark where it was');
  await assert.rejects(() => library.setCategory(link.id, { type: 'website', tags: ['note'] }, 1), /only a note/i);
  await assert.rejects(() => library.setCategory(link.id, { type: 'paper', tags: [] }, 1), /Unknown library type/);
});

test('library: rename, touch, rewritePathPrefix only touches rows under the old prefix', async () => {
  const library = await db.openLibraryDb(root);
  const inside = randomUUID();
  const outside = randomUUID();
  await library.insert({ id: inside, name: 'n', type: 'md', tags: ['note'], path: '/root/Old Project/n.md', project_id: randomUUID() });
  await library.insert({ id: outside, name: 'o', type: 'md', tags: ['note'], path: '/root/Old Project 2/o.md' });
  const renamed = await library.rename(inside, 'renamed');
  assert.equal(renamed.name, 'renamed');
  const changed = await library.rewritePathPrefix('/root/Old Project/', '/root/New Project/');
  assert.equal(changed, 1);
  assert.equal((await library.get(inside)).path, '/root/New Project/n.md');
  assert.equal((await library.get(outside)).path, '/root/Old Project 2/o.md');
  assert.equal(await library.touch(inside), true);
  assert.equal(await library.remove(outside), true);
  assert.equal(await library.get(outside), null);
});

test('notes: schema, insert, rename updates path and last_edited', async () => {
  const projectDir = path.join(root, 'Project');
  fs.mkdirSync(projectDir);
  const notes = await db.openNotesDb(projectDir);
  const id = randomUUID();
  const row = await notes.insert({ id, name: 'Note', path: 'Note.md', goal_id: null, topic_id: null });
  assert.equal(row.path, 'Note.md');
  assert.equal(row.goal_id, null);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const renamed = await notes.rename(id, 'Better', 'Better.md');
  assert.equal(renamed.name, 'Better');
  assert.equal(renamed.path, 'Better.md');
  assert.ok(renamed.last_edited >= row.last_edited);
  assert.deepEqual(Object.keys(renamed).sort(), ['created', 'goal_id', 'id', 'last_edited', 'name', 'path', 'topic_id']);
  assert.equal((await notes.list()).length, 1);
  assert.equal(await db.closeDb(notes.dir), true);
  assert.equal(await db.closeDb(notes.dir), false);
  const reopened = await db.openNotesDb(projectDir);
  assert.equal((await reopened.list())[0].name, 'Better');
});

// The library table as it stood on 2026-09-21, before `type` became the format and the rest moved to `tags`.
const OLD_LIBRARY_SCHEMA = `
create table if not exists library (
  id uuid primary key,
  name text not null,
  type text not null check (type in ('note','paper','git_repo','dataset','website','image')),
  path text,
  url text,
  folder_path text,
  project_id uuid,
  created timestamptz not null default now(),
  last_edited timestamptz not null default now()
);
alter table library add column if not exists summary text;
alter table library add column if not exists summary_edited timestamptz;
alter table library add column if not exists char_count integer;
alter table library add column if not exists github_id text;
`;

test('library: a database typed the old way is converted in place, once, after a copy of it is set aside', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-db-old-'));
  const old = new PGlite(path.join(oldRoot, 'library.pglite'));
  await old.waitReady;
  await old.exec(OLD_LIBRARY_SCHEMA);
  const was = [
    ['note', 'A note', '/p/A note.md', null, null],
    ['paper', 'Downloaded', '/lib/attention.pdf', null, null],
    ['paper', 'arXiv 1706.03762', null, 'https://arxiv.org/abs/1706.03762', null],
    ['git_repo', 'o/address-only', null, 'https://github.com/o/address-only', null],
    ['git_repo', 'o/cloned', null, 'https://github.com/o/cloned', '/code/cloned'],
    ['dataset', 'rows.csv', '/data/rows.csv', null, null],
    ['dataset', 'events.ndjson', '/data/events.NDJSON', null, null],
    ['dataset', 'tables', null, null, '/data/tables'],
    ['website', 'A page', null, 'https://example.org/', null],
    ['website', 'report.html', '/pages/report.htm', 'file:///pages/report.htm', null],
    ['image', 'Attachment 1', '/p/assets/1.png', null, null],
  ];
  const ids = [];
  for (const [type, name, file, url, folder] of was) {
    const id = randomUUID();
    ids.push(id);
    await old.query("insert into library (id, name, type, path, url, folder_path, summary, summary_edited, last_edited, char_count) values ($1, $2, $3, $4, $5, $6, $7, '2026-09-10T00:00:00Z', '2026-09-09T00:00:00Z', 1234)", [id, name, type, file, url, folder, `about ${name}`]);
  }
  await old.close();

  const library = await db.openLibraryDb(oldRoot);
  const rows = await library.list();
  assert.deepEqual(rows.map((row) => row.id).sort(), [...ids].sort(), 'every row is still there under its id');
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.name, [row.type, row.tags]])), {
    'A note': ['md', ['note']],
    Downloaded: ['pdf', []], // every pdf used to be called a paper: whether this one is gets looked into
    'arXiv 1706.03762': ['website', ['paper']],
    'o/address-only': ['website', ['git']],
    'o/cloned': ['folder', ['git']],
    'rows.csv': ['csv', []],
    'events.ndjson': ['jsonl', []],
    tables: ['folder', []],
    'A page': ['website', []],
    'report.html': ['html', []],
    'Attachment 1': ['image', []],
  });
  for (const row of rows) assert.deepEqual([row.summary, row.summary_edited, row.last_edited, row.char_count], [`about ${row.name}`, '2026-09-10T00:00:00.000Z', '2026-09-09T00:00:00.000Z', 1234], `${row.name}: converted, not edited, not re-summarized`);
  assert.ok(rows.every((row) => row.categorized === null), 'every converted row is due for the category rules (library.recategorize)');
  assert.equal((await library.uncategorized(1)).length, rows.length);

  const backups = () => fs.readdirSync(path.join(oldRoot, '.backups')).filter((name) => /^library-.*\.pglite$/.test(name));
  assert.equal(backups().length, 1);
  await library.close();
  const copy = new PGlite(path.join(oldRoot, '.backups', backups()[0]));
  await copy.waitReady;
  assert.deepEqual((await copy.query('select type from library order by type')).rows.map((row) => row.type), was.map(([type]) => type).sort(), 'the copy is the database as it was');
  await copy.close();

  const again = await db.openLibraryDb(oldRoot);
  assert.deepEqual((await again.list()).map((row) => [row.type, row.tags]), rows.map((row) => [row.type, row.tags]), 'opening it again changes nothing');
  assert.equal(backups().length, 1, 'and sets nothing more aside');
});
