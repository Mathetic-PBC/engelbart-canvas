import React from 'react';
import { place } from '../model/place.js';

/**
 * Measures the panel before it is painted and puts it where place() says. Returns [ref, style]: the ref goes on the panel,
 * the style (position, left, top, and a height limit when it had to be cut) is spread into its own. `cap` limits how tall
 * the panel may be even with room to spare. Measured again after every render, since what it holds can change its size.
 * The limit is off while it measures, and a list that cannot scroll is put back to its top, so where it was scrolled to is
 * kept and given back (MATH-55): hovering a row of the @ menu, or the document loading under it, never moves the list.
 * So are the lists inside it (2026-10-08): with the limit off the panel grows to hold them whole, which put a list that
 * scrolled inside it (the Library's) back at its top on every render.
 */
export function usePlaced(anchor, { gap = 6, align = 'start', cap = null, side = 'below' } = {}) {
  const ref = React.useRef(null);
  const [at, setAt] = React.useState(null);
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el || !anchor) return;
    const held = el.style.maxHeight, scrolled = el.scrollTop;
    const inside = []; // read before the limit comes off: laid out without it, a list inside reads 0
    for (const child of el.querySelectorAll('*')) if (child.scrollTop > 0) inside.push([child, child.scrollTop]);
    el.style.maxHeight = 'none';
    const natural = el.offsetHeight, width = el.offsetWidth;
    el.style.maxHeight = held;
    if (el.scrollTop !== scrolled) el.scrollTop = scrolled;
    for (const [child, top] of inside) if (child.scrollTop !== top) child.scrollTop = top;
    const want = cap ? Math.min(natural, cap) : natural;
    const spot = place(anchor, { width, height: want }, { width: window.innerWidth || 1200, height: window.innerHeight || 800 }, { gap, align, side });
    const next = { left: spot.left, top: spot.top, maxHeight: spot.maxHeight != null ? spot.maxHeight : want < natural ? want : null };
    setAt((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next));
  });
  const style = at
    ? { position: 'fixed', left: at.left, top: at.top, ...(at.maxHeight != null ? { maxHeight: at.maxHeight, overflowY: 'auto' } : {}) }
    : { position: 'fixed', left: anchor ? anchor.left : 0, top: anchor ? anchor.bottom + gap : 0, visibility: 'hidden' };
  return [ref, style];
}
