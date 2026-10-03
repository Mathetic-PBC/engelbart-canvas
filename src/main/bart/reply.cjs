'use strict';

// How an answer sits in a document's text (2026-09-19). Every line says what it is, as todo
// lines do, so the editor stays line by line and a copied document reads as a conversation:
//   @bart --opus why does the sweep skip short notes?     the question
//   bart~> 6f1c…                                          pending: the run with that id is working
//   bart> It skips them because …                         the answer, kept as it arrives (2026-09-21: no Save;
//                                                         the card's Delete takes the question and the answer out)
//   bart+> It skips them because …                        the same line while the answer is folded (Collapse)
//   @bart and the long ones?                              a question right under an answer continues that exchange
// `bart?> ` was the unsaved draft of the 09-19 build; the editor reads it as an answer.
// src/renderer/model/doc.js parses the same prefixes; test/bart.test.cjs holds the two together.

const PENDING_RE = /^bart~> ?([\w-]*)$/;
const REPLY_PREFIX = 'bart> ';
const MAX_REPLY_CHARS = 12000;

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} s`;

/**
 * "Sol · high · 41 s · moved up from Sol medium": which model said this, kept with the answer. "8 s" alone without `model`
 * (@brainstorm, 2026-10-02: its model is fixed and not shown).
 */
function attribution({ level, trail, ms }, { model = true } = {}) {
  if (!model) return `*${seconds(ms)}*`;
  const parts = [level.name, level.effort, seconds(ms)];
  if (trail.length) parts.push(`moved up from ${trail.map((step) => `${step.name} ${step.effort}`).join(', then ')}`);
  return `*${parts.join(' · ')}*`;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * The model's text as the lines of an answer. A fenced code block is kept as written (2026-09-22: the editor draws it),
 * and one the text leaves open — cut off, or still arriving — is closed, so it reads as code rather than as a stray
 * fence. Outside code, the block quotes it was told not to use are flattened and a run of blank lines is one.
 */
function bodyLines(text) {
  const lines = String(text || '').replace(/\r/g, '').slice(0, MAX_REPLY_CHARS).split('\n').map((line) => line.replace(/\s+$/, ''));
  const out = [];
  let fence = null;
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = line.match(CLOSE_RE);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_RE);
    if (open) { fence = open[1]; out.push(line); continue; }
    const flat = line.replace(/^> ?/, '');
    if (flat || out[out.length - 1] !== '') out.push(flat);
  }
  if (fence) { while (out[out.length - 1] === '') out.pop(); out.push(fence); }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  if (out.length && !FENCE_RE.test(out[0])) out[0] = out[0].trimStart();
  return out.length ? out : ['No answer came back.'];
}

/** The answer as lines for the document. `options` go to its foot (attribution). */
function replyLines(text, meta, options) {
  const lines = bodyLines(text);
  if (meta) lines.push('', attribution(meta, options));
  return lines.map((line) => `${REPLY_PREFIX}${line}`.trimEnd());
}

/** The answer as the document will hold it and as a later follow-up will send it back: the body alone. */
function answerText(text) {
  return bodyLines(text).join('\n').trim();
}

/** A run that failed still answers, so the card has a foot to regenerate or delete it from. */
function failureLines(message) {
  return [`${REPLY_PREFIX}**No answer.** ${String(message || 'The run failed.').replace(/\s+/g, ' ').slice(0, 300)}`];
}

module.exports = { PENDING_RE, REPLY_PREFIX, attribution, bodyLines, replyLines, answerText, failureLines };
