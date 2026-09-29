'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');
const store = require('../src/main/store/session-ui.cjs');
const { windowOptions, createWindowState } = require('../src/main/window-state.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-view-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { dataRoot: root };
}
test('local view updates merge, survive a new reader, and remain isolated by data root', t => {
  const ctx = fixture(t), other = fixture(t);
  store.write(ctx, { 'sidebar:one:expanded': { Files: true, 'Files/images': true }, 'draft:one': 'Not submitted' });
  store.write(ctx, { 'layout:one:right': 510 });
  assert.deepEqual(store.read(ctx), { 'sidebar:one:expanded': { Files: true, 'Files/images': true }, 'draft:one': 'Not submitted', 'layout:one:right': 510 });
  assert.deepEqual(store.read(other), {});
  store.write(ctx, { 'draft:one': null });
  assert.equal(store.read(ctx)['draft:one'], undefined);
  assert.equal(fs.statSync(path.join(ctx.dataRoot, 'session-ui.json')).mode & 0o777, 0o600);
});
test('bad saved fields do not prevent startup; invalid updates cannot replace good state', t => {
  const ctx = fixture(t), file = path.join(ctx.dataRoot, 'session-ui.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, values: { 'layout:width': 320, 'draft:huge': 'x'.repeat(100001), '__proto__': 'bad' } }));
  assert.deepEqual(store.read(ctx), { 'layout:width': 320 });
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.write(ctx, { 'layout:width': 400, 'invalid': true }), /Invalid view key/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.throws(() => store.write(ctx, { 'layout:width': Infinity }), /Invalid view state/);
  fs.writeFileSync(file, '{partial');
  assert.deepEqual(store.read(ctx), {});
});
test('window restoration keeps valid positions and brings a disconnected display back on screen', t => {
  const primary = { x: 0, y: 25, width: 1440, height: 875 }, secondary = { x: 1440, y: 25, width: 1920, height: 1055 };
  const bounds = { x: 1560, y: 80, width: 1200, height: 780 };
  assert.deepEqual(windowOptions({ bounds }, [primary, secondary]), bounds);
  assert.deepEqual(windowOptions({ bounds }, [primary]), { x: 240, y: 80, width: 1200, height: 780 });
  assert.deepEqual(windowOptions({ bounds: { ...bounds, width: NaN } }, [primary]), { width: 1440, height: 900 });
  const ctx = fixture(t), state = createWindowState(ctx.dataRoot);
  state.save({ isDestroyed: () => false, getNormalBounds: () => bounds, isMaximized: () => true, isFullScreen: () => false });
  assert.deepEqual(createWindowState(ctx.dataRoot).read(), { version: 1, bounds, maximized: true, fullscreen: false });
});

const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/session-ui.js')], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
function renderer(bridge) {
  const filename = path.join(__dirname, '__view-state-test.cjs'), compiled = new Module(filename, module), previous = global.window;
  compiled.paths = module.paths;
  global.window = bridge === null ? { postItAPI: {} } : { engelbartAPI: { sessionUI: async () => ({}), ...bridge } };
  try { compiled._compile(built.outputFiles[0].text, filename); } finally { if (previous === undefined) delete global.window; else global.window = previous; }
  return compiled.exports;
}
test('restricted post-it renderers use isolated in-memory view state without the app bridge', async () => {
  const state = renderer(null), other = renderer(null);
  await state.loadSessionUI();
  assert.equal(state.sessionValue('draft:reply', 'empty'), 'empty');
  state.saveSessionValue('draft:reply', 'local only');
  assert.equal(state.sessionValue('draft:reply', 'empty'), 'local only');
  assert.equal(other.sessionValue('draft:reply', 'empty'), 'empty');
  await state.flushCanvasView();
  assert.equal(state.sessionValue('draft:reply', 'empty'), 'local only');
});
test('quit flush captures the last keystroke and waits for document writes', async () => {
  const patches = [], state = renderer({ saveSessionUI: async patch => patches.push(patch) });
  await state.loadSessionUI();
  let release;
  const write = new Promise(resolve => { release = resolve; });
  state.registerViewFlusher(() => { state.saveSessionValue('draft:reply', 'last keystroke'); state.trackViewSave(write); });
  let done = false;
  const quitting = state.flushCanvasView().then(() => { done = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(done, false); assert.equal(patches.length, 0);
  release(); await quitting;
  assert.deepEqual(patches, [{ 'draft:reply': 'last keystroke' }]);
});
test('failed saves retry without overwriting a newer draft queued behind them', async () => {
  let rejectFirst, first = true;
  const persisted = {}, state = renderer({ saveSessionUI: patch => {
    if (first) { first = false; return new Promise((_, reject) => { rejectFirst = reject; }); }
    Object.assign(persisted, patch); return Promise.resolve();
  } });
  await state.loadSessionUI();
  state.saveSessionValue('draft:reply', 'old');
  const older = state.flushSessionUI();
  await new Promise(resolve => setImmediate(resolve));
  state.saveSessionValue('draft:reply', 'new');
  const newer = state.flushSessionUI();
  rejectFirst(new Error('disk unavailable'));
  await assert.rejects(older, /disk unavailable/); await newer;
  await state.flushCanvasView();
  assert.deepEqual(persisted, { 'draft:reply': 'new' });
});
test('a failed latest save is retained and retried before quit', async () => {
  let fail = true;
  const persisted = {}, state = renderer({ saveSessionUI: async patch => { if (fail) throw new Error('disk unavailable'); Object.assign(persisted, patch); } });
  await state.loadSessionUI(); state.saveSessionValue('draft:reply', 'unsent');
  await assert.rejects(state.flushSessionUI(), /disk unavailable/);
  fail = false; await state.flushCanvasView();
  assert.deepEqual(persisted, { 'draft:reply': 'unsent' });
});
