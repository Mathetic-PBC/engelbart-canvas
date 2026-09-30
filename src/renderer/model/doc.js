// Pure document model for the Obsidian-style editor.
// Ported verbatim from design/goal-canvas/Goal Canvas.dc.html (lines 403–404, 439–456, 692–730, 801–812).
// One markdown string per document; the caret's line shows its source, every other line renders.

// A checkbox line: `- [ ] text` (2026-09-20), typed as `- []` or `- [ ]`. `@Task` is gone (2026-09-29): stickies
// took its place, and a checkbox is a checklist, nothing more. A bare `- text` is a bullet: lists are their own kind of
// line, nested two spaces at a time.
export const TODO_RE = /^( *)- \[([ xX]?)\](?: (.*))?$/;
export const LIST_RE = /^( *)[-*] (.*)$/;
export const HEAD_RE = /^(#{1,3}) (.*)$/;
export const IMG_RE = /^!\[([^\]]*)\]\((img:[\w-]+|https?:[^)\s]+|data:image[^)\s]+)\)$/;
export const BART_RE = /^@bart(?:\s(.*))?$/i; // `@Bart` is what the @ menu writes (2026-09-22); `@bart` is what is typed
// An answer under an @bart line, one prefix per line (src/main/bart/reply.cjs writes them): pending while the run with
// that id works, then a reply. A reply is kept as it arrives (2026-09-21: no Save; Delete is the way out) and its text
// can be edited; `bart+> ` is the same line folded away by Collapse, so a fold is in the file and survives everything
// else. `bart?> ` was the unsaved draft of the 09-19 build and reads as a reply.
export const PENDING_RE = /^bart~> ?([\w-]*)$/;
// A Build (2026-09-25): the line holds its id alone, and the editor draws the Build's card from its record (main/build):
// what it is doing, what it said, the reply field, Review / Accept / Discard. Nothing the agent says is in the document.
export const BUILD_RE = /^build> ([0-9a-f]{10})$/;
export const buildLine = (id) => `build> ${id}`;
export const DRAFT_RE = /^bart\?> ?(.*)$/;
export const REPLY_RE = /^bart(\+?)> ?(.*)$/;
// The closing line of an answer: which model said it and how long it took. It is drawn as the card's foot.
export const ATTRIBUTION_RE = /^\*[^*]+\*$/;
export const QUOTE_RE = /^> ?(.*)$/;
export const ATTACH_RE = /^!\[([^\]\n]*)\]\(img:([\w-]+)\)$/;
export const INLINE = /(!\[[^\]\n]*\]\(img:[\w-]+\)|@[Bb]art(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]\(ws:[\w-]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`])/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
// Another workspace of the project, mentioned (2026-09-25): `@[Name](ws:<id>)`. The id finds it after a rename (workspaces
// are born "Untitled Workspace n" and named later); the line shows the @, the workspace icon right after it, then the name
// (2026-09-29), so it never reads as a note of the same name. Before the plain mention in INLINE, so the id stays part of the token.
export const WS_MENTION_RE = /^@\[([^\]\n]+)\]\(ws:([\w-]+)\)$/;
/** The token that mentions a workspace. */
export const wsMention = (name, id) => `@[${String(name || '').replace(/[[\]\n]/g, '').trim() || 'Workspace'}](ws:${id})`;
// ui/Icons.jsx WS, as markup for the rendered line: 0.8em square, on the text's baseline.
const WS_ICON = '<svg viewBox="0 0 16 16" width="0.8em" height="0.8em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="6.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="6.5" height="6.5" rx="1"/><rect x="10" y="8" width="4.5" height="4.5" rx="1"/></svg>';
// A bare address, typed, pasted or written by @bart, is a link as it stands (closing punctuation is not part of it).
const URL_RE = /^https?:\/\/\S+$/;

const depthOf = (indent) => Math.min(8, Math.floor(indent.length / 2));

export const parseLine = (l) => {
  let m;
  if ((m = l.match(BART_RE))) return { type: 'bart', text: m[1] || '' };
  if ((m = l.match(BUILD_RE))) return { type: 'build', id: m[1], text: '' };
  if ((m = l.match(PENDING_RE))) return { type: 'pending', id: m[1], text: '' };
  if ((m = l.match(DRAFT_RE))) return { type: 'reply', text: m[1], folded: false };
  if ((m = l.match(REPLY_RE))) return { type: 'reply', text: m[2], folded: m[1] === '+' };
  if ((m = l.match(QUOTE_RE))) return { type: 'quote', text: m[1] };
  if ((m = l.match(IMG_RE))) return { type: 'img', text: m[1], src: m[2] };
  if ((m = l.match(TODO_RE))) return { type: 'todo', depth: depthOf(m[1]), done: !!m[2] && m[2] !== ' ', text: m[3] || '' };
  if ((m = l.match(LIST_RE))) return { type: 'list', depth: depthOf(m[1]), text: m[2] };
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
export const listLine = (depth, text) => `${'  '.repeat(depth)}- ${text}`;
// No trimming: a space typed at the end of an answer line has to survive the round trip, or no second word can follow.
export const replyLine = (text, folded) => `bart${folded ? '+' : ''}> ${text}`;

/** Rows of a list: a checkbox or a bullet. They nest, Enter continues them, an empty one steps out. */
export const isMarked = (type) => type === 'todo' || type === 'list';
/** Lines whose prefix is drawn, not typed: the caret's line shows `p.text`, never the `- `, `- [ ] ` or `bart> ` in front of it. */
export const isDrawn = (type) => isMarked(type) || type === 'reply';
/** The text the caret moves through on a line: a drawn line's own text, any other line's whole source. */
export const lineText = (p, line) => (isDrawn(p.type) ? p.text : line);
/** That line again with different text, keeping its kind. */
export const sameLine = (p, text) => (p.type === 'todo' ? todoLine(p.depth, p.done, text) : p.type === 'list' ? listLine(p.depth, text) : p.type === 'reply' ? replyLine(text, p.folded) : text);
/** How a line the person just typed is stored: `- []` and `* x` become the line they make. */
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
  return null;
}

/** What an inline token shows when rendered, and how many source characters precede the shown text. */
export function tokShown(tok) {
  const attachment = tok.match(ATTACH_RE); if (attachment) return { shown: `[${attachment[1] || 'Attachment'}]`, pre: 1 };
  if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) return { shown: tok.slice(2, -2), pre: 2 };
  if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  const ws = tok.match(WS_MENTION_RE); if (ws) return { shown: '@' + ws[1], pre: 1 }; // the icon after the @ is not text
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
 * heading shows without its `## `, a bullet shows a `•` (one character of the display) where its `- ` stands.
 */
export function replyRawOffset(p, fOff) {
  const q = parseLine(p.text);
  if (q.type !== 'h' && !isMarked(q.type)) return rawOffset({ type: 'p', text: p.text }, fOff, p.text);
  const lead = p.text.length - q.text.length;
  return lead + rawOffset({ type: 'p', text: q.text }, Math.max(0, fOff - (q.type === 'h' ? 0 : 1)), q.text);
}

/**
 * The @bart exchanges of a document, by line index. A thread is a run of lines with nothing between them: a question,
 * what stands under it (a pending line, or the answer), then any question asked right after that answer — a follow-up,
 * which reads as one card. → [{ from, to, turns }], each turn { q, from, to, answered, pending, foot, folded } where
 * `from..to` are the lines under the question (to === q when there are none), `pending` is the id of a run still
 * working, `foot` the closing line that says which model answered (-1 without one).
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
      if (!turn.answered || i + 1 >= lines.length || ps[i + 1].type !== 'bart') break;
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

/** Rendered HTML for inline markup (bold, code, italic, @bart, @[mention], [link](url), bare urls). */
export function inlineHtml(text) {
  return text.split(INLINE).map((p) => {
    if (!p) return '';
    // A pasted image inside a todo or a chat line reads as [Attachment n]; on a line of its own it renders as the image.
    const attachment = p.match(ATTACH_RE);
    if (attachment) return `<span data-attachment="${esc(attachment[2])}" style="padding:1px 6px;border-radius:4px;background:#f2f2f2;border:1px solid #eaeaea;font:.86em/1.6 var(--font-mono);color:#4d4d4d;white-space:nowrap">[${esc(attachment[1] || 'Attachment')}]</span>`;
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return `<strong style="font-weight:600">${esc(p.slice(2, -2))}</strong>`;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return `<code style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)">${esc(p.slice(1, -1))}</code>`;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return `<em>${esc(p.slice(1, -1))}</em>`;
    if (/^@bart$/i.test(p)) return `<span style="color:#0070f3;font-weight:500">${esc(p)}</span>`;
    const ws = p.match(WS_MENTION_RE);
    if (ws) return `<span data-mention="${esc(ws[1])}" data-ws="${esc(ws[2])}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9;white-space:nowrap">@${WS_ICON}${esc(ws[1])}</span>`;
    if (p.startsWith('@[')) { const name = p.slice(2, -1), shown = name.startsWith('bart') ? 'bart' : name; return `<span data-mention="${esc(name)}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9">@${esc(shown)}</span>`; }
    const m = p.match(LINK_RE);
    if (m) return `<a href="${esc(m[2])}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(m[1])}</a>`;
    if (URL_RE.test(p)) return `<a href="${esc(p)}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(p)}</a>`;
    return esc(p);
  }).join('');
}
