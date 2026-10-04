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
const { createTools } = require('../src/main/tools/manager.cjs');
const { createFakeTools } = require('../src/main/tools/fake.cjs');

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
const { default: Connections, GithubConnection, githubAction, ToolConnection, toolAction, watchTools, TOOL_CONNECTIONS } = compiled.exports;
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

// Claude Code and Codex (2026-10-03): rows drawn from the snapshots the tools manager sends, over a pretend machine
// (ENGELBART_TOOLS_FAKE's, src/main/tools/fake.cjs).
async function machine(spec, { delayMs = 0 } = {}) {
  const fake = createFakeTools(spec, { delayMs, sleep: async () => {} });
  let pretend = {};
  const seen = [];
  const tools = createTools({ readTools: () => pretend, writeTools: (value) => { pretend = value; return null; }, detect: fake.detect, actions: fake.actions,
    signInProcess: fake.signInProcess, signOutProcess: fake.signOutProcess, onChange: (snapshot) => seen.push(snapshot) });
  await tools.check();
  return { tools, seen };
}
const renderTool = (id, tool, extra = {}) => {
  elements.length = 0;
  return renderToStaticMarkup(React.createElement(ToolConnection, { id, tool, onAction: () => {}, ...extra }));
};

test('Claude Code and Codex: Connected · the account, the version in the tooltip, and Sign out behind the options menu', async () => {
  const { tools } = await machine({ claude: '2.1.300', codex: '0.155.1' });
  const actions = [];
  const html = renderTool('claude', tools.snapshot().tools.claude, { onAction: name => actions.push(name) });
  assert.match(html, /Claude Code/);
  assert.match(html, /role="status"[^>]*><span[^>]*>Connected · researcher@example\.com<\/span>/, 'like GitHub\'s row, without the @');
  assert.doesNotMatch(html, /Signed in|role="status"[^>]*>[^<]*<span[^>]*>[^<]*2\.1\.300/, 'no version on the status line');
  assert.match(html, /title="Claude Code 2\.1\.300"/, 'the version is the row\'s tooltip');
  assert.doesNotMatch(html, /Sign out|role="alert"/, 'the menu is closed');
  const menu = elements.find(element => element.props.provider === 'claude');
  assert.equal(menu.props.label, 'Claude Code');
  assert.deepEqual(menu.props.items, [{ action: 'sign-out', label: 'Sign out' }]);
  assert.equal(elements.find(element => element.props['data-claude-actions']).props.disabled, false);
  assert.equal(action('sign-in'), undefined);
  menu.props.onAction('sign-out');
  assert.deepEqual(actions, ['sign-out']);
  const codex = renderTool('codex', tools.snapshot().tools.codex);
  assert.match(codex, /Codex[\s\S]*Connected · researcher@example\.com/);
  assert.match(codex, /title="Codex 0\.155\.1"/);
  assert.match(renderTool('claude', tools.snapshot().tools.claude, { busy: 'sign-out' }), /Signing out…/);
  assert.equal(elements.find(element => element.props['data-claude-actions']).props.disabled, true, 'no second action while one runs');
});

test('signed in as nobody the CLI names: plain Connected, the version still in the tooltip', async () => {
  const { tools } = await machine({ claude: '2.1.300', codex: '0.155.1' });
  const claude = renderTool('claude', { ...tools.snapshot().tools.claude, account: null });
  assert.match(claude, /role="status"[^>]*><span[^>]*>Connected<\/span>/);
  assert.doesNotMatch(claude, /Connected ·|Signed in/);
  assert.match(claude, /title="Claude Code 2\.1\.300"/);
  assert.match(renderTool('codex', { ...tools.snapshot().tools.codex, account: null }), /role="status"[^>]*><span[^>]*>Connected<\/span>/);
  const checking = renderTool('claude', { ...tools.snapshot().tools.claude, busy: { action: 'check' } });
  assert.match(checking, /Connected · researcher@example\.com/, 'a check before an @bart turn leaves the line as it is');
  const signedOut = renderTool('claude', { ...tools.snapshot().tools.claude, status: 'signed-out', signedIn: false, account: null });
  assert.match(signedOut, /Not signed in/);
  assert.doesNotMatch(signedOut, /Connected|title="/, 'no account, and no tooltip, once signed out');
});

test('signed out: Sign in; a Codex API-key sign-in counts as signed out and says why in red', async () => {
  const { tools } = await machine({ claude: '2.1.300 signed-out' });
  const actions = [];
  const html = renderTool('claude', tools.snapshot().tools.claude, { onAction: name => actions.push(name) });
  assert.match(html, /Not signed in/);
  assert.equal(action('sign-in').props.children, 'Sign in');
  assert.equal(action('sign-in').props.disabled, false);
  assert.equal(elements.find(element => element.props.provider === 'claude'), undefined, 'no Sign out while signed out');
  action('sign-in').props.onClick();
  assert.deepEqual(actions, ['sign-in']);
  const apiKey = { ...tools.snapshot().tools.codex, status: 'signed-out', signedIn: false, error: 'Codex is signed in with an API key; Engelbart uses a ChatGPT sign-in (run `codex login`).' };
  const codex = renderTool('codex', apiKey);
  assert.match(codex, /Not signed in/);
  assert.match(codex, /role="alert"[^>]*>Codex is signed in with an API key/);
  assert.match(renderTool('claude', tools.snapshot().tools.claude, { error: 'Could not sign out of Claude Code: refused' }), /role="alert"[^>]*>Could not sign out of Claude Code: refused/, 'an action\'s own error');
});

test('signing in: finish in the browser, Cancel, and Reopen page once the CLI has printed one', async () => {
  const { tools, seen } = await machine({ codex: '0.155.1 signed-out' }, { delayMs: 60_000 });
  const signing = tools.signIn('codex');
  const actions = [];
  const before = renderTool('codex', tools.snapshot().tools.codex, { onAction: name => actions.push(name) });
  assert.match(before, /Finish signing in in your browser/);
  assert.equal(action('reopen'), undefined, 'no page yet');
  assert.equal(action('cancel').props.children, 'Cancel');
  for (let n = 0; n < 100 && !tools.snapshot().tools.codex.busy?.url; n += 1) await new Promise(resolve => setTimeout(resolve, 20));
  const html = renderTool('codex', seen[seen.length - 1].tools.codex, { onAction: name => actions.push(name) });
  assert.match(html, /Finish signing in in your browser/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(action('reopen').props.children, 'Reopen page');
  assert.equal(action('sign-in'), undefined);
  action('reopen').props.onClick(); action('cancel').props.onClick();
  assert.deepEqual(actions, ['reopen', 'cancel']);
  assert.match(renderTool('codex', tools.snapshot().tools.codex, { busy: 'cancel' }), /Cancelling…/);
  tools.cancelSignIn('codex');
  await signing;
  assert.match(renderTool('codex', tools.snapshot().tools.codex), /Not signed in/, 'cancelled: signed out as before');
});

test('missing: Install; a broken one: Try again; before the first snapshot: Checking…, and no button', async () => {
  const { tools } = await machine({ claude: 'missing', codex: 'broken' });
  const actions = [];
  assert.match(renderTool('claude', tools.snapshot().tools.claude, { onAction: name => actions.push(name) }), /Not installed/);
  assert.equal(action('install').props.children, 'Install');
  action('install').props.onClick();
  assert.deepEqual(actions, ['install']);
  const broken = renderTool('codex', tools.snapshot().tools.codex);
  assert.match(broken, /Not working/);
  assert.match(broken, /role="alert"[^>]*>Codex did not start/);
  assert.equal(action('retry').props.children, 'Try again');
  const installing = renderTool('claude', { ...tools.snapshot().tools.claude, busy: { action: 'install', phase: null } });
  assert.match(installing, /Installing…/);
  assert.equal(elements.some(element => element.type === 'button'), false, 'nothing to press while it installs');
  const unknown = renderTool('codex', undefined);
  assert.match(unknown, /Codex[\s\S]*Checking…/);
  assert.equal(elements.some(element => element.type === 'button'), false);
});

test('each Claude Code / Codex action calls what the setup dialog calls; pages open only through open-external', async () => {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return name === 'toolsSignOut' ? { ok: true, error: null } : true; };
  Object.assign(bridge, Object.fromEntries(['toolsInstall', 'toolsUpdate', 'toolsSignIn', 'toolsCancelSignIn', 'toolsCheck', 'toolsSignOut', 'openExternal'].map(name => [name, record(name)])));
  try {
    const { tools } = await machine({ claude: '2.1.300 signed-out', codex: 'broken' });
    const claude = tools.snapshot().tools.claude;
    const codex = tools.snapshot().tools.codex;
    await toolAction('install', { ...claude, status: 'missing', installed: false });
    await toolAction('update', claude);
    await toolAction('sign-in', claude);
    await toolAction('cancel', claude);
    await toolAction('retry', codex);
    await toolAction('retry', { ...codex, installed: false });
    assert.deepEqual(await toolAction('sign-out', codex), { ok: true, error: null });
    assert.deepEqual(calls, [['toolsInstall', ['claude']], ['toolsUpdate', 'claude'], ['toolsSignIn', 'claude'], ['toolsCancelSignIn', 'claude'], ['toolsCheck'], ['toolsInstall', ['codex']], ['toolsSignOut', 'codex']]);
    calls.length = 0;
    await toolAction('reopen', { ...claude, busy: { action: 'sign-in', url: 'https://claude.ai/oauth/authorize?state=abc' } });
    assert.equal(toolAction('reopen', { ...claude, busy: { action: 'sign-in', url: null } }), null, 'no page, nothing to open');
    assert.deepEqual(calls, [['openExternal', 'https://claude.ai/oauth/authorize?state=abc']], 'the default browser, never Stage');
    const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Connections.jsx'), 'utf8');
    assert.doesNotMatch(source, /browserOpen|openStage|window\.open/);
  } finally {
    for (const key of Object.keys(bridge)) delete bridge[key];
  }
});

test('the panel reads the snapshot when it opens, follows every change, and lets go when it closes', async () => {
  const listeners = new Set();
  let answer;
  const first = { checked: true, tools: { claude: { id: 'claude' } } };
  const later = { checked: true, tools: { claude: { id: 'claude', busy: { action: 'sign-in' } } } };
  Object.assign(bridge, {
    tools: () => new Promise(resolve => { answer = resolve; }),
    onTools: (callback) => { listeners.add(callback); return () => listeners.delete(callback); },
  });
  try {
    const taken = [];
    const stop = watchTools(snapshot => taken.push(snapshot));
    assert.equal(listeners.size, 1);
    answer(first); await new Promise(resolve => setImmediate(resolve));
    for (const listener of listeners) listener(later);
    assert.deepEqual(taken, [first, later]);
    stop();
    assert.equal(listeners.size, 0, 'unsubscribed on close');

    taken.length = 0;
    const again = watchTools(snapshot => taken.push(snapshot));
    for (const listener of listeners) listener(later);
    answer(first); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(taken, [later], 'an answer that comes after a change is no newer than it');
    again();
    const closed = watchTools(snapshot => taken.push(snapshot));
    closed();
    answer(first); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(taken, [later], 'nothing is taken once closed');
  } finally {
    for (const key of Object.keys(bridge)) delete bridge[key];
  }
});

test('the panel shows Claude Code and Codex under GitHub', () => {
  assert.deepEqual([...TOOL_CONNECTIONS], ['claude', 'codex']);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Connections.jsx'), 'utf8');
  assert.match(source, /<GithubConnection [^\n]*\/>\n\s*\{TOOL_CONNECTIONS\.map\(name => [^\n]*\n\s*<ToolConnection id=\{name\} tool=\{tools\?\.tools\?\.\[name\]\}/);
  assert.match(source, /React\.useEffect\(\(\) => watchTools\(setTools\), \[\]\)/, 'watched while the panel is open');
});
