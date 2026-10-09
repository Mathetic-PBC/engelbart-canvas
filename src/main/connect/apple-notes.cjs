'use strict';

// Connect your library (2026-10-07, second build): Apple Notes, asked through macOS Automation (JavaScript for Automation
// run by osascript). Notes keeps its notes in a database no other app may read, so Engelbart asks Notes itself, in the
// background: Notes is never brought forward and nothing is clicked. The first time, macOS asks the person to let Engelbart
// control Notes (the permission the Connect window requests up front, `permission()`); after a refusal every call fails
// with NOT_ALLOWED until they allow it in System Settings → Privacy & Security → Automation. Only reads.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

const TIMEOUT_MS = 120_000;
const MAX_NOTES = 5000;
const DAY_MS = 86_400_000;
const ID_RE = /^x-coredata:\/\/[\w./-]{1,200}$/;
const NOT_ALLOWED = 'macOS has not let Engelbart read Apple Notes. Allow it in System Settings → Privacy & Security → Automation (Engelbart → Notes), then try again.';

// One script, three commands: folders, list (notes of one folder or all), read (notes by id).
const SCRIPT = `function run(argv) {
  const Notes = Application('Notes');
  const cmd = argv[0];
  const args = JSON.parse(argv[1] || '{}');
  const iso = (d) => { try { return d ? d.toISOString() : null; } catch (e) { return null; } };
  const folders = [];
  const walk = (folder, account, prefix) => {
    const name = folder.name();
    const shown = prefix ? prefix + ' / ' + name : name;
    folders.push({ folder: folder, id: folder.id(), name: shown, account: account });
    try { folder.folders().forEach((child) => walk(child, account, shown)); } catch (e) {}
  };
  Notes.accounts().forEach((account) => { const a = account.name(); account.folders().forEach((f) => walk(f, a, '')); });
  if (cmd === 'folders') return JSON.stringify(folders.map((f) => ({ id: f.id, name: f.name, account: f.account, count: f.folder.notes.length })));
  if (cmd === 'list') {
    const out = [];
    for (const f of folders) {
      if (args.folder && f.id !== args.folder && f.name !== args.folder) continue;
      const ids = f.folder.notes.id(), names = f.folder.notes.name(), dates = f.folder.notes.modificationDate();
      for (let i = 0; i < ids.length && out.length < args.max; i++) out.push({ id: ids[i], name: names[i], folder: f.name, account: f.account, modified: iso(dates[i]) });
    }
    return JSON.stringify(out);
  }
  if (cmd === 'read') {
    return JSON.stringify(args.ids.map((id) => {
      try { const n = Notes.notes.byId(id); return { id: id, name: n.name(), body: n.body(), modified: iso(n.modificationDate()), folder: n.container().name() }; }
      catch (e) { return { id: id, error: String(e) }; }
    }));
  }
  return JSON.stringify({ error: 'unknown command' });
}`;

function runScript(command, args, { run = execFile, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    run('osascript', ['-l', 'JavaScript', '-e', SCRIPT, command, JSON.stringify(args || {})], { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const said = `${stderr || ''} ${error.message || ''}`;
        if (/-1743|not authori[sz]ed|not allowed/i.test(said)) { const refused = new Error(NOT_ALLOWED); refused.code = 'NOT_ALLOWED'; reject(refused); return; }
        reject(new Error(`Apple Notes did not answer (${String(stderr || error.message).trim().split('\n')[0].slice(0, 200)})`));
        return;
      }
      try { resolve(JSON.parse(String(stdout || '').trim() || 'null')); } catch { reject(new Error('Apple Notes answered something unreadable')); }
    });
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (text) => String(text).replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, name) => {
  if (name[0] === '#') { const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return Number.isFinite(code) ? String.fromCodePoint(code) : whole; }
  return Object.hasOwn(ENTITIES, name.toLowerCase()) ? ENTITIES[name.toLowerCase()] : whole;
});

/**
 * A note's HTML body as Markdown. Pictures pasted into it (data: images) are written into `pictureDir` and linked by
 * their path, so ./notes.cjs convertMarkdown saves them with the note. The first line, the note's own title, is dropped.
 */
function noteMarkdown(html, { name = '', pictureDir = '', key = '' } = {}) {
  let n = 0;
  let text = String(html || '')
    .replace(/<img[^>]*src="data:image\/(png|jpe?g|gif|webp);base64,([^"]+)"[^>]*>/gi, (_whole, kind, data) => {
      if (!pictureDir) return '';
      n += 1;
      fs.mkdirSync(pictureDir, { recursive: true, mode: 0o700 });
      const file = path.join(pictureDir, `${key || 'note'}-${n}.${kind === 'jpeg' ? 'jpg' : kind}`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
      return `\n![picture ${n}](${file})\n`;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi, (_whole, level, inner) => `\n${'#'.repeat(Number(level))} ${inner}\n`)
    .replace(/<li[^>]*>/gi, '\n- ').replace(/<\/li>/gi, '')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<(strike|s|del)>([\s\S]*?)<\/\1>/gi, '~~$2~~')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_whole, href, inner) => `[${inner}](${href})`)
    .replace(/<\/(div|p|ul|ol|h\d|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  text = decode(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const lines = text.split('\n');
  if (name && lines[0] && lines[0].replace(/^#+\s*/, '').replace(/\*/g, '').trim() === String(name).trim()) lines.shift();
  return lines.join('\n').trim();
}

/** `run` replaces execFile (tests). → { permission, folders, list, read } */
function createAppleNotes({ run = execFile, platform = process.platform } = {}) {
  const call = (command, args) => {
    if (platform !== 'darwin') return Promise.reject(new Error('Apple Notes is only on a Mac'));
    return runScript(command, args, { run });
  };
  return {
    /** Asks Notes for its folders, which makes macOS ask the person once. → { allowed, error } */
    async permission() {
      try { await call('folders', {}); return { allowed: true, error: '' }; } catch (error) { return { allowed: false, error: error.message, refused: error.code === 'NOT_ALLOWED' }; }
    },
    folders: () => call('folders', {}),
    /** Notes newest first → [{ id, name, folder, account, modified }]: in `folder` (an id or a name), changed in `days`, matching `query`. */
    async list({ folder = '', days = null, query = '', limit = 500 } = {}) {
      const rows = (await call('list', { folder, max: MAX_NOTES })) || [];
      const since = Number.isFinite(days) && days > 0 ? Date.now() - days * DAY_MS : 0;
      const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
      return rows.filter((row) => row && ID_RE.test(row.id) && !/recently deleted/i.test(row.folder || ''))
        .filter((row) => !since || Date.parse(row.modified || '') >= since)
        .filter((row) => !words.length || words.every((word) => `${row.name} ${row.folder}`.toLowerCase().includes(word)))
        .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
        .slice(0, Math.min(Math.max(1, Math.round(limit) || 500), MAX_NOTES));
    },
    /** Notes by id → [{ id, name, folder, modified, markdown } | { id, error }], pictures written into `pictureDir`. */
    async read(ids, { pictureDir = '' } = {}) {
      const clean = (Array.isArray(ids) ? ids : []).filter((id) => ID_RE.test(String(id)));
      const out = [];
      for (let i = 0; i < clean.length; i += 25) {
        const batch = (await call('read', { ids: clean.slice(i, i + 25) })) || [];
        for (const note of batch) {
          if (!note || note.error) { out.push({ id: note && note.id, error: note ? note.error : 'not read' }); continue; }
          const key = createHash('sha1').update(String(note.id)).digest('hex').slice(0, 10);
          out.push({ id: note.id, name: String(note.name || 'Untitled note').slice(0, 200), folder: note.folder, modified: note.modified, markdown: noteMarkdown(note.body, { name: note.name, pictureDir, key }) });
        }
      }
      return out;
    },
  };
}

module.exports = { createAppleNotes, noteMarkdown, SCRIPT, NOT_ALLOWED };
