import React from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens/typography.css';
import '@fontsource/caveat/500.css';
import 'katex/dist/katex.min.css';
import { inlineHtml, noteInkHtml } from '../model/doc.js';
import { noteQuestion, askedByNote, runningLabel } from '../pdf/canvas.js';
import { NOTE_INK, NOTE_TYPE, ANSWER_FONT, ANSWER_INK, QUESTION_INK, LABEL_INK, ERROR_INK, ANSWER_GAP, SPINNER as SPINNER_CSS, CARD_GROUND, cardCss, styleOf } from '../pdf/card-look.js';

// The card beside a selected box on a web page (MATH-70 build 2, 2026-10-07): its own small view, one per window, which
// main places beside the box and moves with it (src/main/browser/views.cjs `card`). The one component Hudson will replace:
// everything it needs comes through window.boxCardAPI (src/main/browser/box-card-preload.cjs). It looks as the pdf's card
// does (2026-10-17, David: "exactly like the annotation card on PDFs"), from the same values (src/renderer/pdf/card-look.js,
// imported, never copied): the Caveat note, the answers' type and inks, room rather than a rule between the note and each
// answer, the buttons, the answer's paragraphs and the spinner. The pdf's card has no box of its own, only handwriting on
// the paper's white; over a web page this one is given that white (CARD_GROUND) and no edge, corners or shadow. ASK_W wide,
// with the trash.
// The note is saved on the box's mark as it is typed; Enter in a note that starts with @bart asks (Shift+Enter is a new
// line), and the answer comes in under it. Keys typed here are the card's: Backspace never removes the box.

const api = window.boxCardAPI;

const NOTE_LOOK = styleOf(NOTE_TYPE);
const ANSWER_LOOK = { ...styleOf(ANSWER_FONT), color: ANSWER_INK };
const ASK_W = 320;
// A card with no answers is only as wide as its note (David, 2026-10-07: "make the text box smaller"), from MIN_W to ASK_W:
// its longest line, measured in the note's ink, and the field's padding and edge.
const MIN_W = 140;
const NOTE_ROOM = 12 + 2 + 6;
const PLACEHOLDER = 'Note, or @bart and a question';
const GRIP = { height: 12, position: 'relative' }; // the trash's row (the pdf's card has no grip bar since 2026-10-16)
const TRASH = { position: 'absolute', top: 1, right: 3, width: 18, height: 18, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 0, background: 'rgba(255,255,255,.97)', color: '#8f8f8f', cursor: 'pointer' };
const GAP = styleOf(ANSWER_GAP); // between the note and an answer, and between two answers
const SPINNER = styleOf(SPINNER_CSS);
const ANSWER_MAX = 320; // an answer scrolls inside past this many pixels

const CSS = `
*{box-sizing:border-box}
html,body,#root{margin:0;background:transparent;color:${ANSWER_INK};${ANSWER_FONT};overflow:hidden}
${cardCss('[data-card]')}
[data-card] [data-trash]:hover{background:#f2f2f2;color:#171717}
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
      <textarea ref={fieldRef} rows={1} value={value} placeholder={PLACEHOLDER} spellCheck={false} onChange={(event) => onChange(event.target.value)} onKeyDown={onKeyDown} style={field} />
    </div>
  );
}

/** A finished answer: its question in grey when it is not what the note asks now, then the answer. The model that wrote it
 *  (ask.meta) is kept but not shown (MATH-70 build 3). */
function Answer({ ask, note, divided }) {
  const asked = askedByNote(ask.question, note) ? '' : String(ask.question || '');
  return (
    <div data-ask={ask.id} style={{ ...(divided ? GAP : {}), flex: 'none', display: 'flex', flexDirection: 'column', ...ANSWER_LOOK }}>
      {asked && <div title={asked} style={{ flex: 'none', padding: '0 6px 6px', color: QUESTION_INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asked}</div>}
      <div data-ask-body="1" onClick={noFollow} style={{ flex: 'none', maxHeight: ANSWER_MAX, overflow: 'auto', padding: '0 6px 2px', overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: answerHtml(ask.answer) }} />
    </div>
  );
}

/** An answer being written: what Bart is doing with a spinner and Stop, then the answer as it comes; a failure says why, with ×. */
function Running({ run, note, divided }) {
  const failed = run.error != null;
  const lines = !failed && run.activity === 'Writing' && Array.isArray(run.lines) ? run.lines : [];
  const asked = askedByNote(run.question, note) ? '' : String(run.question || '');
  return (
    <div data-ask-run={run.askId} style={{ ...(divided ? GAP : {}), flex: 'none', display: 'flex', flexDirection: 'column', ...ANSWER_LOOK }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 4px 6px' }}>
        {failed ? <span style={{ flex: 1, minWidth: 0, fontWeight: 500, color: ANSWER_INK }}>Bart · No answer</span>
          : <><span style={SPINNER} /><span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: LABEL_INK }}>{runningLabel(run)}</span></>}
        <button type="button" aria-label={failed ? 'Close' : 'Stop'} onClick={() => api.stop(run.askId)}>{failed ? '×' : 'Stop'}</button>
      </div>
      {asked && <div title={asked} style={{ flex: 'none', padding: '0 6px 6px', color: QUESTION_INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{asked}</div>}
      {failed && <div style={{ flex: 'none', padding: '0 6px 8px', color: ERROR_INK, overflowWrap: 'anywhere' }}>{run.error || 'The run failed.'}</div>}
      {lines.length > 0 && <div data-run-body="1" onClick={noFollow} style={{ flex: 'none', maxHeight: ANSWER_MAX, overflow: 'auto', padding: '0 6px 8px', color: QUESTION_INK, overflowWrap: 'anywhere' }} dangerouslySetInnerHTML={{ __html: answerHtml(lines.join('\n')) }} />}
    </div>
  );
}

const NOTE_SAVE_MS = 300;

function BoxCard() {
  const [state, setState] = React.useState(null); // { mark: { id, note, asks }, running }
  const [note, setNote] = React.useState('');
  const [noteW, setNoteW] = React.useState(0);
  const field = React.useRef(null), root = React.useRef(null), mirror = React.useRef(null), shown = React.useRef(null), timer = React.useRef(0), unsaved = React.useRef(null);

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
  // the note's longest line (the placeholder's while it is empty), for the card's width
  React.useLayoutEffect(() => {
    const el = mirror.current;
    if (!el) return;
    el.textContent = note || PLACEHOLDER;
    setNoteW(el.getBoundingClientRect().width);
  }, [note]);
  // how big it is, for main to give its view that size
  React.useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => api.size({ height: el.offsetHeight, width: el.offsetWidth }));
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
  const width = asks.length || running.length ? ASK_W : Math.min(ASK_W, Math.max(MIN_W, Math.ceil(noteW) + NOTE_ROOM));
  return (
    <div ref={root} style={{ padding: 8, width: width + 16 }}>
      <style>{CSS}</style>
      <span ref={mirror} aria-hidden="true" style={{ ...NOTE_LOOK, padding: 0, position: 'absolute', left: -9999, top: 0, visibility: 'hidden', whiteSpace: 'pre' }} />
      <div data-card="1" style={{ width, display: 'flex', flexDirection: 'column', background: CARD_GROUND, paddingBottom: 4 }}>
        <div style={GRIP}>
          <button type="button" data-trash="1" title="Remove box" aria-label="Remove box" onMouseDown={(event) => event.preventDefault()} onClick={() => api.remove()} style={TRASH}>{TRASH_SVG}</button>
        </div>
        <Note value={note} onChange={change} onKeyDown={key} fieldRef={field} />
        {/* the note is first: every answer comes with room above it */}
        {asks.map((ask, i) => <Answer key={ask.id || `ask-${i}`} ask={ask} note={note} divided />)}
        {running.map((run) => <Running key={run.askId} run={run} note={note} divided />)}
      </div>
    </div>
  );
}

export { answerHtml }; // for test/math.test.cjs

createRoot(document.getElementById('root')).render(<BoxCard />);
