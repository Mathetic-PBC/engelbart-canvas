'use strict';

// A repository's code for its sandbox, read with the GitHub sign-in (src/main/github/repo-access.cjs): the sign-in goes
// to GitHub's API only; a private repository's sandbox gets a codeload link for one archive, and nothing else.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepoAccess } = require('../src/main/github/repo-access.cjs');

const REPO = { owner: 'owner', name: 'app', url: 'https://github.com/owner/app' };
const TOKEN = 'ghu_signed_in_token';
const LINK = 'https://codeload.github.com/owner/app/legacy.tar.gz/refs/heads/main?token=AAAAONEARCHIVEONLYTOKEN';

/** A GitHub that answers from `routes` (path → { status, body, location }), keeping every request. */
function github(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const { pathname } = new URL(url);
    calls.push({ url, path: pathname, init });
    const route = routes[pathname] || { status: 404, body: { message: 'Not Found' } };
    return {
      status: route.status, ok: route.status >= 200 && route.status < 300,
      headers: { get: (name) => (name.toLowerCase() === 'location' ? route.location || null : null) },
      json: async () => route.body,
      body: { cancel: async () => {} },
    };
  };
  return { calls, fetch };
}

test('a private repository: described with the sign-in, its code handed over as a one-archive link fetched without following it', async () => {
  const gh = github({
    '/repos/owner/app': { status: 200, body: { private: true, default_branch: 'main' } },
    '/repos/owner/app/git/trees/HEAD': { status: 200, body: { tree: [{ path: 'src/index.js' }, { path: 'docker-compose.yml' }] } },
    '/repos/owner/app/tarball': { status: 302, location: LINK },
  });
  const access = createRepoAccess({ token: async () => TOKEN, fetch: gh.fetch });
  assert.deepEqual(await access.describe(REPO), { private: true, branch: 'main', docker: true });
  assert.equal(await access.archive(REPO), LINK);
  assert.ok(gh.calls.every((call) => call.url.startsWith('https://api.github.com/') && call.init.headers.authorization === `Bearer ${TOKEN}`), 'the sign-in goes to GitHub\'s API only');
  assert.equal(gh.calls.at(-1).init.redirect, 'manual', 'the archive link is read, never followed with the sign-in');
  assert.ok(!LINK.includes(TOKEN));
});

test('a public repository needs no link; GitHub unable to answer leaves it to the sandbox\'s clone', async () => {
  const gh = github({ '/repos/owner/app': { status: 200, body: { private: false, default_branch: 'main' } }, '/repos/owner/app/git/trees/HEAD': { status: 200, body: { tree: [{ path: 'package.json' }] } } });
  assert.deepEqual(await createRepoAccess({ token: async () => TOKEN, fetch: gh.fetch }).describe(REPO), { private: false, branch: 'main', docker: false });
  const limited = github({ '/repos/owner/app': { status: 403, body: { message: 'API rate limit exceeded' } } });
  assert.deepEqual(await createRepoAccess({ fetch: limited.fetch }).describe(REPO), { private: false, branch: null, docker: undefined });
  const offline = createRepoAccess({ fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(await offline.describe(REPO), { private: false, branch: null, docker: undefined });
});

test('a repository GitHub will not show says what to do: install the App (signed in) or sign in', async () => {
  const gh = github({});
  await assert.rejects(createRepoAccess({ token: async () => TOKEN, fetch: gh.fetch, installUrl: () => 'https://github.com/apps/engelbart/installations/new' }).describe(REPO),
    /Engelbart's GitHub App cannot see owner\/app\. If it is private, install the App for owner with access to it \(https:\/\/github\.com\/apps\/engelbart\/installations\/new\)\./);
  await assert.rejects(createRepoAccess({ fetch: gh.fetch }).describe(REPO), /owner\/app was not found on GitHub\. If it is private, sign in to GitHub in Engelbart\./);
});

test('only a codeload link of GitHub\'s is ever handed over', async () => {
  const answer = (route) => createRepoAccess({ token: async () => TOKEN, fetch: github({ '/repos/owner/app/tarball': route }).fetch }).archive(REPO);
  await assert.rejects(answer({ status: 302, location: 'https://evil.example/owner/app.tar.gz' }), /unexpected download address/);
  await assert.rejects(answer({ status: 302, location: 'http://codeload.github.com/owner/app' }), /unexpected download address/);
  await assert.rejects(answer({ status: 302, location: 'https://user:pass@codeload.github.com/owner/app' }), /unexpected download address/);
  await assert.rejects(answer({ status: 404 }), /would not hand over owner\/app's code \(404\)/);
  await assert.rejects(createRepoAccess({ fetch: github({ '/repos/owner/app/tarball': { status: 302, location: LINK } }).fetch }).archive(REPO), /Sign in to GitHub/);
});
