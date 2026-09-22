'use strict';

// Is this pdf a paper? Its type says only that it is a pdf; `paper` is a tag, inferred here from
// what the file prints and says about itself. The signals are structural, the kind CiteSeerX's
// crawler sorts papers from slides, books and resumes by (Caragea, Wu, Gollapalli & Giles 2016,
// "Document Type Classification in Online Digital Libraries": structure beats bag-of-words).
// Authors are left out on purpose: finding an author block takes a trained header model
// (GROBID's job), and a rule that guesses at it is wrong in both directions.
//
//   arxiv       the stamp arXiv prints down the margin of page 1: id, [category], date
//   doi         a DOI in the file's own metadata, or printed on page 1
//   abstract    an "Abstract" heading on the first three pages (pdf-text's findAbstract)
//   keywords    a Keywords / Index Terms / CCS Concepts heading on the first three pages
//   references  a line that is only References / Bibliography / Works Cited, anywhere up to page 60
//
// A paper is the stamp, or any two of the other four. Tuned to say no when unsure: a wrong tag has
// no way of being taken off yet. Known misses: a scanned paper (no text), a paper older than the
// habit of printing "Abstract". Known false alarms: an RFC, a thesis, a technical report with an
// abstract and a reference list — arguably papers.

const fs = require('node:fs');
const { openPdf, pageLines, findAbstract } = require('./pdf-text.cjs');

const FIRST_PAGES = 3;
const MAX_PAGES = 60;
const MAX_BYTES = 200 * 1024 * 1024;
const ARXIV_STAMP = /arXiv:\s*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\s*\[[\w.-]+\]\s*\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4}/;
const DOI = /\b10\.\d{4,9}\/[^\s"<>]{2,}/;
const KEYWORDS = /^(?:keywords?|key words|index terms|author keywords|additional key ?words(?: and phrases)?|ccs concepts)\s*(?:[:—–•.-]|$)/i;
const REFERENCES = /^(?:\d+\.?\s+|[IVX]+\.\s+)?(?:references|bibliography|works cited|literature cited|references and notes)\s*$/i;

/** What the file says about itself: the Info dictionary and the XMP packet, as one text. */
async function aboutText(doc) {
  try {
    const { info, metadata } = await doc.getMetadata();
    const xmp = metadata && typeof metadata.getAll === 'function' ? metadata.getAll() : null;
    return JSON.stringify([info || null, xmp || null]);
  } catch { return ''; }
}

/** The five signals. `references` is null when nothing turned on it, so the later pages were not read. */
async function paperSignals(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('The pdf is too large to look into');
  const { doc, close } = await openPdf(file);
  try {
    const lines = [];
    const stamps = [];
    for (let n = 1; n <= Math.min(FIRST_PAGES, doc.numPages); n += 1) lines.push(...(await pageLines(doc, n, n === 1 ? { rotated: stamps } : {})));
    const pageOne = lines.filter((line) => line.page === 1).map((line) => line.text);
    const signals = {
      arxiv: ARXIV_STAMP.test(stamps.join(' ')) || pageOne.some((text) => ARXIV_STAMP.test(text)),
      doi: DOI.test(await aboutText(doc)) || pageOne.some((text) => DOI.test(text)),
      abstract: findAbstract(lines) != null,
      keywords: lines.some((line) => KEYWORDS.test(line.text)),
      references: null,
    };
    const others = [signals.doi, signals.abstract, signals.keywords].filter(Boolean).length;
    if (signals.arxiv || others !== 1) return signals; // decided either way without the reference list
    signals.references = lines.some((line) => REFERENCES.test(line.text));
    for (let n = FIRST_PAGES + 1; !signals.references && n <= Math.min(MAX_PAGES, doc.numPages); n += 1) {
      signals.references = (await pageLines(doc, n)).some((line) => REFERENCES.test(line.text));
    }
    return signals;
  } finally {
    await close();
  }
}

const isPaper = (signals) => !!signals.arxiv || [signals.doi, signals.abstract, signals.keywords, signals.references].filter(Boolean).length >= 2;

/** The tags a pdf's content earns: `['paper']` or `[]`. Throws when the file cannot be read as a pdf. */
async function inspectPdf(file) {
  return isPaper(await paperSignals(file)) ? ['paper'] : [];
}

module.exports = { paperSignals, isPaper, inspectPdf };
