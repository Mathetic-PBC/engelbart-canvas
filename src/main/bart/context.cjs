'use strict';

// What one @bart question carries (2026-09-19): the workspace document, the note the question
// was asked from when it was asked from a note, every mentioned note in full at the place it is
// mentioned (../context/expand-mentions.cjs), the library as Context.json with a `mentioned`
// flag per item, and where things are on disk so the agent's own file tools can open the rest.
// A follow-up carries all of that again, read again, and the earlier turns of its exchange as well.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const projects = require('../store/projects.cjs');
const { buildCatalog } = require('../context/catalog.cjs');
const { expandDoc } = require('../context/expand-mentions.cjs');
const { PENDING_RE } = require('./reply.cjs');
const { stripAgentReplies } = require('./strip.cjs');
const db = require('../store/db.cjs');
const { instructionsBlock } = require('../store/onboarding.cjs');

const HERE = '<<< this is the question being asked now >>>';

/** The pending line of this question marks its place; the pending lines of other questions are noise. */
function markPlace(text, askId) {
  return String(text || '').split('\n').flatMap((line) => {
    const pending = line.match(PENDING_RE);
    if (!pending) return [line];
    return pending[1] === askId ? [HERE] : [];
  }).join('\n');
}

/**
 * The earlier turns of the exchange a follow-up continues, as the document holds them now: the person may have edited
 * an answer or deleted a turn since, and what stands in the document is what was said.
 */
function conversationBlock(turns) {
  if (!turns.length) return '';
  const said = turns.map((turn, n) => `<turn n="${n + 1}">\n<asked>\n${turn.question}\n</asked>\n<answered>\n${turn.answer}\n</answered>\n</turn>`);
  return `<conversation>\n${said.join('\n')}\n</conversation>`;
}

const block = (tag, name, text) => `<${tag} name="${String(name).replace(/[<>"\n\r]/g, ' ').slice(0, 200)}">\n${text}\n</${tag}>`;

/**
 * The library's entries an agent may be shown. @brainstorm's (2026-09-30, round 3): this workspace's alone, what its
 * sidebar holds (its context and the notes made in it, less what was thrown away) and whatever the document mentions.
 * Everyone else's: the whole project's. `scope` { agent, workspace, own } — `own` the ids of the notes made in it.
 */
function catalogFor(project, rows, seen, { agent = 'bart', workspace = null, own = [] } = {}) {
  if (agent !== 'brainstorm' || !workspace) return buildCatalog(project, projects.flattenWorkspaces(project.dir), rows, null).entries;
  const removed = new Set(workspace.removed || []);
  const held = new Set([...workspace.context, ...own].filter((id) => !removed.has(id)));
  for (const id of seen) held.add(id);
  const here = { id: workspace.id, name: workspace.name, path: workspace.name, context: [...held] };
  return buildCatalog(project, [here], rows.filter((row) => held.has(row.id)), null).entries;
}

/**
 * The library as the agent is shown it (Context.json): every item but pictures, `mentioned` when `seen` holds it. The
 * whole project's, or for @brainstorm this workspace's alone (catalogFor).
 */
function catalogEntries(project, rows, seen, scope) {
  return catalogFor(project, rows, seen, scope).filter((entry) => entry.type !== 'image').map((entry) => ({
    name: entry.name,
    type: entry.type,
    tags: entry.tags,
    path: entry.path ? path.resolve(project.dir, entry.path) : null,
    url: entry.url,
    summary: entry.summaryStale ? null : entry.summary,
    lastEdited: entry.lastEdited,
    mentioned: seen.has(entry.id),
  }));
}

// The agents that may open the library's own files (2026-09-30, MB-06): the folders those files are in join the
// --add-dir list, read-only like the rest. @bart's list stays the code directory and the data folder.
const LIBRARY_READERS = new Set(['brainstorm', 'discover']);
const MAX_LIBRARY_DIRS = 24;
const within = (dir, root) => { const inside = path.relative(root, dir); return inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside)); };

/**
 * The folders to grant so the library's files can be opened: each file's folder, and a folder item itself. Never the
 * home folder or the disk's root (a file straight in either is left out), nothing already granted or inside another
 * one, nothing that is gone.
 */
function libraryDirs(project, rows, granted, { home = os.homedir(), seen = new Set(), scope } = {}) {
  const wanted = [];
  for (const entry of catalogFor(project, rows, seen, scope)) {
    if (entry.type === 'image') continue;
    const dir = entry.folderPath ? path.resolve(entry.folderPath) : entry.path ? path.dirname(path.resolve(project.dir, entry.path)) : null;
    if (!dir || dir === path.parse(dir).root || dir === path.resolve(home) || granted.some((root) => within(dir, root))) continue;
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    wanted.push(dir);
  }
  const out = [];
  for (const dir of [...new Set(wanted)].sort((a, b) => a.length - b.length)) if (!out.some((root) => within(dir, root))) out.push(dir);
  return out.slice(0, MAX_LIBRARY_DIRS);
}

/**
 * → { project, dirs, head, contextJson, documents, entries, workspaceName }. `head` and the documents are text; the
 * caller adds the level and the question (./ask.cjs), which differ per step. `entries` (the library as Context.json
 * holds it) and `workspaceName` are for the fake agents, which name what a real one would read.
 */
async function buildContext(ctx, projectId, { ref, workspaceId, askId, agent = 'bart' }) {
  const found = projects.findWorkspace(ctx, projectId, workspaceId);
  const { project, workspace } = found;
  const rows = await ctx.libraryDb.list();
  const seen = new Set();
  const documents = [];
  // @brainstorm reads where the person is from what they wrote: other agents' answers are taken out (./strip.cjs).
  const brainstorm = agent === 'brainstorm';
  const shown = (body) => markPlace(brainstorm ? stripAgentReplies(body) : body, askId);
  let from = `the workspace "${workspace.name}"`;
  if (ref.kind === 'note') {
    // The note is its own block: the workspace must not also carry it as a mention.
    seen.add(ref.id);
    const space = await expandDoc(ctx, projectId, { kind: 'workspace', workspaceId }, { seen });
    const note = await expandDoc(ctx, projectId, ref, { seen });
    documents.push(block('workspace', space.title, shown(space.body)), block('note', note.title, shown(note.body)));
    from = `the note "${note.title}", opened from the workspace "${workspace.name}"`;
  } else {
    const space = await expandDoc(ctx, projectId, ref, { seen });
    documents.push(block('workspace', space.title, shown(space.body)));
  }
  const own = brainstorm ? (await (await db.openNotesDb(project.dir)).list()).filter((note) => note.topic_id === workspace.id).map((note) => note.id) : [];
  const scope = { agent, workspace, own };
  const entries = catalogEntries(project, rows, seen, scope);
  const head = [
    '<engelbart>',
    `project: ${project.name}`,
    ...(project.description ? [`project description: ${project.description.replace(/\s+/g, ' ')}`] : []),
    `code directory: ${project.directory || 'none set'}`,
    `notes and workspaces: ${project.dir}`,
    `asked from: ${from}`,
    '</engelbart>',
    instructionsBlock(ctx.dataRoot),
  ].filter(Boolean).join('\n');
  const granted = [project.directory, ctx.dataRoot].filter(Boolean);
  const dirs = LIBRARY_READERS.has(agent) ? [...granted, ...libraryDirs(project, rows, granted, { seen, scope })] : granted;
  return { project, dirs, head, contextJson: `<context_json>\n${JSON.stringify(entries, null, 1)}\n</context_json>`, documents: documents.join('\n\n'), entries, workspaceName: workspace.name };
}

module.exports = { HERE, markPlace, buildContext, conversationBlock, catalogEntries, libraryDirs, block };
