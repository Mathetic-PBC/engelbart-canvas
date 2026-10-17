// PaperView — the "Paper" pane: a PDF drawn page by page with pdf.js, each page one white
// sheet, rough.js zigzag highlights and Caveat handwritten notes. Port of
// the design's syncPdf / pdfMouseUp / freeWidth / pendingSelKey / addMark / renderMarks
// (design/goal-canvas/Goal Canvas.dc.html lines 516–602), with two changes: marks are stored in
// page units (fractions of the page's drawn width) so they survive a re-layout at another zoom,
// and the document is parsed once and only re-laid-out on zoom or resize.
// Zoom follows the "Stage" design (Add - Mention Stage.dc.html, 2026-09-23), with 100% = fit width
// (Hudson, 2026-09-23: "I want fit width for 100%"): at 100% the first page is exactly as wide as the
// pane, and every zoom is that width times the percentage, so a resized pane keeps its zoom and
// redraws. Pages are centered with no gutter of their own; a floating bar at the bottom shows the
// page and zoom; a pinch (or ⌘ / ⌃ scroll) zooms around the pointer.
// `target` (2026-09-30): a passage a link asked for. Once every page's text is drawn it is found from page 1, scrolled to and
// shown as a section (showSection), and told through onTarget(text, result); once per target, until the prop is cleared
// and given again. Nothing matching leaves the scroll where it is. `targetTo` (@discover round 2): the first words of the
// section after it; the stretch from the passage to just before them, up to six pages on, is tinted (SECTION), else the
// passage alone is. The section is find's no longer (2026-10-03, the Stage's Sections menu): it stays while find
// searches and stops, until another is shown or clearSection(). `initialSection` { find, to }: the section to show the
// same way when the viewer opens with no target (a tab with a guide's sections come to the front again). Never ink.
// A margin note mentions library items (MATH-21, 2026-10-05): `@` in it opens the @ menu (`mentionItems`, the workspace's
// list, of which only library rows are kept, and Bart at the start of a highlight's note: MATH-27), and a pick writes
// `@[Name](lib:<id>)` into the note (model/doc.js libMention).
// A note no one is typing in is shown as text (`data-note-view`), its mentions links: a click on one is
// `onOpenMention(id)`, a click anywhere else in it gives the note its field back, the caret where it was clicked. Its
// names are the library's now (`library`), so a renamed item shows its new name; one gone from the library is grey. With
// no `onOpenMention` a note is its field alone, as before: the token reads as typed.
// A library folder in the note's @ menu opens in place (MATH-22, with `listFolder`), as in a document, and a file in it is
// written `@[Name](lib:<folderId>:<path>)` (model/doc.js fileMention): its chip is clicked to `onOpenFile({ folderId,
// rel, name })`, and drawn grey when `fileState(folderId, rel)` says it is gone.
// The page as a canvas (MATH-27 phase 1, 2026-10-06; the pure parts are ./canvas.js). Until 2026-10-16 every page lay on a
// desk at least DESK desk px wide each side, that a box moved past its edge widened, and the pane scrolled onto it.
// Every note was a box with a grip (no border, 2026-10-06; neither since 2026-10-16): a highlight's note opens beside it (its `side`), a double-click on blank
// space made a free note there (a click again since 2026-10-16), and dragging the grip moved either (`pos`, page units, saved on drop); a click in its text edits it. Each
// answer Bart gave from a highlight's note (`asks`) is a box under the note, joined by a short line, moved the same way.
// Boxes that were not moved are spaced on every draw (canvas.js spaceBoxes), never saved. A note on a highlight that
// starts with @bart asks on Enter (`onAsk`; Shift+Enter is a new line), and a second one continues the exchange (its
// `asks` go as the turns). An answer being written (`pendingAsks`, the workspace's) is a box of its own until it lands
// (`addAsk`, from the Stage). Space-drag or a middle-drag panned and a fade said where boxes were out of view, until
// 2026-10-16. Since 2026-10-07 (David) there is no chip ("2 notes →"), and the bar has no Fit page or Fit page + notes.
// Follow-ups (2026-10-06): the boxes hanging under a moved one widened the desk as it did, while it was
// dragged too; @bart from a part of a selection across pages sends the whole passage (./marks.js passageOf), and so does
// Continue in workspace; a deleted answer comes back with ⌘Z (undoKey) and stays a turn of its exchange, so the next
// question goes on in the same session (canvas.js exchangeOf); ⌘Z and a pending selection's keys are the paper's only
// while nothing has the keyboard (keyFree).
// Second pass (2026-10-06): a box being written is filled in place as Bart works (fillRun), its Stop and "▸ steps" the
// same buttons throughout, so a click on one is not lost to the next tick; an answer that is here already is not added
// again (addAsk: main tells every window how an ask ended, the one that asked too).
// A true canvas (MATH-27 follow-up, 2026-10-06): what is drawn on the desk scales with the page. Boxes and the
// lines joining them are laid out in desk px (./canvas.js: the px of 100%) on each sheet's notes layer, and
// that layer is scaled by the page's zoom (`k`, geo[n].k: the layout's zoom), so at 200% a note is 480px wide, its
// type twice as big and its gap from the page twice as wide, and a box keeps its place against the page's text at every
// zoom, moved or not. A pinch scales what is drawn, and the layout that follows leaves every box where the pinch left it;
// a free note keeps the width it was written with (`w`; one from before, the width it was measured at, freeW). The zoom
// bar and the @ menu stay screen-sized.
// One card a highlight (MATH-27 follow-up, 2026-10-06): a highlight's note and Bart's answers to it are one card, like a
// comment thread, one width throughout: the note at the top, then each answer and each answer being written, room between
// them (a thin divider until 2026-10-16; cardBox). Nothing joins them now. The card moves as one (the mark's `pos`); an answer moved on
// its own before is shown in its card, its `pos` no longer read. An answer's grey question shows only when it is not what
// the note asks now (canvas.js askedByNote). A question carries the page's text around the passage (pageTextAround), a
// selection snaps out to whole words (snapWords), and a card leaves its highlight's margin only as a last resort
// (marks.js NOTE_SLACK).
// Blank space and @bart (MATH-27 follow-up, 2026-10-06): until 2026-10-16 a drag from blank space panned and a
// double-click wrote a free note (now a click writes one, a drag selects, as before MATH-27). A free note left empty goes
// when it loses the keyboard and is never saved (canvas.js keptMarks). A highlight's card has no arrow to it (taken out
// again on 2026-10-06, as MATH-15 had it).
// @bart at the start of a note that can ask is the document's blue
// label, in the note shown and, through a backdrop under its transparent text, in its field (model/doc.js noteInkHtml).
// Removing a mark (MATH-66, 2026-10-06): Backspace / Delete on the mark in focus (a highlight pressed, or a card moved by
// its note: the card's trash button went 2026-10-07, David, its grip 2026-10-16), nothing having the keyboard, takes the mark away, every part of a
// selection across pages with it, and an answer still being written on it is stopped first (removeMark). No confirmation:
// a toast says so for about 5 s with Undo, and ⌘Z does the same, the mark coming back where it was with its note, answers
// and place (undoRemoval).
// Annotations round (Hudson, 2026-10-16), most of it the look notes had before MATH-27 (6217120), on the canvas kept since:
// - One white surface. Every page is drawn as wide as the others (scans' pages differ by a few points, which left their
//   edges out of line) and they meet with no gap, no rule and no edge.
// - No panning sideways: the column is always in the middle of the pane, and a zoom keeps the pane's vertical center
//   line where it is (tldraw's camera with x `fixed` at origin 0.5). What lies beside the page is reached by zooming out;
//   past 100% the page alone scrolls sideways, never the desk beyond it (the sheet clips at the page's edges then).
// - Zoom without rebuilding (pdf.js's viewer does the same): a pinch scales the paper with one CSS transform, the
//   compositor's alone; once it settles every sheet takes its new size (applyGeometry), the text layers through
//   --total-scale-factor (their spans are placed in % of the page), the highlights through their viewBox (drawn in desk
//   px), the notes through their layer's scale, and only the drawings near the view are drawn again. Nothing is built
//   anew, and the pages far from the view get their text and their marks a page at a time, letting the app breathe.
// - Notes are handwriting on the paper, no box, no grip: a click anywhere that is not text or a highlight writes one
//   there (typing anywhere, as before MATH-27), a press on a note's words moved past PRESS_MOVE drags it, a click puts the
//   caret in it. A highlight's note is narrow and grows down, in the margin beside its highlight, so it is read without
//   panning; one written while zoomed out may use the room that showed then (`vis`).
// - A highlight's own boxes on a line are one band across the word gaps (./marks.js bandRects), with no outline.
// Bugs after that round (Hudson, 2026-10-16, later):
// - Notes are the same size at every zoom ("the font size should be adaptive so it is the same size at all zooms") and
//   always in sight beside the part of the page that is ("i should be able to see all annotations if i can see any
//   vertical position y at all times, irrespective of zoom and position it was left x"). The cards' layer is no longer
//   scaled with the page: a card is laid out in screen px, only where it sits follows the page (its highlight's height
//   and the text's edge, or its `pos`), and the pane's sides move it in, narrower and taller if need be (arrangePages,
//   ./canvas.js fitWidth). A pinch counter-scales each card (--inv) so it keeps its size until the layout settles. This
//   replaces the layer's scale above and the `vis` room.
// - Hovering a note shows a move handle at its lower right (dragged, it moves the card, as its words do).
// - A selection is kept only with Enter or a note typed on it; a click away puts it away, as before David's 2026-10-07.
// - The text layer's line breaks are not painted when selected (pdf.js's br::selection rule; they drew a dashed line down
//   the page's left), and a selection being dragged is drawn as the bands it will be kept as (liveSelection), not the
//   browser's word boxes.
// - A page has a small drawing under its own (keepThumb), made from it or drawn small near the view, so a zoom out shows
//   pages, not white, while their drawings come.
import React from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import rough from 'roughjs';
import { mergeLineRects, bandRects, placeHighlight, boxSeed, selectionParts, scalePart, partMarks, passageOf, stackNotes, wordBounds, pdfText, pageWindow } from './marks.js';
import { nextFind, createTargetGate, sectionSpans, paintSection, clearFind, FIND, FIND_ACTIVE } from '../model/find.js';
import { wheelZooms, wheelZoom, createPageCache } from '../model/paper-zoom.js';
import { nearOrder, allOrder, tooFar, DRAW_AHEAD, columnGeometry, settleView, nextTick } from '../model/paper-draw.js';
import { mentionAt, libMention, fileMention, fileMentionOf, noteHtml, noteInkHtml, noteParts, noteOffset, inlineHtml, esc, LIB_MENTION_RE } from '../model/doc.js';
import { isFolderRow, folderRows, firstPick, parentRel } from '../model/rail.js';
import { NOTE_INK, NOTE_TYPE, ANSWER_FONT, ANSWER_INK, QUESTION_INK, LABEL_INK, ERROR_INK, ANSWER_GAP, SPINNER, CARD_GROUND, cardCss } from './card-look.js';
import { sideSpace, deskGeom, placeOf, posOf, spaceBoxes, noteQuestion, askedByNote, turnsOf, shownAsks, keptMarks, runningLabel, textColumn, fitWidth, freeNoteWidth, noteScale, NOTE_FLOOR, HIDE_ROOM, FREE_MIN, FREE_FIT, EDGE_PAD, NOTE_W, NOTE_MIN, BOX_GAP, SIDE_GAP, POS_DY, PRESS_MOVE } from './canvas.js';
import { fieldCaret } from '../workspace/caret.js';
import MentionMenu from '../workspace/MentionMenu.jsx';

// pdf.js 6: a document is torn down through its loading task (PDFDocumentProxy has no destroy()).
const destroyDoc = (doc) => { try { const task = doc && doc.loadingTask; if (task && typeof task.destroy === 'function') task.destroy().catch(() => {}); } catch { /* already gone */ } };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const BASE = document.baseURI;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', BASE).href;
// Optional asset folders next to index.html (copied by the build when present): standard
// fonts for PDFs that do not embed theirs, CMaps for CJK text, wasm image decoders.
const ASSETS = {
  standardFontDataUrl: new URL('./standard_fonts/', BASE).href,
  cMapUrl: new URL('./cmaps/', BASE).href,
  wasmUrl: new URL('./wasm/', BASE).href,
};

/* ---------------------------------------------------------------- zoom math (pure) */
// 100% = page 1 as wide as the pane. Zoom is kept as a fraction (1 = 100%).
export const ZOOM_MIN = 0.15, ZOOM_MAX = 2;
export const ZOOM_STEPS = [15, 30, 41, 67, 69, 90, 100, 110, 150, 200];
/** The fixed zoom (percent) that − (dir < 0) or + (dir > 0) goes to from `pct`, or null past the ends. */
export function zoomStep(pct, dir) {
  const r = Math.round(pct);
  if (dir > 0) { const s = ZOOM_STEPS.find((v) => v > r); return s == null ? null : s; }
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i -= 1) if (ZOOM_STEPS[i] < r) return ZOOM_STEPS[i];
  return null;
}
/** 1-based page whose sheet contains y, given the sheets' ascending tops (tops[0] is page 1). */
export function pageAt(tops, y) {
  if (!tops.length) return 0;
  let lo = 0, hi = tops.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] <= y) lo = mid; else hi = mid - 1; }
  return lo + 1;
}
export { sideSpace };
/** Canvas pixels per CSS px: 2×, capped so one page's canvas stays near 4 million device pixels. */
export const canvasScale = (cssW, cssH) => Math.min(2, Math.sqrt(4e6 / Math.max(1, cssW * cssH)));
// A page's small drawing (keepThumb): this many canvas px wide, for the pages within THUMB_AHEAD of the view.
export const THUMB_W = 180;
export const THUMB_AHEAD = 12;
const PINCH_SETTLE_MS = 180;

// pdf.js 6 positions text-layer spans through CSS custom properties (--font-height,
// --scale-x, --rotate, --total-scale-factor); these rules mirror pdf_viewer.css for the
// design's .pdf-text container so selection rectangles line up with the printed text.
// .endOfContent (MATH-14, 2026-10-05) is pdf.js's TextLayerBuilder's: an empty, unselectable box at the end of each
// layer that covers it while a selection is made there (.selecting, see trackSelecting). Without it a drag ending past a
// line or in a margin lands on the layer itself, whose spans are all absolutely placed, and Chromium takes the end of the
// layer: the rest of the page was selected.
// A selection is never the browser's paint in a text layer (2026-10-16, later): its word boxes overlapped darker, and its
// line breaks drew a dashed line down the page's left (pdf.js hides those with br::selection). It is drawn as bands
// instead (liveSelection), as it will be kept.
// Since 2026-10-16 a text layer is `content-visibility:auto`: the spans of the pages out of view are not styled or laid
// out when a zoom changes --total-scale-factor on every layer, or at all until they come near. A selection or a find in
// one makes it count again. The highlight layer multiplies with the page (pdf.js's highlights do), so a band darkens the
// paper, never the ink.
const LAYER_CSS = `
[data-pdf] .pdf-text{color-scheme:only light;overflow:clip;opacity:1;letter-spacing:normal;word-spacing:normal;caret-color:CanvasText;z-index:0;--min-font-size:1;--text-scale-factor:calc(var(--total-scale-factor) * var(--min-font-size));--min-font-size-inv:calc(1 / var(--min-font-size))}
[data-pdf] .pdf-text :is(span,br){color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%;user-select:text}
[data-pdf] .pdf-text > :not(.markedContent),[data-pdf] .pdf-text .markedContent span:not(.markedContent){z-index:1;--font-height:0;font-size:calc(var(--text-scale-factor) * var(--font-height));--scale-x:1;--rotate:0deg;transform:rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv))}
[data-pdf] .pdf-text .markedContent{display:contents}
[data-pdf] .pdf-text .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;user-select:none}
[data-pdf] .pdf-text.selecting .endOfContent{top:0}
[data-pdf] .pdf-text span[role="img"]{user-select:none;cursor:default}
[data-pdf] .pdf-text{content-visibility:auto}
[data-pdf] .pdf-text ::selection{background:transparent;color:transparent}
[data-pdf] .pdf-text br::selection{background:transparent}
[data-pdf] [data-box] [data-move]{position:absolute;right:0;bottom:-15px;width:15px;height:15px;display:flex;align-items:center;justify-content:center;color:#8f8f8f;opacity:0;cursor:move;pointer-events:auto;transition:opacity 120ms;transform-origin:100% 0;transform:scale(calc(1 / (var(--ns,1) * var(--inv,1))))}
[data-pdf] [data-box]:hover [data-move]{opacity:1}
[data-pdf] [data-box] [data-move]:hover{color:#171717}
[data-pdf][data-dragging] [data-move]{opacity:0}
[data-pdf] [data-page]{cursor:text}
[data-pdf] [data-hl]{mix-blend-mode:multiply}
[data-pdf][data-dragging],[data-pdf][data-dragging] *{cursor:grabbing!important;user-select:none!important}
[data-pdf] [data-box] [data-note-view]{cursor:text}
${cardCss('[data-pdf] [data-box]')}
::highlight(pdf-section){background-color:rgba(255,196,0,.13)}
::highlight(pdf-find){background-color:rgba(255,196,0,.35)}
::highlight(pdf-find-active){background-color:rgba(255,140,0,.6)}
`;

// The page-and-zoom bar (Stage design).
const BAR = { position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 2, height: 34, boxSizing: 'border-box', padding: '0 4px 0 12px', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, font: '400 12.5px/1 var(--font-sans)', fontVariantNumeric: 'tabular-nums', color: '#4d4d4d', whiteSpace: 'nowrap', zIndex: 5 };
const BAR_STEP = { flex: 'none', width: 26, height: 26, padding: 0, borderRadius: 6, border: 0, background: 'transparent', font: '400 14px/1 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer' };
const BAR_PCT = { flex: 'none', minWidth: 48, height: 26, padding: '0 6px', borderRadius: 6, border: 0, background: 'transparent', font: '500 12.5px/1 var(--font-sans)', fontVariantNumeric: 'tabular-nums', color: '#171717', cursor: 'pointer' };
// A card (MATH-27): a highlight's note and Bart's answers to it, or a note typed anywhere. Since 2026-10-16 there is nothing
// of a card to see (Hudson: "Get rid of the ugly box around the annotations"): no edge, fill, grip or divider, only the
// handwriting and the answers' text on the paper. It is moved by pressing on its note's words (startNoteDrag).
// A card is laid out in note px and drawn at --ns, the page's noteScale (./canvas.js), about its top-left (2026-10-16,
// third round: notes the size of the paper's text). A pinch under way multiplies that by --inv (cardsInverse) only where
// the pinch would take a note under NOTE_FLOOR.
const BOX_LOOK = 'position:absolute;box-sizing:border-box;pointer-events:auto;transform-origin:0 0;transform:scale(calc(var(--ns,1) * var(--inv,1)))';
// The move handle at a card's lower right, shown while the pointer is on the card (Hudson's four arrows).
const MOVE_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 .5 10.6 3.4H8.9V7.1h3.7V5.4L15.5 8l-2.9 2.6V8.9H8.9v3.7h1.7L8 15.5l-2.6-2.9h1.7V8.9H3.4v1.7L.5 8l2.9-2.6v1.7h3.7V3.4H5.4z"/></svg>';
const REVEAL_PAD = 16; // px a card is kept from the pane's edges: its widest (paneFit), and scrolled into view (revealCard)
const REMOVED_MS = 5000; // how long "Highlight removed · Undo" stays
const TOAST = { position: 'absolute', left: '50%', bottom: 60, transform: 'translateX(-50%)', zIndex: 6, display: 'flex', alignItems: 'center', gap: 4, height: 30, boxSizing: 'border-box', padding: '0 4px 0 12px', background: '#171717', borderRadius: 8, font: '400 12.5px/1 var(--font-sans)', color: '#fff', whiteSpace: 'nowrap', boxShadow: '0 2px 8px rgba(0,0,0,.12)' };
const TOAST_UNDO = { flex: 'none', height: 22, padding: '0 8px', border: 0, borderRadius: 5, background: 'transparent', font: '500 12.5px/1 var(--font-sans)', color: '#fff', cursor: 'pointer' };

// Find (the Browser pane's ⌘F, 2026-09-22): matches are Ranges over the text layer, painted with
// the CSS Custom Highlight API, so the page's DOM is never touched. Space in the query matches any
// run of space, or none (pdf.js splits lines and words into separate spans), and a word may be
// broken by a hyphen at the end of a line ("construc-" / "tion"; a line break is \n here).
const escapeChar = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const findPattern = (query) => new RegExp(query.trim().split(/\s+/).map((word) => [...word].map(escapeChar).join('(?:-\\n)?')).join('\\s*'), 'gi');
// A link's target as the gate holds it: the passage, and the start of the section after it when there is one.
const targetKey = (find, to) => (find ? (to ? `${find}\n${to}` : find) : '');
const highlights = () => (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null);

const clone = (v) => JSON.parse(JSON.stringify(v));
const markId = (prefix = 'm') => prefix + Date.now() + Math.random().toString(36).slice(2, 6); // 'g…': a selection across pages' group
// What has the keyboard when it is no field, button or link: Space, ⌘Z and a pending selection's keys can be the paper's.
const CONTROL = 'input,textarea,select,button,a[href],[contenteditable="true"]';
// A range's text as a selection gives it: its text nodes in order, a line break (<br>) as \n. Range.toString() leaves
// out line breaks, which would run one line's last word into the next one's first.
function rangeText(range) {
  const root = range.commonAncestorContainer;
  if (root.nodeType === Node.TEXT_NODE) return root.data.slice(range.startOffset, range.endOffset);
  let out = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    if (node.nodeType === Node.TEXT_NODE) out += node.data.slice(node === range.startContainer ? range.startOffset : 0, node === range.endContainer ? range.endOffset : node.data.length);
    else if (node.nodeName === 'BR') out += '\n';
  }
  return out;
}
// A range's client rects, its text's alone (2026-10-08): each text node it takes in measured on its own, one of only
// white space skipped. The rects of the elements it takes in whole, and a lone space's sliver past the end of a line,
// were drawn as thin vertical lines. With no text in it, the range's own rects.
function textRects(range) {
  const root = range.commonAncestorContainer, out = [];
  const nodes = root.nodeType === Node.TEXT_NODE ? [root] : [];
  if (!nodes.length) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if (range.intersectsNode(node)) nodes.push(node);
  }
  for (const node of nodes) {
    const from = node === range.startContainer ? range.startOffset : 0, to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from || !node.data.slice(from, to).trim()) continue;
    const part = document.createRange();
    part.setStart(node, from); part.setEnd(node, to);
    out.push(...part.getClientRects());
  }
  return out.length ? out : [...range.getClientRects()];
}
const SVG = 'http://www.w3.org/2000/svg';
// A note's handwriting, the same in its field and shown as text (./card-look.js NOTE_TYPE, a web box's card's too).
const NOTE_LOOK = `pointer-events:auto;${NOTE_TYPE};transition:opacity 120ms,background 120ms`;

// An answer as its box draws it (MATH-27): a paragraph a line, with what Bart was told a box may hold (bold, italic,
// code, links), and a list's or a heading's mark taken off should one come anyway. answerParas: each paragraph's inside.
function answerParas(text, opts) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const item = line.match(/^[-*] (.*)$/), head = line.match(/^#{1,6} (.*)$/);
    return item ? `• ${inlineHtml(item[1], opts)}` : head ? `<strong>${inlineHtml(head[1], opts)}</strong>` : inlineHtml(line, opts);
  });
}
const answerHtml = (text, opts) => answerParas(text, opts).map((inside) => `<p>${inside}</p>`).join('');

// A box being written is changed in place as Bart works (second pass, 2026-10-06): its Stop and "▸ steps" buttons stay
// the elements they were, so a click on one never lands between two drawings of the box and is lost. `shownHtml`: what
// each line of its steps and its answer so far was last given (syncKids); a line that reads the same is left alone, and
// a selection in it, or a link being clicked, outlasts the next tick.
const shownHtml = new WeakMap();
function syncKids(parent, htmls, make) {
  htmls.forEach((html, i) => {
    let el = parent.children[i];
    if (!el) { el = make(); parent.appendChild(el); }
    if (shownHtml.get(el) !== html) { el.innerHTML = html; shownHtml.set(el, html); }
  });
  while (parent.children.length > htmls.length) parent.lastElementChild.remove();
}
const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const showEl = (el, on) => { const display = on ? '' : 'none'; if (el.style.display !== display) el.style.display = display; };
/** An element made with its look, and `data` (dataset), as runBox builds a box being written. */
function makeEl(tag, css, data = {}, text = '') {
  const el = document.createElement(tag);
  if (css) el.style.cssText = css;
  Object.assign(el.dataset, data);
  if (tag === 'button') el.type = 'button';
  if (text) el.textContent = text;
  return el;
}

function toBytes(src) {
  // pdf.js transfers the buffer to its worker (detaching it), so hand it a private copy.
  if (!src) return null;
  if (src instanceof ArrayBuffer) return src.slice(0);
  if (ArrayBuffer.isView(src)) return new Uint8Array(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
  return null;
}

export default class PaperView extends React.Component {
  constructor(props) {
    super(props);
    this.state = { note: 'Opening the paper…', page: 0, pages: 0, pct: 100, mention: null, mentionIdx: 0, removed: null, browse: null };
    this.host = React.createRef();
    this.root = React.createRef(); // the pane: the paper, its bar and its toast
    this.marks = clone(props.marks || {}); // { [page]: Mark[] }, geometry in page units
    this.doc = null;
    this.gen = 0; // document generation
    this.layoutGen = 0; // page-layout generation
    this.renderTask = null;
    this.textLayer = null;
    this.drawGen = 0; // the layout whose sheets are in the DOM, once they are (drawSoon draws for it alone)
    this.pumping = 0; // the layout whose pages drawPages is drawing now
    this.textsAt = 0; // the document whose pages all have their text (textsDone)
    this.drawingPage = 0; // the page renderTask is drawing
    this.pdfG = 150; // page 1's side space (per-page values live in this.geo)
    this.pdfW = null; // pane width of the current layout
    this.pageW = null; // page 1's drawn width
    this.resetGeometry();
    this.pendingSel = null;
    this.pdfDown = null;
    this.dirty = false;
    this.saveTimer = null;
    this.resizeTimer = null;
    this.pinchTimer = null;
    this.pinching = null; // a pinch under way: { ox, oy }, the point inside the paper its transform is centered on
    this.scrollRaf = 0;
    this.editing = null; // the id of the note being typed in: drawn as its field, the rest as text (see renderMarks)
    this.redrawing = 0; // > 0 while notes are taken out to be drawn again: a field losing the keyboard then is not left
    this.libDrawn = ''; // the mentioned items' names the notes were drawn with (libKey)
    this.drawn = {}; // { [page]: { boxes, units } }: the cards as last drawn (sheet px), for spacing and fitting
    this.viewX = 0; // the pane's scrollLeft as the cards were last kept in it (arrangePages)
    this.cols = new Map(); // page → its text's column, { l, r } page units, once measured (columnOf)
    this.drag = null; // a card being moved by its note (startNoteDrag)
    this.press = null; // a press on a note's words, until it moves (a drag) or is let go (a click: the caret goes there)
    this.openLogs = new Set(); // answers being written whose steps are shown
    this.undos = []; // what ⌘Z brings back, the last first: answers deleted, { page, markId, askId }, and marks removed, { kind: 'mark', page, mark, index, batch } a part (undoKey)
    this.removedTimer = null; // the "Highlight removed · Undo" toast going (state.removed)
    this.downHere = false; // the last press was in this pane: ⌘Z is the paper's
    // A press on the paper (2026-10-16): it puts away what was open (a pending selection goes unkept: Enter or a note keeps
    // it, Hudson, 2026-10-16 later, as before 2026-10-07; the highlight in focus loses it, a note being typed in is left),
    // and only a press that put nothing away may write a note where it is let go (pdfMouseUp): one click closes, the next
    // one writes, as before MATH-27.
    this.onDown = (e) => {
      if (!(e.target.closest && e.target.closest('[data-pdf] [data-page]'))) return;
      if (e.target.closest('[data-box]')) return;
      const host = this.host.current, active = document.activeElement;
      const typing = !!(active && active.tagName === 'TEXTAREA' && active.dataset.mark && host && host.contains(active));
      this.pdfDown = { x: e.clientX, y: e.clientY, closed: typing || !!this.pendingSel || !!this.focusId };
      if (!e.target.closest('textarea')) this.clearPending();
      const tl = e.target.closest('[data-text-layer]');
      if (tl) tl.classList.add('selecting');
    };
    this.onUp = (e) => this.pdfMouseUp(e);
    // A selection being made (see LAYER_CSS .endOfContent): the layers it touches stay .selecting until the pointer is
    // up, the window loses focus, or a key is let go with the pointer up (pdf.js TextLayerBuilder's listeners).
    this.pointerIsDown = false;
    this.onPointerDown = (e) => {
      this.pointerIsDown = true;
      const root = this.root.current;
      this.downHere = !!(root && e && e.target && root.contains(e.target));
    };
    this.onPointerUp = () => { this.pointerIsDown = false; this.endSelecting(); };
    this.onBlur = () => { this.pointerIsDown = false; this.endSelecting(); };
    this.onKeyUp = () => { if (!this.pointerIsDown) this.endSelecting(); };
    this.onSelectionChange = () => { this.trackSelecting(); this.liveSoon(); };
    this.liveRaf = 0;
    this.onKeyCapture = (e) => { if (this.copyKey(e) || this.pendingSelKey(e) || this.undoKey(e) || this.markKey(e)) e.stopPropagation(); };
    this.onWheel = (e) => this.pinch(e);
    this.onScroll = () => {
      if (this.state.mention) this.closeMention();
      if (this.scrollRaf) return;
      this.scrollRaf = requestAnimationFrame(() => {
        this.scrollRaf = 0;
        const host = this.host.current;
        // Past 100% the page scrolls sideways: its cards are kept in the pane (arrangePages) as it goes.
        if (host && host.scrollLeft !== this.viewX) { this.viewX = host.scrollLeft; this.arrangeNear(); }
        this.syncBar(); this.drawSoon();
      });
    };
    this.textRects = new Map(); // page → its text runs' boxes in page units, measured once its text is drawn (textBoxes)
    this.painted = null; // the mark paintFocus last showed (the one in focus, or the one pointed at)
    // A press on a note's words: past PRESS_MOVE it drags the card (the view scrolls up or down at the pane's edges,
    // dragTick); let go before that, the caret goes where it was pressed.
    this.onPressMove = (e) => this.pressMove(e);
    this.onPressUp = (e) => this.pressUp(e);
    this.onDragMove = (e) => { const d = this.drag; if (!d) return; d.at = { x: e.clientX, y: e.clientY }; this.dragTo(); };
    this.onDragUp = () => this.endDrag();
    this.findQuery = '';
    this.findAt = -1;
    this.findRanges = [];
    this.findSpots = []; // where each of findRanges is: { page, from, to } in its page's text
    this.section = null; // { text, to, spot }: a link's section, its start words found at `spot` ({ page, from, to })
    this.gate = createTargetGate();
    const first = props.target ? { find: props.target, to: props.targetTo } : props.initialSection || {};
    this.gate.set(targetKey(first.find, first.to));
  }

  // Zoom and layout state, dropped whenever a new document opens (which opens at 100%).
  resetGeometry() {
    this.zoom = 1; // committed zoom (fraction of fit width)
    this.live = null; // zoom while a pinch is under way, before it is laid out
    this.renderedZoom = 1; // the zoom the sheets are laid out at
    this.css = 1; // the scale a pinch's transform puts on the paper now (live / rendered); 1 otherwise
    this.pages = []; // [n] PDFPageProxy
    this.v0 = []; // [n] viewport at scale 1 (pdf points)
    this.geo = []; // [n] { G, R, pageW, pageH, scale, k } in CSS px
    this.sheets = []; // [n] { wrap, canvas, hl, tl, notes }, made once a document
    this.tops = []; // [n − 1] top of sheet n inside the inner wrapper (unzoomed)
    this.sheetW = 0; // the sheets' width: the pane's, or the page's once it is wider
    this.inner = null;
    const pages = this.pages;
    this.texts = createPageCache((n) => pages[n].getTextContent()); // each page's text, asked for once a document
  }

  componentDidMount() {
    const host = this.host.current;
    host.addEventListener('mousedown', this.onDown);
    host.addEventListener('mouseup', this.onUp);
    host.addEventListener('wheel', this.onWheel, { passive: false });
    host.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('keydown', this.onKeyCapture, true);
    document.addEventListener('pointerdown', this.onPointerDown);
    document.addEventListener('pointerup', this.onPointerUp);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('selectionchange', this.onSelectionChange);
    window.addEventListener('blur', this.onBlur);
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(host);
    this.load();
  }

  componentDidUpdate(prev, prevState) {
    if (prevState && !prevState.mention !== !this.state.mention && this.props.onMentionOpen) this.props.onMentionOpen(!!this.state.mention);
    if (prev.target !== this.props.target || prev.targetTo !== this.props.targetTo) {
      const text = this.gate.set(targetKey(this.props.target, this.props.targetTo));
      if (text) this.applyTarget(text);
    }
    if (prev.bytes !== this.props.bytes) {
      this.flushSave(prev.onMarksChange);
      this.marks = clone(this.props.marks || {});
      this.dirty = false;
      this.clearPending();
      this.load();
      return;
    }
    if (prev.marks !== this.props.marks && !this.dirty) {
      // Annotations arriving after the bytes (loaded separately) adopt as long as nothing was edited here in the meantime.
      this.marks = clone(this.props.marks || {});
      this.renderAllMarks();
    }
    if (prev.pendingAsks !== this.props.pendingAsks) this.syncPending(prev.pendingAsks || []);
    // A mentioned item renamed, or gone from the library: its mentions are drawn again with its name now.
    if ((prev.library !== this.props.library || prev.fileState !== this.props.fileState) && this.libKey() !== this.libDrawn) this.renderAllMarks();
  }

  componentWillUnmount() {
    const host = this.host.current;
    if (host) {
      host.removeEventListener('mousedown', this.onDown);
      host.removeEventListener('mouseup', this.onUp);
      host.removeEventListener('wheel', this.onWheel);
      host.removeEventListener('scroll', this.onScroll);
    }
    this.pressUp(null);
    if (this.drag) this.endDrag(true);
    window.removeEventListener('keydown', this.onKeyCapture, true);
    document.removeEventListener('pointerdown', this.onPointerDown);
    document.removeEventListener('pointerup', this.onPointerUp);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('selectionchange', this.onSelectionChange);
    window.removeEventListener('blur', this.onBlur);
    clearTimeout(this.removedTimer);
    if (this.ro) this.ro.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.pinchTimer);
    if (this.scrollRaf) cancelAnimationFrame(this.scrollRaf);
    if (this.state.mention && this.props.onMentionOpen) this.props.onMentionOpen(false);
    // Where the paper was read to (MATH-16): its tab, brought back to the front, opens there again (props.view).
    if (host && this.inner && this.props.onView) this.props.onView({ zoom: this.live != null ? this.live : this.zoom, at: host.scrollHeight ? host.scrollTop / host.scrollHeight : 0, left: host.scrollLeft });
    this.flushSave(this.props.onMarksChange);
    this.gen += 1;
    this.cancelLayout();
    this.cancelText();
    this.stopFind();
    this.clearSection();
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
  }
  // In this viewer only: the Paper pane and a pdf in the Browser pane can both be open, with the same page numbers.
  find1(selector) { const host = this.host.current; return host ? host.querySelector(selector) : null; }

  // A page's drawn geometry (falls back to page 1's before the first layout).
  geom(page) { return this.geo[page] || { G: this.pdfG || 0, R: this.pdfG || 0, pageW: this.pageW || 1, k: this.renderedZoom || 1 }; }
  // The same in desk px, where its cards are laid out (./canvas.js deskGeom), from the page's left edge (2026-10-16: the
  // cards' layer starts where the page does, so a zoom, which moves the page along its sheet, moves them with it).
  desk(page) { return { ...deskGeom(this.geom(page)), G: 0 }; }
  // Screen px per px of a card on page n (BOX_LOOK --ns): its handwriting the size of the page's text, never under
  // NOTE_FLOOR (./canvas.js noteScale).
  boxScale(page) { return noteScale(this.geom(page || 1).pageW); }

  /* ---------------------------------------------------------------- persistence */
  scheduleSave() {
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.emit(this.props.onMarksChange); }, 300);
  }
  flushSave(cb) {
    if (!this.saveTimer) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.emit(cb);
  }
  emit(cb) {
    if (typeof cb !== 'function') return;
    const out = {}, now = Date.now();
    for (const [page, list] of Object.entries(this.marks)) { const kept = keptMarks(list, now); if (kept.length) out[page] = clone(kept); }
    cb(out);
  }

  /* ---------------------------------------------------------------- loading */
  async load() {
    const gen = ++this.gen;
    this.cancelLayout();
    this.cancelText();
    this.endPinch(true);
    if (this.doc) { const d = this.doc; this.doc = null; destroyDoc(d); }
    const host = this.host.current;
    this.closeMention();
    this.redrawing += 1;
    try { if (host) host.replaceChildren(); } finally { this.redrawing -= 1; }
    this.resetGeometry();
    this.pdfW = null;
    this.undos = []; // another paper
    this.hideRemoved();
    this.cols.clear();
    this.textRects.clear();
    this.gate.drawing();
    const data = toBytes(this.props.bytes);
    if (!data) { this.setState({ note: 'No paper to open.', page: 0, pages: 0 }); return; }
    this.setState({ note: 'Opening the paper…', page: 0, pages: 0, pct: 100 });
    try {
      const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false, ...ASSETS }).promise;
      if (gen !== this.gen) { destroyDoc(doc); return; }
      this.doc = doc;
      this.setState({ note: '' });
      const view = this.props.target || this.props.initialSection ? null : this.props.view;
      if (view && view.zoom > 0) this.zoom = clamp(view.zoom, ZOOM_MIN, ZOOM_MAX);
      if (!(await this.layout())) return;
      const h = this.host.current;
      if (view && h && gen === this.gen) { h.scrollTop = view.at * h.scrollHeight; h.scrollLeft = view.left || 0; this.syncBar(); }
      this.drawSoon();
    } catch (err) {
      if (gen !== this.gen) return;
      this.setState({ note: 'Could not open the paper — ' + ((err && err.message) || err) });
    }
  }

  // The drawing under way stops: it was for a size the pages no longer have. (A text layer under way goes on: its spans
  // are placed in % of their page, good at any size; cancelText stops it when the document goes.)
  cancelLayout() {
    this.layoutGen += 1;
    if (this.renderTask) { try { this.renderTask.cancel(); } catch (e) { /* already done */ } this.renderTask = null; }
  }
  cancelText() {
    if (this.textLayer) { try { this.textLayer.cancel(); } catch (e) { /* already done */ } this.textLayer = null; }
  }

  /* ---------------------------------------------------------------- zoom */
  pct() { return Math.round((this.live != null ? this.live : this.zoom) * 100); }

  /** Zoom to a percent of fit width, about the middle of the view. */
  zoomTo(target) {
    const host = this.host.current;
    if (!host || !this.doc || !this.inner) return;
    this.endPinch(true);
    this.rezoom(target / 100, { ox: host.scrollLeft + host.clientWidth / 2, oy: host.scrollTop + host.clientHeight / 2 });
  }
  zoomStepBy(dir) { const next = zoomStep(this.pct(), dir); if (next != null) this.zoomTo(next); }
  // The percentage goes back to 100%: the page as wide as the pane.
  togglePct() { if (this.pct() !== 100) this.zoomTo(100); }

  // Trackpad pinch (and ⌃ scroll) arrive as wheel events with ctrlKey, ⌘ scroll with metaKey. 2026-10-16: while the pinch
  // goes on the paper is scaled by one CSS transform (the compositor's: nothing is laid out again, the drawings are
  // stretched), about the pane's vertical center line at the height the pinch began; once it settles (PINCH_SETTLE_MS
  // with no event) the pages are laid out at the new zoom and the same point is put back under it (rezoom). It was CSS
  // `zoom` until then, which laid every page's layers out again on each event, then rebuilt every page when it settled.
  pinch(e) {
    if (!wheelZooms(e)) return;
    e.preventDefault();
    if (!this.doc || !this.inner) return;
    const from = this.live != null ? this.live : this.zoom;
    const to = wheelZoom(from, e, ZOOM_MIN, ZOOM_MAX);
    if (to !== from) {
      if (!this.pinching) this.startPinch(e.clientY);
      this.closeMention();
      this.live = to;
      this.css = to / this.renderedZoom;
      this.inner.style.transform = this.pinchTransform();
      this.cardsInverse(this.css);
      this.syncBar();
    }
    clearTimeout(this.pinchTimer);
    this.pinchTimer = setTimeout(() => this.endPinch(), PINCH_SETTLE_MS);
  }
  // The pinch's transform now: its scale about its center, and, where that would pull the paper's top below the pane's
  // top (zooming out near page 1) or its foot above the pane's foot, moved back up or down to the pane's edge, as the
  // layout after it will be (settleView keeps the scroll at 0 or more). Without it a white band showed above page 1 for
  // as long as the pinch went on, and the paper jumped up when it settled.
  pinchTransform() {
    const host = this.host.current, p = this.pinching, c = this.css || 1, N = this.tops.length;
    if (!host || !p || !N) return `scale(${c})`;
    const H = host.clientHeight, total = this.tops[N - 1] + ((this.geo[N] && this.geo[N].pageH) || 0);
    const head = p.oy * (1 - c) - host.scrollTop, foot = p.oy + (total - p.oy) * c - host.scrollTop;
    p.ty = total * c <= H || head > 0 ? -head : foot < H ? H - foot : 0;
    return p.ty ? `translateY(${p.ty}px) scale(${c})` : `scale(${c})`;
  }
  // Where the pinch's transform is centered, px inside the paper: the middle of the view across, the pointer's height.
  startPinch(clientY) {
    const host = this.host.current, r = host.getBoundingClientRect();
    const oy = host.scrollTop + clamp(clientY - r.top - host.clientTop, 0, host.clientHeight), ox = host.scrollLeft + host.clientWidth / 2;
    this.pinching = { ox, oy, ty: 0 };
    this.inner.style.transformOrigin = `${ox}px ${oy}px`;
    this.inner.style.willChange = 'transform';
  }
  // The pinch settled: laid out at its zoom. `drop`: the transform is taken off and nothing laid out (another paper).
  endPinch(drop = false) {
    clearTimeout(this.pinchTimer);
    this.pinchTimer = null;
    const p = this.pinching, z = this.live;
    this.pinching = null; this.live = null;
    // The point the pinch was centered on, where the transform's shift (pinchTransform) has put it on the pane.
    if (!drop && p && z != null && this.inner) { this.rezoom(z, { ox: p.ox, oy: p.oy - (p.ty || 0) / (z / this.renderedZoom) }); return; }
    this.css = 1;
    if (this.inner) { this.inner.style.transform = ''; this.inner.style.willChange = ''; }
    this.cardsInverse(1);
  }
  // Every page's cards while a pinch scales the paper by c: they go with the paper, as its text does, except where that
  // would draw them under NOTE_FLOOR, where --inv holds them there; none (1) once it is laid out. Only the pages that
  // have cards are touched.
  cardsInverse(c) {
    const ns = this.boxScale(), v = c === 1 ? 1 : Math.max(ns * c, NOTE_FLOOR) / (ns * c);
    for (const sh of this.sheets) {
      if (!sh || !sh.cards) continue;
      sh.notes.style.setProperty('--inv', v === 1 ? '' : String(v)); // '' takes it away
    }
  }

  // The pages laid out at zoom z, the paper's point (ox, oy) of the layout before (px inside it) kept where it is in the
  // pane (../model/paper-draw.js settleView). Only sizes change (applyGeometry): the drawings near the view are drawn
  // again for the new size, the rest when a scroll brings them near. `draw` false: not yet (a resize still going on).
  rezoom(z, { ox, oy }, { draw = true } = {}) {
    const host = this.host.current;
    if (!host || !this.inner) return;
    this.closeMention();
    const top = host.scrollTop, left = host.scrollLeft, W = host.clientWidth;
    const from = { tops: this.tops, pageW: this.pageW, S: this.sheetW }, oldGeo = this.geo;
    this.cancelLayout();
    this.applyGeometry(clamp(z, ZOOM_MIN, ZOOM_MAX));
    const at = settleView({ W, ox, oy, top, left, from, to: { tops: this.tops, pageW: this.pageW, S: this.sheetW } });
    host.scrollTop = at.top; host.scrollLeft = at.left;
    this.viewX = host.scrollLeft;
    this.arrangeNear(); // the rest as drawPages comes to them (due)
    // A pending selection is kept in px of the layout it was made in, a part a page; carried over.
    const p = this.pendingSel;
    if (p) p.parts = p.parts.map((part) => (this.geo[part.page] ? scalePart(part, part.u || (oldGeo[part.page] && oldGeo[part.page].pageW), this.geo[part.page].pageW) : part));
    for (const s of this.sheets) if (s) { s.drawn = false; s.failed = false; }
    this.syncBar();
    this.drawGen = this.layoutGen;
    if (draw) this.drawPages(this.layoutGen);
  }

  // The pane resized: 100% is still the page as wide as the pane, so the pages take the new width at once (the top of
  // the view kept), are drawn for it once the resize has settled, and their notes are laid out again for it (a desk px is
  // a px of 100%) as drawPages comes to them, the pages in view first.
  onResize() {
    const host = this.host.current;
    if (!host || !this.doc) return;
    const W = host.clientWidth;
    this.pdfH = host.clientHeight;
    if (!this.inner) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => { this.layout().then((ok) => { if (ok) this.drawSoon(); }); }, 200);
      return;
    }
    if (W === this.pdfW || W < 40) return;
    this.endPinch(true);
    this.rezoom(this.zoom, { ox: host.scrollLeft + host.clientWidth / 2, oy: host.scrollTop }, { draw: false });
    clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.drawSoon(), 150);
  }

  /* ---------------------------------------------------------------- layout */
  // Every sheet at zoom z (2026-10-16): only sizes and CSS variables change, so a zoom lays out what is in view and no
  // more (the text layers out of view are skipped: LAYER_CSS content-visibility). Every page is as wide as the others
  // (../model/paper-draw.js columnGeometry), and the sheets meet with nothing between them.
  applyGeometry(z) {
    const host = this.host.current, W = host.clientWidth, N = this.v0.length - 1;
    const { pageW, S, G } = columnGeometry(W, z);
    const geo = [], tops = [];
    let top = 0;
    for (let n = 1; n <= N; n += 1) {
      const v0 = this.v0[n], scale = pageW / v0.width, s = this.sheets[n];
      geo[n] = { G, R: G, pageW, pageH: v0.height * scale, scale, k: pageW / ((s && s.deskW) || W) };
      tops.push(top);
      top += geo[n].pageH;
    }
    this.geo = geo; this.tops = tops;
    this.zoom = z; this.renderedZoom = z; this.css = 1;
    this.pdfW = W; this.pdfH = host.clientHeight; this.pdfG = G; this.pageW = pageW; this.sheetW = S;
    if (this.inner) { this.inner.style.width = `${S}px`; this.inner.style.transform = ''; this.inner.style.willChange = ''; }
    for (let n = 1; n <= N; n += 1) if (this.sheets[n]) this.place(n);
  }

  // Everything about a sheet that depends on its geometry. The page's drawing, its small one, highlights and text sit G
  // from the sheet's left; the cards' layer is the whole sheet, unscaled (their places: arrangePages).
  place(n) {
    const g = this.geo[n], s = this.sheets[n], S = this.sheetW;
    const { G, pageW, pageH, scale } = g;
    s.wrap.style.width = `${S}px`;
    s.wrap.style.height = `${pageH}px`;
    if (s.canvas) s.canvas.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px`;
    s.hl.setAttribute('width', pageW); s.hl.setAttribute('height', pageH);
    s.hl.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px;pointer-events:none;overflow:visible`;
    const tl = s.tl.style;
    tl.left = `${G}px`; tl.top = '0'; tl.width = `${pageW}px`; tl.height = `${pageH}px`;
    tl.setProperty('--scale-factor', String(scale));
    tl.setProperty('--total-scale-factor', String(scale));
    // The cards' layer is the sheet's own, in its px (2026-10-16, later: cards are screen-sized, arrangePages).
    s.notes.style.left = '0px';
    s.notes.style.width = `${S}px`;
    s.notes.style.height = `${pageH}px`;
    s.notes.style.transform = '';
    s.notes.style.setProperty('--inv', '');
    if (s.thumb) s.thumb.style.cssText = `position:absolute;left:${G}px;top:0;width:${pageW}px;height:${pageH}px`;
  }

  /* paper — the document's sheets, made once (2026-10-16): one a page, each its drawing (a canvas, once drawn), highlights,
     text and notes, laid out at the zoom now (applyGeometry). A zoom or a resize lays the same sheets out again (rezoom);
     nothing here runs twice for a document. The paper is as wide as its sheets and clips what lies past them, so the
     pane never scrolls sideways onto the desk. → whether the sheets are there (not while the pane is too narrow). */
  async layout() {
    const host = this.host.current, doc = this.doc;
    if (!host || !doc || host.clientWidth < 40) return false;
    const gen = this.gen;
    try {
      for (let n = 1; n <= doc.numPages; n += 1) {
        if (!this.pages[n]) {
          const page = await doc.getPage(n);
          if (gen !== this.gen) return false;
          this.pages[n] = page;
          this.v0[n] = page.getViewport({ scale: 1 });
        }
      }
    } catch (err) {
      if (gen === this.gen) this.setState({ note: 'Could not draw the paper — ' + ((err && err.message) || err) });
      return false;
    }
    if (gen !== this.gen || !this.host.current || this.inner) return !!this.inner;
    const N = doc.numPages, sheets = [];
    const inner = document.createElement('div');
    inner.style.cssText = 'position:relative;overflow-x:clip;margin:0';
    for (let n = 1; n <= N; n += 1) {
      const wrap = document.createElement('div');
      wrap.dataset.page = n;
      wrap.style.cssText = 'position:relative';
      const hl = document.createElementNS(SVG, 'svg');
      hl.dataset.hl = n;
      const tl = document.createElement('div');
      tl.className = 'pdf-text'; tl.dataset.textLayer = n;
      tl.style.setProperty('--user-unit', '1');
      tl.style.setProperty('--scale-round-x', '1px');
      tl.style.setProperty('--scale-round-y', '1px');
      tl.style.position = 'absolute';
      // Cards above every page's drawing and text (one running past its page's foot stays in sight), in the sheet's px.
      const notes = document.createElement('div');
      notes.dataset.notes = n; notes.style.cssText = 'position:absolute;top:0;pointer-events:none;z-index:2;transform-origin:0 0';
      wrap.append(hl, tl, notes);
      sheets[n] = { wrap, canvas: null, hl, tl, notes };
      inner.appendChild(wrap);
    }
    this.redrawing += 1;
    try { host.replaceChildren(inner); } finally { this.redrawing -= 1; }
    this.inner = inner; this.sheets = sheets; this.drawn = {};
    this.cancelLayout(); // a layout of its own (layoutGen), which drawPages draws for
    this.applyGeometry(clamp(this.zoom, ZOOM_MIN, ZOOM_MAX));
    host.scrollTop = 0;
    host.scrollLeft = Math.max(0, (this.sheetW - host.clientWidth) / 2);
    this.syncBar();
    this.drawGen = this.layoutGen;
    return true;
  }

  // The pages the view shows, by the sheets' tops: { first, last, current }, or null before a layout.
  viewRange() {
    const host = this.host.current;
    if (!host || !this.tops.length) return null;
    const css = this.css || 1;
    return { first: pageAt(this.tops, host.scrollTop / css), last: pageAt(this.tops, (host.scrollTop + host.clientHeight) / css), current: this.currentPage() };
  }

  /* Pages drawn as the view needs them (MATH-71, ../model/paper-draw.js): one at a time, the next chosen again before
     each, so a scroll while drawing moves what comes next. The pages in view and DRAW_AHEAD each side get a drawing, their
     text and their marks; then every other page gets its text and its marks alone (find and a link's passage search every
     page). A turn of the event loop goes between two pages (2026-10-16): a long paper's text layers were built one after
     another in one go, and the whole app stopped while they were. A page more than KEEP_DRAWN from the view gives its
     drawing back, and is drawn again when a scroll brings it near (drawSoon). */
  async drawPages(gen) {
    if (this.pumping === gen) return;
    this.pumping = gen;
    try {
      for (;;) {
        if (gen !== this.layoutGen || this.pinching) return;
        const n = this.nextDraw();
        if (!n) break;
        await this.drawPage(n, gen);
        await nextTick();
      }
    } catch (err) {
      if (gen === this.layoutGen) this.setState({ note: 'Could not draw the paper — ' + ((err && err.message) || err) });
    } finally {
      if (this.pumping === gen) this.pumping = 0;
    }
  }

  // After a scroll: the pages now near the view drawn, if the loop is not already at it. A drawing under way of a page
  // that has gone far from the view is stopped (it is drawn again when it comes back).
  drawSoon() {
    if (!this.inner || this.drawGen !== this.layoutGen) return;
    const r = this.viewRange(), n = this.drawingPage, s = n && this.sheets[n];
    if (r && s && this.renderTask && tooFar(n, r.first, r.last, DRAW_AHEAD)) {
      s.stopped = true;
      try { this.renderTask.cancel(); } catch (e) { /* already done */ }
    }
    if (this.pumping !== this.layoutGen) this.drawPages(this.layoutGen);
  }

  // What page n still needs: its drawing, its text, its marks laid out for the pane as it is, or its cards for the zoom
  // and sideways scroll as they are (cardKey).
  due(s, near) { return (near && !s.drawn && !s.failed) || (!s.texted && !s.texting) || s.marksW !== this.pdfW || (!!s.cards && s.cardsAt !== this.cardKey()); }
  // The zoom, pane and sideways scroll a page's cards were laid out for (arrangePages).
  cardKey() { return `${this.renderedZoom}|${this.pdfW}|${Math.round(this.viewX || 0)}`; }
  // Page n wants its small drawing (keepThumb): it has none, and is near enough the view that a zoom out would show it.
  thumbDue(s, n, r) { return !s.thumb && !s.thumbFailed && !tooFar(n, r.first, r.last, THUMB_AHEAD); }

  // The next page to draw (nearest the view first), drawings far from the view given back on the way; null when done.
  nextDraw() {
    const r = this.viewRange(), N = this.tops.length;
    if (!r) return null;
    for (let n = 1; n <= N; n += 1) { const s = this.sheets[n]; if (s && s.canvas && tooFar(n, r.first, r.last)) this.dropDrawing(s); }
    for (const n of nearOrder(r.first, r.last, r.current, N)) { const s = this.sheets[n]; if (s && this.due(s, true)) return n; }
    for (const n of allOrder(r.first, r.last, r.current, N)) { const s = this.sheets[n]; if (s && (this.due(s, false) || this.thumbDue(s, n, r))) return n; }
    return null;
  }

  // A sheet's drawing given back: its canvas emptied (the memory goes at once, not when it is collected) and taken
  // out; its small drawing (keepThumb) shows until it is drawn again.
  dropDrawing(s) {
    const c = s.canvas;
    s.canvas = null; s.drawn = false; s.failed = false;
    c.width = 0; c.height = 0;
    c.remove();
  }

  // Page n drawn as it is laid out now: its canvas if it is near the view, then its text layer if it has none, then its
  // marks if they were laid out for another pane width. A drawing that fails leaves the one before it (stretched, or the
  // white page) and is tried again at the next zoom.
  async drawPage(n, gen) {
    const page = this.pages[n], g = this.geo[n], s = this.sheets[n], r = this.viewRange();
    if (!page || !g || !s) return;
    if (!s.drawn && !s.failed && r && !tooFar(n, r.first, r.last, DRAW_AHEAD)) {
      const vp2 = page.getViewport({ scale: g.scale * canvasScale(g.pageW, g.pageH) });
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.floor(vp2.width)); c.height = Math.max(1, Math.floor(vp2.height));
      const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp2 });
      this.renderTask = task; this.drawingPage = n;
      let ok = true;
      try { await task.promise; } catch (err) { ok = false; }
      if (this.renderTask === task) { this.renderTask = null; this.drawingPage = 0; }
      if (gen !== this.layoutGen) { c.width = 0; c.height = 0; return; }
      if (!ok) {
        if (!s.stopped) s.failed = true;
        s.stopped = false;
        c.width = 0; c.height = 0;
        return;
      }
      // Under the highlights, which multiply with it.
      if (s.canvas) { const was = s.canvas; was.replaceWith(c); was.width = 0; was.height = 0; } else s.wrap.insertBefore(c, s.hl);
      s.canvas = c; s.drawn = true;
      if (!s.thumb) this.keepThumb(n, c);
      // A canvas Chromium let go of under memory pressure comes back blank: drawn again.
      if (c.addEventListener) c.addEventListener('contextrestored', () => { if (s.canvas === c) { s.drawn = false; this.drawSoon(); } });
      c.style.cssText = `position:absolute;left:${g.G}px;top:0;width:${g.pageW}px;height:${g.pageH}px`;
    }
    else if (r && this.thumbDue(s, n, r)) await this.drawThumb(n, gen);
    if (gen !== this.layoutGen) return;
    if (!s.texted && !s.texting) await this.drawText(n);
    if (this.sheets[n] !== s) return;
    if (s.marksW !== this.pdfW) this.renderMarks(n);
    else if (s.cards && s.cardsAt !== this.cardKey()) this.arrange(n);
  }

  // Page n's small drawing (2026-10-16, later; Hudson: "some weird white strip over the zoomed out PDF"): THUMB_W canvas
  // px wide, under its drawing and stretched to the page, so a page whose drawing was given back, or is not drawn yet for
  // a zoom out, shows blurred for a moment instead of white. Made from its drawing (`from`, a scale-down that asks pdf.js
  // for nothing) when it has one.
  keepThumb(n, from) {
    const s = this.sheets[n], g = this.geo[n];
    if (!s || !g || !from || !from.width) return;
    const t = document.createElement('canvas');
    t.width = THUMB_W; t.height = Math.max(1, Math.round((THUMB_W * from.height) / from.width));
    try { t.getContext('2d').drawImage(from, 0, 0, t.width, t.height); } catch (e) { return; }
    this.putThumb(s, g, t);
  }
  putThumb(s, g, t) {
    if (s.thumb) { const was = s.thumb; was.replaceWith(t); was.width = 0; was.height = 0; } else s.wrap.insertBefore(t, s.canvas || s.hl);
    s.thumb = t;
    t.style.cssText = `position:absolute;left:${g.G}px;top:0;width:${g.pageW}px;height:${g.pageH}px`;
  }
  // Page n drawn small by pdf.js (it has never had a drawing to scale down), once the pages near the view are done. What
  // pdf.js kept of the page to draw it is let go after (page.cleanup), as it has no drawing of its own to need it.
  async drawThumb(n, gen) {
    const page = this.pages[n], s = this.sheets[n], v0 = this.v0[n];
    if (!page || !s || !v0) return;
    const vp = page.getViewport({ scale: THUMB_W / v0.width });
    const t = document.createElement('canvas');
    t.width = THUMB_W; t.height = Math.max(1, Math.floor(vp.height));
    const task = page.render({ canvasContext: t.getContext('2d'), viewport: vp });
    this.renderTask = task; this.drawingPage = n;
    let ok = true;
    try { await task.promise; } catch (err) { ok = false; }
    if (this.renderTask === task) { this.renderTask = null; this.drawingPage = 0; }
    if (gen !== this.layoutGen || !ok) { t.width = 0; t.height = 0; if (!ok && gen === this.layoutGen && !s.stopped) s.thumbFailed = true; s.stopped = false; return; }
    if (!s.thumb) this.putThumb(s, this.geo[n], t);
    if (!s.canvas) { try { page.cleanup(); } catch (e) { /* drawing again */ } }
  }

  // Page n's text layer, made once a document (its spans are placed in % of the page and sized by --total-scale-factor,
  // so a zoom never makes it again). The text runs' boxes are kept in page units from what pdf.js gives (textBoxes), not
  // measured in the page: its column and the room a note typed beside its text has come from them.
  async drawText(n) {
    const s = this.sheets[n], page = this.pages[n], g = this.geo[n], doc = this.gen;
    if (!s || !page || !g) return;
    s.texting = true;
    let layer = null;
    try {
      const content = await this.texts.get(n);
      if (doc !== this.gen) return;
      this.textBoxes(n, content);
      layer = new pdfjsLib.TextLayer({ textContentSource: content, container: s.tl, viewport: page.getViewport({ scale: g.scale }) });
      this.textLayer = layer;
      await layer.render();
      if (doc !== this.gen) return;
      const end = document.createElement('div');
      end.className = 'endOfContent';
      s.tl.append(end);
    } catch (err) { /* a page without a text layer is still readable */ } finally {
      s.texting = false;
      if (layer && this.textLayer === layer) this.textLayer = null;
    }
    if (doc !== this.gen) return;
    s.texted = true;
    // The page's notes go by its printed text (its column, the room beside it), which only now is known.
    if ((this.marks[n] || []).length) s.marksW = null;
    this.textsDone();
  }

  // The first time every page of a document has its text: a search and a passage are found again, over all of it.
  textsDone() {
    if (this.textsAt === this.gen || this.sheets.some((s) => s && !s.texted)) return;
    this.textsAt = this.gen;
    if (this.findQuery) this.report(this.find(this.findQuery, 0, { scroll: false }));
    if (this.section) { this.section.spot = this.sectionStart(this.section.text).spot; this.paintSection(); }
    const text = this.gate.drawn();
    if (text) this.applyTarget(text);
  }

  // Page n's text runs as boxes in page units ({ l, t, r, b }, fractions of the page's width), from pdf.js's text content
  // (no layout asked of the page), and its column from them (./canvas.js textColumn). Upright text only: a stamp up the
  // margin is no part of a column.
  textBoxes(n, content) {
    const v0 = this.v0[n];
    if (!v0 || !content || !Array.isArray(content.items)) return;
    const W = v0.width || 1, boxes = [], lefts = [], rights = [];
    for (const it of content.items) {
      if (!it || typeof it.str !== 'string' || !it.str.trim() || !Array.isArray(it.transform)) continue;
      const tx = pdfjsLib.Util && pdfjsLib.Util.transform ? pdfjsLib.Util.transform(v0.transform, it.transform) : null;
      if (!tx || Math.abs(tx[1]) > 1e-3 || Math.abs(tx[2]) > 1e-3) continue;
      const h = Math.hypot(tx[2], tx[3]), x = tx[4], base = tx[5], w = Number(it.width) || 0;
      if (!(w > 0) || !(h > 0)) continue;
      const box = { l: x / W, t: (base - h) / W, r: (x + w) / W, b: base / W };
      boxes.push(box);
      if (it.str.trim().length >= 3) { lefts.push(box.l); rights.push(box.r); }
    }
    this.textRects.set(n, boxes);
    const col = textColumn(lefts, rights);
    if (col) this.cols.set(n, col);
    // A note of the page before can lie over this one (pageOver): laid out again now its text is known.
    const prev = this.sheets[n - 1];
    if (col && prev && prev.cards && this.drawn[n - 1] && prev.marksW === this.pdfW) this.arrange(n - 1);
  }

  // The page whose sheet holds the vertical middle of the view.
  currentPage() {
    const host = this.host.current;
    if (!host || !this.tops.length) return 0;
    return pageAt(this.tops, (host.scrollTop + host.clientHeight / 2) / this.css);
  }

  syncBar() {
    const next = { page: this.currentPage(), pages: this.tops.length, pct: this.pct() };
    const s = this.state;
    if (next.page !== s.page || next.pages !== s.pages || next.pct !== s.pct) this.setState(next);
  }

  /* ---------------------------------------------------------------- find */
  /** `step` 0: a new query starts at the first match in view or below (the same query keeps its place);
   *  1 / -1: the next / previous match, wrapping. '' stops. `fromStart`: counted from page 1 (a link's passage).
   *  Answers { matches, active } (active from 1). Where it lands: ../model/find.js nextFind. */
  find(query, step = 0, { scroll = true, fromStart = false } = {}) {
    const text = String(query || '');
    if (!text.trim()) { this.stopFind(); return { matches: 0, active: 0 }; }
    const fresh = text !== this.findQuery;
    this.findQuery = text;
    const pages = this.pageTexts();
    this.findSpots = this.matchSpots(text, pages);
    this.findRanges = [];
    const spots = [];
    for (const spot of this.findSpots) {
      const range = this.rangeIn(pages, spot.page, spot.from, spot.to);
      if (range) { this.findRanges.push(range); spots.push(spot); }
    }
    this.findSpots = spots;
    const plan = nextFind({ fresh, step, count: this.findRanges.length, at: this.findAt, fromStart, firstInView: () => this.firstInView() });
    this.findAt = plan.at;
    this.paintFind(scroll && plan.scroll);
    return { matches: this.findRanges.length, active: this.findAt + 1 };
  }

  // A link's passage, every page drawn: shown as a section from page 1 (`target`, `targetTo`). Told through onTarget alone:
  // find has not been asked anything.
  applyTarget(key) {
    const [text, to = ''] = String(key).split('\n');
    const result = this.showSection(text, to);
    if (typeof this.props.onTarget === 'function') this.props.onTarget(text, result);
  }

  // Where a section starts: its words' first match from page 1, as find counts them (one with a range) → { spot, range,
  // matches }; `spot` null when they are nowhere.
  sectionStart(text, pages = this.pageTexts()) {
    let first = null, matches = 0;
    for (const spot of this.matchSpots(text, pages)) {
      const range = this.rangeIn(pages, spot.page, spot.from, spot.to);
      if (!range) continue;
      matches += 1;
      if (!first) first = { spot, range };
    }
    return { spot: first ? first.spot : null, range: first ? first.range : null, matches };
  }

  /** A section (2026-10-03, apart from find): its start words `find` found from page 1 and scrolled to, and tinted to just
   *  before `to` (paintSection). Answers { matches, active } as find would; nothing matching clears it and leaves the scroll. */
  showSection(find, to = '') {
    const text = String(find || '');
    if (!text.trim()) { this.clearSection(); return { matches: 0, active: 0 }; }
    const { spot, range, matches } = this.sectionStart(text);
    if (!spot) { this.clearSection(); return { matches: 0, active: 0 }; }
    this.section = { text, to: String(to || ''), spot };
    this.paintSection();
    this.scrollToRange(range);
    return { matches, active: 1 };
  }

  clearSection() {
    this.section = null;
    paintSection(highlights(), [], null);
  }

  // The section from its start words to just before the first match of `to` after them, one range a page
  // (../model/find.js sectionSpans). No `to`, `to` nowhere after them, or too far on: the start words alone are tinted.
  paintSection() {
    const h = highlights();
    if (!h) return;
    const s = this.section, start = s && s.spot;
    const pages = start ? this.pageTexts() : [];
    const spans = start ? (s.to && sectionSpans(start, this.matchSpots(s.to, pages))) || [start] : [];
    paintSection(h, spans.map((span) => this.rangeIn(pages, span.page, span.from, span.to)).filter(Boolean), Highlight);
  }

  stopFind() {
    this.findQuery = '';
    this.findAt = -1;
    this.findRanges = [];
    this.findSpots = [];
    clearFind(highlights());
  }

  report(result) { if (typeof this.props.onFind === 'function') this.props.onFind(result); }

  // Each page's text layer as one string (a line break is \n) → [{ page, layer, joined, locate }]; `locate(index, end)`
  // is the text node and offset at that index (`end`: the end of a stretch, so a node starting there is not it).
  pageTexts() {
    const host = this.host.current;
    if (!host) return [];
    return [...host.querySelectorAll('[data-text-layer]')].map((layer) => this.layerText(layer));
  }
  // One text layer's text (pageTexts); `indexOf(node, offset)` is where a point in one of its text nodes is in `joined`
  // (null in none of them).
  layerText(layer) {
    const nodes = [];
    let joined = '';
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) { nodes.push({ node, start: joined.length }); joined += node.data; }
      else if (node.nodeName === 'BR') joined += '\n';
    }
    const locate = (index, end) => {
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const { node, start } = nodes[i];
        if (end ? start < index : start <= index) return { node, offset: Math.min(index - start, node.data.length) };
      }
      return null;
    };
    const indexOf = (node, offset) => { const at = nodes.find((x) => x.node === node); return at ? at.start + offset : null; };
    return { page: Number(layer.dataset.textLayer), layer, joined, locate, indexOf };
  }

  // Where a query matches, page by page in order → [{ page, from, to }].
  matchSpots(query, pages = this.pageTexts()) {
    const pattern = findPattern(query);
    const spots = [];
    for (const { page, joined } of pages) {
      pattern.lastIndex = 0;
      for (let m = pattern.exec(joined); m; m = pattern.exec(joined)) {
        if (!m[0]) { pattern.lastIndex += 1; continue; }
        spots.push({ page, from: m.index, to: m.index + m[0].length });
      }
    }
    return spots;
  }

  // A Range over one page's text, from `from` to `to` (null: to the end of the page); null when there is nothing there.
  rangeIn(pages, page, from, to) {
    const at = pages.find((p) => p.page === page);
    if (!at) return null;
    const a = at.locate(from, false), b = to == null ? null : at.locate(to, true);
    if (!a || (to != null && !b)) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    if (b) range.setEnd(b.node, b.offset); else range.setEnd(at.layer, at.layer.childNodes.length);
    return range.collapsed ? null : range;
  }

  firstInView() {
    const host = this.host.current;
    if (!host) return 0;
    const top = host.getBoundingClientRect().top;
    const i = this.findRanges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
    return i < 0 ? 0 : i;
  }

  paintFind(scroll) {
    const h = highlights();
    const active = this.findRanges[this.findAt];
    if (h) {
      h.set(FIND, new Highlight(...this.findRanges.filter((range) => range !== active)));
      const on = new Highlight(...(active ? [active] : []));
      on.priority = 1;
      h.set(FIND_ACTIVE, on);
    }
    if (scroll) this.scrollToRange(active);
  }

  // A range out of view is brought a third of the way down (and across) the pane.
  scrollToRange(range) {
    const host = this.host.current;
    if (!range || !host) return;
    const box = host.getBoundingClientRect(), r = range.getBoundingClientRect();
    if (r.top < box.top + 24 || r.bottom > box.bottom - 24) host.scrollTop += r.top - box.top - host.clientHeight / 3;
    if (r.left < box.left || r.right > box.left + host.clientWidth) host.scrollLeft += r.left - box.left - host.clientWidth / 3;
  }

  /* ---------------------------------------------------------------- selection → marks */
  // The text layers a selection touches are .selecting (LAYER_CSS .endOfContent): `layers` (default: every one in this
  // viewer) stop being so, their .endOfContent back at their end. Electron 44's Chromium is 152; pdf.js moves the box next
  // to the selection's anchor only before Chromium 148, so that part of TextLayerBuilder is left out.
  endSelecting(layers) {
    const host = this.host.current;
    for (const tl of layers || (host ? host.querySelectorAll('[data-text-layer]') : [])) {
      tl.classList.remove('selecting');
      const end = tl.querySelector(':scope > .endOfContent');
      if (end && end !== tl.lastChild) tl.append(end);
    }
  }
  trackSelecting() {
    const host = this.host.current, sel = document.getSelection();
    if (!host) return;
    const ranges = [];
    for (let i = 0; sel && i < sel.rangeCount; i += 1) ranges.push(sel.getRangeAt(i));
    for (const tl of host.querySelectorAll('[data-text-layer]')) {
      if (ranges.some((range) => range.intersectsNode(tl))) tl.classList.add('selecting');
      else if (tl.classList.contains('selecting')) this.endSelecting([tl]);
    }
  }

  // A range cut into one a page: for each text layer in this viewer it touches, the range from the layer's start where it
  // began on an earlier page, to the layer's end where it goes on to a later one. → [{ page, layer, range }] in page order.
  pageRanges(range) {
    const host = this.host.current;
    if (!host) return [];
    const out = [];
    for (const tl of host.querySelectorAll('[data-text-layer]')) {
      if (!range.intersectsNode(tl)) continue;
      const part = range.cloneRange();
      if (!tl.contains(range.startContainer)) part.setStart(tl, 0);
      if (!tl.contains(range.endContainer)) part.setEnd(tl, tl.childNodes.length);
      if (!part.collapsed) out.push({ page: Number(tl.dataset.textLayer), layer: tl, range: part });
    }
    return out;
  }

  // Client rects are divided by this.css so geometry is in the layout's own pixels mid-pinch too. A fully selected span
  // gives its own box and its text's (they differ in height), and spans can overlap, so the rects are merged into one
  // box per stretch of a line (./marks.js) before anything is drawn or stored. A selection across pages (MATH-14) is one
  // part a page (pageRanges, ./marks.js selectionParts), each measured against its own page's text layer; a page that
  // gives no rects has no part.
  pdfMouseUp(e) {
    const wrap = e.target.closest && e.target.closest('[data-pdf] [data-page]');
    if (!wrap) return;
    if (e.target.closest('textarea, [data-note-view], [data-box]')) return;
    const sel = getSelection(), css = this.css || 1;
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      // Whole words at both ends (2026-10-06): the selection is snapped out before anything is measured or kept.
      const range = this.snapWords(sel.getRangeAt(0));
      sel.removeAllRanges(); sel.addRange(range);
      const cut = this.pageRanges(range);
      this.hideLive();
      if (!cut.length) { this.clearPending(); return; }
      this.endSelecting(); // the pointer is up: no .endOfContent covers a layer while it is measured
      const text = sel.toString();
      const parts = this.partsOf(cut, text, css);
      if (!parts.length) return;
      this.pendingSel = { parts, text };
      this.showPending(); sel.removeAllRanges();
      return;
    }
    const down = this.pdfDown, still = !!down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < PRESS_MOVE;
    if (!still) return;
    // A click on a highlight (MATH-15) shows which note is its; a click anywhere else puts that away. Typing anywhere
    // (2026-10-16, as before MATH-27; a double-click since 2026-10-06): a click that put nothing away, on anything but the
    // printed words, the page's or the desk beside it, writes a note there.
    const n = Number(wrap.dataset.page), box = wrap.getBoundingClientRect(), x = (e.clientX - box.left) / css, y = (e.clientY - box.top) / css;
    const hit = this.markAt(n, x, y);
    if (hit) { this.focusMark(hit.id); return; }
    if (this.focusId) this.focusMark(null);
    if (down.closed || e.button !== 0 || e.target.closest('.pdf-text span')) return;
    this.writeAt(n, x, y);
  }

  // A selection's parts, a page each (./marks.js selectionParts): its boxes in the layout's px (client rects over the
  // pinch's scale), merged into one band a stretch of a line.
  partsOf(cut, text, css = this.css || 1) {
    return selectionParts(cut.map(({ page, layer, range: part }) => {
      const box = layer.getBoundingClientRect();
      const rects = textRects(part).filter((r) => r.width > 1 && r.height > 1)
        .map((r) => ({ x: (r.left - box.left) / css, y: (r.top - box.top) / css, w: r.width / css, h: r.height / css }));
      return { page, rects, width: box.width / css, text: cut.length > 1 ? rangeText(part) : text, u: this.geom(page).pageW };
    }));
  }
  // A selection being made in the paper's text is drawn as the bands it will be kept as (2026-10-16, later), a frame at
  // a time: the browser's own paint of it is hidden (LAYER_CSS ::selection), its word boxes overlapping darker and its
  // line breaks a dashed line down the page's left. A selection elsewhere, or none, takes them away.
  liveSoon() {
    if (this.liveRaf || typeof requestAnimationFrame !== 'function') return;
    this.liveRaf = requestAnimationFrame(() => { this.liveRaf = 0; this.liveSelection(); });
  }
  liveSelection() {
    const host = this.host.current, sel = document.getSelection();
    if (!host) return;
    const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
    const cut = range && host.contains(range.commonAncestorContainer) ? this.pageRanges(range) : [];
    this.hideLive();
    if (!cut.length) return;
    this.drawParts(this.partsOf(cut, ''), 'live');
  }
  hideLive() { const host = this.host.current; if (host) host.querySelectorAll('[data-live]').forEach((n) => n.remove()); }

  /* ---------------------------------------------------------------- typing anywhere (2026-10-16) */
  // A note at (x, y) of page n's sheet (layout px), with the caret in it: as wide as there is room for it to the right,
  // up to the printed text there or the edge of the pane as it shows now (freeWidthAt), screen px, and it grows down from
  // there. One begun so near the pane's right edge that even FREE_MIN would not show starts that much further left: in the
  // margin, narrow and tall, rather than over the printed column (FREE_FIT there covered it).
  writeAt(n, x, y) {
    const g = this.geo[n], s = this.sheets[n], host = this.host.current;
    if (!g || !s) return null;
    if (s.marksW !== this.pdfW) this.renderMarks(n); // its notes laid out for the pane as it is, as this one will be
    this.clearPending();
    const left = host ? host.scrollLeft : 0, right = left + (this.pdfW || 0) - EDGE_PAD;
    x = Math.max(left + EDGE_PAD, Math.min(x, right - FREE_MIN * this.boxScale(n)));
    const m = this.addMark({ page: n, rects: [], side: null, y: clamp(y, 0, g.pageH), text: '' }, '', { x, y: clamp(y, 0, g.pageH), w: this.freeWidthAt(n, x, y) });
    const ta = this.find1(`textarea[data-mark="${m.id}"]`);
    if (ta) ta.focus({ preventScroll: true });
    requestAnimationFrame(() => this.revealCard(m.id));
    return m;
  }
  // The width (note px) a note typed at (x, y) of page n's sheet gets (./canvas.js freeNoteWidth, its room measured in
  // the sheet's px).
  freeWidthAt(n, x, y) {
    const host = this.host.current, edge = (host ? host.scrollLeft : 0) + (this.pdfW || 0);
    return freeNoteWidth(x, this.textAfter(n, x, y - POS_DY, 29), edge, this.boxScale(n));
  }
  // The left edge (the sheet's px) of the nearest printed text right of x on the band y .. y + h, from the page's text
  // runs (textBoxes) at the zoom now; Infinity with none, or before the page's text is known.
  textAfter(n, x, y, h) {
    const boxes = this.textRects.get(n);
    if (!boxes) return Infinity;
    const { G, pageW: P } = this.geom(n);
    let best = Infinity;
    for (const b of boxes) {
      const l = G + b.l * P;
      if (b.b * P < y || b.t * P > y + h) continue;
      if (l > x && l < best) best = l;
    }
    return best;
  }

  // A selection's range widened to whole words at both ends (./marks.js wordBounds), each end in its own page's text layer.
  // An end that is not in a text node (past a line, in a margin) stays where it is.
  snapWords(range) {
    const out = range.cloneRange();
    const textAt = (node) => {
      const layer = node && node.nodeType === Node.TEXT_NODE && node.parentElement && node.parentElement.closest('[data-text-layer]');
      return layer ? this.layerText(layer) : null;
    };
    const a = textAt(range.startContainer), ai = a && a.indexOf(range.startContainer, range.startOffset);
    if (ai != null) { const to = a.locate(wordBounds(a.joined, ai, ai).from, false); if (to) out.setStart(to.node, to.offset); }
    const b = textAt(range.endContainer), bi = b && b.indexOf(range.endContainer, range.endOffset);
    if (bi != null) { const to = b.locate(wordBounds(b.joined, bi, bi).to, true); if (to) out.setEnd(to.node, to.offset); }
    return out;
  }

  // Whether page n's text runs are known (textBoxes): a note typed beside its text is measured against them.
  textDrawn(page) { return this.textRects.has(page); }
  // Page n's text column in page units (./canvas.js textColumn), from its text runs (textBoxes); null until they are
  // known, when cards go against the page's edge.
  columnOf(page) { return this.cols.get(page) || null; }
  // The page under y px of page n's sheet (y past its foot is a later page's, above its top an earlier one's).
  pageOver(n, y) {
    const abs = (this.tops[n - 1] || 0) + y, N = this.tops.length;
    let q = n;
    while (q < N && this.tops[q] <= abs) q += 1;
    while (q > 1 && this.tops[q - 1] > abs) q -= 1;
    return q;
  }

  // Nothing has the keyboard (2026-10-06): it is on the page itself, or on something of the paper's that is no field,
  // button or link. A note's field, a button (the Stage's, the sidebar's, an answer's Copy) or the document keeps its keys.
  keyFree(t) {
    if (!t || t === document || t === document.body || t === document.documentElement) return true;
    const host = this.host.current;
    return !!(host && host.contains(t) && !(t.closest && t.closest(CONTROL)));
  }

  // ⌘Z (or Ctrl+Z) after a press in this pane, nothing having the keyboard: the answer deleted last comes back (one gone
  // meanwhile is passed over). With nothing to bring back the key is the app's.
  undoKey(e) {
    if (!this.undos.length || !this.downHere || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 'z' || !this.keyFree(e.target)) return false;
    if (!this.undo()) return false;
    e.preventDefault();
    return true;
  }
  // What ⌘Z brings back: the last thing taken that is still to be had, a removed mark with all its parts at once (undoRemoval).
  undo() {
    while (this.undos.length) {
      const last = this.undos[this.undos.length - 1];
      if (last.kind === 'mark') { if (this.undoRemoval(last.batch)) return true; continue; }
      if (this.restoreAsk(this.undos.pop())) return true;
    }
    return false;
  }
  restoreAsk({ page, markId, askId }) {
    const m = ((this.marks || {})[page] || []).find((x) => x && x.id === markId);
    const a = m && (m.asks || []).find((x) => x && x.id === askId && x.deleted);
    if (!a) return false;
    delete a.deleted;
    this.renderMarks(page);
    this.scheduleSave();
    return true;
  }

  // Backspace or Delete with a highlight in focus (MATH-15), after a press in this pane and nothing having the keyboard:
  // the mark goes (removeMark). Typing in its note keeps the key, since the note's field has the keyboard.
  markKey(e) {
    if (!this.focusId || !this.downHere || (e.key !== 'Backspace' && e.key !== 'Delete') || e.metaKey || e.ctrlKey || e.altKey || !this.keyFree(e.target)) return false;
    const found = this.findMark(this.focusId);
    if (!found) return false;
    e.preventDefault();
    this.removeMark(found.page, found.m);
    return true;
  }

  // ⌘C (or Ctrl+C) with nothing else selected and nothing having the keyboard (2026-10-08): a selection on the page is
  // taken off the page once the pointer is up (it is pending, see pdfMouseUp), so the app's Copy found nothing. Its text
  // is copied, else, after a press in this pane, the passage of the highlight in focus.
  copyKey(e) {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || String(e.key).toLowerCase() !== 'c' || !this.keyFree(e.target)) return false;
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return false;
    const found = !this.pendingSel && this.focusId && this.downHere ? this.findMark(this.focusId) : null;
    const text = this.pendingSel ? this.pendingSel.text : found ? passageOf(this.marks, found.m) : '';
    if (!String(text || '').trim()) return false;
    e.preventDefault();
    const copy = this.props.onCopyText || ((t) => navigator.clipboard.writeText(t));
    Promise.resolve().then(() => copy(text)).catch(() => {});
    return true;
  }

  pendingSelKey(e) {
    const p = this.pendingSel; if (!p) return false;
    if (!this.keyFree(e.target)) return false;
    if (e.key === 'Escape') { this.clearPending(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); this.addMark(p, null); this.clearPending(); return true; }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const m = this.addMark(p, e.key); this.clearPending();
      // The keyboard goes to the note now, not a frame later (2026-10-16): the next key, typed fast, was lost on the way.
      // This key's own character is not typed twice: its default is prevented above.
      const ta = m && this.find1(`textarea[data-mark="${m.id}"]`);
      if (ta) { ta.focus({ preventScroll: true }); ta.setSelectionRange(ta.value.length, ta.value.length); }
      requestAnimationFrame(() => { if (m) this.revealCard(m.id); });
      return true;
    }
    return false;
  }

  // The pending selection (bands, see pdfMouseUp), each part drawn into its page's highlight layer until a note is
  // typed or it is dismissed. Over an existing highlight it is drawn on top of it. `page`: that page's part only.
  showPending(page) {
    const p = this.pendingSel; if (!p) return;
    if (page == null) this.hidePending();
    this.drawParts(page == null ? p.parts : p.parts.filter((part) => part.page === page), 'pending');
  }
  // Parts of a selection drawn on their pages' highlight layers, each a group marked `data-<tag>` (pending, live).
  drawParts(parts, tag) {
    for (const part of parts) {
      const hl = this.find1(`[data-hl="${part.page}"]`); if (!hl) continue;
      // The highlight layer is drawn in desk px (renderMarks): the part's px of a page `u` wide, taken there.
      const g = document.createElementNS(SVG, 'g'), f = this.desk(part.page).pageW / (part.u || this.geom(part.page).pageW || 1);
      g.dataset[tag] = '1';
      for (const r of part.rects) {
        const el = document.createElementNS(SVG, 'rect');
        el.setAttribute('x', r.x * f); el.setAttribute('y', r.y * f); el.setAttribute('width', r.w * f); el.setAttribute('height', r.h * f); el.setAttribute('fill', 'rgba(0,112,243,.22)');
        g.appendChild(el);
      }
      hl.appendChild(g);
    }
  }
  hidePending() { const host = this.host.current; if (host) host.querySelectorAll('[data-pending]').forEach((n) => n.remove()); }
  clearPending() { this.pendingSel = null; this.hidePending(); }

  // p carries pixel geometry from the current layout; the stored marks are in page units. A free note (`pos`) is p.page's
  // alone. A selection (`p.parts`) is one mark a part, on its own page (./marks.js partMarks): the parts of a selection
  // across pages share a `group` id, and only the first has the note. Each is placed among its page's marks (./marks.js
  // placeHighlight): inside one already there it adds nothing, and overlapping ones without notes become one. Answers
  // the mark that holds the first part (or the free note), whose note a caller may focus.
  addMark(p, note, pos) {
    if (pos) {
      const { G, pageW } = this.geom(p.page), u = pageW || 1;
      const m = { id: markId(), rects: [], side: p.side, y: p.y / u, note, text: p.text, pos: { x: (pos.x - G) / u, y: pos.y / u } };
      if (pos.w) m.w = pos.w; // screen px, measured where it was written (writeAt)
      this.editing = m.id; // a new note opens as its field, for the caller to focus
      this.marks[p.page] = [...(this.marks[p.page] || []), m];
      this.renderMarks(p.page);
      // Not saved while it is empty (2026-10-06, canvas.js keptMarks): the first thing typed in it saves it, and left
      // empty it goes (leaveNote).
      return m;
    }
    let first = null;
    for (const { page, mark } of partMarks(p.parts, note, markId, (n) => this.geom(n).pageW)) {
      const placed = placeHighlight(this.marks[page] || [], mark);
      this.marks[page] = placed.list;
      if (!first) {
        first = placed.mark;
        if (note != null) this.editing = first.id;
      }
      this.renderMarks(page);
    }
    this.scheduleSave();
    return first;
  }

  /* ---------------------------------------------------------------- removing a mark (MATH-66) */
  /** The mark `id` and its page, or null. */
  findMark(id) {
    for (const [page, list] of Object.entries(this.marks || {})) {
      const m = (list || []).find((x) => x && x.id === id);
      if (m) return { page: Number(page), m };
    }
    return null;
  }
  // Mark m of page n taken away, with every part of its selection across pages (`group`), no question asked: an answer
  // still being written on any of them is stopped first, as its Stop button would, so none lands on a mark that is gone.
  // Each part goes onto the undos where it stood ({ kind: 'mark', page, mark, index }, the parts one `batch`), and the
  // toast says so. The mark object itself is kept there, its note, answers and place with it.
  removeMark(page, m) {
    if (!m) return false;
    const parts = [];
    if (m.group) {
      for (const [n, list] of Object.entries(this.marks || {})) for (const x of list || []) if (x && x.group === m.group) parts.push({ page: Number(n), mark: x });
    } else if (((this.marks || {})[page] || []).includes(m)) parts.push({ page, mark: m });
    if (!parts.length) return false;
    const ids = new Set(parts.map((p) => p.mark.id));
    for (const p of Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : []) {
      if (p && p.askId && ids.has(p.markId) && p.error == null && this.props.onStopAsk) this.props.onStopAsk(p.askId);
    }
    const batch = markId('r'), pages = new Set();
    for (const { page: n, mark } of parts) {
      const list = this.marks[n], index = list.indexOf(mark);
      list.splice(index, 1);
      this.undos.push({ kind: 'mark', page: n, mark, index, batch });
      pages.add(n);
    }
    if (ids.has(this.editing)) this.editing = null;
    if (this.state.mention && ids.has(this.state.mention.markId)) this.closeMention();
    this.focusId = null;
    for (const n of pages) this.renderMarks(n);
    this.paintFocus(null);
    this.scheduleSave();
    const first = parts.find((p) => p.mark.note != null) || parts[0];
    this.showRemoved(batch, (first.mark.rects || []).length ? 'Highlight removed' : 'Note removed');
    return true;
  }
  // A removal undone (⌘Z, or the toast's Undo): every part of `batch` taken off the undos and put back at its index, the
  // last taken first so the indices hold. → whether one came back (one there again already is passed over).
  undoRemoval(batch) {
    const parts = this.undos.filter((u) => u.kind === 'mark' && u.batch === batch);
    if (!parts.length) return false;
    this.undos = this.undos.filter((u) => !parts.includes(u));
    const pages = new Set();
    for (const { page, mark, index } of parts.reverse()) {
      const list = this.marks[page] || (this.marks[page] = []);
      if (list.some((x) => x && x.id === mark.id)) continue;
      list.splice(Math.max(0, Math.min(index, list.length)), 0, mark);
      pages.add(page);
    }
    if (this.state.removed && this.state.removed.batch === batch) this.hideRemoved();
    if (!pages.size) return false;
    for (const n of pages) this.renderMarks(n);
    this.scheduleSave();
    return true;
  }
  // The toast (about REMOVED_MS): "Highlight removed · Undo", or "Note removed · Undo" for a free note.
  showRemoved(batch, label) {
    clearTimeout(this.removedTimer);
    this.setState({ removed: { batch, label } });
    this.removedTimer = setTimeout(() => { this.removedTimer = null; this.setState({ removed: null }); }, REMOVED_MS);
  }
  hideRemoved() {
    clearTimeout(this.removedTimer);
    this.removedTimer = null;
    if (this.state.removed) this.setState({ removed: null });
  }

  // Every page's marks drawn again (the library renamed an item, other marks came): the pages near the view now, the rest
  // as drawPages comes to them (2026-10-16; every page was drawn at once before).
  renderAllMarks() {
    const host = this.host.current; if (!host) return;
    this.libDrawn = this.libKey();
    const r = this.viewRange();
    for (let n = 1; n < this.sheets.length; n += 1) {
      const s = this.sheets[n];
      if (!s) continue;
      if (!r || !tooFar(n, r.first, r.last, DRAW_AHEAD)) this.renderMarks(n); else s.marksW = null;
    }
    this.drawSoon();
  }

  // Highlights are drawn once a page: each mark's boxes joined into bands across its word gaps (./marks.js bandRects,
  // 2026-10-16), every mark's bands merged (mergeLineRects), one zigzag a band, seeded by where it is so it keeps its
  // shape between draws. Marks overlapping each other, or saved with doubled rects, draw no darker. A note being typed in
  // when its page is drawn again (a mark added beside it, a rename) has the keyboard back after.
  // Cards (MATH-27; one a mark since 2026-10-06): a mark with a note, an answer (`asks`) or an answer being written
  // (`pendingAsks`) is one card holding them all, in that order (cardBox). A card is where it was moved to (the mark's
  // `pos`), else beside its highlight, on its `side`; the cards not moved are then spaced (arrange).
  // Highlights are drawn in desk px, a px of 100% for the pane as it is now (2026-10-16): the highlight layer's viewBox
  // takes any zoom after this without their being drawn again. Cards are screen-sized (2026-10-16, later): a zoom lays
  // them out again where they go (arrangePages), never draws them again.
  renderMarks(page) {
    const hl = this.find1(`[data-hl="${page}"]`), notes = this.find1(`[data-notes="${page}"]`), sheet = this.sheets[page], g = this.geo[page];
    if (!hl || !notes) return;
    if (sheet && g && this.pdfW && sheet.deskW !== this.pdfW) { sheet.deskW = this.pdfW; g.k = g.pageW / this.pdfW; this.place(page); }
    if (sheet) sheet.marksW = this.pdfW;
    const { pageW: P } = this.desk(page), H = (this.geom(page).pageH || 0) / (this.geom(page).k || 1);
    const active = document.activeElement;
    const had = active && active.tagName === 'TEXTAREA' && notes.contains(active) ? { id: active.dataset.mark, a: active.selectionStart, b: active.selectionEnd } : null;
    this.redrawing += 1;
    try { hl.innerHTML = ''; notes.innerHTML = ''; } finally { this.redrawing -= 1; }
    if (P > 0 && H > 0) hl.setAttribute('viewBox', `0 0 ${P} ${H}`);
    const rc = rough ? rough.svg(hl) : null;
    const list = (this.marks || {})[page] || [];
    for (const b of mergeLineRects(list.flatMap((m) => bandRects(m.rects || [])))) {
      const r = { x: b.x * P, y: b.y * P, w: b.w * P, h: b.h * P };
      if (rc) hl.appendChild(rc.rectangle(r.x, r.y + r.h * 0.12, r.w, r.h * 0.76, { fill: 'rgba(0,112,243,.16)', fillStyle: 'zigzag', fillWeight: 1.3, hachureGap: 2.4, hachureAngle: -4, stroke: 'none', roughness: 0.9, seed: boxSeed(page, b) }));
      else { const d = document.createElementNS(SVG, 'rect'); d.setAttribute('x', r.x); d.setAttribute('y', r.y); d.setAttribute('width', r.w); d.setAttribute('height', r.h); d.setAttribute('fill', 'rgba(0,112,243,.12)'); hl.appendChild(d); }
    }
    const boxes = [], units = [], running = this.pendingOn(page);
    for (const m of list) {
      const asks = shownAsks(m), runs = running.filter((p) => p.markId === m.id);
      if (m.note == null && !asks.length && !runs.length) continue;
      const side = m.side === 'left' ? 'left' : 'right';
      const el = this.cardBox(m, asks, runs, page);
      notes.appendChild(el);
      const b = { el, m, page, fixed: !!m.pos, pos: m.pos || null, how: 'pos', left: 0, top: 0, width: 0, height: 0, want: this.cardWidth(m, page), typing: this.typingIn(m, asks, runs), w: null };
      if (!m.pos) { b.how = side; units.push({ id: m.id, side, boxes: [b] }); }
      boxes.push(b);
    }
    this.drawn[page] = { boxes, units };
    if (sheet) sheet.cards = boxes.length;
    this.arrange(page);
    // Clearing the highlight layer took the pending selection with it, and the mark in focus with it (MATH-15).
    this.showPending(page);
    if (this.focusId) this.paintFocus(this.focusId);
    if (had) {
      const ta = notes.querySelector(`textarea[data-mark="${had.id}"]`);
      if (ta) { ta.focus({ preventScroll: true }); try { ta.setSelectionRange(had.a, had.b); } catch { /* not a text field */ } }
    }
    const open = this.state.mention;
    if (open && open.page === page) {
      const ta = notes.querySelector(`textarea[data-mark="${open.markId}"]`);
      if (ta && document.activeElement === ta) this.setState({ mention: { ...open, anchor: fieldCaret(ta, undefined, this.boxScale(page)) } }); else this.closeMention();
    }
  }

  /* ---------------------------------------------------------------- cards (MATH-27) */
  // Where the cards go (2026-10-16, later; Hudson: "i should be able to see all annotations if i can see any vertical
  // position y at all times, irrespective of zoom and position it was left x"). A card is laid out in note px and drawn
  // at its page's noteScale (third round: the size of the paper's text, never under NOTE_FLOOR); in the sheet's px:
  // - a highlight's card goes against the text's column (a left one's right edge to it, SIDE_GAP off), at its highlight's
  //   height, as wide as there is room for between the text and the pane's side (./canvas.js fitWidth, NOTE_MIN..NOTE_W).
  //   Its highlight's margin, unless that one has less room than NOTE_MIN and the other has more, or that one is full
  //   where it wants to be and the other would keep it nearer (./marks.js stackNotes). With less room than NOTE_MIN on
  //   both sides it keeps NOTE_MIN and is moved in over the text. Then the cards are spaced, each as high as it wants with
  //   BOX_GAP from any card it shares x with (./canvas.js spaceBoxes).
  // - a card that was moved, or typed anywhere, starts where it was put (`pos`). In the left margin it is as wide as the
  //   room to the text, down to FREE_FIT, then moved out toward the pane's side rather than over the text (third round:
  //   "it overlaps and isn't in the margins"); one put against the text's right edge goes past it into the right margin;
  //   elsewhere narrowed to FREE_FIT and then moved in when the pane's side is nearer than its width.
  // A card whose margin shows less than HIDE_ROOM (zoomed in on the text alone) is hidden, not drawn over the text (round
  // 4: "if i zoom in such that there are no margins and it is just text the annotations shouldn't still show"); a sideways
  // scroll that brings its margin back shows it. This takes back round 2's "see all annotations … irrespective of zoom".
  // Every page's cards are given their widths, then measured (one layout for them all), then placed. A card being dragged
  // stays where the pointer has it.
  arrange(page) { this.arrangePages([page]); }
  // The cards of the pages near the view laid out now (a zoom, a sideways scroll); the others as drawPages comes to them.
  arrangeNear() {
    const r = this.viewRange();
    if (!r) return;
    const pages = [];
    for (let n = Math.max(1, r.first - DRAW_AHEAD); n <= Math.min(this.sheets.length - 1, r.last + DRAW_AHEAD); n += 1) {
      const sh = this.sheets[n];
      if (sh && sh.cards && sh.marksW === this.pdfW) pages.push(n);
    }
    if (pages.length) this.arrangePages(pages);
  }
  arrangePages(pages) {
    const host = this.host.current;
    if (!host) return;
    const key = this.cardKey(), x0 = this.viewX || 0, W = this.pdfW || host.clientWidth;
    const vL = x0 + EDGE_PAD, vR = x0 + W - EDGE_PAD;
    const work = [];
    for (const page of pages) {
      const model = this.drawn[page], g = this.geo[page], sh = this.sheets[page];
      if (!model || !g) continue;
      if (sh) sh.cardsAt = key;
      if (!model.boxes.length) continue;
      // Widths in note px (cardBox), rooms in the sheet's px over ns.
      const ns = this.boxScale(page), span = (vR - vL) / ns;
      if (sh) sh.notes.style.setProperty('--ns', String(ns));
      const col = this.columnOf(page), L = g.G + (col ? col.l : 0) * g.pageW, R = g.G + (col ? col.r : 1) * g.pageW;
      const roomL = (L - SIDE_GAP - vL) / ns, roomR = (vR - R - SIDE_GAP) / ns;
      const dragged = this.drag && this.drag.moved ? this.drag.b : null;
      for (const b of model.boxes) {
        if (b === dragged) continue;
        let w;
        if (b.fixed) {
          const at = placeOf(b.pos, g.G, g.pageW);
          b.ax = at.left; b.top = at.top;
          // The text it keeps clear of is the page it lies over: a note's `pos` can be past its own page's foot.
          const q = this.pageOver(page, b.top + POS_DY), cq = q === page ? col : this.columnOf(q), gq = this.geo[q] || g;
          const L = cq ? gq.G + cq.l * gq.pageW : col ? g.G + col.l * g.pageW : g.G, R = cq ? gq.G + cq.r * gq.pageW : col ? g.G + col.r * g.pageW : g.G + g.pageW;
          b.L = L;
          // One put in the left margin keeps to it: as wide as the room to the text, else moved out (placed below). One
          // put so near the text's right edge that not even FREE_MIN fits before it goes to the right margin, when that
          // has FREE_MIN of room (round 2 began a note near the pane's edge that far in).
          b.inLeft = b.ax < L - SIDE_GAP;
          if (!b.inLeft && b.ax < R + SIDE_GAP && b.ax + FREE_MIN * ns > R && (vR - R - SIDE_GAP) / ns >= FREE_MIN) b.ax = R + SIDE_GAP;
          const from = Math.max(b.ax, vL), room = ((b.inLeft ? L - SIDE_GAP : vR) - from) / ns; // from where it can show
          // In a margin it narrows to that margin's room (down to FREE_MIN) before it is moved over the text.
          const inRight = b.ax >= R + SIDE_GAP - 0.5, rL = (L - SIDE_GAP - vL) / ns, rR = (vR - R - SIDE_GAP) / ns;
          const least = b.inLeft ? Math.min(b.want, FREE_FIT, Math.max(FREE_MIN, rL)) : inRight ? Math.min(b.want, FREE_FIT, Math.max(FREE_MIN, rR)) : Math.min(b.want, FREE_FIT);
          w = fitWidth(b.want, room, least, span);
          // Hidden when its margin is out of view, or, put in the text's column, when its place is.
          b.hide = b.inLeft ? rL < HIDE_ROOM : inRight ? rR < HIDE_ROOM : b.ax < vL - 0.5 || b.ax > vR - FREE_MIN * ns;
        } else {
          // Its highlight's margin, unless that one is too narrow for NOTE_MIN and the other is not.
          const mine = b.how === 'left' ? roomL : roomR, other = b.how === 'left' ? roomR : roomL;
          b.side = mine < NOTE_MIN && other >= NOTE_MIN ? (b.how === 'left' ? 'right' : 'left') : b.how;
          w = fitWidth(b.want, b.side === 'left' ? roomL : roomR, NOTE_MIN, span);
        }
        if (b.w !== w) {
          b.w = w;
          if (b.typing) { b.el.style.width = `${w}px`; b.el.style.maxWidth = ''; } else { b.el.style.width = 'max-content'; b.el.style.maxWidth = `${w}px`; }
          for (const ta of b.el.querySelectorAll('textarea')) this.fitNote(ta);
        }
      }
      work.push({ page, model, g, L, R, dragged, ns, narrow: Math.min(roomL, roomR) < NOTE_MIN });
    }
    // Measured once for every page (one layout), then on screen: note px times ns.
    for (const { model, ns } of work) for (const b of model.boxes) { b.width = b.el.offsetWidth * ns; b.height = b.el.offsetHeight * ns; }
    // A card is hidden rather than drawn over the text (round 4): its margin shows less than HIDE_ROOM. Never the one
    // being typed in or dragged.
    const show = (b, hide) => {
      const off = !!hide && b.m.id !== this.editing && !(b.el.contains && b.el.contains(document.activeElement));
      b.hidden = off;
      const v = off ? 'hidden' : '';
      if (b.el.style.visibility !== v) b.el.style.visibility = v;
    };
    for (const { model, g, L, R, dragged, narrow, ns } of work) {
      const fixed = model.boxes.filter((b) => b.fixed);
      for (const b of fixed) {
        if (b !== dragged) b.left = Math.max(vL, Math.min(b.inLeft ? Math.min(b.ax, b.L - SIDE_GAP - b.width) : b.ax, vR - b.width));
        b.el.style.left = `${b.left}px`; b.el.style.top = `${b.top}px`;
        show(b, b !== dragged && b.hide);
      }
      const beside = model.units.filter((unit) => unit.boxes.length);
      // A full margin sends a note to the other one (./marks.js stackNotes), unless that one is too narrow to hold it.
      for (const unit of beside) { unit.want = Math.max(0, unit.boxes[0].m.y * g.pageW - 6); unit.at = unit.boxes[0].side || unit.side; }
      const sides = new Map([...stackNotes(beside.map((unit) => ({ id: unit.id, ideal: unit.want, h: unit.boxes.reduce((h, b, i) => h + b.height + (i ? BOX_GAP : 0), 0), side: unit.at })), { gap: BOX_GAP, ...(narrow ? { slack: Infinity } : {}) })].map(([id, at]) => [id, at.side]));
      for (const unit of beside) {
        const side = sides.get(unit.id) || unit.at;
        const room = side === 'left' ? (L - SIDE_GAP - vL) / ns : (vR - R - SIDE_GAP) / ns;
        for (const b of unit.boxes) {
          const want = side === 'left' ? L - SIDE_GAP - b.width : R + SIDE_GAP;
          b.left = Math.max(vL, Math.min(want, vR - b.width));
          show(b, room < HIDE_ROOM);
        }
      }
      // Hidden cards take no room from the others.
      const tops = spaceBoxes(beside.filter((unit) => !unit.boxes.every((b) => b.hidden)).map((unit) => ({ id: unit.id, want: unit.want, boxes: unit.boxes.map((b) => ({ left: b.left, width: b.width, height: b.height })) })), fixed.filter((b) => !b.hidden));
      for (const unit of beside) {
        let t = tops.has(unit.id) ? tops.get(unit.id) : unit.want;
        for (const b of unit.boxes) { b.top = t; b.el.style.left = `${b.left}px`; b.el.style.top = `${t}px`; t += b.height + BOX_GAP; }
      }
    }
  }

  // The width a card would be, note px (cardBox), before the pane's sides narrow it (arrangePages): a note typed anywhere keeps
  // the width it was written with (`w`, writeAt; one from before is measured against the text beside it at the zoom now),
  // a highlight's note NOTE_W, as narrow as its margin then makes it (2026-10-16, Hudson: "slightly less horizontal text
  // … take up the vertical space").
  cardWidth(m, page) {
    if (Number(m.w) > 0) return Number(m.w);
    if (m.pos && !(m.rects || []).length) {
      const g = this.geom(page), at = placeOf(m.pos, g.G, g.pageW || 1);
      return freeNoteWidth(at.left, this.textAfter(page, at.left, at.top + POS_DY, 29), Infinity, this.boxScale(page));
    }
    return NOTE_W;
  }
  // A card that keeps its whole width to type into: its note is being typed in (or is empty, or has nowhere for a
  // mention to go), or it holds answers. Others are as wide as what they hold, up to their width (cardBox).
  typingIn(m, asks, runs) {
    return (m.note != null && (this.editing === m.id || !String(m.note).trim() || !this.showsNotes())) || !!asks.length || !!runs.length;
  }

  // A mark's card (2026-10-06): its note (being typed in, empty, or with nowhere for a mention to go: its field; else its
  // text), then each answer (askSection) and each answer being written (runBox), with room, not a rule, between them
  // (2026-10-16). Nothing of the card itself shows but the move handle while the pointer is on it. Shown, it is only as
  // wide as what it holds, up to its width (arrangePages), and wraps there, growing down; a note being typed in keeps the
  // whole width to type into. Pointing at a card marks it and its
  // highlight (MATH-15), while the pointer is there.
  cardBox(m, asks, runs, page) {
    const width = Math.min(this.cardWidth(m, page), this.paneFit(page));
    const size = this.typingIn(m, asks, runs) ? `width:${width}px` : `width:max-content;max-width:${width}px`;
    const box = document.createElement('div');
    box.dataset.box = 'card'; box.dataset.boxMark = m.id; box.dataset.noteFor = m.id;
    box.style.cssText = `${BOX_LOOK};left:0;top:0;${size};display:flex;flex-direction:column;transition:opacity 120ms`;
    box.onmouseenter = () => this.paintFocus(m.id);
    box.onmouseleave = () => this.paintFocus(this.focusId);
    box.onmousedown = (ev) => ev.stopPropagation(); // not a press on the page: no new note, the pending selection stays
    let n = 0;
    if (m.note != null) { box.appendChild(this.noteSection(m, page)); n += 1; }
    for (const a of asks) box.appendChild(this.askSection(m, a, page, n++ > 0));
    for (const p of runs) box.appendChild(this.runBox(p, page, n++ > 0));
    // The move handle (2026-10-16, later; Hudson: "when I hover over text annotation there should be this icon in the lower
    // right corner"): pressed, the card is dragged, as a press on its words moved past PRESS_MOVE drags it.
    const grip = makeEl('div', '', { move: m.id });
    grip.innerHTML = MOVE_ICON;
    grip.title = 'Move';
    grip.onmousedown = (ev) => {
      ev.stopPropagation();
      if (ev.button !== 0) return;
      ev.preventDefault();
      const ta = document.activeElement;
      if (ta && ta.tagName === 'TEXTAREA' && box.contains(ta)) ta.blur();
      this.startDrag(ev, box, page);
    };
    box.appendChild(grip);
    return box;
  }

  // A card's note: its field or its text, with a little room under it. The field of a note that can ask Bart lies over a
  // backdrop of its own text (2026-10-06, model/doc.js noteInkHtml), where a leading @bart is the document's blue label:
  // the field's own text is transparent, its caret and selection are not, and the two wrap alike (same look, same width).
  noteSection(m, page) {
    const sec = makeEl('div', 'flex:none;padding-bottom:4px', { cardNote: '1' });
    if (this.editing === m.id || !String(m.note).trim() || !this.showsNotes()) {
      const ta = this.noteField(m, page), inked = this.asksFrom(m);
      ta.style.cssText = `${NOTE_LOOK};display:block;width:100%;box-sizing:border-box;margin:0;border:0;background:transparent;resize:none;overflow:hidden;outline:none${inked ? `;position:relative;color:transparent;caret-color:${NOTE_INK}` : ''}`;
      if (inked) {
        const ink = makeEl('div', `${NOTE_LOOK};position:absolute;left:0;top:0;right:0;bottom:0;box-sizing:border-box;margin:0;border:0;white-space:pre-wrap;overflow-wrap:break-word;overflow:hidden;pointer-events:none`, { noteInk: m.id });
        ink.setAttribute('aria-hidden', 'true');
        ta.onscroll = () => { ink.scrollTop = ta.scrollTop; };
        const both = makeEl('div', 'position:relative');
        both.append(ink, ta);
        sec.appendChild(both);
        this.inkNote(ta);
      } else sec.appendChild(ta);
    } else {
      const view = this.noteView(m, page);
      view.style.cssText = `${NOTE_LOOK};white-space:pre-wrap;overflow-wrap:break-word;cursor:text`;
      sec.appendChild(view);
    }
    return sec;
  }

  // An answer in its card: the question in grey when it is not what the note asks now (an earlier one of the thread,
  // canvas.js askedByNote) and the model, the answer (scrolling inside past 40% of the pane's height), then Continue in
  // workspace, Copy, Delete (⌘Z brings it back) and Collapse. Collapsed it is one line, "Bart ›". `divided`: below
  // something else of the card, with room between (a rule until 2026-10-16). In line with the note's words (6px in).
  askSection(m, a, page, divided) {
    const sec = document.createElement('div');
    sec.dataset.ask = String(a.id || '');
    sec.onclick = (ev) => this.askClick(ev, m, a, page);
    const line = divided ? `${ANSWER_GAP};` : '';
    if (a.collapsed) {
      sec.style.cssText = `${line}flex:none;padding:2px 6px`;
      sec.innerHTML = `<button type="button" data-act="expand" title="${esc(a.question || '')}" style="font-weight:500;color:#171717">Bart ›</button>`;
      return sec;
    }
    // the model that wrote it (a.meta) is kept but not shown (MATH-70 build 3)
    const lib = { libName: (id) => this.libName(id) }, asked = askedByNote(a.question, m.note) ? '' : String(a.question || '');
    sec.style.cssText = `${line}flex:none;display:flex;flex-direction:column;${ANSWER_FONT};color:${ANSWER_INK}`;
    sec.innerHTML = (asked ? `<div title="${esc(asked)}" style="flex:none;padding:0 6px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${QUESTION_INK}">${esc(asked)}</div>` : '')
      + `<div data-ask-body="1" style="flex:none;max-height:${this.boxMaxHeight(page)}px;overflow:auto;padding:0 6px 2px;overflow-wrap:anywhere">${answerHtml(a.answer, lib)}</div>`
      + '<div style="flex:none;display:flex;flex-wrap:wrap;gap:2px;padding:2px 0 4px">'
      + (this.props.onContinueAsk ? '<button type="button" data-act="continue">Continue in project</button>' : '')
      + (this.props.onCopyText ? '<button type="button" data-act="copy">Copy</button>' : '')
      + '<button type="button" data-act="delete">Delete</button><button type="button" data-act="collapse">Collapse</button></div>';
    return sec;
  }
  // 40% of the pane's height (2026-10-08; screen px since 2026-10-16, later). The pane's size as last laid out (pdfW,
  // pdfH): asking the page for it here laid the page out once a card.
  boxMaxHeight(page) { return Math.round(Math.max(140, (this.pdfH || 600) * 0.4) / this.boxScale(page)); }
  // The widest a card may be, to be seen whole in the pane (2026-10-08, Hudson: "the annotation text should fit to the
  // window of the stager"): the pane's width less REVEAL_PAD each side.
  paneFit(page) {
    return this.pdfW ? Math.max(140, this.pdfW - 2 * REVEAL_PAD) / this.boxScale(page) : Infinity;
  }
  // Mark id's card scrolled into the pane, by as little as will do (2026-10-08): a new note, an ask sent from it, an answer
  // landing in it. One bigger than the pane shows its top-left. `seen`: only when some of it is in view already, so an
  // answer landing while the paper is read elsewhere does not take the view there.
  revealCard(id, seen = false) {
    const host = this.host.current, el = id && this.find1(`[data-box-mark="${id}"]`);
    if (!host || !el) return;
    const view = this.viewRect(), r = el.getBoundingClientRect();
    if (seen && (r.right <= view.left || r.left >= view.right || r.bottom <= view.top || r.top >= view.bottom)) return;
    const along = (lo, hi, vLo, vHi) => (hi - lo > vHi - vLo - 2 * REVEAL_PAD || lo < vLo + REVEAL_PAD ? lo - vLo - REVEAL_PAD : hi > vHi - REVEAL_PAD ? hi - vHi + REVEAL_PAD : 0);
    host.scrollLeft += along(r.left, r.right, view.left, view.right);
    host.scrollTop += along(r.top, r.bottom, view.top, view.bottom);
  }

  askClick(ev, m, a, page) {
    const link = ev.target.closest && ev.target.closest('a[href]');
    if (link) { // never the app's window: the Stage opens it
      ev.preventDefault(); ev.stopPropagation();
      if (this.props.onOpenLink) this.props.onOpenLink(link.getAttribute('href'));
      return;
    }
    if (this.openFileChip(ev)) return;
    const lib = ev.target.closest && ev.target.closest('[data-lib]');
    if (lib) { ev.preventDefault(); if (this.props.onOpenMention) this.props.onOpenMention(lib.dataset.lib); return; }
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (!act) return;
    ev.preventDefault();
    const what = act.dataset.act;
    const say = (words, back) => { act.textContent = words; setTimeout(() => { if (act.isConnected) act.textContent = back; }, 1400); };
    if (what === 'copy') { if (this.props.onCopyText) this.props.onCopyText(a.answer || ''); say('Copied', 'Copy'); return; }
    if (what === 'continue') {
      if (this.props.onContinueAsk) this.props.onContinueAsk({ markId: m.id, page, quote: passageOf(this.marks, m), question: a.question || '', answer: a.answer || '', foot: (a.meta && a.meta.foot) || '' });
      say('Added', 'Continue in project');
      return;
    }
    // Deleted, an answer is no longer drawn but stays one of the exchange's turns (./canvas.js exchangeOf), and ⌘Z brings it back.
    if (what === 'delete') { a.deleted = true; this.undos.push({ page, markId: m.id, askId: a.id }); }
    else if (what === 'collapse') a.collapsed = true;
    else if (what === 'expand') a.collapsed = false;
    else return;
    this.renderMarks(page);
    this.scheduleSave();
  }

  // An answer being written (`pendingAsks`), in its mark's card (under a divider when `divided`). Its header says what
  // Bart is doing, with a spinner, and Stop; ▸ shows its steps; the answer comes in once it is writing. A failure says
  // why, with × to close it. Made once; each change of what Bart is doing fills it in place (fillRun).
  runBox(p, page, divided = false) {
    const box = makeEl('div', `${divided ? `${ANSWER_GAP};` : ''}flex:none;display:flex;flex-direction:column;${ANSWER_FONT};color:${ANSWER_INK}`, { askRun: p.askId });
    box.onmousedown = (ev) => ev.stopPropagation();
    box.onclick = (ev) => this.runClick(ev, p.askId, page);
    const steps = makeEl('div', 'display:none;flex:none;padding:0 0 4px', { runSteps: '1' });
    steps.appendChild(makeEl('button', '', { act: 'log' }));
    box.append(
      makeEl('div', 'flex:none;display:flex;align-items:center;gap:8px;padding:0 0 4px 6px', { runHead: '1' }),
      makeEl('div', `flex:none;padding:0 6px 6px;color:${QUESTION_INK};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`, { runQuestion: '1' }),
      makeEl('div', `display:none;flex:none;padding:0 6px 8px;color:${ERROR_INK};overflow-wrap:anywhere`, { runError: '1' }),
      steps,
      makeEl('div', 'display:none;flex:none;padding:0 6px 6px;font-size:13px;line-height:1.7;color:#8f8f8f', { runLog: '1' }),
      makeEl('div', `display:none;flex:none;max-height:${this.boxMaxHeight(page)}px;overflow:auto;padding:0 6px 8px;color:${QUESTION_INK};overflow-wrap:anywhere`, { runBody: '1' }),
    );
    this.fillRun(box, p);
    return box;
  }
  fillRun(box, p) {
    const part = (name) => box.querySelector(`[data-run-${name}]`);
    const failed = p.error != null, log = Array.isArray(p.log) ? p.log : [], open = this.openLogs.has(p.askId);
    const lines = !failed && p.activity === 'Writing' && Array.isArray(p.lines) ? p.lines : [];
    // The header is made again only when the run fails (Stop goes, × comes); while it runs only its label changes.
    const head = part('head'), mode = failed ? 'failed' : 'running';
    if (head.dataset.mode !== mode) {
      head.dataset.mode = mode;
      if (failed) {
        const close = makeEl('button', '', { act: 'dismiss' }, '×');
        close.setAttribute('aria-label', 'Close');
        head.replaceChildren(makeEl('span', `flex:1;min-width:0;font-weight:500;color:${ANSWER_INK}`, {}, 'Bart · No answer'), close);
      } else {
        head.replaceChildren(makeEl('span', SPINNER), makeEl('span', `flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${LABEL_INK}`, { runLabel: '1' }), makeEl('button', '', { act: 'stop' }, 'Stop'));
      }
    }
    const label = head.querySelector('[data-run-label]');
    if (label) setText(label, runningLabel(p));
    // Its question in grey only when it is not what the note asks now (canvas.js askedByNote).
    const question = part('question'), m = ((this.marks || {})[p.page] || []).find((x) => x && x.id === p.markId);
    const asked = askedByNote(p.question, m ? m.note : p.question) ? '' : String(p.question || '');
    showEl(question, !!asked);
    setText(question, asked);
    if (question.title !== asked) question.title = asked;
    const error = part('error');
    showEl(error, failed);
    if (failed) setText(error, p.error || 'The run failed.');
    const steps = part('steps'), toggle = steps.firstElementChild;
    showEl(steps, log.length > 0);
    if (log.length) {
      setText(toggle, `${open ? '▾' : '▸'} ${log.length} ${log.length === 1 ? 'step' : 'steps'}`);
      if (toggle.getAttribute('aria-expanded') !== String(open)) toggle.setAttribute('aria-expanded', String(open));
    }
    const list = part('log');
    showEl(list, open && log.length > 0);
    syncKids(list, open ? log.map((entry) => esc(entry)) : [], () => makeEl('div', 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'));
    const body = part('body'), atEnd = body.style.display === 'none' || body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    showEl(body, lines.length > 0);
    syncKids(body, answerParas(lines.join('\n')), () => makeEl('p'));
    if (lines.length && atEnd) body.scrollTop = body.scrollHeight;
  }
  runClick(ev, askId, page) {
    const link = ev.target.closest && ev.target.closest('a[href]');
    if (link) { // never the app's window: the Stage opens it, as from an answer's box
      ev.preventDefault(); ev.stopPropagation();
      if (this.props.onOpenLink) this.props.onOpenLink(link.getAttribute('href'));
      return;
    }
    const act = ev.target.closest && ev.target.closest('[data-act]');
    if (!act) return;
    ev.preventDefault();
    const what = act.dataset.act;
    if (what === 'stop' && this.props.onStopAsk) this.props.onStopAsk(askId);
    else if (what === 'dismiss' && this.props.onDismissAsk) this.props.onDismissAsk(askId);
    else if (what === 'log') {
      if (this.openLogs.has(askId)) this.openLogs.delete(askId); else this.openLogs.add(askId);
      const p = (this.props.pendingAsks || []).find((x) => x && x.askId === askId), box = this.find1(`[data-ask-run="${askId}"]`);
      if (p && box) { this.fillRun(box, p); this.arrange(page); }
    }
  }

  // How many answers are being written for mark `id`: each is a box under its others (deskNeed).
  runsOf(id) { return (Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : []).filter((p) => p && p.askId && p.markId === id).length; }

  // The answers being written for this pdf on a page.
  pendingOn(page) { return (Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : []).filter((p) => p && p.page === page && p.askId); }

  // What Bart is doing changed: a box that is already there is filled again and its page spaced; one that came or went
  // draws its page again.
  syncPending(before) {
    const now = Array.isArray(this.props.pendingAsks) ? this.props.pendingAsks : [];
    const pages = new Set([...before, ...now].filter(Boolean).map((p) => p.page));
    const ids = (list, page) => list.filter((p) => p && p.page === page).map((p) => `${p.markId}/${p.askId}`).join(',');
    const had = new Set(before.filter(Boolean).map((p) => p.askId));
    for (const page of pages) {
      if (ids(before, page) !== ids(now, page)) {
        this.renderMarks(page);
        for (const p of now) if (p && p.page === page && p.askId && !had.has(p.askId)) this.revealCard(p.markId, true); // an ask just sent
        continue;
      }
      let filled = false;
      for (const p of this.pendingOn(page)) {
        const box = this.find1(`[data-ask-run="${p.askId}"]`);
        if (box) { this.fillRun(box, p); filled = true; }
      }
      if (filled) this.arrange(page);
    }
  }

  /** A finished answer, from the Stage (MATH-27): it joins its mark's answers, drawn and saved. → whether the mark is here. */
  addAsk(page, markId, entry) {
    const m = ((this.marks || {})[page] || []).find((x) => x && x.id === markId);
    if (!m || !entry) return false;
    if ((m.asks || []).some((a) => a && a.id === entry.id)) return true; // here already (main tells every window too)
    m.asks = [...(m.asks || []), entry];
    this.renderMarks(page);
    this.revealCard(markId, true);
    this.scheduleSave();
    return true;
  }

  // Moving a card (2026-10-16: by its note's words; by a grip since MATH-27). A press on a note shown as text is held
  // (startPress): moved PRESS_MOVE px it drags the card, let go before that it is a click, and the caret goes where it
  // was pressed. Dragged, the card leaves the spacing, follows the pointer and on release keeps its place in page units
  // (the mark's `pos`); its mark is put in focus, so Backspace / Delete then removes it (markKey).
  startPress(ev, m, page, view) {
    this.pressUp(null);
    this.press = { x: ev.clientX, y: ev.clientY, m, page, view, at: this.noteCaret(view, m, ev) };
    window.addEventListener('mousemove', this.onPressMove);
    window.addEventListener('mouseup', this.onPressUp);
  }
  pressMove(e) {
    const p = this.press;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) < PRESS_MOVE) return;
    this.pressUp(null);
    const card = p.view.closest && p.view.closest('[data-box]');
    if (card && this.startDrag({ clientX: p.x, clientY: p.y }, card, p.page)) { this.drag.at = { x: e.clientX, y: e.clientY }; this.dragTo(); }
  }
  // The press let go (`e` null: only stop listening).
  pressUp(e) {
    window.removeEventListener('mousemove', this.onPressMove);
    window.removeEventListener('mouseup', this.onPressUp);
    const p = this.press;
    this.press = null;
    if (p && e) this.editNote(p.m, p.page, p.at);
  }
  // → whether the card is being moved now.
  startDrag(ev, el, page) {
    const model = this.drawn[page], b = model && model.boxes.find((x) => x.el === el);
    if (!b || this.drag) return false;
    if (el.dataset.boxMark) this.focusMark(el.dataset.boxMark);
    const r = el.getBoundingClientRect(); // the card's px on screen are its sheet's (arrangePages)
    this.closeMention();
    this.drag = { b, page, grabX: ev.clientX - r.left, grabY: ev.clientY - r.top, x0: ev.clientX, y0: ev.clientY, at: { x: ev.clientX, y: ev.clientY }, moved: false, raf: 0 };
    window.addEventListener('mousemove', this.onDragMove);
    window.addEventListener('mouseup', this.onDragUp);
    return true;
  }
  // The card out of the spacing: it stays where it is put.
  detach(model, b) {
    b.fixed = true; b.how = 'pos';
    if (model) for (const unit of model.units) unit.boxes = unit.boxes.filter((x) => x !== b);
  }
  // The card under the pointer, in its sheet's px (the cards' layer), kept on the paper: not above the first page, not
  // past the sheet's sides (2026-10-16: no desk beyond them to reach).
  dragTo() {
    const d = this.drag, host = this.host.current, s = d && this.sheets[d.page], g = d && this.geo[d.page];
    if (!d || !host || !s || !g) return;
    if (!d.moved) {
      if (Math.hypot(d.at.x - d.x0, d.at.y - d.y0) < 3) return;
      d.moved = true;
      host.dataset.dragging = '1';
      this.detach(this.drawn[d.page], d.b);
      this.dragTick();
    }
    const b = d.b, lr = s.notes.getBoundingClientRect();
    b.left = clamp(d.at.x - lr.left - d.grabX, 0, Math.max(0, this.sheetW - b.width));
    b.top = Math.max(-(this.tops[d.page - 1] || 0), d.at.y - lr.top - d.grabY);
    this.arrange(d.page);
  }
  // Held near the top or the foot of the pane, the view scrolls that way and the card goes with it (sideways too, past
  // 100%, where the page is wider than the pane).
  dragTick() {
    const d = this.drag, host = this.host.current;
    if (!d || !host || typeof requestAnimationFrame !== 'function') return;
    const r = host.getBoundingClientRect(), edge = 28, speed = 14;
    const dx = d.at.x < r.left + edge ? -speed : d.at.x > r.left + host.clientWidth - edge ? speed : 0;
    const dy = d.at.y < r.top + edge ? -speed : d.at.y > r.top + host.clientHeight - edge ? speed : 0;
    if (dx || dy) {
      const left = host.scrollLeft, top = host.scrollTop;
      host.scrollLeft += dx; host.scrollTop += dy;
      if (host.scrollLeft !== left || host.scrollTop !== top) this.dragTo();
    }
    d.raf = requestAnimationFrame(() => this.dragTick());
  }
  endDrag(cancel = false) {
    const d = this.drag;
    window.removeEventListener('mousemove', this.onDragMove);
    window.removeEventListener('mouseup', this.onDragUp);
    this.drag = null;
    if (!d) return;
    if (d.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(d.raf);
    const host = this.host.current;
    if (host) delete host.dataset.dragging;
    if (!d.moved || cancel) return;
    const g = this.geom(d.page), pos = posOf(d.b.left, d.b.top, g.G, g.pageW || 1);
    d.b.m.pos = pos;
    // It keeps the width it was moved at (a highlight's note had its margin's).
    if (!(Number(d.b.m.w) > 0)) d.b.m.w = Math.round(d.b.w || d.b.width / this.boxScale(d.page));
    this.renderMarks(d.page);
    this.scheduleSave();
  }

  viewRect() {
    const host = this.host.current, r = host.getBoundingClientRect();
    return { left: r.left + host.clientLeft, top: r.top + host.clientTop, right: r.left + host.clientLeft + host.clientWidth, bottom: r.top + host.clientTop + host.clientHeight };
  }

  /* ---------------------------------------------------------------- the mark in focus (MATH-15) */
  // The mark `id` and its note shown together (MATH-15, merged into the canvas 2026-10-06): its highlight drawn darker
  // over the page. The other marks' cards are left as they are (2026-10-16, third round; Hudson: "when I hover all the
  // other highlights grey out instead of just the one I am hovering over"; they were faded to 0.45). A press on a highlight keeps it (this.focusId); pointing at a card shows
  // its own while the pointer is there. null shows none. The darker bands go on the page's highlight layer (desk px), a
  // deeper fill and no outline (2026-10-16, Hudson: "get rid of this artificial outline").
  paintFocus(id) {
    const host = this.host.current; if (!host) return;
    this.painted = id || null;
    for (const el of host.querySelectorAll('[data-focus]')) el.remove();
    if (!id) return;
    for (const [page, list] of Object.entries(this.marks || {})) {
      const m = (list || []).find((x) => x && x.id === id); if (!m || !m.rects || !m.rects.length) continue;
      const hl = this.find1(`[data-hl="${page}"]`); if (!hl) continue;
      const u = this.desk(Number(page)).pageW; // the highlight layer's desk px (renderMarks)
      for (const b of bandRects(m.rects)) {
        const d = document.createElementNS(SVG, 'rect');
        d.dataset.focus = '1';
        d.setAttribute('x', b.x * u); d.setAttribute('y', b.y * u + b.h * u * 0.12); d.setAttribute('width', b.w * u); d.setAttribute('height', b.h * u * 0.76);
        d.setAttribute('rx', 2); d.setAttribute('fill', 'rgba(0,112,243,.14)');
        hl.appendChild(d);
      }
    }
  }
  // The mark under a point of a page, given in the sheet's own pixels: the last drawn wins (it is on top). Its bands as
  // drawn (./marks.js bandRects): a click in a gap between two of its words is on it.
  markAt(page, x, y) {
    const { G, pageW: u } = this.geom(page), list = (this.marks || {})[page] || [];
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (m && m.rects && bandRects(m.rects).some((r) => x >= G + r.x * u - 2 && x <= G + (r.x + r.w) * u + 2 && y >= r.y * u - 2 && y <= (r.y + r.h) * u + 2)) return m;
    }
    return null;
  }
  focusMark(id) { this.focusId = id || null; this.paintFocus(this.focusId); }

  /* ---------------------------------------------------------------- notes (MATH-21: mentions) */
  // Notes are shown as text, their mentions links, once there is somewhere for a link to go.
  showsNotes() { return typeof this.props.onOpenMention === 'function'; }
  fitNote(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }
  // A note's field's backdrop (noteSection) given the field's text as it is now; a field with none is left alone.
  inkNote(ta) {
    const ink = ta && ta.parentNode && ta.parentNode.querySelector ? ta.parentNode.querySelector('[data-note-ink]') : null;
    if (!ink) return;
    const html = noteInkHtml(ta.value);
    if (ink.innerHTML !== html) ink.innerHTML = html;
    ink.scrollTop = ta.scrollTop || 0;
  }

  // A mentioned item's name now: null when the library no longer holds it; undefined (the name it was mentioned by)
  // when there is no library to ask, or none yet.
  libName(id) {
    const lib = this.props.library;
    if (!Array.isArray(lib) || !lib.length) return undefined;
    const row = lib.find((r) => r && r.id === id);
    return row ? row.name || '' : null;
  }
  // A file in a library folder a note mentions (MATH-22): false when it is gone, undefined until that is known.
  fileState(folderId, rel) { return typeof this.props.fileState === 'function' ? this.props.fileState(folderId, rel) : undefined; }
  // A file's chip clicked (MATH-22): opened in the Stage, or told it is gone. → whether the click was one
  openFileChip(ev) {
    const chip = ev.target.closest && ev.target.closest('[data-file]');
    if (!chip || !chip.dataset.folder) return false;
    ev.preventDefault(); ev.stopPropagation();
    if (this.props.onOpenFile) this.props.onOpenFile({ folderId: chip.dataset.folder, rel: chip.dataset.file, name: chip.dataset.mention });
    return true;
  }
  // The names now of every item the notes mention, as one string: the notes are drawn again when it changes.
  libKey() {
    const ids = new Set(), files = new Set();
    for (const list of Object.values(this.marks || {})) {
      for (const m of list || []) {
        if (!m || !m.note) continue;
        for (const part of noteParts(m.note)) {
          const t = part.match(LIB_MENTION_RE), f = fileMentionOf(part);
          if (t) ids.add(t[2]);
          if (f) { ids.add(f.folderId); files.add(JSON.stringify([f.folderId, f.rel])); }
        }
      }
    }
    const state = (key) => { const [id, rel] = JSON.parse(key); const known = this.fileState(id, rel); return known === undefined ? '?' : known ? (known.dir ? 'd' : 'f') : '-'; };
    return [...[...ids].sort().map((id) => `${id}\t${this.libName(id)}`), ...[...files].sort().map((key) => `${key}\t${state(key)}`)].join('\n');
  }

  // A note being typed in: its text, saved as it changes, and the @ menu opened by what stands before the caret.
  noteField(m, page) {
    const ta = document.createElement('textarea');
    ta.dataset.mark = m.id; ta.value = m.note; ta.rows = 1; ta.spellcheck = false;
    ta.oninput = () => {
      m.note = ta.value;
      this.inkNote(ta); this.fitNote(ta); this.arrange(page); this.scheduleSave(); this.noteMention(ta, m, page);
    };
    ta.onfocus = () => { this.editing = m.id; if (m.rects && m.rects.length) this.focusMark(m.id); };
    ta.onblur = () => this.leaveNote(ta, m, page);
    ta.onkeydown = (ev) => this.noteKey(ev, ta, m, page);
    // The caret moved along the line: the menu follows what stands before it now (↑ and ↓ are the menu's).
    ta.onkeyup = (ev) => { if (/^(ArrowLeft|ArrowRight|Home|End)$/.test(ev.key) && this.state.mention && this.state.mention.markId === m.id) this.noteMention(ta, m, page); };
    ta.onmousedown = (ev) => ev.stopPropagation();
    return ta;
  }
  // A note no one is typing in, as text: a mention opens its item; a click anywhere else is a click into its field, and a
  // press moved past PRESS_MOVE drags its card (startPress, 2026-10-16: no grip).
  noteView(m, page) {
    const view = document.createElement('div');
    view.dataset.noteView = m.id;
    view.innerHTML = noteHtml(m.note, { libName: (id) => this.libName(id), fileState: (id, rel) => this.fileState(id, rel), agents: this.asksFrom(m) });
    view.onmousedown = (ev) => {
      ev.stopPropagation(); // not a click on the page: no new note, the pending selection stays (as in a field)
      if (ev.button !== 0) return;
      ev.preventDefault();
      if (ev.target.closest && ev.target.closest('[data-lib],[data-file]')) return; // its click opens it
      this.startPress(ev, m, page, view);
    };
    view.onclick = (ev) => {
      if (this.openFileChip(ev)) return;
      const link = ev.target.closest && ev.target.closest('[data-lib]');
      if (!link) return;
      ev.preventDefault(); ev.stopPropagation();
      if (this.props.onOpenMention) this.props.onOpenMention(link.dataset.lib);
    };
    return view;
  }
  // Where in the note's text a click on its shown text lands (model/doc.js noteOffset); null when it cannot be told.
  noteCaret(view, m, ev) {
    const r = typeof document.caretRangeFromPoint === 'function' ? document.caretRangeFromPoint(ev.clientX, ev.clientY) : null;
    if (!r || !view.contains(r.startContainer)) return null;
    let node = r.startContainer;
    const opts = { agents: this.asksFrom(m) }; // the pieces noteView drew (model/doc.js noteParts)
    if (node === view) return r.startOffset ? noteOffset(m.note, r.startOffset - 1, Infinity, opts) : 0; // between two pieces
    while (node.parentNode !== view) node = node.parentNode;
    return noteOffset(m.note, [...view.childNodes].indexOf(node), node === r.startContainer && node.nodeType === Node.TEXT_NODE ? r.startOffset : Infinity, opts);
  }
  // The note's field in place of its text, with the keyboard and the caret at `at` (the end when null). The note typed
  // in until now is left first, as a click away from it leaves it: an empty one goes, a written one shows as text.
  editNote(m, page, at) {
    const host = this.host.current, active = document.activeElement;
    if (host && active && active.tagName === 'TEXTAREA' && active.dataset.mark && host.contains(active)) active.blur();
    this.editing = m.id;
    this.renderMarks(page);
    const ta = this.find1(`textarea[data-mark="${m.id}"]`);
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const pos = at == null ? ta.value.length : Math.max(0, Math.min(at, ta.value.length));
    ta.setSelectionRange(pos, pos);
  }
  // The keyboard left a note's field. Empty, the note goes (a highlight keeps its mark); written, it shows as text a frame
  // later, so a click that moved the keyboard to another field on the page is not undone by drawing the page again. A
  // field taken out to be drawn again was not left; the app going to the background leaves it as it is.
  leaveNote(ta, m, page) {
    if (this.redrawing || !ta.isConnected) return;
    if (this.state.mention && this.state.mention.markId === m.id) this.closeMention();
    if (!ta.value.trim()) {
      if (this.editing === m.id) this.editing = null;
      const list = this.marks[page] || [], at = list.indexOf(m);
      if (m.rects.length) m.note = null; else if (at >= 0) list.splice(at, 1);
      this.renderMarks(page);
      this.scheduleSave();
      return;
    }
    if (document.activeElement === ta) return;
    if (this.editing === m.id) this.editing = null;
    if (this.showsNotes()) requestAnimationFrame(() => { if (this.editing !== m.id) this.renderMarks(page); });
  }

  // The @ menu in a note (as in a follow-up field, DocEditor followMention): open while an `@word` stands before the caret.
  noteMention(ta, m, page) {
    const found = typeof this.props.mentionItems === 'function' ? mentionAt(ta.value, ta.selectionStart) : null;
    if (found) this.setState({ mention: { markId: m.id, page, query: found.query, start: found.start, anchor: fieldCaret(ta, undefined, this.boxScale(page)) }, mentionIdx: 0 });
    else this.closeMention();
  }
  closeMention() { if (this.state.mention || this.state.browse) this.setState({ mention: null, browse: null }); }

  /* ------------------------------------------------- a library folder in a note's @ menu (MATH-22) */
  mentionKey(open) { return open ? `${open.markId}:${open.start}` : null; }
  /** The folder the menu is in → { at, row, rel, listing }, or null at the menu's top. */
  browsing() { const b = this.state.browse, open = this.state.mention; return b && open && b.at === this.mentionKey(open) ? b : null; }
  // The menu goes into `rel` of the folder `row`: what was typed to find it is taken out of the note, and the level is
  // asked of main (listFolder) each time, live.
  openFolder(row, rel) {
    const open = this.state.mention;
    if (!open || !row || typeof this.props.listFolder !== 'function') return;
    const ta = this.find1(`textarea[data-mark="${open.markId}"]`), m = ((this.marks || {})[open.page] || []).find((x) => x.id === open.markId);
    if (ta && m) {
      const end = ta.selectionStart;
      if (end > open.start + 1 && ta.value.charAt(open.start) === '@') {
        ta.setRangeText('', open.start + 1, end, 'end');
        m.note = ta.value; this.inkNote(ta); this.fitNote(ta); this.scheduleSave();
      }
      if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    }
    const at = this.mentionKey(open), id = row.id;
    this.setState({ mention: { ...open, query: '' }, browse: { at, row, rel, listing: undefined }, mentionIdx: 0 });
    Promise.resolve().then(() => this.props.listFolder(id, rel)).catch((error) => ({ error: (error && error.message) || 'This folder could not be read' })).then((listing) => {
      const b = this.state.browse;
      if (!this.host.current || !b || b.at !== at || b.row.id !== id || b.rel !== rel) return;
      const next = { ...b, listing: listing || { error: 'This folder could not be read' } };
      this.setState({ browse: next, mentionIdx: firstPick(folderRows({ browse: next, listing: next.listing, query: (this.state.mention || {}).query })) });
    });
  }
  leaveFolder() {
    const b = this.browsing(); if (!b) return;
    const up = parentRel(b.rel);
    if (up == null) this.setState({ browse: null, mentionIdx: 0 }); else this.openFolder(b.row, up);
  }
  // A note that can ask Bart (MATH-27): one on a highlight, with somewhere to send the question. A free note has no passage.
  asksFrom(m) { return typeof this.props.onAsk === 'function' && !!m && Array.isArray(m.rects) && m.rects.length > 0; }
  pageOf(m) { for (const [page, list] of Object.entries(this.marks || {})) if ((list || []).includes(m)) return Number(page); return 0; }
  // The menu's rows: library items, and Bart where it can ask (MATH-27): a highlight's note, at its start. A note does not
  // ask the other agents, make a note, name a workspace or a page the library does not hold.
  mentionList() {
    const open = this.state.mention;
    if (!open || typeof this.props.mentionItems !== 'function') return [];
    const m = ((this.marks || {})[open.page] || []).find((x) => x && x.id === open.markId);
    const browse = this.browsing();
    if (browse) return folderRows({ browse, listing: browse.listing, query: open.query.toLowerCase() });
    const bart = this.asksFrom(m) && !String((m && m.note) || '').slice(0, open.start).trim();
    // Zotero's row (MATH-65 build 2) is the documents' alone: a note mentions library items.
    return (this.props.mentionItems(open.query.toLowerCase()) || []).filter((r) => r && ((r.kind === 'item' && r.row && r.row.id && !r.row.zotero) || (bart && r.kind === 'verb' && r.verb === 'bart')));
  }
  // Keys in a note's field: the menu's first while it is open (↑ ↓ move, Enter or Tab picks, Escape closes it alone),
  // then Enter in a highlight's note that starts with @bart asks (Shift+Enter is a new line), then Escape leaves the note.
  // None reaches the page or the Stage.
  noteKey(ev, ta, m, page) {
    ev.stopPropagation();
    const items = this.state.mention && this.state.mention.markId === m.id ? this.mentionList() : [];
    if (items.length) {
      const n = items.length, open = this.state.mention;
      // Backspace with nothing typed after the `@`, inside a folder: up a level, the `@` kept (MATH-22).
      if (ev.key === 'Backspace' && !open.query && ta.selectionStart === ta.selectionEnd && ta.selectionStart === open.start + 1 && this.browsing()) { ev.preventDefault(); this.leaveFolder(); return; }
      if (ev.key === 'ArrowDown') { ev.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx + 1) % n }); return; }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); this.setState({ mentionIdx: (this.state.mentionIdx - 1 + n) % n }); return; }
      if ((ev.key === 'Enter' || ev.key === 'Tab') && !ev.isComposing) { ev.preventDefault(); this.pickMention(items[this.state.mentionIdx] || items[0]); return; }
      if (ev.key === 'Escape') { ev.preventDefault(); this.closeMention(); return; }
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && this.asksFrom(m)) {
      const question = noteQuestion(ta.value);
      if (question != null) {
        ev.preventDefault();
        if (question) this.askFrom(ta, m, page || this.pageOf(m), question);
        return;
      }
    }
    if (ev.key === 'Escape') ta.blur();
  }
  // Bart asked from a highlight's note: the passage (all of it, when the highlight is part of a selection across pages),
  // the note as it stands, the question and the highlighted page's text around the passage (pageTextAround) go up (the
  // Stage adds which pdf), with the mark's earlier answers as the turns, deleted ones too while their session lasts
  // (./canvas.js exchangeOf), so a follow-up within half an hour resumes the same session. The note keeps what was typed
  // and shows as text; the answer comes under it in its card.
  askFrom(ta, m, page, question) {
    m.note = ta.value;
    this.flushSave(this.props.onMarksChange);
    this.closeMention();
    const ask = { markId: m.id, page, quote: passageOf(this.marks, m), note: m.note, question, turns: turnsOf(m) };
    if (this.editing === m.id) this.editing = null;
    ta.blur();
    const g = this.geo[page], at = g && g.pageH ? (Number(m.y) * g.pageW) / g.pageH : null;
    return this.pageTextAround(page, m.text, at).then((pageText) => { if (typeof this.props.onAsk === 'function') this.props.onAsk({ ...ask, pageText }); });
  }
  // The text of page n as pdf.js gives it, cut to about 4,000 characters centered on `passage` (./marks.js pageWindow;
  // `at` the share of the page's height it is at, should it not be found). '' when the text cannot be had within 2 s.
  async pageTextAround(n, passage, at = null) {
    let timer = 0;
    try {
      const late = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('slow')), 2000); });
      return pageWindow(pdfText(await Promise.race([this.texts.get(n), late])), passage, { at });
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }
  // A row picked: its token takes the place of `@query`, then a space (one there already is stepped over), and the note
  // keeps the keyboard. The item is only mentioned: nothing is added to the workspace. Bart's row writes `@Bart `.
  pickMention(r) {
    const open = this.state.mention;
    // A library folder, and a subfolder of it, opens in the menu; the back row goes up; a row that only says something is
    // not picked (MATH-22).
    if (r && typeof this.props.listFolder === 'function' && isFolderRow(r)) { this.openFolder(r.row, ''); return; }
    if (r && r.kind === 'entry' && r.dir) { this.openFolder(r.row, r.rel); return; }
    if (r && r.kind === 'back') { this.leaveFolder(); return; }
    if (r && r.kind === 'note') return;
    this.closeMention();
    const bart = !!r && r.kind === 'verb' && r.verb === 'bart';
    if (!open || !r || (!bart && (!r.row || !r.row.id))) return;
    const ta = this.find1(`textarea[data-mark="${open.markId}"]`), m = ((this.marks || {})[open.page] || []).find((x) => x.id === open.markId);
    if (!ta || !m) return;
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    const end = ta.selectionStart, found = mentionAt(ta.value, end), start = found ? found.start : open.start;
    if (start > end) return;
    if (bart) {
      ta.setRangeText('@Bart ', start, end, 'end');
      if (ta.value.charAt(ta.selectionEnd) === ' ') ta.setRangeText('', ta.selectionEnd, ta.selectionEnd + 1, 'end');
      m.note = ta.value;
      this.inkNote(ta);
      this.fitNote(ta);
      this.scheduleSave();
      return;
    }
    const file = (r.kind === 'entry' || r.kind === 'self') && r.rel; // a file or a subfolder in a library folder
    ta.setRangeText(file ? fileMention(r.kind === 'self' ? r.entryName : r.name, r.row.id, r.rel) : libMention(r.kind === 'self' ? r.row.name : r.name, r.row.id), start, end, 'end');
    if (ta.value.charAt(ta.selectionEnd) === ' ') ta.setSelectionRange(ta.selectionEnd + 1, ta.selectionEnd + 1);
    else ta.setRangeText(' ', ta.selectionEnd, ta.selectionEnd, 'end');
    m.note = ta.value;
    this.inkNote(ta);
    this.fitNote(ta);
    this.scheduleSave();
  }

  /* ---------------------------------------------------------------- render */
  render() {
    const { title } = this.props;
    const { note, page, pages, pct, removed } = this.state;
    return (
      <div ref={this.root} style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: title ? 12 : 0 }}>
        <style>{LAYER_CSS}</style>
        {title ? (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, padding: '14px 20px 0' }}>
              <h3 style={{ margin: 0, font: '600 15px/1.4 var(--font-sans)', color: '#171717', textWrap: 'pretty' }}>{title}</h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} />
          </>
        ) : null}
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div ref={this.host} data-pdf="1" style={{ flex: 1, minHeight: 0, overflow: 'auto', border: 0, borderTop: title ? '1px solid #eaeaea' : 0, borderRadius: 0, background: CARD_GROUND, padding: 0 }} />
          {note
            ? <span style={{ position: 'absolute', left: 0, right: 0, top: 14, textAlign: 'center', font: '12px/1.5 var(--font-sans)', color: '#8f8f8f', pointerEvents: 'none' }}>{note}</span>
            : null}
          {removed ? (
            <div data-removed="1" role="status" style={TOAST} onMouseDown={(e) => e.preventDefault()}>
              <span>{removed.label}</span>
              <span style={{ color: '#8f8f8f' }}>·</span>
              <button type="button" data-removed-undo="1" style={TOAST_UNDO} onClick={() => this.undoRemoval(removed.batch)}>Undo</button>
            </div>
          ) : null}
          {this.state.mention && this.state.mention.anchor ? (
            <MentionMenu items={this.mentionList()} index={this.state.mentionIdx} anchor={this.state.mention.anchor} onPick={(r) => this.pickMention(r)} onHover={(i) => this.setState({ mentionIdx: i })} />
          ) : null}
          {!note && pages > 0 ? (
            <div style={BAR} title="pinch, or ⌘ or ⌃ scroll, to zoom" onMouseDown={(e) => e.preventDefault()}>
              <span style={{ color: '#171717', minWidth: `${String(pages).length}ch`, textAlign: 'right' }}>{page}</span>
              <span style={{ margin: '0 4px', color: '#8f8f8f' }}>of {pages}</span>
              <span style={{ flex: 'none', width: 1, height: 16, margin: '0 6px', background: '#eaeaea' }} />
              <button type="button" className="hov-wash" aria-label="Zoom out" style={BAR_STEP} onClick={() => this.zoomStepBy(-1)}>−</button>
              <button type="button" className="hov-wash" title="100% = fit width" style={BAR_PCT} onClick={() => this.togglePct()}>{pct}%</button>
              <button type="button" className="hov-wash" aria-label="Zoom in" style={BAR_STEP} onClick={() => this.zoomStepBy(1)}>+</button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
