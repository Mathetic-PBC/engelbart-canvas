'use strict';
// How one address is spelled, wherever a page is matched or filed: "is it open already" for the Stage's tabs
// (renderer/model/stage.js) and the tabs main keeps for it in state.json (main/store/projects.cjs cleanStage, MATH-10);
// which library row a page is and where its ink is kept (main/store/library.cjs sameAs, inkAddresses; MATH-54,
// 2026-10-06, so example.com and www.example.com/?utm_source=x are one page with one note file).

// Query parameters that say how someone came to a page, not which page it is.
const TRACKING = /^(?:utm_.*|fbclid|gclid|mc_cid|mc_eid|ref)$/i;

/** A query without its tracking parameters, the rest as they were written (not re-encoded): '' when none is left. */
function cleanSearch(search) {
  const kept = String(search || '').replace(/^\?/, '').split('&').filter((part) => {
    if (!part) return false;
    let name = part.split('=')[0];
    try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { /* as written */ }
    return !TRACKING.test(name);
  });
  return kept.length ? `?${kept.join('&')}` : '';
}

/**
 * http or https, www. or not, a trailing slash, a #fragment, tracking parameters (utm_*, fbclid, gclid, mc_cid, mc_eid,
 * ref): one address. The rest of the query stays — `?id=2` can be another page. Another scheme loses its #fragment
 * only; anything that is no URL is as it came.
 */
function addressKey(value) {
  const v = String(value || '').trim();
  if (!v || v === 'about:blank') return '';
  let u;
  try { u = new URL(v); } catch { return v; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.href.replace(/#.*$/, '');
  return `${u.host.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}${cleanSearch(u.search)}`;
}

// Hosts whose pages are this Mac's or a sandbox's (MATH-54): a dev server, a Build's preview, an E2B sandbox's
// <port>-<id>.e2b.app. Their addresses change from run to run, so nothing is filed under them.
const PREVIEW_HOST = /(?:^|\.)e2b\.(?:app|dev)$/i;

/** Whether `value` is a local server or a sandbox preview: localhost, 127.x, ::1, 0.0.0.0, *.localhost, *.e2b.app. */
function isPreviewAddress(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || /^127(?:\.\d{1,3}){3}$/.test(host) || PREVIEW_HOST.test(host);
}

module.exports = { addressKey, isPreviewAddress };
