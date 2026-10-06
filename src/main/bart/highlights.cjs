'use strict';
// A pdf's ink as @bart is shown it (MATH-27, 2026-10-06): <stage>, the paper in front in the Stage with the page in
// view, and <highlights>, the papers the documents mention. Pure: ./context.cjs reads the ink and finds the papers.
// Ink is the Stage's: { "<page>": [mark] }, a mark { id, rects, y, text, note, group, asks: [{ question, answer, … }] }
// (src/renderer/pdf/marks.js, src/shared/mark-answers.cjs). A free note is a mark without rects; it has no quote.

const { clipMiddle } = require('./clip.cjs');

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
    const asks = (Array.isArray(m.asks) ? m.asks : []).filter((a) => a && (text(a.question) || text(a.answer)))
      .map((a) => ({ question: text(a.question), answer: text(a.answer) }));
    const piece = { quote: text(m.text), note: text(m.note), asks };
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

const said = (h) => !!(h.note || h.asks.length);

/** One highlight as a block: its quote, note and asks, each clipped in the middle; the parts it has none of are left out. */
function highlightXml(h) {
  const body = [];
  if (h.quote) body.push(`<quote>\n${clipMiddle(h.quote, QUOTE_MAX)}\n</quote>`);
  if (h.note) body.push(`<note>\n${clipMiddle(h.note, NOTE_MAX)}\n</note>`);
  for (const a of h.asks) body.push(`<ask>\n<question>\n${clipMiddle(a.question, QUESTION_MAX)}\n</question>\n<answer>\n${clipMiddle(a.answer, ANSWER_MAX)}\n</answer>\n</ask>`);
  return `<highlight page="${h.page}">\n${body.join('\n')}\n</highlight>\n`;
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

/**
 * <highlights from="mentioned"> a <paper name="…" path="…" annotations="…"> for each of `papers` that has highlights
 * </highlights>, at most `budget` characters shared among them: those with a note or an ask before the bare ones, and
 * within each, the papers' first highlights, then their second… so every paper gets some; each paper's shown in page
 * order, with <more n="K"/> when K were left out. `papers`: [{ name, where, annotations, ink }]. '' when none has any.
 */
function mentionedBlock(papers, budget = MENTIONED_BUDGET) {
  const open = '<highlights from="mentioned">\n', close = '</highlights>';
  let room = budget - open.length - close.length;
  const held = [];
  for (const paper of papers || []) {
    const list = marksOf(paper && paper.ink);
    if (!list.length) continue;
    const head = `<paper name="${attrOf(paper.name, 200)}" path="${attrOf(paper.where, 4096)}" annotations="${attrOf(paper.annotations, 4096)}">\n`;
    const frame = head.length + '</paper>\n'.length + MORE_ROOM;
    if (frame > room) continue;
    room -= frame;
    held.push({ head, list, candidates: list.map((h, i) => ({ h, at: i, xml: highlightXml(h), n: held.length })) });
  }
  if (!held.length) return '';
  const candidates = held.flatMap((p) => p.candidates).sort((a, b) => a.at - b.at || a.n - b.n);
  const taken = take(candidates, room);
  const body = held.map((p) => {
    const shown = p.candidates.filter((c) => taken.has(c)).sort(inPageOrder);
    return `${p.head}${shown.map((c) => c.xml).join('')}${moreLine(p.list.length - shown.length)}</paper>\n`;
  });
  return `${open}${body.join('')}${close}`;
}

module.exports = { attrOf, marksOf, stageBlock, mentionedBlock, STAGE_BUDGET, MENTIONED_BUDGET, QUOTE_MAX, ANSWER_MAX };
