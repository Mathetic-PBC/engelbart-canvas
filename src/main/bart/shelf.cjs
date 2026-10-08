'use strict';

// The papers a climb may quote (onboarding build 2, 2026-10-08; ./climb.cjs): each candidate onboarding's searches found,
// made ready to read. For a paper: its OpenAlex record in full (./papers.cjs resolve: the abstract, free by id), then an
// open-access pdf, found as a Zotero item's free copy is (../zotero/oa.cjs: OpenAlex's pdf addresses, then Semantic
// Scholar's, then arXiv's), then its text page by page (../context/pdf-text.cjs, pdf.js, as the reader draws it). Kept in
// `dir`, one folder a paper, so a paper is fetched once whatever project or onboarding asks again:
//   <dir>/<W…>/record.json   { id, title, authors, year, venue, type, cited_by, doi, abstract, at }
//   <dir>/<W…>/text.json     { pages: [{ page, lines }], at }   only when a pdf was had
//   <dir>/oa/…               the pdfs (oa.cjs's files/ and items/)
// A paper with no pdf to be had keeps its abstract, which may be quoted (an abstract is a good first rung); one with
// neither is never a rung. Nothing here throws: a failure is a paper with less to read.
// Since 2026-10-08 a paper's record is had first and alone (`describe`: free by id), so the papers worth reading are
// picked from title, abstract, venue, year and citations (./climb.cjs pickPapers) before any pdf is fetched.

const fs = require('node:fs');
const path = require('node:path');
const { createOpenAccess } = require('../zotero/oa.cjs');
const { openPdf, pageLines } = require('../context/pdf-text.cjs');

const MAX_PAGES = 60;
const ID_RE = /^W\d{1,12}$/;

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`);
  fs.renameSync(temporary, file);
}

// Characters markdown would read as markup are taken out of an abstract once, here: the abstract a rung quotes is the
// file the Stage draws (climbs.cjs abstractFile), word for word.
const plainAbstract = (text) => String(text || '').replace(/[*_`[\]<>#\\|]/g, ' ').replace(/\s+/g, ' ').trim();

/** The pages of a pdf as pdf.js gives them: [{ page, lines: [text] }], the first MAX_PAGES. */
async function readPages(file, { maxPages = MAX_PAGES } = {}) {
  const { doc, close } = await openPdf(file);
  const pages = [];
  try {
    for (let n = 1; n <= Math.min(maxPages, doc.numPages); n += 1) pages.push({ page: n, lines: (await pageLines(doc, n)).map((line) => line.text) });
  } finally { await close(); }
  return pages;
}

/** "Kapur 2008", "Bastani et al. 2025": the label a rung's paper is shown with. */
function paperLabel(paper) {
  const authors = (paper && paper.authors) || [];
  const real = authors.filter((name) => !/^et al\./.test(name));
  const last = (name) => String(name || '').trim().split(/\s+/).pop();
  const who = real.length === 0 ? (paper && paper.title ? String(paper.title).split(/\s+/).slice(0, 3).join(' ') : 'Paper') : real.length === 1 ? last(real[0]) : real.length === 2 && authors.length === 2 ? `${last(real[0])} & ${last(real[1])}` : `${last(real[0])} et al.`;
  return [who, paper && paper.year].filter(Boolean).join(' ');
}

/**
 * `dir`: where papers are kept. `papers`: ./papers.cjs (resolve). `openAccess`: oa.cjs's createOpenAccess, made on
 * `dir/oa` unless given (tests). `readPdf(file)`: the pages (tests). → { prepare(candidate), get(id) }
 */
function createShelf({ dir, papers, openAccess = null, readPdf = readPages, now = () => new Date().toISOString() } = {}) {
  const access = openAccess || createOpenAccess({ root: path.join(dir, 'oa') });
  const running = new Map();

  /** What is kept of paper `id` → { id, title, authors, year, venue, doi, abstract, pdf, pages } | null. */
  function get(id) {
    if (!ID_RE.test(String(id || ''))) return null;
    const record = readJson(path.join(dir, id, 'record.json'));
    if (!record) return null;
    const text = readJson(path.join(dir, id, 'text.json'));
    const kept = access.kept(id);
    return { ...record, pdf: kept && text ? kept.path : null, pages: kept && text && Array.isArray(text.pages) ? text.pages : null };
  }

  /** The record of paper `candidate` ({ id, … }), from the shelf or OpenAlex → it, or null (not found, or not reached). */
  async function recordOf(candidate) {
    const id = candidate.id;
    const record = readJson(path.join(dir, id, 'record.json'));
    // A record kept before citations were (2026-10-08) takes them from the search that found it.
    if (record) return record.cited_by == null && candidate.cited_by != null ? { ...record, cited_by: candidate.cited_by, type: record.type || candidate.type || null } : record;
    let full = null;
    try { const out = await papers.resolve({ query: id }); full = out && out.found ? out.paper : null; } catch { full = null; }
    if (!full) return null;
    const made = { id, title: full.title, authors: full.authors || [], year: full.year || null, venue: full.venue || null, type: full.type || null, cited_by: full.cited_by || 0, doi: full.doi || null, abstract: plainAbstract(full.abstract) || null, oa: full.open_access || null, at: now() };
    writeJson(path.join(dir, id, 'record.json'), made);
    return made;
  }

  async function fetchOne(candidate) {
    const id = candidate.id;
    const record = await recordOf(candidate);
    if (!record) return get(id) || null;
    if (!readJson(path.join(dir, id, 'text.json'))) {
      const last = (name) => String(name || '').trim().split(/\s+/).pop();
      const item = { key: id, doi: record.doi || '', title: record.title || '', year: record.year || '', creators: (record.authors || []).filter((name) => !/^et al\./.test(name)).slice(0, 1).map((name) => ({ type: 'author', last: last(name) })) };
      let copy = null;
      try { copy = await access.find(item); } catch { copy = null; }
      if (copy && copy.path) {
        try { writeJson(path.join(dir, id, 'text.json'), { pages: await readPdf(copy.path), at: now() }); } catch { /* a pdf pdf.js cannot read: the abstract only */ }
      }
    }
    return get(id);
  }

  return {
    /** A candidate ({ id, … } from a search) made ready: its record, and its text when a pdf was had. Once at a time a paper. */
    prepare(candidate) {
      const id = candidate && candidate.id;
      if (!ID_RE.test(String(id || ''))) return Promise.resolve(null);
      if (running.has(id)) return running.get(id);
      const kept = get(id);
      if (kept && kept.pages) return Promise.resolve(kept);
      // Asked again for one without a pdf: oa.cjs remembers a miss (a week; an hour when a source was not reached).
      const under = fetchOne(candidate).catch(() => get(id)).finally(() => running.delete(id));
      running.set(id, under);
      return under;
    },
    /** A candidate's record alone, no pdf: what picking it reads. → { id, title, authors, year, venue, type, cited_by, abstract } | null */
    async describe(candidate) {
      const id = candidate && candidate.id;
      if (!ID_RE.test(String(id || ''))) return null;
      try { return await recordOf(candidate); } catch { return null; }
    },
    get,
    dir,
  };
}

module.exports = { createShelf, readPages, paperLabel, plainAbstract };
