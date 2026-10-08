'use strict';
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const BROKER = 'https://engelbart.mathetic.com';
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// What the broker's callback errors (Mathetic-PBC/landing api/_lib/zotero-auth.cjs) and its token errors mean to the person.
const FAILURES = {
  access_denied: 'Cancelled on Zotero.',
  authorization_failed: 'Zotero did not authorize the sign-in. Try again.',
  upstream_unavailable: 'Zotero could not be reached. Try again.',
  invalid_ticket: 'The Zotero sign-in expired. Try again.',
  invalid_verifier: 'The Zotero sign-in could not be verified. Try again.',
};
const failure = (code) => Object.assign(new Error(FAILURES[code] || 'Zotero sign-in did not complete. Try again.'), { code: FAILURES[code] ? code : 'failed' });

// GitHub's flow (../github/browser-auth.cjs) for Zotero's OAuth 1.0a, which only the broker can sign: a random loopback
// port, a state and a PKCE challenge go to /api/zotero/start; the browser comes back to the loopback with a sealed ticket
// that only this process's verifier redeems for the API key (POST /api/zotero/token → { key, userID }).
function createBrowserAuth({ broker = BROKER, fetch = globalThis.fetch, timeoutMs = 600000 } = {}) {
  const target = new URL(broker);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw new Error('Zotero sign-in requires HTTPS');
  async function exchange(body) {
    const response = await fetch(new URL('/api/zotero/token', target), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok && response.status >= 500) throw new Error('Zotero sign-in service is unavailable. Try again.');
    if (!response.ok) throw failure(data && data.error);
    if (!data || typeof data.key !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(data.key) || !/^[0-9]{1,20}$/.test(String(data.userID ?? ''))) throw failure('authorization_failed');
    return { key: data.key, userID: String(data.userID) };
  }
  async function start() {
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let resolve, reject, timer, finished = false, consuming = false;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Cancel/timeout can happen before the caller attaches its continuation.
    result.catch(() => {});
    const finish = (error, credentials) => {
      if (finished) return;
      finished = true; clearTimeout(timer); server.close();
      if (error) reject(error); else resolve(credentials);
    };
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const answer = (status, text) => { res.statusCode = status; res.end(`<!doctype html><meta charset="utf-8"><title>Engelbart</title><h1>${text}</h1><p>You can close this tab and return to Engelbart.</p>`); };
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${server.address().port}`) return answer(403, 'Request refused');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/oauth/zotero/callback' || !same(url.searchParams.get('state'), state)) return answer(400, 'Invalid sign-in callback');
      if (finished || consuming) return answer(409, 'Sign-in already handled');
      if (url.searchParams.has('error')) {
        const code = url.searchParams.get('error');
        answer(200, code === 'access_denied' ? 'Sign-in cancelled' : 'Sign-in did not complete. Try again in Engelbart.');
        finish(failure(code));
        return;
      }
      const ticket = url.searchParams.get('ticket');
      if (!ticket || ticket.length > 4096) return answer(400, 'Invalid sign-in callback');
      consuming = true;
      try {
        const credentials = await exchange({ ticket, verifier });
        if (finished) return answer(410, 'Sign-in expired or cancelled');
        answer(200, 'Zotero connected'); finish(null, credentials);
      } catch (error) { answer(502, 'Sign-in did not complete. Try again in Engelbart.'); finish(error); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    const url = new URL('/api/zotero/start', target);
    url.search = new URLSearchParams({ port: String(server.address().port), state, challenge }).toString();
    timer = setTimeout(() => finish(Object.assign(new Error('The Zotero sign-in expired. Try again.'), { code: 'expired' })), timeoutMs);
    return { url: url.href, expiresAt: Date.now() + timeoutMs, result, cancel: () => finish(Object.assign(new Error('Zotero sign-in cancelled.'), { code: 'cancelled' })) };
  }
  return { start };
}
module.exports = { createBrowserAuth, BROKER, FAILURES };
