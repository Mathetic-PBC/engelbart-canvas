// Settings › Intelligence (2026-10-06, MATH-53): what its rows show and what a pick in them saves. Pure: what
// api.settingsModels() gives in (src/main/bart/settings.cjs: { models, choices, usable, offered, cli, fileError }), rows and
// patches out. The provider a row runs on is found as a run finds it (src/main/bart/in-force.cjs).
import { EFFORT_LABELS } from '../../main/bart/question.cjs';
import { onlyProviders, preferUsable, startingAt } from '../../main/bart/in-force.cjs';

// One row per agent. `place`: where its last pick by hand is kept (src/main/bart/choices.cjs); Build's covers a post-it's
// quick task too, which starts on the same default but keeps a pick of its own (`also`).
export const AGENT_ROWS = Object.freeze([
  { id: 'bart', name: '@bart', place: 'bart' },
  { id: 'brainstorm', name: '@brainstorm' },
  { id: 'discover', name: '@discover' },
  { id: 'build', name: 'Build', place: 'build', also: 'quick' },
]);
// @discover's levels under Advanced; `standard` is the row itself.
export const ADVANCED_LEVELS = Object.freeze([{ id: 'quick', name: 'Quick' }, { id: 'deep', name: 'Deep' }]);

/** The providers shown, in the file's order: the ones config.json offers. */
export const shownProviders = (settings) => Object.keys(settings.models.providers).filter((id) => settings.offered.includes(id));

/**
 * The list a run starts on, as src/main/bart/settings.cjs modelsInForce makes it: cut to the providers offered, from
 * `place`'s last pick by hand when one is named, on a provider whose CLI can run.
 */
function inForce(settings, place = null) {
  const offered = onlyProviders(settings.models, settings.offered);
  return preferUsable(place ? startingAt(offered, place, settings.choices && settings.choices[place]) : offered, settings.usable);
}

/** The saved default provider of @bart (`which` 'bart') or of Build ('build'). */
export const savedProvider = (settings, which) => (which === 'build' ? settings.models.build.provider : settings.models.provider);

/**
 * The default provider of @bart (`which` 'bart') or of Build ('build') as a run sees it: one config.json does not offer
 * gives way to the first it does, and one whose CLI cannot run to one whose CLI can (preferUsable).
 */
export function defaultProvider(settings, which) {
  const models = inForce(settings);
  return which === 'build' ? models.build.provider : models.provider;
}

/** `agent`'s default on `provider` → { model, effort }; `level` is @discover's ('standard' unless named). */
export function defaultStep(models, agent, provider, level = 'standard') {
  if (agent === 'bart') return models.providers[provider].ladder[0];
  if (agent === 'brainstorm') return models.brainstorm.providers[provider];
  if (agent === 'discover') return models.discover.providers[provider][level];
  return models.build.providers[provider].default;
}

/** What a cell's ModelGrid lists: that provider alone, with @bart's models and efforts (Build's for Build) and the ladder that pairs a model with an effort. */
export function cellModels(models, agent, provider) {
  const entry = models.providers[provider];
  const build = agent === 'build' ? models.build.providers[provider] : null;
  const list = build ? { models: build.models, efforts: build.efforts, ladder: [build.default] } : { models: entry.models, efforts: entry.efforts, ladder: entry.ladder };
  return { provider, providers: { [provider]: { name: entry.name, ...list } } };
}

/** What a pick in a cell saves (api.saveSettingsModels). */
export function patchOf(agent, provider, { model, effort }, level = 'standard') {
  if (agent === 'discover') return { discover: { [provider]: { [level]: { model, effort } } } };
  return { [agent]: { [provider]: { model, effort } } };
}

/** "Opus Extra high": a step as a chip reads, on its provider's list (`list`: { models }). */
export function stepLabel(list, step) {
  const model = list && step && list.models[step.model];
  return model ? `${model.name} ${EFFORT_LABELS[step.effort] || step.effort}` : '';
}

/**
 * The pick by hand `place` starts on instead of its default, or null: none kept, one a run would pass over (a provider not
 * offered or whose CLI cannot run, a model or effort no longer listed), or the default itself. → { provider, model, effort, label }
 */
export function lastPick(settings, place) {
  const held = settings.choices && settings.choices[place];
  if (!held || !settings.offered.includes(held.provider)) return null;
  const agent = place === 'bart' ? 'bart' : 'build';
  const models = settings.models;
  const list = agent === 'bart' ? models.providers[held.provider] : models.build.providers[held.provider];
  if (!list || !list.models[held.model] || !list.efforts.includes(held.effort)) return null;
  const run = inForce(settings, place);
  if ((agent === 'bart' ? run.provider : run.build.provider) !== held.provider) return null;
  const provider = defaultProvider(settings, agent), step = defaultStep(models, agent, provider);
  if (held.provider === provider && held.model === step.model && held.effort === step.effort) return null;
  return { provider: held.provider, model: held.model, effort: held.effort, label: stepLabel(list, held) };
}

/**
 * The provider @brainstorm and @discover run on instead of @bart's default one, or null. Neither keeps a pick of its own:
 * each runs on the provider an @bart question would start on, so @bart's last pick by hand on the other provider moves
 * them there, at that provider's default for them (the row's cell in that column). → { provider, label } ("Codex")
 */
export function followedPick(settings) {
  const home = defaultProvider(settings, 'bart'), provider = inForce(settings, 'bart').provider;
  return provider === home ? null : { provider, label: settings.models.providers[provider].name };
}
