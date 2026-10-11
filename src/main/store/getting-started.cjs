'use strict';

// The Welcome walkthrough (2026-10-09, remade from 21384b3's Getting started panel in the "Suggested steps" look of
// design/onboarding-brainstorm/6-workspace.dc.html): three steps under the title of the "Welcome" workspace of a project
// a new user's onboarding made (never one made with + Project), or of the Welcome workspace the guided setup added to a
// project it was started in (2026-10-10; the newest one when it ran more than once): see what came in (the Library's tabs), @brainstorm, and
// @discover. The window ticks a step when the person does it (opens the Library, runs @brainstorm or @discover), or by
// hand. Kept in <project>/.context/getting-started.json: { workspaceId, ticked: [1..3], hidden }. A project without the
// file has no walkthrough.

const fs = require('node:fs');
const path = require('node:path');
const projects = require('./projects.cjs');
const { readJson } = require('./home.cjs');

const STEPS = 3;
const FILE = 'getting-started.json';

const fileOf = (ctx, projectId) => path.join(projects.findProject(ctx, projectId).dir, '.context', FILE);
const cleanTicks = (value) => [...new Set((Array.isArray(value) ? value : []).filter((n) => Number.isInteger(n) && n >= 1 && n <= STEPS))].sort((a, b) => a - b);
const idOrNull = (value) => (typeof value === 'string' && value ? value : null);

function publicState(value) {
  return { workspaceId: idOrNull(value.workspaceId), ticked: cleanTicks(value.ticked), hidden: value.hidden === true, steps: STEPS };
}

/** The walkthrough's state for a project → { workspaceId, ticked, hidden, steps }, or null: none. */
function readGettingStarted(ctx, projectId) {
  let value = null;
  try { value = readJson(fileOf(ctx, projectId)); } catch { return null; }
  return value && typeof value === 'object' ? publicState(value) : null;
}

function writeFile(ctx, projectId, value) {
  const state = publicState(value);
  const file = fileOf(ctx, projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  projects.writeTextAtomic(file, `${JSON.stringify({ workspaceId: state.workspaceId, ticked: state.ticked, hidden: state.hidden }, null, 2)}\n`);
  return state;
}

/** Onboarding made the project (ipc start-project), or added a Welcome workspace to it (ipc welcome-workspace): its walkthrough, nothing ticked. */
function startGettingStarted(ctx, projectId, { workspaceId }) {
  return writeFile(ctx, projectId, { workspaceId, ticked: [], hidden: false });
}

/**
 * The window ticked steps or hid the walkthrough: `tick` steps to add, `untick` to take off (a circle clicked by hand),
 * `hidden`. Once hidden it stays hidden. → the state
 */
function setGettingStarted(ctx, projectId, { tick = [], untick = [], hidden } = {}) {
  const now = readGettingStarted(ctx, projectId);
  if (!now) throw new Error('This project has no walkthrough');
  const off = new Set(cleanTicks(untick));
  const ticked = cleanTicks([...now.ticked, ...cleanTicks(tick)]).filter((n) => !off.has(n));
  return writeFile(ctx, projectId, { ...now, ticked, hidden: now.hidden || hidden === true });
}

// The guided setup offered once to someone who has projects (2026-10-10, "showing this would be better"; it took the
// place of Connect your library's one-time popup): "New: a guided setup", whose Start runs a new user's onboarding over
// what they have. Kept in <dataRoot>/.guided-setup.json as { seen, how, at } once it has been answered, or a new user's
// onboarding has made their first project (they have had it).
const OFFER_FILE = '.guided-setup.json';
const OFFER_HOW = new Set(['shown', 'started', 'dismissed', 'onboarded']);

/** Whether the offer is still to be shown in this data root. */
function guidedOfferDue(ctx) {
  const value = readJson(path.join(ctx.dataRoot, OFFER_FILE));
  return !(value && typeof value === 'object' && value.seen === true);
}

/** The offer shown or answered (`how`: shown, started, dismissed, or onboarded): it is never shown again here. */
function markGuidedOffer(ctx, how, now = new Date()) {
  const value = { seen: true, how: OFFER_HOW.has(how) ? how : 'dismissed', at: now.toISOString() };
  fs.mkdirSync(ctx.dataRoot, { recursive: true });
  projects.writeTextAtomic(path.join(ctx.dataRoot, OFFER_FILE), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

module.exports = { STEPS, readGettingStarted, startGettingStarted, setGettingStarted, OFFER_FILE, guidedOfferDue, markGuidedOffer };
