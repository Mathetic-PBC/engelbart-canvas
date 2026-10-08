// Onboarding's order and gates (2026-09-28; as brainstorm cards since 2026-10-07, design/onboarding-brainstorm). Pure:
// screens/Onboarding.jsx asks where Submit, Skip and Wrap up go.

import { launchRows, installable } from './tools.js';

/**
 * A new install: welcome, the tools (second, and only when something is missing: the cards need a working model), the
 * cards, then the project it opens. + Project on the all-projects screen: the cards and the project. 'open' is the
 * preparing screen. The tools screen is left out when `tools` is false: the launch check found nothing to install.
 * Since 2026-10-08 (a hand test: Bart's question from two thin answers was a guess): what they work on, what they are
 * trying to do with it, then the research question they want to start with, theirs (or an example of Bart's they
 * chose). "Putting it together" and the joined sentence are gone, and so is the step counter.
 */
export const FLOWS = {
  new: ['welcome', 'tools', 'working', 'goal', 'question', 'open'],
  existing: ['working', 'goal', 'question', 'open'],
};

/** The cards, in order. */
export const CARDS = ['working', 'goal', 'question'];

/** Each card's words. The question card also has Bart's examples (screens/Onboarding.jsx). */
export const QUESTIONS = {
  working: { title: 'What are you working on?', placeholder: 'In your own words…', label: 'What you are working on' },
  goal: { title: 'What are you trying to do with it?', placeholder: 'Build a model, write a review, decide what to try…', label: 'What you are trying to do with it' },
  question: { title: 'What research question would you like to start with?', placeholder: 'Your question…', label: 'The research question you want to start with' },
};

export function flowOf(mode, { tools = true } = {}) {
  const flow = FLOWS[mode] || FLOWS.new;
  return tools ? flow : flow.filter((step) => step !== 'tools');
}

/** Where Continue, Submit or Skip go from `step`: the next step of the flow ('open' after the last card). */
export function forward(mode, step, options) {
  const full = FLOWS[mode] || FLOWS.new;
  const flow = flowOf(mode, options);
  const at = full.indexOf(step);
  return (at < 0 ? null : full.slice(at + 1).find((name) => flow.includes(name))) || step;
}

/** Wrap up: from the first two cards straight to the question card; anywhere else, on as Submit goes. */
export function wrapUp(mode, step, options) {
  return step === 'working' || step === 'goal' ? 'question' : forward(mode, step, options);
}

/**
 * A card's buttons: Skip and Submit always; Wrap up on the first two cards only. Submit is greyed while the field is
 * empty (Skip on the question card opens the project on a question of Bart's).
 */
export function cardButtons(step, value) {
  return { showWrap: step === 'working' || step === 'goal', submitDisabled: !String(value || '').trim() };
}

/** The project's description: their two answers, as they wrote them. */
export function descriptionOf({ working = '', goal = '' } = {}) {
  const line = (text) => { const words = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!…]+$/, ''); return words ? `${words[0].toUpperCase()}${words.slice(1)}.` : ''; };
  return [line(working), goal.trim() ? `Trying to: ${line(goal)}` : ''].filter(Boolean).join(' ');
}

/** A question as the field and the title show it: one line, a capital first, a question mark last; '' for none. */
export function questionOf(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!…]+$/, '');
  return words ? `${words[0].toUpperCase()}${words.slice(1)}${words.endsWith('?') ? '' : '?'}` : '';
}

/** The plan when Bart could not be asked at all: a name from their words, their question, no sub-questions. */
export function planFallback(answers, question) {
  const words = String(answers.working || '').replace(/^(?:i['’]?m|i\s+am)\s+(?:working\s+on|studying)\s+/i, '').toLowerCase().split(/\s+/).filter((word) => word.length > 3).slice(0, 4);
  const name = words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') : 'New project';
  return { name, question: questionOf(question), starts: [] };
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

/* ------------------------------------------------------------ preparing the first places to start (build 2) */

/**
 * The longest the preparing screen after Open project stays up (60 s since 2026-10-08; it was 20): then the workspace
 * opens with what there is, the rest filling in.
 */
export const PREPARE_MS = 60_000;

/** Approved papers under the first sub-question that end the preparing screen. */
export const FIRST_PAPERS = 2;

/** Whether a climb has something approved to show: a rung read and approved, or the step that stands in for one. */
export const hasApproved = (climb) => !!(climb && Array.isArray(climb.rungs) && climb.rungs.length);

/** How many approved papers a climb shows (a step that is not a paper is not one). */
export const papersIn = (climb) => (climb && Array.isArray(climb.rungs) ? climb.rungs.filter((rung) => rung && rung.kind === 'paper').length : 0);

/**
 * The preparing screen after Open project, from what is known: `starts` [{ id, text }] once the project is made (null
 * while the plan is still being written), `climbs` { <start id>: climb } (main/bart/climbs.cjs), `elapsedMs` since Open
 * project. → { done, label }: done once the first sub-question has FIRST_PAPERS approved papers, or its climb has ended
 * with fewer (nothing more is coming), or after PREPARE_MS, or at once when there are no sub-questions (2026-10-08: it
 * waited for an item under every sub-question, at most 20 s). The label names the step under way for the first,
 * lowercase: reading your answers (the plan), finding papers (picked and read, a draft written), checking each passage
 * (the approval).
 */
export function preparingState({ starts = null, climbs = {}, elapsedMs = 0 } = {}) {
  if (!starts) return { done: false, label: 'reading your answers' };
  if (!starts.length || elapsedMs >= PREPARE_MS) return { done: true, label: 'checking each passage' };
  const first = (climbs || {})[starts[0].id] || null;
  if (papersIn(first) >= FIRST_PAPERS) return { done: true, label: 'checking each passage' };
  if (first && (first.status === 'done' || first.status === 'unavailable')) return { done: true, label: 'checking each passage' };
  const finding = !first || first.step === 'reading' || first.step === 'finding';
  return { done: false, label: finding ? 'finding papers' : 'checking each passage' };
}
