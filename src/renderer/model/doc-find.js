// Find in the middle canvas's document (⌘F, 2026-10-16), its pure part: where a query matches the text as it is drawn.
// The editor's text nodes come in as segments, in page order, each with the block it sits in (a line, a paragraph of an
// answer): a match may run across the nodes of one block (a bold word inside a sentence) but never from one block into
// the next. Case is ignored, as the Stage's find ignores it. workspace/DocFind.jsx walks the page, makes the ranges and
// paints them with CSS Custom Highlights; the editor's DOM is never changed.

// A segment lowercased, unless that changes its length (a few letters lowercase to two), which would put every offset
// after it off: that segment is then matched as it is.
const folded = (text) => { const low = text.toLowerCase(); return low.length === text.length ? low : text; };

/**
 * The matches of `query` in `segments` ([{ text, block }]; consecutive segments with the same `block` are one block).
 * → [{ start: { seg, offset }, end: { seg, offset } }], in page order; none for an empty or blank query. An end sits in
 * the segment its last character is in (offset up to that segment's length), never at the start of the next.
 */
export function segmentMatches(segments, query) {
  const list = Array.isArray(segments) ? segments : [];
  const needle = folded(String(query == null ? '' : query));
  if (!needle.trim()) return [];
  const out = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    const starts = [];
    let hay = '';
    while (j < list.length && list[j].block === list[i].block) { starts.push(hay.length); hay += folded(String(list[j].text || '')); j += 1; }
    const at = (pos, end) => {
      // The segment holding character `pos` (a start) or ending at `pos` (an end); empty segments hold nothing.
      for (let k = 0; k < starts.length; k += 1) {
        const from = starts[k], to = from + String(list[i + k].text || '').length;
        if (from === to) continue;
        if (end ? pos > from && pos <= to : pos >= from && pos < to) return { seg: i + k, offset: pos - from };
      }
      return null;
    };
    for (let hit = hay.indexOf(needle); hit >= 0; hit = hay.indexOf(needle, hit + needle.length)) {
      const start = at(hit, false), end = at(hit + needle.length, true);
      if (start && end) out.push({ start, end });
    }
    i = j;
  }
  return out;
}
