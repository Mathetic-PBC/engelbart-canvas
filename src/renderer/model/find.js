// Find in a pdf (PaperView), its pure parts (2026-09-30): where a search lands, and a link's passage applied once the
// pages are drawn. PaperView keeps the ranges and paints them; this only decides.

/**
 * Which match is in front after a search, and whether to scroll to it. `fresh`: a new query; `step` 0 starts a search
 * (or re-runs one after a re-layout), 1 / -1 step, wrapping; `at` the match in front before (-1 none); `fromStart`: a
 * link's passage, counted from page 1 rather than from what is in view; `firstInView()` the first match in view or below.
 * → { at, scroll }. Nothing matched: no match in front, and nothing scrolls.
 */
export function nextFind({ fresh, step = 0, count, at, fromStart = false, firstInView = () => 0 }) {
  if (!count) return { at: -1, scroll: false };
  let next;
  if (fromStart) next = 0;
  else if (fresh || at < 0) next = step < 0 ? count - 1 : firstInView();
  else if (step) next = (at + step + count) % count;
  else next = Math.min(at, count - 1); // re-laid-out: same place, as near as the count allows
  return { at: next, scroll: fresh || step !== 0 || fromStart };
}

/**
 * A link's passage waiting for the pages to be drawn (PaperView's `target`): `set(text)` when the prop changes,
 * `drawing()` when a layout starts, `drawn()` when one has drawn every page. `set` and `drawn` answer the text to find
 * now, or null: each passage is found once, after drawing, until the target is cleared and given again.
 */
export function createTargetGate() {
  let target = '', done = '', ready = false;
  const take = () => { if (!ready || !target || target === done) return null; done = target; return target; };
  return {
    set(next) { target = String(next || ''); if (!target) done = ''; return take(); },
    drawing() { ready = false; },
    drawn() { ready = true; return take(); },
  };
}

// A link's section (2026-09-30, @discover round 2: `#find=<start words>&to=<end words>`): from the start words to just
// before the first sentence of the next section, tinted under find's colours. Its parts that do not need a page. Since
// 2026-10-03 the section is find's no longer: it stays while find searches and stops, until another is shown or it is cleared.
export const FIND = 'pdf-find', FIND_ACTIVE = 'pdf-find-active', SECTION = 'pdf-section';
export const SECTION_PAGES = 6;

/**
 * The stretch a section covers, page by page. `start` { page, from, to }: the start words, offsets in their page's text;
 * `ends`: every match of the `to` words { page, from }, in page order. → [{ page, from, to }], `to` null for the end of
 * the page (`from` 0 is its top); the `to` words themselves are left out. null when `to` matches nowhere after the start,
 * or only more than SECTION_PAGES pages on: then the start words alone are shown.
 */
export function sectionSpans(start, ends) {
  if (!start) return null;
  const end = (ends || []).find((e) => e.page > start.page || (e.page === start.page && e.from >= start.to));
  if (!end || end.page - start.page > SECTION_PAGES) return null;
  if (end.page === start.page) return [{ page: start.page, from: start.from, to: end.from }];
  const spans = [{ page: start.page, from: start.from, to: null }];
  for (let page = start.page + 1; page < end.page; page += 1) spans.push({ page, from: 0, to: null });
  spans.push({ page: end.page, from: 0, to: end.from });
  return spans;
}

/** The section painted (`registry` CSS.highlights, `Make` the Highlight constructor): below find's matches and its match in front. */
export function paintSection(registry, ranges, Make) {
  if (!registry) return;
  if (!ranges || !ranges.length) { registry.delete(SECTION); return; }
  const tint = new Make(...ranges);
  tint.priority = -1;
  registry.set(SECTION, tint);
}

/** Find stopped: its matches and its match in front go; a link's section stays (2026-10-03). Nothing of it was ever ink. */
export function clearFind(registry) {
  if (registry) for (const name of [FIND, FIND_ACTIVE]) registry.delete(name);
}
