// The panes beside the document (MATH-23), in the manner of Andy Matuschak's working notes: a note's or a workspace's
// mention clicked opens its document in a pane to the right of the document in front. Pure: Workspace.jsx keeps the list
// and draws it.
//
// As many panes as the middle column fits (MATH-103, 2026-10-25): pane 0 is the document in front (the tab), which this
// list never holds, and panes 1… are the list's entries, left to right, each at least PANE_MIN wide. A mention clicked
// in any pane opens its document in a new pane at the right while there is room, and in place of the rightmost pane in
// sight once there is none; one already open is not opened a second time (two editors on one document undid each other's
// typing with ⌘Z): its pane is shown instead. Panes the column is too narrow for are kept, out of sight, and come back
// when it widens. A pane is { kind, id, title, link, from }: 'note' and the note's library id, or 'workspace' and the
// workspace's id; its name; `link`, the mention's text clicked to open it, which stays marked in the pane it was clicked
// in; and `from`, that pane's document key (Workspace.jsx docOf: `ws:<id>`, `note:<id>`…).

/** px: the narrowest a pane of the middle column gets; the column's own least width (Workspace.jsx DOC_MIN) is the same. */
export const PANE_MIN = 280;

/** How many panes a middle column `width` px wide fits side by side, the document in front among them: at least 1. */
export function paneRoom(width) {
  const w = Number(width);
  return Number.isFinite(w) && w > 0 ? Math.max(1, Math.floor(w / PANE_MIN)) : 1;
}

/**
 * How many of `count` panes beside the document are in sight when the column fits `room`: the rest wait at the right.
 * A document opened beside always shows, so a column too narrow for two still shows one beside the document.
 */
export const besideShown = (room, count) => Math.max(0, Math.min(Math.max(0, count | 0), slotsOf(room)));
const slotsOf = (room) => { const r = Math.floor(Number(room)); return Number.isNaN(r) ? 1 : Math.max(1, r - 1); };

/** Whether another pane fits beside the ones in sight (the split icon): the column has room for one more. */
export const roomForAnother = (room, count) => Math.max(0, count | 0) < Math.floor(Number(room) || 1) - 1;

/** What a document is, for telling two apart: { kind: 'note' | 'workspace', id }. */
const kindOf = (item) => (item && item.kind === 'workspace' ? 'workspace' : 'note');
export const sameDoc = (a, b) => !!a && !!b && !!a.id && a.id === b.id && kindOf(a) === kindOf(b);
const text = (value) => (value == null ? '' : String(value));

/**
 * `item` ({ kind, id, title }) opened from a mention (`link`) clicked in the pane whose document is `from`, with the column
 * fitting `room` panes (paneRoom; 2 when not given). `front` is what the document in front shows ({ kind, id }; null for
 * neither, an archived version).
 * → { panes, at }: the list after it (`panes` itself when nothing changed) and the pane that shows the item: 0 when it is
 * the document in front (the panes beside stay as they were), 1… when it is beside, null when there is nothing to open.
 * One already in sight beside takes the new link; one kept out of sight leaves its place for the new one.
 */
export function openBeside(panes, front, item, link, room = 2, from = '') {
  const list = Array.isArray(panes) ? panes : [];
  if (!item || !item.id) return { panes: list, at: null };
  if (sameDoc(front, item)) return { panes: list, at: 0 };
  const shown = text(link), source = text(from);
  const slots = slotsOf(room);
  const held = list.findIndex((pane) => sameDoc(pane, item));
  if (held >= 0 && held < slots) {
    const now = list[held];
    if (now.link === shown && text(now.from) === source) return { panes: list, at: held + 1 };
    const out = list.slice();
    out[held] = { ...now, link: shown, from: source };
    return { panes: out, at: held + 1 };
  }
  const kept = held >= 0 ? list.filter((_, i) => i !== held) : list;
  const fresh = held >= 0 ? { ...list[held], link: shown, from: source } : { kind: kindOf(item), id: item.id, title: text(item.title), link: shown, from: source };
  if (kept.length < slots) return { panes: [...kept, fresh], at: kept.length + 1 };
  const out = kept.slice();
  out[slots - 1] = fresh; // the rightmost in sight; those out of sight stay behind it
  return { panes: out, at: slots };
}

/**
 * Pane `index` closed (its ×), and only that one: the panes after it move left. The document (pane 0) does not close.
 * → a new list, or `panes` itself when nothing changed
 */
export function closePane(panes, index) {
  const list = Array.isArray(panes) ? panes : [];
  const at = Number(index);
  if (!Number.isInteger(at) || at < 1 || at > list.length) return list;
  return list.filter((_, i) => i !== at - 1);
}

/**
 * A tab's panes as they were kept (state.json `views`, across launches), less the documents that are gone and any one
 * twice. `nameOf(pane)` is the document's name now, or null when it no longer exists; each pane takes it.
 * → a new list, or `panes` itself when nothing changed
 */
export function restorePanes(panes, nameOf) {
  const list = Array.isArray(panes) ? panes : [];
  const out = [];
  let changed = false;
  for (const pane of list) {
    const name = pane && pane.id && !out.some((held) => sameDoc(held, pane)) ? nameOf(pane) : null;
    if (name == null) { changed = true; continue; }
    const title = text(name);
    if (title !== text(pane.title)) { changed = true; out.push({ ...pane, title }); } else out.push(pane);
  }
  return changed ? out : list;
}
