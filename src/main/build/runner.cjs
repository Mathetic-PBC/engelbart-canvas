'use strict';

// One turn of a Build agent (2026-09-25; design B9-B12): Claude Code or Codex, hidden, on the person's subscription, in
// the Build's worktree, run exactly the way @bart runs them (../bart/ask.cjs: the login shell, every value through the
// environment, API keys removed, one process per turn, events read as they arrive by ../bart/activity.cjs) but able to
// write. What each may reach beyond its worktree is ./policy.cjs's. Flags checked on Claude Code 2.1.283 and codex-cli
// 0.157.0 (2026-09-25, in a scratch worktree): writes inside work and writes outside are refused; `exec resume` takes
// only -c, which is why Codex's sandbox and auto-review are set that way on every turn.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { pathLabeller, claudeUpdate, codexUpdate, eventReader } = require('../bart/activity.cjs');
const { claudeSettings } = require('./policy.cjs');

const CLAUDE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TurnError extends Error {
  constructor(kind, message, session = null) {
    super(message);
    this.name = 'TurnError';
    this.kind = kind; // 'unavailable' | 'failed' | 'stopped'
    this.session = session; // a turn stopped part way keeps its session, so the next one can go on with it
  }
}

function createRunner({ environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-build-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-build'), codexAuthFile, run = execFile, tools = null } = {}) {
  const shell = resolveShell(environment);
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const shellArgs = (command) => (path.basename(shell) === 'fish' ? ['--login', '--interactive', '--command', command] : ['-ilc', command]);
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...extra };
  };
  const execute = (command, cwd, env, { signal, timeoutMs, onEvent }) => new Promise((resolve) => {
    const child = run(shell, shellArgs(command), { cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, signal }, (error, out) => resolve({ stdout: out, failure: error }));
    if (onEvent && child && child.stdout) child.stdout.on('data', eventReader(onEvent));
  });
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');
  const timedOut = (failure) => !!(failure && failure.killed && failure.signal); // execFile's timeout kills with a signal; Stop is read from the AbortSignal first

  /**
   * One turn. `task` gives provider, modelId, effort, worktree; `session` is the session to go on with (null: a new one).
   * `system` is Build's prompt, `policy` ./policy.cjs's. → { text, session }; throws TurnError (a stopped one carries the
   * session when it had one: Claude Code's is named before it starts, Codex's is read from what it printed so far).
   */
  async function turn({ task, message, session = null, system, policy, signal, timeoutMs, onUpdate = () => {} }) {
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const stem = path.join(runDirectory, `${task.id}-${randomUUID()}`);
    const input = `${stem}.input.txt`;
    fs.writeFileSync(input, message, { mode: 0o600 });
    const short = pathLabeller([task.worktree, ...policy.readOnly]);
    try {
      if (task.provider === 'anthropic') {
        const promptFile = `${stem}.system.md`;
        const settingsFile = `${stem}.settings.json`;
        fs.writeFileSync(promptFile, system, { mode: 0o600 });
        fs.writeFileSync(settingsFile, JSON.stringify(claudeSettings(policy)), { mode: 0o600 });
        const id = session || randomUUID();
        const grants = policy.readOnly.map((_, n) => `--add-dir "$ENGELBART_BUILD_READ${n}"`).join(' ');
        const command = `exec ${program('claude')} -p --output-format stream-json --verbose --include-partial-messages ${session ? '--resume' : '--session-id'} "$ENGELBART_BUILD_SESSION" --restricted --strict-mcp-config --tools "${CLAUDE_TOOLS}" --permission-mode auto --permission-prompts none ${grants} --settings "$ENGELBART_BUILD_SETTINGS" --model "$ENGELBART_BUILD_MODEL" --effort ${task.effort} --append-system-prompt-file "$ENGELBART_BUILD_PROMPT" < "$ENGELBART_BUILD_INPUT"`;
        const env = childEnvironment({ ...programEnv('claude'), ENGELBART_BUILD_SESSION: id, ENGELBART_BUILD_MODEL: task.modelId, ENGELBART_BUILD_PROMPT: promptFile, ENGELBART_BUILD_SETTINGS: settingsFile, ENGELBART_BUILD_INPUT: input, ...Object.fromEntries(policy.readOnly.map((dir, n) => [`ENGELBART_BUILD_READ${n}`, dir])) });
        try {
          const { stdout, failure } = await execute(command, task.worktree, env, { signal, timeoutMs, onEvent: (event) => onUpdate(claudeUpdate(event, short)) });
          if (signal && signal.aborted) throw new TurnError('stopped', 'Stopped.', id);
          const result = lastResultLine(stdout);
          if (!result) throw new TurnError(notFound(failure) ? 'unavailable' : 'failed', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : timedOut(failure) ? 'The turn ran past its time limit and was stopped.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
          if (result.is_error || typeof result.result !== 'string') throw new TurnError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 500));
          return { text: result.result, session: id };
        } finally {
          for (const file of [promptFile, settingsFile]) { try { fs.unlinkSync(file); } catch { /* gone */ } }
        }
      }
      const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
      if (!prepareCodexHome({ codexHome, source, instructions: system })) throw new TurnError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
      const outFile = `${stem}.out.txt`;
      const shared = `-m "$ENGELBART_BUILD_MODEL" -c 'model_reasoning_effort="${task.effort}"' -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' -c 'tools.web_search=true' --json -o "$ENGELBART_BUILD_OUTPUT" - < "$ENGELBART_BUILD_INPUT"`;
      const command = session ? `exec ${program('codex')} exec resume "$ENGELBART_BUILD_SESSION" ${shared}` : `exec ${program('codex')} exec --color never ${shared}`;
      const env = childEnvironment({ ...programEnv('codex'), CODEX_HOME: codexHome, ENGELBART_BUILD_SESSION: session || '', ENGELBART_BUILD_MODEL: task.modelId, ENGELBART_BUILD_OUTPUT: outFile, ENGELBART_BUILD_INPUT: input });
      try {
        const { stdout, failure } = await execute(command, task.worktree, env, { signal, timeoutMs, onEvent: (event) => onUpdate(codexUpdate(event, short)) });
        let thread = session;
        for (const line of String(stdout || '').split(/\r?\n/)) {
          if (thread || !line.startsWith('{')) continue;
          try { const event = JSON.parse(line); if (event.type === 'thread.started' && UUID_RE.test(event.thread_id)) thread = event.thread_id; } catch { /* not an event */ }
        }
        if (signal && signal.aborted) throw new TurnError('stopped', 'Stopped.', thread);
        let text = '';
        try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
        if (!text.trim()) {
          if (notFound(failure)) throw new TurnError('unavailable', 'Codex was not found on the login shell PATH.');
          const reason = String(stdout || '').split(/\r?\n/).reverse().find((line) => /"type":"(error|turn\.failed)"|^ERROR/.test(line) && !/resuming with/.test(line)) || (timedOut(failure) ? 'The turn ran past its time limit and was stopped.' : failure ? failure.message.split('\n')[0] : 'Codex returned no message.');
          throw new TurnError('failed', reason.slice(0, 500));
        }
        return { text, session: thread };
      } finally {
        try { fs.unlinkSync(outFile); } catch { /* none */ }
      }
    } finally {
      try { fs.unlinkSync(input); } catch { /* gone */ }
    }
  }

  return { turn };
}

/**
 * Scripted runs (ENGELBART_BUILD_FAKE=1; design B24): no model. The fake agent writes BUILD-FAKE.md in the worktree (one
 * line per turn), reports two things it did, and answers. A first message containing "question" asks one (NEEDS YOU); a
 * quick task containing "escalate" escalates; "fail" fails the turn.
 */
function createFakeRunner({ delayMs = 900 } = {}) {
  const waits = new Map();
  return {
    async turn({ task, message, session = null, signal, onUpdate = () => {} }) {
      const pause = (ms) => new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        const stop = () => { clearTimeout(timer); reject(new TurnError('stopped', 'Stopped.', session || 'fake-session')); };
        if (signal) { if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true }); }
      });
      const said = String(message || '');
      onUpdate({ activity: 'Reading the workspace', log: true });
      await pause(delayMs / 3);
      if (/\bfail\b/i.test(said) && !session) throw new TurnError('failed', 'The fake agent was asked to fail.');
      if (task.kind === 'quick' && /escalate/i.test(said) && !session) return { text: 'ESCALATE: the fake agent was asked to escalate.', session: 'fake-session' };
      onUpdate({ activity: 'Editing BUILD-FAKE.md', log: true });
      const file = path.join(task.worktree, 'BUILD-FAKE.md');
      let held = '';
      try { held = fs.readFileSync(file, 'utf8'); } catch { held = ''; }
      fs.writeFileSync(file, `${held}turn ${(held.match(/\n/g) || []).length + 1}: ${said.includes('<reply>') ? said.replace(/[\s\S]*<reply>\n?|\n?<\/reply>[\s\S]*/g, '').slice(0, 80) : 'first'}\n`);
      await pause(delayMs / 3);
      onUpdate({ textStart: true });
      onUpdate({ delta: 'FAKE BUILD' });
      await pause(delayMs / 3);
      if (!session && /question/i.test(said) && task.kind !== 'quick') return { text: 'I wrote BUILD-FAKE.md.\n\nNEEDS YOU: Should the fake build keep going?', session: 'fake-session' };
      return { text: `FAKE BUILD: changed \`BUILD-FAKE.md\`.\n\n- ${session ? 'the same session, continued' : 'a new session'}\n- ${task.modelName} ${task.effort}`, session: session || 'fake-session' };
    },
    stopAll() { for (const stop of waits.values()) stop(); },
  };
}

module.exports = { createRunner, createFakeRunner, TurnError, CLAUDE_TOOLS };
