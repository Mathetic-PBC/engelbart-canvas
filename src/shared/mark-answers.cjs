'use strict';
// An answer Bart gave from a note on a pdf's highlight (MATH-27), as the mark keeps it in the pdf's ink. Shared since the
// second-pass fixes (2026-10-06): the Stage puts a finished answer on its mark (src/renderer/pdf/canvas.js re-exports
// these), and so does main itself (src/main/store/library.cjs addMarkAnswer), so an answer still lands when the window
// that asked was reloaded meanwhile.

const ATTRIBUTION = /^\*([^*]+)\*$/;

// Where a web page's highlights are kept in its ink (MATH-54, 2026-10-06): one list beside the pdf pages' numbered ones,
// { "web": [mark] }, a mark { id, quote: { exact, prefix, suffix }, note, asks, … } with no page (src/main/bart/highlights.cjs).
const WEB = 'web';

/**
 * An answer's lines as main sends them (`bart> …`, then a blank line and its foot, "*Sol · high · 12 s*") → { answer,
 * foot }: the answer as the document would hold it and as a follow-up sends it back (main: bart/reply.cjs answerText),
 * so the follow-up finds the same session (ask.cjs threadKey); the foot without its stars.
 */
function answerOf(lines) {
  const body = (Array.isArray(lines) ? lines : []).map((line) => String(line).replace(/^bart\+?> ?/, ''));
  let foot = '';
  const last = body.length ? body[body.length - 1].match(ATTRIBUTION) : null;
  if (last) { foot = last[1]; body.pop(); }
  return { answer: body.join('\n').trim(), foot };
}

// A box's picture as an answer keeps it (MATH-70 build 2, 2026-10-07): the one the box had when it was asked about,
// "crops/<…>.png" under the annotations folder (src/main/browser/boxes.cjs CROP_RE), kept when the box is resized later.
const CROP_RE = /^crops\/[\w-]{1,64}\.png$/;

/**
 * A finished answer as a mark keeps it: { id, question, answer, meta, at, pos, collapsed }, and `crop` when it was asked
 * about a box: the box's picture at the moment it was asked.
 */
function askEntry({ id, question, lines, meta, at, crop = null }) {
  const { answer, foot } = answerOf(lines);
  const level = (meta && meta.level) || {};
  return {
    id,
    question: String(question || '').trim(),
    answer,
    meta: { provider: (meta && meta.provider) || null, name: level.name || null, effort: level.effort || null, ms: (meta && meta.ms) || null, foot },
    at,
    pos: null,
    collapsed: false,
    ...(typeof crop === 'string' && CROP_RE.test(crop) ? { crop } : {}),
  };
}

/**
 * The marks with `entry` added to the answers of mark `markId` on `page` (once), or in the web page's list when `page` is
 * null (WEB). Unchanged when the mark is gone or has it. An entry's `crop` (a box's picture when it was asked) is kept as
 * it came: the box may have a newer picture by now.
 */
function withAsk(marks, page, markId, entry) {
  if (page == null) page = WEB;
  const list = (marks || {})[page];
  const m = Array.isArray(list) ? list.find((x) => x && x.id === markId) : null;
  if (!m || (m.asks || []).some((a) => a && a.id === entry.id)) return marks || {};
  return { ...marks, [page]: list.map((x) => (x === m ? { ...m, asks: [...(m.asks || []), entry] } : x)) };
}

module.exports = { WEB, answerOf, askEntry, withAsk };
