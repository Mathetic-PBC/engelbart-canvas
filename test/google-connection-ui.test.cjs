'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const runtime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const elements = [], recording = { ...runtime };
for (const name of ['jsx', 'jsxs']) recording[name] = (...args) => {
  const element = runtime[name](...args); elements.push(element); return element;
};
const filename = path.join(__dirname, '__google-connection-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/GoogleConnection.jsx')], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'] });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { GoogleConnectionRow } = compiled.exports;
const pending = { connected: false, pending: { kind: 'stage' }, loading: false, error: '' };
const render = (status, extra = {}) => {
  elements.length = 0;
  return renderToStaticMarkup(React.createElement(GoogleConnectionRow, { status, ...extra }));
};
const action = name => elements.find(element => element.props['data-google-action'] === name);

test('connecting Google keeps sign-in and cancellation in one row', () => {
  const actions = [];
  const html = render(pending, { onAction: name => actions.push(name) });
  assert.match(html, /Connecting…/);
  assert.doesNotMatch(html, /Waiting for Google/);
  assert.equal(action('reopen').props['aria-label'], 'Open Google Docs sign-in in Stage');
  assert.equal(action('reopen').props.disabled, false);
  action('reopen').props.onClick(); action('cancel').props.onClick();
  assert.deepEqual(actions, ['reopen', 'cancel']);
});

test('failed initial read offers Retry and does not claim it is still waiting for login', () => {
  const actions = [];
  const html = render({ ...pending, error: 'Google Drive took too long to load.' }, { onAction: name => actions.push(name) });
  assert.match(html, /Could not load recent Docs/);
  assert.doesNotMatch(html, /Waiting for Google|appear automatically/);
  assert.equal(action('retry').props.disabled, false);
  action('retry').props.onClick();
  assert.deepEqual(actions, ['retry']);
});

test('loading a retry remains cancellable and cannot start a second read', () => {
  const html = render({ ...pending, loading: true }, { busy: 'retry' });
  assert.match(html, /Connecting…/);
  assert.doesNotMatch(html, /Loading recent Docs|Waiting for Google/);
  assert.equal(action('cancel').props.disabled, false);
  assert.equal(action('reopen').props.disabled, true);
});
