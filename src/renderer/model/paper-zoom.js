// Zooming a pdf (PaperView), its pure parts (2026-10-02): which wheel events zoom, how far one goes, and the text each
// page is drawn from, kept for the life of the document so a zoom does not ask the worker for it again.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Whether a wheel event over the paper zooms instead of scrolling: a trackpad pinch (it arrives with ctrlKey), ⌃ scroll
 *  and ⌘ scroll (metaKey). */
export const wheelZooms = (e) => !!(e && (e.ctrlKey || e.metaKey));

/** The zoom one wheel event goes to from `from`, within [min, max]. A mouse-wheel notch is ~100px (or 3 lines, deltaMode
 *  1); one event is limited to about ×1.65 so ⌘ / ⌃ + wheel stays usable. */
export function wheelZoom(from, e, min, max) {
  const dy = clamp(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, -50, 50);
  return clamp(from * Math.exp(-dy * 0.01), min, max);
}

/** A page's text content, asked for once: `load(n)` → a promise; two layouts asking at once share it, and one that
 *  failed is asked for again next time. One cache a document. */
export function createPageCache(load) {
  const kept = new Map();
  return {
    get(n) {
      if (!kept.has(n)) {
        const p = Promise.resolve().then(() => load(n));
        kept.set(n, p);
        p.catch(() => { if (kept.get(n) === p) kept.delete(n); });
      }
      return kept.get(n);
    },
  };
}
