'use strict';

// One bounded model invocation: a note's text (and, when it has one, its current summary) in,
// a catalog blurb out. The sweep (./sweeper.cjs) decides when; this decides how.
//
// Two providers, switched in ~/.engelbart/config.json (`summarizer`, read again for every call):
//   openai     Codex CLI, `codex exec`. Its system prompt is the AGENTS.md of a private CODEX_HOME
//              under the app's user-data folder, which holds nothing else of yours (no MCP
//              servers, hooks or personal AGENTS.md) except a link to your Codex sign-in.
//   anthropic  Claude Code CLI, `claude -p --system-prompt-file`, with settings, hooks, plugins,
//              MCP servers, tools and CLAUDE.md all switched off.
// Both are the CLIs the terminal already offers, as the agentic-pipelines design chooses, and
// both are held to your subscription: API keys are removed from the child's environment, and
// Codex is refused unless it is signed in with a ChatGPT account. They run hidden, through the
// login shell (an app opened from Finder has no useful PATH), one fresh process per note: the
// providers cache prompt prefixes on their servers by content, so a long-lived session would add
// nothing but a conversation in which every note leaks into the next. The note travels in a 0600
// temp file that is removed afterwards, never on a command line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { normalizeSummarizer } = require('../store/home.cjs');
const { SUMMARY_SYSTEM_PROMPT } = require('./summary-prompt.cjs');

const MAX_SUMMARY_CHARS = 999; // "less than 1000 characters"
const MAX_INPUT_CHARS = 1_500_000; // beyond this a note does not fit a request; it is reported, never truncated
const TIMEOUT_MS = 300_000;
// Anything that would bill an API account, or send the call somewhere other than the subscription.
const NOT_THE_SUBSCRIPTION = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'OPENAI_API_KEY', 'CODEX_API_KEY'];

class SummaryError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'SummaryError';
    this.kind = kind; // 'unavailable' (no CLI / not logged in) | 'too-long' | 'failed'
  }
}

/** What the model is sent. Case 1 has no current summary; case 2 attaches it. */
function buildRequest({ name, text, currentSummary, systemPrompt }) {
  const safeName = String(name || 'note').replace(/[<>"\n\r]/g, ' ').slice(0, 200);
  let input = `<file name="${safeName}">\n${text}\n</file>`;
  if (currentSummary) input += `\n\n<current_summary>\n${currentSummary}\n</current_summary>`;
  return { system: systemPrompt || SUMMARY_SYSTEM_PROMPT, input };
}

/** A blurb that fits the column: one paragraph, under 1000 characters, cut at a sentence when the model overshoots. */
function fitSummary(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const head = text.slice(0, MAX_SUMMARY_CHARS);
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('? '), head.lastIndexOf('! '));
  return (stop > 400 ? head.slice(0, stop + 1) : `${head.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`).trim();
}

/** The system prompt in force: <dataRoot>/.context/summary-system-prompt.md when it exists, else the built-in one. */
function loadSystemPrompt(dataRoot) {
  try {
    const custom = fs.readFileSync(path.join(dataRoot, '.context', 'summary-system-prompt.md'), 'utf8').trim();
    if (custom) return custom;
  } catch { /* built-in */ }
  return SUMMARY_SYSTEM_PROMPT;
}

/**
 * A private CODEX_HOME holding two things: a link to the person's Codex sign-in and an AGENTS.md,
 * which is how `codex exec` is given a system prompt. False when Codex is not signed in with a
 * ChatGPT account: an API key is never used.
 */
function prepareCodexHome({ codexHome, source, instructions }) {
  let auth = null;
  try { auth = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { auth = null; }
  if (!auth || auth.auth_mode !== 'chatgpt' || !auth.tokens) return false;
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const link = path.join(codexHome, 'auth.json');
  let linked = null;
  try { linked = fs.readlinkSync(link); } catch { linked = null; }
  if (linked !== source) { try { fs.unlinkSync(link); } catch { /* none yet */ } fs.symlinkSync(source, link); }
  const file = path.join(codexHome, 'AGENTS.md');
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== instructions) fs.writeFileSync(file, instructions, { mode: 0o600 });
  return true;
}

function lastResultLine(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith('{') && line.endsWith('}'));
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(lines[i]);
      if (value && value.type === 'result') return value;
    } catch { /* not the result line */ }
  }
  return null;
}

function lastUsage(stdout) {
  let usage = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try { const event = JSON.parse(line); if (event && event.type === 'turn.completed' && event.usage) usage = event.usage; } catch { /* not an event */ }
  }
  return usage;
}

/**
 * The summarizer the app uses. `readSettings()` returns the `summarizer` block of the config and is
 * asked again on every call, so switching provider, model or effort needs no restart.
 * `run` (execFile by default) and `codexAuthFile` are injectable for tests.
 */
function createCliSummarizer({ readSettings, environment = process.env, runDirectory = os.tmpdir(), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home'), codexAuthFile, run = execFile } = {}) {
  const shell = resolveShell(environment);
  const shellArgs = (command) => (path.basename(shell) === 'fish' ? ['--login', '--interactive', '--command', command] : ['-ilc', command]);
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...extra };
  };
  const execute = (command, env, signal) => new Promise((resolve) => {
    run(shell, shellArgs(command), { cwd: runDirectory, env, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, signal }, (error, out) => resolve({ stdout: out, failure: error }));
  });
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');

  // Every flag is a literal and every value arrives through the environment, so nothing needs quoting
  // and the same line works in zsh, bash and fish. `effort` is one of five known words.
  async function viaClaudeCode({ request, model, effort, stem, signal }) {
    const promptFile = `${stem}.system.md`;
    fs.writeFileSync(promptFile, request.system, { mode: 0o600 });
    try {
      const command = `exec claude -p --output-format json --no-session-persistence --setting-sources "" --strict-mcp-config --tools "" --model "$ENGELBART_SUMMARY_MODEL" --effort ${effort} --system-prompt-file "$ENGELBART_SUMMARY_PROMPT" < "$ENGELBART_SUMMARY_INPUT"`;
      const { stdout, failure } = await execute(command, childEnvironment({ ENGELBART_SUMMARY_MODEL: model, ENGELBART_SUMMARY_PROMPT: promptFile, ENGELBART_SUMMARY_INPUT: `${stem}.input.txt` }), signal);
      const result = lastResultLine(stdout);
      if (!result) throw new SummaryError('unavailable', notFound(failure) ? 'Claude Code was not found on the login shell PATH' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}`);
      if (result.is_error || result.subtype !== 'success' || typeof result.result !== 'string' || !result.result.trim()) throw new SummaryError('failed', String(result.result || result.subtype || 'the model returned no text').slice(0, 300));
      return { text: result.result, model: Object.keys(result.modelUsage || {})[0] || model, usage: result.usage || null, costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null };
    } finally {
      try { fs.unlinkSync(promptFile); } catch { /* already gone */ }
    }
  }

  async function viaCodex({ request, model, effort, stem, signal }) {
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome, source, instructions: request.system })) throw new SummaryError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`); an API key is never used for summaries');
    const outFile = `${stem}.out.txt`;
    try {
      const command = `exec codex exec --skip-git-repo-check --ephemeral -s read-only -m "$ENGELBART_SUMMARY_MODEL" -c 'model_reasoning_effort="${effort}"' -c project_doc_max_bytes=0 --color never --json -o "$ENGELBART_SUMMARY_OUTPUT" - < "$ENGELBART_SUMMARY_INPUT"`;
      const { stdout, failure } = await execute(command, childEnvironment({ CODEX_HOME: codexHome, ENGELBART_SUMMARY_MODEL: model, ENGELBART_SUMMARY_OUTPUT: outFile, ENGELBART_SUMMARY_INPUT: `${stem}.input.txt` }), signal);
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
      if (!text.trim()) {
        if (notFound(failure)) throw new SummaryError('unavailable', 'Codex was not found on the login shell PATH');
        const reason = String(stdout || '').split(/\r?\n/).reverse().find((line) => /"type":"error"|^ERROR/.test(line)) || (failure ? failure.message.split('\n')[0] : 'Codex returned no message');
        throw new SummaryError('failed', reason.slice(0, 300));
      }
      return { text, model, usage: lastUsage(stdout), costUsd: null };
    } finally {
      try { fs.unlinkSync(outFile); } catch { /* none */ }
    }
  }

  return async function summarize({ name, text, currentSummary = null, systemPrompt, signal }) {
    if (text.length > MAX_INPUT_CHARS) throw new SummaryError('too-long', `${name} is ${text.length} characters, more than one request can carry`);
    const settings = normalizeSummarizer(readSettings ? readSettings() : null);
    const { model, effort } = settings[settings.provider];
    const request = buildRequest({ name, text, currentSummary, systemPrompt });
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const stem = path.join(runDirectory, `summary-${randomUUID()}`);
    fs.writeFileSync(`${stem}.input.txt`, request.input, { mode: 0o600 });
    const started = Date.now();
    try {
      const out = await (settings.provider === 'anthropic' ? viaClaudeCode : viaCodex)({ request, model, effort, stem, signal });
      return { summary: fitSummary(out.text), meta: { provider: settings.provider, model: out.model, effort, durationMs: Date.now() - started, costUsd: out.costUsd, usage: out.usage } };
    } finally {
      try { fs.unlinkSync(`${stem}.input.txt`); } catch { /* already gone */ }
    }
  };
}

/** Test provider (ENGELBART_SUMMARY_FAKE=1, scripted runs only): no model, a recognisable blurb. */
function createFakeSummarizer() {
  return async function summarize({ name, text, currentSummary = null }) {
    return { summary: fitSummary(`FAKE SUMMARY of ${name} (${text.length} characters).${currentSummary ? ' Changed: regenerated after an edit.' : ''}`), meta: { provider: 'fake', model: 'none', durationMs: 0, costUsd: 0 } };
  };
}

module.exports = { buildRequest, fitSummary, loadSystemPrompt, createCliSummarizer, createFakeSummarizer, SummaryError, MAX_SUMMARY_CHARS, MAX_INPUT_CHARS, NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine, lastUsage };
