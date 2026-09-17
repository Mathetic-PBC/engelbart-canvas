// One markdown string per document, edited on a single contentEditable surface (Obsidian-style: the caret's
// line shows its source, every other line renders). Ported from design/goal-canvas/Goal Canvas.dc.html
// (state 458–466, listeners 492–512, document engine 678–983). Differences from the design:
//   * props.text is the source of truth; every edit calls props.onChange(text) synchronously.
//   * the `@[chat]` inline chat *panels* are gone; only the `@chat …` line form remains (tweaks #32/#33).
//   * image paste/drop is not supported (spec §2 #19); `![alt](http…)` lines still render.
//   * clicking into a rendered (non-active) line maps the display offset through rawOffset(), so the caret
//     lands on the clicked character even inside bold/mention markup.
import React from 'react';
import { parseLine, todoLine, esc, tokShown, tokensOf, rawOffset, inlineHtml, LABELS, HELD } from '../model/doc.js';
import MentionMenu from './MentionMenu.jsx';
import Popover from './Popover.jsx';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const SPEED = { fast: 0.45, normal: 1, slow: 2.2 };

export const CHAT_ITEM = { id: 'chat', type: 'chat', name: 'chat', title: 'Chat', summary: 'Talk to the model about this document. Replies are simulated in this prototype.', facts: 'simulated' };

/** The design's simulated reply: two lines, inserted below the prompt as `> ` quotes. */
export function defaultPlaceholderReply(prompt, docText) {
  const todos = String(docText || '').split('\n').map(parseLine).filter((q) => q.type === 'todo' && q.text.trim());
  const open = todos.filter((q) => !q.done);
  return [
    `I read this document — ${todos.length} todo${todos.length === 1 ? '' : 's'}, ${open.length} open.`,
    `About "${prompt}": no model is connected in this prototype, so this reply is simulated.`,
  ];
}

const RISE_CSS = '@keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}';

export default class DocEditor extends React.Component {
  state = { activeLine: null, mention: null, mentionIdx: 0, pop: null, statuses: {} };
  edRef = React.createRef();
  history = []; future = []; caret = null; lastHtml = ''; lastKey = null; selRaw = null; openKey = '';
  syncing = false; wantFocus = false; composing = false; mounted = false; timers = new Set();

  /* ---------------------------------------------------------------- lifecycle */
  componentDidMount() {
    this.mounted = true;
    const inEd = (e) => e.target && e.target.closest && e.target.closest('[data-editor]') === this.editorEl();
    this.docListeners = {
      keydown: (e) => { if (inEd(e)) this.editorKey(e); },
      input: (e) => { if (inEd(e)) this.editorInput(); },
      beforeinput: (e) => { if (!inEd(e)) return; const sel = getSelection(); this.bulkDelete = /^delete/.test(e.inputType || '') && !!sel && !sel.isCollapsed; },
      paste: (e) => { if (inEd(e)) this.editorPaste(e); },
      click: (e) => { if (inEd(e)) this.editorClick(e); },
      mouseover: (e) => { if (inEd(e)) this.editorOver(e); },
      mouseout: (e) => { if (inEd(e)) this.editorOut(e); },
      selectionchange: () => this.onSel(),
      dragover: (e) => { if (inEd(e)) e.preventDefault(); },
      drop: (e) => { if (inEd(e)) e.preventDefault(); },
      focusout: (e) => { if (inEd(e) && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('[data-mention-menu]'))) this.setState({ activeLine: null, mention: null }); },
      compositionstart: () => { this.composing = true; },
      compositionend: (e) => { this.composing = false; if (inEd(e)) this.editorInput(); },
    };
    Object.entries(this.docListeners).forEach(([k, f]) => document.addEventListener(k, f));
    this.syncEditor();
    if (Array.isArray(this.props.initialBuild) && this.props.initialBuild.length) this.buildIdx(this.props.initialBuild);
  }

  componentDidUpdate(prevProps) {
    if (prevProps.docKey !== this.props.docKey) {
      this.history = []; this.future = []; this.caret = null; this.lastHtml = ''; this.lastKey = null; this.selRaw = null; this.openKey = '';
      const s = this.state;
      if (s.activeLine != null || s.mention || s.pop) { this.setState({ activeLine: null, mention: null, pop: null }); return; }
    }
    this.syncEditor();
  }

  componentWillUnmount() {
    this.mounted = false;
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

  /* ---------------------------------------------------------------- document access */
  key() { return this.props.docKey; }
  lines() { return String(this.props.text ?? '').split('\n'); }
  editorEl() { return this.edRef.current; }
  statusesFor(key = this.key()) { return this.state.statuses[key] || {}; }
  status(i) { return this.statusesFor()[i] || ''; }
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
    this.setLines((ls) => ls.map((l, j) => { if (j !== i) return l; const p = parseLine(l); return p.type === 'todo' ? todoLine(p.depth, p.done, text) : text; }), caret);
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
  // Which tokens show their source on the active line: markers the caret touches, and a heading's `# ` only while the caret is inside it.
  openIdx(tokens, a, b, prefixCount = 0) { const out = []; let acc = 0; tokens.forEach((tok, k) => { const end = acc + tok.length; const isPrefix = k < prefixCount; const pre = isPrefix ? tok.length : tokShown(tok).pre; if (pre && (isPrefix ? (a < end && b >= acc) : (a <= end && b >= acc))) out.push(k); acc = end; }); return out; }
  activeHtml(tokens, prefixCount = 0) {
    const [a, b] = this.revealRange(), open = this.openIdx(tokens, a, b, prefixCount); this.openKey = open.join(',');
    return tokens.map((tok, k) => {
      if (k < prefixCount) { const isOpen = open.includes(k); return `<span data-src="${esc(tok)}" data-open="${isOpen ? 1 : 0}" data-prefix="1">${isOpen ? esc(tok) : ''}</span>`; }
      const isOpen = !tokShown(tok).pre || open.includes(k);
      return `<span data-src="${esc(tok)}" data-open="${isOpen ? 1 : 0}">${isOpen && tok !== '@chat' ? esc(tok) : inlineHtml(tok)}</span>`;
    }).join('');
  }
  segs(t) {
    return [...t.childNodes].filter((n) => n.nodeName !== 'BR').map((n) => {
      const el = n.nodeType === 1 && n.dataset && n.dataset.src != null ? n : null;
      const txt = n.textContent.replace(/\u200b/g, '');
      const open = !el || el.dataset.open === '1';
      const prefix = !!(el && el.dataset.prefix);
      return { dl: txt.length, src: open ? txt : el.dataset.src, open, rl: open ? txt.length : el.dataset.src.length, prefix };
    });
  }
  displayToRaw(t, disp) {
    const segs = this.segs(t); if (!segs.length) return null; let accD = 0, accR = 0;
    for (const s of segs) {
      if (disp <= accD + s.dl) { const d = disp - accD; if (s.open) return accR + d; if (s.prefix) return accR + s.rl; const { pre } = tokShown(s.src); return accR + (d === 0 ? 0 : Math.min(s.rl, pre + d)); }
      accD += s.dl; accR += s.rl;
    }
    return accR;
  }
  rawToDisplay(t, raw) {
    const segs = this.segs(t); let accD = 0, accR = 0;
    for (const s of segs) {
      if (raw <= accR + s.rl) { const d = raw - accR; if (s.open) return accD + d; if (s.prefix) return accD; const { pre } = tokShown(s.src); return accD + Math.max(0, Math.min(s.dl, d - pre)); }
      accD += s.dl; accR += s.rl;
    }
    return accD;
  }
  activeRaw(t) { return this.segs(t).map((s) => s.src).join(''); }

  lineHtml(i, line, p, active, status) {
    const raw = `data-line="${i}" data-raw="${esc(line)}"`;
    if (p.type === 'todo') {
      const held = HELD.includes(status), done = p.done, label = done ? 'Done' : (LABELS[status] || '');
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;margin-left:${p.depth * 24}px">`
        + `<span contenteditable="false" data-act="toggle" data-row="${i}" role="button" style="user-select:none;flex:none;width:14px;margin-top:12px;text-align:center;font:15px/1 var(--font-sans);color:${held ? '#c9c9c9' : done ? '#8f8f8f' : '#171717'};cursor:${held ? 'default' : 'pointer'}">${done ? '✓' : '–'}</span>`
        + `<span class="t" style="flex:1;min-width:0;padding:6px 0;min-height:39px;color:${(held || done) ? '#8f8f8f' : '#171717'};text-decoration:${done ? 'line-through' : 'none'}">${content || '<br>'}</span>`
        + (label ? `<span contenteditable="false" style="user-select:none;flex:none;margin-top:11px;font:600 11px/1.5 var(--font-sans);color:${status === 'failed' ? '#e70022' : '#8f8f8f'}">${label}</span>` : '')
        + (!held && !done ? `<button contenteditable="false" data-act="build" data-row="${i}" ${p.text.trim() ? '' : 'disabled'} style="user-select:none;flex:none;margin-top:7px;padding:4px 8px;border:1px solid #eaeaea;border-radius:6px;background:#fff;font:12px/1.5 var(--font-sans);color:#171717;cursor:pointer;opacity:${p.text.trim() ? 1 : .4};white-space:nowrap">Build</button>` : '')
        + (!held ? `<button contenteditable="false" data-act="remove" data-row="${i}" aria-label="Remove todo" style="user-select:none;flex:none;margin-top:12px;padding:0 2px;border:0;background:transparent;font:14px/1 var(--font-sans);color:#c9c9c9;cursor:pointer">×</button>` : '')
        + '</div>';
    }
    if (p.type === 'h') {
      const size = [26, 22, 18][p.level - 1]; const content = active ? this.activeHtml(tokensOf(p, line), 1) : inlineHtml(p.text);
      return `<div ${raw} style="padding:4px 0;min-height:35px;font:500 ${size}px/1.6 var(--font-sans);letter-spacing:-0.3px"><span class="t">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'chat') {
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(line); const busy = status === 'asking'; const ready = !!p.text.trim() && !busy;
      return `<div ${raw} style="display:flex;align-items:flex-start;gap:10px;padding:4px 0;min-height:35px"><span class="t" style="flex:1;min-width:0">${content || '<br>'}</span>`
        + `<button contenteditable="false" data-act="ask" data-row="${i}" aria-label="Send" ${ready ? '' : 'disabled'} style="user-select:none;flex:none;margin-top:3px;width:26px;height:26px;padding:0;border:0;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${ready ? '#0070f3' : '#eaeaea'};color:${ready ? '#fff' : '#8f8f8f'};cursor:${ready ? 'pointer' : 'default'};transition:background 160ms"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="square"><path d="M8 13.5V3.2M3.6 7.4 8 3l4.4 4.4"/></svg></button></div>`;
    }
    if (p.type === 'quote') {
      const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(p.text);
      return `<div ${raw} style="padding:2px 0 2px 14px;min-height:31px;border-left:2px solid #eaeaea;margin-left:2px;color:#4d4d4d;font-size:16px"><span class="t">${content || '<br>'}</span></div>`;
    }
    if (p.type === 'img') {
      const src = p.src.startsWith('img:') ? '' : p.src;
      const content = active ? this.activeHtml([line]) : `<img src="${esc(src)}" alt="${esc(p.text)}" draggable="false" style="display:block;max-width:100%;max-height:520px;margin:6px 0;border:1px solid #eaeaea;border-radius:8px;user-select:none">`;
      return `<div ${raw} style="padding:4px 0;min-height:35px"><span class="t" style="display:block">${content}</span></div>`;
    }
    const content = active ? this.activeHtml(tokensOf(p, line)) : inlineHtml(line);
    return `<div ${raw} style="padding:4px 0;min-height:35px"><span class="t">${content || '<br>'}</span></div>`;
  }
  groupHtml(group) {
    const open = group.filter((t) => t.p.text.trim() && !t.p.done); if (!open.length) return '';
    const busy = open.filter((t) => HELD.includes(t.status)), ready = open.filter((t) => !HELD.includes(t.status)), doneN = group.filter((t) => t.p.done).length;
    const label = busy.length && !ready.length ? 'Building…' : ready.length && busy.length ? `Queue ${ready.length}` : 'Build all';
    const note = `${group.length} todo${group.length === 1 ? '' : 's'} · ${doneN} done${busy.length ? ` · ${busy.length} in progress` : ''}`;
    return `<div contenteditable="false" style="user-select:none;display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:12px 0 18px"><span style="margin-right:auto;font:12px/1.5 var(--font-sans);color:#8f8f8f">${note}</span><button data-act="buildall" data-lines="${ready.map((t) => t.i).join(',')}" ${ready.length ? '' : 'disabled'} style="display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:42px;min-width:110px;padding:12px 20px;border:0;border-radius:8px;background:#0070f3;color:#fff;font:600 14px/1 var(--font-sans);cursor:pointer;opacity:${ready.length ? 1 : .4}">${label}</button></div>`;
  }
  editorHtml() {
    const ls = this.lines(), st = this.statusesFor(), active = this.state.activeLine; let out = '', group = [];
    ls.forEach((line, i) => {
      const p = parseLine(line);
      out += this.lineHtml(i, line, p, active === i, st[i] || '');
      if (p.type === 'todo') group.push({ i, p, status: st[i] || '' });
      const next = ls[i + 1];
      if (p.type === 'todo' && (next == null || parseLine(next).type !== 'todo')) { out += this.groupHtml(group); group = []; }
    });
    return out;
  }
  syncEditor() {
    const ed = this.editorEl(); if (!ed) return; const key = this.key(), html = this.editorHtml();
    const hadFocus = document.activeElement === ed || ed.contains(document.activeElement);
    if (html === this.lastHtml && key === this.lastKey) {
      if (this.caret && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.applyCaret(); }
      this.wantFocus = false; return;
    }
    const c = this.caret || (hadFocus ? this.caretInfo()?.anchor : null);
    if (c && !this.caret) this.caret = c;
    this.syncing = true; ed.innerHTML = html; this.lastHtml = html; this.lastKey = key;
    if (c && (hadFocus || this.wantFocus)) { ed.focus({ preventScroll: true }); this.caret = c; this.applyCaret(); }
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
      if (t && t.contains(n)) { const r = document.createRange(); r.selectNodeContents(t); r.setEnd(n, o); off = r.toString().replace(/​/g, '').length; } else off = t ? t.textContent.length : 0;
      const isActive = Number(d.dataset.line) === this.state.activeLine;
      let raw = null;
      if (t && (isActive || t.querySelector('[data-src]'))) raw = this.displayToRaw(t, off);
      if (raw == null) { const line = d.dataset.raw || '', p = parseLine(line); raw = isActive ? off : p.type === 'img' ? 0 : rawOffset(p, off, line); }
      return { line: Number(d.dataset.line), offset: raw };
    };
    const anchor = info(sel.anchorNode, sel.anchorOffset), focus = info(sel.focusNode, sel.focusOffset) || anchor;
    return anchor ? { anchor, focus } : null;
  }

  /* ---------------------------------------------------------------- events */
  onSel() {
    if (this.syncing) return; const c = this.caretInfo(); if (!c) return;
    const a = Math.min(c.anchor.offset, c.focus.offset), b = Math.max(c.anchor.offset, c.focus.offset);
    if (c.anchor.line !== this.state.activeLine) {
      this.selRaw = { line: c.anchor.line, a, b };
      if (!this.caret) this.caret = { line: c.anchor.line, sel: [a, b] };
      this.setState({ activeLine: c.anchor.line, mention: null }); return;
    }
    this.selRaw = { line: c.anchor.line, a, b };
    const ls = this.lines(), line = ls[c.anchor.line] ?? '', p = parseLine(line), key = p.type === 'img' ? '' : this.openIdx(tokensOf(p, line), a, b, p.type === 'h' ? 1 : 0).join(',');
    if (key !== this.openKey) { this.caret = { line: c.anchor.line, sel: [a, b] }; this.forceUpdate(); }
  }
  editorInput = () => {
    const ed = this.editorEl(); if (!ed || this.composing) return; const old = this.lines();
    const divs = [...ed.querySelectorAll('[data-raw]')], c = this.caretInfo(), activeId = c ? c.anchor.line : null;
    // Text the browser put outside the line structure (a caret that landed on the root) is folded into the last line.
    const strayText = [...ed.childNodes]
      .filter((n) => (n.nodeType === 3 && n.textContent.trim()) || (n.nodeType === 1 && n.getAttribute('data-line') == null && n.getAttribute('contenteditable') !== 'false' && n.textContent.trim()))
      .map((n) => n.textContent).join('').replace(/\u200b/g, '');
    let strip = 0, cleared = false;
    // A non-collapsed selection at the last selectionchange (which precedes the edit; the collapse arrives after `input`)
    // or a beforeinput delete of a selection: the edit removed a range, not a character.
    const bulk = this.bulkDelete || !!(this.selRaw && this.selRaw.a !== this.selRaw.b); this.bulkDelete = false;
    let ls = divs.map((d) => {
      const raw = d.dataset.raw ?? ''; if (Number(d.dataset.line) !== activeId) return raw;
      const t = d.querySelector('.t'); let txt = t ? this.activeRaw(t) : ''; const p = parseLine(raw);
      if (p.type !== 'todo') return txt;
      // A bulk deletion that empties a todo leaves a plain empty line, as deleting everything should.
      if (bulk && !txt.trim()) { cleared = true; return ''; }
      // A list marker typed into an empty todo row starts the todo instead of nesting a literal "- ".
      if (!p.text.trim()) { const m = txt.match(/^- (?:\[[ xX]\] )?/); if (m) { strip = m[0].length; txt = txt.slice(strip); } }
      return todoLine(p.depth, p.done, txt);
    });
    if (!ls.length) ls = [''];
    let pos = divs.findIndex((d) => Number(d.dataset.line) === activeId);
    let caret = c && pos >= 0 ? { line: pos, offset: c.anchor.offset } : null;
    if (caret && (strip || cleared)) { caret = { line: pos, offset: cleared ? 0 : Math.max(0, caret.offset - strip) }; this.lastHtml = null; }
    if (strayText) {
      const last = ls.length - 1, q = parseLine(ls[last]), base = q.type === 'todo' ? q.text.length : ls[last].length;
      ls[last] = q.type === 'todo' ? todoLine(q.depth, q.done, q.text + strayText) : ls[last] + strayText;
      pos = last; caret = { line: last, offset: base + strayText.length }; this.lastHtml = null;
    }
    if (caret) {
      const before = parseLine(old[activeId] ?? ''), after = parseLine(ls[pos] ?? '');
      if (before.type !== 'todo' && after.type === 'todo') caret = { line: pos, offset: Math.max(0, caret.offset - (ls[pos].length - after.text.length)) };
    }
    const nextText = ls.join('\n'); const unchanged = nextText === this.props.text;
    this.setDoc(nextText, caret);
    // A strip or clear that leaves the stored text as it was still has to redraw the line the browser altered.
    if (unchanged && (strip || cleared)) this.syncEditor();
    if (caret) {
      const p = parseLine(ls[pos] ?? ''), txt = p.type === 'todo' ? p.text : ls[pos], m = txt.slice(0, caret.offset).match(/@([^\s@\[\]]{0,30})$/);
      if (m) {
        const r = getSelection().getRangeAt(0).getBoundingClientRect();
        this.setState({ activeLine: pos, mention: { i: pos, query: m[1], start: caret.offset - m[0].length, caret: caret.offset, x: clamp(r.left, 8, (window.innerWidth || 1200) - 300), y: r.bottom + 6 }, mentionIdx: 0 });
      } else this.setState((s) => (s.mention || s.activeLine !== pos ? { mention: null, activeLine: pos } : null));
    }
  };
  editorKey = (e) => {
    const s = this.state, c = this.caretInfo(); if (!c) return; const ls = this.lines();
    const i = c.anchor.line, line = ls[i] ?? '', p = parseLine(line), cur = p.type === 'todo' ? p.text : line, mod = e.metaKey || e.ctrlKey;
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
    if (e.key === 'Tab') { e.preventDefault(); if (p.type === 'todo') { this.indent(i, e.shiftKey ? -1 : 1); this.caret = { line: i, offset: a }; } return; }
    if (e.key === 'Enter' && !e.shiftKey && !mod && p.type === 'chat') { e.preventDefault(); this.askInline(i); return; }
    if (e.key === 'Enter' && !e.shiftKey && !mod) {
      e.preventDefault(); if (!same) return;
      if (p.type === 'todo' && !p.text.trim()) { this.setLines((x) => x.map((l, j) => (j === i ? '' : l)), { line: i, offset: 0 }); return; }
      const head = cur.slice(0, a), tail = cur.slice(b), l1 = p.type === 'todo' ? todoLine(p.depth, p.done, head) : head, l2 = p.type === 'todo' ? todoLine(p.depth, false, tail) : tail;
      this.setLines((x) => { const out = [...x]; out[i] = l1; out.splice(i + 1, 0, l2); return out; }, { line: i + 1, offset: 0 });
      this.shiftStatuses(i + 1, 1); this.setState({ activeLine: i + 1, mention: null }); return;
    }
    if (e.key === 'Backspace' && collapsed && a === 0) {
      if (p.type === 'todo') {
        e.preventDefault();
        if (p.depth > 0) { this.indent(i, -1); this.caret = { line: i, offset: 0 }; } else this.setLines((x) => x.map((l, j) => (j === i ? p.text : l)), { line: i, offset: 0 });
        return;
      }
      if (i > 0) {
        e.preventDefault(); const q = parseLine(ls[i - 1]), off = (q.type === 'todo' ? q.text : ls[i - 1]).length;
        this.setLines((x) => { const out = [...x]; out[i - 1] = x[i - 1] + cur; out.splice(i, 1); return out; }, { line: i - 1, offset: off });
        this.shiftStatuses(i, -1); this.setState({ activeLine: i - 1, mention: null });
      }
      return;
    }
    if (e.key === 'Delete' && collapsed && a === cur.length && i < ls.length - 1) {
      e.preventDefault(); const q = parseLine(ls[i + 1]), nt = q.type === 'todo' ? q.text : ls[i + 1];
      this.setLines((x) => { const out = [...x]; out[i] = x[i] + nt; out.splice(i + 1, 1); return out; }, { line: i, offset: cur.length });
      this.shiftStatuses(i + 1, -1); return;
    }
    if (e.key === 'Escape') { const ed = this.editorEl(); if (ed) ed.blur(); }
  };
  editorPaste = (e) => {
    const c = this.caretInfo(); if (!c) return; e.preventDefault();
    const text = ((e.clipboardData || window.clipboardData).getData('text/plain') || '').replace(/\r/g, ''); if (!text) return;
    const ls = this.lines(), i = c.anchor.line, line = ls[i] ?? '', p = parseLine(line), cur = p.type === 'todo' ? p.text : line;
    const same = c.anchor.line === c.focus.line, a = same ? Math.min(c.anchor.offset, c.focus.offset) : c.anchor.offset, b = same ? Math.max(c.anchor.offset, c.focus.offset) : a;
    const parts = text.split('\n');
    if (parts.length === 1) { this.writeText(i, cur.slice(0, a) + text + cur.slice(b), { line: i, offset: a + text.length }); return; }
    const first = cur.slice(0, a) + parts[0], last = parts[parts.length - 1] + cur.slice(b);
    this.setLines((x) => { const out = [...x]; out[i] = p.type === 'todo' ? todoLine(p.depth, p.done, first) : first; out.splice(i + 1, 0, ...parts.slice(1, -1), last); return out; }, { line: i + parts.length - 1, offset: parts[parts.length - 1].length });
    this.shiftStatuses(i + 1, parts.length - 1); this.setState({ activeLine: i + parts.length - 1, mention: null });
  };
  editorClick = (e) => {
    if (e.target === this.editorEl()) { this.focusEnd(); return; } // the editor's own empty space below the last line
    const act = e.target.closest('[data-act]');
    if (act) {
      e.preventDefault(); const i = Number(act.dataset.row), k = act.dataset.act;
      if (k === 'ask') { this.askInline(i); return; }
      if (k === 'toggle') this.toggleTodo(i);
      else if (k === 'build') this.buildIdx([i]);
      else if (k === 'remove') this.removeLine(i);
      else if (k === 'buildall' && act.dataset.lines) this.buildIdx(act.dataset.lines.split(',').map(Number));
      return;
    }
    const a = e.target.closest('a[data-link]');
    if (a) { e.preventDefault(); this.openLink(a.getAttribute('href')); return; }
    const m = e.target.closest('[data-mention]');
    if (m) {
      e.preventDefault(); this.hidePop(); const nm = m.dataset.mention; if (nm.startsWith('chat')) return;
      const res = this.findRes(nm); if (res.id !== '?' && this.props.onOpenItem) this.props.onOpenItem(res);
    }
  };
  editorOver = (e) => { const m = e.target.closest('[data-mention]'); if (m) this.showPop(this.findRes(m.dataset.mention), { currentTarget: m }); };
  editorOut = (e) => { if (e.target.closest('[data-mention]')) this.hidePop(); };
  openLink(href) { if (this.props.onOpenLink) this.props.onOpenLink(href); else window.open(href, '_blank', 'noreferrer'); }
  docClick = (e) => { if (e.target !== e.currentTarget) return; this.docClickInternal(); };
  docClickInternal() {
    const ed = this.editorEl(); if (!ed) return;
    const ls = this.lines(), last = ls.length - 1, p = parseLine(ls[last]);
    this.caret = { line: last, offset: (p.type === 'todo' ? p.text : ls[last]).length }; this.wantFocus = true; ed.focus({ preventScroll: true });
    if (this.state.activeLine === last) this.applyCaret(); else this.setState({ activeLine: last });
  }

  /* ---------------------------------------------------------------- chat (placeholder replies) */
  askInline(i) {
    const ls = this.lines(), p = parseLine(ls[i] || ''); if (p.type !== 'chat' || !p.text.trim() || this.status(i) === 'asking') return;
    const key = this.key();
    this.setState((s) => ({ statuses: { ...s.statuses, [key]: { ...(s.statuses[key] || {}), [i]: 'asking' } } }));
    const ed = this.editorEl(); if (ed) ed.blur(); this.setState({ activeLine: null, mention: null });
    this.timer(() => {
      const clear = () => this.setState((s) => ({ statuses: { ...s.statuses, [key]: { ...(s.statuses[key] || {}), [i]: '' } } }));
      if (key !== this.key()) { clear(); return; }
      const cur = this.lines(); const prompt = p.text.trim();
      const reply = (this.props.placeholderReply || defaultPlaceholderReply)(prompt, cur.join('\n'));
      let j = i + 1; while (j < cur.length && parseLine(cur[j]).type === 'quote') j++;
      const quotes = (Array.isArray(reply) ? reply : [String(reply)]).map((t) => '> ' + t);
      this.setLines((x) => { const out = [...x]; out.splice(i + 1, j - i - 1, ...quotes); return out; });
      this.shiftStatuses(i + 1, quotes.length - (j - i - 1));
      clear();
    }, 700);
  }

  /* ---------------------------------------------------------------- operations */
  chatItem() { return (this.props.mentionable || []).find((r) => r && r.id === 'chat') || CHAT_ITEM; }
  mentionList() {
    const q = (this.state.mention?.query || '').toLowerCase();
    return (this.props.mentionable || []).filter((r) => r && ((r.name || '').toLowerCase().includes(q) || (r.title || '').toLowerCase().includes(q)));
  }
  pickMention(r) {
    const m = this.state.mention; if (!m || !r) return; const ls = this.lines(), p = parseLine(ls[m.i] || '');
    const cur = p.type === 'todo' ? p.text : ls[m.i], ins = r.id === 'chat' ? '@chat ' : `@[${r.name}] `;
    this.writeText(m.i, cur.slice(0, m.start) + ins + cur.slice(m.caret), { line: m.i, offset: m.start + ins.length });
    this.wantFocus = true; this.setState({ mention: null, activeLine: m.i });
  }
  wrap(i, cur, st, en, mark) { this.writeText(i, cur.slice(0, st) + mark + cur.slice(st, en) + mark + cur.slice(en), { line: i, sel: [st + mark.length, en + mark.length] }); }
  link(i, cur, st, en) { const sel = cur.slice(st, en) || 'link'; const a = st + sel.length + 3; this.writeText(i, cur.slice(0, st) + `[${sel}](url)` + cur.slice(en), { line: i, sel: [a, a + 3] }); }
  indent(i, dir) {
    this.setLines((ls) => {
      const p = parseLine(ls[i] || ''); if (p.type !== 'todo') return ls; const nd = clamp(p.depth + dir, 0, 8); if (nd === p.depth) return ls;
      if (dir > 0) { const prev = parseLine(ls[i - 1] || ''); if (prev.type !== 'todo' || nd > prev.depth + 1) return ls; }
      const out = [...ls]; out[i] = todoLine(nd, p.done, p.text);
      for (let j = i + 1; j < ls.length; j++) { const q = parseLine(ls[j]); if (q.type !== 'todo' || q.depth <= p.depth) break; out[j] = todoLine(clamp(q.depth + dir, 0, 8), q.done, q.text); }
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
    const n = String(name).toLowerCase(); if (n.startsWith('chat')) return this.chatItem();
    return (this.props.mentionable || []).find((r) => r && r.id !== 'chat' && (r.name || '').toLowerCase() === n)
      || { id: '?', type: 'note', name, title: name, summary: 'Not attached to this topic yet.', facts: 'unresolved' };
  }
  showPop(res, e) { const r = e.currentTarget.getBoundingClientRect(); this.setState({ pop: { res, x: clamp(r.left, 8, (window.innerWidth || 1200) - 340), y: r.bottom + 8 } }); }
  hidePop = () => { if (this.state.pop) this.setState({ pop: null }); };

  /* ---------------------------------------------------------------- render */
  render() {
    const s = this.state;
    return (
      <>
        <style>{RISE_CSS}</style>
        <div onClick={this.docClick} style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '28px clamp(12px, 4%, 40px) 120px', cursor: 'text' }}>
          <div style={{ maxWidth: '65ch', marginInline: 'auto', paddingInline: 'clamp(0px, 3%, 24px)', cursor: 'auto', fontSize: 17 }}>
            {this.props.header}
            <div
              data-editor="1"
              ref={this.edRef}
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              role="textbox"
              aria-multiline="true"
              aria-label="Document"
              style={{ marginTop: 18, outline: 'none', minHeight: 240, font: '17px/1.6 var(--font-sans)', color: '#171717', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', caretColor: '#171717', cursor: 'text' }}
            />
          </div>
        </div>
        {s.mention && <MentionMenu items={this.mentionList()} index={s.mentionIdx} x={s.mention.x} y={s.mention.y} onPick={(r) => this.pickMention(r)} />}
        {s.pop && <Popover item={s.pop.res} x={s.pop.x} y={s.pop.y} />}
      </>
    );
  }
}
