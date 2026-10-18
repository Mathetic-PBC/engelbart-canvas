import React from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens/typography.css';
import '@fontsource/caveat/500.css';
import 'katex/dist/katex.min.css';
import '../wave.css'; // .eb-wave, the document's text at work (this page has no styles.css)
import { inlineHtml, noteInkHtml } from '../model/doc.js';
import { noteQuestion, askedByNote, runningLabel } from '../pdf/canvas.js';
import { NOTE_INK, NOTE_TYPE, ANSWER_FONT, ANSWER_INK, QUESTION_INK, ERROR_INK, ANSWER_GAP, CARD_GROUND, cardCss, styleOf } from '../pdf/card-look.js';
import { WAVE_SPAN, keepWaves } from '../ui/wave.js';

// The card beside a selected box on a web page (MATH-70 build 2, 2026-10-07): its own small view, one per window, which
// main places beside the box and moves with it (src/main/browser/views.cjs `card`). The one component Hudson will replace:
// everything it needs comes through window.boxCardAPI (src/main/browser/box-card-preload.cjs). It looks as the pdf's card
// does (2026-10-17, David: "exactly like the annotation card on PDFs"), from the same values (src/renderer/pdf/card-look.js,
// imported, never copied): the Caveat note, the answers' type and inks, room rather than a rule between the note and each
// answer, the buttons and the answer's paragraphs. What Bart is doing while he answers waves as the document's text at
// work does (2026-10-17, David: no spinner; ../ui/wave.js, ../wave.css). The pdf's card has no box of its own, only handwriting on
// the paper's white; over a web page this one is given that white (CARD_GROUND) and no edge, corners or shadow. ASK_W wide,
// with the trash.
// The note is saved on the box's mark as it is typed; Enter in a note that starts with @bart asks (Shift+Enter is a new
// line), and the answer comes in under it. Keys typed here are the card's: Backspace never removes the box.
// A selection's card (2026-10-18, David: "the annotation card should appear by itself just under the selection, ready to
// type into"): main shows this card, mode 'selection', under a web page's selection, empty and with no mark. Its field
// is the document's focused element from the start, and while the page keeps the keyboard (⌘C there copies the
// selection) a caret is drawn where typing goes. The first key, typed in the page (main begins the note and gives this
// card the keyboard) or here, keeps the highlight with it (api.keep); Enter in it empty keeps the highlight alone. Such a
// card has no trash: a highlight is not a box.

const api = window.boxCardAPI;

const NOTE_LOOK = styleOf(NOTE_TYPE);
const ANSWER_LOOK = { ...styleOf(ANSWER_FONT), color: ANSWER_INK };
const ASK_W = 320;
// A card with no answers is only as wide as its note (David, 2026-10-07: "make the text box smaller"), from MIN_W to ASK_W:
// its longest line, measured in the note's ink, and the field's padding and edge.
const MIN_W = 140;
const NOTE_ROOM = 12 + 2 + 6;
const PLACEHOLDER = 'Write a note or ask @bart'; // one line: the card is as wide as it (MIN_W..ASK_W), see noteWidth
const GRIP = { height: 12, position: 'relative' }; // the trash's row (the pdf's card has no grip bar since 2026-10-16)
const TRASH = { position: 'absolute', top: 1, right: 3, width: 18, height: 18, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 0, background: 'rgba(255,255,255,.97)', color: '#8f8f8f', cursor: 'pointer' };
const GAP = styleOf(ANSWER_GAP); // between the note and an answer, and between two answers
const WAVE = styleOf(WAVE_SPAN);
const ANSWER_MAX = 320; // an answer scrolls inside past this many pixels

const CSS = `
@keyframes sel-caret{50%{opacity:0}}
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

/** The card's width: ASK_W once it has answers or one is coming, else as wide as the note's longest line `noteW` (its
 *  ink, measured) and the field's room, from MIN_W to ASK_W. */
function noteWidth(noteW, answered) {
  return answered ? ASK_W : Math.min(ASK_W, Math.max(MIN_W, Math.ceil(Number(noteW) || 0) + NOTE_ROOM));
}

/** The field as tall as its lines at the width it has now: its height let go first, so what it had cannot hold it up. */
function fitField(ta) {
  if (!ta) return;
  ta.style.height = '0px';
  ta.style.height = `${ta.scrollHeight}px`;
}

/** The note: a field in the note's ink, a leading @bart drawn as the document's blue label under its transparent text.
 *  Its height follows its lines, and how many lines it has is its text at its width: so it is fitted again when either
 *  changes (`width`, the card's; `refit`, a font loaded). The card's width follows the note too, and is set after this
 *  field has been fitted to the text (BoxCard measures it in its own layout effect, which runs after this one): fitted on
 *  the text alone, a keystroke that widened the card left the field as tall as it was at the narrower width, where its
 *  last word had wrapped, a line too tall until the next keystroke (2026-10-17). Both passes come before the card is
 *  painted, so it is never seen at the wrong height. */
function Note({ value, onChange, onKeyDown, fieldRef, width, refit, caret }) {
  const inked = noteQuestion(value) != null;
  React.useLayoutEffect(() => fitField(fieldRef.current), [value, width, refit, fieldRef]);
  const field = { ...NOTE_LOOK, display: 'block', width: '100%', margin: 0, border: 0, background: 'transparent', resize: 'none', overflow: 'hidden', outline: 'none', ...(inked ? { position: 'relative', color: 'transparent', caretColor: NOTE_INK } : {}) };
  return (
    <div style={{ flex: 'none', paddingBottom: 4, position: 'relative' }}>
      {inked && <div aria-hidden="true" style={{ ...NOTE_LOOK, position: 'absolute', inset: 0, margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', pointerEvents: 'none' }} dangerouslySetInnerHTML={{ __html: noteInkHtml(value) }} />}
      {caret && <div aria-hidden="true" data-sel-caret="1" style={{ ...NOTE_LOOK, position: 'absolute', inset: 0, margin: 0, color: 'transparent', pointerEvents: 'none', zIndex: 1 }}><span style={{ display: 'inline-block', width: 1.5, height: '1.1em', verticalAlign: 'text-bottom', background: NOTE_INK, animation: 'sel-caret 1.06s steps(1) infinite' }} /></div>}
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

/** An answer being written: what Bart is doing, in the wave, and Stop, then the answer as it comes; a failure says why, with ×. */
function Running({ run, note, divided }) {
  const failed = run.error != null;
  const lines = !failed && run.activity === 'Writing' && Array.isArray(run.lines) ? run.lines : [];
  const asked = askedByNote(run.question, note) ? '' : String(run.question || '');
  return (
    <div data-ask-run={run.askId} style={{ ...(divided ? GAP : {}), flex: 'none', display: 'flex', flexDirection: 'column', ...ANSWER_LOOK }}>
      <div style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 0 4px 6px' }}>
        {failed ? <span style={{ flex: 1, minWidth: 0, fontWeight: 500, color: ANSWER_INK }}>Bart · No answer</span>
          : <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}><span className="eb-wave" style={WAVE}>{runningLabel(run)}</span></span>}
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
  const [fonts, setFonts] = React.useState(0); // a font loaded: the note measured again (Caveat may come after the first draw)
  const field = React.useRef(null), root = React.useRef(null), mirror = React.useRef(null), shown = React.useRef(null), timer = React.useRef(0), unsaved = React.useRef(null);
  // a selection's card: the offer its note was begun for here (api.keep sent, its mark not come yet), and a turn to take
  // the field again (a new offer, or a note begun by a key in the page)
  const kept = React.useRef(null);
  const [take, setTake] = React.useState(0);
  const [focused, setFocused] = React.useState(() => document.hasFocus());

  const flush = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = 0;
    if (unsaved.current != null) { api.note(unsaved.current); unsaved.current = null; }
  }, []);
  React.useEffect(() => {
    const off = api.onState((next) => {
      if (!next) return;
      const selection = next.mode === 'selection';
      // a selection offered: an empty card, the field ready for the keyboard
      if (selection && !next.mark) { flush(); shown.current = null; kept.current = null; setNote(''); setState(next); setTake((n) => n + 1); return; }
      if (!next.mark) return;
      // its note begun here: the mark is the one being typed in, and what was typed since goes on to it as ever
      if (selection && kept.current && kept.current === next.offer && shown.current == null) { shown.current = next.mark.id; kept.current = null; setState(next); return; }
      if (!selection && document.activeElement === field.current && !document.hasFocus()) field.current.blur();
      // another box: its note, whatever was typed for the last one saved first; the same box: the kept note, unless
      // this one is being typed in
      if (shown.current !== next.mark.id) { flush(); shown.current = next.mark.id; setNote(next.mark.note || ''); }
      else if (document.activeElement !== field.current && unsaved.current == null) setNote(next.mark.note || '');
      setState(next);
      if (next.typed) setTake((n) => n + 1);
    });
    api.ready();
    return () => { off(); flush(); };
  }, [flush]);
  // whether this card has the keyboard: a selection's card without it draws its caret
  React.useEffect(() => {
    const on = () => setFocused(true), off = () => { setFocused(false); flush(); };
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
  }, [flush]);
  // the field taken, its caret after what it has
  React.useEffect(() => {
    const el = field.current;
    if (!take || !el) return;
    el.focus({ preventScroll: true });
    const n = el.value.length;
    try { el.setSelectionRange(n, n); } catch { /* not a field that has one */ }
  }, [take]);
  React.useEffect(() => {
    const set = document.fonts;
    if (!set || typeof set.addEventListener !== 'function') return undefined;
    const again = () => setFonts((n) => n + 1);
    set.addEventListener('loadingdone', again);
    return () => set.removeEventListener('loadingdone', again);
  }, []);
  // the note's longest line (the placeholder's while it is empty), for the card's width; the field is fitted again at it
  React.useLayoutEffect(() => {
    const el = mirror.current;
    if (!el) return;
    el.textContent = note || PLACEHOLDER;
    setNoteW(el.getBoundingClientRect().width);
  }, [note, fonts]);
  // what Bart is doing waves on the page's clock, so a row drawn again goes on where it was (as the document's do)
  React.useLayoutEffect(() => keepWaves(root.current));
  // how big it is, for main to give its view that size
  React.useEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver !== 'function') return undefined;
    const observer = new ResizeObserver(() => api.size({ height: el.offsetHeight, width: el.offsetWidth }));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selecting = !!(state && state.mode === 'selection');
  const change = (value) => {
    // a selection's card: its first key keeps the highlight, with the note begun
    if (selecting && !shown.current) {
      setNote(value);
      if (!kept.current && value) { kept.current = state.offer; api.keep(value); }
      return;
    }
    setNote(value);
    unsaved.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, NOTE_SAVE_MS);
  };
  const key = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    // Enter in a selection's card with nothing in it: the highlight alone
    if (selecting && !shown.current && !kept.current && !event.currentTarget.value) { event.preventDefault(); kept.current = state.offer; api.keep(''); return; }
    const question = noteQuestion(event.currentTarget.value);
    if (question == null) return;
    event.preventDefault();
    if (!question) return;
    flush();
    api.ask(question);
  };

  const asks = state && state.mark ? state.mark.asks || [] : [];
  const running = state && Array.isArray(state.running) ? state.running : [];
  const width = noteWidth(noteW, asks.length > 0 || running.length > 0);
  return (
    <div ref={root} style={{ padding: 8, width: width + 16 }}>
      <style>{CSS}</style>
      <span ref={mirror} aria-hidden="true" style={{ ...NOTE_LOOK, padding: 0, position: 'absolute', left: -9999, top: 0, visibility: 'hidden', whiteSpace: 'pre' }} />
      <div data-card="1" style={{ width, display: 'flex', flexDirection: 'column', background: CARD_GROUND, paddingBottom: 4 }}>
        <div style={GRIP}>
          {!selecting && <button type="button" data-trash="1" title="Remove box" aria-label="Remove box" onMouseDown={(event) => event.preventDefault()} onClick={() => api.remove()} style={TRASH}>{TRASH_SVG}</button>}
        </div>
        <Note value={note} onChange={change} onKeyDown={key} fieldRef={field} width={width} refit={fonts} caret={selecting && !focused && !note} />
        {/* the note is first: every answer comes with room above it */}
        {asks.map((ask, i) => <Answer key={ask.id || `ask-${i}`} ask={ask} note={note} divided />)}
        {running.map((run) => <Running key={run.askId} run={run} note={note} divided />)}
      </div>
    </div>
  );
}

export { answerHtml, noteWidth, fitField, Running, PLACEHOLDER, ASK_W, MIN_W }; // for test/math.test.cjs and test/box-card.test.cjs

createRoot(document.getElementById('root')).render(<BoxCard />);
