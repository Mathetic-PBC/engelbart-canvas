// The typed text of a page (Type Folio or on-screen keyboard), as paragraphs. Text is stored as runs of characters,
// each run under one CRDT id with the ids of the characters after its first implicit (id + 1, + 2, …). The runs are
// expanded to single characters, ordered, then read: a newline starts a paragraph whose style is keyed by that
// newline's id (the first paragraph's by (0,0)); empty items with a code switch bold and italic on and off.
// After rmscene's text.py (MIT; see THIRD_PARTY_NOTICES.md).

import { RmFormatError } from '../doc/json.ts';
import { ParagraphStyle } from './codes.ts';
import { crdtOrder } from './crdt.ts';
import { END_KEY, idKey, type IdKey } from './reader.ts';
import type { RootText, SequenceItem, TextFormat } from './blocks.ts';

export interface TextSpan {
  text: string;
  bold: boolean;
  italic: boolean;
}

export type ParagraphKind = 'plain' | 'heading' | 'bullet' | 'numbered' | 'checkbox';

export interface Paragraph {
  kind: ParagraphKind;
  /** Heading level (1–3) for a heading; list nesting (0 for the first level) for a list item; 0 otherwise. */
  level: number;
  /** For a checkbox: whether it is ticked. */
  checked: boolean;
  /** The raw style code and fields, for callers that need what this package does not interpret. */
  format: TextFormat;
  spans: TextSpan[];
  text: string;
}

export interface TypedText {
  paragraphs: Paragraph[];
  /** Top-left of the text column and its width, page units. */
  x: number;
  y: number;
  width: number;
  /** The paragraph each character is in, by character key: where a group anchored to that character sits. */
  paragraphOf: Map<IdKey, number>;
}

interface Char {
  id: { a: number; c: number };
  key: IdKey;
  left: IdKey;
  right: IdKey;
  value: string | number; // '' for a deleted character
}

/**
 * A page's text, deleted characters included, is never near this; a run or a total claiming more is a damaged file,
 * read as a problem of the page rather than an allocation that would take the process down.
 */
const MAX_CHARS = 2_000_000;

/** Splits each run into characters with explicit ids. Code points, as rmscene counts them. */
function expand(items: readonly SequenceItem<string | number>[]): Char[] {
  const out: Char[] = [];
  let total = 0;
  for (const item of items) {
    total += item.deletedLength > 0 ? item.deletedLength : typeof item.value === 'string' ? item.value.length : 1;
    if (total > MAX_CHARS) throw new RmFormatError(`Typed text claims more than ${MAX_CHARS} characters`);
    if (typeof item.value === 'number' && item.deletedLength === 0) {
      out.push({ id: item.id, key: item.key, left: item.left, right: item.right, value: item.value });
      continue;
    }
    const chars = item.deletedLength > 0 ? new Array<string>(item.deletedLength).fill('') : Array.from(typeof item.value === 'string' ? item.value : '');
    if (chars.length === 0) continue;
    const { a } = item.id;
    let c = item.id.c;
    let left = item.left;
    for (let k = 0; k < chars.length; k++, c++) {
      const key = idKey(a, c);
      const right = k === chars.length - 1 ? item.right : idKey(a, c + 1);
      out.push({ id: { a, c }, key, left, right, value: chars[k]! });
      left = key;
    }
  }
  return out;
}

const PLAIN: TextFormat = { style: ParagraphStyle.PLAIN, field2: null, field3: null };

export function readText(root: RootText): TypedText {
  const chars = crdtOrder(expand(root.items));
  const paragraphs: Paragraph[] = [];
  const paragraphOf = new Map<IdKey, number>();
  let bold = false;
  let italic = false;
  let i = 0;
  while (i < chars.length) {
    let start: IdKey = END_KEY;
    if (chars[i]!.value === '\n') start = chars[i++]!.key;
    const index = paragraphs.length;
    paragraphOf.set(start, index);
    const spans: TextSpan[] = [];
    for (; i < chars.length && chars[i]!.value !== '\n'; i++) {
      const ch = chars[i]!;
      paragraphOf.set(ch.key, index);
      if (typeof ch.value === 'number') {
        if (ch.value === 1) bold = true;
        else if (ch.value === 2) bold = false;
        else if (ch.value === 3) italic = true;
        else if (ch.value === 4) italic = false;
        continue;
      }
      if (ch.value === '') continue;
      const last = spans[spans.length - 1];
      if (last && last.bold === bold && last.italic === italic) last.text += ch.value;
      else spans.push({ text: ch.value, bold, italic });
    }
    paragraphs.push(paragraph(root.formats.get(start) ?? PLAIN, spans));
  }
  return { paragraphs, x: root.x, y: root.y, width: root.width, paragraphOf };
}

/**
 * What a style code means. Firmware 3.2x adds fields after some styles: a BOLD paragraph with fields 2 and 3 is a
 * second-level heading (BOLD alone the third), and a list item below the first level has field 2 = 3 and its level in
 * field 3 (plus 0x20 when numbered).
 */
function paragraph(format: TextFormat, spans: TextSpan[]): Paragraph {
  const MAX_LEVEL = 8; // the tablet nests lists a few deep; a larger level is a damaged file
  const listLevel = format.field2 === 3 && format.field3 !== null ? Math.min(format.field3 & ~0x20, MAX_LEVEL) : null;
  const base = { format, spans, text: spans.map((s) => s.text).join(''), checked: false };
  switch (format.style) {
    case ParagraphStyle.HEADING: return { ...base, kind: 'heading', level: 1 };
    case ParagraphStyle.BOLD: return { ...base, kind: 'heading', level: format.field2 === 2 && format.field3 === 3 ? 2 : 3 };
    case ParagraphStyle.BULLET: return { ...base, kind: 'bullet', level: 0 };
    case ParagraphStyle.BULLET2: return { ...base, kind: 'bullet', level: listLevel ?? 1 };
    case ParagraphStyle.NUMBERED: return { ...base, kind: 'numbered', level: 0 };
    case ParagraphStyle.NUMBERED_NESTED: return { ...base, kind: 'numbered', level: listLevel ?? 1 };
    case ParagraphStyle.CHECKBOX: return { ...base, kind: 'checkbox', level: 0 };
    case ParagraphStyle.CHECKBOX_CHECKED: return { ...base, kind: 'checkbox', level: 0, checked: true };
    default: return { ...base, kind: 'plain', level: 0 };
  }
}
