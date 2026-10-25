// The chat icon at a selection's end (2026-10-24, David): a small white round button with a speech bubble, a shade darker
// under the pointer, "Ask or add a note" as its tooltip. A click keeps the selection as a highlight and opens its note,
// focused. The pdf's (pdf/PaperView.jsx) and a web page's (box-card/BoxCard.jsx, in the card's own view, so the page is
// never touched) are drawn from here; where it goes is ../../shared/selection-card.cjs chatIconPlace.
import { CHAT_ICON } from '../../shared/selection-card.cjs';

export const CHAT_TIP = 'Ask or add a note';
export const CHAT_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path></svg>';
export const chatIconLook = () => `box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${CHAT_ICON}px;height:${CHAT_ICON}px;padding:0;margin:0;border:1px solid #e5e5e5;border-radius:50%;background:#fff;color:#4d4d4d;box-shadow:0 1px 4px rgba(0,0,0,.12);cursor:pointer;transition:background 120ms,border-color 120ms`;
/** Its hover, for the element marked `data-chat-icon`. */
export const CHAT_ICON_CSS = '[data-chat-icon]:hover{background:#f2f2f2!important;border-color:#d4d4d4!important;color:#171717!important}';
