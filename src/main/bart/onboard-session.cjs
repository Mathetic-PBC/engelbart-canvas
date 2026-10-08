'use strict';

// Onboarding's one CLI session (2026-10-07, onboarding as brainstorm cards): started when onboarding opens and used for
// every card after it, so no card waits on a cold start. Claude Code runs as one long-lived process reading its turns as
// stream-json on stdin (`--input-format stream-json`): each card's turn is one more user message to a process that is
// already up, its answer streamed back as text deltas, and a warm reflection takes one to two seconds (measured
// 2026-10-07, Sonnet 5.5 medium: 0.7–2.0 s to the first words). Codex has no streaming input, so there each turn is
// `codex exec resume` of the session the first turn made, and its line arrives whole.
//
// The first turn is a warm-up that asks for one word: the process is up, the system prompt is cached, and the first card
// meets a warm session. A turn that fails, or a process that dies, leaves nothing half done: the next turn starts it again.
// Each card's message carries every answer so far (./onboard.cjs), so a new process loses nothing but its warmth.
//
// It runs as @bart does (./ask.cjs): hidden, through the login shell, on the person's subscription (an API key is never
// used), in a private folder. No tools at all, and Claude Code keeps no session file (`--no-session-persistence`).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnProcess, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome } = require('../context/summarizer.cjs');

const WARM_MESSAGE = 'Reply with the one word: ready';
const TURN_TIMEOUT_MS = 45_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class SessionError extends Error {
  constructor(message) { super(message); this.name = 'SessionError'; }
}

/** One line of Claude Code's stream-json → { delta } (text as it arrives), { result, error } (the turn's end), or null. */
function claudeEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'stream_event' && event.event && event.event.type === 'content_block_delta' && event.event.delta && event.event.delta.type === 'text_delta') return { delta: String(event.event.delta.text || '') };
  if (event.type === 'result') return { result: typeof event.result === 'string' ? event.result : '', error: !!event.is_error || typeof event.result !== 'string' };
  return null;
}

/**
 * `step`: { provider: 'anthropic' | 'openai', model (the CLI's id), effort }. `system`: the instructions. `spawn` and `run`
 * (execFile's shape) are for tests. `tools` (../tools/manager.cjs, optional): a CLI the login shell's PATH misses is run by
 * the full path the tool check found, and Engelbart's own Git stands in as it does for @bart.
 */
function createWarmSession({ step, system, runDirectory = path.join(os.tmpdir(), 'engelbart-onboarding-runs'), environment = process.env, tools = null, codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-onboarding'), codexAuthFile, spawn = spawnProcess, run = execFile, timeoutMs = TURN_TIMEOUT_MS } = {}) {
  const shell = resolveShell(environment);
  const name = step.provider === 'openai' ? 'codex' : 'claude';
  const program = tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name;
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...(tools && tools.environment ? tools.environment() : {}), ...(tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {}), ...extra };
  };
  fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
  const stem = path.join(runDirectory, `onboarding-${randomUUID()}`);
  let closed = false;
  let queue = Promise.resolve();
  // One turn at a time, in the order asked: a card's turn waits for the one before it.
  const serial = (fn) => { const next = queue.then(fn, fn); queue = next.catch(() => {}); return next; };

  /* ------------------------------------------------------------ Claude Code */
  let child = null; // the running process, while it lives
  let current = null; // the turn it is answering: { text, onDelta, resolve, reject, timer }
  const end = (failure) => {
    const turn = current;
    current = null;
    if (!turn) return;
    clearTimeout(turn.timer);
    if (failure) turn.reject(failure); else turn.resolve(turn.text);
  };
  function startClaude() {
    const promptFile = `${stem}.system.md`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    const command = `exec ${program} -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --no-session-persistence --restricted --setting-sources "" --strict-mcp-config --tools "" --model "$ENGELBART_ONBOARD_MODEL" --effort ${step.effort} --system-prompt-file "$ENGELBART_ONBOARD_PROMPT"`;
    const env = childEnvironment({ ENGELBART_ONBOARD_MODEL: step.model, ENGELBART_ONBOARD_PROMPT: promptFile });
    const proc = spawn(shell, loginShellArgs(shell, command, env), { cwd: runDirectory, env, stdio: ['pipe', 'pipe', 'ignore'] });
    child = proc;
    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        const event = line.startsWith('{') ? claudeEvent(line) : null;
        if (!event || !current) continue;
        if (event.delta != null) { current.text += event.delta; try { if (current.onDelta) current.onDelta(current.text); } catch { /* a preview only */ } }
        else if (event.error || !event.result.trim()) end(new SessionError(String(event.result || 'The model returned no text.').slice(0, 300)));
        else { current.text = event.result; end(null); }
      }
    });
    const gone = (why) => { if (child === proc) child = null; end(new SessionError(why)); };
    proc.on('error', (error) => gone(`Claude Code could not start (${error.message}).`));
    proc.on('exit', (code) => gone(code === 127 ? 'Claude Code was not found on the login shell PATH.' : 'Claude Code stopped.'));
    if (proc.stdin) proc.stdin.on('error', () => {}); // a process gone mid-write is said by its exit
    return proc;
  }
  const claudeTurn = (message, onDelta) => new Promise((resolve, reject) => {
    if (closed) { reject(new SessionError('The session is closed.')); return; }
    const proc = child || startClaude();
    const timer = setTimeout(() => { end(new SessionError('The model took too long.')); try { proc.kill(); } catch { /* gone */ } }, timeoutMs);
    if (timer.unref) timer.unref();
    current = { text: '', onDelta, resolve, reject, timer };
    proc.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: message } })}\n`);
  });

  /* ------------------------------------------------------------------ Codex */
  let thread = null;
  const codexTurn = (message) => new Promise((resolve, reject) => {
    if (closed) { reject(new SessionError('The session is closed.')); return; }
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome, source, instructions: system })) { reject(new SessionError('Codex is not signed in with a ChatGPT account.')); return; }
    const input = `${stem}.input.txt`, out = `${stem}.out.txt`;
    fs.writeFileSync(input, message, { mode: 0o600 });
    try { fs.unlinkSync(out); } catch { /* none */ }
    const shared = `--skip-git-repo-check -m "$ENGELBART_ONBOARD_MODEL" -c 'model_reasoning_effort="${step.effort}"' -c 'sandbox_mode="read-only"' -c 'tools.web_search=false' -c project_doc_max_bytes=0 --json -o "$ENGELBART_ONBOARD_OUTPUT" - < "$ENGELBART_ONBOARD_INPUT"`;
    const command = thread ? `exec ${program} exec resume "$ENGELBART_ONBOARD_SESSION" ${shared}` : `exec ${program} exec --color never ${shared}`;
    const env = childEnvironment({ CODEX_HOME: codexHome, ENGELBART_ONBOARD_SESSION: thread || '', ENGELBART_ONBOARD_MODEL: step.model, ENGELBART_ONBOARD_OUTPUT: out, ENGELBART_ONBOARD_INPUT: input });
    run(shell, loginShellArgs(shell, command, env), { cwd: runDirectory, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch { text = ''; }
      for (const line of String(stdout || '').split(/\r?\n/)) {
        if (thread || !line.startsWith('{')) continue;
        try { const event = JSON.parse(line); if (event.type === 'thread.started' && UUID_RE.test(event.thread_id)) thread = event.thread_id; } catch { /* not an event */ }
      }
      if (text.trim()) resolve(text);
      else reject(new SessionError(error && (error.code === 127 || error.code === 'ENOENT') ? 'Codex was not found on the login shell PATH.' : 'Codex returned no message.'));
    });
  });

  const turn = (message, { onDelta } = {}) => serial(() => (name === 'claude' ? claudeTurn(message, onDelta) : codexTurn(message)));
  return {
    provider: step.provider,
    /** The warm-up: the process up and the instructions cached before the first card is answered. */
    warm: () => turn(WARM_MESSAGE),
    turn,
    alive: () => !closed && (name === 'claude' ? !!child : !!thread),
    close() {
      if (closed) return;
      closed = true;
      end(new SessionError('The session is closed.'));
      if (child) { try { child.stdin.end(); child.kill(); } catch { /* gone */ } child = null; }
      for (const file of ['system.md', 'input.txt', 'out.txt']) { try { fs.unlinkSync(`${stem}.${file}`); } catch { /* none */ } }
    },
  };
}

module.exports = { createWarmSession, claudeEvent, SessionError, WARM_MESSAGE, TURN_TIMEOUT_MS };
