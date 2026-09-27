// What the workspace sidebar's search and the document's @ menu list (Claude Design "Canvas.dc.html" and
// "Add - Mention.dc.html", 2026-09-22). Pure: the rows come in, the lists go out; the screen does the adding.

import { hasTag, isNote, kindLabel } from './kind.js';
import { findWorkspaces } from './nav.js';

/**
 * The sidebar's sections, in order (Claude Design "Sidebar.dc.html", 2026-09-23): Notes, Websites, GitHub, Files and
 * Sub-Workspaces. Files is everything else (papers, folders, pages on disk, data, images: "files should be de facto other").
 */
export const RAIL_SECTIONS = [
  { key: 'Notes', label: 'Notes' },
  { key: 'Websites', label: 'Websites' },
  { key: 'GitHub', label: 'GitHub' },
  { key: 'Files', label: 'Files' },
  { key: 'Workspaces', label: 'Sub-Workspaces' },
  // This workspace's earlier versions, one per Clear (2026-09-25): shown only when there are some, as every section is.
  { key: 'Archived', label: 'Archived' },
];

/** Which section a rail row sorts into: a repository by its tag whether it is an address or a clone. */
export function sectionOf(row) {
  if (row.type === 'archive') return 'Archived';
  if (row.type === 'child' || row.type === 'workspace') return 'Workspaces';
  if (isNote(row)) return 'Notes';
  if (hasTag(row, 'git')) return 'GitHub';
  if (row.type === 'website') return 'Websites';
  return 'Files';
}

/** The rail's rows under their sections, each keeping the rows' order; a section with nothing in it is not shown. */
export function railSections(rows) {
  const by = new Map(RAIL_SECTIONS.map((section) => [section.key, []]));
  for (const row of rows) by.get(sectionOf(row)).push(row);
  return RAIL_SECTIONS.map((section) => ({ ...section, rows: by.get(section.key) })).filter((section) => section.rows.length > 0);
}

/** Something the library could add, by its spelling alone: a web address, an arXiv or DOI id, a git remote, a path from / or ~/. The main process decides for real. */
export function looksAddable(value) {
  const v = String(value || '').trim().replace(/^["'](.*)["']$/, '$1').trim();
  if (!v || /\s/.test(v)) return false;
  return /^https?:\/\/\S+\.\S*/i.test(v) || /^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$/i.test(v) || /^(doi:\s*)?10\.\d{4,9}\/\S+$/i.test(v)
    || /^(?:ssh|git):\/\//i.test(v) || /^[\w.-]+@[\w.-]+:\S+/.test(v) || /^(~\/|\/|file:\/\/)\S/.test(v);
}

/** What a row is searched by: its name, where it is, and the words shown beside it. */
const hay = (row) => [row.name, row.url || '', row.path || '', row.folder_path || '', kindLabel(row)].join(' ').toLowerCase();

/**
 * The search field under the workspace's name (Canvas.dc.html `results`): it finds anything the library holds and brings
 * it into this workspace. Empty, it offers four things from the library that are not here yet; typed, every match in the
 * library (no cap), what is here already included (`here`: picking one opens it). An address or a path is the one row the library
 * has for it (`here` when it is on the rail already) or a new one — that needs `found`, the main process's answer
 * (library.lookupItem): undefined while it is on its way. Making a note or a nested workspace is the +'s job (2026-09-22).
 * Rows: { kind: 'item' | 'fresh', key, name, tag, row?, found? }; a tag that starts with "new" draws a +.
 */
export function searchRows({ query, library, inRail, found }) {
  const typed = String(query || '').trim();
  if (looksAddable(typed)) {
    if (!found || found.error) return [];
    if (found.row) return [{ kind: 'item', key: found.row.id, row: found.row, name: found.row.name, tag: inRail(found.row.id) ? 'here' : kindLabel(found.row) }];
    return found.found ? [{ kind: 'fresh', key: `fresh:${typed}`, found: found.found, name: found.found.name, tag: `new ${kindLabel(found.found)}` }] : [];
  }
  const needle = typed.toLowerCase();
  const hits = needle
    ? library.filter((row) => hay(row).includes(needle))
    : library.filter((row) => !inRail(row.id) && !row.tags.includes('note') && row.type !== 'image').slice(0, 4);
  return hits.map((row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : kindLabel(row) }));
}

export const BART_VERB = { kind: 'verb', verb: 'bart', key: 'verb:bart', name: 'Bart', glyph: 'chat', token: '@Bart ' };
export const TASK_VERB = { kind: 'verb', verb: 'task', key: 'verb:task', name: 'Task', glyph: 'task', token: '@Task ' };
export const NOTE_VERB = { kind: 'verb', verb: 'note', key: 'verb:note', name: 'Note', glyph: 'note', token: '@Note ' };
const MAX_MENTIONS = 10;
const MAX_WORKSPACES = 6; // typed
const FIRST_WORKSPACES = 3; // before anything is typed

/**
 * The @ menu (Add - Mention.dc.html `menu`): Bart, Task and Note first, matched from their first letter; then the page
 * open in the Browser, which the library may not hold yet (`page` { input, title }, `pageRow` its row or null); then the
 * project's other workspaces (2026-09-25; `workspaces` as model/nav.js flatWorkspaces gives them, the ones written in
 * last first, never `hereId`): three before anything is typed, else up to six whose names hold the words; then up to ten
 * things from the library.
 */
export function mentionRows({ query, library, page, pageRow, workspaces = [], hereId = null }) {
  const needle = String(query || '').trim().toLowerCase();
  const verbs = [BART_VERB, TASK_VERB, NOTE_VERB].filter((verb) => !needle || verb.name.toLowerCase().startsWith(needle));
  const pool = library.filter((row) => row.type !== 'image');
  let hits = (needle ? pool.filter((row) => hay(row).includes(needle)) : pool).map((row) => ({ kind: 'item', key: row.id, row, name: row.name }));
  const out = [...verbs];
  if (page && page.title && (!needle || `${page.title} ${page.input}`.toLowerCase().includes(needle))) {
    if (pageRow) { out.push({ kind: 'item', key: pageRow.id, row: pageRow, name: pageRow.name, open: true }); hits = hits.filter((hit) => hit.key !== pageRow.id); }
    else out.push({ kind: 'fresh', key: `page:${page.input}`, name: mentionName(page.title), input: page.input, open: true });
  }
  const others = workspaces.filter((workspace) => workspace.id !== hereId);
  const spaces = (needle ? findWorkspaces(others, needle).slice(0, MAX_WORKSPACES) : others.slice(0, FIRST_WORKSPACES))
    .map((workspace) => ({ kind: 'workspace', key: `ws:${workspace.id}`, id: workspace.id, name: workspace.name, above: workspace.above || [] }));
  return [...out, ...spaces, ...hits.slice(0, MAX_MENTIONS)];
}

/** A name a mention can carry: `@[…]` ends at the first `]` and stays on one line. */
export const mentionName = (value) => String(value || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled page';
