'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const MARGIN = 8;
const TOP = 56; // leave the window controls and project navigation reachable

// Preferred size is CSS pixels; native view bounds and the viewport are Electron DIPs.
// Clamping never writes back to the preferred layout, so a small window loses nothing.
function cardBounds(row, viewport, zoom = 1) {
  const w = viewport.width / zoom, h = viewport.height / zoom;
  const width = Math.max(1, Math.min(row.width, w - 2 * MARGIN));
  const height = Math.max(1, Math.min(row.height, h - TOP - MARGIN));
  return {
    x: Math.round((MARGIN + row.nx * Math.max(0, w - width - 2 * MARGIN)) * zoom),
    y: Math.round((TOP + row.ny * Math.max(0, h - height - TOP - MARGIN)) * zoom),
    width: Math.round(width * zoom), height: Math.round(height * zoom),
  };
}

function layoutFromBounds(bounds, viewport, zoom = 1) {
  const width = bounds.width / zoom, height = bounds.height / zoom;
  return {
    nx: clamp((bounds.x / zoom - MARGIN) / Math.max(1, viewport.width / zoom - width - 2 * MARGIN), 0, 1),
    ny: clamp((bounds.y / zoom - TOP) / Math.max(1, viewport.height / zoom - height - TOP - MARGIN), 0, 1),
    width: clamp(width, 180, 2400), height: clamp(height, 140, 2400),
  };
}

function inTrash(point, viewport, zoom = 1) {
  return point.x >= 0 && point.x <= 160 * zoom && point.y >= viewport.height - 112 * zoom && point.y <= viewport.height;
}

module.exports = { cardBounds, layoutFromBounds, inTrash };
