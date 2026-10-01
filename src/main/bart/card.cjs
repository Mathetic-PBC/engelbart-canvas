'use strict';

// @brainstorm's cards (2026-09-30): what the agent replies with, how a card is kept in the document, and how the
// person's answer is written back. Nothing here touches the disk, so the editor bundles this same file (as it does
// ./question.cjs): a card it draws is one main would have written, and an answer it writes is one main reads.
//
// The agent replies with one JSON object (./brainstorm-system-prompt.cjs):
//   { say, card: 'questions' | 'focus' | 'none', map?, questions | focus, ready }
// `map` (2026-09-30, the first card of an exchange): where the person seems to be, read from what they wrote, as three
// groups of { text, from }: settled, open, untouched. All three empty says there was too little to go on.
// A card is kept as the lines of a fenced ```json block (./reply.cjs puts `bart> ` in front of each); the recap
// (card 'none') as its text. A reply that is not a card is kept as it came, and reads as an @bart answer does.
// The person's answer is the next line of the document:
//   @brainstorm picked "label"                 one choice (mcq, focus)
//   @brainstorm picked "a", "b"                several (select_all)
//   @brainstorm the words they typed           free and open, or a sentence typed by hand
//   @brainstorm picked "a"; note: …            with something added
//   @brainstorm (skipped)                      Skip

const TYPES = ['mcq', 'select_all', 'free', 'open'];
const MAX_OPTIONS = 6;
const MAP_GROUPS = ['settled', 'open', 'untouched'];
const MAX_MAP_ITEMS = 4;
const SKIPPED = '(skipped)';
// What an @brainstorm line with nothing after it asks (BS-01).
const OPENING = 'Start from this workspace.';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** One line of text: spaces run together, cut to `max`. */
const clip = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Text that may keep its lines (the recap is three). */
const clipText = (value, max) => (typeof value === 'string' ? value.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max) : '');

/** The model's text as JSON: bare, in a code fence, or with words around it. null when there is none. */
function parseJson(text) {
  const raw = String(text == null ? '' : text).trim();
  const fenced = raw.match(/^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/i);
  const body = fenced ? fenced[1] : raw;
  try { return JSON.parse(body); } catch { /* words around it, perhaps */ }
  const from = body.indexOf('{'), to = body.lastIndexOf('}');
  if (from >= 0 && to > from) { try { return JSON.parse(body.slice(from, to + 1)); } catch { /* not JSON */ } }
  return null;
}

// An answer names its options by label inside double quotes, so a label never holds one.
function cleanOptions(list) {
  const out = [];
  for (const option of Array.isArray(list) ? list : []) {
    const given = typeof option === 'string' ? { label: option } : isObject(option) ? option : null;
    const label = given ? clip(given.label, 200).replace(/"/g, '\'') : '';
    if (!label || out.some((held) => held.label.toLowerCase() === label.toLowerCase())) continue;
    const why = clip(given.why, 300);
    out.push(why ? { label, why } : { label });
    if (out.length === MAX_OPTIONS) break;
  }
  return out;
}

/**
 * The map as it may be kept → { settled, open, untouched }, each at most four { text, from } (an item without text is
 * dropped; `from` may be empty). null when `map` is not an object: the card is kept without it.
 */
function cleanMap(map) {
  if (!isObject(map)) return null;
  const out = {};
  for (const group of MAP_GROUPS) {
    out[group] = [];
    for (const item of Array.isArray(map[group]) ? map[group] : []) {
      const given = typeof item === 'string' ? { text: item } : isObject(item) ? item : null;
      const text = given ? clip(given.text, 200) : '';
      if (!text) continue;
      out[group].push({ text, from: clip(given.from, 160) });
      if (out[group].length === MAX_MAP_ITEMS) break;
    }
  }
  return out;
}

/** Whether a map says anything (all three groups empty: there was too little to go on). */
const mapHolds = (map) => !!map && MAP_GROUPS.some((group) => map[group].length > 0);

/**
 * A reply (the model's text, or a value already parsed) as a card fit to draw, or null when it is not one. `ready`
 * ends the exchange whatever card it names: the recap is `say`, and a recap without words is not one.
 */
function readCard(text) {
  const value = typeof text === 'string' ? parseJson(text) : text;
  if (!isObject(value)) return null;
  const say = clipText(value.say, 1500);
  const kind = String(value.card || '').toLowerCase();
  if (kind === 'none' || value.ready === true) return say ? { say, card: 'none', ready: true } : null;
  const map = cleanMap(value.map);
  const mapped = map ? { map } : {};
  if (kind === 'focus') {
    const focus = isObject(value.focus) ? value.focus : {};
    const options = cleanOptions(focus.options);
    if (options.length < 2) return null;
    return { say, card: 'focus', ...mapped, focus: { title: clip(focus.title, 300) || 'What should we focus on?', options }, ready: false };
  }
  if (kind === 'questions') {
    const questions = isObject(value.questions) ? value.questions : {};
    const item = (Array.isArray(questions.items) ? questions.items : []).find(isObject); // one question per card
    const type = item && TYPES.includes(item.type) ? item.type : null;
    const title = item ? clip(item.title, 300) : '';
    if (!type || !title) return null;
    const out = { id: clip(item.id, 40) || 'q', type, title };
    const subtitle = clip(item.subtitle, 300);
    if (subtitle) out.subtitle = subtitle;
    if (type === 'mcq' || type === 'select_all') {
      out.options = cleanOptions(item.options);
      if (out.options.length < 2) return null;
    } else {
      const placeholder = clip(item.placeholder, 120);
      if (placeholder) out.placeholder = placeholder;
    }
    const eyebrow = clip(questions.eyebrow, 60);
    return { say, card: 'questions', ...mapped, questions: { ...(eyebrow ? { eyebrow } : {}), items: [out] }, ready: false };
  }
  return null;
}

/** The reply as the document keeps it → { body, card }: a card as its JSON in a fence, the recap as its words, anything else as it came. */
function cardBody(text) {
  const card = readCard(text);
  if (!card) return { body: String(text == null ? '' : text), card: null };
  if (card.card === 'none') return { body: card.say, card };
  return { body: ['```json', JSON.stringify(card, null, 2), '```'].join('\n'), card };
}

/** An answer as the document holds it (the body of a turn, doc.js turnText) → the card it is, or null. Only a card that asks something. */
function cardOfAnswer(answer) {
  const m = String(answer == null ? '' : answer).trim().match(/^```json[ \t]*\n([\s\S]*)\n```$/);
  if (!m) return null;
  let value;
  try { value = JSON.parse(m[1]); } catch { return null; }
  const card = readCard(value);
  return card && card.card !== 'none' ? card : null;
}

/** What the card asks, whatever its kind → { type, title, subtitle, options, placeholder, eyebrow }. A focus card is one choice. */
function questionOf(card) {
  if (!card) return null;
  if (card.card === 'focus') return { type: 'focus', title: card.focus.title, options: card.focus.options, eyebrow: 'focus' };
  const item = card.questions.items[0];
  return { ...item, options: item.options || [], eyebrow: card.questions.eyebrow || '' };
}

const isChoice = (type) => type === 'mcq' || type === 'select_all' || type === 'focus';

/**
 * The answer as the words after "@brainstorm" (BS-06). `given` { picks: [labels], text, note }: the picks for a choice,
 * the text for free and open. On a choice card the field under the options is a note to a pick, or, with nothing picked,
 * the answer in the person's own words (2026-09-30): written as they are, with no `picked` and no `; note:`, which
 * readAnswer reads back as text. Nothing given is Skip.
 */
function answerLine(card, given = {}) {
  const asked = questionOf(card);
  const one = (value) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  const labels = asked ? asked.options.map((option) => option.label) : [];
  const picks = (Array.isArray(given.picks) ? given.picks : []).filter((label) => labels.includes(label));
  const note = one(given.note);
  if (asked && isChoice(asked.type) && !picks.length) return note || SKIPPED;
  const said = asked && isChoice(asked.type) ? `picked ${picks.map((label) => `"${label}"`).join(', ')}` : one(given.text);
  if (!said) return SKIPPED;
  return note ? `${said}; note: ${note}` : said;
}

/** The words after "@brainstorm" (flags already taken off) read back against the card they answer → { skipped, picks, text, note }. */
function readAnswer(text, card) {
  const said = String(text == null ? '' : text).trim();
  if (!said || said === SKIPPED) return { skipped: true, picks: [], text: '', note: '' };
  const m = said.match(/^picked\s+((?:"[^"]*"\s*,\s*)*"[^"]*")\s*(?:;\s*note:\s*([\s\S]*))?$/i);
  if (m) return { skipped: false, picks: [...m[1].matchAll(/"([^"]*)"/g)].map((pick) => pick[1]), text: '', note: (m[2] || '').trim() };
  // Typed by hand: a sentence stands as what was said; one that is an option's label word for word is that pick.
  const asked = questionOf(card);
  const same = asked && isChoice(asked.type) ? asked.options.find((option) => option.label.toLowerCase() === said.toLowerCase()) : null;
  return same ? { skipped: false, picks: [same.label], text: '', note: '' } : { skipped: false, picks: [], text: said, note: '' };
}

const bare = (question) => String(question == null ? '' : question).replace(/^(?:--\S+\s*)+|(?:\s*--\S+)+$/g, '').trim();

/**
 * How many meaningful answers the person has given since the exchange last ended (a recap, or a reply that was not a
 * card), `question` (the one being asked now) included: an answer to a card that is not Skip. `turns`: the earlier
 * turns { question, answer }, oldest first; turn n + 1's question answers turn n's card.
 */
function answersSoFar(turns, question) {
  const said = [...turns.map((turn) => turn.question), question];
  let count = 0;
  for (let n = turns.length - 1; n >= 0; n -= 1) {
    if (!cardOfAnswer(turns[n].answer)) break;
    const answer = bare(said[n + 1]);
    if (answer && answer !== SKIPPED) count += 1;
  }
  return count;
}

const LOOK_FOR_RE = /^\s*look for:\s*(?:@discover\b\s*)?(.*)$/i;
const MAX_LOOK_FOR = 2, LOOK_FOR_CHARS = 140;

/**
 * A recap (the text of a brainstorm reply that is not a card) → { lines, lookFor } (2026-09-30, round 4): its lines
 * other than the "Look for:" ones, and the searches those name, at most two of at most 140 characters, a leading
 * "@discover" taken off. An older recap has no Look for lines and comes back whole.
 */
function recapParts(text) {
  const lines = [], lookFor = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const m = line.match(LOOK_FOR_RE);
    if (!m) { lines.push(line); continue; }
    const query = m[1].replace(/\s+/g, ' ').trim().slice(0, LOOK_FOR_CHARS).trim();
    if (query && lookFor.length < MAX_LOOK_FOR && !lookFor.includes(query)) lookFor.push(query);
  }
  return { lines, lookFor };
}

// The labels a recap's lines start with: round 4's, and the ones older recaps used, which still draw the same way.
const RECAP_LABELS = ['Where you are', 'What pulls apart', 'What\'s unclear', 'Next, you said', 'Where you\'ll look next'];
const RECAP_LINE_RE = new RegExp(`^\\s*(${RECAP_LABELS.map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*[:：]\\s*(.*)$`, 'i');

/** One line of a recap → { label, text } when it starts with a recap label (as written in the file), else null. */
function recapLine(line) {
  const m = String(line == null ? '' : line).replace(/[’]/g, '\'').match(RECAP_LINE_RE);
  if (!m) return null;
  const label = RECAP_LABELS.find((known) => known.toLowerCase() === m[1].toLowerCase());
  return { label, text: m[2].trim() };
}

module.exports = { recapParts, recapLine, RECAP_LABELS, TYPES, SKIPPED, OPENING, MAP_GROUPS, parseJson, cleanMap, mapHolds, readCard, cardBody, cardOfAnswer, questionOf, isChoice, answerLine, readAnswer, answersSoFar };
