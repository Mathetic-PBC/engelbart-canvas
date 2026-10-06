'use strict';

// Settings › Intelligence (2026-10-06, MATH-53; src/renderer/ui/Settings.jsx): the default model and effort of each agent
// on each provider, and the default provider of @bart (which @brainstorm and @discover follow) and of Build. No file of its
// own: the defaults are the models file's (./models.cjs), so a save writes what an edit by hand would, and the next run
// reads it with no restart. Each agent's default is
//   @bart        providers.<p>.ladder[0], then the built-in ladder's steps above it (withFirstStep)
//   @brainstorm  brainstorm.providers.<p>
//   @discover    discover.providers.<p>.standard (quick and deep under the panel's Advanced)
//   Build        build.providers.<p>.default, which a post-it's quick task starts on too
// The last action wins: setting @bart's default provider forgets @bart's last pick by hand, and setting its default on a
// provider forgets that pick when it is on that provider; Build's do the same to Build's pick and the quick task's
// (./choices.cjs). A pick by hand after that is kept as before, and wins until the next save.

const fs = require('node:fs');
const path = require('node:path');
const { MODELS_FILE, MODES, loadModels, normalizeModels, fileShape, withFirstStep, onlyProviders, preferUsable, startingAt } = require('./models.cjs');
const { PLACES, readChoices, forgetChoice } = require('./choices.cjs');
const { equal, writeJsonFile } = require('../store/defaults.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');

// What a save may name: the two default providers, then per agent { <provider>: { model, effort } } (@discover's
// { <provider>: { quick?, standard?, deep? } }).
const PATCH_KEYS = Object.freeze(['provider', 'buildProvider', 'bart', 'brainstorm', 'discover', 'build']);

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The list a run starts on (index.cjs readModels): the models file, cut to the providers config.json offers (`only`),
 * starting where `place` ('bart', 'build' or 'quick') was last picked by hand, else on its default, on a provider whose CLI
 * can run (`usable`, the tool check's; null before it). Read again for every run.
 */
function modelsInForce(homeRoot, place = 'bart', { only, usable = null } = {}) {
  return preferUsable(startingAt(loadModels(homeRoot, { only }), place, readChoices(homeRoot)[place]), usable);
}

/** Why each provider's CLI cannot run now: 'not installed', 'signed out', 'out of date' or 'cannot run'; null when it can, or before the first check. */
function cliNotes(providers, tools) {
  const usable = tools ? tools.usableAgents() : null;
  const records = tools && Array.isArray(usable) ? (tools.snapshot().tools || {}) : {};
  const out = {};
  for (const provider of Object.keys(providers)) {
    const name = TOOL_OF[provider], record = records[name] || {};
    out[provider] = !Array.isArray(usable) || usable.includes(name) ? null
      : !record.installed ? 'not installed'
        : record.status === 'signed-out' ? 'signed out'
          : record.status === 'outdated' || record.status === 'incompatible' ? 'out of date' : 'cannot run';
  }
  return out;
}

/** The models file as it is on disk; a file that is not a JSON object is refused, never written over: the person may be halfway through an edit. */
function readFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  let value = null;
  try { value = JSON.parse(text); } catch { /* refused below */ }
  if (!isObject(value)) throw new Error(`${MODELS_FILE} is not valid JSON. Fix it or delete it, then save again.`);
  return value;
}

/**
 * Why the models file cannot be read, or null when it can (or is not there). While it cannot, every run is on the
 * built-in defaults (loadModels) and a save is refused, so the panel says so instead of showing those defaults as if
 * they were the file's.
 */
function fileError(homeRoot) {
  try {
    readFile(path.join(homeRoot, MODELS_FILE));
    return null;
  } catch (error) {
    const why = /is not valid JSON/.test(error.message) ? 'is not valid JSON' : `cannot be read (${error.code || error.message})`;
    return `${MODELS_FILE} ${why}, so every agent runs on the built-in defaults shown here, and a pick here is not saved. Fix the file or delete it.`;
  }
}

/**
 * What the panel shows → { models, choices, usable, offered, cli, fileError }: the models file normalized, every provider,
 * before a last pick or a CLI that cannot run moves anything; the last picks by hand (./choices.cjs); the CLIs that can
 * run (null before the first check); the providers config.json offers (all when it names none of them, as onlyProviders);
 * why each provider's CLI cannot run, if it cannot; and why the models file cannot be read, if it cannot (null when it can).
 */
function settingsModels(homeRoot, { only, tools = null } = {}) {
  const models = loadModels(homeRoot);
  return { models, choices: readChoices(homeRoot), usable: tools ? tools.usableAgents() : null, offered: Object.keys(onlyProviders(models, only).providers), cli: cliNotes(models.providers, tools), fileError: fileError(homeRoot) };
}

function providerOf(models, value, what) {
  if (typeof value !== 'string' || !Object.hasOwn(models.providers, value)) throw new TypeError(`${what} must be one of ${Object.keys(models.providers).join(', ')}`);
  return value;
}

/** A pick checked against the list it must come from (`list`: { models, efforts }). → { model, effort } */
function stepOf(list, value, what) {
  if (!isObject(value) || typeof value.model !== 'string' || !Object.hasOwn(list.models, value.model) || typeof value.effort !== 'string' || !list.efforts.includes(value.effort)) {
    throw new TypeError(`${what} must be one of its provider's models and efforts`);
  }
  return { model: value.model, effort: value.effort };
}

/** { <provider>: value } → [[provider, value]], every provider one the file knows. */
function eachProvider(models, value, what) {
  if (value === undefined) return [];
  if (!isObject(value)) throw new TypeError(`${what} must name providers`);
  return Object.entries(value).map(([provider, held]) => [providerOf(models, provider, `${what}'s provider`), held]);
}

/**
 * Every value `patch` sets, checked against the list in force (`current`, the file normalized) before anything is written,
 * and only those that differ from it: [[keys into the file, value]].
 */
function changesOf(current, patch) {
  const changes = [];
  const change = (keys, value, now) => { if (!equal(value, now)) changes.push([keys, value]); };
  if (patch.provider !== undefined) change(['provider'], providerOf(current, patch.provider, 'provider'), current.provider);
  if (patch.buildProvider !== undefined) change(['build', 'provider'], providerOf(current, patch.buildProvider, 'buildProvider'), current.build.provider);
  for (const [provider, value] of eachProvider(current, patch.bart, '@bart')) {
    const entry = current.providers[provider];
    change(['providers', provider, 'ladder'], withFirstStep(provider, entry, stepOf(entry, value, `@bart on ${provider}`)), entry.ladder);
  }
  for (const [provider, value] of eachProvider(current, patch.brainstorm, '@brainstorm')) {
    change(['brainstorm', 'providers', provider], stepOf(current.providers[provider], value, `@brainstorm on ${provider}`), current.brainstorm.providers[provider]);
  }
  for (const [provider, levels] of eachProvider(current, patch.discover, '@discover')) {
    if (!isObject(levels)) throw new TypeError(`@discover on ${provider} must name its levels`);
    for (const [mode, value] of Object.entries(levels)) {
      if (!MODES.includes(mode)) throw new TypeError(`@discover's level must be one of ${MODES.join(', ')}`);
      change(['discover', 'providers', provider, mode], stepOf(current.providers[provider], value, `@discover ${mode} on ${provider}`), current.discover.providers[provider][mode]);
    }
  }
  for (const [provider, value] of eachProvider(current, patch.build, 'Build')) {
    const entry = current.build.providers[provider];
    change(['build', 'providers', provider, 'default'], stepOf(entry, value, `Build on ${provider}`), entry.default);
  }
  return changes;
}

/** `value` put at `keys` in `object`, making the objects on the way that are missing (or are not objects). */
function setAt(object, keys, value) {
  let held = object;
  for (const key of keys.slice(0, -1)) {
    if (!isObject(held[key])) held[key] = {};
    held = held[key];
  }
  held[keys[keys.length - 1]] = value;
}

/**
 * A save from the panel → what settingsModels gives after it. Every pick is checked first (one that is not one of its
 * provider's models and efforts refuses the whole save); then only the values that change are written into the file as it
 * is on disk, so its `about`s, its other values and keys Engelbart does not know stay as they are. Written whole, over a
 * temporary. Then the last action wins over the picks it overrules: @bart's last pick is forgotten when the save names
 * @bart's provider, or @bart's default on the provider that pick is on; Build's and the quick task's the same way, by
 * Build's provider and Build's defaults. A pick on the other provider stays: saving Codex's default leaves a pick on
 * Claude Code alone.
 */
function saveSettingsModels(homeRoot, patch, options = {}) {
  if (!isObject(patch)) throw new TypeError('settings must be an object');
  const unknown = Object.keys(patch).find((key) => !PATCH_KEYS.includes(key));
  if (unknown) throw new TypeError(`${unknown} is not a setting`);
  const file = path.join(homeRoot, MODELS_FILE);
  loadModels(homeRoot); // the file is there, and any default changed since is carried into it, before it is edited
  const held = readFile(file);
  const changes = changesOf(normalizeModels(held), patch);
  if (changes.length) {
    const next = fileShape(JSON.parse(JSON.stringify(held)));
    for (const [keys, value] of changes) setAt(next, keys, value);
    writeJsonFile(file, next);
  }
  const choices = readChoices(homeRoot);
  const overruled = (place, provider, defaults) => provider !== undefined || (!!choices[place] && isObject(defaults) && Object.hasOwn(defaults, choices[place].provider));
  if (overruled('bart', patch.provider, patch.bart)) forgetChoice(homeRoot, 'bart');
  for (const place of ['build', 'quick']) if (overruled(place, patch.buildProvider, patch.build)) forgetChoice(homeRoot, place);
  return settingsModels(homeRoot, options);
}

/**
 * The panel's calls, on the home Engelbart is using now (`homeRoot()`), the providers config.json offers now (`only()`)
 * and the tool check (`tools`, optional): read, save and forget ("Use default": that place starts on its default again).
 */
function createModelSettings({ homeRoot, only = () => undefined, tools = null }) {
  const options = () => ({ only: only(), tools });
  return {
    read: () => settingsModels(homeRoot(), options()),
    save: (patch) => saveSettingsModels(homeRoot(), patch, options()),
    forget: (place) => {
      if (!PLACES.includes(place)) throw new TypeError(`place must be one of ${PLACES.join(', ')}`);
      forgetChoice(homeRoot(), place);
      return settingsModels(homeRoot(), options());
    },
  };
}

module.exports = { PATCH_KEYS, modelsInForce, cliNotes, fileError, settingsModels, saveSettingsModels, createModelSettings };
