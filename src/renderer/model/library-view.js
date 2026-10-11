// The Library window (2026-10-11, the Library's Phase C, first cut; the mockups in the Library 2 workspace): what it
// lists, in which order, and the words beside each row. Pure: the rows come in, the lists go out; LibraryModal.jsx draws
// them and does the adding and removing.

import { libraryFilter } from './kind.js';
import { searchRows } from './rail.js';
import { sinceWords } from './sidebar.js';

/** How many ids one add-to-project or remove-from-project call takes (main refuses more: projects.MAX_PROJECT_CHANGE). */
export const PROJECT_BATCH = 200;

/** `ids` in calls of at most `size`. */
export function batches(ids, size = PROJECT_BATCH) {
  const out = [];
  for (let at = 0; at < ids.length; at += size) out.push(ids.slice(at, at + size));
  return out;
}

const edited = (row) => Date.parse(row.last_edited || row.created || '') || 0;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A row's date as the list shows it: "2 h ago" within a week, then "Sep 3", and "Sep 3, 2025" another year. */
export function libraryDate(row, now = Date.now()) {
  const then = edited(row);
  if (!then) return '';
  if (now - then < 7 * 24 * 3600_000) return sinceWords(new Date(then).toISOString(), now);
  const day = new Date(then);
  const year = day.getFullYear() === new Date(now).getFullYear() ? '' : `, ${day.getFullYear()}`;
  return `${MONTHS[day.getMonth()]} ${day.getDate()}${year}`;
}

/** Where a row is from, in a few words: its folder, the site of its address, or its file's folder. */
export function placeOf(row) {
  if (row.url) { try { return new URL(row.url).hostname.replace(/^www\./, ''); } catch { /* not an address */ } }
  const at = row.folder_path || (row.path ? String(row.path).replace(/\/[^/]*$/, '') : '');
  if (!at) return '';
  const parts = at.split('/').filter(Boolean);
  if (parts.includes('.engelbart') || parts.includes('assets')) return 'Engelbart'; // a note or an import kept by Engelbart
  return parts.slice(-2).join('/');
}

/**
 * The words in the "Where" column. In this project: made here, or the workspaces that have it, or the project's own list.
 * Everything: where it is from (placeOf).
 */
export function whereLine(row, scope) {
  if (scope === 'project') {
    if (row.origin) return 'Made in this project';
    if (row.workspaces && row.workspaces.length) return row.workspaces.join(', ');
    return 'Project library';
  }
  return placeOf(row);
}

/**
 * The rows listed: every row of the scope but pictures (a pasted image is its document's), narrowed by the chip; nothing
 * typed, the last edited first; typed, searchRows' order (names that start with it first, what holds it only in what it
 * says last).
 */
export function libraryViewRows({ rows, chip = 'all', query = '', bodies = null }) {
  const things = (rows || []).filter((row) => libraryFilter(row, chip));
  const typed = String(query || '').trim();
  if (!typed) return [...things].sort((a, b) => edited(b) - edited(a));
  return searchRows({ query: typed, library: things, inRail: () => false, bodies }).filter((hit) => hit.kind === 'item').map((hit) => hit.row);
}

/** What the add bar says it did, from each batch's answer ({ added, inWorkspace } or { error, ids }). */
export function addedLine(results, projectName) {
  const added = results.reduce((n, one) => n + (one.added || 0), 0);
  const here = results.reduce((n, one) => n + (one.inWorkspace || 0), 0);
  const failed = results.filter((one) => one.error);
  const parts = [];
  if (added) parts.push(`Added ${added} to ${projectName}.${here ? ` ${here === added ? (added === 1 ? 'It is' : 'They are') : `${here} are`} also in this workspace.` : ''}`);
  for (const one of failed) parts.push(`${one.ids.length} did not go in: ${one.error}`);
  return parts.join(' ');
}
