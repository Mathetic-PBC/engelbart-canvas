// Where an ask's line is now (2026-10-12, the Agent Viewer's click; src/main/agent-map/asks.cjs). The run log keeps the
// line as typed and its number when it was asked; the document has moved on since. The line is the one equal to what was
// typed, or to it with `@bart` written as the agent Bart handed it to (DocEditor handOff rewrites the line), the nearest
// to where it was. A Build with no line of its own is found by its card's line.

import { buildLine } from './doc.js';

// The token a line Bart routed is rewritten to: Chat's line is `@chat`, as is a build request with no spec above it.
const REWRITTEN = { chat: ['chat'], brainstorm: ['brainstorm'], discover: ['discover'], create: ['create'], build: ['chat'] };

/** The texts the line may read now. */
export function askLineTexts(text, routedTo) {
  const typed = String(text == null ? '' : text).trimEnd();
  if (!typed.trim()) return [];
  const out = [typed];
  for (const token of REWRITTEN[routedTo] || []) {
    const swapped = typed.replace(/^(\s*)@bart\b/, `$1@${token}`);
    if (!out.includes(swapped)) out.push(swapped);
  }
  return out;
}

/** The index of the ask's line in `lines` now, the nearest to `line`; -1 when it is gone. */
export function findAskLine(lines, { text, line = null, routedTo = null } = {}) {
  const wants = new Set(askLineTexts(text, routedTo));
  if (!wants.size || !Array.isArray(lines)) return -1;
  const near = Number.isInteger(line) ? line : 0;
  let best = -1;
  lines.forEach((held, i) => {
    if (wants.has(String(held).trimEnd()) && (best < 0 || Math.abs(i - near) < Math.abs(best - near))) best = i;
  });
  return best;
}

/** A Build's card line (`build> <id>`), or -1. */
export function findBuildLine(lines, buildId) {
  if (!buildId || !Array.isArray(lines)) return -1;
  return lines.findIndex((held) => String(held).trim() === buildLine(buildId));
}
