'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { assertTrustedRenderer, parseExternalUrl } = require('../src/main/ipc-validation.cjs');

const TRUSTED = 'engelbart://app/index.html';

function eventFor(url, { subframe = false } = {}) {
  const mainFrame = { url };
  return { sender: { mainFrame }, senderFrame: subframe ? { url } : mainFrame };
}

test('assertTrustedRenderer accepts the app page, with or without query/hash', () => {
  assert.doesNotThrow(() => assertTrustedRenderer(eventFor(TRUSTED), TRUSTED));
  assert.doesNotThrow(() => assertTrustedRenderer(eventFor(`${TRUSTED}?x=1#y`), TRUSTED));
});

test('assertTrustedRenderer rejects other origins, subframes and file URLs', () => {
  assert.throws(() => assertTrustedRenderer(eventFor('https://claude.ai/index.html'), TRUSTED), /untrusted renderer/);
  assert.throws(() => assertTrustedRenderer(eventFor('engelbart://evil/index.html'), TRUSTED), /untrusted renderer/);
  assert.throws(() => assertTrustedRenderer(eventFor('engelbart://app/other.html'), TRUSTED), /untrusted renderer/);
  assert.throws(() => assertTrustedRenderer(eventFor('file:///Users/x/dist/index.html'), TRUSTED), /untrusted renderer/);
  assert.throws(() => assertTrustedRenderer(eventFor(TRUSTED, { subframe: true }), TRUSTED), /untrusted renderer/);
  assert.throws(() => assertTrustedRenderer(null, TRUSTED), /untrusted renderer/);
});

test('parseExternalUrl only allows bounded http(s) URLs', () => {
  assert.equal(parseExternalUrl('https://example.com/a').href, 'https://example.com/a');
  assert.throws(() => parseExternalUrl('javascript:alert(1)'), TypeError);
  assert.throws(() => parseExternalUrl('file:///etc/passwd'), TypeError);
  assert.throws(() => parseExternalUrl(''), TypeError);
  assert.throws(() => parseExternalUrl('x'.repeat(5000)), TypeError);
});
