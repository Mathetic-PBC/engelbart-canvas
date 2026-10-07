'use strict';

// The page as a canvas (src/renderer/pdf/canvas.js, MATH-27 phase 1, 2026-10-06): the desk beside every page, the spacing
// pass that keeps boxes 12px apart and flowing around the ones that were moved, Fit page + notes, which boxes are out of
// view, and the answers a highlight keeps. Follow-ups (2026-10-06): answers hanging under a moved note widen the desk,
// a deleted answer stays a turn while its session lasts. Fit page + notes reads the page in view alone (a fit of every
// page's boxes was tried and undone, 2026-10-06: it zoomed a long paper with notes far apart down to 15%).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');

const load = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/pdf/canvas.js')).href);

// PaperView itself, bundled as paper-note-ask.test.cjs does (pdf.js and rough.js are not loaded).
function loadView() {
  globalThis.document = { baseURI: 'file:///app/index.html' };
  const filename = path.join(__dirname, '__PaperView-canvas-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/pdf/PaperView.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom', 'pdfjs-dist', 'roughjs'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const stubs = { 'pdfjs-dist': { GlobalWorkerOptions: {} }, roughjs: { __esModule: true, default: null } };
  compiled.require = (id) => (id in stubs ? stubs[id] : Module.prototype.require.call(compiled, id));
  compiled._compile(bundled.outputFiles[0].text, filename);
  delete globalThis.document;
  return compiled.exports;
}

/* ------------------------------------------------------------------------------------------------ the desk */

test('deskOf: DESK desk px each side, scaled with the page, more when the pane centers a narrow page, more when a moved box needs it', async () => {
  const { deskOf, deskGeom, DESK } = await load();
  assert.equal(DESK, 400);
  assert.deepEqual(deskOf(800, 800), { G: 400, R: 400 }, '100%: the page as wide as the pane, a desk beside it all the same');
  assert.deepEqual(deskOf(800, 1600, {}, 2), { G: 800, R: 800 }, '200%: the desk twice as wide, as the page is (true canvas, 2026-10-06)');
  assert.deepEqual(deskOf(800, 400, {}, 0.5), { G: 200, R: 200 }, '50%');
  assert.deepEqual(deskOf(2000, 120, {}, 0.15), { G: 940, R: 940 }, '15% in a wide pane: centered');
  assert.deepEqual(deskOf(800, 800, { left: 520.2, right: 0 }), { G: 521, R: 400 }, 'one side widened alone');
  assert.deepEqual(deskOf(800, 1600, { left: 520.2, right: 0 }, 2), { G: 1041, R: 800 }, 'by desk px, k times as many in the layout');
  assert.deepEqual(deskGeom({ G: 1041, R: 800, pageW: 1600, k: 2 }), { G: 520.5, R: 400, pageW: 800, k: 2 }, 'a page\'s layout in desk px');
});

test('deskNeed: how far past its page each moved card reaches, plus the desk\'s edge; cards not moved need nothing', async () => {
  const { deskNeed, DESK_EDGE, NOTE_W, ASK_W } = await load();
  const P = 500;
  assert.deepEqual(deskNeed({ 1: [{ id: 'a', note: 'beside', pos: null, rects: [{}] }] }, () => P), { left: 0, right: 0 });
  const marks = {
    1: [{ id: 'a', note: 'far left', rects: [{}], pos: { x: -1.2, y: 0.1 } }],
    2: [{ id: 'b', note: null, rects: [{}], pos: { x: 1.5, y: 0 }, asks: [{ id: 'q' }] }],
  };
  const need = deskNeed(marks, () => P);
  assert.equal(need.left, DESK_EDGE + 1.2 * P);
  assert.equal(need.right, 1.5 * P + ASK_W + DESK_EDGE - P, 'a mark without a note is a card of its answers');
  assert.equal(deskNeed({ 3: [{ note: 'x', pos: { x: 0.9, y: 0 } }] }, () => P).right, 0.9 * P + NOTE_W + DESK_EDGE - P, 'a free note');
  assert.deepEqual(deskNeed({ 9: [{ note: 'x', pos: { x: -3, y: 0 } }] }, () => 0), { left: 0, right: 0 }, 'a page not laid out counts for nothing');
});

test('deskNeed: one card a highlight (2026-10-06): a card ASK_W wide at the mark\'s place; an answer\'s own `pos` is not read', async () => {
  const { deskNeed, DESK, DESK_EDGE } = await load();
  const P = 500;
  const answer = (id, more = {}) => ({ id, question: 'q', answer: 'a', pos: null, collapsed: false, ...more });
  const x = -0.9 * P;
  const left = { 1: [{ id: 'm', note: '@bart q', rects: [{}], pos: { x: -0.9, y: 0.1 }, asks: [answer('a1'), answer('a2', { pos: { x: -3, y: 0.5 } })] }] };
  assert.deepEqual(deskNeed(left, () => P), { left: DESK_EDGE - x, right: 0 }, 'the card where the mark was moved; a2 moved on its own before is in it');
  assert.ok(deskNeed(left, () => P).left > DESK, 'past the 400px desk: it widens');
  // A mark with nothing left to show is no card: a deleted answer and no note.
  const gone = { 1: [{ id: 'm', note: null, rects: [{}], pos: { x: -0.9, y: 0.1 }, asks: [answer('a1', { deleted: true })] }] };
  assert.deepEqual(deskNeed(gone, () => P), { left: 0, right: 0 });
  assert.equal(deskNeed(gone, () => P, (id) => (id === 'm' ? 1 : 0)).left, DESK_EDGE - x, 'an answer being written makes it one again');
  // Cards beside the page fit the desk as it is.
  const beside = { 1: [{ id: 'm', note: 'n', rects: [{}], side: 'left', pos: null, asks: [answer('a1', { pos: { x: -2, y: 0 } })] }] };
  assert.deepEqual(deskNeed(beside, () => P, () => 2), { left: 0, right: 0 });
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
  // The boxes scale with the page (true canvas, 2026-10-06): their extent at 2 is twice theirs at 1.
  const one = extentAt({ ...page, boxes }, 1), two = extentAt({ ...page, boxes }, 2);
  for (const key of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(two[key] - 2 * one[key]) < 1e-9, key);
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

test('Fit page + notes fits the page in view and the boxes beside it alone: a note pages away does not zoom it out', async () => {
  const { fitZoom, extentAt } = await load();
  const { default: PaperView, ZOOM_MIN, ZOOM_MAX } = loadView();
  const beside = { x: { a: 1, b: 28 }, y: { a: 0.1, b: 0 }, w: 320, h: 120 };
  const far = { x: { a: -0.4, b: 0 }, y: { a: 0.9, b: 0 }, w: 320, h: 120 };
  // A twelve-page paper, page 1 in view with a note beside it, and a note on every other page.
  const W = 800, H = 700, v = { width: 612, height: 792 };
  const view = new PaperView({});
  const read = [];
  let centered = null;
  Object.assign(view, {
    host: { current: { clientWidth: W, clientHeight: H } }, doc: {}, inner: {},
    v0: [null, ...Array.from({ length: 12 }, () => v)],
    currentPage: () => 1,
    boxShapes: (n) => { read.push(n); return n === 1 ? [beside] : [far]; },
    layout(_, done) { this.geo = { 1: { pageW: v.width * this.unit(W) * this.zoom } }; done(); },
    centerOn: (n, x, y) => { centered = { n, x, y }; },
  });
  const page = { pageW1: W, pageH1: v.height * (W / v.width), availW: W - 48, availH: H - 48 - 50, zMin: ZOOM_MIN, zMax: ZOOM_MAX };
  view.fitPage(true);
  assert.deepEqual(read, [1], 'only the page in view\'s boxes are read');
  assert.equal(view.zoom, fitZoom({ ...page, boxes: [beside] }), 'the page and the note beside it');
  assert.ok(view.zoom > 0.4, 'nowhere near the least zoom');
  const e = extentAt({ ...page, boxes: [beside] }, view.zoom);
  assert.equal(centered.n, 1);
  assert.ok(Math.abs(centered.x - (e.left + e.right) / 2) < 1e-6 && Math.abs(centered.y - (e.top + e.bottom) / 2) < 1e-6, 'centered on them');
  read.length = 0;
  view.fitPage(false);
  assert.deepEqual(read, [], 'Fit page reads no boxes');
  assert.equal(view.zoom, fitZoom(page));
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

test('textColumn: the text runs\' left and right edges, a stray run in the margin left out', async () => {
  const { textColumn } = await load();
  const lefts = [...Array(60).fill(0.12), 0.02], rights = [...Array(60).fill(0.88), 0.99];
  assert.deepEqual(textColumn(lefts, rights), { l: 0.12, r: 0.88 }, 'a line number at 0.02 and a mark at 0.99 do not count');
  const two = [...Array(30).fill(0.1), ...Array(30).fill(0.52)], ends = [...Array(30).fill(0.48), ...Array(30).fill(0.9)];
  assert.deepEqual(textColumn(two, ends), { l: 0.1, r: 0.9 }, 'two columns: the outer edges of both');
  assert.equal(textColumn([0.1, 0.2], [0.8, 0.9]), null, 'too few runs to tell');
  assert.equal(textColumn([], []), null);
});
