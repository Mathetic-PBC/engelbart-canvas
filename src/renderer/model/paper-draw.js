// Drawing a pdf's pages (PaperView, MATH-71, 2026-10-07), its pure parts: which pages to draw next and which drawings to
// give back. Pages used to be drawn one after another in an order fixed when the layout began, every one kept: a scroll
// past the page being drawn waited for every page before it, and a long paper's canvases (up to 16 MB each) went past
// what Chromium keeps, so some came back blank. Now the pages in view come first, read again before every page, and a
// page far from the view gives its drawing back and is drawn again when it comes near.

/** Pages within this many of the view are drawn before they are reached. */
export const DRAW_AHEAD = 2;
/** Pages within this many of the view keep their drawing; further off it is given back. */
export const KEEP_DRAWN = 5;

/** The pages in view, `first`..`last`, from `current` outward, then the DRAW_AHEAD pages on each side, the one below
 *  first (reading goes down): the pages to draw, in order, within 1..N. */
export function nearOrder(first, last, current, N, ahead = DRAW_AHEAD) {
  if (!N) return [];
  first = Math.max(1, Math.min(N, first || 1)); last = Math.max(first, Math.min(N, last || first));
  current = Math.max(first, Math.min(last, current || first));
  const out = [current];
  for (let d = 1; current + d <= last || current - d >= first; d += 1) {
    if (current + d <= last) out.push(current + d);
    if (current - d >= first) out.push(current - d);
  }
  for (let d = 1; d <= ahead; d += 1) {
    if (last + d <= N) out.push(last + d);
    if (first - d >= 1) out.push(first - d);
  }
  return out;
}

/** Every page 1..N, nearest the view first (for the text layers, which every page has so find can search them). */
export function allOrder(first, last, current, N) {
  return nearOrder(first, last, current, N, N);
}

/** Whether page n, with `first`..`last` in view, is too far off to keep its drawing. */
export const tooFar = (n, first, last, keep = KEEP_DRAWN) => n < first - keep || n > last + keep;

/* ------------------------------------------------------------------------- the column and its zoom (2026-10-16) */
// Hudson: "I should not be able to pan left and right … All zooming should be uniform straight down the center." The
// pages are one column in the middle of the pane, every page as wide as the others; the desk beside them shows only as
// the page gets narrower than the pane. Since 2026-10-27 (David) a card beside the page is never narrowed to its margin:
// the sheet is widened each side for it (columnGeometry's `reach`), the column still down its middle, and the pane can
// be panned sideways onto the desk where a card lies past its edge.

/** The column at zoom `z` (1 = the page as wide as the pane) in a pane `W` wide: every page `pageW` wide, on a sheet `S`
 *  wide (the pane, or the page once it is wider), the page starting `G` from the sheet's left. → { pageW, S, G }
 *  `reach` (2026-10-27): px of desk each side of the page its cards need (../pdf/canvas.js deskReach, a function of the
 *  page's width, or a number), so a card beside the page is never narrowed to its margin: the sheet is widened for it,
 *  the page still in its middle, and the pane scrolls sideways onto it. */
export function columnGeometry(W, z, reach = 0) {
  const pageW = Math.max(1, Math.round(W * z));
  const need = typeof reach === 'function' ? reach(pageW) : reach;
  const S = Math.max(W, pageW + 2 * Math.max(0, Math.ceil(Number(need) || 0)));
  return { pageW, S, G: (S - pageW) / 2 };
}

/** The index of the sheet whose top is the last at or above y, given the sheets' ascending tops. */
function sheetIndex(tops, y) {
  let lo = 0, hi = tops.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo;
}

/**
 * Where the view goes once a zoom is laid out: the document point at (`ox`, `oy`) of the old layout (px inside the
 * paper, where a pinch's transform was centered) stays under the same point of the pane. Vertically by its page and its
 * share of that page's width, horizontally by its distance from the column's middle, scaled. `from` / `to`: { tops,
 * pageW, S } of the two layouts; `top` / `left` the scroll now; `W` the pane's width. → { top, left }, left kept to the
 * page (0 while the page is no wider than the pane).
 */
export function settleView({ W, ox, oy, top, left, from, to }) {
  const n = sheetIndex(from.tops, oy), fy = (oy - (from.tops[n] || 0)) / (from.pageW || 1);
  const y = (to.tops[n] || 0) + fy * to.pageW, s = to.pageW / (from.pageW || 1);
  const x = to.S / 2 + (ox - from.S / 2) * s;
  return { top: Math.max(0, y - (oy - top)), left: Math.max(0, Math.min(Math.max(0, to.S - W), x - (ox - left))) };
}

/** A turn of the event loop (a task, not a microtask), so input and painting go between two pages' work. */
export const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));
