'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { pasteDeviceCode } = require('../src/main/github/paste.cjs');

// Execute the actual page script with GitHub's observed eight inputs, not a stubbed success response.
function page(url = 'https://github.com/login/device') {
  class Input {
    constructor(id) { this.id = id; this.type = 'text'; this.maxLength = 1; this.disabled = false; this.readOnly = false; this.events = []; }
    set value(v) { this.stored = v; }
    get value() { return this.stored || ''; }
    getClientRects() { return [{}]; }
    dispatchEvent(e) { this.events.push(e.type); }
    focus() { this.focused = true; }
  }
  const fields = [0, 1, 2, 3, 5, 6, 7, 8].map((i) => new Input(`user-code-${i}`));
  const context = { location: new URL(url), HTMLInputElement: Input, Event: class { constructor(type) { this.type = type; } }, document: { getElementById: (id) => fields.find((f) => f.id === id) } };
  const contents = { isDestroyed: () => false, getURL: () => url, focus() {}, executeJavaScript: async (script) => vm.runInNewContext(script, context) };
  return { fields, context, contents };
}
const pending = { userCode: 'ABCD-EFGH', verificationUri: 'https://github.com/login/device' };

test('one click fills all eight device code boxes without submitting or touching other fields', async () => {
  const p = page();
  assert.equal(await pasteDeviceCode(p.contents, pending), true);
  assert.equal(p.fields.map((f) => f.value).join(''), 'ABCDEFGH');
  assert.ok(p.fields.every((f) => f.events.includes('input') && f.events.includes('change')));
  assert.equal(p.fields.at(-1).focused, true);
});

test('paste refuses login, lookalike origins, missing fields, and navigation during the request', async () => {
  for (const url of ['https://github.com/login', 'https://github.com.evil.test/login/device', 'http://github.com/login/device']) {
    const p = page(url);
    assert.equal(await pasteDeviceCode(p.contents, pending), false);
    assert.ok(p.fields.every((f) => !f.value));
  }
  const partial = page();
  partial.fields.pop();
  assert.equal(await pasteDeviceCode(partial.contents, pending), false);
  assert.ok(partial.fields.every((f) => !f.value));
  const navigated = page();
  navigated.context.location = new URL('https://example.com/login/device');
  assert.equal(await pasteDeviceCode(navigated.contents, pending), false);
  assert.ok(navigated.fields.every((f) => !f.value));
});

test('only a valid pending user code can be pasted', async () => {
  for (const userCode of ['', 'x', 'ghu_secret', 'ABCD-EFGHI']) {
    const p = page();
    await assert.rejects(pasteDeviceCode(p.contents, { ...pending, userCode }), /code/i);
    assert.ok(p.fields.every((f) => !f.value));
  }
});
