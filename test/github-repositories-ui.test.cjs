'use strict';
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
for (const name of ['jsx', 'jsxs']) recording[name] = (...args) => {
  const element = runtime[name](...args); elements.push(element); return element;
};
let account = { connected: true, login: 'researcher' };
const filename = path.join(__dirname, '__github-repositories-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/GithubRepositories.jsx')], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', './useGithubStatus.js'] });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) {
  if (id === './useGithubStatus.js') return { useGithubStatus: () => [account] };
  return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id);
};
const previous = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previous === undefined) delete global.window; else global.window = previous; }
const { default: GithubRepositories, GithubRepositoryResults } = compiled.exports;
const repos = [
  { id: '1', fullName: 'Mathetic-PBC/engelbart-canvas', owner: 'Mathetic-PBC', private: true, description: 'Desktop workspace', url: 'https://github.com/Mathetic-PBC/engelbart-canvas' },
  { id: '2', fullName: 'researcher/research-notes', owner: 'researcher', private: false, description: 'Collected reading', url: 'https://github.com/researcher/research-notes' },
];
const results = (query = '', onOpen = () => {}, list = repos) => {
  elements.length = 0;
  return renderToStaticMarkup(React.createElement(GithubRepositoryResults, { repos: list, query, onOpen }));
};

test('catalog has loading and disconnected states without another nested heading', () => {
  account = { connected: true, login: 'researcher' };
  const html = renderToStaticMarkup(React.createElement(GithubRepositories, {}));
  assert.match(html, /Loading repositories/);
  assert.match(html, /data-github-repository-section/);
  assert.doesNotMatch(html, /My repositories|aria-expanded|aria-haspopup/);
  account = { connected: false };
  assert.match(renderToStaticMarkup(React.createElement(GithubRepositories, {})), /Connect GitHub in Connections/);
});

test('repository names lead, owners are secondary, and private repositories remain identified', () => {
  const html = results();
  const name = elements.find(element => element.props['data-github-repo-name']);
  const owner = elements.find(element => element.props['data-github-repo-owner']);
  assert.equal(name.props.children, 'engelbart-canvas');
  assert.equal(owner.props.children, 'Mathetic-PBC');
  assert.equal(owner.props.style.color, '#8f8f8f');
  assert.ok(html.indexOf('data-github-repo-name') < html.indexOf('data-github-repo-owner'));
  assert.equal((html.match(/aria-label="Private repository"/g) || []).length, 1);
});

test('repository search matches names, owners and descriptions, with clear empty states', () => {
  assert.match(results('MATHEtic desktop'), /data-github-account-repo="Mathetic-PBC\/engelbart-canvas"/);
  assert.doesNotMatch(results('MATHEtic desktop'), /data-github-account-repo="researcher/);
  assert.match(results('reading'), /data-github-account-repo="researcher\/research-notes"/);
  assert.match(results('missing'), /No matching repositories/);
  assert.match(results('', () => {}, []), /No repositories shared with Engelbart yet/);
});

test('selecting a result passes the original repository to the existing Stage handler', () => {
  const opened = [];
  results('', repo => opened.push(repo));
  elements.find(element => element.props['data-github-account-repo'] === repos[0].fullName).props.onClick();
  assert.deepEqual(opened, [repos[0]]);
});
