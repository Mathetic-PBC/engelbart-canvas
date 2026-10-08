'use strict';

// Connect your library (2026-10-07; every library since 2026-10-08): the tools an import agent is given, served to Claude
// Code and Codex as the MCP server `engelbart` (./import-mcp.cjs) over the loopback bridge Build's tools use
// (../sandbox/local-tools.cjs openToolBridge), one bridge per import. The agent decides what to bring in from what the
// person said in the chat; these do the reading and the writing, so a vault of 300 notes is one call, not 300.
// They only ever write into the Engelbart data root the session started in (~/.engelbart, or ~/.engelbart/test): Markdown files
// of the library's own in <data root>/assets/md (notes, chats, documents: ./notes.cjs writeFile; 2026-10-08, "save the
// imported content not as notes but as md files ... in the engelbart assets folder") and library rows
// (../store/library.cjs addItem, as the sidebar adds them). Nothing the person has is changed, moved or deleted.
// What has been brought in is remembered in <data root>/.connect/imported.json (a note's source file, a chat's id, a
// Zotero item's key), so a second import of the same thing is skipped instead of making "Note 2".
//
// Second build (2026-10-07, "Agent onboarding"): the agents fetch what the person used to be told to export. The browser
// tools drive the agent's own hidden window (./browser.cjs) on the Stage's sign-ins; web_chats and import_web_chats read
// ChatGPT's and Claude's chats from the signed-in page (./web-chats.cjs); import_google_files and import_overleaf_projects
// download with that same sign-in into <data root>/imports/<session>/; Apple Notes goes through macOS Automation
// (./apple-notes.cjs) and Cursor's chats are read from its database (./cursor.cjs). needs_you hands a step only the person
// can do (a sign-in, a code) to the Connect window and waits; save_memory keeps an assistant's answer for MEMORY.md. A
// survey brings nothing in and a recall only saves its answer (WRITING tools refused to both), and each agent's server
// lists only its kind's tools (TOOLS_FOR).

const fs = require('node:fs');
const path = require('node:path');
const readers = require('./readers.cjs');
const notes = require('./notes.cjs');
const { listWebChats, readWebChat, WEB_CHAT_APPS } = require('./web-chats.cjs');
const { cursorChats, cursorTranscript } = require('./cursor.cjs');
const { readZip, safeName } = require('../overleaf/copy.cjs');
const { mcpContent } = require('../sandbox/local-tools.cjs');
const { clipMiddle } = require('../bart/clip.cjs');
const { sanitizeName } = require('../store/home.cjs');

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const strs = { type: 'array', items: { type: 'string' } };
const objs = { type: 'array', items: { type: 'object' } };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const CHAT_APPS = ['Claude Code', 'Codex', 'Cursor', 'Claude', 'ChatGPT'];
const MAX_FILES_A_CALL = 300;
const MAX_CHATS_A_CALL = 100;
const MAX_ZOTERO_A_CALL = 300;
const MAX_GOOGLE_A_CALL = 25;
const MAX_WEB_CHATS_A_CALL = 40;
const CALL_BUDGET_MS = 170_000; // a call answers within the bridge's four minutes: what is left is said, for another call
const MAX_NOTE_CHARS = 200_000;
const GOOGLE_ID_RE = /^[\w-]{10,120}$/;
const OVERLEAF_ID_RE = /^[0-9a-f]{24}$/;
const NEEDS_KINDS = ['signin', '2fa', 'password', 'captcha', 'permission', 'connector', 'confirm'];
const GOOGLE_KINDS = ['doc', 'sheet', 'slides', 'file', 'pdf'];

const IMPORT_TOOLS = [
  { name: 'folder_overview', description: 'A folder at a glance: how many notes, pdfs and pictures it holds, and the same for each folder at its top (most notes first), with the share of notes named by date and the daily-notes folder when there is one. path: absolute or ~/….', inputSchema: schema({ path: str }, ['path']) },
  { name: 'list_note_files', description: 'The note files (.md, .markdown, .txt) under a folder, newest first, as absolute paths. include: only these folders (relative to it); exclude: never these; days: only those changed in the last n days.', inputSchema: schema({ folder: str, include: strs, exclude: strs, days: num }, ['folder']) },
  { name: 'import_note_files', description: `Bring note files into Engelbart's library, each as its own Markdown file named by its file, its pictures included and Obsidian links ([[Note]]) turned into mentions. files: absolute paths, up to ${MAX_FILES_A_CALL} a call (call again for more). root: the vault or export folder they come from, where pictures are looked up by name. A file brought in before is skipped. Returns how many were added and why any were skipped.`, inputSchema: schema({ files: strs, root: str }, ['files']) },
  { name: 'add_note', description: 'Add a Markdown file you wrote to Engelbart\'s library: a page\'s text, a meeting\'s notes and transcript, a summary of a source with no files of its own. title: what it is called. source: where it came from, a path, link or id, so it is never brought in twice.', inputSchema: schema({ title: str, markdown: str, source: str }, ['title', 'markdown']) },
  { name: 'add_to_library', description: 'Add one thing to the Engelbart library: a web link, a GitHub repository link, an arXiv id or DOI, or the absolute path of a pdf, file or folder (a folder with .git is a repository). name: what the library calls it (optional). Something the library already holds is not added twice.', inputSchema: schema({ input: str, name: str }, ['input']) },
  { name: 'unpack', description: 'Unpack a .zip (one you downloaded with browser_download, or on this Mac) into a folder in Engelbart\'s imports, and say what it holds. Then bring its notes in with list_note_files and import_note_files, its pdfs with add_to_library.', inputSchema: schema({ file: str }, ['file']) },
  { name: 'list_chats', description: `AI chats on this Mac or in an export, newest first: id, title, first prompt, folder, date. app: ${CHAT_APPS.join(', ')} (Claude and ChatGPT only from an export; use web_chats for their accounts). days: only the last n days. project: only chats run in a folder whose path holds this. query: words to look for. automated: include runs a program started (left out by default). limit: at most (default 200).`, inputSchema: schema({ app: str, days: num, project: str, query: str, limit: num, automated: bool }, ['app']) },
  { name: 'read_chat', description: 'One chat from list_chats as its turns of text (tool calls left out), to judge what it is about. max_chars: how much at most (default 6000).', inputSchema: schema({ app: str, id: str, max_chars: num }, ['app', 'id']) },
  { name: 'import_chats', description: `Bring chats from list_chats into Engelbart's library, each as a Markdown file of its turns (what the person asked and what the assistant answered), named by the chat's title. ids: up to ${MAX_CHATS_A_CALL} a call. A chat brought in before is skipped.`, inputSchema: schema({ app: str, ids: strs }, ['app', 'ids']) },
  { name: 'web_chats', description: `The person's chats in their own ${WEB_CHAT_APPS.join(' or ')} account, read from the signed-in page in Engelbart's browser, newest first: id, title, date, project. days, query (words in the title), project (part of a project's name), limit (default 200). Says when the person must sign in.`, inputSchema: schema({ app: str, days: num, query: str, project: str, limit: num }, ['app']) },
  { name: 'web_chat_read', description: 'One chat from web_chats as its turns of text, to judge what it is about. max_chars: how much at most (default 6000).', inputSchema: schema({ app: str, id: str, max_chars: num }, ['app', 'id']) },
  { name: 'import_web_chats', description: `Bring chats from web_chats into Engelbart's library, each as a Markdown file of its turns, named by its title. ids: up to ${MAX_WEB_CHATS_A_CALL} a call (what did not fit in the time is returned as left). A chat brought in before is skipped.`, inputSchema: schema({ app: str, ids: strs }, ['app', 'ids']) },
  { name: 'browser_open', description: 'Open a page in Engelbart\'s hidden browser (the person\'s sign-ins; only this job\'s apps\' sites). Returns its address and title.', inputSchema: schema({ url: str }, ['url']) },
  { name: 'browser_read', description: 'What the page shows now: its text (from offset, at most max_chars, default 8000) and its controls (links, buttons, fields, rows), each with a ref to click or type into, a link\'s href and an item\'s id (Drive file ids) when it has one.', inputSchema: schema({ offset: num, max_chars: num }) },
  { name: 'browser_click', description: 'Click a control by its ref from browser_read.', inputSchema: schema({ ref: str }, ['ref']) },
  { name: 'browser_type', description: 'Type text into a field or editor by its ref. replace: clear it first. submit: press Enter after. Never a password: call needs_you instead.', inputSchema: schema({ ref: str, text: str, submit: bool, replace: bool }, ['ref', 'text']) },
  { name: 'browser_press', description: 'Press a key: Enter, Tab, Escape, Backspace, Delete, ArrowDown, ArrowUp, ArrowLeft, ArrowRight, PageDown, PageUp, Home, End, Space.', inputSchema: schema({ key: str }, ['key']) },
  { name: 'browser_scroll', description: 'Scroll the page (or the control ref) down or up by amount pixels (default 800), to load more of a list.', inputSchema: schema({ ref: str, direction: str, amount: num }) },
  { name: 'browser_wait', description: 'Wait for the page: until_text appears, until_gone disappears, or stable (its text stops changing, as an assistant\'s answer does when it is finished); seconds at most (default 5, up to 120).', inputSchema: schema({ seconds: num, until_text: str, until_gone: str, stable: bool }) },
  { name: 'browser_screenshot', description: 'A picture of the page as it is now, when its text is not enough.', inputSchema: schema({}) },
  { name: 'browser_eval', description: 'Run a script in the page (an async function body: use await and return a value that is JSON). For what the page itself can ask its own site for (fetch with its sign-in). Never to type passwords or change anything in the account.', inputSchema: schema({ script: str }, ['script']) },
  { name: 'browser_download', description: 'Download a file with the person\'s sign-in (an export, a zip, a pdf) into Engelbart\'s imports. Returns its path, to unpack or bring in.', inputSchema: schema({ url: str, name: str }, ['url']) },
  { name: 'import_google_files', description: `Bring Google Drive files in by id, with the person's Google sign-in: items [{ id, kind, name }], kind doc (a Google Doc: a Markdown file with its pictures), sheet (a Markdown file with its first sheet as a table), slides (a Markdown file of its text), or file / pdf (a file in Drive: into the library). Up to ${MAX_GOOGLE_A_CALL} a call; a file brought in before is skipped.`, inputSchema: schema({ items: objs }, ['items']) },
  { name: 'overleaf_projects', description: 'The person\'s Overleaf projects (id, name, last updated, owner, archived), read from their signed-in project page.', inputSchema: schema({}) },
  { name: 'import_overleaf_projects', description: 'Bring Overleaf projects in by id (up to 20 a call; what did not fit in the time is returned as left): each is downloaded as its source zip with the person\'s sign-in, unpacked into Engelbart\'s imports and kept in the library as a folder, with its main .tex as a Markdown file and its compiled pdf.', inputSchema: schema({ ids: strs }, ['ids']) },
  { name: 'apple_notes_folders', description: 'Apple Notes\' folders (id, name, account, how many notes), asked through macOS Automation.', inputSchema: schema({}) },
  { name: 'apple_notes_list', description: 'Apple Notes\' notes, newest first: id, name, folder, modified. folder: an id or name; days; query: words in the name or folder; limit (default 500).', inputSchema: schema({ folder: str, days: num, query: str, limit: num }) },
  { name: 'import_apple_notes', description: 'Bring Apple Notes in by id, each as its own Markdown file with its pictures. Up to 200 a call; a note brought in before is skipped.', inputSchema: schema({ ids: strs }, ['ids']) },
  { name: 'browser_history', description: 'The most visited sites (by "site", the default) or pages (by "page") in a Chromium browser on this Mac (Chrome, Arc, Brave, Edge, Chromium, Vivaldi). browser and profile pick one (default: the one used last). days: how far back (default 90). exclude: hosts to leave out. limit: at most (default 50).', inputSchema: schema({ browser: str, profile: str, days: num, by: str, exclude: strs, limit: num }) },
  { name: 'browser_bookmarks', description: 'A Chromium browser profile\'s bookmarks: title, link and folder. browser and profile as browser_history.', inputSchema: schema({ browser: str, profile: str }) },
  { name: 'links_in_notes', description: 'The web links written in the notes under a folder, most used first, with the notes they are in.', inputSchema: schema({ folder: str, limit: num }, ['folder']) },
  { name: 'zotero_collections', description: 'The collections of the person\'s Zotero library (as Engelbart keeps a copy of it) with how many items each holds.', inputSchema: schema({}) },
  { name: 'zotero_items', description: 'Items of the Zotero library: key, title, authors, year, DOI, link, whether it has a pdf, its collections. collection: a collection\'s key (its subcollections included). query: words to look for. limit: at most (default 500).', inputSchema: schema({ collection: str, query: str, limit: num }) },
  { name: 'import_zotero_items', description: `Bring Zotero items into the Engelbart library as papers: its pdf when there is one, else its DOI or link. keys: from zotero_items, up to ${MAX_ZOTERO_A_CALL} a call.`, inputSchema: schema({ keys: strs }, ['keys']) },
  { name: 'github_repos', description: 'The GitHub repositories the person\'s GitHub sign-in can read: full name, link, description, private.', inputSchema: schema({}) },
  { name: 'needs_you', description: `Hand the person a step only they can do, shown in the Connect window: kind ${NEEDS_KINDS.join(', ')}; reason: a short line for them ("Sign in to ChatGPT"). Waits up to about three minutes: returns done (go on), skipped (go on without it) or waiting (call wait_for_you).`, inputSchema: schema({ kind: str, reason: str }, ['kind', 'reason']) },
  { name: 'wait_for_you', description: 'Wait again, up to about three minutes, for the step needs_you handed the person. Returns done, skipped or waiting.', inputSchema: schema({}) },
  { name: 'save_memory', description: 'Keep what an AI assistant answered about the person (its research profile) for MEMORY.md. app: the assistant; text: the answer, exactly as written.', inputSchema: schema({ app: str, text: str }, ['app', 'text']) },
];

// What each kind of agent may call: a survey looks, a recall asks and saves its answer, an import brings things in.
const LOOK = ['folder_overview', 'list_note_files', 'list_chats', 'read_chat', 'web_chats', 'web_chat_read', 'browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_screenshot', 'browser_eval', 'overleaf_projects', 'apple_notes_folders', 'apple_notes_list', 'browser_history', 'browser_bookmarks', 'links_in_notes', 'zotero_collections', 'zotero_items', 'github_repos', 'needs_you', 'wait_for_you'];
const TOOLS_FOR = Object.freeze({
  survey: LOOK,
  recall: ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_scroll', 'browser_wait', 'browser_screenshot', 'needs_you', 'wait_for_you', 'save_memory'],
  import: IMPORT_TOOLS.map((tool) => tool.name).filter((name) => name !== 'save_memory'),
});
const WRITING = new Set(['import_note_files', 'add_note', 'add_to_library', 'unpack', 'import_chats', 'import_web_chats', 'browser_download', 'import_google_files', 'import_overleaf_projects', 'import_apple_notes', 'import_zotero_items']);

/** The tool definitions an agent of `kind` is served. */
const toolsFor = (kind) => { const names = new Set(TOOLS_FOR[kind] || TOOLS_FOR.import); return IMPORT_TOOLS.filter((tool) => names.has(tool.name)); };

/** Arguments as a tool's schema says, or an error. */
function validateImportTool(name, args) {
  const tool = IMPORT_TOOLS.find((entry) => entry.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown tool');
  const { properties, required } = tool.inputSchema;
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key];
    if (!type) throw new Error(`Unknown argument ${key}`);
    if (type.type === 'array' && type.items.type === 'object') {
      if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || Object.values(item).some((field) => typeof field !== 'string' || field.includes('\0') || field.length > 4096))) throw new Error(`${key} must be a list of objects of text`);
    } else if (type.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.includes('\0') || item.length > 4096)) throw new Error(`${key} must be a list of text`);
    } else if (type.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
    } else if (typeof value !== type.type) throw new Error(`${key} must be a ${type.type}`);
    if (typeof value === 'string' && (value.includes('\0') || (!['markdown', 'script', 'text'].includes(key) && value.length > 4096))) throw new Error(`${key} is not valid`);
  }
  return args;
}

const importedFile = (dataRoot) => path.join(dataRoot, '.connect', 'imported.json');

/** What has been brought in from where, kept across sessions of one data root. */
function createImported(dataRoot) {
  let held = null;
  const load = () => {
    if (held) return held;
    try { held = new Set(JSON.parse(fs.readFileSync(importedFile(dataRoot), 'utf8'))); } catch { held = new Set(); }
    return held;
  };
  return {
    has: (key) => load().has(key),
    add(key) {
      load().add(key);
      try { fs.mkdirSync(path.dirname(importedFile(dataRoot)), { recursive: true, mode: 0o700 }); fs.writeFileSync(importedFile(dataRoot), JSON.stringify([...held]), { mode: 0o600 }); } catch { /* kept for this run */ }
    },
  };
}

/** A chat as the note that keeps it. */
function chatNote(app, chat) {
  const who = app === 'ChatGPT' || app === 'Codex' || app === 'Cursor' ? app : 'Claude';
  const head = [app, chat.date ? chat.date.slice(0, 10) : '', chat.project].filter(Boolean).join(' · ');
  const turns = chat.turns.map((turn) => `**${turn.role === 'user' ? 'You' : who}:** ${turn.text.trim()}`).join('\n\n');
  return clipMiddle(`*${head}*\n\n${turns}\n`, MAX_NOTE_CHARS);
}

/**
 * Google's Markdown export keeps a document's pictures as data: links at its end, referred to as ![][image1]. Each one is
 * written into `dir` and linked by its path, so the note's pictures are saved with it (./notes.cjs convertMarkdown).
 */
function googleMarkdown(text, dir) {
  const files = new Map();
  let n = 0;
  let body = String(text || '').replace(/^\[([^\]\n]+)\]:\s*<?data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)>?\s*$/gim, (_whole, label, kind, data) => {
    n += 1;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `picture-${Date.now().toString(36)}-${n}.${kind === 'jpeg' ? 'jpg' : kind}`);
    fs.writeFileSync(file, Buffer.from(data.replace(/\s+/g, ''), 'base64'), { mode: 0o600 });
    files.set(label.toLowerCase(), file);
    return '';
  });
  body = body.replace(/!\[([^\]\n]*)\]\[([^\]\n]+)\]/g, (whole, alt, label) => (files.has(label.toLowerCase()) ? `![${alt || label}](${files.get(label.toLowerCase())})` : whole));
  return body.replace(/\n{3,}/g, '\n\n').trim();
}

/** A CSV (a sheet's export) as a Markdown table: the first 200 rows and 20 columns. */
function csvTable(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  const value = String(text || '');
  for (let i = 0; i < value.length && rows.length < 201; i += 1) {
    const ch = value[i];
    if (quoted) { if (ch === '"' && value[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && value[i + 1] === '\n') i += 1; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const kept = rows.filter((r) => r.some((c) => c.trim())).slice(0, 200).map((r) => r.slice(0, 20).map((c) => c.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()));
  if (!kept.length) return '';
  const width = Math.max(...kept.map((r) => r.length));
  const line = (r) => `| ${Array.from({ length: width }, (_, i) => r[i] || '').join(' | ')} |`;
  return [line(kept[0]), `|${' --- |'.repeat(width)}`, ...kept.slice(1).map(line)].join('\n');
}

const looksSignedOut = (file, type) => {
  if (!/html/i.test(type || '')) return false;
  try { const head = fs.readFileSync(file, 'utf8').slice(0, 4000); return /accounts\.google\.com|ServiceLogin|Sign in|<form/i.test(head); } catch { return true; }
};

/**
 * The tools of one import. `session`: { dataRoot, homeDir, dir (its folder), downloads (where downloads and unpacked zips
 * go), projectId() (null until onboarding makes the project), exports (app → the export chosen), folders (app → folder) };
 * `context()` the store's context now; `added(kind, n, what)` counts what this import added ('notes' | 'items');
 * `zotero` { root(), download? }; `github` (its repos()); `library` deps { describe, identifyRepo, inspectPdf, onAdded,
 * onPdf }; `kind` 'import' | 'survey' | 'recall'; `page` the job's browser (./browser.cjs tools), null where there is
 * none; `needs` { ask({ kind, reason }), wait() }; `recall(app, text)` keeps an assistant's answer; `appleNotes`
 * (./apple-notes.cjs); `log(text)` the action log. → call(name, args)
 */
function createImportTools({ session, context, added = () => {}, zotero = null, github = null, deps = {}, env = process.env, kind = 'import', page = null, needs = null, recall = null, appleNotes = null, log = () => {} }) {
  const library = require('../store/library.cjs');
  const mirror = require('../zotero/mirror.cjs');
  const imported = createImported(session.dataRoot);
  const index = notes.createIndex();
  const homeDir = session.homeDir;
  const allowed = new Set(TOOLS_FOR[kind] || TOOLS_FOR.import);
  const downloads = (part) => path.join(session.downloads || path.join(session.dir, 'downloads'), part);

  async function ctxNow() {
    const ctx = await context();
    if (ctx.dataRoot !== session.dataRoot) throw new Error('Engelbart switched to another library while this import ran; it stopped.');
    return ctx;
  }
  const where = (value, what = 'path') => {
    const file = readers.expandPath(homeDir, value);
    if (!file) throw new Error(`${what} must be absolute or start with ~/`);
    if (file !== homeDir && !file.startsWith(homeDir + path.sep)) throw new Error('Only files inside the home directory can be read');
    return file;
  };
  const exportOf = (app) => {
    const file = session.exports && session.exports[app];
    if (!file) throw new Error(`There is no ${app} export on this Mac; use web_chats for ${app}.`);
    return file;
  };
  const browser = () => {
    if (!page) throw new Error('Engelbart\'s browser is not available to this agent. Say so in your reply.');
    return page;
  };

  /** A note, chat or document in: a Markdown file of the library's own in <data root>/assets/md, its pictures beside it. */
  async function putNote({ title, body, images = [], source }) {
    const ctx = await ctxNow();
    const row = await notes.writeFile(ctx, { title, body, images }, { library });
    if (deps.onAdded) deps.onAdded(row);
    if (source) imported.add(source);
    added('notes', 1, title);
  }

  async function addRow(input, name, { describe = true } = {}) {
    const ctx = await ctxNow();
    try {
      const row = await library.addItem(ctx, input, { describe: describe ? deps.describe : undefined, identifyRepo: deps.identifyRepo, inspectPdf: deps.inspectPdf, name: name || null });
      if (row.type === 'pdf' && deps.onPdf) deps.onPdf();
      if (deps.onAdded) deps.onAdded(row);
      added('items', 1, row.name);
      return { added: true, id: row.id, name: row.name, type: row.type, tags: row.tags };
    } catch (error) {
      if (error && error.code === 'EXISTS') return { added: false, already: error.row ? error.row.name : true };
      throw error;
    }
  }

  /** A downloaded pdf or picture copied into the library (assets/), else the file added where it is. */
  async function addFile(file, name, url = null) {
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.pdf' ? 'application/pdf' : { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[ext];
    if (!mime) return addRow(file, name, { describe: false });
    const ctx = await ctxNow();
    const bytes = fs.readFileSync(file);
    try {
      const row = await library.addFileCopy(ctx, { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime, name, url }, { inspectPdf: deps.inspectPdf });
      if (mime === 'application/pdf' && deps.onPdf) deps.onPdf();
      if (deps.onAdded) deps.onAdded(row);
      added('items', 1, row.name);
      return { added: true, id: row.id, name: row.name, type: row.type };
    } catch (error) {
      if (error && error.code === 'EXISTS') return { added: false, already: error.row ? error.row.name : true };
      throw error;
    }
  }

  /** A zip's files written into a folder of the imports (names that would leave it are passed over). → { folder, files } */
  function unzipInto(buffer, folder) {
    const { files, skipped } = readZip(buffer);
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    let written = 0;
    for (const entry of files) {
      const rel = safeName(entry.name);
      if (!rel) continue;
      const target = path.join(folder, ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, entry.data, { mode: 0o600 });
      written += 1;
    }
    return { folder, files: written, skipped: skipped.length };
  }

  const chatApp = (app) => { if (!CHAT_APPS.includes(app)) throw new Error(`app must be one of ${CHAT_APPS.join(', ')}`); return app; };
  const listLocal = (app, options) => (app === 'Cursor' ? cursorChats(homeDir, options) : app === 'Claude' || app === 'ChatGPT' ? readers.exportChats(exportOf(app), options) : readers.localChats(app, { homeDir, env, ...options }));
  const readLocal = (app, id) => (app === 'Cursor' ? cursorTranscript(homeDir, id) : app === 'Claude' || app === 'ChatGPT' ? readers.exportTranscript(exportOf(app), id) : readers.localTranscript(app, id, { homeDir, env }));

  let waiting = null; // the step needs_you handed over, while the person has not answered

  const call = {
    folder_overview: ({ path: dir }) => readers.folderOverview(where(dir), { homeDir }),
    list_note_files: ({ folder, include, exclude, days }) => {
      const files = readers.noteFiles(where(folder, 'folder'), { include, exclude, days, max: 5000 });
      return { total: files.length, files: files.slice(0, 2000), more: Math.max(0, files.length - 2000) };
    },
    import_note_files: async ({ files, root }) => {
      if (files.length > MAX_FILES_A_CALL) throw new Error(`At most ${MAX_FILES_A_CALL} files a call`);
      const base = root ? where(root, 'root') : '';
      let count = 0;
      const skipped = [];
      for (const given of files) {
        let file;
        try { file = where(given); } catch (error) { skipped.push({ file: given, why: error.message }); continue; }
        const key = `file:${file}`;
        if (imported.has(key)) { skipped.push({ file: given, why: 'brought in before' }); continue; }
        if (!readers.NOTE_EXT.has(path.extname(file).toLowerCase())) { skipped.push({ file: given, why: 'not a note file' }); continue; }
        let stat;
        try { stat = fs.statSync(file); } catch { skipped.push({ file: given, why: 'not there' }); continue; }
        if (!stat.isFile() || stat.size > notes.MAX_NOTE_BYTES) { skipped.push({ file: given, why: stat.isFile() ? 'larger than 5 MB' : 'not a file' }); continue; }
        const { body, images } = notes.convertMarkdown(fs.readFileSync(file, 'utf8'), { sourcePath: file, root: base || path.dirname(file), index });
        await putNote({ title: path.basename(file, path.extname(file)), body, images, source: key });
        count += 1;
      }
      if (count) log(`Brought in ${count} note${count === 1 ? '' : 's'}`);
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length, where: 'the library, as Markdown files in Engelbart\'s assets/md' };
    },
    add_note: async ({ title, markdown, source }) => {
      if (markdown.length > MAX_NOTE_CHARS) throw new Error(`A note is at most ${MAX_NOTE_CHARS} characters`);
      const key = source ? `note:${source}` : '';
      if (key && imported.has(key)) return { added: false, why: 'brought in before' };
      const { body, images } = notes.convertMarkdown(markdown, { root: session.downloads || '' });
      await putNote({ title: sanitizeName(title), body, images, source: key });
      log(`Wrote “${String(title).slice(0, 60)}”`);
      return { added: true };
    },
    add_to_library: ({ input, name }) => addRow(input, name),
    unpack: ({ file }) => {
      const zip = where(file, 'file');
      if (!/\.zip$/i.test(zip)) throw new Error('Only a .zip can be unpacked');
      const out = unzipInto(fs.readFileSync(zip), downloads(path.basename(zip, '.zip').replace(/[^\w .-]+/g, '-').slice(0, 80) || 'unpacked'));
      log(`Unpacked ${path.basename(zip)}`);
      return { ...out, overview: readers.folderOverview(out.folder, { homeDir, top: 15 }) };
    },
    list_chats: ({ app, days, project, query, limit = 200, automated = false }) => {
      chatApp(app);
      const cap = Math.min(Math.max(1, Math.round(limit)), 1000);
      return listLocal(app, { days, project, query, limit: cap, automated }).map((chat) => ({ ...chat, imported: imported.has(`chat:${app}:${chat.id}`) }));
    },
    read_chat: ({ app, id, max_chars: max = 6000 }) => {
      chatApp(app);
      const chat = readLocal(app, id);
      return { title: chat.title, date: chat.date, project: chat.project, text: clipMiddle(chat.turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n'), Math.min(Math.max(500, max), 40000)) };
    },
    import_chats: async ({ app, ids }) => {
      chatApp(app);
      if (ids.length > MAX_CHATS_A_CALL) throw new Error(`At most ${MAX_CHATS_A_CALL} chats a call`);
      let count = 0;
      const skipped = [];
      for (const id of ids) {
        const key = `chat:${app}:${id}`;
        if (imported.has(key)) { skipped.push({ id, why: 'brought in before' }); continue; }
        let chat;
        try { chat = readLocal(app, id); } catch (error) { skipped.push({ id, why: error.message }); continue; }
        if (!chat.turns.length) { skipped.push({ id, why: 'no turns of text' }); continue; }
        await putNote({ title: chat.title || `${app} chat`, body: chatNote(app, chat), images: [], source: key });
        count += 1;
      }
      if (count) log(`Brought in ${count} ${app} chat${count === 1 ? '' : 's'}`);
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length };
    },
    web_chats: async ({ app, days, query, project, limit = 200 }) => {
      const out = await listWebChats(browser(), app, { days, query, project, limit });
      log(`Listed ${out.chats.length} ${app} chat${out.chats.length === 1 ? '' : 's'}`);
      return { ...out, chats: out.chats.map((chat) => ({ ...chat, imported: imported.has(`chat:${app}:${chat.id}`) })) };
    },
    web_chat_read: async ({ app, id, max_chars: max = 6000 }) => {
      const chat = await readWebChat(browser(), app, id);
      return { title: chat.title, date: chat.date, text: clipMiddle(chat.turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n'), Math.min(Math.max(500, max), 40000)) };
    },
    import_web_chats: async ({ app, ids }) => {
      if (ids.length > MAX_WEB_CHATS_A_CALL) throw new Error(`At most ${MAX_WEB_CHATS_A_CALL} chats a call`);
      let count = 0;
      const skipped = [], left = [];
      const deadline = Date.now() + CALL_BUDGET_MS;
      for (const id of ids) {
        if (Date.now() > deadline) { left.push(id); continue; }
        const key = `chat:${app}:${id}`;
        if (imported.has(key)) { skipped.push({ id, why: 'brought in before' }); continue; }
        let chat;
        try { chat = await readWebChat(browser(), app, id); } catch (error) { if (error.code === 'SIGNED_OUT') throw error; skipped.push({ id, why: error.message }); continue; }
        if (!chat.turns.length) { skipped.push({ id, why: 'no turns of text' }); continue; }
        await putNote({ title: chat.title, body: chatNote(app, chat), images: [], source: key });
        count += 1;
      }
      if (count) log(`Brought in ${count} ${app} chat${count === 1 ? '' : 's'}`);
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length, ...(left.length ? { left } : {}) };
    },
    browser_open: ({ url }) => browser().open(url),
    browser_read: ({ offset = 0, max_chars: maxChars = 8000 }) => browser().read({ offset, maxChars }),
    browser_click: ({ ref }) => browser().click(ref),
    browser_type: ({ ref, text, submit = false, replace = false }) => browser().type(ref, text, { submit, replace }),
    browser_press: ({ key }) => browser().press(key),
    browser_scroll: ({ ref = '', direction = 'down', amount = 800 }) => browser().scroll({ ref, direction, amount }),
    browser_wait: ({ seconds = 5, until_text: untilText = '', until_gone: untilGone = '', stable = false }) => browser().wait({ seconds, untilText, untilGone, stable }),
    browser_screenshot: async () => { const shot = await browser().screenshot(); return mcpContent([{ type: 'image', data: shot.data, mimeType: shot.mimeType }]); },
    browser_eval: ({ script }) => browser().evaluate(script),
    browser_download: async ({ url, name = '' }) => {
      const out = await browser().download(url, downloads('files'), { name });
      return { path: out.path, bytes: out.bytes, type: out.type };
    },
    import_google_files: async ({ items }) => {
      if (items.length > MAX_GOOGLE_A_CALL) throw new Error(`At most ${MAX_GOOGLE_A_CALL} files a call`);
      const pageNow = browser();
      let count = 0;
      const skipped = [], left = [];
      const deadline = Date.now() + CALL_BUDGET_MS;
      for (const item of items) {
        if (Date.now() > deadline) { left.push(item.id); continue; }
        const id = String(item.id || ''), kindOf = String(item.kind || 'doc').toLowerCase(), named = String(item.name || '').trim();
        if (!GOOGLE_ID_RE.test(id)) { skipped.push({ id, why: 'not a Drive id' }); continue; }
        if (!GOOGLE_KINDS.includes(kindOf)) { skipped.push({ id, why: `kind must be one of ${GOOGLE_KINDS.join(', ')}` }); continue; }
        const key = `google:${id}`;
        if (imported.has(key)) { skipped.push({ id, why: 'brought in before' }); continue; }
        try {
          if (kindOf === 'doc' || kindOf === 'sheet' || kindOf === 'slides') {
            const url = kindOf === 'doc' ? `https://docs.google.com/document/d/${id}/export?format=md`
              : kindOf === 'sheet' ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`
                : `https://docs.google.com/presentation/d/${id}/export/txt`;
            const got = await pageNow.download(url, downloads('google'), { name: `${id}.${kindOf === 'doc' ? 'md' : kindOf === 'sheet' ? 'csv' : 'txt'}`, quiet: true });
            if (looksSignedOut(got.path, got.type)) { fs.rmSync(got.path, { force: true }); throw Object.assign(new Error('Not signed in to Google in Engelbart\'s browser. Call needs_you with kind "signin", then try again.'), { code: 'SIGNED_OUT' }); }
            const text = fs.readFileSync(got.path, 'utf8');
            fs.rmSync(got.path, { force: true });
            const markdown = kindOf === 'doc' ? googleMarkdown(text, downloads('google')) : kindOf === 'sheet' ? csvTable(text) : text.trim();
            const title = named || (markdown.match(/^#\s+(.+)$/m) || [])[1] || `Google ${kindOf} ${id.slice(0, 8)}`;
            const { body, images } = notes.convertMarkdown(markdown, { root: downloads('google') });
            await putNote({ title: sanitizeName(title), body: `*Google Drive · https://drive.google.com/open?id=${id}*\n\n${body}`, images, source: key });
          } else {
            let got = await pageNow.download(`https://drive.google.com/uc?export=download&id=${id}`, downloads('google'), { name: named, quiet: true });
            if (/html/i.test(got.type)) { // a large file's virus-scan warning, or a sign-in page
              fs.rmSync(got.path, { force: true });
              got = await pageNow.download(`https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`, downloads('google'), { name: named, quiet: true });
              if (looksSignedOut(got.path, got.type)) { fs.rmSync(got.path, { force: true }); throw Object.assign(new Error('Not signed in to Google in Engelbart\'s browser. Call needs_you with kind "signin", then try again.'), { code: 'SIGNED_OUT' }); }
            }
            const ext = path.extname(got.path).toLowerCase();
            if (readers.NOTE_EXT.has(ext)) {
              const { body, images } = notes.convertMarkdown(fs.readFileSync(got.path, 'utf8'), { sourcePath: got.path, root: path.dirname(got.path) });
              await putNote({ title: sanitizeName(named || path.basename(got.path, ext)), body, images, source: key });
            } else {
              const out = await addFile(got.path, named || path.basename(got.path, ext), null);
              if (!out.added) { imported.add(key); skipped.push({ id, why: 'in the library already' }); continue; }
              imported.add(key);
            }
          }
          count += 1;
        } catch (error) {
          if (error.code === 'SIGNED_OUT') throw error;
          skipped.push({ id, why: String(error.message).slice(0, 200) });
        }
      }
      if (count) log(`Brought in ${count} Google Drive file${count === 1 ? '' : 's'}`);
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length, ...(left.length ? { left } : {}) };
    },
    overleaf_projects: async () => {
      const pageNow = browser();
      await pageNow.ensure('https://www.overleaf.com/project');
      const out = await pageNow.evaluate(`
        const meta = document.querySelector('meta[name="ol-prefetchedProjectsBlob"]');
        if (meta) { try { const blob = JSON.parse(meta.content); return { projects: (blob.projects || []).map((p) => ({ id: p.id, name: p.name, updated: p.lastUpdated, owner: p.owner && (p.owner.email || ((p.owner.firstName || '') + ' ' + (p.owner.lastName || '')).trim()), archived: !!p.archived, trashed: !!p.trashed })) }; } catch (e) {} }
        if (/\\/login/.test(location.pathname) || document.querySelector('form[action*="login"]')) return { signedIn: false };
        return { projects: [...document.querySelectorAll('a[href^="/project/"]')].map((a) => ({ id: a.getAttribute('href').split('/')[2], name: a.textContent.trim() })) };`);
      if (out && out.signedIn === false) throw Object.assign(new Error('Not signed in to Overleaf in Engelbart\'s browser. Call needs_you with kind "signin", then try again.'), { code: 'SIGNED_OUT' });
      const projectsList = ((out && out.projects) || []).filter((p) => p && OVERLEAF_ID_RE.test(String(p.id)));
      log(`Listed ${projectsList.length} Overleaf project${projectsList.length === 1 ? '' : 's'}`);
      return { projects: projectsList.slice(0, 500) };
    },
    import_overleaf_projects: async ({ ids }) => {
      const pageNow = browser();
      let count = 0;
      const skipped = [], left = [];
      const deadline = Date.now() + CALL_BUDGET_MS;
      for (const id of ids.slice(0, 20)) {
        if (Date.now() > deadline) { left.push(id); continue; }
        if (!OVERLEAF_ID_RE.test(id)) { skipped.push({ id, why: 'not an Overleaf project id' }); continue; }
        const key = `overleaf:${id}`;
        if (imported.has(key)) { skipped.push({ id, why: 'brought in before' }); continue; }
        try {
          const got = await pageNow.download(`https://www.overleaf.com/project/${id}/download/zip`, downloads('overleaf'), { quiet: true });
          const buffer = fs.readFileSync(got.path);
          fs.rmSync(got.path, { force: true });
          if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) throw Object.assign(new Error('Overleaf sent no project: not signed in to Overleaf in Engelbart\'s browser. Call needs_you with kind "signin", then try again.'), { code: 'SIGNED_OUT' });
          const name = sanitizeName(path.basename(got.path, '.zip')) || `Overleaf ${id.slice(0, 6)}`;
          const { folder } = unzipInto(buffer, downloads(path.join('overleaf', name)));
          await addRow(folder, `${name} (Overleaf)`, { describe: false });
          const main = findMainTex(folder);
          if (main) await putNote({ title: sanitizeName(`${name} (main.tex)`), body: `*Overleaf · https://www.overleaf.com/project/${id}*\n\n\`\`\`latex\n${clipMiddle(fs.readFileSync(main, 'utf8'), 150_000)}\n\`\`\`\n`, images: [], source: `${key}:main` });
          for (const pdf of fs.readdirSync(folder).filter((file) => /\.pdf$/i.test(file)).slice(0, 3)) await addFile(path.join(folder, pdf), `${name}: ${path.basename(pdf, '.pdf')}`);
          imported.add(key);
          count += 1;
        } catch (error) {
          if (error.code === 'SIGNED_OUT') throw error;
          skipped.push({ id, why: String(error.message).slice(0, 200) });
        }
      }
      if (count) log(`Brought in ${count} Overleaf project${count === 1 ? '' : 's'}`);
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length, ...(left.length ? { left } : {}) };
    },
    apple_notes_folders: async () => { const notesApp = appleNotesOf(); const out = await notesApp.folders(); log('Read Apple Notes\' folders'); return out; },
    apple_notes_list: async ({ folder = '', days, query = '', limit = 500 }) => appleNotesOf().list({ folder, days, query, limit }),
    import_apple_notes: async ({ ids }) => {
      const wanted = ids.slice(0, 200).filter((id) => !imported.has(`apple-notes:${id}`));
      const read = await appleNotesOf().read(wanted, { pictureDir: downloads('apple-notes') });
      let count = 0;
      const skipped = ids.length - wanted.length ? [{ why: 'brought in before', count: ids.length - wanted.length }] : [];
      for (const note of read) {
        if (note.error) { skipped.push({ id: note.id, why: String(note.error).slice(0, 120) }); continue; }
        const { body, images } = notes.convertMarkdown(note.markdown, { root: downloads('apple-notes') });
        await putNote({ title: sanitizeName(note.name), body, images, source: `apple-notes:${note.id}` });
        count += 1;
      }
      if (count) log(`Brought in ${count} Apple Note${count === 1 ? '' : 's'}`);
      return { added: count, skipped: skipped.slice(0, 30) };
    },
    browser_history: async ({ browser: which, profile, days = 90, by = 'site', exclude = [], limit = 50 }) => {
      const found = readers.profileOf(homeDir, { browser: which, profile });
      if (!found) throw new Error('No Chromium browser profile with a history was found on this Mac');
      log(`Read ${found.browser}'s history`);
      return { browser: found.browser, profile: found.name, entries: await readers.browserHistory(found.dir, { days, by: by === 'page' ? 'page' : 'site', exclude, limit: Math.min(Math.max(1, Math.round(limit)), 500) }) };
    },
    browser_bookmarks: ({ browser: which, profile }) => {
      const found = readers.profileOf(homeDir, { browser: which, profile });
      if (!found) throw new Error('No Chromium browser profile was found on this Mac');
      log(`Read ${found.browser}'s bookmarks`);
      return { browser: found.browser, profile: found.name, bookmarks: readers.browserBookmarks(found.dir) };
    },
    links_in_notes: ({ folder, limit = 200 }) => readers.linksIn(where(folder, 'folder'), { limit: Math.min(Math.max(1, Math.round(limit)), 1000) }),
    zotero_collections: () => readers.zoteroCollections(zoteroRoot()),
    zotero_items: ({ collection = '', query = '', limit = 500 }) => readers.zoteroItems(zoteroRoot(), { collection, query, limit: Math.min(Math.max(1, Math.round(limit)), 2000) }),
    import_zotero_items: async ({ keys }) => {
      if (keys.length > MAX_ZOTERO_A_CALL) throw new Error(`At most ${MAX_ZOTERO_A_CALL} items a call`);
      const root = zoteroRoot();
      let count = 0, already = 0;
      const skipped = [];
      for (const key of keys) {
        const item = mirror.itemOf(root, key);
        if (!item) { skipped.push({ key, why: 'not in the library' }); continue; }
        const source = `zotero:${key}`;
        if (imported.has(source)) { already += 1; continue; }
        const title = String(item.title || '').slice(0, 200);
        let out = null;
        try {
          const attachment = mirror.openableOf(item);
          const here = attachment && attachment.contentType === 'application/pdf' ? mirror.localFile(root, attachment) : null;
          if (here && here.source !== 'downloaded') out = await addRow(here.path, title, { describe: false });
          else if (here || (attachment && attachment.contentType === 'application/pdf' && zotero && zotero.download)) {
            const file = here ? here.path : await zotero.download(attachment.key, attachment.filename);
            out = await addFile(file, title, item.doi ? `https://doi.org/${item.doi}` : (item.url || null));
          } else if (item.doi) out = await addRow(`https://doi.org/${item.doi}`, title, { describe: false });
          else if (item.url) out = await addRow(item.url, title, { describe: false });
          else { skipped.push({ key, why: 'no pdf, DOI or link' }); continue; }
        } catch (error) { skipped.push({ key, why: error.message }); continue; }
        imported.add(source);
        if (out && out.added) count += 1; else already += 1;
      }
      if (count) log(`Brought in ${count} paper${count === 1 ? '' : 's'} from Zotero`);
      return { added: count, alreadyInLibrary: already, skipped: skipped.slice(0, 30), skippedCount: skipped.length };
    },
    github_repos: async () => {
      if (!github || !github.status().connected) throw new Error('GitHub is not signed in. Call needs_you with kind "signin" and reason "Sign in to GitHub".');
      const { repos = [] } = await github.repos();
      return repos.map((repo) => ({ fullName: repo.fullName, url: repo.url, description: repo.description || '', private: !!repo.private }));
    },
    needs_you: async ({ kind: what, reason }) => {
      if (!needs) throw new Error('Nobody can be asked from here. Say what you could not do in your reply.');
      if (!NEEDS_KINDS.includes(what)) throw new Error(`kind must be one of ${NEEDS_KINDS.join(', ')}`);
      waiting = true;
      const out = await needs.ask({ kind: what, reason: String(reason).replace(/\s+/g, ' ').trim().slice(0, 160) });
      if (out.status !== 'waiting') waiting = null;
      return out;
    },
    wait_for_you: async () => {
      if (!needs || !waiting) return { status: 'done', note: 'Nothing is waiting on the person.' };
      const out = await needs.wait();
      if (out.status !== 'waiting') waiting = null;
      return out;
    },
    save_memory: async ({ app, text }) => {
      if (!recall) throw new Error('This agent does not keep memories');
      const value = String(text).trim();
      if (value.length < 20) throw new Error('That answer is too short to keep: read the whole answer first');
      await recall(app, value);
      log(`Kept what ${app} remembers (${value.length.toLocaleString('en-US')} characters)`);
      return { saved: true, chars: value.length };
    },
  };

  function appleNotesOf() {
    if (!appleNotes) throw new Error('Apple Notes cannot be read here');
    return appleNotes;
  }

  function zoteroRoot() {
    const root = zotero && zotero.root ? zotero.root() : null;
    if (!root) throw new Error('Zotero is not signed in. Call needs_you with kind "signin" and reason "Sign in to Zotero".');
    return root;
  }

  return async function callTool(name, args) {
    validateImportTool(name, args || {});
    if (!allowed.has(name)) throw new Error(kind === 'survey' && WRITING.has(name) ? 'A survey brings nothing in: report what you found instead.' : `${name} is not one of this agent's tools`);
    return call[name](args || {});
  };
}

/** The .tex file of an unpacked Overleaf project that has \documentclass, main.tex first. */
function findMainTex(folder) {
  const all = [];
  readers.walkFiles(folder, { max: 5000 }, (file, name) => { if (/\.tex$/i.test(name)) all.push(file); });
  const ordered = all.sort((a, b) => (path.basename(a).toLowerCase() === 'main.tex' ? -1 : 0) - (path.basename(b).toLowerCase() === 'main.tex' ? -1 : 0));
  return ordered.find((file) => { try { return /\\documentclass/.test(fs.readFileSync(file, 'utf8').slice(0, 20000)); } catch { return false; } }) || null;
}

module.exports = { IMPORT_TOOLS, TOOLS_FOR, toolsFor, CHAT_APPS, NEEDS_KINDS, validateImportTool, createImported, createImportTools, chatNote, googleMarkdown, csvTable };
