import React from 'react';
import { place } from '../model/place.js';

/**
 * Measures the panel before it is painted and puts it where place() says. Returns [ref, style]: the ref goes on the panel,
 * the style (position, left, top, and a height limit when it had to be cut) is spread into its own. `cap` limits how tall
 * the panel may be even with room to spare. Measured again after every render, since what it holds can change its size.
 */
export function usePlaced(anchor, { gap = 6, align = 'start', cap = null } = {}) {
  const ref = React.useRef(null);
  const [at, setAt] = React.useState(null);
  React.useLayoutEffect(() => {
    const el = ref.current; if (!el || !anchor) return;
    const held = el.style.maxHeight; el.style.maxHeight = 'none';
    const natural = el.offsetHeight, width = el.offsetWidth;
    el.style.maxHeight = held;
    const want = cap ? Math.min(natural, cap) : natural;
    const spot = place(anchor, { width, height: want }, { width: window.innerWidth || 1200, height: window.innerHeight || 800 }, { gap, align });
    const next = { left: spot.left, top: spot.top, maxHeight: spot.maxHeight != null ? spot.maxHeight : want < natural ? want : null };
    setAt((prev) => (prev && prev.left === next.left && prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next));
  });
  const style = at
    ? { position: 'fixed', left: at.left, top: at.top, ...(at.maxHeight != null ? { maxHeight: at.maxHeight, overflowY: 'auto' } : {}) }
    : { position: 'fixed', left: anchor ? anchor.left : 0, top: anchor ? anchor.bottom + gap : 0, visibility: 'hidden' };
  return [ref, style];
}
