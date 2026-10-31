// The v6 `.rm` primitives: little-endian numbers, LEB128 varuints, CRDT ids and "tagged" values (a varuint
// `(index << 4) | type` before each field). Fields are positional but many are optional, so a reader asks whether a
// given tag is next. Every Reader is bounded by the block or subblock it reads: an optional peek never looks past that
// end, where the next block's length bytes can look exactly like a tag (rmscene PR #60 found strokes corrupted that way).

import { RmFormatError } from '../doc/json.ts';

export const TAG_BYTE1 = 0x1;
export const TAG_BYTE4 = 0x4;
export const TAG_BYTE8 = 0x8;
export const TAG_LENGTH4 = 0xc;
export const TAG_ID = 0xf;

/** A CRDT id: `a` the author's index on the page (u8), `c` that author's counter (up to 2^48). */
export interface CrdtId {
  readonly a: number;
  readonly c: number;
}

/** A Map key for a CRDT id: a number while it fits in a double exactly (nearly always), else a string. */
export type IdKey = number | string;
export const idKey = (a: number, c: number): IdKey => (c < 2 ** 44 ? c * 256 + a : `${a}:${c}`);
export const keyOf = (id: CrdtId): IdKey => idKey(id.a, id.c);

/** (0,0): "none", the start or end of a sequence. */
export const END_MARKER: CrdtId = Object.freeze({ a: 0, c: 0 });
export const END_KEY = keyOf(END_MARKER);
/** (0,1): the scene tree's root group. */
export const ROOT_ID: CrdtId = Object.freeze({ a: 0, c: 1 });
/** The special anchors of a group placed against the typed text: its top and its bottom. */
export const ANCHOR_TOP_KEY = idKey(0, 0xfffffffffffe);
export const ANCHOR_BOTTOM_KEY = idKey(0, 0xffffffffffff);

const utf8 = new TextDecoder('utf-8', { fatal: false });

export class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos: number;
  readonly end: number;

  constructor(bytes: Uint8Array, view: DataView, pos: number, end: number) {
    this.bytes = bytes;
    this.view = view;
    this.pos = pos;
    this.end = end;
  }

  static of(bytes: Uint8Array): Reader {
    return new Reader(bytes, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), 0, bytes.byteLength);
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): number {
    const at = this.pos;
    if (at + n > this.end) throw new RmFormatError(`Unexpected end of data at byte ${at} (wanted ${n}, ${this.end - at} left)`);
    this.pos = at + n;
    return at;
  }

  u8(): number { return this.view.getUint8(this.need(1)); }
  u16(): number { return this.view.getUint16(this.need(2), true); }
  u32(): number { return this.view.getUint32(this.need(4), true); }
  i32(): number { return this.view.getInt32(this.need(4), true); }
  f32(): number { return this.view.getFloat32(this.need(4), true); }
  f64(): number { return this.view.getFloat64(this.need(8), true); }
  bool(): boolean { return this.u8() !== 0; }

  /** Raw bytes, without copying. */
  take(n: number): Uint8Array {
    const at = this.need(n);
    return this.bytes.subarray(at, at + n);
  }

  /** LEB128. Values reach 2^48, past what 32-bit bitwise operators hold, so this multiplies. */
  varuint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const byte = this.u8();
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    throw new RmFormatError(`Varuint too long at byte ${this.pos}`);
  }

  crdtId(): CrdtId {
    const a = this.u8();
    const c = this.varuint();
    return { a, c };
  }

  /* ------------------------------------------------------------------------------------------- tagged values */

  /** The next tag's raw value without moving, or -1 at the end of this block. */
  peekTag(): number {
    if (this.pos >= this.end) return -1;
    const at = this.pos;
    try {
      return this.varuint();
    } catch {
      return -1;
    } finally {
      this.pos = at;
    }
  }

  /** Whether field `index` of type `type` comes next, inside this block. */
  has(index: number, type: number): boolean {
    return this.peekTag() === index * 16 + type;
  }

  private expect(index: number, type: number): void {
    const tag = this.peekTag();
    if (tag !== index * 16 + type) {
      const found = tag < 0 ? 'the end of the block' : `field ${Math.floor(tag / 16)} of type ${tag % 16}`;
      throw new RmFormatError(`Expected field ${index} of type ${type} at byte ${this.pos}, found ${found}`);
    }
    this.varuint();
  }

  id(index: number): CrdtId { this.expect(index, TAG_ID); return this.crdtId(); }
  byte(index: number): number { this.expect(index, TAG_BYTE1); return this.u8(); }
  flag(index: number): boolean { this.expect(index, TAG_BYTE1); return this.bool(); }
  int(index: number): number { this.expect(index, TAG_BYTE4); return this.u32(); }
  float(index: number): number { this.expect(index, TAG_BYTE4); return this.f32(); }
  double(index: number): number { this.expect(index, TAG_BYTE8); return this.f64(); }

  /** A length-prefixed subblock as its own bounded Reader; this reader moves past it. */
  sub(index: number): Reader {
    this.expect(index, TAG_LENGTH4);
    const length = this.u32();
    const start = this.need(length);
    return new Reader(this.bytes, this.view, start, start + length);
  }

  optional<T>(index: number, type: number, read: (index: number) => T): T | null {
    return this.has(index, type) ? read.call(this, index) : null;
  }

  /** A string subblock: varuint byte length, a flag (always 1 so far), UTF-8. */
  string(index: number): string {
    return stringIn(this.sub(index));
  }

  /** A string subblock that may carry a formatting code after the text (the typed text's bold and italic marks). */
  stringWithFormat(index: number): { text: string; format: number | null } {
    const sub = this.sub(index);
    const text = stringIn(sub);
    return { text, format: sub.has(2, TAG_BYTE4) ? sub.int(2) : null };
  }

  /* -------------------------------------------- last-writer-wins values: a timestamp id, then the value at 2 */

  lwwId(index: number): CrdtId { const s = this.sub(index); s.id(1); return s.id(2); }
  lwwFlag(index: number): boolean { const s = this.sub(index); s.id(1); return s.flag(2); }
  lwwByte(index: number): number { const s = this.sub(index); s.id(1); return s.byte(2); }
  lwwFloat(index: number): number { const s = this.sub(index); s.id(1); return s.float(2); }
  lwwString(index: number): string { const s = this.sub(index); s.id(1); return s.string(2); }
}

function stringIn(sub: Reader): string {
  const length = sub.varuint();
  sub.u8(); // is-ASCII flag: 1 in every file seen, and UTF-8 either way
  return utf8.decode(sub.take(length));
}
