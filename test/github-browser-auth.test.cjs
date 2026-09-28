'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createBrowserAuth } = require('../src/main/github/browser-auth.cjs');

test('browser authorization uses PKCE, loopback and state; no copying or tokens in callback', async t => {
  let exchanged;
  const auth = createBrowserAuth({ fetch: async (url, init) => {
    exchanged = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ access_token: 'ghu_test' }) };
  } });
  const flow = await auth.start();
  t.after(() => flow.cancel());
  const authorize = new URL(flow.url);
  assert.equal(authorize.origin, 'https://engelbart.mathetic.com');
  const local = new URL(`http://127.0.0.1:${authorize.searchParams.get('port')}/oauth/github/callback`);
  local.search = new URLSearchParams({ state: 'wrong', code: 'test', ticket: 'ticket' });
  assert.equal((await fetch(local)).status, 400);
  local.searchParams.set('state', authorize.searchParams.get('state'));
  assert.equal((await fetch(local, { headers: { origin: 'https://evil.example' } })).status, 403);
  const response = await fetch(local);
  assert.equal(response.status, 200);
  assert.equal((await flow.result).access_token, 'ghu_test');
  assert.equal(createHash('sha256').update(exchanged.verifier).digest('base64url'), authorize.searchParams.get('challenge'));
  assert.equal(exchanged.code, 'test');
  assert.ok(!(await response.text()).includes('ghu_'));
});

test('late browser requests after completion retain the original Host check without a closed-listener error', async t => {
  const http = require('node:http');
  const { EventEmitter } = require('node:events');
  let receive;
  const server = new EventEmitter();
  let listening = false;
  server.listen = (_port, _host, ready) => { listening = true; ready(); };
  server.address = () => listening ? { port: 45123 } : null;
  server.close = () => { listening = false; };
  t.mock.method(http, 'createServer', handler => { receive = handler; return server; });
  const flow = await createBrowserAuth({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ access_token: 'fixture-token' }) }) }).start();
  t.after(() => flow.cancel());
  const state = new URL(flow.url).searchParams.get('state');
  const request = async (url, headers = {}) => {
    const response = { statusCode: null, body: '', setHeader() {}, end(body) { this.body = body; } };
    await receive({ method: 'GET', url, headers: { host: '127.0.0.1:45123', ...headers } }, response);
    return response;
  };
  assert.equal((await request(`/oauth/github/callback?state=${state}&code=test&ticket=test`)).statusCode, 200);
  await flow.result;
  assert.equal(server.address(), null);
  assert.equal((await request('/favicon.ico')).statusCode, 400);
  assert.equal((await request(`/oauth/github/callback?state=${state}&code=test&ticket=test`)).statusCode, 409);
  assert.equal((await request('/favicon.ico', { host: 'attacker.example' })).statusCode, 403);
});
test('cancellation and timeout close the callback listener; broker error is reported', async t => {
  const auth = createBrowserAuth();
  const flow = await auth.start();
  const rejected = assert.rejects(flow.result, /cancel/i);
  flow.cancel(); await rejected;
  await assert.rejects(fetch(`http://127.0.0.1:${new URL(flow.url).searchParams.get('port')}/`));
  const expired = await createBrowserAuth({ timeoutMs: 20 }).start();
  await assert.rejects(expired.result, /expired/i);
  const denied = await auth.start(); t.after(() => denied.cancel());
  const url = new URL(denied.url);
  const failure = assert.rejects(denied.result, /cancel/i);
  const response = await fetch(`http://127.0.0.1:${url.searchParams.get('port')}/oauth/github/callback?state=${url.searchParams.get('state')}&error=access_denied`);
  assert.equal(response.status, 200); await failure;
});
