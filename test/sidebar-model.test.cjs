'use strict';

// What the workspace sidebar lists (src/renderer/model/sidebar.js, 2026-10-07): Your sources by kind and Starred, the share
// of the sidebar each section keeps to, the workspaces worked in last with their sub-workspaces, the Inbox and Agents.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/sidebar.js')).href);

const row = (id, name, type, tags = [], more = {}) => ({ id, name, type, tags, ...more });
const rows = [
  row('n1', 'Sidebar requirements', 'md', ['note']),
  row('p1', 'Working spheres', 'pdf', ['paper'], { path: '/Users/h/spheres.pdf' }),
  row('g1', 'Papert-Lab/notes', 'website', ['git'], { url: 'https://github.com/Papert-Lab/notes' }),
  row('g2', 'engelbart-canvas', 'folder', ['git'], { folder_path: '/Users/h/engelbart-canvas' }),
  row('w1', 'Magic Ink', 'website', [], { url: 'https://worrydream.com/MagicInk/' }),
  row('m1', 'README', 'md'),
  row('c1', 'survey.csv', 'csv'),
  row('f1', 'fixtures', 'folder', [], { folder_path: '/Users/h/fixtures' }),
  row('i1', 'Attachment 1', 'image'),
];

test('Your sources: Starred and Notes are the subsections; websites, code and files are mixed in one list after them', async () => {
  const { SOURCE_GROUPS, sourceGroups, sourceKind } = await load();
  assert.deepEqual(SOURCE_GROUPS.map((group) => group.label), ['Starred', 'Notes', 'Sources']);
  assert.deepEqual(SOURCE_GROUPS.map((group) => group.header), [undefined, undefined, false], 'the mixed list has no heading');
  const groups = sourceGroups(rows, [], rows);
  assert.deepEqual(groups.map((group) => [group.key, group.rows.map((r) => r.id)]), [['starred', []], ['notes', ['n1']], ['other', ['p1', 'g1', 'g2', 'w1', 'm1', 'c1', 'f1', 'i1']]], 'in the workspace\'s own order');
  assert.deepEqual(['n1', 'w1', 'g1', 'g2', 'p1'].map((id) => sourceKind(rows.find((r) => r.id === id))), ['notes', 'websites', 'code', 'code', 'files'], 'each keeps its kind, for its icon: a repository is Code as an address or a clone');
  assert.equal(sourceKind(row('m2', 'README', 'md')), 'files', 'a Markdown file that is not a note is a file');
});

test('Starred lists the starred ids in the order they were starred, from the library when they are not in this workspace; a gone row is left out', async () => {
  const { sourceGroups } = await load();
  const elsewhere = row('x1', 'As We May Think', 'website', [], { url: 'https://www.w3.org/History/1945/vbush/' });
  const starred = sourceGroups(rows.slice(0, 2), ['x1', 'gone', 'p1'], [elsewhere, ...rows]).find((group) => group.key === 'starred');
  assert.deepEqual(starred.rows.map((r) => r.id), ['x1', 'p1']);
});

test('a section keeps to its room: a header for Starred and Notes, then at least one row of each, then a few more each, "More" under what is cut', async () => {
  const { fitGroups } = await load();
  const groups = [{ key: 'starred', count: 2 }, { key: 'notes', count: 7 }, { key: 'other', header: false, count: 6 }];
  const fit = fitGroups(groups, 12, { cap: 5 });
  assert.deepEqual(fit.shown, { starred: 2, notes: 3, other: 3 }, 'dealt round: Starred whole, Notes and the mixed list as the room leaves');
  assert.deepEqual(fit.more, { starred: false, notes: true, other: true });
  assert.equal(fit.lines, 12);
  assert.equal(fit.fits, true);
  assert.deepEqual(fitGroups(groups, 40, { cap: 5 }).shown.notes, 5, 'never past "the first few" however much room there is');
  assert.equal(fitGroups(groups, 40, { cap: 5 }).more.notes, true);
});

test('dealt group by group: each group shows a few before any shows many; the last row takes "More"\'s place', async () => {
  const { fitGroups } = await load();
  const open = ['a', 'b', 'c'].map((key) => ({ key, count: 9 }));
  assert.deepEqual(fitGroups(open, 14).shown, { a: 3, b: 3, c: 2 }, '3 headers, a first row and "More" each leave 5 rows, dealt a, b, c, a, b');
  assert.deepEqual(fitGroups(open, 12).shown, { a: 2, b: 2, c: 2 });
  assert.deepEqual(fitGroups([{ key: 'a', count: 2 }], 3).shown, { a: 2 }, 'a header and two rows, no "More"');
  assert.deepEqual(fitGroups([{ key: 'a', count: 3 }], 3), { shown: { a: 1 }, more: { a: true }, lines: 3, fits: true }, 'one row and "More": the second row would need a fourth line and leave one out');
  assert.deepEqual(fitGroups([{ key: 'a', header: false, count: 3 }], 3).shown, { a: 3 }, 'no heading, no line for it');
});

test('a group never shows "More" alone: with no room for one row each, the section scrolls instead', async () => {
  const { fitGroups } = await load();
  const fit = fitGroups(['a', 'b', 'c'].map((key) => ({ key, count: 4 })), 6);
  assert.equal(fit.fits, false);
  assert.deepEqual(fit.shown, { a: 1, b: 1, c: 1 }, 'one row each, and no more dealt');
  const empty = fitGroups([{ key: 'starred', count: 0 }, { key: 'other', header: false, count: 0 }], 10);
  assert.deepEqual([empty.lines, empty.shown, empty.more], [2, { starred: 0, other: 0 }, { starred: false, other: false }], 'an empty group says so on one line under its header; one with no heading takes none');
});

// A tree like Hudson's: areas at the top, the workspaces worked in under them, one deeper.
const at = (minutes) => new Date(Date.UTC(2026, 9, 7, 12, 0) - minutes * 60000).toISOString();
const ws = (id, name, edited, children = []) => ({ id, name, edited, children });
const tree = () => [
  ws('gs', 'Getting started', at(600)),
  ws('ui', 'User Interface', at(500), [ws('sb', 'Sidebar', at(5), [ws('ic', 'Iconography', at(400))]), ws('mc', 'Middle Canvas', at(50)), ws('fa', 'Focusing attention', at(300))]),
  ws('ag', 'Agents', at(450), [ws('bb', 'Bart build agents', at(30))]),
  ws('lb', 'Library', at(100)),
  ws('ob', 'Onboarding', at(700)),
];

test('Workspaces: the three worked in last at the top level, by what was done in them or anything nested in them; children by the same', async () => {
  const { recentWorkspaces } = await load();
  const listed = recentWorkspaces({ roots: tree(), hereId: 'sb' });
  assert.deepEqual(listed.map((entry) => entry.node.id), ['ui', 'ag', 'lb'], 'Sidebar (5 min) lifts User Interface; Bart build agents (30) lifts Agents');
  assert.deepEqual(listed[0].children.map((child) => child.node.id), ['sb', 'mc', 'fa'], 'its children, worked in last first; Iconography is a grandchild and never listed');
  assert.equal(listed[0].holdsHere, true);
  assert.equal(listed[1].holdsHere, false);
});

test('a note typed in a workspace (state.json `recent`) counts as working in it, as its document saved does', async () => {
  const { recentWorkspaces } = await load();
  const recent = [{ projectId: 'p', workspaceId: 'ob', at: at(1) }];
  assert.deepEqual(recentWorkspaces({ roots: tree(), recent, hereId: 'sb' }).map((entry) => entry.node.id), ['ob', 'ui', 'ag']);
});

test('the workspace open here is always among them: it takes the last place when it was not worked in lately', async () => {
  const { recentWorkspaces } = await load();
  assert.deepEqual(recentWorkspaces({ roots: tree(), hereId: 'gs' }).map((entry) => entry.node.id), ['ui', 'ag', 'gs']);
  assert.deepEqual(recentWorkspaces({ roots: tree(), hereId: 'ic' }).map((entry) => [entry.node.id, entry.holdsHere]), [['ui', true], ['ag', false], ['lb', false]], 'a grandchild is held by its top');
  assert.deepEqual(recentWorkspaces({ roots: [], hereId: null }), []);
});

test('sub-workspaces share the section\'s room, row by row; a folded row takes none', async () => {
  const { fitChildren } = await load();
  assert.deepEqual(fitChildren([{ id: 'ui', open: true, count: 3 }, { id: 'ag', open: true, count: 1 }, { id: 'lb', open: false, count: 4 }], 3), { ui: 2, ag: 1, lb: 0 });
  assert.deepEqual(fitChildren([{ id: 'ui', open: true, count: 5 }], 3), { ui: 3 });
});

test('pathTo, countWorkspaces, workspaceActivity', async () => {
  const { pathTo, countWorkspaces, workspaceActivity } = await load();
  assert.deepEqual(pathTo(tree(), 'ic').map((node) => node.id), ['ui', 'sb', 'ic']);
  assert.deepEqual(pathTo(tree(), 'nope'), []);
  assert.equal(countWorkspaces(tree()), 10);
  const { own, within } = workspaceActivity(tree());
  assert.ok(within.get('ui') > own.get('ui'), 'what was done in Sidebar counts for User Interface');
  assert.equal(within.get('ui'), own.get('sb'));
});

test('Inbox: this project\'s agents that finished and wait, newest first, each saying what it did', async () => {
  const { inboxEntries } = await load();
  const agents = [
    { id: 'a1', kind: 'bart', projectId: 'p', workspaceId: 'ag', status: 'waiting', name: 'Agents', finished: at(10) },
    { id: 'a2', kind: 'build', projectId: 'p', workspaceId: 'sb', status: 'waiting', name: 'Sidebar', finished: at(2) },
    { id: 'a3', kind: 'bart', projectId: 'p', workspaceId: 'mc', status: 'running', started: at(1) },
    { id: 'a4', kind: 'discover', projectId: 'other', workspaceId: 'x', status: 'waiting', finished: at(1) },
    { id: 'a5', kind: 'build', projectId: 'p', workspaceId: null, status: 'waiting', finished: at(1) },
  ];
  assert.deepEqual(inboxEntries(agents, 'p').map((entry) => [entry.id, entry.did]), [['a2', 'Build finished a turn'], ['a1', 'Bart answered']], 'a post-it\'s quick task, in no workspace, is its card\'s to show');
});

test('Agents: inline questions still running, and the Builds by where they stand; a Build\'s own turns are its record\'s', async () => {
  const { agentGroups } = await load();
  const agents = [
    { id: 'q1', kind: 'discover', projectId: 'p', workspaceId: 'lb', status: 'running', started: at(3) },
    { id: 'q2', kind: 'build', projectId: 'p', workspaceId: 'sb', status: 'running', started: at(4) },
    { id: 'q3', kind: 'bart', projectId: 'p', workspaceId: 'sb', status: 'waiting', finished: at(4) },
  ];
  const builds = [
    { id: 'b1', kind: 'build', projectId: 'p', workspaceId: 'sb', title: 'New sidebar', status: 'running', updated: at(1) },
    { id: 'b2', kind: 'build', projectId: 'p', workspaceId: 'mc', title: 'Copy button', status: 'needs-you', updated: at(20) },
    { id: 'b3', kind: 'quick', projectId: 'p', workspaceId: null, title: 'Fix the tabs', status: 'accepted', updated: at(90) },
    { id: 'b4', kind: 'build', projectId: 'other', workspaceId: 'x', title: 'Elsewhere', status: 'running', updated: at(1) },
  ];
  const groups = agentGroups({ agents, builds, projectId: 'p' });
  assert.deepEqual(groups.running.map((entry) => [entry.id, entry.title, entry.state]), [['build:b1', 'New sidebar', 'Working'], ['agent:q1', 'Discover', 'Working']]);
  assert.deepEqual(groups.waiting.map((entry) => [entry.id, entry.state]), [['build:b2', 'Needs you']]);
  assert.deepEqual(groups.done.map((entry) => [entry.id, entry.kind, entry.state]), [['build:b3', 'quick', 'Accepted']]);
});

test('archived versions of every workspace, newest first; sinceWords', async () => {
  const { archivedVersions, sinceWords } = await load();
  const roots = [{ id: 'a', name: 'A', archives: [{ file: '1.md', title: 'First', clearedAt: at(300) }], children: [{ id: 'b', name: 'B', archives: [{ file: '2.md', title: '', clearedAt: at(10) }], children: [] }] }];
  assert.deepEqual(archivedVersions(roots).map((v) => [v.workspaceId, v.file, v.title]), [['b', '2.md', 'Untitled'], ['a', '1.md', 'First']]);
  const now = Date.parse(at(0));
  assert.deepEqual([sinceWords(at(0), now), sinceWords(at(4), now), sinceWords(at(130), now), sinceWords(at(3000), now), sinceWords(null, now)], ['just now', '4 min ago', '2 h ago', '2 d ago', '']);
});

test('versionsOf: one workspace\'s own archived versions, newest first, none of its sub-workspaces\'', async () => {
  const { versionsOf } = await load();
  const node = { id: 'a', name: 'A', archives: [{ file: '1.md', title: 'Old', clearedAt: at(300) }, { file: '2.md', title: '', clearedAt: at(10) }], children: [{ id: 'b', name: 'B', archives: [{ file: '3.md', title: 'Child', clearedAt: at(1) }], children: [] }] };
  assert.deepEqual(versionsOf(node).map((v) => [v.workspaceId, v.file, v.title]), [['a', '2.md', 'Untitled'], ['a', '1.md', 'Old']]);
  assert.deepEqual(versionsOf({ id: 'c', name: 'C', children: [] }), []);
});
