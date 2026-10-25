// The chat icon at the end of a selection (2026-10-24, David): a web page's (box-card/BoxCard.jsx ChatIcon) and a pdf's
// (pdf/PaperView.jsx openSelIcon) are drawn from here, never a copy. A round of white with a hairline edge and a soft
// shadow, so it shows on a light page and a dark one alike (2026-10-24 later, David: smaller, a thinner bubble, fading in);
// under the pointer a little darker, the bubble the app's blue (the send's, ./send-button.js), and its tooltip.
import { CHAT_ICON } from '../../shared/selection-card.cjs';
import { SEND_BLUE } from './send-button.js';

export const CHAT_TIP = 'Ask or add a note';
export const CHAT_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path></svg>';
// Its shadow reaches ICON_SHADE (../../shared/selection-card.cjs) at most, the room a web page's icon view has about it.
export const ICON_SHADOW = '0 1px 2px rgba(0,0,0,.06),0 1px 5px rgba(0,0,0,.07)';
export const CHAT_FADE_MS = 120;
export const chatIconLook = () => `box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${CHAT_ICON}px;height:${CHAT_ICON}px;padding:0;margin:0;border:.5px solid rgba(0,0,0,.14);border-radius:50%;background:#fff;color:#5c5c5c;box-shadow:${ICON_SHADOW};cursor:pointer;animation:chat-icon-in ${CHAT_FADE_MS}ms ease-out;transition:background 120ms,color 120ms,border-color 120ms`;
export const CHAT_ICON_CSS = `@keyframes chat-icon-in{from{opacity:0}to{opacity:1}}[data-chat-icon]:hover{background:#f3f3f3!important;border-color:rgba(0,0,0,.2)!important;color:${SEND_BLUE}!important}`;
