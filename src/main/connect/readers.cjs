'use strict';

// Connect your library (2026-10-07; every library since 2026-10-08): what Engelbart reads on this Mac for the interviewer's
// first look (./scan.cjs) and the import agents' tools (./tools.cjs). Everything here only reads; nothing is written
// except a private copy of a browser's History database (it is locked while the browser runs), deleted after the query.
//   folders      an overview (counts per top folder, the daily-notes folder), the note files under one
//   Obsidian     its vaults, from obsidian.json
//   AI chats     Claude Code (~/.claude/projects/*/*.jsonl) and Codex (~/.codex/sessions/**/rollout-*.jsonl) sessions,
//                and the conversations.json of a Claude or ChatGPT export: listed by title and first prompt, read as
//                turns of text (tool calls, thinking and tool output left out). Runs started by a program (Claude Code's
//                sdk entry points, `codex exec`, Codex subagents) are marked `automated` and left out unless asked for.
//   websites     a Chromium browser's history (top sites or pages) and bookmarks, and the links written in notes
//   Zotero       the collections and items of the mirror Engelbart keeps (../zotero/sync.cjs)
//   PDFs         the folders that hold PDFs (Downloads, Documents, Desktop, iCloud Drive…) with counts, a few titles and
//                a rough guess of what kind of PDFs each holds, and the PDFs under one folder (2026-10-08, "Agent
//                onboarding": papers on this Mac, asked about by folder and kind, never one by one)

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const { authorsOf } = require('../zotero/mirror.cjs');

const SKIP_DIRS = new Set(['.git', 'node_modules', '.obsidian', '.trash', '__pycache__', '.venv', 'venv', '.cache', '.Trash']);
const NOTE_EXT = new Set(['.md', '.markdown', '.txt']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic']);
const DATED_RE = /^\d{4}-\d{2}-\d{2}/;
const DAY_MS = 86_400_000;

const statOf = (file) => { try { return fs.statSync(file); } catch { return null; } };
const isDir = (dir) => { const stat = statOf(dir); return !!(stat && stat.isDirectory()); };
const shownPath = (homeDir, file) => (homeDir && file.startsWith(homeDir + path.sep) ? `~${file.slice(homeDir.length)}` : file);
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const clip = (text, max) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const cutoff = (days) => (Number.isFinite(days) && days > 0 ? Date.now() - days * DAY_MS : 0);
function readJsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// Windows (2026-10-09, docs/windows-port-log.md "Catch-up to 0.1.13"): apps keep there in the home's AppData (Roaming:
// Obsidian; Local: the Chromium browsers), looked in besides the Mac's ~/Library/Application Support; a browser's history
// is read with node:sqlite (no sqlite3 command), and an export's .zip with Windows' own tar (no unzip).
const WINDOWS = process.platform === 'win32';
const roaming = (homeDir, ...parts) => path.join(homeDir, 'AppData', 'Roaming', ...parts);
const local = (homeDir, ...parts) => path.join(homeDir, 'AppData', 'Local', ...parts);

/** `~/x` or an absolute path → absolute; anything else null. */
function expandPath(homeDir, value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === '~' || raw.startsWith('~/')) return path.join(homeDir, raw.slice(1));
  return path.isAbsolute(raw) ? path.resolve(raw) : null;
}

/** Every file under `dir` (dot folders and the folders in SKIP_DIRS passed over), breadth first, at most `max` entries. */
function walkFiles(dir, { max = 20000 } = {}, visit) {
  const queue = [dir];
  let seen = 0;
  while (queue.length) {
    const here = queue.shift();
    let entries = [];
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name === '.DS_Store') continue;
      seen += 1;
      if (seen > max) return true;
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full); continue; }
      if (entry.isFile()) visit(full, entry.name);
    }
  }
  return false;
}

/** The folder Obsidian's Daily notes plugin writes to, relative to the vault, or ''. */
function obsidianDailyFolder(vault) {
  for (const file of ['daily-notes.json', 'plugins/periodic-notes/data.json']) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(vault, '.obsidian', file), 'utf8'));
      const folder = value && (value.folder || (value.daily && value.daily.folder));
      if (typeof folder === 'string' && folder.trim()) return folder.trim().replace(/^\/+|\/+$/g, '');
    } catch { /* not set */ }
  }
  return '';
}

/**
 * A folder at a glance: how many notes, pdfs and pictures it holds, and the same for each folder at its top (most notes
 * first), with how many of a folder's notes are named by date (`dated`, 0–1). `dailyFolder`: Obsidian's setting, else the
 * top folder whose notes are mostly dated. `truncated` when it held more than `max` entries.
 */
function folderOverview(dir, { homeDir = os.homedir(), max = 20000, top = 30 } = {}) {
  const root = path.resolve(dir);
  const totals = { files: 0, notes: 0, pdfs: 0, images: 0, newest: 0 };
  const folders = new Map();
  let rootNotes = 0;
  const truncated = walkFiles(root, { max }, (file, name) => {
    const ext = path.extname(name).toLowerCase();
    const rel = path.relative(root, file);
    const head = rel.includes(path.sep) ? rel.split(path.sep)[0] : null;
    const kind = NOTE_EXT.has(ext) ? 'notes' : ext === '.pdf' ? 'pdfs' : IMAGE_EXT.has(ext) ? 'images' : null;
    const stat = statOf(file);
    const mtime = stat ? stat.mtimeMs : 0;
    totals.files += 1;
    if (kind) totals[kind] += 1;
    totals.newest = Math.max(totals.newest, mtime);
    if (!head) { if (kind === 'notes') rootNotes += 1; return; }
    const entry = folders.get(head) || { name: head, files: 0, notes: 0, pdfs: 0, images: 0, dated: 0, newest: 0 };
    entry.files += 1;
    if (kind) entry[kind] += 1;
    if (kind === 'notes' && DATED_RE.test(name)) entry.dated += 1;
    entry.newest = Math.max(entry.newest, mtime);
    folders.set(head, entry);
  });
  const list = [...folders.values()].map((entry) => ({ ...entry, dated: entry.notes ? Math.round((entry.dated / entry.notes) * 100) / 100 : 0, newest: iso(entry.newest) }))
    .sort((a, b) => b.notes - a.notes || b.files - a.files || a.name.localeCompare(b.name));
  const setting = fs.existsSync(path.join(root, '.obsidian')) ? obsidianDailyFolder(root) : '';
  const guessed = list.find((entry) => entry.notes >= 5 && entry.dated >= 0.6);
  return { path: root, shown: shownPath(homeDir, root), ...totals, newest: iso(totals.newest), rootNotes, dailyFolder: setting || (guessed ? guessed.name : ''), folders: list.slice(0, top), moreFolders: Math.max(0, list.length - top), truncated };
}

/**
 * The note files (.md, .markdown, .txt) under `dir`: only inside `include` (folders relative to it) when given, never
 * inside `exclude`, changed since `days` ago when given. Absolute paths, at most `max`, newest first.
 */
function noteFiles(dir, { include = [], exclude = [], days = null, max = 2000 } = {}) {
  const root = path.resolve(dir);
  const norm = (list) => (Array.isArray(list) ? list : []).map((rel) => String(rel || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const ins = norm(include), outs = norm(exclude);
  const under = (rel, folder) => rel === folder || rel.startsWith(`${folder}/`);
  const since = cutoff(days);
  const found = [];
  walkFiles(root, { max: 200000 }, (file, name) => {
    if (!NOTE_EXT.has(path.extname(name).toLowerCase())) return;
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (ins.length && !ins.some((folder) => under(rel, folder))) return;
    if (outs.some((folder) => under(rel, folder))) return;
    const stat = statOf(file);
    if (!stat || (since && stat.mtimeMs < since)) return;
    found.push({ file, mtime: stat.mtimeMs });
  });
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, max).map((entry) => entry.file);
}

/* ------------------------------------------------------------------------------------------------------- Obsidian */

/** The vaults Obsidian knows on this Mac that are still there → [{ name, path, shown, open, lastOpened }]. */
function obsidianVaults(homeDir = os.homedir(), platform = process.platform) {
  const files = [path.join(homeDir, 'Library', 'Application Support', 'obsidian', 'obsidian.json'), ...(platform === 'win32' ? [roaming(homeDir, 'obsidian', 'obsidian.json')] : [])];
  const config = files.map(readJsonFile).find(Boolean);
  if (!config) return [];
  return Object.values((config && config.vaults) || {})
    .filter((vault) => vault && typeof vault.path === 'string' && isDir(vault.path))
    .map((vault) => ({ name: path.basename(vault.path), path: vault.path, shown: shownPath(homeDir, vault.path), open: !!vault.open, lastOpened: iso(Number(vault.ts)) }))
    .sort((a, b) => String(b.lastOpened).localeCompare(String(a.lastOpened)));
}

/* -------------------------------------------------------------------------------------------------------- AI chats */

/** The first `bytes` of a file as lines (the last, possibly cut, dropped when the file is longer). */
function headLines(file, bytes = 96 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buffer, 0, bytes, 0);
    const text = buffer.subarray(0, read).toString('utf8');
    const lines = text.split('\n');
    if (read === bytes) lines.pop();
    return lines;
  } catch { return []; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };
// A prompt a person typed, not one a command or a hook wrote (those start with a tag) nor a caveat Claude Code adds.
const typed = (text) => typeof text === 'string' && text.trim() && !/^\s*</.test(text) && !/^Caveat: /.test(text);
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((part) => part && (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') && typeof part.text === 'string').map((part) => part.text).join('\n') : '');

const claudeCodeRoot = (homeDir) => path.join(homeDir, '.claude', 'projects');
const codexRoot = (homeDir, env = process.env) => path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions');
const CLAUDE_ID_RE = /^[\w.-]{1,255}\/[\w-]{1,80}$/;
const CODEX_ID_RE = /^\d{4}\/\d{2}\/\d{2}\/rollout-[\w.:-]{1,120}$/;

function claudeCodeFiles(homeDir) {
  const root = claudeCodeRoot(homeDir);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return out; }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(root, dir.name, name);
      const stat = statOf(file);
      if (stat && stat.isFile()) out.push({ id: `${dir.name}/${name.slice(0, -6)}`, file, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function codexFiles(homeDir, env) {
  const root = codexRoot(homeDir, env);
  const out = [];
  walkFiles(root, { max: 100000 }, (file, name) => {
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) return;
    const stat = statOf(file);
    if (stat) out.push({ id: path.relative(root, file).split(path.sep).join('/').slice(0, -6), file, mtime: stat.mtimeMs, size: stat.size });
  });
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** A Claude Code session's head → { title, first, project, automated }. */
function claudeCodeHead(file) {
  let first = '', summary = '', project = '', entry = '';
  let sidechain = false;
  for (const line of headLines(file)) {
    const event = parse(line);
    if (!event) continue;
    if (!project && typeof event.cwd === 'string') project = event.cwd;
    if (!entry && typeof event.entrypoint === 'string') entry = event.entrypoint;
    if (event.isSidechain === true) sidechain = true;
    if (event.type === 'summary' && typeof event.summary === 'string' && !summary) summary = event.summary;
    if (!first && event.type === 'user' && !event.isMeta && event.message && event.message.role === 'user') {
      const text = textOf(event.message.content);
      if (typed(text) && !(Array.isArray(event.message.content) && event.message.content.some((part) => part && part.type === 'tool_result'))) first = text;
    }
    if (first && project && entry) break;
  }
  return { title: clip(summary || first, 120), first: clip(first, 300), project, automated: /^sdk/.test(entry) || sidechain };
}

/** A Codex session's head → { title, first, project, automated }. */
function codexHead(file) {
  let first = '', project = '', automated = false;
  for (const line of headLines(file, 256 * 1024)) {
    const event = parse(line);
    if (!event || !event.payload) continue;
    if (event.type === 'session_meta') {
      project = String(event.payload.cwd || '');
      const source = event.payload.source;
      automated = event.payload.originator === 'codex_exec' || source === 'exec' || !!(source && typeof source === 'object' && source.subagent);
    }
    if (!first && event.type === 'event_msg' && event.payload.type === 'user_message' && typed(event.payload.message)) first = event.payload.message;
    if (!first && event.type === 'response_item' && event.payload.type === 'message' && event.payload.role === 'user') {
      const text = textOf(event.payload.content);
      if (typed(text)) first = text;
    }
    if (first && project) break;
  }
  return { title: clip(first, 120), first: clip(first, 300), project, automated };
}

const matches = (entry, query) => {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const hay = `${entry.title} ${entry.first} ${entry.project}`.toLowerCase();
  return words.every((word) => hay.includes(word));
};

/**
 * Claude Code's or Codex's sessions on this Mac, newest first: { id, title, first, project, date, size }. `days`: only
 * those touched since; `project`: only those run in a folder whose path holds it; `query`: words in the title, first
 * prompt or folder; `automated`: include runs a program started. At most `limit`.
 */
function localChats(app, { homeDir = os.homedir(), env = process.env, days = null, project = '', query = '', limit = 200, automated = false } = {}) {
  const files = app === 'Codex' ? codexFiles(homeDir, env) : claudeCodeFiles(homeDir);
  const since = cutoff(days);
  const out = [];
  for (const entry of files) {
    if (since && entry.mtime < since) break;
    const head = app === 'Codex' ? codexHead(entry.file) : claudeCodeHead(entry.file);
    if (!head.first && !head.title) continue;
    if (head.automated && !automated) continue;
    const row = { id: entry.id, title: head.title, first: head.first, project: shownPath(homeDir, head.project), date: iso(entry.mtime), size: entry.size };
    if (project && !row.project.toLowerCase().includes(String(project).toLowerCase())) continue;
    if (query && !matches(row, query)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/** How many sessions an app has, how many in the last 30 and 180 days, and in which folders (most first). */
function localChatCounts(app, { homeDir = os.homedir(), env = process.env } = {}) {
  const files = app === 'Codex' ? codexFiles(homeDir, env) : claudeCodeFiles(homeDir);
  const d30 = cutoff(30), d180 = cutoff(180);
  return { total: files.length, last30Days: files.filter((entry) => entry.mtime >= d30).length, last180Days: files.filter((entry) => entry.mtime >= d180).length, newest: iso(files[0] && files[0].mtime) };
}

/** The file a local session's id names, or null (ids are only ever the shapes the listing gives). */
function localChatFile(app, id, { homeDir = os.homedir(), env = process.env } = {}) {
  const value = String(id || '');
  if (app === 'Codex') {
    if (!CODEX_ID_RE.test(value)) return null;
    const file = path.join(codexRoot(homeDir, env), `${value}.jsonl`);
    return statOf(file) ? file : null;
  }
  if (!CLAUDE_ID_RE.test(value) || value.includes('..')) return null;
  const file = path.join(claudeCodeRoot(homeDir), `${value}.jsonl`);
  return statOf(file) ? file : null;
}

/** A local session read as turns of text → { title, project, date, turns: [{ role: 'user' | 'assistant', text }] }. */
function localTranscript(app, id, options = {}) {
  const file = localChatFile(app, id, options);
  if (!file) throw new Error(`No ${app} session ${id}`);
  const head = app === 'Codex' ? codexHead(file) : claudeCodeHead(file);
  const turns = [];
  const push = (role, text) => {
    const value = String(text || '').trim();
    if (!value) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text = `${last.text}\n\n${value}`; else turns.push({ role, text: value });
  };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (app === 'Codex') {
    const events = lines.map(parse).filter((event) => event && event.payload);
    const clean = events.some((event) => event.type === 'event_msg' && (event.payload.type === 'user_message' || event.payload.type === 'agent_message'));
    for (const event of events) {
      if (clean && event.type === 'event_msg') {
        if (event.payload.type === 'user_message' && typed(event.payload.message)) push('user', event.payload.message);
        if (event.payload.type === 'agent_message') push('assistant', event.payload.message);
      } else if (!clean && event.type === 'response_item' && event.payload.type === 'message') {
        const text = textOf(event.payload.content);
        if (event.payload.role === 'assistant') push('assistant', text); else if (event.payload.role === 'user' && typed(text)) push('user', text);
      }
    }
  } else {
    for (const event of lines.map(parse)) {
      if (!event || event.isMeta || event.isSidechain || !event.message) continue;
      const content = event.message.content;
      if (event.type === 'user' && !(Array.isArray(content) && content.some((part) => part && part.type === 'tool_result'))) {
        const text = textOf(content);
        if (typed(text)) push('user', text);
      } else if (event.type === 'assistant') {
        push('assistant', textOf(content));
      }
    }
  }
  return { title: head.title || 'Untitled session', project: shownPath(options.homeDir || os.homedir(), head.project), date: iso((statOf(file) || {}).mtimeMs), turns };
}

/* --------------------------------------------------------------------------------------- Claude and ChatGPT exports */

const exportCache = new Map(); // file → { mtime, chats }

/**
 * `sqlite3 -json -readonly <file> <query>` in this process, with node:sqlite, for Windows, where there is no sqlite3
 * command: the same JSON (Chrome's times are past 2^53, so read as BigInt and given as numbers, as sqlite3 prints them).
 */
function sqliteHere(command, args, options, callback) {
  const [, , file, query] = args;
  let out;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const statement = db.prepare(query);
      statement.setReadBigInts(true);
      out = JSON.stringify(statement.all().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))));
    } finally { db.close(); }
  } catch (error) { setImmediate(() => callback(error, '')); return null; }
  setImmediate(() => callback(null, out));
  return null;
}

/** The conversations.json an export holds: the file itself, inside a folder, or inside a .zip (read with unzip). */
function exportText(file) {
  const stat = statOf(file);
  if (!stat) throw new Error(`Nothing is at ${file}`);
  if (stat.isDirectory()) {
    const inside = path.join(file, 'conversations.json');
    if (!statOf(inside)) throw new Error(`No conversations.json in ${file}`);
    return fs.readFileSync(inside, 'utf8');
  }
  if (/\.zip$/i.test(file)) {
    const [command, args] = WINDOWS ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xOf', file, 'conversations.json']] : ['unzip', ['-p', file, 'conversations.json']];
    try { return execFileSync(command, args, { maxBuffer: 2 * 1024 * 1024 * 1024, windowsHide: true }).toString('utf8'); } catch { throw new Error(`No conversations.json in ${path.basename(file)}`); }
  }
  return fs.readFileSync(file, 'utf8');
}

const seconds = (value) => (typeof value === 'number' ? value * 1000 : Date.parse(value) || 0);

/** One conversation of either export → { id, title, created, updated, turns }. */
function exportChat(entry) {
  if (Array.isArray(entry.chat_messages)) { // Claude
    const turns = entry.chat_messages.map((message) => ({ role: message.sender === 'human' ? 'user' : 'assistant', text: String(message.text || textOf(message.content) || '').trim() })).filter((turn) => turn.text);
    return { id: String(entry.uuid || ''), title: String(entry.name || '').trim(), created: seconds(entry.created_at), updated: seconds(entry.updated_at), turns };
  }
  if (entry.mapping && typeof entry.mapping === 'object') { // ChatGPT: the branch that ends at current_node
    const chain = [];
    let at = entry.current_node;
    const guard = new Set();
    while (at && entry.mapping[at] && !guard.has(at)) { guard.add(at); chain.push(entry.mapping[at]); at = entry.mapping[at].parent; }
    const turns = chain.reverse().map((node) => node.message).filter((message) => message && message.author && (message.author.role === 'user' || message.author.role === 'assistant') && message.content && Array.isArray(message.content.parts))
      .map((message) => ({ role: message.author.role, text: message.content.parts.filter((part) => typeof part === 'string').join('\n').trim() })).filter((turn) => turn.text);
    return { id: String(entry.conversation_id || entry.id || ''), title: String(entry.title || '').trim(), created: seconds(entry.create_time), updated: seconds(entry.update_time), turns };
  }
  return null;
}

function readExport(file) {
  const stat = statOf(file);
  const held = exportCache.get(file);
  if (held && stat && held.mtime === stat.mtimeMs) return held.chats;
  let value;
  try { value = JSON.parse(exportText(file)); } catch (error) { throw new Error(error && /No conversations|Nothing is at/.test(error.message) ? error.message : `${path.basename(file)} is not a Claude or ChatGPT export`); }
  if (!Array.isArray(value)) throw new Error(`${path.basename(file)} is not a Claude or ChatGPT export`);
  const chats = value.map(exportChat).filter((chat) => chat && chat.id && chat.turns.length).sort((a, b) => b.updated - a.updated);
  exportCache.clear(); // one export held at a time: they can be large
  exportCache.set(file, { mtime: stat ? stat.mtimeMs : 0, chats });
  return chats;
}

/** An export's conversations, newest first: { id, title, first, date, turns } (turns: how many). Filters as localChats. */
function exportChats(file, { days = null, query = '', limit = 200 } = {}) {
  const since = cutoff(days);
  const out = [];
  for (const chat of readExport(file)) {
    if (since && chat.updated < since) break;
    const first = (chat.turns.find((turn) => turn.role === 'user') || {}).text || '';
    const row = { id: chat.id, title: clip(chat.title || first, 120), first: clip(first, 300), project: '', date: iso(chat.updated || chat.created), turns: chat.turns.length };
    if (query && !matches(row, query)) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function exportCounts(file) {
  const chats = readExport(file);
  const d30 = cutoff(30), d180 = cutoff(180);
  return { total: chats.length, last30Days: chats.filter((chat) => chat.updated >= d30).length, last180Days: chats.filter((chat) => chat.updated >= d180).length, newest: iso(chats[0] && chats[0].updated), oldest: iso(chats.length ? chats[chats.length - 1].updated : 0) };
}

function exportTranscript(file, id) {
  const chat = readExport(file).find((entry) => entry.id === String(id));
  if (!chat) throw new Error(`No conversation ${id} in the export`);
  return { title: chat.title || clip((chat.turns[0] || {}).text, 80) || 'Untitled conversation', project: '', date: iso(chat.updated || chat.created), turns: chat.turns };
}

/* -------------------------------------------------------------------------------------------------------- websites */

const CHROMIUM = [['Chrome', ['Google', 'Chrome']], ['Arc', ['Arc', 'User Data']], ['Brave', ['BraveSoftware', 'Brave-Browser']], ['Edge', ['Microsoft Edge']], ['Chromium', ['Chromium']], ['Vivaldi', ['Vivaldi']]];
// Under AppData\Local on Windows.
const WINDOWS_CHROMIUM = [['Chrome', ['Google', 'Chrome', 'User Data']], ['Brave', ['BraveSoftware', 'Brave-Browser', 'User Data']], ['Edge', ['Microsoft', 'Edge', 'User Data']], ['Chromium', ['Chromium', 'User Data']], ['Vivaldi', ['Vivaldi', 'User Data']]];

/**
 * The Chromium browsers' profiles on this Mac that have a history or bookmarks → [{ browser, profile, name, dir, used }],
 * the one used last first. `name` is what the browser calls the profile (its Local State), `used` when its history last changed.
 */
function browserProfiles(homeDir = os.homedir(), platform = process.platform) {
  const out = [];
  const bases = [
    ...CHROMIUM.map(([browser, parts]) => [browser, path.join(homeDir, 'Library', 'Application Support', ...parts)]),
    ...(platform === 'win32' ? WINDOWS_CHROMIUM.map(([browser, parts]) => [browser, local(homeDir, ...parts)]) : []),
  ];
  for (const [browser, base] of bases) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { continue; }
    const info = ((readJsonFile(path.join(base, 'Local State')) || {}).profile || {}).info_cache || {};
    for (const name of names.filter((entry) => entry === 'Default' || /^Profile \d+$/.test(entry))) {
      const dir = path.join(base, name);
      const history = statOf(path.join(dir, 'History'));
      if (history || statOf(path.join(dir, 'Bookmarks'))) out.push({ browser, profile: name, name: clip((info[name] && info[name].name) || name, 60), dir, used: iso(history ? history.mtimeMs : 0) });
    }
  }
  return out.sort((a, b) => String(b.used).localeCompare(String(a.used)));
}

/** The profile a tool call names ({ browser, profile }), else the first found. */
function profileOf(homeDir, { browser = '', profile = '' } = {}) {
  const all = browserProfiles(homeDir);
  return all.find((entry) => (!browser || entry.browser.toLowerCase() === String(browser).toLowerCase()) && (!profile || entry.profile === profile)) || null;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
// Chrome counts microseconds from 1601-01-01.
const chromeTime = (ms) => Math.round((ms / 1000 + 11644473600) * 1e6);
const fromChromeTime = (value) => (Number(value) > 0 ? Number(value) / 1000 - 11644473600000 : 0);

/**
 * A browser profile's most visited pages since `days` ago, grouped by site (`by` 'site': { host, visits, pages, title,
 * url } with its most visited page) or as pages ('page': { url, title, visits, last }). `exclude`: hosts left out.
 */
async function browserHistory(dir, { days = 90, limit = 50, by = 'site', exclude = [], sqlite = 'sqlite3', run = WINDOWS ? sqliteHere : execFile } = {}) {
  const source = path.join(dir, 'History');
  if (!statOf(source)) throw new Error('This browser profile has no history');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-history-'));
  try {
    const copy = path.join(scratch, 'History');
    fs.copyFileSync(source, copy);
    if (statOf(`${source}-wal`)) fs.copyFileSync(`${source}-wal`, `${copy}-wal`);
    const since = chromeTime(cutoff(days) || 0);
    const query = `SELECT url, title, visit_count AS visits, last_visit_time AS last FROM urls WHERE hidden = 0 AND last_visit_time > ${Number(since) || 0} ORDER BY visit_count DESC LIMIT 5000;`;
    const out = await new Promise((resolve, reject) => {
      run(sqlite, ['-json', '-readonly', copy, query], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => (error ? reject(new Error('The browser history could not be read')) : resolve(stdout)));
    });
    const rows = (parse(String(out || '').trim() || '[]') || []).filter((row) => /^https?:/i.test(row.url));
    const skip = new Set((Array.isArray(exclude) ? exclude : []).map((host) => String(host).toLowerCase().replace(/^www\./, '')));
    const kept = rows.filter((row) => { const host = hostOf(row.url); return host && !skip.has(host) && ![...skip].some((bad) => host.endsWith(`.${bad}`)); });
    if (by === 'page') return kept.slice(0, limit).map((row) => ({ url: row.url, title: clip(row.title, 160), visits: Number(row.visits) || 0, last: iso(fromChromeTime(row.last)) }));
    const sites = new Map();
    for (const row of kept) {
      const host = hostOf(row.url);
      const site = sites.get(host) || { host, visits: 0, pages: 0, title: '', url: '' };
      site.visits += Number(row.visits) || 0;
      site.pages += 1;
      if (!site.url) { site.url = row.url; site.title = clip(row.title, 160); }
      sites.set(host, site);
    }
    return [...sites.values()].sort((a, b) => b.visits - a.visits).slice(0, limit);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** A browser profile's bookmarks → [{ title, url, folder }]. */
function browserBookmarks(dir, { limit = 2000 } = {}) {
  let value;
  try { value = JSON.parse(fs.readFileSync(path.join(dir, 'Bookmarks'), 'utf8')); } catch { return []; }
  const out = [];
  const visit = (node, folder) => {
    if (!node || out.length >= limit) return;
    if (node.type === 'url' && /^https?:/i.test(node.url || '')) out.push({ title: clip(node.name, 160), url: node.url, folder });
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, node.type === 'folder' && node.name ? (folder ? `${folder} / ${node.name}` : node.name) : folder);
  };
  for (const [key, root] of Object.entries((value && value.roots) || {})) visit(root, { bookmark_bar: 'Bookmarks bar', other: 'Other bookmarks', synced: 'Mobile bookmarks' }[key] || '');
  return out;
}

const URL_RE = /https?:\/\/[^\s<>()[\]"'`]+/g;

/** The web links written in the notes under `dir`, most used first → [{ url, count, notes: [up to three note names] }]. */
function linksIn(dir, { limit = 200, maxFiles = 5000 } = {}) {
  const found = new Map();
  let files = 0;
  walkFiles(path.resolve(dir), { max: 200000 }, (file, name) => {
    if (files >= maxFiles || !NOTE_EXT.has(path.extname(name).toLowerCase())) return;
    files += 1;
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
    for (const match of text.matchAll(URL_RE)) {
      const url = match[0].replace(/[.,;:!?*_]+$/, '');
      const entry = found.get(url) || { url, count: 0, notes: [] };
      entry.count += 1;
      const note = path.basename(name, path.extname(name));
      if (entry.notes.length < 3 && !entry.notes.includes(note)) entry.notes.push(note);
      found.set(url, entry);
    }
  });
  return [...found.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

/* ---------------------------------------------------------------------------------------------------------- Zotero */

/** The mirrored library's collections with how many items each holds → { items, unfiled, collections: [{ key, path, items }] }. */
function zoteroCollections(root) {
  const items = readJsonFile(path.join(root, 'items.json'));
  if (!Array.isArray(items)) throw new Error('Your Zotero library has not finished its first sync');
  const collections = readJsonFile(path.join(root, 'collections.json')) || [];
  const counts = new Map();
  let unfiled = 0;
  for (const item of items) {
    const keys = Array.isArray(item.collections) ? item.collections : [];
    if (!keys.length) unfiled += 1;
    for (const key of keys) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return { items: items.length, unfiled, collections: collections.map((c) => ({ key: c.key, path: c.path || c.name, items: counts.get(c.key) || 0 })) };
}

/**
 * The mirrored library's items → [{ key, title, authors, year, doi, url, attachment, collections }]: in `collection`
 * (its key; with `nested`, its subcollections too), matching `query` (title, authors, year, tags), at most `limit`.
 */
function zoteroItems(root, { collection = '', nested = true, query = '', limit = 500 } = {}) {
  const items = readJsonFile(path.join(root, 'items.json'));
  if (!Array.isArray(items)) throw new Error('Your Zotero library has not finished its first sync');
  const collections = readJsonFile(path.join(root, 'collections.json')) || [];
  const byKey = new Map(collections.map((c) => [c.key, c]));
  const wanted = new Set(collection ? [collection] : []);
  if (collection && nested) {
    let grew = true;
    while (grew) { grew = false; for (const c of collections) if (c.parent && wanted.has(c.parent) && !wanted.has(c.key)) { wanted.add(c.key); grew = true; } }
  }
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const item of items) {
    const keys = Array.isArray(item.collections) ? item.collections : [];
    if (collection && !keys.some((key) => wanted.has(key))) continue;
    const authors = authorsOf(item);
    if (words.length) {
      const hay = `${item.title} ${authors} ${item.year} ${(item.tags || []).join(' ')}`.toLowerCase();
      if (!words.every((word) => hay.includes(word))) continue;
    }
    const attachment = (item.attachments || []).find((a) => a.contentType === 'application/pdf' && a.linkMode !== 'linked_url');
    out.push({ key: item.key, title: clip(item.title, 200), authors, year: item.year || '', doi: item.doi || '', url: item.url || '', attachment: attachment ? 'pdf' : '', collections: keys.map((key) => (byKey.get(key) || {}).path || key) });
    if (out.length >= limit) break;
  }
  return out;
}

/* ----------------------------------------------------------------------------------------------- PDFs on this Mac */

// Folders a Mac keeps documents in, looked through when the person let the agents read their home folder. ~/Zotero is
// not among them: its PDFs come in through Zotero, with their metadata.
const PDF_ROOTS = ['Downloads', 'Documents', 'Desktop', 'Papers', 'Research', 'Dropbox', path.join('Library', 'Mobile Documents', 'com~apple~CloudDocs')];
// Packages and libraries that are folders on disk but never hold the person's papers.
const PACKAGE_RE = /\.(?:app|bundle|framework|photoslibrary|musiclibrary|tvlibrary|xcodeproj|xcworkspace|pkg|plugin|kext|lproj)$/i;
const PDF_SKIP = new Set(['Zotero', 'Library', 'site-packages', 'dist', 'build', 'target', 'vendor', 'Pods']);

/** The folders PDFs are looked for in: those of PDF_ROOTS that are here, and Google Drive's when it syncs to this Mac. */
function pdfRoots(homeDir = os.homedir()) {
  const drives = (() => { try { return fs.readdirSync(path.join(homeDir, 'Library', 'CloudStorage')).filter((name) => /^(?:GoogleDrive|Dropbox|OneDrive)/.test(name)).map((name) => path.join(homeDir, 'Library', 'CloudStorage', name)); } catch { return []; } })();
  return [...PDF_ROOTS.map((rel) => path.join(homeDir, rel)), ...drives].filter(isDir);
}

/** Every PDF under `dir`, depth first to `depth` levels, packages and code folders passed over, at most `max` entries seen. */
function walkPdfs(dir, { max = 40000, depth = 6 } = {}, visit) {
  let seen = 0;
  const stack = [[dir, 0]];
  while (stack.length) {
    const [here, level] = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(here, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (seen > max) return true;
      if (entry.name.startsWith('.')) continue;
      const full = path.join(here, entry.name);
      if (entry.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(entry.name) && !PDF_SKIP.has(entry.name) && !PACKAGE_RE.test(entry.name)) stack.push([full, level + 1]);
      } else if (entry.isFile() && /\.pdf$/i.test(entry.name)) visit(full, entry.name);
    }
  }
  return false;
}

/**
 * A PDF's title as the file says it, read cheaply from its first and last 64 KB (the XMP packet's dc:title, else the Info
 * dictionary's /Title), or ''. Misses what is kept in compressed object streams: a hint for the librarian, not a fact.
 */
function pdfTitle(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const span = Math.min(size, 64 * 1024);
    const head = Buffer.alloc(span);
    fs.readSync(fd, head, 0, span, 0);
    const tail = Buffer.alloc(span);
    fs.readSync(fd, tail, 0, span, Math.max(0, size - span));
    const text = head.toString('latin1') + tail.toString('latin1');
    const xmp = text.match(/<dc:title>[\s\S]{0,200}?<rdf:li[^>]*>([^<]{3,300})<\/rdf:li>/);
    if (xmp) return clip(Buffer.from(xmp[1], 'latin1').toString('utf8').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), 200);
    const hex = text.match(/\/Title\s*<(FEFF[0-9A-Fa-f]{4,600})>/);
    if (hex) { const bytes = Buffer.from(hex[1].slice(4), 'hex'); for (let i = 0; i + 1 < bytes.length; i += 2) [bytes[i], bytes[i + 1]] = [bytes[i + 1], bytes[i]]; return clip(bytes.toString('utf16le'), 200); }
    const plain = text.match(/\/Title\s*\(((?:\\.|[^\\)]){3,300})\)/);
    if (!plain || /^\xfe\xff/.test(plain[1])) return '';
    const title = plain[1].replace(/\\([nrt()\\])/g, (m, c) => ({ n: ' ', r: ' ', t: ' ' }[c] || c));
    return /[\x00-\x08]/.test(title) || /^(?:untitled|microsoft word - .*|\s*)$/i.test(title) ? '' : clip(title, 200);
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// What kind of PDF a name (and title) suggests, for the librarian's questions about kinds: `paper` (an arXiv id, a
// DOI-like or ACM-style number, a venue or a paper's words), `personal` (receipts, statements, tickets, résumés: never
// offered), `book` (books, slides, lecture notes, manuals), else `unclear`, left to the titles.
const PAPER_ID_RE = /(?:^|[^\d])\d{4}\.\d{4,5}(?:v\d+)?(?:[^\d]|$)|^\d{5,}\.\d{5,}|^10\.\d{4,}/;
const PERSONAL_RE = /\b(?:invoice|receipt|bank statement|statement of account|bill|tax(?:es)?|w-?2|w-?9|1099|1040|payslip|pay ?stub|lease|rental agreement|insurance|boarding pass|ticket|itinerary|reservation|booking|confirmation|bank|passport|visa|i-?20|ds-?160|medical|prescription|lab results|vaccin\w*|resume|résumé|cover letter|offer letter|transcript|diploma|refund|warranty|utility)\b/i;
const PAPER_RE = /\b(?:et al|arxiv|preprint|proceedings|proc\.|journal|conference|symposium|workshop|chi|uist|cscw|neurips|nips|icml|iclr|acl|emnlp|naacl|cvpr|iccv|eccv|sigcse|icer|aaai|ijcai|kdd|paper|thesis|dissertation)\b|^[a-z]+(?:[-_ ][a-z]+)?[-_ ]?(?:19|20)\d{2}[a-z]?(?:[-_ ]|\.pdf$)/i;
const BOOK_RE = /\b(?:book|textbook|handbook|chapter|ch\d+|slides?|lecture|lec\d*|syllabus|manual|guide|notes|homework|hw\d*|problem set|pset|exam|midterm|final)\b/i;
function pdfGuess(name, title = '') {
  const text = `${name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ')} ${title}`;
  if (PAPER_ID_RE.test(name)) return 'paper';
  if (PERSONAL_RE.test(text)) return 'personal';
  if (PAPER_RE.test(name) || PAPER_RE.test(title)) return 'paper';
  if (BOOK_RE.test(text)) return 'book';
  return 'unclear';
}

/**
 * The folders under `roots` that hold PDFs, most first: how many, the newest, how many of each kind (pdfGuess), and the
 * names and titles of a few of the newest. → { roots, pdfs, folders: [...], moreFolders, truncated }. Only reads.
 */
function pdfFolders(roots, { homeDir = os.homedir(), top = 40, samples = 6, titles = 150, max = 40000 } = {}) {
  const byFolder = new Map();
  let total = 0, truncated = false;
  // A folder inside another one looked through is not looked through twice.
  const sorted = [...new Set(roots.map((root) => path.resolve(root)))].sort((a, b) => a.length - b.length);
  const seen = sorted.filter((dir, i) => !sorted.slice(0, i).some((outer) => dir.startsWith(outer + path.sep)));
  for (const dir of seen) {
    truncated = walkPdfs(dir, { max }, (file, name) => {
      total += 1;
      const folder = path.dirname(file);
      const stat = statOf(file);
      const entry = byFolder.get(folder) || { path: folder, pdfs: 0, newest: 0, files: [] };
      entry.pdfs += 1;
      entry.newest = Math.max(entry.newest, stat ? stat.mtimeMs : 0);
      entry.files.push({ file, name, mtime: stat ? stat.mtimeMs : 0 });
      byFolder.set(folder, entry);
    }) || truncated;
  }
  let budget = titles;
  const list = [...byFolder.values()].sort((a, b) => b.pdfs - a.pdfs || b.newest - a.newest);
  const folders = list.slice(0, top).map((entry) => {
    const kinds = { paper: 0, personal: 0, book: 0, unclear: 0 };
    for (const each of entry.files) kinds[pdfGuess(each.name)] += 1;
    const newest = entry.files.sort((a, b) => b.mtime - a.mtime).filter((each) => pdfGuess(each.name) !== 'personal').slice(0, samples);
    const examples = newest.map((each) => { const title = budget-- > 0 ? pdfTitle(each.file) : ''; return title && title !== each.name.replace(/\.pdf$/i, '') ? `${each.name} — ${title}` : each.name; });
    return { folder: shownPath(homeDir, entry.path), path: entry.path, pdfs: entry.pdfs, newest: iso(entry.newest), kinds: Object.fromEntries(Object.entries(kinds).filter(([, n]) => n)), examples };
  });
  return { roots: [...seen].map((dir) => shownPath(homeDir, dir)), pdfs: total, folders, moreFolders: Math.max(0, list.length - top), truncated };
}

/**
 * The PDFs under `dir`, newest first: path, name, title, the folder it is in (relative), when it changed, its size and the
 * kind its name suggests. `days`: changed in the last n days; `query`: words in its name, title or folder; `kind`: only
 * that pdfGuess; `include` / `exclude`: folders relative to `dir`. At most `limit`.
 */
function pdfFiles(dir, { days = null, query = '', kind = '', include = [], exclude = [], limit = 300, titles = true } = {}) {
  const root = path.resolve(dir);
  const norm = (list) => (Array.isArray(list) ? list : []).map((rel) => String(rel || '').replace(/^\/+|\/+$/g, '')).filter(Boolean);
  const ins = norm(include), outs = norm(exclude);
  const under = (rel, folder) => rel === folder || rel.startsWith(`${folder}/`);
  const since = cutoff(days);
  const found = [];
  walkPdfs(root, { max: 200000, depth: 12 }, (file, name) => {
    const rel = path.relative(root, path.dirname(file)).split(path.sep).join('/');
    if (ins.length && !ins.some((folder) => under(rel, folder))) return;
    if (outs.some((folder) => under(rel, folder))) return;
    const stat = statOf(file);
    if (!stat || (since && stat.mtimeMs < since)) return;
    found.push({ file, name, folder: rel, mtime: stat.mtimeMs, size: stat.size });
  });
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (const entry of found.sort((a, b) => b.mtime - a.mtime)) {
    if (out.length >= limit) break;
    const title = titles ? pdfTitle(entry.file) : '';
    const guess = pdfGuess(entry.name, title);
    if (kind && guess !== kind) continue;
    if (words.length) { const text = `${entry.name} ${title} ${entry.folder}`.toLowerCase(); if (!words.every((word) => text.includes(word))) continue; }
    out.push({ path: entry.file, name: entry.name, title: title || null, folder: entry.folder || '.', modified: iso(entry.mtime), size: entry.size, kind: guess });
  }
  return { total: found.length, pdfs: out };
}

module.exports = {
  NOTE_EXT, IMAGE_EXT, shownPath, expandPath, walkFiles, folderOverview, noteFiles, obsidianDailyFolder, obsidianVaults,
  localChats, localChatCounts, localChatFile, localTranscript, readExport, exportChat, exportChats, exportCounts, exportTranscript,
  browserProfiles, profileOf, browserHistory, browserBookmarks, linksIn, hostOf, chromeTime, zoteroCollections, zoteroItems,
  pdfRoots, pdfFolders, pdfFiles, pdfTitle, pdfGuess,
};
