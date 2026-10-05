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
//
// @brainstorm (2026-09-30): the same run with another agent. Its own system prompt (./brainstorm-system-prompt.cjs),
// one fixed step (./models.cjs readBrainstorm; 2026-10-02: no flags, and its foot gives the time alone), file tools only,
// its own Codex home, and sessions of its own kept for two idle hours. It replies with one JSON card (./card.cjs), which is written as a fenced block the editor draws; a reply
// that does not parse is written as it came and reads as an @bart answer. An empty line asks it to start from the
// workspace. Round 7: each turn is told which card to ask as <stage>, so a session ends with a research question the
// person wrote. 2026-10-05: @orient folded in (an `@orient` line runs as @brainstorm; its sessions file is left unread).
// The exchange's path (<path>: paper, topic or open) is read here from its opening line against the library the turn is
// shown, and the next stage from the id of the last card asked (turnPlan).
//
// @discover (2026-09-30): the same again, for what to read about a problem. Its own prompt (./discover-system-prompt.cjs),
// one step (./question.cjs readDiscover: the level of the models file's `discover` block for its mode, on the provider the
// line or its exchange names with --claude or --codex, else @bart's; a follow-up stays on it and resumes), @bart's file and
// web tools and the paper tools (./papers.cjs, served by ./papers-mcp.cjs: to Claude Code by --mcp-config, to Codex by its
// own home's config.toml), its own sessions kept for two idle hours, and half an hour a step (three quarters, deep). It may
// ask a card or two first, which are written as @brainstorm's are; its guide is markdown, written as an @bart answer is.
// Each turn carries <mode>: quick or deep when a line of the exchange said --quick or --deep, else standard.
//
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { BART_SYSTEM_PROMPT } = require('./system-prompt.cjs');
const { BRAINSTORM_SYSTEM_PROMPT } = require('./brainstorm-system-prompt.cjs');
const { DISCOVER_SYSTEM_PROMPT } = require('./discover-system-prompt.cjs');
const { readQuestion, readBrainstorm, readDiscover, withChoice } = require('./models.cjs');
const { OPENING, SKIPPED, cardBody, cardOfAnswer, questionOf, readCard, readAnswer, readWrap } = require('./card.cjs');
const { buildContext, conversationBlock } = require('./context.cjs');
const { projectSource, imagePaths } = require('../context/expand-mentions.cjs');
const { replyLines, answerText } = require('./reply.cjs');
const { pathLabeller, claudeUpdate, codexUpdate, eventReader, createFeed } = require('./activity.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');

const STEP_TIMEOUT_MS = 15 * 60_000;
const DISCOVER_TIMEOUT_MS = 30 * 60_000;
// Opus max or Astra ultra, two hops from up to five starting points, may need longer (2026-10-02).
const DEEP_DISCOVER_TIMEOUT_MS = 45 * 60_000;
const THREAD_IDLE_MS = 30 * 60_000;
const BRAINSTORM_IDLE_MS = 2 * 60 * 60_000;
const DISCOVER_IDLE_MS = 2 * 60 * 60_000;
const MAX_TURNS = 40;
const ESCALATE_RE = /^ESCALATE:\s*(.{0,400})$/s;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';
const BRAINSTORM_TOOLS = 'Read,Grep,Glob';
// @discover's paper tools, as Claude Code names an MCP server's tools; the server, run by Engelbart's own executable as Node.
const PAPER_TOOLS = 'mcp__papers__*';
const PAPERS_SERVER = path.join(__dirname, 'papers-mcp.cjs');
const AGENTS = ['bart', 'brainstorm', 'discover'];
const PROMPTS = { bart: ['bart-system-prompt.md', BART_SYSTEM_PROMPT], brainstorm: ['brainstorm-system-prompt.md', BRAINSTORM_SYSTEM_PROMPT], discover: ['discover-system-prompt.md', DISCOVER_SYSTEM_PROMPT] };
// The agents on one fixed step whose model is never named, while they run or in their foot (2026-10-02, B-05).
const QUIET = new Set(['brainstorm']);
// @brainstorm's paths (2026-10-05, @orient folded in) and the cards each asks, in order (the prompt's <path> and <stage>):
// a library paper mentioned on the opening line, what they took from it; words without one, what they know; nothing, an
// area first. Then where it thins out, their question as they write it, and versions of it made from their words.
const BRAINSTORM_PATHS = { paper: ['took', 'thin', 'draft', 'versions'], topic: ['know', 'thin', 'draft', 'versions'], open: ['area', 'know', 'thin', 'draft', 'versions'] };
// What comes after a card, by its id, whatever the path: its own stages, and the ids older documents hold (round 7's
// puzzle, @orient's subject and interest, rounds 4 and 5's closing). After draft, versions only when it was answered.
const AFTER = { area: 'know', subject: 'know', know: 'thin', took: 'thin', thin: 'draft', puzzle: 'draft', interest: 'draft', draft: 'versions', versions: 'recap', closing: 'recap' };
// The most cards an exchange asks before its recap, skips included.
const MAX_BRAINSTORM_CARDS = 5;
// What an @discover line with nothing after it asks.
const DISCOVER_OPENING = 'Find what I should read about the problem this workspace is about.';
// How far each mode traces (the prompt's <mode>), and how many of its sources are essays when essays apply (2026-10-03):
// a share of the same total, so papers no longer use it all. And how many more papers may be opened only to look for a
// repository to run (2026-10-04, the prompt's "Code"): none in quick mode.
const MODE_LIMITS = {
  quick: 'quick. Up to two starting points; one hop backward and one forward from each; at most five sources in the guide, of which up to two are essays when essays apply. No extra papers opened to look for code.',
  standard: 'standard. Up to three starting points; one hop backward and one forward from each; at most eight sources in the guide, of which two to three are essays when essays apply. Up to two extra papers opened to look for code.',
  deep: 'deep. Up to five starting points; one hop backward and one forward from each, then one more of each from the best of what you found; at most fifteen sources in the guide, of which three to five are essays when essays apply. Up to four extra papers opened to look for code.',
};

class BartError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'BartError';
    this.kind = kind; // 'unavailable' | 'failed' | 'stopped'
  }
}

/** The agent's instructions: <dataRoot>/.context/<agent>-system-prompt.md when it holds any, else the built-in ones. */
function loadSystemPrompt(dataRoot, agent = 'bart') {
  const [file, builtIn] = PROMPTS[agent] || PROMPTS.bart;
  try {
    const custom = fs.readFileSync(path.join(dataRoot, '.context', file), 'utf8').trim();
    if (custom) return custom;
  } catch { /* built-in */ }
  return builtIn;
}

function levelBlock(steps, at, pinned) {
  const level = steps[at];
  const now = `You are running as ${level.name} at ${level.effort} effort`;
  if (pinned) return `<level>${now}. The person chose this model and effort by hand: no higher step exists.</level>`;
  const next = steps[at + 1];
  return `<level>${now}, step ${at + 1} of ${steps.length}. ${next ? `A higher step exists: ${next.name} at ${next.effort} effort.` : 'No higher step exists.'}</level>`;
}

/**
 * The earlier turns of an exchange as the renderer read them from the document, made safe: strings, bounded, no empty
 * questions. `keepEmpty`: @brainstorm's and @discover's, whose first line may say nothing and still be a turn.
 */
function cleanTurns(turns, { keepEmpty = false } = {}) {
  return (Array.isArray(turns) ? turns : []).filter((turn) => turn && typeof turn.question === 'string' && (keepEmpty || turn.question.trim()))
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

/**
 * The question as it is sent (2026-10-02): an image pasted into it (`![Attachment n](img:<id>)`, from the document or a
 * follow-up's field) as the path of its file, which the agent's file tools can open; one whose image is gone as written.
 * A new session's documents carry the path too, a resumed one is sent the question alone. What the session is kept
 * under is the line as the document holds it, img:<id> and all.
 */
async function withImagePaths(ctx, projectId, question) {
  if (!/\]\(img:/.test(question)) return question;
  return imagePaths(question, projectSource(ctx, projectId, await ctx.libraryDb.list()));
}

/**
 * What a question is given: everything, for a new session; the question alone, for a session that already holds the
 * rest. `extra` goes in front of the level either way (@brainstorm's path and stage, @discover's mode).
 */
function firstMessage({ context, prior, question, resumed, extra = '' }) {
  const asked = `<question>\n${question}\n</question>`;
  if (resumed) return (level) => [extra, level, asked].filter(Boolean).join('\n\n');
  return (level) => [context.head, context.contextJson, context.documents, conversationBlock(prior), extra, level, asked].filter(Boolean).join('\n\n');
}

/** Where the cards at the end of `turns` begin: after the last recap, or the last reply that was not a card. */
function cardsFrom(turns) {
  let from = turns.length;
  while (from > 0 && cardOfAnswer(turns[from - 1].answer)) from -= 1;
  return from;
}

/**
 * The library paper an @brainstorm opening mentions (2026-10-05): a mention that is not a workspace's (`@[Name]`, as
 * fakeDiscover reads one) naming, as a mention finds it (in any case), an item of `entries` (the library the turn is
 * shown, ./context.cjs) that is a pdf or tagged "paper". null when it mentions none: a note is not a paper.
 */
function mentionedPaper(opening, entries = []) {
  for (const m of String(opening || '').matchAll(/@\[([^\]\n]+)\](?!\(ws:)/g)) {
    const name = m[1].toLowerCase();
    const found = entries.find((entry) => String(entry.name).toLowerCase() === name && (entry.type === 'pdf' || (Array.isArray(entry.tags) && entry.tags.includes('paper'))));
    if (found) return found;
  }
  return null;
}

/** The stage a card says it is, by its id (a focus card is the area's): null for an id no path knows. */
function stageOf(card) {
  if (card.card === 'focus') return 'area';
  const { id } = questionOf(card);
  return Object.hasOwn(AFTER, id) ? id : null;
}

/**
 * One turn of any agent, read from the line (`text`, what follows "@bart", "@brainstorm" or "@discover"; an `@orient`
 * line is asked as @brainstorm) before anything runs → { agent, brainstorm, question, provider, steps, pinned, prior,
 * asked, shown, extra, mode, path, paper, stage }. `prior` is what the session is kept under; `shown` and `asked` are what
 * the agent is sent: an empty line is the opening, each brainstorm turn is told its path and which card to ask, and each
 * discover turn how far to trace. `entries`: the library the turn is shown (./context.cjs buildContext), which
 * @brainstorm's path is read against.
 */
function turnPlan({ agent, text, turns, choice, entries = [] }, models) {
  const brainstorm = agent === 'brainstorm', discover = agent === 'discover';
  const prior = cleanTurns(turns, { keepEmpty: brainstorm || discover });
  // @discover's mode, and the level it runs on, is the one the line names, else the one an earlier turn named (readDiscover).
  const read = brainstorm ? readBrainstorm(text, models) : discover ? readDiscover(text, models, prior) : readQuestion(choice ? withChoice(text, models, choice) : text, models);
  if (discover) {
    return {
      agent, brainstorm, ...read, prior,
      asked: read.question || DISCOVER_OPENING,
      shown: prior.map((turn) => ({ ...turn, question: turn.question || DISCOVER_OPENING })),
      extra: `<mode>${MODE_LIMITS[read.mode]}</mode>`,
    };
  }
  if (!brainstorm) return { agent: 'bart', brainstorm, ...read, prior, asked: read.question, shown: prior, extra: '' };
  // Which card comes next is decided here, never by the model (round 7; 2026-10-05). The path is read from the exchange's
  // opening, its first line since the last recap (after a recap the next line opens again), against the library this turn
  // is shown. Each card since then leads to the next by its id (AFTER), whatever the path, so a first card the agent gave
  // way to thin goes on from thin, and an older document's card goes on from what it asked. A card whose id no path knows
  // goes on from the stage it was asked as. A draft leads to versions only when it was answered, else to the recap. Wrap
  // up, or five cards asked (skips count), gets the recap.
  const from = cardsFrom(prior), cards = prior.slice(from);
  const opening = from < prior.length ? readBrainstorm(prior[from].question, models).question : read.question;
  const paper = mentionedPaper(opening, entries), path = !opening.trim() ? 'open' : paper ? 'paper' : 'topic';
  const said = (n) => (n + 1 < cards.length ? readBrainstorm(cards[n + 1].question, models).question : read.question);
  let stage = BRAINSTORM_PATHS[path][0];
  cards.forEach((turn, n) => {
    const card = cardOfAnswer(turn.answer), was = stageOf(card) || stage;
    stage = was === 'draft' ? (readAnswer(said(n), card).skipped ? 'recap' : 'versions') : AFTER[was] || 'recap';
  });
  if (readWrap(read.question).wrap || cards.length >= MAX_BRAINSTORM_CARDS) stage = 'recap';
  return {
    agent, brainstorm, ...read, prior, path, paper, stage, close: stage === 'recap' ? 'recap' : null,
    asked: read.question || OPENING,
    shown: prior.map((turn) => ({ ...turn, question: turn.question || OPENING })),
    extra: `<path>${path}</path>\n<stage>${stage}</stage>`,
  };
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

/**
 * The config.toml of a private Codex home: the MCP servers it starts (`servers` { name: { command, args, env } }), and
 * nothing else. A string in TOML is written as JSON writes one. Written only when it changes.
 */
function writeCodexConfig(home, servers) {
  const toml = (value) => (Array.isArray(value) ? `[${value.map(toml).join(', ')}]` : JSON.stringify(String(value)));
  const lines = ['# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.'];
  for (const [name, server] of Object.entries(servers)) {
    lines.push('', `[mcp_servers.${name}]`, `command = ${toml(server.command)}`, `args = ${toml(server.args)}`, `env = { ${Object.entries(server.env || {}).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')} }`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 90');
  }
  const text = `${lines.join('\n')}\n`, file = path.join(home, 'config.toml');
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== text) fs.writeFileSync(file, text, { mode: 0o600 });
}

/**
 * The reply as the document keeps it, by agent: @brainstorm's card or recap (./card.cjs cardBody);
 * @discover's card when it asked one, else its guide as it came; @bart's answer as it came.
 */
function replyBody(agent, text) {
  if (agent === 'brainstorm') return cardBody(text).body;
  if (agent === 'discover') {
    const card = /^\s*(\{|```)/.test(String(text)) ? readCard(text) : null;
    if (card && card.card !== 'none') return cardBody(text).body;
    // A guide starts at its first "## " heading (round 2): a status line or an account of the run written before it is dropped.
    const lines = String(text).split('\n'), at = lines.findIndex((line) => line.startsWith('## '));
    return at > 0 ? lines.slice(at).join('\n') : String(text);
  }
  return String(text);
}

/** A pick handed on to be kept; keeping it never stands in a question's way. */
function remember(onPicked, step) {
  try { onPicked({ provider: step.provider, model: step.key, effort: step.effort }); } catch { /* a convenience only */ }
}

/** What a step beginning shows while the turn runs: @brainstorm's model is fixed and never named (2026-10-02, B-05). */
function stepShown(agent, onProgress) {
  if (!QUIET.has(agent) || !onProgress) return onProgress;
  return ({ name, effort, ...rest }) => onProgress(rest);
}

// `tools` (../tools/manager.cjs, optional): a question waits for an install or update of its CLI to end and
// holds one off while it runs, a stale check is redone in the background, and a CLI the login shell's PATH
// does not reach is run by its full path. `onPicked({ provider, model, effort })`: a question asked with a model or an
// effort picked by hand (flags, or Regenerate's choice), so the next question starts there (./choices.cjs).
// `brainstormThreads` and `brainstormCodexHome`: @brainstorm's sessions, apart from @bart's (two idle hours; its own
// AGENTS.md, which a Codex home holds one of). `discoverThreads` and `discoverCodexHome` the same for @discover, whose home
// also holds the config.toml that gives Codex the paper tools.
// `papersServer`: the MCP server's script, run by `node` (Engelbart's own executable, as Node).
function createBart({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-bart-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-bart'), brainstormCodexHome = `${codexHome}-brainstorm`, discoverCodexHome = `${codexHome}-discover`, codexAuthFile, run = execFile, threads = createThreads(), brainstormThreads = createThreads({ idleMs: BRAINSTORM_IDLE_MS }), discoverThreads = createThreads({ idleMs: DISCOVER_IDLE_MS }), tools = null, onPicked = () => {}, node = process.execPath, papersServer = PAPERS_SERVER } = {}) {
  const shell = resolveShell(environment);
  // The CLI by name, or by the full path the tool check found it at when PATH misses it (then through the environment, never quoted).
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const running = new Map(); // askId → AbortController
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...(tools && tools.environment ? tools.environment() : {}), ...extra }; // Engelbart's own Git, when it stands in (../tools/bundled-git.cjs)
  };
  // execFile still collects stdout for the result; the same stream is also read line by line as it arrives.
  const execute = (command, cwd, env, signal, onEvent, timeout = STEP_TIMEOUT_MS) => new Promise((resolve) => {
    const child = run(shell, loginShellArgs(shell, command, env), { cwd, env, timeout, maxBuffer: 64 * 1024 * 1024, signal }, (error, out) => resolve({ stdout: out, failure: error }));
    if (onEvent && child && child.stdout) child.stdout.on('data', eventReader(onEvent));
  });
  // The paper tools' MCP server, as either CLI is told to start it.
  const papers = { command: node, args: [papersServer], env: { ELECTRON_RUN_AS_NODE: '1' } };
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');
  const stopped = (signal) => signal && signal.aborted;

  // Every flag is a literal, every value arrives through the environment: nothing is quoted by hand.
  // `effort` is one of six known words (./question.cjs). `resume`: the id of a session to go on with. `mcp`: the paper
  // tools too (@discover), from a config written next to the prompt.
  function claudeTurns({ system, cwd, dirs, stem, signal, short, onUpdate, resume, allowed = CLAUDE_TOOLS, mcp = false, timeout }) {
    const promptFile = `${stem}.system.md`, mcpFile = `${stem}.mcp.json`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    if (mcp) fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { papers } }), { mode: 0o600 });
    const id = resume || randomUUID();
    const grants = dirs.map((_, n) => `--add-dir "$ENGELBART_BART_DIR${n}"`).join(' ');
    return {
      done: () => { for (const file of [promptFile, mcpFile]) { try { fs.unlinkSync(file); } catch { /* already gone */ } } },
      turn: async ({ level, message, session }) => {
        fs.writeFileSync(`${stem}.input.txt`, message, { mode: 0o600 });
        // --tools names the built-in tools; the paper tools are allowed by their server's prefix.
        const servers = mcp ? ' --mcp-config "$ENGELBART_BART_MCP"' : '', granted = mcp ? `${allowed},${PAPER_TOOLS}` : allowed;
        const command = `exec ${program('claude')} -p --output-format stream-json --verbose --include-partial-messages ${session ? '--resume' : '--session-id'} "$ENGELBART_BART_SESSION" --restricted --setting-sources "" --strict-mcp-config${servers} --tools "${allowed}" --allowedTools "${granted}" ${grants} --model "$ENGELBART_BART_MODEL" --effort ${level.effort} --system-prompt-file "$ENGELBART_BART_PROMPT" < "$ENGELBART_BART_INPUT"`;
        const env = childEnvironment({ ...programEnv('claude'), ENGELBART_BART_SESSION: id, ENGELBART_BART_MODEL: level.model, ENGELBART_BART_PROMPT: promptFile, ENGELBART_BART_INPUT: `${stem}.input.txt`, ...(mcp ? { ENGELBART_BART_MCP: mcpFile } : {}), ...Object.fromEntries(dirs.map((dir, n) => [`ENGELBART_BART_DIR${n}`, dir])) });
        const { stdout, failure } = await execute(command, cwd, env, signal, (event) => onUpdate(claudeUpdate(event, short)), timeout);
        if (stopped(signal)) throw new BartError('stopped', 'Stopped.');
        const result = lastResultLine(stdout);
        if (!result) throw new BartError('unavailable', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
        if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new BartError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 300));
        return { text: result.result, session: id };
      },
    };
  }

  // `mcp`: the paper tools too (@discover), from the private home's config.toml, which holds nothing else.
  function codexTurns({ system, cwd, stem, signal, short, onUpdate, home = codexHome, web = true, mcp = false, timeout }) {
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome: home, source, instructions: system })) throw new BartError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
    writeCodexConfig(home, mcp ? { papers } : {});
    const outFile = `${stem}.out.txt`;
    return {
      done: () => { try { fs.unlinkSync(outFile); } catch { /* none */ } },
      turn: async ({ level, message, session }) => {
        fs.writeFileSync(`${stem}.input.txt`, message, { mode: 0o600 });
        try { fs.unlinkSync(outFile); } catch { /* none */ }
        const shared = `--skip-git-repo-check -m "$ENGELBART_BART_MODEL" -c 'model_reasoning_effort="${level.effort}"' -c 'sandbox_mode="read-only"' -c 'tools.web_search=${web}' -c project_doc_max_bytes=0 --json -o "$ENGELBART_BART_OUTPUT" - < "$ENGELBART_BART_INPUT"`;
        const command = session ? `exec ${program('codex')} exec resume "$ENGELBART_BART_SESSION" ${shared}` : `exec ${program('codex')} exec --color never ${shared}`;
        const env = childEnvironment({ ...programEnv('codex'), CODEX_HOME: home, ENGELBART_BART_SESSION: session || '', ENGELBART_BART_MODEL: level.model, ENGELBART_BART_OUTPUT: outFile, ENGELBART_BART_INPUT: `${stem}.input.txt` });
        const { stdout, failure } = await execute(command, cwd, env, signal, (event) => onUpdate(codexUpdate(event, short)), timeout);
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
   * `agent`: 'bart', 'brainstorm' or 'discover'; all but @bart may be asked with nothing on the line and reply with cards.
   */
  async function ask(ctx, projectId, { askId, ref, workspaceId, text, turns, choice, agent = 'bart' }, { onProgress } = {}) {
    const models = readModels();
    const bart = agent === 'bart';
    // The context first: @brainstorm's path is read against the library it shows (turnPlan).
    const context = await buildContext(ctx, projectId, { ref, workspaceId, askId, agent });
    const { question, provider, steps, pinned, prior, asked, shown, extra, mode } = turnPlan({ agent, text, turns, choice: bart ? choice : null, entries: context.entries }, models);
    if (!question && bart) throw new BartError('failed', 'There is no question on the line.');
    if (pinned && bart) remember(onPicked, steps[0]);
    const store = { bart: threads, brainstorm: brainstormThreads, discover: discoverThreads }[agent];
    const held = prior.length ? store.take(threadKey(projectId, ref, prior), provider) : null;
    const sent = await withImagePaths(ctx, projectId, asked);
    const cwd = path.join(runDirectory, projectId);
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const stem = path.join(cwd, `ask-${randomUUID()}`);
    const controller = new AbortController();
    running.set(askId, controller);
    const feed = createFeed({ onProgress });
    const once = async (session) => {
      let cli = null;
      try {
        const only = {
          bart: {},
          brainstorm: { allowed: BRAINSTORM_TOOLS, home: brainstormCodexHome, web: false },
          discover: { home: discoverCodexHome, mcp: true, timeout: mode === 'deep' ? DEEP_DISCOVER_TIMEOUT_MS : DISCOVER_TIMEOUT_MS },
        }[agent];
        cli = (provider === 'anthropic' ? claudeTurns : codexTurns)({ system: loadSystemPrompt(ctx.dataRoot, agent), cwd, dirs: context.dirs, stem, signal: controller.signal, short: pathLabeller(context.dirs), onUpdate: feed.take, resume: session, ...only });
        return await climb({ steps, pinned, first: firstMessage({ context, prior: shown, question: sent, resumed: !!session, extra }), session, turn: (input) => { feed.reset(); return cli.turn(input); }, onProgress: stepShown(agent, onProgress) });
      } finally { if (cli) cli.done(); }
    };
    const cliName = TOOL_OF[provider];
    // While it runs, the CLI is not installed or updated under it (the tool lock); a CLI that was not found is looked for again.
    const guarded = async (session) => {
      if (!tools) return once(session);
      try {
        return await tools.use(cliName, () => once(session));
      } catch (error) {
        if (error && error.kind === 'unavailable') void tools.check([cliName]).catch(() => {});
        throw error;
      }
    };
    if (tools) await tools.ensure(cliName);
    try {
      let out;
      // A session that will not resume (its file is gone, the CLI changed) is not the person's problem: start again from the document.
      try { out = await guarded(held ? held.session : null); } catch (error) { if (!held || error.kind === 'stopped') throw error; out = await guarded(null); }
      const meta = { provider, level: { name: out.level.name, effort: out.level.effort, model: out.level.model }, trail: out.trail.map((step) => ({ name: step.name, effort: step.effort, why: step.why })), ms: out.ms, pinned };
      // A card is written as its JSON in a fence; a reply that is not one, as it came (the editor draws it as an answer).
      const body = replyBody(agent, out.text);
      // Kept under what the document will say once this answer is in it: the next follow-up is found by that.
      if (out.session) store.keep(threadKey(projectId, ref, [...prior, { question: String(text).trim(), answer: answerText(body) }]), { provider, session: out.session, projectId, workspaceId });
      return { lines: replyLines(body, meta, { model: !QUIET.has(agent) }), meta };
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

/**
 * A sentence of the person's own in the documents that holds `subject` (in any case), for the fake @brainstorm's first
 * card to give way on (2026-10-05): from a line of theirs, not an agent's line, the marked line or a mentioned file; one
 * ending in ".", "!" or "?". '' when there is none, or the subject is too short to look for.
 */
function ownSentence(documents, subject) {
  const needle = String(subject || '').trim().toLowerCase();
  if (needle.length < 4) return '';
  let depth = 0;
  for (const line of String(documents || '').split('\n')) {
    if (/^<file\s/.test(line)) { if (!/\/>$/.test(line)) depth += 1; continue; }
    if (line === '</file>') { depth = Math.max(0, depth - 1); continue; }
    if (depth || /^(?:@(?:bart|brainstorm|orient|discover)\b|bart[+?~]?>|<|\[agent reply omitted\]|#)/i.test(line)) continue;
    const found = (line.match(/[^.!?]+[.!?]/g) || []).find((sentence) => sentence.toLowerCase().includes(needle));
    if (found) return found.trim();
  }
  return '';
}

/**
 * The fake @brainstorm's reply (BS-13, MB-12, round 3; 2026-10-05, @orient folded in), as a model would write it: the card
 * turnPlan's stage names, on the exchange's path. The area card (open path) has a reading in two sentences and broad
 * areas from the workspace and what its library holds; with nothing in the library it says there is little to go on and
 * asks the same question as an open card. Then open cards, each with its stage as its id: what they know about the
 * subject (the opening's words, a mention as its name; the area picked; else "this") or, on the paper path, what they
 * took from the paper; where that thins out, on their words (with a paper, naming a section, never what it says); their
 * question in one sentence; and an mcq of versions: their draft as written, then the draft with "specifically" put in.
 * The first card gives way to thin when a line of their own in the workspace holds a sentence with the subject in it,
 * which "say" quotes. Then the recap: what they know (on the paper path, took from it), where it thins out, and their
 * question (the version picked, the words typed on that card, else the draft; "not written yet" without one). No card or
 * recap suggests a search (MATH-31). A line containing "malformed" gets a reply that is not a card.
 */
function fakeCard(context, plan, models) {
  if (/malformed/i.test(plan.question)) return 'FAKE REPLY that is not a card: {"say": "cut off';
  const from = cardsFrom(plan.prior);
  // What they said on each card since the last recap, in order, by the stage its id names (a focus card is the area's).
  const answers = [];
  for (let n = from; n < plan.prior.length; n += 1) {
    const card = cardOfAnswer(plan.prior[n].answer);
    const next = n + 1 < plan.prior.length ? plan.prior[n + 1].question : String(plan.text).trim();
    answers.push({ id: card.card === 'focus' ? 'area' : questionOf(card).id, say: card.say, ...readAnswer(readQuestion(next, models).question, card) });
  }
  const words = (answer) => (!answer || answer.skipped ? '' : [answer.picks.join(', '), answer.text, answer.note].filter(Boolean).join('; '));
  const of = (...ids) => answers.find((answer) => ids.includes(answer.id));
  // The sentence of theirs a thin card asked first quoted, which stands for what they know.
  const quoted = ((of('thin') || {}).say || '').match(/^You wrote: "(.+)"$/);
  const knew = words(of('know', 'took')) || (quoted ? quoted[1] : ''), thin = words(of('thin', 'puzzle', 'interest')), draft = words(of('draft'));
  const ask = (id, type, title, say, extra = {}) => JSON.stringify({ say, card: 'questions', questions: { eyebrow: 'your question', items: [{ id, type, title, ...extra }] }, ready: false });
  if (plan.stage === 'recap') {
    const versions = of('versions'), chosen = versions && !versions.skipped ? versions.picks[0] || versions.text : '';
    const question = chosen || draft;
    return JSON.stringify({ say: [`${plan.path === 'paper' ? 'What you took from it' : 'What you know'}: ${knew || 'not said'}`, `Where it thins out: ${thin || 'not said'}`, `Your question: ${question || 'not written yet'}`].join('\n'), card: 'none', ready: true });
  }
  if (plan.stage === 'area') {
    const names = context.entries.map((entry) => entry.name).slice(0, 2);
    if (!names.length) return ask('area', 'open', 'Where do you want to find a question?', `There is little of your own writing in “${context.workspaceName}” to go on yet.`, { placeholder: 'In your own words…' });
    const say = `You seem to have settled what “${context.workspaceName}” is for. What still looks open is how ${names.join(' and ')} ${names.length > 1 ? 'fit' : 'fits'} into it.`;
    const options = [`What “${context.workspaceName}” is trying to do`, ...names.map((name) => `How ${name} fits in`), 'How you would know it worked'];
    return JSON.stringify({ say, card: 'focus', focus: { title: 'Where do you want to find a question?', options: options.map((label) => ({ label })) }, ready: false });
  }
  // The subject: the opening's words, each mention as its name, beside the paper's (the paper's name when there are
  // none); on the open path, the area picked.
  const opening = from < plan.prior.length ? readQuestion(plan.prior[from].question, models).question : plan.question;
  const paper = plan.paper ? plan.paper.name : '';
  const beside = opening.replace(/@\[([^\]\n]+)\](?:\(ws:[\w-]+\))?/g, (token, name) => (paper && name.toLowerCase() === paper.toLowerCase() ? ' ' : name)).replace(/\s+/g, ' ').trim();
  const subject = (plan.path === 'open' ? words(of('area')) : beside || paper).slice(0, 80);
  if (plan.stage === 'know' || plan.stage === 'took') {
    const own = ownSentence(context.documents, plan.path === 'paper' ? beside : subject);
    if (own) return ask('thin', 'open', 'What would you need to find out to be sure of it?', `You wrote: "${own}"`, { placeholder: 'In your own words…' });
    if (plan.stage === 'took') return ask('took', 'open', `What did you take from “${paper || subject}”?`, '', { placeholder: 'In your own words…' });
    return ask('know', 'open', `Write what you know about ${subject ? `“${subject}”` : 'this'}, as you would explain it to a colleague.`, '', { placeholder: 'In your own words…' });
  }
  if (plan.stage === 'thin') {
    const part = knew.slice(0, 60), section = plan.path === 'paper' ? ' That sits with the paper’s Method section.' : '';
    return ask('thin', 'open', part ? `You wrote “${part}”.${section} What would you need to find out to be sure of it?` : 'Which part of this are you least sure of, and what would you need to find out to be sure of it?', '', { placeholder: 'In your own words…' });
  }
  if (plan.stage === 'draft') {
    return ask('draft', 'open', 'Write what you want to find out as one question, in one sentence.', thin ? `You said “${thin.slice(0, 60)}”.` : '', { placeholder: 'Your question…' });
  }
  // versions: their draft word for word, then one version of it with "specifically" put in after its first word; when the
  // draft already says it there is no version to make, and the card asks them to read it again.
  if (/\bspecifically\b/i.test(draft)) return ask('versions', 'open', 'Read your question once more. Would you change anything?', '', { placeholder: 'Your question…' });
  const parts = draft.match(/^(\S+)\s+([\s\S]+)$/);
  const narrower = parts ? `${parts[1]} specifically ${parts[2]}` : draft.replace(/\??$/, ' specifically?');
  return ask('versions', 'mcq', 'Which one is your question?', '', { options: [{ label: draft, why: 'as you wrote it' }, { label: narrower, why: 'narrower' }] });
}

/**
 * The fake @discover's reply, as a model would write it. An @discover line with no problem gets one card first (which
 * part, in broad areas; 2026-09-30, one card, no longer a second of starting points); its answer, its skip or a line
 * that names a problem gets a guide in three-line entries, whose first entry is what the person wrote in their own words
 * on the card, if they did, then the first library item, by its path when it has one, with a section to find in it
 * (`#find=…&to=…`, round 2), and an "## Essays" group of one essay, its Read a link to its first paragraph's words with
 * no `&to=` (2026-10-03). Each Why says what the passage gives and the open question it bears on (round 3). The classic
 * was read in full and carries a Try line, its authors' repository (2026-10-04). A follow-up on a guide gets additions.
 * A question holding a mention (`@[Name]`, with or without words beside it; 2026-10-04) names a paper: no card, and a
 * guide that opens with "## This paper", the library item by its path, two sections best first, each its own Read and
 * Why, then a classic it cites, a paper that cites it and an essay; a follow-up that names one gets the same.
 * Nothing is looked up: every entry says it is fake.
 */
function fakeDiscover(context, plan) {
  const guided = plan.prior.length > 0 && /^## /.test(plan.prior[plan.prior.length - 1].answer);
  let from = plan.prior.length;
  while (from > 0 && cardOfAnswer(plan.prior[from - 1].answer)) from -= 1;
  const cards = plan.prior.length - from, skipped = plan.question.trim() === SKIPPED;
  // Title, Read and Why; Read names a section by a link to its first words, or says the fake only had the abstract.
  // Why: what the passage gives (a method, a measurement, a design…) and the open question it bears on; never the person's words.
  const why = (gives) => `**Why:** a fake ${gives} to set against the open question in “${context.workspaceName}” of how to tell the work is going well.`;
  const entry = (title, address, section, words, to, gives = 'method') => [
    `**[${title}](${address})** · Fake Author et al. · 2024`,
    `**Read:** ${section ? `[${section}](${address}#find=${encodeURIComponent(words)}${to ? `&to=${encodeURIComponent(to)}` : ''})` : 'abstract only'}`,
    why(gives),
  ];
  // An essay: one author, a year or "undated"; Read is a heading with the words of its first paragraph, no &to= (a web page ignores it).
  const essay = (title, address, heading, words, gives) => [
    `**[${title}](${address})** · Fake Essayist · undated`,
    `**Read:** [${heading}](${address}#find=${encodeURIComponent(words)})`,
    why(gives),
  ];
  // An item's place: a path is written percent-encoded, so a space ends no link.
  const where = (item) => (item.path ? item.path.split('/').map(encodeURIComponent).join('/') : item.url);
  const classic = (label) => [
    ...entry(`A fake classic${label} (${plan.mode} mode)`, 'https://example.org/fake-classic', 'Implementation', 'a fake passage on how it was built', 'the fake evaluation after it', 'term for what is being handled'),
    '**Try:** [fake-lab/fake-classic](https://github.com/fake-lab/fake-classic)',
  ];
  const essays = ['## Essays', '', ...essay('A fake essay', 'https://example.org/fake-essay', 'A fake heading', 'the fake first paragraph of the essay', 'case that cuts against what is assumed')];
  // A paper named by a mention (a workspace's, `(ws:…)`, is not one): its own sections first, best first, not in its order.
  const mention = String(plan.question).match(/@\[([^\]\n]+)\](?!\(ws:)/);
  if (mention) {
    const item = context.entries.find((row) => row.name === mention[1] && (row.path || row.url));
    const address = item ? where(item) : 'https://example.org/fake-named-paper.pdf';
    const pair = (section, words, to, gives) => [`**Read:** [${section}](${address}#find=${encodeURIComponent(words)}&to=${encodeURIComponent(to)})`, why(gives)];
    return [
      '## This paper', '',
      `**[${mention[1]}](${address})** · Fake Author et al. · 2024`,
      ...pair('5 Findings', 'a fake passage on what was found', 'the fake discussion after it', 'measurement'),
      ...pair('3 Method', 'a fake passage on how it was done', 'the fake findings after it', 'method'), '',
      '## Classics', '', ...classic(' it cites'), '',
      '## Recent', '', ...entry('A fake paper that cites it', 'https://example.org/fake-recent', 'Study', 'a fake passage on its study', 'the fake results after it', 'design to compare against'), '',
      ...essays,
    ].join('\n');
  }
  if (guided) return ['## Recent', '', ...entry('A fake later paper', 'https://example.org/fake-recent', null, '', '', 'measurement')].join('\n');
  const problem = cards > 0 ? plan.prior[from].question : plan.question; // the problem as first asked, not an answer to a card
  if (!String(problem || '').trim() && cards === 0) {
    return JSON.stringify({ say: '', card: 'focus', focus: { title: 'Which part do you want prior work on?', options: [{ label: `What “${context.workspaceName}” is trying to do`, why: 'the aim as a whole' }, { label: 'How others have measured it', why: 'ways to tell it worked' }, { label: 'What has been tried before', why: 'earlier attempts' }] }, ready: false });
  }
  // Words of their own in place of a pick name the problem (and any paper in them) and start the guide (A-05).
  const asked = cards >= 1 ? cardOfAnswer(plan.prior[from].answer) : null;
  const said = asked && !skipped ? readAnswer(plan.question, asked) : null;
  const own = said && !said.picks.length ? said.text : '';
  // A paper of the library first, else anything it has a place for.
  const first = context.entries.find((item) => item.type === 'pdf' && (item.path || item.url)) || context.entries.find((item) => item.path || item.url);
  return [
    '## Start here', '',
    ...(own ? [...entry(`A fake record for “${own.slice(0, 80)}”`, 'https://example.org/fake-named', null, '', '', 'design to compare against'), ''] : []),
    ...(first ? entry(first.name, where(first), 'Introduction', 'a fake passage the fake did not read', 'the fake section after it') : entry('A fake starting paper', 'https://example.org/fake-start.pdf', 'Introduction', 'a fake passage', 'the fake section after it')), '',
    '## Classics', '', ...classic(''), '',
    ...essays,
  ].join('\n');
}

/** Scripted runs only (ENGELBART_BART_FAKE=1): no model. A question containing "hard" moves up one step; one containing "code" is answered with a JSON code block too. @brainstorm runs fakeCard, @discover fakeDiscover. */
function createFakeBart({ readModels, delayMs = 1200, threads = createThreads(), brainstormThreads = createThreads({ idleMs: BRAINSTORM_IDLE_MS }), discoverThreads = createThreads({ idleMs: DISCOVER_IDLE_MS }), onPicked = () => {} }) {
  const waits = new Map();
  return {
    async ask(ctx, projectId, { askId, ref, workspaceId, text, turns, choice, agent = 'bart' }, { onProgress } = {}) {
      const models = readModels();
      const context = await buildContext(ctx, projectId, { ref, workspaceId, askId, agent });
      const plan = turnPlan({ agent, text, turns, choice: agent === 'bart' ? choice : null, entries: context.entries }, models);
      const { brainstorm, question, provider, steps, pinned, prior } = plan, discover = agent === 'discover';
      if (pinned && question && agent === 'bart') remember(onPicked, steps[0]);
      const store = { bart: threads, brainstorm: brainstormThreads, discover: discoverThreads }[agent];
      const held = prior.length ? store.take(threadKey(projectId, ref, prior), provider) : null;
      const message = firstMessage({ context, prior: plan.shown, question: await withImagePaths(ctx, projectId, plan.asked), resumed: !!held, extra: plan.extra });
      const pause = (ms) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); waits.set(askId, () => { clearTimeout(timer); reject(new BartError('stopped', 'Stopped.')); }); });
      const feed = createFeed({ onProgress, intervalMs: 0 });
      // The same kinds of update a real run sends, spread over the delay: two things done, then the answer in pieces. An
      // @brainstorm exchange on a paper opens it first, on its first turn.
      const opens = brainstorm && plan.paper && cardsFrom(prior) === prior.length ? [`Reading ${path.basename(plan.paper.path || plan.paper.name)}`] : [];
      const act = async (text) => {
        feed.reset();
        for (const activity of discover ? ['Reading notes.md', 'Looking up “fake”', 'Reading what cites “fake”'] : [...opens, 'Reading notes.md', QUIET.has(agent) ? 'Searching for “fake”' : 'Searching the web for “fake”']) { feed.take({ activity, log: true }); await pause(delayMs / 4); }
        feed.take({ textStart: true });
        const pieces = text.match(/[\s\S]{1,24}/g) || [];
        for (const delta of pieces) { feed.take({ delta }); await pause(delayMs / 2 / pieces.length); }
        return text;
      };
      try {
        const out = await climb({
          steps, pinned, onProgress: stepShown(agent, onProgress),
          first: message, session: held ? held.session : null,
          // What it was sent is what it reports: a resumed session gets the question alone, a new one gets everything.
          turn: async ({ message: sent }) => ({ session: 'fake', text: await act(brainstorm ? fakeCard(context, { ...plan, text }, models) : discover ? fakeDiscover(context, plan) : /hard/.test(question) && /step 1 of/.test(sent) ? 'ESCALATE: the question says it is hard' : `FAKE ANSWER to "${question}".\n\n## Seen\n- **${context.documents.length}** characters of documents\n- \`${steps.length}\` steps${prior.length ? `\n- ${/<conversation>/.test(sent) ? `a new session, given ${prior.length} earlier ${prior.length === 1 ? 'turn' : 'turns'}` : /<engelbart>/.test(sent) ? 'a new session, given no earlier turns' : 'the same session, given the question alone'}` : ''}${/code/.test(question) ? `\n\nThe same as JSON:\n\n\`\`\`json\n{\n  "fake": true,\n  "steps": ${steps.length},\n  "note": "# not a heading"\n}\n\`\`\`` : ''}`) }),
        });
        const meta = { provider, level: out.level, trail: out.trail, ms: out.ms, pinned };
        const body = replyBody(agent, out.text);
        store.keep(threadKey(projectId, ref, [...prior, { question: String(text).trim(), answer: answerText(body) }]), { provider, session: out.session, projectId, workspaceId });
        return { lines: replyLines(body, meta, { model: !QUIET.has(agent) }), meta };
      } finally { feed.end(); waits.delete(askId); }
    },
    stop(askId) { const cancel = waits.get(askId); if (cancel) cancel(); return !!cancel; },
    stopAll() { for (const cancel of waits.values()) cancel(); },
  };
}

module.exports = { createBart, createFakeBart, createThreads, threadKey, cleanTurns, turnPlan, climb, levelBlock, loadSystemPrompt, replyBody, writeCodexConfig, BartError, ESCALATE_RE, THREAD_IDLE_MS, BRAINSTORM_IDLE_MS, DISCOVER_IDLE_MS, DISCOVER_TIMEOUT_MS, DEEP_DISCOVER_TIMEOUT_MS, MODE_LIMITS, AGENTS, BRAINSTORM_PATHS, MAX_BRAINSTORM_CARDS };
