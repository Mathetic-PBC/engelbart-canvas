// The round send (2026-10-24, David: the Stage's highlight cards send as the workspace does): the workspace's ask and
// follow-up fields' button (workspace/DocEditor.jsx fieldBox), 28px, its arrow 14px, blue with a white arrow once there is
// something to send and grey before, a little lighter under the pointer. DocEditor, a web page's cards
// (box-card/BoxCard.jsx) and the pdf's highlight cards (pdf/PaperView.jsx) all draw it from here, never a copy.

export const SEND_PATHS = '<path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path>';
export const SEND_SIZE = 28;
/** The app's blue: the send's when it can be pressed (the chat icon's glyph under the pointer is it too, ./chat-icon.js). */
export const SEND_BLUE = '#0070f3';
export const SEND_ARROW = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SEND_PATHS}</svg>`;

/** Whether there is something to send: any text but spaces. */
export const sendReady = (text) => String(text ?? '').trim() !== '';
/** Its colors, ready or not. */
export const boxSend = (ready) => `background:${ready ? SEND_BLUE : '#ececec'};color:${ready ? '#fff' : '#a3a3a3'}`;
/** The button's whole look, ready or not (not ready, it is disabled and takes no click), `size` px round (a web page's
 *  selection card's is 26, box-card/BoxCard.jsx SEL_SEND). */
export const sendLook = (ready, size = SEND_SIZE) => `flex:none;display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;padding:0;border:0;border-radius:50%;${boxSend(ready)};cursor:${ready ? 'pointer' : 'default'};transition:background 160ms`;
/** Under the pointer (.bart-send): a little lighter, when it can be pressed. */
export const SEND_HOVER_CSS = '.bart-send{transition:background 120ms}.bart-send:hover:not(:disabled){opacity:.86}';
