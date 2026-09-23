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
  { name: 'start_app', description: 'Save a reusable launch command, start the web app in E2B, and independently check its live preview. Replaces a previous attempted app. Command must stay in the foreground and start the server (not install dependencies). Bind to 0.0.0.0 or 127.0.0.1. On failure, inspect logs and fix the app before retrying.', inputSchema: schema({ command: text, cwd: text, port: { type: 'integer', minimum: 1024, maximum: 65535 }, path: text }, ['command', 'port']) },
  { name: 'list_files', description: 'List repository files/directories without executing repository code. Available while dependencies install. Omits generated dependency/build directories and bounds the listing.', inputSchema: schema({ path: text }, []) },
  { name: 'dependency_install', description: 'Control the worker-owned dependency job in E2B. start runs command in cwd asynchronously, first stopping and confirming any previous job; use it for initial/custom installs or retries (up to 600 seconds). status returns outcome and log tail; optional wait_seconds (up to 180) waits without busy polling. stop confirms its process tree is gone before edits. skip requires a reason after verifying dependencies already exist or no install is needed. Continue read-only inspection/planning while running; wait for success before build/start.', inputSchema: schema({ action: { type: 'string', enum: ['start', 'status', 'stop', 'skip'] }, command: text, cwd: text,
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
    if (type.enum && !type.enum.includes(value)) throw new Error(`Invalid ${key}`);
  }
  if ('cwd' in args) repoPath(args.cwd);
  if (name.endsWith('_file')) repoPath(args.path);
  if (name === 'list_files') repoPath(args.path);
  if ('command' in args && !args.command.trim()) throw new Error('Command is empty');
  if (name === 'dependency_install') {
    const allowed = { start: ['action', 'command', 'cwd', 'timeout_seconds'], status: ['action', 'wait_seconds'], stop: ['action'], skip: ['action', 'reason'] }[args.action];
    if (Object.keys(args).some((key) => !allowed.includes(key)) || (args.action === 'start' && !args.command) || (args.action === 'skip' && !args.reason?.trim())) throw new Error('Invalid dependency install action');
  }
  if (name === 'start_app') {
    if (args.port === 43110) throw new Error('Port 43110 is reserved for the preview proxy');
    if (args.path !== undefined && (!args.path.startsWith('/') || args.path.startsWith('//') || /[\r\n\\]/.test(args.path))) throw new Error('Invalid preview path');
  }
  return args;
}

function createSandboxTools({ sandbox, startApp, install, onEvent, signal, secrets = [], environment = {} }) {
  const emit = (event) => { if (!signal?.aborted) onEvent(redact(event, secrets)); };
  let chain = Promise.resolve();
  let closed = false;
  const perform = async (name, raw) => {
    if (closed) throw new Error('Sandbox tools are closed');
    signal?.throwIfAborted();
    const args = validateTool(name, raw);
    if (name === 'dependency_install') return install.control(args);
    if (name === 'list_files') return install.list(args.path);
    if (name === 'start_app') { install?.assertReady(); return startApp(args); }
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
      emit({ phase: 'setup', status: 'working', message: `Updated ${args.path} in sandbox` });
      return { written: args.path };
    }
    install?.assertIdle();
    emit({ phase: 'stage', stage: 'setup', status: 'running', command: args.command });
    let output = '';
    const receive = (stream) => (chunk) => {
      const safe = redactOutput(chunk, secrets);
      output = (output + safe).slice(-32_000);
      emit({ phase: 'log', stream, text: safe.slice(-2000) });
    };
    try {
      const result = await sandbox.commands.run(`cd ${quote(repoPath(args.cwd))} && ${args.command}`, {
        timeoutMs: (args.timeout_seconds || 120) * 1000,
        // Aborting the SDK stream does not prove the remote process stopped.
        // Mark tool processes so the fallback handoff can stop their trees too.
        envs: { ...environment, ENGELBART_CANVAS_LOCAL_TOOL: '1' }, signal,
        onStdout: receive('stdout'), onStderr: receive('stderr'),
      });
      signal?.throwIfAborted();
      return { exitCode: result.exitCode, output };
    } catch (error) {
      signal?.throwIfAborted();
      return { exitCode: Number.isInteger(error.exitCode) ? error.exitCode : null, error: redact(String(error.message).slice(-2000), secrets), output };
    }
  };
  // A start must not race an install, file write, or another start.
  const call = (name, args) => {
    if (closed) return Promise.reject(new Error('Sandbox tools are closed'));
    const result = chain.then(() => perform(name, args));
    chain = result.catch(() => {});
    return result;
  };
  // A provider handoff must not race an unfinished local tool or queued write.
  call.close = async () => { closed = true; await chain; };
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
      reply(200, { isError: true, content: [{ type: 'text', text: redact(String(error.message).slice(-2000), secrets) }] });
    }
  });
  server.requestTimeout = 240_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { connection: { url: `http://127.0.0.1:${server.address().port}/tools`, token },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}

module.exports = { ROOT, quote, TOOL_DEFINITIONS, repoPath, validateTool, createSandboxTools, openToolBridge };
