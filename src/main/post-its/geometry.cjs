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

// The trash is the sidebar's trash can (2026-09-22), wherever the sidebar puts it: the renderer
// measures it in CSS pixels of the window's content (`rect`, null when no workspace shows one); the
// pointer comes in content DIPs, which are CSS pixels times the zoom.
function inTrash(point, rect, zoom = 1) {
  if (!rect) return false;
  const x = point.x / zoom, y = point.y / zoom;
  return x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
}

/** A rect the renderer sent, or null: four finite numbers, inside any window there could be. */
function trashRect(value) {
  if (value == null) return null;
  const fields = ['x', 'y', 'width', 'height'];
  if (typeof value !== 'object' || !fields.every((key) => Number.isFinite(value[key]) && Math.abs(value[key]) < 100000) || value.width <= 0 || value.height <= 0) throw new TypeError('Invalid trash rect');
  return Object.fromEntries(fields.map((key) => [key, value[key]]));
}

module.exports = { cardBounds, layoutFromBounds, inTrash, trashRect };
