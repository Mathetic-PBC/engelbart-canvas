// The pane beside the document (MATH-23), in the manner of Andy Matuschak's working notes: a note's or a workspace's
// mention clicked opens its document in a pane to the right of the document in front. Pure: Workspace.jsx keeps the list
// and draws it.
//
// Two panes at most (2026-10-05): pane 0 is the document in front (the tab), which this list never holds, and pane 1 is
// the list's one entry. A mention clicked in either pane puts its document in pane 1, in place of what was there; one
// already in front is not opened a second time (two editors on one document undid each other's typing with ⌘Z).
// A pane is { kind, id, title, link }: 'note' and the note's library id, or 'workspace' and the workspace's id; its name;
// and `link`, the mention's text clicked to open it, which stays marked in the document in front.

/** What a document is, for telling two apart: { kind: 'note' | 'workspace', id }. */
const kindOf = (item) => (item && item.kind === 'workspace' ? 'workspace' : 'note');
export const sameDoc = (a, b) => !!a && !!b && !!a.id && a.id === b.id && kindOf(a) === kindOf(b);

/**
 * `item` ({ kind, id, title }) opened from a mention (`link`) clicked in either pane. `front` is what the document in front
 * shows ({ kind, id }; null for neither, an archived version).
 * → { panes, at }: the list after it (`panes` itself when nothing changed) and the pane that shows the item: 0 when it is
 * the document in front (the pane beside stays as it was), 1 when it is beside, null when there is nothing to open.
 */
export function openBeside(panes, front, item, link) {
  const list = Array.isArray(panes) ? panes : [];
  if (!item || !item.id) return { panes: list, at: null };
  if (sameDoc(front, item)) return { panes: list, at: 0 };
  const shown = link == null ? '' : String(link);
  const now = list[0];
  if (sameDoc(now, item)) return { panes: now.link === shown ? list : [{ ...now, link: shown }], at: 1 };
  return { panes: [{ kind: kindOf(item), id: item.id, title: item.title == null ? '' : String(item.title), link: shown }], at: 1 };
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
