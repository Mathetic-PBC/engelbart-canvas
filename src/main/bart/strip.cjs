'use strict';

// What @brainstorm is not shown (2026-09-30, round 3): the answers other agents wrote in the document. An @bart or
// @discover question is the person's words and stays; the reply lines under it (answer, folded answer, pending) are the
// agent's understanding, not theirs, and each run of them becomes one "[agent reply omitted]". @brainstorm's own threads
// stay whole: its cards and the person's answers to them are the exchange. The grammar is the editor's
// (src/renderer/model/doc.js BART_RE, REPLY_RE, PENDING_RE), restated here because main cannot import that module;
// test/bart.test.cjs checks the two agree.

const BART_RE = /^@(bart|brainstorm|discover)(?:\s(.*))?$/i;
const REPLY_RE = /^bart(\+?)> ?(.*)$/;
const PENDING_RE = /^bart~> ?([\w-]*)$/;
const OMITTED = '[agent reply omitted]';

/** The text with the replies under @bart and @discover lines taken out, one marker per run of them. */
function stripAgentReplies(text) {
  const out = [];
  let owner = null; // the agent of the question the lines below answer, until a line that is neither
  let omitting = false;
  for (const line of String(text == null ? '' : text).split('\n')) {
    const asked = line.match(BART_RE);
    if (asked) { owner = asked[1].toLowerCase(); omitting = false; out.push(line); continue; }
    if (REPLY_RE.test(line) || PENDING_RE.test(line)) {
      if (owner === 'bart' || owner === 'discover') {
        if (!omitting) out.push(OMITTED);
        omitting = true;
        continue;
      }
      out.push(line);
      continue;
    }
    owner = null;
    omitting = false;
    out.push(line);
  }
  return out.join('\n');
}

module.exports = { OMITTED, BART_RE, REPLY_RE, PENDING_RE, stripAgentReplies };
