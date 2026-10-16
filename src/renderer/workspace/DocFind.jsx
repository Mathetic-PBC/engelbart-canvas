import React from 'react';
import FindCard from '../ui/FindCard.jsx';
import { segmentMatches } from '../model/doc-find.js';
import { nextFind } from '../model/find.js';

// ⌘F in the middle canvas (2026-10-16: "Add cmd + f to the middle canvas"): the Stage's find card (ui/FindCard.jsx) at
// the top right of the pane clicked last, its matches in that pane's document as drawn (model/doc-find.js). Painted with
// CSS Custom Highlights (styles.css doc-find, doc-find-cur), as the Stage paints a file's: the editor keeps its own model
// of the text and its DOM is never written to. The editor redraws its lines whole (an answer arriving, a line opening or
// closing), so whenever the pane's DOM changes the matches are found again, the one in front kept. Enter, ↓ and ⌘G step
// on, ⇧Enter, ↑ and ⇧⌘G back (Workspace.jsx asks `step` through `stepRef`). Escape or × closes it and gives the keyboard
// back to the document: on the match in front, selected, when the caret can go there (DocEditor caretOfRange), else
// where it was when find opened (`back`).

const FIND = 'doc-find', FIND_ON = 'doc-find-cur';
const highlights = () => (typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null);
const clear = () => { const h = highlights(); if (h) { h.delete(FIND); h.delete(FIND_ON); } };
// A match may run across inline elements (bold, a link, a mention); any of these starts a block of its own.
const BLOCK = '[data-line], p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, div';
// The editor's own controls are not the document's text (a card's Copy, a code block's language button).
const SKIP = 'button, svg, style, script, [aria-hidden="true"]';
const TOP_ROOM = 56; // the card sits over the pane's top: a match scrolled to lands below it

// The lines' text nodes on screen, each with its block: a line folded away (display:none) is not searched.
function segmentsOf(root) {
  const segs = [], nodes = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!node.data || !el || el.closest(SKIP)) continue;
    if (typeof el.checkVisibility === 'function' ? !el.checkVisibility() : !el.getClientRects().length) continue;
    segs.push({ text: node.data, block: el.closest(BLOCK) });
    nodes.push(node);
  }
  return { segs, nodes };
}

export default function DocFind({ editorRef, text, onText, onClose, focusKey, back, stepRef, place = null }) {
  const inputRef = React.useRef(null);
  const held = React.useRef({ ranges: [], at: -1, query: null });
  const [found, setFound] = React.useState(null);
  const query = React.useRef(text);
  query.current = text;

  // `step` 0 finds again (a new query, a redraw), 1 / -1 move to the next or previous match, wrapping.
  const run = React.useCallback((step) => {
    const editor = editorRef && editorRef.current;
    const where = editor && editor.findRoot ? editor.findRoot() : null;
    const words = query.current;
    if (!where || !String(words || '').trim()) { clear(); held.current = { ranges: [], at: -1, query: words }; setFound(null); return; }
    const { segs, nodes } = segmentsOf(where.root);
    const ranges = segmentMatches(segs, words).map(({ start, end }) => {
      const range = document.createRange();
      range.setStart(nodes[start.seg], start.offset);
      range.setEnd(nodes[end.seg], end.offset);
      return range;
    });
    const was = held.current, scroller = where.scroller;
    const firstInView = () => {
      if (!scroller) return 0;
      const top = scroller.getBoundingClientRect().top + TOP_ROOM;
      const i = ranges.findIndex((range) => range.getBoundingClientRect().bottom >= top);
      return i < 0 ? 0 : i;
    };
    const { at, scroll } = nextFind({ fresh: was.query !== words, step, count: ranges.length, at: was.at, firstInView });
    held.current = { ranges, at, query: words };
    const h = highlights();
    if (h) {
      h.set(FIND, new Highlight(...ranges.filter((_range, i) => i !== at)));
      const on = new Highlight(...(ranges[at] ? [ranges[at]] : []));
      on.priority = 1;
      h.set(FIND_ON, on);
    }
    if (scroll && ranges[at] && scroller) {
      const box = scroller.getBoundingClientRect(), r = ranges[at].getBoundingClientRect();
      if (r.top < box.top + TOP_ROOM || r.bottom > box.bottom - 24) scroller.scrollTop += r.top - box.top - scroller.clientHeight / 3;
    }
    setFound({ matches: ranges.length, active: at + 1 });
  }, [editorRef]);
  if (stepRef) stepRef.current = run;

  React.useEffect(() => { run(0); }, [text, run]);

  // The pane's DOM changed (its lines redrawn, another document in front, the editor drawn after "Opening…"): the same
  // query again, on the match in front. The card's own changes (its count) are not the document's.
  React.useEffect(() => {
    const bar = inputRef.current && inputRef.current.closest('[data-doc-find]');
    const pane = bar && bar.closest('[data-doc-pane]');
    if (!pane || typeof MutationObserver !== 'function') return undefined;
    let frame = 0;
    const observer = new MutationObserver((records) => {
      if (records.every((record) => bar.contains(record.target))) return;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; run(0); });
    });
    observer.observe(pane, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [run]);

  React.useEffect(() => () => clear(), []);

  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [focusKey]);

  const close = () => {
    const editor = editorRef && editorRef.current;
    const range = held.current.ranges[held.current.at];
    clear();
    const onMatch = editor && editor.caretOfRange && range && range.startContainer.isConnected ? editor.caretOfRange(range) : null;
    const placed = !!editor && editor.placeCaret && ((onMatch && editor.placeCaret(onMatch)) || (back && editor.placeCaret(back)));
    if (!placed && editor && editor.findRoot && !editor.props.readOnly) { const where = editor.findRoot(); if (where) where.root.focus({ preventScroll: true }); }
    onClose();
  };

  return (
    <div data-doc-find="1">
      <FindCard inputRef={inputRef} text={text} found={found} onText={onText} onStep={run} onClose={close} label="Find in this document" place={place} />
    </div>
  );
}
