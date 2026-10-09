// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html"), the window's model. Pure:
// screens/ConnectLibrary.jsx and ui/ConnectDock.jsx ask what is ticked, what a row says beside it, what goes to main
// (src/main/connect), how an import's progress reads, what a step the agents hand the person says, and what the dock
// shows. The sources and apps are src/shared/connect-sources.cjs.

import { SOURCES, APPS, LOCAL_PDFS, recallApps, webApps } from '../../shared/connect-sources.cjs';

export { SOURCES, APPS, LOCAL_PDFS };

// MATH-114 (2026-10-09): the choose screen as the mockup's grouped list. Each source is a group whose header ticks its
// rows (tri-state); a row says at its right how the app is reached and where it stands; ticking is the consent (a
// connector's sign-in, macOS's Apple Notes prompt, a folder for a local app that was not found). Websites is one row (the
// browser's history), Code two (GitHub, and the repositories on this Mac). One checkbox lets the agents read with the
// person's own subscription (files and browser); asking an assistant what it remembers is ticking that assistant.

/** The AI assistants that remember the person (connect-sources' `memory`): found, they still start unticked. */
export const MEMORY_APPS = Object.freeze(recallApps(Object.keys(APPS)));
/** Websites' one row, and Code's second (the first is GitHub). */
export const BROWSER_ROW = 'Browser history';
export const LOCAL_REPOS = 'Local repos';

/** The rows a group's header ticks, in order. */
export function rowsOf(sourceId) {
  if (sourceId === 'sites') return [BROWSER_ROW];
  if (sourceId === 'code') return ['GitHub', LOCAL_REPOS];
  const source = SOURCES.find((entry) => entry.id === sourceId);
  return source ? source.apps : [];
}

/** Whether a row was found (on this Mac, signed in to, connected): what the header and Select all tick. */
export function foundRow(found, sourceId, row) {
  if (!found) return false;
  if (sourceId === 'sites') return !!(found.sites && found.sites.found);
  if (sourceId === 'code') return row === 'GitHub' ? !!(found.github && found.github.found) : (found.localRepos || []).length > 0;
  return !!(found.apps && found.apps[row] && found.apps[row].found);
}

/** Whether a row is ticked. Local repos is, when any repository on this Mac (or folder picked for Code) is. */
export function ticked(state, sourceId, row) {
  if (!state) return false;
  if (sourceId === 'code' && row === LOCAL_REPOS) return Object.values(state.local || {}).some(Boolean);
  return !!(state.apps && state.apps[sourceId] && state.apps[sourceId][row]);
}

// Each source is on exactly when one of its rows is ticked: never on with none (appsOf would read that as every app).
function derive(state) {
  const picks = {};
  for (const source of SOURCES) picks[source.id] = rowsOf(source.id).some((row) => ticked(state, source.id, row));
  return { ...state, picks };
}

/**
 * Where the choose screen starts, from what main found (`connect-detect`): a row is ticked when it was found (on this Mac,
 * signed in to in Engelbart's browser, connected; Websites: a browser; Code: a GitHub sign-in), except the assistants that
 * remember the person (asking them is its own consent) and the repositories on this Mac. Nothing is open but the first
 * ticked source.
 */
export function initialPicks(found) {
  const apps = {};
  for (const source of SOURCES) {
    apps[source.id] = {};
    for (const row of rowsOf(source.id)) if (!(source.id === 'code' && row === LOCAL_REPOS)) apps[source.id][row] = foundRow(found, source.id, row) && !MEMORY_APPS.includes(row);
  }
  const state = derive({ apps, local: {}, open: {} });
  const first = SOURCES.find((source) => state.picks[source.id] && source.apps.length);
  return { ...state, open: first ? { [first.id]: true } : {} };
}

/** A row ticked or not. Local repos ticks every repository found (`repos`: their paths), or none. */
export function tickRow(state, sourceId, row, on, repos = []) {
  if (sourceId === 'code' && row === LOCAL_REPOS) {
    const local = Object.fromEntries(Object.keys(state.local || {}).map((dir) => [dir, !!on]));
    for (const dir of repos) local[dir] = !!on;
    return derive({ ...state, local });
  }
  return derive({ ...state, apps: { ...state.apps, [sourceId]: { ...(state.apps[sourceId] || {}), [row]: !!on } } });
}

/** A repository on this Mac (or a folder picked for Code) ticked or not. */
export function tickRepo(state, dir, on) {
  return derive({ ...state, local: { ...(state.local || {}), [dir]: !!on } });
}

/** A group's header: 'all' of its rows ticked, 'some', or 'none'. */
export function groupState(state, sourceId) {
  const rows = rowsOf(sourceId);
  const n = rows.filter((row) => ticked(state, sourceId, row)).length;
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some';
}

/**
 * A group's header clicked: with anything ticked, everything goes off; with nothing, its found rows come on (Local repos:
 * every repository found). A group with nothing found opens instead, for the person to pick its rows.
 */
export function tickGroup(state, sourceId, found) {
  const rows = rowsOf(sourceId);
  const repos = ((found && found.localRepos) || []).map((repo) => repo.path);
  if (groupState(state, sourceId) !== 'none') return rows.reduce((next, row) => tickRow(next, sourceId, row, false), state);
  const on = rows.filter((row) => foundRow(found, sourceId, row));
  if (!on.length) return { ...state, open: { ...state.open, [sourceId]: true } };
  return on.reduce((next, row) => tickRow(next, sourceId, row, true, repos), state);
}

/** Select all: every found row of every group; `false`: nothing. */
export function tickAll(state, found, on = true) {
  const repos = ((found && found.localRepos) || []).map((repo) => repo.path);
  return SOURCES.reduce((next, source) => rowsOf(source.id).reduce((acc, row) => (on ? (foundRow(found, source.id, row) ? tickRow(acc, source.id, row, true, repos) : acc) : tickRow(acc, source.id, row, false)), next), state);
}

/** Whether every found row is ticked (Select all's button then says Clear). */
export function allPicked(state, found) {
  const rows = SOURCES.flatMap((source) => rowsOf(source.id).filter((row) => foundRow(found, source.id, row)).map((row) => [source.id, row]));
  return rows.length > 0 && rows.every(([id, row]) => ticked(state, id, row));
}

/** The repository folders ticked for Code, sent as its `folders` (gitFolders takes a repository's own folder). */
export function localPicked(state) {
  return Object.entries((state && state.local) || {}).filter(([, on]) => on).map(([dir]) => dir);
}

/** The apps of a source that are ticked (a source turned on with none ticked counts every app, as the design has it). */
export function appsOf(sourceId, apps) {
  const source = SOURCES.find((entry) => entry.id === sourceId);
  if (!source) return [];
  const chosen = source.apps.filter((app) => apps[sourceId] && apps[sourceId][app]);
  return chosen.length ? chosen : source.apps;
}

/** Every app picked, across the sources that are on. */
export function pickedApps(picks, apps) {
  return SOURCES.filter((source) => picks[source.id]).flatMap((source) => appsOf(source.id, apps));
}

/** What a group's header says after its name: the rows ticked ("Obsidian, Google Docs"; "GitHub, 2 local repos"), or "nothing picked". */
export function subOf(sourceId, state) {
  const names = rowsOf(sourceId).filter((row) => ticked(state, sourceId, row)).map((row) => (sourceId === 'code' && row === LOCAL_REPOS ? reposCount(state) : row));
  return names.length ? names.join(', ') : 'nothing picked';
}
const reposCount = (state) => { const n = localPicked(state).length; return `${n} local repo${n === 1 ? '' : 's'}`; };

/**
 * What a row says at its right, from how its app is reached and where it stands → { text, tone: 'muted' | 'busy' |
 * 'error' | '' }. `connectors`: app → { connected, pending } (main's connectors); `notes`: the Apple Notes prompt's state
 * ('' | 'asking' | 'allowed' | why not); `folder`: one the person picked for it.
 */
export function rowLabel(app, { found = null, connectors = {}, notes = '', folder = '' } = {}) {
  const spec = APPS[app];
  const seen = (found && found.apps && found.apps[app]) || {};
  if (folder) return { text: folder, tone: '' };
  if (!spec) return { text: '', tone: '' };
  if (spec.reach === 'connector') {
    const status = connectors[app] || {};
    if (status.connected) return { text: 'signed in', tone: '' };
    if (status.pending) return { text: `Waiting for ${app} sign-in…`, tone: 'busy' };
    return { text: `Opens ${app} in your browser to sign in`, tone: 'muted' };
  }
  if (spec.reach === 'automation') {
    if (notes === 'allowed') return { text: 'allowed', tone: '' };
    if (notes === 'asking') return { text: 'macOS is asking you…', tone: 'busy' };
    return notes ? { text: notes, tone: 'error' } : { text: '', tone: '' };
  }
  if (spec.reach === 'web') {
    if (seen.signedIn) return { text: 'signed in to Engelbart', tone: '' };
    return seen.found ? { text: 'Sign in to add', tone: 'muted' } : { text: 'Not found', tone: 'muted' };
  }
  return seen.found ? { text: seen.where || '', tone: '' } : { text: 'Not found', tone: 'muted' };
}

/** The line under a row's name, when it needs one: an assistant is read and asked; macOS asks before Apple Notes. */
export function rowSub(app) {
  if (MEMORY_APPS.includes(app)) return 'Chats about your question · asks what it remembers, for a head start';
  if (app === 'Apple Notes') return 'macOS will ask';
  return '';
}

/**
 * What the one checkbox ("Use my … subscription to read these") covers of what is ticked: the apps read on this Mac, in
 * Engelbart's browser and through Engelbart's own sign-ins, the browser's history, and the repositories. Connectors, Apple
 * Notes and asking an assistant what it remembers each have their own consent, and are left out.
 */
export function consentFor(state) {
  const names = [];
  for (const source of SOURCES) {
    for (const row of rowsOf(source.id)) {
      if (!ticked(state, source.id, row)) continue;
      if (source.id === 'sites') names.push('your browser history');
      else if (source.id === 'code') names.push(row === 'GitHub' ? 'GitHub' : reposCount(state));
      else if (['local', 'web', 'signin'].includes((APPS[row] || {}).reach)) names.push(row);
    }
  }
  return names;
}

/** The permissions sent: files and the browser from the one checkbox, recall from an assistant ticked, Apple Notes from macOS. */
export function permissionsOf(state, { consent = true, notes = false } = {}) {
  const apps = SOURCES.flatMap((source) => source.apps.filter((app) => ticked(state, source.id, app)));
  return { files: !!consent, browser: !!consent, recall: recallApps(apps).length > 0, notes: !!notes };
}

/**
 * What the permissions card asks about for these picks: the web apps the agents will open in the background browser,
 * the assistants they may ask what they remember, the connectors to sign in to, and whether Apple Notes needs macOS's leave.
 */
export function permissionsFor(apps) {
  const list = [...new Set(apps || [])];
  return {
    web: webApps(list),
    recall: recallApps(list),
    connectors: list.filter((app) => APPS[app] && APPS[app].reach === 'connector'),
    notes: list.includes('Apple Notes'),
  };
}

/** What `connect-start` is sent: each source on or off with its apps, folders and repositories; the instructions; the permissions; the provider. */
export function choicesOf({ picks, apps, folders = {}, repos = [], custom = '', permissions = {}, provider = null, projectId = null }) {
  const sources = {};
  for (const source of SOURCES) {
    sources[source.id] = {
      on: !!picks[source.id],
      apps: picks[source.id] ? appsOf(source.id, apps) : [],
      folders: picks[source.id] ? (folders[source.id] || []) : [],
      repos: source.id === 'code' && picks.code ? repos : [],
    };
  }
  const allowed = { files: permissions.files !== false, browser: permissions.browser !== false, recall: permissions.recall !== false, notes: permissions.notes === true };
  return { sources, custom: String(custom || '').trim(), computer: allowed.files, permissions: allowed, ...(provider ? { provider } : {}), ...(projectId ? { projectId } : {}) };
}

/** An import's place in the progress list: its words, whether it is finished, failed, or waits on the person. */
export function statusOf(job) {
  const n = (job.notes || 0) + (job.items || 0);
  const added = `${n} added`;
  if (job.skipped) return { text: 'skipped', done: true };
  if (job.kind === 'survey') {
    if (job.status === 'done') return { text: 'looked', done: true };
    if (job.status === 'failed') return { text: 'could not look', done: true, failed: true };
    if (job.status === 'stopped') return { text: 'stopped', done: true };
    if (job.status === 'waiting') return { text: 'needs you', done: false, waiting: true };
    return { text: job.status === 'running' ? 'looking…' : 'queued', done: false };
  }
  if (job.kind === 'recall') {
    if (job.status === 'done') return { text: '✓ remembered', done: true };
    if (job.status === 'failed') return { text: 'failed', done: true, failed: true };
    if (job.status === 'stopped') return { text: 'stopped', done: true };
    if (job.status === 'waiting') return { text: 'needs you', done: false, waiting: true };
    return { text: job.status === 'running' ? 'asking…' : 'queued', done: false };
  }
  if (job.status === 'done') return { text: `✓ ${added}`, done: true };
  if (job.status === 'failed') return { text: n ? `stopped after ${added}` : 'failed', done: true, failed: true };
  if (job.status === 'stopped') return { text: n ? `stopped · ${added}` : 'stopped', done: true };
  if (job.status === 'waiting') return { text: n ? `needs you · ${added}` : 'needs you', done: false, waiting: true };
  if (job.status === 'running') return { text: n ? `importing… ${added}` : 'importing…', done: false };
  return { text: 'queued', done: false };
}

/** Whether every job has ended. */
export const allEnded = (jobs) => (jobs || []).every((job) => statusOf(job).done);

/** The jobs the progress list shows: the work, without MEMORY.md's own (it has a row of its own). */
export const workJobs = (jobs) => (jobs || []).filter((job) => job.kind !== 'memory' && job.kind !== 'redact');

/** The jobs still going first (2026-10-08: "show the ones still running at the top"), running before queued, then the ended, each group in its order. */
export function runningFirst(jobs) {
  const rank = (job) => { const status = statusOf(job); return status.done ? 2 : job.status === 'queued' ? 1 : 0; };
  return (jobs || []).map((job, i) => ({ job, i })).sort((a, b) => rank(a.job) - rank(b.job) || a.i - b.i).map((entry) => entry.job);
}

/**
 * The line under the chat, as Claude Code shows its subagents (2026-10-08: "list the current action of the agent and cycle
 * through the subagents at the bottom"): what the librarian is doing, and the subagents still at work, one at a time.
 * `tick` turns the cycle. → { lead, agent: { label, doing, place } | null } or null when nothing works.
 */
export function workLine(session, tick = 0) {
  if (!session) return null;
  const busy = workJobs(session.jobs).filter((job) => job.status === 'running' || job.status === 'waiting');
  const lead = session.thinking ? `${session.activity || 'Thinking'}…`.replace(/……$/, '…') : '';
  if (!lead && !busy.length) return null;
  const at = busy.length ? ((tick % busy.length) + busy.length) % busy.length : 0;
  const job = busy[at];
  return { lead, agent: job ? { id: job.id, label: job.label, doing: job.status === 'waiting' ? 'needs you' : job.activity || statusOf(job).text, place: busy.length > 1 ? `${at + 1} of ${busy.length}` : '', waiting: job.status === 'waiting' } : null };
}

/** What a step the agents hand the person asks of them, and the button that does it. */
export function needView(need) {
  const kind = need && need.kind;
  if (kind === 'connector') return { title: `${need.app} needs you to sign in`, action: 'Log in', hint: '' };
  if (kind === 'permission') return { title: `${need.app} needs your permission`, action: 'Allow', hint: '' };
  if (need && (need.app === 'Zotero' || need.app === 'GitHub')) return { title: `${need.app} needs you to sign in`, action: 'Log in', hint: '' };
  // One button and Skip (2026-10-08: "It should just be one login button on the right ... or skip"): a sign-in opens in the
  // default browser and is brought over (main's connect/web-signin.cjs); a code or a captcha, the agent's own window.
  const what = { signin: 'sign in', '2fa': 'enter a code', password: 'sign in', captcha: 'prove you are not a robot', confirm: 'confirm something' }[kind] || 'sign in';
  return { title: `${need ? need.app : 'An app'} needs you to ${what}`, action: kind === 'signin' || kind === 'password' ? 'Log in' : 'Open', hint: '' };
}

/** MEMORY.md's line in the progress list. */
export function memoryLine(memory) {
  const status = memory && memory.status;
  if (status === 'saved') return { text: memory.removed ? `Saved · ${memory.removed} secret${memory.removed === 1 ? '' : 's'} masked` : 'Saved', done: true };
  if (status === 'writing') return { text: 'Writing…', done: false };
  if (status === 'cleaning') return { text: 'Taking out any secrets…', done: false };
  if (status === 'failed') return { text: 'Not saved', done: true, failed: true };
  if (status === 'stopped') return { text: 'Stopped', done: true };
  if (status === 'skipped') return { text: 'Nothing to write from', done: true };
  return { text: 'Waits for the imports', done: false };
}

/**
 * The dock's line for a session in the background: what needs the person first, else how far it is. `short` is what the
 * chip in the top-right controls says (it shares the row with the bell and the pane tabs, so a few words); `text` the
 * whole line, its tooltip.
 */
export function dockLine(session) {
  if (!session) return null;
  const needs = session.needs || [];
  if (needs.length) return { tone: 'warn', short: 'Needs you', text: needs.length === 1 ? needView(needs[0]).title : `${needs.length} steps need you` };
  if (session.thinking || (!session.done && !session.finished)) {
    const asked = session.chat && session.chat.length && session.chat[session.chat.length - 1].role === 'agent' && !session.thinking;
    return { tone: asked ? 'warn' : 'busy', short: asked ? 'Your answer' : 'Connecting', text: asked ? 'The librarian asked you something' : 'Connecting your library…' };
  }
  const jobs = workJobs(session.jobs);
  const ended = jobs.filter((job) => statusOf(job).done).length;
  const memory = memoryLine(session.memory);
  if (jobs.length && ended < jobs.length) return { tone: 'busy', short: `Importing ${ended}/${jobs.length}`, text: `Importing · ${ended} of ${jobs.length} done` };
  if (!memory.done) return { tone: 'busy', short: 'Memory…', text: `MEMORY.md · ${memory.text.toLowerCase()}` };
  const n = (session.counts && session.counts.notes + session.counts.items) || 0;
  return { tone: 'done', short: 'Library', text: `Library connected${n ? ` · ${n} added` : ''}${session.memory && session.memory.status === 'saved' ? ' · MEMORY.md saved' : ''}` };
}

/** When a log entry happened, as the activity list shows it: "14:02". */
export function logTime(at) {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * Connect your library in the sidebar's Inbox (2026-10-08: "all the notifications should be sent to the inbox in the sidebar
 * ... if the user is needed or if it is done"): a session of this project (or one onboarding has not given a project) that
 * needs the person, or has finished. → [{ id, kind: 'connect', sessionId, name, did, at }]
 */
export function connectInbox(sessions, projectId) {
  const out = [];
  for (const session of sessions || []) {
    if (!session || session.dismissed || session.stopped || (session.projectId && session.projectId !== projectId)) continue;
    const view = dockLine(session);
    if (!view || view.tone === 'busy') continue;
    out.push({ id: `connect:${session.id}`, kind: 'connect', sessionId: session.id, workspaceId: null, name: 'Connect your library', did: view.text, at: session.created || null });
  }
  return out;
}
