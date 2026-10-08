'use strict';

// The workspace sidebar as it draws (src/renderer/workspace/Rail.jsx, 2026-10-07, Hudson's "Sidebar" workspace): the
// project's name with Settings and Search; Inbox, Agents, Connections, Library and Add sources, fixed; Workspaces, the three
// worked in last with their sub-workspaces; Your sources by kind; the stickies at the foot. Sections have no icons;
// indented rows have none either.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const runtime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const elements = [];
const recording = { ...runtime };
for (const name of ['jsx', 'jsxs']) recording[name] = (...args) => { const element = runtime[name](...args); elements.push(element); return element; };
const filename = path.join(__dirname, '__sidebar-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/Rail.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const Rail = compiled.exports.default;

const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const ws = (id, name, edited, children = []) => ({ id, name, edited, children, archives: [] });
const roots = [
  ws('gs', 'Getting started', at(600)),
  ws('ui', 'User Interface', at(500), [ws('sb', 'Sidebar', at(5), [ws('ic', 'Iconography', at(400))]), ws('mc', 'Middle Canvas', at(50))]),
  ws('ag', 'Agents', at(450), [ws('bb', 'Bart build agents', at(30))]),
  ws('lb', 'Library', at(100)),
];
const row = (id, name, type, tags = [], more = {}) => ({ id, name, type, tags, ...more });
const notes = Array.from({ length: 7 }, (_, i) => row(`n${i}`, `Note ${i}`, 'md', ['note']));
const rows = [...notes, row('w1', 'Magic Ink', 'website', [], { url: 'https://worrydream.com/MagicInk/' }), row('w2', 'Linear refresh', 'website'), row('g1', 'engelbart-canvas', 'folder', ['git']), row('p1', 'Working spheres', 'pdf')];

function render(more = {}) {
  const calls = [];
  const call = (name) => (...args) => { calls.push([name, ...args]); };
  const props = {
    width: 300,
    project: { id: 'p', name: 'Engelbart' },
    roots,
    hereId: 'sb',
    recent: [],
    agents: [{ id: 'a1', kind: 'bart', projectId: 'p', workspaceId: 'ag', status: 'waiting', name: 'Agents', finished: at(3) }],
    builds: [],
    rows,
    starred: ['p1'],
    library: rows,
    inRail: (id) => rows.some((candidate) => candidate.id === id),
    onSelectWorkspace: call('select'), onCreateWorkspace: call('create'), onRenameWorkspace: call('rename'), onDeleteWorkspace: call('delete'),
    onOpenVersion: call('version'), onSeenAll: call('seen'), onStar: call('star'), onOpenRow: call('open'), onRenameRow: call('renameRow'),
    onRemoveRow: call('remove'), onLinkRow: call('link'), onOpenHeld: call('held'), onDropItems: call('drop'), onAddInput: call('add'),
    onPickDisk: call('disk'), onNewNote: call('note'), onNewSticky: call('sticky'), onPickRepo: call('repo'), onOpenLink: call('link'),
    onOpenProject: call('project'), onNewProject: call('newProject'), onAllProjects: call('home'), onRenameProject: call('renameProject'),
    onTogglePostIts: call('stickies'),
    trashRef: () => {},
    ...more,
  };
  elements.length = 0;
  const previous = global.window;
  global.window = { engelbartAPI: {}, innerHeight: 900, innerWidth: 1440 };
  try { return { html: renderToStaticMarkup(React.createElement(Rail, props)), calls }; } finally { global.window = previous; }
}
const attrs = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map((match) => match[1]);

test('the head: the project\'s name with its chevron, then Settings and Search, in that order', () => {
  const { html } = render();
  assert.match(html, /data-sb-trigger="project"[^>]*>.*?<span data-sb-project-name="1"[^>]*>Engelbart<\/span><svg/);
  assert.ok(html.indexOf('data-sb-settings') < html.indexOf('data-sb-search'), 'Settings, then Search');
  assert.equal(attrs(html, 'aria-label').filter((label) => label === 'Settings' || label === 'Search').join(','), 'Settings,Search');
});

test('fixed rows, in order: Inbox, Agents, Connections, Library, Add sources; the inbox wears its dot and count while an agent waits', () => {
  const { html } = render();
  assert.deepEqual(attrs(html, 'data-sb-fixed-row'), ['inbox', 'agents', 'connections', 'library', 'add']);
  assert.match(html, /data-sb-fixed-row="inbox".*?data-inbox-dot="1".*?data-sb-count="inbox"[^>]*>1</);
  const quiet = render({ agents: [] }).html;
  assert.doesNotMatch(quiet, /data-inbox-dot|data-sb-count="inbox"/);
});

test('Workspaces: the three worked in last, the one holding this workspace open onto its children, this one marked; no grandchildren; More', () => {
  const { html } = render();
  assert.deepEqual(attrs(html.slice(html.indexOf('data-sb-section="workspaces"'), html.indexOf('data-sb-section="sources"')), 'data-sb-workspace'), ['ui', 'sb', 'mc', 'ag', 'lb']);
  assert.match(html, /<div[^>]*data-active="1"[^>]*data-sb-workspace="sb"/, 'Sidebar, where you are, marked');
  assert.doesNotMatch(html, /<div[^>]*data-active="1"[^>]*data-sb-workspace="ui"/, 'not its parent');
  assert.doesNotMatch(html, /data-sb-workspace="ic"/, 'Iconography is a grandchild');
  assert.match(html, /data-sb-more="workspaces"/, 'More, for Getting started and the rest');
  assert.deepEqual(attrs(html, 'data-sb-waiting'), ['ag'], 'Agents, where an agent waits, wears the blue dot');
});

test('a + on the Workspaces title, and on each workspace row but not on its sub-workspaces', () => {
  const { html } = render();
  assert.match(html, /data-sb-new-workspace="1"/);
  assert.match(html, /aria-label="Add workspace"[^>]*title="Add workspace"/, 'its tooltip');
  assert.match(html, /aria-label="Add sub-workspace"[^>]*title="Add sub-workspace"/, 'and the row\'s');
  assert.deepEqual(attrs(html, 'data-sb-new-child'), ['ui', 'ag', 'lb']);
});

test('sections have no icon: a section\'s title is its name and its chevron, which always shows', () => {
  const { html } = render();
  for (const key of ['workspaces', 'sources']) {
    const head = html.slice(html.indexOf(`data-sb-head="${key}"`));
    const toggle = head.slice(0, head.indexOf('</button>'));
    assert.equal((toggle.match(/<svg/g) || []).length, 1, `${key}: only the chevron`);
  }
});

test('Your sources: Starred and Notes, each with its icon and no chevron, always open; the rest mixed below with no heading', () => {
  const { html } = render();
  assert.deepEqual(attrs(html, 'data-sb-group'), ['starred', 'notes'], 'two subsections');
  assert.match(html, /data-sb-group="starred"[^>]*><span[^>]*><svg/, 'a subsection has its icon');
  const sources = html.slice(html.indexOf('data-sb-sources-body'));
  assert.doesNotMatch(sources, /aria-expanded/, 'nothing folds but the section itself');
  assert.deepEqual(attrs(html.slice(html.indexOf('data-sb-group-rows="starred"')), 'data-sb-source')[0], 'p1', 'the starred paper under Starred');
  assert.match(html, /data-sb-group-rows="other"/, 'websites, code and files in one list');
  assert.doesNotMatch(html, /data-sb-group="(websites|code|files|other)"/);
});

test('an open subsection shows its first few, indented without icons, then More; a starred row keeps its star in sight', () => {
  const { html } = render();
  const notesRows = html.slice(html.indexOf('data-sb-group-rows="notes"'), html.indexOf('data-sb-group-rows="other"'));
  assert.deepEqual(attrs(notesRows, 'data-sb-source').slice(0, 5), ['n0', 'n1', 'n2', 'n3', 'n4'], 'five: "the first few"');
  assert.match(notesRows, /data-sb-more="notes"/);
  assert.match(notesRows, /data-sb-source="n0"[^>]*><span style="flex:0 1 auto/, 'an indented row starts with its name, no icon');
  const starredNote = render({ starred: ['n1'] }).html;
  const n1 = starredNote.slice(starredNote.indexOf('data-sb-group-rows="notes"'));
  assert.match(n1.slice(n1.indexOf('data-sb-source="n1"')), /^[^]*?class="sb-act sb-act-on"[^>]*data-sb-star="n1"/, 'starred: its star shows without the pointer on it');
  assert.match(n1.slice(n1.indexOf('data-sb-source="n2"')), /^[^]*?class="sb-act"[^>]*data-sb-star="n2"/, 'not starred: on hover only');
});

test('the mixed sources are not indented and each has its own icon', () => {
  const { html } = render();
  const other = html.slice(html.indexOf('data-sb-group-rows="other"'));
  assert.match(other, /data-sb-source="[^"]+"[^>]*><span[^>]*><svg/, 'a mixed row starts with its icon');
});

test('the foot: Hide stickies while they show, Show stickies (dotted) while hidden; the trash only while something is in it', () => {
  const shown = render().html;
  assert.match(shown, /data-toggle-post-its="shown"[^>]*>.*?Hide stickies/);
  assert.doesNotMatch(shown, /data-sb-trash/);
  const hidden = render({ postItsHidden: true, trashFull: true, postItTrash: { count: 1, load: async () => [], restore: async () => {} } }).html;
  assert.match(hidden, /data-toggle-post-its="hidden"[^>]*>.*?stroke-dasharray.*?Show stickies/);
  assert.match(hidden, /data-sb-trash="1"/);
});

test('a project with no workspace yet says so, and still offers the +', () => {
  const { html } = render({ roots: [], hereId: null, rows: [], starred: [] });
  assert.match(html, /No workspaces yet/);
  assert.match(html, /data-sb-new-workspace="1"/);
  assert.match(html, /aria-label="Add workspace"[^>]*title="Add workspace"/, 'its tooltip');
  assert.doesNotMatch(html, /data-sb-more="workspaces"/);
});

test('folded away it draws nothing: display none, kept as it is', () => {
  assert.match(render({ hidden: true }).html, /^<aside aria-label="Sidebar" data-sidebar="1" style="flex:none;width:300px;min-height:0;display:none/);
});
