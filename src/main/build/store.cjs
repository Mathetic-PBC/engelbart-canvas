'use strict';

// A Build's record (2026-09-25; design docs/superpowers/specs/2026-09-25-build-workflow-design.md B4, §3):
//   <dataRoot>/<slug>/builds/<id>/task.json    what it is, where it runs, where it stands, what was said
//   <dataRoot>/<slug>/builds/<id>/context.md   the first message, frozen when Build was pressed
// The record, not the document, holds the conversation: the document has one `build> <id>` line that draws it. Records
// outlive their worktrees (accepted and discarded Builds stay, for the history and for a future panel).

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { readJson, writeJson } = require('../store/home.cjs');

const ID_RE = /^[0-9a-f]{10}$/;
const KINDS = Object.freeze(['build', 'quick']);
const STATUSES = Object.freeze(['setting-up', 'queued', 'running', 'needs-you', 'review', 'stopped', 'failed', 'escalated', 'interrupted', 'accepting', 'conflict', 'accepted', 'discarded']);
const FINAL = new Set(['accepted', 'discarded']);
// States a turn or git is at work in: at launch, a record left in one of these was cut off by the app closing (B19).
const WORKING = new Set(['setting-up', 'queued', 'running', 'accepting']);
const MAX_MESSAGES = 200;
const MAX_MESSAGE_CHARS = 40_000;

const newId = () => randomBytes(5).toString('hex');
const buildsDir = (project) => path.join(project.dir, 'builds');
const taskDir = (project, id) => {
  if (!ID_RE.test(String(id))) throw new TypeError('build id is invalid');
  return path.join(buildsDir(project), id);
};

function readTask(project, id) {
  let dir;
  try { dir = taskDir(project, id); } catch { return null; }
  const task = readJson(path.join(dir, 'task.json'));
  return task && task.id === id ? task : null;
}

/** The record written whole (atomically), stamped `updated`. → the record */
function writeTask(project, task, now = new Date()) {
  const dir = taskDir(project, task.id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const next = { ...task, messages: (task.messages || []).slice(-MAX_MESSAGES), updated: now.toISOString() };
  writeJson(path.join(dir, 'task.json'), next);
  return next;
}

/** A fresh id: unused here and, when `taken(id)` says so, elsewhere (a branch of that name in the repository). */
async function freeId(project, taken = async () => false) {
  for (let tries = 0; tries < 20; tries += 1) {
    const id = newId();
    if (!fs.existsSync(path.join(buildsDir(project), id)) && !(await taken(id))) return id;
  }
  throw new Error('No free Build id');
}

function listTasks(project) {
  let names = [];
  try { names = fs.readdirSync(buildsDir(project)); } catch { names = []; }
  return names.filter((name) => ID_RE.test(name)).map((id) => readTask(project, id)).filter(Boolean).sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

function writeContext(project, id, text) {
  const dir = taskDir(project, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'context.md');
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return file;
}

function readContext(project, id) {
  try { return fs.readFileSync(path.join(taskDir(project, id), 'context.md'), 'utf8'); } catch { return null; }
}

/** A message for the conversation: who said it, what, when (cut to a size a record can carry). */
const message = (role, text, now = new Date()) => ({ role, text: String(text || '').slice(0, MAX_MESSAGE_CHARS), at: now.toISOString() });

/** What the renderer is sent: the record less nothing it could not show, plus whether it is done with. */
function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    kind: task.kind,
    projectId: task.projectId,
    workspaceId: task.workspaceId || null,
    postItId: task.postItId || null,
    title: task.title,
    provider: task.provider,
    model: task.model,
    modelName: task.modelName,
    effort: task.effort,
    status: task.status,
    question: task.question || null,
    escalation: task.escalation || null,
    error: task.error || null,
    queued: task.queued || null,
    turn: task.turn || 0,
    branch: task.branch,
    baseBranch: task.baseBranch,
    worktree: task.worktree,
    checkpoints: (task.checkpoints || []).length,
    messages: task.messages || [],
    checks: task.checks || null,
    conflict: task.conflict || null,
    accepted: task.accepted || null,
    version: task.version || null, // a post-it added to a workspace: the archived version it was put in as ({ file, title })
    created: task.created,
    updated: task.updated,
    final: FINAL.has(task.status),
  };
}

module.exports = { ID_RE, KINDS, STATUSES, FINAL, WORKING, newId, freeId, buildsDir, taskDir, readTask, writeTask, listTasks, writeContext, readContext, message, publicTask };
