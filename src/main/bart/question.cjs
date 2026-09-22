'use strict';

// Reading an @bart line (2026-09-20, taken out of ./models.cjs): which words are flags, which
// model and effort they pick, what is left as the question. Nothing here touches the disk, so
// the editor bundles this same file: a flag it shows as recognised is one the run will obey.

// In rising order. Both CLIs were checked for the words they take (2026-09-21): Claude Code 2.1.278 `--effort` lists low to
// max; codex-cli 0.155.1 knows none, minimal, low, medium, high, xhigh, max and ultra for `model_reasoning_effort`.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

const squash = (word) => String(word == null ? '' : word).toLowerCase().replace(/[\s_.-]+/g, '');
const EFFORT_WORDS = { low: 'low', lo: 'low', medium: 'medium', med: 'medium', mid: 'medium', high: 'high', hi: 'high', xhigh: 'xhigh', extrahigh: 'xhigh', xtrahigh: 'xhigh', exhigh: 'xhigh', veryhigh: 'xhigh', max: 'max', maximum: 'max', ultra: 'ultra' };

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
 * The flags of the text after "@bart", taken from either end; a `--word` that names neither a
 * model nor an effort is not one and ends the taking. → { chosen, effort, spans, rest } where
 * spans are the [start, end) of each flag in `text` and rest is the text without them.
 */
function readFlags(text, models) {
  const source = String(text || '');
  const words = [...source.matchAll(/\S+/g)].map((match) => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
  let chosen = null;
  let effort = null;
  const spans = [];
  const take = (from) => {
    for (;;) {
      const at = from === 'start' ? 0 : words.length - 1;
      const held = words[at];
      if (!held || !/^--\S/.test(held.word)) return;
      const flag = held.word.slice(2);
      const model = modelOf(flag, models);
      let level = effortOf(flag);
      let used = 1;
      // "--extra high" and "--extra --high": two words, one effort.
      if (!model && !level && squash(flag) === 'extra' && from === 'start' && words[1] && effortOf(words[1].word.replace(/^--/, '')) === 'high') { level = 'xhigh'; used = 2; }
      if (!model && !level) return;
      if (model) chosen = model; else effort = level;
      for (const taken of words.splice(from === 'start' ? 0 : at, used)) spans.push([taken.start, taken.end]);
    }
  };
  take('start');
  take('end');
  spans.sort((a, b) => a[0] - b[0]);
  return { chosen, effort, spans, rest: words.map((held) => held.word).join(' ') };
}

/**
 * The text after "@bart" → { question, provider, steps, pinned } where steps are
 * { provider, key, model (the id the CLI gets), name, effort }, one when pinned.
 */
function readQuestion(text, models) {
  const { chosen, effort: asked, rest } = readFlags(text, models);
  let effort = asked;
  const provider = chosen ? chosen.provider : models.provider;
  const entry = models.providers[provider];
  // An effort the list does not offer becomes the nearest one it does, the higher of two equally near: --low is medium,
  // and --max asked of Codex (medium to xhigh, then ultra) is ultra.
  if (effort && !entry.efforts.includes(effort)) {
    const rank = (value) => EFFORTS.indexOf(value);
    effort = [...entry.efforts].sort((a, b) => (Math.abs(rank(a) - rank(effort)) - Math.abs(rank(b) - rank(effort))) || rank(b) - rank(a))[0];
  }
  const step = (rung) => ({ provider, key: rung.model, model: entry.models[rung.model].id, name: entry.models[rung.model].name, effort: rung.effort });
  const pinned = !!(chosen || effort);
  if (!pinned) return { question: rest, provider, steps: entry.ladder.map(step), pinned };
  // One of the two by hand: the other comes from the ladder step that already pairs with it.
  const rung = chosen
    ? { model: chosen.model, effort: effort || (entry.ladder.find((candidate) => candidate.model === chosen.model) || { effort: 'medium' }).effort }
    : { model: (entry.ladder.find((candidate) => candidate.effort === effort) || entry.ladder[0]).model, effort };
  return { question: rest, provider, steps: [step(rung)], pinned };
}

/** The text after "@bart" with its flags replaced by the two that name this model and effort. */
function withChoice(text, models, { model, effort }) {
  const { rest } = readFlags(text, models);
  return [`--${model}`, `--${effort}`, rest].filter(Boolean).join(' ');
}

module.exports = { EFFORTS, EFFORT_LABELS, effortOf, modelOf, readFlags, readQuestion, withChoice };
