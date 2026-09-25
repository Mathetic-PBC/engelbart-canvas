'use strict';

// Authentication stays in the installed, unmodified Claude Code CLI. Never read
// its credential files or keychain, and never send its environment to E2B.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveShell } = require('../terminal/launch.cjs');
const execute = promisify(execFile);

function subscriptionEnvironment(source = process.env) {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'CLAUDE_CONFIG_DIR'];
  return Object.fromEntries(allowed.filter((key) => typeof source[key] === 'string').map((key) => [key, source[key]]));
}

function subscriptionStatus(status) {
  return status?.loggedIn === true && status.authMethod === 'claude.ai'
    && status.apiProvider === 'firstParty' && typeof status.subscriptionType === 'string'
    && /^(pro|max|team|enterprise)$/i.test(status.subscriptionType);
}

async function prepareLocalClaude(source = process.env, run = execute) {
  const env = subscriptionEnvironment(source);
  const shell = resolveShell(env);
  // Resolve through the same login shell as the terminal, then invoke the binary
  // directly. Shell startup cannot reintroduce API keys into the Claude process.
  const fish = path.basename(shell) === 'fish';
  const query = fish ? 'command -s claude' : path.basename(shell) === 'bash' ? 'type -P claude' : 'whence -p claude';
  let file;
  try {
    const { stdout } = await run(shell, fish ? ['--login', '--interactive', '--command', query] : ['-ilc', query], { env, cwd: os.tmpdir(), timeout: 15_000, maxBuffer: 64_000 });
    file = stdout.trim().split(/\r?\n/).findLast((line) => path.isAbsolute(line.trim()))?.trim();
    if (!file || !fs.statSync(file).isFile()) throw new Error('missing');
    const { stdout: version } = await run(file, ['--version'], { env, timeout: 15_000, maxBuffer: 64_000 });
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match || (Number(match[1]) < 2 || (Number(match[1]) === 2 && (Number(match[2]) < 1 || (Number(match[2]) === 1 && Number(match[3]) < 248))))) {
      throw new Error('version');
    }
  } catch (error) {
    throw new Error(error.message === 'version' ? 'Update Claude Code to 2.1.248 or newer for restricted sandbox setup.' : 'Claude Code was not found on your login shell PATH. Install it and sign in from the Canvas terminal.');
  }
  try {
    const { stdout } = await run(file, ['auth', 'status', '--json'], { env, cwd: os.tmpdir(), timeout: 15_000, maxBuffer: 64_000 });
    if (!subscriptionStatus(JSON.parse(stdout))) throw new Error('not subscription');
  } catch {
    throw new Error('Sign in to your Claude subscription using Claude Code in the Canvas terminal.');
  }
  return { file, env };
}

function claudeArguments(config, model = 'sonnet') {
  if (!/^[a-zA-Z0-9._:-]{1,100}$/.test(model)) throw new Error('Invalid local Claude model');
  return ['-p', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--restricted', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config', '--mcp-config', config, '--tools', '',
    '--allowedTools', 'mcp__canvas__*', '--permission-mode', 'dontAsk',
    '--model', model, '--max-turns', '32'];
}

async function runLocalClaude({ auth, bridge, prompt, model, signal, onMessage = () => {}, spawnProcess = spawn }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-claude-setup-'));
  fs.chmodSync(directory, 0o700);
  const config = path.join(directory, 'mcp.json');
  const connection = path.join(directory, 'bridge.json');
  fs.writeFileSync(connection, JSON.stringify(bridge), { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { canvas: {
    command: process.execPath, args: [path.join(__dirname, 'local-mcp.cjs'), connection],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  } } }), { mode: 0o600 });
  let child, killTimer, abort;
  try {
    signal?.throwIfAborted();
    child = spawnProcess(auth.file, claudeArguments(config, model), {
      cwd: directory, env: { ...auth.env, MCP_TOOL_TIMEOUT: '240000' },
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const kill = (sig) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
    };
    abort = () => { if (killTimer) return; kill('SIGTERM'); killTimer = setTimeout(() => kill('SIGKILL'), 3000); };
    signal?.addEventListener('abort', abort, { once: true });
    let buffer = '', result, failure;
    const consume = (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'system' && event.subtype === 'init') {
        if (!event.mcp_servers?.some((server) => server.name === 'canvas' && server.status === 'connected') || event.mcp_server_errors?.length) {
          failure = 'Claude could not connect to the sandbox tools.';
          abort();
        }
      }
      if (event.type === 'assistant') {
        for (const block of event.message?.content || []) {
          if (block.type === 'text') onMessage(block.text);
        }
      }
      if (event.type === 'result') result = event;
    };
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 2_000_000) { failure = 'Claude output exceeded its size limit.'; abort(); return; }
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); consume(line); }
    });
    // Do not persist raw CLI diagnostics: they can contain account/configuration details.
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    signal?.removeEventListener('abort', abort);
    if (buffer.trim()) consume(buffer);
    signal?.throwIfAborted();
    if (failure) throw new Error(failure);
    if (code !== 0 || !result || result.is_error || result.subtype !== 'success') {
      const reason = String(result?.result || result?.subtype || 'Claude Code exited without a result').slice(0, 800);
      throw new Error(`Local Claude setup did not finish: ${reason}. Check your subscription sign-in and usage limits in the Canvas terminal.`);
    }
  } finally {
    if (abort) signal?.removeEventListener('abort', abort);
    clearTimeout(killTimer);
    // Only the two files created above, and then this task-owned empty directory.
    for (const file of [config, connection]) { try { fs.unlinkSync(file); } catch {} }
    try { fs.rmdirSync(directory); } catch { /* CLI may have left a diagnostic; do not recursively remove it. */ }
  }
}

module.exports = { subscriptionEnvironment, subscriptionStatus, prepareLocalClaude, claudeArguments, runLocalClaude };
