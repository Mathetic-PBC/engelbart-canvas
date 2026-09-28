'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { dateWindow } = require('./browser-reader.cjs');

// Stage owns authentication. This module persists only opt-in and an encrypted
// local metadata cache; it never reads, exports or duplicates browser cookies.
function createGoogleBrowser({ reader, file, crypt = { available: () => false }, openStage, onChange = () => {}, now = Date.now, pollMs = 1800 } = {}) {
  let enabled = false, account = null, user = '0', list = null, updatedAt = 0, persisted = false;
  let generation = 0, pending = null, job = null, controller = null, timer = null, error = '';
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    enabled = saved.v === 1 && saved.enabled === true;
    if (enabled && saved.encrypted && crypt.available()) {
      const data = JSON.parse(crypt.decrypt(saved.encrypted));
      if (typeof data.account?.id === 'string' && typeof data.account.email === 'string' && Array.isArray(data.list?.documents)) {
        account = data.account; user = data.user; list = data.list; updatedAt = data.updatedAt; persisted = true;
      }
    }
  } catch { /* missing cache is a fresh connection */ }
  function status() {
    return { configured: true, method: 'stage', connected: enabled && !!account, account: enabled ? account : null,
      persisted: enabled && persisted, pending: pending ? { kind: 'stage' } : null, loading: !!controller, error, updatedAt };
  }
  const changed = () => { try { onChange(status()); } catch { /* listener errors don't affect the connection */ } };
  function save() {
    persisted = false;
    if (!file) return;
    if (!enabled) { fs.rmSync(file, { force: true }); return; }
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      const encrypted = account && crypt.available() ? crypt.encrypt(JSON.stringify({ account, user, list, updatedAt })) : null;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ v: 1, enabled: true, encrypted }), { mode: 0o600 });
      fs.renameSync(temporary, file); persisted = !!encrypted;
    } catch { fs.rmSync(temporary, { force: true }); fs.rmSync(file, { force: true }); }
  }
  function invalidate() {
    generation++; clearTimeout(timer); timer = null;
    controller?.abort(); controller = null; job = null;
  }
  async function refresh() {
    if (!enabled) throw new Error('Connect Google Docs to see recent documents.');
    if (job) return job;
    const ticket = generation;
    const abort = controller = new AbortController();
    error = ''; changed();
    const current = (async () => {
      // Follow an account deliberately selected in Stage, including /u/1 etc.
      const stage = await reader.stageAccount();
      if (ticket !== generation) throw new Error('Google connection cancelled.');
      if (stage) user = stage.user;
      const result = await reader.read({ user, since: dateWindow(now()), signal: abort.signal });
      if (ticket !== generation) throw new Error('Google connection cancelled.');
      account = result.account; user = result.user; updatedAt = now();
      list = { accountId: account.id, since: result.since, documents: result.documents, incomplete: result.incomplete, updatedAt, dateFiltered: true };
      pending = null; error = ''; clearTimeout(timer); save(); changed();
      return list;
    })();
    job = current;
    try { return await current; }
    catch (failure) {
      if (ticket === generation) {
        if (failure.code === 'login') { account = null; list = null; updatedAt = 0; save(); }
        error = failure.message; changed();
      }
      throw failure;
    } finally { if (job === current) { job = null; controller = null; changed(); } }
  }
  function watchSignIn(ticket, until) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (ticket !== generation || !pending) return;
      if (now() >= until) { pending = null; error = 'Sign-in is still waiting. Open Google Drive in Stage and connect again.'; changed(); return; }
      try {
        if (await reader.stageAccount()) await refresh();
      } catch { /* keep the user's sign-in open; errors are visible in Connections */ }
      // A failed listing needs an explicit retry, not another hidden load every
      // poll interval while the UI still claims it is waiting for sign-in.
      if (ticket === generation && pending && !error) watchSignIn(ticket, until);
    }, pollMs);
    timer.unref?.();
  }
  async function connect() {
    if (pending) { await reopen(); return status(); }
    invalidate(); enabled = true; error = ''; pending = { key: `google:connect:${now()}:${generation}` };
    const ticket = generation;
    try {
      const stage = await reader.stageAccount();
      if (ticket !== generation) return status();
      if (stage) user = stage.user;
      save(); changed();
      await openStage(reader.searchUrl(user, dateWindow(now())), pending.key);
      if (ticket === generation) watchSignIn(ticket, now() + 10 * 60 * 1000);
    } catch (failure) { if (ticket === generation) { pending = null; error = failure.message; changed(); } }
    return status();
  }
  async function reopen() {
    await openStage(reader.searchUrl(user, dateWindow(now())), pending?.key);
    error = ''; changed();
    if (enabled && pending) watchSignIn(generation, now() + 10 * 60 * 1000);
    else if (enabled) void refresh().catch(() => {});
    return true;
  }
  function cancel() {
    invalidate(); pending = null; error = '';
    if (!account) { enabled = false; list = null; save(); }
    changed(); return status();
  }
  function disconnect() {
    // Disconnect the catalog only. Do not sign the user out of other Stage tabs.
    if (file) fs.rmSync(file, { force: true });
    invalidate(); enabled = false; account = null; list = null; pending = null; updatedAt = 0; persisted = false; error = '';
    changed(); return status();
  }
  async function documents(force = false) {
    if (!enabled) throw new Error('Connect Google Docs to see recent documents.');
    if (!force && list && list.since === dateWindow(now()) && now() - updatedAt < 60000) return list;
    return refresh();
  }
  function openDocument(id) {
    if (typeof id !== 'string' || !enabled || !account) throw new Error('Connect Google Docs first.');
    const doc = list?.documents.find(item => item.id === id);
    if (!doc) throw new Error('This document is no longer in the list. Refresh Google Docs.');
    return openStage(doc.url);
  }
  function resume() { if (enabled) void refresh().catch(() => {}); }
  return { status, connect, cancel, disconnect, reopen, documents, openDocument, resume, close: invalidate };
}
module.exports = { createGoogleBrowser };
