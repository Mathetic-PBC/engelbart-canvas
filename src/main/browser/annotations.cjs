'use strict';

const { source, WORLD } = require('./annotation-page.cjs');
const { anchor } = require('../../shared/interface-annotations.cjs');

// Placement is transient UI data, never part of a saved anchor or matching.
function placement(bounds) {
  const keys = ['x', 'y', 'w', 'h', 'viewportWidth', 'viewportHeight'];
  return bounds && keys.every(key => Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 1e6)
    && bounds.w >= 0 && bounds.h >= 0 && bounds.viewportWidth > 0 && bounds.viewportHeight > 0
    ? Object.fromEntries(keys.map(key => [key, bounds[key]])) : null;
}

function createAnnotations(contents, report) {
  let enabled = false, revision = 0, timer = null, pending = Promise.resolve();
  const alive = () => !contents.isDestroyed();
  function reset() {
    revision++; enabled = false; clearTimeout(timer);
    report({ type: 'navigated' });
  }
  function emit(events, at) {
    if (revision !== at || !enabled) return;
    for (const event of Array.isArray(events) ? events.slice(-30) : []) {
      if (event.type === 'picked') {
        // Ephemeral popover placement, never part of a saved anchor or matching.
        const bounds = placement(event.bounds);
        report({ type: 'picked', anchor: anchor(event.anchor), ...(bounds ? { bounds } : {}) });
      }
      else if (['marker', 'located'].includes(event.type)) {
        if (typeof event.id === 'string' && event.id.length <= 64) report({ type: event.type, id: event.id, bounds: placement(event.bounds) });
      }
      else if (['exited', 'status', 'navigated'].includes(event.type)) report(event);
    }
  }
  async function execute(message, at) {
    if (!alive() || revision !== at) return;
    // Check in the actual page world, not a main-process "installed" cache:
    // navigation can replace the context between commands. The installer is
    // idempotent; cleanup must never install a helper just to remove its overlay.
    const payload = JSON.stringify(message);
    const code = message.type === 'clear'
      ? `globalThis.__engelbartAnnotations?.command(${payload}) ?? []`
      : `${source}\nglobalThis.__engelbartAnnotations.command(${payload})`;
    let result;
    try { result = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); }
    catch (error) {
      // A cancelled document/tab no longer has an overlay to update. Preserve
      // real errors in the current document instead of swallowing all failures.
      if (!alive() || revision !== at) return;
      throw error;
    }
    if (!alive() || revision !== at) return;
    emit(result, at);
  }
  function enqueue(message) {
    const at = revision;
    const result = pending.catch(() => {}).then(() => execute(message, at));
    pending = result;
    return result;
  }
  function schedule() {
    clearTimeout(timer);
    if (!enabled || !alive()) return;
    timer = setTimeout(async () => {
      const at = revision;
      try { await enqueue({ type: 'poll' }); }
      catch (error) { if (enabled && revision === at) { enabled = false; report({ type: 'error', message: 'The page could not be inspected. Try Annotate again.' }); } }
      schedule();
    }, 250);
    timer.unref?.();
  }
  async function command(message) {
    if (!message || !['mode', 'show', 'locate', 'clear'].includes(message.type)) throw new TypeError('Invalid annotation command');
    let clean = { type: message.type };
    if (message.type === 'show') {
      if (!Array.isArray(message.items) || message.items.length > 500) throw new TypeError('Too many annotation markers');
      clean.items = message.items.map((m) => {
        if (typeof m.id !== 'string' || m.id.length > 64) throw new TypeError('Invalid annotation id');
        return { id: m.id, anchor: anchor(m.anchor) };
      });
    }
    if (message.type === 'mode') clean.on = message.on === true;
    if (message.type === 'locate') {
      if (typeof message.id !== 'string' || message.id.length > 64) throw new TypeError('Invalid annotation id');
      clean.id = message.id;
    }
    if (message.type === 'clear') {
      enabled = false; revision++; clearTimeout(timer);
    } else enabled = true;
    const at = revision;
    try { await enqueue(clean); }
    catch (error) { if (revision === at) { enabled = false; clearTimeout(timer); } throw error; }
    schedule(); return true;
  }
  const navigate = (_event, _url, inPlace, main) => {
    if (!main) return;
    // An in-page navigation keeps the isolated world and its listeners alive.
    // Clear that world before the next show; a full navigation destroys it.
    reset();
    if (inPlace) void enqueue({ type: 'clear' }).catch(() => {});
  };
  contents.on('did-start-navigation', navigate);
  contents.on('render-process-gone', reset);
  return {
    command,
    dispose() { enabled = false; revision++; clearTimeout(timer); contents.removeListener('did-start-navigation', navigate); contents.removeListener('render-process-gone', reset); },
  };
}
module.exports = { createAnnotations };
