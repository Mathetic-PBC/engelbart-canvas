'use strict';

// Obsidian's vaults as its file explorer shows them (2026-10-14), for Import your context's Choose files under Obsidian:
// "clicking choose files on obsidian should open a picker like the obsidian sidebar, right now it opens the native file
// picker where there is no way for me to find the obsidian files easily". The vaults Obsidian knows (obsidian.json, via
// ../connect/readers.cjs), each read as a tree: folders first, then files, each by name as Obsidian sorts them; dot
// folders (.obsidian, .trash, .git) and node_modules left out, as Obsidian hides them. Read off the main thread's way
// (fs.promises), and capped so a huge vault cannot hold the picker up.

const fs = require('node:fs');
const path = require('node:path');
const readers = require('../connect/readers.cjs');

/** The files Obsidian's explorer lists that an import can read. */
const SHOWN = /\.(md|canvas|pdf|png|jpe?g|gif|svg|webp|txt|csv)$/i;
const MAX_ENTRIES = 5000;
const MAX_DEPTH = 10;

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * → { vaults: [{ name, path, tree: [{ name, path, dir, children? }] }], truncated } for `homeDir`'s Obsidian vaults.
 * A file's `name` is shown as Obsidian shows it: a note without its .md.
 */
async function obsidianTree(homeDir, { maxEntries = MAX_ENTRIES, platform = process.platform, env = process.env } = {}) {
  let seen = 0;
  let truncated = false;
  async function read(dir, depth) {
    if (depth > MAX_DEPTH) return [];
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return []; }
    const folders = [];
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (seen >= maxEntries) { truncated = true; break; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { seen += 1; folders.push({ name: entry.name, path: full, dir: true }); } else if (entry.isFile() && SHOWN.test(entry.name)) {
        seen += 1;
        files.push({ name: entry.name.replace(/\.md$/i, ''), path: full, dir: false });
      }
    }
    folders.sort(byName);
    files.sort(byName);
    for (const folder of folders) folder.children = await read(folder.path, depth + 1);
    return [...folders, ...files];
  }
  const vaults = [];
  for (const vault of readers.obsidianVaults(homeDir, platform, env)) vaults.push({ name: vault.name, path: vault.path, tree: await read(vault.path, 0) });
  return { vaults, truncated };
}

module.exports = { obsidianTree };
