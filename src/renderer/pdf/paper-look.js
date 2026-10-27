// A pdf annotation's look, the pdf's alone (2026-10-27, David: readable cards and highlights in the Stage). ./card-look.js
// is shared with a web page's card (../box-card/BoxCard.jsx), which this must not change, so what the pdf's card does
// otherwise is set here and read only by ./PaperView.jsx.
//
// A card is a card again: a solid ground, a faint edge and room inside it, so it reads apart from the paper it lies
// beside (it had nothing of its own to see from 2026-10-16). Its note, its placeholder and its answers are in the app's
// own type, not handwriting; @bart stays the document's blue (model/doc.js noteInkHtml). An answer is under a hairline.
// Words wrap between words, and a word breaks only when it is longer than a line (a long URL): `anywhere` broke short
// words in a narrow card.
// A highlight is a flat tint, no longer a scribble (rough.js zigzag): it multiplies with the page (PaperView LAYER_CSS),
// so the printed ink keeps its black. A selection pending its note is a stronger tint than a kept highlight, and the one
// in focus (clicked, or its card pointed at) adds a tint and a line under each of its lines.

import { NOTE_INK } from './card-look.js';

export const PDF_NOTE_TYPE = `padding:0 6px;font:15px/1.5 var(--font-sans);color:${NOTE_INK};-webkit-font-smoothing:antialiased`;
export const PDF_CARD_LOOK = 'background:#fff;border:1px solid #e4e4e4;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:8px 6px 6px';
export const PDF_ANSWER_GAP = 'margin-top:8px;padding-top:8px;border-top:1px solid #ededed';
export const PDF_WRAP = 'overflow-wrap:break-word;word-break:normal';

export const HL_SAVED = 'rgba(0,112,243,.15)';
export const HL_PENDING = 'rgba(0,112,243,.28)';
export const HL_FOCUS = 'rgba(0,112,243,.15)'; // over the kept tint
export const HL_FOCUS_LINE = 'rgba(0,112,243,.7)';
export const HL_RADIUS = 2;

/** The pdf card's own rules after ./card-look.js cardCss: its secondary actions smaller and closer. */
export const pdfCardCss = (card) => `${card} button{font-size:12px;line-height:1.3;padding:1px 5px}`;
