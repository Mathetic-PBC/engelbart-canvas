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

// A web page's selection card (2026-10-18, David's picture): a white card SEL_CARD_W wide with a soft shadow, in its own
// view (views.cjs, renderer/box-card/BoxCard.jsx). The view has CARD_SHADE about the card for the shadow to fade out in,
// so it is placed by the card's own size in the pane less that room: the card CARD_GAP from the text, below or above it,
// and the whole view, shadow and all, inside the pane.
const SEL_CARD_W = 340;
const CARD_SHADE = Object.freeze({ top: 18, side: 24, bottom: 30 }); // 0 6px 24px: its blur out from the card, less its drop

/**
 * The view's place for a card `size` ({ width, height }, the card alone) with `shade` about it, for a selection (`line`,
 * `all`) in `pane`, as selectionCardPlace's arguments → the view's { x, y, width, height }, or null when the selection
 * shows nowhere in the pane.
 */
function shadedCardPlace(line, all, pane, size, shade = CARD_SHADE, gap = CARD_GAP) {
  if (!isRect(pane) || !size || !finite(size.width) || !finite(size.height) || !selectionCardPlace(line, all, pane, size, gap)) return null;
  const inner = { x: pane.x + shade.side, y: pane.y + shade.top, width: Math.max(0, pane.width - 2 * shade.side), height: Math.max(0, pane.height - shade.top - shade.bottom) };
  const at = selectionCardPlace(line, all, inner, size, gap);
  if (!at) {
    // the selection only in the pane's rim: the card as near it as the pane lets it be
    const x = Math.max(inner.x, Math.min(line.x, inner.x + inner.width - size.width));
    const y = Math.max(inner.y, Math.min(line.y + line.height + gap, inner.y + inner.height - size.height));
    return { x: Math.round(x - shade.side), y: Math.round(y - shade.top), width: Math.round(Math.min(size.width, inner.width) + 2 * shade.side), height: Math.round(Math.min(size.height, inner.height) + shade.top + shade.bottom) };
  }
  return { x: Math.round(at.x - shade.side), y: Math.round(at.y - shade.top), width: Math.round(at.width + 2 * shade.side), height: Math.round(at.height + shade.top + shade.bottom) };
}

// The chat icon at a selection's end (2026-10-24, David): what a settled selection shows instead of its card, which the
// icon opens (renderer/ui/chat-icon.js). CHAT_ICON square, ICON_GAP right of the selection's last line's end, its middle
// level with that line's; with no room there, under the line's end (above it with no room under), its right edge with it;
// always inside the pane, and none once the end of the selection is out of it (scrolled past). On a web page it is the card
// view's, with ICON_SHADE about it for its shadow.
const CHAT_ICON = 28;
const ICON_GAP = 6;
const ICON_SHADE = 6;

/** The icon's place for a selection whose last line is `line`, in `pane` (as selectionCardPlace's) → { x, y, width, height }, or null. */
function chatIconPlace(line, pane, size = { width: CHAT_ICON, height: CHAT_ICON }, gap = ICON_GAP) {
  if (!isRect(line) || !isRect(pane) || !size || !finite(size.width) || !finite(size.height)) return null;
  const right = pane.x + pane.width, bottom = pane.y + pane.height, end = line.x + line.width;
  if (end <= pane.x || line.x >= right || line.y + line.height <= pane.y || line.y >= bottom) return null;
  const width = Math.min(size.width, pane.width), height = Math.min(size.height, pane.height);
  let x = end + gap, y = line.y + (line.height - height) / 2;
  if (x + width > right) {
    x = end - width;
    y = line.y + line.height + gap;
    if (y + height > bottom) y = line.y - gap - height;
  }
  x = Math.max(pane.x, Math.min(x, right - width));
  y = Math.max(pane.y, Math.min(y, bottom - height));
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** The icon's view on a web page: the icon placed in the pane less `shade`, the view `shade` bigger on every side; or null. */
function shadedIconPlace(line, pane, size = { width: CHAT_ICON, height: CHAT_ICON }, shade = ICON_SHADE, gap = ICON_GAP) {
  if (!isRect(pane)) return null;
  const inner = { x: pane.x + shade, y: pane.y + shade, width: Math.max(0, pane.width - 2 * shade), height: Math.max(0, pane.height - 2 * shade) };
  const at = chatIconPlace(line, inner, size, gap);
  return at && { x: Math.round(at.x - shade), y: Math.round(at.y - shade), width: Math.round(at.width + 2 * shade), height: Math.round(at.height + 2 * shade) };
}

module.exports = { CARD_GAP, SEL_CARD_W, CARD_SHADE, CHAT_ICON, ICON_GAP, ICON_SHADE, selectionCardPlace, shadedCardPlace, chatIconPlace, shadedIconPlace };
