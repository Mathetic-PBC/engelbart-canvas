'use strict';

// The Agent Viewer's asks (2026-10-12; src/main/agent-map/asks.cjs, src/renderer/agent-map/runText.js,
// src/renderer/model/askLine.js, src/renderer/screens/AgentMap.jsx, back to its first design on 2026-10-13): the run log's records grouped one entry per ask, the
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

const whole = (id, records) => ({ ...groupAsks(records).find((ask) => ask.id === id), records });
const step = (output) => ({ model: 'claude-sonnet-5-5', name: 'Sonnet', effort: 'high', input: 'IN', output, tools: [] });

test('detail: typed directly, a Brainstorm card, Discover, and a Build\'s turns and run step', () => {
  const sections = (ask) => runText.askSections(ask);
  const chat = sections(whole('a-6', [{ ...RECORDS[9], steps: [step('ok')] }]));
  assert.deepEqual(chat.map((section) => section.title), ['1 Input', '2 Bart (classifier)', '3 Chat input', '4 Chat output']);
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
  assert.match(html, /1 Input[\s\S]*4 Discover output/);
  assert.doesNotMatch(html, /<script src|<link /, 'nothing loaded from elsewhere');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'what a run wrote cannot close the page\'s data');
});

/* ------------------------------------------------------------- where an ask was typed */

test('placeNames: the project, workspace, note and paper an ask was typed in, by name; empty when not found', async () => {
  const { placeNames } = require('../src/main/agent-map/ipc.cjs');
  const projects = {
    findProject: (ctx, id) => { if (id !== 'p-1') throw new Error('no project'); return { name: 'Engelbart', dir: '/p-1' }; },
    findWorkspace: (ctx, pid, wid) => { if (wid !== 'w-1') throw new Error('no workspace'); return { workspace: { name: 'oct-12' } }; },
  };
  const db = { openNotesDb: async () => ({ get: async (id) => (id === 'n-1' ? { name: 'Viewer plan', topic_id: 'w-1' } : null) }) };
  const ctx = { libraryDb: { get: async (id) => (id === 'r-1' ? { name: 'Augmenting Human Intellect' } : null) } };
  const at = (ref, projectId = 'p-1') => placeNames(ctx, { projectId, ref }, { projects, db });
  assert.deepEqual(await at({ kind: 'workspace', workspaceId: 'w-1' }), { project: 'Engelbart', workspace: 'oct-12', note: '', paper: '' });
  assert.deepEqual(await at({ kind: 'note', id: 'n-1' }), { project: 'Engelbart', workspace: 'oct-12', note: 'Viewer plan', paper: '' });
  assert.deepEqual(await at({ kind: 'note', id: 'r-1' }), { project: 'Engelbart', workspace: '', note: 'Augmenting Human Intellect', paper: '' }, 'a library note');
  assert.deepEqual(await at({ kind: 'mark', id: 'm', rowId: 'r-1', page: 3 }), { project: 'Engelbart', workspace: '', note: '', paper: 'Augmenting Human Intellect' });
  assert.deepEqual(await at({ kind: 'workspace', workspaceId: 'gone' }), { project: 'Engelbart', workspace: '', note: '', paper: '' });
  assert.deepEqual(await at({ kind: 'workspace', workspaceId: 'w-1' }, 'gone'), { project: '', workspace: '', note: '', paper: '' });
});

/* ------------------------------------------------------------- the first design, back (2026-10-13) */

test('viewer: Runs | Design and the two exports, in one monospace font, and no key legend (2026-10-13)', () => {
  const html = renderToStaticMarkup(React.createElement(view.default));
  assert.match(html, />Runs</);
  assert.match(html, />Design</);
  assert.match(html, />Export run</);
  assert.match(html, />Export all</);
  assert.doesNotMatch(html, /j\/k run/);
  assert.match(html, /ui-monospace/);
  assert.doesNotMatch(html, />Asks</);
});

test('viewer: the runs list shows every run, newest first, the person\'s words over the agent in plain words, with no filter tabs or status dots (2026-10-13)', () => {
  const runs = [
    { id: 'c1', agent: 'create', at: 3, status: 'done', question: 'a chart of the results', projectName: 'P', model: 'claude-sonnet-5-5', effort: 'high' },
    { id: 'd1', agent: 'discover', at: 2, status: 'running', question: 'papers on X', projectName: 'P' },
    { id: 'b1', agent: 'build', at: 1, status: 'failed', buildId: 'b1', title: 'a parser', turn: 1, projectName: 'P' },
    { id: 's1', agent: 'run step', at: 0, status: 'stopped', buildId: 'b1', title: 'a parser', projectName: 'P' },
  ];
  const html = renderToStaticMarkup(React.createElement(view.RunList, { runs, selected: 'c1', onSelect() {} }));
  const order = ['a chart of the results', 'papers on X', 'Build · turn 1', 'Build · run step'].map((label) => html.indexOf(label));
  assert.ok(order.every((at) => at >= 0), 'each row is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the order given, newest first');
  assert.match(html, />Create · [^<·]+<\/div>/, 'no model in the row (2026-10-13), only the time after the agent');
  assert.doesNotMatch(html, /claude-sonnet-5-5|· high/);
  assert.match(html, /Build · turn 1 · [^<·]+ · first message · failed/);
  assert.doesNotMatch(html, />Questions</);
  assert.doesNotMatch(html, />Builds</);
  assert.doesNotMatch(html, />All</);
  assert.ok(!html.includes('●') && !html.includes('○'), 'no status dots');
  assert.ok(!html.includes('@'), 'no "@" in any row');
});

/** The list's rows as text: each header, and each row's two lines, in order. */
function listRows(html) {
  const rows = [];
  // A row (2026-10-13): its first line, then one dim line with the time in it; no element of its own for the time.
  const re = /<div style="[^"]*font-size:11px[^"]*">([^<]*)<\/div>|<div style="[^"]*cursor:pointer[^"]*" title="([^"]*)"><div[^>]*>([^<]*)<\/div><div[^>]*>([^<]*)<\/div><\/div>/g;
  for (const match of html.matchAll(re)) rows.push(match[1] != null ? { header: match[1] } : { title: match[2], first: match[3], second: match[4] });
  return rows;
}
const unescape = (text) => text.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

test('viewer: a row is the person\'s words, then the agent, its time, first message or reply; one row per question; no place headers (2026-10-13)', () => {
  const W = { projectId: 'p1', workspaceName: 'Concision in Agent Responses' };
  const runs = [
    { id: 'rt-1', agent: 'router', at: 5, status: 'done', by: 'model', sure: 0.85, pick: 'chat', question: 'why is the sky blue?', projectName: '', ...W, model: 'claude-haiku-5-5', effort: 'low' },
    { id: 'ch-1', agent: 'bart', at: 4, status: 'done', question: 'why is the sky blue?', routedFrom: 'rt-1', reply: 0, projectName: 'Engelbart', ...W, model: 'claude-opus-5-5', effort: 'high' },
    { id: 'rt-2', agent: 'router', at: 3, status: 'done', by: 'rule', rule: '--build', pick: 'build', handedTo: 'build:9f3e2a1b7c', question: 'make the list readable', projectName: '', ...W },
    { id: '9f3e2a1b7c:1', agent: 'build', at: 2, status: 'done', buildId: '9f3e2a1b7c', turn: 1, title: 'Make the list readable', projectName: 'Engelbart', ...W, model: 'claude-opus-5-5', effort: 'high', toolCount: 12 },
    { id: 'rs-1', agent: 'run step', at: 1, status: 'done', buildId: '9f3e2a1b7c', title: 'Make the list readable', projectName: 'Engelbart', ...W },
  ];
  const html = renderToStaticMarkup(React.createElement(view.RunList, { runs, selected: 'ch-1', onSelect() {} }));
  const rows = listRows(html).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, unescape(value)])));
  assert.deepEqual(rows.filter((row) => row.header), [], 'no place header');
  const items = rows.filter((row) => !row.header);
  assert.equal(items.length, 3, 'the router\'s records whose runs are listed are gone, the rule\'s pick too');
  assert.deepEqual(items.map((row) => row.first), ['why is the sky blue?', 'Make the list readable', 'Make the list readable']);
  const at = (n) => runText.timeLabel(n);
  assert.equal(items[0].second, `Chat · ${at(4)} · first message`);
  assert.equal(items[1].second, `Build · turn 1 · ${at(2)} · first message`);
  assert.equal(items[2].second, `Build · run step · ${at(1)}`, 'a run step is no message');
  for (const row of items) {
    assert.ok(!/via Bart|Bart →/.test(row.second), row.second);
    assert.ok(!/@run|@bart|@chat|@/.test(row.first + row.second), `no "@" in ${row.second}`);
    assert.ok(!(row.first + row.second).includes('9f3e2a1b7c'), 'no Build id in the row');
    assert.ok(!/tools/.test(row.second), 'no tool count');
  }
  assert.match(items[1].title, /^Engelbart \/ Concision in Agent Responses\nBuild 9f3e2a1b7c\nMake the list readable$/, 'hover: place, Build id, the whole text');
  const alone = renderToStaticMarkup(React.createElement(view.RunList, { runs: [runs[0]], selected: null, onSelect() {} }));
  assert.match(unescape(listRows(alone)[0].title), /^Engelbart \/ Concision in Agent Responses\n|^Concision in Agent Responses\n/, 'a router\'s record alone has its workspace');
  assert.ok(!html.includes('picked by') && !html.includes('rule:'), 'no internal labels');

  // A failed rule pick is listed.
  const failed = renderToStaticMarkup(React.createElement(view.RunList, { runs: [{ ...runs[2], status: 'failed' }], selected: null, onSelect() {} }));
  assert.match(unescape(failed), /Bart couldn't route this · .* · first message · failed/);
  assert.deepEqual(runText.listedRuns(runs).map((run) => run.id), ['ch-1', '9f3e2a1b7c:1', 'rs-1'], 'j/k move over these');

  // Two workspaces: no header row; the place is only in the rows' hover titles.
  const two = renderToStaticMarkup(React.createElement(view.RunList, { runs: [
    { id: 'a', agent: 'bart', at: 3, status: 'done', question: 'q1', projectId: 'p1', projectName: 'Engelbart', workspaceName: 'One' },
    { id: 'b', agent: 'bart', at: 2, status: 'done', question: 'q2', projectId: 'p1', projectName: 'Engelbart', workspaceName: 'One' },
    { id: 'c', agent: 'discover', at: 1, status: 'done', question: 'q3', projectId: 'p1', projectName: 'Engelbart', workspaceName: 'Two' },
  ], selected: null, onSelect() {} }));
  assert.deepEqual(listRows(two).filter((row) => row.header), []);
  assert.equal(listRows(two).length, 3);
  const outsideTitles = two.replace(/ title="[^"]*"/g, '');
  assert.ok(!outsideTitles.includes('Engelbart / One') && !outsideTitles.includes('Engelbart / Two') && !outsideTitles.includes('Engelbart'), 'no place text outside the titles');
});

test('viewer: first message or reply, from each record\'s own field; none on a record without one (2026-10-13)', () => {
  const { turnLabel, rowLine, runLabel } = runText;
  assert.equal(turnLabel({ agent: 'bart', reply: 0 }), 'first message');
  assert.equal(turnLabel({ agent: 'bart', reply: 2 }), 'reply 3');
  assert.equal(turnLabel({ agent: 'discover', reply: 1 }), 'reply 2');
  assert.equal(turnLabel({ agent: 'router', current: 'chat' }), 'reply');
  assert.equal(turnLabel({ agent: 'router' }), 'first message');
  assert.equal(turnLabel({ agent: 'build', turn: 1 }), 'first message');
  assert.equal(turnLabel({ agent: 'build', turn: 2 }), 'reply');
  assert.equal(turnLabel({ agent: 'run step', turn: 1 }), '');
  for (const old of [{ agent: 'bart', question: 'q' }, { agent: 'brainstorm' }, { agent: 'build' }]) {
    assert.doesNotMatch(rowLine(old), /first message|reply/, `${old.agent} without the field says neither`);
  }
  assert.equal(rowLine({ agent: 'bart', reply: 2, status: 'done', model: 'opus', effort: 'high' }), 'Chat · reply 3');
  assert.match(rowLine({ agent: 'bart', reply: 0, status: 'done', stepCount: 2, model: 'opus', effort: 'high' }), /^Chat · first message · escalated/);
  assert.match(rowLine({ agent: 'build', turn: 3, status: 'escalated', ending: 'escalated' }), /^Build · turn 3 · reply · escalated/);
  assert.equal(runLabel({ agent: 'run step', title: 'a parser' }), 'Build · run step a parser');
  assert.equal(runText.AGENTS.find((agent) => agent.agent === 'run step').name, 'Run step');
});

test('viewer: the window is called Agent Viewer, and so is an export (2026-10-13)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/AgentMap.jsx'), 'utf8');
  assert.match(source, /document\.title = 'Agent Viewer'/);
  assert.doesNotMatch(source, /document\.title = 'Agent map'/);
  const page = runText.exportPage([{ id: 'x', agent: 'bart', at: 0, status: 'done', question: 'q', system: '', context: {}, steps: [], written: [] }]);
  assert.match(page, /Exported from Engelbart's Agent Viewer/);
  assert.doesNotMatch(page, /Agent map/);
});

test('viewer: a question\'s record keeps how many turns came before it (reply)', async () => {
  const log = createRunLog();
  const bart = createFakeBart({ readModels: () => normalizeModels(null), delayMs: 0, runLog: log });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const turns = [{ question: 'why?', answer: 'because' }, { question: 'and then?', answer: 'then this' }];
  await bart.ask(ctx, project.id, { askId: 'rp-0', ref, workspaceId: workspace.id, text: 'first one' });
  await bart.ask(ctx, project.id, { askId: 'rp-2', ref, workspaceId: workspace.id, text: 'and after that?', turns });
  assert.equal(log.get('rp-0').reply, 0);
  assert.equal(log.get('rp-2').reply, 2);
  const { runRecord } = require('../src/main/bart/ask.cjs');
  const base = { id: 'r', agent: 'bart', provider: 'anthropic', projectId: 'p', question: 'q', system: '', context: { project: null }, shown: [], extra: '', mode: null, pinned: false };
  assert.equal(runRecord({ ...base, reply: 2 }).reply, 2);
  assert.equal('reply' in runRecord(base), false, 'none given, none kept');
});

test('viewer: an open run has no header and no size notes beside its sections; a failed one still says why (2026-10-13)', () => {
  const record = { id: 'r-77fa', agent: 'bart', at: 3, status: 'done', question: 'why is the sky blue?', projectName: 'Engelbart', workspaceName: 'oct-13', provider: 'anthropic-provider', system: 'SYS', context: { head: '<engelbart>' }, steps: [], written: ['bart> blue'] };
  const html = renderToStaticMarkup(React.createElement(view.RunDetail, { record, open: null, onToggle() {} }));
  for (const title of ['1 System prompt', '2 Context', '3 Steps', '4 Written']) assert.ok(html.includes(`<b>${title}</b></div>`), `${title} with nothing after it`);
  assert.doesNotMatch(html, /~0 tok/);
  assert.doesNotMatch(html, /chars ·/);
  assert.doesNotMatch(html, /blocks ·/);
  assert.ok(!html.includes('r-77fa'), 'no line with the id');
  assert.ok(!html.includes('anthropic-provider'), 'no line with the provider');
  assert.ok(!html.includes('@chat'), 'no title line');
  const failed = renderToStaticMarkup(React.createElement(view.RunDetail, { record: { ...record, status: 'failed', error: 'the model timed out' }, open: null, onToggle() {} }));
  assert.match(failed, /failed: the model timed out/);
  const routed = renderToStaticMarkup(React.createElement(view.RunDetail, { record: { ...record, routedFrom: 'route-1' }, open: null, onToggle() {} }));
  assert.ok(!routed.includes('handed over by Bart') && !routed.includes('route-'), 'no route id (2026-10-13)');
  const router = renderToStaticMarkup(React.createElement(view.RunDetail, { record: { ...record, agent: 'router', by: 'model', sure: 0.85, pick: 'chat', sectionSize: 4000, specAbove: true, threads: [{ agent: 'bart', up: 292 }], context: { input: 'IN' } }, open: null, onToggle() {} }));
  assert.ok(!router.includes('picked by') && !router.includes('threads:') && !router.includes('spec above'), 'no router line');
});

test('viewer: a @create run\'s Written shows what it kept in the library', () => {
  const record = { id: 'c1', agent: 'create', at: 3, status: 'done', question: 'a chart', projectName: 'P', provider: 'anthropic', steps: [], written: ['create> made it'], created: [{ name: 'Results chart', type: 'html', path: 'assets/files/chart.html' }], skipped: ['too big'] };
  const html = renderToStaticMarkup(React.createElement(view.RunDetail, { record, open: 'written', onToggle() {} }));
  assert.match(html, /kept in the library/);
  assert.match(html, /Results chart · html · assets\/files\/chart\.html/);
  assert.match(html, /skipped: too big/);
});

/* ------------------------------------------------------------- order, filters, no model, closed sections (2026-10-13) */

test('viewer: listedRuns is newest first by `at`, whatever order the log gave', () => {
  const runs = [{ id: 'three', agent: 'bart', at: 3 }, { id: 'one', agent: 'bart', at: 1 }, { id: 'two', agent: 'bart', at: 2 }];
  assert.deepEqual(runText.listedRuns(runs).map((run) => run.at), [3, 2, 1]);
  assert.deepEqual(runs.map((run) => run.at), [3, 1, 2], 'the given list is left as it was');
  const html = renderToStaticMarkup(React.createElement(view.RunList, { runs: runs.map((run) => ({ ...run, status: 'done', question: run.id })), selected: null, onSelect() {} }));
  assert.deepEqual(listRows(html).map((row) => row.first), ['three', 'two', 'one']);
});

const DAY = (d, h) => new Date(2026, 9, d, h).getTime();
const NOW = DAY(13, 18);
const FILTERED = [
  { id: 'r1', agent: 'router', by: 'model', at: DAY(13, 12), status: 'done', question: 'q', projectId: 'p1', workspaceName: 'oct-12' },
  { id: 'c1', agent: 'bart', at: DAY(13, 11), status: 'done', question: 'q', projectId: 'p1', projectName: 'Engelbart', workspaceName: 'oct-12' },
  { id: 'c2', agent: 'bart', at: DAY(12, 9), status: 'done', question: 'q', projectId: 'p1', projectName: 'Engelbart', workspaceName: 'Concision in Agent Responses' },
  { id: 'd1', agent: 'discover', at: DAY(11, 20), status: 'done', question: 'q', projectId: 'p2', projectName: 'Papers', workspaceName: 'oct-12' },
  { id: 'n1', agent: 'bart', at: DAY(11, 8), status: 'done', question: 'q' },
];

test('viewer: filterRuns by project, by workspace within a project, by day; all three on all is everything', () => {
  const { filterRuns, dayKey } = runText;
  const ids = (filter) => filterRuns(FILTERED, filter).map((run) => run.id);
  assert.deepEqual(ids({ project: '', workspace: '', day: '' }), ['r1', 'c1', 'c2', 'd1', 'n1']);
  assert.deepEqual(ids({}), ['r1', 'c1', 'c2', 'd1', 'n1']);
  assert.deepEqual(ids({ project: 'Engelbart' }), ['r1', 'c1', 'c2'], 'the router\'s record is matched through projectNames');
  assert.deepEqual(ids({ project: 'Engelbart', workspace: 'oct-12' }), ['r1', 'c1'], 'a workspace within a project: not Papers\' oct-12');
  assert.deepEqual(ids({ workspace: 'oct-12' }), ['r1', 'c1', 'd1']);
  assert.deepEqual(ids({ day: dayKey(DAY(11, 0)) }), ['d1', 'n1']);
  assert.deepEqual(ids({ project: 'Papers', day: dayKey(DAY(13, 0)) }), []);
  assert.ok(!ids({ project: 'Engelbart' }).includes('n1') && !ids({ workspace: 'oct-12' }).includes('n1'), 'a run with no place shows only under all');
});

test('viewer: the filters\' options: projects, the project\'s workspaces, and days newest first as Today, Yesterday, Oct 11', () => {
  const { filterOptions, projectNames } = runText;
  const all = filterOptions(FILTERED, {}, projectNames(FILTERED), NOW);
  assert.deepEqual(all.projects, ['Engelbart', 'Papers']);
  assert.deepEqual(all.workspaces, ['Concision in Agent Responses', 'oct-12']);
  assert.deepEqual(all.days.map((day) => day.label), ['Today', 'Yesterday', 'Oct 11']);
  assert.deepEqual(filterOptions(FILTERED, { project: 'Papers' }, projectNames(FILTERED), NOW).workspaces, ['oct-12']);
  assert.equal(runText.dayLabel('2025-10-11', NOW), 'Oct 11, 2025', 'another year says which');

  const html = renderToStaticMarkup(React.createElement(view.RunFilters, { runs: FILTERED, filter: view.ALL_RUNS, onChange() {} }));
  assert.equal((html.match(/<select/g) || []).length, 3);
  assert.match(html, /<option value="" selected="">All projects<\/option><option value="Engelbart">Engelbart<\/option><option value="Papers">Papers<\/option>/);
  assert.match(html, /<option value="" selected="">All workspaces<\/option>/);
  assert.match(html, /<option value="" selected="">All dates<\/option>/);
});

test('viewer: a filter that leaves nothing says so; the list under a filter', () => {
  const none = renderToStaticMarkup(React.createElement(view.RunList, { runs: FILTERED, filter: { project: 'Papers', workspace: '', day: runText.dayKey(DAY(13, 0)) }, selected: null, onSelect() {} }));
  assert.match(none, /No runs match\./);
  const papers = renderToStaticMarkup(React.createElement(view.RunList, { runs: FILTERED, filter: { project: 'Papers', workspace: '', day: '' }, selected: null, onSelect() {} }));
  assert.equal(listRows(papers).length, 1);
});

test('viewer: no model in a row; a router row has no "claude" (2026-10-13)', () => {
  const chat = runText.rowLine({ agent: 'bart', reply: 0, status: 'done', model: 'opus', effort: 'high' });
  assert.ok(!chat.includes('opus') && !chat.includes('high'), chat);
  const router = runText.rowLine({ agent: 'router', by: 'model', sure: 0.9, pick: 'chat', status: 'done', model: 'claude-haiku-5-5', effort: 'low' });
  assert.ok(!router.includes('claude'), router);
  assert.equal(runText.modelLabel({ model: 'opus', effort: 'high' }), 'opus · high', 'kept for the export');
});

test('viewer: a run opens with its sections closed; a step row shows once Steps is opened (2026-10-13)', () => {
  const record = { id: 'c1', agent: 'bart', at: 3, status: 'done', question: 'why?', system: 'SYS', context: { head: 'H' }, steps: [step('blue')], written: ['bart> blue'] };
  const html = renderToStaticMarkup(React.createElement(view.default, { seed: { runs: [record], record } }));
  assert.match(html, /<b>3 Steps<\/b>/, 'the run is drawn');
  assert.ok(!html.includes('<b>step 1</b>'), 'no step row');
  assert.ok(!html.includes('SYS') && !html.includes('bart&gt; blue'), 'no section open');
  const opened = renderToStaticMarkup(React.createElement(view.RunDetail, { record, open: 'steps', onToggle() {} }));
  assert.match(opened, /<b>step 1<\/b>/);
  assert.match(opened, /\(claude-sonnet-5-5\) · high/, 'a step still names its model');
});

/* ------------------------------------------------------------- one row per question, the detail in two parts (2026-10-13) */

const ROUTER = { id: 'r1', agent: 'router', at: 10, status: 'done', by: 'model', sure: 0.85, pick: 'chat', question: 'why blue?', system: 'ROUTER SYS', context: { input: 'ROUTER IN' }, steps: [step('{"agent":"chat","sure":0.85}')], written: ['@chat'] };
const CHAT = { id: 'c1', agent: 'bart', at: 11, status: 'done', question: 'why blue?', routedFrom: 'r1', reply: 0, system: 'CHAT SYS', context: { head: 'H' }, steps: [step('blue')], written: ['bart> blue'] };
const detail = (props) => unescape(renderToStaticMarkup(React.createElement(view.RunPanel, { open: null, routeOpen: null, onToggle() {}, ...props })));

test('viewer: an @bart question is one row, "Chat · <time>"; its detail is the Classification, then the agent', () => {
  const runs = [ROUTER, CHAT];
  const rows = listRows(renderToStaticMarkup(React.createElement(view.RunList, { runs, selected: null, onSelect() {} }))).map((row) => ({ ...row, second: unescape(row.second) }));
  assert.equal(rows.length, 1);
  assert.ok(rows[0].second.startsWith(`Chat · ${runText.timeLabel(11)}`), rows[0].second);
  assert.ok(!rows[0].second.includes('via Bart'));
  assert.equal(runText.routerFor(CHAT, runs).id, 'r1');
  const html = detail({ record: CHAT, route: { id: 'r1', record: ROUTER } });
  const one = html.indexOf('1. Classification'), two = html.indexOf('2. Agent: Chat');
  assert.ok(one >= 0 && two > one, 'the Classification part, then the agent\'s');
  assert.ok(html.includes('Bart sent this to Chat (0.85 sure)'));
  const part1 = html.slice(one, two), part2 = html.slice(two);
  assert.match(part1, /<b>3 Steps<\/b>/, 'the router\'s Steps');
  assert.match(part2, /<b>1 System prompt<\/b>/, 'the chat\'s sections');
  assert.ok(!html.includes('handed over by Bart') && !html.includes('route-') && !html.includes('>r1<'), 'no route id in the panel');
});

test('viewer: a row has no time element of its own; the time comes right after the agent', () => {
  const html = renderToStaticMarkup(React.createElement(view.RunList, { runs: [CHAT], selected: null, onSelect() {} }));
  assert.ok(!/<span/.test(html), 'no span in a row');
  const [row] = listRows(html);
  assert.equal(unescape(row.second), `Chat · ${runText.timeLabel(11)} · first message`);
});

test('viewer: a rule\'s Build pick and its Build: one row "Build · turn 1 · <time>"; turn 1 has the Classification, turn 2 none', () => {
  const rule = { id: 'r2', agent: 'router', at: 20, status: 'done', by: 'rule', rule: '--build', pick: 'build', handedTo: 'build:b1', question: 'make it', system: '', context: { input: '' }, steps: [], written: ['@build'] };
  const t1 = { id: 'b1:1', agent: 'build', at: 21, status: 'done', buildId: 'b1', turn: 1, title: 'Make it', system: 'BUILD SYS', context: {}, steps: [], written: [] };
  const t2 = { ...t1, id: 'b1:2', at: 30, turn: 2 };
  const one = listRows(renderToStaticMarkup(React.createElement(view.RunList, { runs: [rule, t1], selected: null, onSelect() {} })));
  assert.equal(one.length, 1);
  assert.ok(unescape(one[0].second).startsWith(`Build · turn 1 · ${runText.timeLabel(21)}`), one[0].second);
  assert.equal(runText.routerFor(t1, [rule, t1, t2]).id, 'r2');
  assert.equal(runText.routerFor(t2, [rule, t1, t2]), null, 'a later turn has none');
  const html = detail({ record: t1, route: { id: 'r2', record: rule } });
  assert.ok(html.includes('1. Classification') && html.includes('Bart sent this to Build (rule: --build)') && html.includes('2. Agent: Build · turn 1'));
  assert.ok(!detail({ record: t2 }).includes('Classification'));
  // Also with a model router, both kept as the run log has them.
  const model = { ...rule, id: 'r3', by: 'model', sure: 0.9, handedTo: 'build:b2' };
  assert.deepEqual(runText.listedRuns([model, { ...t1, id: 'b2:1', buildId: 'b2' }]).map((run) => run.id), ['b2:1']);
});

test('viewer: a chat asked directly has no headings, its sections as before; Loading… until the router record comes', () => {
  const direct = { ...CHAT, routedFrom: undefined };
  assert.equal(runText.routerFor(direct, [ROUTER, direct]), null);
  const html = detail({ record: direct });
  assert.ok(!html.includes('Classification') && !html.includes('2. Agent'));
  assert.equal(html, unescape(renderToStaticMarkup(React.createElement(view.RunDetail, { record: direct, open: null, onToggle() {} }))));
  const loading = detail({ record: CHAT, route: { id: 'r1', record: undefined } });
  assert.match(loading, /1\. Classification<\/div><div[^>]*>Loading…<\/div>/);
  assert.ok(loading.includes('2. Agent: Chat'));
});

test('viewer: opening the router\'s System prompt leaves the agent\'s closed, and the other way round', () => {
  const routeOpen = detail({ record: CHAT, route: { id: 'r1', record: ROUTER }, routeOpen: 'route:system' });
  assert.ok(routeOpen.includes('ROUTER SYS') && !routeOpen.includes('CHAT SYS'));
  const agentOpen = detail({ record: CHAT, route: { id: 'r1', record: ROUTER }, open: 'system' });
  assert.ok(agentOpen.includes('CHAT SYS') && !agentOpen.includes('ROUTER SYS'));
  assert.equal(view.ROUTE, 'route:', 'the router\'s sections are "route:system" and so on');
});

test('viewer: a failed router is listed as "Bart couldn\'t route this"; a router no listed run points to is listed, its detail as today', () => {
  const failed = { ...ROUTER, id: 'r9', status: 'failed', error: 'timed out' };
  const handed = { ...CHAT, id: 'c9', routedFrom: 'r9', routedBy: 'error' };
  const rows = listRows(renderToStaticMarkup(React.createElement(view.RunList, { runs: [failed, handed], selected: null, onSelect() {} }))).map((row) => unescape(row.second));
  assert.equal(rows.length, 2, 'a failed router stays');
  assert.ok(rows.some((line) => line.startsWith("Bart couldn't route this")), rows.join(' | '));
  assert.ok(rows.some((line) => line.startsWith('Chat · Bart failed to route')), rows.join(' | '));
  // Its error under the part it belongs to.
  const html = detail({ record: handed, route: { id: 'r9', record: failed } });
  assert.ok(html.indexOf('failed: timed out') > html.indexOf('1. Classification') && html.indexOf('failed: timed out') < html.indexOf('2. Agent'));
  assert.ok(html.includes("Bart couldn't route this; it went to Chat"));

  const lone = { ...ROUTER, id: 'r10' };
  assert.deepEqual(runText.listedRuns([lone]).map((run) => run.id), ['r10']);
  assert.equal(unescape(listRows(renderToStaticMarkup(React.createElement(view.RunList, { runs: [lone], selected: null, onSelect() {} })))[0].second), `Bart → Chat · 0.85 · ${runText.timeLabel(10)} · first message`);
  assert.equal(runText.routerFor(lone, [lone]), null, 'a router\'s own record has none');
  const own = detail({ record: lone });
  assert.ok(!own.includes('Classification'));
  assert.equal(own, unescape(renderToStaticMarkup(React.createElement(view.RunDetail, { record: lone, open: null, onToggle() {} }))));
});

test('viewer: a corrected pick says "you changed it to …"', () => {
  const corrected = { ...ROUTER, pick: 'build', corrected: 'chat' };
  assert.equal(runText.classificationLine(corrected, { ...CHAT, corrected: 'chat' }), 'Bart sent this to Build; you changed it to Chat');
  assert.equal(runText.classificationLine({ ...ROUTER, pick: 'build' }, { ...CHAT, corrected: 'chat' }), 'Bart sent this to Build; you changed it to Chat', 'the run\'s own correction when the router\'s record has none');
  assert.equal(runText.agentLabel({ ...CHAT, corrected: 'chat' }), 'Chat', 'no "corrected from Bart" in the row');
  assert.equal(runText.runLabel({ agent: 'build', title: 'x', turn: 1, routedFrom: 'route-1' }), 'Build x · turn 1');
});
