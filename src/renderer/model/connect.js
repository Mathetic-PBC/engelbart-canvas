// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html"), the choose screen's model. Pure:
// screens/ConnectLibrary.jsx asks what is ticked, what a row says beside it, what goes to main (src/main/connect), and
// how an import's progress reads. The sources and apps are src/shared/connect-sources.cjs.

import { SOURCES } from '../../shared/connect-sources.cjs';

export { SOURCES };

/**
 * Where the choose screen starts, from what main found on this Mac (`connect-detect`): an app is ticked when it was found,
 * a source when one of its apps was (Websites: a browser; Code: a GitHub sign-in). Nothing is open but the first ticked source.
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

/** What `connect-start` is sent: each source on or off with its apps, folders and repositories; the instructions; the model. */
export function choicesOf({ picks, apps, folders = {}, repos = [], custom = '', computer = true, pick = null }) {
  const sources = {};
  for (const source of SOURCES) {
    sources[source.id] = {
      on: !!picks[source.id],
      apps: picks[source.id] ? appsOf(source.id, apps) : [],
      folders: picks[source.id] ? (folders[source.id] || []) : [],
      repos: source.id === 'code' && picks.code ? repos : [],
    };
  }
  return { sources, custom: String(custom || '').trim(), computer: !!computer, pick };
}

/** An import's place in the progress list: its words and whether it is finished. */
export function statusOf(job) {
  const n = (job.notes || 0) + (job.items || 0);
  const added = `${n} added`;
  if (job.status === 'done') return { text: `✓ ${added}`, done: true };
  if (job.status === 'failed') return { text: n ? `stopped after ${added}` : 'failed', done: true, failed: true };
  if (job.status === 'stopped') return { text: n ? `stopped · ${added}` : 'stopped', done: true };
  if (job.status === 'running') return { text: n ? `importing… ${added}` : 'importing…', done: false };
  return { text: 'queued', done: false };
}

/** Whether every import has ended. */
export const allEnded = (jobs) => (jobs || []).every((job) => statusOf(job).done);
