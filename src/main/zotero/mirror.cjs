'use strict';

// Reading the Zotero mirror (MATH-65 build 2; ./sync.cjs writes it to <dataRoot>/.zotero/). For the @ menu, a level of the
// library as a library folder's is listed (listLevel: collections, then items); for a mention, `@[Title](zotero:<key>)`
// (renderer/model/doc.js), its item, its attachment and the <zotero_item> block Bart is given (itemBlock).
// An attachment's file is found where it already is before anything is downloaded: a linked file at its own path, else
// Zotero's storage folder on this Mac (~/Zotero/storage/<attachmentKey>/<file>), else a copy downloaded before
// (files/<attachmentKey>/), else, only when asked (`download`), Zotero's copy is fetched (sync.cjs download).
// Build 3: an item with none of these may have a free copy (./oa.cjs, `openAccess`): found through OpenAlex when it is
// mentioned or its chip is clicked, kept in files/<itemKey>/. A chip opens a pdf in the paper viewer and anything without
// one in the default browser (its DOI's page, else its URL), never in the Stage, where publishers' bot checks block it.
// Build 4: more free sources (Semantic Scholar, arXiv), and a copy the person downloaded in their browser after a chip
// opened the item there (./downloads.cjs) or dropped on its chip: kept in files/<itemKey>/ as a found copy is, and read
// the same way (`source` says which).
// Build 5: group libraries. Each group the person is in is mirrored as My Library is, in <mirror>/groups/<groupID>/ with
// the same files (./sync.cjs). Item keys are only unique within a library, so a mention names its library: `zotero:<key>`
// is an item of My Library (every mention written before build 5), `zotero:g<groupID>:<key>` one of that group (a `ref`,
// parseRef). The @ menu's Zotero lists My Library, then each group by name (listLibraries), each browsed as before.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_RE = /^[A-Za-z0-9]{1,32}$/;
const GROUP_RE = /^[0-9]{1,20}$/;
const REF_RE = /^(?:g([0-9]{1,20}):)?([A-Za-z0-9]{1,32})$/;
const MY_LIBRARY = 'My Library';
// The kinds of attachment opened for an item, best first: a pdf, an epub, a saved web page.
const OPENABLE = ['application/pdf', 'application/epub+zip', 'text/html'];
const MAX_ENTRIES = 5000;
const MAX_NOTE_CHARS = 4000;
const MAX_NOTES_CHARS = 16000;
const MAX_ANNOTATIONS = 200;
// A collection's name in the line (`@Zotero/Reading/`): a `/` in it would read as a level.
const SLASH = '∕';

// A dot folder: a project's folder is <dataRoot>/<slug>, and one named "Zotero" would be <dataRoot>/zotero, which a sync
// and a disconnect delete. No project is ever a dot folder (store/projects.cjs).
const mirrorDir = (dataRoot) => path.join(dataRoot, '.zotero');
const defaultStorage = () => path.join(os.homedir(), 'Zotero', 'storage');
/** A group's mirror: <mirror>/groups/<groupID>. */
const groupDir = (base, group) => path.join(base, 'groups', String(group));
/** A library's mirror: `group` '' is My Library, the mirror's own folder. */
const libraryRoot = (base, group = '') => (group ? groupDir(base, group) : base);

/** A mention's target ('KEY' or 'g<groupID>:KEY') → { group: '' | groupID, key }, or null when it is neither. */
function parseRef(ref) {
  const m = REF_RE.exec(String(ref ?? ''));
  return m ? { group: m[1] || '', key: m[2] } : null;
}
/** The target a mention of item `key` of library `group` writes. */
const refOf = (group, key) => (group ? `g${group}:${key}` : String(key));

// items.json and collections.json, read again only when they change.
const cache = new Map();
function readCached(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { cache.delete(file); return null; }
  const held = cache.get(file);
  if (held && held.mtimeMs === stat.mtimeMs && held.size === stat.size) return held.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { value = null; }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
  return value;
}
const readItems = (root) => { const v = readCached(path.join(root, 'items.json')); return Array.isArray(v) ? v : null; };
const readCollections = (root) => { const v = readCached(path.join(root, 'collections.json')); return Array.isArray(v) ? v : []; };

/** Whether a mirror is there to read: a sync has finished at least once. */
const hasMirror = (root) => !!root && !!readItems(root);

const readState = (root) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')); } catch { return null; } };
/** A library's name: My Library, else the group's as its last sync found it (else "Group <id>"). */
function libraryName(base, group = '') {
  if (!group) return MY_LIBRARY;
  const state = base ? readState(groupDir(base, group)) : null;
  return state && typeof state.name === 'string' && state.name.trim() ? state.name.trim() : `Group ${group}`;
}

/** The groups mirrored under `base` → [groupID], each with a state.json (synced at least once). */
function groupIds(base) {
  let names = [];
  try { names = fs.readdirSync(path.join(base, 'groups')); } catch { return []; }
  return names.filter((name) => GROUP_RE.test(name) && fs.existsSync(path.join(groupDir(base, name), 'state.json')));
}

/**
 * The libraries mirrored under `base`, as the @ menu shows them: My Library, then each group by name → [{ group, name,
 * root, shown }]. `shown` is unique among them (a group named as another, or as My Library, gets its id after it).
 */
function librariesOf(base) {
  if (!base) return [];
  const groups = groupIds(base).map((group) => ({ group, name: libraryName(base, group), root: groupDir(base, group) }))
    .sort((a, b) => a.name.localeCompare(b.name) || Number(a.group) - Number(b.group));
  const taken = new Set();
  return [{ group: '', name: MY_LIBRARY, root: base }, ...groups].map((lib) => {
    let shown = shownName(lib.name);
    if (taken.has(shown.toLowerCase())) shown = `${shown} (${lib.group})`;
    taken.add(shown.toLowerCase());
    return { ...lib, shown };
  });
}

/** An item by its key, or null. */
function itemOf(root, key) {
  if (!KEY_RE.test(String(key || ''))) return null;
  const items = readItems(root);
  return (items && items.find((item) => item.key === key)) || null;
}

/** "Smith, Jones and Lee" from an item's authors (its other creators when it has none). */
function authorsOf(item, max = 3) {
  const creators = item.creators || [];
  const authors = creators.filter((c) => c.type === 'author');
  const names = (authors.length ? authors : creators).map((c) => c.last || c.name).filter(Boolean);
  if (!names.length) return '';
  if (names.length > max) return `${names[0]} et al.`;
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/* ---------------------------------------------------------------------------------------------------- the @ menu */

const shownName = (name) => String(name || 'Untitled').replace(/\//g, SLASH);

/**
 * One level of the library for the @ menu, as store/folder-files.cjs listFolder answers for a folder: `rel` the
 * collection's path of names ('' the whole library). → { entries: [{ name, rel, dir, type, zotero?, find?, hint? }],
 * total } with its subcollections first, then its items by title (at the top, every item in the library); { missing }
 * for a collection that is gone; { error } before the first sync has finished. An item's `find` is what typing
 * matches besides its title (its authors and year); `hint` what the row shows beside it.
 */
function listLevel(root, rel = '', { group = '' } = {}) {
  const items = root ? readItems(root) : null;
  if (!items) return { error: 'Your Zotero library is still syncing…' };
  const collections = readCollections(root);
  const parts = String(rel || '').split('/').filter(Boolean);
  let parent = null;
  for (const part of parts) {
    const next = collections.find((c) => (c.parent || null) === parent && shownName(c.name) === part);
    if (!next) return { missing: true };
    parent = next.key;
  }
  const subs = collections.filter((c) => (c.parent || null) === parent)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ name: shownName(c.name), rel: [...parts, shownName(c.name)].join('/'), dir: true, type: 'folder' }));
  const held = parent ? items.filter((item) => (item.collections || []).includes(parent)) : items;
  const all = [...subs, ...held.map((item) => itemEntry(item, group))];
  return { entries: all.slice(0, MAX_ENTRIES), total: all.length };
}

/** An item's row in the @ menu; `library` (a group's name) is said beside it where items of several libraries are listed. */
function itemEntry(item, group = '', library = '') {
  const who = authorsOf(item), year = item.year || '';
  const file = (item.attachments || []).some((a) => OPENABLE.includes(a.contentType));
  const ref = refOf(group, item.key);
  return {
    name: item.title || 'Untitled', rel: `~${ref}`, dir: false, type: file ? 'pdf' : item.url ? 'website' : 'md', zotero: ref,
    find: `${who} ${(item.creators || []).map((c) => c.name).join(' ')} ${year} ${item.citeKey || ''}${library ? ` ${library}` : ''}`.toLowerCase(),
    hint: [who, year, library].filter(Boolean).join(' · '),
  };
}

/**
 * Zotero in the @ menu (build 5): at its top, My Library and then each group by name, as folders, then every item of
 * them all (a group's item says its group beside it); `rel` '<library>/<collection path>' one library's level
 * (listLevel), whose items mention it (`zotero:g<groupID>:<key>` for a group's). → listLevel's answers.
 */
function listLibraries(base, rel = '') {
  const libraries = librariesOf(base).filter((lib) => hasMirror(lib.root));
  if (!libraries.length) return { error: 'Your Zotero library is still syncing…' };
  const parts = String(rel || '').split('/').filter(Boolean);
  if (!parts.length) {
    const dirs = libraries.map((lib) => ({ name: lib.shown, rel: lib.shown, dir: true, type: 'folder' }));
    const items = libraries.flatMap((lib) => readItems(lib.root).map((item) => itemEntry(item, lib.group, lib.group ? lib.name : '')))
      .sort((a, b) => a.name.localeCompare(b.name) || a.zotero.localeCompare(b.zotero));
    const all = [...dirs, ...items];
    return { entries: all.slice(0, MAX_ENTRIES), total: all.length };
  }
  const lib = libraries.find((one) => one.shown === parts[0]);
  if (!lib) return { missing: true };
  const level = listLevel(lib.root, parts.slice(1).join('/'), { group: lib.group });
  if (!level.entries) return level;
  return { ...level, entries: level.entries.map((entry) => (entry.dir ? { ...entry, rel: `${lib.shown}/${entry.rel}` } : entry)) };
}

/* --------------------------------------------------------------------------------------------------- attachments */

const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const safeName = (name) => path.basename(String(name || '')).replace(/[\0/\\]/g, '');

/** The attachment an item opens with: its first pdf, else epub, else saved web page; null when it has none. */
function openableOf(item) {
  const list = (item && item.attachments) || [];
  for (const type of OPENABLE) {
    const found = list.find((a) => a.contentType === type && a.linkMode !== 'linked_url');
    if (found) return found;
  }
  return null;
}

/** Where an attachment's file already is on this Mac → { path, source: 'linked' | 'storage' | 'downloaded' }, or null. */
function localFile(root, attachment, { storageDir = defaultStorage() } = {}) {
  if (!attachment || !KEY_RE.test(String(attachment.key || ''))) return null;
  if (attachment.linkMode === 'linked_file') {
    const own = attachment.path && path.isAbsolute(attachment.path) ? attachment.path : '';
    return own && exists(own) ? { path: own, source: 'linked' } : null;
  }
  const name = safeName(attachment.filename);
  if (!name) return null;
  const stored = storageDir ? path.join(storageDir, attachment.key, name) : '';
  if (stored && exists(stored)) return { path: stored, source: 'storage' };
  const downloaded = path.join(root, 'files', attachment.key, name);
  if (exists(downloaded)) return { path: downloaded, source: 'downloaded' };
  return null;
}

/**
 * The file an item opens with → { path, source, attachment }: where it already is (localFile), else, with `download`
 * (sync.cjs download, (key, filename) → path), Zotero's copy fetched into files/. Null when it has no attachment to
 * open, or a linked file that is not on this Mac. A download that fails throws.
 */
async function resolveAttachment(root, item, { storageDir = defaultStorage(), download = null } = {}) {
  const attachment = openableOf(item);
  if (!attachment) return null;
  const here = localFile(root, attachment, { storageDir });
  if (here) return { ...here, attachment };
  if (attachment.linkMode === 'linked_file' || typeof download !== 'function') return null;
  const file = await download(attachment.key, attachment.filename);
  return { path: file, source: 'downloaded', attachment };
}

// A copy kept for an item with no file of its own (./oa.cjs keptCopy's `source`): found free, or brought by the person.
const KEPT = new Set(['open access', 'downloaded in browser', 'added by hand']);

/**
 * The pdf (or other file) an item is read from → { path, source: 'linked' | 'storage' | 'downloaded' | 'open access' |
 * 'downloaded in browser' | 'added by hand', attachment?, url?, foundAt?, via?, from? }, or { failed } when it has none:
 * its own attachment first (resolveAttachment), else, when it has none that can be had, the copy kept for it
 * (`openAccess(item)`, sync.cjs's, → ./oa.cjs find's answer or null).
 */
async function resolvePdf(root, item, options = {}) {
  let failed = '';
  try {
    const own = await resolveAttachment(root, item, options);
    if (own) return own;
  } catch (error) { failed = error && error.message ? error.message : 'The file could not be downloaded.'; }
  let free = null;
  try { free = typeof options.openAccess === 'function' ? await options.openAccess(item) : null; } catch { free = null; }
  if (free && free.path) return { path: free.path, source: KEPT.has(free.source) ? free.source : 'open access', url: free.url || '', foundAt: free.foundAt || '', via: free.via || 'OpenAlex', ...(free.from ? { from: free.from } : {}) };
  return { failed };
}

/** An item's page in the default browser: its DOI's, else its URL; '' when it has neither. */
function pageOf(item) {
  const doi = String(item.doi || '').trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  if (doi) return `https://doi.org/${doi}`;
  return /^https?:\/\//i.test(String(item.url || '')) ? item.url : '';
}

/**
 * What a mention of item `key` opens (a chip clicked) → { path, source } its file, a free copy found now when it has
 * none of its own (opened in the paper viewer); else { url, external: true } its DOI's page or its URL (the default
 * browser); else { error }.
 */
async function openTarget(root, key, options = {}) {
  const item = root ? itemOf(root, key) : null;
  if (!item) return { error: goneWords(root, options.library) };
  const found = await resolvePdf(root, item, options);
  if (found.path) return { path: found.path, source: found.source };
  const url = pageOf(item);
  if (url) return { url, external: true };
  return { error: found.failed || 'This item has no file or address to open.' };
}

/** Why an item cannot be read: gone from its library, its group no longer the person's, or nothing synced yet. */
function goneWords(root, library) {
  if (library && library.group) return hasMirror(root) ? `This item is no longer in the Zotero group "${library.name}".` : 'This item is in a Zotero group you are no longer in, or that has not synced yet.';
  return hasMirror(root) ? 'This item is no longer in your Zotero library.' : 'Your Zotero library is not synced yet.';
}

/* ------------------------------------------------------------------------------------------------ Bart's context */

const attr = (value, max = 300) => String(value ?? '').replace(/[<>"\n\r]/g, ' ').slice(0, max);
const cut = (text, max) => { const s = String(text || '').trim(); return s.length > max ? `${s.slice(0, max)}… [cut]` : s; };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };

/**
 * The <zotero_item> block for a mention of item `key` (`name` the title the mention was written with) → { lines, file }:
 * its metadata, its BibTeX, its notes, its annotations (quote, comment and page), and where its attachment's file and
 * indexed text are on disk (`file`, so the agent may be granted its folder). The attachment is downloaded now when it is
 * not on this Mac (`download`); one that cannot be is named as such. An item the mirror does not hold → a `missing` line.
 * `library` { group, name } (build 5): the library it is in, said as library="…" (and group="<id>" for a group's).
 */
async function itemBlock(root, key, name = '', options = {}) {
  const item = root ? itemOf(root, key) : null;
  const where = libraryAttrs(options.library);
  if (!item) return { lines: [`<zotero_item key="${attr(key, 40)}" title="${attr(name)}"${where} missing="true" />`], file: '', missing: true };
  const dir = path.join(root, 'items', item.key);
  const resolved = await resolvePdf(root, item, options);
  const found = resolved.path && !KEPT.has(resolved.source) ? resolved : null;
  const free = resolved.path && KEPT.has(resolved.source) ? resolved : null;
  const failed = resolved.failed || '';
  const openable = openableOf(item);
  const texts = (item.attachments || []).map((a) => path.join(dir, `fulltext-${a.key}.txt`)).filter(exists);
  const head = [
    `title: ${item.title}`,
    ...(options.library ? [`library: ${options.library.group ? `${options.library.name} (Zotero group ${options.library.group})` : `${MY_LIBRARY} (the person's own Zotero library)`}`] : []),
    ...(item.creators && item.creators.length ? [`creators: ${item.creators.map((c) => (c.type && c.type !== 'author' ? `${c.name} (${c.type})` : c.name)).join('; ')}`] : []),
    ...(item.year ? [`year: ${item.year}`] : []),
    `type: ${item.itemType}`,
    ...(item.publication ? [`publication: ${item.publication}`] : []),
    ...(item.doi ? [`doi: ${item.doi}`] : []),
    ...(item.url ? [`url: ${item.url}`] : []),
    ...(item.tags && item.tags.length ? [`tags: ${item.tags.join(', ')}`] : []),
    ...collectionNames(root, item).map((p) => `collection: ${p}`),
    found ? `attachment: ${found.path} (${found.attachment.contentType || 'file'})`
      : openable ? `attachment: ${openable.filename || openable.title || openable.key} (${openable.contentType || 'file'}), not on this Mac${failed ? `: ${failed}` : ''}`
        : 'attachment: none',
    ...(free ? [`pdf: ${free.path} (${keptNote(free)})`] : []),
    ...texts.map((file) => `full text: ${file}`),
    `folder: ${dir}`,
  ];
  const lines = [`<zotero_item key="${attr(item.key, 40)}" cite="${attr(item.citeKey, 200)}"${where}>`, ...head];
  if (item.abstractNote) lines.push('<abstract>', cut(item.abstractNote, 6000), '</abstract>');
  const bib = readText(path.join(dir, 'item.bib')).trim();
  if (bib) lines.push('<bibtex>', bib, '</bibtex>');
  let children = null;
  try { children = JSON.parse(readText(path.join(dir, 'children.json')) || 'null'); } catch { children = null; }
  const notes = (children && children.notes) || [];
  if (notes.length) {
    let room = MAX_NOTES_CHARS;
    lines.push('<notes>');
    for (const note of notes) {
      if (room <= 0) { lines.push(`[${notes.length - notes.indexOf(note)} more notes in ${path.join(dir, 'children.json')}]`); break; }
      const text = cut(note.text, Math.min(MAX_NOTE_CHARS, room));
      room -= text.length;
      lines.push('<note>', text, '</note>');
    }
    lines.push('</notes>');
  }
  const annotations = (children && children.annotations) || [];
  if (annotations.length) {
    lines.push('<annotations>');
    for (const a of annotations.slice(0, MAX_ANNOTATIONS)) {
      lines.push(`<annotation type="${attr(a.type, 40)}"${a.page ? ` page="${attr(a.page, 40)}"` : ''}>`);
      if (a.text) lines.push('<quote>', a.text.trim(), '</quote>');
      if (a.comment) lines.push('<comment>', a.comment.trim(), '</comment>');
      lines.push('</annotation>');
    }
    if (annotations.length > MAX_ANNOTATIONS) lines.push(`[${annotations.length - MAX_ANNOTATIONS} more in ${path.join(dir, 'children.json')}]`);
    lines.push('</annotations>');
  }
  lines.push('</zotero_item>');
  return { lines, file: resolved.path || '', missing: false };
}

/** library="…" (and group="<id>") for a <zotero_item>: '' when the library is not known. */
function libraryAttrs(library) {
  if (!library) return '';
  return library.group ? ` library="${attr(library.name)}" group="${attr(library.group, 20)}"` : ` library="${MY_LIBRARY}"`;
}

/**
 * The <zotero_item> block for a mention's target (`ref`, parseRef) → itemBlock's answer, read from its library's mirror
 * under `base`. `service` (./sync.cjs's): its library(group) downloads, finds free copies and knows Zotero's storage.
 */
async function mentionBlock(base, ref, name = '', service = null) {
  const parsed = parseRef(ref);
  if (!parsed) return { lines: [`<zotero_item key="${attr(ref, 60)}" title="${attr(name)}" missing="true" />`], file: '', missing: true };
  const lib = service && typeof service.library === 'function' ? service.library(parsed.group) : null;
  const options = lib ? { download: lib.download, ...(lib.openAccess ? { openAccess: lib.openAccess } : {}), ...(lib.storageDir ? { storageDir: lib.storageDir } : {}) } : {};
  return itemBlock(base ? libraryRoot(base, parsed.group) : null, parsed.key, name, { ...options, library: { group: parsed.group, name: libraryName(base, parsed.group) } });
}

/** Where a kept copy came from, for its "pdf:" line: source="…" and in words. */
function keptNote(copy) {
  const on = copy.foundAt ? ` on ${copy.foundAt.slice(0, 10)}` : '';
  if (copy.source === 'downloaded in browser') return `source="downloaded in browser": the person downloaded it in their browser${on}, after Engelbart opened the item's page there`;
  if (copy.source === 'added by hand') return `source="added by hand": the person chose this file as the item's pdf${on}`;
  return `source="open access": found through ${copy.via || 'OpenAlex'}${copy.url ? ` at ${copy.url}` : ''}${on}`;
}

function collectionNames(root, item) {
  const byKey = new Map(readCollections(root).map((c) => [c.key, c]));
  return (item.collections || []).map((key) => byKey.get(key)).filter(Boolean).map((c) => c.path || c.name);
}

/**
 * The line every @bart turn carries when a mirror is there (./sync.cjs): where it is and what it holds, so Bart can search
 * the library when asked about it. '' when there is none.
 */
function pointerLine(root) {
  if (!root) return '';
  const lines = [];
  const items = readItems(root);
  if (items) lines.push(`zotero library: ${root} (My Library, ${items.length} items; items.json, collections.json, library.bib, and items/<key>/ with item.bib, children.json and fulltext-*.txt)`);
  // Build 5: each group's mirror, with the same files.
  for (const lib of librariesOf(root).slice(1)) {
    const held = readItems(lib.root);
    if (held) lines.push(`zotero group: ${lib.root} ("${attr(lib.name, 200)}", group ${lib.group}, ${held.length} items; the same files)`);
  }
  return lines.join('\n');
}

module.exports = { KEPT, mirrorDir, defaultStorage, hasMirror, readItems, itemOf, authorsOf, listLevel, listLibraries, librariesOf, libraryName, libraryRoot, groupDir, groupIds, parseRef, refOf, openableOf, localFile, resolveAttachment, resolvePdf, pageOf, openTarget, itemBlock, mentionBlock, pointerLine, SLASH, KEY_RE, GROUP_RE, MY_LIBRARY };
