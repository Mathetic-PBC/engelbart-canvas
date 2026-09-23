'use strict';

// The window the GitHub sign-in happens in (2026-09-22): a small window over the app, on GitHub's own pages, sharing
// the Browser pane's cookies (partition `persist:browser`), so being signed in to github.com there is being signed in
// here, and signing in here signs the Browser pane in too. It goes only to github.com (and, for scripted runs, the
// fake GitHub named by ENGELBART_GITHUB_WEB); a link anywhere else opens in the default browser. It shows GitHub's
// device page for the code, and the App's install page. Electron is passed in.

function createGithubWindow({ BrowserWindow, shell, getParent, partition, extraOrigin = null, headless = false }) {
  let win = null;

  function allowed(url) {
    try {
      const target = new URL(url);
      if (extraOrigin && target.origin === new URL(extraOrigin).origin) return true;
      return target.protocol === 'https:' && (target.hostname === 'github.com' || target.hostname.endsWith('.github.com'));
    } catch {
      return false;
    }
  }

  const outside = (url) => { if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => {}); };

  function open(url) {
    if (!allowed(url)) { outside(url); return; }
    if (win && !win.isDestroyed()) {
      if (win.webContents.getURL() !== url) void win.loadURL(url).catch(() => {});
      win.show();
      win.focus();
      return;
    }
    const parent = getParent();
    win = new BrowserWindow({
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      width: 460,
      height: 720,
      minWidth: 360,
      minHeight: 480,
      title: 'GitHub',
      backgroundColor: '#ffffff',
      show: !headless,
      autoHideMenuBar: true,
      webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    const contents = win.webContents;
    contents.setWindowOpenHandler(({ url: next }) => { outside(next); return { action: 'deny' }; });
    const guard = (event, next) => { if (!allowed(next)) { event.preventDefault(); outside(next); } };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    win.on('closed', () => { win = null; });
    void win.loadURL(url).catch(() => {});
  }

  function close() {
    if (win && !win.isDestroyed()) win.close();
    win = null;
  }

  return { open, close, allowed };
}

module.exports = { createGithubWindow };
