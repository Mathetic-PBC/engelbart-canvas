'use strict';

// The climbs under a workspace's "Suggested places to start" (onboarding build 2, 2026-10-08; ./climb.cjs makes one).
// What runs them, when, and where they are kept.
//
// When: onboarding's searches find papers while the cards are answered (./onboard.cjs), and the best of them are read
// at once (prefetch: ./shelf.cjs fetches each one's record, open-access pdf and text). As soon as the sub-questions
// exist (the plan, made while the person is on Putting it together) a climb starts for each (begin), so approval is under
// way before the project opens. Once it is made (bind) each climb is the climb of its start, and is written into the
// project as it goes. A start edited or added later, or a climb a quit left unfinished, is climbed when the workspace
// shows it (ensure).
//
// Every sub-question always ends with something approved under it: the climb from onboarding's papers; else one from a
// quick OpenAlex search for that sub-question; else, for a sub-question about their own data or work, a step that is not
// a paper ("Add your data: …", with the way to add it), and for any other, a step asking for a paper they trust. Those
// two are fixed words that claim nothing about a paper, so no model has anything to approve in them: their record says so.
//
// Where: <project>/.context/climbs.json { v, about, starts: { <start id>: climb } } (a climb: ./climb.cjs buildClimb's,
// each paper rung with `open`: the copy the Stage opens, in <project>/.context/papers/ — the pdf, or for a passage of an
// abstract a markdown file of the abstract — and the passage to show there). `onChange({ projectId, workspaceId })` is
// told after each write.
//
// The models: the writer at the fastest level Bart has (Sonnet medium; Luna on Codex), the approval at the second step of
// @bart's ladder (Opus high; Sol high on Codex): "the strongest level Bart has" short of Fable and Astra, which a question
// reaches only when it asks to. At most LIMIT run at once, a first rung's check before a draft, a draft before a whole
// climb's check.

const fs = require('node:fs');
const path = require('node:path');
const { createWarmSession } = require('./onboard-session.cjs');
const { buildClimb, WRITER_SYSTEM, CHECKER_SYSTEM } = require('./climb.cjs');
const { onboardStep } = require('./models.cjs');
const { nearness } = require('./climb-text.cjs');
const { paperLabel } = require('./shelf.cjs');

const FILE = 'climbs.json';
const LIMIT = 4;
const PREFETCH = 12; // papers read while the cards are answered
const PER_CLIMB = 8; // candidates read for one sub-question
const QUOTABLE = 6; // papers a writer is given to quote from
const READ_WAIT_MS = 15_000; // how long a climb waits for its papers to be read before it goes on with what is
const READING = 4; // papers read at once (OpenAlex records, open-access pdfs, their text)
const TIMEOUTS = { writer: 150_000, checker: 240_000 };

const ACTIONS = {
  data: { title: 'Add your data: logs, exports, a codebook', line: 'Choose the files here, or drop them on the sidebar’s library.', how: 'files' },
  paper: { title: 'Add a paper you trust on this', line: 'Choose its pdf here, or drop it on the sidebar’s library.', how: 'files' },
};

/** Whether a sub-question is about the person's own data, study or work (build 1 puts that one last). */
const aboutTheirOwn = (text) => /\b(your|you|my|our)\b/i.test(String(text || '')) && /\b(data|dataset|logs?|study|studies|collect|measure|capture|build|design|show|contribution|work|sample|participants|records?)\b/i.test(String(text || ''));

/** The action step a sub-question falls back on, as a climb's one item. */
function actionClimb(sub, now) {
  const which = aboutTheirOwn(sub) ? 'data' : 'paper';
  const action = ACTIONS[which];
  return { id: `action-${which}`, kind: 'action', which, title: action.title, line: action.line, how: action.how, approval: { by: 'fixed words', note: 'Not a passage: it claims nothing about a paper, so there is nothing for a model to approve.', at: now } };
}

/** The best of onboarding's candidates to read first: found by the most searches, then the most cited. */
function rankCandidates(candidates) {
  return (candidates || []).filter((one) => one && typeof one.id === 'string').slice().sort((a, b) => ((b.queries || []).length - (a.queries || []).length) || ((b.cited_by || 0) - (a.cited_by || 0)));
}

/** The candidates for one sub-question: nearest by title, then found by the most searches, then the most cited. */
function candidatesFor(sub, candidates) {
  return (candidates || []).filter((one) => one && typeof one.id === 'string').map((one) => ({ one, near: nearness(one, sub) })).sort((a, b) => (b.near - a.near) || (((b.one.queries || []).length) - ((a.one.queries || []).length)) || ((b.one.cited_by || 0) - (a.one.cited_by || 0))).map(({ one }) => one);
}

/** Searches for one sub-question when onboarding's papers gave nothing: its content words, whole and the first half. */
function fallbackQueries(sub) {
  const words = String(sub || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ' ').split(/\s+/).filter((word) => word.length > 2 && !QUESTION_WORDS.has(word));
  if (!words.length) return [];
  return [...new Set([words.slice(0, 6).join(' '), words.slice(0, 3).join(' ')])];
}
const QUESTION_WORDS = new Set('what which how does your the and for with from that this have been will would could should about into their there when where whom whose why are was were has had can did you they them its our'.split(' '));

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

/** What a project keeps of its climbs → { v, starts }. */
function readClimbs(projectDir) {
  const value = projectDir ? readJson(path.join(projectDir, '.context', FILE)) : null;
  return value && value.starts && typeof value.starts === 'object' ? { v: 1, starts: value.starts } : { v: 1, starts: {} };
}

const safeName = (text) => String(text || '').replace(/[\0-\x1f\x7f/\\:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90).trim() || 'paper';

/**
 * A paper rung given what the Stage opens (`open` { path, find, page }): a copy of its pdf in <project>/.context/papers,
 * or, for a passage of the abstract, the abstract as a markdown file there. Made once a paper.
 */
function withOpen(rung, projectDir, shelf) {
  if (!rung || rung.kind !== 'paper' || !projectDir) return rung;
  const paper = shelf.get(rung.paper.id);
  if (!paper) return rung;
  const dir = path.join(projectDir, '.context', 'papers');
  const stem = safeName(`${paperLabel(paper)} ${String(paper.title || '').split(/[:?!.]\s/)[0].split(/\s+/).slice(0, 7).join(' ')}`);
  try {
    if (rung.source === 'pdf' && paper.pdf) {
      const file = path.join(dir, `${stem}.pdf`);
      if (!fs.existsSync(file)) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(paper.pdf, file); }
      return { ...rung, open: { path: file, find: rung.anchor.find, page: rung.anchor.page } };
    }
    if (paper.abstract) {
      const file = path.join(dir, `${stem} (abstract).md`);
      if (!fs.existsSync(file)) {
        const by = [(paper.authors || []).join(', '), paper.year, paper.venue].filter(Boolean).join(' · ');
        writeAtomic(file, `# ${String(paper.title || 'Untitled').replace(/[#*_`[\]]/g, ' ').replace(/\s+/g, ' ').trim()}\n\n${by}\n\n## Abstract\n\n${paper.abstract}\n`);
      }
      return { ...rung, open: { path: file, find: rung.anchor.find, page: null } };
    }
  } catch { /* the project's folder could not be written: the rung opens nothing */ }
  return rung;
}

/**
 * `readModels()`: @bart's list in force. `makeSession(options)`: ./onboard-session.cjs's (a fake in tests). `shelf`:
 * ./shelf.cjs. `papers`: ./papers.cjs (search). `onChange({ projectId, workspaceId })`.
 */
function createClimbs({ readModels, makeSession = (options) => createWarmSession(options), sessionOptions = {}, shelf, papers, onChange = () => {}, limit = LIMIT, readWaitMs = READ_WAIT_MS, now = () => new Date().toISOString() } = {}) {
  /* --------------------------------------------------------------------------- models, LIMIT at once */
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < limit && queue.length) {
      queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      const next = queue.shift();
      active += 1;
      next.run().finally(() => { active -= 1; pump(); });
    }
  };
  let seq = 0;
  const limited = (priority, fn) => new Promise((resolve, reject) => { queue.push({ priority, seq: (seq += 1), run: () => fn().then(resolve, reject) }); pump(); });

  /**
   * The step a role runs at: the writer the fastest level Bart has (./models.cjs onboardStep: Sonnet medium, Luna), the
   * approval the second step of @bart's ladder (Opus high, Sol high): the strongest it climbs to unasked.
   */
  function stepOf(role) {
    const models = readModels();
    if (role !== 'checker') return onboardStep(models);
    const provider = models.provider, entry = models.providers[provider];
    const ladder = entry.ladder || [];
    const rung = ladder[1] || ladder[ladder.length - 1] || { model: Object.keys(entry.models)[0], effort: entry.efforts[0] };
    const model = entry.models[rung.model] || Object.values(entry.models)[0];
    return { provider, key: rung.model, model: model.id, name: model.name, effort: rung.effort };
  }

  /** `ask` for one job: a new session a call (a whole climb's checks share one, so a round two reads round one). */
  function asker(job) {
    return (role, message, { onDelta, onBy, priority = 1 } = {}) => limited(priority, async () => {
      if (job.cancelled) throw new Error('cancelled');
      const step = stepOf(role);
      const by = { provider: step.provider, model: step.name || step.model, id: step.model, effort: step.effort };
      if (onBy) onBy(by);
      const shared = role === 'checker' && priority === 2;
      let session = shared ? job.checker : null;
      if (!session) {
        // Codex keeps its instructions in its home: one home a role, so a draft and a check never read each other's.
        const own = sessionOptions.codexHome ? { codexHome: `${sessionOptions.codexHome}-${role}` } : {};
        session = makeSession({ step, system: role === 'checker' ? CHECKER_SYSTEM : WRITER_SYSTEM, timeoutMs: TIMEOUTS[role], ...sessionOptions, ...own });
        job.sessions.add(session);
        if (shared) job.checker = session;
      }
      try {
        const text = await session.turn(message, { onDelta });
        return { text, by };
      } finally {
        if (!shared) { try { session.close(); } catch { /* gone */ } job.sessions.delete(session); }
      }
    });
  }

  /* --------------------------------------------------------------------------------- reading papers */
  const reading = []; let readingNow = 0;
  const readLater = (candidate) => new Promise((resolve) => {
    reading.push({ candidate, resolve });
    const go = () => {
      while (readingNow < READING && reading.length) {
        const { candidate: one, resolve: done } = reading.shift();
        readingNow += 1;
        Promise.resolve(shelf.prepare(one)).catch(() => null).then((out) => { readingNow -= 1; done(out); go(); });
      }
    };
    go();
  });
  const asked = new Map(); // paper id → its reading
  const read = (candidate) => { if (!asked.has(candidate.id)) asked.set(candidate.id, readLater(candidate)); return asked.get(candidate.id); };

  /** Papers for a climb: the nearest candidates read (waited for up to readWaitMs), quotable ones first. */
  async function papersFor(sub, candidates) {
    const near = candidatesFor(sub, candidates).slice(0, PER_CLIMB);
    const all = Promise.all(near.map((one) => read(one)));
    await Promise.race([all, new Promise((resolve) => { const timer = setTimeout(resolve, readWaitMs); if (timer.unref) timer.unref(); })]);
    const got = near.map((one) => shelf.get(one.id)).filter(Boolean);
    const quotable = got.filter((paper) => paper.abstract || paper.pages).sort((a, b) => (nearness(b, sub) - nearness(a, sub)) || ((b.pages ? 1 : 0) - (a.pages ? 1 : 0))).slice(0, QUOTABLE);
    const unquotable = got.filter((paper) => !paper.abstract && !paper.pages).slice(0, 3);
    return [...quotable, ...unquotable];
  }

  /** OpenAlex searched in a sub-question's words (`count` searches, fallbackQueries) → their papers, each once. */
  async function searchFor(sub, count, limit = 6) {
    const found = [];
    for (const query of fallbackQueries(sub).slice(0, count)) {
      try { const out = await papers.search({ query, limit }); for (const one of out.results || []) if (!found.some((held) => held.id === one.id)) found.push({ ...one, queries: [query] }); } catch { /* offline: on to the next */ }
    }
    return found;
  }

  /* ------------------------------------------------------------------------------------------ jobs */
  const jobs = new Set();
  const writing = new Map(); // `${projectDir}\n${startId}` → the job climbing it

  function write(job) {
    const target = job.target;
    if (!target || job.cancelled || !job.state) return;
    const file = path.join(target.projectDir, '.context', FILE);
    const kept = readClimbs(target.projectDir);
    const state = { ...job.state, rungs: (job.state.rungs || []).map((rung) => withOpen(rung, target.projectDir, shelf)), updatedAt: now() };
    kept.starts[target.startId] = state;
    try {
      writeAtomic(file, `${JSON.stringify({ v: 1, about: 'The climbs under each of a workspace\'s suggested places to start (src/main/bart/climbs.cjs): each start\'s approved rungs, in order, each with the record of its approval.', starts: kept.starts }, null, 1)}\n`);
    } catch { return; }
    try { onChange({ projectId: target.projectId, workspaceId: target.workspaceId }); } catch { /* a listener never stops a climb */ }
  }

  function startJob({ text, question, brief, candidates, target = null }) {
    const job = { text, question, brief, target, state: null, cancelled: false, sessions: new Set(), checker: null, done: null };
    jobs.add(job);
    if (target) writing.set(`${target.projectDir}\n${target.startId}`, job);
    const ask = asker(job);
    // When each step was reached, in ms from the start (the eval script reports them): papers read, drafted, the first
    // rung approved, done.
    const began = Date.now(), timing = {};
    const mark = (name) => { if (timing[name] == null) timing[name] = Date.now() - began; };
    const update = (climb) => {
      if (job.cancelled) return;
      if (climb.status === 'checking') mark('drafted');
      if (climb.rungs.length) mark('firstApproved');
      job.state = { ...climb, fallback: job.fallback || null, timing: { ...timing } };
      write(job);
    };
    job.done = (async () => {
      job.state = { question: text, status: 'reading', step: 'reading', answer: '', rungs: [], pending: 0, more: [], failures: [], newcomer: null, rounds: 0, fallback: null };
      write(job);
      let climb = null;
      try {
        // Onboarding's papers were found from their answers; one search in the sub-question's own words joins them, so
        // a sub-question onboarding's searches did not reach ("what counts as transfer?") has papers on it too.
        const own = await searchFor(text, 1);
        const pool = [...(typeof candidates === 'function' ? candidates() : candidates || [])];
        for (const one of own) if (!pool.some((held) => held.id === one.id)) pool.push(one);
        const papersNow = await papersFor(text, pool);
        mark('read');
        if (job.cancelled) return null;
        climb = await buildClimb({ sub: text, question, brief, papers: papersNow, ask, onUpdate: update, cancelled: () => job.cancelled, now });
      } catch { climb = null; }
      if (job.cancelled) return null;
      // Nothing approved from onboarding's papers: a quick search for this sub-question.
      if (!climb || !climb.rungs.length) {
        job.fallback = 'search';
        const found = await searchFor(text, 2, 8);
        if (found.length && !job.cancelled) {
          try {
            const papersNow = await papersFor(text, found);
            const failures = climb ? climb.failures : [];
            climb = await buildClimb({ sub: text, question, brief, papers: papersNow, ask, onUpdate: update, cancelled: () => job.cancelled, now });
            climb.failures = [...failures, ...climb.failures];
          } catch { /* on to the last resort */ }
        }
      }
      if (job.cancelled) return null;
      // Still nothing: a step that is not a paper.
      if (!climb || !climb.rungs.length) {
        job.fallback = 'action';
        climb = { ...(climb || { question: text, answer: '', more: [], failures: [], newcomer: null, rounds: 0 }), status: 'done', step: 'done', pending: 0, rungs: [actionClimb(text, now())] };
      }
      if (climb.rungs.length) mark('firstApproved');
      mark('done');
      job.state = { ...climb, fallback: job.fallback || null, timing: { ...timing } };
      write(job);
      return job.state;
    })().finally(() => {
      for (const session of job.sessions) { try { session.close(); } catch { /* gone */ } }
      job.sessions.clear();
      jobs.delete(job);
      if (job.target && writing.get(`${job.target.projectDir}\n${job.target.startId}`) === job) writing.delete(`${job.target.projectDir}\n${job.target.startId}`);
    });
    return job;
  }

  function cancel(job) {
    job.cancelled = true;
    for (const session of job.sessions) { try { session.close(); } catch { /* gone */ } }
  }

  const runs = new Map(); // onboarding id → { jobs: Map(text → job), question, brief, candidates }

  return {
    /** While the cards are answered: the best of what the searches found so far, read now. */
    prefetch(candidates) { for (const one of rankCandidates(candidates).slice(0, PREFETCH)) read(one); },
    /**
     * The plan's sub-questions exist: a climb starts for each, before the project does. Asked again with a new plan, a
     * climb for the same words goes on, and one for words no longer there stops.
     */
    begin(key, { question, starts, brief = null, candidates }) {
      const run = runs.get(key) || { jobs: new Map() };
      Object.assign(run, { question, brief, candidates });
      const wanted = new Set(starts);
      for (const [text, job] of run.jobs) if (!wanted.has(text)) { cancel(job); run.jobs.delete(text); }
      for (const text of starts) if (!run.jobs.has(text)) run.jobs.set(text, startJob({ text, question, brief, candidates }));
      runs.set(key, run);
      return [...run.jobs.keys()];
    },
    /**
     * The project exists (`starts` [{ id, text }] its first workspace's): each climb is its start's from now on, written
     * into the project; a start with no climb under way (a plan made from their own words) gets one.
     */
    bind(key, { projectDir, projectId, workspaceId, starts, question, brief = null, candidates = null }) {
      const run = runs.get(key) || { jobs: new Map(), question, brief, candidates: candidates || [] };
      runs.delete(key);
      const used = new Set();
      for (const start of starts || []) {
        const target = { projectDir, projectId, workspaceId, startId: start.id };
        let job = run.jobs.get(start.text);
        if (job && !used.has(job)) {
          used.add(job);
          job.target = target;
          writing.set(`${projectDir}\n${start.id}`, job);
          write(job);
        } else {
          job = startJob({ text: start.text, question: question || run.question, brief: brief || run.brief, candidates: candidates || run.candidates || [], target });
          used.add(job);
        }
      }
      for (const job of run.jobs.values()) if (!used.has(job)) cancel(job);
    },
    /** Onboarding left without a project: its climbs stop. */
    cancel(key) { const run = runs.get(key); if (!run) return false; for (const job of run.jobs.values()) cancel(job); runs.delete(key); return true; },
    /** What a project keeps for one workspace's starts → { starts: { id: climb } } (only those it has). */
    read(projectDir, startIds = null) {
      const kept = readClimbs(projectDir).starts;
      if (!startIds) return { starts: kept };
      return { starts: Object.fromEntries(startIds.filter((id) => kept[id]).map((id) => [id, kept[id]])) };
    },
    /**
     * A workspace's starts as they are: one with no climb for its words, or one a quit left unfinished, is climbed now;
     * climbs of starts removed are dropped. → which start ids started.
     */
    ensure({ projectDir, projectId, workspaceId, question, brief = null, starts }) {
      const kept = readClimbs(projectDir).starts;
      const candidates = () => { const file = readJson(path.join(projectDir, '.context', 'start-candidates.json')); return (file && Array.isArray(file.papers)) ? file.papers : []; };
      const started = [];
      for (const start of starts || []) {
        const key = `${projectDir}\n${start.id}`;
        const running = writing.get(key);
        if (running && running.text === start.text) continue;
        const climb = kept[start.id];
        if (climb && climb.question === start.text && climb.status === 'done') continue;
        if (running) cancel(running);
        startJob({ text: start.text, question, brief, candidates, target: { projectDir, projectId, workspaceId, startId: start.id } });
        started.push(start.id);
      }
      const ids = new Set((starts || []).map((start) => start.id));
      const gone = Object.keys(kept).filter((id) => !ids.has(id));
      if (gone.length) {
        for (const id of gone) { delete kept[id]; const job = writing.get(`${projectDir}\n${id}`); if (job) cancel(job); }
        try { writeAtomic(path.join(projectDir, '.context', FILE), `${JSON.stringify({ v: 1, starts: kept }, null, 1)}\n`); } catch { /* left as it was */ }
      }
      return started;
    },
    /** Settles once every climb under way has ended (tests, the eval script). */
    settled() { return Promise.allSettled([...jobs].map((job) => job.done)); },
    stopAll() { for (const job of jobs) cancel(job); runs.clear(); },
    stepOf,
  };
}

module.exports = { createClimbs, readClimbs, withOpen, actionClimb, aboutTheirOwn, rankCandidates, candidatesFor, fallbackQueries, ACTIONS, FILE };
