// One markdown string per document, edited on a single contentEditable surface (Obsidian-style: the caret's
// line shows its source, every other line renders). Ported from design/goal-canvas/Goal Canvas.dc.html
// (state 458–466, listeners 492–512, document engine 678–983). Differences from the design:
//   * props.text is the source of truth; every edit calls props.onChange(text) synchronously.
//   * the `@[chat]` inline chat *panels* are gone; the line form is `@bart …` (2026-09-19), answered by a real agent:
//     Enter puts a pending line under the question and hands it to props.onAsk; the parent replaces that line with the
//     answer. The card is Claude Design's "Answer Card" (2026-09-21, design/goal-canvas/ANSWER-CARD.md): an answer is kept
//     as it arrives and its text can be edited; its foot holds Copy, Regenerate, which model said it, Collapse and Delete
//     as icons; a field at the bottom of the card asks a follow-up, which joins the same card.
//   * image paste/drop is not supported (spec §2 #19); `![alt](http…)` lines still render.
//   * clicking into a rendered (non-active) line maps the display offset through rawOffset(), so the caret
//     lands on the clicked character even inside bold/mention markup.
//   * fenced code blocks (2026-09-22): the lines between two fences are code, read with parseLines() (a `# x` in a block
//     is not a heading). Typing a fence and Enter closes it and puts the caret inside; in a block Enter keeps the line's
//     indent and Tab indents by two spaces.
//   * @brainstorm (2026-09-30) is an @bart line asked of another agent. An answer of its that is a card (main/bart/card.cjs:
//     a fenced JSON block) is drawn as one card in place of its lines, as a Build is drawn from its record; the lines
//     never take the caret. The last card of a card's thread is live: Submit or Skip writes the answer as the next
//     `@brainstorm …` line and asks it, as a follow-up is asked. Earlier cards show what was picked. A live @brainstorm card
//     also has Wrap up, which asks for the recap, and an @discover button that starts a search thread of its own under
//     the brainstorm thread, leaving the card live (round 6). @discover (2026-09-30)
//     asks its cards the same way, as `@discover …` lines, and answers with a reading guide drawn as an @bart answer is.
//     @orient (2026-10-04) asks @brainstorm's kind of card, as `@orient …` lines, with Skip, Wrap up and Submit and no
//     @discover button; its recap is drawn as @brainstorm's is, and only its first Look for line is a button.
//     Each paper's title line in a guide has a bookmark in its right margin that keeps the paper (2026-10-02, model/guide.js;
//     a quiet icon since 2026-10-03): outline, outline with +, or filled, from props.paperState; a click hands it to
//     props.onSavePaper. Drawn, never written: the line stays as it came. An entry's **Try:** line (2026-10-04) links the
//     paper's own repository: a small grey "Run" mark ("Added" once it is here, props.repoState) stands before the link, and
//     a click on the link opens the page as any link does and also hands the repository to props.onTryRepo.
//   * the follow-up field has the @ menu too (2026-10-02): `@` opens it under the field's caret and a pick writes the token
//     a document line would; Bart, Brainstorm, Orient, Discover and Note are left out, since the field already asks its agent.
//   * Edit (2026-10-03): an answered question's foot has Edit, which makes the question an ordinary agent line again, as it
//     stands, with its answer dimmed under it. Enter asks it again in place of that answer, as Regenerate does, and the turns
//     after it in its thread go; one undo brings all of it back. Escape, or the caret or a click going elsewhere, puts it back.
//   * where a document was scrolled to is kept per workspace (props.viewOf / props.onView, 2026-09-22), apart from the
//     caret: coming back to a document shows what was on screen, not where the last edit was.
import React from 'react';
import { parseLine, parseLines, codeBlocks, todoLine, esc, tokShown, tokensOf, rawOffset, replyRawOffset, inlineHtml, highlight, fenceShown, isFence, isCode, isAnswer, isMarked, lineText, sameLine, replyLine, canonicalLine, retypedRow, listMark, threads, turnText, wsMention, mentionAt, agentOf, flattenPaste, selectionMarkdown, selectionHtml, withLinks, INLINE, AGENT_TOKEN, ATTRIBUTION_RE, BART_RE, FENCE_RE } from '../model/doc.js';
import { fieldRows, isVerbRow } from '../model/rail.js';
import { readFlags, readQuestion, readDiscover, withChoice, withMode, discoverSpans, modelOf, effortOf, buildRequestOf, EFFORT_LABELS } from '../../main/bart/question.cjs';
import { SKIPPED, MAP_GROUPS, cardOfAnswer, questionOf, isChoice, answerLine, withWrap, readAnswer, recapParts, recapLine } from '../../main/bart/card.cjs';
import BartPicker from './BartPicker.jsx';
import DiscoverLevels, { LEVEL_LABELS } from './DiscoverLevels.jsx';
import MentionMenu from './MentionMenu.jsx';
import Popover from './Popover.jsx';
import WorkspacePeek from './WorkspacePeek.jsx';
import { diffRows, diffTotals, nextAttachment } from '../model/build-diff.js';
import { guideTitle, guideRepo, repoOf } from '../model/guide.js';
import { guideSections, splitTarget } from '../model/stage.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const BART_ITEM = { id: 'bart', type: 'chat', name: 'bart', title: 'Bart', summary: 'Ask a question about this document, the project\'s code or the web. Add --opus or --high to pick the model or the effort by hand.', facts: 'reads, never edits' };
export const DISCOVER_ITEM = { id: 'discover', type: 'chat', name: 'discover', title: 'Discover', summary: 'Find what to read about a problem, and where in it to look: it traces the citations of the papers in your library and the pages of the people you follow. Pick Quick, Standard or Deep on the line\'s chip.', facts: 'finds, never concludes' };
export const BRAINSTORM_ITEM = { id: 'brainstorm', type: 'chat', name: 'brainstorm', title: 'Brainstorm', summary: 'Work out what puzzles you and land on a research question in your own words.', facts: 'asks, never proposes' };
export const ORIENT_ITEM = { id: 'orient', type: 'chat', name: 'orient', title: 'Orient', summary: 'Write what you know about a topic or paper, then what interests you about it.', facts: 'asks, never explains' };

const UNDER_BART = ['pending', 'reply'];
// The agents that run on one model of their own (no model chip, no selector on Regenerate), may be asked with nothing after
// them and answer with cards: every one but @bart. An @discover line's chip picks its level instead (2026-10-03). What
// their follow-up field says, and whether it may be sent empty.
const oneModel = (agent) => agent !== 'bart';
// The ones of those on a fixed step (main/bart/models.cjs readBrainstorm): no flag is read or marked on their lines, their
// cards have no subtitle and have Wrap up, and their recaps are drawn as sections. @brainstorm and @orient (2026-10-04).
const fixedStep = (agent) => agent === 'brainstorm' || agent === 'orient';
// How a question line starts, as it was written: "@Bart" (the @ menu's) or "@bart" (typed), "@Discover" or "@discover".
const leadOf = (line, agent) => (String(line).match(new RegExp(`^@${agent}`, 'i')) || [`@${agent}`])[0];
const FOLLOW = {
  brainstorm: { placeholder: 'Go on…', label: 'Brainstorm again', empty: true },
  orient: { placeholder: 'Go on, or a new topic or paper…', label: 'Orient again', empty: true },
  discover: { placeholder: 'More like one of these, only after 2022, essays…', label: 'Ask Discover for more', empty: false },
};
// A Build's state as its card names it (main/build/store.cjs STATUSES).
const BUILD_STATUS = { 'setting-up': 'Setting up', queued: 'Waiting for a slot', running: 'Working', 'needs-you': 'Needs you', review: 'Ready to review', stopped: 'Stopped', failed: 'Failed', escalated: 'Too big for a quick task', interrupted: 'Interrupted', accepting: 'Accepting', conflict: 'Conflict', accepted: 'Accepted', discarded: 'Discarded' };
const BUILD_WORKING = new Set(['setting-up', 'queued', 'running', 'accepting']);
// `@Note` (the @ menu's Note) and the name after it, to the end of the line.
const NOTE_VERB_RE = /(^|\s)@Note(?:\s+(.*))?$/;
// A short fingerprint of a line (FNV-1a), so a remembered scroll position finds its line again without keeping its text.
const hashLine = (line) => { let h = 0x811c9dc5; const s = String(line ?? ''); for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const newAskId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
// A follow-up's text with each [Attachment n] whose image was saved ([{ n, id }]) written as an image pasted on a line is:
// ![Attachment n](img:<id>). A token typed by hand, or one whose image did not save, stays as it was typed.
const withAttachments = (text, images) => {
  const ids = new Map(images.filter((image) => image.id).map((image) => [image.n, image.id]));
  return text.replace(/(?<!!)\[Attachment (\d+)\](?!\()/g, (token, n) => (ids.has(Number(n)) ? `![Attachment ${n}](img:${ids.get(Number(n))})` : token));
};
// A link ⌘-clicked (Ctrl-clicked off macOS, where Ctrl-click is the context menu) opens in a new Stage tab (2026-10-02).
const newTabClick = (e) => e.metaKey || (e.ctrlKey && !/^(darwin|mac)/i.test(document.documentElement.dataset.platform || navigator.platform || ''));

const RISE_CSS = '@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}@keyframes thinking{0%,100%{opacity:.25}50%{opacity:1}}';
// The answer card's controls. They are drawn as strings inside the editor, so what hover does lives here: an icon washes
// grey and turns ink (Delete turns red) and shows its name under it; the chip's border goes one grey darker, never ink.
const CARD_CSS = '.bart-ic{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:none;cursor:pointer;color:#4d4d4d}'
  + '.bart-ic:hover{background:#f2f2f2;color:#171717}.bart-ic[data-danger]:hover{color:#e70022}.bart-ic:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.bart-tip{position:absolute;top:100%;z-index:5;margin-top:4px;padding:4px 7px;border:1px solid #eaeaea;border-radius:6px;background:#fff;color:#171717;font:12px/1.2 var(--font-sans);white-space:nowrap;pointer-events:none;opacity:0;visibility:hidden;transition:opacity 120ms}'
  + '.bart-ic:hover+.bart-tip,.bart-ic:focus-visible+.bart-tip{opacity:1;visibility:visible}'
  + '.bart-chip{transition:border-color 120ms}.bart-chip:hover{border-color:#c9c9c9!important}.bart-send{transition:background 120ms}.bart-send:hover{opacity:.86}'
  + '.bart-text{padding:4px 2px;border:0;background:transparent;color:#8f8f8f;font:500 12px/1.4 var(--font-sans);cursor:pointer}.bart-text:hover{color:#171717}'
  + '[data-follow-input]::placeholder{color:#8f8f8f;font-style:italic;font-size:14.5px}'
  // An @discover guide's bookmark (2026-10-03): faint until its title line is hovered, washed when it is; a saved one is ink
  // and still; one at work is what it was when clicked, at half strength.
  + '.paper-mark{position:absolute;top:1px;right:-4px;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:none;color:#c9c9c9;cursor:pointer;transition:color 120ms,background 120ms}'
  + '[data-paper-line]:hover .paper-mark:not(:disabled){color:#4d4d4d}.paper-mark:not(:disabled):hover{background:#f2f2f2}'
  + '.paper-mark:disabled{cursor:default}.paper-mark[data-save="here"]{color:#4d4d4d}.paper-mark[data-busy]{opacity:.5}'
  + '.paper-mark:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  // @brainstorm's card: options as rows with a round (one) or square (several) mark; the pick in blue.
  + '.bs-opt{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;margin:0;padding:9px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fff;text-align:left;cursor:pointer;font:15px/1.45 var(--font-sans);color:#171717;transition:border-color 120ms}'
  + '.bs-opt+.bs-opt{margin-top:6px}.bs-opt:hover{border-color:#c9c9c9}.bs-opt[aria-checked="true"]{border-color:#0070f3}'
  + '.bs-opt:disabled{cursor:default;color:#8f8f8f}.bs-opt:disabled:hover{border-color:#eaeaea}.bs-opt:disabled[aria-checked="true"]{color:#171717;border-color:#0070f3}'
  + '.bs-opt:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(0,112,243,.18)}'
  + '.bs-mark{flex:none;box-sizing:border-box;width:14px;height:14px;margin-top:3px;border:1.5px solid #c9c9c9;border-radius:50%;background:#fff}.bs-mark[data-square]{border-radius:4px}'
  + '[aria-checked="true"]>.bs-mark{border-color:#0070f3;background:#0070f3;box-shadow:inset 0 0 0 2.5px #fff}'
  // The answer under a question being edited (2026-10-03): its contents faded, its card's grey as it was.
  + '[data-dim]>*{opacity:.45}'
  + '.bs-why{display:block;margin-top:2px;font-size:13px;line-height:1.45;color:#8f8f8f}'
  + '.bs-field{display:block;width:100%;box-sizing:border-box;margin:0;padding:8px 10px;border:1px solid #eaeaea;border-radius:8px;background:#fff;outline:none;resize:none;font:15px/1.5 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text}'
  + '.bs-field:focus{border-color:#c9c9c9}.bs-field::placeholder{color:#8f8f8f}'
  + '.bs-submit{padding:8px 14px;border:0;border-radius:8px;background:#0070f3;color:#fff;font:500 13px/1 var(--font-sans);cursor:pointer;transition:opacity 120ms}.bs-submit:hover{opacity:.86}.bs-submit:disabled{background:#eaeaea;color:#8f8f8f;cursor:default;opacity:1}'
  // Near the bottom of the window a name goes above its icon instead (editorOver sets the mark).
  + '[data-tip-up]>.bart-tip{top:auto;bottom:100%;margin-top:0;margin-bottom:4px}';
// Lucide's drawings at the design's weight: 16px, 1.5px stroke, round caps.
// A map card's three lists (main/bart/card.cjs `map`).
const MAP_LABELS = { settled: 'Seems settled', open: 'Seems open', untouched: 'Not touched yet' };
const icon = (paths, size = 16, width = 1.5, caps = 'round') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="${caps}" stroke-linejoin="${caps === 'round' ? 'round' : 'miter'}" aria-hidden="true">${paths}</svg>`;
const ICON = {
  copy: icon('<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'),
  regenerate: icon('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path>'),
  edit: icon('<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path>'),
  collapse: icon('<path d="m7 20 5-5 5 5"></path><path d="m7 4 5 5 5-5"></path>'),
  expand: icon('<path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path>'),
  trash: icon('<path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>'),
  chevron: `<span style="display:inline-flex;color:#8f8f8f">${icon('<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span>`,
  send: icon('<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>', 13, 2.2),
  // The steps toggle: a plain angle with square ends (Hudson's reference, 2026-09-21), pointing up while the list is open.
  stepsOpen: icon('<path d="m5 15.5 7-7 7 7"></path>', 10, 3, 'square'),
  stepsShut: icon('<path d="m5 8.5 7 7 7-7"></path>', 10, 3, 'square'),
};
// An @discover guide's bookmark by where its paper is (2026-10-03): its drawing and the words its title and label carry.
const BOOKMARK = '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>';
const PAPER_MARK = {
  none: { icon: icon(BOOKMARK), words: 'Save to library and this workspace' },
  lib: { icon: icon(`${BOOKMARK}<path d="M12 7v6"></path><path d="M9 10h6"></path>`), words: 'Add to this workspace (already in the library)' },
  here: { icon: icon(BOOKMARK.replace('<path ', '<path fill="currentColor" ')), words: 'Saved in this workspace' },
};
// A Try line's mark by where its repository is (2026-10-04): the words it shows and its title.
const RUN_WORDS = 'Opens the repository and adds it to this workspace, which starts building it';
const REPO_MARK = {
  none: { label: 'Run', words: RUN_WORDS },
  lib: { label: 'Run', words: RUN_WORDS },
  here: { label: 'Added', words: 'In this workspace: open it from the sidebar' },
};
const radius = (top, closes) => `${top ? '10px 10px' : '0 0'} ${closes ? '10px 10px' : '0 0'}`;
// Where a follow-up field's caret is on screen (its @ menu hangs there, 2026-10-02). A textarea has no range to measure,
// so a hidden copy laid over it is: the same width, padding and type, holding the text up to the caret and then a mark
// with the rest (so a word wraps as it does in the field). The field's bottom-left corner when that cannot be measured.
const MIRRORED = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform', 'tabSize', 'whiteSpace', 'overflowWrap', 'wordBreak'];
function fieldCaret(input, pos = input.selectionStart) {
  const box = input.getBoundingClientRect(), corner = { left: box.left, right: box.left, top: box.top, bottom: box.bottom };
  let copy = null;
  try {
    const css = getComputedStyle(input);
    copy = document.createElement('div');
    for (const key of MIRRORED) copy.style[key] = css[key];
    Object.assign(copy.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top - input.scrollTop}px`, margin: '0', overflow: 'hidden', visibility: 'hidden', pointerEvents: 'none' });
    copy.textContent = input.value.slice(0, pos);
    const mark = document.createElement('span'); mark.textContent = input.value.slice(pos) || '\u200b';
    copy.appendChild(mark); document.body.appendChild(copy);
    const r = mark.getClientRects()[0];
    return r ? { left: r.left, right: r.left, top: r.top, bottom: r.bottom } : corner;
  } catch { return corner; } finally { if (copy) copy.remove(); }
}
// A flag the models file recognises is a little bolder than the text around it; a `--word` it does not know stays plain.
const FLAG_LOOK = 'font-weight:500';

export default class DocEditor extends React.Component {
  state = { activeLine: null, mention: null, mentionIdx: 0, pop: null, picker: null };
  edRef = React.createRef();
  history = []; future = []; caret = null; lastHtml = ''; lastKey = null; selRaw = null; openKey = ''; copied = null; copiedT = null;
  syncing = false; wantFocus = false; composing = false; mounted = false; timers = new Set(); held = false; downOnRoot = false; downOnPage = false;
  openLogs = new Set(); // asks whose list of steps is open
  pickerT = null;
  // A follow-up being typed, the model picked for it and the images pasted into it ([{ n, id }]), by the first line of its
  // card. None is in the document, and none is in the editor's HTML: the field keeps its text across redraws because it
  // is put back after each one.
  followText = new Map(); followChoice = new Map(); followImages = new Map();
  // What is being answered on a live @brainstorm card, by its question's line: { picks, text, note }. Picks are drawn
  // into the card's HTML; the typed text is not, and is put back after each redraw (restoreCards).
  cardState = new Map(); cardCache = new WeakMap();
  // A Build card's reply being typed (by Build id) and the images pasted into it ([{ n, id }]), which cards show their
  // earlier messages and their steps, where each card's diff is scrolled to, and the HTML each part of each card was last
  // drawn with (patchBuilds compares these).
  buildText = new Map(); buildImages = new Map(); buildOpen = new Set(); buildSteps = new Set(); buildScroll = new Map(); buildDrawn = new Map();
  // An @discover guide's papers being saved, by address: the button's state when it was clicked (it stays disabled on it).
  saving = new Map();
  // Its repositories being brought here from a Try line, by address in lower case: the mark's state when it was clicked.
  trying = new Map();
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
    const inEd = (e) => e.target && e.target.closest && e.target.closest('[data-editor]') === this.editorEl();
    // The follow-up field is an <input> inside the editor: its keys and text are its own, not the document's. So is a
    // Build card's reply field.
    // And so are an @brainstorm card's fields.
    const inFollow = (e) => !!(e.target && e.target.matches && e.target.matches('[data-follow-input], [data-build-input], [data-card-input]'));
    const inBuild = (e) => !!(e.target && e.target.matches && e.target.matches('[data-build-input]'));
    const inCard = (e) => !!(e.target && e.target.matches && e.target.matches('[data-card-input]'));
    const inAsk = (e) => !!(e.target && e.target.matches && e.target.matches('[data-follow-input]')); // a follow-up's field alone
    this.docListeners = {
      keydown: (e) => { if (!inEd(e)) return; this.held = false; if (inBuild(e)) this.buildKey(e); else if (inCard(e)) this.cardKey(e); else if (inFollow(e)) this.followKey(e); else this.editorKey(e); },
      input: (e) => { if (!inEd(e)) return; if (inBuild(e)) this.buildInput(e.target); else if (inCard(e)) this.cardInput(e.target); else if (inFollow(e)) this.followInput(e.target); else this.editorInput(); },
      beforeinput: (e) => { if (!inEd(e) || inFollow(e)) return; const sel = getSelection(); this.bulkDelete = /^delete/.test(e.inputType || '') && !!sel && !sel.isCollapsed; },
      paste: (e) => { if (!inEd(e)) return; if (inBuild(e)) this.buildPaste(e); else if (inAsk(e)) this.followPaste(e); else if (!inFollow(e)) this.editorPaste(e); },
      // A copy or a cut of the document is its markdown (editorCopy); in a field of its own it is the browser's, as a paste is.
      copy: (e) => { if (inEd(e) && !inFollow(e)) this.editorCopy(e, false); },
      cut: (e) => { if (inEd(e) && !inFollow(e)) this.editorCopy(e, true); },
      // A press on one of the editor's buttons must not move the keyboard: leaving a line redraws the editor, and a button
      // redrawn between the press and the release never gets its click (found with Delete, while an answer was being edited).
      // A link or a mention is pressed to open it (2026-09-29): the press must not put the caret there, or the line would
      // redraw as its source and the click land on plain text (links in answers did nothing).
      // Where the press landed is kept for the click that follows it: a drag across lines ends in a click on what holds
      // both ends (the editor, or the page around it when released past it), and only a press there is a click there.
      mousedown: (e) => {
        this.downOnPage = e.target === this.scrollRef.current;
        if (!inEd(e)) return;
        this.downOnRoot = e.target === this.editorEl();
        if (e.target.closest('button[data-act], .bart-chip, a[data-link], [data-mention]')) { e.preventDefault(); return; }
        if (e.button === 0 && !inFollow(e)) this.held = true;
      },
      // While the button is down a selection is only noted: redrawing the line under a drag (to show its source) lost the
      // highlight. The line becomes the caret's once the button comes up, after this click is handled.
      mouseup: () => { if (!this.held) return; this.held = false; this.timer(() => this.onSel(), 0); },
      click: (e) => { if (inEd(e)) this.editorClick(e); },
      mouseover: (e) => { if (inEd(e)) this.editorOver(e); },
      mouseout: (e) => { if (inEd(e)) this.editorOut(e); },
      selectionchange: () => this.onSel(),
      dragover: (e) => { if (inEd(e)) e.preventDefault(); },
      drop: (e) => { if (inEd(e)) e.preventDefault(); },
      // Switching to another app blurs the page too; that is not leaving the line, and redrawing it would drop a selection.
      // Leaving it otherwise puts back a question being edited (2026-10-03).
      focusout: (e) => { if (inEd(e) && document.hasFocus() && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-mention-menu]'))) { this.cancelEdit(); this.setState({ activeLine: null, mention: null }); } },
      compositionstart: () => { this.composing = true; },
      compositionend: (e) => { this.composing = false; if (inEd(e) && !inFollow(e)) this.editorInput(); },
    };
    Object.entries(this.docListeners).forEach(([k, f]) => document.addEventListener(k, f));
    document.addEventListener('scroll', this.buildScrolled, true); // a card's diff scrolls on its own; redraws put it back
    window.addEventListener('resize', this.fitFollows);
    this.syncEditor();
    this.wantView = true; this.maybeRestoreView();
    if (typeof ResizeObserver === 'function' && this.editorEl()) {
      this.resizeObs = new ResizeObserver(() => { const s = this.settle; if (s && s.key === this.key() && Date.now() < s.until) this.applyView(s.pos); });
      this.resizeObs.observe(this.editorEl());
    }
  }

  // The document on screen is about to be replaced by another: what it was scrolled to is reported first, while it is still there.
  getSnapshotBeforeUpdate(prevProps) {
    if (prevProps.docKey !== this.props.docKey && this.lastKey === prevProps.docKey) this.reportView(prevProps, true);
    return null;
  }

  componentDidUpdate(prevProps) {
    if (prevProps.docKey !== this.props.docKey) {
      this.dropEdit(prevProps);
      this.wantView = true; this.settle = null;
      this.history = []; this.future = []; this.caret = null; this.lastHtml = ''; this.lastKey = null; this.selRaw = null; this.openKey = '';
      const s = this.state;
      if (s.activeLine != null || s.mention || s.pop || s.picker) { this.setState({ activeLine: null, mention: null, pop: null, picker: null }); return; }
    }
    if (this.editing && prevProps.text !== this.props.text) this.trackEdit();
    // Progress of a run arrives many times a second. It changes pending rows and Build cards only, and those are replaced
    // where they stand: the rest of the editor, the caret and a selection in it are not touched.
    const asked = prevProps.asks !== this.props.asks, built = prevProps.builds !== this.props.builds || prevProps.buildProgress !== this.props.buildProgress || prevProps.buildDiffs !== this.props.buildDiffs;
    // Builds first: each patch ends by redrawing the editor's HTML in memory, which is where the cards' parts are remembered.
    // A guide's paper buttons (paperState) and Try marks (repoState) are not patched: a change there redraws the editor.
    if ((asked || built) && prevProps.text === this.props.text && prevProps.docKey === this.props.docKey && prevProps.models === this.props.models && prevProps.paperState === this.props.paperState && prevProps.repoState === this.props.repoState && (!built || this.patchBuilds()) && (!asked || this.patchPending())) return;
    this.syncEditor();
    this.maybeRestoreView();
  }

  componentWillUnmount() {
    if (this.lastKey === this.key()) this.reportView(this.props, true);
    this.dropEdit(this.props);
    this.mounted = false; clearTimeout(this.pickerT); clearTimeout(this.viewT);
    if (this.resizeObs) this.resizeObs.disconnect();
    window.removeEventListener('resize', this.fitFollows);
    Object.entries(this.docListeners || {}).forEach(([k, f]) => document.removeEventListener(k, f));
    document.removeEventListener('scroll', this.buildScrolled, true);
    for (const id of this.timers) clearTimeout(id);
    this.timers.clear();
  }

  /* ---------------------------------------------------------------- public (via ref) */
  /** Put the caret at the start of the document (a freshly created note). */
  focusStart() { this.caret = { line: 0, offset: 0 }; this.wantFocus = true; this.setState({ activeLine: 0 }); }
  /** Put the caret at the end of the last line. */
  focusEnd() { this.docClickInternal(); }
  /** True while a line is being edited or the mention menu is open (the parent's Esc handler checks this). */
  isActive() { return this.state.activeLine != null || !!this.state.mention; }

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
    this.settle = pos ? { key: this.key(), pos, until: Date.now() + 4000 } : null;
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
  stopSettling = () => { this.settle = null; };
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
  // Each line read in place (a line inside a code block is code). Kept per array, so a loop over one array reads it once.
  parsedOf(ls) { let ps = this.parsedCache.get(ls); if (!ps) { ps = parseLines(ls); this.parsedCache.set(ls, ps); } return ps; }
  editorEl() { return this.edRef.current; }
  // Lines the person cannot type in: an @bart line once something stands under it, a run at work, the closing line of an
  // answer (it is the card's foot), an answer folded away, the lines of an @brainstorm card, and the prototype's `> `
  // replies. The text of an answer can be edited (2026-09-21): it is a drawn-prefix line, as a bullet is. So is a question
  // in edit mode (2026-10-03), until Enter, Escape or the caret leaving it ends that.
  lockedAt(ls, i) {
    if (this.editing && this.editing.q === i) return false;
    const ps = this.parsedOf(ls), p = ps[i] || parseLine('');
    if (p.type === 'build') return true;
    if (p.type === 'reply') return p.folded || this.cardsOf(ls).lines.has(i) || (ATTRIBUTION_RE.test(p.text) && (ps[i + 1] || parseLine('')).type !== 'reply');
    if (p.type === 'bart') return ls[i + 1] != null && UNDER_BART.includes(ps[i + 1].type);
    return isAnswer(p.type);
  }
  // A card is closed by its foot, never by a line the caret can sit on: the document needs a line of its own after it.
  // So does a code block, or the caret below it would land on its closing fence and type into it.
  endsOnCard(ls) { const last = ls.length - 1; return this.lockedAt(ls, last) || ['reply', 'fence'].includes((this.parsedOf(ls)[last] || parseLine('')).type); }
  // The @brainstorm cards of a document (kept per array, as parsedOf is) → { byQ, lines }: by the line of the question each
  // answers, { card, turn, thread, last, live, answer }, where `last` is the card's last line before its foot, `live` that
  // it is the last turn of its thread (unfolded, in an editor that can ask), and `answer` what the line under it said
  // (main/bart/card.cjs readAnswer); `lines` holds every line a card is drawn over.
  cardsOf(ls) {
    let held = this.cardCache.get(ls); if (held) return held;
    held = { byQ: new Map(), lines: new Set() };
    const ps = this.parsedOf(ls), models = this.props.models;
    for (const thread of threads(ls, ps)) {
      thread.turns.forEach((turn, n) => {
        const agent = agentOf(ps[turn.q]);
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
  // left an empty span the browser typed into, and those characters were lost).
  openIdx(tokens, a, b) { const out = []; let acc = 0; tokens.forEach((tok, k) => { const end = acc + tok.length, pre = tokShown(tok).pre; if (pre && a <= end && b >= acc) out.push(k); acc = end; }); return out; }
  activeHtml(tokens, flags) {
    const [a, b] = this.revealRange(), open = this.openIdx(tokens, a, b); this.openKey = open.join(',');
    return tokens.map((tok, k) => {
      if (flags && flags.has(k)) return `<span data-src="${esc(tok)}" data-open="1" style="${FLAG_LOOK}">${esc(tok)}</span>`;
      const isOpen = !tokShown(tok).pre || open.includes(k);
      return `<span data-src="${esc(tok)}" data-open="${isOpen ? 1 : 0}">${isOpen && !AGENT_TOKEN.test(tok) ? esc(tok) : inlineHtml(tok)}</span>`;
    }).join('');
  }
  // An @bart line in pieces: its recognised flags (src/main/bart/question.cjs reads them, as the run will) each a token of
  // their own, the rest split as any line is. Shown verbatim, so offsets in the line are what they were. An @brainstorm
  // or @orient line has none: its model is fixed and a flag picks nothing (main/bart/models.cjs readBrainstorm). An @discover line's
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
  segs(t) {
    return [...t.childNodes].filter((n) => n.nodeName !== 'BR').map((n) => {
      const el = n.nodeType === 1 && n.dataset && n.dataset.src != null ? n : null;
      const txt = n.textContent.replace(/\u200b/g, '');
      const open = !el || el.dataset.open === '1';
      return { dl: txt.length, src: open ? txt : el.dataset.src, open, rl: open ? txt.length : el.dataset.src.length };
    });
  }
  displayToRaw(t, disp) {
    const segs = this.segs(t); if (!segs.length) return null; let accD = 0, accR = 0;
    for (const s of segs) {
      if (disp <= accD + s.dl) { const d = disp - accD; if (s.open) return accR + d; const { pre } = tokShown(s.src); return accR + (d === 0 ? 0 : Math.min(s.rl, pre + d)); }
      accD += s.dl; accR += s.rl;
    }
    return accR;
  }
  rawToDisplay(t, raw) {
    const segs = this.segs(t); let accD = 0, accR = 0;
    for (const s of segs) {
      if (raw <= accR + s.rl) { const d = raw - accR; if (s.open) return accD + d; const { pre } = tokShown(s.src); return accD + Math.max(0, Math.min(s.dl, d - pre)); }
      accD += s.dl; accR += s.rl;
    }
    return accD;
  }
  activeRaw(t) { return this.segs(t).map((s) => s.src).join(''); }

  // `at` says where a line of an @bart card stands in it (this.layout); every other line has none.
  lineHtml(i, line, p, active, first, at, locked) {
    const raw = `data-line="${i}" data-raw="${esc(line)}"`;
    if (p.type === 'build') return this.buildHtml(i, line, p);
    if (p.type === 'code' || p.type === 'fence') return this.codeHtml(i, line, p, active);
    if (p.type === 'todo') {
      const done = p.done;
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;background:#fafafa;padding:${first ? '10px' : '0'} 16px 0 ${16 + p.depth * 24}px;border-radius:${first ? '10px 10px 0 0' : '0'}">`
        + `<span contenteditable="false" data-act="toggle" data-row="${i}" role="button" style="user-select:none;flex:none;width:14px;margin-top:12px;text-align:center;font:15px/1 var(--font-sans);color:${done ? '#8f8f8f' : '#171717'};cursor:pointer">${done ? '✓' : '–'}</span>`
        + `<span class="t" style="flex:1;min-width:0;padding:6px 0;min-height:39px;color:${done ? '#8f8f8f' : '#171717'};text-decoration:${done ? 'line-through' : 'none'}">${content || '<br>'}</span>`
        + `<button contenteditable="false" data-act="remove" data-row="${i}" aria-label="Remove todo" style="user-select:none;flex:none;margin-top:12px;padding:0 2px;border:0;background:transparent;font:14px/1 var(--font-sans);color:#c9c9c9;cursor:pointer">×</button>`
        + '</div>';
    }
    if (p.type === 'list') {
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;padding:4px 0 4px ${p.depth * 24}px;min-height:35px">`
        + (p.num != null
          ? `<span contenteditable="false" style="user-select:none;flex:none;min-width:14px;text-align:right;line-height:1.6;color:#8f8f8f;font-variant-numeric:tabular-nums">${esc(listMark(p))}</span>`
          : `<span contenteditable="false" style="user-select:none;flex:none;width:14px;text-align:center;line-height:1.6;color:#8f8f8f">\u2022</span>`)
        + `<span class="t" style="flex:1;min-width:0">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'h') {
      const size = [26, 22, 18][p.level - 1]; const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="padding:4px 0;min-height:35px;font:500 ${size}px/1.6 var(--font-sans);letter-spacing:-0.3px"><span class="t">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'bart') {
      const { tokens, flags } = this.bartTokens(line, p), models = this.props.models;
      const content = active && !locked ? this.activeHtml(tokens, flags) : tokens.map((tok, k) => (flags.has(k) ? `<span style="${FLAG_LOOK}">${esc(tok)}</span>` : inlineHtml(tok))).join('');
      // @brainstorm and @discover run on one model (BS-08) and may be asked with nothing after them.
      const agent = agentOf(p), plain = oneModel(agent);
      const read = models && !plain ? readQuestion(p.text, models) : null, ready = plain || !!(read ? read.question : p.text).trim();
      // The question opens its card, or follows an answer inside one. Once it is answered its chip goes: the foot says who answered.
      // Being edited (2026-10-03), it has its chip and send again, as an unasked line has.
      const top = !at || at.top, closes = !at || at.closes, editing = !!this.editing && this.editing.q === i, chipped = closes || editing;
      const send = `<button contenteditable="false" data-act="ask" data-row="${i}" aria-label="Send" ${ready ? '' : 'disabled'} style="user-select:none;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${ready ? '#0070f3' : '#eaeaea'};color:${ready ? '#fff' : '#8f8f8f'};cursor:${ready ? 'pointer' : 'default'};transition:background 160ms"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"><path d="M8 13.5V3.2M3.6 7.4 8 3l4.4 4.4"/></svg></button>`;
      // The chip: what the question starts on, and (hovered) where that is changed. The arrow sits inside it, one unit.
      const open = !!(this.state.picker && this.state.picker.kind === 'line' && this.state.picker.i === i);
      // An unanswered @discover line's chip (2026-10-03) names its level instead, the one it would run at now (carried from
      // an earlier turn of its exchange when the line names none), with its provider when that is not the default ("Codex ·
      // Deep"), or the model and effort a flag pins it to; its menu is DiscoverLevels. @brainstorm and @orient run on one model: no chip.
      const label = read ? `${read.steps[0].name} ${EFFORT_LABELS[read.steps[0].effort] || read.steps[0].effort}` : models && agent === 'discover' && chipped ? this.discoverLabel(i) : null;
      const chip = label ? `<span contenteditable="false" data-chip="${i}" style="user-select:none;flex:none;display:inline-flex;align-items:center;gap:8px;margin:-2px -6px 0 0;padding:2px 2px 2px 12px;border:1px solid #eaeaea;border-radius:999px;background:#fff"><span data-act="pick" data-row="${i}" role="button" aria-haspopup="dialog" aria-expanded="${open}" style="display:inline-flex;align-items:center;gap:7px;height:26px;font:13px/1 var(--font-sans);color:#4d4d4d;cursor:default;white-space:nowrap">${esc(label)}<span style="display:inline-flex;align-items:center;justify-content:center;width:10px;height:12px;font:12px/1 var(--font-sans);color:#8f8f8f"><span style="position:relative;top:${open ? '3px' : '-3px'}">${open ? '⌃' : '⌄'}</span></span></span>${send}</span>` : `<span contenteditable="false" style="flex:none;margin-top:3px">${send}</span>`;
      return `<div ${raw} ${locked ? 'contenteditable="false" data-readonly="1"' : ''}${editing ? ' data-editing="1"' : ''} style="display:flex;align-items:flex-start;gap:10px;padding:${top ? 12 : 10}px 16px ${closes ? '10px' : '4px'};min-height:35px;background:#fafafa;border-radius:${radius(top, closes)};margin-bottom:${closes ? '14px' : '0'};font-size:16px;line-height:1.6;${locked ? 'user-select:text;cursor:default' : ''}"><span class="t" style="flex:1;min-width:0">${content || '<br>'}</span>`
        + (chipped ? chip : '')
        + '</div>';
    }
    if (p.type === 'pending') {
      // The run with this id is working, or it died with the app and only Hide is left. While it works the row shows what
      // it is doing, the things it has done (behind the count, closed until clicked) and the answer so far. None of that is
      // in the document: it comes from props.asks, and the row's `data-raw` stays the bare pending line.
      const ask = (this.props.asks || {})[p.id];
      const doing = ask ? (ask.activity || (ask.movedUp ? 'Thinking harder' : 'Thinking')) : '';
      const label = ask ? `${esc(doing)}${ask.name ? ` · ${esc(ask.name)} ${esc(ask.effort)}` : ''}` : 'No answer came back: the run was interrupted.';
      const log = (ask && ask.log) || [], open = this.openLogs.has(p.id);
      // The answer so far is not the answer: smaller and grey, with a mark pulsing where the next words go. No rule beside
      // it (2026-09-21); it starts where the answer's text will, so nothing moves sideways when the answer lands.
      const cursor = '<span style="display:inline-block;width:7px;height:13px;margin-left:3px;vertical-align:-1px;border-radius:2px;background:#c9c9c9;animation:thinking 1.2s ease-in-out infinite"></span>';
      // Code arriving shows as code: mono, grey like the rest, its fences a little space (bodyLines closes a block still
      // being written, so the lines under an opening fence are code as soon as they come).
      // A card arriving is JSON, which says nothing until it is drawn: an @brainstorm or @orient run shows what it is doing
      // only, and an @discover run its guide as it comes but not a card.
      const who = (ask && ask.agent) || (at && at.agent), coming = (ask && ask.lines) || [];
      const so = fixedStep(who) || (who === 'discover' && /^\s*(\{|```)/.test(coming.join('\n'))) ? [] : coming, role = new Map();
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
      return `<div ${raw} data-pending="${esc(p.id)}" contenteditable="false" data-readonly="1" style="user-select:none;cursor:default;padding:2px 16px 12px;background:#fafafa;border-radius:${radius(!at, closes)};margin-bottom:${closes ? '14px' : '0'};color:#8f8f8f;font:13px/1.5 var(--font-sans)">`
        + written
        + (open && log.length ? `<div style="margin:0 0 8px 16px;font:12px/1.7 var(--font-sans);color:#8f8f8f">${log.map((entry) => `<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(entry)}</div>`).join('')}</div>` : '')
        + '<div style="display:flex;align-items:center;gap:10px">'
        + (ask ? '<span style="flex:none;width:6px;height:6px;border-radius:50%;background:#0070f3;animation:thinking 1.2s ease-in-out infinite"></span>' : '')
        + `<span class="t" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</span>`
        + (log.length ? `<button class="bart-text" data-act="asklog" data-ask="${esc(p.id)}" aria-expanded="${open}" style="user-select:none;flex:none;display:inline-flex;align-items:center;gap:6px;font-weight:400">${log.length} ${log.length === 1 ? 'step' : 'steps'}${open ? ICON.stepsOpen : ICON.stepsShut}</button>` : '')
        + (ask ? `<button class="bart-text" data-act="stopask" data-ask="${esc(p.id)}" style="user-select:none;flex:none">Stop</button>` : `<button class="bart-text" data-act="dropline" data-row="${i}" style="user-select:none;flex:none">Hide</button>`)
        + '</div></div>';
    }
    if (p.type === 'reply') {
      if (at && at.role === 'foot') return this.footHtml({ raw, q: at.turn.q, text: p.text.slice(1, -1), folded: at.turn.folded, closes: at.closes, plain: oneModel(at.agent), edit: at.editable });
      // Folded away, or the empty line the runner leaves before the closing line: in the document, not on the page.
      if (p.folded || (at && (at.gap || at.underCard))) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
      if (at && at.card) return this.cardHtml(raw, at.card);
      // One line of an answer, in the grey card with one continuous rule down its left. The caret's line shows its source
      // on the design's focus tint; the rule and the card stay where they are.
      // (An answer with no question above it, left by an edit outside the app, is a card of its own.)
      const near = at ? null : this.lines(), first = at ? at.first : parseLine(near[i - 1] ?? '').type !== 'reply', closes = at ? at.closes : parseLine(near[i + 1] ?? '').type !== 'reply', last = at ? at.lastBody : closes;
      if (p.code) return this.answerCodeHtml(i, raw, p, active, first, closes, last, !at);
      // A brainstorm recap's "Look for:" line (2026-09-30, round 4) draws as a button that starts an @discover thread on
      // it; the line stays in the file as it was written, so Copy and an edit read the words. An orient recap's first one
      // alone (2026-10-04): any after it is drawn as a line of the answer.
      const look = at && fixedStep(at.agent) && !active && !(at.agent === 'orient' && this.lookedAbove(i, at)) ? recapParts(p.text).lookFor[0] : null;
      // And its other lines ("Where you are: …", "What you know: …") as sections: the label in bold on a line of its own, the words under it.
      const recap = at && fixedStep(at.agent) && !active && !look ? recapLine(p.text) : null;
      const lookAbove = look && !first && !!recapParts(parseLine(this.lines()[i - 1] ?? '').text).lookFor.length;
      // An @discover guide's title line (2026-10-02) has its paper's bookmark in a margin of its own on the right, level with
      // the title's first line (2026-10-03): the title wraps before it, and every entry's sits in the same place.
      const paper = at && at.agent === 'discover' && !active ? this.guidePaper(i, p.text, at) : null, mark = paper ? this.paperSaveHtml(i, paper) : '';
      // Its Try line (2026-10-04) has the repository's mark just before the link.
      const repo = at && at.agent === 'discover' && !active && !paper ? guideRepo(p.text) : null, run = repo ? this.repoMarkHtml(repo) : '';
      const a = this.answerLook(p.text), content = active ? this.activeHtml(tokensOf(p, line)) : look ? (lookAbove ? '' : this.recapLabelHtml('Look for prior work', first)) + this.lookForHtml(i, look, lookAbove ? 6 : 4) : recap ? this.recapHtml(recap, first) : (run ? a.content.replace('<a ', `${run}<a `) : a.content) + mark;
      return `<div ${raw}${mark ? ' data-paper-line="1"' : ''} style="padding:${first ? 8 : 0}px 16px ${closes ? 12 : 0}px;background:#fafafa;border-radius:${radius(!at && first, closes)};margin-bottom:${closes ? 14 : 0}px;color:#4d4d4d;font-size:16px;line-height:1.65;cursor:text"><span style="display:block;padding:${first ? 2 : 0}px 0 ${last ? 2 : 0}px 12px;border-left:2px solid #dcdcdc"><span class="t" style="display:block;min-height:${a.minHeight}px;border-radius:4px;${a.look}${mark ? 'position:relative;padding-right:28px;' : ''}${active ? 'background:#f2f2f2;box-shadow:0 0 0 4px #f2f2f2;' : ''}">${content || '<br>'}</span></span></div>`;
    }
    if (p.type === 'quote') {
      // The prototype's replies: read-only, as they were.
      const ls = this.lines(), up = i > 0 && parseLine(ls[i - 1]).type === 'quote', down = parseLine(ls[i + 1] ?? '').type === 'quote';
      return `<div ${raw} contenteditable="false" data-readonly="1" style="user-select:text;cursor:default;padding:${up ? 0 : 8}px 16px ${down ? '0' : '12px'};background:#fafafa;border-radius:${radius(!up, !down)};margin-bottom:${down ? '0' : '14px'};color:#4d4d4d;font-size:16px"><span class="t" style="display:block;min-height:${p.text ? 31 : 12}px;padding:2px 0 2px 12px;border-left:2px solid #dcdcdc">${inlineHtml(p.text) || '<br>'}</span></div>`;
    }
    if (p.type === 'img') {
      const src = p.src.startsWith('img:') ? ((this.props.images || {})[p.src.slice(4)] || '') : p.src;
      const content = active ? this.activeHtml([line]) : !src ? `<span contenteditable="false" style="display:inline-block;margin:6px 0;padding:10px 14px;border:1px dashed #c9c9c9;border-radius:8px;font:12.5px/1.5 var(--font-sans);color:#8f8f8f;user-select:none">${esc(p.text || 'image')}…</span>` : `<img src="${esc(src)}" alt="${esc(p.text)}" draggable="false" style="display:block;max-width:100%;max-height:520px;margin:6px 0;border:1px solid #eaeaea;border-radius:8px;user-select:none">`;
      return `<div ${raw} style="padding:4px 0;min-height:35px"><span class="t" style="display:block">${content}</span></div>`;
    }
    const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(line);
    return `<div ${raw} style="padding:4px 0;min-height:35px"><span class="t">${content || '<br>'}</span></div>`;
  }
  // One line of a fenced code block, on the grey of the cards, in the mono face. The opening fence is the block's head:
  // its language and Copy, or the fence as typed while the caret is on it. The closing fence is the block's foot, a
  // strip of grey, or the fence while the caret is on it. A line of code shows its source whether or not the caret is
  // on it (display and source are the same characters), so JSON keeps its colours while it is edited.
  codeHtml(i, line, p, active) {
    const raw = `data-line="${i}" data-raw="${esc(line)}" data-kind="${p.type}"`, mono = 'font:14px/1.7 var(--font-mono)';
    if (p.type === 'code') return `<div ${raw} style="padding:0 16px;background:#fafafa;${mono};color:#171717"><span class="t" style="display:block;min-height:24px;tab-size:2">${highlight(line, p.lang) || '<br>'}</span></div>`;
    if (!p.open) return `<div ${raw} style="padding:0 16px ${active ? 8 : 4}px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px"><span class="t" style="display:block;${active ? `${mono};color:#8f8f8f` : 'font:8px/1 var(--font-sans)'}">${active ? esc(line) : '<br>'}</span></div>`;
    const shown = active ? esc(line) : esc(fenceShown(p));
    return `<div ${raw} style="display:flex;align-items:center;gap:8px;min-height:36px;margin-top:6px;padding:4px 6px 0 16px;background:#fafafa;border-radius:10px 10px 0 0"><span class="t" style="flex:1;min-width:0;${active ? `${mono};color:#8f8f8f` : 'font:12px/1.6 var(--font-sans);color:#8f8f8f'}">${shown || '<br>'}</span>${this.copyCodeHtml(i)}</div>`;
  }
  // A code block inside an @bart answer (2026-09-22): a white box on the card's grey, inside the answer's rule, drawn
  // the way a block in the document is (language and Copy at its head, a fence as typed while the caret is on it).
  answerCodeHtml(i, raw, p, active, first, closes, last, alone) {
    const mono = 'font:14px/1.7 var(--font-mono)', sides = 'border-left:1px solid #eaeaea;border-right:1px solid #eaeaea';
    let inner;
    if (p.code === 'body') inner = `<span class="t" style="display:block;min-height:24px;padding:0 12px;background:#fff;${sides};${mono};color:#171717;tab-size:2">${highlight(p.text, p.lang) || '<br>'}</span>`;
    else if (p.code === 'close') inner = `<span class="t" style="display:block;padding:0 12px ${active ? 6 : 4}px;background:#fff;${sides};border-bottom:1px solid #eaeaea;border-radius:0 0 8px 8px;${active ? `${mono};color:#8f8f8f` : 'font:8px/1 var(--font-sans)'}">${active ? esc(p.text) : '<br>'}</span>`;
    else inner = `<span style="display:flex;align-items:center;gap:8px;min-height:32px;padding:2px 4px 0 12px;background:#fff;${sides};border-top:1px solid #eaeaea;border-radius:8px 8px 0 0"><span class="t" style="flex:1;min-width:0;${active ? `${mono};color:#8f8f8f` : 'font:12px/1.6 var(--font-sans);color:#8f8f8f'}">${(active ? esc(p.text) : esc(fenceShown(p))) || '<br>'}</span>${this.copyCodeHtml(i)}</span>`;
    // The space around the box is the rule's padding, not a margin: a margin would fall through the line's wrappers and
    // cut a white strip across the card.
    const above = first ? 2 : p.code === 'open' ? 6 : 0, below = last ? 2 : p.code === 'close' ? 6 : 0;
    return `<div ${raw} data-kind="${p.code === 'body' ? 'code' : 'fence'}" style="padding:${first ? 8 : 0}px 16px ${closes ? 12 : 0}px;background:#fafafa;border-radius:${radius(alone && first, closes)};margin-bottom:${closes ? 14 : 0}px;cursor:text"><span style="display:block;padding:${above}px 0 ${below}px 12px;border-left:2px solid #dcdcdc">${inner}</span></div>`;
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
      + `<span style="display:block;${missing ? 'color:#8f8f8f;font-style:italic;' : ''}">${text ? inlineHtml(text) : '<span style="color:#8f8f8f;font-style:italic">not said</span>'}</span>`;
  }
  // Whether a line of answer `at` above line `i` is a Look for line already.
  lookedAbove(i, at) {
    const ls = this.lines();
    for (let k = at.turn.from; k < i; k++) if (recapParts(parseLine(ls[k] ?? '').text).lookFor.length) return true;
    return false;
  }
  // `target`: what the click names, the recap's line (data-row) by default; a live card's button names its turn (round 6).
  lookForHtml(i, query, above = 0, target = `data-act="discoverlook" data-row="${i}"`) {
    const can = !!this.props.onAsk;
    return `<button type="button" contenteditable="false" class="${can ? 'hov-ink-wash' : ''}" ${target} ${can ? '' : 'disabled'} style="user-select:none;display:inline-flex;align-items:baseline;gap:6px;max-width:100%;margin:${above}px 0 2px;padding:4px 10px;border:1px solid #eaeaea;border-radius:6px;background:#fff;font:14px/1.5 var(--font-sans);color:#171717;text-align:left;cursor:${can ? 'pointer' : 'default'}"><span style="flex:none;color:#0070f3;font-weight:500">@discover</span>${query ? `<span>${esc(query)}</span>` : ''}</button>`;
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
    const held = this.saving.get(paper.address), state = held || known, off = !!held || state === 'here' || !this.props.onSavePaper, { icon: drawn, words } = PAPER_MARK[state];
    return `<button type="button" contenteditable="false" class="paper-mark" data-act="papersave" data-row="${i}" data-save="${state}"${held ? ' data-busy="1"' : ''} ${off ? 'disabled aria-disabled="true"' : ''} title="${words}" aria-label="${words}" style="user-select:none">${drawn}</button>`;
  }
  // The button clicked: the paper goes to props.onSavePaper, the document is not touched. A failure goes to props.onError
  // and the button says what it said before; a success shows when the library or the workspace changes.
  savePaper(i) {
    const ls = this.lines(), p = this.parsedOf(ls)[i], at = this.layout(ls).get(i);
    if (!p || p.type !== 'reply' || !at || at.agent !== 'discover' || !this.props.onSavePaper || !this.props.paperState) return;
    const paper = this.guidePaper(i, p.text, at), state = paper && this.props.paperState(paper.address);
    if (!paper || this.saving.has(paper.address) || (state !== 'none' && state !== 'lib')) return;
    this.saving.set(paper.address, state); this.redraw();
    Promise.resolve().then(() => this.props.onSavePaper(paper))
      .catch((error) => { if (this.props.onError) this.props.onError(error); })
      .finally(() => { this.saving.delete(paper.address); this.redraw(); });
  }
  // A Try line's mark (2026-10-04): grey words before the link, "Run" (the repository is not here yet) or "Added" (it is).
  // Not a button: the link is what is clicked. Words drawn, never written, which a copy holds none of and caretAt does not
  // count. At half strength while a click is at work. None where the editor is not told where repositories are.
  repoMarkHtml(repo) {
    const known = this.props.repoState && this.props.onTryRepo ? this.props.repoState(repo.address) : null; if (!REPO_MARK[known]) return '';
    const held = this.trying.get(repo.address.toLowerCase()), state = held || known, { label, words } = REPO_MARK[state];
    return `<span contenteditable="false" data-repo-mark="${state}"${held ? ' data-busy="1"' : ''} title="${words}" style="user-select:none;-webkit-user-select:none;margin-right:6px;font-size:12px;color:#8f8f8f${held ? ';opacity:.5' : ''}">${label}</span>`;
  }
  // A link clicked on a Try line of an @discover answer (2026-10-04), once the page has opened: when it is the line's own
  // repository and that is not here yet, it goes to props.onTryRepo, one click at a time for each repository. A failure
  // goes to props.onError and the mark says what it said before; a success shows when the library or the workspace
  // changes. The document is not touched.
  tryRepo(i, href) {
    const ls = this.lines(), p = this.parsedOf(ls)[i], at = this.layout(ls).get(i);
    if (!p || p.type !== 'reply' || !at || at.agent !== 'discover' || at.role !== 'answer' || !this.props.onTryRepo || !this.props.repoState) return;
    const repo = guideRepo(p.text), clicked = repoOf(href), key = repo && repo.address.toLowerCase();
    if (!repo || !clicked || clicked.address.toLowerCase() !== key || this.trying.has(key)) return;
    const state = this.props.repoState(repo.address); if (state !== 'none' && state !== 'lib') return;
    this.trying.set(key, state); this.redraw();
    Promise.resolve().then(() => this.props.onTryRepo(repo))
      .catch((error) => { if (this.props.onError) this.props.onError(error); })
      .finally(() => { this.trying.delete(key); this.redraw(); });
  }
  redraw() { this.lastHtml = null; if (this.mounted) this.forceUpdate(); }
  // A recap's Look for line clicked: its first search.
  recapLook(i) {
    const p = this.parsedOf(this.lines())[i]; if (!p || p.type !== 'reply') return;
    const query = recapParts(p.text).lookFor[0]; if (query) this.discoverLook(i, query);
  }
  // A live @brainstorm card's @discover button clicked (round 6): the card's search, or none. The card stays live.
  cardLook(q) {
    const entry = this.cardsOf(this.lines()).byQ.get(q); if (!entry || !entry.live || entry.agent !== 'brainstorm') return;
    this.discoverLook(q, entry.card.lookFor || '');
  }
  // After the thread line `i` is in, a blank line (so the new line starts a thread of its own, doc.js threads) and
  // "@discover <query>" ("@discover" alone with no query) with its pending line, asked with no earlier turns. An answer to
  // a brainstorm card still live above it is written under the brainstorm thread, so above this one (sendCard).
  discoverLook(i, query = '') {
    const ls = this.lines(), thread = threads(ls).find((t) => t.from <= i && i <= t.to);
    if (!thread || !this.props.onAsk) return;
    const askId = newAskId(), add = ['', query ? `@discover ${query}` : '@discover', `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    this.setLines((x) => { const out = [...x]; out.splice(thread.to + 1, 0, ...add); return out; });
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: query, turns: [], agent: 'discover' });
  }
  answerLook(text) {
    const q = parseLine(text), ink = (html) => html.replace(/<strong style="font-weight:600">/g, '<strong style="color:#171717;font-weight:600">');
    if (q.type === 'h') return { content: ink(inlineHtml(q.text)), look: `font:600 ${[18, 17, 16][q.level - 1]}px/1.5 var(--font-sans);color:#171717;padding-top:8px;`, minHeight: 26 };
    if (isMarked(q.type)) return { content: `<span style="display:flex;gap:10px;padding-left:${q.depth * 18}px"><span contenteditable="false" style="flex:none;color:#8f8f8f;user-select:none">${esc(listMark(q))}</span><span style="flex:1;min-width:0">${ink(inlineHtml(q.text))}</span></span>`, look: 'padding-top:4px;padding-bottom:4px;', minHeight: 26 };
    return { content: ink(inlineHtml(text)), look: 'text-wrap:pretty;', minHeight: text ? 26 : 22 };
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
    // The conversation: from the agent's last message on; the earlier ones behind a count. A closed Build shows only its last note.
    const messages = task.messages || [];
    let from = 0;
    for (let k = messages.length - 1; k >= 0; k--) if (messages[k].role === 'agent') { from = k; break; }
    if (final) from = Math.max(0, messages.length - 1);
    const open = this.buildOpen.has(id), hidden = open ? 0 : from;
    let body = hidden ? `<button class="bart-text" data-act="buildhistory" data-build-id="${esc(id)}" style="user-select:none;padding-left:0">${hidden} earlier ${hidden === 1 ? 'message' : 'messages'}</button>` : (open && from ? `<button class="bart-text" data-act="buildhistory" data-build-id="${esc(id)}" style="user-select:none;padding-left:0">Hide earlier messages</button>` : '');
    body += messages.slice(hidden).map((m) => this.buildMessageHtml(m)).join('');
    if (status === 'needs-you' && task.question) body += `<div style="margin:10px 0 2px;padding:8px 12px;border-left:2px solid #0070f3;background:#fff;color:#171717"><strong style="font-weight:600">Needs you:</strong> ${inlineHtml(task.question)}</div>`;
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
        + '<span style="flex:none;width:6px;height:6px;border-radius:50%;background:#0070f3;animation:thinking 1.2s ease-in-out infinite"></span>'
        + `<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doing)}</span>`
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
    return [['head', head], ['body', body], ['run', this.buildRunHtml(id, task)], ['live', live], ['diff', this.buildDiffHtml(id, task)], ['reply', reply], ['actions', actions]];
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
      + (working && !kept ? '<span style="flex:none;width:6px;height:6px;border-radius:50%;background:#0070f3;animation:thinking 1.2s ease-in-out infinite"></span>' : '')
      + `<span style="flex:none;font-weight:500;color:#171717">${label}</span>`
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
        part.innerHTML = html; this.buildDrawn.set(key, html);
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
    else if (e.key === 'Escape') e.target.blur();
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

  // The foot of a checklist card: Copy all; clicking its whitespace adds a line below the card. (Build all and ⌘⏎,
  // which only pretended to build, went with @Task on 2026-09-29.)
  groupHtml(group) {
    const lastIdx = group[group.length - 1].i;
    const copy = `<button data-act="copyall" data-lines="${group.map((t) => t.i).join(',')}" style="margin-right:auto;display:inline-flex;align-items:center;min-height:32px;padding:8px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fff;color:#171717;font:500 13px/1 var(--font-sans);cursor:pointer">${this.copied === group[0].i ? 'Copied' : 'Copy all'}</button>`;
    return `<div contenteditable="false" data-act="after" data-after="${lastIdx}" style="user-select:none;display:flex;align-items:center;padding:8px 16px 14px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px;cursor:text">${copy}</div>`;
  }
  // Where every line of an @bart card stands in it: which turn it belongs to, whether it opens or closes the card, and
  // what is drawn after it that is not a line (a foot for an answer that has no closing line; the follow-up field).
  // `agent` is the turn's; an @brainstorm answer that is a card is drawn on its first line (`card`) and the rest of its
  // lines are `underCard`. A live card is answered on the card itself, so its thread has no follow-up field. `editable`:
  // whether the turn's question can be edited in place (canEdit).
  layout(ls) {
    const at = new Map(), ps = this.parsedOf(ls), cards = this.cardsOf(ls);
    for (const thread of threads(ls, ps)) {
      const end = thread.turns[thread.turns.length - 1], endCard = cards.byQ.get(end.q);
      const follow = end.answered && !end.pending && !end.folded && !!this.props.onAsk && !(endCard && endCard.live);
      for (const turn of thread.turns) {
        const agent = agentOf(ps[turn.q]), card = cards.byQ.get(turn.q), editable = this.canEdit(ps[turn.q], turn, card);
        at.set(turn.q, { thread, turn, agent, role: 'question', top: turn.q === thread.from, closes: !turn.answered, editable });
        const footless = turn.answered && !turn.pending && turn.foot < 0, tail = turn === end;
        const gap = turn.foot > turn.from && parseLine(ls[turn.foot - 1]).text === '' ? turn.foot - 1 : -1;
        const lastBody = (turn.foot >= 0 ? turn.foot : turn.to + 1) - (gap >= 0 ? 2 : 1);
        for (let i = turn.from; i <= turn.to; i++) {
          const role = i === turn.foot ? 'foot' : parseLine(ls[i]).type === 'pending' ? 'pending' : 'answer', ends = i === turn.to;
          const drawn = card && i <= card.last ? { card: i === turn.from ? card : null, underCard: i !== turn.from } : {};
          at.set(i, { thread, turn, agent, role, gap: i === gap, first: i === turn.from, lastBody: i === lastBody, closes: ends && tail && !follow && !footless, footAfter: ends && footless, followAfter: ends && tail && follow, tail, editable, ...drawn });
        }
      }
    }
    return at;
  }
  // Whether a turn's question can be edited in place (2026-10-03): answered and not at work, in an editor that can ask and
  // be written in; not a Build (`@bart --build`), and not a turn whose answer is a card (cardsOf).
  canEdit(p, turn, card) {
    return !!this.props.onAsk && !this.props.readOnly && turn.answered && !turn.pending && !card && !buildRequestOf({ agent: agentOf(p), text: p.text });
  }
  /* ---------------------------------------------------------------- @brainstorm cards (2026-09-30) */
  // One card on the answer's grey: what it says, then a white box with the question, its options (a round mark for one,
  // a square for several, each option's `why` under its label) or its field, and Skip and Submit. An answered card is
  // drawn still, with what was picked marked; a card that is not the thread's last and has no answer under it (a turn
  // deleted after it) is drawn still too. A map card (the first of an exchange, 2026-09-30) draws where the person seems
  // to be above the box, live or answered: three short lists, each line with what it rests on in grey. A live @brainstorm
  // card (round 6) adds Wrap up before Submit, and under its box an @discover button with the card's search; on its
  // versions card (round 7) the field under the options reads "Or rewrite it yourself…". A live @orient card (2026-10-04)
  // has Wrap up and no @discover button.
  cardHtml(raw, entry) {
    const { card, turn, live, answer } = entry, q = turn.q, asked = questionOf(card), state = this.cardState.get(q) || {};
    const choice = isChoice(asked.type), many = asked.type === 'select_all';
    const picks = live ? state.picks || [] : answer ? answer.picks : [];
    const say = card.say ? `<div style="margin:0 0 10px;color:#4d4d4d;font-size:16px;line-height:1.6;white-space:pre-wrap">${esc(card.say)}</div>` : '';
    const map = card.map ? MAP_GROUPS.filter((group) => card.map[group].length).map((group) => `<div data-card-map="${group}" style="margin:0 0 10px">`
      + `<div style="margin:0 0 2px;font:500 11.5px/1.4 var(--font-sans);letter-spacing:.04em;text-transform:uppercase;color:#8f8f8f">${MAP_LABELS[group]}</div>`
      + card.map[group].map((item) => `<div style="display:flex;gap:8px;font-size:15px;line-height:1.5;color:#171717"><span aria-hidden="true" style="flex:none;color:#c9c9c9">–</span><span style="flex:1;min-width:0">${esc(item.text)}${item.from ? `<span style="display:block;font-size:13px;line-height:1.45;color:#8f8f8f">${esc(item.from)}</span>` : ''}</span></div>`).join('')
      + '</div>').join('') : '';
    // No eyebrow over the question (2026-09-30, David): the card's own `eyebrow` ("FOCUS", "YOUR OWN RESEARCH") is kept, not drawn.
    // Nor, on a brainstorm or orient card, its subtitle (2026-09-30, David: too much to read): the question stands alone. @discover's stays.
    const sub = (fixedStep(entry.agent) ? '' : asked.subtitle) || (many ? 'Select all that apply.' : '');
    let body = '';
    if (choice) {
      body = `<div role="${many ? 'group' : 'radiogroup'}" aria-label="${esc(asked.title)}" style="margin-top:12px">` + asked.options.map((option, n) => {
        const on = picks.includes(option.label);
        return `<button type="button" class="bs-opt" ${live ? `data-act="cardopt" data-turn="${q}" data-opt="${n}"` : 'disabled'} role="${many ? 'checkbox' : 'radio'}" aria-checked="${on}"><span class="bs-mark"${many ? ' data-square="1"' : ''}></span><span style="flex:1;min-width:0">${esc(option.label)}${option.why ? `<span class="bs-why">${esc(option.why)}</span>` : ''}</span></button>`;
      }).join('') + '</div>';
      // On @brainstorm's versions card (round 7) the words typed in place of a pick are their question, rewritten.
      const own = entry.agent === 'brainstorm' && asked.id === 'versions' ? 'Or rewrite it yourself' : 'Or say it in your own words';
      if (live) body += `<input data-card-input="${q}" data-card-field="note" placeholder="${card.map ? 'Anything I got wrong about where you are? (optional)' : `${own}…`}" aria-label="${card.map ? 'Add a note' : own}" spellcheck="false" autocomplete="off" class="bs-field" style="margin-top:10px">`;
      else if (answer && answer.note) body += `<div style="margin-top:10px;font-size:14px;color:#4d4d4d"><span style="color:#8f8f8f">You added:</span> ${esc(answer.note)}</div>`;
    } else if (live) {
      const field = asked.type === 'open'
        ? `<textarea data-card-input="${q}" data-card-field="text" rows="3" placeholder="${esc(asked.placeholder || 'In a sentence or two…')}" aria-label="${esc(asked.title)}" spellcheck="false" autocomplete="off" class="bs-field"></textarea>`
        : `<input data-card-input="${q}" data-card-field="text" placeholder="${esc(asked.placeholder || 'In a few words…')}" aria-label="${esc(asked.title)}" spellcheck="false" autocomplete="off" class="bs-field">`;
      body = `<div style="margin-top:12px">${field}</div>`;
    }
    // What was said, then (in grey) Skipped, or Wrapped up with or without an answer before it (round 6).
    if (!live && answer && answer.text) body += `<div style="margin-top:10px;font-size:14px;color:#171717;white-space:pre-wrap">${esc(answer.text)}</div>`;
    if (!live && answer && (answer.skipped || answer.wrap)) body += `<div style="margin-top:10px;font-size:14px;color:#8f8f8f">${answer.wrap ? 'Wrapped up' : 'Skipped'}</div>`;
    // A choice card can be answered in the person's own words instead of a pick (2026-09-30): the field alone is enough.
    const ready = choice ? picks.length > 0 || !!String(state.note || '').trim() : !!String(state.text || '').trim();
    const wraps = live && fixedStep(entry.agent), brainstorm = live && entry.agent === 'brainstorm';
    const acts = live ? '<div style="display:flex;align-items:center;gap:8px;margin-top:14px">'
      + `<button type="button" class="bart-text" data-act="cardskip" data-turn="${q}" style="user-select:none;padding-left:0">Skip</button><span style="flex:1"></span>`
      + (wraps ? `<button type="button" class="bart-text" data-act="cardwrap" data-turn="${q}" style="user-select:none">Wrap up</button>` : '')
      + `<button type="button" class="bs-submit" data-act="cardsend" data-turn="${q}" ${ready ? '' : 'disabled'}>Submit</button></div>` : '';
    const look = brainstorm ? `<div style="margin-top:10px">${this.lookForHtml(q, card.lookFor || '', 0, `data-act="cardlook" data-turn="${q}"`)}</div>` : '';
    return `<div ${raw} data-card="${q}" contenteditable="false" data-readonly="1" style="user-select:${live ? 'none' : 'text'};cursor:default;padding:12px 16px 4px;background:#fafafa;font:15px/1.5 var(--font-sans)">`
      + say + map
      + `<div data-card-box="${live ? 'live' : 'answered'}" style="padding:14px 16px 16px;border:1px solid #eaeaea;border-radius:10px;background:#fff">`
      + `<div style="font:600 16px/1.45 var(--font-sans);color:#171717">${esc(asked.title)}</div>`
      + (sub ? `<div style="margin-top:8px;font-size:13.5px;color:#8f8f8f">${esc(sub)}</div>` : '')
      + body + acts + '</div>' + look + '</div>';
  }
  // After a redraw: what was typed on a live card goes back into its fields, with the keyboard if it had it.
  restoreCards(ed, had) {
    for (const input of ed.querySelectorAll('[data-card-input]')) {
      const q = Number(input.dataset.cardInput), field = input.dataset.cardField, text = (this.cardState.get(q) || {})[field] || '';
      if (text) input.value = text;
      if (had && had.card && had.key === input.dataset.cardInput && had.field === field) { input.focus({ preventScroll: true }); try { input.setSelectionRange(had.a, had.b); } catch { /* not a text selection */ } }
    }
  }
  cardInput(input) {
    const q = Number(input.dataset.cardInput), field = input.dataset.cardField;
    const state = { ...(this.cardState.get(q) || {}), [field]: input.value };
    this.cardState.set(q, state);
    const send = input.closest('[data-card-box]') && input.closest('[data-card-box]').querySelector('[data-act="cardsend"]');
    if (!send) return;
    if (field === 'text') send.disabled = !input.value.trim();
    else if (field === 'note') send.disabled = !(state.picks || []).length && !input.value.trim(); // own words in place of a pick
  }
  // Enter submits; in an open answer Shift+Enter is a new line (the answer is still one line of the document, so it is
  // written with its lines run together).
  cardKey(e) {
    if (e.key === 'Enter' && !e.isComposing && !(e.shiftKey && e.target.tagName === 'TEXTAREA')) { e.preventDefault(); this.sendCard(Number(e.target.dataset.cardInput)); }
    else if (e.key === 'Escape') e.target.blur();
  }
  // A choice clicked: one of a single choice (a second click takes it back), any of a select-all.
  pickCard(q, n) {
    const entry = this.cardsOf(this.lines()).byQ.get(q); if (!entry || !entry.live) return;
    const asked = questionOf(entry.card), option = asked.options[n]; if (!option) return;
    const state = this.cardState.get(q) || {}, held = state.picks || [], on = held.includes(option.label);
    const picks = asked.type === 'select_all' ? asked.options.map((o) => o.label).filter((label) => (label === option.label ? !on : held.includes(label))) : on ? [] : [option.label];
    this.cardState.set(q, { ...state, picks }); this.lastHtml = null; this.forceUpdate();
  }
  // Submit, Skip (`how` 'skip') or Wrap up ('wrap', round 6; @brainstorm and @orient only) (BS-06): the answer goes under
  // the card as an @brainstorm (or @orient, or @discover) line of its own, with the pending line under it, and is asked as a follow-up is. Wrap up
  // writes what was picked or typed, if anything, then "; (wrap up)", or "(wrap up)" alone. Flags of the line before carry
  // on, as they do for @bart.
  sendCard(q, how = 'submit') {
    const ls = this.lines(), entry = this.cardsOf(ls).byQ.get(q); if (!entry || !entry.live || !this.props.onAsk) return;
    const { thread, card, agent } = entry, skip = how === 'skip', wrap = how === 'wrap';
    if (wrap && !fixedStep(agent)) return;
    const given = skip ? SKIPPED : answerLine(card, this.cardState.get(q) || {});
    if (how === 'submit' && given === SKIPPED) return; // nothing picked or typed yet: Submit waits
    const said = wrap ? withWrap(given) : given;
    const { flags } = this.followStep(ls, thread), text = [flags, said].filter(Boolean).join(' ');
    const askId = newAskId(), add = [`@${agent} ${text}`, `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const turns = thread.turns.filter((turn) => turn.answered && !turn.pending).map((turn) => turnText(ls, turn));
    this.cardState.delete(q);
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    this.setLines((x) => { const out = [...x]; out.splice(thread.to + 1, 0, ...add); return out; });
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text, turns, agent });
  }
  findTurn(ls, q) { for (const thread of threads(ls)) { const turn = thread.turns.find((t) => t.q === q); if (turn) return { thread, turn }; } return null; }
  // The foot of one turn (Answer Card): Copy and Regenerate on the left, which model said it, Collapse or Expand, Delete.
  // Icons, each with its name under it on hover; Regenerate has none, because hovering it opens the selector instead.
  // `raw` is set when the answer's closing line is this foot; an answer without one (a run that failed) gets the same foot.
  // `plain`: an @brainstorm or @discover turn, whose Regenerate asks again on its one model, with no selector (BS-08).
  // `edit` (2026-10-03): Edit beside Regenerate, which makes the question editable in place (startEdit).
  footHtml({ raw, q, text, folded, closes, plain = false, edit = false }) {
    const wrap = (inner, extra = '') => `<span style="flex:none;position:relative;display:inline-flex;${extra}">${inner}</span>`;
    const tip = (label, side) => `<span class="bart-tip" style="${side}:0">${label}</span>`;
    const copied = this.copied === `bart${q}`;
    return `<div ${raw || ''} contenteditable="false" data-readonly="1" data-foot="${q}" style="user-select:none;cursor:default;display:flex;align-items:center;gap:4px;padding:8px 12px 10px;background:#fafafa;border-radius:${radius(false, closes)};margin-bottom:${closes ? '14px' : '0'}">`
      + wrap(`<button class="bart-ic" data-act="copybart" data-turn="${q}" aria-label="Copy" ${copied ? 'style="color:#8f8f8f"' : ''}>${ICON.copy}</button>${tip(copied ? 'Copied' : 'Copy', 'left')}`)
      + wrap(plain ? `<button class="bart-ic" data-act="regen" data-plain="1" data-turn="${q}" aria-label="Regenerate">${ICON.regenerate}</button>${tip('Regenerate', 'left')}` : `<button class="bart-ic" data-act="regen" data-turn="${q}" aria-label="Regenerate" aria-haspopup="dialog">${ICON.regenerate}</button>`, edit ? '' : 'margin-right:auto;')
      + (edit ? wrap(`<button class="bart-ic" data-act="editturn" data-turn="${q}" aria-label="Edit">${ICON.edit}</button>${tip('Edit', 'left')}`, 'margin-right:auto;') : '')
      + `<span class="t" style="flex:0 1 auto;min-width:0;margin-right:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px/1.6 var(--font-sans);color:#8f8f8f">${esc(text || '')}</span>`
      + wrap(`<button class="bart-ic" data-act="fold" data-turn="${q}" aria-label="${folded ? 'Expand' : 'Collapse'}" aria-expanded="${!folded}">${folded ? ICON.expand : ICON.collapse}</button>${tip(folded ? 'Expand' : 'Collapse', 'right')}`)
      + wrap(`<button class="bart-ic" data-danger="1" data-act="dropturn" data-turn="${q}" aria-label="Delete">${ICON.trash}</button>${tip('Delete', 'right')}`)
      + '</div>';
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
  // The field that asks a follow-up, closing the card: `@bart`, the text, and one pill with the model and a round send.
  // What is typed is not in this string (restoreFollow puts it back), so typing never redraws the editor.
  // After an @brainstorm or @orient recap the field asks that agent again, on its one model: no chip, and it may be sent empty. After
  // an @discover guide it asks @discover for more, which needs words.
  followHtml(ls, thread) {
    const { step } = this.followStep(ls, thread), from = thread.from;
    const agent = agentOf(parseLine(ls[thread.turns[thread.turns.length - 1].q]));
    if (FOLLOW[agent]) {
      const { placeholder, label, empty } = FOLLOW[agent];
      return `<div contenteditable="false" data-followup="${from}" style="user-select:none;display:flex;align-items:flex-start;gap:10px;padding:22px 16px 18px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px">`
        + `<span style="flex:none;color:#0070f3;font-weight:500;font-size:16px;line-height:24px">@${agent}</span>`
        + `<textarea data-follow-input="${from}" data-agent="${agent}"${empty ? ' data-empty="1"' : ''} rows="1" placeholder="${esc(placeholder)}" aria-label="${esc(label)}" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;display:block;height:24px;margin:0;padding:0;border:0;background:none;outline:none;resize:none;overflow:hidden;font:16px/1.5 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text"></textarea>`
        + `<button class="bart-send" data-act="sendfollow" data-thread="${from}" aria-label="Send" style="flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:${empty ? '#0070f3' : '#f2f2f2'};color:${empty ? '#fff' : '#8f8f8f'};cursor:pointer">${ICON.send}</button>`
        + '</div>';
    }
    const open = !!(this.state.picker && this.state.picker.kind === 'follow' && this.state.picker.i === from);
    // A textarea one line tall that grows as it wraps, as the @bart line above it does (2026-09-22); the question is still
    // one line of the document, so Enter sends and a pasted line break becomes a space. The chip sits on the first line.
    return `<div contenteditable="false" data-followup="${from}" style="user-select:none;display:flex;align-items:flex-start;gap:10px;padding:22px 16px 18px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px">`
      + '<span style="flex:none;color:#0070f3;font-weight:500;font-size:16px;line-height:24px">@bart</span>'
      + `<textarea data-follow-input="${from}" rows="1" placeholder="Respond…" aria-label="Ask a follow-up" spellcheck="false" autocomplete="off" style="flex:1;min-width:0;display:block;height:24px;margin:0;padding:0;border:0;background:none;outline:none;resize:none;overflow:hidden;font:16px/1.5 var(--font-sans);color:#171717;user-select:text;-webkit-user-select:text"></textarea>`
      + `<span data-chip="f${from}" style="flex:none;position:relative;display:inline-flex;margin-top:-6px"><span class="bart-chip" data-act="pickfollow" data-thread="${from}" role="button" aria-haspopup="dialog" aria-expanded="${open}" style="display:inline-flex;align-items:center;gap:6px;padding:5px 6px 5px 12px;border:1px solid ${open ? '#c9c9c9' : '#eaeaea'};border-radius:999px;background:#fff;cursor:pointer;font:13px/1 var(--font-sans);color:#171717">`
      + (step ? `<span>${esc(step.name)} ${esc(EFFORT_LABELS[step.effort] || step.effort)}</span>${ICON.chevron}<span style="width:1px;height:14px;background:#eaeaea;margin:0 2px"></span>` : '')
      + `<button class="bart-send" data-act="sendfollow" data-thread="${from}" aria-label="Send" style="display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:#f2f2f2;color:#8f8f8f;cursor:pointer">${ICON.send}</button>`
      + '</span></span></div>';
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
  followField(from) { const ed = this.editorEl(); return ed ? ed.querySelector(`[data-follow-input="${from}"]`) : null; }
  // After a redraw, an @ menu open in a follow-up field hangs from the new field's caret; it closes when the field is gone
  // (its thread was asked again, folded or deleted) or did not take the keyboard back.
  followMenuRedrawn(menu) {
    const input = this.followField(menu.field);
    this.setState({ mention: input && document.activeElement === input ? { ...menu, anchor: fieldCaret(input) } : null });
  }
  // The field is as tall as its wrapped text.
  fitFollow(input) { input.style.height = 'auto'; input.style.height = `${Math.max(24, input.scrollHeight)}px`; }
  fitFollows = () => { const ed = this.editorEl(); if (ed) for (const input of ed.querySelectorAll('[data-follow-input]')) this.fitFollow(input); };
  paintSend(input) {
    const send = input.parentElement && input.parentElement.querySelector('[data-act="sendfollow"]'); if (!send) return;
    const ready = input.dataset.empty === '1' || !!input.value.trim(); send.style.background = ready ? '#0070f3' : '#f2f2f2'; send.style.color = ready ? '#fff' : '#8f8f8f';
  }
  editorHtml() {
    const ls = this.lines(), ps = this.parsedOf(ls), active = this.state.activeLine, at = this.layout(ls), editing = this.editing; let out = '', group = [];
    ls.forEach((line, i) => {
      const p = ps[i], where = at.get(i);
      // Under a question being edited (2026-10-03), its answer and the answer's foot are dimmed.
      const dim = !!editing && !!where && where.turn.q === editing.q && i !== editing.q, dimmed = (html) => (dim ? html.replace('<div ', '<div data-dim="1" ') : html);
      out += dimmed(this.lineHtml(i, line, p, active === i, p.type === 'todo' && !group.length, where, this.lockedAt(ls, i)));
      if (where && where.footAfter) out += dimmed(this.footHtml({ q: where.turn.q, text: '', folded: where.turn.folded, closes: where.tail && !where.followAfter, plain: oneModel(where.agent), edit: where.editable }));
      if (where && where.followAfter) out += this.followHtml(ls, where.thread);
      if (p.type === 'todo') group.push({ i, p });
      const next = ls[i + 1];
      if (p.type === 'todo' && (next == null || ps[i + 1].type !== 'todo')) { out += this.groupHtml(group); group = []; }
    });
    return out;
  }
  patchPending() {
    const ed = this.editorEl(); if (!ed || this.lastKey !== this.key()) return false;
    const ls = this.lines(), at = this.layout(ls);
    for (const d of ed.querySelectorAll('[data-pending]')) {
      const i = Number(d.dataset.line), p = parseLine(ls[i] ?? ''); if (p.type !== 'pending' || p.id !== d.dataset.pending) return false;
      const html = this.lineHtml(i, ls[i], p, false, false, at.get(i), true);
      if (html !== d.outerHTML) { const holder = document.createElement('div'); holder.innerHTML = html; if (holder.firstElementChild.outerHTML !== d.outerHTML) d.replaceWith(holder.firstElementChild); }
    }
    this.lastHtml = this.editorHtml(); return true;
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
    const field = document.activeElement, had = field && field.matches && field.matches('[data-follow-input]') && ed.contains(field) ? { key: field.dataset.followInput, a: field.selectionStart, b: field.selectionEnd }
      : field && field.matches && field.matches('[data-card-input]') && ed.contains(field) ? { card: true, key: field.dataset.cardInput, field: field.dataset.cardField, a: field.selectionStart, b: field.selectionEnd } : null;
    const buildField = field && field.matches && field.matches('[data-build-input]') && ed.contains(field) ? { key: field.dataset.buildInput, a: field.selectionStart, b: field.selectionEnd } : null;
    // A field of its own has the keyboard (a follow-up, a card's answer, a Build reply): the document has no caret to put
    // back. Taking one anyway (2026-09-30: a card's textarea sits in a line, so the selection read as that line) left it
    // set, and the next redraw focused the editor with it: typing in the card jumped the caret to the top of the document.
    if (had || buildField) this.caret = null;
    if (html === this.lastHtml && key === this.lastKey) {
      if (this.caret && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.applyCaret(); }
      this.wantFocus = false; return;
    }
    let c = had || buildField ? null : this.caret || (hadFocus ? this.caretInfo()?.anchor : null);
    if (!c && hadFocus && !had && !buildField && !ed.querySelector('[data-line]')) { const ls = this.lines(), last = ls.length - 1, p = parseLine(ls[last]); c = { line: last, offset: lineText(p, ls[last]).length }; }
    if (c && !this.caret) this.caret = c;
    // Read before the fields are replaced: taking a focused field out of the page may blur it, which closes the menu.
    const menu = this.state.mention && this.state.mention.field != null ? this.state.mention : null;
    this.syncing = true; ed.innerHTML = html; this.lastHtml = html; this.lastKey = key; this.restoreFollow(ed, had && !had.card ? had : null); this.restoreCards(ed, had); this.restoreBuilds(ed, buildField);
    if (menu) this.followMenuRedrawn(menu);
    if (c && !had && !buildField && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.caret = c; this.applyCaret(); }
    this.wantFocus = false; this.syncing = false;
  }
  // A selection made backwards (shift+←) is put back backwards, so the next shift+arrow moves the end being moved.
  applyCaret() { const c = this.caret; this.caret = null; if (!c) return; if (c.sel) { if (c.back) this.setSelection(c.line, c.sel[1], c.sel[0]); else this.setSelection(c.line, c.sel[0], c.sel[1]); } else this.setSelection(c.line, c.offset, c.offset); }
  posIn(t, offset) {
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); let node, rest = offset;
    while ((node = walker.nextNode())) { if (rest <= node.length) return { node, offset: rest }; rest -= node.length; }
    if (t.firstChild && t.firstChild.nodeName === 'BR') return { node: t, offset: 0 };
    const last = t.lastChild; return last && last.nodeType === 3 ? { node: last, offset: last.length } : { node: t, offset: t.childNodes.length };
  }
  setSelection(line, a, b) {
    const ed = this.editorEl(); if (!ed) return; const d = ed.querySelector(`[data-line="${line}"]`); const t = d && d.querySelector('.t'); if (!t) return;
    const s = this.posIn(t, this.rawToDisplay(t, a)), e = this.posIn(t, this.rawToDisplay(t, b));
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
    if (t && t.contains(n)) {
      const r = document.createRange(); r.selectNodeContents(t); r.setEnd(n, o); off = r.toString().replace(/\u200b/g, '').length;
      // A Try line's mark is drawn, not in the line: its words before the point are not counted.
      for (const mark of t.querySelectorAll('[data-repo-mark]')) if (!mark.contains(n) && r.intersectsNode(mark)) off -= mark.textContent.length;
    } else off = t ? t.textContent.length : 0;
    const isActive = Number(d.dataset.line) === this.state.activeLine;
    let raw = null;
    if (t && (isActive || t.querySelector('[data-src]'))) raw = this.displayToRaw(t, off);
    if (raw == null) {
      // Code shows its own characters; a fence shown as its language puts the caret at the end of the fence.
      const line = d.dataset.raw || '', kind = d.dataset.kind, p = parseLine(line);
      raw = isActive || kind === 'code' ? off : kind === 'fence' ? lineText(p, line).length : p.type === 'img' ? 0 : p.type === 'reply' ? replyRawOffset(p, off) : rawOffset(p, off, line);
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
    const line = ls[c.anchor.line] ?? '', p = this.parsedOf(ls)[c.anchor.line] || parseLine(line), key = p.type === 'img' || isCode(p) || isFence(p) ? '' : this.openIdx(tokensOf(p, line), a, b).join(',');
    if (key !== this.openKey) { this.caret = { line: c.anchor.line, sel: [a, b], back }; this.forceUpdate(); }
  }
  editorInput = () => {
    const ed = this.editorEl(); if (!ed || this.composing) return; const old = this.lines(), psOld = this.parsedOf(old);
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
      const raw = d.dataset.raw ?? ''; if (Number(d.dataset.line) !== activeId) return raw;
      const p = psOld[Number(d.dataset.line)] || parseLine(raw); if (this.lockedAt(old, Number(d.dataset.line))) return raw;
      const t = d.querySelector('.t'); let txt = t ? this.activeRaw(t) : '';
      if (p.type === 'h' && Number(d.dataset.line) !== this.state.activeLine && !/^#{1,3} /.test(txt)) txt = raw.slice(0, p.level + 1) + txt;
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
    // question with it: those the browser removed are put back where they stood. The one deletion that may take answer
    // lines is one made inside a single answer, where its text is the person's to edit.
    const kept = new Map(divs.map((d) => [Number(d.dataset.line), d]));
    const span = this.selRaw && this.selRaw.multi ? this.selRaw.lines : null, inside = !!span && psOld.slice(span[0], span[1] + 1).every((q) => q.type === 'reply');
    let ls = [], pos = -1, restored = false;
    old.forEach((rawLine, j) => {
      const d = kept.get(j);
      if (!d) { if (this.lockedAt(old, j) || (psOld[j].type === 'reply' && !inside)) { ls.push(rawLine); restored = true; } return; }
      if (j === activeId) pos = ls.length;
      ls.push(textOf(d));
    });
    if (!ls.length || (strayText && this.endsOnCard(ls))) ls.push('');
    if (restored) this.lastHtml = null;
    let caret = c && pos >= 0 ? { line: pos, offset: c.anchor.offset } : null;
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
      const p = parseLine(ls[pos] ?? ''), txt = lineText(p, ls[pos]), m = inCode ? null : mentionAt(txt, caret.offset);
      if (m) {
        const anchor = this.caretRect();
        this.setState({ activeLine: pos, mention: { i: pos, query: m.query, start: m.start, caret: caret.offset, anchor }, mentionIdx: 0 });
      } else this.setState((s) => (s.mention || s.activeLine !== pos ? { mention: null, activeLine: pos } : null));
    }
  };
  editorKey = (e) => {
    if (this.state.picker) this.closePicker();
    const s = this.state, c = this.caretInfo(); if (!c) return; const ls = this.lines();
    const ps = this.parsedOf(ls), i = c.anchor.line, line = ls[i] ?? '', p = ps[i] || parseLine(line), cur = lineText(p, line), mod = e.metaKey || e.ctrlKey;
    const same = c.anchor.line === c.focus.line, a = Math.min(c.anchor.offset, c.focus.offset), b = Math.max(c.anchor.offset, c.focus.offset), collapsed = same && a === b;
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
      e.preventDefault(); const q = ps[i + 1]; if (this.lockedAt(ls, i + 1)) return; const nt = lineText(q, ls[i + 1]);
      if ((isFence(p) || isFence(q)) && cur !== '' && nt !== '') return;
      this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, cur + nt); out.splice(i + 1, 1); return out; }, { line: i, offset: cur.length });
      return;
    }
    if (e.key === 'Escape') { const ed = this.editorEl(); if (ed) ed.blur(); }
  };
  // Pasted images are saved by the parent (library + <project>/assets) and referenced as ![Attachment n](img:<id>):
  // inline in a todo or chat line, where it reads [Attachment n]; on its own line anywhere else, where it renders.
  async pasteImages(files, at) {
    for (const file of files) {
      const n = (String(this.props.text ?? '').match(/\]\(img:/g) || []).length + 1;
      let saved;
      try { saved = await this.props.onPasteImage(file, `Attachment ${n}`); } catch { saved = null; }
      if (!saved || !saved.id || !this.mounted) continue;
      const token = `![Attachment ${n}](img:${saved.id})`;
      const ls = this.lines(), i = Math.min(at.line, ls.length - 1), line = ls[i] ?? '', p = parseLine(line);
      if (isMarked(p.type) || p.type === 'bart' || p.type === 'reply') {
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
  editorPaste = (e) => {
    const c = this.caretInfo(); if (!c) return;
    const pasted = [...(((e.clipboardData || {}).files) || [])].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (pasted.length && this.props.onPasteImage) { e.preventDefault(); void this.pasteImages(pasted, { line: c.anchor.line, offset: Math.min(c.anchor.offset, c.focus.offset) }); return; }
    e.preventDefault();
    const data = e.clipboardData || window.clipboardData;
    let text = (data.getData('text/plain') || '').replace(/\r/g, ''); if (!text) return;
    const ls = this.lines(), i = c.anchor.line, line = ls[i] ?? '', p = this.parsedOf(ls)[i] || parseLine(line), cur = lineText(p, line);
    // Copied from a web page (2026-10-02), the plain text has each link's title only: the page's HTML gives the addresses
    // back. A copy from this editor already holds its links as markdown, and code takes what was copied as it is.
    const html = text.includes('](') || isCode(p) || isFence(p) ? '' : data.getData('text/html');
    if (html) text = withLinks(text, [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('a[href]')].map((a) => ({ text: a.textContent, href: a.getAttribute('href') })));
    const same = c.anchor.line === c.focus.line, a = same ? Math.min(c.anchor.offset, c.focus.offset) : c.anchor.offset, b = same ? Math.max(c.anchor.offset, c.focus.offset) : a;
    const parts = text.split('\n');
    if (parts.length === 1) { this.writeText(i, cur.slice(0, a) + text + cur.slice(b), { line: i, offset: a + text.length }); return; }
    // A question is one line (2026-10-02): several lines pasted into an @bart, @brainstorm or @discover line that can still
    // be asked join into it, and so does a paste that starts one on an empty line. Anywhere else the lines stay lines.
    const asks = (!!this.editing && this.editing.q === i) || (p.type === 'bart' ? !this.lockedAt(ls, i) : p.type === 'p' && !line && BART_RE.test(parts[0].trimStart()));
    if (asks) { const flat = flattenPaste(text); this.writeText(i, cur.slice(0, a) + flat + cur.slice(b), { line: i, offset: a + flat.length }); return; }
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
    if (cut && !this.props.readOnly) { this.bulkDelete = true; document.execCommand('delete'); this.bulkDelete = false; }
  }
  editorClick = (e) => {
    // The editor's own empty space below the last line. A drag from one line to another also ends here (2026-10-02: Chromium
    // clicks what holds both ends), and putting the caret at the end lost its highlight.
    if (e.target === this.editorEl()) { if (this.downOnRoot && getSelection().isCollapsed) { this.cancelEdit(); this.focusEnd(); } return; }
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
      if (k === 'pickfollow') { this.openPicker(act, 'follow'); return; }
      if (k === 'sendfollow') { this.closePicker(); this.sendFollow(Number(act.dataset.thread)); return; }
      if (k === 'discoverlook') { this.closePicker(); this.recapLook(i); return; }
      if (k === 'cardlook') { this.closePicker(); this.cardLook(Number(act.dataset.turn)); return; }
      if (k === 'papersave') { if (!act.disabled) this.savePaper(i); return; }
      if (k === 'regen') { this.closePicker(); const q = Number(act.dataset.turn); this.regenerate(q, act.dataset.plain ? undefined : this.ranWith(this.lines(), q).choice); return; }
      if (k === 'editturn') { this.closePicker(); this.startEdit(Number(act.dataset.turn)); return; }
      if (k === 'cardopt') { this.pickCard(Number(act.dataset.turn), Number(act.dataset.opt)); return; }
      if (k === 'cardsend') { this.sendCard(Number(act.dataset.turn)); return; }
      if (k === 'cardskip') { this.sendCard(Number(act.dataset.turn), 'skip'); return; }
      if (k === 'cardwrap') { this.sendCard(Number(act.dataset.turn), 'wrap'); return; }
      if (k === 'fold') { this.toggleFold(Number(act.dataset.turn)); return; }
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
      if (k === 'stopask') { if (this.props.onStopAsk) this.props.onStopAsk(act.dataset.ask); return; }
      if (k === 'toggle') this.toggleTodo(i);
      else if (k === 'remove') this.removeLine(i);
      return;
    }
    const a = e.target.closest('a[data-link]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href'), row = a.closest('[data-line]'), sections = row ? this.linkSections(Number(row.dataset.line), href) : null;
      const options = { ...(newTabClick(e) ? { newTab: true } : {}), ...(sections ? { sections } : {}) };
      this.openLink(href, Object.keys(options).length ? options : undefined);
      if (row) this.tryRepo(Number(row.dataset.line), href);
      return;
    }
    const m = e.target.closest('[data-mention]');
    if (m && m.dataset.ws) { e.preventDefault(); this.hidePop(); if (this.props.onOpenWorkspace) this.props.onOpenWorkspace(m.dataset.ws); return; } // goes there: one workspace at a time
    if (m) {
      e.preventDefault(); this.hidePop(); const nm = m.dataset.mention; if (nm.startsWith('bart')) return;
      const res = this.findRes(nm); if (res.id !== '?' && this.props.onOpenItem) this.props.onOpenItem(res);
    }
  };
  editorOver = (e) => {
    const m = e.target.closest('[data-mention]'); if (m) this.showPop(m.dataset.ws ? { ws: m.dataset.ws, name: m.dataset.mention } : this.findRes(m.dataset.mention), { currentTarget: m });
    // An icon's name goes under it, or above it when under would leave the pane.
    const ic = e.target.closest('.bart-ic'), box = this.scrollRef.current;
    if (ic && ic.parentElement && box) ic.parentElement.toggleAttribute('data-tip-up', ic.getBoundingClientRect().bottom + 32 > Math.min(box.getBoundingClientRect().bottom, window.innerHeight || 800));
    const pick = e.target.closest('[data-act="pick"],[data-act="pickfollow"],[data-act="regen"]:not([data-plain])'); if (pick) this.openPicker(pick, { pick: 'line', pickfollow: 'follow', regen: 'regen' }[pick.dataset.act]);
  };
  // Leaving what opened the selector starts its closing clock, unless the pointer went straight onto the selector: React has
  // by then already handled that same event (the selector's onMouseEnter stops the clock), and this would start it again.
  editorOut = (e) => {
    if (e.target.closest('[data-mention]')) this.hidePop();
    const onto = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-bart-picker]');
    if (!onto && e.target.closest('[data-act="pick"],[data-act="pickfollow"],[data-act="regen"]')) this.leavePicker();
  };
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
  // An @brainstorm, @orient or @discover line may be asked with nothing after it: it starts from the workspace (@orient asks for a subject).
  askInline(i) {
    if (this.editing && this.editing.q === i) { this.commitEdit(); return; } // an edited question is asked again, not under its answer
    const ls = this.lines(), p = parseLine(ls[i] || ''), agent = agentOf(p);
    if (p.type !== 'bart' || (!p.text.trim() && !oneModel(agent)) || !this.props.onAsk || this.lockedAt(ls, i)) return;
    const askId = newAskId(), add = [`bart~> ${askId}`]; if (i + 1 >= ls.length) add.push('');
    const turns = this.turnsBefore(ls, i);
    this.setLines((x) => { const out = [...x]; out.splice(i + 1, 0, ...add); return out; });
    const ed = this.editorEl(); if (ed) ed.blur(); this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: p.text.trim(), turns, agent });
  }
  // The turns of the card above question `q`, as the document holds them: what a follow-up is a follow-up to.
  turnsBefore(ls, q) {
    const found = this.findTurn(ls, q); if (!found) return [];
    return found.thread.turns.filter((turn) => turn.q < q && turn.answered && !turn.pending).map((turn) => turnText(ls, turn));
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
  // A follow-up: the question goes under the card's last answer as an @bart line of its own, with the pending line under it.
  // It asks what the card's last turn asked: @bart, @brainstorm or @orient after a recap (which may be sent with nothing typed), or
  // @discover after a guide.
  sendFollow(from) {
    const ls = this.lines(), thread = threads(ls).find((t) => t.from === from), typed = (this.followText.get(from) || '').trim();
    if (!thread || !this.props.onAsk) return;
    const end = thread.turns[thread.turns.length - 1], agent = agentOf(parseLine(ls[end.q])); if (!end.answered || end.pending || (!typed && !(FOLLOW[agent] && FOLLOW[agent].empty))) return;
    // A pasted image goes into the line as its [Attachment n] token stood; one whose token was deleted is not sent.
    const text = withAttachments(typed, this.followImages.get(from) || []);
    const { flags } = this.followStep(ls, thread), asked = [flags, text].filter(Boolean).join(' ');
    const askId = newAskId(), add = [`@${agent} ${asked}`.trimEnd(), `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const turns = thread.turns.filter((turn) => turn.answered && !turn.pending).map((turn) => turnText(ls, turn));
    this.followText.delete(from); this.followImages.delete(from);
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    this.setLines((x) => { const out = [...x]; out.splice(thread.to + 1, 0, ...add); return out; });
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: asked, turns, agent });
  }
  // While the field's @ menu shows, the arrows move in it, Enter or Tab puts the row in and Escape closes it alone; Enter
  // sends, and Escape leaves the field, once it is closed.
  followKey(e) {
    if (this.state.picker) this.closePicker();
    const m = this.state.mention, items = m && m.field === Number(e.target.dataset.followInput) ? this.mentionList() : [];
    if (items.length) {
      const n = items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx + 1) % n }); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx - 1 + n) % n }); return; }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing) { e.preventDefault(); this.pickMention(items[this.state.mentionIdx] || items[0]); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.setState({ mention: null }); return; }
    }
    if (e.key === 'Enter' && e.shiftKey) e.preventDefault(); // one line of the document: no line breaks
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.sendFollow(Number(e.target.dataset.followInput)); }
    else if (e.key === 'Escape') e.target.blur();
  }
  followInput(input) {
    if (/[\r\n]/.test(input.value)) { const a = input.selectionStart, b = input.selectionEnd; input.value = input.value.replace(/[\r\n]/g, ' '); input.setSelectionRange(a, b); }
    this.followText.set(Number(input.dataset.followInput), input.value); this.paintSend(input); this.fitFollow(input);
    this.followMention(input);
  }
  // The @ menu in a follow-up field (2026-10-02): opened, narrowed or closed by what stands before the field's caret, as
  // on a document line, and hung from that caret. It is the menu's `field` form: the thread's first line, and no line `i`.
  followMention(input) {
    const from = Number(input.dataset.followInput), caret = input.selectionStart, found = mentionAt(input.value, caret), open = this.state.mention;
    if (found) this.setState({ mention: { field: from, query: found.query, start: found.start, caret, anchor: fieldCaret(input, caret) }, mentionIdx: 0 });
    else if (open && open.field === from) this.setState({ mention: null });
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
    const [name, effort] = found.turn.foot >= 0 ? parseLine(ls[found.turn.foot]).text.slice(1, -1).split(' · ') : [];
    for (const [provider, entry] of Object.entries(models.providers)) {
      for (const [key, model] of Object.entries(entry.models)) if (model.name === name && effortOf(effort)) return { current: { provider, model: key, effort: effortOf(effort) }, choice: { model: key, effort: effortOf(effort) } };
    }
    const step = readQuestion(parseLine(ls[q]).text, models).steps[0];
    return { current: { provider: step.provider, model: step.key, effort: step.effort }, choice: undefined };
  }
  // Regenerate: the answer gives way to a pending line and the question is asked again, as a follow-up to the turns above
  // it. `choice` is a model and effort for this run; the line keeps the words it was asked with. `edited` (2026-10-03): a
  // question edited in place is asked from { lines } (its new words, the turns after it gone), and undo goes to { undo }.
  regenerate(q, choice, edited = null) {
    const ls = edited ? edited.lines : this.lines(), found = this.findTurn(ls, q); if (!found || found.turn.pending || !this.props.onAsk) return;
    const { turn } = found, p = parseLine(ls[q]), agent = agentOf(p); if (!p.text.trim() && !oneModel(agent)) return;
    const askId = newAskId(), gone = turn.to - turn.q, turns = this.turnsBefore(ls, q);
    this.cardState.delete(q);
    const asked = (x) => { const out = [...x]; out.splice(turn.from, gone, `bart~> ${askId}`); return out; };
    if (edited) this.setDoc(asked(ls).join('\n'), undefined, edited.undo); else this.setLines(asked);
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: p.text.trim(), turns, agent, choice: choice && this.props.models && modelOf(choice.model, this.props.models) ? choice : undefined });
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
    const p = parseLine(line), agent = agentOf(p), found = this.findTurn(ls, q);
    if (p.type !== 'bart' || agent !== agentOf(parseLine(was.original)) || buildRequestOf({ agent, text: p.text }) || (!p.text.trim() && !oneModel(agent))) return;
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
  // Collapse all / Expand all (2026-09-29): every answer in the document at once, folded as each card's own Collapse
  // folds it. A run still at work is left as it is.
  foldable(ls) { return threads(ls, this.parsedOf(ls)).flatMap((thread) => thread.turns).filter((turn) => turn.answered && !turn.pending); }
  foldAll(to) {
    const turns = this.foldable(this.lines()); if (!turns.length) return;
    const under = (j) => turns.some((turn) => j >= turn.from && j <= turn.to);
    this.setLines((x) => x.map((l, j) => { if (!under(j)) return l; const p = parseLine(l); return p.type === 'reply' && p.folded !== to ? replyLine(p.text, to).trimEnd() : l; }));
    this.setState({ activeLine: null, mention: null });
  }
  // Delete: this turn leaves the document, its question and its answer; the turns around it stay. A run still at work is stopped.
  deleteTurn(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return;
    const { turn } = found, n = turn.to - turn.q + 1;
    if (turn.pending && this.props.onStopAsk) this.props.onStopAsk(turn.pending);
    this.setLines((x) => { const out = x.filter((_, j) => j < turn.q || j > turn.to); return out.length ? out : ['']; });
    this.setState({ activeLine: null, mention: null });
  }
  // Copy: the question as asked (no flags) and the answer as written (no prefixes, no closing line).
  copyText(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return '';
    const { question, answer } = turnText(ls, found.turn);
    return [this.props.models ? readFlags(question, this.props.models).rest : question, answer].filter(Boolean).join('\n\n');
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
  }
  leavePicker = () => { clearTimeout(this.pickerT); this.pickerT = setTimeout(() => { if (this.mounted) this.closePicker(); }, 220); };
  stayPicker = () => clearTimeout(this.pickerT);
  closePicker() { clearTimeout(this.pickerT); if (this.state.picker) this.setState({ picker: null }); }
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
    const ls = this.lines(), p = parseLine(ls[pk.i] || ''); if (p.type !== 'bart' || agentOf(p) !== 'discover' || this.lockedAt(ls, pk.i)) { this.closePicker(); return; }
    const plain = readDiscover('', models, this.turnsBefore(ls, pk.i)), text = withMode(p.text, mode, models, { mode: plain.mode, provider: plain.provider }, provider || plain.provider);
    // With no question yet, a space after the flag, so what is typed next is the question ("@discover " alone has its own).
    const line = `${leadOf(ls[pk.i], 'discover')} ${text}${text && !readDiscover(text, models).question ? ' ' : ''}`;
    this.setLines((x) => x.map((l, j) => (j === pk.i ? line : l)), this.state.activeLine === pk.i ? { line: pk.i, offset: line.length } : undefined);
  };
  sendPicked = () => {
    const pk = this.state.picker; if (!pk || pk.kind !== 'regen') return;
    const choice = pk.choice || this.ranWith(this.lines(), pk.i).choice; this.closePicker(); this.regenerate(pk.i, choice);
  };

  /* ---------------------------------------------------------------- operations */
  bartItem() { return (this.props.mentionable || []).find((r) => r && r.id === 'bart') || BART_ITEM; }
  mentionList() {
    const m = this.state.mention, q = (m?.query || '').toLowerCase();
    const rows = this.props.mentionItems ? this.props.mentionItems(q) // the workspace's list: Bart, Note, the open page, the library (model/rail.js)
      : (this.props.mentionable || []).filter((r) => r && ((r.name || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)));
    return m && m.field != null ? fieldRows(rows) : rows; // a follow-up field already asks its thread's agent: no verbs
  }
  pickMention(r) {
    const m = this.state.mention; if (!m || !r) return;
    if (m.field != null) { this.pickInField(m, r); return; }
    const ls = this.lines(), p = parseLine(ls[m.i] || '');
    const cur = lineText(p, ls[m.i]);
    const verb = r.kind === 'verb' ? r.verb : r.id === 'bart' || r.id === 'brainstorm' || r.id === 'orient' || r.id === 'discover' ? r.id : null;
    // Bart, Brainstorm, Orient, Discover and Note are words the line keeps (Enter asks, or makes the note); anything else is a mention, and
    // what it names comes into this workspace (the open page is added to the library first: props.onMentionPicked). A verb
    // is followed by a space, since a question comes next; a mention is not (MATH-11, 2026-10-05): the caret stops right after it.
    const ins = verb === 'bart' ? '@Bart ' : verb === 'brainstorm' ? '@Brainstorm ' : verb === 'orient' ? '@Orient ' : verb === 'discover' ? '@Discover ' : verb === 'note' ? '@Note ' : r.kind === 'workspace' ? wsMention(r.name, r.id) : `@[${r.name}]`;
    this.writeText(m.i, cur.slice(0, m.start) + ins + cur.slice(m.caret), { line: m.i, offset: m.start + ins.length });
    this.wantFocus = true; this.setState({ mention: null, activeLine: m.i });
    if (!verb && r.kind !== 'workspace' && this.props.onMentionPicked) this.props.onMentionPicked(r); // a workspace is not a library row
  }
  // A row picked in a follow-up field: the token a document line would get takes the place of `@query`, the keyboard stays
  // in the field, and followInput keeps what it holds and its send button. Sent, it is a mention on the new line.
  pickInField(m, r) {
    const input = this.followField(m.field);
    this.setState({ mention: null });
    if (!input || isVerbRow(r)) return;
    const ins = r.kind === 'workspace' ? wsMention(r.name, r.id) : `@[${r.name}]`;
    const end = Math.min(m.caret, input.value.length), start = Math.min(m.start, end);
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    input.setRangeText(ins, start, end, 'end');
    this.followInput(input);
    if (r.kind !== 'workspace' && this.props.onMentionPicked) this.props.onMentionPicked(r);
  }
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
  findRes(name) {
    const n = String(name).toLowerCase(); if (n.startsWith('bart')) return this.bartItem();
    return (this.props.mentionable || []).find((r) => r && r.id !== 'bart' && (r.name || '').toLowerCase() === n)
      || { id: '?', type: 'note', name, title: name, summary: 'Not attached to this topic yet.', facts: 'unresolved' };
  }
  showPop(res, e) { const r = e.currentTarget.getBoundingClientRect(); this.setState({ pop: { res, anchor: { left: r.left, right: r.right, top: r.top, bottom: r.bottom } } }); }
  hidePop = () => { if (this.state.pop) this.setState({ pop: null }); };

  /* ---------------------------------------------------------------- render */
  pickerView() {
    const pk = this.state.picker, models = this.props.models; if (!pk || !models) return null;
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
    const answers = compact || this.props.readOnly ? [] : this.foldable(this.lines()), anyOpen = answers.some((turn) => !turn.folded);
    // Compact (a post-it, 2026-09-22) never scrolls: it is as tall as its lines, and the card fits the type to its size.
    return (
      <>
        <style>{RISE_CSS + CARD_CSS}</style>
        {/* Past the last line the page keeps going for about half a window (2026-09-22), so the end of a document can be read and written mid-screen. */}
        <div ref={this.scrollRef} onClick={this.docClick} onScroll={this.onScroll} onWheel={this.stopSettling} onPointerDown={this.stopSettling} onKeyDown={this.stopSettling} style={compact ? { flex: 'none', overflow: 'visible', padding: '0 0 2px', cursor: 'grab' } : { flex: 1, minHeight: 0, overflow: 'auto', padding: '28px clamp(12px, 4%, 40px) max(120px, calc(50vh - 40px))', cursor: 'text' }}>
          <div style={{ maxWidth: compact ? 'none' : '65ch', marginInline: 'auto', paddingInline: compact ? 0 : 'clamp(0px, 3%, 24px)', cursor: 'auto', fontSize: 17 }}>
            {this.props.header}
            <div
              data-editor="1"
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
            is a strip of its own under the page ("the text editor stops above these buttons"), no longer floating over it. */}
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
        {s.mention && s.mention.anchor && <MentionMenu items={this.mentionList()} index={s.mentionIdx} anchor={s.mention.anchor} onPick={(r) => this.pickMention(r)} onHover={(i) => this.setState({ mentionIdx: i })} />}
        {s.pop && (s.pop.res.ws ? <WorkspacePeek id={s.pop.res.ws} name={s.pop.res.name} anchor={s.pop.anchor} peek={this.props.workspacePeek} /> : <Popover item={s.pop.res} anchor={s.pop.anchor} />)}
        {this.pickerView()}
      </>
    );
  }
}
