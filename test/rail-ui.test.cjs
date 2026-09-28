'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

// Render the real sidebar and retain element props to exercise its click/hover handlers
// without an Electron window, a real library, or any sandbox/network activity.
const elements = [];
const recordingRuntime = { ...jsxRuntime };
for (const method of ['jsx', 'jsxs']) recordingRuntime[method] = (...args) => {
  const element = jsxRuntime[method](...args);
  elements.push(element);
  return element;
};
const filename = path.join(__dirname, '__rail-ui-unit.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/Rail.jsx')], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'],
  loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
let testExpansion = null;
const testReact = { ...React, useState(initial) {
  return React.useState(initial?.name === 'initialRailExpansion' && testExpansion ? testExpansion : initial);
} };
compiled.require = function (id) {
  if (id === 'react') return testReact;
  return id === 'react/jsx-runtime' ? recordingRuntime : Module.prototype.require.call(this, id);
};
const previousWindow = global.window;
global.window = { engelbartAPI: { repoThumbnail: async () => null } };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const Rail = compiled.exports.default;
const repo = { id: 'repo', name: 'owner/app', type: 'website', tags: ['git'], url: 'https://github.com/owner/app' };
const paper = { id: 'paper', name: 'A paper', type: 'pdf', tags: ['paper'] };
const note = { id: 'note', name: 'A note', type: 'md', tags: ['note'] };
const website = { id: 'web', name: 'A website', type: 'website', tags: [], url: 'https://example.com' };
const child = { id: 'child', name: 'Child workspace', type: 'child' };
const topic = { id: 'workspace', name: 'My workspace' };
const renderRail = (rows, extra = {}) => {
  elements.length = 0;
  const { expansion, ...props } = extra;
  testExpansion = expansion === undefined ? Object.fromEntries(['Workspaces', 'GitHub', 'Papers', 'Overleaf', 'Documents', 'Files'].map(key => [key, true])) : expansion;
  return renderToStaticMarkup(React.createElement(Rail, {
    width: 300, topics: [topic], topic, allWorkspaces: [], rows, library: rows, inRail: () => true, ...props,
  }));
};
const component = (name, predicate = () => true) => elements.find(element => element.type.name === name && predicate(element.props));
const rowElement = id => elements.find(element => element.props['data-rail-row'] === id);

test('sidebar keeps workspace navigation and orders the material groups by purpose', () => {
  const html = renderRail([repo, child, paper, website, note]);
  assert.deepEqual([...html.matchAll(/data-rail-section="([^"]+)"/g)].map(match => match[1]),
    ['GitHub', 'Overleaf', 'Papers', 'Documents', 'Files']);
  assert.ok(html.indexOf('data-workspace-header="1"') < html.indexOf('data-rail-search="1"'));
  assert.ok(html.indexOf('data-rail-search="1"') < html.indexOf('data-rail-section="GitHub"'));
  assert.match(html, /My workspace/);
  assert.match(html, /placeholder="Search\.\.\."/);
  assert.doesNotMatch(html, /data-rail-fold-all|Expand all|Collapse all/);
  assert.match(html, /aria-label="Sidebar"/);
  assert.match(html, /width:300px/);
  assert.doesNotMatch(html, /rail-row-add|rail-section-add|data-repo-thumbnail/);
});

test('all five main sections remain visible when empty, including Other context', () => {
  const html = renderRail([]);
  assert.deepEqual([...html.matchAll(/data-rail-section="([^"]+)"/g)].map(match => match[1]),
    ['GitHub', 'Overleaf', 'Papers', 'Documents', 'Files']);
  assert.match(html, /Add context/);
  assert.match(html, /Other context/);
  assert.match(renderRail([{ id: 'image', name: 'Image', type: 'image', tags: [] }]), /data-rail-row="image"/);
  const noWorkspace = renderRail([], { topic: null, topics: [] });
  assert.doesNotMatch(noWorkspace, /data-rail-library|data-rail-section=/);
});

test('repos use their existing handler and workspaces remain in the header switcher', () => {
  const opened = [];
  renderRail([repo, child], { allWorkspaces: [child], onRowClick: row => opened.push(row.id), onSelectTopic: id => opened.push(id) });
  rowElement(repo.id).props.onClick();
  const header = component('WorkspaceHeader');
  assert.deepEqual(header.props.all, [child]);
  header.props.onSelectTopic(child.id);
  assert.deepEqual(opened, [repo.id, child.id]);
  assert.equal(rowElement(repo.id).props.draggable, true);
  assert.equal(rowElement(child.id), undefined);
});

test('saved provider links stay directly in their sections with existing row actions', () => {
  const google = { id: 'google', name: 'Draft', type: 'website', tags: [], url: 'https://docs.google.com/document/d/draft/edit' };
  const overleaf = { id: 'overleaf', name: 'Manuscript', type: 'website', tags: [], url: 'https://www.overleaf.com/project/123abc' };
  const zotero = { id: 'zotero', name: 'Reference', type: 'website', tags: [], url: 'https://www.zotero.org/reader/items/ABCD1234/library' };
  const opened = [];
  const html = renderRail([note, paper, google, overleaf, zotero], { onRowClick: row => opened.push(row.id) });
  assert.deepEqual(component('RailSection', p => p.section.key === 'Documents').props.section.rows.map(row => row.id), ['note', 'google']);
  assert.deepEqual(component('RailSection', p => p.section.key === 'Papers').props.section.rows.map(row => row.id), ['paper', 'zotero']);
  for (const name of ['GoogleDocuments', 'OverleafProjects', 'ZoteroPapers', 'GithubRepositories']) assert.equal(component(name), undefined, 'catalogs mount only after Browse is clicked');
  for (const [row, provider] of [[google, 'google-docs'], [overleaf, 'overleaf']]) {
    assert.equal(rowElement(row.id).props.children[0].props.kind, provider);
    rowElement(row.id).props.onClick();
    assert.ok(elements.some(element => element.props['data-rail-remove'] === row.id));
  }
  assert.deepEqual(opened, ['google', 'overleaf']);
  assert.match(html, /data-rail-section="Overleaf"/);
  for (const key of ['google', 'overleaf', 'zotero']) assert.match(html, new RegExp(`data-browse-source="${key}"`));
  assert.match(html, /data-github-projects-toggle/);
  assert.doesNotMatch(html, /data-browse-source="github"/);
});

test('context removal does not open the row and is not offered for sub-workspaces', () => {
  const removed = [];
  renderRail([repo, child], { onTrashRow: row => removed.push(row.id) });
  let stopped = false;
  elements.find(element => element.props['data-rail-remove'] === repo.id).props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  assert.deepEqual(removed, [repo.id]);
  assert.equal(elements.some(element => element.props['data-rail-remove'] === child.id), false);
});

test('row renaming uses the existing handler and editing disables dragging', () => {
  const renamed = [];
  renderRail([repo], { onRowRenameStart: row => renamed.push(row.id) });
  rowElement(repo.id).props.onDoubleClick({ stopPropagation() {} });
  assert.deepEqual(renamed, [repo.id]);
  const html = renderRail([{ ...repo, editing: true }]);
  assert.match(html, /data-rename="repo"/);
  assert.doesNotMatch(html, /data-rail-remove="repo"/);
  assert.equal(rowElement(repo.id).props.draggable, false);
});

test('saved repo thumbnails and ordinary hover previews keep the existing delay; sub-workspaces have no peek', () => {
  renderRail([{ ...repo, thumbnail_path: 'assets/repo-thumbnails/saved.jpg' }, website, child]);
  const prior = global.setTimeout;
  const delays = [];
  global.setTimeout = (_fn, delay) => { delays.push(delay); return 1; };
  try {
    rowElement(repo.id).props.onMouseEnter({ currentTarget: {} });
    rowElement(website.id).props.onMouseEnter({ currentTarget: {} });
    assert.equal(rowElement(child.id), undefined);
    assert.deepEqual(delays, [350, 350]);
  } finally { global.setTimeout = prior; }
});

test('repositories without a thumbnail show no card and cancel pending previews from other rows', () => {
  renderRail([repo, website]);
  const prior = global.setTimeout, priorClear = global.clearTimeout;
  const delays = [], cancelled = [];
  global.setTimeout = (_fn, delay) => { delays.push(delay); return 'pending-preview'; };
  global.clearTimeout = id => cancelled.push(id);
  try {
    rowElement(repo.id).props.onMouseEnter({ currentTarget: {} });
    assert.deepEqual(delays, []);
    rowElement(website.id).props.onMouseEnter({ currentTarget: {} });
    rowElement(repo.id).props.onMouseEnter({ currentTarget: {} });
    assert.deepEqual(delays, [350]);
    assert.ok(cancelled.includes('pending-preview'));
  } finally { global.setTimeout = prior; global.clearTimeout = priorClear; }
});

test('library search and Add context retain existing import and creation handlers', () => {
  const onSearchPick = () => {}, onNewChild = () => {}, onPickRepo = () => {};
  renderRail([repo], { onSearchPick, onNewChild, onPickRepo });
  assert.equal(component('LibrarySearch').props.onPick, onSearchPick);
  assert.equal(component('AddToLibrary').props.onSearchPick, onSearchPick);
  assert.equal(component('AddToLibrary').props.onNewChild, onNewChild);
  assert.equal(component('AddToLibrary').props.onPickRepo, onPickRepo);
});

test('Add context has an explicit click toggle and no hover-open or hover-close handlers', () => {
  renderRail([repo]);
  const wrapper = elements.find(element => element.props['data-rail-add'] === '1');
  const trigger = wrapper.props.children[0];
  for (const element of [wrapper, trigger]) {
    assert.equal(element.props.onMouseEnter, undefined);
    assert.equal(element.props.onMouseLeave, undefined);
  }
  assert.equal(trigger.type, 'button');
  assert.equal(trigger.props['aria-label'], 'Add context');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(typeof trigger.props.onClick, 'function');
});

test('top inset and icon-led sections match the reference, with workspace navigation in the header', () => {
  const html = renderRail([repo, child, { id: 'file', name: 'Data', type: 'csv', tags: [] }]);
  const aside = elements.find(element => element.type === 'aside');
  assert.equal(aside.props.children[0].props.style.padding, '10px 10px 8px');
  assert.ok(html.indexOf('data-rail-search') < html.indexOf('data-rail-section="GitHub"'));
  assert.doesNotMatch(html, /data-rail-section="Workspaces"/);
  assert.match(html, /aria-label="Switch workspace"/);
  assert.doesNotMatch(html, /data-next-workspace/);
  for (const [key, icon] of [['GitHub', 'git'], ['Overleaf', 'overleaf'], ['Papers', 'literature'], ['Documents', 'note'], ['Files', 'folder']]) {
    const heading = elements.find(element => element.props['data-rail-section-toggle'] === key);
    const [chevron, glyph, label] = heading.props.children;
    assert.equal(chevron.type, 'svg');
    assert.equal(glyph.type.name, 'KindGlyph');
    assert.equal(glyph.props.kind, icon);
    assert.equal(glyph.props.size, 16);
    assert.equal(label.type, 'span');
    assert.equal(heading.props['aria-expanded'], true);
  }
});

test('initial load ignores previously saved expansion and keeps every section and overlay closed', () => {
  const prior = global.window;
  global.window = { localStorage: { getItem: () => JSON.stringify({ Workspaces: false, GitHub: false, Documents: false }) } };
  try {
    const html = renderRail([repo, child, note], { expansion: null });
    assert.equal([...html.matchAll(/data-rail-section-toggle=/g)].length, 5);
    for (const heading of elements.filter(element => element.props['data-rail-section-toggle'])) {
      assert.equal(heading.props['aria-expanded'], false);
      assert.equal(heading.props.children[0].props.style.transform, 'none');
    }
    assert.doesNotMatch(html, /data-rail-row=|data-rail-subsection=|data-connections-panel|data-rail-results|data-rail-add-menu/);
  } finally { if (prior === undefined) delete global.window; else global.window = prior; }
});

test('sticky note sits before the trash with smaller art and the same click targets', () => {
  let created = 0;
  renderRail([repo], { onPostIt: () => { created += 1; } });
  const bar = elements.find(element => element.props['data-rail-bar'] === '1');
  const group = bar.props.children[0];
  assert.equal(group.props.style.gap, 4);
  const [stickyNote, trash] = group.props.children.map(wrapper => wrapper.props.children[0]);
  assert.equal(trash.props['aria-label'], 'Trash');
  assert.equal(stickyNote.props['data-add-post-it'], '1');
  assert.equal(stickyNote.props.disabled, false);
  for (const control of [trash, stickyNote]) {
    assert.equal(control.props.style.width, 48);
    assert.equal(control.props.style.height, 48);
    assert.equal(control.props.children.props.style.width, 40);
    assert.equal(control.props.children.props.style.height, 40);
  }
  stickyNote.props.onClick();
  assert.equal(created, 1);

  renderRail([repo], { width: 220 });
  for (const control of elements.filter(element => element.props['data-add-post-it'] || element.props['data-trash'])) {
    assert.equal(control.props.style.width, 40);
    assert.equal(control.props.style.height, 40);
    assert.equal(control.props.children.props.style.width, 36);
    assert.equal(control.props.children.props.style.height, 36);
  }

  renderRail([repo]);
  const unavailable = elements.find(element => element.props['data-add-post-it'] === '1');
  assert.equal(unavailable.props.disabled, true);
});

test('Connections shares a compact fixed footer with the existing bottom controls', () => {
  const html = renderRail([repo]);
  const aside = elements.find(element => element.type === 'aside');
  const footer = aside.props.children.find(element => element?.type?.name === 'BottomBar');
  assert.equal(footer.props.children.type.name, 'Connections', 'the entry lives in the fixed footer, not the material scroller');
  assert.equal(aside.props.children[0].props.style.overflowY, 'auto');
  const bar = elements.find(element => element.props['data-rail-bar'] === '1');
  assert.equal(bar.props.style.display, 'flex');
  assert.equal(bar.props.style.alignItems, 'center');
  assert.ok(html.indexOf('data-rail-bar') < html.indexOf('data-rail-connections'));
  assert.ok(html.indexOf('data-add-post-it') < html.indexOf('data-trash='));
  assert.ok(html.indexOf('data-trash=') < html.indexOf('data-rail-connections'));
  const control = elements.find(element => element.type === 'button' && element.props['aria-haspopup'] === 'dialog');
  assert.equal(control.props['aria-expanded'], false);
  assert.doesNotMatch(html, /data-connections-panel/);
  assert.match(renderRail([], { topic: null, topics: [] }), /data-rail-connections/);
});

test('opening sections shows saved items and a collapsed My Projects group without loading account catalogs', () => {
  const html = renderRail([repo, note, paper], { expansion: { GitHub: true, Papers: true, Documents: true, Overleaf: true, Files: true } });
  assert.match(html, /My Projects|Browse Google Docs…|Browse projects…|Browse Zotero…/);
  for (const trigger of elements.filter(element => element.props['data-browse-source'])) assert.equal(trigger.props['aria-expanded'], false);
  assert.match(html, /data-rail-row="repo"/);
  assert.match(html, /data-rail-row="note"/);
  assert.match(html, /data-rail-row="paper"/);
  const projects = elements.find(element => element.props['data-github-projects-toggle']);
  assert.equal(projects.props['aria-expanded'], false);
  assert.equal(component('GithubRepositories'), undefined);
  assert.doesNotMatch(html, /data-source-browser|data-github-account=|data-google-account=|data-overleaf-account=|data-zotero-account=/);
});

test('Workspace supplies children to Hudson sidebar and uses its original default width', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(source, /const DEFAULT_RAIL_WIDTH = 300;/);
  assert.match(source, /for \(const child of here \? here.node.children \|\| \[\] : \[\]\) out.push\(/);
});
