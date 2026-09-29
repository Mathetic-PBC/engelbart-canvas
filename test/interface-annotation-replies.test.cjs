'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const annotations = require('../src/main/store/interface-annotations.cjs');
const projects = require('../src/main/store/projects.cjs');
const { DEFAULT_MODELS } = require('../src/main/bart/models.cjs');
const anchor = { element: { tag: 'button', selector: '#publish', text: 'Publish' }, ancestors: [], frames: [], route: '/editor', documentTitle: 'Editor' };
async function setup(t) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'engelbart-annotation-replies-'));
  const store = createStore({ homeDir, fixturesDir: path.join(__dirname, '../fixtures') });
  const ctx = await store.context();
  const { project, workspaceId } = await projects.createProjectWithWelcome(ctx, { name: 'Annotation replies' });
  const scope = { projectId: project.id, url: 'https://unsaved.example/editor' };
  const note = await annotations.create(ctx, scope, { body: 'Why is this control unclear?', anchor });
  t.after(async () => { await store.close(); await fs.rm(homeDir, { recursive: true, force: true }); });
  return { store, ctx, scope, workspaceId, note };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  throw Error('Reply was not saved');
}
test('annotation asks persist their answer independently and never change the workspace document', async t => {
  const { store, ctx, scope, workspaceId, note } = await setup(t);
  const ref = { kind: 'workspace', workspaceId };
  const before = await projects.readDoc(ctx, scope.projectId, ref);
  const handlers = new Map(), events = [];
  let finish, request, progress;
  registerEngelbartIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: fn => fn, store,
    readModels: () => DEFAULT_MODELS, notify: channel => events.push(channel),
    readAnnotationContext: async (tabId, selected) => { assert.equal(tabId, 'selected-tab'); assert.equal(selected.id, note.id); return { status: 'available', surroundingText: 'Publish this draft to the team.' }; },
    bart: { ask: async (_ctx, _pid, input, options) => { request = input; progress = options.onProgress; return new Promise(resolve => { finish = resolve; }); }, stop: () => false },
  });
  const ask = handlers.get('engelbart:ask-interface-annotation');
  const askId = randomUUID();
  const started = await ask({ projectId: scope.projectId, workspaceId, tabId: 'selected-tab' }, note.id, askId);
  assert.equal(started.reply.status, 'pending');
  assert.equal(started.libraryId, note.libraryId);
  await until(() => request);
  assert.equal(request.text, 'Why is this control unclear?');
  assert.equal(request.annotation.anchor.element.selector, '#publish');
  assert.equal(request.annotation.page.surroundingText, 'Publish this draft to the team.');
  assert.equal(request.repository, undefined, 'annotation asks do not select the workspace repository');
  assert.deepEqual(request.ref, ref);
  const getProgress = handlers.get('engelbart:annotation-reply-progress');
  progress({ activity: 'Writing', lines: ['A **clearer'] });
  const streaming = getProgress(scope.projectId, note.id, askId);
  assert.deepEqual(streaming.lines, ['A **clearer']);
  assert.equal(streaming.activity, 'Writing');
  assert.equal(getProgress('other-project', note.id, askId), null);
  assert.equal(getProgress(scope.projectId, 'other-note', askId), null);
  assert.equal((await annotations.list(ctx, scope)).notes[0].reply.text, '', 'partial text is transient, not a persisted answer');
  progress({ step: 2, name: 'Sol', effort: 'high' });
  assert.deepEqual(getProgress(scope.projectId, note.id, askId).lines, [], 'escalation clears the previous step');
  await assert.rejects(ask({ projectId: scope.projectId, workspaceId }, note.id, randomUUID()), /already replying/);
  // No renderer needs to await the result or stay mounted for persistence.
  finish({ lines: ['bart> A **clearer label** would help.', 'bart>', 'bart> Try “Publish draft”.'] });
  const done = await until(async () => {
    const value = (await annotations.list(ctx, scope)).notes[0];
    return value.reply.status === 'complete' && value;
  });
  assert.equal(done.reply.text, 'A **clearer label** would help.\n\nTry “Publish draft”.');
  assert.equal(getProgress(scope.projectId, note.id, askId), null, 'finished streams are released');
  const firstRequest = request;
  request = null;
  const followup = await ask({ projectId: scope.projectId, workspaceId, tabId: 'selected-tab' }, note.id, randomUUID(), 'What would you call it instead?');
  assert.equal(followup.body, note.body, 'a follow-up does not overwrite the original annotation');
  assert.deepEqual(followup.replyHistory, [done.reply]);
  await until(() => request);
  assert.equal(request.text, 'What would you call it instead?');
  assert.deepEqual(request.turns, [{ question: firstRequest.text, answer: done.reply.text }], 'Bart receives the earlier exchange as conversation context');
  finish({ lines: ['bart> Call it “Publish draft”.'] });
  const continued = await until(async () => {
    const value = (await annotations.list(ctx, scope)).notes[0];
    return value.reply.status === 'complete' && value;
  });
  assert.equal(continued.reply.text, 'Call it “Publish draft”.');
  assert.deepEqual(continued.replyHistory, [done.reply]);
  assert.equal((await annotations.list(ctx, scope)).notes.length, 1);
  assert.deepEqual(await projects.readDoc(ctx, scope.projectId, ref), before);
  assert.ok(events.filter(event => event === 'engelbart:library-changed').length >= 2);
  await store.close();
  const restored = await store.context();
  const reopened = (await annotations.list(restored, scope)).notes[0];
  assert.deepEqual(reopened.reply, continued.reply);
  assert.deepEqual(reopened.replyHistory, [done.reply], 'the full thread survives a restart');
});

test('annotations can answer with an unavailable repository, and failed page inspection stays explicit', async t => {
  const { store, ctx, scope, workspaceId, note } = await setup(t);
  const repositories = require('../src/main/store/workspace-repositories.cjs');
  const directory = repositories.resolve(ctx, scope.projectId, workspaceId).directory;
  await fs.rename(directory, `${directory}-offline`);
  const handlers = new Map();
  let request;
  registerEngelbartIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: fn => fn, store,
    readModels: () => DEFAULT_MODELS, notify() {},
    readAnnotationContext: async () => { throw Error('Tab closed'); },
    bart: { ask: async (_ctx, _pid, input) => { request = input; return { lines: ['bart> I only have the saved label.'] }; }, stop: () => false },
  });
  await handlers.get('engelbart:ask-interface-annotation')({ projectId: scope.projectId, workspaceId }, note.id, randomUUID());
  const done = await until(async () => { const value = (await annotations.list(ctx, scope)).notes[0]; return value.reply.status === 'complete' && value; });
  assert.equal(request.annotation.page.status, 'unavailable');
  assert.equal(done.reply.text, 'I only have the saved label.');
});

test('Stop while capturing prevents an annotation agent from starting', async t => {
  const { store, ctx, scope, workspaceId, note } = await setup(t);
  const handlers = new Map();
  let captured, asks = 0;
  registerEngelbartIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: fn => fn, store,
    readModels: () => DEFAULT_MODELS, notify() {},
    readAnnotationContext: () => new Promise(resolve => { captured = resolve; }),
    bart: { ask: async () => { asks++; }, stop: () => false },
  });
  const askId = randomUUID();
  await handlers.get('engelbart:ask-interface-annotation')({ projectId: scope.projectId, workspaceId }, note.id, askId);
  assert.equal(handlers.get('engelbart:stop-bart')(askId), true);
  captured({ status: 'available' });
  await until(async () => (await annotations.list(ctx, scope)).notes[0].reply.status === 'stopped');
  assert.equal(asks, 0);
  assert.equal(handlers.get('engelbart:annotation-reply-progress')(scope.projectId, note.id, askId), null);
});
test('replies handle interruption, retry, stale results, failure, and deletion without reviving a note', async t => {
  const { store, ctx, scope, note } = await setup(t);
  const original = randomUUID();
  await annotations.beginReply(ctx, scope, note.id, original);
  await store.close();
  const restored = await store.context();
  assert.equal((await annotations.list(restored, scope)).notes[0].reply.status, 'interrupted');
  const retry = randomUUID();
  await annotations.beginReply(restored, scope, note.id, retry);
  assert.equal((await annotations.list(restored, scope)).notes[0].replyHistory[0].status, 'interrupted');
  await annotations.finishReply(restored, scope, note.id, original, { lines: ['bart> Stale answer'] });
  assert.equal((await annotations.list(restored, scope)).notes[0].reply.askId, retry);
  await annotations.finishReply(restored, scope, note.id, retry, { failed: true, lines: ['bart> **No answer.** Sign in first.'] });
  assert.equal((await annotations.list(restored, scope)).notes[0].reply.status, 'error');
  const stopped = randomUUID();
  await annotations.beginReply(restored, scope, note.id, stopped);
  await annotations.finishReply(restored, scope, note.id, stopped, { stopped: true });
  assert.equal((await annotations.list(restored, scope)).notes[0].reply.status, 'stopped');
  await annotations.remove(restored, scope, note.id);
  await assert.rejects(annotations.finishReply(restored, scope, note.id, stopped, { lines: ['bart> Late answer'] }), /no longer exists/);
  assert.equal((await annotations.list(restored, scope)).notes.length, 0);
});
