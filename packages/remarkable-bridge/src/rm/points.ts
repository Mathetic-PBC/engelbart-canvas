// A stroke's points, decoded only when something draws them: text and highlights never need them, and they are most of
// a page's bytes. Decoded into typed arrays, all in the units the current format writes (v2): firmware 3.0 wrote six
// floats a point, later firmware 14 bytes with the speed, width, direction and pressure as small integers.

import { RmFormatError } from '../doc/json.ts';

/** Bytes a point takes in each stroke version. */
export const POINT_SIZE: Record<number, number> = { 1: 24, 2: 14 };

export interface DecodedPoints {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** As the tablet measured it; 0–~170 seen. */
  readonly speed: Float32Array;
  /** The width the tablet drew the point at, in quarters of a page unit. */
  readonly width: Float32Array;
  /** Tilt, 0–255 for a full turn. */
  readonly direction: Float32Array;
  /** 0–255. */
  readonly pressure: Float32Array;
}

export class Points {
  readonly count: number;
  readonly version: number;
  private readonly data: Uint8Array;
  private decoded: DecodedPoints | null = null;

  constructor(data: Uint8Array, version: number) {
    const size = POINT_SIZE[version];
    if (!size) throw new RmFormatError(`Unknown stroke point version ${version}`);
    if (data.byteLength % size !== 0) throw new RmFormatError(`Stroke point data of ${data.byteLength} bytes is not whole points of ${size}`);
    this.data = data;
    this.version = version;
    this.count = data.byteLength / size;
  }

  /** Every point, decoded once and kept. */
  decode(): DecodedPoints {
    if (this.decoded) return this.decoded;
    const n = this.count;
    const out = {
      count: n,
      x: new Float32Array(n), y: new Float32Array(n), speed: new Float32Array(n),
      width: new Float32Array(n), direction: new Float32Array(n), pressure: new Float32Array(n),
    };
    // Points sit at odd offsets, so a Float32Array cannot view them directly.
    const view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    if (this.version === 2) {
      for (let i = 0, o = 0; i < n; i++, o += 14) {
        out.x[i] = view.getFloat32(o, true);
        out.y[i] = view.getFloat32(o + 4, true);
        out.speed[i] = view.getUint16(o + 8, true);
        out.width[i] = view.getUint16(o + 10, true);
        out.direction[i] = view.getUint8(o + 12);
        out.pressure[i] = view.getUint8(o + 13);
      }
    } else {
      for (let i = 0, o = 0; i < n; i++, o += 24) {
        out.x[i] = view.getFloat32(o, true);
        out.y[i] = view.getFloat32(o + 4, true);
        out.speed[i] = view.getFloat32(o + 8, true) * 4;
        out.direction[i] = (view.getFloat32(o + 12, true) * 255) / (Math.PI * 2);
        out.width[i] = Math.round(view.getFloat32(o + 16, true) * 4);
        out.pressure[i] = view.getFloat32(o + 20, true) * 255;
      }
    }
    this.decoded = out;
    return out;
  }

  /** The bounding box of the points. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    const p = this.decode();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.count; i++) {
      const x = p.x[i]!, y = p.y[i]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }
}
