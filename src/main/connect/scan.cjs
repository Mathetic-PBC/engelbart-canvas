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
const folderAccess = require('./folder-access.cjs');
const { cursorDb, cursorChats } = require('./cursor.cjs');
const { APPS, LOCAL_PDFS, sourceOf, periodName } = require('../../shared/connect-sources.cjs');

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
function detect({ homeDir, env = process.env, zotero = () => null, github = () => null, signedIn = [], connectors = () => false, applications = ['/Applications', path.join(homeDir || '', 'Applications')], access = null } = {}) {
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
  set('Google Docs', drives.length || web.has('Google Docs') || has('Google Docs'), web.has('Google Docs') ? 'signed in to Engelbart' : 'Sign in to add');
  apps['Google Docs'].signedIn = web.has('Google Docs');
  // Gmail: the same Google sign-in, read only in Engelbart's browser (no desktop app, no Drive folders).
  set('Gmail', web.has('Gmail'), web.has('Gmail') ? 'signed in to Engelbart' : 'Sign in to add');
  apps.Gmail.signedIn = web.has('Gmail');
  const zs = zotero() || {};
  set('Zotero', zs.connected || exists(path.join(homeDir, 'Zotero')), zs.connected ? `signed in${zs.username ? ` as ${zs.username}` : ''}` : (exists(path.join(homeDir, 'Zotero')) ? '~/Zotero (sign in to read it)' : ''));
  // Only whether the folders are there: reading inside Downloads or Documents is left to the scan, after the person picked.
  const roots = readers.pdfRoots(homeDir).map((dir) => path.basename(dir));
  set(LOCAL_PDFS, roots.length, roots.slice(0, 3).join(', '));
  for (const app of Object.keys(APPS)) {
    if (apps[app] || app === 'GitHub') continue;
    const reach = APPS[app].reach;
    if (reach === 'connector') { const on = connectors(app); set(app, on || has(app), on ? 'connected' : has(app) ? 'on this Mac' : ''); continue; }
    if (reach === 'automation') { set(app, false, 'on this Mac'); continue; } // macOS asks first, so only when ticked
    // Found because its desktop app is installed is not the same as reachable: the agents read it in Engelbart's browser,
    // which needs a sign-in there (MATH-114: "Sign in to add", not "on this Mac").
    set(app, web.has(app) || has(app), web.has(app) ? 'signed in to Engelbart' : has(app) ? 'Sign in to add' : '');
    apps[app].signedIn = web.has(app);
  }
  const profiles = readers.browserProfiles(homeDir);
  const gs = github() || {};
  return {
    apps,
    sites: { found: profiles.length > 0, where: [...new Set(profiles.map((profile) => profile.browser))].join(', ') },
    github: { found: !!gs.connected, where: gs.connected ? `signed in${gs.login ? ` as ${gs.login}` : ''}` : '' },
    localRepos: safely(() => localRepos({ homeDir, env, access })),
  };
}

// The folders macOS keeps behind a prompt (Files and Folders, iCloud Drive): nothing inside them is touched before the
// person picks, as the PDF folders above (MATH-114).
const PROTECTED = ['Documents', 'Desktop', 'Downloads', path.join('Library', 'Mobile Documents')];

/**
 * The repositories on this Mac found before any folder is picked (MATH-114): the folders Claude Code and Codex sessions
 * were run in (readers.localChats, programs' runs left out), grouped by that folder, with how many sessions each. One that
 * macOS does not protect is kept only when it, or a folder above it in the home folder, holds a .git (and is then named by
 * that one); one under ~/Documents, ~/Desktop or ~/Downloads is listed unchecked (`checked: false`), its .git looked for
 * by gitFolders once the person continues. Engelbart's own folders (~/.engelbart and the like) and temporary ones are left
 * out. → [{ path, shown, name, sessions, checked }], most sessions first. `access` (MATH-110, ./folder-access.cjs guard):
 * one under a protected folder macOS let Engelbart read is looked into like any other.
 */
function localRepos({ homeDir, env = process.env, limit = 2000, max = 40, access = null } = {}) {
  const home = path.resolve(homeDir);
  const inside = (dir, root) => dir === root || dir.startsWith(root + path.sep);
  const guarded = PROTECTED.map((name) => path.join(home, name));
  const byFolder = new Map();
  for (const app of ['Claude Code', 'Codex']) {
    for (const chat of readers.localChats(app, { homeDir, env, limit })) {
      const dir = chat.project && chat.project.startsWith('~') ? path.join(home, chat.project.slice(1)) : chat.project;
      if (dir && path.isAbsolute(dir)) byFolder.set(path.resolve(dir), (byFolder.get(path.resolve(dir)) || 0) + 1);
    }
  }
  const repos = new Map();
  for (const [dir, sessions] of byFolder) {
    if (inside(dir, home) ? dir === home || path.relative(home, dir).startsWith('.') : /^\/(private|tmp|var)(\/|$)/.test(dir)) continue;
    let root = null;
    let checked = true;
    if (guarded.some((top) => inside(dir, top)) && !(access && access.readable(dir))) {
      if (guarded.includes(dir)) continue; // ~/Desktop itself is not a repository
      root = dir;
      checked = false;
    } else {
      for (let at = dir, up = 0; up < 8 && at !== home && at !== path.dirname(at); at = path.dirname(at), up += 1) {
        if (exists(path.join(at, '.git'))) { root = at; break; }
      }
    }
    if (!root) continue;
    const held = repos.get(root) || { path: root, shown: readers.shownPath(homeDir, root), name: path.basename(root), sessions: 0, checked };
    held.sessions += sessions;
    repos.set(root, held);
  }
  return [...repos.values()].sort((a, b) => b.sessions - a.sessions || a.name.localeCompare(b.name)).slice(0, max);
}

const safely = (work) => { try { return work(); } catch (error) { return { error: error.message }; } };
const safelyAsync = async (work) => { try { return await work(); } catch (error) { return { error: error.message }; } };

/**
 * A chat app on this Mac at a glance: counts, and the most recent titles (runs a program started left out). `days`
 * (2026-10-10): the period picked on Connect your library; `inPeriod` counts the chats in it.
 */
function chatsAtAGlance(app, { homeDir, env, days = null }) {
  if (app === 'Cursor') {
    return safely(() => {
      const recent = cursorChats(homeDir, { limit: 400 });
      const inPeriod = days ? cursorChats(homeDir, { days, limit: 400 }).length : null;
      return { reach: 'local', chats: recent.length >= 400 ? '400+' : recent.length, ...(days ? { inPeriod: inPeriod >= 400 ? '400+' : inPeriod } : {}), recent: recent.slice(0, 20).map((chat) => `${chat.date ? chat.date.slice(0, 10) : ''} ${chat.title}`) };
    });
  }
  return safely(() => {
    const recent = readers.localChats(app, { homeDir, env, limit: 400 });
    const byProject = new Map();
    for (const chat of recent) byProject.set(chat.project || '(no folder)', (byProject.get(chat.project || '(no folder)') || 0) + 1);
    return {
      reach: 'local',
      ...readers.localChatCounts(app, { homeDir, env, days }),
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
 * The PDFs on this Mac at a glance, by folder, for the librarian to ask about folders and kinds of papers: the chosen
 * folders, and the usual places (Downloads, Documents, Desktop, iCloud Drive…) when the person let the agents read their
 * home folder. With a `project` (2026-10-10) each folder's examples begin with the PDFs that share words with it, for the
 * librarian to offer by title. With `days` (2026-10-10) the counts and examples cover only the PDFs changed in that period;
 * `olderLeftOut` says how many were not, and `olderRelated` names the older ones that bear on the project.
 * → evidence, or { needs: 'folder' } when there is nowhere it may look. `access` (MATH-110, ./folder-access.cjs guard): a
 * protected folder (Desktop, Documents, Downloads, iCloud Drive, the drives) is looked in only once macOS let Engelbart
 * read it, or when the person picked it; with none given, the chosen folders are taken as picked and nothing else
 * protected is read (on the Mac: `platform`). `notAllowed` names the usual places left out.
 */
function pdfsAtAGlance(chosen, { homeDir, everywhere, project = null, days = null, access = null, platform = process.platform }) {
  const guard = access || folderAccess.guard({ homeDir, answers: {}, picked: chosen, platform });
  const roots = [...chosen.filter((dir) => guard.readable(dir)), ...(everywhere ? readers.pdfRoots(homeDir, { readable: guard.readable }) : [])];
  const notAllowed = everywhere ? guard.blocked.map((folder) => folder.name) : [];
  const left = notAllowed.length ? { notAllowed, notAllowedAre: 'macOS has not let Engelbart read these folders: they were not looked in. The person can allow them in System Settings → Privacy & Security → Files and Folders.' } : {};
  if (!roots.length) return { reach: 'local', needs: 'folder', ...left };
  return safely(() => {
    const found = readers.pdfFolders(roots, { homeDir, project, days, readable: guard.readable });
    const period = days ? { period: `Counts and examples cover only the PDFs changed in ${periodName(days)}; olderLeftOut says how many older ones were left out.`, olderLeftOut: found.olderLeftOut, ...(found.olderRelated.length ? { olderRelated: found.olderRelated, olderRelatedAre: 'Older than the period, sharing words with the project: offer them by title, say they are older, and ask first.' } : {}) } : {};
    return { reach: 'local', lookedIn: found.roots, pdfs: found.pdfs, folders: found.folders, moreFolders: found.moreFolders, truncated: found.truncated, ...left, ...period, ...(project ? { examplesFirst: 'Each folder\'s examples begin with the PDFs whose name or title shares words with the project (relatedToProject counts them), then the newest.' } : {}), kinds: 'A guess from each file\'s name: paper, book (books, slides, lecture notes), personal (receipts, statements, tickets: never offered or brought in), unclear (judge from the titles).' };
  });
}

/**
 * What the librarian is shown about each app the person picked → { [source]: { [app]: evidence } }. `choices`:
 * { sources: { [id]: { on, apps: [names], folders: [paths] } }, project: { name, description } or null, days: 182 | 365 | null }; `picked` { folders: { app: path } } from the chat's
 * buttons; `zotero` { status(), root() }, `github` { status(), repos({ dirs }) }; `appleNotes` (./apple-notes.cjs) once the person
 * let Engelbart read Apple Notes, else null. An app on the web or behind a connector is only named here: its survey reads it.
 * `access` (MATH-110, ./folder-access.cjs guard): what in the protected folders may be read; with none, only the folders
 * the person picked (`choices.picked`) on the Mac (`platform`; elsewhere nothing is protected).
 */
async function scanFor(choices, { homeDir, env = process.env, picked = {}, zotero = {}, github = {}, appleNotes = null, access = null, platform = process.platform } = {}) {
  const out = {};
  const folders = picked.folders || {};
  const guard = access || folderAccess.guard({ homeDir, answers: {}, picked: (choices && choices.picked) || [], platform });
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
        here[app] = chatsAtAGlance(app, { homeDir, env, days: choices.days || null });
      } else if (app === 'Zoom') {
        const dir = folders.Zoom || path.join(homeDir, 'Documents', 'Zoom');
        here[app] = exists(dir) ? { reach, ...folderAtAGlance(dir, homeDir), cloud: 'Cloud recordings can be read at zoom.us in Engelbart\'s browser.' } : { reach, needs: 'folder', cloud: 'Cloud recordings can be read at zoom.us in Engelbart\'s browser.' };
      } else if (app === LOCAL_PDFS) {
        here[app] = pdfsAtAGlance([...(choice.folders || []), folders[LOCAL_PDFS]].filter(Boolean), { homeDir, everywhere: !!(choices.permissions && choices.permissions.files), project: choices.project || null, days: choices.days || null, access: guard });
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
    if (id === 'papers' && (choice.folders || []).length && !(choice.apps || []).includes(LOCAL_PDFS)) here.folders = pdfsAtAGlance(choice.folders, { homeDir, everywhere: false, project: (choices && choices.project) || null, days: (choices && choices.days) || null, access: guard });
    if (id === 'code') {
      const status = github.status ? github.status() : null;
      // MATH-110: a repository under a protected folder macOS did not let Engelbart read is not looked into.
      const picked = (choice.folders || []).map((dir) => (guard.readable(dir) ? { dir, repos: gitFolders(dir) } : { dir, repos: [], notAllowed: true }));
      // MATH-111: the organizations GitHub cannot show yet (the App is not installed there), with how many of the
      // repositories on this Mac (found, and picked here) are theirs.
      const shaped = (value) => ({
        signedIn: true,
        repos: (value.repos || []).slice(0, 60).map((repo) => repo.fullName),
        missingOrgs: (value.missingOrgs || []).slice(0, 12).map((org) => ({ login: org.login, repos: (org.repos || []).length })),
      });
      if (status && status.connected && github.repos) here.github = await github.repos({ dirs: picked.flatMap((entry) => entry.repos) }).then(shaped).catch((error) => ({ error: error.message }));
      else here.github = { needs: 'signin' };
      if (Array.isArray(choice.repos) && choice.repos.length) here.picked = choice.repos;
      if (picked.length) here.folders = picked.map((entry) => ({ folder: readers.shownPath(homeDir, entry.dir), repositories: entry.repos.map((repo) => readers.shownPath(homeDir, repo)), ...(entry.notAllowed ? { notAllowed: 'macOS has not let Engelbart read the folder this is in, so it was not looked into.' } : {}) }));
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

module.exports = { detect, scanFor, gitFolders, localRepos, googleDrives, pdfsAtAGlance };
