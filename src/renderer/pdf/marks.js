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

// A highlight is a mark with rects; its note may have been moved (`pos`, MATH-27) and it is still one. A free note has none.
const isHighlight = (m) => !!(m && Array.isArray(m.rects) && m.rects.length);
// A highlight Bart answered from (its `asks`, MATH-27) is held as one with a note: it is never merged into another.
const hasNote = (m) => m.note != null || !!(Array.isArray(m.asks) && m.asks.length);
// Marks may become one when at most one `group` is among them (a selection across pages, MATH-14): one id cannot hold two.
const joins = (a, b) => !a.group || !b.group || a.group === b.group;

/**
 * Where a new selection highlight `mark` (page units, with its id) goes among a page's marks `list`, compared by
 * merged boxes (same line and any horizontal overlap); free notes are never touched. → { list, mark }: the page's
 * marks after, and the mark that holds the selection now.
 * - Inside one existing highlight: nothing is added. A note being started goes on it when it has none, and so does the
 *   mark's `group` (part of a selection across pages) when it has none.
 * - Overlapping highlights, none with a note and none being started: one mark replaces them, keeping the earliest's
 *   id and place: the boxes of them all, the smallest y, the side of the merged boxes, the new text when it covers
 *   the others, else their texts in reading order, and the one group among them, if any.
 * - Otherwise (no overlap, a note anywhere, or two different groups): the mark is added beside them. Drawing merges the
 *   boxes anyway.
 * Marks saved without a group are placed as they always were.
 */
export function placeHighlight(list, mark) {
  const marks = list || [];
  const boxes = mergeLineRects(mark.rects);
  if (!boxes.length) return { list: [...marks, mark], mark };
  const hits = marks.filter((m) => isHighlight(m) && mergeLineRects(m.rects).some((b) => boxes.some((a) => boxesOverlap(a, b))));
  const host = hits.find((m) => boxesInside(boxes, mergeLineRects(m.rects)) && joins(m, mark));
  if (host) {
    const note = mark.note != null && host.note == null ? mark.note : host.note;
    const group = host.group || mark.group;
    if (note === host.note && group === host.group) return { list: marks, mark: host };
    const next = { ...host, note, ...(group ? { group } : {}) };
    return { list: marks.map((m) => (m === host ? next : m)), mark: next };
  }
  const groups = new Set([...hits, mark].map((m) => m.group).filter(Boolean));
  if (!hits.length || hasNote(mark) || hits.some(hasNote) || groups.size > 1) return { list: [...marks, mark], mark };
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
    ...(groups.size ? { group: [...groups][0] } : {}),
  };
  const out = [];
  for (const m of marks) if (m === earliest) out.push(next); else if (!hits.includes(m)) out.push(m);
  return { list: out, mark: next };
}

/* ------------------------------------------------------------------ a selection across pages (MATH-14, 2026-10-05) */
// PaperView cuts a selection into one range a page (each text layer it touches) and measures each; these are the parts
// that need no DOM.

/**
 * A selection's pieces, one a page ({ page, rects, width, text, u }: rects in layout px relative to that page's text
 * layer, `width` the layer's width in the same px, `u` the page's drawn width) → its parts in page order: the rects
 * merged into one box per stretch of a line, the side a note goes on, the top. A piece with no usable rects is dropped.
 */
export function selectionParts(pieces) {
  const out = [];
  for (const { page, rects, width, text, u } of pieces || []) {
    const boxes = mergeLineRects(rects);
    if (boxes.length) out.push({ page, rects: boxes, side: sideOf(boxes, width), y: Math.min(...boxes.map(top)), text, u });
  }
  return out.sort((a, b) => a.page - b.page);
}

/** A part drawn at another size: its geometry (px of a page `from` wide) scaled to a page `to` wide, which becomes its `u`. */
export function scalePart(part, from, to) {
  const k = to / (from || to);
  return { ...part, rects: part.rects.map((r) => ({ x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k })), y: part.y * k, u: to };
}

/**
 * The marks a selection's parts make, one a part, in page units (each part's px over `widthOf(page)`, its page's drawn
 * width now). Ids come from `newId(prefix)`; when there is more than one part they share one `group` id (`newId('g')`)
 * and only the first has the note, the others none (null). → [{ page, mark }] in the parts' order.
 */
export function partMarks(parts, note, newId, widthOf) {
  const list = (parts || []).filter((p) => p && Array.isArray(p.rects) && p.rects.length);
  const group = list.length > 1 ? newId('g') : null;
  return list.map((p, i) => {
    const u = widthOf(p.page) || 1;
    const mark = {
      id: newId('m'),
      rects: p.rects.map((r) => ({ x: r.x / u, y: r.y / u, w: r.w / u, h: r.h / u })),
      side: p.side, y: p.y / u, note: i === 0 ? note : null, text: p.text, pos: null,
    };
    return { page: p.page, mark: group ? { ...mark, group } : mark };
  });
}
