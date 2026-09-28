'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const http = require('node:http');
const { createGoogleAuth, SCOPE } = require('../src/main/google/auth.cjs');

const credentials = { clientId: 'test.apps.googleusercontent.com', clientSecret: 'desktop-registration' };
const response = (status, data) => ({ ok: status === 200, status, json: async () => data });
const callback = flow => {
  const auth = new URL(flow.url), url = new URL(auth.searchParams.get('redirect_uri'));
  url.search = new URLSearchParams({ state: auth.searchParams.get('state'), code: 'one-use-code' });
  return url;
};

test('Google desktop auth uses metadata-only scope, PKCE, state, loopback and no token in browser', async t => {
  const calls = [];
  const auth = createGoogleAuth({ fetch: async (url, init) => {
    calls.push({ url: url.href, form: Object.fromEntries(new URLSearchParams(init.body)) });
    return response(200, { access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, scope: SCOPE });
  } });
  const flow = await auth.start(credentials); t.after(flow.cancel);
  const authorize = new URL(flow.url), url = callback(flow);
  assert.equal(authorize.origin, 'https://accounts.google.com');
  assert.equal(authorize.searchParams.get('scope'), SCOPE);
  assert.equal(authorize.searchParams.get('access_type'), 'offline');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(!flow.url.includes(credentials.clientSecret));
  const state = url.searchParams.get('state');
  url.searchParams.set('state', 'bad');
  assert.equal((await fetch(url)).status, 400);
  url.searchParams.set('state', state);
  assert.equal((await fetch(url, { headers: { Origin: 'https://bad.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'bad.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHost, 403);
  url.searchParams.append('code', 'duplicate');
  assert.equal((await fetch(url)).status, 400);
  url.searchParams.set('code', 'one-use-code');
  const result = await fetch(url);
  assert.equal(result.status, 200);
  assert.doesNotMatch(await result.text(), /secret-access|secret-refresh|one-use-code/);
  assert.equal((await flow.result).refresh, 'secret-refresh');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].form.client_secret, credentials.clientSecret);
  assert.equal(calls[0].form.redirect_uri, authorize.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(calls[0].form.code_verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
});

test('cancel, consent denial and timeout close the callback listener', async t => {
  const flow = await createGoogleAuth().start(credentials);
  flow.cancel(); await assert.rejects(flow.result, /cancelled/);
  await assert.rejects(fetch(callback(flow)));
  const expired = await createGoogleAuth({ timeoutMs: 20 }).start(credentials);
  await assert.rejects(expired.result, /expired/);
  const denied = await createGoogleAuth().start(credentials); t.after(denied.cancel);
  const url = callback(denied); url.searchParams.set('error', 'access_denied');
  assert.equal((await fetch(url)).status, 200);
  await assert.rejects(denied.result, /not approved/);
});

test('cancellation during token exchange cannot return a late token', async t => {
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  const flow = await createGoogleAuth({ fetch: () => { started(); return new Promise(resolve => { finish = resolve; }); } }).start(credentials);
  t.after(flow.cancel);
  const call = fetch(callback(flow)); await ready;
  flow.cancel(); await assert.rejects(flow.result, /cancelled/);
  finish(response(200, { access_token: 'late', expires_in: 3600 }));
  assert.equal((await call).status, 410);
});

test('refresh uses form credentials, reports revoked grants and refuses insufficient scopes', async () => {
  const seen = [];
  const auth = createGoogleAuth({ fetch: async (_url, init) => {
    seen.push(Object.fromEntries(new URLSearchParams(init.body)));
    return response(400, { error: 'invalid_grant', error_description: 'Do not expose upstream detail' });
  } });
  await assert.rejects(auth.refresh(credentials, 'refresh'), { code: 'invalid_grant' });
  assert.equal(seen[0].grant_type, 'refresh_token');
  assert.equal(seen[0].refresh_token, 'refresh');
  const refused = createGoogleAuth({ fetch: async () => response(200, { access_token: 'test', expires_in: 3600, scope: 'email' }) });
  await assert.rejects(refused.refresh(credentials, 'refresh'), { code: 'scope' });
  assert.throws(() => createGoogleAuth({ tokenUrl: 'http://remote.example/token' }), /HTTPS/);
});
