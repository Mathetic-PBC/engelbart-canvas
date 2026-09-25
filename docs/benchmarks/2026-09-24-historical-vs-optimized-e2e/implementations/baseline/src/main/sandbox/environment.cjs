'use strict';

const { randomUUID } = require('node:crypto');
const { githubRepo, runStore } = require('./runs.cjs');
const { isEnvironmentName } = require('../../shared/environment.cjs');

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length > 200) throw new Error('Use at most 200 environment variables.');
  const seen = new Set();
  let bytes = 0;
  for (const change of changes) {
    if (!change || typeof change !== 'object' || !isEnvironmentName(change.name)) throw new Error('Use a valid application environment name (letters, digits, underscores). Runner configuration names are reserved.');
    if (seen.has(change.name)) throw new Error('Each environment name must be unique.');
    seen.add(change.name);
    if (change.value !== null && (typeof change.value !== 'string' || change.value.includes('\0') || change.value.length > 16384)) throw new Error('Environment values must be text of at most 16,384 characters.');
    bytes += Buffer.byteLength(change.value || '');
  }
  if (bytes > 128 * 1024) throw new Error('Environment values exceed 128 KB.');
  return changes;
}

function environmentStore(db, secure) {
  const available = () => {
    if (!secure?.isEncryptionAvailable() || secure.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure storage is unavailable. Unlock your system keychain before saving or launching with environment variables.');
  };
  async function read(libraryId) {
    if (!githubRepo((await db.get(libraryId))?.url)) throw new Error('Choose a saved GitHub repository.');
    const row = (await db.query('select * from sandbox_environments where library_id = $1', [libraryId]))[0];
    if (!row) return { revision: null, values: {}, removed: [] };
    available();
    let payload;
    try { payload = JSON.parse(secure.decryptString(Buffer.from(row.encrypted, 'base64'))); }
    catch { throw new Error('Saved environment could not be unlocked. Check your system keychain.'); }
    return { revision: row.revision, ...payload };
  }
  async function describe(libraryId) {
    const { revision, values, removed } = await read(libraryId);
    return { revision, names: Object.keys(values).sort(), removed, report: await runStore(db).environment(libraryId) };
  }
  async function save(libraryId, changes, expectedRevision) {
    validateChanges(changes);
    const current = await read(libraryId);
    if (current.revision !== expectedRevision) throw new Error('Environment changed elsewhere. Reload the environment panel before saving.');
    if (!changes.length) return describe(libraryId);
    available();
    const values = { ...current.values }, removed = new Set(current.removed);
    for (const { name, value } of changes) {
      if (value === null) { delete values[name]; removed.add(name); }
      else { values[name] = value; removed.delete(name); }
    }
    if (Object.keys(values).length > 200 || removed.size > 500 || Buffer.byteLength(JSON.stringify(values)) > 128 * 1024) throw new Error('Too many environment values or removals.');
    const encrypted = secure.encryptString(JSON.stringify({ values, removed: [...removed] })).toString('base64');
    await db.query(`insert into sandbox_environments (library_id, revision, encrypted) values ($1, $2, $3)
      on conflict (library_id) do update set revision = excluded.revision, encrypted = excluded.encrypted, updated_at = now()`, [libraryId, randomUUID(), encrypted]);
    return describe(libraryId);
  }
  return { read, describe, save };
}

// Redact strings before serialization, including nested structured event data.
function redact(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]));
  return value;
}

function redactOutput(text, secrets) {
  text = redact(String(text), secrets);
  // Output callbacks can split a value between chunks. Suppress matching
  // boundary fragments as well as whole values before truncation/persistence.
  for (const secret of secrets.filter(Boolean)) {
    for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
      if (text.endsWith(secret.slice(0, n))) { text = text.slice(0, -n) + '[redacted]'; break; }
    }
    for (let n = Math.min(secret.length - 1, text.length); n > 0; n--) {
      if (text.startsWith(secret.slice(-n))) { text = '[redacted]' + text.slice(n); break; }
    }
  }
  return text;
}

function redactEvent(event, secrets) {
  const safe = { ...event };
  // IDs, URLs and protocol discriminants must never be rewritten when a short
  // app value happens to match part of them. Only output fields carry logs.
  for (const key of ['message', 'error', 'data']) if (key in safe) safe[key] = redact(safe[key], secrets);
  return safe;
}

module.exports = { environmentStore, validateChanges, redact, redactOutput, redactEvent };
