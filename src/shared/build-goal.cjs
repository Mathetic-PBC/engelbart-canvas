'use strict';

// A goal Build (MATH-88, 2026-10-26): a Build whose request starts with `/goal <condition>` keeps working until the
// condition is met, with Claude Code's own /goal. Step 1 is the Build as always, its request reading "The goal: …";
// step 2 resumes the same session with GOAL_MESSAGE first in the message (Claude Code takes /goal only there), and the
// goal's stop hook runs it round after round. Each round not yet met streams `Stop hook feedback: [<condition>]: <reason>`,
// read here into the card's "Not yet". Codex has no /goal and a quick task is too small for one: either runs as a normal
// Build, the card says why. Shared by main (manager.cjs, runner.cjs) and the cards (DocEditor.jsx, PostItTask.jsx).

const GOAL_RE = /^\s*\/goal\s+(\S[\s\S]*)$/;

/** The condition of a request that starts with `/goal <condition>`, as written; null for any other request. */
function parseGoal(text) {
  const match = typeof text === 'string' ? text.match(GOAL_RE) : null;
  return match ? match[1].trimEnd() : null;
}

/** The request as step 1 is given it: the leading `/goal <condition>` read as "The goal: <condition>". */
function goalRequest(condition) {
  return `The goal: ${condition}`;
}

/** Step 2's message, all of it: /goal must be the first thing in it. */
function goalMessage(condition) {
  return `/goal ${condition}. Also stop when you need to ask the person something (end your reply with a last line \`NEEDS YOU: <question>\`), when two rounds in a row make no progress, or after 20 rounds.`;
}

const FEEDBACK_RE = /Stop hook feedback\s*:\s*([\s\S]*)$/i;

/** The texts an event carries: a message's content (a string, or text parts), or the event's own text. */
function textsOf(event) {
  if (!event || typeof event !== 'object') return [];
  const out = [];
  const content = event.message && event.message.content;
  if (typeof content === 'string') out.push(content);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && typeof part.text === 'string') out.push(part.text);
      else if (part && typeof part.content === 'string') out.push(part.content);
    }
  }
  for (const key of ['text', 'content', 'result']) if (typeof event[key] === 'string') out.push(event[key]);
  return out;
}

/**
 * A round of the goal not yet met, from one raw event of the CLI: its reason, or null when the event is not one. Read
 * loosely: the condition in brackets is taken off when it is there (whatever brackets it holds itself), and any other
 * wrapping is kept as part of the reason. Never throws.
 */
function stopFeedback(event, condition = null) {
  try {
    for (const text of textsOf(event)) {
      const match = text.match(FEEDBACK_RE);
      if (!match) continue;
      let reason = match[1].trim();
      const known = condition ? `[${condition}]` : null;
      if (known && reason.startsWith(known)) reason = reason.slice(known.length);
      else if (reason.startsWith('[')) { const end = reason.indexOf(']:'); if (end !== -1) reason = reason.slice(end + 1); }
      reason = reason.replace(/^\s*:\s*/, '').trim();
      if (reason) return reason.slice(0, 600);
    }
  } catch { /* not one */ }
  return null;
}

const ENDED_RE = /\bno (?:further |more )?progress\b|\bwithout (?:any )?progress\b|\bround limit\b|\b(?:20|twenty) rounds\b|\blimit of (?:20|twenty)\b/i;

/**
 * How step 2 came out when it stopped without asking: 'ended' when its last message or the last round's reason says it
 * stopped for no progress or the round limit (or it counted 20 rounds), else 'met'.
 */
function goalOutcome(finalText, lastReason, rounds = 0) {
  if (rounds >= 20) return 'ended';
  return ENDED_RE.test(String(finalText || '')) || ENDED_RE.test(String(lastReason || '')) ? 'ended' : 'met';
}

const QUICK_NOTE = '/goal needs a full Build: add the post-it to a workspace.';
const CODEX_NOTE = '/goal only works with Claude Code; this ran as a normal Build.';

/**
 * What a card shows of a Build's goal: { condition, line } (line: "Not yet: …", "Goal met", "Goal stopped: …", or the
 * note of a Build the goal could not run in), or null for a Build without one.
 */
function goalShown(task) {
  const goal = task && task.goal;
  if (!goal || typeof goal.condition !== 'string') return null;
  let line = '';
  // A quick task's (or one moved into a workspace since: it never becomes a goal Build), else Codex's.
  if (!goal.supported) line = task.kind !== 'quick' && task.provider !== 'anthropic' ? CODEX_NOTE : QUICK_NOTE;
  else if (goal.state === 'met') line = 'Goal met';
  else if (goal.state === 'ended') line = `Goal stopped${goal.last ? `: ${goal.last}` : ''}`;
  else if (goal.state === 'running' && goal.last) line = `Not yet: ${goal.last}`;
  return { condition: goal.condition, line };
}

module.exports = { parseGoal, goalRequest, goalMessage, stopFeedback, goalOutcome, goalShown, QUICK_NOTE, CODEX_NOTE };
