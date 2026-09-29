'use strict';

const http = require('node:http');
const path = require('node:path').posix;
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { redact, redactOutput } = require('./environment.cjs');
const ROOT = '/home/user/repository';
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const text = { type: 'string' };
const TOOL_DEFINITIONS = [
  { name: 'run_command', description: 'Run a foreground command ONLY in the assigned E2B Linux sandbox. Blocked while dependency installation is active: use read_file/list_files for concurrent inspection. Use dependency_install for installs and start_app for the web server; never background either here.', inputSchema: schema({ command: text, cwd: text, timeout_seconds: { type: 'integer', minimum: 1, maximum: 180 } }, ['command']) },
  { name: 'read_file', description: 'Read a UTF-8 file from the repository in E2B. Paths are relative to the repository root.', inputSchema: schema({ path: text }, ['path']) },
  { name: 'write_file', description: 'Write a UTF-8 file in the repository in E2B. No access to files on the Mac.', inputSchema: schema({ path: text, content: text }, ['path', 'content']) },
  { name: 'start_app', description: 'Save a reusable launch command, start the web app in E2B, and independently check its live preview. When the launch recipe is ready during installation, call with wait_for_install:true now: waits up to 30 seconds for confirmed install success, then launches directly without another agent turn. Failed, stopped or still-running installs never launch; an expired wait leaves no queued launch. Stops and confirms the previous owned attempt before replacing it; never kills an unrelated port owner. Command must stay in the foreground and start the server (not install dependencies). On failure, inspect returned app state/failed_check or call app_status before changing anything. Never diagnose by launching another server via run_command.', inputSchema: schema({ command: text, cwd: text, port: { type: 'integer', minimum: 1024, maximum: 65535 }, path: text, wait_for_install: { type: 'boolean' } }, ['command', 'port']) },
  { name: 'app_status', description: 'Read fresh worker-owned application state: living processes, listener ports/addresses/ownership, the local HTTP check, and recent output. Optionally inspect ownership of a particular port, including a backend or a conflict. A running process is NOT proof of a healthy preview. Safe during installs; does not start or stop anything. Other tool replies also include the latest observed app state and bounded state changes.', inputSchema: schema({ port: { type: 'integer', minimum: 1024, maximum: 65535 } }, []) },
  { name: 'stop_app', description: 'Stop only the current managed application and confirm its descendants are gone. Keeps the sandbox and installed files. Use before intentional app changes; never use broad pkill or launch a duplicate server to inspect it.', inputSchema: schema({}, []) },
  { name: 'list_files', description: 'List repository files/directories without executing repository code. Available while dependencies install. Omits generated dependency/build directories and bounds the listing.', inputSchema: schema({ path: text }, []) },
  { name: 'dependency_install', description: 'Control the worker-owned dependency job in E2B. start runs command in cwd asynchronously, first stopping and confirming any previous job. For independent npm frontend + Python backend directories, instead provide parallel: [{manager:"npm",cwd:"frontend"},{manager:"pip",cwd:"backend"}]. This validates independence, runs npm ci and a requirements.txt install in a new backend .venv concurrently, and succeeds only when BOTH succeed. Shared workspaces, linked dependencies or custom setup must use sequential command jobs. npm audit is deferred until preview readiness; do not enable inline auditing. status returns outcome and log tail; optional wait_seconds (up to 180) waits without busy polling. stop confirms the whole process tree is gone before edits. skip requires a reason after verifying dependencies already exist or no install is needed. Continue read-only inspection/planning while running; wait for success before build/start.', inputSchema: schema({ action: { type: 'string', enum: ['start', 'status', 'stop', 'skip'] }, command: text, cwd: text,
    parallel: { type: 'array', minItems: 2, maxItems: 2, items: schema({ manager: { type: 'string', enum: ['npm', 'pip'] }, cwd: text }, ['manager', 'cwd']) },
    timeout_seconds: { type: 'integer', minimum: 1, maximum: 600 }, wait_seconds: { type: 'integer', minimum: 0, maximum: 180 }, reason: text }, ['action']) },
];

function repoPath(value = '.') {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw new Error('Invalid repository path');
  const resolved = path.resolve(ROOT, value);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}/`)) throw new Error('Path must be inside the sandbox repository');
  return resolved;
}
function validateTool(name, args) {
  const tool = TOOL_DEFINITIONS.find((entry) => entry.name === name);
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Unknown sandbox tool');
  const { properties, required } = tool.inputSchema;
  if (required.some((key) => !Object.hasOwn(args, key)) || Object.keys(args).some((key) => !Object.hasOwn(properties, key))) throw new Error('Invalid tool arguments');
  for (const [key, value] of Object.entries(args)) {
    const type = properties[key];
    if (type.type === 'string' && (typeof value !== 'string' || value.includes('\0') || value.length > (key === 'content' ? 64_000 : 8000))) throw new Error(`Invalid ${key}`);
    if (type.type === 'integer' && (!Number.isInteger(value) || value < type.minimum || value > type.maximum)) throw new Error(`Invalid ${key}`);
    if (type.type === 'boolean' && typeof value !== 'boolean') throw new Error(`Invalid ${key}`);
    if (type.enum && !type.enum.includes(value)) throw new Error(`Invalid ${key}`);
  }
  if ('cwd' in args) repoPath(args.cwd);
  if (name.endsWith('_file')) repoPath(args.path);
  if (name === 'list_files') repoPath(args.path);
  if ('command' in args && !args.command.trim()) throw new Error('Command is empty');
  if (name === 'dependency_install') {
    const allowed = { start: ['action', 'command', 'cwd', 'parallel', 'timeout_seconds'], status: ['action', 'wait_seconds'], stop: ['action'], skip: ['action', 'reason'] }[args.action];
    if (Object.keys(args).some((key) => !allowed.includes(key)) || (args.action === 'start' && !args.command && !args.parallel) || (args.action === 'skip' && !args.reason?.trim())) throw new Error('Invalid dependency install action');
    if ('parallel' in args) {
      if ('command' in args || 'cwd' in args || !Array.isArray(args.parallel) || args.parallel.length !== 2 ||
          args.parallel.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
            Object.keys(item).some((key) => !['manager', 'cwd'].includes(key)) ||
            !['npm', 'pip'].includes(item.manager) || typeof item.cwd !== 'string') ||
          new Set(args.parallel.map((item) => item.manager)).size !== 2) throw new Error('Invalid parallel dependency install plan');
      args.parallel.forEach((item) => repoPath(item.cwd));
    }
  }
  if (name === 'start_app') {
    if (args.port === 43110) throw new Error('Port 43110 is reserved for the preview proxy');
    if (args.path !== undefined && (!args.path.startsWith('/') || args.path.startsWith('//') || /[\r\n\\]/.test(args.path))) throw new Error('Invalid preview path');
  }
  return args;
}

function createSandboxTools({ sandbox, startApp, appStatus, stopApp, appState, install, onEvent, signal, secrets = [], environment = {} }) {
  const emit = (event) => { if (!signal?.aborted) onEvent(redact(event, secrets)); };
  let chain = Promise.resolve();
  let closed = false;
  let verified = false;
  const perform = async (name, raw) => {
    if (closed) throw new Error('Sandbox tools are closed');
    signal?.throwIfAborted();
    const args = validateTool(name, raw);
    if (verified && !['app_status', 'list_files', 'read_file'].includes(name) &&
        !(name === 'dependency_install' && args.action === 'status')) {
      throw new Error('Preview is already verified and published. Setup mutations are closed; finish with a short summary.');
    }
    // Record activity, not file contents, tool arguments, or private CLI diagnostics.
    const activity = {
      read_file: `Reading ${args.path}`, list_files: `Listing ${args.path || '.'}`,
      write_file: `Updating ${args.path}`, run_command: 'Running a setup command',
      start_app: 'Requesting application launch', app_status: 'Checking application processes and listeners',
      stop_app: 'Stopping the owned application', dependency_install: `Dependency install · ${args.action}`,
    }[name];
    emit({ phase: 'agent', status: 'working', tool: name, message: activity });
    if (name === 'app_status') return appStatus(args);
    if (name === 'stop_app') return stopApp();
    if (name === 'dependency_install') return install.control(args);
    if (name === 'list_files') return install.list(args.path);
    if (name === 'start_app') {
      const { wait_for_install, ...recipe } = args;
      if (wait_for_install && ['starting', 'running'].includes(install?.status().status)) {
        await install.control({ action: 'status', wait_seconds: 30 });
        signal?.throwIfAborted();
        if (closed) throw new Error('Sandbox tools are closed; no app was started');
        if (['starting', 'running'].includes(install.status().status)) {
          throw new Error('Dependency installation is still running; no app was started or queued. Wait for its result, then retry start_app.');
        }
      }
      install?.assertReady();
      return startApp(recipe);
    }
    if (name === 'read_file') {
      const stream = await sandbox.files.read(repoPath(args.path), { format: 'stream', signal, requestTimeoutMs: 15_000 });
      const reader = stream.getReader();
      const chunks = [];
      let size = 0;
      try {
        while (size <= 64_000) {
          signal?.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          const part = value.subarray(0, 64_001 - size);
          chunks.push(part); size += part.length;
        }
      } finally { await reader.cancel(); }
      const data = Buffer.concat(chunks).subarray(0, 64_000).toString('utf8');
      return { content: redact(data, secrets), truncated: size > 64_000 };
    }
    if (name === 'write_file') {
      install?.assertIdle();
      await sandbox.files.write(repoPath(args.path), args.content);
      emit({ phase: 'agent', status: 'working', message: `Updated ${args.path} in sandbox` });
      return { written: args.path };
    }
    install?.assertIdle();
    // A guardrail for the common accidental bypasses, not a shell security
    // boundary. start_app is the only supported long-running server launcher.
    if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b|\b(?:concurrently|nodemon|pkill|killall)\b|(?:^|[;|&\n]\s*)\s*(?:vite|kill)\b/.test(args.command)) {
      throw new Error('Use app_status to inspect the existing app, stop_app to stop owned processes, and start_app to launch it. Do not start duplicate servers or kill processes through run_command.');
    }
    emit({ phase: 'stage', stage: 'setup', actor: 'setup-agent', status: 'running', command: args.command });
    let output = '';
    const receive = (stream) => (chunk) => {
      const safe = redactOutput(chunk, secrets);
      output = (output + safe).slice(-32_000);
      emit({ phase: 'log', actor: 'setup-agent', stream, text: safe.slice(-2000) });
    };
    try {
      const result = await sandbox.commands.run(`cd ${quote(repoPath(args.cwd))} && ${args.command}`, {
        timeoutMs: (args.timeout_seconds || 120) * 1000,
        // Aborting the SDK stream does not prove the remote process stopped.
        // Mark tool processes so the fallback handoff can stop their trees too.
        envs: { ...environment, npm_config_audit: 'false', ENGELBART_CANVAS_LOCAL_TOOL: '1' }, signal,
        onStdout: receive('stdout'), onStderr: receive('stderr'),
      });
      signal?.throwIfAborted();
      emit({ phase: 'agent', status: 'working', tool: name, tool_status: result.exitCode === 0 ? 'done' : 'failed',
        message: `Setup command exited with code ${result.exitCode}` });
      return { exitCode: result.exitCode, output };
    } catch (error) {
      signal?.throwIfAborted();
      emit({ phase: 'agent', status: 'working', tool: name, tool_status: 'failed',
        message: `Setup command failed: ${String(error.message).slice(-2000)}` });
      return { exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null, error: redact(String(error.message).slice(-2000), secrets), output };
    }
  };
  const observedState = () => {
    const state = { ...appState?.() };
    if (install) {
      // Keep replies small: the full log tail is available through action=status.
      // Sample after the operation so a read can report an install that just ended.
      const { id, status, started_at, finished_at, exitCode, error, reason } = install.status();
      state.dependency_install = { id, status, started_at, finished_at, exitCode, error, reason };
    }
    return state;
  };
  // A start must not race an install, file write, or another start.
  const call = (name, args) => {
    if (closed) return Promise.reject(new Error('Sandbox tools are closed'));
    const result = chain.then(() => perform(name, args)).then((value) => {
      return appState || install ? { ...value, ...observedState() } : value;
    }, (error) => {
      emit({ phase: 'agent', status: 'working', tool: name, tool_status: 'failed',
        message: `${name}: ${String(error.message).slice(-2000)}` });
      Object.assign(error, observedState());
      throw error;
    });
    chain = result.catch(() => {});
    return result;
  };
  // A provider handoff must not race an unfinished local tool or queued write.
  call.close = async () => { closed = true; await chain; };
  // Fence queued as well as future mutations before the live URL is published.
  call.freeze = () => { verified = true; };
  return call;
}

async function openToolBridge(callTool, { secrets = [], signal } = {}) {
  signal?.throwIfAborted();
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (req.method !== 'POST' || req.url !== '/tools' || req.headers.origin || req.headers.host !== `127.0.0.1:${server.address()?.port}` || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      req.resume(); reply(403, { error: 'Forbidden' }); return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 128_000) { reply(413, { error: 'Request too large' }); return; }
      }
      signal?.throwIfAborted();
      const { name, args } = JSON.parse(body);
      const value = await callTool(name, args);
      reply(200, { content: [{ type: 'text', text: JSON.stringify(redact(value, secrets)) }] });
    } catch (error) {
      const details = error.app || error.dependency_install ? JSON.stringify({ error: String(error.message).slice(-2000), app: error.app,
        app_changes: error.app_changes, failed_check: error.failed_check, dependency_install: error.dependency_install }) : String(error.message).slice(-2000);
      reply(200, { isError: true, content: [{ type: 'text', text: redact(details, secrets) }] });
    }
  });
  server.requestTimeout = 240_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { connection: { url: `http://127.0.0.1:${server.address().port}/tools`, token },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

module.exports = { ROOT, quote, TOOL_DEFINITIONS, repoPath, validateTool, createSandboxTools, openToolBridge };
