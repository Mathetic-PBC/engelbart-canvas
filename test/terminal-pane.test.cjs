'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

// Render real terminal chrome with inert sessions; no shell or agent is launched.
const elements = [], sent = [];
let records = [];
const state = { sessions: new Map(), providers: new Map(), errors: [], bootstrapComplete: true };
const sessions = {
  getState: () => state, sessionsFor: () => records, subscribe: () => () => {},
  sendInput: (...args) => sent.push(args), selectionText: () => '',
};
const runtime = { ...jsxRuntime };
for (const name of ['jsx', 'jsxs']) runtime[name] = (...args) => { const element = jsxRuntime[name](...args); elements.push(element); return element; };
const filename = path.join(__dirname, '__terminal-pane.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/terminal/TerminalPane.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' }, external: ['react', './sessions.js', '../api.js'] });
const compiled = new Module(filename, module); compiled.paths = module.paths;
compiled.require = function (id) {
  if (id === './sessions.js') return sessions;
  if (id === '../api.js') return { api: {} };
  if (id === 'react/jsx-runtime') return runtime;
  if (id === 'react') return { ...React, useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() };
  return Module.prototype.require.call(this, id);
};
compiled._compile(built.outputFiles[0].text, filename);
const TerminalPane = compiled.exports.default;
function render(agent, { integrated = false, cwd, home = '', busy = agent !== 'shell', command = agent === 'shell' ? '' : agent } = {}) {
  elements.length = 0; sent.length = 0;
  state.home = home;
  records = [{ snapshot: { id: 'session', provider: integrated ? 'shell' : agent, cwd: '/project', status: 'running' }, shell: { integrated, busy, command, cwd } }];
  return renderToStaticMarkup(React.createElement(TerminalPane, { projectId: 'project', cwd: '/project' }));
}

test('Run commands uses a compact multiline field above a plain directory label', () => {
  const html = render('shell');
  const input = elements.find((e) => e.props['data-term-input']);
  assert.equal(input.type, 'textarea');
  assert.equal(input.props.rows, 1);
  assert.equal(input.props.className, 'terminal-command');
  assert.match(html, /placeholder="Run commands…"/);
  assert.equal(elements.find((e) => e.props['data-term-footer']).props.className, 'terminal-dock');
  assert.doesNotMatch(html, /data-agent-chip|terminal-agent|terminal-chip|terminal-directory|▭/);
  assert.ok(html.indexOf('data-term-path') > html.indexOf('data-term-input'), 'directory is inside the footer below the command field');
});

test('the path label abbreviates only the current home directory and keeps the full path on hover', () => {
  for (const [cwd, home, label] of [
    ['/Users/alex/Desktop/app', '/Users/alex', '~/Desktop/app'],
    ['/Users/alex', '/Users/alex/', '~'],
    ['/Users/alex-other/app', '/Users/alex', '/Users/alex-other/app'],
    ['/opt/app', '/Users/alex', '/opt/app'],
    ['/Users/alex/Desktop/app', '', '/Users/alex/Desktop/app'],
    ['C:\\Users\\alex\\app', 'C:\\Users\\alex', '~\\app'],
  ]) {
    render('shell', { integrated: true, cwd, home });
    const pathLabel = elements.find((e) => e.props['data-term-path']);
    assert.equal(pathLabel.props.children, label);
    assert.equal(pathLabel.props.title, cwd);
  }
});

test('Enter still runs a command; Shift+Enter stays in the native textarea', () => {
  render('shell', { integrated: true });
  const input = elements.find((e) => e.props['data-term-input']);
  let prevented = 0;
  const event = { key: 'Enter', shiftKey: true, preventDefault: () => prevented++, currentTarget: {} };
  input.props.onKeyDown(event);
  assert.equal(prevented, 0); assert.deepEqual(sent, []);
  input.props.onKeyDown({ ...event, shiftKey: false });
  assert.equal(prevented, 1); assert.deepEqual(sent, [['session', '\r']]);
});

test('Codex and Claude keep their own composer and status without the shell footer', () => {
  for (const agent of ['codex', 'claude']) {
    for (const integrated of [false, true]) {
      const html = render(agent, { integrated });
      assert.equal(elements.find((e) => e.props['data-terminal']).props['data-agent'], agent);
      assert.doesNotMatch(html, /data-term-input|data-term-footer|data-term-path/);
    }
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/terminal/sessions.js'), 'utf8');
  assert.doesNotMatch(source, /--terminal-bottom-space/);
});

test('the plain terminal footer follows its reported working directory, including during commands', () => {
  render('shell');
  assert.equal(elements.find((e) => e.props['data-term-path']).props.children, '/project');
  for (const busy of [false, true]) {
    render('shell', { integrated: true, cwd: '/project/nested directory', busy, command: busy ? 'npm test' : '' });
    const footer = elements.find((e) => e.props['data-term-path']);
    assert.equal(footer.props.children, '/project/nested directory');
    assert.equal(footer.props.title, '/project/nested directory');
    assert.equal(footer.props.className, 'terminal-path');
  }
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/terminal/terminal.css'), 'utf8');
  assert.match(css, /\.terminal-dock\{[^}]*background:var\(--panel2, #fafafa\)/);
  assert.match(css, /\.terminal-path\{[^}]*text-overflow:ellipsis/);
});

test('the restored footer pads a compact input without changing native agent spacing', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/terminal/terminal.css'), 'utf8');
  assert.match(css, /\.terminal-dock\{[^}]*gap:10px;[^}]*padding:10px var\(--terminal-inset\) 12px/);
  assert.match(css, /\.terminal-command\{[^}]*height:26px;min-height:26px/);
  assert.match(css, /\.terminal-command\{[^}]*max-height:180px;resize:none/);
  assert.match(css, /\.terminal-command\{[^}]*padding:2px 0/);
  assert.match(css, /\.terminal-hint\{[^}]*height:26px/);
  assert.match(css, /\.terminal-pane\[data-agent="codex"\] \.terminal-stage\{margin-bottom:20px\}/);
  assert.match(css, /\.terminal-view\{[^}]*inset:10px 0 0 var\(--terminal-inset\)/);
});
