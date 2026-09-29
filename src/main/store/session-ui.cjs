'use strict';
// Local Canvas view preferences and unsent drafts. No webpage DOM or terminal process state.
const path = require('node:path');
const { readJson, writeJson } = require('./home.cjs');
const FILE = 'session-ui.json';
const validKey = key => typeof key === 'string' && /^[a-z][a-z0-9-]*:/.test(key) && key.length <= 10000;
function clean(value, depth = 0) {
  if (depth > 12) throw new TypeError('View state is too deeply nested');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 100000) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.length <= 2000) return value.map(item => clean(item, depth + 1));
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > 2000) throw new TypeError('Too many view fields');
    return Object.fromEntries(entries.filter(([key]) => !['__proto__', 'constructor', 'prototype'].includes(key)).map(([key, item]) => [key, clean(item, depth + 1)]));
  }
  throw new TypeError('Invalid view state');
}
function read(ctx) {
  const held = readJson(path.join(ctx.dataRoot, FILE), null);
  if (!held || held.version !== 1 || !held.values || Array.isArray(held.values)) return {};
  const out = {};
  for (const [key, value] of Object.entries(held.values)) {
    if (!validKey(key)) continue;
    try { out[key] = clean(value); } catch { /* one malformed view must not block startup */ }
  }
  return out;
}
function write(ctx, patch) {
  if (!patch || Array.isArray(patch) || typeof patch !== 'object' || Object.keys(patch).length > 2000) throw new TypeError('Invalid view update');
  const next = read(ctx);
  for (const [key, value] of Object.entries(patch)) {
    if (!validKey(key)) throw new TypeError('Invalid view key');
    if (value === null) delete next[key]; else next[key] = clean(value);
  }
  const output = { version: 1, values: next };
  if (Buffer.byteLength(JSON.stringify(output)) > 8 * 1024 * 1024) throw new TypeError('Saved view state is too large');
  writeJson(path.join(ctx.dataRoot, FILE), output);
  return true;
}
module.exports = { read, write, clean };
