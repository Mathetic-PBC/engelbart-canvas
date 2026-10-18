'use strict';

// Which apps are installed on Linux (2026-10-18, docs/windows-port-log.md "Beta catch-up to 0.1.23 on
// linux-beta-deployment"; Hudson: "on Linux it is not accessing Obsidian files and other files well"). The Mac's code looks
// for .app bundles in /Applications and asks Spotlight; Linux has neither. An installed desktop app has a .desktop entry
// (freedesktop.org's Desktop Entry spec) in an `applications` folder of the XDG data folders: the .deb's in /usr/share,
// a person's own and an AppImage's (AppImageLauncher, Gear Lever) in ~/.local/share, Flatpak's exports
// (/var/lib/flatpak and ~/.local/share/flatpak) and Snap's (/var/lib/snapd/desktop). An app is matched by its entry's
// id (the file's name: obsidian, md.obsidian.Obsidian, obsidian_obsidian) or its Name=. Obsidian also counts when its
// settings are there (an AppImage run without an integrator leaves no entry). Only reads; no process is run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readers = require('./readers.cjs');

// By the names Connect uses (../../shared/connect-sources.cjs APPS). An app with no Linux build simply has no entry.
const LINUX_APPS = Object.freeze({
  Obsidian: { ids: ['obsidian', 'md.obsidian.Obsidian', 'obsidian_obsidian'], names: [/^obsidian$/i] },
  Zotero: { ids: ['zotero', 'org.zotero.Zotero', 'zotero_zotero'], names: [/^zotero$/i] },
  Zoom: { ids: ['Zoom', 'us.zoom.Zoom', 'zoom-client_zoom-client'], names: [/^zoom( workplace)?$/i] },
  Cursor: { ids: ['cursor', 'co.anysphere.cursor', 'cursor_cursor'], names: [/^cursor$/i] },
  Claude: { ids: ['claude-desktop', 'com.anthropic.claude'], names: [/^claude( desktop)?$/i] },
  ChatGPT: { ids: [], names: [/^chatgpt$/i] },
  Notion: { ids: ['notion-app', 'notion-app-enhanced', 'notion-snap-reborn_notion-snap-reborn'], names: [/^notion$/i] },
  Perplexity: { ids: [], names: [/^perplexity$/i] },
  Evernote: { ids: [], names: [/^evernote$/i] },
});

// The browsers, by the bundle ids the Mac's code keys them by (../browser/installed-apps.cjs APP_NAMES). Safari, Arc and
// Comet have no Linux build.
const LINUX_BROWSERS = Object.freeze({
  'com.google.Chrome': { ids: ['google-chrome', 'google-chrome-stable', 'com.google.Chrome'], names: [/^google chrome$/i] },
  'com.brave.Browser': { ids: ['brave-browser', 'brave_brave', 'com.brave.Browser'], names: [/^brave( web browser)?$/i] },
  'com.microsoft.edgemac': { ids: ['microsoft-edge', 'microsoft-edge-stable', 'com.microsoft.Edge'], names: [/^microsoft edge$/i] },
  'com.vivaldi.Vivaldi': { ids: ['vivaldi-stable', 'vivaldi_vivaldi-stable', 'com.vivaldi.Vivaldi'], names: [/^vivaldi$/i] },
  'com.operasoftware.Opera': { ids: ['opera', 'opera_opera', 'com.opera.Opera'], names: [/^opera$/i] },
  'org.chromium.Chromium': { ids: ['chromium', 'chromium-browser', 'chromium_chromium', 'org.chromium.Chromium'], names: [/^chromium( web browser)?$/i] },
  'org.mozilla.firefox': { ids: ['firefox', 'firefox-esr', 'firefox_firefox', 'org.mozilla.firefox'], names: [/^firefox( web browser)?$/i] },
});

/** The folders .desktop entries are kept in, the person's first. */
function applicationDirs({ homeDir = os.homedir(), env = process.env } = {}) {
  const dataHome = env && env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(homeDir, '.local', 'share');
  const dataDirs = String((env && env.XDG_DATA_DIRS) || '/usr/local/share:/usr/share').split(':').filter((dir) => path.isAbsolute(dir));
  return [...new Set([dataHome, ...dataDirs, path.join(homeDir, '.local', 'share', 'flatpak', 'exports', 'share'), '/var/lib/flatpak/exports/share'].map((dir) => path.join(dir, 'applications')).concat('/var/lib/snapd/desktop/applications'))];
}

/** The [Desktop Entry] group's Name= (not a translation) and whether it is Hidden; null when the file is not one. */
function readEntry(text) {
  let group = '';
  let name = '';
  let hidden = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { group = line; continue; }
    if (group !== '[Desktop Entry]') continue;
    if (!name && line.startsWith('Name=')) name = line.slice(5).trim();
    if (/^Hidden\s*=\s*true$/i.test(line)) hidden = true;
  }
  return group || name ? { name, hidden } : null;
}

/** Every visible .desktop entry → [{ id, name }]. A folder that is not there is passed over. */
function desktopEntries({ homeDir = os.homedir(), env = process.env, fsx = fs } = {}) {
  const out = [];
  const seen = new Set();
  for (const dir of applicationDirs({ homeDir, env })) {
    let names = [];
    try { names = fsx.readdirSync(dir); } catch { continue; }
    for (const file of names) {
      if (!file.endsWith('.desktop')) continue;
      const id = file.slice(0, -'.desktop'.length);
      if (seen.has(id)) continue; // the first folder's entry wins, as the spec says
      seen.add(id);
      let entry = null;
      try { entry = readEntry(fsx.readFileSync(path.join(dir, file), 'utf8')); } catch { entry = null; }
      if (entry && !entry.hidden) out.push({ id, name: entry.name });
    }
  }
  return out;
}

const matches = (known, entries) => !!known && entries.some((entry) => known.ids.includes(entry.id) || known.names.some((pattern) => pattern.test(entry.name)));

/** Whether `app` (Connect's name) is installed. `entries` the desktop entries when already read. */
function installed(app, { homeDir = os.homedir(), env = process.env, entries = null } = {}) {
  if (app === 'Obsidian' && readers.obsidianConfigs(homeDir, env).some((file) => fs.existsSync(file))) return true;
  return matches(LINUX_APPS[app], entries || desktopEntries({ homeDir, env }));
}

/**
 * ../browser/installed-apps.cjs's createInstalledApps for Linux: the same calls, answered from the desktop entries (read
 * again after a minute), never a process. `override` (ENGELBART_INSTALLED_BROWSERS) as there.
 */
function createLinuxInstalledApps({ homeDir = os.homedir(), env = process.env, override = null, now = () => Date.now() } = {}) {
  let read = null; // { at, entries }
  const entries = () => {
    if (!read || now() - read.at >= 60_000) read = { at: now(), entries: desktopEntries({ homeDir, env }) };
    return read.entries;
  };
  const has = (bundleId) => (override ? override.includes(bundleId) : matches(LINUX_BROWSERS[bundleId], entries()));
  return {
    has,
    ask: () => Promise.resolve(),
    settled: (bundleId) => Promise.resolve(has(bundleId)),
    where: (bundleId) => (has(bundleId) ? bundleId : ''),
  };
}

module.exports = { LINUX_APPS, LINUX_BROWSERS, applicationDirs, readEntry, desktopEntries, installed, createLinuxInstalledApps };
