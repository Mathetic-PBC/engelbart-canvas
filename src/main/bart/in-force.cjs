'use strict';

// The list a run starts on, made from the models file (./models.cjs loadModels): cut to the providers config.json offers
// (onlyProviders), moved to the last pick by hand (startingAt) and to a provider whose CLI can run (preferUsable). Pure, and
// in a file of its own (2026-10-06) so Settings › Intelligence (src/renderer/model/intelligence.js) shows the provider a
// run uses by the same rules a run does. ./models.cjs exports these too.

const { TOOL_OF } = require('../tools/requirements.cjs');

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

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

module.exports = { onlyProviders, preferUsable, startingAt };
