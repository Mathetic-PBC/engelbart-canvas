'use strict';

// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html", the "Onboarding brainstorm" note). An
// experimental screen, test mode only: the person picks what should go into their library, then a librarian agent talks
// with them in one continuous chat (single and multiple choice and short open questions, built from what was found) and
// hands each source to an import agent as soon as it is settled. Imports run in the background while the chat goes on and
// after the window is put away.
//
// Second build (same day, "Agent onboarding"), what this file does now:
//   · the agents do the work: survey agents look at each web or connector app first (its files, chats, projects) so the
//     librarian can offer the person their own things; import agents use Engelbart's hidden browser (./browser.cjs), the
//     apps' connectors (./connectors.cjs) and macOS Automation; nobody is told to export or download anything
//   · a priority queue (the workspace's TODO): surveys first (they unblock questions), then the recalls, then imports, then
//     MEMORY.md; three at a time; MEMORY.md waits until everything else has ended
//   · "Needs you": an agent that meets a sign-in, a code or a permission hands it to the person (needs_you) and waits; the
//     window shows it with a button that opens the agent's window, runs the connector's sign-in or asks macOS. One request
//     per app and kind, whichever agents wait on it
//   · the action log: every step of every agent, in the person's words; Stop for one import or all
//   · the models are pinned (CONNECT_MODELS: Sonnet high on Claude Code, Sol high on Codex) and only the provider is chosen;
//     no agent moves up to another model
//   · MEMORY.md: recall agents ask the AI assistants what they remember (with the person's leave), and once everything has
//     ended a memory agent writes it from all of it, a Claude Sonnet agent takes secrets out, and it is saved (./memory.cjs)
//   · a session can belong to an existing project (the one-time popup): notes go straight into it
//
// What it writes is only in the data root it started in (test mode: ~/.engelbart/test): <dataRoot>/.connect/<id>/
// (session.json, what was said and how each import went; notes/ the notes staged until the project exists; memories/ what
// each assistant answered), <dataRoot>/imports/<id>/ (what the agents downloaded), MEMORY.md, and what the import tools add.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SOURCES, APPS, sourceOf, appOf, sourceOfApp, recallApps } = require('../../shared/connect-sources.cjs');
const prompts = require('./prompts.cjs');
const { scanFor } = require('./scan.cjs');
const readers = require('./readers.cjs');
const notes = require('./notes.cjs');
const { createImportTools } = require('./tools.cjs');
const { skillsFor } = require('./skills.cjs');
const memory = require('./memory.cjs');
const { clipMiddle } = require('../bart/clip.cjs');

const MAX_RUNNING = 3;
const MAX_JOBS = 40;
const MAX_LOG = 400;
const SHOWN_LOG = 150;
const NEED_WAIT_MS = 170_000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_KINDS = new Set(['single', 'multi', 'open']);
const AUTHORIZE_KINDS = new Set(['signin', 'connector', 'permission', 'folder']);
const SIGNIN_APPS = new Set(['Zotero', 'GitHub']);
const PRIORITY = Object.freeze({ survey: 0, recall: 1, import: 2, memory: 3, redact: 4 });
const WORK = new Set(['survey', 'recall', 'import']);
const ENDED = new Set(['done', 'failed', 'stopped']);
// "change the default model for the context brainstorming and for the background subagents to sonnet high/sol high, and
// do not even allow mke to change model or effort, only provider": not in model-effort-inline-question.json, so not editable.
const CONNECT_MODELS = Object.freeze({ anthropic: Object.freeze({ model: 'sonnet', effort: 'high' }), openai: Object.freeze({ model: 'sol', effort: 'high' }) });
const PROVIDERS = Object.freeze(['anthropic', 'openai']);
const PROVIDER_NAMES = Object.freeze({ anthropic: 'Claude Code', openai: 'Codex' });
const FALLBACK_IDS = Object.freeze({ sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet' }, sol: { id: 'gpt-6.1-sol', name: 'Sol' } });

const clip = (text, max) => { const value = String(text == null ? '' : text).trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const line = (text, max) => clip(String(text == null ? '' : text).replace(/\s+/g, ' '), max);

/** The prompt in force: <dataRoot>/.context/<file> when it holds any, else the built-in one. */
function promptOf(dataRoot, file, builtIn) {
  try { const custom = fs.readFileSync(path.join(dataRoot, '.context', file), 'utf8').trim(); if (custom) return custom; } catch { /* built-in */ }
  return builtIn;
}

/**
 * The pinned model of a provider, from Build's list (an id updated there carries here) → { provider, model, modelId,
 * modelName, effort }. `models()` → that list ({ providers: { anthropic: { models } } }), or nothing.
 */
function connectChoice(provider, models) {
  const at = PROVIDERS.includes(provider) ? provider : 'anthropic';
  const pin = CONNECT_MODELS[at];
  const listed = models && models.providers && models.providers[at] && models.providers[at].models ? models.providers[at].models[pin.model] : null;
  const model = listed && listed.id ? listed : FALLBACK_IDS[pin.model];
  return { provider: at, model: pin.model, modelId: model.id, modelName: model.name || FALLBACK_IDS[pin.model].name, effort: pin.effort };
}

/** The choose screen's answer made safe → { sources: { id: { on, apps, folders, repos } }, custom, computer, permissions }. */
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
  const allowed = given.permissions && typeof given.permissions === 'object' ? given.permissions : {};
  const computer = given.computer !== false && allowed.files !== false;
  return {
    sources,
    custom: typeof given.custom === 'string' ? given.custom.trim().slice(0, 4000) : '',
    computer,
    permissions: { files: computer, browser: allowed.browser !== false, recall: allowed.recall !== false, notes: allowed.notes === true },
  };
}

/** One option of a question: a label and, when given, a few words of why → { label, why } or null. */
function optionOf(option) {
  if (option && typeof option === 'object') { const label = line(option.label, 160); return label ? { label, why: line(option.why, 140) } : null; }
  const label = line(option, 160);
  return label ? { label, why: '' } : null;
}

/**
 * The librarian's reply made safe → { say, ask, authorize, dispatch, waiting, done }. A reply that is not the JSON it was
 * asked for is shown as it came, as words with no question: the person can still answer by typing.
 */
function readReply(text, choices) {
  const raw = String(text || '').trim();
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(body.slice(start, end + 1)); } catch { value = null; } }
  if (!value || typeof value !== 'object') return { say: clip(raw, 2000) || '…', ask: null, authorize: null, dispatch: [], waiting: false, done: false, unread: true };
  const on = (id) => !!(choices.sources[id] && choices.sources[id].on);
  let ask = null;
  if (value.ask && typeof value.ask === 'object' && ASK_KINDS.has(value.ask.kind) && typeof value.ask.title === 'string' && value.ask.title.trim()) {
    const options = (Array.isArray(value.ask.options) ? value.ask.options : []).map(optionOf).filter(Boolean).filter((option, i, all) => all.findIndex((other) => other.label === option.label) === i).slice(0, 10);
    if (value.ask.kind === 'open' || options.length) ask = { source: sourceOf(value.ask.source) ? value.ask.source : null, kind: value.ask.kind, title: line(value.ask.title, 300), options: value.ask.kind === 'open' ? [] : options, placeholder: value.ask.kind === 'open' ? line(value.ask.placeholder, 120) : '' };
  }
  let authorize = null;
  const a = value.authorize || value.connect; // "connect" was the first build's name for it
  if (!ask && a && typeof a === 'object' && AUTHORIZE_KINDS.has(a.kind) && (APPS[a.app] || a.app === 'GitHub')) {
    const reach = appOf(a.app) ? appOf(a.app).reach : 'signin';
    const fits = a.kind === 'signin' ? SIGNIN_APPS.has(a.app) : a.kind === 'connector' ? reach === 'connector' : a.kind === 'permission' ? reach === 'automation' : reach === 'local';
    if (fits) {
      const label = line(a.label, 60) || (a.kind === 'permission' ? `Allow Engelbart to read ${a.app}` : a.kind === 'folder' ? `Choose your ${a.app} folder…` : `Sign in to ${a.app}`);
      authorize = { source: sourceOf(a.source) ? a.source : sourceOfApp(a.app), app: a.app, kind: a.kind, label };
    }
  }
  const dispatch = (Array.isArray(value.dispatch) ? value.dispatch : []).filter((entry) => entry && typeof entry === 'object' && sourceOf(entry.source) && on(entry.source) && typeof entry.plan === 'string' && entry.plan.trim())
    .slice(0, 6).map((entry) => ({ source: entry.source, apps: (Array.isArray(entry.apps) ? entry.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub')).slice(0, 8), label: line(entry.label, 80) || sourceOf(entry.source).label, plan: clip(entry.plan, 8000) }));
  return { say: clip(typeof value.say === 'string' ? value.say : '', 2000), ask, authorize, dispatch, waiting: value.waiting === true && !ask && !authorize, done: value.done === true };
}

/** A survey agent's report made safe → { signedIn, summary, total, items: [{ id, label, kind, date, where, why }], notes }. */
function readSurvey(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(raw.slice(start, end + 1)); } catch { value = null; } }
  if (!value || typeof value !== 'object') return { signedIn: null, summary: line(raw, 600), total: null, items: [], notes: null };
  const items = (Array.isArray(value.items) ? value.items : []).filter((item) => item && typeof item === 'object' && (item.id || item.label)).slice(0, 40)
    .map((item) => ({ id: line(item.id, 300), label: line(item.label, 160), kind: line(item.kind, 20), date: line(item.date, 20) || null, where: line(item.where, 120) || null, why: line(item.why, 120) || null }));
  return { signedIn: typeof value.signedIn === 'boolean' ? value.signedIn : null, summary: line(value.summary, 600), total: Number.isFinite(value.total) ? value.total : null, items, notes: value.notes ? line(value.notes, 600) : null };
}

/** What the person did, as the librarian is told it. */
function messageOf(input) {
  if (input.skipped) return 'skipped';
  if (input.importNow) return 'Import now.';
  if (Array.isArray(input.picked) && input.picked.length) return `picked ${input.picked.map((label) => `"${line(label, 160)}"`).join(', ')}${input.text ? `, and said: ${line(input.text, 2000)}` : ''}`;
  if (input.authorized) return `${input.authorized.kind === 'permission' ? 'allowed' : input.authorized.kind === 'signin' ? 'signed in' : 'authorized'} "${input.authorized.app}"`;
  if (input.chose) return `chose ${input.chose.kind} "${input.chose.shown}" for "${input.chose.app}"`;
  if (input.survey) return `survey finished: "${input.survey}"`;
  return line(input.text, 4000);
}

/** What the chat shows for it. */
function shownOf(input) {
  if (input.skipped) return 'Skip';
  if (input.importNow) return 'Import now';
  if (Array.isArray(input.picked) && input.picked.length) return [input.picked.map((label) => line(label, 160)).join(', '), input.text ? clip(input.text, 2000) : ''].filter(Boolean).join(' — ');
  if (input.authorized) return input.authorized.kind === 'permission' ? `Allowed ${input.authorized.app}` : `Signed in to ${input.authorized.app}`;
  if (input.chose) return `${input.chose.shown}`;
  return clip(input.text, 4000);
}

/**
 * `agents` (./agents.cjs or the fake's); `models()` Build's model list (the pinned models' ids); `ready()` the providers
 * whose CLI can run now; `context()` the store's context; `zotero` { status(), root(), download? }; `github` { status(),
 * repos() }; `deps` for the library (describe, identifyRepo, inspectPdf, onAdded, onPdf); `notify(snapshot)` on every
 * change; `openBridge` (../sandbox/local-tools.cjs openToolBridge); `browser` the agents' browser (./browser.cjs, null
 * where there is none); `connectors` (./connectors.cjs); `appleNotes` (./apple-notes.cjs).
 */
function createConnect({ agents, models = () => null, ready = () => [...PROVIDERS], context, homeDir, env = process.env, zotero = {}, github = {}, deps = {}, notify = () => {}, openBridge, browser = null, connectors = null, appleNotes = null, now = () => new Date().toISOString() }) {
  const sessions = new Map();
  const readyNow = () => { try { return (ready() || []).filter((provider) => PROVIDERS.includes(provider)); } catch { return [...PROVIDERS]; } };
  const choiceFor = (provider) => connectChoice(provider, (() => { try { return models(); } catch { return null; } })());

  const publicJob = (job) => ({ id: job.id, kind: job.kind, source: job.source, label: job.label, apps: job.apps, status: job.status, notes: job.notes, items: job.items, activity: job.activity, summary: job.summary, error: job.error, started: job.started, ended: job.ended });
  const publicNeed = (need) => ({ id: need.id, app: need.app, kind: need.kind, reason: need.reason, jobs: need.jobs.length, opened: need.opened, busy: need.busy, error: need.error, at: need.at });
  function snapshot(s) {
    return {
      id: s.id, mode: s.mode, chat: s.chat, thinking: s.thinking, activity: s.activity, waiting: s.waitingForSurvey, done: s.done, error: s.error, finished: s.finished, stopped: s.stopped, minimized: s.minimized, dismissed: s.dismissed,
      jobs: s.jobs.filter((job) => job.kind !== 'redact').map(publicJob), needs: s.needs.filter((need) => !need.closed).map(publicNeed), log: s.log.slice(-SHOWN_LOG),
      provider: s.choice.provider, choice: { provider: s.choice.provider, name: PROVIDER_NAMES[s.choice.provider], modelName: s.choice.modelName, effort: s.choice.effort },
      permissions: s.choices.permissions, projectId: s.projectId, staged: s.projectId ? 0 : notes.stagedCount(s.dir), memory: { ...s.memory }, created: s.created,
      counts: { notes: s.jobs.reduce((n, job) => n + job.notes, 0), items: s.jobs.reduce((n, job) => n + job.items, 0) },
    };
  }
  function save(s) {
    try {
      fs.mkdirSync(s.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({ ...snapshot(s), log: s.log, choices: s.choices, picked: s.picked, jobs: s.jobs.map((job) => ({ ...publicJob(job), plan: job.plan, titles: job.titles })) }, null, 2), { mode: 0o600 });
    } catch { /* the chat goes on */ }
  }
  let emitTimer = null;
  const pending = new Set();
  function emit(s, { soon = false } = {}) {
    if (!soon) { pending.delete(s); save(s); notify(snapshot(s)); return; }
    pending.add(s);
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; for (const held of pending) notify(snapshot(held)); pending.clear(); }, 250);
    if (emitTimer.unref) emitTimer.unref();
  }

  /** The action log: what each agent did, in the person's words, newest last. */
  function logAction(s, job, text, who = null) {
    s.log.push({ at: now(), job: job ? job.id : null, who: who || (job ? job.label : 'Engelbart'), text: line(text, 200) });
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    emit(s, { soon: true });
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
    add(s.downloads);
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
    return s.chat.map((entry) => `${entry.role === 'agent' ? 'librarian' : 'person'}: ${entry.text}${entry.ask ? `\n  (asked, ${entry.ask.kind}: ${entry.ask.title}${entry.ask.options.length ? ` — ${entry.ask.options.map((option) => option.label).join(' | ')}` : ''})` : ''}${entry.authorize ? `\n  (offered the button: ${entry.authorize.label})` : ''}`).join('\n');
  }

  function importsText(s) {
    const work = s.jobs.filter((job) => job.kind === 'import' || job.kind === 'survey');
    if (!work.length) return '';
    return JSON.stringify(work.map((job) => ({ kind: job.kind, label: job.label, source: job.source, apps: job.apps, status: job.status, notesAdded: job.notes, itemsAdded: job.items, ...(job.summary && job.kind === 'import' ? { said: job.summary } : {}), ...(job.error ? { error: job.error } : {}) })));
  }

  function engelbartBlock(s) {
    const where = s.mode === 'existing' ? 'Notes brought in now go into the project they have open.' : 'Notes brought in now go into the project they make at the end of onboarding.';
    return `<engelbart>\nA person is connecting their library to Engelbart (test mode). Their library is at ${s.dataRoot}. ${where}\nPermissions they gave: read files anywhere in their home folder: ${s.choices.permissions.files ? 'yes' : 'no, only the folders of the sources they picked'}; use their accounts in Engelbart's background browser: ${s.choices.permissions.browser ? 'yes' : 'no (web apps are left out)'}; ask their AI assistants what they remember: ${s.choices.permissions.recall ? 'yes' : 'no'}.\n</engelbart>`;
  }

  const surveying = (s) => s.jobs.some((job) => job.kind === 'survey' && !ENDED.has(job.status));

  async function firstMessage(s, message, { again = false } = {}) {
    const ctx = await context();
    const custom = instructionsText(s.dataRoot);
    const parts = [
      engelbartBlock(s),
      `<choices>\n${JSON.stringify({ ...s.choices.sources, customInstructionsForThisImport: s.choices.custom || null, permissions: s.choices.permissions }, null, 1)}\n</choices>`,
      `<found>\n${JSON.stringify(s.found, null, 1)}\n</found>`,
      `<library>${JSON.stringify(await libraryCounts(ctx))}</library>`,
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      again && s.chat.length ? `<conversation note="What was said so far; your earlier replies are summarised as what you asked.">\n${conversationText(s)}\n</conversation>` : '',
      again && s.jobs.length ? `<imports>${importsText(s)}</imports>` : '',
      `<message>${message}</message>`,
    ];
    s.newFound = null;
    return parts.filter(Boolean).join('\n\n');
  }

  function laterMessage(s, message) {
    const parts = [];
    const imports = importsText(s);
    if (imports && imports !== s.toldImports) { parts.push(`<imports>${imports}</imports>`); s.toldImports = imports; }
    if (s.newFound) { parts.push(`<found note="What changed since your last turn.">\n${JSON.stringify(s.newFound, null, 1)}\n</found>`); s.newFound = null; }
    parts.push(`<message>${message}</message>`);
    return parts.join('\n\n');
  }

  /** One librarian turn: what the person did → its reply applied (a message in the chat, imports started). */
  async function interviewTurn(s, message) {
    if (s.stopped) return;
    s.thinking = true;
    s.activity = '';
    s.error = '';
    s.waitingForSurvey = false;
    s.surveyNews = []; // what they found is in <found> this turn
    emit(s);
    const controller = new AbortController();
    s.interviewController = controller;
    const onUpdate = ({ activity }) => { if (activity && activity !== s.activity) { s.activity = activity; emit(s, { soon: true }); } };
    const system = promptOf(s.dataRoot, 'connect-system-prompt.md', prompts.INTERVIEW_SYSTEM_PROMPT);
    const meta = { kind: 'interview', session: s, message };
    const base = { choice: s.choice, kind: 'interview', system, dirs: s.dirs, signal: controller.signal, onUpdate, meta };
    try {
      let out;
      if (s.interviewSession) {
        try {
          out = await agents.turn({ ...base, message: laterMessage(s, message), session: s.interviewSession });
        } catch (error) {
          if (error && error.kind === 'stopped') throw error;
          // A session that will not resume starts again from everything, the conversation included.
          out = await agents.turn({ ...base, message: await firstMessage(s, message, { again: true }), session: null });
        }
      } else {
        out = await agents.turn({ ...base, message: await firstMessage(s, message, { again: s.chat.length > 1 }), session: null });
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
      // A survey that reported while the librarian talked, and it said it would wait: woken now. Waiting with no survey
      // left to report would leave the chat still for good: it is told so (twice at most), and goes on.
      if (!s.stopped && !s.finished && s.waitingForSurvey) {
        if (s.surveyNews.length) wake(s);
        else if (!surveying(s) && (s.nudges = (s.nudges || 0) + 1) <= 2) void interviewTurn(s, 'Every survey has reported already: what they found is in <found>. Go on.');
      }
    }
  }

  function apply(s, reply) {
    s.chat.push({ role: 'agent', text: reply.say || (reply.ask ? '' : reply.dispatch.length ? 'Starting that now.' : '…'), ask: reply.ask, authorize: reply.authorize, at: now() });
    for (const entry of reply.dispatch) dispatch(s, { ...entry, kind: 'import' });
    if (reply.done && !surveying(s)) s.done = true;
    s.waitingForSurvey = !s.done && !reply.ask && !reply.authorize && (reply.waiting || (reply.done && surveying(s)));
    maybeMemory(s);
  }

  /** The librarian woken by what a survey found, when it said it was waiting for one. */
  function wake(s) {
    if (s.thinking || s.stopped || s.finished) return;
    const apps = [...new Set(s.surveyNews.splice(0))];
    if (!apps.length) return;
    void interviewTurn(s, apps.map((app) => messageOf({ survey: app })).join('; '));
  }

  /* --------------------------------------------------------------------------------------------- the priority queue */

  /** A job queued: started when a place is free, the most urgent kind first. The same kind, source and apps go once. */
  function dispatch(s, { kind = 'import', source, apps = [], label, plan = '', extra = null }) {
    const key = `${kind}:${source}:${[...apps].sort().join(',')}`;
    if (s.jobs.some((job) => job.key === key) || s.jobs.length >= MAX_JOBS) return null;
    if (kind === 'import' && apps.length && s.jobs.some((job) => job.kind === 'import' && job.source === source && !job.apps.length)) return null; // the whole source went already
    s.seq += 1;
    const job = { id: randomUUID(), key, kind, priority: PRIORITY[kind], seq: s.seq, source, apps, label, plan, extra, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null };
    s.jobs.push(job);
    logAction(s, job, kind === 'survey' ? `Will look through ${apps.join(', ')}` : kind === 'recall' ? `Will ask ${apps.join(', ')} what it remembers` : kind === 'import' ? 'Queued' : 'Queued');
    pump(s);
    return job;
  }

  function pump(s) {
    if (s.stopped) return;
    for (;;) {
      const running = s.jobs.filter((job) => job.status === 'running' || job.status === 'waiting').length;
      if (running >= MAX_RUNNING) break;
      const next = s.jobs.filter((job) => job.status === 'queued').sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
      if (!next) break;
      void runJob(s, next);
    }
  }

  const sitesOf = (apps) => [...new Set(apps.flatMap((app) => (appOf(app) && appOf(app).sites) || []))];
  /** The apps a job covers: those it names, else every app picked for its source (a whole source handed over). */
  const appsOfJob = (s, job) => (job.apps.length ? job.apps : ((s.choices.sources[job.source] || {}).apps || []));

  function jobMessage(s, job) {
    const custom = instructionsText(s.dataRoot);
    const choice = s.choices.sources[job.source] || {};
    const apps = job.apps.length ? job.apps : choice.apps || [];
    const found = (s.found || {})[job.source] || {};
    if (job.kind === 'survey') {
      return [engelbartBlock(s), `<source>${job.source}</source>`, `<app>${apps[0]}</app>`, skillsFor({ source: job.source, apps }, s.dataRoot), `<found>\n${JSON.stringify(found[apps[0]] || {}, null, 1)}\n</found>`, `Look at what they have in ${apps[0]} now, and report.`].filter(Boolean).join('\n\n');
    }
    if (job.kind === 'recall') {
      return [engelbartBlock(s), `<app>${apps[0]}</app>`, skillsFor({ source: job.source, apps }, s.dataRoot), `<prompt>\n${prompts.RECALL_PROMPT}\n</prompt>`, `Ask ${apps[0]} now, and save its answer with save_memory.`].join('\n\n');
    }
    return [
      engelbartBlock(s),
      `<source>${JSON.stringify({ source: job.source, apps, label: job.label, foldersPicked: choice.folders || [], repositoriesPicked: choice.repos || [], foldersChosen: s.picked.folders, downloadsGoTo: s.downloads })}</source>`,
      `<plan>\n${job.plan}\n</plan>`,
      `<chat>\n${clipMiddle(conversationText(s), 30000)}\n</chat>`,
      `<found>\n${clipMiddle(JSON.stringify(found, null, 1), 40000)}\n</found>`,
      skillsFor({ source: job.source, apps }, s.dataRoot),
      s.choices.custom ? `<import_instructions note="What the person typed on the choose screen for this import.">\n${s.choices.custom}\n</import_instructions>` : '',
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      'Do the import now.',
    ].filter(Boolean).join('\n\n');
  }

  function systemOf(s, kind) {
    if (kind === 'survey') return prompts.SURVEY_SYSTEM_PROMPT;
    if (kind === 'recall') return prompts.RECALL_SYSTEM_PROMPT;
    if (kind === 'memory') return prompts.MEMORY_SYSTEM_PROMPT;
    if (kind === 'redact') return prompts.REDACT_SYSTEM_PROMPT;
    return promptOf(s.dataRoot, 'connect-import-system-prompt.md', prompts.IMPORT_SYSTEM_PROMPT);
  }

  async function runJob(s, job) {
    job.status = 'running';
    job.started = now();
    logAction(s, job, job.kind === 'memory' ? 'Writing MEMORY.md' : job.kind === 'redact' ? 'Taking any secrets out of MEMORY.md' : 'Started');
    emit(s);
    const controller = new AbortController();
    s.controllers.add(controller);
    job.controller = controller;
    const bridged = WORK.has(job.kind);
    const covered = appsOfJob(s, job);
    const page = bridged && browser && s.choices.permissions.browser && sitesOf(covered).length ? browser.tools({ id: job.id, label: job.label, sites: sitesOf(covered) }) : null;
    const session = {
      dataRoot: s.dataRoot, homeDir, dir: s.dir, downloads: s.downloads, projectId: () => s.projectId,
      get exports() { return s.picked.exports; },
      get folders() { return s.picked.folders; },
    };
    const callTool = bridged ? createImportTools({
      session, context, zotero, github, deps, env, kind: job.kind, page, appleNotes,
      needs: { ask: (request) => askPerson(s, job, request), wait: () => waitAgain(s, job) },
      recall: (app, text) => keepRecall(s, app, text),
      log: (text) => logAction(s, job, text),
      added: (kind, n, title) => { job[kind === 'notes' ? 'notes' : 'items'] += n; if (title && job.titles.length < 80) job.titles.push(String(title).slice(0, 120)); emit(s, { soon: true }); },
    }) : null;
    let bridge = null;
    try {
      const onUpdate = ({ activity }) => { if (activity && activity !== job.activity) { job.activity = activity; emit(s, { soon: true }); } };
      const connectorsNow = bridged && connectors ? await connectors.serversFor(covered).catch(() => []) : [];
      if (bridged) bridge = await openBridge(callTool, { signal: controller.signal, maxBody: 1_000_000 });
      const choice = job.kind === 'redact' ? s.redactChoice || s.choice : s.choice;
      const dirs = job.kind === 'memory' ? [s.dir, ...(s.projectDir ? [s.projectDir] : [])].filter((dir) => fs.existsSync(dir)) : job.kind === 'redact' ? [] : s.dirs;
      const message = job.kind === 'memory' ? await memoryMessage(s) : job.kind === 'redact' ? `<memory_md>\n${s.memoryDraft}\n</memory_md>` : jobMessage(s, job);
      const out = await agents.turn({ choice, kind: job.kind, system: systemOf(s, job.kind), message, session: null, dirs, signal: controller.signal, bridge: bridge && bridge.connection, connectors: connectorsNow, onUpdate, meta: { kind: job.kind, session: s, job, callTool } });
      if (job.kind === 'survey') surveyed(s, job, out.text);
      else if (job.kind === 'memory') drafted(s, out.text);
      else if (job.kind === 'redact') await finishMemory(s, out.text);
      job.summary = job.kind === 'memory' || job.kind === 'redact' ? '' : line(job.kind === 'survey' ? (readSurvey(out.text).summary || out.text) : out.text, 500);
      job.status = 'done';
      logAction(s, job, job.kind === 'import' ? `Finished: ${job.summary}` : job.kind === 'survey' ? `Looked: ${job.summary}` : job.kind === 'recall' ? (s.recalls[job.apps[0]] ? 'Kept what it remembers' : `Finished: ${job.summary}`) : 'Finished');
    } catch (error) {
      job.status = error && error.kind === 'stopped' ? 'stopped' : 'failed';
      job.error = job.status === 'failed' ? line(error && error.message ? error.message : 'The import failed', 300) : '';
      logAction(s, job, job.status === 'stopped' ? 'Stopped' : `Failed: ${job.error}`);
      if (job.kind === 'survey') surveyed(s, job, null, job.error || 'stopped');
      if (job.kind === 'memory' || job.kind === 'redact') { s.memory = { ...s.memory, status: job.status === 'stopped' ? 'stopped' : 'failed', error: job.error }; }
    } finally {
      s.controllers.delete(controller);
      job.controller = null;
      if (bridge) await bridge.close().catch(() => {});
      if (browser) browser.close(job.id);
      releaseNeeds(s, job);
      job.activity = '';
      job.ended = now();
      emit(s);
      pump(s);
      maybeMemory(s);
    }
  }

  /* ------------------------------------------------------------------------------------------------------- surveys */

  /** A survey's report goes into what was found, for the librarian; it is woken if it said it was waiting. */
  function surveyed(s, job, text, error = '') {
    const app = job.apps[0];
    const report = text != null ? readSurvey(text) : { error: error || 'The survey did not finish' };
    s.found[job.source] = { ...(s.found[job.source] || {}), [app]: { ...((s.found[job.source] || {})[app] || {}), survey: report } };
    s.newFound = { ...(s.newFound || {}), [job.source]: { ...((s.newFound || {})[job.source] || {}), [app]: s.found[job.source][app] } };
    s.surveyNews.push(app);
    if (s.waitingForSurvey && !s.thinking) wake(s);
  }

  /** The surveys and recalls a session starts with: every web or connector app it may reach, every assistant it may ask. */
  function startWork(s) {
    for (const [source, choice] of Object.entries(s.choices.sources)) {
      if (!choice.on) continue;
      for (const app of choice.apps) {
        const reach = appOf(app) ? appOf(app).reach : null;
        if (reach === 'web') {
          if (!s.choices.permissions.browser) { s.found[source] = { ...(s.found[source] || {}), [app]: { reach, left: 'They did not let the agents use their accounts, so this app is left out.' } }; continue; }
          s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running' } };
          dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${app}` });
        } else if (reach === 'connector') {
          const connected = connectors ? connectors.status(app).connected : false;
          s.found[source] = { ...(s.found[source] || {}), [app]: connected ? { reach, survey: 'running' } : { reach, needs: 'connector' } };
          if (connected) dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${app}` });
        }
      }
    }
    if (s.choices.permissions.recall && s.choices.permissions.browser) {
      for (const app of recallApps((s.choices.sources.chats || {}).on ? s.choices.sources.chats.apps : [])) dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${app} what it remembers` });
    }
  }

  /* ------------------------------------------------------------------------------------------------------ needs you */

  /** An agent hands the person a step (a sign-in, a code, a permission): one request per app and kind, then waits for it. */
  function askPerson(s, job, { kind, reason }) {
    const app = job.apps[0] || job.label;
    let need = s.needs.find((entry) => !entry.closed && entry.app === app && entry.kind === kind);
    if (!need) {
      need = { id: randomUUID(), app, kind, reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', closed: false, at: now() };
      s.needs.push(need);
      logAction(s, job, `Needs you: ${reason}`);
    }
    if (!need.jobs.includes(job.id)) need.jobs.push(job.id);
    return waitOn(s, job, need);
  }

  function waitAgain(s, job) {
    const need = s.needs.find((entry) => !entry.closed && entry.jobs.includes(job.id));
    if (!need) return Promise.resolve({ status: 'done', note: 'Nothing is waiting on the person any more.' });
    return waitOn(s, job, need);
  }

  function waitOn(s, job, need) {
    job.status = 'waiting';
    emit(s);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { need.waiters.delete(job.id); if (job.status === 'waiting') job.status = 'running'; emit(s, { soon: true }); resolve({ status: 'waiting', note: 'The person has not done it yet. Call wait_for_you again, or go on without it and say so.' }); }, NEED_WAIT_MS);
      if (timer.unref) timer.unref();
      need.waiters.set(job.id, (result) => { clearTimeout(timer); if (job.status === 'waiting') job.status = 'running'; resolve(result); });
    });
  }

  /** The person answered a request: done (the agents go on) or skip (they go on without that app). */
  function closeNeed(s, need, how) {
    if (need.closed) return;
    need.closed = true;
    for (const [jobId, resolve] of need.waiters) { resolve({ status: how === 'skip' ? 'skipped' : 'done' }); if (browser) browser.hide(jobId); }
    need.waiters.clear();
    for (const jobId of need.jobs) if (browser) browser.hide(jobId);
    logAction(s, null, how === 'skip' ? `Skipped: ${need.reason}` : `Done: ${need.reason}`, 'You');
    emit(s);
  }

  /** A job that ended stops waiting; a request no job waits on any more goes. */
  function releaseNeeds(s, job) {
    for (const need of s.needs) {
      if (need.closed || !need.jobs.includes(job.id)) continue;
      need.waiters.delete(job.id);
      need.jobs = need.jobs.filter((id) => id !== job.id);
      if (!need.jobs.length) need.closed = true;
    }
  }

  /* ------------------------------------------------------------------------------------------------------- MEMORY.md */

  function keepRecall(s, app, text) {
    s.recalls[app] = text;
    const dir = path.join(s.dir, 'memories');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${String(app).replace(/[^\w .-]+/g, '-')}.md`), `${text}\n`, { mode: 0o600 });
    emit(s, { soon: true });
  }

  /** MEMORY.md is written once the questions are over and every survey, recall and import has ended. */
  function maybeMemory(s) {
    if (s.stopped || s.memoryQueued || !(s.done || s.finished)) return;
    if (s.jobs.some((job) => WORK.has(job.kind) && !ENDED.has(job.status))) return;
    const worked = s.jobs.some((job) => WORK.has(job.kind) && job.status === 'done') || Object.keys(s.recalls).length;
    if (!worked) { s.memory = { ...s.memory, status: 'skipped' }; return; }
    s.memoryQueued = true;
    s.memory = { ...s.memory, status: 'writing', error: '' };
    dispatch(s, { kind: 'memory', source: 'memory', apps: [], label: 'MEMORY.md' });
  }

  async function memoryMessage(s) {
    const recalls = Object.entries(s.recalls).map(([app, text]) => `## ${app} (asked ${s.created.slice(0, 10)})\n${clipMiddle(text, 12000)}`);
    const local = memory.localMemories(homeDir, env).map((entry) => `## ${entry.app} (${entry.file})\n${entry.text}`);
    const imports = s.jobs.filter((job) => job.kind === 'import').map((job) => ({ label: job.label, status: job.status, notes: job.notes, items: job.items, said: job.summary || job.error, titles: job.titles.slice(0, 40) }));
    const surveys = s.jobs.filter((job) => job.kind === 'survey' && job.status === 'done').map((job) => ({ app: job.apps[0], said: job.summary }));
    const existing = memory.readMemory(s.dataRoot);
    const custom = instructionsText(s.dataRoot);
    return [
      existing ? `<existing_memory>\n${existing}\n</existing_memory>` : '<existing_memory>none yet</existing_memory>',
      `<assistant_memories>\n${[...recalls, ...local].join('\n\n') || 'none'}\n</assistant_memories>`,
      `<conversation>\n${clipMiddle(conversationText(s), 20000)}\n</conversation>`,
      `<imports>\n${JSON.stringify({ imports, surveys }, null, 1)}\n</imports>`,
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      s.choices.custom ? `<import_instructions>\n${s.choices.custom}\n</import_instructions>` : '',
      `<folders note="Where the imported notes are, to Read when a title is not enough.">${[path.join(s.dir, 'notes'), s.projectDir].filter(Boolean).join(', ')}</folders>`,
      `Today is ${s.created.slice(0, 10)}. Write MEMORY.md now.`,
    ].filter(Boolean).join('\n\n');
  }

  function drafted(s, text) {
    const draft = String(text || '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
    if (draft.length < 40) throw new Error('The memory agent wrote nothing to keep');
    s.memoryDraft = draft;
    s.memory = { ...s.memory, status: 'cleaning' };
    // "one background claude sonnet agent": Claude Code's Sonnet when it can run, else the session's own pinned model.
    s.redactChoice = readyNow().includes('anthropic') ? choiceFor('anthropic') : s.choice;
    dispatch(s, { kind: 'redact', source: 'memory', apps: [], label: 'MEMORY.md, secrets out' });
  }

  async function finishMemory(s, text) {
    const draft = s.memoryDraft || '';
    let cleaned = String(text || '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
    // An edit that lost most of the file is not an edit: the draft goes on, with only the secrets of a known shape out.
    if (cleaned.length < draft.length * 0.5) { logAction(s, null, 'The secrets check returned too little; kept the draft with known secrets masked'); cleaned = draft; }
    const scrubbed = memory.scrubSecrets(cleaned);
    const saved = memory.saveMemory(s.dataRoot, scrubbed.text);
    s.memoryDraft = null;
    s.memory = { status: 'saved', path: saved.path, previous: saved.previous, removed: scrubbed.removed, error: '', at: now() };
    logAction(s, null, `Saved MEMORY.md${scrubbed.removed ? ` (${scrubbed.removed} more secret${scrubbed.removed === 1 ? '' : 's'} masked)` : ''}`);
  }

  /* -------------------------------------------------------------------------------------------------------- start */

  async function rescan(s, sourceIds) {
    const only = { sources: Object.fromEntries(Object.entries(s.choices.sources).filter(([id]) => sourceIds.includes(id))) };
    const fresh = await scanFor(only, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null });
    for (const [source, apps] of Object.entries(fresh)) {
      // What a survey found is kept: the scan does not know it.
      const merged = { ...(s.found[source] || {}) };
      for (const [app, value] of Object.entries(apps)) merged[app] = merged[app] && merged[app].survey && value && value.reach ? merged[app] : value;
      s.found[source] = merged;
      s.newFound = { ...(s.newFound || {}), [source]: merged };
    }
    s.dirs = dirsOf(s);
  }

  /** The choose screen sent: the session, the scan, the first surveys, and the librarian's first turn. → snapshot */
  async function start(input) {
    const ctx = await context();
    const choices = cleanChoices(input, homeDir);
    if (!Object.values(choices.sources).some((choice) => choice.on)) throw new Error('Pick at least one source.');
    const usable = readyNow();
    if (!usable.length) throw new Error('Sign in to Claude Code or Codex first: the agents run on one of them.');
    const provider = usable.includes(input && input.provider) ? input.provider : usable[0];
    const id = randomUUID();
    let projectId = null, projectDir = null;
    if (input && typeof input.projectId === 'string' && ID_RE.test(input.projectId)) {
      try { const project = require('../store/projects.cjs').findProject(ctx, input.projectId); projectId = project.id; projectDir = project.dir; } catch { projectId = null; }
    }
    const s = {
      id, mode: projectId ? 'existing' : 'onboarding', dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', id), downloads: path.join(ctx.dataRoot, 'imports', id), created: now(), choices, choice: choiceFor(provider), redactChoice: null,
      picked: { folders: {}, exports: {} }, chat: [], thinking: true, activity: 'Looking at what you picked…', done: false, finished: false, minimized: false, dismissed: false, error: '',
      jobs: [], seq: 0, needs: [], log: [], controllers: new Set(), interviewSession: null, interviewController: null, found: {}, newFound: null, toldImports: '', projectId, projectDir, stopped: false,
      waitingForSurvey: false, surveyNews: [], recalls: {}, memory: { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' }, memoryQueued: false, memoryDraft: null,
    };
    sessions.set(id, s);
    s.dirs = dirsOf(s);
    logAction(s, null, `Started with ${PROVIDER_NAMES[s.choice.provider]} (${s.choice.modelName} · ${s.choice.effort})`);
    emit(s);
    void (async () => {
      try { s.found = await scanFor(choices, { homeDir, env, picked: s.picked, zotero, github, appleNotes: choices.permissions.notes ? appleNotes : null }); } catch (error) { s.found = { error: error.message }; }
      s.dirs = dirsOf(s);
      startWork(s);
      await interviewTurn(s, 'Start.');
    })();
    return snapshot(s);
  }

  function busy(s) { if (s.thinking) throw new Error('Wait for the librarian to answer'); }

  /** The person answered: { text } | { picked: [labels], text? } | { skipped: true }, and maybe { provider }. */
  function answer(id, input = {}) {
    const s = get(id);
    busy(s);
    const value = input && typeof input === 'object' ? input : {};
    const picked = Array.isArray(value.picked) ? value.picked.filter((label) => typeof label === 'string' && label.trim()).slice(0, 12) : null;
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, 4000) : '';
    const clean = value.skipped ? { skipped: true } : picked && picked.length ? { picked, text } : { text };
    if (!clean.skipped && !clean.picked && !clean.text) throw new Error('Say something first');
    if (typeof value.provider === 'string') setProvider(s, value.provider);
    s.chat.push({ role: 'user', text: shownOf(clean), at: now() });
    void interviewTurn(s, messageOf(clean));
    return snapshot(s);
  }

  /** The provider chosen under the chat: the next turns and jobs run there (its pinned model); a new librarian session. */
  function setProvider(s, provider) {
    if (!PROVIDERS.includes(provider) || provider === s.choice.provider) return;
    if (!readyNow().includes(provider)) throw new Error(`${PROVIDER_NAMES[provider]} is not signed in`);
    s.choice = choiceFor(provider);
    s.interviewSession = null;
    logAction(s, null, `Switched to ${PROVIDER_NAMES[provider]} (${s.choice.modelName} · ${s.choice.effort})`, 'You');
  }

  /**
   * A button in the chat was used: { app, kind: 'signin' } done in the window (Zotero, GitHub); { app, kind: 'connector' }
   * (the connector's sign-in, run here: the person's browser opens); { app, kind: 'permission' } (macOS asked here);
   * { app, kind: 'folder', path } chosen. Then the librarian goes on.
   */
  async function authorize(id, input = {}) {
    const s = get(id);
    busy(s);
    const app = typeof input.app === 'string' && (APPS[input.app] || input.app === 'GitHub') ? input.app : null;
    if (!app) throw new Error('Unknown app');
    const kind = AUTHORIZE_KINDS.has(input.kind) ? input.kind : input.kind === 'file' ? 'folder' : null;
    if (!kind) throw new Error('Unknown kind');
    const source = sourceOfApp(app);
    let clean;
    if (kind === 'connector') {
      if (!connectors) throw new Error(`${app} cannot be signed in to here`);
      s.activity = `Waiting for you to sign in to ${app} in your browser`;
      s.thinking = true;
      emit(s);
      try { await connectors.signIn(app); } catch (error) { s.thinking = false; s.activity = ''; emit(s); throw error; }
      s.thinking = false;
      s.activity = '';
      clean = { authorized: { app, kind } };
      s.found[source] = { ...(s.found[source] || {}), [app]: { reach: 'connector', survey: 'running' } };
      dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${app}` });
    } else if (kind === 'permission') {
      if (!appleNotes) throw new Error(`${app} cannot be read here`);
      const out = await appleNotes.permission();
      if (!out.allowed) throw new Error(out.error || 'macOS did not allow it');
      s.choices.permissions.notes = true;
      clean = { authorized: { app, kind } };
    } else if (kind === 'signin') {
      clean = { authorized: { app, kind } };
    } else {
      const file = readers.expandPath(homeDir, input.path);
      if (!file || !file.startsWith(homeDir + path.sep) || !fs.existsSync(file)) throw new Error('Choose something inside your home folder');
      s.picked.folders[app] = file;
      clean = { chose: { app, kind: 'folder', shown: readers.shownPath(homeDir, file) } };
    }
    s.chat.push({ role: 'user', text: shownOf(clean), at: now() });
    logAction(s, null, shownOf(clean), 'You');
    s.thinking = true;
    emit(s);
    // Zotero's library is read from the copy its first sync makes: waited for (a minute and a half at most), so the
    // librarian can list the collections.
    if (app === 'Zotero' && kind === 'signin') {
      s.activity = 'Waiting for your Zotero library to sync';
      emit(s);
      for (let n = 0; n < 90 && !s.stopped; n += 1) {
        const root = zotero.root ? zotero.root() : null;
        if (root && fs.existsSync(path.join(root, 'items.json'))) break;
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
      }
      s.activity = '';
    }
    if (kind !== 'connector') { try { await rescan(s, source ? [source] : []); } catch { /* the librarian is told what it can be */ } }
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
      const sent = s.jobs.filter((job) => job.kind === 'import' && job.source === source);
      if (!choice.on || sent.some((job) => !job.apps.length)) continue;
      const covered = new Set(sent.flatMap((job) => job.apps));
      const reachable = (app) => {
        const found = ((s.found || {})[source] || {})[app];
        const reach = appOf(app) ? appOf(app).reach : null;
        if (reach === 'web') return s.choices.permissions.browser;
        if (reach === 'connector') return !!(connectors && connectors.status(app).connected);
        if (reach === 'automation') return s.choices.permissions.notes;
        return !(found && found.needs);
      };
      const apps = choice.apps.filter((app) => !covered.has(app) && reachable(app));
      if (sent.length && !apps.length) continue;
      if (choice.apps.length && !apps.length && !choice.folders.length && !choice.repos.length) continue; // nothing of it can be reached
      const label = sourceOf(source).label;
      const where = [apps.length ? `from ${apps.join(', ')}` : '', choice.folders.length ? `folders ${choice.folders.join(', ')}` : '', choice.repos.length ? `repositories ${choice.repos.join(', ')} (already in the library)` : ''].filter(Boolean).join('; ');
      dispatch(s, { kind: 'import', source, apps, label: apps.length ? `${label}: ${apps.join(', ')}` : label, plan: `Bring in ${label.toLowerCase()} ${where} as the person picked and said in the chat. They pressed Import before this source was talked through, so use sensible defaults: leave out daily notes, personal folders and journals; tools used every day (mail, calendar, social media); runs a program started; anything older than about six months when there is a lot.` });
    }
    s.chat.push({ role: 'user', text: 'Import now', at: now() });
    s.done = true;
    s.waitingForSurvey = false;
    emit(s);
    maybeMemory(s);
    return snapshot(s);
  }

  /* ---------------------------------------------------------------------------------------- the person's controls */

  /** A request the window shows was answered: 'open' (do it: show the agent's window, sign in, ask macOS), 'done', 'skip'. */
  async function need(id, needId, action) {
    const s = get(id);
    const found = s.needs.find((entry) => entry.id === needId && !entry.closed);
    if (!found) return snapshot(s);
    if (action === 'done' || action === 'skip') { closeNeed(s, found, action); return snapshot(s); }
    if (action !== 'open') throw new Error('Unknown action');
    found.error = '';
    if (found.kind === 'connector' && connectors && APPS[found.app] && APPS[found.app].reach === 'connector') {
      found.busy = true;
      emit(s);
      try { await connectors.signIn(found.app); found.busy = false; closeNeed(s, found, 'done'); } catch (error) { found.busy = false; found.error = line(error.message, 200); emit(s); }
      return snapshot(s);
    }
    if (found.kind === 'permission' && appleNotes && found.app === 'Apple Notes') {
      found.busy = true;
      emit(s);
      const out = await appleNotes.permission();
      found.busy = false;
      if (out.allowed) { s.choices.permissions.notes = true; closeNeed(s, found, 'done'); } else { found.error = line(out.error, 200); emit(s); }
      return snapshot(s);
    }
    // A web sign-in, a code, a password, a captcha: the agent's own window, shown to the person to do it there.
    const jobId = found.jobs.find((each) => browser && browser.has(each));
    if (!jobId || !browser.show(jobId, { title: `${found.reason} — Engelbart` })) {
      found.error = 'There is no window to show here: sign in on the Stage, or bring your sign-ins over from Chrome, then press Done.';
      emit(s);
      return snapshot(s);
    }
    found.opened = true;
    logAction(s, null, `Opened the window: ${found.reason}`, 'You');
    emit(s);
    return snapshot(s);
  }

  /** A step the agents' browser took for a job, into that job's session's action log. */
  function logJob(jobId, text) {
    for (const s of sessions.values()) {
      const job = s.jobs.find((entry) => entry.id === jobId);
      if (job) { logAction(s, job, text); return; }
    }
  }

  /** The person closed a window shown to them: what it was shown for counts as done. */
  function windowClosed(jobId) {
    for (const s of sessions.values()) {
      const found = s.needs.find((entry) => !entry.closed && entry.jobs.includes(jobId));
      if (found) closeNeed(s, found, 'done');
    }
  }

  function stopJob(id, jobId) {
    const s = get(id);
    const job = s.jobs.find((entry) => entry.id === jobId);
    if (!job) return snapshot(s);
    if (job.status === 'queued') { job.status = 'stopped'; job.ended = now(); logAction(s, job, 'Stopped'); }
    else if (job.controller) job.controller.abort();
    emit(s);
    maybeMemory(s);
    return snapshot(s);
  }

  function stop(id) {
    const s = get(id);
    s.stopped = true;
    if (s.interviewController) s.interviewController.abort();
    for (const controller of s.controllers) controller.abort();
    for (const job of s.jobs) if (job.status === 'queued') { job.status = 'stopped'; job.ended = now(); }
    for (const found of s.needs) if (!found.closed) closeNeed(s, found, 'skip');
    if (s.memory.status === 'waiting' || s.memory.status === 'writing' || s.memory.status === 'cleaning') s.memory = { ...s.memory, status: 'stopped' };
    logAction(s, null, 'Stopped everything', 'You');
    emit(s);
    return snapshot(s);
  }

  /** MEMORY.md again, after it failed. */
  function retryMemory(id) {
    const s = get(id);
    if (s.stopped) throw new Error('This import was stopped');
    if (s.jobs.some((job) => (job.kind === 'memory' || job.kind === 'redact') && !ENDED.has(job.status))) return snapshot(s);
    s.jobs = s.jobs.filter((job) => job.kind !== 'memory' && job.kind !== 'redact');
    s.memoryQueued = false;
    if (s.memoryDraft) { s.memoryQueued = true; s.memory = { ...s.memory, status: 'cleaning', error: '' }; dispatch(s, { kind: 'redact', source: 'memory', apps: [], label: 'MEMORY.md, secrets out' }); } else maybeMemory(s);
    emit(s);
    return snapshot(s);
  }

  function setMinimized(id, value) { const s = get(id); s.minimized = !!value; emit(s); return snapshot(s); }

  /** Taken off the list of what is running (the dock), once nothing of it runs any more. */
  function dismiss(id) {
    const s = get(id);
    s.dismissed = true;
    emit(s);
    return true;
  }

  /** Onboarding made the project: the staged notes go into it, and later ones straight there. → how many went in */
  async function attachProject(ctx, id, projectId) {
    const s = sessions.get(id);
    if (!s || s.dataRoot !== ctx.dataRoot) return 0;
    s.projectId = projectId;
    try { s.projectDir = require('../store/projects.cjs').findProject(ctx, projectId).dir; } catch { s.projectDir = null; }
    const written = await notes.flushStaged(ctx, s.dir, projectId, { projects: require('../store/projects.cjs') });
    emit(s);
    return written.length;
  }

  function stopAll() {
    for (const s of sessions.values()) { try { if (!s.stopped) stop(s.id); } catch { /* gone */ } }
    if (browser) browser.closeAll();
  }

  /** The sessions of a data root that are not dismissed, newest first (the dock, a window that opens later). */
  function list(dataRoot) {
    return [...sessions.values()].filter((s) => !s.dismissed && (!dataRoot || s.dataRoot === dataRoot)).sort((a, b) => String(b.created).localeCompare(String(a.created))).map(snapshot);
  }

  /** What the choose screen offers: the providers that can run now, each with its pinned model. */
  function providers() {
    const usable = readyNow();
    return PROVIDERS.map((provider) => { const choice = choiceFor(provider); return { provider, name: PROVIDER_NAMES[provider], modelName: choice.modelName, effort: choice.effort, ready: usable.includes(provider) }; });
  }

  /** A connector's sign-in the person gave up on: the chat goes on. */
  function cancelSignIn(id, app) {
    get(id);
    if (connectors && typeof app === 'string') connectors.cancel(app);
    return true;
  }

  return {
    start, answer, authorize, importNow, need, stop, stopJob, stopAll, retryMemory, setMinimized, dismiss, attachProject, windowClosed, logJob, list, providers, cancelSignIn,
    setProvider: (id, provider) => { const s = get(id); setProvider(s, provider); emit(s); return snapshot(s); },
    // the first build's name for authorize
    connected: (id, input) => authorize(id, input),
    state: (id) => snapshot(get(id)), has: (id) => sessions.has(id),
  };
}

module.exports = { createConnect, cleanChoices, readReply, readSurvey, messageOf, shownOf, connectChoice, CONNECT_MODELS, PROVIDER_NAMES, PRIORITY, MAX_RUNNING };
