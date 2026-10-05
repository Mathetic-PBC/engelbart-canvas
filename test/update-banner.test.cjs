'use strict';

// The update banner (MATH-43, 2026-10-05; src/renderer/ui/UpdateBanner.jsx): the download's percentage while the install
// command runs, Restart to Update and Later once the new version is ready, and nothing otherwise.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const filename = path.join(__dirname, '__update-banner.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/ui/UpdateBanner.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'] });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { UpdateNotice } = compiled.exports;

const at = (update) => renderToStaticMarkup(React.createElement(UpdateNotice, { update: { enabled: true, available: '0.2.0', version: '0.2.0', percent: null, dismissed: false, ...update }, onRestart: () => {}, onLater: () => {} }));

test('update banner: the download as it goes, then Restart to Update and Later; nothing otherwise', () => {
  const waiting = at({ state: 'installing' });
  assert.match(waiting, /data-overlay="1"[^>]*data-update-banner="installing"/);
  assert.match(waiting, />Downloading Engelbart 0\.2\.0…</);
  assert.match(waiting, /data-update-progress="waiting"[^>]*animation:update-slide/, 'indeterminate until curl gives a percentage');
  assert.doesNotMatch(waiting, /<button/);

  const going = at({ state: 'installing', percent: 42 });
  assert.match(going, />Downloading Engelbart 0\.2\.0… 42%</);
  assert.match(going, /data-update-progress="42"[^>]*width:42%/);

  const ready = at({ state: 'ready' });
  assert.match(ready, /data-update-banner="ready"/);
  assert.match(ready, />Engelbart 0\.2\.0 is ready\.</);
  assert.match(ready, /data-update-restart="1"[^>]*>Restart to Update</);
  assert.match(ready, /data-update-later="1"[^>]*>Later</);

  assert.equal(at({ state: 'ready', dismissed: true }), '', 'Later: hidden until the state changes');
  for (const state of ['idle', 'checking']) assert.equal(at({ state }), '', state);
  assert.equal(at({ enabled: false, state: 'installing' }), '', 'no updates in this copy');
});
