// Pure document model for the Obsidian-style editor.
// Ported verbatim from design/goal-canvas/Goal Canvas.dc.html (lines 403–404, 439–456, 692–730, 801–812).
// One markdown string per document; the caret's line shows its source, every other line renders.

// A checkbox line: `- [ ] text` (2026-09-20), typed as `- []` or `- [ ]`. `@Task` is gone (2026-09-29): stickies
// took its place, and a checkbox is a checklist, nothing more. A bare `- text` is a bullet: lists are their own kind of
// line, nested two spaces at a time. `1. text` and `1) text` (2026-10-05) are the same kind of row, numbered: the number
// is kept as typed and Enter writes the next one.
export const TODO_RE = /^( *)- \[([ xX]?)\](?: (.*))?$/;
export const LIST_RE = /^( *)(?:[-*]|(\d{1,9})([.)])) (.*)$/;
export const HEAD_RE = /^(#{1,3}) (.*)$/;
export const IMG_RE = /^!\[([^\]]*)\]\((img:[\w-]+|https?:[^)\s]+|data:image[^)\s]+)\)$/;
// `@Bart` is what the @ menu writes (2026-09-22); `@bart` is what is typed. `@brainstorm` (2026-09-30) is the same kind of
// line, asked of another agent: its answers are cards (src/main/bart/card.cjs) and it may be asked with nothing after it.
// `@discover` (2026-09-30) too: a card or two to refine the problem, then a reading guide, which is an answer like @bart's.
// `@orient` (2026-10-04) was an agent of its own; since 2026-10-05 it is an older name for @brainstorm: the line is
// still read and drawn as written, and asked as @brainstorm (agentOf).
export const BART_RE = /^@(bart|brainstorm|orient|discover)(?:\s(.*))?$/i;
// An answer under an @bart line, one prefix per line (src/main/bart/reply.cjs writes them): pending while the run with
// that id works, then a reply. A reply is kept as it arrives (2026-09-21: no Save; Delete is the way out) and its text
// can be edited; `bart+> ` is the same line folded away by Collapse, so a fold is in the file and survives everything
// else. `bart?> ` was the unsaved draft of the 09-19 build and reads as a reply.
export const PENDING_RE = /^bart~> ?([\w-]*)$/;
// A Build (2026-09-25): the line holds its id alone, and the editor draws the Build's card from its record (main/build):
// what it is doing, what it said, the reply field, Review / Accept / Discard. Nothing the agent says is in the document.
export const BUILD_RE = /^build> ([0-9a-f]{10})$/;
export const buildLine = (id) => `build> ${id}`;
/**
 * `text` with ask `askId`'s pending line replaced by `lines`: its answer, or the line of the Build it started (`@bart
 * --build`, 2026-10-02). null when the pending line is gone (undone away): there is nowhere to put them.
 */
export function placeAnswer(text, askId, lines) {
  const all = String(text).split('\n'), at = all.indexOf(`bart~> ${askId}`);
  if (at < 0) return null;
  all.splice(at, 1, ...lines);
  return all.join('\n');
}
export const DRAFT_RE = /^bart\?> ?(.*)$/;
export const REPLY_RE = /^bart(\+?)> ?(.*)$/;
// The closing line of an answer: which model said it and how long it took. It is drawn as the card's foot.
export const ATTRIBUTION_RE = /^\*[^*]+\*$/;
export const QUOTE_RE = /^> ?(.*)$/;
export const ATTACH_RE = /^!\[([^\]\n]*)\]\(img:([\w-]+)\)$/;
export const INLINE = /(!\[[^\]\n]*\]\(img:[\w-]+\)|@(?:[Bb]art|[Bb]rainstorm|[Oo]rient|[Dd]iscover)(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]\(ws:[\w-]+\)|@\[[^\]\n]+\]\(lib:[\w-]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`])/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
// Another workspace of the project, mentioned (2026-09-25): `@[Name](ws:<id>)`. The id finds it after a rename (workspaces
// are born "Untitled Workspace n" and named later); the line shows the @, the workspace icon right after it, then the name
// (2026-09-29), so it never reads as a note of the same name. Before the plain mention in INLINE, so the id stays part of the token.
export const WS_MENTION_RE = /^@\[([^\]\n]+)\]\(ws:([\w-]+)\)$/;
/** The token that mentions a workspace. */
export const wsMention = (name, id) => `@[${String(name || '').replace(/[[\]\n]/g, '').trim() || 'Workspace'}](ws:${id})`;
// A library item mentioned by id (MATH-21, 2026-10-05): `@[Name](lib:<id>)`, which a PDF margin note's @ menu writes. The
// name is the item's as it was picked; the id finds the item after a rename, or tells that it has left the library.
// Before the plain mention in INLINE too, for the same reason.
export const LIB_MENTION_RE = /^@\[([^\]\n]+)\]\(lib:([\w-]+)\)$/;
/** The token that mentions a library item. */
export const libMention = (name, id) => `@[${String(name || '').replace(/[[\]\n]/g, '').trim() || 'Untitled'}](lib:${id})`;
// What the @ menu is looking for: an `@` and up to 30 characters after it, no space, @ or bracket among them, ending at the
// caret. A document line and a follow-up field (2026-10-02) read it the same way.
const MENTION_QUERY_RE = /@([^\s@[\]]{0,30})$/;
/** The @ menu's query in `text` before `caret` → { query, start } (`start` where its @ stands), or null when there is none. */
export function mentionAt(text, caret) {
  const m = String(text ?? '').slice(0, caret).match(MENTION_QUERY_RE);
  return m ? { query: m[1], start: caret - m[0].length } : null;
}
// ui/Icons.jsx WS, as markup for the rendered line: 0.8em square, on the text's baseline.
const WS_ICON = '<svg viewBox="0 0 16 16" width="0.8em" height="0.8em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="6.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="6.5" height="6.5" rx="1"/><rect x="10" y="8" width="4.5" height="4.5" rx="1"/></svg>';
// A bare address, typed, pasted or written by @bart, is a link as it stands (closing punctuation is not part of it).
const URL_RE = /^https?:\/\/\S+$/;

/** Which agent a question line asks: 'bart', 'brainstorm' or 'discover'. An `@orient` line asks @brainstorm (2026-10-05). */
export const agentOf = (p) => (p && p.agent === 'orient' ? 'brainstorm' : p && (p.agent === 'brainstorm' || p.agent === 'discover') ? p.agent : 'bart');
/** The token that starts a question line, as INLINE splits it out. */
export const AGENT_TOKEN = /^@(bart|brainstorm|orient|discover)$/i;
/**
 * Text pasted into a question line, as one line (2026-10-02): a question is one line of the document, and a paste split
 * over several put all but its first line under the question, where it was never asked. Each line break, with the
 * whitespace and blank lines around it, becomes one space; the ends are trimmed. Spacing inside a line is kept.
 */
export const flattenPaste = (text) => String(text ?? '').replace(/\s*[\r\n]\s*/g, ' ').trim();

const depthOf = (indent) => Math.min(8, Math.floor(indent.length / 2));

export const parseLine = (l) => {
  let m;
  if ((m = l.match(BART_RE))) { const agent = m[1].toLowerCase(); return agent === 'bart' ? { type: 'bart', text: m[2] || '' } : { type: 'bart', text: m[2] || '', agent }; }
  if ((m = l.match(BUILD_RE))) return { type: 'build', id: m[1], text: '' };
  if ((m = l.match(PENDING_RE))) return { type: 'pending', id: m[1], text: '' };
  if ((m = l.match(DRAFT_RE))) return { type: 'reply', text: m[1], folded: false };
  if ((m = l.match(REPLY_RE))) return { type: 'reply', text: m[2], folded: m[1] === '+' };
  if ((m = l.match(QUOTE_RE))) return { type: 'quote', text: m[1] };
  if ((m = l.match(IMG_RE))) return { type: 'img', text: m[1], src: m[2] };
  if ((m = l.match(TODO_RE))) return { type: 'todo', depth: depthOf(m[1]), done: !!m[2] && m[2] !== ' ', text: m[3] || '' };
  if ((m = l.match(LIST_RE))) return m[2] ? { type: 'list', depth: depthOf(m[1]), text: m[4], num: Number(m[2]), delim: m[3] } : { type: 'list', depth: depthOf(m[1]), text: m[4] };
  if ((m = l.match(HEAD_RE))) return { type: 'h', level: m[1].length, text: m[2] };
  return { type: 'p', text: l };
};

// A fenced code block (2026-09-22): a fence of three or more backticks (or tildes) with an optional language, the code,
// then a fence of the same character at least as long. Only a closed fence makes a block, so the rest of the document
// does not turn to code under a fence still being typed. Inside a block every line is code, whatever it looks like:
// `# x` is not a heading, `- x` not a bullet, `@bart` not a question. That needs the lines around it, so the document is
// read with parseLines(); parseLine() alone reads one line as if no block held it.
export const FENCE_RE = /^( {0,3})(`{3,}|~{3,})([^`]*)$/;
const CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** The closed code blocks of a document, in order → [{ open, close, lang, fence }] (line indexes; fence as typed, indent included). */
export function codeBlocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = String(lines[i]).match(FENCE_RE); if (!m) continue;
    const mark = m[2];
    for (let j = i + 1; j < lines.length; j++) {
      const c = String(lines[j]).match(CLOSE_RE);
      if (c && c[1][0] === mark[0] && c[1].length >= mark.length) { out.push({ open: i, close: j, lang: m[3].trim().split(/\s+/)[0] || '', fence: m[1] + mark }); i = j; break; }
    }
  }
  return out;
}

/**
 * Every line of a document, read in place: parseLine's reading, except that the lines of a code block are `fence` and
 * `code`. An @bart answer holds code blocks of its own (2026-09-22), found in each run of answer lines by the same rule;
 * those lines stay `reply` (they belong to the card: fold, delete, copy and follow-ups treat them as answer) and carry
 * `code`: 'open' | 'body' | 'close'. A block's `open`/`close` are always indexes into the document.
 */
export function parseLines(lines) {
  const ps = lines.map((l) => parseLine(String(l)));
  for (const block of codeBlocks(lines)) {
    ps[block.open] = { type: 'fence', open: true, text: lines[block.open], lang: block.lang, block };
    for (let i = block.open + 1; i < block.close; i++) ps[i] = { type: 'code', text: lines[i], lang: block.lang, block };
    ps[block.close] = { type: 'fence', open: false, text: lines[block.close], lang: block.lang, block };
  }
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].type !== 'reply') continue;
    let j = i; while (j + 1 < ps.length && ps[j + 1].type === 'reply') j++;
    for (const found of codeBlocks(ps.slice(i, j + 1).map((p) => p.text))) {
      const block = { ...found, open: i + found.open, close: i + found.close };
      for (let k = block.open; k <= block.close; k++) ps[k] = { ...ps[k], code: k === block.open ? 'open' : k === block.close ? 'close' : 'body', open: k === block.open, lang: block.lang, block };
    }
    i = j;
  }
  return ps;
}

/** A line that opens or closes a code block, in the document or in an answer. */
export const isFence = (p) => !!p && (p.type === 'fence' || p.code === 'open' || p.code === 'close');
/** A line of code, in the document or in an answer: what it shows is exactly its text. */
export const isCode = (p) => !!p && (p.type === 'code' || p.code === 'body');

/** What an opening fence shows while the caret is elsewhere: what follows its backticks (the language), or nothing. */
export const fenceShown = (p) => (p.open ? p.text.slice(p.block.fence.length).trimStart() : '');

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Code is coloured only where it can be read one line at a time without guessing: JSON (keys ink, strings blue, numbers
// and literals grey, punctuation faint), in the app's one ink, grays and one blue. Other languages show as they are typed.
const JSON_LANGS = new Set(['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson']);
const JSON_TOKEN = /("(?:[^"\\]|\\.)*"?)([ \t]*:)?|((?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.]))|\b(true|false|null)\b|([{}[\],:])|(\/\/.*$)/g;
const LOOK = { key: 'color:#171717', str: 'color:#0761d1', num: 'color:#4d4d4d', punct: 'color:#8f8f8f', note: 'color:#8f8f8f;font-style:italic' };
const tint = (look, s) => `<span style="${LOOK[look]}">${esc(s)}</span>`;

/** One line of code as HTML: its text exactly (only spans added), coloured when the language is one read here. */
export function highlight(text, lang) {
  if (!JSON_LANGS.has(String(lang || '').toLowerCase())) return esc(text);
  let out = '', at = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    out += esc(text.slice(at, m.index)); at = m.index + m[0].length;
    if (m[1] != null && m[2] != null) out += tint('key', m[1]) + esc(m[2].slice(0, -1)) + tint('punct', ':');
    else if (m[1] != null) out += tint('str', m[1]);
    else if (m[3] != null || m[4] != null) out += tint('num', m[0]);
    else if (m[5] != null) out += tint('punct', m[0]);
    else out += tint('note', m[0]);
  }
  return out + esc(text.slice(at));
}

/** Lines that stand under an @bart question: what it is working on, what it said, and the legacy `> ` replies of the prototype. */
export const isAnswer = (type) => type === 'quote' || type === 'reply' || type === 'pending';

export const todoLine = (depth, done, text) => `${'  '.repeat(depth)}- [${done ? 'x' : ' '}] ${text}`;
/** A bullet, or with `num` (and `delim`, '.' or ')') a numbered row. */
export const listLine = (depth, text, num, delim = '.') => `${'  '.repeat(depth)}${num != null ? `${num}${delim}` : '-'} ${text}`;
/** What a list row draws in front of its text: `•`, or its number as typed (`1.`, `2)`). */
export const listMark = (p) => (p.num != null ? `${p.num}${p.delim || '.'}` : '\u2022');
// No trimming: a space typed at the end of an answer line has to survive the round trip, or no second word can follow.
export const replyLine = (text, folded) => `bart${folded ? '+' : ''}> ${text}`;

/** Rows of a list: a checkbox or a bullet. They nest, Enter continues them, an empty one steps out. */
export const isMarked = (type) => type === 'todo' || type === 'list';
/** Lines whose prefix is drawn, not typed: the caret's line shows `p.text`, never the `- `, `- [ ] ` or `bart> ` in front of it. */
export const isDrawn = (type) => isMarked(type) || type === 'reply';
/** The text the caret moves through on a line: a drawn line's own text, any other line's whole source. */
export const lineText = (p, line) => (isDrawn(p.type) ? p.text : line);
/** That line again with different text, keeping its kind. */
export const sameLine = (p, text) => (p.type === 'todo' ? todoLine(p.depth, p.done, text) : p.type === 'list' ? listLine(p.depth, text, p.num, p.delim) : p.type === 'reply' ? replyLine(text, p.folded) : text);
/** How a line the person just typed is stored: `- []` and `* x` become the line they make (`1) x` stays as typed). */
export const canonicalLine = (l) => { const p = parseLine(l); return isMarked(p.type) ? sameLine(p, p.text) : l; };

/**
 * A marker typed into a row that already draws one (an empty bullet or task): the row takes that marker instead of
 * holding it as literal text — `- [ ] ` and `- []` make it a checkbox, `- ` makes it a bullet.
 * Returns the row's new source and how many characters the marker ate, or null when nothing was typed but text.
 */
export function retypedRow(p, txt) {
  const task = txt.match(/^- \[([ xX]?)\](?: |$)/);
  if (task) return { line: todoLine(p.depth, (task[1] || ' ') !== ' ', txt.slice(task[0].length)), ate: task[0].length };
  const bullet = txt.match(/^[-*] /);
  if (bullet) return { line: listLine(p.depth, txt.slice(bullet[0].length)), ate: bullet[0].length };
  const numbered = txt.match(/^(\d{1,9})([.)]) /);
  if (numbered) return { line: listLine(p.depth, txt.slice(numbered[0].length), Number(numbered[1]), numbered[2]), ate: numbered[0].length };
  return null;
}

/** What an inline token shows when rendered, and how many source characters precede the shown text. */
export function tokShown(tok) {
  const attachment = tok.match(ATTACH_RE); if (attachment) return { shown: `[${attachment[1] || 'Attachment'}]`, pre: 1 };
  // Bold may hold a link or a mention (an @discover guide's titles, 2026-09-30): what shows is what they show.
  if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) return { shown: tok.slice(2, -2).split(INLINE).filter(Boolean).map((inner) => tokShown(inner).shown).join(''), pre: 2 };
  if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  const ws = tok.match(WS_MENTION_RE); if (ws) return { shown: '@' + ws[1], pre: 1 }; // the icon after the @ is not text
  const lib = tok.match(LIB_MENTION_RE); if (lib) return { shown: '@' + lib[1], pre: 1 };
  if (tok.startsWith('@[')) { const nm = tok.slice(2, -1); return { shown: '@' + (nm.startsWith('bart') ? 'bart' : nm), pre: 1 }; }
  const m = tok.match(LINK_RE); if (m) return { shown: m[1], pre: 1 };
  return { shown: tok, pre: 0 };
}

/** The source tokens of a line as edited on the active line (prefixes for headings/quotes are their own token). */
export function tokensOf(p, line) {
  const src = p.type === 'h' || p.type === 'quote' || isDrawn(p.type) ? p.text : line;
  const toks = src.split(INLINE).filter(Boolean);
  if (p.type === 'h') return [line.slice(0, p.level + 1), ...toks];
  if (p.type === 'quote') return [line.slice(0, line.length - p.text.length), ...toks];
  return toks;
}

/**
 * Map a display offset of a *rendered* (non-active) line to its raw source offset.
 * `line` is optional: when given, chat/paragraph/image lines map against the whole line and quote prefixes
 * use their real length; without it the design's fixed bases apply (heading level+1, quote 2, else 0).
 */
export function rawOffset(p, fOff, line) {
  let text = p.text;
  let base = p.type === 'h' ? p.level + 1 : p.type === 'quote' ? 2 : 0;
  if (typeof line === 'string') {
    if (p.type === 'quote') base = line.length - p.text.length;
    else if (p.type !== 'h' && !isDrawn(p.type)) { text = line; base = 0; }
  }
  let accF = 0, accR = 0;
  for (const tok of text.split(INLINE)) {
    if (!tok) continue;
    const { shown, pre } = tokShown(tok);
    if (fOff <= accF + shown.length) { const d = fOff - accF; return base + accR + (pre ? (d === 0 ? 0 : Math.min(tok.length, pre + d)) : d); }
    accF += shown.length; accR += tok.length;
  }
  return base + text.length;
}

/**
 * A display offset in a rendered answer line → the offset in its text. An answer line holds markdown of its own: a
 * heading shows without its `## `, a bullet shows a `•` (one character of the display) where its `- ` stands, a
 * numbered row its number (`1.`).
 */
export function replyRawOffset(p, fOff) {
  const q = parseLine(p.text);
  if (q.type !== 'h' && !isMarked(q.type)) return rawOffset({ type: 'p', text: p.text }, fOff, p.text);
  const lead = p.text.length - q.text.length;
  return lead + rawOffset({ type: 'p', text: q.text }, Math.max(0, fOff - (q.type === 'h' ? 0 : q.type === 'list' ? listMark(q).length : 1)), q.text);
}

/**
 * Whether question line `p` may follow an answer in the thread question line `first` opened: it asks the same agent
 * (2026-10-02). An `@orient` line (2026-10-05) starts a thread of its own, as it did when it was an agent of its own,
 * unless that thread is an @orient one; the @brainstorm lines answering an @orient thread's cards go on with it.
 */
const followsIn = (p, first) => agentOf(p) === agentOf(first) && (p.agent !== 'orient' || first.agent === 'orient');

/**
 * The @bart exchanges of a document, by line index. A thread is a run of lines with nothing between them: a question,
 * what stands under it (a pending line, or the answer), then any question asked right after that answer — a follow-up,
 * which reads as one card. A follow-up asks the agent the thread's first question asked; a line for another agent
 * starts a thread of its own, with its own card and reply field (2026-10-02; followsIn). → [{ from, to, turns }], each turn
 * { q, from, to, answered, pending, foot, folded } where `from..to` are the lines under the question (to === q when there
 * are none), `pending` is the id of a run still working, `foot` the closing line that says which model answered (-1
 * without one).
 */
export function threads(lines, ps = parseLines(lines)) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (ps[i].type !== 'bart') continue;
    const thread = { from: i, to: i, turns: [] };
    for (;;) {
      const turn = { q: i, from: i + 1, to: i, answered: false, pending: null, foot: -1, folded: false };
      while (i + 1 < lines.length) {
        const p = ps[i + 1];
        if (p.type !== 'pending' && p.type !== 'reply') break;
        i += 1; turn.to = i;
        if (p.type === 'pending') turn.pending = p.id;
        else turn.folded = p.folded;
      }
      turn.answered = turn.to > turn.q;
      if (turn.answered && !turn.pending) { const last = ps[turn.to]; if (last.type === 'reply' && ATTRIBUTION_RE.test(last.text)) turn.foot = turn.to; }
      thread.turns.push(turn); thread.to = turn.to;
      if (!turn.answered || i + 1 >= lines.length || ps[i + 1].type !== 'bart' || !followsIn(ps[i + 1], ps[thread.from])) break;
      i += 1;
    }
    out.push(thread);
  }
  return out;
}

/** One turn as text: the question as typed after `@bart`, and the answer without its prefixes or its closing line. */
export function turnText(lines, turn) {
  const body = [];
  for (let i = turn.from; i <= turn.to; i++) { const p = parseLine(lines[i]); if (p.type === 'reply' && i !== turn.foot) body.push(p.text); }
  return { question: parseLine(lines[turn.q]).text.trim(), answer: body.join('\n').trim() };
}

// A library mention's chip: blue and clickable as a mention is, `data-lib` holding the id. `libName(id)` (optional) is the
// item's name now, shown in place of the one saved; null when the library no longer holds it, which leaves the saved name
// in grey with nothing to click.
function libHtml(name, id, libName) {
  const now = typeof libName === 'function' ? libName(id) : undefined;
  if (now === null) return `<span title="No longer in the library" style="color:#8f8f8f">@${esc(name)}</span>`;
  const shown = typeof now === 'string' && now ? now : name;
  return `<span data-mention="${esc(shown)}" data-lib="${esc(id)}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9">@${esc(shown)}</span>`;
}

/**
 * Rendered HTML for inline markup (bold, code, italic, @bart, @brainstorm and @discover, an older line's @orient,
 * @[mention], [link](url), bare urls). `opts.libName(id)`: a library mention's name now, or null when it is gone (libHtml).
 */
export function inlineHtml(text, opts) {
  return text.split(INLINE).map((p) => {
    if (!p) return '';
    // A pasted image inside a todo or a chat line reads as [Attachment n]; on a line of its own it renders as the image.
    const attachment = p.match(ATTACH_RE);
    if (attachment) return `<span data-attachment="${esc(attachment[2])}" style="padding:1px 6px;border-radius:4px;background:#f2f2f2;border:1px solid #eaeaea;font:.86em/1.6 var(--font-mono);color:#4d4d4d;white-space:nowrap">[${esc(attachment[1] || 'Attachment')}]</span>`;
    // Bold may hold a link or a mention: `**[Title](url)**`, `**@[Name]**` (an @discover guide's titles, 2026-09-30).
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return `<strong style="font-weight:600">${inlineHtml(p.slice(2, -2), opts)}</strong>`;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return `<code style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)">${esc(p.slice(1, -1))}</code>`;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return `<em>${esc(p.slice(1, -1))}</em>`;
    if (AGENT_TOKEN.test(p)) return `<span style="color:#0070f3;font-weight:500">${esc(p)}</span>`;
    const ws = p.match(WS_MENTION_RE);
    if (ws) return `<span data-mention="${esc(ws[1])}" data-ws="${esc(ws[2])}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9;white-space:nowrap">@${WS_ICON}${esc(ws[1])}</span>`;
    const lib = p.match(LIB_MENTION_RE);
    if (lib) return libHtml(lib[1], lib[2], opts && opts.libName);
    if (p.startsWith('@[')) { const name = p.slice(2, -1), shown = name.startsWith('bart') ? 'bart' : name; return `<span data-mention="${esc(name)}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9">@${esc(shown)}</span>`; }
    const m = p.match(LINK_RE);
    if (m) return `<a href="${esc(m[2])}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(m[1])}</a>`;
    if (URL_RE.test(p)) return `<a href="${esc(p)}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(p)}</a>`;
    return esc(p);
  }).join('');
}

// A PDF margin note (MATH-21) is text as typed: only its library mentions are drawn, so a `*`, a backtick or an address in
// it shows as it did before notes could mention anything. Its pieces, text and mentions in turn, are the shown note's
// child nodes one for one (noteHtml), which is how a click in it finds its place in the text (noteOffset).
const LIB_SPLIT = /(@\[[^\]\n]+\]\(lib:[\w-]+\))/;
export const noteParts = (text) => String(text ?? '').split(LIB_SPLIT).filter(Boolean);
/** A margin note as shown while it is not being edited: its text escaped, each library mention a chip (libHtml). */
export function noteHtml(text, opts) {
  return noteParts(text).map((p) => { const lib = p.match(LIB_MENTION_RE); return lib ? libHtml(lib[1], lib[2], opts && opts.libName) : esc(p); }).join('');
}
/** Where in a note's text a click lands: `offset` characters into its `part`-th piece; a mention's piece is passed whole. */
export function noteOffset(text, part, offset) {
  const parts = noteParts(text);
  let at = 0;
  for (let i = 0; i < Math.min(part, parts.length); i++) at += parts[i].length;
  if (part >= parts.length) return at;
  const p = parts[part];
  return at + (LIB_MENTION_RE.test(p) ? p.length : Math.max(0, Math.min(p.length, Number(offset) || 0)));
}

/* ---------------------------------------------------------------- copy and cut (2026-10-02) */

// Where a line's shown text starts in lineText(): after a heading's `# ` or a quote's `> `, and in an answer after a
// heading or bullet mark of its own. A rendered line maps its first shown character there (rawOffset, replyRawOffset).
function shownFrom(p, line) {
  if (p.type === 'h') return p.level + 1;
  if (p.type === 'quote') return line.length - p.text.length;
  if (p.type === 'reply' && !p.code) { const q = parseLine(p.text); return q.type === 'h' || isMarked(q.type) ? p.text.length - q.text.length : 0; }
  return 0;
}

// One token cut to [lo, hi) of its source. A click in shown text maps by shown characters (rawOffset: 0 is the token's
// start, the d-th character pre + d), so the end of a link's title lands before its `](url)` and a selection read raw
// would copy `[tit`. A cut is read in shown characters instead, and what is left keeps its markup: a link is still a link,
// bold still bold, a mention or an attachment whole. `inside`: the whole selection lies within this token (a word picked
// out of a title), and copies as just that text. Past the shown text is the markup itself, selected as typed on the
// caret's line (a link's address), and copies as typed.
function cutToken(tok, lo, hi, inside) {
  if (lo <= 0 && hi >= tok.length) return tok;
  if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
    const inner = tok.slice(2, -2), x = Math.max(0, Math.min(inner.length, lo - 2)), y = Math.max(0, Math.min(inner.length, hi - 2));
    if (x >= y) return '';
    if (lo <= 0 && y === inner.length) return tok;
    const part = sliceInline(inner, x, y, inside);
    return inside || !part ? part : `**${part}**`;
  }
  const { shown, pre } = tokShown(tok); if (!pre) return tok.slice(lo, hi);
  const n = shown.length;
  if (lo >= pre + n) return lo === pre + n && hi >= tok.length ? '' : tok.slice(lo, hi);
  const x = Math.max(0, lo - pre), y = Math.max(0, Math.min(n, hi - pre));
  if (x >= y) return '';
  if (y === n && (lo <= 0 || (!inside && x === 0))) return tok;
  const part = shown.slice(x, y), link = tok.match(LINK_RE);
  if (inside) return part;
  if (link) return `[${part}](${link[2]})`;
  if (tok.startsWith('`')) return `\`${part}\``;
  if (tok.startsWith('*')) return `*${part}*`;
  return tok;
}

// Source a..b of a line's text as markdown that stands on its own (cutToken for each token the range touches).
function sliceInline(text, a, b, alone) {
  let out = '', s = 0;
  for (const tok of String(text).split(INLINE)) {
    if (!tok) continue;
    const e = s + tok.length;
    if (a < e && b > s) out += cutToken(tok, Math.max(0, a - s), Math.min(tok.length, b - s), alone && a >= s && b <= e);
    s = e;
  }
  return out;
}

/**
 * What a selection copies: the document's markdown from `start` to `end` ({ line, offset }, in either order; offsets
 * into lineText() as the editor's caretInfo gives them), so a link keeps its address wherever it is pasted. Within one
 * line, the text selected. Across lines, the first and last lines cut where the selection is and the lines between whole
 * with their marks (`- `, `# `, `- [ ] `), so a list stays a list; a line selected from its start keeps its mark too. An
 * answer comes without its `bart> ` and without its closing line, as the answer's Copy gives it (turnText). A line a run
 * is working on and a Build's line hold an id, not text, and are left out.
 */
export function selectionMarkdown(lines, start, end) {
  if (!start || !end) return '';
  if (end.line < start.line || (end.line === start.line && end.offset < start.offset)) [start, end] = [end, start];
  const ps = parseLines(lines), feet = new Set();
  for (const thread of threads(lines, ps)) for (const turn of thread.turns) if (turn.foot >= 0) feet.add(turn.foot);
  const out = [];
  for (let i = Math.max(0, start.line); i <= Math.min(end.line, lines.length - 1); i++) {
    const p = ps[i], line = String(lines[i]);
    if (p.type === 'pending' || p.type === 'build' || feet.has(i)) continue;
    const text = lineText(p, line), code = isCode(p) || isFence(p), at = (o) => Math.max(0, Math.min(text.length, Number(o) || 0));
    let a = i === start.line ? at(start.offset) : 0;
    const b = i === end.line ? (end.offset === Infinity ? text.length : at(end.offset)) : text.length;
    if (start.line === end.line) return code ? text.slice(a, b) : sliceInline(text, a, b, true);
    const lead = code ? 0 : shownFrom(p, line);
    // The selection reaches the last line without taking any of its text: the line break is all it holds of it.
    if (i === end.line && b <= lead && b < text.length) { out.push(''); continue; }
    if (a <= lead) a = 0;
    const part = code ? text.slice(a, b) : sliceInline(text, a, b, false);
    out.push(a === 0 && isMarked(p.type) ? line.slice(0, line.length - p.text.length) + part : part);
  }
  return out.join('\n');
}

const SAFE_HREF = /^(https?:|mailto:)/i;
// Inline markdown as plain HTML for other apps: no styles, no chips. A mention is its name; an attachment is left out
// (its image lives in this project only); a link to anything but the web or mail is its title.
function plainHtml(text) {
  return String(text).split(INLINE).map((tok) => {
    if (!tok || ATTACH_RE.test(tok)) return '';
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) return `<strong>${plainHtml(tok.slice(2, -2))}</strong>`;
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) return `<code>${esc(tok.slice(1, -1))}</code>`;
    if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) return `<em>${esc(tok.slice(1, -1))}</em>`;
    const ws = tok.match(WS_MENTION_RE); if (ws) return esc(ws[1]);
    const lib = tok.match(LIB_MENTION_RE); if (lib) return esc(lib[1]);
    if (tok.startsWith('@[')) return esc(tok.slice(2, -1));
    const m = tok.match(LINK_RE); if (m) return SAFE_HREF.test(m[2]) ? `<a href="${esc(m[2])}">${esc(m[1])}</a>` : esc(m[1]);
    if (URL_RE.test(tok)) return `<a href="${esc(tok)}">${esc(tok)}</a>`;
    return esc(tok);
  }).join('');
}

/**
 * The HTML a copy carries beside its markdown, for apps that paste HTML (Google Docs, Slack, mail): links to click, bold
 * and italic, one line per line (`<br>`). A heading is bold, a bullet a •, a checkbox ☐ or ☑; code is kept as typed and
 * its fences go; an image from the web is a link to it, an attached one is left out.
 */
export function selectionHtml(markdown) {
  const ls = String(markdown ?? '').split('\n'), ps = parseLines(ls), pad = (depth) => '&nbsp;&nbsp;&nbsp;&nbsp;'.repeat(depth);
  return ls.map((line, i) => {
    const p = ps[i];
    if (p.type === 'fence') return null;
    if (p.type === 'code') return `<code>${esc(line).replace(/^ +/, (s) => '&nbsp;'.repeat(s.length))}</code>`;
    if (p.type === 'h') return `<strong>${plainHtml(p.text)}</strong>`;
    if (p.type === 'todo') return `${pad(p.depth)}${p.done ? '☑' : '☐'} ${plainHtml(p.text)}`;
    if (p.type === 'list') return `${pad(p.depth)}${listMark(p)} ${plainHtml(p.text)}`;
    if (p.type === 'img') return /^https?:/.test(p.src) ? `<a href="${esc(p.src)}">${esc(p.text || p.src)}</a>` : null;
    return plainHtml(line);
  }).filter((html) => html != null).join('<br>');
}

/**
 * Text pasted from a web page: its plain text names each link by its title alone, so each link of the page's HTML
 * ([{ text, href }], in order) is written back where its title next stands, as `[title](url)`. A title not found as
 * words of its own, an address that is not http(s), a title holding brackets and a link that is its own address are
 * left as the plain text has them.
 */
export function withLinks(plain, anchors) {
  const text = String(plain ?? ''), word = /[\p{L}\p{N}]/u;
  let out = '', at = 0;
  for (const anchor of anchors || []) {
    const title = String(anchor.text || '').replace(/\s+/g, ' ').trim(), url = String(anchor.href || '').trim();
    if (!title || /[[\]]/.test(title) || !/^https?:\/\/\S+$/i.test(url) || title.replace(/\/$/, '') === url.replace(/\/$/, '')) continue;
    let k = text.indexOf(title, at);
    while (k >= 0 && ((word.test(title[0]) && word.test(text[k - 1] || '')) || (word.test(title[title.length - 1]) && word.test(text[k + title.length] || '')))) k = text.indexOf(title, k + 1);
    if (k < 0) continue;
    out += `${text.slice(at, k)}[${title}](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`; at = k + title.length;
  }
  return out + text.slice(at);
}
