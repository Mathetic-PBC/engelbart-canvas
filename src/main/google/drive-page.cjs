'use strict';

const WORLD = 1741;

// Runs in an isolated world on Drive's listing only. Read DOM metadata, never
// cookies, page globals, private network APIs, document bodies or auth forms.
// These attributes were checked against the live Drive grid on 2026-09-27.
function snapshotDrive(expectedQuery, advance = false, expectedOrigin = 'https://drive.google.com') {
  if (location.origin !== expectedOrigin || !/^\/drive(?:\/u\/\d+)?\/(?:search|my-drive|recent|home)/.test(location.pathname)) return { kind: 'unavailable' };
  const accountNode = [...document.querySelectorAll('[role="button"][aria-label]')].find(node => /Google Account:/.test(node.getAttribute('aria-label') || ''));
  const label = accountNode?.getAttribute('aria-label') || '';
  const email = label.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
  if (!email) return { kind: 'loading' };
  const account = { id: email.toLowerCase(), email, name: label.replace(/^Google Account:\s*/, '').replace(email, '').replace(/[()]/g, '').trim().slice(0, 200) };
  const user = location.pathname.match(/^\/drive\/u\/(\d+)\//)?.[1] || '0';
  if (!expectedQuery) return { kind: 'account', account, user };
  // On a fresh load Drive converts operators into filter chips and clears the
  // input. The committed search URL retains the query and establishes scope.
  if (!location.pathname.endsWith('/search') || new URL(location.href).searchParams.get('q') !== expectedQuery) return { kind: 'loading', account, user };
  const grid = document.querySelector('[role="grid"], [role="table"]');
  const busy = !!document.querySelector('[role="progressbar"][aria-label="Loading"], [aria-busy="true"]');
  // Only explicit, visible empty-result UI is an empty list. An unfamiliar DOM
  // must fail visibly instead of silently clearing the person's sidebar.
  const emptyNode = [...document.querySelectorAll('[role="main"], main, [role="status"], [role="heading"], h1, h2, body')].find(node =>
    node.getClientRects().length && /(?:No (?:matching |search )?results|No items match|No files (?:found|match)|Try a different search)/i.test(node.innerText || ''));
  const all = grid ? [...grid.querySelectorAll('[data-id][role="row"], [data-id][role="gridcell"]')] : [];
  const documents = [];
  let unrecognized = 0;
  for (const node of all.slice(0, 500)) {
    const id = node.getAttribute('data-id');
    if (!/^[\w-]{10,200}$/.test(id || '')) continue;
    const tip = [...node.querySelectorAll('[data-tooltip]')].find(el => el.getAttribute('data-tooltip')?.endsWith(' Google Docs'));
    const aria = node.getAttribute('aria-label') || '';
    const native = !!tip || / Google Docs(?: More info|$)/.test(aria);
    if (!native) {
      if (!/Microsoft Word|Google Sheets|Google Slides|Folder|PDF|shortcut/i.test(aria)) unrecognized++;
      continue;
    }
    const name = (tip?.innerText || aria.split(' Google Docs')[0] || '').trim().slice(0, 512);
    if (!name) { unrecognized++; continue; }
    // Date text is optional in grid view. The exact Drive search establishes the
    // date range; do not invent timestamps when the page doesn't provide them.
    const dateNode = node.querySelector('time[datetime], [data-modified-time]');
    const date = dateNode?.getAttribute('datetime') || dateNode?.getAttribute('data-modified-time');
    documents.push({ id, name, modifiedTime: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null });
  }
  let scroller = all[0] || grid;
  while (scroller && !(scroller.clientHeight > 0 && scroller.scrollHeight > scroller.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
  const atEnd = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3;
  if (advance && scroller && !atEnd) scroller.scrollTop += Math.max(100, scroller.clientHeight * 0.8);
  return { kind: !busy && (all.length || emptyNode) ? 'ready' : 'loading', account, user, documents,
    empty: !!emptyNode && !all.length, atEnd, busy, unrecognized,
    position: scroller ? `${Math.round(scroller.scrollTop)}:${scroller.scrollHeight}` : 'end' };
}

const source = (query, advance = false, origin = 'https://drive.google.com') => `(${snapshotDrive.toString()})(${JSON.stringify(query)},${JSON.stringify(advance)},${JSON.stringify(origin)})`;
module.exports = { source, snapshotDrive, WORLD };
