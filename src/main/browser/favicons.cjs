'use strict';

const MAX_ICON_BYTES = 256 * 1024;
const IMAGE_TYPE = /^image\/(?:png|x-png|jpeg|gif|webp|avif|svg\+xml|x-icon|vnd\.microsoft\.icon|ico|bmp)$/i;

function faviconPage(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !/(^|\.)e2b\.(app|dev)$/.test(url.hostname.replace(/\.$/, ''));
  } catch { return false; }
}

function iconUrl(value) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('data:')) {
    if (value.length > MAX_ICON_BYTES * 1.4) return null;
    const type = value.slice(5).split(/[;,]/, 1)[0];
    return IMAGE_TYPE.test(type) && value.includes(',') ? value : null;
  }
  if (value.length > 8192) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// Chromium may omit page-favicon-updated when the icon URL is unchanged on
// reload. Read the committed document in an isolated world without modifying it.
function readFaviconUrls(contents) {
  return contents.executeJavaScriptInIsolatedWorld(1740, [{ code: `(() => {
    const links = Array.from(document.querySelectorAll('link[rel]'))
      .filter(link => link.rel.toLowerCase().split(/\\s+/).includes('icon'))
      .map(link => link.href).filter(Boolean).slice(0, 3);
    return links.length ? links : [new URL('/favicon.ico', location.href).href];
  })()` }]);
}

// Use the page's Chromium session, not a third-party icon service or the app's
// privileged renderer. Only bounded image data crosses into the tab UI.
async function loadFavicon(session, candidates, signal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
  for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 3) : []) {
    if (bounded.aborted) break;
    let url = iconUrl(candidate);
    if (!url) continue;
    if (url.startsWith('data:')) return url;
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await session.fetch(url, { signal: bounded, redirect: 'manual', credentials: 'include', bypassCustomProtocolHandlers: true });
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          url = location && iconUrl(new URL(location, url).href);
          if (!url || url.startsWith('data:')) break;
          continue;
        }
        const type = (response.headers.get('content-type') || '').split(';')[0].trim();
        if (!response.ok || !IMAGE_TYPE.test(type) || Number(response.headers.get('content-length')) > MAX_ICON_BYTES || !response.body) {
          await response.body?.cancel(); break;
        }
        const reader = response.body.getReader(), chunks = [];
        let bytes = 0;
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            bytes += next.value.byteLength;
            if (bytes > MAX_ICON_BYTES) throw new Error('Favicon too large');
            chunks.push(Buffer.from(next.value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        if (bytes) return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
        break;
      }
    } catch { /* Missing, blocked, or slow icons keep the existing tab glyph. */ }
  }
  return null;
}

module.exports = { faviconPage, iconUrl, readFaviconUrls, loadFavicon, MAX_ICON_BYTES };
