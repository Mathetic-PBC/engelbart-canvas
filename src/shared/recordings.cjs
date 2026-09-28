'use strict';

const VERSION = 1;
const MAX_BATCH = 8 * 1024 * 1024;
const MAX_RECORDING = 128 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const IMAGE = /^data:image\/(?:png|jpeg|webp|gif|avif|svg\+xml);base64,/;
const RESOURCE = /^data:(?:image\/(?:png|jpeg|webp|gif|avif|svg\+xml)|font\/[\w.-]+|application\/(?:font-woff|vnd.ms-fontobject|octet-stream));base64,/;

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError('Invalid recording identifier');
  return value;
}
function pageUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Only web pages can be recorded');
  url.search = ''; url.hash = '';
  return url.href;
}
function readBatch(text) {
  if (typeof text !== 'string' || text.length > MAX_BATCH) throw new Error('Recording batch is too large');
  const b = JSON.parse(text);
  id(b.id); id(b.documentId);
  if (!Number.isSafeInteger(b.seq) || b.seq < 0 || !Number.isFinite(b.at)) throw new TypeError('Invalid recording sequence');
  if (!Array.isArray(b.events) || b.events.length > 20000 || !Array.isArray(b.canvas) || b.canvas.length > 500 || !Array.isArray(b.assets) || b.assets.length > 200) throw new TypeError('Invalid recording batch');
  if (b.events.some(e => !e || !Number.isFinite(e.timestamp) || !Number.isInteger(e.type) || e.type < 0 || e.type > 6)) throw new TypeError('Invalid replay event');
  if (b.canvas.some(f => !f || !Number.isFinite(f.at) || !Number.isSafeInteger(f.nodeId) || f.nodeId < 0 || typeof f.dataUrl !== 'string' || !IMAGE.test(f.dataUrl))) throw new TypeError('Invalid canvas frame');
  if (b.assets.some(a => !a || typeof a.url !== 'string' || a.url.length > 8192 || typeof a.dataUrl !== 'string' || !RESOURCE.test(a.dataUrl))) throw new TypeError('Invalid recording asset');
  return { id: b.id, documentId: b.documentId, seq: b.seq, at: b.at, events: b.events, canvas: b.canvas, assets: b.assets,
    warnings: Array.isArray(b.warnings) ? b.warnings.filter(w => typeof w === 'string').slice(0, 20).map(w => w.slice(0, 300)) : [],
    end: ['stop', 'navigation', 'limit', 'error'].includes(b.end) ? b.end : null };
}

// Only image/font references and CSS resources, never navigation links or user text.
// The same visitor discovers assets during capture and substitutes saved bytes at replay.
function resources(event, replace) {
  const css = text => typeof text === 'string' ? text
    .replace(/@import\s+(['"])([^'"]+)\1[^;]*;/gi, (_all, _quote, url) => { replace(url); return ''; })
    .replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/gi, (all, quote, url) => `url("${replace(url)}")`) : text;
  const attrs = (a, tag) => {
    if (!a) return;
    for (const key of Object.keys(a)) {
      if (key === 'style' || key === '_cssText') a[key] = css(a[key]);
      else if (key === 'href' && tag === 'link' && /stylesheet/i.test(a.rel || '') && !a._cssText) a[key] = replace(a[key]);
      else if ((key === 'src' && ['img', 'source', 'input'].includes(tag)) || key === 'poster' || (['href', 'xlink:href'].includes(key) && tag === 'image')) a[key] = replace(a[key]);
      // rrweb records the selected image separately; a live srcset must not override it.
      else if (key === 'srcset') delete a[key];
    }
    if (a.style && typeof a.style === 'object') for (const key of Object.keys(a.style)) {
      const value = a.style[key];
      a.style[key] = Array.isArray(value) ? [css(value[0]), ...value.slice(1)] : css(value);
    }
  };
  const node = n => {
    if (!n || typeof n !== 'object') return;
    attrs(n.attributes, n.tagName);
    if (n.isStyle) n.textContent = css(n.textContent);
    for (const child of n.childNodes || []) node(child);
  };
  if (event.type === 2) node(event.data?.node);
  if (event.type === 3 && event.data) {
    const d = event.data;
    for (const a of d.adds || []) node(a.node);
    for (const a of d.attributes || []) attrs(a.attributes, 'img');
    for (const a of d.adds || []) if (typeof a.rule === 'string') a.rule = css(a.rule);
    if (typeof d.rule === 'string') d.rule = css(d.rule);
    for (const value of Object.values(d.set || {})) if (value && typeof value.value === 'string') value.value = css(value.value);
  }
  return event;
}

module.exports = { VERSION, MAX_BATCH, MAX_RECORDING, IMAGE, RESOURCE, id, pageUrl, readBatch, resources };
