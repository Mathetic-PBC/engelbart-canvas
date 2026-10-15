'use strict';

// Connect your library (2026-10-07, second build): the agents' browser. "Instead of telling me to do stuff, it must use
// computer use to do all this stuff for me" and "Ensure all of the computer use is in the background" (the Onboarding
// brainstorm note): an import agent works in a real Chromium window of Engelbart's that is never shown, one per agent,
// on the Stage's own session (the sign-ins the person made in Engelbart's browser, or brought over from Chrome), so it
// opens ChatGPT, Google Drive or Overleaf, reads, clicks, types and downloads as a person would, while the person goes on
// with their own work: nothing takes over the screen, so macOS's Accessibility and Screen Recording are never needed.
//
// Limits, kept here rather than left to the model:
//   · sites: an agent's window opens only the hosts of the apps its job covers (connect-sources `sites`) and the sign-in
//     pages they send it through (SIGN_IN_SITES); a link, a redirect or a new window anywhere else is refused, and said in
//     the action log. https only (plain http only for a loopback host named outright, for tests).
//   · passwords: it never reads a password field's value, and the prompt tells it never to type one. A page that wants a
//     sign-in, a code or a password is shown to the person (show: "Needs you"), who does it in that same window; while it
//     is shown the person goes where they like, and hiding it hands it back.
//   · read-only (2026-10-15): an agent's clicks, typing and keys are held to reading (clickRefusal, typeRefusal,
//     pressRefusal), and no page that signs out is opened. A script of its own never runs in a page: evaluate() is for
//     Engelbart's fixed readers (./web-chats.cjs, ./gmail.cjs), never an agent's tool.
//   · every step is told to `log` (the visible action log) in the person's words, never what came back.
// `headless` (ENGELBART_HEADLESS, the smoke runs): show() does nothing, so no window ever appears.

const fs = require('node:fs');
const path = require('node:path');
const { SIGN_IN_SITES } = require('../../shared/connect-sources.cjs');

const VIEW = { width: 1280, height: 900 };
const LOAD_TIMEOUT_MS = 45_000;
const EVAL_TIMEOUT_MS = 60_000;
const MAX_WAIT_S = 120;
const MAX_ELEMENTS = 250;
const MAX_TEXT = 60_000;
const MAX_RESULT = 120_000;
const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const SHOT_EDGE = 1280;
const KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End', 'Space']);

const hostOf = (value) => { try { return new URL(String(value)).hostname.toLowerCase(); } catch { return ''; } };
const isLoopback = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
const quote = (text, max = 48) => { const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

/** Whether `url` may be opened by an agent whose job allows `hosts` (exact hosts or their subdomains). */
function hostAllowed(url, hosts) {
  if (url === 'about:blank') return true;
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:') { if (!isLoopback(host)) return false; } else if (parsed.protocol !== 'https:') return false;
  return (hosts || []).some((allowed) => { const h = String(allowed).toLowerCase(); return host === h || host.endsWith(`.${h}`); });
}

/** The hosts a job's window may open: its apps' sites, and the sign-in pages they send people through. */
function hostsFor(sites) {
  return [...new Set([...(sites || []), ...SIGN_IN_SITES].map((host) => String(host).toLowerCase()).filter(Boolean))];
}

// What browser_read sees: the page's text and its controls, each given a ref (data-eb-ref) to click or type into. Run in
// the page's main world (the ref attribute is on the shared DOM). A password field's value is never read.
const READ_SCRIPT = (offset, max) => `(() => {
  const SEL = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],[role=row],[role=treeitem],[role=gridcell],[role=checkbox],[role=radio],[role=switch],[role=textbox],[role=combobox],[contenteditable=""],[contenteditable=true],[data-id]';
  const root = document.documentElement;
  let next = Number(root.getAttribute('data-eb-next') || '0');
  const clean = (value, n) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const out = [];
  for (const el of document.querySelectorAll(SEL)) {
    if (out.length >= ${MAX_ELEMENTS}) break;
    if (!el.getClientRects().length) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    let ref = el.getAttribute('data-eb-ref');
    if (!ref) { next += 1; ref = 'e' + next; el.setAttribute('data-eb-ref', ref); }
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || tag === 'summary' ? 'button' : tag === 'input' ? (el.type || 'text') : tag === 'textarea' ? 'textbox' : tag === 'select' ? 'select' : el.isContentEditable ? 'editor' : tag);
    const labelled = el.getAttribute('aria-labelledby') ? clean(el.getAttribute('aria-labelledby').split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' '), 160) : '';
    const name = clean(el.getAttribute('aria-label') || labelled || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || (tag === 'input' ? '' : el.innerText) || el.getAttribute('name') || '', 160);
    const row = { ref, role, name };
    if (tag === 'a' && el.href && !/^javascript:/i.test(el.href)) row.href = el.href.slice(0, 400);
    const id = el.getAttribute('data-id');
    if (id) row.id = id.slice(0, 200);
    if ((tag === 'input' || tag === 'textarea') && el.type !== 'password' && el.value) row.value = String(el.value).slice(0, 200);
    if (el.type === 'password') row.password = true;
    const checked = el.getAttribute('aria-checked') || el.getAttribute('aria-selected') || (el.checked ? 'true' : '');
    if (checked) row.checked = checked;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') row.disabled = true;
    if (!row.name && !row.href && !row.id && !row.value) continue;
    out.push(row);
  }
  root.setAttribute('data-eb-next', String(next));
  const text = (document.body ? document.body.innerText : '') || '';
  return { url: location.href, title: document.title, text: text.slice(${offset}, ${offset + max}), textTotal: text.length, elements: out };
})()`;

// What a control is, for the read-only rules below (readOnly): the control `ref` names, or the one that has the focus when
// `ref` is null (what a key goes to). `spot` also scrolls it into view and says where its middle is, to click.
const INFO_SCRIPT = (ref, spot = false) => `(() => {
  const el = ${ref == null ? 'document.activeElement' : `document.querySelector('[data-eb-ref=${JSON.stringify(String(ref))}]')`};
  if (!el) return null;
  const clean = (value, n) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const tag = el.tagName.toLowerCase();
  const role = (el.getAttribute('role') || '').toLowerCase();
  const labelled = el.getAttribute('aria-labelledby') ? el.getAttribute('aria-labelledby').split(/\\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ') : '';
  const name = clean(el.getAttribute('aria-label') || labelled || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || (tag === 'input' ? el.value : el.innerText) || el.getAttribute('name') || '', 120);
  const words = [el.getAttribute('aria-label'), labelled, el.getAttribute('placeholder'), el.getAttribute('aria-placeholder'), el.getAttribute('name'), el.id, el.getAttribute('title')].join(' ');
  const form = el.form || el.closest('form');
  const formSearch = !!(form && (form.getAttribute('role') === 'search' || form.querySelector('input[type=search],[role=searchbox]') || /search|[?&]q=/i.test(form.getAttribute('action') || '')));
  const search = el.type === 'search' || role === 'searchbox' || !!el.closest('[role=search],search') || /search|find|filter|query|look ?up|jump to/i.test(words) || formSearch;
  const href = tag === 'a' && el.href && !/^javascript:/i.test(el.href) && !/#$/.test(el.getAttribute('href') || '') ? el.href.slice(0, 400) : '';
  const out = { tag, role, type: String(el.type || '').toLowerCase(), name, href, editable: !!el.isContentEditable, search, form: !!form, formSearch, submit: (tag === 'button' && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit' && !!form) || (tag === 'input' && /^(submit|image)$/i.test(el.type || '')) };
  if (${spot ? 'true' : 'false'}) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    out.x = Math.round(r.left + r.width / 2);
    out.y = Math.round(r.top + r.height / 2);
  }
  return out;
})()`;

// Read-only (From Amitav, 2026-10-15: "ensure agents cant fuck w their shit, but if they poke around and read that is fine"):
// an agent in Engelbart's browser opens, reads, scrolls and searches; it never changes anything in the person's accounts.
// That is held here, in code, whatever the model decides: a click on a control that would change something (by its name:
// Delete, Share, Send, Rename, Move, Save…), a switch, a checkbox or a form's submit is refused; text goes only into a search
// box (never a composer, a document or a form); Enter and Space only where they search, open or read; Delete and
// Backspace only in a search box; and no page that signs out is opened. Links that go somewhere are reading.
const CHANGES_RE = /\b(?:delete|remove|trash|bin|discard|archive|unarchive|send|reply|forward|share|unshare|publish|unpublish|post|comment|submit|save|rename|move|edit|create|new|add|upload|import|duplicate|copy|clone|make a copy|restore|empty|clear|reset|change|update|apply|confirm|approve|accept|decline|reject|invite|leave|join|subscribe|unsubscribe|follow|unfollow|block|report|mute|pin|unpin|star|unstar|favou?rite|bookmark|like|vote|rate|install|uninstall|enable|disable|turn on|turn off|connect|disconnect|revoke|grant|allow|deny|transfer|pay|buy|purchase|checkout|upgrade|downgrade|cancel|regenerate|retry|branch|fork|lock|unlock|mark|label|snooze|draft|compose|write|schedule|record|start|stop|download|export|print|sync|request|verify|log ?out|sign ?out|log ?off|sign ?off)\b/i;
const SIGN_OUT_RE = /(?:log|sign)[-_ ]?(?:out|off)\b|logout|signout|logoff/i;
const CHOOSES_ROLES = new Set(['switch', 'checkbox', 'radio', 'menuitemcheckbox', 'menuitemradio', 'slider', 'spinbutton']);
const ACTION_ROLES = new Set(['button', 'menuitem']);
const TEXT_TYPES = new Set(['', 'text', 'search']);

/** Whether `url` is a page that signs the person out (its path or query says so). */
function signsOut(url) {
  try { const parsed = new URL(String(url)); return SIGN_OUT_RE.test(decodeURIComponent(`${parsed.pathname}${parsed.search}`)); } catch { return false; }
}

const isAction = (info) => info.tag === 'button' || ACTION_ROLES.has(info.role) || (info.tag === 'input' && /^(submit|button|reset|image)$/.test(info.type)) || (info.tag === 'a' && !info.href);
const isField = (info) => info.editable || info.tag === 'textarea' || (info.tag === 'input' && !/^(submit|button|reset|image|checkbox|radio|file|hidden|range|color)$/.test(info.type)) || ['textbox', 'searchbox', 'combobox'].includes(info.role);

/** Why a click on the control `info` describes is refused (it could change something), or null when it only reads. */
function clickRefusal(info) {
  if (!info) return null;
  const quoted = info.name ? `“${quote(info.name, 40)}”` : 'That control';
  if (SIGN_OUT_RE.test(info.name) || (info.href && signsOut(info.href))) return `${quoted} signs out`;
  if (info.tag === 'select' || CHOOSES_ROLES.has(info.role) || (info.tag === 'input' && /^(checkbox|radio|file|range|color)$/.test(info.type))) return `${quoted} changes a setting, a selection or a file`;
  if (!isAction(info)) return null;
  if (!info.name) return 'A control with no name could change something';
  if (CHANGES_RE.test(info.name)) return `${quoted} could change something in the account`;
  if (info.submit && !info.formSearch) return `${quoted} sends a form`;
  return null;
}

/** Why typing into the control `info` describes is refused (only a search box takes text), or null. */
function typeRefusal(info) {
  if (!info) return null;
  if (info.type === 'password') return 'That is a password field: call needs_you so the person signs in themselves';
  if (info.editable) return 'That is an editor (a message, a document): agents only type into search boxes';
  if (!isField(info)) return 'That control does not take text';
  if (info.tag === 'input' && !TEXT_TYPES.has(info.type)) return 'Agents only type into search boxes';
  if (!info.search) return `${info.name ? `“${quote(info.name, 40)}”` : 'That field'} is not a search box: agents only type into search boxes`;
  return null;
}

/** Why pressing `key` where the focus is (`info`, the focused control, null for the page) is refused, or null. */
function pressRefusal(key, info) {
  const inSearch = !!info && isField(info) && !typeRefusal(info);
  if (key === 'Delete' || key === 'Backspace') return inSearch ? null : `${key} could delete something: it is only pressed in a search box`;
  if (key !== 'Enter' && key !== 'Space') return null;
  if (!info) return null;
  if (isField(info)) return inSearch || (key === 'Space' && !info.editable && info.tag !== 'textarea' && info.role !== 'textbox') ? null : `${key} there would send or write something: it is only pressed in a search box`;
  return clickRefusal(info);
}

// Text typed into a field: an input's value set as typing sets it (React and the like follow), an editor's
// (contenteditable: ChatGPT's and Claude's composers) through the editing commands a person's typing uses.
const TYPE_SCRIPT = (ref, text, replace) => `(() => {
  const el = document.querySelector('[data-eb-ref=${JSON.stringify(String(ref))}]');
  if (!el) return { error: 'gone' };
  if (el.type === 'password') return { error: 'password' };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  const text = ${JSON.stringify(String(text))};
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
    set.call(el, ${replace ? 'text' : '(el.value || "") + text'});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { kind: 'field', name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '').slice(0, 60) };
  }
  if (el.isContentEditable) {
    if (${replace ? 'true' : 'false'}) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    else { const range = document.createRange(); range.selectNodeContents(el); range.collapse(false); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    const ok = document.execCommand('insertText', false, text);
    return { kind: 'editor', ok, name: (el.getAttribute('aria-label') || el.getAttribute('data-placeholder') || '').slice(0, 60) };
  }
  return { error: 'not a field' };
})()`;

const SCROLL_SCRIPT = (ref, dy) => `(() => {
  const el = ${ref ? `document.querySelector('[data-eb-ref=${JSON.stringify(String(ref))}]')` : 'null'};
  const target = el || document.scrollingElement || document.documentElement;
  target.scrollBy({ top: ${Number(dy) || 0}, behavior: 'instant' });
  return { top: Math.round(target.scrollTop), height: Math.round(target.scrollHeight), view: Math.round(target.clientHeight || innerHeight) };
})()`;

const TEXT_SCRIPT = '(document.body ? document.body.innerText : "")';

/** A file name from a response's content-disposition, else the address's last part, made safe. */
function fileNameOf(response, url, fallback = 'download') {
  const disposition = response && response.headers ? String(response.headers.get('content-disposition') || '') : '';
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  let name = '';
  try { name = star ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) : plain ? plain[1].trim() : decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || ''); } catch { name = ''; }
  name = name.replace(/[/\\:\0]/g, '-').replace(/^\.+/, '').trim().slice(0, 120);
  return name || fallback;
}

/** A path in `dir` for `name` that is not taken: name, name-2, … */
function freePath(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length) || 'download';
  for (let n = 1; n < 1000; n += 1) {
    const file = path.join(dir, n === 1 ? `${base}${ext}` : `${base}-${n}${ext}`);
    if (!fs.existsSync(file)) return file;
  }
  throw new Error('No free name for the download');
}

const withTimeout = (promise, ms, what) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} seconds`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * `BrowserWindow` (Electron's), `getSession()` the Stage's browsing session (its cookies are the sign-ins), `userAgent(ua)`
 * the agent's (the Stage's own, without "Electron"), `log(jobId, text)` the action log, `onClosed(jobId)` when the person
 * closes a window shown to them. → { tools(job), show, hide, close, closeAll, has }
 */
function createAgentBrowser({ BrowserWindow, getSession, userAgent = (ua) => ua, log = () => {}, onClosed = () => {}, headless = false }) {
  const windows = new Map(); // job id → { win, hosts, showing }

  function entryOf(job) {
    let entry = windows.get(job.id);
    if (entry && !entry.win.isDestroyed()) return entry;
    const browsing = getSession();
    const win = new BrowserWindow({
      show: false, width: VIEW.width, height: VIEW.height, title: `Engelbart · ${job.label || 'agent'}`, autoHideMenuBar: true,
      webPreferences: { session: browsing, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    const wc = win.webContents;
    try { wc.setUserAgent(userAgent(wc.getUserAgent())); } catch { /* the session's own */ }
    entry = { win, hosts: hostsFor(job.sites), showing: false };
    windows.set(job.id, entry);
    // Where the page may take itself: the job's hosts while an agent drives it, anywhere on https while the person does.
    const guard = (event, url) => {
      if (entry.showing ? /^(https:|about:blank)/i.test(url) : hostAllowed(url, entry.hosts) && !signsOut(url)) return;
      event.preventDefault();
      log(job.id, signsOut(url) ? `Didn't open ${hostOf(url)}'s sign-out page` : `Kept away from ${hostOf(url) || 'a page'} (not one of ${job.label || 'this app'}'s sites)`);
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    // A new window: while the person signs in, a real popup (OAuth and "Sign in with Google" talk back to their opener);
    // while an agent drives, the page in this same window when it is one of the job's sites, else nothing.
    wc.setWindowOpenHandler(({ url }) => {
      if (entry.showing && /^https:/i.test(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { session: browsing, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
      if (!entry.showing && hostAllowed(url, entry.hosts)) setImmediate(() => { if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {}); });
      else log(job.id, `Kept a new window for ${hostOf(url) || 'a page'} from opening`);
      return { action: 'deny' };
    });
    // Closed by the person while shown: hidden again and handed back, never destroyed under the agent.
    win.on('close', (event) => {
      if (entry.closing) return;
      event.preventDefault();
      if (entry.showing) { entry.showing = false; win.hide(); onClosed(job.id); }
    });
    return entry;
  }

  /** A step refused as it could change the person's account: said in the action log, and to the agent. */
  const refuse = (job, why) => {
    log(job.id, `Didn't: ${why}`);
    return Object.assign(new Error(`Refused: ${why}. Engelbart's agents only open, read, scroll and search; nothing in the person's accounts is changed.`), { code: 'READ_ONLY' });
  };

  const wcOf = (job) => entryOf(job).win.webContents;
  const run = (job, code, ms = EVAL_TIMEOUT_MS) => withTimeout(wcOf(job).executeJavaScript(code, true), ms, 'The page');

  async function open(job, url) {
    const entry = entryOf(job);
    if (!hostAllowed(url, entry.hosts)) throw new Error(`${hostOf(url) || url} is not one of the sites this import may open (${(job.sites || []).join(', ') || 'none'})`);
    if (signsOut(url)) throw refuse(job, 'that page signs out');
    log(job.id, `Opened ${hostOf(url)}`);
    const wc = entry.win.webContents;
    await withTimeout(wc.loadURL(url).catch((error) => { if (!/ERR_ABORTED/.test(String(error && error.message))) throw error; }), LOAD_TIMEOUT_MS, 'Loading the page').catch((error) => { if (!/longer than/.test(error.message)) throw error; });
    await sleep(600); // pages that draw themselves after load
    return { url: wc.getURL(), title: wc.getTitle() };
  }

  /** The page an app starts on, opened when the window is somewhere else (or nowhere yet). */
  async function ensure(job, url) {
    const wc = wcOf(job);
    const here = wc.getURL();
    if (here && hostOf(here) === hostOf(url)) return { url: here, title: wc.getTitle() };
    return open(job, url);
  }

  async function read(job, { offset = 0, maxChars = 8000 } = {}) {
    const max = Math.min(Math.max(500, Math.round(maxChars) || 8000), MAX_TEXT);
    const out = await run(job, READ_SCRIPT(Math.max(0, Math.round(offset) || 0), max));
    log(job.id, `Read ${hostOf(out.url) || 'the page'}${out.title ? ` (${quote(out.title, 40)})` : ''}`);
    return out;
  }

  async function click(job, ref) {
    const spot = await run(job, INFO_SCRIPT(ref, true));
    if (!spot) throw new Error(`No control ${ref} on the page now: browser_read again`);
    const why = clickRefusal(spot);
    if (why) throw refuse(job, why);
    const wc = wcOf(job);
    wc.sendInputEvent({ type: 'mouseMove', x: spot.x, y: spot.y });
    wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: spot.x, y: spot.y });
    wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: spot.x, y: spot.y });
    log(job.id, `Clicked ${spot.name ? `“${quote(spot.name, 40)}”` : 'a control'}`);
    await sleep(700);
    return { url: wc.getURL(), title: wc.getTitle() };
  }

  async function type(job, ref, text, { submit = false, replace = false } = {}) {
    const field = await run(job, INFO_SCRIPT(ref));
    if (!field) throw new Error(`No control ${ref} on the page now: browser_read again`);
    const why = typeRefusal(field);
    if (why && field.type === 'password') throw new Error(why);
    if (why) throw refuse(job, why);
    const out = await run(job, TYPE_SCRIPT(ref, text, replace));
    if (out && out.error === 'password') throw new Error('That is a password field: call needs_you so the person signs in themselves');
    if (out && out.error) throw new Error(out.error === 'gone' ? `No control ${ref} on the page now: browser_read again` : 'That control does not take text');
    log(job.id, `Typed into ${out && out.name ? `“${quote(out.name, 40)}”` : 'a field'}`);
    if (submit) await press(job, 'Enter', { quiet: true });
    return { typed: String(text).length, submitted: !!submit };
  }

  async function press(job, key, { quiet = false } = {}) {
    if (!KEYS.has(key)) throw new Error(`key must be one of ${[...KEYS].join(', ')}`);
    const why = pressRefusal(key, await run(job, INFO_SCRIPT(null)).catch(() => null));
    if (why) throw refuse(job, why);
    const wc = wcOf(job);
    const code = key === 'Space' ? ' ' : key;
    wc.sendInputEvent({ type: 'keyDown', keyCode: code });
    if (key === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' });
    wc.sendInputEvent({ type: 'keyUp', keyCode: code });
    if (!quiet) log(job.id, `Pressed ${key}`);
    await sleep(500);
    return { url: wc.getURL() };
  }

  async function scroll(job, { ref = '', direction = 'down', amount = 0 } = {}) {
    const step = Math.round(Number(amount) || 800) * (direction === 'up' ? -1 : 1);
    const out = await run(job, SCROLL_SCRIPT(ref, step));
    await sleep(500);
    return out;
  }

  /** Waits for the page: some words to appear (untilText), to go (untilGone), or its text to stop changing (stable). */
  async function wait(job, { seconds = 5, untilText = '', untilGone = '', stable = false } = {}) {
    const limit = Math.min(Math.max(1, Number(seconds) || 5), MAX_WAIT_S) * 1000;
    const started = Date.now();
    let last = null, still = 0;
    while (Date.now() - started < limit) {
      const text = String(await run(job, TEXT_SCRIPT).catch(() => ''));
      if (untilText && text.includes(untilText)) return { done: true, after: Math.round((Date.now() - started) / 1000) };
      if (untilGone && !text.includes(untilGone)) return { done: true, after: Math.round((Date.now() - started) / 1000) };
      if (stable) { still = text === last ? still + 1 : 0; last = text; if (still >= 6) return { done: true, after: Math.round((Date.now() - started) / 1000) }; }
      if (!untilText && !untilGone && !stable) { await sleep(limit); return { done: true }; }
      await sleep(500);
    }
    return { done: false, after: Math.round(limit / 1000) };
  }

  async function screenshot(job) {
    const wc = wcOf(job);
    let image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const size = image.getSize();
    if (size.width > SHOT_EDGE) image = image.resize({ width: SHOT_EDGE });
    log(job.id, `Looked at ${hostOf(wc.getURL()) || 'the page'}`);
    return { data: image.toJPEG(70).toString('base64'), mimeType: 'image/jpeg' };
  }

  async function evaluate(job, script) {
    const wc = wcOf(job);
    if (!hostAllowed(wc.getURL(), entryOf(job).hosts)) throw new Error('Open one of this app\'s pages first');
    const value = await run(job, `(async () => {\n${script}\n})()`);
    log(job.id, `Ran a script on ${hostOf(wc.getURL())}`);
    let text;
    try { text = JSON.stringify(value === undefined ? null : value); } catch { text = String(value); }
    return text.length > MAX_RESULT ? { truncated: true, json: text.slice(0, MAX_RESULT) } : JSON.parse(text);
  }

  /**
   * A file fetched with the session's sign-ins (not through the page), saved in `dir` → { path, bytes, type, url }, `url`
   * the address it came from after any redirects (a sign-in page sent in its place answers from another host).
   */
  async function download(job, url, dir, { name = '', maxBytes = MAX_DOWNLOAD_BYTES, quiet = false } = {}) {
    if (!hostAllowed(url, hostsFor(job.sites))) throw new Error(`${hostOf(url) || url} is not one of the sites this import may open`);
    if (signsOut(url)) throw refuse(job, 'that address signs out');
    const response = await withTimeout(getSession().fetch(url, { redirect: 'follow' }), 180_000, 'The download');
    if (!response.ok) throw new Error(`${hostOf(url)} answered ${response.status}`);
    const length = Number(response.headers.get('content-length')) || 0;
    if (length > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = freePath(dir, String(name || '').replace(/[/\\:\0]/g, '-').trim() || fileNameOf(response, url));
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    if (!quiet) log(job.id, `Downloaded ${path.basename(file)}`);
    return { path: file, bytes: bytes.length, type: String(response.headers.get('content-type') || '').split(';')[0], url: response.url || url };
  }

  function show(jobId, { title = '' } = {}) {
    const entry = windows.get(jobId);
    if (!entry || entry.win.isDestroyed() || headless) return false;
    entry.showing = true;
    if (title) entry.win.setTitle(title);
    entry.win.center();
    entry.win.show();
    entry.win.focus();
    return true;
  }

  function hide(jobId) {
    const entry = windows.get(jobId);
    if (!entry || entry.win.isDestroyed()) return;
    entry.showing = false;
    entry.win.hide();
  }

  function close(jobId) {
    const entry = windows.get(jobId);
    windows.delete(jobId);
    if (entry && !entry.win.isDestroyed()) { entry.closing = true; entry.win.destroy(); }
  }

  return {
    tools: (job) => ({
      open: (url) => open(job, url), ensure: (url) => ensure(job, url), read: (options) => read(job, options), click: (ref) => click(job, ref),
      type: (ref, text, options) => type(job, ref, text, options), press: (key) => press(job, key), scroll: (options) => scroll(job, options),
      wait: (options) => wait(job, options), screenshot: () => screenshot(job), evaluate: (script) => evaluate(job, script),
      download: (url, dir, options) => download(job, url, dir, options), url: () => (windows.has(job.id) ? wcOf(job).getURL() : ''),
    }),
    show, hide, close,
    closeAll: () => { for (const id of [...windows.keys()]) close(id); },
    has: (jobId) => windows.has(jobId) && !windows.get(jobId).win.isDestroyed(),
  };
}

module.exports = { createAgentBrowser, hostAllowed, hostsFor, fileNameOf, freePath, READ_SCRIPT, INFO_SCRIPT, KEYS, clickRefusal, typeRefusal, pressRefusal, signsOut };
