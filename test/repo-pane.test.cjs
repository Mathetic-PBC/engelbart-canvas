'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const React = require('react');
const jsxRuntime = require('react/jsx-runtime');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const elements = [];
const recordingRuntime = { ...jsxRuntime };
for (const method of ['jsx', 'jsxs']) recordingRuntime[method] = (...args) => {
  const element = jsxRuntime[method](...args);
  elements.push(element);
  return element;
};
const filename = path.join(__dirname, '__repo-pane-unit.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/RepoPane.jsx')], bundle: true, platform: 'node',
  format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' } });
const compiled = new Module(filename, module);
compiled.paths = module.paths;
compiled.require = function (id) { return id === 'react/jsx-runtime' ? recordingRuntime : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
const started = [];
const stopped = [];
const external = [];
global.window = { engelbartAPI: { startSandbox: (id) => { started.push(id); }, stopSandbox: (id) => { stopped.push(id); }, openExternal: (url) => { external.push(url); } } };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { Repository, RepoSwitcher, repoToolbarStatus } = compiled.exports;
const repo = { id: 'repo', name: 'owner/app', url: 'https://github.com/owner/app' };
const run = (status, overrides = {}) => ({ id: 'run', status, sandbox_id: 'vm', preview_url: status === 'ready' ? 'https://preview.example' : null,
  created_at: '2026-09-22T01:00:00Z', build_log: [], ...overrides });
const render = (value, props = {}) => {
  elements.length = 0;
  return renderToStaticMarkup(React.createElement(Repository, { repo, item: value ? { run: value } : undefined,
    busy: {}, act() { assert.fail('Rendering must not execute a sandbox action'); }, open() { assert.fail('Rendering must not open a preview'); }, ...props }));
};

const toolbar = (html) => html.match(/<header class="repo-toolbar"[\s\S]*?<\/header>/)[0];
const buttonText = (element) => React.Children.toArray(element.props.children).filter((child) => typeof child === 'string').join('');
const button = (label) => elements.find((element) => element.type === 'button' && buttonText(element) === label);

test('header status follows saved lifecycle state without inventing live or failed states', () => {
  assert.deepEqual(repoToolbarStatus(), { label: 'Inactive', kind: 'inactive' });
  assert.deepEqual(repoToolbarStatus(run('stopped')), { label: 'Inactive', kind: 'inactive' });
  assert.deepEqual(repoToolbarStatus(run('starting')), { label: 'Preparing…', kind: 'starting' });
  assert.deepEqual(repoToolbarStatus(run('ready')), { label: 'Live', kind: 'live' });
  assert.deepEqual(repoToolbarStatus(run('ready', { preview_url: null })), { label: 'Ready', kind: 'ready' });
  assert.deepEqual(repoToolbarStatus(run('failed')), { label: 'Needs attention', kind: 'failed' });
  assert.deepEqual(repoToolbarStatus(run('starting', { error: 'An earlier warning' })), { label: 'Preparing…', kind: 'starting' });
  assert.deepEqual(repoToolbarStatus(run('failed', { build_log: [{ data: { phase: 'usable' } }] })), { label: 'Needs attention', kind: 'failed' });
});

test('Repo header groups runtime status with Build on the right outside the scrolling README', () => {
  for (const value of [undefined, run('starting'), run('ready'), run('ready', { preview_url: null }), run('failed'), run('stopped')]) {
    const html = render(value);
    const actions = toolbar(html);
    const status = repoToolbarStatus(value);
    assert.equal((actions.match(/<button\b/g) || []).length, status.kind === 'live' ? 2 : 1);
    assert.ok(actions.includes(status.label));
    assert.match(actions, /<a class="repo-toolbar-identity repo-repository-link" href="https:\/\/github.com\/owner\/app"[^>]*><svg[^>]+aria-hidden="true"/);
    assert.match(actions, /class="repo-toolbar-name">owner\/app<\/span>/);
    assert.match(actions, /class="repo-toolbar-actions"><button[^>]+class="repo-toolbar-build"[^>]*>Build<\/button><span class="repo-runtime">[\s\S]*repo-toolbar-status/);
    assert.match(actions, /class="repo-toolbar-repository">[\s\S]*<\/div><div class="repo-toolbar-actions"><button[^>]+class="repo-toolbar-build"/);
    assert.doesNotMatch(actions, /repo-toolbar-breadcrumb|repo-toolbar-separator/);
    assert.doesNotMatch(actions, /<select|>Working…<|repo-button-primary|>Open live<|>Retry</);
    assert.match(html, /class="repo-selected"><header class="repo-toolbar"/);
    assert.match(html, /<\/header><div class="repo-body"><div class="repo-reading"><div class="repo-document"/);
    assert.doesNotMatch(html, /repo-inline-actions|repo-readme-intro|Build logs &amp; env|repo-selector/);
    assert.match(html, /role="dialog"[^>]+class="repo-details" hidden=""/);
  }
});

test('repo navigation receives existing repositories and the supplied selection handler without a build action', () => {
  const other = { id: 'other', name: 'owner/other', url: 'https://github.com/owner/other' };
  const selected = [];
  started.length = 0;
  const actions = toolbar(render(run('ready'), { repositories: [repo, other], onSelect: (id) => selected.push(id) }));
  const selector = elements.find((element) => element.type === RepoSwitcher);
  assert.equal(selector.props.repo, repo);
  assert.deepEqual(selector.props.repositories, [repo, other]);
  selector.props.onSelect(other.id);
  assert.deepEqual(selected, [other.id]);
  assert.deepEqual(started, []);
  assert.match(actions, /<svg class="repo-toolbar-caret"[^>]*aria-hidden="true"/);
  assert.match(actions, /aria-label="Switch repository"[^>]*aria-haspopup="dialog" aria-expanded="false"/);
  assert.ok(actions.indexOf('repo-switch-trigger') < actions.indexOf('repo-toolbar-actions'));
  assert.doesNotMatch(actions, /<select/);
});

test('a single repository stays a plain identity without an inactive switcher affordance', () => {
  for (const props of [{ repositories: [repo], onSelect() {} }, { repositories: [repo, { id: 'other', name: 'Other' }] }]) {
    const actions = toolbar(render(run('ready'), props));
    assert.doesNotMatch(actions, /<select|repo-switch-trigger|repo-toolbar-caret/);
    assert.match(actions, /repo-toolbar-name">owner\/app/);
  }
});

test('preparing is a non-clickable spinner status while Build stays available as navigation', () => {
  const actions = toolbar(render(run('starting'), { busy: { run: true } }));
  assert.equal((actions.match(/<button\b/g) || []).length, 1);
  assert.match(actions, /<span class="repo-toolbar-status repo-toolbar-status-starting" role="status">/);
  assert.match(actions, /class="repo-toolbar-spinner" aria-hidden="true"/);
  assert.match(actions, /Preparing…/);
  assert.match(actions, />Build<\/button>/);
  assert.doesNotMatch(actions, /repo-button-primary|disabled=/);
});

test('busy state disables Live without hiding Build inspector access', () => {
  const actions = toolbar(render(run('ready'), { busy: { run: true } }));
  const live = elements.find((element) => element.type === 'button' && element.props['aria-label'] === 'Open live preview for owner/app');
  assert.equal(live.props.disabled, true);
  assert.equal(live.props['aria-busy'], true);
  assert.equal(button('Open preview').props.disabled, true);
  assert.ok(!button('Build').props.disabled);
  assert.equal((actions.match(/disabled=/g) || []).length, 1);
});

test('Live and the primary footer action call the existing preview handler without starting a build', () => {
  const ready = run('ready');
  const opened = [];
  started.length = 0;
  render(ready, { open: (value) => opened.push(value) });
  const live = elements.find((element) => element.type === 'button' && element.props['aria-label'] === 'Open live preview for owner/app');
  live.props.onClick();
  const preview = button('Open preview');
  assert.equal(preview.props.disabled, false);
  preview.props.onClick();
  assert.deepEqual(opened, [ready, ready]);
  assert.deepEqual(started, []);
});

test('Build targets the existing inspector in every state without starting another build', () => {
  for (const value of [undefined, run('stopped'), run('starting'), run('failed'), run('ready'), run('ready', { preview_url: null })]) {
    started.length = 0;
    render(value);
    const details = button('Build');
    const dialog = elements.find((element) => element.type === 'dialog');
    assert.equal(details.props['aria-haspopup'], 'dialog');
    assert.equal(details.props['aria-controls'], dialog.props.id);
    assert.ok(!details.props.disabled);
    details.props.onClick();
    assert.deepEqual(started, []);
  }
});

test('Run and Retry inside the inspector keep using the existing start API', () => {
  for (const [value, label] of [[undefined, 'Run'], [run('stopped'), 'Retry build'], [run('failed'), 'Retry build']]) {
    started.length = 0;
    const targets = [];
    render(value, { act: (target, action) => { targets.push(target.id); return action(); } });
    button(label).props.onClick({ currentTarget: {} });
    assert.deepEqual(started, [repo.id]);
    assert.deepEqual(targets, [value?.id || repo.id]);
  }
});

test('the slightly larger 44px header remains unboxed and outside the scrolling README', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/repo-pane.css'), 'utf8');
  const toolbar = css.match(/\.repo-toolbar\{([^}]*)\}/)[1];
  assert.match(toolbar, /flex:none/);
  assert.match(toolbar, /height:44px/);
  assert.match(toolbar, /border-bottom:1px solid #eaeaea/);
  assert.doesNotMatch(toolbar, /box-shadow|border-radius/);
  assert.match(css, /\.repo-body\{[^}]*flex:1;min-height:0/);
  assert.match(css, /\.repo-document\{[^}]*overflow:auto/);
  assert.doesNotMatch(css, /repo-inline-actions|repo-readme-intro/);
  assert.match(css, /\.repo-toolbar-status\{[^}]*background:transparent;[^}]*font:13px\/1\.5/);
  assert.match(css, /\.repo-toolbar-repository\{[^}]*flex:1;min-width:0/);
  assert.match(css, /\.repo-toolbar-name\{[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\.repo-toolbar-spinner\{animation:none\}/);
});

test('non-live statuses are informational even if an old preview URL is still present', () => {
  for (const status of ['starting', 'failed', 'stopped']) {
    const actions = toolbar(render(run(status, { preview_url: 'https://stale.example' })));
    assert.match(actions, /role="status"/);
    assert.doesNotMatch(actions, /Open live preview for|repo-toolbar-status-live/);
    assert.equal((actions.match(/<button\b/g) || []).length, 1);
    if (status === 'starting') assert.equal(button('Open preview').props.disabled, true);
  }
});

test('Build surface separates repo navigation in the header from lifecycle controls in the footer', () => {
  const ready = render(run('ready'));
  const header = ready.match(/<header class="repo-details-heading">[\s\S]*?<\/header>/)[0];
  const footer = ready.match(/<footer class="repo-details-footer">[\s\S]*?<\/footer>/)[0];
  assert.match(header, /repo-toolbar-identity[\s\S]*<svg/);
  assert.doesNotMatch(header, /repo-toolbar-separator|repo-details-section|>Build</);
  assert.match(header, /repo-details-repository[\s\S]*repo-toolbar-name[\s\S]*repo-runtime[\s\S]*repo-toolbar-status-live/);
  assert.doesNotMatch(header, /repo-toolbar-open|↗/);
  assert.match(toolbar(ready), /class="repo-toolbar-open" aria-hidden="true">↗<\/span>/);
  assert.match(header, /<a[^>]+href="https:\/\/github.com\/owner\/app"[^>]+aria-label="Open owner\/app on GitHub"/);
  assert.doesNotMatch(header, /View on GitHub/);
  assert.match(header, /aria-label="Close build details" title="Close">×<\/button>/);
  assert.doesNotMatch(header, /Stop sandbox|Retry build|repo-button|>Close</);
  assert.doesNotMatch(footer, /Sandbox running|role="status"/);
  assert.match(footer, /repo-details-action-primary[^>]*>Open preview<\/button>[\s\S]*>Stop sandbox<\/button>/);
  assert.match(footer, />Stop sandbox<\/button>/);
  assert.doesNotMatch(footer, /View on GitHub|Refresh README/);
  assert.doesNotMatch(ready, /Refresh README|repo-readme-actions/);
  assert.match(ready, /role="tab"[^>]+data-tab="build"[^>]+aria-selected="true"/);
  assert.match(ready, /role="tab"[^>]+data-tab="logs"/);
  assert.match(ready, /role="tab"[^>]+data-tab="environment"/);
  assert.doesNotMatch(ready, /<details/);
  assert.match(render(run('failed', { error: 'Install failed' })), />Retry build<\/button>/);
  assert.match(render(run('failed', { error: 'Install failed' })), /role="alert"[^>]+>Install failed/);
  assert.doesNotMatch(render(run('failed', { sandbox_id: null })), />Stop sandbox<\/button>/);
});

test('lifecycle status sits beside the modal repository name and leaves the footer for actions', () => {
  for (const value of [undefined, run('starting', { sandbox_id: null }), run('starting'), run('ready'), run('ready', { preview_url: null }), run('failed'), run('stopped')]) {
    const html = render(value);
    const header = html.match(/<header class="repo-details-heading">[\s\S]*?<\/header>/)[0];
    const footer = html.match(/<footer class="repo-details-footer">[\s\S]*?<\/footer>/)[0];
    assert.ok(header.includes(repoToolbarStatus(value).label));
    assert.doesNotMatch(footer, /role="status"|Sandbox running|Sandbox preparing|Sandbox stopped/);
    if (value?.status === 'ready' && !value.preview_url) assert.equal(button('Open preview').props.disabled, true);
  }
});

test('repo identity and Stop actions retain the original targets and error-handling path', () => {
  stopped.length = 0; external.length = 0;
  const targets = [];
  render(run('ready'), { act: (target, action) => { targets.push(target.id); return action(); } });
  let prevented = false;
  elements.find((element) => element.type === 'a' && element.props['aria-label'] === 'Open owner/app on GitHub').props.onClick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  button('Stop sandbox').props.onClick();
  assert.deepEqual(external, [repo.url]);
  assert.deepEqual(stopped, ['run']);
  assert.deepEqual(targets, ['run', 'run']);
  render(run('ready'), { busy: { run: true } });
  assert.equal(button('Stop sandbox').props.disabled, true);
  assert.equal(elements.find((element) => element.type === 'button' && element.props['aria-label'] === 'Close build details').props.disabled, undefined);
});

test('all three tabs have matching panels and keyboard navigation from the Build overview', () => {
  render(run('ready'));
  const tabs = elements.filter((element) => element.type === 'button' && element.props.role === 'tab');
  assert.deepEqual(tabs.map((tab) => tab.props['data-tab']), ['build', 'logs', 'environment']);
  for (const tab of tabs) {
    const panel = elements.find((element) => element.type === 'div' && element.props.id === tab.props['aria-controls']);
    assert.equal(panel.props['aria-labelledby'], tab.props.id);
    assert.equal(panel.props.hidden, tab.props['data-tab'] !== 'build');
  }
  const list = elements.find((element) => element.props.role === 'tablist');
  for (const [key, destination] of [['ArrowRight', 'logs'], ['ArrowLeft', 'environment'], ['Home', 'build'], ['End', 'environment']]) {
    let focused, prevented = false;
    list.props.onKeyDown({ key, preventDefault() { prevented = true; }, currentTarget: { querySelector(selector) { return { focus() { focused = selector; } }; } } });
    assert.equal(prevented, true);
    assert.equal(focused, `[data-tab="${destination}"]`);
  }
});

test('event-retention plumbing is absent and the footer remains outside the scrolling content', () => {
  const html = render(run('ready', { build_log: Array.from({ length: 300 }, () => ({ message: 'recorded output' })) }));
  assert.doesNotMatch(html, /Showing the latest 300 build events|Refresh README/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/repo-pane.css'), 'utf8');
  assert.match(css, /\.repo-details-footer\{[^}]*flex:none;[^}]*border-top:1px solid #eaeaea/);
  assert.match(css, /\.repo-details-log-pane\{display:flex;flex-direction:column;overflow:hidden/);
  assert.doesNotMatch(css.match(/\.repo-details\{([^}]*)\}/)[1], /box-shadow/);
});

test('sandbox action errors remain visible without reopening the details panel', () => {
  const html = render(run('ready'), { error: 'Could not stop sandbox' });
  assert.match(html, /<\/header><p role="alert" class="repo-error">Could not stop sandbox<\/p><div class="repo-body"/);
});
