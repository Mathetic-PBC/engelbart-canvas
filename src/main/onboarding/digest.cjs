'use strict';

// The project digest (moved out of ./discover.cjs on 2026-10-13 so the scanner process can run it without loading
// Connect's session): what the person worked on lately, read from this Mac without a model.

const path = require('node:path');
const readers = require('../connect/readers.cjs');
const scan = require('../connect/scan.cjs');

const DIGEST_DAYS = 120;
const dayOf = (iso) => String(iso || '').slice(0, 10);

/**
 * What the person worked on lately, read from this Mac without a model → { folders, vaults, zotero, projects }:
 *   folders  the folders their Claude Code and Codex sessions ran in, the busiest and most recent first, each with how
 *            many sessions, the last day, the repository it is in, and the newest sessions' titles
 *   vaults   each Obsidian vault's notes changed lately (title and folder)
 *   zotero   the collections of their Zotero library (Engelbart's copy), when signed in
 *   projects the Engelbart projects they have already (so a project is not offered twice)
 */
function projectDigest({ homeDir, env = process.env, access = null, zoteroRoot = null, existing = [], days = DIGEST_DAYS }) {
  const byFolder = new Map();
  for (const app of ['Claude Code', 'Codex']) {
    let chats = [];
    try { chats = readers.localChats(app, { homeDir, env, days, limit: 400 }); } catch { chats = []; }
    for (const chat of chats) {
      const key = chat.project || '(no folder)';
      const entry = byFolder.get(key) || { shown: key, sessions: 0, last: '', apps: new Set(), titles: [] };
      entry.sessions += 1;
      entry.apps.add(app);
      if (chat.date > entry.last) entry.last = chat.date;
      if (entry.titles.length < 10 && chat.title && !entry.titles.includes(chat.title)) entry.titles.push(chat.title);
      byFolder.set(key, entry);
    }
  }
  let repos = [];
  try { repos = scan.localRepos({ homeDir, env, access }); } catch { repos = []; }
  const repoOf = (shownPath) => repos.find((repo) => shownPath === repo.shown || shownPath.startsWith(`${repo.shown}/`)) || null;
  const folders = [...byFolder.values()]
    .map((entry) => {
      const repo = repoOf(entry.shown);
      const full = entry.shown.startsWith('~') ? path.join(homeDir, entry.shown.slice(1)) : entry.shown;
      return { shown: entry.shown, path: path.isAbsolute(full) ? full : '', name: path.basename(full) || entry.shown, sessions: entry.sessions, last: dayOf(entry.last), apps: [...entry.apps], repository: repo ? repo.shown : null, titles: entry.titles };
    })
    .sort((a, b) => b.last.localeCompare(a.last) || b.sessions - a.sessions)
    .slice(0, 25);
  const vaults = [];
  let found = [];
  try { found = readers.obsidianVaults(homeDir); } catch { found = []; }
  for (const vault of found.slice(0, 3)) {
    if (access && !access.readable(vault.path)) continue;
    let files = [];
    try { files = readers.noteFiles(vault.path, { days: 60, max: 60, readable: access ? access.readable : null }); } catch { files = []; }
    const notes = files.slice(0, 40).map((file) => ({ title: path.basename(file).replace(/\.(md|markdown|txt)$/i, ''), folder: path.relative(vault.path, path.dirname(file)) || '.' }));
    vaults.push({ vault: vault.shown, notes });
  }
  let zotero = [];
  if (zoteroRoot) { try { zotero = readers.zoteroCollections(zoteroRoot).collections.slice(0, 40).map((one) => ({ name: one.path, items: one.items })); } catch { zotero = []; } }
  return { folders, vaults, zotero, projects: existing.slice(0, 30) };
}

module.exports = { projectDigest, DIGEST_DAYS };
