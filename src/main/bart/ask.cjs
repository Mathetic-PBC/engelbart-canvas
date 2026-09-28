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
//
// While a turn runs, the CLI's events are read as they arrive (./activity.cjs) and sent on as
// progress: what it is doing, and the answer so far. The answer itself is still the CLI's final
// result, read when the process exits; the stream only shows, it decides nothing.
//
// Follow-ups (2026-09-21). A question asked right under an answer continues that exchange. Nothing
// stays running between turns: each turn is one CLI process, and what is kept is its session id,
// for 30 minutes after the last turn. A follow-up inside that window resumes the session and sends
// only the new question, whatever happened to the window in between: another workspace, another
// project, the app closed and opened again (the ids are kept in a file). After it (or when the
// person edited an answer or deleted a turn, or the provider changed) the follow-up is a new session
// that is given exactly what a first question is given, read again, plus the earlier turns as the
// document holds them. A session is found by what the document says was said (./threadKey), so it
// is resumed only while its own memory of the exchange and the document agree. Nothing tells the
// person which of the two happened.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { resolveShell, sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { BART_SYSTEM_PROMPT } = require('./system-prompt.cjs');
const { BUILD_PROPOSAL_PROMPT, parseBuildProposal } = require('./build-proposal.cjs');
const { CLAUDE_SUBSCRIPTION_COMMAND } = require('./claude-command.cjs');
const { readQuestion, withChoice } = require('./models.cjs');
const { buildContext, conversationBlock } = require('./context.cjs');
const { replyLines, answerText } = require('./reply.cjs');
const { pathLabeller, claudeUpdate, codexUpdate, eventReader, createFeed } = require('./activity.cjs');

const STEP_TIMEOUT_MS = 15 * 60_000;
const THREAD_IDLE_MS = 30 * 60_000;
const MAX_TURNS = 40;
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

/** The earlier turns of an exchange as the renderer read them from the document, made safe: strings, bounded, no empty questions. */
function cleanTurns(turns) {
  return (Array.isArray(turns) ? turns : []).filter((turn) => turn && typeof turn.question === 'string' && turn.question.trim())
    .slice(-MAX_TURNS).map((turn) => ({ question: turn.question.trim().slice(0, 8000), answer: String(turn.answer || '').trim().slice(0, 20000) }));
}

/** Where an exchange stands: the document it is in and everything said in it so far. Two exchanges that read the same are the same. */
function threadKey(projectId, ref, turns) {
  return createHash('sha256').update(JSON.stringify([projectId, ref.kind, ref.id || ref.workspaceId, turns.map((turn) => [turn.question, turn.answer])])).digest('hex');
}

/**
 * The sessions that can still be resumed, by threadKey. `take` removes what it returns: a session
 * is either being continued or it is gone, so a turn that fails or is stopped leaves nothing half
 * resumable behind. `keep` starts the idle clock again. With `file`, what is held outlives the app:
 * a session id and when it was last used, nothing of what was said.
 */
function createThreads({ idleMs = THREAD_IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout, file = null, now = Date.now } = {}) {
  const held = new Map();
  const save = () => {
    if (!file) return;
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify([...held].map(([key, { timer, ...entry }]) => [key, entry])), { mode: 0o600 }); } catch { /* it still holds for this run */ }
  };
  const arm = (key, entry, ms) => {
    const timer = setTimer(() => { held.delete(key); save(); }, ms);
    if (timer && timer.unref) timer.unref();
    held.set(key, { ...entry, timer });
  };
  const drop = (key) => { const entry = held.get(key); if (!entry) return; clearTimer(entry.timer); held.delete(key); };
  if (file) {
    try {
      for (const [key, entry] of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        const left = idleMs - (now() - Number(entry && entry.at));
        if (typeof key === 'string' && entry && typeof entry.session === 'string' && typeof entry.provider === 'string' && left > 0 && left <= idleMs) arm(key, entry, left);
      }
    } catch { /* no file yet, or not ours: nothing to resume */ }
  }
  return {
    take(key, provider) { const entry = held.get(key); drop(key); if (entry) save(); return entry && entry.provider === provider && entry.session ? entry : null; },
    keep(key, entry) { drop(key); arm(key, { ...entry, at: now() }, idleMs); save(); },
    forget(match = () => true) { for (const [key, entry] of [...held]) if (match(entry)) drop(key); save(); },
    size: () => held.size,
  };
}

/** What a question is given: everything, for a new session; the question alone, for a session that already holds the rest. */
function firstMessage({ context, prior, question, resumed }) {
  const asked = `<question>\n${question}\n</question>`;
  const capability = `<build_capability>\n${BUILD_PROPOSAL_PROMPT}\n</build_capability>`;
  if (resumed) return (level) => [level, capability, asked].join('\n\n');
  return (level) => [context.head, context.contextJson, context.documents, conversationBlock(prior), level, capability, asked].filter(Boolean).join('\n\n');
}

/**
 * The escalation loop, apart from any CLI. `turn({ level, message, session })` sends one message
 * and resolves to { text, session }. → { text, level, trail, ms }
 */
async function climb({ steps, pinned, first, turn, session: resumed = null, onProgress = () => {}, now = Date.now }) {
  const started = now();
  const trail = [];
  let session = resumed;
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
    if (!wants) return { text, level, trail, session, ms: now() - started };
    if (at < steps.length - 1) {
      trail.push({ ...level, why: wants[1].trim() });
      at += 1;
      message = `${levelBlock(steps, at, pinned)}\n\nYou asked to move up, and you have. Everything you read is still in this conversation. Answer the question now.`;
    } else if (!insisted) {
      insisted = true;
      message = `${levelBlock(steps, at, pinned)}\n\nNo higher step exists. Answer the question now, as well as you can, and say what you are unsure of.`;
    } else {
      return { text: `I could not answer this at the highest step available. ${wants[1].trim()}`, level, trail, session, ms: now() - started };
    }
  }
}

function createBart({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-bart-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-bart'), codexAuthFile, run = execFile, threads = createThreads() } = {}) {
  const shell = resolveShell(environment);
  const shellArgs = (command) => (path.basename(shell) === 'fish' ? ['--login', '--interactive', '--command', command] : ['-ilc', command]);
  const running = new Map(); // askId → AbortController
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...extra };
  };
  // execFile still collects stdout for the result; the same stream is also read line by line as it arrives.
  const execute = (command, cwd, env, signal, onEvent) => new Promise((resolve) => {
    const child = run(shell, shellArgs(command), { cwd, env, timeout: STEP_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, signal }, (error, out) => resolve({ stdout: out, failure: error }));
    if (onEvent && child && child.stdout) child.stdout.on('data', eventReader(onEvent));
  });
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');
  const stopped = (signal) => signal && signal.aborted;

  // Every flag is a literal, every value arrives through the environment: nothing is quoted by hand.
  // `effort` is one of six known words (./question.cjs). `resume`: the id of a session to go on with.
  function claudeTurns({ system, cwd, dirs, stem, signal, short, onUpdate, resume }) {
    const promptFile = `${stem}.system.md`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    const id = resume || randomUUID();
    const grants = dirs.map((_, n) => `--add-dir "$ENGELBART_BART_DIR${n}"`).join(' ');
    return {
      done: () => { try { fs.unlinkSync(promptFile); } catch { /* already gone */ } },
      turn: async ({ level, message, session }) => {
        fs.writeFileSync(`${stem}.input.txt`, message, { mode: 0o600 });
        const command = `exec ${CLAUDE_SUBSCRIPTION_COMMAND} -p --output-format stream-json --verbose --include-partial-messages ${session ? '--resume' : '--session-id'} "$ENGELBART_BART_SESSION" --restricted --setting-sources "" --strict-mcp-config --tools "${CLAUDE_TOOLS}" --allowedTools "${CLAUDE_TOOLS}" ${grants} --model "$ENGELBART_BART_MODEL" --effort ${level.effort} --system-prompt-file "$ENGELBART_BART_PROMPT" < "$ENGELBART_BART_INPUT"`;
        const env = childEnvironment({ ENGELBART_BART_SESSION: id, ENGELBART_BART_MODEL: level.model, ENGELBART_BART_PROMPT: promptFile, ENGELBART_BART_INPUT: `${stem}.input.txt`, ...Object.fromEntries(dirs.map((dir, n) => [`ENGELBART_BART_DIR${n}`, dir])) });
        const { stdout, failure } = await execute(command, cwd, env, signal, (event) => onUpdate(claudeUpdate(event, short)));
        if (stopped(signal)) throw new BartError('stopped', 'Stopped.');
        const result = lastResultLine(stdout);
        if (!result) throw new BartError('unavailable', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
        if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new BartError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 300));
        return { text: result.result, session: id };
      },
    };
  }

  function codexTurns({ system, cwd, stem, signal, short, onUpdate }) {
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
        const { stdout, failure } = await execute(command, cwd, env, signal, (event) => onUpdate(codexUpdate(event, short)));
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

  /**
   * → { lines, meta }: the answer as lines for the document, and what produced it. `text` is what the
   * line says after "@bart"; `choice` ({ model, effort }, from Regenerate's selector) overrules its flags
   * for this run without rewriting the line; `turns` are the earlier turns of the exchange, when there are any.
   */
  async function ask(ctx, projectId, { askId, ref, workspaceId, text, turns, choice }, { onProgress } = {}) {
    const models = readModels();
    const { question, provider, steps, pinned } = readQuestion(choice ? withChoice(text, models, choice) : text, models);
    if (!question) throw new BartError('failed', 'There is no question on the line.');
    const prior = cleanTurns(turns);
    const held = prior.length ? threads.take(threadKey(projectId, ref, prior), provider) : null;
    const context = await buildContext(ctx, projectId, { ref, workspaceId, askId });
    const cwd = path.join(runDirectory, projectId);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const stem = path.join(cwd, `ask-${randomUUID()}`);
    const controller = new AbortController();
    running.set(askId, controller);
    const feed = createFeed({ onProgress });
    const once = async (session) => {
      let cli = null;
      try {
        cli = (provider === 'anthropic' ? claudeTurns : codexTurns)({ system: loadSystemPrompt(ctx.dataRoot), cwd, dirs: context.dirs, stem, signal: controller.signal, short: pathLabeller(context.dirs), onUpdate: feed.take, resume: session });
        return await climb({ steps, pinned, first: firstMessage({ context, prior, question, resumed: !!session }), session, turn: (input) => { feed.reset(); return cli.turn(input); }, onProgress });
      } finally { if (cli) cli.done(); }
    };
    try {
      let out;
      // A session that will not resume (its file is gone, the CLI changed) is not the person's problem: start again from the document.
      try { out = await once(held ? held.session : null); } catch (error) { if (!held || error.kind === 'stopped') throw error; out = await once(null); }
      const meta = { provider, level: { name: out.level.name, effort: out.level.effort, model: out.level.model }, trail: out.trail.map((step) => ({ name: step.name, effort: step.effort, why: step.why })), ms: out.ms, pinned };
      const buildProposal = parseBuildProposal(out.text);
      // A build's eventual answer differs from this routing result; do not keep
      // a resumable read-only session under text that never enters the document.
      if (buildProposal) return { buildProposal, meta };
      // Kept under what the document will say once this answer is in it: the next follow-up is found by that.
      if (out.session) threads.keep(threadKey(projectId, ref, [...prior, { question: String(text).trim(), answer: answerText(out.text) }]), { provider, session: out.session, projectId, workspaceId });
      return { lines: replyLines(out.text, meta), meta };
    } finally {
      feed.end();
      running.delete(askId);
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

/** Scripted runs only (ENGELBART_BART_FAKE=1): no model. A question containing "hard" moves up one step; one containing "code" is answered with a JSON code block too. */
function createFakeBart({ readModels, delayMs = 1200, threads = createThreads() }) {
  const waits = new Map();
  return {
    async ask(ctx, projectId, { askId, ref, workspaceId, text, turns, choice }, { onProgress } = {}) {
      const models = readModels();
      const { question, provider, steps, pinned } = readQuestion(choice ? withChoice(text, models, choice) : text, models);
      const prior = cleanTurns(turns);
      const held = prior.length ? threads.take(threadKey(projectId, ref, prior), provider) : null;
      const context = await buildContext(ctx, projectId, { ref, workspaceId, askId });
      const message = firstMessage({ context, prior, question, resumed: !!held });
      const pause = (ms) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); waits.set(askId, () => { clearTimeout(timer); reject(new BartError('stopped', 'Stopped.')); }); });
      const feed = createFeed({ onProgress, intervalMs: 0 });
      // The same kinds of update a real run sends, spread over the delay: two things done, then the answer in pieces.
      const act = async (text) => {
        feed.reset();
        for (const activity of ['Reading notes.md', 'Searching the web for “fake”']) { feed.take({ activity, log: true }); await pause(delayMs / 4); }
        feed.take({ textStart: true });
        const pieces = text.match(/[\s\S]{1,24}/g) || [];
        for (const delta of pieces) { feed.take({ delta }); await pause(delayMs / 2 / pieces.length); }
        return text;
      };
      try {
        const out = await climb({
          steps, pinned, onProgress,
          first: message, session: held ? held.session : null,
          // What it was sent is what it reports: a resumed session gets the question alone, a new one gets everything.
          turn: async ({ message: sent }) => ({ session: 'fake', text: await act(/hard/.test(question) && /step 1 of/.test(sent) ? 'ESCALATE: the question says it is hard' : `FAKE ANSWER to "${question}".\n\n## Seen\n- **${context.documents.length}** characters of documents\n- \`${steps.length}\` steps${prior.length ? `\n- ${/<conversation>/.test(sent) ? `a new session, given ${prior.length} earlier ${prior.length === 1 ? 'turn' : 'turns'}` : /<engelbart>/.test(sent) ? 'a new session, given no earlier turns' : 'the same session, given the question alone'}` : ''}${/code/.test(question) ? `\n\nThe same as JSON:\n\n\`\`\`json\n{\n  "fake": true,\n  "steps": ${steps.length},\n  "note": "# not a heading"\n}\n\`\`\`` : ''}`) }),
        });
        const meta = { provider, level: out.level, trail: out.trail, ms: out.ms, pinned };
        threads.keep(threadKey(projectId, ref, [...prior, { question: String(text).trim(), answer: answerText(out.text) }]), { provider, session: out.session, projectId, workspaceId });
        return { lines: replyLines(out.text, meta), meta };
      } finally { feed.end(); waits.delete(askId); }
    },
    stop(askId) { const cancel = waits.get(askId); if (cancel) cancel(); return !!cancel; },
    stopAll() { for (const cancel of waits.values()) cancel(); },
  };
}

module.exports = { createBart, createFakeBart, createThreads, threadKey, cleanTurns, climb, levelBlock, loadSystemPrompt, BartError, ESCALATE_RE, THREAD_IDLE_MS };
