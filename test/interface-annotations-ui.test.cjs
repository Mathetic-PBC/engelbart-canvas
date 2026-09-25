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
const previousWindow = global.window;
global.window = { engelbartAPI: {} };
try { compiled._compile(built.outputFiles[0].text, filename); }
finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
const { default: InterfaceAnnotations, annotationPosition } = compiled.exports;

test('direct selection adds no sidebar, banner, or layout content; browsing notes is explicit', () => {
  const props = { projectId: 'project', tabId: 'tab', url: 'https://example.com', onClose() {} };
  assert.equal(renderToStaticMarkup(React.createElement(InterfaceAnnotations, { ...props, mode: 'select' })), '');
  const browse = renderToStaticMarkup(React.createElement(InterfaceAnnotations, { ...props, mode: 'browse' }));
  assert.match(browse, /<aside class="interface-annotations"/);
  assert.doesNotMatch(browse, /Selecting · Esc to stop|Point at an element/);
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/Stage.jsx'), 'utf8');
  assert.match(source, /setAnnotationMode\(annotating \? null : 'select'\)/);
  assert.match(source, /data-annotations-browse="1"[\s\S]*?setAnnotationMode\('browse'\)/);
  assert.match(source, /Annotating · Esc to cancel/);
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

test('annotation styles and owned page overlay use neutral, non-debug presentation', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/workspace/interface-annotations.css'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../src/main/browser/annotation-page.cjs'), 'utf8');
  assert.doesNotMatch(css + page, /#2563eb|#1d4ed8|#eff6ff|crosshair|Math\.round\(r\.w\)/);
  assert.match(page, /chip\.textContent = targetLabel\(describe\(hit\.el\)\)/);
  assert.match(css, /\.interface-annotations\.ia-composer\{position:fixed/);
});
