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
const { sandboxProgressState, sandboxProgressReducer: reduce, readNotifications, writeNotifications, notificationStorageKey } = load('model/sandbox-notifications.js');
const { NotificationBell } = load('ui/SandboxNotifications.jsx');
const root = '/fixture/main';
const at = (second) => `2026-09-23T12:00:${String(second).padStart(2, '0')}.000Z`;
const run = (status, changes = {}) => ({ id: 'run', library_id: 'repo', status, created_at: at(0), updated_at: at(10),
  preview_url: status === 'ready' ? 'https://preview.example/' : null, build_log: status === 'ready' ? [{ time: at(10), message: 'Preview ready' }] : [], ...changes });
const progress = (value, extra = {}) => ({ type: 'progress', event: { dataRoot: root, run: value, ...extra } });
const readyState = () => reduce(sandboxProgressState(root), progress(run('ready'), { notification: 'preview-ready' }));

test('a verified preview creates an unread notification but no navigation side effect', () => {
  let state = reduce(sandboxProgressState(root), progress(run('starting')));
  assert.equal(state.notifications.length, 0);
  state = reduce(state, progress(run('ready'), { notification: 'preview-ready', open: true }));
  assert.equal(state.notifications.length, 1);
  assert.deepEqual(state.notifications[0], { id: `run:${at(10)}`, runId: 'run', libraryId: 'repo', at: at(10), read: false });
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

test('failures, no-service results, stale runs and other data roots do not create preview alerts', () => {
  for (const value of [run('starting'), run('failed'), run('stopped'), run('ready', { preview_url: null })]) {
    assert.equal(reduce(sandboxProgressState(root), progress(value)).notifications.length, 0);
  }
  let state = readyState();
  assert.equal(reduce(state, { type: 'progress', event: { dataRoot: '/fixture/test', run: run('ready') } }), state);
  state = reduce(state, progress(run('starting', { id: 'new-run', created_at: at(30), updated_at: at(30) })));
  assert.equal(reduce(state, progress(run('ready'))), state);
  assert.equal(state.items.repo.run.id, 'new-run');
  assert.notEqual(state.notifications[0].runId, state.items.repo.run.id, 'old notification cannot open the replacement build');
});

test('read state survives reloads and trimmed logs; storage is bounded and isolated by data root', () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  let state = readyState();
  state = reduce(state, { type: 'read', ids: [state.notifications[0].id] });
  writeNotifications(storage, root, state.notifications);
  assert.doesNotMatch(values.get(notificationStorageKey(root)), /preview\.example|preview_url|build_log/);
  state = sandboxProgressState(root, readNotifications(storage, root));
  state = reduce(state, progress(run('ready', { updated_at: at(40), build_log: [] })));
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].read, true);
  assert.deepEqual(readNotifications(storage, '/fixture/test'), []);
  assert.deepEqual(readNotifications({ getItem: () => '{bad' }, root), []);
  assert.deepEqual(readNotifications({ getItem: () => '[null,{},5]' }, root), []);
  assert.doesNotThrow(() => writeNotifications({ setItem: () => { throw new Error('Disabled'); } }, root, []));
  for (let i = 0; i < 50; i++) state = reduce(state, progress(run('ready', { id: `run-${i}`, library_id: `repo-${i}` })));
  assert.equal(state.notifications.length, 40);
});

test('reading one preview only acknowledges its notification, while a root switch clears the inbox', () => {
  let state = readyState();
  state = reduce(state, progress(run('ready', { id: 'other', library_id: 'other' })));
  state = reduce(state, { type: 'read', ids: [state.notifications[0].id] });
  assert.equal(state.notifications.filter((row) => !row.read).length, 1);
  state = reduce(state, { type: 'reset', dataRoot: '/fixture/test', notifications: [] });
  assert.deepEqual(state.items, {});
  assert.deepEqual(state.notifications, []);
});

test('bell is a quiet labelled header control, with badge only for unread notifications', () => {
  const render = (notifications) => renderToStaticMarkup(React.createElement(NotificationBell, { notifications, items: {}, library: [],
    markRead() { assert.fail('Rendering cannot mark notifications read'); }, openPreview() { assert.fail('Rendering cannot navigate'); } }));
  const empty = render([]);
  assert.match(empty, /aria-label="Notifications"/);
  assert.match(empty, /aria-expanded="false"/);
  assert.doesNotMatch(empty, /notification-badge|notification-panel/);
  assert.match(render(readyState().notifications), /aria-label="Notifications, 1 unread"/);
  assert.match(render(readyState().notifications), /class="notification-badge" aria-hidden="true">1</);
  assert.doesNotMatch(render([{ ...readyState().notifications[0], read: true }]), /notification-badge/);
});

test('bell is shared immediately before Test and dropdown is marked for native-browser occlusion', () => {
  for (const name of ['Workspace', 'Home', 'CreateProject']) {
    const source = fs.readFileSync(path.join(__dirname, `../src/renderer/screens/${name}.jsx`), 'utf8');
    assert.doesNotMatch(source, /<SandboxNotifications \/>/);
  }
  const controls = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/TestToggle.jsx'), 'utf8');
  assert.match(controls, /<SandboxNotifications \/>\s*<Button[^>]*[\s\S]*?Test ·/);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxProgress.jsx'), 'utf8');
  assert.doesNotMatch(source, /if \(event\.open\) open/);
  const bell = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/SandboxNotifications.jsx'), 'utf8');
  assert.match(bell, /data-overlay="1"/);
  assert.match(bell, /event\.stopPropagation\(\); close\(true\)/);
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/ui/sandbox-notifications.css'), 'utf8');
  assert.match(css, /\.notification-control\{flex:none;display:flex;align-items:center/);
});
