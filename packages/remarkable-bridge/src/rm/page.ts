// One page as something to draw and read: its layers, strokes and highlights in drawing order, and its typed text.
//
// A v6 page is a tree of groups. Groups directly under the root (0,1) are layers; a group can be anchored to the typed
// text, so the strokes in it move with the line they were written beside. Each group's children are a CRDT sequence of
// items: strokes, highlights, and further groups. Deleted items stay in the sequences (their neighbours may name
// them) but are never drawn. Legacy v3/v5 pages (firmware 1.x and 2.x) are flat lists of layers and strokes.

import { RmFormatError } from '../doc/json.ts';
import { colorOf, toolOf, type Rgba, type Tool } from './codes.ts';
import { crdtOrder } from './crdt.ts';
import { HEADER_LENGTH, isV6, readBlocks, type Anchor, type GlyphValue, type ItemValue, type LineValue, type SequenceItem } from './blocks.ts';
import { Points } from './points.ts';
import { ANCHOR_BOTTOM_KEY, ANCHOR_TOP_KEY, keyOf, ROOT_ID, type CrdtId, type IdKey } from './reader.ts';
import { layoutText } from './layout.ts';
import { readText, type TypedText } from './text.ts';

/** A reMarkable 1 or 2 page, in page units: the size every page had before the Paper Pro. */
export const RM2_PAGE = Object.freeze({ width: 1404, height: 1872 });

export interface Layer {
  label: string;
  visible: boolean;
}

export interface Stroke {
  tool: Tool;
  /** The raw pen code (codes.ts Pen). */
  toolCode: number;
  color: Rgba;
  /** The raw colour code (codes.ts PenColor). */
  colorCode: number;
  thicknessScale: number;
  points: Points;
  /** Index into Page.layers. */
  layer: number;
  /** Where the stroke's points are drawn from: added to every point (non-zero for strokes beside typed text). */
  dx: number;
  dy: number;
}

export interface Highlight {
  /** The highlighted text as the tablet recorded it. */
  text: string;
  color: Rgba;
  colorCode: number;
  /** Offset into the page's text, when recorded (firmware before 3.6, and Paper Pro pages). */
  start: number | null;
  length: number;
  /** One rectangle per line, in page units. */
  rects: { x: number; y: number; w: number; h: number }[];
  layer: number;
}

export interface Page {
  /** The format: 6 for firmware 3.x, 5 and 3 for 2.x and 1.x. */
  version: 3 | 5 | 6;
  /**
   * The page's size in page units, as the tablet wrote it: 1404×1872 on a reMarkable 1 or 2, 1620×2160 on a Paper Pro.
   * Pages from before firmware 3.14 do not say, and are RM2_PAGE. x = 0 is the page's horizontal centre and y = 0
   * its top; ink may lie outside (a page scrolls down and pans sideways).
   */
  width: number;
  height: number;
  layers: Layer[];
  /** In drawing order. */
  strokes: Stroke[];
  highlights: Highlight[];
  text: TypedText | null;
  /** Blocks that could not be read, each in words; the rest of the page is still here. */
  problems: string[];
}

/** Reads a page of any version. Throws RmFormatError only when it is not a page at all. */
export function readPage(bytes: Uint8Array): Page {
  if (isV6(bytes)) return readV6(bytes);
  const header = new TextDecoder('latin1').decode(bytes.subarray(0, HEADER_LENGTH));
  const legacy = /^reMarkable \.lines file, version=([35]) {10}$/.exec(header);
  if (legacy) return readLegacy(bytes, Number(legacy[1]) as 3 | 5);
  throw new RmFormatError('Not a reMarkable page (.rm)');
}

/* ------------------------------------------------------------------------------------------------------------ v6 */

interface Group {
  id: CrdtId;
  label: string;
  visible: boolean;
  anchor: Anchor | null;
  children: SequenceItem<ItemValue>[];
}

function readV6(bytes: Uint8Array): Page {
  const groups = new Map<IdKey, Group>();
  const groupOf = (id: CrdtId): Group => {
    const key = keyOf(id);
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { id, label: '', visible: true, anchor: null, children: [] }));
    return group;
  };
  const root = groupOf(ROOT_ID);
  let size: [number, number] | null = null;
  let text: TypedText | null = null;
  const problems: string[] = [];

  for (const block of readBlocks(bytes)) {
    switch (block.kind) {
      case 'sceneTree': groupOf(block.treeId); break;
      case 'treeNode': {
        const group = groupOf(block.nodeId);
        group.label = block.label;
        group.visible = block.visible;
        group.anchor = block.anchor;
        break;
      }
      case 'item': groupOf(block.parentId).children.push(block.item); break;
      case 'sceneInfo': if (block.paperSize) size = block.paperSize; break;
      case 'rootText':
        try { text = readText(block.text); } catch (error) { problems.push(`Typed text: ${(error as Error).message}`); }
        break;
      case 'unknown': if (block.error) problems.push(`Block of type ${block.header.type}: ${block.error}`); break;
    }
  }

  const page: Page = { version: 6, width: size?.[0] ?? RM2_PAGE.width, height: size?.[1] ?? RM2_PAGE.height, layers: [], strokes: [], highlights: [], text, problems };
  const lineTop = textLines(text);
  const seen = new Set<IdKey>([keyOf(ROOT_ID)]);
  // Items straight under the root, outside any layer (not written by the tablet, but legal), share one unnamed layer.
  let rootLayer = -1;
  const layerOf = (layer: number) => {
    if (layer >= 0) return layer;
    if (rootLayer < 0) rootLayer = page.layers.push({ label: '', visible: true }) - 1;
    return rootLayer;
  };

  const walk = (group: Group, layer: number, dx: number, dy: number, visible: boolean) => {
    for (const item of crdtOrder(group.children)) {
      const value = item.value;
      if (!value) continue; // deleted
      if (value.type === 'group') {
        const key = keyOf(value.nodeId);
        const child = groups.get(key);
        if (!child || seen.has(key)) continue; // a group placed twice, or a loop, is drawn once
        seen.add(key);
        let childLayer = layer;
        if (group === root) {
          childLayer = page.layers.length;
          page.layers.push({ label: child.label, visible: child.visible });
        }
        const anchor = child.anchor;
        const anchored = anchor ? { dx: anchor.originX, dy: lineTop(keyOf(anchor.id)) + (anchor.threshold ?? 0) / 2 } : { dx: 0, dy: 0 };
        walk(child, childLayer, dx + anchored.dx, dy + anchored.dy, visible && child.visible);
      } else if (value.type === 'line') {
        if (visible) page.strokes.push(strokeOf(value, layerOf(layer), dx, dy));
      } else if (value.type === 'glyph') {
        if (visible) page.highlights.push(highlightOf(value, layerOf(layer), dx, dy));
      }
    }
  };
  walk(root, -1, 0, 0, true);
  // Strokes under a group no group item placed: not reachable from the root, but ink the person made. Kept, in a layer
  // of their own, rather than lost.
  const stray = [...groups.entries()].filter(([key, group]) => !seen.has(key) && group.children.some((child) => child.value && child.value.type !== 'group'));
  for (const [key, group] of stray) {
    seen.add(key);
    page.layers.push({ label: group.label, visible: group.visible });
    walk(group, page.layers.length - 1, 0, 0, group.visible);
  }
  return page;
}

function strokeOf(line: LineValue, layer: number, dx: number, dy: number): Stroke {
  return { tool: toolOf(line.tool), toolCode: line.tool, color: colorOf(line.color, line.argb), colorCode: line.color, thicknessScale: line.thicknessScale, points: line.points, layer, dx, dy };
}

function highlightOf(glyph: GlyphValue, layer: number, dx: number, dy: number): Highlight {
  const rects = [];
  for (let i = 0; i + 3 < glyph.rects.length; i += 4) rects.push({ x: glyph.rects[i]! + dx, y: glyph.rects[i + 1]! + dy, w: glyph.rects[i + 2]!, h: glyph.rects[i + 3]! });
  return { text: glyph.text, color: colorOf(glyph.color, glyph.argb), colorCode: glyph.color, start: glyph.start, length: glyph.length, rects, layer };
}

/**
 * Where a group anchored to the typed text sits. Its strokes are kept relative to a point: x = the anchor's originX, y
 * = the top of the line holding the character it names, plus half the anchor's threshold (the line's height, it
 * seems). Measured on rmscene's Lines_v2 / Lines_v2_updated, the same strokes before and after the tablet anchored them:
 * the shift is exactly (originX, 234 + 33.59), and half the threshold is 33.51.
 *
 * The tops of paragraphs below the first come from ./layout.ts, an estimate: the tablet's fonts and wrapping are not
 * in the file. Strokes written beside typed text can land a line or so off; strokes elsewhere never move.
 */
const DEFAULT_TEXT_Y = 234; // where a new page's text column starts

function textLines(text: TypedText | null): (key: IdKey) => number {
  const top = text?.y ?? DEFAULT_TEXT_Y;
  if (!text) return () => top;
  const { paragraphTops, bottom } = layoutText(text);
  return (key) => {
    if (key === ANCHOR_TOP_KEY) return top;
    if (key === ANCHOR_BOTTOM_KEY) return bottom;
    const index = text.paragraphOf.get(key);
    return index === undefined ? top : paragraphTops[index] ?? top;
  };
}

/* ------------------------------------------------------------------------------------------------------ v3 / v5 */

/**
 * Firmware 1.x and 2.x pages: layers of strokes, each stroke a pen, a colour and points of six floats. Their x runs
 * from 0 at the left edge, so strokes are shifted to the v6 convention (x = 0 at the centre).
 */
function readLegacy(bytes: Uint8Array, version: 3 | 5): Page {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = HEADER_LENGTH;
  const i32 = () => { if (pos + 4 > bytes.byteLength) throw new RmFormatError('Truncated page'); const v = view.getInt32(pos, true); pos += 4; return v; };
  const f32 = () => { if (pos + 4 > bytes.byteLength) throw new RmFormatError('Truncated page'); const v = view.getFloat32(pos, true); pos += 4; return v; };
  const page: Page = { version, width: RM2_PAGE.width, height: RM2_PAGE.height, layers: [], strokes: [], highlights: [], text: null, problems: [] };
  const layerCount = i32();
  for (let l = 0; l < layerCount; l++) {
    page.layers.push({ label: `Layer ${l + 1}`, visible: true });
    const lineCount = i32();
    for (let s = 0; s < lineCount; s++) {
      const tool = i32();
      const color = i32();
      i32(); // unknown (selection?)
      const thicknessScale = f32();
      if (version === 5) i32(); // unknown
      const count = i32();
      if (count < 0 || pos + count * 24 > bytes.byteLength) throw new RmFormatError('Truncated stroke');
      const points = new Points(bytes.subarray(pos, pos + count * 24), 1);
      pos += count * 24;
      page.strokes.push({ tool: toolOf(tool), toolCode: tool, color: colorOf(color, null), colorCode: color, thicknessScale, points, layer: l, dx: -RM2_PAGE.width / 2, dy: 0 });
    }
  }
  return page;
}
