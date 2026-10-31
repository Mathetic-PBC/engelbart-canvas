import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutText } from '../src/rm/layout.ts';
import type { Paragraph, TypedText } from '../src/rm/text.ts';

const paragraph = (text: string): Paragraph => ({ kind: 'plain', level: 0, checked: false, format: { style: 1, field2: null, field3: null }, spans: [{ text, bold: false, italic: false }], text });
const typed = (...texts: string[]): TypedText => ({ paragraphs: texts.map(paragraph), x: -468, y: 234, width: 936, paragraphOf: new Map() });
const lineTexts = (t: TypedText) => layoutText(t).lines.map((l) => l.spans.map((s) => s.text).join(''));

test('a word longer than a line (a URL) is cut across lines, and nothing is lost', () => {
  // A real notebook held a 62-character URL on its own; an earlier wrap never finished on it.
  const url = 'https://www.diddigest.xyz/p/a-field-guide-to-missing-data-part-2-and-more-and-more';
  const lines = lineTexts(typed(url));
  assert.ok(lines.length >= 2);
  assert.equal(lines.join(''), url);
  assert.ok(lines.every((l) => l.length <= 58));
});

test('words wrap at spaces; trailing spaces never force a wrap; empty paragraphs keep a line', () => {
  const lines = lineTexts(typed('word '.repeat(30).trim(), '', 'short'));
  assert.ok(lines.length >= 4);
  assert.equal(lines.slice(0, -2).join('').replace(/\s+/g, ' ').trim(), 'word '.repeat(30).trim());
  assert.deepEqual(lines.slice(-2), ['', 'short']);
  assert.ok(lines.every((l) => l.trimEnd().length <= 58));
});

test('a long word after other words starts its own line, then is cut', () => {
  const lines = lineTexts(typed(`see ${'x'.repeat(130)} end`));
  assert.equal(lines[0], 'see ');
  assert.equal(lines.join(''), `see ${'x'.repeat(130)} end`);
});
