'use strict';

// The sidebar's Agents panel (src/renderer/workspace/SidebarPanels.jsx, 2026-10-13): a Build waiting on you offers Reject
// on its row's hover, which hands the bare build id on (the workspace asks to confirm, as the card does); a press on the
// row still goes to its workspace. Running and Done rows offer nothing. A Build's row, in Agents or the Inbox, opens its
// workspace at its card (onRevealBuild, as the Agent Viewer does); a cleared Build its archived version; the rest their workspace.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const ReactDOM = require('react-dom');
const runtime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const elements = [];
const recording = { ...runtime };
for (const name of ['jsx', 'jsxs']) recording[name] = (...args) => { const element = runtime[name](...args); elements.push(element); return element; };
// The panel floats in a portal, which a server render cannot draw: here it draws in place.
const reactDom = { ...ReactDOM, createPortal: (children) => children };
const filename = path.join(__dirname, '__agents-panel-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/SidebarPanels.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) {
  if (id === 'react/jsx-runtime') return recording;
  if (id === 'react-dom') return reactDom;
  return Module.prototype.require.call(this, id);
};
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { AgentsPanel, InboxPanel } = compiled.exports;

// Where a row's press goes is the sidebar's (Rail.jsx goToAgent), built on its own here.
const railFile = path.join(__dirname, '__agents-panel-rail.cjs');
const railBuilt = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/Rail.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const rail = new Module(railFile, module);
rail.paths = module.paths;
global.window = { engelbartAPI: {} };
try { rail._compile(railBuilt.outputFiles[0].text, railFile); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { goToAgent } = rail.exports;

const at = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const entry = (id, status, group) => ({ id: `build:${id}`, kind: 'build', title: `${group} ${id}`, workspaceId: 'sb', state: status, at: at(1), task: { id, status } });
const groups = {
  running: [entry('r1', 'running', 'Running'), entry('r2', 'accepting', 'Running'), { id: 'agent:q1', kind: 'bart', title: 'Bart', workspaceId: 'sb', state: 'Working', at: at(2) }],
  waiting: [entry('w1', 'needs-you', 'Waiting'), entry('w2', 'review', 'Waiting'), entry('w3', 'failed', 'Waiting')],
  done: [entry('d1', 'discarded', 'Done'), entry('d2', 'accepted', 'Done')],
};

function render(more = {}) {
  const calls = [];
  const props = { anchor: { left: 0, right: 300, top: 40, bottom: 72, width: 280 }, groups, nameOf: () => 'Sidebar', onGo: (e) => calls.push(['go', e.id]), onReject: (id) => calls.push(['reject', id]), onClose: () => calls.push(['close']), ignore: null, ...more };
  elements.length = 0;
  const previous = { window: global.window, document: global.document };
  global.window = { engelbartAPI: {}, innerHeight: 900, innerWidth: 1440 };
  global.document = { body: {} }; // the portal's target, which the stub above ignores
  try { return { html: renderToStaticMarkup(React.createElement(AgentsPanel, props)), calls }; }
  finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; } }
}
const attrs = (html, name) => [...html.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))].map((match) => match[1]);

test('Waiting rows offer Reject on hover; Running (an accepting Build too) and Done rows do not', () => {
  const { html } = render();
  assert.deepEqual(attrs(html, 'data-agent-reject'), ['w1', 'w2', 'w3']);
  const buttons = [...html.matchAll(/<button[^>]*data-agent-reject="[^"]+"[^>]*>/g)].map((match) => match[0]);
  assert.ok(buttons.every((tag) => /class="sb-act"/.test(tag) && /aria-label="Reject"/.test(tag) && /title="Reject"/.test(tag)), 'a hover action labelled Reject');
});

test('pressing X hands the bare build id to onReject without reaching the row; the row still goes to its workspace', () => {
  const { calls } = render();
  const button = elements.find((element) => element.type === 'button' && element.props['data-agent-reject'] === 'w2');
  let stopped = 0;
  button.props.onMouseDown({ stopPropagation: () => { stopped += 1; } });
  button.props.onClick({ stopPropagation: () => { stopped += 1; } });
  assert.equal(stopped, 2, 'the press stops at the button');
  assert.deepEqual(calls, [['reject', 'w2']]);
  const row = elements.find((element) => element.props && element.props['data-agent-entry'] === 'build:w2' && element.props.role === 'button');
  row.props.onClick();
  assert.deepEqual(calls.at(-1), ['go', 'build:w2']);
});

test('without onReject no row offers Reject', () => {
  const { html } = render({ onReject: null });
  assert.deepEqual(attrs(html, 'data-agent-reject'), []);
});

/* ------------------------------------------------- where a row's press goes */

const routes = () => {
  const calls = [];
  const handlers = {
    onOpenVersion: (version) => calls.push(['version', version]),
    onRevealBuild: (target) => calls.push(['reveal', target]),
    onSelectWorkspace: (id) => calls.push(['select', id]),
  };
  return { calls, handlers, go: (entry) => goToAgent(entry, handlers) };
};
const press = (attr, id) => {
  const row = elements.find((element) => element.props && element.props[attr] === id && typeof element.props.onClick === 'function');
  assert.ok(row, `a row ${attr}=${id}`);
  row.props.onClick();
};

test('a Build row in Agents reveals its card (workspace and task id), not just its workspace', () => {
  const { calls, go } = routes();
  render({ onGo: go });
  press('data-agent-entry', 'build:w2');
  assert.deepEqual(calls, [['reveal', { workspaceId: 'sb', buildId: 'w2' }]]);
});

test('a cleared Build (task.version) still opens its archived version', () => {
  const { calls, go } = routes();
  const archived = { id: 'build:d3', kind: 'build', title: 'Done d3', workspaceId: 'sb', state: 'Accepted', at: at(1), task: { id: 'd3', status: 'accepted', workspaceId: 'sb', version: { file: 'v1.md', title: 'Sidebar, Oct 12' } } };
  render({ onGo: go, groups: { ...groups, done: [archived] } });
  press('data-agent-entry', 'build:d3');
  assert.deepEqual(calls, [['version', { workspaceId: 'sb', file: 'v1.md', title: 'Sidebar, Oct 12' }]]);
});

test('a running Bart row still opens its workspace', () => {
  const { calls, go } = routes();
  render({ onGo: go });
  press('data-agent-entry', 'agent:q1');
  assert.deepEqual(calls, [['select', 'sb']]);
});

test('a quick task with no workspace goes nowhere', () => {
  const { calls, go } = routes();
  go({ id: 'build:q2', kind: 'quick', title: 'Quick', workspaceId: null, task: { id: 'q2', status: 'review' } });
  assert.deepEqual(calls, []);
});

test('a Build in the Inbox reveals its card by its id; another agent there opens its workspace', () => {
  const { calls, go } = routes();
  const entries = [
    { id: 'b7', kind: 'build', workspaceId: 'sb', name: 'Sidebar', did: 'A Build finished', at: at(1) },
    { id: 'a1', kind: 'bart', workspaceId: 'ag', name: 'Agents', did: 'Bart answered', at: at(2) },
  ];
  elements.length = 0;
  const previous = { window: global.window, document: global.document };
  global.window = { engelbartAPI: {}, innerHeight: 900, innerWidth: 1440 };
  global.document = { body: {} };
  try {
    renderToStaticMarkup(React.createElement(InboxPanel, { anchor: { left: 0, right: 300, top: 40, bottom: 72, width: 280 }, entries, nameOf: () => 'Sidebar', onGo: go, onClear: () => {}, onClose: () => {}, ignore: null }));
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete global[key]; else global[key] = value; } }
  press('data-inbox-entry', 'b7');
  press('data-inbox-entry', 'a1');
  assert.deepEqual(calls, [['reveal', { workspaceId: 'sb', buildId: 'b7' }], ['select', 'ag']]);
});

test('the workspace hands a Build\'s reveal to revealAsk, as a workspace place with its build id', () => {
  const src = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(src, /onRevealBuild=\{\(\{ workspaceId, buildId \}\) => revealAsk\(\{ place: \{ projectId: project\.id, ref: \{ kind: 'workspace', workspaceId \} \}, buildId \}\)\}/);
});
