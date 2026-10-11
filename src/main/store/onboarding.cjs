'use strict';

// Onboarding (2026-09-28; Claude Design "Onboarding.dc.html"). A new install walks through Welcome, Add to your library
// (GitHub, then websites, then papers), Custom instructions, Create a new project (name, description, folder) and
// Project context; + Project on the all-projects screen is the last two only. What the screens write:
//   - library rows, through the same addItem the sidebar uses (ipc `add-library-item`); a repository unticked again
//     during onboarding is discarded (`discardItem`), and only if nothing holds it;
//   - the custom instructions, `<dataRoot>/instructions.md`, read by @bart and Build (`instructionsBlock`);
//   - the project (`startProject`): its folder, made under the home directory when Engelbart is asked to make one,
//     a "Getting started" workspace whose document starts with the description, the "Welcome!" note, and the chosen library
//     rows in the workspace's context;
//   - the guided setup started inside a project (`addWelcomeWorkspace`, 2026-10-10): no project, a "Welcome" workspace in
//     that one, with what the setup added in its context.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const library = require('./library.cjs');
const { slugify, DIR_MODE } = require('./home.cjs');

const INSTRUCTIONS_FILE = 'instructions.md';
const MAX_INSTRUCTIONS = 20000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const instructionsPath = (ctx) => path.join(ctx.dataRoot, INSTRUCTIONS_FILE);

function readInstructions(ctx) {
  try { return fs.readFileSync(instructionsPath(ctx), 'utf8').trim(); } catch { return ''; }
}

/** Empty text removes the file: no instructions is the same as never having written any. */
function writeInstructions(ctx, text) {
  if (typeof text !== 'string') throw new TypeError('instructions must be text');
  const value = text.trim().slice(0, MAX_INSTRUCTIONS);
  if (!value) { fs.rmSync(instructionsPath(ctx), { force: true }); return ''; }
  projects.writeTextAtomic(instructionsPath(ctx), `${value}\n`);
  return value;
}

/** The person's custom instructions as a block of an agent's first message, or '' when there are none. */
function instructionsBlock(dataRoot) {
  const text = readInstructions({ dataRoot });
  return text ? `<custom_instructions note="Written by the person about themselves and how they want to be helped. Follow them unless they conflict with your task.">\n${text}\n</custom_instructions>` : '';
}

const shown = (ctx, dir) => (dir.startsWith(ctx.homeDir + path.sep) ? `~${dir.slice(ctx.homeDir.length)}` : dir);

/** The folder "Create a folder for me" would make for a project called `name`: ~/<slug>, else ~/<slug>-2 … */
function freeFolder(ctx, name) {
  const base = slugify(name) || 'my-project';
  for (let n = 1; n < 1000; n += 1) {
    const dir = path.join(ctx.homeDir, n === 1 ? base : `${base}-${n}`);
    if (!fs.existsSync(dir)) return { path: dir, shown: shown(ctx, dir) };
  }
  throw new Error('No free folder name for this project');
}

/** A folder the person typed: `~` is their home directory; it must exist and be a directory. */
function existingFolder(ctx, value) {
  let dir = String(value || '').trim();
  if (!dir) throw new TypeError('Choose a folder');
  if (dir === '~' || dir.startsWith('~/')) dir = path.join(ctx.homeDir, dir.slice(1));
  if (!path.isAbsolute(dir)) throw new TypeError('A folder path starts with / or ~/');
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new Error(`Nothing is at ${value}`); }
  if (!stat.isDirectory()) throw new Error(`${value} is not a folder`);
  return path.resolve(dir);
}

/**
 * The project the Create screen describes → createProjectWithWelcome's answer. `folder` is 'new' (made now, under the
 * home directory, never an existing one) or 'existing' (`directory`). `context` holds library ids; rows the library does
 * not have, and notes (they belong to their own project), are left out. A new user's first project calls its first
 * workspace "Welcome" (`workspaceName`, 2026-10-09: the walkthrough's title).
 */
async function startProject(ctx, { name, description = '', folder = 'new', directory = '', context = [], workspaceName = 'Getting started' } = {}) {
  let dir;
  if (folder === 'new') {
    dir = freeFolder(ctx, name).path;
    fs.mkdirSync(dir, { mode: DIR_MODE });
  } else {
    dir = existingFolder(ctx, directory);
  }
  const chosen = await contextIds(ctx, context);
  return projects.createProjectWithWelcome(ctx, { name, description, directory: dir }, { workspaceName, context: chosen });
}

/** Library ids a workspace can be given: rows the library has, notes left out (they belong to their own project). */
async function contextIds(ctx, context) {
  const rows = await ctx.libraryDb.list();
  const known = new Map(rows.map((row) => [row.id, row]));
  return [...new Set((Array.isArray(context) ? context : []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))]
    .filter((id) => known.has(id) && !known.get(id).tags.includes('note'));
}

/**
 * The guided setup started inside a project (2026-10-10, "guided setup shouldn't create a new project"): no project is
 * made; this one gets a workspace named "Welcome" (createWorkspace makes the name unique: a second run's is "Welcome 2")
 * holding `context` as startProject's does. Nothing the project had is touched. → { project, workspaceId }
 */
async function addWelcomeWorkspace(ctx, projectId, { context = [] } = {}) {
  const project = projects.findProject(ctx, projectId);
  const chosen = await contextIds(ctx, context);
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Welcome' });
  if (chosen.length) await projects.setWorkspaceContext(ctx, project.id, workspace.id, chosen);
  return { project: { id: project.id, name: project.name }, workspaceId: workspace.id };
}

/**
 * A row added during onboarding and unticked again goes: only when it is not a note and no project holds it (no
 * workspace has it in context, none made it). Anything else stays and the answer is false. `release` runs first when
 * given: a GitHub repository's sandbox stopped and its runs forgotten (sandbox/manager.cjs), else the row cannot go.
 */
async function discardItem(ctx, id, { release = null } = {}) {
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw new TypeError('library id is invalid');
  const row = await ctx.libraryDb.get(id);
  if (!row || row.tags.includes('note') || row.project_id) return false;
  if ((await library.projectsForLibraryItem(ctx, id)).length) return false;
  if (release) await release();
  return ctx.libraryDb.remove(id);
}

module.exports = { INSTRUCTIONS_FILE, readInstructions, writeInstructions, instructionsBlock, freeFolder, existingFolder, startProject, addWelcomeWorkspace, discardItem };
