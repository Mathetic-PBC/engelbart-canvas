'use strict';

// Connect your library (2026-10-07, second build): Cursor's chats on this Mac. Cursor keeps its composer and chat panes in
// one SQLite database (~/Library/Application Support/Cursor/User/globalStorage/state.vscdb, often hundreds of MB): table
// cursorDiskKV, `composerData:<id>` a chat's head (name, createdAt, lastUpdatedAt, the ids of its turns in order) and
// `bubbleId:<chat id>:<turn id>` one turn ({ type: 1 the person, 2 Cursor; text }). Read in place, read-only (node:sqlite,
// as ../browser/import-cookies.cjs reads a browser's cookies); nothing is ever written to it. Checked on Cursor's layout of
// 2026-10 (a Mac with 562 chats); an older or newer layout fails with a plain error, which the agent says in its reply.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const DAY_MS = 86_400_000;
const ID_RE = /^[0-9a-f-]{8,64}$/i;
const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

const cursorDb = (homeDir = os.homedir()) => path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');

function open(homeDir) {
  const file = cursorDb(homeDir);
  if (!fs.existsSync(file)) throw new Error('Cursor has no chats on this Mac');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { throw new Error('This copy of Engelbart cannot read Cursor\'s database'); }
  try { return new DatabaseSync(file, { readOnly: true }); } catch (error) { throw new Error(`Cursor's database could not be opened (${String(error.message).slice(0, 120)})`); }
}

const parse = (value) => { try { return JSON.parse(typeof value === 'string' ? value : Buffer.from(value).toString('utf8')); } catch { return null; } };

/** Cursor's chats, newest first → [{ id, title, first, date, turns }]: changed in `days`, matching `query`, at most `limit`. */
function cursorChats(homeDir, { days = null, query = '', limit = 200 } = {}) {
  const db = open(homeDir);
  try {
    const since = Number.isFinite(days) && days > 0 ? Date.now() - days * DAY_MS : 0;
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const firstOf = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const rows = [];
    for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
      const head = parse(row.value);
      const turns = head && Array.isArray(head.fullConversationHeadersOnly) ? head.fullConversationHeadersOnly : [];
      if (!head || !turns.length) continue;
      const id = String(head.composerId || row.key.slice('composerData:'.length));
      const updated = Number(head.lastUpdatedAt || head.createdAt) || 0;
      if (since && updated < since) continue;
      rows.push({ id, name: head.name || '', updated, turns: turns.length, firstTurn: (turns.find((turn) => turn.type === 1) || {}).bubbleId });
    }
    rows.sort((a, b) => b.updated - a.updated);
    const out = [];
    for (const entry of rows) {
      const bubble = entry.firstTurn ? parse((firstOf.get(`bubbleId:${entry.id}:${entry.firstTurn}`) || {}).value) : null;
      const first = clip(bubble && bubble.text, 300);
      const chat = { id: entry.id, title: clip(entry.name || first || 'Cursor chat', 120), first, project: '', date: entry.updated ? new Date(entry.updated).toISOString() : null, turns: entry.turns };
      if (words.length && !words.every((word) => `${chat.title} ${chat.first}`.toLowerCase().includes(word))) continue;
      out.push(chat);
      if (out.length >= limit) break;
    }
    return out;
  } finally { db.close(); }
}

/** One Cursor chat as turns of text → { title, project, date, turns: [{ role, text }] }. */
function cursorTranscript(homeDir, id) {
  if (!ID_RE.test(String(id || ''))) throw new Error(`No Cursor chat ${id}`);
  const db = open(homeDir);
  try {
    const head = parse((db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`composerData:${id}`) || {}).value);
    if (!head) throw new Error(`No Cursor chat ${id}`);
    const bubble = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
    const turns = [];
    for (const header of Array.isArray(head.fullConversationHeadersOnly) ? head.fullConversationHeadersOnly : []) {
      const value = parse((bubble.get(`bubbleId:${id}:${header.bubbleId}`) || {}).value);
      const text = String((value && value.text) || '').trim();
      if (!text) continue;
      const role = (value.type || header.type) === 1 ? 'user' : 'assistant';
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.text = `${last.text}\n\n${text}`; else turns.push({ role, text });
    }
    const updated = Number(head.lastUpdatedAt || head.createdAt) || 0;
    return { title: clip(head.name || (turns[0] || {}).text || 'Cursor chat', 120), project: '', date: updated ? new Date(updated).toISOString() : null, turns };
  } finally { db.close(); }
}

module.exports = { cursorDb, cursorChats, cursorTranscript };
