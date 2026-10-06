'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { subscriptionEnvironment, subscriptionStatus, prepareLocalClaude, claudeArguments, runLocalClaude } = require('../src/main/sandbox/local-claude.cjs');
const { ROOT, repoPath, validateTool, createSandboxTools, openToolBridge } = require('../src/main/sandbox/local-tools.cjs');
const { runLocalSetup } = require('../src/main/sandbox/local-setup.cjs');
const { createRuntime } = require('../src/main/sandbox/worker.cjs');
// A setup agent's call through its bridge, as Claude's MCP adapter makes it (local-mcp.cjs).
const toolCall = (bridge) => async (name, args) => (await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name, args }) })).json();
const declare = (bridge, kind = 'interface') => toolCall(bridge)('declare_kind', { kind, reason: 'Fixture repository' });

test('subscription environment excludes every API, OAuth, parent-session and Electron credential', () => {
  const source = { HOME: '/users/test', SHELL: '/bin/zsh', PATH: '/bin', CLAUDE_CONFIG_DIR: '/users/test/.claude', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDECODE: '1', E2B_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' };
  assert.deepEqual(subscriptionEnvironment(source), { HOME: '/users/test', SHELL: '/bin/zsh', PATH: '/bin', CLAUDE_CONFIG_DIR: '/users/test/.claude' });
  assert.equal(subscriptionStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), true);
  for (const status of [{}, { loggedIn: true }, { loggedIn: true, authMethod: 'api_key' }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock', subscriptionType: 'max' }]) assert.equal(subscriptionStatus(status), false);
});

test('local Claude missing from the login shell\'s PATH is found where its installer put it (a new account, 2026-09-29)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-local-claude-'));
  const launcher = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'); // where each installer puts it
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
  const asked = [];
  const run = async (file, args) => {
    asked.push([file, args[0]]);
    if (args[0] === '-ilc') throw Object.assign(new Error('not found'), { code: 1 }); // whence -p finds nothing
    if (args[0] === '--version') return { stdout: '2.1.285 (Claude Code)\n' };
    return { stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) };
  };
  const auth = await prepareLocalClaude({ HOME: home, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }, run);
  assert.equal(auth.file, launcher);
  assert.deepEqual(asked.map(([, first]) => first), ['-ilc', '--version', 'auth']);
  const signedOut = async (file, args) => (args[0] === '-ilc' ? { stdout: `${launcher}\n` } : args[0] === '--version' ? { stdout: '2.1.285\n' } : { stdout: '{"loggedIn":false}' });
  await assert.rejects(prepareLocalClaude({ HOME: home, SHELL: '/bin/zsh' }, signedOut), /not signed in/);
});

test('local Claude has only per-run MCP tools, no built-in tools/hooks, and a bounded session', () => {
  const args = claudeArguments('/private/mcp.json');
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'mcp__canvas__*');
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.ok(args.includes('--restricted') && args.includes('--strict-mcp-config') && args.includes('--no-session-persistence'));
  assert.ok(!args.includes('--bare') && !args.includes('--dangerously-skip-permissions'));
  assert.equal(args[args.indexOf('--max-turns') + 1], '32');
  assert.throws(() => claudeArguments('config', 'sonnet --bad'));
});

test('CLI streams messages, requires connected sandbox tools and a successful result, removes bridge capabilities', async () => {
  let directory, seen, input = '', messages = [];
  const spawnProcess = (file, args, options) => {
    seen = { file, args, options }; directory = options.cwd;
    if (process.platform !== 'win32') assert.equal(fs.statSync(directory).mode & 0o777, 0o700); // Windows has no such modes
    const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1]));
    assert.equal(config.mcpServers.canvas.env.ELECTRON_RUN_AS_NODE, '1');
    if (process.platform !== 'win32') assert.equal(fs.statSync(config.mcpServers.canvas.args[1]).mode & 0o777, 0o600);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.stdin.on('data', (chunk) => { input += chunk; });
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.write('{"type":"system","subtype":"init","mcp_servers":[{"name":"canvas","status":"connected"}]}\n');
      child.stdout.write('{"type":"assistant","message":{"content":[{"type":"text","text":"Installing in E2B"}]}}\n');
      child.stdout.write('{"type":"result","subtype":"success","is_error":false}\n');
      child.emit('close', 0);
    });
    return child;
  };
  await runLocalClaude({ auth: { file: '/bin/claude', env: { HOME: '/users/test' } }, bridge: { url: 'http://127.0.0.1:1234/tools', token: '0'.repeat(64) }, prompt: 'Prepare this sandbox', spawnProcess, onMessage: (text) => messages.push(text) });
  assert.equal(input, 'Prepare this sandbox');
  assert.deepEqual(messages, ['Installing in E2B']);
  assert.equal(seen.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(fs.existsSync(directory), false);
});

test('tool validation rejects path escape, type confusion, unknown fields and unsafe preview routes', () => {
  assert.equal(repoPath('src/../package.json'), `${ROOT}/package.json`);
  for (const value of ['/etc/passwd', '../elsewhere', '\0', 1]) assert.throws(() => repoPath(value));
  for (const [name, args] of [
    ['run_command', { command: 12 }], ['run_command', { command: 'ls', sandbox_id: 'another' }],
    ['run_command', { command: 'ls', timeout_seconds: 1000 }], ['run_command', { command: '' }],
    ['start_app', { command: 'npm start', port: 43110 }], ['start_app', { command: 'npm start', port: 3000, path: '//other.example/' }],
    ['start_app', { command: 'npm start', port: 3000, wait_for_install: 'true' }],
    ['read_file', { path: '../../secret' }], ['write_file', { path: 'a', content: {} }], ['delete_sandbox', {}],
  ]) assert.throws(() => validateTool(name, args));
});

test('sandbox tools execute only remotely, bound output, redact secrets and serialize work', async () => {
  const commands = [], events = [];
  let active = 0;
  const tools = createSandboxTools({ signal: new AbortController().signal, secrets: ['test-secret'], environment: { APP_KEY: 'test-secret' }, onEvent: (event) => events.push(event), startApp: async (args) => ({ port: args.port }), sandbox: {
    files: { read: async (file, options) => { assert.equal(file, `${ROOT}/package.json`); assert.equal(options.format, 'stream'); return new Response('test-secret').body; }, write: async () => {} },
    commands: { run: async (command, options) => {
      assert.equal(active++, 0); commands.push(command);
      assert.equal(options.envs.npm_config_audit, 'false');
      assert.equal(options.envs.APP_KEY, 'test-secret');
      options.onStdout('test-secret\n'); await new Promise((resolve) => setTimeout(resolve, 5));
      active--; return { exitCode: 0 };
    } },
  } });
  const results = await Promise.all([tools('run_command', { command: 'npm ci' }), tools('run_command', { command: 'ls' })]);
  assert.deepEqual(commands, [`cd '${ROOT}' && npm ci`, `cd '${ROOT}' && ls`]);
  assert.equal(results[0].output, '[redacted]\n');
  assert.equal((await tools('read_file', { path: 'package.json' })).content, '[redacted]');
  assert.ok(!JSON.stringify(events).includes('test-secret'));
  assert.ok(events.some(event => event.phase === 'agent' && event.message === 'Reading package.json'));
  assert.ok(events.some(event => event.phase === 'agent' && event.tool_status === 'done'));
  assert.ok(events.filter(event => ['stage', 'log'].includes(event.phase)).every(event => event.actor === 'setup-agent'));
});

test('file reads stop at the output limit and cancel the remote stream', async () => {
  let cancelled = false;
  const tools = createSandboxTools({ sandbox: { files: { read: async () => new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(32_000).fill(65)); }, cancel() { cancelled = true; },
  }) } }, onEvent() {} });
  const result = await tools('read_file', { path: 'large.txt' });
  assert.equal(result.content.length, 64_000);
  assert.equal(result.truncated, true);
  assert.equal(cancelled, true);
});

test('closing sandbox tools drains the current operation and rejects queued or future writes', async () => {
  let began, finish;
  const started = new Promise((resolve) => { began = resolve; });
  const pending = new Promise((resolve) => { finish = resolve; });
  const writes = [];
  const tools = createSandboxTools({ sandbox: { files: { write: async (file) => { writes.push(file); began(); await pending; } } }, onEvent() {} });
  const first = tools('write_file', { path: 'first.txt', content: 'test' });
  await started;
  const second = tools('write_file', { path: 'queued.txt', content: 'test' });
  const rejected = assert.rejects(second, /closed/);
  let drained = false;
  const closed = tools.close().then(() => { drained = true; });
  await assert.rejects(tools('write_file', { path: 'later.txt', content: 'test' }), /closed/);
  assert.equal(drained, false);
  finish();
  await Promise.all([first, rejected, closed]);
  assert.equal(drained, true);
  assert.deepEqual(writes, [`${ROOT}/first.txt`]);
});

test('stopping a local setup terminates Claude and rejects instead of falling back', async () => {
  const controller = new AbortController();
  let killed = false;
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.kill = (sig) => { killed = true; assert.equal(sig, 'SIGTERM'); setImmediate(() => child.emit('close', 0)); };
    setImmediate(() => controller.abort());
    return child;
  };
  await assert.rejects(runLocalClaude({ auth: { file: 'claude', env: {} }, bridge: {}, prompt: 'test', signal: controller.signal, spawnProcess }), /abort/i);
  assert.equal(killed, true);
});

test('bridge rejects unauthenticated, cross-origin and arbitrary methods; validates through the tool handler', async () => {
  const bridge = await openToolBridge(async (name, args) => { validateTool(name, args); return { ok: true }; });
  const { url, token } = bridge.connection;
  try {
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://repo.example' }, body: '{}' })).status, 403);
    const invalid = await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name: 'run_command', args: { command: 1 } }) })).json();
    assert.equal(invalid.isError, true);
    const ok = await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ name: 'run_command', args: { command: 'pwd' } }) })).json();
    assert.deepEqual(JSON.parse(ok.content[0].text), { ok: true });
  } finally { await bridge.close(); }
  await assert.rejects(fetch(url));
});

test('real stdio MCP adapter advertises sandbox-only tools and forwards a request', async () => {
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const bridge = await openToolBridge(async (name, args) => { assert.equal(name, 'read_file'); assert.equal(args.path, 'package.json'); return { content: 'fixture' }; });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-mcp-test-'));
  const config = path.join(directory, 'bridge.json');
  fs.writeFileSync(config, JSON.stringify(bridge.connection), { mode: 0o600 });
  const client = new Client({ name: 'canvas-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve(__dirname, '../src/main/sandbox/local-mcp.cjs'), config], env: { ELECTRON_RUN_AS_NODE: '1' } }));
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['declare_kind', 'terminal_ready', 'run_command', 'read_file', 'write_file', 'start_app', 'app_status', 'stop_app', 'list_files', 'dependency_install']);
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'package.json' } });
    assert.equal(JSON.parse(result.content[0].text).content, 'fixture');
  } finally { await client.close(); await bridge.close(); fs.unlinkSync(config); fs.rmdirSync(directory); }
});

test('local setup prompt overlaps managed installation with inspection and requires the actual result', async () => {
  let prompt;
  await assert.rejects(runLocalSetup({ sandbox: { files: { write: async () => {} }, commands: { run: async () => ({ exitCode: 0, stdout: '{}' }) } }, auth: {}, environment: { values: {}, removed: [] },
    onEvent() {}, checkPreview: async () => true, runAgent: async (input) => { prompt = input.prompt; },
  }), /without saying how the repository is used/);
  // The kind comes first, from the discovery and at most one README/manifest read, before any install decision.
  assert.match(prompt, /FIRST, before any install decision, call declare_kind/);
  assert.ok(prompt.indexOf('declare_kind') < prompt.indexOf('dependency_install'), 'the kind is asked for before installation');
  assert.match(prompt, /plus at most one README or manifest read/);
  assert.match(prompt, /interface when a web UI exists \(vite\/next\/express\/etc\., an index\.html, a dev server script\)/);
  assert.match(prompt, /terminal for a CLI, a library, scripts, notebooks-as-scripts, or a package bin\/main with no server/);
  assert.match(prompt, /both for a web UI plus a meaningful CLI/);
  assert.match(prompt, /For terminal there is no web preview and no start_app/);
  assert.match(prompt, /call terminal_ready with the directory to start in and one example command to try/);
  assert.match(prompt, /The hint is shown to the person and never run/);
  assert.match(prompt, /For both, do everything below for the web app \(start_app\) AND call terminal_ready/);
  assert.match(prompt, /Work IN PARALLEL with installation/);
  assert.match(prompt, /read_file and list_files.*while the job runs/);
  assert.match(prompt, /Do not wait for installation before doing this preparation/);
  assert.match(prompt, /always check its actual result before building or starting/);
  assert.match(prompt, /status with wait_seconds=180/);
  assert.match(prompt, /Tool replies include a compact dependency_install snapshot/);
  assert.match(prompt, /A succeeded snapshot in a tool reply is sufficient/);
  assert.match(prompt, /call start_app immediately with wait_for_install:true, even if installation is still running/);
  assert.match(prompt, /If the wait expires, no app is started or queued/);
  assert.match(prompt, /once installation has succeeded.*no known startup prerequisite remains unresolved, make start_app your next tool call/);
  assert.match(prompt, /not a self-reported confidence percentage/);
  assert.match(prompt, /inspect only the missing launch facts/);
  assert.match(prompt, /specific build\/code-generation\/configuration step is required.*then call start_app/);
  assert.match(prompt, /do not fabricate credentials, ignore a known startup blocker, or claim those features work/);
  assert.match(prompt, /Respect declared package-manager versions and lockfiles/);
  for (const exception of ['ambiguous roots', 'conflicting package managers', 'missing runtimes/system dependencies',
    'custom bootstrap steps', 'install-time credentials/services']) {
    assert.ok(prompt.includes(exception), exception);
  }
  assert.match(prompt, /explain the specific prerequisite/);
  assert.match(prompt, /Missing credentials used only when the app runs must not delay an independent install/);
  assert.match(prompt, /already installed or no install is needed, verify that and use action=skip/);
  assert.match(prompt, /action=stop BEFORE changing manifests, lockfiles, runtime or prerequisites/);
  assert.match(prompt, /If installation fails, inspect its error before retrying/);
  assert.match(prompt, /never overlaps two managed jobs/);
  assert.match(prompt, /"parallel":\[\{"manager":"npm"/);
  assert.match(prompt, /Both children must succeed before starting the app/);
  assert.match(prompt, /Do not split one npm workspace into separate installs/);
  assert.match(prompt, /audit reports to Build logs AFTER the preview is ready/);
  assert.doesNotMatch(prompt, /Keep installation in the foreground/);
  assert.match(prompt, /Never request, print or search for credentials/);
  assert.match(prompt, /stop before the operation that needs them rather than fabricate them/);
  assert.match(prompt, /Do not claim success without a successful start_app/);
  assert.match(prompt, /app_status for a fresh check/);
  assert.match(prompt, /Process running, local HTTP healthy, and public preview reachable are separate facts/);
  assert.match(prompt, /Unowned\/unknown listeners are not yours to kill/);
});

test('tool errors expose compact install state through MCP without exposing credentials or the full log', async () => {
  const tools = createSandboxTools({
    sandbox: { files: { read: async () => { throw new Error('File not found'); } } },
    install: { status: () => ({ status: 'failed', exitCode: 1, error: 'fixture-secret install failed', output: 'private long log' }) },
    onEvent() {},
  });
  const bridge = await openToolBridge(tools, { secrets: ['fixture-secret'] });
  try {
    const result = await (await fetch(bridge.connection.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.connection.token}` },
      body: JSON.stringify({ name: 'read_file', args: { path: 'missing.md' } }) })).json();
    assert.equal(result.isError, true);
    const detail = JSON.parse(result.content[0].text);
    assert.equal(detail.error, 'File not found');
    assert.equal(detail.dependency_install.status, 'failed');
    assert.equal(detail.dependency_install.exitCode, 1);
    assert.equal(detail.dependency_install.error, '[redacted] install failed');
    assert.ok(!JSON.stringify(result).includes('private long log'));
  } finally { await bridge.close(); await tools.close(); }
});

test('local setup requires actual start_app, saves restart plan, checks preview, and does not pass Claude auth to E2B', async () => {
  const commands = [], files = new Map(), events = [];
  let running = false;
  const sandbox = { getHost: () => 'preview.example', files: { write: async (file, value) => files.set(file, value) }, commands: { run: async (command, options) => {
    commands.push({ command, options });
    assert.equal(options.envs?.ANTHROPIC_API_KEY, undefined);
    if (command.includes('--local')) {
      running = true;
      options.onStdout('{"phase":"log","stream":"stdout","text":"app log"}\n{"phase":"ready","port":3000,"host":"::1"}\n');
      return { wait: () => new Promise(() => {}) };
    }
    if (command.includes('--app-status')) return { exitCode: 0, stdout: JSON.stringify({ status: running ? 'healthy' : 'idle', running, processes: [], listeners: [] }) };
    return { exitCode: 0 };
  } } };
  const args = { sandbox, auth: { file: 'claude', env: {} }, environment: { values: { APP_KEY: 'app-value' }, removed: [] }, signal: new AbortController().signal, onEvent: (event) => events.push(event), checkPreview: async (url) => { assert.equal(url, 'https://preview.example/'); return true; } };
  await assert.rejects(runLocalSetup({ ...args, runAgent: async ({ bridge }) => { await declare(bridge); } }), /without a verified/);
  assert.ok(events.some(event => event.phase === 'agent' && event.status === 'failed'));
  events.length = 0;
  const result = await runLocalSetup({ ...args, runAgent: async ({ bridge, onMessage }) => {
    onMessage('Reading launch prerequisites while dependencies install.');
    await declare(bridge);
    const skipped = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: 'dependency_install', args: { action: 'skip', reason: 'Fixture app has no dependencies.' } }) });
    assert.equal((await skipped.json()).isError, undefined);
    const response = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: 'start_app', args: { command: 'npm start', port: 3000 } }) });
    assert.equal((await response.json()).isError, undefined);
  } });
  assert.equal(result.preview_url, 'https://preview.example/');
  assert.equal(JSON.parse(files.get('/home/user/.engelbart-canvas/recipe.json')).kind, 'claude-local');
  assert.ok(events.some((event) => event.text === 'app log'));
  assert.ok(commands.some(({ command }) => command.includes('proxy.mjs')));
  assert.ok(commands.some(({ command, options }) => command.includes('43110:3000:::1') && options.envs.ENGELBART_CANVAS_APP_ATTEMPT));
  const agent = events.filter(event => event.phase === 'agent');
  assert.equal(agent[0].status, 'starting');
  assert.ok(agent.some(event => event.message === 'Reading launch prerequisites while dependencies install.'));
  assert.equal(agent.at(-1).status, 'done');
  assert.ok(Number.isFinite(agent.at(-1).elapsed_ms));
  assert.ok(events.some(event => event.phase === 'app_status' && event.app.running));
});

test('failed start returns pre-cleanup diagnostics and confirmed stopped state, not a hidden error or orphaned server', async () => {
  const calls = [], events = [];
  let app = { status: 'idle', running: false, processes: [], listeners: [] };
  const sandbox = { getHost: () => 'preview.example', files: { write: async () => {} }, commands: { run: async (command, options) => {
    calls.push(command);
    if (command.includes('--app-status')) return { exitCode: 0, stdout: JSON.stringify(app) };
    if (command.includes('--stop-app')) { app = { ...app, status: 'stopped', running: false, processes: [], listeners: [] }; return { exitCode: 0 }; }
    if (command.includes('--local')) {
      const attempt = command.match(/--attempt ([a-f0-9-]+)/)[1];
      app = { attempt_id: attempt, status: 'unhealthy', running: true, processes: [{ pid: 701, name: 'node' }],
        listeners: [{ port: 3001, address: '::', ownership: 'owned', pids: [701] }],
        health: { ok: false, error: 'No owned listener on port 5173' }, output: 'fixture-secret meaningful error' };
      options.onStdout(`${JSON.stringify({ phase: 'app_status', message: 'App unhealthy', app })}\n`);
      options.onStdout('{"phase":"error","message":"Local HTTP check failed on port 5173"}\n');
      return { wait: () => new Promise(() => {}) };
    }
    return { exitCode: 0, stdout: '{}' };
  } } };
  await assert.rejects(runLocalSetup({ sandbox, auth: {}, environment: { values: { APP_KEY: 'fixture-secret' }, removed: [] }, onEvent: (event) => events.push(event),
    checkPreview: () => assert.fail('Failed local readiness must not check public preview'), runAgent: async ({ bridge }) => {
      const call = async (name, args) => (await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name, args }) })).json();
      await declare(bridge);
      await call('dependency_install', { action: 'skip', reason: 'Fixture dependencies exist' });
      const result = await call('start_app', { command: 'npm run dev', port: 5173 });
      assert.equal(result.isError, true);
      assert.ok(!JSON.stringify(result).includes('fixture-secret'));
      const details = JSON.parse(result.content[0].text);
      assert.equal(details.failed_check.running, true);
      assert.equal(details.failed_check.listeners[0].port, 3001);
      assert.equal(details.app.running, false);
      assert.match(details.error, /Local HTTP check failed/);
      const status = JSON.parse((await call('app_status', { port: 3001 })).content[0].text);
      assert.equal(status.running, false);
      for (const command of ['npm run dev -w server > /tmp/server.log 2>&1 &', 'pkill -9 -f concurrently', 'kill -9 701']) {
        assert.equal((await call('run_command', { command })).isError, true);
        assert.ok(!calls.some((actual) => actual.endsWith(command)), 'Diagnostic duplicates/kill bypasses must not execute');
      }
    },
  }), /without a verified web preview/);
  assert.equal(app.running, false);
  assert.ok(calls.some((command) => command.includes('--stop-app')));
  assert.ok(events.some((event) => event.phase === 'error' && event.message.includes('5173')), 'The original error must appear in build events');
});

test('start does not proceed when the previous launch cannot be confirmed stopped', async () => {
  const commands = [];
  const sandbox = { files: { write: async () => {} }, commands: { run: async (command) => {
    commands.push(command);
    return { exitCode: command.endsWith('--stop') ? 1 : 0, stdout: '{}' };
  } } };
  await assert.rejects(runLocalSetup({ sandbox, auth: {}, environment: { values: {}, removed: [] }, onEvent() {}, checkPreview: async () => true,
    runAgent: async ({ bridge }) => {
      const call = async (name, args) => (await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name, args }) })).json();
      await declare(bridge);
      await call('dependency_install', { action: 'skip', reason: 'Fixture needs no install' });
      const result = await call('start_app', { command: 'npm start', port: 3000 });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /no replacement was started/);
    },
  }), /without a verified web preview/);
  assert.ok(!commands.some((command) => command.includes('--local')));
});

test('tool replies include observed changes and app_status refreshes state without starting or stopping anything', async () => {
  let app = { status: 'healthy', running: true }, changes = [{ status: 'healthy' }], stopped = 0;
  const tools = createSandboxTools({ sandbox: { files: { read: async () => { app = { status: 'exited', running: false }; changes.push({ status: 'exited' }); return new Response('readme').body; } } },
    appState: () => { const result = { app, app_changes: changes }; changes = []; return result; },
    appStatus: async ({ port }) => { assert.equal(port, 3001); return { ...app, checked: true }; }, stopApp: () => { stopped++; return app; }, onEvent() {} });
  const result = await tools('read_file', { path: 'README.md' });
  assert.equal(result.app.running, false);
  assert.deepEqual(result.app_changes.map((row) => row.status), ['healthy', 'exited']);
  assert.equal((await tools('app_status', { port: 3001 })).checked, true);
  assert.equal(stopped, 0);
  await tools('stop_app', {});
  assert.equal(stopped, 1);
  assert.throws(() => validateTool('app_status', { port: 0 }));
  assert.throws(() => validateTool('stop_app', { pid: 123 }));
});

test('the subscription is checked before provisioning and an API key never stands in for it', async () => {
  const events = [];
  const runtime = createRuntime({ Sandbox: { create: () => assert.fail('must not create sandbox') }, env: { E2B_API_KEY: 'e2b-test', ANTHROPIC_API_KEY: 'should-not-be-used' },
    prepareClaude: async () => { throw new Error('Subscription signed out'); }, emit: (event) => events.push(event) });
  await runtime.run({ run_id: 'local-test', github_url: 'https://github.com/owner/repo' });
  assert.equal(events.at(-1).event, 'failed');
  assert.equal(events.at(-1).error, 'Subscription signed out');
});

test('worker integrates subscription setup with normal ready/log/stop events without an Anthropic key', async () => {
  const events = [], commands = [];
  let kills = 0, finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sandbox = { sandboxId: 'local-sandbox', files: { write: async () => {} }, kill: async () => { kills++; finish(); }, setTimeout: async () => {}, commands: { run: async (command) => { commands.push(command); return { exitCode: 0 }; } } };
  const runtime = createRuntime({ Sandbox: { create: async () => sandbox }, env: { E2B_API_KEY: 'e2b-test' },
    prepareClaude: async () => ({ file: 'claude', env: {} }), detectDocker: async () => false,
    localSetup: async ({ onEvent }) => { onEvent({ phase: 'stage', command: 'npm ci' }); return { preview_url: 'https://preview.example/', port: 3000, done }; },
    emit: (event) => { events.push(event); if (event.event === 'ready') finish(); } });
  await runtime.run({ run_id: 'local-test', github_url: 'https://github.com/owner/repo' });
  assert.deepEqual(events.filter((event) => event.event !== 'progress').map((event) => event.event), ['sandbox_created', 'ready', 'stopped']);
  assert.equal(kills, 1);
  assert.ok(!commands.some((command) => /python3 -u .*\/launch\.py/.test(command)), 'API pipeline must not run');
  assert.ok(events.some((event) => event.message === 'npm ci'));
});

test('verified preview freezes queued and future mutations but keeps read-only status available', async () => {
  let started, complete;
  const waiting = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { complete = resolve; });
  const tools = createSandboxTools({ sandbox: {}, onEvent() {}, startApp: async () => {
    started(); await gate; tools.freeze(); return { ready: true };
  }, stopApp: () => assert.fail('late stop must not execute'), appStatus: async () => ({ running: true }),
  install: { assertReady() {}, status: () => ({ status: 'succeeded' }) } });
  const launch = tools('start_app', { command: 'npm start', port: 3000 });
  await waiting;
  const queued = tools('stop_app', {});
  const rejected = assert.rejects(queued, /already verified/);
  complete(); await launch; await rejected;
  for (const [name, args] of [['write_file', { path: 'x', content: 'x' }], ['run_command', { command: 'echo x' }],
    ['start_app', { command: 'npm start', port: 3000 }], ['dependency_install', { action: 'start', command: 'npm ci' }]]) {
    await assert.rejects(tools(name, args), /already verified/);
  }
  assert.equal((await tools('app_status', {})).running, true);
  await tools.close();
});

test('readiness is published before the final Claude message; late summary failure leaves the app intact', async () => {
  let published = false, stopped = 0, checks = 0;
  const events = [];
  const sandbox = { getHost: () => 'preview.example', files: { write: async () => {} }, commands: { run: async (command, options) => {
    if (command.endsWith('--stop')) stopped++;
    if (command.includes('--app-status')) return { stdout: JSON.stringify({ running: stopped > 0, processes: [], listeners: [] }), exitCode: 0 };
    if (command.includes('--local')) {
      options.onStdout('{"phase":"ready","port":3000}\n');
      return { wait: () => new Promise(() => {}) };
    }
    return { exitCode: 0, stdout: '{}' };
  } } };
  // First status is idle; the one after launch is running.
  let statusCalls = 0;
  const run = sandbox.commands.run;
  sandbox.commands.run = (command, options) => command.includes('--app-status')
    ? Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ running: ++statusCalls > 1, processes: [], listeners: [] }) }) : run(command, options);
  const result = await runLocalSetup({ sandbox, auth: {}, environment: { values: {}, removed: [] },
    discover: async () => ({ components: [] }), onEvent: e => events.push(e), checkPreview: async () => { checks++; return true; },
    onReady: value => { assert.equal(value.preview_url, 'https://preview.example/'); assert.equal(published, false); published = true; },
    runAgent: async ({ bridge }) => {
      const call = async (name, args) => (await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name, args }) })).json();
      await declare(bridge);
      await call('dependency_install', { action: 'skip', reason: 'Fixture' });
      assert.equal((await call('start_app', { command: 'npm start', port: 3000 })).isError, undefined);
      assert.equal(published, true, 'ready must not wait for runAgent to return');
      assert.equal((await call('stop_app', {})).isError, true);
      throw new Error('Final model response failed');
    } });
  assert.equal(result.port, 3000);
  assert.equal(checks, 1, 'public check is not repeated after the final message');
  assert.equal(stopped, 1, 'no post-ready cleanup of the healthy app');
  assert.ok(events.some(e => e.status === 'summary_unavailable'));
  assert.ok(!events.some(e => e.phase === 'agent' && e.status === 'done'), 'a missing final result is not reported as agent completion');
});

test('Railpack hints finish before Claude starts and do not replace the install preflight', async () => {
  let resolveDiscovery, inspecting = false, agentStarted = false;
  const result = runLocalSetup({ sandbox: { files: { write: async () => {} }, commands: { run: async () => { inspecting = true; return { exitCode: 0, stdout: '{}' }; } } },
    auth: {}, environment: { values: {}, removed: [] }, onEvent() {}, checkPreview: async () => true,
    discover: async () => new Promise(resolve => { resolveDiscovery = resolve; }),
    runAgent: async ({ prompt }) => { agentStarted = true; assert.match(prompt, /railpack-evidence-fixture/); },
  });
  const rejected = assert.rejects(result, /without saying how the repository is used/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inspecting, true);
  assert.equal(agentStarted, false);
  resolveDiscovery({ components: [{ cwd: '.', railpack: { start_hint: 'railpack-evidence-fixture' } }] });
  await rejected;
  assert.equal(agentStarted, true);
});

test('a desktop app (Electron, Tauri…) stops before Claude starts: desktop apps are not supported yet (2026-10-04)', async () => {
  for (const [desktop, name] of [[['electron'], 'an Electron'], [['tauri'], 'a Tauri']]) {
    const events = [];
    let agentStarted = false;
    await assert.rejects(runLocalSetup({ sandbox: { files: { write: async () => {} }, commands: { run: async () => ({ exitCode: 0, stdout: '{}' }) } },
      auth: {}, environment: { values: {}, removed: [] }, onEvent: (event) => events.push(event), checkPreview: async () => true,
      discover: async () => ({ components: [{ cwd: '.', hints: { web: ['vite'], desktop } }] }),
      runAgent: async () => { agentStarted = true; },
    }), new RegExp(`^Error: Desktop apps are not supported yet: this repository is ${name} app`));
    assert.equal(agentStarted, false, 'no Claude, no install decisions');
    assert.ok(events.some((event) => event.status === 'unsupported' && /not supported yet/.test(event.message)), 'said in the build log');
  }
});

// How a person uses the repository (2026-10-03): Claude declares it first; a terminal is ready without any web preview.
test('declare_kind and terminal_ready validate their arguments: three kinds, a reason, a directory in the repository, a one-line hint', () => {
  for (const kind of ['interface', 'terminal', 'both']) assert.doesNotThrow(() => validateTool('declare_kind', { kind, reason: 'Has a vite dev server' }));
  assert.doesNotThrow(() => validateTool('terminal_ready', { cwd: '.', hint: 'python main.py --help' }));
  assert.doesNotThrow(() => validateTool('terminal_ready', { cwd: 'tools/cli', hint: 'x'.repeat(200) }));
  for (const [name, args] of [
    ['declare_kind', { kind: 'desktop', reason: 'An Electron app' }], ['declare_kind', { kind: 'terminal' }],
    ['declare_kind', { kind: 'terminal', reason: '   ' }], ['declare_kind', { kind: 'terminal', reason: 'x'.repeat(501) }],
    ['declare_kind', { kind: 'terminal', reason: 'A CLI', extra: true }],
    ['terminal_ready', { cwd: '.' }], ['terminal_ready', { hint: 'make' }], ['terminal_ready', { cwd: '../elsewhere', hint: 'ls' }],
    ['terminal_ready', { cwd: '.', hint: 'x'.repeat(201) }], ['terminal_ready', { cwd: '.', hint: 'ls\nrm -rf /' }],
    ['terminal_ready', { cwd: '.', hint: 'ls \u001b]0;title\u0007' }], ['terminal_ready', { cwd: '.', hint: '  ' }],
  ]) assert.throws(() => validateTool(name, args), `${name} ${JSON.stringify(args)}`);
});

test('until the kind is declared only reading is allowed; a terminal has no start_app and an interface no terminal_ready', async () => {
  let kind = null;
  const runs = [];
  const tools = createSandboxTools({ onEvent() {}, sandbox: { files: { read: async () => new Response('readme').body, write: async () => {} },
    commands: { run: async (command) => { runs.push(command); return { exitCode: 0 }; } } },
  appStatus: async () => ({ running: false }), startApp: async () => ({ ready: true }),
  install: { status: () => ({ status: 'succeeded' }), control: async (args) => ({ status: args.action === 'status' ? 'succeeded' : 'started' }), list: async () => ({ entries: [] }), assertIdle() {}, assertReady() {} },
  kinds: { declared: () => kind, declare: (value) => { kind = value.kind; return { kind }; }, terminal: (value) => ({ ready: true, terminal: value }) } });
  for (const [name, args] of [['write_file', { path: 'a', content: 'x' }], ['run_command', { command: 'ls' }], ['start_app', { command: 'npm start', port: 3000 }],
    ['terminal_ready', { cwd: '.', hint: 'ls' }], ['dependency_install', { action: 'start', command: 'npm ci' }], ['dependency_install', { action: 'skip', reason: 'none' }]]) {
    await assert.rejects(tools(name, args), /Call declare_kind first/, name);
  }
  assert.equal((await tools('read_file', { path: 'README.md' })).content, 'readme');
  await tools('list_files', {});
  await tools('app_status', {});
  await tools('dependency_install', { action: 'status' });
  assert.deepEqual(runs, [], 'nothing ran in the sandbox before the kind');
  await tools('declare_kind', { kind: 'terminal', reason: 'A Python CLI' });
  await assert.rejects(tools('start_app', { command: 'npm start', port: 3000 }), /declared terminal.*terminal_ready/);
  assert.deepEqual((await tools('terminal_ready', { cwd: 'src/..', hint: 'python main.py --help' })).terminal, { cwd: '.', hint: 'python main.py --help' });
  assert.deepEqual(runs, [`test -d '${ROOT}'`]);
  await tools('declare_kind', { kind: 'interface', reason: 'It has a web UI after all' });
  await assert.rejects(tools('terminal_ready', { cwd: '.', hint: 'ls' }), /declared interface.*start_app/);
  assert.equal((await tools('start_app', { command: 'npm start', port: 3000 })).ready, true);
  const plain = createSandboxTools({ sandbox: {}, onEvent() {} });
  await assert.rejects(plain('declare_kind', { kind: 'terminal', reason: 'x' }), /Unknown sandbox tool/, 'only a setup that asks for the kind offers it');
});

function terminalSandbox({ missing = [] } = {}) {
  const commands = [], files = new Map();
  let running = false;
  return { commands, files, sandbox: { getHost: () => 'preview.example', files: { write: async (file, value) => files.set(file, value) }, commands: { run: async (command, options) => {
    commands.push(command);
    if (command.startsWith('test -d ')) {
      if (missing.some((dir) => command.includes(dir))) throw Object.assign(new Error('exit status 1'), { exitCode: 1 });
      return { exitCode: 0 };
    }
    if (command.includes('--local')) {
      running = true;
      options.onStdout('{"phase":"ready","port":3000,"host":"127.0.0.1"}\n');
      return { wait: () => new Promise(() => {}) };
    }
    if (command.includes('--app-status')) return { exitCode: 0, stdout: JSON.stringify({ status: running ? 'healthy' : 'idle', running, processes: [], listeners: [] }) };
    return { exitCode: 0, stdout: '{}' };
  } } } };
}

test('a terminal is ready once installed: terminal_ready, no start_app, no preview check, the kind and the hint in the build log', async () => {
  const f = terminalSandbox({ missing: ['nowhere'] });
  const events = [], published = [];
  const result = await runLocalSetup({ sandbox: f.sandbox, auth: {}, environment: { values: {}, removed: [] }, discover: async () => ({ components: [] }),
    onEvent: (event) => events.push(event), onReady: (value) => published.push(value),
    checkPreview: () => assert.fail('a terminal has no preview to check'),
    runAgent: async ({ bridge }) => {
      const call = toolCall(bridge);
      assert.equal((await call('declare_kind', { kind: 'terminal', reason: 'A Python CLI with no server' })).isError, undefined);
      assert.match((await call('terminal_ready', { cwd: '.', hint: 'python main.py --help' })).content[0].text, /Dependency installation has not succeeded/);
      await call('dependency_install', { action: 'skip', reason: 'Fixture has no dependencies' });
      assert.match((await call('terminal_ready', { cwd: 'nowhere', hint: 'ls' })).content[0].text, /not a directory/);
      const ready = JSON.parse((await call('terminal_ready', { cwd: '.', hint: 'python main.py --help' })).content[0].text);
      assert.equal(ready.ready, true);
      assert.equal(published.length, 1, 'ready before Claude\'s final message');
      assert.match((await call('run_command', { command: 'ls' })).content[0].text, /already verified/, 'setup is closed once ready');
    } });
  assert.deepEqual(result, { kind: 'terminal', reason: 'A Python CLI with no server', terminal: { cwd: '.', hint: 'python main.py --help' } });
  assert.deepEqual(published, [result]);
  assert.ok(!f.commands.some((command) => /--local|proxy\.mjs/.test(command)), 'nothing was launched');
  assert.equal(f.files.has('/home/user/.engelbart-canvas/recipe.json'), false, 'no launch plan to replay');
  assert.ok(events.some((event) => event.phase === 'kind' && event.kind === 'terminal' && /from a terminal: A Python CLI/.test(event.message)));
  assert.ok(events.some((event) => event.phase === 'terminal' && event.status === 'ready' && event.hint === 'python main.py --help'));
  assert.equal(events.filter((event) => event.phase === 'agent').at(-1).message, 'Setup agent finished · terminal ready');
});

test('both is ready only with the verified preview and the terminal, in either order', async () => {
  for (const order of [['start_app', 'terminal_ready'], ['terminal_ready', 'start_app']]) {
    const f = terminalSandbox();
    const published = [];
    let checks = 0;
    const result = await runLocalSetup({ sandbox: f.sandbox, auth: {}, environment: { values: {}, removed: [] }, discover: async () => ({ components: [] }),
      onEvent() {}, onReady: (value) => published.push(value), checkPreview: async () => { checks++; return true; },
      runAgent: async ({ bridge }) => {
        const call = toolCall(bridge);
        await call('declare_kind', { kind: 'both', reason: 'A web UI and a CLI' });
        await call('dependency_install', { action: 'skip', reason: 'Fixture' });
        const args = { start_app: { command: 'npm start', port: 3000 }, terminal_ready: { cwd: '.', hint: 'npx tool --help' } };
        const first = JSON.parse((await call(order[0], args[order[0]])).content[0].text);
        assert.equal(first.ready, false, `${order[0]} alone is not ready`);
        assert.match(first.next, order[0] === 'start_app' ? /terminal_ready/ : /start_app/);
        assert.equal(published.length, 0);
        assert.equal(JSON.parse((await call(order[1], args[order[1]])).content[0].text).ready, true);
      } });
    assert.equal(result.kind, 'both');
    assert.equal(result.preview_url, 'https://preview.example/');
    assert.deepEqual(result.terminal, { cwd: '.', hint: 'npx tool --help' });
    assert.equal(typeof result.done?.then, 'function', 'the app is still watched');
    assert.equal(published.length, 1);
    assert.equal(checks, 1);
  }
  const f = terminalSandbox();
  await assert.rejects(runLocalSetup({ sandbox: f.sandbox, auth: {}, environment: { values: {}, removed: [] }, discover: async () => ({ components: [] }),
    onEvent() {}, checkPreview: async () => true, runAgent: async ({ bridge }) => {
      await toolCall(bridge)('declare_kind', { kind: 'both', reason: 'A web UI and a CLI' });
      await toolCall(bridge)('dependency_install', { action: 'skip', reason: 'Fixture' });
      await toolCall(bridge)('start_app', { command: 'npm start', port: 3000 });
    } }), /^Error: Claude finished without making the terminal ready\.$/);
});
