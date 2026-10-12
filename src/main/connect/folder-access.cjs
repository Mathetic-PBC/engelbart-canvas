'use strict';

// MATH-110 (2026-10-11): macOS's folder access, asked for once, all together and explained, on Connect your library's
// choose screen, instead of prompts popping up mid-run. macOS asks the first time a program reads inside a protected
// folder (System Settings → Privacy & Security → Files and Folders): the Desktop, Documents and Downloads, iCloud Drive
// and the drives under ~/Library/CloudStorage. Three things in a run did that: the PDF scan, a ticked local repo under
// one of them, and MATH-117's search for an app's folder.
//   protectedFolders  the protected folders on this Mac (those that exist), with the names the panel shows
//   needed(choices)   those a run with these choices would read, not asked about before
//   ask(ids)          reads each one in turn (async, so the window never waits), so that macOS shows its prompts one
//                     after another; EPERM or EACCES is "denied". The answers go to <dataRoot>/.connect/folders.json,
//                     and a folder answered once is never asked about again.
//   guard(...)        readable(dir): false inside a protected folder that was not allowed, unless inside a folder the
//                     person picked themselves (macOS lets a program read what was picked in its folder picker)
// Nothing here reads inside a protected folder except ask().
// Off the Mac (Windows, Linux: docs/windows-port-log.md "Catch-up to 0.1.18") no folder is protected: none is asked about,
// and everything may be read, as before MATH-110.

const nodeFs = require('node:fs');
const path = require('node:path');

const LOCAL_PDFS = 'PDFs on this Mac';
const ICLOUD = path.join('Library', 'Mobile Documents', 'com~apple~CloudDocs');
const CLOUD = path.join('Library', 'CloudStorage');
const FILE = 'folders.json';

const guards = (platform) => platform === 'darwin';
const inside = (dir, folder) => dir === folder || dir.startsWith(folder + path.sep);
const isDir = (fs, dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };

/** A drive's shown name from its folder under ~/Library/CloudStorage ("GoogleDrive-me@x.com" → "Google Drive"). */
function driveName(name) {
  if (/^GoogleDrive/i.test(name)) return 'Google Drive';
  if (/^Dropbox/i.test(name)) return 'Dropbox';
  if (/^OneDrive/i.test(name)) return 'OneDrive';
  if (/^Box/i.test(name)) return 'Box';
  return name.split('-')[0] || name;
}

/**
 * The protected folders on this Mac that exist → [{ id, path, name, covers }]: `id` is the path under the home folder,
 * `covers` what macOS guards along with it (iCloud Drive guards all of ~/Library/Mobile Documents). Reading
 * ~/Library/CloudStorage itself is not inside a drive, so no prompt comes of listing it.
 */
function protectedFolders({ homeDir, fs = nodeFs, platform = process.platform } = {}) {
  const out = [];
  if (!guards(platform)) return out;
  for (const [id, name] of [['Desktop', 'Desktop'], ['Documents', 'Documents'], ['Downloads', 'Downloads'], [ICLOUD, 'iCloud Drive']]) {
    const full = path.join(homeDir, id);
    if (isDir(fs, full)) out.push({ id, path: full, name, covers: id === ICLOUD ? path.join(homeDir, 'Library', 'Mobile Documents') : full });
  }
  let drives = [];
  try { drives = fs.readdirSync(path.join(homeDir, CLOUD)).filter((name) => !name.startsWith('.')).sort(); } catch { /* none */ }
  const named = drives.map((name) => ({ name, shown: driveName(name) }));
  for (const { name, shown } of named) {
    const full = path.join(homeDir, CLOUD, name);
    if (!isDir(fs, full)) continue;
    // Two accounts of one drive are told apart by the account.
    const twin = named.filter((other) => other.shown === shown).length > 1;
    const account = name.includes('-') ? name.slice(name.indexOf('-') + 1) : name;
    out.push({ id: path.join(CLOUD, name), path: full, name: twin ? `${shown} (${account})` : shown, covers: full });
  }
  return out;
}

/** What folders.json says: { [id]: 'allowed' | 'denied' }. */
function readAnswers(dataRoot, { fs = nodeFs } = {}) {
  if (!dataRoot) return {};
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(dataRoot, '.connect', FILE), 'utf8'));
    const out = {};
    for (const [id, entry] of Object.entries((saved && saved.asked) || {})) {
      const answer = entry && typeof entry === 'object' ? entry.answer : entry;
      if (answer === 'allowed' || answer === 'denied') out[id] = answer;
    }
    return out;
  } catch { return {}; }
}

function writeAnswers(dataRoot, answers, { fs = nodeFs, now = () => new Date() } = {}) {
  if (!dataRoot) return;
  const file = path.join(dataRoot, '.connect', FILE);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { /* first time */ }
  const asked = { ...((saved && saved.asked) || {}) };
  const at = now().toISOString();
  for (const [id, answer] of Object.entries(answers)) asked[id] = { answer, at };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ asked }, null, 2)}\n`);
}

/**
 * Who may be read: `readable(dir)` is false for a folder inside a protected one not allowed, unless it is inside one of
 * `picked` (folders the person chose in the folder picker) or is a protected folder's parent (the home folder).
 * `allowed` and `blocked` are the protected folders by answer, a folder never asked about counting as blocked.
 */
function guard({ homeDir, dataRoot = null, answers = null, picked = [], fs = nodeFs, platform = process.platform } = {}) {
  const said = answers || readAnswers(dataRoot, { fs });
  const all = protectedFolders({ homeDir, fs, platform });
  const allowed = all.filter((folder) => said[folder.id] === 'allowed');
  const blocked = all.filter((folder) => said[folder.id] !== 'allowed');
  // A drive that is not there yet, or one this list missed, is guarded all the same.
  const guarded = [...blocked.map((folder) => folder.covers), ...['Desktop', 'Documents', 'Downloads', path.join('Library', 'Mobile Documents'), CLOUD]
    .filter((id) => !all.some((folder) => folder.id === id || (id === path.join('Library', 'Mobile Documents') && folder.id === ICLOUD)))
    .map((id) => path.join(homeDir, id))].filter(() => guards(platform));
  const free = [...allowed.map((folder) => folder.covers), ...picked.filter(Boolean).map((dir) => path.resolve(dir))];
  const readable = (dir) => {
    if (!dir) return false;
    const full = path.resolve(dir);
    if (free.some((folder) => inside(full, folder))) return true;
    // ~/Library/CloudStorage itself only lists the drives.
    if (full === path.join(homeDir, CLOUD)) return true;
    return !guarded.some((folder) => inside(full, folder));
  };
  return { readable, allowed, blocked, answers: said };
}

/** The protected folder `dir` is in, of `folders`, or null. */
const folderOf = (folders, dir) => folders.find((folder) => inside(path.resolve(dir), folder.covers)) || null;

/**
 * The protected folders a run with these choices would read and that were never asked about → [{ id, name }]:
 * all of them when PDFs on this Mac is ticked with file access on; the one above each ticked local repo; else none.
 * `choices` as the renderer sends them (choicesOf) or as cleanChoices keeps them.
 */
function needed(choices, { homeDir, dataRoot = null, fs = nodeFs, platform = process.platform } = {}) {
  const all = protectedFolders({ homeDir, fs, platform });
  const said = readAnswers(dataRoot, { fs });
  const want = new Set();
  const sources = (choices && choices.sources) || {};
  const files = !!(choices && ((choices.permissions && choices.permissions.files) || choices.computer));
  const papers = sources.papers;
  const pdfs = papers && papers.on !== false && (Array.isArray(papers.apps) ? papers.apps.includes(LOCAL_PDFS) : !!papers.on);
  if (pdfs && files) all.forEach((folder) => want.add(folder.id));
  const code = sources.code;
  const full = (dir) => { const raw = String(dir || ''); return raw.startsWith('~/') ? path.join(homeDir, raw.slice(2)) : raw; };
  // A folder the person picked themselves needs no asking: macOS lets Engelbart read it.
  const picked = (Array.isArray(choices && choices.picked) ? choices.picked : []).map(full).filter((dir) => path.isAbsolute(dir));
  if (code && code.on !== false) {
    for (const dir of (code.folders || []).map(full)) {
      if (!path.isAbsolute(dir) || picked.some((one) => inside(path.resolve(dir), path.resolve(one)))) continue;
      const folder = folderOf(all, dir);
      if (folder) want.add(folder.id);
    }
  }
  return all.filter((folder) => want.has(folder.id) && !said[folder.id]).map((folder) => ({ id: folder.id, name: folder.name }));
}

/**
 * Reads each of `ids` in turn, so that macOS asks about them one after another → { [id]: 'allowed' | 'denied' }, and
 * writes the answers to folders.json. A folder that is not there is left out.
 */
async function ask(ids, { homeDir, dataRoot = null, fs = nodeFs, now, platform = process.platform } = {}) {
  const all = protectedFolders({ homeDir, fs, platform });
  const answers = {};
  for (const id of Array.isArray(ids) ? ids : []) {
    const folder = all.find((each) => each.id === id);
    if (!folder) continue;
    try {
      await fs.promises.readdir(folder.path);
      answers[id] = 'allowed';
    } catch (failure) {
      if (failure && failure.code === 'ENOENT') continue;
      answers[id] = 'denied';
    }
  }
  if (Object.keys(answers).length) writeAnswers(dataRoot, answers, { fs, now });
  return answers;
}

module.exports = { guards, protectedFolders, readAnswers, writeAnswers, guard, needed, ask, driveName, folderOf, ICLOUD, CLOUD };
