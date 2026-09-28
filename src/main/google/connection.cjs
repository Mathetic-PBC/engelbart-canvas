'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createGoogleAuth, endpoint } = require('./auth.cjs');

const WEEK = 7 * 24 * 60 * 60 * 1000;
const DOC = 'application/vnd.google-apps.document';
const MAX_PAGES = 10;
const signedOut = () => new Error('Connect Google Docs to see recent documents.');

// Account-wide metadata browser. No document bodies, library imports or builds.
function createGoogle({ settings = () => ({}), file, crypt = { available: () => false }, fetch = globalThis.fetch,
  auth = createGoogleAuth({ fetch }), api = 'https://www.googleapis.com/drive/v3/', openExternal = () => {},
  onChange = () => {}, onConnected = () => {}, now = Date.now } = {}) {
  const base = endpoint(api);
  let saved, pending = null, starting = null, refreshing = null, generation = 0, problem = '', persisted = false;
  const credentials = () => settings() || {};
  function load() {
    if (saved !== undefined) return saved;
    saved = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw.v === 1 && typeof raw.encrypted === 'string' && crypt.available()) {
        const next = JSON.parse(crypt.decrypt(raw.encrypted));
        if (next.clientId === credentials().clientId && typeof next.access === 'string' && next.access && typeof next.account?.id === 'string' && Number.isFinite(next.expiresAt)) {
          saved = next; persisted = true;
        }
      }
    } catch { /* missing or unreadable credentials mean signed out */ }
    return saved;
  }
  function remove() { if (file) fs.rmSync(file, { force: true }); }
  function keep(next) {
    saved = next; persisted = false;
    if (!file) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      if (!crypt.available()) { remove(); return; }
      const encrypted = crypt.encrypt(JSON.stringify(next));
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, encrypted }), { mode: 0o600 });
      fs.renameSync(temporary, file); persisted = true;
    } catch {
      // An old account must never reappear after a failed save of a new one.
      fs.rmSync(temporary, { force: true }); remove();
    }
  }
  function status() {
    const account = load()?.account || null;
    return { configured: !!credentials().clientId, connected: !!account, account, persisted: !!account && persisted,
      pending: pending ? { kind: 'browser' } : null, error: problem };
  }
  function changed() { try { onChange(status()); } catch { /* listeners do not break auth */ } }
  function cancel() {
    generation++; const previous = pending;
    pending = null; starting = null; problem = '';
    previous?.flow.cancel(); changed(); return status();
  }
  function disconnect() {
    // Delete credentials before reporting success. No remote account mutation.
    remove(); cancel(); saved = null; persisted = false; refreshing = null; changed(); return status();
  }
  function expire(ticket) {
    if (ticket !== generation) return;
    remove(); saved = null; persisted = false; generation++; refreshing = null;
    problem = 'Google sign-in expired or was revoked. Connect again.'; changed();
  }
  async function request(resource, params, access) {
    const url = new URL(resource, base);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, { headers: { authorization: `Bearer ${access}`, accept: 'application/json' },
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(20000) });
    return { status: response.status, ok: response.ok, data: await response.json().catch(() => null) };
  }
  function apiError(response) {
    if (response.status === 403) return new Error('Google denied access to document information. Check that the Drive API is enabled and access was granted, then reconnect.');
    if (response.status === 429) return new Error('Google is receiving too many requests. Try refreshing in a moment.');
    return new Error('Could not load Google Docs. Check your connection and try again.');
  }
  async function token(force = false) {
    const current = load(), ticket = generation;
    if (!current) throw signedOut();
    if (current.clientId !== credentials().clientId) { expire(ticket); throw signedOut(); }
    if (!force && current.expiresAt > now() + 60000) return current.access;
    if (refreshing) return refreshing;
    if (!current.refresh) { expire(ticket); throw signedOut(); }
    const job = (async () => {
      try {
        const tokens = await auth.refresh(credentials(), current.refresh);
        if (ticket !== generation) throw signedOut();
        keep({ ...current, access: tokens.access, refresh: tokens.refresh || current.refresh, expiresAt: now() + tokens.expiresIn * 1000 });
        changed(); return saved.access;
      } catch (error) { if (error.code === 'invalid_grant' || error.code === 'scope') expire(ticket); throw error; }
    })();
    refreshing = job;
    try { return await job; } finally { if (refreshing === job) refreshing = null; }
  }
  async function get(resource, params, ticket) {
    let access = await token();
    if (ticket !== generation) throw signedOut();
    let result = await request(resource, params, access);
    if (ticket !== generation) throw signedOut();
    if (result.status === 401) {
      // Another concurrent request may already have refreshed this access token.
      access = load()?.access !== access ? await token() : await token(true);
      if (ticket !== generation) throw signedOut();
      result = await request(resource, params, access);
      if (ticket !== generation) throw signedOut();
      if (result.status === 401) { expire(ticket); throw signedOut(); }
    }
    if (!result.ok || !result.data) throw apiError(result);
    return result.data;
  }
  async function connect() {
    if (load()) return status();
    if (pending) return status();
    if (starting) return starting;
    const chosen = credentials();
    if (!chosen.clientId) throw new Error('Google sign-in is not configured for this app. Set up a Google Desktop OAuth client first.');
    const ticket = ++generation;
    problem = '';
    const job = (async () => {
      const flow = await auth.start(chosen);
      if (ticket !== generation) { flow.cancel(); return status(); }
      pending = { flow }; changed();
      void flow.result.then(async tokens => {
        if (ticket !== generation) return;
        const result = await request('about', { fields: 'user(displayName,emailAddress,permissionId)' }, tokens.access);
        if (ticket !== generation) return;
        if (!result.ok) throw apiError(result);
        const user = result.data?.user;
        if (!user?.permissionId || !user?.emailAddress) throw new Error('Google did not return an account. Try connecting again.');
        keep({ clientId: chosen.clientId, access: tokens.access, refresh: tokens.refresh, expiresAt: now() + tokens.expiresIn * 1000,
          account: { id: String(user.permissionId), email: String(user.emailAddress).slice(0, 320), name: String(user.displayName || '').slice(0, 200) } });
        pending = null; problem = ''; changed(); onConnected();
      }).catch(error => {
        if (ticket !== generation) return;
        pending = null; problem = error.message; changed();
      });
      try { await openExternal(flow.url); }
      catch { if (ticket === generation) { cancel(); problem = 'Could not open your browser. Try connecting again.'; changed(); } }
      return status();
    })();
    starting = job;
    try { return await job; } finally { if (starting === job) starting = null; }
  }
  async function reopen() {
    if (!pending) throw new Error('No Google sign-in is waiting.');
    await openExternal(pending.flow.url); return true;
  }
  async function documents() {
    if (!load()) throw signedOut();
    const ticket = generation, accountId = saved.account.id;
    const since = new Date(now() - WEEK).toISOString(), docs = new Map(), seen = new Set();
    let pageToken = '', incomplete = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await get('files', {
        q: `trashed = false and mimeType = '${DOC}' and modifiedTime >= '${since}'`,
        spaces: 'drive', corpora: 'user', orderBy: 'modifiedTime desc', pageSize: '100',
        includeItemsFromAllDrives: 'true', supportsAllDrives: 'true',
        fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,trashed,resourceKey)', ...(pageToken ? { pageToken } : {}),
      }, ticket);
      if (!Array.isArray(data.files)) throw new Error('Google returned an invalid document list. Try refreshing.');
      for (const item of data.files) {
        if (!/^[\w-]+$/.test(item.id || '') || item.mimeType !== DOC || item.trashed || !Number.isFinite(Date.parse(item.modifiedTime)) || Date.parse(item.modifiedTime) < Date.parse(since)) continue;
        const url = new URL(`https://docs.google.com/document/d/${item.id}/edit`);
        if (typeof item.resourceKey === 'string' && item.resourceKey.length <= 256) url.searchParams.set('resourcekey', item.resourceKey);
        docs.set(item.id, { id: item.id, name: typeof item.name === 'string' ? item.name.slice(0, 512) : 'Untitled document', url: url.href, modifiedTime: item.modifiedTime });
      }
      incomplete ||= !!data.incompleteSearch;
      pageToken = typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
      if (!pageToken) break;
      if (seen.has(pageToken)) { incomplete = true; break; }
      seen.add(pageToken);
    }
    if (ticket !== generation) throw signedOut();
    return { accountId, since, documents: [...docs.values()].sort((a, b) => Date.parse(b.modifiedTime) - Date.parse(a.modifiedTime)), incomplete: incomplete || !!pageToken };
  }
  return { status, connect, cancel, disconnect, reopen, documents, close: cancel };
}

module.exports = { createGoogle, WEEK, DOC };
