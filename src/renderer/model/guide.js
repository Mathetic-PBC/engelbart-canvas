// An @discover reading guide's papers kept from the guide (2026-10-02): each entry's title line ends in a button that saves
// the paper to the library and this workspace, as + Save does at the Stage's address. Pure: which lines are titles, what
// the button says, what a click does. The guide in workspace.md is never touched: the button is drawn, not written.
//
// An entry (main/bart/discover-system-prompt.cjs "The guide"):
//   **[Title](address)** · First author et al. · Year
//   **Read:** [section](address#find=…&to=…)   or   **Read:** abstract only
//   **Why:** …
//   **Try:** [owner/repo](https://github.com/owner/repo)   (2026-10-04: only when the paper's authors published one to run)
// The Try line's link opens the repository's page and also brings the repository into this workspace, which starts its
// sandbox (main/ipc.cjs add-library-item and startLinked); the editor draws a "Run" mark before it, never written.

import { paperRow } from './stage.js';

// A title line starts with a bold link; the words after it (authors, year) are not read.
const TITLE_RE = /^\*\*\[([^\]\n]+)\]\(([^)\s]+)\)/;
// An entry read from its abstract alone points to no text to keep (its address is usually a DOI's landing page).
const ABSTRACT_ONLY_RE = /^\*\*Read:\*\*\s*["“]?abstract only\b/i;
// What the library takes a name to be (ipc add-library-item).
const MAX_NAME = 200;
// A Try line: bold "Try:" and a link right after it; the link text is not read.
const TRY_RE = /^\*\*Try:\*\*\s*\[[^\]\n]+\]\(([^)\s]+)\)/;
// A repository's address as the library reads one (main/store/library.cjs GITHUB_RE), the web's spellings only.
const REPO_RE = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i;

/**
 * The paper a guide's line names → { title, address }, or null when it names none. `text` is the line's text (after
 * `bart> `), `next` the text of the line under it in the same answer (null when there is none). The address is the
 * title link's, without its #fragment; a path keeps no percent-encoding, as the library spells it. Only an address on
 * the web or a path from / (a library item's) can be kept.
 */
export function guideTitle(text, next = null) {
  const m = String(text == null ? '' : text).match(TITLE_RE);
  if (!m) return null;
  if (next != null && ABSTRACT_ONLY_RE.test(String(next).trim())) return null;
  let address = m[2].replace(/#.*$/, '');
  // A path on disk (on Windows, C:\…, its colon and backslashes encoded too) is the file's path once decoded.
  if (/^(?:\/|[a-z](?::|%3A))/i.test(address) && /%[0-9a-f]{2}/i.test(address)) { try { address = decodeURIComponent(address); } catch { /* as written */ } }
  if (!/^(?:https?:\/\/\S|\/|[a-z]:\\|file:\/\/)/i.test(address)) return null;
  const title = m[1].replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return title ? { title, address } : null;
}

/**
 * Where the paper at `address` is → { state, row }: 'none' (not in the library), 'lib' (in it, not in this workspace),
 * 'here' (in this workspace: `inRail(id)`, what makes the Stage's Save read ✓). The library row is found as the Stage
 * finds a link's (paperRow: an arXiv pdf is the row of its abstract page).
 */
export function paperState(library, address, inRail) {
  const row = paperRow(library, address);
  if (!row) return { state: 'none', row: null };
  return { state: inRail(row.id) ? 'here' : 'lib', row };
}

/**
 * The button clicked → what was done: 'saved' (a new row named with the title, linked here: `addInput(address, name)`,
 * the Stage's Save with Enter), 'linked' (the library's row brought into this workspace: `linkIds([id])`, never a second
 * row) or 'here' (nothing to do). Throws what those throw.
 */
export async function savePaper({ address, title, library, inRail }, { addInput, linkIds }) {
  const { state, row } = paperState(library, address, inRail);
  if (state === 'none') { await addInput(address, title); return 'saved'; }
  if (state === 'lib') { await linkIds([row.id]); return 'linked'; }
  return 'here';
}

/**
 * A GitHub repository's address in any spelling (.git, a path, a query, a #fragment) → { name: 'owner/repo', address:
 * 'https://github.com/owner/repo' } as the library spells it, or null when it is not one.
 */
export function repoOf(address) {
  const m = String(address == null ? '' : address).trim().match(REPO_RE);
  if (!m || /^\.+$/.test(m[1]) || /^\.+$/.test(m[2])) return null;
  return { name: `${m[1]}/${m[2]}`, address: `https://github.com/${m[1]}/${m[2]}` };
}

/** The repository a guide's Try line links (2026-10-04) → { name, address } (repoOf), or null for any other line. */
export function guideRepo(text) {
  const m = String(text == null ? '' : text).match(TRY_RE);
  return m ? repoOf(m[1]) : null;
}

/**
 * Where the repository at `address` is → { state, row }, as paperState: 'none', 'lib' or 'here'. The library's row is the
 * one whose address names the same owner/repo; GitHub reads both without case.
 */
export function repoState(library, address, inRail) {
  const repo = repoOf(address), key = repo ? repo.address.toLowerCase() : null;
  const row = key ? (library || []).find((item) => { const its = item && repoOf(item.url); return !!its && its.address.toLowerCase() === key; }) || null : null;
  if (!row) return { state: 'none', row: null };
  return { state: inRail(row.id) ? 'here' : 'lib', row };
}

/**
 * A Try link clicked → what was done: 'added' (a new row, named by the library as owner/repo, linked here:
 * `addInput(address)`), 'linked' (the library's row brought into this workspace: `linkIds([id])`, never a second row) or
 * 'here' (nothing to do). Either starts the repository's sandbox in main. Throws what those throw, and on an address that
 * is no repository.
 */
export async function tryRepo({ address, library, inRail }, { addInput, linkIds }) {
  const repo = repoOf(address);
  if (!repo) throw new TypeError('That link is not a GitHub repository');
  const { state, row } = repoState(library, repo.address, inRail);
  if (state === 'none') { await addInput(repo.address); return 'added'; }
  if (state === 'lib') { await linkIds([row.id]); return 'linked'; }
  return 'here';
}
