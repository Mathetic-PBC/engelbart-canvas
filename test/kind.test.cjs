'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/kind.js')).href);

test('Run is available for saved GitHub repositories, including existing clones', async () => {
  const { canRunRepository } = await load();
  for (const type of ['website', 'folder']) {
    assert.equal(canRunRepository({ type, tags: ['git'], url: 'https://github.com/mqo00/rope' }), true);
  }
  for (const row of [null, {}, { tags: ['git'] },
    { tags: [], url: 'https://github.com/mqo00/rope' },
    { tags: ['git'], url: 'https://github.com/mqo00' },
    { tags: ['git'], url: 'https://github.com.evil.example/mqo00/rope' },
    { tags: ['git'], url: 'https://gitlab.com/mqo00/rope' }]) {
    assert.equal(canRunRepository(row), false);
  }
});

test('how a row is shown: the type says what it is, the tags say the rest, and nothing is read out of the type alone', async () => {
  const { kindKey, kindLabel, kindRank, isNote } = await load();
  const rows = {
    note: { type: 'md', tags: ['note'] },
    outsideMd: { type: 'md', tags: [] },
    paper: { type: 'pdf', tags: ['paper'] },
    invoice: { type: 'pdf', tags: [] },
    arxiv: { type: 'website', tags: ['paper'] },
    repoAddress: { type: 'website', tags: ['git'] },
    clone: { type: 'folder', tags: ['git'] },
    folder: { type: 'folder', tags: [] },
    page: { type: 'website', tags: [] },
    html: { type: 'html', tags: [] },
    csv: { type: 'csv', tags: [] },
    parquet: { type: 'parquet', tags: [] },
    image: { type: 'image', tags: [] },
  };
  const keys = Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, kindKey(row)]));
  assert.deepEqual(keys, { note: 'note', outsideMd: 'md', paper: 'pdf', invoice: 'pdf', arxiv: 'website', repoAddress: 'git', clone: 'git', folder: 'folder', page: 'website', html: 'html', csv: 'data', parquet: 'data', image: 'image' });
  assert.deepEqual([isNote(rows.note), isNote(rows.outsideMd), isNote(null), isNote({ type: 'note' })], [true, false, false, false], 'only the tag makes a note');
  assert.deepEqual([kindLabel(rows.note), kindLabel(rows.paper), kindLabel(rows.invoice), kindLabel(rows.arxiv), kindLabel(rows.clone), kindLabel(rows.csv)], ['md · note', 'pdf · paper', 'pdf', 'link · paper', 'folder · git', 'csv']);
  const sorted = Object.keys(rows).sort((a, b) => kindRank(rows[a]) - kindRank(rows[b]) || a.localeCompare(b));
  assert.deepEqual(sorted, ['note', 'outsideMd', 'invoice', 'paper', 'clone', 'repoAddress', 'folder', 'arxiv', 'page', 'html', 'csv', 'parquet', 'image']);
  // the editor's stand-ins (an unresolved mention, @bart, Task, a workspace row) have no tags and still get a glyph
  assert.deepEqual([kindKey({ type: 'note' }), kindKey({ type: 'chat' }), kindKey({ type: 'task' }), kindKey({ type: 'workspace' }), kindKey(undefined)], ['note', 'chat', 'task', 'workspace', 'note']);
});
