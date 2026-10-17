'use strict';

// The page as a canvas (src/renderer/pdf/canvas.js, MATH-27 phase 1, 2026-10-06): the spacing pass that keeps boxes 12px
// apart and flowing around the ones that were moved, and the answers a highlight keeps; a deleted answer stays a turn
// while its session lasts. Since the annotations round (2026-10-16) there is no desk to scroll onto, no Fit page + notes
// and nothing out of view to point at; a note's width is narrow and it grows down (fitWidth, freeNoteWidth), and the
// column stays in the middle of the pane through every zoom (../src/renderer/model/paper-draw.js columnGeometry,
// settleView).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/canvas.js')).href);

/* ------------------------------------------------------------------------------------------------ widths, the column */

test('fitWidth: a card as wide as it would be, narrowed to the room the pane shows, never under its least, never wider than the pane', async () => {
  const { fitWidth, NOTE_MIN, NOTE_W } = await load();
  assert.equal(fitWidth(NOTE_W, 500, NOTE_MIN, 600), NOTE_W, 'room enough: as wide as it would be');
  assert.equal(fitWidth(NOTE_W, 150, NOTE_MIN, 600), 150, 'less room: narrowed to it, and taller');
  assert.equal(fitWidth(NOTE_W, 40, NOTE_MIN, 600), NOTE_MIN, 'too little: its least (it is moved in over the text)');
  assert.equal(fitWidth(NOTE_W, -300, NOTE_MIN, 600), NOTE_MIN, 'its place out of view: its least, moved in');
  assert.equal(fitWidth(NOTE_W, 500, NOTE_MIN, 80), 80, 'never wider than the pane shows');
  assert.equal(fitWidth(70, 500, NOTE_MIN, 600), 70, 'a narrower one is never widened to its least');
});

test('freeNoteWidth: a note typed anywhere runs to the printed text after it or the edge of what showed, within 80..240', async () => {
  const { freeNoteWidth, FREE_MIN, NOTE_W } = await load();
  assert.equal(FREE_MIN, 80);
  assert.equal(freeNoteWidth(100, 300, Infinity), 300 - 6 - 100, 'up to the text on its line');
  assert.equal(freeNoteWidth(100, Infinity, 260), 260 - 8 - 100, 'up to the pane\'s edge');
  assert.equal(freeNoteWidth(100, Infinity, Infinity), NOTE_W);
  assert.equal(freeNoteWidth(500, 520, Infinity), FREE_MIN, 'right against the text: a few words a line all the same');
});

test('columnGeometry: every page as wide as the zoom says, in the middle of a sheet as wide as the pane, or the page past 100%', async () => {
  const { columnGeometry } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/paper-draw.js')).href);
  assert.deepEqual(columnGeometry(800, 1), { pageW: 800, S: 800, G: 0 }, '100%: the page is the pane');
  assert.deepEqual(columnGeometry(800, 0.5), { pageW: 400, S: 800, G: 200 }, '50%: the desk shows each side, the page in the middle');
  assert.deepEqual(columnGeometry(800, 2), { pageW: 1600, S: 1600, G: 0 }, '200%: the sheet is the page, nothing beyond it to scroll to');
  assert.deepEqual(columnGeometry(801, 0.15), { pageW: 120, S: 801, G: 340.5 });
});

test('settleView: a zoom keeps the point it was centered on where it was; across, the view stays on the column\'s middle line', async () => {
  const { settleView } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/paper-draw.js')).href);
  // Three pages 800 × 1000 at 100% in an 800px pane, then 400 × 500 at 50%.
  const from = { tops: [0, 1000, 2000], pageW: 800, S: 800 }, half = { tops: [0, 500, 1000], pageW: 400, S: 800 }, twice = { tops: [0, 2000, 4000], pageW: 1600, S: 1600 };
  // The point 300px down the pane, page 2's 200th px, at scroll 900: zoomed out it is page 2's 100th px, still 300px down.
  assert.deepEqual(settleView({ W: 800, ox: 400, oy: 1200, top: 900, left: 0, from, to: half }), { top: 600 - 300, left: 0 });
  // Zoomed in about the middle line: the page's middle stays in the pane's middle.
  assert.deepEqual(settleView({ W: 800, ox: 400, oy: 1200, top: 900, left: 0, from, to: twice }), { top: 2400 - 300, left: 400 });
  // Past 100% a view scrolled across keeps its point across, and never past the page's edges.
  assert.deepEqual(settleView({ W: 800, ox: 1200, oy: 0, top: 0, left: 800, from: twice, to: { tops: [0, 1500], pageW: 1200, S: 1200 } }), { top: 0, left: 400 });
  assert.equal(settleView({ W: 800, ox: 400, oy: 0, top: 0, left: 0, from: twice, to: from }).left, 0, 'back to 100%: nothing to scroll across');
  assert.equal(settleView({ W: 800, ox: 400, oy: 10, top: 0, left: 0, from, to: half }).top, 0, 'never above the paper\'s top');
});

test('askedByNote: an answer\'s question is shown only when it is not what its note asks now', async () => {
  const { askedByNote } = await load();
  assert.equal(askedByNote('why is κ good?', '@bart why is κ good?'), true, 'the note\'s own question');
  assert.equal(askedByNote('why  is κ\ngood?', '@Bart   why is κ good? '), true, 'give or take spacing');
  assert.equal(askedByNote('why?', '@bart and then?'), false, 'an earlier question of the thread');
  assert.equal(askedByNote('a plain note', 'a plain note'), true, 'a note that does not start with @bart is compared whole');
  assert.equal(askedByNote('why?', null), false, 'the note is gone: the question is shown');
  assert.equal(askedByNote('', 'anything'), true, 'nothing to show');
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

test('fieldCaret: a field in a scaled box (a PDF note at another zoom) has its caret scaled from its corner', async () => {
  const { fieldCaret } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/workspace/caret.js')).href);
  // The copy is laid out at the field's own size: its caret 30px right of the field's left and 10px under its top.
  const field = { value: 'see @Tu', selectionStart: 7, scrollTop: 0, getBoundingClientRect: () => ({ left: 100, top: 50, bottom: 92 }) };
  const made = [];
  globalThis.getComputedStyle = () => ({});
  globalThis.document = {
    body: { appendChild() {} },
    createElement: () => { const el = { style: {}, textContent: '', appendChild() {}, remove() {}, getClientRects: () => [{ left: 130, top: 60, bottom: 81 }] }; made.push(el); return el; },
  };
  try {
    assert.deepEqual(fieldCaret(field), { left: 130, right: 130, top: 60, bottom: 81 }, 'unscaled, as before');
    assert.deepEqual(fieldCaret(field, 7, 2), { left: 160, right: 160, top: 70, bottom: 112 }, 'at 200%');
    assert.deepEqual(fieldCaret(field, 7, 0.5), { left: 115, right: 115, top: 55, bottom: 65.5 }, 'at 50%');
  } finally { delete globalThis.getComputedStyle; delete globalThis.document; }
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

test('after ⌘R the answers this window had being written come back as main keeps them, but not one held already or ended meanwhile (second pass)', async () => {
  const { runningBack } = await load();
  const held = { h1: { askId: 'h1', markId: 'm1', page: 2, rowId: 'r', url: null, question: 'why?', activity: 'Writing', lines: ['So far'] } };
  const list = [
    { askId: 'h1', markId: 'm1', page: 2, rowId: 'r', url: null, question: 'why?', activity: 'Reading' }, // held: progress goes on into it
    { askId: 'h2', markId: 'm3', page: 5, rowId: null, url: 'https://x.org/a.pdf', question: 'and?', step: 1, name: 'Sonnet', effort: 'high', activity: 'Reading', lines: [], log: ['Reading'], agent: 'bart' },
    { askId: 'h3', markId: 'm4', page: 1, rowId: 'r', url: null, question: 'so?' }, // main said it ended before this came back
    { askId: 'h4' }, null, // no mark: not one of these
  ];
  const next = runningBack(held, list, new Set(['h3']));
  assert.deepEqual(Object.keys(next), ['h1', 'h2']);
  assert.equal(next.h1, held.h1);
  assert.equal(next.h2, list[1]);
  assert.equal(runningBack(held, [list[0]], new Set()), held, 'none back: the same object, no render');
  assert.equal(runningBack(held, null), held);
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
    '@chat is that good?',
    'bart> Yes.',
    'bart>',
    'bart> See p. 6.',
    'bart>',
    'bart> *Sonnet · high · 4 s*',
  ]);
  assert.equal(continueLines({ quote: 'q', question: 'why\nnow', answer: 'A', paper: { name: 'Scim', url: 'https://arxiv.org/pdf/1' }, page: 2 })[0], '“q” ([Scim](https://arxiv.org/pdf/1), p. 2)');
  assert.equal(continueLines({ quote: 'q', question: 'why\nnow', answer: 'A', paper: { name: 'Scim', url: 'https://arxiv.org/pdf/1' }, page: 2 })[1], '@chat why now', 'the question on one line');
});

test('runningLabel: what Bart is doing, a step up, or thinking', async () => {
  const { runningLabel } = await load();
  assert.equal(runningLabel({ activity: 'Reading tutortrace.pdf' }), 'Bart · Reading tutortrace.pdf');
  assert.equal(runningLabel({ activity: '', movedUp: 1, name: 'Opus', effort: 'high' }), 'Bart · Moving up to Opus high');
  assert.equal(runningLabel({ movedUp: 0, name: 'Sonnet', effort: 'high' }), 'Bart · Thinking');
  assert.equal(runningLabel(null), 'Bart · Thinking');
});

test('textColumn: the text runs\' left and right edges, a stray run in the margin left out', async () => {
  const { textColumn } = await load();
  const lefts = [...Array(60).fill(0.12), 0.02], rights = [...Array(60).fill(0.88), 0.99];
  assert.deepEqual(textColumn(lefts, rights), { l: 0.12, r: 0.88 }, 'a line number at 0.02 and a mark at 0.99 do not count');
  const two = [...Array(30).fill(0.1), ...Array(30).fill(0.52)], ends = [...Array(30).fill(0.48), ...Array(30).fill(0.9)];
  assert.deepEqual(textColumn(two, ends), { l: 0.1, r: 0.9 }, 'two columns: the outer edges of both');
  assert.equal(textColumn([0.1, 0.2], [0.8, 0.9]), null, 'too few runs to tell');
  assert.equal(textColumn([], []), null);
});
