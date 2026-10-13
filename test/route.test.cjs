'use strict';

// Bart, the router (2026-10-12): @bart picks @chat, @brainstorm, @discover or Build and steps aside. The names (tokenOf,
// parseLine), the migration of older `@bart` questions to `@chat`, the editor's rules (src/renderer/model/route.js), the
// model's pick (src/main/bart/route.cjs) on a stand-in CLI, the handoff and the footer's Build in the editor, "via Bart"
// and its correction, and the run log's links between a pick and the run it handed the line to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { pathToFileURL } = require('node:url');
const { buildSync } = require('esbuild');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const route = require('../src/main/bart/route.cjs');
const { createRunLog } = require('../src/main/bart/runlog.cjs');
const { replyLines, attribution } = require('../src/main/bart/reply.cjs');
const { buildRequestOf } = require('../src/main/bart/question.cjs');
const { RESULT_OFFER, isResultOffer } = require('../src/main/bart/card.cjs');
const { createFakeBart } = require('../src/main/bart/ask.cjs');

const DEFAULTS = normalizeModels(null);
const loadDoc = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/doc.js')).href);
const loadRoute = () => import(pathToFileURL(path.join(__dirname, '../src/renderer/model/route.js')).href);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `engelbart-route-${name}-`));
const SPEC = ['@chat give me the build prompt for the haiku entry', 'bart> Here it is:', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', 'bart> *Sonnet · high · 3s*'];

/* ------------------------------------------------------------------- names */

test('tokenOf: the internal bart is typed @chat, the router @bart, the others as they are named', async () => {
  const { tokenOf, parseLine, agentOf } = await loadDoc();
  assert.deepEqual(['bart', 'router', 'brainstorm', 'discover'].map(tokenOf), ['chat', 'bart', 'brainstorm', 'discover']);
  assert.equal(agentOf(parseLine('@chat why?')), 'bart', '@chat asks the agent the app calls bart');
  assert.equal(agentOf(parseLine('@Chat why?')), 'bart');
  assert.equal(agentOf(parseLine('@bart why?')), 'router', '@bart is the router');
  assert.equal(agentOf(parseLine('@brainstorm')), 'brainstorm');
  assert.equal(parseLine('@chat --haiku why?').text, '--haiku why?');
  assert.equal(parseLine('@chatter is a word').type === 'bart', false, 'only the whole word');
});

test('a Build request, an @menu, the result offer and Settings use the new names', async () => {
  assert.deepEqual(buildRequestOf({ agent: 'router', text: '--build add x' }), { request: 'add x' }, 'an @bart --build line is a Build request');
  assert.match(RESULT_OFFER, /@chat/);
  assert.ok(isResultOffer(RESULT_OFFER));
  const { AGENT_ROWS } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/model/intelligence.js')).href).catch(() => ({}));
  if (AGENT_ROWS) assert.equal(AGENT_ROWS.find((row) => row.id === 'bart').name, '@chat');
});

/* --------------------------------------------------------------- migration */

test('migration: an answered or pending @bart question becomes @chat; a Build request stays; run again, nothing changes', async () => {
  const { migrateChatLines } = await loadDoc();
  const before = [
    '# Plan',
    '@bart why does it fail?', 'bart> Because.', 'bart> *Sonnet · high · 2s*',
    '@Bart --haiku and now?', 'bart+> Folded.',
    '@bart draft one', 'bart?> a draft',
    '@bart asked now', 'bart~> ab12cd',
    '@bart --build add x', 'build> 0123456789',
    '@bart not asked yet',
    '```', '@bart in code', 'bart> code', '```',
  ].join('\n');
  const once = migrateChatLines(before);
  assert.equal(once.count, 4);
  const lines = once.text.split('\n');
  assert.deepEqual([lines[1], lines[4], lines[6], lines[8]], ['@chat why does it fail?', '@Chat --haiku and now?', '@chat draft one', '@chat asked now']);
  assert.equal(lines[10], '@bart --build add x', 'a Build request stays');
  assert.equal(lines[12], '@bart not asked yet', 'an unanswered line is the router\'s now');
  assert.equal(lines[14], '@bart in code', 'code is code');
  const twice = migrateChatLines(once.text);
  assert.deepEqual([twice.count, twice.text], [0, once.text], 'idempotent');
  assert.deepEqual(migrateChatLines('no agents'), { text: 'no agents', count: 0 });
});

/* ------------------------------------------------------------------- rules */

test('routeByRule: empty → brainstorm, --build → Build, a level → discover, a model flag → chat, under a brainstorm or discover thread → it; else the model', async () => {
  const { routeByRule } = await loadRoute();
  const models = DEFAULTS;
  assert.deepEqual(routeByRule('', {}), { agent: 'brainstorm', rule: 'empty' });
  assert.deepEqual(routeByRule('  ', {}), { agent: 'brainstorm', rule: 'empty' });
  assert.deepEqual(routeByRule('--build add a comment', {}), { agent: 'build', rule: '--build' });
  assert.deepEqual(routeByRule('tutors --deep', {}), { agent: 'discover', rule: 'level' });
  assert.deepEqual(routeByRule('--quick tutors', {}), { agent: 'discover', rule: 'level' });
  assert.deepEqual(routeByRule('--haiku why?', { models }), { agent: 'chat', rule: 'model flag' });
  assert.deepEqual(routeByRule('why? --low', { models }), { agent: 'chat', rule: 'model flag' });
  assert.deepEqual(routeByRule('--opus why?', {}), { agent: 'chat', rule: 'model flag' }, 'without the models file, a model\'s word still counts');
  assert.equal(routeByRule('what does this one entail', { models }), null);
  const lines = ['@brainstorm', 'bart> card', '@bart and what about cost?'];
  assert.deepEqual(routeByRule('and what about cost?', { lines, at: 2, models }), { agent: 'brainstorm', rule: 'under thread' });
  const discover = ['@discover tutors', 'bart> guide', '@bart more on this'];
  assert.deepEqual(routeByRule('more on this', { lines: discover, at: 2 }), { agent: 'discover', rule: 'under thread' });
  const gap = ['@discover tutors', 'bart> guide', '', '@bart more on this'];
  assert.equal(routeByRule('more on this', { lines: gap, at: 3 }), null, 'a blank line between: not under it');
  assert.equal(routeByRule('ok build it', { lines: [...SPEC, '@bart ok build it'], at: SPEC.length }), null, 'under a Chat spec, the model reads it');
});

test('routeInputs: the section from the heading, the threads above with their tokens, and the spec of the nearest answer', async () => {
  const { routeInputs, buildTextOf } = await loadRoute();
  const { parseLines, threads } = await loadDoc();
  const lines = ['# Old', '@discover tutors', 'bart> guide', '', '# Haiku', 'Some notes.', ...SPEC, '', '@bart ok build it'];
  const at = lines.length - 1, got = routeInputs(lines, at);
  assert.ok(got.section.startsWith('# Haiku') && got.section.endsWith('@bart ok build it'));
  assert.deepEqual(got.threads.map((t) => [t.agent, t.question.slice(0, 22), t.up]), [['discover', 'tutors', at - 1], ['chat', 'give me the build prom', at - 6]]);
  assert.deepEqual([got.specAbove, got.spec], [true, 'Add Haiku 5.5 to models.cjs.']);
  assert.equal(routeInputs(['# A', '@chat why', 'bart> because', '@bart next'], 3).specAbove, false);
  const thread = threads(lines, parseLines(lines)).find((t) => t.from === 6);
  assert.equal(buildTextOf(lines, thread.turns[0]), 'Add Haiku 5.5 to models.cjs.', 'the last fenced block');
  const plain = ['@chat why', 'bart> because', 'bart> *Sonnet · 2s*'];
  assert.equal(buildTextOf(plain, threads(plain, parseLines(plain))[0].turns[0]), 'why\n\nbecause', 'no block: the question and the answer');
});

/* ------------------------------------------------------------- the model */

function cli(reply, seen = {}) {
  return (file, args, options, done) => {
    seen.command = args[1]; seen.env = options.env; seen.timeout = options.timeout;
    seen.input = fs.readFileSync(options.env.ENGELBART_ROUTE_INPUT, 'utf8');
    if (options.env.ENGELBART_ROUTE_PROMPT) seen.prompt = fs.readFileSync(options.env.ENGELBART_ROUTE_PROMPT, 'utf8');
    if (reply instanceof Error) return done(reply, '');
    if (options.env.ENGELBART_ROUTE_OUTPUT) { fs.writeFileSync(options.env.ENGELBART_ROUTE_OUTPUT, reply); return done(null, ''); }
    return done(null, `noise\n${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: reply })}\n`);
  };
}
const router = (reply, { seen = {}, models = { ...DEFAULTS, provider: 'anthropic' }, runLog = null } = {}) => {
  const dir = tmp('cli'), auth = path.join(dir, 'auth.json');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  return route.createRouter({ readModels: () => models, environment: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: os.homedir() }, runDirectory: dir, codexHome: path.join(dir, 'codex'), codexAuthFile: auth, run: cli(reply, seen), runLog });
};
const LINE = { projectId: 'p', text: 'what does this one entail', section: '# Haiku\nnotes\n@chat why\nbart> secret answer text\n@bart what does this one entail', workspaceName: 'W', threads: [{ agent: 'chat', question: 'why', up: 2 }], specAbove: false };

test('route.cjs: valid JSON is the pick; Haiku at low effort on Claude Code, Luna at low on Codex; no tools, no session, 20 s', async () => {
  const seen = {};
  const got = await router('{"agent":"discover","sure":0.82}', { seen }).route(LINE);
  assert.deepEqual([got.agent, got.sure, got.by, got.model.name, got.model.effort], ['discover', 0.82, 'model', 'Haiku', 'low']);
  assert.ok(typeof got.ms === 'number' && /^route-/.test(got.id));
  for (const flag of ['claude', '-p', '--no-session-persistence', '--tools ""', '--strict-mcp-config', '--effort low']) assert.ok(seen.command.includes(flag), flag);
  assert.equal(seen.env.ENGELBART_ROUTE_MODEL, 'claude-haiku-5-5');
  assert.equal(seen.timeout, 20000);
  assert.match(seen.prompt, /You are Bart, the router/);
  const codex = {};
  const viaCodex = await router('{"agent":"brainstorm","sure":0.9}', { seen: codex, models: { ...DEFAULTS, provider: 'openai' } }).route(LINE);
  assert.deepEqual([viaCodex.agent, viaCodex.model.name, viaCodex.model.effort], ['brainstorm', 'Luna', 'low']);
  assert.ok(codex.command.includes('codex') && codex.command.includes('model_reasoning_effort="low"') && codex.command.includes('-s read-only'));
});

test('route.cjs: unsure, garbage, a timeout or an error all go to chat', async () => {
  assert.deepEqual(await router('{"agent":"build","sure":0.4}').route(LINE).then((r) => [r.agent, r.sure]), ['chat', 0.4]);
  assert.equal((await router('I think build').route(LINE)).agent, 'chat');
  assert.equal((await router('{"agent":"nobody","sure":1}').route(LINE)).agent, 'chat');
  const timedOut = await router(Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM' })).route(LINE);
  assert.deepEqual([timedOut.agent, !!timedOut.error], ['chat', true]);
  const none = await route.createRouter({ readModels: () => null }).route(LINE);
  assert.equal(none.agent, 'chat');
  assert.deepEqual(route.parseReply('Sure: {"agent":"@Discover","sure":7}'), { agent: 'discover', sure: 1 });
});

test('route.cjs: the model reads the line, its section without agent replies, five threads, the spec flag; never the library or mentioned files', async () => {
  const seen = {};
  const threads = Array.from({ length: 8 }, (_, n) => ({ agent: 'chat', question: `q${n} ${'x'.repeat(200)}`, up: n + 1 }));
  await router('{"agent":"chat","sure":0.9}', { seen }).route({ ...LINE, threads, section: `${'y'.repeat(6000)}\n${LINE.section}`, contextJson: '<context_json>LIBRARY</context_json>', mentioned: 'MENTIONED' });
  assert.ok(!seen.input.includes('secret answer text'), 'agent replies left out');
  assert.ok(!/context_json|LIBRARY|MENTIONED/.test(seen.input), 'no library, no context_json, no mentioned file');
  assert.match(seen.input, /<line>\nwhat does this one entail\n<\/line>/);
  assert.match(seen.input, /<spec_above>no<\/spec_above>/);
  const section = seen.input.match(/<section>\n([\s\S]*?)\n<\/section>/)[1];
  assert.ok(section.length <= 4000, 'the last 4,000 characters');
  const listed = seen.input.match(/<threads>\n([\s\S]*?)\n<\/threads>/)[1].split('\n');
  assert.equal(listed.length, 5);
  assert.ok(listed[0].startsWith('- @chat, 4 lines up: "q3'), listed[0]);
  assert.ok(listed.every((line) => line.length < 120), 'each question cut to 80 characters');
});

test('route.cjs fake (ENGELBART_BART_FAKE=1): by keyword', () => {
  assert.deepEqual(['build it now', 'please implement x', 'what papers on tutors', 'prior work on this', 'help me think this through', 'why is it red'].map((t) => route.fakePick(t).agent), ['build', 'build', 'discover', 'discover', 'brainstorm', 'chat']);
});

/* ---------------------------------------------------------- the run log */

test('run log: a pick is a router record; the run it hands to names it; a correction marks it; a Build is handedTo', async () => {
  const runLog = createRunLog({ file: path.join(tmp('log'), 'agent-runs.jsonl') });
  const r = router('{"agent":"discover","sure":0.9}', { runLog });
  const pick = await r.route(LINE);
  const record = runLog.get(pick.id);
  assert.deepEqual([record.agent, record.pick, record.sure, record.by, record.status, record.specAbove, record.threads.length, record.provider], ['router', 'discover', 0.9, 'model', 'done', false, 1, 'anthropic']);
  assert.ok(record.sectionSize > 0 && record.steps.length === 1 && record.steps[0].output.includes('discover'));
  const byRule = await r.route({ ...LINE, text: '--deep tutors', rule: { agent: 'discover', rule: 'level' } });
  assert.deepEqual([runLog.get(byRule.id).by, runLog.get(byRule.id).rule, runLog.get(byRule.id).steps.length], ['rule', 'level', 0]);
  r.handed(byRule.id, 'build:0123456789');
  assert.equal(runLog.get(byRule.id).handedTo, 'build:0123456789');

  // The run it hands to: a fake Chat ask carrying routed.
  const bart = createFakeBart({ runLog });
  const asked = await bart.ask({ projectId: 'p', question: { text: 'what does this one entail', agent: 'bart', routed: { id: pick.id, build: true } } }).catch((e) => ({ error: e }));
  const run = runLog.list().find((x) => x.agent === 'bart');
  if (run) assert.equal(run.routedFrom, pick.id);
  else assert.ok(asked, 'the fake ask ran');
  // A correction: by id, and by the line when the id is not known.
  route.markCorrected(runLog, { id: pick.id, agent: 'brainstorm' });
  assert.equal(runLog.get(pick.id).corrected, 'brainstorm');
  const other = await r.route({ ...LINE, text: 'a line of its own' });
  route.markCorrected(runLog, { text: 'a line of its own', projectId: 'p', agent: 'chat' });
  assert.equal(runLog.get(other.id).corrected, 'chat');
});

test('reply: an answer Bart handed over closes "· via Bart", "· via Bart · build" when it was wanted built', () => {
  const meta = { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 };
  const plain = replyLines('Because.', meta, { model: false });
  assert.ok(!plain[plain.length - 1].includes('via Bart'));
  const via = replyLines('Because.', { ...meta, routed: { id: 'route-1' } }, { model: false });
  assert.match(via[via.length - 1], / · via Bart\*$/);
  const build = replyLines('Because.', { ...meta, routed: { id: 'route-1', build: true } }, { model: false });
  assert.match(build[build.length - 1], / · via Bart · build\*$/);
  assert.equal(typeof attribution, 'function');
});

/* ------------------------------------------------------------- the editor */

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-route-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports.default;
}
const DocEditor = loadEditor();

function mounted(lines, { route: onRoute = null, build = true } = {}) {
  const asks = [], builds = [], routes = [], gone = [];
  const props = {
    docKey: 'k', text: lines.join('\n'), models: DEFAULTS,
    onChange: (next) => { props.text = next; },
    onAsk: (ask) => asks.push(ask),
    onRoute: onRoute ? (input) => { routes.push(input); return onRoute(input); } : undefined,
    onRouteGone: (id) => gone.push(id),
    ...(build ? { onBuild: (b) => builds.push(b) } : {}),
  };
  const editor = new DocEditor(props);
  const root = { closest: (sel) => (sel === '[data-editor]' ? root : null), matches: () => false, focus() {}, blur() {}, contains: () => false, querySelector: () => null };
  editor.props = props;
  editor.edRef = { current: root };
  editor.scrollRef = { current: { closest: () => null } };
  editor.setState = (patch) => Object.assign(editor.state, typeof patch === 'function' ? patch(editor.state) : patch);
  editor.syncEditor = () => {};
  editor.maybeRestoreView = () => {};
  globalThis.getSelection = () => ({ isCollapsed: true, rangeCount: 0 });
  globalThis.document = { addEventListener() {}, removeEventListener() {}, hasFocus: () => true, activeElement: null };
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  editor.componentDidMount();
  return { editor, props, asks, builds, routes, gone, lines: () => props.text.split('\n') };
}
test.afterEach(() => { delete globalThis.getSelection; delete globalThis.document; delete globalThis.window; });

test('handoff: chat, brainstorm and discover rewrite the line and ask that agent, carrying the pick', async () => {
  for (const [agent, token, internal] of [['chat', 'chat', 'bart'], ['brainstorm', 'brainstorm', 'brainstorm'], ['discover', 'discover', 'discover']]) {
    const m = mounted(['# Notes', '@bart how do tutors notice struggle?'], { route: async () => ({ id: 'route-a', agent, sure: 0.9, by: 'model' }) });
    m.editor.askInline(1);
    assert.match(m.lines()[2], /^bart~> /, 'a pending line at once');
    await new Promise((resolve) => setImmediate(resolve));
    // It starts a conversation, so it gets its empty title line, as an asked line does (doc-editor-titles).
    assert.deepEqual(m.lines().slice(1, 3), ['bart# ', `@${token} how do tutors notice struggle?`]);
    assert.match(m.lines()[3], /^bart~> /);
    assert.equal(m.asks.length, 1);
    assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].routed, m.asks[0].name], [internal, 'how do tutors notice struggle?', { id: 'route-a' }, true]);
    assert.equal(m.routes[0].text, 'how do tutors notice struggle?');
  }
});

test('handoff: build with a spec above and sure ≥ 0.8 starts a Build of the spec; otherwise Chat is asked to write the Build prompt', async () => {
  const sure = mounted([...SPEC, '@bart ok build it'], { route: async () => ({ id: 'route-b', agent: 'build', sure: 0.9 }) });
  sure.editor.askInline(SPEC.length);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sure.asks.length, 0);
  assert.equal(sure.builds.length, 1);
  assert.deepEqual([sure.builds[0].text, sure.builds[0].routedFrom], ['Add Haiku 5.5 to models.cjs.', 'route-b']);
  assert.ok(sure.builds[0].askId, 'the card takes the pending line\'s place');
  assert.equal(sure.lines()[SPEC.length], '@bart ok build it', 'the @bart line stays');
  assert.equal(sure.routes[0].specAbove, true);

  const unsure = mounted([...SPEC, '@bart ok build it'], { route: async () => ({ id: 'route-c', agent: 'build', sure: 0.7 }) });
  unsure.editor.askInline(SPEC.length);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsure.builds.length, 0);
  assert.equal(unsure.lines()[SPEC.length], '@chat ok build it');
  assert.deepEqual([unsure.asks[0].agent, unsure.asks[0].routed], ['bart', { id: 'route-c', build: true }]);

  const noSpec = mounted(['@bart build a hello page'], { route: async () => ({ id: 'route-d', agent: 'build', sure: 0.95 }) });
  noSpec.editor.askInline(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([noSpec.builds.length, noSpec.asks[0].routed.build], [0, true]);
});

test('handoff: a line Bart routes under a conversation that has a title, or as a follow-up, gets none', async () => {
  const m = mounted(['bart# Tutors', '@chat how?', 'bart> watching', 'bart> *Sonnet 5.5*', '@bart and then?'], { route: async () => ({ id: 'route-f', agent: 'chat', sure: 0.9, by: 'model' }) });
  m.editor.askInline(4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.lines().filter((l) => l.startsWith('bart#')).length, 1);
  assert.equal(m.asks[0].name, undefined);
});
test('handoff: a rule is passed to the router; --build is asked as a Build request; a line deleted while routing asks nothing', async () => {
  const m = mounted(['@bart --deep tutors'], { route: async (input) => ({ id: 'route-r', agent: input.rule.agent, sure: 1, by: 'rule', rule: input.rule.rule }) });
  m.editor.askInline(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(m.routes[0].rule, { agent: 'discover', rule: 'level' });
  assert.deepEqual(m.lines().slice(0, 2), ['bart# ', '@discover --deep tutors']);

  const b = mounted(['@bart --build add x'], { route: async (input) => ({ id: 'route-x', ...input.rule, sure: 1 }) });
  b.editor.askInline(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([b.asks[0].agent, b.asks[0].text, b.lines()[0], b.asks[0].name], ['router', '--build add x', '@bart --build add x', undefined], 'a Build gets no title line');

  let release; const later = new Promise((resolve) => { release = resolve; });
  const g = mounted(['@bart why?'], { route: () => later });
  g.editor.askInline(0);
  g.props.text = 'nothing here'; g.editor.componentDidUpdate && g.editor.componentDidUpdate({ ...g.props, text: '@bart why?\nbart~> x' });
  release({ id: 'route-g', agent: 'chat', sure: 0.9 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([g.asks.length, g.gone.length], [0, 1]);
});

test('footer Build: on every answered turn, off while the thread is at work, dark when the line was routed to build; it sends the last fenced block', () => {
  const m = mounted([...SPEC, '']);
  const html = m.editor.footHtml({ q: 0, text: 'Sonnet · high · 3s', closes: true });
  assert.match(html, /data-act="footbuild" data-turn="0" aria-label="Build" +style/);
  assert.ok(html.indexOf('data-act="regen"') < html.indexOf('footbuild') && html.indexOf('footbuild') < html.indexOf('Sonnet'), 'between Regenerate and the closing text');
  assert.match(m.editor.footHtml({ q: 0, text: 'x', busy: true }), /data-act="footbuild"[^>]* disabled /);
  const dark = m.editor.footHtml({ q: 0, text: 'Sonnet · 3s · via Bart · build' });
  assert.match(dark, /footbuild[^>]*background:#171717/);
  assert.match(dark, /data-act="viabart"/);
  assert.ok(!mounted(SPEC, { build: false }).editor.footHtml({ q: 0, text: 'x' }).includes('footbuild'), 'no onBuild, no button');

  assert.equal(m.editor.footBuild(0), true);
  assert.deepEqual([m.builds[0].text, m.builds[0].after, m.builds[0].afterLine], ['Add Haiku 5.5 to models.cjs.', SPEC.length - 1, SPEC[SPEC.length - 1]]);
  const pending = mounted(['@chat why', 'bart~> abc']);
  assert.equal(pending.editor.footBuild(0), false);
});

test('"via Bart": picking another agent rewrites the line and asks it again, the correction carried', () => {
  const m = mounted(['@chat what papers on tutors?', 'bart> An answer.', 'bart> *Sonnet · high · 3s · via Bart*', '']);
  m.editor.state.picker = { kind: 'via', i: 0 };
  m.editor.pickVia('discover');
  assert.equal(m.lines()[0], '@discover what papers on tutors?');
  assert.match(m.lines()[1], /^bart~> /);
  assert.deepEqual([m.asks[0].agent, m.asks[0].routed], ['discover', { corrected: 'discover' }]);
  // Regenerate keeps "via Bart".
  const r = mounted(['@chat why?', 'bart> An answer.', 'bart> *Sonnet · high · 3s · via Bart · build*', '']);
  r.editor.regenerate(0);
  assert.deepEqual(r.asks[0].routed, { build: true });
});
