'use strict';

// Connect your library (2026-10-07, experimental, test mode only): the tools an import agent is given, served to Claude
// Code and Codex as the MCP server `engelbart` (./import-mcp.cjs) over the loopback bridge Build's tools use
// (../sandbox/local-tools.cjs openToolBridge), one bridge per import. The agent decides what to bring in from what the
// person said in the chat; these do the reading and the writing, so a vault of 300 notes is one call, not 300.
// They only ever write into the Engelbart data root the session started in (in test mode ~/.engelbart/test): notes of the
// project onboarding makes (staged until it exists, ./notes.cjs) and library rows (../store/library.cjs addItem, as the
// sidebar adds them). Nothing the person has is changed, moved or deleted.
// What has been brought in is remembered in <data root>/.connect/imported.json (a note's source file, a chat's id, a
// Zotero item's key), so a second import of the same thing is skipped instead of making "Note 2".

const fs = require('node:fs');
const path = require('node:path');
const readers = require('./readers.cjs');
const notes = require('./notes.cjs');
const { clipMiddle } = require('../bart/clip.cjs');
const { sanitizeName } = require('../store/home.cjs');

const str = { type: 'string' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const strs = { type: 'array', items: { type: 'string' } };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const CHAT_APPS = ['Claude Code', 'Codex', 'Claude', 'ChatGPT'];
const MAX_FILES_A_CALL = 300;
const MAX_CHATS_A_CALL = 100;
const MAX_ZOTERO_A_CALL = 300;
const MAX_NOTE_CHARS = 200_000;

const IMPORT_TOOLS = [
  { name: 'folder_overview', description: 'A folder at a glance: how many notes, pdfs and pictures it holds, and the same for each folder at its top (most notes first), with the share of notes named by date and the daily-notes folder when there is one. path: absolute or ~/….', inputSchema: schema({ path: str }, ['path']) },
  { name: 'list_note_files', description: 'The note files (.md, .markdown, .txt) under a folder, newest first, as absolute paths. include: only these folders (relative to it); exclude: never these; days: only those changed in the last n days.', inputSchema: schema({ folder: str, include: strs, exclude: strs, days: num }, ['folder']) },
  { name: 'import_note_files', description: `Bring note files into Engelbart, each as its own note named by its file, its pictures included and Obsidian links ([[Note]]) turned into mentions. files: absolute paths, up to ${MAX_FILES_A_CALL} a call (call again for more). root: the vault or export folder they come from, where pictures are looked up by name. A file brought in before is skipped. Returns how many were added and why any were skipped.`, inputSchema: schema({ files: strs, root: str }, ['files']) },
  { name: 'add_note', description: 'Add a note you wrote (Markdown) to Engelbart: a meeting transcript tidied up, a summary of a source with no files of its own. title: what it is called. source: where it came from, a path or link, so it is not brought in twice.', inputSchema: schema({ title: str, markdown: str, source: str }, ['title', 'markdown']) },
  { name: 'add_to_library', description: 'Add one thing to the Engelbart library: a web link, a GitHub repository link, an arXiv id or DOI, or the absolute path of a pdf, file or folder (a folder with .git is a repository). name: what the library calls it (optional). Something the library already holds is not added twice.', inputSchema: schema({ input: str, name: str }, ['input']) },
  { name: 'list_chats', description: `AI chats on this Mac or in an export the person chose, newest first: id, title, first prompt, folder, date. app: ${CHAT_APPS.join(', ')}. days: only the last n days. project: only chats run in a folder whose path holds this. query: words to look for. automated: include runs a program started (left out by default). limit: at most (default 200).`, inputSchema: schema({ app: str, days: num, project: str, query: str, limit: num, automated: bool }, ['app']) },
  { name: 'read_chat', description: 'One chat as its turns of text (tool calls left out), to judge what it is about. max_chars: how much at most (default 6000).', inputSchema: schema({ app: str, id: str, max_chars: num }, ['app', 'id']) },
  { name: 'import_chats', description: `Bring chats into Engelbart, each as a note of its turns (what the person asked and what the assistant answered), named by the chat's title. ids: from list_chats, up to ${MAX_CHATS_A_CALL} a call. A chat brought in before is skipped.`, inputSchema: schema({ app: str, ids: strs }, ['app', 'ids']) },
  { name: 'browser_history', description: 'The most visited sites (by "site", the default) or pages (by "page") in a Chromium browser on this Mac (Chrome, Arc, Brave, Edge, Chromium, Vivaldi). browser and profile pick one (default: the one used last). days: how far back (default 90). exclude: hosts to leave out. limit: at most (default 50).', inputSchema: schema({ browser: str, profile: str, days: num, by: str, exclude: strs, limit: num }) },
  { name: 'browser_bookmarks', description: 'A Chromium browser profile\'s bookmarks: title, link and folder. browser and profile as browser_history.', inputSchema: schema({ browser: str, profile: str }) },
  { name: 'links_in_notes', description: 'The web links written in the notes under a folder, most used first, with the notes they are in.', inputSchema: schema({ folder: str, limit: num }, ['folder']) },
  { name: 'zotero_collections', description: 'The collections of the person\'s Zotero library (as Engelbart keeps a copy of it) with how many items each holds.', inputSchema: schema({}) },
  { name: 'zotero_items', description: 'Items of the Zotero library: key, title, authors, year, DOI, link, whether it has a pdf, its collections. collection: a collection\'s key (its subcollections included). query: words to look for. limit: at most (default 500).', inputSchema: schema({ collection: str, query: str, limit: num }) },
  { name: 'import_zotero_items', description: `Bring Zotero items into the Engelbart library as papers: its pdf when there is one, else its DOI or link. keys: from zotero_items, up to ${MAX_ZOTERO_A_CALL} a call.`, inputSchema: schema({ keys: strs }, ['keys']) },
  { name: 'github_repos', description: 'The GitHub repositories the person\'s GitHub sign-in can read: full name, link, description, private.', inputSchema: schema({}) },
];

/** Arguments as a tool's schema says, or an error. */
function validateImportTool(name, args) {
  const tool = IMPORT_TOOLS.find((entry) => entry.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown tool');
  const { properties, required } = tool.inputSchema;
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key];
    if (!type) throw new Error(`Unknown argument ${key}`);
    if (type.type === 'array') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.includes('\0') || item.length > 4096)) throw new Error(`${key} must be a list of text`);
    } else if (type.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a number`);
    } else if (typeof value !== type.type) throw new Error(`${key} must be a ${type.type}`);
    if (typeof value === 'string' && (value.includes('\0') || (key !== 'markdown' && value.length > 4096))) throw new Error(`${key} is not valid`);
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
  const who = app === 'ChatGPT' || app === 'Codex' ? app : 'Claude';
  const head = [app, chat.date ? chat.date.slice(0, 10) : '', chat.project].filter(Boolean).join(' · ');
  const turns = chat.turns.map((turn) => `**${turn.role === 'user' ? 'You' : who}:** ${turn.text.trim()}`).join('\n\n');
  return clipMiddle(`*${head}*\n\n${turns}\n`, MAX_NOTE_CHARS);
}

/**
 * The tools of one import. `session`: { dataRoot, homeDir, dir (its folder), projectId() (null until onboarding makes the
 * project), exports (app → the file or folder the person chose), folders (app → folder) }; `context()` the store's
 * context now; `added(kind, n)` counts what this import added ('notes' | 'items'); `zotero` { root(), download? };
 * `github` (its repos()); `library` deps { describe, identifyRepo, inspectPdf, onAdded, onPdf }. → call(name, args)
 */
function createImportTools({ session, context, added = () => {}, zotero = null, github = null, deps = {}, env = process.env }) {
  const projects = require('../store/projects.cjs');
  const library = require('../store/library.cjs');
  const mirror = require('../zotero/mirror.cjs');
  const imported = createImported(session.dataRoot);
  const index = notes.createIndex();
  const homeDir = session.homeDir;

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
    if (!file) throw new Error(`The person has not chosen a ${app} export yet. Say so in your reply.`);
    return file;
  };

  /** A note in: written into the project when there is one, else staged until onboarding makes it. */
  async function putNote({ title, body, images = [], source }) {
    const ctx = await ctxNow();
    const projectId = session.projectId();
    if (projectId) await notes.writeNote(ctx, projectId, { title, body, images }, { projects });
    else notes.stageNote(session.dir, { title, body, images, source });
    if (source) imported.add(source);
    added('notes', 1);
  }

  async function addRow(input, name, { describe = true } = {}) {
    const ctx = await ctxNow();
    try {
      const row = await library.addItem(ctx, input, { describe: describe ? deps.describe : undefined, identifyRepo: deps.identifyRepo, inspectPdf: deps.inspectPdf, name: name || null });
      if (row.type === 'pdf' && deps.onPdf) deps.onPdf();
      if (deps.onAdded) deps.onAdded(row);
      added('items', 1);
      return { added: true, id: row.id, name: row.name, type: row.type, tags: row.tags };
    } catch (error) {
      if (error && error.code === 'EXISTS') return { added: false, already: error.row ? error.row.name : true };
      throw error;
    }
  }

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
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length, where: session.projectId() ? 'the new project' : 'held until onboarding makes the project' };
    },
    add_note: async ({ title, markdown, source }) => {
      if (markdown.length > MAX_NOTE_CHARS) throw new Error(`A note is at most ${MAX_NOTE_CHARS} characters`);
      const key = source ? `note:${source}` : '';
      if (key && imported.has(key)) return { added: false, why: 'brought in before' };
      await putNote({ title: sanitizeName(title), body: markdown, images: [], source: key });
      return { added: true };
    },
    add_to_library: ({ input, name }) => addRow(input, name),
    list_chats: ({ app, days, project, query, limit = 200, automated = false }) => {
      if (!CHAT_APPS.includes(app)) throw new Error(`app must be one of ${CHAT_APPS.join(', ')}`);
      const cap = Math.min(Math.max(1, Math.round(limit)), 1000);
      const list = app === 'Claude' || app === 'ChatGPT' ? readers.exportChats(exportOf(app), { days, query, limit: cap }) : readers.localChats(app, { homeDir, env, days, project, query, limit: cap, automated });
      return list.map((chat) => ({ ...chat, imported: imported.has(`chat:${app}:${chat.id}`) }));
    },
    read_chat: ({ app, id, max_chars: max = 6000 }) => {
      if (!CHAT_APPS.includes(app)) throw new Error(`app must be one of ${CHAT_APPS.join(', ')}`);
      const chat = app === 'Claude' || app === 'ChatGPT' ? readers.exportTranscript(exportOf(app), id) : readers.localTranscript(app, id, { homeDir, env });
      return { title: chat.title, date: chat.date, project: chat.project, text: clipMiddle(chat.turns.map((turn) => `${turn.role}: ${turn.text}`).join('\n\n'), Math.min(Math.max(500, max), 40000)) };
    },
    import_chats: async ({ app, ids }) => {
      if (!CHAT_APPS.includes(app)) throw new Error(`app must be one of ${CHAT_APPS.join(', ')}`);
      if (ids.length > MAX_CHATS_A_CALL) throw new Error(`At most ${MAX_CHATS_A_CALL} chats a call`);
      let count = 0;
      const skipped = [];
      for (const id of ids) {
        const key = `chat:${app}:${id}`;
        if (imported.has(key)) { skipped.push({ id, why: 'brought in before' }); continue; }
        let chat;
        try { chat = app === 'Claude' || app === 'ChatGPT' ? readers.exportTranscript(exportOf(app), id) : readers.localTranscript(app, id, { homeDir, env }); } catch (error) { skipped.push({ id, why: error.message }); continue; }
        if (!chat.turns.length) { skipped.push({ id, why: 'no turns of text' }); continue; }
        await putNote({ title: chat.title || `${app} chat`, body: chatNote(app, chat), images: [], source: key });
        count += 1;
      }
      return { added: count, skipped: skipped.slice(0, 30), skippedCount: skipped.length };
    },
    browser_history: async ({ browser, profile, days = 90, by = 'site', exclude = [], limit = 50 }) => {
      const found = readers.profileOf(homeDir, { browser, profile });
      if (!found) throw new Error('No Chromium browser profile with a history was found on this Mac');
      return { browser: found.browser, profile: found.name, entries: await readers.browserHistory(found.dir, { days, by: by === 'page' ? 'page' : 'site', exclude, limit: Math.min(Math.max(1, Math.round(limit)), 500) }) };
    },
    browser_bookmarks: ({ browser, profile }) => {
      const found = readers.profileOf(homeDir, { browser, profile });
      if (!found) throw new Error('No Chromium browser profile was found on this Mac');
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
            const ctx = await ctxNow();
            const bytes = fs.readFileSync(file);
            try {
              const row = await library.addFileCopy(ctx, { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: 'application/pdf', name: title, url: item.doi ? `https://doi.org/${item.doi}` : (item.url || null) }, { inspectPdf: deps.inspectPdf });
              if (deps.onPdf) deps.onPdf();
              if (deps.onAdded) deps.onAdded(row);
              added('items', 1);
              out = { added: true };
            } catch (error) { if (error && error.code === 'EXISTS') out = { added: false }; else throw error; }
          } else if (item.doi) out = await addRow(`https://doi.org/${item.doi}`, title, { describe: false });
          else if (item.url) out = await addRow(item.url, title, { describe: false });
          else { skipped.push({ key, why: 'no pdf, DOI or link' }); continue; }
        } catch (error) { skipped.push({ key, why: error.message }); continue; }
        imported.add(source);
        if (out && out.added) count += 1; else already += 1;
      }
      return { added: count, alreadyInLibrary: already, skipped: skipped.slice(0, 30), skippedCount: skipped.length };
    },
    github_repos: async () => {
      if (!github || !github.status().connected) throw new Error('GitHub is not signed in. Say so in your reply.');
      const { repos = [] } = await github.repos();
      return repos.map((repo) => ({ fullName: repo.fullName, url: repo.url, description: repo.description || '', private: !!repo.private }));
    },
  };

  function zoteroRoot() {
    const root = zotero && zotero.root ? zotero.root() : null;
    if (!root) throw new Error('Zotero is not signed in. Say so in your reply.');
    return root;
  }

  return async function callTool(name, args) {
    validateImportTool(name, args || {});
    return call[name](args || {});
  };
}

module.exports = { IMPORT_TOOLS, CHAT_APPS, validateImportTool, createImported, createImportTools, chatNote };
