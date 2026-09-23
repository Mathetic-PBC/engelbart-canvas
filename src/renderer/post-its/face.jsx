import React from 'react';
import './face.css';

// A post-it's face (2026-09-22): the yellow rectangle, and type that fits.
// A card never scrolls. Text that no longer fits first asks for more room (`grow`, a floating card: it gets taller as far as
// the window lets it); what still does not fit, or a card made smaller by hand, gets smaller type instead (CSS zoom on
// the text, down to SMALLEST).

export const SMALLEST = 0.35;

/** The largest zoom in [SMALLEST, 1] at which `fit`'s content fits `box`'s height (found by bisection, measured live). */
function largestFit(box, fit) {
  const room = box.clientHeight;
  const tall = (zoom) => { fit.style.zoom = String(zoom); return fit.getBoundingClientRect().height > room + 0.5; };
  if (!tall(1)) return 1;
  if (tall(SMALLEST)) return SMALLEST;
  let lo = SMALLEST, hi = 1;
  for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2; if (tall(mid)) hi = mid; else lo = mid; }
  return Math.floor(lo * 1000) / 1000;
}

/**
 * The zoom for the card's text. `text` changing is typing: when it overflows at the zoom it has, the card asks `grow`
 * (if given) for the height it needs, and the zoom follows whatever size the card then has. The card resizing (by hand,
 * or after growing) fits the zoom again, up to 1.
 */
export function useFit({ boxRef, fitRef, text, grow }) {
  const [zoom, setZoom] = React.useState(1);
  const zoomRef = React.useRef(1);
  const refit = React.useCallback(() => {
    const box = boxRef.current, fit = fitRef.current;
    if (!box || !fit || !box.clientHeight) return;
    const next = largestFit(box, fit);
    fit.style.zoom = String(next);
    zoomRef.current = next;
    setZoom(next);
  }, [boxRef, fitRef]);
  React.useLayoutEffect(() => {
    const box = boxRef.current, fit = fitRef.current;
    if (!box || !fit) return;
    fit.style.zoom = String(zoomRef.current);
    const over = fit.getBoundingClientRect().height - box.clientHeight;
    if (over > 0.5 && grow) {
      Promise.resolve(grow(Math.ceil(window.innerHeight + over))).then(() => requestAnimationFrame(refit), refit);
      return;
    }
    refit();
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => refit());
    observer.observe(box);
    return () => observer.disconnect();
  }, [boxRef, refit]);
  return zoom;
}
