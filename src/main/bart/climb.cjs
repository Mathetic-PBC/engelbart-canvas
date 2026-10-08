'use strict';

// A climb (onboarding build 2, 2026-10-08; design/onboarding-brainstorm/6-workspace.dc.html): for one sub-question, the
// fewest passages from papers that walk a newcomer up to its answer, in order: understanding the problem, foundations,
// how it is studied, what is known now, the open edge. Each rung is a passage and a one-line "what you'll learn here";
// read in order, the lines are the steps of the climb. How one is made:
//   1. Bart (the writer, at the fastest level he has: Sonnet medium, Luna on Codex; measured 2026-10-08, a draft in about 5 s
//      at medium against 11 s at high, the lines alike) writes a short answer to the sub-question, then picks
//      the rungs from the papers' abstracts and the excerpts of their text nearest the sub-question (climb-text.cjs).
//   2. The gate, in code: each passage must be word for word in its paper's text (climb-text.cjs gatePassage), on one
//      page; no match, no rung. A paper whose text could not be had is never quoted.
//   3. The rungs are put in the climb's order (orderRungs).
//   4. Approval, by the strongest level Bart has (@bart's second step: Opus high, or Sol high on Codex), which reads each
//      passage with the text around it as the paper has it, and records per rung: read in context, says what the line
//      claims, self-contained, assumes only earlier rungs. Then it reads the climb in order as a newcomer, answers the
//      sub-question from the rungs alone, and compares with its own answer. A confusing step is fixed (reordered, bridged,
//      glossed, its line reworded, or dropped) and the climb checked again, MAX_ROUNDS checks at most. The first rung
//      is also checked on its own as soon as it is gated, so something approved is there early.
// Only an approved rung is ever published (`onUpdate`); each keeps a record of its approval: which model, the text it
// read, when, its verdict. What could be read only by title is listed apart, "more reading, not checked".
// Nothing here talks to a model or the disk: `ask(role, message, { onDelta, priority })` does (./climbs.cjs).

const { randomUUID } = require('node:crypto');
const { gatePassage, contextOf, sectionAt, partName, excerptsFor, sentencesIn } = require('./climb-text.cjs');
const { paperLabel } = require('./shelf.cjs');

const STAGES = ['problem', 'foundations', 'methods', 'known', 'open'];
const STAGE_NAMES = { problem: 'understanding the problem', foundations: 'foundations', methods: 'how it is studied', known: 'what is known now', open: 'the open edge' };
const MAX_RUNGS = 5;
const MAX_ROUNDS = 3;
const FIRST_TRIES = 2;
const CHECKS = ['read_in_context', 'says_what_line_claims', 'self_contained', 'assumes_only_earlier'];

const clean = (value, max = 600) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

const WRITER_SYSTEM = `You are Bart, in Engelbart, a research notebook. A researcher has just started a project. For one of its sub-questions you build a climb: the fewest passages from papers that walk a newcomer up to the answer, read in order. Someone who did not know the answer can give it after the last one.

The climb's order, skipping a stage the answer does not need: understanding the problem → foundations → how it is studied → what is known now → the open edge.

Each rung is one passage from one paper and one line, "what you'll learn here". Read in order, the lines are the steps of the climb.
- Copy every passage exactly as it is written in the text you are given: the same words, punctuation and case, nothing left out in the middle, no ellipsis. A passage that is not word for word in the paper is thrown away.
- As short as it can be without losing what it teaches: usually 1 to 3 sentences, rarely a paragraph.
- Self-contained: no "this approach", "these results", "the above", no acronym without what it stands for, no "see Table 2". Never start a passage with a word that points back ("This", "These", "It", "However", "Thus"…) unless it names the paper ("This study…"). Prefer a short passage and a one-line gloss to a longer passage.
- No rung assumes what an earlier rung did not teach: a term or method is explained by an earlier rung, or this rung's gloss explains it. A rung has one gloss: one line, under 30 words, that may explain two terms.
- An abstract is a good first rung.
- A line is plain and short (under 15 words) and says what the passage teaches. It is checked against the passage alone and refused if it claims more: no conclusion the passage does not state, no "shows" for what it only suggests, no detail from elsewhere in the paper. When unsure, say less.
- Use only papers given as quotable. Two to ${MAX_RUNGS} rungs; fewer is better when fewer get there.

Reply with JSON only, no markdown fences.`;

const CHECKER_SYSTEM = `You approve, or refuse, each step of a reading climb before a researcher sees it. A climb is a few passages from papers, each with a one-line "what you'll learn here", that should walk a newcomer up to the answer to one sub-question, read in order. You are the last check: be strict. A passage is approved only when all four hold:
- read_in_context: you read it in the text around it, and cut out there it still means what it means in the paper.
- says_what_line_claims: it says what its line says you will learn, and the line claims no more than it says.
- self_contained: it stands alone, with its gloss if it has one: no "this approach", "these results", "the above" or acronym left unexplained, no "see Table 2".
- assumes_only_earlier: every term or method it relies on is taught by an earlier rung, its own gloss, or plain everyday knowledge.
A fix you offer is short: a line under 15 words that claims only what the passage says, or a gloss. A rung has one gloss line and yours replaces it, so write the whole gloss it needs: one line, under 30 words, every term it must explain (two at most). A rung that needs more than that to pass should be refused without a fix.
Reply with JSON lines only, exactly as asked, no markdown fences.`;

// A passage that opens by pointing at what came before it ("This indicates…", "These principles…", "It…") cannot stand
// alone: refused in code before any model reads it. "This paper", "this study" and the like name the paper: they stand.
const POINTS_BACK = /^(?:this|these|that|those|such|it|its|they|their|them|he|she|his|her|here|there|thus|hence|therefore|however|moreover|furthermore|additionally|also|similarly|likewise|in addition|in contrast|in turn|as a result|on the other hand|the above|the former|the latter)\b(?!\s+(?:paper|study|article|work|review|research|thesis|chapter|book|survey|report|dissertation|essay|project|analysis|experiment|investigation)\b)/i;
/** The words a passage points back with, or '' when it stands on its own start. */
const pointsBackOf = (passage) => { const m = String(passage || '').trim().replace(/^["“(]+/, '').match(POINTS_BACK); return m ? m[0] : ''; };

/** Rungs in the climb's order (STAGES), keeping the writer's order within a stage. */
function orderRungs(rungs) {
  const at = (rung) => { const i = STAGES.indexOf(rung.stage); return i < 0 ? STAGES.length : i; };
  return rungs.map((rung, i) => ({ rung, i })).sort((a, b) => at(a.rung) - at(b.rung) || a.i - b.i).map(({ rung }) => rung);
}

/** The first JSON object in a reply (fences and words around it tolerated) → the object, or null. */
function jsonIn(text) {
  const raw = String(text || '').replace(/```(?:json)?/g, '');
  const from = raw.indexOf('{'), to = raw.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  try { return JSON.parse(raw.slice(from, to + 1)); } catch { return null; }
}

/** What the writer sent → { answer, rungs: [{ stage, paper, passage, line, gloss, part }], more: [id] }. */
function readDraft(text) {
  const value = jsonIn(text) || {};
  const rungs = (Array.isArray(value.rungs) ? value.rungs : []).filter((one) => one && typeof one === 'object').slice(0, MAX_RUNGS + 2).map((one) => ({
    stage: STAGES.includes(one.stage) ? one.stage : 'known',
    paper: clean(one.paper, 40),
    passage: String(one.passage == null ? '' : one.passage).replace(/\s+/g, ' ').trim().slice(0, 2000),
    line: clean(one.line, 200).replace(/^what you['’]ll learn( here)?:\s*/i, ''),
    gloss: clean(one.gloss, 240),
    part: clean(one.part, 60),
  }));
  return { answer: clean(value.answer, 1200), rungs, more: (Array.isArray(value.more) ? value.more : []).map((id) => clean(id, 40)).filter(Boolean).slice(0, 3) };
}

/** The papers a writer is given, as text: each quotable one's abstract and excerpts; those with no text by title only. */
function papersBlock(papers, sub) {
  const quotable = [], unquotable = [];
  for (const paper of papers) {
    const head = `[${paper.id}] ${paperLabel(paper)}. "${clean(paper.title, 300)}"${paper.venue ? ` (${clean(paper.venue, 120)})` : ''}`;
    const excerpts = paper.pages ? excerptsFor(paper, sub) : [];
    if (!paper.abstract && !excerpts.length) { unquotable.push(head); continue; }
    const lines = [head];
    if (paper.abstract) lines.push(`  Abstract: ${paper.abstract}`);
    excerpts.forEach((one, i) => lines.push(`  Excerpt ${i + 1} (page ${one.page}${one.section ? `, ${one.section}` : ''}): ${one.text}`));
    if (!paper.pages) lines.push('  (abstract only: no pdf could be had)');
    quotable.push(lines.join('\n'));
  }
  return { quotable, unquotable };
}

function writerMessage({ sub, question, brief, papers }) {
  const { quotable, unquotable } = papersBlock(papers, `${sub} ${question}`);
  const said = brief ? Object.entries({ 'Working on': brief.working, 'Why': brief.why, 'Least sure about': brief.unsure }).filter(([, v]) => v).map(([k, v]) => `${k}: ${clean(v, 400)}`).join('\n') : '';
  return [
    `Research question: ${clean(question, 300)}`,
    `Sub-question: ${clean(sub, 300)}`,
    said ? `What the researcher said:\n${said}` : '',
    `Papers you may quote (copy passages exactly as written here):\n${quotable.join('\n\n') || '(none)'}`,
    unquotable.length ? `Papers you cannot quote (no text could be had); name up to two under "more" if they are worth reading later:\n${unquotable.join('\n')}` : '',
    `First write a short answer to the sub-question (2 or 3 sentences), from these papers. Then pick the rungs that walk a newcomer up to it.\nJSON: {"answer": "...", "rungs": [{"stage": "problem" | "foundations" | "methods" | "known" | "open", "paper": "W…", "passage": "copied exactly", "line": "what you'll learn here", "gloss": "one line explaining a term or method no earlier rung explains, or empty"}], "more": ["W…"]}`,
  ].filter(Boolean).join('\n\n');
}

function rungBlock(rung, n) {
  return [
    `Rung ${n} · ${STAGE_NAMES[rung.stage] || rung.stage} · ${rung.label} · ${rung.part}${rung.source === 'abstract' ? ' (its abstract)' : ` (page ${rung.page})`}`,
    `  Line (what you'll learn here): ${rung.line}`,
    rung.gloss ? `  Gloss: ${rung.gloss}` : '  Gloss: (none)',
    `  Passage: "${rung.passage}"`,
    `  The text around it, as the paper has it («» marks the passage):\n${rung.context}`,
  ].join('\n');
}

const VERDICT_SHAPE = '{"rung": n, "read_in_context": true|false, "says_what_line_claims": true|false, "self_contained": true|false, "assumes_only_earlier": true|false, "why": "one short sentence", "fix": null | {"line": "a new line, or omit", "gloss": "a one-line gloss, or omit"}}';

/** The approving model's message: every rung (or the first alone, `firstOnly`), and the newcomer check after them. */
function checkerMessage({ sub, rungs, firstOnly = false }) {
  const list = (firstOnly ? rungs.slice(0, 1) : rungs).map((rung, i) => rungBlock(rung, i + 1)).join('\n\n');
  const head = `Sub-question: ${clean(sub, 300)}\n\n${firstOnly ? 'The first rung of its climb' : 'Its climb, in order'}:\n\n${list}`;
  if (firstOnly) return `${head}\n\nWrite one line of JSON for rung 1, nothing else:\n${VERDICT_SHAPE}\nfix: when a check fails and a reworded line or a one-line gloss would make it pass, give them; else null.`;
  return `${head}\n\nWrite, one per line, nothing else:\n1. For each rung in order, one line of JSON: ${VERDICT_SHAPE}\n   fix: when a check fails and a reworded line or a one-line gloss would make it pass, give them; else null.\n2. Then one last line of JSON, the newcomer check: first your own short answer to the sub-question; then read only the rungs' lines, glosses and passages in order as a newcomer who knew nothing of this, and answer the sub-question from them alone; then compare.\n{"newcomer": true, "own_answer": "...", "newcomer_answer": "...", "same": true|false, "confusing": [{"rung": n, "problem": "...", "fix": "reorder" | "bridge" | "gloss" | "line" | "drop", "move_to": n, "gloss": "...", "line": "..."}]}\n   same: the newcomer's answer gets the substance of yours. confusing: every step a newcomer would stumble on, with its fix ("bridge" and "gloss" give the one-line gloss, "line" the new line, "reorder" where it goes); [] when none.`;
}

/** The JSON lines of a check's reply so far → { verdicts: Map(n → verdict), newcomer | null }. A half-written line is not read. */
function readCheck(text, { complete = true } = {}) {
  const verdicts = new Map();
  let newcomer = null;
  const lines = String(text || '').split('\n');
  if (!complete) lines.pop();
  for (const raw of lines) {
    const line = raw.trim().replace(/^[-*\d.)\s]+(?=\{)/, '');
    if (!line.startsWith('{')) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object') continue;
    if (value.newcomer) { newcomer = value; continue; }
    const n = Number(value.rung);
    if (Number.isInteger(n) && n > 0 && !verdicts.has(n)) verdicts.set(n, value);
  }
  return { verdicts, newcomer };
}

const passes = (verdict) => !!verdict && CHECKS.every((key) => verdict[key] === true);

/** A rung's fix from its verdict and the newcomer's list, applied → the rung (changed or not), or null when it is dropped. */
// A fix is taken only when it is as short as a line or a gloss may be: a longer one is no fix.
const MAX_LINE = 140, MAX_GLOSS = 220;
const short = (value, max) => { const text = clean(value, 1000); return text && text.length <= max ? text : ''; };
function fixRung(rung, verdict, confusing) {
  let next = rung, changed = false;
  const fix = verdict && verdict.fix && typeof verdict.fix === 'object' ? verdict.fix : null;
  if (fix && short(fix.line, MAX_LINE)) { next = { ...next, line: short(fix.line, MAX_LINE) }; changed = true; }
  if (fix && short(fix.gloss, MAX_GLOSS)) { next = { ...next, gloss: short(fix.gloss, MAX_GLOSS) }; changed = true; }
  for (const one of confusing) {
    if (one.fix === 'drop') return null;
    if ((one.fix === 'gloss' || one.fix === 'bridge') && short(one.gloss, MAX_GLOSS)) { next = { ...next, gloss: short(one.gloss, MAX_GLOSS) }; changed = true; }
    if (one.fix === 'line' && short(one.line, MAX_LINE)) { next = { ...next, line: short(one.line, MAX_LINE) }; changed = true; }
  }
  if (verdict && !passes(verdict) && !changed) return null; // failed with nothing that would make it pass
  return next;
}

/** The climb after a check: fixes applied, dropped rungs gone, moves made. → { rungs, changed } */
function applyFixes(rungs, verdicts, newcomer) {
  const confusing = newcomer && Array.isArray(newcomer.confusing) ? newcomer.confusing.filter((one) => one && Number.isInteger(Number(one.rung))) : [];
  let changed = false;
  const kept = [];
  rungs.forEach((rung, i) => {
    const mine = confusing.filter((one) => Number(one.rung) === i + 1);
    const next = fixRung(rung, verdicts.get(i + 1), mine);
    if (next !== rung) changed = true;
    if (next) kept.push({ rung: next, move: mine.find((one) => one.fix === 'reorder' && Number.isInteger(Number(one.move_to))) });
  });
  const out = kept.map((one) => one.rung);
  for (const one of kept) {
    if (!one.move) continue;
    const from = out.indexOf(one.rung), to = Math.max(0, Math.min(out.length - 1, Number(one.move.move_to) - 1));
    if (from >= 0 && from !== to) { out.splice(to, 0, out.splice(from, 1)[0]); changed = true; }
  }
  return { rungs: out, changed };
}

/** A gated rung as published: what the page shows, what opens it, and the record of its approval. */
function published(rung, verdict, by, at, round) {
  return {
    id: rung.id, kind: 'paper', stage: rung.stage, label: rung.label, part: rung.part, line: rung.line, gloss: rung.gloss || '',
    passage: rung.passage, paper: rung.paper, source: rung.source, page: rung.page,
    anchor: { source: rung.source, page: rung.page, start: rung.start, end: rung.end, find: rung.find, occurrences: rung.occurrences },
    sentences: rung.sentences, chars: rung.passage.length,
    approval: { provider: by.provider, model: by.model, effort: by.effort, at, round, read: { passage: rung.passage, context: rung.context }, verdict: { ...Object.fromEntries(CHECKS.map((key) => [key, verdict[key] === true])), why: clean(verdict.why, 300) } },
  };
}

/**
 * One climb. `sub`: the sub-question; `question`: the research question; `brief`: their answers; `papers`: what the
 * shelf has of each candidate ({ id, title, authors, year, venue, doi, abstract, pages }). `ask(role, message, options)` →
 * { text, by: { provider, model, effort } }. `onUpdate(climb)`: every change worth showing, approved rungs only.
 * → the climb: { question, status, step, answer, rungs, pending, more, failures, newcomer, rounds }.
 */
async function buildClimb({ sub, question, brief = null, papers, ask, onUpdate = () => {}, cancelled = () => false, now = () => new Date().toISOString() }) {
  const byId = new Map(papers.map((paper) => [paper.id, paper]));
  const climb = { question: sub, status: 'writing', step: 'finding', answer: '', rungs: [], pending: 0, more: [], failures: [], newcomer: null, rounds: 0, checks: [] };
  // Every check, in the order they ended: which rungs it approved, and for each it refused, which test failed and why.
  const began = Date.now();
  const logCheck = (kind, round, list, verdicts, by) => {
    const refused = [];
    list.forEach((rung, i) => {
      const verdict = verdicts.get(i + 1);
      if (!passes(verdict)) refused.push({ rung: i + 1, line: rung.line, failed: verdict ? CHECKS.filter((key) => verdict[key] !== true) : ['no verdict'], why: clean(verdict && verdict.why, 300) });
    });
    climb.checks.push({ kind, round, ms: Date.now() - began, rungs: list.length, approved: list.length - refused.length, refused, by: by ? `${by.model} ${by.effort}` : null });
  };
  const tell = () => { if (!cancelled()) onUpdate({ ...climb, rungs: climb.rungs.slice() }); };
  tell();
  if (!papers.some((paper) => paper.abstract || (paper.pages && paper.pages.length))) { climb.status = 'done'; climb.step = 'done'; tell(); return climb; }

  // 1. Bart's draft. 2. The gate, in code: a draft none of whose passages passes is written once more, told why each failed.
  const gated = [];
  let draft = null;
  for (let attempt = 0; attempt < 2 && !gated.length; attempt += 1) {
    const refused = climb.failures.slice();
    const message = writerMessage({ sub, question, brief, papers }) + (refused.length ? `\n\nYour last draft's passages were all refused, in code:\n${refused.map((one) => `- [${one.paper}] "${one.passage.slice(0, 160)}": ${one.why}`).join('\n')}\nPick passages that are word for word in the text given and that do not start by pointing back.` : '');
    draft = readDraft((await ask('writer', message, { priority: 1 })).text);
    if (cancelled()) return climb;
    for (const one of draft.rungs) {
      const paper = byId.get(one.paper);
      const pointsBack = pointsBackOf(one.passage);
      const gate = !paper ? { ok: false, why: 'not one of the papers given' } : pointsBack ? { ok: false, why: `starts by pointing back ("${pointsBack}")` } : gatePassage(one.passage, paper);
      if (!gate.ok) { climb.failures.push({ paper: one.paper, passage: one.passage.slice(0, 400), why: gate.why, draft: attempt + 1 }); continue; }
      const part = gate.source === 'abstract' ? 'Abstract' : partName(sectionAt(paper.pages, gate.page, gate.start)) || one.part || `p. ${gate.page}`;
      gated.push({ id: randomUUID(), stage: one.stage, line: one.line, gloss: one.gloss, passage: one.passage, part, label: paperLabel(paper), paper: { id: paper.id, title: paper.title, authors: paper.authors, year: paper.year, venue: paper.venue, doi: paper.doi }, source: gate.source, page: gate.page, start: gate.start, end: gate.end, find: gate.find, occurrences: gate.occurrences, sentences: gate.sentences || sentencesIn(one.passage), context: contextOf(paper, gate) });
    }
    if (!draft.rungs.length) break; // nothing drafted at all: nothing to tell it
  }
  climb.answer = draft.answer;
  climb.more = draft.more.map((id) => byId.get(id)).filter((paper) => paper && !paper.abstract && !paper.pages).map((paper) => ({ id: paper.id, label: paperLabel(paper), title: paper.title, url: paper.doi ? `https://doi.org/${paper.doi}` : `https://openalex.org/${paper.id}` }));

  // 3. The climb's order.
  let rungs = orderRungs(gated).slice(0, MAX_RUNGS);
  climb.status = 'checking'; climb.step = 'checking'; climb.pending = rungs.length;
  tell();
  if (!rungs.length) { climb.status = 'done'; climb.step = 'done'; climb.pending = 0; tell(); return climb; }

  // 4. Approval.
  const approved = new Map(); // rung id → its published form
  const show = (list) => {
    // What is shown: the climb's rungs in order, up to the first not approved (a later one may lean on it).
    const out = [];
    for (const rung of list) { const one = approved.get(rung.id); if (!one) break; out.push(one); }
    climb.rungs = out;
    climb.pending = Math.max(0, list.length - out.length);
    tell();
  };
  // The first rung on its own first (about ten seconds at Opus high, measured 2026-10-08), so something approved is up
  // soon: refused with a fix, the fixed rung is checked at once; refused again (or with no fix), it is dropped and the
  // next rung is tried the same way, FIRST_TRIES checks in all. Then the whole climb's rounds, with what stood.
  for (let tries = 0; tries < FIRST_TRIES && rungs.length && !cancelled(); tries += 1) {
    const rung = rungs[0];
    let reply;
    try { reply = await ask('checker', checkerMessage({ sub, rungs: [rung], firstOnly: true }), { priority: 0 }); } catch { break; }
    if (cancelled()) return climb;
    const verdicts = readCheck(reply.text).verdicts, verdict = verdicts.get(1);
    logCheck('first', 0, [rung], verdicts, reply.by);
    if (passes(verdict)) { approved.set(rung.id, published(rung, verdict, reply.by, now(), 0)); show(rungs); break; }
    const fixed = fixRung(rung, verdict, []);
    rungs = fixed && fixed !== rung ? [{ ...fixed, id: randomUUID() }, ...rungs.slice(1)] : rungs.slice(1);
    show(rungs);
  }

  // The climb that stands is one checked whole: the last list a round read, up to its first rung not approved.
  let checked = null;
  for (let round = 1; round <= MAX_ROUNDS && rungs.length && !cancelled(); round += 1) {
    const list = rungs;
    let by = null, shown = 0;
    // Verdicts as they arrive: each approved rung is shown once those before it are.
    const streamed = (so) => {
      if (!by) return;
      const { verdicts } = readCheck(so, { complete: false });
      let moved = false;
      for (let n = shown + 1; verdicts.has(n); n += 1) {
        const rung = list[n - 1];
        if (rung && passes(verdicts.get(n)) && !approved.has(rung.id)) { approved.set(rung.id, published(rung, verdicts.get(n), by, now(), round)); moved = true; }
        shown = n;
      }
      if (moved && rungs === list) show(list);
    };
    let reply;
    try {
      reply = await ask('checker', checkerMessage({ sub, rungs: list }), { priority: 2, onDelta: streamed, onBy: (who) => { by = who; } });
    } catch { break; }
    if (cancelled()) return climb;
    climb.rounds = round;
    const { verdicts, newcomer } = readCheck(reply.text);
    logCheck('climb', round, list, verdicts, reply.by);
    // This round's verdicts are the record: a rung approved before and refused now is taken back.
    for (const [i, rung] of list.entries()) {
      const verdict = verdicts.get(i + 1);
      if (passes(verdict)) approved.set(rung.id, published(rung, verdict, reply.by, now(), round)); else approved.delete(rung.id);
    }
    checked = list;
    const confusing = newcomer && Array.isArray(newcomer.confusing) ? newcomer.confusing : [];
    climb.newcomer = {
      passed: !!newcomer && newcomer.same === true && !confusing.length && list.every((rung) => approved.has(rung.id)),
      own: clean(newcomer && newcomer.own_answer, 1200), newcomer: clean(newcomer && newcomer.newcomer_answer, 1200), same: !!newcomer && newcomer.same === true,
      confusing: confusing.slice(0, 8).map((one) => ({ rung: Number(one && one.rung) || null, problem: clean(one && one.problem, 300), fix: clean(one && one.fix, 20) })),
      round, at: now(), by: reply.by, ...(newcomer ? {} : { unread: true }),
    };
    if (climb.newcomer.passed) break;
    const fixed = applyFixes(list, verdicts, newcomer);
    if (!fixed.changed) break; // nothing a check could pass: what was approved stands
    if (round === MAX_ROUNDS) break; // the fixed climb was never checked whole: the last checked one stands
    // A rung changed by a fix is a new rung: approved again before it is shown.
    rungs = fixed.rungs.map((rung) => (list.includes(rung) ? rung : { ...rung, id: randomUUID() }));
    show(rungs);
  }
  if (cancelled()) return climb;
  rungs = checked || rungs;
  show(rungs);
  climb.pending = 0;
  climb.status = 'done'; climb.step = 'done';
  tell();
  return climb;
}

module.exports = { pointsBackOf, STAGES, STAGE_NAMES, CHECKS, MAX_RUNGS, MAX_ROUNDS, WRITER_SYSTEM, CHECKER_SYSTEM, orderRungs, readDraft, writerMessage, checkerMessage, readCheck, passes, applyFixes, buildClimb, jsonIn };
