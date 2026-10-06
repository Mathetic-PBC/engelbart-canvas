'use strict';

// A Build's run step (src/main/build/run-step.cjs and its parts): the launch facts of a folder on this Mac, the tools and
// the paths they may reach, Engelbart's own processes and checks, and the step itself inside the Build's lifecycle — after
// a turn that ends in review only, never for a quick task; the stored commands first (the agent only when something is
// left to find); what passes keeps running unseen until it is opened, its commands (a UI's with {port}) on the Build's
// record until Accept writes them; a runnable out of time is failed; what it changed is a checkpoint Review shows apart;
// what it started is stopped before the next run step and on Discard, and after Accept when its last runnable is stopped,
// Engelbart quits, or (a crash) starts. The agent is scripted: it calls the tools through the real loopback bridge, as
// the MCP adapter would. For now (2026-09-29) the run step runs web interfaces only (RUN_KINDS); the tests of desktop apps
// and terminal programs give it every kind (ALL_KINDS), as the code for them stays.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const db = require('../src/main/store/db.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const projects = require('../src/main/store/projects.cjs');
const { createGit } = require('../src/main/build/git.cjs');
const { createBuilds } = require('../src/main/build/manager.cjs');
const store = require('../src/main/build/store.cjs');
const { normalizeModels } = require('../src/main/bart/models.cjs');
const { discoverLocal } = require('../src/main/sandbox/launch-discovery.cjs');
const { claudeArguments, runLocalClaude } = require('../src/main/sandbox/local-claude.cjs');
const { RUN_TOOLS, RUN_KINDS, ALL_KINDS, worktreePath, validateRunTool, createRunTools } = require('../src/main/build/run-tools.cjs');
const { createProcesses, freePort, stopLeftover } = require('../src/main/build/run-processes.cjs');
const { createRunStep, createFakeRunAgent, prompt: runPrompt } = require('../src/main/build/run-step.cjs');
const { runnableStore } = require('../src/main/build/runnables.cjs');

const homeDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'engelbart-run-step-'));
const layout = ensureHome(homeDir);
const environment = { PATH: process.env.PATH, HOME: homeDir, SHELL: '/bin/zsh', XDG_CONFIG_HOME: path.join(homeDir, '.config') };
const git = createGit({ environment });
const sh = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Person', '-c', 'user.email=p@example.com', ...args], { cwd, env: environment, encoding: 'utf8' }).trim();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MODELS = normalizeModels(null);
let ctx;

test.before(async () => {
  ctx = { homeDir, root: layout.root, dataRoot: layout.testRoot, libraryDb: await db.openLibraryDb(layout.testRoot) };
});
// Every process group a test started is stopped when the file ends, also after a test that failed partway.
const started = [];
const processesOf = (options) => { const processes = createProcesses(options); started.push(processes); return processes; };
test.after(async () => { await Promise.all(started.map((processes) => processes.stopAll().catch(() => {}))); await db.closeAll(); });

const answers = async (url) => { try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.status < 500; } catch { return false; } };

// A small app: a web UI that takes its port from PORT, and a terminal program.
const APP = {
  'package.json': JSON.stringify({ name: 'demo', scripts: { start: 'node server.cjs' }, bin: 'cli.cjs' }, null, 2),
  'server.cjs': "require('node:http').createServer((q, r) => r.end('hello from the build')).listen(Number(process.env.PORT), 'localhost');\n",
  'cli.cjs': "console.log(process.argv.includes('--help') ? 'usage: demo' : 'ran'); process.exit(0);\n",
};
function repository(name, files = APP) {
  const dir = path.join(homeDir, `${name}-${randomUUID().slice(0, 6)}`);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  for (const [file, text] of Object.entries(files)) write(path.join(dir, file), text);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-qm', 'init');
  return dir;
}

/** An agent that calls the tools through the bridge; `script(use, input)` is what it does. */
function bridgeAgent(script) {
  const seen = [];
  const run = async (input) => {
    seen.push(input);
    const use = async (name, args) => {
      const response = await fetch(input.bridge.url, { method: 'POST', headers: { authorization: `Bearer ${input.bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, args }) });
      const out = await response.json();
      if (out.isError) throw new Error(out.content[0].text);
      return JSON.parse(out.content[0].text);
    };
    return script(use, input);
  };
  run.seen = seen;
  return run;
}

function terminals() {
  const opened = [];
  const closed = [];
  return {
    opened, closed,
    openTerminal: ({ cwd, command }) => { const session = { id: `term-${opened.length + 1}`, cwd, command, status: 'running' }; opened.push(session); return session; },
    closeTerminal: async (id) => { closed.push(id); const session = opened.find((entry) => entry.id === id); if (session) session.status = 'exited'; },
    terminalSnapshot: (id) => opened.find((session) => session.id === id && session.status === 'running') || null,
  };
}

/* ------------------------------------------------------------------- launch facts */

test('launch facts on this Mac: manifests, scripts and what kind of runnable each folder looks like; bounded, never through a link', () => {
  const root = fs.mkdtempSync(path.join(homeDir, 'facts-'));
  write(path.join(root, 'package.json'), JSON.stringify({ name: 'mono', workspaces: ['apps/*'], scripts: { dev: 'turbo dev', test: 'x' } }));
  write(path.join(root, 'apps', 'web', 'package.json'), JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '5' } }));
  write(path.join(root, 'apps', 'web', 'vite.config.js'), '');
  write(path.join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({ main: 'main.js', scripts: { start: 'electron .' }, devDependencies: { electron: '30' } }));
  write(path.join(root, 'tools', 'cli', 'package.json'), JSON.stringify({ name: 'mycli', bin: { mycli: 'index.js' } }));
  write(path.join(root, 'api', 'requirements.txt'), 'flask\n');
  write(path.join(root, 'api', 'app.py'), '');
  write(path.join(root, 'node_modules', 'x', 'package.json'), '{}');
  const outside = fs.mkdtempSync(path.join(homeDir, 'outside-'));
  write(path.join(outside, 'package.json'), '{}');
  fs.symlinkSync(outside, path.join(root, 'linked'));
  const facts = discoverLocal(root);
  const by = Object.fromEntries(facts.components.map((item) => [item.cwd, item]));
  assert.deepEqual(Object.keys(by).sort(), ['.', 'api', 'apps/desktop', 'apps/web', 'tools/cli']);
  assert.deepEqual(by['apps/web'].hints, { web: ['vite'] });
  assert.equal(by['apps/web'].workspace_root, '.');
  assert.deepEqual(by['apps/web'].scripts, { dev: 'vite', build: 'vite build' });
  assert.deepEqual(by['apps/desktop'].hints, { desktop: ['electron'], main: 'main.js' });
  assert.deepEqual(by['tools/cli'].hints, { bin: ['mycli'] });
  assert.ok(!('workspace_root' in by['tools/cli']));
  assert.deepEqual(by.api.evidence, ['api/app.py']);
  assert.ok(!('test' in by['.'].scripts), 'only the launch scripts');
  assert.ok(Buffer.byteLength(JSON.stringify(facts)) <= 11900);
  for (let n = 0; n < 12; n += 1) write(path.join(root, 'many', `p${n}`, 'package.json'), '{}');
  const capped = discoverLocal(root);
  assert.equal(capped.components.length, 8);
  assert.equal(capped.scan_truncated, true);
  assert.deepEqual(discoverLocal('relative/path').components, []);
});

/* ------------------------------------------------------------------------- tools */

test('the tools reach the worktree only: not above it, not through a link, not .git', () => {
  const root = repository('paths');
  const outside = fs.mkdtempSync(path.join(homeDir, 'outside-'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(outside, 'missing'), path.join(root, 'dangling'));
  assert.equal(worktreePath(root, 'src/new.js'), path.join(fs.realpathSync(root), 'src', 'new.js'));
  assert.equal(worktreePath(root), fs.realpathSync(root));
  for (const bad of ['..', '../x', '/etc/passwd', 'escape/file', 'dangling', 'a/../../b', '.git/config', 'x\0y']) assert.throws(() => worktreePath(root, bad), /inside the repository|\.git|Invalid/, bad);
  assert.ok(RUN_TOOLS.every((tool) => tool.inputSchema.additionalProperties === false));
  assert.throws(() => validateRunTool('start_runnable', { name: 'web' }), /Invalid tool arguments/);
  assert.throws(() => validateRunTool('declare_runnables', { runnables: [{ name: 'x', folder: '.', type: 'server' }] }, ALL_KINDS), /Invalid runnable type server: ui, app, terminal/);
  assert.throws(() => validateRunTool('run_command', { command: 'ls', extra: 1 }), /Invalid tool arguments/);
  assert.throws(() => validateRunTool('rm_rf', {}), /Unknown/);
});

test('run_command runs to its end in the worktree and refuses launches, the background and kill; files are read and written there', async () => {
  const root = repository('commands');
  const processes = processesOf({ environment });
  const handlers = { declare: async () => ({}), start: async () => ({}), status: async () => ({}) };
  const call = createRunTools({ root, runnables: handlers, processes, key: 'test' });
  // Windows: Git Bash's pwd is its own (/tmp/…), so node says where it is, read back as Windows has it (no 8.3 names).
  const [here, real] = process.platform === 'win32' ? ['node -p "process.cwd()"', fs.realpathSync.native] : ['pwd', fs.realpathSync];
  const ran = await call('run_command', { command: `${here} && echo made > made.txt`, cwd: '.' });
  assert.equal(ran.exit_code, 0);
  const printed = ran.output.trim().split('\n').pop();
  assert.equal(process.platform === 'win32' ? real(printed.trim()) : printed, real(root));
  assert.equal(fs.readFileSync(path.join(root, 'made.txt'), 'utf8'), 'made\n');
  assert.equal((await call('run_command', { command: 'exit 3' })).exit_code, 3);
  const slow = await call('run_command', { command: 'sleep 5', timeout_seconds: 1 });
  assert.equal(slow.timed_out, true);
  for (const refused of ['npm run dev', 'npm start', 'yarn dev', 'kill 1', 'pkill node', 'node server.cjs &', 'nohup node x', 'sudo ls', 'vite', 'open -a Calculator', 'npx electron .']) {
    await assert.rejects(call('run_command', { command: refused }), /start_runnable/, refused);
  }
  assert.equal((await call('run_command', { command: 'echo vite build ok' })).exit_code, 0);
  await call('write_file', { path: 'src/fix.js', content: 'fixed\n' });
  assert.deepEqual(await call('read_file', { path: 'src/fix.js' }), { content: 'fixed\n', truncated: false });
  assert.ok((await call('list_files', {})).entries.includes('src/'));
  await assert.rejects(call('write_file', { path: '../out.txt', content: 'x' }), /inside the repository/);
  await assert.rejects(call('run_command', { command: 'ls', cwd: '..' }), /inside the repository/);
  await call.close();
  await assert.rejects(call('list_files', {}), /closed/);
});

/* ------------------------------------------------------------------ processes */

test('Engelbart\'s processes: a UI answers on its port, an app is alive after its wait, a terminal program exits 0; stopping stops the whole group', async () => {
  const root = repository('processes');
  // How long an app must stay up, and a quick program is seen to exit within: Git Bash's login shell can take longer
  // than 0.4 s to start on Windows (CI, 2026-10-05), so there it is 5 s.
  const aliveMs = process.platform === 'win32' ? 5000 : 400;
  const processes = processesOf({ environment, appAliveMs: aliveMs, uiReadyMs: 8000 });
  const port = await freePort();
  await processes.start('web', `PORT=${port} node server.cjs`, root);
  const web = await processes.check('web', 'ui', { port });
  assert.deepEqual([web.ok, web.url], [true, `http://localhost:${port}/`]);
  const pid = processes.status('web').pid;
  assert.equal(await processes.stop('web'), true);
  assert.equal(await answers(`http://localhost:${port}/`), false, 'nothing answers after stop');
  assert.throws(() => process.kill(-pid, 0), 'the group is gone');

  await processes.start('dead', 'node -e "console.error(\'boom\'); process.exit(2)"', root);
  const dead = await processes.check('dead', 'ui', { port: await freePort() });
  assert.equal(dead.ok, false);
  assert.match(dead.failed_check, /exited \(exit code 2\) before it answered/);
  assert.match(dead.output, /boom/);

  await processes.start('app', 'sleep 30', root);
  assert.equal((await processes.check('app', 'app')).ok, true);
  await processes.stop('app');
  await processes.start('quick', 'echo bye', root);
  const quick = await processes.check('quick', 'app');
  assert.match(quick.failed_check, new RegExp(`exited within ${aliveMs / 1000} seconds \\(exit code 0\\)`));

  assert.deepEqual((await processes.runToExit('cli', 'node cli.cjs --help', root)).code, 0);
  assert.notEqual((await processes.runToExit('cli', 'node missing.cjs', root)).code, 0);
  await processes.stopAll();
});

/* --------------------------------------------------------------- the local agent */

test('the agent runs as the sandbox setup runs it: restricted, Engelbart\'s tools only, the Build\'s model and effort, its own adapter', async () => {
  const args = claudeArguments('/private/mcp.json', 'opus', { maxTurns: 250, effort: 'high' });
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 6), ['--model', 'opus', '--effort', 'high', '--max-turns', '250']);
  for (const flag of ['--restricted', '--strict-mcp-config', '--no-session-persistence']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__canvas__*');
  assert.throws(() => claudeArguments('c', 'opus', { effort: 'high; rm' }), /effort/);
  assert.throws(() => claudeArguments('c', 'opus', { maxTurns: 0 }), /turn limit/);
  let config = null;
  const { EventEmitter } = require('node:events');
  const spawnProcess = (file, argv) => {
    config = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8'));
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stderr.resume = () => {};
    child.stdin = { on() {}, end() {
      setImmediate(() => {
        child.stdout.emit('data', `${JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [{ name: 'canvas', status: 'connected' }] })}\n${JSON.stringify({ type: 'result', subtype: 'success', result: 'All running.' })}\n`);
        child.emit('close', 0);
      });
    } };
    return child;
  };
  const server = path.join(__dirname, '..', 'src', 'main', 'build', 'run-mcp.cjs');
  const text = await runLocalClaude({ auth: { file: '/bin/claude', env: {} }, bridge: { url: 'http://127.0.0.1:1/tools', token: '0'.repeat(64) }, prompt: 'x', model: 'opus', server, spawnProcess });
  assert.equal(text, 'All running.');
  assert.equal(config.mcpServers.canvas.args[0], server);
});

/* ------------------------------------------------------------ inside the Build */

let n = 0;
/** A project, a workspace, and a library repository with the small app, the project's. */
async function scene(files = APP) {
  n += 1;
  const code = repository(`project-${n}`, { 'README.md': 'x\n' });
  const project = await projects.createProject(ctx, { name: `Run ${n}`, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Build the app.');
  const repo = repository(`app-${n}`, files);
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: `app-${n}`, type: 'folder', tags: ['git'], folder_path: repo, project_id: project.id });
  return { code, project, workspace, repo, row, target: { kind: 'library', id: row.id } };
}

function scripted(steps) {
  const calls = [];
  return {
    calls,
    async turn(input) {
      calls.push(input);
      const step = steps.shift();
      if (!step) throw Object.assign(new Error('no more steps'), { kind: 'failed' });
      const out = typeof step === 'function' ? await step(input) : step;
      return { text: out, session: input.session || `session-${calls.length}` };
    },
  };
}

function manager(runner, runAgent, extra = {}) {
  const events = [];
  const shown = terminals();
  const processes = processesOf({ environment, appAliveMs: 400, uiReadyMs: 8000 });
  const runStep = createRunStep({ processes, runAgent, prepareClaude: async () => ({ file: 'claude', env: {} }), tickMs: 100, kinds: ALL_KINDS, ...shown, ...extra });
  const builds = createBuilds({ git, runner, readModels: () => MODELS, notify: (channel, payload) => events.push({ channel, payload }), runShell: async () => ({ ok: true, output: '' }), runStep });
  return { builds, events, shown, processes, runStep };
}

async function stepped(builds, project, id, turn) {
  for (let i = 0; i < 600; i += 1) {
    const task = store.readTask(projects.findProject(ctx, project.id), id);
    if (task && task.runStep && task.runStep.turn === turn && task.runStep.status !== 'running' && !builds.stepping(id)) return task;
    await pause(25);
  }
  throw new Error('the run step never finished');
}
async function settled(project, id) {
  for (let i = 0; i < 600; i += 1) {
    const task = store.readTask(projects.findProject(ctx, project.id), id);
    if (task && !['setting-up', 'queued', 'running', 'accepting'].includes(task.status)) return task;
    await pause(25);
  }
  throw new Error('the Build never settled');
}

test('after a turn ends in review: the runnables named, started and checked, their commands kept ({port}, never a port); nothing shown until it is opened', async () => {
  const { project, workspace, target, row } = await scene();
  const agent = bridgeAgent(async (use) => {
    await assert.rejects(use('start_runnable', { name: 'web', run_command: 'PORT={port} npm start' }), /not declared/);
    await assert.rejects(use('declare_runnables', { runnables: [{ name: 'web', folder: '../elsewhere', type: 'ui' }] }), /folder must be inside/);
    const declared = await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }, { name: 'cli', folder: '.', type: 'terminal' }] });
    assert.deepEqual(declared.runnables.map((item) => [item.name, item.status, item.stored]), [['web', 'waiting', null], ['cli', 'waiting', null]]);
    await assert.rejects(use('start_runnable', { name: 'web', run_command: 'npm start' }), /must hold \{port\}/);
    const failed = await use('start_runnable', { name: 'web', run_command: 'node nowhere.cjs {port}' });
    assert.equal(failed.ok, false);
    assert.match(failed.output, /Cannot find module/);
    const web = await use('start_runnable', { name: 'web', run_command: 'PORT={port} npm start' });
    assert.equal(web.ok, true);
    assert.match(web.url, /^http:\/\/localhost:\d+\/$/);
    const again = await use('start_runnable', { name: 'web', run_command: 'PORT={port} npm start' });
    assert.deepEqual([again.ok, again.url], [true, web.url], 'started again: nothing is started, it runs where it ran');
    assert.match(again.message, /already passed/);
    assert.equal((await use('start_runnable', { name: 'cli', run_command: 'node cli.cjs --help' })).ok, true);
    const status = await use('runnable_status', {});
    assert.deepEqual(status.runnables.map((item) => [item.name, item.status]), [['web', 'running'], ['cli', 'running']]);
    return 'web and cli run.';
  });
  const { builds, events, shown } = manager(scripted(['Built it.']), agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target, provider: 'anthropic', model: 'opus', effort: 'max' });
  const task = await stepped(builds, project, started.id, 1);
  assert.equal(task.status, 'review', 'the Build stays in review');
  assert.equal(task.runStep.status, 'done');
  const web = task.runStep.runnables.find((item) => item.name === 'web');
  assert.equal(web.status, 'running');
  assert.equal(await answers(web.url), true, 'it runs');
  assert.deepEqual([agent.seen[0].model, agent.seen[0].effort, path.basename(agent.seen[0].server)], ['opus', 'max', 'run-mcp.cjs'], 'the Build\'s own model and effort');
  assert.match(agent.seen[0].prompt, /"cwd":"\."/, 'the launch facts are in the prompt');
  assert.deepEqual(await runnableStore(ctx.libraryDb).list(row.id), [], 'nothing is written to the repository\'s rows while it runs');
  const run = () => events.filter((event) => event.channel === 'engelbart:build-run').map((event) => event.payload);
  assert.deepEqual([run(), shown.opened], [[], []], 'nothing is shown when it passes: it runs in the background until Review');
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.passed, item.install_command, item.run_command]), [['web', true, null, 'PORT={port} npm start'], ['cli', true, null, 'node cli.cjs --help']], 'the commands that passed, on the record');
  assert.match(task.messages[task.messages.length - 1].text, /^Run step: web \(web UI\) runs at http:\/\/localhost:\d+\/; cli \(terminal\) runs\.$/);
  assert.ok(!task.checkpoints.some((checkpoint) => checkpoint.step === 'run'), 'nothing changed, so no run step checkpoint');
  // Opened (from Review): a UI in the Stage, a terminal program in a terminal of its own, opened then, and the same one again.
  await builds.showRunnable(ctx, project.id, task.id, 'web');
  assert.deepEqual(run().map((event) => [event.kind, event.name, event.url]), [['ui', 'web', web.url]]);
  await builds.showRunnable(ctx, project.id, task.id, 'cli');
  assert.deepEqual(shown.opened.map((session) => [session.command, session.cwd]), [['node cli.cjs --help', fs.realpathSync(task.cwd)]], 'the terminal program runs in a terminal of its own');
  assert.deepEqual(run().slice(1).map((event) => [event.kind, event.name, event.session.id]), [['terminal', 'cli', 'term-1']]);
  await builds.showRunnable(ctx, project.id, task.id, 'cli');
  assert.equal(shown.opened.length, 1, 'its terminal again, not another');
  assert.equal(store.readTask(projects.findProject(ctx, project.id), task.id).runStep.runnables.find((item) => item.name === 'cli').sessionId, 'term-1');
  await assert.rejects(builds.showRunnable(ctx, project.id, task.id, 'nothing'), /not running/);
  await builds.discard(ctx, project.id, task.id);
  assert.equal(await answers(web.url), false, 'Discard stops it');
  assert.deepEqual(shown.closed, ['term-1']);
  const gone = store.readTask(projects.findProject(ctx, project.id), task.id);
  assert.ok(gone.runStep.runnables.every((item) => item.status === 'stopped'));
  assert.deepEqual(await runnableStore(ctx.libraryDb).list(row.id), [], 'Discard writes nothing');
});

test('what the run step changes is its own checkpoint, apart in Review; the next run step stops what the last one started; Accept keeps what passed, and the next Build tries it first', async () => {
  const { project, workspace, target, repo, row } = await scene({ ...APP, 'server.cjs': "require('node:http').createServer((q, r) => r.end('hi')).listen(4999, 'localhost');\n" });
  const agent = bridgeAgent(async (use, input) => {
    assert.match(input.prompt, /Nothing has been verified here before/, 'nothing is kept before an Accept');
    // A fixed port: the one change it takes, made by the run step.
    await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }] });
    await use('write_file', { path: 'server.cjs', content: "require('node:http').createServer((q, r) => r.end('hi')).listen(Number(process.env.PORT), 'localhost');\n" });
    assert.equal((await use('start_runnable', { name: 'web', run_command: 'PORT={port} node server.cjs' })).ok, true);
    return 'web runs; server.cjs now reads PORT.';
  });
  const build = scripted([
    ({ task }) => { write(path.join(task.worktree, 'feature.js'), 'one\n'); return 'Added feature.js.'; },
    ({ task }) => { write(path.join(task.worktree, 'feature.js'), 'two\n'); return 'Changed feature.js.'; },
    ({ task }) => { write(path.join(task.worktree, 'more.js'), 'more\n'); return 'Added more.js.'; },
  ]);
  const { builds } = manager(build, agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  let task = await stepped(builds, project, started.id, 1);
  const first = task.runStep.runnables[0].url;
  assert.equal(await answers(first), true);
  assert.deepEqual(task.checkpoints.map((checkpoint) => checkpoint.step || 'turn'), ['turn', 'run']);
  let review = await builds.review(ctx, project.id, task.id);
  assert.deepEqual(review.files.map((file) => file.path), ['feature.js'], 'the Build\'s own work');
  assert.deepEqual([review.runStep.apart, review.runStep.files.map((file) => file.path)], [true, ['server.cjs']], 'the run step\'s, apart');
  assert.match(review.runStep.patch, /\+require\('node:http'\).*process\.env\.PORT/);

  await builds.reply(ctx, project.id, task.id, 'Change it.');
  task = await stepped(builds, project, task.id, 2);
  assert.equal(await answers(first), false, 'the last run step\'s processes were stopped first');
  assert.equal(agent.seen.length, 2, 'nothing is kept until Accept: the agent finds it again');
  assert.deepEqual(await runnableStore(ctx.libraryDb).list(row.id), []);
  const now = task.runStep.runnables[0].url;
  assert.equal(await answers(now), true);
  review = await builds.review(ctx, project.id, task.id);
  assert.deepEqual([review.files.map((file) => file.path), review.runStep.files.map((file) => file.path)], [['feature.js'], ['server.cjs']]);

  await builds.accept(ctx, project.id, task.id);
  const accepted = store.readTask(projects.findProject(ctx, project.id), task.id).accepted;
  assert.equal(await answers(now), true, 'Accept keeps it running, on what landed');
  assert.match(fs.readFileSync(path.join(repo, 'server.cjs'), 'utf8'), /process\.env\.PORT/, 'the run step\'s change lands with the Build');
  assert.equal(fs.readFileSync(path.join(repo, 'feature.js'), 'utf8'), 'two\n');
  const kept = await runnableStore(ctx.libraryDb).list(row.id);
  assert.deepEqual(kept.map((item) => [item.name, item.type, item.status, item.install_command, item.run_command, item.verified_commit]), [['web', 'ui', 'verified', null, 'PORT={port} node server.cjs', accepted.sha]], 'Accept keeps what passed, at the commit that landed');

  // The next Build of the repository: what the accepted one kept is tried first, and it is all it takes.
  const next = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const again = await stepped(builds, project, next.id, 1);
  assert.equal(agent.seen.length, 2, 'the stored commands passed: no agent');
  assert.deepEqual(again.runStep.runnables.map((item) => [item.name, item.status, item.passed]), [['web', 'running', true]]);
  assert.match(again.messages[again.messages.length - 1].text, /^Run step: web \(web UI\) runs at http:\/\/localhost:\d+\/\.$/);
  await builds.discard(ctx, project.id, next.id);
  assert.deepEqual((await runnableStore(ctx.libraryDb).list(row.id)).map((item) => item.verified_commit), [accepted.sha], 'Discard writes nothing');
  await builds.stopRunnable(ctx, project.id, task.id, null);
  assert.equal(await answers(now), false);
});

test('a stored command that no longer works: the agent is told, what already passed stays running, and what works instead is kept on Accept', async () => {
  const { project, workspace, target, row } = await scene();
  const runnables = runnableStore(ctx.libraryDb);
  for (const [name, type, command] of [['web', 'ui', 'PORT={port} node server.cjs'], ['cli', 'terminal', 'node cli.cjs --help']]) {
    const declared = await runnables.declare(row.id, { folder: '.', name, type });
    await runnables.verify(declared.id, { install_command: null, run_command: command, commit: null });
  }
  const agent = bridgeAgent(async (use, input) => {
    assert.match(input.prompt, /"name":"cli","folder":"\.","type":"terminal","passed":false/, 'told which stored command failed, and how');
    assert.match(input.prompt, /Failed on them: cli\./);
    const declared = await use('declare_runnables', { runnables: [{ name: 'cli', folder: '.', type: 'terminal' }] });
    assert.deepEqual(declared.runnables.map((item) => [item.name, item.status, item.stored.run_command]), [['cli', 'waiting', 'node cli.cjs --help'], ['web', 'running', 'PORT={port} node server.cjs']]);
    assert.equal((await use('start_runnable', { name: 'cli', run_command: 'node tool.cjs --help' })).ok, true);
    return 'cli is tool.cjs now.';
  });
  const build = scripted([({ task }) => { fs.renameSync(path.join(task.worktree, 'cli.cjs'), path.join(task.worktree, 'tool.cjs')); return 'Renamed the CLI.'; }]);
  const { builds } = manager(build, agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const task = await stepped(builds, project, started.id, 1);
  assert.equal(agent.seen.length, 1, 'a stored command failed: the agent explores');
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.status, item.run_command]), [['cli', 'running', 'node tool.cjs --help'], ['web', 'running', 'PORT={port} node server.cjs']]);
  const rowsOf = async () => (await runnables.list(row.id)).map((item) => [item.name, item.status, item.run_command, item.verified_commit]);
  assert.deepEqual(await rowsOf(), [['cli', 'verified', 'node cli.cjs --help', null], ['web', 'verified', 'PORT={port} node server.cjs', null]], 'unchanged until Accept');
  await builds.accept(ctx, project.id, task.id);
  const { sha } = store.readTask(projects.findProject(ctx, project.id), task.id).accepted;
  assert.deepEqual(await rowsOf(), [['cli', 'verified', 'node tool.cjs --help', sha], ['web', 'verified', 'PORT={port} node server.cjs', sha]], 'what works instead replaces it');
  await builds.stopRunnable(ctx, project.id, task.id, null);
});

test('every stored command passes, but the launch facts name a folder no row covers: the agent is told what runs, and declares and starts only what is new', async () => {
  const { project, workspace, target, row } = await scene();
  const runnables = runnableStore(ctx.libraryDb);
  const stored = await runnables.declare(row.id, { folder: '.', name: 'web', type: 'ui' });
  await runnables.verify(stored.id, { install_command: null, run_command: 'PORT={port} node server.cjs', commit: null });
  const agent = bridgeAgent(async (use, input) => {
    assert.match(input.prompt, /Already running on them, and they stay running: web\./);
    assert.match(input.prompt, /Folders no stored runnable covers[^\n]*\["admin"\]/);
    const declared = await use('declare_runnables', { runnables: [{ name: 'admin', folder: 'admin', type: 'ui' }] });
    assert.deepEqual(declared.runnables.map((item) => [item.name, item.status]), [['admin', 'waiting'], ['web', 'running']], 'what runs stays, though not declared again');
    assert.equal((await use('start_runnable', { name: 'admin', run_command: 'PORT={port} node admin.cjs' })).ok, true);
    return 'admin runs too.';
  });
  const build = scripted([({ task }) => {
    write(path.join(task.worktree, 'admin', 'package.json'), JSON.stringify({ name: 'admin', scripts: { start: 'node admin.cjs' } }));
    write(path.join(task.worktree, 'admin', 'admin.cjs'), "require('node:http').createServer((q, r) => r.end('admin')).listen(Number(process.env.PORT), 'localhost');\n");
    return 'Added an admin UI.';
  }]);
  const { builds } = manager(build, agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const task = await stepped(builds, project, started.id, 1);
  assert.equal(agent.seen.length, 1, 'a folder no row covers: the agent looks');
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.status]), [['admin', 'running'], ['web', 'running']]);
  for (const item of task.runStep.runnables) assert.equal(await answers(item.url), true, `${item.name} answers`);
  await builds.discard(ctx, project.id, task.id);
});

test('a desktop app opened from Review: its window is brought forward, found among the processes of its group', { skip: process.platform === 'win32' && 'macOS only: a desktop app\'s window is brought forward with AppKit, found with ps' }, async () => {
  const { project, workspace, target } = await scene();
  const agent = bridgeAgent(async (use) => {
    await use('declare_runnables', { runnables: [{ name: 'desk', folder: '.', type: 'app' }] });
    assert.equal((await use('start_runnable', { name: 'desk', run_command: 'node -e "setInterval(() => {}, 1000)"' })).ok, true);
    return 'desk runs.';
  });
  const asked = [];
  let answer = true;
  const { builds } = manager(scripted(['Built it.']), agent, { focusWindow: async (pids) => { asked.push(pids); return answer; } });
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const task = await stepped(builds, project, started.id, 1);
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.type, item.status]), [['desk', 'app', 'running']]);
  assert.equal(await builds.showRunnable(ctx, project.id, task.id, 'desk'), true);
  assert.equal(asked.length, 1);
  assert.ok(asked[0].length >= 1 && asked[0].every(Number.isInteger));
  const commands = execFileSync('/bin/ps', ['-o', 'command=', '-p', asked[0].join(',')], { encoding: 'utf8' });
  assert.match(commands, /setInterval/, 'the app is among them');
  answer = false;
  await assert.rejects(builds.showRunnable(ctx, project.id, task.id, 'desk'), /could not be brought to the front/);
  await builds.discard(ctx, project.id, task.id);
});

test('a later turn that changes the run step\'s lines: Review shows them together, and the run step\'s own change as it made it', async () => {
  const { project, workspace, target } = await scene();
  const agent = bridgeAgent(async (use) => {
    await use('declare_runnables', { runnables: [] });
    await use('write_file', { path: 'notes.txt', content: 'from the run step\n' });
    return 'Nothing to run.';
  });
  const build = scripted(['Did it.', ({ task }) => { write(path.join(task.worktree, 'notes.txt'), 'from the Build\n'); return 'Rewrote notes.'; }]);
  const { builds } = manager(build, agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  let task = await stepped(builds, project, started.id, 1);
  assert.equal(task.messages[task.messages.length - 1].text, 'Run step: nothing here to run.');
  await builds.reply(ctx, project.id, task.id, 'Again.');
  task = await stepped(builds, project, task.id, 2);
  const review = await builds.review(ctx, project.id, task.id);
  assert.equal(review.runStep.apart, false);
  assert.deepEqual(review.files.map((file) => file.path), ['notes.txt']);
  assert.match(review.runStep.patch, /\+from the run step/);
  await builds.discard(ctx, project.id, task.id);
});

test('a runnable out of time is failed with its last error, and the agent is told to go on; the Build is unchanged', async () => {
  const { project, workspace, target, row } = await scene();
  const agent = bridgeAgent(async (use) => {
    await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }] });
    for (let i = 0; i < 50; i += 1) {
      try {
        const out = await use('start_runnable', { name: 'web', run_command: 'node broken.cjs {port}' });
        if (out.timed_out) break;
      } catch (error) { assert.match(error.message, /time is up|recorded as failed/); break; }
    }
    return 'web does not run.';
  });
  const { builds } = manager(scripted(['Done.']), agent, { runnableMs: 1500 });
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const task = await stepped(builds, project, started.id, 1);
  assert.deepEqual([task.status, task.runStep.status, task.runStep.runnables[0].status], ['review', 'done', 'failed']);
  assert.match(task.runStep.runnables[0].error, /Cannot find module/, 'its last error, on the record');
  assert.deepEqual(await runnableStore(ctx.libraryDb).list(row.id), [], 'nothing is written before Accept');
  await builds.accept(ctx, project.id, task.id);
  const [stored] = await runnableStore(ctx.libraryDb).list(row.id);
  assert.deepEqual([stored.status, stored.run_command], ['failed', null], 'accepted: its failure is kept, and no command that never passed');
  assert.match(stored.last_error, /Cannot find module/);
  const accepted = store.readTask(projects.findProject(ctx, project.id), task.id);
  assert.deepEqual([accepted.keptCopy || false, fs.existsSync(task.worktree)], [false, false], 'nothing ran: its copy goes at once, as before');
});

test('no run step for a quick task, or a turn that ends needing the person; a failing agent leaves the Build as it was', async () => {
  const { project, workspace, target } = await scene();
  const agent = bridgeAgent(async () => { throw new Error('Sign in to your Claude subscription using Claude Code in the Canvas terminal.'); });
  const { builds } = manager(scripted(['Fixed.', 'Half done.\n\nNEEDS YOU: Which port?', 'Done now.']), agent);
  const quick = await builds.start(ctx, project.id, { kind: 'quick', text: 'fix the typo' });
  const landed = await settled(project, quick.id);
  await pause(200);
  assert.deepEqual([store.readTask(projects.findProject(ctx, project.id), quick.id).runStep || null, agent.seen.length], [null, 0], `a quick task (${landed.status}) has none`);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const asking = await settled(project, started.id);
  await pause(200);
  assert.deepEqual([asking.status, asking.runStep || null, agent.seen.length], ['needs-you', null, 0]);
  await builds.reply(ctx, project.id, started.id, 'Any port.');
  const task = await stepped(builds, project, started.id, 2);
  assert.deepEqual([task.status, task.runStep.status, task.runStep.error], ['review', 'failed', 'Sign in to your Claude subscription using Claude Code in the Canvas terminal.']);
  assert.match(task.messages[task.messages.length - 1].text, /^Run step failed: Sign in/);
  await builds.discard(ctx, project.id, task.id);
});

test('a reply while the run step works halts it first: its change is still its own checkpoint, and nothing is recorded as failed', async () => {
  const { project, workspace, target, row } = await scene();
  let release;
  const agent = bridgeAgent(async (use, input) => {
    if (/Nothing has been verified/.test(input.prompt) && !release) {
      await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }] });
      await use('write_file', { path: 'halted.txt', content: 'half\n' });
      await new Promise((resolve) => { release = resolve; input.signal.addEventListener('abort', resolve, { once: true }); });
      input.signal.throwIfAborted();
    }
    return 'ok';
  });
  const turn = (text) => ({ task }) => { write(path.join(task.worktree, `${text}.txt`), `${text}\n`); return text; };
  const { builds } = manager(scripted([turn('one'), turn('two')]), agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  for (let i = 0; i < 400 && !release; i += 1) await pause(25);
  await builds.reply(ctx, project.id, started.id, 'More.');
  const task = await stepped(builds, project, started.id, 2);
  const steps = task.checkpoints.map((checkpoint) => checkpoint.step || 'turn');
  assert.deepEqual(steps, ['turn', 'run', 'turn'], 'the halted run step\'s change, then the next turn');
  assert.ok(task.messages.some((message) => message.text === 'Run step stopped.'));
  assert.deepEqual(await runnableStore(ctx.libraryDb).list(row.id), [], 'halted: nothing recorded against it');
  await builds.discard(ctx, project.id, task.id);
});

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const detachedAt = (dir) => { try { execFileSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: dir, env: environment }); return null; } catch { return sh(dir, 'rev-parse', 'HEAD'); } };
const branchThere = (repo, branch) => { try { sh(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; } };

test('Accept keeps what runs up on the code that landed, its copy detached there; Stop stops one runnable at a time, and the copy goes with the last', async () => {
  const { project, workspace, target } = await scene();
  const agent = bridgeAgent(async (use) => {
    await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }, { name: 'desk', folder: '.', type: 'app' }, { name: 'cli', folder: '.', type: 'terminal' }] });
    for (const [name, command] of [['web', 'PORT={port} node server.cjs'], ['desk', 'node -e "setInterval(() => {}, 1000)"'], ['cli', 'node cli.cjs --help']]) assert.equal((await use('start_runnable', { name, run_command: command })).ok, true);
    return 'All three run.';
  });
  const { builds, shown } = manager(scripted([({ task }) => { write(path.join(task.worktree, 'feature.js'), 'new\n'); return 'Added feature.js.'; }]), agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  let task = await stepped(builds, project, started.id, 1);
  const url = task.runStep.runnables.find((item) => item.name === 'web').url;
  const desk = task.runStep.runnables.find((item) => item.name === 'desk').pid;
  assert.ok(Number.isInteger(desk) && alive(desk), 'its process group, on the record');
  await builds.showRunnable(ctx, project.id, task.id, 'cli');
  await builds.accept(ctx, project.id, task.id);
  task = store.readTask(projects.findProject(ctx, project.id), task.id);
  assert.deepEqual([task.status, task.keptCopy, fs.existsSync(task.worktree)], ['accepted', true, true]);
  assert.equal(detachedAt(task.worktree), task.accepted.sha, 'the copy is detached at the commit that landed');
  assert.match(task.messages[task.messages.length - 1].text, /web, desk, cli keep running on it until you stop them\.$/);
  assert.deepEqual([await answers(url), alive(desk)], [true, true]);
  assert.equal(store.publicTask(task).keptCopy, true);

  await builds.stopRunnable(ctx, project.id, task.id, 'web');
  assert.deepEqual([await answers(url), alive(desk), fs.existsSync(task.worktree)], [false, true, true], 'web alone stops');
  await assert.rejects(builds.stopRunnable(ctx, project.id, task.id, 'web'), /web is not running/);
  await builds.stopRunnable(ctx, project.id, task.id, 'cli');
  assert.deepEqual(shown.closed, ['term-1'], 'its terminal closes');
  task = store.readTask(projects.findProject(ctx, project.id), task.id);
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.status]), [['web', 'stopped'], ['desk', 'running'], ['cli', 'stopped']]);
  await builds.stopRunnable(ctx, project.id, task.id, 'desk');
  await pause(100);
  task = store.readTask(projects.findProject(ctx, project.id), task.id);
  assert.deepEqual([alive(desk), task.keptCopy, fs.existsSync(task.worktree), branchThere(task.repo, task.branch)], [false, false, false, false], 'the last one: the copy and its branch go');
  assert.ok(task.runStep.runnables.every((item) => item.status === 'stopped' && item.pid === null));
  assert.equal(task.messages[task.messages.length - 1].text, 'Stopped desk. Nothing of it runs now, and its copy is removed.');
  await assert.rejects(builds.stopRunnable(ctx, project.id, task.id, null), /Nothing of this Build is running/);
});

test('a kept copy goes when Engelbart quits, and one a crash left behind is swept when it starts: its processes stopped only while they are still its own', { skip: process.platform === 'win32' && 'POSIX only: a crash\'s leftovers are found with lsof and stopped as a process group; Windows skips that sweep (src/main/build/run-processes.cjs)' }, async () => {
  const { project, workspace, target } = await scene();
  const agent = bridgeAgent(async (use) => {
    await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }] });
    assert.equal((await use('start_runnable', { name: 'web', run_command: 'PORT={port} node server.cjs' })).ok, true);
    return 'web runs.';
  });
  const accepted = async (builds) => {
    const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
    const task = await stepped(builds, project, started.id, 1);
    await builds.accept(ctx, project.id, task.id);
    return store.readTask(projects.findProject(ctx, project.id), task.id);
  };
  // Quit.
  const first = manager(scripted([({ task }) => { write(path.join(task.worktree, 'a.js'), 'a\n'); return 'a'; }]), agent);
  let quit = await accepted(first.builds);
  assert.equal(quit.keptCopy, true);
  await first.builds.stopAll();
  quit = store.readTask(projects.findProject(ctx, project.id), quit.id);
  assert.deepEqual([await answers(quit.runStep.runnables[0].url), quit.keptCopy, fs.existsSync(quit.worktree)], [false, false, false], 'quitting stops it and the copy goes');
  assert.match(quit.messages[quit.messages.length - 1].text, /^Engelbart closed: what ran on it was stopped/);

  // A crash: the app that kept it is gone without stopping anything; the next one to start sweeps it.
  const crashed = manager(scripted([({ task }) => { write(path.join(task.worktree, 'b.js'), 'b\n'); return 'b'; }]), agent);
  const left = await accepted(crashed.builds);
  const { url, pid } = left.runStep.runnables[0];
  assert.deepEqual([left.keptCopy, await answers(url)], [true, true]);
  const next = manager(scripted([]), agent);
  next.builds.list(ctx, project.id);
  await next.builds.sweeping();
  const swept = store.readTask(projects.findProject(ctx, project.id), left.id);
  assert.deepEqual([await answers(url), alive(pid), swept.keptCopy, fs.existsSync(left.worktree), branchThere(left.repo, left.branch)], [false, false, false, false, false]);
  assert.ok(swept.runStep.runnables.every((item) => item.status === 'stopped'));
  assert.match(swept.messages[swept.messages.length - 1].text, /it was stopped when Engelbart started again/);
  await crashed.builds.stopAll();
});

test('a process group left behind is stopped only while its leader is the one started there: a folder elsewhere is never touched', { skip: process.platform === 'win32' && 'POSIX only: a leftover is found with lsof and stopped as a process group; Windows skips it (src/main/build/run-processes.cjs)' }, async () => {
  const inside = fs.mkdtempSync(path.join(homeDir, 'leftover-'));
  const elsewhere = fs.mkdtempSync(path.join(homeDir, 'elsewhere-'));
  const { spawn } = require('node:child_process');
  const child = spawn('/bin/sleep', ['30'], { cwd: inside, detached: true, stdio: 'ignore' });
  await pause(200);
  assert.equal(await stopLeftover(child.pid, elsewhere), false, 'not in that copy: left alone');
  assert.equal(alive(child.pid), true);
  assert.equal(await stopLeftover(123456789, inside), false, 'nothing by that number');
  assert.equal(await stopLeftover(child.pid, inside), true);
  await pause(100);
  assert.equal(alive(child.pid), false);
});

test('the default repo\'s run step keeps its runnables on the default repo\'s row; the fake agent finds a start script and a bin', async () => {
  n += 1;
  const code = repository(`default-${n}`, { 'README.md': 'x\n' });
  const project = await projects.createProject(ctx, { name: `Default run ${n}`, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Build it.');
  const build = scripted([({ task }) => { for (const [file, text] of Object.entries(APP)) write(path.join(task.worktree, file), text); return 'Wrote the app.'; }]);
  const { builds, shown } = manager(build, createFakeRunAgent({ kinds: ALL_KINDS }));
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await stepped(builds, project, started.id, 1);
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.type, item.status]), [['web', 'ui', 'running'], ['cli', 'terminal', 'running']]);
  const [mine] = await ctx.libraryDb.query('select * from library where folder_path = $1', [task.repo]);
  assert.deepEqual(await runnableStore(ctx.libraryDb).list(mine.id), [], 'kept only on Accept');
  assert.equal(shown.opened.length, 0, 'no terminal until it is opened');
  const url = task.runStep.runnables[0].url;
  await builds.accept(ctx, project.id, task.id);
  const { sha } = store.readTask(projects.findProject(ctx, project.id), task.id).accepted;
  assert.deepEqual((await runnableStore(ctx.libraryDb).list(mine.id)).map((item) => [item.run_command, item.verified_commit]), [['node cli.cjs --help', sha], ['PORT={port} npm start', sha]], 'on the default repo\'s row');
  await builds.stopAll();
  assert.equal(await answers(url), false, 'quitting stops what it started');
});

test('the run step follows the project\'s default: after Make default, a post-it\'s Build runs in it and its runnables are kept on its row (2026-09-29)', async () => {
  n += 1;
  const code = repository(`code-${n}`, { 'README.md': 'x\n' });
  const project = await projects.createProject(ctx, { name: `Follows ${n}`, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Build it.');
  const app = repository(`app-${n}`);
  const row = await ctx.libraryDb.insert({ id: randomUUID(), name: 'the app', type: 'folder', tags: ['git'], folder_path: app, project_id: project.id });
  const hello = ({ task }) => { write(path.join(task.worktree, 'hello.txt'), 'hello\n'); return 'Wrote hello.txt.'; };
  const { builds } = manager(scripted([hello, hello]), createFakeRunAgent({ kinds: ALL_KINDS }));
  await builds.setDefault(ctx, project.id, { kind: 'library', id: row.id });
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, text: 'Make the page say hello.' });
  const task = await stepped(builds, project, started.id, 1);
  assert.deepEqual([task.repo, task.target], [app, { kind: 'default', name: 'the app' }]);
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.status]), [['web', 'running'], ['cli', 'running']]);
  await builds.accept(ctx, project.id, task.id);
  const { sha } = store.readTask(projects.findProject(ctx, project.id), task.id).accepted;
  assert.deepEqual((await runnableStore(ctx.libraryDb).list(row.id)).map((item) => [item.name, item.verified_commit]), [['cli', sha], ['web', sha]], 'on the default\'s own row');
  assert.deepEqual(await ctx.libraryDb.query('select id from library where folder_path = $1', [code]), [], 'no row made for the code directory');

  // Made the code directory instead: the next run step keeps its runnables on the code directory's row (made for it).
  write(path.join(code, 'package.json'), APP['package.json']);
  write(path.join(code, 'server.cjs'), APP['server.cjs']);
  write(path.join(code, 'cli.cjs'), APP['cli.cjs']);
  sh(code, 'add', '-A');
  sh(code, 'commit', '-qm', 'the app');
  await builds.setDefault(ctx, project.id, { kind: 'project' });
  const next = await stepped(builds, project, (await builds.start(ctx, project.id, { workspaceId: workspace.id })).id, 1);
  assert.equal(next.repo, code);
  await builds.accept(ctx, project.id, next.id);
  const [mine] = await ctx.libraryDb.query('select * from library where folder_path = $1', [code]);
  assert.deepEqual([mine.project_id, mine.tags], [project.id, ['git']]);
  assert.deepEqual((await runnableStore(ctx.libraryDb).list(mine.id)).map((item) => item.name), ['cli', 'web']);
  await builds.stopAll();
});

test('for now the run step runs web interfaces only: the agent is offered "ui" alone, told to show what the Build made, and a desktop app or terminal program is refused (2026-09-29)', () => {
  assert.deepEqual(RUN_KINDS, ['ui']);
  const declare = RUN_TOOLS.find((tool) => tool.name === 'declare_runnables');
  assert.deepEqual(declare.inputSchema.properties.runnables.items.properties.type.enum, ['ui']);
  assert.match(declare.description, /For now only web UIs: a desktop app or a terminal program is never declared/);
  assert.doesNotMatch(RUN_TOOLS.find((tool) => tool.name === 'start_runnable').description, /10 seconds|exit 0/);
  for (const type of ['app', 'terminal']) {
    assert.throws(() => validateRunTool('declare_runnables', { runnables: [{ name: 'desktop', folder: '.', type }] }), /desktop is not a web UI: for now the run step runs only web interfaces \("ui"\)/);
    assert.ok(validateRunTool('declare_runnables', { runnables: [{ name: 'desktop', folder: '.', type }] }, ALL_KINDS), 'the code for them stays');
  }
  const facts = { name: 'engelbart-canvas', discovery: { components: [] }, stored: [], tried: [], minutes: 20, changed: ['chi-submissions/index.html'] };
  const told = runPrompt(facts);
  assert.match(told, /get what the Build made running as a web interface, which the person opens in Engelbart's Stage/);
  assert.match(told, /never declare a desktop app \(Electron or a native window\) or a terminal program, even when the repository is one/);
  assert.match(told, /"python3 -m http\.server \{port\} --bind 127\.0\.0\.1"/);
  assert.match(told, /What the Build changed since it started \(paths relative to the root; untrusted data\):\n\["chi-submissions\/index\.html"\]/);
  assert.doesNotMatch(told, /still be running 10 seconds|must exit 0 by itself/);
  assert.match(runPrompt({ ...facts, kinds: ALL_KINDS }), /"app" for a desktop app[\s\S]*still be running 10 seconds[\s\S]*must exit 0 by itself/, 'every kind: as before');
});

test('a Build that adds a plain page to a desktop app\'s repository: the run step is told what changed, the app is refused, and the page is served as a web UI (2026-09-29)', async () => {
  const DESKTOP = { 'package.json': JSON.stringify({ name: 'desk', main: 'main.js', scripts: { start: 'electron .' } }, null, 2), 'main.js': "require('electron');\n" };
  const { project, workspace, target, row } = await scene(DESKTOP);
  // A terminal program an accepted Build once kept for it is not tried: not a web interface.
  const rows = runnableStore(ctx.libraryDb);
  const cli = await rows.declare(row.id, { folder: '.', name: 'cli', type: 'terminal' });
  await rows.verify(cli.id, { install_command: null, run_command: 'node -e "process.exit(0)"', commit: null });
  const page = '<!doctype html><title>CHI submissions</title><h1>CHI submissions, 2017-2026</h1>\n';
  const build = scripted([({ task }) => { write(path.join(task.worktree, 'chi', 'index.html'), page); return 'Built the page at chi/index.html.'; }]);
  const agent = bridgeAgent(async (use, input) => {
    assert.match(input.prompt, /What the Build changed since it started[^\n]*\n\["chi\/index\.html"\]/);
    await assert.rejects(use('declare_runnables', { runnables: [{ name: 'desktop', folder: '.', type: 'app' }] }), /desktop is not a web UI/);
    await use('declare_runnables', { runnables: [{ name: 'page', folder: 'chi', type: 'ui' }] });
    const served = await use('start_runnable', { name: 'page', run_command: 'python3 -m http.server {port} --bind 127.0.0.1' });
    assert.equal(served.ok, true, JSON.stringify(served));
    return 'page runs.';
  });
  const { builds } = manager(build, agent, { kinds: RUN_KINDS });
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  const task = await stepped(builds, project, started.id, 1);
  assert.equal(agent.seen.length, 1, 'the agent ran: nothing stored is a web interface');
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.type, item.folder, item.status]), [['page', 'ui', 'chi', 'running']], JSON.stringify(task.runStep));
  assert.match(await (await fetch(task.runStep.runnables[0].url)).text(), /CHI submissions, 2017-2026/, 'the page the Build made is what answers');
  await builds.stopAll();
  assert.equal(await answers(task.runStep.runnables[0].url), false);
});
