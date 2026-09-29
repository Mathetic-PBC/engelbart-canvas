'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const projects = require('../src/main/store/projects.cjs');

test('automatic preparation includes existing library repos and waits before a mode change', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-auto-build-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const ctx = await store.context();
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), name: 'old/repo', type: 'website', tags: ['git'], url: 'https://github.com/old/repo' });
  await ctx.libraryDb.insert({ id: randomUUID(), name: 'site', type: 'website', url: 'https://example.org' });
  const handlers = new Map(), calls = [];
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn,
    sandbox: {
      async start(context, id, options) { calls.push({ id, options, root: context.dataRoot }); await wait; },
      async list() { return []; },
      async close() { calls.push('closed'); },
    },
  });
  const ensure = handlers.get('engelbart:sandbox-ensure')();
  const mode = handlers.get('engelbart:set-test-mode')(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: repo.id, options: { automatic: true }, root: ctx.dataRoot }]);
  release();
  await Promise.all([ensure, mode]);
  assert.equal(calls.at(-1), 'closed');
});

test('adding a GitHub URL through IPC persists the library item before starting; other URLs do not launch', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-sandbox-ipc-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map(), launched = [];
  registerEngelbartIpc({
    store, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, trustedHandler: (fn) => fn,
    describe: async () => null, identifyRepo: async (owner, name) => ({ id: '123456789', fullName: `${owner}/${name}`, url: `https://github.com/${owner}/${name}`, description: 'A repo' }),
    sandbox: { async start(ctx, id) { assert.ok(await ctx.libraryDb.get(id)); launched.push(id); }, async close() {} },
  });
  const add = handlers.get('engelbart:add-library-item');
  const [created, duplicate] = await Promise.allSettled([add('https://github.com/owner/app', { name: 'Saved app' }), add('https://github.com/owner/app')]);
  assert.equal(created.status, 'fulfilled');
  const first = created.value;
  assert.equal(first.name, 'Saved app', 'Browser Save keeps its chosen display name');
  assert.equal(duplicate.status, 'rejected');
  assert.match(duplicate.reason.message, /Already in the library/);
  assert.deepEqual(launched, [first.id], 'a rejected duplicate add does not start another build');
  const found = await handlers.get('engelbart:lookup-library-item')('https://github.com/owner/app');
  assert.equal(found.row.id, first.id, 'existing items can still be found and linked from the sidebar');
  await add('https://example.org/');
  assert.equal(launched.length, 1);
  const ctx = await store.context();
  assert.equal((await ctx.libraryDb.list()).length, 2);
});

test('a worker handoff error does not undo the library addition', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-sandbox-ipc-failure-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  registerEngelbartIpc({
    store, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, trustedHandler: (fn) => fn,
    describe: async () => null, identifyRepo: async () => null,
    sandbox: { async start() { throw new Error('Unable to check existing sandbox'); }, async close() {} },
  });
  const result = await handlers.get('engelbart:add-library-item')('https://github.com/owner/app');
  assert.equal(result.sandbox_error, 'Unable to check existing sandbox');
  assert.equal((await (await store.context()).libraryDb.get(result.id)).url, 'https://github.com/owner/app');
});

async function workspaceFixture(t, sandbox, options = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-attach-repo-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const ctx = await store.context();
  const project = await projects.createProject(ctx, { name: 'Canvas' });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Try a repo' });
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'], url: 'https://github.com/owner/app' });
  const site = await ctx.libraryDb.insert({ id: randomUUID(), name: 'Website', type: 'website', url: 'https://example.org' });
  const handlers = new Map();
  registerEngelbartIpc({ store, sandbox, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, trustedHandler: (fn) => fn, ...options });
  return { ctx, project, workspace, repo, site, handlers,
    attach: (entries) => handlers.get('engelbart:set-workspace-context')(project.id, workspace.id, entries),
    link: (entries) => handlers.get('engelbart:link-to-workspace')(project.id, workspace.id, entries),
    unlink: (id) => handlers.get('engelbart:unlink-from-workspace')(project.id, workspace.id, id),
    saved: () => projects.findWorkspace(ctx, project.id, workspace.id).workspace.context,
  };
}

test('attaching an existing repository starts it once after saving; only new attachments request setup', async (t) => {
  const starts = [];
  const f = await workspaceFixture(t, {
    async start(ctx, id, options) {
      assert.ok(f.saved().includes(id), 'the canvas attachment exists before setup starts');
      starts.push({ id, options });
    },
  });
  await Promise.all([f.attach([f.repo.id, f.site.id]), f.attach([f.repo.id, f.site.id])]);
  assert.deepEqual(starts, [{ id: f.repo.id, options: undefined }], 'a new attachment bypasses the once-per-session background preparation guard');
  await f.attach([f.site.id, f.repo.id]);
  await f.attach([f.site.id]);
  assert.equal(starts.length, 1, 'reordering and removing context do not launch anything');
  await f.attach([f.site.id, f.repo.id]);
  assert.equal(starts.length, 2, 'explicit reattachment requests setup again; the manager reuses an active run');
  await assert.rejects(f.attach([42]), /id or a folder/);
  assert.equal(starts.length, 2, 'invalid context does not start work');
});

test('sidebar, Browser Save and mention links retain trash behavior while starting newly attached repos', async (t) => {
  const starts = [];
  const f = await workspaceFixture(t, { async start(ctx, id) {
    assert.ok(f.saved().includes(id));
    starts.push(id);
  } });
  await Promise.all([f.link([f.repo.id]), f.link([f.site.id]), f.link([f.repo.id])]);
  assert.deepEqual(f.saved(), [f.repo.id, f.site.id]);
  assert.deepEqual(starts, [f.repo.id]);
  const trashed = await f.unlink(f.repo.id);
  assert.deepEqual(trashed.removed, [f.repo.id]);
  assert.deepEqual(f.saved(), [f.site.id]);
  assert.equal(starts.length, 1, 'removing context does not launch a run');
  const linked = await f.link(f.repo.id);
  assert.deepEqual(linked.removed, []);
  assert.deepEqual(starts, [f.repo.id, f.repo.id]);
});

test('new sidebar links preserve attachments when sandbox handoff fails', async (t) => {
  const f = await workspaceFixture(t, { async start() { throw new Error('Sandbox unavailable'); } });
  const saved = await f.link([f.repo.id]);
  assert.deepEqual(saved.context, [f.repo.id]);
  assert.deepEqual(f.saved(), [f.repo.id]);
  assert.equal(saved.sandbox_error, 'owner/app: Sandbox unavailable');
});

test('a canvas attachment survives a setup handoff failure and reports its cause', async (t) => {
  const f = await workspaceFixture(t, {
    async start() { throw new Error('Unable to check existing sandbox'); },
  });
  const saved = await f.attach([f.repo.id]);
  assert.deepEqual(saved.context, [f.repo.id]);
  assert.deepEqual(f.saved(), [f.repo.id]);
  assert.equal(saved.sandbox_error, 'owner/app: Unable to check existing sandbox');
});

test('changing data modes waits for the build handoff from a canvas attachment', async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let closed = false;
  const f = await workspaceFixture(t, {
    async start() { entered(); await waiting; },
    async close() { closed = true; },
  });
  const attachment = f.attach([f.repo.id]);
  await started;
  const mode = f.handlers.get('engelbart:set-test-mode')(false);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.throws(() => f.attach([f.site.id]), /data mode change/);
  } finally { release(); }
  await Promise.all([attachment, mode]);
  assert.equal(closed, true);
});

test('mode switches drain sidebar handoffs and hide post-its before closing the sandbox context', async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const order = [];
  const f = await workspaceFixture(t, {
    async start() { entered(); await waiting; order.push('attached'); },
    async close() { order.push('sandbox-closed'); },
  }, { beforeContextChange: async () => { order.push('post-its-hidden'); } });
  const attachment = f.link([f.repo.id]);
  await started;
  const mode = f.handlers.get('engelbart:set-test-mode')(false);
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order, []);
    assert.throws(() => f.link([f.site.id]), /data mode change/);
    assert.throws(() => f.unlink(f.repo.id), /data mode change/);
  } finally { release(); }
  await Promise.all([attachment, mode]);
  assert.deepEqual(order, ['attached', 'post-its-hidden', 'sandbox-closed']);
});

test('onboarding untick releases a repository sandbox before the row goes; a failed release keeps the row', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-discard-repo-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const ctx = await store.context();
  const repo = await ctx.libraryDb.insert({ id: randomUUID(), name: 'owner/app', type: 'website', tags: ['git'], url: 'https://github.com/owner/app' });
  const other = await ctx.libraryDb.insert({ id: randomUUID(), name: 'other/app', type: 'website', tags: ['git'], url: 'https://github.com/other/app' });
  const released = [];
  let fail = false;
  const handlers = new Map();
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn,
    sandbox: {
      async release(context, id) {
        if (fail) throw new Error('Sandbox cleanup failed');
        assert.ok(await context.libraryDb.get(id), 'released while its row is still there');
        released.push(id);
      },
      async close() {},
    },
  });
  const discard = handlers.get('engelbart:discard-library-item');
  assert.equal(await discard(repo.id), true);
  assert.deepEqual(released, [repo.id]);
  assert.equal(await ctx.libraryDb.get(repo.id), null);
  fail = true;
  await assert.rejects(() => discard(other.id), /Sandbox cleanup failed/);
  assert.ok(await ctx.libraryDb.get(other.id), 'a sandbox that could not be released keeps its row');
});

test('with sandboxes turned off the renderer sees none and nothing starts', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-sandbox-off-'));
  const store = createStore({ homeDir, testMode: true });
  await store.setTestMode(false);
  t.after(() => store.close());
  const handlers = new Map();
  registerEngelbartIpc({ store, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn,
    describe: async () => null, identifyRepo: async () => null });
  assert.deepEqual(await handlers.get('engelbart:sandbox-runs')(), []);
  assert.deepEqual(await handlers.get('engelbart:sandbox-ensure')(), []);
  assert.throws(() => handlers.get('engelbart:sandbox-start')('id'), /turned off/);
  const row = await handlers.get('engelbart:add-library-item')('https://github.com/owner/app');
  assert.equal(row.sandbox_error, undefined);
});
