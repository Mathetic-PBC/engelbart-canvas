// Web addresses as mentions name them (2026-10-17). A page's title can be its address: Electron gives the address as the
// title of a page that has none yet, and the Stage falls back to it. A mention never carries that: a name that is the
// address, with or without its scheme, becomes the address's host and path. model/doc.js re-exports these. (model/address.js is the Browser pane's address bar.)

/** Whether `value` is a web address as it stands. */
export const isAddress = (value) => /^https?:\/\/\S+$/i.test(String(value ?? '').trim());
const addressKey = (value) => String(value ?? '').trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/#.*$/, '').replace(/\/+$/, '').toLowerCase();
/** Whether two addresses are the same page: scheme, `www.`, a trailing slash and the fragment aside. */
export const sameAddress = (a, b) => !!addressKey(a) && addressKey(a) === addressKey(b);
/** An address as a mention shows it: host and path, no scheme, `www.`, query, fragment or trailing slash; cut at 60. */
export function webLabel(url) {
  const raw = String(url ?? '').trim();
  let shown;
  try { const u = new URL(raw); let pathname = u.pathname; try { pathname = decodeURI(pathname); } catch { /* as it is */ } shown = u.host.replace(/^www\./i, '') + pathname.replace(/\/+$/, ''); } catch { shown = raw.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, ''); }
  shown = shown.replace(/[[\]\n]/g, '').replace(/\s+/g, ' ').trim();
  return shown.length > 60 ? `${shown.slice(0, 59)}…` : shown || 'Untitled page';
}
/** The name a web page is mentioned by: `name` (its title), unless it is missing or is its address, then webLabel(`url`). */
export function webName(name, url) {
  const n = String(name ?? '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (n && !isAddress(n) && !(url && sameAddress(n, url))) return n.slice(0, 200);
  return webLabel(url || n);
}
