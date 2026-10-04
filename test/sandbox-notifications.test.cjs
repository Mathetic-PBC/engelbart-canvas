'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, '__notifications-unit.cjs');
  const build = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer', file)], bundle: true, platform: 'node', format: 'cjs',
    jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/server'], loader: { '.css': 'empty', '.png': 'dataurl', '.svg': 'dataurl' } });
  const compiled = new Module(filename, module); compiled.paths = module.paths;
  const previous = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(build.outputFiles[0].text, filename); }
  finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return compiled.exports;
}
const { sandboxProgressState, sandboxProgressReducer: reduce, readNotificationState, writeNotificationState, notificationStorageKey, availableBuildNotifications, repositoryClick, previewLibraryId, failureReason } = load('model/sandbox-notifications.js');
const { NotificationBell, BuildNotification } = load('ui/SandboxNotifications.jsx');
const root = '/fixture/main';
const at = (second) => `2026-09-23T12:00:${String(second).padStart(2, '0')}.000Z`;
const run = (status, changes = {}) => ({ id: 'run', library_id: 'repo', status, created_at: at(0), updated_at: at(10),
  preview_url: status === 'ready' ? 'https://preview.example/' : null, build_log: status === 'ready' ? [{ time: at(10), message: 'Preview ready' }] : [], ...changes });
const progress = (value, extra = {}) => ({ type: 'progress', event: { dataRoot: root, run: value, ...extra } });
const readyState = () => reduce(sandboxProgressState(root), progress(run('ready'), { notification: 'preview-ready' }));

test('unavailable preview notifications stay out of the inbox, including persisted alerts before snapshots load', () => {
  const state = readyState(), saved = JSON.stringify(state.notifications);
  assert.deepEqual(availableBuildNotifications(state.notifications, state.items), state.notifications);
  assert.deepEqual(availableBuildNotifications(state.notifications, {}), []);
  for (const value of [run('starting'), run('failed'), run('stopped'), run('ready', { id: 'replacement' })]) {
    assert.deepEqual(availableBuildNotifications(state.notifications, { repo: { run: value } }), []);
  }
  assert.equal(JSON.stringify(state.notifications), saved, 'filtering does not mutate stored alerts or dismissal history');
  const restored = sandboxProgressState(root, { notifications: state.notifications });
  assert.deepEqual(availableBuildNotifications(restored.notifications, restored.items), []);
  const loaded = reduce(restored, progress(run('ready')));
  assert.equal(availableBuildNotifications(loaded.notifications, loaded.items).length, 1);
  const stopped = reduce(loaded, progress(run('stopped', { updated_at: at(20) })));
  assert.deepEqual(availableBuildNotifications(stopped.notifications, stopped.items), []);
});

test('a verified preview creates an unread notification but no navigation side effect', () => {
  let state = reduce(sandboxProgressState(root), progress(run('starting')));
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].status, 'starting');
  state = reduce(state, progress(run('ready'), { notification: 'preview-ready', open: true }));
  assert.equal(state.notifications.length, 1);
  assert.deepEqual(state.notifications[0], { id: `run:ready:${at(10)}`, runId: 'run', libraryId: 'repo', status: 'ready', at: at(10), read: false });
  assert.equal(state.items.repo.run.preview_url, 'https://preview.example/');
  assert.equal(state.open, undefined, 'legacy open flags do not become navigation state');
});

test('duplicate completion, progress and older snapshots cannot re-alert or replace current state', () => {
  let state = readyState();
  state = reduce(state, { type: 'read', ids: [state.notifications[0].id] });
  state = reduce(state, progress(run('ready'), { notification: 'preview-ready' }));
  state = reduce(state, progress(run('ready', { updated_at: at(20) }), { message: 'App log' }));
  const current = state;
  state = reduce(state, progress(run('starting', { updated_at: at(2) })));
  assert.equal(state, current);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].read, true);
  assert.equal(state.items.repo.run.status, 'ready');
});

test('restart completion refreshes that repository notification, not the whole inbox', () => {
  let state = readyState();
  state = reduce(state, { type: 'read', ids: [state.notifications[0].id] });
  state = reduce(state, progress(run('ready', { id: 'other-run', library_id: 'other-repo' })));
  state = reduce(state, progress(run('starting', { updated_at: at(30) })));
  state = reduce(state, progress(run('ready', { updated_at: at(40), build_log: [{ time: at(40), message: 'Preview ready' }] }), { notification: 'preview-ready' }));
  assert.equal(state.notifications.length, 2);
  assert.equal(state.notifications[0].at, at(40));
  assert.equal(state.notifications[0].read, false);
  assert.equal(state.notifications.filter((row) => row.libraryId === 'repo').length, 1);
});

test('build phases notify, stopped runs stay hidden, and stale runs or other roots cannot overwrite current work', () => {
  for (const value of [run('starting'), run('failed'), run('ready', { preview_url: null })]) {
    const state = reduce(sandboxProgressState(root), progress(value));
    assert.equal(availableBuildNotifications(state.notifications, state.items).length, 1);
    assert.equal(state.notifications[0].status, value.status);
  }
  assert.deepEqual(reduce(sandboxProgressState(root), progress(run('stopped'))).notifications, []);
  let state = readyState();
  assert.equal(reduce(state, { type: 'progress', event: { dataRoot: '/fixture/test', run: run('ready') } }), state);
  state = reduce(state, progress(run('starting', { id: 'new-run', created_at: at(30), updated_at: at(30) })));
  assert.equal(reduce(state, progress(run('ready'))), state);
  assert.equal(state.items.repo.run.id, 'new-run');
  assert.equal(state.notifications[0].runId, 'new-run', 'new build replaces the old notification');
  assert.equal(state.notifications[0].status, 'starting');
});

test('read state survives reloads and trimmed logs; storage is bounded and isolated by data root', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let state = readyState();
  state = reduce(state, { type: 'read', ids: [state.notifications[0].id] });
  writeNotificationState(storage, root, state);
  assert.doesNotMatch(values.get(notificationStorageKey(root)), /preview\.example|preview_url|build_log/);
  state = sandboxProgressState(root, readNotificationState(storage, root));
  state = reduce(state, progress(run('ready', { updated_at: at(40), build_log: [] })));
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].read, true);
  assert.deepEqual(readNotificationState(storage, '/fixture/test'), { notifications: [], dismissed: {} });
  assert.deepEqual(readNotificationState({ getItem: () => '{bad' }, root), { notifications: [], dismissed: {} });
  assert.deepEqual(readNotificationState({ getItem: () => '[null,{},5]' }, root), { notifications: [], dismissed: {} });
  assert.doesNotThrow(() => writeNotificationState({ setItem: () => { throw new Error('Disabled'); } }, root, state));
  for (let i = 0; i < 50; i++) state = reduce(state, progress(run('ready', { id: `run-${i}`, library_id: `repo-${i}` })));
  assert.equal(state.notifications.length, 40);
});

test('reading one preview only acknowledges its notification, while a root switch clears the inbox', () => {
  let state = readyState();
  state = reduce(state, progress(run('ready', { id: 'other', library_id: 'other' })));
  state = reduce(state, { type: 'read', ids: [state.notifications[0].id] });
  assert.equal(state.notifications.filter((row) => !row.read).length, 1);
  state = reduce(state, { type: 'reset', dataRoot: '/fixture/test' });
  assert.deepEqual(state.items, {});
  assert.deepEqual(state.notifications, []);
});

test('clearing one or all notifications preserves runs and does not clear later arrivals', () => {
  let state = readyState();
  const firstId = state.notifications[0].id;
  state = reduce(state, progress(run('ready', { id: 'other', library_id: 'other' })));
  const items = state.items;
  state = reduce(state, { type: 'clear', ids: [firstId] });
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].libraryId, 'other');
  assert.equal(state.notifications[0].read, false);
  assert.equal(state.items, items, 'clearing does not stop or remove a preview');
  assert.equal(reduce(state, { type: 'clear', ids: [firstId] }), state);
  const visibleIds = state.notifications.map((row) => row.id);
  state = reduce(state, progress(run('ready', { id: 'later', library_id: 'later' })));
  state = reduce(state, { type: 'clear', ids: visibleIds });
  assert.deepEqual(state.notifications.map((row) => row.libraryId), ['later']);
  state = reduce(state, { type: 'clear', ids: state.notifications.map((row) => row.id) });
  assert.deepEqual(state.notifications, []);
});

test('cleared notifications stay cleared through duplicates, reloads and trimmed logs; new completions still alert', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let state = readyState();
  state = reduce(state, { type: 'clear', ids: state.notifications.map((row) => row.id) });
  state = reduce(state, progress(run('ready'), { notification: 'preview-ready' }));
  assert.deepEqual(state.notifications, []);
  writeNotificationState(storage, root, state);
  assert.doesNotMatch(values.get(notificationStorageKey(root)), /preview\.example|preview_url|build_log/);
  for (const build_log of [run('ready').build_log, []]) {
    state = sandboxProgressState(root, readNotificationState(storage, root));
    state = reduce(state, progress(run('ready', { updated_at: at(20), build_log })));
    assert.deepEqual(state.notifications, []);
    assert.equal(state.items.repo.run.status, 'ready');
  }
  state = reduce(state, progress(run('starting', { updated_at: at(30) })));
  state = reduce(state, progress(run('ready', { updated_at: at(40), build_log: [{ time: at(40), message: 'Preview ready' }] }), { notification: 'preview-ready' }));
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].at, at(40));
  assert.equal(state.notifications[0].read, false);
  state = reduce(state, { type: 'clear', ids: state.notifications.map((row) => row.id) });
  state = reduce(state, progress(run('ready', { id: 'new-run', created_at: at(50), updated_at: at(55), build_log: [{ time: at(55), message: 'Preview ready' }] })));
  assert.equal(state.notifications[0].runId, 'new-run');
  state = reduce(state, { type: 'reset', dataRoot: '/fixture/test', saved: readNotificationState(storage, '/fixture/test') });
  assert.deepEqual(state.dismissed, {});
});

test('stored inbox supports legacy arrays and ignores malformed dismissal history', () => {
  const notifications = readyState().notifications;
  assert.deepEqual(readNotificationState({ getItem: () => JSON.stringify(notifications) }, root), { notifications, dismissed: {} });
  assert.deepEqual(readNotificationState({ getItem: () => JSON.stringify({ notifications, dismissed: { repo: at(10), bad: 'invalid', null: null, numeric: 10 } }) }, root),
    { notifications, dismissed: { repo: at(10) } });
  for (const value of [null, 5, { notifications: {}, dismissed: [] }]) {
    assert.deepEqual(readNotificationState({ getItem: () => JSON.stringify(value) }, root), { notifications: [], dismissed: {} });
  }
});

test('bell is a quiet labelled header control, with badge only for unread notifications', () => {
  const render = (notifications, items = readyState().items) => renderToStaticMarkup(React.createElement(NotificationBell, { notifications, items, library: [],
    markRead() { assert.fail('Rendering cannot mark notifications read'); }, openPreview() { assert.fail('Rendering cannot navigate'); } }));
  const empty = render([]);
  assert.match(empty, /aria-label="Notifications"/);
  assert.match(empty, /aria-expanded="false"/);
  assert.doesNotMatch(empty, /notification-badge|notification-panel/);
  assert.match(render(readyState().notifications), /aria-label="Notifications, 1 unread"/);
  assert.match(render(readyState().notifications), /class="notification-badge" aria-hidden="true">1</);
  assert.doesNotMatch(render([{ ...readyState().notifications[0], read: true }]), /notification-badge/);
  for (const items of [{}, { repo: { run: run('stopped') } }, { repo: { run: run('ready', { id: 'replacement' }) } }]) {
    const hidden = render(readyState().notifications, items);
    assert.match(hidden, /aria-label="Notifications"/);
    assert.doesNotMatch(hidden, /notification-badge|unread build notification/);
  }
  const mixed = reduce(readyState(), progress(run('ready', { id: 'other', library_id: 'other' })));
  mixed.items.repo = { run: run('stopped') };
  assert.match(render(mixed.notifications, mixed.items), /aria-label="Notifications, 1 unread"/);
});

test('bell is shared across screens and dropdown is marked for native-browser occlusion', () => {
  for (const name of ['Workspace', 'Home', 'Onboarding']) {
    const source = fs.readFileSync(path.join(__dirname, `../src/renderer/screens/${name}.jsx`), 'utf8');
    assert.doesNotMatch(source, /<SandboxNotifications \/>/);
  }
  const controls = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/WindowControls.jsx'), 'utf8');
  assert.match(controls, /<SandboxNotifications \/>/);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxProgress.jsx'), 'utf8');
  assert.doesNotMatch(source, /if \(event\.open\) open/);
  const bell = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxNotifications.jsx'), 'utf8');
  assert.match(bell, /data-overlay="1"/);
  assert.match(bell, /event\.stopPropagation\(\); close\(true\)/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/sandbox-notifications.css'), 'utf8');
  assert.match(css, /\.notification-control\{flex:none;display:flex;align-items:center/);
});

test('Open live and dismiss sit together at the right, centered beside the notification text', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxNotifications.jsx'), 'utf8');
  assert.match(source, /<a className="notification-repo" href=\{repo.url\}/);
  assert.match(source, /className="notification-open"/);
  assert.match(source, /Open live ↗/);
  assert.doesNotMatch(source, /Preview no longer available/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/sandbox-notifications.css'), 'utf8');
  assert.match(css, /\.notification-row\{[^}]*align-items:center/);
  assert.match(css, /\.notification-entry\{[^}]*align-items:center/);
  assert.match(css, /\.notification-copy\{[^}]*flex:1;[^}]*min-width:0;[^}]*flex-direction:column/);
  assert.match(css, /\.notification-open\{flex:none/);
  assert.doesNotMatch(css.match(/\.notification-row \.notification-dismiss\{([^}]*)\}/)[1], /position:absolute/);
});

test('notification repo, build details and live preview are separate actions; no notification click stops or retries', () => {
  const repo = { id: 'repo', name: 'owner/app', url: 'https://github.com/owner/app' };
  const descendants = element => !React.isValidElement(element) ? [] : [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
  for (const status of ['starting', 'ready', 'failed']) {
    const value = run(status), calls = [];
    const tree = BuildNotification({ notification: { id: 'notice' }, run: value, repo, onRepository: row => calls.push(['repo', row]),
      onBuild: row => calls.push(['build', row]), onOpen: item => calls.push(['live', item]), onClear: ids => calls.push(['clear', ids]) });
    const elements = descendants(tree);
    const link = elements.find(element => element.type === 'a');
    assert.equal(link.props.href, repo.url);
    let prevented = false;
    link.props.onClick({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(calls.shift(), ['repo', repo]);
    const build = elements.find(element => element.props.className === (status === 'starting' ? 'notification-build' : 'notification-description'));
    assert.equal(build.type, 'button', 'build text supports pointer and keyboard activation');
    assert.equal(build.props['aria-haspopup'], 'dialog');
    assert.equal(build.props.disabled, false);
    assert.equal(build.props.children, status === 'starting' ? 'Building…' : status === 'failed' ? 'Build failed' : 'Build finished');
    if (status !== 'starting') assert.equal(elements.some(element => element.props.className === 'notification-build'), false, 'finished/failed status replaces the separate Build button');
    build.props.onClick(); assert.deepEqual(calls.shift(), ['build', repo]);
    const live = elements.find(element => element.props.className === 'notification-open');
    if (status === 'ready') { live.props.onClick(); assert.deepEqual(calls.shift(), ['live', value]); }
    else assert.equal(live, undefined);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(renderToStaticMarkup(tree), />Stop<|>Retry<|Stop build/);
  }
  const noPreview = renderToStaticMarkup(React.createElement(BuildNotification, { notification: { id: 'notice' }, run: run('ready', { preview_url: null }), repo, onBuild() {} }));
  assert.match(noPreview, /No web preview/);
  assert.match(noPreview, /<button[^>]+class="notification-description"[^>]*>Build finished<\/button>/);
  assert.doesNotMatch(noPreview, /class="notification-open"/);
  const provider = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxProgress.jsx'), 'utf8');
  assert.match(provider, /openRepository = React.useCallback\(row => \{ if \(row\?\.url\) openUrl\(row.url\); \}/);
  assert.doesNotMatch(provider, /api.startSandbox|showNotifications/);
});


test('building progress does not re-alert and clearing it never hides completion or a failed outcome', () => {
  let state = reduce(sandboxProgressState(root), progress(run('starting')));
  const id = state.notifications[0].id;
  state = reduce(state, { type: 'read', ids: [id] });
  state = reduce(state, progress(run('starting', { updated_at: at(15) }), { message: 'Installing dependencies' }));
  assert.equal(state.notifications[0].id, id);
  assert.equal(state.notifications[0].read, true);
  state = reduce(state, { type: 'clear', ids: [id] });
  const saved = { notifications: state.notifications, dismissed: state.dismissed };
  for (const status of ['ready', 'failed']) {
    let restored = sandboxProgressState(root, saved);
    restored = reduce(restored, progress(run('starting', { updated_at: at(15) })));
    assert.equal(restored.notifications.length, 0, 'dismissed progress stays dismissed after reload');
    restored = reduce(restored, progress(run(status, { updated_at: at(20), finished_at: status === 'failed' ? at(20) : null })));
    assert.equal(restored.notifications.length, 1);
    assert.equal(restored.notifications[0].status, status);
    assert.equal(restored.notifications[0].read, false);
  }
  state = reduce(state, progress(run('starting', { updated_at: at(15) }), { reveal: true }));
  assert.equal(state.notifications.length, 1, 'explicit repository click can reopen dismissed progress');
});

test('same-run restarts replace completion with building and survive a reload without duplicate alerts', () => {
  let state = readyState();
  const restarting = run('starting', { updated_at: at(30), build_log: [{ time: at(30), data: { lifecycle: 'restart' } }] });
  state = reduce(state, progress(restarting));
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].status, 'starting');
  assert.equal(state.notifications[0].at, at(30));
  state = reduce(state, { type: 'clear', ids: state.notifications.map(row => row.id) });
  state = reduce(sandboxProgressState(root, state), progress(restarting));
  assert.deepEqual(state.notifications, []);
  state = reduce(state, progress(run('ready', { updated_at: at(40), build_log: [{ time: at(40), message: 'Preview ready' }] })));
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].status, 'ready');
  assert.equal(state.notifications[0].at, at(40));
});

test('a repository clicked in the sidebar opens its live preview, else its build; without a sandbox it opens as before', () => {
  assert.equal(repositoryClick({ run: run('ready') }), 'preview');
  assert.equal(repositoryClick({ run: run('ready', { preview_url: null }) }), 'details', 'ready without an address is not live yet');
  for (const status of ['starting', 'failed', 'stopped']) assert.equal(repositoryClick({ run: run(status) }), 'details');
  assert.equal(repositoryClick(undefined), null);
  assert.equal(repositoryClick(null), null);
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspace, /const onRowClick = [\s\S]*?repositoryClick\(sandbox\)[\s\S]*?sandboxes\.open\(sandbox\.run\)[\s\S]*?sandboxes\.openBuild\(row\)[\s\S]*?openItem\(row\)/);
});

test('a repository ended only because nobody opened it for 7 days is built again on click; asleep it opens as live', () => {
  const expired = run('stopped', { build_log: [{ time: at(20), message: 'Stopped after 7 days unopened', data: { lifecycle: 'expired' } }] });
  assert.equal(repositoryClick({ run: expired }), 'start');
  assert.equal(repositoryClick({ run: run('stopped', { build_log: [{ time: at(20), message: 'Sandbox stopped' }] }) }), 'details', 'Stop still shows the build');
  const asleep = run('ready', { build_log: [{ time: at(10), message: 'Preview ready' }, { time: at(20), message: 'Paused after 10 minutes unused', data: { lifecycle: 'paused' } }] });
  assert.equal(repositoryClick({ run: asleep }), 'preview');
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspace, /click === 'start'\) \{ sandboxes\.openBuild\(row\); sandboxes\.act\(sandbox\.run, \(\) => api\.startSandbox\(row\.id\)\)/);
});

test('the Stage keeps a ready preview awake only while it is in front of a focused window', () => {
  const items = { repo: { run: run('ready', { preview_url: 'https://43110-sb1.e2b.app/app?x=1' }) },
    other: { run: run('starting', { id: 'run-2', library_id: 'other', preview_url: 'https://43110-sb2.e2b.app/' }) } };
  assert.equal(previewLibraryId(items, 'https://43110-sb1.e2b.app/somewhere/else'), 'repo', 'anywhere on its host');
  assert.equal(previewLibraryId(items, 'https://43110-sb2.e2b.app/'), null, 'not ready');
  assert.equal(previewLibraryId(items, 'https://example.org/'), null);
  assert.equal(previewLibraryId(items, 'about:blank'), null);
  assert.equal(previewLibraryId(items, 'not an address'), null);
  assert.equal(previewLibraryId(null, 'https://43110-sb1.e2b.app/'), null);
  const provider = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxProgress.jsx'), 'utf8');
  assert.match(provider, /if \(!libraryId \|\| !focused\) return undefined;[\s\S]*?touch\(\);\s*const timer = setInterval\(touch, 60_000\);\s*return \(\) => clearInterval\(timer\);/);
  assert.match(provider, /api\.onWindowFocus/);
  const stage = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Stage.jsx'), 'utf8');
  assert.match(stage, /usePreviewTouch\(\(web && web\.url\) \|\| tab\.url, visible && page\)/);
});

// The bell says a build failed and, at most, why in a few words (2026-10-03); the whole error is in its build details.
test('a failed build shows a short reason, never its whole error', () => {
  const cases = [
    ['Claude finished without a verified web preview. Retry from build details.', 'No web preview found'],
    ['Setup stopped', 'Setup stopped'],
    ['Setup was interrupted. Retry to start a new run.', 'Setup stopped'],
    ['Claude Code is not signed in to a Claude subscription (Engelbart ▸ Set Up Tools… signs in).', 'Claude Code not signed in'],
    ['Claude Code is not installed yet (Engelbart ▸ Set Up Tools… installs it).', 'Claude Code not installed'],
    ['Claude Code did not finish: error_max_turns. Retry from build details.', 'Setup failed'],
    ['Repository not found', 'Setup failed'],
    [null, 'Setup failed'],
  ];
  for (const [error, reason] of cases) {
    assert.equal(failureReason(run('failed', { error })), reason, String(error));
    assert.ok(reason.length <= 60);
  }
  assert.equal(failureReason(run('ready')), '');
  const repo = { id: 'repo', name: 'owner/app', url: 'https://github.com/owner/app' };
  const error = 'Claude finished without a verified web preview. See the setup log for missing requirements. No ANTHROPIC_API_KEY is configured for fallback. Check Claude sign-in/usage or add a fallback key in ~/.engelbart/sandbox.env. Retry from build details.';
  const html = renderToStaticMarkup(React.createElement(BuildNotification, { notification: { id: 'notice' }, run: run('failed', { error }), repo, onBuild() {} }));
  assert.match(html, />Build failed<\/button>/);
  assert.match(html, /<span class="notification-detail">No web preview found<\/span>/);
  assert.doesNotMatch(html, /ANTHROPIC|fallback|setup log/);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxNotifications.jsx'), 'utf8');
  assert.doesNotMatch(source, /\{run\.error\}/, 'the bell row never prints the error itself');
  const details = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/BuildDetails.jsx'), 'utf8');
  assert.match(details, /\{run\?\.error && <p role="alert" className="repo-error">\{run\.error\}<\/p>\}/, 'build details keep the whole error');
});

test('a terminal opens its terminal, an interface its preview, both both; a terminal has no "No web preview" line', () => {
  const repo = { id: 'repo', name: 'owner/app', url: 'https://github.com/owner/app' };
  const terminal = { cwd: '.', hint: 'python main.py --help' };
  const runs = {
    interface: run('ready', { kind: 'interface' }),
    terminal: run('ready', { kind: 'terminal', preview_url: null, terminal, build_log: [{ time: at(10), message: 'Terminal ready', data: { phase: 'ready', kind: 'terminal' } }] }),
    both: run('ready', { kind: 'both', terminal }),
  };
  const descendants = element => !React.isValidElement(element) ? [] : [element, ...React.Children.toArray(element.props.children).flatMap(descendants)];
  for (const [kind, value] of Object.entries(runs)) {
    const calls = [];
    const tree = BuildNotification({ notification: { id: 'notice' }, run: value, repo, onRepository() {}, onBuild() {}, onClear() {},
      onOpen: (item) => calls.push(['live', item.kind]), onTerminal: (item) => calls.push(['terminal', item.kind]) });
    const elements = descendants(tree);
    const live = elements.find((element) => element.props.className === 'notification-open');
    const shell = elements.find((element) => element.props.className === 'notification-open notification-terminal');
    assert.equal(!!live, kind !== 'terminal', `${kind}: Open live`);
    assert.equal(!!shell, kind !== 'interface', `${kind}: Open terminal`);
    if (live) { assert.equal(live.props.children, 'Open live ↗'); live.props.onClick(); }
    if (shell) { assert.equal(shell.props.children, 'Open terminal'); shell.props.onClick(); }
    assert.deepEqual(calls, [...(live ? [['live', kind]] : []), ...(shell ? [['terminal', kind]] : [])]);
    assert.doesNotMatch(renderToStaticMarkup(tree), /No web preview/);
  }
  // A ready run's notification is dated by its ready entry, for a terminal too.
  const state = reduce(sandboxProgressState(root), progress(runs.terminal));
  assert.equal(state.notifications[0].at, at(10));
});

test('a repository clicked in the sidebar opens what its kind is used through; runs from before kinds open as previews', () => {
  const terminal = { cwd: '.', hint: 'make help' };
  assert.equal(repositoryClick({ run: run('ready', { kind: 'interface' }) }), 'preview');
  assert.equal(repositoryClick({ run: run('ready') }), 'preview', 'no kind: a preview, as every run was');
  assert.equal(repositoryClick({ run: run('ready', { kind: 'terminal', preview_url: null, terminal }) }), 'terminal');
  assert.equal(repositoryClick({ run: run('ready', { kind: 'both', terminal }) }), 'both');
  assert.equal(repositoryClick({ run: run('ready', { kind: 'terminal', preview_url: null, terminal: null }) }), 'details', 'no terminal yet');
  assert.equal(repositoryClick({ run: run('ready', { kind: 'both', terminal: null }) }), 'preview');
  assert.equal(repositoryClick({ run: run('starting', { kind: 'terminal', terminal }) }), 'details');
  const expired = run('stopped', { kind: 'terminal', build_log: [{ time: at(20), message: 'Stopped after 7 days unopened', data: { lifecycle: 'expired' } }] });
  assert.equal(repositoryClick({ run: expired }), 'start', 'one ended after a week unopened is built again, whatever its kind');
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspace, /click === 'terminal'\) \{ sandboxes\.openTerminal\(sandbox\.run\); return; \}/);
  assert.match(workspace, /click === 'both'\) \{ sandboxes\.openTerminal\(sandbox\.run, \{ show: false \}\); sandboxes\.open\(sandbox\.run\); return; \}/);
  assert.match(workspace, /window\.addEventListener\(OPEN_SANDBOX_TERMINAL, onOpen\)/);
  const pane = fs.readFileSync(path.join(__dirname, '../src/renderer/terminal/TerminalPane.jsx'), 'utf8');
  assert.match(pane, /useSandboxTouch\(visible && current && inSandbox\(current\) && running \? current\.snapshot\.libraryId \|\| null : null\)/, 'its tab in front of a focused window keeps the sandbox awake');
});
