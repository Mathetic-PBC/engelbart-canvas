// What the workspace sidebar's search and the document's @ menu list (Claude Design "Canvas.dc.html" and
// "Add - Mention.dc.html", 2026-09-22). Pure: the rows come in, the lists go out; the screen does the adding.

import { kindLabel } from './kind.js';

/** Something the library could add, by its spelling alone: a web address, an arXiv or DOI id, a git remote, a path from / or ~/. The main process decides for real. */
export function looksAddable(value) {
  const v = String(value || '').trim().replace(/^["'](.*)["']$/, '$1').trim();
  if (!v || /\s/.test(v)) return false;
  return /^https?:\/\/\S+\.\S*/i.test(v) || /^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$/i.test(v) || /^(doi:\s*)?10\.\d{4,9}\/\S+$/i.test(v)
    || /^(?:ssh|git):\/\//i.test(v) || /^[\w.-]+@[\w.-]+:\S+/.test(v) || /^(~\/|\/|file:\/\/)\S/.test(v);
}

/** What a row is searched by: its name, where it is, and the words shown beside it. */
const hay = (row) => [row.name, row.url || '', row.path || '', row.folder_path || '', kindLabel(row)].join(' ').toLowerCase();

const NEW_NOTE = { kind: 'note', key: 'new:note', name: 'Note', glyph: 'note', tag: 'new' };
const NEW_WORKSPACE = { kind: 'child', key: 'new:workspace', name: 'Workspace', glyph: 'workspace', tag: 'new' };
const MAX_SEARCH = 40;

/**
 * The search field under Workspace (Canvas.dc.html `results`): it brings into this workspace what the library already
 * holds. Empty, it offers a new Note or Workspace and four things from the library that are not here yet; typed, the
 * library's matches, then Note and Workspace (named after what was typed). An address or a path is the one row the
 * library has for it (`here` when it is on the rail already) or a new one — that needs `found`, the main process's
 * answer (library.lookupItem): undefined while it is on its way.
 * Rows: { kind: 'item' | 'fresh' | 'note' | 'child', key, name, tag, row?, found? }; a tag that starts with "new" draws a +.
 */
export function searchRows({ query, library, inRail, found }) {
  const typed = String(query || '').trim();
  if (looksAddable(typed)) {
    if (!found || found.error) return [];
    if (found.row) return [{ kind: 'item', key: found.row.id, row: found.row, name: found.row.name, tag: inRail(found.row.id) ? 'here' : kindLabel(found.row) }];
    return found.found ? [{ kind: 'fresh', key: `fresh:${typed}`, found: found.found, name: found.found.name, tag: `new ${kindLabel(found.found)}` }] : [];
  }
  const needle = typed.toLowerCase();
  const pool = library.filter((row) => !inRail(row.id));
  const hits = (needle ? pool.filter((row) => hay(row).includes(needle)) : pool.filter((row) => !row.tags.includes('note') && row.type !== 'image').slice(0, 4))
    .slice(0, MAX_SEARCH)
    .map((row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: kindLabel(row) }));
  return needle ? [...hits, NEW_NOTE, NEW_WORKSPACE] : [NEW_NOTE, NEW_WORKSPACE, ...hits];
}

export const BART_VERB = { kind: 'verb', verb: 'bart', key: 'verb:bart', name: 'Bart', glyph: 'chat', token: '@Bart ' };
export const TASK_VERB = { kind: 'verb', verb: 'task', key: 'verb:task', name: 'Task', glyph: 'task', token: '@Task ' };
export const NOTE_VERB = { kind: 'verb', verb: 'note', key: 'verb:note', name: 'Note', glyph: 'note', token: '@Note ' };
const MAX_MENTIONS = 10;

/**
 * The @ menu (Add - Mention.dc.html `menu`): Bart, Task and Note first, matched from their first letter; then the page
 * open in the Browser, which the library may not hold yet (`page` { input, title }, `pageRow` its row or null); then up to
 * ten things from the library. No workspaces.
 */
export function mentionRows({ query, library, page, pageRow }) {
  const needle = String(query || '').trim().toLowerCase();
  const verbs = [BART_VERB, TASK_VERB, NOTE_VERB].filter((verb) => !needle || verb.name.toLowerCase().startsWith(needle));
  const pool = library.filter((row) => row.type !== 'image');
  let hits = (needle ? pool.filter((row) => hay(row).includes(needle)) : pool).map((row) => ({ kind: 'item', key: row.id, row, name: row.name }));
  const out = [...verbs];
  if (page && page.title && (!needle || `${page.title} ${page.input}`.toLowerCase().includes(needle))) {
    if (pageRow) { out.push({ kind: 'item', key: pageRow.id, row: pageRow, name: pageRow.name, open: true }); hits = hits.filter((hit) => hit.key !== pageRow.id); }
    else out.push({ kind: 'fresh', key: `page:${page.input}`, name: mentionName(page.title), input: page.input, open: true });
  }
  return [...out, ...hits.slice(0, MAX_MENTIONS)];
}

/** A name a mention can carry: `@[…]` ends at the first `]` and stays on one line. */
export const mentionName = (value) => String(value || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled page';
