// What the workspace sidebar's search and the document's @ menu list (Claude Design "Canvas.dc.html" and
// "Add - Mention.dc.html", 2026-09-22). Pure: the rows come in, the lists go out; the screen does the adding.

import { hasTag, isNote, kindKey, kindLabel } from './kind.js';
import { findWorkspaces } from './nav.js';

/** Stable keys preserve item routing; labels describe the work, not the connection. */
export const RAIL_SECTIONS = [
  { key: 'Workspaces', label: 'Sub-workspaces', icon: 'workspace' },
  { key: 'GitHub', label: 'Code', icon: 'git', catalog: { provider: 'github', label: 'My Projects', title: 'Repositories' } },
  { key: 'Overleaf', label: 'Writing', icon: 'overleaf', catalog: { provider: 'overleaf', label: 'Browse projects…', title: 'Overleaf projects' } },
  { key: 'Papers', label: 'Literature', icon: 'literature', catalog: { provider: 'zotero', label: 'Browse Zotero…', title: 'Zotero papers' } },
  { key: 'Documents', label: 'Documents', icon: 'note', catalog: { provider: 'google', label: 'Browse Google Docs…', title: 'Google Docs' } },
  { key: 'Files', label: 'Other context', icon: 'folder' },
  { key: 'Archived', label: 'Archived', icon: 'folder' },
];

function webUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url : null; } catch { return null; }
}

/** Provider identity for linked documents, without changing stored library types. */
export function documentProvider(row) {
  if (row.type !== 'website') return null;
  const url = webUrl(row.url);
  if (!url) return null;
  if (url.hostname === 'docs.google.com' && /^\/document\/(?:u\/\d+\/)?d\/[^/]+/.test(url.pathname)) return 'google-docs';
  if (['overleaf.com', 'www.overleaf.com'].includes(url.hostname) && /^\/project\/[^/]+/.test(url.pathname)) return 'overleaf';
  return null;
}

function isZoteroReference(row) {
  const url = webUrl(row.url);
  return url && ['zotero.org', 'www.zotero.org'].includes(url.hostname)
    && /^\/(?:groups\/\d+(?:\/[^/]+)?|[^/]+)\/items\/[^/]+/.test(url.pathname);
}

/** Route each saved item once, without changing its library type or tags. */
export function sectionOf(row) {
  if (row.type === 'archive') return 'Archived';
  if (row.type === 'child' || row.type === 'workspace') return 'Workspaces';
  if (hasTag(row, 'git')) return 'GitHub';
  if (documentProvider(row) === 'overleaf') return 'Overleaf';
  if (hasTag(row, 'paper') || isZoteroReference(row)) return 'Papers';
  if (hasTag(row, 'sticky') || row.type === 'conversation') return 'Files';
  if (isNote(row) || documentProvider(row) === 'google-docs' || ['pdf', 'md', 'docx', 'doc', 'txt', 'rtf', 'odt'].includes(row.type)) return 'Documents';
  return 'Files';
}

/** Keep empty headings and material order, with no intermediate nesting. */
export function railSections(rows) {
  const sections = RAIL_SECTIONS.map(section => ({ ...section, rows: [] }));
  const by = new Map(sections.map(section => [section.key, section]));
  for (const row of rows) by.get(sectionOf(row)).rows.push(row);
  return sections.filter(section => section.key !== 'Archived' || section.rows.length);
}

// Source categories use the existing file kinds; they do not create new stored library types.
const OTHER_CONTEXT_CATEGORIES = [
  { id: 'images', label: 'Images', kind: 'image', empty: 'No images yet' },
  { id: 'datasets', label: 'Datasets', kind: 'data', empty: 'No datasets yet' },
  { id: 'web-pages', label: 'Web pages', kind: 'website', empty: 'No web pages yet' },
  { id: 'conversations', label: 'Conversations', kind: 'chat', type: 'conversation', empty: 'No conversations yet' },
  { id: 'other-notes', label: 'Notes', kind: 'note', type: 'md', empty: 'No notes yet' },
];

/** Each sidebar node has direct rows and optional child categories; no item is duplicated or dropped. */
export function sidebarSections(rows) {
  const sections = [
    { id: 'github', label: 'GitHub', rows: [] },
    { id: 'overleaf', label: 'Overleaf', rows: [] },
    { id: 'papers', label: 'Papers', rows: [] },
    { id: 'notes', label: 'Documents', rows: [] },
    { id: 'other', label: 'Other context', rows: [], children: OTHER_CONTEXT_CATEGORIES.map((category) => ({ ...category, rows: [] })) },
  ];
  const byId = new Map(sections.flatMap((section) => [section, ...(section.children || [])]).map((section) => [section.id, section]));
  for (const row of rows) {
    if (row.type === 'workspace' || row.type === 'child') continue;
    const section = byId.get(sidebarSectionOf(row));
    const kind = row.type === 'html' ? 'website' : kindKey(row);
    const category = section.children?.find((child) => child.type ? child.type === row.type : child.kind === kind);
    (category || section).rows.push(row);
  }
  return sections;
}

/** Linked projects retain their category when they are reopened from the library. */
export function sidebarSectionOf(row) {
  if (row.type === 'conversation') return 'other';
  if (row.type === 'pdf') return hasTag(row, 'paper') ? 'papers' : 'notes';
  if (hasTag(row, 'sticky')) return 'other';
  if (hasTag(row, 'git')) return 'github';
  const linked = linkedSidebarSection(row.url);
  if (linked) return linked;
  if (isNote(row)) return 'notes';
  if (hasTag(row, 'paper')) return 'papers';
  return 'other';
}

export function linkedSidebarSection(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'overleaf.com') return 'overleaf';
  return null;
}

/** Claude and Codex sessions already owned by this project, including agents started from a shell. */
export function conversationRows(sessions, activeId) {
  return sessions.flatMap((record) => {
    const provider = ['claude', 'codex'].includes(record.snapshot.provider) ? record.snapshot.provider
      : record.shell?.busy ? /^(?:\s*(?:command|exec|noglob|nocorrect|sudo)\s+|\s*[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*\s*(?:\S*\/)?(claude|codex)(?:\s|$)/.exec(record.shell.command || '')?.[1] : null;
    if (!provider) return [];
    const label = provider === 'claude' ? 'Claude Code' : 'Codex';
    return [{ id: record.snapshot.id, name: record.snapshot.provider === 'shell' ? label : record.displayTitle || label,
      type: 'conversation', provider, tags: [], on: record.snapshot.id === activeId }];
  });
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

const NEW_NOTE = { kind: 'note', key: 'new:note', name: 'New document', glyph: 'note', tag: 'new' };
const NEW_WORKSPACE = { kind: 'child', key: 'new:workspace', name: 'New workspace', glyph: 'workspace', tag: 'new' };

/**
 * Search sits below the current workspace card. It finds workspaces throughout the project and items already in context as well
 * as the rest of the library. Empty, it offers creation actions and four items that are not here yet. An address or path is the row the
 * library has for it (`here` when it is on the rail already) or a new one — that needs `found`, the main process's
 * answer (library.lookupItem): undefined while it is on its way.
 * Rows: { kind: 'workspace' | 'item' | 'fresh' | 'note' | 'child', key, name, tag, row?, found? }; a tag starting with "new" draws a +.
 */
export function searchRows({ query, library, inRail, found, workspaces = [] }) {
  const typed = String(query || '').trim();
  if (looksAddable(typed)) {
    if (!found || found.error) return [];
    if (found.row) return [{ kind: 'item', key: found.row.id, row: found.row, name: found.row.name, tag: inRail(found.row.id) ? 'here' : kindLabel(found.row) }];
    return found.found ? [{ kind: 'fresh', key: `fresh:${typed}`, found: found.found, name: found.found.name, tag: `new ${kindLabel(found.found)}` }] : [];
  }
  const needle = typed.toLowerCase();
  const workspaceHits = [];
  const walk = (nodes, parents = []) => { for (const node of nodes) {
    const path = [...parents, node.name];
    if (path.join(' / ').toLowerCase().includes(needle)) workspaceHits.push({ kind: 'workspace', key: `workspace:${node.id}`, id: node.id, name: node.name, path: path.join(' / '), tag: 'workspace' });
    walk(node.children || [], path);
  } };
  if (needle) walk(workspaces);
  const hits = (needle ? library.filter((row) => hay(row).includes(needle)) : library.filter((row) => !inRail(row.id) && !isNote(row) && row.type !== 'image').slice(0, 4))
    .map((row) => ({ kind: 'item', key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : kindLabel(row) }));
  return needle ? [...workspaceHits, ...hits, NEW_NOTE, NEW_WORKSPACE] : [NEW_NOTE, NEW_WORKSPACE, ...hits];
}

const ATTACH_RECENT = 8; // what "Add from library" lists before anything is typed
const when = (row) => Date.parse(row.last_edited || row.created || '') || 0;

/**
 * "Add from library" in the Build panel (2026-09-27): what can be attached to a Build. Empty, the things written in last;
 * typed, everything whose name, place or kind holds all the words, names that start with them first. Never an image
 * (a Build is not given pictures) nor what is attached already (`taken`, ids). Rows: { key, row, name, tag }.
 */
export function attachRows({ query, library, taken = [], inRail = () => false }) {
  const words = String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const held = new Set(taken);
  const pool = library.filter((row) => row.type !== 'image' && !held.has(row.id));
  const hits = words.length ? pool.filter((row) => words.every((word) => hay(row).includes(word))) : pool;
  const starts = (row) => (words.length && String(row.name).toLowerCase().startsWith(words[0]) ? 0 : 1);
  const sorted = [...hits].sort((a, b) => starts(a) - starts(b) || when(b) - when(a));
  return (words.length ? sorted : sorted.slice(0, ATTACH_RECENT)).map((row) => ({ key: row.id, row, name: row.name, tag: inRail(row.id) ? 'here' : kindLabel(row) }));
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
