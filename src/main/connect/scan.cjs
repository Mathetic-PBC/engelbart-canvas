'use strict';

// Connect your library (2026-10-07, experimental): what Engelbart finds before anyone asks. `detect` is the choose
// screen's: which apps are here, so it starts with those ticked. `scanFor` is the librarian's first look at what the person
// picked on this Mac, so its questions can be about their own things ("You have 14 Zotero collections: …"), which
// refreshes their memory instead of asking them to remember (the Zotero example in the Onboarding brainstorm note). An app
// on the web or behind a connector is not read here: a survey agent looks at it (./session.cjs startWork). Both only read
// (./readers.cjs). Everything is kept small: the scan goes into the librarian's first message.

const fs = require('node:fs');
const path = require('node:path');
const readers = require('./readers.cjs');
const { cursorDb, cursorChats } = require('./cursor.cjs');
const { APPS, sourceOf } = require('../../shared/connect-sources.cjs');

const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };

function googleDrives(homeDir) {
  const base = path.join(homeDir, 'Library', 'CloudStorage');
  try { return fs.readdirSync(base).filter((name) => /^GoogleDrive-/.test(name)).map((name) => path.join(base, name)); } catch { return []; }
}

// An app installed on this Mac (its bundle in /Applications or ~/Applications) counts as found: the person uses it.
const BUNDLES = { ChatGPT: ['ChatGPT.app'], Claude: ['Claude.app'], Granola: ['Granola.app'], Notion: ['Notion.app'], Evernote: ['Evernote.app'], OneNote: ['Microsoft OneNote.app'], Perplexity: ['Perplexity.app'], Cursor: ['Cursor.app'], Zoom: ['zoom.us.app'], Obsidian: ['Obsidian.app'], 'Google Docs': ['Google Drive.app'], Zotero: ['Zotero.app'] };
function installed(homeDir, app, roots) {
  return (BUNDLES[app] || []).some((bundle) => roots.some((root) => exists(path.join(root, bundle))));
}

/**
 * Which apps are on this Mac → { apps: { [app]: { found, where } }, sites: { found, where }, github: { found, where } }.
 * `zotero()` / `github()`: the sign-ins' statuses (connected, username or login). `signedIn`: the apps Engelbart's browser
 * holds a sign-in for (index.cjs reads the Stage's cookies), which count as found too. `connectors(app)`: whether Engelbart
 * is signed in to an app's connector.
 */
function detect({ homeDir, env = process.env, zotero = () => null, github = () => null, signedIn = [], connectors = () => false, applications = ['/Applications', path.join(homeDir || '', 'Applications')] } = {}) {
  const apps = {};
  const set = (app, found, where = '') => { apps[app] = { found: !!found, where }; };
  const has = (app) => installed(homeDir, app, applications);
  const web = new Set(signedIn || []);
  const vaults = readers.obsidianVaults(homeDir);
  set('Obsidian', vaults.length, vaults.map((vault) => vault.shown).join(', '));
  const claude = path.join(homeDir, '.claude', 'projects');
  set('Claude Code', exists(claude), '~/.claude/projects');
  const codex = path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions');
  set('Codex', exists(codex), readers.shownPath(homeDir, codex));
  set('Cursor', exists(cursorDb(homeDir)), 'its chats on this Mac');
  const zoom = path.join(homeDir, 'Documents', 'Zoom');
  set('Zoom', exists(zoom), exists(zoom) ? '~/Documents/Zoom' : '');
  const drives = googleDrives(homeDir);
  set('Google Docs', drives.length || web.has('Google Docs') || has('Google Docs'), web.has('Google Docs') ? 'signed in in Engelbart' : drives.length ? 'Google Drive on this Mac' : '');
  const zs = zotero() || {};
  set('Zotero', zs.connected || exists(path.join(homeDir, 'Zotero')), zs.connected ? `signed in${zs.username ? ` as ${zs.username}` : ''}` : (exists(path.join(homeDir, 'Zotero')) ? '~/Zotero (sign in to read it)' : ''));
  for (const app of Object.keys(APPS)) {
    if (apps[app] || app === 'GitHub') continue;
    const reach = APPS[app].reach;
    if (reach === 'connector') { const on = connectors(app); set(app, on || has(app), on ? 'connected' : has(app) ? 'on this Mac' : ''); continue; }
    if (reach === 'automation') { set(app, false, 'on this Mac'); continue; } // macOS asks first, so only when ticked
    set(app, web.has(app) || has(app), web.has(app) ? 'signed in in Engelbart' : has(app) ? 'on this Mac' : '');
  }
  const profiles = readers.browserProfiles(homeDir);
  const gs = github() || {};
  return {
    apps,
    sites: { found: profiles.length > 0, where: [...new Set(profiles.map((profile) => profile.browser))].join(', ') },
    github: { found: !!gs.connected, where: gs.connected ? `signed in${gs.login ? ` as ${gs.login}` : ''}` : '' },
  };
}

const safely = (work) => { try { return work(); } catch (error) { return { error: error.message }; } };
const safelyAsync = async (work) => { try { return await work(); } catch (error) { return { error: error.message }; } };

/** A chat app on this Mac at a glance: counts, and the most recent titles (runs a program started left out). */
function chatsAtAGlance(app, { homeDir, env }) {
  if (app === 'Cursor') {
    return safely(() => {
      const recent = cursorChats(homeDir, { limit: 400 });
      return { reach: 'local', chats: recent.length >= 400 ? '400+' : recent.length, recent: recent.slice(0, 20).map((chat) => `${chat.date ? chat.date.slice(0, 10) : ''} ${chat.title}`) };
    });
  }
  return safely(() => {
    const recent = readers.localChats(app, { homeDir, env, limit: 400 });
    const byProject = new Map();
    for (const chat of recent) byProject.set(chat.project || '(no folder)', (byProject.get(chat.project || '(no folder)') || 0) + 1);
    return {
      reach: 'local',
      ...readers.localChatCounts(app, { homeDir, env }),
      typedByYou: recent.length >= 400 ? '400+' : recent.length,
      folders: [...byProject].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([folder, n]) => `${folder} (${n})`),
      recent: recent.slice(0, 20).map((chat) => `${chat.date ? chat.date.slice(0, 10) : ''} ${chat.title}`),
    };
  });
}

/** A folder at a glance, cut down for the librarian. */
function folderAtAGlance(dir, homeDir) {
  return safely(() => {
    const overview = readers.folderOverview(dir, { homeDir, top: 25 });
    return { folder: overview.shown, notes: overview.notes, pdfs: overview.pdfs, images: overview.images, newest: overview.newest, notesAtTop: overview.rootNotes, dailyNotesFolder: overview.dailyFolder || null, folders: overview.folders.map((entry) => `${entry.name}: ${entry.notes} notes${entry.pdfs ? `, ${entry.pdfs} pdfs` : ''}${entry.images ? `, ${entry.images} pictures` : ''}${entry.dated >= 0.6 ? ', mostly dated' : ''}`), moreFolders: overview.moreFolders, truncated: overview.truncated };
  });
}

/**
 * What the librarian is shown about each app the person picked → { [source]: { [app]: evidence } }. `choices`:
 * { sources: { [id]: { on, apps: [names], folders: [paths] } } }; `picked` { folders: { app: path } } from the chat's
 * buttons; `zotero` { status(), root() }, `github` { status(), repos() }; `appleNotes` (./apple-notes.cjs) once the person
 * let Engelbart read Apple Notes, else null. An app on the web or behind a connector is only named here: its survey reads it.
 */
async function scanFor(choices, { homeDir, env = process.env, picked = {}, zotero = {}, github = {}, appleNotes = null } = {}) {
  const out = {};
  const folders = picked.folders || {};
  for (const [id, choice] of Object.entries((choices && choices.sources) || {})) {
    if (!choice || !choice.on || !sourceOf(id)) continue;
    const here = {};
    for (const app of choice.apps || []) {
      if (!APPS[app]) continue;
      const reach = APPS[app].reach;
      if (app === 'Obsidian') {
        const vaults = folders.Obsidian ? [{ path: folders.Obsidian, shown: readers.shownPath(homeDir, folders.Obsidian) }] : readers.obsidianVaults(homeDir);
        here[app] = vaults.length ? { reach, vaults: vaults.slice(0, 4).map((vault) => ({ ...folderAtAGlance(vault.path, homeDir), linksInNotes: safely(() => readers.linksIn(vault.path, { limit: 400 }).length) })) } : { reach, needs: 'folder' };
      } else if (app === 'Zotero') {
        const status = zotero.status ? zotero.status() : null;
        const root = zotero.root ? zotero.root() : null;
        if (!status || !status.connected) here[app] = { reach, needs: 'signin' };
        else if (!root) here[app] = { reach, signedIn: true, syncing: true };
        else here[app] = safely(() => { const c = readers.zoteroCollections(root); return { reach, signedIn: true, items: c.items, unfiled: c.unfiled, collections: c.collections.slice(0, 60).map((entry) => `${entry.path} (${entry.items}) [key ${entry.key}]`), moreCollections: Math.max(0, c.collections.length - 60) }; });
      } else if (app === 'Claude Code' || app === 'Codex' || app === 'Cursor') {
        here[app] = chatsAtAGlance(app, { homeDir, env });
      } else if (app === 'Zoom') {
        const dir = folders.Zoom || path.join(homeDir, 'Documents', 'Zoom');
        here[app] = exists(dir) ? { reach, ...folderAtAGlance(dir, homeDir), cloud: 'Cloud recordings can be read at zoom.us in Engelbart\'s browser.' } : { reach, needs: 'folder', cloud: 'Cloud recordings can be read at zoom.us in Engelbart\'s browser.' };
      } else if (reach === 'automation') {
        here[app] = appleNotes ? await safelyAsync(async () => ({ reach, folders: ((await appleNotes.folders()) || []).slice(0, 40).map((folder) => `${folder.name} (${folder.count})${folder.account && folder.account !== 'iCloud' ? ` · ${folder.account}` : ''} [id ${folder.id}]`) })) : { reach, needs: 'permission' };
      } else {
        here[app] = { reach }; // web or connector: its survey reads it (./session.cjs)
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
      else here.github = { needs: 'signin' };
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

module.exports = { detect, scanFor, gitFolders, googleDrives };
