// The page as a canvas (MATH-27 phase 1, 2026-10-06): the parts of PaperView's desk, boxes, zoom presets and highlight
// answers that need no DOM. Geometry is in a layout's own px (the sheets' CSS px before any CSS zoom) unless it says page
// units: fractions of a page's drawn width, which is how marks are kept so they survive a zoom.
//
// A page lies on a desk at least DESK px wide on each side, at every zoom; a box moved past the desk's edge makes it wider
// (deskNeed). A note is a box; each answer Bart gave from it is a box under it. A box that was moved keeps its place
// (`pos`, page units); the others are placed beside their highlight and then spaced (spaceBoxes), which is never saved.
// Follow-ups (2026-10-06): the boxes hanging under a moved one widen the desk too (deskNeed, hangLeft); Fit page + notes
// reads every page's boxes (paperShape); a deleted answer stays one of its exchange's turns while that session can be
// resumed (exchangeOf), so ⌘Z can bring it back and the next question goes on in the same session.

/** Side space that centers a page of width pageW in a pane of width W (0 once the page is wider). */
export const sideSpace = (W, pageW) => Math.max(0, Math.floor((W - pageW) / 2));

export const DESK = 400; // px of desk beside a page, each side, at every zoom
export const BOX_GAP = 12; // px kept between two boxes by the spacing pass
export const DESK_EDGE = 24; // px a moved box keeps from the desk's edge (the desk grows to keep it)
export const NOTE_W = 240; // a note's box, on the desk
export const ASK_W = 320; // an answer's box
export const COLLAPSED_W = 96; // an answer folded to "Bart ›"
export const SIDE_GAP = 28; // a box beside its page: px from the page's edge
export const POS_DY = 11; // `pos` is where a box's first line sits: 11px under its top, as free notes were always kept

/** The desk on each side of a page `pageW` wide in a pane `W` wide → { G, R }: G is also where the page starts. */
export function deskOf(W, pageW, need = {}) {
  const side = sideSpace(W, pageW);
  return { G: Math.max(side, DESK, Math.ceil(need.left || 0)), R: Math.max(side, DESK, Math.ceil(need.right || 0)) };
}

/**
 * Where a box that hangs under a moved one starts (PaperView arrange): from the edge of that box nearest the page's
 * middle `mid`, so it reaches toward the page and not past the desk. `pLeft`, `pWidth`: the box it hangs from.
 */
export const hangLeft = (pLeft, pWidth, width, mid) => (pLeft + pWidth / 2 < mid ? pLeft + pWidth - width : pLeft);

/**
 * How wide the desk must be on each side so every box that was moved, and every box hanging under one, keeps DESK_EDGE
 * from its edge, at the page widths `pageWOf(page)` → { left, right } px (0 when nothing reaches past the page). A
 * mark's boxes go as PaperView draws them: its note, its answers (deleted ones are not drawn; one folded away is
 * narrower), then `running(markId)` answers being written; a box not moved hangs from the last moved one before it
 * (hangLeft). Boxes beside the page, before any moved one, always fit the DESK.
 */
export function deskNeed(marks, pageWOf, running = () => 0) {
  let left = 0, right = 0;
  for (const [page, list] of Object.entries(marks || {})) {
    const P = pageWOf(Number(page));
    if (!P) continue;
    const reach = (x, w) => { left = Math.max(left, DESK_EDGE - x); right = Math.max(right, x + w + DESK_EDGE - P); };
    for (const m of list || []) {
      if (!m) continue;
      const chain = m.note != null ? [{ pos: m.pos, w: NOTE_W }] : [];
      for (const a of shownAsks(m)) chain.push({ pos: a.pos, w: a.collapsed ? COLLAPSED_W : ASK_W });
      for (let i = Number(running(m.id)) || 0; i > 0; i -= 1) chain.push({ pos: null, w: ASK_W });
      let from = null; // the moved box the next ones hang from
      for (const { pos, w } of chain) {
        if (pos) {
          const x = Number(pos.x) * P;
          from = Number.isFinite(x) ? { x, w } : null;
          if (from) reach(x, w);
        } else if (from) reach(hangLeft(from.x, from.w, w, P / 2), w);
      }
    }
  }
  return { left, right };
}

/** A box kept in page units → its top-left in a sheet whose page starts at G and is P wide; and back. */
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
 * pageW1 × pageH1 at zoom 1. A box's left and top are `x.a·P + x.b` and `y.a·P + y.b` with P the page's width at z (a
 * moved box keeps its page units, a box beside the page its px from the edge); its width and height are px at any zoom.
 * With `pages` (paperShape), several pages each at its own place (`at`: its top-left is at.x.a·z + at.x.b, at.y.a·z +
 * at.y.b), of which only those `whole` count with their page; the others count with their boxes alone.
 */
export function extentAt(shape, z) {
  const pages = shape.pages || [{ ...shape, whole: true }];
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const take = (l, t, r, b) => { left = Math.min(left, l); top = Math.min(top, t); right = Math.max(right, r); bottom = Math.max(bottom, b); };
  for (const p of pages) {
    const P = p.pageW1 * z, at = p.at || { x: { a: 0, b: 0 }, y: { a: 0, b: 0 } };
    const x0 = at.x.a * z + at.x.b, y0 = at.y.a * z + at.y.b;
    if (p.whole) take(x0, y0, x0 + P, y0 + p.pageH1 * z);
    for (const b of p.boxes || []) {
      const x = x0 + b.x.a * P + b.x.b, y = y0 + b.y.a * P + b.y.b;
      take(x, y, x + b.w, y + b.h);
    }
  }
  return left === Infinity ? { left: 0, top: 0, right: 0, bottom: 0 } : { left, top, right, bottom };
}

/**
 * The paper as Fit page + notes reads it (extentAt's `pages`): `list`, every page in order ({ pageW1, pageH1, boxes } at
 * zoom 1, boxes as extentAt reads them), stacked as PaperView lays them out, each 1px under the one before (a gap that
 * does not zoom) and all centered on one axis, x = 0. Page `current` (1-based, the one in view) counts whole; the
 * others with their boxes alone. → the pages, each with its `at` and `whole`.
 */
export function paperShape(list, current) {
  let above = 0;
  return (list || []).map((p, i) => {
    const at = { x: { a: -p.pageW1 / 2, b: 0 }, y: { a: above, b: i } };
    above += p.pageH1;
    return { ...p, at, whole: i + 1 === current };
  });
}

/**
 * "Fit page" (no boxes) and "Fit page + notes": the largest zoom from `zMax` down to `zMin` at which the page and its
 * boxes (or the `pages` and their boxes) fit `availW` × `availH` (extentAt); `zMin` when nothing does.
 */
export function fitZoom({ pageW1, pageH1, boxes = [], pages, availW, availH, zMin, zMax }) {
  const shape = pages ? { pages } : { pageW1, pageH1, boxes };
  const fits = (z) => { const e = extentAt(shape, z); return e.right - e.left <= availW && e.bottom - e.top <= availH; };
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

/* ------------------------------------------------------------------------------------------- answers on a highlight */

const ATTRIBUTION = /^\*([^*]+)\*$/;

/**
 * An answer's lines as main sends them (`bart> …`, then a blank line and its foot, "*Sol · high · 12 s*") → { answer,
 * foot }: the answer as the document would hold it and as a follow-up sends it back (main: bart/reply.cjs answerText),
 * so the follow-up finds the same session (ask.cjs threadKey); the foot without its stars.
 */
export function answerOf(lines) {
  const body = (Array.isArray(lines) ? lines : []).map((line) => String(line).replace(/^bart\+?> ?/, ''));
  let foot = '';
  const last = body.length ? body[body.length - 1].match(ATTRIBUTION) : null;
  if (last) { foot = last[1]; body.pop(); }
  return { answer: body.join('\n').trim(), foot };
}

/** A finished answer as a mark keeps it: { id, question, answer, meta, at, pos, collapsed }. */
export function askEntry({ id, question, lines, meta, at }) {
  const { answer, foot } = answerOf(lines);
  const level = (meta && meta.level) || {};
  return {
    id,
    question: String(question || '').trim(),
    answer,
    meta: { provider: (meta && meta.provider) || null, name: level.name || null, effort: level.effort || null, ms: (meta && meta.ms) || null, foot },
    at,
    pos: null,
    collapsed: false,
  };
}

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

/** A page's marks as they are saved at `now`: a deleted answer whose session is gone is dropped (exchangeOf). */
export const keptMarks = (list, now = Date.now()) => (list || []).map((m) => {
  if (!m || !Array.isArray(m.asks) || !m.asks.some((a) => a && a.deleted)) return m;
  const asks = exchangeOf(m, now);
  return asks.length === m.asks.length ? m : { ...m, asks };
});

/** The earlier turns of a mark's exchange at `now`, as a follow-up sends them (ipc ask-bart `turns`). */
export const turnsOf = (m, now) => exchangeOf(m, now).filter((a) => typeof a.question === 'string').map((a) => ({ question: a.question, answer: String(a.answer || '') }));

/** The marks with `entry` added to the answers of mark `markId` on `page` (once). Unchanged when the mark is gone. */
export function withAsk(marks, page, markId, entry) {
  const list = (marks || {})[page];
  if (!Array.isArray(list) || !list.some((m) => m && m.id === markId)) return marks || {};
  return {
    ...marks,
    [page]: list.map((m) => (m && m.id === markId && !(m.asks || []).some((a) => a && a.id === entry.id) ? { ...m, asks: [...(m.asks || []), entry] } : m)),
  };
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

/** What the box's header names the model by: "Sol · high". */
export const modelLabel = (meta) => (meta && meta.name ? [meta.name, meta.effort].filter(Boolean).join(' · ') : '');

/** The header of an answer still being written: "Bart · Reading …", "Bart · Moving up to Opus high", "Bart · Thinking". */
export function runningLabel(ask) {
  if (!ask) return 'Bart · Thinking';
  if (ask.activity) return `Bart · ${ask.activity}`;
  if (ask.movedUp && ask.name) return `Bart · Moving up to ${[ask.name, ask.effort].filter(Boolean).join(' ')}`;
  return 'Bart · Thinking';
}
