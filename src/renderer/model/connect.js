// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html"), the window's model. Pure:
// screens/ConnectLibrary.jsx and ui/ConnectDock.jsx ask what is ticked, what a row says beside it, what goes to main
// (src/main/connect), how an import's progress reads, what a step the agents hand the person says, and what the dock
// shows. The sources and apps are src/shared/connect-sources.cjs.

import { SOURCES, APPS, recallApps, webApps } from '../../shared/connect-sources.cjs';

export { SOURCES, APPS };

/**
 * Where the choose screen starts, from what main found (`connect-detect`): an app is ticked when it was found (on this
 * Mac, or signed in to in Engelbart's browser), a source when one of its apps was (Websites: a browser; Code: a GitHub
 * sign-in). Nothing is open but the first ticked source.
 */
export function initialPicks(found) {
  const apps = {};
  const picks = {};
  for (const source of SOURCES) {
    apps[source.id] = {};
    for (const app of source.apps) apps[source.id][app] = !!(found && found.apps && found.apps[app] && found.apps[app].found);
    picks[source.id] = source.id === 'sites' ? !!(found && found.sites && found.sites.found)
      : source.id === 'code' ? !!(found && found.github && found.github.found)
        : Object.values(apps[source.id]).some(Boolean);
  }
  const first = SOURCES.find((source) => picks[source.id] && source.apps.length);
  return { picks, apps, open: first ? { [first.id]: true } : {} };
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

/** What a source's row says at its right: "All", "2 of 6", "3 repos · 1 folder", '' while it is off. */
export function subOf(sourceId, { on, apps, repos = [], folders = [] }) {
  if (!on) return '';
  const source = SOURCES.find((entry) => entry.id === sourceId);
  if (sourceId === 'code') {
    const parts = [repos.length ? `${repos.length} repo${repos.length === 1 ? '' : 's'}` : '', folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : ''].filter(Boolean);
    return parts.join(' · ') || 'GitHub';
  }
  if (!source || !source.apps.length) return sourceId === 'papers' && folders.length ? `${folders.length} folder${folders.length === 1 ? '' : 's'}` : '';
  const chosen = source.apps.filter((app) => apps[sourceId] && apps[sourceId][app]);
  const base = chosen.length && chosen.length < source.apps.length ? `${chosen.length} of ${source.apps.length}` : 'All';
  return sourceId === 'papers' && folders.length ? `${base} · ${folders.length} folder${folders.length === 1 ? '' : 's'}` : base;
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

/** What a step the agents hand the person asks of them, and the button that does it. */
export function needView(need) {
  const kind = need && need.kind;
  if (kind === 'connector') return { title: `${need.app} needs you to sign in`, action: `Sign in to ${need.app}`, hint: `${need.app}’s own sign-in page opens in your browser.` };
  if (kind === 'permission') return { title: `${need.app} needs your permission`, action: 'Allow', hint: 'macOS asks once whether Engelbart may read it.' };
  if (need && (need.app === 'Zotero' || need.app === 'GitHub')) return { title: `${need.app} needs you to sign in`, action: `Sign in to ${need.app}`, hint: '' };
  const what = { signin: 'sign in', '2fa': 'enter a code', password: 'enter your password', captcha: 'prove you are not a robot', confirm: 'confirm something' }[kind] || 'do something';
  return { title: `${need ? need.app : 'An app'} needs you to ${what}`, action: kind === 'signin' ? 'Open the sign-in window' : 'Open the window', hint: 'The agent’s own window opens: do it there, then press Done. Nothing is typed for you.' };
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
