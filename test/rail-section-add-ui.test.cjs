'use strict';

// A + in each sidebar section's header (MATH-44, 2026-10-06; src/renderer/workspace/Rail.jsx): Notes, Websites, GitHub,
// Files and Sub-Workspaces have one, Archived none; a click never reaches the section's fold, and the ones that add at
// once call their handler. "+ Add context" keeps the button scripts/smoke-github-signin.cjs presses.

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
const filename = path.join(__dirname, '__rail-section-add-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/Rail.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const Rail = compiled.exports.default;

function render(more = {}) {
  const calls = [];
  const note = (name) => async () => { calls.push(name); return name === 'disk' ? [] : undefined; };
  const props = {
    width: 300, topics: [], topic: { id: 'w1', name: 'Reading' }, allWorkspaces: [], rows: [], library: [], inRail: () => false,
    onNewNote: note('note'), onNewChild: note('workspace'), onPickDisk: note('disk'), onAddInput: note('link'), onPickRepo: note('github'),
    onSearchPick: () => {}, onRowClick: () => {}, onTrashRow: () => {},
    ...more,
  };
  elements.length = 0;
  const previous = global.window;
  global.window = { engelbartAPI: {}, innerHeight: 800, innerWidth: 1200 };
  try { return { html: renderToStaticMarkup(React.createElement(Rail, props)), calls }; } finally { global.window = previous; }
}

const pluses = () => elements.filter((element) => element.props && element.props['data-rail-section-add']);
const press = (element) => {
  let stopped = false;
  const header = { getBoundingClientRect: () => ({ left: 8, right: 292, top: 280, bottom: 310, width: 284 }) };
  element.props.onClick({ stopPropagation: () => { stopped = true; }, currentTarget: { parentElement: header } });
  return stopped;
};

test('every section but Archived has a + in its header, named for its section (MATH-44)', () => {
  const { html } = render();
  assert.deepEqual(pluses().map((element) => [element.props['data-rail-section-add'], element.props['aria-label']]), [['Notes', 'Add to Notes'], ['Websites', 'Add to Websites'], ['GitHub', 'Add to GitHub'], ['Files', 'Add to Files'], ['Workspaces', 'Add to Sub-Workspaces']]);
  assert.ok(!/data-rail-section-add="Archived"/.test(html));
  assert.match(html, /data-rail-add="1"[^>]*><button[^>]*aria-label="Add context"/, '"+ Add context" keeps its button, first in [data-rail-add]');
});

test('a section\'s + stops its click; Notes, Sub-Workspaces and Files add at once; Websites and GitHub only open a panel (MATH-44)', async () => {
  for (const [key, expected] of [['Notes', ['note']], ['Workspaces', ['workspace']], ['Files', ['disk']], ['Websites', []], ['GitHub', []]]) {
    const { calls } = render();
    const plus = pluses().find((element) => element.props['data-rail-section-add'] === key);
    assert.equal(press(plus), true, `${key}: the click stops at the +, so the section never folds`);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, expected, key);
  }
});

test('a section whose handler is missing has no + (MATH-44)', () => {
  render({ onPickRepo: undefined, onNewChild: undefined });
  assert.deepEqual(pluses().map((element) => element.props['data-rail-section-add']), ['Notes', 'Websites', 'Files']);
});

test('at rest the sidebar shows only the section names: a + shows on its header\'s hover, and there is no Expand all (2026-10-06)', () => {
  const { html } = render();
  assert.equal(pluses().length, 5);
  assert.ok(pluses().every((element) => /\brail-add\b/.test(element.props.className)), 'every + hides until its header is hovered');
  assert.doesNotMatch(html, /data-rail-fold-all|Expand all|Collapse all/, 'Option-click on a section does that');
  assert.match(html, /class="rail-section-head"/);
  const css = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  assert.match(css, /\.rail-add\{opacity:0;/);
  assert.match(css, /\.rail-section-head:hover \.rail-add,\.rail-add:focus-visible,\.rail-add\[aria-expanded="true"\]\{opacity:1\}/, 'shown on hover, with the keyboard, and while its panel is open');
});

test('an Option-click on a section folds or opens them all, as Finder does (2026-10-06)', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '../src/renderer/workspace/Rail.jsx'), 'utf8');
  assert.match(source, /onToggle=\{\(event\) => setOpened\(\(now\) => \(event && event\.altKey \? \(now\[section\.key\] \? \{\} : everyOpen\(\)\) : \{ \.\.\.now, \[section\.key\]: !now\[section\.key\] \}\)\)\}/);
});
