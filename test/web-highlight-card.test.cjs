'use strict';

// A web page's highlights and their card (2026-10-18): what a click lands on (page-preload's inRects, highlightAt), a
// selection inside a highlight being that highlight (holdingHighlight: never a second mark for one passage), where a
// noted highlight's symbol goes (symbolPlace) and how it is drawn (boxes.cjs's boxesCss, in the boxes' one html::after
// rule, so the page's layout is never touched), and when the card's Save can be pressed (BoxCard.jsx's canSave).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

const PAGE = require('../src/main/browser/page-preload.cjs');
const BOXES = require('../src/main/browser/boxes.cjs');

test('the hit test: a point inside a highlight\'s rects is on it, one outside is not; an empty rect holds nothing', () => {
  const rects = [{ left: 100, top: 50, width: 200, height: 20 }, { left: 20, top: 72, width: 120, height: 20 }];
  assert.equal(PAGE.inRects(rects, 150, 60), true, 'its first line');
  assert.equal(PAGE.inRects(rects, 30, 80), true, 'its second');
  assert.equal(PAGE.inRects(rects, 100, 50), true, 'its corner');
  assert.equal(PAGE.inRects(rects, 50, 60), false, 'left of the first line, above the second');
  assert.equal(PAGE.inRects(rects, 310, 60), false, 'past its end');
  assert.equal(PAGE.inRects(rects, 150, 71), false, 'between the lines');
  assert.equal(PAGE.inRects(rects, 310, 60, 12), true, 'within the slop given');
  assert.equal(PAGE.inRects([{ left: 10, top: 10, width: 0, height: 20 }], 10, 15), false, 'an empty box');
  assert.equal(PAGE.inRects([{ x: 0, y: 0, w: 10, h: 10 }], 5, 5), true, 'a measured rect ({ x, y, w, h }) too');
  assert.equal(PAGE.inRects(null, 5, 5), false);
});

test('highlightAt: the highlight under a point, the last painted (the one on top) where two overlap, null off them all', () => {
  const list = [
    { id: 'a', rects: [{ left: 0, top: 0, width: 100, height: 20 }] },
    { id: 'b', rects: [{ left: 50, top: 0, width: 100, height: 20 }] },
  ];
  assert.equal(PAGE.highlightAt(list, 10, 10), 'a');
  assert.equal(PAGE.highlightAt(list, 120, 10), 'b');
  assert.equal(PAGE.highlightAt(list, 75, 10), 'b', 'both: the later');
  assert.equal(PAGE.highlightAt(list, 75, 30), null);
  assert.equal(PAGE.highlightAt([], 1, 1), null);
});

// A Range as far as holdingHighlight asks of it: its boundaries as offsets into the page's text
function range(start, end) {
  return {
    start, end,
    compareBoundaryPoints(how, other) {
      const mine = how === 0 ? this.start : this.end, theirs = how === 0 ? other.start : other.end;
      return Math.sign(mine - theirs);
    },
    toString() { return 'x'.repeat(this.end - this.start); },
  };
}

test('a selection wholly inside a highlight is that highlight (its card opens, no new mark); one reaching past it is new', () => {
  const painted = new Map([['wide', range(10, 80)], ['narrow', range(20, 40)], ['other', range(100, 120)]]);
  assert.equal(PAGE.holdingHighlight(painted, range(25, 30)), 'narrow', 'inside two: the smallest');
  assert.equal(PAGE.holdingHighlight(painted, range(20, 40)), 'narrow', 'the very passage again (as the duplicates were)');
  assert.equal(PAGE.holdingHighlight(painted, range(12, 18)), 'wide');
  assert.equal(PAGE.holdingHighlight(painted, range(35, 90)), null, 'past its end');
  assert.equal(PAGE.holdingHighlight(painted, range(5, 15)), null, 'before its start');
  assert.equal(PAGE.holdingHighlight(painted, range(90, 95)), null, 'between them');
  assert.equal(PAGE.holdingHighlight(new Map(), range(1, 2)), null);
  assert.equal(PAGE.holdingHighlight(painted, null), null);
  const broken = new Map([['gone', { compareBoundaryPoints() { throw new Error('WrongDocumentError'); }, toString: () => '' }]]);
  assert.equal(PAGE.holdingHighlight(broken, range(1, 2)), null, 'another document\'s range is none');
});

test('the note symbol sits over the top right of the highlight\'s first line, a little out from it', () => {
  const at = PAGE.symbolPlace([{ left: 0, top: 0, width: 0, height: 0 }, { left: 100, top: 50, width: 200, height: 20 }, { left: 20, top: 72, width: 120, height: 20 }]);
  const tenth = (n) => Math.round(n * 10) / 10;
  assert.deepEqual(at, { x: tenth(300 - PAGE.CHIP * 0.35), y: tenth(50 - PAGE.CHIP * 0.6), size: PAGE.CHIP }, 'the first line with a box, not an empty one');
  assert.ok(PAGE.CHIP >= 14 && PAGE.CHIP <= 16);
  assert.ok(at.x < 300 && at.x + at.size > 300, 'over the line\'s right end');
  assert.ok(at.y < 50 && at.y + at.size > 50, 'over its top');
  assert.deepEqual(PAGE.symbolPlace([{ left: 10.04, top: 10.04, width: 10, height: 10 }], 16), { x: 14.4, y: 0.4, size: 16 }, 'to a tenth of a pixel');
  assert.equal(PAGE.symbolPlace([]), null);
  assert.equal(PAGE.symbolPlace([{ left: 1, top: 1, width: 0, height: 9 }]), null, 'no box: no symbol');
});

test('the symbols are drawn in the boxes\' html::after rule, a blue chip with a white ring and lines; with no boxes too', () => {
  assert.equal(BOXES.boxesCss([], null, null, null, []), '');
  const css = BOXES.boxesCss([], null, null, null, [{ x: 100, y: 40, size: 15 }]);
  assert.match(css, /^html::after\{/);
  assert.match(css, /left:\d+px !important;top:\d+px !important/);
  assert.match(css, /pointer-events:none !important/, 'clicks go through it to the page');
  const svg = decodeURIComponent(css.match(/data:image\/svg\+xml,([^"]+)"/)[1]);
  assert.match(svg, new RegExp(`<circle [^>]*fill="${BOXES.NOTE_CHIP}"[^>]*stroke="#fff"`));
  assert.equal(BOXES.NOTE_CHIP, '#0070f3');
  // with a box: one rule for both, its picture as wide as both
  const both = BOXES.boxesCss([{ id: 'b', x: 0, y: 0, w: 50, h: 50 }], null, null, null, [{ x: 300, y: 10, size: 15 }]);
  const width = Number(both.match(/width:(\d+)px !important/)[1]);
  assert.ok(width >= 315, `${width}`);
  assert.equal((both.match(/html::after/g) || []).length, 1);
  // what is not a symbol is drawn as none
  assert.equal(BOXES.boxesCss([], null, null, null, [{ x: NaN, y: 0, size: 15 }, { x: 0, y: 0, size: 500 }, null]), '');
});

function loadCard() {
  const filename = path.join(__dirname, '__BoxCard-highlight.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/box-card/BoxCard.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'react-dom/client'], loader: { '.js': 'jsx', '.css': 'empty', '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty' }, logLevel: 'silent' });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled.require = (id) => (id === 'react-dom/client' ? { createRoot: () => ({ render() {} }) } : module.require(id));
  globalThis.window = { boxCardAPI: {} };
  globalThis.document = { getElementById: () => ({}) };
  try { compiled._compile(bundled.outputFiles[0].text, filename); } finally { delete globalThis.window; delete globalThis.document; }
  return compiled.exports;
}

test('Save: pressable with a note; for a kept highlight also with its note emptied (to clear it), never for nothing new', () => {
  const { canSave, SEL_CSS } = loadCard();
  assert.equal(canSave('', '', false), false, 'a new selection with no note');
  assert.equal(canSave('   ', '', false), false);
  assert.equal(canSave('Hi', '', false), true);
  assert.equal(canSave('', 'Old', true), true, 'a kept note cleared');
  assert.equal(canSave('', '', true), false);
  assert.equal(canSave('Edited', 'Old', true), true);
  // the look asked for
  assert.match(SEL_CSS, /#0070f3/);
  assert.match(SEL_CSS, /#9a9a9a/);
  assert.match(SEL_CSS, /#6b6b6b/);
});
