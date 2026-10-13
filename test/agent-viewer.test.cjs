'use strict';

// The Agent Viewer's asks (2026-10-12; src/main/agent-map/asks.cjs, src/renderer/agent-map/runText.js,
// src/renderer/model/askLine.js, src/renderer/screens/AgentMap.jsx): the run log's records grouped one entry per ask, the
// place each was typed kept on its records, the line a click finds, the list, the four sections and the export.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { createFakeBart } = require('../src/main/bart/ask.cjs');
const { createFakeRouter } = require('../src/main/bart/route.cjs');
const { createRunLog } = require('../src/main/bart/runlog.cjs');
const { groupAsks, askOf } = require('../src/main/agent-map/asks.cjs');
const { revealTarget } = require('../src/main/agent-map/ipc.cjs');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `engelbart-viewer-${name}-`));

function compile(entry, name) {
  const filename = path.join(__dirname, `__${name}.cjs`);
  const built = buildSync({ entryPoints: [path.join(__dirname, '..', entry)], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'] });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  const previousWindow = global.window;
  global.window = { engelbartAPI: {} };
  try { compiled._compile(built.outputFiles[0].text, filename); } finally { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; }
  return compiled.exports;
}

const PLACE = (line, text) => ({ projectId: 'p', ref: { kind: 'workspace', workspaceId: 'w' }, line, text });

/** A log's records, each as runLog.list() gives them. */
const RECORDS = [
  // An @bart line Chat answered.
  { id: 'route-1', agent: 'router', at: 100, status: 'done', question: 'why is the sky blue?', pick: 'chat', place: PLACE(3, '@bart why is the sky blue?') },
  { id: 'a-1', agent: 'bart', at: 101, status: 'done', question: 'why is the sky blue?', routedFrom: 'route-1', place: PLACE(3, '@bart why is the sky blue?') },
  // An @bart line handed to a Build: its two turns and the run step.
  { id: 'route-2', agent: 'router', at: 200, status: 'done', question: 'build a parser', pick: 'build', handedTo: 'build:b2', place: PLACE(9, '@bart build a parser') },
  { id: 'b2:1', agent: 'build', buildId: 'b2', turn: 1, at: 201, status: 'done', title: 'Parser', place: PLACE(9, '@bart build a parser') },
  { id: 'b2:run:1', agent: 'run step', buildId: 'b2', turn: 1, at: 202, status: 'done' },
  { id: 'b2:2', agent: 'build', buildId: 'b2', turn: 2, at: 203, status: 'running' },
  // @discover typed directly.
  { id: 'a-3', agent: 'discover', at: 300, status: 'done', question: 'papers on X', place: PLACE(12, '@discover papers on X') },
  // A Build from a line's Build button, and one from the panel.
  { id: 'b4:1', agent: 'build', buildId: 'b4', turn: 1, at: 400, status: 'done', title: 'Thing', place: PLACE(20, 'make the thing') },
  { id: 'b5:1', agent: 'build', buildId: 'b5', turn: 1, at: 500, status: 'done', title: 'From the panel', place: { projectId: 'p', ref: { kind: 'workspace', workspaceId: 'w' } } },
  // A follow-up to the Chat answer: an ask of its own.
  { id: 'a-6', agent: 'bart', at: 600, status: 'done', question: 'and at sunset?', place: PLACE(5, '@chat and at sunset?') },
  // Create, and an agent the Viewer does not know.
  { id: 'a-7', agent: 'create', at: 700, status: 'done', question: 'a figure', place: PLACE(30, '@create a figure') },
  { id: 'a-8', agent: 'mystery', at: 800, status: 'failed', question: 'who?' },
  // A post-it's quick Build.
  { id: 'b9:1', agent: 'build', buildId: 'b9', kind: 'quick', turn: 1, at: 900, status: 'done', title: 'fix the typo', place: { projectId: 'p', ref: { kind: 'workspace', workspaceId: 'w' } } },
];

/* ------------------------------------------------------------- grouping */

test('asks: one entry per ask, newest first, no record left out', () => {
  const asks = groupAsks(RECORDS);
  assert.deepEqual(asks.map((ask) => ask.id), ['build:b9', 'a-8', 'a-7', 'a-6', 'build:b5', 'build:b4', 'a-3', 'route-2', 'route-1']);
  const claimed = asks.flatMap((ask) => ask.records);
  assert.deepEqual([...claimed].sort(), RECORDS.map((record) => record.id).sort(), 'every record is in exactly one entry');
  assert.equal(new Set(claimed).size, claimed.length);
});

test('asks: an @bart line and the run the router handed it to are one entry', () => {
  const ask = groupAsks(RECORDS).find((held) => held.id === 'route-1');
  assert.deepEqual([ask.records, ask.routedTo, ask.via, ask.kind, ask.text, ask.place.line], [['route-1', 'a-1'], 'chat', 'router', 'question', '@bart why is the sky blue?', 3]);
});

test('asks: an @bart line handed to a Build is one entry with every turn and run step, running while a turn runs', () => {
  const ask = groupAsks(RECORDS).find((held) => held.id === 'route-2');
  assert.deepEqual([ask.records, ask.routedTo, ask.kind, ask.buildId, ask.status], [['route-2', 'b2:1', 'b2:run:1', 'b2:2'], 'build', 'build', 'b2', 'running']);
});

test('asks: a line asked directly, a Build from a line, the panel, a post-it, a follow-up, Create and an unknown agent', () => {
  const asks = Object.fromEntries(groupAsks(RECORDS).map((ask) => [ask.id, ask]));
  assert.deepEqual([asks['a-3'].routedTo, asks['a-3'].via, asks['a-3'].text], ['discover', 'direct', '@discover papers on X']);
  assert.deepEqual([asks['build:b4'].via, asks['build:b4'].text, asks['build:b4'].kind], ['button', 'make the thing', 'build']);
  assert.deepEqual([asks['build:b5'].via, asks['build:b5'].text, asks['build:b5'].place.line], ['panel', 'From the panel', undefined]);
  assert.deepEqual([asks['build:b9'].via, asks['build:b9'].text], ['post-it', 'fix the typo']);
  assert.deepEqual([asks['a-6'].routedTo, asks['a-6'].records], ['chat', ['a-6']], 'a follow-up is its own entry');
  assert.deepEqual([asks['a-7'].routedTo, asks['a-7'].kind], ['create', 'question']);
  assert.deepEqual([asks['a-8'].routedTo, asks['a-8'].status, asks['a-8'].text, asks['a-8'].place], ['mystery', 'failed', 'who?', null]);
});

test('asks: a line typed with --build reads so', () => {
  const [ask] = groupAsks([{ id: 'b:1', agent: 'build', buildId: 'b', turn: 1, at: 1, status: 'done', place: PLACE(0, 'make it --build') }]);
  assert.equal(ask.via, '--build');
});

test('askOf: an entry with its records whole, null once gone', () => {
  const log = createRunLog();
  for (const record of RECORDS.slice(0, 2)) log.start({ ...record, steps: [] });
  const ask = askOf(log, 'route-1');
  assert.deepEqual(ask.records.map((record) => record.agent), ['router', 'bart']);
  assert.equal(askOf(log, 'nope'), null);
});

/* ------------------------------------------------------------- place stored */

const homeDir = tmp('home');
const layout = ensureHome(homeDir);
let ctx, project, workspace;
test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, { name: 'Viewed', directory: tmp('code') });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Asks' });
});
test.after(async () => { await db.closeAll(); });

test('place: an ask and the router keep where the line was typed on their records; an ask with none keeps none', async () => {
  const log = createRunLog();
  const router = createFakeRouter({ runLog: log });
  const place = { projectId: project.id, ref: { kind: 'workspace', workspaceId: workspace.id }, line: 4, text: '@bart why?' };
  const routed = await router.route({ projectId: project.id, text: 'why?', place });
  assert.deepEqual(log.get(routed.id).place, place);

  const bart = createFakeBart({ readModels: () => normalizeModels(null), delayMs: 0, runLog: log });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await bart.ask(ctx, project.id, { askId: 'v1', ref, workspaceId: workspace.id, text: 'why?', routed: { id: routed.id }, place });
  await bart.ask(ctx, project.id, { askId: 'v2', ref, workspaceId: workspace.id, text: 'no place' });
  await log.flush();
  const withPlace = log.list().find((record) => record.agent === 'bart' && record.question === 'why?');
  assert.deepEqual(withPlace.place, place);
  assert.equal(log.list().find((record) => record.question === 'no place').place, undefined);
});

test('revealTarget: keeps a click\'s place and drops what is not one', () => {
  const target = revealTarget({ place: { projectId: 'p', ref: { kind: 'note', id: 'n1', extra: 'x' }, line: 7, text: '@bart hi' }, routedTo: 'chat', buildId: null });
  assert.deepEqual(target, { place: { projectId: 'p', ref: { kind: 'note', id: 'n1' }, line: 7, text: '@bart hi', quote: null }, routedTo: 'chat', buildId: null });
  assert.equal(revealTarget({ place: { ref: { kind: 'note', id: 'n1' } } }), null, 'no project, nothing to reveal');
  assert.equal(revealTarget('p'), null);
  assert.deepEqual(revealTarget({ place: { projectId: 'p', ref: { kind: 'shell' }, line: -2 } }).place, { projectId: 'p', ref: null, line: null, text: null, quote: null });
});

/* ------------------------------------------------------------- the line a click finds */

const askLine = compile('src/renderer/model/askLine.js', 'ask-line');

test('reveal: the line as typed, or with @bart swapped for the routed token, the nearest to where it was', () => {
  const { findAskLine, askLineTexts } = askLine;
  assert.deepEqual(askLineTexts('@bart papers on X', 'discover'), ['@bart papers on X', '@discover papers on X']);
  // Bart handed the line to @discover, and three lines were written above it since.
  const lines = ['# Plan', 'new', 'new', 'new', 'intro', '@discover papers on X', 'bart> found three'];
  assert.equal(findAskLine(lines, { text: '@bart papers on X', line: 2, routedTo: 'discover' }), 5);
  // The same line twice: the one nearest.
  const twice = ['@chat why?', 'a', 'b', 'c', 'd', '@chat why?'];
  assert.equal(findAskLine(twice, { text: '@bart why?', line: 4, routedTo: 'chat' }), 5);
  assert.equal(findAskLine(twice, { text: '@bart why?', line: 1, routedTo: 'chat' }), 0);
  // Gone.
  assert.equal(findAskLine(['# Plan', 'other'], { text: '@bart why?', line: 1, routedTo: 'chat' }), -1);
  assert.equal(findAskLine(['x'], { text: '' }), -1);
});

test('reveal: a Build with no line of its own is found by its card', () => {
  const { findBuildLine } = askLine;
  const { buildLine } = compile('src/renderer/model/doc.js', 'doc-for-viewer');
  assert.equal(findBuildLine(['a', buildLine('b5'), 'c'], 'b5'), 1);
  assert.equal(findBuildLine(['a'], 'b5'), -1);
});

/* ------------------------------------------------------------- the list, the sections, the export */

const view = compile('src/renderer/screens/AgentMap.jsx', 'agent-viewer');
const runText = compile('src/renderer/agent-map/runText.js', 'run-text-viewer');

test('list: only the line and its time, a dot while running, and All | Questions | Builds', () => {
  const now = new Date(2026, 9, 12, 18, 0).getTime();
  const at = new Date(2026, 9, 12, 9, 5).getTime();
  const asks = groupAsks(RECORDS).map((ask) => ({ ...ask, at }));
  asks.push({ id: 'pic', at, text: '![shot](x.png)', status: 'done', kind: 'question', records: [] });
  const render = (filter) => renderToStaticMarkup(React.createElement(view.AskList, { asks, selected: null, filter, onSelect() {}, onFilter() {}, now }));
  const all = render('all');
  assert.match(all, />All</);
  assert.match(all, />Questions</);
  assert.match(all, />Builds</);
  assert.match(all, /@bart why is the sky blue\?<\/span><span[^>]*>09:05</);
  assert.match(all, />—</, 'a line of only a picture reads —');
  assert.doesNotMatch(all, /Viewed|Sonnet|claude-|Chat|Discover/, 'no project, model or agent in the list');
  assert.equal((all.match(/●/g) || []).length, 1, 'one ask runs');
  const builds = render('builds');
  assert.match(builds, /build a parser/);
  assert.doesNotMatch(builds, /sky blue/);
  const questions = render('questions');
  assert.match(questions, /sky blue/);
  assert.doesNotMatch(questions, /build a parser|make the thing/);
  assert.equal(runText.askTime(new Date(2026, 9, 11, 9, 5).getTime(), now), '2026-10-11', 'another day shows its date');
});

const step = (output) => ({ model: 'claude-sonnet-5-5', name: 'Sonnet', effort: 'high', input: 'IN', output, tools: [] });
const whole = (id, records) => ({ ...groupAsks(records).find((ask) => ask.id === id), records });

test('detail: Chat through the router has the four numbered sections with the classifier\'s pick', () => {
  const records = [
    { ...RECORDS[0], context: { input: '<section>\nIntro\n</section>\n<line>\n@bart why is the sky blue?\n</line>' }, threads: [], steps: [step('{"agent":"chat","sure":0.9}')], sure: 0.9 },
    { ...RECORDS[1], system: 'SYS', context: { documents: 'DOCS' }, steps: [step('Rayleigh scattering.')], written: ['bart> Rayleigh scattering.'] },
  ];
  const html = renderToStaticMarkup(React.createElement(view.AskDetail, { ask: whole('route-1', records) }));
  for (const heading of ['1 Input (you)', '2 Bart (classifier) output', '3 Chat input', '4 Chat output']) assert.match(html, new RegExp(heading.replace(/[()]/g, '\\$&')));
  assert.match(html, /Picked Chat/);
  assert.match(html, /data-section="4"[\s\S]*raw output[\s\S]*what was written/);
  assert.match(runText.nodesText(runText.askSections(whole('route-1', records))[3].nodes), /Rayleigh scattering\./);
  // A closed section shows only its heading.
  const closed = renderToStaticMarkup(React.createElement(view.AskDetail, { ask: whole('route-1', records), closed: { 4: true } }));
  assert.doesNotMatch(closed, /what was written/);
});

test('detail: typed directly, a Brainstorm card, Discover, and a Build\'s turns and run step', () => {
  const sections = (ask) => runText.askSections(ask);
  const chat = sections(whole('a-6', [{ ...RECORDS[9], steps: [step('ok')] }]));
  assert.deepEqual(chat.map((section) => section.title), ['1 Input (you)', '2 Bart (classifier) output', '3 Chat input', '4 Chat output']);
  assert.equal(chat[1].nodes[0].label, 'Typed directly (@chat)');

  const card = '```json\n{"say":"Pick one","card":"questions","questions":{"title":"Next","items":[{"title":"What matters?","type":"open"}]}}\n```';
  const brainstorm = sections(whole('a-b', [{ id: 'a-b', agent: 'brainstorm', at: 1, status: 'done', question: 'hm', steps: [step(card)], written: [card] }]));
  assert.equal(brainstorm[3].title, '4 Brainstorm output');
  assert.match(runText.nodesText(brainstorm[3].nodes), /card: questions[\s\S]*What matters\? \(open\)/);

  const discover = sections(whole('a-3', [{ ...RECORDS[6], steps: [step('three papers')] }]));
  assert.deepEqual([discover[1].nodes[0].label, discover[2].title], ['Typed directly (@discover)', '3 Discover input']);

  const build = sections(whole('route-2', RECORDS.slice(2, 6).map((record) => ({ ...record, steps: [step('done')], ...(record.agent === 'run step' ? { written: [{ name: 'tests', status: 'passed', passed: true }] } : {}) }))));
  assert.deepEqual(build.map((section) => section.title).slice(2), ['3 Build input', '4 Build output']);
  assert.equal(build[1].nodes[0].label, 'Picked Build');
  const out = runText.nodesText(build[3].nodes);
  assert.match(out, /turn 1[\s\S]*turn 2[\s\S]*Run step \(after turn 1\)[\s\S]*tests: passed/);

  const panel = sections(whole('build:b5', [{ ...RECORDS[8], steps: [] }]));
  assert.equal(panel[1].nodes[0].label, 'Typed directly (Build panel)');
  const unknown = sections(whole('a-8', [{ ...RECORDS[11], steps: [] }]));
  assert.equal(unknown[3].title, '4 mystery output', 'an unknown agent is shown under its own name');
});

test('export: one ask, one self-contained page', () => {
  const records = [{ ...RECORDS[6], steps: [step('</script><b>three</b>')] }];
  const html = runText.exportAsk(whole('a-3', records));
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<title>Agent Viewer · @discover papers on X<\/title>/);
  assert.match(html, /1 Input \(you\)[\s\S]*4 Discover output/);
  assert.doesNotMatch(html, /<script src|<link /, 'nothing loaded from elsewhere');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'what a run wrote cannot close the page\'s data');
});
