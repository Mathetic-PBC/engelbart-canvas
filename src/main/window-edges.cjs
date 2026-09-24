'use strict';

// Wider resize edges (2026-09-23): macOS gives a hidden-title-bar window only a thin band just outside its frame, so the
// renderer lays strips along the left, right and bottom edges and main moves the window while one is held. The cursor
// is read in main (screen coordinates), so the window moving under the pointer never skews the arithmetic.

const EDGES = new Set(['left', 'right', 'bottom', 'bottom-left', 'bottom-right']);

/** The window's bounds after the pointer has moved (dx, dy) from where the press began. The side opposite the held one
 *  stays put, and the window never goes below its minimum size. */
function resizedBounds(start, edge, dx, dy, min = { width: 0, height: 0 }) {
  if (!EDGES.has(edge)) throw new TypeError('Unknown window edge');
  let { x, y, width, height } = start;
  if (edge === 'right' || edge === 'bottom-right') width = Math.max(min.width, start.width + dx);
  if (edge === 'left' || edge === 'bottom-left') {
    width = Math.max(min.width, start.width - dx);
    x = start.x + start.width - width;
  }
  if (edge.startsWith('bottom')) height = Math.max(min.height, start.height + dy);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

module.exports = { EDGES, resizedBounds };
