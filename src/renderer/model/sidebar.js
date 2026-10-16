// The workspace sidebar (2026-10-07, Hudson's "Sidebar" workspace: the hand-drawn mockup, Iconography, Linear's "Your
// teams"). Pure: the project's tree, state.json's `recent` and `agents`, the Builds and the workspace's rows come in; what
// each part of the sidebar lists goes out. Rail.jsx draws it.
//
// From the top: the project's name (its menu switches project or renames it) with Settings and Search; Inbox, Agents,
// Connections, Library and Add sources, fixed in place; Workspaces, the three worked in last, each opening onto its
// sub-workspaces; Your sources, this workspace's things under Starred and Notes, then the websites, code and files mixed; and at the
// foot the stickies' Show / Hide. Every section keeps to its share of the sidebar: what does not fit is behind "More",
// which lists everything in a panel beside the sidebar.

import { hasTag, isNote } from './kind.js';

/* ----------------------------------------------------------- your sources */

/**
 * "Your sources", in order: two subsections, Starred (what is starred in this project, of any kind) and Notes, always open
 * (Hudson, 2026-10-08), then everything else, websites, code and files mixed together under no heading of their own.
 */
export const SOURCE_GROUPS = Object.freeze([
  { key: 'starred', label: 'Starred' },
  { key: 'notes', label: 'Notes' },
  { key: 'other', label: 'Sources', header: false },
]);

/**
 * What a row of this workspace is: a note; a repository, which is Code whether it is an address or a clone; a website; and
 * everything else (papers, pages and documents on disk, folders, data, pictures) is a file. The sidebar draws each its own
 * icon, and sorts the last three into one list (sourceGroup).
 */
export function sourceKind(row) {
  if (isNote(row)) return 'notes';
  if (hasTag(row, 'git')) return 'code';
  if (row.type === 'website') return 'websites';
  return 'files';
}

/** Which of SOURCE_GROUPS a row of this workspace sorts into (never Starred: that one is by star): 'notes' or 'other'. */
export const sourceGroup = (row) => (sourceKind(row) === 'notes' ? 'notes' : 'other');

/**
 * The groups with their rows: this workspace's rows by group (in their own order), and Starred, the starred ids (oldest
 * first) as the library has them, wherever they are; a star whose row is gone is left out. → [{ key, label, header?, rows }]
 */
export function sourceGroups(rows, starredIds = [], library = []) {
  const by = new Map(SOURCE_GROUPS.map((group) => [group.key, []]));
  for (const row of rows) by.get(sourceGroup(row)).push(row);
  const known = new Map([...library, ...rows].map((row) => [row.id, row]));
  by.set('starred', starredIds.map((id) => known.get(id)).filter(Boolean));
  return SOURCE_GROUPS.map((group) => ({ ...group, rows: by.get(group.key) }));
}

/* ------------------------------------------------------------- the budget */

/**
 * How many rows each group shows when they share `room` lines (a section keeps to its share of the sidebar: Hudson,
 * "if they are expanded they cannot extend past their section"). The groups are always open. A group with a heading
 * (`header` not false) spends a line on it, and on "None yet" when it holds nothing; a group shows its rows, at least one
 * and at most `cap`, and a "More" line under them when any are left out. Past the first, rows are dealt out one at a
 * time, group by group, so each group shows a few before any shows many. `groups`: [{ key, count, header? }].
 * → { shown: { key: n }, more: { key: bool }, lines, fits }; `fits` is false when not even that first row each has
 * room (the section scrolls then, rather than show a "More" alone).
 */
export function fitGroups(groups, room, { cap = 5 } = {}) {
  const shown = {}, more = {};
  let lines = 0;
  const open = [];
  for (const group of groups) {
    const headed = group.header !== false;
    if (headed) lines += 1;
    shown[group.key] = 0;
    more[group.key] = false;
    if (!group.count) { if (headed) lines += 1; continue; } // its "None yet"
    shown[group.key] = 1;
    more[group.key] = group.count > 1;
    lines += more[group.key] ? 2 : 1;
    open.push(group);
  }
  const fits = lines <= room;
  let grew = fits;
  while (grew) {
    grew = false;
    for (const group of open) {
      const n = shown[group.key];
      if (n >= Math.min(group.count, cap)) continue;
      const last = n + 1 === group.count; // the last row takes the "More" line's place
      const cost = last ? 0 : 1;
      if (lines + cost > room) continue;
      shown[group.key] = n + 1;
      more[group.key] = !last;
      lines += cost;
      grew = true;
    }
  }
  return { shown, more, lines, fits };
}

/* ------------------------------------------------------------- workspaces */

const time = (iso) => { const at = Date.parse(iso || ''); return Number.isNaN(at) ? 0 : at; };

/**
 * When each workspace was last worked in, by id: its document saved (the tree's `edited`) or a note typed in while it was
 * open (state.json `recent`, this project's), whichever is later. `within` is the same for the workspace and everything
 * nested in it. → { own: Map, within: Map } of ms.
 */
export function workspaceActivity(roots, recent = []) {
  const own = new Map(), within = new Map();
  const typed = new Map();
  for (const entry of recent) if (entry && entry.workspaceId) typed.set(entry.workspaceId, Math.max(typed.get(entry.workspaceId) || 0, time(entry.at)));
  const walk = (node) => {
    const mine = Math.max(time(node.edited), typed.get(node.id) || 0);
    own.set(node.id, mine);
    let most = mine;
    for (const child of node.children || []) most = Math.max(most, walk(child));
    within.set(node.id, most);
    return most;
  };
  for (const root of roots || []) walk(root);
  return { own, within };
}

/** The workspaces from a root down to `id` ([root, …, it]), or [] when it is not in the tree. */
export function pathTo(roots, id) {
  const walk = (list, above) => {
    for (const node of list || []) {
      const here = [...above, node];
      if (node.id === id) return here;
      const deeper = walk(node.children, here);
      if (deeper) return deeper;
    }
    return null;
  };
  return (id && walk(roots, [])) || [];
}

/**
 * Workspaces (Hudson: "List last three edited workspaces"): the project's workspaces worked in last, at the top level, by
 * what was done in them or in anything nested in them, newest first, and the one open here always among them (it takes the
 * last place when it would not be). Each comes with its sub-workspaces, the ones worked in last first (only children: no
 * grandchildren in the sidebar). Ties keep the tree's order.
 * → [{ node, at, children: [{ node, at }], holdsHere }]
 */
export function recentWorkspaces({ roots = [], recent = [], hereId = null, count = 3 }) {
  const { own, within } = workspaceActivity(roots, recent);
  const order = (list, times) => (list || []).map((node, i) => ({ node, i, at: times.get(node.id) || 0 })).sort((a, b) => b.at - a.at || a.i - b.i);
  const ranked = order(roots, within);
  const top = pathTo(roots, hereId)[0] || null;
  let picked = ranked.slice(0, count);
  if (top && !picked.some((entry) => entry.node.id === top.id)) picked = [...picked.slice(0, Math.max(0, count - 1)), ranked.find((entry) => entry.node.id === top.id)].sort((a, b) => b.at - a.at || a.i - b.i);
  return picked.map(({ node, at }) => ({
    node,
    at,
    holdsHere: !!top && top.id === node.id,
    children: order(node.children, within).map((entry) => ({ node: entry.node, at: Math.max(own.get(entry.node.id) || 0, entry.at) })),
  }));
}

/**
 * How many sub-workspaces each open workspace row shows in `room` lines, dealt out one at a time, row by row (the
 * Workspaces section is a fixed size: Hudson, "everything not shown at once"). A row holding the workspace open here shows
 * the child on its way to it first. `rows`: [{ id, open, count }]. → { [id]: n }
 */
export function fitChildren(rows, room) {
  const shown = Object.fromEntries(rows.map((row) => [row.id, 0]));
  let left = room, grew = true;
  while (grew && left > 0) {
    grew = false;
    for (const row of rows) {
      if (!row.open || shown[row.id] >= row.count || left <= 0) continue;
      shown[row.id] += 1;
      left -= 1;
      grew = true;
    }
  }
  return shown;
}

/** Every workspace of the tree, and how many there are. */
export const countWorkspaces = (roots) => (roots || []).reduce((n, node) => n + 1 + countWorkspaces(node.children), 0);

/* ------------------------------------------------------------ inbox, agents */

const AGENT_DID = { bart: 'Bart answered', brainstorm: 'Brainstorm asked', discover: 'Discover found reading', create: 'Create made a file', build: 'Build finished a turn' };
export const AGENT_NAME = { bart: 'Bart', brainstorm: 'Brainstorm', discover: 'Discover', create: 'Create', build: 'Build' };

/**
 * The Inbox: this project's agents that finished in a workspace and wait for you to look (state.json `agents`, `waiting`),
 * newest first. Looking at the workspace clears them (main: seenAgents). A post-it's quick task has no workspace: its card
 * says where it stands (and Agents lists it), as ⌘J leaves it out. → [{ id, kind, workspaceId, name, did, at }]
 */
export function inboxEntries(agents = [], projectId) {
  return agents
    .filter((agent) => agent.status === 'waiting' && agent.projectId === projectId && agent.workspaceId)
    .map((agent) => ({ id: agent.id, kind: agent.kind, workspaceId: agent.workspaceId || null, name: agent.name || '', did: AGENT_DID[agent.kind] || 'An agent finished', at: agent.finished || agent.started || null }))
    .sort((a, b) => time(b.at) - time(a.at));
}

// A Build's state, in the words its card uses (workspace/DocEditor.jsx BUILD_STATUS).
export const BUILD_STATE = { 'setting-up': 'Setting up', queued: 'Waiting for a slot', running: 'Working', 'needs-you': 'Needs you', review: 'Ready to review', stopped: 'Stopped', failed: 'Failed', escalated: 'Too big for a quick task', interrupted: 'Interrupted', accepting: 'Accepting', conflict: 'Conflict', accepted: 'Accepted', discarded: 'Discarded' };
const BUILD_WORKING = new Set(['setting-up', 'queued', 'running', 'accepting']);
const BUILD_DONE = new Set(['accepted', 'discarded']);
const DONE_SHOWN = 12;

/**
 * Agents (Cursor's and Codex's lists: what is running, what waits, what is done): the questions asked inline that are still
 * running (state.json `agents`: Bart, Brainstorm, Discover), and the project's Builds by where they stand. A Build's own
 * turns are its record's, not repeated from `agents`. Newest first in each group; Done keeps the last few.
 * → { running: [entry], waiting: [entry], done: [entry] }, entry { id, kind, title, workspaceId, state, at, task? }
 */
export function agentGroups({ agents = [], builds = [], projectId }) {
  const running = [], waiting = [], done = [];
  for (const agent of agents) {
    if (agent.projectId !== projectId || agent.status !== 'running' || agent.kind === 'build') continue;
    running.push({ id: `agent:${agent.id}`, kind: agent.kind, title: AGENT_NAME[agent.kind] || 'Agent', workspaceId: agent.workspaceId || null, state: 'Working', at: agent.started });
  }
  for (const task of builds) {
    if (!task || task.projectId !== projectId) continue;
    const entry = { id: `build:${task.id}`, kind: task.kind === 'quick' ? 'quick' : 'build', title: task.title || 'Untitled Build', workspaceId: task.workspaceId || null, state: BUILD_STATE[task.status] || task.status, at: task.updated || task.created, task };
    if (BUILD_WORKING.has(task.status)) running.push(entry);
    else if (BUILD_DONE.has(task.status)) done.push(entry);
    else waiting.push(entry);
  }
  const newest = (a, b) => time(b.at) - time(a.at);
  return { running: running.sort(newest), waiting: waiting.sort(newest), done: done.sort(newest).slice(0, DONE_SHOWN) };
}

/** How long ago, in words: "just now", "4 min ago", "2 h ago", "3 d ago"; '' for no time. */
export function sinceWords(iso, now = Date.now()) {
  const then = time(iso);
  if (!then) return '';
  const minutes = Math.floor(Math.max(0, now - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (60 * 24))} d ago`;
}

/* ---------------------------------------------------------------- archived */

/**
 * Every workspace's archived versions (one per Clear), newest first, for "See archived workspaces" (requirement 7).
 * → [{ workspaceId, name, file, title, clearedAt }]
 */
export function archivedVersions(roots) {
  const out = [];
  const walk = (list) => {
    for (const node of list || []) {
      out.push(...versionsOf(node));
      walk(node.children);
    }
  };
  walk(roots);
  return out.sort((a, b) => time(b.clearedAt) - time(a.clearedAt));
}

/** One workspace's own archived versions (not its sub-workspaces'), newest first, shown indented under it in the sidebar. */
export function versionsOf(node) {
  return (node.archives || [])
    .map((entry) => ({ workspaceId: node.id, name: node.name, file: entry.file, title: entry.title || 'Untitled', clearedAt: entry.clearedAt || null }))
    .sort((a, b) => time(b.clearedAt) - time(a.clearedAt));
}

/* ===================================================== the redone sidebar */

// 2026-10-13, the "Sidebar" project and its mockup (design/sidebar-mockup/Sidebar.html, "exactly how I want it"). What
// were workspaces are projects now, nested under the top-level project the switcher picks, four levels in all: level 1 the
// switcher's, levels 2 to 4 the Projects section's (roots are level 2). The section shows at most three level-2 projects,
// a stable shortlist that a click never reorders, and ten rows in all, counting what is open under them and every More;
// a group of siblings shows five, or four and More; one path is open at a time. Every row counts the agents running or
// waiting under it, each agent once.

export const MAX_DEPTH = 4;
export const ROOT_ROWS = 3;
export const PROJECT_ROWS = 10;
export const LEVEL_ROWS = 5;
export const RECENT_PAGES = 10;
export const SHORTCUTS = 9;

/**
 * Every project of the tree by id: { node, parent (an id or null), level (2 at the top of the section), path (ids from
 * level 2 down to it) }.
 */
export function indexTree(roots) {
  const index = new Map();
  const walk = (list, parent, level, above) => {
    for (const node of list || []) {
      const path = [...above, node.id];
      index.set(node.id, { node, parent, level, path });
      walk(node.children, node.id, level + 1, path);
    }
  };
  walk(roots, null, 2, []);
  return index;
}

const kidsOf = (index, id) => ((index.get(id) || {}).node || {}).children || [];
const childIds = (index, id) => kidsOf(index, id).map((child) => child.id);

/** Whether `id` is `from` or lies under it. */
export function within(index, id, from) {
  const at = index.get(id);
  return !!at && at.path.includes(from);
}

/** What is open when `id` is gone to: the way down to it, and it too when it has projects in it. Everything else folds. */
export function openPath(index, id) {
  const at = index.get(id);
  if (!at) return new Set();
  const open = new Set(at.path);
  if (!kidsOf(index, id).length) open.delete(id);
  return open;
}

/** A chevron's press: open folds what is under it; folded opens, folding its siblings and what is under them ("If I expand this, subproject 3 should auto-collapse"). */
export function toggleOpen(index, expanded, id) {
  const next = new Set(expanded);
  const at = index.get(id);
  if (!at) return next;
  if (next.has(id) && kidsOf(index, id).length) {
    for (const held of [...next]) if (within(index, held, id)) next.delete(held);
    return next;
  }
  const siblings = at.parent ? childIds(index, at.parent) : [...index.values()].filter((entry) => entry.level === 2).map((entry) => entry.node.id);
  for (const sibling of siblings) if (sibling !== id) for (const held of [...next]) if (within(index, held, sibling)) next.delete(held);
  next.add(id);
  return next;
}

/**
 * The level-2 projects the section shows (at most `rootRows`), in the tree's order. `held` is the shortlist as it was (kept
 * by the sidebar), so a click never moves a row: a project reached from elsewhere (More, a search, ⌘J) takes the last
 * place; an empty place is filled by the project worked in last (`recency`: id → ms, for everything within it).
 */
export function projectSlots({ roots = [], index, focusId = null, held = null, recency = new Map(), rootRows = ROOT_ROWS }) {
  const tops = (roots || []).map((node) => node.id);
  const branch = focusId && index.get(focusId) ? index.get(focusId).path[0] : null;
  let slots = (held || []).filter((id) => tops.includes(id));
  if (branch && !slots.includes(branch)) slots = [...slots.slice(0, rootRows - 1), branch];
  if (slots.length < rootRows) {
    const rest = tops.filter((id) => !slots.includes(id)).map((id, i) => ({ id, i, at: recency.get(id) || 0 })).sort((a, b) => b.at - a.at || a.i - b.i);
    slots = [...slots, ...rest.slice(0, rootRows - slots.length).map((entry) => entry.id)];
  }
  return tops.filter((id) => slots.includes(id)).slice(0, rootRows);
}

/**
 * The section's rows (the mockup's sectionPlan). `order`: the shortlist (projectSlots); `expanded`: what is open. Siblings
 * are dealt rows before what is under them, in the tree's order, so opening a deep project never pushes its earlier
 * siblings out to make room for its children; what does not fit is behind a More. A group of more than `levelRows`
 * siblings shows one fewer and More. → { order, shown: Set, hidden (level-2 ids behind the section's More), visible (ids
 * in the order drawn), opened (Set: open rows that show some of what is in them), guide (the deepest of those: the one
 * whose children get the guide line), rows (lines used) }
 */
export function projectPlan({ index, order, expanded, rows: budget = PROJECT_ROWS, levelRows = LEVEL_ROWS }) {
  const isOpen = (id) => expanded.has(id) && kidsOf(index, id).length > 0;
  const tops = [...index.values()].filter((entry) => entry.level === 2).map((entry) => entry.node.id);
  const shown = new Set(order);
  const hidden = tops.filter((id) => !shown.has(id));
  const visible = (id) => index.get(id).path.slice(0, -1).every((above) => isOpen(above));
  const lines = () => {
    let count = shown.size + (hidden.length ? 1 : 0);
    for (const id of shown) {
      const kids = childIds(index, id), seen = kids.filter((kid) => shown.has(kid)).length;
      if (isOpen(id) && seen > 0 && seen < kids.length) count += 1; // its More
    }
    return count;
  };
  const candidates = [];
  const add = (ids) => { for (const id of ids) if (!candidates.includes(id)) candidates.push(id); };
  const visit = (id) => { if (isOpen(id)) { add(childIds(index, id)); childIds(index, id).forEach(visit); } };
  order.forEach(visit);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of candidates) {
      const at = index.get(id);
      if (shown.has(id) || !visible(id) || !shown.has(at.parent)) continue;
      const siblings = childIds(index, at.parent);
      const limit = siblings.length > levelRows ? levelRows - 1 : levelRows;
      if (siblings.filter((sibling) => shown.has(sibling)).length >= limit) continue;
      shown.add(id);
      if (lines() > budget) shown.delete(id); else grew = true;
    }
  }
  const drawn = [];
  const opened = new Set();
  const walk = (id) => {
    drawn.push(id);
    if (!isOpen(id)) return;
    const kids = childIds(index, id).filter((kid) => shown.has(kid));
    if (kids.length) opened.add(id);
    kids.forEach(walk);
  };
  order.forEach(walk);
  const guide = [...opened].sort((a, b) => index.get(b).level - index.get(a).level)[0] || null;
  return { order, shown, hidden, visible: drawn, opened, guide, rows: lines() };
}

/** Ctrl+1–9: the level-2 projects, in the tree's order (each top-level project has its own). → [id] */
export const shortcutProjects = (roots) => (roots || []).slice(0, SHORTCUTS).map((node) => node.id);

/** A level-2 project's number for Ctrl+number, or 0. */
export function shortcutOf(roots, id) {
  const at = shortcutProjects(roots).indexOf(id);
  return at >= 0 ? at + 1 : 0;
}

/* ------------------------------------------------------- agents and counts */

const BUILD_RUNNING = new Set(['setting-up', 'queued', 'running', 'accepting']);
const BUILD_NEEDS = new Set(['needs-you', 'review']);
const BUILD_FAILED = new Set(['failed', 'conflict', 'interrupted', 'escalated']);
/** A Build's place in the Agents list: running, needs (waits on you: a question, or a review), failed, or done. */
export function buildState(status) {
  if (BUILD_RUNNING.has(status)) return 'running';
  if (BUILD_NEEDS.has(status)) return 'needs';
  if (BUILD_FAILED.has(status)) return 'failed';
  return 'done';
}

/**
 * The Agents list, the Inbox folded into it (2026-10-13: "Combine inbox and Agents into just Agents"): this project's
 * questions asked inline (state.json `agents`: running, or finished and `waiting` for you to look, which is `unseen`), its
 * Builds by where they stand, and Connect your library's notes (`connect`: model/connect.js connectInbox's, each with its
 * dockLine `tone`). Newest first.
 * → [{ id, kind, title, node (the project it is in, or null), state: running|needs|unseen|failed|done, at, task?, sessionId? }]
 */
export function agentEntries({ agents = [], builds = [], connect = [], projectId }) {
  const out = [];
  for (const agent of agents) {
    if (!agent || agent.projectId !== projectId || agent.kind === 'build') continue;
    if (agent.status !== 'running' && agent.status !== 'waiting') continue;
    out.push({ id: `agent:${agent.id}`, kind: agent.kind, title: AGENT_NAME[agent.kind] || 'Agent', node: agent.workspaceId || null, doc: agent.doc || null, state: agent.status === 'running' ? 'running' : 'unseen', at: agent.status === 'running' ? agent.started : (agent.finished || agent.started) });
  }
  for (const task of builds) {
    if (!task || task.projectId !== projectId) continue;
    out.push({ id: `build:${task.id}`, kind: task.kind === 'quick' ? 'quick' : 'build', title: task.title || 'Untitled Build', node: task.workspaceId || null, state: buildState(task.status), status: BUILD_STATE[task.status] || task.status, at: task.updated || task.created, task });
  }
  for (const note of connect) {
    if (!note) continue;
    out.push({ id: note.id, kind: 'connect', title: note.name || 'Import your context', did: note.did || '', node: null, state: note.tone === 'warn' || note.tone === 'needs' ? 'needs' : 'unseen', at: note.at || null, sessionId: note.sessionId });
  }
  return out.sort((a, b) => time(b.at) - time(a.at));
}

/**
 * The repositories' builds the bell held (ui/SandboxNotifications.jsx), as rows of Agents among the rest (2026-10-16:
 * "Repositories should not have its own section"): Building… runs, a failed build failed, a finished one is to look at
 * until it is read. `rows`: the notifications still shown; `items`: library id → { run, sandbox }.
 * → [{ id, kind: 'repo', title, node: null, state, at, viewed?, notification, run, sandbox, repo }]
 */
export function repoEntries(rows = [], items = {}, library = []) {
  const out = [];
  for (const notification of rows) {
    const item = (items || {})[notification.libraryId];
    const run = item && item.run;
    if (!run) continue;
    const repo = library.find((row) => row.id === notification.libraryId) || null;
    const state = run.status === 'starting' ? 'running' : run.status === 'failed' ? 'failed' : 'unseen';
    out.push({ id: `repo:${notification.id}`, kind: 'repo', title: (repo && repo.name) || 'Repository', node: null, state, at: notification.at, ...(notification.read && state !== 'running' ? { viewed: true } : {}), notification, run, sandbox: item.sandbox ?? null, repo });
  }
  return out;
}

export const READY_STATES = new Set(['needs', 'unseen', 'failed']);

/** One count for a list of agents: the running ones and the ones to look at (needs you, finished unseen, failed), less the ones already clicked (`viewed`). */
export function summarize(list = []) {
  let running = 0, ready = 0;
  for (const entry of list) {
    if (entry.state === 'running') running += 1;
    else if (READY_STATES.has(entry.state) && !entry.viewed) ready += 1;
  }
  return { total: running + ready, running, ready };
}

// How long an agent stays in Agents (2026-10-16, Hudson: no "Earlier" section; "it should just like go away after 3d or
// after 1d of me clicking on it"). One still running stays.
export const AGENT_KEPT_MS = 3 * 24 * 60 * 60 * 1000;
export const AGENT_CLICKED_MS = 24 * 60 * 60 * 1000;
const MARKS_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** A row of Agents clicked or put away with its ×: `marks` { [entry id]: { clicked?, dismissed? } } with that one's time set; marks older than a week are dropped. */
export function markAgent(marks = {}, id, what, at = new Date().toISOString()) {
  const now = time(at);
  const out = {};
  for (const [key, mark] of Object.entries(marks || {})) {
    if (!mark || typeof mark !== 'object') continue;
    if (Math.max(time(mark.clicked), time(mark.dismissed)) >= now - MARKS_KEPT_MS) out[key] = mark;
  }
  out[id] = { ...(out[id] || {}), [what]: at };
  return out;
}

/**
 * What Agents shows: no row put away with its × since it last changed, and no row that is not running once it is three days old or a day past
 * the click. A row clicked since it last changed (its `at`) is `viewed`: it has been looked at, so it no longer asks to be
 * (no dot, out of the counts and of ⌘J); one clicked while it ran and finished since is new again.
 */
export function keptAgents(entries = [], marks = {}, now = Date.now()) {
  const out = [];
  for (const entry of entries) {
    const mark = (marks && marks[entry.id]) || {};
    if (mark.dismissed && time(mark.dismissed) >= time(entry.at)) continue; // put away; back if it changes again
    const clicked = time(mark.clicked) >= time(entry.at) ? time(mark.clicked) : 0;
    if (entry.state !== 'running') {
      if (entry.at && now - time(entry.at) > AGENT_KEPT_MS) continue;
      if (clicked && now - clicked > AGENT_CLICKED_MS) continue;
    }
    out.push(clicked ? { ...entry, viewed: true } : entry);
  }
  return out;
}

/**
 * Each project's count, with everything under it (a parent's total counts each agent once, open or folded): id → summary.
 * Agents in no project are left out (they count on the Agents row only).
 */
export function rollUp(index, entries = []) {
  const lists = new Map();
  for (const entry of entries) {
    const at = entry.node && index.get(entry.node);
    if (!at) continue;
    for (const id of at.path) { if (!lists.has(id)) lists.set(id, []); lists.get(id).push(entry); }
  }
  const out = new Map();
  for (const [id, list] of lists) out.set(id, summarize(list));
  return out;
}

/** The count of several projects together (a More's), each agent once. */
export function summaryOf(index, entries, ids) {
  const set = new Set(ids);
  return summarize(entries.filter((entry) => entry.node && index.get(entry.node) && index.get(entry.node).path.some((id) => set.has(id))));
}

/** A count as it is drawn: at most "9+". */
export const countLabel = (n) => (n > 9 ? '9+' : String(n));
/** The library's size beside Library: at most "999+". */
export const libraryLabel = (n) => (n > 999 ? '999+' : String(n));

/* ------------------------------------------------------------ recent pages */

/**
 * The clock's list (2026-10-13: "the last ten (or less) opened notes or projects"): the top-level project's page first,
 * then the pages opened last, newest first, once each: projects of this top-level project still in its tree and notes
 * still in the library. `visits`: [{ kind: 'project'|'note', id, at }], any order.
 * → [{ kind: 'top'|'project'|'note', id }]
 */
export function recentPages({ visits = [], index, notes = new Map(), count = RECENT_PAGES }) {
  const out = [{ kind: 'top', id: 'top' }];
  const seen = new Set();
  for (const visit of [...visits].sort((a, b) => time(b.at) - time(a.at))) {
    if (out.length >= count) break;
    const key = `${visit.kind}:${visit.id}`;
    if (seen.has(key)) continue;
    if (visit.kind === 'project' ? !index.has(visit.id) : visit.kind === 'note' ? !notes.has(visit.id) : true) continue;
    seen.add(key);
    out.push({ kind: visit.kind, id: visit.id });
  }
  return out;
}

/** A visit recorded: it moves to the front; the list keeps `max`. */
export function visited(visits = [], page, at = new Date().toISOString(), max = 60) {
  return [{ kind: page.kind, id: page.id, at }, ...visits.filter((held) => !(held.kind === page.kind && held.id === page.id))].slice(0, max);
}

/** A crumb cut from the front, a level at a time, to "./": ["Engelbart", "User Interface"] → "./User Interface". */
export function crumbFrom(parts, dropped) {
  if (!dropped) return parts.join('/');
  return `./${parts.slice(dropped).join('/')}`;
}

/* ----------------------------------------------------------------- sources */

/** A source's icon (2026-10-13: "image attachments have the image icon, html have code icon, websites have website icon"). */
export function sourceIcon(row) {
  if (!row) return 'file';
  if (isNote(row)) return 'note';
  if (hasTag(row, 'git')) return 'git';
  if (row.type === 'website') return 'website';
  if (row.type === 'image') return 'image';
  if (row.type === 'html') return 'html';
  if (row.type === 'pdf') return 'pdf';
  if (row.type === 'folder') return 'folder';
  return 'file';
}

/**
 * A project's own folder, the source opened or looked at last first (2026-10-16, Hudson: "the most recently opened/viewed
 * notes/images/sources should be shown at the top … right now i think it is in order added"): by when each was last
 * opened (`opened`: id → ISO time), or when it came into the library if it never was; ties keep their order.
 */
export function byOpened(rows = [], opened = {}) {
  const when = (row) => Math.max(time((opened || {})[row.id]), time(row.created));
  return rows.map((row, i) => ({ row, i, at: when(row) })).sort((a, b) => b.at - a.at || a.i - b.i).map((entry) => entry.row);
}

/** An opening remembered: `opened` with `id` at `at`, keeping the `max` newest. */
export function noteOpened(opened = {}, id, at = new Date().toISOString(), max = 400) {
  const next = { ...(opened || {}), [id]: at };
  const ids = Object.keys(next);
  if (ids.length <= max) return next;
  return Object.fromEntries(ids.sort((a, b) => time(next[b]) - time(next[a])).slice(0, max).map((key) => [key, next[key]]));
}

/** A folder's rows as the sidebar draws them: five, or four and More. → { shown, more } */
export function folderRows(rows, cap = LEVEL_ROWS) {
  const shown = rows.length > cap ? rows.slice(0, cap - 1) : rows;
  return { shown, more: rows.length > shown.length };
}
