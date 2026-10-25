// Pure document model for the Obsidian-style editor.
import katex from 'katex';
import { hammerSvg } from './hammer.js';
import { isAddress, webLabel } from './web-name.js';
import { citationOf, citationRuns, citationNumbers, citationHtml, citationMoreHtml } from './cite.js';

export { isAddress, sameAddress, webLabel, webName } from './web-name.js'; // a web page's mention (2026-10-17)
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
// `@chat` (2026-10-12) asks the question-answering agent, which is still 'bart' inside the app (its settings, sessions,
// models file and run log keep that name); `@bart` is now the router (agent 'router'), which picks Chat, Brainstorm,
// Discover or Build for the line and steps aside. tokenOf gives the word a line is written with for each agent.
// `@create` (2026-10-13) makes something new, and its answer mentions the library rows it kept (src/main/bart/create.cjs).
export const BART_RE = /^@(bart|chat|brainstorm|orient|discover|create)(?:\s(.*))?$/i;
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
// A conversation's title (2026-10-12): the line right above the question that starts a thread, named by a model when the
// question was asked (src/main/bart/name-chat.cjs); `bart#+ ` is the same thread collapsed to that one row. Threads begun
// before then have none and keep folding a turn at a time. A title with no question under it is plain text (parseLines).
export const TITLE_RE = /^bart#(\+?) ?(.*)$/;
// What a title line keeps of its conversation (2026-10-12), in brackets before the title: the agent that answered it and
// when it was asked, `bart# [discover 2026-10-12T21:41:00Z] Papers on tutors`, and ` build` after the agent when Bart
// routed it to be built (`[chat build …]`). An `@bart` line stays as the person typed it; this is where Bart's pick is
// kept. A title line from before has none and reads as its text.
const TITLE_META_RE = /^\[(chat|brainstorm|discover|create)( build)?(?: (\d{4}-\d\d-\d\dT[\d:.]+Z?))?\](?: |$)/;
/** The title line's text after `bart# ` read → { text, agent, at, build }: agent 'bart' | 'brainstorm' | 'discover' | 'create' or null. */
export function titleMeta(rest) {
  const m = String(rest ?? '').match(TITLE_META_RE);
  if (!m) return { text: String(rest ?? ''), agent: null, at: null, build: false };
  return { text: String(rest).slice(m[0].length), agent: m[1] === 'chat' ? 'bart' : m[1], at: m[3] || null, build: !!m[2] };
}
/** A title line: its text, collapsed or not, and `meta` ({ agent, at, build }, as parseLine reads them) kept in brackets. */
export const titleLine = (text, folded, meta = null) => {
  const agent = meta && meta.agent ? (meta.agent === 'bart' ? 'chat' : meta.agent) : null;
  const tag = agent ? `[${agent}${meta.build ? ' build' : ''}${meta.at ? ` ${meta.at}` : ''}] ` : '';
  return `bart#${folded ? '+' : ''} ${tag}${text}`;
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * When a conversation was asked, as its collapsed row says it (2026-10-12), in local time: "9:41 PM" today, "Yesterday",
 * the weekday within the week, else the date ("Oct 3", and the year when it is not this one). '' with no time.
 */
export function whenShown(at, now = new Date()) {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 864e5);
  if (days <= 0) return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[d.getDay()];
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== now.getFullYear() ? `, ${d.getFullYear()}` : ''}`;
}
/** Now, as a title line keeps it: to the second, in UTC. */
export const askedNow = (now = new Date()) => now.toISOString().replace(/\.\d{3}Z$/, 'Z');
/**
 * Where ask `askId`'s question stands now → { question, index }: its line as written and its index, or null when its
 * pending line is gone. Read just before the answer replaces the pending line, so the title can still find it (placeTitle).
 */
export function askedAt(text, askId) {
  const all = String(text).split('\n'), at = all.indexOf(`bart~> ${askId}`);
  return at > 0 ? { question: all[at - 1], index: at - 1 } : null;
}
/**
 * `text` with the empty title line of ask `askId`'s thread filled with `title`; null when there is none to fill (the
 * person deleted it, or wrote one). Found by the ask, never by an index kept from before: directly above the question
 * whose pending line is `bart~> <askId>`, or, once the answer has replaced that line, above the line `near.question`
 * (askedAt, read then) nearest to where it was.
 */
export function placeTitle(text, askId, title, near = null) {
  const all = String(text).split('\n');
  const empty = (j) => { const m = j >= 0 ? String(all[j]).match(TITLE_RE) : null; return !!m && !titleMeta(m[2]).text.trim(); };
  let at = -1;
  const pending = all.indexOf(`bart~> ${askId}`);
  if (pending >= 0) { if (pending >= 2 && BART_RE.test(all[pending - 1]) && empty(pending - 2)) at = pending - 2; }
  else if (near && typeof near.question === 'string') {
    let best = -1;
    all.forEach((line, j) => { if (line === near.question && empty(j - 1) && (best < 0 || Math.abs(j - near.index) < Math.abs(best - near.index))) best = j; });
    if (best >= 0) at = best - 1;
  }
  if (at < 0 || !String(title || '').trim()) return null;
  const m = all[at].match(TITLE_RE);
  all[at] = titleLine(String(title).trim(), m[1] === '+', titleMeta(m[2]));
  return all.join('\n');
}
/**
 * `text` with the title of the conversation that holds the question `near` (askedAt, read before its answer was placed)
 * changed to `title` (2026-10-14: a Brainstorm conversation's topic, the label on its chip); null when there is nothing
 * to change: no such question, a conversation with no title line, or the same title already. `unset`: only a title not
 * written yet is changed (2026-10-14: a Discover conversation named from what it settled to research).
 */
export function retitle(text, near, title, { unset = false } = {}) {
  const said = String(title || '').trim();
  if (!said || !near || typeof near.question !== 'string') return null;
  const all = String(text).split('\n');
  let best = -1;
  all.forEach((line, j) => { if (line === near.question && (best < 0 || Math.abs(j - near.index) < Math.abs(best - near.index))) best = j; });
  const thread = best < 0 ? null : threads(all).find((t) => t.turns.some((turn) => turn.q === best));
  if (!thread || thread.titleLine < 0) return null;
  const m = all[thread.titleLine].match(TITLE_RE), meta = titleMeta(m[2]);
  if (meta.text.trim() === said || (unset && meta.text.trim() && meta.text.trim() !== UNSET_TOPIC)) return null;
  all[thread.titleLine] = titleLine(said, m[1] === '+', meta);
  return all.join('\n');
}
// What a bare line's Brainstorm conversation was called before 2026-10-14 (main's bart/name-chat.cjs UNNAMED): no topic.
export const UNSET_TOPIC = 'New conversation';
/** A Brainstorm conversation's topic, as its chip shows it: its title, unless it has none yet. '' otherwise. */
export const topicOfThread = (thread) => (thread && thread.routedTo === 'brainstorm' && thread.title && thread.title.trim() !== UNSET_TOPIC ? thread.title.trim() : '');
// The closing line of an answer: which model said it and how long it took. It is drawn as the card's foot.
export const ATTRIBUTION_RE = /^\*[^*]+\*$/;
export const QUOTE_RE = /^> ?(.*)$/;
export const ATTACH_RE = /^!\[([^\]\n]*)\]\(img:([\w-]+)\)$/;
// Math (2026-10-12): `$…$` inline by Pandoc's rule (no space just inside either `$`, the closing `$` not followed by a
// digit, so "$5 and $10" stays text), `$$…$$` display, and `\$` a dollar as typed. Drawn with KaTeX (renderMath).
const MATH_SRC = String.raw`\$\$(?:[^$\n\\]|\\.)+?\$\$|\$(?=[^\s$])(?:[^$\n\\]|\\.)+?(?<!\s)\$(?!\d)|\\\$`;
export const INLINE = new RegExp(String.raw`(${MATH_SRC}|` + /!\[[^\]\n]*\]\(img:[\w-]+\)|\[\[build\]\]|@(?:[Bb]art|[Cc]hat|[Bb]rainstorm|[Oo]rient|[Dd]iscover|[Cc]reate)(?=\s|$)|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|@\[[^\]\n]+\]\(ws:[\w-]+\)|@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%\/-]+)?\)|@\[[^\]\n]+\]\(zotero:(?:g[0-9]+:)?[A-Za-z0-9]+\)|@\[[^\]\n]+\]\(made:[\w-]+\/[\w.~%\/-]+\)|@\[[^\]\n]+\]|https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"*`]/.source + ')', 'g');
const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
// Build, named in an answer (2026-10-12): a routed build's answer ended "Press [[build]] Build to build it." (main/bart/
// ask.cjs ROUTED_BUILD) until 2026-10-13, when it began asking "Want me to build it?" instead, a "yes" being routed to
// build. Answers written before still hold the token: it is drawn as a hammer that builds (inlineHtml). It is one unit, as
// drawn math is (tokShown, rawOffset, cutToken), and copies as typed.
export const BUILD_TOKEN = '[[build]]';
// The hammer inline: 14px, the answer's grey, sitting on the text's baseline. In an answer line `turn` is the turn's
// question line, and a click does what the footer's Build does for it (DocEditor footbuild); anywhere else it is a drawing.
function buildIconHtml(turn) {
  const acts = Number.isInteger(turn) ? ` data-act="footbuild" data-turn="${turn}" role="button" aria-label="Build" title="Build"` : ' aria-hidden="true"';
  return `<span data-build-icon="1" contenteditable="false"${acts} style="display:inline-flex;color:#4d4d4d;vertical-align:-2px;user-select:none${Number.isInteger(turn) ? ';cursor:pointer' : ''}">${hammerSvg(14)}</span>`;
}
// A math token's source as a whole: `$$…$$` (display) or `$…$` (inline), the same rules as INLINE's.
const DISPLAY_MATH_RE = /^\$\$((?:[^$\n\\]|\\.)+?)\$\$$/;
const INLINE_MATH_RE = /^\$(?=[^\s$])((?:[^$\n\\]|\\.)+?)(?<!\s)\$$/;
/** A math token's LaTeX and whether it is display math, or null for anything else. */
export function mathOf(tok) {
  const d = String(tok).match(DISPLAY_MATH_RE); if (d) return { tex: d[1], display: true };
  const m = String(tok).match(INLINE_MATH_RE); return m ? { tex: m[1], display: false } : null;
}
export const isMathToken = (tok) => !!mathOf(tok);
const CODE_LOOK = 'padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
// What a browser's Range.toString() reads of rendered HTML, as caretAt does (zero-width spaces dropped): KaTeX writes some.
const textOfHtml = (html) => html.replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => (
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? all
)).replace(/\u200b/g, '');
const MATH_CACHE = new Map();
/**
 * LaTeX drawn by KaTeX → { html, shown } (`shown`: the text of the drawing, which is what the caret counts), or null when
 * KaTeX cannot draw it: the source then shows as typed, in the inline-code look. Untrusted (no \\href, \\url and the
 * like) and never throws.
 */
export function renderMath(tex, display) {
  const key = (display ? 'D' : 'I') + tex;
  if (MATH_CACHE.has(key)) return MATH_CACHE.get(key);
  let html = null;
  try { html = katex.renderToString(tex, { throwOnError: false, trust: false, displayMode: !!display }); } catch { html = null; }
  const out = html && !html.includes('katex-error') ? { html, shown: textOfHtml(html) } : null;
  if (MATH_CACHE.size >= 500) MATH_CACHE.delete(MATH_CACHE.keys().next().value);
  MATH_CACHE.set(key, out);
  return out;
}
/** A math token drawn: KaTeX's drawing, not editable (the caret's line shows its source), or its source as code. */
export function mathTokenHtml(tok) {
  const m = mathOf(tok), r = m && renderMath(m.tex, m.display);
  if (!r) return `<code data-math-error="1" style="${CODE_LOOK}">${esc(tok)}</code>`;
  return `<span data-math="1" contenteditable="false"${m.display ? ' style="display:block;text-align:center"' : ''}>${r.html}</span>`;
}
/**
 * A ```math block's LaTeX drawn as display math (DocEditor, when the caret is not in the block), or null when KaTeX cannot
 * draw it and the block shows as code.
 */
export function mathBlockHtml(tex) {
  const r = String(tex).trim() ? renderMath(String(tex), true) : null;
  return r ? `<span data-math="1" contenteditable="false" style="display:block">${r.html}</span>` : null;
}
/**
 * Text as typed with only its math drawn (a brainstorm card's strings, which are otherwise plain text): everything else
 * escaped, `\\$` a dollar.
 */
export function textMathHtml(text) {
  return String(text ?? '').split(INLINE).map((tok) => (!tok ? '' : tok === '\\$' ? '$' : isMathToken(tok) ? mathTokenHtml(tok) : esc(tok))).join('');
}
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
/** The token that mentions a library item. A web page's is written under model/web-name.js webName (2026-10-17). */
export const libMention = (name, id) => `@[${String(name || '').replace(/[[\]\n]/g, '').trim() || 'Untitled'}](lib:${id})`;
// A file inside a library folder (MATH-22, 2026-10-06): `@[Name](lib:<folderId>:<path>)`, the folder's library id and
// the file's path relative to it, each segment percent-encoded (encodeRel) so a space, a bracket, a parenthesis, a `#` or
// a letter outside ASCII never ends the token; `/` stays between segments. The files are not library rows: the folder
// is, and the file is read from disk when the line is drawn or clicked (store/folder-files.cjs). Part of the same INLINE
// alternative as the plain library mention.
export const FILE_MENTION_RE = /^@\[([^\]\n]+)\]\(lib:([\w-]+):([\w.~%/-]+)\)$/;
/** A path inside a folder, as a file mention carries it: each segment encodeURIComponent'd, and `!'()*` too. */
export const encodeRel = (rel) => String(rel ?? '').split('/').filter((part) => part && part !== '.').map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
/** encodeRel's inverse; a segment that does not decode is kept as written. */
export const decodeRel = (rel) => String(rel ?? '').split('/').filter(Boolean).map((part) => { try { return decodeURIComponent(part); } catch { return part; } }).join('/');
/** The token that mentions the file at `rel` (as listed, not encoded) inside the library folder `folderId`. */
export const fileMention = (name, folderId, rel) => `@[${String(name || '').replace(/[[\]\n]/g, '').trim() || String(rel || '').split('/').pop().replace(/[[\]\n]/g, '') || 'Untitled'}](lib:${folderId}:${encodeRel(rel)})`;
/** A file mention's parts → { name, folderId, rel } (`rel` decoded), or null. */
export function fileMentionOf(tok) {
  const m = String(tok ?? '').match(FILE_MENTION_RE);
  return m ? { name: m[1], folderId: m[2], rel: decodeRel(m[3]) } : null;
}
// An item of the connected Zotero library (MATH-65 build 2, 2026-10-07): `@[Title](zotero:<itemKey>)`. The item is no
// library row: main reads it from the mirror of the library (src/main/zotero/mirror.cjs) when Bart is asked or the chip is
// clicked (its pdf in the Stage, else its address). Before the plain mention in INLINE too.
// Build 5: item keys are only unique within a library, so the target is a ref: `<itemKey>` an item of My Library (as
// every mention written before), `g<groupID>:<itemKey>` one of that group (src/main/zotero/mirror.cjs parseRef).
export const ZOTERO_MENTION_RE = /^@\[([^\]\n]+)\]\(zotero:((?:g[0-9]{1,20}:)?[A-Za-z0-9]{1,32})\)$/;
/** The token that mentions the Zotero item `ref` (its key, or g<groupID>:<key>), under its title. */
export const zoteroMention = (title, ref) => `@[${String(title || '').replace(/[[\]\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled'}](zotero:${ref})`;
/** A Zotero mention's parts → { name, key, group } (`key` the ref, `group` '' for My Library), or null. */
export function zoteroMentionOf(tok) {
  const m = String(tok ?? '').match(ZOTERO_MENTION_RE);
  return m ? { name: m[1], key: m[2], group: (/^g([0-9]+):/.exec(m[2]) || ['', ''])[1] } : null;
}
// A file @create made (2026-10-14; main/bart/create.cjs madeMention): `@[name](made:<askId>/<path>)`, the run's id and the
// file's path in its folder (<project>/.created/<askId>/), encoded as a file mention's is. On a line of its own in an
// answer it is drawn as Create's row (DocEditor madeRowHtml); anywhere else, as a mention that opens it in the Stage.
export const MADE_MENTION_RE = /^@\[([^\]\n]+)\]\(made:([\w-]+)\/([\w.~%/-]+)\)$/;
/** A made file's token → { name, askId, rel } (`rel` decoded), or null. */
export function madeMentionOf(tok) {
  const m = String(tok ?? '').trim().match(MADE_MENTION_RE);
  return m ? { name: m[1], askId: m[2], rel: decodeRel(m[3]) } : null;
}
/** Its key, as the editor and the window hold what they read of it: `<askId>/<rel>`. */
export const madeKey = (made) => `${made.askId}/${made.rel}`;
// What kind of file a name is, by its extension, as the library tells (store/library.cjs FILE_TYPES): the chip's glyph.
const FILE_KINDS = { md: 'md', markdown: 'md', pdf: 'pdf', html: 'html', htm: 'html', csv: 'data', tsv: 'data', json: 'data', jsonl: 'data', ndjson: 'data', parquet: 'data', xlsx: 'data', docx: 'md', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image', svg: 'image' };
export const fileKindOf = (name) => { const ext = /\.([^./]+)$/.exec(String(name || '')); return (ext && FILE_KINDS[ext[1].toLowerCase()]) || 'file'; };
// A chat mentioned by name (MATH-60, 2026-10-06): `@[bart]` is Bart itself, always there. `@[bart:<id>]`, and the older
// `@[chat]` and `@[chat:<id>]`, named one of the inline chats @bart replaced on 2026-09-19: none is left, so they show as
// gone. Only these exact names are chats: a note named "Bart Follow-up Sessions…" is that note.
const CHAT_MENTION_RE = /^(bart|chat)(?::[\w-]+)?$/i;
/** A plain mention's name as a chat → { shown, live } (`shown` the word the line shows), or null when it names no chat. */
export function chatMention(name) {
  const m = String(name ?? '').match(CHAT_MENTION_RE);
  return m ? { shown: m[1].toLowerCase(), live: /^bart$/i.test(name) } : null;
}
// What the @ menu is looking for: an `@` and up to 30 characters after it, no space, @ or bracket among them, ending at the
// caret. A document line and a follow-up field (2026-10-02) read it the same way.
const MENTION_QUERY_RE = /@([^\s@[\]]{0,30})$/;
// A name of several words (2026-10-16): past a space the menu keeps reading, up to 60 characters, while a name it offers
// holds what was typed (`holds`), so `@Meeting with D` still narrows to "Meeting with David". Words no name holds are
// writing, not a search: the menu closes.
const NAMED_QUERY_RE = /@([^\s@[\]][^@[\]\n]{0,59})$/;
/**
 * The @ menu's query in `text` before `caret` → { query, start } (`start` where its @ stands), or null when there is none.
 * `holds(query)`, when given, says whether a name the menu offers holds a query with a space in it.
 */
export function mentionAt(text, caret, holds) {
  const before = String(text ?? '').slice(0, caret);
  const m = before.match(MENTION_QUERY_RE);
  if (m) return { query: m[1], start: caret - m[0].length };
  const named = typeof holds === 'function' ? before.match(NAMED_QUERY_RE) : null;
  return named && holds(named[1]) ? { query: named[1], start: caret - named[0].length } : null;
}
/** What a library folder opened from the @ menu writes into the line (MATH-22): `@Folder/`, `@Folder/sub/`, … */
export const folderPath = (name, rel) => `@${[name, ...(rel ? rel.split('/') : [])].join('/')}/`;
/**
 * The @ menu's query inside a library folder opened from it (MATH-22): the line keeps the folder's path (`path`, standing
 * at `start`; folderPath), spaces and all, and what follows it up to the caret narrows that level (it may hold spaces too,
 * as file names do). → { query, start }; { into, start } when a `/` was typed right after a name (the subfolder by that
 * name, if there is one, is entered); null when the path is no longer there before the caret.
 */
export function folderMentionAt(text, caret, { start, path }) {
  const s = String(text ?? ''), end = start + path.length;
  if (caret < end || s.slice(start, end) !== path) return null;
  const rest = s.slice(end, caret);
  if (/[@[\]\n]/.test(rest) || rest.length > 80) return null;
  const slash = rest.indexOf('/');
  if (slash < 0) return { query: rest, start };
  return slash > 0 && slash === rest.length - 1 ? { into: rest.slice(0, -1), start } : null;
}
// ui/Icons.jsx WS, as markup for the rendered line: 0.8em square, on the text's baseline.
const WS_ICON = '<svg viewBox="0 0 16 16" width="0.8em" height="0.8em" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em"><rect x="1.5" y="1.5" width="4.5" height="4.5" rx="1"/><rect x="8" y="1.5" width="6.5" height="4.5" rx="1"/><rect x="1.5" y="8" width="6.5" height="6.5" rx="1"/><rect x="10" y="8" width="4.5" height="4.5" rx="1"/></svg>';
// ui/Icons.jsx's kind glyphs as markup, for a file mention's chip (MATH-22): drawn as WS_ICON is, after the @.
const svgIcon = (body, fill = 'none') => `<svg viewBox="0 0 16 16" width="0.8em" height="0.8em" fill="${fill}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em">${body}</svg>`;
const FILE_ICONS = {
  pdf: svgIcon('<path d="M3.5 1.5h6l3 3v10h-9z"/><path d="M9.5 1.5v3h3"/>'),
  md: svgIcon('<path d="M5 1.5h4.5L13 5v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M9.5 1.5v2A1.5 1.5 0 0 0 11 5h2"/><path d="M5.5 7.75h5M5.5 10h5M5.5 12.25h5"/>'),
  html: svgIcon('<path d="M5 1.5h4.5L13 5v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z"/><path d="M9.5 1.5v2A1.5 1.5 0 0 0 11 5h2"/><path d="M6.75 8.25 5.25 10l1.5 1.75M9.25 8.25l1.5 1.75-1.5 1.75"/>'),
  data: svgIcon('<path d="M8 2.5 14 5.5 8 8.5 2 5.5z"/><path d="M2 8.5l6 3 6-3"/><path d="M2 11.5l6 3 6-3"/>'),
  image: svgIcon('<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><circle cx="5.5" cy="6" r="1.25"/><path d="M14.5 10.5 11 7l-4.5 4.5L4.5 9.5 1.5 12.5"/>'),
  folder: svgIcon('<path d="M1.5 4a1 1 0 0 1 1-1h3.3l1.5 1.8h6.2a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>'),
};
FILE_ICONS.file = FILE_ICONS.pdf;
// A web page's glyph: ui/Icons.jsx GLOBE; a repository's: GH (2026-10-17).
const WEB_ICONS = {
  website: svgIcon('<path d="M8 1.75a6.25 6.25 0 1 1 0 12.5 6.25 6.25 0 0 1 0-12.5z"/><path d="M1.75 8h12.5"/><path d="M8 1.75c1.8 1.7 2.7 3.8 2.7 6.25S9.8 12.55 8 14.25"/><path d="M8 1.75C6.2 3.45 5.3 5.55 5.3 8s.9 4.55 2.7 6.25"/>'),
  git: `<svg viewBox="0 0 16 16" width="0.8em" height="0.8em" fill="currentColor" aria-hidden="true" style="display:inline-block;vertical-align:-0.06em;margin:0 0.2em 0 0.1em"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
};
// A Zotero item's glyph: a book.
const ZOTERO_ICON = svgIcon('<path d="M3 2.5h7.5a1.5 1.5 0 0 1 1.5 1.5v9.5H4.5A1.5 1.5 0 0 1 3 12z"/><path d="M3 12a1.5 1.5 0 0 1 1.5-1.5H12"/>');
// A bare address, typed, pasted or written by @bart, is a link as it stands (closing punctuation is not part of it).
const URL_RE = /^https?:\/\/\S+$/;

/**
 * Which agent a question line asks: 'bart' (an `@chat` line), 'router' (an `@bart` line), 'brainstorm', 'discover' or
 * 'create'. An `@orient` line asks @brainstorm (2026-10-05).
 */
export const agentOf = (p) => (p && p.agent === 'orient' ? 'brainstorm' : p && (p.agent === 'brainstorm' || p.agent === 'discover' || p.agent === 'create' || p.agent === 'router') ? p.agent : 'bart');
/** The word a line asking `agent` starts with (2026-10-12): Chat's is `chat`, the router's `bart`, every other its own name. */
export const tokenOf = (agent) => (agent === 'bart' || !agent ? 'chat' : agent === 'router' ? 'bart' : agent);
/** The token that starts a question line, as INLINE splits it out. */
export const AGENT_TOKEN = /^@(bart|chat|brainstorm|orient|discover|create)$/i;
// How the document draws an agent's token (inlineHtml): the link's blue, weight 500. The Stage's note fields tint theirs
// with it too (2026-10-24, agentTokens, noteInkHtml, agentInkHtml).
export const AGENT_INK = '#0070f3';
export const AGENT_LOOK = `color:${AGENT_INK};font-weight:500`;
/**
 * The agents' tokens in `text`, as the document finds them (INLINE splits the text, AGENT_TOKEN names a piece an agent's):
 * [{ start, end, token }] in order. A token inside code, math or a link is none, as it is none in the document.
 */
export function agentTokens(text, from = 0) {
  const out = [];
  for (const m of String(text ?? '').matchAll(INLINE)) {
    const p = m[0], at = from + m.index;
    if (AGENT_TOKEN.test(p)) out.push({ start: at, end: at + p.length, token: p });
    else if (p.startsWith('**') && p.endsWith('**') && p.length > 4) out.push(...agentTokens(p.slice(2, -2), at + 2)); // bold holds them, as inlineHtml draws it
  }
  return out;
}
/**
 * Text pasted into a question line, as one line (2026-10-02): a question is one line of the document, and a paste split
 * over several put all but its first line under the question, where it was never asked. Each line break, with the
 * whitespace and blank lines around it, becomes one space; the ends are trimmed. Spacing inside a line is kept.
 */
export const flattenPaste = (text) => String(text ?? '').replace(/\s*[\r\n]\s*/g, ' ').trim();

const depthOf = (indent) => Math.min(8, Math.floor(indent.length / 2));

export const parseLine = (l) => {
  let m;
  if ((m = l.match(BART_RE))) { const agent = m[1].toLowerCase(); return agent === 'chat' ? { type: 'bart', text: m[2] || '' } : { type: 'bart', text: m[2] || '', agent: agent === 'bart' ? 'router' : agent }; }
  if ((m = l.match(BUILD_RE))) return { type: 'build', id: m[1], text: '' };
  if ((m = l.match(PENDING_RE))) return { type: 'pending', id: m[1], text: '' };
  if ((m = l.match(TITLE_RE))) return { type: 'title', ...titleMeta(m[2]), folded: m[1] === '+' };
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
  // A title belongs to the question under it; without one it is the text it is.
  for (let i = 0; i < ps.length; i++) if (ps[i].type === 'title' && (!ps[i + 1] || ps[i + 1].type !== 'bart')) ps[i] = { type: 'p', text: String(lines[i]) };
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

/**
 * What an inline token shows when rendered, and how many source characters precede the shown text. `opts` as inlineHtml's:
 * a library mention shows its item's name now, so the offsets of what follows it match what is drawn.
 */
export function tokShown(tok, opts) {
  // A math token is one unit, as a mention is: `unit` (rawOffset, cutToken). Undrawable math shows as typed.
  if (tok === '\\$') return { shown: '$', pre: 1 };
  if (tok === BUILD_TOKEN) return { shown: '', pre: 1, unit: true }; // the hammer: a drawing, no text
  const math = mathOf(tok);
  if (math) { const r = renderMath(math.tex, math.display); return r ? { shown: r.shown, pre: 1, unit: true } : { shown: tok, pre: 0 }; }
  // A pasted image is one unit too (2026-10-15, David): its source (`![Attachment 1](img:<id>)`) is never shown, not even
  // with the caret beside it, and the caret stands before or after it, never inside.
  const attachment = tok.match(ATTACH_RE); if (attachment) return { shown: `[${attachment[1] || 'Attachment'}]`, pre: 1, unit: true };
  // Bold may hold a link or a mention (an @discover guide's titles, 2026-09-30): what shows is what they show.
  if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) return { shown: tok.slice(2, -2).split(INLINE).filter(Boolean).map((inner) => tokShown(inner, opts).shown).join(''), pre: 2 };
  if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) return { shown: tok.slice(1, -1), pre: 1 };
  const ws = tok.match(WS_MENTION_RE); if (ws) return { shown: '@' + ws[1], pre: 1 }; // the icon after the @ is not text
  const file = tok.match(FILE_MENTION_RE); if (file) return { shown: '@' + file[1], pre: 1 }; // nor a file's glyph
  const zotero = tok.match(ZOTERO_MENTION_RE); if (zotero) return { shown: '@' + zotero[1], pre: 1 }; // nor a Zotero item's
  const made = tok.match(MADE_MENTION_RE); if (made) return { shown: '@' + made[1], pre: 1 };
  const lib = tok.match(LIB_MENTION_RE); if (lib) return { shown: '@' + libShown(lib[1], lib[2], opts && opts.libName), pre: 1 };
  if (tok.startsWith('@[')) { const nm = tok.slice(2, -1), chat = chatMention(nm); return { shown: '@' + (chat ? chat.shown : nameShown(nm)), pre: 1 }; } // a web page's glyph is not text either
  // A citation (2026-10-21, ./cite.js) is a circle whose number is CSS's: no text, one unit, as the hammer is.
  if (citationOf(tok)) return { shown: '', pre: 1, unit: true };
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
 * use their real length; without it the design's fixed bases apply (heading level+1, quote 2, else 0). `opts` as the
 * line was drawn with (inlineHtml).
 */
export function rawOffset(p, fOff, line, opts) {
  let text = p.text;
  let base = p.type === 'h' ? p.level + 1 : p.type === 'quote' ? 2 : 0;
  if (typeof line === 'string') {
    if (p.type === 'quote') base = line.length - p.text.length;
    else if (p.type !== 'h' && !isDrawn(p.type)) { text = line; base = 0; }
  }
  let accF = 0, accR = 0;
  for (const tok of text.split(INLINE)) {
    if (!tok) continue;
    const { shown, pre, unit } = tokShown(tok, opts);
    if (unit && fOff <= accF + shown.length) return base + accR + (fOff === accF ? 0 : tok.length); // drawn math: before or after it
    // The end of what a mention shows is the end of its source (MATH-56): a click after it lands after it, not before its
    // `]`. Bold and the rest keep their end inside the closing mark, so what is typed there continues them.
    if (fOff <= accF + shown.length) { const d = fOff - accF; return base + accR + (pre ? (d === 0 ? 0 : d === shown.length && tok.startsWith('@[') ? tok.length : Math.min(tok.length, pre + d)) : d); }
    accF += shown.length; accR += tok.length;
  }
  return base + text.length;
}

/**
 * A display offset in a rendered answer line → the offset in its text. An answer line holds markdown of its own: a
 * heading shows without its `## `, a bullet shows a `•` (one character of the display) where its `- ` stands, a
 * numbered row its number (`1.`).
 */
export function replyRawOffset(p, fOff, opts) {
  const q = parseLine(p.text);
  if (q.type !== 'h' && !isMarked(q.type)) return rawOffset({ type: 'p', text: p.text }, fOff, p.text, opts);
  const lead = p.text.length - q.text.length;
  return lead + rawOffset({ type: 'p', text: q.text }, Math.max(0, fOff - (q.type === 'h' ? 0 : q.type === 'list' ? listMark(q).length : 1)), q.text, opts);
}

/**
 * Whether question line `p` may follow an answer in the thread question line `first` opened: it asks the agent that
 * answered the thread last (2026-10-02), or it is an `@bart` line, which goes on with any thread whatever agent Bart hands
 * it to (2026-10-13). An `@orient` line (2026-10-05) starts a thread of its own, as it did when it was an agent of its
 * own, unless that thread is an @orient one; the @brainstorm lines answering an @orient thread's cards go on with it.
 */
const followsIn = (p, first, thread) => (
  agentOf(p) === 'router' || isResearch(p) || isRefine(p) || (agentOf(p) === thread.agent && (p.agent !== 'orient' || first.agent === 'orient'))
);
// An @discover research box (2026-10-13): an @discover question is answered by a reply (Chat, asked with main's
// bart/ask.cjs DISCOVER_INTRO, its closing line naming Discover), then searched in a box of its own under it, a turn of
// the same conversation whose line is `@discover --research <problem>`. The editor draws that line as the box's head and
// its answer inside the box (DocEditor layout `box`). It goes on with any conversation, whoever answered the turn before
// it, as an `@bart` line does: the reply above it may still be running.
export const RESEARCH_FLAG = '--research';
const RESEARCH_RE = /(^|\s)--research(?=\s|$)/i;
/** Whether parsed line `p` is a research box's line. */
export const isResearch = (p) => !!p && p.type === 'bart' && agentOf(p) === 'discover' && RESEARCH_RE.test(p.text);
/** A research box's line for `text` (an @discover question's, its flags kept). */
export const researchLine = (text) => `@discover ${RESEARCH_FLAG}${String(text || '').trim() ? ` ${String(text).trim()}` : ''}`;
/** What a research box's line asks, without its flag. */
export const researchText = (text) => String(text || '').replace(new RegExp(RESEARCH_RE.source, 'gi'), '$1').replace(/\s+/g, ' ').trim();
// A Refine turn (2026-10-15, David): what the person typed in the field Refine opens under the research-intent reply,
// `@discover --refine <words>`, a turn of the same conversation (it goes on with it as a research box's line does). Its
// answer is the direction again, corrected, which waits in a research box until Start research or Restart research.
export const REFINE_FLAG = '--refine';
const REFINE_RE = /(^|\s)--refine(?=\s|$)/i;
/** Whether parsed line `p` is a Refine turn's line. */
export const isRefine = (p) => !!p && p.type === 'bart' && agentOf(p) === 'discover' && REFINE_RE.test(p.text);
/** A Refine turn's line for what was typed. */
export const refineLine = (text) => `@discover ${REFINE_FLAG} ${String(text || '').trim()}`;
// The agents a closing line names first (main/bart/reply.cjs attribution, 2026-10-12): "Build" is Chat, asked to write
// the Build prompt for a line Bart read as one to build.
const FOOT_AGENTS = { Chat: 'bart', Build: 'bart', Brainstorm: 'brainstorm', Discover: 'discover', Create: 'create' };
const FOOT_LEAD_RE = /^\*(Chat|Brainstorm|Discover|Create|Build)(?: · [^*]*)?\*$/;
/** The agent a closing line says answered ('bart', 'brainstorm', 'discover' or 'create'), or null: an older one names none. */
export const footAgent = (text) => { const m = String(text ?? '').match(FOOT_LEAD_RE); return m ? FOOT_AGENTS[m[1]] : null; };
/**
 * The agent that answers a thread (2026-10-13): the one that answered its last answered turn (turn.agent, read from that
 * turn's closing line), else the one its title line names, where Bart's first pick for an `@bart` line is kept, else the
 * one its first question line asks. 'bart' (Chat), 'brainstorm', 'discover', or 'router' for an `@bart` line not handed
 * over yet.
 */
export const answeredBy = (thread) => {
  const turns = (thread && thread.turns) || [];
  for (let k = turns.length - 1; k >= 0; k--) if (turns[k].answered && !turns[k].pending && turns[k].agent) return turns[k].agent;
  return (thread && thread.routedTo) || (thread && thread.asked) || 'bart';
};

/**
 * The @bart exchanges of a document, by line index. A thread is a run of lines with nothing between them: a question,
 * what stands under it (a pending line, or the answer), then any question asked right after that answer — a follow-up,
 * which reads as one card. A follow-up asks the agent that answered the thread last, or is an `@bart` line, which Bart
 * may hand to any agent (2026-10-13); a line for another agent starts a thread of its own, with its own card and reply
 * field (2026-10-02; followsIn). → [{ from, to, turns, agent, asked, routedTo, at, build, title, titleLine, folded }]:
 * `agent` the thread's (answeredBy: 'bart', 'brainstorm' or 'discover'), `asked` its first line's, `routedTo`, `at` and
 * `build` what its title line keeps (Bart's first pick); and for a thread begun under a title line (2026-10-12) `title`
 * its text, `titleLine` its index (-1 and null without one) and `folded` whether the thread is collapsed to it; `from` is
 * always the first question's line. Each turn { q, from, to, answered, pending, foot, folded, agent, build } where `from..to`
 * are the lines under the question (to === q when there are none), `pending` is the id of a run still working, `foot` the
 * closing line that says which model answered (-1 without one), `build` the id of the Build card that stands directly
 * under the question as its answer (an `@bart --build` line's; no turn follows it; absent otherwise), and `agent` the agent
 * that answered it: the one its closing line names, else the one its line asks, else (an `@bart` line opening a thread)
 * the title line's; null for an `@bart` turn none of them names (pending, or failed).
 */
export function threads(lines, ps = parseLines(lines)) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (ps[i].type !== 'bart') continue;
    const head = i > 0 && ps[i - 1].type === 'title' ? ps[i - 1] : null;
    const thread = { from: i, to: i, turns: [], asked: agentOf(ps[i]), routedTo: (head && head.agent) || null, at: (head && head.at) || null, build: !!(head && head.build), title: head ? head.text : null, titleLine: head ? i - 1 : -1, folded: !!(head && head.folded) };
    thread.agent = answeredBy(thread);
    for (;;) {
      const turn = { q: i, from: i + 1, to: i, answered: false, pending: null, foot: -1, folded: false };
      while (i + 1 < lines.length) {
        const p = ps[i + 1];
        if (p.type !== 'pending' && p.type !== 'reply') break;
        i += 1; turn.to = i;
        if (p.type === 'pending') turn.pending = p.id;
        else turn.folded = p.folded;
      }
      // A Build card right under the question is its answer (2026-10-13): an `@bart --build` line's, which replaced its
      // pending line. Only the line directly under it: a card under a reply was started from the answer above it.
      if (turn.to === turn.q && ps[i + 1] && ps[i + 1].type === 'build') { i += 1; turn.to = i; turn.build = ps[i].id; }
      turn.answered = turn.to > turn.q;
      if (turn.answered && !turn.pending) { const last = ps[turn.to]; if (last.type === 'reply' && ATTRIBUTION_RE.test(last.text)) turn.foot = turn.to; }
      const asks = agentOf(ps[turn.q]);
      turn.agent = (turn.foot >= 0 && footAgent(ps[turn.foot].text)) || (asks !== 'router' ? asks : turn.q === thread.from ? thread.routedTo : null);
      thread.turns.push(turn); thread.to = turn.to;
      thread.agent = answeredBy(thread); // a line under this turn follows in with the agent that answered last
      // A question line goes on with a thread once it is asked (a pending line or an answer under it), whatever its agent
      // (2026-10-13): one still being typed under a card is no turn of it, and asked from the document it starts a
      // conversation of its own (DocEditor askInline). The card's reply field, its cards and its research boxes put the
      // pending line in with the question. A Build's card in place of that pending line (2026-10-13: a "yes" Bart sent to
      // Build with the spec above, DocEditor handOff) is its answer, and the question a turn of the thread as well. A
      // research box goes on with it before it is asked (2026-10-15): the direction a Refine settled waits there to be started.
      if (!turn.answered || turn.build || i + 1 >= lines.length || ps[i + 1].type !== 'bart' || !followsIn(ps[i + 1], ps[thread.from], thread)) break;
      if (!isResearch(ps[i + 1]) && !(ps[i + 2] && (ps[i + 2].type === 'pending' || ps[i + 2].type === 'reply' || ps[i + 2].type === 'build'))) break;
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

/**
 * A document written before the router (2026-10-12): every `@bart` line that was answered as a question (a `bart>`,
 * `bart+>`, `bart?>` or `bart~>` line right under it) asked the agent now called Chat, so it is written `@chat`, its text
 * and flags as they were (`@Bart` from the @ menu becomes `@Chat`). An `@bart` line with a `build>` card under it was a
 * Build request and stays: the router sends it to Build too. Lines inside code blocks are code. Run again, it changes
 * nothing. → { text, count }: the document, and how many lines were rewritten.
 */
export function migrateChatLines(text) {
  const source = String(text ?? ''), lines = source.split('\n'), ps = parseLines(lines);
  // An `@bart` line whose thread's title line keeps Bart's pick (2026-10-12), or whose answer's closing line names the agent
  // that answered (2026-10-13), was routed, and stays as typed.
  const routed = new Set();
  for (const thread of threads(lines, ps)) {
    for (const turn of thread.turns) if (thread.routedTo || (turn.foot >= 0 && footAgent(ps[turn.foot].text))) routed.add(turn.q);
  }
  let count = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (ps[i].type !== 'bart' || ps[i].agent !== 'router' || routed.has(i)) continue;
    const under = ps[i + 1];
    if (under.type !== 'reply' && under.type !== 'pending') continue;
    lines[i] = lines[i].replace(/^@(b)art/i, (all, b) => (b === 'B' ? '@Chat' : '@chat'));
    count += 1;
  }
  return { text: count ? lines.join('\n') : source, count };
}

/** The fenced code blocks of an answer's text, in order, each as the code it holds (no fences). */
export function answerFences(answer) {
  const lines = String(answer ?? '').split('\n');
  return codeBlocks(lines).map((block) => lines.slice(block.open + 1, block.close).join('\n'));
}

// A mention that names nothing any more (MATH-60): the name as written, in grey, with nothing to click and no card; `why`
// is what the pointer resting on it says.
const goneHtml = (shown, why) => `<span title="${esc(why)}" style="color:#8f8f8f">@${esc(shown)}</span>`;
const MENTION_LOOK = 'color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9';
// A note trashed from its last workspace (MATH-58 follow-up, 2026-10-06): still there and still opened by a click, but grey,
// so the line shows it is in the trash.
const TRASHED_LOOK = 'color:#8f8f8f;font-weight:500;cursor:pointer;border-bottom:1px dotted #d9d9d9';
const trashedOf = (trashed, name, id) => typeof trashed === 'function' && trashed(name, id) === true;
// The name a library mention shows: its item's name now when `libName(id)` gives one, else the name it was written with.
// A name that is an address (an older page mention, 2026-10-17) shows as webLabel does.
const libShown = (name, id, libName) => { const now = typeof libName === 'function' ? libName(id) : undefined; return nameShown(typeof now === 'string' && now ? now : name); };
const nameShown = (name) => (isAddress(name) ? webLabel(name) : name);
// The glyph after the @ of a mention of a web page (2026-10-17): `opts.webKind(name, id)` says 'website' or 'git' for a
// page or a repository known by its address, anything else for the rest, which keep no glyph.
const webIcon = (opts, name, id) => { const kind = opts && typeof opts.webKind === 'function' ? opts.webKind(name, id) : null; return WEB_ICONS[kind] || ''; };
// A library mention's chip: blue and clickable as a mention is, `data-lib` holding the id. `libName(id)` (optional) is the
// item's name now, shown in place of the one saved; null when the library no longer holds it, which leaves the saved name
// in grey with nothing to click.
// A web page's has its glyph after the @ (webIcon), on one line as a file's chip is.
function libHtml(name, id, libName, trashed, opts) {
  if (typeof libName === 'function' && libName(id) === null) return goneHtml(nameShown(name), 'No longer in the library');
  const shown = libShown(name, id, libName), bin = trashedOf(trashed, shown, id), icon = webIcon(opts, name, id);
  return `<span data-mention="${esc(shown)}" data-lib="${esc(id)}"${bin ? ' title="In trash"' : ''} style="${bin ? TRASHED_LOOK : MENTION_LOOK}${icon ? ';white-space:nowrap' : ''}">@${icon}${esc(shown)}</span>`;
}
// A file mention's chip (MATH-22): the @, the file's kind glyph, its name; the pointer resting on it says `folder / path`.
// `data-folder` and `data-file` (the path, decoded) are what a click opens. `opts.fileState(folderId, rel)` is false when
// the file is no longer there, which leaves it grey, still clickable to be told so; `opts.libName(folderId)` the folder's
// name now, null when the library no longer holds the folder (grey, nothing to click). Either may answer undefined.
function fileHtml(tok, opts) {
  const f = fileMentionOf(tok);
  const folder = opts && typeof opts.libName === 'function' ? opts.libName(f.folderId) : undefined;
  if (folder === null) return goneHtml(f.name, 'Its folder is no longer in the library');
  const where = `${folder || 'folder'} / ${f.rel}`;
  const state = opts && typeof opts.fileState === 'function' ? opts.fileState(f.folderId, f.rel) : undefined;
  const kind = state && state.dir ? 'folder' : fileKindOf(f.rel), gone = state === false;
  return `<span data-mention="${esc(f.name)}" data-folder="${esc(f.folderId)}" data-file="${esc(f.rel)}"${gone ? ' data-missing="1"' : ''} title="${esc(gone ? `Not found: ${where}` : where)}" style="${gone ? 'color:#8f8f8f;font-weight:500;cursor:pointer;border-bottom:1px dotted #d9d9d9;text-decoration:line-through;text-decoration-color:#c9c9c9' : MENTION_LOOK};white-space:nowrap">@${FILE_ICONS[kind] || FILE_ICONS.file}${esc(f.name)}</span>`;
}
// A Zotero item's chip (MATH-65 build 2): the @, a book glyph, its title; `data-zotero` (its ref: its key, after
// g<groupID>: for a group's) is what a click opens.
function zoteroHtml(name, key) {
  return `<span data-mention="${esc(name)}" data-zotero="${esc(key)}" title="Zotero" style="${MENTION_LOOK};white-space:nowrap">@${ZOTERO_ICON}${esc(name)}</span>`;
}
// A mention by name, `@[Name]`. A chat's (chatMention) shows its word: Bart's is blue, a chat that is gone grey. Anything
// else is a note or a library item: `named(name)` (optional) is false when nothing goes by that name, which leaves it grey;
// `trashed(name)` true for a note in the trash, grey but still clickable.
// A mention by an address (`@[https://…]`, as the open page was mentioned before 2026-10-17) shows its host and path with
// the globe; one the library holds no page for is still the page's: `data-url`, which a click opens in the Stage.
function nameHtml(name, named, trashed, opts) {
  const chat = chatMention(name);
  if (chat && !chat.live) return goneHtml(chat.shown, 'This chat is gone');
  const address = !chat && isAddress(name);
  if (address && typeof named === 'function' && named(name) === false) {
    return `<span data-mention="${esc(name)}" data-url="${esc(name)}" title="${esc(name)}" style="${MENTION_LOOK};white-space:nowrap">@${WEB_ICONS.website}${esc(webLabel(name))}</span>`;
  }
  if (!chat && typeof named === 'function' && named(name) === false) return goneHtml(name, 'Not in the library');
  const bin = !chat && trashedOf(trashed, name, null), icon = chat ? '' : address ? webIcon(opts, name, null) || WEB_ICONS.website : webIcon(opts, name, null);
  return `<span data-mention="${esc(name)}"${bin ? ' title="In trash"' : ''} style="${bin ? TRASHED_LOOK : MENTION_LOOK}${icon ? ';white-space:nowrap' : ''}">@${icon}${esc(chat ? chat.shown : nameShown(name))}</span>`;
}

// A link's box (2026-10-12): 5px above and below its letters and 2px either side, so a click on its underline, in the gap
// between a wrapped link's lines or just past its last letter is on the link. The negative margin takes the padding back:
// the letters stand where they did, a wrapped link wraps where it did, and a link at a line's start or end does not move.
const LINK_LOOK = 'color:#0070f3;text-decoration:underline;text-underline-offset:3px;padding:5px 2px;margin:-5px -2px;border-radius:3px;cursor:pointer';
/** Whether an inline token draws as a link: `[title](url)`, a bare address, or bold around a link (an @discover guide's title). */
export function holdsLink(tok) {
  const s = String(tok ?? ''), inner = s.startsWith('**') && s.endsWith('**') && s.length > 4 ? s.slice(2, -2) : s;
  return inner.split(INLINE).some((part) => LINK_RE.test(part) || URL_RE.test(part));
}

/**
 * Rendered HTML for inline markup (bold, code, italic, @bart, @brainstorm and @discover, an older line's @orient,
 * @[mention], [link](url), bare urls, the [[build]] hammer). `opts.libName(id)`: a library mention's name now, or null when it is gone (libHtml).
 * `opts.named(name)`: false when a mention by name names nothing (nameHtml). `opts.trashed(name, id)`: true for a note in
 * the trash. Any may be left out, or answer undefined when it cannot tell: the mention is then drawn as written.
 * `opts.buildTurn`: in an answer line, its turn's question line, which a click on the hammer builds (buildIconHtml).
 */
// What a citation's lead-in is (inlineHtml): a colon or dash at the end of the text before it, with the space around it;
// never one inside a token (code, emphasis, a link, a mention).
const CITE_LEAD_RE = /\s*[:\u2013\u2014]\s*$/;
const CITE_LEAD_TOKEN = /^(?:\*|`|\[|@\[|!\[|\$)/;
export function inlineHtml(text, opts) {
  const parts = String(text).split(INLINE).filter(Boolean);
  // Chat's citations (./cite.js): numbered by `opts.cites` (the answer's, citationNumbers), else in the order this text
  // cites its sources; a run of three or more folds into its first circle and "…".
  let runs = null;
  if (parts.some((p) => citationOf(p))) {
    // A colon or dash right before a citation ('not just "the process": [cite]') reads as if the quote came next, and the
    // circle shows only a number: it is left out where the circle is drawn, the document keeping it (2026-10-22, David).
    for (let k = 0; k + 1 < parts.length; k += 1) {
      if (citationOf(parts[k + 1]) && !citationOf(parts[k]) && !CITE_LEAD_TOKEN.test(parts[k])) parts[k] = parts[k].replace(CITE_LEAD_RE, ' ');
    }
    runs = citationRuns(parts);
    if (!(opts && opts.cites)) opts = { ...(opts || {}), cites: citationNumbers(text) };
  }
  const html = parts.map((p) => {
    if (!p) return '';
    if (p === '\\$') return '$';
    if (isMathToken(p)) return mathTokenHtml(p);
    if (p === BUILD_TOKEN) return buildIconHtml(opts && opts.buildTurn);
    // A pasted image inside a todo or a chat line reads as [Attachment n]; on a line of its own it renders as the image.
    const attachment = p.match(ATTACH_RE);
    if (attachment) return `<span data-attachment="${esc(attachment[2])}" style="padding:1px 6px;border-radius:4px;background:#f2f2f2;border:1px solid #eaeaea;font:.86em/1.6 var(--font-mono);color:#4d4d4d;white-space:nowrap">[${esc(attachment[1] || 'Attachment')}]</span>`;
    // Bold may hold a link or a mention: `**[Title](url)**`, `**@[Name]**` (an @discover guide's titles, 2026-09-30).
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) return `<strong style="font-weight:600">${inlineHtml(p.slice(2, -2), opts)}</strong>`;
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) return `<code style="padding:1px 4px;border-radius:4px;background:#f2f2f2;font:.92em/1.6 var(--font-mono)">${esc(p.slice(1, -1))}</code>`;
    if (p.startsWith('*') && p.endsWith('*') && p.length > 2) return `<em>${esc(p.slice(1, -1))}</em>`;
    if (AGENT_TOKEN.test(p)) return `<span style="${AGENT_LOOK}">${esc(p)}</span>`;
    const ws = p.match(WS_MENTION_RE);
    if (ws) return `<span data-mention="${esc(ws[1])}" data-ws="${esc(ws[2])}" style="color:#0070f3;font-weight:500;cursor:pointer;border-bottom:1px dotted #c9c9c9;white-space:nowrap">@${WS_ICON}${esc(ws[1])}</span>`;
    const lib = p.match(LIB_MENTION_RE);
    if (lib) return libHtml(lib[1], lib[2], opts && opts.libName, opts && opts.trashed, opts);
    if (FILE_MENTION_RE.test(p)) return fileHtml(p, opts);
    const zotero = p.match(ZOTERO_MENTION_RE);
    if (zotero) return zoteroHtml(zotero[1], zotero[2]);
    const made = madeMentionOf(p);
    if (made) return `<span data-mention="${esc(made.name)}" data-made="${esc(madeKey(made))}" style="${MENTION_LOOK};white-space:nowrap">@${esc(made.name)}</span>`;
    if (p.startsWith('@[')) return nameHtml(p.slice(2, -1), opts && opts.named, opts && opts.trashed, opts);
    const cite = citationOf(p);
    if (cite) return citationHtml(cite, opts);
    const m = p.match(LINK_RE);
    if (m) return `<a href="${esc(m[2])}" data-link="1" style="${LINK_LOOK}">${esc(m[1])}</a>`;
    if (URL_RE.test(p)) return `<a href="${esc(p)}" data-link="1" style="${LINK_LOOK}">${esc(p)}</a>`;
    return esc(p);
  });
  if (!runs) return html.join('');
  return html.map((h, k) => {
    const r = runs[k];
    if (!r) return h;
    const open = r.role === 'first' ? `<span data-cite-run="1">${h}${citationMoreHtml(r.more)}<span data-cite-rest="1">` : h;
    return k === r.last ? `${open}</span></span>` : open;
  }).join('');
}

// A PDF margin note (MATH-21) is text as typed: only its library mentions are drawn, so a `*`, a backtick or an address in
// it shows as it did before notes could mention anything. Its pieces, text and mentions in turn, are the shown note's
// child nodes one for one (noteHtml), which is how a click in it finds its place in the text (noteOffset).
// @bart at the start of a note that can ask (MATH-27 follow-up, 2026-10-06) is drawn as the document draws it: blue, 500, in
// the document's font. With `opts.agents` it is a piece of its own (any space before it another), so the pieces still
// match the shown note's child nodes. The only agent a note asks is Bart (PaperView mentionList).
const LIB_SPLIT = /(@\[[^\]\n]+\]\(lib:[\w-]+(?::[\w.~%/-]+)?\))/;
// Since 2026-10-24 every agent's token is drawn so, where the document would draw it (agentTokens), not only a leading
// @bart: the field and the shown note alike. What a note asks is still a leading @bart's alone (pdf/canvas.js noteQuestion).
/** A note's pieces, each { text, agent }: an agent's token (with `opts.agents`) or a stretch of text and mentions. */
function noteSplit(text, opts) {
  const s = String(text ?? ''), out = [];
  const plain = (piece) => { for (const p of piece.split(LIB_SPLIT)) if (p) out.push({ text: p, agent: false }); };
  let at = 0;
  if (opts && opts.agents) for (const t of agentTokens(s)) { plain(s.slice(at, t.start)); out.push({ text: t.token, agent: true }); at = t.end; }
  plain(s.slice(at));
  return out;
}
export const noteParts = (text, opts) => noteSplit(text, opts).map((p) => p.text);
/**
 * An agent's name in a note, as the document's label (inlineHtml's AGENT_TOKEN): blue, weight 500, the document's font. The
 * note is in Caveat, and its field's caret goes by Caveat's widths, so the name keeps the width it has in Caveat (its own
 * text, transparent) and the label is drawn over it (aria-hidden, not selectable): the field and its backdrop wrap alike.
 */
export const agentLabelHtml = (token, size = '.75em') => `<span data-agent="${esc(token.slice(1).toLowerCase())}" style="position:relative;color:transparent">${esc(token)}<span aria-hidden="true" style="position:absolute;left:0;top:50%;transform:translateY(-50%);color:${AGENT_INK};font:500 ${size}/1 var(--font-sans);letter-spacing:normal;white-space:nowrap;user-select:none;pointer-events:none">${esc(token)}</span></span>`;
/**
 * A margin note as shown while it is not being edited: its text escaped, each library mention a chip (libHtml), and with
 * `opts.agents` each agent's token a label (agentLabelHtml).
 */
export function noteHtml(text, opts) {
  return noteSplit(text, opts).map(({ text: p, agent }) => {
    if (agent) return agentLabelHtml(p);
    const lib = p.match(LIB_MENTION_RE);
    if (FILE_MENTION_RE.test(p)) return fileHtml(p, opts);
    return lib ? libHtml(lib[1], lib[2], opts && opts.libName, undefined, opts) : esc(p);
  }).join('');
}
/**
 * A note's field's backdrop (2026-10-06): the field's text exactly as typed, library mentions included, in the note's own
 * ink, with each agent's token (agentTokens, as the document finds them: 2026-10-24, every agent's, not only a leading
 * @bart) a label `size` big. The field's own text is transparent over it, so the two wrap alike.
 */
export function agentInkHtml(text, size = '1em') {
  const s = String(text ?? '');
  let html = '', at = 0;
  for (const t of agentTokens(s)) { html += esc(s.slice(at, t.start)) + agentLabelHtml(t.token, size); at = t.end; }
  return html + esc(s.slice(at));
}
/** The pdf's (and a box's) Caveat note: its tokens labels in the document's font, .75em of Caveat's (agentLabelHtml). */
export const noteInkHtml = (text) => agentInkHtml(text, '.75em');
/** Where in a note's text a click lands: `offset` characters into its `part`-th piece; a mention's piece is passed whole. */
export function noteOffset(text, part, offset, opts) {
  const parts = noteParts(text, opts);
  let at = 0;
  for (let i = 0; i < Math.min(part, parts.length); i++) at += parts[i].length;
  if (part >= parts.length) return at;
  const p = parts[part];
  return at + (LIB_MENTION_RE.test(p) || FILE_MENTION_RE.test(p) ? p.length : Math.max(0, Math.min(p.length, Number(offset) || 0)));
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
  // Drawn math copies as its LaTeX, whole, unless the selection is within its source (shown on the caret's line).
  const { shown, pre, unit } = tokShown(tok); if (unit) return inside ? tok.slice(lo, hi) : tok;
  if (!pre) return tok.slice(lo, hi);
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
    if (tok === '\\$') return '$';
    if (isMathToken(tok)) return esc(tok); // math pastes as its LaTeX
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) return `<strong>${plainHtml(tok.slice(2, -2))}</strong>`;
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) return `<code>${esc(tok.slice(1, -1))}</code>`;
    if (tok.startsWith('*') && tok.endsWith('*') && tok.length > 2) return `<em>${esc(tok.slice(1, -1))}</em>`;
    const ws = tok.match(WS_MENTION_RE); if (ws) return esc(ws[1]);
    const lib = tok.match(LIB_MENTION_RE); if (lib) return esc(lib[1]);
    const file = tok.match(FILE_MENTION_RE); if (file) return esc(file[1]);
    const zotero = tok.match(ZOTERO_MENTION_RE); if (zotero) return esc(zotero[1]);
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
