// A small zip reader and writer, enough for `.rmdoc` (a plain zip of a document's xochitl files). Only the subset real
// exports use is supported: stored and deflated entries, no ZIP64, no encryption, no spanning. Everything else is
// refused with RmFormatError rather than guessed at.
//
// An archive is someone else's file, so the reader trusts none of it: every length and offset is bounds-checked, every
// name is checked before it can be used as a path, entries may not overlap (the overlapping-entry zip bomb), a deflated
// entry may not claim more than deflate can physically produce, and every file is checked against its CRC-32.

import zlib from 'node:zlib';
import { RmFormatError } from './doc/json.ts';

/** One file of an archive, as its central directory describes it. */
export interface ZipEntry {
  name: string;
  /** 0: stored, 8: deflated. */
  method: number;
  compressedSize: number;
  /** Uncompressed size. */
  size: number;
  crc32: number;
}

/** A zip archive whose directory has been read and checked; files are inflated only when asked for. */
export interface ZipArchive {
  /** File names in directory order. Directory entries (names ending in `/`) are left out. */
  readonly names: readonly string[];
  /** The directory's record of one file, or undefined. */
  entry(name: string): ZipEntry | undefined;
  has(name: string): boolean;
  /**
   * One file's bytes, checked against its CRC; null when the archive has no such file. A stored file is a view into
   * the archive's bytes, not a copy: do not modify it. Throws RmFormatError when the file is corrupt.
   */
  read(name: string): Uint8Array | null;
}

export interface ZipReadOptions {
  /** The most entries the directory may list. Default 65 535 (all a zip without ZIP64 can hold). */
  maxEntries?: number;
  /** The largest uncompressed size one file may declare, in bytes. Default 4 GiB − 1 (all a zip without ZIP64 can say). */
  maxEntrySize?: number;
}

/** One file to put in an archive. */
export interface ZipInput {
  /** The path inside the archive, `/`-separated and relative (`<id>/<pageId>.rm`). */
  name: string;
  bytes: Uint8Array | string;
}

export interface ZipWriteOptions {
  /**
   * Deflate every file (default true). Keep it on for `.rmdoc` going to a tablet: a large stored `.rmdoc` is reported
   * to import and then crash the tablet with "Low memory" when opened, where the same files deflated open fine.
   */
  deflate?: boolean;
  /** zlib level, 1 (fastest) to 9 (smallest). Default 6. */
  level?: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const END_SIZE = 22;
const MAX_COMMENT = 0xffff;
const STORED = 0;
const DEFLATED = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const METHOD_AES = 99;
/** Deflate cannot expand anything by more than about 1032:1; a larger claim is a lie about one of the two sizes. */
const MAX_DEFLATE_RATIO = 1032;

const utf8 = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();

/** Located entry: the directory's record plus where its payload sits in the archive. */
interface Located extends ZipEntry {
  localOffset: number;
  dataStart: number;
  dataEnd: number;
}

const corrupt = (why: string) => new RmFormatError(`The archive is damaged or not a zip file: ${why}.`);

/**
 * Reads an archive's central directory and checks it whole (names, bounds, overlaps, sizes) before anything is
 * inflated. Throws RmFormatError for a corrupt archive, ZIP64, encryption, spanning, an unsupported compression
 * method, or a name that is absolute or climbs out with `..`.
 */
export function readZip(bytes: Uint8Array, options: ZipReadOptions = {}): ZipArchive {
  const maxEntries = options.maxEntries ?? 0xffff;
  const maxEntrySize = options.maxEntrySize ?? 0xffffffff;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(view);

  if (end >= 20 && view.getUint32(end - 20, true) === SIG_ZIP64_LOCATOR) throw zip64();
  const diskNumber = view.getUint16(end + 4, true);
  const directoryDisk = view.getUint16(end + 6, true);
  const entriesOnDisk = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw zip64();
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== count) {
    throw new RmFormatError('The archive is split across several files (a spanned zip), which is not supported.');
  }
  if (count > maxEntries) throw new RmFormatError(`The archive lists ${count} files, more than the ${maxEntries} allowed.`);
  if (directoryOffset + directorySize > end) throw corrupt('its directory runs past its end record');

  const located: Located[] = [];
  const byName = new Map<string, Located>();
  let pos = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (pos + CENTRAL_SIZE > directoryOffset + directorySize) throw corrupt('its directory is shorter than its end record says');
    if (view.getUint32(pos, true) !== SIG_CENTRAL) throw corrupt('a directory record has a bad signature');
    const flags = view.getUint16(pos + 8, true);
    const method = view.getUint16(pos + 10, true);
    const crc32 = view.getUint32(pos + 16, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const size = view.getUint32(pos + 24, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const startDisk = view.getUint16(pos + 34, true);
    const localOffset = view.getUint32(pos + 42, true);
    const nameStart = pos + CENTRAL_SIZE;
    const recordEnd = nameStart + nameLength + extraLength + commentLength;
    if (recordEnd > directoryOffset + directorySize) throw corrupt('a directory record runs past the directory');
    const nameBytes = bytes.subarray(nameStart, nameStart + nameLength);
    pos = recordEnd;

    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff || startDisk === 0xffff) throw zip64();
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION) || method === METHOD_AES) {
      throw new RmFormatError('The archive is encrypted, which is not supported. Export the document again without a password.');
    }
    if (method !== STORED && method !== DEFLATED) throw new RmFormatError(`The archive uses compression method ${method}; only stored and deflated files are supported.`);

    const name = decodeName(nameBytes);
    const isDirectory = name.endsWith('/');
    checkName(isDirectory ? name.slice(0, -1) : name);
    if (byName.has(name)) throw new RmFormatError(`The archive lists ${JSON.stringify(name)} twice.`);

    if (method === STORED && compressedSize !== size) throw corrupt(`${name} is stored but its two sizes differ`);
    if (method === DEFLATED && size > (compressedSize + 1) * MAX_DEFLATE_RATIO) throw corrupt(`${name} claims more than deflate can produce`);
    if (size > maxEntrySize) throw new RmFormatError(`${name} in the archive is ${size} bytes, more than the ${maxEntrySize} allowed.`);

    // The local header restates the name; its extra field may differ from the directory's, so the payload's start can
    // only be found by reading it.
    if (localOffset + LOCAL_SIZE > directoryOffset) throw corrupt(`${name}'s header lies outside the archive`);
    if (view.getUint32(localOffset, true) !== SIG_LOCAL) throw corrupt(`${name}'s header has a bad signature`);
    if (view.getUint16(localOffset + 6, true) & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new RmFormatError('The archive is encrypted, which is not supported. Export the document again without a password.');
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localName = bytes.subarray(localOffset + LOCAL_SIZE, localOffset + LOCAL_SIZE + localNameLength);
    if (!sameBytes(localName, nameBytes)) throw corrupt(`${name}'s header names a different file`);
    const dataStart = localOffset + LOCAL_SIZE + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > directoryOffset) throw corrupt(`${name} runs past the end of the data`);

    const entry: Located = { name, method, compressedSize, size, crc32, localOffset, dataStart, dataEnd };
    byName.set(name, entry);
    located.push(entry);
  }

  // Entries that share bytes let a few kilobytes inflate to gigabytes without any one record looking unusual.
  const ordered = [...located].sort((a, b) => a.localOffset - b.localOffset);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.localOffset < previous.dataEnd) throw corrupt(`${previous.name} and ${current.name} overlap`);
  }

  const files = located.filter((entry) => !entry.name.endsWith('/'));
  const fileMap = new Map(files.map((entry) => [entry.name, entry]));
  const publicEntry = ({ name, method, compressedSize, size, crc32 }: Located): ZipEntry => ({ name, method, compressedSize, size, crc32 });

  return {
    names: files.map((entry) => entry.name),
    entry: (name) => {
      const found = fileMap.get(name);
      return found ? publicEntry(found) : undefined;
    },
    has: (name) => fileMap.has(name),
    read: (name) => {
      const found = fileMap.get(name);
      return found ? extract(bytes, found) : null;
    },
  };
}

function extract(bytes: Uint8Array, entry: Located): Uint8Array {
  const payload = bytes.subarray(entry.dataStart, entry.dataEnd);
  let out: Uint8Array;
  if (entry.method === STORED) {
    out = payload;
  } else {
    try {
      // Never inflate past the declared size: a lying entry fails here instead of filling memory.
      out = zlib.inflateRawSync(payload, { maxOutputLength: Math.max(1, entry.size) });
    } catch {
      throw corrupt(`${entry.name} does not inflate`);
    }
    if (out.length !== entry.size) throw corrupt(`${entry.name} inflates to ${out.length} bytes, not the ${entry.size} declared`);
  }
  if (zlib.crc32(out) >>> 0 !== entry.crc32) throw corrupt(`${entry.name} fails its checksum`);
  return out;
}

function findEnd(view: DataView): number {
  const last = view.byteLength - END_SIZE;
  if (last < 0) throw corrupt('it is too short');
  const first = Math.max(0, last - MAX_COMMENT);
  for (let pos = last; pos >= first; pos--) {
    // The comment length must account exactly for the rest of the file, or this is just those four bytes in a comment.
    if (view.getUint32(pos, true) === SIG_END && pos + END_SIZE + view.getUint16(pos + 20, true) === view.byteLength) return pos;
  }
  throw corrupt('it has no end record');
}

const zip64 = () => new RmFormatError('The archive is a ZIP64 archive (over 4 GB or 65 535 files), which is not supported.');

function decodeName(nameBytes: Uint8Array): string {
  // Names are UTF-8 whether or not the writer set the UTF-8 flag (macOS zip does not); anything else is refused
  // rather than misread as CP437.
  try {
    return utf8.decode(nameBytes);
  } catch {
    throw corrupt('a file name is not valid UTF-8');
  }
}

/**
 * Throws RmFormatError unless `name` is a safe relative path: not empty, not absolute (`/x`, `C:x`), no `\`, no
 * control characters, and no empty, `.` or `..` segment. A name that passes cannot leave the folder it is unpacked
 * into.
 */
export function checkName(name: string): void {
  const unsafe = (why: string) => new RmFormatError(`Refusing the archive: the file name ${JSON.stringify(name)} ${why}.`);
  if (name === '') throw unsafe('is empty');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw unsafe('is an absolute path');
  if (name.includes('\\')) throw unsafe('contains a backslash');
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) throw unsafe('contains a control character');
  for (const segment of name.split('/')) {
    if (segment === '..') throw unsafe('climbs out of its folder with ".."');
    if (segment === '' || segment === '.') throw unsafe('has an empty or "." segment');
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * A zip of `files`, in the order given. Output is deterministic: every entry carries the same timestamp
 * (1980-01-01), so the same files always produce the same bytes. Throws RmFormatError for an unsafe or duplicate name,
 * or when the archive would need ZIP64.
 */
export function writeZip(files: Iterable<ZipInput>, options: ZipWriteOptions = {}): Uint8Array {
  const deflate = options.deflate ?? true;
  const level = options.level ?? 6;
  const seen = new Set<string>();
  const prepared: { name: Uint8Array; data: Uint8Array; method: number; size: number; crc: number; utf8: boolean }[] = [];
  for (const file of files) {
    checkName(file.name);
    if (seen.has(file.name)) throw new RmFormatError(`Cannot write ${JSON.stringify(file.name)} into an archive twice.`);
    seen.add(file.name);
    const raw = typeof file.bytes === 'string' ? encoder.encode(file.bytes) : file.bytes;
    const name = encoder.encode(file.name);
    if (name.length > 0xffff) throw new RmFormatError(`The file name ${JSON.stringify(file.name)} is too long for a zip.`);
    const data = deflate ? zlib.deflateRawSync(raw, { level }) : raw;
    // Non-ASCII names get the UTF-8 flag so other unzippers do not read them as CP437.
    prepared.push({ name, data, method: deflate ? DEFLATED : STORED, size: raw.length, crc: zlib.crc32(raw) >>> 0, utf8: name.length !== file.name.length });
  }
  if (prepared.length >= 0xffff) throw tooBig();

  let total = END_SIZE;
  for (const file of prepared) total += LOCAL_SIZE + CENTRAL_SIZE + 2 * file.name.length + file.data.length;
  if (total > 0xffffffff) throw tooBig();

  const out = Buffer.alloc(total);
  const offsets: number[] = [];
  let pos = 0;
  for (const file of prepared) {
    offsets.push(pos);
    pos = writeHeader(out, pos, SIG_LOCAL, file, null);
    out.set(file.data, pos);
    pos += file.data.length;
  }
  const directoryOffset = pos;
  prepared.forEach((file, i) => {
    pos = writeHeader(out, pos, SIG_CENTRAL, file, offsets[i]!);
  });
  out.writeUInt32LE(SIG_END, pos);
  out.writeUInt16LE(0, pos + 4);
  out.writeUInt16LE(0, pos + 6);
  out.writeUInt16LE(prepared.length, pos + 8);
  out.writeUInt16LE(prepared.length, pos + 10);
  out.writeUInt32LE(pos - directoryOffset, pos + 12);
  out.writeUInt32LE(directoryOffset, pos + 16);
  out.writeUInt16LE(0, pos + 20);
  return out;
}

const tooBig = () => new RmFormatError('Too much to fit in a zip without ZIP64 (over 4 GB or 65 535 files).');

/** A local header (`localOffset` null) or a central directory record; returns the position after it. */
function writeHeader(
  out: Buffer,
  pos: number,
  signature: number,
  file: { name: Uint8Array; data: Uint8Array; method: number; size: number; crc: number; utf8: boolean },
  localOffset: number | null,
): number {
  const central = localOffset !== null;
  const version = file.method === DEFLATED ? 20 : 10;
  out.writeUInt32LE(signature, pos);
  let p = pos + 4;
  if (central) {
    // Made by MS-DOS 2.0: with no Unix mode bits, unzip on Unix applies the umask instead of creating mode-000 files.
    out.writeUInt16LE(20, p);
    p += 2;
  }
  out.writeUInt16LE(version, p);
  out.writeUInt16LE(file.utf8 ? FLAG_UTF8 : 0, p + 2);
  out.writeUInt16LE(file.method, p + 4);
  out.writeUInt16LE(0, p + 6); // 00:00:00
  out.writeUInt16LE((1 << 5) | 1, p + 8); // 1980-01-01
  out.writeUInt32LE(file.crc, p + 10);
  out.writeUInt32LE(file.data.length, p + 14);
  out.writeUInt32LE(file.size, p + 18);
  out.writeUInt16LE(file.name.length, p + 22);
  out.writeUInt16LE(0, p + 24); // extra field
  p += 26;
  if (central) {
    out.writeUInt16LE(0, p); // comment
    out.writeUInt16LE(0, p + 2); // disk
    out.writeUInt16LE(0, p + 4); // internal attributes
    out.writeUInt32LE(0, p + 6); // external attributes
    out.writeUInt32LE(localOffset, p + 10);
    p += 14;
  }
  out.set(file.name, p);
  return p + file.name.length;
}
