'use strict';

// npx electron scripts/probe-paper-steps.cjs <pdf> <out-dir> <steps.cjs>
// PaperView alone on a pdf, as scripts/probe-paper-look.cjs mounts it (offscreen, 60 frames a second, focus emulated),
// then the steps module's default export run with { wc, js, pause, until, shot, click, type, wheel, steps, out }: a probe
// of one behaviour without a probe file of its own. Screenshots and steps.json go to <out-dir>.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const [pdfArg, outArg] = process.argv.slice(2).filter((a) => !a.endsWith('.cjs') && !a.startsWith('--'));
const stepsArg = process.argv.slice(2).filter((a) => a.endsWith('.cjs'))[0];
if (!pdfArg || !outArg || !stepsArg) { console.error('usage: npx electron scripts/probe-paper-steps.cjs <pdf> <out-dir> <steps.cjs>'); process.exit(2); }
const out = path.resolve(outArg);
fs.mkdirSync(out, { recursive: true });
const root = path.join(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-look-'));
app.setPath('userData', path.join(scratch, 'electron'));

const bundle = buildSync({
  stdin: { resolveDir: root, loader: 'jsx', contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import '@fontsource/caveat/500.css';
    import PaperView from './src/renderer/pdf/PaperView.jsx';
    window.saved = null;
    window.mount = (bytes) => {
      const ref = React.createRef();
      window.paper = ref;
      createRoot(document.getElementById('root')).render(
        <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', background: '#fff' }}>
          <PaperView ref={ref} bytes={bytes} marks={{}} onMarksChange={(m) => { window.saved = m; }} onOpenMention={() => {}} />
        </div>);
    };
  ` }, bundle: true, write: false, outdir: scratch, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.woff2': 'file', '.woff': 'file' }, define: { 'process.env.NODE_ENV': '"production"' },
});
for (const f of bundle.outputFiles) fs.writeFileSync(path.join(scratch, path.basename(f.path) === 'stdin.js' ? 'fixture.js' : path.basename(f.path) === 'stdin.css' ? 'fixture.css' : path.basename(f.path)), f.contents);
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), path.join(scratch, 'pdf.worker.min.mjs'));
// pdf.js's decoders and fonts, as the app's build copies them (scripts/build.mjs): a scan's images need the wasm ones.
for (const folder of ['standard_fonts', 'cmaps', 'wasm']) fs.cpSync(path.join(root, 'node_modules/pdfjs-dist', folder), path.join(scratch, folder), { recursive: true });
fs.copyFileSync(path.resolve(pdfArg), path.join(scratch, 'paper.pdf'));
fs.writeFileSync(path.join(scratch, 'fixture.html'), '<html><head><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><style>html,body{margin:0;height:100%;font-family:-apple-system,sans-serif}:root{--font-sans:-apple-system,sans-serif}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, tries = 400) {
  for (let i = 0; i < tries; i += 1) { try { const v = await fn(); if (v) return v; } catch { /* not yet */ } await pause(50); }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const steps = [];
  try {
    const win = new BrowserWindow({ show: false, width: 900, height: 820, webPreferences: { backgroundThrottling: false, offscreen: true } });
    const wc = win.webContents;
    wc.setFrameRate(60);
    wc.on('console-message', (e) => { if (/error/i.test(String(e.level))) console.log('[page]', e.message); });
    await win.loadFile(path.join(scratch, 'fixture.html'));
    // A page that does not have the focus fires no focus or blur events, and a note left would never know it: it acts as
    // focused (CDP focus emulation), as the app's window is while a person types.
    wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const js = (code) => wc.executeJavaScript(code, true);
    await js("fetch('paper.pdf').then((r) => r.arrayBuffer()).then((buf) => window.mount(new Uint8Array(buf)))");
    await until(() => js('!!document.querySelector("[data-pdf] canvas") && document.querySelectorAll("[data-text-layer] span").length > 50'), 'page 1 with its text');
    await pause(1200);
    const shot = async (name, found = {}) => {
      await pause(350);
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(out, `${String(steps.length + 1).padStart(2, '0')}-${name}.png`), img.toPNG());
      const state = await js(`(() => { const h = document.querySelector('[data-pdf]'); return { top: Math.round(h.scrollTop), left: Math.round(h.scrollLeft), scrollWidth: h.scrollWidth, clientWidth: h.clientWidth, pct: window.paper.current.state.pct }; })()`);
      steps.push({ step: name, ...state, ...found });
    };
    const click = async (x, y) => { wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 }); await pause(30); wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 }); await pause(120); };
    const type = async (text) => { for (const ch of text) { wc.sendInputEvent({ type: 'keyDown', keyCode: ch === ' ' ? 'Space' : ch }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch === ' ' ? 'Space' : ch }); await pause(12); } await pause(150); };
    const wheel = async (dy, mods = [], dx = 0, n = 1, x = 450, y = 400) => { for (let i = 0; i < n; i += 1) { wc.sendInputEvent({ type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy, hasPreciseScrollingDeltas: true, canScroll: true, modifiers: mods }); await pause(14); } await pause(500); };

    await shot('open-100pct');
    await require(path.resolve(stepsArg))({ wc, js, pause, until, shot, click, type, wheel, steps, out });
    console.log(JSON.stringify(steps, null, 1));
    console.log('saved', JSON.stringify(await js('window.saved'), null, 0).slice(0, 1500));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    console.log(JSON.stringify(steps, null, 1));
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
