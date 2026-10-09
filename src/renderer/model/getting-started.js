// Getting started (2026-10-09): the panel at the top of the "Getting started" workspace of a project a new user's
// onboarding made (workspace/GettingStarted.jsx; its state is main's, store/getting-started.cjs). Five steps ticked by
// hand; the open one is the first not ticked, or the one whose title was clicked; step 2 holds the workspaces Connect
// your library suggested (connect/session.cjs), each started with Start, or the person's own words.

export const STEPS = Object.freeze([
  { n: 1, title: 'See what came in.', hint: 'Click Library in the sidebar.' },
  { n: 2, title: 'Pick a workspace to start.', hint: '' },
  { n: 3, title: 'Brainstorm what to do next.', hint: 'In your workspace, type @brainstorm and press Enter.' },
  { n: 4, title: 'Find prior work.', hint: 'When the brainstorm ends, press @discover under the result.' },
  { n: 5, title: 'Ask about a paper.', hint: 'Open one from the reading guide, highlight a passage and ask Bart.' },
]);

export const EMPTY_HINT = 'Write, or ask @bart to explain, brainstorm, or find papers';
export const WAITING_LINE = "Still reading your library. Suggestions show up here when it's done.";

const ticksOf = (ticked) => [...new Set((ticked || []).filter((n) => Number.isInteger(n) && n >= 1 && n <= STEPS.length))].sort((a, b) => a - b);

/** The first step not ticked, or null when all are. */
export function firstOpen(ticked) {
  const done = new Set(ticksOf(ticked));
  const step = STEPS.find((entry) => !done.has(entry.n));
  return step ? step.n : null;
}

/** The step shown open: the one picked by its title, else the first not ticked. */
export const openStepOf = (ticked, picked) => (picked && STEPS.some((entry) => entry.n === picked) ? picked : firstOpen(ticked));

/** The ticks with step `n` turned over. */
export function toggled(ticked, n) {
  const now = new Set(ticksOf(ticked));
  if (now.has(n)) now.delete(n); else now.add(n);
  return ticksOf([...now]);
}

export const allDone = (ticked) => ticksOf(ticked).length === STEPS.length;
export const headerLine = (ticked) => `Getting started ${ticksOf(ticked).length}/${STEPS.length}`;

/**
 * What step 2 shows for connect-workspaces' answer → { kind: 'waiting' | 'ready' | 'none', cards, custom }: one card a
 * suggestion (`started` once picked), and what "Something else…" starts with (the project's description when there are
 * no suggestions).
 */
export function pickView(workspaces, description = '') {
  const status = workspaces && workspaces.status;
  if (status === 'waiting' || status === 'writing') return { kind: 'waiting', cards: [], custom: '' };
  const picked = new Set((workspaces && workspaces.picked) || []);
  const cards = status === 'ready' ? (workspaces.suggestions || []).map((entry, index) => ({ index, name: entry.name, description: entry.description || '', why: entry.why || '', started: picked.has(entry.name) })) : [];
  return cards.length ? { kind: 'ready', cards, custom: '' } : { kind: 'none', cards: [], custom: String(description || '') };
}
