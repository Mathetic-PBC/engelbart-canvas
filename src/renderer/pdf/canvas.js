// The page as a canvas (MATH-27 phase 1, 2026-10-06): the parts of PaperView's desk, boxes, zoom presets and highlight
// answers that need no DOM. Geometry is in a layout's own px (the sheets' CSS px before any CSS zoom) unless it says page
// units: fractions of a page's drawn width, which is how marks are kept so they survive a zoom; or desk px.
//
// A true canvas (MATH-27 follow-up, 2026-10-06): everything drawn on the desk scales with the page. Boxes, their arrows and
// the lines between them are laid out in desk px, the px of 100% (the page as wide as the pane), and each page's layer of
// them is scaled by its zoom `k`: a layout px is k desk px. So every constant below is its size at 100%, and at any other
// zoom it is that times k, the page's own factor; a pinch, which scales what is drawn, leaves boxes where the next drawing
// puts them. A page lies on a desk at least DESK desk px wide on each side; a box moved past the desk's edge makes it wider
// (deskNeed). A note is a box; each answer Bart gave from it is a box under it. A box that was moved keeps its place
// (`pos`, page units); the others are placed beside their highlight and then spaced (spaceBoxes), which is never saved.
// Follow-ups (2026-10-06): the boxes hanging under a moved one widen the desk too (deskNeed, hangLeft); a deleted answer
// stays one of its exchange's turns while that session can be resumed (exchangeOf), so ⌘Z can bring it back and the
// next question goes on in the same session.
// One card a highlight (2026-10-06): a highlight's note and its answers are one card, like a comment thread, ASK_W wide
// throughout, with one grip and one place (the mark's `pos`); an answer moved on its own before (an ask's `pos`) is
// shown in its card, its `pos` no longer read. Nothing joins boxes any more, and nothing hangs under a moved one.

/** Side space that centers a page of width pageW in a pane of width W (0 once the page is wider). */
export const sideSpace = (W, pageW) => Math.max(0, Math.floor((W - pageW) / 2));

export const DESK = 400; // desk px of desk beside a page, each side
export const BOX_GAP = 12; // desk px kept between two boxes by the spacing pass
export const DESK_EDGE = 24; // desk px a moved box keeps from the desk's edge (the desk grows to keep it)
export const NOTE_W = 240; // a note's box, on the desk
export const ASK_W = 320; // a highlight's card: its note and its answers
export const SIDE_GAP = 28; // a box beside its page: desk px from the page's edge
export const POS_DY = 11; // `pos` is where a box's first line sits: 11px under its top, as free notes were always kept

/**
 * The desk on each side of a page `pageW` wide in a pane `W` wide, at zoom `k` → { G, R } layout px: G is also where the
 * page starts. DESK and `need` ({ left, right }, deskNeed's) are desk px, so k times as wide in a layout.
 */
export function deskOf(W, pageW, need = {}, k = 1) {
  const side = sideSpace(W, pageW), desk = Math.ceil(DESK * k);
  return { G: Math.max(side, desk, Math.ceil((need.left || 0) * k)), R: Math.max(side, desk, Math.ceil((need.right || 0) * k)) };
}

/**
 * How wide the desk must be on each side so every card that was moved keeps DESK_EDGE from its edge, at the page widths
 * `pageWOf(page)` in desk px → { left, right } desk px (0 when nothing reaches past the page). A mark is a card while it
 * has a note, an answer shown (deleted ones are not) or `running(markId)` answers being written: ASK_W wide on a
 * highlight, NOTE_W for a free note. Cards beside the page always fit the DESK.
 */
export function deskNeed(marks, pageWOf, running = () => 0) {
  let left = 0, right = 0;
  for (const [page, list] of Object.entries(marks || {})) {
    const P = pageWOf(Number(page));
    if (!P) continue;
    for (const m of list || []) {
      if (!m || !m.pos || (m.note == null && !shownAsks(m).length && !(Number(running(m.id)) > 0))) continue;
      const x = Number(m.pos.x) * P, w = (m.rects || []).length ? ASK_W : NOTE_W;
      if (!Number.isFinite(x)) continue;
      left = Math.max(left, DESK_EDGE - x);
      right = Math.max(right, x + w + DESK_EDGE - P);
    }
  }
  return { left, right };
}

/** A page's layout geometry ({ G, R, pageW } layout px, `k` its zoom) in desk px, where its boxes are laid out. */
export const deskGeom = (g) => { const k = (g && g.k) || 1; return { G: (g.G || 0) / k, R: (g.R || 0) / k, pageW: (g.pageW || 0) / k, k }; };

/** A box kept in page units → its top-left in a sheet whose page starts at G and is P wide (desk px); and back. */
export const placeOf = (pos, G, P) => ({ left: G + pos.x * P, top: pos.y * P - POS_DY });
export const posOf = (left, top, G, P) => ({ x: (left - G) / P, y: (top + POS_DY) / P });

/**
 * The spacing pass. `units`: boxes that move together, stacked `gap` apart ({ id, want, boxes: [{ left, width, height }] }).
 * In the order they want to be (their `want`, the top they would have alone), each unit goes to the first top from
 * `want` down at which none of its boxes is nearer than `gap` to a box already there that shares any of its x: a `fixed`
 * box ({ left, top, width, height }: one that was moved, and stays) or a unit placed before it. So the boxes of a column
 * read top = max(wanted, previous bottom + gap), and flow around the ones that were moved. → Map id → top.
 */
export function spaceBoxes(units, fixed = [], gap = BOX_GAP) {
  const placed = (fixed || []).map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
  const out = new Map();
  const order = (units || []).map((u, i) => ({ u, i })).sort((a, b) => a.u.want - b.u.want || a.i - b.i);
  for (const { u } of order) {
    const offs = [];
    let o = 0;
    for (const b of u.boxes) { offs.push(o); o += b.height + gap; }
    let top = u.want;
    for (let guard = 0; guard < 10000; guard += 1) {
      let push = null;
      u.boxes.forEach((b, k) => {
        const y0 = top + offs[k], y1 = y0 + b.height;
        for (const r of placed) {
          if (r.left >= b.left + b.width || b.left >= r.left + r.width) continue; // no x in common
          if (y1 + gap <= r.top || r.top + r.height + gap <= y0) continue; // far enough apart
          const below = r.top + r.height + gap - offs[k];
          if (push == null || below > push) push = below;
        }
      });
      if (push == null || push <= top) break;
      top = push;
    }
    out.set(u.id, top);
    u.boxes.forEach((b, k) => placed.push({ left: b.left, width: b.width, top: top + offs[k], height: b.height }));
  }
  return out;
}

/**
 * Where a page and its boxes reach at zoom z, from the page's top-left → { left, top, right, bottom }. The page is
 * pageW1 × pageH1 at zoom 1. A box's left and top are `x.a·P + x.b·z` and `y.a·P + y.b·z` with P the page's width at z (a
 * moved box keeps its page units, a box beside the page its desk px from the edge); its width and height are desk px,
 * z times as many at z.
 */
export function extentAt({ pageW1, pageH1, boxes = [] }, z) {
  const P = pageW1 * z;
  let left = 0, top = 0, right = P, bottom = pageH1 * z;
  for (const b of boxes) {
    const x = b.x.a * P + b.x.b * z, y = b.y.a * P + b.y.b * z;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x + b.w * z); bottom = Math.max(bottom, y + b.h * z);
  }
  return { left, top, right, bottom };
}

/**
 * "Fit page" (no boxes) and "Fit page + notes": the largest zoom from `zMax` down to `zMin` at which the page and its
 * boxes fit `availW` × `availH` (extentAt); `zMin` when nothing does. Only the page in view and its own boxes count: a
 * fit that took in every page's boxes zoomed a long paper down to the least zoom (undone 2026-10-06).
 */
export function fitZoom({ pageW1, pageH1, boxes = [], availW, availH, zMin, zMax }) {
  const fits = (z) => { const e = extentAt({ pageW1, pageH1, boxes }, z); return e.right - e.left <= availW && e.bottom - e.top <= availH; };
  if (fits(zMax)) return zMax;
  if (!fits(zMin)) return zMin;
  let lo = zMin, hi = zMax;
  for (let i = 0; i < 30; i += 1) { const mid = (lo + hi) / 2; if (fits(mid)) lo = mid; else hi = mid; }
  return lo;
}

/**
 * Which way each box lies outside the view (client rects), by its center: left or right when it is level with the view,
 * else up or down; boxes whose center is in view are not counted. → { left, right, up, down } counts.
 */
export function offscreen(boxes, view) {
  const out = { left: 0, right: 0, up: 0, down: 0 };
  for (const r of boxes || []) { const side = offscreenSide(r, view); if (side) out[side] += 1; }
  return out;
}

/** The edge a box (client rect) lies beyond, by its center: 'left', 'right', 'up', 'down', or null in view. */
export function offscreenSide(r, view) {
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  if (cy < view.top) return 'up';
  if (cy > view.bottom) return 'down';
  if (cx < view.left) return 'left';
  if (cx > view.right) return 'right';
  return null;
}

/** "2 notes →": a chip's words for `n` boxes off one edge. */
export function chipLabel(n, side) {
  const words = `${n} ${n === 1 ? 'note' : 'notes'}`;
  return side === 'left' ? `← ${words}` : side === 'right' ? `${words} →` : side === 'up' ? `${words} ↑` : `${words} ↓`;
}

/**
 * How far to scroll (dx, dy) so the boxes off one edge come into view, `pad` px inside it: all of them when they fit,
 * else the nearest. Boxes above or below that are also off to one side are brought across too. Rects are client rects,
 * `view` the pane's.
 */
export function revealScroll(boxes, view, side, pad = 24) {
  if (!boxes.length) return { dx: 0, dy: 0 };
  const across = side === 'left' || side === 'right';
  const near = [...boxes].sort((a, b) => (side === 'left' ? b.left - a.left : side === 'right' ? a.left - b.left : side === 'up' ? b.top - a.top : a.top - b.top));
  const span = (list) => ({ left: Math.min(...list.map((r) => r.left)), top: Math.min(...list.map((r) => r.top)), right: Math.max(...list.map((r) => r.left + r.width)), bottom: Math.max(...list.map((r) => r.top + r.height)) });
  const room = across ? view.right - view.left - 2 * pad : view.bottom - view.top - 2 * pad;
  let all = span(boxes);
  if ((across ? all.right - all.left : all.bottom - all.top) > room) all = span([near[0]]);
  if (side === 'left') return { dx: all.left - pad - view.left, dy: 0 };
  if (side === 'right') return { dx: all.right + pad - view.right, dy: 0 };
  const dx = all.left < view.left ? all.left - pad - view.left : all.right > view.right ? Math.min(all.right + pad - view.right, all.left - pad - view.left) : 0;
  if (side === 'up') return { dx, dy: all.top - pad - view.top };
  return { dx, dy: all.bottom + pad - view.bottom };
}

/* ------------------------------------------------------------------------------- blank space and arrows (2026-10-06) */
// A drag on blank space pans (MATH-27 follow-up, 2026-10-06), one on or near text selects. Blank is the desk beside a page,
// and the page where no text span is within LINE desk px: margins, the gaps round a figure, the empty end of a page. The
// small gaps between lines and words are near text. A card's arrow to its highlight is drawn only when the card is not
// beside it: moved, in the other margin, or pushed down more than ARROW_LINES lines.

export const LINE = 14; // desk px: about a line of a paper's body text at 100%
export const ARROW_LINES = 2; // a card this many lines (LINE) below its highlight's top is not beside it any more
export const PRESS_MOVE = 4; // px: a press that moves less is a click, not a drag

/** The distance from (x, y) to a rect { left, top, right, bottom } (0 inside it). */
export const rectDistance = (r, x, y) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));

/**
 * Whether a point is blank: off the page `page` ({ left, top, right, bottom }, the same px as everything else), or on it
 * further than `reach` from every rect in `spans` (the text layer's spans). → boolean.
 */
export function blankAt(page, spans, x, y, reach) {
  if (!page || x < page.left || x > page.right || y < page.top || y > page.bottom) return true;
  for (const r of spans || []) if (r && r.right > r.left && r.bottom > r.top && rectDistance(r, x, y) <= reach) return false;
  return true;
}

/**
 * Whether a highlight's card is beside it, so needs no arrow (desk px): not moved (`moved`), in the margin of its highlight
 * (`side`, where it was made; `drawnSide`, the margin the spacing put it in) and its top no more than ARROW_LINES lines
 * (`line`, LINE) below the highlight's top.
 */
export const besideHighlight = ({ moved, side, drawnSide, cardTop, markTop, line = LINE }) =>
  !moved && (side === 'left' ? 'left' : 'right') === drawnSide && cardTop - markTop <= ARROW_LINES * line;

/**
 * An arrow from a highlight (its bounds `hl` { left, top, right, bottom }, `first` the middle of its first line's height) to
 * its card (`card` { left, top, width, height }), desk px → { from, to } points: from the highlight's edge nearest the
 * card to the card's near edge, level with its first line (POS_DY down); a card above or below the highlight is reached
 * at its bottom or top edge.
 */
export function arrowEnds(hl, card, first = (hl.top + hl.bottom) / 2) {
  const right = card.left + card.width, bottom = card.top + card.height;
  const level = Math.min(bottom - 4, card.top + POS_DY);
  if (card.left >= hl.right) return { from: { x: hl.right + 3, y: first }, to: { x: card.left + 2, y: level } };
  if (right <= hl.left) return { from: { x: hl.left - 3, y: first }, to: { x: right - 4, y: level } };
  const x = Math.max(card.left + 8, Math.min(right - 8, (hl.left + hl.right) / 2));
  if (card.top >= hl.bottom) return { from: { x: (hl.left + hl.right) / 2, y: hl.bottom + 2 }, to: { x, y: card.top - 2 } };
  return { from: { x: (hl.left + hl.right) / 2, y: hl.top - 2 }, to: { x, y: bottom + 2 } };
}

/* ------------------------------------------------------------------------------------------- answers on a highlight */

// What a mark keeps of an answer, and putting one on it: shared with main, which lands an answer itself (2026-10-06).
export { answerOf, askEntry, withAsk } from '../../shared/mark-answers.cjs';

export const THREAD_IDLE_MS = 30 * 60_000; // main's bart/ask.cjs: how long after its last turn a session can be resumed

/** The answers a mark shows: all but those deleted (`deleted`, see exchangeOf). */
export const shownAsks = (m) => ((m && m.asks) || []).filter((a) => a && !a.deleted);

/**
 * A mark's exchange as it stands at `now`: its answers in order, a deleted one among them while the session that heard
 * it can still be resumed (THREAD_IDLE_MS after the newest answer). Main finds that session by every turn said in it
 * (ask.cjs threadKey), so the next question goes on in it, and ⌘Z can bring the answer back. Once the session is gone a
 * deleted answer is gone too: the next question starts a new one, given the turns that are left.
 */
export function exchangeOf(m, now = Date.now()) {
  const asks = ((m && m.asks) || []).filter(Boolean);
  if (!asks.some((a) => a.deleted)) return asks;
  const last = Math.max(...asks.map((a) => Date.parse(a.at) || 0));
  return now - last < THREAD_IDLE_MS ? asks : asks.filter((a) => !a.deleted);
}

/** A free note with nothing in it (2026-10-06): it goes when it loses the keyboard, and is never saved. */
export const emptyFree = (m) => !!m && !(m.rects || []).length && !String(m.note == null ? '' : m.note).trim() && !shownAsks(m).length;

/**
 * A page's marks as they are saved at `now`: a deleted answer whose session is gone is dropped (exchangeOf), and so is a
 * free note still empty (emptyFree).
 */
export const keptMarks = (list, now = Date.now()) => (list || []).filter((m) => !emptyFree(m)).map((m) => {
  if (!m || !Array.isArray(m.asks) || !m.asks.some((a) => a && a.deleted)) return m;
  const asks = exchangeOf(m, now);
  return asks.length === m.asks.length ? m : { ...m, asks };
});

/** The earlier turns of a mark's exchange at `now`, as a follow-up sends them (ipc ask-bart `turns`). */
export const turnsOf = (m, now) => exchangeOf(m, now).filter((a) => typeof a.question === 'string').map((a) => ({ question: a.question, answer: String(a.answer || '') }));

/**
 * The answers being written as the workspace keeps them ({ [askId]: ask }), with those main says this window asked and
 * are still running (ipc running-paper-asks) brought back, as after ⌘R (second pass, 2026-10-06). One held already, or
 * that has ended since (`ended`: the ask ids main said were done), is not. The same object when none comes back.
 */
export function runningBack(current, list, ended = new Set()) {
  const back = (Array.isArray(list) ? list : []).filter((ask) => ask && ask.askId && ask.markId && !current[ask.askId] && !ended.has(ask.askId));
  return back.length ? { ...current, ...Object.fromEntries(back.map((ask) => [ask.askId, ask])) } : current;
}

/** A note asks Bart when it starts with @bart: → the question (what follows, flags and all), or null. */
export function noteQuestion(note) {
  const m = String(note == null ? '' : note).match(/^\s*@bart(?=\s|$)([\s\S]*)$/i);
  return m ? m[1].trim() : null;
}

/**
 * What Continue in workspace appends to the open workspace (a normal thread): the passage and where it is, then the
 * question and the answer as the document holds an asked @bart line and its answer. `paper` { name, rowId, url }.
 */
export function continueLines({ quote, question, answer, foot, paper = {}, page }) {
  const name = String(paper.name || 'the paper').replace(/[[\]\n]/g, '').trim() || 'the paper';
  const where = paper.rowId ? `@[${name}]` : paper.url && /^https?:/i.test(paper.url) ? `[${name}](${paper.url})` : name;
  const said = String(quote || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  if (said) lines.push(`“${said}” (${where}${page ? `, p. ${page}` : ''})`);
  lines.push(`@bart ${String(question || '').replace(/\s*\n\s*/g, ' ').trim()}`);
  for (const line of String(answer || '').split('\n')) lines.push(`bart> ${line}`.trimEnd());
  if (foot) lines.push('bart>', `bart> *${foot}*`);
  return lines;
}

/**
 * Whether an answer's question is what its note asks now (one card, 2026-10-06): the note's question after @bart, or the
 * note itself, the same words give or take spacing. Its grey header is shown only when not: an earlier question of the
 * thread. A question that is empty has nothing to show either.
 */
export function askedByNote(question, note) {
  const squash = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const q = squash(question);
  if (!q) return true;
  const asks = noteQuestion(note);
  return q === squash(asks != null ? asks : note);
}

/** What the box's header names the model by: "Sol · high". */
export const modelLabel = (meta) => (meta && meta.name ? [meta.name, meta.effort].filter(Boolean).join(' · ') : '');

/** The header of an answer still being written: "Bart · Reading …", "Bart · Moving up to Opus high", "Bart · Thinking". */
export function runningLabel(ask) {
  if (!ask) return 'Bart · Thinking';
  if (ask.activity) return `Bart · ${ask.activity}`;
  if (ask.movedUp && ask.name) return `Bart · Moving up to ${[ask.name, ask.effort].filter(Boolean).join(' ')}`;
  return 'Bart · Thinking';
}
