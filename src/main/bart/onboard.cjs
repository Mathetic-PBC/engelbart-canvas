'use strict';

// Onboarding as brainstorm cards, build 1 (2026-10-07; design/onboarding-brainstorm, screens/Onboarding.jsx): what Bart
// does while a person answers the cards. One session per onboarding (./onboard-session.cjs), on the fastest level Bart
// has (./models.cjs onboardStep), started when onboarding opens, for what the person waits on: the line said back and
// Stuck?. What they do not wait on (the plan) runs in a second one started beside it, so a Stuck? never queues behind a
// plan (checked by hand 2026-10-07: in one session it waited about seven seconds). Per card:
//   - after "What are you working on?" and "Why are you interested in this?": one line said back, streamed ("You're
//     working on …", "Because …"), and 3 to 5 searches for papers on it, in the same reply;
//   - on the way to "Putting it together": their answers joined into one sentence that reads naturally, their own words
//     kept and each marked so the card can underline it (join, on the session they wait on);
//   - on "Putting it together": Stuck? (one research question to settle on), and one call for the project's name, its
//     question and three sub-questions, made while they are on the card, so they are there the moment the project opens.
// Every message carries every answer so far, so a session started again loses nothing.
// Since 2026-10-08 (from a hand test): "What are you least sure about?" is gone and "Why this, and why now?" asks "Why
// are you interested in this?". Putting it together is their answers joined by Bart ("I'm working on predicting student
// behavior because AI is changing how students learn.") and, under it, the question they want to answer, filled with
// Bart's suggestion from the plan; Stuck? suggests another question. The plan is asked again for their question when
// they change it, so the sub-questions are for the question they settle on.
//
// The searches (for build 2's climbs, ./climbs.cjs: the best papers are read as they are found, and the plan's
// sub-questions are climbed the moment it is written, attach binding them to the project) run straight from main against OpenAlex
// (./papers.cjs `search`), with no agent: 3 to 5 after each question card, their papers merged by id and kept
// with the project, <project>/.context/start-candidates.json, once it exists; until then here. A search that ends after
// the project opened is written there too. Searches the model did not write are made from their own words (queriesOf).
//
// Nothing here fails a card: a turn that fails is no line, a plan that fails is made from their words (fallbackPlan).

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createWarmSession } = require('./onboard-session.cjs');
const { onboardStep } = require('./models.cjs');
const { createPapers } = require('./papers.cjs');

const { searchFiltered, isLimited } = require('./climbs.cjs');

const CARDS = ['working', 'why', 'together'];
const QUESTIONS = { working: 'What are you working on?', why: 'Why are you interested in this?', question: 'The question they want to answer:' };
// What each reflection finishes, as the card above it shows it.
const LABELS = { working: 'You’re working on', why: 'Because' };
const CANDIDATES_FILE = 'start-candidates.json';
const MAX_QUERIES = 5;
const PER_SEARCH = 8;
const IDLE_MS = 30 * 60_000;
const PLAN_TIMEOUT_MS = 40_000;

const ONBOARD_SYSTEM_PROMPT = `You help a researcher start a project in Engelbart, a research notebook, by saying back what they tell you. They answer two questions, one at a time: what they are working on, and why they are interested in it. Then they settle on the research question they want to answer. Each message gives their answers so far and asks for one thing in an exact format.

Reply in that format only: no preamble, no markdown, no quotation marks, nothing after it.

Keep their words and their terms. Make it shorter and plainer, never grander, and add nothing they did not say. Never praise them and never ask a question back.`;

const clean = (value, max = 2000) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** The answers as the renderer sends them, made safe: strings, bounded; '' for a card skipped or a question not written. */
function cleanAnswers(answers) {
  const given = answers && typeof answers === 'object' ? answers : {};
  return { working: clean(given.working), why: clean(given.why), question: clean(given.question, 600) };
}

function answersBlock(answers) {
  const lines = ['working', 'why', 'question'].filter((key) => answers[key]).map((key) => `${QUESTIONS[key]} ${answers[key]}`);
  return `<answers>\n${lines.join('\n') || '(none yet)'}\n</answers>`;
}

const SEARCH_LINES = 'Then 3 to 5 lines, each "search: " and 2 to 6 words to search a catalogue of research papers with: the topic in the words papers on it would use, each line a different angle.';

/** The message after a card is answered (working, why): a reflection and searches. */
function cardMessage(card, answers) {
  const block = answersBlock(answers);
  if (card === 'working') return `${block}\n\nLine 1: finish the sentence "You're working on …" with what they said they are working on, in under 16 words, keeping their terms. Write only the ending: no "You're working on", no full stop.\n${SEARCH_LINES}`;
  return `${block}\n\nLine 1: finish the sentence "Because …" with why their answer to "${QUESTIONS.why}" says they are interested, in under 16 words, keeping their terms. Write only the ending: no "Because", no full stop.\n${SEARCH_LINES}`;
}

/** Stuck?: one research question they could settle on, not one they have seen (Bart's first suggestion included). */
function stuckMessage(answers, { before = [] } = {}) {
  const working = answers.working || '…', why = answers.why || '…';
  const not = before.length ? `\nNot one of these, which they have seen: ${before.map((one) => `"${clean(one, 300)}"`).join('; ')}.` : '';
  return `${answersBlock(answers)}\n\nThey wrote: "I'm working on ${working} because ${why}." Under it they are choosing the research question they want to answer.\nSuggest one research question they could settle on: one they could answer with their work, in their terms, one sentence under 14 words ending in a question mark. Reply with the question only.${not}`;
}

/** The project's name, its question and three sub-questions, from their sentence and the question they settled on (if any). */
function planMessage(answers, sentence) {
  const asked = answers.question
    ? 'question: their question, exactly as they wrote it (only a capital first and a question mark last if it lacks them)'
    : 'question: a research question for them, one sentence under 14 words ending in a question mark, that their work could answer: from what they are working on and why they are interested in it';
  return `${answersBlock(answers)}\n\nTheir sentence: "${clean(sentence, 1200) || '(not written)'}"\n\nWrite exactly five lines:\nname: a name for the project, 2 to 5 words, title case, from what they are working on\n${asked}\n1. a sub-question\n2. a sub-question\n3. a sub-question\nThe three sub-questions break the research question into places to start, each under 12 words, ending in a question mark. Order them as a story, the way an advisor walks someone in: 1 is about understanding the problem itself (what it is, where it shows up, why it is hard), 2 about how it has been studied (what is already published, the methods and findings), and 3, last, about their own data, study or contribution (what they will collect, build or show).`;
}

const strip = (text) => clean(text).replace(/^["“'‘*_-]+|["”'’*_]+$/g, '').trim();

/** A reflection's line as it is shown, from the reply so far: its first line, without the label it finishes, capitalised. */
function reflectionOf(card, text) {
  const first = String(text || '').split('\n').map(strip).find((line) => line && !/^search:/i.test(line)) || '';
  let line = first;
  if (card === 'working') line = line.replace(/^(you['’]?re|you are)\s+working\s+on\s+/i, '');
  if (card === 'why') line = line.replace(/^(?:because|so\s+that)\s+/i, '');
  line = line.replace(/[.…]+$/, '').trim();
  return line ? line[0].toUpperCase() + line.slice(1) : '';
}

/**
 * Putting it together's sentence: their answers joined so it reads naturally, each part in [[ ]] so the card can
 * underline it and let them edit it.
 */
function joinMessage(answers) {
  const parts = ['working', 'why'].filter((key) => answers[key]);
  const which = parts.map((key) => `"${QUESTIONS[key]}"`).join(', then what comes from ');
  return `${answersBlock(answers)}\n\nJoin ${parts.length > 1 ? 'their answers' : 'their answer'} into one sentence that starts "I'm working on" (or "I'm interested in this" when they did not say what they work on) and reads naturally, like: I'm working on [[predicting student behavior]] because [[AI is changing how students learn]].\nKeep their own words wherever you can. Change only what the sentence needs: grammar, a capital, a lead-in they wrote themselves ("I'm working on", "because", "so that"), how the parts join. Add nothing they did not say.\nPut what comes from ${which} in [[ ]], in that order, each once; everything else outside them. Reply with the sentence only.`;
}

const contentWords = (text) => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word));

/**
 * The joined sentence as the model wrote it → { lead, working, join, why, end } (the parts it marked, the words around
 * them), or null when it is not one: a part missing or extra, a part not mostly their words, words around the parts too
 * long to be only joins. A part they skipped is '' with no `join`.
 */
function readJoin(text, answers) {
  const line = strip(String(text || '').split('\n').map((one) => one.trim()).find(Boolean) || '');
  const wanted = ['working', 'why'].filter((key) => answers[key]);
  const marks = [...line.matchAll(/\[\[(.+?)\]\]/g)];
  if (!wanted.length || marks.length !== wanted.length) return null;
  const pieces = line.split(/\[\[.+?\]\]/);
  if (pieces.some((piece) => /\[\[|\]\]/.test(piece))) return null;
  const out = { lead: pieces[0], working: '', join: '', why: '', end: pieces[pieces.length - 1] };
  if (wanted.length === 2) out.join = pieces[1];
  for (const [i, key] of wanted.entries()) {
    const part = clean(marks[i][1], 600);
    const theirs = new Set(contentWords(answers[key]));
    const words = contentWords(part);
    // Their words, mostly: at least half of the part's words are in their answer.
    if (!part || (words.length && words.filter((word) => theirs.has(word)).length * 2 < words.length)) return null;
    out[key] = part;
  }
  if (out.lead.length > 60 || out.join.length > 40 || out.end.length > 12 || !/^I/.test(out.lead.trim())) return null;
  return out;
}

/** The searches a reply wrote: its "search:" lines, at most five, each a few words. */
function queriesIn(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:[-*\d.)\s]*)search:\s*(.+)$/i);
    const query = m ? strip(m[1]).replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (query && !out.some((one) => one.toLowerCase() === query.toLowerCase())) out.push(query);
  }
  return out.slice(0, MAX_QUERIES);
}

const STOP = new Set('a an and are as at be because been being but by can could do does doing for from how i i\'m im if in into is it its me my of on or our so than that the their them then there these they this those to too was we were what when where whether which while who why will with would you your about am want working work find out least sure now just also more most very really much many some any such not only'.split(' '));

/** Searches made from their own words, when the model wrote none: the content words of an answer, whole and in halves. */
function queriesOf(text) {
  const words = clean(text).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word));
  if (!words.length) return [];
  const out = [words.slice(0, 6).join(' ')];
  if (words.length > 4) out.push(words.slice(0, Math.ceil(words.length / 2)).slice(0, 5).join(' '), words.slice(Math.floor(words.length / 2)).slice(0, 5).join(' '));
  return [...new Set(out)].slice(0, 3);
}

/** A question as a question: a capital first, a question mark last. */
const asQuestion = (text) => { const t = clean(text, 300).replace(/[.!…]+$/, ''); return t ? `${t[0].toUpperCase()}${t.slice(1)}${t.endsWith('?') ? '' : '?'}` : ''; };
const titleCase = (words) => words.map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
const topicOf = (answers) => clean(answers.working || answers.question, 400).replace(/^(i['’]?m|i am)\s+(working on|studying|looking at)\s+/i, '').replace(/[.!?]+$/, '');

/** The plan made from their own words, when the model gave none (or part of one). */
function fallbackPlan(answers) {
  const topic = topicOf(answers);
  const words = clean(topic).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word));
  const name = words.length ? titleCase(words.slice(0, 4)) : 'New project';
  const question = asQuestion(answers.question) || (topic ? `What is known about ${topic}?` : 'What do you want to find out?');
  const about = topic ? clean(topic, 90).replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase()) : 'this';
  // In the order the prompt asks for (planMessage): the problem, how it has been studied, then their own contribution.
  const starts = [`What would count as an answer to your question?`, `What has already been found about ${about}?`, `What will your own data or study show that is new?`];
  return { name, question, starts };
}

/** A plan as the model wrote it → { name, question, starts }; whatever it left out, from fallbackPlan. */
function readPlan(text, answers) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  const field = (key) => { const line = lines.find((one) => new RegExp(`^\\**${key}\\**\\s*:`, 'i').test(one)); return line ? strip(line.replace(/^[^:]*:/, '')) : ''; };
  const starts = lines.map((line) => line.match(/^(?:\d+[.)]|[-*•])\s*(.+)$/)).filter(Boolean).map((m) => asQuestion(strip(m[1]))).filter(Boolean).slice(0, 3);
  const fallback = fallbackPlan(answers);
  const name = field('name').replace(/[.:]+$/, '').slice(0, 80) || fallback.name;
  const question = asQuestion(field('question')) || fallback.question;
  return { name, question, starts: starts.length === 3 ? starts : fallback.starts, fallback: starts.length !== 3 };
}

/** A search's results merged into `papers` (by OpenAlex id), each paper remembering the searches and cards that found it. */
function mergeCandidates(papers, results, { query, card }) {
  const out = papers.slice();
  for (const one of results || []) {
    if (!one || typeof one.id !== 'string') continue;
    const at = out.findIndex((held) => held.id === one.id);
    if (at < 0) { out.push({ ...one, queries: [query], after: [card] }); continue; }
    const held = out[at];
    out[at] = { ...held, queries: [...new Set([...held.queries, query])], after: [...new Set([...held.after, card])] };
  }
  return out;
}

/** The file build 2 reads: every search that ran and the papers they found. */
function writeCandidates(projectDir, { searches, papers }) {
  const dir = path.join(projectDir, '.context');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CANDIDATES_FILE), temporary = `${file}.${process.pid}.tmp`;
  const value = { about: 'Papers found while the project was started (onboarding, src/main/bart/onboard.cjs): OpenAlex searches made from the answers to its cards, for sorting under the first workspace\'s sub-questions.', searches, papers };
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function readCandidates(projectDir) {
  try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.context', CANDIDATES_FILE), 'utf8')); } catch { return null; }
}

/**
 * `readModels`: @bart's list in force (the provider its question would start on). `makeSession(options)`: a warm session
 * (./onboard-session.cjs; a fake one in tests). `papers`: ./papers.cjs's tools, of which only `search` is used.
 */
function createOnboard({ readModels, makeSession = (options) => createWarmSession(options), papers = createPapers(), climbs = null, sessionOptions = {}, idleMs = IDLE_MS, now = () => new Date().toISOString() } = {}) {
  const held = new Map(); // id → { session, back, searches, papers, projectDir, pending, timer, suggestions, planNext, planning }
  const get = (id) => {
    const entry = typeof id === 'string' ? held.get(id) : null;
    if (!entry) throw new Error('Unknown onboarding');
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => close(id), idleMs);
    if (entry.timer.unref) entry.timer.unref();
    return entry;
  };
  // The session, made on the provider in force; made again when that changed (the tools screen installed the other CLI).
  // A session whose process died starts it again on its next turn (./onboard-session.cjs), so it is kept.
  // `which`: 'session' (what the person waits on) or 'back' (what runs while they read on).
  const sessionOf = (entry, which = 'session') => {
    let step;
    try { step = onboardStep(readModels()); } catch { return entry[which]; }
    const now = entry[which];
    if (now && (now.provider === step.provider || now.provider === 'fake')) return now;
    if (now) { try { now.close(); } catch { /* gone */ } }
    try { entry[which] = makeSession({ step, system: ONBOARD_SYSTEM_PROMPT, ...sessionOptions }); } catch { entry[which] = null; }
    return entry[which];
  };
  const keep = (entry) => { if (entry.projectDir) { try { writeCandidates(entry.projectDir, entry); } catch { /* kept in memory; nothing else waits on it */ } } };

  /**
   * The searches after `card`, one after another (OpenAlex refuses many at once from a caller without a key), filtered
   * in OpenAlex to papers that are cited, of a kind a newcomer reads, with an abstract (./climbs.cjs searchFiltered). After a
   * 429 the rest are not sent: the allowance is used up.
   */
  async function search(entry, card, queries) {
    for (const query of queries.slice(0, MAX_QUERIES)) {
      let refused = false;
      try {
        const out = await searchFiltered(papers, query, PER_SEARCH);
        entry.papers = mergeCandidates(entry.papers, out.results, { query, card });
        entry.searches.push({ after: card, query, at: now(), found: (out.results || []).length });
      } catch (error) {
        refused = isLimited(error);
        entry.searches.push({ after: card, query, at: now(), error: String(error && error.message || error).slice(0, 200), ...(refused ? { limited: true } : {}) });
      }
      keep(entry);
      // Build 2: the best papers so far are read now (record, pdf, text), so their climbs can start the moment the
      // sub-questions exist.
      if (climbs) { try { climbs.prefetch(entry.papers); } catch { /* read later, when a climb asks */ } }
      if (refused) break;
    }
  }

  function close(id) {
    const entry = held.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    for (const which of ['session', 'back']) if (entry[which]) { try { entry[which].close(); } catch { /* gone */ } entry[which] = null; }
    // Searches still running finish into the project's file; nothing else is kept once they do. Climbs not bound to a
    // project (onboarding left without one) stop.
    if (climbs && !entry.projectDir) climbs.cancel(id);
    Promise.allSettled([...entry.pending]).then(() => held.delete(id));
    entry.closed = true;
    return true;
  }

  return {
    /** Onboarding opened: its session starts now, warming, so the first card never waits on a cold start. */
    open() {
      const id = randomUUID();
      held.set(id, { session: null, back: null, searches: [], papers: [], projectDir: null, pending: new Set(), timer: null, suggestions: [], planNext: null, planning: false });
      const entry = get(id);
      for (const which of ['session', 'back']) { const session = sessionOf(entry, which); if (session) session.warm().catch(() => {}); }
      return { id };
    },
    /** Start (or start again) the session, as a card comes into view: after the tools screen installed the CLI, say. */
    warm(id) {
      const entry = get(id);
      for (const which of ['session', 'back']) {
        const before = entry[which], session = sessionOf(entry, which);
        if (session && (session !== before || !session.alive())) session.warm().catch(() => {});
      }
      return true;
    },
    /**
     * A card answered (`card`: working or why; `answers`: every answer so far) → { line, queries }: the line said back,
     * streamed through `onDelta(line)` as it arrives, and the searches it starts, which run on after this returns.
     */
    async answer(id, { card, answers }, { onDelta } = {}) {
      if (!['working', 'why'].includes(card)) throw new TypeError('card must be working or why');
      const entry = get(id), given = cleanAnswers(answers);
      if (!given[card]) return { line: '', queries: [] };
      let text = '';
      const session = sessionOf(entry, 'session');
      if (session) {
        const shown = (so) => { const line = reflectionOf(card, so); if (line && onDelta) onDelta(line); };
        try { text = await session.turn(cardMessage(card, given), { onDelta: shown }); } catch { text = ''; }
      }
      const line = reflectionOf(card, text);
      const wrote = queriesIn(text);
      const queries = wrote.length >= 3 ? wrote : [...new Set([...wrote, ...queriesOf(card === 'working' ? given.working : `${given[card]} ${given.working}`)])].slice(0, MAX_QUERIES);
      const running = search(entry, card, queries);
      entry.pending.add(running);
      running.finally(() => entry.pending.delete(running));
      return { line, queries };
    },
    /**
     * Putting it together's sentence (`answers`: working, why) → readJoin's { lead, working, join, why, end }, or {}
     * when the model could not join them (the card keeps their words as they are).
     */
    async join(id, { answers }) {
      const entry = get(id), given = cleanAnswers(answers), session = sessionOf(entry);
      if (!session || (!given.working && !given.why)) return {};
      try { return readJoin(await session.turn(joinMessage(given)), given) || {}; } catch { return {}; }
    },
    /**
     * Stuck?: one research question to settle on, not one they have seen (`seen`: what the field has held, Bart's first
     * suggestion among them); '' when the model could not say.
     */
    async stuck(id, { answers, seen = [] }) {
      const entry = get(id), session = sessionOf(entry);
      if (!session) return { text: '' };
      for (const one of Array.isArray(seen) ? seen : []) { const text = clean(one, 300); if (text && !entry.suggestions.includes(text)) entry.suggestions.push(text); }
      try {
        const text = asQuestion(strip(String(await session.turn(stuckMessage(cleanAnswers(answers), { before: entry.suggestions.slice(-8) }))).split('\n')[0]).slice(0, 200));
        if (text) entry.suggestions.push(text);
        return { text };
      } catch { return { text: '' }; }
    },
    /**
     * The project's name, question and three sub-questions, from the sentence; from their own words when the model fails.
     * Asked again as the sentence is edited: a plan still waiting to start when a newer one is asked is never run, and
     * whoever asked for it is answered with the newer one, so Submit never waits behind plans for words since changed.
     */
    plan(id, { answers, sentence }) {
      const entry = get(id);
      const job = { given: cleanAnswers(answers), sentence, askers: entry.planNext ? entry.planNext.askers : [] };
      entry.planNext = job;
      const answered = new Promise((resolve) => { job.askers.push(resolve); });
      const runNext = async () => {
        const next = entry.planNext;
        if (!next || entry.planning) return;
        entry.planNext = null;
        entry.planning = true;
        let out;
        const session = sessionOf(entry, 'back');
        try {
          if (!session) throw new Error('no session');
          const text = await Promise.race([session.turn(planMessage(next.given, next.sentence)), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('slow')), PLAN_TIMEOUT_MS); if (timer.unref) timer.unref(); })]);
          out = readPlan(text, next.given);
        } catch { out = { ...fallbackPlan(next.given), fallback: true }; }
        entry.planning = false;
        // Build 2: the latest plan's sub-questions are climbed at once, while the person is still on the card.
        if (climbs && !entry.planNext && !entry.closed) { try { climbs.begin(id, { question: out.question, starts: out.starts, brief: next.given, candidates: () => entry.papers }); } catch { /* climbed when the project opens */ } }
        for (const resolve of next.askers) resolve(out);
        runNext();
      };
      runNext();
      return answered;
    },
    /**
     * The project exists: what was found is written into it, and so is what is still being found. The session ends.
     * `made` { projectId, workspaceId, starts: [{ id, text }], question, brief }: the climbs begun on the plan become its
     * starts' (build 2, ./climbs.cjs bind).
     */
    attach(id, projectDir, made = null) {
      const entry = held.get(id);
      if (!entry || typeof projectDir !== 'string') return false;
      entry.projectDir = projectDir;
      keep(entry);
      if (climbs && made) { try { climbs.bind(id, { projectDir, projectId: made.projectId, workspaceId: made.workspaceId, starts: made.starts || [], question: made.question, brief: made.brief || null, candidates: () => entry.papers }); } catch { /* climbed when the workspace shows */ } }
      close(id);
      return true;
    },
    close,
    closeAll() { for (const id of [...held.keys()]) close(id); },
    /** What onboarding `id` found so far (tests, and build 2 before the project exists). */
    candidates(id) { const entry = held.get(id); return entry ? { searches: entry.searches.slice(), papers: entry.papers.slice() } : null; },
    /** Settles once the searches started so far have ended (tests). */
    settled(id) { const entry = held.get(id); return entry ? Promise.allSettled([...entry.pending]) : Promise.resolve([]); },
  };
}

/** A scripted climb's draft: the first sentence of the first quotable text of up to three papers, in the climb's order. */
function fakeDraft(message) {
  const stages = ['problem', 'known', 'open'];
  const rungs = [];
  let paper = null;
  for (const line of message.split('\n')) {
    const head = line.match(/^\[(W\d+)\]/);
    if (head) { paper = head[1]; continue; }
    const text = line.match(/^ {2}(?:Abstract|Excerpt \d+ \([^)]*\)): (.+)$/);
    if (!text || !paper || rungs.some((one) => one.paper === paper) || rungs.length >= 3) continue;
    const sentence = (text[1].match(/^.{30,}?[.!?](?=\s|$)/) || [text[1].slice(0, 200)])[0];
    rungs.push({ stage: stages[rungs.length], paper, passage: sentence, line: `fake step ${rungs.length + 1}`, gloss: '' });
  }
  return JSON.stringify({ answer: 'A fake answer.', rungs, more: [] });
}

/** A scripted check: every rung approved, and the newcomer gets there. */
function fakeCheck(message) {
  const count = (message.match(/^Rung \d+ /gm) || []).length;
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ rung: i + 1, read_in_context: true, answers_sub_question: true, says_what_line_claims: true, self_contained: true, assumes_only_earlier: true, why: 'fake check', fix: null }));
  lines.push(JSON.stringify({ newcomer: true, own_answer: 'A fake answer.', newcomer_answer: 'A fake answer.', same: true, confusing: [] }));
  return lines.join('\n');
}

/**
 * Scripted runs only (ENGELBART_BART_FAKE=1): no model. A session whose turns answer as the model's format says, from
 * the message itself, after `delayMs`; the searches are real unless `papers` says otherwise.
 */
function createFakeSession({ delayMs = 300 } = {}) {
  let closed = false;
  const pause = () => new Promise((resolve) => { setTimeout(resolve, delayMs); });
  const answerOf = (message) => {
    const said = (question) => { const m = message.match(new RegExp(`${question.replace(/[?,]/g, (c) => `\\${c}`)} (.+)`)); return m ? m[1] : ''; };
    if (/^Reply with the one word/.test(message)) return 'ready';
    if (/finish the sentence "You're working on/.test(message)) return `fake reflection of ${said(QUESTIONS.working).toLowerCase()}\nsearch: ${queriesOf(said(QUESTIONS.working))[0] || 'fake'}\nsearch: fake search two\nsearch: fake search three`;
    if (/finish the sentence "Because/.test(message)) return `fake purpose: ${said(QUESTIONS.why).toLowerCase()}\nsearch: ${queriesOf(said(QUESTIONS.why))[0] || 'fake'}\nsearch: fake search two\nsearch: fake search three`;
    if (/^Join their answers? into one sentence/m.test(message)) {
      const lower = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text).replace(/[.!]+$/, '');
      const w = lower(said(QUESTIONS.working).replace(/^i['’]?m working on /i, '')), y = lower(said(QUESTIONS.why).replace(/^because /i, ''));
      return w && y ? `I'm working on [[${w}]] because [[${y}]].` : w ? `I'm working on [[${w}]].` : `I'm interested in this because [[${y}]].`;
    }
    if (/Suggest one research question/.test(message)) return `What would a fake question ask about ${queriesOf(said(QUESTIONS.working))[0] || 'it'}, take ${(message.match(/Not one of these/) ? (message.split('"; "').length + 1) : 1)}?`;
    if (/Write exactly five lines/.test(message)) { const theirs = said(QUESTIONS.question); return `name: Fake Project Name\nquestion: ${theirs || 'What would a fake question ask?'}\n1. What makes the fake problem hard?\n2. What has fake prior work found?\n3. What does your own fake data show?`; }
    // Picking the papers worth reading (./climb.cjs pickPapers): every candidate, in the order given.
    if (/Candidate papers:/.test(message)) return JSON.stringify({ picked: (message.match(/^\[(W\d+)\]/gm) || []).map((one) => ({ paper: one.slice(1, -1), why: 'fake pick' })), refused: [] });
    // Build 2's climbs (./climb.cjs): a draft quoting the first sentence of up to three papers, and a check approving all.
    if (/Papers you may quote/.test(message)) return fakeDraft(message);
    if (/Write one line of JSON for rung 1/.test(message)) return '{"rung": 1, "read_in_context": true, "answers_sub_question": true, "says_what_line_claims": true, "self_contained": true, "assumes_only_earlier": true, "why": "fake check", "fix": null}';
    if (/the newcomer check/.test(message)) return fakeCheck(message);
    return 'search: fake search one\nsearch: fake search two\nsearch: fake search three';
  };
  return {
    provider: 'fake',
    warm: () => pause().then(() => 'ready'),
    async turn(message, { onDelta } = {}) {
      if (closed) throw new Error('closed');
      const text = answerOf(message);
      await pause();
      if (onDelta) { const words = text.split(' '); for (let n = 1; n <= words.length; n += 1) { onDelta(words.slice(0, n).join(' ')); await new Promise((resolve) => { setTimeout(resolve, 15); }); } }
      return text;
    },
    alive: () => !closed,
    close() { closed = true; },
  };
}

module.exports = { CARDS, QUESTIONS, LABELS, CANDIDATES_FILE, ONBOARD_SYSTEM_PROMPT, createOnboard, createFakeSession, cleanAnswers, cardMessage, stuckMessage, planMessage, joinMessage, readJoin, reflectionOf, queriesIn, queriesOf, readPlan, fallbackPlan, mergeCandidates, writeCandidates, readCandidates };
