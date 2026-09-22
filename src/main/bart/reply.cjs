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

/** "Sol · high · 41 s · moved up from Sol medium": which model said this, kept with the answer. */
function attribution({ level, trail, ms }) {
  const parts = [level.name, level.effort, seconds(ms)];
  if (trail.length) parts.push(`moved up from ${trail.map((step) => `${step.name} ${step.effort}`).join(', then ')}`);
  return `*${parts.join(' · ')}*`;
}

/** The model's text as the lines of an answer. Fences and quotes it was told not to use are flattened, not trusted. */
function bodyLines(text) {
  const body = String(text || '').replace(/\r/g, '').slice(0, MAX_REPLY_CHARS).split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/^```.*$/, '').replace(/^> ?/, ''))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return (body || 'No answer came back.').split('\n');
}

/** The answer as lines for the document. */
function replyLines(text, meta) {
  const lines = bodyLines(text);
  if (meta) lines.push('', attribution(meta));
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
