'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/place.js')).href);
const view = { width: 1200, height: 800 };

test('place: under what it hangs from when it fits, above near the bottom of the window, cut to the larger side otherwise (2026-09-22)', async () => {
  const { place } = await load();
  const high = { left: 100, right: 180, top: 100, bottom: 120 };
  assert.deepEqual(place(high, { width: 300, height: 250 }, view), { left: 100, top: 126, maxHeight: null });
  const low = { left: 100, right: 180, top: 700, bottom: 720 };
  assert.deepEqual(place(low, { width: 300, height: 250 }, view), { left: 100, top: 444, maxHeight: null }, 'no room under the line: it opens above it');
  const middle = { left: 100, right: 180, top: 380, bottom: 400 };
  const tall = place(middle, { width: 300, height: 700 }, view);
  assert.deepEqual(tall, { left: 100, top: 406, maxHeight: 386 }, 'too tall for either side: the side with more room, cut to it');
  const upper = place({ left: 100, right: 180, top: 500, bottom: 520 }, { width: 300, height: 700 }, view);
  assert.deepEqual(upper, { left: 100, top: 8, maxHeight: 486 });
  assert.equal(place({ left: 1100, right: 1180, top: 100, bottom: 120 }, { width: 330, height: 100 }, view).left, 862, 'it stays inside the window sideways');
  assert.equal(place({ left: 900, right: 1000, top: 100, bottom: 120 }, { width: 332, height: 100 }, view, { align: 'end' }).left, 668, 'a right-aligned panel hangs from the right edge');
});

test('placeBeside: the sidebar\'s panels open to the right of it at the row\'s height, moved up to stay in the window, on the left with no room (2026-10-07)', async () => {
  const { place, placeBeside } = await load();
  const row = { left: 8, right: 300, top: 200, bottom: 228 };
  assert.deepEqual(placeBeside(row, { width: 340, height: 300 }, view), { left: 308, top: 200, maxHeight: null }, 'beside, at the row\'s top');
  assert.deepEqual(placeBeside({ ...row, top: 700, bottom: 728 }, { width: 340, height: 300 }, view), { left: 308, top: 492, maxHeight: null }, 'near the bottom it moves up');
  assert.deepEqual(placeBeside(row, { width: 340, height: 900 }, view), { left: 308, top: 8, maxHeight: 784 }, 'taller than the window: cut to it, and it scrolls');
  assert.equal(placeBeside({ left: 900, right: 1000, top: 100, bottom: 120 }, { width: 340, height: 100 }, view).left, 552, 'no room on the right: on the left');
  assert.deepEqual(place(row, { width: 340, height: 300 }, view, { side: 'right' }), placeBeside(row, { width: 340, height: 300 }, view, { gap: 6 }), 'place() with side right is placeBeside');
});
