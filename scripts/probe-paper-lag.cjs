'use strict';

// npx electron scripts/probe-paper-lag.cjs [pdf] [--profile out.cpuprofile]
// Hudson, 2026-10-16: "There is a TON of lag on panning and zooming in PDFs using my trackpad. Not only does it cause the
// PDF to lag but it also causes all of Engelbart to freeze for a bit." This loads PaperView alone (bundled with esbuild,
// as smoke-canvas-focus does) on a pdf with a few highlights and notes on every page, then sends trackpad-like wheel
// events: a two-finger scroll down, a pinch in, a pinch out (a pinch reaches Chromium as wheel events with ctrlKey). For
// each phase it reports the longest stall of the renderer's main thread (a MessageChannel ping loop) and its long tasks,
// during the gesture and in the 2.5 s after it, when the viewer draws for the new zoom. The window is never shown; the
// switches keep a hidden renderer drawing. Nothing of the person's Engelbart is read or written.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--') && !a.endsWith('.cjs'));
const profileAt = process.argv.indexOf('--profile');
const profileOut = profileAt > 0 ? process.argv[profileAt + 1] : null;
const pdfPath = path.resolve(args.find((a) => a.endsWith('.pdf')) || path.join(__dirname, '..', 'fixtures', 'hypocompass.pdf'));
const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lag-'));
app.setPath('userData', path.join(scratch, 'electron'));

const bundle = buildSync({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import PaperView from './src/renderer/pdf/PaperView.jsx';
    window.mount = (bytes, marks) => {
      const ref = React.createRef();
      window.paper = ref;
      createRoot(document.getElementById('root')).render(
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column' }}>
          <PaperView ref={ref} bytes={bytes} marks={marks} onMarksChange={() => {}} onOpenMention={() => {}} />
        </div>);
    };
  ` }, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty', '.js': 'jsx' }, define: { 'process.env.NODE_ENV': '"production"' },
});
fs.writeFileSync(path.join(scratch, 'fixture.js'), bundle.outputFiles[0].text);
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), path.join(scratch, 'pdf.worker.min.mjs'));
// pdf.js's decoders and fonts, as the app's build copies them (scripts/build.mjs): a scan's images need the wasm ones.
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) fs.cpSync(path.join(root, 'node_modules/pdfjs-dist', folder), path.join(scratch, folder), { recursive: true });
fs.copyFileSync(pdfPath, path.join(scratch, 'paper.pdf'));
fs.writeFileSync(path.join(scratch, 'fixture.html'), '<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');

// A few highlights and notes on every page, in page units, as a reader's would be.
function marksFor(pages) {
  const out = {};
  for (let n = 1; n <= pages; n += 1) {
    const list = [];
    for (let i = 0; i < 4; i += 1) {
      const y = 0.18 + i * 0.28;
      list.push({ id: `m${n}-${i}`, rects: [{ x: 0.1, y, w: 0.36, h: 0.016 }, { x: 0.1, y: y + 0.02, w: 0.36, h: 0.016 }, { x: 0.1, y: y + 0.04, w: 0.2, h: 0.016 }], side: 'left', y, note: i % 2 ? `a note on page ${n}, the ${i}th, long enough to wrap onto a second line` : null, text: 'passage' });
    }
    list.push({ id: `f${n}`, rects: [], side: null, y: 0.6, note: 'a free note typed on the page', text: '', pos: { x: 0.55, y: 0.6 } });
    out[n] = list;
  }
  return out;
}

// Drawn offscreen at 60 frames a second, so style, layout and paint run as in a shown window (a hidden one skips them).
const wc0 = (win) => { win.webContents.setFrameRate(60); win.webContents.on('paint', () => {}); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 400) {
  for (let i = 0; i < tries; i += 1) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await pause(50); }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 820, webPreferences: { backgroundThrottling: false, offscreen: true } });
    wc0(win);
    win.setFocusable(false);
    const wc = win.webContents;
    wc.on('console-message', (e) => { if (/error|warn/i.test(String(e.level))) console.log('[page]', e.message); });
    await win.loadFile(path.join(scratch, 'fixture.html'));
    const js = (code) => wc.executeJavaScript(code, true);
    // The stall monitor: the longest gap between two pings of the main thread, and the long tasks, since the last reset.
    await js(`(() => {
      const m = window.lag = { worst: 0, tasks: [], last: performance.now() };
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { const now = performance.now(); m.worst = Math.max(m.worst, now - m.last); m.last = now; setTimeout(() => ch.port2.postMessage(0), 4); };
      ch.port2.postMessage(0);
      new PerformanceObserver((list) => { for (const e of list.getEntries()) m.tasks.push(Math.round(e.duration)); }).observe({ entryTypes: ['longtask'] });
      window.lagReset = () => { m.worst = 0; m.tasks = []; m.last = performance.now(); };
      window.lagRead = () => ({ worstGap: Math.round(m.worst), longTasks: m.tasks.length, longTaskMs: m.tasks.reduce((a, b) => a + b, 0), biggest: Math.max(0, ...m.tasks) });
    })()`);
    const count = Number(require('node:child_process').execFileSync('pdfinfo', [pdfPath]).toString().match(/Pages:\s+(\d+)/)[1]);
    await js(`fetch('paper.pdf').then((r) => r.arrayBuffer()).then((buf) => window.mount(new Uint8Array(buf), ${JSON.stringify(marksFor(count))}))`);
    await until(() => js('!!document.querySelector("[data-pdf] canvas") && !window.paper.current.state.note'), 'the first page drawn');
    await pause(3000);
    const results = { pdf: path.basename(pdfPath), pages: count };
    const where = await js('(() => { const r = document.querySelector("[data-pdf]").getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()');
    if (profileOut) { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Profiler.enable'); await wc.debugger.sendCommand('Profiler.setSamplingInterval', { interval: 200 }); await wc.debugger.sendCommand('Profiler.start'); }
    const wheel = (dy, mods = [], dx = 0) => wc.sendInputEvent({ type: 'mouseWheel', x: where.x, y: where.y, deltaX: dx, deltaY: dy, wheelTicksX: 0, wheelTicksY: 0, hasPreciseScrollingDeltas: true, canScroll: true, modifiers: mods });
    async function phase(label, gesture, settle = 2500) {
      await js('window.lagReset()');
      const t0 = Date.now();
      await gesture();
      const during = await js('window.lagRead()');
      during.ms = Date.now() - t0;
      await js('window.lagReset()');
      await pause(settle);
      const after = await js('window.lagRead()');
      const state = await js('(() => { const h = document.querySelector("[data-pdf]"); return { top: Math.round(h.scrollTop), left: Math.round(h.scrollLeft), pct: window.paper.current.state.pct }; })()');
      results[label] = { during, after, state };
    }
    // Two-finger scroll down: 90 events, 16 ms apart, 18 px each (≈ a flick and its momentum).
    await phase('scroll', async () => { for (let i = 0; i < 90; i += 1) { wheel(-18); await pause(16); } });
    // Sideways scroll: 40 events of 20 px left-right (Hudson: no horizontal panning).
    await phase('sideways', async () => { for (let i = 0; i < 40; i += 1) { wheel(0, [], -20); await pause(16); } }, 500);
    // Pinch in: 45 events of ctrl+wheel, 12 ms apart (macOS sends pinch as small ctrl-wheel deltas).
    await phase('pinchIn', async () => { for (let i = 0; i < 45; i += 1) { wheel(4, ['control']); await pause(12); } });
    // Pinch out, further than it came in.
    await phase('pinchOut', async () => { for (let i = 0; i < 70; i += 1) { wheel(-4, ['control']); await pause(12); } });
    await phase('scrollAfterZoom', async () => { for (let i = 0; i < 90; i += 1) { wheel(-18); await pause(16); } });
    if (profileOut) {
      const { profile } = await wc.debugger.sendCommand('Profiler.stop');
      fs.writeFileSync(profileOut, JSON.stringify(profile));
      results.profile = profileOut;
    }
    console.log(JSON.stringify(results, null, 1));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
