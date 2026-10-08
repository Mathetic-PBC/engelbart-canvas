'use strict';

function shouldHideWindowOnClose(platform, quitReady) {
  return platform === 'darwin' && !quitReady;
}

// One per window (2026-10-03): `scope(id)` names the terminal sessions whose output goes to this window, and only their
// flow control follows it. Without a scope it is every session's, as when there was one window.
class RendererLifecycle {
  constructor(manager, scope = null) {
    this.manager = manager;
    this.scope = scope;
    this.ready = false;
  }

  bootstrap(snapshot) {
    this.manager.attachRenderer(this.scope);
    this.ready = true;
    try {
      return snapshot();
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  detach() {
    this.ready = false;
    this.manager.detachRenderer(this.scope);
  }

  send(window, channel, payload) {
    if (!this.ready) return false;
    if (!window || window.isDestroyed() || !window.webContents || window.webContents.isDestroyed()) {
      this.detach();
      return false;
    }
    try {
      window.webContents.send(channel, payload);
      return true;
    } catch {
      this.detach();
      return false;
    }
  }
}

module.exports = { RendererLifecycle, shouldHideWindowOnClose };
