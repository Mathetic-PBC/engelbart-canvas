// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html"), the window's model. Pure:
// screens/ConnectLibrary.jsx and ui/ConnectDock.jsx ask what is ticked, what a row says beside it, what goes to main
// (src/main/connect), how an import's progress reads, what a step the agents hand the person says, and what the dock
// shows. The sources and apps are src/shared/connect-sources.cjs.

import { SOURCES, APPS, LOCAL_PDFS, READABLE_NAMES, PERIODS, DEFAULT_PERIOD_DAYS, recallApps, webApps, cleanDays, periodName, shownName } from '../../shared/connect-sources.cjs';

export { SOURCES, APPS, LOCAL_PDFS, PERIODS, DEFAULT_PERIOD_DAYS, periodName, shownName };

// MATH-114 (2026-10-09): the choose screen as the mockup's grouped list. Each source is a group whose header ticks its
// rows (tri-state); a row says at its right how the app is reached and where it stands; ticking is the consent (a
// connector's sign-in, macOS's Apple Notes prompt, a folder for a local app that was not found). Websites is one row (the
// browser's history), Code two (GitHub, and the repositories on this Mac). One checkbox lets the agents read with the
// person's own subscription (files and browser); asking an assistant what it remembers is ticking that assistant.

/** The AI assistants that remember the person (connect-sources' `memory`): found, they still start unticked. */
export const MEMORY_APPS = Object.freeze(recallApps(Object.keys(APPS)));
/** Apps that start unticked even when found (2026-10-11): Gmail holds what other people wrote, so ticking it is its own yes. */
export const NEVER_TICKED = Object.freeze(['Gmail']);
/**
 * Apps that start unticked even when found (2026-10-11): Gmail, and Google Drive ('Google Docs'), which is the person's
 * whole Drive and as personal as their mail, so they choose it themselves. Unlike Gmail, Drive is still ticked by its
 * group's header and Select all (it is not NEVER_TICKED); its row still says it is signed in.
 */
export const START_UNTICKED = Object.freeze([...NEVER_TICKED, 'Google Docs']);
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
 * remember the person (asking them is its own consent), Gmail and Google Drive (START_UNTICKED) and the repositories on this Mac. Nothing is open but the first
 * ticked source.
 */
export function initialPicks(found) {
  const apps = {};
  for (const source of SOURCES) {
    apps[source.id] = {};
    for (const row of rowsOf(source.id)) if (!(source.id === 'code' && row === LOCAL_REPOS)) apps[source.id][row] = foundRow(found, source.id, row) && !MEMORY_APPS.includes(row) && !START_UNTICKED.includes(row);
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
 * every repository found), except Gmail (NEVER_TICKED: ticked only on its own row). A group with none of those opens
 * instead, for the person to pick its rows.
 */
export function tickGroup(state, sourceId, found) {
  const rows = rowsOf(sourceId);
  const repos = ((found && found.localRepos) || []).map((repo) => repo.path);
  if (groupState(state, sourceId) !== 'none') return rows.reduce((next, row) => tickRow(next, sourceId, row, false), state);
  const on = rows.filter((row) => foundRow(found, sourceId, row) && !NEVER_TICKED.includes(row));
  if (!on.length) return { ...state, open: { ...state.open, [sourceId]: true } };
  return on.reduce((next, row) => tickRow(next, sourceId, row, true, repos), state);
}

// What Select all and a group's header tick: a found row, but never Gmail (NEVER_TICKED: ticked only on its own row).
const selectable = (found, sourceId, row) => foundRow(found, sourceId, row) && !NEVER_TICKED.includes(row);

/** Select all: every found row of every group but Gmail; `false`: nothing (Gmail too). */
export function tickAll(state, found, on = true) {
  const repos = ((found && found.localRepos) || []).map((repo) => repo.path);
  return SOURCES.reduce((next, source) => rowsOf(source.id).reduce((acc, row) => (on ? (selectable(found, source.id, row) ? tickRow(acc, source.id, row, true, repos) : acc) : tickRow(acc, source.id, row, false)), next), state);
}

/** Whether every row Select all ticks is ticked (its button then says Clear). */
export function allPicked(state, found) {
  const rows = SOURCES.flatMap((source) => rowsOf(source.id).filter((row) => selectable(found, source.id, row)).map((row) => [source.id, row]));
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

/** What a group's header says after its name: the rows ticked, as the person sees them ("Obsidian, Google Drive"; "GitHub, 2 local repos"), or "nothing picked". */
export function subOf(sourceId, state) {
  const names = rowsOf(sourceId).filter((row) => ticked(state, sourceId, row)).map((row) => (sourceId === 'code' && row === LOCAL_REPOS ? reposCount(state) : shownName(row)));
  return names.length ? names.join(', ') : 'nothing picked';
}
const reposCount = (state) => { const n = localPicked(state).length; return `${n} local repo${n === 1 ? '' : 's'}`; };

/** What a row says when it needs a sign-in before it can be read (2026-10-09, board "Now-3a-Fix"). */
export const NEEDS_SIGN_IN = 'Needs sign-in';

/**
 * What a row says at its right, from how its app is reached and where it stands → { text, tone: 'muted' | 'busy' |
 * 'error' | '' }. `connectors`: app → { connected, pending } (main's connectors); `notes`: the Apple Notes prompt's state
 * ('' | 'asking' | 'allowed' | why not); `folder`: one the person picked for it.
 */
export function rowLabel(app, { found = null, connectors = {}, notes = '', folder = '', signIn = null } = {}) {
  const spec = APPS[app];
  const seen = (found && found.apps && found.apps[app]) || {};
  if (folder) return { text: folder, tone: '' };
  if (!spec) return { text: '', tone: '' };
  if (spec.reach === 'connector') {
    const status = connectors[app] || {};
    if (status.connected) return { text: 'signed in', tone: '' };
    if (status.pending) return { text: `Waiting for ${shownName(app)} sign-in…`, tone: 'busy' };
    return { text: NEEDS_SIGN_IN, tone: 'muted' };
  }
  if (spec.reach === 'automation') {
    if (notes === 'allowed') return { text: 'allowed', tone: '' };
    if (notes === 'asking') return { text: 'macOS is asking you…', tone: 'busy' };
    return notes ? { text: notes, tone: 'error' } : { text: '', tone: '' };
  }
  if (spec.reach === 'web') {
    const said = signInLabel(signIn);
    if (said) return said;
    if (seen.signedIn) return { text: 'signed in to Engelbart', tone: '' };
    return seen.found ? { text: NEEDS_SIGN_IN, tone: 'muted' } : { text: 'Not found', tone: 'muted' };
  }
  if (seen.found && seen.where === 'Sign in to add') return { text: NEEDS_SIGN_IN, tone: 'muted' }; // the scan's words for a web app found, not signed in
  return seen.found ? { text: seen.where || '', tone: '' } : { text: 'Not found', tone: 'muted' };
}

/**
 * A web app's sign-in as checked when it was ticked (2026-10-10, main's connect-signin-check): { status: 'checking' |
 * 'signed-in' | 'refused' | 'signed-out' | 'no-browser', browser } → its label, or null. A refused one offers Try again.
 */
function signInLabel(signIn) {
  if (!signIn || !signIn.status) return null;
  if (signIn.status === 'checking') return { text: 'Waiting for macOS…', tone: 'busy' };
  if (signIn.status === 'signed-in') return { text: signIn.browser ? `✓ Signed in from ${signIn.browser}` : '✓ Signed in', tone: 'ok' };
  if (signIn.status === 'signed-out') return { text: "You'll sign in after you start", tone: 'muted' };
  if (signIn.status === 'refused') return { text: "macOS didn't allow it", tone: 'error', retry: true };
  if (signIn.status === 'no-browser') return { text: `Needs ${READABLE_NAMES}`, tone: 'muted' };
  return null;
}

/**
 * The web apps ticked in `after` that were not in `before` (a row, a group's header, Select all) → [{ id, app }]: each one's
 * sign-in is checked when it is ticked (2026-10-10), not when the run starts.
 */
export function newlyTickedWeb(before, after) {
  const out = [];
  for (const source of SOURCES) {
    for (const app of source.apps) {
      if ((APPS[app] || {}).reach !== 'web') continue;
      if (ticked(after, source.id, app) && !ticked(before, source.id, app)) out.push({ id: source.id, app });
    }
  }
  return out;
}

/** Rows waiting for the person's yes before macOS is asked, by browser ({ [browser]: [{ id, app }] }), with `rows` ({ id, app, browser }) added. */
export function waitForYes(waiting, rows) {
  const out = { ...waiting };
  for (const { id, app, browser } of rows) {
    const list = out[browser] || [];
    if (!list.some((row) => row.app === app)) out[browser] = [...list, { id, app }];
  }
  return out;
}

const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/**
 * The rows whose sign-in may be checked now: none while the "Use my … subscription" consent is off (2026-10-11 review),
 * since a check copies a browser's sign-ins. `rows`: [{ id, app }].
 */
export function signInsToCheck(consent, rows) {
  return consent ? rows || [] : [];
}

/** The panels waiting for a yes (waitForYes's), kept while the consent is on; turning it off takes them away. */
export function waitingWhile(consent, waiting) {
  return consent ? waiting || {} : {};
}

/**
 * The panel shown above the permissions before a browser's sign-ins are first used (2026-10-10: say why macOS will ask
 * before it does), naming every ticked app waiting on it → { browser, rows, title, body } | null when none is still ticked.
 */
export function signInPanel(state, browser, rows = []) {
  const still = rows.filter((row) => ticked(state, row.id, row.app));
  if (!still.length) return null;
  const apps = still.map((row) => shownName(row.app));
  return {
    browser,
    rows: still,
    title: `Use your ${browser} sign-ins for ${listed(apps)}?`,
    // The line that matters most first, in bold (2026-10-11: the modal before macOS asks).
    lead: 'macOS will ask for your Mac password next. Choose Always Allow so it only asks once.',
    body: [
      `Engelbart copies only ${apps.length === 1 ? 'this app\'s sign-in' : 'these apps\' sign-ins'} from ${browser}, and only reads from ${apps.length === 1 ? 'it' : 'them'}, so you don't log in again. Not now leaves ${apps.length === 1 ? 'it' : 'them'} out.`,
    ],
  };
}

/**
 * The modal after Continue (2026-10-11): how the check of each app it named went, from `signIns` (app → { status, browser },
 * the choose screen's). → { done, title, lines, tone } — `done` false while macOS is still being asked; `tone` 'ok' when
 * every app came over, 'warn' when some did not, 'refused' when macOS said no to all.
 */
export function keychainOutcome(browser, rows, signIns) {
  // An app with no answer at all: its check failed and was cleared (checkSignIn), so it counts as not brought over.
  const of = (row) => (signIns && signIns[row.app]) || { status: 'signed-out' };
  if ((rows || []).some((row) => of(row).status === 'checking')) {
    return { done: false, title: 'Waiting for macOS…', lines: ['Enter your Mac password in the macOS window, then choose Always Allow.'], tone: 'busy' };
  }
  const names = (status) => rows.filter((row) => of(row).status === status).map((row) => shownName(row.app));
  const signedIn = names('signed-in'), refused = names('refused');
  const missing = rows.filter((row) => !['signed-in', 'refused'].includes(of(row).status)).map((row) => shownName(row.app));
  const lines = [];
  if (refused.length) lines.push(`macOS didn't allow it, so ${listed(refused)} ${refused.length === 1 ? 'was' : 'were'} unticked. Try again on ${refused.length === 1 ? 'its row' : 'their rows'} to be asked again.`);
  if (missing.length) lines.push(`${browser} isn't signed in to ${listed(missing)}. The import will ask you to log in once it starts.`);
  if (signedIn.length) {
    const title = `Signed in to ${listed(signedIn)}`;
    return { done: true, title, lines: [`Brought over from ${browser}. You won't need to log in again.`, ...lines], tone: lines.length ? 'warn' : 'ok' };
  }
  return { done: true, title: refused.length ? 'Not allowed' : 'Nothing to bring over', lines, tone: refused.length ? 'refused' : 'warn' };
}

/**
 * The line under a row's name, when it needs one: macOS asks before Apple Notes. (What asking an assistant what it
 * remembers is, the refine chat says.) Rows have no such line for web apps, so Google Drive's "Docs, Sheets, Slides and
 * files" (2026-10-10) is its row's tooltip (rowTip), not a line.
 */
export function rowSub(app) {
  if (app === 'Apple Notes') return 'macOS will ask';
  return '';
}

/** What a row's tooltip adds about what the app brings in, or ''. */
export function rowTip(app) {
  if (app === 'Gmail') return 'Only the threads you approve';
  return app === 'Google Docs' ? 'Docs, Sheets, Slides and files' : '';
}

/**
 * What the permissions card adds when Gmail is ticked (2026-10-11): the search's subjects and senders, and the threads
 * approved, which hold what other people wrote, are read by the agent's provider. `name`: the provider as the card names
 * it ("Claude Code"). '' when Gmail is not ticked.
 */
export function gmailConsent(state, name) {
  if (!ticked(state, 'email', 'Gmail')) return '';
  return `Gmail: Engelbart searches your Gmail for threads about your project. Their subjects and senders, and the threads you approve (including what other people wrote), are read by ${name || 'your AI provider'}.`;
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

// As store/projects.cjs clips them: a project's name to 200 characters, its description to MAX_DESCRIPTION.
const MAX_NAME = 200;
const MAX_DESCRIPTION = 4000;

/** The project Connect's librarian is told about: { name, description } trimmed and clipped, or null when both are empty. */
export function projectOf(project) {
  if (!project) return null;
  const name = String(project.name || '').trim().slice(0, MAX_NAME);
  const description = String(project.description || '').trim().slice(0, MAX_DESCRIPTION);
  return name || description ? { name, description } : null;
}

/**
 * What `connect-start` is sent: each source on or off with its apps, folders and repositories; the instructions; the
 * permissions; the provider; the project an existing user's notes go into (`projectId`); and what the project is
 * (`project` { name, description }, 2026-10-10), which onboarding sends without an id; and how far back to look (`days`
 * 182 or 365, null for all time, 2026-10-10), always sent.
 */
export function choicesOf({ picks, apps, folders = {}, repos = [], custom = '', permissions = {}, provider = null, projectId = null, workspaceId = null, project = null, days = null }) {
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
  return { sources, custom: String(custom || '').trim(), computer: allowed.files, permissions: allowed, days: cleanDays(days), ...(provider ? { provider } : {}), ...(projectId ? { projectId } : {}), ...(projectId && workspaceId ? { workspaceId } : {}), ...(projectOf(project) ? { project: projectOf(project) } : {}) };
}

/**
 * The onboarding session to pick up again when onboarding opens after a quit: one begun from onboarding, with no project
 * id (an id makes a session an existing user's), not stopped or put away.
 */
export function resumable(list) {
  return (list || []).find((entry) => entry.mode === 'onboarding' && !entry.projectId && !entry.stopped && !entry.dismissed) || null;
}

/**
 * Where what came in went (2026-10-11), for a session started from a project: `placed` { project, workspace }, the rows
 * on the project's own list and those also in the workspace it was started from. '' before anything went in.
 */
export function placedLine(session) {
  const placed = session && session.projectId && session.placed;
  if (!placed || !placed.project) return '';
  const head = `${placed.project} added to the project.`;
  if (!placed.workspace) return head;
  return placed.workspace < placed.project ? `${head} The first ${placed.workspace} are also in this workspace.` : `${head} ${placed.project === 1 ? 'It is' : 'They are'} also in this workspace.`;
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
// What each source is, under a row of onboarding's "Bringing everything in" when its label says nothing more.
const WORK_SUBS = { notes: 'Notes', transcripts: 'Meeting transcripts', email: 'Email threads', chats: 'AI chats', sites: 'Pages from your browser history', papers: 'Papers', code: 'Repositories' };
const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * A row of onboarding's "Bringing everything in" (2026-10-09, David's mockup): the apps it reads ("Google Meet and Zoom"),
 * under them what it brings in (the label after its colon, else what the source is), and at its right where it stands:
 * "Adding · 65 so far", "Adding…", "Queued", "✓ 11 added". → { title, sub, status: { text, done, failed, waiting, going } }
 */
export function workRow(job) {
  const label = String(job.label || '');
  const at = label.indexOf(':');
  const head = (at >= 0 ? label.slice(0, at) : label).trim();
  const tail = at >= 0 ? label.slice(at + 1).trim() : '';
  const ids = (job.apps || []).filter(Boolean);
  const apps = ids.map(shownName);
  const title = apps.length ? andList(apps) : head || label;
  // The label's tail names the apps again (main writes them shown; a session saved before 2026-10-10, by their ids).
  const own = tail && tail !== apps.join(', ') && tail !== ids.join(', ') && tail !== title ? tail : '';
  const kindSub = job.kind === 'survey' ? 'Looking through it' : job.kind === 'recall' ? 'What it remembers about you' : WORK_SUBS[job.source] || '';
  const sub = own ? own[0].toUpperCase() + own.slice(1) : kindSub !== title ? kindSub : '';
  const n = (job.notes || 0) + (job.items || 0);
  const going = job.status === 'running';
  let status;
  if (job.skipped) status = { text: 'Skipped', done: true };
  else if (job.status === 'done') status = { text: job.kind === 'import' ? `✓ ${n} added` : job.kind === 'recall' ? '✓ Remembered' : '✓ Looked', done: true };
  else if (job.status === 'failed') status = { text: n ? `Stopped after ${n}` : 'Failed', done: true, failed: true };
  else if (job.status === 'stopped') status = { text: n ? `Stopped · ${n} added` : 'Stopped', done: true };
  else if (job.status === 'waiting') status = { text: 'Needs you', done: false, waiting: true };
  else if (going) status = { text: job.kind === 'import' ? (n ? `Adding · ${n} so far` : 'Adding…') : job.kind === 'recall' ? 'Asking…' : 'Looking…', done: false };
  else status = { text: 'Queued', done: false };
  return { title, sub, status: { done: false, failed: false, waiting: false, ...status, going } };
}

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

/**
 * The line at the foot of onboarding's chat and progress (2026-10-09, David's mockup): "Bringing in 2 sources · 3 of 10 ·
 * 2 need you". How many imports are still going, how many of the work's jobs have ended, and the steps waiting on the
 * person. '' before anything was dispatched.
 */
export function footLine(session) {
  if (!session) return '';
  const jobs = workJobs(session.jobs);
  const importing = jobs.filter((job) => job.kind === 'import' && !statusOf(job).done).length;
  const ended = jobs.filter((job) => statusOf(job).done).length;
  const needs = (session.needs || []).length;
  const lead = importing ? `Bringing in ${importing} source${importing === 1 ? '' : 's'}` : ended < jobs.length ? 'Looking through your apps' : jobs.length ? 'Everything looked at' : '';
  return [lead, jobs.length ? `${ended} of ${jobs.length}` : '', needs ? `${needs} need${needs === 1 ? 's' : ''} you` : ''].filter(Boolean).join(' · ');
}

/**
 * What the chat says under its last message while the person waits (the mockup's "••• Looking at your Overleaf
 * projects…"): what the librarian is doing, else the survey (or other work) it waits on, else the sign-in it waits on;
 * '' when it waits on nothing.
 */
export function chatStatus(session) {
  if (!session) return '';
  if (session.thinking) return `${session.activity || 'Thinking'}…`.replace(/……$/, '…');
  if (!session.waiting) return '';
  const going = workJobs(session.jobs).filter((job) => !statusOf(job).done && !statusOf(job).waiting);
  const survey = going.find((job) => job.kind === 'survey') || going[0];
  if (survey) return `${survey.label}…`;
  return (session.needs || []).length ? 'Waiting for your sign-in…' : 'Looking…';
}

/** What a step the agents hand the person asks of them, the button that does it, and how (`hint`, the row's line under its app). */
export function needView(need) {
  const kind = need && need.kind;
  const app = need ? shownName(need.app) : '';
  if (kind === 'connector') return { title: `${app} needs you to sign in`, action: 'Log in', hint: 'Opens in your browser · read-only' };
  if (kind === 'permission') return { title: `${app} needs your permission`, action: 'Allow', hint: 'macOS will ask' };
  if (need && (need.app === 'Zotero' || need.app === 'GitHub')) return { title: `${app} needs you to sign in`, action: 'Log in', hint: 'Opens in your browser · read-only' };
  // One button and Skip (2026-10-08: "It should just be one login button on the right ... or skip"): a sign-in opens in the
  // default browser and is brought over (main's connect/web-signin.cjs); a code or a captcha, the agent's own window.
  const what = { signin: 'sign in', '2fa': 'enter a code', password: 'sign in', captcha: 'prove you are not a robot', confirm: 'confirm something' }[kind] || 'sign in';
  const signs = kind === 'signin' || kind === 'password';
  return { title: `${app || 'An app'} needs you to ${what}`, action: signs ? 'Log in' : 'Open', hint: signs ? 'Opens in your browser · read-only' : `Opens its window to ${what}` };
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
