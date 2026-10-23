'use strict';
// A link's target (2026-09-30, @discover's guide; renderer/model/stage.js splitTarget): the address, and the passage to
// find there, from a `#find=` fragment of percent-encoded words (`https://arxiv.org/pdf/2312.10893#find=We%20argue%20that`),
// and where its section ends, from `&to=` (round 2: the first words of the section after it). Shared since 2026-10-21, as
// main checks Chat's citations by it (../main/bart/cite.cjs): a citation is the same link with `&cite=you|other|source`
// (whose words they are: the person's, someone else's, a paper's or page's) and, for one that cuts against the answer,
// `&counter=1`. Those two may come before or after `find` and `to`, in any order. A citation without `find` (`#cite=source`,
// 2026-10-22) cites the source as a whole: what a document is about, said by no one sentence of it. A citation of the
// person's note on a highlight (2026-10-23) carries the note's words in `&note=`, before `cite`, and in `find` the
// highlighted passage it is on, where the paper opens ('' for a note on no passage). A note's page goes in `&page=`
// (before `note`): the paper opens there at once, not once every page's text is known.

const CITES = new Set(['you', 'other', 'source']);
const TAIL_RE = /&(to|page|note|cite|counter)=([^&]*)$/;
const HEAD_RE = /^(to|page|note|cite|counter)=([^&]*)&/;

const words = (value) => {
  let out;
  try { out = decodeURIComponent(value || ''); } catch { out = value || ''; }
  return out.replace(/\s+/g, ' ').trim();
};

// The fragment's keys around `find=`, each once: { find, to, cite, counter } with their raw values, or null.
function fragmentParts(fragment) {
  if (!/(?:^|&)find=/.test(fragment)) return wholeParts(fragment);
  let rest = fragment;
  const keys = {};
  let lead = false;
  for (let m = rest.match(HEAD_RE); m && !rest.startsWith('find='); m = rest.match(HEAD_RE)) {
    if (m[1] in keys) return null;
    keys[m[1]] = m[2];
    rest = rest.slice(m[0].length);
    lead = true;
  }
  if (!rest.startsWith('find=')) return null;
  for (let m = rest.match(TAIL_RE); m; m = rest.match(TAIL_RE)) {
    if (m[1] in keys) break;
    keys[m[1]] = m[2];
    rest = rest.slice(0, m.index);
  }
  const cited = 'cite' in keys || 'counter' in keys;
  // Before citations a fragment that did not begin with find= was the address's, and one with `&to=` took the last `&to=`
  // only (`find=a&to=b&c` is all find): without `cite` or `counter` it is read exactly as it was.
  if (!cited) {
    if (lead) return null;
    const m = fragment.match(/^find=([\s\S]*?)&to=([^&]*)$/) || fragment.match(/^find=([\s\S]*)$/);
    return m ? { find: m[1], to: m[2] || '' } : null;
  }
  return { find: rest.slice('find='.length), ...keys };
}

// A whole source's fragment: `cite=` and perhaps `page=`, `note=` and `counter=`, each once, and nothing else → { find: '', cite, … }, or null.
function wholeParts(fragment) {
  const keys = {};
  for (const pair of fragment.split('&')) {
    const m = pair.match(/^(page|note|cite|counter)=([^&]*)$/);
    if (!m || m[1] in keys) return null;
    keys[m[1]] = m[2];
  }
  return 'cite' in keys ? { find: '', ...keys } : null;
}

/**
 * → { address, find, to }, and `cite` ('you' | 'other' | 'source') and `counter` (true) when the link is a citation.
 * `find` and `to` are '' when there is none, and without `find` the address is the link as it came: any other fragment
 * (#page=3, #section) stays on it. A citation of a whole source has `cite` and `find` ''. Each value is decoded after the split, so an `&` in the words is `%26`. A path keeps
 * its percent-encoding off (`/Users/me/My%20Paper.pdf` is the file with a space), so it matches the library.
 */
function splitTarget(href) {
  const link = String(href == null ? '' : href).trim();
  const hash = link.indexOf('#');
  const fragment = hash >= 0 ? link.slice(hash + 1) : '';
  const parts = fragmentParts(fragment);
  if (!parts) return { address: link, find: '', to: '' };
  let address = link.slice(0, hash);
  if (/^(?:\/|~\/)/.test(address) && /%[0-9a-f]{2}/i.test(address)) { try { address = decodeURIComponent(address); } catch { /* as written */ } }
  const out = { address, find: words(parts.find), to: words(parts.to) };
  if ('cite' in parts || 'counter' in parts) {
    const cite = words(parts.cite).toLowerCase();
    out.cite = CITES.has(cite) ? cite : '';
    out.counter = words(parts.counter) === '1';
    if (parts.note) out.note = words(parts.note);
    if (/^[1-9]\d{0,5}$/.test(String(parts.page || ''))) out.page = Number(parts.page);
  }
  return out;
}

// Percent-encoded, parentheses too: a link's target ends at its first `)` (renderer/model/doc.js INLINE), and
// encodeURIComponent leaves them as they are.
const encode = (value) => encodeURIComponent(value).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));

/** A path as a citation's address spells it (fakeDiscover's): each segment percent-encoded. A web address as it is, but for its spaces and parentheses. */
const linkAddress = (where) => (String(where || '').startsWith('/') ? String(where).split('/').map(encode).join('/') : String(where || '').replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20')));

/**
 * A citation's href: `address#find=…[&to=…][&page=N][&note=…]&cite=…[&counter=1]`, or a whole source's
 * `address#[page=N&][note=…&]cite=…[&counter=1]`, with no space or parenthesis in it.
 */
function citeHref({ address, find, to = '', page = 0, note = '', cite, counter = false }) {
  const at = Number.isInteger(page) && page > 0 ? `page=${page}&` : '';
  const tail = `${at}${note ? `note=${encode(note)}&` : ''}cite=${cite}${counter ? '&counter=1' : ''}`;
  if (!find) return `${linkAddress(address)}#${tail}`;
  return `${linkAddress(address)}#find=${encode(find)}${to ? `&to=${encode(to)}` : ''}&${tail}`;
}

module.exports = { splitTarget, citeHref, linkAddress, CITES };
