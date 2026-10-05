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
  // This workspace's earlier versions, one per Clear (2026-09-25).
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

/** The rail's rows under their sections, each keeping the rows' order; every section is shown, empty or not (2026-09-29). */
export function railSections(rows) {
  const by = new Map(RAIL_SECTIONS.map((section) => [section.key, []]));
  for (const row of rows) by.get(sectionOf(row)).push(row);
  return RAIL_SECTIONS.map((section) => ({ ...section, rows: by.get(section.key) }));
}

/** Something the library could add, by its spelling alone: a web address, an arXiv or DOI id, a git remote, a path from / or ~/. The main process decides for real. */
export function looksAddable(value) {
  const v = String(value || '').trim().replace(/^["'](.*)["']$/, '$1').trim();
  if (!v || /\s/.test(v)) return false;
  return /^https?:\/\/\S+\.\S*/i.test(v) || /^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$/i.test(v) || /^(doi:\s*)?10\.\d{4,9}\/\S+$/i.test(v)
    || /^(?:ssh|git):\/\//i.test(v) || /^[\w.-]+@[\w.-]+:\S+/.test(v) || /^(~\/|\/|file:\/\/)\S/.test(v);
}

/** What a row is searched by: its name, where it is, the words shown beside it, and its summary. */
const hay = (row) => [row.name, row.url || '', row.path || '', row.folder_path || '', kindLabel(row), row.summary || ''].join(' ').toLowerCase();

// What things say (MATH-29, 2026-10-05): `bodies` { items, workspaces }, Maps of library id and workspace id → text already
// lowercased, as the main process reads it when a search or the @ menu opens (library.bodiesForProject). Optional: without
// it, only what `hay` holds is matched. A row found only by what it says comes after every row found by `hay`, and looks
// the same.
const bodyOf = (bodies, kind, id) => (bodies && bodies[kind] && bodies[kind].get(id)) || '';
const lowered = (texts) => new Map(Object.entries(texts || {}).map(([id, text]) => [id, String(text).toLowerCase()]));
/** `bodies` from the main process's answer ({ items, workspaces }, objects of id → text), lowercased once. */
export const bodyMaps = (reply) => ({ items: lowered(reply && reply.items), workspaces: lowered(reply && reply.workspaces) });
/** The rows `hay` matches (`byHay`), in their order, then the ones only their text does (`byBody`). */
function hayThenBody(rows, byHay, byBody) {
  const first = rows.filter(byHay);
  const held = new Set(first);
  return [...first, ...rows.filter((row) => !held.has(row) && byBody(row))];
}

/**
 * The search field under the workspace's name (Canvas.dc.html `results`): it finds anything the library holds and brings
 * it into this workspace. Empty, it offers four things from the library that are not here yet; typed, every match in the
 * library (no cap; with `bodies`, what holds the words only in what it says comes last), what is here already included
 * (`here`: picking one opens it). An address or a path is the one row the library has for it (`here` when it is on the
 * rail already) or a new one — that needs `found`, the main process's answer (library.lookupItem): undefined while it is
 * on its way; what things say plays no part there. Making a note or a nested workspace is the +'s job (2026-09-22).
 * Rows: { kind: 'item' | 'fresh', key, name, tag, row?, found? }; a tag that starts with "new" draws a +.
 */
export function searchRows({ query, library, inRail, found, bodies = null }) {
  const typed = String(query || '').trim();
  if (looksAddable(typed)) {
    if (!found || found.error) return [];
    if (found.row) return [{ kind: 'item', key: found.row.id, row: found.row, name: found.row.name, tag: inRail(found.row.id) ? 'here' : kindLabel(found.row) }];
    return found.found ? [{ kind: 'fresh', key: `fresh:${typed}`, found: found.found, name: found.found.name, tag: `new ${kindLabel(found.found)}` }] : [];
  }
  const needle = typed.toLowerCase();
  const hits = needle
    ? hayThenBody(library, (row) => hay(row).includes(needle), (row) => bodyOf(bodies, 'items', row.id).includes(needle))
    : library.filter((row) => !inRail(row.id) && !row.tags.includes('note') && row.type !== 'image').slice(0, 4);
  return hits.map((row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : kindLabel(row) }));
}

const ATTACH_RECENT = 8; // what "Add from library" lists before anything is typed
const when = (row) => Date.parse(row.last_edited || row.created || '') || 0;

/**
 * "Add from library" in the Build panel (2026-09-27): what can be attached to a Build. Empty, the things written in last;
 * typed, everything whose name, place, kind or summary holds all the words, names that start with them first, then (with
 * `bodies`) what holds them only in what it says. Never an image (a Build is not given pictures) nor what is attached
 * already (`taken`, ids). Rows: { key, row, name, tag }.
 */
export function attachRows({ query, library, taken = [], inRail = () => false, bodies = null }) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const held = new Set(taken);
  const pool = library.filter((row) => row.type !== 'image' && !held.has(row.id));
  // Every word in the name, place or kind; after those, every word there or in what the row says (MATH-29).
  const inHay = (row) => { const text = hay(row); return words.every((word) => text.includes(word)); };
  const inEither = (row) => { const text = hay(row), body = bodyOf(bodies, 'items', row.id); return words.every((word) => text.includes(word) || body.includes(word)); };
  const hits = words.length ? pool.filter(inHay) : pool;
  const found = new Set(hits);
  const said = words.length ? pool.filter((row) => !found.has(row) && inEither(row)) : [];
  const starts = (row) => (words.length && String(row.name).toLowerCase().startsWith(words[0]) ? 0 : 1);
  const order = (rows) => [...rows].sort((a, b) => starts(a) - starts(b) || when(b) - when(a));
  const sorted = [...order(hits), ...order(said)];
  return (words.length ? sorted : sorted.slice(0, ATTACH_RECENT)).map((row) => ({ key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : kindLabel(row) }));
}

export const BART_VERB = { kind: 'verb', verb: 'bart', key: 'verb:bart', name: 'Bart', glyph: 'chat', token: '@Bart ' };
export const NOTE_VERB = { kind: 'verb', verb: 'note', key: 'verb:note', name: 'Note', glyph: 'note', token: '@Note ' };
// @brainstorm (2026-09-30): asks, a card at a time, what you want to work on.
export const BRAINSTORM_VERB = { kind: 'verb', verb: 'brainstorm', key: 'verb:brainstorm', name: 'Brainstorm', glyph: 'chat', token: '@Brainstorm ' };
// @orient (2026-10-04): asks what you know about a topic or a paper, then what interests you about it.
export const ORIENT_VERB = { kind: 'verb', verb: 'orient', key: 'verb:orient', name: 'Orient', glyph: 'chat', token: '@Orient ' };
// @discover (2026-09-30): what to read about a problem, and where in it to look.
export const DISCOVER_VERB = { kind: 'verb', verb: 'discover', key: 'verb:discover', name: 'Discover', glyph: 'chat', token: '@Discover ' };
const MAX_MENTIONS = 10;
const MAX_WORKSPACES = 6; // typed
const FIRST_WORKSPACES = 3; // before anything is typed

/**
 * The @ menu (Add - Mention.dc.html `menu`): Bart, Note, Brainstorm, Orient and Discover first (Task went on 2026-09-29;
 * Brainstorm and Discover came on 2026-09-30, Orient on 2026-10-04), matched from their first letter; then the page
 * open in the Browser, which the library may not hold yet (`page` { input, title }, `pageRow` its row or null); then the
 * project's other workspaces (2026-09-25; `workspaces` as model/nav.js flatWorkspaces gives them, the ones written in
 * last first, never `hereId`): three before anything is typed, else up to six whose names hold the words, then (with
 * `bodies`) whose documents hold what is typed; then up to ten things from the library, those found only by what they
 * say last.
 */
export function mentionRows({ query, library, page, pageRow, workspaces = [], hereId = null, bodies = null }) {
  const needle = String(query || '').trim().toLowerCase();
  const verbs = [BART_VERB, NOTE_VERB, BRAINSTORM_VERB, ORIENT_VERB, DISCOVER_VERB].filter((verb) => !needle || verb.name.toLowerCase().startsWith(needle));
  const pool = library.filter((row) => row.type !== 'image');
  let hits = (needle ? hayThenBody(pool, (row) => hay(row).includes(needle), (row) => bodyOf(bodies, 'items', row.id).includes(needle)) : pool).map((row) => ({ kind: 'item', key: row.id, row, name: row.name }));
  const out = [...verbs];
  if (page && page.title && (!needle || `${page.title} ${page.input}`.toLowerCase().includes(needle))) {
    if (pageRow) { out.push({ kind: 'item', key: pageRow.id, row: pageRow, name: pageRow.name, open: true }); hits = hits.filter((hit) => hit.key !== pageRow.id); }
    else out.push({ kind: 'fresh', key: `page:${page.input}`, name: mentionName(page.title), input: page.input, open: true });
  }
  const others = workspaces.filter((workspace) => workspace.id !== hereId);
  const named = needle ? findWorkspaces(others, needle) : [];
  const said = needle ? others.filter((workspace) => !named.includes(workspace) && bodyOf(bodies, 'workspaces', workspace.id).includes(needle)) : [];
  const spaces = (needle ? [...named, ...said].slice(0, MAX_WORKSPACES) : others.slice(0, FIRST_WORKSPACES))
    .map((workspace) => ({ kind: 'workspace', key: `ws:${workspace.id}`, id: workspace.id, name: workspace.name, above: workspace.above || [] }));
  return [...out, ...spaces, ...hits.slice(0, MAX_MENTIONS)];
}

/** A row the line keeps as a word (Bart, Note, Brainstorm, Orient, Discover) rather than a mention; an editor's own list names the agents by id. */
export const isVerbRow = (row) => !!row && (row.kind === 'verb' || row.id === 'bart' || row.id === 'brainstorm' || row.id === 'orient' || row.id === 'discover');
/** The @ menu of a follow-up field (2026-10-02): the field already asks its thread's agent, so only what can be mentioned. */
export const fieldRows = (rows) => rows.filter((row) => row && !isVerbRow(row));

/** A name a mention can carry: `@[…]` ends at the first `]` and stays on one line. */
export const mentionName = (value) => String(value || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled page';
