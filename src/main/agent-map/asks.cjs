'use strict';

// The Agent Viewer's asks (2026-10-12): the run log's records (../bart/runlog.cjs) grouped one entry per thing the person
// asked. An `@bart` line is the router's record and the run it handed the line to (`routedFrom`), or every turn of the
// Build it started (`handedTo: build:<id>`) with their run steps; a line asked of an agent directly, a follow-up, a Build
// from a line, the Build panel or a post-it is an entry of its own. No record is ever left out: one of an agent the Viewer
// does not know is an entry under its own name.

// The token each internal agent is known by: 'bart' is @chat since the router took @bart (../bart/route.cjs).
const TOKEN_OF = { router: 'bart', bart: 'chat', brainstorm: 'brainstorm', discover: 'discover', create: 'create', build: 'build', 'run step': 'run step' };
const routedName = (agent) => (agent === 'bart' ? 'chat' : agent === 'run step' ? 'build' : String(agent || 'unknown'));
const BUILDISH = new Set(['build', 'run step']);

const atOf = (record) => (Number.isFinite(record && record.at) ? record.at : 0);
const byAt = (a, b) => atOf(a) - atOf(b);

/** One entry's status: running while any of its records runs, else that of its last. */
function statusOf(records) {
  if (records.some((record) => record.status === 'running')) return 'running';
  const last = [...records].sort(byAt).pop();
  return last ? last.status || 'done' : 'done';
}

/** How a line reached its agent when the router did not pick: what the Viewer's second section says. */
function viaOf(first, records) {
  if (first.agent === 'router') return 'router';
  if (!BUILDISH.has(first.agent)) return 'direct';
  const build = records.find((record) => record.agent === 'build') || first;
  if (build.kind === 'quick') return 'post-it';
  const place = records.map((record) => record.place).find(Boolean);
  if (!place || place.line == null) return 'panel';
  return /(^|\s)--build\b/.test(String(place.text || '')) ? '--build' : 'button';
}

/**
 * The entries, newest first: { id, at, text, place, routedTo, status, via, kind, buildId, records } where `records` are
 * the ids of its records in the order they started, `kind` is 'build' or 'question' (the list's filter) and `buildId` the
 * Build's, when it started one.
 */
function groupAsks(list) {
  const records = (Array.isArray(list) ? list : []).filter((record) => record && typeof record.id === 'string');
  const claimed = new Set();
  const builds = new Map(); // buildId → its turns and run steps
  for (const record of records) {
    if (!BUILDISH.has(record.agent) || !record.buildId) continue;
    if (!builds.has(record.buildId)) builds.set(record.buildId, []);
    builds.get(record.buildId).push(record);
  }
  const routedTo = new Map(); // router id → the asks it handed over
  for (const record of records) {
    if (record.agent === 'router' || !record.routedFrom) continue;
    if (!routedTo.has(record.routedFrom)) routedTo.set(record.routedFrom, []);
    routedTo.get(record.routedFrom).push(record);
  }
  const entries = [];
  const entry = (group, routed) => {
    const sorted = [...group].sort(byAt);
    for (const record of sorted) claimed.add(record.id);
    const first = sorted[0];
    const place = (first.agent === 'router' && first.place) || sorted.map((record) => record.place).find(Boolean) || null;
    const build = sorted.find((record) => record.agent === 'build');
    const text = place && typeof place.text === 'string' && place.text.trim() ? place.text
      : first.agent === 'router' ? first.question || ''
      : BUILDISH.has(first.agent) && (!place || place.line == null) ? (build && build.title) || first.title || first.question || ''
      : first.question || (build && build.title) || '';
    const id = first.agent === 'router' ? first.id : BUILDISH.has(first.agent) && first.buildId ? `build:${first.buildId}` : first.id;
    const buildId = (sorted.find((record) => record.buildId) || {}).buildId || null;
    entries.push({ id, at: atOf(first), text: String(text), place, routedTo: routed, status: statusOf(sorted), via: viaOf(first, sorted), kind: routed === 'build' ? 'build' : 'question', buildId, records: sorted.map((record) => record.id) });
  };
  // The router's records first: each claims what it handed over.
  for (const router of records.filter((record) => record.agent === 'router')) {
    const handed = typeof router.handedTo === 'string' && router.handedTo.startsWith('build:') ? router.handedTo.slice(6) : null;
    if (handed) { entry([router, ...(builds.get(handed) || [])], 'build'); continue; }
    const asks = (routedTo.get(router.id) || []).filter((record) => !claimed.has(record.id));
    // Asked again (Regenerate, another agent picked) the line is the same ask: every run it handed over is in its entry.
    const last = [...asks].sort(byAt).pop();
    entry([router, ...asks], last ? routedName(last.agent) : routedName(router.corrected || router.pick || 'chat'));
  }
  for (const [, group] of builds) {
    if (group.some((record) => claimed.has(record.id))) continue;
    entry(group, 'build');
  }
  for (const record of records) {
    if (claimed.has(record.id)) continue;
    entry([record], routedName(record.agent));
  }
  return entries.sort((a, b) => b.at - a.at);
}

/** The built-in system prompt an agent's record would have had: the Viewer says whether a run's was that or custom. */
function builtInPrompt(record) {
  try {
    if (record.agent === 'router') return require('../bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT;
    if (record.agent === 'build') {
      const { BUILD_SYSTEM_PROMPT, QUICK_PARAGRAPH } = require('../build/prompt.cjs');
      return record.kind === 'quick' ? `${BUILD_SYSTEM_PROMPT}\n\n${QUICK_PARAGRAPH}` : BUILD_SYSTEM_PROMPT;
    }
    const held = require('../bart/ask.cjs').PROMPTS[record.agent];
    return held ? held[1] : null;
  } catch { return null; }
}

/** 'built-in', 'custom', or null when there is none to tell (a run step's prompt is its own). */
function promptSource(record) {
  if (!record || !record.system || record.agent === 'run step') return null;
  const builtIn = builtInPrompt(record);
  if (builtIn == null) return null;
  return String(record.system).trim() === String(builtIn).trim() ? 'built-in' : 'custom';
}

/** One entry with its records whole (runLog.get), for the Viewer's right side and its export. → null when gone. */
function askOf(runLog, id) {
  if (!runLog || typeof id !== 'string') return null;
  const found = groupAsks(runLog.list()).find((held) => held.id === id);
  if (!found) return null;
  const records = found.records.map((key) => runLog.get(key)).filter(Boolean).map((record) => {
    const source = promptSource(record);
    return source ? { ...record, promptSource: source } : record;
  });
  return { ...found, records };
}

module.exports = { groupAsks, askOf, promptSource, TOKEN_OF, routedName };
