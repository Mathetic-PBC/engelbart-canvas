// The v6 parser against rmscene's fixtures (test/fixtures/pages, MIT) and the expectations rmscene's own tests hold
// for them, plus the notable notebook (test/fixtures/xochitl, Apache-2.0) and a v5 page made here.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readBlocks, isV6 } from '../src/rm/blocks.ts';
import { crdtOrder } from '../src/rm/crdt.ts';
import { readPage, RM2_PAGE } from '../src/rm/page.ts';
import { idKey, END_KEY } from '../src/rm/reader.ts';
import { RmFormatError } from '../src/doc/json.ts';

const PAGES = path.join(import.meta.dirname, 'fixtures', 'pages');
const NOTEBOOK = path.join(import.meta.dirname, 'fixtures', 'xochitl', 'f63a4691-25eb-43c5-95b0-a20c2dbeb80b');
const page = (name: string) => readPage(new Uint8Array(fs.readFileSync(path.join(PAGES, name))));
const lines = (name: string) => page(name).text!.paragraphs.map((p) => [p.kind, p.level, p.spans.map((s) => (s.bold ? `<b>${s.text}</b>` : s.italic ? `<i>${s.text}</i>` : s.text)).join('')]);

test('every fixture page parses with no unreadable block', () => {
  const files = [
    ...fs.readdirSync(PAGES).filter((f) => f.endsWith('.rm')).map((f) => path.join(PAGES, f)),
    ...fs.readdirSync(NOTEBOOK).map((f) => path.join(NOTEBOOK, f)),
  ];
  assert.ok(files.length >= 25);
  for (const file of files) {
    const bytes = new Uint8Array(fs.readFileSync(file));
    assert.ok(isV6(bytes), file);
    const unknown = readBlocks(bytes).filter((b) => b.kind === 'unknown');
    assert.deepEqual(unknown, [], file);
    assert.deepEqual(readPage(bytes).problems, [], file);
  }
});

test('typed text: paragraph styles (rmscene test_list)', () => {
  assert.deepEqual(lines('Bold_Heading_Bullet_Normal.rm'), [
    ['heading', 3, 'A'],
    ['heading', 1, 'new line'],
    ['bullet', 0, 'B is a letter of the alphabet'],
    ['plain', 0, 'C'],
  ]);
  assert.deepEqual(lines('Normal_AB.rm'), [['plain', 0, 'AB']]);
});

test('typed text: inline bold and italic (rmscene test_inline_formats)', () => {
  assert.deepEqual(lines('Normal_A_stroke_2_layers_v3.3.2.rm'), [
    ['plain', 0, 'A'],
    ['plain', 0, 'v3.2.2'],
    ['plain', 0, 'Normal <b>bold</b> <i>italic</i>'],
    ['plain', 0, '<b>Bold</b> <i>italic</i> normal'],
    ['heading', 3, 'Bold line'],
    ['plain', 0, 'Normal line'],
    ['heading', 1, 'Heading line'],
  ]);
});

test('concurrent inserts: higher author first, then lower counter ("A12_Z", rmscene test-crdt-ordering)', () => {
  assert.equal(page('test-crdt-ordering.rm').text!.paragraphs[0]!.text, 'A12_Z');
  const item = (a: number, c: number, left: [number, number], right: [number, number], v: string) =>
    ({ id: { a, c }, key: idKey(a, c), left: idKey(...left), right: idKey(...right), v });
  const items = [item(1, 1, [0, 0], [0, 0], 'A'), item(1, 2, [1, 1], [0, 0], 'Z'), item(2, 1, [1, 1], [1, 2], '12'), item(1, 3, [1, 1], [1, 2], '_')];
  assert.equal(crdtOrder(items).map((i) => i.v).join(''), 'A12_Z');
  assert.equal(crdtOrder([...items].reverse()).map((i) => i.v).join(''), 'A12_Z');
});

test('CRDT order: an unknown neighbour is the start or end, and a cycle loses nothing', () => {
  const item = (c: number, left: number, right: number) => ({ id: { a: 0, c }, key: idKey(0, c), left: left ? idKey(0, left) : END_KEY, right: right ? idKey(0, right) : END_KEY });
  assert.deepEqual(crdtOrder([item(8, 0, 0), item(9, 8, 0), item(3, 0, 0)]).map((i) => i.id.c), [3, 8, 9]);
  assert.deepEqual(crdtOrder([item(28, 0, 15), item(33, 32, 15)]).map((i) => i.id.c), [28, 33]);
  assert.equal(crdtOrder([item(1, 2, 0), item(2, 1, 0)]).length, 2);
});

test('highlights on a PDF page carry their text (rmscene test_read_glyph_range)', () => {
  const p = page('Wikipedia_highlighted_p1.rm');
  assert.equal(p.highlights[0]!.text, 'The reMarkable uses electronic paper');
  assert.equal(p.highlights[0]!.start, 821);
  assert.equal(p.highlights[3]!.rects.length, 2);
});

test('Paper Pro: page size, ARGB highlight colours and the shader', () => {
  const p = page('Color_and_tool_v3.14.4.rm');
  assert.deepEqual([p.width, p.height], [1620, 2160]);
  assert.deepEqual(p.highlights.map((h) => [h.color.r, h.color.g, h.color.b]), [[255, 237, 117], [190, 234, 254], [242, 158, 255], [255, 195, 140], [172, 255, 133], [199, 199, 198]]);
  const shader = p.strokes.find((s) => s.tool === 'shader')!;
  assert.ok(shader.color.a < 1, 'the shader is translucent');
  assert.deepEqual([page('Normal_AB.rm').width, page('Normal_AB.rm').height], [RM2_PAGE.width, RM2_PAGE.height]);
});

test('layers: names, order and visibility', () => {
  const p = page('Normal_A_stroke_2_layers.rm');
  assert.deepEqual(p.layers.map((l) => l.label), ['Layer 1', 'Layer 2']);
  assert.deepEqual([...new Set(p.strokes.map((s) => s.layer))].sort(), [0, 1]);
});

test('strokes anchored to the text land where the tablet drew them', () => {
  // Lines_v2_updated holds Lines_v2's strokes after the tablet moved them into a group anchored to the text.
  const before = page('Lines_v2.rm').strokes;
  const after = page('Lines_v2_updated.rm').strokes;
  assert.equal(before.length, after.length);
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!.points.decode(), b = after[i]!.points.decode();
    assert.ok(Math.abs(a.x[0]! - (b.x[0]! + after[i]!.dx)) < 0.01, 'x exact');
    assert.ok(Math.abs(a.y[0]! - (b.y[0]! + after[i]!.dy)) < 0.5, 'y within half a unit');
  }
});

test('deleted items are not drawn, but keep the order of the rest', () => {
  const p = page('More_color_highlight_shader_v3.15.4.2.rm');
  const items = readBlocks(new Uint8Array(fs.readFileSync(path.join(PAGES, 'More_color_highlight_shader_v3.15.4.2.rm')))).filter((b) => b.kind === 'item');
  const deleted = items.filter((b) => b.kind === 'item' && b.item.value === null).length;
  assert.ok(deleted > 0);
  assert.equal(p.strokes.length, items.length - deleted - 1 /* the layer's group item */);
});

test('points decode lazily into typed arrays, once', () => {
  const stroke = page('Lines_v2.rm').strokes[0]!;
  const d = stroke.points.decode();
  assert.ok(d.x instanceof Float32Array);
  assert.equal(d.count, stroke.points.count);
  assert.equal(stroke.points.decode(), d);
});

test('a block cut short becomes a problem, not a failure of the page', () => {
  const bytes = new Uint8Array(fs.readFileSync(path.join(PAGES, 'Lines_v2.rm')));
  const blocks = readBlocks(bytes);
  const line = blocks.find((b) => b.kind === 'item' && b.item.value?.type === 'line')!;
  const broken = bytes.slice();
  broken[line.header.offset] = 0x7f; // not the parent id's tag any more
  const p = readPage(broken);
  assert.equal(p.strokes.length, page('Lines_v2.rm').strokes.length - 1);
  assert.equal(p.problems.length, 1);
});

test('not a page at all is an RmFormatError', () => {
  assert.throws(() => readPage(new TextEncoder().encode('%PDF-1.7 not a page')), RmFormatError);
});

test('a v5 page (firmware 2.x) is read, x moved to the v6 centre', () => {
  const header = new TextEncoder().encode('reMarkable .lines file, version=5          ');
  const body = new ArrayBuffer(4 + 4 + 24 + 24 * 2);
  const v = new DataView(body);
  let o = 0;
  const i32 = (n: number) => { v.setInt32(o, n, true); o += 4; };
  const f32 = (n: number) => { v.setFloat32(o, n, true); o += 4; };
  i32(1); // layers
  i32(1); // lines
  i32(17); i32(0); i32(0); f32(2); i32(0); i32(2); // fineliner, black, ?, size, ?, 2 points
  for (const [x, y] of [[702, 100], [800, 120]] as const) { f32(x); f32(y); f32(0); f32(0); f32(1); f32(0.5); }
  const bytes = new Uint8Array(header.length + body.byteLength);
  bytes.set(header);
  bytes.set(new Uint8Array(body), header.length);
  const p = readPage(bytes);
  assert.equal(p.version, 5);
  assert.equal(p.strokes[0]!.tool, 'fineliner');
  assert.equal(p.strokes[0]!.points.decode().x[0]! + p.strokes[0]!.dx, 0);
});

/** A v6 page holding one RootText block whose single text item claims `deletedLength` deleted characters. */
function pageClaimingDeleted(deletedLength: number): Uint8Array {
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const le = (bytes: number, write: (v: DataView) => void) => { const b = new DataView(new ArrayBuffer(bytes)); write(b); out.push(...new Uint8Array(b.buffer)); };
  const u32 = (v: number) => le(4, (b) => b.setUint32(0, v >>> 0, true));
  const varuint = (v: number) => { do { let b = v % 128; v = Math.floor(v / 128); if (v) b |= 0x80; u8(b); } while (v); };
  const tag = (i: number, t: number) => varuint(i * 16 + t);
  const id = (i: number, a: number, c: number) => { tag(i, 0xf); u8(a); varuint(c); };
  const sub = (i: number, fill: () => void) => { tag(i, 0xc); const at = out.length; u32(0); const start = out.length; fill(); const n = out.length - start; const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, n, true); out.splice(at, 4, ...new Uint8Array(b.buffer)); };
  id(1, 0, 0);
  sub(2, () => {
    sub(1, () => sub(1, () => { varuint(1); sub(0, () => { id(2, 1, 16); id(3, 0, 0); id(4, 0, 0); tag(5, 0x4); u32(deletedLength); }); }));
    sub(2, () => sub(1, () => varuint(0)));
  });
  sub(3, () => { le(8, (b) => b.setFloat64(0, -468, true)); le(8, (b) => b.setFloat64(0, 234, true)); });
  tag(4, 0x4); le(4, (b) => b.setFloat32(0, 936, true));
  const header = new TextEncoder().encode('reMarkable .lines file, version=6          ');
  const block = new Uint8Array(8);
  new DataView(block.buffer).setUint32(0, out.length, true);
  block.set([0, 1, 1, 7], 4);
  return new Uint8Array([...header, ...block, ...out]);
}

test('a damaged page claiming billions of deleted characters is a problem of that page, not a crash', () => {
  const p = readPage(pageClaimingDeleted(0xffffffff));
  assert.equal(p.text, null);
  assert.equal(p.problems.length, 1);
  assert.match(p.problems[0]!, /claims more than/);
  assert.equal(readPage(pageClaimingDeleted(3)).problems.length, 0, 'a real deleted run is fine');
});
