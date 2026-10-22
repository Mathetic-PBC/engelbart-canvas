// Chat's citations as an answer draws them (2026-10-21): a link whose fragment has `cite=` (../../shared/passage-link.cjs;
// main checked it against its source before the answer was written, main/bart/cite.cjs) is a small grey circle with a
// number, as NotebookLM draws its sources, and the answer ends with its sources, each by its number and what it is
// (citationSources; David, 2026-10-21: "cite using number, and show sources at bottom"; a chip with its label for a few
// hours before). The markdown keeps the whole link: this is drawing only. Numbers go by the answer: each distinct source
// its own, in the order the answer first cites it, the same number again for the same source. Two citations side by side
// are two circles; three or more are the first and a "…" circle that opens the rest on a click or the pointer. A circle
// holds no text (its number is CSS's, from data-n), so what a line shows, and every offset into it, is what it was
// without the citation (doc.js tokShown).
import { splitTarget, CITES } from '../../shared/passage-link.cjs';
import { addressKey } from '../../shared/address-key.cjs';

const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
const INLINE_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An answer still arriving (2026-10-21, David: the quote showed in the streamed text): its citations are left out until
// it is in and main has checked them, and so is a link still being written at its end, whatever it turns out to be. The
// citation's target may hold spaces and parentheses the model left in (as main's bart/cite.cjs LOOSE_CITE_RE reads it).
const STREAM_CITE_RE = /[ \t]?\[[^\]\n]*\]\((?:(?!\]\()[^\n])*?[#&]cite=[A-Za-z]*(?:&(?:to|counter)=[^&)\n]*)*\)/g;
const STREAM_TAIL_RE = /[ \t]?\[[^\]\n]*(?:\]\([^)\n]*)?$/;
/** `text` (an answer so far) without its citations, or the link being written at its end. */
export const streamingText = (text) => String(text ?? '').replace(STREAM_CITE_RE, '').replace(STREAM_TAIL_RE, '');

/** Which source an address is, for numbering: a web address as addressKey spells it, a path as it is. */
export const citationKey = (address) => (/^https?:\/\//i.test(address) ? addressKey(address) : String(address || ''));

/**
 * A citation's parts from an inline token (`[label](href)`), or null for any other token, a link without `cite=` or
 * one whose cite is no known kind: { label, href, address, key, find, cite, counter }.
 */
export function citationOf(tok) {
  const m = String(tok ?? '').match(LINK_RE);
  if (!m || !/[#&]cite=/.test(m[2])) return null;
  const t = splitTarget(m[2]);
  if (!t.cite || !CITES.has(t.cite) || !t.find) return null;
  return { label: m[1], href: m[2], address: t.address, key: citationKey(t.address), find: t.find, cite: t.cite, counter: !!t.counter };
}

/** Which passage a citation is, for numbering: its source and the words it quotes. */
export const citationPassage = (c) => `${c.key}\n${c.find}`;

/**
 * An answer's citation numbers: passage (citationPassage) → 1, 2, … in the order the answer's `texts` (its lines, or the
 * whole answer) first cite each. A number a passage, not a source (2026-10-21, David: three quotes of one document read
 * "1, 1, 1"): the same words quoted again keep their number; other words of the same source take the next.
 */
export function citationNumbers(texts) {
  const out = new Map();
  for (const text of [].concat(texts || [])) {
    for (const m of String(text ?? '').matchAll(INLINE_LINK_RE)) {
      const c = citationOf(m[0]);
      if (c && !out.has(citationPassage(c))) out.set(citationPassage(c), out.size + 1);
    }
  }
  return out;
}

/**
 * How each of a line's tokens draws among citations: runs of citations with nothing but space between them. → an array
 * as long as `tokens`, each null (not in a run of three or more) or { run: index of the run's first citation, role:
 * 'first' | 'rest', last: the run's last token's index, more: how many citations the "…" stands for }. A run of one or
 * two draws every circle; three or more draw the first and "…", the rest hidden until opened. `citation(tok)`: whether
 * a token is a citation (citationOf by default).
 */
export function citationRuns(tokens, citation = citationOf) {
  const out = tokens.map(() => null);
  let i = 0;
  while (i < tokens.length) {
    if (!citation(tokens[i])) { i += 1; continue; }
    const cites = [i];
    let j = i + 1, last = i;
    while (j < tokens.length) {
      if (citation(tokens[j])) { cites.push(j); last = j; j += 1; continue; }
      if (/^\s+$/.test(tokens[j] || '') && j + 1 < tokens.length && citation(tokens[j + 1])) { j += 1; continue; }
      break;
    }
    if (cites.length >= 3) {
      for (let k = i; k <= last; k += 1) out[k] = { run: i, role: k === i ? 'first' : 'rest', last, more: cites.length - 1 };
    }
    i = last + 1;
  }
  return out;
}

/** What a citation's card says of its source: the workspace a workspace's document is, or the library's name for it. */
export function citationSource(c, name) {
  const named = typeof name === 'function' ? name(c.address) : null;
  if (named) return named;
  const parts = String(c.address || '').split('/').filter(Boolean);
  if (parts[parts.length - 1] === 'workspace.md' && parts.length > 1) return parts[parts.length - 2];
  if (/^https?:\/\//i.test(c.address)) { try { return new URL(c.address).hostname.replace(/^www\./, ''); } catch { return c.address; } }
  return parts[parts.length - 1] || c.address;
}

/**
 * What the library calls the source at `address`, among `rows` (library rows): a paper's, note's or page's name, a file in
 * a library folder by the folder's name and its own; null when the library does not have it (a workspace's document).
 */
export function libraryName(rows, address) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && r.type !== 'chat');
  const key = /^https?:\/\//i.test(address) ? addressKey(address) : null;
  const row = list.find((r) => (r.path && r.path === address) || (key && r.url && addressKey(r.url) === key));
  if (row) return row.name || null;
  const folder = list.find((r) => { const dir = r.folder_path || (r.type === 'folder' ? r.path : null); return dir && String(address).startsWith(`${dir.replace(/\/+$/, '')}/`); });
  return folder ? `${folder.name} / ${String(address).split('/').pop()}` : null;
}

/**
 * A citation's circle. `n`: its number in the answer (opts.cites, a Map from citationNumbers; else `fallback`, the order
 * it came in the line). `opts.citeSource(address)`: the source's name, when it is known. `opts.citeFocus`: the circle
 * takes keyboard focus (an answer box; not the document, whose caret Tab moves). `opts.citeTitle`: the card is the
 * circle's own tooltip (a web page's box card, a window as small as the card, which no card drawn in it could leave).
 */
export function citationHtml(c, opts, fallback) {
  const cites = opts && opts.cites;
  const n = (cites && cites.get && cites.get(citationPassage(c))) || fallback || 1;
  const source = citationSource(c, opts && opts.citeSource);
  const said = c.counter ? 'Against this' : c.cite === 'you' ? 'Your words' : c.cite === 'other' ? 'Someone else’s words' : 'A source';
  return `<a href="${esc(c.href)}" data-link="1" data-cite="${esc(c.cite)}" data-n="${n}" data-key="${esc(c.key)}" data-label="${esc(c.label)}" data-find="${esc(c.find)}" data-source="${esc(source)}"${c.cite === 'you' ? ' data-you="1"' : ''}${c.counter ? ' data-counter="1"' : ''} contenteditable="false"${opts && opts.citeFocus ? ' tabindex="0"' : ''}${opts && opts.citeTitle ? ` title="${esc(`${c.label}\n“${c.find}”\n${source}`)}"` : ''} aria-label="${esc(`${n}: ${c.label}, ${said}. “${c.find}” — ${source}`)}"></a>`;
}

/**
 * An answer's sources, in the order it first cites each: [{ n, name, href, passages }]. `name`: what the source is
 * (citationSource: the library's name, the workspace's); `passages`: the numbers quoting it, each { n, href }; `n` and
 * `href` its first one's, so the source opens at the passage first quoted from it. `opts.cites` and `opts.citeSource` as
 * citationHtml takes them.
 */
export function citationSources(text, opts = {}) {
  const cites = (opts && opts.cites) || citationNumbers(text), seen = new Map();
  for (const m of String(text ?? '').matchAll(INLINE_LINK_RE)) {
    const c = citationOf(m[0]);
    if (!c) continue;
    const n = cites.get(citationPassage(c)) || cites.size + 1;
    if (!seen.has(c.key)) seen.set(c.key, { n, name: citationSource(c, opts && opts.citeSource), href: c.href, passages: [] });
    const source = seen.get(c.key);
    if (!source.passages.some((p) => p.n === n)) source.passages.push({ n, href: c.href });
  }
  return [...seen.values()].sort((a, b) => a.n - b.n);
}
/**
 * The sources under an answer: "Sources", then a row a source: the circles of the numbers quoting it, each a link to its
 * passage, and its name, a link to the first.
 */
export const citationSourcesHtml = (sources) => (sources.length ? `<div style="font:500 11px/1.4 var(--font-sans);letter-spacing:.2px;color:#8f8f8f;margin-bottom:4px">Sources</div>`
  + sources.map((s) => `<div data-cite-row="${s.n}">${s.passages.map((p) => `<a href="${esc(p.href)}" data-link="1" data-cite-source="${p.n}" data-n="${p.n}" contenteditable="false" title="${esc(s.name)}" aria-label="${p.n}: ${esc(s.name)}"></a>`).join('')}`
    + `<a href="${esc(s.href)}" data-link="1" data-cite-name="1" contenteditable="false" title="${esc(s.name)}">${esc(s.name)}</a></div>`).join('') : '');

/** The "…" circle of a folded run: `more` citations, opened by a click (openCitationRun) or the pointer. */
export const citationMoreHtml = (more) => `<span data-cite-more="1" data-n="…" contenteditable="false" role="button" aria-label="${more} more ${more === 1 ? 'citation' : 'citations'}" title="${more} more"></span>`;

/** A click on a folded run's "…": opens the run and → true; any other click → false. */
export function openCitationRun(target) {
  const more = target && typeof target.closest === 'function' ? target.closest('[data-cite-more]') : null;
  if (!more || !more.dataset || !more.dataset.citeMore || typeof more.closest !== 'function') return false;
  const run = more.closest('[data-cite-run]');
  if (!run || typeof run.setAttribute !== 'function') return false;
  run.setAttribute('data-open', '1');
  return true;
}

// The agents whose words a citation can quote, said by name on its card.
const AGENTS = new Set(['Chat', 'ChatGPT', 'Claude', 'Codex', 'Cursor']);
/**
 * A citation's card (2026-10-21, David's mock): the quote, then who wrote it, where and when: "You wrote this in flow ·
 * Oct 10", "Chat said this in flow · Oct 10", "From Building the computer of the future · Oct 15", "From TutorTrace p. 6".
 * → { quote, lead, where, when, counter }, from the chip's label ("You · Oct 10") and source.
 */
export function citationCard(el) {
  const label = el.dataset.label || '', cite = el.dataset.cite || '';
  const [who, ...rest] = label.split(' · ');
  const source = cite === 'source';
  return {
    quote: el.dataset.find || '',
    lead: cite === 'you' ? 'You wrote this in' : !source && AGENTS.has(who) ? `${who} said this in` : 'From',
    where: source ? label || el.dataset.source || '' : el.dataset.source || '',
    when: source ? '' : rest.join(' · '),
    counter: !!el.dataset.counter,
  };
}
const DOC_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>';
/** The card's inside, as the document's hover card (workspace/Popover.jsx) and an answer box's (citationTip) draw it. */
export const citationCardHtml = (card) => `<div style="font:13.5px/1.55 var(--font-sans);color:#171717;text-wrap:pretty">“${esc(card.quote)}”</div>`
  + `<div style="margin-top:10px;padding-top:9px;border-top:1px solid #eaeaea;display:flex;align-items:center;gap:6px;font:11.5px/1.4 var(--font-sans);color:#8f8f8f">`
  + `<span style="flex:none;display:inline-flex">${DOC_ICON}</span><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(card.lead)} <span style="font-weight:600;color:#4d4d4d">${esc(card.where)}</span>${card.when ? ` · ${esc(card.when)}` : ''}${card.counter ? ' · cuts against this' : ''}</span></div>`;
/** The card's box. */
export const CITE_CARD_STYLE = 'width:280px;box-sizing:border-box;padding:12px 14px 10px;background:#fff;border:1px solid #e3e3e3;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.08);pointer-events:none;text-align:left';

// The circle: 16px, the grey of a chip, its number dark grey, on the text's baseline and never underlined, every one alike
// (the darker ring the person's own words had went, 2026-10-21, David); a passage that cuts against the answer is hollow.
// A folded run's rest is hidden until the pointer is on the run or its "…" was clicked.
const CIRCLE = 'display:inline-block;box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;margin:0 1px 0 2px;border-radius:8px;vertical-align:1px;text-decoration:none;cursor:pointer;user-select:none;-webkit-user-select:none';
const NUMBER = 'display:block;font:500 10px/16px var(--font-sans);font-variant-numeric:tabular-nums;color:#4d4d4d;text-align:center';
export const CITE_CSS = `
a[data-cite]{${CIRCLE};background:#ebebeb;border:1px solid #ebebeb;color:#4d4d4d;text-decoration:none!important}
a[data-cite]::after{content:attr(data-n);${NUMBER};margin-top:-1px}
a[data-cite]:hover,a[data-cite]:focus-visible{background:#d6d6d6;border-color:#d6d6d6;outline:none}
a[data-cite][data-counter]{background:#fff;border-color:#c9c9c9}
a[data-cite][data-counter]:hover{background:#f2f2f2}
[data-cite-more]{${CIRCLE};background:#f2f2f2;border:1px solid #eaeaea}
[data-cite-more]::after{content:attr(data-n);${NUMBER};margin-top:-1px;color:#8f8f8f}
[data-cite-run]:not([data-open]):not(:hover) [data-cite-rest]{display:none}
[data-cite-run][data-open] [data-cite-more],[data-cite-run]:hover [data-cite-more]{display:none}
[data-cite-row]{display:flex;align-items:center;gap:3px;padding:2px 0}
a[data-cite-source]{flex:none;${CIRCLE};margin:0;background:#ebebeb;border:1px solid #ebebeb;text-decoration:none!important}
a[data-cite-source]::after{content:attr(data-n);${NUMBER};margin-top:-1px}
a[data-cite-source]:hover{background:#d6d6d6;border-color:#d6d6d6}
a[data-cite-name]{margin-left:5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4d4d4d;text-decoration:none!important;cursor:pointer}
a[data-cite-name]:hover{text-decoration:underline!important;text-underline-offset:2px}
`;
// An answer box's card (a highlight's box, a web page's box card): the document's hover card (workspace/Popover.jsx) drawn
// over the page by itself, under the circle or above it where there is no room under, as a box clips what overflows it.
// `over` and `out` take the box's pointer and focus events (mouseover/focusin, mouseout/focusout), so a circle reached by
// Tab shows its card too. The pointer leaving leaves the card up (2026-10-21, David): a press elsewhere, a scroll, Escape,
// focus leaving or another circle takes it down.
const TIP = `position:fixed;z-index:1000;${CITE_CARD_STYLE}`;
export function citationTip(doc = typeof document === 'undefined' ? null : document) {
  let tip = null;
  const away = (e) => { if (e.type !== 'keydown' || e.key === 'Escape') hide(); };
  const hide = () => {
    if (!tip) return;
    tip.remove(); tip = null;
    for (const type of ['pointerdown', 'scroll', 'keydown']) doc.removeEventListener(type, away, true);
  };
  const show = (el) => {
    hide();
    if (!doc || !doc.body) return;
    for (const type of ['pointerdown', 'scroll', 'keydown']) doc.addEventListener(type, away, true);
    const card = citationCard(el);
    tip = doc.createElement('div');
    tip.setAttribute('data-cite-tip', '1');
    tip.setAttribute('role', 'tooltip');
    tip.style.cssText = TIP;
    tip.innerHTML = citationCardHtml(card); // as the document's card is (workspace/Popover.jsx)
    doc.body.appendChild(tip);
    const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight;
    const vw = doc.documentElement.clientWidth || 800, vh = doc.documentElement.clientHeight || 600;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, vw - w - 8));
    const top = r.bottom + 6 + h > vh - 8 && r.top - 6 - h >= 8 ? r.top - 6 - h : r.bottom + 6;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  const circle = (e) => (e && e.target && e.target.closest ? e.target.closest('a[data-cite]') : null);
  return {
    over: (e) => { const el = circle(e); if (el) show(el); },
    out: (e) => { const el = circle(e); if (el && /blur|focusout/.test(e.type) && !(e.relatedTarget && el.contains(e.relatedTarget))) hide(); },
    hide,
  };
}
