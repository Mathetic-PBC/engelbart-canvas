// Onboarding's order and gates (2026-09-28; as brainstorm cards since 2026-10-07, design/onboarding-brainstorm). Pure:
// screens/Onboarding.jsx asks where Submit, Skip and Wrap up go, and how their own words become the sentence.

import { launchRows, installable } from './tools.js';

/**
 * A new install: welcome, the tools (second, and only when something is missing: the cards need a working model), the
 * four cards, then the project it opens. + Project on the all-projects screen: the four cards and the project. 'open'
 * is the last dot of the pager (the design's "6 of 6" is the project). The tools screen is left out when `tools` is
 * false: the launch check found nothing to install.
 */
export const FLOWS = {
  new: ['welcome', 'tools', 'working', 'why', 'unsure', 'together', 'open'],
  existing: ['working', 'why', 'unsure', 'together', 'open'],
};

/** The cards, in order: three questions, then their answers put together. */
export const CARDS = ['working', 'why', 'unsure', 'together'];

/** Each question card's words (BSC-2 to BSC-4). */
export const QUESTIONS = {
  working: { title: 'What are you working on?', placeholder: 'In your own words…', label: 'What you are working on' },
  why: { title: 'Why this, and why now?', placeholder: 'In a sentence or two…', label: 'Why this, and why now' },
  unsure: { title: 'What are you least sure about?', placeholder: 'The part you can’t answer yet…', label: 'What you are least sure about' },
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

/** Wrap up: from a question card straight to Putting it together; anywhere else, on as Submit goes. */
export function wrapUp(mode, step, options) {
  return QUESTIONS[step] ? 'together' : forward(mode, step, options);
}

/** The pager under every screen: `{ count, index }`, or null off the flow. */
export function pagerOf(mode, step, options) {
  const flow = flowOf(mode, options);
  const index = flow.indexOf(step);
  return index < 0 ? null : { count: flow.length, index };
}

/**
 * A card's buttons: Skip and Submit always, Submit greyed while there is nothing to submit (the field, or the blank of
 * Putting it together); Wrap up on the question cards only (on Putting it together there is nothing to jump to).
 */
export function cardButtons(step, value) {
  return { showWrap: !!QUESTIONS[step], submitDisabled: !String(value || '').trim() };
}

const LEADS = {
  working: /^(?:(?:i['’]?m|i\s+am|we['’]?re|we\s+are)\s+)?(?:currently\s+)?(?:working\s+on|studying|researching|looking\s+(?:at|into))\s+/i,
  why: /^(?:so\s+that|because|since|so)\s+/i,
  findOut: /^(?:i\s+want\s+to\s+)?(?:find\s+out|figure\s+out|learn|know)\s+/i,
};

/**
 * An answer as it reads inside the sentence: what the sentence already says taken off its start ("I'm working on",
 * "because", "so that", "find out"), lower case unless it starts with a name or an acronym, no full stop.
 */
export function theirWords(text, kind) {
  let words = String(text || '').replace(/\s+/g, ' ').trim();
  if (LEADS[kind]) words = words.replace(LEADS[kind], '');
  words = words.replace(/[.!…]+$/, '').trim();
  const first = words.split(' ')[0] || '';
  const keep = first === 'I' || /^I['’]/.test(first) || (first.length > 1 && first === first.toUpperCase()) || /^[A-Z][a-z]*[A-Z]/.test(first);
  return words && !keep ? words[0].toLowerCase() + words.slice(1) : words;
}

/** Putting it together's three parts, from the answers: their words, not Bart's. The blank starts empty. */
export function partsOf(answers) {
  return { working: theirWords(answers.working, 'working'), findOut: '', why: theirWords(answers.why, 'why') };
}

/**
 * The sentence's clauses, in order, each with the part it is made from ('working', 'findOut', 'why'): "I'm working on
 * …", "because I want to find out …", "so that …". Parts left empty are left out with the words that lead into them, so
 * what is left still reads.
 */
export function clausesOf({ working = '', findOut = '', why = '' }) {
  const w = theirWords(working, 'working'), f = theirWords(findOut, 'findOut'), y = theirWords(why, 'why');
  const clauses = [];
  if (w) clauses.push({ part: 'working', text: `I’m working on ${w}` });
  if (f) clauses.push({ part: 'findOut', text: w ? `because I want to find out ${f}` : `I want to find out ${f}` });
  if (y) clauses.push({ part: 'why', text: clauses.length ? `so that ${y}` : `I’m doing this so that ${y}` });
  return clauses;
}

/** The sentence as the project's description: "I'm working on … because I want to find out … so that …."; nothing at all is ''. */
export function sentenceOf(parts) {
  const clauses = clausesOf(parts);
  return clauses.length ? `${clauses.map((clause) => clause.text).join(' ')}.` : '';
}

/**
 * Putting it together as it grows, above the question cards (BSC-3, BSC-4): their answers so far, in their words, as
 * the sentence will read (no blank yet), one clause per answer, the last of them the newest. [] before any answer.
 */
export function soFarOf(answers) {
  return clausesOf(partsOf(answers || {}));
}

/** The plan when Bart could not be asked at all: a name and a question from their words, no sub-questions. */
export function planFallback(answers, findOut) {
  const words = theirWords(answers.working, 'working').split(' ').filter((word) => word.length > 3).slice(0, 4);
  const name = words.length ? words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ') : 'New project';
  const asked = theirWords(findOut, 'findOut') || theirWords(answers.unsure, 'findOut');
  const question = asked ? `${asked[0].toUpperCase()}${asked.slice(1)}${asked.endsWith('?') ? '' : '?'}` : '';
  return { name, question, starts: [] };
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

/** The longest the preparing screen after Open project stays up: it ends sooner when every sub-question has something. */
export const PREPARE_MS = 20_000;

/** Whether a climb has something approved to show: a rung read and approved, or the step that stands in for one. */
export const hasApproved = (climb) => !!(climb && Array.isArray(climb.rungs) && climb.rungs.length);

/**
 * The preparing screen after Open project (2026-10-08), from what is known: `starts` [{ id, text }] once the project is
 * made (null while the plan is still being written), `climbs` { <start id>: climb } (main/bart/climbs.cjs), `elapsedMs`
 * since Open project. → { done, label }: done once every sub-question has at least one approved item, or after
 * PREPARE_MS, or at once when there are no sub-questions; the label names the step under way, lowercase: reading your
 * answers (the plan), finding places to start (papers read, a draft written), checking each step (the approval).
 */
export function preparingState({ starts = null, climbs = {}, elapsedMs = 0 } = {}) {
  if (!starts) return { done: false, label: 'reading your answers' };
  if (!starts.length || elapsedMs >= PREPARE_MS) return { done: true, label: 'checking each step' };
  const mine = starts.map((start) => (climbs || {})[start.id] || null);
  if (mine.every(hasApproved)) return { done: true, label: 'checking each step' };
  // Named by the sub-questions still waiting: the slowest of them is what the screen waits on.
  const finding = mine.filter((climb) => !hasApproved(climb)).some((climb) => !climb || climb.step === 'reading' || climb.step === 'finding');
  return { done: false, label: finding ? 'finding places to start' : 'checking each step' };
}
