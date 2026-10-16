'use strict';

// The project digest (moved out of ./discover.cjs on 2026-10-13 so the scanner process can run it without loading
// Connect's session): what the person worked on lately, read from this Mac without a model.

const fs = require('node:fs');
const path = require('node:path');
const readers = require('../connect/readers.cjs');
const scan = require('../connect/scan.cjs');

const DIGEST_DAYS = 120;
const dayOf = (iso) => String(iso || '').slice(0, 10);

// Never looked in for repositories: what macOS guards (asked about only once the person connects it), apps and media.
const REPO_SKIP = new Set(['Library', 'Applications', 'Pictures', 'Movies', 'Music', 'Public', 'node_modules']);
const GUARDED = new Set(['Desktop', 'Documents', 'Downloads']);

/**
 * The git repositories in the home folder worked on lately (2026-10-15: a new account with no Claude Code or Codex sessions
 * yet had nothing to name, though ~/testing and ~/personal-website had been committed to two weeks before): up to `depth`
 * folders down, a repository not looked inside, a folder macOS guards only when `access` says it may be read. Each one's
 * folder, the day its history last changed (.git's logs/HEAD, index or HEAD) and its README's first heading.
 */
function recentRepos(homeDir, { days = DIGEST_DAYS, access = null, max = 15, depth = 3, now = Date.now() } = {}) {
  const since = now - days * 86_400_000;
  const found = [];
  let level = [homeDir];
  for (let n = 0; n < depth && level.length; n += 1) {
    const next = [];
    for (const dir of level) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || REPO_SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (dir === homeDir && GUARDED.has(entry.name) && !(access && access.readable(full))) continue;
        if (access && !access.readable(full)) continue;
        let stamp = 0;
        for (const part of [['logs', 'HEAD'], ['index'], ['HEAD']]) { try { stamp = Math.max(stamp, fs.statSync(path.join(full, '.git', ...part)).mtimeMs); } catch { /* none */ } }
        if (stamp) { if (stamp >= since) found.push({ full, stamp }); continue; }
        next.push(full);
      }
    }
    level = next.slice(0, 400);
  }
  return found.sort((a, b) => b.stamp - a.stamp).slice(0, max).map(({ full, stamp }) => {
    let readme = '';
    for (const name of ['README.md', 'readme.md', 'README']) {
      try { readme = (fs.readFileSync(path.join(full, name), 'utf8').split(/\r?\n/).find((line) => line.trim()) || '').replace(/^#+\s*/, '').trim().slice(0, 120); break; } catch { /* none */ }
    }
    return { shown: readers.shownPath(homeDir, full), path: full, name: path.basename(full), last: new Date(stamp).toISOString().slice(0, 10), ...(readme ? { readme } : {}) };
  });
}

/**
 * What the person worked on lately, read from this Mac without a model → { folders, repos, projects }:
 *   folders  the folders their Claude Code and Codex sessions ran in, the busiest and most recent first, each with how
 *            many sessions, the last day, the repository it is in, and the newest sessions' titles
 *   repos    the git repositories in their home folder committed to or changed lately (recentRepos)
 *   projects the Engelbart projects they have already (so a project is not offered twice)
 * Their Obsidian notes and Zotero collections are no longer read here (2026-10-16, Hudson: "instead of searching their
 * Obsidian or Zotero (remove this fallback), it should go to their ChatGPT or Claude"): with nothing here, ./discover.cjs
 * asks the assistants they are signed in to (./assistant-projects.cjs).
 */
function projectDigest({ homeDir, env = process.env, access = null, existing = [], days = DIGEST_DAYS }) {
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
  let recent = [];
  try { recent = recentRepos(homeDir, { days, access }).filter((repo) => !folders.some((folder) => folder.repository === repo.shown || folder.shown === repo.shown)); } catch { recent = []; }
  return { folders, repos: recent, projects: existing.slice(0, 30) };
}

/** Whether a digest holds anything to name projects from (the Engelbart projects they have already aside). */
const digestEmpty = (digest) => !digest || !((digest.folders || []).length || (digest.repos || []).length);

module.exports = { projectDigest, recentRepos, digestEmpty, DIGEST_DAYS };
