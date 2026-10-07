'use strict';

// The model and effort last picked by hand, one for each place that picks (2026-09-29): @bart (a question asked with
// flags, from the chip's selector or Regenerate), a workspace's Build panel, and a post-it's quick task. Each is where the
// next one starts (./models.cjs startingAt), so a choice made once is kept until another is made. One file for every
// project, beside the models file: <home>/model-choices.json. It holds keys only; ./models.cjs checks them against the
// list in force each time, so a model taken out of the list is simply not started on. Setting a place's default in
// Settings › Intelligence (2026-10-06, ./settings.cjs) forgets its pick (forgetChoice): whichever was done last wins.

const fs = require('node:fs');
const path = require('node:path');
const { readJson } = require('../store/home.cjs');
const { EFFORTS } = require('./question.cjs');

const CHOICES_FILE = 'model-choices.json';
const PLACES = Object.freeze(['bart', 'build', 'quick']);
const KEY_RE = /^[a-z][a-z0-9]{0,23}$/;
const ABOUT = 'The model and effort last picked by hand for @bart, Build and a sticky\'s quick task: where the next one starts. Written by Engelbart whenever you pick, and cleared for a place when you set its default in Settings; the lists and the defaults themselves are in model-effort-inline-question.json.';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** A pick as it may be kept: { provider, model, effort } of plain keys, or null. */
function cleanChoice(value) {
  if (!isObject(value)) return null;
  const provider = String(value.provider || '').toLowerCase();
  const model = String(value.model || '').toLowerCase();
  const effort = String(value.effort || '').toLowerCase();
  if (!KEY_RE.test(provider) || !KEY_RE.test(model) || !EFFORTS.includes(effort)) return null;
  return { provider, model, effort };
}

/** → { bart?, build?, quick? }: what the file holds that is well formed. */
function readChoices(homeRoot) {
  const held = readJson(path.join(homeRoot, CHOICES_FILE));
  const out = {};
  for (const place of PLACES) {
    const choice = isObject(held) ? cleanChoice(held[place]) : null;
    if (choice) out[place] = choice;
  }
  return out;
}

/** The file written whole: a temporary beside it renamed over it, so a reader never sees half of it. */
function writeChoices(homeRoot, choices) {
  const file = path.join(homeRoot, CHOICES_FILE);
  fs.mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ about: ABOUT, ...choices }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** Keeps `choice` as where `place` starts next time. → the pick kept, or null when it was not one (nothing is written). */
function rememberChoice(homeRoot, place, choice) {
  const clean = cleanChoice(choice);
  if (!PLACES.includes(place) || !clean) return null;
  const now = readChoices(homeRoot);
  const same = now[place] && now[place].provider === clean.provider && now[place].model === clean.model && now[place].effort === clean.effort;
  if (same) return clean;
  writeChoices(homeRoot, { ...now, [place]: clean });
  return clean;
}

/** Forgets what `place` last picked, so it starts on its default again. → whether there was a pick (nothing is written when not). */
function forgetChoice(homeRoot, place) {
  if (!PLACES.includes(place)) return false;
  const { [place]: held, ...rest } = readChoices(homeRoot);
  if (!held) return false;
  writeChoices(homeRoot, rest);
  return true;
}

module.exports = { CHOICES_FILE, PLACES, cleanChoice, readChoices, rememberChoice, forgetChoice };
