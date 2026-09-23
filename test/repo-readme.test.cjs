'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRepoReadmeReader, MAX_README_BYTES } = require('../src/main/store/repo-readme.cjs');
const repo = 'https://github.com/owner/app';
function body(overrides = {}) {
  return { path: '.github/README.md', size: 9, encoding: 'base64', content: Buffer.from('# Hello ✓').toString('base64'),
    html_url: `${repo}/blob/main/.github/README.md`, download_url: 'https://raw.githubusercontent.com/owner/app/main/.github/README.md', ...overrides };
}
const response = (data = body()) => new Response(JSON.stringify(data), { status: 200 });

test('README reader loads the preferred file, decodes UTF-8, caches and refreshes without credentials', async () => {
  const calls = [];
  let time = 0;
  const read = createRepoReadmeReader({ now: () => time, fetch: async (...args) => { calls.push(args); return response(); } });
  const first = await read(repo);
  assert.equal(first.content, '# Hello ✓');
  assert.equal(first.format, 'markdown');
  assert.equal(first.path, '.github/README.md');
  assert.equal(calls[0][0], 'https://api.github.com/repos/owner/app/readme');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal(await read(repo.toUpperCase()), first);
  assert.equal(calls.length, 1);
  await read(repo, { refresh: true });
  assert.equal(calls.length, 2);
  time = 5 * 60_000;
  await read(repo);
  assert.equal(calls.length, 3);
});

test('parallel README requests coalesce, and failures are retryable', async () => {
  let release, count = 0;
  const read = createRepoReadmeReader({ fetch: async () => { count++; await new Promise((resolve) => { release = resolve; }); return response(); } });
  const first = read(repo), second = read(repo);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(count, 1);
  const retry = createRepoReadmeReader({ fetch: async () => { if (count++ === 1) throw new Error('offline'); return response(); } });
  await assert.rejects(retry(repo), /connection/);
  assert.equal((await retry(repo)).status, 'ready');
});

test('missing/private README and API errors have explicit outcomes', async () => {
  const missing = createRepoReadmeReader({ fetch: async () => new Response('', { status: 404 }) });
  assert.deepEqual(await missing(repo), { status: 'missing', repositoryUrl: repo });
  for (const status of [403, 429, 500]) {
    const read = createRepoReadmeReader({ fetch: async () => new Response('', { status }) });
    await assert.rejects(read(repo), status === 500 ? /500/ : /rate limit/);
  }
});

test('only GitHub repository URLs and GitHub API redirects are fetched', async () => {
  let calls = 0;
  const read = createRepoReadmeReader({ fetch: async () => { calls++; return response(); } });
  for (const url of ['file:///etc/passwd', 'https://localhost/owner/app', 'https://github.com/../app', 'https://github.com/owner/app?token=x']) {
    await assert.rejects(read(url), /saved GitHub/);
  }
  assert.equal(calls, 0);
  const moved = createRepoReadmeReader({ fetch: async (url) => {
    calls++;
    return calls === 1 ? new Response('', { status: 301, headers: { location: 'https://api.github.com/repositories/123/readme' } }) : response();
  } });
  assert.equal((await moved(repo)).status, 'ready');
  assert.equal(calls, 2);
  for (const location of ['https://evil.example/readme', 'http://api.github.com/readme', 'https://user:pass@api.github.com/readme']) {
    const redirected = createRepoReadmeReader({ fetch: async () => new Response('', { status: 302, headers: { location } }) });
    await assert.rejects(redirected(repo), /invalid README source/);
  }
});

test('oversized, malformed and unsafe GitHub responses are rejected', async () => {
  for (const data of [null, body({ size: MAX_README_BYTES + 1 }), body({ content: 'bad!' }), body({ content: 'x' }),
    body({ encoding: 'none' }), body({ path: '../README.md' }), body({ path: 'README\\md' }),
    body({ html_url: 'https://evil.example/README.md' }), body({ download_url: 'file:///README.md' }),
    body({ html_url: `${repo}/blob/main/other.md` }), body({ content: Buffer.alloc(MAX_README_BYTES + 1, 'a').toString('base64') })]) {
    const read = createRepoReadmeReader({ fetch: async () => response(data) });
    await assert.rejects(read(repo), /README/);
  }
  const huge = createRepoReadmeReader({ fetch: async () => new Response(' '.repeat(1024 * 1024 + 1)) });
  await assert.rejects(huge(repo), /too large/);
});

test('non-Markdown README files are returned as plain text', async () => {
  const read = createRepoReadmeReader({ fetch: async () => response(body({ path: 'README.rst', html_url: `${repo}/blob/main/README.rst`, download_url: 'https://raw.githubusercontent.com/owner/app/main/README.rst' })) });
  assert.equal((await read(repo)).format, 'text');
});

test('README IPC resolves only saved library entries and neither launches nor mutates a run', async () => {
  const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const handlers = new Map(), calls = [];
  const rows = { repo: { id: 'repo', url: repo }, site: { id: 'site', url: 'https://example.org' } };
  registerEngelbartIpc({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn,
    store: { context: async () => ({ libraryDb: { get: async (id) => rows[id] } }) },
    sandbox: { start() { assert.fail('README must not start a sandbox'); } },
    readRepoReadme: async (...args) => { calls.push(args); return { status: 'ready' }; },
  });
  const read = handlers.get('engelbart:repository-readme');
  await read('repo');
  await read('repo', { refresh: true });
  assert.deepEqual(calls, [[repo, { refresh: false }], [repo, { refresh: true }]]);
  for (const id of ['missing', 'site', repo]) await assert.rejects(read(id), /saved GitHub/);
  for (const options of [null, [], { url: repo }, { refresh: 'yes' }]) await assert.rejects(read('repo', options), /Invalid README options/);
  assert.equal(calls.length, 2);
});
