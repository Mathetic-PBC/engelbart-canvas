// An estimate of how the tablet lays out a page's typed text. The file holds the characters, the paragraph styles, the
// column's top-left and its width, but not the fonts, sizes or wrapping, so lines here are placed with typical sizes.
// Used to draw the text, and to place strokes anchored to a line of it (./page.ts). Good to about a line.

import type { Paragraph, TextSpan, TypedText } from './text.ts';

export interface TextLine {
  /** Index into TypedText.paragraphs. */
  paragraph: number;
  x: number;
  baseline: number;
  fontSize: number;
  bold: boolean;
  /** A list item's marker on its first line: '•', '1.', '☐', '☑'; '' otherwise. */
  marker: string;
  spans: TextSpan[];
}

export interface TextLayout {
  lines: TextLine[];
  /** The top of each paragraph, page units. */
  paragraphTops: number[];
  /** Below the last line. */
  bottom: number;
}

interface Look { size: number; lineHeight: number; bold: boolean }

function lookOf(p: Paragraph): Look {
  if (p.kind === 'heading') return p.level === 1 ? { size: 56, lineHeight: 130, bold: false } : p.level === 2 ? { size: 44, lineHeight: 100, bold: true } : { size: 36, lineHeight: 80, bold: true };
  return { size: 32, lineHeight: 70, bold: false };
}

const INDENT = 40;
const CHAR_WIDTH = 0.5; // of the font size, on average

export function layoutText(text: TypedText): TextLayout {
  const lines: TextLine[] = [];
  const paragraphTops: number[] = [];
  let y = text.y;
  const numbers: number[] = [];
  text.paragraphs.forEach((p, index) => {
    paragraphTops.push(y);
    const look = lookOf(p);
    const listed = p.kind === 'bullet' || p.kind === 'numbered' || p.kind === 'checkbox';
    const indent = listed ? INDENT * (p.level + 1) : 0;
    if (p.kind === 'numbered') {
      numbers.length = p.level + 1;
      numbers[p.level] = (numbers[p.level] ?? 0) + 1;
    } else if (!listed) numbers.length = 0;
    const marker = p.kind === 'bullet' ? '•' : p.kind === 'numbered' ? `${numbers[p.level]}.` : p.kind === 'checkbox' ? (p.checked ? '☑' : '☐') : '';
    const perLine = Math.max(8, Math.floor((text.width - indent) / (look.size * CHAR_WIDTH)));
    const wrapped = wrap(p.spans, perLine);
    if (wrapped.length === 0) wrapped.push([]);
    wrapped.forEach((spans, i) => {
      lines.push({ paragraph: index, x: text.x + indent, baseline: y + look.lineHeight * 0.7, fontSize: look.size, bold: look.bold, marker: i === 0 ? marker : '', spans });
      y += look.lineHeight;
    });
  });
  return { lines, paragraphTops, bottom: y };
}

/** Spans broken into lines of at most `perLine` characters, at spaces where possible. */
function wrap(spans: TextSpan[], perLine: number): TextSpan[][] {
  const out: TextSpan[][] = [];
  let line: TextSpan[] = [];
  let used = 0;
  const add = (piece: string, from: TextSpan) => {
    const last = line[line.length - 1];
    if (last && last.bold === from.bold && last.italic === from.italic) last.text += piece;
    else line.push({ text: piece, bold: from.bold, italic: from.italic });
    used += piece.length;
  };
  const newLine = () => { out.push(line); line = []; used = 0; };
  for (const span of spans) {
    for (const word of span.text.split(/(?<= )/)) {
      let rest = word;
      // Every turn either starts a new line or uses up a line's worth of the word, so this always ends.
      while (used + rest.trimEnd().length > perLine) {
        if (used > 0) { newLine(); continue; } // the word goes on the next line
        add(rest.slice(0, perLine), span); // a word longer than a line (a URL) is cut
        rest = rest.slice(perLine);
        newLine();
      }
      if (rest) add(rest, span);
    }
  }
  if (line.length) out.push(line);
  return out;
}
