'use strict';

// Onboarding as brainstorm cards, build 1 (2026-10-07; design/onboarding-brainstorm, screens/Onboarding.jsx): what Bart
// does while a person answers the four cards. One session per onboarding (./onboard-session.cjs), on the fastest level
// Bart has (./models.cjs onboardStep), started when onboarding opens, for what the person waits on: the line said back
// and Stuck?. What they do not wait on (the third card's searches, the plan) runs in a second one started beside it, so
// a Stuck? never queues behind a plan (checked by hand 2026-10-07: in one session it waited about seven seconds). Per card:
//   - after "What are you working on?" and "Why this, and why now?": one line said back above the next card, streamed
//     ("You're working on …", "So that …"), and 3 to 5 searches for papers on it, in the same reply;
//   - after "What are you least sure about?": the searches alone;
//   - on "Putting it together": Stuck? (one way to fill the blank), and one call for the project's name, its question and
//     three sub-questions, made while they are on the card, so they are there the moment the project opens.
// Every message carries every answer so far, so a session started again loses nothing.
//
// The searches (for build 2's climbs, ./climbs.cjs: the best papers are read as they are found, and the plan's
// sub-questions are climbed the moment it is written, attach binding them to the project) run straight from main against OpenAlex
// (./papers.cjs `search`), with no agent: 3 to 5 after each of the first three cards, their papers merged by id and kept
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

const CARDS = ['working', 'why', 'unsure', 'together'];
const QUESTIONS = { working: 'What are you working on?', why: 'Why this, and why now?', unsure: 'What are you least sure about?', findOut: 'What do you want to find out?' };
// What each reflection finishes, as the card above it shows it.
const LABELS = { working: 'You’re working on', why: 'So that' };
const CANDIDATES_FILE = 'start-candidates.json';
const MAX_QUERIES = 5;
const PER_SEARCH = 8;
const IDLE_MS = 30 * 60_000;
const PLAN_TIMEOUT_MS = 40_000;

const ONBOARD_SYSTEM_PROMPT = `You help a researcher start a project in Engelbart, a research notebook, by saying back what they tell you. They answer four questions, one at a time: what they are working on, why this and why now, what they are least sure about, and what they want to find out. Each message gives their answers so far and asks for one thing in an exact format.

Reply in that format only: no preamble, no markdown, no quotation marks, nothing after it.

Keep their words and their terms. Make it shorter and plainer, never grander, and add nothing they did not say. Never praise them and never ask a question back.`;

const clean = (value, max = 2000) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** The answers as the renderer sends them, made safe: strings, bounded; '' for a card skipped. */
function cleanAnswers(answers) {
  const given = answers && typeof answers === 'object' ? answers : {};
  return { working: clean(given.working), why: clean(given.why), unsure: clean(given.unsure), findOut: clean(given.findOut, 600) };
}

function answersBlock(answers) {
  const lines = ['working', 'why', 'unsure', 'findOut'].filter((key) => answers[key]).map((key) => `${QUESTIONS[key]} ${answers[key]}`);
  return `<answers>\n${lines.join('\n') || '(none yet)'}\n</answers>`;
}

const SEARCH_LINES = 'Then 3 to 5 lines, each "search: " and 2 to 6 words to search a catalogue of research papers with: the topic in the words papers on it would use, each line a different angle.';

/** The message after a card is answered: a reflection and searches (working, why), or the searches alone (unsure). */
function cardMessage(card, answers) {
  const block = answersBlock(answers);
  if (card === 'working') return `${block}\n\nLine 1: finish the sentence "You're working on …" with what they said they are working on, in under 16 words, keeping their terms. Write only the ending: no "You're working on", no full stop.\n${SEARCH_LINES}`;
  if (card === 'why') return `${block}\n\nLine 1: finish the sentence "So that …" with what their answer to "${QUESTIONS.why}" says the work is for, in under 16 words, keeping their terms. Write only the ending: no "So that", no full stop.\n${SEARCH_LINES}`;
  return `${block}\n\n${SEARCH_LINES.replace('Then 3', 'Write 3')} Search for what they are least sure about, in the setting of what they are working on.`;
}

/** Stuck?: one way to fill the blank, not one of the earlier suggestions. */
function stuckMessage(answers, { before = [] } = {}) {
  const working = answers.working || '…', why = answers.why || '…';
  const not = before.length ? `\nNot one of these, which they have seen: ${before.map((one) => `"${clean(one, 200)}"`).join('; ')}.` : '';
  return `${answersBlock(answers)}\n\nThey are completing: "I'm working on ${working} because I want to find out ___ so that ${why}."\nSuggest one way to fill the blank: something they could find out, drawn from what they are least sure about. Under 15 words, starting with a lowercase word (unless it is a name), no full stop. Reply with the words for the blank only.${not}`;
}

/** The project's name, its question and three sub-questions, from the sentence they put together. */
function planMessage(answers, sentence) {
  return `${answersBlock(answers)}\n\nTheir sentence: "${clean(sentence, 1200) || '(not written)'}"\n\nWrite exactly five lines:\nname: a name for the project, 2 to 5 words, title case, from what they are working on\nquestion: their research question, one sentence under 14 words ending in a question mark, from what they want to find out (else what they are least sure about)\n1. a sub-question\n2. a sub-question\n3. a sub-question\nThe three sub-questions break the research question into places to start, each under 12 words, ending in a question mark. Order them as a story, the way an advisor walks someone in: 1 is about understanding the problem itself (what it is, where it shows up, why it is hard), 2 about how it has been studied (what is already published, the methods and findings), and 3, last, about their own data, study or contribution (what they will collect, build or show).`;
}

const strip = (text) => clean(text).replace(/^["“'‘*_-]+|["”'’*_]+$/g, '').trim();

/** A reflection's line as it is shown, from the reply so far: its first line, without the label it finishes, capitalised. */
function reflectionOf(card, text) {
  const first = String(text || '').split('\n').map(strip).find((line) => line && !/^search:/i.test(line)) || '';
  let line = first;
  if (card === 'working') line = line.replace(/^(you['’]?re|you are)\s+working\s+on\s+/i, '');
  if (card === 'why') line = line.replace(/^so\s+that\s+/i, '');
  line = line.replace(/[.…]+$/, '').trim();
  return line ? line[0].toUpperCase() + line.slice(1) : '';
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
const topicOf = (answers) => clean(answers.working || answers.unsure || answers.findOut, 400).replace(/^(i['’]?m|i am)\s+(working on|studying|looking at)\s+/i, '').replace(/[.!?]+$/, '');

/** The plan made from their own words, when the model gave none (or part of one). */
function fallbackPlan(answers) {
  const topic = topicOf(answers);
  const words = clean(topic).toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word));
  const name = words.length ? titleCase(words.slice(0, 4)) : 'New project';
  const question = asQuestion(answers.findOut) || asQuestion(answers.unsure) || (topic ? `What is known about ${topic}?` : 'What do you want to find out?');
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

  /** The searches after `card`, one after another (OpenAlex refuses many at once from a caller without a key). */
  async function search(entry, card, queries) {
    for (const query of queries.slice(0, MAX_QUERIES)) {
      try {
        const out = await papers.search({ query, limit: PER_SEARCH });
        entry.papers = mergeCandidates(entry.papers, out.results, { query, card });
        entry.searches.push({ after: card, query, at: now(), found: (out.results || []).length });
      } catch (error) {
        entry.searches.push({ after: card, query, at: now(), error: String(error && error.message || error).slice(0, 200) });
      }
      keep(entry);
      // Build 2: the best papers so far are read now (record, pdf, text), so their climbs can start the moment the
      // sub-questions exist.
      if (climbs) { try { climbs.prefetch(entry.papers); } catch { /* read later, when a climb asks */ } }
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
     * A card answered (`card`: working, why or unsure; `answers`: every answer so far) → { line, queries }: the line said
     * back above the next card (none after unsure), streamed through `onDelta(line)` as it arrives, and the searches it
     * starts, which run on after this returns.
     */
    async answer(id, { card, answers }, { onDelta } = {}) {
      if (!['working', 'why', 'unsure'].includes(card)) throw new TypeError('card must be working, why or unsure');
      const entry = get(id), given = cleanAnswers(answers);
      if (!given[card]) return { line: '', queries: [] };
      let text = '';
      const session = sessionOf(entry, card === 'unsure' ? 'back' : 'session');
      if (session) {
        const shown = (so) => { const line = reflectionOf(card, so); if (line && onDelta && card !== 'unsure') onDelta(line); };
        try { text = await session.turn(cardMessage(card, given), { onDelta: shown }); } catch { text = ''; }
      }
      const line = card === 'unsure' ? '' : reflectionOf(card, text);
      const wrote = queriesIn(text);
      const queries = wrote.length >= 3 ? wrote : [...new Set([...wrote, ...queriesOf(card === 'working' ? given.working : `${given[card]} ${given.working}`)])].slice(0, MAX_QUERIES);
      const running = search(entry, card, queries);
      entry.pending.add(running);
      running.finally(() => entry.pending.delete(running));
      return { line, queries };
    },
    /** Stuck?: one way to fill the blank; '' when the model could not say. */
    async stuck(id, { answers }) {
      const entry = get(id), session = sessionOf(entry);
      if (!session) return { text: '' };
      try {
        const text = strip(String(await session.turn(stuckMessage(cleanAnswers(answers), { before: entry.suggestions }))).split('\n')[0]).replace(/[.…]+$/, '').slice(0, 200);
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
  const lines = Array.from({ length: count }, (_, i) => JSON.stringify({ rung: i + 1, read_in_context: true, says_what_line_claims: true, self_contained: true, assumes_only_earlier: true, why: 'fake check', fix: null }));
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
    if (/finish the sentence "So that/.test(message)) return `fake purpose: ${said(QUESTIONS.why).toLowerCase()}\nsearch: ${queriesOf(said(QUESTIONS.why))[0] || 'fake'}\nsearch: fake search two\nsearch: fake search three`;
    if (/Suggest one way to fill the blank/.test(message)) return `fake way to find out about ${said(QUESTIONS.unsure).toLowerCase() || 'it'}`;
    if (/Write exactly five lines/.test(message)) return 'name: Fake Project Name\nquestion: What would a fake question ask?\n1. What makes the fake problem hard?\n2. What has fake prior work found?\n3. What does your own fake data show?';
    // Build 2's climbs (./climb.cjs): a draft quoting the first sentence of up to three papers, and a check approving all.
    if (/Papers you may quote/.test(message)) return fakeDraft(message);
    if (/Write one line of JSON for rung 1/.test(message)) return '{"rung": 1, "read_in_context": true, "says_what_line_claims": true, "self_contained": true, "assumes_only_earlier": true, "why": "fake check", "fix": null}';
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

module.exports = { CARDS, QUESTIONS, LABELS, CANDIDATES_FILE, ONBOARD_SYSTEM_PROMPT, createOnboard, createFakeSession, cleanAnswers, cardMessage, stuckMessage, planMessage, reflectionOf, queriesIn, queriesOf, readPlan, fallbackPlan, mergeCandidates, writeCandidates, readCandidates };
