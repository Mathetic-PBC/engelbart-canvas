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
  const row = await library.insert({ id, name: 'A paper', type: 'paper', path: '/tmp/a.pdf' });
  assert.equal(row.id, id);
  assert.equal(row.type, 'paper');
  assert.equal(row.url, null);
  assert.match(row.created, /^\d{4}-\d{2}-\d{2}T/);
  await assert.rejects(() => library.insert({ id: randomUUID(), name: 'x', type: 'chat' }), /Unknown library type/);
  await library.insert({ id: randomUUID(), name: 'Site', type: 'website', url: 'https://example.com' });
  const rows = await library.list();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'A paper');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['char_count', 'created', 'folder_path', 'id', 'last_edited', 'name', 'path', 'project_id', 'summary', 'summary_edited', 'type', 'url']);
  assert.deepEqual([rows[0].summary, rows[0].summary_edited, rows[0].char_count], [null, null, null], 'the catalog columns default to null');
});

test('library: rename, touch, rewritePathPrefix only touches rows under the old prefix', async () => {
  const library = await db.openLibraryDb(root);
  const inside = randomUUID();
  const outside = randomUUID();
  await library.insert({ id: inside, name: 'n', type: 'note', path: '/root/Old Project/n.md', project_id: randomUUID() });
  await library.insert({ id: outside, name: 'o', type: 'note', path: '/root/Old Project 2/o.md' });
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
