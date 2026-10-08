'use strict';

// The files inside a library folder (MATH-22, 2026-10-06). A folder added by path is one library row (`folder_path`);
// what is in it is not, and is never indexed: the @ menu lists a level of it live from disk when it is opened
// (listFolder), and a file mentioned in a document, `@[Name](lib:<folderId>:<path>)` (renderer/model/doc.js), is found
// again by its folder's row and its path inside it (folderFile) when the line is drawn, clicked, or given to an agent.
// The listing follows the peek's rules (library.previewItem: no .git, no .DS_Store) and the @ menu's: no dotfiles, no
// node_modules, only the formats the library knows (library.FILE_TYPES). Nothing leaves the folder: a path is resolved
// with its symlinks, and one that ends outside the folder is refused.

const fs = require('node:fs');
const path = require('node:path');
const { FILE_TYPES, PEEK_SKIP } = require('./library.cjs');

const ID_RE = /^[\w-]{1,64}$/;
const MAX_ENTRIES = 2000; // a level listed: the menu filters these as it is typed into, and shows ten
const MAX_REL = 4096;
const MAX_BATCH = 200;
const SKIP = new Set([...PEEK_SKIP, 'node_modules']);

const inside = (file, dir) => file === dir || file.startsWith(dir + path.sep);
const realOrNull = (file) => { try { return fs.realpathSync(file); } catch { return null; } };

/** A path inside a folder as given (not encoded) → its segments, or a TypeError for one that could leave the folder. */
function segmentsOf(rel) {
  if (rel == null || rel === '') return [];
  if (typeof rel !== 'string' || rel.length > MAX_REL || rel.includes('\0')) throw new TypeError('path is invalid');
  if (path.isAbsolute(rel) || rel.includes('\\')) throw new TypeError('path must be relative to its folder');
  const parts = rel.split('/').filter((part) => part && part !== '.');
  if (parts.some((part) => part === '..')) throw new TypeError('path must stay inside its folder');
  return parts;
}

/** The folder row `id` names → { row, root }: `root` its real path, null when it is not on this Mac (or not in home). */
async function folderOf(ctx, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new TypeError('library id is invalid');
  const row = await ctx.libraryDb.get(id);
  if (!row) throw new Error('Unknown library item');
  if (!row.folder_path) throw new Error('This item is not a folder on this Mac');
  const home = realOrNull(ctx.homeDir) || path.resolve(ctx.homeDir);
  const root = realOrNull(row.folder_path);
  let dir = false;
  try { dir = !!root && fs.statSync(root).isDirectory(); } catch { dir = false; }
  return { row, root: dir && inside(root, home) ? root : null };
}

/**
 * `rel` inside `root` → its real path, or null when nothing is there. Throws when the path, its symlinks followed, ends
 * outside the folder.
 */
function resolveInside(root, rel) {
  const parts = segmentsOf(rel);
  const target = path.join(root, ...parts);
  const real = realOrNull(target);
  if (!real) return null;
  if (!inside(real, root)) throw new Error('That path leaves its folder');
  return real;
}

/** What the menu shows of a file or folder name: a format the library knows, else null (left out). */
const typeOf = (name) => FILE_TYPES.get(path.extname(name).toLowerCase()) || null;

/**
 * One level of a library folder for the @ menu (MF-01, MF-02): `rel` the path of the level inside it ('' its top). →
 * { id, name, rel, missing, entries: [{ name, rel, dir, type }], total }: subfolders first, then files, each by name;
 * `total` how many there were before MAX_ENTRIES. `missing`: the folder (or the level) is not there.
 */
async function listFolder(ctx, id, rel = '') {
  const parts = segmentsOf(rel);
  const { row, root } = await folderOf(ctx, id);
  const out = { id: row.id, name: row.name, rel: parts.join('/'), missing: false, entries: [], total: 0 };
  if (!root) return { ...out, missing: true };
  const dir = resolveInside(root, out.rel);
  let listed;
  try { listed = dir && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir, { withFileTypes: true }) : null; } catch { listed = null; }
  if (!listed) return { ...out, missing: true };
  const entries = [];
  for (const entry of listed) {
    const name = entry.name;
    if (name.startsWith('.') || SKIP.has(name)) continue;
    let isDir = entry.isDirectory(), isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      // Followed, it must land inside the folder; a link out of it (or a broken one) is not listed.
      const real = realOrNull(path.join(dir, name));
      if (!real || !inside(real, root)) continue;
      try { const stat = fs.statSync(real); isDir = stat.isDirectory(); isFile = stat.isFile(); } catch { continue; }
    }
    if (isDir) entries.push({ name, rel: [...parts, name].join('/'), dir: true, type: 'folder' });
    else if (isFile && typeOf(name)) entries.push({ name, rel: [...parts, name].join('/'), dir: false, type: typeOf(name) });
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  return { ...out, entries: entries.slice(0, MAX_ENTRIES), total: entries.length };
}

/**
 * A mentioned file (MF-05, MF-06) → { folderId, folder, rel, path, exists, dir, type }: `path` absolute (its real path
 * when it is there, else where it would be), `folder` the folder row's name. A path that leaves the folder throws.
 */
async function folderFile(ctx, id, rel) {
  if (!segmentsOf(rel).length) throw new TypeError('path is invalid');
  const { row } = await folderOf(ctx, id);
  return fileInRow(row, rel, ctx.homeDir);
}

/**
 * folderFile's answer from a row already read (the context's: bart/context.cjs, context/expand-mentions.cjs), without a
 * database: `homeDir` the folder must be inside. A path that leaves the folder throws.
 */
function fileInRow(row, rel, homeDir) {
  const parts = segmentsOf(rel);
  if (!parts.length || !row || !row.folder_path) throw new TypeError('path is invalid');
  const home = realOrNull(homeDir) || path.resolve(homeDir);
  let root = realOrNull(row.folder_path);
  try { if (!root || !fs.statSync(root).isDirectory() || !inside(root, home)) root = null; } catch { root = null; }
  const base = { folderId: row.id, folder: row.name, rel: parts.join('/'), type: typeOf(parts[parts.length - 1]) };
  if (!root) return { ...base, path: path.join(path.resolve(row.folder_path), ...parts), exists: false, dir: false };
  const real = resolveInside(root, base.rel);
  let stat = null;
  try { stat = real ? fs.statSync(real) : null; } catch { stat = null; }
  return { ...base, path: real || path.join(root, ...parts), exists: !!stat && (stat.isFile() || stat.isDirectory()), dir: !!stat && stat.isDirectory() };
}

/** Many at once (the lines on screen): [{ folderId, rel }] → [{ folderId, rel, exists, dir }], a failure as not there. */
async function folderFiles(ctx, list) {
  if (!Array.isArray(list)) throw new TypeError('files must be a list');
  const out = [];
  for (const item of list.slice(0, MAX_BATCH)) {
    const folderId = item && item.folderId, rel = item && item.rel;
    try {
      const found = await folderFile(ctx, folderId, rel);
      out.push({ folderId, rel, exists: found.exists, dir: found.dir });
    } catch {
      out.push({ folderId: String(folderId || ''), rel: String(rel || ''), exists: false, dir: false });
    }
  }
  return out;
}

module.exports = { listFolder, folderFile, folderFiles, fileInRow, resolveInside, segmentsOf, MAX_ENTRIES };
