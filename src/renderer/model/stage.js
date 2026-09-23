// The Stage (Claude Design "Add - Mention Stage.dc.html", 2026-09-23): the right pane that opens anything — a page, a
// pdf, a file on disk or in the library — where the Browser and the Paper pane used to split the work. Pure: which tab a
// thing lands in, what the address field suggests, how a table and a markdown file are read. The pane does the loading.

import { kindLabel, isNote } from './kind.js';
import { looksAddable } from './rail.js';

/** The most tabs the Stage holds; past it, what is opened takes the place of the tab in front (Hudson, 2026-09-23). */
export const MAX_TABS = 15;

/** How one address is spelled for "is it open already": http or https, www. or not, a trailing slash, a #fragment. */
export function addressKey(value) {
  const v = String(value || '').trim();
  if (!v || v === 'about:blank') return '';
  let u;
  try { u = new URL(v); } catch { return v; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href.replace(/#.*$/, '');
  return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

/** What a tab is for "is it open already": the library row it shows, else where it is; a blank tab is nothing. */
export function tabKey(tab) {
  if (!tab) return '';
  if (tab.item) return `i:${tab.item}`;
  const where = tab.file && tab.file.path ? `file://${tab.file.path}` : tab.pdf ? tab.pdf.url : tab.url;
  const key = addressKey(where);
  return key ? `l:${key}` : '';
}

/**
 * Where something being opened goes (the design's openInStage): the tab that already shows it comes forward; a blank tab
 * in front is used; at MAX_TABS the tab in front is replaced; otherwise a new tab at the end.
 * Answers { focus: index } | { replace: index } | { append: true }.
 */
export function placeTab(tabs, activeIndex, key) {
  const at = key ? tabs.findIndex((tab) => tabKey(tab) === key) : -1;
  if (at >= 0) return { focus: at };
  const front = tabs[activeIndex];
  if (front && tabKey(front) === '' && !front.pdf && !front.file && !front.claimed) return { replace: activeIndex }; // `claimed`: something is on its way into it
  if (tabs.length >= MAX_TABS) return { replace: activeIndex };
  return { append: true };
}

/** Where a tab is closed from, which tab is in front afterwards (the one to its right, else to its left). */
export function afterClose(count, activeIndex, closedIndex) {
  const left = count - 1;
  if (left <= 0) return -1;
  if (closedIndex < activeIndex) return activeIndex - 1;
  return Math.min(activeIndex, left - 1);
}

/** What the tab's hover card says under its title: the site for a page, the path for a file. */
export function tabPlace(value) {
  const v = String(value || '');
  if (!v || v === 'about:blank') return '';
  if (/^[~/]/.test(v)) return v;
  if (/^file:\/\//i.test(v)) { try { return decodeURIComponent(new URL(v).pathname); } catch { return v; } }
  const host = v.replace(/^https?:\/\/(www\.)?/i, '').split(/[/?#]/)[0];
  return host || v;
}

/** A library row the Stage can show: anything but a note (notes open in the middle), a pasted image, or a folder that is only a folder. */
export function onStage(row) {
  if (!row || isNote(row) || row.type === 'workspace' || row.type === 'child') return false;
  if (row.type === 'folder') return !!row.url; // a repository's folder shows its address
  return !!(row.url || row.path);
}

/** A bare host with a path, as typed into an address bar ("example.com/a"), and not an arXiv id. */
const bareHost = (v) => !/\s/.test(v) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(v) && !/^\d{4}\.\d{4,5}$/.test(v);
/** A path by its spelling: from /, ~/, ./ or ../, a file: address, or a relative name with an extension. */
const pathLike = (v) => /^(\.{0,2}\/|~\/|file:\/\/)/i.test(v) || (/^[\w.-]+(\/[\w.-]+)*\.[a-z0-9]{1,8}$/i.test(v) && !bareHost(v));

/** Something to go to rather than to search for: an address, an id or remote the library knows, a local port, a path. */
export function looksLikePlace(value) {
  const v = String(value || '').trim();
  if (!v || /\s/.test(v)) return false;
  return looksAddable(v) || /^https?:\/\//i.test(v) || /^:?\d{2,5}(\/.*)?$/.test(v) || /^localhost(:\d+)?(\/.*)?$/i.test(v) || bareHost(v) || pathLike(v);
}

const hay = (row) => [row.name, row.url || '', row.path || '', kindLabel(row)].join(' ').toLowerCase();
const SHOWN = 6;

/**
 * The address field's list (the design's stageRows). Typed text that names a place is one row: the library's row for it
 * when there is one (`found`, library.lookupItem's answer, may still be on its way), else the place itself. Anything
 * else lists what this workspace holds, then the rest of the library — never notes, which open in the middle — and a
 * web search for the words. The last row always chooses a file from the computer.
 * Rows: { kind: 'item', key, row, here } | { kind: 'place', key, input } | { kind: 'search', key, input } | { kind: 'disk', key }.
 */
export function stageRows({ query, library, inRail, found }) {
  const typed = String(query || '').trim();
  const rows = [];
  if (typed && looksLikePlace(typed)) {
    if (found && found.row && onStage(found.row)) rows.push({ kind: 'item', key: found.row.id, row: found.row, here: inRail(found.row.id) });
    else rows.push({ kind: 'place', key: `place:${typed}`, input: typed });
  } else {
    const needle = typed.toLowerCase();
    const hit = (row) => onStage(row) && (!needle || hay(row).includes(needle));
    const here = library.filter((row) => inRail(row.id) && hit(row)).slice(0, SHOWN);
    const rest = library.filter((row) => !inRail(row.id) && hit(row)).slice(0, SHOWN);
    for (const row of here) rows.push({ kind: 'item', key: row.id, row, here: true });
    for (const row of rest) rows.push({ kind: 'item', key: row.id, row, here: false });
    if (typed) rows.push({ kind: 'search', key: `search:${typed}`, input: typed });
  }
  rows.push({ kind: 'disk', key: 'disk' });
  return rows;
}

/** A csv or tsv as rows of cells: quoted fields may hold the delimiter, doubled quotes and line breaks. At most `limit` rows. */
export function parseTable(text, delimiter = ',', limit = 5000) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length >= limit) return rows;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
