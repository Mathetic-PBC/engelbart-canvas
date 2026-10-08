// New topics and notes start as "Untitled Workspace n" / "Untitled Note n". That name is what
// lands on disk, but the UI treats it as a hint: grey, and the title field stays empty so typing
// replaces it.

const UNTITLED_RE = /^Untitled (?:Workspace|Note) \d+$/;

export const isUntitled = (name) => UNTITLED_RE.test(String(name || ''));

/**
 * A title as it is typed (workspace/DocPane.jsx): a title is a file name, so slashes become hyphens; and it is one line
 * that wraps, so a line break (pasted, say) becomes a space.
 */
export const titleTyped = (value) => String(value || '').replace(/[/\\]/g, '-').replace(/\r?\n|\r/g, ' ');

/** The first free "Untitled <kind> n" among `names`. */
export function nextUntitled(kind, names) {
  const taken = new Set((names || []).map((name) => String(name)));
  let n = 1;
  while (taken.has(`Untitled ${kind} ${n}`)) n += 1;
  return `Untitled ${kind} ${n}`;
}

/**
 * A workspace's name where "Workspace" stood (MATH-20, 2026-10-06): no longer than that word, nine characters; a longer
 * name shows its first eight and an ellipsis. Spaces at the cut are dropped. No name reads "Workspace".
 */
export function wsLabel(name, max = 'Workspace'.length) {
  const s = String(name || '').replace(/\s+/g, ' ').trim();
  if (!s) return 'Workspace';
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join('').trimEnd()}\u2026`;
}
