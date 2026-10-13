'use strict';

// The sidebar's Agents panel (src/renderer/workspace/SidebarPanels.jsx, 2026-10-13): a Build waiting on you offers Reject
// on its row's hover, which hands the bare build id on (the workspace asks to confirm, as the card does); a press on the
// row still goes to its workspace. Running and Done rows offer nothing.

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
const { AgentsPanel } = compiled.exports;

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
