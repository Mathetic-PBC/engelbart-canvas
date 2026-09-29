'use strict';

// A Build's run step (src/main/build/run-step.cjs and its parts): the launch facts of a folder on this Mac, the tools and
// the paths they may reach, Engelbart's own processes and checks, and the step itself inside the Build's lifecycle — after
// a turn that ends in review only, never for a quick task; the stored commands first; a pass saves the commands (a UI's
// with {port}), a runnable out of time is failed; what it changed is a checkpoint Review shows apart; what it started is
// stopped before the next run step, and on Accept and Discard. The agent is scripted: it calls the tools through the real
// loopback bridge, as the MCP adapter would.

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
const { RUN_TOOLS, worktreePath, validateRunTool, createRunTools } = require('../src/main/build/run-tools.cjs');
const { createProcesses, freePort } = require('../src/main/build/run-processes.cjs');
const { createRunStep, createFakeRunAgent } = require('../src/main/build/run-step.cjs');
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
test.after(async () => { await db.closeAll(); });

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
    openTerminal: ({ cwd, command }) => { const session = { id: `term-${opened.length + 1}`, cwd, command }; opened.push(session); return session; },
    closeTerminal: async (id) => { closed.push(id); },
    terminalSnapshot: (id) => opened.find((session) => session.id === id) || null,
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
  assert.throws(() => validateRunTool('declare_runnables', { runnables: [{ name: 'x', folder: '.', type: 'server' }] }), /ui, app or terminal/);
  assert.throws(() => validateRunTool('run_command', { command: 'ls', extra: 1 }), /Invalid tool arguments/);
  assert.throws(() => validateRunTool('rm_rf', {}), /Unknown/);
});

test('run_command runs to its end in the worktree and refuses launches, the background and kill; files are read and written there', async () => {
  const root = repository('commands');
  const processes = createProcesses({ environment });
  const handlers = { declare: async () => ({}), start: async () => ({}), status: async () => ({}) };
  const call = createRunTools({ root, runnables: handlers, processes, key: 'test' });
  const ran = await call('run_command', { command: 'pwd && echo made > made.txt', cwd: '.' });
  assert.equal(ran.exit_code, 0);
  assert.equal(ran.output.trim().split('\n').pop(), fs.realpathSync(root));
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
  const processes = createProcesses({ environment, appAliveMs: 400, uiReadyMs: 8000 });
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
  assert.match(quick.failed_check, /exited within 0.4 seconds \(exit code 0\)/);

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
  const processes = createProcesses({ environment, appAliveMs: 400, uiReadyMs: 8000 });
  const runStep = createRunStep({ processes, runAgent, prepareClaude: async () => ({ file: 'claude', env: {} }), tickMs: 100, ...shown, ...extra });
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

test('after a turn ends in review: the runnables named, started and checked, their commands kept ({port}, never a port), and shown', async () => {
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
  const rows = await runnableStore(ctx.libraryDb).list(row.id);
  assert.deepEqual(rows.map((item) => [item.name, item.type, item.status, item.run_command]), [['cli', 'terminal', 'verified', 'node cli.cjs --help'], ['web', 'ui', 'verified', 'PORT={port} npm start']]);
  assert.ok(rows.every((item) => /^[0-9a-f]{40}$/.test(item.verified_commit)));
  const run = events.filter((event) => event.channel === 'engelbart:build-run').map((event) => event.payload);
  assert.deepEqual(run.map((event) => [event.kind, event.name]), [['ui', 'web'], ['terminal', 'cli']]);
  assert.equal(run[0].url, web.url);
  assert.deepEqual(shown.opened.map((session) => [session.command, session.cwd]), [['node cli.cjs --help', fs.realpathSync(task.cwd)]], 'the terminal program runs in a terminal of its own');
  assert.match(task.messages[task.messages.length - 1].text, /^Run step: web \(web UI\) runs at http:\/\/localhost:\d+\/; cli \(terminal\) runs\.$/);
  assert.ok(!task.checkpoints.some((checkpoint) => checkpoint.step === 'run'), 'nothing changed, so no run step checkpoint');
  // Shown again from the card; Discard stops everything it started.
  builds.showRunnable(ctx, project.id, task.id, 'web');
  assert.equal(events[events.length - 1].payload.url, web.url);
  await builds.discard(ctx, project.id, task.id);
  assert.equal(await answers(web.url), false, 'Discard stops it');
  assert.deepEqual(shown.closed, ['term-1']);
  const gone = store.readTask(projects.findProject(ctx, project.id), task.id);
  assert.ok(gone.runStep.runnables.every((item) => item.status === 'stopped'));
});

test('what the run step changes is its own checkpoint, apart in Review; the next run step stops what the last one started and tries its stored commands first; Accept stops everything', async () => {
  const { project, workspace, target, repo } = await scene({ ...APP, 'server.cjs': "require('node:http').createServer((q, r) => r.end('hi')).listen(4999, 'localhost');\n" });
  const agent = bridgeAgent(async (use, input) => {
    assert.match(input.prompt, /Nothing has been verified here before/);
    // A fixed port: the one change it takes, made by the run step.
    await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }] });
    await use('write_file', { path: 'server.cjs', content: "require('node:http').createServer((q, r) => r.end('hi')).listen(Number(process.env.PORT), 'localhost');\n" });
    assert.equal((await use('start_runnable', { name: 'web', run_command: 'PORT={port} node server.cjs' })).ok, true);
    return 'web runs; server.cjs now reads PORT.';
  });
  const build = scripted([
    ({ task }) => { write(path.join(task.worktree, 'feature.js'), 'one\n'); return 'Added feature.js.'; },
    ({ task }) => { write(path.join(task.worktree, 'feature.js'), 'two\n'); return 'Changed feature.js.'; },
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
  assert.equal(agent.seen.length, 1, 'its stored commands passed again: nothing to explore, so no agent');
  assert.deepEqual([task.runStep.status, task.runStep.runnables.map((item) => [item.name, item.status])], ['done', [['web', 'running']]]);
  assert.match(task.messages[task.messages.length - 1].text, /^Run step: web \(web UI\) runs at http:\/\/localhost:\d+\/\.$/);
  const now = task.runStep.runnables[0].url;
  assert.equal(await answers(now), true);
  review = await builds.review(ctx, project.id, task.id);
  assert.deepEqual([review.files.map((file) => file.path), review.runStep.files.map((file) => file.path)], [['feature.js'], ['server.cjs']]);

  await builds.accept(ctx, project.id, task.id);
  assert.equal(await answers(now), false, 'Accept stops it');
  assert.match(fs.readFileSync(path.join(repo, 'server.cjs'), 'utf8'), /process\.env\.PORT/, 'the run step\'s change lands with the Build');
  assert.equal(fs.readFileSync(path.join(repo, 'feature.js'), 'utf8'), 'two\n');
});

test('a stored command that no longer works: the agent is told, what already passed stays running, and what works instead is stored', async () => {
  const { project, workspace, target, row } = await scene();
  const agent = bridgeAgent(async (use, input) => {
    if (/Nothing has been verified here before/.test(input.prompt)) {
      await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }, { name: 'cli', folder: '.', type: 'terminal' }] });
      assert.equal((await use('start_runnable', { name: 'web', run_command: 'PORT={port} node server.cjs' })).ok, true);
      assert.equal((await use('start_runnable', { name: 'cli', run_command: 'node cli.cjs --help' })).ok, true);
      return 'Both run.';
    }
    assert.match(input.prompt, /"name":"cli","folder":"\.","type":"terminal","passed":false/, 'told which stored command failed, and how');
    const declared = await use('declare_runnables', { runnables: [{ name: 'web', folder: '.', type: 'ui' }, { name: 'cli', folder: '.', type: 'terminal' }] });
    assert.deepEqual(declared.runnables.map((item) => [item.name, item.status, item.stored.run_command]), [['web', 'running', 'PORT={port} node server.cjs'], ['cli', 'waiting', 'node cli.cjs --help']]);
    assert.equal((await use('start_runnable', { name: 'cli', run_command: 'node tool.cjs --help' })).ok, true);
    return 'cli is tool.cjs now.';
  });
  const build = scripted([
    'Built it.',
    ({ task }) => { fs.renameSync(path.join(task.worktree, 'cli.cjs'), path.join(task.worktree, 'tool.cjs')); return 'Renamed the CLI.'; },
  ]);
  const { builds } = manager(build, agent);
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id, target });
  let task = await stepped(builds, project, started.id, 1);
  await builds.reply(ctx, project.id, task.id, 'Rename the CLI.');
  task = await stepped(builds, project, task.id, 2);
  assert.equal(agent.seen.length, 2, 'a stored command failed: the agent explores');
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.status]), [['web', 'running'], ['cli', 'running']]);
  const rows = await runnableStore(ctx.libraryDb).list(row.id);
  assert.deepEqual(rows.map((item) => [item.name, item.status, item.run_command]), [['cli', 'verified', 'node tool.cjs --help'], ['web', 'verified', 'PORT={port} node server.cjs']], 'what works instead replaces it');
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
  const [stored] = await runnableStore(ctx.libraryDb).list(row.id);
  assert.deepEqual([stored.status, stored.run_command], ['failed', null], 'no command is kept that never passed');
  assert.match(stored.last_error, /Cannot find module/);
  await builds.discard(ctx, project.id, task.id);
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
  const [stored] = await runnableStore(ctx.libraryDb).list(row.id);
  assert.equal(stored.status, 'pending', 'halted: nothing recorded against it');
  await builds.discard(ctx, project.id, task.id);
});

test('the default repo\'s run step keeps its runnables on the default repo\'s row; the fake agent finds a start script and a bin', async () => {
  n += 1;
  const code = repository(`default-${n}`, { 'README.md': 'x\n' });
  const project = await projects.createProject(ctx, { name: `Default run ${n}`, directory: code });
  const workspace = await projects.createWorkspace(ctx, project.id, { name: 'Feature' });
  await projects.writeDoc(ctx, project.id, { kind: 'workspace', workspaceId: workspace.id }, 'Build it.');
  const build = scripted([({ task }) => { for (const [file, text] of Object.entries(APP)) write(path.join(task.worktree, file), text); return 'Wrote the app.'; }]);
  const { builds, shown } = manager(build, createFakeRunAgent());
  const started = await builds.start(ctx, project.id, { workspaceId: workspace.id });
  const task = await stepped(builds, project, started.id, 1);
  assert.deepEqual(task.runStep.runnables.map((item) => [item.name, item.type, item.status]), [['web', 'ui', 'running'], ['cli', 'terminal', 'running']]);
  const [mine] = await ctx.libraryDb.query('select * from library where folder_path = $1', [task.repo]);
  assert.deepEqual((await runnableStore(ctx.libraryDb).list(mine.id)).map((item) => item.run_command), ['node cli.cjs --help', 'PORT={port} npm start']);
  assert.equal(shown.opened.length, 1);
  const url = task.runStep.runnables[0].url;
  await builds.stopAll();
  assert.equal(await answers(url), false, 'quitting stops what it started');
});
