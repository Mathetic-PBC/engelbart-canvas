'use strict';

// The page only contributes a bounded description of an element. Notes and disk
// paths never cross into the page's JavaScript context.
const MAX_BODY = 4000;
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
// Presentation only: use the existing semantic description, never handles or DOM metadata.
// Kept self-contained so the isolated page and Canvas can share the same label.
function targetLabel(element) {
  return String(element?.label || element?.text || 'Selected element').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Selected element';
}
function pageAddress(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new TypeError('Invalid annotation address');
  const url = new URL(value);
  if (!['http:', 'https:', 'file:'].includes(url.protocol)) throw new TypeError('This page cannot be annotated');
  url.username = ''; url.password = ''; url.search = '';
  if (!url.hash.startsWith('#/')) url.hash = '';
  return { url: url.href, site: url.protocol === 'file:' ? `file://${url.pathname}` : url.origin, route: url.pathname + url.hash };
}
function target(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Missing annotation element');
  const out = {};
  for (const [key, limit] of Object.entries({ tag: 64, selector: 2000, id: 160, testid: 160, role: 100, name: 160, type: 80, text: 240, label: 240 })) {
    const got = text(value[key], limit); if (got) out[key] = got;
  }
  if (!out.tag || !/^[a-z][a-z0-9-]*$/.test(out.tag) || !out.selector) throw new TypeError('Invalid annotation element');
  out.classes = Array.isArray(value.classes) ? value.classes.slice(0, 6).map((v) => text(v, 80)).filter(Boolean) : [];
  return out;
}
function anchor(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Missing annotation anchor');
  if (!Array.isArray(value.frames) || value.frames.length > 10) throw new TypeError('Invalid annotation frame path');
  const frames = value.frames.map((v) => { const s = text(v, 2000); if (!s) throw new TypeError('Invalid annotation frame'); return s; });
  const route = text(value.route, 2048);
  if (!route.startsWith('/')) throw new TypeError('Invalid annotation route');
  return { element: target(value.element), ancestors: (Array.isArray(value.ancestors) ? value.ancestors : []).slice(0, 3).map(target), frames, route, documentTitle: text(value.documentTitle, 240) };
}
function body(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_BODY) throw new TypeError(`Write a note of 1–${MAX_BODY} characters`);
  return value.trim();
}
module.exports = { MAX_BODY, pageAddress, target, anchor, body, targetLabel };
