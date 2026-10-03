'use strict';

// Paper highlights' pure parts (src/renderer/pdf/marks.js, 2026-10-02): one box per stretch of a line, and where a new
// highlight goes among a page's marks.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/marks.js')).href);

const r = (x, y, w, h) => ({ x, y, w, h });
const round = (boxes, d = 2) => boxes.map((b) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, +v.toFixed(d)])));

test('mergeLineRects: nothing in, nothing out', async () => {
  const { mergeLineRects } = await load();
  assert.deepEqual(mergeLineRects([]), []);
  assert.deepEqual(mergeLineRects(undefined), []);
  assert.deepEqual(mergeLineRects(null), []);
  assert.deepEqual(mergeLineRects([r(0, 0, 0, 10), r(0, 0, 10, 0), r(NaN, 0, 5, 5), null]), []);
});

test('mergeLineRects: duplicates and near-duplicates (0.5px off) are one box spanning them', async () => {
  const { mergeLineRects } = await load();
  assert.deepEqual(mergeLineRects([r(10, 20, 100, 14), r(10, 20, 100, 14)]), [r(10, 20, 100, 14)]);
  assert.deepEqual(mergeLineRects([r(10, 20, 100, 14), r(10.5, 19.5, 100, 14.5)]), [r(10, 19.5, 100.5, 14.5)]);
  // A fully selected pdf.js span, as Chromium gives it (logged 2026-10-02): the span's box and its text's box.
  assert.deepEqual(round(mergeLineRects([r(86.58, 549.09, 388.35, 14.44), r(86.58, 547.59, 388.35, 16.5)])), [r(86.58, 547.59, 388.35, 16.5)]);
});

test('mergeLineRects: adjacent and overlapping spans on a line join; a word space joins; a column gutter does not', async () => {
  const { mergeLineRects } = await load();
  assert.deepEqual(mergeLineRects([r(0, 0, 50, 14), r(50, 0, 50, 14)]), [r(0, 0, 100, 14)]);
  assert.deepEqual(mergeLineRects([r(0, 0, 60, 14), r(40, 1, 60, 13)]), [r(0, 0, 100, 14)]);
  assert.deepEqual(mergeLineRects([r(0, 0, 50, 14), r(54, 0, 46, 14)]), [r(0, 0, 100, 14)]); // 4 < 0.6 × 14
  // Two columns (TutorTrace, page 2 at 100%): the left column ends at 476, the right starts at 511.
  assert.deepEqual(mergeLineRects([r(87, 496, 389, 14.6), r(511, 496, 389, 14.6)]), [r(87, 496, 389, 14.6), r(511, 496, 389, 14.6)]);
  assert.equal(mergeLineRects([r(0, 0, 50, 10), r(56.1, 0, 50, 10)]).length, 2); // 6.1 ≥ 0.6 × 10
});

test('mergeLineRects: lines that touch or overlap a little stay apart; boxes come top to bottom, then left to right', async () => {
  const { mergeLineRects } = await load();
  const lines = [r(87, 531, 388, 16.5), r(87, 547.6, 388, 16.5), r(87, 565.3, 118, 16.5)];
  assert.deepEqual(mergeLineRects(lines), lines);
  assert.deepEqual(mergeLineRects([r(0, 0, 100, 16), r(0, 12, 100, 16)]), [r(0, 0, 100, 16), r(0, 12, 100, 16)]); // 4 / 16 overlap
  assert.deepEqual(mergeLineRects([r(0, 0, 100, 16), r(0, 7, 100, 16)]), [r(0, 0, 100, 23)]); // 9 / 16: the same line
  const shuffled = [r(511, 40, 50, 10), r(0, 40, 50, 10), r(300, 0, 50, 10), r(0, 20, 50, 10), r(0, 0, 50, 10)];
  assert.deepEqual(mergeLineRects(shuffled), [r(0, 0, 50, 10), r(300, 0, 50, 10), r(0, 20, 50, 10), r(0, 40, 50, 10), r(511, 40, 50, 10)]);
  // Smaller text on a line (a superscript, a smaller font) is on it when it overlaps half of its own height.
  assert.deepEqual(mergeLineRects([r(0, 10, 100, 14), r(100, 8, 6, 8)]), [r(0, 8, 106, 16)]);
});

test('mergeLineRects: the same in any unit (layout px or page units)', async () => {
  const { mergeLineRects } = await load();
  const px = [r(86.58, 549.09, 388.35, 14.44), r(86.58, 547.59, 388.35, 16.5), r(122.76, 530.01, 353.08, 16.5), r(511, 530, 300, 16.5)];
  const W = 985;
  const inPage = mergeLineRects(px.map((b) => r(b.x / W, b.y / W, b.w / W, b.h / W)));
  assert.deepEqual(round(inPage.map((b) => r(b.x * W, b.y * W, b.w * W, b.h * W))), round(mergeLineRects(px)));
  assert.equal(inPage.length, 3);
});

test('sameLine and boxesOverlap: the overlap check', async () => {
  const { sameLine, boxesOverlap } = await load();
  assert.equal(sameLine(r(0, 0, 10, 10), r(0, 5, 10, 10)), true); // half the height
  assert.equal(sameLine(r(0, 0, 10, 10), r(0, 5.1, 10, 10)), false);
  assert.equal(boxesOverlap(r(0, 0, 50, 10), r(49, 1, 50, 10)), true);
  assert.equal(boxesOverlap(r(0, 0, 50, 10), r(50, 0, 50, 10)), false); // touching is not overlapping
  assert.equal(boxesOverlap(r(0, 0, 50, 10), r(10, 8, 20, 10)), false); // the next line
});

test('sideOf and boxSeed', async () => {
  const { sideOf, boxSeed } = await load();
  assert.equal(sideOf([r(0.1, 0, 0.3, 0.01)]), 'left');
  assert.equal(sideOf([r(0.5, 0, 0.4, 0.01)]), 'right');
  assert.equal(sideOf([r(87, 0, 388, 14), r(87, 20, 100, 14)], 985), 'left');
  assert.equal(sideOf([]), 'right');
  const b = r(0.1234, 0.5678, 0.3, 0.015);
  assert.equal(boxSeed(2, b), boxSeed(2, { ...b }));
  assert.ok(boxSeed(2, b) >= 1 && Number.isInteger(boxSeed(2, b)));
  assert.notEqual(boxSeed(2, b), boxSeed(3, b));
  assert.notEqual(boxSeed(2, b), boxSeed(2, { ...b, y: 0.59 }));
  assert.ok(boxSeed(0, r(0, 0, 1, 1)) >= 1); // never 0, which rough.js takes as random
});

// Marks in page units, as PaperView stores them: lines 0.015 tall, 0.018 apart.
const L = (n) => 0.5 + n * 0.018;
const mark = (id, rects, more = {}) => ({ id, rects, side: 'left', y: Math.min(...rects.map((b) => b.y)), note: null, text: id, pos: null, ...more });

test('placeHighlight: the same text twice is one mark (also a little off, as at another zoom)', async () => {
  const { placeHighlight } = await load();
  const a = mark('a', [r(0.12, L(0), 0.36, 0.015), r(0.09, L(1), 0.2, 0.015)]);
  const again = mark('b', [r(0.1205, L(0) - 0.0005, 0.3593, 0.0155), r(0.0898, L(1), 0.2004, 0.015)]);
  const out = placeHighlight([a], again);
  assert.equal(out.list.length, 1);
  assert.equal(out.mark, a);
  assert.equal(out.list[0], a);
});

test('placeHighlight: a note started inside a highlight goes on it; one with a note opens instead', async () => {
  const { placeHighlight } = await load();
  const plain = mark('a', [r(0.1, L(0), 0.4, 0.015)]);
  const inside = mark('b', [r(0.2, L(0), 0.1, 0.015)], { note: 'w' });
  const out = placeHighlight([plain], inside);
  assert.equal(out.list.length, 1);
  assert.equal(out.mark.id, 'a');
  assert.equal(out.mark.note, 'w');
  assert.deepEqual(out.mark.rects, plain.rects);
  assert.equal(plain.note, null); // the list given is left as it was

  const noted = mark('a', [r(0.1, L(0), 0.4, 0.015)], { note: 'mine' });
  const opened = placeHighlight([noted], inside);
  assert.equal(opened.list.length, 1);
  assert.equal(opened.mark, noted);
  assert.equal(opened.mark.note, 'mine');
  const entered = placeHighlight([noted], { ...inside, note: null });
  assert.equal(entered.list.length, 1);
  assert.equal(entered.mark, noted);
});

test('placeHighlight: overlapping highlights without notes become one, with the earliest id and place', async () => {
  const { placeHighlight, mergeLineRects } = await load();
  const free = { id: 'f', rects: [], side: null, y: 0.2, note: 'free', text: '', pos: { x: 0.9, y: 0.2 } };
  const other = mark('o', [r(0.6, L(9), 0.3, 0.015)]);
  const a = mark('a', [r(0.1, L(0), 0.2, 0.015)], { text: 'the quick brown' });
  const b = mark('b', [r(0.25, L(0), 0.2, 0.015), r(0.09, L(1), 0.1, 0.015)], { text: 'brown fox jumps over\nthe' });
  const out = placeHighlight([free, a, other], b);
  assert.deepEqual(out.list.map((m) => m.id), ['f', 'a', 'o']);
  assert.equal(out.list[0], free);
  const m = out.mark;
  assert.equal(m.id, 'a');
  assert.deepEqual(m.rects, mergeLineRects([...a.rects, ...b.rects]));
  assert.deepEqual(round(m.rects, 4), [r(0.1, L(0), 0.35, 0.015), r(0.09, L(1), 0.1, 0.015)]);
  assert.equal(m.y, L(0));
  assert.equal(m.side, 'left');
  assert.equal(m.note, null);
  assert.equal(m.pos, null);
  assert.equal(m.text, 'the quick brown fox jumps over the');
});

test('placeHighlight: a selection covering highlights keeps its own text; texts otherwise join in reading order', async () => {
  const { placeHighlight } = await load();
  const a = mark('a', [r(0.5, L(0), 0.1, 0.015)], { text: 'fox' });
  const b = mark('b', [r(0.62, L(0), 0.1, 0.015)], { text: 'jumps' });
  const cover = mark('c', [r(0.45, L(0), 0.4, 0.015)], { text: 'brown fox jumps over' });
  const out = placeHighlight([a, b], cover);
  assert.equal(out.list.length, 1);
  assert.equal(out.mark.id, 'a');
  assert.equal(out.mark.text, 'brown fox jumps over');
  assert.equal(out.mark.side, 'right');

  const later = mark('l', [r(0.1, L(2), 0.3, 0.015)], { text: 'later words' });
  const earlier = mark('e', [r(0.3, L(1), 0.4, 0.015), r(0.1, L(2), 0.1, 0.015)], { text: 'earlier' });
  const joined = placeHighlight([later], earlier);
  assert.equal(joined.mark.id, 'l');
  assert.equal(joined.mark.text, 'earlier later words');
  assert.equal(joined.mark.y, L(1));
});

test('placeHighlight: a note anywhere keeps marks apart; the note survives', async () => {
  const { placeHighlight } = await load();
  const noted = mark('a', [r(0.1, L(0), 0.3, 0.015)], { note: 'keep me' });
  const b = mark('b', [r(0.3, L(0), 0.2, 0.015)]);
  const out = placeHighlight([noted], b);
  assert.deepEqual(out.list.map((m) => m.id), ['a', 'b']);
  assert.equal(out.list[0], noted);
  assert.equal(out.list[0].note, 'keep me');
  assert.equal(out.mark, b);

  const plain = mark('p', [r(0.1, L(0), 0.3, 0.015)]);
  const started = mark('s', [r(0.3, L(0), 0.2, 0.015)], { note: 'n' });
  const apart = placeHighlight([plain], started);
  assert.deepEqual(apart.list.map((m) => m.id), ['p', 's']);
  assert.equal(apart.mark.note, 'n');
});

test('placeHighlight: no overlap (another line, or beside it on the same line) is a new mark', async () => {
  const { placeHighlight } = await load();
  const a = mark('a', [r(0.1, L(0), 0.3, 0.015)]);
  assert.deepEqual(placeHighlight([a], mark('b', [r(0.1, L(1), 0.3, 0.015)])).list.map((m) => m.id), ['a', 'b']);
  assert.deepEqual(placeHighlight([a], mark('c', [r(0.405, L(0), 0.2, 0.015)])).list.map((m) => m.id), ['a', 'c']);
  assert.deepEqual(placeHighlight([], mark('d', [r(0.1, L(0), 0.3, 0.015)])).list.map((m) => m.id), ['d']);
});
