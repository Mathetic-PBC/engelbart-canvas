'use strict';

// The strip beside a Stage page (2026-10-25, David: a white strip along a dark page's right and bottom edges): the page
// stops WINDOW_EDGE px short of the window's edges, and that strip is painted the page's own background. The page's
// preload says the colour its canvas is painted (src/main/browser/page-preload.cjs canvasColor), main takes only a plain
// rgb() from it (src/main/browser/views.cjs backgroundInput) and sends it with the tab's state, and the Stage paints its
// page slot with it (src/renderer/workspace/Stage.jsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { canvasColor, CHANNELS } = require('../src/main/browser/page-preload.cjs');
const { backgroundInput } = require('../src/main/browser/views.cjs');

const plain = (color) => ({ color, image: 'none' });
const CLEAR = 'rgba(0, 0, 0, 0)';

test('the root\'s background is the canvas\'s', () => {
  assert.equal(canvasColor(plain('rgb(13, 17, 23)'), plain('rgb(255, 255, 255)')), 'rgb(13, 17, 23)');
  assert.equal(canvasColor(plain('rgba(255, 255, 255, 1)'), null), 'rgb(255, 255, 255)');
});

test('a root with none gives the body\'s, as CSS does', () => {
  assert.equal(canvasColor(plain(CLEAR), plain('rgb(13, 17, 23)')), 'rgb(13, 17, 23)');
  assert.equal(canvasColor(null, plain('rgb(1, 2, 3)')), 'rgb(1, 2, 3)');
});

test('no colour, a picture, a gradient or a see-through colour is none', () => {
  assert.equal(canvasColor(plain(CLEAR), plain(CLEAR)), null);
  assert.equal(canvasColor(null, null), null);
  assert.equal(canvasColor({ color: 'rgb(1, 2, 3)', image: 'linear-gradient(red, blue)' }, null), null);
  assert.equal(canvasColor(plain(CLEAR), { color: CLEAR, image: 'url("a.png")' }), null);
  assert.equal(canvasColor(plain('rgba(10, 10, 10, 0.5)'), plain('rgb(255, 255, 255)')), null);
  assert.equal(canvasColor(plain('oklch(0.5 0.1 200)'), null), null); // a colour it cannot read: none, not a guess
});

test('main takes only a plain rgb() from the page', () => {
  assert.equal(backgroundInput('rgb(13, 17, 23)'), 'rgb(13, 17, 23)');
  for (const bad of [null, undefined, '', 'red', 'rgb(256, 0, 0)', 'rgb(1,2,3)', 'rgba(1, 2, 3, 1)', 'rgb(1, 2, 3); background: url(x)', 42, {}]) {
    assert.equal(backgroundInput(bad), null, String(bad));
  }
});

test('the page says it, main sends it with the tab\'s state and forgets it with each new page, the Stage paints the slot', () => {
  assert.equal(CHANNELS.background, 'engelbart-page:background');
  const views = fs.readFileSync(path.join(__dirname, '../src/main/browser/views.cjs'), 'utf8');
  assert.match(views, /contents\.ipc\.on\(PAGE\.CHANNELS\.background,/);
  assert.match(views, /background: entry\.background \|\| null/);
  assert.match(views, /'did-navigate', \(\) => \{[^}]*entry\.background = null;/);
  const stage = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Stage.jsx'), 'utf8');
  assert.match(stage, /const paint = page && !failed && !wait && web && web\.background \? web\.background : '#fff';/);
  assert.match(stage, /background: paint/);
});
