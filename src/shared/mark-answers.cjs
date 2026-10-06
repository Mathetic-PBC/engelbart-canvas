'use strict';
// An answer Bart gave from a note on a pdf's highlight (MATH-27), as the mark keeps it in the pdf's ink. Shared since the
// second-pass fixes (2026-10-06): the Stage puts a finished answer on its mark (src/renderer/pdf/canvas.js re-exports
// these), and so does main itself (src/main/store/library.cjs addMarkAnswer), so an answer still lands when the window
// that asked was reloaded meanwhile.

const ATTRIBUTION = /^\*([^*]+)\*$/;

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

/** A finished answer as a mark keeps it: { id, question, answer, meta, at, pos, collapsed }. */
function askEntry({ id, question, lines, meta, at }) {
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
  };
}

/** The marks with `entry` added to the answers of mark `markId` on `page` (once). Unchanged when the mark is gone or has it. */
function withAsk(marks, page, markId, entry) {
  const list = (marks || {})[page];
  const m = Array.isArray(list) ? list.find((x) => x && x.id === markId) : null;
  if (!m || (m.asks || []).some((a) => a && a.id === entry.id)) return marks || {};
  return { ...marks, [page]: list.map((x) => (x === m ? { ...m, asks: [...(m.asks || []), entry] } : x)) };
}

module.exports = { answerOf, askEntry, withAsk };
