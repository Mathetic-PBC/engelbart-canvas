// Onboarding's order and gates (2026-09-28; as brainstorm cards since 2026-10-07, design/onboarding-brainstorm). Pure:
// screens/Onboarding.jsx asks where Submit, Skip and Wrap up go, and how their own words become the sentence.

import { launchRows, installable } from './tools.js';

/**
 * A new install: welcome, the tools (second, and only when something is missing: the cards need a working model), the
 * cards, then the project it opens. + Project on the all-projects screen: the cards and the project. 'open' (the
 * preparing screen) is in the flow but has no counter. The tools screen is left out when `tools` is false: the launch
 * check found nothing to install. Since 2026-10-08 (a hand test): two questions, then Putting it together; "What are you
 * least sure about?" is gone.
 */
export const FLOWS = {
  new: ['welcome', 'tools', 'working', 'why', 'together', 'open'],
  existing: ['working', 'why', 'together', 'open'],
};

/** The cards, in order: two questions, then their answers put together, with the question they settle on. */
export const CARDS = ['working', 'why', 'together'];

/** Each question card's words (BSC-2, BSC-3; the second reworded 2026-10-08, it was "Why this, and why now?"). */
export const QUESTIONS = {
  working: { title: 'What are you working on?', placeholder: 'In your own words…', label: 'What you are working on' },
  why: { title: 'Why are you interested in this?', placeholder: 'In a sentence or two…', label: 'Why you are interested in this' },
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

/**
 * The counter under a screen: `{ count, index }`, or null off the flow and on the preparing screen ('open', no step
 * counter since 2026-10-08), which is not counted either.
 */
export function pagerOf(mode, step, options) {
  const flow = flowOf(mode, options).filter((name) => name !== 'open');
  const index = flow.indexOf(step);
  return index < 0 ? null : { count: flow.length, index };
}

/**
 * A card's buttons: Skip and Submit always; Wrap up on the question cards only (on Putting it together there is nothing
 * to jump to). Submit is greyed on a question card while its field is empty; on Putting it together it always works
 * (2026-10-08: it waited for a blank nothing said was needed).
 */
export function cardButtons(step, value) {
  return { showWrap: !!QUESTIONS[step], submitDisabled: step === 'together' ? false : !String(value || '').trim() };
}

const LEADS = {
  working: /^(?:(?:i['’]?m|i\s+am|we['’]?re|we\s+are)\s+)?(?:currently\s+)?(?:working\s+on|studying|researching|looking\s+(?:at|into))\s+/i,
  why: /^(?:so\s+that|because|since|so)\s+/i,
};

/**
 * An answer as it reads inside the sentence: what the sentence already says taken off its start ("I'm working on",
 * "because", "so that"), lower case unless it starts with a name or an acronym, no full stop.
 */
export function theirWords(text, kind) {
  let words = String(text || '').replace(/\s+/g, ' ').trim();
  if (LEADS[kind]) words = words.replace(LEADS[kind], '');
  words = words.replace(/[.!…]+$/, '').trim();
  const first = words.split(' ')[0] || '';
  const keep = first === 'I' || /^I['’]/.test(first) || (first.length > 1 && first === first.toUpperCase()) || /^[A-Z][a-z]*[A-Z]/.test(first);
  return words && !keep ? words[0].toLowerCase() + words.slice(1) : words;
}

/** Putting it together's two parts, from the answers: their words, not Bart's. */
export function partsOf(answers) {
  return { working: theirWords(answers.working, 'working'), why: theirWords(answers.why, 'why') };
}

/**
 * The sentence's clauses, in order, each with the part it is made from ('working', 'why'): "I'm working on …",
 * "because …". A part left empty is left out with the words that lead into it, so what is left still reads.
 */
export function clausesOf({ working = '', why = '' }) {
  const w = theirWords(working, 'working'), y = theirWords(why, 'why');
  const clauses = [];
  if (w) clauses.push({ part: 'working', text: `I’m working on ${w}` });
  if (y) clauses.push({ part: 'why', text: clauses.length ? `because ${y}` : `I’m interested in this because ${y}` });
  return clauses;
}

/**
 * Putting it together's sentence (2026-10-08): Bart joins their answers so it reads naturally, keeping their words
 * (main/bart/onboard.cjs join), as a frame around their two parts: { lead, join, end } and which parts it holds. Until
 * he has (JOIN_MS at most), or when he could not, the frame is their words as they are (FRAME).
 */
export const JOIN_MS = 3000;
export const FRAME = { lead: 'I’m working on ', join: ' because ', end: '.', parts: ['working', 'why'] };

/** Bart's join as main sends it → { frame, parts } for the card, or null when it is not one (the card keeps FRAME). */
export function joinedOf(out) {
  if (!out || typeof out !== 'object') return null;
  const text = (key) => (typeof out[key] === 'string' ? out[key] : '');
  const parts = ['working', 'why'].filter((key) => text(key).trim());
  if (!parts.length || !text('lead').trim()) return null;
  return { frame: { lead: text('lead'), join: parts.length > 1 ? text('join') : '', end: text('end'), parts }, parts: { working: text('working').trim(), why: text('why').trim() } };
}

/**
 * The sentence as the project's description: Bart's frame around their parts as they now are; their words alone
 * ("I'm working on … because …."; nothing at all is '') without one, or when a part his frame holds was emptied.
 */
export function sentenceOf(parts, frame = null) {
  const own = (key) => String((parts || {})[key] || '').replace(/\s+/g, ' ').trim();
  if (frame && frame !== FRAME && frame.parts.every((key) => own(key))) {
    const [first, second] = frame.parts;
    return `${frame.lead}${own(first)}${second ? `${frame.join}${own(second)}` : ''}${frame.end}`.replace(/\s+/g, ' ').trim();
  }
  const clauses = clausesOf(parts || {});
  return clauses.length ? `${clauses.map((clause) => clause.text).join(' ')}.` : '';
}

/** A question as the field and the title show it: one line, a capital first, a question mark last; '' for none. */
export function questionOf(text) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().replace(/[.!…]+$/, '');
  return words ? `${words[0].toUpperCase()}${words.slice(1)}${words.endsWith('?') ? '' : '?'}` : '';
}

/** The plan when Bart could not be asked at all: a name from their words, their question, no sub-questions. */
export function planFallback(answers, question) {
  const words = theirWords(answers.working, 'working').split(' ').filter((word) => word.length > 3).slice(0, 4);
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
