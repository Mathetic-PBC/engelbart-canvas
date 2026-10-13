'use strict';

// The Agent Viewer's Benchmark tab (2026-10-13; src/renderer/screens/Benchmark.jsx): every Chat question in the notes, the
// answer the note keeps (old) beside the same question answered again under Chat's prompt as it is now (new), and a note
// the person writes on each.
//
// The questions are read from every .md under each project's folder (<data root>/<project>/: its notes and its workspaces'
// workspace.md, not its trash, archives, assets or builds) with the editor's own reading of a document (threads() in
// src/renderer/model/doc.js): each turn whose answer ends with a `*Chat · …*` closing line, with the turns of its thread
// before it. Nothing here writes to a note, the library or a document: they are only read.
//
// A replay is asked through Chat's own path (../bart/ask.cjs, read-only tools, the system prompt loadSystemPrompt reads, so
// one saved in Design is used), on the model and effort the old closing line names. What it is sent is the document cut
// off at the question line, the earlier turns as <conversation>, the library as it is now and <stage>none</stage>; or, when
// the run log (../bart/runlog.cjs) recorded a run of the same question, the message that run was sent.
//
// The new answers and the notes are kept in <userData>/chat-benchmark.json, by note path and question text, each answer
// with the hash of the prompt it was made under.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const projects = require('../store/projects.cjs');
const { buildContext, block, markPlace, conversationBlock, NO_STAGE } = require('../bart/context.cjs');
const { expandMentions, projectSource } = require('../context/expand-mentions.cjs');
const { stripTitles } = require('../bart/strip.cjs');
const { createBart, loadSystemPrompt, cleanTurns } = require('../bart/ask.cjs');

// How many replays run at once.
const AT_ONCE = 3;
// A Chat answer's closing line (../bart/reply.cjs attribution): `*Chat · Opus · high · 41 s*`.
const CHAT_FOOT_RE = /^\*Chat(?: · [^*]*)?\*$/;
// The pending line the cut document ends with, read as "the question being asked now" (../bart/context.cjs HERE).
const MARK = 'benchmark';
// Folders of a project that hold no notes (../store/projects.cjs PROJECT_RESERVED).
const SKIP = new Set(['assets', 'builds']);

const DOC_JS = path.join(__dirname, '../../renderer/model/doc.js');
let docModel = null;
/** The editor's document model (an ES module). */
const loadDoc = () => { docModel = docModel || import(pathToFileURL(DOC_JS).href); return docModel; };

const hashOf = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
/** Where an entry is kept: the note's path under the data root, and the question as typed. */
const keyOf = (rel, question) => `${rel}\n${question}`;

/** Every .md under a project's folder, sorted, outside dot-folders (.trash, .archive, .context), assets and builds. */
function markdownFiles(dir, depth = 0, out = []) {
  if (depth > 32) return out;
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of names.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!(depth === 0 && SKIP.has(entry.name)) && !entry.name.endsWith('.pglite')) markdownFiles(full, depth + 1, out); }
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** The model and effort a closing line names (`*Chat · Opus · high · 41 s*` → { name: 'Opus', effort: 'high' }), or null. */
function footChoice(foot) {
  const parts = String(foot || '').replace(/^\*|\*$/g, '').split(' · ');
  if (parts.length < 3 || /^\d/.test(parts[1])) return null;
  return { name: parts[1].trim(), effort: parts[2].trim() };
}

/** An answer without the closing lines left at its end (an older run's, above the last one's). */
const withoutFeet = (answer) => { const lines = String(answer || '').split('\n'); while (lines.length && (!lines[lines.length - 1].trim() || /^\*[^*]+\*$/.test(lines[lines.length - 1].trim()))) lines.pop(); return lines.join('\n'); };

/**
 * The Chat questions of one document → [{ question, old, turns, foot, q, lines }]: each turn whose answer closes with a
 * `*Chat · …*` line, its answer without that line, and the turns of its thread before it ({ question, answer, agent }).
 */
function questionsIn(text, doc) {
  const lines = String(text || '').split('\n'), ps = doc.parseLines(lines), out = [];
  for (const thread of doc.threads(lines, ps)) {
    const earlier = [];
    for (const turn of thread.turns) {
      const { question, answer } = doc.turnText(lines, turn);
      if (turn.foot >= 0 && CHAT_FOOT_RE.test(ps[turn.foot].text)) {
        out.push({ question, old: withoutFeet(answer), turns: earlier.map((t) => ({ ...t })), foot: ps[turn.foot].text, q: turn.q, lines });
      }
      earlier.push({ question, answer, ...(turn.agent ? { agent: turn.agent } : {}) });
    }
  }
  return out;
}

/**
 * Every Chat question in the notes of every project, by note, in document order →
 * [{ rel, name, projectId, workspaceId, ref, entries: [{ key, question, old, turns, foot, q, lines }] }].
 */
async function collectQuestions(ctx) {
  const doc = await loadDoc();
  const rows = await ctx.libraryDb.list();
  const groups = [];
  const records = projects.projectRecords(ctx);
  for (const project of records) {
    const workspaces = projects.flattenWorkspaces(project.dir);
    let madeIn = new Map();
    for (const file of markdownFiles(project.dir)) {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      if (!/^bart\+?> \*Chat/m.test(text)) continue;
      const found = questionsIn(text, doc);
      if (!found.length) continue;
      const inProject = path.relative(project.dir, file), rel = path.relative(ctx.dataRoot, file);
      let workspaceId = null, ref = null, name;
      if (path.basename(file) === 'workspace.md') {
        const at = path.dirname(inProject);
        const workspace = workspaces.find((candidate) => candidate.path === at);
        workspaceId = workspace ? workspace.id : null;
        ref = workspaceId ? { kind: 'workspace', workspaceId } : null;
        name = at;
      } else {
        const row = rows.find((candidate) => candidate.path && path.resolve(candidate.path) === file);
        if (row && !madeIn.size) { try { madeIn = await projects.notesMadeIn(project.dir); } catch { madeIn = new Map(); } }
        const home = row && madeIn.get(row.id);
        const workspace = workspaces.find((candidate) => candidate.id === home) || workspaces.find((candidate) => (candidate.context || []).some((entry) => entry && entry.id === (row && row.id))) || workspaces[0];
        workspaceId = workspace ? workspace.id : null;
        ref = row ? { kind: 'note', id: row.id } : workspaceId ? { kind: 'workspace', workspaceId } : null;
        name = inProject.replace(/\.md$/, '');
      }
      const seen = new Map();
      const entries = found.map((entry) => {
        const base = keyOf(rel, entry.question), n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        return { ...entry, key: n > 1 ? `${base}\n${n}` : base };
      });
      groups.push({ rel, name: records.length > 1 ? `${project.name} / ${name}` : name, projectId: project.id, workspaceId, ref, title: path.basename(file) === 'workspace.md' ? path.basename(path.dirname(file)) : path.basename(file, '.md'), kind: path.basename(file) === 'workspace.md' ? 'workspace' : 'note', entries });
    }
  }
  return groups;
}

/** The message a run the log recorded for this question was first sent, everything before its <level>; null when none. */
function recordedMessage(runLog, question) {
  if (!runLog) return null;
  const found = runLog.find((record) => record.agent === 'bart' && String(record.question || '').trim() === question);
  const run = found ? runLog.get(found.id) : null;
  const input = run && run.steps && run.steps[0] ? String(run.steps[0].input || '') : '';
  const at = input.indexOf('\n\n<level>');
  return at > 0 && input.includes('<context_json>') ? input.slice(0, at) : null;
}

/**
 * What a replay is sent before its <level> and <question>: the head, the library and the files it mentions as Chat is
 * given them now, the document cut off at the question line (the question marked as the one asked now), <stage>none</stage>
 * and the highlights, then the earlier turns as <conversation>.
 */
async function messageFor(ctx, group, entry) {
  const context = await buildContext(ctx, group.projectId, { ref: group.ref, workspaceId: group.workspaceId, askId: MARK, agent: 'bart' });
  const cut = [...entry.lines.slice(0, entry.q + 1), `bart~> ${MARK}`].join('\n');
  const { lines } = await expandMentions(cut, projectSource(ctx, group.projectId, await ctx.libraryDb.list()), new Set());
  const body = markPlace(stripTitles(lines.join('\n').trimEnd()), MARK);
  const stage = context.documents.indexOf(NO_STAGE);
  const documents = [block(group.kind, group.title, body), stage >= 0 ? context.documents.slice(stage) : NO_STAGE].join('\n\n');
  return [context.head, context.contextJson, context.mentionedFiles, documents, conversationBlock(cleanTurns(entry.turns), { agent: 'bart' })].filter(Boolean).join('\n\n');
}

/**
 * Chat as ask.cjs runs it, for one replay: a Bart of its own (no run log, no sessions kept) whose first message has what
 * comes before its <level> replaced by `message`. → async (ctx, job, { signal }) → the answer's text, without its closing line.
 * `makeBart`: createBart, or createFakeBart in a copy whose Bart is fake (ENGELBART_BART_FAKE).
 */
function askChat({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-benchmark-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-benchmark'), codexAuthFile, tools = null, run = require('node:child_process').execFile, makeBart = createBart }) {
  const noThreads = { take: () => null, keep: () => {} };
  return async (ctx, job, { signal } = {}) => {
    const models = readModels();
    const choice = choiceOf(models, job.foot);
    const sent = (shell, args, options, done) => {
      const input = options && options.env && options.env.ENGELBART_BART_INPUT;
      try {
        const text = input ? fs.readFileSync(input, 'utf8') : '';
        const at = text.indexOf('\n\n<level>');
        if (at >= 0 && text.includes('<question>')) fs.writeFileSync(input, `${job.message}${text.slice(at)}`, { mode: 0o600 });
      } catch { /* sent as ask.cjs wrote it */ }
      return run(shell, args, options, done);
    };
    const bart = makeBart({ readModels, environment, runDirectory, codexHome, codexAuthFile, tools, run: sent, threads: noThreads, runLog: null });
    const askId = `benchmark-${randomUUID()}`;
    const stop = () => bart.stop(askId);
    if (signal) { if (signal.aborted) throw Object.assign(new Error('Stopped.'), { kind: 'stopped' }); signal.addEventListener('abort', stop, { once: true }); }
    try {
      const { lines } = await bart.ask(ctx, job.projectId, { askId, ref: job.ref, workspaceId: job.workspaceId, text: job.question, turns: job.turns, choice, agent: 'bart' });
      const body = lines.map((line) => line.replace(/^bart\+?> ?/, ''));
      while (body.length && (!body[body.length - 1].trim() || /^\*[^*]+\*$/.test(body[body.length - 1]))) body.pop();
      return body.join('\n').trim();
    } finally { if (signal) signal.removeEventListener('abort', stop); }
  };
}

/** The { model, effort } choice (../bart/question.cjs withChoice) the old closing line names, when the models know it. */
function choiceOf(models, foot) {
  const named = footChoice(foot);
  if (!named || !models || !models.providers) return null;
  for (const provider of Object.values(models.providers)) {
    for (const [key, model] of Object.entries(provider.models || {})) {
      if (model.name === named.name) return { model: key, ...((provider.efforts || []).includes(named.effort) ? { effort: named.effort } : {}) };
    }
  }
  return null;
}

/**
 * → { list, run, runOne, stop, setNote, subscribe }. `file`: chat-benchmark.json; `context()`: the open data root's ctx;
 * `chat(ctx, job, { signal })`: one replay's answer (askChat, or a fake in tests); `runLog`: the recorded runs.
 */
function createChatBenchmark({ file, context, chat, runLog = null, now = () => new Date().toISOString(), atOnce = AT_ONCE }) {
  let kept = null;
  let groups = null;
  const running = new Map(); // key → AbortController
  const listeners = new Set();
  let queue = [];
  let workers = 0;

  const load = () => {
    if (kept) return kept;
    try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); kept = value && typeof value.entries === 'object' && value.entries ? value : { entries: {} }; } catch { kept = { entries: {} }; }
    return kept;
  };
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(load(), null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch { /* kept in memory for this run */ }
  };
  const held = (key) => load().entries[key] || {};
  const put = (key, patch) => { const entries = load().entries; entries[key] = { ...(entries[key] || {}), ...patch }; save(); };

  const shownNew = (key) => {
    if (running.has(key)) return { running: true };
    const entry = held(key);
    if (typeof entry.answer === 'string') return { answer: entry.answer };
    if (typeof entry.error === 'string') return { error: entry.error };
    return {};
  };
  const tell = (change) => { for (const listener of listeners) { try { listener(change); } catch { /* the window's problem */ } } };
  const changed = (key) => tell({ key, new: shownNew(key), running: running.size > 0 });

  const find = (key) => {
    for (const group of groups || []) for (const entry of group.entries) if (entry.key === key) return { group, entry };
    return null;
  };

  async function replay(key) {
    const found = find(key);
    if (!found || running.has(key)) return;
    const controller = new AbortController();
    running.set(key, controller);
    changed(key);
    const { group, entry } = found;
    try {
      const ctx = await context();
      if (!group.workspaceId || !group.ref) throw new Error('This note belongs to no workspace to ask from.');
      const system = loadSystemPrompt(ctx.dataRoot, 'bart');
      const message = recordedMessage(runLog, entry.question) || await messageFor(ctx, group, entry);
      const answer = await chat(ctx, { projectId: group.projectId, workspaceId: group.workspaceId, ref: group.ref, question: entry.question, turns: entry.turns, foot: entry.foot, message }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      const { error, ...rest } = held(key);
      load().entries[key] = { ...rest, answer: String(answer || ''), promptHash: hashOf(system), at: now() };
      save();
    } catch (error) {
      if (controller.signal.aborted || (error && error.kind === 'stopped')) return;
      const { answer, ...rest } = held(key);
      let promptHash = null;
      try { promptHash = hashOf(loadSystemPrompt((await context()).dataRoot, 'bart')); } catch { promptHash = null; }
      load().entries[key] = { ...rest, error: String((error && error.message) || error || 'The run failed.'), promptHash, at: now() };
      save();
    } finally {
      running.delete(key);
      changed(key);
    }
  }

  const pump = () => {
    while (workers < atOnce && queue.length) {
      const key = queue.shift();
      workers += 1;
      replay(key).finally(() => { workers -= 1; pump(); });
    }
  };

  return {
    /** Every entry by note, with its old answer, its new one ({ answer } | { error } | { running } | {}) and its note. */
    async list() {
      groups = await collectQuestions(await context());
      return {
        running: running.size > 0,
        groups: groups.map((group) => ({
          name: group.name,
          rel: group.rel,
          entries: group.entries.map((entry) => ({ key: entry.key, question: entry.question, old: entry.old, new: shownNew(entry.key), note: held(entry.key).note || '' })),
        })),
      };
    },
    /** Replays every question with no new answer yet, `atOnce` at a time. → whether anything runs */
    async run() {
      if (!groups) await this.list();
      const waiting = new Set(queue);
      for (const group of groups) for (const entry of group.entries) {
        if (typeof held(entry.key).answer !== 'string' && !running.has(entry.key) && !waiting.has(entry.key)) queue.push(entry.key);
      }
      pump();
      return running.size > 0;
    },
    /** Replays one question again, whatever it has. */
    async runOne(key) {
      if (!groups) await this.list();
      if (typeof key !== 'string' || !find(key)) return false;
      queue = queue.filter((waiting) => waiting !== key);
      void replay(key);
      return true;
    },
    /** Stops every replay running and every one waiting. */
    stop() {
      queue = [];
      for (const controller of running.values()) controller.abort();
      return true;
    },
    /** The note written under an entry. */
    setNote(key, text) {
      if (typeof key !== 'string' || !key) return false;
      put(key, { note: String(text == null ? '' : text).slice(0, 100000) });
      return true;
    },
    /** Each change: { key, new, running }. → unsubscribe */
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** Resolves when nothing runs or waits (tests). */
    async idle() { while (running.size || queue.length) await new Promise((resolve) => setTimeout(resolve, 10)); },
  };
}

module.exports = { createChatBenchmark, collectQuestions, questionsIn, messageFor, recordedMessage, askChat, choiceOf, footChoice, markdownFiles, keyOf, AT_ONCE };
