'use strict';

// The page as a canvas (src/renderer/pdf/canvas.js, MATH-27 phase 1, 2026-10-06): the desk beside every page, the spacing
// pass that keeps boxes 12px apart and flowing around the ones that were moved, Fit page + notes, which boxes are out of
// view, and the answers a highlight keeps. Follow-ups (2026-10-06): answers hanging under a moved note widen the desk,
// Fit page + notes reads every page, a deleted answer stays a turn while its session lasts.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/canvas.js')).href);

/* ------------------------------------------------------------------------------------------------ the desk */

test('deskOf: at least DESK px each side at every zoom, more when the pane centers a narrow page, more when a moved box needs it', async () => {
  const { deskOf, DESK } = await load();
  assert.equal(DESK, 400);
  assert.deepEqual(deskOf(800, 800), { G: 400, R: 400 }, '100%: the page as wide as the pane, a desk beside it all the same');
  assert.deepEqual(deskOf(800, 1600), { G: 400, R: 400 }, '200%');
  assert.deepEqual(deskOf(2000, 120), { G: 940, R: 940 }, '15% in a wide pane: centered');
  assert.deepEqual(deskOf(800, 800, { left: 520.2, right: 0 }), { G: 521, R: 400 }, 'one side widened alone');
});

test('deskNeed: how far past its page each moved note or answer reaches, plus the desk\'s edge; boxes not moved need nothing', async () => {
  const { deskNeed, DESK_EDGE, NOTE_W, ASK_W, COLLAPSED_W } = await load();
  const P = 500;
  assert.deepEqual(deskNeed({ 1: [{ id: 'a', note: 'beside', pos: null, rects: [{}] }] }, () => P), { left: 0, right: 0 });
  const marks = {
    1: [{ id: 'a', note: 'far left', pos: { x: -1.2, y: 0.1 } }],
    2: [{ id: 'b', note: null, pos: { x: 5, y: 0 }, asks: [{ id: 'q', pos: { x: 1.5, y: 0.2 } }, { id: 'r', pos: { x: 1.9, y: 0.4 }, collapsed: true }] }],
  };
  const need = deskNeed(marks, () => P);
  assert.equal(need.left, DESK_EDGE + 1.2 * P);
  assert.equal(need.right, Math.max(1.5 * P + ASK_W, 1.9 * P + COLLAPSED_W) + DESK_EDGE - P, 'a mark without a note has no note box to place');
  assert.equal(deskNeed({ 3: [{ note: 'x', pos: { x: 0.9, y: 0 } }] }, () => P).right, 0.9 * P + NOTE_W + DESK_EDGE - P);
  assert.deepEqual(deskNeed({ 9: [{ note: 'x', pos: { x: -3, y: 0 } }] }, () => 0), { left: 0, right: 0 }, 'a page not laid out counts for nothing');
});

test('deskNeed: answers hanging under a moved note count too, from its edge nearest the page\'s middle (follow-up, 2026-10-06)', async () => {
  const { deskNeed, hangLeft, DESK, DESK_EDGE, NOTE_W, ASK_W, COLLAPSED_W } = await load();
  const P = 500;
  const answer = (id, more = {}) => ({ id, question: 'q', answer: 'a', pos: null, collapsed: false, ...more });
  // A note dragged near the desk's left edge: its answers (wider than it) hang from its right edge and reach further left.
  const left = { 1: [{ id: 'm', note: '@bart q', rects: [{}], pos: { x: -0.7, y: 0.1 }, asks: [answer('a1'), answer('a2', { collapsed: true })] }] };
  const x = -0.7 * P;
  assert.equal(hangLeft(x, NOTE_W, ASK_W, P / 2), x + NOTE_W - ASK_W);
  assert.equal(deskNeed(left, () => P).left, DESK_EDGE - (x + NOTE_W - ASK_W), 'the widest answer under it, not the note');
  assert.ok(deskNeed(left, () => P).left > DESK, 'past the 400px desk: it widens');
  assert.equal(deskNeed({ 1: [{ ...left[1][0], asks: [answer('a2', { collapsed: true })] }] }, () => P).left, DESK_EDGE - x, 'one folded away is narrower than the note');
  // On the right of the middle they hang from its left edge.
  const right = { 1: [{ id: 'm', note: 'n', rects: [{}], pos: { x: 1.2, y: 0.1 }, asks: [answer('a1')] }] };
  assert.equal(deskNeed(right, () => P).right, 1.2 * P + ASK_W + DESK_EDGE - P);
  // A moved answer is what the ones after it hang from.
  const chain = { 1: [{ id: 'm', note: 'n', rects: [{}], pos: { x: -0.7, y: 0.1 }, asks: [answer('a1', { pos: { x: 0.2, y: 0.5 } }), answer('a2')] }] };
  assert.equal(deskNeed(chain, () => P).left, DESK_EDGE - x, 'a2 hangs from a1, on the page');
  // A deleted answer is not drawn: it holds nothing open. An answer being written is drawn like one.
  const gone = { 1: [{ ...left[1][0], asks: [answer('a1', { deleted: true })] }] };
  assert.equal(deskNeed(gone, () => P).left, DESK_EDGE - x);
  assert.equal(deskNeed(gone, () => P, (id) => (id === 'm' ? 1 : 0)).left, DESK_EDGE - (x + NOTE_W - ASK_W), 'running(markId)');
  // Boxes beside the page, before any moved one, fit the desk as it is.
  const beside = { 1: [{ id: 'm', note: 'n', rects: [{}], side: 'left', pos: null, asks: [answer('a1')] }] };
  assert.deepEqual(deskNeed(beside, () => P, () => 2), { left: 0, right: 0 });
});

test('placeOf and posOf: a box\'s place in page units, at any zoom, and back', async () => {
  const { placeOf, posOf, POS_DY } = await load();
  const pos = posOf(1300, 200, 400, 800);
  assert.deepEqual(pos, { x: 1.125, y: (200 + POS_DY) / 800 });
  assert.deepEqual(placeOf(pos, 400, 800), { left: 1300, top: 200 });
  const half = placeOf(pos, 400, 400);
  assert.deepEqual(half, { left: 400 + 1.125 * 400, top: ((200 + POS_DY) / 800) * 400 - POS_DY }, 'at 50% it keeps its place relative to the page');
});

/* ------------------------------------------------------------------------------------------------ the spacing pass */

const box = (left, width, height) => ({ left, width, height });
const unit = (id, want, ...boxes) => ({ id, want, boxes });

test('spaceBoxes: notes on neighbouring lines are drawn at least 12px apart, in the order they want to be', async () => {
  const { spaceBoxes, BOX_GAP } = await load();
  assert.equal(BOX_GAP, 12);
  const tops = spaceBoxes([unit('c', 130, box(1000, 240, 40)), unit('a', 100, box(1000, 240, 40)), unit('b', 110, box(1000, 240, 30)), unit('d', 400, box(1000, 240, 40))]);
  assert.deepEqual(Object.fromEntries(tops), { a: 100, b: 152, c: 194, d: 400 }, 'top = max(wanted, previous bottom + 12)');
});

test('spaceBoxes: a note and its answers move together; columns that share no x leave each other alone', async () => {
  const { spaceBoxes } = await load();
  const tops = spaceBoxes([
    unit('note+answers', 100, box(1000, 240, 40), box(1000, 320, 200)), // its answer 12px under it: 100..140, 152..352
    unit('next', 120, box(1000, 240, 40)),
    unit('left side', 105, box(40, 240, 40)),
  ]);
  assert.deepEqual(Object.fromEntries(tops), { 'note+answers': 100, next: 364, 'left side': 105 });
});

test('spaceBoxes: boxes that were moved stay put and the others flow around them', async () => {
  const { spaceBoxes } = await load();
  const moved = [{ left: 1100, top: 90, width: 320, height: 100 }];
  const tops = spaceBoxes([unit('a', 80, box(1000, 240, 40)), unit('b', 300, box(1000, 240, 40))], moved);
  assert.deepEqual(Object.fromEntries(tops), { a: 202, b: 300 }, 'pushed under the moved box, which shares its x');
  const clear = spaceBoxes([unit('a', 80, box(1000, 60, 40))], moved);
  assert.equal(clear.get('a'), 80, 'one that shares no x with it is not');
  // Exactly 12px apart is far enough; 11 is not.
  assert.equal(spaceBoxes([unit('a', 202, box(1100, 10, 10))], moved).get('a'), 202);
  assert.equal(spaceBoxes([unit('a', 201, box(1100, 10, 10))], moved).get('a'), 202);
  // A unit with a box that would land in a moved box is pushed by that box, and its first box goes with it.
  const deep = spaceBoxes([unit('pair', 0, box(1000, 60, 50), box(1000, 320, 50))], [{ left: 1200, top: 70, width: 50, height: 50 }]);
  assert.equal(deep.get('pair'), 70 + 50 + 12 - 62);
});

test('spaceBoxes: no two boxes of a page overlap after the pass, whatever they wanted', async () => {
  const { spaceBoxes, BOX_GAP } = await load();
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const units = Array.from({ length: 40 }, (_, i) => unit(`u${i}`, Math.round(rand() * 900), ...Array.from({ length: 1 + Math.floor(rand() * 3) }, () => box(rand() < 0.5 ? 40 : 1000, 240 + Math.round(rand() * 80), 20 + Math.round(rand() * 120)))));
  const fixed = Array.from({ length: 5 }, () => ({ left: rand() < 0.5 ? 60 : 1050, top: Math.round(rand() * 900), width: 200, height: 80 }));
  const tops = spaceBoxes(units, fixed);
  const placed = [...fixed];
  for (const u of units) {
    let t = tops.get(u.id);
    assert.ok(t >= u.want, `${u.id} never goes above where it wants to be`);
    for (const b of u.boxes) { placed.push({ ...b, top: t }); t += b.height + BOX_GAP; }
  }
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const a = placed[i], b = placed[j];
      const sharesX = a.left < b.left + b.width && b.left < a.left + a.width;
      const apart = a.top + a.height + BOX_GAP <= b.top + 1e-9 || b.top + b.height + BOX_GAP <= a.top + 1e-9;
      if (sharesX && !(i < fixed.length && j < fixed.length)) assert.ok(apart, `boxes ${i} and ${j} are ${BOX_GAP}px apart`);
    }
  }
});

/* ------------------------------------------------------------------------------------------------ fit, out of view */

test('fitZoom: Fit page fits the page; Fit page + notes zooms out until every box fits too', async () => {
  const { fitZoom, extentAt } = await load();
  const page = { pageW1: 800, pageH1: 1035, availW: 752, availH: 600, zMin: 0.15, zMax: 2 };
  const fit = fitZoom(page);
  assert.ok(Math.abs(fit - 600 / 1035) < 1e-6, 'the height decides for a tall page');
  const boxes = [{ x: { a: 1, b: 28 }, y: { a: 0.1, b: 0 }, w: 320, h: 260 }, { x: { a: -0.4, b: 0 }, y: { a: 1.2, b: -11 }, w: 240, h: 60 }];
  const z = fitZoom({ ...page, boxes });
  assert.ok(z < fit);
  const e = extentAt({ ...page, boxes }, z);
  assert.ok(e.right - e.left <= page.availW + 1e-6 && e.bottom - e.top <= page.availH + 1e-6, 'everything fits');
  assert.ok(extentAt({ ...page, boxes }, z * 1.01).right - extentAt({ ...page, boxes }, z * 1.01).left > page.availW || extentAt({ ...page, boxes }, z * 1.01).bottom - extentAt({ ...page, boxes }, z * 1.01).top > page.availH, 'and no less zoomed out than it must');
  assert.equal(fitZoom({ ...page, boxes: [{ x: { a: 0, b: -5000 }, y: { a: 0, b: 0 }, w: 10, h: 10 }] }), 0.15, 'what never fits stops at the least zoom');
  assert.equal(fitZoom({ ...page, availW: 5000, availH: 5000 }), 2, 'and at the most');
});

test('Fit page + notes reads every page: paperShape stacks them as laid out, and the fit holds a box three pages on', async () => {
  const { paperShape, extentAt, fitZoom } = await load();
  const box = { x: { a: 1, b: 28 }, y: { a: 0.1, b: 0 }, w: 320, h: 120 };
  const list = [{ pageW1: 800, pageH1: 1000, boxes: [] }, { pageW1: 800, pageH1: 1000, boxes: [] }, { pageW1: 600, pageH1: 900, boxes: [] }, { pageW1: 800, pageH1: 1000, boxes: [box] }];
  const pages = paperShape(list, 1);
  assert.deepEqual(pages.map((p) => p.at), [
    { x: { a: -400, b: 0 }, y: { a: 0, b: 0 } },
    { x: { a: -400, b: 0 }, y: { a: 1000, b: 1 } },
    { x: { a: -300, b: 0 }, y: { a: 2000, b: 2 } },
    { x: { a: -400, b: 0 }, y: { a: 2900, b: 3 } },
  ], 'each 1px under the one before, centered on x = 0');
  assert.deepEqual(pages.map((p) => p.whole), [true, false, false, false], 'the page in view counts whole');
  const z = 0.5;
  assert.deepEqual(extentAt({ pages }, z), { left: -200, top: 0, right: 200 + 28 + 320, bottom: 2900 * z + 3 + 0.1 * 400 + 120 }, 'page 1, and page 4\'s box');
  assert.deepEqual(extentAt({ pages: paperShape(list.map((p) => ({ ...p, boxes: [] })), 2) }, z), { left: -200, top: 500 + 1, right: 200, bottom: 1000 + 1 }, 'no boxes: the page in view alone');
  const view = { availW: 900, availH: 700, zMin: 0.15, zMax: 2 };
  const pageOnly = fitZoom({ pages: paperShape(list.map((p) => ({ ...p, boxes: [] })), 1), ...view });
  assert.ok(Math.abs(pageOnly - 0.7) < 1e-6, 'Fit page: as fitZoom always did for one page');
  const all = fitZoom({ pages, ...view });
  const e = extentAt({ pages }, all);
  assert.ok(all < pageOnly && e.bottom - e.top <= view.availH + 1e-6 && e.right - e.left <= view.availW + 1e-6, 'zoomed out until the box on page 4 fits too');
  // A single page as before: no `pages`, from its own top-left.
  assert.deepEqual(extentAt({ pageW1: 800, pageH1: 1000, boxes: [box] }, 1), { left: 0, top: 0, right: 1148, bottom: 1000 });
});

test('offscreen: boxes beyond each edge of the view by their centers; revealScroll brings them in', async () => {
  const { offscreen, offscreenSide, revealScroll, chipLabel } = await load();
  const view = { left: 0, top: 0, right: 800, bottom: 600 };
  const r = (left, top, width = 240, height = 80) => ({ left, top, width, height });
  const boxes = [r(900, 100), r(1200, 300), r(-300, 50), r(100, 700), r(100, 100), r(600, 100)];
  assert.deepEqual(offscreen(boxes, view), { left: 1, right: 2, up: 0, down: 1 }, 'one half in view counts as in view');
  assert.equal(offscreenSide(r(100, -200), view), 'up');
  assert.equal(offscreenSide(r(-300, 900), view), 'down', 'off to the left but below: down, where scrolling goes first');
  assert.deepEqual(revealScroll([r(-300, 900)], view, 'down'), { dx: -324, dy: 980 + 24 - 600 }, 'and brought across as well');
  assert.deepEqual(revealScroll([r(900, 100), r(1200, 300)], view, 'right'), { dx: 1440 + 24 - 800, dy: 0 }, 'both, when they fit');
  assert.deepEqual(revealScroll([r(900, 100), r(2000, 300)], view, 'right'), { dx: 1140 + 24 - 800, dy: 0 }, 'else the nearest');
  assert.deepEqual(revealScroll([r(-300, 50)], view, 'left'), { dx: -324, dy: 0 });
  assert.deepEqual(revealScroll([r(100, 700)], view, 'down'), { dx: 0, dy: 780 + 24 - 600 });
  assert.deepEqual([chipLabel(2, 'right'), chipLabel(1, 'left'), chipLabel(3, 'down')], ['2 notes →', '← 1 note', '3 notes ↓']);
});

/* ------------------------------------------------------------------------------------------------ answers on a highlight */

test('noteQuestion: a note asks when it starts with @bart; what follows is the question, lines and flags and all', async () => {
  const { noteQuestion } = await load();
  assert.equal(noteQuestion('@bart why κ?'), 'why κ?');
  assert.equal(noteQuestion('  @Bart --opus why\nand how?'), '--opus why\nand how?');
  assert.equal(noteQuestion('@bart'), '');
  assert.equal(noteQuestion('see @bart why'), null, 'only at its start');
  assert.equal(noteQuestion('@barty'), null);
  assert.equal(noteQuestion(null), null);
});

test('withAsk adds an answer to its mark once, and leaves the marks alone when the mark is gone', async () => {
  const { withAsk, turnsOf } = await load();
  const marks = { 2: [{ id: 'm1', note: '@bart q', asks: [] }, { id: 'm2', note: null }] };
  const entry = { id: 'a1', question: 'q', answer: 'A.' };
  const next = withAsk(marks, 2, 'm1', entry);
  assert.deepEqual(next[2][0].asks, [entry]);
  assert.deepEqual(marks[2][0].asks, [], 'the marks given are not changed');
  assert.equal(withAsk(next, 2, 'm1', entry)[2][0].asks.length, 1, 'once');
  assert.equal(withAsk(marks, 2, 'gone', entry), marks);
  assert.equal(withAsk(marks, 7, 'm1', entry), marks);
  assert.deepEqual(turnsOf(next[2][0]), [{ question: 'q', answer: 'A.' }]);
  assert.deepEqual(turnsOf({}), []);
});

test('a deleted answer stays one of the exchange\'s turns while its session can be resumed, then it is gone', async () => {
  const { exchangeOf, shownAsks, turnsOf, keptMarks, THREAD_IDLE_MS } = await load();
  assert.equal(THREAD_IDLE_MS, require('../src/main/bart/ask.cjs').THREAD_IDLE_MS, 'the same window as main\'s');
  const t0 = Date.parse('2026-10-06T10:00:00.000Z');
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const m = { id: 'm1', note: '@bart q', asks: [{ id: 'a1', question: 'why?', answer: 'Because.', at: at(0), deleted: true }, { id: 'a2', question: 'and?', answer: 'Then.', at: at(5) }] };
  assert.deepEqual(shownAsks(m).map((a) => a.id), ['a2'], 'not drawn');
  assert.deepEqual(turnsOf(m, t0 + 20 * 60_000), [{ question: 'why?', answer: 'Because.' }, { question: 'and?', answer: 'Then.' }], 'sent, in its place: the session heard it');
  assert.deepEqual(turnsOf(m, t0 + 36 * 60_000), [{ question: 'and?', answer: 'Then.' }], 'half an hour after the newest answer the session is gone, and so is it');
  assert.deepEqual(exchangeOf({ asks: [{ id: 'a', deleted: true }] }, t0).map((a) => a.id), [], 'an answer with no time is taken as old');
  const kept = keptMarks([m, { id: 'm2', note: 'n' }, null], t0 + 40 * 60_000);
  assert.deepEqual(kept[0].asks.map((a) => a.id), ['a2'], 'and not saved after that');
  assert.equal(kept[1].id, 'm2');
  assert.deepEqual(m.asks.map((a) => a.id), ['a1', 'a2'], 'the marks given are not changed');
  assert.equal(keptMarks([m], t0 + 10 * 60_000)[0], m, 'saved as it is while the session lasts');
});

test('continueLines: the passage and where it is, then the question and the answer as a workspace thread', async () => {
  const { continueLines } = await load();
  assert.deepEqual(continueLines({ quote: 'κ was\n0.79 overall', question: 'is that good?', answer: 'Yes.\n\nSee p. 6.', foot: 'Sonnet · high · 4 s', paper: { name: 'TutorTrace', rowId: 'r1' }, page: 6 }), [
    '“κ was 0.79 overall” (@[TutorTrace], p. 6)',
    '@bart is that good?',
    'bart> Yes.',
    'bart>',
    'bart> See p. 6.',
    'bart>',
    'bart> *Sonnet · high · 4 s*',
  ]);
  assert.equal(continueLines({ quote: 'q', question: 'why\nnow', answer: 'A', paper: { name: 'Scim', url: 'https://arxiv.org/pdf/1' }, page: 2 })[0], '“q” ([Scim](https://arxiv.org/pdf/1), p. 2)');
  assert.equal(continueLines({ quote: 'q', question: 'why\nnow', answer: 'A', paper: { name: 'Scim', url: 'https://arxiv.org/pdf/1' }, page: 2 })[1], '@bart why now', 'the question on one line');
});

test('runningLabel: what Bart is doing, a step up, or thinking', async () => {
  const { runningLabel, modelLabel } = await load();
  assert.equal(runningLabel({ activity: 'Reading tutortrace.pdf' }), 'Bart · Reading tutortrace.pdf');
  assert.equal(runningLabel({ activity: '', movedUp: 1, name: 'Opus', effort: 'high' }), 'Bart · Moving up to Opus high');
  assert.equal(runningLabel({ movedUp: 0, name: 'Sonnet', effort: 'high' }), 'Bart · Thinking');
  assert.equal(runningLabel(null), 'Bart · Thinking');
  assert.equal(modelLabel({ name: 'Sonnet', effort: 'high' }), 'Sonnet · high');
  assert.equal(modelLabel(null), '');
});
