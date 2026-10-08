'use strict';

// The library's searches and the document's @ menu (Canvas.dc.html, Add - Mention.dc.html, 2026-09-22). What the sidebar
// lists (its groups, its workspaces, each section's share) is test/sidebar-model.test.cjs's.

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

test('@ menu: Bart, Note, Brainstorm and Discover first by their first letters, the open page next, then ten from the library; no workspaces', async () => {
  const { mentionRows } = await load();
  const many = [...library, ...Array.from({ length: 12 }, (_, i) => row(`x${i}`, `Extra ${i}`, 'website', [], { url: `https://example.org/${i}` }))];
  const all = mentionRows({ query: '', library: many, page: null, pageRow: null });
  assert.deepEqual(all.slice(0, 4).map((r) => r.name), ['Bart', 'Note', 'Brainstorm', 'Discover']);
  assert.equal(all.length, 4 + 10, 'ten from the library');
  assert.equal(all.some((r) => r.key === 'i1'), false, 'pictures are not mentioned by hand');
  assert.deepEqual(mentionRows({ query: 'b', library, page: null, pageRow: null }).map((r) => r.name).slice(0, 2), ['Bart', 'Brainstorm']);
  assert.deepEqual(mentionRows({ query: 'br', library, page: null, pageRow: null }).map((r) => r.key)[0], 'verb:brainstorm', '@brainstorm by its first letters (2026-09-30)');
  assert.deepEqual(mentionRows({ query: 'dis', library, page: null, pageRow: null }).map((r) => r.key)[0], 'verb:discover', '@discover by its first letters (2026-09-30)');
  assert.ok(!mentionRows({ query: 'or', library, page: null, pageRow: null }).some((r) => r.kind === 'verb'), 'no Orient: it went into Brainstorm (2026-10-05)');
  assert.deepEqual(mentionRows({ query: 'no', library, page: null, pageRow: null }).map((r) => r.key), ['verb:note', 'n1'], 'a verb by its first letters; a library row by its words, which include "md · note"');
  assert.deepEqual(mentionRows({ query: 'as', library, page: null, pageRow: null }).map((r) => r.key), [], 'Note is not matched from its middle; there is no Task (2026-09-29)');
  assert.deepEqual(mentionRows({ query: 'import', library, page: null, pageRow: null }).map((r) => r.key), ['n1']);

  const page = { input: 'https://arxiv.org/pdf/2005.11401', title: 'Retrieval-Augmented Generation [RAG]' };
  const fresh = mentionRows({ query: '', library, page, pageRow: null });
  assert.deepEqual([fresh[4].kind, fresh[4].name, fresh[4].input, fresh[4].open], ['fresh', 'Retrieval-Augmented Generation RAG', page.input, true], 'the open page leads the library, named so a mention can hold it');
  const held = mentionRows({ query: 'contextual', library, page: { input: 'https://www.anthropic.com/engineering/contextual-retrieval', title: 'Contextual Retrieval' }, pageRow: library[3] });
  assert.deepEqual(held.map((r) => [r.key, !!r.open]), [['w1', true]], 'a page the library holds is that row, once');
  assert.deepEqual(mentionRows({ query: 'colbert', library, page, pageRow: null }).map((r) => r.key), ['p1'], 'the page is left out when it does not match');
});

test('@ menu in a follow-up field: the same rows less Bart, Note, Brainstorm and Discover (2026-10-02)', async () => {
  const { mentionRows, fieldRows, isVerbRow } = await load();
  const page = { input: 'https://arxiv.org/pdf/2005.11401', title: 'Retrieval-Augmented Generation' };
  const workspaces = [{ id: 'ws1', name: 'Brainstorm notes', above: [] }];
  const all = mentionRows({ query: '', library, page, pageRow: null, workspaces });
  assert.deepEqual(fieldRows(all).map((r) => r.key), all.slice(4).map((r) => r.key), 'the verbs lead the menu; everything after them stays, in order');
  assert.deepEqual(fieldRows(all).slice(0, 2).map((r) => r.kind), ['fresh', 'workspace'], 'the open page (added when picked) and the workspaces are kept');
  assert.deepEqual(fieldRows(mentionRows({ query: 'br', library, page: null, pageRow: null, workspaces })).map((r) => r.key), ['ws:ws1', 'n1'], 'a workspace named like a verb is still a mention (and "library" holds "br")');
  assert.deepEqual(fieldRows(mentionRows({ query: 'no', library, page: null, pageRow: null })).map((r) => r.key), ['n1']);
  // An editor with no list of its own (DocEditor's `mentionable`) names Bart and the agents by id.
  assert.deepEqual(fieldRows([{ id: 'bart', name: 'bart' }, { id: 'brainstorm' }, { id: 'discover' }, library[0], null]).map((r) => r.id), ['n1']);
  assert.equal(isVerbRow(null), false);
});

test('@Bart, as the menu writes it, is a question like a typed @bart; both render as a token (2026-09-22)', async () => {
  const doc = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
  assert.deepEqual(doc.parseLine('@Bart what is here?'), doc.parseLine('@bart what is here?'));
  assert.equal(doc.parseLine('@Bart what is here?').type, 'bart');
  assert.deepEqual('@Bart hi'.split(doc.INLINE).filter(Boolean), ['@Bart', ' hi']);
  assert.match(doc.inlineHtml('@Bart hi'), /<span style="color:#0070f3;font-weight:500">@Bart<\/span> hi/);
  assert.equal(doc.parseLine('@Barty').type === 'bart', false);
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
  assert.equal(empty.findIndex((r) => r.kind === 'workspace'), 4, 'right after Bart, Note, Brainstorm and Discover');
  const typed = mentionRows({ query: 'ag', library, page: null, pageRow: null, workspaces, hereId: 'c' });
  assert.deepEqual(typed.filter((r) => r.kind === 'workspace').map((r) => [r.id, r.above]), [['a', []], ['b', ['Agents']]], 'names that start with the words first, each with what is above it');
  assert.deepEqual(typed[0], { kind: 'workspace', key: 'ws:a', id: 'a', name: 'Agents', above: [] });
  assert.deepEqual(mentionRows({ query: 'colbert', library, page: null, pageRow: null, workspaces }).map((r) => r.key), ['p1']);
});

test('"Add from library" in the Build panel: the ones written in last before anything is typed, then every match; no pictures, nothing attached already (2026-09-27)', async () => {
  const { attachRows } = await load();
  const dated = library.map((r, i) => ({ ...r, last_edited: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  const inRail = (id) => id === 'p1';
  const empty = attachRows({ query: '', library: dated, taken: ['f1'], inRail });
  assert.deepEqual(empty.map((r) => r.key), ['c1', 'w1', 'g1', 'p1', 'n1'], 'newest first; the picture and what is attached are left out');
  assert.deepEqual(empty.find((r) => r.key === 'p1').tag, 'here');
  assert.deepEqual(attachRows({ query: 'retrieval contextual', library: dated }).map((r) => r.key), ['w1'], 'every word, in any order');
  assert.deepEqual(attachRows({ query: 'c', library: dated }).map((r) => r.key).slice(0, 3), ['w1', 'p1', 'c1'], 'names that start with it first, then the newest');
  const many = Array.from({ length: 30 }, (_, i) => row(`m${i}`, `Match ${i}`, 'website'));
  assert.equal(attachRows({ query: '', library: many }).length, 8);
  assert.equal(attachRows({ query: 'match', library: many }).length, 30);
});

/* -------------------------------------------------------- what things say (MATH-29) */

const said = (items = {}, workspaces = {}) => ({ items, workspaces });

test('a row\'s summary is searched like its name, with or without bodies (MATH-29)', async () => {
  const { searchRows, mentionRows, attachRows } = await load();
  const summed = [...library, row('s1', 'Lewis et al.', 'website', ['paper'], { url: 'https://arxiv.org/abs/2005.11401', summary: 'Retrieval-Augmented GENERATION for knowledge-intensive tasks.' })];
  assert.deepEqual(searchRows({ query: 'augmented generation', library: summed, inRail: () => false }).map((r) => r.key), ['s1']);
  assert.deepEqual(mentionRows({ query: 'Augmented', library: summed, page: null, pageRow: null }).map((r) => r.key), ['s1']);
  assert.deepEqual(attachRows({ query: 'knowledge lewis', library: summed }).map((r) => r.key), ['s1']);
});

test('the sidebar\'s search: a row found only by what it says comes after the rows its name finds; case does not matter; without bodies, as before (MATH-29)', async () => {
  const { searchRows, bodyMaps } = await load();
  const inRail = (id) => id === 'p1';
  const bodies = bodyMaps(said({ p1: 'Late Interaction over BERT, for passage RETRIEVAL.', n1: 'Notes on retrieval at scale.', c1: 'id,title' }));
  assert.ok(bodies.items instanceof Map && bodies.workspaces instanceof Map);
  assert.equal(bodies.items.get('p1'), 'late interaction over bert, for passage retrieval.', 'lowercased once, when the answer comes');
  const found = searchRows({ query: 'retrieval', library, inRail, bodies });
  assert.deepEqual(found.map((r) => r.key), ['w1', 'n1', 'p1'], 'the name match first, then the text matches in the library\'s order');
  assert.deepEqual(found.map((r) => r.tag), ['link', 'md · note', 'here'], 'a row found by its text looks like any other');
  assert.deepEqual(found.map((r) => Object.keys(r).sort()), found.map(() => ['key', 'kind', 'name', 'row', 'tag']), 'no snippet');
  assert.deepEqual(searchRows({ query: 'PASSAGE Retrieval', library, inRail, bodies }).map((r) => r.key), ['p1'], 'the whole phrase, in any case');
  assert.deepEqual(searchRows({ query: 'passage retrieval', library, inRail }).map((r) => r.key), [], 'no bodies: only names, places, kinds and summaries');
  for (const query of ['retrieval', 'colbert', 'import', '', 'xyz']) {
    const before = searchRows({ query, library, inRail }).map((r) => r.key);
    assert.deepEqual(searchRows({ query, library, inRail, bodies: null }).map((r) => r.key), before, query);
    assert.deepEqual(searchRows({ query, library, inRail, bodies: bodyMaps({}) }).map((r) => r.key), before, query);
  }
  assert.deepEqual(searchRows({ query: '', library, inRail, bodies }).map((r) => r.key), ['g1', 'w1', 'c1', 'f1'], 'empty: the same four');
  // An address or a path goes to the main process as before; what things say plays no part.
  const address = 'https://example.org/new-page';
  const withAddress = bodyMaps(said({ n1: `see ${address}` }));
  assert.deepEqual(searchRows({ query: address, library, inRail, bodies: withAddress, found: undefined }), []);
  assert.deepEqual(searchRows({ query: '/Users/h/ColBERT.pdf', library, inRail, bodies: withAddress, found: { row: library[1], found: {}, error: null } }).map((r) => r.key), ['p1']);
});

test('the @ menu: library rows and workspaces found only by what they say come after the ones their names find, within the same caps (MATH-29)', async () => {
  const { mentionRows, bodyMaps } = await load();
  const workspaces = [
    { id: 'a', name: 'Late interaction', above: [] },
    { id: 'b', name: 'Reading', above: [] },
    { id: 'c', name: 'Writing', above: ['Reading'] },
    { id: 'd', name: 'Here', above: [] },
  ];
  const bodies = bodyMaps(said({ p1: 'ColBERT: efficient passage search via LATE INTERACTION.' }, { c: 'We compared late interaction with dense retrieval.', b: 'nothing about it', d: 'late interaction, written here' }));
  const menu = mentionRows({ query: 'late interaction', library, page: null, pageRow: null, workspaces, hereId: 'd', bodies });
  assert.deepEqual(menu.map((r) => r.key), ['ws:a', 'ws:c', 'p1'], 'the workspace by its name, then the one by its document (never the one you are in), then the paper by its text');
  assert.deepEqual(menu[1], { kind: 'workspace', key: 'ws:c', id: 'c', name: 'Writing', above: ['Reading'] }, 'a workspace found by its document looks like any other');
  assert.deepEqual(mentionRows({ query: 'Late Interaction', library, page: null, pageRow: null, workspaces, hereId: 'd' }).map((r) => r.key), ['ws:a'], 'no bodies: names only');
  assert.deepEqual(mentionRows({ query: 'LATE INTERACTION', library, page: null, pageRow: null, workspaces, hereId: 'd', bodies }).map((r) => r.key), ['ws:a', 'ws:c', 'p1'], 'case does not matter');
  assert.deepEqual(mentionRows({ query: 'retrieval', library, page: null, pageRow: null, workspaces, bodies }).map((r) => r.key), ['ws:c', 'w1'], 'a workspace by its document; the page by its name');

  // Ten library rows at most, and six workspaces at most: what is found by name fills them first.
  const named = Array.from({ length: 10 }, (_, i) => row(`m${i}`, `Interaction ${i}`, 'website', [], { url: `https://example.org/${i}` }));
  const capped = mentionRows({ query: 'interaction', library: [row('t1', 'Talk', 'website', [], { url: 'https://example.org/t' }), ...named], page: null, pageRow: null, bodies: bodyMaps(said({ t1: 'an interaction' })) });
  assert.deepEqual(capped.map((r) => r.key), named.map((r) => r.id), 'the row found by its text is past the ten');
  assert.deepEqual(mentionRows({ query: 'interaction', library: [row('t1', 'Talk', 'website'), ...named.slice(0, 9)], page: null, pageRow: null, bodies: bodyMaps(said({ t1: 'an interaction' })) }).map((r) => r.key).slice(-1), ['t1'], 'with room, it is last');
  const many = Array.from({ length: 6 }, (_, i) => ({ id: `n${i}`, name: `Interaction ${i}`, above: [] }));
  const spaces = (list) => mentionRows({ query: 'interaction', library: [], page: null, pageRow: null, workspaces: list, bodies: bodyMaps(said({}, { z: 'interaction' })) }).filter((r) => r.kind === 'workspace').map((r) => r.id);
  assert.deepEqual(spaces([{ id: 'z', name: 'Zed', above: [] }, ...many]), many.map((w) => w.id), 'six by name; the one by its document is past the cap');
  assert.deepEqual(spaces([{ id: 'z', name: 'Zed', above: [] }, ...many.slice(0, 2)]), ['n0', 'n1', 'z']);
});

test('"Add from library": every word in the name, place, kind or summary first; then every word there or in what the row says, newest first (MATH-29)', async () => {
  const { attachRows, bodyMaps } = await load();
  const dated = library.map((r, i) => ({ ...r, last_edited: `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00Z` }));
  const bodies = bodyMaps(said({ n1: 'How RETRIEVAL works here.', p1: 'Late interaction retrieval.', i1: 'retrieval' }));
  assert.deepEqual(attachRows({ query: 'retrieval', library: dated, bodies }).map((r) => r.key), ['w1', 'p1', 'n1'], 'the name match, then the text matches newest first; never a picture');
  assert.deepEqual(attachRows({ query: 'colbert late', library: dated, bodies }).map((r) => r.key), ['p1'], 'one word in the name, the other in the text');
  assert.deepEqual(attachRows({ query: 'Late Interaction', library: dated, bodies }).map((r) => r.key), ['p1'], 'case does not matter');
  assert.deepEqual(attachRows({ query: 'retrieval', library: dated, bodies, taken: ['p1'] }).map((r) => r.key), ['w1', 'n1'], 'what is attached already stays out');
  assert.deepEqual(attachRows({ query: 'colbert late', library: dated }).map((r) => r.key), [], 'no bodies: as before');
  for (const query of ['', 'c', 'retrieval contextual']) {
    assert.deepEqual(attachRows({ query, library: dated, bodies: null }).map((r) => r.key), attachRows({ query, library: dated }).map((r) => r.key), query);
  }
  assert.deepEqual(attachRows({ query: '', library: dated, bodies }).map((r) => r.key), attachRows({ query: '', library: dated }).map((r) => r.key), 'empty: the newest, as before');
});

test('looksAddable: a web address typed without https:// is one, a file\'s bare name is not (2026-10-06)', async () => {
  const { looksAddable } = await load();
  for (const yes of ['github.com', 'github.com/anthropics/claude-code', 'www.example.org/a?b=1', 'example.co.uk']) assert.equal(looksAddable(yes), true, yes);
  for (const no of ['notes.md', 'paper.pdf', 'localhost', 'hello']) assert.equal(looksAddable(no), false, no);
});

test('search: a bare address is still found as text in the library first, then the row the main process found for it (2026-10-06)', async () => {
  const { searchRows } = await load();
  const inRail = () => false;
  const pages = [row('w1', 'Contextual Retrieval', 'website', [], { url: 'https://www.anthropic.com/news/contextual-retrieval' })];
  assert.deepEqual(searchRows({ query: 'anthropic.com', library: pages, inRail }).map((r) => r.key), ['w1']);
  const fresh = { found: { name: 'anthropic.com', type: 'website', tags: [], url: 'https://anthropic.com/' } };
  assert.deepEqual(searchRows({ query: 'anthropic.com', library: pages, inRail, found: fresh }).map((r) => [r.kind, r.key]), [['item', 'w1'], ['fresh', 'fresh:anthropic.com']]);
});

/* -------------------------------------------------------- ranked before the cut (MATH-59) */

test('@List puts a note named List first even with ten older rows whose summaries say "list" (MATH-59)', async () => {
  const { mentionRows, searchRows, bodyMaps } = await load();
  const older = Array.from({ length: 10 }, (_, i) => row(`o${i}`, `Older ${i}`, 'md', ['note'], { summary: `This bug report lists issue ${i}; a TODO list.` }));
  const named = [
    ...older,
    row('a1', 'Shopping', 'website', [], { url: 'https://example.org/lists/shopping' }),
    row('b1', 'Reading list', 'md', ['note']),
    row('l1', 'List', 'md', ['note']),
  ];
  const menu = mentionRows({ query: 'List', library: named, page: null, pageRow: null }).filter((r) => r.kind === 'item');
  assert.equal(menu.length, 10, 'still ten');
  assert.deepEqual(menu.slice(0, 3).map((r) => r.key), ['l1', 'b1', 'a1'], 'a name that starts with it, a name that holds it, then its place, then summaries');
  assert.deepEqual(menu.slice(3).map((r) => r.key), older.slice(0, 7).map((r) => r.id), 'summaries after, in library order, cut after sorting');
  const bodies = bodyMaps({ items: { o9: 'list' }, workspaces: {} });
  const only = [row('x1', 'Said list', 'website', [], { url: 'https://example.org/x' }), row('x2', 'Quiet', 'website', [], { url: 'https://example.org/y' })];
  assert.deepEqual(mentionRows({ query: 'list', library: [...only, ...older], page: null, pageRow: null, bodies }).filter((r) => r.kind === 'item').map((r) => r.key)[0], 'x1', 'what only its text holds stays last');
  assert.deepEqual(searchRows({ query: 'list', library: named, inRail: () => false }).map((r) => r.key).slice(0, 3), ['l1', 'b1', 'a1'], 'the sidebar\'s search ranks the same way, uncut');
  assert.equal(searchRows({ query: 'list', library: named, inRail: () => false }).length, 13);
});

/* -------------------------------------------------------- notes let go of (MATH-58) */

test('a note trashed from its only workspace is not in the @ menu nor the search; a paper in no workspace is (MATH-58)', async () => {
  const { letGoNotes, mentionRows, searchRows } = await load();
  const lib = [
    row('n1', 'Old plan', 'md', ['note']),
    row('n2', 'Old ideas', 'md', ['note']),
    row('n3', 'Old card note', 'md', ['note']),
    row('p9', 'Old paper', 'pdf', ['paper'], { path: '/Users/h/old.pdf' }),
  ];
  // n1 made in a and trashed there; n2 trashed from a but still in b's context; n3 a post-it's +Note, in no workspace ever;
  // p9 trashed from a, a paper.
  const notes = [{ id: 'n1', workspaceId: 'a' }, { id: 'n2', workspaceId: 'a' }, { id: 'n3', workspaceId: null }];
  const workspaces = [
    { id: 'a', context: [], removed: ['n1', 'n2', 'p9'], children: [{ id: 'b', context: ['n2'], removed: [], children: [] }] },
  ];
  const gone = letGoNotes({ workspaces, notes });
  assert.deepEqual([...gone], ['n1'], 'only the note no workspace holds any more');
  const findable = lib.filter((r) => !gone.has(r.id));
  assert.deepEqual(mentionRows({ query: 'old', library: findable, page: null, pageRow: null }).map((r) => r.key), ['n2', 'n3', 'p9']);
  assert.deepEqual(searchRows({ query: 'old', library: findable, inRail: () => false }).map((r) => r.key), ['n2', 'n3', 'p9']);
  assert.ok(lib.some((r) => r.id === 'n1'), 'the library keeps it');
  // Brought back into a workspace, it is found again; made in a workspace that did not throw it away, it was never gone.
  assert.equal(letGoNotes({ workspaces: [{ ...workspaces[0], context: ['n1'], removed: ['n2', 'p9'] }], notes }).has('n1'), false);
  assert.equal(letGoNotes({ workspaces: [workspaces[0], { id: 'c', context: [], removed: [], children: [] }], notes: [{ id: 'n1', workspaceId: 'c' }] }).has('n1'), false);
  assert.equal(letGoNotes({ workspaces: [], notes }).size, 0, 'nothing trashed, nothing let go');
});
