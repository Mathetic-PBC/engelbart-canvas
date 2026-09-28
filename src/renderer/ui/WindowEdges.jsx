import React from 'react';

// Wider resize edges (2026-09-23): invisible strips along the left, right and bottom of the window, over everything (the
// Stage keeps its native page views EDGE px off them). A press takes the pointer; main reads the cursor and moves the
// window (src/main/window-edges.cjs).
// The top edge is the title bar's: it drags the window and keeps macOS's own band for resizing.
export const EDGE = 6;
const CORNER = 14;
const STRIPS = [
  { edge: 'left', cursor: 'ew-resize', style: { left: 0, top: 54, bottom: CORNER, width: EDGE } },
  { edge: 'right', cursor: 'ew-resize', style: { right: 0, top: 54, bottom: CORNER, width: EDGE } },
  { edge: 'bottom', cursor: 'ns-resize', style: { left: CORNER, right: CORNER, bottom: 0, height: EDGE } },
  { edge: 'bottom-left', cursor: 'nesw-resize', style: { left: 0, bottom: 0, width: CORNER, height: CORNER } },
  { edge: 'bottom-right', cursor: 'nwse-resize', style: { right: 0, bottom: 0, width: CORNER, height: CORNER } },
];

export default function WindowEdges() {
  const bridge = typeof window !== 'undefined' ? window.engelbartWindow : null;
  if (!bridge) return null;
  const down = (event, edge) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    bridge.edgeResize('start', edge);
  };
  const move = (event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) bridge.edgeResize('move'); };
  const up = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    bridge.edgeResize('end');
  };
  return STRIPS.map(({ edge, cursor, style }) => (
    <div
      key={edge}
      data-window-edge={edge}
      data-no-drag="1"
      onPointerDown={(event) => down(event, edge)}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={() => bridge.edgeResize('end')}
      style={{ position: 'fixed', zIndex: 900, cursor, ...style }}
    />
  ));
}
