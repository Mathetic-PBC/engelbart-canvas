// The climbs, with real models (onboarding build 2, 2026-10-08): research questions run through what onboarding does
// (src/main/bart/onboard.cjs, climbs.cjs) — the searches after the cards, the papers read, the plan's sub-questions,
// a climb for each drafted, gated in code and approved — and, per climb, what came of it: the newcomer check's result,
// how many rungs, how long each passage is, and every passage the exact-match gate refused. Run by hand; not part of
// npm test. It uses your Claude Code (or Codex) sign-in, as @bart does, and OpenAlex with your key when there is one.
//
//   node scripts/eval-climbs.mjs                      all the questions
//   node scripts/eval-climbs.mjs --only 2             the first two
//   node scripts/eval-climbs.mjs --from 3 --only 2    the third and fourth
//   node scripts/eval-climbs.mjs --provider openai    on Codex
//   node scripts/eval-climbs.mjs --out report.json    the full report (every rung, its record) written there too
//
// Papers are kept between runs in $TMPDIR/engelbart-eval-papers (--papers DIR to choose), so a second run reads none again.
// OpenAlex without a key has a small daily budget shared by everyone on your network's address (about ten questions' worth;
// it answers 429 once it is spent, until midnight UTC, and onboarding's searches in the app go without too). With
// OPENALEX_API_KEY set, or ~/.engelbart/config.json's openalex.apiKey, the run uses that key instead (papers.cjs openAlexKey).
// Since 2026-10-08 the cards are "working" and "why" ("What would this make possible?") and the question they settle on;
// each climb's pick (which papers the approving model chose to read, and why the rest were refused) is printed too.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { createOnboard } = require('../src/main/bart/onboard.cjs');
const { createClimbs, readClimbs } = require('../src/main/bart/climbs.cjs');
const { createShelf } = require('../src/main/bart/shelf.cjs');
const { createPapers } = require('../src/main/bart/papers.cjs');
const { normalizeModels, DEFAULT_MODELS } = require('../src/main/bart/models.cjs');

const QUESTIONS = [
  { working: 'how what students do in an AI-assisted programming course relates to what they can do later on their own', why: 'instructors could tell which habits to encourage', question: 'Which behaviors predict learning transfer?' },
  { working: 'novice programmers asking an AI tutor for help', why: 'tutors could hold back help until it is useful', question: 'Does help-seeking from AI tutors reduce what novice programmers learn?' },
  { working: 'how teachers manage small-group work in middle school classrooms', why: 'new teachers would know when to step in', question: 'How do teachers decide when to intervene in student group work?' },
  { working: 'worked examples in introductory programming', why: 'course designers could use them where they help', question: 'What makes worked examples effective for learning to program?' },
  { working: 'retrieval practice in university science courses', why: 'lecturers could use quizzes for deep understanding', question: 'Do retrieval practice benefits hold for complex, conceptual material?' },
  { working: 'feedback in large online courses', why: 'platforms could time feedback better', question: 'How does feedback timing affect learning in online courses?' },
];

const args = process.argv.slice(2);
const flag = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : null; };
const only = Number(flag('--only')) || QUESTIONS.length;
const from = Math.max(0, (Number(flag('--from')) || 1) - 1);
const provider = flag('--provider') || 'anthropic';
const out = flag('--out');
const papersDir = flag('--papers') || path.join(os.tmpdir(), 'engelbart-eval-papers');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-eval-climbs-'));

const readModels = () => ({ ...normalizeModels(DEFAULT_MODELS), provider });
const papers = createPapers();
const shelf = createShelf({ dir: papersDir, papers });
const sessionOptions = { runDirectory: path.join(scratch, 'runs'), codexHome: path.join(scratch, 'codex-home') };
const climbs = createClimbs({ readModels, shelf, papers, sessionOptions });
const onboard = createOnboard({ readModels, papers, climbs, sessionOptions });

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const say = (line) => process.stdout.write(`${line}\n`);

say(`Climbs eval: ${only} question(s) on ${provider === 'openai' ? 'Codex' : 'Claude Code'}; writer ${climbs.stepOf('writer').name} ${climbs.stepOf('writer').effort}, approval ${climbs.stepOf('checker').name} ${climbs.stepOf('checker').effort}. Papers in ${papersDir}.`);

const report = [];
for (const answers of QUESTIONS.slice(from, from + only)) {
  const question = answers.question;
  say(`\n=== ${question}`);
  const began = Date.now();
  const { id } = onboard.open();
  // The cards, as a person would answer them: the searches run after each, and the best papers are read.
  for (const card of ['working', 'why']) await onboard.answer(id, { card, answers });
  await onboard.settled(id);
  const found = onboard.candidates(id);
  say(`  searches: ${found.searches.length}, papers found: ${found.papers.length} (${seconds(Date.now() - began)})`);
  const refused = found.searches.find((one) => one.error);
  if (refused && !found.papers.length) say(`  OpenAlex: ${refused.error}`);
  // The plan: its sub-questions start their climbs at once.
  const planAt = Date.now();
  const plan = await onboard.plan(id, { answers, sentence: `I'm working on ${answers.working} so that ${answers.why}.` });
  say(`  plan (${seconds(Date.now() - planAt)}): ${plan.question}${plan.fallback ? ' [from their words]' : ''}`);
  plan.starts.forEach((start, i) => say(`    ${i + 1}. ${start}`));
  // The project: a folder of its own; the climbs are written there.
  const projectDir = path.join(scratch, randomUUID());
  fs.mkdirSync(projectDir);
  const starts = plan.starts.map((text) => ({ id: randomUUID(), text }));
  const firstSeen = new Map();
  const watch = setInterval(() => {
    const kept = readClimbs(projectDir).starts;
    for (const start of starts) if (!firstSeen.has(start.id) && kept[start.id] && kept[start.id].rungs.length) firstSeen.set(start.id, Date.now() - planAt);
  }, 200);
  onboard.attach(id, projectDir, { projectId: 'eval', workspaceId: 'eval', starts, question: plan.question, brief: answers });
  await climbs.settled();
  clearInterval(watch);
  const kept = readClimbs(projectDir).starts;
  const climbsOut = [];
  for (const start of starts) {
    const climb = kept[start.id] || { rungs: [], failures: [], newcomer: null };
    const paper = climb.rungs.filter((rung) => rung.kind === 'paper');
    const lengths = paper.map((rung) => `${rung.chars}c/${rung.sentences}s`);
    const newcomer = climb.newcomer ? (climb.newcomer.passed ? `passed (round ${climb.newcomer.round})` : `not passed after ${climb.newcomer.round} round(s)${climb.newcomer.confusing.length ? `: ${climb.newcomer.confusing.map((one) => `rung ${one.rung} ${one.fix}`).join(', ')}` : ''}`) : 'not run';
    say(`\n  ${start.text}`);
    say(`    newcomer check: ${newcomer}`);
    say(`    rungs: ${climb.rungs.length}${climb.fallback ? ` (fallback: ${climb.fallback})` : ''}; first approved ${firstSeen.has(start.id) ? seconds(firstSeen.get(start.id)) : '—'} after the plan`);
    say(`    passage lengths: ${lengths.join(', ') || '—'}`);
    if (climb.pick) say(`    picked (${climb.pick.by || 'code, no model'}): ${climb.pick.picked.map((one) => `${one.paper} (${one.why})`).join('; ') || '—'}; refused ${climb.pick.refused.length}`);
    if (climb.timing) say(`    timing from its start: papers read ${climb.timing.read != null ? seconds(climb.timing.read) : '—'}, drafted ${climb.timing.drafted != null ? seconds(climb.timing.drafted) : '—'}, first approved ${climb.timing.firstApproved != null ? seconds(climb.timing.firstApproved) : '—'}, done ${seconds(climb.timing.done || 0)}`);
    for (const rung of climb.rungs) say(`      · ${rung.kind === 'action' ? rung.title : `${rung.label} · ${rung.part}`} — ${rung.line}${rung.gloss ? ` [gloss: ${rung.gloss}]` : ''}`);
    for (const check of climb.checks || []) say(`    check ${check.kind === 'first' ? 'first rung' : `round ${check.round}`} at ${seconds(check.ms)}: ${check.approved}/${check.rungs} approved${check.refused.map((one) => `; refused ${one.rung} (${one.failed.join(', ')}): ${one.why}`).join('')}`);
    say(`    exact-match failures: ${(climb.failures || []).length}`);
    for (const failure of climb.failures || []) say(`      ✗ ${failure.paper}: ${failure.why} — "${failure.passage.slice(0, 120)}${failure.passage.length > 120 ? '…' : ''}"`);
    if (climb.newcomer && !climb.newcomer.passed) say(`    own answer: ${climb.newcomer.own}\n    newcomer's: ${climb.newcomer.newcomer}`);
    climbsOut.push({ sub: start.text, newcomer: climb.newcomer, rungs: climb.rungs.length, lengths: paper.map((rung) => ({ chars: rung.chars, sentences: rung.sentences })), failures: climb.failures || [], fallback: climb.fallback || null, firstApprovedMs: firstSeen.get(start.id) || null, climb });
  }
  say(`\n  total ${seconds(Date.now() - began)}`);
  report.push({ question, plan, climbs: climbsOut, ms: Date.now() - began });
}

const all = report.flatMap((one) => one.climbs);
const passed = all.filter((one) => one.newcomer && one.newcomer.passed).length;
const failures = all.reduce((n, one) => n + one.failures.length, 0);
const lengths = all.flatMap((one) => one.lengths.map((length) => length.chars));
say(`\n=== Summary: ${all.length} climbs; newcomer check passed ${passed}/${all.length}; rungs ${all.map((one) => one.rungs).join(', ')}; passages ${lengths.length ? `${Math.min(...lengths)}–${Math.max(...lengths)} chars (median ${lengths.sort((a, b) => a - b)[Math.floor(lengths.length / 2)]})` : '—'}; exact-match failures ${failures}; fallbacks ${all.filter((one) => one.fallback).map((one) => one.fallback).join(', ') || 'none'}.`);
if (out) { fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); say(`Report: ${out}`); }
climbs.stopAll();
onboard.closeAll();
fs.rmSync(scratch, { recursive: true, force: true });
