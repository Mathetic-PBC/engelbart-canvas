// The same document open in several windows (2026-10-03). Main gives every save that changes a document a revision,
// counting up, and announces it to the other windows (doc:changed { key, text, revision }); the window that saved gets
// its revision back. A window keeps, per document key, the newest revision it saved or took, so an announcement from
// before its own save is never taken over it.
//
// An announcement newer than that is decided once this window's own saves of the document have answered ('wait': which
// came first is only known then). Then, with no edit of its own waiting to be saved, the window takes the text ('take');
// with one, its edits are kept and the person is asked ('conflict': Keep mine or Take theirs, Workspace.jsx).
//
// `hasEdits(key)`: an edit not yet saved; `take(key, text)`: show the announced text; `conflict(key, change)`: ask.

export function createDocSync({ hasEdits, take, conflict }) {
  const revisions = new Map(); // key → the newest revision saved here or taken
  const writing = new Map(); // key → saves on their way
  const incoming = new Map(); // key → the newest announcement that arrived while one was

  const revision = (key) => revisions.get(key) || 0;

  function seen(key, value) {
    if (Number.isFinite(value) && value > revision(key)) revisions.set(key, value);
  }

  /** Another window saved `change` ({ text, revision }). → 'ignore' | 'wait' | 'conflict' | 'take' */
  function announced(key, change) {
    if (!change || typeof change.text !== 'string' || !(change.revision > revision(key))) return 'ignore';
    if (writing.get(key)) {
      const held = incoming.get(key);
      if (!held || change.revision > held.revision) incoming.set(key, change);
      return 'wait';
    }
    if (hasEdits(key)) { conflict(key, change); return 'conflict'; }
    seen(key, change.revision);
    take(key, change.text);
    return 'take';
  }

  function saving(key) {
    writing.set(key, (writing.get(key) || 0) + 1);
  }

  /** A save of this window's answered (`value`: its revision; none when it failed). */
  function saved(key, value) {
    seen(key, value);
    const left = (writing.get(key) || 1) - 1;
    if (left > 0) { writing.set(key, left); return null; }
    writing.delete(key);
    const change = incoming.get(key);
    incoming.delete(key);
    return change ? announced(key, change) : null;
  }

  return { announced, saving, saved, seen, revision };
}
