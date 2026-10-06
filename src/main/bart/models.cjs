'use strict';

// Which model answers an @bart question, and at what effort (2026-09-19). One file for every
// project, <home>/model-effort-inline-question.json, written with these defaults when it is
// missing and read again for every question, so an edit needs no restart. A default changed in a
// later build reaches the file too, unless the person changed that value (2026-09-23,
// ../store/defaults.cjs): what they edited stays, what they left alone follows the new defaults.
//
// A question starts on the first step of the default provider's ladder, or where the last question picked by hand did
// (2026-09-29, startingAt and ./choices.cjs). Settings › Intelligence (2026-10-06, ./settings.cjs) writes the defaults
// into this same file and drops the last pick of each place whose default it set: the last action wins. The agent may ask to move
// up a step (src/main/bart/ask.cjs), which resumes the same session: what it has read stays read.
// `@bart --opus --high …` picks by hand and turns that off. Flags are matched loosely: case,
// dashes, spaces, dots and version numbers are ignored, and "extra high" is xhigh.

const path = require('node:path');
const { readJson } = require('../store/home.cjs');
const { carryDefaults } = require('../store/defaults.cjs');
const { EFFORTS, MODES, above, effortOf, modelOf, readFlags, readQuestion, readDiscover, withChoice } = require('./question.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');

const MODELS_FILE = 'model-effort-inline-question.json';
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const KEY_RE = /^[a-z][a-z0-9]{0,23}$/;

// Build (2026-09-25; docs/superpowers/specs/2026-09-25-build-workflow-design.md B3): the models a Build can run on, per
// provider, and the one its dialog starts on. Since 2026-09-29 Build has a provider of its own (Claude Code, Opus high),
// and the dialog starts on what was last picked in it (./choices.cjs), a post-it's quick task on its own last pick.
const DEFAULT_BUILD = {
  about: 'Models and efforts for Build, the coding agent a workspace hands its document to, and for a sticky\'s quick task. The Build dialog starts on the model and effort last picked in it (a sticky\'s on its own last pick; model-choices.json), else on `provider`\'s `default`, and lists these models and efforts to pick from. When `provider`\'s CLI cannot run (not installed or not signed in), it starts on the other provider\'s `default`.',
  provider: 'anthropic',
  providers: {
    openai: {
      models: {
        luna: { id: 'gpt-6-luna', name: 'Luna', use: 'Fastest. Small, clear changes.' },
        sol: { id: 'gpt-6.1-sol', name: 'Sol', use: 'The default. Most Builds.' },
        astra: { id: 'gpt-6-astra', name: 'Astra', use: 'Deepest. Hard changes across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'ultra'],
      default: { model: 'sol', effort: 'high' },
    },
    anthropic: {
      models: {
        sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet', use: 'Fast. Small, clear changes.' },
        opus: { id: 'opus', name: 'Opus', use: 'The default. Most Builds.' },
        fable: { id: 'fable', name: 'Fable', use: 'Deepest. Hard changes across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'max'],
      default: { model: 'opus', effort: 'high' },
    },
  },
};

const BART_DEFAULTS = {
  about: 'Models and efforts for @bart, the inline question agent. This file applies to every project and is read again for each question. A question starts where the last one picked by hand did (model-choices.json), else on the first step of the default provider\'s ladder, or on the other provider\'s when the default one\'s CLI cannot run (not installed or not signed in). The agent may move up a step when the question needs more than it was given, and it keeps what it has read. `@bart --opus --high …` picks a model and an effort by hand and turns that off. Luna and Sonnet: lookups, definitions, rewording. Sol and Opus: questions that need several files read or careful reasoning. Astra and Fable: the hardest questions, where a slow answer is acceptable. Medium effort answers in seconds; high and xhigh think longer before answering; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.',
  provider: 'anthropic',
  providers: {
    openai: {
      name: 'Codex',
      models: {
        luna: { id: 'gpt-6-luna', name: 'Luna', use: 'Fastest. Lookups, definitions, rewording.' },
        sol: { id: 'gpt-6.1-sol', name: 'Sol', use: 'The default. Most questions about the project.' },
        astra: { id: 'gpt-6-astra', name: 'Astra', use: 'Deepest. Hard reasoning across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'ultra'],
      ladder: [{ model: 'sol', effort: 'medium' }, { model: 'sol', effort: 'high' }, { model: 'astra', effort: 'xhigh' }],
    },
    anthropic: {
      name: 'Claude Code',
      // Opus and Fable are aliases, not versions: Claude Code resolves each to the latest model of that name. Sonnet is
      // named by version (2026-09-29), since a Claude Code older than 2.1.284 still resolves `sonnet` to Sonnet 5.
      models: {
        sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet', use: 'Fast. Lookups, definitions, rewording, most questions.' },
        opus: { id: 'opus', name: 'Opus', use: 'Questions that need several files read or careful reasoning.' },
        fable: { id: 'fable', name: 'Fable', use: 'Deepest. The hardest questions; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh', 'max'],
      ladder: [{ model: 'sonnet', effort: 'high' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }],
    },
  },
};

// @brainstorm (2026-09-30; fixed 2026-10-02; in the file again 2026-10-06, for Settings): one step per provider, no
// ladder, on the provider an @bart question would start on. Not picked by flags. Keys name @bart's models above; a model
// taken out of that list (or an effort it no longer offers) gives way to the default, else that provider's first step
// (normalizeBrainstorm).
const DEFAULT_BRAINSTORM = {
  about: 'The model and effort for @brainstorm, the agent that asks one card at a time to help find what to work on. One step per provider and no ladder: it runs on the provider an @bart question would start on, at that provider\'s step here. The models and efforts are the ones listed above for @bart. Flags on an @brainstorm line pick nothing; Settings (the gear, top right) changes these.',
  providers: {
    anthropic: { model: 'sonnet', effort: 'high' },
    openai: { model: 'sol', effort: 'medium' },
  },
};

// @discover (2026-09-30; three levels 2026-10-02): per provider a step for each of question.cjs MODES. It reads, looks
// papers up and follows citations for minutes, and every entry it writes must be checked against what it found, so a plain
// @discover starts where @bart's ladder goes for careful work; --quick takes a fast look, --deep goes as far as either goes.
const DEFAULT_DISCOVER = {
  about: 'The models and efforts for @discover, the agent that finds what to read about a problem by following the citations of the papers in the library. Three levels per provider and no ladder: `quick` (`@discover --quick …`, a fast look: at most five sources), `standard` (a plain `@discover …`: at most eight) and `deep` (`@discover --deep …`, a second hop: at most fifteen). It runs on the provider an @bart question would start on, at that provider\'s level here, and an answer or a follow-up stays on the level its exchange was asked at. The models are the ones listed above for @bart. `@discover --sonnet …` or `--high` picks by hand for that line.',
  providers: {
    openai: { quick: { model: 'sol', effort: 'medium' }, standard: { model: 'astra', effort: 'high' }, deep: { model: 'astra', effort: 'ultra' } },
    anthropic: { quick: { model: 'sonnet', effort: 'medium' }, standard: { model: 'opus', effort: 'high' }, deep: { model: 'opus', effort: 'max' } },
  },
};

const DEFAULT_MODELS = { ...BART_DEFAULTS, build: DEFAULT_BUILD, brainstorm: DEFAULT_BRAINSTORM, discover: DEFAULT_DISCOVER };

/** `defaults` with some models' ids replaced: { openai: { sol: 'gpt-6-sol' } }. */
function withIds(defaults, ids) {
  const providers = { ...defaults.providers };
  for (const [provider, changes] of Object.entries(ids)) {
    const models = { ...providers[provider].models };
    for (const [key, id] of Object.entries(changes)) models[key] = { ...models[key], id };
    providers[provider] = { ...providers[provider], models };
  }
  return { ...defaults, providers };
}

// What shipped from 2026-09-25 (Build) and 2026-09-27 (@bart on GPT-6) until 2026-09-29: GPT-6 Sol, Claude Code's
// `sonnet` alias, @bart on Codex first (Sol medium) and Claude Code's ladder from Sonnet medium, Build on @bart's provider.
const BUILD_0925 = withIds({
  about: 'Models and efforts for Build, the coding agent a workspace hands its document to, and for a sticky\'s quick task. The Build dialog starts on the default provider\'s `default` and lists these models and efforts to pick from.',
  providers: DEFAULT_BUILD.providers,
}, { openai: { sol: 'gpt-6-sol' }, anthropic: { sonnet: 'sonnet' } });
const BART_0927 = (() => {
  const shipped = withIds(BART_DEFAULTS, { openai: { sol: 'gpt-6-sol' }, anthropic: { sonnet: 'sonnet' } });
  return {
    ...shipped,
    about: 'Models and efforts for @bart, the inline question agent. This file applies to every project and is read again for each question. A question starts on the first step of the default provider\'s ladder; the agent may move up a step when the question needs more than it was given, and it keeps what it has read. `@bart --opus --high …` picks a model and an effort by hand and turns that off. Luna and Sonnet: lookups, definitions, rewording. Sol and Opus: questions that need several files read or careful reasoning. Astra and Fable: the hardest questions, where a slow answer is acceptable. Medium effort answers in seconds; high and xhigh think longer before answering; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.',
    provider: 'openai',
    providers: { ...shipped.providers, anthropic: { ...shipped.providers.anthropic, ladder: [{ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }] } },
  };
})();

// Keep the shipped 5.6 defaults as migration bases, so untouched model IDs move to 6.
const PREVIOUS_BART_DEFAULTS = withIds(BART_0927, { openai: { luna: 'gpt-5.6-luna', sol: 'gpt-5.6-sol' } });

// @brainstorm's and @discover's blocks as 2026-09-30 wrote them: one step per provider each.
const BRAINSTORM_0930 = {
  about: 'The model and effort for @brainstorm, the agent that asks one card at a time to help find what to work on. One step per provider and no ladder: it runs on the provider an @bart question would start on, at that provider\'s step here. The models are the ones listed above for @bart. `@brainstorm --opus …` picks by hand for that line.',
  providers: { openai: { model: 'sol', effort: 'medium' }, anthropic: { model: 'sonnet', effort: 'high' } },
};
const DISCOVER_0930 = {
  about: 'The model and effort for @discover, the agent that finds what to read about a problem by following the citations of the papers in the library. One step per provider and no ladder: it runs on the provider an @bart question would start on, at that provider\'s step here. The models are the ones listed above for @bart. `@discover --sonnet …` picks by hand for that line; `--deep` traces further.',
  providers: { openai: { model: 'sol', effort: 'high' }, anthropic: { model: 'opus', effort: 'high' } },
};

// Every earlier DEFAULT_MODELS, oldest first. A file written before defaults were carried forward is
// compared with these to tell the values its owner left alone from the ones they chose.
const PAST_DEFAULT_MODELS = [
  // 2026-09-20 (9b50bad): no ultra or max yet, and the last sentence of `about` ended at xhigh.
  {
    ...PREVIOUS_BART_DEFAULTS,
    about: PREVIOUS_BART_DEFAULTS.about.replace('; ultra (Codex) and max (Claude Code) are the most either will spend, by hand only: no ladder reaches them.', '.'),
    providers: {
      openai: { ...PREVIOUS_BART_DEFAULTS.providers.openai, efforts: ['medium', 'high', 'xhigh'] },
      anthropic: { ...PREVIOUS_BART_DEFAULTS.providers.anthropic, efforts: ['medium', 'high', 'xhigh'] },
    },
  },
  // 2026-09-21 to 2026-09-25: @bart alone, before Build had models of its own.
  PREVIOUS_BART_DEFAULTS,
  // 2026-09-25 to 2026-09-27: Build had its own GPT-6 models; @bart still used 5.6.
  { ...PREVIOUS_BART_DEFAULTS, build: BUILD_0925 },
  // 2026-09-27 to 2026-09-29: both on GPT-6, @bart on Codex first.
  { ...BART_0927, build: BUILD_0925 },
  // 2026-09-29 to 2026-09-30: GPT-6.1 Sol, Sonnet 5.5, Claude Code first, Build on a provider of its own.
  { ...BART_DEFAULTS, build: DEFAULT_BUILD },
  // 2026-09-30 to 2026-10-02: @brainstorm and @discover, one step each, both in the file.
  { ...BART_DEFAULTS, build: DEFAULT_BUILD, brainstorm: BRAINSTORM_0930, discover: DISCOVER_0930 },
  // 2026-10-02 to 2026-10-06: @discover's three levels; @brainstorm's step fixed in the code, not in the file.
  { ...BART_DEFAULTS, build: DEFAULT_BUILD, discover: DEFAULT_DISCOVER },
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
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_BUILD.about, provider: providers[given.provider] ? given.provider : DEFAULT_BUILD.provider, providers };
}

/**
 * An @discover provider's levels as the file holds them, { quick, standard, deep }. The one-step shape 2026-09-30 wrote
 * ({ model, effort }) is that provider's `standard` level, the half of it the person left alone taken from that day's
 * default (carryDefaults drops a value equal to its base); quick and deep come from the levels beside it, else the defaults.
 */
function discoverLevels(from, key) {
  if (!isObject(from)) return {};
  if (from.model === undefined && from.effort === undefined) return from;
  const old = DISCOVER_0930.providers[key] || {};
  const { model = old.model, effort = old.effort, ...levels } = from;
  return { ...DEFAULT_DISCOVER.providers[key], ...levels, standard: { model, effort } };
}

/**
 * @discover's block: per provider a step for each mode, each one of that provider's @bart models and efforts, else that
 * level's default, else the provider's ladder's first.
 */
function normalizeDiscover(value, providers) {
  const given = isObject(value) ? value : {};
  const out = {};
  for (const [key, entry] of Object.entries(providers)) {
    const levels = discoverLevels(isObject(given.providers) ? given.providers[key] : null, key);
    const usable = (step) => !!step && !!entry.models[step.model] && entry.efforts.includes(step.effort);
    out[key] = {};
    for (const mode of MODES) {
      const from = levels[mode];
      const wanted = isObject(from) ? { model: String(from.model || '').toLowerCase(), effort: effortOf(from.effort) } : null;
      const step = [wanted, (DEFAULT_DISCOVER.providers[key] || {})[mode]].find(usable) || entry.ladder[0];
      out[key][mode] = { model: step.model, effort: step.effort };
    }
  }
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_DISCOVER.about, providers: out };
}

/**
 * @brainstorm's block (2026-10-06): per provider one step, one of that provider's @bart models and efforts, else the
 * default, else the provider's ladder's first.
 */
function normalizeBrainstorm(value, providers) {
  const given = isObject(value) ? value : {};
  const out = {};
  for (const [key, entry] of Object.entries(providers)) {
    const from = isObject(given.providers) ? given.providers[key] : null;
    const wanted = isObject(from) ? { model: String(from.model || '').toLowerCase(), effort: effortOf(from.effort) } : null;
    const usable = (step) => !!step && !!entry.models[step.model] && entry.efforts.includes(step.effort);
    const step = [wanted, DEFAULT_BRAINSTORM.providers[key]].find(usable) || entry.ladder[0];
    out[key] = { model: step.model, effort: step.effort };
  }
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_BRAINSTORM.about, providers: out };
}

/**
 * The file as the app reads it, for carryDefaults to write: an @discover provider still in the one-step shape, or holding
 * the step left of it beside levels the new defaults brought, as its three levels (discoverLevels). Nothing else changes.
 */
function fileShape(value) {
  const discover = isObject(value) ? value.discover : null;
  if (!isObject(discover) || !isObject(discover.providers)) return value;
  const providers = { ...discover.providers };
  for (const key of Object.keys(DEFAULT_DISCOVER.providers)) {
    const from = providers[key];
    if (isObject(from) && (from.model !== undefined || from.effort !== undefined)) providers[key] = discoverLevels(from, key);
  }
  return { ...value, discover: { ...discover, providers } };
}

/**
 * The text after "@brainstorm" (2026-09-30; fixed 2026-10-02; from the file 2026-10-06) → what readQuestion gives, on one
 * step: the models file's `brainstorm` step for the provider an @bart question would start on, else the default, else that
 * provider's first step. No ladder, so nothing to move up to. A flag picks nothing here: it is taken off the question and
 * the step stays (B-02).
 */
function readBrainstorm(text, models) {
  const provider = models.provider, entry = models.providers[provider];
  const usable = (step) => !!step && !!entry.models[step.model] && entry.efforts.includes(step.effort);
  const rung = [models.brainstorm && models.brainstorm.providers ? models.brainstorm.providers[provider] : null, DEFAULT_BRAINSTORM.providers[provider]].find(usable) || entry.ladder[0];
  return { question: readFlags(text, models).rest, provider, steps: [{ provider, key: rung.model, model: entry.models[rung.model].id, name: entry.models[rung.model].name, effort: rung.effort }], pinned: false };
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
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_MODELS.about, provider: providers[given.provider] ? given.provider : DEFAULT_MODELS.provider, providers, build: normalizeBuild(given.build), brainstorm: normalizeBrainstorm(given.brainstorm, providers), discover: normalizeDiscover(given.discover, providers) };
}

/**
 * @bart's ladder on one provider with `first` as its first step (Settings, 2026-10-06): the steps above it stay as they
 * are, and those at or below it go, so the ladder still only goes up (`above`, as a last pick's ladder is cut: ./question.cjs).
 */
function withFirstStep(entry, first) {
  const step = { model: first.model, effort: first.effort };
  return [step, ...entry.ladder.slice(1).filter((rung) => above(entry, rung, step))];
}

/**
 * What the Build dialog offers, in the shape the @bart selector draws (`BartPicker`): per provider its name, Build's
 * models and efforts, and a one-step `ladder` holding the default. `models` is the list in force (after startingAt,
 * onlyProviders and preferUsable), so the dialog starts on Build's provider, or on the other one while its CLI cannot run.
 */
function buildChoices(models) {
  const build = models.build || normalizeBuild(null);
  const providers = {};
  for (const key of Object.keys(models.providers)) {
    const entry = build.providers[key];
    if (!entry) continue;
    providers[key] = { name: models.providers[key].name, models: entry.models, efforts: entry.efforts, ladder: [entry.default] };
  }
  const provider = [build.provider, models.provider].find((key) => providers[key]) || Object.keys(providers)[0];
  return { provider, providers };
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
  const build = models.build && !kept.includes(models.build.provider) ? { ...models.build, provider: kept[0] } : models.build;
  return { ...models, provider: kept.includes(models.provider) ? models.provider : kept[0], providers: Object.fromEntries(kept.map((key) => [key, models.providers[key]])), ...(build ? { build } : {}) };
}

/**
 * The saved default provider, or another one when the saved one cannot run (2026-09-23; design D4), for @bart and for
 * Build alike. `usable`: the CLIs the last tool check found installed, recent enough and not signed out
 * (['claude', 'codex'] or fewer), or null before the first check. Nothing is written: the saved
 * choice comes back as soon as its CLI does. A model picked by flag is never moved.
 */
function preferUsable(models, usable) {
  if (!Array.isArray(usable)) return models;
  const can = (provider) => usable.includes(TOOL_OF[provider]);
  const moved = (provider) => (can(provider) ? provider : Object.keys(models.providers).find(can) || provider);
  const provider = moved(models.provider);
  const build = models.build && moved(models.build.provider) !== models.build.provider ? { ...models.build, provider: moved(models.build.provider) } : models.build;
  if (provider === models.provider && build === models.build) return models;
  return { ...models, provider, ...(build ? { build } : {}) };
}

/**
 * The list starting where the person last picked (2026-09-29; `held` { provider, model, effort } from ./choices.cjs) for
 * `place`: 'bart' → that provider becomes the default and its `start` the step a question without flags starts on (the
 * ladder goes on above it, ./question.cjs); 'build' or 'quick' → Build's provider and that provider's `default`. A pick the
 * list no longer offers is ignored. Applied before preferUsable, so a pick whose CLI cannot run gives way as the saved
 * default does.
 */
function startingAt(models, place, held) {
  if (!isObject(held) || typeof held.provider !== 'string' || typeof held.model !== 'string' || typeof held.effort !== 'string') return models;
  if (place === 'bart') {
    const entry = models.providers[held.provider];
    if (!entry || !entry.models[held.model] || !entry.efforts.includes(held.effort)) return models;
    return { ...models, provider: held.provider, providers: { ...models.providers, [held.provider]: { ...entry, start: { model: held.model, effort: held.effort } } } };
  }
  const build = models.build;
  const entry = build && models.providers[held.provider] ? build.providers[held.provider] : null;
  if (!entry || !entry.models[held.model] || !entry.efforts.includes(held.effort)) return models;
  return { ...models, build: { ...build, provider: held.provider, providers: { ...build.providers, [held.provider]: { ...entry, default: { model: held.model, effort: held.effort } } } } };
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
    held = carryDefaults({ file, defaults: DEFAULT_MODELS, past: PAST_DEFAULT_MODELS, normalize: fileShape, backupDir: path.join(homeRoot, '.backups') }).value;
  } catch {
    held = readJson(file); // read-only home: what is there (or the defaults) still applies
  }
  const models = normalizeModels(held || DEFAULT_MODELS);
  return only ? onlyProviders(models, only) : models;
}

module.exports = { MODELS_FILE, EFFORTS, MODES, DEFAULT_MODELS, DEFAULT_BUILD, DEFAULT_BRAINSTORM, DEFAULT_DISCOVER, PAST_DEFAULT_MODELS, normalizeModels, normalizeBuild, normalizeBrainstorm, normalizeDiscover, withFirstStep, fileShape, buildChoices, resolveBuildChoice, onlyProviders, preferUsable, startingAt, loadModels, effortOf, modelOf, readFlags, readQuestion, readBrainstorm, readDiscover, withChoice };
