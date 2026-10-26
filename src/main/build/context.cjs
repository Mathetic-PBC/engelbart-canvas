'use strict';

// What a Build is given (2026-09-25; design B6): the first message, frozen into context.md when Build is pressed, so
// notes edited afterwards (for the next workspace) never reach a Build already running. It is @bart's context — the
// workspace document with every mention in place, and the library as Context.json — plus what the Build dialog attached,
// the newest archived version of the workspace marked as history, and where the Build works. Replies after that are
// short messages in the same session; a session that will not resume starts again from context.md and the conversation.
// A post-it added to a workspace (2026-09-27) is a Build of that workspace whose task is the post-it, not the document.
// A request typed on an @bart line after --build (2026-10-02) is the same, given as <request> with the notes it mentions,
// and without the workspace's history. A task built from its own line (MATH-106, 2026-10-25) is such a request with the
// whole workspace beside it (`withDocument`): the task is what to do, the document is background.

const projects = require('../store/projects.cjs');
const archive = require('../store/archive.cjs');
const { expandMentions, expandRows, projectSource } = require('../context/expand-mentions.cjs');
const { catalogEntries } = require('../bart/context.cjs');
const { instructionsBlock } = require('../store/onboarding.cjs');
const { memoryBlock } = require('../connect/memory.cjs');
const { stripTaskMarkers } = require('../../shared/task-marker.cjs');

const BUILD_LINE_RE = /^build> [a-z0-9]{6,32}$/;
const attr = (value) => String(value).replace(/[<>"\n\r]/g, ' ').slice(0, 200);

/** A document's text with its mentions in place and its Build lines (drawn cards, not words) and tasks' Build markers left out. */
async function expandText(text, source, seen) {
  const plain = stripTaskMarkers(String(text || '')).split('\n').filter((line) => !BUILD_LINE_RE.test(line.trim())).join('\n');
  const { lines } = await expandMentions(plain, source, seen);
  return lines.join('\n').trimEnd();
}

/**
 * The frozen first message. `task` carries where the Build works (worktree, branch, baseBranch, baseSha, repo);
 * `attach` library ids; `postIt` the post-it's text: a quick task's (no `workspaceId`), or one added to the workspace;
 * with `fromLine`, the request typed on a line of the workspace; with `withDocument` too, a task built from its own line,
 * given as <request> with the workspace document after it as <workspace>.
 * → { text, archive: file | null }
 */
async function freezeContext(ctx, projectId, { task, workspaceId = null, attach = [], postIt = null, fromLine = false, withDocument = false }) {
  const project = projects.findProject(ctx, projectId);
  const rows = await ctx.libraryDb.list();
  const source = projectSource(ctx, projectId, rows);
  const seen = new Set();
  const parts = [];
  let history = null;
  let from = 'a post-it';
  const blocks = [];
  const fromPostIt = postIt != null;
  const request = fromPostIt && fromLine && !!workspaceId;
  const ofTask = request && !!withDocument;
  if (fromPostIt && !request) blocks.push(`<post-it>\n${String(postIt || '').trim()}\n</post-it>`);
  if (workspaceId) {
    const { workspace } = projects.findWorkspace(ctx, projectId, workspaceId);
    seen.add(`ws:${workspaceId}`);
    const document = async () => {
      let text = '';
      try { text = await projects.readDoc(ctx, projectId, { kind: 'workspace', workspaceId }); } catch { text = ''; }
      blocks.push(`<workspace name="${attr(workspace.name)}">\n${await expandText(text, source, seen)}\n</workspace>`);
    };
    if (request) {
      blocks.push(`<request>\n${await expandText(String(postIt || '').trim(), source, seen)}\n</request>`);
      if (ofTask) await document();
      from = ofTask ? `a task on a line of the workspace "${workspace.name}"` : `a request typed on a line of the workspace "${workspace.name}"`;
    } else if (fromPostIt) {
      from = `a post-it added to the workspace "${workspace.name}"`;
    } else {
      await document();
      from = `the workspace "${workspace.name}"`;
    }
    if (!request) history = archive.latestArchive(ctx, projectId, workspaceId);
  }
  const extra = rows.filter((row) => attach.includes(row.id) && !seen.has(row.id) && row.type !== 'image');
  if (extra.length) blocks.push(`<attached>\n${(await expandRows(extra, source, seen)).lines.join('\n')}\n</attached>`);
  if (history) {
    blocks.push(`<history cleared="${attr(history.clearedAt || history.file)}" note="An earlier version of this workspace, cleared by the person. Context only: do not implement anything that appears only here.">\n${await expandText(history.text, source, seen)}\n</history>`);
  }
  parts.push([
    '<engelbart>',
    `project: ${project.name}`,
    ...(project.description ? [`project description: ${project.description.replace(/\s+/g, ' ')}`] : []),
    `your working copy (make every change to the code here): ${task.worktree}`,
    `branch: ${task.branch}, started from ${task.baseBranch || 'a detached commit'} at ${String(task.baseSha || '').slice(0, 12)}`,
    `the person's own folder (do not touch): ${task.repo}`,
    `notes and workspaces (you may write here; the engelbart tools add to the library): ${project.dir}`,
    `built from: ${from}`,
    '</engelbart>',
  ].join('\n'));
  const instructions = instructionsBlock(ctx.dataRoot);
  if (instructions) parts.push(instructions);
  const page = projects.projectPageBlock(project); // the project page (2026-10-13): project-wide instructions
  if (page) parts.push(page);
  const remembered = memoryBlock(ctx.dataRoot); // MEMORY.md, when Connect your library wrote one (2026-10-07)
  if (remembered) parts.push(remembered);
  parts.push(ofTask
    ? '<task>\nDo the task in the request below. The person built it from a task on a line of their workspace: larger changes are fine, and you may ask with NEEDS YOU when a choice is theirs. The request is the task, with the tasks nested under it as its steps. The workspace document after it is background: what the task is part of, not more to build.\n</task>'
    : request
    ? '<task>\nDo what the request below asks. The person typed it on a line of a workspace as a full Build: larger changes are fine, and you may ask with NEEDS YOU when a choice is theirs. Notes it mentions are included under it; the rest of the workspace is not.\n</task>'
    : !fromPostIt
      ? '<task>\nDo what the workspace document below asks: it is the person\'s plan for this Build, usually ending with what to build now. Where it discusses options, follow what it settles on; where something it asks for is still undecided, choose sensibly and say what you chose, or ask with NEEDS YOU when the choice is theirs.\n</task>'
      : workspaceId
        ? '<task>\nDo what the post-it below asks. The person added it to a workspace as a full Build: larger changes are fine, and you may ask with NEEDS YOU when a choice is theirs.\n</task>'
        : '<task>\nDo what the post-it below asks. It is a quick task: a small change, made without questions.\n</task>');
  parts.push(...blocks);
  parts.push(`<context_json>\n${JSON.stringify(catalogEntries(project, rows, seen), null, 1)}\n</context_json>`);
  return { text: parts.join('\n\n'), archive: history ? history.file : null };
}

/**
 * A reply of the person's, as the next message of the session. `images`: what they pasted into it ([{ n, path }]), each
 * `[Attachment n]` in the text (2026-09-29).
 */
function replyMessage(text, images = []) {
  const reply = `<reply>\n${String(text || '').trim()}\n</reply>`;
  if (!images.length) return reply;
  const listed = images.map((image) => `[Attachment ${image.n}]: ${image.path}`).join('\n');
  return `${reply}\n\n<attachments note="Images the person pasted into the reply, named where the reply says [Attachment n]. Open each file to see it.">\n${listed}\n</attachments>`;
}

/** A session that will not resume: everything again, then what was said, then the new message. */
function freshMessage(context, messages, next) {
  const said = (messages || []).filter((m) => m.role === 'agent' || m.role === 'you').map((m) => `<turn role="${m.role === 'agent' ? 'you (the agent)' : 'the person'}">\n${m.text}\n</turn>`);
  const conversation = said.length ? `<conversation note="Your earlier session could not be resumed. This is what was said in it; your work so far is committed in the working copy.">\n${said.join('\n')}\n</conversation>` : '';
  return [context, conversation, next].filter(Boolean).join('\n\n');
}

/**
 * A first message split into its top-level blocks, for the Agent map: { engelbart, task, workspace | request | post-it,
 * attached, history, context_json, … } in the order sent, each the whole block. A block starts with `<name …>` at the start
 * of a line and ends at the first `</name>` line after it; text outside any block goes under `other`.
 */
function contextParts(text) {
  const source = String(text || '');
  const parts = {};
  const open = /^<([a-z][\w-]*)(?:\s[^>\n]*)?>/gm;
  let at = 0, match, other = '';
  while ((match = open.exec(source))) {
    if (match.index < at) continue;
    const name = match[1];
    const close = source.indexOf(`\n</${name}>`, match.index);
    const end = close === -1 ? source.length : close + name.length + 4;
    other += source.slice(at, match.index);
    const block = source.slice(match.index, end);
    parts[name] = parts[name] ? `${parts[name]}\n\n${block}` : block;
    at = end;
    open.lastIndex = end;
  }
  other += source.slice(at);
  if (other.trim()) parts.other = other.trim();
  return parts;
}

module.exports = { BUILD_LINE_RE, freezeContext, replyMessage, freshMessage, contextParts };
