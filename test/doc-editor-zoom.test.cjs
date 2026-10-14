'use strict';

// ⌘ + scroll zooms the workspace page (src/renderer/workspace/DocEditor.jsx zoomWheel, 2026-10-14): what is under the
// pointer stays under it (it does not scroll the page away), within its bounds, and only with ⌘ or ⌃ held (a trackpad
// pinch arrives as ⌃ + wheel). A sticky's editor never zooms.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

function load(file) {
  const filename = path.join(__dirname, `__${path.basename(file, '.jsx')}-zoom-unit.cjs`);
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace', file)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const { default: DocEditor, docZoomAfter, DOC_ZOOM_MIN, DOC_ZOOM_MAX } = load('DocEditor.jsx');

test('a wheel step zooms in going up and out going down, a notch about a tenth at most, within the bounds', () => {
  assert.ok(docZoomAfter(1, -100) > 1 && docZoomAfter(1, 100) < 1);
  assert.equal(docZoomAfter(1, -100), docZoomAfter(1, -10), 'a mouse notch is clamped');
  assert.equal(docZoomAfter(1, -100), 1.11);
  assert.ok(docZoomAfter(1, -4) > 1 && docZoomAfter(1, -4) < 1.06, 'a pinch step is small');
  assert.equal(docZoomAfter(DOC_ZOOM_MAX, -100), DOC_ZOOM_MAX);
  assert.equal(docZoomAfter(DOC_ZOOM_MIN, 100), DOC_ZOOM_MIN);
  assert.equal(docZoomAfter(1, 0), 1);
});

// A pane 100px down the window, scrolled by scrollTop, and in its column a line ("the icon") that starts 46px + 454px
// into the page as drawn. Zoomed in, the text above it rewraps onto more lines, so it lands lower than the zoom alone
// would put it (454 × zoom, plus 30px a step past 1): the zoom has to measure where it went, not scale.
function editor({ compact = false } = {}) {
  const ed = new DocEditor({ docKey: 'k', text: 'one\ntwo', onChange() {}, compact });
  const pane = { scrollTop: 0, getBoundingClientRect: () => ({ top: 100 }) };
  const colTop = () => 100 - pane.scrollTop + 46;
  const lineTop = () => colTop() + 454 * ed.zoom + Math.max(0, ed.zoom - 1) * 300;
  const doc = { elementFromPoint: () => line };
  const col = { style: {}, ownerDocument: doc, contains: (el) => el === line, getBoundingClientRect: () => ({ top: colTop(), left: 0, right: 600, width: 600, height: 2000 * ed.zoom }) };
  const line = { getBoundingClientRect: () => ({ top: lineTop(), height: 40 * ed.zoom }) };
  ed.scrollRef = { current: pane };
  ed.colRef = { current: col };
  return { ed, col, pane, lineTop };
}
const wheel = (deltaY, mods = {}) => { const e = { deltaY, clientX: 300, clientY: 400, metaKey: false, ctrlKey: false, ...mods, prevented: false, preventDefault() { e.prevented = true; } }; return e; };

test('⌘ or ⌃ + wheel zooms the column and keeps what is under the pointer there, rewrapped or not; a plain wheel scrolls; a sticky never zooms', () => {
  const { ed, col, pane, lineTop } = editor();
  assert.equal(ed.zoom, 1, 'nothing kept: as drawn');
  const plain = wheel(-100);
  ed.zoomWheel(plain);
  assert.deepEqual([plain.prevented, ed.zoom, col.style.zoom], [false, 1, undefined], 'a plain wheel is the pane\'s scroll');
  pane.scrollTop = 210; // the line starts 10px above the pointer (y 400): the pointer is a quarter of the way into it
  const pointerIn = 400 - lineTop(), inLine = pointerIn / 40;
  for (let n = 0; n < 4; n += 1) {
    const inward = wheel(-100, { metaKey: true });
    ed.zoomWheel(inward);
    assert.ok(inward.prevented && ed.zoom > 1 && col.style.zoom === String(ed.zoom));
    assert.ok(Math.abs(lineTop() + inLine * 40 * ed.zoom - 400) < 1e-6, `still under the pointer at ${ed.zoom}`);
  }
  for (let n = 0; n < 4; n += 1) ed.zoomWheel(wheel(100, { ctrlKey: true }));
  assert.ok(Math.abs(ed.zoom - 1) < 0.02, 'a pinch out (⌃) zooms back out');
  assert.ok(Math.abs(lineTop() + inLine * 40 * ed.zoom - 400) < 1e-6, 'and the line is where it was');
  const sticky = editor({ compact: true });
  const pinched = wheel(-100, { ctrlKey: true });
  sticky.ed.zoomWheel(pinched);
  assert.deepEqual([pinched.prevented, sticky.ed.zoom], [false, 1]);
});
