// One markdown string per document, edited on a single contentEditable surface (Obsidian-style: the caret's
// line shows its source, every other line renders). Ported from design/goal-canvas/Goal Canvas.dc.html
// (state 458–466, listeners 492–512, document engine 678–983). Differences from the design:
//   * props.text is the source of truth; every edit calls props.onChange(text) synchronously.
//   * the `@[chat]` inline chat *panels* are gone; the line form is `@bart …` (2026-09-19), answered by a real agent:
//     Enter puts a pending line under the question and hands it to props.onAsk; the parent replaces that line with the
//     answer. The card is Claude Design's "Answer Card" (2026-09-21, design/goal-canvas/ANSWER-CARD.md): an answer is kept
//     as it arrives and its text can be edited; its foot holds Copy, Regenerate, which model said it, Collapse and Delete
//     as icons; a field at the bottom of the card asks a follow-up, which joins the same card.
//   * a picture pasted, or dropped into the document's text (MATH-19, 2026-10-05: where it was let go), is saved by the
//     parent and shown on a line of its own (pasteImages); anything else dropped in (a pdf, a link, a picture of another
//     format) goes to props.onDropItems, which makes it a library row of the workspace. `![alt](http…)` lines still render.
//   * clicking into a rendered (non-active) line maps the display offset through rawOffset(), so the caret
//     lands on the clicked character even inside bold/mention markup.
//   * fenced code blocks (2026-09-22): the lines between two fences are code, read with parseLines() (a `# x` in a block
//     is not a heading). Typing a fence and Enter closes it and puts the caret inside; in a block Enter keeps the line's
//     indent and Tab indents by two spaces.
//   * @brainstorm (2026-09-30) is an @bart line asked of another agent. An answer of its that is a card (main/bart/card.cjs:
//     a fenced JSON block) is drawn as one card in place of its lines, as a Build is drawn from its record; the lines
//     never take the caret. The last card of a card's thread is live: an answer (a row clicked, or the follow-up field
//     under it), or Skip on its foot, writes the answer as the next `@brainstorm …` line and asks it, as a follow-up is
//     asked. Earlier cards show what was picked. A live @brainstorm card's foot also has Wrap up, which asks for the recap
//     (round 6). Since 2026-10-13 a card is drawn as any answer is, its options a list of rows to click. @discover (2026-09-30)
//     asks its cards the same way, as `@discover …` lines, and answers with a reading guide drawn as an @bart answer is.
//     @orient (2026-10-04) went into @brainstorm on 2026-10-05: an older document's `@orient …` line stays as written and
//     is asked, drawn and answered as an @brainstorm line (model/doc.js agentOf).
//     Since 2026-10-14 an @brainstorm answers in prose and is drawn as Chat's answers are: its answer streams in, its foot
//     has Copy and Regenerate, and the follow-up field is under it (2026-10-16: no Reply). The cards, Skip, Wrap up, recaps and results below are
//     what older documents hold and the Welcome walkthrough's three cards, and are drawn as before.
//   * Send to Discover (MATH-31, 2026-10-05): after an older @brainstorm recap, on a row of its own above the follow-up
//     field, a field where the person writes what they want prior work on. Enter starts an @discover thread of its own on
//     those words after the thread. It replaced the searches the agents suggested (a card's lookFor, a recap's Look for
//     line); a Look for line in an older recap reads as text. Since the MATH-40 follow-up (2026-10-06) it is not under a
//     live card: an exchange sends on only from its finished result (the offer line, below).
//   * An @brainstorm result (MATH-40): the sentence the person wrote on the last card, then one small grey line whose
//     @discover and @bart start a thread of that agent's own on the sentence, after the thread (askResult).
//     Each paper's title line in a guide has a bookmark in its right margin that keeps the paper (2026-10-02, model/guide.js;
//     a quiet icon since 2026-10-03): outline, outline with +, or filled, from props.paperState; a click hands it to
//     props.onSavePaper. Drawn, never written: the line stays as it came. A **Try:** line in an older guide (2026-10-04 to
//     2026-10-15, its paper's repository) is drawn as any line with a link is.
//   * the follow-up field has the @ menu too (2026-10-02): `@` opens it under the field's caret and a pick writes the token
//     a document line would; Bart, Brainstorm, Discover and Note are left out, since the field already asks its agent.
//   * Edit (2026-10-03): an answered question's foot has Edit, which makes the question an ordinary agent line again, as it
//     stands, with its answer dimmed under it. Enter asks it again in place of that answer, as Regenerate does, and the turns
//     after it in its thread go; one undo brings all of it back. Escape, or the caret or a click going elsewhere, puts it back.
//   * where a document was scrolled to is kept per workspace (props.viewOf / props.onView, 2026-09-22), apart from the
//     caret: coming back to a document shows what was on screen, not where the last edit was.
//   * a note's or a workspace's mention clicked opens its document beside this one (MATH-23, props.onOpenBeside; Andy
//     Matuschak's working notes), and that mention stays marked (props.besideLink, props.besideWorkspace) while it is open
//     there; ⌘-click opens a note as a tab and goes to a workspace, as a click did before. An Escape the editor uses (the
//     caret leaving a line, its @ menu, the model selector or a mention's card, a field of its own) is marked as used
//     (preventDefault), so the window's Escape leaves it alone (Workspace.jsx).
import React from 'react';
import { createPortal } from 'react-dom';
import { HAMMER_PATHS } from '../model/hammer.js';
import { parseLine, parseLines, codeBlocks, todoLine, esc, tokShown, ATTACH_RE, mathBlockHtml, textMathHtml, tokensOf, rawOffset, replyRawOffset, inlineHtml, highlight, fenceShown, isFence, isCode, isAnswer, isMarked, lineText, sameLine, replyLine, titleLine, canonicalLine, retypedRow, listMark, threads, turnText, holdsLink, isResearch, researchText, isRefine, refineLine, isAddress, sameAddress, madeMentionOf, madeKey, chatMention, mentionAt, folderPath, folderMentionAt, agentOf, answeredBy, askedNow, flattenPaste, selectionMarkdown, selectionHtml, withLinks, INLINE, AGENT_TOKEN, ATTRIBUTION_RE, BART_RE, FENCE_RE, BUILD_TOKEN, tokenOf, topicOfThread, whenShown } from '../model/doc.js';
import { fieldRows, isVerbRow, isFolderRow, folderRows, firstPick, parentRel } from '../model/rail.js';
import { readFlags, readQuestion, readDiscover, withChoice, withMode, discoverSpans, modelOf, effortOf, buildRequestOf, EFFORT_LABELS } from '../../main/bart/question.cjs';
import { SKIPPED, MAP_GROUPS, isResultOffer, cardOfAnswer, questionOf, isChoice, answerLine, withWrap, readAnswer, recapLine, resultParts } from '../../main/bart/card.cjs';
// Phosphor's "shapes" (bold), MIT: its notice ships as dist/licenses/phosphor-icons.txt (scripts/build.mjs).
import SHAPES_SVG from '@phosphor-icons/core/assets/bold/shapes-bold.svg' with { type: 'text' };
import BartPicker from './BartPicker.jsx';
import AgentChoice from './AgentChoice.jsx';
import TopicMenu from './TopicMenu.jsx';
import { routeByRule, routeInputs, fallbackAgent, buildTextOf, questionLine } from '../model/route.js';
import DiscoverLevels, { LEVEL_LABELS } from './DiscoverLevels.jsx';
import { pdfText } from '../model/paste.js';
import MentionMenu from './MentionMenu.jsx';
import { fieldCaret } from './caret.js';
import Popover from './Popover.jsx';
import { citationNumbers, citationCard, openCitationRun, libraryName, CITE_CSS } from '../model/cite.js';
import MadePeek from './MadePeek.jsx';
import WorkspacePeek from './WorkspacePeek.jsx';
import ImageViewer from './ImageViewer.jsx';
import { diffRows, diffTotals, nextAttachment } from '../model/build-diff.js';
import { guideTitle } from '../model/guide.js';
import { guideSections, splitTarget, parseTable } from '../model/stage.js';
import { markdownBlocks, inlineRuns } from '../model/markdown.js';
import { carriesDrop, isPastable, readDrop } from '../model/drop.js';
import { mentionToken, isWebRow, menuItem, rowMention, carriesLibRows, readLibDrag } from '../model/mention.js';
import { isNote, kindKey } from '../model/kind.js';
import { AGENTS_PATH } from '../ui/SidebarIcons.jsx';
import { waveText, keepWaves } from '../ui/wave.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Bart is the router (2026-10-12): `@bart` picks Chat, Brainstorm, Discover, Create or Build for the line and steps aside. The
// question-answering agent (internally still 'bart') is `@chat`.
export const BART_ITEM = { id: 'bart', type: 'chat', name: 'bart', title: 'Bart', summary: 'Ask anything. Bart picks Chat, Brainstorm, Discover, Create or Build, then steps aside.', facts: 'picks, never answers' };
export const CHAT_ITEM = { id: 'chat', type: 'chat', name: 'chat', title: 'Chat', summary: 'Ask a question about this document, the project\'s code or the web. Add --opus or --high to pick the model or the effort by hand.', facts: 'reads, never edits' };
// A line of Brainstorm's reply that is its topic tag, or the start of one still arriving (2026-10-14).
const TOPIC_TAG_LINE = /^\s*<(?:t(?:o(?:p(?:i(?:c(?:>.*)?)?)?)?)?)?\s*$/;
// Discover's research line (2026-10-14; main's bart/ask.cjs takeResearch), whole or still arriving.
const RESEARCH_TAG_LINE = /^\s*<(?:r(?:e(?:s(?:e(?:a(?:r(?:c(?:h(?:>.*)?)?)?)?)?)?)?)?)?\s*$/;
export const DISCOVER_ITEM = { id: 'discover', type: 'chat', name: 'discover', title: 'Discover', summary: 'Find what to read about a problem, and where in it to look: it traces the citations of the papers in your library and the pages of the people you follow. Pick Quick, Standard or Deep on the line\'s chip.', facts: 'finds, never concludes' };
// @create (2026-10-13; main/bart/create.cjs): makes a new thing and keeps it in the library. It adds files, never changes one.
export const CREATE_ITEM = { id: 'create', type: 'chat', name: 'create', title: 'Create', summary: 'Makes a new file (a page, a chart, a document) under your line; Save puts the ones you want in your library.', facts: 'adds, never edits' };
export const BRAINSTORM_ITEM = { id: 'brainstorm', type: 'chat', name: 'brainstorm', title: 'Brainstorm', summary: 'Think something through out loud: a topic, a paper or what is on your mind. It follows where you take it, and you decide where that is.', facts: 'helps you think, never decides' };

// The page's column: it fits the pane, 65ch at most. The page has no zoom (Hudson, 2026-10-16, taking back the ⌘ + scroll
// and pinch zoom of 2026-10-14).
const DOC_COLUMN = { maxWidth: '65ch', paddingInline: 'clamp(0px, 3%, 24px)' };
const UNDER_BART = ['pending', 'reply'];
// The agents that run on one model of their own (no model chip, no selector on Regenerate) and may be asked with nothing
// after them: every one but @bart and @create (which runs on @bart's models, 2026-10-13). An @discover line's chip picks
// its level instead (2026-10-03). What their follow-up field says, and whether it may be sent empty.
const oneModel = (agent) => agent !== 'bart' && agent !== 'create';
// Who a collapsed conversation is with, said when its row is hovered (2026-10-12).
const AGENT_NAMES = { bart: CHAT_ITEM.title, brainstorm: BRAINSTORM_ITEM.title, discover: DISCOVER_ITEM.title, create: CREATE_ITEM.title };
// The ones of those on a fixed step (main/bart/models.cjs readBrainstorm): no flag is read or marked on their lines, their
// cards have no subtitle and have Wrap up, and their recaps are drawn as sections: @brainstorm. Since 2026-10-14 an
// @brainstorm answers in prose, as Chat does; its cards and recaps are those of older documents and the Welcome walkthrough.
const fixedStep = (agent) => agent === 'brainstorm';
// How a question line starts, as it was written: "@Chat" (the @ menu's) or "@chat" (typed), "@Discover" or "@discover".
// `agent` is the internal name; the line's word is its token (doc.js tokenOf: 'bart' is written @chat).
const leadOf = (line, agent) => { const token = tokenOf(agent); return (String(line).match(new RegExp(`^@${token}`, 'i')) || [`@${token}`])[0]; };
// The end of a closing line Bart routed (main/bart/reply.cjs attribution): " · via Bart", and " · build" when it read the
// line as a request to build.
const VIA_RE = /(?:^| · )via Bart( · build)?$/;
// A closing line since 2026-10-12 names the agent that answered first (main/bart/reply.cjs attribution): "Build" for a line
// Bart routed to be built.
const LEAD_RE = /^(Chat|Brainstorm|Discover|Create|Build)(?: · |$)/;
// How long a Deep research box's search waits before it is asked, its pending line offering Cancel (2026-10-13). A line
// Bart sent to Create waited too, until 2026-10-15 (David: no "Create · Starts in 5 s"; it starts at once).
export const RESEARCH_WAIT_S = 5;
// The runs Workspace keeps (`asks`, by id), as pure steps (2026-10-13). A run starting under an id the router held (a
// routed line, Workspace routeLine) keeps what that entry showed, the level the line was sent at (DocEditor routingLevel),
// until its first step's progress replaces it: the pending row is never a bare "Thinking" in between.
export const askStarted = (held, askId, entry) => ({ ...held, [askId]: { ...(held[askId] || {}), ...entry } });
// Progress on a run (main's bart/ask.cjs): a step beginning ({ step, name, effort, movedUp }) drops what the last step
// showed, its name and effort included (an @brainstorm step names none); what the agent is doing ({ activity }) is kept in
// `log` when it is a thing done; the answer so far ({ lines }); @discover's steps as its trace ({ trace }, main's
// bart/trace.cjs, 2026-10-15), whole each time.
export function askProgressed(ask, { log, ...progress }) {
  const next = { ...ask, ...progress };
  if (progress.step) { next.activity = ''; next.lines = []; next.name = progress.name || ''; next.effort = progress.effort || ''; next.trace = null; }
  if (log && progress.activity) next.log = [...(ask.log || []), progress.activity].slice(-60);
  return next;
}
// The agent a conversation is with, as its collapsed row names it: "Build" for an `@bart` line Bart read as one to build.
const agentName = (thread) => (thread.build && (thread.asked === 'router' || thread.turns.some((turn) => turn.build)) ? 'Build' : AGENT_NAMES[thread.agent] || AGENT_NAMES.bart);
// A turn as text (doc.js turnText) with the agent that answered it, when its lines say (doc.js turn.agent).
const withAgent = (said, turn) => (turn && turn.agent ? { ...said, agent: turn.agent } : said);
const FOLLOW = {
  // A conversation since 2026-10-14: what is typed is the next turn of it, so it needs words, as Chat's does.
  brainstorm: { placeholder: 'Respond…', label: 'Ask a follow-up', empty: false },
  discover: { placeholder: 'Respond…', label: 'Ask a follow-up', empty: false },
};
// A Build's state as its card names it (main/build/store.cjs STATUSES).
const BUILD_STATUS = { 'setting-up': 'Setting up', queued: 'Waiting for a slot', running: 'Working', 'needs-you': 'Needs you', review: 'Ready to review', stopped: 'Stopped', failed: 'Failed', escalated: 'Too big for a quick task', interrupted: 'Interrupted', accepting: 'Accepting', conflict: 'Conflict', accepted: 'Accepted', discarded: 'Discarded' };
const BUILD_WORKING = new Set(['setting-up', 'queued', 'running', 'accepting']);
// `@Note` (the @ menu's Note) and the name after it, to the end of the line.
const NOTE_VERB_RE = /(^|\s)@Note(?:\s+(.*))?$/;
// How far beside an answer's link, in px from its box, a press is still on it (nearLink, 2026-10-12).
const NEAR_LINK = 4;
// How long the pointer rests on a made file's name or icon before its peek shows (peekMade): passing over it shows nothing.
const PEEK_MS = 350;
// How tall a pending row's answer so far may grow before it scrolls in its box (2026-10-13), and how far above the box's
// bottom the person must scroll for it to stop following the newest line.
export const STREAM_CAP = 'min(240px, 35vh)';
const STREAM_SLACK = 40;
// A short fingerprint of a line (FNV-1a), so a remembered scroll position finds its line again without keeping its text.
const hashLine = (line) => { let h = 0x811c9dc5; const s = String(line ?? ''); for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const newAskId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// A follow-up's text with each [Attachment n] whose image was saved ([{ n, id }]) written as an image pasted on a line is:
// ![Attachment n](img:<id>). A token typed by hand, or one whose image did not save, stays as it was typed.
// An image line's alt text carries its width after a bar (`Attachment 1|w=320`), kept in the document so a resize stays.
const imgParts = (text) => { const m = /^(.*)\|w=(\d+)$/.exec(text || ''); return m ? { name: m[1], width: Number(m[2]) } : { name: text || '', width: 0 }; };
const withAttachments = (text, images) => {
  const ids = new Map(images.filter((image) => image.id).map((image) => [image.n, image.id]));
  return text.replace(/(?<!!)\[Attachment (\d+)\](?!\()/g, (token, n) => (ids.has(Number(n)) ? `![Attachment ${n}](img:${ids.get(Number(n))})` : token));
};
// The Zotero item's chip a drag of files is over (MATH-65 build 4), or null.
const zoteroChipFor = (e) => {
  const types = [...((e && e.dataTransfer && e.dataTransfer.types) || [])];
  return types.includes('Files') && e.target && e.target.closest ? e.target.closest('[data-zotero]') : null;
};
// The token a picked row of the @ menu writes, and a row of the sidebar dropped here: model/mention.js mentionToken.
// `pickedRow`: the library row picking it links to the workspace (a file's is its folder's); null for a Zotero item, which
// links nothing.
const pickedRow = (r) => (r.kind === 'entry' && r.zotero ? null : (r.kind === 'entry' || r.kind === 'self') && r.row ? { kind: 'item', key: r.row.id, row: r.row, name: r.row.name } : r);
// The mention token of `text` that ends at `at` (`before`) or starts there → [start, end], or null: the line's own
// tokens (doc.js INLINE), so a mention inside bold or a link's text is not one here.
const mentionBeside = (text, at, before) => {
  let acc = 0;
  for (const tok of text.split(INLINE)) {
    const end = acc + tok.length;
    if (tok.startsWith('@[') && (before ? end === at : acc === at)) return [acc, end];
    acc = end;
  }
  return null;
};
// A link ⌘-clicked (Ctrl-clicked off macOS, where Ctrl-click is the context menu) opens in a new Stage tab (2026-10-02).
const newTabClick = (e) => e.metaKey || (e.ctrlKey && !/^(darwin|mac)/i.test(document.documentElement.dataset.platform || navigator.platform || ''));

const RISE_CSS = '@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes made-spin{to{transform:rotate(360deg)}}';
// The hint on a document's last line while it is empty (2026-10-09, the Welcome walkthrough's "Write your thoughts…"):
// drawn by CSS where the line's <br> is, so it is never in the text and the caret stays put.
const cssString = (text) => `"${String(text).replace(/["\\]/g, '\\$&').replace(/[\n\r]+/g, ' ')}"`;
const emptyHintCss = (text) => `[data-editor][data-empty-hint]{position:relative}[data-editor][data-empty-hint] > div[data-line]:last-child > span.t:has(> br:only-child)::before{content:${cssString(text)};position:absolute;left:0;right:0;color:#b5b5b5;pointer-events:none;user-select:none}`;

// The answer card's controls. They are drawn as strings inside the editor, so what hover does lives here: an icon washes
// grey and turns ink (Delete turns red) and shows its name under it; the chip's border goes one grey darker, never ink.
// A conversation's Collapse, in its first open question's corner, is always shown (2026-10-15, David), not only on hover.
// It is the word, not an icon (2026-10-16, David), as is each later exchange's and a research box's.
const CARD_CSS = '.bart-ic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;color:#4d4d4d}'
  + '.bart-ic:hover{background:#f2f2f2;color:#171717}.bart-ic[data-danger]:hover{color:#e70022}.bart-ic:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.bart-tip{position:absolute;top:100%;z-index:5;margin-top:4px;padding:4px 7px;border:1px solid #eaeaea;border-radius:6px;background:#fff;color:#171717;font:12px/1.2 var(--font-sans);white-space:nowrap;pointer-events:none;opacity:0;visibility:hidden;transition:opacity 120ms}'
  + '.bart-ic:hover+.bart-tip,.bart-ic:focus-visible+.bart-tip{opacity:1;visibility:visible}[data-picking]>.bart-tip{display:none}'
  // A conversation's title (2026-10-12): collapsed, it is a link (2026-10-13, Hudson's): the Agents pointer and the title in
  // the link's blue, underlined once hovered; a click expands it, an ⌥-click renames it.
  + '.bart-thread{cursor:pointer}.bart-thread:hover>.bart-thread-name{text-decoration:underline}'
  + '.bart-link{cursor:pointer;color:#0070f3}.bart-link:hover .bart-thread-name{text-decoration:underline;text-underline-offset:3px}.bart-thread:hover+.bart-tip,.bart-thread:focus-visible+.bart-tip{opacity:1;visibility:visible}.bart-ic:disabled{cursor:default;opacity:.4}.bart-ic:disabled:hover{background:none;color:#4d4d4d}'
  + '.bart-chip{transition:border-color 120ms}.bart-chip:hover{border-color:#c9c9c9!important}.bart-send{transition:background 120ms}.bart-send:hover{opacity:.86}'
  + '.bart-fold{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;color:#8f8f8f;cursor:pointer}.bart-fold:hover{background:#f2f2f2;color:#171717}.bart-fold:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}.bart-fold:disabled{cursor:default;opacity:.4}.bart-fold:disabled:hover{background:none;color:#8f8f8f}'
  + '.bart-text{padding:4px 2px;border:0;background:transparent;color:#8f8f8f;font:500 12px/1.4 var(--font-sans);cursor:pointer}.bart-text:hover{color:#171717}'
  + '[data-follow-input]::placeholder,[data-discover-input]::placeholder{color:#8f8f8f;font-style:italic;font-size:14.5px}'
  // An @discover guide's bookmark (2026-10-03): faint until its title line is hovered, washed when it is; a saved one is ink
  // and still; one at work is what it was when clicked, at half strength.
  + '.paper-mark{position:absolute;top:1px;right:-4px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:none;color:#c9c9c9;cursor:pointer;transition:color 120ms,background 120ms}'
  + '[data-paper-line]:hover .paper-mark:not(:disabled){color:#4d4d4d}.paper-mark:not(:disabled):hover{background:#f2f2f2}'
  + '.paper-mark:disabled{cursor:default}.paper-mark[data-save="here"]{color:#4d4d4d}.paper-mark[data-busy]{opacity:.5}'
  + '.paper-mark:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  // @brainstorm's card (2026-10-13): its options are an answer's list, each row a button: blue when hovered or ticked,
  // its mark a tick once ticked; still and plain once the card is answered.
  + '.bs-row{display:flex;align-items:flex-start;width:100%;margin:0;padding:2px 0;border:0;border-radius:4px;background:none;text-align:left;font:inherit;color:inherit;cursor:pointer}'
  + '.bs-mark{flex:none;min-width:1.75em;padding-right:0.25em;box-sizing:border-box;color:#8f8f8f}.bs-label{flex:1;min-width:0}.bs-why{color:#8f8f8f}' // MARK_DRAWN's column
  + '.bs-row:not(:disabled):hover .bs-label,.bs-row[aria-checked="true"] .bs-label,.bs-row[aria-checked="true"] .bs-mark{color:#0070f3}'
  + '.bs-row:disabled{cursor:text}.bs-row:disabled[aria-checked="true"] .bs-label{color:#171717}.bs-row:disabled[aria-checked="true"] .bs-mark{color:#4d4d4d}'
  + '.bs-row:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  // @discover's choices (2026-10-14, David's mock): a bordered row each, a radio, the label over its reason; those picked
  // in blue (any number of them, 2026-10-16, David). Picked, they wait for Submit, beside the field for their own words.
  + '.dv-opts{display:flex;flex-direction:column;gap:8px}'
  + '.dv-opt{display:flex;align-items:flex-start;gap:12px;width:100%;margin:0;padding:10px 14px;box-sizing:border-box;border:1px solid #e3e3e3;border-radius:10px;background:#fff;text-align:left;font:inherit;color:inherit;cursor:pointer}'
  + '.dv-opt:not(:disabled):not([aria-checked="true"]):hover{border-color:#c4c4c4}.dv-opt:disabled{cursor:default}'
  // Picked, the row stays white and only its mark turns blue (2026-10-16, David: not the whole row filled). The mark is a
  // check mark, not a circle (2026-10-16, David): faint grey until the row is picked, then blue.
  + '.dv-opt:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.dv-check{flex:none;display:inline-flex;width:14px;height:14px;margin-top:3.5px;color:#d4d4d4;transition:color 120ms}.dv-check svg{display:block}'
  + '.dv-opt:not(:disabled):not([aria-checked="true"]):hover .dv-check{color:#a3a3a3}.dv-opt[aria-checked="true"] .dv-check{color:#0070f3}'
  + '.dv-label{display:block;font-size:15px;line-height:1.4;color:#171717}.dv-why{display:block;margin-top:2px;font-size:13px;line-height:1.4;color:#8f8f8f}'
  + '.dv-own{display:flex;align-items:center;gap:8px}'
  + '.dv-field{flex:1;min-width:0;display:flex;padding:4px 12px;border:1px solid #e3e3e3;border-radius:8px;background:#fff;cursor:text}.dv-field:focus-within{border-color:#c4c4c4}'
  + '.dv-field textarea{flex:1;min-width:0;display:block;height:24px;margin:0;padding:0;border:0;background:none;outline:none;resize:none;overflow:hidden;font:15px/24px var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text}'
  + '.dv-submit{flex:none;align-self:stretch;min-height:34px;padding:0 16px;border:0;border-radius:8px;font:500 14px/1 var(--font-sans);cursor:pointer}'
  // Another row of an answered choice, asked to be picked (2026-10-15, David): its outline dashed until the restart under
  // the rows is confirmed or cancelled.
  + '.dv-opt[data-repicking]{border:1px dashed #0070f3}.dv-opt[data-repicking] .dv-check{color:#0070f3}'
  + '.dv-confirm{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 14px;border:1px solid #e3e3e3;border-radius:10px;background:#fff}'
  + '.dv-confirm-text{flex:1 1 220px;min-width:0;font-size:14px;line-height:1.45;color:#525252}.dv-confirm-text b{font-weight:500;color:#171717}'
  + '.dv-confirm-btns{flex:none;display:flex;gap:8px;margin-left:auto}'
  + '.dv-confirm button{height:30px;padding:0 12px;border-radius:7px;font:500 13.5px/1 var(--font-sans);cursor:pointer}'
  + '.dv-cancel{border:1px solid #e3e3e3;background:#fff;color:#262626}.dv-cancel:hover{border-color:#c4c4c4}'
  + '.dv-restart{border:0;background:#0070f3;color:#fff}.dv-restart:hover{background:#0062d6}'
  // The answer under a question being edited (2026-10-03): its contents faded, its card's grey as it was.
  + '[data-dim]>*{opacity:.45}'
  // Near the bottom of the window a name goes above its icon instead (editorOver sets the mark).
  + '[data-tip-up]>.bart-tip{top:auto;bottom:100%;margin-top:0;margin-bottom:4px}'
  // The mention whose note is open in the pane beside (MATH-23, markBeside).
  + '[data-mention][data-beside]{background:#e8f0fe;border-radius:3px}'
  // A Zotero item's chip while a free copy of its paper is looked for (MATH-65 build 3, markFinding).
  + '[data-zotero][data-finding]::after{content:" · Finding a free copy…";color:#8f8f8f;font-style:italic}'
  // Build 4: opened in the browser, its pdf waited for in the Downloads folder (said in a label under the chip, as .bart-tip
  // is drawn, since beside it went unseen: David, 2026-10-07); and a file dragged over it.
  + '[data-zotero][data-waiting]{position:relative}'
  + '[data-zotero][data-waiting]::after{content:"Download the PDF in your browser to open it in the Stage";position:absolute;left:0;top:100%;z-index:5;margin-top:4px;padding:4px 7px;border:1px solid #eaeaea;border-radius:6px;background:#fff;color:#4d4d4d;font:12px/1.2 var(--font-sans);font-style:normal;white-space:nowrap;pointer-events:none}'
  + '[data-zotero][data-drop]{background:#e8f0fe;border-radius:3px;box-shadow:0 0 0 1px #9bb6e8}'
  // The middle panel's threads (2026-10-13, Hudson's screenshot): an answer's inline code, the button row's Run again, a long
  // answer's fade and its Show more, and an earlier exchange folded to one line.
  + '[data-answer-of] code{font:13.5px/1.5 var(--font-mono)!important;background:#efefef!important;padding:1px 4px!important;border-radius:4px!important}'
  + '.bart-reply{display:inline-flex;align-items:center;height:28px;padding:0 10px;border:1px solid #e6e6e6;border-radius:6px;background:#fff;color:#4d4d4d;font:12.5px/1 var(--font-sans);cursor:pointer;transition:border-color 120ms}.bart-reply:hover{border-color:#c9c9c9;color:#171717}'
  + '.bart-more{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:#4d4d4d;font:500 13px/1.6 var(--font-sans);cursor:pointer}.bart-more:hover{color:#171717}'
  + '[data-more][data-cut]::before{content:"";position:absolute;left:18px;right:16px;bottom:100%;height:56px;background:linear-gradient(rgba(250,250,250,0),#fafafa);pointer-events:none}'
  + '[data-folded-row]:hover .t{color:#4d4d4d}'
  // @create's row (2026-10-14, the boards): the file's name a blue link, Save a white bordered button, Saved grey words.
  + '.made-name{color:#0070f3;cursor:pointer;text-decoration:none}.made-name:hover{text-decoration:underline;text-underline-offset:3px}'
  + '.made-btn{flex:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid #e3e3e3;border-radius:6px;background:#fff;color:#262626;font:13px/1 var(--font-sans);cursor:pointer;transition:border-color 120ms}.made-btn:hover{border-color:#c9c9c9}.made-btn:disabled{cursor:default;opacity:.6}'
  + '.made-saved{flex:none;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 2px 0 6px;color:#8f8f8f;font:13px/1 var(--font-sans)}'
  + '.made-frame img{display:block;width:100%;height:auto}.made-frame table{border-collapse:collapse;font:13px/1.5 var(--font-sans)}.made-frame td,.made-frame th{padding:4px 10px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}'
  + '.made-peek-body img{height:100%;object-fit:contain}.made-peek-body>:not(img){zoom:.82}' // the smaller peek's text, smaller too
  // A page's picture (2026-10-15, David: a sliver): the top of the page across the peek's width, not all of it squeezed in.
  + '.made-peek-body img.made-page{height:auto;object-fit:initial}'
  // An @bart answer (2026-10-15, David's reference): its icons (15px in 26px, grey until hovered); the fold's toggle; the
  // reply line, plain until it is focused or holds text.
  + '.chat-ic{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;color:#a3a3a3}.chat-ic svg{width:15px;height:15px}.chat-ic:hover{color:#4d4d4d}.chat-ic:disabled{cursor:default;opacity:.4}.chat-ic:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.chat-ic:hover+.bart-tip,.chat-ic:focus-visible+.bart-tip{opacity:1;visibility:visible}'
  + '.bart-level:hover{color:#4d4d4d!important}'
  + '[data-armed]{box-shadow:inset 0 0 0 9999px rgba(0,112,243,.09)!important}' // a conversation marked to be taken away
  + '[data-chat-more][data-cut]::before{left:20px;right:18px;height:46px}'
  + '.chat-more{display:inline-flex;align-items:center;gap:4px;padding:0;border:0;background:none;color:#6b6b6b;font:500 13.5px/1.4 var(--font-sans);cursor:pointer}.chat-more:hover{color:#171717}'
  + '.chat-field{display:flex;align-items:flex-end;gap:8px;margin:-9px -9px -9px -11px;padding:8px 8px 8px 10px;border:1px solid transparent;border-radius:9px;transition:background 120ms,border-color 120ms}'
  + '.chat-field:focus-within,.chat-field[data-typed]{background:#fff;border-color:#e3e3e3}.chat-field:not(:focus-within):not([data-typed]) [data-chip]{visibility:hidden}'
  + '.chat-field textarea::placeholder{color:#a3a3a3;font-style:normal;font-size:14.5px}.chat-field .bart-chip{height:24px!important;font-size:12.5px!important;color:#6b6b6b!important}'
  + '.chat-line:has(.chat-field:focus-within),.chat-line:has(.chat-field[data-typed]){border-top-color:transparent!important}';
// A Zotero chip's hover text while its paper's download is waited for (MATH-65 build 4).
const WAITING_TIP = "Opened in your browser. Download the PDF and it'll open here.";
// Lucide's drawings at the design's weight: 16px, 1.5px stroke, round caps.
// A map card's three lists (main/bart/card.cjs `map`).
const MAP_LABELS = { settled: 'Seems settled', open: 'Seems open', untouched: 'Not touched yet' };
const icon = (paths, size = 16, width = 1.5, caps = 'round') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="${caps}" stroke-linejoin="${caps === 'round' ? 'round' : 'miter'}" aria-hidden="true">${paths}</svg>`;
// An @discover choice's mark (2026-10-16, David: a check mark in place of the circle).
const DV_CHECK = icon('<path d="M20 6 9 17l-5-5"></path>', 14, 2.25);
const ICON = {
  // The sidebar's Agents pointer (ui/SidebarIcons.jsx), the one icon a collapsed conversation shows (2026-10-13).
  agents: icon(`<path d="${AGENTS_PATH}"></path>`, 16, 1.75),
  copy: icon('<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'),
  regenerate: icon('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path>'),
  edit: icon('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path>'),
  // Build (2026-10-12): Lucide's hammer.
  hammer: icon(HAMMER_PATHS),
  chevronRight: icon('<path d="m9 18 6-6-6-6"></path>'),
  // A folded exchange's row (2026-10-13): Lucide's chevron-right at 14px; a collapsed conversation's mouse-pointer-2 at 15px.
  folded: icon('<path d="m9 18 6-6-6-6"></path>', 14, 1.75),
  // An open exchange's Collapse, at the top right of its question (2026-10-15): Lucide's chevron-down, its folded row's turned.
  open: icon('<path d="m6 9 6 6 6-6"></path>', 16, 1.75),
  pointer: icon(`<path d="${AGENTS_PATH}"></path>`, 15, 1.75),
  trash: icon('<path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>'),
  chevron: `<span style="display:inline-flex;color:#8f8f8f">${icon('<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span>`,
  send: icon('<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>', 13, 2.2),
  sendBox: icon('<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>', 14, 2.2),
  // A research box's head (2026-10-13): Lucide's search.
  search: icon('<circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path>', 14, 2),
  discoverOut: icon('<path d="M7 17 17 7"></path><path d="M8 7h9v9"></path>', 12, 2),
  // The steps toggle: a plain angle with square ends (Hudson's reference, 2026-09-21), pointing up while the list is open.
  stepsOpen: icon('<path d="m5 15.5 7-7 7 7"></path>', 10, 3, 'square'),
  stepsShut: icon('<path d="m5 8.5 7 7 7-7"></path>', 10, 3, 'square'),
};
// An @discover guide's bookmark by where its paper is (2026-10-03): its drawing and the words its title and label carry.
const BOOKMARK = '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>';
const PAPER_MARK = {
  none: { icon: icon(BOOKMARK), words: 'Save to library and this project' },
  lib: { icon: icon(`${BOOKMARK}<path d="M12 7v6"></path><path d="M9 10h6"></path>`), words: 'Add to this project (already in the library)' },
  here: { icon: icon(BOOKMARK.replace('<path ', '<path fill="currentColor" ')), words: 'Saved in this project' },
};
// Filled, it can be clicked to take the paper off this project (2026-10-16, David: unbookmark), where onUnsavePaper is given.
const UNSAVE_WORDS = 'Remove from this project (it stays in the library)';
// A conversation at work, and one collapsed to its title's row (2026-10-12): never both, so a run's progress stays in view.
// A turn answered by a Build's card (2026-10-13, doc.js turn.build) is at work until its Build is finished (accepted,
// discarded, failed or stopped); one whose record is not loaded (`builds`, props.builds) counts as at work.
const BUILD_DONE = new Set(['accepted', 'discarded', 'failed', 'stopped']);
const buildDone = (task) => !!task && (!!task.final || BUILD_DONE.has(task.status));
const isRunning = (thread, builds) => thread.turns.some((turn) => turn.pending || (turn.build && !buildDone(builds && builds[turn.build])));
// Whether an exchange's Collapse is in its question's corner (2026-10-15): answered, at rest, and not a research box (whose
// question is its own row, with its own Collapse on its foot).
const cornered = (turn, box) => !!turn && turn.answered && !turn.pending && !turn.folded && !box;
// A Build still at work in a conversation (its card is its answer): such a conversation stays open. A conversation whose
// question is still being answered otherwise collapses as any does (2026-10-15, David: a Create run could not be).
const isBuilding = (thread, builds) => thread.turns.some((turn) => turn.build && !buildDone(builds && builds[turn.build]));
const isCollapsed = (thread, builds) => thread.titleLine >= 0 && thread.folded && !isBuilding(thread, builds);
// `ls` with the answers of `turns` collapsed or expanded (`to`), as a turn's own Collapse does it: on each of its reply
// lines (`bart+>`). Turns not answered, or at work, are left as they are.
const foldTurns = (ls, turns, to = true) => {
  const under = (j) => turns.some((turn) => turn.answered && !turn.pending && j >= turn.from && j <= turn.to);
  return ls.map((l, j) => { if (!under(j)) return l; const p = parseLine(l); return p.type === 'reply' && p.folded !== to ? replyLine(p.text, to).trimEnd() : l; });
};
// A turn asked under a conversation's `turns` (a follow-up, a card answered): the two newest stay open, it and the one
// before it, and any older are collapsed (2026-10-14, David: "If there is three turns auto collapse the first, otherwise
// keep it uncollapsed"). Until then every earlier turn collapsed. One already collapsed or expanded by hand older than
// those two is collapsed; the one before the new turn is left as it is.
const foldOlder = (ls, turns) => foldTurns(ls, turns.slice(0, -1));
// A conversation Discover started (its first line @discover, or Bart sent it there): nothing in it collapses by itself
// (2026-10-15, David). One that started with another agent folds as ever, even after a Discover turn.
const discoverThread = (thread) => thread.asked === 'discover' || thread.routedTo === 'discover' || (thread.turns[0] && thread.turns[0].agent === 'discover');
// @create's row (2026-10-14; main/bart/create.cjs). A file it made is a line of its answer, `@[name](made:<askId>/<path>)`,
// drawn as one row: a shapes icon, the name in blue (a click opens it in the Stage), then Save (or
// Saved) and a chevron that opens it inline in a frame the width of the document. While Create works, the same row says
// what it is making ("Creating a diagram"), what it is doing, how long it has taken, and Stop. What a file holds comes
// from props.madeFiles (Workspace, by madeKey): { name, type, ext, path, saved, url, previewUrl, text, missing, error }.
const MADE_NOUN = { svg: 'Diagram', html: 'Page', htm: 'Page', md: 'Document', markdown: 'Document', csv: 'Dataset', tsv: 'Dataset', json: 'Data', jsonl: 'Data', ndjson: 'Data', png: 'Image', jpg: 'Image', jpeg: 'Image', gif: 'Image', webp: 'Image', pdf: 'PDF', parquet: 'Data', xlsx: 'Spreadsheet', docx: 'Document' };
const extOf = (name) => (/\.([^./]+)$/.exec(String(name || '')) || ['', ''])[1].toLowerCase();
// A Markdown file that is one fenced block with a line or two around it is a script (Create's prompt: "a .md file holding
// the script in one fenced code block").
const isScript = (text) => { const ls = String(text || '').split('\n'), fences = ls.filter((l) => /^\s*```/.test(l)).length; return fences === 2 && ls.filter((l) => l.trim() && !/^\s*```/.test(l)).length > 0 && ls.slice(0, ls.findIndex((l) => /^\s*```/.test(l))).filter((l) => l.trim()).length <= 3; };
export const madeNoun = (name, file) => ((/^(md|markdown)$/.test(extOf(name)) && file && isScript(file.text)) ? 'Script' : MADE_NOUN[extOf(name)] || 'File');
// What Create is making, as its running row says it ("Creating a diagram"): the first of these words in what it said it is
// making, else in the request, else the kind of the file it is writing; else "Create". A format named with it stays
// (2026-10-14, David: "Creating an HTML page", not "Creating a page"), and "html" alone is a page.
const MAKING_WORDS = ['slide deck', 'slides', 'presentation', 'diagram', 'flowchart', 'chart', 'graph', 'plot', 'map', 'timeline', 'page', 'website', 'site', 'dashboard', 'document', 'report', 'essay', 'summary', 'outline', 'plan', 'list', 'table', 'dataset', 'spreadsheet', 'script', 'image', 'picture', 'poster', 'svg', 'csv', 'html'];
const MAKING_FORMATS = { html: 'HTML', markdown: 'Markdown', md: 'Markdown', json: 'JSON', pdf: 'PDF' };
export function makingLabel(said, request, writing) {
  for (const text of [said, request]) {
    const t = String(text || '').toLowerCase(); let best = null;
    for (const word of MAKING_WORDS) { const at = t.search(new RegExp(`\\b${word}\\b`)); if (at >= 0 && (!best || at < best.at)) best = { at, word }; }
    if (best) {
      const format = (/\b(html|markdown|md|json|pdf)\s+$/.exec(t.slice(0, best.at)) || [])[1];
      const word = best.word === 'svg' ? 'diagram' : best.word === 'csv' ? 'dataset' : best.word === 'html' ? 'HTML page' : format ? `${MAKING_FORMATS[format]} ${best.word}` : best.word;
      return /s$/.test(word) && word !== 'analysis' ? `Creating ${word}` : `Creating ${/^(?:[aeiou]|HTML)/.test(word) ? 'an' : 'a'} ${word}`;
    }
  }
  const noun = writing ? MADE_NOUN[extOf(writing)] : null;
  return noun ? `Creating ${/^[AEIOU]/.test(noun) ? 'an' : 'a'} ${noun.toLowerCase()}` : 'Create';
}
// A Create run's line as its running row says it (2026-10-15, David: "it should start with Creating a"): "A diagram of the
// highlighting, …." → "Creating a diagram of the highlighting, ……". The answer keeps the line as it came ("A diagram of …"),
// since by then it is made. An acronym's capital stays ("An HTML page" → "Creating an HTML page").
export function creatingLine(said) {
  const text = String(said || '').trim().replace(/[.…]+$/, '');
  if (!text) return '';
  if (/^creating\b/i.test(text)) return `${text}…`;
  const first = /^[A-Z](?:[a-z]|\s)/.test(text) ? `${text[0].toLowerCase()}${text.slice(1)}` : text;
  return `Creating ${first}…`;
}
// What a Create run is doing, as anyone looking at it reads it (2026-10-15, David: "interpretable from someone looking at it
// rather than random file names and text"): the kind of thing it reads or makes, never a file's name or path. `activity`:
// main's label (main/bart/activity.cjs); `kind`: what it is making ("diagram"; makingLabel's word, null when it names
// none); `wrote`: whether a file has been written yet, so its thinking is planning before and finishing after.
const CODE_EXT = /^(?:c?js|mjs|jsx|tsx?|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|cs|php|sh|css|scss|vue|svelte|sql|toml|ya?ml|json|jsonl)$/;
const MAKE_VERB = { Diagram: 'Drawing the diagram', Page: 'Building the page', Document: 'Writing the document', Dataset: 'Filling in the dataset', Data: 'Writing the data', Image: 'Drawing the image' };
export function createDoing(activity, kind, wrote) {
  const a = String(activity || '');
  const made = /^(Writing|Editing) (.+?)(?: · (\d+) KB)?$/.exec(a);
  if (made) {
    const noun = MADE_NOUN[extOf(made[2])];
    // The verb alone (2026-10-16, David): main's label may still end " · 9 KB", but how much is written is not shown.
    return made[1] === 'Editing' ? `Revising the ${(noun || 'file').toLowerCase()}` : MAKE_VERB[noun] || 'Writing the file';
  }
  const read = /^Reading (.+)$/.exec(a);
  if (read) {
    const what = read[1], ext = extOf(what);
    if (/^(?:md|markdown|txt)$/.test(ext)) return 'Reading your notes';
    if (ext === 'pdf') return 'Reading a paper';
    if (/^(?:png|jpe?g|gif|webp|svg)$/.test(ext)) return 'Looking at an image';
    if (CODE_EXT.test(ext) || ext === 'html') return 'Reading the code';
    if (!what.includes('/') && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(what)) return `Reading a page on ${what}`; // a web page, by its site
    return 'Reading a file';
  }
  if (/^Searching code\b/.test(a)) return 'Searching the code';
  if (/^Listing\b/.test(a)) return 'Looking through your files';
  if (/^Using\b|^Running\b/.test(a)) return 'Working';
  if (!a || /^(?:Thinking|Thinking harder|Writing)$/.test(a)) return wrote ? 'Finishing up' : kind ? `Planning the ${kind}` : 'Thinking it through';
  return a; // the web and papers searched for, saving to Engelbart: already in words
}
// The file a finished Create run opens in the Stage (2026-10-16, David: "it should open by itself"): the first made row of
// its answer (`out`, main's askBart result), the others left to their rows. Only for a run that answered (not stopped,
// not failed, a file kept), only while the person is still in the workspace it was asked in (`askedIn`, `here`; `active`
// false once the project is left), and once per run: `opened` holds the asks that opened theirs, and this adds `askId`.
// An answer already in the document, or one drawn again, never comes here. → { name, askId, rel } | null
export function madeToOpen(out, { askId, askedIn, here, active = true, opened = null } = {}) {
  if (!out || out.stopped || out.failed || !askId || (opened && opened.has(askId))) return null;
  if (!active || !askedIn || askedIn !== here) return null;
  for (const line of out.lines || []) {
    const made = madeMentionOf(String(line).replace(/^bart>\s?/, ''));
    if (made) { if (opened) opened.add(askId); return made; }
  }
  return null;
}
// m:ss since `at`.
const clockOf = (at, now = Date.now()) => { const s = Math.max(0, Math.floor((now - (at || now)) / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const MADE_ICON = {
  folderPlus: icon('<path d="M12 10v6"></path><path d="M9 13h6"></path><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>', 15),
  check: icon('<path d="M20 6 9 17l-5-5"></path>', 14, 2),
  down: icon('<path d="m6 9 6 6 6-6"></path>', 16, 1.75),
  up: icon('<path d="m18 15-6-6-6 6"></path>', 16, 1.75),
  stage: icon('<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M15 3v18"></path>', 15),
  doc: icon('<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path><path d="M10 9H8"></path><path d="M16 13H8"></path><path d="M16 17H8"></path>', 15),
  table: icon('<rect width="18" height="18" x="3" y="3" rx="2"></rect><path d="M3 9h18"></path><path d="M3 15h18"></path><path d="M9 3v18"></path>', 15),
  code: icon('<path d="m16 18 6-6-6-6"></path><path d="m8 6-6 6 6 6"></path>', 15),
  image: icon('<rect width="18" height="18" x="3" y="3" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"></path>', 15),
};
const madeGlyph = (noun) => (noun === 'Script' ? MADE_ICON.code : noun === 'Dataset' || noun === 'Data' || noun === 'Spreadsheet' ? MADE_ICON.table : noun === 'Image' || noun === 'Diagram' ? MADE_ICON.image : MADE_ICON.doc);
// A made file's icon: Phosphor's shapes (bold), 20px in #525252, with nothing behind it and the name 8px after it
// (2026-10-15, David: it was on a #f2f2f2 square, the name far from it).
const MADE_SQUARE = (bg = 'transparent') => `flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:32px;border-radius:8px;background:${bg};color:#525252`;
const SHAPES_ICON = SHAPES_SVG.replace('<svg ', '<svg width="20" height="20" aria-hidden="true" style="display:block" ');
// Text at work waves (../ui/wave.js waveText); every wave on the page's clock (keepWaves), exported for the tests.
export { keepWaves };
// @discover's steps by the part of the trace they are in (2026-10-15, David's mockup): a part done has a check, the one
// still going a grey ring; under each, what its steps found, the step still waiting darker. `writing`: the trace is over.
export function traceHtml(trace, { writing = false } = {}) {
  const groups = (trace && Array.isArray(trace.groups) ? trace.groups : []).filter((group) => group.lines && group.lines.length);
  const ring = '<span aria-hidden="true" style="display:block;width:12px;height:12px;box-sizing:border-box;border:1.5px solid #e1e1e1;border-top-color:#8f8f8f;border-radius:50%;animation:made-spin .8s linear infinite"></span>';
  return groups.map((group, n) => {
    const going = !writing && group.key === trace.latest;
    return `<div data-trace-group="${esc(group.key)}" data-going="${going}" style="margin-top:${n ? 10 : 0}px">`
      + `<div style="display:flex;align-items:center;gap:8px;color:#4d4d4d;font:500 13px/1.6 var(--font-sans)"><span style="flex:none;width:14px;height:14px;display:flex;align-items:center;justify-content:center">${going ? ring : MADE_ICON.check}</span>${esc(group.title)}</div>`
      + group.lines.map((line) => `<div style="padding-left:22px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${line.now ? '#171717' : '#8f8f8f'}">${esc(line.text)}</div>`).join('')
      + '</div>';
  }).join('');
}
// A Markdown file shown in its frame: blocks and runs read as data (model/markdown.js), every character escaped.
const runsHtml = (text) => inlineRuns(text).map((r) => (r.code ? `<code style="font:.92em var(--font-mono);background:#f2f2f2;padding:1px 4px;border-radius:4px">${esc(r.text)}</code>` : r.bold ? `<strong>${esc(r.text)}</strong>` : r.italic ? `<em>${esc(r.text)}</em>` : r.href ? `<span style="color:#0070f3">${esc(r.text)}</span>` : esc(r.text))).join('');
const mdFrameHtml = (text) => markdownBlocks(text).map((b) => (b.type === 'h' ? `<div style="font:600 ${[20, 17, 15, 15, 15, 15][b.level - 1]}px/1.4 var(--font-sans);margin:10px 0 4px">${runsHtml(b.text)}</div>`
  : b.type === 'li' ? `<div style="display:flex;gap:8px;padding-left:${b.depth * 18}px"><span style="color:#8f8f8f">${b.ordered ? esc(b.marker) : '•'}</span><span>${runsHtml(b.text)}</span></div>`
    : b.type === 'code' ? `<pre style="margin:8px 0;padding:10px 12px;background:#f5f5f5;border-radius:6px;font:12.5px/1.55 var(--font-mono);white-space:pre-wrap">${esc(b.text)}</pre>`
      : b.type === 'quote' ? `<div style="padding-left:12px;border-left:2px solid #dcdcdc;color:#4d4d4d">${runsHtml(b.text)}</div>`
        : b.type === 'hr' ? '<hr style="border:0;border-top:1px solid #eaeaea;margin:12px 0">' : `<p style="margin:6px 0">${runsHtml(b.text)}</p>`)).join('');
const radius = (top, closes) => `${top ? '10px 10px' : '0 0'} ${closes ? '10px 10px' : '0 0'}`;
// An answer's line, drawn (2026-10-16, Hudson): not a place to type, but its text selected and copied as before. Rows that
// already say whether they can be typed in (a card, a made file's row) keep what they say.
// Its line and source stay the tag's first attributes, as every row's are.
const unwritable = (html) => (/^<div\b[^>]*\scontenteditable="/.test(html) ? html : html.replace(/^(<div data-line="\d+" data-raw="[^"]*")/, '$1 contenteditable="false" data-readonly="1"').replace(/^(<div [^>]*style=")/, '$1user-select:text;-webkit-user-select:text;'));
// A flag the models file recognises is a little bolder than the text around it; a `--word` it does not know stays plain.
const FLAG_LOOK = 'font-weight:500';
// The middle panel's threads (2026-10-13): an answer's text is dark (#262626) in a rule 14px from it, and a long one is cut
// off (applyClips). A conversation's first answer is never cut; every later one starts cut at about CLIP_OLD lines, there
// when the document opened or just landed (2026-10-16, David). Measured in the answer's own lines, 16px at 1.65.
const ANSWER_LINE_PX = 16 * 1.65;
// An image's corners (2026-10-15, David: no drawn grip): each an unseen square a drag sizes the image from, its cursor
// saying so. [which corner, where, cursor]
const IMG_CORNERS = [['nw', 'left:0;top:0', 'nwse-resize'], ['ne', 'right:0;top:0', 'nesw-resize'], ['sw', 'left:0;bottom:0', 'nesw-resize'], ['se', 'right:0;bottom:0', 'nwse-resize']];
// An image dragged to another place in the document (2026-10-15, David: click, hold and drag it, in place of the zoom
// cursor). Where it may land: before line j, j from 0 to the end, unless that is inside a conversation (between its
// title or question and its last line) or inside a fenced code block. → Set of j.
export function imgDropGaps(ls, ps = parseLines(ls)) {
  const shut = new Set();
  for (const t of threads(ls, ps)) for (let j = (t.titleLine >= 0 ? t.titleLine : t.from) + 1; j <= t.to; j++) shut.add(j);
  for (const b of codeBlocks(ls)) for (let j = b.open + 1; j <= b.close; j++) shut.add(j);
  const out = new Set();
  for (let j = 0; j <= ls.length; j++) if (!shut.has(j)) out.add(j);
  return out;
}
// Line i moved to stand before line j (j as counted before the move); the same lines when that is where it is.
export function moveLineTo(ls, i, j) {
  if (j === i || j === i + 1 || i < 0 || i >= ls.length) return ls;
  const out = ls.filter((_, k) => k !== i);
  out.splice(j > i ? j - 1 : j, 0, ls[i]);
  return out;
}
const CLIP_OLD = 6;
// A Brainstorm conversation's "Topic: …" chip under its first question (topicChipHtml), hidden since 2026-10-16.
const TOPIC_CHIP_SHOWN = false;
// An @bart answer's line height (2026-10-15: 15px/1.55), and how many lines its fold must hide to be drawn.
const CHAT_LINE_PX = 15 * 1.55;
const CHAT_FOLD_LINES = 4;
// How long a question just asked is kept where it was on screen (keepAsked): its title and its routing land in that time.
const ASK_HOLD_MS = 3000;
// The clipboard's copy of a selection with whole conversations in it, as the document's lines (acrossSource).
const OWN_LINES = 'application/x-engelbart-lines';
const STEER_SPLIT = /\s+--steer\s+/i;
const LEVEL_FLAGS = /(^|\s)--(?:quick|standard|deep|claude|codex|chatgpt)(?=\s|$)/gi; // a level picked after a reply was added is written after it (withMode) // a research box's line: its direction, then what a reply under it added (steerResearch)
const CHAT_SHOW_LINES = 6; // what a folded @bart answer shows, at least its first paragraph (2026-10-15, David)
// What a line of an @bart answer is, as its spacing and its fold read it: 'blank', 'item', 'h' or 'p'; null if it is not an answer's line.
const chatKind = (raw) => {
  const r = parseLine(raw ?? ''); if (r.type !== 'reply') return null;
  if (!r.text.trim()) return 'blank';
  const q = parseLine(r.text); return isMarked(q.type) ? 'item' : q.type === 'h' ? 'h' : 'p';
};
// A code line of an @bart answer: the card's 18px and the answer's rule.
// An answer's line drawn read-only (2026-10-16, David: an answer is not edited): selectable, never typed in.
const readOnlyLine = (html) => (html.includes('data-readonly="1"') ? html : html.replace('<div ', '<div contenteditable="false" data-readonly="1" ').replace(/style="/, 'style="user-select:text;-webkit-user-select:text;').replace(/cursor:text/g, 'cursor:default'));
const chatCode = (html, at) => html.replace(/padding:(\d+)px 16px/, 'padding:$1px 18px').replace(/padding:([^;]*?) 14px;border-left:2px solid #d6d6d6/, 'padding:$1 12px;border-left:1.5px solid #e6e6e6').replace('<div ', at.older ? `<div data-chat-older="${at.turn.q}" ` : '<div ');
// The round send of a message box (2026-10-13): blue with a white arrow once there is something to send, grey until then.
const boxSend = (ready) => `background:${ready ? '#0070f3' : '#ececec'};color:${ready ? '#fff' : '#a3a3a3'}`;
// A message box (2026-10-13): one line on the cards' grey, no outline (David: the plain look, as before), growing as its
// text wraps with its controls kept bottom-right.
const MESSAGE_BOX = 'display:flex;align-items:flex-end;gap:8px;padding:9px 10px 9px 16px;border-radius:10px;background:#fafafa';
// An answer's bullet or number stands in a column of its own (MATH-69), as wide drawn as edited: the `•` or `10.` drawn,
// the `- ` or `10. ` faint while the caret is on the line, so its text starts at the same place either way. A mark wider
// than the column (`100.`, a todo's `- [ ] `) widens it, the drawn one by about the space the edited one has after it.
const MARK_COL = '1.75em';
const MARK_DRAWN = `flex:none;min-width:${MARK_COL};padding-right:0.25em;box-sizing:border-box`;
const MARK_EDITED = `display:inline-block;min-width:${MARK_COL};margin-left:-${MARK_COL};box-sizing:border-box;white-space:pre`;

export default class DocEditor extends React.Component {
  state = { lightbox: null, activeLine: null, mention: null, mentionIdx: 0, pop: null, picker: null, browse: null, topicMenu: null };
  edRef = React.createRef();
  history = []; future = []; caret = null; lastHtml = ''; lastKey = null; selRaw = null; openKey = ''; copied = null; copiedT = null;
  syncing = false; wantFocus = false; wantAnchor = false; composing = false; mounted = false; timers = new Set(); held = false; downOnRoot = false; downOnPage = false;
  openLogs = new Set(); // asks whose list of steps is open
  madeOpen = new Set(); // @create's files opened inline in their frame (madeKey); clock: the timer that moves running rows' m:ss
  clock = null;
  waits = new Map(); // Deep research searches counting down (waitResearch): askId → { ask, left, timer }
  streamFollow = new Map(); // askId → false while the person has scrolled up in its answer-so-far box (streamScrolled)
  pickerT = null;
  // A follow-up being typed, the model picked for it and the images pasted into it ([{ n, id }]), by the first line of its
  // card. None is in the document, and none is in the editor's HTML: the field keeps its text across redraws because it
  // is put back after each one.
  followText = new Map(); followChoice = new Map(); followImages = new Map();
  // What is being typed into a Send to Discover field (MATH-31), by the field's target (sendDiscoverHtml): put back after
  // each redraw as a follow-up's is (restoreDiscover).
  discoverText = new Map();
  // The Send to Discover fields opened from their button (2026-10-05), by target: the rest show only the button.
  discoverOpen = new Set();
  // What is ticked on a live select-all card, by its question's line: { picks }, drawn into the card's HTML. What is typed
  // to go with it is the follow-up field's (followText).
  cardState = new Map(); cardCache = new WeakMap(); collapseCache = new WeakMap();
  repick = null; // another row of an answered @discover choice, waiting for its restart to be confirmed (askRepick): { q, n }
  // The conversation title being renamed in its header (2026-10-12): { line, value }.
  titleEdit = null;
  // The threads whose Refine field is open, by first line (a reply field is always open, 2026-10-16). The answers that were in the document
  // when it opened (answerKey), for the document they were read in (seenDoc), and the answers opened past their cut.
  refineOpen = new Set(); replyFocus = null; replyWait = null; keyedAt = 0; seenDoc = {}; seenAnswers = new Set(); moreOpen = new Set();
  colRef = React.createRef(); // the page's column
  // A Build card's reply being typed (by Build id) and the images pasted into it ([{ n, id }]), which cards show their
  // earlier messages, their steps and their prompt, where each card's diff is scrolled to, and the HTML each part of each card was last
  // drawn with (patchBuilds compares these).
  buildText = new Map(); buildImages = new Map(); buildOpen = new Set(); buildSteps = new Set(); buildPrompt = new Set(); buildScroll = new Map(); buildDrawn = new Map();
  // A question just asked (2026-10-16, from 2026-10-13's follow-up hold): its row kept where it was on screen, or where its
  // reply field was, through the redraws that follow (keepAsked), { key, askId, top, until }. `wheelAt`: when the person
  // last scrolled the pane with the wheel (caretLineBelow, submitTop).
  askHold = null; wheelAt = 0; focusInto = null; armed = null; armedDrawn = false;
  // An @discover guide's papers being saved, by address: the button's state when it was clicked (it stays disabled on it).
  saving = new Map(); savingAll = new Set();
  // The question being edited in place (2026-10-03): { q, original, under, mark } — its line, what it held, the lines of
  // its answer (how it is found again when lines above it change) and how long undo was when it began. And, after edit
  // mode ended by putting the question back, the document as this editor reads it until the parent hands it back
  // ({ text, from }: while props.text is still `from`), so what the click that ended it does acts on the question as it was.
  editing = null; textNow = null;
  scrollRef = React.createRef();
  parsedCache = new WeakMap();
  // Where the open document was scrolled to: reported (onView) a moment after scrolling stops and whenever it is left;
  // put back (viewOf) when it opens, and again while images above it load, until the person scrolls.
  viewT = null; wantView = false; settle = null; resizeObs = null;

  /* ---------------------------------------------------------------- lifecycle */
  componentDidMount() {
    this.mounted = true;
    if (this.scrollRef.current && this.scrollRef.current.addEventListener) this.scrollRef.current.addEventListener('wheel', this.noZoom, { passive: false });
    this.autoCollapse();
    const inEd = (e) => e.target && e.target.closest && e.target.closest('[data-editor]') === this.editorEl();
    // The follow-up field is an <input> inside the editor: its keys and text are its own, not the document's. So is a
    // Build card's reply field.
    // And so are an @brainstorm card's fields, and a Send to Discover field.
    const inFollow = (e) => !!(e.target && e.target.matches && e.target.matches('[data-follow-input], [data-build-input], [data-discover-input], [data-title-input]'));
    const inTitle = (e) => !!(e.target && e.target.matches && e.target.matches('[data-title-input]'));
    const inBuild = (e) => !!(e.target && e.target.matches && e.target.matches('[data-build-input]'));
    const inDiscover = (e) => !!(e.target && e.target.matches && e.target.matches('[data-discover-input]'));
    const onPage = (e) => { const page = this.scrollRef.current; return !!(page && e.target && e.target.nodeType === 1 && page.contains(e.target) && !e.target.closest('input, textarea, select, [contenteditable="true"]')); };
    const inAsk = (e) => !!(e.target && e.target.matches && e.target.matches('[data-follow-input]')); // a follow-up's field alone
    this.docListeners = {
      keydown: (e) => { if (!inEd(e)) return; this.held = false; if (inTitle(e)) { this.titleKey(e); return; } if (this.escapeShut(e)) return; if (inBuild(e)) this.buildKey(e); else if (inDiscover(e)) this.discoverKey(e); else if (inFollow(e)) this.followKey(e); else this.editorKey(e); },
      input: (e) => { if (!inEd(e)) return; if (inTitle(e)) { this.titleInput(e.target); return; } if (inBuild(e)) this.buildInput(e.target); else if (inDiscover(e)) this.discoverInput(e.target); else if (inFollow(e)) this.followInput(e.target); else this.editorInput(); },
      beforeinput: (e) => { if (!inEd(e) || inFollow(e)) return; const sel = getSelection(); this.bulkDelete = /^delete/.test(e.inputType || '') && !!sel && !sel.isCollapsed; },
      paste: (e) => { if (!inEd(e)) return; if (inBuild(e)) this.buildPaste(e); else if (inAsk(e)) this.followPaste(e); else if (!inFollow(e)) this.editorPaste(e); if (inFollow(e)) this.fieldPaste(e); },
      // A copy or a cut of the document is its markdown (editorCopy); in a field of its own it is the browser's, as a paste is.
      copy: (e) => { if (inEd(e) && !inFollow(e)) this.editorCopy(e, false); },
      cut: (e) => { if (inEd(e) && !inFollow(e)) this.editorCopy(e, true); },
      // A press on one of the editor's buttons must not move the keyboard: leaving a line redraws the editor, and a button
      // redrawn between the press and the release never gets its click (found with Delete, while an answer was being edited).
      // A link or a mention is pressed to open it (2026-09-29): the press must not put the caret there, or the line would
      // redraw as its source and the click land on plain text (links in answers did nothing).
      // Where the press landed is kept for the click that follows it: a drag across lines ends in a click on what holds
      // both ends (the editor, or the page around it when released past it), and only a press there is a click there.
      // A press just beside a link in an answer (2026-10-12: on its underline, between a wrapped link's lines, past its last
      // letter) is a press on that link (nearLink), and the click that follows opens it.
      // A press that puts the caret is the mouse's (byMouse): the line it lands on, if an answer's, keeps its links drawn.
      // A press in the space under a card (gapAt) is kept for its click too. One on a heading's space above its text must not
      // put the caret in the heading: the click makes a line above it instead.
      mousedown: (e) => {
        this.disarm();
        // While a button is down the pane is not scrolled for the person (keepCaretLine), and an answer-so-far box being
        // dragged by its scrollbar is not replaced under the pointer (patchPending): it is, once the button comes up.
        this.pressed = true;
        const stream = e.target && e.target.closest ? e.target.closest('[data-stream]') : null; this.pressedStream = stream ? stream.dataset.stream : null;
        this.downOnPage = e.target === this.scrollRef.current;
        this.nearA = null; this.downGap = null;
        if (!inEd(e)) return;
        this.downOnRoot = e.target === this.editorEl();
        const grip = e.target.closest && e.target.closest('[data-imgsize]');
        if (grip && e.button === 0) { e.preventDefault(); this.startResize(e, grip); return; }
        const pic = e.target.closest && e.target.closest('[data-img]');
        if (pic && e.button === 0 && !this.props.readOnly) { e.preventDefault(); this.startImgDrag(e, pic); return; }
        if (e.target.closest('button[data-act], [data-build-icon][data-act], .bart-chip, a[data-link], [data-cite-more], [data-mention], [data-folded-row], .made-name, [data-made-folded]')) { e.preventDefault(); return; }
        this.downGap = e.button === 0 && !inFollow(e) ? this.gapAt(e.target, e.clientY) : null;
        if (this.downGap && !this.downOnRoot) { e.preventDefault(); return; }
        const near = e.button === 0 && !inFollow(e) ? this.nearLink(e.target, e.clientX, e.clientY) : null;
        if (near) { this.nearA = near; e.preventDefault(); return; }
        if (e.button === 0 && !inFollow(e)) { this.held = true; this.byMouse = true; }
      },
      // While the button is down a selection is only noted: redrawing the line under a drag (to show its source) lost the
      // highlight. The line becomes the caret's once the button comes up, after this click is handled.
      mouseup: () => {
        this.pressed = false;
        if (this.pressedStream != null) { this.pressedStream = null; this.timer(() => { if (this.mounted) this.patchPending(); }, 0); }
        if (!this.held) return; this.held = false; this.timer(() => this.onSel(), 0);
      },
      click: (e) => { if (inEd(e)) this.editorClick(e); },
      mouseover: (e) => { if (inEd(e)) this.editorOver(e); },
      mouseout: (e) => { if (inEd(e)) this.editorOut(e); },
      selectionchange: () => this.onSel(),
      // Nothing dropped in the editor is the browser's to place. A drop into one of its fields stays refused (2026-10-05).
      // The page around the text takes a drop too (2026-10-05: let go in the margin or below the last line, a picture
      // from Finder flew back): it goes in at the nearest place in the text (dropPoint). The page's own fields are theirs.
      // A row of the sidebar (2026-10-17) is taken by the document, the page around it and a follow-up's field, and by
      // nothing in a document that is read only or in another of its fields; it never reaches editorDrop (libDrop).
      dragover: (e) => {
        if (carriesLibRows(e)) {
          this.markDropChip(null);
          if (this.props.readOnly || !(inEd(e) || onPage(e)) || (inFollow(e) && !inAsk(e))) return;
          e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
          return;
        }
        if (inEd(e) || onPage(e)) e.preventDefault(); this.markDropChip(inEd(e) ? zoteroChipFor(e) : null);
      },
      dragleave: (e) => { if (this.dropChip && !(e.relatedTarget && this.dropChip.contains(e.relatedTarget))) this.markDropChip(null); },
      drop: (e) => {
        this.markDropChip(null); if (!inEd(e) && !onPage(e)) return; e.preventDefault();
        if (carriesLibRows(e)) { if (!inFollow(e) || inAsk(e)) this.libDrop(e, inAsk(e) ? e.target : null); return; }
        if (!inFollow(e)) this.editorDrop(e);
      },
      // Switching to another app blurs the page too; that is not leaving the line, and redrawing it would drop a selection.
      // Leaving it otherwise puts back a question being edited (2026-10-03).
      focusout: (e) => { if (inEd(e) && !(e.relatedTarget && this.editorEl() && this.editorEl().contains(e.relatedTarget))) this.disarm(); if (inEd(e) && inTitle(e) && document.hasFocus()) { if (!this.syncing) this.commitTitle(e.target); return; } if (inEd(e) && inAsk(e) && document.hasFocus()) this.leftReply(Number(e.target.dataset.followInput)); if (inEd(e) && document.hasFocus() && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-mention-menu]'))) { this.focusInto = e.relatedTarget && e.relatedTarget.matches && e.relatedTarget.matches('[data-follow-input]') ? { key: e.relatedTarget.dataset.followInput, a: 1e6, b: 1e6 } : null; if (this.focusInto) this.timer(() => { this.focusInto = null; }, 0); this.cancelEdit(); this.setState({ activeLine: null, mention: null }); } },
      compositionstart: () => { this.composing = true; },
      compositionend: (e) => { this.composing = false; if (inEd(e) && !inFollow(e)) this.editorInput(); },
    };
    Object.entries(this.docListeners).forEach(([k, f]) => document.addEventListener(k, f));
    document.addEventListener('scroll', this.buildScrolled, true); // a card's diff scrolls on its own; redraws put it back
    document.addEventListener('keydown', this.touched, true); // replyArrived
    document.addEventListener('scroll', this.streamScrolled, true); // so does an answer so far (placeStreams)
    window.addEventListener('resize', this.fitFollows);
    this.syncEditor();
    this.needMade();
    Promise.resolve().then(() => this.runClock());
    this.wantView = true; this.maybeRestoreView();
    if (typeof ResizeObserver === 'function' && this.editorEl()) {
      this.resizeObs = new ResizeObserver(() => { const s = this.settle; if (s && s.key === this.key() && Date.now() < s.until) this.applyView(s.pos); else if (this.askHold) this.keepAsked(this.editorEl()); });
      this.resizeObs.observe(this.editorEl());
    }
  }

  // The document on screen is about to be replaced by another: what it was scrolled to is reported first, while it is still there.
  getSnapshotBeforeUpdate(prevProps) {
    if (prevProps.docKey !== this.props.docKey && this.lastKey === prevProps.docKey) this.reportView(prevProps, true);
    return null;
  }

  // A Create run's m:ss moves once a second, on its row alone (patchPending), only while one is drawn: no timer otherwise.
  runClock() {
    const ed = this.editorEl(), running = !!(this.mounted && ed && typeof ed.querySelector === 'function' && ed.querySelector('[data-made-clock]'));
    if (running && !this.clock) {
      this.clock = setInterval(() => { if (!this.runClock()) return; this.patchPending(); }, 1000);
      if (this.clock && typeof this.clock.unref === 'function') this.clock.unref(); // under node (the tests), never what keeps it running
    }
    else if (!running && this.clock) { clearInterval(this.clock); this.clock = null; }
    return running;
  }

  componentDidUpdate(prevProps, prevState) {
    this.autoCollapse();
    Promise.resolve().then(() => this.runClock()); // once this update has drawn (or patched) the rows
    if (prevProps.text !== this.props.text || prevProps.madeFiles !== this.props.madeFiles || prevProps.docKey !== this.props.docKey) this.needMade();
    // The @ menu opening and closing (a line's or a follow-up field's): the workspace asks for what things say then (MATH-29).
    if (prevState && !prevState.mention !== !this.state.mention && this.props.onMentionOpen) this.props.onMentionOpen(!!this.state.mention);
    if (!this.state.mention && this.state.browse) this.setState({ browse: null }); // a folder opened in the menu closes with it (MATH-22)
    if (prevProps.docKey !== this.props.docKey) {
      this.dropEdit(prevProps);
      this.wantView = true; this.settle = null; this.askHold = null;
      this.history = []; this.future = []; this.caret = null; this.lastHtml = ''; this.lastKey = null; this.selRaw = null; this.openKey = '';
      const s = this.state;
      if (s.activeLine != null || s.mention || s.pop || s.picker) { this.setState({ activeLine: null, mention: null, pop: null, picker: null }); return; }
    }
    if (this.editing && prevProps.text !== this.props.text) this.trackEdit();
    // An answer arriving above the line being typed changes its index. The DOM still has the old indices here;
    // restore its caret on the same unchanged line, rather than inside the newly inserted answer. Local edits already
    // supplied their destination caret in setDoc and must not be shifted again.
    if (prevProps.docKey === this.props.docKey && prevProps.text !== this.props.text && !this.caret) {
      const ed = this.editorEl(), c = ed && document.activeElement === ed ? this.caretInfo() : null;
      // An answer landing in place of its pending row is syncEditor's (landing): it keeps the line where it was on screen too.
      if (c && !this.landing(ed, this.lines())) {
        const before = String(prevProps.text ?? '').split('\n'), after = this.lines();
        let head = 0, tail = 0;
        while (head < before.length && head < after.length && before[head] === after[head]) head++;
        while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
        const moved = (line) => line < head ? line : line >= before.length - tail ? line + after.length - before.length : null;
        const a = moved(c.anchor.line), b = moved(c.focus.line);
        if (a != null && a === b) {
          this.caret = { line: a, sel: [Math.min(c.anchor.offset, c.focus.offset), Math.max(c.anchor.offset, c.focus.offset)], back: c.focus.offset < c.anchor.offset };
          if (a !== this.state.activeLine) { this.setState({ activeLine: a, mention: null }); return; }
        }
      }
    }
    // Progress of a run arrives many times a second. It changes pending rows and Build cards only, and those are replaced
    // where they stand: the rest of the editor, the caret and a selection in it are not touched.
    const asked = prevProps.asks !== this.props.asks, built = prevProps.builds !== this.props.builds || prevProps.buildProgress !== this.props.buildProgress || prevProps.buildDiffs !== this.props.buildDiffs;
    const finished = prevProps.builds !== this.props.builds && prevProps.text === this.props.text && this.buildsDone(prevProps.builds) !== this.buildsDone(this.props.builds);
    // Builds first: each patch ends by redrawing the editor's HTML in memory, which is where the cards' parts are remembered.
    // A guide's paper buttons (paperState) are not patched: a change there redraws the editor.
    if ((asked || built) && !finished && prevProps.text === this.props.text && prevProps.docKey === this.props.docKey && prevProps.models === this.props.models && prevProps.paperState === this.props.paperState && prevProps.madeFiles === this.props.madeFiles && prevProps.madeOpen === this.props.madeOpen && (!built || this.patchBuilds()) && (!asked || this.patchPending())) { this.markBeside(); return; }
    this.syncEditor();
    this.focusReplyAfter();
    if (prevProps.text !== this.props.text) this.replyArrived();
    this.maybeRestoreView();
    this.markBeside();
  }

  componentWillUnmount() {
    if (this.state.mention && this.props.onMentionOpen) this.props.onMentionOpen(false);
    if (this.lastKey === this.key()) this.reportView(this.props, true);
    this.dropEdit(this.props);
    this.mounted = false; clearTimeout(this.pickerT); clearTimeout(this.peekT); clearTimeout(this.viewT); clearInterval(this.clock);
    if (this.scrollRef.current && this.scrollRef.current.removeEventListener) this.scrollRef.current.removeEventListener('wheel', this.noZoom);
    if (this.resizeObs) this.resizeObs.disconnect();
    window.removeEventListener('resize', this.fitFollows);
    Object.entries(this.docListeners || {}).forEach(([k, f]) => document.removeEventListener(k, f));
    document.removeEventListener('scroll', this.buildScrolled, true);
    document.removeEventListener('keydown', this.touched, true);
    document.removeEventListener('scroll', this.streamScrolled, true);
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
    // A Create counting down was going to be asked: it is, now, as the document is left (its answer lands in it all the same).
    for (const [, held] of this.waits) if (this.props.onAsk) this.props.onAsk(held.ask);
    this.waits.clear();
  }

  /* ---------------------------------------------------------------- public (via ref) */
  /** Put the caret at the start of the document (a freshly created note). */
  focusStart() { this.caret = { line: 0, offset: 0 }; this.wantFocus = true; this.setState({ activeLine: 0 }); }
  /** Put the caret at the end of the last line. */
  focusEnd() { this.docClickInternal(); }
  /** True while a line is being edited or the mention menu is open (the parent's Esc handler checks this). */
  isActive() { return this.state.activeLine != null || !!this.state.mention; }
  /** The window's Escape with the key elsewhere (MATH-23): the @ menu, the model selector or a mention's card, if one is
   * open, shuts. → whether one was */
  shutMenus() {
    if (this.cancelRepick()) return true;
    const s = this.state; if (!s.mention && !s.picker && !s.pop) return false;
    this.closePicker(); this.hidePop(); if (s.mention) this.setState({ mention: null }); return true;
  }
  // ⌘F in the middle canvas (2026-10-16, DocFind.jsx) searches the lines as drawn and paints its matches with CSS Custom
  // Highlights: nothing is written into the editor's DOM. Closing it gives the keyboard back here, on the match in front.
  /** What find searches: the lines, and the page that scrolls them. null before the editor is drawn. */
  findRoot() { const ed = this.editorEl(); return ed ? { root: ed, scroller: this.scrollRef.current } : null; }
  /** The caret where it is now ({ line, sel: [a, b] } in the line's source), for placeCaret; null when the document does
   * not have it or the selection runs over lines. */
  caretNow() { const c = this.caretInfo(); if (!c || c.anchor.line !== c.focus.line) return null; return { line: c.anchor.line, sel: [Math.min(c.anchor.offset, c.focus.offset), Math.max(c.anchor.offset, c.focus.offset)] }; }
  /** A range on the page (find's match in front) as a caret placeCaret takes: null when it is not in one line's text or
   * the line takes no caret (an answer, a Build). */
  caretOfRange(range) {
    if (!range) return null;
    const a = this.caretAt(range.startContainer, range.startOffset), b = this.caretAt(range.endContainer, range.endOffset);
    if (!a || !b || a.line !== b.line || this.lockedAt(this.lines(), a.line)) return null;
    return { line: a.line, sel: [Math.min(a.offset, b.offset), Math.max(a.offset, b.offset)] };
  }
  /** The keyboard back in the document with `c` selected (caretNow, caretOfRange), as a click would put it. → whether it went */
  placeCaret(c) {
    const ls = this.lines();
    if (this.props.readOnly || !c || ls[c.line] == null || this.lockedAt(ls, c.line)) return false;
    const end = lineText(this.parsedOf(ls)[c.line] || parseLine(ls[c.line]), ls[c.line]).length; // the line may have changed since
    this.caret = { line: c.line, sel: [Math.min(c.sel[0], end), Math.min(c.sel[1], end)] }; this.wantFocus = true;
    if (this.state.activeLine === c.line) this.forceUpdate(); else this.setState({ activeLine: c.line, mention: null });
    return true;
  }

  /* ---------------------------------------------------------------- the pane beside (MATH-23) */
  // The mentions whose document is open in the pane beside this one are marked, as the link clicked stays marked on Andy
  // Matuschak's notes: a note's by the mention's text, a workspace's by its id. On the page only, after each redraw, never
  // in the HTML the editor compares (lastHtml).
  markBeside() {
    const ed = this.editorEl(); if (!ed || !ed.querySelectorAll) return;
    const want = this.props.besideLink ? String(this.props.besideLink).toLowerCase() : null, ws = this.props.besideWorkspace || null;
    for (const m of ed.querySelectorAll('[data-mention]')) {
      const on = m.dataset.ws ? !!ws && m.dataset.ws === ws : m.dataset.file == null && m.dataset.zotero == null && !!want && String(m.dataset.mention).toLowerCase() === want;
      if (on !== m.hasAttribute('data-beside')) m.toggleAttribute('data-beside', on);
    }
    this.markFinding(); this.markArmed();
  }
  // A Zotero item's chips while main looks for a free copy of its paper (MATH-65 build 3; `zoteroFinding`, a Set of item
  // keys) say "Finding a free copy…"; while main waits for it in the Downloads folder (build 4, `zoteroWaiting`), a label
  // under them says to download it, with hover text saying why. On the page only, as markBeside's marks are.
  markFinding() {
    const ed = this.editorEl(); if (!ed || !ed.querySelectorAll) return;
    const finding = this.props.zoteroFinding, waiting = this.props.zoteroWaiting;
    for (const m of ed.querySelectorAll('[data-zotero]')) {
      const on = !!finding && finding.has(m.dataset.zotero);
      const wait = !on && !!waiting && waiting.has(m.dataset.zotero);
      if (on !== m.hasAttribute('data-finding')) m.toggleAttribute('data-finding', on);
      if (wait !== m.hasAttribute('data-waiting')) {
        m.toggleAttribute('data-waiting', wait);
        if (typeof m.setAttribute === 'function') m.setAttribute('title', wait ? WAITING_TIP : 'Zotero');
      }
    }
  }
  // A file dragged over a Zotero item's chip marks it (build 4): let go there, it becomes the item's pdf (editorDrop).
  markDropChip(chip) {
    if (this.dropChip && this.dropChip !== chip && this.dropChip.removeAttribute) this.dropChip.removeAttribute('data-drop');
    if (chip && chip !== this.dropChip) chip.setAttribute('data-drop', '');
    this.dropChip = chip || null;
  }
  // Escape with the model selector or a mention's card open shuts it, and that is all it does: it is marked as used, so the
  // window's Escape (leaving the document's full screen, closing the workspace) leaves it alone. → whether it did
  escapeShut(e) {
    if (e.key === 'Escape' && this.cancelRepick()) { e.preventDefault(); return true; }
    if (e.key !== 'Escape' || (!this.state.picker && !this.state.pop && !this.state.topicMenu)) return false;
    e.preventDefault(); this.closePicker(); this.hidePop(); this.closeTopic(); return true;
  }

  /* ---------------------------------------------------------------- where the document was scrolled to */
  // → { top, line, offset, hash }: the scroll offset, and the first line on screen with how far its top sits above the
  // pane's top edge and a hash of its text. The line is what is put back; `top` only when that line is gone.
  captureView() {
    const box = this.scrollRef.current, ed = this.editorEl(); if (!box || !ed) return null;
    const edge = box.getBoundingClientRect().top;
    for (const d of ed.children) {
      if (d.dataset.line == null) continue;
      const r = d.getBoundingClientRect(); if (!r.height || r.bottom <= edge + 1) continue;
      return { top: Math.round(box.scrollTop), line: Number(d.dataset.line), offset: Math.round(edge - r.top), hash: hashLine(d.dataset.raw || '') };
    }
    return { top: Math.round(box.scrollTop) };
  }
  reportView(props, now) {
    clearTimeout(this.viewT); this.viewT = null;
    if (!props.onView || !props.viewScope || !props.docKey) return;
    const position = this.captureView(); if (position) props.onView({ scope: props.viewScope, key: props.docKey, position, now: !!now });
  }
  maybeRestoreView() {
    if (!this.wantView || this.lastKey !== this.key() || !this.editorEl()) return;
    this.wantView = false;
    if (!this.props.viewOf) return;
    const pos = this.props.viewOf(this.props.viewScope, this.key());
    this.settle = pos ? { key: this.key(), pos, until: Date.now() + 4000 } : null; this.askHold = null;
    this.applyView(pos);
  }
  applyView(pos) {
    const box = this.scrollRef.current, ed = this.editorEl(); if (!box || !ed) return;
    if (!pos) { box.scrollTop = 0; return; }
    let i = null;
    if (Number.isInteger(pos.line)) {
      const ls = this.lines();
      i = pos.line < ls.length ? pos.line : null;
      // Lines were added or taken away above it (in another app, by an answer): the nearest line with the same text.
      if (pos.hash && (i == null || hashLine(ls[i]) !== pos.hash)) {
        for (let d = 0; d < ls.length; d++) {
          if (pos.line - d >= 0 && pos.line - d < ls.length && hashLine(ls[pos.line - d]) === pos.hash) { i = pos.line - d; break; }
          if (pos.line + d < ls.length && hashLine(ls[pos.line + d]) === pos.hash) { i = pos.line + d; break; }
        }
      }
    }
    const d = i == null ? null : ed.querySelector(`[data-line="${i}"]`);
    const r = d && d.getBoundingClientRect();
    if (r && r.height) box.scrollTop += r.top - box.getBoundingClientRect().top + (pos.offset || 0);
    else box.scrollTop = pos.top || 0;
  }
  onScroll = () => {
    // A popup placed against what has now moved would point at the wrong thing: the selector and the hover card close,
    // the @ menu follows the caret.
    if (this.state.picker) this.closePicker();
    if (this.state.pop) this.setState({ pop: null });
    if (this.state.mention) { const anchor = this.mentionAnchor(); if (anchor) this.setState((s) => (s.mention ? { mention: { ...s.mention, anchor } } : null)); }
    clearTimeout(this.viewT); this.viewT = setTimeout(() => { if (this.mounted && this.lastKey === this.key()) this.reportView(this.props, false); }, 300);
  };
  // The person scrolled, clicked or typed: what they do from now on wins over putting the old place back.
  stopSettling = () => { this.settle = null; this.askHold = null; };
  // While the person scrolls the pane, the line being typed on is not kept in place against them (caretLineBelow).
  paneWheel = () => { this.settle = null; this.askHold = null; this.wheelAt = Date.now(); };
  // A trackpad pinch reaches the page as a ⌃ wheel: it does nothing, rather than zoom the window or scroll the pane (the
  // page has no zoom since 2026-10-16). A native listener, since React's wheel listener is passive and could not stop it.
  noZoom = (e) => { if (e.ctrlKey) e.preventDefault(); };
  // The Agent Viewer's click (2026-10-12; Workspace revealAsk): line `i` brought to the middle of the pane and lit up for a
  // moment. Held there as a restored view is (`settle`), so a picture or card still laying itself out does not move it.
  // `flash: false` (a Build jumped to from the Agents dropdown or the Inbox, 2026-10-13) brings it there without the light.
  // → whether the line is drawn
  showLine(i, { flash = true } = {}) {
    const box = this.scrollRef.current, ed = this.editorEl(); if (!box || !ed) return false;
    // A line inside a collapsed conversation (a Build's card, 2026-10-13) is not on the page: the conversation is expanded
    // first, and the caller asks again once it is drawn (Workspace revealAsk). Opened on purpose, it is no longer waited
    // on by autoCollapse, which would fold it again when its Build's record arrives.
    const ls = this.lines();
    if (this.collapsedOf(ls).has(i)) {
      const thread = threads(ls, this.parsedOf(ls)).find((t) => t.titleLine >= 0 && t.folded && i >= t.from && i <= t.to);
      if (thread && !this.props.readOnly) {
        if (this.autoWait) thread.turns.forEach((turn) => turn.build && this.autoWait.ids.delete(turn.build));
        this.toggleThread(thread.titleLine);
      }
      return false;
    }
    const d = ed.querySelector(`[data-line="${i}"]`); if (!d) return false;
    const r = d.getBoundingClientRect(), b = box.getBoundingClientRect();
    const pos = { line: i, hash: hashLine(this.lines()[i] || ''), offset: -Math.max(0, Math.round((b.height - r.height) / 2)) };
    this.settle = { key: this.key(), pos, until: Date.now() + 1500 }; this.askHold = null;
    this.applyView(pos);
    if (flash) {
      d.removeAttribute('data-ask-flash'); void d.offsetWidth; d.setAttribute('data-ask-flash', '');
      setTimeout(() => { if (d.isConnected) d.removeAttribute('data-ask-flash'); }, 2400);
    }
    return true;
  }
  caretRect() {
    const sel = getSelection(); if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  // Where the @ menu hangs now: the document's caret, or the caret of the follow-up field it was opened in.
  mentionAnchor() {
    const m = this.state.mention; if (!m) return null;
    if (m.field == null) return this.caretRect();
    const input = this.followField(m.field); return input ? fieldCaret(input) : null;
  }

  /* ---------------------------------------------------------------- document access */
  key() { return this.props.docKey; }
  docText() {
    const now = this.textNow, text = String(this.props.text ?? '');
    if (now && now.from === text) return now.text;
    this.textNow = null; return text;
  }
  lines() { return this.docText().split('\n'); }
  // Document `key`'s lines as they are now (2026-10-16): this editor's when it shows it, else the workspace's copy
  // (props.docTextOf), so a run started here is handed on after the person went to another document. null: not known.
  // `props` are the ones the editor had when the run started, whose callbacks are that document's.
  linesOf(key, props = this.props) {
    if (this.mounted && key === this.props.docKey) return this.lines();
    const read = this.props.docTextOf || props.docTextOf, text = read ? read(key) : null;
    return typeof text === 'string' ? text.split('\n') : null;
  }
  // Its lines changed: as an edit here when it is shown (one undo step), else through that document's onChange.
  setLinesOf(key, props, fn) {
    if (this.mounted && key === this.props.docKey) { this.setLines(fn); return; }
    const ls = this.linesOf(key, props); if (ls) props.onChange(fn(ls).join('\n'));
  }
  // Each line read in place (a line inside a code block is code). Kept per array, so a loop over one array reads it once.
  parsedOf(ls) { let ps = this.parsedCache.get(ls); if (!ps) { ps = parseLines(ls); this.parsedCache.set(ls, ps); } return ps; }
  editorEl() { return this.edRef.current; }
  // Lines the person cannot type in: an @bart line once something stands under it, a run at work, the closing line of an
  // answer (it is the card's foot), an answer folded away, the lines of an @brainstorm card. Every line of an agent's answer
  // too (2026-10-16, Hudson: an answer is what the agent said, read and copied, not typed over; it was editable from
  // 2026-09-21): selected and copied, never typed in, deleted from or pasted over. A question can be, in edit mode
  // (2026-10-03), until Enter, Escape or the caret leaving it ends that. A `> ` quote was locked too, as the prototype's
  // replies were; since 2026-10-16 it is the person's own block quote, edited like any line (typing `>` used to lock the
  // line at once and send the caret to a new line under it).
  lockedAt(ls, i) {
    if (this.editing && this.editing.q === i) return false;
    const ps = this.parsedOf(ls), p = ps[i] || parseLine('');
    if (p.type === 'build' || p.type === 'title' || p.type === 'reply' || this.collapsedOf(ls).has(i)) return true;
    if (p.type === 'bart') return ls[i + 1] != null && UNDER_BART.includes(ps[i + 1].type);
    return isAnswer(p.type) && p.type !== 'quote';
  }
  // A card is closed by its foot, never by a line the caret can sit on: the document needs a line of its own after it.
  // So does a code block, or the caret below it would land on its closing fence and type into it.
  endsOnCard(ls) { const last = ls.length - 1; return this.lockedAt(ls, last) || ['reply', 'fence'].includes((this.parsedOf(ls)[last] || parseLine('')).type); }
  // The @brainstorm cards of a document (kept per array, as parsedOf is) → { byQ, lines }: by the line of the question each
  // answers, { card, turn, thread, last, live, answer }, where `last` is the card's last line before its foot, `live` that
  // it is the last turn of its thread (unfolded, in an editor that can ask), and `answer` what the line under it said
  // (main/bart/card.cjs readAnswer); `lines` holds every line a card is drawn over.
  // The lines a collapsed conversation hides (2026-10-12): every question and answer under its title, kept per array as
  // parsedOf is.
  // A conversation answered by a Build collapses once the Build is finished: what is kept is for the builds it was read with.
  collapsedOf(ls) {
    const builds = this.props.builds, kept = this.collapseCache.get(ls); if (kept && kept.builds === builds) return kept.held;
    const held = new Set();
    for (const thread of threads(ls, this.parsedOf(ls))) if (isCollapsed(thread, builds)) for (let i = thread.from; i <= thread.to; i++) held.add(i);
    this.collapseCache.set(ls, { builds, held }); return held;
  }
  // Which Builds that answer a turn are finished, as `builds` has them: a change here changes what is collapsed and what
  // may collapse, so the editor is drawn again rather than its cards patched.
  buildsDone(builds) {
    const ls = this.lines();
    return threads(ls, this.parsedOf(ls)).flatMap((thread) => thread.turns.filter((turn) => turn.build).map((turn) => (buildDone(builds && builds[turn.build]) ? 1 : 0))).join('');
  }
  cardsOf(ls) {
    let held = this.cardCache.get(ls); if (held) return held;
    held = { byQ: new Map(), lines: new Set() };
    const ps = this.parsedOf(ls), models = this.props.models;
    for (const thread of threads(ls, ps)) {
      thread.turns.forEach((turn, n) => {
        const agent = this.turnAgent(thread, turn);
        if (!oneModel(agent) || !turn.answered || turn.pending) return;
        const card = cardOfAnswer(turnText(ls, turn).answer); if (!card) return;
        const next = thread.turns[n + 1], said = next ? parseLine(ls[next.q]).text : null;
        const last = turn.foot >= 0 ? turn.foot - 1 : turn.to;
        held.byQ.set(turn.q, { agent, card, turn, thread, last, live: !next && !turn.folded && !!this.props.onAsk, answer: next ? readAnswer(models ? readFlags(said, models).rest : said, card) : null });
        for (let i = turn.from; i <= last; i++) held.lines.add(i);
      });
    }
    this.cardCache.set(ls, held); return held;
  }
  // Where each card of the document ends (2026-10-13), by line: the last line of the @bart conversation (title to last turn,
  // answered or at work), Build, code block or checklist that line is drawn in, or -1 for a line in none. Kept for the text
  // it was read from: lineHtml asks it for every heading.
  cardEnds() {
    const text = this.docText(); if (this.endsCache && this.endsCache.text === text) return this.endsCache.end;
    const ls = text.split('\n'), ps = this.parsedOf(ls), end = new Array(ls.length).fill(-1);
    for (let j = 0; j < ls.length; j++) {
      const p = ps[j];
      if (p.type === 'build' || p.type === 'pending') end[j] = j;
      else if ((p.type === 'code' || p.type === 'fence') && p.block) end[j] = p.block.close;
      else if (p.type === 'todo') { let k = j; while (k + 1 < ls.length && ps[k + 1].type === 'todo') k++; end.fill(k, j, k + 1); j = k; }
    }
    for (const t of threads(ls, ps)) if (t.to > t.from) end.fill(t.to, t.titleLine >= 0 ? t.titleLine : t.from, t.to + 1);
    this.endsCache = { text, end, ls, ps }; return end;
  }
  // The rows drawn just above and just below a height on the page (a click's clientY) → { above, below, level }: their
  // lines, -1 where there is none; `level`: a row spans that height (beside it, then, not between two). Rows not drawn (a
  // folded answer's, a collapsed conversation's) are passed over.
  rowsAround(y) {
    const ed = this.editorEl(), out = { above: -1, below: -1, level: false }; if (!ed || !ed.querySelectorAll || y == null) return out;
    for (const row of ed.querySelectorAll('[data-line]')) {
      const r = row.getBoundingClientRect(); if (!r.height) continue;
      if (r.bottom <= y) out.above = Number(row.dataset.line);
      else { if (r.top >= y) out.below = Number(row.dataset.line); else out.level = true; break; }
    }
    return out;
  }
  // A press in the space under a card (2026-10-13): between the last row of an answer, a run, a Build, a code block or a
  // checklist and whatever row comes under it. It lands on the editor itself (the card's bottom margin), or on the space
  // a heading right under a card has above its text (padding, not margin, so there is a row to land on). → { at, add }:
  // the line under the card the caret goes to, and whether that line is to be made (it is not when it is already empty),
  // or null for any other press, and in a document that cannot be written in.
  gapAt(target, y) {
    const ed = this.editorEl(); if (!ed || !target || y == null || this.props.readOnly) return null;
    const end = this.cardEnds(); let e = -1;
    if (target === ed) {
      const { above, below, level } = this.rowsAround(y); if (level || above < 0 || below < 0) return null;
      e = end[above]; if (e < 0 || below <= e) return null;
    } else {
      if (!target.matches || !target.matches('[data-line]') || !ed.contains(target)) return null;
      const i = Number(target.dataset.line), p = this.endsCache.ps[i], t = target.querySelector && target.querySelector('.t');
      if (!p || p.type !== 'h' || !t || i < 1 || end[i - 1] !== i - 1 || y >= t.getBoundingClientRect().top) return null;
      e = i - 1;
    }
    const { ls, ps } = this.endsCache, at = e + 1, next = ps[at];
    return { at, add: !(ls[at] === '' && next && next.type === 'p') };
  }
  // The caret on the line under a card, made first if it is not there: as the checklist's foot does (data-act="after"), one
  // step to undo.
  openGap(g) {
    if (g.add) this.setLines((x) => { const out = [...x]; out.splice(g.at, 0, ''); return out; });
    this.caret = { line: g.at, offset: 0 }; this.wantFocus = true;
    if (!g.add && this.state.activeLine === g.at) this.applyCaret(); else this.setState({ activeLine: g.at, mention: null });
  }
  timer(fn, ms) { const id = setTimeout(() => { this.timers.delete(id); if (this.mounted) fn(); }, ms); this.timers.add(id); return id; }

  // `undo` (2026-10-03): an edited question asked again is one step back to before it was edited, whatever was typed
  // into it meanwhile: { text, caret, mark }, the steps from `mark` on given way to that one.
  setDoc(text, caret, undo = null) {
    const prev = this.docText();
    if (prev !== text) {
      if (undo) this.history.length = Math.min(this.history.length, undo.mark);
      this.history.push(undo ? { text: undo.text, caret: undo.caret } : { text: prev, caret: this.caretInfo()?.anchor || null });
      if (this.history.length > 200) { this.history.shift(); if (this.editing) this.editing.mark = Math.max(0, this.editing.mark - 1); }
      this.future = [];
      this.props.onChange(text);
    }
    if (caret) this.caret = caret;
  }
  setLines(fn, caret) { this.setDoc(fn(this.lines()).join('\n'), caret); }
  writeText(i, text, caret) {
    this.setLines((ls) => { const ps = this.parsedOf(ls); return ls.map((l, j) => (j !== i ? l : sameLine(ps[j], text))); }, caret);
  }
  undo = () => {
    // A question in edit mode with nothing typed into it (any more): ⌘Z takes it out of edit mode.
    if (this.editing && this.history.length <= this.editing.mark) { this.cancelEdit(true); return; }
    const h = this.history.pop(); if (!h) return;
    this.future.push({ text: this.docText() });
    this.props.onChange(h.text);
    if (h.caret) this.caret = { line: h.caret.line, offset: h.caret.offset };
  };
  redo = () => {
    const f = this.future.pop(); if (!f) return;
    this.history.push({ text: this.docText(), caret: null });
    this.props.onChange(f.text);
  };

  /* ---------------------------------------------------------------- rendering (HTML strings, as the design) */
  revealRange() { const c = this.caret; if (c) return c.sel ? c.sel : [c.offset, c.offset]; const s = this.selRaw; return s ? [s.a, s.b] : [-1, -1]; }
  // Which tokens show their source on the active line: inline markers the caret touches. A heading's `# ` is plain text there, so it
  // shows (in the heading's font) for as long as the caret is on the line and goes away when the caret leaves (2026-09-18: hiding it
  // left an empty span the browser typed into, and those characters were lost). A mention opens only with the caret strictly
  // inside it (MATH-56): at its start or end it stays drawn, so one just picked from the @ menu shows finished at once.
  // Math (2026-10-12) opens when the caret touches it, as bold does: the caret never stands inside a drawn formula.
  // `shut` (2026-10-12): a link stays drawn whatever the caret touches. An answer's line the mouse put the caret on
  // (byMouse) is drawn so: a click beside a link must not turn it into `[title](url)`, or the next click lands on plain
  // text and opens nothing. Its source shows once the keyboard reaches the caret (keyReached). An answer's [[build]]
  // (2026-10-12) stays drawn there as a link does: a click on it builds.
  openIdx(tokens, a, b, shut = false) {
    const out = []; let acc = 0;
    // A pasted image's token never opens (2026-10-15, David): `![Attachment 1](img:<id>)` is no text to edit.
    tokens.forEach((tok, k) => { const end = acc + tok.length, pre = tokShown(tok).pre && !ATTACH_RE.test(tok), touched = tok.startsWith('@[') ? a < end && b > acc : a <= end && b >= acc; if (pre && touched && !(shut && (holdsLink(tok) || tok === BUILD_TOKEN))) out.push(k); acc = end; });
    return out;
  }
  // Whether line `p`'s links stay drawn with the caret on it: an answer's line, the caret put there by the mouse.
  linksShut(p) { return !!this.byMouse && !!p && p.type === 'reply' && !p.code; }
  // `marker`: the style of tokens[0] when it is a line's own `## ` or `- ` (an answer's line being edited: faint, so the
  // line keeps its look and only the mark shows).
  activeHtml(tokens, flags, marker = null, shut = false, opts = this.mentionOpts) {
    const [a, b] = this.revealRange(), open = this.openIdx(tokens, a, b, shut); this.openKey = open.join(',');
    return tokens.map((tok, k) => {
      if (marker && k === 0) return `<span data-src="${esc(tok)}" data-open="1" style="${marker}">${esc(tok)}</span>`;
      if (flags && flags.has(k)) return `<span data-src="${esc(tok)}" data-open="1" style="${FLAG_LOOK}">${esc(tok)}</span>`;
      const isOpen = !tokShown(tok).pre || open.includes(k);
      return `<span data-src="${esc(tok)}" data-open="${isOpen ? 1 : 0}">${isOpen && !AGENT_TOKEN.test(tok) ? esc(tok) : inlineHtml(tok, opts)}</span>`;
    }).join('');
  }
  // An @bart line in pieces: its recognised flags (src/main/bart/question.cjs reads them, as the run will) each a token of
  // their own, the rest split as any line is. Shown verbatim, so offsets in the line are what they were. An @brainstorm
  // line has none: its model is fixed and a flag picks nothing (main/bart/models.cjs readBrainstorm). An @discover line's
  // --quick, --standard and --deep are flags too (2026-10-03), and --claude and --codex, with the model and effort flags
  // readDiscover obeys.
  bartTokens(line, p) {
    const models = this.props.models, base = line.length - p.text.length, tokens = [], flags = new Set(), agent = agentOf(p);
    let at = 0;
    for (const [from, to] of agent === 'discover' ? discoverSpans(p.text, models) : models && !fixedStep(agent) ? readFlags(p.text, models).spans : []) {
      tokens.push(...line.slice(at, base + from).split(INLINE).filter(Boolean)); flags.add(tokens.length); tokens.push(line.slice(base + from, base + to)); at = base + to;
    }
    tokens.push(...line.slice(at).split(INLINE).filter(Boolean));
    return { tokens, flags };
  }
  // A sent @bart line's tokens as it is drawn when not being edited: its flags left out, with the space each leaves
  // behind, and its agent said `@bart` (2026-10-16).
  unflaggedHtml(tokens, flags) {
    let spaced = false;
    return tokens.filter((_, k) => !flags.has(k)).map((tok, k) => {
      const t = k === 0 && AGENT_TOKEN.test(tok) ? '@bart' : spaced ? tok.replace(/^\s+/, '') : tok;
      if (t) spaced = /\s$/.test(t);
      return inlineHtml(t, this.mentionOpts);
    }).join('');
  }
  // A closed token holding more than it shows was typed into at its edge (the caret right before or after a mention,
  // MATH-56): what was typed is the line's own text beside it.
  segs(t) {
    return [...t.childNodes].filter((n) => n.nodeName !== 'BR').flatMap((n) => {
      const el = n.nodeType === 1 && n.dataset && n.dataset.src != null ? n : null;
      const txt = n.textContent.replace(/\u200b/g, '');
      const open = !el || el.dataset.open === '1';
      if (open) return [{ dl: txt.length, src: txt, open, rl: txt.length }];
      const src = el.dataset.src, shut = (dl) => ({ dl, src, open: false, rl: src.length }), typed = (x) => ({ dl: x.length, src: x, open: true, rl: x.length });
      const { shown } = tokShown(src, this.mentionOpts);
      if (txt.length > shown.length && txt.startsWith(shown)) return [shut(shown.length), typed(txt.slice(shown.length))];
      if (txt.length > shown.length && txt.endsWith(shown)) return [typed(txt.slice(0, txt.length - shown.length)), shut(shown.length)];
      return [shut(txt.length)];
    });
  }
  displayToRaw(t, disp) {
    const segs = this.segs(t); if (!segs.length) return null; let accD = 0, accR = 0;
    for (const s of segs) {
      // The end of a drawn mention is the end of its source (MATH-56): a caret after it stays after it, not before its `]`.
      if (disp <= accD + s.dl) { const d = disp - accD; if (s.open) return accR + d; const { pre, unit } = tokShown(s.src); if (unit) return accR + (d === 0 ? 0 : s.rl); return accR + (d === 0 ? 0 : d === s.dl && s.src.startsWith('@[') ? s.rl : Math.min(s.rl, pre + d)); }
      accD += s.dl; accR += s.rl;
    }
    return accR;
  }
  rawToDisplay(t, raw) {
    const segs = this.segs(t); let accD = 0, accR = 0;
    for (const s of segs) {
      if (raw <= accR + s.rl) { const d = raw - accR; if (s.open) return accD + d; const { pre, unit } = tokShown(s.src); if (unit) return accD + (d <= 0 ? 0 : s.dl); return accD + Math.max(0, Math.min(s.dl, d - pre)); }
      accD += s.dl; accR += s.rl;
    }
    return accD;
  }
  activeRaw(t) { return this.segs(t).map((s) => s.src).join(''); }

  // `at` says where a line of an @bart card stands in it (this.layout); every other line has none.
  lineHtml(i, line, p, active, first, at, locked) {
    const raw = `data-line="${i}" data-raw="${esc(line)}"`;
    // A collapsed conversation's lines are in the document, not on the page: its title's row stands for them.
    if (at && at.hidden) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
    if (p.type === 'title' && at) return this.titleHtml(i, raw, p, at);
    if (p.type === 'build') return this.buildHtml(i, line, p);
    if (p.type === 'code' || p.type === 'fence') return this.codeHtml(i, line, p, active);
    if (p.type === 'todo') {
      const done = p.done;
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text, this.mentionOpts);
      // Each checkbox is its own row (2026-10-12): a square box that fills blue when checked, no card around the run.
      const box = `<span contenteditable="false" data-act="toggle" data-row="${i}" role="checkbox" aria-checked="${!!done}" style="user-select:none;flex:none;box-sizing:border-box;width:16px;height:16px;margin-top:10px;border:1.5px solid ${done ? '#0070f3' : '#c9c9c9'};border-radius:4px;background:${done ? '#0070f3' : '#fff'};color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer">${done ? '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.4 5 8.8l4.5-5.4"/></svg>' : ''}</span>`;
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;padding:0 0 0 ${p.depth * 24}px;min-height:35px">${box}`
        + `<span class="t" style="flex:1;min-width:0;padding:4px 0;color:${done ? '#8f8f8f' : '#171717'};text-decoration:${done ? 'line-through' : 'none'}">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'list') {
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text, this.mentionOpts);
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;padding:4px 0 4px ${p.depth * 24}px;min-height:35px">`
        + (p.num != null
          ? `<span contenteditable="false" style="user-select:none;flex:none;min-width:14px;text-align:right;line-height:1.6;color:#8f8f8f;font-variant-numeric:tabular-nums">${esc(listMark(p))}</span>`
          : `<span contenteditable="false" style="user-select:none;flex:none;width:14px;text-align:center;line-height:1.6;color:#8f8f8f">\u2022</span>`)
        + `<span class="t" style="flex:1;min-width:0">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'h') {
      const size = [26, 22, 18][p.level - 1]; const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text, this.mentionOpts);
      // Right under a card it has room above its text to click in (gapAt): a new line goes there.
      const pad = i > 0 && this.cardEnds()[i - 1] === i - 1 ? '12px 0 4px' : '4px 0';
      return `<div ${raw} style="padding:${pad};min-height:35px;font:500 ${size}px/1.6 var(--font-sans);letter-spacing:-0.3px"><span class="t">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'bart') {
      if (at && at.box && at.role === 'question') return this.researchHtml(i, raw, p, at);
      if (at && at.bare && at.role === 'question') return this.foldedHtml(i, raw, line, p, at);
      const { tokens, flags } = this.bartTokens(line, p), models = this.props.models;
      // A question sent says `@bart` (2026-10-16, David: "always show @bart", whichever agent its line names or answered
      // it; from 2026-10-14 a typed `@brainstorm` had stayed `@brainstorm`). The line keeps what was typed, which shows again
      // with the caret in it; a line not sent yet is drawn as typed.
      const asked = !!at && !!at.turn && at.turn.answered;
      const shown = at && at.answers && !(active && !locked) ? this.answerShown(at.answers) : '';
      // A question sent, not being edited, does not draw its flags (2026-10-16, David: "@bart --sonnet --medium i don't
      // know…" read as "@bart i don't know…"); they stay in the line, where the run reads them, and show with the caret in it.
      const sent = asked || !!(at && at.turn && at.turn.pending);
      const content = shown ? `${inlineHtml('@bart', this.mentionOpts)} ${shown}` : active && !locked ? this.activeHtml(tokens, flags) : sent ? this.unflaggedHtml(tokens, flags) : tokens.map((tok, k) => (flags.has(k) ? `<span style="${FLAG_LOOK}">${esc(tok)}</span>` : inlineHtml(tok, this.mentionOpts))).join('');
      // @brainstorm and @discover run on one model (BS-08) and may be asked with nothing after them. An `@bart` line names
      // the model Chat would answer on (2026-10-13), and needs words before it can be sent.
      const agent = agentOf(p), plain = oneModel(agent), routes = agent === 'router';
      const read = models && (!plain || routes) ? readQuestion(p.text, models) : null, ready = (plain && !routes) || !!(read ? read.question : p.text).trim();
      // The question opens its card, or follows an answer inside one. Once it is answered its chip goes: the foot says who answered.
      // Being edited (2026-10-03), it has its chip and send again, as an unasked line has.
      const top = !at || at.top, closes = !at || at.closes, editing = !!this.editing && this.editing.q === i, chipped = closes || editing;
      const send = `<button contenteditable="false" data-act="ask" data-row="${i}" aria-label="Send" ${ready ? '' : 'disabled'} style="user-select:none;flex:none;width:28px;height:28px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;${boxSend(ready)};cursor:${ready ? 'pointer' : 'default'};transition:background 160ms">${ICON.sendBox}</button>`;
      // The chip: what the question starts on, and (hovered) where that is changed. The arrow sits inside it, one unit.
      const open = !!(this.state.picker && this.state.picker.kind === 'line' && this.state.picker.i === i);
      // An unanswered @discover line's chip (2026-10-03) names its level instead, the one it would run at now (carried from
      // an earlier turn of its exchange when the line names none), with its provider when that is not the default ("Codex ·
      // Deep"), or the model and effort a flag pins it to; its menu is DiscoverLevels. @brainstorm runs on one model: no chip.
      const label = read ? `${read.steps[0].name} ${EFFORT_LABELS[read.steps[0].effort] || read.steps[0].effort}` : models && agent === 'discover' && chipped ? this.discoverLabel(i) : null;
      // The chip (2026-10-13): the model and effort as plain words with a chevron, no border, then the round send.
      const chip = label ? `<span contenteditable="false" data-chip="${i}" style="user-select:none;flex:none;display:inline-flex;align-items:center;gap:10px"><span data-act="pick" data-row="${i}" role="button" aria-haspopup="dialog" aria-expanded="${open}" style="display:inline-flex;align-items:center;gap:4px;height:28px;font:13px/1 var(--font-sans);color:#4d4d4d;cursor:default;white-space:nowrap">${esc(label)}<span style="display:inline-flex;color:#8f8f8f">${icon(open ? '<path d="m18 15-6-6-6 6"></path>' : '<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span></span>${send}</span>` : `<span contenteditable="false" style="user-select:none;flex:none;display:inline-flex">${send}</span>`;
      // An answered question's Collapse is in its top right corner (2026-10-15, David: it was on the button row under the
      // answer, far from the row the exchange folds to). A titled conversation's `--build` line (2026-10-13) keeps its chip,
      // and its corner collapses the conversation.
      const buildTurn = !!at && !!at.turn.build, whole = buildTurn && top && at.thread.titleLine >= 0;
      // An untitled Build's card is its answer, and folds no other way (no corner). Every answered exchange's Collapse is
      // collapseTurn's (2026-10-16, David): the first exchange of a titled conversation collapses the conversation, every
      // other folds its exchange alone. A click on the question itself collapses nothing (2026-10-16, David; since
      // 2026-10-15 it had). A question still being answered in a titled conversation has the conversation's (2026-10-15).
      const firstOpen = !!at && (at.thread.turns.find((turn) => !turn.folded) || {}).q === at.turn.q;
      const foldable = !!at && (cornered(at.turn, at.box) || (firstOpen && !!at.turn.pending && !at.box && at.thread.titleLine >= 0)) && (!buildTurn || whole) && !editing;
      // An answered @bart exchange keeps its corner too (2026-10-15, David: it was taken off to match his reference, and he
      // wanted it back).
      const chatQ = !!at && at.chat && asked && !at.turn.pending && !editing;
      const corner = foldable ? this.cornerHtml(at, whole, !!at.turn.pending) : '';
      // Not asked yet (or being edited), the line is the message box (2026-10-13): one line, white, bordered, growing as it
      // wraps with the chip and send kept bottom-right.
      if (!asked || editing) {
        return `<div ${raw} ${locked ? 'contenteditable="false" data-readonly="1"' : ''}${editing ? ' data-editing="1"' : ''} data-message-box="1" style="${MESSAGE_BOX};margin:${top ? 0 : 8}px 0 8px;font-size:16px;line-height:1.6;${locked ? 'user-select:text;cursor:default' : ''}"><span class="t" style="flex:1;min-width:0;align-self:center">${content || '<br>'}</span>`
          + (chipped ? chip : '') + '</div>';
      }
      // Asked, it is the card's question: flush with the card's 16px, 14px under its top, or under an earlier exchange
      // folded to a line (whose own space is under it).
      const pad = top ? 14 : at.afterBare ? 0 : 14;
      // Its topic, a Brainstorm conversation's first question's, on a line of its own under it (topicChipHtml).
      const topic = this.topicChipHtml(i, at, true), wrap = topic ? 'flex-wrap:wrap;' : '';
      if (chatQ) {
        return `<div ${raw} ${locked ? 'contenteditable="false" data-readonly="1"' : ''} class="chat-q"${at.older ? ` data-chat-older="${at.turn.q}"` : ''} style="position:relative;display:flex;${wrap}align-items:flex-start;gap:10px;padding:${pad}px 18px ${closes ? 12 : 0}px;background:#fafafa;border-radius:${radius(top, closes)};margin-bottom:${closes ? '8px' : '0'};font-size:16px;line-height:1.5;color:#171717;${locked ? 'user-select:text;cursor:default' : ''}"><span class="t" style="flex:1;min-width:0">${content || '<br>'}</span>`
          + (chipped ? chip : '') + corner + topic
          + '</div>';
      }
      return `<div ${raw} ${locked ? 'contenteditable="false" data-readonly="1"' : ''} style="display:flex;${wrap}align-items:flex-start;gap:10px;padding:${pad}px 16px ${closes ? 10 : 0}px;background:#fafafa;border-radius:${radius(top, closes)};margin-bottom:${closes ? '8px' : '0'};font-size:16px;line-height:1.6;color:#171717;${locked ? 'user-select:text;cursor:default' : ''}"><span class="t" style="flex:1;min-width:0">${content || '<br>'}</span>`
        + (chipped ? chip : '') + corner + topic
        + '</div>';
    }
    // A research box cut short says so on its status row (researchHtml): its pending line, or its one line, is not drawn.
    if (at && at.box && at.role !== 'question' && ['interrupted', 'stopped', 'failed'].includes(at.boxState)) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
    if (p.type === 'pending') {
      // The run with this id is working, or it died with the app and only Hide is left. While it works the row shows what
      // it is doing, the things it has done (behind the count, closed until clicked) and the answer so far. None of that is
      // in the document: it comes from props.asks, and the row's `data-raw` stays the bare pending line.
      const ask = (this.props.asks || {})[p.id], wait = this.waits.get(p.id);
      // A Create run (2026-10-14): the row its file will have (createPendingHtml).
      // Until Create says what it is making, or writes a file, it is a run thinking like any other (2026-10-14, David: the
      // sentence first, then the row under it).
      if ((ask && ask.agent === 'create' && this.createSaid(ask).shows) || (!ask && !wait && at && at.agent === 'create')) return this.createPendingHtml(raw, p, at, ask);
      // @discover's trace names a step by its paper's title (traceHtml), the activity by its id: the step still waiting,
      // else, until it thinks or writes, the newest step.
      const traced = ask && ask.trace ? ask.trace.now || (/^(?:Thinking|Writing)?$/.test(ask.activity || '') ? null : ask.trace.last) : null;
      // A Create run writing before it has said what it makes: the file without how much is written (2026-10-16, David).
      const now = ask && ask.agent === 'create' ? String(ask.activity || '').replace(/ · \d+ KB$/, '') : ask && ask.activity;
      const doing = wait ? `Searching in ${wait.left} s` : ask ? (traced || now || (ask.movedUp ? 'Thinking harder' : 'Thinking')) : '';
      const label = wait ? esc(doing) : ask ? `${esc(doing)}${ask.name ? ` · ${esc(ask.name)} ${esc(ask.effort)}` : ''}` : 'No answer came back: the run was interrupted.';
      const story = ask && ask.trace ? traceHtml(ask.trace, { writing: ask.activity === 'Writing' }) : '';
      // Told as a trace, the steps are its lines (a run of lookups is one); else each thing done.
      const log = story ? ask.trace.groups.flatMap((group) => group.lines) : (ask && ask.log) || [], open = this.openLogs.has(p.id);
      // The answer so far is not the answer: smaller and grey. No rule beside it (2026-09-21); it starts where the answer's
      // text will, so nothing moves sideways when the answer lands. No mark pulsing where the next words go (2026-10-16, David).
      const cursor = '';
      // Code arriving shows as code: mono, grey like the rest, its fences a little space (bodyLines closes a block still
      // being written, so the lines under an opening fence are code as soon as they come).
      // A card arriving is JSON, which says nothing until it is drawn: an @discover run shows its guide as it comes but not
      // a card, and an @brainstorm run (prose since 2026-10-14) its answer as it comes but not the Welcome walkthrough's card.
      const who = (ask && ask.agent) || (at && at.agent), coming = (ask && ask.lines) || [];
      // Nor the topic tag Brainstorm may end with (2026-10-14; main's bart/ask.cjs takeTopic), whole or still arriving.
      // Nor the research line Discover ends with once it knows what to look for (2026-10-14; takeResearch).
      const told = who === 'brainstorm' ? coming.filter((text) => !TOPIC_TAG_LINE.test(text)) : who === 'discover' ? coming.filter((text) => !RESEARCH_TAG_LINE.test(text)) : coming;
      const so = (who === 'discover' || fixedStep(who)) && /^\s*(\{|```)/.test(told.join('\n')) ? [] : told, role = new Map();
      for (const b of codeBlocks(so)) { role.set(b.open, 'fence'); role.set(b.close, 'fence'); for (let k = b.open + 1; k < b.close; k++) role.set(k, 'code'); }
      let tip = so.length - 1; while (tip >= 0 && role.get(tip) === 'fence') tip--;
      const written = so.map((text, n) => {
        if (role.get(n) === 'fence') return '<span style="display:block;height:6px"></span>';
        const end = n === tip;
        if (role.get(n) === 'code') return `<span style="display:block;min-height:22px;padding:0 0 0 14px;font:13px/1.7 var(--font-mono);color:#8f8f8f;tab-size:2;${end ? 'margin-bottom:10px;' : ''}">${esc(text) || (end ? '' : '<br>')}${end ? cursor : ''}</span>`;
        const a = this.answerLook(text); a.content = a.content.replace(/color:#171717;font-weight:600/g, 'font-weight:600'); // all of it grey until it is the answer
        return `<span style="display:block;min-height:${text ? 22 : 10}px;padding:1px 0 1px 14px;${a.look}color:#8f8f8f;font-size:14px;line-height:1.65;${end ? 'margin-bottom:10px;' : ''}">${end ? (/<\/span><\/span>$/.test(a.content) ? a.content.replace(/<\/span><\/span>$/, `${cursor}</span></span>`) : a.content + cursor) : (a.content || '<br>')}</span>`;
      }).join('');
      const closes = !at || at.closes;
      // The answer so far is in a box of its own, as tall as min(240px, 35vh) at most (2026-10-13): a long answer scrolls
      // inside it, on its newest line unless the person scrolled up in it (placeStreams), and the card does not grow to
      // fill the pane or push the line being typed below it out of view. The log and the activity row stay under it.
      const box = written ? `<div data-stream="${esc(p.id)}" style="max-height:${STREAM_CAP};overflow-y:auto">${written}</div>` : '';
      // A research box's running row is the foot of the box's own card (researchHtml), which it closes.
      const boxed = !!at && at.box;
      return `<div ${raw} data-pending="${esc(p.id)}" contenteditable="false" data-readonly="1" style="user-select:none;cursor:default;padding:${boxed ? 0 : at ? 12 : 2}px 16px 12px;background:#fafafa;border-radius:${radius(!at, closes)};margin-bottom:${closes ? '8px' : '0'};color:#8f8f8f;font:13px/1.5 var(--font-sans)">`
        + (boxed ? '<div data-box-card-end style="padding:10px 14px 8px;background:#fff;border:1px solid #ebebeb;border-top:0;border-radius:0 0 10px 10px">' : '')
        + box
        + (open && story ? `<div data-trace style="margin:0 0 10px 16px;font:12.5px/1.7 var(--font-sans);color:#8f8f8f">${story}</div>` : '')
        + (open && log.length && !story ? `<div style="margin:0 0 8px 16px;font:12px/1.7 var(--font-sans);color:#8f8f8f">${log.map((entry) => `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry)}</div>`).join('')}</div>` : '')
        + '<div style="display:flex;align-items:center;gap:10px">'
        // At work, what it is doing is said by the text alone, a wave through it (2026-10-16, David: no blinking blue dot).
        + `<span class="t" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ask || wait ? waveText(label) : label}</span>`
        + (log.length ? `<button class="bart-text" data-act="asklog" data-ask="${esc(p.id)}" aria-expanded="${open}" style="user-select:none;flex:none;display:inline-flex;align-items:center;gap:6px;font-weight:400">${log.length} ${log.length === 1 ? 'step' : 'steps'}${open ? ICON.stepsOpen : ICON.stepsShut}</button>` : '')
        + (wait ? `<button class="bart-text" data-act="cancelwait" data-ask="${esc(p.id)}" style="user-select:none;flex:none">Cancel</button>` : ask ? `<button class="bart-text" data-act="stopask" data-ask="${esc(p.id)}" style="user-select:none;flex:none">Stop</button>` : `<button class="bart-text" data-act="dropline" data-row="${i}" style="user-select:none;flex:none">Hide</button>`)
        + '</div>' + (boxed ? '</div>' : '') + '</div>';
    }
    if (p.type === 'reply') {
      // An answer is read, never edited (2026-10-16, David): the caret's line shows no source, and the line is read-only
      // (selectable, as the prototype's quotes are).
      active = false;
      // A folded turn's foot is not drawn: the turn is its question's one row (foldedHtml). A research box keeps its own.
      if (at && at.role === 'foot' && at.turn.answered && !at.turn.pending && at.turn.folded && !at.box) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
      if (at && at.role === 'foot' && at.chat) return this.chatFootHtml({ raw, at, closes: at.closes });
      if (at && at.role === 'foot') return this.footHtml({ raw, q: at.turn.q, text: p.text.slice(1, -1), folded: at.turn.folded, closes: at.closes, plain: oneModel(at.agent), busy: isRunning(at.thread, this.props.builds), box: at.box, refine: at.refine, guide: at.agent === 'discover' && (!at.box || at.boxState === 'finished') ? at.turn : null });
      // Folded away, or the empty line the runner leaves before the closing line: in the document, not on the page.
      if (p.folded || (at && (at.gap || at.underCard))) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
      if (at && at.card) return this.cardHtml(raw, at.card);
      // A file @create made (2026-10-14): its row, never edited in place.
      const madeHere = at && at.role === 'answer' && !at.box ? madeMentionOf(p.text) : null;
      if (madeHere) return this.madeLineHtml(raw, madeHere, at);
      // One line of an answer, in the grey card with one continuous rule down its left. The caret's line shows its source
      // on a light focus tint; the rule and the card stay where they are.
      // (An answer with no question above it, left by an edit outside the app, is a card of its own.)
      const near = at ? null : this.lines(), first = at ? at.first : parseLine(near[i - 1] ?? '').type !== 'reply', closes = at ? at.closes : parseLine(near[i + 1] ?? '').type !== 'reply', last = at ? at.lastBody : closes;
      const rawA = at && at.role === 'answer' && !at.box ? `${raw} data-answer-of="${at.turn.q}"` : raw;
      if (p.code) { const code = readOnlyLine(this.answerCodeHtml(i, rawA, p, active, first, closes, last, !at)); return at && at.chat ? chatCode(code, at) : code; }
      if (at && at.chat && at.role === 'answer') return this.chatLineHtml(i, rawA, p, active, at);
      // A brainstorm recap's lines ("What you know: …", "Your question: …") as sections: the label in bold on a line
      // of its own, the words under it. An older recap's "Look for:" line too (MATH-31), no longer a button.
      const recap = at && fixedStep(at.agent) && !active && at.turn && this.isRecap(this.lines(), at.turn) ? recapLine(p.text) : null;
      // A result's last line (MATH-40): small, with @discover and @bart to send their sentence on.
      const offer = !!at && fixedStep(at.agent) && !active && isResultOffer(p.text);
      // An @discover guide's title line (2026-10-02) has its paper's bookmark in a margin of its own on the right, level with
      // the title's first line (2026-10-03): the title wraps before it, and every entry's sits in the same place.
      const paper = at && at.agent === 'discover' && !active ? this.guidePaper(i, p.text, at) : null, mark = paper ? this.paperSaveHtml(i, paper) : '';
      // The caret's line keeps its heading's size or its bullet's indent: its `## ` or `- ` shows faint where the heading
      // starts or the bullet stood, the same characters as before, so the caret and offsets are as they were. The bullet's
      // `- ` stands in the mark's column (MATH-69), pulled into the line's hanging indent, so its text stays where it was
      // drawn and a wrapped line goes on under the text, not under the mark.
      const q = active ? parseLine(p.text) : null, cut = q && (q.type === 'h' || isMarked(q.type)) ? p.text.length - q.text.length : 0;
      const tokens = cut ? [p.text.slice(0, cut), ...p.text.slice(cut).split(INLINE).filter(Boolean)] : null;
      const hang = cut && q.type !== 'h' ? `padding-left:calc(${q.depth * 18}px + ${MARK_COL});` : '';
      const own = at && at.turn && !isRunning(at.thread, this.props.builds) ? at.turn.q : null, cites = this.citesOf(at), a = this.answerLook(p.text, own, cites), shut = active && this.linksShut(p), content = active ? (tokens ? this.activeHtml(tokens, null, `color:#b5b5b5;${q.type === 'h' ? '' : `${MARK_EDITED};`}`, shut, this.answerOpts(own, cites)) : this.activeHtml(tokensOf(p, line), null, null, shut, this.answerOpts(own, cites))) : offer ? this.resultOfferHtml(i) : recap ? this.recapHtml(recap, first) : a.content + mark;
      return `<div ${rawA}${mark ? ' data-paper-line="1"' : ''} contenteditable="false" data-readonly="1" style="user-select:text;-webkit-user-select:text;padding:${first ? 12 : 0}px 16px ${closes ? 10 : 0}px;background:#fafafa;border-radius:${radius(!at && first, closes)};margin-bottom:${closes ? 8 : 0}px;color:#262626;font-size:16px;line-height:1.65;cursor:default"><span style="display:block;padding:${first ? 2 : 0}px 0 ${last ? 2 : 0}px 14px;border-left:2px solid #d6d6d6"><span class="t" style="display:block;min-height:${a.minHeight}px;border-radius:4px;${a.look}${hang}${mark ? 'position:relative;padding-right:28px;' : ''}${active ? 'background:#f5f5f5;box-shadow:0 0 0 4px #f5f5f5;' : ''}">${content || '<br>'}</span></span></div>`;
    }
    if (p.type === 'quote') {
      // A block quote, its lines one grey block (2026-10-16: editable, as any line is). With the caret on it its `> ` shows,
      // faint, at the start of the text, the characters it is in the source, so the caret and offsets are as typed.
      const ls = this.lines(), up = i > 0 && parseLine(ls[i - 1]).type === 'quote', down = parseLine(ls[i + 1] ?? '').type === 'quote';
      const content = active ? this.activeHtml(tokensOf(p, line), null, 'color:#b5b5b5') : inlineHtml(p.text, this.mentionOpts);
      return `<div ${raw} style="cursor:text;padding:${up ? 0 : 8}px 16px ${down ? '0' : '12px'};background:#fafafa;border-radius:${radius(!up, !down)};margin-bottom:${down ? '0' : '14px'};color:#4d4d4d;font-size:16px"><span class="t" style="display:block;min-height:${p.text ? 31 : 12}px;padding:2px 0 2px 12px;border-left:2px solid #dcdcdc">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'img') {
      const src = p.src.startsWith('img:') ? ((this.props.images || {})[p.src.slice(4)] || '') : p.src;
      const { name, width } = imgParts(p.text);
      const picture = `<span contenteditable="false" data-imgbox="${i}" style="position:relative;display:inline-block;max-width:100%;margin:6px 0;line-height:0;user-select:none;${width ? `width:${width}px;` : ''}"><img data-img="${i}" src="${esc(src)}" alt="${esc(name)}" draggable="false" style="display:block;width:100%;max-width:100%;${width ? '' : 'max-height:520px;width:auto;'}border:1px solid #eaeaea;border-radius:8px;cursor:${this.props.readOnly ? 'zoom-in' : 'grab'}">${IMG_CORNERS.map(([side, at, cursor]) => `<span data-imgsize="${i}" data-imgcorner="${side}" aria-label="Resize image" style="position:absolute;${at};width:16px;height:16px;cursor:${cursor};background:transparent"></span>`).join('')}</span>`;
      const drawn = !src ? `<span contenteditable="false" style="display:inline-block;margin:6px 0;padding:10px 14px;border:1px dashed #c9c9c9;border-radius:8px;font:12.5px/1.5 var(--font-sans);color:#8f8f8f;user-select:none">${esc(name || 'image')}…</span>` : picture;
      // With the caret on it the picture stays (2026-10-15, David: never its `![Attachment 1](img:<id>)`), held as the line's
      // one closed token. The caret stands before it or after it, each in a zero-width space of its own (one caret, drawn
      // at one side); what is typed or pasted there goes on a line of its own (besidePicture).
      const content = active ? `\u200b<span data-src="${esc(line)}" data-open="0" data-img-line="1">${drawn}</span>\u200b` : drawn;
      return `<div ${raw} style="padding:4px 0;min-height:35px"><span class="t" style="display:block">${content}</span></div>`;
    }
    const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(line, this.mentionOpts);
    return `<div ${raw} style="padding:4px 0;min-height:35px"><span class="t">${content || '<br>'}</span></div>`;
  }
  // One line of a fenced code block, on the grey of the cards, in the mono face. The opening fence is the block's head:
  // its language and Copy, or the fence as typed while the caret is on it. The closing fence is the block's foot, a
  // strip of grey, or the fence while the caret is on it. A line of code shows its source whether or not the caret is
  // on it (display and source are the same characters), so JSON keeps its colours while it is edited.
  // A ```math block (2026-10-12) is the equation, drawn, while the caret is outside it: its opening fence holds the
  // drawing and Copy (the LaTeX), the rest of the block is hidden. With the caret in it, it is code like any other.
  // Its LaTeX drawn, or null: not a math block, the caret in it, or LaTeX KaTeX cannot draw (then it shows as code).
  mathBlock(p) {
    if (!p.block || p.lang !== 'math') return null;
    const a = this.state.activeLine; if (a != null && a >= p.block.open && a <= p.block.close) return null;
    const ps = this.parsedOf(this.lines());
    return mathBlockHtml(ps.slice(p.block.open + 1, p.block.close).map((q) => q.text).join('\n'));
  }
  codeHtml(i, line, p, active) {
    const raw = `data-line="${i}" data-raw="${esc(line)}" data-kind="${p.type}"`, mono = 'font:14px/1.7 var(--font-mono)';
    const math = this.mathBlock(p);
    if (math && (p.type === 'code' || !p.open)) return `<div ${raw} data-math-block="1" style="display:none"><span class="t"></span></div>`;
    if (math) return `<div ${raw} data-math-block="1" style="display:flex;align-items:center;gap:8px;padding:2px 6px 2px 16px;margin:2px 0"><span class="t" style="flex:1;min-width:0;overflow-x:auto;overflow-y:hidden">${math}</span>${this.copyCodeHtml(i)}</div>`;
    if (p.type === 'code') return `<div ${raw} style="padding:0 16px;background:#fafafa;${mono};color:#171717"><span class="t" style="display:block;min-height:24px;tab-size:2">${highlight(line, p.lang) || '<br>'}</span></div>`;
    if (!p.open) return `<div ${raw} style="padding:0 16px ${active ? 8 : 4}px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px"><span class="t" style="display:block;${active ? `${mono};color:#8f8f8f` : 'font:8px/1 var(--font-sans)'}">${active ? esc(line) : '<br>'}</span></div>`;
    const shown = active ? esc(line) : esc(fenceShown(p));
    return `<div ${raw} style="display:flex;align-items:center;gap:8px;min-height:36px;margin-top:6px;padding:4px 6px 0 16px;background:#fafafa;border-radius:10px 10px 0 0"><span class="t" style="flex:1;min-width:0;${active ? `${mono};color:#8f8f8f` : 'font:12px/1.6 var(--font-sans);color:#8f8f8f'}">${shown || '<br>'}</span>${this.copyCodeHtml(i)}</div>`;
  }
  // A code block inside an @bart answer (2026-09-22): a white box on the card's grey, inside the answer's rule, drawn
  // the way a block in the document is (language and Copy at its head, a fence as typed while the caret is on it).
  answerCodeHtml(i, raw, p, active, first, closes, last, alone) {
    const mono = 'font:14px/1.7 var(--font-mono)', sides = 'border-left:1px solid #eaeaea;border-right:1px solid #eaeaea';
    const math = this.mathBlock(p), card = `padding:${first ? 12 : 0}px 16px ${closes ? 10 : 0}px;background:#fafafa;border-radius:${radius(alone && first, closes)};margin-bottom:${closes ? 8 : 0}px`;
    // A math block in an answer: the equation on the card, inside the rule; its closing fence keeps the card's foot.
    if (math && p.code === 'body') return `<div ${raw} data-kind="code" data-math-block="1" style="display:none"><span class="t"></span></div>`;
    if (math && p.code === 'close') return `<div ${raw} data-kind="fence" data-math-block="1" style="${card};cursor:text"><span style="display:block;padding:0 0 ${last ? 2 : 0}px 14px;border-left:2px solid #d6d6d6"><span class="t" style="display:block;font:4px/1 var(--font-sans)"><br></span></span></div>`;
    if (math) return `<div ${raw} data-kind="fence" data-math-block="1" style="${card};cursor:text"><span style="display:flex;align-items:center;gap:8px;padding:${first ? 2 : 0}px 0 0 14px;border-left:2px solid #d6d6d6"><span class="t" style="flex:1;min-width:0;overflow-x:auto;overflow-y:hidden">${math}</span>${this.copyCodeHtml(i)}</span></div>`;
    let inner;
    if (p.code === 'body') inner = `<span class="t" style="display:block;min-height:24px;padding:0 12px;background:#fff;${sides};${mono};color:#171717;tab-size:2">${highlight(p.text, p.lang) || '<br>'}</span>`;
    else if (p.code === 'close') inner = `<span class="t" style="display:block;padding:0 12px ${active ? 6 : 4}px;background:#fff;${sides};border-bottom:1px solid #eaeaea;border-radius:0 0 8px 8px;${active ? `${mono};color:#8f8f8f` : 'font:8px/1 var(--font-sans)'}">${active ? esc(p.text) : '<br>'}</span>`;
    else inner = `<span style="display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 4px 0 12px;background:#fff;${sides};border-top:1px solid #eaeaea;border-radius:8px 8px 0 0"><span class="t" style="flex:1;min-width:0;${active ? `${mono};color:#8f8f8f` : 'font:12px/1.6 var(--font-sans);color:#8f8f8f'}">${(active ? esc(p.text) : esc(fenceShown(p))) || '<br>'}</span>${this.copyCodeHtml(i)}</span>`;
    // The space around the box is the rule's padding, not a margin: a margin would fall through the line's wrappers and
    // cut a white strip across the card.
    const above = first ? 2 : p.code === 'open' ? 6 : 0, below = last ? 2 : p.code === 'close' ? 6 : 0;
    return `<div ${raw} data-kind="${p.code === 'body' ? 'code' : 'fence'}" style="padding:${first ? 12 : 0}px 16px ${closes ? 10 : 0}px;background:#fafafa;border-radius:${radius(alone && first, closes)};margin-bottom:${closes ? 8 : 0}px;cursor:text"><span style="display:block;padding:${above}px 0 ${below}px 14px;border-left:2px solid #d6d6d6">${inner}</span></div>`;
  }
  copyCodeHtml(i) {
    const copied = this.copied === `code${i}`;
    return `<span contenteditable="false" style="user-select:none;flex:none;position:relative;display:inline-flex"><button class="bart-ic" data-act="copycode" data-row="${i}" aria-label="Copy" ${copied ? 'style="color:#8f8f8f"' : ''}>${ICON.copy}</button><span class="bart-tip" style="right:0">${copied ? 'Copied' : 'Copy'}</span></span>`;
  }
  // How one line of an answer reads: a heading, a bullet, or plain text; bold is ink on the answer's grey. An answer in the
  // document and one still being written (the pending row) look the same. A paragraph is one line and an empty line is
  // the 22px between two of them; a bullet keeps 8px to the next.
  // A recap section (round 4, drawn as sections 2026-09-30): "not decided" and "not said" are what is missing, in grey.
  recapLabelHtml(label, first) {
    return `<span contenteditable="false" style="display:block;padding-top:${first ? 2 : 14}px;margin-bottom:2px;font-weight:600;color:#171717;user-select:none">${esc(label)}</span>`;
  }
  recapHtml({ label, text }, first) {
    const missing = /^not (decided|said)\.?$/i.test(text);
    return this.recapLabelHtml(label, first)
      + `<span style="display:block;${missing ? 'color:#8f8f8f;font-style:italic;' : ''}">${text ? inlineHtml(text, this.mentionOpts) : '<span style="color:#8f8f8f;font-style:italic">not said</span>'}</span>`;
  }
  // An @brainstorm result's offer line (MATH-40): small and grey; @discover and @bart are buttons in an editor that can ask.
  resultOfferHtml(i) {
    const chip = (agent) => (this.props.onAsk
      ? `<button type="button" class="bart-text" data-act="resultask" data-agent="${agent}" data-row="${i}" style="user-select:none;display:inline;padding:0;font-size:13px;font-weight:500;color:#0070f3">@${tokenOf(agent)}</button>`
      : `@${tokenOf(agent)}`);
    return `<span contenteditable="false" style="display:block;font-size:13px;line-height:1.6;color:#8f8f8f;user-select:none">Find papers on it with ${chip('discover')}, or ask about it with ${chip('bart')}.</span>`;
  }
  // The Send to Discover field (MATH-31): the blue "@discover", a field one line tall that grows as it wraps, and a round
  // send, as the follow-up field's FOLLOW rows have. `target` names the field and keys what is typed into it
  // (discoverText): `t<from>` after the recap of the thread that starts on line from, the line it sends from (discoverRow;
  // a live card's `c<q>` is no longer drawn, MATH-40 follow-up). What is typed is not in this string (restoreDiscover puts it back),
  // so typing never redraws the editor. The send is grey until something is typed (paintSend).
  // Until it is opened (2026-10-05: two fields stacked looked alike), it is a small "Send to Discover" button; one with
  // words typed into it stays open.
  sendDiscoverHtml(target) {
    if (!this.discoverOpen.has(target) && !(this.discoverText.get(target) || '').trim()) {
      return `<button type="button" class="bart-text" data-act="opendiscover" data-target="${target}" style="user-select:none;display:inline-flex;align-items:center;gap:6px;padding-left:0;font-size:13px">${ICON.discoverOut}Send to Discover</button>`;
    }
    return `<div data-send-discover="${target}" style="display:flex;align-items:flex-start;gap:10px">`
      + '<span style="flex:none;color:#0070f3;font-weight:500;font-size:16px;line-height:24px">@discover</span>'
      + `<textarea data-discover-input="${target}" rows="1" placeholder="What do you want prior work on?" aria-label="Send to Discover" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;display:block;height:24px;margin:0;padding:0;border:0;background:none;outline:none;resize:none;overflow:hidden;font:16px/1.5 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text"></textarea>`
      + `<button class="bart-send" data-act="senddiscover" data-target="${target}" aria-label="Send" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:#f2f2f2;color:#8f8f8f;cursor:pointer">${ICON.send}</button>`
      + '</div>';
  }
  // An @discover guide's title line → its paper ({ title, address }, model/guide.js), or null. The line under it, in the
  // same answer, says whether the entry was read from its abstract alone (no button then).
  guidePaper(i, text, at) {
    const below = i + 1 <= at.turn.to ? parseLine(this.lines()[i + 1] ?? '') : null;
    return guideTitle(text, below && below.type === 'reply' ? below.text : null);
  }
  // Its bookmark (2026-10-03), at the top right of the line's text (CARD_CSS .paper-mark): an outline (none), an outline
  // with + (lib), or filled and disabled (here); the words are its title and label only, so a copy holds none of them.
  // While a click is at work it is disabled on what it was when clicked. None where the editor is not told where papers are.
  paperSaveHtml(i, paper) {
    const known = this.props.paperState ? this.props.paperState(paper.address) : null; if (!PAPER_MARK[known]) return '';
    const held = this.saving.get(paper.address), state = held || known, off = !!held || (state === 'here' ? !this.props.onUnsavePaper : !this.props.onSavePaper), { icon: drawn } = PAPER_MARK[state];
    const words = state === 'here' && this.props.onUnsavePaper ? UNSAVE_WORDS : PAPER_MARK[state].words;
    return `<button type="button" contenteditable="false" class="paper-mark" data-act="papersave" data-row="${i}" data-save="${state}"${held ? ' data-busy="1"' : ''} ${off ? 'disabled aria-disabled="true"' : ''} title="${words}" aria-label="${words}" style="user-select:none">${drawn}</button>`;
  }
  // The button clicked: the paper goes to props.onSavePaper, or, saved here already, to props.onUnsavePaper (2026-10-16);
  // the document is not touched. A failure goes to props.onError and the button says what it said before; a success shows
  // when the library or the workspace changes.
  savePaper(i) {
    const ls = this.lines(), p = this.parsedOf(ls)[i], at = this.layout(ls).get(i);
    if (!p || p.type !== 'reply' || !at || at.agent !== 'discover' || !this.props.paperState) return;
    const paper = this.guidePaper(i, p.text, at), state = paper && this.props.paperState(paper.address);
    const send = state === 'here' ? this.props.onUnsavePaper : state === 'none' || state === 'lib' ? this.props.onSavePaper : null;
    if (!paper || !send || this.saving.has(paper.address)) return;
    this.saving.set(paper.address, state); this.redraw();
    Promise.resolve().then(() => send(paper))
      .catch((error) => { if (this.props.onError) this.props.onError(error); })
      .finally(() => { this.saving.delete(paper.address); this.redraw(); });
  }
  // A guide's papers not in this project yet (2026-10-16, David: Add all): each entry of turn `turn` whose bookmark reads
  // outline or +, in the guide's order, as { i, paper }.
  unsavedPapers(ls, turn) {
    if (!this.props.paperState) return [];
    const ps = this.parsedOf(ls), out = [];
    for (let i = turn.from; i <= turn.to; i++) {
      if (!ps[i] || ps[i].type !== 'reply' || ps[i].folded) continue;
      const paper = this.guidePaper(i, ps[i].text, { turn }), state = paper && this.props.paperState(paper.address);
      if (paper && (state === 'none' || state === 'lib') && !out.some((o) => o.paper.address === paper.address)) out.push({ i, paper });
    }
    return out;
  }
  // Add all (2026-10-16, David): the guide's papers not here yet, saved one after another as each bookmark's click saves
  // it (onSavePaper), each held while it is at work. One that fails is told (onError) and the rest still go.
  saveAllPapers(q) {
    const ls = this.lines(), turn = threads(ls, this.parsedOf(ls)).flatMap((t) => t.turns).find((t) => t.q === q);
    if (!turn || !this.props.onSavePaper || this.savingAll.has(q)) return;
    const todo = this.unsavedPapers(ls, turn).filter(({ paper }) => !this.saving.has(paper.address)); if (!todo.length) return;
    this.savingAll.add(q);
    for (const { paper } of todo) this.saving.set(paper.address, this.props.paperState(paper.address));
    this.redraw();
    (async () => {
      for (const { paper } of todo) {
        try { await this.props.onSavePaper(paper); } catch (error) { if (this.props.onError) this.props.onError(error); }
        this.saving.delete(paper.address); this.redraw();
      }
    })().finally(() => { this.savingAll.delete(q); this.redraw(); });
  }
  redraw() { this.lastHtml = null; if (this.mounted) this.forceUpdate(); }
  // Whether an @brainstorm thread ended in a recap (MATH-31): its last turn answered, not at work and not
  // folded away, in an editor that can ask, with an answer that is not a card and has a line that is a recap section.
  endsInRecap(ls, thread) {
    const end = thread.turns[thread.turns.length - 1];
    if (!this.props.onAsk || !fixedStep(answeredBy(thread)) || !end.answered || end.pending || end.folded) return false;
    return this.isRecap(ls, end);
  }
  // Whether an @brainstorm answer is an older recap (MATH-31): not a card, and either two of its labelled sections at
  // least or nothing but sections. A line of a conversation's prose (2026-10-14) that happens to start with one of their
  // labels is prose. Kept per document array, as parsedOf is.
  isRecap(ls, turn) {
    if (this.recapsOf !== ls) { this.recapsOf = ls; this.recaps = new Map(); }
    if (!this.recaps.has(turn.q)) {
      const { answer } = turnText(ls, turn), said = answer.split('\n').filter((line) => line.trim()), sections = said.filter((line) => recapLine(line)).length;
      this.recaps.set(turn.q, !cardOfAnswer(answer) && (sections >= 2 || (sections > 0 && sections === said.length)));
    }
    return this.recaps.get(turn.q);
  }
  // Where a Send to Discover field stands (its target, sendDiscoverHtml) → the line of its thread to send from, or null
  // when the field is no longer drawn: the thread no longer ends in a recap.
  discoverRow(ls, target) {
    const m = /^t(\d+)$/.exec(String(target)); if (!m) return null;
    const n = Number(m[1]);
    const thread = threads(ls).find((t) => t.from === n);
    return thread && this.endsInRecap(ls, thread) ? n : null;
  }
  // Send to Discover sent (MATH-31): what was typed starts an @discover thread of its own (discoverLook), and the field is
  // emptied. With nothing typed it does nothing.
  sendDiscover(target) {
    const typed = (this.discoverText.get(target) || '').trim(); if (!typed || !this.props.onAsk) return;
    const i = this.discoverRow(this.lines(), target); if (i == null) return;
    this.discoverText.delete(target);
    this.discoverOpen.delete(target);
    this.discoverLook(i, typed);
  }
  // After the thread line `i` is in, a blank line (so the new line starts a thread of its own, doc.js threads) and
  // "@discover <query>" ("@discover" alone with no query) with its pending line, asked with no earlier turns. An answer to
  // a brainstorm card still live above it is written under the brainstorm thread, so above this one (sendCard). Send to
  // Discover asks it (sendDiscover); a result's offer line asks it, or `agent` 'bart' (askResult).
  discoverLook(i, query = '', agent = 'discover') {
    const ls = this.lines(), thread = threads(ls).find((t) => t.from <= i && i <= t.to);
    if (!thread || !this.props.onAsk || (agent === 'bart' && !query)) return;
    const askId = newAskId(), add = ['', query ? `@${tokenOf(agent)} ${query}` : `@${tokenOf(agent)}`, `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    this.setLines((x) => { const out = [...x]; out.splice(thread.to + 1, 0, ...add); return out; });
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: query, turns: [], agent, place: { line: thread.to + 2, text: add[1] } });
  }
  // The walkthrough's Brainstorm (2026-10-10, "when i click the brainstorming button it automatically types and runs
  // it"): "@<agent>" on a line of its own at the end of the document, after a blank line so that it starts a thread of its
  // own, and asked at once, as Enter on it would. Blank lines it ended on go first. → whether it was asked
  startAgent(agent) {
    if (!this.props.onAsk || !oneModel(agent)) return false;
    const ls = this.lines();
    let end = ls.length;
    while (end > 0 && !ls[end - 1].trim()) end -= 1;
    const askId = newAskId(), add = [...(end ? [''] : []), `@${tokenOf(agent)}`, `bart~> ${askId}`, ''];
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    this.setLines((x) => [...x.slice(0, end), ...add]);
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: '', turns: [], agent, place: { line: end ? end + 1 : 0, text: `@${tokenOf(agent)}` } });
    this.showEnd(); // the button is above the document: its run, at the end, is brought into view
    return true;
  }
  // The Welcome walkthrough's handoff (2026-10-10, "make the handoff to discover seamless"): @discover asked on the
  // sentence of the document's last @brainstorm result, as its offer line's @discover would, unless an @discover was asked
  // after it already. Not while `askId`, the brainstorm turn that wrote it, is still pending here: its result is not in yet.
  // → whether it was asked
  discoverLastResult(askId = null) {
    if (!this.props.onAsk) return false;
    const ls = this.lines();
    if (askId && ls.includes(`bart~> ${askId}`)) return false;
    const all = threads(ls);
    for (let n = all.length - 1; n >= 0; n -= 1) {
      if (answeredBy(all[n]) === 'discover') return false;
      const turn = all[n].turns[all[n].turns.length - 1];
      if (!turn || !turn.answered || turn.pending) continue;
      const found = resultParts(turnText(ls, turn).answer);
      if (!found) continue;
      this.discoverLook(turn.q, found.sentence);
      this.showEnd();
      return true;
    }
    return false;
  }
  showEnd() {
    setTimeout(() => { const box = this.scrollRef.current; if (box && box.scrollTo) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' }); }, 0);
  }
  // @discover or @bart on a result's offer line (MATH-40): the sentence above it, read from the turn line `i` is in.
  askResult(i, agent) {
    if (agent !== 'discover' && agent !== 'bart') return;
    const ls = this.lines(), thread = threads(ls).find((t) => t.from <= i && i <= t.to);
    const turn = thread && thread.turns.find((t) => t.from <= i && i <= t.to);
    const found = turn ? resultParts(turnText(ls, turn).answer) : null;
    if (found) this.discoverLook(i, found.sentence, agent);
  }
  // `turn`: the question line of the answered turn this line is in, which the [[build]] hammer in it builds when clicked
  // (model/doc.js inlineHtml); left out where there is nothing to build (a run still writing, a Build's messages).
  answerLook(text, turn = null, cites = null) {
    const q = parseLine(text), ink = (html) => html.replace(/<strong style="font-weight:600">/g, '<strong style="color:#171717;font-weight:600">');
    const opts = this.answerOpts(turn, cites);
    if (q.type === 'h') return { content: ink(inlineHtml(q.text, opts)), look: `font:600 ${[18, 17, 16][q.level - 1]}px/1.5 var(--font-sans);color:#171717;padding-top:8px;`, minHeight: 26 };
    if (isMarked(q.type)) return { content: `<span style="display:flex;padding-left:${q.depth * 18}px"><span contenteditable="false" style="${MARK_DRAWN};color:#8f8f8f;user-select:none">${esc(listMark(q))}</span><span style="flex:1;min-width:0">${ink(inlineHtml(q.text, opts))}</span></span>`, look: 'padding-top:4px;padding-bottom:4px;', minHeight: 26 };
    return { content: ink(inlineHtml(text, opts)), look: 'text-wrap:pretty;', minHeight: text ? 26 : 22 };
  }
  // inlineHtml's options for a line of turn `turn`'s answer: its [[build]] builds that turn, drawn or with the caret on it.
  // `cites`: the answer's citation numbers (citesOf), so a circle has the same number on every line of it.
  answerOpts(turn, cites = null) {
    const build = Number.isInteger(turn) && this.props.onBuild && !this.props.readOnly;
    return build || cites ? { ...this.mentionOpts, ...(build ? { buildTurn: turn } : {}), ...(cites ? { cites } : {}) } : this.mentionOpts;
  }
  // The citation numbers of the answer line `at` is in (model/cite.js citationNumbers): each source its own, in the order
  // the answer first cites it. Kept by the answer's text, as every line of it asks while the document is drawn.
  citesOf(at) {
    if (!at || !at.turn) return null;
    const answer = turnText(this.lines(), at.turn).answer;
    if (!answer || !answer.includes('cite=')) return null;
    if (!this.citeMemo || this.citeMemo.size > 200) this.citeMemo = new Map();
    if (!this.citeMemo.has(answer)) this.citeMemo.set(answer, citationNumbers(answer));
    return this.citeMemo.get(answer);
  }
  /* ---------------------------------------------------------------- Build cards (2026-09-25) */
  // A `build> <id>` line is drawn as its Build's card, from props.builds (the record main sends), props.buildProgress
  // (what a running turn is doing) and props.buildDiffs (what it has changed). The card is in parts — head, body, live,
  // diff, reply, actions — so an update replaces only the parts it changes (patchBuilds) and a reply being typed keeps
  // its field.
  buildHtml(i, line, p) {
    const task = (this.props.builds || {})[p.id];
    const raw = `data-line="${i}" data-raw="${esc(line)}" data-build="${esc(p.id)}"`;
    const parts = this.buildParts(p.id, task);
    for (const [name, html] of parts) this.buildDrawn.set(`${p.id}:${name}`, html);
    return `<div ${raw} contenteditable="false" data-readonly="1" style="user-select:text;cursor:default;margin:6px 0 14px;padding:12px 16px 14px;background:#fafafa;border-radius:10px;font:14px/1.6 var(--font-sans);color:#4d4d4d">`
      + parts.map(([name, html]) => `<div data-build-part="${name}">${html}</div>`).join('')
      + '</div>';
  }
  // A text button of the card: grey, ink on hover (the answer card's .bart-text); `strong` is Accept's blue.
  buildButton(act, id, label, { strong = false, extra = '', run = null } = {}) {
    return `<button class="bart-text" data-act="${act}" data-build-id="${esc(id)}"${run ? ` data-run-name="${esc(run)}"` : ''} style="user-select:none;${strong ? 'color:#0070f3;' : ''}${extra}">${esc(label)}</button>`;
  }
  // The card's own buttons (2026-09-29): Accept blue, the rest white with a hairline, as in Bart's mockup.
  buildBox(act, id, label, { primary = false, disabled = false, title = '' } = {}) {
    const look = primary
      ? `padding:9px 16px;border:0;background:#0070f3;color:#fff${disabled ? ';opacity:.45' : ''}`
      : `padding:8px 12px;border:1px solid #e5e5e5;background:#fff;color:${disabled ? '#b3b3b3' : '#4d4d4d'}`;
    return `<button class="${disabled ? '' : primary ? 'hov-dim' : 'hov-ink'}" data-act="${act}" data-build-id="${esc(id)}"${disabled ? ' disabled aria-disabled="true"' : ''}${title ? ` title="${esc(title)}"` : ''} style="user-select:none;display:inline-flex;align-items:center;${look};border-radius:8px;font:500 13px/1 var(--font-sans);cursor:${disabled ? 'default' : 'pointer'}">${esc(label)}</button>`;
  }
  // What the Build has changed since it started, streamed while it works (main sends it after each step): a count, then
  // the diff in a box of its own height that scrolls, each file's header held at its top (2026-09-29).
  buildDiffHtml(id, task) {
    if (task.status === 'discarded') return '';
    const diff = (this.props.buildDiffs || {})[id];
    if (!diff) {
      if (this.props.onBuildDiffWanted && task.status !== 'setting-up') { const want = this.props.onBuildDiffWanted; Promise.resolve().then(() => want(id)); }
      return '';
    }
    if (!diff.files || !diff.files.length) return '';
    const totals = diffTotals(diff.files), { rows, cut, truncated } = diffRows(diff);
    const counts = (adds, dels) => `<span style="color:#1a7f37">+${adds}</span> <span style="color:#cf222e">−${dels}</span>`;
    const look = { hunk: 'color:#8f8f8f;background:#f8f8ff', add: 'color:#171717;background:#e6ffec', del: 'color:#171717;background:#ffebe9', ctx: 'color:#4d4d4d', note: 'color:#8f8f8f;font-family:var(--font-sans)' };
    const body = rows.map((row) => (row.kind === 'file'
      ? `<div style="position:sticky;top:0;z-index:1;display:flex;gap:8px;padding:6px 10px;background:#f5f5f5;border-bottom:1px solid #ededed;font:500 12.5px/1.4 var(--font-sans);color:#171717;white-space:nowrap"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(row.was ? `${row.was} → ${row.path}` : row.path)}</span><span style="flex:none;font-weight:400">${row.binary ? 'binary' : counts(row.adds, row.dels)}</span></div>`
      : `<div style="padding:0 10px;white-space:pre;${look[row.kind]}">${esc(row.text) || ' '}</div>`)).join('')
      + (cut || truncated ? '<div style="padding:4px 10px;font:12px/1.6 var(--font-sans);color:#8f8f8f;white-space:normal">The diff is longer than this; the rest is cut.</div>' : '');
    return `<div style="display:flex;align-items:center;gap:6px;margin-top:10px;font:12.5px/1.5 var(--font-sans);color:#8f8f8f">${totals.files} ${totals.files === 1 ? 'file' : 'files'} changed ${counts(totals.adds, totals.dels)}</div>`
      + `<div data-build-diff="${esc(id)}" style="margin-top:6px;max-height:260px;overflow:auto;overscroll-behavior:contain;background:#fff;border:1px solid #ededed;border-radius:8px;font:12px/1.7 var(--font-mono);user-select:text"><div style="min-width:max-content">${body}</div></div>`;
  }
  buildScrolled = (e) => { const box = e.target; if (box && box.dataset && box.dataset.buildDiff) this.buildScroll.set(box.dataset.buildDiff, { top: box.scrollTop, left: box.scrollLeft }); };
  // One message of the conversation. The agent's is markdown (drawn as an answer is), the person's is theirs as typed,
  // Engelbart's own notes are one grey line.
  buildMessageHtml(m) {
    if (m.role === 'engelbart') return `<div style="margin:4px 0;font:12.5px/1.5 var(--font-sans);color:#8f8f8f">${esc(m.text)}</div>`;
    if (m.role === 'you') return `<div style="margin:10px 0 6px;padding-left:12px;border-left:2px solid #c9c9c9;color:#171717;white-space:pre-wrap">${esc(m.text)}</div>`;
    const lines = String(m.text || '').split('\n'), role = new Map();
    for (const b of codeBlocks(lines)) { role.set(b.open, 'fence'); role.set(b.close, 'fence'); for (let k = b.open + 1; k < b.close; k++) role.set(k, 'code'); }
    const body = lines.map((text, n) => {
      if (role.get(n) === 'fence') return '<span style="display:block;height:6px"></span>';
      if (role.get(n) === 'code') return `<span style="display:block;min-height:22px;padding:0 10px;background:#fff;font:13px/1.7 var(--font-mono);color:#171717;white-space:pre-wrap">${esc(text) || '<br>'}</span>`;
      const a = this.answerLook(text);
      return `<span style="display:block;min-height:${text ? 22 : 10}px;${a.look}color:#4d4d4d;font-size:15px;line-height:1.65">${a.content || '<br>'}</span>`;
    }).join('');
    return `<div style="margin:6px 0">${body}</div>`;
  }
  buildParts(id, task) {
    if (!task) {
      return [['head', `<div style="display:flex;align-items:center;gap:10px"><span style="font-weight:600;color:#171717">Build</span><span style="flex:1;color:#8f8f8f">${esc(id)} is not in this project.</span>${this.buildButton('buildremove', id, 'Remove')}</div>`]];
    }
    const status = task.status, working = BUILD_WORKING.has(status) || !!task.working, final = !!task.final;
    // A turn that ended in review whose run step is still getting it running (2026-09-29): Review and Accept wait for it.
    const stepping = status === 'review' && !!task.runStep && task.runStep.status === 'running';
    const statusColor = stepping ? '#8f8f8f' : status === 'needs-you' || status === 'review' ? '#0070f3' : status === 'failed' || status === 'conflict' ? '#e70022' : '#8f8f8f';
    const head = '<div style="display:flex;align-items:baseline;gap:10px">'
      + '<span style="flex:none;font-weight:600;color:#171717">Build</span>'
      + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#171717">${esc(task.title)}</span>`
      + `<span style="flex:none;font-size:12.5px;color:#8f8f8f">${esc(task.modelName || task.model)} · ${esc(EFFORT_LABELS[task.effort] || task.effort)}</span>`
      + `<span data-build-status="${esc(stepping ? 'getting-it-running' : status)}" style="flex:none;font-size:12.5px;font-weight:500;color:${statusColor}">${esc(stepping ? 'Getting it running…' : BUILD_STATUS[status] || status)}</span>`
      + '</div>';
    // What it was given (2026-10-13, task.postIt): a line's request, a post-it's text, the panel's. Closed, one dim row;
    // open, the prompt in full, drawn as the agent's messages are, in a box that scrolls.
    const asked = typeof task.postIt === 'string' && task.postIt.trim() ? task.postIt : '', shows = !!asked && this.buildPrompt.has(id);
    const prompt = asked ? `<div style="margin-top:6px;font:13px/1.5 var(--font-sans);color:#8f8f8f"><button class="bart-text" data-act="buildprompt" data-build-id="${esc(id)}" aria-expanded="${shows}" style="user-select:none;display:inline-flex;align-items:center;gap:6px;padding-left:0;font-weight:400">Prompt${shows ? ICON.stepsOpen : ICON.stepsShut}</button></div>`
      + (shows ? `<div data-build-prompt="${esc(id)}" style="margin-top:4px;max-height:320px;overflow:auto;overscroll-behavior:contain;padding:2px 12px;background:#fff;border-radius:8px;user-select:text">${this.buildMessageHtml({ role: 'agent', text: asked })}</div>` : '') : '';
    // The conversation: from the agent's last message on; the earlier ones behind a count. A closed Build shows only its last note.
    const messages = task.messages || [];
    let from = 0;
    for (let k = messages.length - 1; k >= 0; k--) if (messages[k].role === 'agent') { from = k; break; }
    if (final) from = Math.max(0, messages.length - 1);
    const open = this.buildOpen.has(id), hidden = open ? 0 : from;
    let body = hidden ? `<button class="bart-text" data-act="buildhistory" data-build-id="${esc(id)}" style="user-select:none;padding-left:0">${hidden} earlier ${hidden === 1 ? 'message' : 'messages'}</button>` : (open && from ? `<button class="bart-text" data-act="buildhistory" data-build-id="${esc(id)}" style="user-select:none;padding-left:0">Hide earlier messages</button>` : '');
    body += messages.slice(hidden).map((m) => this.buildMessageHtml(m)).join('');
    if (status === 'needs-you' && task.question) body += `<div style="margin:10px 0 2px;padding:8px 12px;border-left:2px solid #0070f3;background:#fff;color:#171717"><strong style="font-weight:600">Needs you:</strong> ${inlineHtml(task.question, this.mentionOpts)}</div>`;
    if (status === 'escalated' && task.escalation) body += `<div style="margin:10px 0 2px;color:#171717">${esc(task.escalation)}</div>`;
    if (task.checks && !task.checks.ok && !final) body += `<div style="margin:8px 0 0;font:12px/1.6 var(--font-mono);color:#4d4d4d;white-space:pre-wrap;max-height:160px;overflow:auto;padding:8px 10px;background:#fff;border-radius:6px">$ ${esc(task.checks.command)}\n${esc(String(task.checks.output || '').split('\n').slice(-12).join('\n'))}</div>`;
    if (task.queued) body += `<div style="margin:8px 0 0;font:12.5px/1.5 var(--font-sans);color:#8f8f8f">Sending: ${esc(task.queued.length > 140 ? `${task.queued.slice(0, 139)}…` : task.queued)}</div>`;
    // While it works: what it is doing, the steps behind a count, Stop.
    let live = '';
    if (working) {
      const progress = (this.props.buildProgress || {})[id] || {};
      const doing = status === 'running' ? (progress.activity || 'Thinking') : BUILD_STATUS[status];
      const log = progress.log || [], steps = this.buildSteps.has(id);
      live = '<div style="display:flex;align-items:center;gap:10px;margin-top:10px;font:13px/1.5 var(--font-sans);color:#8f8f8f">'
        + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${waveText(esc(doing))}</span>`
        + (log.length ? `<button class="bart-text" data-act="buildsteps" data-build-id="${esc(id)}" aria-expanded="${steps}" style="user-select:none;display:inline-flex;align-items:center;gap:6px;font-weight:400">${log.length} ${log.length === 1 ? 'step' : 'steps'}${steps ? ICON.stepsOpen : ICON.stepsShut}</button>` : '')
        + (status === 'running' || status === 'queued' ? this.buildButton('buildstop', id, 'Stop') : '')
        + '</div>'
        + (steps && log.length ? `<div style="margin:4px 0 0 16px;font:12px/1.7 var(--font-sans);color:#8f8f8f">${log.map((entry) => `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry)}</div>`).join('')}</div>` : '');
    }
    // The reply field (the typed text is not in this string: restoreBuilds puts it back after a redraw). A reply sent while
    // a turn runs reaches the agent at once (2026-09-27: no Stop & send to press or see; main cuts the turn short for it).
    const reply = final || status === 'accepting' ? '' : '<div style="display:flex;align-items:flex-start;gap:10px;margin-top:12px">'
      + `<textarea data-build-input="${esc(id)}" rows="1" placeholder="${status === 'needs-you' ? 'Answer…' : 'Reply…'}" aria-label="Reply to the Build" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;display:block;height:24px;margin:0;padding:0;border:0;background:none;outline:none;resize:none;overflow:hidden;font:15px/1.6 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text"></textarea>`
      + `<button class="bart-send" data-act="buildsend" data-build-id="${esc(id)}" aria-label="Send" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:#f2f2f2;color:#8f8f8f;cursor:pointer">${ICON.send}</button>`
      + '</div>';
    // What can be done with it now (2026-09-29): Preview on the left, Reject and Accept on the right. A refused Accept
    // goes to the agent by itself (main), so there is no Send to agent; the diff is shown above.
    const acts = [];
    if (!working && !final) {
      // Preview (2026-09-29): what the run step got running, opened in the Stage (main's review); not while it gets it
      // running.
      acts.push(this.buildBox('buildpreview', id, 'Preview', stepping ? { disabled: true, title: 'Getting it running…' } : {}));
      if (['interrupted', 'stopped', 'failed'].includes(status)) acts.push(this.buildButton('buildresume', id, 'Resume'));
      acts.push('<span style="flex:1"></span>');
      acts.push(this.buildBox('buildreject', id, 'Reject'));
      acts.push(this.buildBox('buildaccept', id, 'Accept', { primary: true, disabled: stepping, title: stepping ? 'Getting it running…' : '' }));
    } else if (final) {
      if (status === 'accepted' && task.accepted) acts.push(this.buildButton('buildreview', id, 'Review'));
      if (!task.keptCopy) acts.push(this.buildButton('buildremove', id, 'Remove')); // what still runs is stopped first
    }
    // The error in red, unless the conversation's last note already says it.
    const lastNote = messages.length ? messages[messages.length - 1].text : '';
    const errorLine = task.error && !final && !lastNote.includes(task.error) ? `<div style="margin-top:8px;font:12.5px/1.5 var(--font-sans);color:#e70022">${esc(task.error)}</div>` : '';
    const actions = acts.length || errorLine ? `${errorLine}<div style="display:flex;align-items:center;gap:8px;margin-top:12px">${acts.join('')}</div>` : '';
    return [['head', head], ['prompt', prompt], ['body', body], ['run', this.buildRunHtml(id, task)], ['live', live], ['diff', this.buildDiffHtml(id, task)], ['reply', reply], ['actions', actions]];
  }
  // Its run step (main/build/run-step.cjs): while the Build is open, what the repository runs and where each stands (Review
  // opens them, 2026-09-29); while it gets them running, "Getting it running…" with its phase. An accepted Build whose copy
  // was kept for what runs: each still running on the code that landed, with Open and Stop, and Stop all (the copy goes
  // with the last one).
  buildRunHtml(id, task) {
    const step = task.runStep;
    const kept = !!task.final && task.status === 'accepted' && !!task.keptCopy;
    if (!step || step.status === 'skipped' || (task.final && !kept)) return '';
    const working = step.status === 'running';
    const kinds = { ui: 'web UI', app: 'desktop app', terminal: 'terminal' };
    const tight = 'padding-top:0;padding-bottom:0;';
    const rows = (step.runnables || []).filter((item) => !kept || item.passed || item.status === 'running').map((item) => {
      const runs = item.status === 'running';
      const opens = kept && runs ? this.buildButton('buildrunshow', id, item.type === 'ui' ? 'Open' : item.type === 'app' ? 'Window' : 'Terminal', { extra: tight, run: item.name }) + this.buildButton('buildrunstopone', id, 'Stop', { extra: tight, run: item.name }) : '';
      const state = { running: item.type === 'app' ? 'runs in its window' : item.url ? `runs at ${item.url}` : 'runs', failed: 'did not run', stopped: 'stopped', installing: 'installing', checking: 'checking' }[item.status] || 'waiting';
      const color = runs ? '#1a7f37' : item.status === 'failed' ? '#e70022' : '#8f8f8f';
      return `<div data-run-item="${esc(item.name)}" style="display:flex;align-items:baseline;gap:8px;min-width:0">`
        + `<span style="flex:none;color:#171717">${esc(item.name)}</span><span style="flex:none;color:#8f8f8f">${esc(kinds[item.type] || item.type)}</span>`
        + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${color}" title="${esc(item.error || '')}">${esc(state)}${item.status === 'failed' && item.error ? ` · ${esc(String(item.error).split('\n')[0])}` : ''}</span>${opens}</div>`;
    }).join('');
    const label = kept ? 'Running on what landed' : working ? 'Getting it running…' : 'Run step';
    const note = kept ? '' : working ? (step.phase || 'Working') : step.status === 'failed' ? step.error || 'Failed' : step.status === 'stopped' ? 'Stopped' : (step.runnables || []).length ? 'Preview opens what runs' : 'Nothing here to run';
    const head = '<div style="display:flex;align-items:center;gap:10px">'
      + `<span${working && !kept ? ' class="eb-wave"' : ''} style="flex:none;font-weight:500;color:#171717">${label}</span>`
      + `<span data-run-status="${esc(kept ? 'kept' : step.status)}" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${step.status === 'failed' && !kept ? '#e70022' : '#8f8f8f'}">${esc(note)}</span>`
      + (working && !kept ? this.buildButton('buildrunstop', id, 'Stop') : '')
      + (kept ? this.buildButton('buildrunstopall', id, 'Stop all') : '')
      + '</div>';
    return `<div data-run-step="${esc(id)}" style="margin-top:10px;padding:8px 12px;border-radius:8px;background:#fff;font:12.5px/1.7 var(--font-sans)">${head}${rows}</div>`;
  }
  // Only the parts that changed are replaced; a reply field that was replaced gets its text and the keyboard back.
  patchBuilds() {
    const ed = this.editorEl(); if (!ed || this.lastKey !== this.key()) return false;
    const ls = this.lines();
    for (const d of ed.querySelectorAll('[data-build]')) {
      const i = Number(d.dataset.line), p = parseLine(ls[i] ?? ''); if (p.type !== 'build' || p.id !== d.dataset.build) return false;
      for (const [name, html] of this.buildParts(p.id, (this.props.builds || {})[p.id])) {
        const key = `${p.id}:${name}`; if (this.buildDrawn.get(key) === html) continue;
        const part = d.querySelector(`[data-build-part="${name}"]`); if (!part) return false;
        const field = document.activeElement, had = field && part.contains(field) && field.matches('[data-build-input]') ? { a: field.selectionStart, b: field.selectionEnd } : null;
        part.innerHTML = html; this.buildDrawn.set(key, html); keepWaves(part);
        this.restoreBuilds(part, had ? { key: p.id, ...had } : null);
      }
    }
    this.lastHtml = this.editorHtml(); return true;
  }
  restoreBuilds(root, had) {
    for (const box of root.querySelectorAll('[data-build-diff]')) {
      const at = this.buildScroll.get(box.dataset.buildDiff);
      if (at) { box.scrollTop = at.top; box.scrollLeft = at.left; }
    }
    for (const input of root.querySelectorAll('[data-build-input]')) {
      const text = this.buildText.get(input.dataset.buildInput) || '';
      if (text) input.value = text;
      this.paintBuildSend(input); this.fitFollow(input);
      if (had && had.key === input.dataset.buildInput) { input.focus({ preventScroll: true }); try { input.setSelectionRange(had.a, had.b); } catch { /* not a text selection */ } }
    }
  }
  paintBuildSend(input) {
    const send = input.parentElement && input.parentElement.querySelector('[data-act="buildsend"]'); if (!send) return;
    const ready = !!input.value.trim(); send.style.background = ready ? '#0070f3' : '#f2f2f2'; send.style.color = ready ? '#fff' : '#8f8f8f';
  }
  buildInput(input) { this.buildText.set(input.dataset.buildInput, input.value); this.paintBuildSend(input); this.fitFollow(input); }
  // Enter sends; Shift+Enter is a new line of the reply (unlike a follow-up, a reply is not a line of the document).
  buildKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendBuild(e.target.dataset.buildInput); }
    else if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
  }
  // An image pasted into a reply (2026-09-29) is saved as a pasted image of the document is (the parent's onPasteImage)
  // and named in the text as [Attachment n], numbered across the Build; main hands the agent the file for each one.
  buildPaste(e) {
    const input = e.target, id = input.dataset.buildInput;
    const pasted = [...(((e.clipboardData || {}).files) || [])].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (!pasted.length || !this.props.onPasteImage) return; // text pastes as text
    e.preventDefault();
    void (async () => {
      for (const file of pasted) {
        const task = (this.props.builds || {})[id], draft = this.buildImages.get(id) || [];
        const n = nextAttachment(task && task.messages, draft);
        this.buildImages.set(id, [...draft, { n, id: null }]); // holds the number while it saves
        let saved = null;
        try { saved = await this.props.onPasteImage(file, `Attachment ${n}`); } catch { saved = null; }
        const held = (this.buildImages.get(id) || []).filter((image) => image.n !== n);
        if (!saved || !saved.id || !this.mounted) { this.buildImages.set(id, held); continue; }
        this.buildImages.set(id, [...held, { n, id: saved.id }]);
        const field = this.editorEl() && this.editorEl().querySelector(`[data-build-input="${id}"]`);
        const token = `[Attachment ${n}]`;
        if (field) {
          const a = field.selectionStart ?? field.value.length, b = field.selectionEnd ?? a, before = field.value.slice(0, a);
          const ins = `${before && !/\s$/.test(before) ? ' ' : ''}${token} `;
          field.setRangeText(ins, a, b, 'end');
          this.buildInput(field);
        } else {
          const text = this.buildText.get(id) || '';
          this.buildText.set(id, `${text}${text && !/\s$/.test(text) ? ' ' : ''}${token} `);
        }
      }
    })();
  }
  sendBuild(id) {
    const text = (this.buildText.get(id) || '').trim(); if (!text || !this.props.onBuildAction) return;
    const images = (this.buildImages.get(id) || []).filter((image) => image.id && text.includes(`[Attachment ${image.n}]`));
    Promise.resolve(this.props.onBuildAction(id, 'reply', { text, interrupt: true, images })).then((ok) => {
      if (ok === false) return;
      this.buildText.delete(id); this.buildImages.delete(id);
      const input = this.editorEl() && this.editorEl().querySelector(`[data-build-input="${id}"]`);
      if (input) { input.value = ''; this.paintBuildSend(input); this.fitFollow(input); }
    }).catch(() => {});
  }
  buildAct(k, id, runName) {
    // Its prompt opens and closes where nothing can be done with the Build (a read-only document) too.
    if (k === 'buildprompt') { if (this.buildPrompt.has(id)) this.buildPrompt.delete(id); else this.buildPrompt.add(id); this.patchBuilds(); return; }
    const act = this.props.onBuildAction; if (!act) return;
    if (k === 'buildrunshow') { act(id, 'runshow', { name: runName }); return; }
    if (k === 'buildrunstop') { act(id, 'runstop'); return; }
    if (k === 'buildrunstopone') { act(id, 'runstopone', { name: runName }); return; }
    if (k === 'buildrunstopall') { act(id, 'runstopall'); return; }
    if (k === 'buildhistory') { if (this.buildOpen.has(id)) this.buildOpen.delete(id); else this.buildOpen.add(id); this.patchBuilds(); return; }
    if (k === 'buildsteps') { if (this.buildSteps.has(id)) this.buildSteps.delete(id); else this.buildSteps.add(id); this.patchBuilds(); return; }
    if (k === 'buildsend') { this.sendBuild(id); return; }
    if (k === 'buildremove') { this.setLines((ls) => { const out = ls.filter((l) => !(parseLine(l).type === 'build' && parseLine(l).id === id)); return out.length ? out : ['']; }); return; }
    // Reject asks first (the parent's modal), then discards.
    // Preview (and an accepted Build's Review) is main's review: what the run step got running, in the Stage.
    act(id, { buildstop: 'stop', buildpreview: 'review', buildreview: 'review', buildaccept: 'accept', buildreject: 'reject', buildresume: 'resume' }[k]);
  }

  // Where every line of an @bart card stands in it: which turn it belongs to, whether it opens or closes the card, and
  // what is drawn after it that is not a line (a foot for an answer that has no closing line; the follow-up field).
  // `agent` is the turn's; an @brainstorm answer that is a card is drawn on its first line (`card`) and the rest of its
  // lines are `underCard`. A live card is answered in its thread's follow-up field (answerFieldHtml); the question line of
  // a turn that answers a card has that card (`answers`), drawn as said (answerShown). `editable`: whether the turn's
  // question can be edited in place (canEdit).
  layout(ls) {
    const at = new Map(), ps = this.parsedOf(ls), cards = this.cardsOf(ls);
    let shut = -2; // the last line of the collapsed conversation drawn last, whose row a row right under it is ruled off from
    const all = threads(ls, ps), latest = this.latestTurn(ls, all);
    for (const thread of all) {
      // A titled conversation (2026-10-12): open, its title is not drawn and the card starts at its question; collapsed, the
      // title's row is the one row drawn for it all. (`ruled` is no longer drawn: collapsed rows are cards of their own.)
      const titled = thread.titleLine >= 0, collapsed = isCollapsed(thread, this.props.builds);
      if (titled) at.set(thread.titleLine, { thread, agent: thread.agent, role: 'title', collapsed, running: isRunning(thread, this.props.builds), ruled: collapsed && shut === thread.titleLine - 1 });
      if (collapsed) {
        shut = thread.to;
        for (let i = thread.from; i <= thread.to; i++) at.set(i, { thread, turn: thread.turns.find((turn) => i >= turn.q && i <= turn.to), agent: thread.agent, role: 'hidden', hidden: true });
        continue;
      }
      const end = thread.turns[thread.turns.length - 1];
      // A Build's card right under the conversation (2026-10-13: the one a reply was written over, or one built from it) is
      // where it goes on: the conversation has no follow-up field above it.
      const built = (ps[thread.to + 1] || {}).type === 'build';
      const follow = end.answered && !end.pending && !end.folded && !!this.props.onAsk && !built && !end.build;
      // Under the last turn: its reply field, always (2026-10-16, Hudson: Reply had to be clicked first), whatever answered
      // it, and a live card's answer is typed there too; after an @brainstorm recap, Send to Discover's row. Without either
      // the button row closes the card.
      const endCard = cards.byQ.get(end.q), live = !!endCard && endCard.live, inCard = live && this.boxedCard(endCard);
      // Refine (2026-10-15, David): on the reply that said what Discover will look for, the turn before the conversation's
      // last research box, whether that box waits, runs or is done. Its field (refineOpen) opens under that reply's button
      // row, and is the conversation's reply field there (one field a conversation): none at its end meanwhile.
      const boxAt = thread.turns.map((turn) => isResearch(ps[turn.q])).lastIndexOf(true), said = boxAt > 0 ? thread.turns[boxAt - 1] : null;
      const intent = said && said.answered && !said.pending && !said.folded && this.props.onAsk && !this.props.readOnly ? said : null;
      const refineHere = !!intent && this.refineOpen.has(thread.from);
      // No Refine button (2026-10-16, David's mockup): a box's plan is adjusted by replying under it.
      // A Discover card's field is inside it (2026-10-15): the conversation has none under it.
      // A conversation ending in a research box (2026-10-16, David's mockup) has its reply line under the box whatever the
      // box's state: waiting or cut short, what is typed there adjusts the plan (sendFollow, sendRefine); running (2026-10-16,
      // David: "the same as everywhere else"), it adjusts the search as it goes (steerResearch).
      const endBox = isResearch(ps[end.q]) ? this.boxState(ls, end) : null;
      const boxField = !!endBox && !end.folded && !built && !!this.props.onAsk && !this.props.readOnly;
      const field = boxField || (follow && !inCard && !refineHere && !this.props.readOnly), after = field || (follow && this.endsInRecap(ls, thread));
      // A collapsed turn (2026-10-13) is drawn bare, as one row (foldedHtml) with no foot, at the top of the card: the
      // question under it starts 18px below the last of them.
      // An @discover research box (2026-10-13, doc.js isResearch) is drawn inside the card of the reply that asked for it
      // (2026-10-16, David: it was a card of its own), its line the box's head (researchHtml). `cut`: the turn's last row
      // closes the card, a line not asked yet coming next.
      let afterBare = false;
      thread.turns.forEach((turn, n) => {
        const agent = this.turnAgent(thread, turn), card = cards.byQ.get(turn.q), editable = this.canEdit(ps[turn.q], turn, card);
        // A line not asked yet is a message box of its own (2026-10-13): the card above it closes, as above a research box.
        const bare = turn.answered && !turn.pending && turn.folded, box = isResearch(ps[turn.q]), next = thread.turns[n + 1], cut = !!next && !isResearch(ps[next.q]) && !next.answered;
        const nextBare = !!next && next.answered && !next.pending && next.folded && !isResearch(ps[next.q]);
        const answers = n > 0 ? cards.byQ.get(thread.turns[n - 1].q) || null : null;
        const footless = turn.answered && !turn.pending && turn.foot < 0, tail = turn === end, shuts = (tail && !after) || (cut && !(refineHere && turn === intent));
        // An @bart answer (2026-10-15, David's reference), and whether it is older than the latest one asked.
        const chat = this.isChat(agent, turn, card, box), older = chat && turn.q !== latest;
        const boxState = box ? this.boxState(ls, turn) : null, waitsHere = boxState === 'ready' && tail && field; // the reply line follows a box not started
        // A folded turn's row (lineHtml foldedHtml) closes the card when its foot would have: its foot is not drawn.
        at.set(turn.q, { thread, turn, agent, role: 'question', top: turn.q === thread.from || box || !turn.answered, afterBare, lastBare: !nextBare, closes: (!turn.answered && !waitsHere) || !!turn.build || (bare && !box && shuts), editable: editable && !box, bare, box, boxState, answers, chat, older, fieldAfter: waitsHere });
        afterBare = bare;
        if (turn.build) return; // its answer is the Build's card, drawn as a card is (buildHtml), not as an answer's rows
        const gap = turn.foot > turn.from && parseLine(ls[turn.foot - 1]).text === '' ? turn.foot - 1 : -1;
        const lastBody = (turn.foot >= 0 ? turn.foot : turn.to + 1) - (gap >= 0 ? 2 : 1);
        for (let i = turn.from; i <= turn.to; i++) {
          const role = i === turn.foot ? 'foot' : parseLine(ls[i]).type === 'pending' ? 'pending' : 'answer', ends = i === turn.to;
          const drawn = card && i <= card.last ? { card: i === turn.from ? card : null, underCard: i !== turn.from } : {};
          at.set(i, { thread, turn, agent, role, gap: i === gap, first: i === turn.from, lastBody: i === lastBody, closes: ends && shuts && !footless, footAfter: ends && footless, followAfter: ends && tail && follow, fieldAfter: ends && tail && field, drawnAfter: tail && after, refine: null, refineAfter: ends && refineHere && turn === intent, tail, cut, box, boxState, editable: editable && !box, chat, older, ...drawn });
        }
      });
    }
    return at;
  }
  // A research box's state (2026-10-16, David's mockup): 'ready' (nothing has run), 'running' (its search, or a Deep box's
  // wait, is at work), 'interrupted' (its pending line's run is gone: the app closed on it), 'stopped' (`bart> Stopped.`),
  // 'failed' (`bart> **No answer.** …`), else 'finished'.
  boxState(ls, turn) {
    if (turn.pending) return (this.props.asks || {})[turn.pending] || this.waits.has(turn.pending) ? 'running' : 'interrupted';
    if (!turn.answered) return 'ready';
    const said = parseLine(ls[turn.from] ?? '').text.trim();
    return said === 'Stopped.' ? 'stopped' : /^\*\*No answer\.\*\*/.test(said) ? 'failed' : 'finished';
  }
  // An @bart answer drawn in the 2026-10-15 restyle (chatLineHtml, chatFootHtml, chatMoreHtml, chatFieldHtml). Off since
  // 2026-10-16 (David: back to the cards as they were before it); every answer is drawn as any other answer.
  isChat() { return false; }
  // The exchange asked last in this document (2026-10-15, David): the newest run's (an ask id starts with the time it was
  // asked), kept by its question's line once it has answered; else the last one in the document asked (a line not sent
  // yet is not one). → its question's line.
  latestTurn(ls, all) {
    const nth = (q) => { let n = 0; for (let j = 0; j < q; j++) if (ls[j] === ls[q]) n++; return n; };
    let best = null;
    for (const thread of all) for (const turn of thread.turns) {
      if (!turn.pending) continue;
      const t = parseInt(String(turn.pending).split('-')[0], 36) || 0;
      if (!best || t >= best.t) best = { t, q: turn.q };
    }
    if (best) this.lastAsked = { doc: this.props.docKey, line: ls[best.q], nth: nth(best.q) };
    const turns = all.flatMap((thread) => thread.turns).filter((turn) => turn.answered || turn.pending), was = this.lastAsked && this.lastAsked.doc === this.props.docKey ? this.lastAsked : null;
    const kept = was ? turns.find((turn) => ls[turn.q] === was.line && nth(turn.q) === was.nth) : null;
    return kept ? kept.q : turns.length ? turns[turns.length - 1].q : -1;
  }
  // Whether a turn's question can be edited in place (2026-10-03): answered and not at work, in an editor that can ask and
  // be written in; not a Build (`@bart --build`), and not a turn whose answer is a card (cardsOf).
  // The agent a turn is with (2026-10-13): the one its closing line or its line names (doc.js turn.agent), else, for an
  // `@bart` line at work, the one Bart handed it to (props.asks), else the thread's.
  turnAgent(thread, turn) {
    if (turn && turn.agent) return turn.agent;
    const ask = turn && turn.pending && this.props.asks ? this.props.asks[turn.pending] : null;
    return ask && (ask.agent === 'bart' || ask.agent === 'brainstorm' || ask.agent === 'discover') ? ask.agent : thread.agent;
  }
  canEdit(p, turn, card) {
    return !!this.props.onAsk && !this.props.readOnly && turn.answered && !turn.pending && !card && !buildRequestOf({ agent: agentOf(p), text: p.text });
  }
  /* ---------------------------------------------------------------- @brainstorm cards (2026-09-30) */
  // One card, drawn as any answer is (2026-10-13, David: "the same function, but not visually different from a normal
  // @chat thread"): on the answer's grey, inside its rule, in its type. What it says (`say`), then its question, then its
  // options as a list whose rows are buttons: a click on one of a single choice answers with it, with what is typed in the
  // field under the card as a note; a click on one of a select-all ticks it, and Enter in the field (or its send) answers
  // with every row ticked. A free or open question is answered in that field. Skip and Wrap up are on the foot. The field
  // is the thread's follow-up field (answerFieldHtml), so nothing is typed on the card itself. A map card (the first of an
  // exchange, 2026-09-30) says where the person seems to be first, as three short sections. An answered card is drawn
  // still, its picks ticked; what was answered is on the question line under it (answerShown). @discover's cards keep
  // their subtitle; @brainstorm's have none.
  // A card drawn as David's mock has it (2026-10-14): @discover's single choice, and @brainstorm's (2026-10-16, David). Any
  // number of its rows are picked (2026-10-16, David), then sent with Submit, from a field of its own inside it; it has no follow-up field under its button row.
  boxedCard(entry) { return !!entry && (entry.agent === 'discover' || entry.agent === 'brainstorm') && questionOf(entry.card).type !== 'select_all' && isChoice(questionOf(entry.card).type); }
  cardHtml(raw, entry) {
    const { card, turn, live, answer } = entry, q = turn.q, asked = questionOf(card), state = this.cardState.get(q) || {};
    const choice = isChoice(asked.type), many = asked.type === 'select_all';
    const picks = live ? state.picks || [] : answer ? answer.picks : [];
    const parts = [];
    if (card.map) {
      for (const group of MAP_GROUPS.filter((g) => card.map[g].length)) {
        parts.push(`<span data-card-map="${group}" style="display:block">${this.recapLabelHtml(MAP_LABELS[group], true)}`
          + card.map[group].map((item) => `<span style="display:flex"><span aria-hidden="true" style="${MARK_DRAWN};color:#8f8f8f">•</span><span style="flex:1;min-width:0">${textMathHtml(item.text)}${item.from ? `<span style="color:#8f8f8f"> · ${esc(item.from)}</span>` : ''}</span></span>`).join('')
          + '</span>');
      }
    }
    if (card.say) parts.push(`<span data-card-say="1" style="display:block;white-space:pre-wrap">${textMathHtml(card.say)}</span>`);
    parts.push(`<span data-card-question="1" style="display:block;color:#171717">${textMathHtml(asked.title)}</span>`);
    // No eyebrow over the question (2026-09-30, David): the card's own `eyebrow` ("FOCUS", "YOUR OWN RESEARCH") is kept, not drawn.
    // Nor, on a brainstorm card, its subtitle (2026-09-30, David: too much to read). @discover's stays.
    const sub = (fixedStep(entry.agent) ? '' : asked.subtitle) || (many ? 'Pick any, then press Enter.' : '');
    if (sub) parts.push(`<span style="display:block;font-size:14px;color:#8f8f8f">${esc(sub)}</span>`);
    if (this.boxedCard(entry)) {
      // Answered, another row may be picked in place of what was (repickCard), once nothing in the conversation is at work:
      // first asked (askRepick), since what came after it goes.
      const again = this.repickable(entry), asking = again && this.repick && this.repick.q === q ? asked.options[this.repick.n] : null;
      parts.push(`<span class="dv-opts" role="group" aria-label="${esc(asked.title)}">` + asked.options.map((option, n) => {
        const on = picks.includes(option.label);
        const act = live ? `data-act="cardopt" data-turn="${q}" data-opt="${n}"` : again && !on ? `data-act="cardrepick" data-turn="${q}" data-opt="${n}" title="Pick this instead: the conversation starts again from it"` : 'disabled';
        return `<button type="button" class="dv-opt" ${act}${asking === option ? ' data-repicking="1"' : ''} role="checkbox" aria-checked="${on}"><span aria-hidden="true" class="dv-check">${DV_CHECK}</span><span style="flex:1;min-width:0"><span class="dv-label">${textMathHtml(option.label)}</span>${option.why ? `<span class="dv-why">${textMathHtml(option.why)}</span>` : ''}</span></button>`;
      }).join('') + '</span>');
      if (asking) {
        parts.push(`<span class="dv-confirm" data-repick-confirm="${q}" role="alertdialog" aria-label="Pick this instead?"><span class="dv-confirm-text">Pick <b>${textMathHtml(asking.label)}</b> instead? Everything after this will be asked again from that pick.</span>`
          + `<span class="dv-confirm-btns"><button type="button" class="dv-cancel" data-act="cardrepickno" data-turn="${q}">Cancel</button><button type="button" class="dv-restart" data-act="cardrepickgo" data-turn="${q}" data-opt="${this.repick.n}">Restart from here</button></span></span>`);
      }
      if (live) {
        const from = entry.thread.from, ready = picks.length > 0;
        parts.push(`<span class="dv-own" data-answers="${q}"><span class="dv-field"><textarea data-follow-input="${from}" data-agent="${entry.agent}"${ready ? ' data-empty="1"' : ''} rows="1" spellcheck="false" autocomplete="off" placeholder="${entry.agent === 'brainstorm' && asked.id === 'versions' ? 'Or rewrite it yourself…' : 'Or say it in your own words…'}" aria-label="Answer"></textarea></span>`
          + `<button type="button" class="dv-submit" data-act="sendfollow" data-thread="${from}" style="background:${ready ? '#0070f3' : '#f2f2f2'};color:${ready ? '#fff' : '#8f8f8f'}">Submit</button></span>`);
      }
    } else if (choice) {
      parts.push(`<span role="${many ? 'group' : 'radiogroup'}" aria-label="${esc(asked.title)}" style="display:block">` + asked.options.map((option, n) => {
        const on = picks.includes(option.label);
        return `<button type="button" class="bs-row" ${live ? `data-act="cardopt" data-turn="${q}" data-opt="${n}"` : 'disabled'} role="${many ? 'checkbox' : 'radio'}" aria-checked="${on}"><span aria-hidden="true" class="bs-mark">${on ? '✓' : '•'}</span><span class="bs-label">${textMathHtml(option.label)}${option.why ? `<span class="bs-why"> · ${textMathHtml(option.why)}</span>` : ''}</span></button>`;
      }).join('') + '</span>');
    }
    return `<div ${raw} data-card="${q}" contenteditable="false" data-readonly="1" style="user-select:text;cursor:default;padding:12px 16px 0;background:#fafafa;color:#262626;font-size:16px;line-height:1.65">`
      + `<span style="display:block;padding:2px 0 2px 14px;border-left:2px solid #d6d6d6">`
      + parts.join('<span aria-hidden="true" style="display:block;height:10px"></span>')
      + '</span></div>';
  }
  // A question line that answers a card (layout's `answers`), as said: the picks, a note after them, their own words,
  // Skipped or Wrapped up. The line keeps what main reads ("picked \"a\", \"b\"; note: …").
  answerShown(entry) {
    const said = entry.answer; if (!said) return '';
    const grey = (text) => `<span style="color:#8f8f8f">${esc(text)}</span>`;
    const given = said.picks.length ? said.picks.map(esc).join(', ') + (said.note ? ` · ${esc(said.note)}` : '') : esc(said.text);
    if (said.wrap) return given ? `${given} ${grey('· Wrapped up')}` : grey('Wrapped up');
    return said.skipped ? grey('Skipped') : given;
  }
  // A choice clicked on a live card: one of a single choice answers with it; one of a select-all, or of a card drawn as
  // David's mock (boxedCard: any number, 2026-10-16, David), is ticked, or unticked.
  pickCard(q, n) {
    const entry = this.cardsOf(this.lines()).byQ.get(q); if (!entry || !entry.live) return;
    const asked = questionOf(entry.card), option = asked.options[n]; if (!option) return;
    const state = this.cardState.get(q) || {}, held = state.picks || [], on = held.includes(option.label);
    if (asked.type !== 'select_all' && !this.boxedCard(entry)) { this.cardState.set(q, { ...state, picks: [option.label] }); this.sendCard(q); return; }
    const picks = asked.options.map((o) => o.label).filter((label) => (label === option.label ? !on : held.includes(label)));
    this.cardState.set(q, { ...state, picks }); this.lastHtml = null; this.forceUpdate();
  }
  // An answered @discover choice (2026-10-15, David): another of its rows can be picked while nothing in its conversation
  // is at work. The line that answered it says the new pick, every turn after that line goes, and the line is asked again
  // (regenerate, as an edited question is: undo puts it all back), its reply field opening on what comes back.
  repickable(entry) {
    return !!entry && !entry.live && !!entry.answer && !this.props.readOnly && !!this.props.onAsk && this.boxedCard(entry)
      && !entry.thread.turns.some((turn) => turn.pending);
  }
  // A row of it pressed (2026-10-15, David: "it should ask me if i want to do that since it will restart from that new
  // selection"): the restart is asked under the rows, Restart from here doing it (repickCard), Cancel or Escape not. Another
  // row pressed meanwhile is asked instead.
  askRepick(q, n) {
    const entry = this.cardsOf(this.lines()).byQ.get(q); if (!this.repickable(entry)) return;
    const option = questionOf(entry.card).options[n]; if (!option || entry.answer.picks.includes(option.label)) return;
    this.repick = { q, n }; this.lastHtml = null; this.forceUpdate();
  }
  // → whether one was being asked
  cancelRepick() {
    if (!this.repick) return false;
    this.repick = null; this.lastHtml = null; this.forceUpdate(); return true;
  }
  repickCard(q, n) {
    this.repick = null;
    const ls = this.lines(), entry = this.cardsOf(ls).byQ.get(q); if (!this.repickable(entry)) return;
    const option = questionOf(entry.card).options[n]; if (!option || entry.answer.picks.includes(option.label)) return;
    const { thread } = entry, next = thread.turns[thread.turns.indexOf(entry.turn) + 1]; if (!next) return;
    const models = this.props.models, text = parseLine(ls[next.q]).text;
    const flags = models && entry.agent === 'discover' ? discoverSpans(text, models).map(([a, b]) => text.slice(a, b)).join(' ') : '';
    const line = `${leadOf(ls[next.q], entry.agent)} ${[flags, answerLine(entry.card, { picks: [option.label], note: '' })].filter(Boolean).join(' ')}`;
    const later = thread.turns.filter((turn) => turn.q > next.q);
    const kept = later.length ? [...ls.slice(0, later[0].q), ...ls.slice(thread.to + 1)] : ls;
    const lines = kept.map((l, j) => (j === next.q ? line : l));
    const askId = this.regenerate(next.q, undefined, { lines, undo: { text: ls.join('\n'), caret: null, mark: this.history.length } });
    if (askId) this.expectReply(askId);
  }
  // An answer to the live card (BS-06): sent from the field under it (sendFollow), a single choice clicked (pickCard), Skip
  // (`how` 'skip') or Wrap up ('wrap', round 6; @brainstorm only) on its foot. What the field holds is the answer to a free
  // or open question, and to a choice the person's own words in place of a pick, or a note to the picks. It goes under the
  // card as an @brainstorm (or @discover) line of its own, with the pending line under it, and is asked as a follow-up is;
  // the turns before it but the last collapse, as a follow-up's do (foldOlder). Wrap up writes what was picked or typed, if anything,
  // then "; (wrap up)", or "(wrap up)" alone. Flags of the line before carry on, as they do for @bart.
  // @discover's (2026-10-15, David): nothing collapses (the card stays as it was answered), and its reply field opens on
  // the question that comes back, with the keyboard in it (expectReply); a reply that starts the search opens none (the
  // box is the last turn then).
  sendCard(q, how = 'submit') {
    const ls = this.lines(), entry = this.cardsOf(ls).byQ.get(q); if (!entry || !entry.live || !this.props.onAsk) return;
    const { thread, card, agent } = entry, skip = how === 'skip', wrap = how === 'wrap';
    if (wrap && !fixedStep(agent)) return;
    const typed = this.followText.get(thread.from) || '', state = this.cardState.get(q) || {};
    const given = skip ? SKIPPED : answerLine(card, isChoice(questionOf(card).type) ? { picks: state.picks, note: typed } : { text: typed });
    if (how === 'submit' && given === SKIPPED) return; // nothing picked or typed yet: it waits
    const said = wrap ? withWrap(given) : given;
    const { flags } = this.followStep(ls, thread), text = [flags, said].filter(Boolean).join(' ');
    const askId = newAskId(), add = [`@${tokenOf(agent)} ${text}`, `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const turns = thread.turns.filter((turn) => turn.answered && !turn.pending).map((turn) => withAgent(turnText(ls, turn), turn));
    this.cardState.delete(q); this.followText.delete(thread.from); this.followImages.delete(thread.from);
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    const discover = agent === 'discover';
    this.setLines((x) => { const out = discover ? [...x] : foldOlder(x, thread.turns); out.splice(thread.to + 1, 0, ...add); return out; });
    this.setState({ activeLine: null, mention: null });
    if (discover) this.expectReply(askId);
    this.props.onAsk({ askId, text, turns, agent, place: { line: thread.to + 1, text: add[0] } });
  }
  findTurn(ls, q) { for (const thread of threads(ls)) { const turn = thread.turns.find((t) => t.q === q); if (turn) return { thread, turn }; } return null; }
  // A conversation's title (2026-10-12, `bart# …` above the question that starts it). Open, it is not drawn: the card
  // starts at its question, rounded, and Collapse is on the foot. Collapsed (`bart#+ …`), it is all that shows of the
  // conversation: a link (2026-10-13, Hudson's: "just a hyperlink with the agent's icon"), the Agents pointer and the title
  // in the link's blue at the document's size, nothing around it; on its right, when it was asked (whenShown), never the
  // agent (2026-10-15, David: the agent went, the time came back). A click expands it; an ⌥-click makes the title a field to rename it in (titleEdit). While
  // a run is at work it cannot collapse. An empty title is still being named: the line stays in the file for main's
  // name-chat to fill. Collapsed with no title (a line emptied by hand), the link is the conversation's opening question.
  titleHtml(i, raw, p, at) {
    if (!at.collapsed) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
    const { thread } = at, title = p.text.trim();
    const editingTitle = !!this.titleEdit && this.titleEdit.line === i;
    const made = editingTitle ? [] : thread.turns.flatMap((turn) => this.madeInTurn(this.lines(), turn));
    const name = agentName(thread), when = whenShown(thread.at);
    const first = thread.turns && thread.turns[0], shown = title || (first ? questionLine(turnText(this.lines(), first).question, 60) : '') || name;
    const editing = !!this.titleEdit && this.titleEdit.line === i;
    // Under it, the 8px an open card has under its last row (2026-10-17): a press there lands on the editor, and gapAt puts
    // the caret on a line under the conversation, as it does under an open one (two collapsed ones had no space between).
    // It is margin, outside the row: the row's own click target stays its 42px.
    const under = 'margin-bottom:8px';
    const row = `<div ${made.length ? '' : raw} contenteditable="false" data-readonly="1" data-thread-row="${i}" style="user-select:none;display:flex;align-items:center;gap:12px;min-width:0;height:42px;box-sizing:border-box;font:15px/1.4 var(--font-sans)${made.length ? '' : `;${under}`}">`;
    if (editing) {
      return row + `<span style="flex:none;display:inline-flex;color:#0070f3;margin-right:-4px">${ICON.pointer}</span>`
        + `<input data-title-input="${i}" value="${esc(this.titleEdit.value)}" aria-label="Conversation title" spellcheck="false" autocomplete="off" maxlength="200" style="flex:1;min-width:0;margin:0;padding:0;border:0;background:none;outline:none;font:15px/1.4 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text">`
        + '</div>';
    }
    // Still at work (collapsed while it runs, 2026-10-15): the title in the grey wave of other text at work (.eb-wave, put
    // on the page's clock by keepWaves) and its pointer in grey, not the link's blue; no spinner, and no time until it is done
    // (2026-10-17, David: the blue title and spinner went).
    const running = !!at.running;
    const link = row + `<span class="bart-link" data-act="foldthread" data-row="${i}"${running ? ' data-thread-running="1" aria-busy="true"' : ''} role="button" tabindex="0" aria-label="${esc(`Expand ${shown}`)}" aria-expanded="false" title="⌥-click to rename" style="flex:0 1 auto;display:inline-flex;align-items:center;gap:8px;min-width:0">`
      + `<span style="flex:none;display:inline-flex${running ? ';color:#8f8f8f' : ''}">${ICON.pointer}</span>`
      + `<span class="bart-thread-name${running ? ' eb-wave' : ''}" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(shown)}</span>`
      + '</span>'
      + (!running && when ? `<span data-thread-when="1" style="flex:none;margin-left:auto;font:12px/1 var(--font-sans);color:#8f8f8f;white-space:nowrap">${esc(when)}</span>` : '')
      + '</div>';
    // A Create conversation (2026-10-14): its files' rows stay under its title, each on a line of its own, flush with the
    // title's icon (2026-10-15, David: not indented under its words).
    return made.length ? `<div ${raw} contenteditable="false" data-readonly="1" data-made-folded="1" style="user-select:none;${under}">${link}<div style="padding:0 0 6px">${made.map((one) => this.madeHtml(one, { inCard: false })).join('')}</div></div>` : link;
  }
  // A Brainstorm conversation's topic chip (2026-10-14): beside its first question, the label its title holds, in the
  // look of a line's model chip (plain words and a chevron). None until the conversation has a topic (topicOfThread):
  // Brainstorm marks it once the person says what they want to talk about (Workspace askBart retitleTo). A click opens
  // TopicMenu: Rename topic, Change topic. Open, the question has it on a line of its own under it, "Topic: …"
  // (topicLineHtml; 2026-10-16, David: beside the question it competed with it); its folded row keeps it beside.
  // Not drawn since 2026-10-16 (David: "just remove this"); the topic is still the conversation's title.
  topicChipHtml(i, at, own = false) {
    if (TOPIC_CHIP_SHOWN !== true) return '';
    const thread = at && at.thread, topic = thread && thread.titleLine >= 0 && thread.turns[0] && thread.turns[0].q === i ? topicOfThread(thread) : '';
    if (!topic) return '';
    const open = !!this.state.topicMenu && this.state.topicMenu.line === thread.titleLine;
    return `<span contenteditable="false" data-topic-chip="${thread.titleLine}" style="user-select:none;${own ? 'flex:0 0 100%;margin-top:-6px' : 'flex:none;max-width:45%'};display:inline-flex;align-items:center;height:26px;min-width:0"><span data-act="topic" data-row="${thread.titleLine}" role="button" aria-haspopup="dialog" aria-expanded="${open}" aria-label="${esc(`Topic: ${topic}`)}" style="display:inline-flex;align-items:center;gap:4px;min-width:0;font:13px/1 var(--font-sans);color:#4d4d4d;cursor:default;white-space:nowrap">${own ? '<span style="flex:none;color:#8f8f8f">Topic:</span>' : ''}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(topic)}</span><span style="flex:none;display:inline-flex;color:#8f8f8f">${icon(open ? '<path d="m18 15-6-6-6 6"></path>' : '<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span></span></span>`;
  }
  openTopic(el) {
    const line = Number(el.dataset.row);
    if (this.state.topicMenu && this.state.topicMenu.line === line) { this.closeTopic(); return; }
    const r = el.getBoundingClientRect ? el.getBoundingClientRect() : { left: 0, right: 0, top: 0, bottom: 0 };
    this.setState({ topicMenu: { line, left: r.left, right: r.right, top: r.top, bottom: r.bottom } }, () => { this.lastHtml = null; this.syncEditor(); });
  }
  closeTopic = () => { if (this.state.topicMenu) this.setState({ topicMenu: null }, () => { this.lastHtml = null; this.syncEditor(); }); };
  topicThread(line) { return threads(this.lines()).find((t) => t.titleLine === line) || null; }
  // Rename topic: the title line says the new label; nothing is asked.
  renameTopic(line, text) {
    const ls = this.lines(), p = this.parsedOf(ls)[line];
    if (!p || p.type !== 'title' || this.props.readOnly) return;
    this.setLines((x) => x.map((l, j) => (j === line ? titleLine(text, p.folded, p) : l)));
  }
  // Change topic: the label changes, and Brainstorm is asked to go on from the new topic as a follow-up of the same
  // conversation, its turns kept (sendFollow, as `@brainstorm New topic: …`, so the document says where it changed).
  changeTopic(line, text) {
    const thread = this.topicThread(line); if (!thread || this.props.readOnly) return;
    this.renameTopic(line, text);
    this.followText.set(thread.from, `@brainstorm New topic: ${text}`);
    this.sendFollow(thread.from);
  }
  topicView() {
    const held = this.state.topicMenu; if (!held) return null;
    const thread = this.topicThread(held.line), topic = topicOfThread(thread);
    if (!topic) return null;
    const end = thread.turns[thread.turns.length - 1], canChange = !!end && end.answered && !end.pending;
    return <TopicMenu anchor={held} topic={topic} canChange={canChange} onRename={(text) => this.renameTopic(held.line, text)} onChange={(text) => this.changeTopic(held.line, text)} onClose={this.closeTopic} />;
  }
  // The Collapse in an answered question's top-right corner (2026-10-13; only a titled Build's now). In a titled
  // conversation it folds all of it to its title's row (foldthread), not while a turn of it runs; otherwise it folds the
  // turn (fold). Out of the text (contenteditable=false, as the chip is), so it is never in the caret's way or a copy, and
  // pulled into the padding so the row is no taller for it.
  // `whole`: a titled Build's conversation (foldthread); `asking`: a question still being answered, which collapses the
  // whole conversation (collapseAll); else the exchange's (fold, collapseTurn). A chevron (2026-10-16, David; the word
  // Collapse before it, that morning): down while open, as the folded row's points right, named Collapse for a hover and
  // a screen reader. The first exchange of a titled conversation at rest collapses all of it, and says so in its name,
  // Collapse conversation; it is drawn as every other exchange's (2026-10-16, David: it was a double chevron).
  cornerHtml(at, whole = false, asking = false) {
    const { thread, turn } = at, running = whole && isBuilding(thread, this.props.builds);
    const all = !whole && !asking && this.collapsesThread(thread, turn), label = all ? 'Collapse conversation' : 'Collapse';
    const button = whole
      ? `<button type="button" class="bart-fold" data-act="foldthread" data-row="${thread.titleLine}" aria-expanded="true" aria-label="Collapse"${running ? ' disabled title="Collapse once it answers"' : ' title="Collapse"'}>${ICON.open}</button>`
      : `<button type="button" class="bart-fold" data-act="${asking ? 'foldall' : 'fold'}" data-turn="${turn.q}" aria-expanded="true" aria-label="${label}" title="${label}">${ICON.open}</button>`;
    return `<span contenteditable="false" data-corner="${turn.q}" style="user-select:none;flex:none;position:relative;display:inline-flex;margin:-2px -6px -2px auto;height:28px">${button}</span>`;
  }
  // A turn folded by a follow-up (2026-10-13): one row, its question on one line cut off with an ellipsis, grey and small,
  // and Expand at its right. Read-only (no caret, no edit in place, no chip, no corner Collapse); a click on it, or on
  // Expand, unfolds the turn (toggleFold). Its answer and foot are not drawn; its lines in the file are as they were.
  // Since 2026-10-13 it is a line at the top of its card: a chevron, the question without its `@bart`, 6px to the next
  // and 18px to the question under the last of them.
  foldedHtml(i, raw, line, p, at) {
    const made = this.madeInTurn(this.lines(), at.turn);
    const shown = (at.answers && this.answerShown(at.answers)) || esc(questionLine(p.text, 300) || leadOf(line, agentOf(p)));
    const below = at.closes ? 10 : at.lastBare ? 18 : 6, topic = this.topicChipHtml(i, at); // a Brainstorm conversation's first question keeps its topic chip folded (2026-10-14)
    const card = `background:#fafafa;border-radius:${radius(at.top, at.closes)};margin-bottom:${at.closes ? '8px' : '0'}`;
    const head = `<div ${made.length ? '' : raw} contenteditable="false" data-readonly="1" data-folded-row="${at.turn.q}" data-act="fold" data-turn="${at.turn.q}" role="button" aria-expanded="false" aria-label="Expand" style="user-select:none;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0;padding:${at.top ? 14 : 0}px 16px ${made.length ? 4 : below}px;${made.length ? '' : `${card};`}font:14px/1.5 var(--font-sans);color:#7a7a7a">`
      + `<span style="flex:none;display:inline-flex;color:#a3a3a3">${ICON.folded}</span>`
      + `<span class="t" style="flex:${topic ? '0 1 auto' : '1'};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${shown}</span>`
      + topic + '</div>';
    // A Create turn (2026-10-14): its files' rows stay under its folded question, in its card, flush with its icon
    // (2026-10-15, David: not indented).
    return made.length ? `<div ${raw} contenteditable="false" data-readonly="1" data-made-folded="1" style="user-select:none;${card};padding-bottom:${below}px">${head}<div style="padding:0 16px">${made.map((one) => this.madeHtml(one, { inCard: false })).join('')}</div></div>` : head;
  }
  // An @discover research box (2026-10-13; doc.js isResearch), in the card of the reply that asked for it (2026-10-16,
  // David), as two rows (2026-10-16, David's mockup: "The research card, every state"). On top its line, drawn as
  // "Research · Standard", the level it runs at (discoverLabel), which opens the levels menu whenever it is not running
  // (DiscoverLevels, written into its line as a flag); a box that refines an earlier one also says what it was asked. The
  // line is never edited in place. Under it the status row: what state it is in and the one action that state has, on the
  // right. Ready: "Not started" and Start research. Running: the pending line is that row (lineHtml), with Stop. Stopped:
  // Restart. Interrupted (the app closed on it, or its run failed, the reason in plain words): Restart. Finished: how long
  // it took, and Run again, quieter, since nothing is left to do; the guide is under it. Restart and Run again run the plan
  // again from the beginning (restartResearch). Steps are counted on the running row alone: they are not kept after.
  researchHtml(i, raw, p, at) {
    const ls = this.lines(), ps = this.parsedOf(ls), { thread, turn } = at;
    const refines = thread.turns.some((t) => t.q < turn.q && isResearch(ps[t.q]));
    const asked = refines ? researchText(this.props.models ? this.discoverRead(ls, i).question : p.text).split(STEER_SPLIT)[0] : '';
    const level = this.props.models ? this.discoverLabel(i) : '';
    // What was added while it searched (steerResearch), each under the head.
    const steers = p.text.split(STEER_SPLIT).slice(1).map((words) => words.replace(LEVEL_FLAGS, '$1').replace(/\s+/g, ' ').trim()).filter(Boolean);
    const added = steers.map((words) => `<div data-steer style="display:flex;gap:6px;margin:4px 0 0 22px;font:400 13px/1.5 var(--font-sans);color:#4d4d4d"><span style="flex:none;color:#8f8f8f">Added:</span><span style="min-width:0">${esc(words)}</span></div>`).join('');
    const state = at.boxState || this.boxState(ls, turn), can = !!this.props.onAsk && !this.props.readOnly;
    const dot = '<span style="flex:none;white-space:pre"> · </span>', open = !!(this.state.picker && this.state.picker.kind === 'line' && this.state.picker.i === i);
    const grey = 'font-weight:400;color:#8f8f8f';
    // The level never shrinks (2026-10-15): beside a long direction and Restart research it was cut to "Stand…".
    // Picked while it runs (2026-10-16, David), the search goes on at that level (pickLevel, steerBox).
    const levelHtml = !level ? '' : can && this.props.models.providers[this.props.models.provider]
      ? `${dot}<span data-chip="${i}" style="flex:none;display:inline-flex"><span class="bart-level" data-act="pick" data-row="${i}" role="button" aria-haspopup="dialog" aria-expanded="${open}" aria-label="Research level" style="display:inline-flex;align-items:center;gap:3px;cursor:pointer;white-space:nowrap;${grey}">${esc(level)}<span style="display:inline-flex">${icon(open ? '<path d="m18 15-6-6-6 6"></path>' : '<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span></span></span>`
      : `${dot}<span style="flex:none;white-space:nowrap;${grey}">${esc(level)}</span>`;
    const askedHtml = asked ? `${dot}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${grey}">${esc(asked)}</span>` : '';
    const first = turn.q === thread.from, done = state === 'finished';
    const head = '<div style="display:flex;align-items:center;min-width:0">'
      + `<span style="flex:none;display:inline-flex;margin-right:8px;color:#8f8f8f">${ICON.search}</span><span style="flex:none">Research</span>${levelHtml}${askedHtml}`
      // Done, its Collapse (or Expand, folded) is at its top right (2026-10-16, David: it was an icon on its foot), a chevron
      // as the conversation's is: down while open, right while folded.
      // The first exchange of a titled conversation's collapses the conversation (collapseTurn), drawn as its corner's is.
      + (done ? (() => {
        const all = this.collapsesThread(thread, turn), label = turn.folded ? 'Expand' : all ? 'Collapse conversation' : 'Collapse';
        return `<span style="flex:none;display:inline-flex;margin:-4px -6px -4px auto;padding-left:10px"><button type="button" class="bart-fold" data-act="fold" data-turn="${turn.q}" aria-expanded="${!turn.folded}" aria-label="${label}" title="${label}">${turn.folded ? ICON.folded : ICON.open}</button></span>`;
      })() : '')
      + '</div>';
    const running = state === 'running', status = running || (done && turn.folded) ? '' : this.boxStatusHtml(ls, i, turn, state, can);
    // A card of its own (2026-10-16, David), white and ruled, inside the reply's card where it stood: running, it goes on
    // into its pending line, the running row (lineHtml), which closes it.
    const inner = `<div data-box-card style="padding:9px 14px ${running ? 2 : status ? 9 : 7}px;background:#fff;border:1px solid #ebebeb;${running ? 'border-bottom:0;' : ''}border-radius:${running ? '10px 10px 0 0' : '10px'}">${head}${added}${status}</div>`;
    return `<div ${raw} contenteditable="false" data-readonly="1" data-research="${i}" data-box-state="${state}" style="user-select:none;cursor:default;min-width:0;padding:${first ? 10 : 4}px 16px ${running ? 0 : at.closes ? 10 : 12}px;background:${at.bare ? 'none' : '#fafafa'};border-radius:${radius(first, at.closes)};margin-bottom:${at.closes ? '8px' : '0'};font:500 13px/1.6 var(--font-sans);color:#4d4d4d">`
      + inner + '</div>';
  }
  // A research box's status row (researchHtml), as the running row is drawn (lineHtml's pending line): a mark, what it
  // says, then its action on the right. The model is the one it runs on: the one that answered, once it has, else the one
  // its line asks for.
  boxStatusHtml(ls, i, turn, state, can) {
    const read = this.props.models ? this.discoverRead(ls, i) : null, step = read && read.steps && read.steps[0];
    const closing = turn.foot >= 0 ? parseLine(ls[turn.foot] ?? '').text.replace(/^\*|\*$/g, '').split(' · ') : [];
    const ran = closing.length >= 4 ? { model: `${closing[1]} ${closing[2]}`, took: closing[3] } : null;
    const model = ran ? ran.model : step ? `${step.name} ${step.effort}` : '';
    const took = (() => { const n = ran && /^(\d+) s$/.exec(ran.took); if (!n) return ran ? ran.took : ''; const sec = Number(n[1]); return sec < 60 ? `${sec} s` : `${Math.round(sec / 60)} min`; })();
    const reason = state === 'failed' ? parseLine(ls[turn.from] ?? '').text.replace(/^\*\*No answer\.\*\*\s*/, '').trim() : '';
    const said = {
      ready: `Not started${model ? ` · ${model}` : ''}`,
      stopped: `Stopped${model ? ` · ${model}` : ''}`,
      interrupted: 'Interrupted: the app closed before it finished',
      failed: `Interrupted: ${reason || 'the run failed'}`,
      finished: `Finished${took ? ` in ${took}` : ''}${model ? ` · ${model}` : ''}`,
    }[state];
    const mark = state === 'finished'
      ? `<span style="flex:none;display:inline-flex;color:#8f8f8f">${icon('<path d="M20 6 9 17l-5-5"></path>', 13, 2)}</span>`
      : state === 'interrupted' || state === 'failed' ? ''
      : `<span style="flex:none;width:6px;height:6px;border-radius:50%;background:#d4d4d4"></span>`;
    const blue = 'user-select:none;flex:none;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:0;border-radius:6px;background:#0070f3;color:#fff;font:500 12.5px/1 var(--font-sans);cursor:pointer';
    const action = !can ? ''
      : state === 'ready' ? `<button type="button" class="bart-go" data-act="startresearch" data-row="${i}" style="${blue}">${icon('<path d="M7 4.5v15l12-7.5z" fill="currentColor"></path>', 10, 1.5)}Start research</button>`
      : state === 'finished' ? `<button type="button" class="bart-reply" data-act="restartresearch" data-row="${i}" style="user-select:none;flex:none">Run again</button>`
      : `<button type="button" class="bart-go" data-act="restartresearch" data-row="${i}" style="${blue}">${icon('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>', 12, 2.2)}Restart</button>`;
    return `<div data-box-status="${state}" style="display:flex;align-items:center;gap:10px;min-height:28px;margin-top:8px;font:13px/1.5 var(--font-sans);color:#8f8f8f">`
      + mark + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(said)}</span>` + action + '</div>';
  }
  // The foot of one turn (Answer Card): its button row (2026-10-13, inside the card, under the answer, no line above it).
  // On the left Copy and Regenerate as icons (no Reply since 2026-10-16: the reply field is always under the last turn), with a live card's Skip and Wrap up; on the right Collapse or Expand and Delete. What the
  // closing line says (the agent, model, effort and time) is not drawn (2026-10-15, David: the reply field's chip already
  // names the model); it stays in the file, where Regenerate reads the model that answered (ranWith). It opens no selector.
  // `raw` is set when the answer's closing line is this foot; an answer without one (a run that failed) gets the same foot.
  // `plain`: an @brainstorm or @discover turn, whose Regenerate asks again on its one model (BS-08).
  // `busy`: a turn of the thread is at work. Collapse folds this exchange alone (collapseTurn), even while another in its
  // conversation runs. A research box (`box`, 2026-10-13) has its own Collapse. A turn folded by a follow-up has no foot:
  // it is one row (lineHtml's bare question).
  footHtml({ raw, q, text, folded, closes, plain = false, busy = false, box = false, refine = null, guide = null }) {
    const wrap = (inner, extra = '') => `<span style="flex:none;position:relative;display:inline-flex;${extra}">${inner}</span>`;
    const tip = (label, side) => `<span class="bart-tip" style="${side}:0">${label}</span>`;
    const copied = this.copied === `bart${q}`;
    const ls = this.lines();
    // A live card's Skip, and @brainstorm's Wrap up (2026-10-13: off the card, which is drawn as an answer, onto its foot),
    // but not on the card a conversation opens with (2026-10-16: a `focus` card; nothing to wrap up yet).
    const live = this.cardsOf(ls).byQ.get(q), answering = !!live && live.live;
    const lefts = [
      // Refine (2026-10-15): on the reply that said what Discover will look for.
      ...(refine != null ? [`<button type="button" class="bart-reply" data-act="refine" data-thread="${refine}" style="user-select:none;flex:none;margin-right:4px">Refine</button>`] : []),
      wrap(`<button class="bart-ic" data-act="copybart" data-turn="${q}" aria-label="Copy" ${copied ? 'style="color:#8f8f8f"' : ''}>${ICON.copy}</button>${tip(copied ? 'Copied' : 'Copy', 'left')}`),
      ...(box ? [] : [wrap(`<button class="bart-ic" data-act="regen" data-turn="${q}" data-quiet="1"${plain ? ' data-plain="1"' : ''} aria-label="Regenerate"${busy ? ' disabled' : ''}>${ICON.regenerate}</button>${tip(busy ? 'Regenerate once it answers' : 'Regenerate', 'left')}`)]),
      ...(answering ? [`<button type="button" class="bart-text" data-act="cardskip" data-turn="${q}" style="user-select:none;flex:none;margin-left:6px">Skip</button>`] : []),
      ...(answering && fixedStep(live.agent) && live.card.card !== 'focus' ? [`<button type="button" class="bart-text" data-act="cardwrap" data-turn="${q}" style="user-select:none;flex:none;margin-left:6px">Wrap up</button>`] : []),
    ];
    // Collapse is at the top right: the question's corner, or a research box's head (2026-10-16, David). Never here.
    const fold = '<span style="margin-left:auto"></span>';
    // An @discover guide's Save all (2026-10-16, David): words, not a pill, while any of its papers is not in this project,
    // with how many are left, as each bookmark says Save, right after Copy's box. A research box's too, once it has finished (every Discover guide is one now).
    const left = guide && !folded && this.props.onSavePaper ? this.unsavedPapers(ls, guide) : [], adding = guide && this.savingAll.has(guide.q);
    if (left.length || adding) lefts.push(`<button type="button" class="bart-text" data-act="papersaveall" data-turn="${guide.q}"${adding ? ' disabled' : ''} style="user-select:none;flex:none">${adding ? 'Saving…' : `Save all (${left.length})`}</button>`);
    // The row starts with Copy's 28px box (2026-10-16: Reply went), 10px in as Delete is from the right, so its glyph stands
    // 16px in, under the question's text and over the reply field's lead.
    return `<div ${raw || ''} contenteditable="false" data-readonly="1" data-foot="${q}" style="user-select:none;cursor:default;display:flex;align-items:center;gap:2px;padding:12px 10px ${closes ? 10 : 6}px 10px;background:${folded ? 'none' : '#fafafa'};border-radius:${radius(false, closes)};margin-bottom:${closes ? '8px' : '0'}">`
      + lefts.join('')
      + fold
      + wrap(`<button class="bart-ic" data-danger="1" data-act="dropturn" data-turn="${q}" aria-label="Delete">${ICON.trash}</button>${tip('Delete', 'right')}`)
      + '</div>';
  }
  // An @bart answer's foot (2026-10-15, David's reference): its icons, 8px under it (Copy and Regenerate on the left,
  // Delete on the right), 15px in 26px boxes. No Collapse here: it is in the question's corner. An older answer's has them
  // too (2026-10-15, David: not a toolbar over its top right shown on hover).
  // `raw` is set when the answer's closing line is this foot.
  chatFootHtml({ raw = '', at, closes }) {
    const { turn, thread } = at, q = turn.q;
    const busy = isRunning(thread, this.props.builds), copied = this.copied === `bart${q}`;
    const one = (attrs, label, glyph, side, extra = '') => `<span style="flex:none;position:relative;display:inline-flex;${extra}"><button class="chat-ic" ${attrs} aria-label="${label}">${glyph}</button><span class="bart-tip" style="${side}:0">${label}</span></span>`;
    return `<div ${raw} contenteditable="false" data-readonly="1" data-foot="${q}" style="user-select:none;cursor:default;display:flex;align-items:center;padding:8px 12.5px ${closes ? 12 : 0}px;background:#fafafa;border-radius:${radius(false, closes)};margin-bottom:${closes ? 8 : 0}px">`
      + one(`data-act="copybart" data-turn="${q}"${copied ? ' style="color:#4d4d4d"' : ''}`, copied ? 'Copied' : 'Copy', ICON.copy, 'left')
      + one(`data-act="regen" data-turn="${q}" data-quiet="1"${busy ? ' disabled' : ''}`, busy ? 'Regenerate once it answers' : 'Regenerate', ICON.regenerate, 'left')
      + one(`data-act="dropturn" data-turn="${q}"`, 'Delete', ICON.trash, 'right', 'margin-left:auto')
      + '</div>';
  }
  // One line of an @bart answer (2026-10-15, David's reference): 15px/1.55 on the card's grey, 18px in, a 1.5px rule 12px
  // from the text. A bullet is a 4px dot centred 12px left of its text, which starts 14px in (its `•` stays, unseen, so
  // the caret counts it as before). The space over a line is the rule's padding, so the rule runs on: 8px between a
  // paragraph and a list, and for a blank line; 6px between items. The rule starts 11px under the question (2026-10-15,
  // David: 8px was too tight, 14px a bit loose).
  chatLineHtml(i, raw, p, active, at) {
    const ls = this.lines(), kind = chatKind(ls[i]), before = at.first ? null : chatKind(ls[i - 1] ?? '');
    const space = !before || before === 'blank' || kind === 'blank' ? 0 : kind === 'item' && before === 'item' ? 6 : kind !== before && (kind === 'item' || before === 'item') ? 8 : 0;
    const own = !isRunning(at.thread, this.props.builds) ? at.turn.q : null, cites = this.citesOf(at), opts = this.answerOpts(own, cites);
    const q = parseLine(p.text), ink = (html) => html.replace(/<strong style="font-weight:600">/g, '<strong style="color:#171717;font-weight:600">');
    // A bullet's column is 14px; a number's or a todo's keeps the 1.75em one (MATH-69), drawn and edited alike.
    const a = this.answerLook(p.text, own, cites), dot = q.type === 'list' && q.num == null, col = dot ? '14px' : MARK_COL;
    let content, look = q.type === 'h' ? a.look : 'text-wrap:pretty;', hang = '';
    if (active) {
      const cut = q.type === 'h' || isMarked(q.type) ? p.text.length - q.text.length : 0, shut = this.linksShut(p);
      const tokens = cut ? [p.text.slice(0, cut), ...p.text.slice(cut).split(INLINE).filter(Boolean)] : null;
      if (cut && q.type !== 'h') hang = `padding-left:calc(${q.depth * 18}px + ${col});`;
      content = tokens ? this.activeHtml(tokens, null, `color:#b5b5b5;${q.type === 'h' ? '' : `display:inline-block;min-width:${col};margin-left:-${col};box-sizing:border-box;white-space:pre;`}`, shut, opts) : this.activeHtml(tokensOf(p, ls[i]), null, null, shut, opts);
    } else if (dot) {
      const mark = `<span contenteditable="false" aria-hidden="true" style="flex:none;min-width:14px;position:relative;color:transparent;user-select:none">${esc(listMark(q))}<span data-chat-dot="1" style="position:absolute;left:0;top:calc(0.775em - 2px);width:4px;height:4px;border-radius:50%;background:#b3b3b3"></span></span>`;
      content = `<span style="display:flex;padding-left:${q.depth * 18}px">${mark}<span style="flex:1;min-width:0">${ink(inlineHtml(q.text, opts))}</span></span>`;
    } else content = a.content;
    const blank = kind === 'blank' && !active;
    const ends = at.closes ? 'padding-bottom:12px;border-radius:0 0 10px 10px;margin-bottom:8px;' : '';
    return `<div ${raw}${at.older ? ` data-chat-older="${at.turn.q}"` : ''} data-chat-line="${kind}" style="padding:${at.first ? 11 : 0}px 18px 0;${ends}background:#fafafa;color:#262626;font-size:15px;line-height:1.55;cursor:text">`
      + `<span style="display:block;padding:${space}px 0 0 12px;border-left:1.5px solid #e6e6e6"><span class="t" style="display:block;${blank ? 'height:8px;overflow:hidden;' : `min-height:23px;`}border-radius:4px;${look}${hang}${active ? 'background:#f5f5f5;box-shadow:0 0 0 4px #f5f5f5;' : ''}">${content || '<br>'}</span></span></div>`;
  }
  // An @bart answer's fold (2026-10-15, David's reference): folded, its first paragraph and what follows it up to
  // CHAT_SHOW_LINES lines (applyClips), then "N more points" (what is hidden is a list of N items) or "Show more"; opened,
  // "Show less" at its end. 8px over it, inside the rule. Drawn
  // hidden: applyClips shows it when what it hides is over CHAT_FOLD_LINES lines. An answer there when the document opened
  // starts folded; one that landed since starts open.
  chatMoreHtml(ls, at) {
    const turn = at.turn, key = this.answerKey(ls, turn);
    if (this.props.compact) return '';
    const body = [];
    for (let j = turn.from; j <= turn.to && j !== turn.foot; j++) { const kind = chatKind(ls[j]); if (kind) body.push({ j, kind }); }
    let k = 0; while (k < body.length && body[k].kind === 'blank') k++;
    const head = k; while (k < body.length && body[k].kind === 'p') k++;
    if (k === head) k = head + 1; // an answer that starts with a list or a heading: its first line
    const hidden = body.slice(k).filter((row) => row.kind !== 'blank'); if (!hidden.length) return '';
    const items = hidden.every((row) => row.kind === 'item') ? hidden.filter((row) => parseLine(parseLine(ls[row.j]).text).depth === 0).length : 0;
    const label = items ? `${items} more point${items === 1 ? '' : 's'}` : 'Show more';
    const open = this.moreOpen.has(key) || (!this.seenAnswers.has(key) && !this.moreShut.has(key));
    const chevron = `<span style="display:inline-flex;color:#8f8f8f">${icon(open ? '<path d="m18 15-6-6-6 6"></path>' : '<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span>`;
    return `<div contenteditable="false" data-readonly="1" data-more="${turn.q}" data-chat-more="1" data-key="${key}" data-split="${body[k].j}" data-open="${open ? 1 : 0}"${at.older ? ` data-chat-older="${turn.q}"` : ''} style="display:none;position:relative;user-select:none;cursor:default;padding:0 18px;background:#fafafa">`
      + `<span style="display:flex;padding:8px 0 0 12px;border-left:1.5px solid #e6e6e6"><button type="button" class="chat-more" data-act="more" data-key="${key}" data-open="${open ? 1 : 0}" aria-expanded="${open}">${open ? 'Show less' : label}${chevron}</button></span></div>`;
  }
  // What a follow-up starts on: the pick made on this card's chip, or else the flags of the question before it, so an
  // exchange pinned to a model stays on it. → { flags, step }
  followStep(ls, thread) {
    const models = this.props.models; if (!models) return { flags: '', step: null };
    const choice = this.followChoice.get(thread.from);
    const last = parseLine(ls[thread.turns[thread.turns.length - 1].q]).text;
    const flags = choice && modelOf(choice.model, models) ? `--${choice.model} --${choice.effort}` : readFlags(last, models).spans.map(([a, b]) => last.slice(a, b)).join(' ');
    return { flags, step: readQuestion(flags, models).steps[0] };
  }
  // The field that asks a follow-up (2026-10-13; always under the last turn since 2026-10-16): the message box on the
  // card's grey, `@bart`, the text, the model and effort with a chevron, and a round send. What is typed is not in this
  // string (restoreFollow puts it back), so typing never redraws the editor.
  // After an @brainstorm answer the field asks that agent again, on its one model: no chip (until 2026-10-14 it followed a
  // recap and could be sent empty, to brainstorm again; now it is the conversation's next turn and needs words). After an
  // @discover guide it asks @discover for more, which needs words.
  // `closes: false`: a row follows it inside the card (Send to Discover after a recap), so it leaves the card's end to that.
  followHtml(ls, thread, { closes = true, older = null } = {}) {
    const live = this.cardsOf(ls).byQ.get(thread.turns[thread.turns.length - 1].q);
    if (live && live.live) return this.answerFieldHtml(thread, live, closes);
    const { step } = this.followStep(ls, thread), from = thread.from;
    const agent = answeredBy(thread);
    // What is typed goes to Bart, who picks the agent (sendFollow, 2026-10-13), so the field says @bart whoever answered
    // last; without a router (no onRoute) it still asks that agent, and says so.
    const lead = this.props.onRoute ? '@bart' : `@${tokenOf(agent)}`;
    if (FOLLOW[agent]) {
      const { placeholder, label, empty } = FOLLOW[agent];
      return this.fieldBox(from, { lead, closes, ready: empty, input: this.fieldInput(from, `data-agent="${agent}"${empty ? ' data-empty="1"' : ''} placeholder="${esc(placeholder)}" aria-label="${esc(label)}"`) });
    }
    const open = !!(this.state.picker && this.state.picker.kind === 'follow' && this.state.picker.i === from);
    const chip = step ? `<span class="bart-chip" data-act="pickfollow" data-thread="${from}" role="button" aria-haspopup="dialog" aria-expanded="${open}" style="display:inline-flex;align-items:center;gap:4px;height:28px;font:13px/1 var(--font-sans);color:#4d4d4d;cursor:default;white-space:nowrap">${esc(step.name)} ${esc(EFFORT_LABELS[step.effort] || step.effort)}<span style="display:inline-flex;color:#8f8f8f">${icon(open ? '<path d="m18 15-6-6-6 6"></path>' : '<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span></span>` : '';
    return this.fieldBox(from, { lead, closes, chip, input: this.fieldInput(from, 'placeholder="Respond…" aria-label="Ask a follow-up"') });
  }
  // The reply line under an @bart answer (2026-10-15, David's reference): a rule over it, then `@bart` and "Reply…" in grey
  // on the card; focused or holding text, a white box with the model and a 24px send (the CSS's .chat-field). The latest
  // answer's is under its icons, 6px down.
  chatFieldHtml(from, { lead, closes, chip, older }) {
    return `<div contenteditable="false" data-followup="${from}"${older != null ? ` data-chat-older="${older}"` : ''} style="user-select:none;padding:6px 18px ${closes ? 12 : 6}px;background:#fafafa;border-radius:${closes ? '0 0 10px 10px' : '0'};margin-bottom:${closes ? 8 : 0}px"><div class="chat-line" style="display:flow-root;border-top:1px solid #ececec;padding-top:10px"><div class="chat-field">`
      + `<span style="flex:none;align-self:flex-start;color:#8f8f8f;font:500 14.5px/24px var(--font-sans)">${lead}</span>`
      + this.fieldInput(from, 'placeholder="Reply…" aria-label="Ask a follow-up"', 'font:14.5px/24px var(--font-sans);margin:0')
      + `<span data-chip="f${from}" style="flex:none;display:inline-flex;align-items:center;gap:8px">${chip}<button class="bart-send" data-act="sendfollow" data-thread="${from}" data-box="1" aria-label="Send" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;${boxSend(false)};cursor:pointer">${ICON.sendBox}</button></span>`
      + '</div></div></div>';
  }
  // A reply's textarea: one line tall, growing as it wraps (fitFollow); the question is still one line of the document,
  // so Enter sends and a pasted line break becomes a space.
  fieldInput(from, attrs, look = '') {
    return `<textarea data-follow-input="${from}" ${attrs} rows="1" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;display:block;height:24px;margin:2px 0;padding:0;border:0;background:none;outline:none;resize:none;overflow:hidden;font:16px/1.5 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text;${look}"></textarea>`;
  }
  // The field a reply is typed in (2026-10-13), plain on the card's grey under its button row, flush with the question:
  // the blue lead on the first line, the field, then (bottom-right) the chip and the round send.
  fieldBox(from, { lead, input, chip = '', ready = false, closes = true, extra = '' }) {
    return `<div contenteditable="false" data-followup="${from}"${extra} style="user-select:none;padding:4px 10px ${closes ? 10 : 6}px 16px;background:#fafafa;border-radius:${closes ? '0 0 10px 10px' : '0'};margin-bottom:${closes ? 8 : 0}px"><div style="display:flex;align-items:flex-end;gap:8px">`
      + `<span style="flex:none;align-self:flex-start;margin:2px 0;color:#0070f3;font-weight:500;font-size:16px;line-height:24px">${lead}</span>`
      + input
      + `<span data-chip="f${from}" style="flex:none;display:inline-flex;align-items:center;gap:10px">${chip}<button class="bart-send" data-act="sendfollow" data-thread="${from}" data-box="1" aria-label="Send" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;${boxSend(ready)};cursor:pointer">${ICON.sendBox}</button></span>`
      + '</div></div>';
  }
  // The follow-up field under a live card (2026-10-13), where it is answered (sendCard): `@bart`, no chip, and a send that
  // is blue once something is typed, or (a select-all) once a row is ticked. A free or open question's field says
  // "Respond…", never the hint the card was written with (2026-10-15, David: an old Brainstorm card's "A feeling is fine."
  // read as words already in the field); on
  // a choice, what is typed is their own words in place of a pick (on @brainstorm's versions card, round 7, their question
  // rewritten), or a note to what is ticked.
  answerFieldHtml(thread, entry, closes = true) {
    const from = thread.from, asked = questionOf(entry.card), many = asked.type === 'select_all';
    const ticked = many && ((this.cardState.get(entry.turn.q) || {}).picks || []).length > 0;
    const placeholder = !isChoice(asked.type) ? 'Respond…'
      : entry.agent === 'brainstorm' && asked.id === 'versions' ? 'Or rewrite it yourself…'
        : many ? 'Pick any, or say it in your own words…' : 'Pick one, or say it in your own words…';
    return this.fieldBox(from, { lead: '@bart', closes, ready: ticked, extra: ` data-answers="${entry.turn.q}"`, input: this.fieldInput(from, `data-agent="${entry.agent}"${ticked ? ' data-empty="1"' : ''} placeholder="${esc(placeholder)}" aria-label="Answer"`) });
  }
  // The caret into a conversation's reply field (always drawn under its last turn since 2026-10-16; it never shuts).
  focusReply(from, { show = false } = {}) {
    const input = this.followField(from); if (!input) return;
    input.focus({ preventScroll: true });
    if (show) this.showExchange(from, input); else if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest' });
  }
  // A reply field that took the keyboard on its own (its answer landed; not on expand since 2026-10-16) is shown with the answer
  // over it (2026-10-15, David: the pane went to the field, and the answer's top was out of sight): the exchange whole,
  // from its question to the field, when it fits in the pane; when it does not, its question near the pane's top.
  showExchange(from, input) {
    const ls = this.lines(), thread = threads(ls, this.parsedOf(ls)).find((t) => t.from === from), box = this.scrollRef.current, ed = this.editorEl();
    const last = thread && thread.turns[thread.turns.length - 1], row = last && ed && ed.querySelector(`[data-line="${last.q}"]`);
    const card = (input.closest && input.closest('[data-followup]')) || input;
    if (!box || !row || !row.getBoundingClientRect) { if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest' }); return; }
    const pane = box.getBoundingClientRect(), top = row.getBoundingClientRect().top - pane.top - 24, below = card.getBoundingClientRect().bottom - pane.bottom + 16;
    const by = top < 0 ? top : Math.min(Math.max(below, 0), top);
    if (by) box.scrollTop += by;
  }
  closeRefine(from) { if (this.refineOpen.delete(from)) { this.lastHtml = null; this.syncEditor(); } }
  /* Refine (2026-10-15, David). The reply that said what Discover will look for has Refine where a conversation's last
     reply has Reply. It opens the conversation's reply field under that reply (refineHtml); opening it stops nothing.
     What is sent (sendRefine) is the conversation's next turn, `@discover --refine <words>`: a search still running stops
     first, and the direction Discover settles from it waits in a research box of its own until Start research or Restart
     research there (startResearch). The runs that finished stay in the document as they were; a stopped one goes. */
  openRefine(from) {
    this.refineOpen.add(from); this.lastHtml = null; this.syncEditor();
    const input = this.followField(from); if (!input) return;
    input.focus({ preventScroll: true });
    if (input.scrollIntoView) input.scrollIntoView({ block: 'nearest' });
  }
  refineHtml(thread) {
    const from = thread.from;
    return this.fieldBox(from, { lead: '@discover', closes: false, input: this.fieldInput(from, 'data-agent="discover" placeholder="Correct or develop the direction…" aria-label="Refine the research direction"') }); // the box follows it, in the card
  }
  // Whether a Discover turn asked in `thread` before line `before` is part of a Refine: a Refine turn stands after the
  // conversation's last research box that ran (answered, stopped or running). What such a turn settles waits (askBart).
  refiningIn(ls, thread, before = Infinity) {
    const ps = this.parsedOf(ls), turns = thread.turns.filter((turn) => turn.q < before);
    const ran = turns.map((turn) => isResearch(ps[turn.q]) && (turn.answered || !!turn.pending)).lastIndexOf(true);
    return turns.slice(ran + 1).some((turn) => isRefine(ps[turn.q]));
  }
  refiningAt(ls, q) { const found = this.findTurn(ls, q); return !!found && this.refiningIn(ls, found.thread, q); }
  sendRefine(from) {
    const ls = this.lines(), thread = threads(ls).find((t) => t.from === from), typed = (this.followText.get(from) || '').trim();
    if (!thread || !typed || !this.props.onAsk) return;
    const text = withAttachments(typed, this.followImages.get(from) || []), question = refineLine(text), askId = newAskId();
    this.followText.delete(from); this.followImages.delete(from); this.refineOpen.delete(from);
    const ed = this.editorEl(), top = this.fieldTop(ed, from);
    if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    // A search at work stops and its box goes (2026-10-15, David: an empty box stood there, collapsed), so what it would
    // still write finds no place; a direction still waiting to be started goes too, this one replacing it. The runs that
    // finished stay as they were: nothing is collapsed.
    const ps = this.parsedOf(ls);
    const boxes = thread.turns.filter((turn) => isResearch(ps[turn.q]));
    const gone = new Set();
    for (const turn of boxes) {
      if (turn.answered && !turn.pending) continue;
      if (turn.pending && this.boxState(ls, turn) === 'running') this.stopRun(turn.pending);
      for (let j = turn.q; j <= turn.to; j += 1) gone.add(j);
    }
    const next = ls.filter((_, j) => !gone.has(j));
    const at = (threads(next).find((t) => t.from === from) || thread).to + 1; // the boxes that went were after its first line
    next.splice(at, 0, question, `bart~> ${askId}`); if (at + 2 >= next.length) next.push('');
    const turns = this.turnsBefore(next, at);
    this.holdAsked(askId, top); this.setLines(() => next);
    this.setState({ activeLine: null, mention: null });
    this.expectReply(askId); // a question Discover asks about it is answered from the reply field
    this.props.onAsk({ askId, text: `--refine ${text}`, turns, agent: 'discover', refine: true, place: { line: at, text: question } });
  }
  // Start research or Restart research on a direction waiting in its box: the box is asked as one Discover settled
  // outright is (askBoxed), at the level and on the provider its conversation runs at (readDiscover reads them from it).
  startResearch(i) {
    const ls = this.lines(), found = this.findTurn(ls, i);
    if (!found || !isResearch(this.parsedOf(ls)[i]) || found.turn.answered || found.turn.pending || !this.props.onAsk) return;
    const askId = newAskId(), turns = this.turnsBefore(ls, i);
    this.setLines((x) => { const out = [...x]; if (out[i] !== ls[i]) return out; out.splice(i + 1, 0, `bart~> ${askId}`); if (i + 2 >= out.length) out.push(''); return out; });
    this.askResearch({ askId, text: parseLine(ls[i]).text.trim(), turns, place: { line: i, text: ls[i] } });
  }
  // Restart, or Run again (2026-10-16, David's mockup): a box that stopped, failed, was interrupted or finished runs its plan
  // again from the beginning, at the level its line names now: what its run wrote goes, and a pending line takes its place.
  restartResearch(i) {
    const ls = this.lines(), found = this.findTurn(ls, i);
    if (!found || !isResearch(this.parsedOf(ls)[i]) || !this.props.onAsk || this.props.readOnly) return;
    const state = this.boxState(ls, found.turn);
    if (state === 'running') return;
    if (state === 'ready') { this.startResearch(i); return; }
    const askId = newAskId(), turns = this.turnsBefore(ls, i), to = Math.max(i, found.turn.to);
    this.setLines((x) => { const out = [...x]; if (out[i] !== ls[i]) return out; out.splice(i + 1, to - i, `bart~> ${askId}`); if (i + 2 >= out.length) out.push(''); return out; });
    this.setState({ activeLine: null });
    this.askResearch({ askId, text: parseLine(ls[i]).text.trim(), turns, place: { line: i, text: ls[i] } });
  }
  // A click that expands a collapsed conversation (its title's row) or its last exchange (2026-10-15, David): its reply
  // field, under it, takes the keyboard once the fold is out of the document (focusReplyAfter, after the next redraw). The pane stays
  // where it was (2026-10-16, David: "it should stay at the top"; it went down to the last exchange): the field takes the
  // keyboard only when it is in sight. An earlier exchange expanded, or a conversation that cannot be replied to, opens nothing.
  replyOnExpand(at, kind) {
    if (this.props.readOnly || !this.props.onAsk) return;
    const ls = this.lines();
    const thread = kind === 'title' ? threads(ls, this.parsedOf(ls)).find((t) => t.titleLine === at && t.folded) : (() => { const found = this.findTurn(ls, at); return found && found.turn.folded && found.thread.turns[found.thread.turns.length - 1] === found.turn ? found.thread : null; })();
    if (!thread) return;
    this.replyFocus = { from: thread.from, text: this.docText() };
  }
  // A question just asked, on a line or from a reply field (2026-10-15, David): once its answer is in, the reply field
  // under it takes the keyboard while the person is still on that conversation (2026-10-16, David: "assuming
  // I'm not somewhere else working on something else"): nothing typed since they asked, and nothing else has the
  // keyboard but the caret in that conversation's own lines. Scrolled meanwhile (reading it as it came), the pane is left
  // where they put it and the field takes the keyboard when it is in sight. Otherwise what they went on to do stays
  // theirs and the field waits for them. The pending line `bart~> <askId>` is followed until the answer takes its place;
  // the question is the line above it.
  expectReply(askId) { this.replyWait = { askId, at: Date.now(), line: -1 }; }
  touched = (e) => { if (!e || !['Shift', 'Meta', 'Control', 'Alt', 'CapsLock'].includes(e.key)) this.keyedAt = Date.now(); };
  replyArrived() {
    const wait = this.replyWait; if (!wait) return;
    const ls = this.lines(), at = ls.indexOf(`bart~> ${wait.askId}`);
    if (at >= 0) { wait.line = at; return; }
    this.replyWait = null;
    const found = wait.line > 0 ? this.findTurn(ls, wait.line - 1) : null;
    if (!found || !found.turn.answered || found.turn.pending || found.thread.turns[found.thread.turns.length - 1] !== found.turn) return;
    const { from, to } = found.thread, act = document.activeElement, ed = this.editorEl();
    const caretHere = () => {
      const sel = typeof getSelection === 'function' ? getSelection() : null, node = sel && sel.anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement), row = el && el.closest ? el.closest('[data-line]') : null;
      const n = row ? Number(row.dataset.line) : -1; return n >= from && n <= to;
    };
    const field = act && act.closest ? act.closest('[data-follow-input]') : null;
    const here = !act || act === document.body || (field ? Number(field.dataset.followInput) === from : !!ed && act === ed && caretHere());
    const free = this.keyedAt <= wait.at && here;
    if (!free) return;
    if (this.wheelAt <= wait.at) { this.focusReply(from, { show: true }); return; }
    const input = this.followField(from); if (input && this.inSight(input)) input.focus({ preventScroll: true });
  }
  focusReplyAfter() {
    const want = this.replyFocus; if (!want || this.docText() === want.text) return;
    this.replyFocus = null;
    const input = this.followField(want.from);
    if (input && this.inSight(input)) input.focus({ preventScroll: true });
  }
  // Whether `el` is wholly inside the pane as it is scrolled now (true where the layout cannot be read).
  inSight(el) {
    const box = this.scrollRef.current;
    if (!box || !box.getBoundingClientRect || !el.getBoundingClientRect) return true;
    const pane = box.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.top >= pane.top && r.bottom <= pane.bottom;
  }
  // A Refine field left: shut when it holds nothing, once the keyboard has not come back to it (a redraw puts it back) and
  // no selector or @ menu of its own is open. A conversation's reply field stays (2026-10-16): it is always there.
  leftReply(from) {
    this.timer(() => {
      if (!this.refineOpen.has(from) || this.syncing || (this.followText.get(from) || '').trim()) return;
      const input = this.followField(from);
      if ((input && document.activeElement === input) || (this.state.picker && this.state.picker.kind === 'follow') || (this.state.mention && this.state.mention.field === from)) return;
      this.closeRefine(from);
    }, 150);
  }
  // After a redraw: what was being typed goes back into its field, the send turns blue again, and a field that had the
  // keyboard takes it back with its selection.
  restoreFollow(ed, had) {
    for (const input of ed.querySelectorAll('[data-follow-input]')) {
      const text = this.followText.get(Number(input.dataset.followInput)) || '';
      if (text) input.value = text;
      this.paintSend(input); this.fitFollow(input);
      if (had && had.key === input.dataset.followInput) { input.focus({ preventScroll: true }); try { input.setSelectionRange(had.a, had.b); } catch { /* not a text selection */ } }
    }
  }
  // After a redraw: what was being typed into a Send to Discover field goes back into it, as restoreFollow does.
  restoreDiscover(ed, had) {
    for (const input of ed.querySelectorAll('[data-discover-input]')) {
      const text = this.discoverText.get(input.dataset.discoverInput) || '';
      if (text) input.value = text;
      this.paintSend(input); this.fitFollow(input);
      if (had && had.key === input.dataset.discoverInput) { input.focus({ preventScroll: true }); try { input.setSelectionRange(had.a, had.b); } catch { /* not a text selection */ } }
    }
  }
  followField(from) { const ed = this.editorEl(); return ed ? ed.querySelector(`[data-follow-input="${from}"]`) : null; }
  // After a redraw, an @ menu open in a follow-up field hangs from the new field's caret; it closes when the field is gone
  // (its thread was asked again, folded or deleted) or did not take the keyboard back.
  followMenuRedrawn(menu) {
    const input = this.followField(menu.field);
    this.setState({ mention: input && document.activeElement === input ? { ...menu, anchor: fieldCaret(input) } : null });
  }
  // The field is as tall as its wrapped text.
  fitFollow(input) { input.style.height = 'auto'; input.style.height = `${Math.max(24, input.scrollHeight)}px`; }
  fitFollows = () => { const ed = this.editorEl(); if (ed) for (const input of ed.querySelectorAll('[data-follow-input], [data-discover-input]')) this.fitFollow(input); };
  // A follow-up's send, or Send to Discover's: blue when it can send, grey until then.
  paintSend(input) {
    const around = (input.closest && input.closest('.dv-own')) || input.parentElement; // a Discover card's field sits in a box of its own
    const send = around && around.querySelector('[data-act="sendfollow"], [data-act="senddiscover"]'); if (!send) return;
    const ready = input.dataset.empty === '1' || !!input.value.trim();
    if (input.parentElement && input.parentElement.classList && input.parentElement.classList.contains('chat-field')) input.parentElement.toggleAttribute('data-typed', !!input.value.trim());
    const box = !!(send.dataset && send.dataset.box);
    send.style.background = ready ? '#0070f3' : box ? '#ececec' : '#f2f2f2'; send.style.color = ready ? '#fff' : box ? '#a3a3a3' : '#8f8f8f';
  }
  editorHtml() {
    const ls = this.lines(), ps = this.parsedOf(ls), active = this.state.activeLine, at = this.layout(ls), editing = this.editing; let out = '';
    this.noteAnswers(ls);
    const cards = this.cardsOf(ls);
    ls.forEach((line, i) => {
      const p = ps[i], where = at.get(i);
      // Under a question being edited (2026-10-03), its answer and the answer's foot are dimmed.
      const dim = !!editing && !!where && !!where.turn && where.turn.q === editing.q && i !== editing.q, dimmed = (html) => (dim ? html.replace('<div ', '<div data-dim="1" ') : html);
      const locked = this.lockedAt(ls, i);
      out += dimmed(p.type === 'reply' && locked ? unwritable(this.lineHtml(i, line, p, false, false, where, locked)) : this.lineHtml(i, line, p, active === i, false, where, locked));
      // Under an answer's last line, its Show more (2026-10-13), shown by applyClips once it is long enough to cut.
      if (where && where.lastBody && where.role === 'answer' && !where.box && !where.turn.pending && !where.turn.folded && !where.turn.build && !cards.byQ.has(where.turn.q)) out += where.chat ? this.chatMoreHtml(ls, where) : this.moreHtml(ls, where.turn, where.turn === where.thread.turns[0] || where.turn === [...where.thread.turns].reverse().find((t) => t.answered && !t.pending));
      if (where && where.footAfter && where.chat && !where.turn.folded) out += dimmed(this.chatFootHtml({ at: where, closes: (where.tail && !where.drawnAfter) || where.cut }));
      else if (where && where.footAfter && !(where.turn.folded && !where.box) && !(where.box && ['stopped', 'failed'].includes(where.boxState))) out += dimmed(this.footHtml({ q: where.turn.q, text: '', folded: where.turn.folded, closes: (where.tail && !where.drawnAfter) || where.cut, plain: oneModel(where.agent), busy: isRunning(where.thread, this.props.builds), box: where.box, guide: where.agent === 'discover' && (!where.box || where.boxState === 'finished') ? where.turn : null }));
      // After an @brainstorm recap, Send to Discover on a row of its own under the follow-up field, closing the
      // card (MATH-31; under it, not above, since 2026-10-05: the agent's own field comes first).
      const recap = !!where && where.followAfter && this.endsInRecap(ls, where.thread);
      if (where && where.fieldAfter) out += this.followHtml(ls, where.thread, { closes: !recap, older: where.older ? where.turn.q : null });
      if (where && where.refineAfter) out += this.refineHtml(where.thread);
      if (recap) out += `<div contenteditable="false" data-recap-discover="${where.thread.from}" style="user-select:none;padding:0 12px 10px;margin-bottom:8px;background:#fafafa;border-radius:0 0 10px 10px">${this.sendDiscoverHtml(`t${where.thread.from}`)}</div>`;
    });
    return out;
  }
  /* ---------------------------------------------------------------- @create's rows (2026-10-14) */
  // The files a turn's answer stands for, in order: its lines that are a made file's token alone.
  madeInTurn(ls, turn) {
    const out = [];
    for (let j = turn.from; j <= turn.to; j++) { const p = parseLine(ls[j] ?? ''); const made = p.type === 'reply' ? madeMentionOf(p.text) : null; if (made) out.push({ ...made, line: j }); }
    return out;
  }
  madeFile(made) { return (this.props.madeFiles || {})[madeKey(made)] || null; }
  // Save, or Saved once the library has it: the same everywhere the file shows (its row, its frame, the Stage).
  madeSaveHtml(made, file) {
    const key = esc(madeKey(made));
    if (!file) return ''; // still being read: nothing, rather than a Save it will not need (2026-10-15: saved as made)
    if (file.saved) return `<span class="made-saved" data-made-saved="${key}" title="${esc(`In your library as ${file.saved.name}`)}">${MADE_ICON.check}Saved</span>`;
    const off = !!file.error || !!file.missing || !!file.saving || !this.props.onSaveMade;
    return `<button type="button" class="made-btn" data-act="madesave" data-made="${key}" data-name="${esc(made.name)}"${off ? ' disabled' : ''} title="Save to your library (Assets)">${MADE_ICON.folderPlus}<span>${file && file.saving ? 'Saving…' : 'Save'}</span></button>`;
  }
  // A made file as its frame shows it: the picture, the page's picture, the text or the table.
  madeBodyHtml(made, file) {
    return !file ? '<div style="padding:24px;color:#8f8f8f;font:13px/1.5 var(--font-sans)">Loading…</div>'
      : file.missing ? '<div style="padding:24px;color:#8f8f8f;font:13px/1.5 var(--font-sans)">This file is no longer there.</div>'
        : file.error ? `<div style="padding:24px;color:#8f8f8f;font:13px/1.5 var(--font-sans)">${esc(file.error)}</div>`
          : file.url ? `<img src="${esc(file.url)}" alt="${esc(made.name)}" draggable="false">`
            : file.type === 'html' ? (file.previewUrl ? `<img class="made-page" src="${esc(file.previewUrl)}" alt="${esc(made.name)}" draggable="false">` : '<div style="padding:24px;color:#8f8f8f;font:13px/1.5 var(--font-sans)">No picture of this page: open it in the Stage.</div>')
              : file.type === 'md' && typeof file.text === 'string' ? `<div style="padding:14px 18px;color:#262626;font:14px/1.6 var(--font-sans)">${mdFrameHtml(file.text)}</div>`
                : (file.type === 'csv' || file.type === 'tsv') && typeof file.text === 'string' ? `<div style="overflow:auto"><table>${parseTable(file.text, file.type === 'tsv' ? '\t' : ',', 200).map((cells, r) => `<tr>${cells.map((cell) => `<${r ? 'td' : 'th'}>${esc(cell)}</${r ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table></div>`
                  : typeof file.text === 'string' ? `<pre style="margin:0;padding:14px 18px;font:12.5px/1.55 var(--font-mono);white-space:pre-wrap;color:#262626">${esc(file.text.slice(0, 20000))}</pre>`
                    : '<div style="padding:24px;color:#8f8f8f;font:13px/1.5 var(--font-sans)">Open it in the Stage to see it.</div>';
  }
  // One file's row, or its frame while it is opened inline. `inCard`: inside its answer's grey card (open); folded, it
  // stands alone. No grey behind the row while its file is open in a Stage tab (2026-10-14, David: it had one, #f3f3f3).
  madeHtml(made, { inCard = true } = {}) {
    const file = this.madeFile(made), key = madeKey(made), noun = madeNoun(made.name, file);
    const name = `<span class="made-name" data-act="madeopen" data-made="${esc(key)}" data-name="${esc(made.name)}" data-made-peek="${esc(key)}" role="link" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:15.5px/1.4 var(--font-sans)">${esc(made.name)}</span>`;
    const chevron = (open) => `<button class="bart-ic" data-act="madeexpand" data-made="${esc(key)}" aria-label="${open ? 'Fold' : 'Open here'}" aria-expanded="${open}">${open ? MADE_ICON.up : MADE_ICON.down}</button>`;
    if (this.madeOpen.has(key)) {
      const body = this.madeBodyHtml(made, file);
      return `<div class="made-frame" data-made-frame="${esc(key)}" style="border:1px solid #e3e3e3;border-radius:10px;overflow:hidden;background:#fff">`
        + `<div style="max-height:min(640px,70vh);overflow:auto">${body}</div>`
        + `<div style="display:flex;align-items:center;gap:8px;min-width:0;padding:8px 8px 8px 14px;background:#fafafa;border-top:1px solid #e3e3e3">`
        + `<span style="flex:none;display:inline-flex;color:#8f8f8f">${madeGlyph(noun)}</span>`
        + `<span class="made-name" data-act="madeopen" data-made="${esc(key)}" data-name="${esc(made.name)}" role="link" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#262626;font:14px/1.4 var(--font-sans)">${esc(made.name)}</span>`
        + this.madeSaveHtml(made, file)
        + `<button type="button" class="made-btn" data-act="madestage" data-made="${esc(key)}" data-name="${esc(made.name)}">${MADE_ICON.stage}<span>Open in Stage</span></button>`
        + chevron(true) + '</div></div>';
    }
    return `<div data-made-row="${esc(key)}" style="display:flex;align-items:center;gap:8px;min-width:0;height:48px;box-sizing:border-box;padding:0 6px 0 ${inCard ? 0 : 6}px;margin:0 -6px">`
      + `<span aria-hidden="true" data-made-peek="${esc(key)}" data-name="${esc(made.name)}" style="${MADE_SQUARE()}">${SHAPES_ICON}</span>` + name // no kind beside it: its extension says it (2026-10-15)
      // Save (or Saved) sits right beside the chevron (2026-10-15, David), not the row's 12px away.
      + `<span style="flex:1"></span><span style="flex:none;display:inline-flex;align-items:center;gap:2px">${this.madeSaveHtml(made, file)}${chevron(false)}</span></div>`;
  }
  // A made file's line in an open answer: its row in the card, where the answer's text stands (inside the rule's margin).
  madeLineHtml(raw, made, at) {
    const first = at.first, closes = at.closes;
    return `<div ${raw} contenteditable="false" data-readonly="1" style="user-select:none;cursor:default;padding:${first ? 12 : 2}px 16px ${closes ? 10 : 2}px 32px;background:#fafafa;border-radius:${radius(false, closes)};margin-bottom:${closes ? 8 : 0}px">${this.madeHtml(made)}</div>`;
  }
  // A Create run at work (board 1): what it said it is making, as the answer's text will stand, then the row that will
  // become the file's: "Creating a diagram", what it is doing in the grey wave, m:ss and Stop. No spinner, and no empty
  // square where it was (2026-10-17, David): the wave says it is at work, and the words start at the row's edge.
  // What a Create run is making, its line (main/bart/making.cjs, 2026-10-15: a quick model's, a second or two in), and the
  // file it is writing, if any; `shows`: whether its row is drawn yet (either one is there).
  createSaid(ask) {
    const writing = ask && ask.log ? [...ask.log].reverse().map((entry) => (/^Writing (.+)$/.exec(entry) || [])[1]).find(Boolean) : null;
    const said = String((ask && ask.making) || '');
    return { said, writing, shows: !!(said.trim() || writing) };
  }
  createPendingHtml(raw, p, at, ask) {
    const turnLine = at && at.turn ? parseLine(this.lines()[at.turn.q] ?? '').text : '';
    const request = turnLine.replace(/^(?:--\S+\s+)*/, '');
    const { said, writing } = this.createSaid(ask);
    const label = makingLabel(said, request, writing);
    const kind = label === 'Create' ? null : label.replace(/^Creating (?:an? )?/, '');
    const doing = ask ? createDoing(ask.activity, kind, !!writing || /^Writing \S/.test(ask.activity || '')) : 'No answer came back: the run was interrupted.';
    const closes = !at || at.closes;
    // While it works (2026-10-15, David): the line says what it is making, starting "Creating" ("Creating a diagram of this
    // conversation: …", creatingLine); the row under it says what it is doing ("Building the page", createDoing). With no line but a
    // file being written, the few words the file's kind gives ("Creating a diagram…").
    const sentence = said || writing ? `<div style="padding:0 0 6px;color:#262626;font-size:16px;line-height:1.65">${said ? esc(creatingLine(said)) : `${esc(label === 'Create' ? 'Creating' : label)}…`}</div>` : '';
    // Stop and Hide are plain text, as on every other running row (2026-10-16, Hudson); Save and Open in Stage stay buttons.
    const button = ask ? `<button type="button" class="bart-text" data-act="stopask" data-ask="${esc(p.id)}" style="user-select:none;flex:none">Stop</button>`
        : `<button type="button" class="bart-text" data-act="dropline" data-row="${raw.match(/data-line="(\d+)"/)[1]}" style="user-select:none;flex:none">Hide</button>`;
    return `<div ${raw} data-pending="${esc(p.id)}" data-create-pending="1" contenteditable="false" data-readonly="1" style="user-select:none;cursor:default;padding:${at ? 12 : 2}px 16px 10px 32px;background:#fafafa;border-radius:${radius(!at, closes)};margin-bottom:${closes ? '8px' : '0'}">`
      + sentence
      + '<div style="display:flex;align-items:center;gap:8px;min-width:0;height:48px">'
      + (ask ? '' : `<span aria-hidden="true" style="${MADE_SQUARE()}"></span>`)
      // The label is the line above once it has come (2026-10-15); before that, an interrupted run's row names it.
      + '<span style="flex:1;min-width:0;display:flex;align-items:baseline;gap:12px">'
      + (sentence ? '' : `<span style="flex:none;font:15.5px/1.4 var(--font-sans);color:#262626;white-space:nowrap">${esc(label)}</span>`)
      + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:${sentence ? '15.5px/1.4' : '13px/1.4'} var(--font-sans);color:${sentence ? '#525252' : '#8f8f8f'}">${ask ? waveText(esc(doing)) : esc(doing)}</span>`
      + '</span>'
      + (ask ? `<span data-made-clock="1" style="flex:none;font:13px/1 var(--font-sans);color:#8f8f8f;font-variant-numeric:tabular-nums">${clockOf(ask.at)}</span>` : '')
      + button + '</div></div>';
  }
  // The made files the document shows that the window has not read yet are asked for (props.onMadeNeeded).
  needMade() {
    if (!this.props.onMadeNeeded) return;
    const held = this.props.madeFiles || {}, want = [], seen = new Set();
    for (const line of this.lines()) {
      const p = parseLine(line); if (p.type !== 'reply') continue;
      const made = madeMentionOf(p.text); if (!made) continue;
      const key = madeKey(made); if (held[key] || seen.has(key)) continue;
      seen.add(key); want.push(made);
    }
    if (want.length) this.props.onMadeNeeded(want);
  }
  // A press on a row's name, Save, Open in Stage or chevron.
  madeAct(k, act) {
    const key = act.dataset.made || '', cut = key.indexOf('/'); if (cut < 1) return;
    const made = { askId: key.slice(0, cut), rel: key.slice(cut + 1), name: act.dataset.name || key.slice(cut + 1).split('/').pop() };
    this.unpeekMade();
    if (k === 'madeexpand') { if (!this.madeOpen.delete(key)) this.madeOpen.add(key); this.lastHtml = null; this.syncEditor(); return; }
    if (k === 'madesave') { if (!act.disabled && this.props.onSaveMade) this.props.onSaveMade(made); return; }
    if (this.props.onOpenMade) this.props.onOpenMade(made);
  }
  /* Long answers (2026-10-13). An answer is known by its question and closing lines (answerKey); a conversation's
     first answer is shown whole, with no toggle; every later one starts cut at CLIP_OLD lines (2026-10-16, David).
     Show more (moreOpen) shows a cut one whole, Show less cuts it again. */
  // The same question asked again and answered alike is told apart by how many came before it (2026-10-15).
  answerKey(ls, turn) {
    let nth = 0; for (let j = 0; j < turn.q; j++) if (ls[j] === ls[turn.q]) nth++;
    return `${hashLine(ls[turn.q])}.${hashLine(ls[turn.foot >= 0 ? turn.foot : turn.to])}${nth ? `.${nth}` : ''}`;
  }
  noteAnswers(ls) {
    if (this.seenDoc === this.props.docKey) return;
    this.seenDoc = this.props.docKey; this.seenAnswers = new Set(); this.moreOpen = new Set(); this.moreShut = new Set();
    for (const thread of threads(ls, this.parsedOf(ls))) for (const turn of thread.turns) if (turn.answered && !turn.pending) this.seenAnswers.add(this.answerKey(ls, turn));
  }
  // The toggle under an answer, inside its rule, hidden until applyClips finds the answer long enough to cut. None under
  // its conversation's first answer, which is always whole (2026-10-16, David), nor under its latest, the one being read
  // (2026-10-16, David: "it's the one I'm currently on"); every one between has it. `first`: one of those two.
  moreHtml(ls, turn, first = false) {
    const key = this.answerKey(ls, turn);
    if (this.props.compact || first) return '';
    return `<div contenteditable="false" data-readonly="1" data-more="${turn.q}" data-key="${key}" data-cut-at="${CLIP_OLD}" data-cut-over="${CLIP_OLD + 2}" style="display:none;position:relative;user-select:none;cursor:default;padding:0 16px;background:#fafafa">`
      + `<span style="display:block;padding:4px 0 2px 14px;border-left:2px solid #d6d6d6"><button type="button" class="bart-more" data-act="more" data-key="${key}" aria-expanded="false">Show more</button></span></div>`;
  }
  // After a redraw, each answer with a toggle is measured: one over its limit is cut at its cut (rows past it hidden, the
  // row across it held to what is left of it, a 56px fade over the end) and its toggle says Show more; opened, it is whole
  // and says Show less. Not the answer the caret is in. All rows are measured before any is changed.
  applyClips(ed) {
    const all = ed && ed.querySelectorAll ? [...ed.querySelectorAll('[data-more]')] : []; if (!all.length) return;
    const active = this.state.activeLine;
    const chevron = (up) => `<span style="display:inline-flex;color:#8f8f8f">${icon(up ? '<path d="m18 15-6-6-6 6"></path>' : '<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span>`;
    // An @bart answer's fold (chatMoreHtml), measured: it shows its first paragraph (up to data-split), then whole rows
    // while CHAT_SHOW_LINES lines are not passed (2026-10-15, David: the paragraph alone showed too little); a row that
    // would pass them, with two lines or more left, is held to those lines under a fade. Folded only when more than
    // CHAT_FOLD_LINES lines are left hidden; its label counts the points hidden when they are all a list's.
    // The caret on a line it shows leaves it folded (2026-10-15, David: a click in the answer opened it whole, and leaving
    // it for the reply field folded it again under the press); on a line it hides (a search put it there), it opens for
    // good, so leaving it moves nothing.
    const chats = all.filter((more) => more.dataset.chatMore).map((more) => {
      const rows = [...ed.querySelectorAll(`[data-answer-of="${more.dataset.more}"]`)];
      if (!rows.length) return null;
      const split = Number(more.dataset.split);
      const counts = rows.map((row) => { const t = row.dataset.chatLine === 'blank' ? null : row.querySelector('.t'); return t ? Math.round(t.getBoundingClientRect().height / CHAT_LINE_PX) : 0; });
      let shown = 0, k = 0;
      for (; k < rows.length && Number(rows[k].dataset.line) < split; k++) shown += counts[k];
      while (k < rows.length && shown + counts[k] <= CHAT_SHOW_LINES) shown += counts[k++];
      let clip = null;
      if (k < rows.length && CHAT_SHOW_LINES - shown >= 2 && rows[k].dataset.chatLine !== 'h') {
        const n = CHAT_SHOW_LINES - shown, t = rows[k].querySelector('.t');
        clip = { row: rows[k], n, px: Math.round(t.getBoundingClientRect().top - rows[k].getBoundingClientRect().top + n * CHAT_LINE_PX) };
      } else while (k > 0 && Number(rows[k - 1].dataset.line) >= split && rows[k - 1].dataset.chatLine === 'blank') k--;
      const hide = rows.slice(clip ? k + 1 : k), left = counts.slice(clip ? k + 1 : k).reduce((a, b) => a + b, 0) + (clip ? counts[k] - clip.n : 0);
      if (left <= CHAT_FOLD_LINES) return null;
      const said = hide.filter((row) => row.dataset.chatLine !== 'blank');
      const points = said.length && said.every((row) => row.dataset.chatLine === 'item') ? said.filter((row) => parseLine(parseLine(row.dataset.raw || '').text).depth === 0).length : 0;
      const label = points ? `${points} more point${points === 1 ? '' : 's'}` : 'Show more';
      return { more, hide, clip, label, caret: hide.some((row) => Number(row.dataset.line) === active) };
    });
    for (const plan of chats) {
      if (!plan) continue;
      const { more, hide, clip, label } = plan, key = more.dataset.key, button = more.querySelector('[data-act="more"]');
      let open = more.dataset.open === '1';
      if (!open && plan.caret) { this.moreOpen.add(key); this.moreShut.delete(key); open = true; }
      more.style.display = 'block'; more.dataset.open = open ? '1' : '0';
      if (button) { button.innerHTML = `${open ? 'Show less' : esc(label)}${chevron(open)}`; button.dataset.open = open ? '1' : '0'; button.setAttribute('aria-expanded', String(open)); }
      if (open) continue;
      for (const row of hide) row.style.display = 'none';
      if (clip) { Object.assign(clip.row.style, { boxSizing: 'border-box', maxHeight: `${clip.px}px`, overflow: 'hidden' }); more.dataset.cut = '1'; }
    }
    const toggles = all.filter((more) => !more.dataset.chatMore); if (!toggles.length) return;
    const plans = toggles.map((more) => {
      const rows = [...ed.querySelectorAll(`[data-answer-of="${more.dataset.more}"]`)];
      if (!rows.length || rows.some((row) => Number(row.dataset.line) === active)) return null;
      const rects = rows.map((row) => row.getBoundingClientRect()), top = rects[0].top;
      if (rects[rects.length - 1].bottom - top <= Number(more.dataset.cutOver) * ANSWER_LINE_PX + 16) return null;
      return { more, rows, rects, top };
    });
    for (const plan of plans) {
      if (!plan) continue;
      const { more, rows, rects, top } = plan, open = this.moreOpen.has(more.dataset.key), button = more.querySelector('[data-act="more"]');
      more.style.display = 'block';
      if (button) { button.innerHTML = `${open ? 'Show less' : 'Show more'}${chevron(open)}`; button.setAttribute('aria-expanded', String(open)); }
      if (open) continue;
      const cut = 14 + Number(more.dataset.cutAt) * ANSWER_LINE_PX;
      more.dataset.cut = '1';
      rows.forEach((row, k) => {
        const from = rects[k].top - top, to = rects[k].bottom - top;
        if (from >= cut) row.style.display = 'none';
        else if (to > cut) { row.style.boxSizing = 'border-box'; row.style.maxHeight = `${Math.max(0, Math.round(cut - from))}px`; row.style.overflow = 'hidden'; }
      });
    }
  }
  patchPending() {
    const ed = this.editorEl(); if (!ed || this.lastKey !== this.key()) return false;
    const ls = this.lines(), at = this.layout(ls), changed = [];
    // A research box drawn before its run was known ('interrupted') or after it ended is drawn again whole: its status
    // row, its action and which of its rows show all follow its state.
    for (const d of ed.querySelectorAll('[data-box-state]')) if (at.get(Number(d.dataset.research))?.boxState !== d.dataset.boxState) return false;
    for (const d of ed.querySelectorAll('[data-pending]')) {
      const i = Number(d.dataset.line), p = parseLine(ls[i] ?? ''); if (p.type !== 'pending' || p.id !== d.dataset.pending) return false;
      // Its answer so far held by its scrollbar: it is replaced when the button comes up (mouseup).
      if (this.pressedStream != null && this.pressedStream === p.id) continue;
      const html = this.lineHtml(i, ls[i], p, false, false, at.get(i), true);
      if (html !== d.outerHTML) { const holder = document.createElement('div'); holder.innerHTML = html; if (holder.firstElementChild.outerHTML !== d.outerHTML) changed.push([d, holder.firstElementChild]); }
    }
    if (changed.length) {
      const keep = this.caretLineBelow(ed, changed.map(([d]) => d)), tops = this.streamTops(ed);
      for (const [d, next] of changed) { d.replaceWith(next); keepWaves(next); }
      this.placeStreams(changed.map(([, next]) => next), tops);
      if (keep) this.keepCaretLine(keep);
    }
    if (changed.length) this.keepAsked(ed);
    this.pruneStreams();
    this.lastHtml = this.editorHtml(); return true;
  }
  /* The answer so far, in its box (2026-10-13). A row replaced by progress starts its box at the top again: it is put back
     on its newest line, or where the person scrolled it to while they keep it more than STREAM_SLACK px above its bottom. */
  streamScrolled = (e) => {
    const box = e.target; if (!box || !box.dataset || box.dataset.stream == null || box.isConnected === false) return;
    if (box.scrollHeight - box.clientHeight - box.scrollTop > STREAM_SLACK) this.streamFollow.set(box.dataset.stream, false);
    else this.streamFollow.delete(box.dataset.stream);
  };
  streamTops(root) { const tops = new Map(); for (const box of root.querySelectorAll('[data-stream]')) tops.set(box.dataset.stream, box.scrollTop); return tops; }
  placeStreams(rows, tops) {
    for (const row of rows) for (const box of row.querySelectorAll('[data-stream]')) {
      const id = box.dataset.stream;
      box.scrollTop = this.streamFollow.get(id) === false && tops.has(id) ? tops.get(id) : box.scrollHeight;
    }
  }
  // An ask that ended (answered, stopped, failed) follows again if it is ever drawn.
  pruneStreams() { const asks = this.props.asks || {}; for (const id of this.streamFollow.keys()) if (!asks[id]) this.streamFollow.delete(id); }
  /* The line being typed on stays where it is on screen while a card above it changes (2026-10-13). → the caret's line, or
     the field inside the editor being typed in, when it is below one of `rows` (about to be replaced), with its top now;
     null while a mouse button is down (a selection or a drag), with the keyboard elsewhere, or with the caret above them. */
  caretLineBelow(ed, rows) {
    // Nor while the person scrolls the pane with the wheel, nor with that line out of view: the pane is theirs then.
    const pane = this.scrollRef.current; if (this.pressed || !pane || Date.now() - this.wheelAt < 400) return null;
    const act = document.activeElement; let el = null;
    if (act === ed) {
      const sel = getSelection(), n = sel && sel.rangeCount ? sel.focusNode : null, at = n && (n.nodeType === 1 ? n : n.parentElement);
      el = at && at.closest ? at.closest('[data-line]') : null;
    } else if (act && act !== ed && ed.contains(act) && act.matches && act.matches('textarea, input')) el = act;
    if (!el || !ed.contains(el) || !rows.some((d) => d.compareDocumentPosition(el) & 4)) return null; // 4: it follows the row
    const r = el.getBoundingClientRect(), b = pane.getBoundingClientRect ? pane.getBoundingClientRect() : null;
    if (b && (r.top + r.height <= b.top || r.top >= b.top + b.height)) return null;
    return { el, top: r.top };
  }
  // The pane scrolled by however far the change moved that line: only that, so a scroll of the person's own stays.
  keepCaretLine(keep) {
    const box = this.scrollRef.current; if (!box || !keep.el || keep.el.isConnected === false || keep.top == null) return;
    const moved = keep.el.getBoundingClientRect().top - keep.top; if (moved) box.scrollTop += moved;
  }
  /* An answer landing (Workspace placeAnswer) above the caret's line: its pending row, drawn above that line, is the
     answer's lines in the text now. → { caret, from, line, top }: the caret on its own line again, that many lines further
     down (`from` → `line`), and that line's top as drawn now, for keepCaretLine once the answer is (null while a mouse
     button is down); or null when the text changed anywhere else under the caret. */
  landing(ed, ls) {
    const drawn = this.drawnLines; if (!drawn || this.caret) return null;
    const c = this.caretInfo(); if (!c) return null; const from = c.anchor.line;
    if (![...ed.querySelectorAll('[data-pending]')].some((d) => Number(d.dataset.line) < from && !ls.includes(`bart~> ${d.dataset.pending}`))) return null;
    let same = 0; while (same < drawn.length - from && same < ls.length && drawn[drawn.length - 1 - same] === ls[ls.length - 1 - same]) same++;
    if (from < drawn.length - same) return null;
    const line = from + ls.length - drawn.length, el = ed.querySelector(`[data-line="${from}"]`);
    return { caret: { ...c.anchor, line }, from, line, top: el && !this.pressed ? el.getBoundingClientRect().top : null };
  }
  syncEditor() {
    const ed = this.editorEl(); if (!ed) return; const key = this.key();
    // A document never ends on a card: select-all and the caret need a line of the document's own after it.
    const tail = this.lines(); if (this.endsOnCard(tail)) { this.props.onChange(tail.join('\n') + '\n'); return; }
    // Nor does it start on one. Chromium will not select from inside a block that cannot be edited, so with a locked
    // question as the first line, select-all from a caret selected nothing; and nothing could be typed above that card.
    if (this.lockedAt(tail, 0)) {
      if (this.caret) this.caret = { ...this.caret, line: this.caret.line + 1 };
      if (this.state.activeLine != null) this.setState((st) => ({ activeLine: st.activeLine == null ? null : st.activeLine + 1 }));
      this.props.onChange('\n' + tail.join('\n')); return;
    }
    const html = this.editorHtml();
    const hadFocus = document.activeElement === ed || ed.contains(document.activeElement);
    const field = document.activeElement;
    let had = field && field.matches && field.matches('[data-follow-input]') && ed.contains(field) ? { key: field.dataset.followInput, a: field.selectionStart, b: field.selectionEnd }
      : field && field.matches && field.matches('[data-discover-input]') && ed.contains(field) ? { discover: true, key: field.dataset.discoverInput, a: field.selectionStart, b: field.selectionEnd } : null;
    // A reply field pressed while a line had the caret (2026-10-15, David: it took a second click): leaving the line redraws
    // the editor before the field has the keyboard, so the field pressed is gone; the one drawn in its place takes it.
    if (!had && this.focusInto && !ed.contains(field)) had = this.focusInto;
    this.focusInto = null;
    const buildField = field && field.matches && field.matches('[data-build-input]') && ed.contains(field) ? { key: field.dataset.buildInput, a: field.selectionStart, b: field.selectionEnd } : null;
    // A title being renamed (2026-10-12) keeps the keyboard through a redraw (an answer landing, its title filled in by
    // name-chat meanwhile): the field is drawn again with what was typed, and focused again where it was.
    const titleField = field && field.matches && field.matches('[data-title-input]') && ed.contains(field) ? { line: field.dataset.titleInput, a: field.selectionStart, b: field.selectionEnd } : null;
    // A field of its own has the keyboard (a follow-up, a card's answer, a Build reply): the document has no caret to put
    // back. Taking one anyway (2026-09-30: a card's textarea sits in a line, so the selection read as that line) left it
    // set, and the next redraw focused the editor with it: typing in the card jumped the caret to the top of the document.
    if (had || buildField || titleField) this.caret = null;
    // An answer landed above the line being typed on (2026-10-13): the caret stays on that line, and the line where it is
    // on screen. The line was the open one: it is again, under its new number, before anything is drawn.
    let land = this.landAt || null; this.landAt = null;
    if (!land && hadFocus && !had && !buildField && !titleField && key === this.lastKey && (land = this.landing(ed, this.lines()))) {
      this.caret = land.caret;
      if (this.state.activeLine === land.from) { this.landAt = land; this.setState({ activeLine: land.line }); return; }
    }
    if (html === this.lastHtml && key === this.lastKey) {
      if (this.caret && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.applyCaret(); }
      this.wantFocus = false; this.menuToCaret(); return;
    }
    let c = had || buildField || titleField ? null : this.caret || (hadFocus ? this.caretInfo()?.anchor : null);
    if (!c && hadFocus && !had && !buildField && !titleField && !ed.querySelector('[data-line]')) { const ls = this.lines(), last = ls.length - 1, p = parseLine(ls[last]); c = { line: last, offset: lineText(p, ls[last]).length }; }
    if (c && !this.caret) this.caret = c;
    // Read before the fields are replaced: taking a focused field out of the page may blur it, which closes the menu.
    const menu = this.state.mention && this.state.mention.field != null ? this.state.mention : null;
    const tops = this.streamTops(ed);
    this.syncing = true; ed.innerHTML = html; this.lastHtml = html; this.lastKey = key; this.drawnLines = this.lines(); this.markBeside();
    this.placeStreams([ed], tops); keepWaves(ed); this.applyClips(ed); this.pruneStreams(); this.restoreFollow(ed, had && !had.discover ? had : null); this.restoreDiscover(ed, had && had.discover ? had : null); this.restoreBuilds(ed, buildField);
    if (titleField) { const input = ed.querySelector(`[data-title-input="${titleField.line}"]`); if (input) { input.focus({ preventScroll: true }); try { input.setSelectionRange(titleField.a, titleField.b); } catch { /* not a text field */ } } }
    if (menu) this.followMenuRedrawn(menu);
    if (c && !had && !buildField && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.caret = c; this.applyCaret(); }
    if (land && land.top != null) this.keepCaretLine({ el: ed.querySelector(`[data-line="${land.line}"]`), top: land.top });
    this.keepAsked(ed, key);
    this.wantFocus = false; this.syncing = false; this.menuToCaret();
  }
  /* A question asked (2026-10-16, David: "submitting a question must not move the person's place in the document"): its
     row stays where it was on screen, or where the reply field it was typed in was, through the redraws that follow it.
     The turns a follow-up folds above it (foldOlder), the empty line put above a line asked under a card, an answer above
     it still streaming once the editor no longer has the keyboard (caretLineBelow keeps only a caret's line), a picture
     above laying itself out again after the redraw: each would move it. Until 2026-10-16 only the follow-up's fold was
     made up for, on the first draw alone. The pane follows the row by however far it moved, until the question's pending
     line is answered, ASK_HOLD_MS pass, or the person scrolls, clicks or types in the pane (stopSettling, paneWheel). */
  // `el`'s top now, if the pane is the person's to keep as it is: no mouse button down, no wheel scroll in the last 400ms,
  // and `el` in view. Else null: nothing is held.
  submitTop(el) {
    const pane = this.scrollRef.current;
    if (!el || !pane || !pane.getBoundingClientRect || this.pressed || Date.now() - this.wheelAt < 400) return null;
    const r = el.getBoundingClientRect(), b = pane.getBoundingClientRect();
    return r.top + r.height <= b.top || r.top >= b.top + b.height ? null : r.top;
  }
  // The reply field `from`'s top (submitTop): where the question typed in it goes.
  fieldTop(ed, from) { return this.submitTop(ed && ed.querySelector(`[data-follow-input="${from}"]`)); }
  rowTop(ed, i) { return this.submitTop(ed && ed.querySelector(`[data-line="${i}"]`)); }
  holdAsked(askId, top) { this.askHold = top == null ? null : { key: this.key(), askId, top, until: Date.now() + ASK_HOLD_MS }; }
  // After a redraw: the question over pending line `askId` back where it was held. Not while a button is down. A redraw
  // before that line is in the text waits; once it has been and is gone (answered, or its card's), the hold ends.
  keepAsked(ed, key = this.key()) {
    const hold = this.askHold; if (!hold || !ed) return;
    const at = this.lines().indexOf(`bart~> ${hold.askId}`);
    if (hold.key !== key || Date.now() > hold.until || (at < 1 && hold.seen)) { this.askHold = null; return; }
    if (at < 1 || this.pressed) return;
    hold.seen = true;
    this.keepCaretLine({ el: ed.querySelector(`[data-line="${at - 1}"]`), top: hold.top });
  }
  // The @ menu's line was rewritten under it (a folder's path written in, MATH-22): it hangs from the caret again.
  menuToCaret() {
    if (!this.wantAnchor) return; this.wantAnchor = false;
    const anchor = this.state.mention && this.mentionAnchor(); if (anchor) this.setState((s) => (s.mention ? { mention: { ...s.mention, anchor } } : null));
  }
  // A selection made backwards (shift+←) is put back backwards, so the next shift+arrow moves the end being moved.
  applyCaret() { const c = this.caret; this.caret = null; if (!c) return; if (c.sel) { if (c.back) this.setSelection(c.line, c.sel[1], c.sel[0]); else this.setSelection(c.line, c.sel[0], c.sel[1]); } else this.setSelection(c.line, c.offset, c.offset); }
  posIn(t, offset) {
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); let node, rest = offset;
    const shut = (n) => !!(n.parentElement && n.parentElement.closest('[data-open="0"]'));
    while ((node = walker.nextNode())) {
      if (rest <= node.length) {
        // Right after a closed token (a mention, MATH-56) the caret goes to the start of the text after it, when there is
        // some: what is typed there is that text's, not the mention's.
        if (rest && rest === node.length && shut(node)) { const next = walker.nextNode(); if (next && !shut(next)) return { node: next, offset: 0 }; }
        return { node, offset: rest };
      }
      rest -= node.length;
    }
    if (t.firstChild && t.firstChild.nodeName === 'BR') return { node: t, offset: 0 };
    const last = t.lastChild; return last && last.nodeType === 3 ? { node: last, offset: last.length } : { node: t, offset: t.childNodes.length };
  }
  // An image line's picture (2026-10-15) holds no text to stand in: the caret is in the zero-width space before it (0) or
  // after it (the token's length).
  edgeOfPicture(t, raw) {
    const box = t.querySelector('[data-img-line]'); if (!box || box.parentNode !== t) return null;
    const len = (box.dataset.src || '').length, before = box.previousSibling, after = box.nextSibling, at = [...t.childNodes].indexOf(box);
    if (raw <= 0) return before && before.nodeType === 3 ? { node: before, offset: before.length } : { node: t, offset: at };
    return after && after.nodeType === 3 ? { node: after, offset: 0 } : { node: t, offset: at + 1 };
  }
  // Where a point stands on an image line: before its picture (0) or anywhere else, the picture itself included, after it.
  imgSide(d, t, n, o) {
    const len = (d.dataset.raw || '').length, box = t && (t.querySelector('[data-img-line]') || t.firstElementChild); if (!box) return len;
    const r = document.createRange(); r.selectNode(box);
    try { return r.comparePoint(n, o) < 0 ? 0 : len; } catch { return len; }
  }
  setSelection(line, a, b) {
    const ed = this.editorEl(); if (!ed) return; const d = ed.querySelector(`[data-line="${line}"]`); const t = d && d.querySelector('.t'); if (!t) return;
    const s = this.edgeOfPicture(t, a) || this.posIn(t, this.rawToDisplay(t, a)), e = this.edgeOfPicture(t, b) || this.posIn(t, this.rawToDisplay(t, b));
    getSelection().setBaseAndExtent(s.node, s.offset, e.node, e.offset);
  }
  caretInfo() {
    const sel = getSelection(); if (!sel || !sel.rangeCount) return null; const ed = this.editorEl(); if (!ed || !ed.contains(sel.anchorNode)) return null;
    const anchor = this.caretAt(sel.anchorNode, sel.anchorOffset), focus = this.caretAt(sel.focusNode, sel.focusOffset) || anchor;
    return anchor ? { anchor, focus } : null;
  }
  // A point of the page (a node and an offset in it) → { line, offset } in the line's source, or null outside the lines.
  caretAt(n, o) {
    const ed = this.editorEl();
    if (!n || !ed) return null; const el = n.nodeType === 1 ? n : n.parentElement; const d = el && el.closest('[data-line]'); if (!d || !ed.contains(d)) return null;
    const t = d.querySelector('.t'); let off = 0;
    if (parseLine(d.dataset.raw || '').type === 'img') return { line: Number(d.dataset.line), offset: this.imgSide(d, t, n, o) };
    if (t && t.contains(n)) {
      const r = document.createRange(); r.selectNodeContents(t); r.setEnd(n, o); off = r.toString().replace(/\u200b/g, '').length;
    } else off = t ? t.textContent.length : 0;
    const isActive = Number(d.dataset.line) === this.state.activeLine;
    let raw = null;
    if (t && (isActive || t.querySelector('[data-src]'))) raw = this.displayToRaw(t, off);
    if (raw == null) {
      // Code shows its own characters; a fence shown as its language puts the caret at the end of the fence.
      const line = d.dataset.raw || '', kind = d.dataset.kind, p = parseLine(line);
      raw = isActive || kind === 'code' ? off : kind === 'fence' ? lineText(p, line).length : p.type === 'img' ? 0 : p.type === 'reply' ? replyRawOffset(p, off, this.mentionOpts) : rawOffset(p, off, line, this.mentionOpts);
    }
    return { line: Number(d.dataset.line), offset: raw };
  }
  // The two ends of the selection in document order, as caretAt reads them. An end that is not in a line's text stands
  // at the start of the next line (the start) or the end of the line before (the end): select all puts both ends on the
  // editor itself, and a drag can end on an answer's foot or start in a row's margin.
  selEnds() {
    const sel = getSelection(), ed = this.editorEl(); if (!sel || !sel.rangeCount || !ed) return null;
    const range = sel.getRangeAt(0); if (!ed.contains(range.startContainer) || !ed.contains(range.endContainer)) return null;
    const ls = this.lines(), ps = this.parsedOf(ls), rows = [...ed.querySelectorAll('[data-line]')];
    const lineEnd = (d) => { const i = Number(d.dataset.line); return { line: i, offset: lineText(ps[i] || parseLine(''), ls[i] ?? '').length }; };
    const end = (node, offset, last) => {
      const probe = document.createRange(); probe.setStart(node, offset);
      const el = node.nodeType === 1 ? node : node.parentElement, d = el && el.closest('[data-line]'), t = d && ed.contains(d) && d.querySelector('.t');
      if (t && !t.contains(node)) return probe.comparePoint(t, 0) >= 0 ? { line: Number(d.dataset.line), offset: 0 } : lineEnd(d);
      const at = this.caretAt(node, offset); if (at) return at;
      if (!last) { const next = rows.find((row) => probe.comparePoint(row, 0) >= 0); return next ? { line: Number(next.dataset.line), offset: 0 } : null; }
      const before = rows.findLast((row) => probe.comparePoint(row, row.childNodes.length) <= 0); return before ? lineEnd(before) : null;
    };
    const a = end(range.startContainer, range.startOffset, false), b = end(range.endContainer, range.endOffset, true);
    return a && b ? { start: a, end: b } : null;
  }

  /* ---------------------------------------------------------------- events */
  multiLine() {
    const sel = getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const r = sel.getRangeAt(0), lineOf = (n) => { const el = n.nodeType === 1 ? n : n.parentElement; return el && el.closest('[data-line]'); };
    const a = lineOf(r.startContainer), b = lineOf(r.endContainer); return !!(a || b) && a !== b;
  }
  // The first and last line a selection touches; null when either end is outside the lines (select all starts on the root).
  selLines() {
    const sel = getSelection(); if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0), lineOf = (n) => { const el = n.nodeType === 1 ? n : n.parentElement, d = el && el.closest('[data-line]'); return d ? Number(d.dataset.line) : null; };
    const a = lineOf(r.startContainer), b = lineOf(r.endContainer); return a == null || b == null ? null : [Math.min(a, b), Math.max(a, b)];
  }
  onSel() {
    if (this.syncing) return;
    if (this.editing && !this.held) this.leftEdit();
    const c = this.caretInfo(); if (!c) return;
    const ls = this.lines(); if (this.lockedAt(ls, c.anchor.line)) return;
    // A selection across lines (⌘A, shift-click) is left to the browser; the next input rebuilds whatever lines survive it.
    if (c.anchor.line !== c.focus.line || this.multiLine()) { this.selRaw = { line: c.anchor.line, a: c.anchor.offset, b: c.anchor.offset, multi: true, lines: this.selLines() }; return; }
    const a = Math.min(c.anchor.offset, c.focus.offset), b = Math.max(c.anchor.offset, c.focus.offset), back = c.focus.offset < c.anchor.offset;
    this.selRaw = { line: c.anchor.line, a, b };
    if (this.held) return; // the mouse is still selecting: mouseup finishes this
    if (c.anchor.line !== this.state.activeLine) {
      if (!this.caret) this.caret = { line: c.anchor.line, sel: [a, b], back };
      this.setState({ activeLine: c.anchor.line, mention: null }); return;
    }
    const line = ls[c.anchor.line] ?? '', p = this.parsedOf(ls)[c.anchor.line] || parseLine(line);
    if (p.type === 'img' && a === b) {
      const sel = getSelection(), box = sel && sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode.querySelector('[data-img-line]') : null;
      if (!box || (sel.anchorNode !== box.previousSibling && sel.anchorNode !== box.nextSibling)) { this.setSelection(c.anchor.line, a, a); return; }
    }
    const key = p.type === 'img' || isCode(p) || isFence(p) ? '' : this.openIdx(tokensOf(p, line), a, b, this.linksShut(p)).join(',');
    if (key !== this.openKey) { this.caret = { line: c.anchor.line, sel: [a, b], back }; this.forceUpdate(); }
  }
  editorInput = () => {
    const ed = this.editorEl(); if (!ed || this.composing) return; this.byMouse = false; const old = this.lines(), psOld = this.parsedOf(old);
    const divs = [...ed.querySelectorAll('[data-raw]')], c = this.caretInfo(), activeId = c ? c.anchor.line : null;
    // Text the browser put outside the line structure (a caret that landed on the root) is folded into the last line.
    const strayText = [...ed.childNodes]
      .filter((n) => (n.nodeType === 3 && n.textContent.trim()) || (n.nodeType === 1 && n.getAttribute('data-line') == null && n.getAttribute('contenteditable') !== 'false' && n.textContent.trim()))
      .map((n) => n.textContent).join('').replace(/\u200b/g, '');
    let strip = 0, cleared = false;
    // A non-collapsed selection at the last selectionchange (which precedes the edit; the collapse arrives after `input`)
    // or a beforeinput delete of a selection: the edit removed a range, not a character.
    const bulk = this.bulkDelete || !!(this.selRaw && (this.selRaw.multi || this.selRaw.a !== this.selRaw.b)); this.bulkDelete = false;
    const textOf = (d) => {
      const raw = d.dataset.raw ?? ''; if (Number(d.dataset.line) !== activeId || d.dataset.mathBlock) return raw; // a drawn ```math block holds no text of its own
      const p = psOld[Number(d.dataset.line)] || parseLine(raw); if (this.lockedAt(old, Number(d.dataset.line))) return raw;
      const t = d.querySelector('.t'); let txt = t ? this.activeRaw(t) : '';
      if (p.type === 'h' && Number(d.dataset.line) !== this.state.activeLine && !/^#{1,3} /.test(txt)) txt = raw.slice(0, p.level + 1) + txt;
      // So is a quote's `> ` (2026-10-16), typed into before the line was redrawn with it.
      if (p.type === 'quote' && Number(d.dataset.line) !== this.state.activeLine) { const lead = raw.slice(0, raw.length - p.text.length); if (!txt.startsWith(lead)) txt = lead + txt; }
      // Typed into a fence still drawn as its language: the backticks are put back in front of what was typed.
      if (isFence(p) && Number(d.dataset.line) !== this.state.activeLine) txt = p.text.slice(0, p.text.length - fenceShown(p).length) + txt;
      if (p.type === 'reply') return sameLine(p, txt);
      if (!isMarked(p.type)) return txt;
      // A bulk deletion that empties a row leaves a plain empty line, as deleting everything should.
      if (bulk && !txt.trim()) { cleared = true; return ''; }
      // The space that finishes a marker the person is still typing (`- []` then a space) belongs to the marker, not to
      // the row: an empty row never starts with one.
      if (!p.text && /^ /.test(txt)) { const lead = txt.match(/^ +/)[0].length; strip += lead; txt = txt.slice(lead); }
      // A marker just typed at the head of a row that already draws one re-types the row instead of standing as text:
      // `- ` makes it a bullet, `- [] ` makes it a checkbox. The caret must sit right after the marker, so a
      // deletion that happens to leave one at the head does not eat it.
      const again = retypedRow(p, txt);
      if (again && c && c.anchor.offset === strip + again.ate) { strip += again.ate; return again.line; }
      return sameLine(p, txt);
    };
    // The lines that survived the edit, in order. A deletion across lines (select all, cut) takes no answer and no answered
    // question with it, unless their whole conversation is in it (whole): those the browser removed are put back where they
    // stood. An answer's lines are never the person's to edit (2026-10-16), not even inside one answer.
    const kept = new Map(divs.map((d) => [Number(d.dataset.line), d]));
    const span = this.selRaw && this.selRaw.multi ? this.selRaw.lines : null;
    // A conversation wholly inside the selection goes with it (2026-10-15, David), as a picture does; not one at work.
    const whole = new Set();
    if (bulk && span) {
      for (const t of threads(old, psOld)) {
        const from = t.titleLine >= 0 ? t.titleLine : t.from;
        if (from >= span[0] && t.to <= span[1] && !isRunning(t, this.props.builds)) for (let j = from; j <= t.to; j++) whole.add(j);
      }
    }
    let ls = [], pos = -1, restored = false;
    old.forEach((rawLine, j) => {
      const d = kept.get(j);
      if (whole.has(j)) { if (d) restored = true; return; }
      if (!d) { if (this.lockedAt(old, j)) { ls.push(rawLine); restored = true; } return; }
      if (j === activeId) pos = ls.length;
      ls.push(textOf(d));
    });
    if (!ls.length || (strayText && this.endsOnCard(ls))) ls.push('');
    if (restored) this.lastHtml = null;
    let caret = c && pos >= 0 ? { line: pos, offset: c.anchor.offset } : null;
    // Typed beside a picture past editorKey (a composition, say): a line of its own, as besidePicture makes it.
    if (pos >= 0 && psOld[activeId] && psOld[activeId].type === 'img' && ls[pos] !== old[activeId] && ls[pos].includes(old[activeId])) {
      const tok = old[activeId], k = ls[pos].indexOf(tok), head = ls[pos].slice(0, k), tail = ls[pos].slice(k + tok.length);
      ls.splice(pos, 1, ...(head ? [head] : []), tok, ...(tail ? [tail] : []));
      if (tail) pos += head ? 2 : 1;
      caret = { line: pos, offset: tail ? tail.length : head.length }; this.lastHtml = null;
    }
    if (caret && (strip || cleared)) { caret = { line: pos, offset: cleared ? 0 : Math.max(0, caret.offset - strip) }; this.lastHtml = null; }
    if (strayText) {
      const last = ls.length - 1, q = parseLine(ls[last]), base = lineText(q, ls[last]).length;
      ls[last] = sameLine(q, lineText(q, ls[last]) + strayText);
      pos = last; caret = { line: last, offset: base + strayText.length }; this.lastHtml = null;
    }
    // `- []` and `* x` are stored as the row they make, so the line reads the same way tomorrow. Code is kept
    // exactly as typed.
    const psNew = parseLines(ls), inCode = pos >= 0 && (isCode(psNew[pos]) || isFence(psNew[pos]));
    if (pos >= 0 && ls[pos] != null && !inCode) ls[pos] = canonicalLine(ls[pos]);
    // A row that just took a marker (or swapped one) holds fewer characters than the caret counted: the caret moves by
    // the difference between the two markers, so it stays where the person is typing.
    if (caret && activeId != null) {
      const was = old[activeId] ?? '', now = ls[pos] ?? '';
      const before = psOld[activeId] || parseLine(was), after = inCode ? psNew[pos] : parseLine(now);
      const grew = (now.length - lineText(after, now).length) - (was.length - lineText(before, was).length);
      if (grew) caret = { line: pos, offset: Math.max(0, caret.offset - grew) };
    }
    const nextText = ls.join('\n'); const unchanged = nextText === this.props.text;
    this.setDoc(nextText, caret);
    // A strip or clear that leaves the stored text as it was still has to redraw the line the browser altered.
    if (unchanged && (strip || cleared)) this.syncEditor();
    if (caret) {
      // No @ menu inside code: an `@` there is code.
      if (inCode) this.setState((s) => (s.mention || s.activeLine !== pos ? { mention: null, activeLine: pos } : null));
      else this.lineMention(pos, lineText(parseLine(ls[pos] ?? ''), ls[pos]), caret.offset);
    }
  };
  // The @ menu after typing on line `pos` (its text `txt`, the caret at `offset`): opened, narrowed or closed by what stands
  // before the caret; in a library folder opened from it, by what follows the path the line keeps (MATH-22).
  lineMention(pos, txt, offset) {
    const read = this.readMention(txt, offset, { i: pos }), m = read.found;
    if (!m) { this.setState((s) => (s.mention || s.browse || s.activeLine !== pos ? { mention: null, browse: null, activeLine: pos } : null)); return; }
    const mention = { i: pos, query: m.query, start: m.start, caret: offset, anchor: this.caretRect() };
    this.setState({ activeLine: pos, mention, browse: read.browse, mentionIdx: this.mentionStart(mention, read.browse) });
    if (read.into != null) this.browseInto(mention, read.browse.row, read.into, read.browse.before); // `sub/` typed: in it
  }
  // The keyboard reaching the caret (2026-10-12): a key that moves it or types, not a modifier or a shortcut. From then on
  // an answer's line shows the source of a link the caret touches, as any line being edited does. A link the caret
  // touches opens now, before the key acts, so a Backspace or a letter goes into its source and is not lost on the
  // drawn title.
  keyReached(e) {
    if (!this.byMouse) return;
    const k = e.key || '', moves = /^(Arrow|Home$|End$|Page)/.test(k);
    if (!moves && (e.metaKey || e.ctrlKey || /^(Shift|Meta|Control|Alt|AltGraph|CapsLock|Escape|Fn|Dead|Unidentified)$/.test(k))) return;
    this.byMouse = false;
    const c = this.caretInfo(), i = this.state.activeLine; if (!c || c.anchor.line !== i || c.focus.line !== i) return;
    const ls = this.lines(), line = ls[i] ?? '', p = this.parsedOf(ls)[i] || parseLine(line); if (p.type !== 'reply' || p.code) return;
    const a = Math.min(c.anchor.offset, c.focus.offset), b = Math.max(c.anchor.offset, c.focus.offset), tokens = tokensOf(p, line);
    if (this.openIdx(tokens, a, b).join(',') === this.openIdx(tokens, a, b, true).join(',')) return;
    this.caret = { line: i, sel: [a, b], back: c.focus.offset < c.anchor.offset }; this.lastHtml = null;
    if (this.mounted) this.syncEditor();
  }
  editorKey = (e) => {
    this.keyReached(e);
    if (this.armed && e.key !== 'Backspace' && e.key !== 'Delete' && !['Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) this.disarm();
    if (this.state.picker) this.closePicker();
    const s = this.state, c = this.caretInfo(); if (!c) return; const ls = this.lines();
    const ps = this.parsedOf(ls), i = c.anchor.line, line = ls[i] ?? '', p = ps[i] || parseLine(line), cur = lineText(p, line), mod = e.metaKey || e.ctrlKey;
    const same = c.anchor.line === c.focus.line, a = Math.min(c.anchor.offset, c.focus.offset), b = Math.max(c.anchor.offset, c.focus.offset), collapsed = same && a === b;
    if (s.mention && e.key === 'Backspace' && collapsed && !mod && this.upFromFolder(s.mention, a)) { e.preventDefault(); return; }
    if (s.mention) {
      const items = this.mentionList(), n = Math.max(1, items.length);
      if (e.key === 'ArrowDown') { e.preventDefault(); this.setState({ mentionIdx: (s.mentionIdx + 1) % n }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.setState({ mentionIdx: (s.mentionIdx - 1 + n) % n }); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && items.length) { e.preventDefault(); this.pickMention(items[s.mentionIdx] || items[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.setState({ mention: null }); return; }
    }
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    // The question being edited (2026-10-03): Enter asks it again and Shift+Enter adds no line, Escape puts it back, and it
    // is never joined to the line above or below it.
    if (this.editing && same && i === this.editing.q) {
      if (e.key === 'Enter') { if (e.isComposing) return; e.preventDefault(); if (!e.shiftKey && !mod) this.commitEdit(); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(true); return; }
      if ((e.key === 'Backspace' && collapsed && a === 0) || (e.key === 'Delete' && collapsed && a === cur.length)) { e.preventDefault(); return; }
    }
    if (mod && same && e.key.toLowerCase() === 'b') { e.preventDefault(); this.wrap(i, cur, a, b, '**'); return; }
    if (mod && same && e.key.toLowerCase() === 'i') { e.preventDefault(); this.wrap(i, cur, a, b, '*'); return; }
    if (mod && same && e.key.toLowerCase() === 'k') { e.preventDefault(); this.link(i, cur, a, b); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (isMarked(p.type)) { this.indent(i, e.shiftKey ? -1 : 1); this.caret = { line: i, offset: a }; } else if (isCode(p) && same) this.indentCode(i, cur, a, b, e.shiftKey); return; }
    // `@Note name` + Enter (the @ menu's Note, 2026-09-22): a note by that name is made in this workspace and the words become its mention.
    if (e.key === 'Enter' && !e.shiftKey && !mod && this.props.onNoteVerb && NOTE_VERB_RE.test(cur)) { e.preventDefault(); this.noteVerb(i); return; }
    if (e.key === 'Enter' && !e.shiftKey && !mod && p.type === 'bart') { e.preventDefault(); this.askInline(i); return; }
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault(); if (!same) return;
      // A fence typed on a line of its own, with nothing below to close it: Enter closes it and the caret goes inside.
      const fence = p.type === 'p' && a === cur.length ? line.match(FENCE_RE) : null;
      if (fence) {
        this.setLines((x) => { const out = [...x]; out.splice(i + 1, 0, '', fence[1] + fence[2]); return out; }, { line: i + 1, offset: 0 });
        this.setState({ activeLine: i + 1, mention: null }); return;
      }
      // In code the new line starts at the indent of the one it came from, one step deeper after an opening bracket.
      if (isCode(p)) {
        const head = cur.slice(0, a); let lead = head.match(/^[ \t]*/)[0]; if (/[[{(]\s*$/.test(head)) lead += '  ';
        this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, head); out.splice(i + 1, 0, sameLine(p, lead + cur.slice(b))); return out; }, { line: i + 1, offset: lead.length });
        this.setState({ activeLine: i + 1, mention: null }); return;
      }
      if (isMarked(p.type) && !p.text.trim()) {
        if (p.depth > 0) { this.indent(i, -1); this.caret = { line: i, offset: 0 }; } else this.setLines((x) => x.map((l, j) => (j === i ? '' : l)), { line: i, offset: 0 });
        return;
      }
      const head = cur.slice(0, a), tail = cur.slice(b), l1 = sameLine(p, head), l2 = p.type === 'todo' ? todoLine(p.depth, false, tail) : p.num != null ? sameLine({ ...p, num: p.num + 1 }, tail) : sameLine(p, tail);
      this.setLines((x) => { const out = [...x]; out[i] = l1; out.splice(i + 1, 0, l2); return out; }, { line: i + 1, offset: 0 });
      this.setState({ activeLine: i + 1, mention: null }); return;
    }
    // Beside a picture alone on its line (2026-10-15, David): Backspace after it or Delete before it takes it away (an
    // empty line stays); Backspace before it or Delete after it takes an empty line next to it away, or steps onto the
    // line there; a character typed is a line of its own, above or below it. Enter is Enter's own: a line above or below.
    if (p.type === 'img' && collapsed && !mod && !e.altKey && !e.isComposing) {
      const after = a > 0, k = after ? i + 1 : i - 1, near = ls[k];
      if ((e.key === 'Backspace' && after) || (e.key === 'Delete' && !after)) { e.preventDefault(); this.writeText(i, '', { line: i, offset: 0 }); this.setState({ activeLine: i, mention: null }); return; }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault(); if (near == null) return;
        if (near === '' && !this.lockedAt(ls, k)) { this.setLines((x) => x.filter((_, j) => j !== k), { line: after ? i : i - 1, offset: after ? line.length : 0 }); this.setState({ activeLine: after ? i : i - 1, mention: null }); return; }
        if (this.lockedAt(ls, k)) return;
        this.caret = { line: k, offset: after ? 0 : lineText(ps[k] || parseLine(near), near).length }; this.wantFocus = true; this.setState({ activeLine: k, mention: null }); return;
      }
      if (e.key.length === 1 && !e.ctrlKey) { e.preventDefault(); this.besidePicture(i, a, e.key); return; }
    }
    // Backspace right after a mention, or Delete right before one, takes the whole token, its (ws:…) or (lib:…) with it
    // (MATH-57): one key, one mention, and one ⌘Z brings it back. ⌥ and ⌘ delete as the browser does.
    if ((e.key === 'Backspace' || e.key === 'Delete') && collapsed && !mod && !e.altKey && !isCode(p) && !isFence(p)) {
      const span = mentionBeside(cur, a, e.key === 'Backspace');
      if (span) { e.preventDefault(); this.writeText(i, cur.slice(0, span[0]) + cur.slice(span[1]), { line: i, offset: span[0] }); this.setState({ mention: null, activeLine: i }); return; }
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !same && !this.props.readOnly && this.deleteAcross()) { e.preventDefault(); return; }
    // Backspace at the start of a quote's text (2026-10-16) takes its whole `> ` off, as it takes a bullet's mark: the line is
    // plain again. A heading's `# ` goes the same way, one Backspace after it, since `#x` is no heading; `>x` is still a quote.
    if (e.key === 'Backspace' && collapsed && !mod && p.type === 'quote' && a > 0 && a === line.length - p.text.length) {
      e.preventDefault();
      this.setLines((x) => x.map((l, j) => (j === i ? p.text : l)), { line: i, offset: 0 });
      this.setState({ activeLine: i, mention: null });
      return;
    }
    if (e.key === 'Backspace' && collapsed && a === 0) {
      if (isMarked(p.type)) {
        e.preventDefault();
        if (p.depth > 0) { this.indent(i, -1); this.caret = { line: i, offset: 0 }; } else this.setLines((x) => x.map((l, j) => (j === i ? p.text : l)), { line: i, offset: 0 });
        return;
      }
      if (i > 0) {
        e.preventDefault(); const q = ps[i - 1];
        // A fence is not merged into the line next to it (that would undo the block): the caret steps over it instead.
        if ((isFence(p) || isFence(q)) && cur !== '' && lineText(q, ls[i - 1]) !== '') {
          this.caret = { line: i - 1, offset: lineText(q, ls[i - 1]).length }; this.wantFocus = true; this.setState({ activeLine: i - 1, mention: null }); return;
        }
        // A conversation over the line: marked, then taken away (blockAt). An empty line goes first, when a line follows it.
        const block = !mod && this.blockAt(ls, { end: i - 1 });
        if (block) {
          if (this.armedIs(block)) { this.dropBlock(block, { line: block.from, offset: 0 }); return; }
          this.arm(block);
          if (cur === '' && i + 1 < ls.length) { this.setLines((x) => x.filter((_, j) => j !== i), { line: i, offset: 0 }); this.setState({ activeLine: i, mention: null }); }
          return;
        }
        if (this.lockedAt(ls, i - 1)) {
          // Answers are read-only: an empty line right after one goes away; a line with text stays.
          if (cur !== '' || ls.length < 2) return;
          let k = i - 1; while (k >= 0 && this.lockedAt(ls, k)) k--;
          const target = k >= 0 ? { line: k, offset: lineText(parseLine(ls[k]), ls[k]).length } : null;
          this.setLines((x) => x.filter((_, j) => j !== i), target);
          if (target) this.setState({ activeLine: k, mention: null }); else { const ed = this.editorEl(); if (ed) ed.blur(); this.setState({ activeLine: null, mention: null }); }
          return;
        }
        const off = lineText(q, ls[i - 1]).length;
        this.setLines((x) => { const out = [...x]; out[i - 1] = sameLine(q, lineText(q, x[i - 1]) + cur); out.splice(i, 1); return out; }, { line: i - 1, offset: off });
        this.setState({ activeLine: i - 1, mention: null });
      }
      return;
    }
    if (e.key === 'Delete' && collapsed && a === cur.length && i < ls.length - 1) {
      e.preventDefault(); const q = ps[i + 1];
      const block = !mod && this.blockAt(ls, { start: i + 1 });
      if (block) { if (this.armedIs(block)) this.dropBlock(block, { line: i, offset: a }); else this.arm(block); return; }
      if (this.lockedAt(ls, i + 1)) return; const nt = lineText(q, ls[i + 1]);
      if ((isFence(p) || isFence(q)) && cur !== '' && nt !== '') return;
      this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, cur + nt); out.splice(i + 1, 1); return out; }, { line: i, offset: cur.length });
      return;
    }
    // Escape takes the caret out of the line, and that is all it does: marked as used, so the window's Escape leaves the
    // document's full screen only on the next one (MATH-23).
    if (e.key === 'Escape') { e.preventDefault(); const ed = this.editorEl(); if (ed) ed.blur(); }
  };
  // Pasted images are saved by the parent (library + <project>/assets) and referenced as ![Attachment n](img:<id>):
  // inline in a todo or chat line, where it reads [Attachment n]; on its own line anywhere else, where it renders. One
  // dropped on an answer (2026-10-16: an answer is not written in) goes on a line of its own under its conversation.
  async pasteImages(files, at) {
    for (const file of files) {
      const n = (String(this.props.text ?? '').match(/\]\(img:/g) || []).length + 1;
      let saved;
      try { saved = await this.props.onPasteImage(file, `Attachment ${n}`); } catch { saved = null; }
      if (!saved || !saved.id || !this.mounted) continue;
      const token = `![Attachment ${n}](img:${saved.id})`;
      const ls = this.lines();
      let i = Math.min(at.line, ls.length - 1), line = ls[i] ?? '', p = parseLine(line);
      const under = p.type === 'reply';
      if (under) {
        const t = threads(ls, this.parsedOf(ls)).find((x) => i >= x.from && i <= x.to);
        if (t) i = t.to;
        line = ls[i] ?? ''; p = parseLine(line);
      }
      if (!under && (isMarked(p.type) || p.type === 'bart')) {
        const cur = lineText(p, line), a = Math.min(at.offset, cur.length), ins = `${a > 0 && !/\s$/.test(cur.slice(0, a)) ? ' ' : ''}${token} `;
        this.writeText(i, cur.slice(0, a) + ins + cur.slice(a), { line: i, offset: a + ins.length });
        at = { line: i, offset: a + ins.length };
      } else if (!line.trim()) {
        this.setLines((x) => { const out = [...x]; out.splice(i, 1, token, ''); return out; }, { line: i + 1, offset: 0 });
        this.setState({ activeLine: i + 1, mention: null }); at = { line: i + 1, offset: 0 };
      } else {
        this.setLines((x) => { const out = [...x]; out.splice(i + 1, 0, token, ''); return out; }, { line: i + 2, offset: 0 });
        this.setState({ activeLine: i + 2, mention: null }); at = { line: i + 2, offset: 0 };
      }
      this.wantFocus = true;
    }
  }
  // A drop on the document (MATH-19), read inside its event: the pictures pasteImages takes go in where they were let go,
  // and everything else (and every picture, in a document that is read only) to props.onDropItems.
  editorDrop(e) {
    if (!carriesDrop(e)) return;
    // Let go on a Zotero item's chip (MATH-65 build 4), a file becomes the item's pdf: main copies it in and refuses one
    // that is not a pdf. The first pdf of what was dropped, else the first file.
    const chip = zoteroChipFor(e);
    if (chip && this.props.onDropOnZotero) {
      const where = [...((e.dataTransfer && e.dataTransfer.files) || [])].map((file) => { try { return this.props.pathForFile ? this.props.pathForFile(file) : null; } catch { return null; } }).filter(Boolean);
      const file = where.find((p) => /\.pdf$/i.test(p)) || where[0];
      if (file) {
        Promise.resolve(this.props.onDropOnZotero({ key: chip.dataset.zotero, name: chip.dataset.mention }, file)).catch((error) => { if (this.props.onError) this.props.onError(error); });
        return;
      }
    }
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    const items = readDrop(e.dataTransfer, this.props.pathForFile);
    const pictures = !this.props.readOnly && this.props.onPasteImage ? items.filter(isPastable) : [];
    const rest = items.filter((item) => !pictures.includes(item));
    // A path's File is the one the drop carried: readDrop gives one item for each of its files, in their order.
    const fileOf = (item) => (item.kind === 'bytes' ? item.file : files[items.indexOf(item)]);
    if (pictures.length) void this.pasteImages(pictures.map(fileOf).filter(Boolean), this.dropPoint(e));
    if (rest.length && this.props.onDropItems) Promise.resolve(this.props.onDropItems(rest)).catch((error) => { if (this.props.onError) this.props.onError(error); });
  }
  // Rows of the sidebar let go on the document (2026-10-17): their mentions as the @ menu writes them (model/mention.js),
  // where they were let go; in a follow-up's field, at its caret, where nothing is sent until the person sends it. Each
  // row comes into the workspace as a picked one does (props.onMentionPicked); nothing is added to the library and nothing
  // is asked. `input`: the follow-up's field it was let go on, else null.
  libDrop(e, input) {
    if (this.props.readOnly) return;
    const known = new Map((this.props.mentionable || []).filter((r) => r && r.id != null).map((r) => [String(r.id), r]));
    const rows = readLibDrag(e.dataTransfer).map((row) => known.get(String(row.id)) || row);
    if (!rows.length) return;
    const text = rows.map(rowMention).join(' ');
    if (input) {
      const end = input.value.length, mine = document.activeElement === input;
      const a = mine ? Math.min(input.selectionStart ?? end, end) : end, b = mine ? Math.min(input.selectionEnd ?? end, end) : end;
      const ins = `${a > 0 && !/\s$/.test(input.value.slice(0, a)) ? ' ' : ''}${text}${b < end && !/^\s/.test(input.value.slice(b)) ? ' ' : ''}`;
      if (!mine) input.focus({ preventScroll: true });
      input.setRangeText(ins, a, b, 'end');
      this.followInput(input);
    } else this.placeDropped(text, this.dropPoint(e));
    if (this.props.onMentionPicked) for (const row of rows) this.props.onMentionPicked(menuItem(row));
  }
  // `text` let go at `at`: in that line's text, a space either side where a word would touch it; on a line of its own
  // under it when the line is not typed in (an answer, an asked @bart line: under its conversation), and beside a picture
  // alone on its line (besidePicture).
  placeDropped(text, at) {
    const ls = this.lines();
    let i = Math.min(Math.max(0, at.line), ls.length - 1);
    const line = ls[i] ?? '', p = this.parsedOf(ls)[i] || parseLine(line);
    if (this.lockedAt(ls, i)) {
      const t = threads(ls, this.parsedOf(ls)).find((x) => i >= x.from && i <= x.to);
      if (t) i = Math.max(i, t.to);
      this.setLines((x) => { const out = [...x]; out.splice(i + 1, 0, text); return out; }, { line: i + 1, offset: text.length });
      this.setState({ activeLine: i + 1, mention: null });
    } else if (p.type === 'img') {
      this.besidePicture(i, Math.min(at.offset, 1), text);
    } else {
      const cur = lineText(p, line), a = Math.min(at.offset, cur.length);
      const ins = `${a > 0 && !/\s$/.test(cur.slice(0, a)) ? ' ' : ''}${text}${a < cur.length && !/^\s/.test(cur.slice(a)) ? ' ' : ''}`;
      this.writeText(i, cur.slice(0, a) + ins + cur.slice(a), { line: i, offset: a + ins.length });
      this.setState({ activeLine: i, mention: null });
    }
    this.wantFocus = true;
  }
  // Where a drop was let go, as a place in the source: the point under the pointer, else the caret, else the document's end.
  // Let go beside the text, it is the nearest point on that line; below the text, the document's end.
  dropPoint(e) {
    let at = null, below = false;
    try {
      const ed = this.editorEl(), box = ed && ed.getBoundingClientRect ? ed.getBoundingClientRect() : null;
      const lines = ed && ed.querySelectorAll ? ed.querySelectorAll('[data-line]') : [], lastLine = lines.length ? lines[lines.length - 1].getBoundingClientRect() : null;
      below = !!(lastLine ? e.clientY >= lastLine.bottom : box && e.clientY >= box.bottom);
      const x = box && box.width > 4 ? Math.min(Math.max(e.clientX, box.left + 2), box.right - 2) : e.clientX;
      const y = box && box.height > 4 ? Math.max(e.clientY, box.top + 2) : e.clientY;
      const point = !below && typeof document.caretPositionFromPoint === 'function' ? document.caretPositionFromPoint(x, y) : null;
      if (point && point.offsetNode) at = this.caretAt(point.offsetNode, point.offset);
    } catch { at = null; }
    if (!at && !below) { const c = this.caretInfo(); if (c) at = { line: c.anchor.line, offset: Math.min(c.anchor.offset, c.focus.offset) }; }
    if (!at) { const ls = this.lines(), last = Math.max(0, ls.length - 1), line = ls[last] ?? ''; at = { line: last, offset: lineText(parseLine(line), line).length }; }
    return at;
  }
  // Text typed or pasted beside a picture alone on its line (2026-10-15, David): its own line or lines, above the picture
  // when the caret was before it, below when after, so the picture stays a picture and never a chip in a line of text.
  besidePicture(i, at, text) {
    const parts = String(text).replace(/\r/g, '').split('\n'), k = at > 0 ? i + 1 : i, end = k + parts.length - 1;
    this.setLines((x) => { const out = [...x]; out.splice(k, 0, ...parts); return out; }, { line: end, offset: parts[parts.length - 1].length });
    this.setState({ activeLine: end, mention: null });
  }
  editorPaste = (e) => {
    const c = this.caretInfo(); if (!c) return;
    // Over an answer (2026-10-16): nothing, as typing there is nothing.
    { const ls = this.lines(); if ((this.parsedOf(ls)[c.anchor.line] || {}).type === 'reply' && this.lockedAt(ls, c.anchor.line)) { e.preventDefault(); return; } }
    const pasted = [...(((e.clipboardData || {}).files) || [])].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (pasted.length && this.props.onPasteImage) { e.preventDefault(); void this.pasteImages(pasted, { line: c.anchor.line, offset: Math.min(c.anchor.offset, c.focus.offset) }); return; }
    e.preventDefault();
    const data = e.clipboardData || window.clipboardData;
    const own = (data.getData(OWN_LINES) || '').replace(/\r/g, '');
    let text = own || (data.getData('text/plain') || '').replace(/\r/g, ''); if (!text) return;
    const ls = this.lines(), i = c.anchor.line, p = this.parsedOf(ls)[i] || parseLine(ls[i] ?? '');
    let line = ls[i] ?? '', cur = lineText(p, line);
    if (p.type === 'img' && c.anchor.line === c.focus.line && c.anchor.offset === c.focus.offset) { this.besidePicture(i, c.anchor.offset, text); return; }
    // Copied from a PDF (MATH-24): the page's line breaks, split words and ligatures come out (model/paste.js). Not in code.
    if (!own && !isCode(p) && !isFence(p)) text = pdfText(text);
    // Copied from a web page (2026-10-02), the plain text has each link's title only: the page's HTML gives the addresses
    // back. A copy from this editor already holds its links as markdown, and code takes what was copied as it is.
    const html = own || text.includes('](') || isCode(p) || isFence(p) ? '' : data.getData('text/html');
    if (html) text = withLinks(text, [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })));
    // A quote's lines are all it holds (2026-10-07), so blank lines at the ends of a paste would only leave quote lines of
    // nothing, which cannot be edited away.
    if (p.type === 'quote') text = text.replace(/^\n+|\n+$/g, '');
    const same = c.anchor.line === c.focus.line;
    let a = same ? Math.min(c.anchor.offset, c.focus.offset) : c.anchor.offset, b = same ? Math.max(c.anchor.offset, c.focus.offset) : a;
    // `>` typed with no space, then a paste after it (2026-10-16): the quote is written `> ` and what was pasted, as when
    // the space was typed. `>x` reads as a quote here and on the Stage (CommonMark's space is optional); the editor writes
    // its quotes with the space.
    if (p.type === 'quote' && /^>(?! )/.test(line) && a >= 1) { line = `> ${line.slice(1)}`; cur = line; a += 1; b += 1; }
    const parts = text.split('\n');
    if (parts.length === 1) { this.writeText(i, cur.slice(0, a) + text + cur.slice(b), { line: i, offset: a + text.length }); return; }
    // A question is one line (2026-10-02): several lines pasted into an @bart, @brainstorm or @discover line that can still
    // be asked join into it, and so does a paste that starts one on an empty line. Anywhere else the lines stay lines.
    const asks = (!!this.editing && this.editing.q === i) || (p.type === 'bart' ? !this.lockedAt(ls, i) : p.type === 'p' && !line && BART_RE.test(parts[0].trimStart()));
    if (asks) { const flat = flattenPaste(text); this.writeText(i, cur.slice(0, a) + flat + cur.slice(b), { line: i, offset: a + flat.length }); return; }
    // Typed `> ` then pasted (2026-10-07): every line pasted stays in the quote, one quote line each (a blank one is `>`, so
    // the block is not broken). The caret's line source includes its `> `, which the paste never goes before.
    if (p.type === 'quote') {
      const lead = line.length - p.text.length, head = line.slice(0, Math.max(a, lead)), tail = line.slice(Math.max(b, lead));
      const row = (t) => (t ? `> ${t}` : '>'), end = parts[parts.length - 1] + tail;
      this.setLines((x) => { const out = [...x]; out[i] = head + parts[0]; out.splice(i + 1, 0, ...parts.slice(1, -1).map(row), row(end)); return out; }, { line: i + parts.length - 1, offset: row(end).length - tail.length });
      this.setState({ activeLine: i + parts.length - 1, mention: null });
      return;
    }
    const first = cur.slice(0, a) + parts[0], last = parts[parts.length - 1] + cur.slice(b);
    const inAnswer = (text) => (p.type === 'reply' ? sameLine(p, text) : text);
    this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, first); out.splice(i + 1, 0, ...parts.slice(1, -1).map(inAnswer), inAnswer(last)); return out; }, { line: i + parts.length - 1, offset: parts[parts.length - 1].length });
    this.setState({ activeLine: i + parts.length - 1, mention: null });
  };
  // ⌘C and ⌘X (2026-10-02): the document's markdown, not the page drawn from it, so a link keeps its address in the
  // terminal, in Claude Code and pasted back here; apps that read HTML (Docs, Slack) get links to click. A selection that
  // gives no markdown (inside a Build's card, a run at work, an answer's foot) or lies in one @brainstorm card is the
  // browser's to copy. Cut then deletes the selection as Backspace does, through the input path (bulkDelete is what
  // beforeinput sets for Backspace), so the document, the caret and undo are Backspace's.
  editorCopy(e, cut) {
    const sel = getSelection(); if (!sel || sel.isCollapsed || !e.clipboardData) return;
    const ends = this.selEnds(); if (!ends) return;
    const ls = this.lines(); if (ends.start.line === ends.end.line && this.cardsOf(ls).lines.has(ends.start.line)) return;
    const text = selectionMarkdown(ls, ends.start, ends.end); if (!text) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', text);
    e.clipboardData.setData('text/html', selectionHtml(text));
    const over = this.across(); if (over) e.clipboardData.setData(OWN_LINES, this.acrossSource(over));
    if (cut && !this.props.readOnly && !this.deleteAcross()) { this.bulkDelete = true; document.execCommand('delete'); this.bulkDelete = false; }
  }
  // Dragging an image's corner (2026-10-12; any of its four since 2026-10-15) sizes it live; letting go writes the width
  // into its line. A left corner widens it as it is dragged left.
  startResize(e, grip) {
    const box = grip.closest('[data-imgbox]'), i = Number(grip.dataset.imgsize); if (!box) return;
    const dir = /w$/.test(grip.dataset.imgcorner || '') ? -1 : 1;
    const x0 = e.clientX, w0 = box.getBoundingClientRect().width, img = box.querySelector('img'), max = this.editorEl().clientWidth || 2000;
    let w = Math.round(w0);
    this.resizing = true;
    const move = (ev) => { w = Math.max(48, Math.min(max, Math.round(w0 + dir * (ev.clientX - x0)))); box.style.width = `${w}px`; img.style.width = '100%'; img.style.maxHeight = 'none'; };
    const up = () => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      this.timer(() => { this.resizing = false; }, 0);
      this.setLines((ls) => ls.map((l, j) => { if (j !== i) return l; const p = parseLine(l); return p.type === 'img' ? `![${imgParts(p.text).name}|w=${w}](${p.src})` : l; }));
    };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  // Dragging an image (2026-10-15, David): once the pointer has moved a few pixels with the button down, a small solid
  // copy of the picture (at most 220×160) rides under the pointer, the picture itself turns a flat light grey where it was (2026-10-16, David), and a light
  // grey line (2026-10-16, David; dark grey before it, not blue) with a ring at its start glides to where it would land (imgDropGaps, the nearest place to the pointer); letting
  // go moves its line there (moveLineTo). A press that does not move is a click: it opens the picture large, as before.
  // Escape, or letting go where nothing is allowed, leaves it where it was.
  startImgDrag(e, pic) {
    const i = Number(pic.dataset.img), ed = this.editorEl(); if (!ed || !Number.isInteger(i)) return;
    const x0 = e.clientX, y0 = e.clientY, r0 = pic.getBoundingClientRect();
    const k = Math.min(1, 220 / (r0.width || 1), 160 / (r0.height || 1)); // the dragged copy's scale
    let ghost = null, bar = null, target = null;
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.imgDragged = false;
    const gaps = imgDropGaps(this.lines());
    const place = (x, y) => {
      const rows = [...ed.querySelectorAll('[data-line]')].map((row) => ({ j: Number(row.dataset.line), r: row.getBoundingClientRect() })).filter((row) => Number.isInteger(row.j) && row.r.height > 0);
      const spots = rows.filter((row) => gaps.has(row.j)).map((row) => ({ j: row.j, y: row.r.top }));
      const last = rows[rows.length - 1]; if (last && gaps.has(last.j + 1)) spots.push({ j: last.j + 1, y: last.r.bottom });
      let best = null; for (const spot of spots) if (!best || Math.abs(spot.y - y) < Math.abs(best.y - y)) best = spot;
      target = best && best.j !== i && best.j !== i + 1 ? best.j : null;
      const box = ed.getBoundingClientRect();
      if (bar) Object.assign(bar.style, { display: target == null ? 'none' : 'block', left: `${box.left}px`, width: `${box.width}px`, top: `${(best ? best.y : 0) - 1}px` });
      if (ghost) Object.assign(ghost.style, { left: `${x - (x0 - r0.left) * k}px`, top: `${y - (y0 - r0.top) * k}px` });
      // Near the pane's top or bottom edge, the pane scrolls.
      const pane = this.scrollRef.current, pr = pane && pane.getBoundingClientRect ? pane.getBoundingClientRect() : null;
      if (pr && y < pr.top + 40) pane.scrollTop -= 14; else if (pr && y > pr.bottom - 40) pane.scrollTop += 14;
    };
    const finish = (drop) => {
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); window.removeEventListener('keydown', key, true);
      if (ghost) ghost.remove(); if (bar) bar.remove();
      pic.style.filter = '';
      if (document.body && document.body.style) document.body.style.cursor = '';
      if (this.imgDragged) this.timer(() => { this.imgDragged = false; }, 0);
      if (drop && target != null) { const j = target; this.setLines((ls) => moveLineTo(ls, i, j)); this.setState({ activeLine: null }); }
    };
    const move = (ev) => {
      if (!this.imgDragged) {
        if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 5) return;
        this.imgDragged = true;
        bar = document.createElement('div');
        Object.assign(bar.style, { position: 'fixed', zIndex: 59, height: '2px', background: '#c9c9c9', borderRadius: '1px', pointerEvents: 'none', display: 'none', transition: still ? '' : 'top 90ms ease-out' });
        const dot = document.createElement('div'); // the line's start, as a ring
        Object.assign(dot.style, { position: 'absolute', left: '-7px', top: '-3px', width: '8px', height: '8px', boxSizing: 'border-box', border: '2px solid #c9c9c9', borderRadius: '50%', background: '#fff' });
        if (bar.appendChild) bar.appendChild(dot);
        ghost = pic.cloneNode(false);
        ghost.removeAttribute('data-img');
        Object.assign(ghost.style, { position: 'fixed', zIndex: 60, margin: '0', width: `${Math.round(r0.width * k)}px`, height: `${Math.round(r0.height * k)}px`, maxWidth: 'none', maxHeight: 'none', objectFit: 'cover', opacity: '1', pointerEvents: 'none', border: '0', borderRadius: '8px', background: '#fff', boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 10px 28px rgba(0,0,0,.18)' });
        document.body.appendChild(bar); document.body.appendChild(ghost);
        if (!still && typeof ghost.animate === 'function') ghost.animate([{ opacity: 0, transform: 'scale(.92)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 120, easing: 'ease-out' });
        if (document.body.style) document.body.style.cursor = 'grabbing';
        pic.style.filter = 'brightness(0) invert(.93)'; // every pixel #ededed: the picture's shape, light grey
      }
      place(ev.clientX, ev.clientY);
    };
    const up = () => finish(true);
    const key = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up); window.addEventListener('keydown', key, true);
  }
  // The picture viewer (./ImageViewer.jsx): copying the one it shows to the clipboard as an image. → whether it did.
  // Its pixels are read through a canvas: the page's connect-src refuses fetch() a blob: or data: picture (2026-10-15).
  copyPicture = async (src) => {
    try {
      const img = new Image(); img.src = src; await img.decode();
      const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      const blob = await new Promise((done) => canvas.toBlob(done, 'image/png')); if (!blob) return false;
      return !!(await window.engelbartAPI.copyImage(new Uint8Array(await blob.arrayBuffer())));
    } catch { return false; }
  };
  // The note's pictures in document order, each with its line, for the viewer's ← and →.
  pictures() {
    const images = this.props.images || {};
    return this.lines().flatMap((line, j) => {
      const p = parseLine(line); if (p.type !== 'img') return [];
      const src = p.src.startsWith('img:') ? (images[p.src.slice(4)] || '') : p.src;
      return src ? [{ src, alt: imgParts(p.text).name, line: j }] : [];
    });
  }
  openPicture(pic) {
    const line = Number(pic.dataset && pic.dataset.img), src = pic.getAttribute('src'), pics = this.pictures();
    let at = pics.findIndex((one) => one.line === line);
    if (at < 0) at = pics.findIndex((one) => one.src === src);
    const list = at < 0 ? [{ src, alt: pic.getAttribute('alt') || '', line }] : pics;
    at = Math.max(0, at);
    this.setState({ lightbox: { pics: list, at, src: list[at].src } });
  }
  // On close, focus goes back to the picture in the note that was shown last.
  closePicture = () => {
    const lb = this.state.lightbox; if (!lb) return;
    const line = lb.pics[lb.at] && lb.pics[lb.at].line;
    this.setState({ lightbox: null });
    this.timer(() => {
      const ed = this.editorEl(), pic = ed && Number.isFinite(line) ? ed.querySelector(`img[data-img="${line}"]`) : null;
      if (pic) { pic.tabIndex = -1; pic.focus({ preventScroll: true }); }
    }, 0);
  };
  lightboxEl() {
    const lb = this.state.lightbox; if (!lb) return null;
    return <ImageViewer pics={lb.pics} at={lb.at} onStep={(at) => this.setState({ lightbox: { ...lb, at, src: lb.pics[at].src } })} onClose={this.closePicture} onCopy={this.copyPicture} />;
  }
  editorClick = (e) => {
    // A folded run of citations' "…" opens the run (model/cite.js).
    if (openCitationRun(e.target)) { e.preventDefault(); return; }
    const pic = e.target.closest && e.target.closest('[data-img]');
    if (pic && (this.resizing || this.imgDragged)) { e.preventDefault(); return; }
    if (pic && typeof pic.getAttribute === 'function') { e.preventDefault(); this.openPicture(pic); return; }
    // The editor's own empty space below the last line. A drag from one line to another also ends here (2026-10-02: Chromium
    // clicks what holds both ends), and putting the caret at the end lost its highlight.
    // The space under a card, with a row under it (2026-10-13), puts the caret on a line there (gapAt); the space between
    // two other rows is the browser's, which puts the caret on the nearer one.
    if (e.target === this.editorEl()) {
      if (!this.downOnRoot || !getSelection().isCollapsed) return;
      this.cancelEdit();
      // Level with a picture alone on its line (2026-10-15): the caret goes before it or after it, the side nearer the press.
      const pictured = [...(e.target.querySelectorAll ? e.target.querySelectorAll('[data-line]') : [])].find((row) => { const r = row.getBoundingClientRect(); return r.height && r.top <= e.clientY && e.clientY < r.bottom; });
      if (pictured && parseLine(pictured.dataset.raw || '').type === 'img') {
        const r = (pictured.querySelector('[data-imgbox]') || pictured).getBoundingClientRect(), j = Number(pictured.dataset.line);
        this.caret = { line: j, offset: e.clientX < r.left + r.width / 2 ? 0 : pictured.dataset.raw.length };
        if (this.state.activeLine === j) this.applyCaret(); else { this.wantFocus = true; this.setState({ activeLine: j, mention: null }); }
        return;
      }
      const gap = this.downGap && this.gapAt(e.target, e.clientY);
      if (gap && gap.at === this.downGap.at) this.openGap(gap);
      else { const rows = this.rowsAround(e.clientY); if (rows.below < 0 && !rows.level) this.focusEnd(); }
      return;
    }
    // A heading's space above its text, right under a card: the same, when the press was there too.
    if (this.downGap && !this.downOnRoot && getSelection().isCollapsed) {
      const pressed = this.downGap; this.downGap = null;
      if (this.editing) this.cancelEdit();
      const gap = this.gapAt(e.target, e.clientY);
      if (gap && gap.at === pressed.at) { e.preventDefault(); this.openGap(gap); return; }
    }
    const act = e.target.closest('[data-act]');
    // A click anywhere but on the question being edited puts it back first (2026-10-03); what was clicked then does what it
    // does, on the document as it was. Its own Edit button leaves it being edited.
    if (this.editing && !this.inEdit(e.target) && !(act && act.dataset.act === 'editturn' && Number(act.dataset.turn) === this.editing.q)) this.cancelEdit();
    if (act) {
      e.preventDefault(); const i = Number(act.dataset.row), k = act.dataset.act;
      if (k === 'copyall') {
        const idx = String(act.dataset.lines || '').split(',').filter(Boolean).map(Number), ls = this.lines(), text = idx.map((j) => ls[j] ?? '').join('\n');
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('no clipboard'))).catch(() => {});
        this.copied = idx[0]; this.lastHtml = null; this.forceUpdate();
        if (this.copiedT) clearTimeout(this.copiedT);
        this.copiedT = this.timer(() => { this.copied = null; this.lastHtml = null; this.forceUpdate(); }, 1400);
        return;
      }
      if (k === 'after') {
        const at = Number(act.dataset.after) + 1;
        this.setLines((x) => { const out = [...x]; out.splice(at, 0, ''); return out; });
        this.caret = { line: at, offset: 0 }; this.wantFocus = true; this.setState({ activeLine: at, mention: null });
        return;
      }
      if (k === 'ask') { this.closePicker(); this.askInline(i); return; }
      if (k === 'pick') { this.openPicker(act, 'line'); return; }
      if (k === 'topic') { this.closePicker(); this.openTopic(act); return; }
      if (k === 'pickfollow') { this.openPicker(act, 'follow'); return; }
      if (k === 'sendfollow') { this.closePicker(); this.sendFollow(Number(act.dataset.thread)); return; }
      if (k === 'refine') { this.closePicker(); this.openRefine(Number(act.dataset.thread)); return; }
      if (k === 'startresearch') { this.startResearch(Number(act.dataset.row)); return; }
      if (k === 'restartresearch') { this.restartResearch(Number(act.dataset.row)); return; }
      if (k === 'more') {
        const key = act.dataset.key;
        // An @bart answer's toggle says whether it is open (data-open: one that landed since the document opened starts open).
        const open = act.dataset.open != null ? act.dataset.open === '1' : this.moreOpen.has(key);
        if (open) { this.moreOpen.delete(key); this.moreShut.add(key); } else { this.moreOpen.add(key); this.moreShut.delete(key); }
        this.lastHtml = null; this.syncEditor(); return;
      }
      if (k === 'senddiscover') { this.closePicker(); this.sendDiscover(act.dataset.target); return; }
      if (k === 'opendiscover') { this.closePicker(); this.openDiscover(act.dataset.target); return; }
      if (k === 'resultask') { this.closePicker(); this.askResult(i, act.dataset.agent); return; }
      if (k === 'papersave') { if (!act.disabled) this.savePaper(i); return; }
      if (k === 'papersaveall') { if (!act.disabled) this.saveAllPapers(Number(act.dataset.turn)); return; }
      // Regenerate opens the model selector (2026-10-16, David: as hovering it did until 2026-10-13); its blue button asks
      // again on what is picked (sendPicked), @brainstorm's and @discover's too (2026-10-16, David), for that run alone.
      if (k === 'regen') {
        const q = Number(act.dataset.turn);
        const pk = this.state.picker; if (pk && pk.kind === 'regen' && pk.i === q) { this.closePicker(); return; }
        this.openPicker(act, 'regen'); return;
      }
      if (k === 'editturn') { this.closePicker(); this.startEdit(Number(act.dataset.turn)); return; }
      // The foot's Build, or an answer line's [[build]] (2026-10-12): the same Build of that turn.
      if (k === 'footbuild') { this.closePicker(); if (!act.disabled) this.footBuild(Number(act.dataset.turn)); return; }
      if (k === 'cardopt') { this.pickCard(Number(act.dataset.turn), Number(act.dataset.opt)); return; }
      if (k === 'cardrepick') { this.closePicker(); this.askRepick(Number(act.dataset.turn), Number(act.dataset.opt)); return; }
      if (k === 'cardrepickgo') { this.repickCard(Number(act.dataset.turn), Number(act.dataset.opt)); return; }
      if (k === 'cardrepickno') { this.cancelRepick(); return; }
      if (k === 'cardskip') { this.sendCard(Number(act.dataset.turn), 'skip'); return; }
      if (k === 'cardwrap') { this.sendCard(Number(act.dataset.turn), 'wrap'); return; }
      if (k === 'fold') { const q = Number(act.dataset.turn); this.replyOnExpand(q, 'turn'); this.collapseTurn(q); return; }
      if (k === 'foldall') { this.collapseAll(Number(act.dataset.turn)); return; }
      if (k === 'foldthread') { if (act.disabled) return; if (e.altKey && !this.props.readOnly && act.closest && act.closest('[data-thread-row]')) this.startTitle(i); else { this.replyOnExpand(i, 'title'); this.toggleThread(i); } return; }
      if (k === 'edittitle') { if (this.props.readOnly) this.toggleThread(i); else this.startTitle(i); return; }
      if (k === 'dropturn') { this.closePicker(); this.deleteTurn(Number(act.dataset.turn)); return; }
      if (k === 'dropline') { this.removeLine(i); return; }
      if (k === 'copybart') {
        const q = Number(act.dataset.turn), text = this.copyText(q);
        (this.props.onCopyText ? Promise.resolve(this.props.onCopyText(text)) : navigator.clipboard.writeText(text)).catch(() => {});
        this.copied = `bart${q}`; this.lastHtml = null; this.forceUpdate();
        if (this.copiedT) clearTimeout(this.copiedT);
        this.copiedT = this.timer(() => { this.copied = null; this.lastHtml = null; this.forceUpdate(); }, 1400);
        return;
      }
      if (k === 'copycode') {
        // The code alone: no fences, and no `bart> ` in front of a block that is part of an answer.
        const ls = this.lines(), ps = this.parsedOf(ls), p = ps[i]; if (!isFence(p) || !p.open) return;
        const text = ls.slice(p.block.open + 1, p.block.close).map((l, n) => (ps[p.block.open + 1 + n].type === 'reply' ? ps[p.block.open + 1 + n].text : l)).join('\n');
        (this.props.onCopyText ? Promise.resolve(this.props.onCopyText(text)) : navigator.clipboard.writeText(text)).catch(() => {});
        this.copied = `code${i}`; this.lastHtml = null; this.forceUpdate();
        if (this.copiedT) clearTimeout(this.copiedT);
        this.copiedT = this.timer(() => { this.copied = null; this.lastHtml = null; this.forceUpdate(); }, 1400);
        return;
      }
      if (k === 'asklog') { const id = act.dataset.ask; if (this.openLogs.has(id)) this.openLogs.delete(id); else this.openLogs.add(id); this.patchPending(); return; }
      if (k.startsWith('build') && act.dataset.buildId) { this.buildAct(k, act.dataset.buildId, act.dataset.runName); return; }
      if (k === 'cancelwait') { this.cancelWait(act.dataset.ask); return; }
      if (k === 'stopask') { if (this.props.onStopAsk) this.props.onStopAsk(act.dataset.ask); return; }
      if (k === 'madeopen' || k === 'madestage' || k === 'madesave' || k === 'madeexpand') { this.madeAct(k, act); return; }
      if (k === 'toggle') this.toggleTodo(i);
      else if (k === 'remove') this.removeLine(i);
      return;
    }
    const a = e.target.closest('a[data-link]') || this.nearClick(e);
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href'), row = a.closest('[data-line]'), sections = row ? this.linkSections(Number(row.dataset.line), href) : null;
      const options = { ...(newTabClick(e) ? { newTab: true } : {}), ...(sections ? { sections } : {}) };
      this.openLink(href, Object.keys(options).length ? options : undefined);
      return;
    }
    const m = e.target.closest('[data-mention]');
    // A file @create made, mentioned in a line (2026-10-14): it opens in the Stage, as its row's name does.
    if (m && m.dataset.made) { e.preventDefault(); this.hidePop(); this.madeAct('madeopen', m); return; }
    // A Zotero item (MATH-65 build 2) opens its pdf in the Stage, or its address when it has none.
    if (m && m.dataset.zotero) {
      e.preventDefault(); this.hidePop();
      if (this.props.onOpenZotero) this.props.onOpenZotero({ key: m.dataset.zotero, name: m.dataset.mention }, newTabClick(e) ? { newTab: true } : undefined);
      return;
    }
    // A file in a library folder (MATH-22) opens in the Stage; one that is gone says so.
    if (m && m.dataset.file != null && m.dataset.folder) {
      e.preventDefault(); this.hidePop();
      if (this.props.onOpenFile) this.props.onOpenFile({ folderId: m.dataset.folder, rel: m.dataset.file, name: m.dataset.mention }, newTabClick(e) ? { newTab: true } : undefined);
      return;
    }
    // A page mentioned by an address the library holds no page for opens in the Stage, as a link does (2026-10-17).
    if (m && m.dataset.url && !this.findRes(m.dataset.mention)) { e.preventDefault(); this.hidePop(); this.openLink(m.dataset.url, newTabClick(e) ? { newTab: true } : undefined); return; }
    // A workspace's document opens in the pane beside this one (MATH-23); ⌘-click goes there, as a click did before.
    if (m && m.dataset.ws) {
      e.preventDefault(); this.hidePop();
      if (this.props.onOpenBeside && !newTabClick(e)) this.props.onOpenBeside({ kind: 'workspace', id: m.dataset.ws, name: m.dataset.mention }, m.dataset.mention);
      else if (this.props.onOpenWorkspace) this.props.onOpenWorkspace(m.dataset.ws);
      return;
    }
    if (m) {
      e.preventDefault(); this.hidePop(); const nm = m.dataset.mention;
      const res = this.findRes(nm, m.dataset.lib); if (!res || res.type === 'chat') return; // an agent opens nothing
      // A note opens in the pane beside this document (MATH-23); ⌘-click opens it as a tab, as before.
      if (isNote(res) && this.props.onOpenBeside && !newTabClick(e)) { this.props.onOpenBeside({ kind: 'note', id: res.id, name: res.name }, nm); return; }
      if (this.props.onOpenItem) this.props.onOpenItem(res);
      return;
    }
  };
  editorOver = (e) => {
    const m = e.target.closest('[data-mention]'), res = m && m.dataset.file == null && m.dataset.zotero == null && m.dataset.made == null && (m.dataset.ws ? { ws: m.dataset.ws, name: m.dataset.mention } : this.findRes(m.dataset.mention, m.dataset.lib));
    if (res) this.showPop(res, { currentTarget: m });
    // A citation's card (model/cite.js): whose words, the quote, and where they are.
    const cite = e.target.closest('a[data-cite]'); if (cite) this.showPop(citationCard(cite), { currentTarget: cite });
    const peek = e.target.closest('[data-made-peek]'); if (peek) this.peekMade(peek);
    // An icon's name goes under it, or above it when under would leave the pane.
    const ic = e.target.closest('.bart-ic'), box = this.scrollRef.current;
    if (ic && ic.parentElement && box) ic.parentElement.toggleAttribute('data-tip-up', ic.getBoundingClientRect().bottom + 32 > Math.min(box.getBoundingClientRect().bottom, window.innerHeight || 800));
    const pick = e.target.closest('[data-act="pick"],[data-act="pickfollow"],[data-act="regen"]:not([data-plain]):not([data-quiet])'); if (pick) this.openPicker(pick, { pick: 'line', pickfollow: 'follow', regen: 'regen' }[pick.dataset.act]);
  };
  // Leaving what opened the selector starts its closing clock, unless the pointer went straight onto the selector: React has
  // by then already handled that same event (the selector's onMouseEnter stops the clock), and this would start it again.
  editorOut = (e) => {
    if (e.target.closest('[data-mention]') || e.target.closest('a[data-cite]')) this.hidePop();
    const peek = e.target.closest('[data-made-peek]');
    if (peek && !(e.relatedTarget && peek.contains(e.relatedTarget))) this.unpeekMade();
    const onto = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-bart-picker]');
    if (!onto && e.target.closest('[data-act="pick"],[data-act="pickfollow"],[data-act="regen"]')) this.leavePicker();
  };
  // The link of an answer's line within NEAR_LINK px of (x, y), measured from its boxes (one per line it wraps over), the
  // nearest when there are two; null on any other line, and on the answer's line being typed in (the caret put there by
  // the keyboard): a click beside a link there places the caret.
  nearLink(target, x, y) {
    if (x == null || y == null || !target || !target.closest) return null;
    const row = target.closest('[data-line]'), ed = this.editorEl(); if (!row || !ed || !ed.contains(row) || !row.querySelectorAll) return null;
    const i = Number(row.dataset.line), p = this.parsedOf(this.lines())[i]; if (!p || p.type !== 'reply') return null;
    if ((i === this.state.activeLine && !this.byMouse) || (this.editing && this.editing.q === i)) return null;
    let best = null, gap = Infinity;
    for (const a of row.querySelectorAll('a[data-link]')) {
      for (const r of a.getClientRects()) {
        const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom), d = Math.max(dx, dy);
        if (d <= NEAR_LINK && d < gap) { best = a; gap = d; }
      }
    }
    return best;
  }
  // The click after a press beside a link (nearLink): that link, when the click is still beside it.
  nearClick(e) {
    const a = this.nearA; this.nearA = null;
    if (!a || a.isConnected === false) return null;
    return this.nearLink(e.target, e.clientX, e.clientY) === a ? a : null;
  }
  openLink(href, options) { if (this.props.onOpenLink) this.props.onOpenLink(href, options); else window.open(href, '_blank', 'noreferrer'); }
  // A passage link in an @discover answer (2026-10-03) goes with the answer's other sections for the same paper, the
  // Stage's Sections menu (model/stage.js guideSections). Anywhere else, none: null.
  linkSections(i, href) {
    const target = splitTarget(href);
    if (!target.find) return null;
    const ls = this.lines(), at = this.layout(ls).get(i);
    if (!at || at.agent !== 'discover' || at.role !== 'answer') return null;
    const reply = [];
    for (let j = at.turn.from; j <= at.turn.to; j++) { const p = parseLine(ls[j] ?? ''); if (p.type === 'reply') reply.push(p.text); }
    const sections = guideSections(reply, target.address);
    return sections.length ? sections : null;
  }
  // The page past the editor: the same rule as the editor's own empty space, for a drag released below or beside the text.
  docClick = (e) => { if (e.target !== e.currentTarget || !this.downOnPage || !getSelection().isCollapsed) return; this.docClickInternal(); };
  docClickInternal() {
    const ed = this.editorEl(); if (!ed) return;
    const ls = this.lines(), last = ls.length - 1, p = parseLine(ls[last]);
    if (this.endsOnCard(ls)) { this.setLines((x) => [...x, '']); this.caret = { line: last + 1, offset: 0 }; this.wantFocus = true; this.setState({ activeLine: last + 1, mention: null }); return; }
    this.caret = { line: last, offset: lineText(p, ls[last]).length }; this.wantFocus = true; ed.focus({ preventScroll: true });
    if (this.state.activeLine === last) this.applyCaret(); else this.setState({ activeLine: last });
  }

  /* ---------------------------------------------------------------- @bart */
  // The question is handed to the parent with the id of the pending line put under it. The answer arrives as a change to
  // props.text (that line replaced by draft lines), whichever document is open by then.
  // An @brainstorm or @discover line may be asked with nothing after it: it starts from the workspace.
  askInline(i) {
    if (this.editing && this.editing.q === i) { this.commitEdit(); return; } // an edited question is asked again, not under its answer
    const ls = this.lines(), p = parseLine(ls[i] || ''), agent = agentOf(p);
    if (p.type !== 'bart' || (!p.text.trim() && !oneModel(agent)) || !this.props.onAsk || this.lockedAt(ls, i)) return;
    if (agent === 'router') { this.routeLine(i); return; }
    // A line typed right under a card's last answer (2026-10-13) starts a conversation of its own: an empty line goes in
    // above it, in the same change. The card's reply field adds follow-ups (sendFollow).
    const gap = this.underCard(ls, i), at = gap ? i + 1 : i, gapped = gap ? [...ls.slice(0, i), '', ...ls.slice(i)] : ls;
    const askId = newAskId(), add = [`bart~> ${askId}`];
    const turns = this.turnsBefore(gapped, at);
    if (at + 1 >= gapped.length) add.push('');
    // A question that starts a conversation (2026-10-12) gets an empty title line above it, keeping its agent and when it
    // was asked (doc.js titleLine), which the workspace fills in when the title comes back (Workspace askBart, main's bart/name-chat.cjs); the answer starts now, never waiting on it.
    // Not a follow-up, and not a conversation that has a title already (or began before titles: it has no line above it
    // to take one). A Build's line (`@chat --build`, 2026-10-13) takes one too, marked a Build's (` build`): its card is
    // its answer (doc.js turn.build), and its collapsed row says Build.
    const name = this.startsTitled(gapped, at, turns), build = !!buildRequestOf({ agent, text: p.text });
    const ed = this.editorEl(); this.holdAsked(askId, this.rowTop(ed, i)); // the line stays where it is on screen (keepAsked)
    this.setLines((x) => {
      const out = this.refining(gap ? [...x.slice(0, i), '', ...x.slice(i)] : x, at);
      out.splice(at + 1, 0, ...add); if (name) out.splice(at, 0, titleLine('', false, { agent, at: askedNow(), ...(build ? { build } : {}) })); return out;
    });
    if (ed) ed.blur(); this.setState({ activeLine: null, mention: null });
    this.expectReply(askId);
    const q = name ? at + 1 : at;
    this.props.onAsk({ askId, text: p.text.trim(), turns, agent, place: { line: q, text: ls[i] }, ...(name ? { name: true } : {}) });
  }
  // An @discover question is Discover's to answer (2026-10-14): it settles with the person what to research, and once it
  // has, the window puts a research box under its reply (Workspace askBart, main's bart/ask.cjs takeResearch) and asks it
  // here (askBoxed). From 2026-10-13 to 2026-10-14 every @discover question with words on it was answered by Chat at once
  // and searched in a box under that reply at the same time.
  // A research box the window put under Discover's reply (2026-10-14), its pending line `bart~> <askId>` under its
  // `@discover --research <direction>` line: asked as one the editor put there (askResearch), with the turns above it.
  // False until both lines are in the document, so the window tries again.
  askBoxed(askId) {
    const ls = this.lines(), at = ls.indexOf(`bart~> ${askId}`);
    if (at < 1 || !this.props.onAsk) return false;
    const p = parseLine(ls[at - 1]);
    if (!isResearch(p)) return false;
    this.askResearch({ askId, text: p.text.trim(), turns: this.turnsBefore(ls, at - 1), place: { line: at - 1, text: ls[at - 1] } });
    return true;
  }
  // A question that refines a search still running in its conversation (2026-10-13) stops it: `ls` with that box's pending
  // line written as what happened to it, so the box stays a turn of the conversation. Its run is stopped too; the answer it
  // would place finds no pending line.
  refining(ls, q) {
    const out = [...ls], ps = this.parsedOf(ls), thread = threads(ls, ps).find((t) => t.from <= q && q <= t.to);
    if (!thread) return out;
    for (const turn of thread.turns) {
      if (turn.q >= q || !turn.pending || !isResearch(ps[turn.q])) continue;
      const at = ls.indexOf(`bart~> ${turn.pending}`); if (at < 0) continue;
      out[at] = 'bart> Stopped: refined below.';
      this.stopRun(turn.pending);
    }
    return out;
  }
  // A run stopped from the document: a search still counting down (waitResearch) is cancelled, one at work is stopped.
  stopRun(askId) {
    if (this.waits.has(askId)) { const held = this.waits.get(askId); clearTimeout(held.timer); this.timers.delete(held.timer); this.waits.delete(askId); }
    else if (this.props.onStopAsk) this.props.onStopAsk(askId);
  }
  // A research box's search, asked of Discover; a Deep one after RESEARCH_WAIT_S seconds, its pending line counting them
  // down with Cancel beside it (waitResearch), so a reply that corrects what it is about costs nothing.
  askResearch(ask) {
    const full = { ...ask, agent: 'discover', research: true };
    const models = this.props.models, mode = models ? readDiscover(ask.text, models, ask.turns).mode : null;
    if (mode === 'deep') this.waitResearch(full); else this.props.onAsk(full);
  }
  // Whether line `i` stands right under the last line of an answered conversation (2026-10-13): asked from the document
  // there, it starts a conversation of its own (askInline, routeLine), as it is drawn while typed (doc.js threads). Not
  // under one still at work, which has no reply field yet: a line asked there goes on with it (a search refined, refining).
  underCard(ls, i) {
    // (Not under a Build's card, 2026-10-13: a line there was never a turn of the conversation it answers.)
    return i > 0 && threads(ls, this.parsedOf(ls)).some((t) => t.to === i - 1 && t.turns[t.turns.length - 1].answered && !t.turns[t.turns.length - 1].build && !t.turns.some((turn) => turn.pending));
  }
  // Whether the question on line `i` starts a conversation that takes a title (askInline, and handOff for a line Bart routed).
  // A Build's line (`--build`) does too (2026-10-13).
  startsTitled(ls, i, turns) {
    return !turns.length && !this.findTurn(ls, i)?.thread.turns.some((turn) => turn.q < i) && this.parsedOf(ls)[i - 1]?.type !== 'title';
  }
  // Bart, the router (2026-10-12): an `@bart` line gets its pending line (Workspace onRoute; it says "Thinking" as any
  // run's does), its agent by rule (model/route.js routeByRule) or else from the model (main/bart/route.cjs), and is
  // handed over (handOff). A follow-up (2026-10-13) tells the router which agent its thread is with (`current`), which it
  // stays with unless the line clearly wants another. `line`: an `@bart` line to put in at `i` first (sendFollow), in the
  // same change as its pending line.
  // `before`: a change to the lines made in the same edit (one undo), which keeps their number (sendFollow's fold).
  // `top`: where the question is kept on screen (keepAsked), the reply field's top for a follow-up; a typed line's own row's.
  // A typed line (`line` null) right under a card's last answer (2026-10-13) gets an empty line above it in the same change,
  // as askInline's does: it starts a conversation of its own, routed with no `current`, and handOff gives it its title line.
  routeLine(i, line = null, before = null, top) {
    const now = this.lines(), gap = line == null && this.underCard(now, i), put = line != null ? line : gap ? '' : null;
    const ls = put == null ? now : [...now.slice(0, i), put, ...now.slice(i)], q = gap ? i + 1 : i, p = parseLine(ls[q] || '');
    const askId = newAskId(), add = [`bart~> ${askId}`]; if (q + 1 >= ls.length) add.push('');
    const from = { key: this.props.docKey, props: this.props }; // handed off in this document, wherever the editor is by then
    const inputs = routeInputs(ls, q), current = inputs.current, rule = routeByRule(p.text, { models: this.props.models, current, asking: inputs.asking });
    const ed = this.editorEl(); this.holdAsked(askId, top !== undefined ? top : this.rowTop(ed, i));
    this.setLines((x) => { const out = before ? before(x) : [...x]; if (put != null) out.splice(i, 0, put); out.splice(q + 1, 0, ...add); return out; });
    if (ed) ed.blur(); this.setState({ activeLine: null, mention: null });
    this.expectReply(askId);
    const fallback = rule ? { agent: rule.agent, sure: 1, by: 'rule', rule: rule.rule } : { agent: fallbackAgent(current), sure: 0, by: 'none' };
    const level = this.routingLevel(ls, q, p.text, fallback.agent);
    const asked = this.props.onRoute
      ? Promise.resolve(this.props.onRoute({ askId, text: p.text.trim(), section: inputs.section, threads: inputs.threads, specAbove: inputs.specAbove, specTitle: inputs.specTitle, rule, current, place: { line: q, text: ls[q] }, ...(level ? { level } : {}) }))
      : Promise.resolve(fallback);
    return asked.catch(() => null).then((pick) => this.handOff(askId, pick || { agent: fallbackAgent(current), sure: 0 }, from));
  }
  // What a line's pending row names while Bart routes it (2026-10-13): the first step of the agent it goes to if he cannot
  // pick (`agent`: its rule's, else fallbackAgent's, Chat for a new line), read as main reads it (bart/ask.cjs turnPlan)
  // from the models file it was sent (props.models), with what the line pins by flags or was picked by hand (pickLine and
  // the follow-up's chip write those into it): a question's first step, an @discover line's level with the turns before
  // it. @brainstorm's model is never shown, and a Build has none. → { name, effort } | null
  routingLevel(ls, q, text, agent) {
    const models = this.props.models; if (!models || !models.providers) return null;
    try {
      const step = agent === 'discover' ? this.discoverRead(ls, q).steps[0] : agent === 'brainstorm' || agent === 'build' ? null : readQuestion(text, models).steps[0];
      return step && step.name ? { name: step.name, effort: step.effort || '' } : null;
    } catch { return null; }
  }
  // Where Bart's pick goes. The `@bart` line is the one over pending line `askId`, as the document holds it now (gone: the
  // line was deleted while it was being routed, and nothing is asked). That is the document it was typed in (`from`,
  // routeLine's), shown or not (2026-10-16: going to another workspace while Bart routed left the line "interrupted").
  //   chat, brainstorm, discover: asked of that agent. The line stays as typed; a line starting a conversation has the pick
  //     kept on its title line, `bart# [discover <when>] …` (doc.js titleLine), which it gets as an asked line does
  //     (askInline). A line going on with a conversation (2026-10-13) is its next turn whatever agent answers it: the
  //     title line keeps the first pick, and the turn's own closing line names who answered (doc.js turn.agent). A line
  //     starting an untitled conversation, which has nowhere to keep the pick, is written `@<token> <text>` as before.
  //   create: as chat, brainstorm and discover are, at once (2026-10-15, David: no "Create · Starts in 5 s" countdown;
  //     Stop stops a Create nobody wanted, and a stopped Create keeps nothing).
  //   build, with a spec above, sure ≥ 0.8, and the router saying the line asks for that spec (pick.spec, 2026-10-13: a
  //     request of its own was built as the unrelated spec above it): a Build of that fenced block as it reads now, with no
  //     reply of Chat's; the line stays, its card in place of its pending line.
  //   build otherwise: asked of Chat, told it is wanted built (routed.build, ` build` on the title line), so it writes the
  //     Build prompt.
  //   `--build` on the line (a rule): a Build of the line, as `@chat --build` makes (Workspace askBart); one starting a
  //     conversation gets a title line marked a Build's (2026-10-13), and its card collapses with it.
  // A pick made because routing failed (`by: 'error'`, Workspace routeLine) says so in `routed`, for the run's record.
  handOff(askId, pick, from = { key: this.props.docKey, props: this.props }) {
    const { key, props } = from, write = (fn) => this.setLinesOf(key, props, fn);
    const ls = this.linesOf(key, props) || [], at = ls.indexOf(`bart~> ${askId}`), q = at - 1, p = q >= 0 ? parseLine(ls[q]) : null;
    if (!p || p.type !== 'bart' || agentOf(p) !== 'router') { if (props.onRouteGone) props.onRouteGone(askId); return null; }
    const id = pick.id || null, text = p.text.trim(), typed = { line: q, text: ls[q] }; // where it was (the Agent Viewer)
    const failed = pick.by === 'error' ? { by: 'error', ...(pick.error ? { error: String(pick.error).slice(0, 400) } : {}) } : {};
    // A `--build` line that starts a conversation gets its title line (2026-10-13), marked a Build's, named from what it asks to build.
    if (pick.agent === 'build' && pick.rule === '--build') {
      const name = this.startsTitled(ls, q, this.turnsBefore(ls, q));
      if (name) write((x) => { const out = [...x], at = out.indexOf(`bart~> ${askId}`); if (at > 0) out.splice(at - 1, 0, titleLine('', false, { agent: 'bart', at: askedNow(), build: true })); return out; });
      props.onAsk({ askId, text, turns: [], agent: 'router', routed: { id, ...failed }, place: name ? { line: q + 1, text: typed.text } : typed, ...(name ? { name: true } : {}) });
      return 'build';
    }
    if (pick.agent === 'build') {
      const spec = routeInputs(ls, q).spec;
      if (spec != null && pick.spec === true && pick.sure >= 0.8 && props.onBuild) {
        // No reply of Chat's (2026-10-13): the Build's card takes the line's own pending line, so it is that turn's answer
        // (doc.js turn.build) and collapses as other Builds do; the card's Prompt row shows what it was given.
        props.onBuild({ text: spec, askId, routedFrom: id, place: typed });
        return 'build';
      }
    }
    const agent = ['brainstorm', 'discover', 'create'].includes(pick.agent) ? pick.agent : 'bart', build = pick.agent === 'build';
    // An `@bart` line goes on with the conversation above whatever agent answers it (doc.js followsIn).
    const turns = this.turnsBefore(ls, q);
    const above = q > 0 ? this.parsedOf(ls)[q - 1] : null, meta = { agent, at: askedNow(), build };
    let next = ls, name = false;
    if (turns.length) next = ls; // a follow-up: the title line keeps the first pick, the turn's closing line names this one
    else if (above && above.type === 'title') next = ls.map((l, j) => (j === q - 1 ? titleLine(above.text, above.folded, meta) : l));
    else if (this.startsTitled(ls, q, turns)) { next = [...ls]; next.splice(q, 0, titleLine('', false, meta)); name = true; }
    else next = ls.map((l, j) => (j === q ? `@${tokenOf(agent)}${p.text ? ` ${p.text}` : ''}` : l));
    // Sent to Discover: a search still running in its conversation stops, since this line says more about what to look for.
    const at2 = name ? q + 1 : q;
    if (agent === 'discover') next = this.refining(next, at2);
    if (next !== ls) write(() => next);
    const refine = agent === 'discover' && this.refiningAt(next, at2);
    const ask = { askId, text, turns, agent, routed: { id, ...failed, ...(build ? { build: true } : {}) }, place: { line: at2, text: typed.text }, ...(name ? { name: true } : {}), ...(refine ? { refine: true } : {}) };
    props.onAsk(ask);
    return agent;
  }
  // A reply sent under a running search (2026-10-16, David: "it should not restart the research process, rather just adjust,
  // similar to how Claude does it"): the search goes on with it, not over. Its words go on the box's line (`--steer
  // <words>`, drawn under the box's head), its pending line becomes the run that goes on, and main stops the search and
  // resumes it in its own session, told what was added (Workspace askBart's `steer`, main's bart/ask.cjs pausedFor). A Deep
  // box still counting down starts with the words in its line.
  steerResearch(from) {
    const ls = this.lines(), thread = threads(ls, this.parsedOf(ls)).find((t) => t.from === from), box = thread && thread.turns[thread.turns.length - 1];
    const words = (this.followText.get(from) || '').replace(/\s+/g, ' ').trim();
    if (!box || !box.pending || !words || !this.props.onAsk) return;
    this.followText.delete(from); this.followImages.delete(from);
    this.steerBox(ls, box, `${ls[box.q].trimEnd()} --steer ${words}`, { words });
  }
  // A running research box's line rewritten (`line`: a reply added to it, or its level picked, 2026-10-16) and its search
  // told so (`steer`: { words } or { level: true }), the run going on in its session (steerResearch).
  steerBox(ls, box, line, steer) {
    const i = box.q, after = box.pending, text = parseLine(line).text.trim();
    const held = this.waits.get(after);
    if (held) { held.ask = { ...held.ask, text, place: { line: i, text: line } }; this.setLines((x) => x.map((l, j) => (j === i ? line : l))); return; }
    const askId = newAskId(), at = ls.indexOf(`bart~> ${after}`);
    this.setLines((x) => x.map((l, j) => (j === i ? line : j === at ? `bart~> ${askId}` : l)));
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text, turns: this.turnsBefore(ls, i), agent: 'discover', research: true, place: { line: i, text: line }, steer: { after, ...steer } });
  }
  // A Deep research box's search (askResearch) is asked after RESEARCH_WAIT_S seconds, its pending line counting them down
  // ("Searching in 5 s") with Cancel beside it. The line deleted meanwhile, nothing is asked. It is looked for in the
  // document the box is in, shown or not (handOff's `from`).
  waitResearch(ask) {
    const { docKey: key } = this.props, props = this.props;
    const redraw = () => { if (!this.patchPending()) this.syncEditor(); };
    const tick = () => {
      const held = this.waits.get(ask.askId); if (!held) return;
      if (!(this.linesOf(key, props) || []).includes(`bart~> ${ask.askId}`)) { this.waits.delete(ask.askId); if (props.onRouteGone) props.onRouteGone(ask.askId); return; }
      if (held.left <= 1) { this.waits.delete(ask.askId); props.onAsk(ask); redraw(); return; }
      held.left -= 1; held.timer = this.timer(tick, 1000); redraw();
    };
    this.waits.set(ask.askId, { ask, left: RESEARCH_WAIT_S, timer: this.timer(tick, 1000) });
    redraw();
  }
  // Cancel on a Deep research box counting down (2026-10-13): the box is taken out, and nothing is searched.
  cancelWait(askId) {
    const held = this.waits.get(askId); if (!held) return false;
    clearTimeout(held.timer); this.timers.delete(held.timer); this.waits.delete(askId);
    const at = this.lines().indexOf(`bart~> ${askId}`);
    if (at > 0 && isResearch(this.parsedOf(this.lines())[at - 1])) this.setLines((x) => x.filter((_, j) => j !== at - 1 && j !== at));
    else if (!this.patchPending()) this.syncEditor();
    return true;
  }
  // The footer's Build (2026-10-12): the turn's last fenced block as it reads now, else its question and answer, built;
  // the card goes on a line of its own after the thread (Workspace onBuild).
  footBuild(q) {
    const ls = this.lines(), found = this.findTurn(ls, q);
    if (!found || !found.turn.answered || found.turn.pending || found.thread.turns.some((t) => t.pending) || !this.props.onBuild) return false;
    this.props.onBuild({ text: buildTextOf(ls, found.turn), after: found.thread.to, afterLine: ls[found.thread.to], place: { line: found.turn.q, text: ls[found.turn.q] } });
    return true;
  }
  // Another agent for a line Bart routed: asked again of it in its place; the run says the person corrected Bart
  // (routed.corrected), and the router's record is marked. The `@bart` line stays. Its conversation's first turn changes
  // its agent on the title line, which keeps the first pick; a follow-up (2026-10-13) is only asked of the other agent,
  // whose closing line then names it. An older document's line, written as the agent's, is written again.
  // Since the foot lost its label (2026-10-13), nothing on the page opens this picker (kind 'via'); it stays for when a
  // control for it comes back.
  pickVia = (agent) => {
    const pk = this.state.picker; this.closePicker(); if (!pk || pk.kind !== 'via') return;
    const ls = this.lines(), q = pk.i, p = parseLine(ls[q] || ''), found = this.findTurn(ls, q);
    if (p.type !== 'bart' || !found || found.turn.pending) return;
    const undo = { text: ls.join('\n'), caret: null, mark: this.history.length }, { thread, turn } = found;
    if (agentOf(p) === 'router' && (thread.routedTo || q !== thread.from)) {
      const lead = turn.foot >= 0 ? (parseLine(ls[turn.foot]).text.replace(/^\*|\*$/g, '').match(LEAD_RE) || [])[1] : null;
      if (this.turnAgent(thread, turn) === agent && !(q === thread.from ? thread.build : lead === 'Build')) return;
      let lines = ls;
      if (q === thread.from && thread.titleLine >= 0) {
        const head = this.parsedOf(ls)[thread.titleLine];
        lines = ls.map((l, j) => (j === thread.titleLine ? titleLine(head.text, head.folded, { agent, at: head.at }) : l));
      }
      this.regenerate(q, undefined, { lines, undo }, { corrected: tokenOf(agent) }, agent);
      return;
    }
    if (agentOf(p) === agent) return;
    const lines = ls.map((l, j) => (j === q ? `@${tokenOf(agent)}${p.text ? ` ${p.text}` : ''}` : l));
    this.regenerate(q, undefined, { lines, undo }, { corrected: tokenOf(agent) });
  };
  // The turns of the card above question `q`, as the document holds them: what a follow-up is a follow-up to.
  // Each { question, answer, agent }: `agent` the one that answered it (doc.js turn.agent), so a run asked of another agent
  // knows who said what (main's ask.cjs).
  turnsBefore(ls, q) {
    const found = this.findTurn(ls, q); if (!found) return [];
    return found.thread.turns.filter((turn) => turn.q < q && turn.answered && !turn.pending).map((turn) => withAgent(turnText(ls, turn), turn));
  }
  // An @discover line as it would run if sent now (2026-10-03): the level and provider it names, else the ones an earlier
  // turn of its exchange carries, else Standard on the default provider; or the model and effort a flag pins it to
  // (readDiscover, as the run reads it). On a provider other than the default, the chip names it: "Codex · Deep".
  discoverRead(ls, i) { return readDiscover(parseLine(ls[i] || '').text, this.props.models, this.turnsBefore(ls, i)); }
  discoverLabel(i) {
    const models = this.props.models, read = this.discoverRead(this.lines(), i), step = read.steps[0];
    if (read.pinned) return `${step.name} ${EFFORT_LABELS[step.effort] || step.effort}`;
    return read.provider === models.provider ? LEVEL_LABELS[read.mode] : `${models.providers[read.provider].name} · ${LEVEL_LABELS[read.mode]}`;
  }
  // A follow-up: the question goes under the card's last answer as a line of its own, with the pending line under it.
  // Typed (2026-10-13), it is an `@bart` line, routed as one (routeLine): Bart keeps it with the agent the card is with
  // unless it clearly wants another, and the card goes on whichever answers. Sent empty (a FOLLOW agent's field marked
  // `empty`; none is since @brainstorm became a conversation, 2026-10-14), it asks what the card's last turn asked. Sent, the turns before it but the last collapse (foldOlder; until 2026-10-14
  // all of them), in the same edit: each shows its question and its foot, whose Expand opens it again (toggleFold).
  sendFollow(from) {
    if (this.refineOpen.has(from)) { this.sendRefine(from); return; }
    // Under a research box not started yet, or one the app closed on, what is typed adjusts its plan (2026-10-16, David's
    // mockup: "reply to adjust the plan"): it is a Refine.
    { const ls0 = this.lines(), t0 = threads(ls0).find((t) => t.from === from), e0 = t0 && t0.turns[t0.turns.length - 1];
      if (e0 && isResearch(this.parsedOf(ls0)[e0.q]) && ['ready', 'interrupted'].includes(this.boxState(ls0, e0))) { this.sendRefine(from); return; }
      if (e0 && isResearch(this.parsedOf(ls0)[e0.q]) && this.boxState(ls0, e0) === 'running') { this.steerResearch(from); return; } }
    const ls = this.lines(), thread = threads(ls).find((t) => t.from === from), typed = (this.followText.get(from) || '').trim();
    if (!thread || !this.props.onAsk) return;
    const end = thread.turns[thread.turns.length - 1]; let agent = answeredBy(thread);
    const discovering = discoverThread(thread); // a Discover conversation collapses nothing (2026-10-15, David)
    // Under a live card, what is sent answers it (sendCard): it is never routed.
    const live = this.cardsOf(ls).byQ.get(end.q); if (live && live.live) { this.sendCard(end.q); return; }
    if (!end.answered || end.pending || (!typed && !(FOLLOW[agent] && FOLLOW[agent].empty))) return;
    // A pasted image goes into the line as its [Attachment n] token stood; one whose token was deleted is not sent.
    const text = withAttachments(typed, this.followImages.get(from) || []);
    // What is typed may start by naming an agent (2026-10-14): `@brainstorm …` is asked of Brainstorm as it stands, never
    // routed, and without the thread's model flags; `@bart …` is routed as any typed line is.
    const named = /^@(bart|chat|brainstorm|orient|discover|create)(?=\s|$)\s*/i.exec(text), token = named && named[1].toLowerCase();
    const own = token && token !== 'bart', said = named ? text.slice(named[0].length) : text;
    const { flags } = own ? { flags: '' } : this.followStep(ls, thread), asked = [flags, said].filter(Boolean).join(' ');
    this.followText.delete(from); this.followImages.delete(from);
    const ed = this.editorEl();
    const routed = typed && !own && this.props.onRoute, question = routed ? `@bart ${asked}` : own ? `@${token} ${asked}`.trimEnd() : `@${tokenOf(agent)} ${asked}`.trimEnd();
    if (own) agent = agentOf(parseLine(question));
    // The question goes where the field's top is (keepAsked): the turns folding above it in the same edit move nothing on screen.
    const top = this.fieldTop(ed, from);
    if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    const fold = (x) => (discovering ? [...x] : foldOlder(x, thread.turns));
    if (routed) { this.routeLine(thread.to + 1, question, fold, top); return; }
    const askId = newAskId(), add = [question, `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const turns = thread.turns.filter((turn) => turn.answered && !turn.pending).map((turn) => withAgent(turnText(ls, turn), turn));
    this.holdAsked(askId, top); this.setLines((x) => { const out = fold(x); out.splice(thread.to + 1, 0, ...add); return out; });
    this.setState({ activeLine: null, mention: null });
    this.expectReply(askId); // the answer's reply field takes the keyboard (2026-10-16, David; Discover's alone before)
    const refine = agent === 'discover' && this.refiningIn(ls, thread);
    this.props.onAsk({ askId, text: asked, turns, agent, place: { line: thread.to + 1, text: add[0] }, ...(refine ? { refine: true } : {}) });
  }
  // While the field's @ menu shows, the arrows move in it, Enter or Tab puts the row in and Escape closes it alone; Enter
  // sends, and Escape leaves the field, once it is closed.
  followKey(e) {
    if (this.state.picker) this.closePicker();
    const m = this.state.mention, items = m && m.field === Number(e.target.dataset.followInput) ? this.mentionList() : [];
    if (items.length && e.key === 'Backspace' && e.target.selectionStart === e.target.selectionEnd && !e.metaKey && !e.ctrlKey && this.upFromFolder(m, e.target.selectionStart)) { e.preventDefault(); return; }
    if (items.length) {
      const n = items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx + 1) % n }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx - 1 + n) % n }); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) { e.preventDefault(); this.pickMention(items[this.state.mentionIdx] || items[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.setState({ mention: null }); return; }
    }
    if (e.key === 'Enter' && e.shiftKey) e.preventDefault(); // one line of the document: no line breaks
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.sendFollow(Number(e.target.dataset.followInput)); }
    else if (e.key === 'Escape') { e.preventDefault(); const from = Number(e.target.dataset.followInput); e.target.blur(); if (!(this.followText.get(from) || '').trim()) this.closeRefine(from); }
  }
  // Send to Discover's keys (MATH-31): Enter sends, Shift+Enter puts in nothing (what is sent is one line of the document),
  // Escape leaves the field.
  discoverKey(e) {
    if (this.state.picker) this.closePicker();
    if (e.key === 'Enter' && e.shiftKey) e.preventDefault();
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.sendDiscover(e.target.dataset.discoverInput); }
    else if (e.key === 'Escape') { e.preventDefault(); const target = e.target.dataset.discoverInput; e.target.blur(); if (!(this.discoverText.get(target) || '').trim()) this.closeDiscover(target); }
  }
  // The button opens its field, the caret in it; Escape in an empty field shuts it again (2026-10-05).
  openDiscover(target) {
    this.discoverOpen.add(target); this.syncEditor();
    const ed = this.editorEl(), input = ed && ed.querySelector ? ed.querySelector(`[data-discover-input="${target}"]`) : null;
    if (input) input.focus({ preventScroll: true });
  }
  closeDiscover(target) { if (this.discoverOpen.delete(target)) this.syncEditor(); }
  discoverInput(input) {
    if (/[\r\n]/.test(input.value)) { const a = input.selectionStart, b = input.selectionEnd; input.value = input.value.replace(/[\r\n]/g, ' '); input.setSelectionRange(a, b); }
    this.discoverText.set(input.dataset.discoverInput, input.value); this.paintSend(input); this.fitFollow(input);
  }
  followInput(input) {
    if (/[\r\n]/.test(input.value)) { const a = input.selectionStart, b = input.selectionEnd; input.value = input.value.replace(/[\r\n]/g, ' '); input.setSelectionRange(a, b); }
    this.followText.set(Number(input.dataset.followInput), input.value); this.paintSend(input); this.fitFollow(input);
    this.followMention(input);
  }
  // The @ menu in a follow-up field (2026-10-02): opened, narrowed or closed by what stands before the field's caret, as
  // on a document line, and hung from that caret. It is the menu's `field` form: the thread's first line, and no line `i`.
  followMention(input) {
    const from = Number(input.dataset.followInput), caret = input.selectionStart, read = this.readMention(input.value, caret, { field: from }), found = read.found, open = this.state.mention;
    if (found) {
      const mention = { field: from, query: found.query, start: found.start, caret, anchor: fieldCaret(input, caret) };
      this.setState({ mention, browse: read.browse, mentionIdx: this.mentionStart(mention, read.browse) });
      if (read.into != null) this.browseInto(mention, read.browse.row, read.into, read.browse.before);
    } else if (open && open.field === from) this.setState({ mention: null, browse: null });
  }
  // Text pasted into a field of the editor's own (a follow-up, a Build's reply, a card's field, Send to Discover) that
  // was copied from a PDF goes in without the page's layout (MATH-24); the field's input handler then runs as for typing.
  // An image paste is handled above and has already been taken.
  fieldPaste(e) {
    const field = e.target, data = e.clipboardData; if (e.defaultPrevented || !data || typeof field.setRangeText !== 'function') return;
    const raw = (data.getData('text/plain') || '').replace(/\r/g, ''), text = pdfText(raw);
    if (!raw || text === raw) return;
    e.preventDefault();
    field.setRangeText(text, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // An image pasted into a follow-up (2026-10-02) is saved as one pasted into the document is (the parent's onPasteImage)
  // and named in the field as [Attachment n], numbered on from the document's images; sendFollow writes it into the line.
  // A text paste is the field's own, as before.
  followPaste(e) {
    const from = Number(e.target.dataset.followInput);
    const pasted = [...(((e.clipboardData || {}).files) || [])].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (!pasted.length || !this.props.onPasteImage) return; // text pastes as text
    e.preventDefault();
    void (async () => {
      for (const file of pasted) {
        const draft = this.followImages.get(from) || [], inDoc = (String(this.props.text ?? '').match(/\]\(img:/g) || []).length;
        const n = Math.max(inDoc + draft.length, ...draft.map((image) => image.n)) + 1;
        this.followImages.set(from, [...draft, { n, id: null }]); // holds the number while it saves
        let saved = null;
        try { saved = await this.props.onPasteImage(file, `Attachment ${n}`); } catch { saved = null; }
        const held = (this.followImages.get(from) || []).filter((image) => image.n !== n);
        if (!saved || !saved.id || !this.mounted) { this.followImages.set(from, held); continue; }
        this.followImages.set(from, [...held, { n, id: saved.id }]);
        // The field as it is now: a redraw while the image saved replaced the one pasted into.
        const field = this.editorEl() && this.editorEl().querySelector(`[data-follow-input="${from}"]`), token = `[Attachment ${n}]`;
        if (field) {
          const a = field.selectionStart ?? field.value.length, b = field.selectionEnd ?? a, before = field.value.slice(0, a);
          field.setRangeText(`${before && !/\s$/.test(before) ? ' ' : ''}${token} `, a, b, 'end');
          this.followInput(field);
        } else {
          const text = this.followText.get(from) || '';
          this.followText.set(from, `${text}${text && !/\s$/.test(text) ? ' ' : ''}${token} `);
        }
      }
    })();
  }
  // What answered turn `q`, read from its closing line ("Sol · medium · 31 s"); the question's own first step when there is
  // none. → { current } for the selector to mark, and { choice } to regenerate with the same model and effort.
  ranWith(ls, q) {
    const models = this.props.models, found = this.findTurn(ls, q); if (!models || !found) return { current: null, choice: undefined };
    const said = found.turn.foot >= 0 ? parseLine(ls[found.turn.foot]).text.slice(1, -1) : '';
    const [name, effort] = said ? said.replace(LEAD_RE, '').split(' · ') : [];
    for (const [provider, entry] of Object.entries(models.providers)) {
      for (const [key, model] of Object.entries(entry.models)) if (model.name === name && effortOf(effort)) return { current: { provider, model: key, effort: effortOf(effort) }, choice: { model: key, effort: effortOf(effort) } };
    }
    const step = readQuestion(parseLine(ls[q]).text, models).steps[0];
    return { current: { provider: step.provider, model: step.key, effort: step.effort }, choice: undefined };
  }
  // Regenerate: the answer gives way to a pending line and the question is asked again, as a follow-up to the turns above
  // it. `choice` is a model and effort for this run; the line keeps the words it was asked with. `edited` (2026-10-03): a
  // question edited in place is asked from { lines } (its new words, the turns after it gone), and undo goes to { undo }.
  // `routed` (2026-10-12): the turn was handed over by Bart; asked again it is asked of the agent that answered it (its
  // closing line's, 2026-10-13), as routed, or `{ corrected }` with `as`, the agent the person picked instead (pickVia).
  regenerate(q, choice, edited = null, routed = null, as = null) {
    const ls = edited ? edited.lines : this.lines(), found = this.findTurn(ls, q); if (!found || found.turn.pending || found.turn.build || !this.props.onAsk) return;
    const { turn, thread } = found, p = parseLine(ls[q]), agent = agentOf(p) === 'router' ? as || this.turnAgent(thread, turn) : agentOf(p); if (!p.text.trim() && !oneModel(agent)) return;
    const was = (edited ? this.lines() : ls), oldFoot = this.findTurn(was, q), footText = oldFoot && oldFoot.turn.foot >= 0 ? parseLine(was[oldFoot.turn.foot]).text : '';
    // Handed over by Bart: an `@bart` line whose conversation's title line keeps his pick, or an older closing line's "via Bart".
    const said = String(footText).replace(/^\*|\*$/g, ''), via = said.match(VIA_RE);
    const lead = (said.match(LEAD_RE) || [])[1];
    const routing = routed || (via ? { build: !!via[1] } : agentOf(p) === 'router' && (thread.routedTo || lead) ? { build: lead === 'Build' || (thread.build && q === thread.from) } : null);
    const askId = newAskId(), gone = turn.to - turn.q, turns = this.turnsBefore(ls, q);
    this.cardState.delete(q);
    const asked = (x) => { const out = [...x]; out.splice(turn.from, gone, `bart~> ${askId}`); return out; };
    if (edited) this.setDoc(asked(ls).join('\n'), undefined, edited.undo); else this.setLines(asked);
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: p.text.trim(), turns, agent, place: { line: q, text: ls[q] }, choice: choice && this.props.models && modelOf(choice.model, this.props.models) ? choice : undefined, ...(routing ? { routed: routing } : {}) });
    return askId;
  }
  // Edit (2026-10-03): the question of an answered turn becomes an ordinary agent line again (lockedAt), as it stands with
  // its @agent and flags, the caret at its end and its answer dimmed under it. One question at a time: another's goes back.
  startEdit(q) {
    if (this.editing && this.editing.q !== q) this.cancelEdit();
    const ls = this.lines();
    if (!this.editing) {
      const at = this.layout(ls).get(q); if (!at || at.role !== 'question' || !at.editable) return;
      const ed = this.editorEl(), field = document.activeElement;
      if (ed && field && field !== ed && ed.contains(field)) field.blur(); // a field of the editor's had the keyboard
      this.editing = { q, original: ls[q], under: ls.slice(at.turn.from, at.turn.to + 1), mark: this.history.length };
    }
    this.caret = { line: q, offset: (ls[q] ?? '').length }; this.wantFocus = true; this.lastHtml = null;
    this.setState({ activeLine: q, mention: null });
  }
  // Out of edit mode with the question as it was: Escape, ⌘Z with nothing typed, or the caret, the keyboard or a click going
  // elsewhere. What was typed into it leaves the document and undo. `blur`: the caret has nowhere left to be.
  cancelEdit(blur = false) {
    const was = this.editing; if (!was) return;
    this.editing = null;
    this.history.length = Math.min(this.history.length, was.mark);
    const ls = this.lines();
    if (ls[was.q] != null && ls[was.q] !== was.original) {
      const from = String(this.props.text ?? ''), text = ls.map((l, j) => (j === was.q ? was.original : l)).join('\n');
      this.props.onChange(text); this.textNow = { text, from };
    }
    const s = this.state;
    if (s.picker && s.picker.kind === 'line' && s.picker.i === was.q) this.closePicker();
    if (s.mention && s.mention.field == null) this.setState({ mention: null });
    if (blur) { const ed = this.editorEl(); if (ed) ed.blur(); }
    this.redraw();
  }
  // Enter on the question being edited. Unchanged, edit mode ends and nothing is asked. Changed, the turns after it in its
  // thread leave the document (a run among them is stopped) and it is asked again as Regenerate asks it, with the choice
  // Regenerate would make (ranWith), unless its model or effort flags were changed while it was edited (its chip): then
  // the line says. One undo brings back the question, its answer and those turns. A line that no longer asks the same
  // agent, or asks for a Build, or (@bart) asks nothing, is not asked: Enter waits.
  commitEdit() {
    const was = this.editing; if (!was) return;
    const ls = this.lines(), q = was.q, line = ls[q] ?? '';
    if (line === was.original) { this.cancelEdit(true); return; }
    const p = parseLine(line), found = this.findTurn(ls, q), agent = agentOf(p) === 'router' && found ? this.turnAgent(found.thread, found.turn) : agentOf(p);
    if (p.type !== 'bart' || agentOf(p) !== agentOf(parseLine(was.original)) || buildRequestOf({ agent: agentOf(p), text: p.text }) || (!p.text.trim() && !oneModel(agent))) return;
    if (!found || found.turn.pending || !this.props.onAsk) return;
    const later = found.thread.turns.filter((turn) => turn.q > q);
    const lines = later.length ? [...ls.slice(0, later[0].q), ...ls.slice(found.thread.to + 1)] : ls;
    const models = this.props.models, flags = (l) => { const text = parseLine(l).text; return models ? readFlags(text, models).spans.map(([a, b]) => text.slice(a, b)).join(' ') : ''; };
    const choice = oneModel(agent) || flags(line) !== flags(was.original) ? undefined : this.ranWith(ls, q).choice;
    for (const turn of later) if (turn.pending && this.props.onStopAsk) this.props.onStopAsk(turn.pending);
    this.editing = null;
    const ed = this.editorEl(); if (ed) ed.blur();
    this.regenerate(q, choice, { lines, undo: { text: ls.map((l, j) => (j === q ? was.original : l)).join('\n'), caret: null, mark: was.mark } });
  }
  // The document changed under a question being edited (an answer landed above it, an undo): it is found again by its
  // answer, which nothing changes while it is edited, under the nearest question line; the caret goes with it. Not found,
  // edit mode ends with the document as it is.
  trackEdit() {
    const was = this.editing, ls = this.lines(), ps = this.parsedOf(ls), n = was.under.length;
    const holds = (j) => j + n < ls.length && was.under.every((l, k) => ls[j + 1 + k] === l);
    if (holds(was.q)) return;
    let q = -1;
    for (let j = 0; j < ls.length; j++) if (ps[j].type === 'bart' && holds(j) && (q < 0 || Math.abs(j - was.q) < Math.abs(q - was.q))) q = j;
    if (q < 0) { this.editing = null; return; }
    this.editing = { ...was, q };
    if (this.state.activeLine !== was.q) return;
    const c = this.caretInfo();
    this.caret = { line: q, offset: c && c.anchor.line === was.q ? c.anchor.offset : ls[q].length };
    this.setState({ activeLine: q });
  }
  // A question left being edited when its document is replaced or the editor goes: it goes back as it was, in that document.
  dropEdit(props) {
    const was = this.editing; if (!was) return;
    this.editing = null; this.textNow = null;
    const ls = String(props.text ?? '').split('\n');
    if (ls[was.q] != null && ls[was.q] !== was.original && props.onChange) props.onChange(ls.map((l, j) => (j === was.q ? was.original : l)).join('\n'));
  }
  // The selection, once the mouse is up, is no longer inside the question being edited (an arrow, a click on another line,
  // select all): it goes back.
  leftEdit() {
    const sel = getSelection(), ed = this.editorEl(); if (!sel || !sel.rangeCount || !ed) return;
    const row = ed.querySelector(`[data-line="${this.editing.q}"]`), r = sel.getRangeAt(0);
    if (!row || !row.contains(r.startContainer) || !row.contains(r.endContainer)) this.cancelEdit();
  }
  inEdit(el) { const row = el && el.closest && el.closest('[data-line]'); return !!row && !!this.editing && Number(row.dataset.line) === this.editing.q; }
  // Collapse / Expand: the fold is in the file, on every line of the answer, so it survives whatever else changes.
  toggleFold(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found || !found.turn.answered) return;
    const { turn } = found, to = !turn.folded;
    this.setLines((x) => x.map((l, j) => { if (j < turn.from || j > turn.to) return l; const p = parseLine(l); return p.type === 'reply' ? replyLine(p.text, to).trimEnd() : l; }));
    this.setState({ activeLine: null, mention: null });
  }
  // A turn's Collapse (2026-10-13, David): it folds that exchange alone, to a line at the top of its card, whatever else in
  // its conversation is at work. The first exchange of a titled conversation collapses the conversation to its title's row
  // instead (toggleThread), once nothing in it runs (2026-10-16, David: it was the last exchange left open, so a later
  // turn's Collapse could close everything). A folded turn's line expands it (toggleFold).
  collapseTurn(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return;
    const { thread, turn } = found;
    if (this.collapsesThread(thread, turn)) this.toggleThread(thread.titleLine); else this.toggleFold(q);
  }
  // Whether `turn`'s Collapse collapses its whole conversation (collapseTurn): it is the first exchange of a titled one,
  // open, and nothing in the conversation is at work.
  collapsesThread(thread, turn) {
    const first = thread.turns[0];
    return !!turn && !!first && first.q === turn.q && !turn.folded && thread.titleLine >= 0 && !isRunning(thread, this.props.builds);
  }
  // A conversation's Collapse, or a click on one of its open questions (2026-10-15, David): a titled one collapses whole, to
  // its title's row, at work or not (its answer lands hidden); one with no title, or a Build's not yet finished, has each
  // of its answered exchanges folded to its line instead.
  collapseAll(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return;
    const { thread } = found;
    if (thread.titleLine >= 0 && !isBuilding(thread, this.props.builds)) { this.toggleThread(thread.titleLine); return; }
    this.setLines((x) => foldTurns(x, thread.turns));
    this.setState({ activeLine: null, mention: null });
  }
  // A titled conversation (2026-10-12) collapses whole, to its title's row, and expands again: the fold is its title line's
  // `bart#+`, its answers' lines stay as they are. One at work collapses too (2026-10-15, David); one a Build is still at
  // work on stays open.
  toggleThread(line) {
    const ls = this.lines(), thread = threads(ls, this.parsedOf(ls)).find((t) => t.titleLine === line); if (!thread) return;
    if (!thread.folded && isBuilding(thread, this.props.builds)) return;
    this.titleEdit = null;
    const head = this.parsedOf(ls)[line];
    this.setLines((x) => x.map((l, j) => (j === line ? titleLine(thread.title, !thread.folded, head).trimEnd() : l)));
    this.setState({ activeLine: null, mention: null });
  }
  // Coming back to a document (2026-10-13, Hudson's): the titled conversations left open in it are collapsed, all
  // but those still at work or not yet answered, once each time it is shown (its docKey, in this editor) and its text has
  // loaded. Only where the workspace asks for it (autoCollapse), never in a read-only document, and not an edit to undo.
  // A conversation answered by a Build (2026-10-13) collapses once its Build is finished; one whose Build's record had not
  // loaded yet is decided once it has (autoWait, the ids waited for), and only then.
  autoCollapse() {
    const { autoCollapse, readOnly, docKey, text, builds } = this.props;
    if (!autoCollapse || readOnly || typeof text !== 'string') return;
    const first = this.autoFolded !== docKey;
    if (!first && !(this.autoWait && this.autoWait.docKey === docKey && [...this.autoWait.ids].some((id) => builds && builds[id]))) return;
    if (first) { this.autoFolded = docKey; this.autoWait = { docKey, ids: new Set() }; }
    const ls = text.split('\n'), ps = parseLines(ls), titles = new Map(), wait = this.autoWait.ids;
    for (const thread of threads(ls, ps)) {
      if (thread.titleLine < 0 || thread.folded || !thread.turns.some((turn) => turn.answered)) continue;
      const ids = thread.turns.filter((turn) => turn.build).map((turn) => turn.build), unknown = ids.filter((id) => !(builds && builds[id]));
      if (unknown.length) { if (first) unknown.forEach((id) => wait.add(id)); continue; }
      if (!first) { if (!ids.some((id) => wait.has(id))) continue; ids.forEach((id) => wait.delete(id)); }
      if (!isRunning(thread, builds)) titles.set(thread.titleLine, thread.title);
    }
    if (!first) for (const id of [...wait]) if (builds[id]) wait.delete(id); // decided, or its conversation is gone
    if (titles.size) this.props.onChange(ls.map((l, j) => (titles.has(j) ? titleLine(titles.get(j), true, ps[j]).trimEnd() : l)).join('\n'));
  }
  // Collapse all / Expand all (2026-09-29): every answer in the document at once, folded as each card's own Collapse
  // folds it: a titled conversation by its title line, whole (2026-10-12), an older one a turn at a time. A run still at
  // work is left as it is, though one collapsed while at work is opened by Expand all. → [{ folded, title }] for titled
  // conversations, [{ folded, turn }] for the turns of the rest.
  foldable(ls) {
    const out = [];
    for (const thread of threads(ls, this.parsedOf(ls))) {
      if (thread.titleLine >= 0) { if (thread.folded || (!isRunning(thread, this.props.builds) && thread.turns.some((turn) => turn.answered))) out.push({ title: thread.titleLine, folded: thread.folded }); continue; }
      for (const turn of thread.turns) if (turn.answered && !turn.pending && !turn.build) out.push({ turn, folded: turn.folded });
    }
    return out;
  }
  // Expand all also opens the turns a follow-up collapsed in a titled conversation (sendFollow).
  foldAll(to) {
    const items = this.foldable(this.lines()); if (!items.length) return;
    const inTitled = to ? [] : threads(this.lines(), this.parsedOf(this.lines())).filter((t) => t.titleLine >= 0).flatMap((t) => t.turns.filter((turn) => turn.answered && !turn.pending && !turn.build));
    const turns = [...items.filter((item) => item.turn).map((item) => item.turn), ...inTitled], titles = new Set(items.filter((item) => item.title != null).map((item) => item.title));
    const under = (j) => turns.some((turn) => j >= turn.from && j <= turn.to);
    this.titleEdit = null;
    this.setLines((x) => x.map((l, j) => {
      if (titles.has(j)) { const p = parseLine(l); return p.type === 'title' && p.folded !== to ? titleLine(p.text, to, p).trimEnd() : l; }
      if (!under(j)) return l; const p = parseLine(l); return p.type === 'reply' && p.folded !== to ? replyLine(p.text, to).trimEnd() : l;
    }));
    this.setState({ activeLine: null, mention: null });
  }
  // Renaming a conversation (2026-10-12): its collapsed row's title becomes a field holding it; Enter or leaving the field writes
  // what it holds to the title line (an empty field changes nothing), Escape puts it back as it was.
  startTitle(line) {
    const p = this.parsedOf(this.lines())[line]; if (!p || p.type !== 'title' || this.props.readOnly) return;
    this.titleEdit = { line, value: p.text.trim() }; this.lastHtml = null; this.syncEditor();
    const input = this.editorEl() && this.editorEl().querySelector(`[data-title-input="${line}"]`);
    if (input) { input.focus({ preventScroll: true }); input.select(); }
  }
  titleKey(e) {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.commitTitle(e.target); }
    else if (e.key === 'Escape') { e.preventDefault(); this.titleEdit = null; this.lastHtml = null; this.syncEditor(); }
  }
  titleInput(input) { if (this.titleEdit) this.titleEdit.value = input.value; }
  commitTitle(input) {
    const held = this.titleEdit; if (!held) return; this.titleEdit = null;
    const text = flattenPaste(input ? input.value : held.value), ls = this.lines(), p = this.parsedOf(ls)[held.line];
    if (!text || !p || p.type !== 'title' || text === p.text.trim()) { this.lastHtml = null; this.syncEditor(); return; }
    this.setLines((x) => x.map((l, j) => (j === held.line ? titleLine(text, p.folded, p) : l)));
  }
  /* A conversation is taken away whole (2026-10-15, David), as a picture is: Backspace at the start of the line under it
     (an empty one goes first) or Delete at the end of the line over it marks it (armed: tinted), and the same key again
     takes it away, from its title line to its last line; ⌘Z brings it back. Any other key, a click, leaving the document
     or an edit that moves it unmarks it. One still at work (a run, a Build) is not marked. */
  // The conversation whose last line is `end`, or whose first line (its title line, if it has one) is `start`.
  blockAt(ls, { end = null, start = null }) {
    const thread = threads(ls, this.parsedOf(ls)).find((t) => (end != null ? t.to === end : (t.titleLine >= 0 ? t.titleLine : t.from) === start));
    if (!thread || isRunning(thread, this.props.builds)) return null;
    return { thread, from: thread.titleLine >= 0 ? thread.titleLine : thread.from, to: thread.to };
  }
  armedIs(block) { const armed = this.armed; return !!armed && armed.from === block.from && armed.to === block.to; }
  arm(block) { this.armed = { from: block.from, to: block.to, head: block.thread.from }; this.markArmed(); }
  disarm() { if (!this.armed) return; this.armed = null; this.markArmed(); }
  markArmed() {
    const ed = this.editorEl(); if (!ed || !ed.querySelectorAll || (!this.armed && !this.armedDrawn)) return;
    // Still that conversation, where it was: an edit that moved it or changed it unmarks it.
    if (this.armed) { const block = this.blockAt(this.lines(), { start: this.armed.from }); if (!block || block.to !== this.armed.to) this.armed = null; }
    const armed = this.armed;
    for (const el of ed.querySelectorAll('[data-armed]')) el.removeAttribute('data-armed');
    this.armedDrawn = !!armed; if (!armed) return;
    for (const el of ed.querySelectorAll('[data-line]')) { const j = Number(el.dataset.line); if (j >= armed.from && j <= armed.to) el.setAttribute('data-armed', ''); }
    for (const el of ed.querySelectorAll(`[data-followup="${armed.head}"]`)) el.setAttribute('data-armed', '');
    for (const el of ed.querySelectorAll('[data-more]')) { const j = Number(el.dataset.more); if (j >= armed.from && j <= armed.to) el.setAttribute('data-armed', ''); }
  }
  // A selection from a line of text to another with a whole conversation between them, deleted or cut (2026-10-15, David):
  // done on the document, not left to the browser, which lost the end line's rest across the conversation's blocks. The
  // two ends join as Backspace joins lines; a conversation at work between them stays. → whether it was done here.
  // The selection when it runs from a line of text to another over a whole conversation: its ends, and the conversations
  // between them; null otherwise.
  across() {
    const ends = this.selEnds(); if (!ends || ends.start.line === ends.end.line) return null;
    const ls = this.lines(), ps = this.parsedOf(ls), { start, end } = ends;
    const all = threads(ls, ps).map((t) => ({ t, from: t.titleLine >= 0 ? t.titleLine : t.from, to: t.to }));
    const inOne = (j) => all.some((b) => j >= b.from && j <= b.to) || this.lockedAt(ls, j);
    const blocks = all.filter((b) => b.from > start.line && b.to < end.line);
    return inOne(start.line) || inOne(end.line) || !blocks.length ? null : { ls, ps, start, end, blocks };
  }
  // What such a selection holds as the document's own lines (cut or copied with it, 2026-10-15): pasted back into this
  // editor, its conversations are conversations again. One at work is left out.
  acrossSource(sel) {
    const { ls, ps, start, end, blocks } = sel, busy = new Set();
    for (const b of blocks) if (isRunning(b.t, this.props.builds)) for (let j = b.from; j <= b.to; j++) busy.add(j);
    const mid = ls.slice(start.line + 1, end.line).filter((_, k) => !busy.has(start.line + 1 + k));
    return [lineText(ps[start.line], ls[start.line]).slice(start.offset), ...mid, lineText(ps[end.line], ls[end.line]).slice(0, end.offset)].join('\n');
  }
  deleteAcross() {
    const sel = this.across(); if (!sel) return false;
    const { ls, ps, start, end, blocks } = sel, keep = [];
    for (const b of blocks) if (isRunning(b.t, this.props.builds)) for (let j = b.from; j <= b.to; j++) keep.push(ls[j]);
    const head = lineText(ps[start.line], ls[start.line]).slice(0, start.offset), tail = lineText(ps[end.line], ls[end.line]).slice(end.offset);
    const out = [...ls.slice(0, start.line), sameLine(ps[start.line], head + tail), ...keep, ...ls.slice(end.line + 1)];
    this.armed = null;
    this.setLines(() => out, { line: start.line, offset: head.length }); this.wantFocus = true; this.setState({ activeLine: start.line, mention: null });
    return true;
  }
  dropBlock(block, caret) {
    this.armed = null;
    this.setLines((x) => { const out = x.filter((_, j) => j < block.from || j > block.to); return out.length ? out : ['']; }, caret);
    this.setState({ activeLine: caret.line, mention: null });
  }
  // Delete: this turn leaves the document, its question and its answer; the turns around it stay. A run still at work is stopped.
  deleteTurn(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return;
    const { turn, thread } = found, n = turn.to - turn.q + 1;
    if (turn.pending && this.props.onStopAsk) this.props.onStopAsk(turn.pending);
    // The last turn of a titled conversation takes its title with it (2026-10-12): alone, the title would be plain text.
    const from = thread.turns.length === 1 && thread.titleLine >= 0 ? thread.titleLine : turn.q;
    this.setLines((x) => { const out = x.filter((_, j) => j < from || j > turn.to); return out.length ? out : ['']; });
    this.setState({ activeLine: null, mention: null });
  }
  // Copy: the question as asked (no flags) and the answer as written (no prefixes, no closing line).
  copyText(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return '';
    const { question, answer } = turnText(ls, found.turn), card = cardOfAnswer(answer);
    // A card as it reads (2026-10-13), not its JSON: what it says, its question, its options as a list.
    const said = card ? [card.say, questionOf(card).title, questionOf(card).options.map((o) => `- ${o.label}`).join('\n')].filter(Boolean).join('\n\n') : answer;
    return [this.props.models ? readFlags(question, this.props.models).rest : question, said].filter(Boolean).join('\n\n');
  }
  // The selector. Under an @bart line's chip a choice is written into the line as flags, so the line says what will answer
  // it and taking the flags out gives the ladder back. Under a card's follow-up chip the choice waits for the follow-up;
  // under Regenerate it waits for the selector's own blue button. It opens on hover and stays while the pointer is on
  // what opened it or on the selector itself.
  openPicker(el, kind) {
    clearTimeout(this.pickerT); const i = Number(kind === 'line' ? el.dataset.row : kind === 'regen' ? el.dataset.turn : el.dataset.thread);
    if (this.state.picker && this.state.picker.i === i && this.state.picker.kind === kind) return;
    const r = (kind === 'regen' ? el : el.closest('[data-chip]') || el).getBoundingClientRect();
    this.setState({ picker: { kind, i, left: kind === 'regen' ? r.left : null, right: r.right, top: r.top, bottom: r.bottom, choice: null } });
    // Regenerate's name would show behind the selector it opened.
    if (kind === 'regen' && el.parentElement) { this.picking = el.parentElement; this.picking.setAttribute('data-picking', ''); }
  }
  leavePicker = () => { clearTimeout(this.pickerT); this.pickerT = setTimeout(() => { if (this.mounted) this.closePicker(); }, 220); };
  stayPicker = () => clearTimeout(this.pickerT);
  closePicker() { clearTimeout(this.pickerT); if (this.picking) { this.picking.removeAttribute('data-picking'); this.picking = null; } if (this.state.picker) this.setState({ picker: null }); }
  pickModel = (choice) => {
    const pk = this.state.picker, models = this.props.models; if (!pk || !models) return;
    if (pk.kind === 'regen') { this.setState({ picker: { ...pk, choice } }); return; }
    if (pk.kind === 'follow') { this.followChoice.set(pk.i, choice); this.lastHtml = null; this.forceUpdate(); return; }
    const ls = this.lines(), p = parseLine(ls[pk.i] || ''); if (p.type !== 'bart' || this.lockedAt(ls, pk.i)) { this.closePicker(); return; }
    const lead = leadOf(ls[pk.i], agentOf(p));
    const text = withChoice(p.text, models, choice), line = `${lead} ${text}${readFlags(text, models).rest ? '' : ' '}`;
    this.setLines((x) => x.map((l, j) => (j === pk.i ? line : l)), this.state.activeLine === pk.i ? { line: pk.i, offset: line.length } : undefined);
  };
  // A level picked under an @discover line's chip (2026-10-03), on a provider: written into the line as its flags, with any
  // model or effort flag taken off. The level and provider the line runs on with no flag (its exchange's, else Standard on
  // the default provider) are written as none.
  pickLevel = ({ mode, provider }) => {
    const pk = this.state.picker, models = this.props.models; if (!pk || pk.kind !== 'line' || !models) return;
    const ls = this.lines(), p = parseLine(ls[pk.i] || ''), found = this.findTurn(ls, pk.i);
    const box = found && found.turn.q === pk.i && isResearch(this.parsedOf(ls)[pk.i]) ? found.turn : null;
    if (p.type !== 'bart' || agentOf(p) !== 'discover' || (this.lockedAt(ls, pk.i) && !box)) { this.closePicker(); return; }
    const plain = readDiscover('', models, this.turnsBefore(ls, pk.i)), text = withMode(p.text, mode, models, { mode: plain.mode, provider: plain.provider }, provider || plain.provider);
    // With no question yet, a space after the flag, so what is typed next is the question ("@discover " alone has its own).
    const line = `${leadOf(ls[pk.i], 'discover')} ${text}${text && !readDiscover(text, models).question ? ' ' : ''}`;
    // A research box running (2026-10-16, David): its search goes on at the level picked, as a reply under it does (steerBox).
    if (box && this.boxState(ls, box) === 'running') {
      this.closePicker();
      const runs = (read) => [read.mode, read.provider, read.steps[0].model, read.steps[0].effort].join(' ');
      if (runs(this.discoverRead(ls, pk.i)) !== runs(readDiscover(parseLine(line).text, models, this.turnsBefore(ls, pk.i)))) this.steerBox(ls, box, line, { level: true });
      return;
    }
    this.setLines((x) => x.map((l, j) => (j === pk.i ? line : l)), this.state.activeLine === pk.i ? { line: pk.i, offset: line.length } : undefined);
  };
  sendPicked = () => {
    const pk = this.state.picker; if (!pk || pk.kind !== 'regen') return;
    const choice = pk.choice || this.ranWith(this.lines(), pk.i).choice; this.closePicker(); this.regenerate(pk.i, choice);
  };

  /* ---------------------------------------------------------------- operations */
  bartItem() { return (this.props.mentionable || []).find((r) => r && r.id === 'bart') || BART_ITEM; }
  chatItem() { return (this.props.mentionable || []).find((r) => r && r.id === 'chat') || CHAT_ITEM; }
  mentionList() {
    const m = this.state.mention, q = (m?.query || '').toLowerCase();
    const browse = this.browsing();
    if (browse) return folderRows({ browse, listing: browse.listing, query: q }); // inside a library folder (MATH-22)
    const rows = this.props.mentionItems ? this.props.mentionItems(q) // the workspace's list: Bart, Note, the open page, the library (model/rail.js)
      : (this.props.mentionable || []).filter((r) => r && ((r.name || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)));
    return m && m.field != null ? fieldRows(rows) : rows; // a follow-up field already asks its thread's agent: no verbs
  }
  pickMention(r) {
    const m = this.state.mention; if (!m || !r) return;
    // A library folder opens in the menu, and a subfolder of it; the back row goes up; a row that only says something is
    // not picked; "Mention this folder" at its top is the folder's own mention (MATH-22).
    if (this.canBrowse() && isFolderRow(r)) { this.openFolder(r.row, ''); return; }
    if (r.kind === 'entry' && r.dir) { this.openFolder(r.row, r.rel); return; }
    if (r.kind === 'back') { this.leaveFolder(); return; }
    if (r.kind === 'note') return;
    if (r.kind === 'self' && !r.rel) r = { kind: 'item', key: r.row.id, row: r.row, name: r.row.name };
    if (m.field != null) { this.pickInField(m, r); return; }
    const ls = this.lines(), p = parseLine(ls[m.i] || '');
    const cur = lineText(p, ls[m.i]);
    const verb = r.kind === 'verb' ? r.verb : r.id === 'bart' || r.id === 'chat' || r.id === 'brainstorm' || r.id === 'discover' || r.id === 'create' ? r.id : null;
    // Bart, Brainstorm, Discover and Note are words the line keeps (Enter asks, or makes the note); anything else is a mention, and
    // what it names comes into this workspace (the open page is added to the library first: props.onMentionPicked). A verb
    // is followed by a space, since a question comes next; a mention is not (MATH-11, 2026-10-05): the caret stops right after it.
    const ins = verb === 'bart' ? '@Bart ' : verb === 'chat' ? '@Chat ' : verb === 'brainstorm' ? '@Brainstorm ' : verb === 'discover' ? '@Discover ' : verb === 'create' ? '@Create ' : verb === 'note' ? '@Note ' : mentionToken(r);
    this.writeText(m.i, cur.slice(0, m.start) + ins + cur.slice(m.caret), { line: m.i, offset: m.start + ins.length });
    this.wantFocus = true; this.setState({ mention: null, activeLine: m.i });
    if (!verb && r.kind !== 'workspace' && pickedRow(r) && this.props.onMentionPicked) this.props.onMentionPicked(pickedRow(r)); // a workspace is not a library row
  }
  // A row picked in a follow-up field: the token a document line would get takes the place of `@query`, the keyboard stays
  // in the field, and followInput keeps what it holds and its send button. Sent, it is a mention on the new line.
  pickInField(m, r) {
    const input = this.followField(m.field);
    this.setState({ mention: null });
    if (!input || isVerbRow(r)) return;
    const ins = mentionToken(r);
    const end = Math.min(m.caret, input.value.length), start = Math.min(m.start, end);
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    input.setRangeText(ins, start, end, 'end');
    this.followInput(input);
    if (r.kind !== 'workspace' && pickedRow(r) && this.props.onMentionPicked) this.props.onMentionPicked(pickedRow(r));
  }
  /* ------------------------------------------------- a library folder in the @ menu (MATH-22) */
  // Where the @ menu stands (a line's `@`, or a follow-up field's): a folder opened from it is left when the menu moves.
  mentionKey(m) { return m ? (m.field != null ? `f${m.field}:${m.start}` : `${m.i}:${m.start}`) : null; }
  /** The folder the menu is in → { at, row, rel, listing }, or null at the menu's top. */
  browsing() { const b = this.state.browse, m = this.state.mention; return b && m && b.at === this.mentionKey(m) ? b : null; }
  canBrowse() { return typeof this.props.listFolder === 'function'; }
  // The menu goes into `rel` of the folder `row` (MF-01): the line (or field) keeps its path, `@Folder/sub/`, in place of
  // what was typed to find it, the caret after the last `/`, so what is typed next narrows the level. The level is asked
  // of main (listFolder) each time, live. `before`: what was typed after the `@` to find the folder, put back on leaving it.
  openFolder(row, rel, before) {
    const m = this.state.mention; if (!m || !row || !this.canBrowse()) return;
    const was = before ?? (this.browsing() ? this.browsing().before : m.query || '');
    const path = folderPath(row.name || '', rel);
    const anchor = this.putMention(m, path);
    this.browseInto({ ...m, query: '', caret: m.start + path.length, anchor }, row, rel, was);
  }
  // The folder's level is shown for `m`, whose line already holds its path.
  browseInto(m, row, rel, before) {
    const at = this.mentionKey(m), id = row.id, path = folderPath(row.name || '', rel);
    this.setState({ mention: m, browse: { at, start: m.start, path, before, row, rel, listing: undefined }, mentionIdx: 0 });
    Promise.resolve().then(() => this.props.listFolder(id, rel)).catch((error) => ({ error: (error && error.message) || 'This folder could not be read' })).then((listing) => {
      const b = this.state.browse;
      if (!this.mounted || !b || b.at !== at || b.row.id !== id || b.rel !== rel) return; // gone elsewhere meanwhile
      const next = { ...b, listing: listing || { error: 'This folder could not be read' } };
      this.setState({ browse: next, mentionIdx: firstPick(folderRows({ browse: next, listing: next.listing, query: (this.state.mention || {}).query })) });
    });
  }
  // `text` in place of the menu's `@…` (from its `@` to the caret), the caret after it; in a follow-up field as on a line.
  // → where the menu hangs now (a line's menu moves to the caret once the line is redrawn: menuToCaret).
  putMention(m, text) {
    if (m.field != null) {
      const input = this.followField(m.field); if (!input) return m.anchor;
      input.setRangeText(text, m.start, Math.min(m.caret, input.value.length), 'end');
      this.followText.set(m.field, input.value); this.paintSend(input); this.fitFollow(input);
      return fieldCaret(input) || m.anchor;
    }
    const ls = this.lines(), p = parseLine(ls[m.i] || ''), cur = lineText(p, ls[m.i]);
    this.writeText(m.i, cur.slice(0, m.start) + text + cur.slice(m.caret), { line: m.i, offset: m.start + text.length });
    this.wantFocus = true; this.wantAnchor = true;
    return m.anchor;
  }
  // Back up a level, its name taken off the path; from the folder's top, back to the whole menu with what was typed before.
  leaveFolder() {
    const b = this.browsing(), m = this.state.mention; if (!b) return;
    const up = parentRel(b.rel);
    if (up != null) { this.openFolder(b.row, up, b.before); return; }
    const text = `@${b.before}`, anchor = this.putMention(m, text);
    this.setState({ browse: null, mention: { ...m, query: b.before, caret: m.start + text.length, anchor }, mentionIdx: 0 });
  }
  // Backspace right after the path's last `/` (nothing typed after it), inside a folder: up a level. → whether it did
  upFromFolder(m, at) {
    const b = this.browsing();
    if (!m || m.query || !b || at !== b.start + b.path.length) return false;
    this.leaveFolder(); return true;
  }
  // What the @ menu reads before `caret` in `text`, on line `where.i` or in field `where.field`: inside a folder opened from
  // there, the path the line keeps and what follows it (folderMentionAt), else mentionAt. → { found, browse } with the
  // folder still open (or null), and `into`, the subfolder to enter when its name and a `/` were typed after the path.
  // Words with a space that no name holds are writing, not a search: the menu closes.
  readMention(text, caret, where) {
    const b = this.state.browse;
    if (b && b.at === this.mentionKey({ ...where, start: b.start })) {
      const f = folderMentionAt(text, caret, b), entries = (b.listing && b.listing.entries) || [];
      if (f && f.into != null) {
        const dir = entries.find((e) => e.dir && e.name === f.into);
        if (dir) return { found: { query: '', start: b.start }, browse: b, into: dir.rel };
      } else if (f && !(/\s/.test(f.query) && b.listing !== undefined && !entries.some((e) => e.name.toLowerCase().includes(f.query.trim().toLowerCase())))) {
        return { found: f, browse: b };
      }
    }
    return { found: mentionAt(text, caret, (query) => this.namesHold(query)), browse: null };
  }
  // Whether a name the @ menu offers holds `query`, spaces and all (doc.js mentionAt): a library row's or a workspace's,
  // never an agent's, so `@Bart why` is still a question.
  namesHold(query) {
    const q = String(query || '').toLowerCase();
    const rows = this.props.mentionItems ? this.props.mentionItems(q) : this.props.mentionable || [];
    return rows.some((r) => r && r.kind !== 'verb' && r.type !== 'chat' && String(r.name || '').toLowerCase().includes(q));
  }
  // The keyboard's row for a menu just read: in a folder its first entry, else the top.
  mentionStart(m, browse) { return browse ? firstPick(folderRows({ browse, listing: browse.listing, query: (m.query || '').toLowerCase() })) : 0; }
  // Enter on a line holding `@Note name`: the note is made (named, or untitled when nothing follows), and the words
  // become its mention if the line still holds them once it exists.
  async noteVerb(i) {
    const ls = this.lines(), p = parseLine(ls[i] || ''), cur = lineText(p, ls[i]), m = cur.match(NOTE_VERB_RE);
    if (!m) return;
    const said = cur.slice(m.index + m[1].length), name = (m[2] || '').replace(/[[\]]/g, '').trim();
    let note = null;
    try { note = await this.props.onNoteVerb(name); } catch { return; }
    if (!note || !this.mounted) return;
    const now = this.lines(), q = parseLine(now[i] || ''), text = lineText(q, now[i]), at = text.lastIndexOf(said);
    if (at < 0) return;
    const next = `${text.slice(0, at)}@[${note.name}] `;
    this.writeText(i, next, { line: i, offset: next.length });
    this.wantFocus = true; this.setState({ activeLine: i, mention: null });
  }
  // Tab in code: two spaces at the caret (in place of a selection inside the line); Shift+Tab takes up to two off the line's start.
  indentCode(i, cur, a, b, out) {
    if (!out) { this.writeText(i, cur.slice(0, a) + '  ' + cur.slice(b), { line: i, offset: a + 2 }); return; }
    const n = (cur.match(/^ {1,2}|^\t/) || [''])[0].length; if (!n) return;
    this.writeText(i, cur.slice(n), { line: i, sel: [Math.max(0, a - n), Math.max(0, b - n)] });
  }
  wrap(i, cur, st, en, mark) { this.writeText(i, cur.slice(0, st) + mark + cur.slice(st, en) + mark + cur.slice(en), { line: i, sel: [st + mark.length, en + mark.length] }); }
  link(i, cur, st, en) { const sel = cur.slice(st, en) || 'link'; const a = st + sel.length + 3; this.writeText(i, cur.slice(0, st) + `[${sel}](url)` + cur.slice(en), { line: i, sel: [a, a + 3] }); }
  indent(i, dir) {
    this.setLines((ls) => {
      const ps = this.parsedOf(ls), p = ps[i] || parseLine(''); if (!isMarked(p.type)) return ls; const nd = clamp(p.depth + dir, 0, 8); if (nd === p.depth) return ls;
      if (dir > 0) { const prev = ps[i - 1] || parseLine(''); if (!isMarked(prev.type) || nd > prev.depth + 1) return ls; }
      const out = [...ls]; out[i] = sameLine({ ...p, depth: nd }, p.text);
      for (let j = i + 1; j < ls.length; j++) { const q = ps[j]; if (!isMarked(q.type) || q.depth <= p.depth) break; out[j] = sameLine({ ...q, depth: clamp(q.depth + dir, 0, 8) }, q.text); }
      return out;
    });
  }
  removeLine(i) { this.setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [''])); this.setState({ mention: null }); }
  toggleTodo(i) {
    this.setLines((ls) => ls.map((l, j) => { if (j !== i) return l; const p = parseLine(l); return todoLine(p.depth, !p.done, p.text); }));
  }
  // What a mention names (MATH-60): a library mention's item by its id, whatever it is called now; Bart for `@[bart]`;
  // otherwise the item that goes by the name. Null when nothing does: the mention is drawn grey, with no card to show.
  findRes(name, libId) {
    const rows = this.props.mentionable || [];
    if (libId) return rows.find((r) => r && r.type !== 'chat' && r.id === libId) || null;
    const chat = chatMention(name); if (chat) return chat.live ? this.bartItem() : null;
    const n = String(name).toLowerCase();
    const byName = rows.find((r) => r && r.id !== 'bart' && r.id !== 'chat' && (r.name || '').toLowerCase() === n) || null;
    // A page mentioned by its address (`@[https://…]`, before 2026-10-17) is the library's page at that address.
    return byName || (isAddress(name) ? rows.find((r) => isWebRow(r) && sameAddress(r.url, name)) || null : null);
  }
  // What a line's mentions are drawn with (model/doc.js inlineHtml): a library mention under its item's name now, and a
  // mention of something no longer here in grey. Until there is a library to ask (none given, or none yet), as written.
  libraryKnown() { return (this.props.mentionable || []).some((r) => r && r.type !== 'chat'); }
  mentionOpts = {
    libName: (id) => { if (!this.libraryKnown()) return undefined; const row = this.findRes('', id); return row ? row.name || '' : null; },
    named: (name) => (this.libraryKnown() ? !!this.findRes(name) : undefined),
    trashed: (name, id) => { const row = id ? this.findRes('', id) : this.findRes(name); return !!(row && row.trashed); }, // MATH-58 follow-up
    // A web page's chip carries the globe, a repository's known by its address GitHub's mark (2026-10-17).
    webKind: (name, id) => { const row = id ? this.findRes('', id) : this.findRes(name); return isWebRow(row) ? (kindKey(row) === 'git' ? 'git' : 'website') : null; },
    // A file in a library folder (MATH-22): false when it is no longer there, undefined until that is known.
    fileState: (folderId, rel) => (typeof this.props.fileState === 'function' ? this.props.fileState(folderId, rel) : undefined),
    // A citation's source (model/cite.js, 2026-10-21): the library's name for the paper, page or note it quotes, a file in a
    // library folder by the folder's name and its own; null when the library does not have it (a workspace's document).
    citeSource: (address) => libraryName(this.props.mentionable, address),
  };
  showPop(res, e) { const r = e.currentTarget.getBoundingClientRect(); this.setState({ pop: { res, anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } } }); }
  hidePop = () => { if (this.state.pop) this.setState({ pop: null }); };
  // A made file's peek (2026-10-15, David, again: a small card over the page, so nothing in the document moves; for a
  // while it opened in its frame instead): once the pointer has rested on its name or icon a moment, MadePeek shows the
  // file under it; leaving hides it, as does anything pressed (madeAct). A file whose frame is open needs none.
  peekMade(el) {
    clearTimeout(this.peekT);
    const key = el.dataset.madePeek; if (!key || this.madeOpen.has(key)) return;
    this.peekT = setTimeout(() => {
      if (!this.mounted || !el.isConnected || this.madeOpen.has(key)) return;
      const r = el.getBoundingClientRect();
      this.setState({ pop: { made: { key, name: el.dataset.name || key.split('/').pop() }, anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } } });
    }, PEEK_MS);
  }
  unpeekMade = () => { clearTimeout(this.peekT); if (this.state.pop && this.state.pop.made) this.setState({ pop: null }); };

  /* ---------------------------------------------------------------- render */
  // The @ menu, a mention's card and the model selector hang over the whole window, placed by the viewport (usePlaced): in
  // a strip of panes (MATH-23) the pane after this one would otherwise cover them. A post-it's stay in its card.
  overPage(node) { return this.props.compact || typeof document === 'undefined' || !document.body ? node : createPortal(node, document.body); }
  pickerView() {
    const pk = this.state.picker, models = this.props.models;
    if (pk && pk.kind === 'via') return <AgentChoice current={(() => { const ls = this.lines(), found = this.findTurn(ls, pk.i); return found ? this.turnAgent(found.thread, found.turn) : agentOf(parseLine(ls[pk.i] || '')); })()} anchor={pk} onPick={this.pickVia} onEnter={this.stayPicker} onLeave={this.leavePicker} />;
    if (!pk || !models) return null;
    const ls = this.lines(), marked = (choice) => ({ provider: (modelOf(choice.model, models) || {}).provider, model: choice.model, effort: choice.effort });
    let current = null;
    if (pk.kind === 'regen') current = pk.choice ? marked(pk.choice) : this.ranWith(ls, pk.i).current;
    else if (pk.kind === 'follow') { const thread = threads(ls).find((t) => t.from === pk.i), step = thread && this.followStep(ls, thread).step; current = step && { provider: step.provider, model: step.key, effort: step.effort }; }
    else {
      const p = parseLine(ls[pk.i] || '');
      // An @discover line's chip opens its levels instead (2026-10-03).
      if (p.type === 'bart' && agentOf(p) === 'discover') {
        if (!models.providers[models.provider]) return null;
        const read = this.discoverRead(ls, pk.i);
        return <DiscoverLevels models={models} current={{ mode: read.mode, provider: read.provider, pinned: read.pinned }} anchor={pk} onPick={this.pickLevel} onEnter={this.stayPicker} onLeave={this.leavePicker} />;
      }
      if (p.type === 'bart') { const step = readQuestion(p.text, models).steps[0]; current = { provider: step.provider, model: step.key, effort: step.effort }; }
    }
    if (!current || !models.providers[current.provider]) return null;
    return <BartPicker models={models} current={current} anchor={pk} onPick={this.pickModel} onSend={pk.kind === 'regen' ? this.sendPicked : undefined} onEnter={this.stayPicker} onLeave={this.leavePicker} />;
  }
  render() {
    const s = this.state;
    const compact = this.props.compact;
    const lightbox = this.lightboxEl();
    const answers = compact || this.props.readOnly ? [] : this.foldable(this.lines()), anyOpen = answers.some((turn) => !turn.folded);
    // Compact (a post-it, 2026-09-22) never scrolls: it is as tall as its lines, and the card fits the type to its size.
    return (
      <>
        <style>{RISE_CSS + CARD_CSS + CITE_CSS}</style>
        {lightbox && createPortal(lightbox, document.body)}
        {this.props.emptyHint && <style>{emptyHintCss(this.props.emptyHint)}</style>}
        {/* Past the last line the page keeps going for about half a window (2026-09-22), so the end of a document can be read and written mid-screen. */}
        <div ref={this.scrollRef} onClick={this.docClick} onScroll={this.onScroll} onWheel={this.paneWheel} onPointerDown={this.stopSettling} onKeyDown={this.stopSettling} style={compact ? { flex: 'none', overflow: 'visible', padding: '0 0 2px', cursor: 'grab' } : { flex: 1, minHeight: 0, overflow: 'auto', padding: '28px clamp(12px, 4%, 40px) max(120px, calc(50vh - 40px))', cursor: 'text' }}>
          <div ref={this.colRef} style={{ marginInline: 'auto', cursor: 'auto', fontSize: 17, ...(compact ? { maxWidth: 'none', paddingInline: 0 } : DOC_COLUMN) }}>
            {this.props.header}
            {this.props.above}
            <div
              data-editor="1"
              data-empty-hint={this.props.emptyHint ? '1' : undefined}
              ref={this.edRef}
              contentEditable={!this.props.readOnly}
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              aria-label={compact ? 'Sticky' : 'Document'}
              style={{ marginTop: compact ? 0 : 18, outline: 'none', minHeight: compact ? 28 : 240, font: '17px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', caretColor: '#171717', cursor: 'text' }}
            />
          </div>
        </div>
        {/* The footer (the document's Copy, 2026-09-23) sits under the text's left edge, not the pane's: this column
            repeats the scroller's padding and 65ch measure, so it stays with the note when panes split. Since 2026-09-27 it
            is a strip of its own under the page ("the text editor stops above these buttons"), no longer floating over it.
            (2026-10-13: back from a ⋯ menu at the top, David.) */}
        {!compact && this.props.footer && (
          <div data-doc-footer="1" style={{ flex: 'none', borderTop: '1px solid #eaeaea', background: '#fff', paddingInline: 'clamp(12px, 4%, 40px)' }}>
            <div style={{ maxWidth: '65ch', minHeight: 44, marginInline: 'auto', paddingInline: 'clamp(0px, 3%, 24px)', boxSizing: 'border-box', fontSize: 17, display: 'flex', alignItems: 'center' }}>
              {this.props.footer}
            </div>
          </div>
        )}
        {/* Top right of the page: every answer folded or unfolded at once, as plain words (2026-09-29). */}
        {answers.length > 0 && (
          <button type="button" className="hov-ink" data-fold-all={anyOpen ? 'collapse' : 'expand'} onClick={() => this.foldAll(anyOpen)} title={anyOpen ? 'Collapse every @bart answer' : 'Expand every @bart answer'} style={{ position: 'absolute', top: 8, right: 22, zIndex: 2, padding: '4px 6px', border: 0, borderRadius: 6, background: '#fff', cursor: 'pointer', font: '400 12.5px/1.3 var(--font-sans)', color: '#8f8f8f', whiteSpace: 'nowrap' }}>{anyOpen ? 'Collapse all' : 'Expand all'}</button>
        )}
        {this.overPage(
          <>
            {s.mention && s.mention.anchor && <MentionMenu items={this.mentionList()} index={s.mentionIdx} anchor={s.mention.anchor} onPick={(r) => this.pickMention(r)} onHover={(i) => this.setState({ mentionIdx: i })} />}
            {s.pop && s.pop.made && <MadePeek name={s.pop.made.name} body={this.madeBodyHtml(s.pop.made, (this.props.madeFiles || {})[s.pop.made.key] || null)} anchor={s.pop.anchor} />}
            {s.pop && s.pop.res && (s.pop.res.ws ? <WorkspacePeek id={s.pop.res.ws} name={s.pop.res.name} anchor={s.pop.anchor} peek={this.props.workspacePeek} /> : <Popover item={s.pop.res} anchor={s.pop.anchor} />)}
            {this.pickerView()}
            {this.topicView()}
          </>,
        )}
      </>
    );
  }
}
