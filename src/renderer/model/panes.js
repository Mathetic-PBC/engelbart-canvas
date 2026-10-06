// The notes open to the right of the document (MATH-23), in the manner of Andy Matuschak's working notes: a note mention
// clicked in a pane opens its note in the pane after it, and every pane that stood further right goes. Pure: Workspace.jsx
// keeps the list and draws it.
//
// Panes are counted as they stand in the strip: pane 0 is the document in front (the tab), which this list never holds;
// pane i, for i ≥ 1, is the list's [i - 1]. A pane is { id, title, link }: the note's library id and name, and `link`, the
// mention's text clicked to open it, which stays marked in the pane before it.

/** The most note panes beside the document; opening one more lets the oldest go. */
export const MAX_PANES = 4;

/**
 * `note` ({ id, title }) opened from a mention (`link`) clicked in pane `fromIndex` (0: the document). Every pane after
 * `fromIndex` goes and the note comes after it, unless the note is already the pane right after it: then only that pane's
 * `link` changes, and the panes after it stay. Past MAX_PANES the oldest note pane goes.
 * → a new list, or `panes` itself when nothing changed
 */
export function openBeside(panes, fromIndex, note, link) {
  const list = Array.isArray(panes) ? panes : [];
  if (!note || !note.id) return list;
  const from = Math.max(0, Math.min(Number(fromIndex) || 0, list.length));
  const after = list[from];
  const shown = link == null ? '' : String(link);
  if (after && after.id === note.id) {
    if (after.link === shown) return list;
    return list.map((pane, i) => (i === from ? { ...pane, link: shown } : pane));
  }
  const next = [...list.slice(0, from), { id: note.id, title: note.title == null ? '' : String(note.title), link: shown }];
  return next.length > MAX_PANES ? next.slice(next.length - MAX_PANES) : next;
}

/**
 * Pane `index` closed (its ×), and every pane after it with it. The document (pane 0) does not close.
 * → a new list, or `panes` itself when nothing changed
 */
export function closePane(panes, index) {
  const list = Array.isArray(panes) ? panes : [];
  const at = Number(index);
  if (!Number.isInteger(at) || at < 1 || at > list.length) return list;
  return list.slice(0, at - 1);
}
