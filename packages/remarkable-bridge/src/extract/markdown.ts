// What a page says, as text: its typed text as Markdown, and the passages highlighted on the PDF or EPUB under it.
// Handwriting is not text here: the tablet converts it only when asked, and then the result is typed text.

import type { Rgba } from '../rm/codes.ts';
import type { Page } from '../rm/page.ts';
import type { Paragraph, TextSpan } from '../rm/text.ts';

export interface PassageHighlight {
  /** The passage, fragments the tablet stored separately joined where they touch. */
  text: string;
  color: Rgba;
  /** Offset into the page's text, when the tablet recorded it. */
  start: number | null;
  /** Rectangles of every line of the passage, page units. */
  rects: { x: number; y: number; w: number; h: number }[];
}

/**
 * A page's highlights, in reading order. The tablet stores a highlight that crosses a column or a link as several; those
 * within two characters of each other and of the same colour are joined into one passage.
 */
export function highlightsOf(page: Page): PassageHighlight[] {
  const sorted = [...page.highlights].sort((a, b) => {
    if (a.start !== null && b.start !== null) return a.start - b.start;
    const ra = a.rects[0], rb = b.rects[0];
    return (ra?.y ?? 0) - (rb?.y ?? 0) || (ra?.x ?? 0) - (rb?.x ?? 0);
  });
  const out: (PassageHighlight & { end: number | null })[] = [];
  for (const h of sorted) {
    const last = out[out.length - 1];
    const sameColor = last && last.color.r === h.color.r && last.color.g === h.color.g && last.color.b === h.color.b;
    if (last && sameColor && last.end !== null && h.start !== null && h.start - last.end <= 2 && h.start >= last.end) {
      last.text += (h.start > last.end ? ' ' : '') + h.text;
      last.end = h.start + h.length;
      last.rects.push(...h.rects);
      continue;
    }
    out.push({ text: h.text, color: h.color, start: h.start, rects: [...h.rects], end: h.start === null ? null : h.start + h.length });
  }
  return out.map(({ end: _end, ...rest }) => ({ ...rest, text: rest.text.replace(/\s+/g, ' ').trim() }));
}

/** The page's typed text as Markdown; '' when it has none. */
export function textMarkdown(page: Page): string {
  if (!page.text) return '';
  const lines: string[] = [];
  const numbers: number[] = [];
  let previousListed = false;
  for (const p of page.text.paragraphs) {
    const body = spansMarkdown(p.spans);
    const listed = p.kind === 'bullet' || p.kind === 'numbered' || p.kind === 'checkbox';
    if (!listed && previousListed) lines.push('');
    if (p.kind === 'numbered') {
      numbers.length = p.level + 1;
      numbers[p.level] = (numbers[p.level] ?? 0) + 1;
    } else if (!listed) numbers.length = 0;
    lines.push(paragraphMarkdown(p, body, numbers[p.level] ?? 1));
    if (!listed) lines.push('');
    previousListed = listed;
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function paragraphMarkdown(p: Paragraph, body: string, number: number): string {
  const indent = '  '.repeat(p.level);
  switch (p.kind) {
    case 'heading': return `${'#'.repeat(p.level)} ${body}`;
    case 'bullet': return `${indent}- ${body}`;
    case 'numbered': return `${indent}${number}. ${body}`;
    case 'checkbox': return `${indent}- [${p.checked ? 'x' : ' '}] ${body}`;
    default: return body;
  }
}

/** Spans with bold and italic marked; the marks hug the words (Markdown ignores `** word**`). */
function spansMarkdown(spans: TextSpan[]): string {
  return spans.map((s) => {
    if (!s.bold && !s.italic) return escape(s.text);
    const mark = s.bold && s.italic ? '***' : s.bold ? '**' : '*';
    const m = /^(\s*)(.*?)(\s*)$/s.exec(s.text)!;
    return m[2] ? `${m[1]}${mark}${escape(m[2])}${mark}${m[3]}` : s.text;
  }).join('');
}

const escape = (text: string) => text.replace(/([\\`*_[\]])/g, '\\$1');

/** A page as Markdown: its typed text, then its highlights as quotes. */
export function pageMarkdown(page: Page): string {
  const parts = [textMarkdown(page)];
  const highlights = highlightsOf(page);
  if (highlights.length) parts.push(highlights.map((h) => `> ${h.text}`).join('\n>\n'));
  return parts.filter(Boolean).join('\n\n');
}
