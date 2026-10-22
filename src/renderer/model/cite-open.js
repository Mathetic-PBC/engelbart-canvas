// Where a citation of the person's own thinking opens (2026-10-21): a workspace's document or a note is opened in the
// pane beside the document in front (model/panes.js), or, when it is the one in front, that document is scrolled, with
// the passage it quotes lit up there. Everything else a citation names (a paper, a page, a file of a library folder)
// opens in the Stage as any `#find=` link does. Pure: Workspace.jsx opens the pane and DocEditor lights the words.

import { splitTarget } from '../../shared/passage-link.cjs';
import { matchPassage } from '../../shared/passage-text.cjs';

const trimSlash = (dir) => String(dir || '').replace(/\/+$/, '');
// A workspace's answer lines: an answer, a folded one, an old draft (as main's bart/cite.cjs reads them).
const ANSWER_LINE_RE = /^bart[+?]?> ?/;

/** A workspace's document by where it is on disk: `<project dir>/<its folders, from the top>/workspace.md`. */
function workspaceFile(projectDir, index, id) {
  const folders = [];
  for (let at = index.get(id); at; at = at.parent ? index.get(at.parent.id) : null) {
    if (!at.node.folder) return null;
    folders.unshift(at.node.folder);
  }
  return `${trimSlash(projectDir)}/${folders.join('/')}/workspace.md`;
}

/**
 * The document a citation at `href` quotes, when it is one the middle column shows → { kind: 'workspace' | 'note', id,
 * name, find, cite } or null. `projectDir`: the project's folder; `index`: its workspaces by id, each { node, parent }
 * (`node.folder` the workspace's folder's name); `notes`: the project's notes (library rows, each with its `path`).
 */
export function citedDoc(href, { projectDir, index, notes } = {}) {
  const target = splitTarget(href);
  if (!target.cite || !target.find || !String(target.address).startsWith('/')) return null;
  const address = target.address;
  if (address.endsWith('/workspace.md') && projectDir && index) {
    for (const [id, at] of index) {
      if (workspaceFile(projectDir, index, id) === address) return { kind: 'workspace', id, name: at.node.name, find: target.find, cite: target.cite };
    }
    return null;
  }
  const note = (notes || []).find((row) => row && row.path && row.path === address);
  return note ? { kind: 'note', id: note.id, name: note.name, find: target.find, cite: target.cite } : null;
}

/**
 * The line of `lines` (a document's, as its editor holds them) where the quoted words start, or -1. Found as main found
 * them (shared/passage-text.cjs), line prefixes and marks let go. Where the words are more than once, the person's own
 * line goes first for their words (`cite` 'you'), an answer line for anyone else's.
 */
export function passageLine(lines, find, cite = 'you') {
  const list = Array.isArray(lines) ? lines : [];
  const text = list.join('\n');
  const hits = matchPassage(text, find, { prefixes: true, markdown: true });
  if (!hits.length) return -1;
  const starts = [];
  for (let i = 0, at = 0; i < list.length; i += 1) { starts.push(at); at += list[i].length + 1; }
  const lineOf = (offset) => { let i = starts.length - 1; while (i > 0 && starts[i] > offset) i -= 1; return i; };
  const at = hits.map((hit) => lineOf(hit.start));
  const answer = (i) => ANSWER_LINE_RE.test(list[i] || '');
  const preferred = at.find((i) => (cite === 'you' ? !answer(i) : answer(i)));
  return preferred == null ? at[0] : preferred;
}
