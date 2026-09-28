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

// A card crumples on its way to the trash (2026-09-22): from REACH CSS pixels out it shrinks towards
// SMALLEST of its size and slides off to the can's right, so the can stays in sight while it takes it.
const REACH = 220;
const SMALLEST = 0.28;

/** 0 at REACH or farther from the can, 1 touching or over it (eased); `point` in content DIPs. */
function crumpleAmount(point, rect, zoom = 1) {
  if (!rect) return 0;
  const x = point.x / zoom, y = point.y / zoom;
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width));
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height));
  const t = clamp(1 - Math.hypot(dx, dy) / REACH, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Where a dragged card sits: `size` its uncrumpled DIPs, `grab` the fraction of it under the pointer when the
 * drag began, `point` the pointer (content DIPs), `t` from crumpleAmount. At t = 0 the grabbed spot stays under the
 * pointer; at t = 1 the card is SMALLEST of its size, centred on the pointer's height, left edge past the can.
 */
function draggedBounds({ point, grab, size, t, rect, zoom = 1 }) {
  const scale = 1 - (1 - SMALLEST) * t;
  const width = size.width * scale, height = size.height * scale;
  const held = { x: point.x - grab.x * width, y: point.y - grab.y * height };
  const beside = rect ? Math.max(point.x + 14 * zoom, (rect.x + rect.width + 10) * zoom) : point.x + 14 * zoom;
  const aside = { x: beside, y: point.y - height / 2 };
  const round = Math.round;
  return { scale, bounds: { x: round(held.x + (aside.x - held.x) * t), y: round(held.y + (aside.y - held.y) * t), width: Math.max(1, round(width)), height: Math.max(1, round(height)) } };
}

/** Whether two { x, y, width, height } rects overlap (touching edges do not). */
function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Rects of the app's own menus and dialogs, as the renderer measured them (CSS px of the content): at most 64, all finite.
 * One marked `cover` (a panel opened by a click, 2026-09-27) covers the cards under it rather than moving them aside.
 */
function blockingRects(value) {
  if (!Array.isArray(value) || value.length > 64) throw new TypeError('Blocking rects must be a list of at most 64');
  return value.map((rect) => { const r = trashRect(rect); return r && rect.cover === true ? { ...r, cover: true } : r; }).filter(Boolean);
}

/** The tallest a card can show in this window (CSS px): the preferred height is clamped to it on screen. */
function tallest(viewport, zoom = 1) {
  return Math.max(140, Math.min(2400, viewport.height / zoom - TOP - MARGIN));
}

/**
 * A card that grows to fit its text (2026-09-22) keeps its top edge where it is, unless the window's
 * bottom is in the way, and then it moves up. → { nx, ny, width, height }, height clamped to the window.
 */
function grown(row, height, viewport, zoom = 1) {
  const now = cardBounds(row, viewport, zoom);
  const h = clamp(height, 140, tallest(viewport, zoom));
  const next = layoutFromBounds({ x: now.x, y: now.y, width: now.width, height: h * zoom }, viewport, zoom);
  return { nx: row.nx, ny: next.ny, width: row.width, height: next.height };
}

module.exports = { cardBounds, layoutFromBounds, inTrash, trashRect, crumpleAmount, draggedBounds, overlaps, blockingRects, tallest, grown, REACH, SMALLEST };
