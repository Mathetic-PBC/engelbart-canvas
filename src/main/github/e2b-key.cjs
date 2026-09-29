'use strict';
const KEY_HOST = 'https://mathetic.com';

// The E2B API key for whoever is signed in, from mathetic.com's /api/e2b/key: it answers any token GitHub confirms was
// issued to the Engelbart App. Memory only: never written to disk or logged, dropped on sign-out, fetched again after.
// `override`: an unpackaged copy's own E2B_API_KEY (index.cjs), answered as is, signed in or not; never in a release.
function createE2bKey({ github, version, host = KEY_HOST, fetch = globalThis.fetch, override = null } = {}) {
  const target = new URL(host);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw new Error('The E2B key requires HTTPS');
  let pending = null;
  async function request(token) {
    const response = await fetch(new URL('/api/e2b/key', target), { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-engelbart-client': `engelbart-desktop/${version}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`E2B key request failed (${response.status})`);
    const data = await response.json();
    if (!data || typeof data.e2bApiKey !== 'string' || !data.e2bApiKey) throw new Error('E2B key response had no key');
    return data.e2bApiKey;
  }
  /** The key, or null when signed out. Callers at the same time share one request; a failed one is not kept. */
  async function get() {
    if (override) return override;
    const token = await github.token();
    if (!token) { pending = null; return null; }
    if (!pending) {
      const attempt = pending = request(token);
      attempt.catch(() => { if (pending === attempt) pending = null; });
    }
    return pending;
  }
  return { get, forget: () => { pending = null; } };
}
module.exports = { createE2bKey, KEY_HOST };
