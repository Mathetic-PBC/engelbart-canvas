// What the library searches (the sidebar's Search and Library, Add context's search) and the document's @ menu list
// (Claude Design "Canvas.dc.html" and "Add - Mention.dc.html", 2026-09-22). Pure: the rows come in, the lists go out; the
// screen does the adding. What the sidebar itself lists is model/sidebar.js's.

import { kindLabel, libraryFilter } from './kind.js';
import { findWorkspaces } from './nav.js';

// A web address without its scheme (github.com, example.org/page), as the main process reads one (store/library.cjs).
const BARE_HOST = /^(?:www\.)?(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z]{2,24}(?::\d{1,5})?(?:[/?#]\S*)?$/i;
const FILE_NAME = /^[^./]+\.(?:md|markdown|txt|pdf|html?|png|jpe?g|gif|webp|svg|docx?|pptx?|xlsx?|csv|json|ya?ml|py|js|ts|ipynb|tex|bib|zip)$/i;

/** Something the library could add, by its spelling alone: a web address, an arXiv or DOI id, a git remote, a path from / or ~/. The main process decides for real. */
export function looksAddable(value) {
  const v = String(value || '').trim().replace(/^["'](.*)["']$/, '$1').trim();
  if (!v || /\s/.test(v)) return false;
  return /^https?:\/\/\S+\.\S*/i.test(v) || /^(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?$/i.test(v) || /^(doi:\s*)?10\.\d{4,9}\/\S+$/i.test(v)
    || /^(?:ssh|git):\/\//i.test(v) || /^[\w.-]+@[\w.-]+:\S+/.test(v) || /^(~\/|\/|file:\/\/)\S/.test(v)
    || bareAddress(v);
}

const bareAddress = (v) => BARE_HOST.test(v) && !FILE_NAME.test(v);

/** What a row is searched by: its name, where it is, the words shown beside it, and its summary. */
const hay = (row) => [row.name, row.url || '', row.path || '', row.folder_path || '', kindLabel(row), row.summary || ''].join(' ').toLowerCase();

// What things say (MATH-29, 2026-10-05): `bodies` { items, workspaces }, Maps of library id and workspace id → text already
// lowercased, as the main process reads it when a search or the @ menu opens (library.bodiesForProject). Optional: without
// it, only what `hay` holds is matched. A row found only by what it says comes after every row found by `hay` (matchRank),
// and looks the same.
const bodyOf = (bodies, kind, id) => (bodies && bodies[kind] && bodies[kind].get(id)) || '';
const lowered = (texts) => new Map(Object.entries(texts || {}).map(([id, text]) => [id, String(text).toLowerCase()]));
/** `bodies` from the main process's answer ({ items, workspaces }, objects of id → text), lowercased once. */
export const bodyMaps = (reply) => ({ items: lowered(reply && reply.items), workspaces: lowered(reply && reply.workspaces) });
// How well a row matches what is typed (MATH-59, 2026-10-06), best first: 0 its name starts with it, 1 its name holds it,
// 2 where it is or its kind does, 3 the rest of `hay` (its summary), 4 only what it says (`bodies`); null, not at all.
function matchRank(row, needle, bodies) {
  const name = String(row.name || '').toLowerCase();
  if (name.startsWith(needle)) return 0;
  if (name.includes(needle)) return 1;
  if ([row.url || '', row.path || '', row.folder_path || '', kindLabel(row)].join(' ').toLowerCase().includes(needle)) return 2;
  if (hay(row).includes(needle)) return 3;
  return bodyOf(bodies, 'items', row.id).includes(needle) ? 4 : null;
}
/** The rows that match `needle`, best first (matchRank), each rank in the rows' own order. */
function ranked(rows, needle, bodies) {
  return rows.map((row, i) => ({ row, i, rank: matchRank(row, needle, bodies) }))
    .filter((hit) => hit.rank != null)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((hit) => hit.row);
}

/**
 * The search field under the workspace's name (Canvas.dc.html `results`): it finds anything the library holds and brings
 * it into this workspace. Empty, it offers four things from the library that are not here yet; typed, every match in the
 * library (no cap; ranked as the @ menu is, by matchRank: names that start with the words first, what holds them only in
 * what it says last), what is here already included (`here`: picking one opens it). An address or a path is the one row the library has for it (`here` when it is on the
 * rail already) or a new one — that needs `found`, the main process's answer (library.lookupItem): undefined while it is
 * on its way; what things say plays no part there. Making a note or a nested workspace is the +'s job (2026-09-22).
 * Rows: { kind: 'item' | 'fresh', key, name, tag, row?, found? }; a tag that starts with "new" draws a +.
 */
export function searchRows({ query, library, inRail, found, bodies = null }) {
  const typed = String(query || '').trim();
  const item = (row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : kindLabel(row) });
  const answered = () => {
    if (!found || found.error) return null;
    if (found.row) return item(found.row);
    return found.found ? { kind: 'fresh', key: `fresh:${typed}`, found: found.found, name: found.found.name, tag: `new ${kindLabel(found.found)}` } : null;
  };
  // A bare address (anthropic.com) is still searched for as text first, then is the row the main process found for it.
  const bare = bareAddress(typed);
  if (looksAddable(typed) && !bare) { const one = answered(); return one ? [one] : []; }
  const needle = typed.toLowerCase();
  const hits = needle
    ? ranked(library, needle, bodies)
    : library.filter((row) => !inRail(row.id) && !row.tags.includes('note') && row.type !== 'image').slice(0, 4);
  const rows = hits.map(item);
  const one = bare ? answered() : null;
  return one && !rows.some((row) => row.key === one.key) ? [...rows, one] : rows;
}

/** How many rows the sidebar's Library panel lists before anything is typed. */
export const LIBRARY_RECENT = 40;
const edited = (row) => Date.parse(row.last_edited || row.created || '') || 0;

/**
 * The sidebar's Library panel (2026-10-09): `chip` (kind.js LIBRARY_CHIPS) narrows the library first, so it holds in both
 * modes. Nothing typed, the LIBRARY_RECENT last edited of what is left; typed, searchRows over only that, in its order. A
 * pasted link or path is searchRows' answer whatever the chip: it is not looked for in the library.
 */
export function libraryPanelRows({ query, library, chip = 'all', inRail, found, bodies = null }) {
  const things = (library || []).filter((row) => libraryFilter(row, chip));
  const typed = String(query || '').trim();
  if (!typed) return [...things].sort((a, b) => edited(b) - edited(a)).slice(0, LIBRARY_RECENT).map((row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : '' }));
  return searchRows({ query: typed, library: things, inRail, found, bodies });
}

/**
 * The notes let go of (MATH-58, 2026-10-06): trashed from a workspace (meta.json `removed`) and held by none of the
 * project's workspaces any more, neither in its context nor made in it (`notes`, the tree's, `workspaceId`) unless that
 * one threw it away too. The @ menu and the sidebar's search leave them out; the library keeps them, nothing is deleted,
 * and a mention already written still opens one. Only notes: a paper, a link or a file in no workspace is still found,
 * and so is a note never put in one (a post-it's +Note). `workspaces` is the tree's, nested. → Set of library ids.
 */
export function letGoNotes({ workspaces = [], notes = [] }) {
  const all = [];
  const walk = (list) => { for (const workspace of list || []) { all.push(workspace); walk(workspace.children); } };
  walk(workspaces);
  const trashed = new Set(), held = new Set();
  const madeIn = new Map((notes || []).map((note) => [note.id, note.workspaceId]));
  for (const workspace of all) {
    const removed = new Set(workspace.removed || []);
    for (const id of removed) trashed.add(id);
    for (const id of workspace.context || []) if (!removed.has(id)) held.add(id);
    for (const [id, at] of madeIn) if (at === workspace.id && !removed.has(id)) held.add(id);
  }
  return new Set([...trashed].filter((id) => madeIn.has(id) && !held.has(id)));
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
// @brainstorm (2026-09-30): asks, a card at a time, what you know about a topic or paper and where it thins out, until you
// write a research question (2026-10-05, @orient folded in).
export const BRAINSTORM_VERB = { kind: 'verb', verb: 'brainstorm', key: 'verb:brainstorm', name: 'Brainstorm', glyph: 'chat', token: '@Brainstorm ' };
// @discover (2026-09-30): what to read about a problem, and where in it to look.
export const DISCOVER_VERB = { kind: 'verb', verb: 'discover', key: 'verb:discover', name: 'Discover', glyph: 'chat', token: '@Discover ' };
const MAX_MENTIONS = 10;
const MAX_WORKSPACES = 6; // typed
const FIRST_WORKSPACES = 3; // before anything is typed

/**
 * The @ menu (Add - Mention.dc.html `menu`): Bart, Note, Brainstorm and Discover first (Task went on 2026-09-29;
 * Brainstorm and Discover came on 2026-09-30; Orient, of 2026-10-04, went into Brainstorm on 2026-10-05), matched from
 * their first letter; then the page open in the Browser, which the library may not hold yet (`page` { input, title }, `pageRow` its row or null); then the
 * project's other workspaces (2026-09-25; `workspaces` as model/nav.js flatWorkspaces gives them, the ones written in
 * last first, never `hereId`): three before anything is typed, else up to six whose names hold the words, then (with
 * `bodies`) whose documents hold what is typed; then up to ten things from the library, ranked before they are cut
 * (MATH-59, matchRank): names that start with what is typed, names that hold it, where they are or their kind, their
 * summary, and last (with `bodies`) only what they say.
 */
export function mentionRows({ query, library, page, pageRow, workspaces = [], hereId = null, bodies = null, zotero = false }) {
  const needle = String(query || '').trim().toLowerCase();
  const verbs = [BART_VERB, NOTE_VERB, BRAINSTORM_VERB, DISCOVER_VERB].filter((verb) => !needle || verb.name.toLowerCase().startsWith(needle));
  const pool = library.filter((row) => row.type !== 'image');
  let hits = (needle ? ranked(pool, needle, bodies) : pool).map((row) => ({ kind: 'item', key: row.id, row, name: row.name }));
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
  // The connected Zotero library (MATH-65 build 2): one row, opened like a library folder, before the library's own.
  const zoteroRow = zotero && (!needle || ZOTERO_ROW.name.toLowerCase().startsWith(needle)) ? [{ kind: 'item', key: ZOTERO_ROW.id, row: ZOTERO_ROW, name: ZOTERO_ROW.name }] : [];
  return [...out, ...spaces, ...zoteroRow, ...hits.slice(0, MAX_MENTIONS)];
}

/* ------------------------------------------------------------ files in a folder (MATH-22) */

/**
 * The connected Zotero library in the @ menu (MATH-65 build 2): no library row, but opened as one of its folders is
 * (`@Zotero/` in the line), its collections then its items listed by main from the mirror (zotero-list). An item picked
 * is mentioned as `@[Title](zotero:<key>)` (model/doc.js zoteroMention); the library itself is not mentioned. Build 5:
 * its top is My Library and then each group by name, each opened the same way; a group's item is
 * `@[Title](zotero:g<groupID>:<key>)`.
 */
export const ZOTERO_ROW = Object.freeze({ id: 'zotero', type: 'folder', name: 'Zotero', zotero: true, tags: [] });
export const isZotero = (row) => !!row && row.zotero === true;
/** A library row the @ menu goes into rather than mentions: a folder on this Mac, a repository's clone included; Zotero. */
export const isBrowsable = (row) => !!row && (isZotero(row) || (row.type === 'folder' && !!row.folder_path));
/** The @ menu's row for a library folder: picked, it opens (MF-01). */
export const isFolderRow = (m) => !!m && m.kind === 'item' && isBrowsable(m.row);

/**
 * The @ menu inside a library folder (MF-01, MF-02). Before anything is typed: a row back up a level, "Mention this
 * folder" (the folder's own mention at its top, a subfolder's below it), then what the level holds, subfolders first.
 * Typed: what of it holds the words, the first one ready for Enter. Cut at MAX_MENTIONS, with a row saying how many more.
 * `browse` { row, rel }: the folder's library row and the path of the level inside it ('' at its top). `listing`: main's
 * answer for that level (store/folder-files.cjs listFolder), undefined while it is on its way, { error } when it could
 * not be read. Rows: { kind: 'back' | 'self' | 'entry' | 'note', key, name, … }; a 'note' row says something and is never
 * picked.
 */
export function folderRows({ browse, listing, query }) {
  const { row, rel = '' } = browse;
  const parts = rel ? rel.split('/') : [];
  const needle = String(query || '').trim().toLowerCase();
  const out = needle ? [] : [{ kind: 'back', key: 'back', name: parts.length ? parts[parts.length - 2] || row.name : 'All', hint: [row.name, ...parts].join(' / ') }];
  const say = (key, name) => [...out, { kind: 'note', key: `note:${key}`, name }];
  if (listing === undefined) return say('loading', 'Opening…');
  if (!listing || listing.error) return say('error', (listing && listing.error) || 'This folder could not be read');
  if (listing.missing) return say('missing', isZotero(row) ? 'This collection is no longer in Zotero' : rel ? 'This folder is no longer there' : 'This folder is not on this Mac any more');
  if (!needle && !isZotero(row)) {
    out.push(rel
      ? { kind: 'self', key: `self:${rel}`, name: 'Mention this folder', row, rel, entryName: parts[parts.length - 1], dir: true }
      : { kind: 'self', key: 'self', name: 'Mention this folder', row });
  }
  // A Zotero item is found by its authors and year too (`find`), and says them beside its title (`hint`).
  const hits = (listing.entries || []).filter((entry) => !needle || entry.name.toLowerCase().includes(needle) || (entry.find || '').includes(needle));
  for (const entry of hits.slice(0, MAX_MENTIONS)) out.push({ kind: 'entry', key: `entry:${entry.rel}`, name: entry.name, row, rel: entry.rel, dir: !!entry.dir, type: entry.type || null, ...(entry.zotero ? { zotero: entry.zotero, hint: entry.hint || '' } : {}) });
  // More than shown: those cut here, and (nothing typed) those main left out of a very large folder.
  const more = hits.length - Math.min(hits.length, MAX_MENTIONS) + (needle ? 0 : Math.max(0, (listing.total || 0) - (listing.entries || []).length));
  if (more > 0) out.push({ kind: 'note', key: 'note:more', name: `${more} more${needle ? '' : ': type to narrow'}` });
  else if (!hits.length) out.push({ kind: 'note', key: 'note:none', name: needle ? 'Nothing here by that name' : 'Nothing here to mention' });
  return out;
}
/** The row the keyboard starts on in a folder: its first file or subfolder, else "Mention this folder", else the first. */
export const firstPick = (rows) => { const at = rows.findIndex((m) => m.kind === 'entry'); return at >= 0 ? at : Math.max(0, rows.findIndex((m) => m.kind === 'self')); };
/**
 * A name the @ menu may have to cut, in two (MATH-22 follow-up): its start, which the row cuts with an ellipsis when it
 * runs out of room, and its end, the extension and the ten characters before it, always shown. Long names that start
 * the same ("_FutureHCI_26__The_Illusion…", "…-2.pdf") then still differ on screen. A short name is not split.
 */
export function nameParts(name) {
  const s = String(name || ''); if (s.length <= 24) return { head: s, tail: '' };
  const ext = (s.match(/\.[A-Za-z0-9]{1,8}$/) || [''])[0], keep = Math.min(ext.length + 10, Math.floor(s.length / 2));
  return { head: s.slice(0, s.length - keep), tail: s.slice(s.length - keep) };
}
/** The path of the level above `rel` ('' at the folder's top), or null when `rel` is the top already. */
export const parentRel = (rel) => (rel ? rel.split('/').slice(0, -1).join('/') : null);

/** A row the line keeps as a word (Bart, Note, Brainstorm, Discover) rather than a mention; an editor's own list names the agents by id. */
export const isVerbRow = (row) => !!row && (row.kind === 'verb' || row.id === 'bart' || row.id === 'brainstorm' || row.id === 'discover');
/** The @ menu of a follow-up field (2026-10-02): the field already asks its thread's agent, so only what can be mentioned. */
export const fieldRows = (rows) => rows.filter((row) => row && !isVerbRow(row));

/** A name a mention can carry: `@[…]` ends at the first `]` and stays on one line. */
export const mentionName = (value) => String(value || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled page';

// Every mention a document holds: `@[Name]`, `@[Name](lib:<id>)`, `@[Name](ws:<id>)`, and a file in a library folder,
// `@[Name](lib:<folderId>:<path>)` (MATH-22), and a Zotero item, `@[Title](zotero:<key>)`, which is no row.
const MENTION_TOKEN_RE = /@\[([^\]\n]+)\](?:\((ws|lib|zotero):([\w-]+)(?::[\w.~%/-]+)?\))?/g;
/**
 * The library rows a document mentions, by id (MATH-57): a library mention its item, a plain one every row of its name
 * (as the rail reads them, Workspace.jsx `mentioned`). A workspace is no row. A file in a folder (MATH-22) is a mention of
 * its folder, so the folder stays linked while any mention of it or of a file in it is left.
 */
export function mentionedIds(text, library = []) {
  const ids = new Set(), names = new Set(), body = String(text || '');
  if (!body.includes('@[')) return ids;
  for (const [, name, kind, id] of body.matchAll(MENTION_TOKEN_RE)) {
    if (kind === 'lib') ids.add(id);
    else if (!kind) names.add(name.toLowerCase());
  }
  if (names.size) for (const row of library) if (row && row.name && names.has(row.name.toLowerCase())) ids.add(row.id);
  return ids;
}

/**
 * What an edit of a workspace's document does to its links (MATH-57), from the ids mentioned `before` and `after` it:
 * an item the @ menu linked (`picked`) whose last mention went is unlinked; one this window unlinked that way (`dropped`)
 * whose mention came back, by ⌘Z or typed again, is linked again. An item linked from the sidebar, or still mentioned,
 * is left alone. → { unlink, relink }, ids. Main runs the two in the order asked, so a quick ⌘Z after a delete ends linked.
 */
export function pickedChanges({ before, after, picked = [], dropped = new Set() }) {
  const unlink = [...before].filter((id) => !after.has(id) && picked.includes(id));
  const relink = [...after].filter((id) => !before.has(id) && dropped.has(id));
  return { unlink, relink };
}
