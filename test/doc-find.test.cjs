'use strict';

// Find in the middle canvas's document (model/doc-find.js, 2026-10-16): where a query matches the editor's text as drawn,
// segment by segment. A match runs across the nodes of one block, never from one block into the next.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc-find.js')).href);

// The text each match covers, read back from the segments.
const covered = (segments, matches) => matches.map(({ start, end }) => {
  let text = '';
  for (let i = start.seg; i <= end.seg; i += 1) text += segments[i].text.slice(i === start.seg ? start.offset : 0, i === end.seg ? end.offset : undefined);
  return text;
});

test('segmentMatches: every match in a block, ignoring case, in page order', async () => {
  const { segmentMatches } = await load();
  const segs = [{ text: 'The plan, the Plan and THE PLAN.', block: 0 }];
  const found = segmentMatches(segs, 'plan');
  assert.equal(found.length, 3);
  assert.deepEqual(covered(segs, found), ['plan', 'Plan', 'PLAN']);
  assert.deepEqual(found[0], { start: { seg: 0, offset: 4 }, end: { seg: 0, offset: 8 } });
});

test('segmentMatches: across the nodes of one block (a bold word in a sentence), not across blocks', async () => {
  const { segmentMatches } = await load();
  const segs = [
    { text: 'read the ', block: 'a' }, { text: 'related', block: 'a' }, { text: ' work', block: 'a' },
    { text: 'work', block: 'b' }, { text: 'shop', block: 'c' },
  ];
  const found = segmentMatches(segs, 'the related work');
  assert.deepEqual(found, [{ start: { seg: 0, offset: 5 }, end: { seg: 2, offset: 5 } }]);
  assert.deepEqual(segmentMatches(segs, 'workshop'), [], 'two lines are not one word');
  assert.deepEqual(covered(segs, segmentMatches(segs, 'work')), ['work', 'work']);
});

test('segmentMatches: an end stays in the segment its last letter is in; empty segments hold nothing', async () => {
  const { segmentMatches } = await load();
  const segs = [{ text: 'ab', block: 0 }, { text: '', block: 0 }, { text: 'cd', block: 0 }];
  assert.deepEqual(segmentMatches(segs, 'ab'), [{ start: { seg: 0, offset: 0 }, end: { seg: 0, offset: 2 } }]);
  assert.deepEqual(segmentMatches(segs, 'cd'), [{ start: { seg: 2, offset: 0 }, end: { seg: 2, offset: 2 } }]);
  assert.deepEqual(segmentMatches(segs, 'bc'), [{ start: { seg: 0, offset: 1 }, end: { seg: 2, offset: 1 } }]);
});

test('segmentMatches: matches do not overlap; a blank query finds nothing', async () => {
  const { segmentMatches } = await load();
  assert.equal(segmentMatches([{ text: 'aaaa', block: 0 }], 'aa').length, 2);
  assert.deepEqual(segmentMatches([{ text: 'a b', block: 0 }], ''), []);
  assert.deepEqual(segmentMatches([{ text: 'a b', block: 0 }], '   '), []);
  assert.deepEqual(segmentMatches(null, 'a'), []);
});

test('segmentMatches: a letter whose lowercase is longer leaves its segment matched as written, offsets intact', async () => {
  const { segmentMatches } = await load();
  const segs = [{ text: 'İstanbul ', block: 0 }, { text: 'Plan', block: 0 }];
  assert.deepEqual(segmentMatches(segs, 'plan'), [{ start: { seg: 1, offset: 0 }, end: { seg: 1, offset: 4 } }]);
  assert.deepEqual(segmentMatches(segs, 'İstan'), [{ start: { seg: 0, offset: 0 }, end: { seg: 0, offset: 5 } }]);
});
