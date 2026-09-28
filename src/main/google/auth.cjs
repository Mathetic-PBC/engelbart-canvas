'use strict';
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
const same = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = (message, code) => Object.assign(new Error(message), { code });
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw new Error('Google sign-in requires HTTPS');
  return url;
}

function createGoogleAuth({ fetch = globalThis.fetch, authorizeUrl = 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl = 'https://oauth2.googleapis.com/token', timeoutMs = 600000 } = {}) {
  const authorize = endpoint(authorizeUrl), token = endpoint(tokenUrl);
  async function exchange(credentials, fields, signal) {
    const form = { client_id: credentials.clientId, ...fields };
    if (credentials.clientSecret) form.client_secret = credentials.clientSecret;
    const response = await fetch(token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
    const data = await response.json().catch(() => null);
    if (data?.error === 'invalid_grant') throw failure('Google sign-in expired or was revoked. Connect again.', 'invalid_grant');
    if (data?.error === 'invalid_client') throw failure('Google did not accept this app’s sign-in configuration.', 'invalid_client');
    if (!response.ok || typeof data?.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0)) throw failure('Google sign-in could not complete. Try again.', 'oauth');
    if (data.scope && !data.scope.split(/\s+/).includes(SCOPE)) throw failure('Allow access to Drive file information to list your Google Docs.', 'scope');
    return { access: data.access_token, refresh: typeof data.refresh_token === 'string' ? data.refresh_token : null, expiresIn: Number(data.expires_in) };
  }
  async function start(credentials) {
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    const controller = new AbortController();
    let resolve, reject, timer, port, finished = false, consuming = false;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    result.catch(() => {});
    const finish = (error, tokens) => {
      if (finished) return;
      finished = true; clearTimeout(timer); controller.abort(); server.close();
      if (error) reject(error); else resolve(tokens);
    };
    const server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const answer = (status, message) => { res.statusCode = status; res.end(`<!doctype html><meta charset="utf-8"><title>Engelbart</title><h1>${message}</h1><p>You can close this tab and return to Engelbart.</p>`); };
      if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) return answer(403, 'Request refused');
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method !== 'GET' || url.pathname !== '/' || url.searchParams.getAll('state').length !== 1 || !same(url.searchParams.get('state'), state)) return answer(400, 'Invalid sign-in callback');
      if (finished || consuming) return answer(409, 'Sign-in already handled');
      if (url.searchParams.has('error')) { answer(200, 'Sign-in cancelled'); finish(new Error('Google sign-in was not approved. Try connecting again.')); return; }
      const code = url.searchParams.get('code');
      if (!code || code.length > 2048 || url.searchParams.getAll('code').length !== 1) return answer(400, 'Invalid sign-in callback');
      consuming = true;
      try {
        const tokens = await exchange(credentials, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: `http://127.0.0.1:${port}/` }, controller.signal);
        if (finished) return answer(410, 'Sign-in expired or cancelled');
        answer(200, 'Google sign-in complete'); finish(null, tokens);
      } catch (error) { answer(502, 'Sign-in did not complete. Try again in Engelbart.'); finish(error); }
    });
    server.requestTimeout = 20000; server.headersTimeout = 10000;
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    server.on('error', error => finish(error));
    port = server.address().port;
    timer = setTimeout(() => finish(new Error('Google sign-in expired. Try again.')), timeoutMs);
    timer.unref?.();
    const url = new URL(authorize);
    url.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: `http://127.0.0.1:${port}/`, response_type: 'code',
      scope: SCOPE, state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent select_account' });
    return { url: url.href, result, cancel: () => finish(new Error('Google sign-in cancelled.')) };
  }
  return { start, refresh: (credentials, refresh) => exchange(credentials, { grant_type: 'refresh_token', refresh_token: refresh }) };
}

module.exports = { createGoogleAuth, SCOPE, endpoint };
