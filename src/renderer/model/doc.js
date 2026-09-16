// Pure document model for the Obsidian-style editor.
// Ported verbatim from design/goal-canvas/Goal Canvas.dc.html (lines 403–404, 439–456, 692–730, 801–812).
// One markdown string per document; the caret's line shows its source, every other line renders.

export const TODO_RE = /^( *)- (?:\[([ xX])\] )?(.*)$/;
export const HEAD_RE = /^(#{1,3}) (.*)$/;
export const IMG_RE = /^!\[([^\]]*)\]\((img:[\w-]+|https?:[^)\s]+|data:image[^)\s]+)\)$/;
export const CHAT_RE = /^@chat(?:\s(.*))?$/;
export const QUOTE_RE = /^> ?(.*)$/;
export const INLINE = /(@chat(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\])/g;
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;

export const LABELS = { queued: 'Queued', building: 'Building…', checking: 'Checking…', fixing: 'Fixing…', needs_user: 'Needs you', done: 'Done', failed: 'Failed' };
export const HELD = ['queued', 'building', 'checking', 'fixing'];

export const parseLine = (l) => {
  let m;
  if ((m = l.match(CHAT_RE))) return { type: 'chat', text: m[1] || '' };
  if ((m = l.match(QUOTE_RE))) return { type: 'quote', text: m[1] };
  if ((m = l.match(IMG_RE))) return { type: 'img', text: m[1], src: m[2] };
  if ((m = l.match(TODO_RE))) return { type: 'todo', depth: Math.min(8, Math.floor(m[1].length / 2)), done: !!m[2] && m[2] !== ' ', text: m[3] };
  if ((m = l.match(HEAD_RE))) return { type: 'h', level: m[1].length, text: m[2] };
  return { type: 'p', text: l };
};

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const todoLine = (depth, done, text) => `${'  '.repeat(depth)}- [${done ? 'x' : ' '}] ${text}`;

/** What an inline token shows when rendered, and how many source characters precede the shown text. */
export function tokShown(tok) {
  if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) return { shown: tok.slice(2, -2), pre: 2 };
  if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  if (tok.startsWith('@[')) { const nm = tok.slice(2, -1); return { shown: '@' + (nm.startsWith('chat') ? 'chat' : nm), pre: 1 }; }
  const m = tok.match(LINK_RE); if (m) return { shown: m[1], pre: 1 };
  return { shown: tok, pre: 0 };
}

/** The source tokens of a line as edited on the active line (prefixes for headings/quotes are their own token). */
export function tokensOf(p, line) {
  const src = p.type === 'h' || p.type === 'todo' || p.type === 'quote' ? p.text : line;
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
    else if (p.type !== 'h' && p.type !== 'todo') { text = line; base = 0; }
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

/** Rendered HTML for inline markup (bold, code, italic, @chat, @[mention], [link](url)). */
export function inlineHtml(text) {
  return text.split(INLINE).map((p) => {
    if (!p) return '';
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return `<strong style="font-weight:600">${esc(p.slice(2, -2))}</strong>`;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return `<code style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)">${esc(p.slice(1, -1))}</code>`;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return `<em>${esc(p.slice(1, -1))}</em>`;
    if (p === '@chat') return `<span style="color:#0070f3;font-weight:500">@chat</span>`;
    if (p.startsWith('@[')) { const name = p.slice(2, -1), shown = name.startsWith('chat') ? 'chat' : name; return `<span data-mention="${esc(name)}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9">@${esc(shown)}</span>`; }
    const m = p.match(LINK_RE);
    if (m) return `<a href="${esc(m[2])}" data-link="1" style="color:#0070f3;text-decoration:underline;text-underline-offset:3px">${esc(m[1])}</a>`;
    return esc(p);
  }).join('');
}
