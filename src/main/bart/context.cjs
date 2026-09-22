'use strict';

// What one @bart question carries (2026-09-19): the workspace document, the note the question
// was asked from when it was asked from a note, every mentioned note in full at the place it is
// mentioned (../context/expand-mentions.cjs), the library as Context.json with a `mentioned`
// flag per item, and where things are on disk so the agent's own file tools can open the rest.
// A follow-up carries all of that again, read again, and the earlier turns of its exchange as well.

const path = require('node:path');
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

/**
 * → { project, dirs, head, contextJson, documents }. `head` and the documents are text; the
 * caller adds the level and the question (./ask.cjs), which differ per step.
 */
async function buildContext(ctx, projectId, { ref, workspaceId, askId }) {
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
  const catalog = buildCatalog(project, projects.flattenWorkspaces(project.dir), rows, null);
  const entries = catalog.entries.filter((entry) => entry.type !== 'image').map((entry) => ({
    name: entry.name,
    type: entry.type,
    tags: entry.tags,
    path: entry.path ? path.resolve(project.dir, entry.path) : null,
    url: entry.url,
    summary: entry.summaryStale ? null : entry.summary,
    lastEdited: entry.lastEdited,
    mentioned: seen.has(entry.id),
  }));
  const head = [
    '<engelbart>',
    `project: ${project.name}`,
    `code directory: ${project.directory || 'none set'}`,
    `notes and workspaces: ${project.dir}`,
    `asked from: ${from}`,
    '</engelbart>',
  ].join('\n');
  return { project, dirs: [project.directory, ctx.dataRoot].filter(Boolean), head, contextJson: `<context_json>\n${JSON.stringify(entries, null, 1)}\n</context_json>`, documents: documents.join('\n\n') };
}

module.exports = { HERE, markPlace, buildContext, conversationBlock };
