'use strict';
// How a quoted passage is found in a text, wherever one is (2026-10-21, Chat's citations): main checks a citation's words
// against its source (../main/bart/cite.cjs), and the Stage finds them in a file it draws (renderer/workspace/Stage.jsx).
// Both fold the two texts the same way, so what main kept is what the Stage lands on. Folded: case, every run of
// whitespace one space, curly quotes and primes straight, any dash a hyphen, the fi/fl ligatures spelled out, soft
// hyphens gone, and a word broken at a line's end ("construc-\ntion") whole. `prefixes`: a workspace's line prefixes
// ("@bart ", "bart> ", "bart+> ") are not text. `markdown`: emphasis marks, backticks, a link's brackets and address,
// and a heading's or list item's mark are not text either. Every folded character keeps the offset it came from, so a
// match maps back onto the original.
// (The Stage's web pages are matched in page-preload.cjs, which runs sandboxed and cannot load this; its fold is the
// one-for-one part of this one.)

const ONE = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
};
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const SOFT_HYPHEN = '­';
const SPACE = /\s/;
const HYPHEN = /[-‐-―−]/;
const LETTER = /\p{L}/u;
// A workspace line's prefix: the question's, an answer's, a folded answer's, a pending or draft answer's.
const PREFIX_RE = /^(?:@(?:bart|chat|brainstorm|discover|create|build)\b(?:\s+--\S+)*\s|bart[+?~]?> ?)/i;
const MD_LINE_RE = /^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/;

/**
 * `text` folded → { text, map }: `map[i]` is the offset in `text` that folded character i came from. Leading and
 * trailing space is dropped. Options: { prefixes, markdown } (above).
 */
function foldPassage(input, { prefixes = false, markdown = false } = {}) {
  const src = String(input == null ? '' : input);
  // Built as a list of characters: asking a string being added to for its last character copies it whole each time,
  // which took a second over a long workspace's document (2026-10-21).
  const out = [];
  const map = [];
  let lineStart = true;
  const push = (chars, at) => {
    for (const c of chars) { out.push(c); map.push(at); }
  };
  const space = (at) => { if (out.length && out[out.length - 1] !== ' ') push(' ', at); };
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\n') { space(i); lineStart = true; continue; }
    if (SPACE.test(c)) { space(i); continue; }
    if (lineStart) {
      lineStart = false;
      const rest = src.slice(i, i + 80);
      if (prefixes) {
        const m = rest.match(PREFIX_RE);
        if (m) { i += m[0].length - 1; lineStart = true; continue; }
      }
      if (markdown) {
        const m = rest.match(MD_LINE_RE);
        if (m) { i += m[0].length - 1; continue; }
      }
    }
    if (c === SOFT_HYPHEN) continue;
    // "construc-\ntion": a hyphen at a line's end between letters joins the word.
    if (HYPHEN.test(c) && i > 0 && LETTER.test(src[i - 1])) {
      const m = src.slice(i + 1, i + 40).match(/^[ \t]*\r?\n\s*/);
      if (m && LETTER.test(src[i + 1 + m[0].length] || '')) {
        // a line prefix after the break is skipped as the line's start would be
        let j = i + 1 + m[0].length;
        if (prefixes) { const p = src.slice(j, j + 80).match(PREFIX_RE); if (p) j += p[0].length; }
        if (LETTER.test(src[j] || '') && src[j] === src[j].toLowerCase()) { i = j - 1; continue; }
      }
    }
    if (markdown) {
      if (c === '*' || c === '`' || c === '_' || c === '[') continue;
      if (c === ']' && src[i + 1] === '(') {
        const close = src.indexOf(')', i + 2);
        if (close > 0 && !/\s/.test(src.slice(i + 2, close))) { i = close; continue; }
      }
      if (c === ']') continue;
    }
    if (ONE[c]) { push(ONE[c], i); continue; }
    if (LIGATURES[c]) { push(LIGATURES[c], i); continue; }
    push(c.toLowerCase(), i);
  }
  while (out[out.length - 1] === ' ') { out.pop(); map.pop(); }
  return { text: out.join(''), map };
}

/** `text` folded, as foldPassage does: for comparing, when where it came from does not matter. */
const normalizePassage = (text, options) => foldPassage(text, options).text;

// The same folded text with some characters left out (hyphens, or spaces too), and where each one left came from.
function without(folded, drop) {
  let text = '';
  const map = [];
  for (let i = 0; i < folded.text.length; i += 1) {
    if (drop.test(folded.text[i])) continue;
    text += folded.text[i];
    map.push(folded.map[i]);
  }
  return { text, map };
}

/**
 * Every place `words` are in `text` → [{ start, end }], offsets into `text`. Both are folded (foldPassage, with `options`
 * for `text`; `words` with `markdown` alone, so a quote's own emphasis marks do not count). Where that finds nothing, the
 * hyphens are let go ("well-\nknown" is "wellknown" once broken), then the spaces too, for text whose pieces ran
 * together with none between them (a table's cells, a list's items, a file drawn across many nodes).
 */
function matchPassage(text, words, options = {}) {
  const hay = foldPassage(text, options);
  const want = foldPassage(words, { markdown: !!options.markdown }).text;
  if (!want) return [];
  const tries = [[hay, want], [without(hay, /-/), want.replace(/-/g, '')], [without(hay, /[- ]/), want.replace(/[- ]/g, '')]];
  for (const [h, w] of tries) {
    if (!w) continue;
    const out = [];
    for (let at = h.text.indexOf(w); at >= 0; at = h.text.indexOf(w, at + 1)) out.push({ start: h.map[at], end: h.map[at + w.length - 1] + 1 });
    if (out.length) return out;
  }
  return [];
}

module.exports = { foldPassage, normalizePassage, matchPassage, PREFIX_RE };
