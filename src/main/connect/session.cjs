'use strict';

// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html", the "Onboarding brainstorm" note). In
// every library since 2026-10-08 (test mode's only until then): the person picks what should go into their library,
// then a librarian agent talks with them in one continuous chat (single and multiple choice and short open questions,
// built from what was found) and hands each source to an import agent as soon as it is settled. Imports run in the
// background while the chat goes on and after the window is put away.
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
//   · a session can belong to an existing project (the one-time popup)
//
// Third build (2026-10-08, "Agent onboarding" again):
//   · what comes in is a Markdown file of the library's own in <dataRoot>/assets/md, not a project's note ("save the
//     imported content not as notes but as md files"), so nothing waits for onboarding to make the project
//   · Skip on a "Needs you" holds for the run: that app is never put to the person again (skipApp)
//   · Skip on the librarian's question or button brings nothing of it in (2026-10-08: "When I hit skip it should not bring
//     in anything, not just have the agent choose"): the question's source (or the apps it named) or the button's app is
//     left out for the run, in code, so neither the librarian nor Import can hand it over (skipAsked)
//   · Papers on this Mac: the folders that hold PDFs, asked about by folder and kind (../../shared/connect-sources.cjs
//     LOCAL_PDFS, ./scan.cjs pdfsAtAGlance)
//   · a session still going when Engelbart quits (or switches library) is saved as it is and picked up again when that
//     library is next open (suspendAll, resume)
//
// What it writes is only in the data root it started in (~/.engelbart, or ~/.engelbart/test in test mode): <dataRoot>/.connect/<id>/
// (session.json, what was said, how each import went and what resuming needs; notes/ notes an earlier build staged;
// memories/ what each assistant answered), <dataRoot>/imports/<id>/ (what the agents downloaded), assets/md/, MEMORY.md,
// and the library rows the import tools add.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SOURCES, APPS, LOCAL_PDFS, sourceOf, appOf, sourceOfApp, recallApps } = require('../../shared/connect-sources.cjs');
const prompts = require('./prompts.cjs');
const { scanFor } = require('./scan.cjs');
const readers = require('./readers.cjs');
const notes = require('./notes.cjs');
const { createImportTools } = require('./tools.cjs');
const { skillsFor } = require('./skills.cjs');
const memory = require('./memory.cjs');
const { clipMiddle } = require('../bart/clip.cjs');
const { READABLE_NAMES } = require('./web-signin.cjs');

const MAX_RUNNING = 3;
const MAX_JOBS = 40;
const MAX_LOG = 400;
const SHOWN_LOG = 150;
const NEED_WAIT_MS = 170_000;
const SIGN_IN_CHECK_MS = 10_000; // the sign-ins looked at before the surveys start, all together, at most this long
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_KINDS = new Set(['single', 'multi', 'open', 'repos']);
// Which of GitHub's repositories, asked as any choice is: the window shows the GitHub list instead (2026-10-08: "when
// asking me which repositories it should use our existing nice github ui"), whether or not the librarian said "repos".
const REPOS_ASK = /\bwhich\b.*\brepo(?:s|sitory|sitories)?\b/i;
const AUTHORIZE_KINDS = new Set(['signin', 'connector', 'permission', 'folder']);
const SIGNIN_APPS = new Set(['Zotero', 'GitHub']);
const PRIORITY = Object.freeze({ survey: 0, recall: 1, import: 2, memory: 3, redact: 4, suggest: 5 });
// Engelbart's own jobs, not shown in the working view's list: MEMORY.md's secrets check and the suggested workspaces.
const HIDDEN = new Set(['redact', 'suggest']);
const SUGGEST_ROWS = 300;
const SUGGEST_MAX = 4;
const SUGGEST_ITEMS = 12;
const NAME_MAX = 40;
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
  const reposAsk = value.ask && typeof value.ask === 'object' && typeof value.ask.title === 'string' && (value.ask.kind === 'repos' || (value.ask.source === 'code' && value.ask.kind !== 'open' && REPOS_ASK.test(value.ask.title)));
  if (reposAsk && value.ask.title.trim()) {
    ask = { source: 'code', kind: 'repos', title: line(value.ask.title, 300), options: [], placeholder: '' };
  } else if (value.ask && typeof value.ask === 'object' && ASK_KINDS.has(value.ask.kind) && value.ask.kind !== 'repos' && typeof value.ask.title === 'string' && value.ask.title.trim()) {
    const options = (Array.isArray(value.ask.options) ? value.ask.options : []).map(optionOf).filter(Boolean).filter((option, i, all) => all.findIndex((other) => other.label === option.label) === i).slice(0, 10);
    const source = sourceOf(value.ask.source) ? value.ask.source : null;
    const apps = source && Array.isArray(value.ask.apps) ? [...new Set(value.ask.apps.filter((app) => sourceOf(source).apps.includes(app)))] : [];
    if (value.ask.kind === 'open' || options.length) ask = { source, ...(apps.length ? { apps } : {}), kind: value.ask.kind, title: line(value.ask.title, 300), options: value.ask.kind === 'open' ? [] : options, placeholder: value.ask.kind === 'open' ? line(value.ask.placeholder, 120) : '' };
  }
  let authorize = null;
  const a = value.authorize || value.connect; // "connect" was the first build's name for it
  if (!ask && a && typeof a === 'object' && AUTHORIZE_KINDS.has(a.kind) && (APPS[a.app] || a.app === 'GitHub')) {
    const reach = appOf(a.app) ? appOf(a.app).reach : 'signin';
    const fits = a.kind === 'signin' ? SIGNIN_APPS.has(a.app) : a.kind === 'connector' ? reach === 'connector' : a.kind === 'permission' ? reach === 'automation' : reach === 'local';
    if (fits) {
      const label = line(a.label, 60) || (a.kind === 'permission' ? `Allow Engelbart to read ${a.app}` : a.kind === 'folder' ? (a.app === LOCAL_PDFS ? 'Choose a folder of PDFs…' : `Choose your ${a.app} folder…`) : `Sign in to ${a.app}`);
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

/** A workspace's name from words: one line, at most `max` characters, cut at a word when there is one to cut at. */
function workspaceName(text, max = NAME_MAX) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1).lastIndexOf(' ');
  return (cut >= max / 2 ? value.slice(0, cut) : value.slice(0, max)).replace(/[\s,;:.\-–—]+$/, '');
}

/**
 * The suggest agent's reply made safe (2026-10-09, onboarding's Getting started) → [{ name, description, why, items }],
 * at most four, or null when nothing in it can be used. `ids` the library rows it was shown: any other id is dropped.
 */
function readSuggestions(text, ids) {
  const known = ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []);
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(raw.slice(start, end + 1)); } catch { value = null; } }
  const list = value && typeof value === 'object' && Array.isArray(value.workspaces) ? value.workspaces : [];
  const out = [];
  const names = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') continue;
    const name = workspaceName(entry.name);
    if (!name || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    const items = [...new Set((Array.isArray(entry.items) ? entry.items : []).filter((id) => typeof id === 'string' && known.has(id)))].slice(0, SUGGEST_ITEMS);
    out.push({ name, description: line(entry.description, 300), why: line(entry.why, 160), items });
    if (out.length === SUGGEST_MAX) break;
  }
  return out.length ? out : null;
}

/** workspaces.json of a session's folder → { status, suggestions, picked }, or null when there is none. */
function readSuggestFile(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'workspaces.json'), 'utf8'));
    if (!value || typeof value !== 'object') return null;
    const status = ['waiting', 'writing', 'ready', 'none'].includes(value.status) ? value.status : 'none';
    const suggestions = (Array.isArray(value.suggestions) ? value.suggestions : []).filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim()).slice(0, SUGGEST_MAX)
      .map((entry) => ({ name: workspaceName(entry.name), description: line(entry.description, 300), why: line(entry.why, 160), items: (Array.isArray(entry.items) ? entry.items : []).filter((id) => typeof id === 'string').slice(0, SUGGEST_ITEMS) }));
    const picked = (Array.isArray(value.picked) ? value.picked : []).filter((name) => typeof name === 'string').slice(0, 40);
    return { status: status === 'ready' && !suggestions.length ? 'none' : status, suggestions, picked };
  } catch { return null; }
}

function writeSuggestFile(dir, suggest) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ status: suggest.status, suggestions: suggest.suggestions, picked: suggest.picked }, null, 2), { mode: 0o600 });
  } catch { /* shown from memory until the next write */ }
}

/** What the person did, as the librarian is told it. */
function messageOf(input) {
  if (input.skipped) return input.left ? `skipped: ${input.left} is left out for this run; nothing of it comes in` : 'skipped';
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
function createConnect({ agents, models = () => null, ready = () => [...PROVIDERS], context, homeDir, env = process.env, zotero = {}, github = {}, deps = {}, notify = () => {}, openBridge, browser = null, connectors = null, appleNotes = null, webSignIn = null, now = () => new Date().toISOString() }) {
  const sessions = new Map();
  const readyNow = () => { try { return (ready() || []).filter((provider) => PROVIDERS.includes(provider)); } catch { return [...PROVIDERS]; } };
  const choiceFor = (provider) => connectChoice(provider, (() => { try { return models(); } catch { return null; } })());

  const publicJob = (job) => ({ id: job.id, kind: job.kind, source: job.source, label: job.label, apps: job.apps, status: job.status, skipped: !!job.skipped, notes: job.notes, items: job.items, activity: job.activity, summary: job.summary, error: job.error, started: job.started, ended: job.ended });
  const publicNeed = (need) => ({ id: need.id, app: need.app, kind: need.kind, reason: need.reason, jobs: need.jobs.length, opened: need.opened, busy: need.busy, browser: need.browser || '', error: need.error, note: need.note || '', at: need.at });
  function snapshot(s) {
    return {
      id: s.id, mode: s.mode, chat: s.chat, thinking: s.thinking, activity: s.activity, waiting: s.waitingForSurvey, done: s.done, error: s.error, finished: s.finished, stopped: s.stopped, minimized: s.minimized, dismissed: s.dismissed,
      jobs: s.jobs.filter((job) => !HIDDEN.has(job.kind)).map(publicJob), needs: s.needs.filter((need) => !need.closed).map(publicNeed), log: s.log.slice(-SHOWN_LOG),
      provider: s.choice.provider, choice: { provider: s.choice.provider, name: PROVIDER_NAMES[s.choice.provider], modelName: s.choice.modelName, effort: s.choice.effort },
      permissions: s.choices.permissions, projectId: s.projectId, staged: s.projectId ? 0 : notes.stagedCount(s.dir), memory: { ...s.memory }, workspaces: s.suggest ? s.suggest.status : 'none', created: s.created,
      counts: { notes: s.jobs.reduce((n, job) => n + job.notes, 0), items: s.jobs.reduce((n, job) => n + job.items, 0) },
    };
  }
  // What session.json keeps is enough to pick the session up again after Engelbart quits (resume): the chat, the choices,
  // what was found, the jobs with their plans, the librarian's agent session, what the person skipped. Never MEMORY.md's
  // draft before its secrets are out: a session that quit then writes it again.
  function save(s, { force = false } = {}) {
    if (s.suspended && !force) return;
    try {
      fs.mkdirSync(s.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({
        ...snapshot(s), log: s.log, choices: s.choices, picked: s.picked, found: s.found, interviewSession: s.interviewSession, skipped: [...s.skipped], skippedSources: [...s.skippedSources],
        suspended: !!s.suspended, jobs: s.jobs.map((job) => ({ ...publicJob(job), key: job.key, plan: job.plan, titles: job.titles })),
      }, null, 2), { mode: 0o600 });
    } catch { /* the chat goes on */ }
  }
  let emitTimer = null;
  const pending = new Set();
  function emit(s, { soon = false } = {}) {
    if (s.suspended) return; // put away until Engelbart opens this library again: its agents' last words are not news
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
    return s.chat.filter((entry) => !entry.opener).map((entry) => `${entry.role === 'agent' ? 'librarian' : 'person'}: ${entry.text}${entry.ask ? `\n  (asked, ${entry.ask.kind}: ${entry.ask.title}${entry.ask.options.length ? ` — ${entry.ask.options.map((option) => option.label).join(' | ')}` : ''})` : ''}${entry.authorize ? `\n  (offered the button: ${entry.authorize.label})` : ''}`).join('\n');
  }

  function importsText(s) {
    const work = s.jobs.filter((job) => job.kind === 'import' || job.kind === 'survey');
    if (!work.length) return '';
    return JSON.stringify(work.map((job) => ({ kind: job.kind, label: job.label, source: job.source, apps: job.apps, status: job.status, notesAdded: job.notes, itemsAdded: job.items, ...(job.summary && job.kind === 'import' ? { said: job.summary } : {}), ...(job.error ? { error: job.error } : {}) })));
  }

  function engelbartBlock(s) {
    const where = `What comes in is saved in their library: notes, chats and documents as Markdown files in ${path.join(s.dataRoot, 'assets', 'md')}, papers, files and links as library items.`;
    return `<engelbart>\nA person is connecting their library to Engelbart. Their library is at ${s.dataRoot}. ${where}\nPermissions they gave: read files anywhere in their home folder: ${s.choices.permissions.files ? 'yes' : 'no, only the folders of the sources they picked'}; use their accounts in Engelbart's background browser: ${s.choices.permissions.browser ? 'yes' : 'no (web apps are left out)'}; ask their AI assistants what they remember: ${s.choices.permissions.recall ? 'yes' : 'no'}.\n</engelbart>`;
  }

  const surveying = (s) => s.jobs.some((job) => job.kind === 'survey' && !ENDED.has(job.status)) || !!(s.held && s.held.size);

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
    if (s.stopped || s.suspended) return;
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
      if (!s.stopped && !s.suspended && !s.finished && s.waitingForSurvey) {
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
    if (s.thinking || s.stopped || s.suspended || s.finished) return;
    const apps = [...new Set(s.surveyNews.splice(0))];
    if (!apps.length) return;
    void interviewTurn(s, apps.map((app) => messageOf({ survey: app })).join('; '));
  }

  /* --------------------------------------------------------------------------------------------- the priority queue */

  /** A job queued: started when a place is free, the most urgent kind first. The same kind, source and apps go once. */
  function dispatch(s, { kind = 'import', source, apps: given = [], label, plan = '', extra = null }) {
    if (kind === 'import' && s.skippedSources.has(source)) return null; // the person skipped it: nothing of it comes in
    const apps = kind === 'import' && given.length ? given.filter((app) => !s.skipped.has(app)) : given;
    if (given.length && !apps.length) return null;
    const key = `${kind}:${source}:${[...apps].sort().join(',')}`;
    if (s.jobs.some((job) => job.key === key) || s.jobs.length >= MAX_JOBS) return null;
    if (apps.length && apps.every((app) => s.skipped.has(app))) return null; // the person skipped them for this run
    if (kind === 'import' && apps.length && s.jobs.some((job) => job.kind === 'import' && job.source === source && !job.apps.length)) return null; // the whole source went already
    s.seq += 1;
    const job = { id: randomUUID(), key, kind, priority: PRIORITY[kind], seq: s.seq, source, apps, label, plan, extra, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null };
    s.jobs.push(job);
    logAction(s, job, kind === 'survey' ? `Will look through ${apps.join(', ')}` : kind === 'recall' ? `Will ask ${apps.join(', ')} what it remembers` : kind === 'import' ? 'Queued' : 'Queued');
    pump(s);
    return job;
  }

  function pump(s) {
    if (s.stopped || s.suspended) return;
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
    if (kind === 'suggest') return prompts.SUGGEST_SYSTEM_PROMPT;
    return promptOf(s.dataRoot, 'connect-import-system-prompt.md', prompts.IMPORT_SYSTEM_PROMPT);
  }

  async function runJob(s, job) {
    job.status = 'running';
    job.started = now();
    logAction(s, job, job.kind === 'memory' ? 'Writing MEMORY.md' : job.kind === 'redact' ? 'Taking any secrets out of MEMORY.md' : job.kind === 'suggest' ? 'Suggesting workspaces to start with' : 'Started');
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
      const dirs = job.kind === 'memory' ? [s.dir, path.join(s.dataRoot, 'assets', 'md'), ...(s.projectDir ? [s.projectDir] : [])].filter((dir) => fs.existsSync(dir)) : HIDDEN.has(job.kind) ? [] : s.dirs;
      const message = job.kind === 'memory' ? await memoryMessage(s) : job.kind === 'suggest' ? await suggestMessage(s) : job.kind === 'redact' ? `<memory_md>\n${s.memoryDraft}\n</memory_md>` : jobMessage(s, job);
      const out = await agents.turn({ choice, kind: job.kind, system: systemOf(s, job.kind), message, session: null, dirs, signal: controller.signal, bridge: bridge && bridge.connection, connectors: connectorsNow, onUpdate, meta: { kind: job.kind, session: s, job, callTool } });
      if (job.kind === 'survey') surveyed(s, job, out.text);
      else if (job.kind === 'memory') drafted(s, out.text);
      else if (job.kind === 'redact') await finishMemory(s, out.text);
      else if (job.kind === 'suggest') suggested(s, out.text);
      job.summary = job.kind === 'memory' || HIDDEN.has(job.kind) ? '' : line(job.kind === 'survey' ? (readSurvey(out.text).summary || out.text) : out.text, 500);
      job.status = 'done';
      logAction(s, job, job.kind === 'import' ? `Finished: ${job.summary}` : job.kind === 'survey' ? `Looked: ${job.summary}` : job.kind === 'recall' ? (s.recalls[job.apps[0]] ? 'Kept what it remembers' : `Finished: ${job.summary}`) : 'Finished');
    } catch (error) {
      job.status = error && error.kind === 'stopped' ? 'stopped' : 'failed';
      job.error = job.status === 'failed' ? line(error && error.message ? error.message : 'The import failed', 300) : '';
      logAction(s, job, job.status === 'stopped' ? 'Stopped' : `Failed: ${job.error}`);
      if (job.kind === 'survey') surveyed(s, job, null, job.error || 'stopped');
      if (job.kind === 'memory' || job.kind === 'redact') { s.memory = { ...s.memory, status: job.status === 'stopped' ? 'stopped' : 'failed', error: job.error }; }
      if (job.kind === 'suggest' && !s.suspended) setSuggest(s, { status: 'none', suggestions: [] }); // quitting picks it up again (revive)
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
      maybeSuggest(s);
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

  /**
   * The surveys and recalls a session starts with: every web or connector app it may reach, every assistant it may ask.
   * An app in `held` is still signed out (signInsFirst): its survey and recall wait for its sign-in card (releaseHeld).
   */
  function startWork(s, held = new Set()) {
    for (const [source, choice] of Object.entries(s.choices.sources)) {
      if (!choice.on) continue;
      for (const app of choice.apps) {
        const reach = appOf(app) ? appOf(app).reach : null;
        if (reach === 'web') {
          if (!s.choices.permissions.browser) { s.found[source] = { ...(s.found[source] || {}), [app]: { reach, left: 'They did not let the agents use their accounts, so this app is left out.' } }; continue; }
          if (held.has(app)) {
            s.held.set(app, { source, recall: false });
            s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running', signIn: 'waiting: the person was shown a Log in card for it; its survey starts once they sign in' } };
            continue;
          }
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
      for (const app of recallApps((s.choices.sources.chats || {}).on ? s.choices.sources.chats.apps : [])) {
        if (s.held.has(app)) s.held.get(app).recall = true;
        else dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${app} what it remembers` });
      }
    }
  }

  /** A held app's sign-in card answered: done starts its survey and recall; skip leaves it out, and the librarian hears. */
  function releaseHeld(s, app, how) {
    const held = s.held.get(app);
    if (!held) return;
    s.held.delete(app);
    const { [app]: was = {}, ...rest } = s.found[held.source] || {};
    const { signIn: _signIn, ...entry } = was;
    if (how === 'skip' || s.stopped) {
      const left = { reach: entry.reach || 'web', skipped: 'The person skipped this app for this run: leave it out, and do not offer, ask about or hand it over again.' };
      s.found[held.source] = { ...rest, [app]: left };
      s.newFound = { ...(s.newFound || {}), [held.source]: { ...((s.newFound || {})[held.source] || {}), [app]: left } };
      s.surveyNews.push(app);
      if (s.waitingForSurvey && !s.thinking) wake(s);
      return;
    }
    s.found[held.source] = { ...rest, [app]: { ...entry, survey: s.finished ? 'not run: Import was pressed first' : 'running' } };
    if (!s.finished) dispatch(s, { kind: 'survey', source: held.source, apps: [app], label: `Looking through ${app}` });
    if (held.recall) dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${app} what it remembers` });
  }

  /**
   * The ticked web apps' sign-ins, looked at before any survey starts (2026-10-09): each brought over from a browser that
   * holds it, all together, at most SIGN_IN_CHECK_MS. A refusal from macOS, or no answer in time, counts as signed out, and
   * one browser is asked once. → the apps still signed out
   */
  async function signInsFirst(s) {
    const out = new Set();
    if (!webSignIn || !s.choices.permissions.browser) return out;
    const apps = Object.values(s.choices.sources).filter((choice) => choice.on).flatMap((choice) => choice.apps)
      .filter((app) => appOf(app) && appOf(app).reach === 'web' && webSignIn.supports(app));
    if (!apps.length) return out;
    const denied = new Set();
    const results = new Map();
    let timer = null;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, deps.signInCheckMs || SIGN_IN_CHECK_MS); if (timer.unref) timer.unref(); });
    await Promise.race([
      Promise.all(apps.map((app) => webSignIn.signInQuiet(app, { denied }).catch(() => ({ signedIn: false })).then((result) => { results.set(app, result); }))),
      limit,
    ]);
    clearTimeout(timer);
    for (const app of apps) {
      const result = results.get(app);
      if (result && result.signedIn) logAction(s, null, result.browser ? `Signed in to ${app} from ${result.browser}` : `Signed in to ${app} already`);
      else out.add(app);
    }
    return out;
  }

  /** A sign-in card shown before the run asks for it: no agent waits on it; the app's survey does (releaseHeld). */
  function upfrontNeed(s, app) {
    const reason = `Sign in to ${app}`;
    s.needs.push({ id: randomUUID(), app, kind: 'signin', reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', note: noteFor(app, 'signin'), closed: false, upfront: true, at: now() });
    logAction(s, null, `Needs you: ${reason}`);
  }

  /** The line under a sign-in card before macOS is first asked for a browser's sign-ins this run, or ''. */
  function noteFor(app, kind) {
    if (!(kind === 'signin' || kind === 'password') || !webSignIn || !webSignIn.supports(app) || !webSignIn.keychainNote) return '';
    try { return webSignIn.keychainNote(app) || ''; } catch { return ''; }
  }

  /* ------------------------------------------------------------------------------------------------------ needs you */

  /** An agent hands the person a step (a sign-in, a code, a permission): one request per app and kind, then waits for it. */
  function askPerson(s, job, { kind, reason }) {
    const app = job.apps[0] || job.label;
    // Skip holds for the whole run (2026-10-08: "hitting skip should skip it permanently for this run, right now it tries
    // again"): an app the person skipped is never put to them again; the agent hears at once that it was skipped.
    if (s.skipped.has(app)) return Promise.resolve({ status: 'skipped', note: `The person skipped ${app} for this run. Do not ask again: finish without it.` });
    let need = s.needs.find((entry) => !entry.closed && entry.app === app && entry.kind === kind);
    if (!need) {
      need = { id: randomUUID(), app, kind, reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', note: noteFor(app, kind), closed: false, at: now() };
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
    need.outcome = how;
    if (need.cancel) need.cancel(); // a sign-in still waited for in the default browser
    if (how === 'skip' && !s.stopped) skipApp(s, need.app, need.jobs);
    if (need.upfront) releaseHeld(s, need.app, how);
    for (const [jobId, resolve] of need.waiters) { resolve({ status: how === 'skip' ? 'skipped' : 'done' }); if (browser) browser.hide(jobId); }
    need.waiters.clear();
    for (const jobId of need.jobs) if (browser) browser.hide(jobId);
    logAction(s, null, how === 'skip' ? `Skipped: ${need.reason}` : `Done: ${need.reason}`, 'You');
    emit(s);
  }

  /**
   * An app the person skipped, left out for the rest of the run: its other jobs end as skipped (queued ones at once, running
   * ones stopped; those that waited on the card hear "skipped" and finish what they report), no new one is queued
   * (dispatch, Import), and the librarian is told not to offer it again.
   */
  function skipApp(s, app, waiting = []) {
    if (!app || s.skipped.has(app)) return;
    s.skipped.add(app);
    for (const job of s.jobs) {
      if (!job.apps.length || !job.apps.every((each) => s.skipped.has(each)) || waiting.includes(job.id)) continue;
      if (job.status === 'queued') { job.status = 'stopped'; job.skipped = true; job.ended = now(); }
      else if (job.status === 'running' && job.controller) { job.skipped = true; job.controller.abort(); }
    }
    const source = sourceOfApp(app);
    if (source) {
      const note = { ...((s.found[source] || {})[app] || {}), skipped: 'The person skipped this app for this run: leave it out, and do not offer, ask about or hand it over again.' };
      s.found[source] = { ...(s.found[source] || {}), [app]: note };
      s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: note } };
    }
  }

  /**
   * Skip on the librarian's last question or button: nothing of what it was about comes in (2026-10-08: "When I hit skip
   * it should not bring in anything, not just have the agent choose"). A question leaves out the apps it named, else its
   * whole source; a button leaves out its app. → what was left out, in words, or '' when the last turn asked nothing.
   */
  function skipAsked(s) {
    const last = [...s.chat].reverse().find((entry) => entry.role === 'agent');
    if (!last) return '';
    if (last.authorize && last.authorize.app) { skipApp(s, last.authorize.app); return last.authorize.app; }
    const ask = last.ask;
    if (!ask || !ask.source || !sourceOf(ask.source)) return '';
    if (Array.isArray(ask.apps) && ask.apps.length) { for (const app of ask.apps) skipApp(s, app); return ask.apps.join(', '); }
    skipSource(s, ask.source);
    return sourceOf(ask.source).label;
  }

  /**
   * A source the person skipped, left out for the rest of the run: no import of it starts after this (dispatch, Import).
   * What they settled before the question, and the librarian handed over then, goes on.
   */
  function skipSource(s, source) {
    if (s.skippedSources.has(source)) return;
    s.skippedSources.add(source);
    const note = { ...((s.newFound || {})[source] || {}), skipped: 'The person skipped this source for this run: nothing of it comes in. Do not offer, ask about or dispatch it again.' };
    s.found[source] = { ...(s.found[source] || {}), skipped: note.skipped };
    s.newFound = { ...(s.newFound || {}), [source]: note };
    logAction(s, null, `Skipped ${sourceOf(source).label}`, 'You');
  }

  /** A job that ended stops waiting; a request no job waits on any more goes. */
  function releaseNeeds(s, job) {
    for (const need of s.needs) {
      if (need.closed || !need.jobs.includes(job.id)) continue;
      need.waiters.delete(job.id);
      need.jobs = need.jobs.filter((id) => id !== job.id);
      if (!need.jobs.length && !need.upfront) { need.closed = true; if (need.cancel) need.cancel(); }
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
    if (s.stopped || s.suspended || s.memoryQueued || !(s.done || s.finished)) return;
    if (s.jobs.some((job) => WORK.has(job.kind) && !ENDED.has(job.status))) return;
    const worked = s.jobs.some((job) => WORK.has(job.kind) && job.status === 'done') || Object.keys(s.recalls).length;
    if (!worked) { s.memory = { ...s.memory, status: 'skipped' }; maybeSuggest(s); return; }
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
      `<folders note="Where what came in is, as Markdown files (one folder each), to Read when a title is not enough.">${[path.join(s.dataRoot, 'assets', 'md'), path.join(s.dir, 'notes'), s.projectDir].filter(Boolean).join(', ')}</folders>`,
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

  /* ---------------------------------------------------------------------------------------- suggested workspaces */

  // Onboarding's Getting started (2026-10-09): once MEMORY.md is saved and onboarding has made the project, an agent with
  // no tools reads MEMORY.md, the project and the library's rows and suggests three or four workspaces to start in. Kept
  // in <session dir>/workspaces.json { status, suggestions, picked }: waiting (for MEMORY.md or the project), writing,
  // ready, or none (MEMORY.md was skipped or failed, or the reply could not be used: the panel offers "Something else…").

  function setSuggest(s, patch) {
    s.suggest = { ...s.suggest, ...patch };
    if (!s.suspended) writeSuggestFile(s.dir, s.suggest);
    emit(s);
  }

  /** The suggest job, once MEMORY.md is saved in a new user's session whose project exists. */
  function maybeSuggest(s) {
    if (!s.suggest || s.suggestQueued || s.stopped || s.suspended || s.mode !== 'onboarding') return;
    if (s.suggest.status !== 'waiting') return;
    if (['skipped', 'failed', 'stopped'].includes(s.memory.status)) { setSuggest(s, { status: 'none' }); return; }
    if (s.memory.status !== 'saved' || !s.projectId) return;
    s.suggestQueued = true;
    setSuggest(s, { status: 'writing' });
    dispatch(s, { kind: 'suggest', source: 'workspaces', apps: [], label: 'Suggested workspaces' });
  }

  async function suggestMessage(s) {
    const ctx = await context();
    let project = null;
    try { project = require('../store/projects.cjs').findProject(ctx, s.projectId); } catch { project = null; }
    const rows = ((await ctx.libraryDb.list()) || []).filter((row) => row && !(row.tags || []).includes('note')).reverse().slice(0, SUGGEST_ROWS);
    s.suggestIds = new Set(rows.map((row) => row.id));
    const library = rows.map((row) => ({ id: row.id, name: line(row.name, 160), type: row.type, tags: row.tags || [], summary: line(row.summary, 300) }));
    return [
      `<memory_md>\n${clipMiddle(memory.readMemory(s.dataRoot) || '', 30000)}\n</memory_md>`,
      `<project>\n${JSON.stringify({ name: project ? project.name : '', description: project ? project.description || '' : '' })}\n</project>`,
      `<library>\n${JSON.stringify(library, null, 0).replace(/},{/g, '},\n{')}\n</library>`,
      'Suggest the workspaces now.',
    ].join('\n\n');
  }

  function suggested(s, text) {
    const suggestions = readSuggestions(text, s.suggestIds || new Set());
    setSuggest(s, suggestions ? { status: 'ready', suggestions } : { status: 'none', suggestions: [] });
    logAction(s, null, suggestions ? `Suggested ${suggestions.length} workspace${suggestions.length === 1 ? '' : 's'}` : 'Could not suggest workspaces');
  }

  /** The session onboarding made `projectId` with: live, else its folder → { id, dir, live } or null. */
  function sessionOfProject(ctx, projectId) {
    const live = [...sessions.values()].filter((s) => s.dataRoot === ctx.dataRoot && s.projectId === projectId && s.mode === 'onboarding').sort((a, b) => String(b.created).localeCompare(String(a.created)))[0];
    if (live) return { id: live.id, dir: live.dir, live };
    let names = [];
    try { names = fs.readdirSync(path.join(ctx.dataRoot, '.connect')).filter((name) => ID_RE.test(name)); } catch { return null; }
    let best = null;
    for (const id of names) {
      const dir = path.join(ctx.dataRoot, '.connect', id);
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); } catch { continue; }
      if (!saved || saved.projectId !== projectId || saved.mode === 'existing') continue;
      if (!best || String(saved.created).localeCompare(String(best.created)) > 0) best = { id, dir, live: null, created: saved.created };
    }
    return best;
  }

  /** The workspaces suggested for a project onboarding made → { status, suggestions, picked }; { status: 'none' } when none. */
  function workspaces(ctx, projectId) {
    const found = ctx && typeof projectId === 'string' ? sessionOfProject(ctx, projectId) : null;
    if (!found) return { status: 'none', suggestions: [], picked: [] };
    const held = found.live ? found.live.suggest : readSuggestFile(found.dir);
    if (!held) return { status: 'none', suggestions: [], picked: [] };
    return { status: held.status, suggestions: held.suggestions.map((entry) => ({ ...entry, items: [...entry.items] })), picked: [...held.picked] };
  }

  /** A workspace the person started from Getting started: its name is kept, so its card says Started. */
  function pickedWorkspace(ctx, projectId, name) {
    const found = sessionOfProject(ctx, projectId);
    if (!found) return;
    if (found.live) { if (!found.live.suggest.picked.includes(name)) setSuggest(found.live, { picked: [...found.live.suggest.picked, name] }); return; }
    const held = readSuggestFile(found.dir) || { status: 'none', suggestions: [], picked: [] };
    if (!held.picked.includes(name)) writeSuggestFile(found.dir, { ...held, picked: [...held.picked, name] });
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
      skipped: new Set(), skippedSources: new Set(), suspended: false, held: new Map(),
      suggest: { status: projectId ? 'none' : 'waiting', suggestions: [], picked: [] }, suggestQueued: false, suggestIds: null,
    };
    sessions.set(id, s);
    s.dirs = dirsOf(s);
    logAction(s, null, `Started with ${PROVIDER_NAMES[s.choice.provider]} (${s.choice.modelName} · ${s.choice.effort})`);
    emit(s);
    void opening(s);
    return snapshot(s);
  }

  /**
   * A session's opening: a first line at once, the scan of what was picked (said in a sentence, without the model), the
   * web apps' sign-ins looked at, the first surveys and recalls (a signed-out app's wait for its card), the librarian's
   * first turn.
   */
  async function opening(s) {
    let opener = s.chat.find((entry) => entry.opener);
    if (!opener) {
      opener = { role: 'agent', text: 'Looking at what you picked…', ask: null, authorize: null, opener: true, at: now() };
      s.chat.push(opener);
      emit(s);
    }
    try { s.found = await scanFor(s.choices, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null }); } catch (error) { s.found = { error: error.message }; }
    if (s.stopped || s.suspended) return;
    opener.text = foundSentence(s);
    s.dirs = dirsOf(s);
    emit(s);
    const signedOut = await signInsFirst(s);
    if (s.stopped || s.suspended) return;
    startWork(s, signedOut);
    for (const app of signedOut) if (s.held.has(app)) upfrontNeed(s, app);
    emit(s);
    await interviewTurn(s, 'Start.');
  }

  /** What the scan found, in one plain sentence: "Found 2 Obsidian vaults, 36 PDFs in Downloads and your Claude Code chats. Starting with your notes." */
  function foundSentence(s) {
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const parts = [];
    const firstSource = [];
    for (const [source, apps] of Object.entries(s.found || {})) {
      if (!apps || typeof apps !== 'object' || source === 'error') continue;
      const before = parts.length;
      for (const [app, value] of Object.entries(apps)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value.vaults) && value.vaults.length) parts.push(`${plural(value.vaults.length, `${app} vault`)}`);
        else if (Array.isArray(value.folders) && value.folders.length && typeof value.pdfs === 'number') {
          const where = value.folders.slice(0, 2).map((folder) => folder.folder).filter(Boolean);
          parts.push(`${plural(value.pdfs, 'PDF')}${where.length ? ` in ${where.join(' and ')}` : ''}`);
        } else if (typeof value.chats === 'number' && value.chats) parts.push(`your ${app} chats`);
        else if (value.signedIn && typeof value.items === 'number') parts.push(`${plural(value.items, `${app} item`)}`);
        else if (Array.isArray(value.repos) && value.repos.length) parts.push(`${plural(value.repos.length, `${app} repository`, `${app} repositories`)}`);
      }
      if (parts.length > before) firstSource.push(source);
    }
    const ticked = Object.entries(s.choices.sources).filter(([, choice]) => choice.on).map(([source]) => source);
    const startWith = ticked.find((source) => firstSource.includes(source)) || ticked[0];
    const label = startWith && sourceOf(startWith) ? sourceOf(startWith).label.toLowerCase() : '';
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const found = list ? `Found ${list}.` : 'Had a look at what you picked.';
    return label ? `${found} Starting with your ${label}.` : found;
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
    if (clean.skipped) clean.left = skipAsked(s);
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
      if (!choice.on || s.skippedSources.has(source) || sent.some((job) => !job.apps.length)) continue;
      const covered = new Set(sent.flatMap((job) => job.apps));
      const reachable = (app) => {
        const found = ((s.found || {})[source] || {})[app];
        const reach = appOf(app) ? appOf(app).reach : null;
        if (reach === 'web') return s.choices.permissions.browser;
        if (reach === 'connector') return !!(connectors && connectors.status(app).connected);
        if (reach === 'automation') return s.choices.permissions.notes;
        return !(found && found.needs);
      };
      const apps = choice.apps.filter((app) => !covered.has(app) && !s.skipped.has(app) && reachable(app));
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
    // A web app's sign-in: in the person's default browser, where they are likely signed in already, then brought over to
    // Engelbart's (./web-signin.cjs). The window waits on it in the background; done once Engelbart holds the sign-in.
    if ((found.kind === 'signin' || found.kind === 'password') && webSignIn && webSignIn.supports(found.app)) {
      if (found.busy) return snapshot(s);
      const controller = new AbortController();
      found.busy = true;
      found.cancel = () => controller.abort();
      emit(s);
      const opened = (name) => { found.opened = true; found.browser = name; logAction(s, null, `Opened ${found.app}'s sign-in in ${name}`, 'You'); emit(s); };
      webSignIn.signIn(found.app, { signal: controller.signal, onOpened: opened }).catch((error) => ({ status: 'failed', error: error.message })).then((out) => {
        found.busy = false;
        found.cancel = null;
        found.note = noteFor(found.app, found.kind); // macOS has been asked now, or will be by the next browser
        if (out.browser) found.browser = out.browser; // the browser it used, not the default it may have passed over
        if (found.closed || out.status === 'cancelled') return;
        if (out.status === 'signed-in') { logAction(s, null, `Signed in to ${found.app} from ${out.browser}`, 'You'); closeNeed(s, found, 'done'); return; }
        if (out.status === 'unsupported') { showWindow(s, found, `${out.browser}'s sign-ins can't be brought into Engelbart: sign in here instead.`); return; }
        found.error = out.status === 'no-browser' ? `Signing in to ${found.app} needs ${READABLE_NAMES}.`
          : out.status === 'denied' ? `macOS didn't let Engelbart use ${out.browser}'s sign-ins. Log in to ask again, or Skip.`
            : out.status === 'timeout' ? `Still not signed in to ${found.app} in ${out.browser}. Log in to keep waiting, or skip it.` : line(out.error, 200);
        emit(s);
      });
      return snapshot(s);
    }
    showWindow(s, found);
    return snapshot(s);
  }

  /**
   * A code, a captcha, or a sign-in the default browser cannot carry over: the agent's own window, on its page, shown to the
   * person to do it there (the agents' sign-ins are Engelbart's browser's). Closing the window carries on (windowClosed).
   */
  function showWindow(s, found, note = '') {
    const jobId = found.jobs.find((each) => browser && browser.has(each));
    if (!jobId || !browser.show(jobId, { title: `${found.reason} — Engelbart` })) {
      found.error = 'There is no sign-in window to show: sign in to it on the Stage, or skip it.';
      emit(s);
      return;
    }
    found.opened = true;
    found.error = note;
    logAction(s, null, `Opened the window: ${found.reason}`, 'You');
    emit(s);
  }

  /** A step the agents' browser took for a job, into that job's session's action log. */
  function logJob(jobId, text) {
    for (const s of sessions.values()) {
      const job = s.jobs.find((entry) => entry.id === jobId);
      if (job) { logAction(s, job, text); return; }
    }
  }

  /**
   * The person closed a window shown to them: what it was shown for counts as done, but a web app's sign-in only when
   * Engelbart's browser holds it now (2026-10-08: signed in, then asked again), else the card stays with Log in.
   */
  function windowClosed(jobId) {
    for (const s of sessions.values()) {
      const found = s.needs.find((entry) => !entry.closed && entry.jobs.includes(jobId));
      if (!found) continue;
      if (!(webSignIn && webSignIn.supports(found.app))) { closeNeed(s, found, 'done'); continue; }
      webSignIn.signedIn(found.app).catch(() => true).then((yes) => {
        if (found.closed) return;
        if (yes) { closeNeed(s, found, 'done'); return; }
        found.opened = false;
        found.error = `Not signed in to ${found.app} yet.`;
        emit(s);
      });
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
    if (s.suggest && (s.suggest.status === 'waiting' || s.suggest.status === 'writing')) setSuggest(s, { status: 'none' });
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
    if (s.suggest && s.suggest.status === 'none' && !s.suggestQueued && s.mode === 'onboarding') setSuggest(s, { status: 'waiting' }); // MEMORY.md again, then the suggestions
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
    maybeSuggest(s); // MEMORY.md was saved before the project was made
    return written.length;
  }

  /* ------------------------------------------------------------------------------------------ quitting and resuming */

  /**
   * Engelbart quits, or switches to another library: every session still going is saved as it is (`suspended`) and its
   * agents end, to be picked up again by resume when that library is open next. Nothing it did is undone.
   */
  function suspendAll() {
    for (const s of [...sessions.values()]) {
      if (!s.stopped && !s.dismissed) {
        s.suspended = true;
        save(s, { force: true });
        if (s.interviewController) s.interviewController.abort();
        for (const controller of s.controllers) controller.abort();
      }
      sessions.delete(s.id);
      resumed.delete(s.dataRoot);
    }
    if (browser) browser.closeAll();
  }

  const resumed = new Set(); // the data roots whose saved sessions were looked at
  const RESUME_DAYS = 7;

  /** A saved session that was not done when Engelbart closed: not stopped, dismissed or over, and less than a week old. */
  function unfinished(saved) {
    if (!saved || typeof saved !== 'object' || saved.stopped || saved.dismissed) return false;
    const created = Date.parse(saved.created);
    if (!Number.isFinite(created) || Date.now() - created > RESUME_DAYS * 86_400_000) return false;
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    if (!saved.done && !saved.finished) return true;
    if (jobs.some((job) => job && WORK.has(job.kind) && !ENDED.has(job.status))) return true;
    if (saved.mode !== 'existing' && saved.projectId && saved.memory && saved.memory.status === 'saved' && ['waiting', 'writing'].includes(saved.workspaces)) return true; // the suggestions were not written
    return !!(saved.memory && ['waiting', 'writing', 'cleaning'].includes(saved.memory.status));
  }

  /** Paths a saved session kept for an app (a folder chosen, an export), still inside the home folder and still there. */
  function keptPaths(value) {
    const out = {};
    for (const [app, file] of Object.entries(value && typeof value === 'object' ? value : {})) {
      const real = typeof file === 'string' ? readers.expandPath(homeDir, file) : null;
      if (real && real.startsWith(homeDir + path.sep) && fs.existsSync(real) && (APPS[app] || app === 'GitHub')) out[app] = real;
    }
    return out;
  }

  /** What each assistant answered, read back from the session's memories/ folder. */
  function keptRecalls(dir) {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'memories')).filter((name) => name.endsWith('.md')); } catch { return out; }
    for (const name of names) {
      const app = name.slice(0, -3);
      if (!APPS[app]) continue;
      try { out[app] = fs.readFileSync(path.join(dir, 'memories', name), 'utf8').trim(); } catch { /* gone */ }
    }
    return out;
  }

  /** One saved session made live again: its unfinished jobs queued, the librarian asked again if it had not answered. */
  function revive(ctx, id, saved) {
    const dir = path.join(ctx.dataRoot, '.connect', id);
    const usable = readyNow();
    const provider = usable.includes(saved.provider) ? saved.provider : usable[0] || (PROVIDERS.includes(saved.provider) ? saved.provider : 'anthropic');
    let projectId = null, projectDir = null;
    if (typeof saved.projectId === 'string' && ID_RE.test(saved.projectId)) {
      try { const project = require('../store/projects.cjs').findProject(ctx, saved.projectId); projectId = project.id; projectDir = project.dir; } catch { projectId = null; }
    }
    const kept = saved.memory && saved.memory.status === 'saved';
    const s = {
      id, mode: saved.mode === 'existing' && projectId ? 'existing' : 'onboarding', dataRoot: ctx.dataRoot, homeDir, dir, downloads: path.join(ctx.dataRoot, 'imports', id), created: saved.created, choices: cleanChoices(saved.choices, homeDir), choice: choiceFor(provider), redactChoice: null,
      picked: { folders: keptPaths(saved.picked && saved.picked.folders), exports: keptPaths(saved.picked && saved.picked.exports) },
      chat: (Array.isArray(saved.chat) ? saved.chat : []).filter((entry) => entry && (entry.role === 'agent' || entry.role === 'user')), thinking: false, activity: '', done: !!saved.done, finished: !!saved.finished, minimized: true, dismissed: false, error: '',
      jobs: [], seq: 0, needs: [], log: (Array.isArray(saved.log) ? saved.log : []).slice(-MAX_LOG), controllers: new Set(), interviewSession: typeof saved.interviewSession === 'string' ? saved.interviewSession : null, interviewController: null,
      found: saved.found && typeof saved.found === 'object' ? saved.found : {}, newFound: null, toldImports: '', projectId, projectDir, stopped: false,
      waitingForSurvey: !!saved.waiting, surveyNews: [], recalls: keptRecalls(dir), memory: kept ? { ...saved.memory } : { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' }, memoryQueued: kept, memoryDraft: null,
      skipped: new Set((Array.isArray(saved.skipped) ? saved.skipped : []).filter((app) => typeof app === 'string')),
      skippedSources: new Set((Array.isArray(saved.skippedSources) ? saved.skippedSources : []).filter((id) => sourceOf(id))), suspended: false, held: new Map(),
      suggest: null, suggestQueued: false, suggestIds: null,
    };
    // Closed before the librarian's first word, with only the opening line said: the opening again.
    if (s.chat.every((entry) => entry.opener)) s.chat = [];
    const savedSuggest = readSuggestFile(dir);
    s.suggest = savedSuggest ? { ...savedSuggest, status: savedSuggest.status === 'writing' ? 'waiting' : savedSuggest.status } : { status: s.mode === 'onboarding' ? 'waiting' : 'none', suggestions: [], picked: [] };
    for (const job of Array.isArray(saved.jobs) ? saved.jobs : []) {
      if (!job || !Object.hasOwn(PRIORITY, job.kind)) continue;
      // MEMORY.md is written again once the work has ended, unless it was saved: its draft was never kept on disk.
      if ((job.kind === 'memory' || job.kind === 'redact') && !kept) continue;
      if (job.kind === 'suggest') continue; // asked again below (maybeSuggest), when it had not answered
      const again = !ENDED.has(job.status);
      const apps = (Array.isArray(job.apps) ? job.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub'));
      s.seq += 1;
      s.jobs.push({
        id: typeof job.id === 'string' && ID_RE.test(job.id) ? job.id : randomUUID(), key: typeof job.key === 'string' ? job.key : `${job.kind}:${job.source}:${[...apps].sort().join(',')}`,
        kind: job.kind, priority: PRIORITY[job.kind], seq: s.seq, source: String(job.source || ''), apps, label: line(job.label, 120), plan: typeof job.plan === 'string' ? clip(job.plan, 8000) : '', extra: null,
        status: again ? 'queued' : job.status, skipped: !!job.skipped, notes: Number(job.notes) || 0, items: Number(job.items) || 0, titles: (Array.isArray(job.titles) ? job.titles : []).slice(0, 80).map((title) => line(title, 120)),
        activity: '', summary: again ? '' : line(job.summary, 500), error: again ? '' : line(job.error, 300), started: again ? null : job.started || null, ended: again ? null : job.ended || null,
      });
    }
    // A survey that waited on a sign-in card when Engelbart closed (the card is not kept): it runs now, and asks again itself.
    for (const [source, apps] of Object.entries(s.found)) {
      for (const [app, value] of Object.entries(apps && typeof apps === 'object' ? apps : {})) {
        if (!value || !value.signIn || s.skipped.has(app)) continue;
        const { signIn: _signIn, ...entry } = value;
        s.found[source] = { ...s.found[source], [app]: entry };
        if (!s.jobs.some((job) => job.kind === 'survey' && job.apps.includes(app))) {
          s.seq += 1;
          s.jobs.push({ id: randomUUID(), key: `survey:${source}:${app}`, kind: 'survey', priority: PRIORITY.survey, seq: s.seq, source, apps: [app], label: `Looking through ${app}`, plan: '', extra: null, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null });
        }
      }
    }
    sessions.set(id, s);
    s.dirs = dirsOf(s);
    logAction(s, null, 'Picked up again after Engelbart closed');
    emit(s);
    pump(s);
    if (!s.chat.length && !s.jobs.length) {
      // closed before the librarian's first word: the opening again
      s.thinking = true;
      s.activity = 'Looking at what you picked…';
      void opening(s);
    } else if (!s.done && !s.finished) {
      const last = s.chat[s.chat.length - 1];
      if (!last) void interviewTurn(s, 'Start.');
      else if (last.role === 'user') void interviewTurn(s, `${line(last.text, 2000)} (Engelbart closed before you answered this. Answer it now.)`);
      else if (saved.thinking || (s.waitingForSurvey && !surveying(s))) void interviewTurn(s, 'Engelbart closed while you were working, and has opened again. What the surveys found is in <found>. Go on from where you were.');
    }
    maybeMemory(s);
    maybeSuggest(s);
    return s;
  }

  /**
   * "if i close engelbart and it hasnt finish it should auto-resume" (2026-10-08): the sessions of this library that were
   * still going when Engelbart closed (or switched library) start again where they were, in the background: the jobs that
   * were running or queued are queued again (an import skips what came in before), a librarian turn that had not answered
   * is asked again, and MEMORY.md is written once everything has ended. Once per library each time it is opened. → how many
   */
  function resume(ctx) {
    if (!ctx || !ctx.dataRoot || resumed.has(ctx.dataRoot)) return 0;
    resumed.add(ctx.dataRoot);
    let names = [];
    try { names = fs.readdirSync(path.join(ctx.dataRoot, '.connect')).filter((name) => ID_RE.test(name)); } catch { return 0; }
    let n = 0;
    for (const id of names) {
      if (sessions.has(id)) continue;
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', id, 'session.json'), 'utf8')); } catch { continue; }
      if (!unfinished(saved)) continue;
      try { revive(ctx, id, saved); n += 1; } catch { sessions.delete(id); }
    }
    return n;
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
    start, answer, authorize, importNow, need, stop, stopJob, suspendAll, resume, retryMemory, setMinimized, dismiss, attachProject, windowClosed, logJob, list, providers, cancelSignIn, workspaces, pickedWorkspace,
    setProvider: (id, provider) => { const s = get(id); setProvider(s, provider); emit(s); return snapshot(s); },
    // the first build's name for authorize
    connected: (id, input) => authorize(id, input),
    state: (id) => snapshot(get(id)), has: (id) => sessions.has(id),
  };
}

module.exports = { createConnect, cleanChoices, readReply, readSurvey, readSuggestions, workspaceName, messageOf, shownOf, connectChoice, CONNECT_MODELS, PROVIDER_NAMES, PRIORITY, MAX_RUNNING };
