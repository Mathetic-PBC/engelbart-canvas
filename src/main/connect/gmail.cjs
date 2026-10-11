'use strict';

// Connect your library (2026-10-11): Gmail, read with the same Google sign-in as Google Drive. It is never brought in
// whole: the librarian searches it, lists the threads that match, and only the ones the person approves come in, one note
// a thread (./tools.cjs gmail_accounts, gmail_search, import_gmail_threads).
//
// What was checked on a live inbox (2026-10-11): a search lists each thread as a row holding
// <span data-thread-id="#thread-f:<decimal id>" data-legacy-thread-id="<hex id>">, before any thread is opened; the
// account's key is the page global GLOBALS[9] ("ik"), the same for that account in every browser; a whole thread as plain
// HTML is its print view, ?ik=<ik>&view=pt&search=all&permthid=thread-f:<decimal id>; and /mail/u/<n>/ is the account's
// place in that browser's sign-in order, which differs between browsers (never assume /u/0). Not checked: the print view's
// inner layout and where an account's address is best read, so both are read defensively here.

const THREAD_ID_RE = /^thread-f:\d{1,20}$/;
const IK_RE = /^[0-9a-z]{6,20}$/;
const MAX_ACCOUNTS = 6;
const MAX_SEARCH = 50;
const MAX_THREADS_A_CALL = 50;
const MAX_THREADS_A_SESSION = 300;
const ORIGIN = 'https://mail.google.com';

/** A Gmail account's place in the browser's sign-in order: a whole number 0–9, or an error. */
function accountIndex(n) {
  if (!Number.isInteger(n) || n < 0 || n > 9) throw new Error('n must be the account\'s number from gmail_accounts (0–9)');
  return n;
}

/** What a search adds for the session's period: newer_than:1y for a year, newer_than:6m for six months, '' for all time. */
function gmailPeriod(days) {
  if (!Number.isFinite(days) || days <= 0) return '';
  if (days === 365) return ' newer_than:1y';
  if (days === 182) return ' newer_than:6m';
  return ` newer_than:${Math.ceil(days)}d`;
}

const inboxUrl = (n) => `${ORIGIN}/mail/u/${accountIndex(n)}/`;
/** The search page for `query` (the period already added). */
const searchUrl = (n, query) => `${inboxUrl(n)}#search/${encodeURIComponent(query)}`;
/** A whole thread as plain HTML: its print view. */
function printUrl(n, ik, id) {
  if (!IK_RE.test(String(ik || ''))) throw new Error('ik must be the account key gmail_search returned');
  if (!THREAD_ID_RE.test(String(id || ''))) throw new Error('Not a Gmail thread id');
  return `${inboxUrl(n)}?ik=${ik}&view=pt&search=all&permthid=${id}`;
}

// The account a /mail/u/<n>/ page is signed in as: its address (the tab's title holds it once the inbox has drawn,
// "Inbox (3) - lee@example.edu - Gmail"; else the account button's label) and its key, GLOBALS[9].
const ACCOUNT_SCRIPT = `
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/;
const keyOf = () => { try { const g = window.GLOBALS; return g && typeof g[9] === 'string' ? g[9] : ''; } catch (e) { return ''; } };
const addressOf = () => {
  const inTitle = (document.title || '').match(EMAIL);
  if (inTitle) return inTitle[0];
  for (const el of document.querySelectorAll('[aria-label*="@"]')) {
    const label = el.getAttribute('aria-label') || '';
    const found = /Google Account/i.test(label) && label.match(EMAIL);
    if (found) return found[0];
  }
  return '';
};
const until = Date.now() + 20000;
while (Date.now() < until) {
  if (!/mail\\.google\\.com$/.test(location.hostname)) return { signedIn: false };
  const address = addressOf(), ik = keyOf();
  if (address && ik) return { signedIn: true, address, ik, path: location.pathname };
  await new Promise((resolve) => setTimeout(resolve, 500));
}
return { signedIn: /mail\\.google\\.com$/.test(location.hostname), address: addressOf(), ik: keyOf(), path: location.pathname };`;

// A search's rows, once drawn: wait (up to 25 s) until thread rows are shown and stop changing, or Gmail says nothing
// matched; then each shown row's thread id ("#" taken off), subject, people and date. Rows of a view Gmail keeps hidden
// (the inbox behind the search) are left out.
const SEARCH_SCRIPT = (limit) => `
const keyOf = () => { try { const g = window.GLOBALS; return g && typeof g[9] === 'string' ? g[9] : ''; } catch (e) { return ''; } };
const shown = (el) => (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.getClientRects().length > 0);
const spans = () => [...document.querySelectorAll('span[data-thread-id]')].filter(shown);
const none = () => /No messages matched your search|There are no conversations|No conversations/i.test((document.querySelector('[role="main"]') || document.body || {}).innerText || '');
const from = Date.now(), until = from + 25000;
let last = '';
while (Date.now() < until) {
  if (!/mail\\.google\\.com$/.test(location.hostname)) return { signedIn: false };
  const now = spans().map((el) => el.getAttribute('data-thread-id')).join(',');
  if (now && now === last && Date.now() - from > 1500) break; // a search opened over another may show the old rows a moment
  if (!now && none() && /^#search/.test(location.hash)) break;
  last = now;
  await new Promise((resolve) => setTimeout(resolve, 700));
}
const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim() : '');
const seen = new Set(), threads = [];
for (const span of spans()) {
  const id = String(span.getAttribute('data-thread-id') || '').replace(/^#/, '');
  if (!id || seen.has(id)) continue;
  seen.add(id);
  const row = span.closest('tr') || span.parentElement;
  const people = [];
  for (const el of row ? row.querySelectorAll('[email]') : []) {
    const name = (el.getAttribute('name') || text(el) || el.getAttribute('email') || '').trim();
    if (name && !people.includes(name)) people.push(name);
  }
  const dated = row && (row.querySelector('td.xW span[title], td.xW [title]') || [...row.querySelectorAll('span[title]')].pop());
  threads.push({ id, subject: text(span) || text(row && row.querySelector('.bog')), people: people.join(', '), date: dated ? dated.getAttribute('title') || text(dated) : '' });
  if (threads.length > ${limit}) break;
}
return { signedIn: true, ik: keyOf(), hash: location.hash, none: !threads.length && none(), threads };`;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(text) {
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    }
    return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : whole;
  });
}

/** HTML as plain text, its line breaks kept (br, paragraphs, rows, list items), links as Markdown links. */
function htmlText(html) {
  let value = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\b[^>]*\bhref\s*=\s*"(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (whole, href, inner) => {
      const label = decode(inner.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
      const url = decode(href);
      return !label || label === url ? url : `[${label}](${url})`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|ul|ol)>/gi, '\n')
    .replace(/<(p|div|tr|table|blockquote|hr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  value = decode(value).replace(/\r\n?/g, '\n');
  return value.split('\n').map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Earlier messages quoted in a reply (each is its own message in the thread already), innermost first.
function dropQuotes(html) {
  let value = String(html || '');
  for (let i = 0; i < 20; i += 1) {
    const next = value.replace(/<blockquote\b[^>]*>(?:(?!<blockquote\b)[\s\S])*?<\/blockquote>/gi, '');
    if (next === value) break;
    value = next;
  }
  return value;
}

const FILE_NAME_RE = /^[^<>\n/\\]{1,200}\.[A-Za-z0-9]{1,5}$/;

// The names of a message's attachments: Gmail's print view lists each in bold beside its size and View / Download links.
function attachmentsOf(html) {
  const names = [];
  const add = (name) => { const value = decode(name).replace(/\s+/g, ' ').trim(); if (FILE_NAME_RE.test(value) && !/^https?:/i.test(value) && !names.includes(value)) names.push(value); };
  for (const match of String(html || '').matchAll(/<b>([^<]{1,200})<\/b>(?:(?!<\/?b>)[\s\S]){0,400}?(?:attid=|view=att|disp=(?:safe|inline|attd)|\b\d+(?:\.\d+)?\s?[KMG]B?\b)/gi)) add(match[1]);
  for (const match of String(html || '').matchAll(/<a\b[^>]*href="[^"]*(?:attid=|view=att)[^"]*"[^>]*>([^<]{1,200})<\/a>/gi)) add(match[1]);
  return names;
}

const dateOf = (text) => { const time = Date.parse(String(text || '').replace(/\s+at\s+/i, ' ').replace(/\s+/g, ' ').trim()); return Number.isFinite(time) ? time : null; };

/**
 * A print view read into { subject, messages: [{ sender, date, text }], people, attachments }. A message is a table of
 * class "message" (its first cell the sender, the cell at its right the date); a page with none of them is kept as one
 * message of its whole text. Messages oldest first; quoted earlier messages left out of the replies.
 */
function readThread(html) {
  const source = String(html || '');
  const titled = (source.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
  const big = (source.match(/<font size=["']?\+1["']?>\s*<b>([\s\S]*?)<\/b>/i) || [])[1];
  const subject = htmlText(big || (titled || '').replace(/^\s*Gmail\s*-\s*/i, '')).replace(/\s+/g, ' ').trim();
  const starts = [...source.matchAll(/<table\b[^>]*class=["']?message\b[^>]*>/gi)].map((match) => match.index);
  const messages = [], attachments = [];
  for (let i = 0; i < starts.length; i += 1) {
    const part = source.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : source.length);
    const headEnd = part.search(/<\/tr>/i);
    const head = headEnd > 0 ? part.slice(0, headEnd) : '';
    const cells = [...head.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    const fromCell = cells.find((cell) => !/align=["']?right/i.test(cell[1])) || cells[0];
    const dateCell = cells.find((cell) => /align=["']?right/i.test(cell[1])) || cells[1];
    const named = fromCell ? (fromCell[2].match(/<b>([\s\S]*?)<\/b>/i) || [])[1] : '';
    const address = fromCell ? (decode(fromCell[2].replace(/<[^>]+>/g, ' ')).match(/<([^<>\s]+@[^<>\s]+)>/) || [])[1] : '';
    const sender = htmlText(named || '').replace(/\s+/g, ' ').trim() || address || htmlText(fromCell ? fromCell[2] : '').replace(/\s+/g, ' ').trim();
    const date = htmlText(dateCell ? dateCell[2] : '').replace(/\s+/g, ' ').trim();
    const rest = headEnd > 0 ? part.slice(headEnd) : part;
    const files = attachmentsOf(rest);
    for (const file of files) if (!attachments.includes(file)) attachments.push(file);
    let body = dropQuotes(rest).replace(/<(font|div|span|td)\b[^>]*class=["']?recipient[^>]*>[\s\S]*?<\/\1>/gi, '');
    // An attachment's name, size and View / Download links are not the message: its name is listed at the note's end.
    body = body.replace(/<a\b[^>]*href="[^"]*(?:attid=|view=att)[^"]*"[^>]*>[\s\S]*?<\/a>/gi, '');
    for (const file of files) body = body.split(`<b>${file}</b>`).map((piece, at) => (at ? piece.replace(/^(?:\s|<br\s*\/?>)*\d+(?:\.\d+)?\s?[KMG]B?\b/i, '') : piece)).join('');
    const text = htmlText(body).replace(/\n*On [^\n]{5,300} wrote:\s*$/, '').replace(/\n{3,}/g, '\n\n').trim();
    messages.push({ sender, date, text });
  }
  if (!messages.length) {
    const body = (source.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] || source;
    for (const file of attachmentsOf(body)) attachments.push(file);
    messages.push({ sender: '', date: '', text: htmlText(dropQuotes(body)) });
  }
  const times = messages.map((message) => dateOf(message.date));
  if (times.every((time) => time !== null)) messages.sort((a, b) => dateOf(a.date) - dateOf(b.date));
  const people = [...new Set(messages.map((message) => message.sender).filter(Boolean))];
  return { subject, messages, people, attachments };
}

/** Whether a downloaded print view is Google's sign-in page in its place. */
function gmailSignedOut(html) {
  const head = String(html || '').slice(0, 20000);
  if (/<table\b[^>]*class=["']?message\b/i.test(head)) return false;
  return /ServiceLogin|accounts\.google\.com\/(?:v3\/)?signin|identifierId|Sign in - Google Accounts|<title>[^<]*Sign in/i.test(head);
}

/** A thread as the note that keeps it: a header (Gmail, its dates, its people), then each message, then its attachments' names. */
function gmailThreadNote(thread) {
  const dates = thread.messages.map((message) => message.date).filter(Boolean);
  const span = dates.length ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]}–${dates[dates.length - 1]}`) : '';
  const head = ['Gmail', span, thread.people.join(', ')].filter(Boolean).join(' · ');
  const parts = [`*${head}*`];
  for (const message of thread.messages) {
    const by = [message.sender ? `**${message.sender}**` : '', message.date].filter(Boolean).join(', ');
    parts.push([by, message.text].filter(Boolean).join('\n\n'));
  }
  if (thread.attachments.length) parts.push(`Attachments (not brought in): ${thread.attachments.join(', ')}`);
  return `${parts.filter(Boolean).join('\n\n')}\n`;
}

module.exports = {
  THREAD_ID_RE, IK_RE, MAX_ACCOUNTS, MAX_SEARCH, MAX_THREADS_A_CALL, MAX_THREADS_A_SESSION,
  accountIndex, gmailPeriod, inboxUrl, searchUrl, printUrl, ACCOUNT_SCRIPT, SEARCH_SCRIPT, htmlText, readThread, gmailSignedOut, gmailThreadNote,
};
