// The Stage (Claude Design "Add - Mention Stage.dc.html", 2026-09-23): the right pane that opens anything — a page, a
// pdf, a file on disk or in the library — where the Browser and the Paper pane used to split the work. Pure: which tab a
// thing lands in, what the address field suggests, how a table and a markdown file are read. The pane does the loading.

import { kindLabel, isNote } from './kind.js';
import { looksAddable } from './rail.js';
import { kindOf } from './address.js';

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

/**
 * A link's target (2026-09-30, @discover's guide): the address, and the passage to find there, from a `#find=` fragment of
 * percent-encoded words (`https://arxiv.org/pdf/2312.10893#find=We%20argue%20that`), and where its section ends, from
 * `&to=` (round 2: the first words of the section after it). → { address, find, to }; `find` and `to` are '' when there
 * is none, and without `find` the address is the link as it came: any other fragment (#page=3, #section) stays on it.
 * Each value is decoded after the split, so an `&` in the words is `%26`. A path keeps its percent-encoding off
 * (`/Users/me/My%20Paper.pdf` is the file with a space), so it matches the library.
 */
export function splitTarget(href) {
  const link = String(href == null ? '' : href).trim();
  const hash = link.indexOf('#');
  const fragment = hash >= 0 ? link.slice(hash + 1) : '';
  const m = fragment.match(/^find=([\s\S]*?)&to=([^&]*)$/) || fragment.match(/^find=([\s\S]*)$/);
  if (!m) return { address: link, find: '', to: '' };
  const words = (value) => {
    let out;
    try { out = decodeURIComponent(value || ''); } catch { out = value || ''; }
    return out.replace(/\s+/g, ' ').trim();
  };
  let address = link.slice(0, hash);
  if (/^(?:\/|~\/)/.test(address) && /%[0-9a-f]{2}/i.test(address)) { try { address = decodeURIComponent(address); } catch { /* as written */ } }
  return { address, find: words(m[1]), to: words(m[2]) };
}

// A link in an answer line as the editor draws one (model/doc.js INLINE): `[text](href)`, inside bold or not; code is not a link.
const GUIDE_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * The sections an @discover guide suggests for one paper (2026-10-03): every link with a passage (#find=) to `address` in
 * the reply `replyLines` (its lines' text, after `bart> `), in the order they come, each passage once →
 * [{ label, find, to }], `label` the link's text ("3.2 Design Goals"). The paper's title link has no passage: not a section.
 */
export function guideSections(replyLines, address) {
  const where = String(address || '').trim();
  const out = [], seen = new Set();
  if (!where) return out;
  for (const line of replyLines || []) {
    const text = String(line == null ? '' : line).replace(/`[^`\n]+`/g, '');
    for (const m of text.matchAll(GUIDE_LINK_RE)) {
      const target = splitTarget(m[2]);
      if (!target.find || target.address !== where) continue;
      const key = `${target.find}\n${target.to}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label: m[1].replace(/\s+/g, ' ').trim(), find: target.find, to: target.to });
    }
  }
  return out;
}

/** Which of a tab's sections a passage is the start of (-1: none). */
export function sectionAt(sections, find, to) {
  return (sections || []).findIndex((s) => s.find === find && (s.to || '') === (to || ''));
}

/**
 * A tab a link's passage goes to (Stage claim): it waits there as `pendingFind` / `pendingTo` until what the tab shows is
 * ready. The sections an @discover guide gave with it (guideSections, 2026-10-03) replace the tab's, the clicked one in
 * front (`activeSection`); a passage from anywhere else leaves the tab none. No passage: the tab as it was.
 */
export function withPassage(tab, find, to, sections) {
  if (!find) return tab;
  const list = Array.isArray(sections) ? sections : [];
  return { ...tab, pendingFind: find, pendingTo: to || null, sections: list, activeSection: sectionAt(list, find, to) };
}

/** A tab whose passage was found (Stage landed): it waits no longer, and the section it starts is the one in front. */
export function landTab(tab, find) {
  if (!tab || tab.pendingFind !== find) return tab;
  const sections = tab.sections || [];
  return { ...tab, pendingFind: null, pendingTo: null, activeSection: sections.length ? sectionAt(sections, find, tab.pendingTo) : -1 };
}

/**
 * Whether a link's passage, found in a pdf, opens the find card with its words: yes, as ever, except in one an
 * @discover guide's sections came with (2026-10-03), where the Sections menu shows what was found instead. (A page or a
 * drawn file never opens it: Stage land, 2026-10-03.)
 */
export const landingFinds = (tab) => !(tab && tab.pdf && tab.sections && tab.sections.length);

/** The library row a link's address is: one the Stage shows whose path (or file: address) or url is that address. */
export function rowForAddress(library, address) {
  const where = String(address || '').trim();
  if (!where) return null;
  let path = null;
  if (/^file:\/\//i.test(where)) { try { path = decodeURIComponent(new URL(where).pathname); } catch { path = null; } } else if (where.startsWith('/')) path = where;
  const key = /^https?:\/\//i.test(where) ? addressKey(where) : '';
  return (library || []).find((row) => onStage(row) && ((path && row.path === path) || (key && row.url && addressKey(row.url) === key))) || null;
}

// A paper's address as the library spells it (main/store/library.cjs resolveAddition): an arXiv pdf, a version or a
// .pdf is the paper's abstract page, a DOI is doi.org's. Anything else is as it came.
const ARXIV_RE = /^(?:arxiv:\s*|https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5})(?:v\d+)?(?:\.pdf)?\/?$/i;
const DOI_RE = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i;
export function libraryAddress(address) {
  const where = String(address || '').trim();
  let m;
  if ((m = where.match(ARXIV_RE))) return `https://arxiv.org/abs/${m[1]}`;
  if ((m = where.match(DOI_RE))) return `https://doi.org/${m[1]}`;
  return where;
}

/**
 * The library row a paper's address is (2026-10-02, an @discover guide's title): rowForAddress, and else the row the
 * library made for it, which spells an arXiv pdf as its abstract page (`arxiv.org/pdf/2205.04561` is the row of
 * `arxiv.org/abs/2205.04561`).
 */
export function paperRow(library, address) {
  const spelled = libraryAddress(address);
  return rowForAddress(library, address) || (spelled !== String(address || '').trim() ? rowForAddress(library, spelled) : null);
}

/** A page's save button, by where the page is: not in the library, in it but not this workspace, here. The Stage's address and an @discover guide's titles (2026-10-02). */
export const SAVE_LABEL = { none: '+ Save', lib: '+ Workspace', here: '✓' };

const fileAddress = (file) => `file://${String(file).split('/').map(encodeURIComponent).join('/')}`;

/**
 * Where a link opens (Stage.openInput) → { address, find, to, row, key }. A link with a passage to a library row opens that
 * row, ink and all; otherwise the address does. `key` is the tab it comes forward in when that is open already (tabKey;
 * '' always takes a tab of its own, as a path did before passages): a page by its address, a row by its id, and with a
 * passage a file by its path too.
 * A passage in an arXiv pdf opens the paper's row once the library keeps its copy (2026-10-02: a paper saved from its
 * guide reads offline); while the row is still its abstract page, the pdf's address opens, as before.
 */
export function linkPlan(href, library) {
  const { address, find, to } = splitTarget(href);
  const kept = find ? paperRow(library, address) : null;
  const row = find ? rowForAddress(library, address) || (kept && kept.type === 'pdf' && kept.path ? kept : null) : null;
  if (row) return { address, find, to, row, key: `i:${row.id}` };
  const k = kindOf(address);
  const page = k.kind === 'web' || k.kind === 'local' || k.kind === 'disk';
  let key = page && !/^file:/i.test(address) ? `l:${addressKey(k.url)}` : '';
  if (!key && find && address.startsWith('/')) key = `l:${addressKey(fileAddress(address))}`;
  return { address, find, to, row: null, key };
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
 * in front is used; at MAX_TABS the tab in front is replaced; otherwise a new tab at the end. `newTab` (a ⌘-click on a
 * link): a tab of its own even when one already shows it, still the blank tab in front, still at most MAX_TABS.
 * Answers { focus: index } | { replace: index } | { append: true }.
 */
export function placeTab(tabs, activeIndex, key, { newTab = false } = {}) {
  const at = key && !newTab ? tabs.findIndex((tab) => tabKey(tab) === key) : -1;
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

/** A library row the Stage can show: anything but a note (notes open in the middle) or a pasted image. */
export function onStage(row) {
  if (!row || isNote(row) || row.type === 'workspace' || row.type === 'child') return false;
  if (row.type === 'folder') return !!(row.url || row.folder_path); // a repository's folder shows its address, a plain one itself
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
