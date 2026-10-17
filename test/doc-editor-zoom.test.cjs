'use strict';

// The workspace page has no zoom (Hudson, 2026-10-16; the ⌘ + scroll and pinch zoom of 2026-10-14 is gone): a pinch,
// which reaches the page as ⌃ + wheel, does nothing, and ⌘ + wheel and a plain wheel scroll the pane.

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
const { default: DocEditor } = load('DocEditor.jsx');
const wheel = (mods = {}) => { const e = { deltaY: -100, metaKey: false, ctrlKey: false, ...mods, prevented: false, preventDefault() { e.prevented = true; } }; return e; };

test('a pinch does nothing; ⌘ + wheel and a plain wheel scroll; the column is never zoomed', () => {
  const ed = new DocEditor({ docKey: 'k', text: 'one\ntwo', onChange() {} });
  assert.equal(typeof ed.zoomWheel, 'undefined');
  assert.equal(ed.zoom, undefined);
  const pinch = wheel({ ctrlKey: true }), command = wheel({ metaKey: true }), plain = wheel();
  for (const e of [pinch, command, plain]) ed.noZoom(e);
  assert.deepEqual([pinch.prevented, command.prevented, plain.prevented], [true, false, false]);
});
