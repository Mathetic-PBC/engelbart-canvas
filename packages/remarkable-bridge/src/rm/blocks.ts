// The v6 file as a list of blocks. Each block is `u32 length, u8 0, u8 min_version, u8 current_version, u8 type`, then
// its payload. A block this package cannot read (an unknown type, or one that does not parse) becomes an `unknown`
// block and the rest of the page is still read: newer firmware adds blocks and fields, and one odd stroke must never
// cost the whole page. Fields a block has beyond what is read here are skipped by its length.
//
// Block layouts follow rmscene (MIT, Copyright (c) 2023 Rick Lupton; see THIRD_PARTY_NOTICES.md), with the fields
// later firmware added (3.2x–3.28) read only when their own tag is next.

import { RmFormatError } from '../doc/json.ts';
import { Points } from './points.ts';
import { keyOf, Reader, TAG_BYTE1, TAG_BYTE4, TAG_ID, TAG_LENGTH4, type CrdtId, type IdKey } from './reader.ts';

export const HEADER_V6 = 'reMarkable .lines file, version=6          ';
export const HEADER_LENGTH = 43;

export const BlockType = Object.freeze({
  MIGRATION_INFO: 0x00,
  SCENE_TREE: 0x01,
  TREE_NODE: 0x02,
  GLYPH_ITEM: 0x03,
  GROUP_ITEM: 0x04,
  LINE_ITEM: 0x05,
  TEXT_ITEM: 0x06,
  ROOT_TEXT: 0x07,
  TOMBSTONE_ITEM: 0x08,
  AUTHOR_IDS: 0x09,
  PAGE_INFO: 0x0a,
  SCENE_INFO: 0x0d,
  IMAGE_INFO: 0x0e,
  IMAGE_ITEM: 0x0f,
});

export interface BlockHeader {
  type: number;
  minVersion: number;
  currentVersion: number;
  /** Where the payload starts in the file, and its length. */
  offset: number;
  length: number;
}

/* ------------------------------------------------------------------------------------------------- item values */

export interface LineValue {
  type: 'line';
  /** Pen code (codes.ts Pen). */
  tool: number;
  /** Colour code (codes.ts PenColor). */
  color: number;
  /** 0xAARRGGBB, written for highlighter and shader strokes since firmware 3.14; null otherwise. */
  argb: number | null;
  thicknessScale: number;
  startingLength: number;
  points: Points;
}

export interface GlyphValue {
  type: 'glyph';
  /** Offset of the highlighted text in the page's text, when the tablet recorded it (optional since 3.6). */
  start: number | null;
  length: number;
  color: number;
  argb: number | null;
  /** The highlighted text itself. */
  text: string;
  /** One rectangle per line highlighted, x, y, w, h after one another, in the page's coordinates. */
  rects: Float64Array;
}

export interface GroupValue {
  type: 'group';
  /** The group (tree node) this item places in its parent's sequence. */
  nodeId: CrdtId;
}

/** Item kinds this package does not draw yet: a text item (no layout known) and a 3.28 image. */
export interface OpaqueValue {
  type: 'text' | 'image';
}

export type ItemValue = LineValue | GlyphValue | GroupValue | OpaqueValue;

/** An element of a CRDT sequence. Deleted items keep their place (others' left and right may point at them). */
export interface SequenceItem<V> {
  id: CrdtId;
  key: IdKey;
  left: IdKey;
  right: IdKey;
  /** Deleted elements: 1 for a deleted item, n for a run of n deleted characters. */
  deletedLength: number;
  /** null for a deleted item (and every tombstone). */
  value: V | null;
}

/* ------------------------------------------------------------------------------------------------------- blocks */

export interface Anchor {
  /** The character of the typed text the group follows, or ANCHOR_TOP_KEY / ANCHOR_BOTTOM_KEY. */
  id: CrdtId;
  type: number | null;
  threshold: number | null;
  /** x of the group's origin, page units. */
  originX: number;
}

export interface TextFormat {
  /** The paragraph's style code (codes.ts ParagraphStyle). */
  style: number;
  /** The fields firmware 3.2x writes after some styles: heading level and list nesting. */
  field2: number | null;
  field3: number | null;
}

export interface RootText {
  items: SequenceItem<string | number>[];
  /** Paragraph styles by the key of the newline character starting the paragraph (END_KEY for the first). */
  formats: Map<IdKey, TextFormat>;
  /** Top-left of the text column, page units. */
  x: number;
  y: number;
  width: number;
}

export type Block =
  | { kind: 'authors'; header: BlockHeader; authors: Map<number, string> }
  | { kind: 'migration'; header: BlockHeader }
  | { kind: 'pageInfo'; header: BlockHeader; loads: number; merges: number; textChars: number; textLines: number }
  | { kind: 'sceneInfo'; header: BlockHeader; currentLayer: CrdtId | null; paperSize: [number, number] | null; backgroundVisible: boolean | null }
  | { kind: 'sceneTree'; header: BlockHeader; treeId: CrdtId; parentId: CrdtId }
  | { kind: 'treeNode'; header: BlockHeader; nodeId: CrdtId; label: string; visible: boolean; anchor: Anchor | null }
  | { kind: 'item'; header: BlockHeader; parentId: CrdtId; item: SequenceItem<ItemValue> }
  | { kind: 'rootText'; header: BlockHeader; text: RootText }
  | { kind: 'unknown'; header: BlockHeader; error: string | null };

const decoder = new TextDecoder('latin1');

/** Whether `bytes` is a v6 page. */
export const isV6 = (bytes: Uint8Array): boolean => bytes.byteLength >= HEADER_LENGTH && decoder.decode(bytes.subarray(0, HEADER_LENGTH)) === HEADER_V6;

/** Every block of a v6 page, in file order. Throws RmFormatError only when the file is not v6 or its framing is broken. */
export function readBlocks(bytes: Uint8Array): Block[] {
  if (!isV6(bytes)) throw new RmFormatError('Not a v6 .rm page');
  const file = Reader.of(bytes);
  file.pos = HEADER_LENGTH;
  const blocks: Block[] = [];
  while (file.remaining > 0) {
    if (file.remaining < 8) throw new RmFormatError(`Truncated block header at byte ${file.pos}`);
    const length = file.u32();
    file.u8(); // always 0
    const minVersion = file.u8();
    const currentVersion = file.u8();
    const type = file.u8();
    const offset = file.pos;
    if (length > file.remaining) throw new RmFormatError(`Block at byte ${offset - 8} runs past the end of the file`);
    file.pos += length;
    const header: BlockHeader = { type, minVersion, currentVersion, offset, length };
    const payload = new Reader(bytes, file.view, offset, offset + length);
    try {
      blocks.push(readBlock(payload, header));
    } catch (error) {
      blocks.push({ kind: 'unknown', header, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return blocks;
}

function readBlock(r: Reader, header: BlockHeader): Block {
  switch (header.type) {
    case BlockType.AUTHOR_IDS: return authorIds(r, header);
    case BlockType.MIGRATION_INFO: return { kind: 'migration', header };
    case BlockType.PAGE_INFO: return pageInfo(r, header);
    case BlockType.SCENE_INFO: return sceneInfo(r, header);
    case BlockType.SCENE_TREE: return sceneTree(r, header);
    case BlockType.TREE_NODE: return treeNode(r, header);
    case BlockType.ROOT_TEXT: return { kind: 'rootText', header, text: rootText(r) };
    case BlockType.GLYPH_ITEM:
    case BlockType.GROUP_ITEM:
    case BlockType.LINE_ITEM:
    case BlockType.TEXT_ITEM:
    case BlockType.TOMBSTONE_ITEM:
    case BlockType.IMAGE_ITEM:
      return item(r, header);
    default:
      return { kind: 'unknown', header, error: null };
  }
}

function authorIds(r: Reader, header: BlockHeader): Block {
  const authors = new Map<number, string>();
  const n = r.varuint();
  for (let i = 0; i < n; i++) {
    const s = r.sub(0);
    const length = s.varuint();
    if (length !== 16) throw new RmFormatError(`Author id of ${length} bytes`);
    const uuid = uuidFromBytesLe(s.take(16));
    authors.set(s.u16(), uuid);
  }
  return { kind: 'authors', header, authors };
}

function pageInfo(r: Reader, header: BlockHeader): Block {
  return { kind: 'pageInfo', header, loads: r.int(1), merges: r.int(2), textChars: r.int(3), textLines: r.int(4) };
}

/**
 * SceneInfo: the current layer, then optional fields. The paper size is field 5 (two u32); firmware 3.27 may leave
 * it out and write it only as doubles (field 7) or a last-writer-wins pair (field 8).
 */
function sceneInfo(r: Reader, header: BlockHeader): Block {
  const currentLayer = r.has(1, TAG_LENGTH4) ? r.lwwId(1) : null;
  const backgroundVisible = r.has(2, TAG_LENGTH4) ? r.lwwFlag(2) : null;
  if (r.has(3, TAG_LENGTH4)) r.sub(3);
  let paperSize: [number, number] | null = null;
  if (r.has(5, TAG_LENGTH4)) {
    const s = r.sub(5);
    paperSize = [s.u32(), s.u32()];
  }
  if (r.has(6, TAG_LENGTH4)) r.sub(6);
  if (r.has(7, TAG_LENGTH4)) {
    const s = r.sub(7);
    if (!paperSize && s.remaining >= 16) paperSize = [s.f64(), s.f64()];
  }
  if (r.has(8, TAG_LENGTH4)) {
    const s = r.sub(8);
    if (!paperSize && s.has(1, TAG_ID)) {
      s.id(1);
      const pair = s.has(2, TAG_LENGTH4) ? s.sub(2) : null;
      if (pair && pair.remaining >= 16) paperSize = [pair.f64(), pair.f64()];
    }
  }
  if (paperSize && !(paperSize[0] > 0 && paperSize[1] > 0)) paperSize = null;
  return { kind: 'sceneInfo', header, currentLayer, paperSize, backgroundVisible };
}

function sceneTree(r: Reader, header: BlockHeader): Block {
  const treeId = r.id(1);
  r.id(2); // node_id: (0,0) in every file seen; meaning unknown
  r.flag(3); // is_update
  const parentId = r.sub(4).id(1);
  return { kind: 'sceneTree', header, treeId, parentId };
}

function treeNode(r: Reader, header: BlockHeader): Block {
  const nodeId = r.id(1);
  const label = r.has(2, TAG_LENGTH4) ? r.lwwString(2) : '';
  const visible = r.has(3, TAG_LENGTH4) ? r.lwwFlag(3) : true;
  let anchor: Anchor | null = null;
  if (r.has(7, TAG_LENGTH4)) {
    const id = r.lwwId(7);
    const type = r.has(8, TAG_LENGTH4) ? r.lwwByte(8) : null;
    const threshold = r.has(9, TAG_LENGTH4) ? r.lwwFloat(9) : null;
    const originX = r.has(10, TAG_LENGTH4) ? r.lwwFloat(10) : 0;
    anchor = { id, type, threshold, originX };
  }
  return { kind: 'treeNode', header, nodeId, label, visible, anchor };
}

const ITEM_TYPE: Record<number, number> = {
  [BlockType.GLYPH_ITEM]: 1,
  [BlockType.GROUP_ITEM]: 2,
  [BlockType.LINE_ITEM]: 3,
  [BlockType.TEXT_ITEM]: 5,
  [BlockType.IMAGE_ITEM]: 7,
};

/** The envelope every scene item shares: where it goes, its place in the sequence, then its value (absent once deleted). */
function item(r: Reader, header: BlockHeader): Block {
  const parentId = r.id(1);
  const id = r.id(2);
  const left = r.id(3);
  const right = r.id(4);
  const deletedLength = r.int(5);
  let value: ItemValue | null = null;
  if (header.type !== BlockType.TOMBSTONE_ITEM && r.has(6, TAG_LENGTH4)) {
    const v = r.sub(6);
    const itemType = v.u8();
    if (itemType !== ITEM_TYPE[header.type]) throw new RmFormatError(`Item of type ${itemType} in a block of type ${header.type}`);
    value = itemValue(v, header);
  }
  return { kind: 'item', header, parentId, item: { id, key: keyOf(id), left: keyOf(left), right: keyOf(right), deletedLength, value } };
}

function itemValue(v: Reader, header: BlockHeader): ItemValue {
  switch (header.type) {
    case BlockType.LINE_ITEM: return line(v, header.currentVersion);
    case BlockType.GLYPH_ITEM: return glyph(v);
    case BlockType.GROUP_ITEM: return { type: 'group', nodeId: v.id(2) };
    case BlockType.IMAGE_ITEM: return { type: 'image' };
    default: return { type: 'text' };
  }
}

function line(v: Reader, version: number): LineValue {
  const tool = v.int(1);
  const color = v.int(2);
  const thicknessScale = v.double(3);
  const startingLength = v.float(4);
  const pointData = v.sub(5);
  // Firmware 3.0 wrote float points (block version 1); everything since writes compact ones (2).
  const points = new Points(pointData.take(pointData.remaining), version >= 2 ? 2 : 1);
  if (v.has(6, TAG_ID)) v.id(6); // timestamp, unused
  if (v.has(7, TAG_ID)) v.id(7); // move id: probably the stroke this one was moved from
  const argb = v.has(8, TAG_BYTE4) ? v.int(8) : null;
  return { type: 'line', tool, color, argb, thicknessScale, startingLength, points };
}

function glyph(v: Reader): GlyphValue {
  const start = v.has(2, TAG_BYTE4) ? v.int(2) : null;
  const lengthField = v.has(3, TAG_BYTE4) ? v.int(3) : null;
  const color = v.int(4);
  const text = v.string(5);
  const s = v.sub(6);
  const n = s.varuint();
  if (n * 32 > s.remaining) throw new RmFormatError(`A highlight claims ${n} rectangles in ${s.remaining} bytes`);
  const rects = new Float64Array(n * 4);
  for (let i = 0; i < n * 4; i++) rects[i] = s.f64();
  const argb = v.has(10, TAG_BYTE4) ? v.int(10) : null;
  return { type: 'glyph', start, length: lengthField ?? [...text].length, color, argb, text, rects };
}

/**
 * The page's typed text: its characters as a CRDT sequence (runs of characters under one id, ids implicit after the
 * first), the paragraph styles by the newline starting each paragraph, and where the text column is.
 */
function rootText(r: Reader): RootText {
  r.id(1);
  const body = r.sub(2);
  const itemsBlock = body.sub(1).sub(1);
  const items: SequenceItem<string | number>[] = [];
  for (let i = 0, n = itemsBlock.varuint(); i < n; i++) items.push(textItem(itemsBlock.sub(0)));
  const formatsBlock = body.sub(2).sub(1);
  const formats = new Map<IdKey, TextFormat>();
  for (let i = 0, n = formatsBlock.varuint(); i < n; i++) {
    const charId = formatsBlock.crdtId(); // the one id in the file without a tag before it
    formatsBlock.id(1);
    const f = formatsBlock.sub(2);
    const style = f.byte(1);
    const field2 = f.has(2, TAG_BYTE1) ? f.byte(2) : null;
    const field3 = f.has(3, TAG_BYTE4) ? f.int(3) : null;
    formats.set(keyOf(charId), { style, field2, field3 });
  }
  const pos = r.sub(3);
  const x = pos.f64();
  const y = pos.f64();
  const width = r.float(4);
  return { items, formats, x, y, width };
}

function textItem(s: Reader): SequenceItem<string | number> {
  const id = s.id(2);
  const left = s.id(3);
  const right = s.id(4);
  const deletedLength = s.int(5);
  let value: string | number = '';
  if (s.has(6, TAG_LENGTH4)) {
    const { text, format } = s.stringWithFormat(6);
    // A formatting mark (bold or italic on or off) is stored as an empty string with a code.
    value = format !== null && text === '' ? format : text;
  }
  return { id, key: keyOf(id), left: keyOf(left), right: keyOf(right), deletedLength, value };
}

/** A UUID stored with its first three fields little-endian (.NET's byte order), as text. */
function uuidFromBytesLe(b: Uint8Array): string {
  const hex = (i: number) => b[i]!.toString(16).padStart(2, '0');
  const order = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15];
  return order.map((i) => (i < 0 ? '-' : hex(i))).join('');
}
