'use strict';

// The Agent trace window (2026-10-13, the workspace: "create a plain UI like https://mathetic.com/bart that shows the
// prompts, input, output, and context for all the agents and dispatching involved in this process"). View ▸ Agent Trace
// opens it: ./trace.html, a plain page with no app chrome, fed by ./trace.cjs (the last entries at once, each new one as
// it happens). "Save as HTML" writes the page as it shows, with its entries, as one file that opens anywhere.

const fs = require('node:fs');
const path = require('node:path');

/**
 * `BrowserWindow`, `dialog` (Electron's, or fakes); `trace` (./trace.cjs); `traceDir()` where its files are, for Reveal;
 * `reveal(path)`. → { open, send, isOpen, save }
 */
function createTraceWindow({ BrowserWindow, dialog = null, trace, traceDir = () => '', reveal = () => {}, preload = path.join(__dirname, 'trace-preload.cjs'), page = path.join(__dirname, 'trace.html') }) {
  let win = null;

  function open() {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return true; }
    win = new BrowserWindow({
      width: 980, height: 820, minWidth: 560, minHeight: 400, title: 'Agent trace', show: false, backgroundColor: '#ffffff',
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.loadFile(page).catch(() => {});
    win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
    win.on('closed', () => { win = null; });
    return true;
  }

  /** A new or changed entry, to the window when it is open. */
  function send(entry) {
    if (win && !win.isDestroyed()) win.webContents.send('trace:entry', entry);
  }

  /** The page as it shows (`html`, built by the page itself), written where the person picks. → the path, or '' */
  async function save(html) {
    if (typeof html !== 'string' || !html.startsWith('<!doctype html>') || html.length > 60_000_000) throw new TypeError('html is invalid');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const options = { title: 'Save agent trace', defaultPath: `Engelbart agent trace ${stamp}.html`, filters: [{ name: 'HTML', extensions: ['html'] }] };
    const out = dialog ? await (win && !win.isDestroyed() ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)) : { canceled: true };
    if (!out || out.canceled || !out.filePath) return '';
    fs.writeFileSync(out.filePath, html, { mode: 0o600 });
    return out.filePath;
  }

  return {
    open, send, save,
    isOpen: () => !!(win && !win.isDestroyed()),
    list: () => trace.list(),
    revealFolder: () => { const dir = traceDir(); if (dir) reveal(dir); return !!dir; },
  };
}

module.exports = { createTraceWindow };
