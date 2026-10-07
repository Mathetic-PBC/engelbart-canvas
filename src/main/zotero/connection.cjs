'use strict';

// Zotero access (MATH-65): browser sign-in through the server broker (./browser-auth.cjs), then the Web API key kept in
// main, encrypted with the system keychain in <dataRoot>/zotero.json, as github.json keeps GitHub's token. Zotero keys
// do not expire, so there is no refresh; disconnecting deletes the file and revokes the key. The key never leaves this
// module except as a request header to api.zotero.org: status() carries the account's name, never the key. The older
// zotero-browser.json (a web session from another branch) is not read or touched.

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.zotero.org';
const TIMEOUT_MS = 15000;

class ZoteroError extends Error {
  constructor(message, code = 'zotero') { super(message); this.code = code; }
}

function createZotero({
  fetch = globalThis.fetch,
  file,
  crypt = { available: () => false, encrypt: () => { throw new Error('no keychain'); }, decrypt: () => { throw new Error('no keychain'); } },
  browserAuth = () => null,
  openAuthorize = () => {},
  onConnected = () => {},
  onChange = () => {},
  api = API,
} = {}) {
  let saved; // undefined: not read yet; null: signed out; else { userID, username, key }
  let pending = null; // { kind: 'browser', expiresAt, url, cancel }
  let problem = '';
  let persisted = true;
  let starting = null;
  let generation = 0;

  const changed = () => { try { onChange(status()); } catch { /* a listener never breaks the flow */ } };

  async function call(method, key) {
    const response = await fetch(`${api}/keys/current`, {
      method,
      headers: { 'zotero-api-key': key, 'zotero-api-version': '3', accept: 'application/json' },
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let data = null;
    if (method === 'GET') { try { data = await response.json(); } catch { data = null; } }
    return { status: response.status, ok: response.ok, data };
  }

  /* ------------------------------------------------------------- storage */

  // `file` may be a function: the sign-in then follows it (one per data root), read again whenever it names another file.
  let savedFor = null;
  const fileNow = () => (typeof file === 'function' ? file() : file);

  function load() {
    const at = fileNow();
    if (saved !== undefined && savedFor === at) return saved;
    savedFor = at;
    saved = null;
    if (!at) return saved;
    try {
      const raw = JSON.parse(fs.readFileSync(at, 'utf8'));
      if (raw && raw.v === 1 && typeof raw.key === 'string' && crypt.available()) {
        saved = { userID: String(raw.userID || ''), username: String(raw.username || ''), key: crypt.decrypt(raw.key) };
      }
    } catch {
      saved = null; // missing, unreadable, or encrypted by another keychain: signed out
    }
    return saved;
  }

  function keep(next) {
    saved = next;
    const at = fileNow();
    savedFor = at;
    persisted = !!at && crypt.available();
    if (!persisted) return;
    const out = { v: 1, userID: next.userID, username: next.username, key: crypt.encrypt(next.key) };
    fs.mkdirSync(path.dirname(at), { recursive: true });
    const temporary = `${at}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, at);
  }

  function forget(reason = '') {
    saved = null;
    const at = fileNow();
    savedFor = at;
    if (at) { try { fs.rmSync(at, { force: true }); } catch { /* already gone */ } }
    problem = reason;
  }

  /* -------------------------------------------------------------- status */

  function status() {
    const account = load();
    return {
      configured: !!browserAuth(),
      connected: !!account,
      username: account ? account.username : '',
      userID: account ? account.userID : '',
      persisted: account ? persisted : true,
      pending: pending ? { kind: 'browser', expiresAt: pending.expiresAt } : null,
      error: problem,
    };
  }

  /* -------------------------------------------------------------- sign-in */

  /** Starts signing in (or opens the browser again for a sign-in already waiting). Answers the status. */
  function connect() {
    if (!starting) starting = begin().finally(() => { starting = null; });
    return starting;
  }

  async function begin() {
    const browser = browserAuth();
    if (!browser) throw new ZoteroError('Zotero sign-in is not available.', 'unconfigured');
    if (pending && Date.now() < pending.expiresAt) { await openAuthorize(pending.url); return status(); }
    if (pending) pending.cancel();
    const attempt = ++generation;
    problem = '';
    const auth = await browser.start();
    if (attempt !== generation) { auth.cancel(); return status(); }
    const flow = { kind: 'browser', url: auth.url, expiresAt: auth.expiresAt, cancel: auth.cancel };
    pending = flow;
    changed();
    void auth.result.then(async (credentials) => {
      if (pending !== flow) return;
      await accept(credentials, () => pending === flow);
      if (pending !== flow) return;
      pending = null; problem = ''; changed(); onConnected();
    }).catch((error) => {
      if (pending !== flow) return;
      pending = null; problem = error.message; changed();
    });
    try { await openAuthorize(flow.url); }
    catch (error) { cancel(); problem = 'Could not open your browser. Try signing in again.'; changed(); throw error; }
    return status();
  }

  /** A key arrived from the broker: ask Zotero whose it is, then keep it. A key Zotero will not vouch for is revoked. */
  async function accept({ key, userID }, active = () => true) {
    let who;
    try { who = await call('GET', key); }
    catch { await revoke(key); throw new ZoteroError('Could not reach Zotero to check the sign-in. Try again.', 'network'); }
    const data = who.data || {};
    if (!who.ok || String(data.userID ?? '') !== String(userID)) {
      await revoke(key);
      throw new ZoteroError('Zotero did not accept the sign-in. Try again.', 'key');
    }
    if (!active()) { await revoke(key); return; }
    keep({ userID: String(userID), username: typeof data.username === 'string' ? data.username : '', key });
  }

  /** Revokes a key on Zotero's side; whether it worked or not changes nothing here. */
  async function revoke(key) {
    try { await call('DELETE', key); } catch { /* offline or already revoked: disconnected all the same */ }
  }

  function cancel() {
    generation += 1;
    if (!pending) return status();
    const flow = pending;
    pending = null;
    flow.cancel();
    changed();
    return status();
  }

  /** Forgets the key (the file goes first) and revokes it with Zotero; a revoke that fails still disconnects. */
  async function disconnect() {
    cancel();
    const account = load();
    forget('');
    changed();
    if (account) await revoke(account.key);
    return status();
  }

  /* ------------------------------------------------------------------ key */

  /** The API key, for main's own requests to api.zotero.org (the next build's library reads), or null when signed out. */
  function key() {
    const account = load();
    return account ? account.key : null;
  }

  return { status, connect, cancel, disconnect, key };
}

module.exports = { createZotero, ZoteroError, API };
