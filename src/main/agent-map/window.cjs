'use strict';

// The Agent map (2026-10-12): a window for developers only, one per app, that shows every @bart, @brainstorm and
// @discover run as it happens (../bart/runlog.cjs) and how each agent is set up (./design.cjs). The app's own renderer and
// preload at `?view=agent-map` (src/renderer/index.jsx reads it once). It is no workspace window: not in the windows
// registry (../windows.cjs), so its IPC is the trusted handlers' that need no window's context. Opened only while test
// mode is on (`available`: a copy with test mode, ../developer.cjs, and the mode on; 2026-10-12): `open()` does nothing
// otherwise, and focuses it when it is already open. `closeUnlessAvailable()` closes it once test mode is off
// (../ipc.cjs, set-test-mode). Electron is passed in.

const VIEW = 'agent-map';

function createAgentMapWindow({ BrowserWindow, appUrl, preload, available = () => false, headless = false }) {
  let win = null;
  const alive = () => !!win && !win.isDestroyed();

  /** → whether it is open now. */
  function open() {
    if (!available()) return false;
    if (alive()) { win.show(); win.focus(); return true; }
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 720,
      minHeight: 420,
      title: 'Agent map',
      backgroundColor: '#ffffff',
      show: !headless,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== win.webContents.getURL()) event.preventDefault(); });
    win.on('closed', () => { win = null; });
    void win.loadURL(`${appUrl}?view=${VIEW}`).catch(() => {});
    return true;
  }

  /** `channel` with `payload` to the map alone, when it is open and loaded. */
  function send(channel, payload) {
    if (!alive() || win.webContents.isLoading()) return false;
    try { win.webContents.send(channel, payload); return true; } catch { return false; }
  }

  function close() {
    if (alive()) win.close();
    win = null;
  }

  /** Closes the map when test mode is no longer on. → whether it is open now. */
  function closeUnlessAvailable() {
    if (!available()) close();
    return alive();
  }

  return { open, send, close, closeUnlessAvailable, isOpen: alive, window: () => (alive() ? win : null) };
}

module.exports = { createAgentMapWindow, VIEW };
