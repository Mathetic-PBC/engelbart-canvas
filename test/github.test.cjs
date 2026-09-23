'use strict';

// The GitHub connection (src/main/github/connection.cjs) against a fake GitHub, a fake keychain and a fake clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createGithub } = require('../src/main/github/connection.cjs');
const { createRepoIdentifier, createRemoteFileLister } = require('../src/main/store/page-meta.cjs');

const CLIENT = 'Iv23liTestClient0001';
const crypt = {
  available: () => true,
  encrypt: (text) => Buffer.from([...text].reverse().join(''), 'utf8').toString('base64'),
  decrypt: (text) => [...Buffer.from(text, 'base64').toString('utf8')].reverse().join(''),
};
const reply = (status, data, headers = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => data, headers: { get: (name) => headers[name.toLowerCase()] ?? null } });

/** A GitHub that answers the device flow and the API from `script`, recording every request. */
function fakeGithub(script) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const form = init.body ? Object.fromEntries(new URLSearchParams(init.body)) : null;
    calls.push({ url, method: init.method || 'GET', form, auth: (init.headers || {}).authorization || null });
    return script({ url, form, auth: (init.headers || {}).authorization || null, calls });
  };
  return { fetch, calls };
}

function setup(script, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-github-'));
  const clock = { t: 1_000_000 };
  const opened = [], closed = [], changes = [];
  const gh = fakeGithub(script);
  const github = createGithub({
    fetch: gh.fetch,
    settings: () => ({ clientId: CLIENT, appSlug: 'engelbart-mathetic' }),
    file: path.join(dir, 'github.json'),
    crypt,
    openVerification: (url) => opened.push(url),
    closeVerification: () => closed.push(true),
    onChange: (status) => changes.push(status),
    now: () => clock.t,
    sleep: async (ms) => { clock.t += ms; },
    ...extra,
  });
  return { github, dir, clock, opened, closed, changes, calls: gh.calls, file: path.join(dir, 'github.json'), fetch: gh.fetch };
}

const settle = () => new Promise((resolve) => { setImmediate(resolve); });
async function until(check, tries = 200) { for (let i = 0; i < tries; i += 1) { if (check()) return; await settle(); } throw new Error('never settled'); }

const user = reply(200, { login: 'hudsonmp', name: 'Hudson', avatar_url: 'https://avatars.githubusercontent.com/u/1', id: 7 });

test('device flow: a code, the window, waiting (and slowing down when told), then a token kept encrypted; no client secret anywhere', async () => {
  let polls = 0;
  const { github, opened, closed, changes, calls, file, dir } = setup(({ url, form }) => {
    if (url.endsWith('/login/device/code')) return reply(200, { device_code: 'dev-1', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (url.endsWith('/login/oauth/access_token')) {
      polls += 1;
      if (polls === 1) return reply(200, { error: 'authorization_pending' });
      if (polls === 2) return reply(200, { error: 'slow_down', interval: 10 });
      return reply(200, { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first', refresh_token_expires_in: 15897600, token_type: 'bearer' });
    }
    if (url.endsWith('/user')) return user;
    return reply(404, {});
  });
  const started = await github.connect();
  assert.deepEqual([started.pending.userCode, started.connected], ['WDJB-MJHT', false]);
  assert.deepEqual(opened, ['https://github.com/login/device'], 'the window opens on GitHub\'s device page');
  await until(() => github.status().connected);
  const status = github.status();
  assert.deepEqual([status.login, status.name, status.pending, status.error, status.persisted], ['hudsonmp', 'Hudson', null, '', true]);
  assert.equal(closed.length, 1, 'the window closes once the token has come');
  assert.equal(changes.at(-1).connected, true);
  assert.equal(status.installUrl, 'https://github.com/apps/engelbart-mathetic/installations/new');
  const polled = calls.filter((call) => call.url.endsWith('/access_token'));
  assert.equal(polled.length, 3);
  assert.ok(polled.every((call) => call.form.grant_type === 'urn:ietf:params:oauth:grant-type:device_code' && call.form.client_id === CLIENT && !('client_secret' in call.form)));
  assert.equal(calls.find((call) => call.url.endsWith('/user')).auth, 'Bearer ghu_first');

  const kept = fs.readFileSync(file, 'utf8');
  assert.equal(kept.includes('ghu_first') || kept.includes('ghr_first'), false, 'the tokens are never written in the clear');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const later = { t: 1_000_000 + 60 * 1000 };
  const again = createGithub({ fetch: async () => reply(500, {}), settings: () => ({ clientId: CLIENT }), file, crypt, now: () => later.t });
  assert.equal(again.status().login, 'hudsonmp', 'a restart is still signed in');
  assert.equal(await again.token(), 'ghu_first');
  later.t += 9 * 3600 * 1000;
  assert.equal(await again.token(), null, 'expired, and GitHub answers 500 to the refresh: nothing works now');
  assert.equal(again.status().connected, true, 'but a bad moment at GitHub does not sign anyone out');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('device flow: cancelled on GitHub, expired, disabled, unconfigured; cancel here stops the waiting', async () => {
  const denied = setup(({ url }) => (url.endsWith('/device/code') ? reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 }) : reply(200, { error: 'access_denied' })));
  await denied.github.connect();
  await until(() => !denied.github.status().pending);
  assert.deepEqual([denied.github.status().connected, denied.github.status().error], [false, 'Cancelled on GitHub.']);
  assert.equal(denied.closed.length, 1);

  const expiring = setup(({ url }) => (url.endsWith('/device/code') ? reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 12, interval: 5 }) : reply(200, { error: 'authorization_pending' })));
  await expiring.github.connect();
  await until(() => !expiring.github.status().pending);
  assert.equal(expiring.github.status().error, 'The code expired. Try again.');

  const disabled = setup(() => reply(400, { error: 'device_flow_disabled' }));
  await assert.rejects(disabled.github.connect(), /Device flow is off/);

  const unconfigured = setup(() => reply(500, {}), { settings: () => ({ clientId: '' }) });
  assert.equal(unconfigured.github.status().configured, false);
  await assert.rejects(unconfigured.github.connect(), /client id in ~\/\.engelbart\/config\.json/);
  assert.equal(unconfigured.calls.length, 0, 'nothing is asked of GitHub without a client id');

  let polls = 0;
  const cancelled = setup(({ url }) => { if (url.endsWith('/device/code')) return reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 }); polls += 1; return reply(200, { error: 'authorization_pending' }); });
  await cancelled.github.connect();
  const again = await cancelled.github.connect();
  assert.equal(cancelled.calls.filter((call) => call.url.endsWith('/device/code')).length, 1, 'asking again while a code waits shows the same code');
  assert.equal(cancelled.opened.length, 2, 'and opens the window again');
  assert.equal(again.pending.userCode, 'AAAA-BBBB');
  cancelled.github.cancel();
  const after = polls;
  await settle(); await settle();
  assert.ok(polls <= after + 1, 'no more asking after cancel');
  assert.equal(cancelled.github.status().pending, null);
});

test('tokens: refreshed without a secret before they expire; a refused refresh or a refused token signs out', async () => {
  let refreshes = 0;
  const refreshable = setup(({ url, form }) => {
    if (url.endsWith('/device/code')) return reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 });
    if (url.endsWith('/access_token') && form.grant_type === 'refresh_token') { refreshes += 1; return refreshes === 1 ? reply(200, { access_token: 'ghu_second', expires_in: 28800 }) : reply(200, { error: 'bad_refresh_token' }); }
    if (url.endsWith('/access_token')) return reply(200, { access_token: 'ghu_first', expires_in: 28800, refresh_token: 'ghr_first', refresh_token_expires_in: 15897600 });
    if (url.endsWith('/user')) return user;
    return reply(404, {});
  });
  await refreshable.github.connect();
  await until(() => refreshable.github.status().connected);
  assert.equal(await refreshable.github.token(), 'ghu_first');
  refreshable.clock.t += 8 * 3600 * 1000 - 60 * 1000; // a minute before it expires
  const [a, b] = await Promise.all([refreshable.github.token(), refreshable.github.token()]);
  assert.deepEqual([a, b, refreshes], ['ghu_second', 'ghu_second', 1], 'two askers share one refresh');
  const refresh = refreshable.calls.find((call) => call.form && call.form.grant_type === 'refresh_token');
  assert.deepEqual(refresh.form, { client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'ghr_first' }, 'the device flow refreshes with the client id alone');
  refreshable.clock.t += 8 * 3600 * 1000;
  assert.equal(await refreshable.github.token(), null, 'the refresh token was kept and then refused');
  assert.deepEqual([refreshable.github.status().connected, refreshable.github.status().error], [false, 'The GitHub sign-in expired. Sign in again.']);
  assert.equal(fs.existsSync(refreshable.file), false);

  const revoked = setup(({ url }) => {
    if (url.endsWith('/device/code')) return reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 });
    if (url.endsWith('/access_token')) return reply(200, { access_token: 'ghu_never_expires' });
    if (url.endsWith('/user')) return user;
    return reply(401, { message: 'Bad credentials' });
  });
  await revoked.github.connect();
  await until(() => revoked.github.status().connected);
  revoked.clock.t += 400 * 24 * 3600 * 1000;
  assert.equal(await revoked.github.token(), 'ghu_never_expires', 'an App that opted out of expiring tokens never refreshes');
  await assert.rejects(revoked.github.repos(), /no longer accepts/);
  assert.equal(revoked.github.status().connected, false);
});

test('repositories: every installation, every page, once each, most recently pushed first; the accounts it is installed on', async () => {
  const repo = (id, full, pushed, priv = false) => ({ id, full_name: full, private: priv, description: `about ${full}`, pushed_at: pushed });
  const many = Array.from({ length: 100 }, (_, i) => repo(1000 + i, `Mathetic-PBC/r${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`));
  const { github, calls } = setup(({ url }) => {
    if (url.endsWith('/device/code')) return reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 });
    if (url.endsWith('/access_token')) return reply(200, { access_token: 'ghu_first' });
    if (url.endsWith('/user')) return user;
    if (url.includes('/user/installations?')) return reply(200, { total_count: 2, installations: [{ id: 11, account: { login: 'Mathetic-PBC', type: 'Organization' }, repository_selection: 'all' }, { id: 12, account: { login: 'hudsonmp', type: 'User' }, repository_selection: 'selected' }] });
    if (url.includes('/installations/11/repositories') && url.includes('page=1')) return reply(200, { repositories: many }, { link: '<https://api.github.com/user/installations/11/repositories?page=2>; rel="next"' });
    if (url.includes('/installations/11/repositories') && url.includes('page=2')) return reply(200, { repositories: [repo(9, 'Mathetic-PBC/engelbart-canvas', '2026-09-22T20:00:00Z', true)] });
    if (url.includes('/installations/12/repositories')) return reply(200, { repositories: [repo(9, 'Mathetic-PBC/engelbart-canvas', '2026-09-22T20:00:00Z', true), repo(5, 'hudsonmp/hudsonmp.github.io', '2026-09-20T00:00:00Z'), { id: 'x', full_name: 'bad' }] });
    return reply(404, {});
  });
  await assert.rejects(github.repos(), /Not signed in/);
  await github.connect();
  await until(() => github.status().connected);
  const { repos, accounts } = await github.repos();
  assert.equal(repos.length, 102, 'a repository two installations share is listed once; nonsense is dropped');
  assert.deepEqual(repos.slice(0, 2).map((r) => [r.fullName, r.private, r.url]), [['Mathetic-PBC/engelbart-canvas', true, 'https://github.com/Mathetic-PBC/engelbart-canvas'], ['hudsonmp/hudsonmp.github.io', false, 'https://github.com/hudsonmp/hudsonmp.github.io']]);
  assert.deepEqual(accounts, [{ login: 'Mathetic-PBC', type: 'Organization', all: true }, { login: 'hudsonmp', type: 'User', all: false }]);
  assert.ok(calls.filter((call) => call.url.includes('/user/installations')).every((call) => call.auth === 'Bearer ghu_first'));
});

test('without a keychain the sign-in lasts as long as the app runs; a sign-out forgets it', async () => {
  const { github, file } = setup(({ url }) => {
    if (url.endsWith('/device/code')) return reply(200, { device_code: 'd', user_code: 'AAAA-BBBB', expires_in: 900, interval: 5 });
    if (url.endsWith('/access_token')) return reply(200, { access_token: 'ghu_first' });
    return user;
  }, { crypt: { available: () => false, encrypt: () => { throw new Error('no'); }, decrypt: () => { throw new Error('no'); } } });
  await github.connect();
  await until(() => github.status().connected);
  assert.deepEqual([github.status().persisted, fs.existsSync(file)], [false, false]);
  github.disconnect();
  assert.equal(github.status().connected, false);
  assert.equal(await github.token(), null);
});

test('page-meta asks GitHub signed in when there is a token, and again signed out when the token is refused', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push(init.headers.authorization || null);
    if (init.headers.authorization === 'Bearer stale') return reply(401, {});
    return reply(200, url.endsWith('/contents') ? [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }] : { id: 42, full_name: 'Mathetic-PBC/engelbart-canvas', description: 'Engelbart' });
  };
  const identify = createRepoIdentifier({ fetch, auth: async () => ({ authorization: 'Bearer good' }) });
  assert.deepEqual(await identify('Mathetic-PBC', 'engelbart-canvas'), { id: '42', fullName: 'Mathetic-PBC/engelbart-canvas', url: 'https://github.com/Mathetic-PBC/engelbart-canvas', description: 'Engelbart' });
  assert.deepEqual(seen, ['Bearer good']);
  seen.length = 0;
  const list = createRemoteFileLister({ fetch, auth: async () => ({ authorization: 'Bearer stale' }) });
  assert.deepEqual(await list('Mathetic-PBC', 'engelbart-canvas'), ['src/', 'README.md']);
  assert.deepEqual(seen, ['Bearer stale', null], 'refused signed in, answered signed out');
  seen.length = 0;
  await createRepoIdentifier({ fetch, auth: async () => ({}) })('o', 'r');
  assert.deepEqual(seen, [null], 'signed out: no header at all');
});
