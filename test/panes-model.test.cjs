'use strict';

// The pane beside the document (model/panes.js, MATH-23): a note's or a workspace's mention clicked opens its document
// to the right of the document in front, Andy Matuschak's working notes style. Two panes at most (2026-10-05): pane 0 is
// the document in front; the list holds the one beside it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/panes.js')).href);

const note = (id) => ({ kind: 'note', id, title: id.toUpperCase() });
const space = (id) => ({ kind: 'workspace', id, title: id.toUpperCase() });
const pane = (id, link = id, kind = 'note') => ({ kind, id, title: id.toUpperCase(), link });
const ids = (panes) => panes.map((p) => p.id);
const FRONT = { kind: 'workspace', id: 'w1' }; // the Workspace tab in front

test('a note clicked in the document opens beside it; another one clicked there takes its place', async () => {
  const { openBeside } = await load();
  const one = openBeside([], FRONT, note('a'), 'A');
  assert.deepEqual(one, { panes: [{ kind: 'note', id: 'a', title: 'A', link: 'A' }], at: 1 });
  assert.deepEqual(ids(openBeside(one.panes, FRONT, note('b'), 'B').panes), ['b'], 'the pane beside is replaced');
  assert.deepEqual(openBeside([], FRONT, { id: 'a' }, null).panes, [{ kind: 'note', id: 'a', title: '', link: '' }], 'no kind, title or link: a note, empty, never undefined');
});

test('two panes at most: a mention clicked in the right pane replaces it, never a third', async () => {
  const { openBeside } = await load();
  let panes = [];
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    const out = openBeside(panes, FRONT, note(id), id);
    assert.equal(out.at, 1, `${id} is beside`);
    assert.equal(out.panes.length, 1, `one pane beside the document after ${id}`);
    panes = out.panes;
  }
  assert.deepEqual(ids(panes), ['e']);
  assert.deepEqual(ids(openBeside([pane('a'), pane('b'), pane('c')], FRONT, note('x'), 'x').panes), ['x'], 'a longer list (an older strip) comes down to one');
  const given = [pane('a')];
  openBeside(given, FRONT, note('x'), 'x');
  assert.deepEqual(given, [pane('a')], 'the list given is never changed');
});

test('the note already beside only takes the new link; the same link changes nothing', async () => {
  const { openBeside } = await load();
  const held = [pane('a', 'old')];
  const same = openBeside(held, FRONT, note('a'), 'new');
  assert.deepEqual(same.panes, [{ kind: 'note', id: 'a', title: 'A', link: 'new' }]);
  assert.equal(same.at, 1);
  const again = openBeside(held, FRONT, note('a'), 'old');
  assert.equal(again.panes, held, 'the same list');
  assert.equal(again.at, 1, 'the pane beside shows it');
});

test('the note already open on the left is not opened again beside it: the pane in front shows it', async () => {
  const { openBeside, sameDoc } = await load();
  const front = { kind: 'note', id: 'a' }; // note A's tab in front
  const held = [pane('b')];
  const out = openBeside(held, front, note('a'), 'A');
  assert.equal(out.at, 0, 'scroll to the left pane');
  assert.equal(out.panes, held, 'the pane beside stays as it was');
  assert.equal(openBeside([], front, note('a'), 'A').panes.length, 0, 'nothing beside: still nothing');
  assert.equal(openBeside(held, FRONT, space('w1'), 'W1').at, 0, 'the workspace in front, mentioned: the same');
  assert.equal(openBeside(held, null, note('a'), 'A').at, 1, 'an archived version in front is neither: the note opens beside');
  assert.equal(sameDoc({ kind: 'note', id: 'x' }, { kind: 'workspace', id: 'x' }), false, 'a note and a workspace never match by id alone');
  assert.equal(sameDoc({ id: 'x' }, { kind: 'note', id: 'x' }), true, 'no kind is a note');
  assert.equal(sameDoc(null, null), false);
});

test('a workspace\'s mention opens its document beside, in place of a note there; a note replaces it in turn', async () => {
  const { openBeside } = await load();
  const out = openBeside([pane('a')], FRONT, space('w2'), 'Elsewhere');
  assert.deepEqual(out, { panes: [{ kind: 'workspace', id: 'w2', title: 'W2', link: 'Elsewhere' }], at: 1 });
  assert.deepEqual(openBeside(out.panes, FRONT, note('w2'), 'w2').panes[0].kind, 'note', 'a note that has the same id is another document');
  assert.deepEqual(openBeside(out.panes, FRONT, space('w2'), 'Elsewhere').panes, out.panes, 'the same workspace again: nothing changed');
});

test('nothing to open: the list as it was, and no pane', async () => {
  const { openBeside } = await load();
  const held = [pane('a')];
  assert.deepEqual(openBeside(held, FRONT, null, 'x'), { panes: held, at: null });
  assert.deepEqual(openBeside(held, FRONT, { kind: 'note' }, 'x'), { panes: held, at: null });
  assert.deepEqual(openBeside(undefined, FRONT, note('a'), 'A').panes, [pane('a', 'A')]);
});

test('closing the pane beside closes it; the document never closes', async () => {
  const { closePane } = await load();
  const one = [pane('a')];
  assert.deepEqual(closePane(one, 1), []);
  assert.equal(closePane(one, 0), one, 'pane 0 is the document');
  assert.equal(closePane(one, 2), one, 'no such pane');
  assert.equal(closePane(one, 'x'), one);
  assert.deepEqual(closePane(undefined, 1), []);
  assert.deepEqual(ids(one), ['a'], 'the list given is never changed');
});
