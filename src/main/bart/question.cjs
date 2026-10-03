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
 * The steps a question without flags climbs: the ladder, or, when the person last picked by hand (`start`, 2026-09-29:
 * ./models.cjs startingAt), that pick and then the ladder's steps above it — a later model, or the same one at a higher effort.
 */
function ladderOf(entry) {
  const start = entry.start;
  if (!start || !entry.models[start.model] || !entry.efforts.includes(start.effort)) return entry.ladder;
  const order = Object.keys(entry.models);
  const above = (rung) => order.indexOf(rung.model) > order.indexOf(start.model) || (rung.model === start.model && EFFORTS.indexOf(rung.effort) > EFFORTS.indexOf(start.effort));
  return [start, ...entry.ladder.filter(above)];
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
  if (!pinned) return { question: rest, provider, steps: ladderOf(entry).map(step), pinned };
  // One of the two by hand: the other comes from the step that already pairs with it, the one it would start on first.
  const rungs = [...ladderOf(entry), ...entry.ladder];
  const rung = chosen
    ? { model: chosen.model, effort: effort || (rungs.find((candidate) => candidate.model === chosen.model) || { effort: 'medium' }).effort }
    : { model: (rungs.find((candidate) => candidate.effort === effort) || rungs[0]).model, effort };
  return { question: rest, provider, steps: [step(rung)], pinned };
}

// How far @discover traces: `--quick`, `--standard` or `--deep`, anywhere on the line (they name no model, so readFlags
// leaves them). Each is a level of the models file's `discover` block (./models.cjs DEFAULT_DISCOVER).
const MODE_RE = /(^|\s)--(quick|standard|deep)(?=\s|$)/gi;
const MODES = ['quick', 'standard', 'deep'];

/** The mode an @discover line names, the last when it names two, else null; and the line without it. → { mode, rest } */
function readMode(text) {
  let mode = null;
  const rest = String(text || '').replace(MODE_RE, (all, lead, word) => { mode = word.toLowerCase(); return lead; }).replace(/\s+/g, ' ').trim();
  return { mode, rest };
}

/**
 * The text after "@discover" (2026-09-30; three levels 2026-10-02) → what readQuestion gives, on one step, and `mode`: the
 * one the line names, else the last one an earlier turn of the exchange named (`earlier`, its turns { question }: an
 * answer to a card, or a follow-up, carries on as deep as the problem was asked), else 'standard'. The step is that mode's
 * level in the models file's `discover` block, on the provider an @bart question would start on, else that provider's first
 * step. No ladder, so nothing to move up to. A model or effort flag still picks by hand, for that line only.
 */
function readDiscover(text, models, earlier = []) {
  const { mode: named, rest } = readMode(text);
  const carried = [...(Array.isArray(earlier) ? earlier : [])].reverse().map((turn) => readMode(turn && turn.question).mode).find(Boolean);
  const mode = named || carried || 'standard';
  const read = readQuestion(rest, models);
  if (read.pinned) return { ...read, mode };
  const provider = read.provider, entry = models.providers[provider];
  const levels = models.discover && models.discover.providers ? models.discover.providers[provider] : null;
  const held = levels ? levels[mode] : null;
  const rung = held && entry.models[held.model] && entry.efforts.includes(held.effort) ? held : entry.ladder[0];
  return { question: read.question, provider, steps: [{ provider, key: rung.model, model: entry.models[rung.model].id, name: entry.models[rung.model].name, effort: rung.effort }], pinned: false, mode };
}

// A full Build of what follows (2026-10-02): `--build` anywhere on an @bart line, in any case.
const BUILD_RE = /(^|\s)--build(?=\s|$)/gi;

/**
 * The text after "@bart" → { build, rest }: whether it says --build, and what is left without --build and without the
 * model and effort flags (readFlags; only when `models` is given, as the editor's are not always loaded yet).
 */
function readBuildFlag(text, models = null) {
  let build = false;
  const without = String(text || '').replace(BUILD_RE, (all, lead) => { build = true; return lead; }).replace(/\s+/g, ' ').trim();
  return { build, rest: models ? readFlags(without, models).rest : without };
}

/**
 * What an ask is when it is a Build (Workspace.jsx askBart): { request } (empty when nothing follows the flag), or null
 * for an ask. Only an @bart line builds; on @brainstorm and @discover lines --build is words for that agent.
 */
function buildRequestOf({ agent = 'bart', text }, models = null) {
  if ((agent || 'bart') !== 'bart') return null;
  const { build, rest } = readBuildFlag(text, models);
  return build ? { request: rest } : null;
}

/** The text after "@bart" with its flags replaced by the two that name this model and effort. */
function withChoice(text, models, { model, effort }) {
  const { rest } = readFlags(text, models);
  return [`--${model}`, `--${effort}`, rest].filter(Boolean).join(' ');
}

module.exports = { EFFORTS, EFFORT_LABELS, MODES, effortOf, modelOf, readFlags, ladderOf, readQuestion, readMode, readDiscover, readBuildFlag, buildRequestOf, withChoice };
