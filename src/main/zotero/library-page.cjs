'use strict';

// Runs only in the isolated preload on Zotero's own website. The website's
// existing API key is used here, never sent over IPC, logged, or persisted.
function accountConfig(doc = document) {
  const node = doc.getElementById('zotero-web-library-config');
  if (!node || node.textContent.length > 200000) return null;
  try {
    const config = JSON.parse(node.textContent);
    if (!/^\d{1,20}$/.test(String(config.userId)) || typeof config.apiKey !== 'string' ||
        !/^[a-zA-Z0-9]{8,256}$/.test(config.apiKey) || typeof config.userSlug !== 'string' || !config.userSlug) return null;
    return { id: String(config.userId), slug: config.userSlug.slice(0, 200), apiKey: config.apiKey };
  } catch { return null; }
}
const accountOf = config => ({ id: config.id, name: config.slug });
function paperOf(item, account) {
  const data = item?.data, id = item?.key;
  if (!/^[A-Z0-9]{8}$/.test(id || '') || !data || typeof data.title !== 'string' ||
      data.deleted || data.parentItem || ['note', 'annotation'].includes(data.itemType) ||
      (data.itemType === 'attachment' && data.contentType !== 'application/pdf')) return null;
  return { id, name: data.title.replace(/<[^>]*>/g, '').trim().slice(0, 1000) || 'Untitled paper',
    authors: (Array.isArray(data.creators) ? data.creators : []).slice(0, 30).map(c => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ')).filter(s => typeof s === 'string').join(', ').slice(0, 1000),
    date: typeof data.date === 'string' ? data.date.slice(0, 100) : '',
    itemType: typeof data.itemType === 'string' ? data.itemType.slice(0, 50) : '',
    dateAdded: typeof data.dateAdded === 'string' ? data.dateAdded.slice(0, 40) : '',
    url: `https://www.zotero.org/${encodeURIComponent(account.name)}/items/${id}/library` };
}
async function readLibraryPage(request, { doc = document, locationUrl = location.href, fetcher = fetch } = {}) {
  const { origin, start } = request;
  const url = new URL(locationUrl);
  if (url.origin !== origin || !(origin === 'https://www.zotero.org' || /^http:\/\/127\.0\.0\.1:\d+$/.test(origin))) return { kind: 'unavailable' };
  const config = accountConfig(doc);
  if (!config) return { kind: /\/user\/login\b/.test(url.pathname) || doc.querySelector('input[type="password"]') ? 'login' : 'loading' };
  const account = accountOf(config);
  if (start === null) return { kind: 'account', account };
  if (!Number.isSafeInteger(start) || start < 0 || start > 100000) return { kind: 'unavailable' };
  const apiOrigin = origin === 'https://www.zotero.org' ? 'https://api.zotero.org' : origin;
  const endpoint = new URL(`/users/${config.id}/items/top`, apiOrigin);
  endpoint.search = new URLSearchParams({ format: 'json', include: 'data', sort: 'dateAdded', direction: 'desc', limit: '100', start: String(start) });
  try {
    const response = await fetcher(endpoint.href, { method: 'GET', credentials: 'omit', redirect: 'error',
      headers: { 'Zotero-API-Version': '3', 'Zotero-API-Key': config.apiKey }, signal: AbortSignal.timeout(15000) });
    const backoff = Math.max(0, Number(response.headers.get('Backoff')) || 0, Number(response.headers.get('Retry-After')) || 0);
    if ([401, 403].includes(response.status)) return { kind: 'login' };
    if (response.status === 429) return { kind: 'rate-limit', backoff: Math.max(30, backoff) };
    if (!response.ok) return { kind: 'error', backoff };
    const items = await response.json();
    if (!Array.isArray(items) || items.length > 100) return { kind: 'error', backoff };
    // A page navigation or account switch cannot return another account's list.
    if (accountConfig(doc)?.id !== account.id) return { kind: 'login' };
    const rawTotal = response.headers.get('Total-Results');
    const total = rawTotal !== null && /^\d+$/.test(rawTotal) ? Number(rawTotal) : null;
    const hasNext = /rel="?next\b/.test(response.headers.get('Link') || '');
    const next = hasNext || (total !== null ? start + items.length < total : items.length === 100);
    if (!items.length && next) return { kind: 'error', backoff };
    return { kind: 'ready', account, papers: items.map(item => paperOf(item, account)).filter(Boolean),
      next: next ? start + items.length : null, total, backoff,
      version: response.headers.get('Last-Modified-Version') || '' };
  } catch { return { kind: 'error' }; }
}
module.exports = { accountConfig, paperOf, readLibraryPage };
