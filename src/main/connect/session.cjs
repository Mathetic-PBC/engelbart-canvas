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
const { SOURCES, APPS, LOCAL_PDFS, sourceOf, appOf, sourceOfApp, recallApps, cleanDays, periodName, shownName, sharesSignIn, signInGroup } = require('../../shared/connect-sources.cjs');
const prompts = require('./prompts.cjs');
const { scanFor } = require('./scan.cjs');
const readers = require('./readers.cjs');
const folderAccess = require('./folder-access.cjs');
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
// A web app's sign-in copied again mid-run (signInAgain): another agent asking within this long of it shares its answer.
const SIGN_IN_AGAIN_SHARED_MS = 30_000;
const SIGN_IN_CHECK_MS = 10_000; // the sign-ins looked at before the surveys start, all together, at most this long
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_KINDS = new Set(['single', 'multi', 'open', 'repos']);
// Which of GitHub's repositories, asked as any choice is: the window shows the GitHub list instead (2026-10-08: "when
// asking me which repositories it should use our existing nice github ui"), whether or not the librarian said "repos".
const REPOS_ASK = /\bwhich\b.*\brepo(?:s|sitory|sitories)?\b/i;
const AUTHORIZE_KINDS = new Set(['signin', 'connector', 'permission', 'folder']);
const SIGNIN_APPS = new Set(['Zotero', 'GitHub']);
const PRIORITY = Object.freeze({ survey: 0, recall: 1, import: 2, memory: 3, redact: 4 });
const WORK = new Set(['survey', 'recall', 'import']);
const ENDED = new Set(['done', 'failed', 'stopped']);
// The apps on this Mac whose folder an agent looks for when the scan did not find it where it usually is (MATH-117).
const FIND_APPS = new Set(['Obsidian', 'Zoom', LOCAL_PDFS]);
const folderName = (app) => (app === LOCAL_PDFS ? 'folders of PDFs' : `${shownName(app)} folder`);
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

// As store/projects.cjs clips them: a project's name to 200 characters, its description to MAX_DESCRIPTION.
const MAX_PROJECT_NAME = 200;
const MAX_DESCRIPTION = 4000;

/** What the project is, as the choose screen sent it ({ name, description }, 2026-10-10) → the same, trimmed, or null. */
function cleanProject(input) {
  if (!input || typeof input !== 'object') return null;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_PROJECT_NAME) : '';
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, MAX_DESCRIPTION) : '';
  return name || description ? { name, description } : null;
}

/**
 * The project the agents are told about: only one with a description (with none, Connect works as it did before
 * 2026-10-10, when it was never told).
 */
const projectFor = (choices) => (choices && choices.project && choices.project.description ? choices.project : null);

/**
 * What MEMORY.md's agent is told came in: the imports (label, how many, titles) and the surveys that finished. Never an
 * email job (2026-10-11): Gmail's threads hold what other people wrote, so neither their subjects nor a survey's account
 * of an inbox goes near the person's memory.
 */
function memoryJobs(s) {
  const appsOf = (job) => (job.apps.length ? job.apps : (((s.choices.sources || {})[job.source] || {}).apps || []));
  const email = (job) => job.source === 'email' || appsOf(job).includes('Gmail');
  const imports = s.jobs.filter((job) => job.kind === 'import' && !email(job)).map((job) => ({ label: job.label, status: job.status, notes: job.notes, items: job.items, said: job.summary || job.error, titles: job.titles.slice(0, 40) }));
  const surveys = s.jobs.filter((job) => job.kind === 'survey' && job.status === 'done' && !email(job)).map((job) => ({ app: job.apps[0], said: job.summary }));
  return { imports, surveys };
}

/**
 * The choose screen's answer made safe → { sources: { id: { on, apps, folders, repos } }, custom, computer, permissions,
 * project }. `project` { name, description } (or null) is what the person is working on; it is kept in session.json with
 * the rest, so a session picked up again after a quit still knows it.
 */
function cleanChoices(input, homeDir, { alsoPicked = [] } = {}) {
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
  // The folders the person chose in the folder picker (MATH-110): macOS lets Engelbart read them even inside a protected
  // folder it was not let to read. Only those among the sources' folders count.
  const chosen = new Set([...Object.values(sources).flatMap((source) => source.folders), ...alsoPicked]);
  const picked = [...new Set((Array.isArray(given.picked) ? given.picked : []).map((dir) => readers.expandPath(homeDir, dir)).filter((dir) => dir && chosen.has(dir)))].slice(0, 40);
  return {
    sources,
    picked,
    custom: typeof given.custom === 'string' ? given.custom.trim().slice(0, 4000) : '',
    computer,
    permissions: { files: computer, browser: allowed.browser !== false, recall: allowed.recall !== false, notes: allowed.notes === true },
    project: cleanProject(given.project),
    days: cleanDays(given.days), // how far back to look (2026-10-10): 182, 365, or null for all time
  };
}

/** The <project> block every agent is given when there is a project with a description, else nothing. */
function projectBlock(choices) {
  const project = projectFor(choices);
  if (!project) return '';
  return `<project note="What the person is working on: the project this library is being connected for.">\n${project.name ? `Name: ${project.name}\n` : ''}Description: ${project.description}\n</project>`;
}

/** The <period> block surveys and imports are given (2026-10-10): how far back the person chose to look. */
function periodBlock(choices) {
  const days = (choices && choices.days) || null;
  return `<period days="${days || 'all'}">${days ? `Only ${periodName(days)}: things changed or written in the last ${days} days. The listing tools hold to it. Older items come in only when <plan> names them (by path for PDFs).` : 'All time: no limit on how far back.'}</period>`;
}

/**
 * What an option covers (2026-10-11), shown in its ⓘ: the real titles with their dates and places. Its line breaks are
 * kept (at most 10 lines, blank ones dropped, spaces in a line folded), up to 600 characters; anything not a string is ''.
 */
function detailOf(value) {
  if (typeof value !== 'string') return '';
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10);
  return clip(lines.join('\n'), 600);
}

/**
 * One option of a question: a label and, when given, a few words of why and what it covers → { label, why, detail } or null.
 * In a "multi" (`multi` true) it also keeps whether the librarian recommends it, `checked` (MATH-122, 2026-10-11), though the
 * card no longer shows it (2026-10-12: no tag, nothing starts ticked). A "single" has no such field.
 */
function optionOf(option, multi = false) {
  const checked = multi ? { checked: !!(option && typeof option === 'object' && option.checked === true) } : {};
  if (option && typeof option === 'object') { const label = line(option.label, 160); return label ? { label, why: line(option.why, 140), detail: detailOf(option.detail), ...checked } : null; }
  const label = line(option, 160);
  return label ? { label, why: '', detail: '', ...checked } : null;
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
    const options = (Array.isArray(value.ask.options) ? value.ask.options : []).map((option) => optionOf(option, value.ask.kind === 'multi')).filter(Boolean).filter((option, i, all) => all.findIndex((other) => other.label === option.label) === i).slice(0, 10);
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
      const label = line(a.label, 60) || (a.kind === 'permission' ? `Allow Engelbart to read ${shownName(a.app)}` : a.kind === 'folder' ? (a.app === LOCAL_PDFS ? 'Choose a folder of PDFs…' : `Choose your ${shownName(a.app)} folder…`) : `Sign in to ${shownName(a.app)}`);
      authorize = { source: sourceOf(a.source) ? a.source : sourceOfApp(a.app), app: a.app, kind: a.kind, label };
    }
  }
  const dispatch = (Array.isArray(value.dispatch) ? value.dispatch : []).filter((entry) => entry && typeof entry === 'object' && sourceOf(entry.source) && on(entry.source) && typeof entry.plan === 'string' && entry.plan.trim())
    .slice(0, 6).map((entry) => ({ source: entry.source, apps: (Array.isArray(entry.apps) ? entry.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub')).slice(0, 8), label: line(entry.label, 80) || sourceOf(entry.source).label, plan: clip(entry.plan, 8000) }));
  return { say: clip(typeof value.say === 'string' ? value.say : '', 2000), ask, authorize, dispatch, waiting: value.waiting === true && !ask && !authorize, done: value.done === true };
}

/**
 * A survey agent's report made safe → { signedIn, summary, total, items: [{ id, label, kind, date, where, why }], notes,
 * folders, searched }. A search for an app's folder (MATH-117) also says "folder" (or, for PDFs, "folders"): only folders
 * inside `homeDir` that are there are kept.
 */
function readSurvey(text, homeDir = null) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(raw.slice(start, end + 1)); } catch { value = null; } }
  if (!value || typeof value !== 'object') return { signedIn: null, summary: line(raw, 600), total: null, items: [], notes: null, folders: [], searched: null };
  const items = (Array.isArray(value.items) ? value.items : []).filter((item) => item && typeof item === 'object' && (item.id || item.label)).slice(0, 40)
    .map((item) => ({ id: line(item.id, 300), label: line(item.label, 160), kind: line(item.kind, 20), date: line(item.date, 20) || null, where: line(item.where, 120) || null, why: line(item.why, 120) || null }));
  const home = homeDir ? path.resolve(homeDir) : null;
  const inHome = (folder) => {
    if (!home || typeof folder !== 'string' || !folder.trim()) return null;
    const full = readers.expandPath(home, folder);
    if (!full || !full.startsWith(home + path.sep)) return null;
    try { return fs.statSync(full).isDirectory() ? full : null; } catch { return null; }
  };
  const folders = [...new Set([value.folder, ...(Array.isArray(value.folders) ? value.folders : [])].map(inHome).filter(Boolean))].slice(0, 12);
  return { signedIn: typeof value.signedIn === 'boolean' ? value.signedIn : null, summary: line(value.summary, 600), total: Number.isFinite(value.total) ? value.total : null, items, notes: value.notes ? line(value.notes, 600) : null, folders, searched: value.searched ? line(value.searched, 300) : null };
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
  if (input.authorized) return input.authorized.kind === 'permission' ? `Allowed ${shownName(input.authorized.app)}` : `Signed in to ${shownName(input.authorized.app)}`;
  if (input.chose) return `${input.chose.shown}`;
  return clip(input.text, 4000);
}

/**
 * `agents` (./agents.cjs or the fake's); `models()` Build's model list (the pinned models' ids); `ready()` the providers
 * whose CLI can run now; `context()` the store's context; `zotero` { status(), root(), download? }; `github` { status(),
 * repos() }; `deps` for the library (describe, identifyRepo, inspectPdf, onAdded, onPdf); `notify(snapshot)` on every
 * change; `openBridge` (../sandbox/local-tools.cjs openToolBridge); `browser` the agents' browser (./browser.cjs, null
 * where there is none); `connectors` (./connectors.cjs); `appleNotes` (./apple-notes.cjs); `platform` whose folder access
 * applies (./folder-access.cjs: macOS's alone).
 */
function createConnect({ agents, models = () => null, ready = () => [...PROVIDERS], context, homeDir, env = process.env, zotero = {}, github = {}, deps = {}, notify = () => {}, placed = () => {}, openBridge, browser = null, connectors = null, appleNotes = null, webSignIn = null, signInWindow = null, now = () => new Date().toISOString(), platform = process.platform }) {
  const sessions = new Map();
  const readyNow = () => { try { return (ready() || []).filter((provider) => PROVIDERS.includes(provider)); } catch { return [...PROVIDERS]; } };
  const choiceFor = (provider) => connectChoice(provider, (() => { try { return models(); } catch { return null; } })());
  // The web apps' sign-ins checked when they were ticked on the choose screen (2026-10-10, signInCheck), kept while Engelbart
  // runs: the browsers macOS refused (not asked again until Try again), each app's last answer { status, browser, browserId },
  // and the checks still waiting on macOS.
  const signInDenied = new Set();
  const signInChecked = new Map();
  const signInChecking = new Map();

  const publicJob = (job) => ({ id: job.id, kind: job.kind, source: job.source, label: job.label, apps: job.apps, status: job.status, skipped: !!job.skipped, notes: job.notes, items: job.items, activity: job.activity, summary: job.summary, error: job.error, started: job.started, ended: job.ended });
  const publicNeed = (need) => ({ id: need.id, app: need.app, kind: need.kind, reason: need.reason, jobs: need.jobs.length, opened: need.opened, busy: need.busy, browser: need.browser || '', error: need.error, note: need.note || '', at: need.at });
  function snapshot(s) {
    return {
      id: s.id, mode: s.mode, chat: s.chat, thinking: s.thinking, activity: s.activity, waiting: s.waitingForSurvey, done: s.done, error: s.error, finished: s.finished, stopped: s.stopped, minimized: s.minimized, dismissed: s.dismissed,
      jobs: s.jobs.filter((job) => job.kind !== 'redact').map(publicJob), needs: s.needs.filter((need) => !need.closed).map(publicNeed), log: s.log.slice(-SHOWN_LOG),
      provider: s.choice.provider, choice: { provider: s.choice.provider, name: PROVIDER_NAMES[s.choice.provider], modelName: s.choice.modelName, effort: s.choice.effort },
      permissions: s.choices.permissions, projectId: s.projectId, staged: s.projectId ? 0 : notes.stagedCount(s.dir), memory: { ...s.memory }, created: s.created,
      counts: { notes: s.jobs.reduce((n, job) => n + job.notes, 0), items: s.jobs.reduce((n, job) => n + job.items, 0) },
      placed: { project: s.inProject.size, workspace: s.inWorkspace.size },
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
        suspended: !!s.suspended, gmailThreads: s.gmailThreads || 0, rows: [...s.rows], inProject: [...s.inProject], inWorkspace: [...s.inWorkspace], workspaceId: s.workspaceId, jobs: s.jobs.map((job) => ({ ...publicJob(job), key: job.key, plan: job.plan, titles: job.titles, ...(job.find ? { find: true } : {}) })),
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

  /**
   * What macOS let Engelbart read of its protected folders (MATH-110, ./folder-access.cjs): those allowed on the choose
   * screen, the folders the person picked themselves, and the places of the apps they ticked that Engelbart knows from the
   * app itself (Obsidian's vaults, ~/Documents/Zoom), which the choose screen does not ask about: read as before.
   */
  function accessOf(s) {
    const on = (app) => Object.values(s.choices.sources).some((choice) => choice.on && choice.apps.includes(app));
    const places = [
      ...(on('Obsidian') || (s.choices.sources.sites && s.choices.sources.sites.on) ? readers.obsidianVaults(homeDir).map((vault) => vault.path) : []),
      ...(on('Zoom') ? [path.join(homeDir, 'Documents', 'Zoom')] : []),
    ];
    return folderAccess.guard({ homeDir, dataRoot: s.dataRoot, picked: [...(s.choices.picked || []), ...places], platform });
  }

  /**
   * The folders the agents' file tools may read: what the sources need, or the whole home folder when allowed. A folder
   * inside a protected one macOS did not let Engelbart read is not given (MATH-110); the home folder still is, the find
   * search being told to keep out of those (findMessage) and the file tools refusing them (./tools.cjs).
   */
  function dirsOf(s) {
    const dirs = new Set();
    const access = accessOf(s);
    const grant = (dir) => { if (dir && fs.existsSync(dir)) dirs.add(path.resolve(dir)); };
    const add = (dir) => { if (dir && access.readable(dir)) grant(dir); };
    if (s.choices.computer) grant(homeDir);
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
    grant(s.downloads);
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
      projectBlock(s.choices),
      `<choices>\n${JSON.stringify({ ...s.choices.sources, customInstructionsForThisImport: s.choices.custom || null, permissions: s.choices.permissions, period: periodName(s.choices.days), days: s.choices.days || null }, null, 1)}\n</choices>`,
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
  function dispatch(s, { kind = 'import', source, apps: given = [], label, plan = '', extra = null, find = false }) {
    if (kind === 'import' && s.skippedSources.has(source)) return null; // the person skipped it: nothing of it comes in
    const apps = kind === 'import' && given.length ? given.filter((app) => !s.skipped.has(app)) : given;
    if (given.length && !apps.length) return null;
    const key = `${find ? 'find' : kind}:${source}:${[...apps].sort().join(',')}`;
    if (s.jobs.some((job) => job.key === key) || s.jobs.length >= MAX_JOBS) return null;
    if (apps.length && apps.every((app) => s.skipped.has(app))) return null; // the person skipped them for this run
    if (kind === 'import' && apps.length && s.jobs.some((job) => job.kind === 'import' && job.source === source && !job.apps.length)) return null; // the whole source went already
    s.seq += 1;
    const job = { id: randomUUID(), key, kind, priority: PRIORITY[kind], seq: s.seq, source, apps, label, plan, extra, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null, ...(find ? { find: true } : {}) };
    s.jobs.push(job);
    logAction(s, job, find ? `Will look for your ${folderName(apps[0])}` : kind === 'survey' ? `Will look through ${apps.map(shownName).join(', ')}` : kind === 'recall' ? `Will ask ${apps.map(shownName).join(', ')} what it remembers` : kind === 'import' ? 'Queued' : 'Queued');
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
    const period = periodBlock(s.choices);
    if (job.kind === 'survey' && job.find) return findMessage(s, job);
    if (job.kind === 'survey') {
      return [engelbartBlock(s), projectBlock(s.choices), period, `<source>${job.source}</source>`, `<app>${apps[0]}</app>`, skillsFor({ source: job.source, apps }, s.dataRoot), `<found>\n${JSON.stringify(found[apps[0]] || {}, null, 1)}\n</found>`, `Look at what they have in ${apps[0]} now, and report.`].filter(Boolean).join('\n\n');
    }
    if (job.kind === 'recall') {
      return [engelbartBlock(s), `<app>${apps[0]}</app>`, skillsFor({ source: job.source, apps }, s.dataRoot), `<prompt>\n${prompts.RECALL_PROMPT}\n</prompt>`, `Ask ${apps[0]} now, and save its answer with save_memory.`].join('\n\n');
    }
    return [
      engelbartBlock(s),
      projectBlock(s.choices),
      `<source>${JSON.stringify({ source: job.source, apps, label: job.label, foldersPicked: choice.folders || [], repositoriesPicked: choice.repos || [], foldersChosen: s.picked.folders, downloadsGoTo: s.downloads })}</source>`,
      period,
      `<plan>\n${job.plan}\n</plan>`,
      `<chat>\n${clipMiddle(conversationText(s), 30000)}\n</chat>`,
      `<found>\n${clipMiddle(JSON.stringify(found, null, 1), 40000)}\n</found>`,
      skillsFor({ source: job.source, apps }, s.dataRoot),
      s.choices.custom ? `<import_instructions note="What the person typed on the choose screen for this import.">\n${s.choices.custom}\n</import_instructions>` : '',
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      'Do the import now.',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * A search for an app's folder the scan did not find where it usually is (MATH-117): what to look for, and how. Its reply
   * is a survey's, with "folder" (or "folders") and "searched".
   */
  function findMessage(s, job) {
    const app = job.apps[0];
    // MATH-110: the protected folders macOS did not let Engelbart read are kept out of the search, so it never asks
    // mid-run; ~/Pictures, ~/Music and ~/Movies too (their own prompts). `allowed` are the ones it may look in. Off the Mac
    // nothing is protected (./folder-access.cjs): every folder of the home folder may be looked in but Windows' AppData.
    const mac = folderAccess.guards(platform);
    const access = accessOf(s);
    const shown = (dir) => readers.shownPath(homeDir, dir);
    const allowed = access.allowed.map((folder) => `${folder.name} (${shown(folder.path)})`);
    const allowedTop = new Set(access.allowed.map((folder) => folder.id));
    const skipped = mac ? ['Desktop', 'Documents', 'Downloads', 'Library', 'Pictures', 'Music', 'Movies'].filter((name) => !allowedTop.has(name)) : ['AppData'];
    const insideLibrary = access.allowed.filter((folder) => folder.id.startsWith(`Library${path.sep}`)).map((folder) => shown(folder.path));
    const tops = (() => { try { return fs.readdirSync(homeDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skipped.includes(entry.name)).map((entry) => `~/${entry.name}`).sort().slice(0, 60); } catch { return []; } })();
    const lookIn = [...tops, ...insideLibrary];
    const usual = [fs.existsSync(path.join(homeDir, 'Dropbox')) ? '~/Dropbox' : '', ...allowed].filter(Boolean);
    const what = {
      Zoom: `Find their folder of Zoom recordings. Zoom keeps each meeting in a folder named by its date and topic ("2026-03-04 10.00.00 Lab meeting"), holding its transcript (a .vtt or .txt file), audio and video. People move that folder, or point Zoom's recording setting elsewhere${usual.length ? `: look under ${usual.join(', ')} first` : ''}. "folder" is the folder that holds the meeting folders. When there is none on this Mac, say so in "notes": the cloud recordings at zoom.us/recording are what an import agent reads instead.`,
      Obsidian: 'Find their Obsidian vault: a folder holding a .obsidian folder (Glob for **/.obsidian inside each folder you may look in, one at a time). When there are several, "folder" is the one they most likely work in: the most notes, changed most recently.',
      [LOCAL_PDFS]: 'Find the folders that hold their PDFs, papers mostly: use folder_overview and list_pdfs on the folders Glob finds them in. "folders" lists them, the most PDFs first, at most 6.',
    }[app] || `Find their ${shownName(app)} folder.`;
    const reply = app === LOCAL_PDFS ? '"folders": ["<absolute path>", ...] (empty when you found none)' : '"folder": "<absolute path, or null when you found none>"';
    return [
      engelbartBlock(s), projectBlock(s.choices), `<source>${job.source}</source>`, `<app>${app}</app>`,
      `Engelbart did not find ${app === LOCAL_PDFS ? 'any folder of PDFs' : `their ${shownName(app)} folder`} where it usually is. ${what}`,
      mac
        ? `Look with Glob, Grep and Read, inside their home folder (${homeDir}) only. Never look in ${skipped.map((name) => `~/${name}`).join(', ')}${insideLibrary.length ? ` (${insideLibrary.join(' and ')} aside)` : ''}: macOS has not let Engelbart read ${skipped.length > 1 ? 'them' : 'it'}, and looking there makes it stop the person with a prompt. Skip hidden folders too (a vault's .obsidian aside). Never Glob from the home folder itself (a pattern like ${homeDir}/**/x walks into the folders to skip): Glob inside each folder you may look in instead.`
        : `Look with Glob, Grep and Read, inside their home folder (${homeDir}) only. Skip hidden folders (a vault's .obsidian aside) and ~/AppData. Never Glob from the home folder itself (a pattern like ${homeDir}/**/x walks into every folder at once): Glob inside each folder you may look in instead.`,
      mac ? `<folders_allowed note="Protected folders macOS let Engelbart read">${allowed.length ? allowed.join(', ') : 'none'}</folders_allowed>` : '',
      `<look_in note="The folders of their home folder you may look in">${lookIn.length ? lookIn.join(', ') : 'none'}</look_in>`,
      'Spend a few minutes at most. Never call needs_you to ask them for a folder: when you find nothing, say so, and they are offered a button to choose one.',
      `Reply with the survey's JSON object, with two more fields: ${reply}, and "searched": "<where you looked, in a few words>".`,
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
      // what macOS let Engelbart read of its protected folders (MATH-110): the file tools keep out of the rest
      readable: (dir) => accessOf(s).readable(dir),
      // the apps the job covers and its source group, for what each row it brings in knows about itself (Library Phase B)
      apps: covered, group: job.source,
      get exports() { return s.picked.exports; },
      get folders() { return s.picked.folders; },
      get days() { return s.choices.days || null; }, // the period picked (2026-10-10): the listing tools hold to it
      // The Gmail threads this session brought in (2026-10-11), held to import_gmail_threads' cap across its jobs.
      get gmailThreads() { return s.gmailThreads || 0; },
      set gmailThreads(n) { s.gmailThreads = Math.max(0, Number(n) || 0); save(s); },
    };
    const callTool = bridged ? createImportTools({
      session, context, zotero, github, deps, env, kind: job.kind, page, appleNotes,
      needs: { ask: (request) => askPerson(s, job, request), wait: () => waitAgain(s, job) },
      recall: (app, text) => keepRecall(s, app, text),
      // the chat the memory question opened (2026-10-12), deleted by the tools once its answer is kept
      asked: (app, id) => { job.asked = { app, id }; }, question: prompts.RECALL_PROMPT,
      kept: (row) => keepRow(s, row),
      log: (text) => logAction(s, job, text),
      added: (kind, n, title) => { job[kind === 'notes' ? 'notes' : 'items'] += n; if (title && job.titles.length < 80) job.titles.push(String(title).slice(0, 120)); emit(s, { soon: true }); },
    }) : null;
    let bridge = null;
    try {
      const onUpdate = ({ activity }) => { if (activity && activity !== job.activity) { job.activity = activity; emit(s, { soon: true }); } };
      const connectorsNow = bridged && connectors ? await connectors.serversFor(covered).catch(() => []) : [];
      if (bridged) bridge = await openBridge(callTool, { signal: controller.signal, maxBody: 1_000_000 });
      const choice = job.kind === 'redact' ? s.redactChoice || s.choice : s.choice;
      const dirs = job.kind === 'memory' ? [s.dir, path.join(s.dataRoot, 'assets', 'md'), ...(s.projectDir ? [s.projectDir] : [])].filter((dir) => fs.existsSync(dir)) : job.kind === 'redact' ? [] : s.dirs;
      const message = job.kind === 'memory' ? await memoryMessage(s) : job.kind === 'redact' ? `<memory_md>\n${s.memoryDraft}\n</memory_md>` : jobMessage(s, job);
      const out = await agents.turn({ choice, kind: job.kind, system: systemOf(s, job.kind), message, session: null, dirs, signal: controller.signal, bridge: bridge && bridge.connection, connectors: connectorsNow, onUpdate, meta: { kind: job.kind, session: s, job, callTool } });
      if (job.kind === 'survey') await surveyed(s, job, out.text);
      else if (job.kind === 'memory') drafted(s, out.text);
      else if (job.kind === 'redact') await finishMemory(s, out.text);
      job.summary = job.kind === 'memory' || job.kind === 'redact' ? '' : line(job.kind === 'survey' ? (readSurvey(out.text).summary || out.text) : out.text, 500);
      job.status = 'done';
      logAction(s, job, job.kind === 'import' ? `Finished: ${job.summary}` : job.kind === 'survey' ? `${job.find ? 'Looked for it' : 'Looked'}: ${job.summary}` : job.kind === 'recall' ? (s.recalls[job.apps[0]] ? 'Kept what it remembers' : `Finished: ${job.summary}`) : 'Finished');
    } catch (error) {
      job.status = error && error.kind === 'stopped' ? 'stopped' : 'failed';
      job.error = job.status === 'failed' ? line(error && error.message ? error.message : 'The import failed', 300) : '';
      logAction(s, job, job.status === 'stopped' ? 'Stopped' : `Failed: ${job.error}`);
      if (job.kind === 'survey') await surveyed(s, job, null, job.error || 'stopped');
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
  async function surveyed(s, job, text, error = '') {
    if (job.find) return lookedFor(s, job, text, error);
    const app = job.apps[0];
    const report = text != null ? readSurvey(text) : { error: error || 'The survey did not finish' };
    s.found[job.source] = { ...(s.found[job.source] || {}), [app]: { ...((s.found[job.source] || {})[app] || {}), survey: report } };
    s.newFound = { ...(s.newFound || {}), [job.source]: { ...((s.newFound || {})[job.source] || {}), [app]: s.found[job.source][app] } };
    s.surveyNews.push(app);
    if (s.waitingForSurvey && !s.thinking) wake(s);
  }

  /**
   * The search for an app's folder ended (MATH-117). A folder found is the app's, as if the person had chosen it: the scan
   * reads it again, so the librarian gets its at-a-glance. None found: the app needs its folder, with where the agent
   * looked, and the librarian offers the button. A search stopped by Engelbart quitting runs again when it resumes.
   */
  async function lookedFor(s, job, text, error) {
    const app = job.apps[0], source = job.source;
    if (text == null && (s.suspended || s.stopped)) return;
    const report = text != null ? readSurvey(text, homeDir) : { folders: [], searched: null, notes: null, error: error || 'The search did not finish' };
    // A folder inside a protected one macOS did not let Engelbart read is not taken (MATH-110).
    const access = accessOf(s);
    report.folders = report.folders.filter((dir) => access.readable(dir));
    const reach = appOf(app) ? appOf(app).reach : 'local';
    const put = (entry) => {
      s.found[source] = { ...(s.found[source] || {}), [app]: entry };
      s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: entry } };
    };
    const missing = () => put({ reach, needs: 'folder', searched: report.searched || report.notes || (report.error ? `the search failed: ${report.error}` : 'their home folder'), ...(app === 'Zoom' ? { cloud: 'Cloud recordings can be read at zoom.us in Engelbart\'s browser.' } : {}) });
    const [folder, ...more] = report.folders;
    if (folder) {
      s.picked.folders[app] = folder;
      const choice = s.choices.sources[source];
      if (app === LOCAL_PDFS && choice && more.length) choice.folders = [...new Set([...(choice.folders || []), ...more])].slice(0, 12);
      logAction(s, job, `Found your ${folderName(app)} at ${[folder, ...more].slice(0, 3).map((one) => readers.shownPath(homeDir, one)).join(', ')}`);
      put({ reach }); // no survey: the scan's at-a-glance takes its place
      try { await rescan(s, [source]); } catch { missing(); }
    } else missing();
    s.dirs = dirsOf(s);
    s.surveyNews.push(app);
    save(s);
    if (s.waitingForSurvey && !s.thinking) wake(s);
  }

  /**
   * An app on this Mac whose folder the scan did not find, looked for by an agent before the person is asked to choose it
   * (MATH-117): only when they let the agents read the files on this Mac, once a session for each app.
   */
  function lookForFolders(s) {
    if (!s.choices.computer || s.stopped || s.suspended || s.finished) return;
    for (const [source, apps] of Object.entries(s.found || {})) {
      const choice = s.choices.sources[source];
      if (!choice || !choice.on || !apps || typeof apps !== 'object') continue;
      for (const [app, value] of Object.entries(apps)) {
        if (!value || value.needs !== 'folder' || !FIND_APPS.has(app) || !choice.apps.includes(app) || s.skipped.has(app) || s.picked.folders[app]) continue;
        if (s.jobs.some((job) => job.find && job.apps.includes(app))) continue; // looked for once already
        const entry = { reach: value.reach || 'local', survey: 'running', looking: 'for its folder' };
        s.found[source] = { ...s.found[source], [app]: entry };
        const job = dispatch(s, { kind: 'survey', find: true, source, apps: [app], label: `Looking for your ${folderName(app)}` });
        if (!job) { s.found[source] = { ...s.found[source], [app]: value }; continue; }
        s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: entry } };
      }
    }
  }

  /**
   * The surveys and recalls a session starts with: every web or connector app it may reach, every assistant it may ask.
   * An app in `held` is still signed out or refused (signInsFirst): its survey and recall are held, then left out (releaseHeld).
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
            s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running', signIn: 'waiting: not signed in yet' } };
            continue;
          }
          s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running' } };
          dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` });
        } else if (reach === 'connector') {
          const connected = connectors ? connectors.status(app).connected : false;
          s.found[source] = { ...(s.found[source] || {}), [app]: connected ? { reach, survey: 'running' } : { reach, needs: 'connector' } };
          if (connected) dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` });
        }
      }
    }
    if (s.choices.permissions.recall && s.choices.permissions.browser) {
      for (const app of recallApps((s.choices.sources.chats || {}).on ? s.choices.sources.chats.apps : [])) {
        if (s.held.has(app)) s.held.get(app).recall = true;
        else dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${shownName(app)} what it remembers` });
      }
    }
  }

  /** A held app's sign-in settled: done starts its survey and recall; skip leaves it out, and the librarian hears. */
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
    if (!s.finished) dispatch(s, { kind: 'survey', source: held.source, apps: [app], label: `Looking through ${shownName(app)}` });
    if (held.recall) dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${shownName(app)} what it remembers` });
  }

  /**
   * A sign-in check's answer (webSignIn.signInQuiet) as the choose screen shows it → { status, browser, browserId, profile?,
   * unchecked? }: `profile` the browser profile it came from when that browser has several, `unchecked` when the site's
   * check page gave no answer (counted as signed in, 2026-10-12).
   */
  function checkedAs(app, result) {
    const was = signInChecked.get(app);
    if (result && result.signedIn) {
      const kept = !result.browser && was && was.status === 'signed-in' ? was : null;
      const profile = result.browser ? result.profile || '' : (kept && kept.profile) || '';
      return { status: 'signed-in', browser: result.browser || (kept ? kept.browser : ''), browserId: '', ...(profile ? { profile } : {}), ...(result.unchecked ? { unchecked: true } : {}) };
    }
    if (result && result.refused) return { status: 'refused', browser: result.refused, browserId: result.refusedId || '' };
    if (result && result.noBrowser) return { status: 'no-browser', browser: '', browserId: '' };
    return { status: 'signed-out', browser: '', browserId: '' };
  }

  /**
   * What to tell the person before a ticked web app's check asks macOS for a browser's sign-ins → { browser, note }; note ''
   * when macOS will not be asked (held already, no browser holding it, Firefox, asked once already, or a browser it
   * refused). Only a browser holding the app's sign-in is named (2026-10-11): the check opens no sign-in page, so where one
   * would open (the Log in card's note, noteFor) is never promised here.
   */
  async function signInNote(app, { route = '' } = {}) {
    if (!webSignIn || !webSignIn.supports(app) || !webSignIn.keychainTarget) return { browser: '', note: '', profiles: [], opens: '' };
    // Google's Sign in (2026-10-12) opens its page in the person's browser: the browser it opens in is the one named.
    const browserRoute = route === 'browser';
    const opens = browserRoute && webSignIn.opensIn ? webSignIn.opensIn(app) : '';
    if (!browserRoute && await webSignIn.signedIn(app).catch(() => false)) return { browser: '', note: '', profiles: [], opens };
    const profiles = profilesToAsk(app);
    let target = null;
    try { target = webSignIn.keychainTarget(app, { holdersOnly: !browserRoute }); } catch { target = null; }
    const browser = target ? target.name : profiles.length ? profiles[0].browser : '';
    if (!target || signInDenied.has(target.id)) return { browser, note: '', profiles, opens };
    return { browser: target.name, note: webSignIn.keychainNote(app, { holdersOnly: !browserRoute }) || '', profiles, opens };
  }

  /**
   * The profiles to ask the person to pick from for an app's sign-in (2026-10-12) → [{ browserId, browser, profileId, name,
   * email, keychain }]: every one holding it, when more than one does and none was picked before (or the one picked no
   * longer holds it); else none, and no question.
   */
  function profilesToAsk(app) {
    if (!webSignIn || !webSignIn.holdersOf) return [];
    let list = [];
    try { list = webSignIn.holdersOf(app) || []; } catch { list = []; }
    list = list.filter((profile) => !signInDenied.has(profile.browserId));
    if (list.length < 2) return [];
    const pick = webSignIn.picked ? webSignIn.picked(app) : null;
    if (pick && list.some((profile) => profile.browserId === pick.browser && profile.profileId === pick.profile)) return [];
    return list;
  }

  /** The profile picked for an app's sign-in ({ browser, profile }, ids), remembered for every app sharing it. */
  function signInPick(app, pick) {
    if (!webSignIn || !webSignIn.choose || !webSignIn.supports(app)) return false;
    return webSignIn.choose(app, pick);
  }

  /**
   * A web app ticked on the choose screen: its sign-in brought over from a browser holding it, however long macOS's prompt
   * waits for the person (2026-10-10: they were told it would ask). → { status: 'signed-in'|'refused'|'signed-out'|
   * 'no-browser', browser } (status '' for an app whose sign-in can't be checked), kept for the run's signInsFirst. `retry` (Try again) asks macOS again about the browser that
   * refused it. Off the Mac (2026-10-12), nothing is copied: whether Engelbart's own session holds the sign-in, signed in or
   * signed out.
   */
  function signInCheck(app, { retry = false } = {}) {
    if (!webSignIn || !signsInAtAll(app)) return Promise.resolve({ status: '', browser: '' }); // not one it can check
    if (signInChecking.has(app)) return signInChecking.get(app);
    if (retry) { const was = signInChecked.get(app); if (was && was.browserId) signInDenied.delete(was.browserId); }
    const checking = webSignIn.signInQuiet(app, { denied: signInDenied }).catch(() => ({ signedIn: false, browser: '' })).then((result) => {
      const out = checkedAs(app, result);
      signInChecked.set(app, out);
      signInChecking.delete(app);
      return { status: out.status, browser: out.browser, ...(out.profile ? { profile: out.profile } : {}) };
    });
    signInChecking.set(app, checking);
    return checking;
  }

  /**
   * "Sign in" on the choose screen (2026-10-11): the app's sign-in page in Engelbart's own browser (./signin-window.cjs), for
   * an app no browser of the person's could sign in, one whose browser sign-ins they turned down, and every app off the Mac
   * (2026-10-12). → { status: 'signed-in' | 'rejected' | 'closed' }. Signed in, it is kept as signed in for every app sharing
   * that sign-in (Google Drive, Gmail, Google Meet and Gemini are one), so the run counts them all, and never copied over
   * from a browser again this run; a wait for it in the person's browser ends. 'rejected': Google turned it away (the window
   * cleared what Google left, so Try again can work).
   */
  async function signInWindowOpen(app) {
    if (!signInWindow || !webSignIn || !signsInAtAll(app)) return { status: 'closed' };
    const out = await signInWindow.open(app).catch(() => ({ status: 'closed' }));
    if (out && out.status === 'signed-in') {
      if (typeof webSignIn.signedInHere === 'function') webSignIn.signedInHere(app);
      for (const other of sharesSignIn(app)) signInChecked.set(other, { status: 'signed-in', browser: '', browserId: '' });
      signInBrowserCancel(app);
      return { status: 'signed-in' };
    }
    if (out && out.status === 'rejected') return { status: 'rejected' };
    return { status: 'closed' };
  }

  /** Whether `app`'s sign-in can be made at all: in Engelbart's window, wherever it runs (webSignIn.canSignIn). */
  function signsInAtAll(app) {
    if (!webSignIn) return false;
    return typeof webSignIn.canSignIn === 'function' ? webSignIn.canSignIn(app) : webSignIn.supports(app);
  }

  // Google's Sign in on the choose screen, waited for in the person's browser (2026-10-12): one wait per sign-in (every
  // Google app shares it), with the controller that ends it.
  const browserWaits = new Map();

  /**
   * "Sign in" for an app whose sign-in goes through the person's browser (signsInThroughBrowser: Google's, which refuses
   * Engelbart's window, 2026-10-12): its sign-in page opened in their default browser (Chrome when that is Safari), then
   * waited for with no time limit until it comes over, or until signInBrowserCancel (the row unticked, Leave out, the choose
   * screen gone). → { status: 'signed-in', browser, profile? } | { status: 'refused', browser } | { status: 'no-browser' } |
   * { status: 'cancelled' }. Signed in, every app sharing the sign-in is kept as signed in. "Sign in here instead" ends it
   * (signInBrowserCancel) for Engelbart's window (signInWindowOpen).
   */
  function signInBrowser(app) {
    if (!webSignIn || !webSignIn.supports(app)) return Promise.resolve({ status: 'no-browser' });
    const key = signInGroup(app);
    if (browserWaits.has(key)) return browserWaits.get(key).done;
    const controller = new AbortController();
    const done = webSignIn.signIn(app, { signal: controller.signal, timeoutMs: Infinity, denied: signInDenied }).catch(() => ({ status: 'cancelled' })).then((out) => {
      browserWaits.delete(key);
      if (out.status === 'signed-in') {
        const kept = { status: 'signed-in', browser: out.browser || '', browserId: '', ...(out.profile ? { profile: out.profile } : {}) };
        for (const other of sharesSignIn(app)) signInChecked.set(other, kept);
        return { status: 'signed-in', browser: kept.browser, ...(out.profile ? { profile: out.profile } : {}) };
      }
      if (out.status === 'denied') {
        if (out.browserId) signInDenied.add(out.browserId);
        for (const other of sharesSignIn(app)) signInChecked.set(other, { status: 'refused', browser: out.browser, browserId: out.browserId || '' });
        return { status: 'refused', browser: out.browser };
      }
      if (out.status === 'no-browser') return { status: 'no-browser' };
      return { status: 'cancelled' };
    });
    browserWaits.set(key, { controller, done });
    return done;
  }

  /**
   * Continue on the Keychain panel for a sign-in through the person's browser (2026-10-12): macOS asked for that browser's
   * sign-ins now, before its page opens, copying nothing (webSignIn.unlock; the key is kept for the run, so the copy when
   * the sign-in shows up asks nothing). → { status: 'allowed', browser } | { status: 'refused', browser }: refused, every
   * app sharing the sign-in is refused (Try again asks again), and nothing is opened.
   */
  async function signInUnlock(app) {
    if (!webSignIn || !webSignIn.supports(app) || typeof webSignIn.unlock !== 'function') return { status: 'allowed', browser: '' };
    const out = await webSignIn.unlock(app, { denied: signInDenied }).catch(() => ({ status: 'allowed', browser: '' }));
    if (out.status === 'denied') {
      if (out.browserId) signInDenied.add(out.browserId);
      for (const other of sharesSignIn(app)) signInChecked.set(other, { status: 'refused', browser: out.browser, browserId: out.browserId || '' });
      return { status: 'refused', browser: out.browser };
    }
    return { status: 'allowed', browser: out.browser || '' };
  }

  /** "Use another account" on a Google row waiting on the browser: Google's add-an-account page there; the wait goes on. */
  async function signInAnotherAccount(app) {
    if (!webSignIn || typeof webSignIn.anotherAccount !== 'function' || !browserWaits.has(signInGroup(app))) return { opened: false, browser: '' };
    return webSignIn.anotherAccount(app).catch(() => ({ opened: false, browser: '' }));
  }

  /** Ends the wait for `app`'s sign-in in the person's browser (any app sharing it), or every wait when `app` is ''. */
  function signInBrowserCancel(app = '') {
    for (const [key, wait] of browserWaits) if (!app || key === signInGroup(app)) wait.controller.abort();
    return true;
  }

  /** Closes the sign-in window, if one is open (Leave out, or the choose screen gone). */
  function signInWindowClose() {
    if (signInWindow) signInWindow.close();
    return true;
  }

  /**
   * The ticked web apps' sign-ins, looked at before any survey starts (2026-10-09). One checked when it was ticked keeps
   * that answer (a check still waiting on macOS is waited for); any other is brought over from a browser that holds it, all
   * together, at most SIGN_IN_CHECK_MS. One with no answer by then is still checking (2026-10-12), not signed out: its
   * answer, when it comes, is lateSignIn's. A browser macOS refused is not asked again.
   * → { signedOut: Set, refused: Map(app → browser), signedIn: Map(app → browser, '' when held already),
   *     checking: Map(app → Promise of its answer) }
   */
  async function signInsFirst(s) {
    const out = { signedOut: new Set(), refused: new Map(), signedIn: new Map(), checking: new Map() };
    if (!webSignIn || !s.choices.permissions.browser) return out;
    const apps = Object.values(s.choices.sources).filter((choice) => choice.on).flatMap((choice) => choice.apps)
      .filter((app) => appOf(app) && appOf(app).reach === 'web' && signsInAtAll(app));
    if (!apps.length) return out;
    const results = new Map();
    const waiting = [];
    const quiet = [];
    for (const app of apps) {
      const known = signInChecked.get(app);
      if (signInChecking.has(app)) waiting.push(signInChecking.get(app).then(() => { results.set(app, signInChecked.get(app)); }));
      else if (known && known.status !== 'no-browser') results.set(app, known);
      else quiet.push(app);
    }
    let timer = null;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, deps.signInCheckMs || SIGN_IN_CHECK_MS); if (timer.unref) timer.unref(); });
    const answers = new Map(quiet.map((app) => [app, webSignIn.signInQuiet(app, { denied: signInDenied }).catch(() => ({ signedIn: false })).then((result) => {
      const answer = checkedAs(app, result);
      results.set(app, answer);
      return answer;
    })]));
    await Promise.all([
      Promise.all(waiting),
      quiet.length ? Promise.race([Promise.all(answers.values()), limit]) : null,
    ]);
    clearTimeout(timer);
    for (const app of apps) {
      const result = results.get(app);
      if (!result && answers.has(app)) { out.checking.set(app, answers.get(app)); continue; }
      if (result && result.status === 'signed-in') {
        out.signedIn.set(app, result.browser);
        logAction(s, null, result.browser ? `Signed in to ${shownName(app)} from ${result.browser}` : `Signed in to ${shownName(app)} already`);
        if (result.unchecked) logAction(s, null, `Couldn't check the ${shownName(app)} sign-in (no answer): counted as signed in`);
      } else if (result && result.status === 'refused') out.refused.set(app, result.browser);
      else out.signedOut.add(app);
    }
    return out;
  }

  /**
   * A sign-in still being checked when the surveys started (signInsFirst's `checking`, 2026-10-12): its app is held, and
   * joins the run when the answer is signed in; signed out, it is left out quietly with a line in the chat (no Log in card,
   * 2026-10-12); refused by macOS, it is skipped as at the start.
   */
  function lateSignIn(s, app, answer) {
    logAction(s, null, `Still checking the ${shownName(app)} sign-in`);
    answer.then((result) => {
      if (s.stopped || !s.held.has(app)) return;
      if (result && result.status === 'signed-in') {
        logAction(s, null, result.browser ? `Signed in to ${shownName(app)} from ${result.browser}` : `Signed in to ${shownName(app)}`);
        if (result.unchecked) logAction(s, null, `Couldn't check the ${shownName(app)} sign-in (no answer): counted as signed in`);
        releaseHeld(s, app, 'done');
        emit(s);
        return;
      }
      if (result && result.status === 'refused') {
        skipApp(s, app);
        releaseHeld(s, app, 'skip');
        s.chat.push({ role: 'agent', text: skippedLine(result.browser, [app]), ask: null, authorize: null, at: now() });
        emit(s);
        return;
      }
      // Signed out (2026-10-12): left out quietly, as signInsFirst leaves out an app signed out at the start. Everything
      // about a web app's sign-in is settled on the choose screen; no Log in card comes up later.
      skipApp(s, app);
      releaseHeld(s, app, 'skip');
      s.chat.push({ role: 'agent', text: leftOutLine([app]), ask: null, authorize: null, at: now() });
      emit(s);
    });
  }

  /** "ChatGPT", "ChatGPT and Claude", "ChatGPT, Claude and Gemini". */
  const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

  /** The apps grouped by the browser named for each, '' left out → [[browser, apps]]. */
  function byBrowser(map) {
    const out = new Map();
    for (const [app, name] of map) if (name) out.set(name, [...(out.get(name) || []), app]);
    return [...out];
  }

  /** "Skipped ChatGPT and Claude: macOS didn't allow Chrome's sign-ins. You can add them later from Add sources." */
  const skippedLine = (name, apps) => `Skipped ${listed(apps.map(shownName))}: macOS didn't allow ${name || 'your browser'}'s sign-ins. You can add ${apps.length === 1 ? 'it' : 'them'} later from Add sources.`;

  /** "Left out Gmail: its sign-in ended partway through. You can add it later from Add sources." */
  const endedLine = (app) => `Left out ${shownName(app)}: its sign-in ended partway through. You can add it later from Add sources.`;

  /** "Left out Google Drive: not signed in. You can add it from Add sources." */
  const leftOutLine = (apps) => `Left out ${listed(apps.map(shownName))}: not signed in. You can add ${apps.length === 1 ? 'it' : 'them'} from Add sources.`;

  /** What the opener says of the sign-ins brought over and the apps macOS refused, in plain lines, or ''. */
  function signInLines({ signedIn, refused }) {
    const lines = byBrowser(signedIn).map(([name, apps]) => `Using your ${name} sign-ins for ${listed(apps.map(shownName))}.`);
    const skipped = new Map();
    for (const [app, name] of refused) skipped.set(name || '', [...(skipped.get(name || '') || []), app]);
    for (const [name, apps] of skipped) lines.push(skippedLine(name, apps));
    return lines.join('\n');
  }

  /** The line under a sign-in card before macOS is first asked for a browser's sign-ins this run, or ''. */
  function noteFor(app, kind) {
    if (!(kind === 'signin' || kind === 'password') || !webSignIn || !webSignIn.supports(app) || !webSignIn.keychainNote) return '';
    try { return webSignIn.keychainNote(app) || ''; } catch { return ''; }
  }

  /* ------------------------------------------------------------------------------------------------------ needs you */

  /**
   * The app a need is for: the job's first, unless that isn't a web app and the reason names the site of a web app among
   * the job's (2026-10-12: a job filed under "Codex, Claude, Claude Code" asked to sign in to "Claude (claude.ai)", was
   * taken as Codex's and so never reached signInAgain).
   */
  function needApp(job, reason) {
    const first = job.apps[0] || job.label;
    const web = (app) => !!(appOf(app) && appOf(app).reach === 'web');
    if (web(first)) return first;
    const said = String(reason || '').toLowerCase();
    const edge = (ch) => !/[a-z0-9-]/.test(ch || '');
    const names = (site) => { const want = site.toLowerCase(); for (let at = said.indexOf(want); at >= 0; at = said.indexOf(want, at + 1)) if (edge(said[at - 1]) && edge(said[at + want.length])) return true; return false; };
    return job.apps.find((app) => web(app) && (appOf(app).sites || []).some(names)) || first;
  }

  /** An agent hands the person a step (a sign-in, a code, a permission): one request per app and kind, then waits for it. */
  function askPerson(s, job, { kind, reason }) {
    const app = needApp(job, reason);
    // Skip holds for the whole run (2026-10-08: "hitting skip should skip it permanently for this run, right now it tries
    // again"): an app the person skipped is never put to them again; the agent hears at once that it was skipped.
    if (s.skipped.has(app)) return Promise.resolve({ status: 'skipped', note: `The person skipped ${shownName(app)} for this run. Do not ask again: finish without it.` });
    // A web app's sign-in lost partway through (2026-10-12): settled here, with no card (Zotero's and GitHub's sign-ins,
    // connectors and folder choices keep theirs).
    if ((kind === 'signin' || kind === 'password') && webSignIn && signsInAtAll(app) && appOf(app) && appOf(app).reach === 'web') return signInAgain(s, job, app);
    let need = s.needs.find((entry) => !entry.closed && entry.app === app && entry.kind === kind);
    if (!need) {
      need = { id: randomUUID(), app, kind, reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', note: noteFor(app, kind), closed: false, at: now() };
      s.needs.push(need);
      logAction(s, job, `Needs you: ${reason}`);
    }
    if (!need.jobs.includes(job.id)) need.jobs.push(job.id);
    return waitOn(s, job, need);
  }

  /**
   * An agent found `app` signed out partway through the run. Its word is checked first (2026-10-12: one failed API answer
   * in "Looking through ChatGPT" dropped ChatGPT's working sign-in and stopped "Asking ChatGPT what it remembers"): while
   * Engelbart's browser still holds the sign-in cookie, and the site's check page (where it has one) doesn't say signed out,
   * the sign-in stands and the agent is told to reload and try again; nothing is dropped, no other job stopped, nothing
   * said in the chat. The same agent saying so again after that finishes without the app, quietly. Only a cookie that is
   * gone, or a check that says signed out, has the sign-in copied again quietly from the person's browser (signInQuiet; a
   * browser macOS refused, or was never asked about this run, is not asked: no new Keychain prompt). Signed in now: the
   * agent carries on. Not: the app is left out for the run, with a line in the chat. One check and one copy per sign-in at
   * a time: Gmail and Google Drive losing theirs together wait for the one answer.
   */
  function signInAgain(s, job, app) {
    const group = signInGroup(app);
    if (!s.signInsAgain) s.signInsAgain = new Map();
    let again = s.signInsAgain.get(group);
    if (!again) {
      again = { checking: null, checkedAt: 0, stood: new Set(), copying: null, settledAt: 0, told: new Set() };
      s.signInsAgain.set(group, again);
    }
    const skippedNote = () => ({ status: 'skipped', note: `${shownName(app)} was left out for this run. Do not ask again: finish without it.` });
    if (again.stood.has(job.id)) {
      logAction(s, job, `Carried on without ${shownName(app)}: it still looked signed in`);
      emit(s);
      return Promise.resolve({ status: 'skipped', note: `${shownName(app)} still looks signed in to Engelbart, so the trouble is on its side. Do not ask again: finish without it with what you have, and say so in your answer.` });
    }
    if (again.copying) return copyAgain(s, job, app, again);
    // One look at the sign-in, shared by the agents asking within a while of it.
    if (!again.checking || (again.checkedAt && Date.now() - again.checkedAt > SIGN_IN_AGAIN_SHARED_MS)) {
      again.checkedAt = 0;
      const look = typeof webSignIn.stillSignedIn === 'function' ? () => webSignIn.stillSignedIn(app) : () => webSignIn.signedIn(app);
      again.checking = Promise.resolve().then(look).then((value) => !!value, () => false);
      again.checking.then(() => { again.checkedAt = Date.now(); });
    }
    return again.checking.then((stands) => {
      if (s.skipped.has(app)) return skippedNote();
      if (again.copying || !stands) return copyAgain(s, job, app, again);
      again.stood.add(job.id);
      logAction(s, job, `Still signed in to ${shownName(app)}: its page or API failed for a moment`);
      emit(s);
      return { status: 'done', note: 'Still signed in: the page or its API failed for a moment. Reload and try again, or finish with what you have.' };
    });
  }

  /**
   * The sign-in found gone: copied again once per sign-in per run. Agents asking while that copy is made, or just after,
   * share its answer; one asking again after it was told to carry on, or later on, found the copy did not hold: left out,
   * so the run never loops on copies the site refuses.
   */
  function copyAgain(s, job, app, again) {
    if (!again.copying) {
      again.copying = webSignIn.signInQuiet(app, { denied: signInDenied, askedOnly: true, fresh: true }).catch(() => ({ signedIn: false }));
      again.copying.then(() => { again.settledAt = Date.now(); });
    }
    const lost = again.told.has(job.id) || (again.settledAt && Date.now() - again.settledAt > SIGN_IN_AGAIN_SHARED_MS);
    const answer = lost ? Promise.resolve({ signedIn: false }) : again.copying;
    return answer.then((result) => {
      if (s.skipped.has(app)) return { status: 'skipped', note: `${shownName(app)} was left out for this run. Do not ask again: finish without it.` };
      if (result && result.signedIn) {
        again.told.add(job.id);
        const kept = checkedAs(app, result);
        for (const other of sharesSignIn(app)) signInChecked.set(other, kept);
        logAction(s, job, result.browser ? `Copied the ${shownName(app)} sign-in again from ${result.browser}` : `Signed in to ${shownName(app)} again`);
        emit(s);
        return { status: 'done', note: `The ${shownName(app)} sign-in was copied again from the person's browser. Reload the page and carry on.` };
      }
      skipApp(s, app, [job.id]);
      logAction(s, job, `Left out ${shownName(app)}: its sign-in ended partway through`);
      s.chat.push({ role: 'agent', text: endedLine(app), ask: null, authorize: null, at: now() });
      emit(s);
      return { status: 'skipped', note: `${shownName(app)}'s sign-in ended and could not be brought back, so it is left out for this run. Do not ask again: finish without it and say so.` };
    });
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
    // A sign-in that came back signed out after the run started (lateSignIn): Log in done lets it join, Skip leaves it out.
    if (need.held) releaseHeld(s, need.app, how === 'skip' ? 'skip' : 'done');
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
      if (!need.jobs.length) { need.closed = true; if (need.cancel) need.cancel(); }
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
    if (!worked) { s.memory = { ...s.memory, status: 'skipped' }; return; }
    s.memoryQueued = true;
    s.memory = { ...s.memory, status: 'writing', error: '' };
    dispatch(s, { kind: 'memory', source: 'memory', apps: [], label: 'MEMORY.md' });
  }

  async function memoryMessage(s) {
    const recalls = Object.entries(s.recalls).map(([app, text]) => `## ${app} (asked ${s.created.slice(0, 10)})\n${clipMiddle(text, 12000)}`);
    const local = memory.localMemories(homeDir, env).map((entry) => `## ${entry.app} (${entry.file})\n${entry.text}`);
    const { imports, surveys } = memoryJobs(s);
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

  /* -------------------------------------------------------------------------------------------------------- start */

  async function rescan(s, sourceIds) {
    const only = { sources: Object.fromEntries(Object.entries(s.choices.sources).filter(([id]) => sourceIds.includes(id))), project: projectFor(s.choices), days: s.choices.days || null };
    const fresh = await scanFor(only, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null, access: accessOf(s) });
    for (const [source, apps] of Object.entries(fresh)) {
      // What a survey found is kept: the scan does not know it.
      const merged = { ...(s.found[source] || {}) };
      for (const [app, value] of Object.entries(apps)) {
        const before = merged[app];
        // Where the search for its folder looked is kept while the folder is still missing (MATH-117).
        merged[app] = before && before.survey && value && value.reach ? before : before && before.searched && value && value.needs === 'folder' ? { ...value, searched: before.searched } : value;
      }
      s.found[source] = merged;
      s.newFound = { ...(s.newFound || {}), [source]: merged };
    }
    s.dirs = dirsOf(s);
    lookForFolders(s);
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
    // The workspace it was started from (2026-10-11): what comes in joins its context too (placeRows), when it is one of the project's.
    let workspaceId = null;
    if (projectId && typeof input.workspaceId === 'string' && ID_RE.test(input.workspaceId)) {
      try { workspaceId = require('../store/projects.cjs').findWorkspace(ctx, projectId, input.workspaceId).workspace.id; } catch { workspaceId = null; }
    }
    const s = {
      id, mode: projectId ? 'existing' : 'onboarding', dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', id), downloads: path.join(ctx.dataRoot, 'imports', id), created: now(), choices, choice: choiceFor(provider), redactChoice: null,
      picked: { folders: {}, exports: {} }, chat: [], thinking: true, activity: 'Looking at what you picked…', done: false, finished: false, minimized: false, dismissed: false, error: '',
      jobs: [], seq: 0, needs: [], log: [], controllers: new Set(), interviewSession: null, interviewController: null, found: {}, newFound: null, toldImports: '', projectId, projectDir, stopped: false,
      waitingForSurvey: false, surveyNews: [], recalls: {}, memory: { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' }, memoryQueued: false, memoryDraft: null,
      skipped: new Set(), skippedSources: new Set(), suspended: false, held: new Map(), rows: new Set(), inProject: new Set(), inWorkspace: new Set(), workspaceId, placing: Promise.resolve(),
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
   * web apps' sign-ins looked at, the first surveys and recalls (a signed-out app left out), the librarian's
   * first turn.
   */
  async function opening(s) {
    let opener = s.chat.find((entry) => entry.opener);
    if (!opener) {
      opener = { role: 'agent', text: 'Looking at what you picked…', ask: null, authorize: null, opener: true, at: now() };
      s.chat.push(opener);
      emit(s);
    }
    try { s.found = await scanFor({ ...s.choices, project: projectFor(s.choices) }, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null, access: accessOf(s) }); } catch (error) { s.found = { error: error.message }; }
    if (s.stopped || s.suspended) return;
    opener.text = foundSentence(s);
    s.dirs = dirsOf(s);
    emit(s);
    const checked = await signInsFirst(s);
    if (s.stopped || s.suspended) return;
    startWork(s, new Set([...checked.signedOut, ...checked.refused.keys(), ...checked.checking.keys()]));
    for (const [app, answer] of checked.checking) if (s.held.has(app)) lateSignIn(s, app, answer);
    lookForFolders(s);
    // A ticked web app still signed out (the choose screen signs each in before it starts, so a race, or a session resumed
    // after a quit) gets no card on this screen (2026-10-11): it is left out, and the opener says where to add it.
    const leftOut = [...checked.signedOut].filter((app) => s.held.has(app));
    for (const app of leftOut) {
      skipApp(s, app);
      releaseHeld(s, app, 'skip');
      logAction(s, null, `Left out ${shownName(app)}: not signed in`);
    }
    // An app whose browser macOS refused gets no card that can't succeed (2026-10-10): it is skipped for this run.
    for (const [app, name] of checked.refused) {
      skipApp(s, app);
      releaseHeld(s, app, 'skip');
      logAction(s, null, `Skipped ${shownName(app)}: macOS didn't allow ${name || 'your browser'}'s sign-ins`);
    }
    const lines = [signInLines(checked), leftOut.length ? leftOutLine(leftOut) : ''].filter(Boolean).join('\n');
    if (lines) opener.text = `${opener.text}\n\n${lines}`;
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
        if (Array.isArray(value.vaults) && value.vaults.length) parts.push(`${plural(value.vaults.length, `${shownName(app)} vault`)}`);
        else if (Array.isArray(value.folders) && value.folders.length && typeof value.pdfs === 'number') {
          const where = value.folders.slice(0, 2).map((folder) => folder.folder).filter(Boolean);
          parts.push(`${plural(value.pdfs, 'PDF')}${s.choices.days ? ` from ${periodName(s.choices.days)}` : ''}${where.length ? ` in ${where.join(' and ')}` : ''}`);
        } else if (typeof value.chats === 'number' && value.chats) parts.push(`your ${shownName(app)} chats`);
        else if (value.signedIn && typeof value.items === 'number') parts.push(`${plural(value.items, `${shownName(app)} item`)}`);
        else if (Array.isArray(value.repos) && value.repos.length) parts.push(`${plural(value.repos.length, `${shownName(app)} repository`, `${shownName(app)} repositories`)}`);
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
      if (!connectors) throw new Error(`${shownName(app)} cannot be signed in to here`);
      s.activity = `Waiting for you to sign in to ${shownName(app)} in your browser`;
      s.thinking = true;
      emit(s);
      try { await connectors.signIn(app); } catch (error) { s.thinking = false; s.activity = ''; emit(s); throw error; }
      s.thinking = false;
      s.activity = '';
      clean = { authorized: { app, kind } };
      s.found[source] = { ...(s.found[source] || {}), [app]: { reach: 'connector', survey: 'running' } };
      dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` });
    } else if (kind === 'permission') {
      if (!appleNotes) throw new Error(`${shownName(app)} cannot be read here`);
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
      // Chosen in the folder picker: macOS lets Engelbart read it, protected folder or not (MATH-110).
      s.choices.picked = [...new Set([...(s.choices.picked || []), fs.statSync(file).isDirectory() ? file : path.dirname(file)])].slice(-40);
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
        return !(found && (found.needs || found.looking));
      };
      const apps = choice.apps.filter((app) => !covered.has(app) && !s.skipped.has(app) && reachable(app));
      if (sent.length && !apps.length) continue;
      if (choice.apps.length && !apps.length && !choice.folders.length && !choice.repos.length) continue; // nothing of it can be reached
      const label = sourceOf(source).label;
      const where = [apps.length ? `from ${apps.join(', ')}` : '', choice.folders.length ? `folders ${choice.folders.join(', ')}` : '', choice.repos.length ? `repositories ${choice.repos.join(', ')} (already in the library)` : ''].filter(Boolean).join('; ');
      dispatch(s, { kind: 'import', source, apps, label: apps.length ? `${label}: ${apps.map(shownName).join(', ')}` : label, plan: `Bring in ${label.toLowerCase()} ${where} as the person picked and said in the chat. They pressed Import before this source was talked through, so use sensible defaults: leave out daily notes, personal folders and journals; tools used every day (mail, calendar, social media); runs a program started; anything older than about six months when there is a lot.` });
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
      const opened = (name) => { found.opened = true; found.browser = name; logAction(s, null, `Opened ${shownName(found.app)}'s sign-in in ${name}`, 'You'); emit(s); };
      webSignIn.signIn(found.app, { signal: controller.signal, onOpened: opened }).catch((error) => ({ status: 'failed', error: error.message })).then((out) => {
        found.busy = false;
        found.cancel = null;
        found.note = noteFor(found.app, found.kind); // macOS has been asked now, or will be by the next browser
        if (out.browser) found.browser = out.browser; // the browser it used, not the default it may have passed over
        if (found.closed || out.status === 'cancelled') return;
        if (out.status === 'signed-in') { logAction(s, null, `Signed in to ${shownName(found.app)} from ${out.browser}`, 'You'); closeNeed(s, found, 'done'); return; }
        if (out.status === 'unsupported' || out.status === 'no-browser') { showWindow(s, found, out.status === 'no-browser' ? 'Sign in here.' : `${out.browser}'s sign-ins can't be brought into Engelbart: sign in here instead.`); return; }
        // macOS refused: a card that asks again can't succeed (2026-10-10), so the app is skipped and the chat says so.
        if (out.status === 'denied') {
          if (out.browserId) signInDenied.add(out.browserId);
          closeNeed(s, found, 'skip');
          s.chat.push({ role: 'agent', text: skippedLine(out.browser, [found.app]), ask: null, authorize: null, at: now() });
          emit(s);
          return;
        }
        found.error = out.status === 'timeout' ? `Still not signed in to ${shownName(found.app)} in ${out.browser}. Log in to keep waiting, or skip it.` : line(out.error, 200);
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
        found.error = `Not signed in to ${shownName(found.app)} yet.`;
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
  async function attachProject(ctx, id, projectId, workspaceId = null) {
    const s = sessions.get(id);
    if (!s || s.dataRoot !== ctx.dataRoot) return 0;
    s.projectId = projectId;
    try { s.projectDir = require('../store/projects.cjs').findProject(ctx, projectId).dir; } catch { s.projectDir = null; }
    const written = await notes.flushStaged(ctx, s.dir, projectId, { projects: require('../store/projects.cjs') });
    if (typeof workspaceId === 'string' && ID_RE.test(workspaceId)) s.workspaceId = workspaceId;
    await placeRows(s, [...s.rows]);
    emit(s);
    return written.length;
  }

  // What the session brought into the library, or found already there (2026-10-10). Library rows belong to no project,
  // so no agent of the project was told of them (shared/project-holds.cjs): once the session knows its project (started
  // from it, or onboarding's attachProject), each goes on the project's own list (project.json `library`, 2026-10-11), and
  // with a workspace (the one it was started from, or the Welcome workspace) joins its context too, those that come in
  // later as well, so the project's agents and that workspace's sidebar see the person's library. Never a row taken out of
  // the project before (project.json `removed`): only adding it again brings it back. One placing at a time: each reads
  // what it adds to.
  function keepRow(s, row) {
    if (!row || typeof row.id !== 'string' || !ID_RE.test(row.id) || s.rows.has(row.id)) return;
    s.rows.add(row.id);
    if (s.projectId) void placeRows(s, [row.id]);
  }
  function placeRows(s, ids) {
    if (!ids.length || !s.projectId) return s.placing;
    s.placing = s.placing.then(async () => {
      const projects = require('../store/projects.cjs');
      const ctx = await context();
      if (ctx.dataRoot !== s.dataRoot) return;
      const listed = projects.keepInProject(ctx, s.projectId, ids);
      const { removed } = projects.findProject(ctx, s.projectId);
      const kept = ids.filter((row) => !removed.includes(row));
      for (const row of kept) s.inProject.add(row);
      let fresh = [];
      if (s.workspaceId) {
        try {
          const { workspace } = projects.findWorkspace(ctx, s.projectId, s.workspaceId);
          for (const row of kept) if (workspace.context.includes(row)) s.inWorkspace.add(row);
          // A workspace holds 500 entries at most (projects.cjs MAX_TREE_ENTRIES): past that, the rest are the project's alone.
          fresh = kept.filter((row) => !workspace.context.includes(row) && !(workspace.removed || []).includes(row)).slice(0, Math.max(0, 500 - workspace.context.length));
          if (fresh.length) await projects.setWorkspaceContext(ctx, s.projectId, s.workspaceId, [...workspace.context, ...fresh]);
          for (const row of fresh) s.inWorkspace.add(row);
        } catch { fresh = []; } // the workspace gone: what came in is the project's
      }
      if (listed.length || fresh.length) placed(s.projectId);
    }).catch(() => {}); // the project gone, or the library closed: what came in stays in the library
    return s.placing;
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
      id, mode: saved.mode === 'existing' && projectId ? 'existing' : 'onboarding', dataRoot: ctx.dataRoot, homeDir, dir, downloads: path.join(ctx.dataRoot, 'imports', id), created: saved.created, choices: cleanChoices(saved.choices, homeDir, { alsoPicked: Object.values(keptPaths(saved.picked && saved.picked.folders)).map((file) => (fs.statSync(file).isDirectory() ? file : path.dirname(file))) }), choice: choiceFor(provider), redactChoice: null,
      picked: { folders: keptPaths(saved.picked && saved.picked.folders), exports: keptPaths(saved.picked && saved.picked.exports) },
      chat: (Array.isArray(saved.chat) ? saved.chat : []).filter((entry) => entry && (entry.role === 'agent' || entry.role === 'user')), thinking: false, activity: '', done: !!saved.done, finished: !!saved.finished, minimized: true, dismissed: false, error: '',
      jobs: [], seq: 0, needs: [], log: (Array.isArray(saved.log) ? saved.log : []).slice(-MAX_LOG), controllers: new Set(), interviewSession: typeof saved.interviewSession === 'string' ? saved.interviewSession : null, interviewController: null,
      found: saved.found && typeof saved.found === 'object' ? saved.found : {}, newFound: null, toldImports: '', projectId, projectDir, stopped: false,
      waitingForSurvey: !!saved.waiting, surveyNews: [], recalls: keptRecalls(dir), memory: kept ? { ...saved.memory } : { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' }, memoryQueued: kept, memoryDraft: null,
      skipped: new Set((Array.isArray(saved.skipped) ? saved.skipped : []).filter((app) => typeof app === 'string')),
      skippedSources: new Set((Array.isArray(saved.skippedSources) ? saved.skippedSources : []).filter((id) => sourceOf(id))), suspended: false, held: new Map(),
      rows: new Set((Array.isArray(saved.rows) ? saved.rows : []).filter((row) => typeof row === 'string' && ID_RE.test(row))),
      inProject: new Set((Array.isArray(saved.inProject) ? saved.inProject : []).filter((row) => typeof row === 'string' && ID_RE.test(row))),
      inWorkspace: new Set((Array.isArray(saved.inWorkspace) ? saved.inWorkspace : []).filter((row) => typeof row === 'string' && ID_RE.test(row))),
      workspaceId: projectId && typeof saved.workspaceId === 'string' && ID_RE.test(saved.workspaceId) ? saved.workspaceId : null, placing: Promise.resolve(),
      gmailThreads: Number.isInteger(saved.gmailThreads) && saved.gmailThreads > 0 ? saved.gmailThreads : 0,
    };
    // Closed before the librarian's first word, with only the opening line said: the opening again.
    if (s.chat.every((entry) => entry.opener)) s.chat = [];
    for (const job of Array.isArray(saved.jobs) ? saved.jobs : []) {
      if (!job || !Object.hasOwn(PRIORITY, job.kind)) continue;
      // MEMORY.md is written again once the work has ended, unless it was saved: its draft was never kept on disk.
      if ((job.kind === 'memory' || job.kind === 'redact') && !kept) continue;
      const again = !ENDED.has(job.status);
      const apps = (Array.isArray(job.apps) ? job.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub'));
      s.seq += 1;
      const find = job.kind === 'survey' && (job.find === true || (typeof job.key === 'string' && job.key.startsWith('find:')));
      s.jobs.push({
        ...(find ? { find: true } : {}),
        id: typeof job.id === 'string' && ID_RE.test(job.id) ? job.id : randomUUID(), key: typeof job.key === 'string' ? job.key : `${find ? 'find' : job.kind}:${job.source}:${[...apps].sort().join(',')}`,
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
          s.jobs.push({ id: randomUUID(), key: `survey:${source}:${app}`, kind: 'survey', priority: PRIORITY.survey, seq: s.seq, source, apps: [app], label: `Looking through ${shownName(app)}`, plan: '', extra: null, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null });
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
    start, answer, authorize, importNow, need, stop, stopJob, suspendAll, resume, retryMemory, setMinimized, dismiss, attachProject, windowClosed, logJob, list, providers, cancelSignIn, signInNote, signInCheck, signInWindowOpen, signInWindowClose, signInBrowser, signInBrowserCancel, signInUnlock, signInAnotherAccount, signInPick,
    setProvider: (id, provider) => { const s = get(id); setProvider(s, provider); emit(s); return snapshot(s); },
    // the first build's name for authorize
    connected: (id, input) => authorize(id, input),
    state: (id) => snapshot(get(id)), has: (id) => sessions.has(id),
  };
}

module.exports = { createConnect, cleanChoices, memoryJobs, projectBlock, optionOf, readReply, readSurvey, messageOf, shownOf, connectChoice, CONNECT_MODELS, PROVIDER_NAMES, PRIORITY, MAX_RUNNING };
