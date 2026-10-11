'use strict';

// The Library window's lists (2026-10-11, Phase C first cut): src/renderer/model/library-view.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/library-view.js')).href);

test('the add bar sends 450 ids in three calls of at most 200, and says one total', async () => {
  const { batches, addedLine, PROJECT_BATCH } = await load();
  const ids = Array.from({ length: 450 }, (_, i) => `id${i}`);
  const sent = batches(ids);
  assert.equal(PROJECT_BATCH, 200);
  assert.deepEqual(sent.map((one) => one.length), [200, 200, 50]);
  assert.deepEqual(sent.flat(), ids, 'every id once, in order');
  assert.equal(addedLine([{ added: 200, inWorkspace: 200 }, { added: 200, inWorkspace: 100 }, { added: 50, inWorkspace: 0 }], 'Thesis'), 'Added 450 to Thesis. 300 are also in this workspace.');
  assert.equal(addedLine([{ added: 3, inWorkspace: 3 }], 'Thesis'), 'Added 3 to Thesis. They are also in this workspace.');
  assert.equal(addedLine([{ added: 200, inWorkspace: 0 }, { error: 'Not in the library: x', ids: ['a', 'b'] }], 'Thesis'), 'Added 200 to Thesis. 2 did not go in: Not in the library: x');
});

test('rows: no pictures, newest first, a chip narrows, typing ranks by name first', async () => {
  const { libraryViewRows } = await load();
  const rows = [
    { id: 'a', name: 'Old paper', type: 'pdf', tags: ['paper'], last_edited: '2026-01-01T00:00:00Z' },
    { id: 'b', name: 'Fresh note', type: 'md', tags: ['note'], last_edited: '2026-10-10T00:00:00Z' },
    { id: 'c', name: 'Pasted', type: 'image', tags: [], last_edited: '2026-10-11T00:00:00Z' },
    { id: 'd', name: 'Notes on transfer', type: 'md', tags: ['note'], summary: 'paper about transfer', last_edited: '2026-05-01T00:00:00Z' },
  ];
  assert.deepEqual(libraryViewRows({ rows }).map((row) => row.id), ['b', 'd', 'a']);
  assert.deepEqual(libraryViewRows({ rows, chip: 'papers' }).map((row) => row.id), ['a']);
  assert.deepEqual(libraryViewRows({ rows, query: 'paper' }).map((row) => row.id), ['a', 'd'], 'the name first, then the summary');
});

test('dates and where a row is: words within a week, then the day; made here, its workspaces, or the project\'s list', async () => {
  const { libraryDate, whereLine, placeOf } = await load();
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(libraryDate({ last_edited: '2026-10-11T10:00:00Z' }, now), '2 h ago');
  assert.match(libraryDate({ last_edited: '2026-09-03T12:00:00Z' }, now), /^Sep \d$/);
  assert.match(libraryDate({ created: '2025-03-02T12:00:00Z' }, now), /^Mar \d, 2025$/);
  assert.equal(libraryDate({}, now), '');
  assert.equal(whereLine({ origin: true }, 'project'), 'Made in this project');
  assert.equal(whereLine({ workspaces: ['Pilot', 'Agents/Inline'] }, 'project'), 'Pilot, Agents/Inline');
  assert.equal(whereLine({ workspaces: [] }, 'project'), 'Project library');
  assert.equal(placeOf({ url: 'https://www.arxiv.org/abs/1' }), 'arxiv.org');
  assert.equal(placeOf({ path: '/Users/me/.engelbart/assets/md/x/Chat.md' }), 'Engelbart');
  assert.equal(placeOf({ path: '/Users/me/Documents/Papers/a.pdf' }), 'Documents/Papers');
  assert.equal(placeOf({ path: '/Users/me/.engelbart/thesis/Pilot notes.md' }), 'Engelbart', 'a note written in a project');
  assert.equal(placeOf({ folder_path: '/Users/me/code/engelbart' }), 'code/engelbart');
});

test('Open full library opens the Library window, not the projects screen', () => {
  const fs = require('node:fs');
  const rail = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Rail.jsx'), 'utf8');
  assert.match(rail, /onOpenFull=\{\(\) => setFullLibrary\(true\)\}/);
  assert.match(rail, /<LibraryModal project=\{project\} workspaceId=\{hereId\}/);
});
