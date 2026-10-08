// Where a floating panel goes (2026-09-22). Every popup used to open under what it hangs from, so near the bottom of the
// window it opened off screen. Now: under it when it fits there, else above it when it fits there, else on whichever
// side has more room, cut to that room (the panel scrolls). Sideways it stays inside the window. All in viewport pixels.

/**
 * @param anchor { left, right, top, bottom } of what the panel hangs from
 * @param size { width, height } the panel wants
 * @param view { width, height } of the window
 * @returns { left, top, maxHeight } — maxHeight is null when the panel fits whole
 */
export function place(anchor, size, view, { gap = 6, margin = 8, align = 'start', side = 'below' } = {}) {
  if (side === 'right') return placeBeside(anchor, size, view, { gap, margin });
  const below = view.height - margin - (anchor.bottom + gap);
  const above = anchor.top - gap - margin;
  let top, maxHeight = null;
  if (size.height <= below) top = anchor.bottom + gap;
  else if (size.height <= above) top = anchor.top - gap - size.height;
  else if (below >= above) { maxHeight = Math.max(0, below); top = anchor.bottom + gap; }
  else { maxHeight = Math.max(0, above); top = anchor.top - gap - maxHeight; }
  const x = align === 'end' ? anchor.right - size.width : anchor.left;
  const left = Math.max(margin, Math.min(x, view.width - size.width - margin));
  return { left, top, maxHeight };
}

/**
 * Beside what it hangs from, to its right (the sidebar's panels, 2026-10-07: Hudson, "a (not centered) scrollable modal
 * next to that (to the right)"): its top at the anchor's top, moved up as far as it must to stay in the window, cut to
 * the window's height when it is taller (the panel scrolls). With no room on the right it goes on the left.
 */
export function placeBeside(anchor, size, view, { gap = 8, margin = 8 } = {}) {
  const room = view.height - 2 * margin;
  const maxHeight = size.height > room ? Math.max(0, room) : null;
  const height = maxHeight == null ? size.height : maxHeight;
  const top = Math.max(margin, Math.min(anchor.top, view.height - margin - height));
  const right = anchor.right + gap;
  const left = right + size.width <= view.width - margin ? right : Math.max(margin, anchor.left - gap - size.width);
  return { left, top, maxHeight };
}
