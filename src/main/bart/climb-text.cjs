'use strict';

// A paper's text for a climb (onboarding build 2, 2026-10-08; ./climb.cjs): the gate that keeps a rung honest, in code and
// not the model. A rung's passage must appear word for word in the text the paper's pdf gives (pdf-text.cjs, pdf.js, as
// the reader draws it) or in its OpenAlex abstract; no match, no rung. What counts as the same words: the text is put in
// one canonical form on both sides (canon): NFKC (a ligature "ﬁ" is "fi"), curly quotes as straight ones, a soft hyphen
// gone, a word broken across a line ("construc-" / "tion") joined, and every run of space one space. Nothing else:
// case, punctuation and every word are compared as they are. A match is anchored to its span in the text as extracted
// (`find`: those characters, spaces collapsed, which the Stage's find matches in the pdf's text layer), on one page:
// a passage across a page break is refused, since the reader finds a passage page by page.
//
// Also here: the section a passage is in (its heading, for "Kapur 2008 · Method"), the text around it the approving
// model reads, and the excerpts Bart picks passages from (the windows of a paper's text nearest the sub-question).

const MIN_PASSAGE = 30;
const MAX_PASSAGE = 900; // "usually 1 to 3 sentences, rarely a paragraph"
const CONTEXT_CHARS = 1400;

const QUOTES = { '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"' };

/**
 * `text` in canonical form → { text, map }: map[i] is the index in `text` the i-th canonical character came from (the
 * first of the characters it stands for). Leading and trailing space dropped.
 */
function canon(source) {
  const input = String(source == null ? '' : source);
  let out = '';
  const map = [];
  let space = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (c === '­') continue; // a soft hyphen
    // "construc-\ntion": a hyphen at a line's end before a lowercase letter joins the word (as pdf-text.cjs joinLines).
    if ((c === '-' || c === '‐') && input[i + 1] === '\n' && /[a-z]/.test(input[i + 2] || '') && /[A-Za-z]/.test(input[i - 1] || '')) { i += 1; continue; }
    if (/\s/.test(c)) { space = out.length > 0; continue; }
    if (space) { out += ' '; map.push(i); space = false; }
    const plain = QUOTES[c] || c.normalize('NFKC');
    for (const one of plain) { out += one; map.push(i); }
  }
  return { text: out, map };
}

const canonical = (text) => canon(text).text;

/** A paper's pages ([{ page, lines }]) as one text, a line a "\n" and a page a blank line, with where each page starts. */
function joinPages(pages) {
  let text = '';
  const starts = [];
  for (const one of pages || []) {
    if (text) text += '\n\n';
    starts.push({ page: one.page, at: text.length });
    text += (one.lines || []).join('\n');
  }
  return { text, starts };
}

const pageAt = (starts, index) => { let page = starts.length ? starts[0].page : 1; for (const one of starts) { if (one.at <= index) page = one.page; else break; } return page; };

/**
 * Where `passage` is, word for word, in `text` → { start, end (in `text`), find (those characters, spaces collapsed),
 * occurrences } or null. Case and punctuation count; see canon for what does not.
 */
function exactSpan(passage, text) {
  const needle = canonical(passage);
  if (!needle) return null;
  const hay = canon(text);
  const at = hay.text.indexOf(needle);
  if (at < 0) return null;
  let occurrences = 0;
  for (let from = at; from >= 0; from = hay.text.indexOf(needle, from + 1)) occurrences += 1;
  const start = hay.map[at];
  const last = hay.map[at + needle.length - 1];
  // The source character the last canonical one came from, and any it expanded to (a ligature).
  const end = last + 1;
  return { start, end, find: text.slice(start, end).replace(/\s+/g, ' ').trim(), occurrences };
}

/** How many sentences a passage holds (a full stop, question or exclamation mark before a space or its end). */
const sentencesIn = (text) => Math.max(1, (canonical(text).match(/[.!?]["')\]]?(?=\s|$)/g) || []).length);

/**
 * The gate, in code: a rung's passage checked against the paper's text. `paper` { abstract, pages } (either may be
 * missing). `source` 'abstract' | 'text': where the writer said it came from; the pdf's text is tried first either way,
 * so a passage of the abstract that is also in the pdf opens the paper itself. → { ok: true, source: 'pdf' | 'abstract',
 * page, start, end, find, occurrences, sentences } or { ok: false, why }.
 */
function gatePassage(passage, paper) {
  const words = String(passage == null ? '' : passage).replace(/\s+/g, ' ').trim();
  if (!paper || (!paper.abstract && !(paper.pages && paper.pages.length))) return { ok: false, why: 'no text: the paper\'s text could not be had' };
  if (canonical(words).length < MIN_PASSAGE) return { ok: false, why: 'too short to stand alone' };
  if (canonical(words).length > MAX_PASSAGE) return { ok: false, why: `longer than ${MAX_PASSAGE} characters` };
  if (paper.pages && paper.pages.length) {
    const { text, starts } = joinPages(paper.pages);
    const span = exactSpan(words, text);
    if (span) {
      const page = pageAt(starts, span.start);
      if (pageAt(starts, span.end - 1) !== page) return { ok: false, why: 'runs across a page break' };
      const from = starts.find((one) => one.page === page).at;
      return { ok: true, source: 'pdf', page, start: span.start - from, end: span.end - from, find: span.find, occurrences: span.occurrences, sentences: sentencesIn(words) };
    }
  }
  if (paper.abstract) {
    const span = exactSpan(words, paper.abstract);
    if (span) return { ok: true, source: 'abstract', page: null, start: span.start, end: span.end, find: span.find, occurrences: span.occurrences, sentences: sentencesIn(words) };
  }
  return { ok: false, why: 'not word for word in the paper\'s text' };
}

// A heading as pdf.js gives one: numbered ("3.2 Study design", "2 RELATED WORK", "IV. RESULTS") or a usual section's name alone.
const NUMBERED = /^(?:\d{1,2}(?:\.\d{1,2}){0,2}\.?|[IVX]{1,5}\.)\s+([A-Z][A-Za-z0-9 ,:&'’()/–—-]{2,70})$/;
const NAMED = /^(abstract|introduction|background|related work|prior work|literature review|theoretical framework|method|methods|methodology|materials and methods|study design|participants|procedure|measures|data|data analysis|analysis|results|findings|evaluation|discussion|general discussion|conclusion|conclusions|limitations|future work|implications|summary)\s*:?$/i;

const titled = (words) => words.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(And|Of|The|In|On|For|To|A|An|With|By)\b/g, (w, _x, at) => (at ? w.toLowerCase() : w));

/** A line → the section it heads ("Method"), or '' when it heads none. */
function headingOf(line) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 80 || /[.;]$/.test(text) && !NAMED.test(text.replace(/[.;]$/, ''))) return '';
  const named = text.match(NAMED);
  if (named) return titled(named[1]);
  const numbered = text.match(NUMBERED);
  if (!numbered) return '';
  const words = numbered[1].replace(/\s+/g, ' ').trim();
  if (words.split(' ').length > 8 || /\d{3,}/.test(words)) return '';
  return words === words.toUpperCase() ? titled(words) : words;
}

/** The section a span of the pdf's text is in: the last heading before it (pages [{ page, lines }]) → its name, or ''. */
function sectionAt(pages, page, start) {
  let found = '';
  for (const one of pages || []) {
    if (one.page > page) break;
    let at = 0;
    for (const line of one.lines || []) {
      if (one.page === page && at > start) return found;
      const heading = headingOf(line);
      if (heading) found = heading;
      at += line.length + 1;
    }
  }
  return found;
}

/** A section's name as a rung shows it after the paper: short, at most four words ("Study Design", "Method"). */
const partName = (name) => String(name || '').split(/\s*[:–—]\s*/)[0].split(' ').slice(0, 4).join(' ');

/**
 * The text around a gated passage, as the approving model reads it: up to CONTEXT_CHARS before and after, whole lines,
 * the passage itself marked «…». `paper` { abstract, pages }, `gate` gatePassage's answer.
 */
function contextOf(paper, gate) {
  if (!gate || !gate.ok) return '';
  let text, start, end;
  if (gate.source === 'abstract') { text = paper.abstract; start = gate.start; end = gate.end; } else {
    const one = (paper.pages || []).find((p) => p.page === gate.page);
    const before = (paper.pages || []).find((p) => p.page === gate.page - 1);
    const after = (paper.pages || []).find((p) => p.page === gate.page + 1);
    const head = before ? `${before.lines.join('\n')}\n\n` : '';
    text = `${head}${one.lines.join('\n')}${after ? `\n\n${after.lines.join('\n')}` : ''}`;
    start = head.length + gate.start; end = head.length + gate.end;
  }
  let from = Math.max(0, start - CONTEXT_CHARS), to = Math.min(text.length, end + CONTEXT_CHARS);
  if (from > 0) { const nl = text.indexOf('\n', from); if (nl > 0 && nl < start) from = nl + 1; }
  if (to < text.length) { const nl = text.lastIndexOf('\n', to); if (nl > end) to = nl; }
  return `${from > 0 ? '…' : ''}${text.slice(from, start)}«${text.slice(start, end)}»${text.slice(end, to)}${to < text.length ? '…' : ''}`;
}

/* ------------------------------------------------------------------------------------------- excerpts for Bart */

const STOP = new Set('a an and are as at be because been being but by can could do does did for from has have how i if in into is it its may might more most no not of on or our over so such than that the their them then there these they this those through to under up use used using was we were what when where whether which while who why will with within would you your about between both each other only also'.split(' '));
const stem = (word) => word.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').slice(0, 9);
const termsOf = (text) => canonical(text).toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/[\s-]+/).filter((word) => word.length > 2 && !STOP.has(word)).map(stem);

/** A paper's canonical text cut into sentences, each with where it starts and the section it is in. */
function sentencesOf(paper) {
  const out = [];
  for (const one of paper.pages || []) {
    let section = '';
    const lines = [];
    for (const line of one.lines || []) { const heading = headingOf(line); if (heading) { if (lines.length) { out.push(...split(lines.join('\n'), one.page, section)); lines.length = 0; } section = heading; } else lines.push(line); }
    if (lines.length) out.push(...split(lines.join('\n'), one.page, section));
  }
  return out;
}
function split(text, page, section) {
  const flat = canonical(text);
  return flat.split(/(?<=[.!?]["')\]]?)\s+(?=[A-Z(“"])/).map((sentence) => sentence.trim()).filter((sentence) => sentence.length > 25).map((sentence) => ({ text: sentence, page, section }));
}

/**
 * The excerpts of a paper's pdf text nearest a sub-question, for Bart to quote from: windows of up to four sentences
 * (on one page), scored by how many of the question's terms they hold (each term once), the best `max` that do not overlap,
 * in the paper's order. → [{ page, section, text }]. A references list is never an excerpt.
 */
function excerptsFor(paper, question, { max = 5, size = 4 } = {}) {
  const wanted = new Set(termsOf(question));
  if (!wanted.size) return [];
  const sentences = sentencesOf(paper);
  const cut = sentences.findIndex((one) => /^(references|bibliography)$/i.test(one.section));
  const usable = cut >= 0 ? sentences.slice(0, cut) : sentences;
  const windows = [];
  for (let i = 0; i < usable.length; i += 1) {
    const group = [usable[i]];
    for (let j = i + 1; j < Math.min(usable.length, i + size) && usable[j].page === usable[i].page; j += 1) group.push(usable[j]);
    const text = group.map((one) => one.text).join(' ');
    if (text.length > 1400) continue;
    const terms = new Set(termsOf(text));
    let score = 0;
    for (const term of wanted) if (terms.has(term)) score += 1;
    if (score) windows.push({ from: i, to: i + group.length, page: group[0].page, section: group[0].section, text, score });
  }
  windows.sort((a, b) => b.score - a.score || a.from - b.from);
  const kept = [];
  for (const one of windows) {
    if (kept.length >= max) break;
    if (kept.some((other) => one.from < other.to && other.from < one.to)) continue;
    kept.push(one);
  }
  return kept.sort((a, b) => a.from - b.from).map(({ page, section, text }) => ({ page, section, text }));
}

/** How near a paper is to a sub-question from its title and abstract alone: the question's terms it holds (a number). */
function nearness(paper, question) {
  const wanted = new Set(termsOf(question));
  const terms = new Set(termsOf(`${paper.title || ''} ${paper.abstract || ''}`));
  let score = 0;
  for (const term of wanted) if (terms.has(term)) score += 1;
  return score;
}

module.exports = { canon, canonical, joinPages, exactSpan, gatePassage, sentencesIn, headingOf, sectionAt, partName, contextOf, excerptsFor, sentencesOf, nearness, termsOf, MIN_PASSAGE, MAX_PASSAGE };
