'use strict';

// Whether a browser's app is installed on this Mac, without ever holding up Engelbart (2026-10-12, "make Chrome sign-ins
// dependable"). It used to ask Spotlight (`mdfind`) synchronously in the main process, up to 8 times a minute and up to 5 s
// each. Now:
//   1. /Applications and ~/Applications are looked in first: the browser's known app name (its Info.plist naming its
//      bundle id, or unreadable, as a binary plist is), else any app there whose Info.plist names the bundle id. No
//      Spotlight, no process.
//   2. Not there: Spotlight is asked in the background (`ask`, when Connect's choose screen opens, or the page before it),
//      and its answer kept. Until it answers, the browser counts as installed (what a Spotlight that cannot answer meant).
//   3. Before macOS is asked for a browser's key or a page is opened in it, its answer is waited for (`settled`), at most
//      `settleMs`: an uninstalled browser is never asked about or opened.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// The name each browser's app usually has, by bundle id.
const APP_NAMES = Object.freeze({
  'com.google.Chrome': ['Google Chrome.app'],
  'com.brave.Browser': ['Brave Browser.app'],
  'com.microsoft.edgemac': ['Microsoft Edge.app'],
  'com.vivaldi.Vivaldi': ['Vivaldi.app'],
  'com.operasoftware.Opera': ['Opera.app'],
  'org.chromium.Chromium': ['Chromium.app'],
  'company.thebrowser.Browser': ['Arc.app'],
  'org.mozilla.firefox': ['Firefox.app'],
  // Import your context's browser list (2026-10-13): Safari, and Perplexity's Comet.
  'com.apple.Safari': ['Safari.app'],
  'ai.perplexity.comet': ['Comet.app'],
});

const SETTLE_MS = 2000;
// A found app is looked for again after this (it may have gone to the Trash); Spotlight's answer is kept this long.
const LOCAL_MS = 60_000;
const SPOTLIGHT_MS = 10 * 60_000;

const safeId = (bundleId) => /^[\w.-]+$/.test(String(bundleId || ''));

/**
 * Spotlight's answer for `bundleId` → Promise<boolean>: an app with that bundle id outside the Trash, still there
 * (`mdfind "kMDItemCFBundleIdentifier == '<id>'"`, through `run`, execFile or a fake; never synchronously). A Spotlight that
 * cannot answer (indexing off, an error) is not taken as "not installed": the browser counts.
 */
function installedApp(bundleId, { run = execFile, exists = (p) => fs.existsSync(p) } = {}) {
  if (!safeId(bundleId)) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { encoding: 'utf8', timeout: 5000 }, (error, stdout) => {
        if (error) { resolve(true); return; }
        resolve(String(stdout || '').split('\n').map((line) => line.trim()).filter(Boolean).some((found) => /\.app$/i.test(found) && !/\/\.Trash\//.test(found) && exists(found)));
      });
    } catch {
      resolve(true);
    }
  });
}

/** Whether an Info.plist's text names `bundleId` as the app's bundle id (an XML plist; a binary one is not read). */
function plistNames(text, bundleId) {
  const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]*)<\/string>/.exec(String(text || ''));
  return match ? match[1].trim() === bundleId : null;
}

/**
 * `appDirs` where apps are looked for first; `spotlight(bundleId)` → Promise<boolean> (installedApp); `override` a list of
 * bundle ids standing in for this Mac's apps (ENGELBART_INSTALLED_BROWSERS in scripted runs), or null; `fsx` { readdir,
 * readFile, exists } (node:fs, or fakes); `settleMs` how long `settled` waits for Spotlight.
 * → { has(bundleId) boolean, ask(bundleIds) Promise, settled(bundleId, { maxMs }) Promise<boolean>, where(bundleId) }
 */
function createInstalledApps({
  appDirs = ['/Applications', path.join(os.homedir(), 'Applications')],
  spotlight = (bundleId) => installedApp(bundleId),
  override = null,
  fsx = {
    readdir: (dir) => fs.readdirSync(dir),
    readFile: (file) => fs.readFileSync(file, 'utf8'),
    exists: (p) => fs.existsSync(p),
  },
  settleMs = SETTLE_MS,
  now = () => Date.now(),
} = {}) {
  const local = new Map(); // bundle → { at, path }
  const answers = new Map(); // bundle → { at, yes }
  const pending = new Map(); // bundle → Promise<boolean>

  const read = (file) => { try { return fsx.readFile(file); } catch { return null; } };

  /** The app with `bundleId` in appDirs → its path, or ''. No process: a few file reads. */
  function lookLocally(bundleId) {
    for (const dir of appDirs) {
      for (const name of APP_NAMES[bundleId] || []) {
        const app = path.join(dir, name);
        if (!fsx.exists(app)) continue;
        // The known name, its Info.plist naming another app, is not it; one that can't be read (binary) is taken on its name.
        if (plistNames(read(path.join(app, 'Contents', 'Info.plist')), bundleId) !== false) return app;
      }
    }
    for (const dir of appDirs) {
      let names = [];
      try { names = fsx.readdir(dir); } catch { continue; }
      for (const name of names) {
        if (!/\.app$/i.test(name)) continue;
        const app = path.join(dir, name);
        if (plistNames(read(path.join(app, 'Contents', 'Info.plist')), bundleId)) return app;
      }
    }
    return '';
  }

  /** Where the app is in appDirs, or '' (kept a minute). */
  function where(bundleId) {
    const known = local.get(bundleId);
    if (known && now() - known.at < LOCAL_MS) return known.path;
    const found = lookLocally(bundleId);
    local.set(bundleId, { at: now(), path: found });
    return found;
  }

  /** Spotlight asked about `bundleId` once, in the background; its answer kept → Promise<boolean>. */
  function askOne(bundleId) {
    const answer = answers.get(bundleId);
    if (answer && now() - answer.at < SPOTLIGHT_MS) return Promise.resolve(answer.yes);
    if (pending.has(bundleId)) return pending.get(bundleId);
    let started;
    try { started = Promise.resolve(spotlight(bundleId)); } catch { started = Promise.resolve(true); }
    const asking = started.catch(() => true).then((yes) => {
      answers.set(bundleId, { at: now(), yes: !!yes });
      pending.delete(bundleId);
      return !!yes;
    });
    pending.set(bundleId, asking);
    return asking;
  }

  const overridden = (bundleId) => override.includes(bundleId);

  /** Whether the browser counts as installed now: in appDirs, else Spotlight's answer, else (not answered yet) yes. */
  function has(bundleId) {
    if (!safeId(bundleId)) return false;
    if (override) return overridden(bundleId);
    if (where(bundleId)) return true;
    const answer = answers.get(bundleId);
    if (answer) {
      if (now() - answer.at >= SPOTLIGHT_MS) void askOne(bundleId);
      return answer.yes;
    }
    void askOne(bundleId);
    return true;
  }

  /** Spotlight asked about each browser not in appDirs, in the background (the choose screen opening). */
  function ask(bundleIds = Object.keys(APP_NAMES)) {
    if (override) return Promise.resolve();
    return Promise.all(bundleIds.filter((id) => safeId(id) && !where(id)).map(askOne)).then(() => undefined);
  }

  /** The browser's answer, waited for at most `maxMs` (no answer by then: installed) → Promise<boolean>. */
  function settled(bundleId, { maxMs = settleMs } = {}) {
    if (!safeId(bundleId)) return Promise.resolve(false);
    if (override) return Promise.resolve(overridden(bundleId));
    if (where(bundleId)) return Promise.resolve(true);
    let timer = null;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve(true), maxMs); });
    return Promise.race([askOne(bundleId), late]).finally(() => clearTimeout(timer));
  }

  return { has, ask, settled, where };
}

module.exports = { createInstalledApps, installedApp, plistNames, APP_NAMES };
