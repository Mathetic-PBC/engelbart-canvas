// The page as a canvas (MATH-27 phase 1, 2026-10-06): the parts of PaperView's desk, boxes, zoom presets and highlight
// answers that need no DOM. Geometry is in a layout's own px (the sheets' CSS px before any CSS zoom) unless it says page
// units: fractions of a page's drawn width, which is how marks are kept so they survive a zoom; or desk px.
//
// A true canvas (MATH-27 follow-up, 2026-10-06): everything drawn on the desk scales with the page. Boxes and
// the lines between them are laid out in desk px, the px of 100% (the page as wide as the pane), and each page's layer of
// them is scaled by its zoom `k`: a layout px is k desk px. So every constant below is its size at 100%, and at any other
// zoom it is that times k, the page's own factor; a pinch, which scales what is drawn, leaves boxes where the next drawing
// puts them. A page lies on a desk at least DESK desk px wide on each side; a box moved past the desk's edge makes it wider
// (deskNeed). A note is a box; each answer Bart gave from it is a box under it. A box that was moved keeps its place
// (`pos`, page units); the others are placed beside their highlight and then spaced (spaceBoxes), which is never saved.
// Follow-ups (2026-10-06): the boxes hanging under a moved one widen the desk too (deskNeed, hangLeft); a deleted answer
// stays one of its exchange's turns while that session can be resumed (exchangeOf), so ⌘Z can bring it back and the
// next question goes on in the same session.
// One card a highlight (2026-10-06): a highlight's note and its answers are one card, like a comment thread, with one
// place (the mark's `pos`); an answer moved on its own before (an ask's `pos`) is shown in its card, its `pos` no longer
// read. Nothing joins boxes any more, and nothing hangs under a moved one.
// Annotations round (2026-10-16): no desk to scroll onto. The column stays in the middle of the pane and what lies beside
// the page is reached by zooming out (../model/paper-draw.js columnGeometry), so the desk's widths (DESK, deskOf,
// deskNeed), the fades and chips for boxes out of view, Fit page + notes, and the blank-space pan (blankAt) are gone. A
// note is narrow and grows down (noteWidth, freeNoteWidth).
// Notes the same size at every zoom (2026-10-16, later; Hudson: "the font size should be adaptive so it is the same size
// at all zooms", "i should be able to see all annotations if i can see any vertical position y at all times, irrespective
// of zoom and position it was left x"): a card is laid out in screen px, not desk px, so the widths below are px on
// screen at any zoom. Only where a card sits follows the page (its highlight's height and the text's edge, or its `pos`);
// the pane's edges then move it in, narrowed and taller if it has to be (fitWidth).
// Notes the size of the paper's text (2026-10-16, third round; Hudson: "the font size is way too large for the annotation,
// it should be roughly constant to what the font size of the pdf is at 100%, so like 10pt", "shrinking may actually be
// more natural"): a card is laid out in note px and drawn scaled by noteScale, which follows the page's width, so its
// handwriting stays beside the printed text at the size of it at every zoom, down to NOTE_FLOOR, where it stops shrinking
// so it can still be read. The widths below are note px.

/** Side space that centers a page of width pageW in a pane of width W (0 once the page is wider). */
export const sideSpace = (W, pageW) => Math.max(0, Math.floor((W - pageW) / 2));

export const BOX_GAP = 12; // desk px kept between two boxes by the spacing pass
export const NOTE_W = 240; // desk px: the widest a note gets (2026-10-16: a highlight's card too, 320 until then)
export const SIDE_GAP = 12; // a note beside its page: desk px from the text's edge (28 until 2026-10-07: closer, David)
export const POS_DY = 11; // `pos` is where a box's first line sits: 11px under its top, as free notes were always kept
export const NOTE_MIN = 96; // px: the narrowest a highlight's note in a margin gets (2026-10-16)
export const FREE_MIN = 80; // px: the narrowest a note typed anywhere is written
export const FREE_FIT = 160; // px: a note typed anywhere is narrowed to this, no further, before it is moved in
export const EDGE_PAD = 8; // px kept between a card and the pane's side
export const HIDE_ROOM = 40; // note px: a card whose margin shows less than this is hidden, not drawn over the text (round 4,
// 2026-10-16: "if i zoom in such that there are no margins and it is just text the annotations shouldn't still show")
export const NOTE_REF = 1050; // a page this many px wide draws a note at its laid-out size: Caveat 24px is then 14 of
// the page's 612 pt, whose x-height (0.36 em) is that of 10 pt body text (Helvetica, 0.52 em)
export const NOTE_FLOOR = 10 / 24; // the least a note is drawn at: 10px handwriting, the smallest that reads
/** Screen px per note px for a page drawn pageW px wide. */
export const noteScale = (pageW) => Math.max(NOTE_FLOOR, (pageW || NOTE_REF) / NOTE_REF);

/**
 * A card's width where it is now (2026-10-16): what it would be (`want`), narrowed to the `room` the pane shows beside
 * its anchor (a highlight's note: from the text's edge to the pane's; a moved or typed one: from where it starts to the
 * pane's right), but not under `min` (it is moved in over the text instead), and never wider than the pane shows (`span`).
 * A highlight's note is as wide as its margin, within NOTE_MIN..NOTE_W, and grows down (Hudson: "slightly less horizontal
 * text … take up the vertical space").
 */
export const fitWidth = (want, room, min, span) => {
  const most = Math.max(1, Math.min(want, span)), least = Math.min(min, most);
  return Math.round(Math.max(least, Math.min(most, room)));
};

/* ----------------------------------------------- readable cards and the desk beside the page (2026-10-27, David) */
// Screenshots of a short highlight in a large title: its card squeezed into the margin it found (fitWidth, down to
// NOTE_MIN) and wrapping mid-word, the empty card over the title's next line. Since then a highlight's card, and the empty
// one a selection opens, is CARD_W note px wide at every zoom and in every pane, never narrowed to a margin: it goes
// beside the text's column, outside the printed text, and the desk beside the page is made wide enough to hold it
// (deskReach, ../model/paper-draw.js columnGeometry), panned to sideways. fitWidth stays for no card of a highlight.

export const CARD_W = 300; // note px: a highlight's card, about 300 px where a note is drawn at its laid-out size (noteScale 1)
export const DESK_PAD = 16; // note px of desk kept past a card's far edge

/**
 * Where a card beside the text's column goes across (the sheet's px): a right one `gap` past the column's right edge R,
 * a left one its own width and `gap` before its left edge L, so neither is ever over the text. `width` is the card's on
 * screen, `gap` already on screen too.
 */
export const besideLeft = (side, L, R, width, gap) => (side === 'left' ? L - gap - width : R + gap);

/**
 * How far one card reaches past its page's edges, as terms of deskReach: [{ a, b }], each a reach of a × pageW + b ×
 * noteScale(pageW) sheet px, a in page units, b note px (DESK_PAD counted in). `side`/`col` for a card beside the text
 * (col its column in page units, null for the page's edges); `pos` (page units, its left at pos.x) for one put somewhere;
 * `w` its width in note px. Kept apart from any zoom, so the desk follows the page through a zoom without a jump.
 */
export function cardReach({ side, col, pos, w }) {
  const width = Math.max(0, Number(w) || 0);
  if (pos && Number.isFinite(pos.x)) {
    const out = [{ a: pos.x - 1, b: width + DESK_PAD }];
    if (pos.x < 0) out.push({ a: -pos.x, b: DESK_PAD });
    return out;
  }
  const l = col ? col.l : 0, r = col ? col.r : 1;
  return [side === 'left' ? { a: -l, b: SIDE_GAP + width + DESK_PAD } : { a: r - 1, b: SIDE_GAP + width + DESK_PAD }];
}

/** The desk each side of a page `pageW` wide that holds every card whose reach is `terms` (cardReach): sheet px, 0 or more. */
export function deskReach(terms, pageW) {
  const ns = noteScale(pageW);
  let most = 0;
  for (const t of terms || []) if (t && Number.isFinite(t.a) && Number.isFinite(t.b)) most = Math.max(most, t.a * pageW + t.b * ns);
  return most;
}

/**
 * A note typed anywhere (2026-10-16): from where it starts (`x`) to the printed text after it on its line (`textAt`, its
 * left edge; Infinity with none) or the edge of what showed (`edge`), whichever is nearer, within FREE_MIN..NOTE_W.
 * x, textAt and edge are the sheet's px; `ns` its notes' scale (noteScale), the result note px.
 */
export const freeNoteWidth = (x, textAt, edge, ns = 1) => Math.round(Math.max(FREE_MIN, Math.min(NOTE_W, (Math.min(textAt - 6, edge - 8) - x) / ns)));

/**
 * The printed text's column on a page (2026-10-06, David: a card beside its highlight sits next to the text at any zoom,
 * not out past the paper's margin) from the left and right edges of its text runs, each a fraction of the page's width →
 * { l, r } in page units, or null with too few runs to tell. The 2nd and 98th percentiles, so a line number or a stray
 * mark in the margin does not count.
 */
export function textColumn(lefts, rights) {
  const ls = (lefts || []).filter(Number.isFinite).sort((a, b) => a - b);
  const rs = (rights || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (ls.length < 5 || rs.length < 5) return null;
  const at = (xs, q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const l = Math.min(1, Math.max(0, at(ls, 0.02))), r = Math.min(1, Math.max(0, at(rs, 0.98)));
  return r > l ? { l, r } : null;
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

export const PRESS_MOVE = 4; // px: a press that moves less is a click, not a drag

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
 * question and the answer as the document holds an asked @chat line and its answer. `paper` { name, rowId, url }.
 */
export function continueLines({ quote, question, answer, foot, paper = {}, page }) {
  const name = String(paper.name || 'the paper').replace(/[[\]\n]/g, '').trim() || 'the paper';
  const where = paper.rowId ? `@[${name}]` : paper.url && /^https?:/i.test(paper.url) ? `[${name}](${paper.url})` : name;
  const said = String(quote || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  if (said) lines.push(`“${said}” (${where}${page ? `, p. ${page}` : ''})`);
  // Written as Chat's (2026-10-12): it answered, and `@bart` on a line is the router now.
  lines.push(`@chat ${String(question || '').replace(/\s*\n\s*/g, ' ').trim()}`);
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

/** The header of an answer still being written: "Bart · Reading …", "Bart · Moving up to Opus high", "Bart · Thinking". */
export function runningLabel(ask) {
  if (!ask) return 'Bart · Thinking';
  if (ask.activity) return `Bart · ${ask.activity}`;
  if (ask.movedUp && ask.name) return `Bart · Moving up to ${[ask.name, ask.effort].filter(Boolean).join(' ')}`;
  return 'Bart · Thinking';
}
