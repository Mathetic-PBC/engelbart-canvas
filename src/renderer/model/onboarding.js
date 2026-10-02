// Onboarding's order and gates (2026-09-28; Claude Design "Onboarding.dc.html" and Hudson's tweaks in
// design/onboarding/TWEAKS.md). Pure: screens/Onboarding.jsx asks where Continue and Skip go.

import { hasTag } from './kind.js';
import { launchRows, installable } from './tools.js';

/**
 * A new install walks all six screens; + Project on the all-projects screen only the last two. The tools screen
 * (second, 2026-09-28: it replaces the setup dialog a first launch used to open) is left out when `tools` is false:
 * the launch check found nothing to install.
 */
export const FLOWS = { new: ['welcome', 'tools', 'import', 'instructions', 'create', 'context'], existing: ['create', 'context'] };

export function flowOf(mode, { tools = true } = {}) {
  const flow = FLOWS[mode] || FLOWS.new;
  return tools ? flow : flow.filter((step) => step !== 'tools');
}

/** Screens that are several screens in effect (2a, 2b …), one box shown at a time. */
export const SUBS = { import: ['github', 'url', 'pdf'], create: ['name', 'desc', 'folder'] };

/**
 * Where a forward move from `{ step, sub }` lands: the next part of the same screen, else the next screen, else 'open'
 * (after the context screen). `detour` is set when the context screen sent the person to add to the library outside
 * the flow (the existing-user flow has no import screen): the end of the import screen returns to context.
 * `options` as flowOf's: from a screen left out of the flow, the next one still in it.
 */
export function forward(mode, { step, sub = 0, detour = false }, options) {
  const parts = SUBS[step];
  if (parts && sub < parts.length - 1) return { step, sub: sub + 1 };
  if (step === 'context') return { step: 'open', sub: 0 };
  if (detour && step === 'import') return { step: 'context', sub: 0 };
  const full = FLOWS[mode] || FLOWS.new;
  const flow = flowOf(mode, options);
  const at = full.indexOf(step);
  const next = at < 0 ? null : full.slice(at + 1).find((name) => flow.includes(name));
  return next ? { step: next, sub: 0 } : { step, sub };
}

/** The pager under every screen of the flow: `{ count, index }`, or null off the flow (opening, a detour). */
export function pagerOf(mode, step, options) {
  const flow = flowOf(mode, options);
  const index = flow.indexOf(step);
  return index < 0 ? null : { count: flow.length, index };
}

/**
 * Whether a new install's onboarding has the tools screen, from the tool check's snapshot: null until the first check
 * has answered, then whether it found something Install all would install (Git missing, or neither agent installed).
 * What else the check asks about (signing in, an update) waits for the setup dialog after onboarding.
 */
export function toolsWanted(snapshot) {
  if (!snapshot || !snapshot.checked) return null;
  return installable(snapshot, launchRows(snapshot)).length > 0;
}

/** What each tool is for, under its name on the tools screen. */
export const TOOL_WHY = {
  git: 'Keeps the history of your code. Build needs it.',
  claude: 'Anthropic’s agent. Runs @bart and Build with your Claude account.',
  codex: 'OpenAI’s agent. Runs @bart and Build with your ChatGPT account.',
};

/**
 * The import screen's buttons, from how many rows its current part has (`n`): Skip while that part is empty; Continue
 * always shown and live once it holds something. It opens the next part, and after the last part the next screen
 * (there is no separate Next: Hudson, 2026-09-28). The GitHub part's Continue is live too once GitHub is connected
 * (`signedIn`), with nothing ticked: connecting is the step, a repository is not required (2026-10-02).
 */
export function importButtons(sub, n, { signedIn = false } = {}) {
  const connected = SUBS.import[sub] === 'github' && signedIn;
  return { showSkip: n === 0, continueDisabled: n === 0 && !connected };
}

/**
 * The create screen's: Skip only on an empty description; Continue (next part, then the context screen) greyed on an
 * empty name, an empty description, and an existing folder not yet named.
 */
export function createButtons(sub, { name, desc, folder = 'new', folderPath = '' }) {
  const part = SUBS.create[sub];
  const empty = (value) => !String(value || '').trim();
  return {
    showSkip: part === 'desc' && empty(desc),
    continueDisabled: (part === 'name' && empty(name)) || (part === 'desc' && empty(desc)) || (part === 'folder' && folder === 'existing' && empty(folderPath)),
  };
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** What a library row is, in the words of the context screen: "paper · arxiv.org", "git repo · github.com", "website · …". */
export function rowWhy(row) {
  const what = hasTag(row, 'git') ? 'git repo' : hasTag(row, 'paper') ? 'paper' : row.type === 'website' ? 'website' : row.type;
  const where = row.url && !/^file:/i.test(row.url) ? hostOf(row.url) : '';
  return [what, where].filter(Boolean).join(' · ');
}

/** The library rows a project can be given: everything but notes (they belong to their project) and pasted pictures. */
export function contextRows(library) {
  return (library || []).filter((row) => !hasTag(row, 'note') && row.type !== 'image');
}

/** The prompt "Import from an AI provider" copies (Hudson's wording, design chat message 58). */
export const PROFILE_PROMPT = `I want to export a research profile of me that I can give to another AI assistant or collaborator. Using everything you know about me from memory and our past conversations, write a structured profile of me *as a researcher*. Ignore personal, financial, and non-research details unless they directly shape my research.

Cover the following, and skip any section you have no real evidence for:

1. Field(s) and position: my disciplines, subfields, career stage, institutional affiliation (or independence), and how I describe my own work.
2. Core research questions and thesis: the central problem(s) I'm working on, the claims or constructs I've proposed, and what I'm arguing against or distancing myself from.
3. Current and past projects: for each, the question, study design, data, status (idea / running / analyzing / submitted / published), and target venue.
4. Methods and epistemology: my methodological commitments (e.g., qualitative vs. quantitative, specific analytic traditions), theoretical frameworks I build on, and standards of evidence I hold myself to.
5. Intellectual lineage: thinkers, papers, and traditions I draw on, and any I explicitly reject.
6. Collaborators and ecosystem: advisors, co-authors, labs, and communities, with each person's role.
7. Open problems: methodological or conceptual issues I'm currently stuck on or actively iterating on.
8. Trajectory: my research goals, target institutions or venues, and how I'm trying to get there.
9. Working style: how I want AI to engage with my research (tone, level of pushback, formatting, what to avoid).

Rules:
- Be specific. Use the exact terms, names, and framings I've used rather than generic paraphrases.
- Mark each claim with its epistemic status: [stated] if I said it directly, [inferred] if you're reading it from patterns in our conversations, [uncertain] if you're unsure or it may be outdated.
- Do not invent details, papers, or collaborators to fill gaps. An empty section is better than a fabricated one.
- Where something may have changed since I last mentioned it, note roughly when it came up.
- After the profile, list the 3–5 most important things you *don't* know about my research that would substantially improve the profile, so I can fill them in.

Output the final profile inside a single code block so I can copy it cleanly.`;
