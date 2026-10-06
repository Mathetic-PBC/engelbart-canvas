// Text copied out of a PDF (MATH-24, 2026-10-06), in Engelbart's Paper pane or any other reader, comes with the page's
// layout in it: a line break wherever the column ended, words split with a hyphen across two lines, ligature characters
// (ﬁ, ﬂ), soft hyphens and page numbers on lines of their own. pdfText() takes that layout back out, so a paste into a
// note, a workspace, a post-it, a reply field or an agent's terminal reads as the sentences it was. Text that does not
// look hard-wrapped (a list, code, lines that end where their sentences end) keeps its line breaks.

const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
// A line that starts an item of its own: a bullet, a number (`1.`, `2)`, `(3)`), a letter (`a)`, `(b)`) or a reference (`[4]`).
const ITEM_RE = /^(?:[•◦▪▫●○‣∙·\-–—*]\s|\(?\d{1,3}[.)]\s|\(?[a-z][.)]\s|\(\d{1,3}\)\s|\[\d{1,3}\]\s)/;
// Where a sentence (or a heading, or a clause the next line may not carry on) ends.
const END_RE = /[.!?:;]["'”’)\]]*$/;
// A word split across two lines: a letter, then the hyphen the layout put there.
const SPLIT_RE = /[A-Za-zÀ-ɏ]-$/;
const PAGE_NUMBER_RE = /^(?:\d{1,4}|[ivxlc]{1,6})$/i;

const median = (ns) => { const s = [...ns].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** The characters a PDF copies that no one typed: ligatures as their letters, soft hyphens gone, odd spaces as spaces. */
export const pdfChars = (text) => String(text ?? '')
  .replace(/\r\n?/g, '\n')
  .replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c)
  .replace(/­/g, '')
  .replace(/[    ]/g, ' ');

/**
 * Whether `lines` read as prose broken by a page's layout: most breaks fall where no sentence ends, the lines are a
 * column's width (a short list is not), and nothing looks like code.
 */
function hardWrapped(lines) {
  const full = lines.filter((l) => l.trim());
  if (full.length < 2 || lines.some((l) => /^\s*(```|~~~)/.test(l))) return false;
  if (full.filter((l) => /^(?: {4}|\t)/.test(l)).length > 1) return false;
  if (median(full.map((l) => l.trim().length)) < 30) return false;
  let breaks = 0, soft = 0, strong = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i].trim(), b = lines[i + 1].trim();
    if (!a || !b) continue;
    if (ITEM_RE.test(b)) continue;
    breaks += 1;
    if (SPLIT_RE.test(a) || !END_RE.test(a)) soft += 1;
    if (SPLIT_RE.test(a) || (!END_RE.test(a) && /^[a-z(]/.test(b))) strong += 1;
  }
  return breaks > 0 && strong > 0 && soft * 2 >= breaks;
}

/**
 * `text` as pasted from a PDF, with the layout taken out: inside a paragraph the lines join into one (a word the layout
 * split with a hyphen is put back whole), a blank line still parts paragraphs, and a short line that ends a sentence
 * ends its paragraph too. An item that starts a line (a bullet, `1.`, `(a)`, `[3]`) keeps its own line. Text that is
 * not hard-wrapped comes back with only pdfChars() applied.
 */
export function pdfText(text) {
  const s = pdfChars(text);
  if (!s.includes('\n')) return s;
  const lines = s.split('\n');
  if (!hardWrapped(lines)) return s;
  const width = median(lines.map((l) => l.trim()).filter(Boolean).map((l) => l.length));
  const lead = s.match(/^\n*/)[0], trail = s.match(/\n*$/)[0];
  const out = [];
  for (const block of s.trim().split(/\n[ \t]*\n+/)) {
    const ls = block.split('\n').map((l) => l.trim().replace(/\s{2,}/g, ' ')).filter(Boolean);
    const kept = ls.length > 1 ? ls.filter((l) => !PAGE_NUMBER_RE.test(l)) : ls;
    const paras = [];
    let last = ''; // the line before, as the page had it: a short one that ends a sentence ends its paragraph
    for (const line of kept) {
      const at = paras.length - 1, prev = at >= 0 ? paras[at] : null;
      const ends = prev == null || ITEM_RE.test(line) || (END_RE.test(last) && last.length < width * 0.8);
      last = line;
      if (ends) { paras.push(line); continue; }
      // `abil-` + `ities` is one word; `self-` + `Supervised` keeps its hyphen, with no space after it.
      paras[at] = !SPLIT_RE.test(prev) ? `${prev} ${line}` : /^[a-z]/.test(line) ? prev.slice(0, -1) + line : prev + line;
    }
    out.push(paras.join('\n'));
  }
  return lead + out.join('\n\n') + trail;
}
