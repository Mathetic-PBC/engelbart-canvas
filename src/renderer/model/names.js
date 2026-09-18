// New topics and notes start as "Untitled Workspace n" / "Untitled Note n". That name is what
// lands on disk, but the UI treats it as a hint: grey, and the title field stays empty so typing
// replaces it.

const UNTITLED_RE = /^Untitled (?:Workspace|Note) \d+$/;

export const isUntitled = (name) => UNTITLED_RE.test(String(name || ''));

/** The first free "Untitled <kind> n" among `names`. */
export function nextUntitled(kind, names) {
  const taken = new Set((names || []).map((name) => String(name)));
  let n = 1;
  while (taken.has(`Untitled ${kind} ${n}`)) n += 1;
  return `Untitled ${kind} ${n}`;
}
