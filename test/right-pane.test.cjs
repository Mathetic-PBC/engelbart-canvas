'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

// Exercise the real pane switcher with inert children, not a real browser, terminal or sandbox.
const panes = { './Browser.jsx': 'browser', './RepoPane.jsx': 'repo', '../pdf/PaperView.jsx': 'paper', '../terminal/TerminalPane.jsx': 'terminal' };
const calls = [];
const stubs = Object.fromEntries(Object.entries(panes).map(([id, name]) => [id, (props) => {
  calls.push({ name, props });
  return React.createElement('div', { 'data-pane': name });
}]));
const filename = path.join(__dirname, '__right-pane-unit.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/RightPane.jsx')], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', ...Object.keys(panes)] });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return stubs[id] || Module.prototype.require.call(this, id); };
compiled._compile(built.outputFiles[0].text, filename);
const { default: RightPane, RIGHT_MODES } = compiled.exports;

test('top-level tabs are unchanged and Repo is mounted only for its own tab', () => {
  assert.deepEqual(RIGHT_MODES, [{ id: 'preview', label: 'Browser' }, { id: 'terminal', label: 'Terminal' }, { id: 'paper', label: 'Paper' }, { id: 'repo', label: 'Repo' }]);
  for (const { id: mode } of RIGHT_MODES) {
    calls.length = 0;
    renderToStaticMarkup(React.createElement(RightPane, { mode, repositories: [], repoId: 'repo',
      paper: { id: 'paper', name: 'Paper', bytes: new Uint8Array() }, projectId: 'project', projectDir: '/project' }));
    assert.equal(calls.some((call) => call.name === 'repo'), mode === 'repo');
    assert.equal(calls.some((call) => call.name === 'paper'), mode === 'paper');
    assert.equal(calls.find((call) => call.name === 'browser').props.visible, mode === 'preview');
    assert.equal(calls.find((call) => call.name === 'terminal').props.visible, mode === 'terminal');
  }
});
