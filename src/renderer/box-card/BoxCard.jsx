import React from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens/typography.css';
import '@fontsource/caveat/500.css';
import { inlineHtml, noteInkHtml } from '../model/doc.js';
import { noteQuestion, askedByNote, runningLabel } from '../pdf/canvas.js';

// The card beside a selected box on a web page (MATH-70 build 2, 2026-10-07): its own small view, one per window, which
// main places beside the box and moves with it (src/main/browser/views.cjs `card`). The one component Hudson will replace:
// everything it needs comes through window.boxCardAPI (src/main/browser/box-card-preload.cjs), and its look is a copy of
// the pdf's card (src/renderer/pdf/PaperView.jsx, its values copied here, not imported): the Caveat note, ASK_W wide,
// the grip, the trash, the divider between the note and each answer, the answer's paragraphs and the spinner. Over a web
// page it needs a ground of its own, so it is white with a thin edge and a soft shadow (the pdf's sits on its desk).
// The note is saved on the box's mark as it is typed; Enter in a note that starts with @bart asks (Shift+Enter is a new
// line), and the answer comes in under it. Keys typed here are the card's: Backspace never removes the box.

const api = window.boxCardAPI;

// PaperView's values (2026-10-07), copied.
const NOTE_INK = '#1f2633';
const NOTE_LOOK = { padding: '0 6px', font: "500 20px/1.2 'Caveat',cursive", letterSpacing: '.2px', color: NOTE_INK, WebkitFontSmoothing: 'antialiased' };
const ASK_W = 320;
const GRIP = { height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' };
const GRIP_BAR = { width: 22, height: 3, borderRadius: 2, background: '#d9d9d9' };
const TRASH = { position: 'absolute', top: 1, right: 3, width: 18, height: 18, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 0, background: 'rgba(255,255,255,.97)', color: '#8f8f8f', cursor: 'pointer' };
const DIVIDER = '1px solid #ececec'; // between the note and an answer, and between two answers
const SPINNER = { flex: 'none', width: 10, height: 10, boxSizing: 'border-box', border: '1.5px solid #c9d9f2', borderTopColor: '#0070f3', borderRadius: '50%', animation: 'card-spin .8s linear infinite' };
const BUTTON = { border: 0, background: 'transparent', padding: '2px 6px', borderRadius: 5, font: '12px/1.4 var(--font-sans)', color: '#4d4d4d', cursor: 'pointer', whiteSpace: 'nowrap' };
const ANSWER_MAX = 320; // an answer scrolls inside past this many pixels

const CSS = `
*{box-sizing:border-box}
html,body,#root{margin:0;background:transparent;color:#171717;font:13px/1.55 var(--font-sans);overflow:hidden}
@keyframes card-spin{to{transform:rotate(360deg)}}
[data-card] button:hover{background:#f2f2f2}
[data-card] [data-trash]:hover{background:#f2f2f2;color:#171717}
[data-card] [data-answer] p{margin:0 0 6px}
[data-card] a{color:#0070f3;text-decoration:underline;text-underline-offset:2px}
[data-card] textarea::placeholder{color:#b5b5b5}
`;

const TRASH_SVG = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" /></svg>
);

// An answer as the pdf's box draws it: a paragraph a line, bold, italic, code and links, a list's or a heading's mark
// taken off should one come anyway (PaperView answerParas).
function answerParas(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const item = line.match(/^[-*] (.*)$/), head = line.match(/^#{1,6} (.*)$/);
    return item ? `• ${inlineHtml(item[1])}` : head ? `<strong>${inlineHtml(head[1])}</strong>` : inlineHtml(line);
  });
}
const answerHtml = (text) => answerParas(text).map((inside) => `<p>${inside}</p>`).join('');
// a link in an answer never takes the card's page anywhere (main refuses it too)
const noFollow = (event) => { if (event.target.closest && event.target.closest('a[href]')) event.preventDefault(); };

/** The note: a field in the note's ink, a leading @bart drawn as the document's blue label under its transparent text. */
function Note({ value, onChange, onKeyDown, fieldRef }) {
  const inked = noteQuestion(value) != null;
  const grow = React.useCallback(() => { const ta = fieldRef.current; if (ta) { ta.style.height = '0px'; ta.style.height = `${ta.scrollHeight}px`; } }, [fieldRef]);
  React.useLayoutEffect(grow, [value, grow]);
  const field = { ...NOTE_LOOK, display: 'block', width: '100%', margin: 0, border: 0, background: 'transparent', resize: 'none', overflow: 'hidden', outline: 'none', ...(inked ? { position: 'relative', color: 'transparent', caretColor: NOTE_INK } : {}) };
  return (
    <div style={{ flex: 'none', paddingBottom: 4, position: 'relative' }}>
      {inked && <div aria-hidden="true" style={{ ...NOTE_LOOK, position: 'absolute', inset: 0, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', pointerEvents: 'none' }} dangerouslySetInnerHTML={{ __html: noteInkHtml(value) }} />}
      <textarea ref={fieldRef} rows={1} value={value} placeholder="Note, or @bart and a question" spellCheck={false} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} style={field} />
    </div>
  );
}

/** A finished answer: its question in grey when it is not what the note asks now, then the answer. The model that wrote it
 *  (ask.meta) is kept but not shown (MATH-70 build 3). */
function Answer({ ask, note, divided }) {
  const asked = askedByNote(ask.question, note) ? '' : String(ask.question || '');
  return (
    <div data-ask={ask.id} style={{ flex: 'none', display: 'flex', flexDirection: 'column', borderTop: divided ? DIVIDER : 0, paddingTop: divided ? 8 : 0 }}>
      {asked && <div title={asked} style={{ flex: 'none', padding: '0 12px 6px', color: '#8f8f8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asked}</div>}
      <div data-answer="1" onClick={noFollow} style={{ flex: 'none', maxHeight: ANSWER_MAX, overflow: 'auto', padding: '0 12px 6px', overflowWrap: 'anywhere', userSelect: 'text' }} dangerouslySetInnerHTML={{ __html: answerHtml(ask.answer) }} />
    </div>
  );
}

/** An answer being written: what Bart is doing with a spinner and Stop, then the answer as it comes; a failure says why, with ×. */
function Running({ run, note, divided }) {
  const failed = run.error != null;
  const lines = !failed && run.activity === 'Writing' && Array.isArray(run.lines) ? run.lines : [];
  const asked = askedByNote(run.question, note) ? '' : String(run.question || '');
  return (
    <div data-ask-run={run.askId} style={{ flex: 'none', display: 'flex', flexDirection: 'column', borderTop: divided ? DIVIDER : 0, paddingTop: divided ? 8 : 0 }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 6px 4px 12px' }}>
        {failed ? <span style={{ flex: 1, minWidth: 0, fontWeight: 500, color: '#171717' }}>Bart · No answer</span>
          : <><span style={SPINNER} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#4d4d4d' }}>{runningLabel(run)}</span></>}
        <button type="button" aria-label={failed ? 'Close' : 'Stop'} onClick={() => api.stop(run.askId)} style={BUTTON}>{failed ? '×' : 'Stop'}</button>
      </div>
      {asked && <div title={asked} style={{ flex: 'none', padding: '0 12px 6px', color: '#8f8f8f', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asked}</div>}
      {failed && <div style={{ flex: 'none', padding: '0 12px 8px', color: '#c4372d', overflowWrap: 'anywhere' }}>{run.error || 'The run failed.'}</div>}
      {lines.length > 0 && <div data-answer="1" onClick={noFollow} style={{ flex: 'none', maxHeight: ANSWER_MAX, overflow: 'auto', padding: '0 12px 8px', color: '#8f8f8f', overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: answerHtml(lines.join('\n')) }} />}
    </div>
  );
}

const NOTE_SAVE_MS = 300;

function BoxCard() {
  const [state, setState] = React.useState(null); // { mark: { id, note, asks }, running }
  const [note, setNote] = React.useState('');
  const field = React.useRef(null), root = React.useRef(null), shown = React.useRef(null), timer = React.useRef(0), unsaved = React.useRef(null);

  const flush = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = 0;
    if (unsaved.current != null) { api.note(unsaved.current); unsaved.current = null; }
  }, []);
  React.useEffect(() => {
    const off = api.onState((next) => {
      if (!next || !next.mark) return;
      // another box: its note, whatever was typed for the last one saved first; the same box: the kept note, unless
      // this one is being typed in
      if (shown.current !== next.mark.id) { flush(); shown.current = next.mark.id; setNote(next.mark.note || ''); }
      else if (document.activeElement !== field.current && unsaved.current == null) setNote(next.mark.note || '');
      setState(next);
    });
    api.ready();
    return () => { off(); flush(); };
  }, [flush]);
  // how tall it is, for main to give its view that height
  React.useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => api.size({ height: el.offsetHeight }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const change = (value) => {
    setNote(value);
    unsaved.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, NOTE_SAVE_MS);
  };
  const key = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    const question = noteQuestion(event.currentTarget.value);
    if (question == null) return;
    event.preventDefault();
    if (!question) return;
    flush();
    api.ask(question);
  };

  const asks = state && state.mark ? state.mark.asks || [] : [];
  const running = state && Array.isArray(state.running) ? state.running : [];
  return (
    <div ref={root} style={{ padding: 8, width: ASK_W + 16 }}>
      <style>{CSS}</style>
      <div data-card="1" style={{ width: ASK_W, display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #eaeaea', borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,.08)', paddingBottom: 4 }}>
        <div style={GRIP}>
          <span style={GRIP_BAR} />
          <button type="button" data-trash="1" title="Remove box" aria-label="Remove box" onMouseDown={(event) => event.preventDefault()} onClick={() => api.remove()} style={TRASH}>{TRASH_SVG}</button>
        </div>
        <Note value={note} onChange={change} onKeyDown={key} fieldRef={field} />
        {/* the note is first: every answer comes under a divider */}
        {asks.map((ask, i) => <Answer key={ask.id || `ask-${i}`} ask={ask} note={note} divided />)}
        {running.map((run) => <Running key={run.askId} run={run} note={note} divided />)}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<BoxCard />);
