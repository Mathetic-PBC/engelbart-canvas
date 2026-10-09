'use strict';

// The Getting started panel's steps and what step 2 shows (model/getting-started.js, 2026-10-09).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/getting-started.js')).href);

test('five steps; the open one is the first unticked or the one picked; ticks toggle; the header counts them', async () => {
  const { STEPS, firstOpen, openStepOf, toggled, allDone, headerLine } = await load();
  assert.deepEqual(STEPS.map((step) => step.title), ['See what came in.', 'Pick a workspace to start.', 'Brainstorm what to do next.', 'Find prior work.', 'Ask about a paper.']);
  assert.equal(STEPS[0].hint, 'Click Library in the sidebar.');
  assert.equal(headerLine([]), 'Getting started 0/5');
  assert.equal(firstOpen([]), 1);
  assert.equal(firstOpen([1, 2]), 3);
  assert.equal(openStepOf([1, 2], 5), 5, 'a clicked title opens its step');
  assert.equal(openStepOf([1, 2], null), 3);
  assert.deepEqual(toggled([1, 3], 3), [1]);
  assert.deepEqual(toggled([1], 2), [1, 2]);
  assert.equal(allDone([1, 2, 3, 4, 5]), true);
  assert.equal(firstOpen([5, 4, 3, 2, 1]), null);
  assert.equal(headerLine([1, 2, 3, 4, 5]), 'Getting started 5/5');
});

test('step 2: still reading while waiting or writing; a card a suggestion, Started once picked; none offers the description', async () => {
  const { pickView } = await load();
  assert.equal(pickView({ status: 'waiting' }).kind, 'waiting');
  assert.equal(pickView({ status: 'writing' }).kind, 'waiting');
  const ready = pickView({ status: 'ready', suggestions: [{ name: 'A', description: 'a', why: 'w', items: [] }, { name: 'B', description: 'b', why: '', items: [] }], picked: ['B'] }, 'desc');
  assert.equal(ready.kind, 'ready');
  assert.deepEqual(ready.cards.map((card) => [card.index, card.name, card.started]), [[0, 'A', false], [1, 'B', true]]);
  assert.equal(ready.custom, '', '"Something else…" starts empty beside suggestions');
  assert.deepEqual(pickView({ status: 'none', suggestions: [], picked: [] }, 'My project, as typed.'), { kind: 'none', cards: [], custom: 'My project, as typed.' });
  assert.equal(pickView(null, 'x').kind, 'none');
});
