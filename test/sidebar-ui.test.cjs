'use strict';

// The sidebar as it draws (src/renderer/workspace/Rail.jsx, redone 2026-10-13 from design/sidebar-mockup/Sidebar.html):
// the top-level project's name with Settings and New note; Agents, Library and Search, fixed; Projects, three level-2
// projects at most with what is open under them, ten rows in all; Sources, this project's folder and the person's own
// folders; the stickies at the foot. Sections have no icons; indented rows have none either.

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
  ws('ag', 'Agents', at(450), [ws('bb', 'Bart build agents', at(30), [ws('sx', 'Sandbox', at(31))])]),
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
    entries: [{ id: 'agent:a1', kind: 'bart', title: 'Bart', node: 'bb', state: 'unseen', at: at(3) }, { id: 'build:b1', kind: 'build', title: 'Pills', node: 'ic', state: 'running', at: at(1) }],
    rows,
    folders: [{ id: 'f1', name: 'References', items: ['w1', 'gone'] }],
    library: rows,
    inRail: (id) => rows.some((candidate) => candidate.id === id),
    onSelectWorkspace: call('select'), onCreateWorkspace: call('create'), onRenameWorkspace: call('rename'), onDeleteWorkspace: call('delete'),
    onOpenVersion: call('version'), onSeenAll: call('seen'), onOpenRow: call('open'), onRenameRow: call('renameRow'),
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

const between = (html, from, to) => html.slice(html.indexOf(from), to ? html.indexOf(to) : undefined);

test('the head: the top-level project\'s name with its chevron, which never turns; then Settings and New note', () => {
  const { html } = render();
  assert.match(html, /data-sb-trigger="project"[^>]*>.*?<span data-sb-project-name="1"[^>]*>Engelbart<\/span><span class="sb-chev-mark"[^>]*><svg/);
  assert.doesNotMatch(between(html, 'data-sb-trigger="project"', 'data-sb-settings'), /data-open=/, 'the switcher\'s chevron has no open state');
  assert.ok(html.indexOf('data-sb-settings') < html.indexOf('data-sb-new-note'), 'Settings, then New note');
  assert.doesNotMatch(between(html, 'data-sb-head="project"', 'data-sb-fixed'), /aria-label="Search"/, 'Search is a row now, not an icon');
});

test('fixed rows, in order: Agents, Library, Search; Inbox, Connections and Add sources are gone', () => {
  const { html } = render();
  assert.deepEqual(attrs(html, 'data-sb-fixed-row'), ['agents', 'library', 'search']);
  assert.doesNotMatch(html, />Inbox<|>Connections<|>Add sources</);
  assert.match(html, /data-sb-fixed-row="library".*?data-sb-count="library"[^>]*>11</, 'the library\'s size');
});

test('Agents: one count, running and to look at together, its outline breathing while one runs, filled once all wait; 9+', () => {
  const { html } = render();
  assert.match(html, /<span class="sb-pill running"[^>]*data-sb-count="agents"[^>]*>2</);
  const done = render({ entries: [{ id: 'a', node: 'sb', state: 'needs' }, { id: 'b', node: null, state: 'unseen' }] }).html;
  assert.match(done, /<span class="sb-pill ready"[^>]*data-sb-count="agents"[^>]*>2</);
  const many = render({ entries: Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, node: 'sb', state: 'unseen' })) }).html;
  assert.match(many, /data-sb-count="agents"[^>]*>9\+</);
  assert.doesNotMatch(render({ entries: [{ id: 'old', node: 'sb', state: 'done' }] }).html, /data-sb-count="agents"/, 'nothing to count: no pill');
});

test('Projects: three level-2 projects at most, the way down to where you are open, its siblings; More for the rest; this one marked', () => {
  const { html } = render();
  const section = between(html, 'data-sb-section="projects"', 'data-sb-section="sources"');
  assert.deepEqual(attrs(section, 'data-sb-project-row'), ['ui', 'sb', 'ic', 'mc', 'ag', 'lb']);
  assert.match(section, /data-active="1"[^>]*data-sb-project-row="sb"/, 'Sidebar, where you are, marked');
  assert.match(section, /data-sb-more="projects"/, 'More, for Getting started');
  assert.deepEqual(attrs(section, 'data-level'), ['2', '3', '4', '3', '2', '2']);
});

test('counts roll up, each agent once: a parent counts what is under it, folded or open; a number, no box', () => {
  const { html } = render();
  const count = (id) => (html.match(new RegExp(`data-sb-count="${id}"[^>]*>([^<]+)<`)) || [])[1] || null;
  assert.deepEqual([count('ui'), count('sb'), count('ic'), count('ag'), count('lb')], ['1', '1', '1', '1', null]);
  assert.match(html, /<span class="sb-count running"[^>]*data-sb-count="ui"/, 'grey and breathing while it runs');
  assert.match(html, /<span class="sb-count done"[^>]*data-sb-count="ag"/, 'dark once ready');
});

test('a + makes a project within the title\'s project or a row\'s, never in a fourth-level one; Ctrl+number only on level 2', () => {
  const { html } = render();
  assert.match(html, /aria-label="Create project within Engelbart"[^>]*data-sb-new-workspace="1"/);
  assert.deepEqual(attrs(html, 'data-sb-new-child'), ['ui', 'sb', 'mc', 'ag', 'lb'], 'Iconography is the fourth level: no +');
  assert.match(html, /aria-label="User Interface, Ctrl\+2"/);
  assert.doesNotMatch(html, /aria-label="Sidebar, Ctrl/);
});

test('chevrons: down while open, up while folded; a level-2 project you are not in shows its own on hover', () => {
  const { html } = render();
  assert.match(html, /class="sb-chev" data-open="1"[^>]*data-sb-chevron="ui"/, 'User Interface: open, always shown');
  assert.match(html, /class="sb-chev sb-on-hover" data-open="0"[^>]*data-sb-chevron="ag"/, 'Agents: folded, on hover');
  assert.match(html, /data-sb-children="sb" data-guide="1"/, 'the guide line beside the deepest group open');
  assert.match(html, /data-sb-children="ui" data-guide="0"/);
});

test('sections have no icon: a section\'s title is its name and its chevron', () => {
  const { html } = render();
  for (const key of ['projects', 'sources']) {
    const head = html.slice(html.indexOf(`data-sb-head="${key}"`));
    const toggle = head.slice(0, head.indexOf('</button>'));
    assert.equal((toggle.match(/<svg/g) || []).length, 1, `${key}: only the chevron`);
  }
});

test('Sources: this project\'s folder, open, its first four and More; the person\'s folders, folded; Create new', () => {
  const { html } = render();
  const sources = between(html, 'data-sb-section="sources"', 'data-sb-foot');
  assert.deepEqual(attrs(sources, 'data-sb-folder'), ['project', 'f1']);
  assert.match(sources, /aria-expanded="true"[^>]*data-sb-folder="project"/);
  assert.match(sources, /aria-expanded="false"[^>]*data-sb-folder="f1"/);
  assert.deepEqual(attrs(sources, 'data-sb-source'), ['n0', 'n1', 'n2', 'n3'], 'eleven sources: four, then More');
  assert.match(sources, /data-sb-more="project"/);
  assert.match(sources, /data-sb-create-folder="1"/);
  assert.doesNotMatch(html, /Starred|data-sb-star/, 'Starred is gone');
});

test('a source wears its kind\'s icon', async () => {
  const { pathToFileURL } = require('node:url');
  const { sourceIcon } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/sidebar.js')).href);
  const { html } = render({ rows: [rows[7], rows[8], rows[9], rows[10]] });
  const sources = between(html, 'data-sb-section="sources"', 'data-sb-foot');
  assert.deepEqual(attrs(sources, 'data-sb-source'), ['w1', 'w2', 'g1', 'p1']);
  assert.deepEqual([rows[7], rows[9], rows[10]].map(sourceIcon), ['website', 'git', 'pdf']);
});

test('the foot: Hide stickies while they show, Show stickies (dotted) while hidden; the trash only while something is in it', () => {
  const shown = render().html;
  assert.match(shown, /data-toggle-post-its="shown"[^>]*>.*?Hide stickies/);
  assert.doesNotMatch(shown, /data-sb-trash/);
  const hidden = render({ postItsHidden: true, trashFull: true, postItTrash: { count: 1, load: async () => [], restore: async () => {} } }).html;
  assert.match(hidden, /data-toggle-post-its="hidden"[^>]*>.*?stroke-dasharray.*?Show stickies/);
  assert.match(hidden, /data-sb-trash="1"/);
});

test('a project with nothing in it yet says so, and still offers the +', () => {
  const { html } = render({ roots: [], hereId: null, rows: [], entries: [] });
  assert.match(html, /No projects yet/);
  assert.match(html, /data-sb-new-workspace="1"/);
  assert.doesNotMatch(html, /data-sb-more="projects"/);
});

test('folded away it draws nothing: display none, kept as it is', () => {
  assert.match(render({ hidden: true }).html, /^<aside aria-label="Sidebar" data-sidebar="1" style="flex:none;width:300px;min-height:0;display:none/);
});
