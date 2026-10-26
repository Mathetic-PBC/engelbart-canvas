'use strict';

// A goal Build (MATH-88): a request that starts with `/goal <condition>` runs step 1 as a Build always does (its request
// reading "The goal: …"), then step 2, the same session resumed with /goal first in the message, with no review or run
// step in between. Codex and quick tasks run as a normal Build. The rounds' stop-hook feedback is read for the card.
// Against real git and a real library database, with the agent scripted (as in build.test.cjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { createGit } = require('../src/main/build/git.cjs');
const { createBuilds, TURN_MS } = require('../src/main/build/manager.cjs');
const store = require('../src/main/build/store.cjs');
const { createFakeRunner } = require('../src/main/build/runner.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { parseGoal, goalMessage, stopFeedback, goalOutcome, goalShown, QUICK_NOTE, CODEX_NOTE } = require('../src/shared/build-goal.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-goal-'));
const layout = ensureHome(homeDir);
const environment = { PATH: process.env.PATH, HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), SHELL: '/bin/zsh' };
const git = createGit({ environment });
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Person', '-c', 'user.email=p@example.com', ...args], { cwd, env: environment, encoding: 'utf8' }).trim();
const MODELS = normalizeModels(null);
const WORKING = ['setting-up', 'queued', 'running', 'accepting'];
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => { await db.closeAll(); });

let n = 0;
async function scene(doc = 'Plan.') {
  n += 1;
  const code = path.join(homeDir, `code${n}`);
  fs.mkdirSync(code);
  sh(code, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(code, 'a.txt'), 'one\n');
  sh(code, 'add', '-A');
  sh(code, 'commit', '-qm', 'init');
  const project = await projects.createProject(ctx, { name: `Aim ${n}`, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, doc);
  return { project, workspace };
}

/**
 * A scripted agent: each turn takes the next step (a function of the turn's input, an Error to throw, or a text); its
 * calls are kept with the session and time limit each was given. A step that writes a file leaves the Build in review.
 */
function scripted(steps) {
  const calls = [];
  return {
    calls,
    async turn(input) {
      calls.push({ message: input.message, session: input.session, timeoutMs: input.timeoutMs });
      const step = steps.shift();
      if (!step) throw Object.assign(new Error('no more steps'), { kind: 'failed' });
      const out = typeof step === 'function' ? await step(input) : step;
      if (out instanceof Error) throw out;
      return { text: out, session: input.session || 'session-1' };
    },
  };
}
const edit = (text) => ({ task }) => { fs.writeFileSync(path.join(task.worktree, `b${Math.random().toString(36).slice(2, 7)}.txt`), 'bee\n'); return text; };

function manager(runner, extra = {}) {
  const events = [];
  const runs = [];
  const runStep = { stop: async () => {}, halt: async () => {}, holds: () => false, run: async (input) => { runs.push(input); throw new Error('no run step here'); } };
  const raw = createBuilds({ git, runner, readModels: () => MODELS, notify: (channel, payload) => events.push({ channel, payload }), runShell: async () => ({ ok: true, output: 'ok' }), runStep, ...extra });
  const builds = { ...raw, start: (c, pid, input = {}) => raw.start(c, pid, { target: { kind: 'project' }, ...input }) };
  return { builds, events, runs };
}

const recordOf = (project, id) => store.readTask(projects.findProject(ctx, project.id), id);
async function settled(project, id, not = WORKING) {
  for (let i = 0; i < 500; i += 1) {
    const task = recordOf(project, id);
    if (task && !not.includes(task.status)) { await new Promise((resolve) => setTimeout(resolve, 30)); return recordOf(project, id); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the Build never settled');
}
/** Until the Build has taken `turns` turns and is not working. */
async function turned(project, id, turns) {
  for (let i = 0; i < 500; i += 1) {
    const task = recordOf(project, id);
    if (task && task.turn >= turns && !WORKING.includes(task.status)) { await new Promise((resolve) => setTimeout(resolve, 30)); return recordOf(project, id); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the Build never took its turns');
}
/** The statuses the renderer was sent for one Build, in order, each once. */
const statuses = (events, id) => events.filter((e) => e.channel === 'engelbart:build' && e.payload.id === id).map((e) => e.payload.status).filter((s, i, all) => s !== all[i - 1]);

/* ----------------------------------------------------------------------------- detection */

test('a goal is a request that starts with /goal, whitespace and a condition; anywhere else it is words', () => {
  assert.equal(parseGoal('/goal the tests pass'), 'the tests pass');
  assert.equal(parseGoal('  /goal the tests pass'), 'the tests pass', 'leading spaces');
  assert.equal(parseGoal('/goal\tthe tests pass\nand lint is clean'), 'the tests pass\nand lint is clean', 'as written, over lines');
  assert.equal(parseGoal('fix /goal handling'), null);
  assert.equal(parseGoal('/goal'), null, 'a bare /goal');
  assert.equal(parseGoal('/goal   '), null);
  assert.equal(parseGoal('/goals x'), null);
  assert.equal(parseGoal(null), null);
  assert.equal(goalMessage('the tests pass'), '/goal the tests pass. Also stop when you need to ask the person something (end your reply with a last line `NEEDS YOU: <question>`), when two rounds in a row make no progress, or after 20 rounds.');
});

/* ----------------------------------------------------------------------------- the two steps */

const PATHS = (workspace) => [
  ['an @bart or @chat line\'s --build', { kind: 'build', workspaceId: workspace.id, fromLine: true }, 'request'],
  ['a post-it added to a workspace', { kind: 'build', workspaceId: workspace.id }, 'post-it'],
  ['a task\'s row', { kind: 'build', workspaceId: workspace.id, fromLine: true, withDocument: true }, 'request'],
];

test('every way a request reaches a Build turns the goal on: step 1 reads "The goal: …", then step 2 resumes the session with /goal, no review or run step between (MATH-88)', async () => {
  const { project, workspace } = await scene('- [ ] /goal the export works');
  for (const [name, input, block] of PATHS(workspace)) {
    let id = null;
    let between = null;
    const { builds, events, runs } = manager(scripted([
      edit('Built the export.'),
      () => { between = { statuses: statuses(events, id), runs: runs.length, record: recordOf(project, id) }; return 'The export works now.'; },
    ]));
    const started = await builds.start(ctx, project.id, { ...input, text: '  /goal the export works' });
    id = started.id;
    assert.deepEqual(started.goal, { condition: 'the export works', supported: true, state: 'pending', rounds: 0, last: null }, name);
    const task = await settled(project, id);
    assert.equal(task.status, 'review', name);
    assert.equal(task.goal.state, 'met', name);
    assert.equal(task.turn, 2, `${name}: two turns`);
    const context = store.readContext(projects.findProject(ctx, project.id), id);
    assert.match(context, new RegExp(`<${block}>\\nThe goal: the export works\\n</${block}>`), `${name}: step 1's ${block}`);
    assert.doesNotMatch(context.split(`</${block}>`)[0], /\/goal\s/, `${name}: its ${block} has no /goal (a task's workspace, background, keeps its line as written)`);
    assert.ok(between, `${name}: step 2 ran`);
    assert.equal(between.record.status, 'running', `${name}: still working between the steps`);
    assert.equal(between.record.goal.state, 'running', name);
    assert.ok(!between.statuses.includes('review'), `${name}: no Ready to review between the steps (${between.statuses})`);
    assert.equal(between.runs, 0, `${name}: no run step between the steps`);
    assert.equal(between.record.runStep || null, null, name);
  }
});

test('step 2\'s message is exactly the /goal message, sent on --resume of step 1\'s session, with what is left of the turn\'s time', async () => {
  const { project, workspace } = await scene();
  const agent = scripted([edit('Step one.'), 'Met.']);
  const { builds, runs } = manager(agent, { turnMs: { ...TURN_MS, build: 10 * 60_000 } });
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the tests pass', fromLine: true });
  const task = await settled(project, id);
  assert.equal(agent.calls.length, 2);
  assert.equal(agent.calls[0].session, null, 'step 1: a new session');
  assert.equal(agent.calls[1].message, goalMessage('the tests pass'), 'nothing before /goal: no <reply>, no context');
  assert.equal(agent.calls[1].session, 'session-1', 'step 2 resumes step 1\'s session');
  assert.equal(agent.calls[0].timeoutMs, 10 * 60_000);
  assert.ok(agent.calls[1].timeoutMs <= 10 * 60_000 && agent.calls[1].timeoutMs >= 60_000, 'step 2 has what is left');
  assert.equal(task.status, 'review');
  assert.equal(task.messages.filter((m) => m.role === 'agent').map((m) => m.text).join('|'), 'Step one.|Met.');
  for (let i = 0; i < 40 && !runs.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(runs.length, 1, 'the run step starts after step 2, as after any turn that ends in review');
});

test('step 1 that asks waits for the person; the reply\'s turn that ends done runs step 2', async () => {
  const { project, workspace } = await scene();
  const agent = scripted(['Half done.\n\nNEEDS YOU: Which format?', edit('CSV it is.'), 'Met.']);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the export works', fromLine: true });
  let task = await settled(project, id);
  assert.equal(task.status, 'needs-you');
  assert.equal(task.goal.state, 'pending');
  assert.equal(agent.calls.length, 1, 'no step 2 while it asks');
  await builds.reply(ctx, project.id, id, 'CSV');
  task = await turned(project, id, 3);
  assert.equal(agent.calls.length, 3);
  assert.match(agent.calls[1].message, /^<reply>\nCSV\n<\/reply>$/);
  assert.equal(agent.calls[2].message, goalMessage('the export works'));
  assert.equal(task.status, 'review');
  assert.equal(task.goal.state, 'met');
});

test('step 2 that asks keeps its goal running; the reply\'s turn sends /goal again (Claude Code keeps no goal across a resume)', async () => {
  const { project, workspace } = await scene();
  const agent = scripted([edit('Step one.'), 'Not there yet.\n\nNEEDS YOU: Which port?', 'Used 8080.', 'Met.']);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the server starts', fromLine: true });
  let task = await settled(project, id);
  assert.equal(task.status, 'needs-you');
  assert.equal(task.question, 'Which port?');
  assert.equal(task.goal.state, 'running', 'it stays running while it asks');
  await builds.reply(ctx, project.id, id, '8080');
  task = await turned(project, id, 4);
  assert.equal(agent.calls.length, 4);
  assert.equal(agent.calls[3].message, goalMessage('the server starts'));
  assert.equal(task.status, 'review');
  assert.equal(task.goal.state, 'met');
});

test('a session that will not resume fails the goal, and never falls back to everything again', async () => {
  const { project, workspace } = await scene();
  const agent = scripted([edit('Step one.'), Object.assign(new Error('No conversation found with session ID: session-1'), { kind: 'failed' }), 'never sent']);
  const { builds, runs } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the tests pass', fromLine: true });
  const task = await settled(project, id);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /^The goal could not start: the Build's session could not be resumed \(No conversation found/);
  assert.equal(agent.calls.length, 2, 'no third call with the context again');
  assert.equal(runs.length, 0, 'no run step');
});

test('Codex runs a /goal request as a normal Build: step 1 only, the goal not supported, the card says why', async () => {
  const { project, workspace } = await scene();
  const agent = scripted([edit('Built it.')]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the tests pass', fromLine: true, provider: 'openai', model: 'sol', effort: 'high' });
  const task = await settled(project, id);
  assert.equal(task.status, 'review');
  assert.equal(agent.calls.length, 1, 'no step 2');
  assert.match(agent.calls[0].message, /<request>\nThe goal: the tests pass\n<\/request>/);
  assert.equal(task.goal.supported, false);
  assert.equal(goalShown(store.publicTask(task)).line, CODEX_NOTE);
});

test('a quick post-it with /goal is a quick task as always: its limits, no step 2, landing by itself; the card says it needs a full Build', async () => {
  const { project } = await scene();
  const agent = scripted([edit('Fixed.')]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { kind: 'quick', text: '/goal the typo is gone' });
  const task = await settled(project, id, [...WORKING, 'review']);
  assert.equal(task.status, 'accepted', 'it landed by itself');
  assert.equal(agent.calls.length, 1, 'no step 2');
  assert.equal(agent.calls[0].timeoutMs, TURN_MS.quick, 'a quick task\'s time');
  assert.match(agent.calls[0].message, /<post-it>\nThe goal: the typo is gone\n<\/post-it>/);
  assert.equal(task.goal.supported, false);
  assert.equal(goalShown(store.publicTask(task)).line, QUICK_NOTE);
});

test('a request without /goal at its start is a Build as before: one turn, no goal on its record', async () => {
  const { project, workspace } = await scene();
  const agent = scripted([edit('Fixed.')]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: 'fix /goal handling', fromLine: true });
  const task = await settled(project, id);
  assert.equal(task.status, 'review');
  assert.equal(agent.calls.length, 1);
  assert.equal(task.goal, undefined);
  assert.equal(store.publicTask(task).goal, null);
  assert.match(agent.calls[0].message, /<request>\nfix \/goal handling\n<\/request>/);
});

/* ----------------------------------------------------------------------------- rounds */

const feedback = (text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

test('stop-hook feedback: the reason of each round not yet met, read loosely; anything else is none', () => {
  const condition = 'color.txt holds the [favorite] color';
  assert.equal(stopFeedback(feedback(`Stop hook feedback:\n[${condition}]: the file does not exist yet.`), condition), 'the file does not exist yet.');
  assert.equal(stopFeedback(feedback('Stop hook feedback: [other words]: no tests yet'), condition), 'no tests yet', 'another condition in brackets');
  assert.equal(stopFeedback(feedback('stop hook feedback : the build is red'), condition), 'the build is red', 'no brackets');
  assert.equal(stopFeedback({ type: 'user', message: { content: `Stop hook feedback:\n[${condition}]: as a string` } }, condition), 'as a string');
  for (const odd of [null, 'text', 5, {}, { message: null }, { message: { content: 5 } }, { message: { content: [null, 7, { text: 9 }] } }, feedback('Hello'), feedback('Stop hook feedback:'), feedback('Stop hook feedback: [x]:   ')]) {
    assert.equal(stopFeedback(odd, condition), null, JSON.stringify(odd));
  }
  assert.equal(goalOutcome('Done: the export works.', 'the CSV is empty'), 'met');
  assert.equal(goalOutcome('I stopped: two rounds in a row made no progress.', null), 'ended');
  assert.equal(goalOutcome('Stopping.', 'still failing after 20 rounds'), 'ended');
  assert.equal(goalOutcome('Stopping.', null, 20), 'ended');
});

test('step 2\'s rounds are counted and their last reason kept on the record; odd events never touch the Build', async () => {
  const { project, workspace } = await scene();
  let seen = null;
  let buildId = null;
  const agent = scripted([edit('Step one.'), async ({ onEvent }) => {
    for (const odd of [null, 'x', { type: 'user', message: { content: 7 } }, { get message() { throw new Error('boom'); } }]) onEvent(odd);
    onEvent(feedback('Stop hook feedback:\n[the tests pass]: 3 tests fail.'));
    onEvent(feedback('Stop hook feedback:\n[the tests pass]: 1 test fails.'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    seen = recordOf(project, buildId);
    return 'All tests pass.';
  }]);
  const { builds, events } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the tests pass', fromLine: true });
  buildId = id;
  const task = await settled(project, id);
  assert.equal(seen.goal.rounds, 2);
  assert.equal(seen.goal.last, '1 test fails.');
  assert.equal(seen.status, 'running');
  assert.ok(events.some((e) => e.channel === 'engelbart:build' && e.payload.id === id && e.payload.goal && e.payload.goal.last === '3 tests fail.'), 'sent as each round comes');
  assert.equal(task.status, 'review');
  assert.deepEqual([task.goal.state, task.goal.rounds, task.goal.last], ['met', 2, '1 test fails.'], 'kept: they survive a reload');
});

test('step 2 that stopped for no progress is ended, not met', async () => {
  const { project, workspace } = await scene();
  const agent = scripted([edit('Step one.'), async ({ onEvent }) => { onEvent(feedback('Stop hook feedback:\n[the tests pass]: 1 test fails.')); return 'Two rounds in a row made no progress, so I stopped.'; }]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the tests pass', fromLine: true });
  const task = await settled(project, id);
  assert.equal(task.status, 'review', 'Ready to review as always');
  assert.equal(task.goal.state, 'ended');
  assert.equal(goalShown(store.publicTask(task)).line, 'Goal stopped: 1 test fails.');
});

/* ----------------------------------------------------------------------------- fake mode */

test('fake mode: a message that starts with /goal streams three rounds of stop-hook feedback, then finishes', async () => {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-fake-'));
  const events = [];
  const out = await createFakeRunner({ delayMs: 30 }).turn({ task: { id: 'abcdef0123', kind: 'build', worktree, modelName: 'Opus', effort: 'high' }, message: goalMessage('the tests pass'), session: 'fake-session', onEvent: (event) => events.push(event) });
  const reasons = events.map((event) => stopFeedback(event, 'the tests pass')).filter(Boolean);
  assert.deepEqual(reasons, ['the fake goal is on round 1 of 3.', 'the fake goal is on round 2 of 3.', 'the fake goal is on round 3 of 3.']);
  assert.match(out.text, /the goal is met/);
  assert.equal(out.session, 'fake-session');
});

test('fake mode end to end: step 1, then the goal\'s rounds on the record, then Ready to review with the goal met', async () => {
  const { project, workspace } = await scene();
  const { builds } = manager(createFakeRunner({ delayMs: 30 }));
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: '/goal the fake works', fromLine: true });
  const task = await settled(project, id);
  assert.equal(task.status, 'review');
  assert.deepEqual([task.goal.state, task.goal.rounds, task.goal.last], ['met', 3, 'the fake goal is on round 3 of 3.']);
});

/* ----------------------------------------------------------------------------- the cards */

function loadEditor() {
  const { buildSync } = require('esbuild');
  const filename = path.join(__dirname, '__DocEditor-goal-unit.cjs');
  const bundled = buildSync({ entryPoints: [path.join(__dirname, '../src/renderer/workspace/DocEditor.jsx')], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, external: ['react', 'react-dom'], loader: { '.css': 'empty' } });
  const compiled = new Module(filename, module);
  compiled.paths = module.paths;
  compiled._compile(bundled.outputFiles[0].text, filename);
  return compiled.exports.default;
}

test('the cards show the goal: under the Build card\'s title, in a task\'s card, and in the task row\'s status', () => {
  const DocEditor = loadEditor();
  const editor = Object.create(DocEditor.prototype);
  Object.assign(editor, { props: { builds: {} }, buildOpen: new Set(), buildSteps: new Set(), buildPrompt: new Set(), taskOpen: new Set(), taskStarting: new Set(), tickRefused: new Map(), taskSummaryOpen: new Set(), taskDiffOpen: new Set(), taskConvo: new Set() });
  const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const base = { id: '0123456789', title: '/goal the tests pass', provider: 'anthropic', modelName: 'Opus', effort: 'high', messages: [], kind: 'build' };
  const goal = (change) => ({ condition: 'the tests pass\nand lint is clean', supported: true, state: 'running', rounds: 1, last: null, ...change });
  const partsOf = (task) => Object.fromEntries(editor.buildParts(task.id, task));
  const row = (task) => { editor.props.builds = { [task.id]: task }; return editor.taskBuildHtml(0, '', { type: 'todo', text: 'x', build: task.id }, false); };

  let task = { ...base, status: 'running', goal: goal({ last: '2 tests fail.' }) };
  let parts = partsOf(task);
  assert.equal(plain(parts.goal), 'Goal: the tests pass and lint is clean Not yet: 2 tests fail.');
  assert.match(parts.goal, /title="the tests pass\nand lint is clean"/, 'the condition in full on hover');
  assert.match(parts.head, /Working/, 'its status words as always');
  assert.equal(plain(row(task)), 'Building · Not yet: 2 tests fail.');
  assert.match(row(task), /title="[^"]*Goal: the tests pass/);
  assert.equal(plain(Object.fromEntries(editor.taskParts(task.id, task)).goal), plain(parts.goal), 'a task\'s card shows it too');

  task = { ...base, status: 'review', goal: goal({ state: 'met', last: '1 test fails.' }) };
  assert.equal(plain(partsOf(task).goal), 'Goal: the tests pass and lint is clean Goal met');
  assert.match(partsOf(task).head, /Ready to review/);
  assert.equal(plain(row(task)), 'Review · Goal met');
  task = { ...base, status: 'review', goal: goal({ state: 'ended', last: '1 test fails.' }) };
  assert.equal(plain(partsOf(task).goal), 'Goal: the tests pass and lint is clean Goal stopped: 1 test fails.');
  task = { ...base, status: 'needs-you', question: 'Which?', goal: goal({ state: 'pending' }) };
  assert.equal(plain(partsOf(task).goal), 'Goal: the tests pass and lint is clean', 'step 1: the goal alone');
  assert.equal(plain(row(task)), 'Needs you · Goal: the tests pass and lint is clean');
  task = { ...base, status: 'review', provider: 'openai', goal: goal({ supported: false, state: 'pending' }) };
  assert.equal(plain(partsOf(task).goal), `Goal: the tests pass and lint is clean ${CODEX_NOTE}`);
  task = { ...base, status: 'failed', kind: 'quick', goal: goal({ supported: false, state: 'pending' }) };
  assert.match(plain(partsOf(task).goal), new RegExp(QUICK_NOTE.replace(/[/.]/g, '\\$&')));
  task = { ...base, status: 'review', goal: undefined };
  assert.equal(partsOf(task).goal, '', 'a Build without a goal: nothing');
  assert.equal(plain(row(task)), 'Review', 'its row as before');
});
