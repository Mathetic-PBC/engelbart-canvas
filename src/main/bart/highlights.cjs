'use strict';
// A pdf's ink as @bart is shown it (MATH-27, 2026-10-06): <stage>, the paper in front in the Stage with the page in
// view, and <highlights>, the papers the documents mention. Pure: ./context.cjs reads the ink and finds the papers.
// Ink is the Stage's: { "<page>": [mark] }, a mark { id, rects, y, text, note, group, asks: [{ question, answer, … }] }
// (src/renderer/pdf/marks.js, src/shared/mark-answers.cjs). A free note is a mark without rects; it has no quote.
// A web page's ink (MATH-54, 2026-10-06) is the same file with a "web" list beside the pages: { "web": [mark] }, a mark
// { id, quote: { exact, prefix, suffix }, note, asks, … } with no page. Its <stage> and its entry in <highlights> say
// source="web" and give the page's title and address instead of a paper and a page.

const { clipMiddle } = require('./clip.cjs');
const { WEB } = require('../../shared/mark-answers.cjs');

const QUOTE_MAX = 600; // a mark may hold whole pages (a selection across them)
const ANSWER_MAX = 1500;
const NOTE_MAX = 1500;
const QUESTION_MAX = 600;
const STAGE_BUDGET = 6000;
const MENTIONED_BUDGET = 14000;
const MORE_ROOM = '<more n="000000"/>\n'.length; // kept free in a paper for the line that says how many were left out

const attrOf = (value, max) => String(value == null ? '' : value).replace(/[<>"\n\r]/g, ' ').slice(0, max);
const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * A pdf's ink → its highlights in page order, top to bottom: [{ page, quote, note, asks: [{ question, answer }] }]. The
 * marks sharing a `group` (one selection across pages, MATH-14) are one highlight: their texts joined in page order, its
 * notes and asks together, labelled with the first page. A mark with no text, note or ask is left out.
 */
function marksOf(ink) {
  const parts = [];
  if (ink && typeof ink === 'object' && !Array.isArray(ink)) {
    for (const [key, list] of Object.entries(ink)) {
      const page = Number(key);
      if (!Number.isInteger(page) || page < 1 || !Array.isArray(list)) continue;
      list.forEach((m, i) => { if (m && typeof m === 'object') parts.push({ page, y: Number(m.y) || 0, i, m }); });
    }
  }
  parts.sort((a, b) => a.page - b.page || a.y - b.y || a.i - b.i);
  const out = [], grouped = new Map();
  for (const { page, m } of parts) {
    const piece = { quote: text(m.text), note: text(m.note), asks: asksOf(m) };
    const group = typeof m.group === 'string' && m.group ? m.group : null;
    const held = group ? grouped.get(group) : null;
    if (held) {
      if (piece.quote) held.quote.push(piece.quote);
      if (piece.note) held.note.push(piece.note);
      held.asks.push(...piece.asks);
      continue;
    }
    const entry = { page, quote: piece.quote ? [piece.quote] : [], note: piece.note ? [piece.note] : [], asks: piece.asks };
    if (group) grouped.set(group, entry);
    out.push(entry);
  }
  return out.map((h) => ({ page: h.page, quote: h.quote.join('\n'), note: h.note.join('\n'), asks: h.asks }))
    .filter((h) => h.quote || h.note || h.asks.length);
}

/** A mark's asks that say something: [{ question, answer }]. */
function asksOf(m) {
  return (Array.isArray(m.asks) ? m.asks : []).filter((a) => a && (text(a.question) || text(a.answer)))
    .map((a) => ({ question: text(a.question), answer: text(a.answer) }));
}

/**
 * A web page's ink → its highlights in the order the ink keeps them: [{ page: null, quote, note, asks }], the quote the
 * passage itself (`quote.exact`; the words around it are for finding it again on the page). The pdf pages' marks are
 * not read here, nor this list by marksOf. A mark with no quote, note or ask is left out.
 */
function webMarksOf(ink) {
  const list = ink && typeof ink === 'object' && !Array.isArray(ink) && Array.isArray(ink[WEB]) ? ink[WEB] : [];
  return list.filter((m) => m && typeof m === 'object')
    .map((m) => ({ page: null, quote: text(m.quote && typeof m.quote === 'object' ? m.quote.exact : m.quote), note: text(m.note), asks: asksOf(m) }))
    .filter((h) => h.quote || h.note || h.asks.length);
}

const said = (h) => !!(h.note || h.asks.length);

/** One highlight as a block: its quote, note and asks, each clipped in the middle; the parts it has none of are left out. */
function highlightXml(h) {
  const body = [];
  if (h.quote) body.push(`<quote>\n${clipMiddle(h.quote, QUOTE_MAX)}\n</quote>`);
  if (h.note) body.push(`<note>\n${clipMiddle(h.note, NOTE_MAX)}\n</note>`);
  for (const a of h.asks) body.push(`<ask>\n<question>\n${clipMiddle(a.question, QUESTION_MAX)}\n</question>\n<answer>\n${clipMiddle(a.answer, ANSWER_MAX)}\n</answer>\n</ask>`);
  return `<highlight${h.page ? ` page="${h.page}"` : ''}>\n${body.join('\n')}\n</highlight>\n`;
}

/**
 * Which of `candidates` ({ h, xml, … }, in the order they are wanted) fit in `room` characters: each in turn when it
 * still fits, those with a note or an ask before the bare ones. → the set of those taken.
 */
function take(candidates, room) {
  const taken = new Set();
  let left = room;
  for (const c of [...candidates.filter((c) => said(c.h)), ...candidates.filter((c) => !said(c.h))]) {
    if (c.xml.length > left) continue;
    taken.add(c);
    left -= c.xml.length;
  }
  return taken;
}

const moreLine = (n) => (n > 0 ? `<more n="${n}"/>\n` : '');
const inPageOrder = (a, b) => a.at - b.at;

/**
 * <stage paper="…" path="…" page="N" annotations="…"> the highlights of the paper in front </stage>, at most `budget`
 * characters: the ones on the page in view first, then the nearest pages (the earlier of two as near), and within that
 * the ones with a note or an ask before the bare ones; shown in page order, with <more n="K"/> when K were left out.
 * `paper`: { name, where (its absolute path or address), annotations (the ink file's absolute path) }. No highlights:
 * one line, highlights="0".
 */
function stageBlock(paper, page, ink, budget = STAGE_BUDGET) {
  const at = Number.isInteger(page) && page > 0 ? page : 1;
  const attrs = `paper="${attrOf(paper.name, 200)}" path="${attrOf(paper.where, 4096)}" page="${at}"`;
  const list = marksOf(ink);
  if (!list.length) return `<stage ${attrs} highlights="0"/>`;
  const open = `<stage ${attrs} annotations="${attrOf(paper.annotations, 4096)}">\n`, close = '</stage>';
  const candidates = list.map((h, i) => ({ h, at: i, xml: highlightXml(h) }))
    .sort((a, b) => Math.abs(a.h.page - at) - Math.abs(b.h.page - at) || a.h.page - b.h.page || a.at - b.at);
  const taken = take(candidates, budget - open.length - close.length - MORE_ROOM);
  const shown = candidates.filter((c) => taken.has(c)).sort(inPageOrder);
  return `${open}${shown.map((c) => c.xml).join('')}${moreLine(list.length - shown.length)}${close}`;
}

/** A web page's attributes: source="web", its title, its address, and the saved copy's path when there is one. */
const webAttrs = (page) => `source="web" title="${attrOf(page.name, 200)}" address="${attrOf(page.address, 4096)}"${page.path ? ` path="${attrOf(page.path, 4096)}"` : ''}`;

/**
 * <stage source="web" title="…" address="…" path="…" annotations="…"> the highlights of the web page in front </stage>
 * (MATH-54), at most `budget` characters: those with a note or an ask before the bare ones, shown in the order the ink
 * keeps them, with <more n="K"/> when K were left out. `page`: { name (its title), address, path (a saved copy's
 * index.html, else none), annotations (the ink file, '' for a page whose ink is not kept: a preview) }. No highlights:
 * one line, highlights="0", which still says what the page is.
 */
function webStageBlock(page, ink, budget = STAGE_BUDGET) {
  const attrs = webAttrs(page);
  const list = webMarksOf(ink);
  if (!list.length) return `<stage ${attrs} highlights="0"/>`;
  const open = `<stage ${attrs}${page.annotations ? ` annotations="${attrOf(page.annotations, 4096)}"` : ''}>\n`, close = '</stage>';
  const candidates = list.map((h, i) => ({ h, at: i, xml: highlightXml(h) }));
  const taken = take(candidates, budget - open.length - close.length - MORE_ROOM);
  const shown = candidates.filter((c) => taken.has(c));
  return `${open}${shown.map((c) => c.xml).join('')}${moreLine(list.length - shown.length)}${close}`;
}

/** One mentioned item's highlights and the tags around them: a pdf's <paper>, a web page's <page source="web"> (MATH-54). */
function mentionedItem(item) {
  if (item && item.source === 'web') {
    return { list: webMarksOf(item.ink), head: `<page ${webAttrs(item)} annotations="${attrOf(item.annotations, 4096)}">\n`, tail: '</page>\n' };
  }
  return { list: marksOf(item && item.ink), head: `<paper name="${attrOf(item && item.name, 200)}" path="${attrOf(item && item.where, 4096)}" annotations="${attrOf(item && item.annotations, 4096)}">\n`, tail: '</paper>\n' };
}

/**
 * <highlights from="mentioned"> a <paper name="…" path="…" annotations="…"> for each of `papers` that has highlights
 * </highlights>, at most `budget` characters shared among them: those with a note or an ask before the bare ones, and
 * within each, the papers' first highlights, then their second… so every paper gets some; each paper's shown in page
 * order, with <more n="K"/> when K were left out. `papers`: [{ name, where, annotations, ink }]. A saved web page
 * (MATH-54) is { source: 'web', name, address, path, annotations, ink }, shown as <page source="web" title="…"
 * address="…" path="…" annotations="…"> the same way. '' when none has any.
 */
function mentionedBlock(papers, budget = MENTIONED_BUDGET) {
  const open = '<highlights from="mentioned">\n', close = '</highlights>';
  let room = budget - open.length - close.length;
  const held = [];
  for (const paper of papers || []) {
    const { list, head, tail } = mentionedItem(paper);
    if (!list.length) continue;
    const frame = head.length + tail.length + MORE_ROOM;
    if (frame > room) continue;
    room -= frame;
    held.push({ head, tail, list, candidates: list.map((h, i) => ({ h, at: i, xml: highlightXml(h), n: held.length })) });
  }
  if (!held.length) return '';
  const candidates = held.flatMap((p) => p.candidates).sort((a, b) => a.at - b.at || a.n - b.n);
  const taken = take(candidates, room);
  const body = held.map((p) => {
    const shown = p.candidates.filter((c) => taken.has(c)).sort(inPageOrder);
    return `${p.head}${shown.map((c) => c.xml).join('')}${moreLine(p.list.length - shown.length)}${p.tail}`;
  });
  return `${open}${body.join('')}${close}`;
}

module.exports = { attrOf, marksOf, webMarksOf, stageBlock, webStageBlock, mentionedBlock, STAGE_BUDGET, MENTIONED_BUDGET, QUOTE_MAX, ANSWER_MAX };
