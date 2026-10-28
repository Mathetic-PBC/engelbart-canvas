// The Build default (MATH-162, 2026-10-27): the model and effort a Build starts on when nothing names one, which every
// place that offers it shares, so a pick in one shows in all. BuildPanel's selector, the model on every Build card and
// the chip of an unanswered `@bart --build` line read it here; a pick saves it as Build's last pick by hand (main
// rememberModelChoice('build')), the default the next Build starts on (main resolveBuildChoice), and is drawn at once.
// It never changes a Build already made. Read from the bridge lazily, as the editor is also drawn where there is none.

let models = null;
let loading = null;
let heard = false;
const listeners = new Set();

const bridge = () => (typeof window !== 'undefined' && window.engelbartAPI) || null;
const tell = () => { for (const listener of [...listeners]) listener(models); };

/** The provider offering `model`, or the default provider (BuildPanel's providerOf). */
export const providerOf = (value, model) => Object.keys(value.providers).find((id) => value.providers[id].models[model]) || value.provider;

/** {provider, model, effort} a Build starts on with `value`, the list main's buildChoices gives; null while it loads. */
export function buildDefaultOf(value) {
  const entry = value && value.providers && value.providers[value.provider];
  const first = entry && entry.ladder && entry.ladder[0];
  return first ? { provider: value.provider, model: first.model, effort: first.effort } : null;
}

/** The list as it was last read (or set), or null. */
export const buildModelsNow = () => models;

/** Sets the list and redraws whatever shows it; for a fresh read, and for tests with no bridge. */
export function setBuildModels(value) {
  models = value || null;
  tell();
}

/** Reads the list from main (once, unless `fresh`); resolves to it, or to null where there is no bridge. */
export function loadBuildModels({ fresh = false } = {}) {
  const api = bridge();
  if (!api || !api.buildModels) return Promise.resolve(models);
  if (!heard && api.onModelsChanged) { heard = true; api.onModelsChanged(() => { loadBuildModels({ fresh: true }); }); } // Settings changed a default
  if (models && !fresh) return Promise.resolve(models);
  if (loading && !fresh) return loading;
  const read = api.buildModels('build').then((value) => { if (loading === read) loading = null; setBuildModels(value); return value; }, () => { if (loading === read) loading = null; return models; });
  loading = read;
  return read;
}

/** Hears every change to the list; returns the call that stops it. */
export function onBuildModels(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** `pick` ({model, effort}, provider optional) made the default: drawn at once, saved, then read again from main. */
export function pickBuildModel(pick) {
  if (!models || !pick || !pick.model) return Promise.resolve(null);
  const provider = pick.provider && models.providers[pick.provider] && models.providers[pick.provider].models[pick.model] ? pick.provider : providerOf(models, pick.model);
  const choice = { provider, model: pick.model, effort: pick.effort };
  const entry = models.providers[provider];
  setBuildModels({ ...models, provider, providers: { ...models.providers, [provider]: { ...entry, ladder: [{ model: choice.model, effort: choice.effort }] } } });
  const api = bridge();
  if (!api || !api.rememberModelChoice) return Promise.resolve(choice);
  return api.rememberModelChoice('build', choice).then(() => loadBuildModels({ fresh: true }), () => null).then(() => choice);
}
