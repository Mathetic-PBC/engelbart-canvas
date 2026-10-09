'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/kind.js')).href);

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

test('the Library panel\'s chips: each kind under one chip, a repository address under Repos not Web, pictures under none', async () => {
  const { libraryFilter, libraryCounts, LIBRARY_CHIPS } = await load();
  const rows = {
    note: { type: 'md', tags: ['note'] },
    mdFile: { type: 'md', tags: [] },
    pdf: { type: 'pdf', tags: ['paper'] },
    gitFolder: { type: 'folder', tags: ['git'] },
    gitAddress: { type: 'website', tags: ['git'], name: 'tinygrad/tinygrad' },
    website: { type: 'website', tags: [] },
    html: { type: 'html', tags: [] },
    docx: { type: 'docx', tags: [] },
    folder: { type: 'folder', tags: [] },
    csv: { type: 'csv', tags: [] },
    image: { type: 'image', tags: [] },
  };
  const chips = LIBRARY_CHIPS.map((chip) => chip.id).filter((id) => id !== 'all');
  assert.deepEqual(chips, ['notes', 'papers', 'repos', 'web', 'files']);
  const under = Object.fromEntries(Object.entries(rows).map(([name, row]) => [name, chips.filter((chip) => libraryFilter(row, chip))]));
  assert.deepEqual(under, {
    note: ['notes'], mdFile: ['files'], pdf: ['papers'], gitFolder: ['repos'], gitAddress: ['repos'], website: ['web'], html: ['web'],
    docx: ['files'], folder: ['files'], csv: ['files'], image: [],
  });
  assert.equal(Object.values(rows).filter((row) => libraryFilter(row, 'all')).length, 10, 'All is everything but the picture');
  assert.equal(libraryFilter(rows.pdf), true, 'no chip is All');
  assert.deepEqual(libraryCounts(Object.values(rows)), { all: 10, notes: 1, papers: 1, repos: 2, web: 2, files: 4 });
});
