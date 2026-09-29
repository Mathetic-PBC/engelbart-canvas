'use strict';

// Where a workspace's Builds work (src/renderer/model/build-target.js): the pick remembered per workspace, the default
// repo until there is one and again when the one picked is gone; storage that fails changes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/model/build-target.js');
const LIST = [{ kind: 'default', name: 'repo' }, { kind: 'project', name: 'code' }, { kind: 'library', id: 'row-1', name: 'owner/app', place: 'github' }];

function withStorage(storage, work) {
  const before = globalThis.window;
  globalThis.window = { localStorage: storage };
  try { return work(); } finally { globalThis.window = before; }
}
const memory = () => { const held = new Map(); return { getItem: (key) => (held.has(key) ? held.get(key) : null), setItem: (key, value) => held.set(key, String(value)) }; };

test('the pick is remembered per workspace; the default repo until there is one, and when the one picked is gone (2026-09-29)', async () => {
  const { pickedTarget, rememberTarget, DEFAULT_TARGET } = await load();
  const storage = memory();
  withStorage(storage, () => {
    assert.deepEqual(pickedTarget('p1', 'w1', LIST), DEFAULT_TARGET);
    rememberTarget('p1', 'w1', { kind: 'library', id: 'row-1', name: 'ignored', folder: '/not/kept' });
    assert.deepEqual(pickedTarget('p1', 'w1', LIST), { kind: 'library', id: 'row-1' }, 'only what names it is kept');
    assert.deepEqual(pickedTarget('p1', 'w2', LIST), DEFAULT_TARGET, 'another workspace of the project has its own');
    assert.deepEqual(pickedTarget('p2', 'w1', LIST), DEFAULT_TARGET, 'another project has its own');
    assert.deepEqual(pickedTarget('p1', 'w1', LIST.slice(0, 2)), DEFAULT_TARGET, 'a row no longer listed');
    assert.deepEqual(pickedTarget('p1', 'w1', []), DEFAULT_TARGET, 'a list that could not be read');
    rememberTarget('p1', 'w2', { kind: 'project' });
    assert.deepEqual(pickedTarget('p1', 'w2', LIST), { kind: 'project' });
    assert.deepEqual(pickedTarget('p1', 'w1', LIST), { kind: 'library', id: 'row-1' }, 'the first workspace keeps its pick');
  });
  withStorage({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }, () => {
    rememberTarget('p1', 'w1', { kind: 'project' });
    assert.deepEqual(pickedTarget('p1', 'w1', LIST), DEFAULT_TARGET);
  });
});

test('a picker row says what kind of repository it is; one with a sandbox says so', async () => {
  const { targetTag, sameTarget, targetKey } = await load();
  assert.deepEqual(LIST.map((item) => targetTag(item)), ['default', 'project', 'github']);
  assert.equal(targetTag(LIST[2], true), 'sandbox');
  assert.equal(targetTag({ kind: 'library', id: 'x', place: 'local' }), 'local');
  assert.equal(targetKey(LIST[2]), 'library:row-1');
  assert.ok(sameTarget(LIST[2], { kind: 'library', id: 'row-1' }));
  assert.ok(!sameTarget(LIST[0], LIST[1]));
});
