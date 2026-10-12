'use strict';

// A GitHub repository's row in the picker (src/renderer/workspace/GithubRepos.jsx RepoRow, 2026-10-12): a box on the right
// of every row, empty until picked, and a private repository's lock right after its name.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const filename = path.join(__dirname, '__github-repo-row.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/GithubRepos.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl', '.woff2': 'empty', '.woff': 'empty' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { RepoRow } = compiled.exports;

const row = (props) => renderToStaticMarkup(React.createElement(RepoRow, { busy: false, onToggle() {}, ...props }));
const repo = { id: 1, owner: 'mathetic', fullName: 'mathetic/engelbart', private: true, description: '' };

test('every repository row has a box on the right: empty until picked, ticked once picked', () => {
  const off = row({ repo, on: false });
  assert.match(off, /role="checkbox" aria-checked="false"/);
  assert.match(off, /data-github-repo-box="off" style="[^"]*border-radius:4px;background:#fff;border:1.5px solid #c9c9c9[^"]*"><\/span><\/button>$/, 'an empty box, last in the row');
  const on = row({ repo, on: true });
  assert.match(on, /aria-checked="true"/);
  assert.match(on, /data-github-repo-box="on" style="[^"]*background:#171717[^"]*">✓<\/span><\/button>$/);
  assert.match(row({ repo: { ...repo, private: false }, on: false }), /data-github-repo-box="off"/, 'a public one too');
});

test('a private repository\'s lock sits right after its name, not by the box', () => {
  const html = row({ repo, on: false });
  assert.match(html, /<span style="flex:1;min-width:0;display:flex;align-items:center;gap:6px"><span [^>]*><span [^>]*>mathetic\/<\/span><span [^>]*>engelbart<\/span><\/span><span aria-label="private" data-github-repo-lock="1"/, 'the lock beside the name, inside the name\'s part of the row');
  assert.ok(html.indexOf('data-github-repo-lock') < html.indexOf('data-github-repo-box'));
  assert.doesNotMatch(row({ repo: { ...repo, private: false }, on: false }), /data-github-repo-lock/);
});
