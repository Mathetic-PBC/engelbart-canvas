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
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const archive = require('../src/main/store/archive.cjs');
const { createGit } = require('../src/main/build/git.cjs');
const { createBuilds, createShell, checkOutput } = require('../src/main/build/manager.cjs');
const store = require('../src/main/build/store.cjs');
const { readEnding, loadBuildPrompt, BUILD_SYSTEM_PROMPT } = require('../src/main/build/prompt.cjs');
const { buildPolicy, claudeSettings } = require('../src/main/build/policy.cjs');
const { createRunner, createFakeRunner } = require('../src/main/build/runner.cjs');
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
      calls.push({ message: input.message, session: input.session, cwd: input.task.worktree, system: input.system, policy: input.policy, engelbart: input.engelbart });
      const step = steps.shift();
      if (!step) throw Object.assign(new Error('no more steps'), { kind: 'failed' });
      const out = typeof step === 'function' ? await step(input) : step;
      if (out instanceof Error) throw out;
      return { text: out, session: input.session || `session-${calls.length}` };
    },
  };
}

/**
 * `builds` works in the project folder (scene makes it the repository) unless a test names another target; `raw` is
 * the manager as the app has it, whose Builds go to the default repo (repo/ in the project folder).
 */
function manager(runner, extra = {}) {
  const events = [];
  const shells = [];
  const raw = createBuilds({
    git, runner, readModels: () => MODELS,
    notify: (channel, payload) => events.push({ channel, payload }),
    runShell: async (command, cwd) => { shells.push({ command, cwd }); return command.includes('fail') ? { ok: false, output: 'test failed: 1 of 3' } : { ok: true, output: 'ok' }; },
    ...extra,
  });
  const PROJECT = { kind: 'project' };
  const builds = {
    ...raw,
    start: (c, pid, input = {}) => raw.start(c, pid, { target: PROJECT, ...input }),
    preflight: (c, pid, target = PROJECT) => raw.preflight(c, pid, target),
    initRepository: (c, pid, target = PROJECT) => raw.initRepository(c, pid, target),
  };
  return { builds, raw, events, shells };
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

test('Build has models of its own: Codex GPT-6.1-Sol high, Claude Code Opus high, the dialog on Build\'s own provider, Claude Code (2026-09-29)', () => {
  assert.equal(DEFAULT_MODELS.build.providers.openai.models.sol.id, 'gpt-6.1-sol');
  assert.equal(DEFAULT_MODELS.build.providers.anthropic.models.sonnet.id, 'claude-sonnet-5-5');
  const choices = buildChoices(MODELS);
  assert.equal(choices.provider, 'anthropic');
  assert.equal(buildChoices({ ...MODELS, provider: 'openai' }).provider, 'anthropic', 'not @bart\'s');
  assert.deepEqual(choices.providers.openai.ladder, [{ model: 'sol', effort: 'high' }]);
  assert.deepEqual(choices.providers.anthropic.ladder, [{ model: 'opus', effort: 'high' }]);
  assert.deepEqual(resolveBuildChoice(MODELS, { provider: 'anthropic' }), { provider: 'anthropic', model: 'opus', modelId: 'opus', modelName: 'Opus', effort: 'high' });
  assert.deepEqual(resolveBuildChoice(MODELS, { provider: 'openai', model: 'astra', effort: 'ultra' }).modelId, 'gpt-6-astra');
  assert.equal(resolveBuildChoice(MODELS, { provider: 'openai', model: 'nope', effort: 'max' }).effort, 'high', 'what the list does not offer falls back to the default');
  assert.deepEqual(resolveBuildChoice(MODELS, {}), { provider: 'anthropic', model: 'opus', modelId: 'opus', modelName: 'Opus', effort: 'high' });
  const edited = normalizeModels({ ...MODELS, build: { provider: 'openai', providers: { openai: { models: { sol: { id: 'gpt-7-sol', name: 'Sol' } }, default: { model: 'sol', effort: 'xhigh' } } } } });
  assert.deepEqual(resolveBuildChoice(edited, {}), { provider: 'openai', model: 'sol', modelId: 'gpt-7-sol', modelName: 'Sol', effort: 'xhigh' });
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

test('the policy (2026-10-07): notes written, saved copies, papers and Engelbart\'s records never edited, the person\'s own setup, no computer use', () => {
  const project = { dir: path.join(ctx.dataRoot, 'p') };
  const assets = path.join(ctx.dataRoot, 'assets');
  const paper = path.join(homeDir, 'Downloads', 'paper.pdf');
  const policy = buildPolicy({ project, dataRoot: ctx.dataRoot, papers: [paper, paper], gitDir: '/repo/.git' });
  assert.deepEqual(policy.folders, [project.dir, assets]);
  assert.deepEqual(policy.writable, [project.dir]);
  assert.deepEqual(policy.kept, [assets, path.join(project.dir, 'assets')]);
  assert.deepEqual(policy.papers, [paper]);
  assert.deepEqual([policy.gitDir, policy.personal, policy.subagents, policy.computerUse], ['/repo/.git', true, true, false]);
  const settings = claudeSettings(policy);
  const deny = settings.permissions.deny;
  assert.deepEqual(settings.permissions.allow, ['mcp__engelbart'], 'Engelbart\'s own tools need no classifier');
  for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
    for (const rule of [`/${assets}/**`, `/${path.join(project.dir, 'assets')}/**`, `/${paper}`, `/${path.join(project.dir, 'builds')}/**`, `/${path.join(project.dir, 'notes.pglite')}/**`, `/${path.join(project.dir, 'project.json')}`, `/${path.join(project.dir, '**', 'meta.json')}`, `/${path.join(ctx.dataRoot, 'library.pglite')}/**`]) assert.ok(deny.includes(`${tool}(${rule})`), `${tool}(${rule})`);
  }
  assert.ok(!deny.includes(`Edit(/${project.dir}/**)`), 'notes and workspaces can be written');
  assert.ok(!deny.some((rule) => rule.includes('worktrees')), 'the worktrees under the data root stay writable');
  assert.ok(deny.includes('mcp__computer-use'));
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
  assert.match(task.messages[0].text, /Started on Opus max in code\d+, from main at [0-9a-f]{7}; 1 uncommitted file left out\./);
  assert.deepEqual(task.target, { kind: 'project', name: path.basename(code) });
  // what it was given: the document with the note in place, the attached paper, its working copy; no build lines
  const context = fs.readFileSync(path.join(project.dir, 'builds', task.id, 'context.md'), 'utf8');
  assert.equal(agent.calls[0].message, context);
  assert.equal(agent.calls[0].session, null);
  assert.equal(agent.calls[0].cwd, task.worktree);
  assert.match(context, /your working copy \(make every change to the code here\): .*worktrees/);
  assert.match(context, /notes and workspaces \(you may write here; the engelbart tools add to the library\): /);
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

test('a turn\'s reach (2026-10-07): Engelbart\'s tools over its bridge; a paper the agent deleted put back and a branch it moved held, both said on the card', async () => {
  const { project, workspace } = await scene();
  const paperFile = path.join(homeDir, 'reach-paper.pdf');
  write(paperFile, '%PDF-1.4\n%%EOF\n');
  const paper = await ctx.libraryDb.insert({ id: '6f7f8f9f-0000-4000-8000-0000000000aa', name: 'Reach paper', type: 'pdf', path: paperFile, project_id: project.id });
  let saved = null;
  const agent = scripted([async ({ task, policy, engelbart }) => {
    // what it was given: the repository whose history is Engelbart's, the paper for the edit tools' rules, the bridge
    assert.equal(policy.gitDir, fs.realpathSync(path.join(task.repo, '.git')));
    assert.ok(policy.papers.includes(paperFile));
    const response = await fetch(engelbart.url, { method: 'POST', headers: { authorization: `Bearer ${engelbart.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'save_file', args: { name: 'Build notes', content: '# What I found' } }) });
    saved = JSON.parse((await response.json()).content[0].text);
    // what it should not do: delete a paper, commit, leave its branch
    fs.rmSync(paperFile);
    write(path.join(task.worktree, 'c.txt'), 'sea\n');
    sh(task.worktree, 'add', 'c.txt');
    sh(task.worktree, 'commit', '-qm', 'the agent\'s own commit');
    sh(task.worktree, 'checkout', '-q', '-b', 'side');
    write(path.join(task.worktree, 'd.txt'), 'dee\n');
    return 'Did it.';
  }]);
  const { builds, raw } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await settled(project, id);
  assert.equal(task.status, 'review');
  assert.equal(fs.readFileSync(paperFile, 'utf8'), '%PDF-1.4\n%%EOF\n', 'the paper is back');
  assert.equal(sh(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), task.branch, 'back on its branch');
  assert.equal(sh(task.worktree, 'rev-parse', 'HEAD^'), task.baseSha, 'one checkpoint on where it started: the agent\'s commit folded in');
  assert.deepEqual(sh(task.worktree, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['c.txt', 'd.txt']);
  const said = task.messages.filter((m) => m.role === 'engelbart').map((m) => m.text).join('\n');
  assert.match(said, /The agent deleted “Reach paper” from the library\. Engelbart put it back\./);
  assert.match(said, /The agent left the Build's branch/);
  assert.match(said, /The agent moved the Build's branch/);
  // what it saved is a note of the project, linked to the workspace
  assert.equal(saved.name, 'Build notes');
  assert.equal(fs.readFileSync(saved.path, 'utf8'), '# What I found');
  assert.ok(projects.findWorkspace(ctx, project.id, workspace.id).workspace.context.includes(saved.id));
  assert.ok(paper.id && raw);
});

test('Stop while a turn is being made ready (the library kept aside, Engelbart\'s tools opened): its agent never starts, and the Build is stopped (2026-10-07)', async () => {
  const { project, workspace } = await scene();
  const agent = scripted(['First.', 'Never said.']);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  assert.equal((await settled(project, id)).status, 'review');
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const slow = { ...ctx, libraryDb: { ...ctx.libraryDb, list: async () => { await gate; return ctx.libraryDb.list(); } } };
  await builds.reply(slow, project.id, id, 'Again.');
  let stopped = false;
  for (let i = 0; i < 250 && !stopped; i += 1) { stopped = builds.stop(project.id, id); if (!stopped) await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.ok(stopped);
  open();
  let task = null;
  for (let i = 0; i < 500 && (!task || task.status !== 'stopped'); i += 1) { await new Promise((resolve) => setTimeout(resolve, 20)); task = store.readTask(projects.findProject(ctx, project.id), id); }
  assert.equal(task.status, 'stopped');
  assert.equal(agent.calls.length, 1, 'the agent was never started for the reply');
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
  // once the agent works (a turn is made ready first: the library kept aside, Engelbart's tools opened; 2026-10-07)
  for (let i = 0; i < 250 && agent.calls.length < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
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
  assert.match(sh(code, 'log', '-1', '--format=%b'), /Added c\.[\s\S]*Engelbart Build [0-9a-f]{10} · Opus high · 2 turns/);
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
  const { builds } = manager(agent, { autoFixes: 0 }); // the refusals by hand; Accept sending them itself is tested below
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
  const { builds } = manager(agent, { autoFixes: 0 });
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

test('a refused Accept goes to the agent by itself and Accept runs again: failed checks, then a conflict (2026-09-29)', async () => {
  const { code, project, workspace } = await scene();
  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(project.dir, 'project.json'), 'utf8')), build: { check: 'npm test' } }));
  const agent = scripted([
    ({ task }) => { write(path.join(task.worktree, 'a.txt'), 'one\nBUILD\nthree\n'); return 'Changed.'; },
    ({ message, task }) => { assert.match(message, /checks failed[\s\S]*npm test[\s\S]*broken/); write(path.join(task.worktree, 'fixed.txt'), 'yes\n'); return 'Fixed the test.'; },
  ]);
  const runShell = async (command, cwd) => (fs.existsSync(path.join(cwd, 'fixed.txt')) ? { ok: true, output: 'ok' } : { ok: false, output: 'broken' });
  const { builds } = manager(agent, { runShell });
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  const pressed = await builds.accept(ctx, project.id, id); // no rejection: it was sent on
  assert.equal(pressed.landing.attempt, 1);
  let task = await settled(project, id, ['setting-up', 'queued', 'running', 'accepting', 'review']);
  assert.equal(task.status, 'accepted');
  assert.equal(agent.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(code, 'fixed.txt'), 'utf8'), 'yes\n');
  assert.equal(task.landing || null, null);

  // a conflict: the person's branch is merged in, the agent resolves the markers, Accept lands both
  const second = await scene();
  const agent2 = scripted([
    ({ task: t }) => { write(path.join(t.worktree, 'a.txt'), 'one\nBUILD\nthree\n'); return 'Changed.'; },
    ({ message, task: t }) => { assert.match(message, /conflict markers/); write(path.join(t.worktree, 'a.txt'), 'one\nBUILD+PERSON\nthree\n'); return 'Resolved.'; },
  ]);
  const m2 = manager(agent2);
  const started = await m2.builds.start(ctx, second.project.id, { workspaceId: second.workspace.id });
  await settled(second.project, started.id);
  write(path.join(second.code, 'a.txt'), 'one\nPERSON\nthree\n');
  sh(second.code, 'commit', '-qam', 'theirs');
  await m2.builds.accept(ctx, second.project.id, started.id);
  task = await settled(second.project, started.id, ['setting-up', 'queued', 'running', 'accepting', 'review', 'conflict']);
  assert.equal(task.status, 'accepted');
  assert.equal(fs.readFileSync(path.join(second.code, 'a.txt'), 'utf8'), 'one\nBUILD+PERSON\nthree\n');
});

test('an Accept the agent cannot fix goes back twice at most, then waits for the person (2026-09-29)', async () => {
  const { code, project, workspace } = await scene();
  fs.writeFileSync(path.join(project.dir, 'project.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(project.dir, 'project.json'), 'utf8')), build: { check: 'npm run fail' } }));
  const agent = scripted([
    ({ task }) => { write(path.join(task.worktree, 'a.txt'), 'one\nBUILD\nthree\n'); return 'Changed.'; },
    'Tried once.',
    'Tried twice.',
  ]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  const head = sh(code, 'rev-parse', 'HEAD');
  await builds.accept(ctx, project.id, id);
  let task;
  for (let i = 0; i < 500; i += 1) {
    task = store.readTask(projects.findProject(ctx, project.id), id);
    if (task.turn >= 3 && !task.landing && !['running', 'queued', 'accepting'].includes(task.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(agent.calls.length, 3, 'the first turn and two fixes');
  assert.deepEqual([task.status, task.landing || null, task.checks.ok], ['review', null, false]);
  assert.match(task.messages[task.messages.length - 1].text, /Still refused after the agent's 2 fixes/);
  assert.equal(sh(code, 'rev-parse', 'HEAD'), head, 'nothing landed');
});

test('the card is sent the Build\'s diff as the agent works, unsaved files too, and once more when the turn ends (2026-09-29)', async () => {
  const { project, workspace } = await scene();
  let during = null;
  const agent = scripted([
    async ({ task, onUpdate }) => {
      write(path.join(task.worktree, 'new.txt'), 'fresh\n');
      onUpdate({ activity: 'Editing new.txt', log: true });
      for (let i = 0; i < 100 && !during; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      return 'Done.';
    },
  ]);
  const { builds, events } = manager(agent, { diffMs: 5 });
  const watch = setInterval(() => { const e = events.find((x) => x.channel === 'engelbart:build-diff' && x.payload.running); if (e) during = e.payload; }, 5);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await settled(project, id);
  clearInterval(watch);
  assert.ok(during, 'a diff while the turn ran');
  assert.deepEqual(during.files.map((f) => f.path), ['new.txt']);
  assert.match(during.patch, /\+fresh/);
  assert.equal(sh(task.worktree, 'status', '--porcelain'), '', 'the turn\'s checkpoint took it all');
  let last = null;
  for (let i = 0; i < 200 && !(last && !last.payload.running); i += 1) { await new Promise((resolve) => setTimeout(resolve, 10)); last = events.filter((x) => x.channel === 'engelbart:build-diff').pop(); }
  assert.equal(last.payload.running, false, 'the turn\'s last diff comes last');
  assert.deepEqual(last.payload.files.map((f) => f.path), ['new.txt']);
  write(path.join(task.worktree, 'later.txt'), 'unsaved\n');
  const review = await builds.review(ctx, project.id, id);
  assert.deepEqual(review.files.map((f) => f.path).sort(), ['later.txt', 'new.txt']);
  assert.match(sh(task.worktree, 'status', '--porcelain'), /\?\? later\.txt/, 'still untracked after the review');
});

test('a reply\'s pasted images reach the agent as files named [Attachment n] (2026-09-29)', async () => {
  const { project, workspace } = await scene();
  const agent = scripted(['First.', 'Seen it.']);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, id);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const image = await projects.saveImage(ctx, project.id, { bytes: png, mime: 'image/png', name: 'Attachment 1' });
  const other = await projects.saveImage(ctx, project.id, { bytes: png, mime: 'image/png', name: 'Attachment 2' });
  await builds.reply(ctx, project.id, id, 'Match this: [Attachment 1]', { images: [{ n: 1, id: image.id }, { n: 2, id: other.id }, { n: 3, id: 'not-an-id' }] });
  const task = await turned(project, id, 2);
  const sent = agent.calls[1].message;
  assert.match(sent, /<reply>\nMatch this: \[Attachment 1\]\n<\/reply>/);
  assert.ok(sent.includes(`[Attachment 1]: ${image.path}`));
  assert.ok(!sent.includes(other.path), 'an attachment taken out of the text is not sent');
  const mine = task.messages.find((m) => m.role === 'you');
  assert.deepEqual([mine.text, mine.images], ['Match this: [Attachment 1]', [{ n: 1, id: image.id }]]);
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

test('a project deleted while its Build works: the turn stops and nothing starts by itself; restored under another folder name its worktree follows and Resume goes on; purged, its worktree and branch go (2026-10-03)', async () => {
  const { code, project, workspace } = await scene();
  const files = (dir) => Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter((name) => !name.split(path.sep).includes('.git')).sort().map((name) => [name, fs.statSync(path.join(dir, name)).isFile() ? fs.readFileSync(path.join(dir, name), 'utf8') : '/']));
  const before = files(code);
  let begun;
  const working = new Promise((resolve) => { begun = resolve; });
  const agent = scripted([
    ({ task, signal }) => { write(path.join(task.worktree, 'half.txt'), 'half\n'); begun(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped.'), { kind: 'stopped', session: 'session-1' })))); },
    ({ message }) => { assert.match(message, /cut off/); return 'Went on.'; },
    ({ message }) => { assert.match(message, /<reply>\nAnd the tests\.\n<\/reply>/); return 'Tests too.'; },
  ]);
  const { builds } = manager(agent);
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  await working;
  await builds.reply(ctx, project.id, id, 'And the tests.'); // waits for the turn
  const stopBuilds = (pid) => builds.stopProject(ctx, pid);
  await projects.trashProject(ctx, project.id, { stopBuilds });
  assert.deepEqual(builds.running(), [], 'its turn was stopped');
  const inTrash = { dir: path.join(ctx.dataRoot, '.trash', project.slug) };
  let task = store.readTask(inTrash, id);
  assert.deepEqual([task.status, task.sessionId, task.queued, task.checkpoints.length], ['stopped', 'session-1', 'And the tests.', 1], 'stopped, its work saved, the reply still waiting');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(agent.calls.length, 1, 'the waiting reply did not start a turn in a deleted project');
  assert.ok(fs.existsSync(path.join(task.worktree, 'half.txt')), 'its copy stays while the project is in the trash');
  const oldCopy = task.worktree;

  // A new project takes the folder name meanwhile: the restored one gets the next, and its Build's worktree follows it.
  assert.equal((await projects.createProject(ctx, project.name)).slug, project.slug);
  const back = await projects.restoreProject(ctx, project.id, { moveWorktree: builds.moveWorktree, removeWorktrees: builds.removeWorktrees });
  assert.equal(back.slug, `${project.slug} 2`);
  task = store.readTask(projects.findProject(ctx, project.id), id);
  assert.equal(task.worktree, path.join(ctx.dataRoot, 'worktrees', back.slug, id));
  assert.equal(task.cwd, task.worktree);
  assert.ok(!fs.existsSync(oldCopy));
  assert.equal(fs.readFileSync(path.join(task.worktree, 'half.txt'), 'utf8'), 'half\n');
  assert.equal(sh(task.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), task.branch, 'git knows the copy where it is now');
  assert.ok(sh(code, 'worktree', 'list', '--porcelain').includes(`${back.slug}/${id}`));

  // Resume goes on in the same session, where the copy is now, and the reply that waited follows.
  await builds.resume(ctx, project.id, id);
  task = await turned(project, id, 3);
  assert.equal(task.status, 'review');
  assert.deepEqual(agent.calls.slice(1).map((call) => [call.session, call.cwd]), [['session-1', task.worktree], ['session-1', task.worktree]]);

  // Deleted again, and purged a week later: its worktree and branch go; the code folder's files are as they were.
  await projects.trashProject(ctx, project.id, { stopBuilds });
  await projects.trashedProjects(ctx, Date.now() + 8 * 24 * 60 * 60 * 1000, { removeWorktrees: builds.removeWorktrees });
  assert.ok(!fs.existsSync(task.worktree));
  assert.equal(await git.branchExists(code, task.branch), false);
  assert.ok(!sh(code, 'worktree', 'list', '--porcelain').includes(id));
  assert.deepEqual(files(code), before);
  await assert.rejects(projects.restoreProject(ctx, project.id), /no longer in the trash/);
});

test('a project whose Build is being accepted cannot be deleted until that is done (2026-10-03)', async () => {
  const { project, workspace } = await scene();
  const { builds } = manager(scripted(['Done.']));
  const { id } = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await settled(project, id);
  store.writeTask(projects.findProject(ctx, project.id), { ...task, status: 'accepting' });
  await assert.rejects(projects.trashProject(ctx, project.id, { stopBuilds: (pid) => builds.stopProject(ctx, pid) }), /being accepted/);
  assert.equal(projects.findProject(ctx, project.id).dir, project.dir, 'nothing moved');
});

test('a folder that cannot take a Build says why; one without history is given one when the Build starts, unasked (2026-09-29)', async () => {
  const code = path.join(homeDir, 'no-history');
  write(path.join(code, 'index.js'), 'x\n');
  const project = await projects.createProject(ctx, { name: 'No history', directory: code });
  const { builds } = manager(scripted([]));
  const pre = await builds.preflight(ctx, project.id);
  assert.deepEqual([pre.ok, pre.init, pre.problems], [true, true, []], 'nothing for the panel to say');
  const after = await builds.initRepository(ctx, project.id);
  assert.deepEqual([after.ok, after.init, after.dirty], [true, undefined, 0]);
  const other = path.join(homeDir, 'no-history-2');
  write(path.join(other, 'index.js'), 'y\n');
  const second = await projects.createProject(ctx, { name: 'No history 2', directory: other });
  const agent = scripted([() => 'Looked.']);
  const started = await manager(agent).builds.start(ctx, second.id, { workspaceId: (await projects.createWorkspace(ctx, second.id, {})).id });
  assert.ok(fs.existsSync(path.join(other, '.git')), 'the history was started by the Build');
  assert.match(sh(other, 'log', '-1', '--format=%s'), /First snapshot \(Engelbart\)/);
  assert.equal((await turned(second, started.id, 1)).turn, 1, 'and the Build went on from it');
  const bare = await projects.createProject(ctx, { name: 'No folder' });
  assert.equal((await builds.preflight(ctx, bare.id)).problems[0].code, 'no-directory');
  assert.equal((await manager(scripted([]), { gitReady: () => false }).builds.preflight(ctx, project.id)).problems[0].code, 'no-git');
});

test('a project folder Engelbart made gets its default repo and first commit in the background, before any Build (2026-09-29)', async () => {
  const code = path.join(homeDir, 'made-by-engelbart');
  fs.mkdirSync(code);
  const project = await projects.createProject(ctx, { name: 'Made Here', directory: code });
  assert.equal(await manager(scripted([]), { gitReady: () => false }).raw.prepareDefault(ctx, project.id), null, 'not while Git is not ready: the first Build makes it');
  const { raw } = manager(scripted([]));
  const folder = await raw.prepareDefault(ctx, project.id);
  assert.equal(folder, path.join(code, 'made-here'));
  assert.match(sh(folder, 'log', '-1', '--format=%s'), /First snapshot \(Engelbart\)/);
  const [row] = await ctx.libraryDb.query('select * from library where folder_path = $1', [folder]);
  assert.deepEqual(projects.findProject(ctx, project.id).defaultTarget, { kind: 'library', id: row.id }, 'kept as the project\'s default, as its row');
  const pre = await raw.preflight(ctx, project.id, { kind: 'default' });
  assert.deepEqual([pre.ok, pre.create, pre.directory], [true, undefined, folder], 'the first Build finds it ready');
  assert.ok(!fs.existsSync(path.join(code, '.git')), 'the project folder itself is left alone');
});

test('the default repo: a folder named after the project, made with a history of its own by the first Build, never a commit around it (2026-09-29)', async () => {
  const { code, project, workspace } = await scene();
  const agent = scripted([({ task }) => { write(path.join(task.worktree, 'b.txt'), 'bee\n'); return 'Added b.txt.'; }]);
  const { raw } = manager(agent);
  const named = project.name.toLowerCase().replace(/ /g, '-'); // "Build 12" → build-12
  const mine = path.join(code, named);
  const list = await raw.targets(ctx, project.id);
  assert.deepEqual(list.map((item) => [item.kind, item.name, item.folder]), [['default', named, mine], ['project', path.basename(code), code]], 'the code directory is offered after it, as a repository (Make default)');
  const pre = await raw.preflight(ctx, project.id);
  assert.deepEqual([pre.ok, pre.create, pre.target], [true, true, { kind: 'default', name: named }]);
  assert.ok(!fs.existsSync(mine), 'asking makes nothing');
  const started = await raw.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await settled(project, started.id);
  assert.equal(task.status, 'review');
  assert.deepEqual([task.repo, task.source, task.target], [mine, mine, { kind: 'default', name: named }]);
  assert.match(task.messages[0].text, new RegExp(`in ${named}, from \\S+ at [0-9a-f]{7}\\.`));
  assert.ok(fs.existsSync(path.join(mine, '.git')), 'a repository of its own');
  assert.equal(sh(mine, 'log', '--format=%s'), 'First snapshot (Engelbart)');
  assert.equal(sh(code, 'log', '--format=%s'), 'init', 'the project folder\'s own history is untouched');
  // Its library row (2026-09-29): a folder tagged git, the project's; listed once, as the default repo.
  const rows = () => ctx.libraryDb.query('select * from library where folder_path = $1', [mine]);
  const [row] = await rows();
  assert.deepEqual([row.name, row.type, row.tags, row.project_id], [named, 'folder', ['git'], project.id]);
  assert.deepEqual((await raw.targets(ctx, project.id)).map((item) => [item.kind, item.folder]), [['default', mine], ['project', code]]);
  assert.deepEqual(projects.findProject(ctx, project.id).defaultTarget, { kind: 'library', id: row.id }, 'kept as its row: a rename never moves it');
  await raw.accept(ctx, project.id, task.id);
  assert.equal(fs.readFileSync(path.join(mine, 'b.txt'), 'utf8'), 'bee\n', 'Accept lands in the default repo');
  assert.ok(!fs.existsSync(path.join(code, 'b.txt')));
  const again = await raw.preflight(ctx, project.id, { kind: 'default' });
  assert.deepEqual([again.ok, !!again.create, again.top], [true, false, mine]);
  // Renaming the project never moves it: its folder is kept in project.json.
  await projects.renameProject(ctx, project.id, `${project.name} renamed`);
  assert.equal((await raw.preflight(ctx, project.id)).top, mine);
  assert.equal((await raw.targets(ctx, project.id))[0].name, named);
  // A second Build there makes no second row.
  const agent2 = scripted(['Nothing to do.']);
  const second = await manager(agent2).raw.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, second.id);
  assert.equal((await rows()).length, 1);
});

test('the default repo that already has a row (added to the library by hand) is not given a second one (2026-09-29)', async () => {
  const { code, project, workspace } = await scene();
  const named = project.name.toLowerCase().replace(/ /g, '-');
  const mine = path.join(code, named);
  const theirs = await ctx.libraryDb.insert({ id: randomUUID(), name: 'my name for it', type: 'folder', tags: ['git'], folder_path: mine });
  const { raw } = manager(scripted(['Done.']));
  const started = await raw.start(ctx, project.id, { workspaceId: workspace.id });
  await settled(project, started.id);
  const rows = await ctx.libraryDb.query('select * from library where folder_path = $1', [mine]);
  assert.deepEqual(rows.map((row) => [row.id, row.name]), [[theirs.id, 'my name for it']]);
});

test('the Build picker lists the git rows this project holds: made in it or in a workspace\'s context, not another project\'s (2026-09-29)', async () => {
  const { project, workspace } = await scene();
  const other = await projects.createProject(ctx, { name: `Elsewhere ${n}` });
  const repo = (name, extra = {}) => { const dir = path.join(homeDir, `${name}-${n}`); fs.mkdirSync(dir); sh(dir, 'init', '-q', '-b', 'main'); return ctx.libraryDb.insert({ id: randomUUID(), name, type: 'folder', tags: ['git'], folder_path: dir, ...extra }); };
  const made = await repo('made-here', { project_id: project.id });
  const linked = await repo('in-context');
  const theirs = await repo('theirs', { project_id: other.id });
  const loose = await repo('nobodys');
  const notes = await ctx.libraryDb.insert({ id: randomUUID(), name: 'A folder, not a repository', type: 'folder', folder_path: homeDir, project_id: project.id });
  await projects.linkToWorkspace(ctx, project.id, workspace.id, [linked.id]);
  const { raw } = manager(scripted([]));
  const ids = (await raw.targets(ctx, project.id)).map((item) => item.id || item.kind);
  assert.deepEqual(ids, ['default', 'project', made.id, linked.id]);
  assert.ok(![theirs.id, loose.id, notes.id].some((id) => ids.includes(id)));
});

test('the default repo never takes a folder of the person\'s that has the project\'s name: the next free one (2026-09-29)', async () => {
  const { code, project } = await scene();
  const named = project.name.toLowerCase().replace(/ /g, '-');
  write(path.join(code, named, 'module.py'), 'x = 1\n'); // e.g. a Python package named like the project
  fs.mkdirSync(path.join(code, `${named}-2`)); // an empty one is fine to use
  const { raw } = manager(scripted([]));
  const pre = await raw.preflight(ctx, project.id);
  assert.deepEqual([pre.ok, pre.create, pre.directory, pre.target.name], [true, true, path.join(code, `${named}-2`), `${named}-2`]);
  assert.ok(!fs.existsSync(path.join(code, named, '.git')));
});

test('library repositories: a local one works as it is, a GitHub one is cloned into repos/<name> first and its row keeps the clone (2026-09-29)', async () => {
  const { code, project, workspace } = await scene();
  // github.com/example/… comes from folders here, so nothing reaches the network.
  const remotes = path.join(homeDir, 'remotes');
  const origin = path.join(remotes, 'app');
  fs.mkdirSync(origin, { recursive: true });
  sh(origin, 'init', '-q', '-b', 'main');
  write(path.join(origin, 'app.js'), 'app\n');
  sh(origin, 'add', '-A');
  sh(origin, 'commit', '-qm', 'app');
  fs.appendFileSync(path.join(homeDir, '.gitconfig'), `[url "${pathToFileURL(remotes).href}/"]\n\tinsteadOf = https://github.com/example/\n`);
  const local = path.join(homeDir, `local-lib-${n}`);
  fs.mkdirSync(local);
  sh(local, 'init', '-q', '-b', 'main');
  write(path.join(local, 'lib.js'), 'lib\n');
  sh(local, 'add', '-A');
  sh(local, 'commit', '-qm', 'lib');
  const hub = await ctx.libraryDb.insert({ id: randomUUID(), name: 'example/app', type: 'website', tags: ['git'], url: 'https://github.com/example/app', project_id: project.id });
  const mine = await ctx.libraryDb.insert({ id: randomUUID(), name: 'local-lib', type: 'folder', tags: ['git'], folder_path: local, project_id: project.id });
  const agent = scripted([({ task }) => { write(path.join(task.worktree, 'more.js'), 'more\n'); return 'Added more.js.'; }]);
  const { raw } = manager(agent);
  const listed = (list, id) => list.find((item) => item.id === id);
  let list = await raw.targets(ctx, project.id);
  assert.deepEqual([listed(list, hub.id).place, listed(list, hub.id).folder], ['github', null]);
  assert.deepEqual([listed(list, mine.id).place, listed(list, mine.id).folder], ['local', local]);

  const target = { kind: 'library', id: hub.id };
  const pre = await raw.preflight(ctx, project.id, target);
  assert.deepEqual([pre.ok, pre.canClone, pre.cloneTo, pre.problems[0].message], [false, true, path.join('repos', 'app'), 'example/app is not on this Mac yet.']);
  const cloned = await raw.cloneRepository(ctx, project.id, target);
  const into = path.join(code, 'repos', 'app');
  assert.deepEqual([cloned.ok, cloned.top, cloned.target], [true, into, { kind: 'library', id: hub.id, name: 'example/app' }]);
  assert.equal(fs.readFileSync(path.join(into, 'app.js'), 'utf8'), 'app\n');
  const row = await ctx.libraryDb.get(hub.id);
  assert.deepEqual([row.folder_path, row.type, row.url], [into, 'folder', 'https://github.com/example/app'], 'the row keeps its clone, and its address (its sandbox is found by it)');
  await assert.rejects(raw.cloneRepository(ctx, project.id, target), /already on this Mac/);
  list = await raw.targets(ctx, project.id);
  assert.equal(listed(list, hub.id).place, 'local');

  const started = await raw.start(ctx, project.id, { workspaceId: workspace.id, target: { kind: 'library', id: mine.id } });
  const task = await settled(project, started.id);
  assert.deepEqual([task.status, task.repo, task.target.name], ['review', local, 'local-lib']);
  await raw.accept(ctx, project.id, task.id);
  assert.equal(fs.readFileSync(path.join(local, 'more.js'), 'utf8'), 'more\n', 'Accept lands in the library repository');
  await assert.rejects(raw.preflight(ctx, project.id, { kind: 'library', id: randomUUID() }), /not in the library/);
});

test('a Build in a library repository not on this Mac clones it into repos/<name> before its agent starts, and its row keeps the clone (2026-09-29)', async () => {
  const { code, project, workspace } = await scene();
  const remotes = path.join(homeDir, `remotes-auto-${n}`);
  const origin = path.join(remotes, 'sandboxed');
  fs.mkdirSync(origin, { recursive: true });
  sh(origin, 'init', '-q', '-b', 'main');
  write(path.join(origin, 'index.js'), 'hi\n');
  sh(origin, 'add', '-A');
  sh(origin, 'commit', '-qm', 'first');
  const into = path.join(code, 'repos', 'sandboxed');
  let clonedFirst = null;
  const stub = { ...git, clone: async (url, dir) => { assert.equal(url, 'https://github.com/example/sandboxed'); return git.clone(origin, dir); } };
  const agent = scripted([({ task }) => { clonedFirst = fs.existsSync(path.join(into, 'index.js')); write(path.join(task.worktree, 'more.js'), 'more\n'); return 'Added more.js.'; }]);
  let changed = 0;
  const { raw } = manager(agent, { git: stub, libraryChanged: () => { changed += 1; } });
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'example/sandboxed', type: 'website', tags: ['git'], url: 'https://github.com/example/sandboxed', project_id: project.id });
  const started = await raw.start(ctx, project.id, { workspaceId: workspace.id, target: { kind: 'library', id: row.id } });
  assert.deepEqual([started.target, started.status], [{ kind: 'library', id: row.id, name: 'example/sandboxed' }, 'setting-up']);
  assert.equal((await ctx.libraryDb.get(row.id)).folder_path, into, 'the clone is on the row before start returns');
  assert.ok(changed >= 1, 'the sidebar is told');
  const task = await settled(project, started.id);
  assert.deepEqual([task.status, task.repo, clonedFirst], ['review', into, true]);
  const listed = (await raw.targets(ctx, project.id)).find((item) => item.id === row.id);
  assert.deepEqual([listed.place, listed.folder], ['local', into]);
  // A clone GitHub refuses stops the Build before anything is made.
  const refused = await ctx.libraryDb.insert({ id: randomUUID(), name: 'example/refused', type: 'website', tags: ['git'], url: 'https://github.com/example/refused', project_id: project.id });
  const failing = { ...git, clone: async () => { throw new Error('fatal: repository not found'); } };
  const before = store.listTasks(projects.findProject(ctx, project.id)).length;
  await assert.rejects(manager(scripted([]), { git: failing }).raw.start(ctx, project.id, { workspaceId: workspace.id, target: { kind: 'library', id: refused.id } }), /example\/refused could not be cloned: GitHub refused/);
  assert.equal(store.listTasks(projects.findProject(ctx, project.id)).length, before, 'no record');
  assert.equal((await ctx.libraryDb.get(refused.id)).folder_path, null);
});

test('cloning a library repository: the GitHub sign-in first, the person\'s own Git when GitHub turns it away, and a refusal says what to do (2026-09-29)', async () => {
  const { code, project } = await scene();
  const origin = path.join(homeDir, `origin-${n}`);
  fs.mkdirSync(origin);
  sh(origin, 'init', '-q', '-b', 'main');
  write(path.join(origin, 'x.js'), 'x\n');
  sh(origin, 'add', '-A');
  sh(origin, 'commit', '-qm', 'x');
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'example/private', type: 'website', tags: ['git'], url: 'https://github.com/example/private' });
  const target = { kind: 'library', id: row.id };
  const calls = [];
  let theirs = true;
  const stub = { ...git, clone: async (url, dir, options = {}) => {
    calls.push({ url, token: options.token || null });
    if (options.token || !theirs) throw new Error("fatal: Authentication failed for 'https://github.com/example/private.git/'");
    return git.clone(origin, dir);
  } };
  const { raw } = manager(scripted([]), { git: stub, githubToken: async () => 'ghu_test_token' });
  const cloned = await raw.cloneRepository(ctx, project.id, target);
  assert.deepEqual(calls, [{ url: 'https://github.com/example/private', token: 'ghu_test_token' }, { url: 'https://github.com/example/private', token: null }]);
  assert.deepEqual([cloned.ok, cloned.top], [true, path.join(code, 'repos', 'private')]);

  const other = await ctx.libraryDb.insert({ id: randomUUID(), name: 'example/hidden', type: 'website', tags: ['git'], url: 'https://github.com/example/hidden' });
  theirs = false;
  await assert.rejects(raw.cloneRepository(ctx, project.id, { kind: 'library', id: other.id }),
    /example\/hidden could not be cloned: GitHub refused \(.*Authentication failed.*\)\. If it is private, Engelbart's GitHub App must be installed where it lives, with access to it\./);
  assert.equal((await ctx.libraryDb.get(other.id)).folder_path, null, 'nothing is kept of a refused clone');
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
  const named = project.name.toLowerCase().replace(/ /g, '-');
  assert.deepEqual(landed.target, { kind: 'default', name: named }, 'a post-it\'s Build works in the default repo, whatever the panel picked');
  assert.equal(fs.readFileSync(path.join(code, named, 'quick.txt'), 'utf8'), 'quick\n');
  assert.ok(!fs.existsSync(path.join(code, 'quick.txt')));
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
  assert.equal(task.target.kind, 'default', 'a post-it\'s Build: the default repo, though the project folder was asked for');
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

test('`@bart --build <request>`: a Build of only the request, with the notes it mentions, no workspace, no history, nothing archived (2026-10-02)', async () => {
  const { project, workspace } = await scene({ doc: 'Old plan.' });
  const ref = { kind: 'workspace', workspaceId: workspace.id };
  await archive.clearWorkspace(ctx, project.id, workspace.id, { keep: () => false });
  await projects.writeDoc(ctx, project.id, ref, 'The plan in front now.\n@bart --build implement @[Spec]');
  await projects.createNote(ctx, project.id, { name: 'Spec', text: 'Greet in French.' });
  const archivesBefore = projects.findWorkspace(ctx, project.id, workspace.id).workspace.archives.length;
  const recentBefore = JSON.stringify(projects.readNav(ctx).recent);
  const agent = scripted(['Done.']);
  const { builds } = manager(agent);
  const task = await builds.start(ctx, project.id, { kind: 'build', workspaceId: workspace.id, text: 'implement @[Spec]', fromLine: true });
  assert.deepEqual([task.kind, task.workspaceId, task.title], ['build', workspace.id, 'implement @[Spec]']);
  assert.equal(task.target.kind, 'default', 'the default repo, as a post-it\'s Build');
  assert.equal(task.version, null, 'not put in as an archived version');
  await settled(project, task.id);
  const context = agent.calls[0].message;
  assert.match(context, /<request>\nimplement @\[Spec\]\n\n<file name="Spec"[^>]*>\nGreet in French\.\n<\/file>\n<\/request>/, 'the request, with the note it mentions in full under it');
  assert.match(context, /built from: a request typed on a line of the workspace "Feature"/);
  assert.match(context, /Do what the request below asks\. The person typed it on a line of a workspace as a full Build/);
  for (const absent of [/<workspace /, /<history /, /<post-it>/, /The plan in front now/, /Old plan/]) assert.doesNotMatch(context, absent);
  const held = projects.findWorkspace(ctx, project.id, workspace.id).workspace;
  assert.equal(held.archives.length, archivesBefore, 'no new archived version');
  assert.ok(held.builds.includes(task.id));
  assert.equal(JSON.stringify(projects.readNav(ctx).recent), recentBefore, 'no edit recorded');
});

/* --------------------------------------------------------------------- the runner */

test('while Engelbart\'s own Git stands in, a Build\'s agent, setup and checks find it first on PATH (2026-09-28)', { skip: process.platform === 'win32' && 'macOS only: Engelbart\'s own Git ships for the Mac alone' }, async () => {
  const authFile = path.join(homeDir, 'auth-git.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const gitBin = '/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin';
  const tools = { binaryFor: () => null, environment: () => ({ ENGELBART_GIT_BIN: gitBin }) };
  const calls = [];
  const run = (shell, args, options, callback) => {
    calls.push({ command: args[args.length - 1], env: options.env });
    callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })}\n`, '');
    return null;
  };
  const environment = { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir };
  const worktree = path.join(homeDir, 'wt-git');
  fs.mkdirSync(worktree, { recursive: true });
  const policy = buildPolicy({ project: { dir: path.join(ctx.dataRoot, 'p') }, dataRoot: ctx.dataRoot });
  const runner = createRunner({ environment, runDirectory: path.join(homeDir, 'build-runs-git'), codexHome: path.join(homeDir, 'codex-home-git'), codexAuthFile: authFile, run, tools });
  await runner.turn({ task: { id: 'abcdef0124', provider: 'anthropic', modelId: 'opus', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy });
  assert.match(calls[0].command, /^PATH="\$ENGELBART_GIT_BIN:\$PATH"; exec claude -p /);
  assert.equal(calls[0].env.ENGELBART_GIT_BIN, gitBin);
  const shell = createShell({ environment, run, tools });
  await shell('npm test', worktree);
  assert.equal(calls[1].command, 'PATH="$ENGELBART_GIT_BIN:$PATH"; npm test');
  assert.deepEqual([calls[1].env.ENGELBART_GIT_BIN, calls[1].env.CI], [gitBin, '1']);
  await createShell({ environment, run })('npm test', worktree);
  assert.equal(calls[2].command, 'npm test', 'without the tool check (or with the person\'s own Git) the command is left as it is');
});

test('the real runner: command lines for both CLIs, the worktree as the working directory, no API key (CLIs stubbed)', async () => {
  const authFile = path.join(homeDir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  const calls = [];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    const read = (file) => (file ? fs.readFileSync(file, 'utf8') : null);
    calls.push({ command, cwd: options.cwd, env: options.env, input: read(options.env.ENGELBART_BUILD_INPUT), settings: read(options.env.ENGELBART_BUILD_SETTINGS), mcp: read(options.env.ENGELBART_BUILD_MCP) });
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
  // 2026-10-07: the person's settings, hooks and MCP servers (no --restricted, no --strict-mcp-config), subagents, no Chrome
  assert.match(calls[0].command, /^exec claude -p --output-format stream-json --verbose --include-partial-messages --session-id "\$ENGELBART_BUILD_SESSION" --setting-sources user,project,local --no-chrome --tools "Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch,Agent" --permission-mode auto --permission-prompts none --add-dir "\$ENGELBART_BUILD_DIR0" --add-dir "\$ENGELBART_BUILD_DIR1" --settings "\$ENGELBART_BUILD_SETTINGS" --model "\$ENGELBART_BUILD_MODEL" --effort high --append-system-prompt-file "\$ENGELBART_BUILD_PROMPT" < "\$ENGELBART_BUILD_INPUT"$/);
  assert.deepEqual([calls[0].env.ENGELBART_BUILD_DIR0, calls[0].env.ENGELBART_BUILD_DIR1], policy.folders);
  assert.equal(calls[0].mcp, null, 'no bridge, no engelbart server');
  assert.ok(!('GIT_CONFIG_PARAMETERS' in calls[0].env), 'no repository named, no git guard');
  assert.equal(calls[0].cwd, worktree);
  assert.equal(calls[0].input, 'do it');
  assert.ok(!('ANTHROPIC_API_KEY' in calls[0].env) && !('OPENAI_API_KEY' in calls[0].env));
  assert.ok(JSON.parse(calls[0].settings).permissions.deny.length > 0);
  await runner.turn({ task: { id: 'abcdef0123', provider: 'anthropic', modelId: 'opus', effort: 'high', worktree }, message: 'again', session: claude.session, system: 'SYSTEM', policy });
  assert.match(calls[1].command, /--resume "\$ENGELBART_BUILD_SESSION"/);
  assert.equal(calls[1].env.ENGELBART_BUILD_SESSION, claude.session);
  const codex = await runner.turn({ task: { id: 'abcdef0123', provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy });
  assert.deepEqual([codex.text, codex.session], ['codex did it', '01a0bc2d-7c18-77d2-8b21-3cc7e942cbcc']);
  assert.match(calls[2].command, /^exec codex exec --color never -m "\$ENGELBART_BUILD_MODEL" -c 'model_reasoning_effort="high"' -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' -c 'tools\.web_search=true' -c "\$ENGELBART_BUILD_C0" -c "\$ENGELBART_BUILD_C1" .* --json -o/);
  assert.equal(calls[2].env.CODEX_HOME, codexHome);
  const settings = Object.keys(calls[2].env).filter((key) => /^ENGELBART_BUILD_C\d+$/.test(key)).sort((a, b) => Number(a.slice(18)) - Number(b.slice(18))).map((key) => calls[2].env[key]);
  assert.deepEqual(settings, ['developer_instructions="SYSTEM"', 'features.multi_agent=true', `sandbox_workspace_write.writable_roots=${JSON.stringify([path.join(ctx.dataRoot, 'p')])}`, 'features.computer_use=false', 'features.browser_use=false', 'features.browser_use_external=false']);
  assert.ok(!fs.existsSync(path.join(codexHome, 'AGENTS.md')), 'Build\'s prompt is no longer an AGENTS.md: the home is the person\'s');
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

test('the real runner (2026-10-07): Engelbart\'s MCP server, the git guard first on PATH, Codex in the person\'s own home with their computer-use server off', async () => {
  const personal = path.join(homeDir, 'person-codex');
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x' } }));
  fs.writeFileSync(path.join(personal, 'config.toml'), 'model = "gpt-6-sol"\n\n[mcp_servers.computer-use]\ncommand = "/Applications/Codex.app/cu"\n');
  const calls = [];
  const run = (shell, args, options, callback) => {
    const command = args[args.length - 1];
    const read = (file) => (file ? fs.readFileSync(file, 'utf8') : null);
    const mcp = read(options.env.ENGELBART_BUILD_MCP);
    const settings = Object.keys(options.env).filter((key) => /^ENGELBART_BUILD_C\d+$/.test(key)).sort((a, b) => Number(a.slice(18)) - Number(b.slice(18))).map((key) => options.env[key]);
    const served = settings.find((value) => value.startsWith('mcp_servers.engelbart.args='));
    const connection = mcp ? read(JSON.parse(mcp).mcpServers.engelbart.args[1]) : served ? read(JSON.parse(served.slice(27))[1]) : null;
    calls.push({ command, env: options.env, mcp, settings, connection });
    if (/codex/.test(command)) { fs.writeFileSync(options.env.ENGELBART_BUILD_OUTPUT, 'codex did it'); callback(null, '{"type":"thread.started","thread_id":"01a0bc2d-7c18-77d2-8b21-3cc7e942cbce"}\n'); } else callback(null, `${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'claude did it' })}\n`);
    return null;
  };
  const runDirectory = path.join(homeDir, 'build-runs-reach');
  const runner = createRunner({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir, CODEX_HOME: personal }, runDirectory, run });
  const worktree = path.join(homeDir, 'wt-reach');
  fs.mkdirSync(worktree, { recursive: true });
  const policy = buildPolicy({ project: { dir: path.join(ctx.dataRoot, 'p') }, dataRoot: ctx.dataRoot, gitDir: '/repo/.git' });
  const engelbart = { url: 'http://127.0.0.1:1/tools', token: 'a'.repeat(64) };
  await runner.turn({ task: { id: 'abcdef0125', provider: 'anthropic', modelId: 'opus', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy, engelbart });
  // Windows (docs/windows-port-log.md "Catch-up to 0.1.13"): Git for Windows' bash, whose PATH is written the POSIX way
  const windows = process.platform === 'win32';
  const guardFirst = windows ? 'PATH="\\$\\(cygpath -u "\\$ENGELBART_BUILD_GUARD"\\):\\$PATH"; ' : 'PATH="\\$ENGELBART_BUILD_GUARD:\\$PATH"; ';
  assert.match(calls[0].command, new RegExp(`^${guardFirst}exec claude -p .* --setting-sources user,project,local --mcp-config "\\$ENGELBART_BUILD_MCP" --no-chrome --tools `));
  const server = JSON.parse(calls[0].mcp).mcpServers.engelbart;
  assert.deepEqual([server.command, server.args[0], server.env], [process.execPath, path.join(__dirname, '..', 'src', 'main', 'build', 'engelbart-mcp.cjs'), { ELECTRON_RUN_AS_NODE: '1' }]);
  assert.deepEqual(JSON.parse(calls[0].connection), engelbart, 'the bridge reaches the server through a file of its own');
  assert.equal(calls[0].env.ENGELBART_BUILD_GUARD, path.join(runDirectory, 'git-guard', 'bin'));
  assert.ok(windows || fs.statSync(path.join(calls[0].env.ENGELBART_BUILD_GUARD, 'git')).mode & 0o100, 'executable (Windows has no execute bit: bash reads the #! line)');
  assert.equal(calls[0].env.ENGELBART_BUILD_GIT_DIR, '/repo/.git');
  if (windows) assert.match(calls[0].env.GIT_CONFIG_PARAMETERS, /^'includeIf\.gitdir\/i:\/repo\/\.git\.path'='[^']+build\.gitconfig' 'includeIf\.gitdir\/i:\/repo\/\.git\/\*\*\.path'=/);
  else assert.match(calls[0].env.GIT_CONFIG_PARAMETERS, /^'includeIf\.gitdir:\/repo\/\.git\.path'='[^']+build\.gitconfig' 'includeIf\.gitdir:\/repo\/\.git\/\*\*\.path'=/);
  const codex = await runner.turn({ task: { id: 'abcdef0125', provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', worktree }, message: 'do it', system: 'SYSTEM', policy, engelbart });
  assert.equal(codex.text, 'codex did it');
  assert.match(calls[1].command, new RegExp(`^${guardFirst}exec codex exec --color never `));
  assert.equal(calls[1].env.CODEX_HOME, personal, 'the person\'s own Codex home: their config, hooks, rules and MCP servers');
  assert.ok(!fs.existsSync(path.join(personal, 'AGENTS.md')), 'and their AGENTS.md is never written');
  for (const value of ['developer_instructions="SYSTEM"', 'features.multi_agent=true', 'features.computer_use=false', 'features.browser_use=false', 'mcp_servers.computer-use.enabled=false', `mcp_servers.engelbart.command=${JSON.stringify(process.execPath)}`, 'mcp_servers.engelbart.env={ ELECTRON_RUN_AS_NODE = "1" }']) assert.ok(calls[1].settings.includes(value), value);
  assert.deepEqual(JSON.parse(calls[1].connection), engelbart);
  assert.equal(calls[1].env.ENGELBART_BUILD_GIT_DIR, '/repo/.git');
  assert.deepEqual(fs.readdirSync(runDirectory), ['git-guard'], 'nothing of a turn stays on disk but the guard');
  fs.writeFileSync(path.join(personal, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-never' }));
  await assert.rejects(runner.turn({ task: { id: 'abcdef0125', provider: 'openai', modelId: 'gpt-6-sol', effort: 'high', worktree }, message: 'x', system: 'SYSTEM', policy }), (error) => error.kind === 'unavailable' && /ChatGPT/.test(error.message));
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
  const slugged = await projects.createProject(ctx, 'worktrees');
  assert.equal(slugged.slug, 'worktrees-project');
});

test('a check runs without Engelbart\'s terminal, and what failed keeps its name when the output is cut (2026-09-29)', async () => {
  const seen = [];
  const long = ['TAP version 13', 'ok 1 - first', 'not ok 2 - the shell reads its input', 'ok 3 - third', '# Subtest: second', 'not ok 4 - second', `  output: ${'x'.repeat(6000)}`, 'ok 5 - last', '# fail 2'].join('\n');
  const run = (shell, args, options, callback) => { seen.push(options); callback(Object.assign(new Error('failed'), { code: 1 }), long, ''); return null; };
  const ran = await createShell({ environment: { PATH: '/usr/bin', SHELL: '/bin/zsh', HOME: homeDir }, run })('npm test', homeDir);
  assert.equal(seen[0].detached, true, 'a session of its own: an interactive zsh in the tests never reads the terminal Engelbart was started from');
  assert.equal(ran.ok, false);
  assert.match(ran.output, /^What failed, before what is shown below:\nnot ok 2 - the shell reads its input\nnot ok 4 - second\n\n…/);
  assert.match(ran.output, /ok 5 - last\n# fail 2$/);
  assert.ok(ran.output.length < 4200);
  assert.equal(checkOutput('ok 1\nnot ok 2 - short'), 'ok 1\nnot ok 2 - short', 'what fits is kept as it is');
  assert.match(checkOutput(`✖ spec: fails\n${'y'.repeat(5000)}`), /^What failed[^\n]*\n✖ spec: fails\n/, "node's spec reporter too");
});
