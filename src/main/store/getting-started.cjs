'use strict';

// Getting started (2026-10-09): the panel at the top of the "Getting started" workspace of a project a new user's
// onboarding made (never one made with + Project). Five steps the person ticks by hand, and the workspaces Connect your
// library suggested to start in (../connect/session.cjs). Kept in <project>/.context/getting-started.json:
// { workspaceId, welcomeId, ticked: [1..5], hidden }. A project without the file has no panel.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const { readJson } = require('./home.cjs');

const STEPS = 5;
const PICK_STEP = 2; // "Pick a workspace to start."
const FILE = 'getting-started.json';

const fileOf = (ctx, projectId) => path.join(projects.findProject(ctx, projectId).dir, '.context', FILE);
const cleanTicks = (value) => [...new Set((Array.isArray(value) ? value : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= STEPS))].sort((a, b) => a - b);

/** The step open in the panel: the first one not ticked, or null when all five are. */
function openStep(ticked) {
  const done = new Set(cleanTicks(ticked));
  for (let n = 1; n <= STEPS; n += 1) if (!done.has(n)) return n;
  return null;
}

/** `state` with step `n` ticked (or unticked, `on` false). */
function tick(state, n, on = true) {
  const ticked = new Set(cleanTicks(state && state.ticked));
  if (on) ticked.add(n); else ticked.delete(n);
  return { ...state, ticked: cleanTicks([...ticked]) };
}

function publicState(value) {
  const ticked = cleanTicks(value.ticked);
  return { workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : null, welcomeId: typeof value.welcomeId === 'string' ? value.welcomeId : null, ticked, hidden: value.hidden === true, open: openStep(ticked), steps: STEPS };
}

/** The panel's state for a project → { workspaceId, welcomeId, ticked, hidden, open, steps }, or null: no panel. */
function readGettingStarted(ctx, projectId) {
  let value = null;
  try { value = readJson(fileOf(ctx, projectId)); } catch { return null; }
  return value && typeof value === 'object' ? publicState(value) : null;
}

function writeFile(ctx, projectId, value) {
  const file = fileOf(ctx, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  projects.writeTextAtomic(file, `${JSON.stringify({ workspaceId: value.workspaceId, welcomeId: value.welcomeId, ticked: cleanTicks(value.ticked), hidden: value.hidden === true }, null, 2)}\n`);
  return publicState(value);
}

/** Onboarding made the project (ipc start-project): its panel, nothing ticked. */
function startGettingStarted(ctx, projectId, { workspaceId, welcomeId = null }) {
  return writeFile(ctx, projectId, { workspaceId, welcomeId, ticked: [], hidden: false });
}

/** The person ticked steps or hid the panel: { ticked, hidden } (either). Once hidden it stays hidden. → the state */
function setGettingStarted(ctx, projectId, { ticked, hidden } = {}) {
  const now = readGettingStarted(ctx, projectId);
  if (!now) throw new Error('This project has no Getting started panel');
  return writeFile(ctx, projectId, { ...now, ticked: ticked === undefined ? now.ticked : cleanTicks(ticked), hidden: now.hidden || hidden === true });
}

/** A workspace was started from step 2: step 2 is ticked. */
function pickedWorkspace(ctx, projectId) {
  const now = readGettingStarted(ctx, projectId);
  return now ? writeFile(ctx, projectId, tick(now, PICK_STEP)) : null;
}

const NAME_MAX = 40;
/** A workspace's name from the person's words: one line, at most 40 characters, cut at a word when there is one. */
function nameFrom(text, max = NAME_MAX) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  const cut = value.slice(0, max + 1).lastIndexOf(' ');
  return (cut >= max / 2 ? value.slice(0, cut) : value.slice(0, max)).replace(/[\s,;:.\-–—]+$/, '');
}

/**
 * Step 2's Start: `choice` { index } (one of `suggestions`, Connect's) or { custom: text } (the person's own words: named
 * from them, the whole text its description, Getting started's context its context). The workspace is made
 * (projects.createStartedWorkspace), `recordPick(name)` keeps a suggestion's name as picked, and step 2 is ticked.
 * → { workspace, name, gettingStarted }
 */
async function pickWorkspace(ctx, projectId, choice, { suggestions = [], recordPick = () => {} } = {}) {
  const state = readGettingStarted(ctx, projectId);
  const welcomeId = state ? state.welcomeId : null;
  let made;
  if (choice && typeof choice.custom === 'string') {
    const text = choice.custom.trim();
    if (!text) throw new Error('Write what the workspace is for');
    let context = [];
    if (state && state.workspaceId) { try { context = projects.findWorkspace(ctx, projectId, state.workspaceId).workspace.context; } catch { context = []; } }
    made = await projects.createStartedWorkspace(ctx, projectId, { name: nameFrom(text), description: text, context, welcomeId });
    recordPick(nameFrom(text));
  } else {
    const index = choice ? choice.index : null;
    const suggestion = Number.isInteger(index) && index >= 0 ? suggestions[index] : null;
    if (!suggestion) throw new Error('That suggestion is no longer there');
    made = await projects.createStartedWorkspace(ctx, projectId, { name: suggestion.name, description: suggestion.description, context: suggestion.items || [], welcomeId });
    recordPick(suggestion.name);
  }
  return { workspace: made, name: made.name, gettingStarted: pickedWorkspace(ctx, projectId) };
}

module.exports = { STEPS, PICK_STEP, openStep, tick, nameFrom, readGettingStarted, startGettingStarted, setGettingStarted, pickedWorkspace, pickWorkspace };
