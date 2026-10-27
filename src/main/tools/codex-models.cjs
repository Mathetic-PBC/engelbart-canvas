'use strict';

// Which Codex model a run sends (MATH-159, 2026-10-26). The models file names fixed ids (../bart/models.cjs: Luna
// gpt-6-luna, Sol gpt-6.1-sol, Astra gpt-6-astra), but which ones Codex accepts depends on the person's ChatGPT plan and
// on their Codex version: on an account without one, every run on it failed with turn.failed, code model_not_found.
// Codex keeps the models it was offered in models_cache.json in its home (CODEX_HOME, else ~/.codex):
// { fetched_at, client_version, models: [{ slug, visibility, ... }] }, and the list differs by Codex version.
//
// codexModel picks from that list as onboarding first did (../connect/agents.cjs, 2026-10-15): the model itself when it
// is listed, else the first listed model of its family (-sol, -luna, -astra), else the first listed model. A run of
// Engelbart's (@bart, Build, a title, a route, a summary) trusts the list only when it was written by the Codex that runs
// now (`version`, what `codex --version` printed, as ./manager.cjs records it); with no cache, or one from another
// version, the model goes as it is. Onboarding's own calls skip that check (`anyVersion`), as they always did.
//
// codexRun runs once more, on the pick read again from the cache the failed run just refreshed, when Codex refused the
// model (model_not_found); only for that, only once, and not when the pick is the model that just failed.
// codexMenu is the pickers' list: each Codex model stands for its family, shown as the listed member, and a family the
// list has none of is hidden. Read only; the models file is never written.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseVersion, isVersion } = require('./version.cjs');

const SLUG = /^[\w.-]{1,80}$/;
const CACHE_FILE = 'models_cache.json';

/** The person's own Codex home: CODEX_HOME, else ~/.codex. */
function personalCodexHome(environment = process.env) {
  return environment.CODEX_HOME || path.join(environment.HOME || os.homedir(), '.codex');
}

/** 'x.y.z' from a version as Codex or the tool check writes it ('0.159.3', 'codex-cli 0.159.3'), or null. */
function versionOf(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return isVersion(value.trim()) ? value.trim() : parseVersion(value, 'codex');
}

/** The version of the Codex Engelbart runs, as the tool check found it (`tools`, ./manager.cjs), or null. */
function runningCodexVersion(tools) {
  try {
    const record = tools && typeof tools.snapshot === 'function' ? (tools.snapshot().tools || {}).codex : null;
    return record ? versionOf(record.version) : null;
  } catch { return null; }
}

/** `home`'s cache → { version, listed } (listed: the slugs with visibility 'list'), or null when there is none or it cannot be read. */
function readCache(home) {
  if (!home) return null;
  try {
    const cache = JSON.parse(fs.readFileSync(path.join(home, CACHE_FILE), 'utf8'));
    const models = Array.isArray(cache && cache.models) ? cache.models : [];
    return {
      version: versionOf(cache && cache.client_version),
      listed: models.filter((one) => one && one.visibility === 'list' && typeof one.slug === 'string' && SLUG.test(one.slug)).map((one) => one.slug),
    };
  } catch { return null; }
}

/**
 * The listed slugs of `home`'s cache, or null when it says nothing to go by: no cache, nothing listed, or (unless
 * `anyVersion`) a cache written by another Codex than `version`, or no version to compare with.
 */
function listedModels(home, { version = null, anyVersion = false } = {}) {
  const cache = readCache(home);
  if (!cache || !cache.listed.length) return null;
  if (!anyVersion && (!versionOf(version) || cache.version !== versionOf(version))) return null;
  return cache.listed;
}

/** listedModels of the first of `homes` whose cache says something to go by, or null. */
function listedIn(homes, options = {}) {
  for (const home of homes) { const listed = listedModels(home, options); if (listed) return listed; }
  return null;
}

const familyOf = (model) => (/-([a-z]+)$/.exec(String(model || '')) || [])[1] || null;

/** The listed member of `model`'s family: `model` when it is listed, else the first listed of its family, else null. */
function familyMember(model, listed) {
  if (listed.includes(model)) return model;
  const family = familyOf(model);
  return (family && listed.find((slug) => slug.endsWith(`-${family}`))) || null;
}

/**
 * The model to send for `model`, by `home`'s cache: `model` when it is listed, else the first listed model of its family,
 * else the first listed model; `model` unchanged when the cache says nothing to go by (listedModels).
 */
function codexModel(model, home, options = {}) {
  const listed = listedModels(home, options);
  if (!listed) return model;
  return familyMember(model, listed) || listed[0];
}

/** Whether Codex's --json output says it refused the model (turn.failed or error, code model_not_found). */
function modelNotFound(stdout) {
  return String(stdout || '').split(/\r?\n/).some((line) => /"type":"(?:error|turn\.failed)"|^ERROR/.test(line) && /model_not_found|model is not supported when using Codex/.test(line));
}

/**
 * One Codex run on the model to send for `model`, and once more on the pick read again when Codex refused it.
 * `attempt(id)` runs Codex with `-m id` and resolves to { stdout, ... } (never rejects for a failed run); `ok(out)` says
 * whether it succeeded. → { ...the last attempt's result, ran: the id it ran on }.
 */
async function codexRun({ model, home, version = null, attempt, ok }) {
  const first = codexModel(model, home, { version });
  const out = await attempt(first);
  if (ok(out) || !modelNotFound(out && out.stdout)) return { ...out, ran: first };
  const next = codexModel(model, home, { version });
  if (next === first) return { ...out, ran: first };
  return { ...(await attempt(next)), ran: next };
}

/** "Sol (ran as gpt-6-sol)" when a run used another model than the one picked; the name alone otherwise. */
function ranAs(name, picked, ran) {
  return ran && picked && ran !== picked ? `${name} (ran as ${ran})` : name;
}

/**
 * `models` (the list in force, ../bart/settings.cjs modelsInForce) as the pickers show it, by `listed` (listedModels):
 * each Codex model as the listed member of its family, a family the list has none of left out, and a step that named a
 * model left out moved to the nearest one kept below it (else the first kept). Unchanged when `listed` is null or would
 * leave nothing to pick. A new object; `models` is not touched.
 */
function codexMenu(models, listed, provider = 'openai') {
  if (!listed || !models || !models.providers || !models.providers[provider]) return models;
  const narrow = (entry) => {
    if (!entry || !entry.models) return null;
    const keys = Object.keys(entry.models), kept = {};
    for (const key of keys) {
      const id = familyMember(entry.models[key].id, listed);
      if (id) kept[key] = { ...entry.models[key], id };
    }
    if (!Object.keys(kept).length) return null;
    const keep = (step) => {
      if (!step || typeof step !== 'object' || kept[step.model]) return step;
      const below = keys.slice(0, Math.max(0, keys.indexOf(step.model))).reverse().find((key) => kept[key]);
      return { ...step, model: below || Object.keys(kept)[0] };
    };
    const out = { ...entry, models: kept };
    for (const field of ['ladder']) if (Array.isArray(entry[field])) out[field] = entry[field].map(keep);
    for (const field of ['start', 'default']) if (entry[field]) out[field] = keep(entry[field]);
    return { out, keep };
  };
  const bart = narrow(models.providers[provider]);
  const next = { ...models };
  if (bart) {
    next.providers = { ...models.providers, [provider]: bart.out };
    if (models.brainstorm && models.brainstorm.providers && models.brainstorm.providers[provider]) {
      next.brainstorm = { ...models.brainstorm, providers: { ...models.brainstorm.providers, [provider]: bart.keep(models.brainstorm.providers[provider]) } };
    }
    const levels = models.discover && models.discover.providers && models.discover.providers[provider];
    if (levels) next.discover = { ...models.discover, providers: { ...models.discover.providers, [provider]: Object.fromEntries(Object.entries(levels).map(([mode, step]) => [mode, bart.keep(step)])) } };
  }
  const build = models.build && models.build.providers ? narrow(models.build.providers[provider]) : null;
  if (build) next.build = { ...models.build, providers: { ...models.build.providers, [provider]: build.out } };
  return next;
}

module.exports = { CACHE_FILE, personalCodexHome, versionOf, runningCodexVersion, readCache, listedModels, listedIn, familyOf, codexModel, modelNotFound, codexRun, ranAs, codexMenu };
