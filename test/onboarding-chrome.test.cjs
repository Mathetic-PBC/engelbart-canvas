'use strict';

// Onboarding's follow-ups to build 1 (2026-10-07) on screens beyond its own: the workspace title, a field that wraps so
// the question onboarding names the first workspace with shows in full (src/renderer/workspace/DocPane.jsx), and the
// top-right controls without the bell and the gear while onboarding is up (src/renderer/ui/WindowControls.jsx, App.jsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-onboarding-chrome-unit.cjs`);
  const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs',
    jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/server'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' } });
  const compiled = new Module(filename, module); compiled.paths = module.paths;
  const previous = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(built.outputFiles[0].text, filename); }
  finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return compiled.exports;
}

const QUESTION = 'How does what students do in the minutes before they ask an AI tutor for help relate to what they learn from its answer?';

test('the title wraps: a field of many lines that grows with its text, never one line cut off or scrolled sideways', () => {
  const { default: DocPane } = load('workspace/DocPane.jsx');
  const html = renderToStaticMarkup(React.createElement(DocPane, { index: 0, docKey: 'k', text: '', title: QUESTION, onRename: () => {}, editor: null }));
  const field = html.match(/<(\w+)[^>]*data-doc-title="1"[^>]*>/);
  assert.ok(field, 'the title is there');
  assert.equal(field[1], 'textarea', 'a textarea, which wraps; not an input, which scrolls sideways');
  assert.match(field[0], /field-sizing:content/, 'as tall as its text');
  assert.match(field[0], /overflow:hidden/, 'no scrollbar');
  assert.match(field[0], /resize:none/);
  assert.match(field[0], /overflow-wrap:anywhere/, 'a long word wraps too');
  assert.ok(html.includes(`>${QUESTION}</textarea>`), 'the whole question, not cut');
});

test('the title keeps how it behaves: Enter names it and drops the caret in, Escape leaves it, slashes become hyphens', async () => {
  const { titleKeyDown } = load('workspace/DocPane.jsx');
  const { titleTyped } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/names.js')).href);
  const press = (key, extra = {}) => {
    const did = [];
    const event = { key, ...extra, preventDefault: () => did.push('prevent'), target: { blur: () => did.push('blur') } };
    titleKeyDown(event, { current: { focusStart: () => did.push('into the document') } });
    return did;
  };
  assert.deepEqual(press('Enter'), ['prevent', 'blur', 'into the document']);
  assert.deepEqual(press('Enter', { shiftKey: true }), ['prevent', 'blur', 'into the document'], 'never a second line');
  assert.deepEqual(press('Escape'), ['prevent', 'blur'], 'Escape leaves it, and that is all');
  assert.deepEqual(press('a'), [], 'any other key types');
  assert.doesNotThrow(() => titleKeyDown({ key: 'Enter', preventDefault() {}, target: { blur() {} } }, null), 'no editor to drop into');
  assert.equal(titleTyped('Inputs/outputs\\ of AI tutors'), 'Inputs-outputs- of AI tutors');
  assert.equal(titleTyped('A pasted\ntitle\r\nof lines'), 'A pasted title of lines', 'a line break pasted in is a space');
});

test('no bell and no gear during onboarding; the test pill stays', () => {
  const { default: WindowControls } = load('ui/WindowControls.jsx');
  const pill = React.createElement('span', { 'data-test-pill': '1' }, 'Test · on');
  const html = renderToStaticMarkup(React.createElement(WindowControls, { onboarding: true, test: { testMode: true } }, pill));
  assert.ok(html.includes('data-test-pill="1"'), 'the pill stays');
  assert.ok(!/notification/i.test(html), 'no bell');
  assert.ok(!/settings/i.test(html), 'no gear');
  assert.equal(html.match(/<button/g), null, 'nothing else to press');
  const app = fs.readFileSync(path.join(__dirname, '../src/renderer/App.jsx'), 'utf8');
  assert.match(app, /<WindowControls onboarding=\{phase === 'create'\}/, 'onboarding (and + Project) is the create phase');
  assert.match(app, /phase === 'create' && \(\s*<Onboarding /);
});
