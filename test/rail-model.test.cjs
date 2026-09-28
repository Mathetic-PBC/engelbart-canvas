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

test('search: empty offers creation and new context; typed, it also finds what is already on the rail', async () => {
  const { searchRows } = await load();
  const inRail = (id) => id === 'p1';
  const empty = searchRows({ query: '', library, inRail });
  assert.deepEqual(empty.map((r) => r.key), ['new:note', 'new:workspace', 'g1', 'w1', 'c1', 'f1'], 'no notes, no pictures, nothing already here, at most four');
  assert.deepEqual(empty.slice(2).map((r) => r.tag), ['link · git', 'link', 'csv', 'folder']);
  const typed = searchRows({ query: 'retriev', library, inRail });
  assert.deepEqual(typed.map((r) => r.key), ['w1', 'new:note', 'new:workspace'], 'the Note and Workspace rows keep their names whatever is typed');
  assert.deepEqual(searchRows({ query: 'colbert', library, inRail }).map((r) => [r.key, r.tag]), [['p1', 'here'], ['new:note', 'new'], ['new:workspace', 'new']], 'existing context can be opened from search');
  assert.deepEqual(searchRows({ query: 'import', library, inRail }).map((r) => r.key)[0], 'n1', 'a note is found by name');
  assert.deepEqual(searchRows({ query: 'anthropic.com', library, inRail }).map((r) => r.key)[0], 'w1', 'and a page by its address');
  const many = Array.from({ length: 60 }, (_, i) => row(`m${i}`, `Match ${i}`, 'website', [], { url: `https://example.org/${i}` }));
  assert.equal(searchRows({ query: 'match', library: many, inRail }).filter((result) => result.kind === 'item').length, 60, 'no cap: all of the library is searched and shown');
});

test('sidebar sections use semantic tags and keep every remaining context item', async () => {
  const { sidebarSections } = await load();
  const rows = [...library, row('p2', 'Research link', 'website', ['paper']), row('m1', 'Readme', 'md'), row('x', 'Child', 'child')];
  assert.deepEqual(sidebarSections(rows).map((section) => [section.label, section.rows.map((item) => item.id)]), [
    ['GitHub', ['g1']], ['Overleaf', []], ['Papers', ['p1', 'p2']], ['Documents', ['n1']], ['Other context', ['f1']],
  ]);
  const other = sidebarSections(rows).find((section) => section.id === 'other');
  assert.deepEqual(other.children.map((category) => [category.label, category.rows.map((item) => item.id)]), [
    ['Images', ['i1']], ['Datasets', ['c1']], ['Web pages', ['w1']], ['Conversations', []], ['Notes', ['m1']],
  ]);
  assert.deepEqual(sidebarSections([]).map((section) => section.label), ['GitHub', 'Overleaf', 'Papers', 'Documents', 'Other context'], 'empty sections remain visible in the same order');
});

test('Other context groups existing file kinds without losing, duplicating, or mutating sources', async () => {
  const { sidebarSections } = await load();
  const types = ['image', 'csv', 'tsv', 'json', 'jsonl', 'parquet', 'xlsx', 'website', 'html', 'folder', 'md', 'docx'];
  const rows = types.map((type) => row(type, type, type));
  const before = structuredClone(rows);
  const other = sidebarSections(rows).find((section) => section.id === 'other');
  assert.deepEqual(other.children.map((category) => category.rows.map((item) => item.type)), [
    ['image'], ['csv', 'tsv', 'json', 'jsonl', 'parquet', 'xlsx'], ['website', 'html'], [], ['md'],
  ]);
  assert.deepEqual(other.rows.map((item) => item.type), ['folder', 'docx'], 'unrelated source types keep their existing location');
  const grouped = [...other.rows, ...other.children.flatMap((category) => category.rows)];
  assert.equal(grouped.length, rows.length);
  assert.equal(new Set(grouped).size, rows.length, 'each original row is retained once');
  assert.deepEqual(rows, before);
  assert.deepEqual(sidebarSections([]).find((section) => section.id === 'other').children.map((category) => category.rows), [[], [], [], [], []]);
});

test('PDFs stay out of Other context: papers use Papers and general PDFs use Documents', async () => {
  const { sidebarSections, sidebarSectionOf } = await load();
  const general = row('general', 'Handbook', 'pdf');
  const research = row('research', 'Research', 'pdf', ['paper']);
  const downloaded = row('downloaded', 'Saved handbook', 'pdf', [], { url: 'https://example.com/handbook' });
  const sections = sidebarSections([general, research, downloaded]);
  assert.deepEqual(sections.find((section) => section.id === 'papers').rows, [research]);
  assert.deepEqual(sections.find((section) => section.id === 'notes').rows, [general, downloaded]);
  assert.equal(sidebarSectionOf(general), 'notes');
  const other = sections.find((section) => section.id === 'other');
  assert.deepEqual(other.rows, []);
  assert.ok(other.children.every((category) => category.rows.length === 0));
});

test('saved sticky notes are grouped under Other context > Notes while Documents keep their existing notes', async () => {
  const { sidebarSections } = await load();
  const { isNote } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/kind.js')).href);
  const sticky = row('sticky', 'Remember this', 'md', ['note', 'sticky']);
  const sections = sidebarSections([library[0], sticky]);
  assert.equal(isNote(sticky), true);
  const other = sections.find((section) => section.id === 'other');
  assert.deepEqual(other.rows, []);
  assert.deepEqual(other.children.find((category) => category.id === 'other-notes').rows, [sticky]);
  assert.deepEqual(sections.find((section) => section.id === 'notes').rows, [library[0]]);
});

test('Overleaf is a separate section immediately above Papers while ordinary websites remain in Other context', async () => {
  const { sidebarSections } = await load();
  const project = row('latex', 'Paper draft', 'website', [], { url: 'https://www.overleaf.com/project/123' });
  const unrelated = row('web', 'Overleaf tips', 'website', [], { url: 'https://example.com/overleaf.com' });
  const sections = sidebarSections([project, unrelated]);
  assert.equal(sections[sections.findIndex((section) => section.id === 'papers') - 1].id, 'overleaf');
  assert.deepEqual(sections.find((section) => section.id === 'overleaf').rows, [project]);
  assert.deepEqual(sections.find((section) => section.id === 'other').children.find((category) => category.id === 'web-pages').rows, [unrelated]);
});

test('Conversations lists Claude and Codex sessions, including an agent launched in a shell', async () => {
  const { conversationRows, sidebarSections } = await load();
  const sessions = [
    { snapshot: { id: 'claude', provider: 'claude' }, displayTitle: 'Review the design' },
    { snapshot: { id: 'codex', provider: 'codex' }, displayTitle: 'Build the sidebar' },
    { snapshot: { id: 'shell', provider: 'shell' }, shell: { busy: false, command: '' } },
    { snapshot: { id: 'agent-in-shell', provider: 'shell' }, shell: { busy: true, command: 'codex resume' } },
  ];
  const rows = conversationRows(sessions, 'codex');
  assert.deepEqual(rows.map(({ id, provider, on }) => [id, provider, on]), [['claude', 'claude', false], ['codex', 'codex', true], ['agent-in-shell', 'codex', false]]);
  assert.equal(rows[0].name, 'Review the design');
  assert.equal(rows[2].name, 'Codex');
  const sections = sidebarSections(rows);
  assert.equal(sections.some((section) => section.id === 'conversations'), false);
  assert.deepEqual(sections.find((section) => section.id === 'other').children.find((category) => category.id === 'conversations').rows, rows);
});

test('search finds nested workspaces by their name or their parent path', async () => {
  const { searchRows } = await load();
  const workspaces = [{ id: 'root', name: 'Research', children: [{ id: 'child', name: 'Agents', children: [{ id: 'deep', name: 'Evaluation' }] }] }, { id: 'other', name: 'Writing' }];
  const search = (query) => searchRows({ query, library: [], workspaces, inRail: () => false }).filter((result) => result.kind === 'workspace');
  assert.deepEqual(search('evaluation').map((result) => [result.id, result.path]), [['deep', 'Research / Agents / Evaluation']]);
  assert.deepEqual(search('research').map((result) => result.id), ['root', 'child', 'deep']);
  assert.equal(search('writing')[0].key, 'workspace:other');
  assert.deepEqual(search(''), [], 'empty search remains a compact creation menu');
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

test('rail matches the six reference groups with empty headings and flat, lossless item lists', async () => {
  const { railSections, sectionOf } = await load();
  const rows = [...library, row('k1', 'Child', 'child'), row('g2', 'Clone', 'folder', ['git']), row('h1', 'Saved page', 'html'),
    row('md', 'README', 'md'), row('pdf', 'Handbook', 'pdf'), row('sticky', 'Reminder', 'md', ['note', 'sticky']), row('chat', 'Codex', 'conversation')];
  const sections = railSections(rows);
  assert.deepEqual(sections.map(s => s.label), ['Sub-workspaces', 'Code', 'Writing', 'Literature', 'Documents', 'Other context']);
  assert.deepEqual(sections.map(s => s.icon), ['workspace', 'git', 'overleaf', 'literature', 'note', 'folder']);
  assert.deepEqual(railSections([]).map(s => s.key), ['Workspaces', 'GitHub', 'Overleaf', 'Papers', 'Documents', 'Files']);
  assert.equal(sectionOf(row('md', 'README', 'md')), 'Documents');
  assert.equal(sectionOf(row('pdf', 'Handbook', 'pdf')), 'Documents');
  const leaves = sections.flatMap(s => s.rows);
  assert.ok(sections.every(s => !s.children));
  assert.deepEqual(leaves.map(r => r.id).sort(), rows.map(r => r.id).sort());
  assert.equal(new Set(leaves).size, rows.length);
  const other = sections.find(s => s.key === 'Files');
  assert.deepEqual(other.rows.map(r => r.id), ['w1', 'i1', 'c1', 'f1', 'h1', 'sticky', 'chat']);
});

test('saved provider links stay in the right sections with one catalog action per provider', async () => {
  const { railSections, sectionOf, documentProvider } = await load();
  const google = row('doc', 'Draft', 'website', [], { url: 'https://docs.google.com/document/d/draft_123/edit?tab=t.0' });
  const overleaf = row('tex', 'Manuscript', 'website', [], { url: 'https://www.overleaf.com/project/abc123' });
  const zotero = row('ref', 'Reference', 'website', [], { url: 'https://www.zotero.org/reader/items/ABCD1234/library' });
  const pdf = row('attached', 'Full text', 'pdf', [], { url: 'https://www.zotero.org/groups/123/team/items/EFGH5678/library', path: '/papers/full-text.pdf' });
  const rows = [...library, google, overleaf, zotero, pdf], original = JSON.stringify(rows);
  const sections = railSections(rows);
  assert.equal(documentProvider(google), 'google-docs'); assert.equal(documentProvider(overleaf), 'overleaf');
  assert.equal(documentProvider({ ...google, url: 'https://docs.google.com/document/u/1/d/draft_123/edit' }), 'google-docs');
  assert.deepEqual(sections.find(c => c.key === 'Documents').rows, [library[0], google]);
  assert.deepEqual(sections.find(c => c.key === 'Overleaf').rows, [overleaf]);
  assert.deepEqual(sections.find(c => c.key === 'Papers').rows, [library[1], zotero, pdf]);
  assert.deepEqual(sections.filter(c => c.catalog).map(c => c.catalog.provider), ['github', 'overleaf', 'zotero', 'google']);
  for (const url of ['https://docs.google.com/', 'https://docs.google.com/spreadsheets/d/sheet/edit', 'https://www.overleaf.com/login', 'https://example.com/project/abc123', 'https://overleaf.com.example.org/project/abc123']) {
    assert.equal(documentProvider({ ...google, url }), null, url);
    assert.equal(sectionOf({ ...google, url }), 'Files', url);
  }
  assert.equal(JSON.stringify(rows), original);
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
  assert.deepEqual(railSections(rows).filter(s => s.rows.length).map((s) => [s.key, s.rows.map((r) => r.id)]), [['Documents', ['n1']], ['Archived', ['archive:2026-09-25T21-03-12Z']]]);
  assert.ok(!railSections([rows[1]]).some((s) => s.key === 'Archived'), 'no versions, no section');
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
