'use strict';
// Where the card for a selection goes (2026-10-18, David: "the annotation card should appear by itself just under the
// selection, ready to type into"): under the selection's last line, its left edge with that line's, CARD_GAP below it;
// with no room for it there, above the selection's first line; with room for it nowhere, as far down as it fits. Always
// inside the pane, and none once the selection is wholly out of it. The pdf's (renderer/pdf/PaperView.jsx) and a web
// page's (main/browser/views.cjs, for its card view) both place it by this. Pure: the tests hold it.

const CARD_GAP = 8; // pixels between the selection and its card

const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const isRect = (r) => !!r && [r.x, r.y, r.width, r.height].every(finite);

/**
 * The card's place: `line`, the selection's last line, `all`, all of it (its bounding box: its first line's top is where
 * the card goes above), `pane`, what shows of the page, and `size`, the card's, all { x, y, width, height } in one space.
 * → { x, y, width, height } (whole pixels, inside the pane), or null when the selection shows nowhere in the pane.
 */
function selectionCardPlace(line, all, pane, size, gap = CARD_GAP) {
  if (!isRect(line) || !isRect(pane) || !size || !finite(size.width) || !finite(size.height)) return null;
  const sel = isRect(all) ? all : line;
  const right = pane.x + pane.width, bottom = pane.y + pane.height;
  if (sel.x + sel.width <= pane.x || sel.x >= right || sel.y + sel.height <= pane.y || sel.y >= bottom) return null;
  const width = Math.max(0, Math.min(size.width, pane.width)), height = Math.max(0, Math.min(size.height, pane.height));
  const x = Math.max(pane.x, Math.min(line.x, right - width));
  const below = line.y + line.height + gap, above = Math.min(sel.y, line.y) - gap - height;
  let y;
  if (below >= pane.y && below + height <= bottom) y = below;
  else if (above >= pane.y && above + height <= bottom) y = above;
  else y = Math.max(pane.y, Math.min(below, bottom - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

module.exports = { CARD_GAP, selectionCardPlace };
