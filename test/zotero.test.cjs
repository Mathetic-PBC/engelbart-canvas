'use strict';

// The Zotero connection (src/main/zotero/connection.cjs) and its browser sign-in (src/main/zotero/browser-auth.cjs)
// against a fake broker (the shape of Mathetic-PBC/landing's api/_lib/zotero-auth.cjs), a fake api.zotero.org and a
// fake keychain, both servers on loopback. The "browser" is this test following the redirects.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { createZotero } = require('../src/main/zotero/connection.cjs');
const { createBrowserAuth } = require('../src/main/zotero/browser-auth.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');

const KEY = 'P9NiFoyLeZu2bZNvvuQPDWsd';
const USER_ID = '475425';

// Everything the process logs while these tests run, so the last test can say none of it held the key.
const logged = [];
for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
  const original = console[level];
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); original.apply(console, args); };
}

const crypt = {
  available: () => true,
  encrypt: (text) => Buffer.from([...text].reverse().join(''), 'utf8').toString('base64'),
  decrypt: (text) => [...Buffer.from(text, 'base64').toString('utf8')].reverse().join(''),
};

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const readBody = (req) => new Promise((resolve) => { let raw = ''; req.on('data', (chunk) => { raw += chunk; }); req.on('end', () => resolve(raw)); });
const json = (res, status, value) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };

/** The broker: start sends the browser to Zotero; Zotero's callback comes back as a ticket (or an error) on loopback. */
async function fakeBroker(t, { callbackError = null, tokenStatus = null } = {}) {
  const seen = { starts: [], tokens: [] };
  const tickets = new Map();
  const base = await serve(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/api/zotero/start') {
      seen.starts.push(Object.fromEntries(url.searchParams));
      res.statusCode = 302; res.setHeader('location', 'https://www.zotero.org/oauth/authorize?oauth_token=request-1'); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/api/zotero/callback') {
      const start = seen.starts[seen.starts.length - 1];
      const local = new URL(`http://127.0.0.1:${start.port}/oauth/zotero/callback`);
      if (callbackError || !url.searchParams.get('oauth_verifier')) local.search = new URLSearchParams({ state: start.state, error: callbackError || 'access_denied' });
      else {
        const ticket = randomBytes(24).toString('base64url');
        tickets.set(ticket, { key: KEY, userID: USER_ID, challenge: start.challenge });
        local.search = new URLSearchParams({ state: start.state, ticket });
      }
      res.statusCode = 302; res.setHeader('location', local.href); return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/zotero/token') {
      const body = JSON.parse(await readBody(req));
      seen.tokens.push(body);
      if (tokenStatus) return json(res, tokenStatus.status, { error: tokenStatus.error });
      const data = tickets.get(body.ticket);
      tickets.delete(body.ticket);
      if (!data) return json(res, 400, { error: 'invalid_ticket' });
      if (createHash('sha256').update(body.verifier).digest('base64url') !== data.challenge) return json(res, 400, { error: 'invalid_verifier' });
      return json(res, 200, { key: data.key, userID: data.userID });
    }
    return json(res, 404, { error: 'not_found' });
  });
  return { base, seen };
}

/** api.zotero.org's /keys/current: who a key belongs to (GET) and revoking it (DELETE). */
async function fakeApi(t, { check = 'ok', revoke = 204 } = {}) {
  const calls = [];
  const base = await serve(t, (req, res) => {
    const key = req.headers['zotero-api-key'];
    calls.push({ method: req.method, path: req.url, key, version: req.headers['zotero-api-version'] });
    if (req.url !== '/keys/current') return json(res, 404, {});
    if (req.method === 'DELETE') { if (revoke === 'offline') return req.socket.destroy(); res.statusCode = revoke; return res.end(); }
    if (check === 'forbidden' || key !== KEY) { res.statusCode = 403; return res.end('Invalid key'); }
    return json(res, 200, { key, userID: check === 'mismatch' ? 1 : Number(USER_ID), username: 'researcher', displayName: 'A Researcher', access: { user: { library: true, files: true, notes: true } } });
  });
  return { base, calls };
}

async function setup(t, { broker: brokerOptions, api: apiOptions, timeoutMs, openAuthorize, file } = {}) {
  const broker = await fakeBroker(t, brokerOptions);
  const zoteroApi = await fakeApi(t, apiOptions);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-zotero-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [], changes = [];
  let connected = 0;
  const auth = createBrowserAuth({ broker: broker.base, ...(timeoutMs ? { timeoutMs } : {}) });
  const zotero = createZotero({
    file: file || path.join(dir, 'zotero.json'),
    crypt,
    browserAuth: () => auth,
    openAuthorize: openAuthorize || ((url) => { opened.push(url); }),
    onConnected: () => { connected += 1; },
    onChange: (status) => changes.push(status),
    api: zoteroApi.base,
  });
  t.after(() => zotero.cancel());
  return { zotero, broker, api: zoteroApi, opened, changes, connected: () => connected, file: file || path.join(dir, 'zotero.json'), dir };
}

/** The person's browser: the broker's start, Zotero's authorize page (approved, or denied), the broker's callback, loopback. */
async function browse(broker, startUrl, { approve = true } = {}) {
  const start = await fetch(startUrl, { redirect: 'manual' });
  assert.equal(start.status, 302);
  assert.match(start.headers.get('location'), /^https:\/\/www\.zotero\.org\/oauth\/authorize/);
  const back = await fetch(`${broker.base}/api/zotero/callback?oauth_token=request-1${approve ? '&oauth_verifier=approved' : ''}`, { redirect: 'manual' });
  assert.equal(back.status, 302);
  const local = back.headers.get('location');
  assert.match(local, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/zotero\/callback\?state=/);
  const page = await fetch(local);
  return { status: page.status, html: await page.text() };
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return; await new Promise((resolve) => { setTimeout(resolve, 5); }); }
  throw new Error('never settled');
}

const portOf = (url) => new URL(url).searchParams.get('port');

test('sign-in: broker start with loopback port, state and PKCE challenge; the ticket redeemed with the verifier; the key checked, kept encrypted, the username shown', async (t) => {
  const { zotero, broker, api, opened, changes, connected, file } = await setup(t);
  assert.deepEqual(zotero.status(), { configured: true, connected: false, username: '', userID: '', persisted: true, pending: null, error: '' });
  const waiting = await zotero.connect();
  assert.equal(waiting.connected, false);
  assert.equal(waiting.pending.kind, 'browser');
  assert.ok(waiting.pending.expiresAt > Date.now() + 9 * 60_000, 'ten minutes to finish');
  assert.equal(opened.length, 1, 'the start page, in the default browser');
  const start = new URL(opened[0]);
  assert.equal(`${start.origin}${start.pathname}`, `${broker.base}/api/zotero/start`);
  assert.match(start.searchParams.get('state'), /^[A-Za-z0-9_-]{43}$/);
  assert.match(start.searchParams.get('challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Number(portOf(opened[0])) >= 1024);

  const page = await browse(broker, opened[0]);
  assert.equal(page.status, 200);
  assert.match(page.html, /Zotero connected/);
  assert.ok(!page.html.includes(KEY), 'the loopback page never shows the key');
  await until(() => zotero.status().connected);

  assert.equal(broker.seen.tokens.length, 1);
  assert.equal(createHash('sha256').update(broker.seen.tokens[0].verifier).digest('base64url'), start.searchParams.get('challenge'), 'the verifier answers the challenge');
  assert.deepEqual(api.calls, [{ method: 'GET', path: '/keys/current', key: KEY, version: '3' }], 'the key is checked with Zotero-API-Key, once');
  const status = zotero.status();
  assert.deepEqual(status, { configured: true, connected: true, username: 'researcher', userID: USER_ID, persisted: true, pending: null, error: '' });
  assert.equal(connected(), 1);
  assert.equal(zotero.key(), KEY, 'main can still use the key');

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(saved).sort(), ['key', 'userID', 'username', 'v']);
  assert.equal(saved.userID, USER_ID);
  assert.equal(saved.username, 'researcher');
  assert.notEqual(saved.key, KEY);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY), 'the key is encrypted on disk');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows has no such modes
  for (const change of changes) assert.ok(!JSON.stringify(change).includes(KEY), 'no status sent to the window carries the key');

  // A new launch reads the file: still connected, nothing to refresh, no request to Zotero.
  const again = createZotero({ file, crypt, browserAuth: () => null, api: api.base });
  assert.equal(again.status().connected, true);
  assert.equal(again.status().username, 'researcher');
  assert.equal(again.key(), KEY);
  assert.equal(api.calls.length, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${portOf(opened[0])}/`), 'the loopback listener is closed once signed in');
});

test('a callback with the wrong state is refused and the sign-in keeps waiting; one from another origin too', async (t) => {
  const { zotero, broker, opened } = await setup(t);
  await zotero.connect();
  const local = new URL(`http://127.0.0.1:${portOf(opened[0])}/oauth/zotero/callback`);
  local.search = new URLSearchParams({ state: 'x'.repeat(43), ticket: 'forged' });
  assert.equal((await fetch(local)).status, 400);
  local.searchParams.set('state', new URL(opened[0]).searchParams.get('state'));
  assert.equal((await fetch(local, { headers: { origin: 'https://evil.example' } })).status, 403);
  local.searchParams.delete('ticket');
  assert.equal((await fetch(local)).status, 400, 'no ticket, no exchange');
  assert.equal(broker.seen.tokens.length, 0, 'nothing reached the broker');
  assert.equal(zotero.status().pending.kind, 'browser');
  assert.equal(zotero.status().error, '');
  await browse(broker, opened[0]);
  await until(() => zotero.status().connected);
});

for (const [code, message] of [
  ['access_denied', /Cancelled on Zotero/],
  ['authorization_failed', /did not authorize/],
  ['upstream_unavailable', /could not be reached/],
]) {
  test(`the broker's ${code} ends the sign-in with its message, and keeps nothing`, async (t) => {
    const { zotero, broker, api, opened, file } = await setup(t, { broker: { callbackError: code } });
    await zotero.connect();
    const page = await browse(broker, opened[0], { approve: code !== 'access_denied' });
    assert.equal(page.status, 200);
    await until(() => !zotero.status().pending);
    const status = zotero.status();
    assert.equal(status.connected, false);
    assert.match(status.error, message);
    assert.equal(broker.seen.tokens.length, 0);
    assert.equal(api.calls.length, 0);
    assert.equal(fs.existsSync(file), false);
    await assert.rejects(fetch(`http://127.0.0.1:${portOf(opened[0])}/`), 'the listener stops');
  });
}

for (const [label, tokenStatus, message] of [
  ['an expired ticket', { status: 400, error: 'invalid_ticket' }, /expired/],
  ['a verifier the broker refuses', { status: 400, error: 'invalid_verifier' }, /could not be verified/],
  ['a broker that is down', { status: 503, error: 'not_configured' }, /service is unavailable/],
]) {
  test(`redeeming the ticket: ${label} is reported`, async (t) => {
    const { zotero, broker, api, opened } = await setup(t, { broker: { tokenStatus } });
    await zotero.connect();
    const page = await browse(broker, opened[0]);
    assert.equal(page.status, 502);
    await until(() => !zotero.status().pending);
    assert.match(zotero.status().error, message);
    assert.equal(zotero.status().connected, false);
    assert.equal(api.calls.length, 0);
  });
}

test('a key Zotero will not vouch for (refused, or another user\'s) is not kept, and is revoked', async (t) => {
  for (const check of ['forbidden', 'mismatch']) {
    const { zotero, broker, api, opened, file } = await setup(t, { api: { check } });
    await zotero.connect();
    await browse(broker, opened[0]);
    await until(() => !zotero.status().pending);
    assert.equal(zotero.status().connected, false);
    assert.match(zotero.status().error, /did not accept/);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(api.calls.map((call) => call.method), ['GET', 'DELETE']);
    assert.ok(!zotero.status().error.includes(KEY));
  }
});

test('the sign-in times out: its error shows and the listener stops', async (t) => {
  const { zotero, opened } = await setup(t, { timeoutMs: 40 });
  await zotero.connect();
  await until(() => !zotero.status().pending);
  assert.match(zotero.status().error, /expired/);
  assert.equal(zotero.status().connected, false);
  await assert.rejects(fetch(`http://127.0.0.1:${portOf(opened[0])}/`));
});

test('the default sign-in waits ten minutes', async () => {
  const flow = await createBrowserAuth().start();
  try {
    assert.ok(Math.abs(flow.expiresAt - Date.now() - 600_000) < 2000);
    assert.equal(new URL(flow.url).origin, 'https://engelbart.mathetic.com');
    assert.equal(new URL(flow.url).pathname, '/api/zotero/start');
  } finally { flow.cancel(); }
  await assert.rejects(flow.result, /cancelled/);
  assert.throws(() => createBrowserAuth({ broker: 'http://broker.example' }), /HTTPS/);
});

test('Cancel stops the listener, shows no error, and a late callback changes nothing', async (t) => {
  const { zotero, broker, opened, changes } = await setup(t);
  await zotero.connect();
  const cancelled = zotero.cancel();
  assert.equal(cancelled.pending, null);
  assert.equal(cancelled.error, '');
  assert.equal(changes[changes.length - 1].pending, null);
  await assert.rejects(fetch(`http://127.0.0.1:${portOf(opened[0])}/oauth/zotero/callback?state=${new URL(opened[0]).searchParams.get('state')}&ticket=late`));
  assert.equal(broker.seen.tokens.length, 0);
  assert.equal(zotero.status().connected, false);
});

test('Connect while a sign-in waits opens the same page again, not a second sign-in', async (t) => {
  const { zotero, broker, opened } = await setup(t);
  await zotero.connect();
  await zotero.connect();
  assert.equal(opened.length, 2);
  assert.equal(opened[0], opened[1]);
  await browse(broker, opened[1]);
  await until(() => zotero.status().connected);
});

test('a browser that will not open cancels the sign-in and says so', async (t) => {
  const { zotero } = await setup(t, { openAuthorize: () => { throw new Error('no browser'); } });
  await assert.rejects(zotero.connect(), /no browser/);
  assert.equal(zotero.status().pending, null);
  assert.match(zotero.status().error, /Could not open your browser/);
});

test('Disconnect deletes zotero.json and revokes the key; a revoke that fails still disconnects', async (t) => {
  for (const revoke of [204, 500, 'offline']) {
    const { zotero, broker, api, opened, file, changes } = await setup(t, { api: { revoke } });
    await zotero.connect();
    await browse(broker, opened[0]);
    await until(() => zotero.status().connected);
    const status = await zotero.disconnect();
    assert.equal(status.connected, false);
    assert.equal(status.username, '');
    assert.equal(status.error, '');
    assert.equal(fs.existsSync(file), false);
    assert.equal(zotero.key(), null);
    assert.equal(changes[changes.length - 1].connected, false);
    assert.deepEqual(api.calls.slice(1), [{ method: 'DELETE', path: '/keys/current', key: KEY, version: '3' }]);
  }
});

test('zotero-browser.json is left alone; a file from another keychain reads as signed out', async (t) => {
  const { zotero, dir, file } = await setup(t);
  const old = path.join(dir, 'zotero-browser.json');
  fs.writeFileSync(old, '{"cookie":"old"}');
  fs.writeFileSync(file, JSON.stringify({ v: 1, userID: USER_ID, username: 'researcher', key: 'not ours' }));
  const other = createZotero({ file, crypt: { available: () => true, encrypt: () => '', decrypt: () => { throw new Error('other keychain'); } } });
  assert.equal(other.status().connected, false);
  await zotero.disconnect();
  assert.equal(fs.readFileSync(old, 'utf8'), '{"cookie":"old"}');
});

test('without a keychain the key lives only until Engelbart quits', async (t) => {
  const broker = await fakeBroker(t);
  const api = await fakeApi(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-zotero-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opened = [];
  const zotero = createZotero({ file: path.join(dir, 'zotero.json'), browserAuth: () => createBrowserAuth({ broker: broker.base }), openAuthorize: (url) => opened.push(url), api: api.base });
  await zotero.connect();
  await browse(broker, opened[0]);
  await until(() => zotero.status().connected);
  assert.equal(zotero.status().persisted, false);
  assert.equal(fs.existsSync(path.join(dir, 'zotero.json')), false);
});

test('IPC: zotero status / connect / cancel / disconnect answer the status, and none carries the key', async (t) => {
  const { zotero, broker, opened } = await setup(t);
  const handlers = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, zotero });
  const call = (name) => handlers.get(`engelbart:${name}`)({});
  const answers = [];
  answers.push(await call('zotero-status'));
  answers.push(await call('zotero-connect'));
  answers.push(await call('zotero-cancel'));
  answers.push(await call('zotero-connect'));
  await browse(broker, opened[opened.length - 1]);
  await until(() => zotero.status().connected);
  answers.push(await call('zotero-status'));
  assert.equal(answers[answers.length - 1].username, 'researcher');
  answers.push(await call('zotero-disconnect'));
  assert.equal(answers[answers.length - 1].connected, false);
  for (const answer of answers) assert.ok(!JSON.stringify(answer).includes(KEY));
  assert.ok(![...handlers.keys()].some((name) => /zotero-key/.test(name)), 'no channel hands out the key');

  const bare = new Map();
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => bare.set(name, fn) }, trustedHandler: (fn) => fn });
  assert.deepEqual(await bare.get('engelbart:zotero-status')({}), { configured: false, connected: false, username: '', userID: '', persisted: true, pending: null, error: '', sync: null });
  await assert.rejects(async () => bare.get('engelbart:zotero-connect')({}), /not available/);
});

test('the preload bridges the four calls and the change channel, and nothing named for the key', () => {
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.cjs'), 'utf8');
  for (const [name, channel] of [['zoteroStatus', 'zotero-status'], ['zoteroConnect', 'zotero-connect'], ['zoteroCancel', 'zotero-cancel'], ['zoteroDisconnect', 'zotero-disconnect']]) {
    assert.match(preload, new RegExp(`${name}: invoke\\('${channel}'\\)`));
  }
  assert.match(preload, /onZotero: \(callback\) => subscribe\('engelbart:zotero', callback\)/);
  assert.doesNotMatch(preload, /zoteroKey|zotero-key/);
});

test('nothing logged during these tests held the key', () => {
  assert.ok(!logged.some((line) => line.includes(KEY)));
  const sources = ['connection.cjs', 'browser-auth.cjs'].map((name) => fs.readFileSync(path.join(__dirname, '../src/main/zotero', name), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /console\./, 'the Zotero modules log nothing');
});
