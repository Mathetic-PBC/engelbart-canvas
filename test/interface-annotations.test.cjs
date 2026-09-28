'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const schema = require('../src/shared/interface-annotations.cjs');
const notes = require('../src/main/store/interface-annotations.cjs');
const db = require('../src/main/store/db.cjs');
const projects = require('../src/main/store/projects.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { createAnnotations } = require('../src/main/browser/annotations.cjs');
const { WORLD, source } = require('../src/main/browser/annotation-page.cjs');
const picked = { element: { tag: 'button', selector: '#save', id: 'save', text: 'Save', value: 'private', classes: [] }, ancestors: [], frames: [], route: '/editor', documentTitle: 'Editor' };

test('shared display labels prefer semantic names and never reveal selectors, IDs, tags, or dimensions', () => {
  assert.equal(schema.targetLabel({ ...picked.element, label: 'Save changes' }), 'Save changes');
  assert.equal(schema.targetLabel(picked.element), 'Save');
  assert.equal(schema.targetLabel({ tag: 'button', selector: '#debug', id: 'debug', testid: 'debug', width: 113 }), 'Selected element');
  assert.equal(schema.targetLabel({ text: ' Clear\n storage ' }), 'Clear storage');
});

test('picker coordinates are ephemeral, bounded, and never become anchor identity', async () => {
  let bounds = { x: 12, y: 30, w: 80, h: 24, viewportWidth: 900, viewportHeight: 600, secret: 'omit' };
  const reports = [];
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async () => [{ type: 'picked', anchor: { ...picked, bounds }, bounds }],
  });
  const controller = createAnnotations(wc, (event) => reports.push(event));
  try {
    await controller.command({ type: 'mode', on: true });
    assert.deepEqual(reports[0].bounds, { x: 12, y: 30, w: 80, h: 24, viewportWidth: 900, viewportHeight: 600 });
    assert.equal(reports[0].anchor.bounds, undefined);
    for (const invalid of [{ ...bounds, x: NaN }, { ...bounds, viewportWidth: 0 }, { ...bounds, w: -1 }, { ...bounds, h: 1e9 }]) {
      bounds = invalid;
      await controller.command({ type: 'mode', on: true });
      assert.equal(reports.at(-1).bounds, undefined);
      assert.equal(reports.at(-1).anchor.element.text, 'Save');
    }
  } finally { controller.dispose(); }
});

test('saved marker and locate events provide only validated ephemeral placement', async () => {
  const bounds = { x: 12, y: 30, w: 80, h: 24, viewportWidth: 900, viewportHeight: 600 };
  let events = ['marker', 'located'].map(type => ({ type, id: 'saved-note', bounds: { ...bounds, extra: 'omit' }, body: 'omit' }));
  const reports = [];
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async () => events,
  });
  const controller = createAnnotations(wc, event => reports.push(event));
  try {
    await controller.command({ type: 'locate', id: 'saved-note' });
    assert.deepEqual(reports, ['marker', 'located'].map(type => ({ type, id: 'saved-note', bounds })));
    reports.length = 0;
    events = [
      { type: 'located', id: 'missing', bounds: null },
      { type: 'marker', id: 'invalid-bounds', bounds: { ...bounds, x: Infinity } },
      { type: 'marker', id: 'x'.repeat(65), bounds },
      { type: 'located', id: 123, bounds },
    ];
    await controller.command({ type: 'locate', id: 'missing' });
    assert.deepEqual(reports, [{ type: 'located', id: 'missing', bounds: null }, { type: 'marker', id: 'invalid-bounds', bounds: null }]);
  } finally { controller.dispose(); }
});

test('anchors are bounded descriptions; URLs omit credentials and query tokens', () => {
  const a = schema.anchor({ ...picked, userId: 'forged', frames: ['iframe#preview'] });
  assert.equal(a.element.value, undefined);
  assert.equal(a.userId, undefined);
  assert.equal(schema.pageAddress('https://user:secret@example.com/editor?token=secret#section').url, 'https://example.com/editor');
  assert.equal(schema.pageAddress('https://example.com/#/editor').route, '/#/editor');
  assert.throws(() => schema.pageAddress('javascript:alert(1)'));
  assert.throws(() => schema.anchor({ ...picked, element: { tag: '*', selector: '#a' } }));
  assert.throws(() => schema.anchor({ ...picked, frames: Array(11).fill('iframe') }));
  assert.throws(() => schema.body(' '));
  assert.throws(() => schema.body('a'.repeat(4001)));
});

test('notes survive fresh reads and preview host changes; projects/sites/PDF ink stay separate', async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-interface-notes-'));
  const layout = ensureHome(homeDir);
  const ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
  try {
    const project = await projects.createProject(ctx, { name: 'Browser notes', directory: homeDir });
    const other = await projects.createProject(ctx, { name: 'Other notes', directory: homeDir });
    const scope = { projectId: project.id, url: 'https://old.example/editor?token=private' };
    const repo = randomUUID();
    await ctx.libraryDb.insert({ id: repo, type: 'website', name: 'Repository', url: 'https://github.com/example/repo', tags: ['git'] });
    await ctx.libraryDb.query('insert into sandbox_runs(id,library_id,status,preview_url) values($1,$2,$3,$4)', [randomUUID(), repo, 'stopped', 'https://old.example/']);
    await ctx.libraryDb.query('insert into sandbox_runs(id,library_id,status,preview_url) values($1,$2,$3,$4)', [randomUUID(), repo, 'ready', 'https://new.example/']);
    const created = await notes.create(ctx, scope, { body: ' Make this clearer. ', anchor: picked });
    assert.equal(created.body, 'Make this clearer.');
    assert.equal(created.url, 'https://old.example/editor');
    const next = { ...scope, url: 'https://new.example/editor' };
    assert.deepEqual((await notes.list(ctx, next)).notes, [created]);
    assert.equal((await notes.list(ctx, { ...next, projectId: other.id })).notes.length, 0);
    assert.equal((await notes.list(ctx, { ...next, url: 'https://elsewhere.example/editor' })).notes.length, 0);
    await Promise.all([notes.create(ctx, next, { body: 'Second', anchor: picked }), notes.create(ctx, next, { body: 'Third', anchor: picked })]);
    assert.equal((await notes.list(ctx, next)).notes.length, 3, 'concurrent additions do not overwrite one another');
    const edited = await notes.edit(ctx, next, created.id, 'Edited');
    assert.deepEqual(edited.anchor, created.anchor);
    assert.equal(edited.body, 'Edited');
    await assert.rejects(() => notes.create(ctx, { ...next, url: 'https://new.example/other' }, { body: 'No', anchor: picked }), /page changed/);
    await assert.rejects(() => notes.list(ctx, { ...next, projectId: '../../outside' }));
    await notes.remove(ctx, next, created.id);
    assert.equal((await notes.list(ctx, next)).notes.length, 2);
    assert.equal(fs.existsSync(path.join(ctx.dataRoot, 'annotations', `${repo}.json`)), false, 'PDF storage is untouched');
  } finally { await db.closeAll(); }
});

test('controller uses an isolated world, strips note text, rejects stale picks, and clears same-document navigation', async () => {
  const calls = [], reports = [];
  let delayed;
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async (world, scripts) => {
      calls.push({ world, code: scripts[0].code });
      if (delayed) return delayed;
      return [];
    },
  });
  const controller = createAnnotations(wc, (e) => reports.push(e));
  try {
    await controller.command({ type: 'show', items: [{ id: 'note', anchor: picked, body: 'NEVER_IN_PAGE' }] });
    assert.equal(calls[0].world, WORLD);
    assert.equal(calls[0].code.includes('NEVER_IN_PAGE'), false);
    let resolve;
    delayed = new Promise((r) => { resolve = r; });
    const inFlight = controller.command({ type: 'mode', on: true });
    await new Promise((r) => setImmediate(r));
    wc.emit('did-start-navigation', {}, 'https://example.com/next', true, true);
    delayed = null;
    resolve([{ type: 'picked', anchor: picked }]);
    await inFlight;
    await new Promise((r) => setImmediate(r));
    assert.equal(reports.some((e) => e.type === 'picked'), false);
    assert.match(calls.at(-1).code, /"type":"clear"/);
    await controller.command({ type: 'clear' });
  } finally { controller.dispose(); }
  assert.equal(wc.listenerCount('did-start-navigation'), 0);
});

test('a rejected execution from the old document cannot stop polling the new document', async () => {
  const calls = [];
  let reject, hold = true;
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: (_world, scripts) => {
      calls.push(scripts[0].code);
      if (hold) return new Promise((_resolve, fail) => { reject = fail; });
      return Promise.resolve([]);
    },
  });
  const controller = createAnnotations(wc, () => {});
  try {
    const old = controller.command({ type: 'mode', on: true });
    await new Promise((resolve) => setImmediate(resolve));
    wc.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
    const fresh = controller.command({ type: 'show', items: [] });
    hold = false; reject(new Error('Document destroyed'));
    await old; await fresh;
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.match(calls.at(-1), /"type":"poll"/);
  } finally { controller.dispose(); }
});

// Evaluate the bridge's actual generated JavaScript, replacing only the DOM
// installer's body. Real Chromium coverage exercises that installer separately.
function isolatedController() {
  const world = vm.createContext({ installs: 0, messages: [] });
  const bootstrap = `if (!globalThis.__engelbartAnnotations) {
    installs++;
    globalThis.__engelbartAnnotations = { command(message) { messages.push(message); return []; } };
  }`;
  const wc = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    executeJavaScriptInIsolatedWorld: async (id, scripts) => {
      assert.equal(id, WORLD);
      return vm.runInContext(scripts[0].code.replace(source, bootstrap), world);
    },
  });
  return { world, wc, controller: createAnnotations(wc, () => {}) };
}

test('clearing a page without an annotation helper is a no-op and does not install one', async () => {
  const { world, controller } = isolatedController();
  try {
    await controller.command({ type: 'clear' });
    await controller.command({ type: 'clear' });
    assert.equal(world.installs, 0);
    assert.equal(world.__engelbartAnnotations, undefined);
    assert.equal(world.messages.length, 0);
  } finally { controller.dispose(); }
});

test('cleanup tolerates a lost helper and subsequent actions reinstall only when needed', async () => {
  const { world, controller } = isolatedController();
  try {
    await controller.command({ type: 'mode', on: true });
    await controller.command({ type: 'mode', on: false });
    assert.equal(world.installs, 1, 'ordinary actions reuse the page helper');
    vm.runInContext('delete globalThis.__engelbartAnnotations', world);
    await controller.command({ type: 'clear' });
    assert.equal(world.installs, 1, 'cleanup must not recreate a missing helper');
    assert.equal(world.__engelbartAnnotations, undefined);
    for (const message of [
      { type: 'mode', on: true },
      { type: 'show', items: [{ id: 'saved', anchor: picked }] },
      { type: 'locate', id: 'saved' },
    ]) {
      vm.runInContext('delete globalThis.__engelbartAnnotations', world);
      const before = world.installs;
      await controller.command(message);
      assert.equal(world.installs, before + 1);
      assert.equal(world.messages.at(-1).type, message.type);
    }
    await controller.command({ type: 'clear' });
    assert.equal(world.messages.at(-1).type, 'clear', 'an existing helper still receives cleanup');
  } finally { controller.dispose(); }
});

test('polling restores a missing page helper without throwing or installing duplicates', async () => {
  const { world, controller } = isolatedController();
  try {
    await controller.command({ type: 'mode', on: true });
    vm.runInContext('delete globalThis.__engelbartAnnotations', world);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(world.installs, 2);
    assert.equal(world.messages.at(-1).type, 'poll');
    await controller.command({ type: 'mode', on: false });
    assert.equal(world.installs, 2);
  } finally { controller.dispose(); }
});

test('real errors from the current page are still reported, including failed cleanup', async () => {
  const { world, controller } = isolatedController();
  try {
    world.__engelbartAnnotations = { command() { throw new Error('Actual overlay failure'); } };
    for (const message of [{ type: 'mode', on: true }, { type: 'clear' }]) {
      await assert.rejects(controller.command(message), /Actual overlay failure/);
    }
  } finally { controller.dispose(); }
});

test('cancelled commands do not reject after cleanup, renderer loss, disposal, or tab destruction', async t => {
  for (const reason of ['clear', 'render-process-gone', 'dispose', 'destroyed']) {
    await t.test(reason, async () => {
      let reject, calls = 0, destroyed = false;
      const reports = [];
      const wc = Object.assign(new EventEmitter(), {
        isDestroyed: () => destroyed,
        executeJavaScriptInIsolatedWorld: () => ++calls === 1
          ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve([]),
      });
      const controller = createAnnotations(wc, event => reports.push(event));
      try {
        const pending = controller.command({ type: 'mode', on: true });
        await new Promise(resolve => setImmediate(resolve));
        let cleanup;
        if (reason === 'clear') cleanup = controller.command({ type: 'clear' });
        else if (reason === 'render-process-gone') wc.emit('render-process-gone');
        else if (reason === 'dispose') controller.dispose();
        else destroyed = true;
        reject(new Error('Old execution context is gone'));
        await assert.doesNotReject(pending);
        if (cleanup) await cleanup;
        assert.equal(reports.some(event => event.type === 'error'), false);
      } finally { controller.dispose(); }
    });
  }
});
