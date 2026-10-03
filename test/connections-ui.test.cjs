'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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
const filename = path.join(__dirname, '__connections-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/Connections.jsx')], bundle: true,
  platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'] });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recording : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
const bridge = {};
global.window = { engelbartAPI: bridge };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { default: Connections, GithubConnection, githubAction } = compiled.exports;
const signedOut = { configured: true, connected: false, pending: null, error: '', installUrl: '' };
const render = (status, extra = {}) => {
  elements.length = 0;
  return renderToStaticMarkup(React.createElement(GithubConnection, { status, ...extra }));
};
const action = name => elements.find(element => element.props['data-connection-action'] === name);

test('GitHub offers an explicit Connect action', () => {
  const actions = [];
  const html = render(signedOut, { onAction: name => actions.push(name) });
  assert.match(html, /GitHub/);
  assert.match(html, /Not connected/);
  assert.doesNotMatch(html, /Overleaf|Google|Zotero|repository|Sign in with/);
  assert.deepEqual(actions, [], 'rendering does not start authentication');
  action('connect').props.onClick();
  assert.deepEqual(actions, ['connect']);
});

test('connected account exposes its actions through a closed options menu', () => {
  const actions = [];
  const html = render({ ...signedOut, connected: true, login: 'researcher', persisted: true, installUrl: 'https://github.com/apps/example/installations/new' }, { onAction: name => actions.push(name) });
  assert.match(html, /Connected · @researcher/);
  assert.equal(action('connect'), undefined);
  assert.doesNotMatch(html, /Manage access|Repository access|Disconnect/);
  const options = elements.find(element => element.props['data-github-actions']);
  assert.equal(options.props['aria-haspopup'], 'menu');
  assert.equal(options.props['aria-expanded'], false);
  assert.equal(options.props.disabled, false);
  assert.deepEqual(actions, [], 'rendering the connected account performs no action');
});

test('connection options center the dots as an icon, independent of font metrics', () => {
  render({ ...signedOut, connected: true, login: 'researcher', persisted: true });
  const options = elements.find(element => element.props['data-github-actions']);
  assert.equal(options.props.style.alignItems, 'center');
  assert.equal(options.props.style.justifyContent, 'center');
  assert.equal(options.props.style.width, 28);
  assert.equal(options.props.style.height, 28);
  const icon = options.props.children;
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props['aria-hidden'], 'true');
  assert.equal(icon.props.viewBox, '0 0 16 16');
  assert.deepEqual(icon.props.children.map(dot => [dot.props.cx, dot.props.cy]), [['3', '8'], ['8', '8'], ['13', '8']]);
});

test('pending browser sign-in can be cancelled or reopened', () => {
  const actions = [];
  const html = render({ ...signedOut, pending: { kind: 'browser' } }, { onAction: name => actions.push(name) });
  assert.match(html, /Connecting…/);
  assert.doesNotMatch(html, /Waiting for sign-in|Finish signing in in Stage/);
  assert.equal(action('reopen').props['aria-label'], 'Open GitHub sign-in in your browser');
  assert.doesNotMatch(html, /Stage|Open browser again/);
  assert.doesNotMatch(html, /Copy code/);
  assert.equal(action('connect'), undefined);
  action('cancel').props.onClick(); action('reopen').props.onClick();
  assert.deepEqual(actions, ['cancel', 'reopen']);
});

test('legacy device authorization retains its code and copy action', () => {
  const actions = [];
  const html = render({ ...signedOut, pending: { kind: 'device', userCode: 'ABCD-EFGH' } }, { onAction: name => actions.push(name) });
  assert.match(html, /ABCD-EFGH/);
  action('copy').props.onClick();
  assert.deepEqual(actions, ['copy']);
});

test('auth errors remain visible and allow reconnecting', () => {
  const html = render({ ...signedOut, error: 'Your GitHub sign-in expired.' });
  assert.match(html, /role="alert"/);
  assert.match(html, /Your GitHub sign-in expired/);
  assert.equal(action('connect').props.children, 'Reconnect');
  assert.match(render(signedOut, { error: 'Could not open your browser.' }), /Could not open your browser/);
});

test('loading, unavailable configuration and busy states cannot start duplicate actions', () => {
  assert.match(render(null), /Checking connection/);
  assert.equal(action('connect').props.disabled, true);
  assert.match(render({ ...signedOut, configured: false }), /Not configured/);
  assert.equal(action('connect').props.disabled, true);
  assert.match(render(signedOut, { busy: 'connect' }), /Connecting…/);
  assert.equal(action('connect').props.disabled, true);
  render({ ...signedOut, connected: true, installUrl: 'https://github.com/apps/example/installations/new' }, { busy: 'disconnect' });
  assert.equal(elements.find(element => element.props['data-github-actions']).props.disabled, true);
});

test('a non-persisted connection does not imply it will survive quitting', () => {
  assert.match(render({ ...signedOut, connected: true, persisted: false }), /Connected until Engelbart quits/);
  assert.equal(action('manage'), undefined, 'no broken access action without its URL');
});

test('every GitHub page in Connections opens through github-open, in the default browser', async () => {
  const calls = [];
  Object.assign(bridge, {
    githubOpen: async (which) => { calls.push(['githubOpen', which]); return true; },
    githubConnect: async () => { calls.push(['githubConnect']); return { ...signedOut, pending: { kind: 'browser' } }; },
    githubCancel: async () => { calls.push(['githubCancel']); return signedOut; },
    githubDisconnect: async () => { calls.push(['githubDisconnect']); return signedOut; },
    copyText: async (value) => { calls.push(['copyText', value]); return true; },
  });
  try {
    assert.equal(await githubAction('manage', signedOut), null);
    assert.equal(await githubAction('reopen', signedOut), null);
    assert.deepEqual(calls, [['githubOpen', 'install'], ['githubOpen', 'device']], 'Repository access and the sign-in page: the default browser');
    calls.length = 0;
    assert.equal((await githubAction('connect', signedOut)).pending.kind, 'browser');
    await githubAction('cancel', signedOut);
    await githubAction('disconnect', signedOut);
    await githubAction('copy', { ...signedOut, pending: { kind: 'device', userCode: 'ABCD-EFGH' } });
    assert.deepEqual(calls, [['githubConnect'], ['githubCancel'], ['githubDisconnect'], ['copyText', 'ABCD-EFGH']]);
  } finally {
    for (const key of Object.keys(bridge)) delete bridge[key];
  }
});

test('the connected options are Repository access and Disconnect, and no Refresh that nothing would show', () => {
  render({ ...signedOut, connected: true, login: 'researcher', installUrl: 'https://github.com/apps/example/installations/new' }, { onAction: () => {} });
  const menu = elements.find(element => element.props.provider === 'github');
  assert.deepEqual(menu.props.items.map(item => item.action), ['manage', 'disconnect']);
  render({ ...signedOut, connected: true, login: 'researcher' }, { onAction: () => {} });
  assert.deepEqual(elements.find(element => element.props.provider === 'github').props.items.map(item => item.action), ['disconnect']);
});

test('Connections is an icon in the top-right controls, left of the notification bell, and not in the sidebar', () => {
  elements.length = 0;
  const html = renderToStaticMarkup(React.createElement(Connections));
  const trigger = elements.find(element => element.type === 'button');
  assert.equal(trigger.props['aria-label'], 'Connections');
  assert.equal(trigger.props.title, 'Connections');
  assert.equal(trigger.props['aria-haspopup'], 'dialog');
  assert.equal(trigger.props['aria-expanded'], false);
  assert.equal(trigger.props.style.width, 32, 'the bell\'s size');
  assert.equal(trigger.props.style.height, 32);
  assert.doesNotMatch(html, />Connections</, 'an icon, no label beside it');
  assert.doesNotMatch(html, /data-connections-panel/, 'closed until clicked');
  const controls = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/WindowControls.jsx'), 'utf8');
  assert.match(controls, /<Connections \/>\s*<SandboxNotifications \/>/);
  const rail = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Rail.jsx'), 'utf8');
  assert.doesNotMatch(rail, /Connections/);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Connections.jsx'), 'utf8');
  assert.match(source, /usePlaced\(anchor, \{ gap: 6, align: 'end'/, 'the panel hangs from the icon\'s right edge, inside the window');
});
