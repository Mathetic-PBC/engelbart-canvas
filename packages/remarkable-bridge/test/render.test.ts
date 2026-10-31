import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readPage } from '../src/rm/page.ts';
import { pageToSvg } from '../src/render/svg.ts';
import { pdfMapping, UNITS_PER_POINT } from '../src/geometry.ts';
import { highlightsOf, pageMarkdown, textMarkdown } from '../src/extract/markdown.ts';

const PAGES = path.join(import.meta.dirname, 'fixtures', 'pages');
const page = (name: string) => readPage(new Uint8Array(fs.readFileSync(path.join(PAGES, name))));

test('SVG: one group per stroke, in page units over the page frame', () => {
  const p = page('Color_and_tool_v3.14.4.rm');
  const svg = pageToSvg(p);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox="-810 0 1620 2160"/);
  assert.equal((svg.match(/<g fill="none"/g) ?? []).length, p.strokes.length);
  assert.match(svg, /mix-blend-mode:multiply/, 'the shader and highlights multiply');
  assert.doesNotMatch(svg, /NaN|undefined/);
});

test('SVG: options for frame, background, text and hidden layers', () => {
  const p = page('Normal_A_stroke_2_layers_v3.3.2.rm');
  assert.match(pageToSvg(p, { background: '#fff' }), /<rect x="-702" y="0" width="1404" height="1872" fill="#fff"\/>/);
  assert.match(pageToSvg(p), /Heading line/);
  assert.doesNotMatch(pageToSvg(p, { text: false }), /Heading line/);
  const viewBox = pdfMapping({ x0: 0, y0: 0, x1: 612, y1: 792 }).viewBox;
  assert.match(pageToSvg(p, { frame: { viewBox } }), new RegExp(`viewBox="${viewBox}"`));
  p.layers[1]!.visible = false;
  const hidden = p.strokes.filter((s) => s.layer === 1).length;
  assert.equal((pageToSvg(p).match(/<g fill="none"/g) ?? []).length, p.strokes.length - hidden);
  assert.equal((pageToSvg(p, { hiddenLayers: true }).match(/<g fill="none"/g) ?? []).length, p.strokes.length);
});

test('PDF mapping: top-centre of the crop box, a fixed scale, round trips', () => {
  const m = pdfMapping({ x0: 0, y0: 0, x1: 612, y1: 792 }); // US Letter
  assert.deepEqual(m.toPdf(0, 0), [306, 792]);
  const [X, Y] = m.toPdf(-306 * UNITS_PER_POINT, 792 * UNITS_PER_POINT);
  assert.ok(Math.abs(X) < 1e-9 && Math.abs(Y) < 1e-9, 'the bottom-left corner');
  const [x, y] = m.fromPdf(...m.toPdf(123.4, 567.8));
  assert.ok(Math.abs(x - 123.4) < 1e-9 && Math.abs(y - 567.8) < 1e-9);
  // A crop box away from the origin moves the frame with it.
  assert.deepEqual(pdfMapping({ x0: 36, y0: 36, x1: 576, y1: 756 }).toPdf(0, 0), [306, 756]);
  assert.deepEqual(m.matrix, [72 / 227, 0, 0, -72 / 227, 306, 792]);
});

test('Markdown: typed text keeps headings, lists and inline marks', () => {
  assert.equal(textMarkdown(page('Bold_Heading_Bullet_Normal.rm')), '### A\n\n# new line\n\n- B is a letter of the alphabet\n\nC');
  assert.match(textMarkdown(page('Normal_A_stroke_2_layers_v3.3.2.rm')), /Normal \*\*bold\*\* \*italic\*/);
});

test('highlights: touching fragments become one passage, in reading order', () => {
  const passages = highlightsOf(page('Wikipedia_highlighted_p1.rm'));
  assert.deepEqual(passages.map((h) => h.text), [
    'The reMarkable uses electronic paper',
    'ReMarkable uses its own operating system, named Codex. Codex is based on Linux and optimized for electronic paper display technology.[13]',
  ]);
  assert.equal(passages[1]!.rects.length, 4);
  assert.match(pageMarkdown(page('Wikipedia_highlighted_p1.rm')), /^> The reMarkable uses electronic paper\n>\n> ReMarkable/);
});

test('PDF mapping on a rotated page: the tablet draws on the page as shown', () => {
  const box = { x0: 0, y0: 0, x1: 612, y1: 792 }; // portrait in the file
  const k = UNITS_PER_POINT;
  const close = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  // Shown landscape (792 wide, 612 high) at 90 and 270: its top-left, top-right and bottom-left corners in PDF space.
  const r90 = pdfMapping(box, k, 90);
  assert.ok(close(r90.toPdf(-396 * k, 0), [0, 0]), '90: shown top-left is the file\'s bottom-left');
  assert.ok(close(r90.toPdf(396 * k, 0), [0, 792]), '90: shown top-right is the file\'s top-left');
  assert.ok(close(r90.toPdf(-396 * k, 612 * k), [612, 0]), '90: shown bottom-left is the file\'s bottom-right');
  const r270 = pdfMapping(box, k, 270);
  assert.ok(close(r270.toPdf(-396 * k, 0), [612, 792]), '270: shown top-left is the file\'s top-right');
  const r180 = pdfMapping(box, k, 180);
  assert.ok(close(r180.toPdf(-306 * k, 0), [612, 0]), '180: shown top-left is the file\'s bottom-right');
  assert.equal(r90.viewBox, `${-(792 * k) / 2} 0 ${792 * k} ${612 * k}`.replace(/(\.\d{3})\d+/g, '$1'));
  for (const m of [pdfMapping(box), r90, r180, r270]) {
    const [x, y] = m.fromPdf(...m.toPdf(123.4, 567.8));
    assert.ok(Math.abs(x - 123.4) < 1e-6 && Math.abs(y - 567.8) < 1e-6, 'round trip');
  }
});
