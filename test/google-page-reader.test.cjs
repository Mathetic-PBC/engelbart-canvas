'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readPage } = require('../src/main/google/page-reader.cjs');
const origin = 'https://drive.google.com';
function page() {
  return Object.assign(new EventEmitter(), {
    mainFrame: {}, isDestroyed: () => false,
    send(channel, request) { this.request = { channel, ...request }; },
  });
}
test('only the requested top frame and request ID can supply Drive metadata', async () => {
  const p = page(), reading = readPage(p, null, false, origin);
  const reply = { kind: 'account', account: { id: 'reader@example.com' } };
  assert.equal(p.request.channel, 'google:read-listing');
  p.emit('ipc-message', { senderFrame: {} }, 'google:listing', p.request.id, { kind: 'wrong-frame' });
  p.emit('ipc-message', { senderFrame: p.mainFrame }, 'google:listing', 'wrong-id', { kind: 'wrong-request' });
  p.emit('ipc-message', { senderFrame: p.mainFrame }, 'google:listing', p.request.id, reply);
  assert.deepEqual(await reading, reply);
  assert.equal(p.listenerCount('ipc-message'), 0); assert.equal(p.listenerCount('destroyed'), 0);
});
test('unresponsive, closed, and aborted Drive pages cannot leave reads pending', async () => {
  const p = page();
  assert.equal((await readPage(p, null, false, origin, { timeoutMs: 5 })).kind, 'unavailable');
  const abort = new AbortController(), pending = readPage(p, null, false, origin, { signal: abort.signal });
  abort.abort(); assert.equal((await pending).kind, 'unavailable');
  const closed = readPage(p, null, false, origin); p.emit('destroyed');
  assert.equal((await closed).kind, 'unavailable');
  assert.equal(p.listenerCount('ipc-message'), 0); assert.equal(p.listenerCount('destroyed'), 0);
});
