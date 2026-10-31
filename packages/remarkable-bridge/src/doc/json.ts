// Lenient readers for the JSON files of a document bundle. reMarkable adds, drops and retypes fields from one firmware to
// the next (null where an array was, strings where numbers were), so nothing here throws on a field's shape: a field
// that is missing or of the wrong type reads as its default, and the parsed object is kept as `raw` for callers that
// need a field this package does not model.

export class RmFormatError extends Error {
  readonly code: string;
  constructor(message: string, code = 'format') {
    super(message);
    this.name = 'RmFormatError';
    this.code = code;
  }
}

export type Json = Record<string, unknown>;

const decoder = new TextDecoder();

/** A JSON object from text or bytes; throws RmFormatError when it is not JSON or not an object. */
export function parseObject(input: string | Uint8Array, what: string): Json {
  const text = typeof input === 'string' ? input : decoder.decode(input);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RmFormatError(`${what} is not valid JSON`);
  }
  if (!isObject(value)) throw new RmFormatError(`${what} is not a JSON object`);
  return value;
}

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

export const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);

/** A number from a number or a numeric string (timestamps are strings of epoch ms), else `fallback`. */
export function num(value: unknown, fallback: number): number;
export function num(value: unknown, fallback: null): number | null;
export function num(value: unknown, fallback: number | null): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export const bool = (value: unknown): boolean => value === true || value === 1 || value === 'true';

/** A CRDT-style `{ timestamp, value }` field's value (the .content cPages fields), else the value itself. */
export const lww = (value: unknown): unknown => (isObject(value) && 'value' in value ? value.value : value);
