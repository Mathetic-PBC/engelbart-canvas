// Pure document model for the Obsidian-style editor.
// Ported verbatim from design/goal-canvas/Goal Canvas.dc.html (lines 403–404, 439–456, 692–730, 801–812).
// One markdown string per document; the caret's line shows its source, every other line renders.

// A task is a checkbox line: `- [ ] text` (2026-09-20). Two things start one — the checkbox itself, typed as `- []`
// or `- [ ]`, and `@Task ` (either case, what the @ menu inserts), which is stored as the checkbox line it makes.
// A bare `- text` is a bullet, not a task: lists are their own kind of line, nested two spaces at a time.
export const TODO_RE = /^( *)- \[([ xX]?)\](?: (.*))?$/;
export const TASK_RE = /^( *)@task[ \t](.*)$/i;
export const LIST_RE = /^( *)[-*] (.*)$/;
export const HEAD_RE = /^(#{1,3}) (.*)$/;
export const IMG_RE = /^!\[([^\]]*)\]\((img:[\w-]+|https?:[^)\s]+|data:image[^)\s]+)\)$/;
export const BART_RE = /^@bart(?:\s(.*))?$/;
// An answer under an @bart line, one prefix per line (src/main/bart/reply.cjs writes them): pending while the run with
// that id works, then a reply. A reply is kept as it arrives (2026-09-21: no Save; Delete is the way out) and its text
// can be edited; `bart+> ` is the same line folded away by Collapse, so a fold is in the file and survives everything
// else. `bart?> ` was the unsaved draft of the 09-19 build and reads as a reply.
export const PENDING_RE = /^bart~> ?([\w-]*)$/;
export const DRAFT_RE = /^bart\?> ?(.*)$/;
export const REPLY_RE = /^bart(\+?)> ?(.*)$/;
// The closing line of an answer: which model said it and how long it took. It is drawn as the card's foot.
export const ATTRIBUTION_RE = /^\*[^*]+\*$/;
export const QUOTE_RE = /^> ?(.*)$/;
export const ATTACH_RE = /^!\[([^\]\n]*)\]\(img:([\w-]+)\)$/;
export const INLINE = /(!\[[^\]\n]*\]\(img:[\w-]+\)|@bart(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`])/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
// A bare address, typed, pasted or written by @bart, is a link as it stands (closing punctuation is not part of it).
const URL_RE = /^https?:\/\/\S+$/;

export const LABELS = { queued: 'Queued', building: 'Building…', checking: 'Checking…', fixing: 'Fixing…', needs_user: 'Needs you', done: 'Done', failed: 'Failed' };
export const HELD = ['queued', 'building', 'checking', 'fixing'];

const depthOf = (indent) => Math.min(8, Math.floor(indent.length / 2));

export const parseLine = (l) => {
  let m;
  if ((m = l.match(BART_RE))) return { type: 'bart', text: m[1] || '' };
  if ((m = l.match(PENDING_RE))) return { type: 'pending', id: m[1], text: '' };
  if ((m = l.match(DRAFT_RE))) return { type: 'reply', text: m[1], folded: false };
  if ((m = l.match(REPLY_RE))) return { type: 'reply', text: m[2], folded: m[1] === '+' };
  if ((m = l.match(QUOTE_RE))) return { type: 'quote', text: m[1] };
  if ((m = l.match(IMG_RE))) return { type: 'img', text: m[1], src: m[2] };
  if ((m = l.match(TODO_RE))) return { type: 'todo', depth: depthOf(m[1]), done: !!m[2] && m[2] !== ' ', text: m[3] || '' };
  if ((m = l.match(TASK_RE))) return { type: 'todo', depth: depthOf(m[1]), done: false, text: m[2] };
  if ((m = l.match(LIST_RE))) return { type: 'list', depth: depthOf(m[1]), text: m[2] };
  if ((m = l.match(HEAD_RE))) return { type: 'h', level: m[1].length, text: m[2] };
  return { type: 'p', text: l };
};

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Lines that stand under an @bart question: what it is working on, what it said, and the legacy `> ` replies of the prototype. */
export const isAnswer = (type) => type === 'quote' || type === 'reply' || type === 'pending';

export const todoLine = (depth, done, text) => `${'  '.repeat(depth)}- [${done ? 'x' : ' '}] ${text}`;
export const listLine = (depth, text) => `${'  '.repeat(depth)}- ${text}`;
// No trimming: a space typed at the end of an answer line has to survive the round trip, or no second word can follow.
export const replyLine = (text, folded) => `bart${folded ? '+' : ''}> ${text}`;

/** Rows of a list: a task or a bullet. They nest, Enter continues them, an empty one steps out. */
export const isMarked = (type) => type === 'todo' || type === 'list';
/** Lines whose prefix is drawn, not typed: the caret's line shows `p.text`, never the `- `, `- [ ] ` or `bart> ` in front of it. */
export const isDrawn = (type) => isMarked(type) || type === 'reply';
/** The text the caret moves through on a line: a drawn line's own text, any other line's whole source. */
export const lineText = (p, line) => (isDrawn(p.type) ? p.text : line);
/** That line again with different text, keeping its kind. */
export const sameLine = (p, text) => (p.type === 'todo' ? todoLine(p.depth, p.done, text) : p.type === 'list' ? listLine(p.depth, text) : p.type === 'reply' ? replyLine(text, p.folded) : text);
/** How a line the person just typed is stored: `@Task …`, `- []` and `* x` become the line they make. */
export const canonicalLine = (l) => { const p = parseLine(l); return isMarked(p.type) ? sameLine(p, p.text) : l; };

/**
 * A marker typed into a row that already draws one (an empty bullet or task): the row takes that marker instead of
 * holding it as literal text — `- [ ] `, `- []` and `@Task ` make it a task, `- ` makes it a bullet.
 * Returns the row's new source and how many characters the marker ate, or null when nothing was typed but text.
 */
export function retypedRow(p, txt) {
  const task = txt.match(/^(?:- \[([ xX]?)\](?: |$)|@task[ \t])/i);
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
export function threads(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (parseLine(lines[i]).type !== 'bart') continue;
    const thread = { from: i, to: i, turns: [] };
    for (;;) {
      const turn = { q: i, from: i + 1, to: i, answered: false, pending: null, foot: -1, folded: false };
      while (i + 1 < lines.length) {
        const p = parseLine(lines[i + 1]);
        if (p.type !== 'pending' && p.type !== 'reply') break;
        i += 1; turn.to = i;
        if (p.type === 'pending') turn.pending = p.id;
        else turn.folded = p.folded;
      }
      turn.answered = turn.to > turn.q;
      if (turn.answered && !turn.pending) { const last = parseLine(lines[turn.to]); if (last.type === 'reply' && ATTRIBUTION_RE.test(last.text)) turn.foot = turn.to; }
      thread.turns.push(turn); thread.to = turn.to;
      if (!turn.answered || i + 1 >= lines.length || parseLine(lines[i + 1]).type !== 'bart') break;
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
    if (p === '@bart') return `<span style="color:#0070f3;font-weight:500">@bart</span>`;
    if (p.startsWith('@[')) { const name = p.slice(2, -1), shown = name.startsWith('bart') ? 'bart' : name; return `<span data-mention="${esc(name)}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9">@${esc(shown)}</span>`; }
    const m = p.match(LINK_RE);
    if (m) return `<a href="${esc(m[2])}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(m[1])}</a>`;
    if (URL_RE.test(p)) return `<a href="${esc(p)}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(p)}</a>`;
    return esc(p);
  }).join('');
}
