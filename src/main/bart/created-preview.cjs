'use strict';

// A picture of a page @create made (2026-10-14; ./create.cjs readCreated): the editor draws an html file's row thumbnail and
// its expanded view from it, since the window shows no frames (index.html's frame-src 'none'). The page is opened in a
// hidden, offscreen window of its own (an in-memory session, no node, sandboxed; it may not navigate or open windows),
// WIDTH wide, given a moment to draw itself, and captured as tall as it is, to MAX_HEIGHT. The picture is kept beside the
// file (`out`) and taken again only when the file is newer. One page at a time.

const fs = require('node:fs');
const path = require('node:path');

const WIDTH = 1200;
const MAX_HEIGHT = 4000;
const LOAD_MS = 8000;
const SETTLE_MS = 400;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** `BrowserWindow`: Electron's. → snapshot(file, out) → the png's bytes (a Buffer) */
function createSnapshotter({ BrowserWindow }) {
  let queue = Promise.resolve();
  return (file, out) => {
    const run = queue.then(() => shoot(file, out));
    queue = run.catch(() => {});
    return run;
  };

  async function shoot(file, out) {
    try { if (fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) return fs.readFileSync(out); } catch { /* none yet, or the file is gone */ }
    const win = new BrowserWindow({ show: false, width: WIDTH, height: 800, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'engelbart-created-preview', backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    try {
      await Promise.race([win.loadFile(file), pause(LOAD_MS)]);
      await pause(SETTLE_MS);
      const tall = await win.webContents.executeJavaScript('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)', true).catch(() => 800);
      const height = Math.max(200, Math.min(MAX_HEIGHT, Math.ceil(Number(tall) || 800)));
      win.setContentSize(WIDTH, height);
      await pause(200);
      const image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height });
      if (image.isEmpty()) throw new Error('The page drew nothing');
      const png = image.toPNG();
      fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
      fs.writeFileSync(out, png, { mode: 0o600 });
      return png;
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }
}

module.exports = { createSnapshotter, WIDTH, MAX_HEIGHT };
