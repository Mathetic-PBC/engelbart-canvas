'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resizedBounds } = require('../src/main/window-edges.cjs');

const start = { x: 100, y: 50, width: 1200, height: 800 };
const min = { width: 900, height: 560 };

test('the right edge grows and shrinks the width only', () => {
  assert.deepEqual(resizedBounds(start, 'right', 40, 30, min), { x: 100, y: 50, width: 1240, height: 800 });
  assert.deepEqual(resizedBounds(start, 'right', -100, 0, min), { x: 100, y: 50, width: 1100, height: 800 });
});

test('the left edge keeps the right side where it was', () => {
  const b = resizedBounds(start, 'left', -60, 0, min);
  assert.deepEqual(b, { x: 40, y: 50, width: 1260, height: 800 });
  assert.equal(b.x + b.width, start.x + start.width);
});

test('the bottom corners move height and one side', () => {
  assert.deepEqual(resizedBounds(start, 'bottom', 25, 40, min), { x: 100, y: 50, width: 1200, height: 840 });
  assert.deepEqual(resizedBounds(start, 'bottom-right', 25, 40, min), { x: 100, y: 50, width: 1225, height: 840 });
  assert.deepEqual(resizedBounds(start, 'bottom-left', 25, 40, min), { x: 125, y: 50, width: 1175, height: 840 });
});

test('never below the minimum size, and the left edge stops instead of sliding the window', () => {
  assert.deepEqual(resizedBounds(start, 'bottom-right', -900, -900, min), { x: 100, y: 50, width: 900, height: 560 });
  assert.deepEqual(resizedBounds(start, 'left', 700, 0, min), { x: 400, y: 50, width: 900, height: 800 });
});

test('an unknown edge is refused', () => {
  assert.throws(() => resizedBounds(start, 'top', 0, 0, min), TypeError);
});
