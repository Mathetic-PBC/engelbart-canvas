'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CrossSourceShortcutGate,
  handleTerminalKeyEvent,
  initialTerminalGeometry,
  openTerminalLink,
  browserLink,
  PendingEvents,
  preservedChromeFocus,
  splitUtf8Chunks,
  terminalKeyAction,
  workspaceKeyAction,
} = require('../src/renderer/terminal/helpers.cjs');

test('splitUtf8Chunks preserves ordered Unicode below the byte ceiling', () => {
  const source = `${'a'.repeat(11)}🧠${'漢字'.repeat(20)}\n${'🧪'.repeat(9)}`;
  const chunks = splitUtf8Chunks(source, 17);

  assert.equal(chunks.join(''), source);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 17));
  assert.ok(chunks.every((chunk) => !chunk.includes('\ufffd')));
});

test('splitUtf8Chunks rejects a limit too small for one Unicode scalar', () => {
  assert.throws(() => splitUtf8Chunks('🧠', 3), /complete character/i);
});

test('terminal key mapping reserves only plain Shift+Enter and macOS copy', () => {
  assert.equal(terminalKeyAction({ key: 'Enter', shiftKey: true }), 'line-feed');
  assert.equal(terminalKeyAction({ key: 'Enter', shiftKey: true, isComposing: true }), null);
  assert.equal(terminalKeyAction({ key: 'Enter', shiftKey: true, altKey: true }), null);
  assert.equal(terminalKeyAction({ key: 'j', ctrlKey: true }), null);
  assert.equal(terminalKeyAction({ key: 'Enter', altKey: true }), null);
  assert.equal(terminalKeyAction({ key: 'c', metaKey: true }), 'copy');
  assert.equal(terminalKeyAction({ key: 'c', ctrlKey: true }), null);
});

test('Shift+Enter lifecycle sends LF once and suppresses keydown, keypress and keyup', () => {
  const sent = [];
  let prevented = 0;
  const base = { key: 'Enter', shiftKey: true, preventDefault: () => { prevented += 1; } };

  assert.equal(handleTerminalKeyEvent({ ...base, type: 'keydown' }, (data) => sent.push(data)), false);
  assert.equal(handleTerminalKeyEvent({ ...base, type: 'keypress' }, (data) => sent.push(data)), false);
  assert.equal(handleTerminalKeyEvent({ ...base, type: 'keyup' }, (data) => sent.push(data)), false);
  assert.deepEqual(sent, ['\n']);
  assert.equal(prevented, 3);
});

test('workspace shortcuts recognize literal Cmd+plus without stealing equals or Ctrl combos', () => {
  assert.deepEqual(workspaceKeyAction({ key: '+', metaKey: true }, {}), { type: 'font-increase' });
  assert.equal(workspaceKeyAction({ key: '=', metaKey: true }, {}), null);
  assert.equal(workspaceKeyAction({ key: '+', metaKey: true, ctrlKey: true }, {}), null);
  assert.equal(workspaceKeyAction({ key: '+', ctrlKey: true }, {}), null);
});

test('workspace shortcuts are inert behind the new-session modal', () => {
  const modal = { dialogOpen: true, findOpen: true };
  assert.equal(workspaceKeyAction({ key: 'Escape' }, modal), null);
  assert.equal(workspaceKeyAction({ key: '2', metaKey: true }, modal), null);
  assert.equal(workspaceKeyAction({ key: '+', metaKey: true }, modal), null);

  assert.deepEqual(workspaceKeyAction({ key: '2', metaKey: true }, {}), { type: 'activate-session', index: 1 });
  assert.deepEqual(workspaceKeyAction({ key: 'Escape' }, { findOpen: true }), { type: 'close-find' });
});

test('cross-source shortcut gate suppresses one menu echo without blocking later presses', () => {
  const gate = new CrossSourceShortcutGate(100);
  assert.equal(gate.allow('font-increase', 'renderer', 1000), true);
  assert.equal(gate.allow('font-increase', 'menu', 1005), false);
  assert.equal(gate.allow('font-increase', 'renderer', 1040), true);

  const reverseGate = new CrossSourceShortcutGate(100);
  assert.equal(reverseGate.allow('font-increase', 'menu', 2000), true);
  assert.equal(reverseGate.allow('font-increase', 'renderer', 2002), false);
});

test('initial terminal geometry preserves validated non-default snapshot dimensions', () => {
  assert.deepEqual(initialTerminalGeometry({ cols: 137, rows: 41 }), { cols: 137, rows: 41 });
  assert.throws(() => initialTerminalGeometry({ cols: 0, rows: 41 }), /dimensions/i);
  assert.throws(() => initialTerminalGeometry({ cols: 137, rows: 501 }), /dimensions/i);
});

test('chrome focus is preserved only for a surviving session control identity', () => {
  assert.deepEqual(
    preservedChromeFocus({ sessionId: 'one', action: 'tab-close' }, ['one', 'two']),
    { sessionId: 'one', action: 'tab-close' },
  );
  assert.equal(preservedChromeFocus({ sessionId: 'gone', action: 'tab' }, ['one']), null);
  assert.equal(preservedChromeFocus({ sessionId: 'one', action: 'terminal' }, ['one']), null);
  assert.equal(preservedChromeFocus(null, ['one']), null);
});

test('terminal link activation delegates the exact URI to the restricted bridge', async () => {
  const opened = [];
  const errors = [];
  await openTerminalLink(
    'https://example.com/a?b=1#c',
    async (uri) => { opened.push(uri); },
    (error) => { errors.push(error); },
  );
  assert.deepEqual(opened, ['https://example.com/a?b=1#c']);
  assert.deepEqual(errors, []);
});

test('terminal link activation reports bridge rejection without opening a window', async () => {
  const rejection = new Error('URL protocol must be http or https');
  const errors = [];
  await openTerminalLink('file:///tmp/private', async () => { throw rejection; }, (error) => errors.push(error));
  assert.deepEqual(errors, [rejection]);
});

test('a terminal link is a web page for the Browser pane, or it is refused', async () => {
  assert.equal(browserLink('http://localhost:5173'), 'http://localhost:5173/');
  assert.equal(browserLink('https://example.com/a?b=1#c'), 'https://example.com/a?b=1#c');
  assert.throws(() => browserLink('file:///tmp/private'), /http or https/);
  assert.throws(() => browserLink('javascript:alert(1)'), /http or https/);
  assert.throws(() => browserLink('not a url'), /invalid/);
  const errors = [];
  await openTerminalLink('mailto:a@b.c', (uri) => browserLink(uri), (error) => errors.push(error.message));
  assert.deepEqual(errors, ['URL protocol must be http or https']);
});

test('pending events merge bootstrap history monotonically exactly once', () => {
  const pending = new PendingEvents();
  pending.pushData({ id: 'one', sequence: 3, data: 'third' });
  pending.pushData({ id: 'one', sequence: 2, data: 'second-live' });
  pending.pushData({ id: 'one', sequence: 3, data: 'duplicate' });
  pending.pushExit({ id: 'one', exitCode: 7, signal: 'SIGTERM' });

  const result = pending.take('one', [
    { sequence: 1, data: 'first' },
    { sequence: 2, data: 'second-snapshot' },
  ]);

  assert.deepEqual(result.data, [
    { sequence: 1, data: 'first' },
    { sequence: 2, data: 'second-live' },
    { sequence: 3, data: 'third' },
  ]);
  assert.deepEqual(result.exit, { id: 'one', exitCode: 7, signal: 'SIGTERM' });
  assert.deepEqual(pending.take('one', []).data, []);
});

test('pending event storage is bounded and reports data dropped under overflow', () => {
  const pending = new PendingEvents({ maxEntries: 2, maxBytes: 100 });
  assert.deepEqual(pending.pushData({ id: 'a', sequence: 1, data: 'a' }), []);
  assert.deepEqual(pending.pushData({ id: 'b', sequence: 1, data: 'b' }), []);
  assert.deepEqual(pending.pushData({ id: 'a', sequence: 2, data: 'c' }), [
    { id: 'a', sequence: 1, data: 'a' },
  ]);
  assert.deepEqual(pending.take('a', []).data, [{ sequence: 2, data: 'c' }]);
  assert.deepEqual(pending.take('b', []).data, [{ sequence: 1, data: 'b' }]);
});
