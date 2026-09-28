'use strict';
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const BROKER = 'https://engelbart.mathetic.com';
const CLIENT_ID = 'Iv23liAZNYl96zlluMDs';
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Only main knows the PKCE verifier. The browser carries a single-use code to a random loopback port.
function createBrowserAuth({ broker = BROKER, fetch = globalThis.fetch, timeoutMs = 600000 } = {}) {
  const target = new URL(broker);
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && target.hostname === '127.0.0.1')) throw new Error('GitHub sign-in requires HTTPS');
  async function exchange(body) {
    const response = await fetch(new URL('/api/github/token', target), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(20000) });
    const data = await response.json();
    if (!response.ok && response.status >= 500) throw new Error('GitHub sign-in service is unavailable. Try again.');
    return data;
  }
  async function start() {
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    let resolve, reject, timer, callbackPort, finished = false, consuming = false;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Cancel/timeout can happen before the caller attaches its continuation.
    result.catch(() => {});
    const finish = (error, tokens) => {
      if (finished) return;
      finished = true; clearTimeout(timer); server.close();
      if (error) reject(error); else resolve(tokens);
    };
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const answer = (status, text) => { res.statusCode = status; res.end(`<!doctype html><meta charset="utf-8"><title>Engelbart</title><h1>${text}</h1><p>You can close this tab and return to your workspace.</p>`); };
      // A browser can request a favicon on a keep-alive socket after finish()
      // closes the listener. Its original port stays valid even then.
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${callbackPort}`) return answer(403, 'Request refused');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/oauth/github/callback' || !same(url.searchParams.get('state'), state)) return answer(400, 'Invalid sign-in callback');
      if (finished || consuming) return answer(409, 'Sign-in already handled');
      if (url.searchParams.has('error')) { answer(200, 'Sign-in cancelled'); finish(new Error('GitHub sign-in cancelled.')); return; }
      const code = url.searchParams.get('code'), ticket = url.searchParams.get('ticket');
      if (!code || code.length > 512 || !ticket || ticket.length > 2048) return answer(400, 'Invalid sign-in callback');
      consuming = true;
      try {
        const data = await exchange({ code, ticket, verifier });
        if (finished) return answer(410, 'Sign-in expired or cancelled');
        if (!data.access_token) throw new Error('GitHub did not authorize this sign-in. Try again.');
        answer(200, 'GitHub connected'); finish(null, data);
      } catch (error) { answer(502, 'Sign-in did not complete. Try again in Engelbart.'); finish(error); }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    callbackPort = server.address().port;
    const url = new URL('/api/github/start', target);
    url.search = new URLSearchParams({ port: String(callbackPort), state, challenge }).toString();
    timer = setTimeout(() => finish(new Error('GitHub sign-in expired. Try again.')), timeoutMs);
    return { url: url.href, expiresAt: Date.now() + timeoutMs, result, cancel: () => finish(new Error('GitHub sign-in cancelled.')) };
  }
  return { start, refresh: refreshToken => exchange({ refreshToken }) };
}
module.exports = { createBrowserAuth, BROKER, CLIENT_ID };
