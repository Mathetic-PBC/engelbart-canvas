'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const db = require('../src/main/store/db.cjs');
const projects = require('../src/main/store/projects.cjs');
const { ensureHome } = require('../src/main/store/home.cjs');
const { createLocalPreviews } = require('../src/main/local-preview/manager.cjs');
const { createProcesses, ownsListener, environmentFor } = require('../src/main/local-preview/process.cjs');
const { locations, readRecipe } = require('../src/main/local-preview/files.cjs');
const { createBuildAgent } = require('../src/main/local-preview/agent.cjs');
const { createBuildPlanner, normalizePlan, claudeFailure } = require('../src/main/local-preview/plan.cjs');
const { CLAUDE_SUBSCRIPTION_COMMAND } = require('../src/main/bart/claude-command.cjs');
const fixturePlan = require('./fixtures/local-build-plan.cjs');
const { readQuestion, withChoice } = require('../src/main/bart/question.cjs');
const { DEFAULT_MODELS } = require('../src/main/bart/models.cjs');
const { registerEngelbartIpc } = require('../src/main/ipc.cjs');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-local-preview-test-'));
let ctx, project;
test.before(async () => {
  const layout = ensureHome(root);
  ctx = { homeDir: root, root: layout.root, dataRoot: layout.root, libraryDb: await db.openLibraryDb(layout.root) };
  project = await projects.createProject(ctx, { name: 'Local interfaces', directory: root });
});
test.after(() => db.closeAll());

const serverSource = `const http=require('node:http');
const fs=require('node:fs');
http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(fs.readFileSync('index.html'))}).listen(Number(process.argv[2]),'127.0.0.1');`;
function writeApp(directory, input, { broken = false, wide = false } = {}) {
  fs.writeFileSync(path.join(directory, 'server.cjs'), wide ? serverSource.replace("'127.0.0.1'", "'0.0.0.0'") : serverSource);
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>Local fixture</title><main><h1>A working interface</h1><button>Try me</button></main>');
  fs.writeFileSync(path.join(directory, 'engelbart-preview.json'), JSON.stringify({ version: 1, kind: 'interface', buildId: input.askId, name: 'Local fixture', command: broken ? 'exit 3 # {port}' : 'node server.cjs {port}', install: null }));
  fs.writeFileSync(path.join(directory, '.gitignore'), 'node_modules\n');
}
async function fixture(t, overrides = {}) {
  const workspace = await projects.createWorkspace(ctx, project.id, { name: randomUUID() });
  const input = { askId: randomUUID(), workspaceId: workspace.id, ref: { kind: 'workspace', workspaceId: workspace.id }, text: '--build Make a small interface', turns: [] };
  await projects.writeDoc(ctx, project.id, input.ref, '# Workspace instructions\nUse a restrained interface.');
  const events = [];
  const manager = createLocalPreviews({
    confirm: async () => true,
    planner: async () => fixturePlan(),
    agent: async (_ctx, _pid, request, { directory }) => { writeApp(directory, request); return { text: 'Created the interface.' }; },
    verify: async url => { assert.match(await (await fetch(url)).text(), /working interface/); return { title: 'Verified fixture' }; },
    notify: event => events.push(event), readyTimeoutMs: 4000, ...overrides,
  });
  t.after(() => manager.close());
  return { workspace, input, manager, events, build: options => manager.build(ctx, project.id, input, options) };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { const answer = await check(); if (answer) return answer; await delay(30); }
  throw new Error('Timed out waiting for local preview test state.');
}

test('the explicit build shortcut survives model choices; ordinary prose is not a flag', () => {
  for (const text of ['--build create it', '--sol --build --high create it', 'create it --build']) assert.equal(readQuestion(text, DEFAULT_MODELS).build, true);
  for (const text of ['build an interface?', 'what does --build mean?', '--unknown --build something']) assert.equal(readQuestion(text, DEFAULT_MODELS).build, false);
  const changed = withChoice('--build --astra build a timer', DEFAULT_MODELS, { model: 'sol', effort: 'high' });
  assert.equal(changed, '--build --sol --high build a timer');
});

test('runtime environment drops credentials and inherited agent state', () => {
  const env = environmentFor({ SHELL: '/bin/zsh', PATH: process.env.PATH, HOME: root, E2B_API_KEY: 'no', GITHUB_TOKEN: 'no', OPENAI_API_KEY: 'no', DATABASE_PASSWORD: 'no', CODEX_HOME: '/private/agent', CLAUDECODE: '1' });
  for (const key of ['E2B_API_KEY', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'DATABASE_PASSWORD', 'CODEX_HOME', 'CLAUDECODE']) assert.equal(env[key], undefined);
  assert.equal(env.PATH, process.env.PATH);
});

test('notification approval waits before coding and accepts only the current workspace request once', async t => {
  let calls = 0;
  const progress = [];
  const f = await fixture(t, { confirm: null, agent: async (_ctx, _pid, input, { directory }) => { calls++; writeApp(directory, input); return { text: 'Built.' }; } });
  const pending = f.build({ onProgress: value => progress.push(value) });
  const approval = await until(() => f.manager.get(ctx, project.id, f.workspace.id)?.approval);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(path.join(f.manager.get(ctx, project.id, f.workspace.id).directory, '.git')), false);
  assert.equal(progress.find(value => value.buildApproval)?.buildApproval.id, approval.id);
  const other = await projects.createWorkspace(ctx, project.id, { name: 'Not the requesting workspace' });
  assert.throws(() => f.manager.approve(ctx, project.id, other.id, approval.id, true), /no longer waiting/);
  assert.throws(() => f.manager.approve(ctx, project.id, f.workspace.id, 'stale', true), /no longer waiting/);
  assert.throws(() => f.manager.approve(ctx, project.id, f.workspace.id, approval.id, 'true'), /true or false/);
  f.manager.approve(ctx, project.id, f.workspace.id, approval.id, true);
  assert.throws(() => f.manager.approve(ctx, project.id, f.workspace.id, approval.id, true), /no longer waiting/);
  const { preview } = await pending;
  assert.equal(preview.status, 'ready');
  assert.equal(preview.approval, null);
  assert.equal(calls, 1);
  assert.ok(progress.some(value => value.buildApproval === null));

  // Saying "Not now" to an update must keep the already-live app running.
  f.input.askId = randomUUID();
  const update = f.build(), declined = assert.rejects(update, error => error.kind === 'stopped');
  const next = await until(() => f.manager.get(ctx, project.id, f.workspace.id)?.approval);
  assert.notEqual(next.id, approval.id);
  f.manager.approve(ctx, project.id, f.workspace.id, next.id, false);
  await declined;
  assert.equal(calls, 1);
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).status, 'ready');
  assert.ok((await fetch(preview.url)).ok);
});

test('Stop and shutdown settle pending approvals; saved requests cannot grant permission', async t => {
  const f = await fixture(t, { confirm: null, agent: async () => { throw new Error('Must not run before approval'); } });
  const pending = f.build(), stopped = assert.rejects(pending, error => error.kind === 'stopped');
  const first = await until(() => f.manager.get(ctx, project.id, f.workspace.id)?.approval);
  assert.equal(f.manager.stopAsk(f.input.askId), true);
  await stopped;
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).approval, null);
  assert.throws(() => f.manager.approve(ctx, project.id, f.workspace.id, first.id, true), /no longer waiting/);
  f.input.askId = randomUUID();
  const again = f.build(), closed = assert.rejects(again, error => error.kind === 'stopped');
  await until(() => f.manager.get(ctx, project.id, f.workspace.id)?.approval);
  await f.manager.close();
  await closed;
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).approval, null);
});

test('build → owned server → verified preview → library; update reuses repo; stop and restart persist', async t => {
  const f = await fixture(t);
  const first = await f.build();
  const preview = first.preview;
  assert.equal(preview.status, 'ready');
  assert.ok(fs.existsSync(path.join(preview.directory, '.git')));
  assert.ok(f.events.some(event => event.preview?.status === 'checking'));
  assert.ok(first.lines.join('\n').includes(preview.url));
  assert.equal((await ctx.libraryDb.get(preview.libraryId)).folder_path, preview.directory);
  assert.ok(projects.findWorkspace(ctx, project.id, f.workspace.id).workspace.context.includes(preview.libraryId));
  fs.writeFileSync(path.join(preview.directory, 'keep.txt'), 'user work');
  f.input.askId = randomUUID();
  const second = await f.build();
  assert.equal(second.preview.directory, preview.directory);
  assert.equal(second.preview.libraryId, preview.libraryId);
  assert.equal(fs.readFileSync(path.join(preview.directory, 'keep.txt'), 'utf8'), 'user work');
  await f.manager.stop(ctx, project.id, f.workspace.id);
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).status, 'stopped');
  await assert.rejects(fetch(second.preview.url));
  const restart = await f.manager.restart(ctx, project.id, f.workspace.id);
  assert.equal(restart.status, 'ready');
  await f.manager.close();
  await assert.rejects(fetch(restart.url));
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).status, 'stopped');
  assert.ok(f.manager.get(ctx, project.id, f.workspace.id).recipe, 'launch recipe survives app restart');
});

test('one repair inspects the failed command and only the repaired interface becomes ready', async t => {
  let attempts = 0;
  const f = await fixture(t, { agent: async (_ctx, _pid, input, { directory, repair }) => {
    attempts++;
    if (attempts === 2) assert.match(repair, /exited before/);
    writeApp(directory, input, { broken: attempts === 1 });
    return { text: 'Repaired.' };
  } });
  assert.equal((await f.build()).preview.status, 'ready');
  assert.equal(attempts, 2);
});

test('npm-launched servers are owned and Stop terminates their child process too', async t => {
  const f = await fixture(t, { agent: async (_ctx, _pid, input, { directory }) => {
    writeApp(directory, input);
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, scripts: { dev: 'node server.cjs' } }));
    const file = path.join(directory, 'engelbart-preview.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), command: 'npm run dev -- {port}' }));
    return { text: 'An npm app.' };
  } });
  const { preview } = await f.build();
  assert.equal(preview.status, 'ready');
  await f.manager.stop(ctx, project.id, f.workspace.id);
  await assert.rejects(fetch(preview.url));
});

test('unchanged dependencies are reused but compilation runs again after source edits', async t => {
  let build = 0;
  const f = await fixture(t, { agent: async (_ctx, _pid, input, { directory }) => {
    writeApp(directory, input);
    fs.writeFileSync(path.join(directory, 'package.json'), '{"private":true}');
    fs.writeFileSync(path.join(directory, 'source.html'), `<title>Fixture</title><main><h1>A working interface ${++build}</h1></main>`);
    fs.writeFileSync(path.join(directory, 'install.cjs'), "const fs=require('node:fs');fs.mkdirSync('node_modules',{recursive:true});fs.appendFileSync('installs.txt','installed\\n');");
    fs.writeFileSync(path.join(directory, 'compile.cjs'), "require('node:fs').copyFileSync('source.html','index.html');");
    const file = path.join(directory, 'engelbart-preview.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file)), install: 'node install.cjs', build: 'node compile.cjs' }));
    return { text: 'Compiled.' };
  } });
  const first = await f.build();
  assert.match(await (await fetch(first.preview.url)).text(), /interface 1/);
  f.input.askId = randomUUID();
  const second = await f.build();
  assert.match(await (await fetch(second.preview.url)).text(), /interface 2/);
  assert.equal(fs.readFileSync(path.join(second.preview.directory, 'installs.txt'), 'utf8'), 'installed\n');
});

test('a blank/non-interface browser result never becomes live and its process is cleaned up', async t => {
  const f = await fixture(t, { verify: async () => { throw new Error('The page has no visible interface.'); } });
  await assert.rejects(f.build(), /no visible interface/);
  const state = f.manager.get(ctx, project.id, f.workspace.id);
  assert.equal(state.status, 'failed');
  assert.equal(state.url, null);
  assert.ok(!f.events.some(event => event.preview?.status === 'ready'));
  await assert.rejects(fetch(`http://127.0.0.1:${state.port}`));
});

test('old manifests cannot be passed off as a new interface build', async t => {
  let calls = 0;
  const f = await fixture(t, { agent: async (_ctx, _pid, input, { directory }) => { if (++calls === 1) writeApp(directory, input); return { text: 'No interface requested.' }; } });
  await f.build();
  f.input.askId = randomUUID();
  await assert.rejects(f.build(), /did not produce an interface launch recipe/);
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).status, 'failed');
});

test('cancellation stops a build and duplicate requests cannot start a second one', async t => {
  const f = await fixture(t, { agent: async (_ctx, _pid, _input, { signal }) => { await delay(30_000, undefined, { signal }); return { text: 'never' }; } });
  const pending = f.build();
  const rejected = assert.rejects(pending, error => error.kind === 'stopped');
  await until(() => f.manager.get(ctx, project.id, f.workspace.id)?.status === 'building');
  assert.throws(f.build, /already has a local build/);
  assert.equal(f.manager.stopAsk(f.input.askId), true);
  await rejected;
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).status, 'stopped');
});

test('cancellation during browser verification cannot publish a late ready event', async t => {
  let checking = false;
  const f = await fixture(t, { verify: async (_url, { signal }) => { checking = true; await delay(30_000, undefined, { signal }); } });
  const result = f.build();
  const rejected = assert.rejects(result, error => error.kind === 'stopped');
  await until(() => checking);
  await f.manager.stop(ctx, project.id, f.workspace.id);
  await rejected;
  assert.ok(!f.events.some(event => event.preview?.status === 'ready'));
});

test('server exits are reflected in state instead of leaving a false Live indicator', async t => {
  const f = await fixture(t);
  const { preview } = await f.build();
  // Ask the owned process to exit through its fixture endpoint, not by a guessed PID.
  await f.manager.stop(ctx, project.id, f.workspace.id);
  fs.writeFileSync(path.join(preview.directory, 'server.cjs'), serverSource.replace("res.setHeader('content-type'", "if(req.url==='/exit'){res.end('bye');setTimeout(()=>process.exit(0),20);return;}res.setHeader('content-type'"));
  const restarted = await f.manager.restart(ctx, project.id, f.workspace.id);
  await fetch(new URL('/exit', restarted.url));
  await until(() => f.manager.get(ctx, project.id, f.workspace.id).status === 'failed');
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).url, null);
});

test('a same-origin route redirect is checked as an interface', async t => {
  const f = await fixture(t, { agent: async (_ctx, _pid, input, { directory }) => {
    writeApp(directory, input);
    fs.writeFileSync(path.join(directory, 'server.cjs'), serverSource.replace("res.setHeader('content-type'", "if(req.url==='/'){res.writeHead(302,{location:'/app'});res.end();return;}res.setHeader('content-type'"));
    return { text: 'An app with a redirect.' };
  } });
  assert.equal((await f.build()).preview.status, 'ready');
});

test('declining another build leaves an already-running preview untouched', async t => {
  let approved = true;
  const f = await fixture(t, { confirm: async () => approved });
  const { preview } = await f.build();
  approved = false;
  await assert.rejects(f.build(), error => error.kind === 'stopped');
  assert.equal(f.manager.get(ctx, project.id, f.workspace.id).status, 'ready');
  assert.ok((await fetch(preview.url)).ok);
});

test('occupied ports belong to their owner; restart chooses another without killing it', async t => {
  const f = await fixture(t);
  const { preview } = await f.build();
  await f.manager.stop(ctx, project.id, f.workspace.id);
  const outsider = http.createServer((_req, res) => res.end('unrelated'));
  await new Promise(resolve => outsider.listen(preview.port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => outsider.close(resolve)));
  const restarted = await f.manager.restart(ctx, project.id, f.workspace.id);
  assert.notEqual(restarted.port, preview.port);
  assert.equal(await (await fetch(preview.url)).text(), 'unrelated');
});

test('listener ownership rejects all-interface bindings', async t => {
  const f = await fixture(t, { readyTimeoutMs: 500, agent: async (_ctx, _pid, input, { directory }) => { writeApp(directory, input, { wide: true }); return { text: 'Wide.' }; } });
  await assert.rejects(f.build(), /owned loopback port/);
});

test('launch recipe rejects escaping paths, symlinks, missing ports and non-interface output', async t => {
  const f = await fixture(t);
  const where = locations(ctx, project.id, f.workspace.id, true);
  writeApp(where.directory, f.input);
  const file = path.join(where.directory, 'engelbart-preview.json');
  const original = JSON.parse(fs.readFileSync(file));
  for (const patch of [{ cwd: '..' }, { cwd: root }, { kind: 'api' }, { command: 'node server.cjs 4000' }, { path: '//example.com' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...original, ...patch }));
    assert.throws(() => readRecipe(where.directory));
  }
  fs.symlinkSync(root, path.join(where.directory, 'escape'));
  fs.writeFileSync(file, JSON.stringify({ ...original, cwd: 'escape' }));
  assert.throws(() => readRecipe(where.directory), /escapes/);
});

test('both build providers receive existing workspace context, scoped build intent and write tools', async t => {
  const f = await fixture(t);
  const where = locations(ctx, project.id, f.workspace.id, true);
  const auth = path.join(root, 'fixture-auth.json');
  fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', tokens: {} }));
  const calls = [];
  const build = createBuildAgent({ readModels: () => DEFAULT_MODELS, runDirectory: path.join(root, 'agent-runs'), codexHome: path.join(root, 'agent-home'), codexAuthFile: auth,
    processes: { run: async (command, options) => {
      if (command.endsWith('claude auth status')) return { stdout: '{"loggedIn":true}' };
      calls.push({ command, options, prompt: fs.readFileSync(options.env.ENGELBART_BUILD_INPUT, 'utf8') });
      options.onData('{"type":"item.started","item":{"type":"command_execution","command":"ls"}}\n', 'stdout');
      fs.writeFileSync(options.env.ENGELBART_BUILD_OUTPUT, 'App written.');
      return { stdout: '{"type":"result","result":"App written."}\n' };
    } },
  });
  for (const flag of ['--sol', '--sonnet']) await build(ctx, project.id, { ...f.input, text: `--build ${flag} create a timer` }, { directory: where.directory, signal: new AbortController().signal, approved: true, onProgress: () => {} });
  assert.match(calls[0].command, /--sandbox workspace-write/);
  assert.doesNotMatch(calls[0].command, /danger|--add-dir/);
  assert.match(calls[1].command, /--restricted/);
  assert.match(calls[1].command, /Write,Edit,Bash/);
  assert.doesNotMatch(calls[1].command, /bypass|skip-permissions/);
  for (const call of calls) {
    assert.equal(call.options.cwd, where.directory);
    assert.match(call.prompt, /Workspace instructions/);
    assert.match(call.prompt, /<request>create a timer<\/request>/);
    assert.match(call.prompt, new RegExp(`<build_id>${f.input.askId}</build_id>`));
  }
});

test('Claude fails quickly with sign-in instructions; structured agent failures remain readable', async t => {
  const f = await fixture(t);
  const where = locations(ctx, project.id, f.workspace.id, true);
  let signedIn = false, calls = 0;
  const build = createBuildAgent({ readModels: () => DEFAULT_MODELS, runDirectory: path.join(root, 'failure-runs'), environment: {},
    processes: { run: async command => {
      calls++;
      if (command.endsWith('claude auth status')) return { stdout: JSON.stringify({ loggedIn: signedIn }) };
      const error = new Error('Command exited with status 1.');
      error.stdout = '{"type":"result","is_error":true,"result":"The provider is temporarily unavailable."}';
      throw error;
    } },
  });
  const request = { ...f.input, text: '--build --sonnet create a timer' };
  const options = { directory: where.directory, signal: new AbortController().signal, approved: true, onProgress: () => {} };
  await assert.rejects(build(ctx, project.id, request, options), /claude auth login/);
  assert.equal(calls, 1);
  signedIn = true;
  await assert.rejects(build(ctx, project.id, request, options), /provider is temporarily unavailable/);
});

test('IPC keeps questions read-only, while explicit flags and Bart proposals enter the approval flow', async t => {
  const f = await fixture(t);
  const handlers = new Map(), calls = [];
  registerEngelbartIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, trustedHandler: fn => fn,
    store: { context: async () => ctx }, notify: () => {}, readModels: () => DEFAULT_MODELS,
    bart: { ask: async (_ctx, _pid, input) => { calls.push('ask'); return input.text === 'Make an interface' ? { buildProposal: { name: 'Timer', request: 'A local timer interface' } } : { lines: ['answer'] }; }, stop: () => false },
    localPreviews: { build: async () => { calls.push('build'); return { lines: ['built'] }; }, stopAsk: () => true, approve: (...args) => { calls.push(args.slice(1)); return true; } },
  });
  const ask = handlers.get('engelbart:ask-bart');
  await ask(project.id, { ...f.input, text: 'How would I build an interface?' });
  await ask(project.id, f.input);
  assert.deepEqual(calls, ['ask', 'build']);
  assert.equal(handlers.get('engelbart:stop-bart')(f.input.askId), true);
  await ask(project.id, { ...f.input, text: 'Make an interface' });
  assert.deepEqual(calls, ['ask', 'build', 'ask', 'build']);
  const approve = handlers.get('engelbart:local-preview-approve');
  await assert.rejects(approve(project.id, f.workspace.id, 'request', 'true'), /true or false/);
  assert.equal(await approve(project.id, f.workspace.id, 'request', false), true);
  assert.deepEqual(calls.at(-1), [project.id, f.workspace.id, 'request', false]);
});

test('Claude plans read-only before approval and the approved code steps execute in order', async t => {
  const seen = [];
  const f = await fixture(t, {
    planner: async () => { seen.push('plan'); return fixturePlan(2); },
    confirm: async preview => { seen.push('approve'); assert.equal(preview.plan.steps.length, 6); return true; },
    agent: async (_ctx, _pid, input, options) => {
      assert.equal(options.approved, true);
      assert.equal(options.plan.steps.find(row => row.id === options.currentStep.id).status, 'running');
      seen.push(options.currentStep.id);
      if (options.finalCodeStep) writeApp(options.directory, input);
      return { text: 'Implemented the planned step.' };
    },
  });
  const { preview } = await f.build();
  assert.deepEqual(seen, ['plan', 'approve', 'step-1', 'step-2']);
  assert.deepEqual(preview.plan.steps.map(row => row.status), ['done', 'done', 'skipped', 'skipped', 'done', 'done']);
  assert.ok((await f.manager.list(ctx)).some(row => row.id === preview.id));
});

test('planner failure is a notification, not permission or a code-generation attempt', async t => {
  let coded = false, approved = false;
  const f = await fixture(t, { planner: async () => { throw new Error('Claude sign-in needed'); }, confirm: async () => { approved = true; return true; }, agent: async () => { coded = true; } });
  await assert.rejects(f.build(), /sign-in needed/);
  const preview = f.manager.get(ctx, project.id, f.workspace.id);
  assert.equal(preview.status, 'failed');
  assert.equal(preview.error, 'Claude sign-in needed');
  assert.equal(approved, false); assert.equal(coded, false);
});

test('planning can be stopped without any approval, coding or app commands', async t => {
  let approved = false;
  const f = await fixture(t, { planner: async (_ctx, _pid, _input, { signal }) => { await delay(30_000, undefined, { signal }); return fixturePlan(); }, confirm: async () => { approved = true; return true; } });
  const pending = f.build(), stopped = assert.rejects(pending, error => error.kind === 'stopped');
  await until(() => f.manager.get(ctx, project.id, f.workspace.id)?.status === 'planning');
  f.manager.stopAsk(f.input.askId);
  await stopped;
  assert.equal(approved, false);
  assert.equal(fs.existsSync(path.join(f.manager.get(ctx, project.id, f.workspace.id).directory, '.git')), false);
});

test('planner CLI has read-only tools, context and a bounded validated plan', async t => {
  const f = await fixture(t), where = locations(ctx, project.id, f.workspace.id, true);
  let calls = 0;
  const planner = createBuildPlanner({ readModels: () => DEFAULT_MODELS, environment: {}, runDirectory: path.join(root, 'plans'), processes: { run: async (command, options) => {
    calls++;
    assert.ok(command.includes(CLAUDE_SUBSCRIPTION_COMMAND));
    if (command.endsWith('claude auth status')) return { stdout: '{"loggedIn":true}' };
    assert.match(command, /--json-schema "\$ENGELBART_PLAN_SCHEMA"/);
    const schema = JSON.parse(options.env.ENGELBART_PLAN_SCHEMA);
    assert.deepEqual(schema.required, ['name', 'summary', 'steps', 'error']);
    assert.equal(schema.properties.steps.minItems, 5);
    assert.equal(schema.properties.steps.maxItems, 8);
    assert.equal(schema.properties.steps.items.properties.instructions.maxLength, 1200);
    assert.match(command, /--tools "Read,Glob,Grep,WebSearch,WebFetch"/);
    assert.doesNotMatch(command, /Write|Edit|Bash|bypassPermissions/);
    assert.match(fs.readFileSync(options.env.ENGELBART_PLAN_INPUT, 'utf8'), /restrained interface/);
    return { stdout: JSON.stringify({ type: 'result', structured_output: fixturePlan() }) + '\n' };
  } } });
  const plan = await planner(ctx, project.id, f.input, { directory: where.directory, signal: new AbortController().signal });
  assert.equal(calls, 2); assert.equal(plan.by, 'Claude Sonnet');
  assert.equal(plan.steps[0].status, 'pending');
  assert.throws(() => normalizePlan({ ...fixturePlan(), steps: fixturePlan().steps.reverse() }), /invalid build-step sequence/);
  assert.throws(() => normalizePlan({ ...fixturePlan(), steps: [] }), /incomplete/);
  assert.equal(fs.readdirSync(path.join(root, 'plans')).length, 0);
});

test('proxy authentication failures do not persist echoed credentials in notifications', () => {
  const error = new Error('Command exited with status 1.');
  error.stdout = JSON.stringify({ type: 'result', is_error: true, result: '401 Authentication Error. Received API Key = sk-private-example. Token Hash = private-hash' }) + '\n';
  const message = claudeFailure(error).message;
  assert.match(message, /Claude Code.*subscription/);
  assert.doesNotMatch(message, /private-example|private-hash/);
});

test('Claude subscription routing clears overrides introduced by the shell, without changing its configuration', () => {
  const bin = path.join(root, 'subscription-bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'claude'));
  const keys = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];
  const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDE_CODE_OAUTH_TOKEN: 'subscription-fixture' };
  const probe = `process.stdout.write(JSON.stringify({overrides:${JSON.stringify(keys)}.filter(k=>process.env[k]),subscription:process.env.CLAUDE_CODE_OAUTH_TOKEN==="subscription-fixture"}))`;
  const command = `${keys.map(key => `export ${key}=shell-override`).join('\n')}\nexec ${CLAUDE_SUBSCRIPTION_COMMAND} -e '${probe}'`;
  const out = require('node:child_process').execFileSync('/bin/sh', ['-c', command], { env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), { overrides: [], subscription: true });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'subscription-fixture');
});
