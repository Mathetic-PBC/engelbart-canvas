'use strict';

// The Agent Viewer's IPC (2026-10-12; ./window.cjs; it was the Agent map). Trusted handlers that need no window's context:
// the Viewer is no workspace window. agentMap:open opens or focuses it (from a workspace window's Agents button);
// agentMap:runs is every run without its big fields, newest first; agentMap:run(id) one run whole; agentMap:asks the runs
// grouped one entry per ask (./asks.cjs); agentMap:ask(id) one entry with its records whole and
// the names of where it was typed (placeNames); agentMap:design each agent as
// it is set up now (./design.cjs); agentMap:export(html, name) saves a page the Viewer made, through a save dialog;
// agentMap:reveal(target) brings the window with the ask's project to the front at its line (index.cjs `reveal`). Each
// change to a run is sent to the Viewer alone as engelbart:agent-run (index.cjs, the run log's onChange).

const { groupAsks, askOf } = require('./asks.cjs');

const MAX_EXPORT = 200 * 1024 * 1024;

const shortStr = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);

/** What a click asks to be shown: { place: { projectId, ref, line, text, quote }, routedTo, buildId }, or null. */
function revealTarget(value) {
  if (!value || typeof value !== 'object') return null;
  const place = value.place && typeof value.place === 'object' ? value.place : null;
  const projectId = place && shortStr(place.projectId, 64);
  if (!projectId) return null;
  const held = place.ref && typeof place.ref === 'object' ? place.ref : null;
  let ref = null;
  if (held && held.kind === 'workspace' && shortStr(held.workspaceId, 64)) ref = { kind: 'workspace', workspaceId: held.workspaceId };
  else if (held && held.kind === 'note' && shortStr(held.id, 64)) ref = { kind: 'note', id: held.id };
  else if (held && held.kind === 'mark' && shortStr(held.id, 64) && (shortStr(held.rowId, 64) || shortStr(held.url, 8192))) {
    ref = { kind: 'mark', id: held.id, ...(held.rowId ? { rowId: held.rowId } : { url: held.url }), ...(Number.isInteger(held.page) ? { page: held.page } : {}), ...(held.source === 'web' ? { source: 'web' } : {}) };
  }
  return {
    place: { projectId, ref, line: Number.isInteger(place.line) && place.line >= 0 ? place.line : null, text: shortStr(place.text, 8000), quote: shortStr(place.quote, 2000) },
    routedTo: shortStr(value.routedTo, 40), buildId: shortStr(value.buildId, 64),
  };
}

/**
 * The names of where an ask's line was typed (2026-10-13), for the Viewer to show in place of ids: { project, workspace,
 * note, paper }, each '' when it cannot be found (a project or note since deleted). `ctx` is the store's context.
 */
async function placeNames(ctx, place, { projects = require('../store/projects.cjs'), db = require('../store/db.cjs') } = {}) {
  const names = { project: '', workspace: '', note: '', paper: '' };
  if (!ctx || !place || typeof place.projectId !== 'string') return names;
  const ref = place.ref && typeof place.ref === 'object' ? place.ref : null;
  let project;
  try { project = projects.findProject(ctx, place.projectId); } catch { return names; }
  names.project = project.name;
  const workspaceName = (id) => { try { return projects.findWorkspace(ctx, place.projectId, id).workspace.name; } catch { return ''; } };
  const libraryName = async (id) => { try { const row = ctx.libraryDb ? await ctx.libraryDb.get(id) : null; return row && row.name ? String(row.name) : ''; } catch { return ''; } };
  if (ref && ref.kind === 'workspace' && typeof ref.workspaceId === 'string') names.workspace = workspaceName(ref.workspaceId);
  else if (ref && ref.kind === 'note' && typeof ref.id === 'string') {
    // A project's note (its notes database, the workspace it was made in), else a note of the library.
    let note = null;
    try { note = await (await db.openNotesDb(project.dir)).get(ref.id); } catch { note = null; }
    if (note) { names.note = String(note.name || ''); if (note.topic_id) names.workspace = workspaceName(note.topic_id); }
    else names.note = await libraryName(ref.id);
  } else if (ref && ref.kind === 'mark' && typeof ref.rowId === 'string') names.paper = await libraryName(ref.rowId);
  return names;
}

// `benchmark` (./benchmark.cjs): the Benchmark tab's questions, replays and notes; each change is sent to the Viewer alone.
function registerAgentMapIpc({ ipcMain, trustedHandler, mapWindow, runLog, design, saveFile, reveal = () => false, context = null, benchmark = null }) {
  const handle = (channel, handler) => ipcMain.handle(`engelbart:${channel}`, trustedHandler(handler));
  handle('agentMap:open', () => mapWindow.open());
  handle('agentMap:runs', () => (runLog ? runLog.list() : []));
  handle('agentMap:run', (id) => (runLog && typeof id === 'string' ? runLog.get(id) : null));
  handle('agentMap:asks', () => (runLog ? groupAsks(runLog.list()) : []));
  handle('agentMap:ask', async (id) => {
    const ask = askOf(runLog, id);
    if (!ask || !ask.place || !context) return ask;
    let names = null;
    try { names = await placeNames(await context(), ask.place); } catch { names = null; }
    return names ? { ...ask, names } : ask;
  });
  handle('agentMap:reveal', (value) => { const target = revealTarget(value); return target ? reveal(target) : false; });
  handle('agentMap:design', () => design());
  handle('agentMap:export', async (html, name) => {
    if (typeof html !== 'string' || html.length > MAX_EXPORT) throw new Error('Nothing to export.');
    const safe = String(name || 'agent-runs').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'agent-runs';
    return saveFile(html, `${safe}.html`);
  });
  if (benchmark) benchmark.subscribe((change) => mapWindow.send('engelbart:chat-benchmark', change));
  const benched = (fn) => (...args) => { if (!benchmark) throw new Error('The benchmark is not available.'); return fn(...args); };
  handle('agentMap:benchmark', benched(() => benchmark.list()));
  handle('agentMap:benchmark-run', benched((key) => (key == null ? benchmark.run() : benchmark.runOne(key))));
  handle('agentMap:benchmark-stop', benched(() => benchmark.stop()));
  handle('agentMap:benchmark-note', benched((key, text) => (typeof key === 'string' && typeof text === 'string' ? benchmark.setNote(key, text) : false)));
}

module.exports = { registerAgentMapIpc, revealTarget, placeNames };
