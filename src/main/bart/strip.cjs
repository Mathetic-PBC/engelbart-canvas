'use strict';

// What @brainstorm is not shown (2026-09-30, round 3): the answers other agents wrote in the document. An @bart or
// @discover question is the person's words and stays; the reply lines under it (answer, folded answer, pending) are the
// agent's understanding, not theirs, and each run of them becomes one "[agent reply omitted]". @brainstorm's own threads
// stay whole: its cards and the person's answers to them are the exchange. The asking agent is named: only its own
// threads stay. An `@orient` line (2026-10-04; since 2026-10-05 an older name for @brainstorm) is @brainstorm's, its
// cards and recap with it. The grammar is the editor's (src/renderer/model/doc.js BART_RE, REPLY_RE, PENDING_RE),
// restated here because main cannot import that module; test/bart.test.cjs checks the two agree.
//
// A conversation's title (2026-10-12, `bart# …` or `bart#+ …` above the question that starts a thread; ./name-chat.cjs)
// is the editor's, named by a model: no agent is shown it, its own threads' included (stripTitles; ./context.cjs applies
// it to every agent's text). It keeps, in brackets before the title, the agent Bart handed an `@bart` line to
// (`bart# [discover …] …`, doc.js titleMeta): the `@bart` lines of that thread are that agent's.
//
// 2026-10-14: @brainstorm is shown the other agents' replies (show), each run of them as <reply agent="Chat">…</reply>
// in its place under the line that asked it, so it can talk about the reply the person is discussing. The reply is what
// the person sees in the document, without its closing line (model and seconds; the agent it names is the label): no
// run log, no Build's work (a `build> ` line holds only its id), no title. Nearest the line being asked first, up to
// REPLY_BUDGET characters; one farther away is a <reply … left_out="…"/> naming its size, which the workspace file still
// holds. The router (../bart/route.cjs) still gets one marker per run.
//
// The text is read after its mentions are placed (../context/expand-mentions.cjs): a mention on a question line puts a
// blank line, the <file> and a blank line between the question and its replies (2026-10-04, `@brainstorm @[Paper]`). That
// stays with the line it is under, so the replies after it are still that question's; under a reply left out, it goes too.

const BART_RE = /^@(bart|chat|brainstorm|orient|discover|create)(?:\s(.*))?$/i;
const REPLY_RE = /^bart(\+?)> ?(.*)$/;
const PENDING_RE = /^bart~> ?([\w-]*)$/;
const TITLE_RE = /^bart#(\+?) ?(.*)$/;
const TITLE_META_RE = /^\[(chat|brainstorm|discover|create)( build)?(?: [^\]]*)?\](?: |$)/;
const OMITTED = '[agent reply omitted]';
// An agent a line names by another word: `@orient` is @brainstorm's; `@chat` is the agent the app calls 'bart', and an
// `@bart` line is the router's (2026-10-12, src/renderer/model/doc.js tokenOf).
const SAME_AS = { orient: 'brainstorm', chat: 'bart', bart: 'router' };
const FILE_RE = /^<file\s/;
const CLOSED_RE = /\/>$/;
const FILE_END = '</file>';
const REPLY_BUDGET = 40000;
// Who wrote a run of replies, by the agent its question line names; an `@bart` line Bart did not hand on is from before
// 2026-10-12, when that was the agent now called Chat.
const AGENT_LABELS = { bart: 'Chat', router: 'Chat', brainstorm: 'Brainstorm', discover: 'Discover', create: 'Create' };
// An answer's closing line (./reply.cjs attribution): "*Chat · Sonnet · high · 12 s*", or before 2026-10-12 "*Sonnet · high · 12 s*".
const FOOT_RE = /^\*(?:(Chat|Brainstorm|Discover|Create|Build)(?: · [^*]*)?|[^*]* · \d+ s(?: · [^*]*)?)\*$/;
const FOOT_LABELS = { Chat: 'Chat', Build: 'Chat', Brainstorm: 'Brainstorm', Discover: 'Discover', Create: 'Create' };

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

/** A run of another agent's replies as `show` gives it: what it says, labelled with who said it. */
function replyText(run) {
  const said = run.lines.slice();
  const trim = () => { while (said.length && !said[said.length - 1].trim()) said.pop(); while (said.length && !said[0].trim()) said.shift(); };
  trim();
  let who = AGENT_LABELS[run.who] || 'Another agent';
  const foot = said.length ? said[said.length - 1].trim().match(FOOT_RE) : null;
  if (foot) { if (foot[1]) who = FOOT_LABELS[foot[1]]; said.pop(); trim(); }
  return { who, body: said.join('\n'), pending: run.pending };
}

/**
 * The text with the replies under every other agent's lines taken out, one marker per run of them; `agent`'s own stay.
 * With `show`, each run is kept instead as a <reply agent="…"> block, nearest the pending line `askId` first, up to
 * `budget` characters; the rest are left out with their size.
 */
function stripAgentReplies(text, agent = 'brainstorm', { show = false, askId = null, budget = REPLY_BUDGET } = {}) {
  const lines = String(text == null ? '' : text).split('\n');
  const out = [];
  let run = null; // with `show`: the run of another agent's replies being read
  const outer = []; // the owners of the lines whose mentioned notes are open around this one
  let owner = null; // the agent of the question the lines below answer, until a line that is neither
  let omitting = false;
  let titled = null; // under a title line: the agent its brackets name, or '' (none)
  let routed = null; // the agent Bart handed this thread's `@bart` lines to
  const ends = (n) => n >= 0 && (lines[n] === FILE_END || (FILE_RE.test(lines[n]) && CLOSED_RE.test(lines[n])));
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    const title = line.match(TITLE_RE);
    if (title) { const meta = title[2].match(TITLE_META_RE); titled = meta ? SAME_AS[meta[1]] || meta[1] : ''; continue; }
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
    if (asked) {
      if (titled !== null) routed = titled || null; else if (!owner) routed = null;
      titled = null;
      const named = asked[1].toLowerCase(), who = SAME_AS[named] || named;
      owner = who === 'router' && routed ? routed : who; omitting = false; out.push(line); continue;
    }
    if (REPLY_RE.test(line) || PENDING_RE.test(line)) {
      if (owner && owner !== agent) {
        if (show) {
          if (!omitting) { run = { who: owner, at: n, lines: [], pending: false }; out.push(run); }
          const reply = line.match(REPLY_RE);
          if (reply) run.lines.push(reply[2]); else run.pending = true;
        } else if (!omitting) out.push(OMITTED);
        omitting = true;
        continue;
      }
      out.push(line);
      continue;
    }
    owner = null;
    titled = null;
    omitting = false;
    out.push(line);
  }
  if (!show) return out.join('\n');
  const runs = out.filter((part) => typeof part !== 'string').map((part) => ({ part, ...replyText(part) }));
  const here = askId ? lines.findIndex((line) => { const m = line.match(PENDING_RE); return m && m[1] === askId; }) : -1;
  const mark = here < 0 ? lines.length : here;
  let spent = 0, full = true;
  for (const r of [...runs].sort((a, b) => Math.abs(a.part.at - mark) - Math.abs(b.part.at - mark))) {
    full = full && spent + r.body.length <= budget;
    if (full) spent += r.body.length;
    r.full = full;
  }
  const shown = new Map(runs.map((r) => [r.part,
    !r.body ? `<reply agent="${r.who}"${r.pending ? ' status="still being written"' : ''}/>`
      : r.full ? `<reply agent="${r.who}">\n${r.body}\n</reply>`
        : `<reply agent="${r.who}" left_out="${r.body.length} characters, farther from this line"/>`]));
  return out.map((part) => (typeof part === 'string' ? part : shown.get(part))).join('\n');
}

// A Brainstorm conversation's topic (2026-10-14): its title line's text, the label on the chip beside its first
// `@brainstorm` (DocEditor topicChipHtml). What a bare line's conversation was once called, "New conversation"
// (./name-chat.cjs UNNAMED), is no topic.
const UNSET_TOPIC = 'New conversation';
const BUILD_LINE_RE = /^build> [0-9a-f]{10}$/;

/**
 * The topic of the conversation whose pending line is `bart~> <askId>` → its title's text, or null: none asked, no title,
 * a title that is not a Brainstorm conversation's, or one still unset. Read upward from the pending line through the
 * conversation's questions, replies and the mentions placed under them, to the title line right above its first question.
 */
function topicOf(text, askId) {
  if (!askId) return null;
  const lines = String(text == null ? '' : text).split('\n');
  let n = lines.findIndex((line) => { const m = line.match(PENDING_RE); return !!m && m[1] === askId; });
  if (n < 0) return null;
  const closedFile = (line) => FILE_RE.test(line || '') && CLOSED_RE.test(line);
  for (n -= 1; n >= 0; n -= 1) {
    const line = lines[n], title = line.match(TITLE_RE);
    if (title) {
      const meta = title[2].match(TITLE_META_RE), said = (meta ? title[2].slice(meta[0].length) : title[2]).trim();
      return meta && meta[1] === 'brainstorm' && said && said !== UNSET_TOPIC ? said : null;
    }
    if (BART_RE.test(line) || REPLY_RE.test(line) || PENDING_RE.test(line) || BUILD_LINE_RE.test(line) || closedFile(line)) continue;
    if (line === FILE_END) { // a note placed under a line: up to where it opens
      let depth = 0;
      for (; n >= 0; n -= 1) {
        if (lines[n] === FILE_END) depth += 1; else if (FILE_RE.test(lines[n]) && !CLOSED_RE.test(lines[n]) && --depth === 0) break;
      }
      continue;
    }
    if (line === '' && (lines[n - 1] === FILE_END || closedFile(lines[n - 1]) || FILE_RE.test(lines[n + 1] || ''))) continue;
    return null;
  }
  return null;
}

/** The text without its conversation titles. */
function stripTitles(text) {
  return String(text == null ? '' : text).split('\n').filter((line) => !TITLE_RE.test(line)).join('\n');
}

module.exports = { OMITTED, REPLY_BUDGET, UNSET_TOPIC, topicOf, BART_RE, REPLY_RE, PENDING_RE, TITLE_RE, stripAgentReplies, stripTitles };
