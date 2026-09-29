'use strict';

// What one @bart question carries (2026-09-19): the workspace document, the note the question
// was asked from when it was asked from a note, every mentioned note in full at the place it is
// mentioned (../context/expand-mentions.cjs), the library as Context.json with a `mentioned`
// flag per item, and where things are on disk so the agent's own file tools can open the rest.
// A follow-up carries all of that again, read again, and the earlier turns of its exchange as well.

const path = require('node:path');
const { createHash } = require('node:crypto');
const projects = require('../store/projects.cjs');
const { buildCatalog } = require('../context/catalog.cjs');
const { expandDoc } = require('../context/expand-mentions.cjs');
const { PENDING_RE } = require('./reply.cjs');

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

/** The project's library as the agent is shown it (Context.json): every item but pictures, `mentioned` when `seen` holds it. */
function catalogEntries(project, rows, seen) {
  const catalog = buildCatalog(project, projects.flattenWorkspaces(project.dir), rows, null);
  return catalog.entries.filter((entry) => entry.type !== 'image').map((entry) => ({
    name: entry.name,
    type: entry.type,
    tags: entry.tags,
    path: entry.path || entry.folderPath ? path.resolve(project.dir, entry.path || entry.folderPath) : null,
    folderPath: entry.folderPath ? path.resolve(project.dir, entry.folderPath) : null,
    url: entry.url,
    summary: entry.summaryStale ? null : entry.summary,
    lastEdited: entry.lastEdited,
    mentioned: seen.has(entry.id),
  }));
}

/**
 * → { project, dirs, head, contextJson, documents }. `head` and the documents are text; the
 * caller adds the level and the question (./ask.cjs), which differ per step.
 */
async function buildContext(ctx, projectId, { ref, workspaceId, askId, repository: captured }) {
  const repositories = require('../store/workspace-repositories.cjs');
  await repositories.ensure(ctx, projectId);
  const repository = captured || repositories.resolve(ctx, projectId, workspaceId);
  const found = projects.findWorkspace(ctx, projectId, workspaceId);
  const { project, workspace } = found;
  const rows = await ctx.libraryDb.list();
  const seen = new Set();
  const documents = [];
  let from = `the workspace "${workspace.name}"`;
  if (ref.kind === 'note') {
    // The note is its own block: the workspace must not also carry it as a mention.
    seen.add(ref.id);
    const space = await expandDoc(ctx, projectId, { kind: 'workspace', workspaceId }, { seen });
    const note = await expandDoc(ctx, projectId, ref, { seen });
    documents.push(block('workspace', space.title, markPlace(space.body, askId)), block('note', note.title, markPlace(note.body, askId)));
    from = `the note "${note.title}", opened from the workspace "${workspace.name}"`;
  } else {
    const space = await expandDoc(ctx, projectId, ref, { seen });
    documents.push(block('workspace', space.title, markPlace(space.body, askId)));
  }
  const entries = catalogEntries(project, rows, seen);
  // Context repositories are readable sources, not a change to the working
  // repository. Grant access to external sources even without an @mention.
  const dirs = [repository.directory, ctx.dataRoot];
  for (const entry of entries) if (entry.folderPath && entry.tags?.includes('git') && !dirs.some(dir => repositories.contains(dir, entry.folderPath))) dirs.push(entry.folderPath);
  const head = [
    '<engelbart>',
    `project: ${project.name}`,
    `code directory: ${repository.directory}`,
    `repository ID: ${repository.repoId}`,
    `notes and workspaces: ${project.dir}`,
    `workspace directory: ${workspace.dir}`,
    `asked from: ${from}`,
    '</engelbart>',
  ].join('\n');
  // A resumable CLI session has memorized these locations. IDs alone survive
  // moves; include the current locations so persisted sessions are checked too.
  const location = createHash('sha256').update(JSON.stringify([project.dir, workspace.dir, repository.directory, [...dirs].sort(), entries.map(entry => [entry.path, entry.folderPath]).sort()])).digest('hex');
  return { project, repository, dirs, location, head, contextJson: `<context_json>\n${JSON.stringify(entries, null, 1)}\n</context_json>`, documents: documents.join('\n\n') };
}

module.exports = { HERE, markPlace, buildContext, conversationBlock, catalogEntries, block };
