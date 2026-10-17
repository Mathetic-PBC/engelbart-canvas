'use strict';

// npx electron scripts/probe-paper-look.cjs <pdf> <out-dir>
// The PDF annotations round (2026-10-16), driven as a person would: PaperView alone (bundled as probe-paper-lag does) on
// a pdf, offscreen at 60 frames a second, with real input events. It selects a passage on page 1 and types a note on it,
// clicks in the margin and types there, scrolls sideways, pinches out, writes on the desk beside the page, pinches back in
// and to 200%, and saves a screenshot after each step in <out-dir>, with what the step found in steps.json. Nothing of
// the person's Engelbart is read or written.
const { app, BrowserWindow } = require('electron');
const { buildSync } = require('esbuild');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const [pdfArg, outArg] = process.argv.slice(2).filter((a) => !a.endsWith('.cjs') && !a.startsWith('--'));
if (!pdfArg || !outArg) { console.error('usage: npx electron scripts/probe-paper-look.cjs <pdf> <out-dir>'); process.exit(2); }
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

    // A passage selected by dragging across three lines of page 1's body (the first long spans in the left column),
    // then a note typed on it.
    // The right column's words between 520 and 640 px down, in reading order (a scan's text layer has a span a word).
    const spans = await js(`(() => {
      const box = document.querySelector('[data-pdf]').getBoundingClientRect();
      const all = [...document.querySelectorAll('[data-text-layer="1"] span')].map((s) => ({ t: s.textContent, r: s.getBoundingClientRect() })).filter((s) => s.t.trim().length > 1 && s.r.top > box.top + 520 && s.r.top < box.top + 640 && s.r.left > box.left + 440 && s.r.right < box.left + 880);
      return all.map((s) => ({ t: s.t, x: Math.round(s.r.left), y: Math.round(s.r.top + s.r.height / 2), r: Math.round(s.r.right) }));
    })()`);
    const lines = [];
    for (const sp of spans) { const line = lines.find((l) => Math.abs(l[0].y - sp.y) < 6); if (line) line.push(sp); else lines.push([sp]); }
    lines.sort((a, b) => a[0].y - b[0].y);
    const pick = lines.length >= 3 ? [lines[0].sort((a, b) => a.x - b.x)[1] || lines[0][0], null, lines[2].sort((a, b) => a.x - b.x)[Math.max(0, lines[2].length - 2)]] : [];
    if (pick.length === 3 && pick[0] && pick[2]) {
      const a = pick[0], b = pick[2];
      wc.sendInputEvent({ type: 'mouseDown', x: a.x + 2, y: a.y, button: 'left', clickCount: 1 });
      for (let i = 1; i <= 12; i += 1) { wc.sendInputEvent({ type: 'mouseMove', x: Math.round(a.x + 2 + ((b.r - 2 - a.x - 2) * i) / 12), y: Math.round(a.y + ((b.y - a.y) * i) / 12), button: 'left' }); await pause(16); }
      wc.sendInputEvent({ type: 'mouseUp', x: b.r - 2, y: b.y, button: 'left', clickCount: 1 });
      await pause(250);
      const pending = await js('!!window.paper.current.pendingSel');
      await shot('selection-pending', { pending, from: a.t.slice(0, 30), to: b.t.slice(0, 30) });
      await type('this is the claim the whole paper rests on');
      await shot('highlight-note-typing');
      // Away from it: the note shows as handwriting beside its highlight.
      await click(450, 120);
      await shot('highlight-note-shown', { marks: await js('JSON.stringify(window.paper.current.marks[1].map((m) => ({ note: m.note, rects: m.rects.length, side: m.side, vis: m.vis })))') });
    } else steps.push({ step: 'selection', skipped: `${lines.length} lines of words found in the right column` });

    // Typing anywhere: a click in the page's right margin, then words.
    await js(`(() => { const v = window.paper.current, orig = v.leaveNote.bind(v); window.leaves = []; v.leaveNote = (ta, m, page) => { window.leaves.push({ redrawing: v.redrawing, connected: ta.isConnected, value: ta.value.slice(0, 12), active: document.activeElement && document.activeElement.tagName, editing: v.editing }); return orig(ta, m, page); }; })()`);
    await click(880, 250);
    await type('margin thought, wraps down not out');
    const typingIn = await js('document.activeElement && document.activeElement.tagName');
    await click(450, 700);
    steps.push({ step: 'left-margin-note', hasFocus: await js('document.hasFocus()'), leaves: await js('JSON.stringify(window.leaves)'), typingIn, after: await js('document.activeElement && document.activeElement.tagName'), editing: await js('String(window.paper.current.editing)') });
    await shot('typed-in-margin', { free: await js('JSON.stringify((window.paper.current.marks[1] || []).filter((m) => m.pos).map((m) => ({ note: m.note, w: m.w, pos: m.pos })))'), cards: await js('JSON.stringify([...document.querySelectorAll("[data-box]")].map((b) => ({ id: b.dataset.boxMark, opacity: getComputedStyle(b).opacity, field: !!b.querySelector("textarea"), color: getComputedStyle(b.querySelector("[data-note-view],textarea") || b).color })))'), focus: await js('window.paper.current.focusId + " " + window.paper.current.painted') });

    // Sideways: a two-finger swipe left and right moves nothing.
    await wheel(0, [], 30, 20);
    const sideways = await js('document.querySelector("[data-pdf]").scrollLeft');
    await shot('after-sideways-swipe', { scrollLeftAfterSwipe: sideways });

    // Pinch out to about 60%: the desk shows each side, the column in the middle.
    await wheel(-6, ['control'], 0, 9, 200, 300);
    await pause(400);
    await shot('pinched-out');
    // Writing on the desk left of the page.
    const deskX = await js('(() => { const p = window.paper.current, g = p.geo[1], box = document.querySelector("[data-pdf]").getBoundingClientRect(); return Math.round(box.left + g.G / 2); })()');
    await click(deskX, 300);
    await type('a note out on the desk');
    await click(deskX, 700);
    await shot('desk-note', { deskX });
    // Back to 100%, then 200%: the desk note is out of view (clipped), nothing scrolls sideways at 100%.
    await js('window.paper.current.zoomTo(100)');
    await pause(600);
    await shot('back-to-100', { scrollWidth: await js('document.querySelector("[data-pdf]").scrollWidth') });
    await wheel(6, ['control'], 0, 12, 700, 300);
    await pause(400);
    await shot('pinched-in-200');
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
