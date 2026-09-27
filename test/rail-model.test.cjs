'use strict';

// The workspace sidebar's search and the document's @ menu (Canvas.dc.html, Add - Mention.dc.html, 2026-09-22).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/rail.js')).href);

const row = (id, name, type, tags = [], more = {}) => ({ id, name, type, tags, ...more });
const library = [
  row('n1', 'Saving and importing library items', 'md', ['note']),
  row('p1', 'ColBERT', 'pdf', ['paper'], { path: '/Users/h/ColBERT.pdf' }),
  row('g1', 'VectifyAI/PageIndex', 'website', ['git'], { url: 'https://github.com/VectifyAI/PageIndex' }),
  row('w1', 'Contextual Retrieval', 'website', [], { url: 'https://www.anthropic.com/engineering/contextual-retrieval' }),
  row('i1', 'Attachment 1', 'image'),
  row('c1', 'problems.csv', 'csv', [], { path: '/Users/h/problems.csv' }),
  row('f1', 'fixtures', 'folder', [], { folder_path: '/Users/h/fixtures' }),
];

test('looksAddable: addresses, arXiv and DOI ids, remotes and paths, by their spelling', async () => {
  const { looksAddable } = await load();
  for (const yes of ['https://example.org/a', 'arxiv:2310.05292', '2310.05292v2', 'doi:10.1145/3544548.3580919', 'git@github.com:o/r.git', 'ssh://git@host/o/r', '~/papers/x.pdf', '/Users/h/x', 'file:///Users/h/x.html', '"https://example.org/q"']) assert.equal(looksAddable(yes), true, yes);
  for (const no of ['', 'colbert', 'Contextual Retrieval', 'notes/today.md', 'https://', 'a b']) assert.equal(looksAddable(no), false, no);
});

test('search: empty offers four things not here yet; typed, every match in the library, what is here included as `here`; no Note or Workspace rows (2026-09-22)', async () => {
  const { searchRows } = await load();
  const inRail = (id) => id === 'p1';
  const empty = searchRows({ query: '', library, inRail });
  assert.deepEqual(empty.map((r) => r.key), ['g1', 'w1', 'c1', 'f1'], 'no notes, no pictures, nothing already here, at most four');
  assert.deepEqual(empty.map((r) => r.tag), ['link · git', 'link', 'csv', 'folder']);
  assert.deepEqual(searchRows({ query: 'retriev', library, inRail }).map((r) => r.key), ['w1'], 'making a note or a workspace is the +\'s job now');
  assert.deepEqual(searchRows({ query: 'colbert', library, inRail }).map((r) => [r.key, r.tag]), [['p1', 'here']], 'what is here already is found too');
  assert.deepEqual(searchRows({ query: 'import', library, inRail }).map((r) => r.key)[0], 'n1', 'a note is found by name');
  assert.deepEqual(searchRows({ query: 'anthropic.com', library, inRail }).map((r) => r.key)[0], 'w1', 'and a page by its address');
  const many = Array.from({ length: 60 }, (_, i) => row(`m${i}`, `Match ${i}`, 'website', [], { url: `https://example.org/${i}` }));
  assert.equal(searchRows({ query: 'match', library: many, inRail }).length, 60, 'no cap: all of the library is searched and shown');
});

test('search: an address or a path is the one row the library has for it, or a new one, once the main process has answered', async () => {
  const { searchRows } = await load();
  const inRail = (id) => id === 'p1';
  const query = 'https://example.org/new-page';
  assert.deepEqual(searchRows({ query, library, inRail, found: undefined }), [], 'still asking');
  assert.deepEqual(searchRows({ query, library, inRail, found: { row: null, found: null, error: 'Nothing is at that path' } }), []);
  const fresh = searchRows({ query, library, inRail, found: { row: null, found: { type: 'website', tags: [], name: 'example.org/new-page', url: query }, error: null } });
  assert.deepEqual([fresh.length, fresh[0].kind, fresh[0].name, fresh[0].tag], [1, 'fresh', 'example.org/new-page', 'new link']);
  assert.deepEqual(searchRows({ query: '/Users/h/ColBERT.pdf', library, inRail, found: { row: library[1], found: {}, error: null } }).map((r) => [r.key, r.tag]), [['p1', 'here']]);
  assert.deepEqual(searchRows({ query: 'https://github.com/VectifyAI/PageIndex', library, inRail, found: { row: library[2], found: {}, error: null } }).map((r) => [r.key, r.tag]), [['g1', 'link · git']]);
});

test('@ menu: Bart, Task and Note first by their first letters, the open page next, then ten from the library; no workspaces', async () => {
  const { mentionRows } = await load();
  const many = [...library, ...Array.from({ length: 12 }, (_, i) => row(`x${i}`, `Extra ${i}`, 'website', [], { url: `https://example.org/${i}` }))];
  const all = mentionRows({ query: '', library: many, page: null, pageRow: null });
  assert.deepEqual(all.slice(0, 3).map((r) => r.name), ['Bart', 'Task', 'Note']);
  assert.equal(all.length, 3 + 10, 'ten from the library');
  assert.equal(all.some((r) => r.key === 'i1'), false, 'pictures are not mentioned by hand');
  assert.deepEqual(mentionRows({ query: 'b', library, page: null, pageRow: null }).map((r) => r.name).slice(0, 1), ['Bart']);
  assert.deepEqual(mentionRows({ query: 'no', library, page: null, pageRow: null }).map((r) => r.key), ['verb:note', 'n1'], 'a verb by its first letters; a library row by its words, which include "md · note"');
  assert.deepEqual(mentionRows({ query: 'as', library, page: null, pageRow: null }).map((r) => r.key), [], 'Task is not matched from its middle');
  assert.deepEqual(mentionRows({ query: 'import', library, page: null, pageRow: null }).map((r) => r.key), ['n1']);

  const page = { input: 'https://arxiv.org/pdf/2005.11401', title: 'Retrieval-Augmented Generation [RAG]' };
  const fresh = mentionRows({ query: '', library, page, pageRow: null });
  assert.deepEqual([fresh[3].kind, fresh[3].name, fresh[3].input, fresh[3].open], ['fresh', 'Retrieval-Augmented Generation RAG', page.input, true], 'the open page leads the library, named so a mention can hold it');
  const held = mentionRows({ query: 'contextual', library, page: { input: 'https://www.anthropic.com/engineering/contextual-retrieval', title: 'Contextual Retrieval' }, pageRow: library[3] });
  assert.deepEqual(held.map((r) => [r.key, !!r.open]), [['w1', true]], 'a page the library holds is that row, once');
  assert.deepEqual(mentionRows({ query: 'colbert', library, page, pageRow: null }).map((r) => r.key), ['p1'], 'the page is left out when it does not match');
});

test('@Bart, as the menu writes it, is a question like a typed @bart; both render as a token (2026-09-22)', async () => {
  const doc = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(doc.parseLine('@Bart what is here?'), doc.parseLine('@bart what is here?'));
  assert.equal(doc.parseLine('@Bart what is here?').type, 'bart');
  assert.deepEqual('@Bart hi'.split(doc.INLINE).filter(Boolean), ['@Bart', ' hi']);
  assert.match(doc.inlineHtml('@Bart hi'), /<span style="color:#0070f3;font-weight:500">@Bart<\/span> hi/);
  assert.equal(doc.parseLine('@Barty').type === 'bart', false);
});

test('sections: Notes, Websites, GitHub, Files, Sub-Workspaces in that order; Files takes everything else; empty ones are left out (Sidebar.dc.html, 2026-09-23)', async () => {
  const { railSections, sectionOf } = await load();
  const rows = [...library, row('k1', 'Evaluation harness', 'child'), row('g2', 'engelbart-canvas', 'folder', ['git'], { folder_path: '/Users/h/e' }), row('h1', 'saved.html', 'html')];
  const sections = railSections(rows);
  assert.deepEqual(sections.map((s) => s.label), ['Notes', 'Websites', 'GitHub', 'Files', 'Sub-Workspaces']);
  assert.deepEqual(sections.map((s) => s.rows.map((r) => r.id)), [['n1'], ['w1'], ['g1', 'g2'], ['p1', 'i1', 'c1', 'f1', 'h1'], ['k1']]);
  assert.equal(sectionOf(row('m1', 'README', 'md')), 'Files', 'an outside md is a file, not a note');
  assert.deepEqual(railSections([row('p1', 'ColBERT', 'pdf', ['paper'])]).map((s) => s.key), ['Files']);
  assert.deepEqual(railSections([]), []);
});

test('the @ menu offers the project\'s other workspaces after the page and before the library (2026-09-25)', async () => {
  const { mentionRows } = await load();
  const workspaces = [
    { id: 'a', name: 'Agents', above: [] },
    { id: 'b', name: 'Inline chat agent', above: ['Agents'] },
    { id: 'c', name: 'Pulling in workspaces', above: [] },
    { id: 'd', name: 'Reading', above: [] },
    { id: 'e', name: 'Writing', above: [] },
  ];
  const empty = mentionRows({ query: '', library, page: null, pageRow: null, workspaces, hereId: 'a' });
  assert.deepEqual(empty.filter((r) => r.kind === 'workspace').map((r) => r.id), ['b', 'c', 'd'], 'three, in the order given, never the one you are in');
  assert.equal(empty.findIndex((r) => r.kind === 'workspace'), 3, 'right after Bart, Task and Note');
  const typed = mentionRows({ query: 'ag', library, page: null, pageRow: null, workspaces, hereId: 'c' });
  assert.deepEqual(typed.filter((r) => r.kind === 'workspace').map((r) => [r.id, r.above]), [['a', []], ['b', ['Agents']]], 'names that start with the words first, each with what is above it');
  assert.deepEqual(typed[0], { kind: 'workspace', key: 'ws:a', id: 'a', name: 'Agents', above: [] });
  assert.deepEqual(mentionRows({ query: 'colbert', library, page: null, pageRow: null, workspaces }).map((r) => r.key), ['p1']);
});

test('the Archived section: a workspace\'s earlier versions, last, and only when there are some (2026-09-25)', async () => {
  const { railSections, sectionOf, RAIL_SECTIONS } = await load();
  assert.equal(RAIL_SECTIONS[RAIL_SECTIONS.length - 1].label, 'Archived');
  assert.equal(sectionOf({ type: 'archive' }), 'Archived');
  const rows = [{ id: 'archive:2026-09-25T21-03-12Z', type: 'archive', name: 'Storage plan' }, { id: 'n1', type: 'md', tags: ['note'], name: 'Spec' }];
  assert.deepEqual(railSections(rows).map((s) => [s.key, s.rows.map((r) => r.id)]), [['Notes', ['n1']], ['Archived', ['archive:2026-09-25T21-03-12Z']]]);
  assert.ok(!railSections([rows[1]]).some((s) => s.key === 'Archived'), 'no versions, no section');
});
