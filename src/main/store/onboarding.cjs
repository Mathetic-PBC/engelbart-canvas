'use strict';

// Onboarding (2026-09-28; as brainstorm cards since 2026-10-07, design/onboarding-brainstorm). A new install walks
// through Welcome, the tools (when one is missing), then the cards: What are you working on? Why are you interested in
// this? Putting it together, where they settle on their question (three since 2026-10-08; "What are you least sure
// about?" is gone). + Project on the all-projects screen is the cards. Bart's part
// while they answer is ../bart/onboard.cjs. What the flow writes, all in `startProject`:
//   - the project: named by Bart from the answers (renamable), its description their first two answers as they wrote
//     them, its folder the default, made under the home directory;
//   - its brief (project.json `brief`): what they are working on, what they are trying to do with it and the research
//     question they start with, in their own words. The custom instructions and the library
//     rows picked as the project's context, which the screens before 2026-10-07 asked for, were what @bart and Build
//     were told about the person and the project; the brief is told in their place (`briefBlock`). Instructions written
//     before then, `<dataRoot>/instructions.md`, are still read (`instructionsBlock`);
//   - its first workspace, named with their question, holding Bart's three sub-questions under "Suggested places to
//     start" (meta.json `starts`) and the "Welcome!" note in its context.
// `discardItem` and the folder helpers stay for the library and the + Project of older screens.

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

/** What the person said about the project on onboarding's cards, as a block of an agent's first message; '' when nothing. */
function briefBlock(project) {
  const brief = project && project.brief;
  if (!brief) return '';
  const lines = [['working', 'What they are working on'], ['goal', 'What they are trying to do with it'], ['why', 'Why they are interested in it'], ['question', 'The question they want to answer'], ['unsure', 'What they are least sure about'], ['findOut', 'What they want to find out']]
    .filter(([key]) => brief[key]).map(([key, label]) => `${label}: ${brief[key]}`);
  return lines.length ? `<project_brief note="What the person said about this project when they started it, in their own words. It tells you what they are after; it may have moved on since.">\n${lines.join('\n')}\n</project_brief>` : '';
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
 * The project the cards describe → createProjectWithWelcome's answer. `name`: Bart's (else the person's). `description`:
 * their sentence. `question`: the first workspace's name (else "Getting started"). `starts`: Bart's sub-questions, each
 * text marked as his. `brief`: their answers. `folder` is 'new' (made now, under the home directory, never an existing
 * one: the default) or 'existing' (`directory`).
 */
async function startProject(ctx, { name, description = '', question = '', starts = [], brief = null, folder = 'new', directory = '' } = {}) {
  let dir;
  if (folder === 'new') {
    dir = freeFolder(ctx, name).path;
    fs.mkdirSync(dir, { mode: DIR_MODE });
  } else {
    dir = existingFolder(ctx, directory);
  }
  const suggested = (Array.isArray(starts) ? starts : []).filter((text) => typeof text === 'string' && text.trim()).slice(0, 6).map((text) => ({ text, by: 'bart' }));
  return projects.createProjectWithWelcome(ctx, { name, description, directory: dir, brief }, { workspaceName: String(question || '').trim() || 'Getting started', starts: suggested, describe: false });
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

module.exports = { INSTRUCTIONS_FILE, readInstructions, writeInstructions, instructionsBlock, briefBlock, freeFolder, existingFolder, startProject, discardItem };
