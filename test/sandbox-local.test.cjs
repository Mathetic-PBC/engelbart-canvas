'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { subscriptionEnvironment, subscriptionStatus, claudeArguments, runLocalClaude } = require('../src/main/sandbox/local-claude.cjs');
const { ROOT, repoPath, validateTool, createSandboxTools, openToolBridge } = require('../src/main/sandbox/local-tools.cjs');
const { runLocalSetup } = require('../src/main/sandbox/local-setup.cjs');
const { createRuntime } = require('../src/main/sandbox/worker.cjs');

test('subscription environment excludes every API, OAuth, parent-session and Electron credential', () => {
  const source = { HOME: '/users/test', SHELL: '/bin/zsh', PATH: '/bin', CLAUDE_CONFIG_DIR: '/users/test/.claude', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDECODE: '1', E2B_API_KEY: 'secret', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect' };
  assert.deepEqual(subscriptionEnvironment(source), { HOME: '/users/test', SHELL: '/bin/zsh', PATH: '/bin', CLAUDE_CONFIG_DIR: '/users/test/.claude' });
  assert.equal(subscriptionStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), true);
  for (const status of [{}, { loggedIn: true }, { loggedIn: true, authMethod: 'api_key' }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock', subscriptionType: 'max' }]) assert.equal(subscriptionStatus(status), false);
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
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    const config = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1]));
    assert.equal(config.mcpServers.canvas.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(fs.statSync(config.mcpServers.canvas.args[1]).mode & 0o777, 0o600);
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
      assert.equal(options.envs.ENGELBART_CANVAS_LOCAL_TOOL, '1');
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
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['run_command', 'read_file', 'write_file', 'start_app', 'list_files', 'dependency_install']);
    const result = await client.callTool({ name: 'read_file', arguments: { path: 'package.json' } });
    assert.equal(JSON.parse(result.content[0].text).content, 'fixture');
  } finally { await client.close(); await bridge.close(); fs.unlinkSync(config); fs.rmdirSync(directory); }
});

test('local setup prompt overlaps managed installation with inspection and requires the actual result', async () => {
  let prompt;
  await assert.rejects(runLocalSetup({ sandbox: { files: { write: async () => {} }, commands: { run: async () => ({ exitCode: 0, stdout: '{}' }) } }, auth: {}, environment: { values: {}, removed: [] },
    onEvent() {}, checkPreview: async () => true, runAgent: async (input) => { prompt = input.prompt; },
  }), /without a verified web preview/);
  assert.match(prompt, /Work IN PARALLEL with installation/);
  assert.match(prompt, /read_file and list_files.*while the job runs/);
  assert.match(prompt, /Do not wait for installation before doing this preparation/);
  assert.match(prompt, /always check its actual result before building or starting/);
  assert.match(prompt, /status with wait_seconds=180/);
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
  assert.match(prompt, /never overlaps two installs/);
  assert.doesNotMatch(prompt, /Keep installation in the foreground/);
  assert.match(prompt, /Never request, print or search for credentials/);
  assert.match(prompt, /stop before the operation that needs them rather than fabricate them/);
  assert.match(prompt, /Do not claim success without a successful start_app/);
});

test('local setup requires actual start_app, saves restart plan, checks preview, and does not pass Claude auth to E2B', async () => {
  const commands = [], files = new Map(), events = [];
  const sandbox = { getHost: () => 'preview.example', files: { write: async (file, value) => files.set(file, value) }, commands: { run: async (command, options) => {
    commands.push({ command, options });
    assert.equal(options.envs?.ANTHROPIC_API_KEY, undefined);
    if (command.includes('--local')) {
      options.onStdout('{"phase":"log","stream":"stdout","text":"app log"}\n{"phase":"ready","port":3000}\n');
      return { wait: () => new Promise(() => {}) };
    }
    return { exitCode: 0 };
  } } };
  const args = { sandbox, auth: { file: 'claude', env: {} }, environment: { values: { APP_KEY: 'app-value' }, removed: [] }, signal: new AbortController().signal, onEvent: (event) => events.push(event), checkPreview: async (url) => { assert.equal(url, 'https://preview.example/'); return true; } };
  await assert.rejects(runLocalSetup({ ...args, runAgent: async () => {} }), /without a verified/);
  const result = await runLocalSetup({ ...args, runAgent: async ({ bridge }) => {
    const skipped = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: 'dependency_install', args: { action: 'skip', reason: 'Fixture app has no dependencies.' } }) });
    assert.equal((await skipped.json()).isError, undefined);
    const response = await fetch(bridge.url, { method: 'POST', headers: { authorization: `Bearer ${bridge.token}` }, body: JSON.stringify({ name: 'start_app', args: { command: 'npm start', port: 3000 } }) });
    assert.equal((await response.json()).isError, undefined);
  } });
  assert.equal(result.preview_url, 'https://preview.example/');
  assert.equal(JSON.parse(files.get('/home/user/.engelbart-canvas/recipe.json')).kind, 'claude-local');
  assert.ok(events.some((event) => event.text === 'app log'));
  assert.ok(commands.some(({ command }) => command.includes('proxy.mjs')));
});

test('explicit claude-local checks subscription before provisioning and never falls back to API mode', async () => {
  const events = [];
  const runtime = createRuntime({ Sandbox: { create: () => assert.fail('must not create sandbox') }, env: { E2B_API_KEY: 'e2b-test', ANTHROPIC_API_KEY: 'should-not-be-used', ENGELBART_SANDBOX_SETUP: 'claude-local' },
    prepareClaude: async () => { throw new Error('Subscription signed out'); }, emit: (event) => events.push(event) });
  await runtime.run({ run_id: 'local-test', github_url: 'https://github.com/owner/repo' });
  assert.equal(events.at(-1).event, 'failed');
  assert.equal(events.at(-1).error, 'Subscription signed out');
});

test('worker integrates subscription setup with normal ready/log/stop events without an Anthropic key', async () => {
  const events = [], commands = [];
  let kills = 0, finish;
  const done = new Promise((resolve) => { finish = resolve; });
  const sandbox = { sandboxId: 'local-sandbox', files: { write: async () => {} }, kill: async () => { kills++; finish(); }, commands: { run: async (command) => { commands.push(command); return { exitCode: 0 }; } } };
  const runtime = createRuntime({ Sandbox: { create: async () => sandbox }, env: { E2B_API_KEY: 'e2b-test', ENGELBART_SANDBOX_SETUP: 'claude-local' },
    prepareClaude: async () => ({ file: 'claude', env: {} }), detectDocker: async () => false,
    localSetup: async ({ onEvent }) => { onEvent({ phase: 'stage', command: 'npm ci' }); return { preview_url: 'https://preview.example/', port: 3000, done }; },
    emit: (event) => { events.push(event); if (event.event === 'ready') finish(); } });
  await runtime.run({ run_id: 'local-test', github_url: 'https://github.com/owner/repo' });
  assert.deepEqual(events.filter((event) => event.event !== 'progress').map((event) => event.event), ['sandbox_created', 'ready', 'stopped']);
  assert.equal(kills, 1);
  assert.ok(!commands.some((command) => /python3 -u/.test(command)), 'API pipeline must not run');
  assert.ok(events.some((event) => event.message === 'npm ci'));
});
