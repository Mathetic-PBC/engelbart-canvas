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
//
// Linear and Evernote (2026-10-16, Hudson's Onboarding note: "we should add MCP support for Evernote and Linear") are
// signed in to the same way: both servers register clients dynamically and give refresh tokens (connect-sources has what
// each said when probed). Each asks for only its `scope` ('read'): the SDK otherwise asks for every scope the server
// lists, Evernote's write and delete among them.
//
// A sign-in that ends (K3, the same note: "MCP connections need their own token-refresh and authorization recovery"). Until
// now a refresh the server refused was taken by the SDK's auth() as a reason to sign in again, which a run can't do: the
// tokens were dropped and the connector looked never connected, so it was left out without a word; a token the person
// revoked, or one with no end given, was handed to agents as good. Now:
//   - a token near its end is refreshed (refreshAuthorization, one at a time per app: a refresh token used twice is
//     refused); a refusal (invalid_grant, invalid_client…) or no refresh token at all marks the connector `reconnect`
//   - check(app) asks the server itself (initialize, then tools/list) at most every five minutes, before a run's servers
//     are handed out: a 401 refreshes once and asks again, still refused is `reconnect` (reason 'revoked'); a 403, or a
//     server with none of the app's reading tools, is `unavailable` (Evernote's beta not open to the account): the app's
//     `fallback` ('web') is the route then
//   - what can't be told (offline, a 5xx, a timeout) changes nothing: the token is kept and used while it lasts
// status(app).state says which: 'connected' | 'signed-out' (never connected) | 'reconnect' | 'unavailable', with `action`
// ("Connect Linear") whenever a sign-in is what it needs. `connected` is state 'connected' alone.

const fs = require('node:fs');
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { auth, refreshAuthorization, discoverOAuthServerInfo, selectResourceURL } = require('@modelcontextprotocol/sdk/client/auth.js');
const { OAuthError, ServerError, TemporarilyUnavailableError, TooManyRequestsError } = require('@modelcontextprotocol/sdk/server/auth/errors.js');
const { APPS, shownName } = require('../../shared/connect-sources.cjs');

const CONNECTORS = Object.freeze(Object.fromEntries(Object.entries(APPS).filter(([, app]) => app.reach === 'connector')
  .map(([name, app]) => [name, Object.freeze({ url: app.mcp, server: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), scope: app.scope || null, fallback: app.fallback || null, reads: app.reads ? Object.freeze([...app.reads.list, ...app.reads.read]) : null })])));
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const REFRESH_EARLY_MS = 2 * 60_000;
const CHECK_KEEP_MS = 5 * 60_000;
const CHECK_TIMEOUT_MS = 15_000;

/** Whether a refresh's error is the server saying no (the grant or client refused), not a failure to ask it. */
const refusedBy = (error) => error instanceof OAuthError && !(error instanceof ServerError || error instanceof TemporarilyUnavailableError || error instanceof TooManyRequestsError);

/**
 * One look at an MCP server with a token: initialize, then tools/list → { status: 200, tools: [names] }, or the HTTP
 * status it refused with (401, 403…), 0 when it couldn't be asked (offline, a timeout, an answer that isn't MCP).
 */
async function probeServer({ url, token, fetchFn, timeoutMs = CHECK_TIMEOUT_MS }) {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport, StreamableHTTPError } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'Engelbart', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } }, ...(fetchFn ? { fetch: fetchFn } : {}) });
  try {
    await client.connect(transport, { timeout: timeoutMs });
    const listed = await client.listTools(undefined, { timeout: timeoutMs });
    return { status: 200, tools: ((listed && listed.tools) || []).map((tool) => tool.name) };
  } catch (error) {
    return { status: error instanceof StreamableHTTPError && error.code > 0 ? error.code : 0 };
  } finally {
    client.close().catch(() => {});
  }
}

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
 * fetch the OAuth requests use; `probe({ url, token, fetchFn })` how a server is asked (probeServer; tests). → { list,
 * status, check, signIn, cancel, signOut, accessToken, serversFor, serversForRun, reaches }
 */
function createConnectors({ file, crypt, openExternal, fetchFn = globalThis.fetch, now = Date.now, urls = {}, onChange = () => {}, own = null, probe = probeServer }) {
  const pending = new Map(); // app → { cancel, promise }
  const memory = new Map(); // app → what could not be written (no keychain): kept for this run only
  const refreshing = new Map(); // app → the refresh under way (a refresh token is used once)
  const checks = new Map(); // app → { at, promise } the last look at its server
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
    const keep = () => save(app, { client: held.client, redirectUrl: held.redirectUrl, tokens: held.tokens, obtainedAt: held.obtainedAt, discovery: held.discovery, lapsed: held.lapsed, unavailable: held.unavailable });
    return {
      get redirectUrl() { return redirectUrl; },
      get clientMetadata() { return { client_name: 'Engelbart', client_uri: 'https://engelbart.mathetic.com', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }; },
      ...(state ? { state: () => state } : {}),
      // A registration for another return address (the port moved) is no use: registered again.
      clientInformation: () => (held.client && held.redirectUrl === redirectUrl ? held.client : undefined),
      saveClientInformation: (info) => { held.client = info; held.redirectUrl = redirectUrl; keep(); },
      tokens: () => held.tokens,
      // New tokens: whatever ended or was refused before is past, and the server is asked again (check).
      saveTokens: (tokens) => { held.tokens = tokens; held.obtainedAt = now(); delete held.lapsed; delete held.unavailable; checks.delete(app); keep(); },
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

  /**
   * → { app, connected, state, reason, action?, fallback, refreshable, expiresAt, pending }. `state` 'connected',
   * 'signed-out' (never connected, or signed out), 'reconnect' (it was: `reason` 'expired', its token ended with nothing to
   * refresh it, or 'revoked', the server refused it), 'unavailable' (signed in, but the server refuses the account or has
   * no reading tools: `reason` 'refused' | 'no-tools'). `action` "Connect {app}" when a sign-in is what it needs.
   * `fallback` the app's other route ('web' for Evernote) or null.
   */
  function status(app) {
    const connector = CONNECTORS[app];
    if (!connector) throw new Error(`${app} has no connector`);
    const held = load(app) || {};
    const tokens = held.tokens;
    const has = !!(tokens && tokens.access_token);
    const expiresAt = has && Number(tokens.expires_in) > 0 ? (held.obtainedAt || 0) + Number(tokens.expires_in) * 1000 : null;
    const ended = !!(expiresAt && expiresAt <= now() && !tokens.refresh_token);
    const state = has && !ended ? (held.unavailable ? 'unavailable' : 'connected') : (held.lapsed || ended ? 'reconnect' : 'signed-out');
    const reason = state === 'unavailable' ? held.unavailable.reason || 'refused' : state === 'reconnect' ? (ended ? 'expired' : held.lapsed.reason || 'revoked') : null;
    return {
      app, connected: state === 'connected', state, reason,
      ...(state === 'reconnect' || state === 'signed-out' ? { action: `Connect ${shownName(app)}` } : {}),
      fallback: connector.fallback, refreshable: !!(tokens && tokens.refresh_token), expiresAt, pending: pending.has(app),
    };
  }

  /** Kept as it is but for `change` (lapsed, unavailable), told to onChange when the state moved. */
  function mark(app, change) {
    const before = status(app).state;
    const held = load(app) || {};
    const next = { ...held, ...change };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    save(app, next);
    if (status(app).state !== before) onChange(status(app));
  }
  /** Its sign-in can't be used any more (`reason` 'expired' | 'revoked'): the tokens go, the registration stays for the next. */
  function lapse(app, reason) {
    checks.delete(app);
    mark(app, { tokens: undefined, obtainedAt: undefined, unavailable: undefined, lapsed: { at: now(), reason } });
  }

  /**
   * The refresh token traded for new tokens → { ok, token } | { lapsed: 'expired' | 'revoked' } (the server said no, or
   * there is nothing to refresh with) | { unknown: true } (it couldn't be asked). One at a time per app.
   */
  function refresh(app) {
    if (refreshing.has(app)) return refreshing.get(app);
    const promise = (async () => {
      const held = load(app);
      if (!held || !held.tokens || !held.tokens.refresh_token || !held.client) return { lapsed: 'expired' };
      try {
        let discovery = held.discovery && held.discovery.authorizationServerUrl ? held.discovery : null;
        if (!discovery) {
          const info = await discoverOAuthServerInfo(urlOf(app), { fetchFn });
          discovery = { authorizationServerUrl: String(info.authorizationServerUrl), resourceMetadata: info.resourceMetadata, authorizationServerMetadata: info.authorizationServerMetadata };
        }
        const resource = await selectResourceURL(urlOf(app), {}, discovery.resourceMetadata);
        const tokens = await refreshAuthorization(discovery.authorizationServerUrl, { metadata: discovery.authorizationServerMetadata, clientInformation: held.client, refreshToken: held.tokens.refresh_token, resource, fetchFn });
        save(app, { ...(load(app) || held), discovery, tokens, obtainedAt: now() });
        return { ok: true, token: tokens.access_token };
      } catch (error) {
        return refusedBy(error) ? { lapsed: 'revoked' } : { unknown: true };
      }
    })().finally(() => { refreshing.delete(app); });
    refreshing.set(app, promise);
    return promise;
  }

  /** The access token, refreshed when it is about to end; a refusal lapses the connector. Null when there is none to use. */
  async function tokenOf(app) {
    const held = load(app);
    if (!held || !held.tokens || !held.tokens.access_token) return null;
    const lifetime = Number(held.tokens.expires_in) > 0 ? Number(held.tokens.expires_in) * 1000 : null;
    const endsAt = lifetime ? (held.obtainedAt || 0) + lifetime : null;
    if (!endsAt || endsAt - now() > REFRESH_EARLY_MS) return held.tokens.access_token;
    const out = await refresh(app);
    if (out.ok) return out.token;
    if (out.lapsed) { lapse(app, out.lapsed); return null; }
    return endsAt > now() ? held.tokens.access_token : null; // couldn't tell: the token while it lasts
  }

  /**
   * The connector's server asked whether its sign-in works (at most every five minutes, `force` now) → status(app), with
   * `unchecked: true` when the server couldn't be asked and nothing changed.
   */
  function check(app, { force = false } = {}) {
    if (!CONNECTORS[app]) return Promise.reject(new Error(`${app} has no connector`));
    const hit = checks.get(app);
    if (!force && hit && now() - hit.at < CHECK_KEEP_MS) return hit.promise;
    const promise = (async () => {
      const before = status(app);
      if (before.state === 'signed-out' || before.state === 'reconnect') return before;
      const token = await tokenOf(app);
      if (!token) return status(app);
      let seen = await probe({ url: urlOf(app), token, fetchFn }).catch(() => ({ status: 0 }));
      if (seen.status === 401) {
        const out = await refresh(app);
        if (out.lapsed) { lapse(app, 'revoked'); return status(app); }
        if (!out.ok) return { ...status(app), unchecked: true };
        seen = await probe({ url: urlOf(app), token: out.token, fetchFn }).catch(() => ({ status: 0 }));
        if (seen.status === 401) { lapse(app, 'revoked'); return status(app); }
      }
      const reads = CONNECTORS[app].reads;
      if (seen.status === 403) mark(app, { unavailable: { at: now(), reason: 'refused' } });
      else if (seen.status === 200 && reads && !(seen.tools || []).some((tool) => reads.includes(tool))) mark(app, { unavailable: { at: now(), reason: 'no-tools' } });
      else if (seen.status === 200) mark(app, { unavailable: undefined });
      else return { ...status(app), unchecked: true };
      return status(app);
    })();
    checks.set(app, { at: now(), promise });
    promise.catch(() => { checks.delete(app); });
    return promise;
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
        const scope = CONNECTORS[app].scope ? { scope: CONNECTORS[app].scope } : {};
        const first = await auth(provider, { serverUrl: urlOf(app), fetchFn, ...scope });
        if (first !== 'AUTHORIZED') {
          const code = await returned;
          await auth(provider, { serverUrl: urlOf(app), authorizationCode: code, fetchFn, ...scope });
        }
        // Signed in: the server is asked at once whether it takes the account (Evernote's beta), so the step that
        // follows knows whether to go on through it or through the app's fallback.
        return await check(app, { force: true });
      } finally {
        clearTimeout(timer);
        loop.close();
      }
    })().finally(() => { pending.delete(app); onChange(status(app)); });
    pending.set(app, { promise, cancel: () => cancel() });
    return promise;
  }

  /**
   * An access token for a run, refreshed when it is about to end; null when the person must sign in again (status says
   * 'reconnect' then, never connected) or the server refuses the account ('unavailable').
   */
  async function accessToken(app) {
    if (!CONNECTORS[app]) return null;
    const held = load(app);
    if (held && held.unavailable) return null;
    return tokenOf(app);
  }

  /**
   * The connectors among `apps` the person is signed in to, for an agent's run → [{ app, name, url, token }]. Each server
   * is asked first (check): one that refused the sign-in or the account is not handed out, and its status says why.
   */
  async function serversFor(apps) {
    const out = [];
    for (const app of [...new Set(apps || [])]) {
      if (!CONNECTORS[app]) continue;
      const seen = await check(app).catch(() => null);
      if (seen && !seen.connected) continue;
      const token = await accessToken(app);
      if (token) out.push({ app, name: CONNECTORS[app].server, url: urlOf(app), token });
    }
    return out;
  }

  /**
   * The servers an agent on `provider` gets for `apps` (round 3): Engelbart's sign-in where it has one, else the one the
   * person made in their own Claude Code or Codex (./own-connectors.cjs: no token of Engelbart's, their CLI's own).
   */
  async function serversForRun(apps, provider) {
    const mine = await serversFor(apps);
    const rest = (apps || []).filter((app) => CONNECTORS[app] && !mine.some((server) => server.app === app));
    const theirs = own && rest.length ? await own.serversFor(rest, provider).catch(() => []) : [];
    return [...mine, ...theirs];
  }

  /** Whether an agent on `provider` reaches `app` through a connector: Engelbart's sign-in or the person's own. */
  async function reaches(app, provider) {
    if (!CONNECTORS[app]) return false;
    if (status(app).connected) {
      const seen = await check(app).catch(() => null);
      if (!seen || seen.connected) return true;
    }
    return own ? own.reaches(app, provider).catch(() => false) : false;
  }

  return {
    list: () => Object.keys(CONNECTORS).map(status),
    status, check, signIn, serversFor, serversForRun, reaches, accessToken,
    cancel: (app) => { const held = pending.get(app); if (held) held.cancel(); },
    signOut: (app) => { if (!CONNECTORS[app]) throw new Error(`${app} has no connector`); memory.delete(app); checks.delete(app); save(app, null); onChange(status(app)); return status(app); },
  };
}

module.exports = { CONNECTORS, createConnectors, NeedsSignIn, listen, probeServer, refusedBy };
