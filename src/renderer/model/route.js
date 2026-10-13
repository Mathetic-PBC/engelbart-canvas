// Bart, the router, in the editor (2026-10-12). An `@bart` line picks its agent here first, by rule; only a line no
// rule settles is sent to the model (src/main/bart/route.cjs), with what this module reads of the document around it:
// its section, the threads above and the spec above, if any.
import { parseLines, threads, turnText, answeredBy, tokenOf, answerFences } from './doc.js';
import { readFlags, readBuildFlag, effortOf } from '../../main/bart/question.cjs';

const LEVEL_RE = /(^|\s)--(quick|standard|deep)(?=\s|$)/i;
// The models' words when the models file is not loaded yet: a flag naming one still means a question for Chat.
const MODEL_WORDS = new Set(['haiku', 'sonnet', 'opus', 'fable', 'luna', 'sol', 'astra']);
// A thread's question as the router is sent it, at most (main's bart/route.cjs reads 80 too).
export const QUESTION_CHARS = 80;

/**
 * A thread's question as the router reads it: its first line, as plain text (mentions as their names, links as their
 * words, markdown marks, agent tokens and flags gone), cut at a word to at most QUESTION_CHARS characters. A thread asked
 * with a pasted document under it is still one short line.
 */
export function questionLine(text, max = QUESTION_CHARS) {
  let s = String(text == null ? '' : text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  s = s.replace(/@\[([^\]\n]+)\]\([^)\s]*\)/g, '$1').replace(/@\[([^\]\n]+)\]/g, '$1')
    .replace(/(^|\s)@(?:bart|chat|brainstorm|orient|discover)\b/gi, '$1').replace(/(^|\s)--\S+/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2').replace(/[*`]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1), space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : s.slice(0, max)).replace(/[\s,;:–—-]+$/, '');
}

/** Whether the text after `@bart` carries a model or effort flag. */
function hasModelFlag(text, models) {
  if (models && models.providers) { const { chosen, effort } = readFlags(text, models); return !!(chosen || effort); }
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const flag = (word) => /^--\S/.test(word || '') && (effortOf(word.slice(2)) || MODEL_WORDS.has(word.slice(2).toLowerCase()));
  return !!(flag(words[0]) || flag(words[words.length - 1]));
}

/**
 * The agent an `@bart` line goes to by rule, or null when no rule settles it and the model is asked. `text`: the line
 * after `@bart`; `lines`, `at`: the document and the line's index (for the thread it is under); `models`: the models
 * file, when loaded; `current`: the agent the thread a follow-up goes on with is with (routeInputs). → { agent: 'chat' |
 * 'brainstorm' | 'discover' | 'build', rule } | null. In order:
 *   an empty line → brainstorm; --build → Build; --quick, --standard or --deep → discover; a model or effort flag → chat,
 *   unless the line follows up a thread, where the flag is for whichever agent answers.
 * A line under a thread is no longer settled by its thread's agent (2026-10-13): the model is told which agent the
 * conversation is with (`current`) and stays with it unless the line clearly wants another.
 */
export function routeByRule(text, { models = null, current = null } = {}) {
  const said = String(text || '');
  if (!said.trim()) return { agent: 'brainstorm', rule: 'empty' };
  if (readBuildFlag(said).build) return { agent: 'build', rule: '--build' };
  if (LEVEL_RE.test(said)) return { agent: 'discover', rule: 'level' };
  if (!current && hasModelFlag(said, models)) return { agent: 'chat', rule: 'model flag' };
  return null;
}

/** The text a Build is started from for a turn: the last fenced block of its answer as the document holds it, else the question and the answer. */
export function buildTextOf(lines, turn) {
  const { question, answer } = turnText(lines, turn);
  const fences = answerFences(answer);
  return fences.length ? fences[fences.length - 1] : [question, answer].filter(Boolean).join('\n\n');
}

/**
 * What the router reads around the `@bart` line at `at`: { section, threads, specAbove, spec, current }.
 *   section: from the nearest heading above (it included) to the line;
 *   threads: every thread above, each { agent (its token), question (the first line of its first question, plain, at most
 *     QUESTION_CHARS characters: questionLine), up (lines above the line) };
 *   spec: the last fenced block of the last answer of the nearest answered turn above in the section, or null;
 *   current: when the line follows up a thread (a turn of it, or directly under its last answer), the token of the agent
 *     that answered it last ('chat', 'brainstorm' or 'discover'), else null (2026-10-13).
 * The router (main) takes the last five threads and the section's last 4,000 characters once agent replies are left out
 * (bart/route.cjs sectionText), so the section is sent whole here: cut first, it would hold less than that.
 */
export function routeInputs(lines, at) {
  const ps = parseLines(lines);
  let start = 0;
  for (let k = at - 1; k >= 0; k--) if (ps[k].type === 'h') { start = k; break; }
  // The threads begun above, the one the line goes on with among them (2026-10-13: an `@bart` line asked under a thread is
  // its next turn, doc.js followsIn), each read up to the line.
  const above = threads(lines, ps).filter((thread) => thread.from < at);
  const said = (thread) => thread.turns.filter((turn) => turn.q < at && turn.answered && !turn.pending);
  const list = above.map((thread) => ({ agent: tokenOf(answeredBy(thread)), question: questionLine(turnText(lines, thread.turns[0]).question), up: at - thread.from }));
  let spec = null;
  const near = [...above].reverse().find((thread) => thread.from >= start && said(thread).length);
  if (near) {
    const turn = said(near)[said(near).length - 1];
    const fences = answerFences(turnText(lines, turn).answer);
    if (fences.length) spec = fences[fences.length - 1];
  }
  const into = above.find((thread) => thread.to === at - 1 || thread.turns.some((turn) => turn.q === at));
  const agent = into ? answeredBy(into) : null;
  const current = agent === 'bart' || agent === 'brainstorm' || agent === 'discover' ? tokenOf(agent) : null;
  return { section: lines.slice(start, at + 1).join('\n'), threads: list, specAbove: spec != null, spec, current };
}
