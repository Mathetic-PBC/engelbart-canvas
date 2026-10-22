// An annotation card's look, the one place it is set (2026-10-17, David: "make the annotation card on web pages look
// exactly like the annotation card on PDFs"). The pdf's card (./PaperView.jsx cardBox) and a web box's card
// (../box-card/BoxCard.jsx, its own view over the page) both read these, so the two cannot drift apart.
//
// A note's handwriting: Caveat (MATH-15, 2026-10-06), 24px since 2026-10-08 (Hudson: "the font of annotations should be
// larger"; its x-height is small, 0.36 em), a little tracking keeps its letters apart, and the ink is a touch softer than
// black. Line height 1.2 (notes are short). An answer, and one being written: 15px sans (13px until 2026-10-08).
// A pdf's card is laid out at these sizes and drawn at its page's noteScale (./canvas.js); a web box's card at them.

export const NOTE_INK = '#1f2633';
export const NOTE_TYPE = `padding:0 6px;font:500 24px/1.2 'Caveat',cursive;letter-spacing:.2px;color:${NOTE_INK};-webkit-font-smoothing:antialiased`;
export const ANSWER_FONT = 'font:15px/1.55 var(--font-sans)';
export const ANSWER_INK = '#171717';
export const QUESTION_INK = '#8f8f8f'; // an earlier question over its answer, and an answer still being written
export const LABEL_INK = '#4d4d4d'; // what Bart is doing, beside the spinner
export const ERROR_INK = '#c4372d';
export const ANSWER_GAP = 'margin-top:10px'; // space, not a rule, between the note and an answer, and between two answers
export const SPINNER = 'flex:none;width:10px;height:10px;box-sizing:border-box;border:1.5px solid #c9d9f2;border-top-color:#0070f3;border-radius:50%;animation:card-spin .8s linear infinite';
// What a card is seen on. A pdf's card has no ground, edge, corners or shadow of its own since 2026-10-16 (Hudson: "Get
// rid of the ugly box around the annotations"): it is handwriting on the paper's pane, which is this white. A web box's
// card lies over the page in a view of its own, so it is given this ground and nothing else.
export const CARD_GROUND = '#fff';

/** The rules a card's insides need, under `card` (a selector for the card): its buttons, an answer's paragraphs and links. */
export const cardCss = (card) => `${card} button{border:0;background:transparent;padding:2px 6px;border-radius:5px;font:13px/1.4 var(--font-sans);color:#8f8f8f;cursor:pointer;white-space:nowrap}
${card} button:hover{background:#f2f2f2;color:#171717}
${card} [data-ask-body],${card} [data-run-body]{user-select:text;cursor:text}
${card} [data-ask-body] p,${card} [data-run-body] p{margin:0 0 6px}
${card} a{color:#0070f3;text-decoration:underline;text-underline-offset:2px}
@keyframes card-spin{to{transform:rotate(360deg)}}`;

/** A declaration list ('padding:0 6px;font:…') as React's style object ({ padding: '0 6px', font: '…' }). */
export function styleOf(css) {
  const out = {};
  for (const part of String(css).split(';')) {
    const at = part.indexOf(':');
    if (at < 0) continue;
    const name = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
    if (!name) continue;
    out[name.replace(/^-(webkit|moz|ms)-/, (_, v) => `${v[0].toUpperCase()}${v.slice(1)}-`).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}
