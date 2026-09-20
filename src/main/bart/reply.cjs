'use strict';

// How an answer sits in a document's text (2026-09-19). Every line says what it is, as todo
// lines do, so the editor stays line by line and a copied document reads as a conversation:
//   @bart --opus why does the sweep skip short notes?     the question
//   bart~> 6f1c…                                          pending: the run with that id is working
//   bart?> It skips them because …                        an answer not yet kept: Hide or Save
//   bart> It skips them because …                         a kept answer, read-only
// src/renderer/model/doc.js parses the same prefixes; test/bart.test.cjs holds the two together.

const PENDING_RE = /^bart~> ?([\w-]*)$/;
const DRAFT_PREFIX = 'bart?> ';
const MAX_REPLY_CHARS = 12000;

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} s`;

/** "Sol · high · 41 s · moved up from Sol medium": which model said this, kept with the answer. */
function attribution({ level, trail, ms }) {
  const parts = [level.name, level.effort, seconds(ms)];
  if (trail.length) parts.push(`moved up from ${trail.map((step) => `${step.name} ${step.effort}`).join(', then ')}`);
  return `*${parts.join(' · ')}*`;
}

/** The model's text as draft lines. Fences and quotes it was told not to use are flattened, not trusted. */
function draftLines(text, meta) {
  const body = String(text || '').replace(/\r/g, '').slice(0, MAX_REPLY_CHARS).split('\n')
    .map((line) => line.replace(/\s+$/, '').replace(/^```.*$/, '').replace(/^> ?/, ''))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = (body || 'No answer came back.').split('\n');
  if (meta) lines.push('', attribution(meta));
  return lines.map((line) => `${DRAFT_PREFIX}${line}`.trimEnd());
}

/** A run that failed still answers, so the question line can be unlocked with Hide. */
function failureLines(message) {
  return [`${DRAFT_PREFIX}**No answer.** ${String(message || 'The run failed.').replace(/\s+/g, ' ').slice(0, 300)}`];
}

module.exports = { PENDING_RE, DRAFT_PREFIX, attribution, draftLines, failureLines };
