// The text that mentions a library row, and a row of the sidebar dragged onto the document (2026-10-17).
//
// mentionToken is the one place a picked row of the @ menu becomes its token (DocEditor's @ menu writes it), and a row
// dragged from the sidebar is written by it too, so a drop and a pick read the same. A drag of rows carries LIB_DRAG_TYPE:
// the document writes their mentions where they are let go, and nothing that reads a drop from Finder or a browser
// (model/drop.js readDrop, the workspace's onDropItems) ever sees one, or it would add the row to the library again.
import { wsMention, libMention, webName, isAddress, fileMention, zoteroMention } from './doc.js';

// A library row of a page on the web, a repository known by its address among them: it has an address and nothing on this Mac.
export const isWebRow = (row) => !!row && row.type === 'website' && !!row.url && !row.path && !row.folder_path;

// The token a picked row of the @ menu writes: a workspace's, a Zotero item's (MATH-65 build 2), a file's or a subfolder's
// in a library folder (MATH-22), a web page's by its id under its title (2026-10-17: never its address, model/web-name.js), a
// picture's by its id under its name (2026-10-17: pasted ones share names, "Attachment 1"),
// else a mention by name. The open page the library does not hold yet has no id: it is mentioned by name, its title's.
export const mentionToken = (r) => (r.kind === 'workspace' ? wsMention(r.name, r.id)
  : r.kind === 'entry' && r.zotero ? zoteroMention(r.name, r.zotero)
    : (r.kind === 'entry' || r.kind === 'self') && r.rel ? fileMention(r.kind === 'self' ? r.entryName : r.name, r.row.id, r.rel)
      : r.kind === 'item' && isWebRow(r.row) ? libMention(webName(r.row.name, r.row.url), r.row.id)
        : r.kind === 'item' && r.row && r.row.type === 'image' ? libMention(r.row.name, r.row.id)
        : r.kind === 'fresh' && isAddress(r.input) ? `@[${webName(r.name, r.input)}]`
          : `@[${r.name}]`);

// A library row as the @ menu lists it (model/rail.js), and the token picking it there writes.
export const menuItem = (row) => ({ kind: 'item', key: row.id, row, name: row.name });
export const rowMention = (row) => mentionToken(menuItem(row));

export const LIB_DRAG_TYPE = 'application/x-engelbart-lib';

/** Whether a drag is of rows of the sidebar. Only the types can be read while it is under way. */
export function carriesLibRows(event) {
  const types = (event && event.dataTransfer && event.dataTransfer.types) || [];
  return [...types].includes(LIB_DRAG_TYPE);
}

// What a dragged row carries: enough to write its mention when the document's library does not list it.
const snapshot = (row) => ({ id: row.id, name: row.name, type: row.type, url: row.url || null, path: row.path || null, folder_path: row.folder_path || null });

/** Starts a drag of `rows`: their ids and names, and their mentions as plain text for anywhere else they are let go. */
export function writeLibDrag(dataTransfer, rows) {
  const list = rows.filter((row) => row && row.id);
  if (!dataTransfer || !list.length) return false;
  dataTransfer.setData(LIB_DRAG_TYPE, JSON.stringify(list.map(snapshot)));
  dataTransfer.setData('text/plain', list.map(rowMention).join(' '));
  dataTransfer.effectAllowed = 'copy';
  return true;
}

/** The rows a drop of the sidebar's carries, [] when it carries none (read inside the drop event). */
export function readLibDrag(dataTransfer) {
  try {
    const rows = JSON.parse(dataTransfer.getData(LIB_DRAG_TYPE) || '[]');
    return Array.isArray(rows) ? rows.filter((row) => row && row.id != null && row.id !== '' && typeof row.name === 'string') : [];
  } catch { return []; }
}
