'use strict';

// Papers a Build cannot lose (2026-10-07, "Bart build agents": a Build may write outside its copy, "but it should not
// be able [to delete] papers … It should be able to delete code files of course"). Its agent's shell is not confined,
// so this is not a wall but what holds after any turn, whichever CLI ran it and however it went about it:
//
//   before a turn  every file the library holds (papers, notes, saved pages, pictures, datasets) and the ink on them
//                  (<data root>/annotations) is kept aside as a hard link: no space and no time to speak of, and the
//                  file's bytes stay whatever is done to its name (deleted, moved away, replaced by another file). A file
//                  on another volume, where a link cannot go, is copied when it is at most 20 MB. (Node does not clone on
//                  macOS: COPYFILE_FICLONE copies the whole file, and _FORCE is not implemented.)
//   after it       one that is gone is put back, and so is a paper or a picture, or any file in the folders where
//                  Engelbart keeps its saved copies (assets), that another file replaced. A note or a dataset the agent
//                  edits is its work, and stays. A file rewritten in place shares the link and cannot be put back: the
//                  edit tools are refused on papers for that (./policy.cjs claudeSettings)
//
// What the person did meanwhile is left alone: a row deleted, or moved (a note renamed), is not put back, nor the ink of
// a row that went. Code is not the library's: the worktree's files the agent deletes stay deleted.

const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 20_000; // files kept, at most, for one turn
const FAR_MAX = 20 * 1024 * 1024; // a file on another volume is copied up to this size
const PAPERS = new Set(['pdf', 'image']); // rows whose bytes are put back when they change: nobody edits them by hand
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const inside = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);

function walk(dir, out, limit) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out, limit);
    else if (entry.isFile()) out.push(file);
  }
}

/** `file` kept at `to`: a hard link, else (another volume) a copy of a file of at most FAR_MAX. → 'link' | 'copy' | null */
function keepOne(file, to, size) {
  try { fs.linkSync(file, to); return 'link'; } catch { /* another volume, or a file system without links */ }
  if (size > FAR_MAX) return null;
  try { fs.copyFileSync(file, to); return 'copy'; } catch { return null; }
}

/** The kept file back at `file`, in place of whatever is there, whole or not at all. */
function putBack(entry) {
  fs.mkdirSync(path.dirname(entry.file), { recursive: true });
  const temporary = `${entry.file}.engelbart-${process.pid}.tmp`;
  fs.rmSync(temporary, { force: true });
  if (entry.how === 'link') { try { fs.linkSync(entry.copy, temporary); } catch { fs.copyFileSync(entry.copy, temporary); } } else fs.copyFileSync(entry.copy, temporary);
  fs.renameSync(temporary, entry.file);
}

function sameBytes(a, b) {
  try { return fs.readFileSync(a).equals(fs.readFileSync(b)); } catch { return false; }
}

/**
 * The library's files and their ink, kept in `dir` (emptied first; removed by `restore`). `kept`: the folders whose
 * files are all saved copies (./policy.cjs). → { count, papers: the pdf and picture files outside `kept`,
 * restore() → [{ name, file, how: 'deleted' | 'changed' }] }
 */
async function keepLibrary(ctx, { dir, kept = [] }) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries = [];
  const papers = [];
  const keep = (file, about) => {
    if (entries.length >= LIMIT) return;
    let stat;
    try { stat = fs.statSync(file); } catch { return; }
    if (!stat.isFile()) return;
    const copy = path.join(dir, String(entries.length));
    const how = keepOne(file, copy, stat.size);
    if (how) entries.push({ ...about, file, copy, how, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
  };
  for (const row of await ctx.libraryDb.list()) {
    if (typeof row.path !== 'string' || !path.isAbsolute(row.path)) continue;
    const saved = kept.some((folder) => inside(folder, row.path));
    keep(row.path, { id: row.id, name: row.name, bytes: saved || PAPERS.has(row.type) });
    if (PAPERS.has(row.type) && !saved) papers.push(row.path);
  }
  const ink = [];
  walk(path.join(ctx.dataRoot, 'annotations'), ink, LIMIT);
  for (const file of ink) {
    const stem = path.basename(file, path.extname(file));
    keep(file, { name: 'highlights and notes', of: UUID_RE.test(stem) ? stem : null, bytes: false });
  }

  async function restore() {
    const back = [];
    try {
      const rows = new Map((await ctx.libraryDb.list()).map((row) => [row.id, row]));
      for (const entry of entries) {
        if (entry.id && (!rows.has(entry.id) || rows.get(entry.id).path !== entry.file)) continue;
        if (entry.of && !rows.has(entry.of)) continue;
        let now = null;
        try { now = fs.lstatSync(entry.file); } catch { now = null; }
        try {
          if (!now) {
            putBack(entry);
            back.push({ name: entry.name, file: entry.file, how: 'deleted' });
            continue;
          }
          if (!entry.bytes || now.isDirectory()) continue;
          // A link sees what was written into the file it shares, so only a file put in its place can be told apart.
          const replaced = !now.isFile() || now.ino !== entry.ino;
          const changed = entry.how === 'link' ? replaced : replaced || now.size !== entry.size || now.mtimeMs !== entry.mtimeMs;
          if (changed && !(now.isFile() && sameBytes(entry.file, entry.copy))) {
            putBack(entry);
            back.push({ name: entry.name, file: entry.file, how: 'changed' });
          }
        } catch { /* left as it is: the next turn keeps what is there then */ }
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return back;
  }

  return { count: entries.length, papers, restore };
}

module.exports = { keepLibrary };
