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
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recordingRuntime : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { default: Rail, RailRow, RailSection } = compiled.exports;
const repo = { id: 'repo', name: 'owner/app', type: 'website', tags: ['git'], url: 'https://github.com/owner/app' };
const paper = { id: 'paper', name: 'A paper', type: 'pdf', tags: ['paper'] };
const note = { id: 'note', name: 'A note', type: 'md', tags: ['note'] };
const overleaf = { id: 'overleaf', name: 'Paper draft', type: 'website', tags: [], url: 'https://www.overleaf.com/project/example' };
const conversation = { id: 'conversation', name: 'Codex', type: 'conversation', provider: 'codex', tags: [] };
const other = { id: 'other', name: 'A website', type: 'website', tags: [], url: 'https://example.com' };
const noop = () => {};
const render = (Component, props) => {
  elements.length = 0;
  return renderToStaticMarkup(React.createElement(Component, props));
};
const renderRail = (rows, extra = {}) => render(Rail, { width: 300, workspaces: [], topic: { id: 'workspace' }, rows,
  library: rows, inRail: () => true, ...extra });
const sectionMarkup = (html, id) => html.match(new RegExp(`<section[^>]+data-rail-section="${id}"[\\s\\S]*?<\\/section>`))[0];
const githubSection = (html) => sectionMarkup(html, 'github');
const elementWithClass = (className) => elements.find((element) => typeof element.type === 'string' && element.props.className?.split(' ').includes(className));

test('the current workspace card stays above search and the restored workspace tree', () => {
  const html = renderRail([note], { topic: { id: 'workspace', name: 'Work Flow Github url -> e2b sandbox' } });
  const card = html.indexOf('data-workspace-header="1"');
  const search = html.indexOf('data-rail-search="1"');
  const tree = html.indexOf('data-rail-section="workspaces"');
  assert.ok(card >= 0 && card < search && search < tree);
  assert.match(html, /data-workspace-name="1"[^>]*>Work Flow Github url -&gt; e2b sandbox<\/span>/);
  assert.match(html, /aria-label="Switch workspace"/);
  assert.match(sectionMarkup(html, 'workspaces'), /aria-label="Sub-workspaces"/);
});

test('populated GitHub section has one header plus and one per repository, without a footer action', () => {
  const section = githubSection(renderRail([repo, { ...repo, id: 'repo2', name: 'owner/other' }]));
  assert.equal((section.match(/rail-section-add/g) || []).length, 1);
  assert.equal((section.match(/rail-row-add/g) || []).length, 2);
  assert.doesNotMatch(section, /rail-section-footer|rail-text-action|<span>Add repository<\/span>|No repositories yet/);
  assert.match(section, /aria-expanded="false"/);
  assert.ok(section.indexOf('rail-section-add') < section.indexOf('id="rail-section-github" hidden'), 'header plus remains outside the collapsed section content');
});

test('empty GitHub section retains its message and only the header plus, including with no selected workspace', () => {
  const section = githubSection(renderRail([]));
  assert.match(section, /No repositories yet/);
  assert.doesNotMatch(section, /rail-section-footer|rail-text-action/);
  assert.match(section, /rail-section-add/);
  assert.doesNotMatch(section, /rail-row-add/);
  const disabled = githubSection(renderRail([], { topic: null }));
  assert.match(disabled, /class="rail-icon-action rail-section-add"[^>]*disabled=""/);
  assert.doesNotMatch(disabled, /rail-text-action/);
});

test('populated direct context sections have labeled header and row plus buttons, without text footers', () => {
  const html = renderRail([repo, paper, note, overleaf, other], { conversations: [conversation] });
  for (const [id, label, count] of [['github', 'Add repository', 1], ['papers', 'Add paper', 1], ['overleaf', 'Add Overleaf project', 1], ['notes', 'Add document', 1]]) {
    const section = sectionMarkup(html, id);
    assert.equal((section.match(/rail-section-add/g) || []).length, count, id);
    assert.equal((section.match(/rail-row-add/g) || []).length, count, id);
    assert.match(section, new RegExp(`rail-section-add" aria-label="${label}"`));
    assert.match(section, new RegExp(`rail-row-add" aria-label="${label}"`));
    assert.doesNotMatch(section, /rail-section-footer|rail-text-action|rail-empty/, id);
  }
});

test('Overleaf sits directly above Papers and retains its own add and open actions', () => {
  const opened = [];
  const html = renderRail([paper, overleaf], { onRowClick: (row) => opened.push(row.id) });
  const section = sectionMarkup(html, 'overleaf');
  assert.doesNotMatch(sectionMarkup(html, 'papers'), /data-rail-subsection="overleaf"|data-rail-row="overleaf"/);
  const sections = [...html.matchAll(/data-rail-section="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(sections[sections.indexOf('papers') - 1], 'overleaf');
  assert.match(section, /rail-section-add" aria-label="Add Overleaf project"/);
  assert.match(section, /rail-row-add" aria-label="Add Overleaf project"/);
  const row = elements.find((element) => element.type === RailRow && element.props.row.id === overleaf.id);
  row.props.onClick(overleaf);
  assert.deepEqual(opened, [overleaf.id]);
  assert.equal(row.props.glyphKind, 'overleaf');
});

test('Other context shows five nested categories even when empty, with parent and conversation add actions', () => {
  const section = sectionMarkup(renderRail([]), 'other');
  assert.match(section, /id="rail-section-other" hidden/);
  assert.match(section, /<ul class="workspace-tree workspace-children">/);
  assert.deepEqual([...section.matchAll(/data-rail-subsection="([^"]+)"/g)].map((match) => match[1]), ['images', 'datasets', 'web-pages', 'conversations', 'other-notes']);
  for (const label of ['Images', 'Datasets', 'Web pages', 'Conversations', 'Notes']) assert.ok(section.includes(`aria-label="Expand ${label}" aria-expanded="false"`));
  for (const message of ['No images yet', 'No datasets yet', 'No web pages yet', 'No conversations yet', 'No notes yet']) assert.ok(section.includes(message));
  assert.equal((section.match(/data-rail-section=/g) || []).length, 1, 'children are tree rows, not extra top-level sections');
  assert.equal((section.match(/rail-section-add/g) || []).length, 2);
  assert.match(section, /rail-section-add" aria-label="Add conversation"/);
  assert.doesNotMatch(section, /rail-section-footer|rail-text-action|Add image|Add dataset|Add web page/);
});

test('nested source rows retain opening, renaming, dragging, removal, and hover behavior', () => {
  const images = { id: 'image', name: 'Screenshot', type: 'image', path: '/tmp/screenshot.png' };
  const dataset = { id: 'data', name: 'Experiment', type: 'csv', path: '/tmp/data.csv' };
  const opened = [], removed = [];
  const rename = noop;
  const html = renderRail([images, dataset, other, paper], { onRowClick: (row) => opened.push(row.id), onTrashRow: (row) => removed.push(row.id), onRowRenameStart: rename });
  const section = sectionMarkup(html, 'other');
  for (const [category, item] of [['images', images], ['datasets', dataset], ['web-pages', other]]) {
    assert.ok(section.indexOf(`data-rail-subsection="${category}"`) < section.indexOf(`data-rail-row="${item.id}"`));
    const row = elements.find((element) => element.type === RailRow && element.props.row.id === item.id);
    row.props.onClick(item);
    row.props.onRemove(item);
    assert.equal(row.props.onRenameStart, rename);
    assert.equal(typeof row.props.onDragStart, 'function');
    assert.equal(typeof row.props.onEnter, 'function');
    assert.equal(typeof row.props.onAdd, 'function');
  }
  assert.deepEqual(opened, ['image', 'data', 'other']);
  assert.deepEqual(removed, opened);
  assert.equal((section.match(/rail-row-add/g) || []).length, 3);
  assert.doesNotMatch(section, /data-rail-row="paper"/);
});

test('conversation rows open their session without library rename, preview or removal actions', () => {
  const opened = [];
  const html = renderRail([], { conversations: [conversation], onOpenConversation: (id) => opened.push(id) });
  const row = elements.find((element) => element.type === RailRow && element.props.row.id === conversation.id);
  row.props.onClick(conversation);
  assert.deepEqual(opened, [conversation.id]);
  assert.equal(row.props.onDragStart, undefined);
  assert.equal(row.props.onRenameStart, undefined);
  assert.equal(row.props.onRemove, undefined);
  const otherSection = sectionMarkup(html, 'other');
  assert.match(otherSection, /data-rail-subsection="conversations"/);
  assert.match(otherSection, /rail-row-add" aria-label="Add conversation"/);
  assert.doesNotMatch(otherSection, /data-rail-remove/);
  assert.doesNotMatch(html, /data-rail-section="conversations"/);
});

test('new or active conversations do not automatically expand Other context or Conversations', () => {
  for (const conversations of [[], [conversation], [{ ...conversation, on: true }], [conversation, { ...conversation, id: 'new-chat', on: true }]]) {
    const section = sectionMarkup(renderRail([], { conversations }), 'other');
    assert.match(section, /aria-label="Other context"[^>]*aria-expanded="false"/);
    assert.match(section, /id="rail-section-other" hidden/);
    assert.match(section, /aria-label="Expand Conversations" aria-expanded="false"/);
    for (const id of ['images', 'datasets', 'web-pages', 'conversations', 'other-notes']) assert.ok(section.includes(`id="rail-subsection-${id}" hidden`));
  }
});

test('empty sections retain their message and use the header plus as their only add action', () => {
  const html = renderRail([]);
  for (const [id, label, message] of [
    ['workspaces', 'Add workspace', 'No sub-workspaces yet'],
    ['github', 'Add repository', 'No repositories yet'],
    ['papers', 'Add paper', 'No papers yet'],
    ['overleaf', 'Add Overleaf project', 'No Overleaf projects yet'],
    ['notes', 'Add document', 'No documents yet'],
  ]) {
    const section = sectionMarkup(html, id);
    assert.match(section, new RegExp(`rail-section-add" aria-label="${label}"`));
    assert.match(section, new RegExp(`<p class="rail-empty">${message}<\\/p>`));
    assert.doesNotMatch(section, /rail-row-add|rail-section-footer|rail-text-action/);
  }
  assert.match(html, /rail-add-context[\s\S]*Add context/);
  const list = elements.find((element) => element.type === 'div' && element.props.className === 'rail-sections');
  const children = React.Children.toArray(list.props.children);
  assert.equal(children.at(-1).props.className, 'rail-add-context', 'global Add context sits directly below the category list');
});

test('moving a sticky reveals Other context and Notes without opening unrelated sections', () => {
  const sticky = { ...note, id: 'sticky', tags: ['note', 'sticky'] };
  const opened = [];
  const rename = noop;
  const html = renderRail([repo, note, sticky], { flashId: sticky.id, onRowClick: (row) => opened.push(row.id), onRowRenameStart: rename });
  assert.match(sectionMarkup(html, 'other'), /aria-expanded="true"/);
  assert.doesNotMatch(sectionMarkup(html, 'other'), /id="rail-section-other" hidden/);
  assert.match(sectionMarkup(html, 'other'), /aria-label="Collapse Notes" aria-expanded="true"/);
  assert.match(sectionMarkup(html, 'other'), /id="rail-subsection-other-notes"[^>]*>[\s\S]*data-rail-row="sticky"/);
  const row = elements.find((element) => element.type === RailRow && element.props.row.id === sticky.id);
  row.props.onClick(sticky);
  assert.deepEqual(opened, [sticky.id]);
  assert.equal(row.props.onRenameStart, rename);
  assert.equal(typeof row.props.onRemove, 'function');
  assert.match(sectionMarkup(html, 'notes'), /aria-expanded="false"/);
  assert.match(sectionMarkup(html, 'github'), /aria-expanded="false"/);
  const reloaded = sectionMarkup(renderRail([sticky]), 'other');
  assert.match(reloaded, /aria-expanded="false"/, 'ordinary reload still respects the usual collapsed start');
  assert.match(reloaded, /id="rail-subsection-other-notes" hidden/);
});

test('workspace header adds a root, row plus adds a child, and populated trees have no text add footer', () => {
  const calls = [];
  const html = renderRail([], { workspaces: [{ id: 'parent', name: 'My workspace', children: [] }],
    onCreateWorkspace: (parentId) => calls.push(parentId) });
  const section = sectionMarkup(html, 'workspaces');
  assert.match(section, /rail-section-add" aria-label="Add workspace"/);
  assert.match(section, /aria-label="Add sub-workspace to My workspace"/);
  assert.doesNotMatch(section, /rail-section-footer|rail-text-action/);
  const header = elements.find((element) => element.type === RailSection && element.props.id === 'workspaces');
  const child = elements.find((element) => element.type === 'button' && element.props['aria-label'] === 'Add sub-workspace to My workspace');
  header.props.onAdd();
  child.props.onClick();
  assert.deepEqual(calls, [null, 'parent']);
});

test('context add buttons require a selected workspace, but workspace creation does not', () => {
  const html = renderRail([repo, paper, note, overleaf, other], { topic: null, conversations: [conversation] });
  for (const id of ['github', 'papers', 'overleaf', 'notes', 'other']) {
    const section = sectionMarkup(html, id);
    assert.match(section, /class="rail-icon-action rail-section-add"[^>]*disabled=""/);
    assert.match(section, /class="rail-icon-action rail-row-add"[^>]*disabled=""/);
  }
  const conversationAdd = elements.find((element) => element.type === 'button' && element.props.className === 'rail-icon-action rail-section-add' && element.props['aria-label'] === 'Add conversation');
  assert.equal(conversationAdd.props.disabled, true);
  const workspace = sectionMarkup(html, 'workspaces');
  assert.match(workspace, /rail-section-add/);
  assert.doesNotMatch(workspace, /disabled=""/);
});

test('document header and row plus buttons reuse note creation, including the empty section header', () => {
  let created = 0;
  let opened = 0;
  const props = { onNewNote: () => { created++; }, onRowClick: () => { opened++; } };
  renderRail([note], props);
  const header = elements.find((element) => element.type === RailSection && element.props.id === 'notes');
  const rowAdd = elementWithClass('rail-row-add');
  header.props.onAdd();
  let stopped = false;
  rowAdd.props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  renderRail([], props);
  const emptyHeader = elements.find((element) => element.type === RailSection && element.props.id === 'notes');
  emptyHeader.props.onAdd();
  assert.equal(created, 3);
  assert.equal(opened, 0);
});

test('repository open and add are sibling buttons; add never opens or renames the existing repository', () => {
  const calls = [];
  const html = render(RailRow, { row: repo, onClick: (row) => calls.push(['open', row.id]), onAdd: (event) => calls.push(['add', event.currentTarget]),
    onRenameStart: () => calls.push(['rename']), onDragStart: noop });
  assert.doesNotMatch(html, /role="button"/);
  assert.equal((html.match(/<button\b/g) || []).length, 2);
  const open = elementWithClass('rail-row-open');
  const add = elementWithClass('rail-row-add');
  const row = elements.find((element) => element.props['data-rail-row'] === repo.id);
  assert.equal(row.props.onClick, undefined);
  open.props.onClick();
  let stopped = 0, prevented = 0;
  const trigger = {};
  const event = { currentTarget: trigger, stopPropagation() { stopped++; }, preventDefault() { prevented++; } };
  add.props.onClick(event);
  add.props.onDoubleClick(event);
  add.props.onDragStart(event);
  assert.deepEqual(calls, [['open', repo.id], ['add', trigger]]);
  assert.equal(stopped, 3);
  assert.equal(prevented, 1);
  assert.equal(add.props.draggable, false);
});

test('header plus opens the add action without toggling the section', () => {
  const calls = [];
  render(RailSection, { id: 'github', label: 'GitHub', onAdd: (event) => calls.push(event.currentTarget) });
  const add = elementWithClass('rail-section-add');
  const heading = elementWithClass('rail-section-heading');
  assert.notEqual(add.props.onClick, heading.props.onClick);
  const trigger = {};
  add.props.onClick({ currentTarget: trigger });
  assert.deepEqual(calls, [trigger]);
});

test('repository hover does not schedule or fetch a preview; other rows retain their hover previews', () => {
  renderRail([repo, { id: 'paper', name: 'A paper', type: 'pdf', tags: ['paper'] }]);
  const repos = elements.find((element) => element.type === RailRow && element.props.row.id === repo.id);
  const paper = elements.find((element) => element.type === RailRow && element.props.row.id === 'paper');
  assert.notEqual(repos.props.onEnter, paper.props.onEnter);
  assert.equal(typeof paper.props.onEnter, 'function');
  const prior = global.setTimeout;
  const priorClear = global.clearTimeout;
  global.setTimeout = () => { assert.fail('Repository hover must not schedule a preview'); };
  try {
    repos.props.onEnter(repo, {});
    const cancelled = [];
    global.setTimeout = () => 'pending-paper-preview';
    global.clearTimeout = (timer) => cancelled.push(timer);
    paper.props.onEnter(paper.props.row, {});
    repos.props.onEnter(repo, {});
    assert.ok(cancelled.includes('pending-paper-preview'), 'entering a repo also cancels a pending preview from another row');
  } finally { global.setTimeout = prior; global.clearTimeout = priorClear; }
});

test('renaming a repository hides its plus; existing drag and rename actions remain available', () => {
  let renamed = false;
  render(RailRow, { row: repo, onAdd: noop, onClick: noop, onRenameStart: () => { renamed = true; }, onDragStart: noop });
  const row = elements.find((element) => element.props['data-rail-row'] === repo.id);
  row.props.onDoubleClick({ stopPropagation: noop });
  assert.equal(renamed, true);
  assert.equal(row.props.draggable, true);
  const editing = render(RailRow, { row: { ...repo, editing: true }, onAdd: noop, onClick: noop, onDragStart: noop });
  assert.match(editing, /data-rename="repo"/);
  assert.doesNotMatch(editing, /rail-row-add|rail-row-open/);
  assert.match(editing, /draggable="false"/);
});

test('hover actions reveal on keyboard focus, not lingering mouse focus, and support non-hover devices', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/sidebar.css'), 'utf8');
  assert.match(css, /\.rail-section-add,\.rail-row-add\{opacity:0;pointer-events:none;/);
  assert.doesNotMatch(css, /:focus-within/);
  assert.match(css, /\.rail-section-head:has\(:focus-visible\) \.rail-section-add/);
  assert.match(css, /\.rail-context-row:has\(:focus-visible\) \.rail-row-add\{opacity:1;pointer-events:auto\}/);
  assert.match(css, /\.workspace-row:has\(:focus-visible\) \.workspace-tree-actions\{opacity:1;pointer-events:auto\}/);
  assert.match(css, /@media \(hover:none\)\{\.rail-section-add,\.rail-row-add\{opacity:1;pointer-events:auto\}/);
});
