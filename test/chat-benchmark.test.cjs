'use strict';

// The Agent Viewer's Benchmark tab (2026-10-13; src/main/agent-map/benchmark.cjs, src/renderer/screens/Benchmark.jsx):
// every Chat question in the notes with the answer the note keeps beside the same question asked again, and a note on
// each. A fake Chat stands in for the model; the notes are only read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { createRunLog } = require('../src/main/bart/runlog.cjs');
const { CLAUDE_TOOLS } = require('../src/main/bart/ask.cjs');
const { HERE } = require('../src/main/bart/context.cjs');
const { registerAgentMapIpc } = require('../src/main/agent-map/ipc.cjs');
const { createChatBenchmark, askChat, choiceOf, footChoice, AT_ONCE } = require('../src/main/agent-map/benchmark.cjs');

const MODELS = { ...normalizeModels(null), provider: 'anthropic' };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `engelbart-bench-${name}-`));

// Two Chat questions, the second a follow-up in the same thread; a Brainstorm answer, which is no Chat question; text after.
const NOTE = [
  '# Plan',
  'Some text before.',
  '@chat What is X?',
  'bart> X is **one** thing.',
  'bart> ',
  'bart> *Chat · Opus · high · 12 s*',
  '@chat And Y?',
  'bart> - Y is two.',
  'bart> - and three',
  'bart> ',
  'bart> *Chat · Sonnet · medium · 5 s*',
  '',
  '@brainstorm a topic',
  'bart> A card.',
  'bart> ',
  'bart> *Brainstorm · 3 s*',
  '',
  'Later text.',
  '',
].join('\n');

const homeDir = tmp('home');
const layout = ensureHome(homeDir);
let ctx, project, workspace, note, noteFile;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, { name: 'Bench', directory: tmp('code') });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Plans' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'A workspace with no Chat answers.\n');
  note = await projects.createNote(ctx, project.id, { name: 'Fixture', workspaceId: workspace.id, text: NOTE });
  noteFile = path.join(project.dir, note.path);
});
test.after(async () => { await db.closeAll(); });

/** Every file of the project folder but its databases, path → bytes. */
function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const full = path.join(dir, String(entry));
    if (/\.pglite(\/|$)/.test(String(entry)) || !fs.statSync(full).isFile()) continue;
    out[String(entry)] = fs.readFileSync(full).toString('base64');
  }
  return out;
}

/** A fake Chat: answers "NEW n: <question>" after a tick, and keeps every job it was given. */
function fakeChat() {
  const jobs = [];
  let n = 0;
  const chat = async (_ctx, job, { signal }) => {
    jobs.push(job);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (signal.aborted) throw Object.assign(new Error('Stopped.'), { kind: 'stopped' });
    n += 1;
    return `NEW ${n}: ${job.question}`;
  };
  return { chat, jobs };
}

const benchmark = (file, chat, runLog = null) => createChatBenchmark({ file, context: async () => ctx, chat, runLog });
const entriesOf = (listed) => listed.groups.flatMap((group) => group.entries);

test('two Chat questions in a note, one a follow-up, are two entries with their old answers; Run fills in both', async () => {
  const before = snapshot(project.dir);
  const file = path.join(tmp('store'), 'chat-benchmark.json');
  const { chat, jobs } = fakeChat();
  const bench = benchmark(file, chat);
  const changes = [];
  bench.subscribe((change) => changes.push(change));

  const listed = await bench.list();
  assert.equal(listed.running, false);
  assert.deepEqual(listed.groups.map((group) => group.name), ['Fixture']);
  assert.deepEqual(entriesOf(listed).map((entry) => [entry.question, entry.old, entry.new, entry.note]), [
    ['What is X?', 'X is **one** thing.', {}, ''],
    ['And Y?', '- Y is two.\n- and three', {}, ''],
  ]);

  assert.equal(await bench.run(), true);
  assert.equal(changes[0].running, true);
  assert.deepEqual(changes[0].new, { running: true });
  await bench.idle();
  const after = entriesOf(await bench.list());
  assert.deepEqual(after.map((entry) => entry.new.answer).sort(), ['NEW 1: What is X?', 'NEW 2: And Y?'].sort());
  assert.equal(changes[changes.length - 1].running, false);

  // Asked on the old closing line's model and effort, with the earlier turn of the thread.
  const second = jobs.find((job) => job.question === 'And Y?');
  assert.equal(second.foot, '*Chat · Sonnet · medium · 5 s*');
  assert.deepEqual(second.turns, [{ question: 'What is X?', answer: 'X is **one** thing.', agent: 'bart' }]);
  // The document cut off at the question line, the question marked, no stage, the earlier turn as <conversation>.
  assert.match(second.message, /^<engelbart>\nproject: Bench/);
  assert.match(second.message, /<context_json>/);
  assert.match(second.message, /<note name="Fixture">\n# Plan\nSome text before\.[\s\S]*@chat And Y\?\n<<< this is the question being asked now >>>\n<\/note>/);
  assert.ok(second.message.includes(HERE));
  assert.ok(!second.message.includes('Later text.'), 'nothing below the question is sent');
  assert.match(second.message, /<stage>none<\/stage>/);
  assert.match(second.message, /<conversation>\n<turn n="1">[\s\S]*What is X\?[\s\S]*<\/conversation>$/);
  const first = jobs.find((job) => job.question === 'What is X?');
  assert.deepEqual(first.turns, []);
  assert.ok(!first.message.includes('<conversation>'));
  assert.ok(!first.message.includes('And Y?'));

  // Kept by note path and question, with the prompt's hash; nothing else written.
  const kept = JSON.parse(fs.readFileSync(file, 'utf8')).entries;
  const rel = path.relative(ctx.dataRoot, noteFile);
  assert.deepEqual(Object.keys(kept).sort(), [`${rel}\nAnd Y?`, `${rel}\nWhat is X?`]);
  for (const value of Object.values(kept)) assert.match(value.promptHash, /^[0-9a-f]{16}$/);

  assert.deepEqual(snapshot(project.dir), before, 'the notes and documents are byte-for-byte as they were');
  assert.equal(fs.readFileSync(noteFile, 'utf8'), NOTE);
});

test('a note typed in an entry survives reloading the tab and a Run again', async () => {
  const file = path.join(tmp('notes'), 'chat-benchmark.json');
  const { chat } = fakeChat();
  const bench = benchmark(file, chat);
  const [x] = entriesOf(await bench.list());
  bench.setNote(x.key, 'Old is better here.');

  // The tab opened again, by a benchmark made again (the app restarted).
  const again = benchmark(file, chat);
  assert.equal(entriesOf(await again.list())[0].note, 'Old is better here.');
  await again.runOne(x.key);
  await again.idle();
  const after = entriesOf(await again.list())[0];
  assert.equal(after.note, 'Old is better here.');
  assert.equal(after.new.answer, 'NEW 1: What is X?');
  // Run again replaces the answer and keeps the note.
  await again.runOne(x.key);
  await again.idle();
  const twice = entriesOf(await benchmark(file, chat).list())[0];
  assert.deepEqual([twice.note, twice.new.answer], ['Old is better here.', 'NEW 2: What is X?']);
});

test('Run replays only questions with no new answer, `atOnce` at a time (3 in the app); a failure shows its error; Stop stops', async () => {
  assert.equal(AT_ONCE, 3);
  const file = path.join(tmp('pool'), 'chat-benchmark.json');
  let live = 0, most = 0, fail = true;
  const chat = async (_ctx, job, { signal }) => {
    live += 1; most = Math.max(most, live);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error('Stopped.'), { kind: 'stopped' });
      if (fail && job.question === 'And Y?') throw new Error('Claude Code was not found on the login shell PATH.');
      return `again: ${job.question}`;
    } finally { live -= 1; }
  };
  const bench = createChatBenchmark({ file, context: async () => ctx, chat, atOnce: 1 });
  await bench.list();
  await bench.run();
  await bench.idle();
  assert.equal(most, 1);
  let [x, y] = entriesOf(await bench.list());
  assert.equal(x.new.answer, 'again: What is X?');
  assert.deepEqual(y.new, { error: 'Claude Code was not found on the login shell PATH.' });
  // Run again: the one with an answer is left; the failed one is asked.
  fail = false;
  await bench.run();
  await bench.idle();
  [x, y] = entriesOf(await bench.list());
  assert.deepEqual([x.new.answer, y.new.answer], ['again: What is X?', 'again: And Y?']);
  // Stop: what runs is stopped and left empty.
  const stopFile = path.join(tmp('stop'), 'chat-benchmark.json');
  const stopping = createChatBenchmark({ file: stopFile, context: async () => ctx, chat });
  await stopping.list();
  await stopping.run();
  stopping.stop();
  await stopping.idle();
  assert.deepEqual(entriesOf(await stopping.list()).map((entry) => entry.new), [{}, {}]);
});

test('a replay goes through Chat\'s ask path: read-only tools, the old model and effort, and the benchmark\'s message', async () => {
  const sent = [];
  const run = (shell, args, options, callback) => {
    const stdout = new EventEmitter();
    sent.push({ command: args[args.length - 1], env: options.env, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    setImmediate(() => {
      const out = `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'The **new** answer.' })}\n`;
      stdout.emit('data', Buffer.from(out));
      callback(null, out);
    });
    return { stdout };
  };
  const chat = askChat({ readModels: () => MODELS, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'bench-runs'), run });
  const file = path.join(tmp('ask'), 'chat-benchmark.json');
  const bench = benchmark(file, chat);
  const before = snapshot(project.dir);
  const [x] = entriesOf(await bench.list());
  await bench.runOne(x.key);
  await bench.idle();
  assert.equal(entriesOf(await bench.list())[0].new.answer, 'The **new** answer.');
  assert.equal(sent.length, 1);
  const [call] = sent;
  assert.ok(call.command.includes(`--tools "${CLAUDE_TOOLS}"`), 'Chat\'s read-only tools');
  assert.equal(call.env.ENGELBART_BART_MODEL, 'opus');
  assert.match(call.command, /--effort high /);
  // The message: the cut document, then the level ask.cjs gave and the question.
  assert.match(call.input, /<note name="Fixture">[\s\S]*@chat What is X\?\n<<< this is the question being asked now >>>\n<\/note>\n\n<stage>none<\/stage>/);
  assert.ok(!call.input.includes('And Y?'));
  assert.match(call.input, /<level>You are running as Opus at high effort\. The person chose this model and effort by hand: no higher step exists\.<\/level>\n\n<question>\nWhat is X\?\n<\/question>$/);
  assert.deepEqual(snapshot(project.dir), before);
});

test('a question the run log recorded is sent the message that run was sent', async () => {
  const runLog = createRunLog();
  runLog.start({ id: 'r1', agent: 'bart', provider: 'anthropic', question: 'And Y?', system: 'S', context: {} });
  runLog.step('r1', { model: 'claude-sonnet-5-5', name: 'Sonnet', effort: 'medium', input: '<engelbart>\nrecorded head\n</engelbart>\n\n<context_json>\n[]\n</context_json>\n\n<workspace name="Then">\nas it was\n</workspace>\n\n<level>You are running as Sonnet at medium effort, step 1 of 3.</level>\n\n<question>\nAnd Y?\n</question>' });
  runLog.finish('r1', { status: 'done' });
  const { chat, jobs } = fakeChat();
  const bench = benchmark(path.join(tmp('recorded'), 'chat-benchmark.json'), chat, runLog);
  await bench.list();
  await bench.run();
  await bench.idle();
  assert.equal(jobs.find((job) => job.question === 'And Y?').message, '<engelbart>\nrecorded head\n</engelbart>\n\n<context_json>\n[]\n</context_json>\n\n<workspace name="Then">\nas it was\n</workspace>');
  assert.match(jobs.find((job) => job.question === 'What is X?').message, /<note name="Fixture">/);
});

test('the closing line\'s model and effort are the choice the replay is asked with', () => {
  assert.deepEqual(footChoice('*Chat · Opus · high · 41 s*'), { name: 'Opus', effort: 'high' });
  assert.deepEqual(footChoice('*Chat · Opus · high*'), { name: 'Opus', effort: 'high' });
  assert.equal(footChoice('*Chat · 4 s*'), null);
  assert.deepEqual(choiceOf(MODELS, '*Chat · Sonnet · medium · 5 s*'), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(choiceOf(MODELS, '*Chat · Sol · xhigh · 5 s · moved up from Sol medium*'), { model: 'sol', effort: 'xhigh' });
  assert.equal(choiceOf(MODELS, '*Chat · Nobody · high*'), null);
});

test('the Viewer\'s benchmark channels: list, Run, Run again, Stop, a note, and each change sent to the Viewer', async () => {
  const handlers = {};
  const sentToMap = [];
  const { chat } = fakeChat();
  const bench = benchmark(path.join(tmp('ipc'), 'chat-benchmark.json'), chat);
  registerAgentMapIpc({ ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } }, trustedHandler: (fn) => (_event, ...args) => fn(...args), mapWindow: { open() {}, send: (channel, payload) => sentToMap.push([channel, payload]) }, runLog: null, design: () => null, saveFile: async () => null, benchmark: bench });
  const listed = await handlers['engelbart:agentMap:benchmark']({});
  const [x] = entriesOf(listed);
  assert.equal(await handlers['engelbart:agentMap:benchmark-note']({}, x.key, 'a note'), true);
  assert.equal(await handlers['engelbart:agentMap:benchmark-note']({}, x.key, 7), false);
  await handlers['engelbart:agentMap:benchmark-run']({});
  await bench.idle();
  assert.ok(sentToMap.length >= 4 && sentToMap.every(([channel]) => channel === 'engelbart:chat-benchmark'));
  await handlers['engelbart:agentMap:benchmark-run']({}, x.key);
  assert.equal(await handlers['engelbart:agentMap:benchmark-stop']({}), true);
  await bench.idle();
  assert.equal(entriesOf(await handlers['engelbart:agentMap:benchmark']({}))[0].note, 'a note');
});

/* ------------------------------------------------------------- the tab */

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

test('the Benchmark tab: Run at the top, each question over Old and New, the note under them, nothing else', () => {
  const { BenchmarkList, applyChange } = compile('src/renderer/screens/Benchmark.jsx', 'benchmark-tab');
  const data = {
    running: false,
    groups: [{ name: 'Fixture', rel: 'bench/Fixture.md', entries: [
      { key: 'a', question: 'What is X?', old: '## Head\n- **one** thing', new: {}, note: 'kept' },
      { key: 'b', question: 'And Y?', old: 'old', new: { running: true }, note: '' },
      { key: 'c', question: 'And Z?', old: 'old', new: { error: 'It failed.' }, note: '' },
    ] }],
  };
  const page = renderToStaticMarkup(React.createElement(BenchmarkList, { data, onRun() {}, onStop() {}, onRunOne() {}, onNote() {} }));
  assert.deepEqual([...page.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]), ['Run', 'Run again', 'Run again', 'Run again']);
  assert.ok(page.includes('>Fixture<'));
  assert.ok(page.includes('What is X?') && page.includes('And Y?'));
  assert.equal((page.match(/>Old</g) || []).length, 3);
  assert.equal((page.match(/>New</g) || []).length, 3);
  assert.ok(page.includes('Running…'));
  assert.ok(page.includes('It failed.'));
  assert.match(page, /<strong[^>]*>one<\/strong>/, 'answers are drawn as markdown');
  assert.match(page, /<textarea[^>]*>kept<\/textarea>/);
  assert.equal((page.match(/<textarea/g) || []).length, 3);

  // While it runs: Stop. A change fills in one entry's New and leaves its note.
  const running = applyChange(data, { key: 'a', new: { answer: 'new **x**' }, running: true });
  assert.equal(running.groups[0].entries[0].note, 'kept');
  const busy = renderToStaticMarkup(React.createElement(BenchmarkList, { data: running, onRun() {}, onStop() {}, onRunOne() {}, onNote() {} }));
  assert.match(busy, /<button[^>]*>Stop<\/button>/);
  assert.ok(!/<button[^>]*>Run<\/button>/.test(busy));
  assert.match(busy, /new <strong[^>]*>x<\/strong>/);
});

test('the Viewer\'s tab bar: Runs, Design, then Benchmark', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/screens/AgentMap.jsx'), 'utf8');
  const tabs = [...source.matchAll(/style=\{S\.tab\(tab === '(\w+)'\)\} onClick=\{\(\) => setTab\('\w+'\)\}>(\w+)<\/button>/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(tabs, [['runs', 'Runs'], ['design', 'Design'], ['benchmark', 'Benchmark']]);
});
