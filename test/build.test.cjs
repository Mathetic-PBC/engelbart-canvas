'use strict';

// Build (src/main/build): the lifecycle against real git and a real library database, with the agent scripted. What a
// Build is given, where its record is, how a turn ends, replies, Stop, Accept (one commit, checks, refusals), Discard,
// recovery after the app closed, quick tasks, Clear and the archived versions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const archive = require('../src/main/store/archive.cjs');
const { createGit } = require('../src/main/build/git.cjs');
const { createBuilds } = require('../src/main/build/manager.cjs');
const store = require('../src/main/build/store.cjs');
const { readEnding, loadBuildPrompt, BUILD_SYSTEM_PROMPT } = require('../src/main/build/prompt.cjs');
const { buildPolicy, claudeSettings } = require('../src/main/build/policy.cjs');
const { createRunner, createFakeRunner } = require('../src/main/build/runner.cjs');
const { CLAUDE_SUBSCRIPTION_COMMAND } = require('../src/main/bart/claude-command.cjs');
const { createBuildPreviews } = require('../src/main/build/previews.cjs');
const { createInterfaceBuilds } = require('../src/main/build/interfaces.cjs');
const { createProcesses } = require('../src/main/local-preview/process.cjs');
const { normalizeModels, buildChoices, resolveBuildChoice, DEFAULT_MODELS } = require('../src/main/bart/models.cjs');

const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-build-'));
const layout = ensureHome(homeDir);
const environment = { PATH: process.env.PATH, HOME: homeDir, XDG_CONFIG_HOME: path.join(homeDir, '.config'), SHELL: '/bin/zsh' };
const git = createGit({ environment });
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Person', '-c', 'user.email=p@example.com', ...args], { cwd, env: environment, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const MODELS = normalizeModels(null);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
test.after(async () => { await db.closeAll(); });

let n = 0;
/** A project whose code folder is a git repository with one commit, and a workspace. */
async function scene({ files = { 'a.txt': 'one\ntwo\nthree\n' }, doc = 'Build the thing.' } = {}) {
  n += 1;
  const code = path.join(homeDir, `code${n}`);
  fs.mkdirSync(code);
  sh(code, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) write(path.join(code, name), text);
  sh(code, 'add', '-A');
  sh(code, 'commit', '-qm', 'init');
  const project = await projects.createProject(ctx, { name: `Build ${n}`, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, doc);
  return { code, project, workspace };
}

/** A scripted agent: each turn takes the next step (a function of the turn, or a text), and the calls are kept. */
function scripted(steps) {
  const calls = [];
  return {
    calls,
    async turn(input) {
      calls.push({ message: input.message, session: input.session, cwd: input.task.worktree, system: input.system, policy: input.policy });
      const step = steps.shift();
      if (!step) throw Object.assign(new Error('no more steps'), { kind: 'failed' });
      const out = typeof step === 'function' ? await step(input) : step;
      if (out instanceof Error) throw out;
      return { text: out, session: input.session || `session-${calls.length}` };
    },
  };
}

function manager(runner, extra = {}) {
  const events = [];
  const shells = [];
  const builds = createBuilds({
    git, runner, readModels: () => MODELS,
    notify: (channel, payload) => events.push({ channel, payload }),
    runShell: async (command, cwd) => { shells.push({ command, cwd }); return command.includes('fail') ? { ok: false, output: 'test failed: 1 of 3' } : { ok: true, output: 'ok' }; },
    ...extra,
  });
  return { builds, events, shells };
}

/** Until the Build has taken `turns` turns and is not working. */
async function turned(project, id, turns) {
  for (let i = 0; i < 500; i += 1) {
    const task = store.readTask(projects.findProject(ctx, project.id), id);
    if (task && task.turn >= turns && !['setting-up', 'queued', 'running', 'accepting'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the Build never took its turns');
}

async function settled(project, id, not = ['setting-up', 'queued', 'running', 'accepting']) {
  for (let i = 0; i < 500; i += 1) {
    const task = store.readTask(projects.findProject(ctx, project.id), id);
    if (task && !not.includes(task.status)) { await new Promise((resolve) => setTimeout(resolve, 20)); return store.readTask(projects.findProject(ctx, project.id), id); }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the Build never settled');
}

/* ------------------------------------------------------------------ models and prompt */

test('shared Context survives Clear/Restore and project removals beat archived links and imported tasks', async () => {
  const { project, workspace } = await scene();
  const other = await projects.createWorkspace(ctx, project.id, { name: 'Other' });
  const note = await projects.createNote(ctx, project.id, { name: 'Shared reference', workspaceId: workspace.id, text: 'A source' });
  await projects.linkToWorkspace(ctx, project.id, workspace.id, [note.id]);
  const text = `My document\n@[${note.name}]\nbuild> abcdef0123\n`;
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, text);
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }, 'Other document');
  const cleared = await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: line => line === 'build> abcdef0123' });
  assert.deepEqual((await projects.loadProject(ctx, project.id)).project.context, [note.id]);
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }), 'Other document');
  await projects.unlinkFromWorkspace(ctx, project.id, other.id, note.id);
  await archive.restoreArchive(ctx, project.id, workspace.id, cleared.archive.file);
  let shared = (await projects.loadProject(ctx, project.id)).project;
  assert.deepEqual(shared.context, []);
  assert.deepEqual(shared.removedContext, [note.id]);
  const imported = await archive.importTask(ctx, project.id, other.id, { text: `Task with @[${note.name}]`, buildId: 'abcdef0124' });
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }), 'Other document');
  await archive.restoreArchive(ctx, project.id, other.id, imported.file);
  shared = (await projects.loadProject(ctx, project.id)).project;
  assert.deepEqual(shared.context, [], 'task history is not explicit reattachment');
  assert.ok(shared.removedContext.includes(note.id));
  assert.equal(projects.findWorkspace(ctx, project.id, workspace.id).workspace.archives.length, 2);
});

test('post-it destination is explicit, uses project code, and promotion keeps the destination document', async t => {
  const { project, workspace, code } = await scene();
  const other = await projects.createWorkspace(ctx, project.id, { name: 'Destination' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }, 'Keep this plan');
  const agent = scripted(['ESCALATE: needs a larger change', 'Done']);
  const { builds } = manager(agent);
  t.after(() => builds.stopAll());
  const task = await builds.start(ctx, project.id, { kind: 'quick', workspaceId: other.id, text: 'A small post-it' });
  await turned(project, task.id, 1);
  assert.equal(builds.get(ctx, project.id, task.id).workspaceId, other.id);
  assert.equal(store.readTask(project, task.id).repo, code);
  assert.match(agent.calls[0].message, /It is a quick task/);
  assert.equal(projects.findWorkspace(ctx, project.id, workspace.id).workspace.builds.length, 0);
  const promoted = await builds.promote(ctx, project.id, task.id, other.id);
  await turned(project, task.id, 2);
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: other.id }), 'Keep this plan');
  assert.match(archive.readArchive(ctx, project.id, other.id, promoted.version.file).text, /Imported from Task:/);
  await builds.discard(ctx, project.id, task.id);
});

test('Bart approval hands code generation to Hudson Build; legacy local interfaces stay listed and reachable', async t => {
  const { project, workspace } = await scene();
  const events = [], calls = [];
  const saved = { id: `${project.id}:${workspace.id}`, directory: '/existing/.local-apps/app', status: 'ready', url: 'http://127.0.0.1:12345/' };
  const legacy = { get: () => saved, list: async () => [saved], stopAsk: () => false, approve: () => { throw new Error('expired'); }, close: async () => {}, restart: async () => saved };
  const bridge = createInterfaceBuilds({
    legacy, readModels: () => MODELS, planner: async () => require('./fixtures/local-build-plan.cjs')(),
    builds: { preflight: async () => ({ ok: true }), start: async (...args) => { calls.push(args); return { id: 'abcdef0123' }; } },
    notify: event => events.push(event),
  });
  t.after(() => bridge.close());
  const input = { askId: 'proposal-one', workspaceId: workspace.id, text: '--astra --xhigh Build the chart', buildRequest: 'Make a chart', turns: [] };
  const first = bridge.build(ctx, project.id, input);
  while (!events.at(-1)?.preview.approval) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls.length, 0, 'planning never generates code');
  const approval = events.at(-1).preview.approval.id;
  assert.throws(() => bridge.approve(ctx, project.id, workspace.id, 'wrong', true), /expired/);
  bridge.approve(ctx, project.id, workspace.id, approval, false);
  await assert.rejects(first, error => error.kind === 'stopped');
  assert.equal(calls.length, 0);
  const next = bridge.build(ctx, project.id, { ...input, askId: 'proposal-two' });
  while (!events.at(-1)?.preview.approval) await new Promise(resolve => setTimeout(resolve, 5));
  bridge.approve(ctx, project.id, workspace.id, events.at(-1).preview.approval.id, true);
  assert.deepEqual((await next).lines, ['build> abcdef0123']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].workspaceId, workspace.id);
  assert.equal(calls[0][2].model, 'astra');
  assert.equal(calls[0][2].effort, 'xhigh');
  assert.equal(calls[0][2].interfaceIntent.request, 'Make a chart');
  assert.deepEqual(bridge.get(ctx, project.id, workspace.id), saved);
  assert.ok((await bridge.list(ctx)).includes(saved));
  assert.deepEqual(await bridge.restart(ctx, project.id, workspace.id), saved);
});

test('worktree review → Accept → accepted preview; failed Accept retains review; Discard restores accepted and stops before removal', async t => {
  const server = `const http=require('node:http'),fs=require('node:fs'); http.createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(fs.readFileSync('index.html'));}).listen(Number(process.argv[2]),'127.0.0.1');`;
  const recipe = { version: 1, kind: 'interface', name: 'Interface', cwd: '.', install: null, build: null, command: 'node server.cjs {port}', path: '/' };
  const { project, workspace, code } = await scene({ files: { 'index.html': '<h1>Original</h1>', 'server.cjs': server, 'engelbart-preview.json': JSON.stringify(recipe) } });
  const processes = createProcesses({ environment });
  let failAcceptedLaunch = false;
  const previews = createBuildPreviews({ processes, verify: async url => {
    assert.match(await (await fetch(url)).text(), /<h1>/);
    if (failAcceptedLaunch) throw new Error('Fixture accepted launch failed');
  }, readyTimeoutMs: 5000 });
  const urls = new Map();
  const checkingGit = { ...git, removeWorktree: async (repo, dir) => {
    if (urls.has(dir)) await assert.rejects(fetch(urls.get(dir)), 'owned review server must stop before worktree deletion');
    return git.removeWorktree(repo, dir);
  } };
  let turn = 0;
  const runner = { turn: async ({ task }) => {
    turn++;
    write(path.join(task.worktree, 'index.html'), `<h1>Version ${turn}</h1>`);
    write(path.join(task.worktree, 'engelbart-preview.json'), JSON.stringify({ ...recipe, buildId: task.id }));
    return { text: 'Built the interface', session: 'session' };
  } };
  const { builds } = manager(runner, { git: checkingGit, previews });
  t.after(() => builds.stopAll());
  const ready = async id => {
    for (let n = 0; n < 300; n++) {
      const task = builds.get(ctx, project.id, id);
      if (task.preview?.status === 'failed') throw new Error(task.preview.error);
      if (task.preview?.url && !task.working) { urls.set(task.worktree, task.preview.url); return task; }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Preview did not become ready');
  };
  const first = await builds.start(ctx, project.id, { workspaceId: workspace.id, interfaceIntent: { request: 'Make interface' } });
  const review = await ready(first.id);
  assert.equal(await (await fetch(review.preview.url)).text(), '<h1>Version 1</h1>');
  assert.equal(fs.readFileSync(path.join(code, 'index.html'), 'utf8'), '<h1>Original</h1>');
  const accepted = await builds.accept(ctx, project.id, first.id);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.preview.mode, 'accepted');
  assert.equal(accepted.preview.directory, code);
  assert.equal(fs.existsSync(first.worktree), false);
  assert.equal(await (await fetch(accepted.preview.url)).text(), '<h1>Version 1</h1>');
  const second = await builds.start(ctx, project.id, { workspaceId: workspace.id, interfaceIntent: { request: 'Update interface' } });
  const secondReview = await ready(second.id);
  write(path.join(code, 'index.html'), '<h1>My unsaved edit</h1>');
  await assert.rejects(builds.accept(ctx, project.id, second.id));
  assert.equal(builds.get(ctx, project.id, second.id).preview.url, secondReview.preview.url);
  assert.equal(await (await fetch(secondReview.preview.url)).text(), '<h1>Version 2</h1>');
  assert.ok(fs.existsSync(second.worktree));
  const discarded = await builds.discard(ctx, project.id, second.id);
  assert.equal(discarded.preview.mode, 'restored');
  assert.equal(discarded.preview.url, accepted.preview.url);
  assert.equal(fs.existsSync(second.worktree), false);
  assert.equal(fs.readFileSync(path.join(code, 'index.html'), 'utf8'), '<h1>My unsaved edit</h1>', 'Discard does not touch user edits');
  write(path.join(code, 'index.html'), '<h1>Version 1</h1>'); // fixture restores its own edit
  const third = await builds.start(ctx, project.id, { workspaceId: workspace.id, interfaceIntent: { request: 'Another update' } });
  const thirdReview = await ready(third.id);
  failAcceptedLaunch = true;
  const landed = await builds.accept(ctx, project.id, third.id);
  assert.equal(landed.status, 'accepted', 'a server failure cannot undo or misreport a successful Git Accept');
  assert.equal(landed.preview.status, 'failed');
  assert.equal(landed.preview.previousUrl, accepted.preview.url, 'Stage can fall back instead of staying on a stopped worktree URL');
  assert.match(landed.preview.error, /Fixture accepted launch failed/);
  assert.equal(fs.existsSync(third.worktree), false);
  await assert.rejects(fetch(thirdReview.preview.url));
  await builds.stopAll();
  await assert.rejects(fetch(accepted.preview.url), 'shutdown stops accepted servers too');
});

test('Build has models of its own: Codex GPT-6-Sol high, Claude Code Opus high, the dialog on @bart\'s provider', () => {
  assert.equal(DEFAULT_MODELS.build.providers.openai.models.sol.id, 'gpt-6-sol');
  const choices = buildChoices(MODELS);
  assert.equal(choices.provider, 'openai');
  assert.deepEqual(choices.providers.openai.ladder, [{ model: 'sol', effort: 'high' }]);
  assert.deepEqual(choices.providers.anthropic.ladder, [{ model: 'opus', effort: 'high' }]);
  assert.deepEqual(resolveBuildChoice(MODELS, { provider: 'anthropic' }), { provider: 'anthropic', model: 'opus', modelId: 'opus', modelName: 'Opus', effort: 'high' });
  assert.deepEqual(resolveBuildChoice(MODELS, { provider: 'openai', model: 'astra', effort: 'ultra' }).modelId, 'gpt-6-astra');
  assert.equal(resolveBuildChoice(MODELS, { provider: 'openai', model: 'nope', effort: 'max' }).effort, 'high', 'what the list does not offer falls back to the default');
  const edited = normalizeModels({ ...MODELS, build: { providers: { openai: { models: { sol: { id: 'gpt-7-sol', name: 'Sol' } }, default: { model: 'sol', effort: 'xhigh' } } } } });
  assert.deepEqual(resolveBuildChoice(edited, {}), { provider: 'openai', model: 'sol', modelId: 'gpt-7-sol', modelName: 'Sol', effort: 'xhigh' });
});

test('Discard drains setup and stops a running turn without sending its queued reply', async t => {
  const { project, workspace } = await scene();
  let began, calls = 0;
  const started = new Promise(resolve => { began = resolve; });
  const { builds } = manager({ turn: async ({ signal }) => {
    calls++; began();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped'), { kind: 'stopped' })), { once: true }));
  } });
  t.after(() => builds.stopAll());
  const task = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await started;
  await builds.reply(ctx, project.id, task.id, 'This reply must not start after Discard');
  const done = await builds.discard(ctx, project.id, task.id);
  assert.equal(done.status, 'discarded');
  assert.equal(done.queued, null);
  assert.equal(calls, 1);
  assert.equal(fs.existsSync(task.worktree), false);

  const config = path.join(project.dir, 'project.json');
  write(config, JSON.stringify({ ...JSON.parse(fs.readFileSync(config, 'utf8')), build: { setup: 'wait-for-test' } }));
  let setupBegan;
  const settingUp = new Promise(resolve => { setupBegan = resolve; });
  const slow = manager(scripted([]), { runShell: async (_command, _cwd, { signal }) => {
    setupBegan();
    await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Setup aborted')), { once: true }));
  } }).builds;
  t.after(() => slow.stopAll());
  const pending = await slow.start(ctx, project.id, { workspaceId: workspace.id });
  await settingUp;
  assert.equal((await slow.discard(ctx, project.id, pending.id)).status, 'discarded');
  assert.equal(fs.existsSync(pending.worktree), false);
  assert.equal(slow.get(ctx, project.id, pending.id).status, 'discarded', 'late setup failure cannot overwrite Discard');
});

test('shutdown aborts an explicit preview launch before closing its process owner or storage', async t => {
  const { project, workspace } = await scene();
  let began, closed = false;
  const launching = new Promise(resolve => { began = resolve; });
  const { builds } = manager(scripted(['Done']), { previews: {
    review: async () => null,
    open: async (_task, { signal }) => {
      began();
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Preview aborted')), { once: true }));
    },
    close: async () => { closed = true; },
  } });
  t.after(() => builds.stopAll());
  const task = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, task.id);
  const opening = assert.rejects(builds.preview(ctx, project.id, task.id), /aborted/);
  await launching;
  await builds.stopAll();
  await opening;
  assert.equal(closed, true);
  assert.equal(builds.get(ctx, project.id, task.id).preview, null);
  assert.ok(fs.existsSync(task.worktree), 'shutdown preserves review work for the next session');
});

test('a turn ends on NEEDS YOU (last line), ESCALATE (a quick task), or done', () => {
  assert.deepEqual(readEnding('Did half.\n\nNEEDS YOU: Which database?'), { ending: 'needs-you', question: 'Which database?', why: undefined, text: 'Did half.' });
  assert.equal(readEnding('NEEDS YOU: mid text\nthen more').ending, 'done', 'only the last line asks');
  assert.deepEqual(readEnding('ESCALATE: too big', { quick: true }), { ending: 'escalated', why: 'too big', text: '' });
  assert.equal(readEnding('ESCALATE: too big').ending, 'done', 'a Build never escalates');
  assert.equal(readEnding('Done.\nNEEDS YOU: q', { quick: true }).ending, 'escalated', 'a quick task asks no questions');
  assert.match(BUILD_SYSTEM_PROMPT, /NEEDS YOU:/);
  assert.match(BUILD_SYSTEM_PROMPT, /Do not implement anything that appears only in <history>/);
  assert.match(loadBuildPrompt(ctx.dataRoot, { quick: true }), /ESCALATE:/);
});

test('the policy: the project\'s folders can be read, never written; nothing else is granted', () => {
  const project = { dir: path.join(ctx.dataRoot, 'p') };
  const policy = buildPolicy({ project, dataRoot: ctx.dataRoot });
  assert.deepEqual(policy.readOnly, [project.dir, path.join(ctx.dataRoot, 'assets')]);
  assert.deepEqual([policy.mcpServers, policy.computerUse], [[], false]);
  const deny = claudeSettings(policy).permissions.deny;
  assert.ok(deny.includes(`Edit(/${project.dir}/**)`) && deny.includes(`Write(/${project.dir}/**)`));
  assert.ok(!deny.some((rule) => rule.includes('worktrees')), 'the worktrees under the data root stay writable');
});

/* ---------------------------------------------------------------------- lifecycle */

test('Build: the record, the frozen context, a worktree from the last commit, a turn, a checkpoint', async () => {
  const note = await projects.createNote(ctx, (await scene()).project.id, { name: 'unused' }); // another project's note of no concern
  assert.ok(note.id);
  const { code, project, workspace } = await scene({ doc: 'Build @[Spec] now.\n@bart what?\nbart> An old answer.' });
  const spec = await projects.createNote(ctx, project.id, { name: 'Spec', workspaceId: workspace.id, text: 'The spec says: add b.txt.' });
  const paper = await ctx.libraryDb.insert({ id: '6f7f8f9f-0000-4000-8000-000000000001', name: 'A paper', type: 'pdf', path: path.join(homeDir, 'paper.pdf'), project_id: project.id });
  write(path.join(code, 'a.txt'), 'uncommitted edit\n');
  const agent = scripted([({ task }) => { write(path.join(task.worktree, 'b.txt'), 'bee\n'); return 'Added b.txt.'; }]);
  const { builds, events } = manager(agent);
  const pre = await builds.preflight(ctx, project.id);
  assert.deepEqual([pre.ok, pre.dirty, pre.branch], [true, 1, 'main']);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, provider: 'anthropic', model: 'opus', effort: 'max', attach: [paper.id] });
  assert.equal(started.status, 'setting-up');
  assert.match(started.id, /^[0-9a-f]{10}$/);
  const task = await settled(project, started.id);
  assert.equal(task.status, 'review');
  assert.deepEqual([task.provider, task.modelId, task.effort, task.turn], ['anthropic', 'opus', 'max', 1]);
  assert.equal(task.worktree, path.join(ctx.dataRoot, 'worktrees', project.slug, task.id));
  assert.equal(task.branch, `engelbart/${task.id}`);
  assert.equal(fs.readFileSync(path.join(task.worktree, 'a.txt'), 'utf8'), 'one\ntwo\nthree\n', 'uncommitted work is left out');
  assert.equal(fs.readFileSync(path.join(code, 'a.txt'), 'utf8'), 'uncommitted edit\n', 'and untouched');
  assert.ok(!fs.existsSync(path.join(code, 'b.txt')), 'nothing reaches the person\'s folder before Accept');
  assert.equal(task.checkpoints.length, 1);
  assert.equal(sh(task.worktree, 'log', '-1', '--format=%s'), 'Build Feature: turn 1');
  assert.deepEqual(task.messages.map((m) => m.role), ['engelbart', 'agent']);
  assert.match(task.messages[0].text, /Started on Opus max from main at [0-9a-f]{7}; 1 uncommitted file left out\./);
  // what it was given: the document with the note in place, the attached paper, its working copy; no build lines
  const context = fs.readFileSync(path.join(project.dir, 'builds', task.id, 'context.md'), 'utf8');
  assert.equal(agent.calls[0].message, context);
  assert.equal(agent.calls[0].session, null);
  assert.equal(agent.calls[0].cwd, task.worktree);
  assert.match(context, /your working copy \(make every change here\): .*worktrees/);
  assert.match(context, /<workspace name="Feature">\nBuild @\[Spec\] now\.\n\n<file name="Spec" type="md" tags="note"[^>]*>\nThe spec says: add b\.txt\.\n<\/file>/);
  assert.match(context, /<attached>\n<file name="A paper" type="pdf"/);
  assert.ok(!/<history/.test(context), 'no archived version yet');
  assert.match(context, /"mentioned": true/);
  // the record, the workspace's list of Builds, the attached item linked, the events
  assert.deepEqual(projects.findWorkspace(ctx, project.id, workspace.id).workspace.builds, [task.id]);
  assert.ok(projects.findWorkspace(ctx, project.id, workspace.id).workspace.context.includes(paper.id));
  assert.ok(events.some((e) => e.channel === 'engelbart:build' && e.payload.status === 'running'));
  assert.ok(spec.id);
  const seen = await builds.review(ctx, project.id, task.id);
  assert.deepEqual(seen.files.map((f) => `${f.status} ${f.path}`), ['A b.txt']);
});

test('NEEDS YOU, a reply in the same session, a reply that waits for the turn, Stop', async () => {
  const { project, workspace } = await scene();
  let release;
  const agent = scripted([
    'Half done.\n\nNEEDS YOU: Blue or green?',
    ({ message }) => { assert.match(message, /<reply>\nGreen\.\n<\/reply>/); return new Promise((resolve) => { release = () => resolve('Painted it green.'); }); },
    ({ message }) => { assert.match(message, /<reply>\nAlso the border\.\n<\/reply>/); return 'Border too.'; },
    ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { kind: 'stopped' })))),
  ]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  let task = await settled(project, id);
  assert.deepEqual([task.status, task.question], ['needs-you', 'Blue or green?']);
  assert.equal(task.messages[task.messages.length - 1].text, 'Half done.', 'the question is on the card, not in the text');
  await builds.reply(ctx, project.id, id, 'Green.');
  await settled(project, id, ['needs-you', 'setting-up', 'queued']);
  assert.equal(agent.calls[1].session, 'session-1', 'the same session');
  await builds.reply(ctx, project.id, id, 'Also the border.'); // while the turn runs: it waits
  assert.equal(store.readTask(projects.findProject(ctx, project.id), id).queued, 'Also the border.');
  release();
  task = await settled(project, id);
  for (let i = 0; i < 50 && agent.calls.length < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  task = await settled(project, id);
  assert.equal(task.status, 'review');
  assert.deepEqual(task.messages.filter((m) => m.role !== 'engelbart').map((m) => `${m.role}: ${m.text}`), ['agent: Half done.', 'you: Green.', 'agent: Painted it green.', 'you: Also the border.', 'agent: Border too.']);
  await builds.reply(ctx, project.id, id, 'One more.');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(builds.stop(project.id, id));
  task = await settled(project, id);
  assert.equal(task.status, 'stopped');
});

test('a reply sent while a turn runs cuts it short and goes on in the same session, with nothing said about stopping (2026-09-27)', async () => {
  const { project, workspace } = await scene();
  const cut = ({ task, signal }) => { write(path.join(task.worktree, 'half.txt'), 'half done\n'); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { kind: 'stopped', session: 'session-cut' })))); };
  const agent = scripted([cut, ({ message }) => { assert.match(message, /^<reply>\nUse the blue one\.\n<\/reply>$/); return 'Blue it is.'; }]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id, ['setting-up', 'queued']);
  await builds.reply(ctx, project.id, id, 'Use the blue one.', { interrupt: true });
  const task = await turned(project, id, 2);
  assert.equal(task.status, 'review');
  assert.equal(agent.calls[1].session, 'session-cut', 'the turn cut short kept its session');
  assert.deepEqual(task.messages.filter((m) => m.role !== 'engelbart').map((m) => `${m.role}: ${m.text}`), ['you: Use the blue one.', 'agent: Blue it is.']);
  assert.ok(!task.messages.some((m) => /Stopped/.test(m.text)), 'no "Stopped" note: the person only replied');
  assert.deepEqual(task.checkpoints.map((c) => c.turn), [1], 'what the cut turn had done was saved');

  // a first turn cut short before it had a session: the reply goes to a new one with everything again
  const bare = scripted([({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { kind: 'stopped' })))), 'Started again.']);
  const other = manager(bare).builds;
  const second = await other.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, second.id, ['setting-up', 'queued']);
  await other.reply(ctx, project.id, second.id, 'Smaller, please.', { interrupt: true });
  await turned(project, second.id, 2);
  assert.equal(bare.calls[1].session, null);
  assert.match(bare.calls[1].message, /<workspace name="Feature">[\s\S]*<reply>\nSmaller, please\.\n<\/reply>$/);
  // a reply while it waits for a slot or is being set up never cuts anything
  assert.equal(other.stop(project.id, 'ffffffffff'), false);
});

test('Accept: one commit on the person\'s current branch, after theirs, checks run, worktree and branch gone', async () => {
  const { code, project, workspace } = await scene({ files: { 'a.txt': 'one\ntwo\nthree\n', 'package.json': '{"scripts":{"test":"node t.js"}}' } });
  const agent = scripted([
    ({ task }) => { write(path.join(task.worktree, 'a.txt'), 'one\nTWO\nthree\n'); return 'Changed two.'; },
    ({ task }) => { write(path.join(task.worktree, 'c.txt'), 'see\n'); return 'Added c.\n\nThe tests pass.'; },
  ]);
  const { builds, shells } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  await builds.reply(ctx, project.id, id, 'Add c too.');
  let task = await turned(project, id, 2);
  sh(code, 'checkout', '-q', '-b', 'feature');
  write(path.join(code, 'b.txt'), 'theirs\n');
  sh(code, 'add', '-A');
  sh(code, 'commit', '-qm', 'theirs meanwhile');
  const done = await builds.accept(ctx, project.id, id);
  assert.equal(done.status, 'accepted');
  assert.equal(done.accepted.branch, 'feature', 'the branch their folder is on, not main');
  assert.deepEqual(sh(code, 'log', '--format=%s', '-3').split('\n'), ['Feature', 'theirs meanwhile', 'init']);
  assert.match(sh(code, 'log', '-1', '--format=%b'), /Added c\.[\s\S]*Engelbart Build [0-9a-f]{10} · Sol high · 2 turns/);
  assert.equal(fs.readFileSync(path.join(code, 'c.txt'), 'utf8'), 'see\n');
  assert.deepEqual(shells.map((s) => s.command), ['npm test']);
  task = store.readTask(projects.findProject(ctx, project.id), id);
  assert.ok(!fs.existsSync(task.worktree));
  assert.equal(await git.branchExists(code, task.branch), false);
  const after = await builds.review(ctx, project.id, id);
  assert.deepEqual(after.files.map((f) => f.path).sort(), ['a.txt', 'c.txt'], 'an accepted Build\'s review is its commit');
});

test('Accept refuses without changing anything: failed checks, the person\'s overlapping edit, a conflict (then the agent resolves it)', async () => {
  const { code, project, workspace } = await scene();
  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(project.dir, 'project.json'), 'utf8')), build: { check: 'npm run fail' } }));
  const agent = scripted([
    ({ task }) => { write(path.join(task.worktree, 'a.txt'), 'one\nBUILD\nthree\n'); return 'Changed.'; },
    ({ message, task }) => {
      assert.match(message, /<from_engelbart>[\s\S]*conflict markers/);
      assert.match(fs.readFileSync(path.join(task.worktree, 'a.txt'), 'utf8'), /<<<<<<</);
      write(path.join(task.worktree, 'a.txt'), 'one\nBUILD+PERSON\nthree\n');
      return 'Resolved.';
    },
  ]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  const head = sh(code, 'rev-parse', 'HEAD');
  await assert.rejects(builds.accept(ctx, project.id, id), /checks failed \(npm run fail\)/);
  let task = store.readTask(projects.findProject(ctx, project.id), id);
  assert.deepEqual([task.status, task.checks.ok, task.checks.output], ['review', false, 'test failed: 1 of 3']);
  assert.equal(sh(code, 'rev-parse', 'HEAD'), head);
  assert.equal(sh(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), task.branch, 'the worktree is back on its branch');

  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(project.dir, 'project.json'), 'utf8')), build: { check: '' } }));
  write(path.join(code, 'a.txt'), 'the person, uncommitted\n');
  await assert.rejects(builds.accept(ctx, project.id, id), /uncommitted edits to a\.txt/);
  assert.equal(fs.readFileSync(path.join(code, 'a.txt'), 'utf8'), 'the person, uncommitted\n');

  write(path.join(code, 'a.txt'), 'one\nPERSON\nthree\n');
  sh(code, 'commit', '-qam', 'theirs');
  await assert.rejects(builds.accept(ctx, project.id, id), /same lines in a\.txt/);
  task = store.readTask(projects.findProject(ctx, project.id), id);
  assert.deepEqual([task.status, task.conflict.files], ['conflict', ['a.txt']]);
  await builds.fix(ctx, project.id, id);
  task = await settled(project, id, ['conflict', 'setting-up', 'queued', 'running']);
  task = await settled(project, id);
  assert.equal(task.status, 'review');
  const done = await builds.accept(ctx, project.id, id);
  assert.equal(done.status, 'accepted');
  assert.equal(fs.readFileSync(path.join(code, 'a.txt'), 'utf8'), 'one\nBUILD+PERSON\nthree\n');
  assert.deepEqual(sh(code, 'log', '--format=%s', '-2').split('\n'), ['Feature', 'theirs']);
});

test('conflict markers an agent leaves behind never land: Accept refuses, and the agent is told where they are', async () => {
  const { code, project, workspace } = await scene();
  const agent = scripted([
    ({ task }) => { write(path.join(task.worktree, 'a.txt'), 'one\nBUILD\nthree\n'); return 'Changed.'; },
    'Resolved, I think.', // leaves the markers in a.txt
    ({ message, task }) => { assert.match(message, /a\.txt still holds conflict markers/); write(path.join(task.worktree, 'a.txt'), 'one\nBOTH\nthree\n'); return 'Really resolved.'; },
  ]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  write(path.join(code, 'a.txt'), 'one\nPERSON\nthree\n');
  sh(code, 'commit', '-qam', 'theirs');
  await assert.rejects(builds.accept(ctx, project.id, id), /same lines/);
  await builds.fix(ctx, project.id, id);
  await turned(project, id, 2);
  await assert.rejects(builds.accept(ctx, project.id, id), /a\.txt still holds conflict markers/);
  assert.equal(sh(code, 'log', '-1', '--format=%s'), 'theirs', 'nothing landed');
  let task = store.readTask(projects.findProject(ctx, project.id), id);
  assert.deepEqual([task.status, task.conflict], ['conflict', { files: ['a.txt'], markers: true }]);
  await builds.fix(ctx, project.id, id);
  task = await turned(project, id, 3);
  assert.equal((await builds.accept(ctx, project.id, id)).status, 'accepted');
  assert.equal(fs.readFileSync(path.join(code, 'a.txt'), 'utf8'), 'one\nBOTH\nthree\n');
});

test('Discard, a failed turn, recovery after the app closed, and Resume in the same worktree', async () => {
  const { code, project, workspace } = await scene();
  const agent = scripted([Object.assign(new Error('rate limited'), { kind: 'failed' }), 'Went on.']);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  let task = await settled(project, id);
  assert.deepEqual([task.status, task.error], ['failed', 'rate limited']);
  // the app closed while it worked: a new manager finds the record left running
  store.writeTask(projects.findProject(ctx, project.id), { ...task, status: 'running' });
  const second = manager(agent).builds;
  const listed = second.list(ctx, project.id).find((t) => t.id === id);
  assert.equal(listed.status, 'interrupted');
  await second.resume(ctx, project.id, id);
  task = await settled(project, id, ['interrupted', 'setting-up', 'queued', 'running']);
  task = await settled(project, id);
  assert.equal(task.status, 'review');
  assert.match(agent.calls[1].message, /cut off/);
  const gone = await second.discard(ctx, project.id, id);
  assert.equal(gone.status, 'discarded');
  assert.ok(!fs.existsSync(task.worktree));
  assert.equal(await git.branchExists(code, task.branch), false);
  await assert.rejects(second.reply(ctx, project.id, id, 'hello'), /closed/);
});

test('a folder that cannot take a Build says why; one without history can be given one', async () => {
  const code = path.join(homeDir, 'no-history');
  write(path.join(code, 'index.js'), 'x\n');
  const project = await projects.createProject(ctx, { name: 'No history', directory: code });
  const { builds } = manager(scripted([]));
  const pre = await builds.preflight(ctx, project.id);
  assert.deepEqual([pre.ok, pre.canInit, pre.problems[0].code], [false, true, 'not-a-repository']);
  await assert.rejects(builds.start(ctx, project.id, { workspaceId: (await projects.createWorkspace(ctx, project.id, {})).id }), /no history yet/);
  const after = await builds.initRepository(ctx, project.id);
  assert.deepEqual([after.ok, after.dirty], [true, 0]);
  const bare = await projects.createProject(ctx, { name: 'No folder' });
  assert.equal((await builds.preflight(ctx, bare.id)).problems[0].code, 'no-directory');
  assert.equal((await manager(scripted([]), { gitReady: () => false }).builds.preflight(ctx, project.id)).problems[0].code, 'no-git');
});

test('quick tasks: their own slot, no workspace, a clean finish lands by itself; one that escalates becomes a Build', async () => {
  const { code, project, workspace } = await scene();
  let hold;
  const bigAgent = scripted([() => new Promise((resolve) => { hold = () => resolve('Big done.'); })]);
  const quickAgent = { calls: [], async turn(input) { this.calls.push(input); if (/escalate/.test(input.message)) return { text: 'ESCALATE: needs a schema change.', session: 'q' }; if (/full Build/.test(input.message)) return { text: 'Did it properly.', session: input.session }; write(path.join(input.task.worktree, 'quick.txt'), 'quick\n'); return { text: 'Fixed the typo.', session: 'q' }; } };
  const quickIds = new Set();
  const runner = { turn: (input) => (input.task.kind === 'quick' || quickIds.has(input.task.id) ? quickAgent.turn(input) : bigAgent.turn(input)) };
  const { builds } = manager(runner, { limits: { build: 1, quick: 1 } });
  const big = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, big.id, ['setting-up']);
  const quick = await builds.start(ctx, project.id, { kind: 'quick', text: '- [ ] fix the typo in the header', postItId: 'card-1' });
  assert.deepEqual([quick.kind, quick.workspaceId, quick.postItId, quick.title], ['quick', null, 'card-1', 'fix the typo in the header']);
  const landed = await settled(project, quick.id, ['setting-up', 'queued', 'running', 'review', 'accepting']);
  assert.equal(landed.status, 'accepted', 'a quick task does not wait behind a running Build, and lands by itself');
  assert.equal(fs.readFileSync(path.join(code, 'quick.txt'), 'utf8'), 'quick\n');
  assert.match(quickAgent.calls[0].system, /This is a quick task/);
  assert.match(quickAgent.calls[0].message, /<post-it>\n- \[ \] fix the typo in the header\n<\/post-it>/);
  hold();
  await settled(project, big.id);

  const hard = await builds.start(ctx, project.id, { kind: 'quick', text: 'escalate: rework the storage' });
  quickIds.add(hard.id);
  const escalated = await settled(project, hard.id);
  assert.deepEqual([escalated.status, escalated.escalation], ['escalated', 'needs a schema change.']);
  // a record from before 2026-09-27 has no `postIt`: its post-it is read back from the frozen context
  const record = store.readTask(projects.findProject(ctx, project.id), hard.id);
  delete record.postIt;
  store.writeTask(projects.findProject(ctx, project.id), record);
  const promoted = await builds.promote(ctx, project.id, hard.id, workspace.id);
  const moved = await turned(project, hard.id, 2);
  assert.deepEqual([moved.kind, moved.workspaceId, moved.status], ['build', workspace.id, 'review']);
  assert.equal(quickAgent.calls[quickAgent.calls.length - 1].session, 'q', 'the same session goes on');
  assert.ok(projects.findWorkspace(ctx, project.id, workspace.id).workspace.builds.includes(hard.id));
  // Run as big task puts the post-it in as an archived version of the workspace (2026-09-27); the document is not touched
  assert.equal(promoted.version.title, 'Imported from Task: escalate: rework the storage');
  assert.equal(archive.readArchive(ctx, project.id, workspace.id, promoted.version.file).text, `Imported from Task:\nescalate: rework the storage\n\nbuild> ${hard.id}\n`);
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }), 'Build the thing.');
  assert.deepEqual(projects.readNav(ctx).recent.map((entry) => [entry.projectId, entry.workspaceId])[0], [project.id, workspace.id], 'first of ⌘J\'s recent workspaces');
});

test('the "Needs you" card\'s model: another model of the same provider goes on in the session, another provider starts again with everything (2026-09-27)', async () => {
  const { project, workspace } = await scene();
  const agent = { calls: [], async turn(input) { this.calls.push(input); if (/escalate/.test(input.message)) return { text: 'ESCALATE: too big.', session: 'q1' }; return { text: 'Done properly.', session: input.session || 'fresh' }; } };
  const { builds } = manager(agent);
  const first = await builds.start(ctx, project.id, { kind: 'quick', text: 'escalate: one', provider: 'openai', model: 'sol', effort: 'high' });
  await settled(project, first.id);
  const same = await builds.promote(ctx, project.id, first.id, workspace.id, { provider: 'openai', model: 'astra', effort: 'xhigh' });
  assert.deepEqual([same.provider, same.model, same.effort], ['openai', 'astra', 'xhigh']);
  await turned(project, first.id, 2);
  const went = agent.calls[agent.calls.length - 1];
  assert.equal(went.session, 'q1', 'same provider: the session goes on');
  assert.equal(went.task.model, 'astra');
  assert.match(same.messages[same.messages.length - 1].text, /as a Build on .* xhigh\./);

  const second = await builds.start(ctx, project.id, { kind: 'quick', text: 'escalate: two', provider: 'openai', model: 'sol', effort: 'high' });
  await settled(project, second.id);
  const other = await builds.promote(ctx, project.id, second.id, workspace.id, { provider: 'anthropic', model: 'opus', effort: 'max' });
  assert.deepEqual([other.provider, other.model, other.effort], ['anthropic', 'opus', 'max']);
  await turned(project, second.id, 2);
  const fresh = agent.calls[agent.calls.length - 1];
  assert.equal(fresh.session, null, 'another provider cannot resume the session');
  assert.match(fresh.message, /<post-it>\nescalate: two\n<\/post-it>/, 'so it is given everything again');
  assert.match(fresh.message, /full Build/);
});

test('a post-it added to a workspace: a Build of it whose task is the post-it, put in as an archived version, the document untouched (2026-09-27)', async () => {
  const { project, workspace } = await scene({ doc: 'Old plan.' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: () => false });
  await projects.writeDoc(ctx, project.id, ref, 'The plan in front now.');
  const agent = scripted(['Renamed it.\n\nNEEDS YOU: Keep the old name as an alias?']);
  const { builds } = manager(agent);
  const task = await builds.start(ctx, project.id, { kind: 'build', workspaceId: workspace.id, postItId: 'card-9', text: '- [ ] rename the header\n' });
  assert.deepEqual([task.kind, task.workspaceId, task.postItId, task.title], ['build', workspace.id, 'card-9', 'rename the header']);
  assert.equal(task.version.title, 'Imported from Task: rename the header');
  const done = await settled(project, task.id);
  assert.equal(done.status, 'needs-you', 'a full Build: it may ask');
  const context = agent.calls[0].message;
  assert.match(context, /<post-it>\n- \[ \] rename the header\n<\/post-it>/);
  assert.match(context, /added it to a workspace as a full Build/);
  assert.match(context, /built from: a post-it added to the workspace "Feature"/);
  assert.match(context, /<history [^>]*>\nOld plan\.\n<\/history>/, 'the version before it, as history');
  assert.ok(!/The plan in front now/.test(context), 'the document in front is not its task');
  assert.doesNotMatch(agent.calls[0].system, /This is a quick task/);
  const held = projects.findWorkspace(ctx, project.id, workspace.id).workspace;
  assert.deepEqual(held.archives[held.archives.length - 1], task.version, 'the newest archived version');
  assert.ok(held.builds.includes(task.id));
  const version = archive.readArchive(ctx, project.id, workspace.id, task.version.file);
  assert.equal(version.text, `Imported from Task:\n- [ ] rename the header\n\nbuild> ${task.id}\n`);
  assert.deepEqual([version.held.imported, version.held.builds], [{ buildId: task.id }, [task.id]]);
  assert.equal(await projects.readDoc(ctx, project.id, ref), 'The plan in front now.', 'the workspace is not cleared');
  assert.deepEqual(projects.readNav(ctx).recent.map((entry) => [entry.projectId, entry.workspaceId])[0], [project.id, workspace.id], 'first of ⌘J\'s recent workspaces');
  await assert.rejects(builds.start(ctx, project.id, { kind: 'build', workspaceId: workspace.id, text: '  ' }), /empty/);
});

/* --------------------------------------------------------------------- the runner */

test('the real runner: command lines for both CLIs, the worktree as the working directory, no API key (CLIs stubbed)', async () => {
  const authFile = path.join(homeDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    calls.push({ command, cwd: options.cwd, env: options.env, input: fs.readFileSync(options.env.ENGELBART_BUILD_INPUT, 'utf8'), settings: options.env.ENGELBART_BUILD_SETTINGS ? fs.readFileSync(options.env.ENGELBART_BUILD_SETTINGS, 'utf8') : null });
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BUILD_OUTPUT, 'codex did it'); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc"}\n'); } else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude did it' })}\n`);
    return null;
  };
  const codexHome = path.join(homeDir, 'codex-home-build');
  const runner = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir, ANTHROPIC_API_KEY: 'sk-never', OPENAI_API_KEY: 'sk-never' }, runDirectory: path.join(homeDir, 'build-runs'), codexHome, codexAuthFile: authFile, run });
  const worktree = path.join(homeDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const policy = buildPolicy({ project: { dir: path.join(ctx.dataRoot, 'p') }, dataRoot: ctx.dataRoot });
  const claude = await runner.turn({ task: { id: 'abcdef0123', provider: 'anthropic', modelId: 'opus', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy });
  assert.equal(claude.text, 'claude did it');
  assert.ok(calls[0].command.startsWith(`exec ${CLAUDE_SUBSCRIPTION_COMMAND} `), 'subscription overrides are cleared after shell startup');
  assert.match(calls[0].command.replace(CLAUDE_SUBSCRIPTION_COMMAND, 'claude'), /^exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id "\$ENGELBART_BUILD_SESSION" --restricted --strict-mcp-config --tools "Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch" --permission-mode auto --permission-prompts none --add-dir "\$ENGELBART_BUILD_READ0" --add-dir "\$ENGELBART_BUILD_READ1" --settings "\$ENGELBART_BUILD_SETTINGS" --model "\$ENGELBART_BUILD_MODEL" --effort high --append-system-prompt-file "\$ENGELBART_BUILD_PROMPT" < "\$ENGELBART_BUILD_INPUT"$/);
  assert.equal(calls[0].cwd, worktree);
  assert.equal(calls[0].input, 'do it');
  assert.ok(!('ANTHROPIC_API_KEY' in calls[0].env) && !('OPENAI_API_KEY' in calls[0].env));
  assert.ok(JSON.parse(calls[0].settings).permissions.deny.length > 0);
  await runner.turn({ task: { id: 'abcdef0123', provider: 'anthropic', modelId: 'opus', effort: 'high', worktree }, message: 'again', session: claude.session, system: 'SYSTEM', policy });
  assert.match(calls[1].command, /--resume "\$ENGELBART_BUILD_SESSION"/);
  assert.equal(calls[1].env.ENGELBART_BUILD_SESSION, claude.session);
  const codex = await runner.turn({ task: { id: 'abcdef0123', provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy });
  assert.deepEqual([codex.text, codex.session], ['codex did it', '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc']);
  assert.match(calls[2].command, /^exec codex exec --color never -m "\$ENGELBART_BUILD_MODEL" -c 'model_reasoning_effort="high"' -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' -c 'tools\.web_search=true' --json -o/);
  assert.equal(calls[2].env.CODEX_HOME, codexHome);
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), 'SYSTEM');
  await runner.turn({ task: { id: 'abcdef0123', provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', worktree }, message: 'again', session: codex.session, system: 'SYSTEM', policy });
  assert.match(calls[3].command, /^exec codex exec resume "\$ENGELBART_BUILD_SESSION" -m/);
  assert.equal(fs.readdirSync(path.join(homeDir, 'build-runs')).length, 0, 'nothing of a turn stays on disk');
  // a turn stopped part way keeps its session: Claude Code's was named before it started, Codex's is in what it printed
  const cut = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, runDirectory: path.join(homeDir, 'build-runs'), codexHome, codexAuthFile: authFile, run: (shell, args, options, callback) => { callback(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }), /codex/.test(args[args.length - 1]) ? '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd"}\n' : ''); return null; } });
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(cut.turn({ task: { id: 'abcdef0123', provider: 'anthropic', modelId: 'opus', effort: 'high', worktree }, message: 'x', system: 'SYSTEM', policy, signal: stopped.signal }), (error) => error.kind === 'stopped' && /^[0-9a-f-]{36}$/.test(error.session));
  await assert.rejects(cut.turn({ task: { id: 'abcdef0123', provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', worktree }, message: 'x', system: 'SYSTEM', policy, signal: stopped.signal }), (error) => error.kind === 'stopped' && error.session === '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcd');
});

test('the fake agent (scripted runs) edits its worktree, asks when told to, and stops', async () => {
  const fake = createFakeRunner({ delayMs: 30 });
  const worktree = path.join(homeDir, 'fake-wt');
  fs.mkdirSync(worktree, { recursive: true });
  const task = { id: 'abcdef0123', kind: 'build', worktree, modelName: 'Opus', effort: 'high' };
  const first = await fake.turn({ task, message: 'please ask a question', session: null });
  assert.match(first.text, /NEEDS YOU: /);
  const second = await fake.turn({ task, message: '<reply>\nkeep going\n</reply>', session: first.session });
  assert.match(second.text, /the same session, continued/);
  assert.equal(fs.readFileSync(path.join(worktree, 'BUILD-FAKE.md'), 'utf8'), 'turn 1: first\nturn 2: keep going\n');
  const controller = new AbortController();
  const pending = fake.turn({ task, message: 'x', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.kind === 'stopped');
});

/* ------------------------------------------------------------------------ Clear */

test('Clear: the document archived, the blank one keeps open Builds\' lines, every mentioned item stays on the sidebar', async () => {
  const { project, workspace } = await scene();
  const kept = await projects.createNote(ctx, project.id, { name: 'Kept note', text: 'k' });
  const trashed = await projects.createNote(ctx, project.id, { name: 'Trashed note', text: 't' });
  await projects.unlinkFromWorkspace(ctx, project.id, workspace.id, trashed.id);
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  const text = '# Storage plan\nSee @[Kept note] and @[Trashed note] and @[Nowhere].\nbuild> 0123456789\nbuild> abcdefabcd\n';
  await projects.writeDoc(ctx, project.id, ref, text);
  const at = new Date('2026-09-25T21:03:12.000Z');
  const cleared = await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: (line) => line === 'build> 0123456789', now: () => at });
  assert.equal(cleared.text, 'build> 0123456789\n');
  assert.deepEqual(cleared.archive, { file: '2026-09-25T21-03-12Z', clearedAt: at.toISOString(), title: 'Storage plan' });
  assert.deepEqual(cleared.linked, [kept.id], 'what the document mentioned stays on the sidebar; what was thrown away stays away');
  const held = projects.findWorkspace(ctx, project.id, workspace.id).workspace;
  assert.deepEqual(held.archives, [cleared.archive]);
  assert.ok(held.context.includes(kept.id) && !held.context.includes(trashed.id));
  assert.equal(await projects.readDoc(ctx, project.id, ref), 'build> 0123456789\n');
  const saved = archive.readArchive(ctx, project.id, workspace.id, cleared.archive.file);
  assert.equal(saved.text, text);
  assert.deepEqual(saved.held.mentions, [kept.id, trashed.id], 'ids of what was mentioned, no note text');
  assert.ok(!JSON.stringify(saved.held).includes('"k"'));
  assert.ok(saved.path.includes(`${path.sep}.archive${path.sep}`));
  assert.equal((await projects.loadProject(ctx, project.id)).workspaces.find((w) => w.id === workspace.id).children.length, 0, '.archive is never a workspace');
  // nothing to archive in a document of kept lines alone
  const again = await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: (line) => line.startsWith('build> ') });
  assert.equal(again.archive, null);
  // a second Clear in the same second gets its own file; the newest goes to a Build as history
  await projects.writeDoc(ctx, project.id, ref, 'Second version.\nbuild> 0123456789\n');
  const second = await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: (line) => line.startsWith('build> '), now: () => at });
  assert.equal(second.archive.file, '2026-09-25T21-03-12Z-2');
  assert.equal(archive.latestArchive(ctx, project.id, workspace.id).text, 'Second version.\nbuild> 0123456789\n');
  // Restore: the current document is archived first, then the chosen version is back, with the kept lines after it
  await projects.writeDoc(ctx, project.id, ref, 'Third, unsaved thoughts.\nbuild> 0123456789\n');
  const restored = await archive.restoreArchive(ctx, project.id, workspace.id, cleared.archive.file, { keep: (line) => line === 'build> 0123456789' });
  assert.equal(restored.text, text, 'the version comes back as it was (its own build lines included)');
  assert.equal(restored.archive.title, 'Third, unsaved thoughts.');
  assert.equal(projects.findWorkspace(ctx, project.id, workspace.id).workspace.archives.length, 3);
  assert.throws(() => archive.readArchive(ctx, project.id, workspace.id, '../../x'), /invalid/);
});

test('importTask: one more archived version, headed "Imported from Task:", the document, links and edit time untouched (2026-09-27)', async () => {
  const { project, workspace } = await scene({ doc: 'Stays.' });
  const note = await projects.createNote(ctx, project.id, { name: 'Header spec', text: 'h' });
  await projects.unlinkFromWorkspace(ctx, project.id, workspace.id, note.id);
  const before = projects.findWorkspace(ctx, project.id, workspace.id).workspace;
  const at = new Date('2026-09-27T20:00:00.000Z');
  const entry = await archive.importTask(ctx, project.id, workspace.id, { text: '## Fix it\nper @[Header spec]', buildId: '0123456789', now: () => at });
  assert.deepEqual(entry, { file: '2026-09-27T20-00-00Z', clearedAt: at.toISOString(), title: 'Imported from Task: Fix it' });
  const after = projects.findWorkspace(ctx, project.id, workspace.id).workspace;
  assert.deepEqual([after.context, after.removed, after.chars], [before.context, before.removed, before.chars]);
  assert.equal(await projects.readDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }), 'Stays.');
  const saved = archive.readArchive(ctx, project.id, workspace.id, entry.file);
  assert.equal(saved.text, 'Imported from Task:\n## Fix it\nper @[Header spec]\n\nbuild> 0123456789\n');
  assert.deepEqual(saved.held.mentions, [note.id]);
  assert.equal(archive.latestArchive(ctx, project.id, workspace.id).file, entry.file, 'the next Build of the workspace is given it as history');
  await assert.rejects(archive.importTask(ctx, project.id, workspace.id, { text: 'x', buildId: '../x' }), /invalid/);
});

test('a Build after a Clear is given the newest archived version as history, with its mentions, and no Build lines', async () => {
  const { project, workspace } = await scene();
  await projects.createNote(ctx, project.id, { name: 'Old spec', text: 'The old spec.' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await projects.writeDoc(ctx, project.id, ref, 'Phase one per @[Old spec].\nbuild> 0123456789\n');
  await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: () => false });
  await projects.writeDoc(ctx, project.id, ref, 'Phase two: the new thing.');
  const agent = scripted(['ok']);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  const context = agent.calls[0].message;
  assert.match(context, /<workspace name="Feature">\nPhase two: the new thing\.\n<\/workspace>/);
  assert.match(context, /<history cleared="[^"]+" note="An earlier version of this workspace, cleared by the person\. Context only: do not implement anything that appears only here\.">\nPhase one per @\[Old spec\]\.\n\n<file name="Old spec"[^>]*>\nThe old spec\.\n<\/file>\n<\/history>/);
  assert.ok(!/build> 0123456789/.test(context));
  assert.equal(store.readTask(projects.findProject(ctx, project.id), id).archive, projects.findWorkspace(ctx, project.id, workspace.id).workspace.archives[0].file);
});

test('storage: builds/ is the project\'s, never a workspace, and does not count as the person editing', async () => {
  const { project } = await scene();
  assert.throws(() => store.taskDir(project, '../x'), /invalid/);
  const made = await projects.createWorkspace(ctx, project.id, { name: 'builds' });
  assert.equal(made.name, 'builds workspace');
  const legacy = projects.findWorkspace(ctx, project.id, made.id).workspace;
  fs.renameSync(legacy.dir, path.join(project.dir, 'builds')); // fixture for a pre-Build workspace with this name
  assert.equal(projects.findWorkspace(ctx, project.id, made.id).workspace.name, 'builds', 'adding Build storage never hides an existing workspace');
  const slugged = await projects.createProject(ctx, 'worktrees');
  assert.equal(slugged.slug, 'worktrees-project');
});
