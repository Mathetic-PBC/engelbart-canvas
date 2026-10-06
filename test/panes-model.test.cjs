'use strict';

// The notes open beside the document (model/panes.js, MATH-23): a note mention clicked in a pane opens its note in the
// pane after it, Andy Matuschak's working notes style. Pane 0 is the document; the list holds the notes after it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/panes.js')).href);

const note = (id) => ({ id, title: id.toUpperCase() });
const pane = (id, link = id) => ({ id, title: id.toUpperCase(), link });
const ids = (panes) => panes.map((p) => p.id);

test('a note clicked in the document opens beside it; another one clicked there takes its place', async () => {
  const { openBeside } = await load();
  const one = openBeside([], 0, note('a'), 'A');
  assert.deepEqual(one, [{ id: 'a', title: 'A', link: 'A' }]);
  assert.deepEqual(ids(openBeside(one, 0, note('b'), 'B')), ['b'], 'clicked in the document again: the pane after it is replaced');
  assert.deepEqual(openBeside([], 0, { id: 'a' }, null), [{ id: 'a', title: '', link: '' }], 'no title or link: empty, never undefined');
});

test('a note clicked in a pane opens after that pane, and every pane further right goes', async () => {
  const { openBeside } = await load();
  const three = [pane('a'), pane('b'), pane('c')];
  assert.deepEqual(ids(openBeside([pane('a')], 1, note('b'), 'B')), ['a', 'b'], 'from pane 1: a third pane');
  assert.deepEqual(ids(openBeside(three, 1, note('x'), 'X')), ['a', 'x'], 'from pane 1: b and c go');
  assert.deepEqual(ids(openBeside(three, 0, note('x'), 'X')), ['x'], 'from the document: all of them go');
  assert.deepEqual(ids(openBeside(three, 3, note('x'), 'X')), ['a', 'b', 'c', 'x'], 'from the last pane: added at the end');
  assert.deepEqual(ids(openBeside([pane('a')], 9, note('x'), 'X')), ['a', 'x'], 'an index past the end is the last pane');
  assert.deepEqual(ids(openBeside(three, -2, note('x'), 'X')), ['x'], 'below 0 is the document');
  assert.deepEqual(ids(openBeside([pane('a')], 1, note('a'), 'A')), ['a', 'a'], 'a note that mentions itself opens again after itself');
  assert.deepEqual(three, [pane('a'), pane('b'), pane('c')], 'the list given is never changed');
});

test('the note already right after the pane only takes the new link; the panes after it stay', async () => {
  const { openBeside } = await load();
  const three = [pane('a', 'old'), pane('b'), pane('c')];
  const same = openBeside(three, 0, note('a'), 'new');
  assert.deepEqual(ids(same), ['a', 'b', 'c']);
  assert.equal(same[0].link, 'new');
  assert.equal(same[0].title, 'A');
  assert.equal(same[1], three[1], 'the rest are the same objects');
  assert.equal(openBeside(three, 0, note('a'), 'old'), three, 'the same link: nothing changed, the same list');
  assert.deepEqual(ids(openBeside(three, 0, note('b'), 'B')), ['b'], 'a note further right is not "right after": opened anew');
});

test('at most MAX_PANES note panes: one more lets the oldest go', async () => {
  const { openBeside, MAX_PANES } = await load();
  assert.equal(MAX_PANES, 4);
  let panes = [];
  for (const [i, id] of ['a', 'b', 'c', 'd'].entries()) panes = openBeside(panes, i, note(id), id);
  assert.deepEqual(ids(panes), ['a', 'b', 'c', 'd']);
  panes = openBeside(panes, 4, note('e'), 'e');
  assert.deepEqual(ids(panes), ['b', 'c', 'd', 'e'], 'a fifth: the first note pane goes, never the document');
  assert.deepEqual(ids(openBeside(panes, 2, note('x'), 'x')), ['b', 'c', 'x'], 'opened further left: nothing to drop');
});

test('closing a pane closes it and every pane to its right; the document never closes', async () => {
  const { closePane } = await load();
  const three = [pane('a'), pane('b'), pane('c')];
  assert.deepEqual(ids(closePane(three, 2)), ['a']);
  assert.deepEqual(ids(closePane(three, 3)), ['a', 'b']);
  assert.deepEqual(closePane(three, 1), []);
  assert.equal(closePane(three, 0), three, 'pane 0 is the document');
  assert.equal(closePane(three, 4), three, 'no such pane');
  assert.equal(closePane(three, 'x'), three);
  assert.deepEqual(closePane(undefined, 1), []);
  assert.deepEqual(ids(three), ['a', 'b', 'c'], 'the list given is never changed');
});
