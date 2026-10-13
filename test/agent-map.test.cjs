'use strict';

// The Agent map (2026-10-12; src/main/agent-map, src/main/bart/runlog.cjs, src/renderer/screens/AgentMap.jsx): the run log,
// what ask() tells it, each agent's design, and the Agents button, in a developer's copy alone.

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
const { createBart, createFakeBart, CLAUDE_TOOLS, BRAINSTORM_TOOLS, PAPER_TOOLS } = require('../src/main/bart/ask.cjs');
const { createRunLog, toolCallsOf } = require('../src/main/bart/runlog.cjs');
const { agentDesign } = require('../src/main/agent-map/design.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
const { BRAINSTORM_SYSTEM_PROMPT } = require('../src/main/bart/brainstorm-system-prompt.cjs');

const DEFAULTS = normalizeModels(null);
const CLAUDE = { ...DEFAULTS, provider: 'anthropic' };
const CODEX = { ...DEFAULTS, provider: 'openai' };
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `engelbart-map-${name}-`));
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, content) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] } });

/* ------------------------------------------------------------- the run log alone */

test('run log: two steps, one escalated, a Claude tool call and its result, and the end make one complete record', async () => {
  const file = path.join(tmp('log'), 'agent-runs.jsonl');
  const changes = [];
  const log = createRunLog({ file, onChange: (record) => changes.push(record) });
  log.start({ id: 'a1', agent: 'bart', provider: 'anthropic', projectId: 'p', projectName: 'P', workspaceName: 'W', question: 'why?', at: 1, status: 'running', system: 'SYSTEM', context: { head: '<engelbart>', contextJson: '<context_json>[]', mentionedFiles: '', documents: 'docs', now: '<stage>none</stage>', conversation: '', dirs: ['/a'] }, steps: [] });
  log.step('a1', { model: 'claude-sonnet-5-5', name: 'Sonnet', effort: 'high', input: 'first message' });
  log.event('a1', toolUse('t1', 'Read', { file_path: '/a/notes.md' }));
  log.event('a1', { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } } });
  log.event('a1', toolResult('t1', [{ type: 'text', text: 'y'.repeat(5000) }]));
  log.output('a1', { raw: 'ESCALATE: deeper', escalated: true });
  log.step('a1', { model: 'opus', name: 'Opus', effort: 'high', input: 'move up' });
  log.output('a1', { raw: 'the answer', escalated: false });
  log.finish('a1', { status: 'done', written: ['bart> the answer'], ms: 42 });
  await log.flush();

  const record = log.get('a1');
  assert.equal(record.system, 'SYSTEM');
  assert.equal(record.status, 'done');
  assert.deepEqual(record.written, ['bart> the answer']);
  assert.equal(record.ms, 42);
  assert.deepEqual(record.steps.map((step) => [step.model, step.effort, step.input, step.output, step.escalated]), [['claude-sonnet-5-5', 'high', 'first message', 'ESCALATE: deeper', true], ['opus', 'high', 'move up', 'the answer', false]]);
  const [read] = record.steps[0].tools;
  assert.deepEqual([read.name, read.input, read.result.size, read.result.excerpt.length], ['Read', { file_path: '/a/notes.md' }, 5000, 2000]);
  assert.equal(record.steps[1].tools.length, 0);
  assert.ok(changes.length >= 8, 'every change is told');
  assert.ok(!('system' in changes[0]) && !('steps' in changes[0]), 'onChange gets the record without its big fields');
  assert.deepEqual(log.list().map((run) => [run.id, run.status, run.model, run.toolCount]), [['a1', 'done', 'opus', 1]]);

  // On disk: the prompt once, by hash, and the run as it started and as it ended; read back, the last line wins.
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => (line.prompt ? 'prompt' : line.run.status)), ['prompt', 'running', 'done']);
  const again = createRunLog({ file });
  assert.equal(again.get('a1').system, 'SYSTEM');
  assert.equal(again.get('a1').steps.length, 2);
});

test('run log: the same system prompt is kept once; maxRuns trims the oldest runs, in memory and on disk', async () => {
  const file = path.join(tmp('trim'), 'agent-runs.jsonl');
  const log = createRunLog({ file, maxRuns: 3 });
  for (let n = 1; n <= 8; n += 1) {
    log.start({ id: `r${n}`, agent: 'bart', question: `q${n}`, system: 'SAME', context: {}, steps: [] });
    log.finish(`r${n}`, { status: 'done', written: [] });
  }
  await log.flush();
  assert.deepEqual(log.list().map((run) => run.id), ['r8', 'r7', 'r6']);
  assert.equal(log.get('r1'), null);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(lines.length <= 3 * 2, `the file is written out again: ${lines.length} lines`);
  assert.equal(lines.filter((line) => line.prompt).length, 1, 'one prompt line');
  assert.deepEqual(createRunLog({ file, maxRuns: 3 }).list().map((run) => run.id), ['r8', 'r7', 'r6']);
});

test('run log: a throwing onChange or a failed write never reaches the caller', async () => {
  const blocked = path.join(tmp('fail'), 'not-a-dir');
  fs.writeFileSync(blocked, 'a file where a folder should be');
  const log = createRunLog({ file: path.join(blocked, 'agent-runs.jsonl'), onChange: () => { throw new Error('the map broke'); } });
  assert.doesNotThrow(() => {
    log.start({ id: 'x', agent: 'bart', system: 's', context: {}, steps: [] });
    log.step('x', { model: 'm', effort: 'high', input: 'i' });
    log.event('x', toolUse('t', 'Grep', { pattern: 'a' }));
    log.event('x', null);
    log.event('nobody', toolUse('t', 'Grep', {}));
    log.output('x', { raw: 'out' });
    log.finish('x', { status: 'failed', error: 'boom' });
    log.start(null);
  });
  await log.flush();
  assert.equal(log.get('x').status, 'failed');
  assert.equal(log.get('x').error, 'boom');
});

test('run log: Codex command_execution, web_search and mcp_tool_call items are tool calls, with their output once completed', () => {
  const log = createRunLog();
  log.start({ id: 'c', agent: 'discover', system: 's', context: {}, steps: [] });
  log.step('c', { model: 'gpt-6-astra', effort: 'high', input: 'm' });
  log.event('c', { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'rg -n bart', status: 'in_progress' } });
  log.event('c', { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'rg -n bart', aggregated_output: 'notes.md:1:bart', exit_code: 0, status: 'completed' } });
  log.event('c', { type: 'item.started', item: { id: 'i2', type: 'web_search', query: 'citation tracing' } });
  log.event('c', { type: 'item.completed', item: { id: 'i3', type: 'mcp_tool_call', server: 'papers', tool: 'citations', arguments: '{"doi":"10.1/x"}', result: { content: [{ type: 'text', text: 'three papers' }] }, status: 'completed' } });
  log.event('c', { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'hi' } });
  const tools = log.get('c').steps[0].tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['command', 'web_search', 'papers.citations']);
  assert.deepEqual(tools[0].input, { command: 'rg -n bart' });
  assert.deepEqual([tools[0].result.excerpt, tools[0].result.exitCode], ['notes.md:1:bart', 0]);
  assert.deepEqual(tools[1].input, { query: 'citation tracing' });
  assert.equal(tools[1].result, undefined, 'a search still going has no result');
  assert.deepEqual(tools[2].input, { doi: '10.1/x' });
  assert.match(tools[2].result.excerpt, /three papers/);
  assert.deepEqual(toolCallsOf({ type: 'turn.completed' }), []);
});

/* ------------------------------------------------------------- ask() with a run log */

const homeDir = tmp('home');
const layout = ensureHome(homeDir);
let ctx;
let project;
let workspace;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, { name: 'Mapped', directory: tmp('code') });
  workspace = await projects.createWorkspace(ctx, project.id, { name: 'Agents' });
});
test.after(async () => { await db.closeAll(); });

/** A CLI that streams `events` (later, as a real one does) and then ends with `text`. */
function streaming(script) {
  const calls = [];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1], stdout = new EventEmitter();
    const { events = [], text } = script.shift();
    calls.push({ command, input: fs.readFileSync(options.env.ENGELBART_BART_INPUT, 'utf8') });
    setImmediate(() => {
      if (/codex/.test(command)) {
        const out = [{ type: 'thread.started', thread_id: '01a0bc2d-7c18-77d2-8b21-3cc7e942cb11' }, ...events].map((event) => JSON.stringify(event)).join('\n') + '\n';
        stdout.emit('data', Buffer.from(out));
        fs.writeFileSync(options.env.ENGELBART_BART_OUTPUT, text);
        callback(null, out);
      } else {
        const out = [...events, { type: 'result', subtype: 'success', is_error: false, result: text }].map((event) => JSON.stringify(event)).join('\n') + '\n';
        stdout.emit('data', Buffer.from(out));
        callback(null, out);
      }
    });
    return { stdout };
  };
  return { run, calls };
}

test('ask with a run log: every context block, the system prompt, each step\'s input and output, the tool calls and the lines written', async () => {
  const log = createRunLog();
  const { run, calls } = streaming([
    { events: [toolUse('t1', 'Read', { file_path: '/notes.md' }), toolResult('t1', 'the notes')], text: 'ESCALATE: deeper' },
    { events: [toolUse('t2', 'WebSearch', { query: 'q' })], text: 'done' },
  ]);
  const bart = createBart({ readModels: () => CLAUDE, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs'), run, runLog: log });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, 'A plan.\n@bart why?\n');
  const out = await bart.ask(ctx, project.id, { askId: 'm1', ref, workspaceId: workspace.id, text: 'why?' });
  assert.equal(out.lines[0], 'bart> done');

  const record = log.get('m1');
  assert.deepEqual([record.agent, record.provider, record.projectName, record.workspaceName, record.question, record.status], ['bart', 'anthropic', 'Mapped', 'Agents', 'why?', 'done']);
  assert.equal(record.system, BART_SYSTEM_PROMPT);
  assert.match(record.context.head, /^<engelbart>\nproject: Mapped/);
  assert.match(record.context.contextJson, /^<context_json>/);
  assert.match(record.context.documents, /<workspace name="Agents">[\s\S]*A plan\./);
  assert.equal(record.context.now, '<stage>none</stage>\n\n<highlights>none</highlights>');
  assert.equal(record.context.conversation, '');
  assert.deepEqual(record.context.dirs, [project.directory, ctx.dataRoot]);
  assert.deepEqual(record.steps.map((step) => step.input), calls.map((call) => call.input), 'each step\'s input is what was sent');
  assert.deepEqual(record.steps.map((step) => [step.name, step.effort, step.output, step.escalated]), [['Sonnet', 'high', 'ESCALATE: deeper', true], ['Opus', 'high', 'done', false]]);
  assert.deepEqual(record.steps.map((step) => step.tools.map((tool) => tool.name)), [['Read'], ['WebSearch']]);
  assert.equal(record.steps[0].tools[0].result.excerpt, 'the notes');
  assert.deepEqual(record.written, out.lines);

});

test('ask with a run log: a resumed turn records only now and the question as its input', async () => {
  const log = createRunLog();
  const script = [{ text: 'first answer' }, { text: 'second answer' }];
  const { run, calls } = streaming(script);
  const bart = createBart({ readModels: () => CLAUDE, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-resume'), run, runLog: log });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await bart.ask(ctx, project.id, { askId: 'f1', ref, workspaceId: workspace.id, text: 'why?' });
  await bart.ask(ctx, project.id, { askId: 'f2', ref, workspaceId: workspace.id, text: 'and then?', turns: [{ question: 'why?', answer: 'first answer' }] });
  assert.match(calls[1].command, /--resume "\$ENGELBART_BART_SESSION"/);
  const [step] = log.get('f2').steps;
  assert.match(step.input, /^<stage>none<\/stage>\n\n<highlights>none<\/highlights>\n\n<level>[^\n]+<\/level>\n\n<question>\nand then\?\n<\/question>$/);
  assert.ok(!/<engelbart>/.test(step.input));
  assert.match(log.get('f2').context.conversation, /<conversation>\n<turn n="1">/, 'what the exchange holds is still recorded as context');
});

test('ask with a run log: Codex\'s command_execution and mcp_tool_call land as tool calls; a failure is recorded as failed', async () => {
  const authFile = path.join(homeDir, 'auth-map.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const log = createRunLog();
  const { run } = streaming([{
    events: [
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'cat notes.md', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'cat notes.md', aggregated_output: 'the notes', exit_code: 0, status: 'completed' } },
      { type: 'item.started', item: { id: 'c2', type: 'mcp_tool_call', server: 'papers', tool: 'search', arguments: { query: 'x' }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c2', type: 'mcp_tool_call', server: 'papers', tool: 'search', arguments: { query: 'x' }, result: { content: [{ type: 'text', text: 'two papers' }] }, status: 'completed' } },
    ],
    text: '## Start here\n\nA guide.',
  }, { text: '' }]);
  const bart = createBart({ readModels: () => CODEX, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-codex'), codexHome: path.join(homeDir, 'codex-home-map'), codexAuthFile: authFile, run, runLog: log });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await bart.ask(ctx, project.id, { askId: 'd1', ref, workspaceId: workspace.id, text: 'tracing citations', agent: 'discover' });
  const tools = log.get('d1').steps[0].tools;
  assert.deepEqual(tools.map((tool) => [tool.name, tool.result && tool.result.excerpt]), [['command', 'the notes'], ['papers.search', JSON.stringify({ content: [{ type: 'text', text: 'two papers' }] })]]);
  assert.deepEqual(tools[1].input, { query: 'x' });

  await assert.rejects(bart.ask(ctx, project.id, { askId: 'd2', ref, workspaceId: workspace.id, text: 'something else', agent: 'discover' }));
  assert.equal(log.get('d2').status, 'failed');
  assert.ok(log.get('d2').error);
});

test('ask without a run log, and the fake agents with one, run as before', async () => {
  const { run } = streaming([{ text: 'plain' }]);
  const bart = createBart({ readModels: () => CLAUDE, environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'runs-plain'), run });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  assert.equal((await bart.ask(ctx, project.id, { askId: 'n1', ref, workspaceId: workspace.id, text: 'why?' })).lines[0], 'bart> plain');

  const log = createRunLog();
  const fake = createFakeBart({ readModels: () => CLAUDE, delayMs: 0, runLog: log });
  const out = await fake.ask(ctx, project.id, { askId: 'k1', ref, workspaceId: workspace.id, text: 'hard question' });
  const record = log.get('k1');
  assert.deepEqual([record.status, record.steps.length, record.steps[0].escalated], ['done', 2, true]);
  assert.deepEqual(record.written, out.lines);
});

/* ------------------------------------------------------------- design */

test('design: the three agents, their tools and model steps, and a custom .context prompt marked custom', () => {
  const dataRoot = tmp('design');
  fs.mkdirSync(path.join(dataRoot, '.context'));
  fs.writeFileSync(path.join(dataRoot, '.context', 'brainstorm-system-prompt.md'), 'Ask one question at a time.\n');
  fs.writeFileSync(path.join(dataRoot, '.context', 'bart-system-prompt.md'), '   \n');
  const { agents } = agentDesign({ dataRoot, models: CLAUDE });
  assert.deepEqual(agents.map((agent) => agent.agent), ['bart', 'brainstorm', 'discover']);
  const [bart, brainstorm, discover] = agents;
  assert.deepEqual([bart.prompt.custom, bart.prompt.text], [false, BART_SYSTEM_PROMPT], 'a prompt file with nothing in it is not custom');
  assert.deepEqual([brainstorm.prompt.custom, brainstorm.prompt.text], [true, 'Ask one question at a time.']);
  assert.notEqual(brainstorm.prompt.text, BRAINSTORM_SYSTEM_PROMPT);
  assert.deepEqual([bart.tools.anthropic.tools, brainstorm.tools.anthropic.tools, discover.tools.anthropic.allowedTools], [CLAUDE_TOOLS, BRAINSTORM_TOOLS, `${CLAUDE_TOOLS},${PAPER_TOOLS}`]);
  assert.deepEqual([bart.tools.openai.webSearch, brainstorm.tools.openai.webSearch, discover.tools.openai.papers, bart.tools.openai.papers], [true, false, true, false]);
  assert.equal(bart.models.inForce, 'anthropic');
  assert.deepEqual(bart.models.providers.anthropic.steps.map((step) => `${step.name} ${step.effort}`), ['Sonnet high', 'Opus high', 'Fable xhigh']);
  assert.equal(brainstorm.models.providers.anthropic.steps.length, 1);
  assert.deepEqual(Object.keys(discover.models.providers.openai.modes), ['quick', 'standard', 'deep']);
  assert.deepEqual([bart.timeout.step, discover.timeout.deep], [15 * 60_000, 45 * 60_000]);
  assert.ok(brainstorm.context.blocks.some((block) => /\[agent reply omitted\]/.test(block.note)), '@brainstorm\'s documents leave other agents\' replies out');
  assert.ok(bart.context.blocks.some((block) => /<stage>/.test(block.block)) && !brainstorm.context.blocks.some((block) => /<stage> \//.test(block.block)));
});

/* ------------------------------------------------------------- the button and the page */

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

test('the Agents button renders only in a copy with test mode', () => {
  const AgentsButton = compile('src/renderer/ui/AgentsButton.jsx', 'agents-button').default;
  assert.equal(renderToStaticMarkup(React.createElement(AgentsButton, { available: false, onOpen: () => {} })), '');
  assert.match(renderToStaticMarkup(React.createElement(AgentsButton, { available: true, onOpen: () => {} })), /<button[^>]*>Agents<\/button>/);
});

test('the export is one page, its styles and data inside it', () => {
  const { exportPage, sectionText } = compile('src/renderer/agent-map/runText.js', 'run-text');
  const record = { id: 'e1', agent: 'bart', provider: 'anthropic', question: 'why </script>?', at: 0, status: 'done', system: 'SYS', context: { head: '<engelbart>' }, steps: [{ model: 'opus', name: 'Opus', effort: 'high', input: 'IN', at: 0, tools: [{ id: 't', name: 'Read', input: { file_path: '/x' }, at: 0, result: { size: 3, excerpt: 'abc' } }], output: 'OUT', escalated: false }], written: ['bart> OUT'] };
  const page = exportPage([record], 'One run');
  assert.match(page, /^<!doctype html>.*<style>/);
  assert.ok(!/<script src|<link /.test(page), 'nothing loaded from outside');
  assert.match(page, /&lt;engelbart&gt;/);
  assert.match(page, /<script type="application\/json" id="agent-runs">.*\\u003c\/script>/, 'the data cannot close its script');
  assert.match(sectionText(record, 'steps'), /--- tool: Read ---\n\{\n  "file_path": "\/x"\n\}\n--- result \(3 chars\) ---\nabc/);
});
