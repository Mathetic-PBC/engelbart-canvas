'use strict';

// One turn of a Build agent (2026-09-25; design B9-B12): Claude Code or Codex, hidden, on the person's subscription, in
// the Build's worktree, run exactly the way @bart runs them (../bart/ask.cjs: the login shell, every value through the
// environment, API keys removed, one process per turn, events read as they arrive by ../bart/activity.cjs) but able to
// write. What each may reach beyond its worktree is ./policy.cjs's. Flags checked on Claude Code 2.1.283 and codex-cli
// 0.157.0 (2026-09-25, in a scratch worktree); `exec resume` takes only -c, which is why Codex's sandbox and
// auto-review are set that way on every turn.
//
// Since 2026-10-07 ("Bart build agents"; flags checked on Claude Code 2.1.293 and codex-cli 0.160.0) each runs with the
// person's own setup: Claude Code without --restricted and --strict-mcp-config, its user, project and local settings
// loaded (hooks, permission rules, MCP servers), the Agent tool for subagents and no Chrome; Codex in the person's own
// CODEX_HOME (their config.toml, hooks, rules, MCP servers, AGENTS.md), Build's prompt as developer_instructions,
// multi_agent on, computer use and browser use off. Both get Engelbart's MCP server (./engelbart-tools.cjs) when the
// turn has its bridge, and Engelbart's git first on PATH with its hooks (./git-guard.cjs) when the policy names the
// repository.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, lastResultLine } = require('../context/summarizer.cjs');
const { pathLabeller, claudeUpdate, codexUpdate, eventReader } = require('../bart/activity.cjs');
const { claudeSettings, COMPUTER_USE } = require('./policy.cjs');
const { prepareGitGuard, guardEnvironment, guardPath } = require('./git-guard.cjs');

const CLAUDE_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash,WebSearch,WebFetch,Agent';
const SETTING_SOURCES = 'user,project,local';
const ENGELBART_SERVER = path.join(__dirname, 'engelbart-mcp.cjs');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class TurnError extends Error {
  constructor(kind, message, session = null) {
    super(message);
    this.name = 'TurnError';
    this.kind = kind; // 'unavailable' | 'failed' | 'stopped'
    this.session = session; // a turn stopped part way keeps its session, so the next one can go on with it
  }
}

/** Whether Codex's auth.json is a ChatGPT sign-in (an API key is never used). */
function chatGptSignIn(file) {
  try { const auth = JSON.parse(fs.readFileSync(file, 'utf8')); return !!(auth && auth.auth_mode === 'chatgpt' && auth.tokens); } catch { return false; }
}

/** Whether the person's Codex config has an MCP server of that name (turning off one it lacks would make a half entry). */
function codexHasServer(home, name) {
  let config = '';
  try { config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { return false; }
  const key = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\.(?:"${key}"|${key})\\s*\\]`, 'm').test(config);
}

const toml = (value) => JSON.stringify(value); // a JSON string or array of strings is TOML too

/**
 * Codex's `-c` settings for a policy, each `key=value` in TOML: subagents on, computer and browser use off, the
 * project's folder writable, Build's prompt, Engelbart's MCP server (`engelbart`: { command, args }).
 */
function codexOverrides(policy, { instructions, engelbart = null, home }) {
  const out = [
    `developer_instructions=${toml(instructions)}`,
    `features.multi_agent=${policy.subagents ? 'true' : 'false'}`,
    `sandbox_workspace_write.writable_roots=${toml(policy.writable)}`,
  ];
  if (!policy.computerUse) {
    for (const feature of ['computer_use', 'browser_use', 'browser_use_external']) out.push(`features.${feature}=false`);
    for (const server of COMPUTER_USE) if (codexHasServer(home, server)) out.push(`mcp_servers.${server}.enabled=false`);
  }
  if (engelbart) out.push(`mcp_servers.engelbart.command=${toml(engelbart.command)}`, `mcp_servers.engelbart.args=${toml(engelbart.args)}`, 'mcp_servers.engelbart.env={ ELECTRON_RUN_AS_NODE = "1" }');
  return out;
}

/**
 * `codexHome`: the Codex home a Build uses, the person's own unless a test names one (CODEX_HOME, else ~/.codex).
 * `runDirectory` holds what one turn needs on disk, and the git guard (./git-guard.cjs).
 */
function createRunner({ environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-build-runs'), codexHome = null, codexAuthFile, run = execFile, tools = null } = {}) {
  const shell = resolveShell(environment);
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...(tools && tools.environment ? tools.environment() : {}), ...extra }; // Engelbart's own Git, when it stands in (../tools/bundled-git.cjs)
  };
  const execute = (command, cwd, env, { signal, timeoutMs, onEvent }) => new Promise((resolve) => {
    const child = run(shell, loginShellArgs(shell, command, env), { cwd, env, timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, signal, windowsHide: true }, (error, out) => resolve({ stdout: out, failure: error }));
    if (onEvent && child && child.stdout) child.stdout.on('data', eventReader(onEvent));
  });
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');
  const timedOut = (failure) => !!(failure && failure.killed && failure.signal); // execFile's timeout kills with a signal; Stop is read from the AbortSignal first

  /**
   * One turn. `task` gives provider, modelId, effort, worktree; `session` is the session to go on with (null: a new one).
   * `system` is Build's prompt, `policy` ./policy.cjs's; `engelbart`, the turn's bridge to Engelbart's tools ({ url,
   * token }; none: no `engelbart` server). → { text, session }; throws TurnError (a stopped one carries the session when
   * it had one: Claude Code's is named before it starts, Codex's is read from what it printed so far).
   */
  async function turn({ task, message, session = null, system, policy, engelbart = null, signal, timeoutMs, onUpdate = () => {} }) {
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const stem = path.join(runDirectory, `${task.id}-${randomUUID()}`);
    const input = `${stem}.input.txt`;
    fs.writeFileSync(input, message, { mode: 0o600 });
    const connection = engelbart ? `${stem}.engelbart.json` : null;
    if (connection) fs.writeFileSync(connection, JSON.stringify({ url: engelbart.url, token: engelbart.token }), { mode: 0o600 });
    const server = connection ? { command: process.execPath, args: [ENGELBART_SERVER, connection] } : null;
    const short = pathLabeller([task.worktree, ...policy.folders]);
    // The git ban (./git-guard.cjs): the guard first on PATH, after the login shell's startup files, and its config.
    const guarded = policy.gitDir ? guardEnvironment(prepareGitGuard(path.join(runDirectory, 'git-guard')), policy.gitDir, environment) : null; // written again when changed
    const guardFirst = guarded ? guardPath(shell) : '';
    try {
      if (task.provider === 'anthropic') {
        const promptFile = `${stem}.system.md`;
        const settingsFile = `${stem}.settings.json`;
        const mcpFile = `${stem}.mcp.json`;
        fs.writeFileSync(promptFile, system, { mode: 0o600 });
        fs.writeFileSync(settingsFile, JSON.stringify(claudeSettings(policy)), { mode: 0o600 });
        if (server) fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { engelbart: { ...server, env: { ELECTRON_RUN_AS_NODE: '1' } } } }), { mode: 0o600 });
        const id = session || randomUUID();
        const grants = policy.folders.map((_, n) => `--add-dir "$ENGELBART_BUILD_DIR${n}"`).join(' ');
        const command = `${guardFirst}exec ${program('claude')} -p --output-format stream-json --verbose --include-partial-messages ${session ? '--resume' : '--session-id'} "$ENGELBART_BUILD_SESSION" --setting-sources ${SETTING_SOURCES}${server ? ' --mcp-config "$ENGELBART_BUILD_MCP"' : ''} --no-chrome --tools "${CLAUDE_TOOLS}" --permission-mode auto --permission-prompts none ${grants} --settings "$ENGELBART_BUILD_SETTINGS" --model "$ENGELBART_BUILD_MODEL" --effort ${task.effort} --append-system-prompt-file "$ENGELBART_BUILD_PROMPT" < "$ENGELBART_BUILD_INPUT"`;
        const env = childEnvironment({ ...programEnv('claude'), ...guarded, ENGELBART_BUILD_SESSION: id, ENGELBART_BUILD_MODEL: task.modelId, ENGELBART_BUILD_PROMPT: promptFile, ENGELBART_BUILD_SETTINGS: settingsFile, ...(server ? { ENGELBART_BUILD_MCP: mcpFile } : {}), ENGELBART_BUILD_INPUT: input, ...Object.fromEntries(policy.folders.map((dir, n) => [`ENGELBART_BUILD_DIR${n}`, dir])) });
        try {
          const { stdout, failure } = await execute(command, task.worktree, env, { signal, timeoutMs, onEvent: (event) => onUpdate(claudeUpdate(event, short)) });
          if (signal && signal.aborted) throw new TurnError('stopped', 'Stopped.', id);
          const result = lastResultLine(stdout);
          if (!result) throw new TurnError(notFound(failure) ? 'unavailable' : 'failed', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : timedOut(failure) ? 'The turn ran past its time limit and was stopped.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
          if (result.is_error || typeof result.result !== 'string') throw new TurnError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 500));
          return { text: result.result, session: id };
        } finally {
          for (const file of [promptFile, settingsFile, mcpFile]) { try { fs.unlinkSync(file); } catch { /* gone */ } }
        }
      }
      const home = codexHome || environment.CODEX_HOME || path.join(environment.HOME || os.homedir(), '.codex');
      if (!chatGptSignIn(codexAuthFile || path.join(home, 'auth.json'))) throw new TurnError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
      const outFile = `${stem}.out.txt`;
      const overrides = codexOverrides(policy, { instructions: system, engelbart: server, home });
      const settings = overrides.map((_, n) => `-c "$ENGELBART_BUILD_C${n}"`).join(' ');
      const shared = `-m "$ENGELBART_BUILD_MODEL" -c 'model_reasoning_effort="${task.effort}"' -c 'sandbox_mode="workspace-write"' -c 'approval_policy="on-request"' -c 'approvals_reviewer="auto_review"' -c 'tools.web_search=true' ${settings} --json -o "$ENGELBART_BUILD_OUTPUT" - < "$ENGELBART_BUILD_INPUT"`;
      const command = `${guardFirst}${session ? `exec ${program('codex')} exec resume "$ENGELBART_BUILD_SESSION" ${shared}` : `exec ${program('codex')} exec --color never ${shared}`}`;
      const env = childEnvironment({ ...programEnv('codex'), ...guarded, ...(codexHome ? { CODEX_HOME: codexHome } : {}), ENGELBART_BUILD_SESSION: session || '', ENGELBART_BUILD_MODEL: task.modelId, ENGELBART_BUILD_OUTPUT: outFile, ENGELBART_BUILD_INPUT: input, ...Object.fromEntries(overrides.map((value, n) => [`ENGELBART_BUILD_C${n}`, value])) });
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
      for (const file of [input, connection]) { if (file) { try { fs.unlinkSync(file); } catch { /* gone */ } } }
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

module.exports = { createRunner, createFakeRunner, TurnError, CLAUDE_TOOLS, codexOverrides };
