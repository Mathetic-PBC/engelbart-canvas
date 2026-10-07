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
