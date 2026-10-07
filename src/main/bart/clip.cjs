'use strict';
// Text too long for where it goes, cut in the middle (MATH-27 second pass, 2026-10-06): a passage highlighted across many
// pages, or an earlier answer past what a turn may hold, is asked about with its start and its end and a line saying how
// much was left out between them, rather than refused.

/** The line that stands where `n` characters were cut. */
const cutLine = (n) => `\n[… ${n.toLocaleString('en-US')} characters cut …]\n`;

/** `text` as it is when it fits in `max` characters, else its start and end around cutLine, `max` long at most. */
function clipMiddle(text, max) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const room = max - cutLine(s.length).length; // the line for the most that could be cut is the longest it gets
  if (room <= 0) return s.slice(0, max);
  let head = Math.ceil(room / 2), tail = room - head;
  if (/[\ud800-\udbff]/.test(s.charAt(head - 1))) head -= 1; // no half of a character on either side of the cut
  if (tail && /[\udc00-\udfff]/.test(s.charAt(s.length - tail))) tail -= 1;
  return s.slice(0, head) + cutLine(s.length - head - tail) + (tail ? s.slice(s.length - tail) : '');
}

module.exports = { clipMiddle, cutLine };
