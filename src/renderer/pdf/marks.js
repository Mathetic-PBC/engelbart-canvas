// Paper highlights, their pure parts (2026-10-02): one box per stretch of a line, and where a new highlight goes among
// a page's marks. A selection's client rects come in doubled (a fully selected pdf.js span gives its own box and its
// text's, which differ under --scale-x) and overlapping (neighbouring spans), so PaperView draws merged boxes only.
// Rects are { x, y, w, h } in any one unit (layout px or page units); every threshold is relative to a line's height.

const LINE = 0.5; // same line: vertical overlap of at least half the smaller height
const GAP = 0.6; // within a line, a gap under 0.6 × the line's height is joined; a wider one (a column gutter) is not
const SLACK = 0.2; // "inside" allows this share of a line's height at either end (rounding between zooms)
const SIDE = 0.45; // a selection centered left of 45% of the page has its note on the left

const top = (r) => r.y;
const bottom = (r) => r.y + r.h;
const vOverlap = (a, b) => Math.min(bottom(a), bottom(b)) - Math.max(top(a), top(b));

/** Two rects on the same line: their vertical overlap is at least half the smaller height. */
export const sameLine = (a, b) => vOverlap(a, b) >= LINE * Math.min(a.h, b.h);

/** Same line and some horizontal overlap. */
export const boxesOverlap = (a, b) => sameLine(a, b) && Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);

const usable = (r) => r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w > 0 && r.h > 0;
const union = (list) => {
  const x = Math.min(...list.map((r) => r.x)), y = Math.min(...list.map(top));
  return { x, y, w: Math.max(...list.map((r) => r.x + r.w)) - x, h: Math.max(...list.map(bottom)) - y };
};

/**
 * Rects merged into one box per stretch of a line: rects are grouped into lines (sameLine with the line so far), and
 * within a line joined left to right where they overlap or the gap is under 0.6 × the line's height. Each box spans
 * its members. → boxes top to bottom, then left to right. Empty or unusable rects are dropped.
 */
export function mergeLineRects(rects) {
  const lines = [];
  for (const r of [...(rects || [])].filter(usable).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const line = lines.find((l) => sameLine(l.band, r));
    if (line) { line.members.push(r); line.band = union([line.band, r]); } else lines.push({ band: { ...r }, members: [r] });
  }
  lines.sort((a, b) => a.band.y - b.band.y);
  const out = [];
  for (const { band, members } of lines) {
    let box = null;
    for (const r of members.sort((a, b) => a.x - b.x)) {
      if (box && r.x - (box.x + box.w) < GAP * band.h) box = union([box, r]);
      else { if (box) out.push(box); box = { x: r.x, y: r.y, w: r.w, h: r.h }; }
    }
    if (box) out.push(box);
  }
  return out;
}

/** Each of `inner` lies inside one of `outer`: on its line, and within it give or take SLACK of the line's height. */
export function boxesInside(inner, outer) {
  return inner.length > 0 && inner.every((a) => outer.some((b) => {
    const slack = SLACK * Math.min(a.h, b.h);
    return sameLine(a, b) && a.x >= b.x - slack && a.x + a.w <= b.x + b.w + slack;
  }));
}

/** 'left' or 'right': the side a note goes on, from the boxes' mean center over a page `width` wide. */
export function sideOf(boxes, width = 1) {
  if (!boxes.length) return 'right';
  const cx = boxes.reduce((a, r) => a + r.x + r.w / 2, 0) / boxes.length;
  return cx / width < SIDE ? 'left' : 'right';
}

/** A rough.js seed (never 0, which rough.js takes as "random") fixed by a box's place on its page, in page units. */
export function boxSeed(page, box) {
  const h = (Number(page) || 0) * 7919 + Math.round(box.y * 1000) * 131 + Math.round(box.x * 1000);
  return 1 + (Math.abs(h) % 2147483646);
}

// Two texts in reading order as one: where the end of `a` is the start of `b` (two overlapping highlights), it is
// written once.
const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function joinText(a, b) {
  if (!a) return b;
  if (!b || a.includes(b)) return a;
  if (b.includes(a)) return b;
  for (let k = Math.min(a.length, b.length) - 1; k >= 3; k -= 1) if (a.endsWith(b.slice(0, k))) return a + b.slice(k);
  return `${a} ${b}`;
}

const isHighlight = (m) => !!(m && !m.pos && Array.isArray(m.rects) && m.rects.length);
const hasNote = (m) => m.note != null;

/**
 * Where a new selection highlight `mark` (page units, with its id) goes among a page's marks `list`, compared by
 * merged boxes (same line and any horizontal overlap); free notes are never touched. → { list, mark }: the page's
 * marks after, and the mark that holds the selection now.
 * - Inside one existing highlight: nothing is added. A note being started goes on it when it has none.
 * - Overlapping highlights, none with a note and none being started: one mark replaces them, keeping the earliest's
 *   id and place: the boxes of them all, the smallest y, the side of the merged boxes, the new text when it covers
 *   the others, else their texts in reading order.
 * - Otherwise (no overlap, or a note anywhere): the mark is added beside them. Drawing merges the boxes anyway.
 */
export function placeHighlight(list, mark) {
  const marks = list || [];
  const boxes = mergeLineRects(mark.rects);
  if (!boxes.length) return { list: [...marks, mark], mark };
  const hits = marks.filter((m) => isHighlight(m) && mergeLineRects(m.rects).some((b) => boxes.some((a) => boxesOverlap(a, b))));
  const host = hits.find((m) => boxesInside(boxes, mergeLineRects(m.rects)));
  if (host) {
    if (mark.note == null || hasNote(host)) return { list: marks, mark: host };
    const next = { ...host, note: mark.note };
    return { list: marks.map((m) => (m === host ? next : m)), mark: next };
  }
  if (!hits.length || hasNote(mark) || hits.some(hasNote)) return { list: [...marks, mark], mark };
  const merged = mergeLineRects([...hits.flatMap((m) => m.rects), ...mark.rects]);
  const covers = hits.every((m) => boxesInside(mergeLineRects(m.rects), boxes));
  const reading = [...hits, mark].map((m) => ({ m, b: mergeLineRects(m.rects)[0] }))
    .sort((p, q) => (sameLine(p.b, q.b) ? p.b.x - q.b.x : p.b.y - q.b.y)).map((p) => p.m);
  const earliest = hits[0];
  const next = {
    ...earliest,
    rects: merged,
    side: sideOf(merged),
    y: Math.min(mark.y, ...hits.map((m) => m.y)),
    text: covers ? mark.text : squash(reading.reduce((t, m) => joinText(t, squash(m.text)), '')),
  };
  const out = [];
  for (const m of marks) if (m === earliest) out.push(next); else if (!hits.includes(m)) out.push(m);
  return { list: out, mark: next };
}
