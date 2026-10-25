import React from 'react';
import { createRoot } from 'react-dom/client';
import '../tokens/typography.css';
import '@fontsource/caveat/500.css';
import 'katex/dist/katex.min.css';
import '../wave.css'; // .eb-wave, the document's text at work (this page has no styles.css)
import { inlineHtml, noteInkHtml, agentInkHtml, agentTokens } from '../model/doc.js';
import { citationNumbers, citationSources, citationSourcesHtml, openCitationRun, CITE_CSS } from '../model/cite.js';
import { noteQuestion, askedByNote, runningLabel } from '../pdf/canvas.js';
import { NOTE_INK, NOTE_TYPE, ANSWER_FONT, ANSWER_INK, QUESTION_INK, ERROR_INK, ANSWER_GAP, CARD_GROUND, cardCss, styleOf } from '../pdf/card-look.js';
import { WAVE_SPAN, keepWaves } from '../ui/wave.js';
import { SEL_CARD_W, SEL_CARD_H, CARD_SHADE, ICON_SHADE } from '../../shared/selection-card.cjs';
import { SEND_ARROW, SEND_HOVER_CSS, sendLook, sendReady } from '../ui/send-button.js';
import { CHAT_SVG, CHAT_TIP, CHAT_ICON_CSS, chatIconLook } from '../ui/chat-icon.js';

// The card beside a selected box on a web page (MATH-70 build 2, 2026-10-07): its own small view, one per window, which
// main places beside the box and moves with it (src/main/browser/views.cjs `card`). The one component Hudson will replace:
// everything it needs comes through window.boxCardAPI (src/main/browser/box-card-preload.cjs). It looks as the pdf's card
// does (2026-10-17, David: "exactly like the annotation card on PDFs"), from the same values (src/renderer/pdf/card-look.js,
// imported, never copied): the Caveat note, the answers' type and inks, room rather than a rule between the note and each
// answer, the buttons and the answer's paragraphs. What Bart is doing while he answers waves as the document's text at
// work does (2026-10-17, David: no spinner; ../ui/wave.js, ../wave.css). The pdf's card has no box of its own, only handwriting on
// the paper's white; over a web page this one is given that white (CARD_GROUND) and no edge, corners or shadow. ASK_W wide,
// with the trash.
// The note is saved on the box's mark as it is typed; Enter (or the round send under it, the workspace's: ../ui/
// send-button.js, 2026-10-24) sends it: a note that starts with @bart asks, and the answer comes in under it; any other is
// kept as it is and the field let go. Shift+Enter is a new line. Every agent's token in it is tinted as the workspace
// tints it (model/doc.js noteInkHtml). Keys typed here are the card's: Backspace never removes the box.
// A selection's card (2026-10-18, David: "the annotation card should appear by itself just under the selection, ready to
// type into"), and a highlight's own: this view too, mode 'selection', drawn by SelectionCard below in its own look (David's
// picture, 2026-10-18). Its field is the document's focused element from the start, and while the page keeps the keyboard
// (⌘C there copies the selection) a caret is drawn where typing goes; a key typed in the page comes here (`typed`).
// Since 2026-10-24 (David) a selection first shows only the chat icon at its end (`icon` in main's state, ChatIcon below):
// the card opens when it is clicked (api.open), focused.

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
*{box-sizing:border-box}
html,body,#root{margin:0;background:transparent;color:${ANSWER_INK};${ANSWER_FONT};overflow:hidden}
${cardCss('[data-card]')}
${SEND_HOVER_CSS}
${CHAT_ICON_CSS}
[data-card] [data-trash]:hover{background:#f2f2f2;color:#171717}
[data-card] textarea::placeholder{color:#b5b5b5}
`;

const TRASH_SVG = (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" /></svg>
);

// An answer as the pdf's box draws it: a paragraph a line, bold, italic, code and links, a list's or a heading's mark
// taken off should one come anyway (PaperView answerParas).
// Chat's citations are its circles (../model/cite.js), numbered over the whole answer, each its card as its tooltip.
function answerParas(text) {
  const cites = citationNumbers(String(text || '')), opts = cites.size ? { cites, citeFocus: true, citeTitle: true } : undefined;
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const item = line.match(/^[-*] (.*)$/), head = line.match(/^#{1,6} (.*)$/);
    return item ? `• ${inlineHtml(item[1], opts)}` : head ? `<strong>${inlineHtml(head[1], opts)}</strong>` : inlineHtml(line, opts);
  });
}
// and its sources under it (../model/cite.js citationSources)
const answerHtml = (text) => {
  const sources = citationSources(String(text || ''));
  return answerParas(text).map((inside) => `<p>${inside}</p>`).join('') + (sources.length ? `<div data-cite-sources="1" style="margin-top:8px;padding-top:8px;border-top:1px solid #eaeaea;font:12px/1.5 var(--font-sans)">${citationSourcesHtml(sources)}</div>` : '');
};
// a link in an answer never takes the card's page anywhere (main refuses it too)
const noFollow = (event) => { if (openCitationRun(event.target) || (event.target.closest && event.target.closest('a[href]'))) event.preventDefault(); };

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

/** The round send (../ui/send-button.js): ready once there is something to send; a press keeps the field's keyboard. */
function SendButton({ ready, onSend, size }) {
  return <button type="button" className="bart-send" data-send="1" aria-label="Send" disabled={!ready} onMouseDown={(event) => event.preventDefault()} onClick={() => { if (ready) onSend(); }} style={styleOf(sendLook(ready, size))} dangerouslySetInnerHTML={{ __html: SEND_ARROW }} />;
}

/** The note: a field in the note's ink, each agent's token drawn as the document's blue label under its transparent text.
 *  Its height follows its lines, and how many lines it has is its text at its width: so it is fitted again when either
 *  changes (`width`, the card's; `refit`, a font loaded). The card's width follows the note too, and is set after this
 *  field has been fitted to the text (BoxCard measures it in its own layout effect, which runs after this one): fitted on
 *  the text alone, a keystroke that widened the card left the field as tall as it was at the narrower width, where its
 *  last word had wrapped, a line too tall until the next keystroke (2026-10-17). Both passes come before the card is
 *  painted, so it is never seen at the wrong height. */
function Note({ value, onChange, onKeyDown, fieldRef, width, refit }) {
  const inked = agentTokens(value).length > 0;
  React.useLayoutEffect(() => fitField(fieldRef.current), [value, width, refit, fieldRef]);
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

/**
 * What Enter or the send does with a box's note `text`: null, nothing (no text, or @bart and no question yet); { ask },
 * the question a leading @bart asks; else { ask: null }, the note kept as typed.
 */
function sendBox(text) {
  if (!sendReady(text)) return null;
  const question = noteQuestion(text);
  if (question == null) return { ask: null };
  return question ? { ask: question } : null;
}

/** A box's card: its note saved as it is typed, Enter in an @bart note asks; `msg`, what main last said. */
function BoxCard({ msg }) {
  const [state, setState] = React.useState(null); // { mark: { id, note, asks }, running }
  const [note, setNote] = React.useState('');
  const [noteW, setNoteW] = React.useState(0);
  const [fonts, setFonts] = React.useState(0); // a font loaded: the note measured again (Caveat may come after the first draw)
  const field = React.useRef(null), mirror = React.useRef(null), shown = React.useRef(null), timer = React.useRef(0), unsaved = React.useRef(null);
  const [take, setTake] = React.useState(0); // a turn to take the field (a note begun by a key in the page)

  const flush = React.useCallback(() => {
    clearTimeout(timer.current);
    timer.current = 0;
    if (unsaved.current != null) { api.note(unsaved.current); unsaved.current = null; }
  }, []);
  React.useEffect(() => {
    const next = msg;
    if (!next || !next.mark) return;
    if (document.activeElement === field.current && !document.hasFocus()) field.current.blur();
    // another box: its note, whatever was typed for the last one saved first; the same box: the kept note, unless
    // this one is being typed in
    if (shown.current !== next.mark.id) { flush(); shown.current = next.mark.id; setNote(next.mark.note || ''); }
    else if (document.activeElement !== field.current && unsaved.current == null) setNote(next.mark.note || '');
    setState(next);
    if (next.typed) setTake((n) => n + 1);
  }, [msg, flush]);
  React.useEffect(() => () => flush(), [flush]);
  React.useEffect(() => {
    const off = () => flush();
    window.addEventListener('blur', off);
    return () => window.removeEventListener('blur', off);
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

  const change = (value) => {
    setNote(value);
    unsaved.current = value;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, NOTE_SAVE_MS);
  };
  // Enter or the send: an @bart note asks; any other is kept as typed and the field let go (sendBox)
  const send = () => {
    const text = field.current ? field.current.value : note;
    const out = sendBox(text);
    if (!out) return;
    flush();
    if (out.ask) api.ask(out.ask); else if (field.current) field.current.blur();
  };
  const key = (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  const asks = state && state.mark ? state.mark.asks || [] : [];
  const running = state && Array.isArray(state.running) ? state.running : [];
  const width = noteWidth(noteW, asks.length > 0 || running.length > 0);
  return (
    <div style={{ padding: 8, width: width + 16 }}>
      <span ref={mirror} aria-hidden="true" style={{ ...NOTE_LOOK, padding: 0, position: 'absolute', left: -9999, top: 0, visibility: 'hidden', whiteSpace: 'pre' }} />
      <div data-card="1" style={{ width, display: 'flex', flexDirection: 'column', background: CARD_GROUND, paddingBottom: 4 }}>
        <div style={GRIP}>
          <button type="button" data-trash="1" title="Remove box" aria-label="Remove box" onMouseDown={(event) => event.preventDefault()} onClick={() => api.remove()} style={TRASH}>{TRASH_SVG}</button>
        </div>
        <Note value={note} onChange={change} onKeyDown={key} fieldRef={field} width={width} refit={fonts} />
        <div style={{ flex: 'none', display: 'flex', justifyContent: 'flex-end', padding: '0 2px 4px' }}><SendButton ready={sendReady(note)} onSend={send} /></div>
        {/* the note is first: every answer comes with room above it */}
        {asks.map((ask, i) => <Answer key={ask.id || `ask-${i}`} ask={ask} note={note} divided />)}
        {running.map((run) => <Running key={run.askId} run={run} note={note} divided />)}
      </div>
    </div>
  );
}

// A selection's or a highlight's card on a web page (2026-10-18, David's picture): a plain white card with rounded corners,
// a hairline edge and a soft shadow, SEL_CARD_W wide, in the view's CARD_SHADE of room for the shadow. The note is typed in
// the app's sans, not the pdf's Caveat, every agent's token tinted as the workspace tints it (2026-10-24, model/doc.js
// agentInkHtml, under the field's transparent text); under it, Cancel and the workspace's round send (../ui/
// send-button.js). Nothing is kept until it is sent (Enter, ⌘Enter or the send; Shift+Enter is a new line): then the note
// is the highlight's, and the card closes, unless the note starts with @bart: that is asked, and the answer comes in under
// it in the answers' type while Bart's work waves. Cancel or Esc closes the card unsaved (a new selection leaves no
// highlight). A highlight's own card (its text or its symbol clicked, or a selection inside it) has its note in the field
// and Remove at the bottom left; Enter in it emptied clears its note (canSave), the send being for text to send.
// Smaller since 2026-10-24 later (David): SEL_CARD_W 260, its note 14px, and Cancel and a 26px send on the note's own row
// while the note is one line (empty, its placeholder) and the card has no answers and no Remove; once it wraps, they go to
// a row of their own under it, on the right (selInline). The placeholder is shorter than a box's to fit beside them.
const SEL_INK = '#1f2633';
const SEL_PAD = { top: 10, side: 12, bottom: 8 };
const SEL_SEND = 26;
const SEL_GAP = 8; // px between the note and its buttons on one row
const SEL_PLACEHOLDER = 'Note or ask @bart';
const SEL_FIELD = { display: 'block', width: '100%', margin: 0, padding: 0, border: 0, background: 'transparent', resize: 'none', overflow: 'hidden', outline: 'none', font: '14px/1.45 var(--font-sans)', color: SEL_INK };
const SEL_CSS = `
@keyframes sel-caret{50%{opacity:0}}
[data-sel-card] textarea::placeholder{color:#9a9a9a;opacity:1}
[data-sel-card] [data-sel-cancel],[data-sel-card] [data-sel-remove]{border:0;background:transparent;padding:5px 6px;border-radius:999px;font:13px/1.2 var(--font-sans);color:#6b6b6b;cursor:pointer}
[data-sel-card] [data-sel-remove]{color:#8f8f8f;margin-left:-6px}
[data-sel-card] [data-sel-cancel]:hover,[data-sel-card] [data-sel-remove]:hover{background:#f2f2f2;color:#171717}
${cardCss('[data-sel-answers]')}
`;

/** Whether the note can be sent (kept): a note to keep, or (a highlight's) one to clear. */
function canSave(note, saved, kept) {
  return String(note || '').trim() !== '' || (!!kept && String(saved || '').trim() !== '');
}

let inkMeter = null;
/** The note's width on one line in the field's type (`ta`), px; Infinity once it has a line break. */
function noteInkWidth(text, ta) {
  const s = String(text ?? '');
  if (s.includes('\n')) return Infinity;
  if (inkMeter === null) {
    try { inkMeter = document.createElement('canvas').getContext('2d') || false; } catch { inkMeter = false; }
  }
  if (!inkMeter || !ta || typeof inkMeter.measureText !== 'function') return s.length * 7.5; // no canvas (a test's DOM): about 14px sans
  const cs = getComputedStyle(ta);
  inkMeter.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  return inkMeter.measureText(s).width;
}
/** Whether the note (or, empty, the placeholder) fits on one line beside the buttons `row` (Cancel and the send): the card's
 *  inside less the row and SEL_GAP, and a pixel or two for the caret. Measured as one line at that width, not at the field's
 *  width now, so the card does not swing between its two layouts at a line's end. */
function selInline(note, ta, row) {
  if (!row) return true;
  const room = SEL_CARD_W - 2 * SEL_PAD.side - 2 - row.offsetWidth - SEL_GAP;
  return noteInkWidth(note || SEL_PLACEHOLDER, ta) + 2 <= room;
}

function SelectionCard({ msg }) {
  const [view, setView] = React.useState(null); // { mark, running }
  const [note, setNote] = React.useState('');
  const field = React.useRef(null), offer = React.useRef(null), markId = React.useRef(null), saved = React.useRef(''), typedNote = React.useRef('');
  const [take, setTake] = React.useState(0);
  const [focused, setFocused] = React.useState(() => document.hasFocus());
  const wasIcon = React.useRef(false);
  const set = (value) => { typedNote.current = value; setNote(value); };
  // whether this card has the keyboard: without it, an empty card draws its caret where typing goes
  React.useEffect(() => {
    const on = () => setFocused(true), off = () => setFocused(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
  }, []);
  React.useEffect(() => {
    const next = msg;
    if (!next) return;
    const mark = next.mark || null;
    if (next.offer !== offer.current) {
      // a new card: empty, or the highlight's note
      offer.current = next.offer;
      markId.current = mark ? mark.id : null;
      saved.current = mark ? mark.note || '' : '';
      set(saved.current);
      setTake((n) => n + 1);
    } else if (mark) {
      // the highlight read from its ink (opened, saved, answered): its note, unless something else has been typed since
      const dirty = typedNote.current !== saved.current;
      markId.current = mark.id;
      saved.current = mark.note || '';
      if (!dirty) set(saved.current);
    }
    // a key typed in the page: the note's, and the field has the keyboard
    if (typeof next.typed === 'string') { set(typedNote.current + next.typed); setTake((n) => n + 1); return; }
    // the chat icon clicked: the card, its field with the keyboard
    const icon = next.icon === true;
    if (wasIcon.current && !icon) setTake((n) => n + 1);
    wasIcon.current = icon;
    setView({ mark, running: Array.isArray(next.running) ? next.running : [], icon });
  }, [msg]);
  React.useEffect(() => {
    const el = field.current;
    if (!take || !el) return;
    el.focus({ preventScroll: true });
    const n = el.value.length;
    try { el.setSelectionRange(n, n); } catch { /* not a field that has one */ }
  }, [take]);
  const [inline, setInline] = React.useState(true);
  const buttons = React.useRef(null);
  React.useLayoutEffect(() => fitField(field.current), [note, inline]);

  const kept = !!(view && view.mark);
  const save = () => { if (!canSave(note, saved.current, kept)) return; saved.current = note; api.save(note); };
  const key = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); save(); }
  };
  const asks = kept ? view.mark.asks || [] : [];
  const running = view ? view.running : [];
  const inked = agentTokens(note).length > 0;
  const answered = asks.length > 0 || running.length > 0;
  const icon = !!(view && view.icon);
  // one row while the note is a line and nothing else is in the card; measured after each render, set before it is painted
  React.useLayoutEffect(() => {
    if (icon) return;
    const next = !kept && !answered && selInline(note, field.current, buttons.current);
    if (next !== inline) setInline(next);
  });
  if (icon) return <ChatIcon />;
  const row = (
    <div ref={buttons} data-sel-buttons="1" style={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
      <button type="button" data-sel-cancel="1" onMouseDown={(event) => event.preventDefault()} onClick={() => api.cancel()}>Cancel</button>
      <SendButton ready={sendReady(note)} onSend={save} size={SEL_SEND} />
    </div>
  );
  return (
    <div style={{ padding: `${CARD_SHADE.top}px ${CARD_SHADE.side}px ${CARD_SHADE.bottom}px` }}>
      <div data-sel-card="1" data-sel-inline={inline ? '1' : undefined} style={{ width: SEL_CARD_W, minHeight: SEL_CARD_H, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', justifyContent: 'center', background: CARD_GROUND, borderRadius: 10, border: '1px solid #ececec', boxShadow: '0 4px 16px rgba(0,0,0,.10)', padding: `${SEL_PAD.top}px ${SEL_PAD.side}px ${SEL_PAD.bottom}px` }}>
        <div style={inline ? { display: 'flex', alignItems: 'center', gap: SEL_GAP } : undefined}>
        <div style={{ position: 'relative', flex: inline ? 1 : undefined, minWidth: 0 }}>
          {!focused && !note && <div aria-hidden="true" data-sel-caret="1" style={{ ...SEL_FIELD, position: 'absolute', inset: 0, pointerEvents: 'none', color: 'transparent' }}><span style={{ display: 'inline-block', width: 1.5, height: '1.2em', verticalAlign: 'text-bottom', background: SEL_INK, animation: 'sel-caret 1.06s steps(1) infinite' }} /></div>}
          {inked && <div aria-hidden="true" data-sel-ink="1" style={{ ...SEL_FIELD, position: 'absolute', inset: 0, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden', pointerEvents: 'none' }} dangerouslySetInnerHTML={{ __html: agentInkHtml(note) }} />}
          <textarea ref={field} rows={1} value={note} placeholder={SEL_PLACEHOLDER} spellCheck={false} onChange={(event) => set(event.target.value)} onKeyDown={key} style={inked ? { ...SEL_FIELD, position: 'relative', color: 'transparent', caretColor: SEL_INK } : SEL_FIELD} />
        </div>
        {inline && row}
        </div>
        {answered && (
          <div data-sel-answers="1" style={{ display: 'flex', flexDirection: 'column', margin: '0 -6px' }}>
            {asks.map((ask, i) => <Answer key={ask.id || `ask-${i}`} ask={ask} note={note} divided />)}
            {running.map((run) => <Running key={run.askId} run={run} note={note} divided />)}
          </div>
        )}
        {!inline && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            {kept && <button type="button" data-sel-remove="1" onMouseDown={(event) => event.preventDefault()} onClick={() => api.remove()}>Remove</button>}
            <span style={{ flex: 1 }} />
            {row}
          </div>
        )}
      </div>
    </div>
  );
}

/** The chat icon at a selection's end (../ui/chat-icon.js), in ICON_SHADE of room for its shadow: a click opens the card. */
function ChatIcon() {
  return (
    <div style={{ padding: ICON_SHADE }}>
      <button type="button" data-chat-icon="1" title={CHAT_TIP} aria-label={CHAT_TIP} onMouseDown={(event) => event.preventDefault()} onClick={() => api.open()} style={styleOf(chatIconLook())} dangerouslySetInnerHTML={{ __html: CHAT_SVG }} />
    </div>
  );
}

/** The card's page: main's state to whichever card it is for, and the card's size back for main to size the view. */
function CardPage() {
  const [msg, setMsg] = React.useState(null);
  const root = React.useRef(null);
  React.useEffect(() => {
    const off = api.onState((next) => { if (next) setMsg(next); });
    api.ready();
    return off;
  }, []);
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
  const selection = !!(msg && msg.mode === 'selection');
  return (
    <div ref={root} style={{ display: 'inline-block', verticalAlign: 'top' }}>
      <style>{CSS}{SEL_CSS}{CITE_CSS}</style>
      {selection ? <SelectionCard msg={msg} /> : <BoxCard msg={msg} />}
    </div>
  );
}

export { answerHtml, noteWidth, fitField, canSave, sendBox, Running, SelectionCard, SendButton, ChatIcon, PLACEHOLDER, SEL_PLACEHOLDER, ASK_W, MIN_W, SEL_CSS }; // for test/math.test.cjs and test/box-card.test.cjs

createRoot(document.getElementById('root')).render(<CardPage />);
