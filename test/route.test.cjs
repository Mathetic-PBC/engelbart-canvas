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

test('routeByRule: empty → brainstorm, --build → Build, a level → discover; a model flag settles nothing (2026-10-16); a thread above settles nothing: the model', async () => {
  const { routeByRule } = await loadRoute();
  const models = DEFAULTS;
  assert.deepEqual(routeByRule('', {}), { agent: 'brainstorm', rule: 'empty' });
  assert.deepEqual(routeByRule('  ', {}), { agent: 'brainstorm', rule: 'empty' });
  assert.deepEqual(routeByRule('--build add a comment', {}), { agent: 'build', rule: '--build' });
  assert.deepEqual(routeByRule('tutors --deep', {}), { agent: 'discover', rule: 'level' });
  assert.deepEqual(routeByRule('--quick tutors', {}), { agent: 'discover', rule: 'level' });
  // Answering Discover's question (2026-10-14): Discover's, after the flags that pick otherwise.
  assert.deepEqual(routeByRule('how they notice', { current: 'discover', asking: true }), { agent: 'discover', rule: 'answering Discover' });
  assert.deepEqual(routeByRule('--build it', { current: 'discover', asking: true }), { agent: 'build', rule: '--build' });
  assert.equal(routeByRule('how they notice', { current: 'discover' }), null, 'after a guide, the model decides');
  // A model or effort flag picks how the agent runs, not which agent (2026-10-16): the rest of the line is classified.
  assert.equal(routeByRule('--haiku why?', { models }), null);
  assert.equal(routeByRule('why? --low', { models }), null);
  assert.equal(routeByRule('--sonnet --medium I want to find an excerpt from a religious text', { models }), null);
  assert.equal(routeByRule('--opus why?', {}), null, 'without the models file too');
  assert.deepEqual(routeByRule('--sonnet --medium tutors --deep', { models }), { agent: 'discover', rule: 'level' }, 'a level beside them still picks Discover');
  assert.deepEqual(routeByRule('--opus --build add a comment', { models }), { agent: 'build', rule: '--build' }, 'and --build, Build');
  assert.equal(routeByRule('what does this one entail', { models }), null);
  // 2026-10-13: under a thread, the model decides, told which agent the conversation is with (routeInputs current).
  assert.equal(routeByRule('and what about cost?', { models, current: 'brainstorm' }), null);
  assert.equal(routeByRule('more on this', { current: 'discover' }), null);
  assert.equal(routeByRule('--sol why?', { models, current: 'brainstorm' }), null, 'in a follow-up a model flag is for whichever agent answers');
  assert.equal(routeByRule('ok build it', { models, current: 'chat' }), null, 'under a Chat spec, the model reads it');
});

test('routeInputs: the section from the heading, the threads above with their tokens, and the spec of the nearest answer', async () => {
  const { routeInputs, buildTextOf } = await loadRoute();
  const { parseLines, threads } = await loadDoc();
  const lines = ['# Old', '@discover tutors', 'bart> guide', '', '# Haiku', 'Some notes.', ...SPEC, '', '@bart ok build it'];
  const at = lines.length - 1, got = routeInputs(lines, at);
  assert.ok(got.section.startsWith('# Haiku') && got.section.endsWith('@bart ok build it'));
  assert.deepEqual(got.threads.map((t) => [t.agent, t.question.slice(0, 22), t.up]), [['discover', 'tutors', at - 1], ['chat', 'give me the build prom', at - 6]]);
  assert.deepEqual([got.specAbove, got.spec, got.specTitle], [true, 'Add Haiku 5.5 to models.cjs.', 'Add Haiku 5.5 to models.cjs.']);
  assert.deepEqual(['specAbove', 'specTitle'].map((k) => routeInputs(['# A', '@chat why', 'bart> because', '@bart next'], 3)[k]), [false, '']);
  // A spec's title is its first line with words on it, as a thread's question is cut (2026-10-13).
  const long = ['@chat spec', 'bart> ```text', 'bart> ', `bart> Agent Viewer: one run list ${'and more '.repeat(20)}`, 'bart> Why: busy', 'bart> ```', '@bart yes'];
  const title = routeInputs(long, long.length - 1).specTitle;
  assert.ok(title.startsWith('Agent Viewer: one run list') && title.length <= 80, title);
  const thread = threads(lines, parseLines(lines)).find((t) => t.from === 6);
  assert.equal(buildTextOf(lines, thread.turns[0]), 'Add Haiku 5.5 to models.cjs.', 'the last fenced block');
  const plain = ['@chat why', 'bart> because', 'bart> *Sonnet · 2s*'];
  assert.equal(buildTextOf(plain, threads(plain, parseLines(plain))[0].turns[0]), 'why\n\nbecause', 'no block: the question and the answer');
  // `asking` (2026-10-14): Discover's last turn neither a research box nor a guide.
  const asking = (ls) => routeInputs([...ls, '@bart x'], ls.length).asking;
  assert.equal(asking(['@discover', 'bart> What would you like to research?']), true);
  assert.equal(asking(['@discover tutors', 'bart> I will look.', '@discover --research tutors', 'bart> ## Start here']), false, 'a box');
  assert.equal(asking(['@discover tutors', 'bart> ## Start here']), false, 'a guide');
  assert.equal(asking(['@discover tutors', 'bart> I will look.', '@discover --research tutors', 'bart> ## Start here', '@discover only after 2022', 'bart> Which years?']), true, 'asking again after a guide');
  assert.equal(asking(['@chat why', 'bart> because']), false, 'not Discover');
  // A Refine (2026-10-15): Discover's question about it is answered to Discover; a line under the direction it settled,
  // waiting in its box to be started, goes on with Discover too.
  const refined = ['@discover tutors', 'bart> I will look.', '@discover --research tutors', 'bart> ## Start here', '@discover --refine something else'];
  assert.equal(asking([...refined, 'bart> What should the search look at instead?']), true, 'asked about a Refine');
  assert.equal(asking([...refined, 'bart> I will now look at turn-taking.', '@discover --research turn-taking']), true, 'a direction waiting');
});

test('routeInputs: a thread\'s question is its first line, as plain text, cut at a word to 80 characters or fewer', async () => {
  const { routeInputs, questionLine, QUESTION_CHARS } = await loadRoute();
  const long = `Compare **this** with @[TutorTrace](lib:abc-1) and [the guide](https://x.y/z) ${'across every deployment '.repeat(220)}`.trim();
  assert.ok(long.length >= 5000);
  const lines = ['# Notes', `@chat ${long}`, 'and a second line of the question', 'bart> an answer', '', '@bart what next?'];
  const got = routeInputs(lines, lines.length - 1);
  const question = got.threads[0].question;
  assert.equal(QUESTION_CHARS, 80);
  assert.ok(question.length <= 80, `${question.length} characters`);
  assert.ok(question.startsWith('Compare this with TutorTrace and the guide across every'), question);
  assert.ok(!/[*@[\]()]/.test(question), 'plain text: no markdown, mention or link syntax');
  assert.ok(!question.includes('second line'), 'the first line only');
  const whole = questionLine(long, 100000);
  assert.ok(whole.startsWith(question) && whole[question.length] === ' ', 'cut at a word');
  assert.equal(questionLine('one two three', 7), 'one two', 'cut at a word');
  assert.equal(questionLine('x'.repeat(200)).length, 80, 'one long word is cut where it must be');
  assert.equal(questionLine('@chat --opus why\nmore'), 'why');
  // The section is sent as it is: the router keeps its last 4,000 characters once replies are left out (route.cjs).
  assert.ok(got.section.includes(long));
});

test('route-line: a 5,000-character thread question, a long section and a long workspace name are cut, never refused; a wrong type still is', async () => {
  const { registerEngelbartIpc } = require('../src/main/ipc.cjs');
  const handlers = new Map(), seen = [];
  const bart = { route: async (input) => { seen.push(input); return { id: 'route-long', agent: 'discover', sure: 0.9, by: 'model' }; }, stop: () => true };
  registerEngelbartIpc({ store: {}, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, notify: () => {}, bart, windowHandler: (fn) => (...args) => fn({ id: 'w' }, ...args), reply: () => {}, announce: () => {} });
  const routeLine = handlers.get('engelbart:route-line');
  const pick = await routeLine('p', {
    text: 'what does this one entail', section: 's'.repeat(250000) + 'END', workspaceName: 'W'.repeat(900),
    threads: [{ agent: 'chat'.repeat(10), question: 'q'.repeat(5000), up: 3 }], specAbove: false, rule: null,
  });
  assert.equal(pick.agent, 'discover', 'routed, not thrown');
  const input = seen[0];
  assert.deepEqual([input.threads[0].question.length, input.threads[0].agent.length, input.workspaceName.length, input.section.length], [400, 20, 400, 200000]);
  assert.ok(input.section.endsWith('END'), 'the section keeps its end');
  await assert.rejects(() => routeLine('p', { text: 'x', threads: [{ agent: 'chat', question: 42 }] }), /thread question must be a string/);
  await assert.rejects(() => routeLine('p', { text: 'x', section: { no: 1 } }), /section must be a string/);
  await assert.rejects(() => routeLine('p', { text: 7 }), /line must be a string/);
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

test('route.cjs (2026-10-16): the model reads the line without its model and effort flags; the record keeps the line as typed', async () => {
  const seen = {}, runs = [];
  const runLog = { start: (r) => runs.push({ ...r }), amend() {}, step() {}, output() {}, finish() {} };
  const TYPED = '--sonnet --medium I want to find an excerpt from a religious text';
  const got = await router('{"agent":"discover","sure":0.9}', { seen, runLog }).route({ ...LINE, text: TYPED, section: `# Reading\n@bart ${TYPED}` });
  assert.deepEqual([got.agent, got.by], ['discover', 'model']);
  assert.match(seen.input, /<line>\nI want to find an excerpt from a religious text\n<\/line>/);
  assert.equal(runs[0].question, TYPED);
  // A `--word` the models file does not know is the person's own text, and stays.
  await router('{"agent":"chat","sure":0.9}', { seen }).route({ ...LINE, text: 'what does --verbose do?' });
  assert.match(seen.input, /<line>\nwhat does --verbose do\?\n<\/line>/);
});

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
  // A build says whether the line means the spec above (2026-10-13); anything but true is no.
  assert.deepEqual(['{"agent":"build","sure":0.9,"spec":true}', '{"agent":"build","sure":0.9,"spec":"yes"}', '{"agent":"build","sure":0.9}'].map((raw) => route.parseReply(raw).spec), [true, false, false]);
  assert.deepEqual([(await router('{"agent":"build","sure":0.9,"spec":true}').route(LINE)).spec, (await router('{"agent":"build","sure":0.9,"spec":false}').route(LINE)).spec], [true, false]);
  assert.equal('spec' in (await router('{"agent":"chat","sure":0.9,"spec":true}').route(LINE)), false, 'only a build');
});

test('route.cjs: the model reads the line, its section without agent replies, five threads, the spec flag; never the library or mentioned files', async () => {
  const seen = {};
  const threads = Array.from({ length: 8 }, (_, n) => ({ agent: 'chat', question: `q${n} ${'x'.repeat(200)}`, up: n + 1 }));
  await router('{"agent":"chat","sure":0.9}', { seen }).route({ ...LINE, threads, section: `${'y'.repeat(6000)}\n${LINE.section}`, contextJson: '<context_json>LIBRARY</context_json>', mentioned: 'MENTIONED' });
  assert.ok(!seen.input.includes('secret answer text'), 'agent replies left out');
  assert.ok(!/context_json|LIBRARY|MENTIONED/.test(seen.input), 'no library, no context_json, no mentioned file');
  assert.match(seen.input, /<line>\nwhat does this one entail\n<\/line>/);
  assert.match(seen.input, /<spec_above>no<\/spec_above>/);
  // With a spec above, its first line (2026-10-13), so a line asking for something of its own is not built as it.
  const told = {};
  await router('{"agent":"build","sure":0.9,"spec":false}', { seen: told }).route({ ...LINE, specAbove: true, specTitle: 'Workspace editor: an @ line typed under an answer starts its own conversation' });
  assert.match(told.input, /<spec_above>yes: "Workspace editor: an @ line typed under an answer starts its own conversation"<\/spec_above>/);
  const section = seen.input.match(/<section>\n([\s\S]*?)\n<\/section>/)[1];
  assert.ok(section.length <= 4000, 'the last 4,000 characters');
  const listed = seen.input.match(/<threads>\n([\s\S]*?)\n<\/threads>/)[1].split('\n');
  assert.equal(listed.length, 5);
  assert.ok(listed[0].startsWith('- @chat, 4 lines up: "q3'), listed[0]);
  assert.ok(listed.every((line) => line.length < 120), 'each question cut to 80 characters');
});

test('route.cjs fake (ENGELBART_BART_FAKE=1): by keyword', () => {
  assert.deepEqual(['build it now', 'please implement x', 'what papers on tutors', 'prior work on this', 'help me think this through', 'why is it red'].map((t) => route.fakePick(t).agent), ['build', 'build', 'discover', 'discover', 'brainstorm', 'chat']);
  assert.deepEqual(['ok build it', 'go ahead', 'implement that', 'please implement x'].map((t) => route.fakePick(t).spec), [true, true, true, false], 'a go-ahead means the spec above; a request of its own does not');
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

test('reply: the closing line names the agent first, "Build" when Bart wanted it built, and says nothing of Bart (2026-10-12)', () => {
  const meta = { level: { name: 'Opus', effort: 'high' }, trail: [], ms: 9000 };
  const last = (lines) => lines[lines.length - 1].replace(/^bart> /, '');
  assert.equal(last(replyLines('Because.', meta, { model: true, agent: 'discover' })), '*Discover · Opus · high · 9 s*');
  assert.equal(last(replyLines('Because.', { ...meta, routed: { id: 'route-1' } }, { model: true, agent: 'discover' })), '*Discover · Opus · high · 9 s*', 'routed: no "via Bart"');
  assert.equal(last(replyLines('Because.', { ...meta, routed: { id: 'route-1', build: true } }, { model: true, agent: 'bart' })), '*Build · Opus · high · 9 s*');
  assert.equal(last(replyLines('Because.', meta, { model: false, agent: 'brainstorm' })), '*Brainstorm · 9 s*');
  assert.equal(last(replyLines('Because.', meta, { model: true, agent: 'bart' })), '*Chat · Opus · high · 9 s*');
  assert.equal(last(replyLines('Because.', meta, { model: true })), '*Opus · high · 9 s*', 'no agent given, none named');
  assert.equal(typeof attribution, 'function');
});

/* ------------------------------------------------------------- the editor */

function loadEditor() {
  const filename = path.join(__dirname, '__DocEditor-route-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports;
}
const EDITOR = loadEditor(), DocEditor = EDITOR.default;

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

test('handoff: chat, brainstorm and discover keep the @bart line as typed, ask that agent, and keep the pick on the title line', async () => {
  for (const [agent, token, internal] of [['chat', 'chat', 'bart'], ['brainstorm', 'brainstorm', 'brainstorm'], ['discover', 'discover', 'discover']]) {
    const m = mounted(['# Notes', '@bart how do tutors notice struggle?'], { route: async () => ({ id: 'route-a', agent, sure: 0.9, by: 'model' }) });
    m.editor.askInline(1);
    assert.match(m.lines()[2], /^bart~> /, 'a pending line at once');
    await new Promise((resolve) => setImmediate(resolve));
    // It starts a conversation, so it gets its empty title line, as an asked line does (doc-editor-titles), with the pick.
    assert.match(m.lines()[1], new RegExp(`^bart# \\[${token} \\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\] $`));
    assert.equal(m.lines()[2], '@bart how do tutors notice struggle?', '@bart stays @bart');
    assert.match(m.lines()[3], /^bart~> /);
    // Discover (2026-10-14): asked as any agent is; a research box comes only once it settles the direction.
    assert.equal(m.asks.length, 1);
    assert.deepEqual([m.asks[0].agent, m.asks[0].text, m.asks[0].routed, m.asks[0].name, m.asks[0].intro], [internal, 'how do tutors notice struggle?', { id: 'route-a' }, true, undefined]);
    assert.deepEqual(m.asks[0].place, { line: 2, text: '@bart how do tutors notice struggle?' });
    assert.ok(!m.lines().some((l) => l.includes('--research')));
    assert.equal(m.routes[0].text, 'how do tutors notice struggle?');
    const { threads, answeredBy } = await loadDoc();
    assert.equal(answeredBy(threads(m.lines())[0]), internal);
  }
});

test('a line Bart handed to @discover: its follow-up, Regenerate, the session and the rules are @discover\'s', async () => {
  const head = 'bart# [discover 2026-10-12T21:41:00Z] Tutors';
  const done = [head, '@bart papers on tutors?', 'bart> ## Start here', 'bart> *Discover · Opus · high · 9 s*', ''];
  // The follow-up field asks @discover, and is written as its line.
  const f = mounted(done);
  assert.match(f.editor.followHtml(f.lines(), f.editor.findTurn(f.lines(), 1).thread), />@discover</);
  f.editor.followText.set(1, 'and newer ones?');
  f.editor.sendFollow(1);
  assert.equal(f.asks[0].agent, 'discover');
  assert.equal(f.lines()[4], '@discover and newer ones?');
  assert.equal(f.asks[0].turns.length, 1, 'a follow-up to the routed turn: the same thread, the same session key');
  // Regenerate asks @discover again, as routed; the line and the title stay.
  const r = mounted(done);
  r.editor.regenerate(1);
  assert.deepEqual([r.asks[0].agent, r.asks[0].routed], ['discover', { build: false }]);
  assert.deepEqual(r.lines().slice(0, 2), [head, '@bart papers on tutors?']);
  // A follow-up from the card's field is routed with @discover as the agent the conversation is with (2026-10-13; no
  // rule), and once handed over it is the thread's next turn, as an `@bart` line. (One typed in the document under the
  // card starts a conversation of its own, doc-editor-titles.)
  // Sent to Discover again (2026-10-14), it is Discover's turn of the same conversation, which settles the new direction.
  const n = mounted(done.slice(0, 4), { route: async (input) => ({ id: 'route-n', agent: input.current, sure: 0.9, by: 'model' }) });
  n.editor.followText.set(1, 'and more?');
  n.editor.sendFollow(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([n.routes[0].rule, n.routes[0].current], [null, 'discover'], 'after a guide the model decides');
  assert.equal(n.lines()[4], '@bart and more?');
  assert.equal(n.lines().filter((l) => l.startsWith('bart#')).length, 1, 'no second title');
  assert.equal(n.asks.length, 1);
  assert.deepEqual([n.asks[0].agent, n.asks[0].intro, n.asks[0].research, n.asks[0].turns.length, n.asks[0].name], ['discover', undefined, undefined, 1, undefined]);
  const { threads } = await loadDoc();
  assert.equal(threads(n.lines())[0].turns.length, 2);
  // While Discover is still asking what to research (its last turn no box and no guide), a reply is its answer, by rule.
  const asking = mounted([head, '@bart papers on tutors?', 'bart> What are you hoping the research will help you figure out?', 'bart> *Discover · Opus · high · 4 s*'], { route: async (input) => ({ id: 'route-q', agent: 'chat', sure: 0.9, by: input.rule ? 'rule' : 'model' }) });
  asking.editor.followText.set(1, 'how they notice a student is stuck');
  asking.editor.sendFollow(1);
  assert.deepEqual([asking.routes[0].rule, asking.routes[0].current], [{ agent: 'discover', rule: 'answering Discover' }, 'discover']);
});

test('handoff: build with a spec above, sure ≥ 0.8 and meaning that spec starts a Build of the spec; otherwise Chat is asked to write the Build prompt', async () => {
  // Asked from the spec's conversation's field (2026-10-13: a line typed under it starts a conversation of its own).
  const sure = mounted(SPEC, { route: async () => ({ id: 'route-b', agent: 'build', sure: 0.9, spec: true }) });
  sure.editor.followText.set(0, 'ok build it');
  sure.editor.sendFollow(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sure.builds.length, 1);
  assert.deepEqual([sure.builds[0].text, sure.builds[0].routedFrom], ['Add Haiku 5.5 to models.cjs.', 'route-b']);
  assert.equal(sure.lines()[SPEC.length], '@bart ok build it', 'the @bart line stays');
  assert.deepEqual([sure.routes[0].specAbove, sure.routes[0].specTitle], [true, 'Add Haiku 5.5 to models.cjs.'], 'the router is told what the spec is');
  // No reply of Chat's (2026-10-13): the Build takes the line's own pending line, and no second one is put in.
  assert.equal(sure.asks.length, 0, 'Chat is not asked');
  assert.equal(sure.lines()[SPEC.length + 1], `bart~> ${sure.builds[0].askId}`, 'the line\'s own pending line');
  assert.equal(sure.lines().filter((l) => l.startsWith('bart~> ')).length, 1, 'no second pending line');
  assert.deepEqual(sure.builds[0].place, { line: SPEC.length, text: '@bart ok build it' });
  // The card in: it is that turn's answer, right under the line, with no follow-up field over it.
  const placed = sure.lines().map((l) => (l === `bart~> ${sure.builds[0].askId}` ? 'build> 0123456789' : l));
  sure.props.text = placed.join('\n');
  const drawn = sure.editor.editorHtml();
  assert.ok(!drawn.includes('data-followup='), 'no follow-up field over the card');
  const { threads } = await loadDoc();
  const turns = threads(placed)[0].turns;
  assert.deepEqual([threads(placed).length, turns.length, turns[1].q, turns[1].build], [1, 2, SPEC.length, '0123456789'], 'the card is the line\'s answer');

  // A request of its own under a spec (2026-10-13, the Agent Viewer line built as the spec above it): sure it is a build,
  // but not of that spec, so Chat writes its Build prompt.
  const own = mounted(SPEC, { route: async () => ({ id: 'route-o', agent: 'build', sure: 0.9, spec: false }) });
  own.editor.followText.set(0, 'also remove the filter tabs from the agent viewer');
  own.editor.sendFollow(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(own.builds.length, 0, 'the spec above is not built');
  assert.deepEqual([own.asks[0].agent, own.asks[0].intro, own.asks[0].routed], ['bart', undefined, { id: 'route-o', build: true }]);
  // Nor when the router does not say (an older pick, or a failed one).
  const silent = mounted(SPEC, { route: async () => ({ id: 'route-s', agent: 'build', sure: 0.9 }) });
  silent.editor.followText.set(0, 'ok build it');
  silent.editor.sendFollow(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(silent.builds.length, 0);

  const unsure = mounted(SPEC, { route: async () => ({ id: 'route-c', agent: 'build', sure: 0.7, spec: true }) });
  unsure.editor.followText.set(0, 'ok build it');
  unsure.editor.sendFollow(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unsure.builds.length, 0);
  assert.equal(unsure.lines()[SPEC.length], '@bart ok build it', 'a follow-up (2026-10-13) stays as typed; its closing line names who answered');
  assert.deepEqual([unsure.asks[0].agent, unsure.asks[0].routed], ['bart', { id: 'route-c', build: true }]);

  const noSpec = mounted(['@bart build a hello page'], { route: async () => ({ id: 'route-d', agent: 'build', sure: 0.95 }) });
  noSpec.editor.askInline(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([noSpec.builds.length, noSpec.asks[0].routed.build], [0, true]);
  assert.match(noSpec.lines()[0], /^bart# \[chat build [^\]]+\] $/, 'wanted built: kept on the title line');
  assert.equal(noSpec.lines()[1], '@bart build a hello page');
});

test('an older document with Chat\'s reply over the Build\'s card (BUILD_INTRO, before 2026-10-13) parses and draws as it did', async () => {
  const old = [...SPEC, '@bart ok build it', 'bart> Building the Haiku entry from the spec above; I expect it to change models.cjs.', 'bart> *Build · 3 s*', 'build> 0123456789'];
  const m = mounted(old);
  const drawn = m.editor.editorHtml();
  assert.ok(!drawn.includes('data-followup='), 'no follow-up field over the card');
  const foot = drawn.slice(drawn.indexOf(`data-foot="${SPEC.length}"`));
  assert.match(foot.slice(0, foot.indexOf('>')), /border-radius:0 0 10px 10px;margin-bottom:8px/, 'the reply closes its card');
  assert.ok(drawn.includes('data-build="0123456789"'), 'the card under it');
  const { threads } = await loadDoc();
  const all = threads(old);
  assert.deepEqual(all.map((t) => t.turns.length), [2], 'the reply is the next turn of the spec\'s conversation');
  assert.equal(all[0].turns[1].build, undefined, 'the card is not the turn\'s answer: the reply is');
});

test('handoff: a line Bart routes under a conversation that has a title, or as a follow-up, gets none', async () => {
  const m = mounted(['bart# Tutors', '@chat how?', 'bart> watching', 'bart> *Sonnet 5.5*'], { route: async () => ({ id: 'route-f', agent: 'chat', sure: 0.9, by: 'model' }) });
  m.editor.followText.set(1, 'and then?');
  m.editor.sendFollow(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.lines().filter((l) => l.startsWith('bart#')).length, 1);
  assert.equal(m.asks[0].name, undefined);
});
test('handoff: a rule is passed to the router; --build is asked as a Build request; a line deleted while routing asks nothing', async () => {
  const m = mounted(['@bart --deep tutors'], { route: async (input) => ({ id: 'route-r', agent: input.rule.agent, sure: 1, by: 'rule', rule: input.rule.rule }) });
  m.editor.askInline(0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(m.routes[0].rule, { agent: 'discover', rule: 'level' });
  assert.match(m.lines()[0], /^bart# \[discover [^\]]+\] $/);
  assert.equal(m.lines()[1], '@bart --deep tutors');

  const b = mounted(['@bart --build add x'], { route: async (input) => ({ id: 'route-x', ...input.rule, sure: 1 }) });
  b.editor.askInline(0);
  await new Promise((resolve) => setImmediate(resolve));
  // A Build's line gets a title line too (2026-10-13), marked a Build's, and is named; its place is the line under it.
  assert.match(b.lines()[0], /^bart# \[chat build \d{4}-\d\d-\d\dT[\d:]+Z\] $/);
  assert.deepEqual([b.asks[0].agent, b.asks[0].text, b.lines()[1], b.asks[0].name, b.asks[0].place], ['router', '--build add x', '@bart --build add x', true, { line: 1, text: '@bart --build add x' }]);
  assert.match(b.lines()[2], /^bart~> /);

  let release; const later = new Promise((resolve) => { release = resolve; });
  const g = mounted(['@bart why?'], { route: () => later });
  g.editor.askInline(0);
  g.props.text = 'nothing here'; g.editor.componentDidUpdate && g.editor.componentDidUpdate({ ...g.props, text: '@bart why?\nbart~> x' });
  release({ id: 'route-g', agent: 'chat', sure: 0.9 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual([g.asks.length, g.gone.length], [0, 1]);
});

test('handoff: when routing fails the line is asked of Chat saying so (by: error), and its run is marked as Bart\'s failure, not its pick', async () => {
  const m = mounted(['# Notes', '@bart how do tutors notice struggle?'], { route: async () => ({ agent: 'chat', sure: 0, by: 'error', error: 'thread question must be a string of at most 400 characters' }) });
  m.editor.askInline(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(m.lines()[2], '@bart how do tutors notice struggle?');
  assert.match(m.lines()[1], /^bart# \[chat \d{4}-\d\d-\d\dT[\d:]+Z\] $/);
  assert.deepEqual(m.asks[0].routed, { id: null, by: 'error', error: 'thread question must be a string of at most 400 characters' });

  // Main keeps it ({ by: 'error' } through ask-bart), and the run's record says the classifier failed.
  const { routedOf, runRecord } = require('../src/main/bart/ask.cjs');
  const routed = routedOf(m.asks[0].routed);
  const record = runRecord({ id: 'r1', agent: 'bart', provider: 'anthropic', projectId: 'p', question: 'how?', system: '', context: { project: null }, shown: [], extra: '', mode: null, pinned: false, routed });
  assert.deepEqual([record.routedBy, record.routeError, record.routedFrom], ['error', 'thread question must be a string of at most 400 characters', undefined]);
  const plain = runRecord({ id: 'r2', agent: 'bart', provider: 'anthropic', projectId: 'p', question: 'how?', system: '', context: { project: null }, shown: [], extra: '', mode: null, pinned: false, routed: routedOf({ id: 'route-a' }) });
  assert.deepEqual([plain.routedBy, plain.routedFrom], [undefined, 'route-a']);
  const { agentLabel, askSections } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/agent-map/runText.js')).href);
  assert.equal(agentLabel(record), 'Chat · Bart failed to route');
  assert.equal(agentLabel(plain), 'Chat', 'a run Bart handed over says nothing of it in its row (2026-10-13)');
  // The Agent Viewer's second section says so too, with the error.
  const [, picked] = askSections({ id: 'r1', routedTo: 'bart', via: 'direct', records: [{ ...record, steps: [] }] });
  assert.match(picked.nodes[0].label, /Bart \(classifier\) failed/);
  assert.equal(picked.nodes[1].error, 'thread question must be a string of at most 400 characters');
});

test('the button row (2026-10-13): Copy and Regenerate as icons with their names; then Delete on the right (Collapse is at the top right, 2026-10-16), the closing line\'s words not drawn (2026-10-15); no Edit or Build', () => {
  const m = mounted([...SPEC, '']);
  const html = m.editor.footHtml({ q: 0, text: 'Chat · Sonnet · high · 3 s', closes: true });
  assert.match(html, /<button class="bart-ic" data-act="copybart" data-turn="0"[^>]*aria-label="Copy"[^>]*>[\s\S]*?<\/button><span class="bart-tip"[^>]*>Copy<\/span>/, 'Copy: an icon with its tip');
  assert.match(html, /<button class="bart-ic" data-act="regen" data-turn="0" data-quiet="1" aria-label="Regenerate">[\s\S]*?<\/button><span class="bart-tip"[^>]*>Regenerate<\/span>/, 'Regenerate: an icon with its tip, opening no selector');
  for (const act of ['editturn', 'footbuild', 'viabart']) assert.ok(!html.includes(`data-act="${act}"`), `no ${act}`);
  const text = (h) => h.replace(/<span class="bart-tip"[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim();
  assert.equal(text(html), '', 'no model, effort, time or agent');
  const order = ['copybart', 'data-act="regen"', 'dropturn'].map((k) => html.indexOf(k));
  assert.deepEqual(order, [...order].sort((x, y) => x - y), 'Copy, Regenerate, Delete');
  assert.ok(!html.includes('data-foot-meta'));
  assert.ok(!html.includes('data-act="fold"'), 'no Collapse on it');
  assert.match(html, /<span style="margin-left:auto"><\/span><span style="flex:none;position:relative;display:inline-flex;"><button class="bart-ic" data-danger="1" data-act="dropturn"/, 'Delete pushed right');
  // Routed by Bart: neither Build nor an older closing line's "via Bart" is drawn.
  const routed = mounted(['bart# [chat build 2026-10-12T21:41:00Z] Haiku', '@bart build the haiku entry', ...SPEC.slice(1), '']);
  const foot = routed.editor.footHtml({ q: 1, text: 'Build · Sonnet · high · 3 s' });
  assert.equal(text(foot), '', 'no agent (2026-10-15)'); assert.ok(!foot.includes('bart-who') && !foot.includes('viabart'));
  const discover = mounted(['bart# [discover 2026-10-12T21:41:00Z] Tutors', '@bart papers?', 'bart> A guide.', 'bart> *Discover · Opus · high · 9 s*', '']);
  const drawn = discover.editor.editorHtml().replace(/ data-raw="[^"]*"/g, '');
  assert.ok(!drawn.includes('Opus · high · 9 s') && !drawn.includes('>Discover · Opus') && !/viabart|via Bart/.test(drawn), 'no model, no agent (2026-10-15)');
  const dark = m.editor.footHtml({ q: 0, text: 'Sonnet · 3 s · via Bart · build' });
  assert.equal(text(dark), '');

  // Build is still there for the [[build]] hammer in a routed build's answer.
  assert.equal(m.editor.footBuild(0), true);
  assert.deepEqual([m.builds[0].text, m.builds[0].after, m.builds[0].afterLine], ['Add Haiku 5.5 to models.cjs.', SPEC.length - 1, SPEC[SPEC.length - 1]]);
  const pending = mounted(['@chat why', 'bart~> abc']);
  assert.equal(pending.editor.footBuild(0), false);
});

/* ------------------------------------------- the [[build]] line (2026-10-12) */

const BUILD_LINE = 'Press [[build]] Build to build it.';
const ROUTED_SPEC = ['bart# [chat build 2026-10-12T21:41:00Z] Haiku', '@bart build the haiku entry', 'bart> Here it is:', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', `bart> ${BUILD_LINE}`, 'bart> *Build · Sonnet · high · 3 s*', ''];

test('a routed build run is asked to end by asking whether to build it (2026-10-13), not on the [[build]] line; a plain @chat run is not', () => {
  const { firstMessage } = require('../src/main/bart/ask.cjs');
  const context = { head: '<engelbart/>', contextJson: '', mentionedFiles: '', documents: '', now: '' };
  const sent = (routed, resumed = false) => firstMessage({ context, prior: [], question: 'build the haiku entry', resumed, routed })('<level/>');
  const routed = sent({ id: 'route-1', build: true });
  assert.ok(routed.includes('Want me to build it?'), 'it asks');
  assert.ok(routed.includes('Do not write [[build]] or tell them to press anything.'));
  assert.ok(!routed.includes(BUILD_LINE) && !routed.includes('Press [[build]]'), 'not the old line');
  assert.ok(routed.indexOf('one fenced code block') < routed.indexOf('Want me to build it?') && routed.indexOf('Want me to build it?') < routed.indexOf('<question>'), 'after the code block\'s sentence, before the question');
  assert.ok(sent({ build: true }, true).includes('Want me to build it?'), 'a resumed routed turn too');
  for (const plain of [null, { id: 'route-2', build: false }, { corrected: 'chat' }]) assert.ok(!sent(plain).includes('Want me to build it?') && !sent(plain).includes('[[build]]'), 'unrouted or not to build: no such line');
});

test('[[build]] draws as the footer\'s hammer, one unit that copies as typed; outside an answer it is only a drawing', async () => {
  const doc = await loadDoc();
  const { inlineHtml, tokShown, rawOffset, replyRawOffset, selectionMarkdown, parseLine, turnText, threads, BUILD_TOKEN } = doc;
  assert.equal(BUILD_TOKEN, '[[build]]');
  const plain = inlineHtml(BUILD_LINE);
  assert.match(plain, /^Press <span data-build-icon="1" contenteditable="false" aria-hidden="true" style="display:inline-flex;color:#4d4d4d;vertical-align:-2px;user-select:none"><svg width="14" height="14"[^>]*><path d="m15 12-8\.373/);
  assert.ok(!plain.includes('data-act'), 'outside an answer line: no click');
  assert.match(inlineHtml(BUILD_LINE, { buildTurn: 3 }), /<span data-build-icon="1" contenteditable="false" data-act="footbuild" data-turn="3" role="button"/);
  assert.deepEqual(tokShown('[[build]]'), { shown: '', pre: 1, unit: true });
  assert.ok(!inlineHtml('[[builds]] and [[x]]').includes('data-build-icon'), 'only the exact token');
  // A click right after "Press " lands before the token; past the icon, " Build" maps after it.
  const p = parseLine(`bart> ${BUILD_LINE}`);
  assert.equal(replyRawOffset(p, 6), 6);
  assert.equal(replyRawOffset(p, 7), 'Press [[build]] '.length);
  assert.equal(rawOffset({ type: 'p', text: BUILD_LINE }, 'Press  Build'.length, BUILD_LINE), 'Press [[build]] Build'.length);
  // Copying: the whole line, a piece across the icon, and the answer's Copy keep `[[build]]`.
  const ls = ROUTED_SPEC, at = ls.indexOf(`bart> ${BUILD_LINE}`);
  assert.equal(selectionMarkdown(ls, { line: at, offset: 0 }, { line: at, offset: Infinity }), BUILD_LINE);
  assert.equal(selectionMarkdown(ls, { line: at, offset: 0 }, { line: at, offset: 'Press [[build]] Build'.length }), 'Press [[build]] Build');
  assert.equal(selectionMarkdown(ls, { line: at, offset: 'Press [[build]]'.length }, { line: at, offset: Infinity }), ' Build to build it.');
  assert.ok(turnText(ls, threads(ls)[0].turns[0]).answer.endsWith(BUILD_LINE));
});

test('in an answer line, the hammer builds that turn as the footer\'s Build does; a plain @chat answer is drawn as before', () => {
  const m = mounted(ROUTED_SPEC);
  const html = m.editor.editorHtml();
  assert.match(html, /<span data-build-icon="1" contenteditable="false" data-act="footbuild" data-turn="1" role="button" aria-label="Build" title="Build" style="display:inline-flex;color:#4d4d4d;vertical-align:-2px;user-select:none;cursor:pointer"><svg width="14" height="14"/);
  assert.equal((html.match(/data-build-icon/g) || []).length, 1, 'one hammer inline, the footer\'s is its own button');
  // A click on it: the editor's click, as the browser sends it from the svg inside.
  const icon = { dataset: { act: 'footbuild', turn: '1' } };
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? icon : null) }, preventDefault() {} });
  const foot = mounted(ROUTED_SPEC);
  assert.equal(foot.editor.footBuild(1), true);
  assert.equal(m.builds.length, 1);
  assert.deepEqual(m.builds[0], foot.builds[0], 'the same Build as the footer\'s hammer');
  assert.equal(m.builds[0].text, 'Add Haiku 5.5 to models.cjs.', 'the code block, not the line under it');
  // No Build to start (read only, or no onBuild), or a turn at work: a drawing.
  assert.ok(!mounted(ROUTED_SPEC, { build: false }).editor.editorHtml().includes('data-act="footbuild" data-turn="1" role'));
  // A plain @chat answer: no such line, no hammer.
  assert.ok(!mounted([...SPEC, '']).editor.editorHtml().includes('data-build-icon'));
});

test('the [[build]] line clicked into: the hammer stays drawn and builds; the keyboard at it shows its source', () => {
  const at = ROUTED_SPEC.indexOf(`bart> ${BUILD_LINE}`), after = 'Press [[build]]'.length;
  const m = mounted(ROUTED_SPEC);
  m.editor.state.activeLine = at; m.editor.caret = { line: at, offset: after }; m.editor.byMouse = true;
  const clicked = m.editor.editorHtml();
  assert.match(clicked, /<span data-src="\[\[build\]\]" data-open="0"><span data-build-icon="1" contenteditable="false" data-act="footbuild" data-turn="1"/, 'the mouse put the caret beside it: still the hammer, still the turn\'s Build');
  m.editor.byMouse = false;
  assert.match(m.editor.editorHtml(), /<span data-src="\[\[build\]\]" data-open="1">\[\[build\]\]<\/span>/, 'the keyboard reached it: its source');
});

test('another agent for a routed line: only the title line changes, and it is asked again with the correction carried', () => {
  const m = mounted(['bart# [chat 2026-10-12T21:41:00Z] Tutors', '@bart what papers on tutors?', 'bart> An answer.', 'bart> *Chat · Sonnet · high · 3 s*', '']);
  m.editor.state.picker = { kind: 'via', i: 1 };
  m.editor.pickVia('discover');
  assert.deepEqual(m.lines().slice(0, 2), ['bart# [discover 2026-10-12T21:41:00Z] Tutors', '@bart what papers on tutors?']);
  assert.match(m.lines()[2], /^bart~> /);
  assert.deepEqual([m.asks[0].agent, m.asks[0].routed], ['discover', { corrected: 'discover' }]);
  // The same agent again asks nothing.
  const same = mounted(['bart# [chat 2026-10-12T21:41:00Z] Tutors', '@bart why?', 'bart> An answer.', 'bart> *Chat · Sonnet · high · 3 s*', '']);
  same.editor.state.picker = { kind: 'via', i: 1 };
  same.editor.pickVia('bart');
  assert.equal(same.asks.length, 0);
  // Regenerate on a turn routed to build keeps it wanted built.
  const b = mounted(['bart# [chat build 2026-10-12T21:41:00Z] Build it', '@bart build a page', 'bart> Here.', 'bart> *Build · Sonnet · high · 3 s*', '']);
  assert.deepEqual(b.editor.ranWith(b.lines(), 1).choice, { model: 'sonnet', effort: 'high' }, 'the model is read past the agent\'s name');
  b.editor.regenerate(1);
  assert.deepEqual([b.asks[0].agent, b.asks[0].routed], ['bart', { build: true }]);
});

test('an older document\'s "via Bart": picking another agent rewrites the line and asks it again, the correction carried', () => {
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

/* ------------------------------------------------------------ @create (2026-10-13) */

test('@create: the fake router sends "make a chart", "make a page" and "create a" to Create; a prompt for one is Chat\'s, a change Build\'s', () => {
  const picks = (lines) => lines.map((line) => route.fakePick(line).agent);
  assert.deepEqual(picks([
    'make a chart of CHI submissions by year',
    'make an html page summarizing the papers in my library on AI-assisted programming',
    'write up a summary page of these papers as html',
    'create a dataset of the tutors in my notes',
  ]), ['create', 'create', 'create', 'create']);
  assert.deepEqual(picks(['can you create the build prompt for this', 'create a prompt for the chart', 'give me the build prompt for a chart', 'make the file icons different', 'what papers should I read']), ['chat', 'chat', 'chat', 'build', 'discover']);
  assert.ok(route.PICKS.includes('create'));
  assert.match(require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT, /- create: the person wants a NEW STANDALONE ARTIFACT[^]*"make a chart of CHI submissions by year" → create[^]*"chat\|brainstorm\|discover\|create\|build"/);
});

test('Bart\'s prompt (2026-10-14): classify by what the person wants back; their own project history is chat, published research is discover', () => {
  const prompt = require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /Classify by WHAT THE PERSON WANTS BACK FROM THIS TURN, not by what subject the request happens to mention\./);
  assert.match(prompt, /- Topic does not determine the agent\. Desired result does\./);
  assert.match(prompt, /- chat: [^\n]*retrieval of their own notes, decisions, conversations or prior work/);
  assert.match(prompt, /- discover: the person wants external source material found, to go read or quote: published research and other people's prior work[^\n]*Their own notes, decisions, Builds and chats are not Discover\./);
  assert.match(prompt, /"what did we decide about the router\?" → chat/);
  assert.match(prompt, /"what papers should I read on agent debugging\?" → discover/);
  const order = ['1. Do they want an existing thing changed now? → build', '2. Do they want a new standalone artifact/file made? → create', '3. Do they want external source material found to read or quote: research, a text, or a passage in one? → discover', '4. Is what they are after their own understanding, ideas, judgment or direction, rather than a particular answer? → brainstorm', '5. Otherwise'].map((k) => prompt.indexOf(k));
  assert.ok(order.every((at) => at >= 0) && order.every((at, n) => !n || at > order[n - 1]), 'the decision procedure, in order');
  // What the model is given stays described, tag by tag.
  for (const tag of ['<line>', '<section>', '<threads>', '<spec_above>', '<current>']) assert.ok(prompt.includes(tag), tag);
});

test('Bart\'s prompt (2026-10-16): Chat and Brainstorm are told apart by the interaction wanted, not by phrases; the evals hold the cases (prompt text only: scripts/route-eval.mjs asks the model)', () => {
  const prompt = require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /- chat: the person is after a particular result Engelbart supplies[^\n]*list of ideas[^\n]*Chat cannot make files\./);
  assert.match(prompt, /- brainstorm: the person is after a change in THEIR OWN understanding, ideas, judgment or direction: coming to understand a subject they set out to learn/);
  assert.match(prompt, /Chat or Brainstorm:\n\nDecide by what the person is after, inferred from the whole line and the conversation[^\n]*no particular words are needed or decisive\./);
  assert.match(prompt, /- Chat: they are after something Engelbart can hand over in a reply[^\n]*\n- Brainstorm: they are after a change in their own understanding or thinking/);
  // The shortcuts it must not take, one list; and an unmarked request is answered.
  const shortcuts = prompt.match(/None of these decides it by itself:\n((?:- [^\n]*\n)+)/);
  assert.ok(shortcuts, 'the shortcuts list');
  for (const word of ['unsure or confused', 'A question mark', 'A specific topic', '"learn"', 'Needing a clarification']) assert.ok(shortcuts[1].includes(word), word);
  assert.match(prompt, /When nothing in the line or its conversation points to the person's own understanding or thinking being what they are after, a request is answered: Chat\./);
  // No phrase rules or wording examples of their own (David: "it's about intent").
  assert.ok(!prompt.includes('is Brainstorm even when no topic is named'));
  assert.ok(!/^BRAINSTORM$/m.test(prompt), 'no list of Brainstorm phrases');
  assert.ok(!prompt.includes('Pairs on one subject') && !/" → brainstorm$/m.test(prompt), 'no Brainstorm wording examples');
  // Follow-ups: read in their conversation, which the model is told it sees without the agent's replies.
  assert.match(prompt, /Agent replies are left out of what you are given, so you cannot see what the agent last said/);
  assert.match(prompt, /classify the kind of interaction the conversation is having, not the single turn/);
  assert.match(prompt, /after Chat: "help me work through it myself instead" → Brainstorm/);
  assert.match(prompt, /- In Chat, a further question, pushback or confusion about the answer stays Chat\./);
  assert.ok(prompt.indexOf('Follow-ups:') < prompt.indexOf('Important distinctions:'), 'follow-ups near the Chat/Brainstorm test');
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const cases = read('fixtures/route-eval.jsonl');
  for (const [line, expected, current] of [['help me learn', 'brainstorm'], ['wait, what does policy mean here?', 'brainstorm', 'brainstorm'], ['help me work through it myself instead', 'brainstorm', 'chat'], ['and what about the learning rate?', 'chat', 'chat']]) {
    assert.ok(cases.some((c) => c.line === line && c.expected === expected && (c.current || undefined) === current), `eval: ${line}${current ? ` in ${current}` : ''} → ${expected}`);
  }
  // The held-out paraphrases stay out of the prompt, and their follow-ups are read as the editor sends them: with the
  // thread's title line, so the agent's replies are left out.
  const held = read('fixtures/route-eval-intent.jsonl');
  assert.ok(held.length >= 70);
  for (const c of held) assert.ok(!prompt.toLowerCase().includes(c.line.replace(/^(--\S+\s+)+/, '').toLowerCase()), `held out: ${c.line}`);
  for (const c of held.filter((c) => c.current && !c.specAbove)) assert.ok(route.sectionText(c.section).includes('[agent reply omitted]') && !/^bart> /m.test(route.sectionText(c.section)), `replies left out: ${c.line}`);
  for (const tag of ['bs-indirect', 'chat-rec', 'chat-uncertain', 'chat-flags', 'bs-flags', 'fu-bs', 'fu-chat', 'fu-bs-switch', 'fu-chat-switch', 'reg-discover', 'reg-create', 'reg-build']) assert.ok(held.some((c) => c.tag === tag), tag);
});

test('Bart\'s prompt (2026-10-16): Discover finds outside texts and passages, not only research; Chat interprets them and finds their own material (prompt text only: scripts/route-eval.mjs asks the model)', () => {
  const prompt = require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /- discover: [^\n]*religious texts\), or a specific passage, excerpt or quote in them\. It need not be academic[^\n]*a search with details missing is still Discover\./);
  assert.match(prompt, /- chat: [^\n]*interpretation of a text or passage/);
  assert.ok(!/religious/.test(prompt.match(/Important distinctions:[^]*?Examples:/)[0]), 'no rule for religious texts of its own');
  for (const [line, agent] of [['I want to find an excerpt from a religious text', 'discover'], ['find a passage about forgiveness in a religious text', 'discover'], ['find a historical speech about reconciliation', 'discover'], ['what does this passage mean?', 'chat'], ['explain forgiveness in Christianity', 'chat'], ['find the excerpt I saved in my notes yesterday', 'chat'], ['make a markdown document collecting religious passages about forgiveness', 'create']]) {
    assert.ok(prompt.includes(`- "${line}" → ${agent}`), `${line} → ${agent}`);
  }
  const cases = fs.readFileSync(path.join(__dirname, '../fixtures/route-eval.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const [line, expected] of [['I want to find an excerpt from a religious text', 'discover'], ['--sonnet --medium I want to find an excerpt from a religious text', 'discover'], ['Find the excerpt I saved in my notes yesterday', 'chat']]) {
    assert.ok(cases.some((c) => c.line === line && c.expected === expected), `eval: ${line} → ${expected}`);
  }
});

test('@create: the classifier\'s create pick stands at SURE_ENOUGH, as the others do (2026-10-14: no longer 0.8)', async () => {
  const sure = await router('{"agent":"create","sure":0.9}').route(LINE);
  assert.deepEqual([sure.agent, sure.sure], ['create', 0.9]);
  assert.deepEqual(await router('{"agent":"create","sure":0.6}').route(LINE).then((r) => [r.agent, r.sure]), ['create', 0.6], 'Chat makes no files: an unsure create pick is still Create, with its 5 s Cancel');
  assert.deepEqual(await router('{"agent":"create","sure":0.5}').route(LINE).then((r) => [r.agent, r.sure]), ['chat', 0.5], 'below SURE_ENOUGH');
  assert.deepEqual(await router('{"agent":"discover","sure":0.7}').route(LINE).then((r) => r.agent), 'discover');
  assert.equal(route.CREATE_SURE, undefined);
});

test('routing regression (2026-10-14): "can you make a file going over the changes we made" is Create, by its end result', async () => {
  const runs = [];
  const runLog = { start: (r) => runs.push({ ...r }), amend: (id, fields) => Object.assign(runs.find((r) => r.id === id), fields), step() {}, output() {}, finish() {} };
  const LINE_FILE = 'can you make a file going over the changes we made';
  // The reply the model gave in the workspace, which was sent to Chat (CREATE_SURE 0.8); Chat said it could not write files.
  const fake = (raw) => router(raw, { runLog });
  const out = await fake('{"agent":"create","sure":0.6}').route({ text: LINE_FILE, section: `# Concision\n@bart ${LINE_FILE}` });
  assert.deepEqual([out.agent, out.sure], ['create', 0.6]);
  // When the line goes elsewhere than the model said, the record keeps what it said.
  await fake('{"agent":"create","sure":0.4}').route({ text: LINE_FILE, section: '' });
  assert.deepEqual([runs[runs.length - 1].pick, runs[runs.length - 1].said, runs[runs.length - 1].sure], ['chat', 'create', 0.4]);
  assert.equal(runs[0].said, undefined, 'none when the model\'s pick stands');
  // The prompt draws the distinction by the result wanted, not by keywords: the summary is a step toward the file.
  const prompt = require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT;
  assert.match(prompt, /making it may first take reading, gathering or summarizing them: that work is part of Create's job, and the request is still Create/);
  assert.match(prompt, /Judge the request by its end result, not by the steps needed to get there\./);
  assert.match(prompt, /Polite or conversational wording \("can you…"[^\n]*is still a request for the action\./);
  assert.match(prompt, /Asking HOW to do something[^\n]*→ Chat\./);
  assert.match(prompt, /- chat: [^\n]*Chat cannot make files\./);
  const contrast = ['"go over what we changed today" → chat', '"can you put what we changed today in a doc" → create', '"how would I put what we changed today in a doc?" → chat', '"add today\'s changes to the changelog file" → build'].map((k) => prompt.indexOf(k));
  assert.ok(contrast.every((at, n) => at >= 0 && (!n || at > contrast[n - 1])), 'the four-way contrast, in order');
  assert.ok(!prompt.includes(LINE_FILE), 'the failing line itself stays out of the prompt: it is the eval\'s');
  // The eval holds the line and its contrasts, in the workspace they came from.
  const cases = fs.readFileSync(path.join(__dirname, '../fixtures/route-eval.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const [line, expected] of [[LINE_FILE, 'create'], ['summarize the changes we made', 'chat'], ['make a file summarizing the changes we made', 'create'], ['how would I make a file summarizing the changes we made?', 'chat']]) {
    assert.ok(cases.some((c) => c.line === line && c.expected === expected), `eval: ${line} → ${expected}`);
  }
});

test('@create: a line Bart sent to Create is asked at once (2026-10-15, David: no "Create · Starts in 5 s"), titled [create <when>]', async () => {
  const m = mounted(['# Notes', '@bart make a chart of CHI submissions by year'], { route: async () => ({ id: 'route-c', agent: 'create', sure: 0.9, by: 'model' }) });
  m.editor.askInline(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(m.lines()[1], /^bart# \[create \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\] $/, 'the pick on its title line');
  assert.equal(m.lines()[2], '@bart make a chart of CHI submissions by year', '@bart stays @bart');
  const askId = m.lines()[3].replace(/^bart~> /, '');
  assert.equal(m.asks.length, 1, 'asked at once');
  assert.deepEqual([m.asks[0].askId, m.asks[0].agent, m.asks[0].text, m.asks[0].routed, m.asks[0].name], [askId, 'create', 'make a chart of CHI submissions by year', { id: 'route-c' }, true]);
  // Until it says what it is making, its row is a run thinking like any other: no countdown, no Cancel, no file row.
  m.props.asks = { [askId]: { agent: 'create', name: 'Opus', effort: 'high', activity: 'Thinking', at: Date.now(), lines: [], log: [] } };
  m.editor.lastHtml = null;
  const html = m.editor.editorHtml();
  assert.ok(!/Starts in|cancelwait|data-create-pending/.test(html));
  assert.match(html, /Thinking · Opus high/);
});

test('@create at work (2026-10-15, David): a thinking line until its line on what it is making comes, then that line, in the words the answer keeps, and what it is doing under it', () => {
  const m = mounted(['# Notes', 'bart# [create 2026-10-14T20:00:00Z] ', '@create create a html page descriing everyting weve worked on', 'bart~> c1', '']);
  const run = { agent: 'create', name: 'Opus', effort: 'high', activity: 'Thinking', at: Date.now(), lines: [], log: [] };
  const html = (ask) => { m.props.asks = { c1: ask }; m.editor.lastHtml = null; return m.editor.editorHtml(); };
  const thinking = html(run);
  assert.ok(!thinking.includes('data-create-pending'), 'no file row before the line');
  assert.match(thinking, /Thinking · Opus high/);
  assert.ok(!html({ ...run, activity: 'Writing', lines: ['Done.'] }).includes('data-create-pending'), 'the model\'s own text is not the line');
  const line = 'An HTML page on the work in this workspace: the agents, the five pillars and what is still open.';
  const told = html({ ...run, making: line, activity: 'Writing work-summary.html · 9 KB' });
  assert.ok(told.includes('data-create-pending'));
  assert.equal((told.match(/an HTML page on the work in this workspace/g) || []).length, 1, 'said once');
  assert.ok(!told.includes('>Creating an HTML page…<'), 'the line itself, not a few words for it');
  // Starting "Creating" (2026-10-15, David), the acronym's capital kept.
  assert.match(told, new RegExp(`>Creating an HTML page on the work in this workspace: the agents, the five pillars and what is still open…</div><div[^>]*>[\\s\\S]*?align-items:baseline[^>]*><span[^>]*>Building the page · 9 KB so far</span></span>`), 'the line, then the row saying what it is doing, in words: no file name (2026-10-15, David)');
  // No line, but a file being written: the few words its kind gives.
  const writing = html({ ...run, log: ['Writing summary.html'] });
  assert.ok(writing.includes('data-create-pending') && writing.includes('>Creating an HTML page…</div>'));
  const { makingLabel, creatingLine } = EDITOR;
  assert.equal(creatingLine('A diagram of the highlighting, Stage, and browser-window problems we discussed.'), 'Creating a diagram of the highlighting, Stage, and browser-window problems we discussed…');
  assert.equal(creatingLine('Two charts of CHI submissions.'), 'Creating two charts of CHI submissions…');
  assert.equal(creatingLine('Creating a page on tutors.'), 'Creating a page on tutors…');
  assert.equal(creatingLine(''), '');
  const { createDoing } = EDITOR;
  for (const [activity, kind, wrote, said] of [
    ['Thinking', 'diagram', false, 'Planning the diagram'], ['Thinking', 'diagram', true, 'Finishing up'], ['Writing', 'HTML page', false, 'Planning the HTML page'], ['Thinking', null, false, 'Thinking it through'],
    ['Writing ui-workspace-conversation-diagram.svg', 'diagram', false, 'Drawing the diagram'], ['Writing summary.html · 12 KB', 'page', false, 'Building the page · 12 KB so far'],
    ['Writing data.csv', 'dataset', false, 'Filling in the dataset'], ['Editing summary.html', 'page', true, 'Revising the page'],
    ['Reading …/Concision in Agent Responses/workspace.md', 'diagram', false, 'Reading your notes'], ['Reading src/main/bart/ask.cjs', 'diagram', false, 'Reading the code'], ['Reading tutors.pdf', 'diagram', false, 'Reading a paper'],
    ['Reading arxiv.org', 'diagram', false, 'Reading a page on arxiv.org'], ['Searching code for “stage”', 'diagram', false, 'Searching the code'], ['Listing **/*.md', 'diagram', false, 'Looking through your files'],
    ['Searching the web for “tutors”', 'diagram', false, 'Searching the web for “tutors”'],
  ]) assert.equal(createDoing(activity, kind, wrote), said, activity);
  assert.equal(makingLabel('', 'create a html page descriing everyting weve worked on', null), 'Creating an HTML page');
  assert.equal(makingLabel('An HTML page covering the work', '', null), 'Creating an HTML page');
  assert.equal(makingLabel('', 'make an html of the results', null), 'Creating an HTML page');
  assert.equal(makingLabel('', 'write a markdown document on it', null), 'Creating a Markdown document');
  assert.equal(makingLabel('', 'make a chart of CHI submissions by year', null), 'Creating a chart');
  assert.equal(makingLabel('', 'make an svg of the agents', null), 'Creating a diagram');
  // A file open in a Stage tab has no grey behind its row (2026-10-14).
  const made = mounted(['bart#+ [create 2026-10-14T20:00:00Z] A page', '@create make a page', 'bart> A page.', 'bart>', 'bart> @[page.html](made:c1/page.html)', 'bart>', 'bart> *Create · Opus · high · 9 s*', '']);
  made.props.madeOpen = new Set(['c1/page.html']); made.editor.lastHtml = null;
  const row = made.editor.editorHtml().match(/<div data-made-row="c1\/page\.html"[^>]*>/);
  assert.ok(row && !/background/.test(row[0]), 'no background on the row');
  assert.ok(!made.editor.editorHtml().includes('#f3f3f3'));
});

test('a made file\'s peek (2026-10-15, David): a rest of the pointer on its name or icon shows the file in a small card over the page, nothing in the document moves; leaving or a press hides it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const made = mounted(['bart#+ [create 2026-10-14T20:00:00Z] A diagram', '@create make an svg of the agents', 'bart> A diagram.', 'bart>', 'bart> @[agents.svg](made:c1/agents.svg)', 'bart>', 'bart> *Create · Opus · high · 9 s*', '']);
  made.props.madeFiles = { 'c1/agents.svg': { name: 'agents.svg', type: 'svg', url: 'file:///made/agents.svg', saved: { name: 'agents' } } };
  made.editor.lastHtml = null;
  const html = made.editor.editorHtml();
  assert.equal((html.match(/data-made-peek="c1\/agents\.svg"/g) || []).length, 2, 'on the name and the icon');
  const framed = () => { made.editor.lastHtml = null; return made.editor.editorHtml().includes('data-made-frame="c1/agents.svg"'); };
  const peeked = () => made.editor.state.pop && made.editor.state.pop.made;
  const el = { dataset: { madePeek: 'c1/agents.svg', name: 'agents.svg' }, isConnected: true, getBoundingClientRect: () => ({ left: 10, right: 90, top: 100, bottom: 120 }) };
  made.editor.peekMade(el);
  assert.ok(!peeked(), 'nothing while the pointer only passes');
  t.mock.timers.tick(400);
  assert.deepEqual(peeked(), { key: 'c1/agents.svg', name: 'agents.svg' }, 'a rest: the peek');
  assert.deepEqual(made.editor.state.pop.anchor, { left: 10, right: 90, top: 100, bottom: 120 }, 'under the name');
  assert.ok(!framed(), 'the document is as it was: no frame opens in it');
  assert.equal(made.editor.madeBodyHtml(peeked(), made.props.madeFiles['c1/agents.svg']), '<img src="file:///made/agents.svg" alt="agents.svg" draggable="false">', 'the peek shows the file as its frame would');
  made.editor.unpeekMade();
  assert.equal(made.editor.state.pop, null, 'leaving hides it');
  made.editor.peekMade(el); made.editor.unpeekMade(); t.mock.timers.tick(400);
  assert.equal(made.editor.state.pop, null, 'left before the rest: it never shows');
  made.editor.peekMade(el); t.mock.timers.tick(400);
  made.editor.madeAct('madestage', { dataset: { made: 'c1/agents.svg', name: 'agents.svg' } });
  assert.equal(made.editor.state.pop, null, 'a press hides it');
  // A file whose frame is open (the chevron) gets no peek.
  made.editor.madeAct('madeexpand', { dataset: { made: 'c1/agents.svg', name: 'agents.svg' } });
  assert.ok(framed());
  made.editor.peekMade(el); t.mock.timers.tick(400);
  assert.equal(made.editor.state.pop, null);
});

test('a made file\'s card is small (2026-10-15, David): 280 by 168, floating over the page', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/renderer/workspace/MadePeek.jsx'), 'utf8');
  assert.ok(src.includes('data-overlay="1"') && src.includes('width: 280,') && src.includes('height: 168,'));
});

test('a collapsed Create conversation\'s files stand on lines of their own, flush with its title\'s icon, not indented (2026-10-15, David)', () => {
  const made = mounted(['bart#+ [create 2026-10-14T20:00:00Z] A page', '@create make a page', 'bart> A page.', 'bart>', 'bart> @[page.html](made:c1/page.html)', 'bart>', 'bart> *Create · Opus · high · 9 s*', '']);
  made.editor.lastHtml = null;
  const html = made.editor.editorHtml(), at = html.indexOf('data-made-folded="1"');
  assert.ok(at >= 0);
  const block = html.slice(at, html.indexOf('data-made-row=', at));
  assert.ok(block.includes('<div style="padding:0 0 6px">'), 'no left padding under the title');
  assert.match(html, /data-made-row="c1\/page\.html" style="[^"]*padding:0 6px 0 6px;margin:0 -6px/, 'the row\'s own 6px taken back: flush');
});

test('@create: a typed @create starts at once', () => {
  const typed = mounted(['@create make a chart of CHI submissions by year']);
  typed.editor.askInline(0);
  assert.equal(typed.routes.length, 0);
  assert.deepEqual([typed.asks.length, typed.asks[0].agent, typed.asks[0].text], [1, 'create', 'make a chart of CHI submissions by year']);
  assert.match(typed.lines()[0], /^bart# \[create [^\]]+\] $/);
  const empty = mounted(['@create']);
  empty.editor.askInline(0);
  assert.equal(empty.asks.length, 0, 'nothing on the line: nothing to make');
});

/* ------------------------------------------- a conversation across agents (2026-10-13) */

const CHAT_DONE = ['bart# [chat 2026-10-13T09:00:00Z] Tutors', '@bart how do tutors notice struggle?', 'bart> By watching.', 'bart> *Chat · Sonnet · high · 3 s*', ''];
const settled = () => new Promise((resolve) => setImmediate(resolve));
// The run with `askId` answering, as main writes it (Workspace placeAnswer): its pending line gives way to the lines.
const answerAt = (m, askId, lines) => { m.props.text = m.lines().flatMap((line) => (line === `bart~> ${askId}` ? lines : [line])).join('\n'); };

test('no "Choosing an agent…": a line Bart is routing shows the pending row every run shows ("Thinking"); "Starting a Build" stays', () => {
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.ok(!workspace.includes('Choosing an agent'), 'the router\'s pending line sets no activity');
  assert.ok(workspace.includes("activity: 'Starting a Build'"));
  const m = mounted(['@bart why?', 'bart~> r1', '']);
  m.props.asks = { r1: { docKey: 'k', agent: 'router' } };
  const html = m.editor.editorHtml();
  assert.match(html, /Thinking/);
  assert.ok(!/Choosing an agent/.test(html));
});

test('Chat → Discover → Chat: a typed follow-up is an @bart line Bart routes, told the agent the card is with; one card, each turn its own agent and footer', async () => {
  let pick = 'discover';
  const m = mounted(CHAT_DONE, { route: async (input) => ({ id: `route-${input.current}`, agent: pick, sure: 0.9, by: 'model' }) });
  // The follow-up field: typed, it is routed (no "@chat" line written), the card's agent passed as `current`.
  m.editor.followText.set(1, 'papers on this?');
  m.editor.sendFollow(1);
  assert.equal(m.lines()[4], '@bart papers on this?');
  assert.match(m.lines()[5], /^bart~> /, 'the line and its pending line in one change');
  assert.equal(m.routes.length, 1);
  assert.deepEqual([m.routes[0].text, m.routes[0].current, m.routes[0].rule], ['papers on this?', 'chat', null]);
  await settled();
  // Discover (2026-10-14): asked alone; it settles the direction, and the window puts the research box under its reply.
  assert.deepEqual([m.asks[0].agent, m.asks[0].intro, m.asks[0].routed.id, m.asks[0].name], ['discover', undefined, 'route-chat', undefined]);
  assert.deepEqual(m.asks[0].turns, [{ question: 'how do tutors notice struggle?', answer: 'By watching.', agent: 'bart' }], 'the earlier turn says Chat answered it');
  assert.equal(m.lines()[0], CHAT_DONE[0], 'the title line keeps the first pick');
  answerAt(m, m.asks[0].askId, ['bart> I will look for tutoring papers.', 'bart> *Discover · Sonnet · high · 3 s*', '@discover --research tutoring papers', 'bart~> box-1']);
  assert.equal(m.editor.askBoxed('box-1'), true);
  assert.deepEqual([m.asks[1].agent, m.asks[1].research], ['discover', true]);
  answerAt(m, 'box-1', ['bart> ## Start here', 'bart> *Discover · Opus · high · 9 s*']);

  // Discover answered: the card's next follow-up is routed with Discover as `current`; Bart sends it back to Chat.
  pick = 'chat';
  m.editor.followText.set(1, 'which is cheapest?');
  m.editor.sendFollow(1);
  await settled();
  assert.equal(m.routes[1].current, 'discover');
  assert.equal(m.asks[2].agent, 'bart');
  assert.deepEqual(m.asks[2].turns.map((t) => t.agent), ['bart', 'discover', 'discover']);
  answerAt(m, m.asks[2].askId, ['bart> The first.', 'bart> *Chat · Sonnet · high · 2 s*']);

  const { threads, answeredBy } = await loadDoc();
  const all = threads(m.lines());
  assert.equal(all.length, 1, 'one card');
  assert.deepEqual(all[0].turns.map((t) => t.agent), ['bart', 'discover', 'discover', 'bart']);
  assert.deepEqual([answeredBy(all[0]), all[0].routedTo], ['bart', 'bart']);
  assert.equal(m.lines()[0], CHAT_DONE[0], 'still the first pick');
  // Each turn is drawn as its own agent's; its closing line names it (the foot no longer draws it, 2026-10-13).
  const at = m.editor.layout(m.lines());
  assert.deepEqual([at.get(1).agent, at.get(4).agent, at.get(7).agent, at.get(10).agent], ['bart', 'discover', 'discover', 'bart']);
  const html = m.editor.editorHtml();
  assert.ok(!html.includes('Bart picked this'), 'no picker on the foot');
  assert.deepEqual([1, 4].map((q) => html.includes(`data-folded-row="${q}"`)), [true, true], 'the earlier turns are one row each');
  // Regenerate asks each turn of the agent that answered it; another agent for a follow-up leaves the title line alone.
  m.editor.regenerate(4);
  assert.deepEqual([m.asks[3].agent, m.asks[3].routed], ['discover', { build: false }]);
});

test('a follow-up Bart is less than 0.8 sure wants another agent stays with the agent the conversation is with', async () => {
  const unsure = route.decide({ agent: 'chat', sure: 0.75 }, 'brainstorm');
  assert.deepEqual(unsure, { agent: 'brainstorm', sure: 0.75 });
  assert.deepEqual(route.decide({ agent: 'chat', sure: 0.8 }, 'brainstorm'), { agent: 'chat', sure: 0.8 }, 'sure enough: it switches');
  assert.deepEqual(route.decide({ agent: 'brainstorm', sure: 0.3 }, 'brainstorm'), { agent: 'brainstorm', sure: 0.3 }, 'the same agent, however unsure');
  // A conversation with Discover (2026-10-13) has its search in a box already: a reply is Chat's, a new search only at 0.8.
  assert.deepEqual(route.decide({ agent: 'chat', sure: 0.75 }, 'discover'), { agent: 'chat', sure: 0.75 });
  assert.deepEqual(route.decide({ agent: 'discover', sure: 0.75 }, 'discover'), { agent: 'chat', sure: 0.75 }, 'not sure enough it wants a new search');
  assert.deepEqual(route.decide({ agent: 'discover', sure: 0.85 }, 'discover'), { agent: 'discover', sure: 0.85 });
  assert.deepEqual(route.decide({ agent: 'brainstorm', sure: 0.7 }, 'discover'), { agent: 'brainstorm', sure: 0.7 }, 'another agent as for a line with no conversation');
  assert.deepEqual(route.decide(null, 'discover'), { agent: 'chat', sure: 0 });
  assert.match(require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT, /After Discover: "what do you think these findings mean for us\?" → Chat/i);
  assert.deepEqual(route.decide(null, 'brainstorm'), { agent: 'brainstorm', sure: 0 }, 'an unread reply leaves it there');
  assert.deepEqual(route.decide({ agent: 'build', sure: 0.7 }, 'chat'), { agent: 'chat', sure: 0.7 });
  assert.deepEqual(route.decide({ agent: 'brainstorm', sure: 0.7 }), { agent: 'brainstorm', sure: 0.7 }, 'a line starting a conversation: 0.6 as before');
  // Through the router: `current` is given the model as <current>, and a timeout leaves the line where it was.
  const seen = {};
  const stays = await router('{"agent":"chat","sure":0.7}', { seen }).route({ ...LINE, current: 'brainstorm' });
  assert.deepEqual([stays.agent, stays.sure], ['brainstorm', 0.7]);
  assert.match(seen.input, /<current>brainstorm<\/current>\n\n<line>/);
  const timedOut = await router(Object.assign(new Error('Command failed: timed out'), { killed: true, signal: 'SIGTERM' })).route({ ...LINE, current: 'brainstorm' });
  assert.equal(timedOut.agent, 'brainstorm');
  assert.ok(!(await router('{"agent":"chat","sure":0.9}', { seen: {} }).route(LINE)).error);
  assert.match(require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT, /Only switch agents when you are confident the user has changed modes/);
  assert.equal(route.fakePick('and then?', 'brainstorm').agent, 'brainstorm', 'the fake router stays put too');
  assert.equal(route.fakePick('and then?', 'discover').agent, 'chat', 'but not with Discover');
  // In the editor: the router's own fallback, with no answer, is the thread's agent (a follow-up from the card's field).
  const m = mounted(CHAT_DONE.slice(0, 4), { route: async () => null });
  m.editor.followText.set(1, 'and then?');
  m.editor.sendFollow(1);
  await settled();
  assert.equal(m.asks[0].agent, 'bart');
  // With Discover (2026-10-13), Chat: a failed routing never starts a search.
  const d = mounted(['@discover tutors', 'bart> A guide.', 'bart> *Discover · Opus · high · 9 s*'], { route: async () => { throw new Error('down'); } });
  d.editor.followText.set(0, 'and newer?');
  d.editor.sendFollow(0);
  await settled();
  assert.deepEqual([d.asks.length, d.asks[0].agent, d.asks[0].intro], [1, 'bart', undefined]);
  assert.equal(d.lines()[3], '@bart and newer?', 'a follow-up stays as typed');
});

test('a Brainstorm card answer is written @brainstorm and asked of Brainstorm: it is never routed', async () => {
  const card = require('../src/main/bart/card.cjs');
  const FREE = { say: '', card: 'questions', questions: { items: [{ id: 'q', type: 'free', title: 'What would change your mind?' }] }, ready: false };
  const body = replyLines(card.cardBody(JSON.stringify(FREE)).body, { level: { name: 'Sonnet', effort: 'high' }, trail: [], ms: 3000 }, { model: false, agent: 'brainstorm' });
  const m = mounted(['bart# [brainstorm 2026-10-13T09:00:00Z] Aims', '@bart help me figure out what to measure', ...body, ''], { route: async () => ({ agent: 'chat', sure: 1 }) });
  const entry = m.editor.cardsOf(m.lines()).byQ.get(1);
  assert.deepEqual([entry.agent, entry.live], ['brainstorm', true]);
  m.editor.sendCard(1, 'skip');
  assert.equal(m.routes.length, 0, 'not routed');
  assert.equal(m.asks.length, 1);
  assert.equal(m.asks[0].agent, 'brainstorm');
  assert.ok(m.lines().some((line) => /^@brainstorm /.test(line)), m.lines().join('\n'));
});

test('old threads read as before: untitled @chat and @discover follow-ups, "via Bart" feet, and an @discover line under Chat starting its own card', async () => {
  const { threads, answeredBy, footAgent, migrateChatLines } = await loadDoc();
  const chat = ['@chat why?', 'bart> because', 'bart> *Sonnet · high · 3s*', '@chat and then?', 'bart> then this', 'bart> *Sonnet · high · 2s*'];
  const [one] = threads(chat);
  assert.deepEqual([threads(chat).length, one.turns.length, one.turns.map((t) => t.agent), answeredBy(one)], [1, 2, ['bart', 'bart'], 'bart']);
  const via = ['@discover papers?', 'bart> A guide.', 'bart> *Opus · high · 9s · via Bart*', '@discover more?', 'bart> More.'];
  assert.deepEqual(threads(via).map((t) => [t.turns.length, answeredBy(t)]), [[2, 'discover']]);
  assert.equal(footAgent('*Sonnet · high · 3s · via Bart*'), null, 'an older closing line names no agent');
  assert.deepEqual(['*Chat · Sol · high · 41 s*', '*Build · Sonnet · high · 3 s*', '*Discover · Opus · 9 s*', '*Brainstorm*'].map(footAgent), ['bart', 'bart', 'discover', 'brainstorm']);
  const apart = ['@chat why?', 'bart> because', '@discover papers?', 'bart> A guide.'];
  assert.deepEqual(threads(apart).map((t) => answeredBy(t)), ['bart', 'discover'], 'an agent\'s own line for another agent still starts a card of its own');
  // An @bart line typed under a card but not asked yet is no turn of it.
  assert.equal(threads([...chat, '@bart next']).length, 2);
  // An answered @bart follow-up whose closing line names its agent is not migrated to @chat; an older answered @bart is.
  const routedFollow = [...CHAT_DONE.slice(1, 4), '@bart papers?', 'bart> A guide.', 'bart> *Discover · Opus · high · 9 s*'];
  assert.equal(migrateChatLines(routedFollow.join('\n')).count, 0);
  assert.equal(migrateChatLines(['@bart why?', 'bart> because', 'bart> *Sonnet · 2s*'].join('\n')).count, 1);
});

test('a run asked of another agent than the turn before it starts a session of its own, the earlier turns labelled with who answered', async () => {
  const { conversationBlock } = require('../src/main/bart/context.cjs');
  const turns = [{ question: 'why?', answer: 'because', agent: 'bart' }, { question: 'papers?', answer: 'A guide.', agent: 'discover' }];
  assert.equal(conversationBlock(turns, { agent: 'bart' }), '<conversation>\n<turn n="1" agent="Chat">\n<asked>\nwhy?\n</asked>\n<answered>\nbecause\n</answered>\n</turn>\n<turn n="2" agent="Discover">\n<asked>\npapers?\n</asked>\n<answered>\nA guide.\n</answered>\n</turn>\n</conversation>');
  assert.ok(!conversationBlock([turns[0]], { agent: 'bart' }).includes('agent='), 'all with the agent asked now: as before');
  // The agent rides on the turn into main, and is no part of the session key (the session itself: bart.test.cjs).
  const { threadKey, cleanTurns } = require('../src/main/bart/ask.cjs');
  const { turnsInput } = require('../src/main/ipc.cjs');
  const ref = { kind: 'workspace', workspaceId: 'w' };
  const said = cleanTurns(turnsInput([{ question: 'why?', answer: 'because', agent: 'discover' }, { question: 'and?', answer: 'so', agent: 'nobody' }]));
  assert.deepEqual(said.map((t) => t.agent), ['discover', undefined]);
  assert.equal(threadKey('p', ref, said), threadKey('p', ref, cleanTurns([{ question: 'why?', answer: 'because' }, { question: 'and?', answer: 'so' }])));
});

test('@create in a conversation: its closing line names Create, and a Create thread is no `current` to stay with', async () => {
  const { footAgent } = await loadDoc();
  assert.equal(footAgent('*Create · Sonnet · high · 41 s*'), 'create');
  assert.equal(route.fakePick('and then?', 'create').agent, 'chat', 'Create keeps no conversation: a follow-up is routed afresh');
  assert.deepEqual(route.decide({ agent: 'create', sure: 0.8 }, 'chat'), { agent: 'create', sure: 0.8 }, 'switching to Create needs SURE_TO_SWITCH, as any switch does');
  assert.deepEqual(route.decide({ agent: 'create', sure: 0.79 }, 'brainstorm'), { agent: 'brainstorm', sure: 0.79 });
  const { turnsInput } = require('../src/main/ipc.cjs');
  assert.deepEqual(turnsInput([{ question: 'a chart', answer: 'Made.', agent: 'create' }]).map((t) => t.agent), ['create']);
});

/* ----------------------------------------------- answer cards and pending lines, five changes (2026-10-13) */

/** The rendered row of line `i`: its opening tag, and what it holds up to the next line's row. */
function rowOf(html, i) {
  const at = html.indexOf(`data-line="${i}"`); assert.ok(at >= 0, `line ${i} is drawn`);
  const start = html.lastIndexOf('<', at), next = html.indexOf(`data-line="${i + 1}"`);
  return html.slice(start, next < 0 ? undefined : html.lastIndexOf('<', next));
}
const clickAct = (m, dataset, disabled = false) => m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? { dataset, disabled, closest: () => null } : null) }, preventDefault() {} });
const TITLED = ['bart# [chat 2026-10-13T09:00:00Z] Retry logic', '@chat why retry?', 'bart> because', 'bart> *Chat · Sonnet · high · 3 s*', ''];

test('a click on Regenerate opens the model selector (2026-10-16, David: as hovering it did until 2026-10-13); its button asks again on what is picked; @brainstorm\'s and @discover\'s too', () => {
  const m = mounted(TITLED);
  let asked = null; m.editor.regenerate = (q, choice) => { asked = { q, choice }; };
  const el = { dataset: { act: 'regen', turn: '1', quiet: '1' }, disabled: false, closest: () => null, parentElement: { setAttribute() {}, removeAttribute() {} }, getBoundingClientRect: () => ({ left: 10, right: 38, top: 100, bottom: 128 }) };
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? el : null) }, preventDefault() {} });
  assert.equal(asked, null, 'nothing asked yet');
  assert.deepEqual([m.editor.state.picker.kind, m.editor.state.picker.i], ['regen', 1], 'the selector, for that answer');
  m.editor.sendPicked();
  assert.equal(asked.q, 1, 'its button asks again');
  assert.equal(m.editor.state.picker, null);
  // Clicked again while open, it closes.
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? el : null) }, preventDefault() {} });
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? el : null) }, preventDefault() {} });
  assert.equal(m.editor.state.picker, null);
  // @brainstorm's and @discover's too (2026-10-16, David): main asks them on what is picked, for that run (ask.cjs turnPlan).
  asked = null; el.dataset.plain = '1';
  m.editor.editorClick({ target: { closest: (sel) => (sel === '[data-act]' ? el : null) }, preventDefault() {} });
  assert.equal(asked, null);
  assert.equal(m.editor.state.picker.kind, 'regen');
});

test('a conversation\'s Collapse is its first exchange\'s, a double chevron named Collapse conversation (2026-10-16, David); every later exchange\'s folds it alone', () => {
  const DOUBLE = '<path d="m17 11-5-5-5 5"></path><path d="m17 18-5-5-5 5"></path>', SINGLE = '<path d="m6 9 6 6 6-6"></path>';
  // Titled, its only exchange: the corner's Collapse collapses the conversation to its title's row.
  const titled = mounted(TITLED);
  const html = titled.editor.editorHtml();
  assert.ok(!rowOf(html, 1).includes('data-chip'), 'no chip beside an answered question');
  assert.match(rowOf(html, 1), /data-corner="1"[^>]*><button type="button" class="bart-fold" data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse conversation" title="Collapse conversation"><svg/, 'its Collapse, top right');
  assert.ok(rowOf(html, 1).includes(DOUBLE), 'a double chevron');
  assert.ok(!/data-foot="1"[^>]*>(?:(?!<\/div><div data-line)[\s\S])*data-act="fold"/.test(html), 'not on the button row');
  clickAct(titled, { act: 'fold', turn: '1' });
  assert.equal(titled.lines()[0], 'bart#+ [chat 2026-10-13T09:00:00Z] Retry logic', 'collapsed to its title');
  assert.deepEqual(titled.lines().slice(1), TITLED.slice(1), 'its exchange is not folded as well');

  // Titled, three answered: the second's and the third's fold their exchange alone, whatever else is folded.
  const threeLines = [...TITLED.slice(0, 4), '@chat and timeouts?', 'bart> those too', 'bart> *Chat · Sonnet · high · 2 s*', '@chat and jitter?', 'bart> jitter too', 'bart> *Chat · Sonnet · high · 2 s*', ''];
  const replies = (m, q) => m.lines().slice(q + 1, q + 3);
  const three = mounted(threeLines), drawn = three.editor.editorHtml();
  assert.match(rowOf(drawn, 1), /data-corner="1"[^>]*><button[^>]*data-act="fold" data-turn="1"[^>]*aria-label="Collapse conversation"/, 'the first: the conversation\'s');
  assert.ok(rowOf(drawn, 1).includes(DOUBLE));
  for (const q of [4, 7]) {
    assert.match(rowOf(drawn, q), new RegExp(`data-corner="${q}"[^>]*><button type="button" class="bart-fold" data-act="fold" data-turn="${q}" aria-expanded="true" aria-label="Collapse" title="Collapse"><svg`), `turn at ${q}: its own`);
    assert.ok(rowOf(drawn, q).includes(SINGLE) && !rowOf(drawn, q).includes(DOUBLE), `turn at ${q}: the single chevron`);
  }
  assert.ok(!rowOf(drawn, 4).includes('data-fold-turn'), 'a click on the question is no Collapse');
  clickAct(three, { act: 'fold', turn: '4' });
  assert.equal(three.lines()[0], threeLines[0], 'turn 2: the conversation stays open');
  assert.deepEqual(replies(three, 4), ['bart+> those too', 'bart+> *Chat · Sonnet · high · 2 s*'], 'turn 2 folds');
  assert.deepEqual(replies(three, 1), threeLines.slice(2, 4), 'turn 1 stays open');
  assert.deepEqual(replies(three, 7), threeLines.slice(8, 10), 'turn 3 stays open');
  // Turns 1 and 2 folded, turn 3's Collapse folds turn 3 alone: the last one open no longer collapses the conversation.
  three.editor.toggleFold(1);
  assert.deepEqual(replies(three, 1), ['bart+> because', 'bart+> *Chat · Sonnet · high · 3 s*']);
  clickAct(three, { act: 'fold', turn: '7' });
  assert.equal(three.lines()[0], threeLines[0], 'turn 3: the conversation stays open');
  assert.deepEqual(replies(three, 7), ['bart+> jitter too', 'bart+> *Chat · Sonnet · high · 2 s*'], 'turn 3 folds');
  // Turn 1's Collapse: the title line folds, the turns' own reply lines are as they were.
  const first = mounted(threeLines);
  first.editor.collapseTurn(1);
  assert.match(first.lines()[0], /^bart#\+ /, 'the conversation collapses');
  assert.deepEqual(first.lines().slice(1), threeLines.slice(1), 'no turn\'s reply lines change');
  assert.equal(first.editor.findTurn(first.lines(), 1).thread.folded, true, 'thread.folded');
  // A folded turn 1's line expands that turn alone.
  const back = mounted(threeLines);
  back.editor.toggleFold(1);
  clickAct(back, { act: 'fold', turn: '1' });
  assert.deepEqual(back.lines(), threeLines, 'expanded, the conversation not collapsed');

  // Untitled: its first exchange's Collapse folds it alone, the single chevron.
  const untitledLines = [...TITLED.slice(1, 4), '@chat and timeouts?', 'bart> those too', 'bart> *Chat · Sonnet · high · 2 s*', ''];
  const untitled = mounted(untitledLines), uh = untitled.editor.editorHtml();
  assert.match(rowOf(uh, 0), /data-corner="0"[^>]*><button type="button" class="bart-fold" data-act="fold" data-turn="0" aria-expanded="true" aria-label="Collapse" title="Collapse">/);
  assert.ok(!rowOf(uh, 0).includes(DOUBLE));
  clickAct(untitled, { act: 'fold', turn: '0' });
  assert.match(untitled.lines()[1], /^bart\+> because$/, 'the first folded');
  assert.equal(untitled.lines()[4], 'bart> those too', 'the second stays open');

  // A turn of it at work: turn 1's Collapse folds turn 1 alone, the single chevron; the conversation stays open.
  const runLines = [...TITLED.slice(0, 4), '@chat and timeouts?', 'bart~> r1', ''];
  const running = mounted(runLines), rh = running.editor.editorHtml();
  assert.ok(!rh.includes('Collapse once it answers'));
  assert.match(rowOf(rh, 1), /data-act="fold" data-turn="1" aria-expanded="true" aria-label="Collapse" title="Collapse">/);
  assert.ok(rowOf(rh, 1).includes(SINGLE) && !rowOf(rh, 1).includes(DOUBLE), 'running: the single chevron');
  clickAct(running, { act: 'fold', turn: '1' });
  assert.equal(running.lines()[0], runLines[0], 'the conversation stays open');
  assert.match(running.lines()[2], /^bart\+> because$/, 'turn 1 folds');
  assert.equal(running.lines()[5], 'bart~> r1', 'the one at work as it was');
  // collapseAll is as it was: a titled conversation at work collapses whole; an untitled one's answered exchanges fold.
  const all = mounted(runLines);
  clickAct(all, { act: 'foldall', turn: '1' });
  assert.match(all.lines()[0], /^bart#\+ /, 'collapseAll collapses the conversation');
  assert.deepEqual(all.lines().slice(1), runLines.slice(1));
  const bare = mounted([...runLines.slice(1)]);
  clickAct(bare, { act: 'foldall', turn: '0' });
  assert.match(bare.lines()[1], /^bart\+> because$/);
  assert.equal(bare.lines()[4], 'bart~> r1');
});

test('three turns, the first two folded: two one-line rows (no foot, no answer), then the open turn; a click expands one', () => {
  const long = 'what about the case where the server is slow but never fails outright, and the retries pile up across every request of the session?';
  const lines = ['@chat why retry?', 'bart+> because', 'bart+> *Chat · Sonnet · high · 3 s*', `@chat ${long}`, 'bart+> it depends', 'bart+> *Chat · Sonnet · high · 4 s*', '@chat and backoff?', 'bart> exponential', 'bart> *Chat · Sonnet · high · 2 s*', ''];
  const m = mounted(lines), html = m.editor.editorHtml(), drawn = html.replace(/ data-raw="[^"]*"/g, '');
  for (const q of [0, 3]) {
    const row = rowOf(html, q);
    assert.match(row, /^<div data-line="\d+" data-raw="[^"]*" contenteditable="false" data-readonly="1" data-folded-row/, `${q}: read-only`);
    assert.match(row, /white-space:nowrap/, `${q}: one line`);
    assert.ok(!row.includes('editturn') && !row.includes('data-chip'));
    assert.ok(!html.includes(`data-foot="${q}"`), `${q}: no foot`);
  }
  assert.ok(!drawn.includes('because') && !drawn.includes('it depends'), 'no answer text');
  assert.ok(rowOf(html, 3).includes(long.slice(0, 60)), 'the long question, in its one line');
  assert.match(rowOf(html, 6), /padding:0px 16px 0px;background:#fafafa;border-radius:0 0 0 0/, 'the open turn goes on in the same card, under the folded lines (2026-10-13)');
  assert.match(rowOf(html, 0), /padding:14px 16px 6px;background:#fafafa;border-radius:10px 10px 0 0/, 'the folded lines open the card');
  assert.ok(drawn.includes('exponential') && html.includes('data-foot="6"'));
  clickAct(m, { act: 'fold', turn: '3' });
  assert.deepEqual(m.lines().slice(4, 6), ['bart> it depends', 'bart> *Chat · Sonnet · high · 4 s*']);
  assert.ok(m.editor.editorHtml().includes('data-foot="3"') && rowOf(m.editor.editorHtml(), 0).includes('data-folded-row'));
});

/* "yes" builds: a routed build's answer asks, and the reply under it is a line for Build with the answer's spec above. */
const ASKED_BUILD = ['bart# [chat build 2026-10-13T09:00:00Z] Haiku', '@bart add Haiku 5.5 to the models', 'bart> Here it is:', 'bart> ```', 'bart> Add Haiku 5.5 to models.cjs.', 'bart> ```', 'bart> Want me to build it?', 'bart> *Build · Sonnet · high · 3 s*', ''];

test('"yes" under an answer that asks "Want me to build it?": from the reply field or typed under it, Bart is sent the spec, and a build pick starts the Build with no reply of Chat\'s', async () => {
  // The reply field.
  const field = mounted(ASKED_BUILD, { route: async () => ({ id: 'route-y', agent: 'build', sure: 0.95, spec: true, by: 'model' }) });
  field.editor.followText.set(1, 'yes');
  field.editor.sendFollow(1);
  await settled();
  assert.deepEqual([field.routes[0].text, field.routes[0].specAbove, field.routes[0].current], ['yes', true, 'chat']);
  assert.equal(field.asks.length, 0, 'no reply of Chat\'s');
  assert.deepEqual([field.builds.length, field.builds[0].text], [1, 'Add Haiku 5.5 to models.cjs.'], 'the Build, of the answer\'s fenced block');
  assert.equal(field.lines().filter((l) => l.startsWith('bart~> ')).length, 1, 'on the "yes" line\'s own pending line');
  assert.equal(field.lines()[field.lines().indexOf(`bart~> ${field.builds[0].askId}`) - 1], '@bart yes');
  // The card in: the "yes" turn's answer, in the titled conversation, which collapses to its title as Builds' do.
  const carded = field.lines().map((l) => (l === `bart~> ${field.builds[0].askId}` ? 'build> 0123456789' : l));
  const { threads: threadsOf } = await loadDoc(), [one, ...rest] = threadsOf(carded);
  assert.deepEqual([rest.length, one.titleLine, one.turns.length, one.turns[1].build], [0, 0, 2, '0123456789']);
  field.props.text = carded.join('\n'); field.props.builds = { '0123456789': { id: '0123456789', status: 'accepted', final: true } };
  assert.deepEqual(field.editor.foldable(carded), [{ title: 0, folded: false }], 'it collapses once the Build is done');
  field.props.builds = { '0123456789': { id: '0123456789', status: 'running' } };
  assert.deepEqual(field.editor.foldable(carded), [], 'not while it runs');
  // A line typed under the answer: a conversation of its own, but the spec above is the same.
  const typed = mounted([...ASKED_BUILD.slice(0, -1), '@bart yes', ''], { route: async () => ({ id: 'route-t', agent: 'build', sure: 0.9, spec: true, by: 'model' }) });
  typed.editor.askInline(ASKED_BUILD.length - 1);
  await settled();
  assert.deepEqual([typed.routes[0].text, typed.routes[0].specAbove], ['yes', true]);
  assert.equal(typed.asks.length, 0);
  assert.deepEqual([typed.builds.length, typed.builds[0].text], [1, 'Add Haiku 5.5 to models.cjs.']);
  // No fenced block above: Bart is told so, and a "yes" there is Chat's (nothing is built even if he says build).
  const plain = ['@bart should we add Haiku?', 'bart> It would help. Want a plan?', 'bart> *Chat · Sonnet · high · 3 s*', ''];
  const chat = mounted(plain, { route: async () => ({ id: 'route-n', agent: 'chat', sure: 0.85, by: 'model' }) });
  chat.editor.followText.set(0, 'yes'); chat.editor.sendFollow(0); await settled();
  assert.deepEqual([chat.routes[0].specAbove, chat.builds.length, chat.asks[0].agent, chat.asks[0].intro], [false, 0, 'bart', undefined]);
  const unsure = mounted(plain, { route: async () => ({ id: 'route-u', agent: 'build', sure: 0.95, spec: true, by: 'model' }) });
  unsure.editor.followText.set(0, 'yes'); unsure.editor.sendFollow(0); await settled();
  assert.deepEqual([unsure.builds.length, unsure.asks[0].agent, unsure.asks[0].routed.build], [0, 'bart', true]);
  // The prompt and the eval: "yes", "yes build it", "go ahead" with a spec above → build; "yes" with none → chat.
  const prompt = require('../src/main/bart/route-system-prompt.cjs').ROUTE_SYSTEM_PROMPT;
  assert.ok(prompt.includes('- "yes", "yes build it" or "go ahead", as a follow-up with a spec above → build, spec true'));
  assert.ok(prompt.includes('- "ok build it", with a spec above → build, spec true'));
  const cases = fs.readFileSync(path.join(__dirname, '../fixtures/route-eval.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const [line, specAbove, expected] of [['yes', true, 'build'], ['yes build it', true, 'build'], ['go ahead', true, 'build'], ['yes', false, 'chat']]) {
    assert.ok(cases.some((c) => c.line === line && c.specAbove === specAbove && c.expected === expected), `eval: ${line}, spec ${specAbove} → ${expected}`);
  }
});

test('a line being routed names, from the start, the level it would start on; the run keeps it until its first step', async () => {
  const { readQuestion, readDiscover } = require('../src/main/bart/question.cjs');
  const { askStarted, askProgressed } = EDITOR;
  const label = (m, asks) => { m.props.asks = asks; const html = m.editor.editorHtml(); const at = html.indexOf('data-pending='); const row = html.slice(at, html.indexOf('</div></div>', at)); return (row.match(/<span class="t"[^>]*>([^<]*)<\/span>/) || [])[1]; };
  // A new line: Chat's first step, from the models file (not a fixed "Opus high").
  const chatStep = readQuestion('why?', DEFAULTS).steps[0];
  const fresh = mounted(['@bart why?', ''], { route: () => new Promise(() => {}) });
  fresh.editor.askInline(0);
  assert.deepEqual(fresh.routes[0].level, { name: chatStep.name, effort: chatStep.effort });
  // Pinned by flags (or picked by hand, which writes the flags in): that step.
  const pinned = mounted(['@bart --opus --high why?', ''], { route: () => new Promise(() => {}) });
  pinned.editor.askInline(0);
  assert.deepEqual(pinned.routes[0].level, { name: 'Opus', effort: 'high' });
  // A follow-up of a conversation with Discover falls back to Chat; one with Brainstorm names nothing (its model is never shown).
  const discover = mounted(['@discover tutors', 'bart> ## Start here', 'bart> *Discover · Opus · high · 9 s*', ''], { route: () => new Promise(() => {}) });
  discover.editor.followText.set(0, 'which is cheapest?'); discover.editor.sendFollow(0);
  assert.deepEqual([discover.routes[0].current, discover.routes[0].level], ['discover', { name: chatStep.name, effort: chatStep.effort }]);
  // One answering Discover's question goes to Discover by rule (2026-10-14): its level.
  const asked = mounted(['@discover tutors', 'bart> What are you hoping to figure out?', 'bart> *Discover · Opus · high · 9 s*', ''], { route: () => new Promise(() => {}) });
  asked.editor.followText.set(0, 'how they notice'); asked.editor.sendFollow(0);
  assert.deepEqual([asked.routes[0].rule.rule, asked.routes[0].level.name], ['answering Discover', readDiscover('tutors', DEFAULTS, []).steps[0].name]);
  const brainstorm = mounted(['@brainstorm a plan', 'bart> Think about it.', 'bart> *Brainstorm · 9 s*', ''], { route: () => new Promise(() => {}) });
  brainstorm.editor.followText.set(0, 'more'); brainstorm.editor.sendFollow(0);
  assert.equal(brainstorm.routes[0].level, undefined);
  assert.equal(fresh.editor.routingLevel(['@bart --deep tutors'], 0, '--deep tutors', 'discover').name, readDiscover('--deep tutors', DEFAULTS, []).steps[0].name, 'a discover rule: its level');

  // The pending row, as Workspace keeps it: routing, handed over, the first step.
  const m = mounted(['@bart --opus --high why?', 'bart~> r1', '']);
  let held = { r1: { docKey: 'k', agent: 'router', name: 'Opus', effort: 'high' } };
  assert.equal(label(m, held), 'Thinking · Opus high', 'while Bart routes it');
  held = askStarted(held, 'r1', { docKey: 'k', agent: 'bart' });
  assert.equal(label(m, held), 'Thinking · Opus high', 'handed to Chat: kept, not a bare "Thinking"');
  held = { r1: askProgressed(held.r1, { activity: 'Reading the workspace' }) };
  assert.equal(label(m, held), 'Reading the workspace · Opus high', 'the activity once, then the level');
  held = { r1: askProgressed(held.r1, { step: 1, of: 2, name: 'Opus', effort: 'high', movedUp: 0 }) };
  assert.equal(label(m, held), 'Thinking · Opus high');
  // Handed to Discover: its level once its run starts; to Brainstorm: its step, which names no model.
  let d = askStarted({ r1: { docKey: 'k', agent: 'router', name: chatStep.name, effort: chatStep.effort } }, 'r1', { docKey: 'k', agent: 'discover' });
  assert.equal(label(m, d), `Thinking · ${chatStep.name} ${chatStep.effort}`);
  d = { r1: askProgressed(d.r1, { step: 1, of: 1, name: 'Opus', effort: 'max', movedUp: 0 }) };
  assert.equal(label(m, d), 'Thinking · Opus max');
  const b = { r1: askProgressed(askStarted({ r1: { docKey: 'k', agent: 'router', name: 'Sonnet', effort: 'high' } }, 'r1', { docKey: 'k', agent: 'brainstorm' }).r1, { step: 1, of: 1, movedUp: 0 }) };
  assert.equal(b.r1.name, '', 'Brainstorm\'s step drops the level it was routed with');
  // "Starting a Build" is as it was; Workspace wires the router's level and merges.
  const workspace = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/Workspace.jsx'), 'utf8');
  assert.match(workspace, /\[askId\]: \{ docKey: key, agent: 'router', \.\.\.\(level \? \{ name: level\.name, effort: level\.effort \} : \{\}\) \}/);
  assert.match(workspace, /setAsks\(\(current\) => askStarted\(current, askId, \{ docKey: key, agent: agent \|\| 'bart', at: \(current\[askId\] && current\[askId\]\.at\) \|\| Date\.now\(\) \}\)\)/);
  assert.match(workspace, /\[askId\]: askProgressed\(ask, progress\)/);
  assert.ok(workspace.includes("activity: 'Starting a Build'"));
});

test('routeInputs: a Build card under its --build line, titled or not, is no answer to route by: the spec above and no current conversation, as before (2026-10-13)', async () => {
  const { routeInputs } = await loadRoute();
  for (const head of [[], ['bart# [chat build 2026-10-13T09:00:00Z] X']]) {
    const lines = [...SPEC, '', ...head, '@bart --build make X', 'build> abc0123456', '@bart build that'];
    const got = routeInputs(lines, lines.length - 1);
    assert.deepEqual([got.specAbove, got.spec, got.current], [true, 'Add Haiku 5.5 to models.cjs.', null], head.length ? 'titled' : 'untitled');
  }
});
