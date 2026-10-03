'use strict';

// Several windows, one main process (2026-10-03, "multiple windows (like VS Code)"). Projects, the library, Bart, Builds,
// sandboxes, terminal processes and the GitHub sign-in are the app's, shared by every window; what a window looks at is
// its own: its Stage tabs (browser views), its post-it cards, whether its terminal pane is attached, how many of its
// Stages take links, and the project and workspace it shows. Each window's context is kept here by its page's
// webContents id.
//
// A handler that touches a window's things is a windowHandler: the trusted-renderer check, then the context of the
// window that called, which also stays known to whatever the handler calls (`asking()`). What gets saved is announced to
// every window (`broadcast`); what a window asked for goes back to it alone (`send`, `deliver`). `deliver` and a gated
// broadcast wait, as the one window always did, until the window's terminal pane has attached (RendererLifecycle).
//
// Terminal sessions belong to the window they were opened from: their output goes there alone, and only that window
// acknowledges it. A closed window's sessions keep running; the next window whose terminal attaches takes them.

const { AsyncLocalStorage } = require('node:async_hooks');
const { RendererLifecycle } = require('./terminal/window-lifecycle.cjs');
const { assertTrustedRenderer } = require('./ipc-validation.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOrNull = (value) => (typeof value === 'string' && UUID_RE.test(value) ? value : null);

/** Where a window is: { projectId, workspaceId }, projectId null on the projects screen. */
function cleanPlace(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const projectId = idOrNull(input.projectId);
  return { projectId, workspaceId: projectId ? idOrNull(input.workspaceId) : null };
}

/**
 * Where a new window goes: `bounds` (a saved window's) when enough of it is on a screen, else that size, centred; one
 * opened from another (`from`, its bounds) a step down and to the right of it; else the default size, centred. Never
 * below the window's minimum size. `workAreas`: the displays' work areas.
 */
function placement({ bounds = null, from = null, workAreas = [], min = { width: 900, height: 560 }, size = { width: 1440, height: 900 } } = {}) {
  const onScreen = (rect) => workAreas.some((area) => {
    const width = Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x);
    const height = Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y);
    return width >= 200 && height >= 120;
  });
  const sized = (rect) => ({ width: Math.max(min.width, rect.width), height: Math.max(min.height, rect.height) });
  const at = (rect) => { const out = { x: rect.x, y: rect.y, ...sized(rect) }; return onScreen(out) ? out : sized(rect); };
  if (bounds) return at(bounds);
  if (from) return at({ ...from, x: from.x + 24, y: from.y + 24 });
  return { ...size };
}

/**
 * `makeViews(ctx)` → { browserViews, postItViews } for a new window; `onChange()` runs whenever what would be saved of
 * the windows (which there are, where each is, its place) may have changed.
 */
function createWindows({ appUrl, manager, makeViews, onChange = () => {}, report = (error) => console.error(error) }) {
  const contexts = new Map(); // webContents id → context
  const leaving = new Set(); // closed windows whose post-its are still being let go (their cards' last edits saved)
  const owners = new Map(); // terminal session id → the context its output goes to
  const asking = new AsyncLocalStorage();
  let clock = 0; // focus order

  const open = (ctx) => !!ctx && contexts.get(ctx.id) === ctx && !ctx.win.isDestroyed() && !ctx.win.webContents.isDestroyed();

  function add(win, place = null) {
    const ctx = { id: win.webContents.id, win, place: place ? cleanPlace(place) : null, stageListeners: 0, focusedAt: ++clock, edgeResize: null };
    ctx.lifecycle = new RendererLifecycle(manager, (sessionId) => owners.get(sessionId) === ctx);
    contexts.set(ctx.id, ctx);
    Object.assign(ctx, makeViews(ctx));
    onChange();
    return ctx;
  }

  const of = (sender) => (sender ? contexts.get(sender.id) || null : null);
  const all = () => [...contexts.values()];

  /** The focused window, else the one focused last (a hidden one too: a dialog shows it first). */
  function focused() {
    let best = null;
    for (const ctx of contexts.values()) {
      if (ctx.win.isDestroyed()) continue;
      if (ctx.win.isFocused()) return ctx;
      if (!best || ctx.focusedAt > best.focusedAt) best = ctx;
    }
    return best;
  }

  function touch(ctx) { ctx.focusedAt = ++clock; }

  /** A window on a project, the one focused last first. */
  function showing(projectId) {
    let best = null;
    for (const ctx of contexts.values()) if (ctx.place && ctx.place.projectId === projectId && (!best || ctx.focusedAt > best.focusedAt)) best = ctx;
    return best;
  }

  // The page went (reloading): its Stage tabs and cards go with it, and its terminal pane is no longer attached.
  function reset(ctx) {
    ctx.stageListeners = 0;
    ctx.lifecycle.detach();
    ctx.browserViews.closeAll();
    void Promise.resolve(ctx.postItViews.activate(null)).catch(report);
  }

  // Its renderer crashed: the cards and the terminal let go; the Stage's pages stay for a reload to take back.
  function crashed(ctx) {
    ctx.stageListeners = 0;
    ctx.lifecycle.detach();
    void Promise.resolve(ctx.postItViews.activate(null)).catch(report);
  }

  // Closed: everything of its own goes; its terminal sessions keep running, held by no window until one attaches.
  function remove(ctx) {
    if (contexts.get(ctx.id) !== ctx) return;
    ctx.stageListeners = 0;
    ctx.lifecycle.detach();
    contexts.delete(ctx.id);
    for (const [sessionId, owner] of owners) if (owner === ctx) owners.delete(sessionId);
    ctx.browserViews.closeAll();
    if (ctx.browserViews.dispose) ctx.browserViews.dispose();
    leaving.add(ctx);
    void Promise.resolve(ctx.postItViews.activate(null)).catch(report).finally(() => {
      leaving.delete(ctx);
      if (ctx.postItViews.dispose) ctx.postItViews.dispose();
    });
    onChange();
  }

  /** The post-its holding a card's page: an open window's, or a closed one's still saving its cards. */
  function cardsHolding(sender) {
    for (const ctx of [...contexts.values(), ...leaving]) if (ctx.postItViews.holds(sender)) return ctx.postItViews;
    return null;
  }

  function navigated(ctx, place) {
    ctx.place = cleanPlace(place);
    onChange();
  }

  /** What a window opens on (its first page, or a reload): its place, the projects screen, or null (the app decides). */
  function target(ctx) {
    if (!ctx.place) return null;
    return ctx.place.projectId ? { ...ctx.place } : { home: true };
  }

  /** What is saved of the windows, the one focused last at the end: [{ projectId, workspaceId, bounds }]. A window that
   *  has not said where it is yet is left out. */
  function places() {
    return all()
      .filter((ctx) => ctx.place && !ctx.win.isDestroyed())
      .sort((a, b) => a.focusedAt - b.focusedAt)
      .map((ctx) => ({ ...ctx.place, bounds: typeof ctx.win.getNormalBounds === 'function' ? ctx.win.getNormalBounds() : ctx.win.getBounds() }));
  }

  /* ------------------------------------------------------------ sending */

  function send(ctx, channel, payload) {
    if (!open(ctx)) return false;
    try { ctx.win.webContents.send(channel, payload); return true; } catch { return false; }
  }

  function deliver(ctx, channel, payload) {
    return contexts.get(ctx && ctx.id) === ctx ? ctx.lifecycle.send(ctx.win, channel, payload) : false;
  }

  /** To every window (but `except`); `gated`: only those whose terminal pane has attached. → whether any took it */
  function broadcast(channel, payload, { except = null, gated = false } = {}) {
    let sent = false;
    for (const ctx of all()) {
      if (ctx === except) continue;
      if (gated ? deliver(ctx, channel, payload) : send(ctx, channel, payload)) sent = true;
    }
    return sent;
  }

  /** A trusted handler that knows which window called: `fn(ctx, ...args)`. */
  function handler(fn) {
    return async (event, ...args) => {
      assertTrustedRenderer(event, appUrl);
      const ctx = of(event.sender);
      if (!ctx) throw new Error('IPC rejected: unknown window');
      return asking.run(ctx, () => fn(ctx, ...args));
    };
  }

  /* ----------------------------------------------------------- terminals */

  /** The session's output goes to `ctx` from now on. → the open window it went to before, if another */
  function own(sessionId, ctx) {
    const before = owners.get(sessionId) || null;
    if (ctx && contexts.get(ctx.id) === ctx) owners.set(sessionId, ctx);
    else owners.delete(sessionId);
    manager.detachRenderer((id) => id === sessionId); // its flow control starts over with the window it goes to now
    return before && before !== ctx && open(before) ? before : null;
  }

  function ownerOf(sessionId) {
    const ctx = owners.get(sessionId);
    return open(ctx) ? ctx : null;
  }

  const forget = (sessionId) => owners.delete(sessionId);
  const attached = (sessionId) => { const ctx = owners.get(sessionId); return !!ctx && ctx.lifecycle.ready; };

  /** A window's terminal pane attaches: sessions no open window holds come to it. → every session (the bootstrap list) */
  function bootstrap(ctx) {
    for (const session of manager.list()) if (!open(owners.get(session.id))) owners.set(session.id, ctx);
    return ctx.lifecycle.bootstrap(() => manager.list());
  }

  function terminalData(payload) {
    const ctx = payload ? ownerOf(payload.id) : null;
    return ctx ? ctx.lifecycle.send(ctx.win, 'terminal:data', payload) : false;
  }

  return {
    add, of, all, focused, touch, showing, reset, crashed, remove, navigated, target, places, cardsHolding,
    send, deliver, broadcast, handler, asking: () => asking.getStore() || null,
    own, ownerOf, forget, attached, bootstrap, terminalData,
    count: () => contexts.size,
  };
}

module.exports = { createWindows, cleanPlace, placement };
