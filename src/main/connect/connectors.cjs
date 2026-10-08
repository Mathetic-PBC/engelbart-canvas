'use strict';

// Connect your library (2026-10-07, second build): the apps reached through their own MCP servers, Granola and Notion
// (connect-sources reach 'connector'). Granola keeps its notes encrypted on this Mac and has no web app, so its official
// server (https://mcp.granola.ai/mcp) is the one way in that needs nothing of the person but a click: "the interface should
// have buttons that allow the user to authenticate different things for the agents as needed" (the Onboarding brainstorm).
//
// Engelbart signs in as an MCP client does (OAuth 2.1 with PKCE, the client registered dynamically), with the MCP SDK's
// own auth(): discovery from the server's metadata, registration, the sign-in page opened in the person's browser, the code
// back on a loopback port, the tokens, and refreshing them later. Tokens are kept per data root, encrypted with the
// system keychain (safeStorage, as github.json and zotero.json are), in <dataRoot>/connectors.json. An import agent is
// given the server and a fresh access token for its run only (./agents.cjs): Claude Code as an http MCP server with an
// Authorization header, Codex as a streamable-HTTP server whose bearer token is read from its environment.

const fs = require('node:fs');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { auth } = require('@modelcontextprotocol/sdk/client/auth.js');
const { APPS } = require('../../shared/connect-sources.cjs');

const CONNECTORS = Object.freeze(Object.fromEntries(Object.entries(APPS).filter(([, app]) => app.reach === 'connector')
  .map(([name, app]) => [name, Object.freeze({ url: app.mcp, server: name.toLowerCase().replace(/[^a-z0-9]+/g, '-') })])));
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_EARLY_MS = 2 * 60_000;

class NeedsSignIn extends Error {
  constructor(app) { super(`Sign in to ${app} again`); this.code = 'NEEDS_SIGN_IN'; }
}

const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A loopback server for the sign-in's return: 127.0.0.1 and, on the same port, ::1 (localhost may be either). */
async function listen(preferred, onRequest) {
  const servers = [];
  const make = () => { const server = http.createServer(onRequest); server.requestTimeout = 10_000; server.headersTimeout = 10_000; return server; };
  const bind = (server, port, host) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(server.address().port); }); });
  let port;
  const first = make();
  try { port = await bind(first, preferred || 0, '127.0.0.1'); } catch { port = await bind(first, 0, '127.0.0.1'); }
  servers.push(first);
  const second = make();
  try { await bind(second, port, '::1'); servers.push(second); } catch { /* no IPv6 loopback: 127.0.0.1 answers localhost */ }
  return { port, close: () => { for (const server of servers) { try { server.close(); server.closeAllConnections(); } catch { /* closed */ } } } };
}

/**
 * `file()`: where the tokens are kept for the data root in use; `crypt` { available, encrypt, decrypt } (safeStorage);
 * `openExternal(url)` the person's browser; `urls` { [app]: server url } in place of the real ones (tests); `fetchFn` the
 * fetch the OAuth requests use. → { list, status, signIn, cancel, signOut, accessToken, serversFor }
 */
function createConnectors({ file, crypt, openExternal, fetchFn = globalThis.fetch, now = Date.now, urls = {}, onChange = () => {} }) {
  const pending = new Map(); // app → { cancel, promise }
  const memory = new Map(); // app → what could not be written (no keychain): kept for this run only
  const urlOf = (app) => urls[app] || CONNECTORS[app].url;

  function readAll() {
    try { const value = JSON.parse(fs.readFileSync(file(), 'utf8')); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
  }
  function load(app) {
    if (memory.has(app)) return memory.get(app);
    const sealed = readAll()[app];
    if (typeof sealed !== 'string') return null;
    try { return JSON.parse(crypt.decrypt(sealed)); } catch { return null; }
  }
  function save(app, value) {
    if (!crypt || !crypt.available()) { if (value) memory.set(app, value); else memory.delete(app); return; }
    const all = readAll();
    if (value) all[app] = crypt.encrypt(JSON.stringify(value)); else delete all[app];
    fs.writeFileSync(file(), `${JSON.stringify(all, null, 1)}\n`, { mode: 0o600 });
  }

  /** The SDK's view of one app's sign-in: what is kept, saved as the SDK hands it over. */
  function providerFor(app, { redirectUrl, interactive = false, state = null, onRedirect = () => {} }) {
    const held = load(app) || {};
    const keep = () => save(app, { client: held.client, redirectUrl: held.redirectUrl, tokens: held.tokens, obtainedAt: held.obtainedAt, discovery: held.discovery });
    return {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() { return { client_name: 'Engelbart', client_uri: 'https://engelbart.mathetic.com', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
      ...(state ? { state: () => state } : {}),
      // A registration for another return address (the port moved) is no use: registered again.
      clientInformation: () => (held.client && held.redirectUrl === redirectUrl ? held.client : undefined),
      saveClientInformation: (info) => { held.client = info; held.redirectUrl = redirectUrl; keep(); },
      tokens: () => held.tokens,
      saveTokens: (tokens) => { held.tokens = tokens; held.obtainedAt = now(); keep(); },
      redirectToAuthorization: (url) => { if (!interactive) throw new NeedsSignIn(app); onRedirect(url); },
      saveCodeVerifier: (verifier) => { held.verifier = verifier; },
      codeVerifier: () => held.verifier,
      discoveryState: () => held.discovery,
      saveDiscoveryState: (value) => { held.discovery = value; keep(); },
      invalidateCredentials: (scope) => {
        if (scope === 'all' || scope === 'tokens') delete held.tokens;
        if (scope === 'all' || scope === 'client') delete held.client;
        if (scope === 'all' || scope === 'discovery') delete held.discovery;
        keep();
      },
    };
  }

  function status(app) {
    if (!CONNECTORS[app]) throw new Error(`${app} has no connector`);
    const held = load(app);
    const tokens = held && held.tokens;
    const expiresAt = tokens && Number(tokens.expires_in) > 0 ? (held.obtainedAt || 0) + Number(tokens.expires_in) * 1000 : null;
    return { app, connected: !!(tokens && tokens.access_token), refreshable: !!(tokens && tokens.refresh_token), expiresAt, pending: pending.has(app) };
  }

  /**
   * The sign-in: the app's page opened in the person's browser, their consent, the code back on the loopback port, the
   * tokens kept. Resolves with the status once done; rejects when cancelled, refused or after ten minutes.
   */
  function signIn(app) {
    if (!CONNECTORS[app]) return Promise.reject(new Error(`${app} has no connector`));
    if (pending.has(app)) return pending.get(app).promise;
    let cancel = () => {};
    const promise = (async () => {
      const state = randomBytes(24).toString('base64url');
      let settle;
      const returned = new Promise((resolve, reject) => { settle = { resolve, reject }; });
      returned.catch(() => {});
      const held = load(app) || {};
      const preferred = (() => { try { return Number(new URL(held.redirectUrl).port) || 0; } catch { return 0; } })();
      const answer = (res, code, text) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'" }); res.end(`<!doctype html><meta charset="utf-8"><title>Engelbart</title><h1>${text}</h1><p>You can close this tab and go back to Engelbart.</p>`); };
      const loop = await listen(preferred, (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method !== 'GET' || url.pathname !== '/callback') { answer(res, 404, 'Not found'); return; }
        if (!same(url.searchParams.get('state'), state)) { answer(res, 400, 'This sign-in is not the one Engelbart started'); return; }
        if (url.searchParams.get('error')) { answer(res, 200, `${app} sign-in cancelled`); settle.reject(new Error(`${app} sign-in was cancelled`)); return; }
        const code = url.searchParams.get('code');
        if (!code || code.length > 4096) { answer(res, 400, 'Sign-in callback without a code'); return; }
        answer(res, 200, `${app} is connected`);
        settle.resolve(code);
      });
      const timer = setTimeout(() => settle.reject(new Error(`${app} sign-in expired. Try again.`)), SIGN_IN_TIMEOUT_MS);
      cancel = () => settle.reject(new Error(`${app} sign-in was cancelled`));
      onChange(status(app));
      try {
        const redirectUrl = `http://localhost:${loop.port}/callback`;
        const provider = providerFor(app, { redirectUrl, interactive: true, state, onRedirect: (url) => { void Promise.resolve(openExternal(url.href)).catch((error) => settle.reject(error)); } });
        const first = await auth(provider, { serverUrl: urlOf(app), fetchFn });
        if (first !== 'AUTHORIZED') {
          const code = await returned;
          await auth(provider, { serverUrl: urlOf(app), authorizationCode: code, fetchFn });
        }
        return status(app);
      } finally {
        clearTimeout(timer);
        loop.close();
      }
    })().finally(() => { pending.delete(app); onChange(status(app)); });
    pending.set(app, { promise, cancel: () => cancel() });
    return promise;
  }

  /** An access token for a run, refreshed when it is about to end; null when the person must sign in again. */
  async function accessToken(app) {
    if (!CONNECTORS[app]) return null;
    const held = load(app);
    if (!held || !held.tokens || !held.tokens.access_token) return null;
    const lifetime = Number(held.tokens.expires_in) > 0 ? Number(held.tokens.expires_in) * 1000 : null;
    if (!lifetime || (held.obtainedAt || 0) + lifetime - now() > REFRESH_EARLY_MS) return held.tokens.access_token;
    if (!held.tokens.refresh_token) return null;
    try {
      await auth(providerFor(app, { redirectUrl: held.redirectUrl }), { serverUrl: urlOf(app), fetchFn });
      const fresh = load(app);
      return fresh && fresh.tokens ? fresh.tokens.access_token : null;
    } catch { return null; }
  }

  /** The connectors among `apps` the person is signed in to, for an agent's run → [{ app, name, url, token }]. */
  async function serversFor(apps) {
    const out = [];
    for (const app of [...new Set(apps || [])]) {
      if (!CONNECTORS[app]) continue;
      const token = await accessToken(app);
      if (token) out.push({ app, name: CONNECTORS[app].server, url: urlOf(app), token });
    }
    return out;
  }

  return {
    list: () => Object.keys(CONNECTORS).map(status),
    status, signIn, serversFor, accessToken,
    cancel: (app) => { const held = pending.get(app); if (held) held.cancel(); },
    signOut: (app) => { if (!CONNECTORS[app]) throw new Error(`${app} has no connector`); memory.delete(app); save(app, null); onChange(status(app)); return status(app); },
  };
}

module.exports = { CONNECTORS, createConnectors, NeedsSignIn, listen };
