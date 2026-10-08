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

const AGENT_DID = { bart: 'Bart answered', brainstorm: 'Brainstorm asked', discover: 'Discover found reading', build: 'Build finished a turn' };
export const AGENT_NAME = { bart: 'Bart', brainstorm: 'Brainstorm', discover: 'Discover', build: 'Build' };

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
      for (const entry of node.archives || []) out.push({ workspaceId: node.id, name: node.name, file: entry.file, title: entry.title || 'Untitled', clearedAt: entry.clearedAt || null });
      walk(node.children);
    }
  };
  walk(roots);
  return out.sort((a, b) => time(b.clearedAt) - time(a.clearedAt));
}
