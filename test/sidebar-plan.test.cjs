'use strict';

// The app's Projects section against the mockup it was built from (design/sidebar-mockup/Sidebar.html, Hudson 2026-10-13:
// "it is exactly how I want it"): for every project of the mockup's tree, going there leaves the same shortlist, the same
// rows in the same order, the same row behind each More and the same guide line in the app's model (model/sidebar.js) as
// in the mockup's own script. Then the model's own rules: counts, shortcuts, the clock's list, a source's icon.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/sidebar.js')).href);

// The mockup's script, run without a browser (the same stand-ins test/sidebar-mockup.test.cjs uses).
function mockup() {
  const html = fs.readFileSync(path.join(__dirname, '../design/sidebar-mockup/Sidebar.html'), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { innerHTML: '', dataset: {}, querySelector: () => null, getBoundingClientRect: () => ({ left: 8, right: 288, top: 80, bottom: 110, width: 280 }), focus() {}, scrollIntoView() {} });
    return elements.get(selector);
  };
  const context = vm.createContext({
    console, Date, Set, Map,
    setTimeout: () => 0, clearTimeout() {}, setInterval() {},
    window: { innerHeight: 1000, innerWidth: 1400, addEventListener() {} },
    document: { activeElement: null, querySelector: (selector) => (/^(#|\.stage-body)/.test(selector) ? element(selector) : null), querySelectorAll: () => [], addEventListener() {} },
  });
  vm.runInContext(source, context);
  const read = (expression) => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, context));
  const run = (code) => vm.runInContext(code, context);
  return { read, run };
}

// The mockup's Engelbart tree as the app's tree: { id, name, children }.
function treeOf(m, top = 'engelbart') {
  const nodes = m.read('Object.fromEntries(Object.values(N).map(n => [n.id, { name: n.name, children: n.children }]))');
  const build = (id) => ({ id, name: nodes[id].name, children: nodes[id].children.map(build) });
  return nodes[top].children.map(build);
}

test('going to each project leaves the mockup\'s shortlist, rows, Mores and guide line', async () => {
  const { indexTree, projectSlots, projectPlan, openPath } = await load();
  const m = mockup();
  const roots = treeOf(m);
  const index = indexTree(roots);
  const targets = [...index.keys()];
  // A walk through every project, then back up and across, the way a person clicks.
  for (const target of [...targets, ...targets.slice().reverse(), 'engelbart/agents/bart-build-agents/sandbox', 'engelbart/getting-started', 'engelbart/user-studies/tom']) {
    const held = m.read('S.projectSlots.engelbart || null');
    m.run(`goProject(${JSON.stringify(target)})`);
    m.read('projectsSection()'); // the mockup plans while it draws
    const want = m.read('({ order: PLAN.order, visible: PLAN.visible, hidden: PLAN.hidden, guide: guideParent(), expanded: [...S.expanded] })');
    if (held) assert.deepEqual(projectSlots({ roots, index, focusId: target, held }), want.order, `shortlist after ${target}`);
    assert.deepEqual([...openPath(index, target)].sort(), want.expanded.slice().sort(), `open after ${target}`);
    const plan = projectPlan({ index, order: want.order, expanded: new Set(want.expanded) });
    assert.deepEqual(plan.visible, want.visible, `rows after ${target}`);
    assert.deepEqual(plan.hidden, want.hidden, `More after ${target}`);
    assert.equal(plan.guide, want.guide, `guide line after ${target}`);
    assert.ok(plan.rows <= 10, `at most ten rows after ${target}`);
  }
});

test('a chevron opens one branch at a time, as the mockup\'s does', async () => {
  const { indexTree, toggleOpen, projectPlan } = await load();
  const m = mockup();
  const roots = treeOf(m);
  const index = indexTree(roots);
  m.run('goProject("engelbart/user-interface/sidebar")');
  let expanded = new Set(m.read('[...S.expanded]'));
  for (const id of ['engelbart/agents', 'engelbart/agents/bart-build-agents', 'engelbart/user-interface', 'engelbart/user-interface', 'engelbart/onboarding']) {
    m.run(`toggle(${JSON.stringify(id)})`);
    expanded = toggleOpen(index, expanded, id);
    assert.deepEqual([...expanded].sort(), m.read('[...S.expanded]').sort(), `after toggling ${id}`);
    m.read('projectsSection()');
    const order = m.read('PLAN.order');
    assert.deepEqual(projectPlan({ index, order, expanded }).visible, m.read('PLAN.visible'));
  }
});

test('counts: running and to-look-at together, each agent once up the tree, 9+', async () => {
  const { indexTree, agentEntries, summarize, rollUp, summaryOf, countLabel, libraryLabel, buildState } = await load();
  const roots = [{ id: 'ui', name: 'UI', children: [{ id: 'sb', name: 'Sidebar', children: [{ id: 'nt', name: 'Notifications', children: [] }] }] }, { id: 'ag', name: 'Agents', children: [] }];
  const index = indexTree(roots);
  const entries = agentEntries({
    projectId: 'p',
    agents: [
      { id: 'a', kind: 'bart', projectId: 'p', workspaceId: 'nt', status: 'running', started: '2026-10-13T10:00:00Z' },
      { id: 'b', kind: 'bart', projectId: 'p', workspaceId: 'sb', status: 'waiting', finished: '2026-10-13T11:00:00Z' },
      { id: 'c', kind: 'bart', projectId: 'other', workspaceId: 'sb', status: 'waiting' },
    ],
    builds: [
      { id: 'b1', projectId: 'p', workspaceId: 'ag', status: 'review', title: 'Pills', updated: '2026-10-13T12:00:00Z' },
      { id: 'b2', projectId: 'p', workspaceId: 'ui', status: 'accepted', title: 'Old' },
      { id: 'b3', projectId: 'p', workspaceId: null, status: 'failed', title: 'A post-it', kind: 'quick' },
    ],
    connect: [{ id: 'connect:s', sessionId: 's', name: 'Connect your library', tone: 'warn', at: '2026-10-13T09:00:00Z' }],
  });
  assert.deepEqual(entries.map((entry) => [entry.id, entry.state]), [['build:b1', 'needs'], ['agent:b', 'unseen'], ['agent:a', 'running'], ['connect:s', 'needs'], ['build:b2', 'done'], ['build:b3', 'failed']]);
  assert.deepEqual(summarize(entries), { total: 5, running: 1, ready: 4 });
  const rolled = rollUp(index, entries);
  assert.deepEqual(rolled.get('ui'), { total: 2, running: 1, ready: 1 }, 'the parent counts its descendants once each; done is not counted');
  assert.deepEqual(rolled.get('nt'), { total: 1, running: 1, ready: 0 });
  assert.deepEqual(summaryOf(index, entries, ['sb', 'nt', 'ag']), { total: 3, running: 1, ready: 2 }, 'overlapping ids count each agent once');
  assert.deepEqual([countLabel(9), countLabel(10), libraryLabel(999), libraryLabel(1000)], ['9', '9+', '999', '999+']);
  assert.deepEqual(['queued', 'needs-you', 'review', 'conflict', 'stopped'].map(buildState), ['running', 'needs', 'needs', 'failed', 'done']);
});

test('Ctrl+number reaches the level-2 projects in the tree\'s order, nine at most', async () => {
  const { shortcutProjects, shortcutOf } = await load();
  const roots = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, children: [{ id: `c${i}`, name: 'child', children: [] }] }));
  assert.deepEqual(shortcutProjects(roots), roots.slice(0, 9).map((node) => node.id));
  assert.equal(shortcutOf(roots, 'p0'), 1);
  assert.equal(shortcutOf(roots, 'p9'), 0, 'the tenth has no number');
  assert.equal(shortcutOf(roots, 'c0'), 0, 'deeper projects have none');
});

test('the clock: the project page first, then the pages opened last, once each, ten at most, gone ones left out', async () => {
  const { indexTree, recentPages, visited, crumbFrom } = await load();
  const index = indexTree([{ id: 'ui', name: 'UI', children: [{ id: 'sb', name: 'Sidebar', children: [] }] }]);
  let visits = [];
  const at = (n) => new Date(Date.UTC(2026, 9, 13, 10, n)).toISOString();
  visits = visited(visits, { kind: 'project', id: 'ui' }, at(1));
  visits = visited(visits, { kind: 'note', id: 'n1' }, at(2));
  visits = visited(visits, { kind: 'project', id: 'gone' }, at(3));
  visits = visited(visits, { kind: 'project', id: 'sb' }, at(4));
  visits = visited(visits, { kind: 'project', id: 'ui' }, at(5));
  const notes = new Map([['n1', { id: 'n1', name: 'Requirements' }]]);
  assert.deepEqual(recentPages({ visits, index, notes }).map((page) => `${page.kind}:${page.id}`), ['top:top', 'project:ui', 'project:sb', 'note:n1']);
  const many = Array.from({ length: 20 }, (_, i) => ({ kind: 'note', id: `n${i}`, at: at(i) }));
  const lots = new Map(many.map((visit) => [visit.id, {}]));
  assert.equal(recentPages({ visits: many, index, notes: lots }).length, 10);
  assert.deepEqual([crumbFrom(['Engelbart', 'User Interface'], 0), crumbFrom(['Engelbart', 'User Interface'], 1)], ['Engelbart/User Interface', './User Interface']);
});

test('a source\'s icon is its kind\'s: note, file, picture, code for html, globe, folder, paper, repository', async () => {
  const { sourceIcon, folderRows } = await load();
  const rows = [
    { type: 'md', tags: ['note'] }, { type: 'md', tags: [] }, { type: 'image', tags: [] }, { type: 'html', tags: [] },
    { type: 'website', tags: [] }, { type: 'folder', tags: [] }, { type: 'pdf', tags: ['paper'] }, { type: 'folder', tags: ['git'] }, { type: 'csv', tags: [] },
  ];
  assert.deepEqual(rows.map(sourceIcon), ['note', 'file', 'image', 'html', 'website', 'folder', 'pdf', 'git', 'file']);
  assert.deepEqual(folderRows([1, 2, 3, 4, 5]), { shown: [1, 2, 3, 4, 5], more: false });
  assert.deepEqual(folderRows([1, 2, 3, 4, 5, 6]), { shown: [1, 2, 3, 4], more: true });
});
