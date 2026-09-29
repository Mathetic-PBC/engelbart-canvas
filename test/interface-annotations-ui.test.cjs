'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const filename = path.join(__dirname, '__annotation-ui.cjs');
const built = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/InterfaceAnnotations.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
const compiled = new Module(filename, module); compiled.paths = module.paths;
// Render portal contents inline for markup assertions; real placement and
// dismissal are covered by the isolated Electron interaction test.
compiled.require = function(id) { return id === 'react-dom' ? { createPortal: child => child } : Module.prototype.require.call(this, id); };
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { default: InterfaceAnnotations, annotationPosition, annotationListPosition, annotationChatPosition } = compiled.exports;

test('direct selection adds no sidebar, banner, or layout content; browsing notes is explicit', () => {
  const props = { projectId: 'project', tabId: 'tab', url: 'https://example.com', onClose() {} };
  assert.equal(renderToStaticMarkup(React.createElement(InterfaceAnnotations, { ...props, mode: 'select' })), '');
  const previousDocument = global.document;
  let browse;
  try {
    global.document = { body: {} };
    browse = renderToStaticMarkup(React.createElement(InterfaceAnnotations, { ...props, mode: 'browse' }));
  } finally { if (previousDocument === undefined) delete global.document; else global.document = previousDocument; }
  assert.match(browse, /role="dialog" aria-label="Annotations" data-overlay="1" class="stage-popover interface-annotations ia-popover ia-browser"/);
  assert.match(browse, /class="ia-list" aria-busy="true"/);
  assert.match(browse, /<strong>Annotations<\/strong>/);
  assert.doesNotMatch(browse, /<aside|ia-pick|Select an element|Selecting · Esc to stop|Point at an element/);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Stage.jsx'), 'utf8');
  assert.match(source, /setAnnotationMode\(annotating \? null : 'select'\)/);
  assert.match(source, /data-annotations-browse="1"[\s\S]*?setAnnotationMode\('browse'\)/);
  assert.match(source, /Annotating · Esc to cancel/);
  assert.doesNotMatch(source, /data-saved-annotations|annotationSummary|Notes ·/);
  assert.match(source, /data-annotate-toggle="1"[^>]+aria-label=\{annotating[^>]+hint=\{annotating/);
  assert.match(source, /data-annotate-toggle="1"[\s\S]*?<ANNOTATE \/>/);
  assert.match(source, /data-record-toggle="1"[\s\S]*?aria-label=\{recordingLabel\}[^>]+aria-pressed=\{recordingActive\}/);
  assert.match(source, /data-record-toggle="1"[\s\S]*?<svg/);
  assert.match(source, /recordingActive \? <STOP_RECORDING \/> : <RECORD \/>/);
  assert.match(source, /tip && <SaveTip id=\{tipId\} text=\{hint\} overlay/);
  assert.doesNotMatch(source, /data-annotation-markers|Keep markers visible|ANNOTATION_MARKERS_KEY|keepAnnotationMarkers/);
});

test('composer stays near its target and flips or clamps within the browser slot', () => {
  const slot = { left: 200, top: 100, right: 1000, bottom: 700, width: 800, height: 600 };
  const bounds = { x: 20, y: 40, w: 100, h: 30, viewportWidth: 800, viewportHeight: 600 };
  assert.deepEqual(annotationPosition(bounds, slot, { height: 200 }), { left: 220, top: 178, width: 300, maxHeight: 584 });
  assert.deepEqual(annotationPosition({ ...bounds, x: 760, y: 550 }, slot, { height: 200 }), { left: 692, top: 442, width: 300, maxHeight: 584 });
  assert.equal(annotationPosition({ ...bounds, y: -200 }, slot, { height: 200 }).top, 108);
  assert.equal(annotationPosition(bounds, { ...slot, right: 460, width: 260 }, { height: 200 }).width, 244);
  const scaled = annotationPosition({ ...bounds, x: 100, y: 100, viewportWidth: 400, viewportHeight: 300 }, slot, { height: 200 });
  assert.equal(scaled.left, 400); assert.equal(scaled.top, 368);
});

test('saved-annotation browser stays compact and inside narrow or short Stage viewports', () => {
  const slot = { left: 200, top: 100, right: 1000, bottom: 700, width: 800, height: 600 };
  assert.deepEqual(annotationListPosition(slot), { left: 692, top: 108, width: 300, maxHeight: 420 });
  assert.deepEqual(annotationListPosition({ ...slot, right: 460, width: 260 }), { left: 208, top: 108, width: 244, maxHeight: 420 });
  assert.equal(annotationListPosition({ ...slot, height: 200, bottom: 300 }).maxHeight, 184);
});

test('a growing conversation stays anchored on the same side and scrolls within available space', () => {
  const slot = { left: 200, top: 100, right: 1000, bottom: 700, width: 800, height: 600 };
  const bounds = { x: 20, y: 190, w: 100, h: 30, viewportWidth: 800, viewportHeight: 600 };
  const first = annotationChatPosition(bounds, slot, { height: 200 });
  const long = annotationChatPosition(bounds, slot, { height: 900 });
  assert.equal(first.top, 328);
  assert.deepEqual(long, first, 'messages cannot flip the chat above its target');
  assert.equal(long.top + long.maxHeight, slot.bottom - 8);
  const nearBottom = annotationChatPosition({ ...bounds, y: 540 }, slot, { height: 900 });
  assert.equal(nearBottom.top + nearBottom.maxHeight, slot.top + 540 - 8);
  const wholePage = annotationChatPosition({ ...bounds, y: 0, h: 600 }, slot, { height: 900 });
  assert.ok(wholePage.maxHeight > 0 && wholePage.top >= slot.top && wholePage.top + wholePage.maxHeight <= slot.bottom);
});

test('annotation styles and owned page overlay use neutral, non-debug presentation', () => {
  const css = ['interface-annotations.css', 'stage-popover.css'].map(file => fs.readFileSync(path.join(__dirname, '../src/renderer/workspace', file), 'utf8')).join('\n');
  const page = fs.readFileSync(path.join(__dirname, '../src/main/browser/annotation-page.cjs'), 'utf8');
  assert.doesNotMatch(css + page, /#2563eb|#1d4ed8|#eff6ff|crosshair|Math\.round\(r\.w\)/);
  assert.doesNotMatch(page, /\bchip\b/);
  assert.match(css, /\.stage-popover\{[^}]*position:fixed/);
  assert.doesNotMatch(css, /flex:0 0 260px|\.interface-annotations\{[^}]*border-left:/);
});
