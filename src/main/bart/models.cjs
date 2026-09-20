'use strict';

// Which model answers an @bart question, and at what effort (2026-09-19). One file for every
// project, <home>/model-effort-inline-question.json, written with these defaults when it is
// missing and read again for every question, so an edit needs no restart.
//
// A question starts on the first step of the default provider's ladder. The agent may ask to move
// up a step (src/main/bart/ask.cjs), which resumes the same session: what it has read stays read.
// `@bart --opus --high …` picks by hand and turns that off. Flags are matched loosely: case,
// dashes, spaces, dots and version numbers are ignored, and "extra high" is xhigh.

const fs = require('node:fs');
const path = require('node:path');
const { readJson, writeJson } = require('../store/home.cjs');

const MODELS_FILE = 'model-effort-inline-question.json';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const KEY_RE = /^[a-z][a-z0-9]{0,23}$/;

const DEFAULT_MODELS = {
  about: 'Models and efforts for @bart, the inline question agent. This file applies to every project and is read again for each question. A question starts on the first step of the default provider\'s ladder; the agent may move up a step when the question needs more than it was given, and it keeps what it has read. `@bart --opus --high …` picks a model and an effort by hand and turns that off. Luna and Sonnet: lookups, definitions, rewording. Sol and Opus: questions that need several files read or careful reasoning. Astra and Fable: the hardest questions, where a slow answer is acceptable. Medium effort answers in seconds; high and xhigh think longer before answering.',
  provider: 'openai',
  providers: {
    openai: {
      name: 'Codex',
      models: {
        luna: { id: 'gpt-5.6-luna', name: 'Luna', use: 'Fastest. Lookups, definitions, rewording.' },
        sol: { id: 'gpt-5.6-sol', name: 'Sol', use: 'The default. Most questions about the project.' },
        astra: { id: 'gpt-6-astra', name: 'Astra', use: 'Deepest. Hard reasoning across many files; slow.' },
      },
      efforts: ['medium', 'high', 'xhigh'],
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
      efforts: ['medium', 'high', 'xhigh'],
      ladder: [{ model: 'sonnet', effort: 'medium' }, { model: 'opus', effort: 'high' }, { model: 'fable', effort: 'xhigh' }],
    },
  },
};

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/** Whatever the file holds, made safe to run: unknown providers dropped, bad models, efforts and steps replaced by the defaults. */
function normalizeModels(value) {
  const given = isObject(value) ? value : {};
  const providers = {};
  for (const [key, fallback] of Object.entries(DEFAULT_MODELS.providers)) {
    const from = isObject(given.providers) && isObject(given.providers[key]) ? given.providers[key] : {};
    const models = {};
    for (const [name, model] of Object.entries(isObject(from.models) ? from.models : {})) {
      const k = String(name).toLowerCase();
      if (!KEY_RE.test(k) || !isObject(model) || typeof model.id !== 'string' || !MODEL_ID_RE.test(model.id)) continue;
      models[k] = { id: model.id, name: typeof model.name === 'string' && model.name.trim() ? model.name.trim().slice(0, 40) : k[0].toUpperCase() + k.slice(1), use: typeof model.use === 'string' ? model.use.slice(0, 300) : '' };
    }
    const held = Object.keys(models).length ? models : fallback.models;
    const efforts = (Array.isArray(from.efforts) ? from.efforts : []).map(effortOf).filter(Boolean);
    const ladder = (Array.isArray(from.ladder) ? from.ladder : []).map((step) => (isObject(step) ? { model: String(step.model || '').toLowerCase(), effort: effortOf(step.effort) } : null)).filter((step) => step && held[step.model] && step.effort).slice(0, 5);
    providers[key] = {
      name: fallback.name,
      models: held,
      efforts: efforts.length ? [...new Set(efforts)] : fallback.efforts,
      ladder: ladder.length ? ladder : fallback.ladder.filter((step) => held[step.model]).length ? fallback.ladder.filter((step) => held[step.model]) : [{ model: Object.keys(held)[0], effort: 'medium' }],
    };
  }
  return { about: typeof given.about === 'string' ? given.about : DEFAULT_MODELS.about, provider: providers[given.provider] ? given.provider : DEFAULT_MODELS.provider, providers };
}

/** The list in force, writing the defaults the first time so there is a file to edit. */
function loadModels(homeRoot) {
  const file = path.join(homeRoot, MODELS_FILE);
  const held = readJson(file);
  if (!held) { try { if (!fs.existsSync(file)) writeJson(file, DEFAULT_MODELS); } catch { /* read-only home: the defaults still apply */ } }
  return normalizeModels(held || DEFAULT_MODELS);
}

const squash = (word) => String(word == null ? '' : word).toLowerCase().replace(/[\s_.-]+/g, '');
const EFFORT_WORDS = { low: 'low', lo: 'low', medium: 'medium', med: 'medium', mid: 'medium', high: 'high', hi: 'high', xhigh: 'xhigh', extrahigh: 'xhigh', xtrahigh: 'xhigh', exhigh: 'xhigh', veryhigh: 'xhigh', max: 'max', maximum: 'max' };

/** "Extra high", "x-high", " XHIGH " → "xhigh"; null when the word is not an effort. */
function effortOf(word) {
  return EFFORT_WORDS[squash(word)] || null;
}

/** "--Fable", "fable 5.1", "claude-opus-5", "gpt-5.6-sol" → { provider, model }; null when the word names no model in the list. */
function modelOf(word, models) {
  const bare = (value) => squash(value).replace(/\d+/g, '');
  const wanted = bare(word);
  if (!wanted) return null;
  for (const [provider, entry] of Object.entries(models.providers)) {
    for (const [key, model] of Object.entries(entry.models)) {
      if (wanted === key || wanted === bare(model.id) || wanted === bare(model.name) || wanted.replace(/^(claude|gpt|codex)/, '') === key) return { provider, model: key };
    }
  }
  return null;
}

/**
 * The text after "@bart": flags at either end are taken off, the rest is the question. A `--word`
 * that names neither a model nor an effort stays in the question. → { question, provider, steps, pinned }
 * where steps are { provider, key, model (the id the CLI gets), name, effort }, one when pinned.
 */
function readQuestion(text, models) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  let chosen = null;
  let effort = null;
  const take = (from) => {
    for (;;) {
      const at = from === 'start' ? 0 : words.length - 1;
      const word = words[at];
      if (!word || !/^--\S/.test(word)) return;
      const flag = word.slice(2);
      const model = modelOf(flag, models);
      let level = effortOf(flag);
      let used = 1;
      // "--extra high" and "--extra --high": two words, one effort.
      if (!model && !level && squash(flag) === 'extra' && from === 'start' && effortOf((words[1] || '').replace(/^--/, '')) === 'high') { level = 'xhigh'; used = 2; }
      if (!model && !level) return;
      if (model) chosen = model; else effort = level;
      if (from === 'start') words.splice(0, used); else words.splice(at, 1);
    }
  };
  take('start');
  take('end');
  const provider = chosen ? chosen.provider : models.provider;
  const entry = models.providers[provider];
  // An effort the list does not offer becomes the nearest one it does: --max is xhigh, --low is medium.
  if (effort && !entry.efforts.includes(effort)) {
    const rank = (value) => EFFORTS.indexOf(value);
    effort = [...entry.efforts].sort((a, b) => Math.abs(rank(a) - rank(effort)) - Math.abs(rank(b) - rank(effort)))[0];
  }
  const step = (rung) => ({ provider, key: rung.model, model: entry.models[rung.model].id, name: entry.models[rung.model].name, effort: rung.effort });
  const pinned = !!(chosen || effort);
  if (!pinned) return { question: words.join(' '), provider, steps: entry.ladder.map(step), pinned };
  // One of the two by hand: the other comes from the ladder step that already pairs with it.
  const rung = chosen
    ? { model: chosen.model, effort: effort || (entry.ladder.find((candidate) => candidate.model === chosen.model) || { effort: 'medium' }).effort }
    : { model: (entry.ladder.find((candidate) => candidate.effort === effort) || entry.ladder[0]).model, effort };
  return { question: words.join(' '), provider, steps: [step(rung)], pinned };
}

module.exports = { MODELS_FILE, EFFORTS, DEFAULT_MODELS, normalizeModels, loadModels, effortOf, modelOf, readQuestion };
