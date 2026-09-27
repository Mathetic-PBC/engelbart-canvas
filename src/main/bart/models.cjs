'use strict';

// Which model answers an @bart question, and at what effort (2026-09-19). One file for every
// project, <home>/model-effort-inline-question.json, written with these defaults when it is
// missing and read again for every question, so an edit needs no restart. A default changed in a
// later build reaches the file too, unless the person changed that value (2026-09-23,
// ../store/defaults.cjs): what they edited stays, what they left alone follows the new defaults.
//
// A question starts on the first step of the default provider's ladder. The agent may ask to move
// up a step (src/main/bart/ask.cjs), which resumes the same session: what it has read stays read.
// `@bart --opus --high …` picks by hand and turns that off. Flags are matched loosely: case,
// dashes, spaces, dots and version numbers are ignored, and "extra high" is xhigh.

const path = require('node:path');
const { readJson } = require('../store/home.cjs');
const { carryDefaults } = require('../store/defaults.cjs');
const { EFFORTS, effortOf, modelOf, readFlags, readQuestion, withChoice } = require('./question.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');

const MODELS_FILE = 'model-effort-inline-question.json';
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const KEY_RE = /^[a-z][a-z0-9]{0,23}$/;

// Build (2026-09-25; docs/superpowers/specs/2026-09-25-build-workflow-design.md B3): the models a Build can run on, per
// provider, and the one its dialog starts on. A list of its own, so @bart's Sol stays gpt-5.6-sol while a Build's Sol is
// GPT-6-Sol ("opus 5.5 high … sol 6 high for oai"). The dialog starts on the file's `provider`, as @bart does.
const DEFAULT_BUILD = {
  about: 'Models and efforts for Build, the coding agent a workspace hands its document to, and for a post-it\'s quick task. The Build dialog starts on the default provider\'s `default` and lists these models and efforts to pick from.',
  providers: {
    openai: {
      models: {
        luna: { id: 'gpt-6-luna', name: 'Luna', use: 'Fastest. Small, clear changes.' },
        sol: { id: 'gpt-6-sol', name: 'Sol', use: 'The default. Most Builds.' },
        astra: { id: 'gpt-6-astra', name: 'Astra', use: 'Deepest. Hard changes across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'ultra'],
      default: { model: 'sol', effort: 'high' },
    },
    anthropic: {
      models: {
        sonnet: { id: 'sonnet', name: 'Sonnet', use: 'Fast. Small, clear changes.' },
        opus: { id: 'opus', name: 'Opus', use: 'The default. Most Builds.' },
        fable: { id: 'fable', name: 'Fable', use: 'Deepest. Hard changes across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'max'],
      default: { model: 'opus', effort: 'high' },
    },
  },
};

const BART_DEFAULTS = {
  about: 'Models and efforts for @bart, the inline question agent. This file applies to every project and is read again for each question. A question starts on the first step of the default provider\'s ladder; the agent may move up a step when the question needs more than it was given, and it keeps what it has read. `@bart --opus --high …` picks a model and an effort by hand and turns that off. Luna and Sonnet: lookups, definitions, rewording. Sol and Opus: questions that need several files read or careful reasoning. Astra and Fable: the hardest questions, where a slow answer is acceptable. Medium effort answers in seconds; high and xhigh think longer before answering; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.',
  provider: 'openai',
  providers: {
    openai: {
      name: 'Codex',
      models: {
        luna: { id: 'gpt-5.6-luna', name: 'Luna', use: 'Fastest. Lookups, definitions, rewording.' },
        sol: { id: 'gpt-5.6-sol', name: 'Sol', use: 'The default. Most questions about the project.' },
        astra: { id: 'gpt-6-astra', name: 'Astra', use: 'Deepest. Hard reasoning across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'ultra'],
      ladder: [{ model: 'sol', effort: 'medium' }, { model: 'sol', effort: 'high' }, { model: 'astra', effort: 'xhigh' }],
    },
    anthropic: {
      name: 'Claude Code',
      // Aliases, not versions: Claude Code resolves each to the latest model of that name.
      models: {
        sonnet: { id: 'sonnet', name: 'Sonnet', use: 'Fast. Lookups, definitions, rewording, most questions.' },
        opus: { id: 'opus', name: 'Opus', use: 'Questions that need several files read or careful reasoning.' },
        fable: { id: 'fable', name: 'Fable', use: 'Deepest. The hardest questions; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'max'],
      ladder: [{ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }],
    },
  },
};

const DEFAULT_MODELS = { ...BART_DEFAULTS, build: DEFAULT_BUILD };

// Every earlier DEFAULT_MODELS, oldest first. A file written before defaults were carried forward is
// compared with these to tell the values its owner left alone from the ones they chose.
const PAST_DEFAULT_MODELS = [
  // 2026-09-20 (9b50bad): no ultra or max yet, and the last sentence of `about` ended at xhigh.
  {
    ...BART_DEFAULTS,
    about: BART_DEFAULTS.about.replace('; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.', '.'),
    providers: {
      openai: { ...BART_DEFAULTS.providers.openai, efforts: ['medium', 'high', 'xhigh'] },
      anthropic: { ...BART_DEFAULTS.providers.anthropic, efforts: ['medium', 'high', 'xhigh'] },
    },
  },
  // 2026-09-21 to 2026-09-25: @bart alone, before Build had models of its own.
  BART_DEFAULTS,
];

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** A provider's `models` as the file holds them, bad entries dropped; the defaults when none is left. */
function cleanModels(given, fallback) {
  const models = {};
  for (const [name, model] of Object.entries(isObject(given) ? given : {})) {
    const k = String(name).toLowerCase();
    if (!KEY_RE.test(k) || !isObject(model) || typeof model.id !== 'string' || !MODEL_ID_RE.test(model.id)) continue;
    models[k] = { id: model.id, name: typeof model.name === 'string' && model.name.trim() ? model.name.trim().slice(0, 40) : k[0].toUpperCase() + k.slice(1), use: typeof model.use === 'string' ? model.use.slice(0, 300) : '' };
  }
  return Object.keys(models).length ? models : fallback;
}

const cleanEfforts = (given, fallback) => { const efforts = (Array.isArray(given) ? given : []).map(effortOf).filter(Boolean); return efforts.length ? [...new Set(efforts)] : fallback; };

/** Build's block (B3): per provider its models, efforts and the one the dialog starts on, each checked as @bart's are. */
function normalizeBuild(value) {
  const given = isObject(value) ? value : {};
  const providers = {};
  for (const [key, fallback] of Object.entries(DEFAULT_BUILD.providers)) {
    const from = isObject(given.providers) && isObject(given.providers[key]) ? given.providers[key] : {};
    const models = cleanModels(from.models, fallback.models);
    const efforts = cleanEfforts(from.efforts, fallback.efforts);
    const wanted = isObject(from.default) ? { model: String(from.default.model || '').toLowerCase(), effort: effortOf(from.default.effort) } : null;
    const usable = (step) => !!step && !!models[step.model] && efforts.includes(step.effort);
    const start = usable(wanted) ? wanted : usable(fallback.default) ? fallback.default : { model: Object.keys(models)[0], effort: efforts.includes('high') ? 'high' : efforts[0] };
    providers[key] = { models, efforts, default: { model: start.model, effort: start.effort } };
  }
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_BUILD.about, providers };
}

/** Whatever the file holds, made safe to run: unknown providers dropped, bad models, efforts and steps replaced by the defaults. */
function normalizeModels(value) {
  const given = isObject(value) ? value : {};
  const providers = {};
  for (const [key, fallback] of Object.entries(DEFAULT_MODELS.providers)) {
    const from = isObject(given.providers) && isObject(given.providers[key]) ? given.providers[key] : {};
    const held = cleanModels(from.models, fallback.models);
    const ladder = (Array.isArray(from.ladder) ? from.ladder : []).map((step) => (isObject(step) ? { model: String(step.model || '').toLowerCase(), effort: effortOf(step.effort) } : null)).filter((step) => step && held[step.model] && step.effort).slice(0, 5);
    providers[key] = {
      name: fallback.name,
      models: held,
      efforts: cleanEfforts(from.efforts, fallback.efforts),
      ladder: ladder.length ? ladder : fallback.ladder.filter((step) => held[step.model]).length ? fallback.ladder.filter((step) => held[step.model]) : [{ model: Object.keys(held)[0], effort: 'medium' }],
    };
  }
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_MODELS.about, provider: providers[given.provider] ? given.provider : DEFAULT_MODELS.provider, providers, build: normalizeBuild(given.build) };
}

/**
 * What the Build dialog offers, in the shape the @bart selector draws (`BartPicker`): per provider its name, Build's
 * models and efforts, and a one-step `ladder` holding the default. `models` is the list in force (after onlyProviders and
 * preferUsable), so the dialog starts on the provider @bart would start on.
 */
function buildChoices(models) {
  const build = models.build || normalizeBuild(null);
  const providers = {};
  for (const key of Object.keys(models.providers)) {
    const entry = build.providers[key];
    if (!entry) continue;
    providers[key] = { name: models.providers[key].name, models: entry.models, efforts: entry.efforts, ladder: [entry.default] };
  }
  return { provider: providers[models.provider] ? models.provider : Object.keys(providers)[0], providers };
}

/** A pick from the dialog made real: the model's id and name, the effort; the defaults when the pick names nothing Build knows. */
function resolveBuildChoice(models, { provider, model, effort } = {}) {
  const choices = buildChoices(models);
  const at = choices.providers[provider] ? provider : choices.provider;
  const entry = choices.providers[at];
  const key = entry.models[model] ? model : entry.ladder[0].model;
  const level = entry.efforts.includes(effort) ? effort : entry.ladder[0].effort;
  return { provider: at, model: key, modelId: entry.models[key].id, modelName: entry.models[key].name, effort: level };
}

/** Only the providers config.json lists (`providers`); when it lists none of them, all stay, so a question can always run. */
function onlyProviders(models, only) {
  const kept = Object.keys(models.providers).filter((key) => Array.isArray(only) && only.includes(key));
  if (!kept.length) return models;
  return { ...models, provider: kept.includes(models.provider) ? models.provider : kept[0], providers: Object.fromEntries(kept.map((key) => [key, models.providers[key]])) };
}

/**
 * The saved default provider, or another one when the saved one cannot run (2026-09-23; design D4).
 * `usable`: the CLIs the last tool check found installed, recent enough and not signed out
 * (['claude', 'codex'] or fewer), or null before the first check. Nothing is written: the saved
 * choice comes back as soon as its CLI does. A model picked by flag is never moved.
 */
function preferUsable(models, usable) {
  if (!Array.isArray(usable)) return models;
  const can = (provider) => usable.includes(TOOL_OF[provider]);
  if (can(models.provider)) return models;
  const other = Object.keys(models.providers).find(can);
  return other ? { ...models, provider: other } : models;
}

/**
 * The list in force: the file, with the defaults written the first time so there is a file to edit, and
 * any default changed since carried into it where the person left that value alone. `only`: the
 * providers config.json offers.
 */
function loadModels(homeRoot, { only } = {}) {
  const file = path.join(homeRoot, MODELS_FILE);
  let held;
  try {
    held = carryDefaults({ file, defaults: DEFAULT_MODELS, past: PAST_DEFAULT_MODELS, backupDir: path.join(homeRoot, '.backups') }).value;
  } catch {
    held = readJson(file); // read-only home: what is there (or the defaults) still applies
  }
  const models = normalizeModels(held || DEFAULT_MODELS);
  return only ? onlyProviders(models, only) : models;
}

module.exports = { MODELS_FILE, EFFORTS, DEFAULT_MODELS, DEFAULT_BUILD, PAST_DEFAULT_MODELS, normalizeModels, normalizeBuild, buildChoices, resolveBuildChoice, onlyProviders, preferUsable, loadModels, effortOf, modelOf, readFlags, readQuestion, withChoice };
