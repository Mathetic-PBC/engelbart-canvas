'use strict';

// The Agent Viewer (2026-10-12; it was the Agent map; src/main/agent-map, src/main/bart/runlog.cjs,
// src/renderer/screens/AgentMap.jsx): the run log, what ask() tells it, each agent's design, and the Agents button and
// window, in a copy with test mode whether the mode is on or off. The asks it groups are in agent-viewer.test.cjs.

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
const { createBart, createFakeBart, CLAUDE_TOOLS, BRAINSTORM_TOOLS, PAPER_TOOLS, CREATE_TOOLS, CREATE_CODEX } = require('../src/main/bart/ask.cjs');
const { CREATE_SYSTEM_PROMPT } = require('../src/main/bart/create-system-prompt.cjs');
const { createRunLog, toolCallsOf } = require('../src/main/bart/runlog.cjs');
const { agentDesign } = require('../src/main/agent-map/design.cjs');
const { createAgentMapWindow } = require('../src/main/agent-map/window.cjs');
const { registerAgentMapIpc } = require('../src/main/agent-map/ipc.cjs');
const { createStore, registerEngelbartIpc } = require('../src/main/ipc.cjs');
const { BART_SYSTEM_PROMPT } = require('../src/main/bart/system-prompt.cjs');
const { BRAINSTORM_SYSTEM_PROMPT } = require('../src/main/bart/brainstorm-system-prompt.cjs');
const { MAX_TOOLS } = require('../src/main/bart/runlog.cjs');
const { BUILD_SYSTEM_PROMPT, QUICK_PARAGRAPH } = require('../src/main/build/prompt.cjs');
const { CLAUDE_TOOLS: BUILD_TOOLS } = require('../src/main/build/runner.cjs');
const { ENGELBART_TOOLS } = require('../src/main/build/engelbart-tools.cjs');
const { RUN_TOOLS } = require('../src/main/build/run-tools.cjs');
const { RUNNABLE_MS, DECLARE_MS, INSTALL_MS, WIND_DOWN_MS, MAX_TURNS } = require('../src/main/build/run-step.cjs');
const { LIMITS, TURN_MS } = require('../src/main/build/manager.cjs');

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

test('design: the router and the three agents, the calls between them, their tools and model steps, and a custom .context prompt marked custom', () => {
  const dataRoot = tmp('design');
  fs.mkdirSync(path.join(dataRoot, '.context'));
  fs.writeFileSync(path.join(dataRoot, '.context', 'brainstorm-system-prompt.md'), 'Ask one question at a time.\n');
  fs.writeFileSync(path.join(dataRoot, '.context', 'bart-system-prompt.md'), '   \n');
  const { agents } = agentDesign({ dataRoot, models: CLAUDE });
  assert.deepEqual(agents.map((agent) => agent.agent), ['router', 'bart', 'brainstorm', 'discover', 'create', 'build', 'run step'], 'Bart, the classifier, first; Create built (2026-10-13)');
  assert.deepEqual(agents.slice(0, 5).map((agent) => agent.title), ['Bart (classifier)', 'Chat', 'Brainstorm', 'Discover', 'Create']);
  // @create (2026-10-13): built, its prompt, tools, write rule, timeout and where its files go; @chat's models; it calls nothing.
  const create = agents[4];
  assert.equal(create.planned, undefined);
  assert.deepEqual([create.prompt.custom, create.prompt.text], [false, CREATE_SYSTEM_PROMPT]);
  assert.equal(create.tools.anthropic.tools, CREATE_TOOLS);
  assert.ok(!/Bash/.test(create.tools.anthropic.tools), 'no Bash');
  assert.equal(create.tools.anthropic.allowedTools, `${CLAUDE_TOOLS},Edit(//<data root>/.create/<ask id>/**),Write(//<data root>/.create/<ask id>/**) --permission-mode dontAsk`);
  assert.deepEqual(create.tools.openai.overrides, ['-C /<data root>/.create/<ask id>', ...CREATE_CODEX, 'tools.web_search=true']);
  assert.equal(create.timeout.step, 10 * 60_000);
  assert.match(create.reach, /draft folder alone.*A write anywhere else fails/);
  assert.match(create.keeps, /at most 5 .*20 MB.*assets\/md.*assets\/files\/<uuid>\/.*deleted/);
  assert.match(create.models.rule, /@chat's models and efforts/);
  assert.deepEqual(create.calls, []);
  assert.ok(agents[0].calls.some((call) => call.to === 'create' && /Creating in 5 s · Cancel/.test(call.how)), 'Bart calls Create');
  const [router, bart, brainstorm, discover] = agents;
  assert.deepEqual(router.models.providers.anthropic.steps.map((step) => `${step.name} ${step.effort}`), ['Haiku low']);
  assert.deepEqual(router.models.providers.openai.steps.map((step) => `${step.name} ${step.effort}`), ['Luna low']);
  assert.deepEqual([router.tools.anthropic.tools, router.timeout.route, router.rules.length > 4, /You are Bart, the router/.test(router.prompt.text)], ['', 20_000, true, true]);
  assert.ok(router.inputs.some((input) => /never the library/.test(input)));
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
  assert.ok(brainstorm.context.blocks.some((block) => /other agents' replies as <reply agent="…">/.test(block.note)), '@brainstorm\'s documents carry other agents\' replies, labelled');
  assert.ok(bart.context.blocks.some((block) => /<stage>/.test(block.block)) && !brainstorm.context.blocks.some((block) => /<stage> \//.test(block.block)));
});

test('design: Build and the run step after it, their tools, models, time limits and context blocks, and who calls whom (2026-10-12)', () => {
  const dataRoot = tmp('design-build');
  const { agents } = agentDesign({ dataRoot, models: CLAUDE, buildModels: DEFAULTS });
  const build = agents.find((agent) => agent.agent === 'build');
  const step = agents.find((agent) => agent.agent === 'run step');
  assert.deepEqual([build.prompt.custom, build.prompt.text, build.prompt.quick], [false, BUILD_SYSTEM_PROMPT, `${BUILD_SYSTEM_PROMPT}\n\n${QUICK_PARAGRAPH}`]);
  assert.equal(build.tools.anthropic.tools, BUILD_TOOLS);
  assert.equal(build.tools.anthropic.settingSources, 'user,project,local');
  assert.match(build.tools.anthropic.personal, /own Claude Code settings, hooks and MCP servers/);
  assert.deepEqual(build.tools.anthropic.engelbart, ENGELBART_TOOLS.map((tool) => `mcp__engelbart__${tool.name}`));
  assert.ok(build.tools.openai.overrides.includes('features.multi_agent=true') && build.tools.openai.overrides.includes('features.computer_use=false'), 'what codexOverrides sets');
  assert.match(build.reach, /worktree/);
  assert.match(build.reach, /git guard/);
  assert.match(build.reach, /Kept aside/);
  assert.equal(build.models.inForce, 'anthropic');
  assert.deepEqual(build.models.providers.anthropic.steps.map((one) => `${one.name} ${one.effort}`), ['Opus high']);
  assert.deepEqual(build.models.providers.openai.steps.map((one) => `${one.name} ${one.effort}`), ['Sol high']);
  assert.deepEqual([build.timeout, build.slots], [{ build: TURN_MS.build, quick: TURN_MS.quick }, { build: LIMITS.build, quick: LIMITS.quick }]);
  assert.deepEqual(build.context.blocks.map((block) => block.block), ['<engelbart>', '<custom_instructions> / <memory>', '<task>', '<workspace>', '<attached>', '<history>', '<context_json>']);
  assert.match(build.context.blocks.find((block) => block.block === '<workspace>').note, /<request> instead.*<post-it>/);
  assert.deepEqual(build.ends.map((end) => end.line.split(':')[0]), ['NEEDS YOU', 'ESCALATE', '(anything else)']);
  assert.equal(build.startedFrom.length, 5);
  assert.ok(build.startedFrom.some((from) => /Bart's pick/.test(from)) && build.startedFrom.some((from) => /footer Build/.test(from)), 'the router and the footer\'s Build start one too (2026-10-12)');
  assert.match(step.prompt.note, /launch facts/);
  assert.match(step.prompt.text, /You are the run step of an Engelbart Build/);
  assert.equal(step.tools.anthropic.allowedTools, RUN_TOOLS.map((tool) => `mcp__canvas__${tool.name}`).join(','));
  assert.deepEqual([step.tools.anthropic.tools, step.tools.anthropic.restricted, step.tools.openai], ['', true, null], 'Engelbart\'s run tools only, Claude only, restricted');
  assert.deepEqual([step.models.fallback.name, step.models.fallback.effort], ['Opus', 'high']);
  assert.deepEqual([step.timeout, step.maxTurns], [{ runnable: RUNNABLE_MS, declare: DECLARE_MS, install: INSTALL_MS, windDown: WIND_DOWN_MS }, MAX_TURNS]);
  const calls = Object.fromEntries(agents.map((agent) => [agent.agent, agent.calls.map((call) => call.to)]));
  assert.deepEqual(calls, { router: ['chat', 'brainstorm', 'discover', 'create', 'build'], bart: ['build'], brainstorm: ['discover', 'chat'], discover: ['build'], create: [], build: ['run step'], 'run step': [] }, 'each `to` as a line writes it: @chat is bart (2026-10-12)');
  // A custom Build prompt shows as custom, its quick task's with the quick paragraph after it.
  fs.mkdirSync(path.join(dataRoot, '.context'));
  fs.writeFileSync(path.join(dataRoot, '.context', 'build-system-prompt.md'), 'Build carefully.\n');
  const custom = agentDesign({ dataRoot, models: CLAUDE, buildModels: DEFAULTS }).agents.find((agent) => agent.agent === 'build');
  assert.deepEqual([custom.prompt.custom, custom.prompt.text, custom.prompt.file], [true, 'Build carefully.', path.join(dataRoot, '.context', 'build-system-prompt.md')]);
  assert.equal(custom.prompt.quick, `Build carefully.\n\n${QUICK_PARAGRAPH}`);
});

test('run log: a step keeps its first 1,000 tool calls and counts the rest, whatever their results (2026-10-12)', () => {
  const log = createRunLog();
  log.start({ id: 'b:1', agent: 'build', system: 'S' });
  log.step('b:1', { model: 'opus', input: 'go' });
  for (let i = 0; i < MAX_TOOLS + 25; i += 1) { log.event('b:1', toolUse(`t${i}`, 'Read', { i })); log.event('b:1', toolResult(`t${i}`, 'x')); }
  log.event('b:1', { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'ls' } });
  log.event('b:1', { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0 } });
  const [step] = log.get('b:1').steps;
  assert.equal(MAX_TOOLS, 1000);
  assert.equal(step.tools.length, 1000);
  assert.equal(step.toolsDropped, 26, 'a Codex command counted once, started and completed');
  assert.ok(step.tools.every((tool) => tool.result), 'the kept ones have their results');
  const [summary] = log.list();
  assert.deepEqual([summary.toolCount, summary.toolsDropped], [1000, 26]);
  log.note('b:1', { context: { prompt: 'P' }, id: 'other', status: 'x' });
  log.finish('b:1', { status: 'done', ending: 'review' });
  const record = log.get('b:1');
  assert.deepEqual([record.id, record.status, record.ending, record.context], ['b:1', 'done', 'review', { prompt: 'P' }], 'note merges fields but never the id or status');
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

test('the Agents button renders in a copy with test mode, whether the mode is on or off (2026-10-12)', () => {
  const { default: AgentsButton, agentsAvailable } = compile('src/renderer/ui/AgentsButton.jsx', 'agents-button');
  const render = (config) => renderToStaticMarkup(React.createElement(AgentsButton, { available: agentsAvailable(config), onOpen: () => {} }));
  assert.match(render({ testModeAvailable: true, testMode: true }), /<button[^>]*title="Agent Viewer[^"]*"[^>]*>Agents<\/button>/);
  assert.match(render({ testModeAvailable: true, testMode: false }), /<button[^>]*>Agents<\/button>/, 'test mode off: the button still shows');
  assert.equal(render({ testModeAvailable: false, testMode: true }), '', 'a copy without test mode: no button');
  assert.equal(render({ testModeAvailable: false, testMode: false }), '');
  assert.equal(render(null), '');
});

/** A BrowserWindow that opens nothing: each made is kept in `made`. */
function fakeElectron() {
  const made = [];
  class BrowserWindow {
    constructor(options) {
      this.options = options;
      this.handlers = {};
      this.destroyed = false;
      this.webContents = { setWindowOpenHandler() {}, on() {}, getURL: () => '', isLoading: () => false, send() {} };
      made.push(this);
    }
    on(event, fn) { this.handlers[event] = fn; }
    loadURL() { return Promise.resolve(); }
    show() {}
    focus() {}
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; if (this.handlers.closed) this.handlers.closed(); }
  }
  return { BrowserWindow, made };
}

test('agentMap:open opens the Viewer with test mode off or on, titled Agent Viewer, and focuses it after; a copy without test mode opens none', async (t) => {
  const store = createStore({ homeDir: tmp('open'), testMode: true });
  t.after(() => store.close());
  await store.setTestMode(false);
  const { BrowserWindow, made } = fakeElectron();
  let developer = false;
  const mapWindow = createAgentMapWindow({ BrowserWindow, appUrl: 'app://x', preload: '/p.js', available: () => developer && store.config().testModeAvailable, headless: true });
  const handlers = new Map();
  registerAgentMapIpc({ ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn, mapWindow, runLog: null, design: () => ({}), saveFile: async () => null });
  const open = handlers.get('engelbart:agentMap:open');

  assert.equal(await open(), false);
  assert.equal(made.length, 0, 'no window in a copy without test mode');
  developer = true;
  assert.equal(await open(), true, 'test mode off: it opens');
  assert.equal(made[0].options.title, 'Agent Viewer');
  await store.setTestMode(true);
  assert.equal(await open(), true);
  assert.equal(made.length, 1, 'opened once, then brought forward');
});

test('turning test mode off leaves the Agent Viewer open (2026-10-12); runs are still recorded while it is off', async (t) => {
  const store = createStore({ homeDir: tmp('close'), testMode: true });
  t.after(() => store.close());
  await store.setTestMode(true);
  const { BrowserWindow, made } = fakeElectron();
  const agentMap = createAgentMapWindow({ BrowserWindow, appUrl: 'app://x', preload: '/p.js', available: () => store.config().testModeAvailable, headless: true });
  const handlers = new Map();
  registerEngelbartIpc({ store, agentMap, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, trustedHandler: (fn) => fn });
  const setTestMode = handlers.get('engelbart:set-test-mode');

  assert.equal(agentMap.open(), true);
  await setTestMode(false);
  assert.equal(agentMap.isOpen(), true, 'test mode off: the Viewer stays open');
  assert.equal(made[0].destroyed, false);
  await setTestMode(true);
  assert.equal(agentMap.isOpen(), true);
  assert.equal(made.length, 1);

  const log = createRunLog();
  log.start({ id: 'off', agent: 'bart', question: 'while off', system: 's', context: {}, steps: [] });
  log.finish('off', { status: 'done', written: [] });
  assert.equal(log.get('off').status, 'done', 'the log takes no notice of test mode');
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

test('a Build\'s context is shown block by block, as it was sent; a run step\'s its prompt (2026-10-12)', () => {
  const { contextBlocks } = compile('src/renderer/agent-map/runText.js', 'run-text-build');
  assert.deepEqual(contextBlocks({ agent: 'build', context: { engelbart: '<engelbart>\nx\n</engelbart>', task: '<task>\ny\n</task>', request: '<request>\nz\n</request>' } }).map((block) => block.label), ['<engelbart>', '<task>', '<request>']);
  assert.deepEqual(contextBlocks({ agent: 'run step', context: { prompt: 'P' } }).map((block) => [block.label, block.text]), [['prompt', 'P']]);
});

test('the Design tab draws one agent at a time, picked from a row of tabs, each with what it calls (2026-10-13)', () => {
  const { Design } = compile('src/renderer/screens/AgentMap.jsx', 'agent-map-design');
  const design = agentDesign({ dataRoot: tmp('design-page'), models: CLAUDE, buildModels: DEFAULTS });
  const NAMES = ['Bart (classifier)', 'Chat', 'Brainstorm', 'Discover', 'Create', 'Build', 'Run step'];
  const ids = design.agents.map((agent) => agent.agent);
  assert.equal(ids.length, NAMES.length);
  const render = (agent) => renderToStaticMarkup(React.createElement(Design, { design, agent, onPick() {} }));
  const headings = (page) => NAMES.filter((name) => page.includes(`<div><b>${name}</b>`));

  // No agent picked, or one the design does not have: the first, Bart (classifier), alone.
  assert.deepEqual(headings(render(undefined)), ['Bart (classifier)']);
  assert.deepEqual(headings(render('nobody')), ['Bart (classifier)']);

  // The tab row: all seven, in the Viewer's order.
  const tabs = [...render(undefined).matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]);
  assert.deepEqual(tabs, NAMES);

  const pages = {};
  ids.forEach((id, i) => {
    const page = render(id);
    assert.deepEqual(headings(page), [NAMES[i]], `${NAMES[i]} alone`);
    pages[NAMES[i]] = page;
  });

  const groups = (page) => [...page.matchAll(/<div style="font-weight:600;[^"]*">([^<]*)<\/div>/g)].map((match) => match[1]);
  const ORDER = ['How it routes', 'What it sees', 'Prompt', 'Tools', 'Models', 'Limits', 'Ends', 'Hands work to', 'Started from'];
  for (const name of NAMES) {
    const seen = groups(pages[name]);
    assert.deepEqual(seen, ORDER.filter((group) => seen.includes(group)), `${name}: its groups in order`);
  }
  // A row: a dim label 160px wide, its value beside it.
  const row = (label) => new RegExp(`<div style="width:160px;[^"]*">${label}</div><div[^>]*>`);

  const bart = pages['Bart (classifier)'];
  assert.deepEqual(groups(bart), ['How it routes', 'What it sees', 'Prompt', 'Tools', 'Models', 'Limits', 'Hands work to']);
  assert.match(bart, /<div><b>Bart \(classifier\)<\/b><span[^>]*> · @bart · internally &#x27;router&#x27;<\/span><\/div><div style="border-top:1px solid #ddd/, 'the header, then a thin rule');
  const rules = [...bart.match(/<ol[^>]*>(.*?)<\/ol>/)[1].matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1]);
  const router = design.agents[0];
  assert.equal(rules.length, 9);
  assert.deepEqual(rules, router.rules.map((rule) => `${rule.when.replace(/</g, '&lt;')} <b>→ ${rule.to.replace(/</g, '&lt;').replace(/≥/g, '≥')}</b>`), 'one item per rule, in order, the → part bold');
  for (const rule of router.rules) assert.ok(!bart.includes(`${rule.to} · `) && !bart.includes(` · ${rule.when}`), `"${rule.when}" is not joined to another rule`);
  assert.match(bart, row('Inputs'));
  for (const input of router.inputs) assert.ok(bart.includes(`<div>${input.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>`), `input on its own line: ${input}`);
  assert.match(bart, /width:160px;[^"]*">Claude<\/div><div[^>]*><div><code>--tools &quot;&quot;<\/code><\/div><\/div>/, 'Claude | --tools ""');
  assert.match(bart, /<div style="width:160px;[^"]*">anthropic \(in force\)<\/div><div[^>]*><div>Haiku \(claude-haiku-[^)]*\) at low<\/div>/);
  const hands = bart.slice(bart.indexOf('>Hands work to<'));
  const calls = [...hands.matchAll(/<div style="margin:2px 0 2px 14px"><b>([^<]*)<\/b> <span[^>]*>([^<]*)<\/span><\/div>/g)].map((match) => match[1]);
  assert.deepEqual(calls, ['Chat', 'Brainstorm', 'Discover', 'Create', 'Build'], 'one row per agent Bart hands work to');

  const chat = pages.Chat;
  assert.match(chat, row('New session'));
  assert.match(chat, /<div><div>&lt;context_json&gt;<\/div><div style="color:#777">[^<]+<\/div><\/div>/, 'a block on its own line, its note dim under it');
  assert.match(chat, row('Resumed'));
  assert.match(chat, row('Folders'));
  assert.match(chat, />Codex<\/div><div[^>]*>web search on · paper MCP off · sandbox read-only</);

  const create = pages.Create;
  assert.ok(!/Planned, not built yet/.test(create), 'Create is built (2026-10-13)');
  assert.match(create, /<b>Create<\/b>[^]*?Write,Edit[^]*?--permission-mode dontAsk[^]*?draft folder alone[^]*?assets\/files/, 'Create: its tools, where it writes, where its files go');
  assert.ok(!create.includes('Hands work to'), 'Create hands work to no one: no group');

  const build = pages.Build;
  assert.match(build, /a quick task&#x27;s system prompt/);
  assert.match(build, /what codexOverrides sets/);
  const limits = build.slice(build.indexOf('>Limits<'), build.indexOf('>Ends<'));
  assert.match(limits, /Slots at once<\/div><div[^>]*><div>build 3<\/div><div>quick 1<\/div><\/div>/, 'Limits shows its slots, one per line');
  const ends = build.slice(build.indexOf('>Ends<'), build.indexOf('>Hands work to<'));
  const endLines = [...ends.matchAll(/<code>([^<]*)<\/code>/g)].map((match) => match[1]);
  assert.deepEqual(endLines, ['NEEDS YOU: &lt;question&gt;', 'ESCALATE: &lt;why&gt;', '(anything else)'], 'Ends lists each end line');
  assert.match(build, />Hands work to<\/div><div[^>]*><b>Run step<\/b>/, 'Build hands work to the run step');
  assert.match(build, />Started from<\/div>(<div style="margin:2px 0 2px 14px">[^<]+<\/div>){5}/, 'what starts a Build, one per line');
  assert.match(pages['Run step'], />Codex<\/div><div[^>]*><span[^>]*>none \(Claude Code only\)/);
  assert.match(pages['Run step'], /Turns<\/div><div[^>]*>at most \d+/);
  for (const name of NAMES) assert.ok(!/Planned, not built yet/.test(pages[name]), `${name} is built`);
});
