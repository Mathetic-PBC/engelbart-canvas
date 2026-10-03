// An @discover reading guide's papers kept from the guide (2026-10-02): each entry's title line ends in a button that saves
// the paper to the library and this workspace, as + Save does at the Stage's address. Pure: which lines are titles, what
// the button says, what a click does. The guide in workspace.md is never touched: the button is drawn, not written.
//
// An entry (main/bart/discover-system-prompt.cjs "The guide"):
//   **[Title](address)** · First author et al. · Year
//   **Read:** [section](address#find=…&to=…)   or   **Read:** abstract only

import { paperRow } from './stage.js';

// A title line starts with a bold link; the words after it (authors, year) are not read.
const TITLE_RE = /^\*\*\[([^\]\n]+)\]\(([^)\s]+)\)/;
// An entry read from its abstract alone points to no text to keep (its address is usually a DOI's landing page).
const ABSTRACT_ONLY_RE = /^\*\*Read:\*\*\s*["“]?abstract only\b/i;
// What the library takes a name to be (ipc add-library-item).
const MAX_NAME = 200;

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
  if (address.startsWith('/') && /%[0-9a-f]{2}/i.test(address)) { try { address = decodeURIComponent(address); } catch { /* as written */ } }
  if (!/^(?:https?:\/\/\S|\/|file:\/\/)/i.test(address)) return null;
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
