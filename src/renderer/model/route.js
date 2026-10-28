// Bart, the router, in the editor (2026-10-12). An `@bart` line picks its agent here first, by rule; only a line no
// rule settles is sent to the model (src/main/bart/route.cjs), with what this module reads of the document around it:
// its section, the threads above and the spec above, if any.
import { parseLines, threads, turnText, answeredBy, tokenOf, answerFences, isResearch } from './doc.js';
import { readBuildFlag } from '../../main/bart/question.cjs';

const LEVEL_RE = /(^|\s)--(quick|standard|deep)(?=\s|$)/i;
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
    .replace(/(^|\s)@(?:bart|chat|brainstorm|orient|discover|create)\b/gi, '$1').replace(/(^|\s)--\S+/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2').replace(/[*`]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1), space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : s.slice(0, max)).replace(/[\s,;:–—-]+$/, '');
}

/**
 * The agent an `@bart` line goes to by rule, or null when no rule settles it and the model is asked. `text`: the line
 * after `@bart`; `lines`, `at`: the document and the line's index (for the thread it is under); `models`: the models
 * file, when loaded; `current`: the agent the thread a follow-up goes on with is with (routeInputs). → { agent: 'chat' |
 * 'brainstorm' | 'discover' | 'build', rule } | null. `models` and `current` are no longer read (2026-10-16), kept for
 * the callers. In order:
 *   an empty line → brainstorm; --build → Build; --quick, --standard or --deep → discover. (A line under Discover's open
 *   question went to Discover by rule from 2026-10-14; since MATH-165, 2026-10-28, the model is asked, shown that
 *   question: every other request asked there had been answered or refused by Discover.) A model or effort flag settles nothing (2026-10-16, David: "@bart --sonnet --medium I want to find an
 *   excerpt from a religious text" went to Chat by rule): it picks the model and effort of whichever agent answers, and
 *   the rest of the line is classified (main's bart/route.cjs reads it without the flags).
 * A line under a thread is no longer settled by its thread's agent (2026-10-13): the model is told which agent the
 * conversation is with (`current`) and stays with it unless the line clearly wants another.
 */
export function routeByRule(text, { models = null, current = null } = {}) {
  const said = String(text || '');
  if (!said.trim()) return { agent: 'brainstorm', rule: 'empty' };
  if (readBuildFlag(said).build) return { agent: 'build', rule: '--build' };
  if (LEVEL_RE.test(said)) return { agent: 'discover', rule: 'level' };
  return null;
}

/** The text a Build is started from for a turn: the last fenced block of its answer as the document holds it, else the question and the answer. */
export function buildTextOf(lines, turn) {
  const { question, answer } = turnText(lines, turn);
  const fences = answerFences(answer);
  return fences.length ? fences[fences.length - 1] : [question, answer].filter(Boolean).join('\n\n');
}

// A Build started straight from an `@bart` line (MATH-168, 2026-10-28): the request, then the conversation it was asked in,
// so a follow-up such as "now make it blue" says what "it" is. The latest turns, each answer cut, at most CONTEXT_CHARS.
const CONTEXT_TURNS = 4;
const ANSWER_CHARS = 4000;
const CONTEXT_CHARS = 12000;

/** The text a Build of `request` starts from, with `turns` ({ question, answer }, as DocEditor turnsBefore) above it. */
export function buildWithContext(request, turns = []) {
  const cut = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
  const said = [];
  let left = CONTEXT_CHARS;
  for (const turn of turns.slice(-CONTEXT_TURNS).reverse()) {
    const part = [`Asked: ${String(turn.question || '').trim()}`, turn.answer ? `Answered: ${cut(String(turn.answer).trim(), ANSWER_CHARS)}` : ''].filter(Boolean).join('\n');
    if (part.length > left) break;
    said.unshift(part);
    left -= part.length;
  }
  return said.length ? `${request}\n\nThis was asked in a conversation. What was said before it, oldest first:\n\n${said.join('\n\n')}` : request;
}

/**
 * What the router reads around the `@bart` line at `at`: { section, threads, specAbove, spec, specTitle, current, asking,
 * discoverAsked }.
 *   section: from the nearest heading above (it included) to the line;
 *   threads: every thread above, each { agent (its token), question (the first line of its first question, plain, at most
 *     QUESTION_CHARS characters: questionLine), up (lines above the line) };
 *   spec: the last fenced block of the last answer of the nearest answered turn above in the section, or null;
 *   specTitle: its first line, plain and cut as a thread's question is (questionLine), or '' (2026-10-13: so the router can
 *     tell a line asking for that spec to be built from one asking for something of its own);
 *   current: when the line follows up a thread (a turn of it, or directly under its last answer), the token of the agent
 *     that answered it last ('chat', 'brainstorm' or 'discover'), else null (2026-10-13);
 *   asking: that agent is Discover and its last turn neither searched nor gave a guide: it is still settling what to
 *     research, and the line may answer it (2026-10-14);
 *   discoverAsked: then, what Discover asked, plain, at most ASKED_CHARS characters (discoverAskedOf), else null. The
 *     router is shown it (MATH-165): an answer to it stays with Discover, anything else goes where it is for.
 * The router (main) takes the last five threads and the section's last 4,000 characters once agent replies are left out
 * (bart/route.cjs sectionText), so the section is sent whole here: cut first, it would hold less than that.
 */
/**
 * The agent a follow-up goes to when Bart could not pick (2026-10-13): the one its conversation is with, but Chat for a
 * conversation with Discover, whose reply would otherwise start a new search.
 */
export const fallbackAgent = (current) => (current && current !== 'discover' ? current : 'chat');

// What Discover asked, as the router is sent it, at most (main's bart/route.cjs cuts it to 300 too).
export const ASKED_CHARS = 300;
/**
 * What a Discover answer still settling what to research asks, as the router reads it: an opening card's title and its
 * options' labels; else the answer as plain text, its end kept (the question is its last paragraph), cut at a word.
 */
export function discoverAskedOf(answer, max = ASKED_CHARS) {
  const said = String(answer == null ? '' : answer);
  const fenced = said.match(/^\s*(?:```(?:json)?\s*)?(\{[\s\S]*\})\s*(?:```)?\s*$/);
  if (fenced) {
    try {
      const focus = JSON.parse(fenced[1]).focus;
      const labels = focus && Array.isArray(focus.options) ? focus.options.map((option) => (typeof option === 'string' ? option : option && option.label)).filter(Boolean) : [];
      if (focus && focus.title) return `${focus.title}${labels.length ? ` (options: ${labels.join('; ')})` : ''}`.slice(0, max);
    } catch { /* plain text */ }
  }
  const plain = said.replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1').replace(/(\*\*|__|\*|`)/g, '').replace(/\s+/g, ' ').trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(plain.length - max), space = cut.indexOf(' ');
  return space > 0 ? cut.slice(space + 1) : cut;
}

export function routeInputs(lines, at) {
  const ps = parseLines(lines);
  let start = 0;
  for (let k = at - 1; k >= 0; k--) if (ps[k].type === 'h') { start = k; break; }
  // The threads begun above, the one the line goes on with among them (2026-10-13: an `@bart` line asked under a thread is
  // its next turn, doc.js followsIn), each read up to the line.
  const above = threads(lines, ps).filter((thread) => thread.from < at);
  // A Build card under its `--build` line is that turn's answer (doc.js threads, 2026-10-13), but no answer to route by:
  // the spec above and the conversation a line goes on with are read as they were before it counted.
  const said = (thread) => thread.turns.filter((turn) => turn.q < at && turn.answered && !turn.pending && !turn.build);
  const list = above.map((thread) => ({ agent: tokenOf(answeredBy(thread)), question: questionLine(turnText(lines, thread.turns[0]).question), up: at - thread.from }));
  let spec = null;
  const near = [...above].reverse().find((thread) => thread.from >= start && said(thread).length);
  if (near) {
    const turn = said(near)[said(near).length - 1];
    const fences = answerFences(turnText(lines, turn).answer);
    if (fences.length) spec = fences[fences.length - 1];
  }
  const built = (thread) => !!thread.turns[thread.turns.length - 1].build;
  const into = above.find((thread) => (thread.to === at - 1 && !built(thread)) || thread.turns.some((turn) => turn.q === at));
  const agent = into ? answeredBy(into) : null;
  const current = agent === 'bart' || agent === 'brainstorm' || agent === 'discover' ? tokenOf(agent) : null;
  const specTitle = spec != null ? questionLine(spec.split('\n').find((line) => line.trim()) || '') : '';
  // Discover still settling what to research (2026-10-14): its last turn is not a research box and gave no guide.
  const last = into && agent === 'discover' ? said(into).pop() : null;
  const asking = !!last && !isResearch(ps[last.q]) && !/^## /m.test(turnText(lines, last).answer);
  const discoverAsked = asking ? discoverAskedOf(turnText(lines, last).answer) || null : null;
  return { section: lines.slice(start, at + 1).join('\n'), threads: list, specAbove: spec != null, spec, specTitle, current, asking, discoverAsked };
}
