'use strict';

// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html", the "Onboarding brainstorm" note). An
// experimental onboarding screen, test mode only: the person picks what should go into their library, then a librarian
// agent talks with them in one continuous chat (single and multiple choice and short open questions, built from what was
// found on this Mac, ./scan.cjs) and hands each source to an import agent as soon as it is settled. Imports run in the
// background, two at a time, while the chat goes on and after onboarding moves on; Import hands every source not yet
// handed over at once, and the progress list follows them. Buttons in the chat sign in (Zotero, GitHub) or choose a
// folder or an export for an agent.
//
// What it writes is only in the data root it started in (test mode: ~/.engelbart/test): <dataRoot>/.connect/<id>/
// (session.json, what was said and how each import went; notes/ the notes staged until the project exists) and what the
// import tools add (./tools.cjs). Onboarding passes the session to start-project, which writes the staged notes into the
// new project (attachProject); later notes go there directly.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SOURCES, APPS, sourceOf } = require('../../shared/connect-sources.cjs');
const { INTERVIEW_SYSTEM_PROMPT, IMPORT_SYSTEM_PROMPT } = require('./prompts.cjs');
const { scanFor } = require('./scan.cjs');
const readers = require('./readers.cjs');
const notes = require('./notes.cjs');
const { createImportTools } = require('./tools.cjs');
const { clipMiddle } = require('../bart/clip.cjs');

const MAX_RUNNING = 2;
const MAX_JOBS = 24;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_KINDS = new Set(['single', 'multi', 'open']);
const CONNECT_KINDS = new Set(['signin', 'folder', 'file']);
const SIGNIN_APPS = new Set(['Zotero', 'GitHub']);

const clip = (text, max) => { const value = String(text == null ? '' : text).trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const line = (text, max) => clip(String(text == null ? '' : text).replace(/\s+/g, ' '), max);

/** The prompt in force: <dataRoot>/.context/<file> when it holds any, else the built-in one. */
function promptOf(dataRoot, file, builtIn) {
  try { const custom = fs.readFileSync(path.join(dataRoot, '.context', file), 'utf8').trim(); if (custom) return custom; } catch { /* built-in */ }
  return builtIn;
}

/** The choose screen's answer made safe → { sources: { id: { on, apps, folders, repos } }, custom, computer }. */
function cleanChoices(input, homeDir) {
  const given = input && typeof input === 'object' ? input : {};
  const sources = {};
  for (const source of SOURCES) {
    const value = given.sources && typeof given.sources === 'object' ? given.sources[source.id] : null;
    if (!value || typeof value !== 'object') { sources[source.id] = { on: false, apps: [], folders: [], repos: [] }; continue; }
    const apps = (Array.isArray(value.apps) ? value.apps : []).filter((app) => source.apps.includes(app));
    const folders = (Array.isArray(value.folders) ? value.folders : []).map((dir) => readers.expandPath(homeDir, dir)).filter((dir) => dir && dir.startsWith(homeDir + path.sep)).slice(0, 12);
    const repos = (Array.isArray(value.repos) ? value.repos : []).filter((repo) => typeof repo === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo)).slice(0, 100);
    sources[source.id] = { on: !!value.on, apps, folders, repos };
  }
  return { sources, custom: typeof given.custom === 'string' ? given.custom.trim().slice(0, 4000) : '', computer: given.computer !== false };
}

/**
 * The librarian's reply made safe → { say, ask, connect, dispatch, done }. A reply that is not the JSON it was asked for
 * is shown as it came, as words with no question: the person can still answer by typing.
 */
function readReply(text, choices) {
  const raw = String(text || '').trim();
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(body.slice(start, end + 1)); } catch { value = null; } }
  if (!value || typeof value !== 'object') return { say: clip(raw, 2000) || '…', ask: null, connect: null, dispatch: [], done: false, unread: true };
  const on = (id) => !!(choices.sources[id] && choices.sources[id].on);
  let ask = null;
  if (value.ask && typeof value.ask === 'object' && ASK_KINDS.has(value.ask.kind) && typeof value.ask.title === 'string' && value.ask.title.trim()) {
    const options = (Array.isArray(value.ask.options) ? value.ask.options : []).map((option) => line(option && typeof option === 'object' ? option.label : option, 160)).filter(Boolean).slice(0, 8);
    if (value.ask.kind === 'open' || options.length) ask = { source: sourceOf(value.ask.source) ? value.ask.source : null, kind: value.ask.kind, title: line(value.ask.title, 300), options: value.ask.kind === 'open' ? [] : options, placeholder: value.ask.kind === 'open' ? line(value.ask.placeholder, 120) : '' };
  }
  let connect = null;
  const c = value.connect;
  if (!ask && c && typeof c === 'object' && CONNECT_KINDS.has(c.kind) && APPS[c.app] && (c.kind !== 'signin' || SIGNIN_APPS.has(c.app))) {
    connect = { source: sourceOf(c.source) ? c.source : null, app: c.app, kind: c.kind, label: line(c.label, 60) || (c.kind === 'signin' ? `Sign in to ${c.app}` : c.kind === 'file' ? `Choose your ${c.app} export…` : `Choose a ${c.app} folder…`), how: APPS[c.app].how };
  }
  const dispatch = (Array.isArray(value.dispatch) ? value.dispatch : []).filter((entry) => entry && typeof entry === 'object' && sourceOf(entry.source) && on(entry.source) && typeof entry.plan === 'string' && entry.plan.trim())
    .slice(0, 6).map((entry) => ({ source: entry.source, apps: (Array.isArray(entry.apps) ? entry.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub')).slice(0, 8), label: line(entry.label, 80) || sourceOf(entry.source).label, plan: clip(entry.plan, 8000) }));
  return { say: clip(typeof value.say === 'string' ? value.say : '', 2000), ask, connect, dispatch, done: value.done === true };
}

/** What the person did, as the librarian is told it. */
function messageOf(input) {
  if (input.skipped) return 'skipped';
  if (input.importNow) return 'Import now.';
  if (Array.isArray(input.picked) && input.picked.length) return `picked ${input.picked.map((label) => `"${line(label, 160)}"`).join(', ')}`;
  if (input.connected) return `connected "${input.connected}"`;
  if (input.chose) return `chose ${input.chose.kind} "${input.chose.shown}" for "${input.chose.app}"`;
  return line(input.text, 4000);
}

/** What the chat shows for it. */
function shownOf(input) {
  if (input.skipped) return 'Skip';
  if (input.importNow) return 'Import now';
  if (Array.isArray(input.picked) && input.picked.length) return input.picked.map((label) => line(label, 160)).join(', ');
  if (input.connected) return `Signed in to ${input.connected}`;
  if (input.chose) return `${input.chose.shown}`;
  return clip(input.text, 4000);
}

/**
 * `agents` (./agents.cjs or the fake's), `models()` → the resolved choice for a pick ({ provider, model, effort } →
 * { provider, model, modelId, modelName, effort }), `context()` the store's context, `zotero` { status(), root(), download? },
 * `github` { status(), repos() }, `deps` for the library (describe, identifyRepo, inspectPdf, onAdded, onPdf), `notify(snapshot)`
 * on every change, `openBridge` (../sandbox/local-tools.cjs openToolBridge).
 */
function createConnect({ agents, resolveChoice, context, homeDir, env = process.env, zotero = {}, github = {}, deps = {}, notify = () => {}, openBridge, now = () => new Date().toISOString() }) {
  const sessions = new Map();

  const publicJob = (job) => ({ id: job.id, source: job.source, label: job.label, apps: job.apps, status: job.status, notes: job.notes, items: job.items, activity: job.activity, summary: job.summary, error: job.error });
  function snapshot(s) {
    return {
      id: s.id, chat: s.chat, thinking: s.thinking, activity: s.activity, done: s.done, error: s.error, finished: s.finished,
      jobs: s.jobs.map(publicJob), choice: { provider: s.choice.provider, model: s.choice.model, modelName: s.choice.modelName, effort: s.choice.effort },
      projectId: s.projectId, staged: s.projectId ? 0 : notes.stagedNotes(s.dir).length,
    };
  }
  function save(s) {
    try { fs.mkdirSync(s.dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({ ...snapshot(s), created: s.created, choices: s.choices, picked: s.picked, jobs: s.jobs.map((job) => ({ ...publicJob(job), plan: job.plan, started: job.started, ended: job.ended })) }, null, 2), { mode: 0o600 }); } catch { /* the chat goes on */ }
  }
  let emitTimer = null;
  const pending = new Set();
  function emit(s, { soon = false } = {}) {
    if (!soon) { save(s); notify(snapshot(s)); return; }
    pending.add(s);
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; for (const held of pending) notify(snapshot(held)); pending.clear(); }, 250);
    if (emitTimer.unref) emitTimer.unref();
  }

  function get(id) {
    const s = typeof id === 'string' && ID_RE.test(id) ? sessions.get(id) : null;
    if (!s) throw new Error('That import is no longer open');
    return s;
  }

  /** The folders the agents' file tools may read: what the sources need, or the whole home folder when allowed. */
  function dirsOf(s) {
    const dirs = new Set();
    const add = (dir) => { if (dir && fs.existsSync(dir)) dirs.add(path.resolve(dir)); };
    if (s.choices.computer) add(homeDir);
    for (const [id, choice] of Object.entries(s.choices.sources)) {
      if (!choice.on) continue;
      for (const dir of choice.folders) add(dir);
      for (const app of choice.apps) {
        if (app === 'Obsidian') for (const vault of readers.obsidianVaults(homeDir)) add(vault.path);
        if (app === 'Claude Code') add(path.join(homeDir, '.claude', 'projects'));
        if (app === 'Codex') add(path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions'));
        if (app === 'Zoom') add(path.join(homeDir, 'Documents', 'Zoom'));
        if (app === 'Zotero') { add(path.join(homeDir, 'Zotero', 'storage')); add(zotero.root ? zotero.root() : null); }
      }
      if (id === 'sites') for (const vault of readers.obsidianVaults(homeDir).slice(0, 2)) add(vault.path);
    }
    for (const file of [...Object.values(s.picked.folders), ...Object.values(s.picked.exports)]) add(fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file));
    // The narrowest set: a folder inside another granted one adds nothing.
    const list = [...dirs].sort((a, b) => a.length - b.length);
    return list.filter((dir, i) => !list.slice(0, i).some((outer) => dir.startsWith(outer + path.sep)));
  }

  async function libraryCounts(ctx) {
    try {
      const rows = await ctx.libraryDb.list();
      const has = (tag) => rows.filter((row) => Array.isArray(row.tags) && row.tags.includes(tag)).length;
      return { items: rows.length, notes: has('note'), papers: has('paper'), repositories: has('git'), websites: rows.filter((row) => row.type === 'website' && !(row.tags || []).length).length };
    } catch { return null; }
  }

  function instructionsText(dataRoot) {
    try { return fs.readFileSync(path.join(dataRoot, 'instructions.md'), 'utf8').trim(); } catch { return ''; }
  }

  function conversationText(s) {
    return s.chat.map((entry) => `${entry.role === 'agent' ? 'librarian' : 'person'}: ${entry.text}${entry.ask ? `\n  (asked, ${entry.ask.kind}: ${entry.ask.title}${entry.ask.options.length ? ` — ${entry.ask.options.join(' | ')}` : ''})` : ''}${entry.connect ? `\n  (offered the button: ${entry.connect.label})` : ''}`).join('\n');
  }

  function importsText(s) {
    if (!s.jobs.length) return '';
    return JSON.stringify(s.jobs.map((job) => ({ label: job.label, source: job.source, status: job.status, notesAdded: job.notes, itemsAdded: job.items, ...(job.summary ? { said: job.summary } : {}), ...(job.error ? { error: job.error } : {}) })));
  }

  function engelbartBlock(s) {
    return `<engelbart>\nA new person is setting up Engelbart (onboarding, test mode). Their library is at ${s.dataRoot}. Notes brought in now go into the project they make at the end of onboarding.\nAgents may read files anywhere in their home folder: ${s.choices.computer ? 'yes' : 'no, only the folders of the sources they picked'}.\n</engelbart>`;
  }

  async function firstMessage(s, message, { again = false } = {}) {
    const ctx = await context();
    const custom = instructionsText(s.dataRoot);
    const parts = [
      engelbartBlock(s),
      `<choices>\n${JSON.stringify({ ...s.choices.sources, customInstructionsForThisImport: s.choices.custom || null }, null, 1)}\n</choices>`,
      `<found>\n${JSON.stringify(s.found, null, 1)}\n</found>`,
      `<library>${JSON.stringify(await libraryCounts(ctx))}</library>`,
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      again && s.chat.length ? `<conversation note="What was said so far; your earlier replies are summarised as what you asked.">\n${conversationText(s)}\n</conversation>` : '',
      again && s.jobs.length ? `<imports>${importsText(s)}</imports>` : '',
      `<message>${message}</message>`,
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  function laterMessage(s, message) {
    const parts = [];
    const imports = importsText(s);
    if (imports && imports !== s.toldImports) { parts.push(`<imports>${imports}</imports>`); s.toldImports = imports; }
    if (s.newFound) { parts.push(`<found note="Read again after the person's last step.">\n${JSON.stringify(s.newFound, null, 1)}\n</found>`); s.newFound = null; }
    parts.push(`<message>${message}</message>`);
    return parts.join('\n\n');
  }

  /** One librarian turn: what the person did → its reply applied (a message in the chat, imports started). */
  async function interviewTurn(s, message) {
    s.thinking = true;
    s.activity = '';
    s.error = '';
    emit(s);
    const controller = new AbortController();
    s.interviewController = controller;
    const onUpdate = ({ activity }) => { if (activity && activity !== s.activity) { s.activity = activity; emit(s, { soon: true }); } };
    const system = promptOf(s.dataRoot, 'connect-system-prompt.md', INTERVIEW_SYSTEM_PROMPT);
    const meta = { kind: 'interview', session: s, message };
    try {
      let out;
      if (s.interviewSession) {
        try {
          out = await agents.turn({ choice: s.choice, system, message: laterMessage(s, message), session: s.interviewSession, dirs: s.dirs, signal: controller.signal, onUpdate, meta });
        } catch (error) {
          if (error && error.kind === 'stopped') throw error;
          // A session that will not resume starts again from everything, the conversation included.
          out = await agents.turn({ choice: s.choice, system, message: await firstMessage(s, message, { again: true }), session: null, dirs: s.dirs, signal: controller.signal, onUpdate, meta });
        }
      } else {
        out = await agents.turn({ choice: s.choice, system, message: await firstMessage(s, message, { again: s.chat.length > 1 }), session: null, dirs: s.dirs, signal: controller.signal, onUpdate, meta });
      }
      s.interviewSession = out.session || null;
      s.toldImports = importsText(s);
      apply(s, readReply(out.text, s.choices));
    } catch (error) {
      if (!(error && error.kind === 'stopped')) s.error = error && error.message ? error.message : 'The librarian did not answer.';
    } finally {
      if (s.interviewController === controller) s.interviewController = null;
      s.thinking = false;
      s.activity = '';
      emit(s);
    }
  }

  function apply(s, reply) {
    s.chat.push({ role: 'agent', text: reply.say || (reply.ask ? '' : reply.dispatch.length ? 'Starting that now.' : '…'), ask: reply.ask, connect: reply.connect, at: now() });
    for (const entry of reply.dispatch) dispatch(s, entry);
    if (reply.done) s.done = true;
  }

  /** A source handed to an import agent: queued, started when a place is free. The same source and apps go once. */
  function dispatch(s, { source, apps, label, plan }) {
    const key = `${source}:${[...apps].sort().join(',')}`;
    if (s.jobs.some((job) => job.key === key) || s.jobs.length >= MAX_JOBS) return null;
    if (apps.length && s.jobs.some((job) => job.source === source && !job.apps.length)) return null; // the whole source went already
    const job = { id: randomUUID(), key, source, apps, label, plan, status: 'queued', notes: 0, items: 0, activity: '', summary: '', error: '', started: null, ended: null };
    s.jobs.push(job);
    pump(s);
    return job;
  }

  function pump(s) {
    if (s.stopped) return;
    while (s.jobs.filter((job) => job.status === 'running').length < MAX_RUNNING) {
      const next = s.jobs.find((job) => job.status === 'queued');
      if (!next) break;
      void runJob(s, next);
    }
  }

  function importMessage(s, job) {
    const custom = instructionsText(s.dataRoot);
    return [
      engelbartBlock(s),
      `<source>${JSON.stringify({ source: job.source, apps: job.apps.length ? job.apps : (s.choices.sources[job.source] || {}).apps || [], label: job.label, foldersPicked: (s.choices.sources[job.source] || {}).folders || [], repositoriesPicked: (s.choices.sources[job.source] || {}).repos || [], exportsChosen: s.picked.exports, foldersChosen: s.picked.folders })}</source>`,
      `<plan>\n${job.plan}\n</plan>`,
      `<chat>\n${clipMiddle(conversationText(s), 30000)}\n</chat>`,
      `<found>\n${JSON.stringify((s.found || {})[job.source] || {}, null, 1)}\n</found>`,
      s.choices.custom ? `<import_instructions note="What the person typed on the choose screen for this import.">\n${s.choices.custom}\n</import_instructions>` : '',
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      'Do the import now.',
    ].filter(Boolean).join('\n\n');
  }

  async function runJob(s, job) {
    job.status = 'running';
    job.started = now();
    emit(s);
    const controller = new AbortController();
    s.controllers.add(controller);
    const session = {
      dataRoot: s.dataRoot, homeDir, dir: s.dir, projectId: () => s.projectId,
      get exports() { return s.picked.exports; },
      get folders() { return s.picked.folders; },
    };
    const callTool = createImportTools({ session, context, zotero, github, deps, env, added: (kind, n) => { job[kind === 'notes' ? 'notes' : 'items'] += n; emit(s, { soon: true }); } });
    let bridge = null;
    try {
      bridge = await openBridge(callTool, { signal: controller.signal });
      const out = await agents.turn({ choice: s.choice, system: promptOf(s.dataRoot, 'connect-import-system-prompt.md', IMPORT_SYSTEM_PROMPT), message: importMessage(s, job), session: null, dirs: s.dirs, signal: controller.signal, bridge: bridge.connection, onUpdate: ({ activity }) => { if (activity && activity !== job.activity) { job.activity = activity; emit(s, { soon: true }); } }, meta: { kind: 'import', session: s, job, callTool } });
      job.summary = line(out.text, 500);
      job.status = 'done';
    } catch (error) {
      job.status = error && error.kind === 'stopped' ? 'stopped' : 'failed';
      job.error = job.status === 'failed' ? line(error && error.message ? error.message : 'The import failed', 300) : '';
    } finally {
      s.controllers.delete(controller);
      if (bridge) await bridge.close().catch(() => {});
      job.activity = '';
      job.ended = now();
      emit(s);
      pump(s);
    }
  }

  async function rescan(s, sourceIds) {
    const only = { sources: Object.fromEntries(Object.entries(s.choices.sources).filter(([id]) => sourceIds.includes(id))) };
    const fresh = await scanFor(only, { homeDir, env, picked: s.picked, zotero, github });
    s.found = { ...s.found, ...fresh };
    s.newFound = { ...(s.newFound || {}), ...fresh };
    s.dirs = dirsOf(s);
  }

  /** The choose screen sent: the session, the scan, and the librarian's first turn (in the background). → snapshot */
  async function start(input) {
    const ctx = await context();
    const choices = cleanChoices(input, homeDir);
    if (!Object.values(choices.sources).some((choice) => choice.on)) throw new Error('Pick at least one source.');
    const choice = resolveChoice(input && input.pick);
    const id = randomUUID();
    const s = {
      id, dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', id), created: now(), choices, choice,
      picked: { folders: {}, exports: {} }, chat: [], thinking: true, activity: 'Looking at what you picked…', done: false, finished: false, error: '',
      jobs: [], controllers: new Set(), interviewSession: null, interviewController: null, found: {}, newFound: null, toldImports: '', projectId: null, stopped: false,
    };
    sessions.set(id, s);
    emit(s);
    void (async () => {
      try { s.found = await scanFor(choices, { homeDir, env, picked: s.picked, zotero, github }); } catch (error) { s.found = { error: error.message }; }
      s.dirs = dirsOf(s);
      await interviewTurn(s, 'Start.');
    })();
    return snapshot(s);
  }

  function busy(s) { if (s.thinking) throw new Error('Wait for the librarian to answer'); }

  /** The person answered: { text } | { picked: [labels] } | { skipped: true }. The librarian's turn runs in the background. */
  function answer(id, input = {}) {
    const s = get(id);
    busy(s);
    const value = input && typeof input === 'object' ? input : {};
    const picked = Array.isArray(value.picked) ? value.picked.filter((label) => typeof label === 'string' && label.trim()).slice(0, 12) : null;
    const clean = value.skipped ? { skipped: true } : picked && picked.length ? { picked } : { text: typeof value.text === 'string' ? value.text.trim().slice(0, 4000) : '' };
    if (!clean.skipped && !clean.picked && !clean.text) throw new Error('Say something first');
    // The model chip under the chat changed: the next turns run there; another provider starts a session of its own.
    if (value.pick && typeof value.pick === 'object') {
      const next = resolveChoice(value.pick);
      if (next.provider !== s.choice.provider) s.interviewSession = null;
      s.choice = next;
    }
    s.chat.push({ role: 'user', text: shownOf(clean), at: now() });
    void interviewTurn(s, messageOf(clean));
    return snapshot(s);
  }

  /** A button in the chat was used: { app, kind: 'folder' | 'file', path } chosen, or { app, kind: 'signin' } done. */
  async function connected(id, input = {}) {
    const s = get(id);
    busy(s);
    const app = typeof input.app === 'string' && (APPS[input.app] || input.app === 'GitHub') ? input.app : null;
    if (!app) throw new Error('Unknown app');
    let clean;
    if (input.kind === 'signin') clean = { connected: app };
    else {
      const file = readers.expandPath(homeDir, input.path);
      if (!file || !file.startsWith(homeDir + path.sep) || !fs.existsSync(file)) throw new Error('Choose something inside your home folder');
      if (input.kind === 'file' || (APPS[app] && APPS[app].pick === 'file')) s.picked.exports[app] = file; else s.picked.folders[app] = file;
      clean = { chose: { app, kind: fs.statSync(file).isDirectory() ? 'folder' : 'file', shown: readers.shownPath(homeDir, file) } };
    }
    s.chat.push({ role: 'user', text: shownOf(clean), at: now() });
    s.thinking = true;
    emit(s);
    const sources = SOURCES.filter((source) => source.apps.includes(app) || (app === 'GitHub' && source.id === 'code')).map((source) => source.id);
    // Zotero's library is read from the copy its first sync makes: waited for (a minute and a half at most), so the
    // librarian can list the collections.
    if (app === 'Zotero' && clean.connected) {
      s.activity = 'Waiting for your Zotero library to sync';
      emit(s);
      for (let n = 0; n < 90 && !s.stopped; n += 1) {
        const root = zotero.root ? zotero.root() : null;
        if (root && fs.existsSync(path.join(root, 'items.json'))) break;
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
      }
      s.activity = '';
    }
    try { await rescan(s, sources); } catch { /* the librarian is told what it can be */ }
    s.thinking = false;
    void interviewTurn(s, messageOf(clean));
    return snapshot(s);
  }

  /**
   * Import: every source picked and not yet handed over goes now, with what the chat said, so the person need not wait
   * for the librarian; it is told, and asks nothing more. → snapshot
   */
  function importNow(id) {
    const s = get(id);
    s.finished = true;
    if (s.interviewController) s.interviewController.abort();
    for (const [source, choice] of Object.entries(s.choices.sources)) {
      const sent = s.jobs.filter((job) => job.source === source);
      if (!choice.on || sent.some((job) => !job.apps.length)) continue;
      const covered = new Set(sent.flatMap((job) => job.apps));
      if (sent.length && !choice.apps.some((app) => !covered.has(app))) continue;
      const label = sourceOf(source).label;
      const apps = choice.apps.filter((app) => { const found = ((s.found || {})[source] || {})[app]; return !covered.has(app) && !(found && found.needs); });
      if (sent.length && !apps.length) continue;
      if (choice.apps.length && !apps.length && !choice.folders.length && !choice.repos.length) continue; // nothing of it can be read yet
      const where = [apps.length ? `from ${apps.join(', ')}` : '', choice.folders.length ? `folders ${choice.folders.join(', ')}` : '', choice.repos.length ? `repositories ${choice.repos.join(', ')}` : ''].filter(Boolean).join('; ');
      dispatch(s, { source, apps, label: apps.length ? `${label}: ${apps.join(', ')}` : label, plan: `Bring in ${label.toLowerCase()} ${where} as the person picked and said in the chat. They pressed Import before this source was talked through, so use sensible defaults: leave out daily notes, personal folders and journals; tools used every day (mail, calendar, social media); runs a program started; anything older than about six months when there is a lot.` });
    }
    s.chat.push({ role: 'user', text: 'Import now', at: now() });
    s.done = true;
    emit(s);
    return snapshot(s);
  }

  function stop(id) {
    const s = get(id);
    s.stopped = true;
    if (s.interviewController) s.interviewController.abort();
    for (const controller of s.controllers) controller.abort();
    for (const job of s.jobs) if (job.status === 'queued') job.status = 'stopped';
    emit(s);
    return snapshot(s);
  }

  /** Onboarding made the project: the staged notes go into it, and later ones straight there. → how many went in */
  async function attachProject(ctx, id, projectId) {
    const s = sessions.get(id);
    if (!s || s.dataRoot !== ctx.dataRoot) return 0;
    s.projectId = projectId;
    const written = await notes.flushStaged(ctx, s.dir, projectId, { projects: require('../store/projects.cjs') });
    emit(s);
    return written.length;
  }

  function stopAll() { for (const s of sessions.values()) { try { stop(s.id); } catch { /* gone */ } } }

  return { start, answer, connected, importNow, stop, stopAll, attachProject, state: (id) => snapshot(get(id)), has: (id) => sessions.has(id) };
}

module.exports = { createConnect, cleanChoices, readReply, messageOf, shownOf, MAX_RUNNING };
