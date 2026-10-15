'use strict';

// ⌘ + scroll zooms the workspace page (src/renderer/workspace/DocEditor.jsx zoomWheel, 2026-10-14): what is under the
// pointer stays under it (it does not scroll the page away), and the page is magnified, not laid out again, within its bounds, and only with ⌘ or ⌃ held (a trackpad
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
const { default: DocEditor, docZoomAfter, docColumnStyle, DOC_ZOOM_MIN, DOC_ZOOM_MAX } = load('DocEditor.jsx');

test('a wheel step zooms in going up and out going down, a notch about a tenth at most, within the bounds', () => {
  assert.ok(docZoomAfter(1, -100) > 1 && docZoomAfter(1, 100) < 1);
  assert.equal(docZoomAfter(1, -100), docZoomAfter(1, -10), 'a mouse notch is clamped');
  assert.equal(docZoomAfter(1, -100), 1.11);
  assert.ok(docZoomAfter(1, -4) > 1 && docZoomAfter(1, -4) < 1.06, 'a pinch step is small');
  assert.equal(docZoomAfter(DOC_ZOOM_MAX, -100), DOC_ZOOM_MAX);
  assert.equal(docZoomAfter(DOC_ZOOM_MIN, 100), DOC_ZOOM_MIN);
  assert.equal(docZoomAfter(1, 0), 1);
});

test('the column fits the pane at 1 and is the column as it was at 1, magnified, at any other zoom', () => {
  assert.deepEqual(docColumnStyle(1, { width: 600, pad: 24 }), { zoom: '', width: '', maxWidth: '65ch', paddingInline: 'clamp(0px, 3%, 24px)' });
  assert.deepEqual(docColumnStyle(1.5, null), docColumnStyle(1, null), 'not measured yet: as at 1');
  assert.deepEqual(docColumnStyle(1.5, { width: 600, pad: 24 }), { zoom: '1.5', width: '600px', maxWidth: 'none', paddingInline: '24px' });
});

// A pane 100px down the window and 50px in, scrolled by scrollTop and scrollLeft. Its column is 600px wide at 1, and in
// it a line ("the icon") 46px + 454px down the page and 100px in, 400px wide, all of it magnified with the zoom.
function editor({ compact = false } = {}) {
  const ed = new DocEditor({ docKey: 'k', text: 'one\ntwo', onChange() {}, compact });
  const pane = { scrollTop: 0, scrollLeft: 0, getBoundingClientRect: () => ({ top: 100 }) };
  const colTop = () => 100 - pane.scrollTop + 46, colLeft = () => 50 - pane.scrollLeft;
  const lineBox = () => ({ top: colTop() + 454 * ed.zoom, left: colLeft() + 100 * ed.zoom, width: 400 * ed.zoom, height: 40 * ed.zoom });
  const doc = { elementFromPoint: () => line, defaultView: { getComputedStyle: () => ({ paddingLeft: '24px' }) } };
  const col = { style: {}, ownerDocument: doc, contains: (el) => el === line, getBoundingClientRect: () => ({ top: colTop(), left: colLeft(), right: colLeft() + 600 * ed.zoom, width: 600 * ed.zoom, height: 2000 * ed.zoom }) };
  const line = { getBoundingClientRect: lineBox };
  ed.scrollRef = { current: pane };
  ed.colRef = { current: col };
  return { ed, col, pane, lineBox };
}
const wheel = (deltaY, mods = {}) => { const e = { deltaY, clientX: 300, clientY: 400, metaKey: false, ctrlKey: false, ...mods, prevented: false, preventDefault() { e.prevented = true; } }; return e; };

test('⌘ or ⌃ + wheel magnifies the column and keeps what is under the pointer there, both ways; a plain wheel scrolls; a sticky never zooms', () => {
  const { ed, col, pane, lineBox } = editor();
  assert.equal(ed.zoom, 1, 'nothing kept: as drawn');
  const plain = wheel(-100);
  ed.zoomWheel(plain);
  assert.deepEqual([plain.prevented, ed.zoom, col.style.zoom], [false, 1, undefined], 'a plain wheel is the pane\'s scroll');
  pane.scrollTop = 210; // the line starts 10px above the pointer (y 400): the pointer is a quarter of the way down it
  const b0 = lineBox(), fy = (400 - b0.top) / b0.height, fx = (300 - b0.left) / b0.width;
  const under = () => { const b = lineBox(); return [b.left + fx * b.width, b.top + fy * b.height]; };
  for (let n = 0; n < 4; n += 1) {
    const inward = wheel(-100, { metaKey: true });
    ed.zoomWheel(inward);
    assert.ok(inward.prevented && ed.zoom > 1 && col.style.zoom === String(ed.zoom));
    assert.deepEqual([col.style.width, col.style.maxWidth, col.style.paddingInline], ['600px', 'none', '24px'], 'the column as it was at 1');
    assert.deepEqual(under().map((v) => Math.round(v * 1e6) / 1e6), [300, 400], `still under the pointer at ${ed.zoom}`);
  }
  assert.ok(pane.scrollLeft > 0, 'wider than the pane: scrolled sideways to keep it');
  for (let n = 0; n < 4; n += 1) ed.zoomWheel(wheel(100, { ctrlKey: true }));
  assert.ok(Math.abs(ed.zoom - 1) < 0.02, 'a pinch out (⌃) zooms back out');
  assert.deepEqual(under().map((v) => Math.round(v * 1e6) / 1e6), [300, 400], 'and the line is where it was');
  const sticky = editor({ compact: true });
  const pinched = wheel(-100, { ctrlKey: true });
  sticky.ed.zoomWheel(pinched);
  assert.deepEqual([pinched.prevented, sticky.ed.zoom], [false, 1]);
});
