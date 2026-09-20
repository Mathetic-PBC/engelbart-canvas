'use strict';

// One @bart question, from the line in the document to the answer under it (2026-09-19).
// No router in front: the question starts on the first step of the ladder (./models.cjs) and the
// agent itself may ask for the next step by replying "ESCALATE: <why>". Moving up resumes the
// same CLI session at a higher model and effort, so everything it has read stays in context;
// a new agent would start cold. Flags on the @bart line pick one step by hand and turn that off.
//
// The agent is the Claude Code or Codex CLI, hidden, on the person's subscription, exactly as the
// summary sweep runs them (../context/summarizer.cjs), with three differences: it keeps a session
// so it can be resumed, it has tools, and the tools only read. Claude Code: --restricted with
// Read, Grep, Glob, WebSearch and WebFetch, its file tools confined to the project's code
// directory and the Engelbart data folder. Codex: the read-only sandbox with web search on; that
// sandbox can read the whole disk, which Codex offers no way to narrow. Both run in a private
// folder, so their sessions never show up among the person's own in the code directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { BART_SYSTEM_PROMPT } = require('./system-prompt.cjs');
const { readQuestion } = require('./models.cjs');
const { buildContext } = require('./context.cjs');
const { draftLines } = require('./reply.cjs');

const STEP_TIMEOUT_MS = 15 * 60_000;
const ESCALATE_RE = /^ESCALATE:\s*(.{0,400})$/s;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';

class BartError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'BartError';
    this.kind = kind; // 'unavailable' | 'failed' | 'stopped'
  }
}

function loadSystemPrompt(dataRoot) {
  try {
    const custom = fs.readFileSync(path.join(dataRoot, '.context', 'bart-system-prompt.md'), 'utf8').trim();
    if (custom) return custom;
  } catch { /* built-in */ }
  return BART_SYSTEM_PROMPT;
}

function levelBlock(steps, at, pinned) {
  const level = steps[at];
  const now = `You are running as ${level.name} at ${level.effort} effort`;
  if (pinned) return `<level>${now}. The person chose this model and effort by hand: no higher step exists.</level>`;
  const next = steps[at + 1];
  return `<level>${now}, step ${at + 1} of ${steps.length}. ${next ? `A higher step exists: ${next.name} at ${next.effort} effort.` : 'No higher step exists.'}</level>`;
}

/**
 * The escalation loop, apart from any CLI. `turn({ level, message, session })` sends one message
 * and resolves to { text, session }. → { text, level, trail, ms }
 */
async function climb({ steps, pinned, first, turn, onProgress = () => {}, now = Date.now }) {
  const started = now();
  const trail = [];
  let session = null;
  let at = 0;
  let message = first(levelBlock(steps, 0, pinned));
  let insisted = false;
  for (;;) {
    const level = steps[at];
    onProgress({ step: at + 1, of: steps.length, name: level.name, effort: level.effort, movedUp: trail.length });
    const out = await turn({ level, message, session });
    session = out.session;
    const text = String(out.text || '').trim();
    const wants = text.length < 500 ? text.match(ESCALATE_RE) : null;
    if (!wants) return { text, level, trail, ms: now() - started };
    if (at < steps.length - 1) {
      trail.push({ ...level, why: wants[1].trim() });
      at += 1;
      message = `${levelBlock(steps, at, pinned)}\n\nYou asked to move up, and you have. Everything you read is still in this conversation. Answer the question now.`;
    } else if (!insisted) {
      insisted = true;
      message = `${levelBlock(steps, at, pinned)}\n\nNo higher step exists. Answer the question now, as well as you can, and say what you are unsure of.`;
    } else {
      return { text: `I could not answer this at the highest step available. ${wants[1].trim()}`, level, trail, ms: now() - started };
    }
  }
}

function createBart({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-bart-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-bart'), codexAuthFile, run = execFile } = {}) {
  const shell = resolveShell(environment);
  const shellArgs = (command) => (path.basename(shell) === 'fish' ? ['--login', '--interactive', '--command', command] : ['-ilc', command]);
  const running = new Map(); // askId → AbortController
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...extra };
  };
  const execute = (command, cwd, env, signal) => new Promise((resolve) => {
    run(shell, shellArgs(command), { cwd, env, timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal }, (error, out) => resolve({ stdout: out, failure: error }));
  });
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');
  const stopped = (signal) => signal && signal.aborted;

  // Every flag is a literal, every value arrives through the environment: nothing is quoted by hand.
  // `effort` is one of five known words (./models.cjs).
  function claudeTurns({ system, cwd, dirs, stem, signal }) {
    const promptFile = `${stem}.system.md`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    const id = randomUUID();
    const grants = dirs.map((_, n) => `--add-dir "$ENGELBART_BART_DIR${n}"`).join(' ');
    return {
      done: () => { try { fs.unlinkSync(promptFile); } catch { /* already gone */ } },
      turn: async ({ level, message, session }) => {
        fs.writeFileSync(`${stem}.input.txt`, message, { mode: 0o600 });
        const command = `exec claude -p --output-format json ${session ? '--resume' : '--session-id'} "$ENGELBART_BART_SESSION" --restricted --setting-sources "" --strict-mcp-config --tools "${CLAUDE_TOOLS}" --allowedTools "${CLAUDE_TOOLS}" ${grants} --model "$ENGELBART_BART_MODEL" --effort ${level.effort} --system-prompt-file "$ENGELBART_BART_PROMPT" < "$ENGELBART_BART_INPUT"`;
        const env = childEnvironment({ ENGELBART_BART_SESSION: id, ENGELBART_BART_MODEL: level.model, ENGELBART_BART_PROMPT: promptFile, ENGELBART_BART_INPUT: `${stem}.input.txt`, ...Object.fromEntries(dirs.map((dir, n) => [`ENGELBART_BART_DIR${n}`, dir])) });
        const { stdout, failure } = await execute(command, cwd, env, signal);
        if (stopped(signal)) throw new BartError('stopped', 'Stopped.');
        const result = lastResultLine(stdout);
        if (!result) throw new BartError('unavailable', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
        if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new BartError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 300));
        return { text: result.result, session: id };
      },
    };
  }

  function codexTurns({ system, cwd, stem, signal }) {
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome, source, instructions: system })) throw new BartError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
    const outFile = `${stem}.out.txt`;
    return {
      done: () => { try { fs.unlinkSync(outFile); } catch { /* none */ } },
      turn: async ({ level, message, session }) => {
        fs.writeFileSync(`${stem}.input.txt`, message, { mode: 0o600 });
        try { fs.unlinkSync(outFile); } catch { /* none */ }
        const shared = `--skip-git-repo-check -m "$ENGELBART_BART_MODEL" -c 'model_reasoning_effort="${level.effort}"' -c 'sandbox_mode="read-only"' -c 'tools.web_search=true' -c project_doc_max_bytes=0 --json -o "$ENGELBART_BART_OUTPUT" - < "$ENGELBART_BART_INPUT"`;
        const command = session ? `exec codex exec resume "$ENGELBART_BART_SESSION" ${shared}` : `exec codex exec --color never ${shared}`;
        const env = childEnvironment({ CODEX_HOME: codexHome, ENGELBART_BART_SESSION: session || '', ENGELBART_BART_MODEL: level.model, ENGELBART_BART_OUTPUT: outFile, ENGELBART_BART_INPUT: `${stem}.input.txt` });
        const { stdout, failure } = await execute(command, cwd, env, signal);
        if (stopped(signal)) throw new BartError('stopped', 'Stopped.');
        let text = '';
        try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
        let thread = session;
        for (const line of String(stdout || '').split(/\r?\n/)) {
          if (thread || !line.startsWith('{')) continue;
          try { const event = JSON.parse(line); if (event.type === 'thread.started' && UUID_RE.test(event.thread_id)) thread = event.thread_id; } catch { /* not an event */ }
        }
        if (!text.trim()) {
          if (notFound(failure)) throw new BartError('unavailable', 'Codex was not found on the login shell PATH.');
          const reason = String(stdout || '').split(/\r?\n/).reverse().find((line) => /"type":"(error|turn\.failed)"|^ERROR/.test(line) && !/resuming with/.test(line)) || (failure ? failure.message.split('\n')[0] : 'Codex returned no message.');
          throw new BartError('failed', reason.slice(0, 300));
        }
        return { text, session: thread };
      },
    };
  }

  /** → { lines, meta }: the answer as draft lines for the document, and what produced it. */
  async function ask(ctx, projectId, { askId, ref, workspaceId, text }, { onProgress } = {}) {
    const { question, provider, steps, pinned } = readQuestion(text, readModels());
    if (!question) throw new BartError('failed', 'There is no question on the line.');
    const context = await buildContext(ctx, projectId, { ref, workspaceId, askId });
    const cwd = path.join(runDirectory, projectId);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const stem = path.join(cwd, `ask-${randomUUID()}`);
    const controller = new AbortController();
    running.set(askId, controller);
    let turns = null;
    try {
      turns = (provider === 'anthropic' ? claudeTurns : codexTurns)({ system: loadSystemPrompt(ctx.dataRoot), cwd, dirs: context.dirs, stem, signal: controller.signal });
      const first = (level) => [context.head, context.contextJson, context.documents, level, `<question>\n${question}\n</question>`].join('\n\n');
      const out = await climb({ steps, pinned, first, turn: turns.turn, onProgress });
      const meta = { provider, level: { name: out.level.name, effort: out.level.effort, model: out.level.model }, trail: out.trail.map((step) => ({ name: step.name, effort: step.effort, why: step.why })), ms: out.ms, pinned };
      return { lines: draftLines(out.text, meta), meta };
    } finally {
      running.delete(askId);
      if (turns) turns.done();
      try { fs.unlinkSync(`${stem}.input.txt`); } catch { /* already gone */ }
    }
  }

  function stop(askId) {
    const controller = running.get(askId);
    if (controller) controller.abort();
    return !!controller;
  }

  return { ask, stop, stopAll: () => { for (const controller of running.values()) controller.abort(); } };
}

/** Scripted runs only (ENGELBART_BART_FAKE=1): no model. A question containing "hard" moves up one step. */
function createFakeBart({ readModels, delayMs = 1200 }) {
  const waits = new Map();
  return {
    async ask(ctx, projectId, { askId, ref, workspaceId, text }, { onProgress } = {}) {
      const { question, provider, steps, pinned } = readQuestion(text, readModels());
      const context = await buildContext(ctx, projectId, { ref, workspaceId, askId });
      const pause = () => new Promise((resolve, reject) => { const timer = setTimeout(resolve, delayMs); waits.set(askId, () => { clearTimeout(timer); reject(new BartError('stopped', 'Stopped.')); }); });
      try {
        const out = await climb({
          steps, pinned, onProgress,
          first: (level) => `${level}\n${question}`,
          turn: async ({ message }) => { await pause(); return { session: 'fake', text: /hard/.test(question) && /step 1 of/.test(message) ? 'ESCALATE: the question says it is hard' : `FAKE ANSWER to "${question}".\n\n## Seen\n- **${context.documents.length}** characters of documents\n- \`${steps.length}\` steps` }; },
        });
        const meta = { provider, level: out.level, trail: out.trail, ms: out.ms, pinned };
        return { lines: draftLines(out.text, meta), meta };
      } finally { waits.delete(askId); }
    },
    stop(askId) { const cancel = waits.get(askId); if (cancel) cancel(); return !!cancel; },
    stopAll() { for (const cancel of waits.values()) cancel(); },
  };
}

module.exports = { createBart, createFakeBart, climb, levelBlock, loadSystemPrompt, BartError, ESCALATE_RE };
