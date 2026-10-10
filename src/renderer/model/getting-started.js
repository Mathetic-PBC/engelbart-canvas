// The Welcome walkthrough (2026-10-09; 21384b3's Getting started steps, in the "Suggested steps" look of
// design/onboarding-brainstorm/6-workspace.dc.html): under the title of a new user's "Welcome" workspace, "Get started":
// see what came in (the Library's tabs), @brainstorm, @discover (and the papers it found). workspace/GettingStarted.jsx
// draws it; its state is main's (store/getting-started.cjs). Pure.

import { LIBRARY_CHIPS, libraryCounts } from './kind.js';
import { REPLY_RE } from './doc.js';

export const STEPS = Object.freeze([
  { n: 1, title: 'See what came in', hint: 'Everything Connect brought in is in Library, in the sidebar, under these tabs.' },
  { n: 2, title: 'Brainstorm what to do next', hint: 'Type @brainstorm in this workspace and press Enter.' },
  { n: 3, title: 'Find prior work', hint: 'When the brainstorm ends, press @discover under the result. The papers it finds show here.' },
]);

/** The hint on an empty last line of a document while the walkthrough shows (the design's "Write your thoughts…"). */
export const EMPTY_HINT = 'Write your thoughts…';

const ticksOf = (ticked) => [...new Set((ticked || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= STEPS.length))].sort((a, b) => a - b);

/** The steps a workspace shows: all three in the Welcome workspace, none elsewhere or once hidden. */
export function stepsHere(state, workspaceId) {
  if (!state || state.hidden || !workspaceId || workspaceId !== state.workspaceId) return [];
  return STEPS.map((step) => ({ ...step, shown: step.n }));
}

/** The first of `steps` not ticked (its n), or null when all are: the one open to begin with. */
export function firstOpen(steps, ticked) {
  const done = new Set(ticksOf(ticked));
  const step = (steps || []).find((entry) => !done.has(entry.n));
  return step ? step.n : null;
}

const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Step 1's rows (2026-10-09: "show the tabs [of the library] as options and then how many items are in them"): the
 * Library panel's tabs that hold something (Notes, Papers, Repos, Web, Files), each with its count → [{ id, label,
 * count }], and `total` the rows under All.
 */
export function libraryTabs(rows) {
  const counts = libraryCounts(rows);
  const tabs = LIBRARY_CHIPS.filter((chip) => chip.id !== 'all' && counts[chip.id] > 0).map((chip) => ({ id: chip.id, label: chip.label, count: counts[chip.id] }));
  return { tabs, total: counts.all };
}

// An @discover guide's entry in a document (main/bart/discover-system-prompt.cjs "The guide"; model/guide.js): its title
// line "**[Title](address)** · First author et al. · Year", then "**Read:** [section](address#find=…)" and "**Why:** …".
const GUIDE_TITLE_RE = /^\*\*\[([^\]\n]+)\]\(([^)\s]+)\)\*\*\s*(?:·\s*(.*))?$/;
const GUIDE_READ_RE = /^\*\*Read:\*\*\s*\[([^\]\n]+)\]\(([^)\s]+)\)/;
const GUIDE_WHY_RE = /^\*\*Why:\*\*\s*(.+)$/;

/**
 * Step 3's papers: the ones @discover's guides in a workspace's document found, in order, each once, at most `max` →
 * [{ key, title, byline ("Kapur · 2008 · Method"), why, address (its Read link, at the passage, else the title's) }].
 */
export function discoverPapers(text, max = 3) {
  const out = [];
  const seen = new Set();
  let entry = null;
  for (const raw of String(text || '').split('\n')) {
    const reply = raw.match(REPLY_RE);
    if (!reply) { entry = null; continue; }
    const line = reply[2].trim();
    const title = line.match(GUIDE_TITLE_RE);
    if (title) {
      entry = null;
      const address = title[2].replace(/#.*$/, '');
      if (seen.has(address) || out.length >= max) continue;
      seen.add(address);
      entry = { key: address, title: title[1].trim(), by: String(title[3] || '').replace(/\s+et al\.?/i, '').trim(), section: '', why: '', address: title[2] };
      out.push(entry);
      continue;
    }
    if (!entry) continue;
    const read = line.match(GUIDE_READ_RE);
    if (read && !entry.section) { entry.section = read[1].trim(); entry.address = read[2]; continue; }
    const why = line.match(GUIDE_WHY_RE);
    if (why && !entry.why) entry.why = why[1].trim();
  }
  return out.map(({ by, section, ...paper }) => ({ ...paper, byline: [by, section].filter(Boolean).join(' · ') }));
}

/** What sits at the right of a step's row: how much is under it, or where it leads. */
export function stepMeta(n, { items = 0, papers = 0 } = {}) {
  if (n === 1) return items ? plural(items, 'item') : 'Library';
  if (n === 3) return papers ? plural(papers, 'paper') : '';
  return '';
}
