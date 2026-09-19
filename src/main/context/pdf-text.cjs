'use strict';

// Text out of a PDF, for the catalog. A paper that prints an "Abstract" section already carries the
// blurb its authors wrote, so that text becomes the summary and no model runs; only a PDF without
// one is summarized like a note, from its extracted text.
//
// pdf.js (already a dependency, for the reader) is loaded on first use. Lines are rebuilt from text
// items by baseline; rotated items (the arXiv stamp down the margin) are dropped.

const fs = require('node:fs');

const MAX_ABSTRACT_CHARS = 4000;
const HEADING_ALONE = /^abstract\s*[:.]?$/i;
const HEADING_RUN_IN = /^abstract\s*[—–:.-]\s*(\S.*)$/i;
// What follows an abstract: the next section, or front-matter boilerplate.
const NEXT_SECTION = /^(?:(?:\d+(?:\.\d+)*\.?|[IVX]{1,4}\.)\s+[A-Z]|introduction\b|ccs concepts\b|keywords?\b|key words\b|index terms\b|author keywords\b|additional key ?words\b|categories and subject descriptors\b|general terms\b|acm reference format\b|permission to make\b)/i;
const ENDS_SENTENCE = /[.!?]["'”’)\]]?$/;

let pdfjsPromise = null;
const loadPdfjs = () => { pdfjsPromise = pdfjsPromise || import('pdfjs-dist/legacy/build/pdf.mjs'); return pdfjsPromise; };

/** Lines of the first `maxPages` pages: [{ page, x, y, h (font height), text }], in reading order of the content stream. */
async function readPdfLines(file, { maxPages = 3 } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const lines = [];
  try {
    for (let n = 1; n <= Math.min(maxPages, doc.numPages); n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let current = null;
      const flush = () => { if (current && current.text.trim()) lines.push({ ...current, text: current.text.replace(/\s+/g, ' ').trim() }); current = null; };
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        const [, b, c, , x, y] = item.transform;
        if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01) continue; // rotated: watermarks, margin stamps
        if (current && Math.abs(y - current.y) > 2) flush();
        if (!current) current = { page: n, x: Math.round(x), y: Math.round(y), h: Math.round((item.height || 0) * 10) / 10, text: '' };
        current.text += item.str;
        if (item.hasEOL) flush();
      }
      flush();
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return lines;
}

const joinLines = (parts) => parts.reduce((text, part) => {
  if (!text) return part;
  // "prin-" + "ciples": a word broken across lines loses its hyphen.
  if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(part)) return text.slice(0, -1) + part;
  return `${text} ${part}`;
}, '');

/** The text under an "Abstract" section header, or null when the lines have none. */
function findAbstract(lines) {
  const at = lines.findIndex((line) => HEADING_ALONE.test(line.text) || HEADING_RUN_IN.test(line.text));
  if (at < 0) return null;
  const heading = lines[at];
  const runIn = heading.text.match(HEADING_RUN_IN);
  const parts = runIn ? [runIn[1]] : [];
  let bodyHeight = runIn ? heading.h : null;
  let previous = heading;
  for (const line of lines.slice(at + 1)) {
    if (bodyHeight == null) bodyHeight = line.h;
    const newBlock = line.page !== previous.page || line.y > previous.y + 2 || Math.abs(line.x - previous.x) > 40;
    if (NEXT_SECTION.test(line.text)) break;
    if (!runIn && heading.h > bodyHeight + 0.5 && line.h >= heading.h - 0.2 && line.text.length < 60) break; // set like the "Abstract" heading itself
    if (parts.length && newBlock && ENDS_SENTENCE.test(parts[parts.length - 1])) break; // the paragraph ended where the column or page did
    if (line.h && bodyHeight && line.h < bodyHeight - 1.5) continue; // running heads, footnote marks
    parts.push(line.text);
    previous = line;
    if (parts.join(' ').length > MAX_ABSTRACT_CHARS) break;
  }
  let text = joinLines(parts).trim();
  if (!text) return null;
  if (text.length > MAX_ABSTRACT_CHARS) {
    const head = text.slice(0, MAX_ABSTRACT_CHARS);
    const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
    text = stop > 0 ? head.slice(0, stop + 1) : head;
  }
  return text;
}

/** The abstract of a PDF (looked for on its first three pages), or null. */
async function extractAbstract(file) {
  return findAbstract(await readPdfLines(file, { maxPages: 3 }));
}

/** The whole text of a PDF, one line per printed line (for the model, when there is no abstract). */
async function extractText(file, { maxPages = 120 } = {}) {
  return (await readPdfLines(file, { maxPages })).map((line) => line.text).join('\n');
}

module.exports = { readPdfLines, findAbstract, extractAbstract, extractText, MAX_ABSTRACT_CHARS };
