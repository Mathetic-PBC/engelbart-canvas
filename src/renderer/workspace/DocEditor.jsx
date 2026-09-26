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
//   * where a document was scrolled to is kept per workspace (props.viewOf / props.onView, 2026-09-22), apart from the
//     caret: coming back to a document shows what was on screen, not where the last edit was.
import React from 'react';
import { parseLine, parseLines, codeBlocks, todoLine, esc, tokShown, tokensOf, rawOffset, replyRawOffset, inlineHtml, highlight, fenceShown, isFence, isCode, isAnswer, isMarked, lineText, sameLine, replyLine, canonicalLine, retypedRow, threads, turnText, wsMention, INLINE, LABELS, HELD, ATTRIBUTION_RE, FENCE_RE } from '../model/doc.js';
import { readFlags, readQuestion, withChoice, modelOf, effortOf, EFFORT_LABELS } from '../../main/bart/question.cjs';
import BartPicker from './BartPicker.jsx';
import MentionMenu from './MentionMenu.jsx';
import Popover from './Popover.jsx';
import WorkspacePeek from './WorkspacePeek.jsx';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SPEED = { fast: 0.45, normal: 1, slow: 2.2 };

export const BART_ITEM = { id: 'bart', type: 'chat', name: 'bart', title: 'Bart', summary: 'Ask a question about this document, the project\'s code or the web. Add --opus or --high to pick the model or the effort by hand.', facts: 'reads, never edits' };
// Picking this writes `@Task `, which the document stores as the `- [ ] ` row a typed `- []` also makes.
export const TASK_ITEM = { id: 'task', type: 'task', name: 'Task', title: 'Task', summary: 'A task row: check it off, \u2318\u23ce builds it, and a run of them shares one card.', facts: 'stored as - [ ]' };

const UNDER_BART = ['pending', 'reply'];
// `@Note` (the @ menu's Note) and the name after it, to the end of the line.
const NOTE_VERB_RE = /(^|\s)@Note(?:\s+(.*))?$/;
// A short fingerprint of a line (FNV-1a), so a remembered scroll position finds its line again without keeping its text.
const hashLine = (line) => { let h = 0x811c9dc5; const s = String(line ?? ''); for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const newAskId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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
  // Near the bottom of the window a name goes above its icon instead (editorOver sets the mark).
  + '[data-tip-up]>.bart-tip{top:auto;bottom:100%;margin-top:0;margin-bottom:4px}';
// Lucide's drawings at the design's weight: 16px, 1.5px stroke, round caps.
const icon = (paths, size = 16, width = 1.5, caps = 'round') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="${caps}" stroke-linejoin="${caps === 'round' ? 'round' : 'miter'}" aria-hidden="true">${paths}</svg>`;
const ICON = {
  copy: icon('<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>'),
  regenerate: icon('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path>'),
  collapse: icon('<path d="m7 20 5-5 5 5"></path><path d="m7 4 5 5 5-5"></path>'),
  expand: icon('<path d="m7 15 5 5 5-5"></path><path d="m7 9 5-5 5 5"></path>'),
  trash: icon('<path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M19 6v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path>'),
  chevron: `<span style="display:inline-flex;color:#8f8f8f">${icon('<path d="m6 9 6 6 6-6"></path>', 12, 2)}</span>`,
  send: icon('<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>', 13, 2.2),
  // The steps toggle: a plain angle with square ends (Hudson's reference, 2026-09-21), pointing up while the list is open.
  stepsOpen: icon('<path d="m5 15.5 7-7 7 7"></path>', 10, 3, 'square'),
  stepsShut: icon('<path d="m5 8.5 7 7 7-7"></path>', 10, 3, 'square'),
};
const radius = (top, closes) => `${top ? '10px 10px' : '0 0'} ${closes ? '10px 10px' : '0 0'}`;
// A flag the models file recognises is a little bolder than the text around it; a `--word` it does not know stays plain.
const FLAG_LOOK = 'font-weight:500';

export default class DocEditor extends React.Component {
  state = { activeLine: null, mention: null, mentionIdx: 0, pop: null, picker: null, statuses: {} };
  edRef = React.createRef();
  history = []; future = []; caret = null; lastHtml = ''; lastKey = null; selRaw = null; openKey = ''; copied = null; copiedT = null;
  syncing = false; wantFocus = false; composing = false; mounted = false; timers = new Set();
  openLogs = new Set(); // asks whose list of steps is open
  pickerT = null;
  // A follow-up being typed and the model picked for it, by the first line of its card. Neither is in the document, and
  // neither is in the editor's HTML: the field keeps its text across redraws because it is put back after each one.
  followText = new Map(); followChoice = new Map();
  scrollRef = React.createRef();
  parsedCache = new WeakMap();
  // Where the open document was scrolled to: reported (onView) a moment after scrolling stops and whenever it is left;
  // put back (viewOf) when it opens, and again while images above it load, until the person scrolls.
  viewT = null; wantView = false; settle = null; resizeObs = null;

  /* ---------------------------------------------------------------- lifecycle */
  componentDidMount() {
    this.mounted = true;
    const inEd = (e) => e.target && e.target.closest && e.target.closest('[data-editor]') === this.editorEl();
    // The follow-up field is an <input> inside the editor: its keys and text are its own, not the document's.
    const inFollow = (e) => !!(e.target && e.target.matches && e.target.matches('[data-follow-input]'));
    this.docListeners = {
      keydown: (e) => { if (!inEd(e)) return; if (inFollow(e)) this.followKey(e); else this.editorKey(e); },
      input: (e) => { if (!inEd(e)) return; if (inFollow(e)) this.followInput(e.target); else this.editorInput(); },
      beforeinput: (e) => { if (!inEd(e) || inFollow(e)) return; const sel = getSelection(); this.bulkDelete = /^delete/.test(e.inputType || '') && !!sel && !sel.isCollapsed; },
      paste: (e) => { if (inEd(e) && !inFollow(e)) this.editorPaste(e); },
      // A press on one of the editor's buttons must not move the keyboard: leaving a line redraws the editor, and a button
      // redrawn between the press and the release never gets its click (found with Delete, while an answer was being edited).
      mousedown: (e) => { if (inEd(e) && e.target.closest('button[data-act], .bart-chip')) e.preventDefault(); },
      click: (e) => { if (inEd(e)) this.editorClick(e); },
      mouseover: (e) => { if (inEd(e)) this.editorOver(e); },
      mouseout: (e) => { if (inEd(e)) this.editorOut(e); },
      selectionchange: () => this.onSel(),
      dragover: (e) => { if (inEd(e)) e.preventDefault(); },
      drop: (e) => { if (inEd(e)) e.preventDefault(); },
      focusout: (e) => { if (inEd(e) && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-mention-menu]'))) this.setState({ activeLine: null, mention: null }); },
      compositionstart: () => { this.composing = true; },
      compositionend: (e) => { this.composing = false; if (inEd(e) && !inFollow(e)) this.editorInput(); },
    };
    Object.entries(this.docListeners).forEach(([k, f]) => document.addEventListener(k, f));
    window.addEventListener('resize', this.fitFollows);
    this.syncEditor();
    this.wantView = true; this.maybeRestoreView();
    if (typeof ResizeObserver === 'function' && this.editorEl()) {
      this.resizeObs = new ResizeObserver(() => { const s = this.settle; if (s && s.key === this.key() && Date.now() < s.until) this.applyView(s.pos); });
      this.resizeObs.observe(this.editorEl());
    }
    if (Array.isArray(this.props.initialBuild) && this.props.initialBuild.length) this.buildIdx(this.props.initialBuild);
  }

  // The document on screen is about to be replaced by another: what it was scrolled to is reported first, while it is still there.
  getSnapshotBeforeUpdate(prevProps) {
    if (prevProps.docKey !== this.props.docKey && this.lastKey === prevProps.docKey) this.reportView(prevProps, true);
    return null;
  }

  componentDidUpdate(prevProps) {
    if (prevProps.docKey !== this.props.docKey) {
      this.wantView = true; this.settle = null;
      this.history = []; this.future = []; this.caret = null; this.lastHtml = ''; this.lastKey = null; this.selRaw = null; this.openKey = '';
      const s = this.state;
      if (s.activeLine != null || s.mention || s.pop || s.picker) { this.setState({ activeLine: null, mention: null, pop: null, picker: null }); return; }
    }
    // Progress of a run arrives many times a second. It changes pending rows only, and those are replaced where they
    // stand: the rest of the editor, the caret and a selection in it are not touched.
    if (prevProps.asks !== this.props.asks && prevProps.text === this.props.text && prevProps.docKey === this.props.docKey && this.patchPending()) return;
    this.syncEditor();
    this.maybeRestoreView();
  }

  componentWillUnmount() {
    if (this.lastKey === this.key()) this.reportView(this.props, true);
    this.mounted = false; clearTimeout(this.pickerT); clearTimeout(this.viewT);
    if (this.resizeObs) this.resizeObs.disconnect();
    window.removeEventListener('resize', this.fitFollows);
    Object.entries(this.docListeners || {}).forEach(([k, f]) => document.removeEventListener(k, f));
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
    if (this.state.mention) { const anchor = this.caretRect(); if (anchor) this.setState((s) => (s.mention ? { mention: { ...s.mention, anchor } } : null)); }
    clearTimeout(this.viewT); this.viewT = setTimeout(() => { if (this.mounted && this.lastKey === this.key()) this.reportView(this.props, false); }, 300);
  };
  // The person scrolled, clicked or typed: what they do from now on wins over putting the old place back.
  stopSettling = () => { this.settle = null; };
  caretRect() {
    const sel = getSelection(); if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }

  /* ---------------------------------------------------------------- document access */
  key() { return this.props.docKey; }
  lines() { return String(this.props.text ?? '').split('\n'); }
  // Each line read in place (a line inside a code block is code). Kept per array, so a loop over one array reads it once.
  parsedOf(ls) { let ps = this.parsedCache.get(ls); if (!ps) { ps = parseLines(ls); this.parsedCache.set(ls, ps); } return ps; }
  editorEl() { return this.edRef.current; }
  statusesFor(key = this.key()) { return this.state.statuses[key] || {}; }
  status(i) { return this.statusesFor()[i] || ''; }
  // Lines the person cannot type in: an @bart line once something stands under it, a run at work, the closing line of an
  // answer (it is the card's foot), an answer folded away, and the prototype's `> ` replies. The text of an answer can be
  // edited (2026-09-21): it is a drawn-prefix line, as a bullet is.
  lockedAt(ls, i) {
    const ps = this.parsedOf(ls), p = ps[i] || parseLine('');
    if (p.type === 'reply') return p.folded || (ATTRIBUTION_RE.test(p.text) && (ps[i + 1] || parseLine('')).type !== 'reply');
    if (p.type === 'bart') return ls[i + 1] != null && UNDER_BART.includes(ps[i + 1].type);
    return isAnswer(p.type);
  }
  // A card is closed by its foot, never by a line the caret can sit on: the document needs a line of its own after it.
  // So does a code block, or the caret below it would land on its closing fence and type into it.
  endsOnCard(ls) { const last = ls.length - 1; return this.lockedAt(ls, last) || ['reply', 'fence'].includes((this.parsedOf(ls)[last] || parseLine('')).type); }
  speed() { return SPEED[this.props.buildSpeed] || 1; }
  timer(fn, ms) { const id = setTimeout(() => { this.timers.delete(id); if (this.mounted) fn(); }, ms); this.timers.add(id); return id; }

  setDoc(text, caret) {
    const prev = String(this.props.text ?? '');
    if (prev !== text) {
      this.history.push({ text: prev, caret: this.caretInfo()?.anchor || null });
      if (this.history.length > 200) this.history.shift();
      this.future = [];
      this.props.onChange(text);
    }
    if (caret) this.caret = caret;
  }
  setLines(fn, caret) { this.setDoc(fn(this.lines()).join('\n'), caret); }
  writeText(i, text, caret) {
    this.setLines((ls) => { const ps = this.parsedOf(ls); return ls.map((l, j) => (j !== i ? l : sameLine(ps[j], text))); }, caret);
  }
  setStatus(key, i, status, done) {
    this.setState((s) => ({ statuses: { ...s.statuses, [key]: { ...(s.statuses[key] || {}), [i]: status } } }));
    if (done && key === this.key()) {
      const ls = this.lines(); const p = parseLine(ls[i] || '');
      if (p.type === 'todo' && !p.done) { ls[i] = todoLine(p.depth, true, p.text); this.props.onChange(ls.join('\n')); }
    }
  }
  shiftStatuses(from, delta) {
    const key = this.key();
    this.setState((s) => {
      const st = {};
      Object.entries(s.statuses[key] || {}).forEach(([k, v]) => { const i = Number(k); if (i < from) st[i] = v; else if (!(delta < 0 && i < from - delta)) st[i + delta] = v; });
      return { statuses: { ...s.statuses, [key]: st } };
    });
  }
  undo = () => {
    const h = this.history.pop(); if (!h) return;
    this.future.push({ text: String(this.props.text ?? '') });
    this.props.onChange(h.text);
    if (h.caret) this.caret = { line: h.caret.line, offset: h.caret.offset };
  };
  redo = () => {
    const f = this.future.pop(); if (!f) return;
    this.history.push({ text: String(this.props.text ?? ''), caret: null });
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
      return `<span data-src="${esc(tok)}" data-open="${isOpen ? 1 : 0}">${isOpen && !/^@bart$/i.test(tok) ? esc(tok) : inlineHtml(tok)}</span>`;
    }).join('');
  }
  // An @bart line in pieces: its recognised flags (src/main/bart/question.cjs reads them, as the run will) each a token of
  // their own, the rest split as any line is. Shown verbatim, so offsets in the line are what they were.
  bartTokens(line, p) {
    const models = this.props.models, base = line.length - p.text.length, tokens = [], flags = new Set();
    let at = 0;
    for (const [from, to] of models ? readFlags(p.text, models).spans : []) {
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
  lineHtml(i, line, p, active, status, first, at, locked) {
    const raw = `data-line="${i}" data-raw="${esc(line)}"`;
    if (p.type === 'code' || p.type === 'fence') return this.codeHtml(i, line, p, active);
    if (p.type === 'todo') {
      const held = HELD.includes(status), done = p.done, label = done ? 'Done' : (LABELS[status] || '');
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;background:#fafafa;padding:${first ? '10px' : '0'} 16px 0 ${16 + p.depth * 24}px;border-radius:${first ? '10px 10px 0 0' : '0'}">`
        + `<span contenteditable="false" data-act="toggle" data-row="${i}" role="button" style="user-select:none;flex:none;width:14px;margin-top:12px;text-align:center;font:15px/1 var(--font-sans);color:${held ? '#c9c9c9' : done ? '#8f8f8f' : '#171717'};cursor:${held ? 'default' : 'pointer'}">${done ? '✓' : '–'}</span>`
        + `<span class="t" style="flex:1;min-width:0;padding:6px 0;min-height:39px;color:${(held || done) ? '#8f8f8f' : '#171717'};text-decoration:${done ? 'line-through' : 'none'}">${content || '<br>'}</span>`
        + (label ? `<span contenteditable="false" style="user-select:none;flex:none;margin-top:11px;font:600 11px/1.5 var(--font-sans);color:${status === 'failed' ? '#e70022' : '#8f8f8f'}">${label}</span>` : '')
        + (!held ? `<button contenteditable="false" data-act="remove" data-row="${i}" aria-label="Remove todo" style="user-select:none;flex:none;margin-top:12px;padding:0 2px;border:0;background:transparent;font:14px/1 var(--font-sans);color:#c9c9c9;cursor:pointer">×</button>` : '')
        + '</div>';
    }
    if (p.type === 'list') {
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;padding:4px 0 4px ${p.depth * 24}px;min-height:35px">`
        + `<span contenteditable="false" style="user-select:none;flex:none;width:14px;text-align:center;line-height:1.6;color:#8f8f8f">\u2022</span>`
        + `<span class="t" style="flex:1;min-width:0">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'h') {
      const size = [26, 22, 18][p.level - 1]; const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="padding:4px 0;min-height:35px;font:500 ${size}px/1.6 var(--font-sans);letter-spacing:-0.3px"><span class="t">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'bart') {
      const { tokens, flags } = this.bartTokens(line, p), models = this.props.models;
      const content = active && !locked ? this.activeHtml(tokens, flags) : tokens.map((tok, k) => (flags.has(k) ? `<span style="${FLAG_LOOK}">${esc(tok)}</span>` : inlineHtml(tok))).join('');
      const read = models ? readQuestion(p.text, models) : null, ready = !!(read ? read.question : p.text).trim();
      const send = `<button contenteditable="false" data-act="ask" data-row="${i}" aria-label="Send" ${ready ? '' : 'disabled'} style="user-select:none;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${ready ? '#0070f3' : '#eaeaea'};color:${ready ? '#fff' : '#8f8f8f'};cursor:${ready ? 'pointer' : 'default'};transition:background 160ms"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"><path d="M8 13.5V3.2M3.6 7.4 8 3l4.4 4.4"/></svg></button>`;
      // The chip: what the question starts on, and (hovered) where that is changed. The arrow sits inside it, one unit.
      const open = !!(this.state.picker && this.state.picker.kind === 'line' && this.state.picker.i === i);
      const chip = read ? `<span contenteditable="false" data-chip="${i}" style="user-select:none;flex:none;display:inline-flex;align-items:center;gap:8px;margin:-2px -6px 0 0;padding:2px 2px 2px 12px;border:1px solid #eaeaea;border-radius:999px;background:#fff"><span data-act="pick" data-row="${i}" role="button" aria-haspopup="dialog" aria-expanded="${open}" style="display:inline-flex;align-items:center;gap:7px;height:26px;font:13px/1 var(--font-sans);color:#4d4d4d;cursor:default;white-space:nowrap">${esc(read.steps[0].name)} ${esc(EFFORT_LABELS[read.steps[0].effort] || read.steps[0].effort)}<span style="display:inline-flex;align-items:center;justify-content:center;width:10px;height:12px;font:12px/1 var(--font-sans);color:#8f8f8f"><span style="position:relative;top:${open ? '3px' : '-3px'}">${open ? '⌃' : '⌄'}</span></span></span>${send}</span>` : `<span contenteditable="false" style="flex:none;margin-top:3px">${send}</span>`;
      // The question opens its card, or follows an answer inside one. Once it is answered its chip goes: the foot says who answered.
      const top = !at || at.top, closes = !at || at.closes;
      return `<div ${raw} ${locked ? 'contenteditable="false" data-readonly="1"' : ''} style="display:flex;align-items:flex-start;gap:10px;padding:${top ? 12 : 10}px 16px ${closes ? '10px' : '4px'};min-height:35px;background:#fafafa;border-radius:${radius(top, closes)};margin-bottom:${closes ? '14px' : '0'};font-size:16px;line-height:1.6;${locked ? 'user-select:text;cursor:default' : ''}"><span class="t" style="flex:1;min-width:0">${content || '<br>'}</span>`
        + (closes ? chip : '')
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
      const so = (ask && ask.lines) || [], role = new Map();
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
      if (at && at.role === 'foot') return this.footHtml({ raw, q: at.turn.q, text: p.text.slice(1, -1), folded: at.turn.folded, closes: at.closes });
      // Folded away, or the empty line the runner leaves before the closing line: in the document, not on the page.
      if (p.folded || (at && at.gap)) return `<div ${raw} contenteditable="false" data-readonly="1" style="display:none"></div>`;
      // One line of an answer, in the grey card with one continuous rule down its left. The caret's line shows its source
      // on the design's focus tint; the rule and the card stay where they are.
      // (An answer with no question above it, left by an edit outside the app, is a card of its own.)
      const near = at ? null : this.lines(), first = at ? at.first : parseLine(near[i - 1] ?? '').type !== 'reply', closes = at ? at.closes : parseLine(near[i + 1] ?? '').type !== 'reply', last = at ? at.lastBody : closes;
      if (p.code) return this.answerCodeHtml(i, raw, p, active, first, closes, last, !at);
      const a = this.answerLook(p.text), content = active ? this.activeHtml(tokensOf(p, line)) : a.content;
      return `<div ${raw} style="padding:${first ? 8 : 0}px 16px ${closes ? 12 : 0}px;background:#fafafa;border-radius:${radius(!at && first, closes)};margin-bottom:${closes ? 14 : 0}px;color:#4d4d4d;font-size:16px;line-height:1.65;cursor:text"><span style="display:block;padding:${first ? 2 : 0}px 0 ${last ? 2 : 0}px 12px;border-left:2px solid #dcdcdc"><span class="t" style="display:block;min-height:${a.minHeight}px;border-radius:4px;${a.look}${active ? 'background:#f2f2f2;box-shadow:0 0 0 4px #f2f2f2;' : ''}">${content || '<br>'}</span></span></div>`;
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
  answerLook(text) {
    const q = parseLine(text), ink = (html) => html.replace(/<strong style="font-weight:600">/g, '<strong style="color:#171717;font-weight:600">');
    if (q.type === 'h') return { content: ink(inlineHtml(q.text)), look: `font:600 ${[18, 17, 16][q.level - 1]}px/1.5 var(--font-sans);color:#171717;padding-top:8px;`, minHeight: 26 };
    if (isMarked(q.type)) return { content: `<span style="display:flex;gap:10px;padding-left:${q.depth * 18}px"><span contenteditable="false" style="flex:none;color:#8f8f8f;user-select:none">•</span><span style="flex:1;min-width:0">${ink(inlineHtml(q.text))}</span></span>`, look: 'padding-top:4px;padding-bottom:4px;', minHeight: 26 };
    return { content: ink(inlineHtml(text)), look: 'text-wrap:pretty;', minHeight: text ? 26 : 22 };
  }
  // The foot of a todo card: Copy all on the left, Build all on the right while anything is open; clicking its whitespace adds a line below the card.
  groupHtml(group) {
    const lastIdx = group[group.length - 1].i;
    const copy = `<button data-act="copyall" data-lines="${group.map((t) => t.i).join(',')}" style="margin-right:auto;display:inline-flex;align-items:center;min-height:32px;padding:8px 12px;border:1px solid #eaeaea;border-radius:8px;background:#fff;color:#171717;font:500 13px/1 var(--font-sans);cursor:pointer">${this.copied === group[0].i ? 'Copied' : 'Copy all'}</button>`;
    const open = group.filter((t) => t.p.text.trim() && !t.p.done);
    if (!open.length) return `<div contenteditable="false" data-act="after" data-after="${lastIdx}" style="user-select:none;display:flex;align-items:center;padding:8px 16px 14px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px;cursor:text">${copy}</div>`;
    const busy = open.filter((t) => HELD.includes(t.status)), ready = open.filter((t) => !HELD.includes(t.status));
    const label = busy.length && !ready.length ? 'Building…' : ready.length && busy.length ? `Queue ${ready.length}` : 'Build all';
    return `<div contenteditable="false" data-act="after" data-after="${lastIdx}" style="user-select:none;display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:12px 16px 14px;margin-bottom:14px;background:#fafafa;border-radius:0 0 10px 10px;cursor:text">${copy}<button data-act="buildall" data-lines="${ready.map((t) => t.i).join(',')}" ${ready.length ? '' : 'disabled'} style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:8px 14px;border:0;border-radius:8px;background:#0070f3;color:#fff;font:500 13px/1 var(--font-sans);cursor:pointer;opacity:${ready.length ? 1 : .4}">${label}</button></div>`;
  }
  // Where every line of an @bart card stands in it: which turn it belongs to, whether it opens or closes the card, and
  // what is drawn after it that is not a line (a foot for an answer that has no closing line; the follow-up field).
  layout(ls) {
    const at = new Map();
    for (const thread of threads(ls, this.parsedOf(ls))) {
      const end = thread.turns[thread.turns.length - 1];
      const follow = end.answered && !end.pending && !end.folded && !!this.props.onAsk;
      for (const turn of thread.turns) {
        at.set(turn.q, { thread, turn, role: 'question', top: turn.q === thread.from, closes: !turn.answered });
        const footless = turn.answered && !turn.pending && turn.foot < 0, tail = turn === end;
        const gap = turn.foot > turn.from && parseLine(ls[turn.foot - 1]).text === '' ? turn.foot - 1 : -1;
        const lastBody = (turn.foot >= 0 ? turn.foot : turn.to + 1) - (gap >= 0 ? 2 : 1);
        for (let i = turn.from; i <= turn.to; i++) {
          const role = i === turn.foot ? 'foot' : parseLine(ls[i]).type === 'pending' ? 'pending' : 'answer', ends = i === turn.to;
          at.set(i, { thread, turn, role, gap: i === gap, first: i === turn.from, lastBody: i === lastBody, closes: ends && tail && !follow && !footless, footAfter: ends && footless, followAfter: ends && tail && follow, tail });
        }
      }
    }
    return at;
  }
  findTurn(ls, q) { for (const thread of threads(ls)) { const turn = thread.turns.find((t) => t.q === q); if (turn) return { thread, turn }; } return null; }
  // The foot of one turn (Answer Card): Copy and Regenerate on the left, which model said it, Collapse or Expand, Delete.
  // Icons, each with its name under it on hover; Regenerate has none, because hovering it opens the selector instead.
  // `raw` is set when the answer's closing line is this foot; an answer without one (a run that failed) gets the same foot.
  footHtml({ raw, q, text, folded, closes }) {
    const wrap = (inner, extra = '') => `<span style="flex:none;position:relative;display:inline-flex;${extra}">${inner}</span>`;
    const tip = (label, side) => `<span class="bart-tip" style="${side}:0">${label}</span>`;
    const copied = this.copied === `bart${q}`;
    return `<div ${raw || ''} contenteditable="false" data-readonly="1" data-foot="${q}" style="user-select:none;cursor:default;display:flex;align-items:center;gap:4px;padding:8px 12px 10px;background:#fafafa;border-radius:${radius(false, closes)};margin-bottom:${closes ? '14px' : '0'}">`
      + wrap(`<button class="bart-ic" data-act="copybart" data-turn="${q}" aria-label="Copy" ${copied ? 'style="color:#8f8f8f"' : ''}>${ICON.copy}</button>${tip(copied ? 'Copied' : 'Copy', 'left')}`)
      + wrap(`<button class="bart-ic" data-act="regen" data-turn="${q}" aria-label="Regenerate" aria-haspopup="dialog">${ICON.regenerate}</button>`, 'margin-right:auto;')
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
  followHtml(ls, thread) {
    const { step } = this.followStep(ls, thread), from = thread.from;
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
  // The field is as tall as its wrapped text.
  fitFollow(input) { input.style.height = 'auto'; input.style.height = `${Math.max(24, input.scrollHeight)}px`; }
  fitFollows = () => { const ed = this.editorEl(); if (ed) for (const input of ed.querySelectorAll('[data-follow-input]')) this.fitFollow(input); };
  paintSend(input) {
    const send = input.parentElement && input.parentElement.querySelector('[data-act="sendfollow"]'); if (!send) return;
    const ready = !!input.value.trim(); send.style.background = ready ? '#0070f3' : '#f2f2f2'; send.style.color = ready ? '#fff' : '#8f8f8f';
  }
  editorHtml() {
    const ls = this.lines(), ps = this.parsedOf(ls), st = this.statusesFor(), active = this.state.activeLine, at = this.layout(ls); let out = '', group = [];
    ls.forEach((line, i) => {
      const p = ps[i], where = at.get(i);
      out += this.lineHtml(i, line, p, active === i, st[i] || '', p.type === 'todo' && !group.length, where, this.lockedAt(ls, i));
      if (where && where.footAfter) out += this.footHtml({ q: where.turn.q, text: '', folded: where.turn.folded, closes: where.tail && !where.followAfter });
      if (where && where.followAfter) out += this.followHtml(ls, where.thread);
      if (p.type === 'todo') group.push({ i, p, status: st[i] || '' });
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
      const html = this.lineHtml(i, ls[i], p, false, '', false, at.get(i), true);
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
      this.shiftStatuses(0, 1); if (this.caret) this.caret = { ...this.caret, line: this.caret.line + 1 };
      if (this.state.activeLine != null) this.setState((st) => ({ activeLine: st.activeLine == null ? null : st.activeLine + 1 }));
      this.props.onChange('\n' + tail.join('\n')); return;
    }
    const html = this.editorHtml();
    const hadFocus = document.activeElement === ed || ed.contains(document.activeElement);
    const field = document.activeElement, had = field && field.matches && field.matches('[data-follow-input]') && ed.contains(field) ? { key: field.dataset.followInput, a: field.selectionStart, b: field.selectionEnd } : null;
    if (html === this.lastHtml && key === this.lastKey) {
      if (this.caret && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.applyCaret(); }
      this.wantFocus = false; return;
    }
    let c = this.caret || (hadFocus ? this.caretInfo()?.anchor : null);
    if (!c && hadFocus && !ed.querySelector('[data-line]')) { const ls = this.lines(), last = ls.length - 1, p = parseLine(ls[last]); c = { line: last, offset: lineText(p, ls[last]).length }; }
    if (c && !this.caret) this.caret = c;
    this.syncing = true; ed.innerHTML = html; this.lastHtml = html; this.lastKey = key; this.restoreFollow(ed, had);
    if (c && !had && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.caret = c; this.applyCaret(); }
    this.wantFocus = false; this.syncing = false;
  }
  applyCaret() { const c = this.caret; this.caret = null; if (!c) return; if (c.sel) this.setSelection(c.line, c.sel[0], c.sel[1]); else this.setSelection(c.line, c.offset, c.offset); }
  posIn(t, offset) {
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); let node, rest = offset;
    while ((node = walker.nextNode())) { if (rest <= node.length) return { node, offset: rest }; rest -= node.length; }
    if (t.firstChild && t.firstChild.nodeName === 'BR') return { node: t, offset: 0 };
    const last = t.lastChild; return last && last.nodeType === 3 ? { node: last, offset: last.length } : { node: t, offset: t.childNodes.length };
  }
  setSelection(line, a, b) {
    const ed = this.editorEl(); if (!ed) return; const d = ed.querySelector(`[data-line="${line}"]`); const t = d && d.querySelector('.t'); if (!t) return;
    const s = this.posIn(t, this.rawToDisplay(t, a)), e = this.posIn(t, this.rawToDisplay(t, b)), range = document.createRange();
    range.setStart(s.node, s.offset); range.setEnd(e.node, e.offset);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  }
  caretInfo() {
    const sel = getSelection(); if (!sel || !sel.rangeCount) return null; const ed = this.editorEl(); if (!ed || !ed.contains(sel.anchorNode)) return null;
    const info = (n, o) => {
      if (!n) return null; const el = n.nodeType === 1 ? n : n.parentElement; const d = el && el.closest('[data-line]'); if (!d || !ed.contains(d)) return null;
      const t = d.querySelector('.t'); let off = 0;
      if (t && t.contains(n)) { const r = document.createRange(); r.selectNodeContents(t); r.setEnd(n, o); off = r.toString().replace(/\u200b/g, '').length; } else off = t ? t.textContent.length : 0;
      const isActive = Number(d.dataset.line) === this.state.activeLine;
      let raw = null;
      if (t && (isActive || t.querySelector('[data-src]'))) raw = this.displayToRaw(t, off);
      if (raw == null) {
        // Code shows its own characters; a fence shown as its language puts the caret at the end of the fence.
        const line = d.dataset.raw || '', kind = d.dataset.kind, p = parseLine(line);
        raw = isActive || kind === 'code' ? off : kind === 'fence' ? lineText(p, line).length : p.type === 'img' ? 0 : p.type === 'reply' ? replyRawOffset(p, off) : rawOffset(p, off, line);
      }
      return { line: Number(d.dataset.line), offset: raw };
    };
    const anchor = info(sel.anchorNode, sel.anchorOffset), focus = info(sel.focusNode, sel.focusOffset) || anchor;
    return anchor ? { anchor, focus } : null;
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
    if (this.syncing) return; const c = this.caretInfo(); if (!c) return;
    const ls = this.lines(); if (this.lockedAt(ls, c.anchor.line)) return;
    // A selection across lines (⌘A, shift-click) is left to the browser; the next input rebuilds whatever lines survive it.
    if (c.anchor.line !== c.focus.line || this.multiLine()) { this.selRaw = { line: c.anchor.line, a: c.anchor.offset, b: c.anchor.offset, multi: true, lines: this.selLines() }; return; }
    const a = Math.min(c.anchor.offset, c.focus.offset), b = Math.max(c.anchor.offset, c.focus.offset);
    if (c.anchor.line !== this.state.activeLine) {
      this.selRaw = { line: c.anchor.line, a, b };
      if (!this.caret) this.caret = { line: c.anchor.line, sel: [a, b] };
      this.setState({ activeLine: c.anchor.line, mention: null }); return;
    }
    this.selRaw = { line: c.anchor.line, a, b };
    const line = ls[c.anchor.line] ?? '', p = this.parsedOf(ls)[c.anchor.line] || parseLine(line), key = p.type === 'img' || isCode(p) || isFence(p) ? '' : this.openIdx(tokensOf(p, line), a, b).join(',');
    if (key !== this.openKey) { this.caret = { line: c.anchor.line, sel: [a, b] }; this.forceUpdate(); }
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
      // `- ` makes it a bullet, `- [] ` / `@Task ` make it a task. The caret must sit right after the marker, so a
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
    // `@Task …`, `- []` and `* x` are stored as the row they make, so the line reads the same way tomorrow. Code is kept
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
      const p = parseLine(ls[pos] ?? ''), txt = lineText(p, ls[pos]), m = inCode ? null : txt.slice(0, caret.offset).match(/@([^\s@\[\]]{0,30})$/);
      if (m) {
        const anchor = this.caretRect();
        this.setState({ activeLine: pos, mention: { i: pos, query: m[1], start: caret.offset - m[0].length, caret: caret.offset, anchor }, mentionIdx: 0 });
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
    if (mod && same && e.key.toLowerCase() === 'b') { e.preventDefault(); this.wrap(i, cur, a, b, '**'); return; }
    if (mod && same && e.key.toLowerCase() === 'i') { e.preventDefault(); this.wrap(i, cur, a, b, '*'); return; }
    if (mod && same && e.key.toLowerCase() === 'k') { e.preventDefault(); this.link(i, cur, a, b); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); if (p.type === 'todo') this.buildIdx([i]); return; }
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
        this.shiftStatuses(i + 1, 2); this.setState({ activeLine: i + 1, mention: null }); return;
      }
      // In code the new line starts at the indent of the one it came from, one step deeper after an opening bracket.
      if (isCode(p)) {
        const head = cur.slice(0, a); let lead = head.match(/^[ \t]*/)[0]; if (/[[{(]\s*$/.test(head)) lead += '  ';
        this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, head); out.splice(i + 1, 0, sameLine(p, lead + cur.slice(b))); return out; }, { line: i + 1, offset: lead.length });
        this.shiftStatuses(i + 1, 1); this.setState({ activeLine: i + 1, mention: null }); return;
      }
      if (isMarked(p.type) && !p.text.trim()) {
        if (p.depth > 0) { this.indent(i, -1); this.caret = { line: i, offset: 0 }; } else this.setLines((x) => x.map((l, j) => (j === i ? '' : l)), { line: i, offset: 0 });
        return;
      }
      const head = cur.slice(0, a), tail = cur.slice(b), l1 = sameLine(p, head), l2 = p.type === 'todo' ? todoLine(p.depth, false, tail) : sameLine(p, tail);
      this.setLines((x) => { const out = [...x]; out[i] = l1; out.splice(i + 1, 0, l2); return out; }, { line: i + 1, offset: 0 });
      this.shiftStatuses(i + 1, 1); this.setState({ activeLine: i + 1, mention: null }); return;
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
          this.setLines((x) => x.filter((_, j) => j !== i), target); this.shiftStatuses(i, -1);
          if (target) this.setState({ activeLine: k, mention: null }); else { const ed = this.editorEl(); if (ed) ed.blur(); this.setState({ activeLine: null, mention: null }); }
          return;
        }
        const off = lineText(q, ls[i - 1]).length;
        this.setLines((x) => { const out = [...x]; out[i - 1] = sameLine(q, lineText(q, x[i - 1]) + cur); out.splice(i, 1); return out; }, { line: i - 1, offset: off });
        this.shiftStatuses(i, -1); this.setState({ activeLine: i - 1, mention: null });
      }
      return;
    }
    if (e.key === 'Delete' && collapsed && a === cur.length && i < ls.length - 1) {
      e.preventDefault(); const q = ps[i + 1]; if (this.lockedAt(ls, i + 1)) return; const nt = lineText(q, ls[i + 1]);
      if ((isFence(p) || isFence(q)) && cur !== '' && nt !== '') return;
      this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, cur + nt); out.splice(i + 1, 1); return out; }, { line: i, offset: cur.length });
      this.shiftStatuses(i + 1, -1); return;
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
        this.shiftStatuses(i + 1, 1); this.setState({ activeLine: i + 1, mention: null }); at = { line: i + 1, offset: 0 };
      } else {
        this.setLines((x) => { const out = [...x]; out.splice(i + 1, 0, token, ''); return out; }, { line: i + 2, offset: 0 });
        this.shiftStatuses(i + 1, 2); this.setState({ activeLine: i + 2, mention: null }); at = { line: i + 2, offset: 0 };
      }
      this.wantFocus = true;
    }
  }
  editorPaste = (e) => {
    const c = this.caretInfo(); if (!c) return;
    const pasted = [...(((e.clipboardData || {}).files) || [])].filter((file) => /^image\/(png|jpeg|gif|webp)$/.test(file.type));
    if (pasted.length && this.props.onPasteImage) { e.preventDefault(); void this.pasteImages(pasted, { line: c.anchor.line, offset: Math.min(c.anchor.offset, c.focus.offset) }); return; }
    e.preventDefault();
    const text = ((e.clipboardData || window.clipboardData).getData('text/plain') || '').replace(/\r/g, ''); if (!text) return;
    const ls = this.lines(), i = c.anchor.line, line = ls[i] ?? '', p = this.parsedOf(ls)[i] || parseLine(line), cur = lineText(p, line);
    const same = c.anchor.line === c.focus.line, a = same ? Math.min(c.anchor.offset, c.focus.offset) : c.anchor.offset, b = same ? Math.max(c.anchor.offset, c.focus.offset) : a;
    const parts = text.split('\n');
    if (parts.length === 1) { this.writeText(i, cur.slice(0, a) + text + cur.slice(b), { line: i, offset: a + text.length }); return; }
    const first = cur.slice(0, a) + parts[0], last = parts[parts.length - 1] + cur.slice(b);
    const inAnswer = (text) => (p.type === 'reply' ? sameLine(p, text) : text);
    this.setLines((x) => { const out = [...x]; out[i] = sameLine(p, first); out.splice(i + 1, 0, ...parts.slice(1, -1).map(inAnswer), inAnswer(last)); return out; }, { line: i + parts.length - 1, offset: parts[parts.length - 1].length });
    this.shiftStatuses(i + 1, parts.length - 1); this.setState({ activeLine: i + parts.length - 1, mention: null });
  };
  editorClick = (e) => {
    if (e.target === this.editorEl()) { this.focusEnd(); return; } // the editor's own empty space below the last line
    const act = e.target.closest('[data-act]');
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
        this.setLines((x) => { const out = [...x]; out.splice(at, 0, ''); return out; }); this.shiftStatuses(at, 1);
        this.caret = { line: at, offset: 0 }; this.wantFocus = true; this.setState({ activeLine: at, mention: null });
        return;
      }
      if (k === 'ask') { this.closePicker(); this.askInline(i); return; }
      if (k === 'pick') { this.openPicker(act, 'line'); return; }
      if (k === 'pickfollow') { this.openPicker(act, 'follow'); return; }
      if (k === 'sendfollow') { this.closePicker(); this.sendFollow(Number(act.dataset.thread)); return; }
      if (k === 'regen') { this.closePicker(); const q = Number(act.dataset.turn); this.regenerate(q, this.ranWith(this.lines(), q).choice); return; }
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
      if (k === 'stopask') { if (this.props.onStopAsk) this.props.onStopAsk(act.dataset.ask); return; }
      if (k === 'toggle') this.toggleTodo(i);
      else if (k === 'build') this.buildIdx([i]);
      else if (k === 'remove') this.removeLine(i);
      else if (k === 'buildall' && act.dataset.lines) this.buildIdx(act.dataset.lines.split(',').map(Number));
      return;
    }
    const a = e.target.closest('a[data-link]');
    if (a) { e.preventDefault(); this.openLink(a.getAttribute('href')); return; }
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
    const pick = e.target.closest('[data-act="pick"],[data-act="pickfollow"],[data-act="regen"]'); if (pick) this.openPicker(pick, { pick: 'line', pickfollow: 'follow', regen: 'regen' }[pick.dataset.act]);
  };
  // Leaving what opened the selector starts its closing clock, unless the pointer went straight onto the selector: React has
  // by then already handled that same event (the selector's onMouseEnter stops the clock), and this would start it again.
  editorOut = (e) => {
    if (e.target.closest('[data-mention]')) this.hidePop();
    const onto = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-bart-picker]');
    if (!onto && e.target.closest('[data-act="pick"],[data-act="pickfollow"],[data-act="regen"]')) this.leavePicker();
  };
  openLink(href) { if (this.props.onOpenLink) this.props.onOpenLink(href); else window.open(href, '_blank', 'noreferrer'); }
  docClick = (e) => { if (e.target !== e.currentTarget) return; this.docClickInternal(); };
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
  askInline(i) {
    const ls = this.lines(), p = parseLine(ls[i] || ''); if (p.type !== 'bart' || !p.text.trim() || !this.props.onAsk || this.lockedAt(ls, i)) return;
    const askId = newAskId(), add = [`bart~> ${askId}`]; if (i + 1 >= ls.length) add.push('');
    const turns = this.turnsBefore(ls, i);
    this.setLines((x) => { const out = [...x]; out.splice(i + 1, 0, ...add); return out; }); this.shiftStatuses(i + 1, add.length);
    const ed = this.editorEl(); if (ed) ed.blur(); this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: p.text.trim(), turns });
  }
  // The turns of the card above question `q`, as the document holds them: what a follow-up is a follow-up to.
  turnsBefore(ls, q) {
    const found = this.findTurn(ls, q); if (!found) return [];
    return found.thread.turns.filter((turn) => turn.q < q && turn.answered && !turn.pending).map((turn) => turnText(ls, turn));
  }
  // A follow-up: the question goes under the card's last answer as an @bart line of its own, with the pending line under it.
  sendFollow(from) {
    const ls = this.lines(), thread = threads(ls).find((t) => t.from === from), text = (this.followText.get(from) || '').trim();
    if (!thread || !text || !this.props.onAsk) return;
    const end = thread.turns[thread.turns.length - 1]; if (!end.answered || end.pending) return;
    const { flags } = this.followStep(ls, thread), asked = [flags, text].filter(Boolean).join(' ');
    const askId = newAskId(), add = [`@bart ${asked}`, `bart~> ${askId}`]; if (thread.to + 1 >= ls.length) add.push('');
    const turns = thread.turns.filter((turn) => turn.answered && !turn.pending).map((turn) => turnText(ls, turn));
    this.followText.delete(from);
    const ed = this.editorEl(); if (ed && ed.contains(document.activeElement)) document.activeElement.blur();
    this.setLines((x) => { const out = [...x]; out.splice(thread.to + 1, 0, ...add); return out; }); this.shiftStatuses(thread.to + 1, add.length);
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: asked, turns });
  }
  followKey(e) {
    if (this.state.picker) this.closePicker();
    if (e.key === 'Enter' && e.shiftKey) e.preventDefault(); // one line of the document: no line breaks
    else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.sendFollow(Number(e.target.dataset.followInput)); }
    else if (e.key === 'Escape') e.target.blur();
  }
  followInput(input) {
    if (/[\r\n]/.test(input.value)) { const a = input.selectionStart, b = input.selectionEnd; input.value = input.value.replace(/[\r\n]/g, ' '); input.setSelectionRange(a, b); }
    this.followText.set(Number(input.dataset.followInput), input.value); this.paintSend(input); this.fitFollow(input);
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
  // it. `choice` is a model and effort for this run; the line keeps the words it was asked with.
  regenerate(q, choice) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found || found.turn.pending || !this.props.onAsk) return;
    const { turn } = found, p = parseLine(ls[q]); if (!p.text.trim()) return;
    const askId = newAskId(), gone = turn.to - turn.q, turns = this.turnsBefore(ls, q);
    this.setLines((x) => { const out = [...x]; out.splice(turn.from, gone, `bart~> ${askId}`); return out; });
    if (gone > 1) this.shiftStatuses(turn.from + 1, -(gone - 1)); else if (!gone) this.shiftStatuses(turn.from, 1);
    this.setState({ activeLine: null, mention: null });
    this.props.onAsk({ askId, text: p.text.trim(), turns, choice: choice && this.props.models && modelOf(choice.model, this.props.models) ? choice : undefined });
  }
  // Collapse / Expand: the fold is in the file, on every line of the answer, so it survives whatever else changes.
  toggleFold(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found || !found.turn.answered) return;
    const { turn } = found, to = !turn.folded;
    this.setLines((x) => x.map((l, j) => { if (j < turn.from || j > turn.to) return l; const p = parseLine(l); return p.type === 'reply' ? replyLine(p.text, to).trimEnd() : l; }));
    this.setState({ activeLine: null, mention: null });
  }
  // Delete: this turn leaves the document, its question and its answer; the turns around it stay. A run still at work is stopped.
  deleteTurn(q) {
    const ls = this.lines(), found = this.findTurn(ls, q); if (!found) return;
    const { turn } = found, n = turn.to - turn.q + 1;
    if (turn.pending && this.props.onStopAsk) this.props.onStopAsk(turn.pending);
    this.setLines((x) => { const out = x.filter((_, j) => j < turn.q || j > turn.to); return out.length ? out : ['']; });
    this.shiftStatuses(turn.q, -n); this.setState({ activeLine: null, mention: null });
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
    const lead = (ls[pk.i].match(/^@bart/i) || ['@bart'])[0]; // "@Bart" (the @ menu's) or "@bart" (typed) stays as it was written
    const text = withChoice(p.text, models, choice), line = `${lead} ${text}${readFlags(text, models).rest ? '' : ' '}`;
    this.setLines((x) => x.map((l, j) => (j === pk.i ? line : l)), this.state.activeLine === pk.i ? { line: pk.i, offset: line.length } : undefined);
  };
  sendPicked = () => {
    const pk = this.state.picker; if (!pk || pk.kind !== 'regen') return;
    const choice = pk.choice || this.ranWith(this.lines(), pk.i).choice; this.closePicker(); this.regenerate(pk.i, choice);
  };

  /* ---------------------------------------------------------------- operations */
  bartItem() { return (this.props.mentionable || []).find((r) => r && r.id === 'bart') || BART_ITEM; }
  mentionList() {
    const q = (this.state.mention?.query || '').toLowerCase();
    if (this.props.mentionItems) return this.props.mentionItems(q); // the workspace's list: Bart, Task, Note, the open page, the library (model/rail.js)
    return (this.props.mentionable || []).filter((r) => r && ((r.name || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)));
  }
  pickMention(r) {
    const m = this.state.mention; if (!m || !r) return; const ls = this.lines(), p = parseLine(ls[m.i] || '');
    const cur = lineText(p, ls[m.i]);
    const verb = r.kind === 'verb' ? r.verb : r.id === 'task' || r.id === 'bart' ? r.id : null;
    if (verb === 'task') {
      // `@Task` is a trigger, not text: the line becomes the task row it names, keeping whatever else was on it.
      const rest = (cur.slice(0, m.start) + cur.slice(m.caret)).replace(/\s+$/, '');
      this.setLines((x) => x.map((l, j) => (j === m.i ? todoLine(isMarked(p.type) ? p.depth : 0, p.type === 'todo' && p.done, rest) : l)), { line: m.i, offset: rest.length });
      this.wantFocus = true; this.setState({ mention: null, activeLine: m.i }); return;
    }
    // Bart and Note are words the line keeps (Enter asks, or makes the note); anything else is a mention, and what it names
    // comes into this workspace (the open page is added to the library first: props.onMentionPicked).
    const ins = verb === 'bart' ? '@Bart ' : verb === 'note' ? '@Note ' : r.kind === 'workspace' ? `${wsMention(r.name, r.id)} ` : `@[${r.name}] `;
    this.writeText(m.i, cur.slice(0, m.start) + ins + cur.slice(m.caret), { line: m.i, offset: m.start + ins.length });
    this.wantFocus = true; this.setState({ mention: null, activeLine: m.i });
    if (!verb && r.kind !== 'workspace' && this.props.onMentionPicked) this.props.onMentionPicked(r); // a workspace is not a library row
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
  removeLine(i) { this.setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : [''])); this.shiftStatuses(i, -1); this.setState({ mention: null }); }
  toggleTodo(i) {
    this.setLines((ls) => ls.map((l, j) => { if (j !== i) return l; const p = parseLine(l); return todoLine(p.depth, !p.done, p.text); }));
    const key = this.key();
    this.setState((s) => ({ statuses: { ...s.statuses, [key]: { ...(s.statuses[key] || {}), [i]: '' } } }));
  }
  buildIdx(idxs) {
    const ls = this.lines(), open = idxs.filter((i) => { const p = parseLine(ls[i] || ''); return p.type === 'todo' && p.text.trim() && !p.done && !HELD.includes(this.status(i)); });
    if (!open.length) return; const key = this.key();
    this.setState((s) => { const st = { ...(s.statuses[key] || {}) }; open.forEach((i) => { st[i] = 'building'; }); return { statuses: { ...s.statuses, [key]: st }, mention: null }; });
    const k = this.speed();
    open.forEach((i, n) => {
      this.timer(() => this.setStatus(key, i, 'checking'), (1600 + n * 400) * k);
      this.timer(() => this.setStatus(key, i, 'done', true), (3000 + n * 400) * k);
    });
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
    else { const p = parseLine(ls[pk.i] || ''); if (p.type === 'bart') { const step = readQuestion(p.text, models).steps[0]; current = { provider: step.provider, model: step.key, effort: step.effort }; } }
    if (!current || !models.providers[current.provider]) return null;
    return <BartPicker models={models} current={current} anchor={pk} onPick={this.pickModel} onSend={pk.kind === 'regen' ? this.sendPicked : undefined} onEnter={this.stayPicker} onLeave={this.leavePicker} />;
  }
  render() {
    const s = this.state;
    const compact = this.props.compact;
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
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              aria-label={compact ? 'Post-it' : 'Document'}
              style={{ marginTop: compact ? 0 : 18, outline: 'none', minHeight: compact ? 28 : 240, font: '17px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', caretColor: '#171717', cursor: 'text' }}
            />
          </div>
        </div>
        {/* The footer (the document's Copy, 2026-09-23) sits under the text's left edge, not the pane's: this column
            repeats the scroller's padding and 65ch measure, so it stays with the note when panes split. */}
        {!compact && this.props.footer && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 14, zIndex: 3, paddingInline: 'clamp(12px, 4%, 40px)', pointerEvents: 'none' }}>
            <div style={{ maxWidth: '65ch', marginInline: 'auto', paddingInline: 'clamp(0px, 3%, 24px)', fontSize: 17, display: 'flex' }}>
              <span style={{ pointerEvents: 'auto' }}>{this.props.footer}</span>
            </div>
          </div>
        )}
        {s.mention && s.mention.anchor && <MentionMenu items={this.mentionList()} index={s.mentionIdx} anchor={s.mention.anchor} onPick={(r) => this.pickMention(r)} onHover={(i) => this.setState({ mentionIdx: i })} />}
        {s.pop && (s.pop.res.ws ? <WorkspacePeek id={s.pop.res.ws} name={s.pop.res.name} anchor={s.pop.anchor} peek={this.props.workspacePeek} /> : <Popover item={s.pop.res} anchor={s.pop.anchor} />)}
        {this.pickerView()}
      </>
    );
  }
}
