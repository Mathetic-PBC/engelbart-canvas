'use strict';

// What @brainstorm is not shown (2026-09-30, round 3): the answers other agents wrote in the document. An @bart or
// @discover question is the person's words and stays; the reply lines under it (answer, folded answer, pending) are the
// agent's understanding, not theirs, and each run of them becomes one "[agent reply omitted]". @brainstorm's own threads
// stay whole: its cards and the person's answers to them are the exchange. The asking agent is named: only its own
// threads stay. An `@orient` line (2026-10-04; since 2026-10-05 an older name for @brainstorm) is @brainstorm's, its
// cards and recap with it. The grammar is the editor's (src/renderer/model/doc.js BART_RE, REPLY_RE, PENDING_RE),
// restated here because main cannot import that module; test/bart.test.cjs checks the two agree.
//
// The text is read after its mentions are placed (../context/expand-mentions.cjs): a mention on a question line puts a
// blank line, the <file> and a blank line between the question and its replies (2026-10-04, `@brainstorm @[Paper]`). That
// stays with the line it is under, so the replies after it are still that question's; under a reply left out, it goes too.

const BART_RE = /^@(bart|brainstorm|orient|discover)(?:\s(.*))?$/i;
const REPLY_RE = /^bart(\+?)> ?(.*)$/;
const PENDING_RE = /^bart~> ?([\w-]*)$/;
const OMITTED = '[agent reply omitted]';
// An agent a line names by another word: `@orient` is @brainstorm's.
const SAME_AS = { orient: 'brainstorm' };
const FILE_RE = /^<file\s/;
const CLOSED_RE = /\/>$/;
const FILE_END = '</file>';

/** The line where the <file> block opening at `n` ends: `n` itself for one closed on its line. */
function blockEnd(lines, n) {
  if (CLOSED_RE.test(lines[n])) return n;
  let depth = 0;
  for (let k = n; k < lines.length; k += 1) {
    if (FILE_RE.test(lines[k]) && !CLOSED_RE.test(lines[k])) depth += 1;
    else if (lines[k] === FILE_END && --depth === 0) return k;
  }
  return lines.length - 1;
}

/** The text with the replies under every other agent's lines taken out, one marker per run of them; `agent`'s own stay. */
function stripAgentReplies(text, agent = 'brainstorm') {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  const outer = []; // the owners of the lines whose mentioned notes are open around this one
  let owner = null; // the agent of the question the lines below answer, until a line that is neither
  let omitting = false;
  const ends = (n) => n >= 0 && (lines[n] === FILE_END || (FILE_RE.test(lines[n]) && CLOSED_RE.test(lines[n])));
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    // A mention placed under an agent's line: the blank lines around it, then the file itself.
    if (owner && line === '' && (FILE_RE.test(lines[n + 1] || '') || ends(n - 1))) { if (!omitting) out.push(line); continue; }
    if (FILE_RE.test(line)) {
      if (omitting) { n = blockEnd(lines, n); continue; }
      out.push(line);
      if (!CLOSED_RE.test(line)) { outer.push(owner); owner = null; } // a note, read as a document of its own
      continue;
    }
    if (line === FILE_END && outer.length) { owner = outer.pop(); omitting = false; out.push(line); continue; }
    const asked = line.match(BART_RE);
    if (asked) { const named = asked[1].toLowerCase(); owner = SAME_AS[named] || named; omitting = false; out.push(line); continue; }
    if (REPLY_RE.test(line) || PENDING_RE.test(line)) {
      if (owner && owner !== agent) {
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
