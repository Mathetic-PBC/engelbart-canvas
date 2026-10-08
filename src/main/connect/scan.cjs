'use strict';

// Connect your library (2026-10-07, experimental): what Engelbart finds on this Mac before anyone asks. `detect` is the
// choose screen's: which apps are here, so it starts with those ticked. `scanFor` is the interviewer's first look at
// what the person picked, so its questions can be about their own things ("You have 14 Zotero collections: …"), which
// refreshes their memory instead of asking them to remember (the Zotero example in the Onboarding brainstorm note).
// Both only read (./readers.cjs). Everything is kept small: the scan goes into the interviewer's first message.

const fs = require('node:fs');
const path = require('node:path');
const readers = require('./readers.cjs');
const { APPS, sourceOf } = require('../../shared/connect-sources.cjs');

const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };

function googleDrives(homeDir) {
  const base = path.join(homeDir, 'Library', 'CloudStorage');
  try { return fs.readdirSync(base).filter((name) => /^GoogleDrive-/.test(name)).map((name) => path.join(base, name)); } catch { return []; }
}

/**
 * Which apps are on this Mac → { apps: { [app]: { found, where } }, sites: { found, where }, github: { found, where } }.
 * `zotero()` / `github()`: the sign-ins' statuses (connected, username or login).
 */
function detect({ homeDir, env = process.env, zotero = () => null, github = () => null } = {}) {
  const apps = {};
  const set = (app, found, where = '') => { apps[app] = { found: !!found, where }; };
  const vaults = readers.obsidianVaults(homeDir);
  set('Obsidian', vaults.length, vaults.map((vault) => vault.shown).join(', '));
  const claude = path.join(homeDir, '.claude', 'projects');
  set('Claude Code', exists(claude), '~/.claude/projects');
  const codex = path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions');
  set('Codex', exists(codex), readers.shownPath(homeDir, codex));
  const zoom = path.join(homeDir, 'Documents', 'Zoom');
  set('Zoom', exists(zoom), '~/Documents/Zoom');
  const drives = googleDrives(homeDir);
  set('Google Docs', drives.length, drives.map((dir) => readers.shownPath(homeDir, dir)).join(', '));
  const zs = zotero() || {};
  set('Zotero', zs.connected || exists(path.join(homeDir, 'Zotero')), zs.connected ? `signed in${zs.username ? ` as ${zs.username}` : ''}` : (exists(path.join(homeDir, 'Zotero')) ? '~/Zotero (sign in to read it)' : ''));
  for (const app of Object.keys(APPS)) if (!apps[app]) set(app, false);
  const profiles = readers.browserProfiles(homeDir);
  const gs = github() || {};
  return {
    apps,
    sites: { found: profiles.length > 0, where: [...new Set(profiles.map((profile) => profile.browser))].join(', ') },
    github: { found: !!gs.connected, where: gs.connected ? `signed in${gs.login ? ` as ${gs.login}` : ''}` : '' },
  };
}

const safely = (work) => { try { return work(); } catch (error) { return { error: error.message }; } };

/** A chat app's sessions at a glance: counts, and the most recent titles (runs a program started left out). */
function chatsAtAGlance(app, { homeDir, env, exportFile }) {
  if (app === 'Claude' || app === 'ChatGPT') {
    if (!exportFile) return { needs: 'file', how: APPS[app].how };
    return safely(() => ({ export: readers.shownPath(homeDir, exportFile), ...readers.exportCounts(exportFile), recent: readers.exportChats(exportFile, { limit: 25 }).map((chat) => `${chat.date ? chat.date.slice(0, 10) : ''} ${chat.title}`) }));
  }
  if (app !== 'Claude Code' && app !== 'Codex') return null;
  return safely(() => {
    const recent = readers.localChats(app, { homeDir, env, limit: 400 });
    const byProject = new Map();
    for (const chat of recent) byProject.set(chat.project || '(no folder)', (byProject.get(chat.project || '(no folder)') || 0) + 1);
    return {
      ...readers.localChatCounts(app, { homeDir, env }),
      typedByYou: recent.length >= 400 ? '400+' : recent.length,
      folders: [...byProject].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([folder, n]) => `${folder} (${n})`),
      recent: recent.slice(0, 20).map((chat) => `${chat.date ? chat.date.slice(0, 10) : ''} ${chat.title}`),
    };
  });
}

/** A folder at a glance, cut down for the interviewer. */
function folderAtAGlance(dir, homeDir) {
  return safely(() => {
    const overview = readers.folderOverview(dir, { homeDir, top: 25 });
    return { folder: overview.shown, notes: overview.notes, pdfs: overview.pdfs, images: overview.images, newest: overview.newest, notesAtTop: overview.rootNotes, dailyNotesFolder: overview.dailyFolder || null, folders: overview.folders.map((entry) => `${entry.name}: ${entry.notes} notes${entry.pdfs ? `, ${entry.pdfs} pdfs` : ''}${entry.images ? `, ${entry.images} pictures` : ''}${entry.dated >= 0.6 ? ', mostly dated' : ''}`), moreFolders: overview.moreFolders, truncated: overview.truncated };
  });
}

/**
 * What the interviewer is shown about each app the person picked → { [source]: { [app]: evidence } }. `choices`:
 * { sources: { [id]: { on, apps: [names], folders: [paths] } } }; `picked` { folders: { app: path }, exports: { app: path } }
 * from the chat's buttons; `zoteroRoot()` the mirror's folder when Zotero is signed in; `githubRepos()` → names.
 */
async function scanFor(choices, { homeDir, env = process.env, picked = {}, zotero = {}, github = {} } = {}) {
  const out = {};
  const folders = picked.folders || {}, exportsOf = picked.exports || {};
  for (const [id, choice] of Object.entries((choices && choices.sources) || {})) {
    if (!choice || !choice.on || !sourceOf(id)) continue;
    const here = {};
    for (const app of choice.apps || []) {
      if (!APPS[app]) continue;
      if (app === 'Obsidian') {
        const vaults = folders.Obsidian ? [{ path: folders.Obsidian, shown: readers.shownPath(homeDir, folders.Obsidian) }] : readers.obsidianVaults(homeDir);
        here[app] = vaults.length ? { vaults: vaults.slice(0, 4).map((vault) => ({ ...folderAtAGlance(vault.path, homeDir), linksInNotes: safely(() => readers.linksIn(vault.path, { limit: 400 }).length) })) } : { needs: 'folder', how: APPS[app].how };
      } else if (app === 'Zotero') {
        const status = zotero.status ? zotero.status() : null;
        const root = zotero.root ? zotero.root() : null;
        if (!status || !status.connected) here[app] = { needs: 'signin', how: APPS[app].how };
        else if (!root) here[app] = { signedIn: true, syncing: true };
        else here[app] = safely(() => { const c = readers.zoteroCollections(root); return { signedIn: true, items: c.items, unfiled: c.unfiled, collections: c.collections.slice(0, 60).map((entry) => `${entry.path} (${entry.items}) [key ${entry.key}]`), moreCollections: Math.max(0, c.collections.length - 60) }; });
      } else if (app === 'Claude Code' || app === 'Codex' || app === 'Claude' || app === 'ChatGPT') {
        here[app] = chatsAtAGlance(app, { homeDir, env, exportFile: exportsOf[app] });
      } else if (app === 'Zoom' && !folders.Zoom) {
        const dir = path.join(homeDir, 'Documents', 'Zoom');
        here[app] = exists(dir) ? folderAtAGlance(dir, homeDir) : { needs: 'folder', how: APPS[app].how };
      } else if (app === 'Google Docs' && !folders['Google Docs']) {
        const drives = googleDrives(homeDir);
        here[app] = drives.length ? { drives: drives.map((dir) => readers.shownPath(homeDir, dir)), note: 'Google Docs in Drive are links (.gdoc), not text: ask for a Takeout export if they want the documents themselves.' } : { needs: 'folder', how: APPS[app].how };
      } else {
        here[app] = folders[app] || exportsOf[app] ? folderAtAGlance(folders[app] || exportsOf[app], homeDir) : { needs: APPS[app].pick || 'nothing', how: APPS[app].how };
      }
    }
    if (id === 'sites') {
      const profiles = readers.browserProfiles(homeDir);
      const first = profiles[0];
      here.browsers = profiles.slice(0, 8).map((profile) => `${profile.browser} · ${profile.name}${profile.used ? ` (last used ${profile.used.slice(0, 10)})` : ''}`);
      if (first) {
        here.bookmarks = safely(() => readers.browserBookmarks(first.dir).length);
        here.topSites = await readers.browserHistory(first.dir, { days: 90, limit: 25 }).then((sites) => sites.map((site) => `${site.host} (${site.visits})`)).catch((error) => ({ error: error.message }));
      }
      const vaults = readers.obsidianVaults(homeDir);
      if (vaults.length) here.linksInObsidian = vaults.slice(0, 2).map((vault) => ({ vault: vault.shown, links: safely(() => readers.linksIn(vault.path, { limit: 400 }).length) }));
      if (folders.sites) here.folder = folderAtAGlance(folders.sites, homeDir);
    }
    if (id === 'papers' && (choice.folders || []).length) here.folders = choice.folders.map((dir) => folderAtAGlance(dir, homeDir));
    if (id === 'code') {
      const status = github.status ? github.status() : null;
      if (status && status.connected && github.repos) here.github = await github.repos().then((value) => ({ signedIn: true, repos: (value.repos || []).slice(0, 60).map((repo) => repo.fullName) })).catch((error) => ({ error: error.message }));
      else here.github = { needs: 'signin', how: APPS.GitHub.how };
      if (Array.isArray(choice.repos) && choice.repos.length) here.picked = choice.repos;
      if ((choice.folders || []).length) here.folders = choice.folders.map((dir) => ({ folder: readers.shownPath(homeDir, dir), repositories: gitFolders(dir).map((repo) => readers.shownPath(homeDir, repo)) }));
    }
    out[id] = here;
  }
  return out;
}

/** The git repositories in a folder: it, or its folders two levels down that hold a .git. */
function gitFolders(dir, depth = 2) {
  if (exists(path.join(dir, '.git'))) return [dir];
  if (depth <= 0) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules').flatMap((entry) => gitFolders(path.join(dir, entry.name), depth - 1)).slice(0, 100);
}

module.exports = { detect, scanFor, gitFolders };
