const test = require('node:test');
const assert = require('node:assert/strict');

const { RendererLifecycle, shouldHideWindowOnClose } = require('../src/main/terminal/window-lifecycle.cjs');

function fakeWindow(send = () => {}) {
  return {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send,
    },
  };
}

test('macOS close hides the live window until confirmed application quit', () => {
  assert.equal(shouldHideWindowOnClose('darwin', false), true);
  assert.equal(shouldHideWindowOnClose('darwin', true), false);
  assert.equal(shouldHideWindowOnClose('linux', false), false);
});

test('renderer output remains gated until trusted bootstrap and after detach', () => {
  const calls = [];
  const manager = {
    attachRenderer: () => calls.push('attach'),
    detachRenderer: () => calls.push('detach'),
  };
  const lifecycle = new RendererLifecycle(manager);
  const window = fakeWindow((_channel, payload) => calls.push(payload));

  assert.equal(lifecycle.send(window, 'terminal:data', 'before'), false);
  const snapshot = lifecycle.bootstrap(() => {
    assert.equal(lifecycle.send(window, 'terminal:data', 'during-snapshot'), true);
    return ['snapshot'];
  });
  assert.deepEqual(snapshot, ['snapshot']);
  assert.deepEqual(calls, ['attach', 'during-snapshot']);

  lifecycle.detach();
  assert.equal(lifecycle.send(window, 'terminal:data', 'after'), false);
  assert.deepEqual(calls, ['attach', 'during-snapshot', 'detach']);
});

test('renderer send failure detaches flow control and blocks later sends', () => {
  let detachCount = 0;
  const lifecycle = new RendererLifecycle({
    attachRenderer() {},
    detachRenderer() { detachCount += 1; },
  });
  lifecycle.bootstrap(() => null);
  const brokenWindow = fakeWindow(() => { throw new Error('renderer destroyed concurrently'); });

  assert.equal(lifecycle.send(brokenWindow, 'terminal:data', { data: 'x' }), false);
  assert.equal(lifecycle.ready, false);
  assert.equal(detachCount, 1);
  assert.equal(lifecycle.send(fakeWindow(), 'terminal:data', { data: 'later' }), false);
});

test('destroyed renderer discovered during send detaches flow control', () => {
  let detachCount = 0;
  const lifecycle = new RendererLifecycle({
    attachRenderer() {},
    detachRenderer() { detachCount += 1; },
  });
  lifecycle.bootstrap(() => null);
  const destroyedWindow = {
    isDestroyed: () => true,
    webContents: { isDestroyed: () => true, send() {} },
  };

  assert.equal(lifecycle.send(destroyedWindow, 'terminal:exit', {}), false);
  assert.equal(lifecycle.ready, false);
  assert.equal(detachCount, 1);
});

test('bootstrap failure returns the manager to detached mode', () => {
  let detachCount = 0;
  const lifecycle = new RendererLifecycle({
    attachRenderer() {},
    detachRenderer() { detachCount += 1; },
  });

  assert.throws(() => lifecycle.bootstrap(() => { throw new Error('snapshot failed'); }), /snapshot failed/);
  assert.equal(lifecycle.ready, false);
  assert.equal(detachCount, 1);
});
