'use strict';
const { isGithubSignIn, endedGithubSession, GITHUB_SESSION_COOKIES } = require('../../shared/github.cjs');
const { isPreviewAddress } = require('../../shared/address-key.cjs');
const PAGE = require('./page-preload.cjs');
const BOX = require('./boxes.cjs');
const LAYER = require('./box-layer-preload.cjs');
const CARD = require('./box-card-preload.cjs');
const SEL = require('../../shared/selection-card.cjs');
const { assertTrustedRenderer } = require('../ipc-validation.cjs');
const OVERLEAF = require('../overleaf/editor.cjs');

// The Browser pane's pages (decision 48). Each browser tab is a WebContentsView: a native view
// with its own top-level webContents, laid over a placeholder the renderer measures. A page is
// therefore never framed, so X-Frame-Options and CSP frame-ancestors do not apply to it, and
// web security stays on. Pages live in their own persistent session, apart from the app's. Electron
// is passed in so the rules below can be tested without it.
//
// Signing in (decision 49): a page that opens a window keeps its opener, because OAuth and 2FA
// flows finish by talking back to it (postMessage, then window.close()). A popup (window.open
// with features) is a real child window, as in Chrome; any other new window is a tab whose view
// is built around the webContents Chromium already made. HTTP authentication asks the person.
// So do camera, microphone, location, notifications and reading the clipboard (once per site per
// run), and a link into another app (slack://, vscode://): sign-ins to desktop apps end on one.
//
// Pages on disk (decision 51): a file: address opens when the file is inside the home directory,
// the same line the text viewer draws. The person can type one and a page on disk can link to
// another; a page from the web can do neither.
//
// Pdfs (2026-09-22): a tab never shows Chromium's pdf viewer. A page that answers with a pdf is
// turned into a download, a download that is a pdf (by its type, its file name, or an address
// ending .pdf: a site serving one as octet-stream) is saved to a temporary file, and its bytes go
// to the renderer, which draws them with the Paper pane's viewer. A pdf on disk is read directly.
// The page under it stays where it was, so Back leaves the pdf.
//
// Highlights on web pages (MATH-54 build 2, 2026-10-06): one preload (page-preload.cjs) is registered on the browsing
// session, so every page in it has it, a tab a page opened (adopt) and a popup as much as a typed tab; it stays sandboxed
// and isolated and gives the page nothing. It tints the page's web highlights with CSS.highlights, which main styles with
// insertCSS (MARK_CSS). It talks to main only over its tab's own `webContents.ipc`, and main answers only a tab it knows
// (tabOf), from its main frame, in the shapes below and no longer than their limits; a popup is no tab and gets nothing.
// The right-click menu's Highlight, with a selection, asks the preload for the selection's quote and saves it through
// `pageMarks` (index.cjs: the library's ink for the page, store/library.cjs addWebMark), then has it tinted. A sandbox
// preview or a local server (isPreviewAddress) is never filed, so it offers no Highlight and gets no marks.
//
// What @bart sees of the page in front (MATH-54 build 3a, 2026-10-06): its selection as it is now (pageSelection: the
// preload's quote and the page's text around it, answered within SELECTION_TIMEOUT_MS or not at all, kept nowhere) and
// what it looks like (screenshot: capturePage as a PNG, its longer edge at most SHOT_MAX_EDGE). A preview's selection is
// read too: nothing of it is filed.
//
// Boxes (MATH-70 build 1, 2026-10-07; ./boxes.cjs): the Stage's Box button, or ⌥ held while the page has the keyboard and
// no text field of its own does, lays a transparent drawing layer over the tab (box-layer-preload.cjs) until a box is
// drawn, Esc is pressed or ⌥ let go: a native view cannot let clicks through to the page below, so it is there only
// while drawing. A box drawn is given to the page's preload, which says what it is kept by (its anchor) and what text is
// under it; its picture is captured from the page (capturePage of its rectangle) and the mark saved with it through
// `pageMarks`. The page reports where its boxes are, and main draws them with one inserted rule (boxesCss), replaced as
// they move. A click on a box's edge selects it (the preload's), and Backspace or Delete removes it; the Stage shows
// "Box removed · Undo" (browser:box-removed), and Undo or ⌘Z in the page puts it back, picture and all.
//
// MATH-70 build 2 (2026-10-07): a box is selected by its edge alone, and one just drawn is selected. Its handles resize it
// (the page's): the page reports the new rectangle as it is dragged, and on release says what it is kept by now
// (boxResize); main draws the page's boxes without that one, waits for the page to paint, takes the new picture under a
// new name (boxes.cjs nextCropName; the old one is kept for the answers about it) and updates the mark (`pageMarks.update`,
// store/library.cjs updateWebMark). A rule inserted while the pointer is over a handle gives it the handle's cursor.
// MATH-70 build 3 (2026-10-07): a box being resized is drawn as the drawing layer draws one (a flat fill, its size beside
// the pointer: boxes.cjs readoutCss, in the same rule), and the pointer is a hand over any box's edge.
// The selected box has a card beside it: one small view per window (`card`, like `layer`; box-card-preload.cjs, the
// renderer's box-card/BoxCard.jsx), shown while a box is selected on the tab in front and in view, to the box's right when
// there is room, else its left (boxes.cjs cardPlace), following it as the page scrolls; gone on navigating, another tab,
// hide or close. Its note is saved on the mark; @bart from it goes to the window's renderer (browser:box-ask), which asks
// as for any highlight, and Stop too (browser:box-stop); the Stage gives back what it has running (setBoxAsks) for the
// card to show. Keys typed in the card are the card's: Backspace there never removes the box.
// Overleaf (MATH-65, Overleaf part 1, 2026-10-07; ../overleaf/): the tabs showing an Overleaf editor (overleafTabs), and
// the open file read live from one (readOverleaf): a script run in the page's main world with executeJavaScript, which
// reads CodeMirror's state (the preload's isolated world cannot see the page's objects, and the DOM holds only the lines
// in view). Within OVERLEAF.READ_TIMEOUT_MS or not at all; nothing is kept here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { randomUUID } = require('node:crypto');

const PARTITION = 'persist:browser';
// A copy run from a checkout (`npm start`, `electron .`) keeps the Stage's cookies apart (2026-10-06). A package turns on
// Electron's EnableCookieEncryption fuse (electron-builder.config.cjs) and encrypts this store on write; a checkout runs
// the stock Electron, without the fuse, on the same userData folder, and cannot read what a package encrypted (Electron:
// "effectively corrupt"), while what it wrote would sit in the clear beside it. So each keeps its own: a developer signs
// in to the Stage once in each. Only the cookie store is split; settings, threads and the single-instance lock stay shared.
const DEV_PARTITION = 'persist:browser-dev';
/** The Stage's partition for this copy: `packaged` is app.isPackaged. */
const stagePartition = (packaged) => (packaged ? PARTITION : DEV_PARTITION);
const ERR_ABORTED = -3;
const SNAPSHOT_TIMEOUT_MS = 250;
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
const WEB_PREFERENCES = Object.freeze({ partition: PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const COOKIE_FLUSH_MS = 1000;
const ASKED_PERMISSIONS = { media: 'the camera or microphone', geolocation: 'your location', notifications: 'notifications', 'clipboard-read': 'the clipboard' };
// Never handed to another app: these either reach into this one or are not addresses at all.
const INTERNAL_SCHEMES = new Set(['http:', 'https:', 'file:', 'about:', 'blob:', 'data:', 'javascript:', 'chrome:', 'devtools:', 'view-source:', 'engelbart:']);
const MAX_PDF_BYTES = 200 * 1024 * 1024; // the library's limit
const PDF_TYPE = /^\s*application\/(?:x-)?pdf\b/i;
const FIND_MAX = 1000;
const SAVE_TIMEOUT_MS = 2 * 60 * 1000;
const PAGE_PRELOAD = path.join(__dirname, 'page-preload.cjs');
const PAGE_PRELOAD_ID = 'engelbart-page';
// A web highlight (2026-10-18, David's picture): a soft yellow with a thin yellow line under each of its lines (until then
// the PDF's blue). An author sheet: Chromium leaves ::highlight() out of a user one (cssOrigin 'user' paints nothing,
// checked 2026-10-06 on Electron 44). !important, so a page's own rule for the name wins only with !important of its own.
// The line sits 1px under the baseline (2026-10-24, was 3px): a ::highlight() is painted over the text's glyph box only
// (font ascent to descent), and at 3px the 2px line hung about 1.5px below that box, so the kept passage looked taller
// than the same passage offered; at 1px it is inside the box (measured on Electron 44 at 16px).
const MARK_LOOK = 'background-color:rgba(255,214,0,.22);text-decoration-line:underline;text-decoration-style:solid;text-decoration-color:rgba(240,190,0,.9);text-decoration-thickness:2px;text-underline-offset:1px';
// A selection on a page (2026-10-24, David: "it should look the same" from the drag to the kept highlight): the page's
// own paint of it is hidden and the preload tints its Range instead (page-preload.cjs SELECTION) in the active selection's
// colour, the system's Highlight (already see-through in Electron 44). A selection fills its line boxes, a ::highlight()
// only the glyph box of each line, and a kept highlight can only be the second: drawn the same way all along, the passage
// is the same size dragged, let go, with its chat icon or card, and kept, and the tint does not go grey when the card
// takes the keyboard. Its text keeps its colour (currentcolor: a page's own ::selection{color:#fff} would leave white
// text on the page's white). A field's text is the page's still (a ::highlight() cannot reach into an input), the
// active blue too.
const MARK_CSS = `::highlight(${PAGE.HIGHLIGHT}){${MARK_LOOK.split(';').map((p) => `${p} !important`).join(';')}}::highlight(${PAGE.SECTION}){background-color:rgba(255,196,0,.13) !important}` // a guide's section as a pdf's (PaperView)
  + `::selection{background-color:transparent !important;color:currentcolor !important}::highlight(${PAGE.SELECTION}){background-color:Highlight !important}`
  + ':is(input,textarea)::selection{background-color:Highlight !important}';
const QUOTE_TIMEOUT_MS = 2000;
const SELECTION_TIMEOUT_MS = 300; // an @bart turn does not wait on a page that does not answer
const MAX_PAGE_TEXT = 2 * PAGE.PAGE_TEXT + 2 * PAGE.MAX_EXACT; // the most page text main takes with a selection
const SHOT_TIMEOUT_MS = 1500;
const SHOT_MAX_EDGE = 1568; // pixels on the longer edge: what the models look at without scaling it down themselves
const MAX_PAGE_MARKS = 2000;
const BOX_LAYER_PRELOAD = path.join(__dirname, 'box-layer-preload.cjs');
const BOX_LAYER_PAGE = 'data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Chtml%3E%3Chead%3E%3Cmeta%20charset%3D%22utf-8%22%3E%3C%2Fhead%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E';
const BOX_TIMEOUT_MS = 2000; // how long the page has to say what a box drawn on it is
const FRAME_TIMEOUT_MS = 150; // how long a resize waits for the page to have painted without the box's lines
const BOX_CARD_PRELOAD = path.join(__dirname, 'box-card-preload.cjs');
const BOX_CARD_URL = 'engelbart://app/box-card.html';
const CARD_W = 336; // the card's widest, in the app's CSS pixels: BoxCard's ASK_W (320) and its shadow's room; it says how
// wide it is (only as wide as its note when it has no answers, 2026-10-07), and is never wider than this
const CARD_MIN_H = 64; // its height until it says how tall it is
// A selection's or a highlight's card (2026-10-18): SEL_CARD_W wide and its shadow's room each side (selection-card.cjs),
// and about as tall as an empty one until it says how tall it is
const SEL_VIEW_W = SEL.SEL_CARD_W + 2 * SEL.CARD_SHADE.side;
const SEL_VIEW_H = SEL.SEL_CARD_H + SEL.CARD_SHADE.top + SEL.CARD_SHADE.bottom;
// The chat icon a selection shows first (2026-10-24), in the same view: the icon and its shadow's room each side
const ICON_VIEW = SEL.CHAT_ICON + 2 * SEL.ICON_SHADE;
/** What a note asks Bart: the words after a leading @bart, or null for a note that asks nothing (pdf/canvas.js noteQuestion). */
function bartQuestion(note) {
  const m = String(note == null ? '' : note).match(/^\s*@bart(?=\s|$)([\s\S]*)$/i);
  const question = m ? m[1].trim() : '';
  return question || null;
}
const CARD_MAX_H = 1600;
// Whether the card is hidden while the page scrolls and shown again where the box is once it stops (the page says when:
// page-preload.cjs SCROLL_END_MS). Off: it follows. Measured on GitHub and Wikipedia (2026-10-07, a 240px wheel scroll
// sampled every few ms), the card's bounds kept within 0.5px of the box as the page reported it; how it looks against
// the page's own compositor scrolling is not measured, and this is the one switch should it trail on screen.
const CARD_HIDE_WHILE_SCROLLING = false;
const CURSOR_VALUES = new Set(['nwse-resize', 'nesw-resize', 'ns-resize', 'ew-resize', 'pointer']);
const RUN_LINES = 400, RUN_LINE = 4000;

/** http(s) only. 0.0.0.0 is what dev servers print, not an address to visit. */
function parseBrowserUrl(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new TypeError('URL must be a bounded string');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('URL protocol must be http or https');
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
  return url;
}

/** A file: address inside `root`, links followed. A file that is not there yet is judged by where it would be. */
function parseFileUrl(value, root) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 8192) throw new TypeError('URL must be a bounded string');
  let url;
  let target;
  try {
    url = new URL(value);
    if (url.protocol !== 'file:' || url.hostname) throw new TypeError('not a local file');
    target = fileURLToPath(url);
  } catch {
    throw new TypeError('URL is invalid');
  }
  if (typeof root !== 'string' || !root) throw new TypeError('Files cannot be opened here');
  const real = (file) => { try { return fs.realpathSync(file); } catch { return path.resolve(file); } };
  const home = real(root);
  const resolved = real(target);
  if (resolved !== home && !resolved.startsWith(home + path.sep)) throw new TypeError('Only files inside your home directory can be opened');
  return url;
}

const isFileUrl = (value) => /^file:/i.test(String(value || ''));

/** `slack://…`, `mailto:…`: an address some other app owns. */
function externalScheme(value) {
  try {
    const url = new URL(String(value));
    return INTERNAL_SCHEMES.has(url.protocol) ? '' : url.protocol;
  } catch {
    return '';
  }
}

function originOf(value) {
  try { return new URL(String(value)).origin; } catch { return ''; }
}

/** This machine only: the one place a self-signed certificate is accepted. */
function isLoopback(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Sites sniff "Electron/x" and serve a refusal, so it goes; the app's own token ("Engelbart/x") stays (2026-10-12). Google
 * refuses a sign-in from a user agent shaped exactly like desktop Chrome's that is not Chrome (Orca and Otter Mail found
 * the same): with either token kept it shows its password page.
 */
function cleanUserAgent(userAgent) {
  return String(userAgent || '').replace(/ Electron\/\S+/gi, '');
}

/** An address whose path ends in .pdf. */
function pdfAddress(value) {
  try { return /\.pdf$/i.test(new URL(String(value)).pathname); } catch { return false; }
}

function headerValue(headers, name) {
  for (const [key, value] of Object.entries(headers || {})) if (key.toLowerCase() === name) return [].concat(value).join(', ');
  return '';
}

/** A pdf response as a download, file name kept: that is how its bytes reach the viewer. Anything else: null. */
function pdfAsDownload(headers) {
  if (!PDF_TYPE.test(headerValue(headers, 'content-type'))) return null;
  const name = headerValue(headers, 'content-disposition').replace(/^\s*(?:inline|attachment)\b\s*;?\s*/i, '').trim(); // `filename="…"`, if any
  const out = {};
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() !== 'content-disposition') out[key] = value;
  out['Content-Disposition'] = [name ? `attachment; ${name}` : 'attachment'];
  return out;
}

/** What a pdf's tab is called: its file name without .pdf, else the last part of its address. */
function pdfName(fileName, url) {
  let name = String(fileName || '');
  if (!name) { try { name = decodeURIComponent(new URL(String(url)).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; } }
  return name.replace(/\.pdf$/i, '') || 'pdf';
}

function readPdf(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('The pdf is not a file');
  if (stat.size > MAX_PDF_BYTES) throw new Error('The pdf is larger than 200 MB');
  const buffer = fs.readFileSync(file);
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function boundsFrom(rect, zoom) {
  if (!rect || typeof rect !== 'object') throw new TypeError('Bounds are required');
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(rect[key]);
    if (!Number.isFinite(value) || Math.abs(value) > 100000) throw new TypeError('Bounds must be finite numbers');
    out[key] = Math.round(value * scale);
  }
  out.width = Math.max(1, out.width);
  out.height = Math.max(1, out.height);
  return out;
}

/** Whether ink on the page at `url` is kept: a page on the web or on disk; never a preview or a local server. */
function fileablePage(url) {
  let u;
  try { u = new URL(String(url || '')); } catch { return false; }
  if (u.protocol === 'file:') return true;
  return (u.protocol === 'http:' || u.protocol === 'https:') && !isPreviewAddress(u.href);
}

/** A quote as a page's preload sends it: { exact, prefix, suffix } of strings within their limits; anything else is null. */
function quoteInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { exact, prefix = '', suffix = '' } = value;
  if (typeof exact !== 'string' || typeof prefix !== 'string' || typeof suffix !== 'string') return null;
  if (!exact.trim() || exact.length > PAGE.MAX_EXACT || prefix.length > PAGE.MAX_AFFIX || suffix.length > PAGE.MAX_AFFIX) return null;
  return { exact, prefix, suffix };
}

/** A live selection as a page's preload sends it: { quote (quoteInput's), pageText (at most MAX_PAGE_TEXT) }, or null. */
function selectionInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const quote = quoteInput(value.quote);
  if (!quote) return null;
  const pageText = typeof value.pageText === 'string' ? value.pageText.slice(0, MAX_PAGE_TEXT) : '';
  return { quote, pageText };
}

/**
 * A selection's card as a page's preload says it (2026-10-18): { token: null } (taken back), or { token, line, rect,
 * viewport }, where its last line and all of it are in the viewport ({ x, y, w, h } or null), with { quote (quoteInput's),
 * pageText } when it is newly offered, or { markId, pageText } for a highlight's own card; null for anything else.
 */
function selectionCardInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.token === null) return { token: null };
  if (typeof value.token !== 'string' || !/^[\w-]{1,32}$/.test(value.token)) return null;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6;
  const rect = (r) => (r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(ok) && r.w >= 0 && r.h >= 0 ? { x: r.x, y: r.y, w: r.w, h: r.h } : null);
  const v = value.viewport;
  if (!v || typeof v !== 'object' || !ok(v.width) || !ok(v.height)) return null;
  const out = { token: value.token, line: rect(value.line), rect: rect(value.rect), viewport: { width: v.width, height: v.height } };
  // a highlight's own card (2026-10-18): its id, and the page's text around it for @bart
  if (value.markId !== undefined) {
    if (typeof value.markId !== 'string' || !value.markId || value.markId.length > 64) return null;
    // a selection inside it (2026-10-24): the chat icon first, as for a new selection
    return { ...out, markId: value.markId, pageText: typeof value.pageText === 'string' ? value.pageText.slice(0, MAX_PAGE_TEXT) : '', ...(value.icon === true ? { icon: true } : {}) };
  }
  if (value.quote === undefined) return out;
  const quote = quoteInput(value.quote);
  if (!quote) return null;
  return { ...out, quote, pageText: typeof value.pageText === 'string' ? value.pageText.slice(0, MAX_PAGE_TEXT) : '' };
}

/**
 * A page's web marks as its preload is given them: [{ id, quote }] for a highlight (noted: true with a note or an answer,
 * for its symbol), [{ id, box }] for a box (MATH-70), only the well-formed, at most MAX_PAGE_MARKS.
 */
function marksForPage(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_PAGE_MARKS) break;
    if (!m || typeof m.id !== 'string' || m.id.length > 64) continue;
    if (BOX.isBox(m)) { const box = BOX.boxInput(m.box); if (box) out.push({ id: m.id, box }); continue; }
    if (!m.quote) continue;
    const quote = quoteInput({ exact: m.quote.exact, prefix: String(m.quote.prefix || '').slice(-PAGE.MAX_AFFIX), suffix: String(m.quote.suffix || '').slice(0, PAGE.MAX_AFFIX) });
    if (quote) out.push(isNoted(m) ? { id: m.id, quote, noted: true } : { id: m.id, quote });
  }
  return out;
}

/** Whether a web highlight has a note or an answer (2026-10-18): its symbol shows. Its words stay in main. */
function isNoted(m) {
  return !!m && ((typeof m.note === 'string' && m.note.trim() !== '') || (Array.isArray(m.asks) && m.asks.some((a) => a && !a.deleted && String(a.answer || '').trim())));
}

/** What a page's preload says of a box drawn on it: { box (boxInput's), text (at most TEXT_MAX) }, or null. */
function boxReplyInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const box = BOX.boxInput(value.box);
  if (!box) return null;
  return { box, text: typeof value.text === 'string' ? value.text.replace(/\s+/g, ' ').trim().slice(0, BOX.TEXT_MAX) : '' };
}

/** Where a page says its boxes are: { rects: [{ id, x, y, w, h }], selected, size }, only the well-formed; null for anything else. */
function boxReportInput(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.rects)) return null;
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6;
  const rects = value.rects.slice(0, BOX.MAX_BOXES).filter((r) => r && typeof r.id === 'string' && r.id.length <= 64 && [r.x, r.y, r.w, r.h].every(ok) && r.w > 0 && r.h > 0)
    .map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h }));
  const selected = typeof value.selected === 'string' && value.selected.length <= 64 ? value.selected : null;
  const size = value.size && ok(value.size.width) && ok(value.size.height) ? { width: value.size.width, height: value.size.height } : null;
  // the box being resized, where the pointer is in the viewport and how big that is (build 3)
  const z = value.resizing, v = z && z.viewport;
  const resizing = z && typeof z.id === 'string' && rects.some((r) => r.id === z.id) && ok(z.x) && ok(z.y) && v && ok(v.width) && ok(v.height)
    ? { id: z.id, x: z.x, y: z.y, viewport: { width: v.width, height: v.height } } : null;
  // the notes' symbols on the page's highlights (2026-10-18): { id, x, y, size }, as rects are
  const notes = Array.isArray(value.notes) ? value.notes.slice(0, BOX.MAX_NOTES).filter((c) => c && typeof c.id === 'string' && c.id.length <= 64 && [c.x, c.y, c.size].every(ok) && c.size > 0 && c.size <= 64)
    .map((c) => ({ id: c.id, x: c.x, y: c.y, size: c.size })) : [];
  return notes.length ? { rects, selected, size, resizing, notes } : { rects, selected, size, resizing };
}

/** Where a page says its selected box is in its viewport: { id, rect: { x, y, w, h }, viewport, scrolling }, or { id: null }. */
function boxViewInput(value) {
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6;
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id.length > 64) return { id: null };
  const r = value.rect, v = value.viewport;
  if (!r || ![r.x, r.y, r.w, r.h].every(ok) || !(r.w > 0) || !(r.h > 0) || !v || !ok(v.width) || !ok(v.height)) return { id: null };
  return { id: value.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, viewport: { width: v.width, height: v.height }, scrolling: value.scrolling === true };
}

/** A box resized as its page says it: { id, rect (its viewport's CSS pixels), box, text } (boxReplyInput's), or null. */
function boxResizeInput(value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !/^[\w-]{1,64}$/.test(value.id)) return null;
  const r = value.rect;
  if (!r || ![r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e5) || !(r.w > 0) || !(r.h > 0)) return null;
  const got = boxReplyInput(value);
  return got ? { id: value.id, rect: { x: r.x, y: r.y, w: r.w, h: r.h }, ...got } : null;
}

/**
 * What the Stage has running from boxes' cards, as the card is given it: [{ askId, markId, question, activity, name,
 * effort, movedUp, lines, log, error }], only the well-formed and within bounds.
 */
function boxAsksInput(list) {
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const out = [];
  for (const p of Array.isArray(list) ? list.slice(0, 200) : []) {
    if (!p || typeof p !== 'object' || typeof p.askId !== 'string' || p.askId.length > 64 || typeof p.markId !== 'string' || p.markId.length > 64) continue;
    out.push({
      askId: p.askId, markId: p.markId, question: text(p.question, 8000), activity: text(p.activity, 300), name: text(p.name, 60), effort: text(p.effort, 30), movedUp: p.movedUp === true,
      lines: Array.isArray(p.lines) ? p.lines.slice(-RUN_LINES).map((l) => text(l, RUN_LINE)) : [],
      log: Array.isArray(p.log) ? p.log.slice(-60).map((l) => text(l, 300)) : [],
      error: p.error == null ? null : text(String(p.error), 2000),
    });
  }
  return out;
}

/** A mark's answers as its card shows them: [{ id, question, answer, meta, at }], the deleted ones left out. */
function cardAsks(asks) {
  return (Array.isArray(asks) ? asks : []).filter((a) => a && typeof a === 'object' && !a.deleted).slice(-100).map((a) => ({
    id: String(a.id || ''), question: String(a.question || ''), answer: String(a.answer || ''), at: a.at || null,
    meta: a.meta && typeof a.meta === 'object' ? { name: a.meta.name || null, effort: a.meta.effort || null } : null,
  }));
}

// The browsing session is the app's, one for every window (2026-10-03): its handlers are set once, by the first window's
// views, and each finds the window whose tab (or popup) the page is. A permission answered in one window is answered in
// all of them, for this run, as it is for the session.
const sessions = new WeakMap(); // browsing session -> { members: Set of a window's views, decided: Map }

function decide(shared, member, contents, permission, details) {
  if (ALLOWED_PERMISSIONS.has(permission)) return Promise.resolve(true);
  const what = ASKED_PERMISSIONS[permission];
  const origin = originOf((details && details.requestingUrl) || (contents && contents.getURL()));
  if (!what || !origin || !member) return Promise.resolve(false);
  const key = `${origin} ${permission}`; // -> the person's answer, for this run
  if (!shared.decided.has(key)) shared.decided.set(key, member.ask(`Allow ${origin} to use ${what}?`, '', 'Allow'));
  return shared.decided.get(key);
}

function joinSession(browsing, member) {
  let shared = sessions.get(browsing);
  if (!shared) {
    shared = { members: new Set(), decided: new Map() };
    sessions.set(browsing, shared);
    const ownerOf = (contents) => { for (const each of shared.members) if (each.owns(contents)) return each; return null; };
    browsing.setUserAgent(cleanUserAgent(browsing.getUserAgent()));
    browsing.setPermissionRequestHandler((contents, permission, callback, details) => {
      void decide(shared, ownerOf(contents) || [...shared.members].pop() || null, contents, permission, details).then(callback, () => callback(false));
    });
    // Sign-ins are cookies, and Chromium writes them lazily: a relaunch is a kill, not a quit.
    let timer = null;
    browsing.cookies.on('changed', () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; browsing.cookies.flushStore().catch(() => {}); }, COOKIE_FLUSH_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    // A tab's page that is a pdf becomes a download, which receivePdf hands to the renderer's viewer.
    browsing.webRequest.onHeadersReceived({ urls: ['http://*/*', 'https://*/*'], types: ['mainFrame'] }, (details, callback) => {
      const owner = details.resourceType === 'mainFrame' && details.webContents ? ownerOf(details.webContents) : null;
      const headers = owner && owner.tabOf(details.webContents) ? pdfAsDownload(details.responseHeaders) : null;
      callback(headers ? { responseHeaders: headers } : {});
    });
    browsing.on('will-download', (_event, item, contents) => { const owner = ownerOf(contents); if (owner) owner.receivePdf(item, contents); });
    // Every page in the session has the highlights' preload (MATH-54 build 2): a tab adopt() built around a webContents
    // Chromium made gets it as well, which a preload in a view's webPreferences would not reach.
    if (typeof browsing.registerPreloadScript === 'function') browsing.registerPreloadScript({ type: 'frame', id: PAGE_PRELOAD_ID, filePath: PAGE_PRELOAD });
  }
  shared.members.add(member);
  return shared;
}

function createBrowserViews({ electron, getWindow, send, appName, fileRoot, onLayerChange = () => {}, pdfDir = path.join(os.tmpdir(), 'engelbart-pdf'), partition = PARTITION, pageMarks = null, newId = randomUUID }) {
  const { WebContentsView, session, Menu, clipboard, dialog, shell, screen = null } = electron;
  const entries = new Map(); // tab id -> { view, error, requested, pending, seq, found }
  const popups = new Set(); // child windows opened by pages
  const logins = new Map(); // request id -> answer(credentials | null)
  let counter = 0;
  const nextId = (prefix) => `${prefix}-${Date.now().toString(36)}-${(counter += 1)}`;
  let configured = false;

  const pageUrl = (value) => (isFileUrl(value) ? parseFileUrl(value, fileRoot ? fileRoot() : '') : parseBrowserUrl(value));

  /** Where `contents` may go: http(s) from anywhere; the disk only from a page already on it. */
  function allowed(value, contents) {
    if (value === 'about:blank') return true;
    try {
      if (isFileUrl(value) && !(contents && isFileUrl(contents.getURL()))) return false;
      pageUrl(value);
      return true;
    } catch {
      return false;
    }
  }

  // This window's part in the shared session (joinSession): whose pages are whose, and where a question about one is asked.
  let shared = null;
  const member = {
    owns: (contents) => !!tabOf(contents) || [...popups].some((popup) => !popup.isDestroyed() && popup.webContents === contents),
    tabOf: (contents) => tabOf(contents),
    receivePdf: (item, contents) => receivePdf(item, contents),
    ask: (message, detail, yes) => ask(message, detail, yes),
  };
  function configureSession() {
    if (configured) return;
    configured = true;
    shared = joinSession(session.fromPartition(partition), member);
  }

  /** GitHub's sign-in cookies in the Stage's session, gone (endedGithubSession): the next GitHub page is asked for signed out. */
  async function dropGithubSession() {
    configureSession();
    const cookies = session.fromPartition(partition).cookies;
    await Promise.all(GITHUB_SESSION_COOKIES.map((name) => cookies.remove('https://github.com', name).catch(() => {})));
  }

  function tabOf(contents) {
    for (const [id, entry] of entries) if (entry.view.webContents === contents) return id;
    return null;
  }

  /** A tab's download that is a pdf goes to a temporary file and then to the viewer. Any other download is Electron's to ask about. */
  function receivePdf(item, contents) {
    const id = tabOf(contents);
    const url = item.getURL();
    if (!id || !(PDF_TYPE.test(item.getMimeType()) || /\.pdf$/i.test(item.getFilename()) || pdfAddress(url))) return false;
    fs.mkdirSync(pdfDir, { recursive: true, mode: 0o700 });
    const file = path.join(pdfDir, `${nextId('pdf')}.pdf`);
    item.setSavePath(file);
    if (entries.has(id)) entries.get(id).download = url; // its page's cancelled load is this download, not a failure
    const shown = { id, url, name: pdfName(item.getFilename(), url), under: contents.getURL() || 'about:blank' };
    send('browser:pdf', { ...shown, loading: true });
    item.on('updated', () => { if (item.getReceivedBytes() > MAX_PDF_BYTES) item.cancel(); });
    item.once('done', (_event, state) => {
      let result;
      try {
        if (state !== 'completed') throw new Error(item.getReceivedBytes() > MAX_PDF_BYTES ? 'The pdf is larger than 200 MB' : 'The pdf did not download');
        result = { bytes: readPdf(file) };
      } catch (failure) {
        result = { error: failure.message };
      }
      fs.rm(file, { force: true }, () => {});
      if (entries.has(id)) send('browser:pdf', { ...shown, ...result });
    });
    return true;
  }

  /** A pdf on disk: read here, never loaded into the page. */
  function openPdfFile(id, url) {
    const entry = entries.get(id);
    const shown = { id, url: url.href, name: pdfName('', url.href), under: (entry && entry.view.webContents.getURL()) || 'about:blank' };
    let result;
    try { result = { bytes: readPdf(fileURLToPath(url)) }; } catch (failure) { result = { error: failure.code === 'ENOENT' ? 'Nothing is at that path' : failure.message }; }
    send('browser:pdf', { ...shown, ...result });
  }

  async function ask(message, detail, yes) {
    const win = getWindow();
    const options = { type: 'question', buttons: [yes, 'Don\u2019t Allow'], defaultId: 1, cancelId: 1, message, detail, noLink: true };
    const result = win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return result.response === 0;
  }

  let handing = false; // one question at a time, however often a page tries
  async function handOver(url) {
    const scheme = externalScheme(url);
    if (!scheme || handing || String(url).length > 8192) return;
    handing = true;
    try {
      if (await ask(`Open this ${scheme}// link in its app?`, String(url).slice(0, 300), 'Open')) await shell.openExternal(String(url)).catch(() => {});
    } finally {
      handing = false;
    }
  }

  function assertId(id) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new TypeError('Tab id must be a bounded string');
  }

  function emit(id) {
    const entry = entries.get(id);
    if (!entry) return;
    const contents = entry.view.webContents;
    send('browser:state', {
      id,
      // Until a page commits, getURL() is still the page before it: report where the tab is headed.
      url: entry.error ? entry.error.url : entry.pending || contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      error: entry.error,
      drawn: entry.drawn, // a page has arrived in this tab at least once (the Stage's "Waking…" waits for the first)
    });
  }

  function focusAddress() {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.focus();
    send('browser:focus-address', {});
  }

  function contextMenu(contents, params, tab) {
    const template = [];
    if (tab && params.linkURL && allowed(params.linkURL, contents)) {
      template.push({ label: 'Open Link in New Tab', click: () => send('browser:open-tab', { url: params.linkURL, from: tab }) });
    }
    if (params.linkURL) template.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    if (params.isEditable) template.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    else if (params.selectionText) {
      if (canHighlight(contents, params, tab)) template.push({ label: 'Highlight', click: () => { void highlightSelection(tab, contents); } });
      template.push({ role: 'copy' }, { type: 'separator' });
    }
    template.push({ label: 'Back', enabled: contents.navigationHistory.canGoBack(), click: () => contents.navigationHistory.goBack() });
    template.push({ label: 'Forward', enabled: contents.navigationHistory.canGoForward(), click: () => contents.navigationHistory.goForward() });
    template.push({ label: 'Reload', click: () => { if (tab) command(tab, 'reload'); else contents.reload(); } });
    template.push({ type: 'separator' });
    template.push({ label: 'Inspect Element', click: () => { contents.inspectElement(params.x, params.y); } });
    Menu.buildFromTemplate(template).popup({ window: getWindow() || undefined });
  }

  /* ------------------------------------------------------------------ highlights on web pages (MATH-54 build 2) */

  /** Highlight is offered for a selection, in a tab (not a popup, not a field), on a page whose ink is kept. */
  function canHighlight(contents, params, tab) {
    const chosen = String(params.selectionText || '').trim();
    return !!(pageMarks && tab && entries.has(tab) && !params.isEditable && chosen && chosen.length <= PAGE.MAX_EXACT && fileablePage(contents.getURL()));
  }

  /** A message from tab `id`'s page: the tab is still this one, and it came from its main frame (the preload's). */
  function fromTab(event, id, entry) {
    if (!event || entries.get(id) !== entry || tabOf(event.sender) !== id) return false;
    const frame = event.senderFrame, main = entry.view.webContents.mainFrame;
    return !!frame && !!main && (frame === main || frame.frameTreeNodeId === main.frameTreeNodeId);
  }

  /** The tab's preload is asked for the selection's quote, saved as a web mark, and told to tint it. */
  async function highlightSelection(id, contents) {
    const entry = entries.get(id);
    if (!entry || !pageMarks || contents.isDestroyed()) return false;
    const url = contents.getURL();
    if (!fileablePage(url)) return false;
    const nonce = nextId('quote');
    const quote = await new Promise((resolve) => {
      const timer = setTimeout(() => { if (entry.quoteWait && entry.quoteWait.nonce === nonce) entry.quoteWait = null; resolve(null); }, QUOTE_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      entry.quoteWait = { nonce, resolve: (value) => { clearTimeout(timer); entry.quoteWait = null; resolve(value); } };
      contents.send(PAGE.CHANNELS.quote, nonce);
    });
    // the page went elsewhere meanwhile: its selection is not this page's
    if (!quote || entries.get(id) !== entry || contents.isDestroyed() || contents.getURL() !== url) return false;
    const mark = { id: newId(), quote, note: null, at: new Date().toISOString() };
    let saved = false;
    try { saved = await pageMarks.add(url, mark); } catch { saved = false; }
    if (saved && !contents.isDestroyed()) contents.send(PAGE.CHANNELS.add, { nonce, mark: { id: mark.id, quote } });
    return !!saved;
  }

  /**
   * The selection on tab `id`'s page as it is now, for an @bart turn (MATH-54 build 3a): { quote, pageText }, or null when
   * there is none, the tab is gone, or the page does not answer within `timeoutMs`. Nothing is saved or tinted.
   */
  function pageSelection(id, { timeoutMs = SELECTION_TIMEOUT_MS } = {}) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(null);
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return Promise.resolve(null);
    const nonce = nextId('selection');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { entry.selectionWaits.delete(nonce); resolve(null); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      entry.selectionWaits.set(nonce, (value) => { clearTimeout(timer); entry.selectionWaits.delete(nonce); resolve(value); });
      try { contents.send(PAGE.CHANNELS.selection, nonce); } catch { entry.selectionWaits.get(nonce)(null); }
    });
  }

  /**
   * What tab `id`'s page looks like now, as PNG bytes (its longer edge at most SHOT_MAX_EDGE), or null: no tab, a capture
   * that fails, takes past SHOT_TIMEOUT_MS or comes back empty.
   */
  async function screenshot(id) {
    const entry = entries.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) return null;
    let timer;
    try {
      let image = await Promise.race([
        entry.view.webContents.capturePage(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), SHOT_TIMEOUT_MS); }),
      ]);
      if (!image || image.isEmpty()) return null;
      const { width, height } = image.getSize();
      const scale = SHOT_MAX_EDGE / Math.max(width, height);
      if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
      const png = image.toPNG();
      return png && png.length ? png : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The tabs showing an Overleaf editor (overleaf.com/project/<id>) → [{ id, projectId, title, front }], `front` the one shown. */
  function overleafTabs() {
    const out = [];
    for (const [id, entry] of entries) {
      const contents = entry.view.webContents;
      if (contents.isDestroyed() || entry.error) continue;
      const projectId = OVERLEAF.overleafProjectId(contents.getURL());
      if (projectId) out.push({ id, projectId, title: contents.getTitle(), front: entry.view.getVisible() });
    }
    return out;
  }

  /**
   * The editor of tab `id`'s Overleaf page read now (../overleaf/editor.cjs readEditor): { ok: true, read } or
   * { ok: false, why }. A tab that is gone or not an Overleaf editor is { ok: false, why: 'error' }.
   */
  function readOverleaf(id, { timeoutMs = OVERLEAF.READ_TIMEOUT_MS } = {}) {
    const entry = entries.get(id);
    const contents = entry && entry.view.webContents;
    if (!contents || contents.isDestroyed() || !OVERLEAF.overleafProjectId(contents.getURL())) return Promise.resolve({ ok: false, why: 'error' });
    return OVERLEAF.readEditor(contents, { timeoutMs });
  }

  /** What tab `id`'s preload may ask (its marks) and answer (a quote or a selection main asked for), on the tab's own ipc. */
  function listenToPage(contents, id, entry) {
    if (!contents.ipc) return;
    contents.ipc.handle(PAGE.CHANNELS.marks, async (event, ...args) => {
      if (!fromTab(event, id, entry)) throw new Error('Not a page in the Stage');
      if (args.length) throw new TypeError('marks takes nothing');
      const url = contents.getURL();
      if (!pageMarks || !fileablePage(url)) return [];
      try { return marksForPage(await pageMarks.list(url)); } catch { return []; }
    });
    contents.ipc.on(PAGE.CHANNELS.quote, (event, reply) => {
      const waiting = entry.quoteWait;
      if (!waiting || !fromTab(event, id, entry) || !reply || typeof reply !== 'object' || reply.nonce !== waiting.nonce) return;
      waiting.resolve(quoteInput(reply.quote));
    });
    contents.ipc.on(PAGE.CHANNELS.section, (event, reply) => {
      const waiting = reply && typeof reply === 'object' ? entry.sectionWaits.get(reply.nonce) : null;
      if (!waiting || !fromTab(event, id, entry)) return;
      waiting(reply.shown === true);
    });
    contents.ipc.on(PAGE.CHANNELS.selection, (event, reply) => {
      const waiting = reply && typeof reply === 'object' ? entry.selectionWaits.get(reply.nonce) : null;
      if (!waiting || !fromTab(event, id, entry)) return;
      waiting(selectionInput(reply));
    });
    // boxes (MATH-70): what a box drawn here is, where the page's boxes are now, whether a field has the keyboard
    contents.ipc.on(PAGE.CHANNELS.box, (event, reply) => {
      const waiting = entry.boxWait;
      if (!waiting || !fromTab(event, id, entry) || !reply || typeof reply !== 'object' || reply.nonce !== waiting.nonce) return;
      waiting.resolve(boxReplyInput(reply));
    });
    contents.ipc.on(PAGE.CHANNELS.boxes, (event, report) => {
      if (!fromTab(event, id, entry)) return;
      const got = boxReportInput(report);
      if (got) drawBoxes(entry, contents, got);
    });
    contents.ipc.on(PAGE.CHANNELS.editing, (event, value) => { if (fromTab(event, id, entry)) entry.editing = value === true; });
    // build 2: a box resized, where the selected one is in the viewport, a frame painted, the cursor over a handle
    contents.ipc.handle(PAGE.CHANNELS.boxResize, async (event, value) => {
      if (!fromTab(event, id, entry)) throw new Error('Not a page in the Stage');
      const got = boxResizeInput(value);
      return got ? resizeBox(id, entry, contents, got) : null;
    });
    contents.ipc.on(PAGE.CHANNELS.boxView, (event, value) => {
      if (!fromTab(event, id, entry)) return;
      entry.boxView = boxViewInput(value);
      if (entry.view.getVisible() || card.tab === id) placeCard(id);
    });
    contents.ipc.on(PAGE.CHANNELS.frame, (event, nonce) => {
      const waiting = typeof nonce === 'string' ? entry.frameWaits.get(nonce) : null;
      if (waiting && fromTab(event, id, entry)) waiting();
    });
    contents.ipc.on(PAGE.CHANNELS.cursor, (event, value) => { if (fromTab(event, id, entry)) setCursor(entry, contents, CURSOR_VALUES.has(value) ? value : ''); });
    // a selection's card (2026-10-18): a settled selection offered, where it is now, or taken back
    contents.ipc.on(PAGE.CHANNELS.selectionCard, (event, value) => {
      if (!fromTab(event, id, entry)) return;
      const got = selectionCardInput(value);
      if (!got) return;
      if (!got.token) { dropOffer(id, entry); return; }
      if (got.quote || got.markId) {
        // a page whose ink is not kept, a field with the keyboard, a box being drawn or selected: no card
        if (!pageMarks || entry.editing || !fileablePage(contents.getURL()) || layer.tab === id || selectedBox(entry)) { dropOffer(id, entry); return; }
        if (card.tab === id && card.mode === 'selection') hideCard(); // the last selection's card, typed in or not
        // a selection (a new one, or one inside a highlight) shows the chat icon first (2026-10-24); a highlight clicked, its card
        entry.offer = { ...got, icon: !!got.quote || got.icon === true };
      } else if (entry.offer && entry.offer.token === got.token) entry.offer = { ...entry.offer, line: got.line, rect: got.rect, viewport: got.viewport };
      else return;
      if (entry.view.getVisible()) placeCard(id);
    });
    // the page's tints are styled anew with each document (insertCSS lasts until the page goes)
    contents.on('dom-ready', () => { if (!contents.isDestroyed()) contents.insertCSS(MARK_CSS).catch(() => {}); });
    // a new document has none of the boxes' rule, nothing selected and no field with the keyboard yet
    // (the keys of the rules inserted before are kept and taken out at the next drawing: a page given back from the
    // back-forward cache still has them; for a new one, removing them does nothing)
    contents.on('did-navigate', () => {
      entry.boxes = null; entry.boxCss = null; entry.editing = false; entry.boxView = { id: null }; entry.boxHide = null; entry.offer = null;
      setCursor(entry, contents, '');
      if (layer.tab === id) endBox(false);
      if (card.tab === id) hideCard();
    });
    // the same document at another address (a page that changes its own address): its boxes are that address's
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      if (!isMainFrame || !pageMarks || !fileablePage(url)) return;
      Promise.resolve(pageMarks.list(url)).then((list) => {
        if (!contents.isDestroyed() && contents.getURL() === url) contents.send(PAGE.CHANNELS.boxSet, marksForPage(list).filter((m) => m.box));
      }, () => {});
    });
  }

  /* ------------------------------------------------------------------------------------------- boxes (MATH-70) */

  // The page's boxes drawn by one inserted rule, the new one in before the old one is taken out; one change at a time.
  function drawBoxes(entry, contents, report) {
    entry.boxes = report;
    entry.boxDraw = entry.boxDraw.then(async () => {
      if (contents.isDestroyed() || entry.boxes !== report) return;
      // a box being pictured after a resize is left out until its picture is taken
      const z = report.resizing, rect = z && report.rects.find((r) => r.id === z.id);
      // a box's picture is taken without the notes' symbols too
      const css = BOX.boxesCss(entry.boxHide ? report.rects.filter((r) => r.id !== entry.boxHide) : report.rects, report.selected, report.size, z ? z.id : null, entry.boxHide ? [] : report.notes)
        + (rect ? BOX.readoutCss({ x: z.x, y: z.y, w: rect.w, h: rect.h, zoom: contents.getZoomFactor() || 1, viewport: z.viewport }) : '');
      if (css === entry.boxCss) return;
      const old = entry.boxKey;
      entry.boxCss = css;
      entry.boxKey = css ? await contents.insertCSS(css).catch(() => null) : null;
      if (old) await contents.removeInsertedCSS(old).catch(() => {});
    });
    return entry.boxDraw;
  }
  const selectedBox = (entry) => (entry.boxes && entry.boxes.selected && entry.boxes.rects.some((r) => r.id === entry.boxes.selected) ? entry.boxes.selected : null);

  // The drawing layer: one per window, made the first time it is wanted, over the tab in front while a box is drawn.
  const layer = { view: null, ready: false, tab: null, mode: null, queued: null };
  function layerView() {
    if (layer.view) return layer.view;
    const view = new WebContentsView({ webPreferences: { preload: BOX_LAYER_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    const contents = view.webContents;
    contents.on('focus', () => send('browser:focused', { id: layer.tab })); // the Stage's, as its page is (attach)
    contents.on('did-finish-load', () => { layer.ready = true; if (layer.queued) { contents.send(LAYER.CHANNELS.start, layer.queued); layer.queued = null; } });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    if (contents.ipc) {
      contents.ipc.on(LAYER.CHANNELS.done, (_event, rect) => { const tab = layer.tab; endBox(true); if (tab && rect) void makeBox(tab, rect); });
      contents.ipc.on(LAYER.CHANNELS.click, (_event, point) => {
        const tab = layer.tab, entry = tab ? entries.get(tab) : null;
        endBox(true);
        if (entry && point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
          const zoom = entry.view.webContents.getZoomFactor() || 1;
          entry.view.webContents.send(PAGE.CHANNELS.boxHit, { x: point.x / zoom, y: point.y / zoom });
        }
      });
      contents.ipc.on(LAYER.CHANNELS.cancel, () => endBox(true));
    }
    contents.loadURL(BOX_LAYER_PAGE).catch(() => {});
    layer.view = view;
    return view;
  }

  /** Whether tab `id` can be boxed now: a tab in front, showing a page whose ink is kept, not loading for the first time. */
  function canBox(id) {
    const entry = entries.get(id);
    return !!(pageMarks && entry && entry.view.getVisible() && !entry.error && !entry.view.webContents.isDestroyed() && fileablePage(entry.view.webContents.getURL()));
  }

  /** The drawing layer over tab `id` (`mode` 'button', the Stage's Box; 'alt', ⌥ held in the page), with the keyboard. */
  function startBox(id, mode = 'button') {
    assertId(id);
    const win = getWindow();
    if (!canBox(id) || !win || win.isDestroyed()) return false;
    const entry = entries.get(id);
    const view = layerView();
    if (layer.tab && layer.tab !== id) endBox(false);
    hideCardView(); // under the layer it could not be used; it comes back with the layer gone
    win.contentView.addChildView(view); // again: on top
    view.setBounds(entry.view.getBounds());
    view.setVisible(true);
    onLayerChange();
    layer.tab = id;
    layer.mode = mode;
    const start = { mode, ...pointerIn(win, entry.view.getBounds()) };
    if (layer.ready) view.webContents.send(LAYER.CHANNELS.start, start); else layer.queued = start;
    view.webContents.focus();
    send('browser:boxing', { id, on: true });
    return true;
  }

  /** Where the pointer is over a view at `bounds` as the layer comes up: { at: { x, y, screenX, screenY } }, or nothing. */
  function pointerIn(win, bounds) {
    if (!screen || typeof screen.getCursorScreenPoint !== 'function' || typeof win.getContentBounds !== 'function') return {};
    try {
      const p = screen.getCursorScreenPoint(), content = win.getContentBounds();
      const x = p.x - content.x - bounds.x, y = p.y - content.y - bounds.y;
      return x >= 0 && y >= 0 && x <= bounds.width && y <= bounds.height ? { at: { x, y, screenX: p.x, screenY: p.y } } : {};
    } catch {
      return {};
    }
  }

  /** The drawing layer gone; with `focusPage`, the page under it has the keyboard again. */
  function endBox(focusPage = true) {
    const id = layer.tab;
    if (!id) return false;
    layer.tab = null;
    layer.mode = null;
    layer.queued = null;
    if (layer.view) layer.view.setVisible(false);
    const entry = entries.get(id);
    if (focusPage && entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.focus();
    send('browser:boxing', { id, on: false });
    if (entry && entry.view.getVisible()) placeCard(id);
    return true;
  }

  /** The page's picture of `rect` (the view's pixels) as PNG bytes, its longer edge at most SHOT_MAX_EDGE; null when it fails. */
  async function cropOf(contents, rect) {
    let timer;
    try {
      const bounds = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.w)), height: Math.max(1, Math.round(rect.h)) };
      let image = await Promise.race([contents.capturePage(bounds), new Promise((resolve) => { timer = setTimeout(() => resolve(null), SHOT_TIMEOUT_MS); })]);
      if (!image || image.isEmpty()) return null;
      const { width, height } = image.getSize();
      const scale = SHOT_MAX_EDGE / Math.max(width, height);
      if (scale < 1) image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' });
      const png = image.toPNG();
      return png && png.length ? png : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A box drawn over tab `id` at `rect` (the layer's pixels, which are the page view's): the page says what it is kept by
   * and what text is under it, its picture is taken, and it is saved as a mark in the page's ink and drawn. → whether it
   * was saved.
   */
  async function makeBox(id, rect) {
    const entry = entries.get(id);
    if (!entry || !pageMarks || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0) return false;
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return false;
    const url = contents.getURL();
    if (!fileablePage(url)) return false;
    const zoom = contents.getZoomFactor() || 1;
    const nonce = nextId('box');
    const [got, crop] = await Promise.all([
      new Promise((resolve) => {
        const timer = setTimeout(() => { if (entry.boxWait && entry.boxWait.nonce === nonce) entry.boxWait = null; resolve(null); }, BOX_TIMEOUT_MS);
        if (typeof timer.unref === 'function') timer.unref();
        entry.boxWait = { nonce, resolve: (value) => { clearTimeout(timer); entry.boxWait = null; resolve(value); } };
        contents.send(PAGE.CHANNELS.box, { nonce, rect: { x: rect.x / zoom, y: rect.y / zoom, w: rect.w / zoom, h: rect.h / zoom } });
      }),
      cropOf(contents, rect),
    ]);
    if (!got || entries.get(id) !== entry || contents.isDestroyed() || contents.getURL() !== url) return false;
    const markId = newId();
    const mark = { id: markId, box: got.box, crop: crop ? BOX.cropName(markId) : null, text: got.text, note: null, at: new Date().toISOString() };
    let saved = false;
    try { saved = await pageMarks.add(url, mark, { crop }); } catch { saved = false; }
    if (saved && !contents.isDestroyed()) contents.send(PAGE.CHANNELS.boxAdd, { id: mark.id, box: mark.box, select: true }); // a box just drawn is selected
    return !!saved;
  }

  /** Tab `id`'s page painted at least once since now (its preload's two frames), or FRAME_TIMEOUT_MS gone by. */
  function pageFrame(entry, contents) {
    const nonce = nextId('frame');
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); entry.frameWaits.delete(nonce); resolve(); };
      const timer = setTimeout(done, FRAME_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      entry.frameWaits.set(nonce, done);
      try { contents.send(PAGE.CHANNELS.frame, nonce); } catch { done(); }
    });
  }

  /**
   * Box `got.id` resized on tab `id`'s page to `got.rect` (its viewport's CSS pixels), kept by `got.box` with `got.text`
   * under it: its picture is taken without its own lines (drawn without it, the page painted), and the mark updated with
   * them and the picture under a new name (store/library.cjs updateWebMark). → { box } as it is kept now, or null.
   */
  async function resizeBox(id, entry, contents, got) {
    if (!pageMarks || !pageMarks.update || contents.isDestroyed()) return null;
    const url = contents.getURL();
    if (!fileablePage(url)) return null;
    const zoom = contents.getZoomFactor() || 1;
    entry.boxHide = got.id;
    let crop = null;
    try {
      if (entry.boxes) await drawBoxes(entry, contents, entry.boxes);
      await pageFrame(entry, contents);
      crop = await cropOf(contents, { x: got.rect.x * zoom, y: got.rect.y * zoom, w: got.rect.w * zoom, h: got.rect.h * zoom });
    } finally {
      if (entry.boxHide === got.id) entry.boxHide = null;
      if (entry.boxes && !contents.isDestroyed()) void drawBoxes(entry, contents, entry.boxes);
    }
    if (entries.get(id) !== entry || contents.isDestroyed() || contents.getURL() !== url) return null;
    let mark = null;
    try { mark = await pageMarks.update(url, got.id, { box: got.box, text: got.text }, { crop }); } catch { mark = null; }
    if (!mark || !BOX.isBox(mark)) return null;
    if (card.tab === id && card.markId === got.id) void refreshCard();
    return { box: mark.box };
  }

  /** The cursor the pointer has over the page: a handle's (an inserted rule over everything), or the page's own (''). */
  function setCursor(entry, contents, value) {
    if (entry.cursor === value) return;
    entry.cursor = value;
    entry.cursorDraw = entry.cursorDraw.then(async () => {
      if (contents.isDestroyed() || entry.cursor !== value) return;
      const old = entry.cursorKey;
      entry.cursorKey = value ? await contents.insertCSS(`html,html *,html *::before,html *::after{cursor:${value} !important}`).catch(() => null) : null;
      if (old) await contents.removeInsertedCSS(old).catch(() => {});
    });
  }
  /* --------------------------------------------------------------------------------- the selected box's card */

  // One per window, made the first time a box is selected: { view, ready, tab, markId, height, running, note }.
  // A selection's card (2026-10-18) is this view too, in mode 'selection' (else 'box'): `offer`, the selection's token,
  // `markId` null until it is saved (a highlight's own card: its mark's from the start); `last`, the mark it was for
  // before, whose note may still come; `shown`, the last state sent to it.
  // `icon` (2026-10-24): a selection's card shown as the chat icon alone, until it is clicked (box-card:open).
  const card = { view: null, ready: false, tab: null, markId: null, mode: null, offer: null, icon: false, pageText: '', last: null, height: 0, width: 0, sizes: new Map(), running: [], note: null, saving: Promise.resolve(), queued: null, shown: null };
  const iconState = () => (card.icon ? { icon: true } : {});
  /** Messages from the card's own page alone (box-card.html, its main frame). */
  function fromCard(event) {
    try { assertTrustedRenderer(event, BOX_CARD_URL); } catch { return false; }
    return !!card.view && event.sender === card.view.webContents;
  }
  function cardView() {
    if (card.view) return card.view;
    const view = new WebContentsView({ webPreferences: { preload: BOX_CARD_PRELOAD, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    const contents = view.webContents;
    contents.on('focus', () => send('browser:focused', { id: card.tab })); // the Stage's, as its page is (attach)
    contents.on('did-finish-load', () => { card.ready = true; if (card.queued) { contents.send(CARD.CHANNELS.state, card.queued); card.queued = null; } });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Esc in the card gives the keyboard back to the page, the box still selected; a selection's or a highlight's card it
    // closes, what was typed in it unsaved
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.key !== 'Escape') return;
      const entry = card.tab ? entries.get(card.tab) : null;
      if (!entry || entry.view.webContents.isDestroyed()) return;
      event.preventDefault();
      if (card.mode === 'selection') closeOffer(card.tab, entry);
      entry.view.webContents.focus();
    });
    if (contents.ipc) {
      contents.ipc.on(CARD.CHANNELS.ready, (event) => { if (fromCard(event)) void refreshCard(); });
      contents.ipc.on(CARD.CHANNELS.note, (event, text) => { if (fromCard(event) && typeof text === 'string' && text.length <= 20000) saveCardNote(text); });
      // a selection's or a highlight's card (2026-10-18): Save keeps the note (and asks one that starts with @bart), Cancel
      // closes it with nothing saved
      contents.ipc.on(CARD.CHANNELS.save, (event, text) => {
        if (!fromCard(event) || typeof text !== 'string' || text.length > 20000 || card.mode !== 'selection' || card.icon) return;
        void saveSelectionCard(text);
      });
      // the chat icon clicked (2026-10-24): its card, in its place under the selection, with the keyboard
      contents.ipc.on(CARD.CHANNELS.open, (event) => {
        if (!fromCard(event) || card.mode !== 'selection' || !card.icon) return;
        card.icon = false; card.height = 0; card.width = 0;
        const { icon, ...shown } = card.shown || { mode: 'selection', offer: card.offer, mark: null, running: [] };
        sendCard(shown);
        if (card.tab) placeCard(card.tab);
        if (!view.webContents.isDestroyed()) view.webContents.focus();
      });
      contents.ipc.on(CARD.CHANNELS.cancel, (event) => {
        if (!fromCard(event) || card.mode !== 'selection') return;
        const entry = card.tab ? entries.get(card.tab) : null;
        if (entry) closeOffer(card.tab, entry);
      });
      contents.ipc.on(CARD.CHANNELS.ask, (event, question) => { if (fromCard(event) && typeof question === 'string' && question.trim() && question.length <= 8000) void cardAsk(question.trim()); });
      contents.ipc.on(CARD.CHANNELS.stop, (event, askId) => { if (fromCard(event) && typeof askId === 'string' && askId.length <= 64) send('browser:box-stop', { askId }); });
      contents.ipc.on(CARD.CHANNELS.remove, (event) => {
        if (!fromCard(event) || !card.tab || !card.markId) return;
        if (card.mode === 'selection') void removeHighlight(card.tab, card.markId); else void removeBox(card.tab, card.markId);
      });
      contents.ipc.on(CARD.CHANNELS.size, (event, value) => {
        const height = value && typeof value === 'object' ? Number(value.height) : NaN;
        const width = value && typeof value === 'object' ? Number(value.width) : NaN;
        if (!fromCard(event) || !Number.isFinite(height)) return;
        card.height = Math.max(card.icon ? 1 : CARD_MIN_H, Math.min(CARD_MAX_H, Math.ceil(height)));
        card.width = Number.isFinite(width) && width > 0 ? Math.min(card.mode === 'selection' ? SEL_VIEW_W : CARD_W, Math.ceil(width)) : 0;
        // kept a box (the last 200), so the card is placed at its own size the next time that box is selected, not first
        // at the widest and then moved (2026-10-07)
        if (card.markId && card.mode === 'box') { card.sizes.delete(card.markId); card.sizes.set(card.markId, { height: card.height, width: card.width }); }
        if (card.sizes.size > 200) card.sizes.delete(card.sizes.keys().next().value);
        if (card.tab) placeCard(card.tab);
      });
    }
    contents.loadURL(BOX_CARD_URL).catch(() => {});
    card.view = view;
    return view;
  }
  function sendCard(state) {
    if (!card.view || card.view.webContents.isDestroyed()) return;
    if (state && state.typed === undefined) card.shown = state;
    if (card.ready) card.view.webContents.send(CARD.CHANNELS.state, state); else card.queued = state;
  }
  /** The card given its mark as it is kept now ({ id, note, asks }) and what the Stage has running from it. */
  async function refreshCard() {
    const { tab, markId } = card;
    const entry = tab ? entries.get(tab) : null;
    if (!entry || !markId || !pageMarks) return;
    let list = [];
    try { list = await pageMarks.list(entry.view.webContents.getURL()); } catch { list = []; }
    if (card.tab !== tab || card.markId !== markId) return;
    const m = (Array.isArray(list) ? list : []).find((x) => x && x.id === markId);
    sendCard({ mode: card.mode, offer: card.offer, mark: m ? { id: m.id, note: typeof m.note === 'string' ? m.note : '', asks: cardAsks(m.asks) } : { id: markId, note: '', asks: [] }, running: card.running.filter((p) => p.markId === markId), ...iconState() });
    // a highlight's symbol shows once it has a note or an answer (an answer comes in while its card is open)
    const contents = entry.view.webContents;
    if (m && card.mode === 'selection' && !BOX.isBox(m) && !contents.isDestroyed()) contents.send(PAGE.CHANNELS.noted, { id: m.id, on: isNoted(m) });
  }
  /**
   * The card's note saved on its mark, one save after another. A note that comes once the card has gone (or has gone on
   * to a selection with no mark yet) is the mark's it was showing (`card.last`): what was typed there last is kept.
   */
  function saveCardNote(text) {
    const at = card.markId ? { tab: card.tab, markId: card.markId, url: null } : card.last;
    const entry = at && at.tab ? entries.get(at.tab) : null, markId = at && at.markId;
    if (!entry || !markId || !pageMarks || !pageMarks.update) return;
    if (card.markId) card.note = { markId, text };
    const url = at.url || entry.view.webContents.getURL();
    card.saving = card.saving.then(() => pageMarks.update(url, markId, { note: text })).catch(() => null);
  }
  /** The card's mark, before it is let go of or another is shown: a note still on its way is that one's. */
  function rememberCard() {
    const entry = card.tab && card.markId ? entries.get(card.tab) : null;
    card.last = entry && !entry.view.webContents.isDestroyed() ? { tab: card.tab, markId: card.markId, url: entry.view.webContents.getURL() } : card.last;
  }
  /**
   * Tab `id`'s offered selection kept as a highlight with `text` for its note (2026-10-18, on Save): as the right-click
   * menu's Highlight keeps it (its quote, then the page told to tint it, the offer's token for its nonce). The same passage
   * kept already (its quote word for word) is that mark, its note this one: never two marks for one passage. The card
   * shows the mark from now on; `clear`: it is closing, and the page lets go of the selection. → the mark's id, or null.
   */
  async function keepSelection(id, entry, text, { clear = false } = {}) {
    const offer = entry.offer, contents = entry.view.webContents;
    if (!offer || !offer.quote || !pageMarks || card.tab !== id || card.mode !== 'selection' || card.offer !== offer.token || card.markId || contents.isDestroyed()) return null;
    const url = contents.getURL();
    if (!fileablePage(url)) return null;
    const mark = { id: newId(), quote: offer.quote, note: text || null, at: new Date().toISOString() };
    card.markId = mark.id; // a second Save meanwhile keeps nothing more
    card.note = text ? { markId: mark.id, text } : null;
    card.pageText = offer.pageText || '';
    const filed = card.saving.then(async () => {
      let list = [];
      try { list = await pageMarks.list(url); } catch { list = []; }
      const twin = (Array.isArray(list) ? list : []).find((m) => m && !BOX.isBox(m) && sameQuote(m.quote, mark.quote));
      if (twin) return pageMarks.update && (await pageMarks.update(url, twin.id, { note: mark.note })) ? twin.id : null;
      return (await pageMarks.add(url, mark)) ? mark.id : null;
    }).catch(() => null);
    card.saving = filed.then(() => null);
    const kept = await filed;
    const still = card.tab === id && card.markId === mark.id;
    if (!kept) { if (still) { card.markId = null; card.note = null; } return null; }
    if (still) { card.markId = kept; if (card.note) card.note.markId = kept; }
    if (!contents.isDestroyed() && contents.getURL() === url) contents.send(PAGE.CHANNELS.add, { nonce: offer.token, mark: { id: kept, quote: mark.quote, noted: !!(text && text.trim()) }, ...(clear ? { clear: true } : {}) });
    if (still && !clear) void refreshCard();
    return kept;
  }
  /** Whether two quotes are the same passage, as the page is given them (marksForPage's affixes). */
  function sameQuote(a, b) {
    if (!a || !b || typeof a.exact !== 'string' || a.exact !== b.exact) return false;
    return String(a.prefix || '').slice(-PAGE.MAX_AFFIX) === String(b.prefix || '').slice(-PAGE.MAX_AFFIX) && String(a.suffix || '').slice(0, PAGE.MAX_AFFIX) === String(b.suffix || '').slice(0, PAGE.MAX_AFFIX);
  }
  /**
   * Save in a selection's or a highlight's card (2026-10-18): the note kept on its highlight (a new selection's highlight
   * kept with it), then the card closes; a note that starts with @bart is asked, as Enter asked it before, and the card
   * stays for the answer. A new selection's card with nothing in it keeps nothing.
   */
  async function saveSelectionCard(text) {
    const id = card.tab, entry = id ? entries.get(id) : null, offer = entry && entry.offer;
    if (!entry || !offer || card.offer !== offer.token || entry.view.webContents.isDestroyed()) return;
    const question = bartQuestion(text);
    let markId = card.markId;
    if (!markId) {
      if (!text.trim()) return;
      markId = await keepSelection(id, entry, text, { clear: !question });
      if (!markId) return;
    } else {
      card.note = { markId, text };
      saveHighlightNote(entry, markId, text);
    }
    if (card.tab !== id || card.markId !== markId) return;
    if (question) { void cardAsk(question); return; }
    closeOffer(id, entry);
  }
  /** A kept highlight's note saved, one save after another, and its page told whether its symbol shows. */
  function saveHighlightNote(entry, markId, text) {
    const contents = entry.view.webContents, url = contents.getURL();
    if (!pageMarks || !pageMarks.update) return;
    card.saving = card.saving.then(() => pageMarks.update(url, markId, { note: text })).then((m) => {
      if (m && !contents.isDestroyed() && contents.getURL() === url) contents.send(PAGE.CHANNELS.noted, { id: markId, on: isNoted(m) });
    }, () => null);
  }
  /** Tab `id`'s selection or highlight card closed by the card (Save, Cancel, Esc): the page is told, so the passage can
   *  be offered again. */
  function closeOffer(id, entry) {
    const token = entry.offer ? entry.offer.token : card.tab === id && card.mode === 'selection' ? card.offer : null;
    entry.offer = null;
    if (card.tab === id && card.mode === 'selection') hideCard();
    const contents = entry.view.webContents;
    if (token && !contents.isDestroyed()) contents.send(PAGE.CHANNELS.cardGone, token);
  }
  /** Tab `id`'s selection taken back: its card, typed in or not, goes, nothing saved. */
  function dropOffer(id, entry) {
    closeOffer(id, entry);
  }
  /** A highlight removed from its card: out of the page's ink, its tint and symbol gone, its card closed. → whether it was. */
  async function removeHighlight(id, markId) {
    const entry = entries.get(id);
    if (!entry || !pageMarks || !pageMarks.remove) return false;
    const contents = entry.view.webContents, url = contents.getURL();
    await card.saving;
    let removed = null;
    try { removed = await pageMarks.remove(url, markId); } catch { removed = null; }
    if (!removed) return false;
    if (!contents.isDestroyed()) contents.send(PAGE.CHANNELS.unmark, markId);
    if (card.tab === id && card.markId === markId && entries.get(id) === entry) closeOffer(id, entry);
    return true;
  }
  /**
   * A key in tab `id`'s page while its selection's or highlight's card shows (2026-10-18): a printable one goes into the
   * card's note, which takes the keyboard (nothing is saved until Save), Esc closes the card. Every other key (⌘C, ⌘A,
   * Enter, the arrows) is the page's. → whether the key was the card's.
   */
  function selectionKey(id, entry, event, input) {
    if (input.type !== 'keyDown' || !entry.offer || card.tab !== id || card.mode !== 'selection' || card.offer !== entry.offer.token || !card.view || !card.view.getVisible()) return false;
    if (input.key === 'Escape' && !input.meta && !input.control && !input.alt) { event.preventDefault(); closeOffer(id, entry); return true; }
    if (card.icon) return false; // the chat icon alone (2026-10-24): every key but Esc is the page's
    if (input.meta || input.control || input.alt || input.isComposing) return false;
    if ([...String(input.key)].length !== 1) return false;
    event.preventDefault();
    sendCard({ ...(card.shown || { mode: 'selection', offer: card.offer, mark: null, running: [] }), typed: input.key });
    if (!card.view.webContents.isDestroyed()) card.view.webContents.focus();
    return true;
  }
  /** @bart from the card: the window's renderer asks it as it asks from a highlight (Stage.jsx), with the mark's answers so far. */
  async function cardAsk(question) {
    const tab = card.tab, markId = card.markId, entry = tab ? entries.get(tab) : null;
    if (!entry || !markId || !pageMarks) return;
    const contents = entry.view.webContents, url = contents.getURL();
    await card.saving;
    let list = [];
    try { list = await pageMarks.list(url); } catch { list = []; }
    const m = (Array.isArray(list) ? list : []).find((x) => x && x.id === markId);
    // a box's, or (2026-10-18) a highlight's from a selection's card
    const box = BOX.isBox(m);
    if (!m || !(box || (m.quote && typeof m.quote.exact === 'string')) || card.tab !== tab || contents.isDestroyed()) return;
    const note = card.note && card.note.markId === markId ? card.note.text : String(m.note || '');
    const turns = cardAsks(m.asks).slice(-40).map((a) => ({ question: a.question, answer: a.answer }));
    send('browser:box-ask', { tab, markId, url, title: contents.getTitle(), question, note, turns, ...(box ? {} : { quote: m.quote.exact, pageText: card.pageText }) });
  }
  /** What the Stage has running from boxes' cards (Stage.jsx): the card shows its own box's, and reads its mark again. */
  function setBoxAsks(list) {
    card.running = boxAsksInput(list);
    if (card.markId) void refreshCard();
    return true;
  }
  /** The card out of sight, the box it is for kept: it comes back where the box is. */
  function hideCardView() {
    if (!card.view || !card.view.getVisible()) return;
    const had = card.view.webContents.isFocused();
    card.view.setVisible(false);
    const entry = card.tab ? entries.get(card.tab) : null;
    if (had && entry && !entry.view.webContents.isDestroyed()) entry.view.webContents.focus();
  }
  /** The card gone: no box is selected on a tab in front (nor a selection offered). */
  function hideCard() {
    rememberCard();
    hideCardView();
    card.tab = null;
    card.markId = null;
    card.note = null;
    card.mode = null;
    card.offer = null;
    card.icon = false;
  }
  /**
   * The card beside the box selected on tab `id`, when that tab is in front and the box in view (BOX.cardPlace), at the
   * app's zoom; else out of sight.
   */
  function placeCard(id) {
    const entry = entries.get(id), win = getWindow();
    const sel = entry && entry.boxView && entry.boxView.id ? entry.boxView : null;
    if (sel && entry.offer) dropOffer(id, entry); // a box selected: its card, not the selection's
    if (!sel && entry && entry.offer) { placeSelectionCard(id, entry); return; }
    if (!sel || !entry.view.getVisible() || !pageMarks || !win || win.isDestroyed()) { if (card.tab === id) hideCard(); return; }
    if (layer.tab === id) { hideCardView(); return; }
    const view = cardView();
    if (card.tab !== id || card.markId !== sel.id || card.mode !== 'box') { rememberCard(); hideCardView(); card.tab = id; card.markId = sel.id; card.mode = 'box'; card.offer = null; card.icon = false; card.note = null; const kept = card.sizes.get(sel.id); card.height = kept ? kept.height : 0; card.width = kept ? kept.width : 0; void refreshCard(); }
    if (CARD_HIDE_WHILE_SCROLLING && sel.scrolling) { hideCardView(); return; }
    const zoom = entry.view.webContents.getZoomFactor() || 1, page = entry.view.getBounds();
    const box = { x: page.x + sel.rect.x * zoom, y: page.y + sel.rect.y * zoom, width: sel.rect.w * zoom, height: sel.rect.h * zoom };
    const appZoom = (win.webContents && win.webContents.getZoomFactor && win.webContents.getZoomFactor()) || 1;
    const at = BOX.cardPlace(box, page, { width: (card.width || CARD_W) * appZoom, height: (card.height || CARD_MIN_H) * appZoom });
    if (!at) { hideCardView(); return; }
    if (view.webContents.getZoomFactor && view.webContents.getZoomFactor() !== appZoom) view.webContents.setZoomFactor(appZoom);
    view.setBounds(at);
    if (!view.getVisible()) {
      win.contentView.addChildView(view); // on top of the page (a tab made after it went in under it)
      view.setVisible(true);
      onLayerChange();
    }
  }

  /**
   * The card for the selection offered on tab `id` (2026-10-18), or for a highlight's own (its markId): empty at first,
   * or with the highlight's note, under the selection's (the highlight's) last line and left with it, or above it with no
   * room below, inside the page (SEL.shadedCardPlace: the view has room about the card for its shadow), at the app's
   * zoom. The selection gone out of view: a new selection's card closes, a highlight's waits out of sight.
   */
  function placeSelectionCard(id, entry) {
    const win = getWindow(), offer = entry.offer;
    if (!entry.view.getVisible() || !pageMarks || !win || win.isDestroyed()) { if (card.tab === id) hideCardView(); return; }
    if (layer.tab === id) { dropOffer(id, entry); return; }
    const view = cardView();
    if (card.tab !== id || card.mode !== 'selection' || card.offer !== offer.token) {
      rememberCard(); hideCardView();
      card.tab = id; card.mode = 'selection'; card.offer = offer.token; card.markId = offer.markId || null; card.icon = !!offer.icon; card.note = null; card.pageText = offer.pageText || ''; card.height = 0; card.width = 0;
      sendCard({ mode: 'selection', offer: offer.token, mark: null, running: [], ...iconState() });
      if (card.markId) void refreshCard();
    }
    const zoom = entry.view.webContents.getZoomFactor() || 1, page = entry.view.getBounds();
    const appZoom = (win.webContents && win.webContents.getZoomFactor && win.webContents.getZoomFactor()) || 1;
    const inWindow = (r) => (r ? { x: page.x + r.x * zoom, y: page.y + r.y * zoom, width: r.w * zoom, height: r.h * zoom } : null);
    const line = inWindow(offer.line), all = inWindow(offer.rect);
    if (card.icon) {
      // the chat icon at the selection's end (SEL.shadedIconPlace), gone once that end is out of the page
      const side = (card.width || ICON_VIEW) * appZoom, room = SEL.ICON_SHADE * appZoom;
      const icon = { width: Math.max(1, side - 2 * room), height: Math.max(1, (card.height || ICON_VIEW) * appZoom - 2 * room) };
      const spot = line && SEL.shadedIconPlace(line, page, icon, room, SEL.ICON_GAP * appZoom);
      if (!spot) { dropOffer(id, entry); return; }
      showCardAt(view, win, spot, appZoom);
      return;
    }
    const shade = { top: SEL.CARD_SHADE.top * appZoom, side: SEL.CARD_SHADE.side * appZoom, bottom: SEL.CARD_SHADE.bottom * appZoom };
    const full = { width: (card.width || SEL_VIEW_W) * appZoom, height: (card.height || SEL_VIEW_H) * appZoom };
    const size = { width: Math.max(1, full.width - 2 * shade.side), height: Math.max(1, full.height - shade.top - shade.bottom) };
    const at = line && SEL.shadedCardPlace(line, all, page, size, shade, SEL.CARD_GAP * appZoom);
    if (!at) { if (card.markId) hideCardView(); else dropOffer(id, entry); return; }
    showCardAt(view, win, at, appZoom);
  }
  /** The card view at `at` in the window, at the app's zoom, over the page. */
  function showCardAt(view, win, at, appZoom) {
    if (view.webContents.getZoomFactor && view.webContents.getZoomFactor() !== appZoom) view.webContents.setZoomFactor(appZoom);
    view.setBounds(at);
    if (!view.getVisible()) {
      win.contentView.addChildView(view);
      view.setVisible(true);
      onLayerChange();
    }
  }

  /** The box selected on tab `id`'s page taken out of its ink, picture and all, and kept for Undo. → whether it was. */
  async function removeBox(id, markId) {
    const entry = entries.get(id);
    if (!entry || !pageMarks || !pageMarks.remove) return false;
    const contents = entry.view.webContents, url = contents.getURL();
    let removed = null;
    try { removed = await pageMarks.remove(url, markId); } catch { removed = null; }
    if (!removed) return false;
    entry.removed = { url, removed };
    if (!contents.isDestroyed()) contents.send(PAGE.CHANNELS.boxRemove, markId);
    send('browser:box-removed', { id, markId });
    return true;
  }

  /** The box last removed on tab `id` put back where it was, with its picture. → whether it was. */
  async function undoBox(id) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry || !entry.removed || !pageMarks || !pageMarks.restore) return false;
    const { url, removed } = entry.removed;
    entry.removed = null;
    let back = false;
    try { back = await pageMarks.restore(url, removed); } catch { back = false; }
    const contents = entry.view.webContents;
    if (back && !contents.isDestroyed() && contents.getURL() === url) contents.send(PAGE.CHANNELS.boxAdd, { id: removed.mark.id, box: removed.mark.box });
    send('browser:box-restored', { id, markId: removed.mark.id });
    return !!back;
  }

  /** What every page gets, in a tab or in a popup: http(s) or the disk, loopback certificates, a sign-in prompt. */
  function protect(contents, tab) {
    const guard = (event, url) => {
      if (isGithubSignIn(url)) { event.preventDefault(); void shell.openExternal(url).catch(() => {}); return; }
      if (allowed(url, contents)) {
        // a page on disk linking to a pdf on disk: the viewer reads it, as when it is typed
        if (!(isFileUrl(url) && pdfAddress(url) && tab && tabOf(contents) === tab)) return;
        event.preventDefault();
        openPdfFile(tab, new URL(url));
        return;
      }
      event.preventDefault();
      void handOver(url);
    };
    contents.on('will-navigate', guard);
    // A GitHub page sent to GitHub's /login by a redirect (2026-10-05): the Stage still holds a sign-in GitHub has ended,
    // and with it GitHub shows nothing, not even a public repository. The ended session is dropped and the page asked for
    // again, once, signed out; sent to /login again, it goes to the default browser as any sign-in does.
    let started = ''; // where the page's current navigation set out for
    let retried = '';
    contents.on('did-start-navigation', (details) => { if (details && details.isMainFrame && !details.isSameDocument) started = String(details.url || ''); });
    contents.on('did-navigate', () => { retried = ''; });
    contents.on('will-redirect', (event, url) => {
      const from = started;
      if (!event.isMainFrame || retried === from || !endedGithubSession(from, url)) { guard(event, url); return; }
      event.preventDefault();
      retried = from;
      const entry = tab ? entries.get(tab) : null;
      if (entry) entry.retrying = true; // the cancelled load is no failure: the page is asked for again
      void dropGithubSession().then(() => {
        if (contents.isDestroyed()) return;
        if (entry && entries.get(tab) === entry) load(entry, from);
        else contents.loadURL(from).catch(() => {});
      });
    });
    contents.on('certificate-error', (event, url, _error, _certificate, callback) => {
      let trusted = false;
      try { trusted = isLoopback(new URL(url).hostname); } catch { trusted = false; }
      if (!trusted) return; // Chromium's own refusal stands
      event.preventDefault();
      callback(true);
    });
    contents.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault();
      const requestId = nextId('login');
      const timer = setTimeout(() => answerLogin(requestId, null), LOGIN_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      logins.set(requestId, (credentials) => { clearTimeout(timer); if (credentials) callback(credentials.username, credentials.password); else callback(); });
      const delivered = send('browser:login', { requestId, tab: tab || null, host: String(authInfo.host || ''), realm: String(authInfo.realm || ''), proxy: !!authInfo.isProxy });
      if (delivered === false) answerLogin(requestId, null);
    });
  }

  function answerLogin(requestId, credentials) {
    const answer = logins.get(requestId);
    if (!answer) return false;
    logins.delete(requestId);
    const ok = credentials && typeof credentials.username === 'string' && typeof credentials.password === 'string'
      && credentials.username.length <= 1024 && credentials.password.length <= 1024;
    answer(ok ? { username: credentials.username, password: credentials.password } : null);
    return true;
  }

  /** New windows keep their opener. With features it is a popup; otherwise a tab around the contents Chromium made. */
  function windowOpenHandler(from, contents) {
    return ({ url, disposition }) => {
      if (isGithubSignIn(url)) { void shell.openExternal(url).catch(() => {}); return { action: 'deny' }; }
      if (!allowed(url, contents)) return { action: 'deny' };
      if (disposition === 'new-window') {
        const parent = getWindow();
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: parent && !parent.isDestroyed() ? parent : undefined,
            minWidth: 320, minHeight: 320, // the size is the page's to ask for (window.open features)
            autoHideMenuBar: true, backgroundColor: '#ffffff', fullscreenable: false,
            webPreferences: { ...WEB_PREFERENCES, partition },
          },
        };
      }
      return { action: 'allow', createWindow: (options) => adopt(options, from) };
    };
  }

  // A popup has no address bar, so its title carries the host: the person can see who is asking.
  function watchPopup(popup, from) {
    popups.add(popup);
    const contents = popup.webContents;
    protect(contents, from);
    contents.setWindowOpenHandler(windowOpenHandler(from, contents));
    const title = () => {
      if (popup.isDestroyed()) return;
      let host = '';
      try { host = new URL(contents.getURL()).host; } catch { host = ''; }
      popup.setTitle([host, contents.getTitle()].filter(Boolean).join(' — '));
    };
    contents.on('page-title-updated', (event) => { event.preventDefault(); title(); });
    contents.on('did-navigate', title);
    contents.on('context-menu', (_event, params) => contextMenu(contents, params, null));
    popup.on('closed', () => popups.delete(popup));
  }

  function adopt(options, from) {
    const win = getWindow();
    const view = new WebContentsView({ webContents: options.webContents, webPreferences: { ...WEB_PREFERENCES, partition } });
    const id = nextId('tab');
    attach(id, view, win);
    send('browser:open-tab', { id, url: view.webContents.getURL(), from });
    return view.webContents;
  }

  function create(id) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('No window for the browser');
    configureSession();
    return attach(id, new WebContentsView({ webPreferences: { ...WEB_PREFERENCES, partition } }), win);
  }

  function attach(id, view, win) {
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    win.contentView.addChildView(view);
    onLayerChange();
    const entry = { view, error: null, requested: '', pending: '', seq: 0, found: '', drawn: false, download: '', retrying: false, quoteWait: null, selectionWaits: new Map(), sectionWaits: new Map(), editing: false, boxWait: null, boxes: null, boxCss: '', boxKey: null, boxDraw: Promise.resolve(), removed: null, boxView: { id: null }, boxHide: null, frameWaits: new Map(), cursor: '', cursorKey: null, cursorDraw: Promise.resolve(), offer: null };
    entries.set(id, entry);

    const contents = view.webContents;
    protect(contents, id);
    listenToPage(contents, id, entry);
    contents.setWindowOpenHandler(windowOpenHandler(id, contents));
    contents.on('did-create-window', (popup) => watchPopup(popup, id));
    // The page took the keyboard (a click in it, mostly): the renderer never sees a click in a native view, and ⌘T, ⌘W
    // and ⌘F go to the place clicked last (2026-10-16, renderer's model/key-side.js).
    contents.on('focus', () => send('browser:focused', { id }));
    // window.close() from the page (the last step of many sign-ins) closes the tab.
    contents.on('destroyed', () => { if (entries.get(id) === entry) { detach(id); send('browser:closed', { id }); } });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (code === ERR_ABORTED) return; // a cancelled load: did-stop-loading judges it, below
      entry.error = { code, description: String(description || ''), url: String(url || entry.requested) };
      entry.pending = '';
      emit(id);
    });
    contents.on('did-navigate', () => { entry.error = null; entry.pending = ''; entry.found = ''; entry.drawn = true; emit(id); });
    contents.on('did-stop-loading', () => {
      // The tab's first load stopped with no page and nothing else on the way (2026-10-04): cancelled (a 204, a sandbox
      // waking), it would leave the tab blank for good, with Chromium saying nothing. A pdf turned into a download is the
      // viewer's; a load another took the place of is still loading; once a page is there, a cancel is no failure.
      if (entry.requested && !entry.drawn && !entry.error && !entry.download && !entry.retrying && !contents.isLoading()) {
        entry.error = { code: ERR_ABORTED, description: 'The page did not load', url: entry.requested };
      }
      entry.pending = ''; // a stopped load is headed nowhere
    });
    for (const name of ['did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) contents.on(name, () => emit(id));
    contents.on('context-menu', (_event, params) => contextMenu(contents, params, id));
    contents.on('found-in-page', (_event, result) => send('browser:found', { id, matches: result.matches, active: result.activeMatchOrdinal }));
    // ⌘T and ⌘W are the pane's, as in Chrome, where a page cannot take them. ⌘F is the Edit menu's
    // (shortcut below), which a page that has its own find (Google Docs) gets to first.
    contents.on('before-input-event', (event, input) => {
      if (boxKey(id, entry, event, input)) return;
      if (selectionKey(id, entry, event, input)) return;
      if (input.type !== 'keyDown' || input.alt || !(process.platform === 'darwin' ? input.meta : input.control)) return;
      const key = String(input.key).toLowerCase();
      if (key === 'r') command(id, 'reload');
      else if (key === 'l') focusAddress();
      else if (key === '[') command(id, 'back');
      else if (key === ']') command(id, 'forward');
      else if (key === 'j') send('engelbart:next-workspace', {}); // the workspace's ⌘J, which a page in front would otherwise swallow
      else if (key === 't' && !input.shift) { focusApp(); send('browser:shortcut', { name: 'new-tab', tab: id }); }
      else if (key === 'w' && !input.shift) send('browser:shortcut', { name: 'close-tab', tab: id }); // ⇧⌘W is the window's
      // ⌘1–9 in a page: the Stage was clicked last (the page has the keyboard), so its tabs switch, as in Chrome.
      else if (/^[1-9]$/.test(key) && !input.shift) send('browser:shortcut', { name: `tab-${key}`, tab: id });
      else return;
      event.preventDefault();
    });
    return entry;
  }

  /**
   * The page's keys for boxes (MATH-70): ⌥ alone, held, lays the drawing layer over it (not while a text field has the
   * keyboard) and letting go takes it away; with a box selected, Backspace or Delete removes it and Esc lets it go; ⌘Z
   * puts back the box last removed. → whether the key was the boxes'.
   */
  function boxKey(id, entry, event, input) {
    const command = process.platform === 'darwin' ? input.meta : input.control;
    if (input.key === 'Alt') {
      if (input.type === 'keyDown' && !input.isAutoRepeat && !input.shift && !input.meta && !input.control && !entry.editing && canBox(id)) startBox(id, 'alt');
      else if (input.type === 'keyUp' && layer.tab === id && layer.mode === 'alt' && layer.view) layer.view.webContents.send(LAYER.CHANNELS.altUp);
      return false; // the page sees ⌥ as ever
    }
    if (input.type !== 'keyDown' || entry.editing) return false;
    const selected = selectedBox(entry);
    if (selected && (input.key === 'Backspace' || input.key === 'Delete') && !command && !input.alt && !input.shift) {
      event.preventDefault();
      void removeBox(id, selected);
      return true;
    }
    if (selected && input.key === 'Escape') { event.preventDefault(); entry.view.webContents.send(PAGE.CHANNELS.boxSelect, null); return true; }
    if (entry.removed && command && !input.shift && !input.alt && String(input.key).toLowerCase() === 'z') { event.preventDefault(); void undoBox(id); return true; }
    return false;
  }

  function focusApp() {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.focus();
  }

  /** Find in the page: a new query starts over, the same one steps. An empty one stops. */
  function find(id, text, options) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    const contents = entry.view.webContents;
    if (typeof text !== 'string' || text.length > FIND_MAX) throw new TypeError('Find text must be a bounded string');
    if (!text) { contents.stopFindInPage('clearSelection'); entry.found = ''; return true; }
    const forward = !(options && options.backward);
    contents.findInPage(text, { forward, findNext: entry.found !== text, matchCase: false });
    entry.found = text;
    return true;
  }

  /**
   * A guide's section on the page (2026-10-15; page-preload.cjs showSection): the words it starts with, or '' for none.
   * → whether the page found it, tinted it and scrolled to it (false: not found, no answer within SELECTION_TIMEOUT_MS,
   * or the tab gone), so Stage finds the words as ⌘F would only when the page could not.
   */
  function section(id, text, { timeoutMs = SELECTION_TIMEOUT_MS } = {}) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return Promise.resolve(false);
    if (typeof text !== 'string' || text.length > FIND_MAX) throw new TypeError('Section text must be a bounded string');
    const contents = entry.view.webContents;
    if (contents.isDestroyed()) return Promise.resolve(false);
    const nonce = nextId('section');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { entry.sectionWaits.delete(nonce); resolve(false); }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      entry.sectionWaits.set(nonce, (shown) => { clearTimeout(timer); entry.sectionWaits.delete(nonce); resolve(shown); });
      try { contents.send(PAGE.CHANNELS.section, { nonce, words: text }); } catch { entry.sectionWaits.get(nonce)(false); }
    });
  }

  function stopFind(id) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    entry.found = '';
    entry.view.webContents.stopFindInPage('keepSelection');
    return true;
  }

  /** The Edit menu's Find items: to the renderer, with the tab whose page has the keyboard (null: the app has it). */
  function shortcut(name) {
    let tab = null;
    for (const [id, entry] of entries) if (entry.view.getVisible() && entry.view.webContents.isFocused()) tab = id;
    if (tab && name === 'find') focusApp();
    send('browser:shortcut', { name, tab });
  }

  // A retry keeps the failure on screen until a page actually arrives (did-navigate clears it).
  function load(entry, href, keepError) {
    if (!keepError) entry.error = null;
    entry.download = '';
    entry.retrying = false;
    entry.requested = href;
    entry.pending = href;
    // A failed load is reported by did-fail-load; the promise says the same thing twice.
    entry.view.webContents.loadURL(href).catch(() => {});
  }

  function open(id, value) {
    assertId(id);
    const url = pageUrl(value);
    if (isGithubSignIn(url.href)) return shell.openExternal(url.href).then(() => true);
    if (url.protocol === 'file:' && pdfAddress(url.href)) openPdfFile(id, url);
    else load(entries.get(id) || create(id), url.href);
    return true;
  }

  /** One page shows at a time: placing a tab's view hides every other. */
  function show(id, rect) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    const win = getWindow();
    const bounds = boundsFrom(rect, win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1);
    for (const [other, item] of entries) {
      if (other !== id) { item.seq += 1; item.view.setVisible(false); item.offer = null; } // a tab left: its selection's card is not kept
    }
    entry.seq += 1;
    entry.view.setBounds(bounds);
    entry.view.setVisible(true);
    if (layer.tab && layer.tab !== id) endBox(false);
    else if (layer.tab === id && layer.view) layer.view.setBounds(bounds);
    if (card.tab && card.tab !== id) hideCard();
    onLayerChange();
    if ((entry.boxView && entry.boxView.id) || entry.offer) placeCard(id);
    return true;
  }

  async function capture(entry) {
    let timer;
    try {
      const image = await Promise.race([
        entry.view.webContents.capturePage(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), SNAPSHOT_TIMEOUT_MS); }),
      ]);
      if (!image || image.isEmpty()) return null;
      return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hides whatever shows. With `snapshot`, the page's picture comes back first, so the renderer
   *  can keep it on screen under a menu or a modal that the native view would have covered. */
  async function hide(options) {
    endBox(false);
    hideCard();
    let picture = null;
    for (const entry of entries.values()) {
      entry.offer = null; // a selection's card is not brought back: its highlight, if begun, is kept
      if (!entry.view.getVisible()) continue;
      const seq = entry.seq;
      if (options && options.snapshot) picture = await capture(entry);
      if (entry.seq === seq) entry.view.setVisible(false);
    }
    return picture;
  }

  function command(id, name) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) return false;
    const contents = entry.view.webContents;
    if (name === 'back') { if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); }
    else if (name === 'forward') { if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); }
    else if (name === 'reload') { if (entry.error) load(entry, entry.error.url || entry.requested, true); else contents.reload(); }
    else if (name === 'stop') contents.stop();
    else if (name === 'devtools') contents.openDevTools({ mode: 'detach' });
    else throw new TypeError('Unknown browser command');
    return true;
  }

  /**
   * The page a tab shows, written into `dir` as Chromium saves a complete page: index.html and its index_files folder
   * (the library's copy of a page, MATH-17). The page as it is now, signed in or not; a page still loading or that failed
   * to load is not saved. → { file, url, title }
   */
  async function savePage(id, dir) {
    assertId(id);
    const entry = entries.get(id);
    if (!entry) throw new Error('That tab is not open');
    const contents = entry.view.webContents;
    if (contents.isLoading()) throw new Error('The page is still loading');
    if (entry.error) throw new Error('The page did not load');
    const file = path.join(dir, 'index.html');
    let timer;
    try {
      await Promise.race([
        contents.savePage(file, 'HTMLComplete'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The page took too long to save')), SAVE_TIMEOUT_MS); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return { file, url: contents.getURL(), title: contents.getTitle() };
  }

  function detach(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    if (layer.tab === id) endBox(false);
    if (card.tab === id) hideCard();
    entries.delete(id);
    const win = getWindow();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
    } catch {
      // The window went first.
    }
    return entry;
  }

  function close(id) {
    assertId(id);
    const entry = detach(id);
    if (!entry) return false;
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    return true;
  }

  function closeAll() {
    for (const id of [...entries.keys()]) close(id);
    for (const popup of [...popups]) { if (!popup.isDestroyed()) popup.destroy(); }
    popups.clear();
    for (const requestId of [...logins.keys()]) answerLogin(requestId, null);
    if (layer.view) {
      const win = getWindow();
      try { if (win && !win.isDestroyed()) win.contentView.removeChildView(layer.view); } catch { /* the window went first */ }
      if (!layer.view.webContents.isDestroyed()) layer.view.webContents.close();
      layer.view = null;
      layer.ready = false;
    }
    if (card.view) {
      hideCard();
      const win = getWindow();
      try { if (win && !win.isDestroyed()) win.contentView.removeChildView(card.view); } catch { /* the window went first */ }
      if (!card.view.webContents.isDestroyed()) card.view.webContents.close();
      card.view = null;
      card.ready = false;
    }
  }

  /** Sign-ins are cookies; Chromium writes them lazily, so quitting asks for them now. */
  async function flush() {
    const browsing = session.fromPartition(partition);
    if (configured || sessions.has(browsing)) await browsing.cookies.flushStore(); // whichever window's tabs set it up
  }

  /** The window closed: its pages are gone, and the shared session no longer asks it about any. */
  function dispose() {
    closeAll();
    if (shared) shared.members.delete(member);
  }

  return { open, show, hide, command, find, section, stopFind, shortcut, savePage, close, closeAll, answerLogin, flush, dispose, has: (id) => entries.has(id), highlightSelection, pageSelection, screenshot, overleafTabs, readOverleaf, startBox, endBox, makeBox, removeBox, undoBox, canBox, resizeBox, setBoxAsks };
}

// Each handler is registered once and acts on the views of the window that called (`viewsFor(event)`, 2026-10-03).
// `cookieImport` (MATH-18, 2026-10-06) is the one importer for the whole app — the Stage's session is shared across
// windows — so its three handlers are not per-window. They carry domains and counts only, never cookie values (CK-07,
// CK-13): import-domains gives a domain and a count, import gives { imported, skipped, sessionOnly, checks }.
function registerBrowserIpc({ ipcMain, trustedHandler, viewsFor = null, views = null, cookieImport = null }) {
  const lookup = viewsFor || (() => views);
  const handle = (channel, call) => ipcMain.handle(channel, (event, ...args) => trustedHandler((...rest) => {
    const mine = lookup(event);
    if (!mine) throw new Error('No window for the browser');
    return call(mine, ...rest);
  })(event, ...args));
  handle('browser:open', (mine, id, url) => mine.open(id, url));
  handle('browser:show', (mine, id, rect) => mine.show(id, rect));
  handle('browser:hide', (mine, options) => mine.hide(options));
  handle('browser:command', (mine, id, name) => mine.command(id, name));
  handle('browser:find', (mine, id, text, options) => mine.find(id, text, options));
  handle('browser:stop-find', (mine, id) => mine.stopFind(id));
  handle('browser:section', (mine, id, text) => mine.section(id, text));
  handle('browser:close', (mine, id) => mine.close(id));
  handle('browser:login-reply', (mine, requestId, credentials) => mine.answerLogin(requestId, credentials));
  handle('browser:close-all', (mine) => { mine.closeAll(); return true; });
  handle('browser:box', (mine, id) => mine.startBox(id, 'button'));
  handle('browser:box-undo', (mine, id) => mine.undoBox(id));
  handle('browser:box-asks', (mine, list) => mine.setBoxAsks(list));

  if (cookieImport) {
    const text = (value, what) => { if (typeof value !== 'string' || !value || value.length > 256) throw new TypeError(`${what} must be a short string`); return value; };
    ipcMain.handle('browser:import-sources', trustedHandler(() => cookieImport.sources()));
    ipcMain.handle('browser:import-domains', trustedHandler((browser, profile) => cookieImport.domains(text(browser, 'A browser'), text(profile, 'A profile'))));
    ipcMain.handle('browser:import', trustedHandler((request) => {
      if (!request || typeof request !== 'object') throw new TypeError('An import needs a browser, a profile and domains');
      const domains = Array.isArray(request.domains) ? request.domains.slice(0, 500).map((d) => text(d, 'A domain')) : [];
      return cookieImport.import({ browser: text(request.browser, 'A browser'), profile: text(request.profile, 'A profile'), domains });
    }));
  }
}

module.exports = { PAGE_PRELOAD, BOX_LAYER_PRELOAD, BOX_CARD_PRELOAD, BOX_CARD_URL, CARD_W, CARD_HIDE_WHILE_SCROLLING, boxViewInput, selectionCardInput, boxResizeInput, boxAsksInput, cardAsks, MARK_CSS, SELECTION_TIMEOUT_MS, SHOT_MAX_EDGE, fileablePage, quoteInput, selectionInput, marksForPage, boxReplyInput, boxReportInput, PARTITION, DEV_PARTITION, stagePartition, parseBrowserUrl, parseFileUrl, externalScheme, isLoopback, cleanUserAgent, boundsFrom, pdfAddress, pdfAsDownload, pdfName, createBrowserViews, registerBrowserIpc };
