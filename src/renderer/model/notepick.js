// What the + beside the document's tabs lists (2026-09-25): "the plus button on middle canvas should allow me to search
// for a note to open (it does not necessarily have to be linked to current workspace) or to create a new note — it should
// not automatically create a new note." Pure: the library comes in, the rows go out; the screen opens or makes the note.

import { isNote } from './kind.js';

export const NOTE_PICK_RECENT = 8; // notes shown before anything is typed

const when = (row) => Date.parse(row.last_edited || row.created || '') || 0;

/**
 * Rows: { kind: 'new', key, name } makes a note (named `name`, or the next Untitled one when it is empty); { kind: 'note',
 * key, row, name, tag } opens one. Empty, New note comes first and then the notes written in last. Typed, every note of
 * the whole library whose name holds all the words, the ones that start with what was typed first, then New note named
 * what was typed. `tag` is 'open' for a note already in a tab, 'here' for one in this workspace, else ''.
 */
export function notePickRows({ query, library, openIds = [], inRail = () => false }) {
  const typed = String(query || '').trim();
  const needle = typed.toLowerCase();
  const words = needle.split(/\s+/).filter(Boolean);
  const notes = library.filter(isNote);
  const hits = words.length ? notes.filter((row) => words.every((word) => String(row.name).toLowerCase().includes(word))) : notes;
  const starts = (row) => (words.length && String(row.name).toLowerCase().startsWith(needle) ? 0 : 1);
  const sorted = [...hits].sort((a, b) => starts(a) - starts(b) || when(b) - when(a));
  const open = new Set(openIds);
  const found = (words.length ? sorted : sorted.slice(0, NOTE_PICK_RECENT))
    .map((row) => ({ kind: 'note', key: row.id, row, name: row.name, tag: open.has(row.id) ? 'open' : inRail(row.id) ? 'here' : '' }));
  const make = { kind: 'new', key: 'new', name: typed };
  return words.length ? [...found, make] : [make, ...found];
}
