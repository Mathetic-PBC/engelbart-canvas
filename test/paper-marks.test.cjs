'use strict';

// Paper highlights' pure parts (src/renderer/pdf/marks.js, 2026-10-02): one box per stretch of a line, and where a new
// highlight goes among a page's marks. A selection across pages (MATH-14, 2026-10-05): one part a page, one mark a part,
// the parts' marks sharing a group id that placing them among a page's marks keeps.

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

/* ------------------------------------------------------------------ a selection across pages (MATH-14) */

test('selectionParts: a page with no usable rects has no part; the rest are merged boxes in page order, with side and top', async () => {
  const { selectionParts } = await load();
  const parts = selectionParts([
    { page: 4, rects: [r(95, 106, 330, 16.5), r(95, 107.5, 330, 14.4), r(95, 126, 120, 16.5)], width: 985, text: 'This hypothesis-driven\nbugs', u: 985 },
    { page: 3, rects: [r(700, 1240, 125, 18)], width: 985, text: 'us hypotheses [84].', u: 985 },
    { page: 5, rects: [r(0, 0, 0, 10), r(5, 5, 0.5, 0)], width: 985, text: '', u: 985 },
  ]);
  assert.deepEqual(parts.map((p) => p.page), [3, 4]);
  assert.deepEqual(parts[0], { page: 3, rects: [r(700, 1240, 125, 18)], side: 'right', y: 1240, text: 'us hypotheses [84].', u: 985 });
  assert.deepEqual(parts[1].rects, [r(95, 106, 330, 16.5), r(95, 126, 120, 16.5)]); // the doubled span box is one
  assert.equal(parts[1].side, 'left');
  assert.equal(parts[1].y, 106);
  assert.deepEqual(selectionParts([]), []);
  assert.deepEqual(selectionParts(undefined), []);
});

test('scalePart: a pending part drawn at another size', async () => {
  const { scalePart } = await load();
  const part = { page: 3, rects: [r(100, 200, 50, 10)], side: 'left', y: 200, text: 't', u: 1000 };
  assert.deepEqual(scalePart(part, 1000, 1500), { page: 3, rects: [r(150, 300, 75, 15)], side: 'left', y: 300, text: 't', u: 1500 });
  assert.deepEqual(part.rects, [r(100, 200, 50, 10)]); // the part given is left as it was
  assert.deepEqual(scalePart(part, undefined, 800), { ...part, u: 800 }); // nothing to scale from: as it is
});

const counter = () => { let n = 0; return (prefix = 'm') => `${prefix}${++n}`; };

test('partMarks: one part is one mark with the note and no group', async () => {
  const { partMarks } = await load();
  const out = partMarks([{ page: 2, rects: [r(100, 200, 300, 15)], side: 'left', y: 200, text: 'one page', u: 1000 }], 'n', counter(), () => 1000);
  assert.deepEqual(out, [{ page: 2, mark: { id: 'm1', rects: [r(0.1, 0.2, 0.3, 0.015)], side: 'left', y: 0.2, note: 'n', text: 'one page', pos: null } }]);
  assert.equal('group' in out[0].mark, false);
});

test('partMarks: parts across pages share one group id; the note is on the first only; each in its own page units', async () => {
  const { partMarks } = await load();
  const parts = [
    { page: 3, rects: [r(700, 1240, 125, 18)], side: 'right', y: 1240, text: 'us hypotheses [84].', u: 1000 },
    { page: 4, rects: [r(95, 106, 330, 16)], side: 'left', y: 106, text: 'This hypothesis', u: 1000 },
    { page: 5, rects: [], side: 'left', y: 0, text: '', u: 1000 }, // nothing drawn on it: no mark
  ];
  const widths = { 3: 1000, 4: 500 };
  const out = partMarks(parts, 'k', counter(), (page) => widths[page]);
  assert.deepEqual(out.map((o) => o.page), [3, 4]);
  const [a, b] = out.map((o) => o.mark);
  assert.equal(a.group, 'g1');
  assert.equal(b.group, 'g1');
  assert.deepEqual([a.id, b.id], ['m2', 'm3']);
  assert.deepEqual([a.note, b.note], ['k', null]);
  assert.deepEqual([a.text, b.text], ['us hypotheses [84].', 'This hypothesis']);
  assert.deepEqual(round(a.rects, 4), [r(0.7, 1.24, 0.125, 0.018)]);
  assert.deepEqual(round(b.rects, 4), [r(0.19, 0.212, 0.66, 0.032)]); // page 4 is drawn 500 wide
  assert.equal(b.y, 106 / 500);
  // Enter (no note): none on any part
  assert.deepEqual(partMarks(parts, null, counter(), () => 1000).map((o) => o.mark.note), [null, null]);
  assert.deepEqual(partMarks([], 'k', counter(), () => 1000), []);
});

test('placeHighlight: a part of a selection across pages merging with plain highlights keeps its group', async () => {
  const { placeHighlight } = await load();
  const a = mark('a', [r(0.1, L(0), 0.2, 0.015)], { text: 'the quick brown' });
  const part = mark('p', [r(0.25, L(0), 0.2, 0.015)], { text: 'brown fox', group: 'g1' });
  const out = placeHighlight([a], part);
  assert.equal(out.list.length, 1);
  assert.equal(out.mark.id, 'a');
  assert.equal(out.mark.group, 'g1');
  assert.equal(out.mark.text, 'the quick brown fox');
  assert.equal('group' in a, false); // the list given is left as it was

  // A plain selection over a grouped highlight: the merged mark keeps that group, even when the earliest had none.
  const plain = mark('e', [r(0.1, L(1), 0.1, 0.015)]);
  const grouped = mark('q', [r(0.3, L(1), 0.1, 0.015)], { group: 'g2' });
  const over = mark('o', [r(0.15, L(1), 0.2, 0.015)]);
  const merged = placeHighlight([plain, grouped], over);
  assert.deepEqual(merged.list.map((m) => m.id), ['e']);
  assert.equal(merged.mark.group, 'g2');

  // No group anywhere: none is added (marks saved before groups stay as they were).
  const none = placeHighlight([mark('x', [r(0.1, L(2), 0.2, 0.015)])], mark('y', [r(0.2, L(2), 0.2, 0.015)]));
  assert.equal(none.list.length, 1);
  assert.equal('group' in none.mark, false);
});

test('placeHighlight: a part inside a highlight gives it its group (and its note when it has none)', async () => {
  const { placeHighlight } = await load();
  const host = mark('h', [r(0.1, L(0), 0.4, 0.015)]);
  const part = mark('p', [r(0.2, L(0), 0.1, 0.015)], { group: 'g1' });
  const out = placeHighlight([host], part);
  assert.equal(out.list.length, 1);
  assert.equal(out.mark.id, 'h');
  assert.equal(out.mark.group, 'g1');
  assert.equal(out.mark.note, null);
  assert.equal('group' in host, false);

  const noted = placeHighlight([host], { ...part, note: 'w' });
  assert.equal(noted.mark.id, 'h');
  assert.deepEqual([noted.mark.group, noted.mark.note], ['g1', 'w']);

  // Already in that group, or a plain selection inside a grouped highlight: nothing changes.
  const same = { ...host, group: 'g1' };
  assert.equal(placeHighlight([same], part).mark, same);
  assert.equal(placeHighlight([same], mark('s', [r(0.2, L(0), 0.1, 0.015)])).mark, same);
});

test('placeHighlight: marks of two different groups stay apart, each keeping its group', async () => {
  const { placeHighlight } = await load();
  const host = mark('h', [r(0.1, L(0), 0.4, 0.015)], { group: 'g1' });
  const inside = mark('p', [r(0.2, L(0), 0.1, 0.015)], { group: 'g2' });
  const kept = placeHighlight([host], inside);
  assert.deepEqual(kept.list.map((m) => [m.id, m.group]), [['h', 'g1'], ['p', 'g2']]);
  assert.equal(kept.list[0], host);
  assert.equal(kept.mark, inside);

  const left = mark('l', [r(0.1, L(1), 0.2, 0.015)], { group: 'g1' });
  const overlapping = mark('o', [r(0.25, L(1), 0.2, 0.015)], { group: 'g2' });
  assert.deepEqual(placeHighlight([left], overlapping).list.map((m) => [m.id, m.group]), [['l', 'g1'], ['o', 'g2']]);

  // Two highlights of different groups, overlapped by a plain selection: not made one.
  const right = mark('r', [r(0.5, L(1), 0.2, 0.015)], { group: 'g3' });
  const across = mark('x', [r(0.25, L(1), 0.3, 0.015)]);
  assert.deepEqual(placeHighlight([left, right], across).list.map((m) => m.id), ['l', 'r', 'x']);
});

test('passageOf: a highlight\'s own text; a part of a selection across pages, every part of its group in page order', async () => {
  const { passageOf } = await load();
  const plain = { id: 'p', text: 'Cohen\'s κ was 0.79', y: 0.2 };
  const a = { id: 'a', group: 'g1', text: 'the model was\ntrained on ', y: 0.9, note: '@bart why?' };
  const b = { id: 'b', group: 'g1', text: 'a dataset of 480 students', y: 0.05, note: null };
  const c = { id: 'c', group: 'g1', text: ' and four deployments.', y: 0.04, note: null };
  const other = { id: 'o', group: 'g2', text: 'elsewhere', y: 0.5 };
  const marks = { 4: [c, other], 3: [b], 2: [plain, a] };
  assert.equal(passageOf(marks, plain), 'Cohen\'s κ was 0.79', 'no group: as it was');
  const whole = 'the model was\ntrained on\na dataset of 480 students\nand four deployments.';
  assert.equal(passageOf(marks, a), whole, 'pages 2, 3 and 4, one line each, whichever part the note is on');
  assert.equal(passageOf(marks, c), whole);
  assert.equal(passageOf(marks, other), 'elsewhere');
  assert.equal(passageOf({}, { id: 'x', group: 'g9', text: 'alone' }), 'alone', 'a group not among the marks: its own text');
  assert.equal(passageOf(marks, null), '');
});

test('stackNotes: margin notes never cover each other; only a margin full where a note wants to be sends it to the other (MATH-15)', async () => {
  const { stackNotes, NOTE_SLACK } = await load();
  // Two highlights on neighbouring lines, both nearer the right margin: a little crowding is taken in the same margin.
  let at = stackNotes([{ id: 'a', ideal: 100, h: 48, side: 'right' }, { id: 'b', ideal: 110, h: 24, side: 'right' }], { gap: 8 });
  assert.deepEqual(at.get('a'), { top: 100, side: 'right' });
  assert.deepEqual(at.get('b'), { top: 156, side: 'right' }, 'pushed 46 down its own margin: it stays (2026-10-06)');
  // A tall card where it wants to be: past NOTE_SLACK down, the left margin keeps it level with its highlight.
  at = stackNotes([{ id: 'a', ideal: 100, h: NOTE_SLACK + 40, side: 'right' }, { id: 'b', ideal: 110, h: 24, side: 'right' }], { gap: 8 });
  assert.deepEqual(at.get('b'), { top: 110, side: 'left' }, 'the other margin, as a last resort');
  // Exactly NOTE_SLACK down is still its own margin.
  at = stackNotes([{ id: 'a', ideal: 100, h: NOTE_SLACK + 2, side: 'right' }, { id: 'b', ideal: 110, h: 24, side: 'right' }], { gap: 8 });
  assert.equal(at.get('b').side, 'right');
  // Both margins full: stacked, none overlapping.
  at = stackNotes([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ id: `n${i}`, ideal: 100, h: 60, side: 'right' })), { gap: 8 });
  const bySide = { left: [], right: [] };
  for (const [, p] of at) bySide[p.side].push(p.top);
  assert.ok(bySide.left.length > 0, 'once the right one is full far enough down');
  for (const tops of Object.values(bySide)) { tops.sort((x, y) => x - y); for (let i = 1; i < tops.length; i++) assert.ok(tops[i] - tops[i - 1] >= 68); }
  // Past the page's foot: pushed back up.
  at = stackNotes([{ id: 'a', ideal: 980, h: 40, side: 'left' }], { pageH: 1000 });
  assert.equal(at.get('a').top, 960);
});

/* ------------------------------------------------------------- whole words, and the page around a passage (2026-10-06) */

test('wordBounds: a selection snaps out to whole words at both ends; ends between words stay', async () => {
  const { wordBounds } = await load();
  const t = 'the example text here';
  assert.deepEqual(wordBounds(t, 6, 14), { from: 4, to: 16 }, '"ample te" → "example text"');
  assert.deepEqual(wordBounds(t, 4, 11), { from: 4, to: 11 }, 'whole already');
  assert.deepEqual(wordBounds(t, 3, 12), { from: 3, to: 12 }, 'starting and ending on spaces');
  assert.deepEqual(wordBounds('κ = 0.79, n=480', 1, 6), { from: 1, to: 8 }, '"= 0." → "= 0.79": a point between digits is in a number, a comma after one ends it');
  assert.deepEqual(wordBounds('N = 13,633 events', 6, 6), { from: 4, to: 10 });
  assert.deepEqual(wordBounds('behavior-aware AI', 10, 12), { from: 0, to: 14 }, 'a hyphenated word whole');
  assert.deepEqual(wordBounds('construc-\ntion of', 11, 13), { from: 10, to: 14 }, 'not across a line\'s break');
  assert.deepEqual(wordBounds('it\'s fine', 3, 3), { from: 0, to: 4 });
  assert.deepEqual(wordBounds('', 0, 0), { from: 0, to: 0 });
});

test('pdfText: a page\'s items as text, a line break where one ends a line', async () => {
  const { pdfText } = await load();
  assert.equal(pdfText({ items: [{ str: 'Results', hasEOL: true }, { type: 'beginMarkedContent' }, { str: 'κ = 0.79' }, { str: ' overall' }] }), 'Results\nκ = 0.79 overall');
  assert.equal(pdfText(null), '');
});

test('pageWindow: the whole page when it is short; else about 4,000 characters centered on the passage, cut at spaces', async () => {
  const { pageWindow, findPassage } = await load();
  assert.equal(pageWindow('Results.\n\n\n\nκ   was 0.79.  ', 'κ was'), 'Results.\n\nκ was 0.79.', 'tidied');
  const filler = (w, n) => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
  const page = `${filler('before', 900)} Cohen's κ was 0.79 overall across the four deployments ${filler('after', 900)}`;
  const out = pageWindow(page, "Cohen's κ was 0.79\noverall across");
  assert.ok(out.length <= 4004 && out.length > 3900, `${out.length}`);
  assert.ok(out.startsWith('… ') && out.endsWith(' …'), 'marked where cut');
  const at = out.indexOf("Cohen's κ"), mid = at + 30;
  assert.ok(Math.abs(mid - out.length / 2) < 60, `centered on the passage: ${mid} of ${out.length}`);
  assert.ok(!/^… \S*[^\s]\S* /.test(out.slice(0, 2)) && /^… before\d+ /.test(out), 'starts on a whole word');
  // Found across a line's hyphen, or with no space where the page has none.
  assert.deepEqual(findPassage('a b construc-\ntion of the thing', 'construc- tion of'), [4, 21]);
  assert.deepEqual(findPassage('x Cohen\'sκ y', 'Cohen\'s κ'), [2, 10]);
  assert.equal(findPassage('nothing here', 'elsewhere'), null);
  // Not found: centered where its highlight is on the page.
  const late = pageWindow(page, 'not on this page', { at: 1 });
  assert.ok(late.endsWith('after899') && late.startsWith('… '), 'the foot of the page');
  const early = pageWindow(page, 'not on this page', { at: 0 });
  assert.ok(early.startsWith('before0 ') && early.endsWith(' …'), 'its head');
});
