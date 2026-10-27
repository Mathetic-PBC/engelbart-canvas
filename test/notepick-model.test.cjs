'use strict';

// The + beside the document's tabs: find a note anywhere in the library, or make one (2026-09-25).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/notepick.js')).href);

const note = (id, name, last_edited) => ({ id, name, type: 'md', tags: ['note'], last_edited });
const library = [
  note('a', 'Middle Canvas (Workspace or Notes)', '2026-09-20T10:00:00Z'),
  note('b', 'Tabs', '2026-09-25T10:00:00Z'),
  note('c', 'Canvas ideas', '2026-09-24T10:00:00Z'),
  { id: 'p', name: 'Canvas paper', type: 'pdf', tags: ['paper'] },
  ...Array.from({ length: 10 }, (_, i) => note(`old${i}`, `Old ${i}`, `2026-01-0${(i % 9) + 1}T00:00:00Z`)),
];

test('empty: New note first, then the notes written in last, eight of them', async () => {
  const { notePickRows, NOTE_PICK_RECENT } = await load();
  const rows = notePickRows({ query: '', library });
  assert.equal(rows[0].kind, 'new');
  assert.equal(rows[0].name, '');
  assert.deepEqual(rows.slice(1, 4).map((row) => row.key), ['b', 'c', 'a']);
  assert.equal(rows.length, 1 + NOTE_PICK_RECENT);
});

test('typed: only notes, from the whole library, every word matched, names that start with it first; New note last, named as typed', async () => {
  const { notePickRows } = await load();
  const rows = notePickRows({ query: 'canvas', library });
  assert.deepEqual(rows.map((row) => row.key), ['c', 'a', 'new']); // "Canvas ideas" starts with it; the pdf is not a note
  assert.equal(rows.at(-1).name, 'canvas');
  assert.deepEqual(notePickRows({ query: 'canvas notes', library }).map((row) => row.key), ['a', 'new']);
  assert.deepEqual(notePickRows({ query: 'zzz', library }).map((row) => row.kind), ['new']);
});

test('tags: open in a tab, else in this workspace', async () => {
  const { notePickRows } = await load();
  const rows = notePickRows({ query: 'canvas', library, openIds: ['a'], inRail: (id) => id === 'c' });
  assert.deepEqual(rows.filter((row) => row.kind === 'note').map((row) => row.tag), ['here', 'open']);
});

test('the split icon\'s menu (MATH-84): the workspaces written in last after the notes, four of them; typed, every match', async () => {
  const { notePickRows, NOTE_PICK_RECENT, SPACE_PICK_RECENT } = await load();
  const workspaces = Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, name: i === 5 ? 'Canvas plans' : `Space ${i}` }));
  const rows = notePickRows({ query: '', library, workspaces, openIds: ['w1'] });
  assert.equal(rows.length, 1 + NOTE_PICK_RECENT + SPACE_PICK_RECENT);
  assert.deepEqual(rows.slice(-SPACE_PICK_RECENT).map((row) => [row.kind, row.key, row.tag]), [['workspace', 'ws:w0', ''], ['workspace', 'ws:w1', 'open'], ['workspace', 'ws:w2', ''], ['workspace', 'ws:w3', '']]);
  assert.deepEqual(rows[rows.length - 1].row, { id: 'w3', name: 'Space 3' });
  const typed = notePickRows({ query: 'canvas', library, workspaces });
  assert.deepEqual(typed.map((row) => row.kind), ['note', 'note', 'workspace', 'new'], 'notes, then workspaces, then New note');
  assert.equal(typed[2].name, 'Canvas plans');
  assert.equal(notePickRows({ query: '', library }).some((row) => row.kind === 'workspace'), false, 'the +\'s menu: notes only, as before');
});
