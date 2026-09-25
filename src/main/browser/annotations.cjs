'use strict';

const { source, WORLD } = require('./annotation-page.cjs');
const { anchor } = require('../../shared/interface-annotations.cjs');

function createAnnotations(contents, report) {
  let enabled = false, installed = false, revision = 0, timer = null, pending = Promise.resolve();
  const alive = () => !contents.isDestroyed();
  function reset() {
    revision++; installed = false; enabled = false; clearTimeout(timer);
    report({ type: 'navigated' });
  }
  function emit(events, at) {
    if (revision !== at || !enabled) return;
    for (const event of Array.isArray(events) ? events.slice(-30) : []) {
      if (event.type === 'picked') {
        // Ephemeral popover placement, never part of a saved anchor or matching.
        const bounds = event.bounds;
        const valid = bounds && ['x', 'y', 'w', 'h', 'viewportWidth', 'viewportHeight'].every((key) => Number.isFinite(bounds[key]) && Math.abs(bounds[key]) <= 1e6)
          && bounds.w >= 0 && bounds.h >= 0 && bounds.viewportWidth > 0 && bounds.viewportHeight > 0;
        report({ type: 'picked', anchor: anchor(event.anchor), ...(valid ? { bounds: Object.fromEntries(['x', 'y', 'w', 'h', 'viewportWidth', 'viewportHeight'].map((key) => [key, bounds[key]])) } : {}) });
      }
      else if (['marker', 'exited', 'status', 'navigated'].includes(event.type)) report(event);
    }
  }
  async function execute(message, at) {
    if (!alive() || revision !== at) return;
    const code = `${installed ? '' : source}\nglobalThis.__engelbartAnnotations.command(${JSON.stringify(message)})`;
    const result = await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]);
    if (revision !== at) return;
    installed = true; emit(result, at);
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
    const hadScript = installed;
    reset();
    if (inPlace && hadScript) void enqueue({ type: 'clear' }).catch(() => {});
  };
  contents.on('did-start-navigation', navigate);
  contents.on('render-process-gone', reset);
  return {
    command,
    dispose() { enabled = false; revision++; clearTimeout(timer); contents.removeListener('did-start-navigation', navigate); contents.removeListener('render-process-gone', reset); },
  };
}
module.exports = { createAnnotations };
