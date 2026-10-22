// Chat's citations as an answer draws them (2026-10-21): a link whose fragment has `cite=` (../../shared/passage-link.cjs;
// main checked it against its source before the answer was written, main/bart/cite.cjs) is a small grey chip with its
// label, as NotebookLM draws its sources: "You · Oct 12", "Chat · Oct 12", a paper's short title (David, 2026-10-21; a
// number until then). Main writes who and when, from the source. The markdown keeps the whole link: this is drawing
// only. Each distinct source still has its number by the answer (data-n), in the order the answer first cites it. Two
// citations side by side are two chips; three or more are the first and a "…" that opens the rest on a click or the
// pointer. A chip holds no text (its label is CSS's, from data-label), so what a line shows, and every offset into it,
// is what it was without the citation (doc.js tokShown).
import { splitTarget, CITES } from '../../shared/passage-link.cjs';
import { addressKey } from '../../shared/address-key.cjs';

const LINK_RE = /^\[([^\]]+)\]\(([^)]+)\)$/;
const INLINE_LINK_RE = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

/**
 * An answer's citation numbers: source key → 1, 2, … in the order the answer's `texts` (its lines, or the whole answer)
 * first cite each.
 */
export function citationNumbers(texts) {
  const out = new Map();
  for (const text of [].concat(texts || [])) {
    for (const m of String(text ?? '').matchAll(INLINE_LINK_RE)) {
      const c = citationOf(m[0]);
      if (c && !out.has(c.key)) out.set(c.key, out.size + 1);
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
  const n = (cites && cites.get && cites.get(c.key)) || fallback || 1;
  const source = citationSource(c, opts && opts.citeSource);
  const said = c.counter ? 'Against this' : c.cite === 'you' ? 'Your words' : c.cite === 'other' ? 'Someone else’s words' : 'A source';
  return `<a href="${esc(c.href)}" data-link="1" data-cite="${esc(c.cite)}" data-n="${n}" data-key="${esc(c.key)}" data-label="${esc(c.label)}" data-find="${esc(c.find)}" data-source="${esc(source)}"${c.cite === 'you' ? ' data-you="1"' : ''}${c.counter ? ' data-counter="1"' : ''} contenteditable="false"${opts && opts.citeFocus ? ' tabindex="0"' : ''}${opts && opts.citeTitle ? ` title="${esc(`${c.label}\n“${c.find}”\n${source}`)}"` : ''} aria-label="${esc(`${n}: ${c.label}, ${said}. “${c.find}” — ${source}`)}"></a>`;
}

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

/** A citation's card, as the document's hover card (Popover) draws it: its label ("You · Oct 12"), the quote, and where. */
export const citationCard = (el) => ({
  kindLabel: el.dataset.counter ? 'Cuts against this' : '',
  title: el.dataset.label || '',
  summary: el.dataset.find ? `“${el.dataset.find}”` : '',
  facts: el.dataset.source || '',
});

// The chip: 18px high, the grey of a chip, its label dark grey, on the text's baseline and never underlined. The person's
// own words have a darker ring; a passage that cuts against the answer is hollow. A folded run's rest is hidden until the
// pointer is on the run or its "…" was clicked.
const CIRCLE = 'display:inline-block;box-sizing:border-box;min-width:18px;height:18px;padding:0 7px;margin:0 1px 0 3px;border-radius:9px;vertical-align:0;text-decoration:none;cursor:pointer;user-select:none;-webkit-user-select:none;white-space:nowrap';
const NUMBER = 'display:block;font:500 11px/18px var(--font-sans);font-variant-numeric:tabular-nums;color:#4d4d4d;text-align:center';
export const CITE_CSS = `
a[data-cite]{${CIRCLE};background:#ebebeb;border:1px solid #ebebeb;color:#4d4d4d;text-decoration:none!important}
a[data-cite]::after{content:attr(data-label);${NUMBER};margin-top:-1px}
a[data-cite]:hover,a[data-cite]:focus-visible{background:#d6d6d6;border-color:#d6d6d6;outline:none}
a[data-cite][data-you]{border-color:#8f8f8f}
a[data-cite][data-counter]{background:#fff;border-color:#c9c9c9}
a[data-cite][data-counter]:hover{background:#f2f2f2}
[data-cite-more]{${CIRCLE};background:#f2f2f2;border:1px solid #eaeaea}
[data-cite-more]::after{content:attr(data-n);${NUMBER};margin-top:-1px;color:#8f8f8f}
[data-cite-run]:not([data-open]):not(:hover) [data-cite-rest]{display:none}
[data-cite-run][data-open] [data-cite-more],[data-cite-run]:hover [data-cite-more]{display:none}
`;
// An answer box's card (a highlight's box, a web page's box card): the document's hover card (workspace/Popover.jsx) drawn
// over the page by itself, under the circle or above it where there is no room under, as a box clips what overflows it.
// `over` and `out` take the box's pointer and focus events (mouseover/focusin, mouseout/focusout), so a circle reached by
// Tab shows its card too.
const TIP = 'position:fixed;z-index:1000;width:280px;box-sizing:border-box;padding:12px 14px;background:#fff;border:1px solid #c9c9c9;border-radius:8px;box-shadow:0 12px 32px rgba(0,0,0,.06);pointer-events:none;text-align:left';
export function citationTip(doc = typeof document === 'undefined' ? null : document) {
  let tip = null;
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  const show = (el) => {
    hide();
    if (!doc || !doc.body) return;
    const card = citationCard(el);
    tip = doc.createElement('div');
    tip.setAttribute('data-cite-tip', '1');
    tip.setAttribute('role', 'tooltip');
    tip.style.cssText = TIP;
    tip.innerHTML = (card.kindLabel ? `<div style="font:500 9px/1 var(--font-sans);letter-spacing:1.6px;text-transform:uppercase;color:#8f8f8f">${esc(card.kindLabel)}</div>` : '')
      + `<div style="margin-top:${card.kindLabel ? 8 : 0}px;font:500 13.5px/1.4 var(--font-sans);color:#171717">${esc(card.title)}</div>`
      + `<div style="margin-top:6px;font:12.5px/1.6 var(--font-sans);color:#4d4d4d">${esc(card.summary)}</div>`
      + `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #eaeaea;font:12px/1.5 var(--font-sans);color:#8f8f8f">${esc(card.facts)}</div>`;
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
    out: (e) => { const el = circle(e); if (el && !(e.relatedTarget && el.contains(e.relatedTarget))) hide(); },
    hide,
  };
}
