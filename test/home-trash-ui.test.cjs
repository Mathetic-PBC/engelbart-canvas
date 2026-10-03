'use strict';

// The all-projects screen's Delete and Recently deleted (2026-10-03; src/renderer/screens/Home.jsx): a card's can asks
// before anything goes and never opens the card; what is in the trash is listed under the cards, with Restore.

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
const filename = path.join(__dirname, '__home-trash-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/screens/Home.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const Home = compiled.exports.default;

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const DAY = 24 * 60 * 60 * 1000;

test('Home: each card has a Delete that never opens the card; Recently deleted lists the trash with when it goes and Restore (2026-10-03)', () => {
  const opened = [];
  const deleted = Date.now() - 2 * DAY;
  const props = {
    projects: [{ id: P1, name: 'Thesis', workspaceCount: 0, lastEdited: null, recent: [], libraryIds: [] }],
    trashed: [{ id: P2, name: 'Old <Draft>', deleted: new Date(deleted).toISOString(), expires: new Date(deleted + 7 * DAY).toISOString(), workspaceCount: 3 }],
    library: [],
    onOpenWorkspace: (...args) => opened.push(args),
    onDelete: () => {},
    onRestore: () => {},
  };
  elements.length = 0;
  const html = renderToStaticMarkup(React.createElement(Home, props));
  assert.match(html, new RegExp(`data-delete-project="${P1}"[^>]*aria-label="Delete Thesis"`));
  assert.match(html, /data-recently-deleted="1"[\s\S]*Recently deleted/);
  assert.match(html, new RegExp(`data-trashed-project="${P2}"[\\s\\S]*Old &lt;Draft&gt;[\\s\\S]*deleted 2 days ago · gone ${new Date(deleted + 7 * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}[\\s\\S]*data-restore-project="${P2}"[^>]*>Restore<`));
  assert.ok(!html.includes('data-delete-project-dialog'), 'nothing asks before the can is pressed');

  const can = elements.find((element) => element.props && element.props['data-delete-project'] === P1);
  let stopped = false;
  try { can.props.onClick({ stopPropagation: () => { stopped = true; } }); } catch { /* the state it sets belongs to a render that is over */ }
  assert.ok(stopped, 'the click stops at the can');
  assert.deepEqual(opened, []);

  // Nothing in the trash: no Recently deleted.
  assert.ok(!renderToStaticMarkup(React.createElement(Home, { ...props, trashed: [] })).includes('Recently deleted'));
});
