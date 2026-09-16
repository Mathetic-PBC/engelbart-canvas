'use strict';

function shouldHideWindowOnClose(platform, quitReady) {
  return platform === 'darwin' && !quitReady;
}

class RendererLifecycle {
  constructor(manager) {
    this.manager = manager;
    this.ready = false;
  }

  bootstrap(snapshot) {
    this.manager.attachRenderer();
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
    this.manager.detachRenderer();
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
