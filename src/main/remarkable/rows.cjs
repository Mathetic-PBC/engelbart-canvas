'use strict';

// The library's rows for the reMarkable documents (2026-10-31, after "you can't actually interact with the remarkable
// files"): one row per document, its PDF in the mirror (./sync.cjs), or its `.md` for an ebook, so a notebook is found
// by the library's search and the @ menu, opens in the Stage's paper viewer, joins a workspace, takes highlights and
// notes, and reaches Bart, as any paper does. Until then the mirror was one folder row, which the Stage could not open.
//
// A row is the same row for as long as its document is the same document: <root>/rows.json maps each document's id to
// its row and to the name and file the row was last given. A rename or a move on the tablet renames the row or points
// it at the new file (its ink, highlights, stars and links in Engelbart stay with it); a name changed in Engelbart is
// kept until the tablet's name changes. A document gone from the tablet (deleted, or in its trash) takes its row with
// it. A PDF row is left to be read for whether it is a paper (categorized null), as a PDF added by hand is.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { libraryDir } = require('./sync.cjs');

const CATEGORY_RULES = 1; // library.cjs CATEGORY_RULES: an md row needs no reading

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`);
  fs.renameSync(temporary, file);
}
const realOr = (file) => { try { return fs.realpathSync(file); } catch { return file; } };

/** The file a document's row points at, relative to library/: its PDF, else its `.md`; null when it has neither yet. */
const fileOf = (item) => (item.files || []).find((f) => f.endsWith('.pdf')) || (item.files || []).find((f) => f.endsWith('.md')) || null;

/**
 * Brings the library's rows up to the mirror at `root` (mirrorDir(<dataRoot>)). `ctx`: the store's context (its
 * libraryDb). → { added, changed, removed }, counts.
 */
async function reconcileRows(ctx, root) {
  const state = readJson(path.join(root, 'state.json'));
  // No mirror to follow (disconnected, or its state unreadable this moment): the rows are left as they are. Taking
  // them away is disconnecting's alone (removeRows).
  if (!state || state.v !== 1 || !state.connected) return { added: 0, changed: 0, removed: 0 };
  const mapFile = path.join(root, 'rows.json');
  const map = readJson(mapFile) || {};
  // Spelled from the data root as given, as the library's own copies are: what a row's path is checked against
  // (inside the home folder) is spelled that way too.
  const library = libraryDir(root);
  const real = realOr(library);
  const rows = new Map((await ctx.libraryDb.list()).map((row) => [row.id, row]));
  const out = { added: 0, changed: 0, removed: 0 };
  const next = {};

  // The one folder row an earlier build added for the whole mirror (the Stage could not open it): taken away.
  for (const row of rows.values()) {
    if (row.type === 'folder' && row.folder_path && (row.folder_path === library || row.folder_path === real)) {
      await ctx.libraryDb.remove(row.id);
      out.removed += 1;
    }
  }

  const items = state.items || {};
  // A row is one document's: the rows still mapped to documents the mirror has are theirs, and adopting a row by its
  // file never takes one of those (a rename and a new document of the old name in one sync).
  const claimed = new Set(Object.entries(map).filter(([docId, was]) => was && items[docId] && rows.has(was.row)).map(([, was]) => was.row));
  for (const [docId, item] of Object.entries(items)) {
    if (item.kind !== 'document') continue;
    const rel = fileOf(item);
    if (!rel) continue;
    const file = path.join(library, rel);
    const type = rel.endsWith('.pdf') ? 'pdf' : 'md';
    const name = String(item.name || item.base || 'Untitled').slice(0, 512);
    const was = map[docId];
    let row = was && rows.get(was.row);
    if (!row) { // a row for this file already, nobody else's (adopted)
      row = [...rows.values()].find((r) => r.path === file && !claimed.has(r.id)) || null;
      if (row) claimed.add(row.id);
    }
    if (!row) {
      row = await ctx.libraryDb.insert({ id: randomUUID(), name, type, tags: [], path: file, url: null, folder_path: null, project_id: null, github_id: null, categorized: type === 'pdf' ? null : CATEGORY_RULES });
      rows.set(row.id, row);
      claimed.add(row.id);
      out.added += 1;
    } else {
      if ((!was || was.name !== name) && row.name !== name) { row = (await ctx.libraryDb.rename(row.id, name)) || { ...row, name }; out.changed += 1; }
      if (row.path !== file) { row = (await ctx.libraryDb.updatePath(row.id, file)) || { ...row, path: file }; out.changed += 1; }
      rows.set(row.id, row);
    }
    next[docId] = { row: row.id, name, file };
  }
  // Documents gone from the tablet: their rows go too.
  for (const [docId, was] of Object.entries(map)) {
    if (next[docId] || !was || !rows.has(was.row)) continue;
    await ctx.libraryDb.remove(was.row);
    out.removed += 1;
  }
  writeJson(mapFile, next);
  return out;
}

/** Takes every reMarkable row out of the library (disconnecting). → how many. */
async function removeRows(ctx, root) {
  const map = readJson(path.join(root, 'rows.json')) || {};
  let removed = 0;
  for (const was of Object.values(map)) if (was && was.row && await ctx.libraryDb.remove(was.row)) removed += 1;
  return removed;
}

module.exports = { reconcileRows, removeRows };
