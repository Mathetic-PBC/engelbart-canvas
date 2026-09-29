'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createE2bKey } = require('../src/main/github/e2b-key.cjs');

function fixture({ answers = [{ status: 200, body: { e2bApiKey: 'e2b_test' } }] } = {}) {
  const sent = [];
  const account = { token: 'ghu_test' };
  let release = () => {};
  const gate = { hold: false };
  const key = createE2bKey({ github: { token: async () => account.token }, version: '1.2.3', fetch: async (url, init) => {
    sent.push({ url: String(url), init });
    if (gate.hold) await new Promise((resolve) => { release = resolve; });
    const answer = answers[Math.min(sent.length - 1, answers.length - 1)];
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, json: async () => answer.body };
  } });
  return { key, sent, account, gate, release: () => release() };
}

test('asks mathetic.com with the GitHub token and client label; callers at the same time share one request', async () => {
  const f = fixture();
  f.gate.hold = true;
  const both = Promise.all([f.key.get(), f.key.get()]);
  await new Promise((resolve) => { setImmediate(resolve); });
  f.release();
  assert.deepEqual(await both, ['e2b_test', 'e2b_test']);
  assert.equal(await f.key.get(), 'e2b_test');
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].url, 'https://mathetic.com/api/e2b/key');
  assert.equal(f.sent[0].init.method, 'POST');
  assert.equal(f.sent[0].init.redirect, 'error');
  assert.deepEqual(f.sent[0].init.headers, { authorization: 'Bearer ghu_test', 'x-engelbart-client': 'engelbart-desktop/1.2.3' });
});

test('signed out answers null without asking, even with a key cached; forget() makes the next call ask again', async () => {
  const f = fixture();
  assert.equal(await f.key.get(), 'e2b_test');
  f.account.token = null;
  assert.equal(await f.key.get(), null);
  assert.equal(f.sent.length, 1);
  f.account.token = 'ghu_test';
  assert.equal(await f.key.get(), 'e2b_test');
  assert.equal(f.sent.length, 2);
  f.key.forget();
  assert.equal(await f.key.get(), 'e2b_test');
  assert.equal(f.sent.length, 3);
});

test('a failed or malformed answer is not kept, and its error carries neither token nor key', async () => {
  const f = fixture({ answers: [{ status: 401, body: { error: 'invalid_token' } }, { status: 200, body: {} }, { status: 200, body: { e2bApiKey: 'e2b_test' } }] });
  const refused = await f.key.get().catch((error) => error);
  assert.match(refused.message, /401/);
  assert.ok(!refused.message.includes('ghu_'));
  await assert.rejects(f.key.get(), /no key/);
  assert.equal(await f.key.get(), 'e2b_test');
  assert.equal(f.sent.length, 3);
});

test('refuses a host that is neither HTTPS nor loopback', () => {
  const github = { token: async () => 'ghu_test' };
  assert.throws(() => createE2bKey({ github, version: '1.2.3', host: 'http://mathetic.com' }), /HTTPS/);
  assert.doesNotThrow(() => createE2bKey({ github, version: '1.2.3', host: 'http://127.0.0.1:3000' }));
});
