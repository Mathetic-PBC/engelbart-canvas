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
// person which of the two happened. MATH-54 follow-up (2026-10-06): a resumed @bart turn is sent the Stage and the
// highlights as they are now too (<stage>, <highlights>; ./context.cjs `now`), ahead of the question.
//
// @brainstorm (2026-09-30): the same run with another agent. Its own system prompt (./brainstorm-system-prompt.cjs),
// one fixed step (./models.cjs readBrainstorm; 2026-10-02: no flags, and its foot gives the time alone), file tools only,
// its own Codex home, and sessions of its own kept for two idle hours. It replies with one JSON card (./card.cjs), which is written as a fenced block the editor draws; a reply
// that does not parse is written as it came and reads as an @bart answer. An empty line asks it to start from the
// workspace. Round 7: each turn is told which card to ask as <stage>, so a session ends with a research question the
// person wrote. 2026-10-05: @orient folded in (an `@orient` line runs as @brainstorm; its sessions file is left unread).
// The exchange's path (<path>: paper, topic or open) is read here from its opening line against the library the turn is
// shown, and the next stage from the id of the last card asked (turnPlan). MATH-40 (2026-10-06): the stages are first,
// move (the agent picks which), versions and next; the person's answer to the next card is the result, written here
// with no model run (./card.cjs resultText). Its follow-up (2026-10-06): no card says anything above its question
// (brainstormReply writes `say` empty), the next card's title leads in with what they kept coming back to, and an answer
// to it that only repeats their first answer gets the again card, written here with no model run, before the result.
// MATH-40 round 3 (2026-10-06): a card's `say` is kept again, drawn in the card above its question: the agent's reply to
// what they just said. The next card's lead-in is its `say` (or, from an agent that put it there, its title's).
// 2026-10-14 (David's): an ordinary @brainstorm is a conversation, the same collaborator as Chat with a different job. No
// path, stage, card count or result: each turn is the question and the conversation so far (an older exchange's cards
// sent as text, ./card.cjs cardAsText), and the reply is prose, kept as Chat's is (replyBody). Only the Welcome
// walkthrough's exchange (welcomeHere) still runs as three cards, under a prompt of its own
// (./brainstorm-welcome-system-prompt.cjs, PROMPTS.welcome): turnPlan's welcome plan and welcomeReply.
//
// @discover (2026-09-30): the same again, for what to read about a problem. Its own prompt (./discover-system-prompt.cjs),
// one step (./question.cjs readDiscover: the level of the models file's `discover` block for its mode, on the provider the
// line or its exchange names with --claude or --codex, else @bart's; a follow-up stays on it and resumes), @bart's file and
// web tools and the paper tools (./papers.cjs, served by ./papers-mcp.cjs: to Claude Code by --mcp-config, to Codex by its
// own home's config.toml), its own sessions kept for two idle hours, and half an hour a step (three quarters, deep).
// 2026-10-14 (David's): it settles what to research in conversation first, in prose, in place of its card (an older
// exchange's cards are sent as text, ./card.cjs cardAsText). Once the direction is clear its reply ends with
// <research>…</research>, taken out here (takeResearch) and handed back as `research`; the window opens a research box
// on it (`@discover --research <direction>`, the line keeping the direction in the document), whose turn is the search:
// it alone carries <mode> (quick or deep when a line of the exchange said --quick or --deep, else standard) and
// <search>, and gets the guide, markdown written as an @bart answer is.
//
// @create (2026-10-13): the same run, for something new the person wants made (a page, a chart, a document, a dataset, a
// small script). Its own prompt (./create-system-prompt.cjs), @bart's models and steps (./models.cjs readQuestion; no
// setting of its own), no sessions kept (each turn starts from the document), ten minutes a step, and its working
// directory a draft folder of its own (./create.cjs), the one place it can write: Claude Code gets Write and Edit allowed
// there alone (permission rules on the folder's absolute path, --permission-mode dontAsk refusing the rest) and no Bash;
// Codex a workspace-write sandbox rooted there, with no other writable root (no /tmp, no $TMPDIR, no --add-dir) and no
// network. After a run that answered, what it wrote is kept in the library and the folder deleted (./create.cjs
// keepCreated); a run stopped or failed deletes the folder and keeps nothing. It runs here, not in Build: it never takes
// a Build slot.
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
const { WELCOME_SYSTEM_PROMPT } = require('./brainstorm-welcome-system-prompt.cjs');
const { DISCOVER_SYSTEM_PROMPT } = require('./discover-system-prompt.cjs');
const { createTrace } = require('./trace.cjs');
const { CREATE_SYSTEM_PROMPT } = require('./create-system-prompt.cjs');
const { CREATE_TIMEOUT_MS, openDraft, dropDraft, keepCreated, saveAllCreated, createdBody, createdSentence, requestSentence } = require('./create.cjs');
const { createMaking, createdLine } = require('./making.cjs');
const { readQuestion, readBrainstorm, readDiscover, withChoice } = require('./models.cjs');
const { readMode, readProvider, readRefine, modelOf, effortOf } = require('./question.cjs');
const { OPENING, NEXT_ID, NEXT_PLACEHOLDER, cardBody, cardOfAnswer, cardAsText, questionOf, readCard, readAnswer, resultText, parseJson } = require('./card.cjs');
const { plainTitle, capTitle } = require('./name-chat.cjs');
const { buildContext, conversationBlock } = require('./context.cjs');
const { projectSource, imagePaths } = require('../context/expand-mentions.cjs');
const { replyLines, answerText } = require('./reply.cjs');
const { checkCitations } = require('./cite.cjs');
const { openedBy, keepPageTexts, MAX_TEXT_CHARS } = require('./source-text.cjs');
const { toolCallsOf } = require('./runlog.cjs');
const { citeHref } = require('../../shared/passage-link.cjs');
const { clipMiddle } = require('./clip.cjs');
const { pathLabeller, claudeReader, codexUpdate, eventReader, createFeed } = require('./activity.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');
const { readGettingStarted } = require('../store/getting-started.cjs');
const { createRouter, createFakeRouter, markCorrected } = require('./route.cjs');

const STEP_TIMEOUT_MS = 15 * 60_000;
const DISCOVER_TIMEOUT_MS = 30 * 60_000;
// Opus max or Astra ultra, two hops from up to five starting points, may need longer (2026-10-02).
const DEEP_DISCOVER_TIMEOUT_MS = 45 * 60_000;
const THREAD_IDLE_MS = 30 * 60_000;
const BRAINSTORM_IDLE_MS = 2 * 60 * 60_000;
const DISCOVER_IDLE_MS = 2 * 60 * 60_000;
const MAX_TURNS = 40;
const ESCALATE_RE = /^ESCALATE:\s*(.{0,400})$/s;
const STEER_KEEP_MS = 10 * 60 * 1000; // how long a search stopped by a reply keeps its session for the run that goes on
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch';
const BRAINSTORM_TOOLS = 'Read,Grep,Glob';
// @create's: @bart's, and Write and Edit, which its permission rules allow in its draft folder alone (createRules).
const CREATE_TOOLS = `${CLAUDE_TOOLS},Write,Edit`;
// @discover's paper tools, as Claude Code names an MCP server's tools; the server, run by Engelbart's own executable as Node.
const PAPER_TOOLS = 'mcp__papers__*';
const PAPERS_SERVER = path.join(__dirname, 'papers-mcp.cjs');
const AGENTS = ['bart', 'brainstorm', 'discover', 'create'];
// `welcome`: the Welcome walkthrough's @brainstorm (2026-10-14: a prompt of its own, so the walkthrough's cards are not an
// ordinary Brainstorm's), a file of its own replacing it too. It is no agent: its runs are @brainstorm's.
const PROMPTS = { bart: ['bart-system-prompt.md', BART_SYSTEM_PROMPT], brainstorm: ['brainstorm-system-prompt.md', BRAINSTORM_SYSTEM_PROMPT], discover: ['discover-system-prompt.md', DISCOVER_SYSTEM_PROMPT], create: ['create-system-prompt.md', CREATE_SYSTEM_PROMPT], welcome: ['brainstorm-welcome-system-prompt.md', WELCOME_SYSTEM_PROMPT] };
// The agents on one fixed step whose model is never named, while they run or in their foot (2026-10-02, B-05).
const QUIET = new Set(['brainstorm']);
// The Welcome walkthrough's exchange (2026-10-10, "what are you working on? / where are you in the process? / what are
// your next steps?"): someone's first, started for them by the walkthrough's Brainstorm (an empty @brainstorm line in the
// walkthrough's workspace while the walkthrough shows), moments after Connect brought their library in. Three cards: what
// they are working on (the agent's, its title fixed), where they are in the process (written by code, no model run), and
// their next steps (the next card under its own title). Their answer is the result, which the window hands to @discover.
const WELCOME_CARDS = 3;
const WORKING_ID = 'working';
const WORKING_TITLE = 'What are you working on?';
const STAGE_ID = 'stage';
const STAGE_TITLE = 'Where are you in the process?';
const STAGES = ['Just exploring', 'Reading what’s out there', 'I have a question I want to answer', 'Building or running something', 'Writing it up'];
const WELCOME_NEXT_TITLE = 'What are your next steps?';
// What an @discover line with nothing after it asks (2026-10-14: as @brainstorm's, a start; it asks what to research, a
// card of the workspace's themes).
const DISCOVER_OPENING = 'Start from this workspace.';
// A research box's turn, the search (2026-10-14): what it is told besides its <mode>.
const SEARCH_BLOCK = '<search>The direction is settled: search on the one in <question> now, and reply with the reading guide.</search>';
// A Refine turn (2026-10-15, David), and every turn after it until the next search: the person is correcting or developing
// the direction (the prompt's "Refining the direction"). `current`: the direction last searched, when there was one.
const refineBlock = (current) => `<refine>The person is refining the research direction${current ? `. The direction last searched: ${current}` : ''}. Their latest words take precedence over anything said before.</refine>`;
// How far each mode traces (the prompt's <mode>), and how many of its sources are essays when essays apply (2026-10-03):
// a share of the same total, so papers no longer use it all. (2026-10-04 to 2026-10-15 it also said how many papers could
// be opened only to look for code; Discover no longer looks.)
const MODE_LIMITS = {
  quick: 'quick. Up to two starting points; one hop backward and one forward from each; at most five sources in the guide, of which up to two are essays when essays apply.',
  standard: 'standard. Up to three starting points; one hop backward and one forward from each; at most eight sources in the guide, of which two to three are essays when essays apply.',
  deep: 'deep. Up to five starting points; one hop backward and one forward from each, then one more of each from the best of what you found; at most fifteen sources in the guide, of which three to five are essays when essays apply.',
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
 * A turn as it is told and as its session is kept by (threadKey): trimmed, a question past 8,000 characters or an answer
 * past 20,000 cut in the middle, its start and end kept (./clip.cjs, 2026-10-06; before, an answer kept its start alone).
 * `agent` (2026-10-13): the agent that answered it, when the document says; never part of threadKey.
 */
// An @discover research box's line (2026-10-13; src/renderer/model/doc.js isResearch) is `@discover --research <problem>`:
// the flag says where the editor draws it, and is never part of the question.
const RESEARCH_RE = /(^|\s)--research(?=\s|$)/gi;
const withoutResearch = (text) => String(text == null ? '' : text).replace(RESEARCH_RE, '$1').replace(/\s+/g, ' ').trim();
/**
 * A research box's line with what the person said while it searched (2026-10-16, David: a reply under a running search
 * adjusts it, as one to Claude does, rather than starting it over): `--steer <words>` after its direction, once a reply.
 * Read anywhere but the run it steers, they are part of the direction.
 */
const steersShown = (text) => {
  const [head, ...more] = String(text == null ? '' : text).split(/\s+--steer\s+/i);
  return more.length ? `${head.trim()} (also: ${more.map((words) => words.trim()).filter(Boolean).join('; ')})` : head;
};
/**
 * What a search is told when it goes on, in its own session, with a reply sent while it ran; or with the level picked on
 * its box while it ran (`mode`, 2026-10-16, David), how far it now traces.
 */
const steerMessage = (words, mode = null) => [
  mode && MODE_LIMITS[mode] ? `While you were searching, the person changed how far to search:\n\n<mode>${MODE_LIMITS[mode]}</mode>` : '',
  words ? `While you were searching, the person added this:\n\n${words}` : '',
  `Take it into account and carry on from where you are. Keep what you found that still fits, ${words ? 'look further where it points' : 'search as far as the new level goes'}, and do not start the search over. Then write the guide as before.`,
].filter(Boolean).join('\n\n');
/** Whether an @discover line is a research box's, the search (2026-10-14). */
const isSearch = (text) => /(^|\s)--research(?=\s|$)/i.test(String(text == null ? '' : text));
// A Refine turn's line (2026-10-15) is told as what it is: the person correcting the direction.
const refineShown = (text) => { const read = readRefine(text); return read.refine ? `Refine the research direction: ${read.rest}` : String(text == null ? '' : text); };
const cleanTurn = (turn) => ({ question: clipMiddle(refineShown(withoutResearch(steersShown(turn.question))), 8000), answer: clipMiddle(String(turn.answer || '').trim(), 20000), ...(AGENTS.includes(turn.agent) ? { agent: turn.agent } : {}) });

/**
 * The earlier turns of an exchange as the renderer read them from the document, made safe: strings, bounded, no empty
 * questions. `keepEmpty`: @brainstorm's and @discover's, whose first line may say nothing and still be a turn.
 */
function cleanTurns(turns, { keepEmpty = false } = {}) {
  return (Array.isArray(turns) ? turns : []).filter((turn) => turn && typeof turn.question === 'string' && (keepEmpty || turn.question.trim()))
    .slice(-MAX_TURNS).map(cleanTurn);
}

/**
 * Whether a follow-up is asked of another agent than the one that answered the turn before it (2026-10-13: Bart handed it
 * elsewhere). Such a run starts a session of its own, told the earlier turns, each labelled with who answered it
 * (context.cjs conversationBlock), rather than resuming one.
 */
const switched = (prior, agent) => { const last = prior[prior.length - 1]; return !!(last && last.agent && last.agent !== agent); };

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
 * rest. `extra` goes in front of the level either way (@brainstorm's path and stage, @discover's mode). A resumed @bart
 * turn is also sent the Stage and the highlights as they are now (`context.now`, MATH-54 follow-up): what it was given
 * when the session started may be out of date.
 */
function firstMessage({ context, prior, question, resumed, extra = '', routed = null, agent = null, topic = null }) {
  const asked = [routedBlock(routed), topicBlock(topic), `<question>\n${question}\n</question>`].filter(Boolean).join('\n\n');
  if (resumed) return (level) => [extra, context.now, level, asked].filter(Boolean).join('\n\n');
  return (level) => [context.head, context.contextJson, context.mentionedFiles, context.documents, conversationBlock(prior, { agent }), extra, level, asked].filter(Boolean).join('\n\n');
}

// A line Bart, the router (./route.cjs), read as a request to build, with no spec above it to build from (2026-10-12): it
// is asked of Chat with this one block before <question>, and nothing else Chat is sent changes. Its last line asks
// whether to build it (2026-10-13: Build is no longer on the foot to press): a "yes" under it is a line Bart routes to
// build, the answer's fenced block the spec above it, and starts the Build with no reply of Chat's (2026-10-13, the
// editor's handOff). Older answers that end "Press [[build]] Build" still draw the hammer and build on a click
// (model/doc.js BUILD_TOKEN).
const ROUTED_BUILD = '<routed>The person wants this built. Write the Build prompt as one fenced code block, after at most two sentences. End with one short line asking whether they want you to build it, such as `Want me to build it?` Do not write [[build]] or tell them to press anything.</routed>';
// From 2026-10-13 to 2026-10-14 an @discover question was answered twice, Chat's reply first (told so by a
// <discover_intro> block) and Discover's search in a box under it, at once. Discover now says itself what it will look for,
// once it knows (turnPlan, takeResearch).
/** The block a routed turn carries before <question>: '' unless Bart routed it with build. */
const routedBlock = (routed) => (routed && routed.build ? ROUTED_BUILD : '');

/**
 * What a routed run's meta and its record say of the routing ({ id, build, corrected, failed }), or null when it was not
 * routed. `failed`: routing failed and this is the fallback (the editor's `by: 'error'`), with why when it is known.
 */
function routedOf(value) {
  if (!value || typeof value !== 'object') return null;
  return { id: value.id ? String(value.id) : null, build: !!value.build, corrected: value.corrected ? String(value.corrected) : null, ...(value.by === 'error' ? { failed: value.error ? String(value.error) : true } : {}) };
}

/** Where the cards at the end of `turns` begin: after the last recap, or the last reply that was not a card. */
function cardsFrom(turns) {
  let from = turns.length;
  while (from > 0 && cardOfAnswer(turns[from - 1].answer)) from -= 1;
  return from;
}

/** A card's id (a focus card is the first card's, "mind"). */
const idOf = (card) => (card.card === 'focus' ? 'mind' : questionOf(card).id);

/**
 * One turn of any agent, read from the line (`text`, what follows "@bart", "@brainstorm" or "@discover"; an `@orient`
 * line is asked as @brainstorm) before anything runs → { agent, brainstorm, question, provider, steps, pinned, prior,
 * asked, shown, extra, mode, path, paper, stage }. `prior` is what the session is kept under; `shown` and `asked` are what
 * the agent is sent: an empty line is the opening, each brainstorm turn is told its path and which card to ask, and each
 * discover turn how far to trace. `entries`: the library the turn is shown (./context.cjs buildContext), which
 * @brainstorm's path is read against.
 */
function turnPlan({ agent, text, turns, choice, entries = [], welcome = false }, models) {
  const brainstorm = agent === 'brainstorm', discover = agent === 'discover';
  const prior = cleanTurns(turns, { keepEmpty: brainstorm || discover });
  // @discover's mode, and the level it runs on, is the one the line names, else the one an earlier turn named (readDiscover).
  const named = brainstorm ? readBrainstorm(text, models) : discover ? readDiscover(withoutResearch(steersShown(text)), models, prior) : readQuestion(choice ? withChoice(text, models, choice) : text, models);
  // Regenerate's selector (2026-10-16, David) asks @brainstorm and @discover again on the model and effort picked there,
  // for that run alone: the line keeps its words, and Discover its mode.
  const picked = (brainstorm || discover) && choice ? modelOf(choice.model, models) : null, effort = picked ? effortOf(choice.effort) : null;
  const entry = picked ? models.providers[picked.provider] : null;
  const read = entry && effort && entry.efforts.includes(effort)
    ? { ...named, provider: picked.provider, pinned: false, steps: [{ provider: picked.provider, key: picked.model, model: entry.models[picked.model].id, name: entry.models[picked.model].name, effort }] }
    : named;
  // A turn settles what to research (2026-10-14), unless it is a research box's, which searches: that turn alone is told
  // how far to trace. An older exchange's card is sent as text.
  // A Refine turn, or a turn answering Discover's question about one (2026-10-15): told so, with the direction last searched.
  if (discover) {
    const search = isSearch(text), raw = (Array.isArray(turns) ? turns : []).map((turn) => String((turn && turn.question) || ''));
    const last = raw.map(isSearch).lastIndexOf(true), refine = readRefine(text).refine;
    const refining = !search && (refine || raw.slice(last + 1).some((question) => readRefine(question).refine));
    const current = last >= 0 ? withoutResearch(readProvider(readMode(raw[last]).rest).rest) : '';
    return {
      agent, brainstorm, ...read, prior, search, refine, refining,
      asked: read.question || DISCOVER_OPENING,
      shown: prior.map((turn) => { const card = cardOfAnswer(turn.answer); return { ...turn, question: turn.question || DISCOVER_OPENING, ...(card ? { answer: cardAsText(card) } : {}) }; }),
      extra: search ? `<mode>${MODE_LIMITS[read.mode]}</mode>\n\n${SEARCH_BLOCK}` : refining ? refineBlock(current) : '',
    };
  }
  // @create asks as @bart does, on @bart's models (2026-10-13).
  if (!brainstorm) return { agent: agent === 'create' ? 'create' : 'bart', brainstorm, ...read, prior, asked: read.question, shown: prior, extra: '' };
  // An ordinary @brainstorm (2026-10-14): the question and the conversation so far, nothing else. An empty line is the
  // opening; a card of an older exchange in it is sent as text (cardAsText), and decides nothing about this turn.
  const from = cardsFrom(prior);
  const opening = from < prior.length ? readBrainstorm(prior[from].question, models).question : read.question;
  if (!(welcome && !opening.trim())) {
    return {
      agent, brainstorm, ...read, prior, welcome: false,
      asked: read.question || OPENING,
      shown: prior.map((turn) => { const card = cardOfAnswer(turn.answer); return { ...turn, question: turn.question || OPENING, ...(card ? { answer: cardAsText(card) } : {}) }; }),
      extra: '',
    };
  }
  // The Welcome walkthrough's exchange (`welcome`, read by the caller; it opened with nothing typed): three cards. The
  // first and the next are the agent's, the stage card between them code's, with no model run; Wrap up on the first goes
  // straight to the next card, and their answer to the next card is the result, which the window hands to @discover.
  const cards = prior.slice(from);
  const last = cards.length ? cardOfAnswer(cards[cards.length - 1].answer) : null;
  const answer = last ? readAnswer(read.question, last) : null, lastId = last ? idOf(last) : null;
  const stage = !last ? 'first' : lastId === NEXT_ID ? 'result' : answer.wrap || cards.length >= WELCOME_CARDS - 1 ? 'next' : STAGE_ID;
  const result = stage === 'result' ? resultText(answer.skipped ? '' : [answer.picks.join(', '), answer.text, answer.note].filter(Boolean).join('; ')) : null;
  return {
    agent, brainstorm, ...read, prior, path: 'welcome', stage, result, close: stage === 'result' ? 'result' : null, welcome: true,
    // What is written in place of a reply, with no model run: the result, or the stage card.
    written: stage === STAGE_ID ? cardBody(stageCard()).body : result,
    asked: read.question || OPENING,
    shown: prior.map((turn) => ({ ...turn, question: turn.question || OPENING })),
    extra: `<path>welcome</path>\n<stage>${stage}</stage>\n<card>${cards.length + 1} of ${WELCOME_CARDS}</card>`,
  };
}

/** The Welcome walkthrough's last card: `lead`, the agent's lead-in, said above WELCOME_NEXT_TITLE, which code fixes. */
const nextCard = (lead = '', title = WELCOME_NEXT_TITLE) => JSON.stringify({ say: lead, card: 'questions', questions: { eyebrow: 'what next', items: [{ id: NEXT_ID, type: 'open', title, placeholder: NEXT_PLACEHOLDER }] }, ready: false });
/** The welcome path's second card, written by code: where they are in the process, one pick or their own words. */
const stageCard = () => JSON.stringify({ say: '', card: 'questions', questions: { eyebrow: 'where you are', items: [{ id: STAGE_ID, type: 'mcq', title: STAGE_TITLE, options: STAGES.map((label) => ({ label })) }] }, ready: false });

/**
 * What the Welcome walkthrough's @brainstorm replied, as the document keeps it: the first card is always "What are you
 * working on?" with the agent's `say` above it, and the next card always "What are your next steps?" with its lead-in
 * (its `say`); a card of another kind as it came, and a reply that is not a card as it came.
 */
function welcomeReply(text, stage) {
  const card = readCard(text), asked = card && card.card !== 'none' ? card : null;
  const say = asked && typeof asked.say === 'string' ? asked.say : '';
  if (stage === 'first') return JSON.stringify({ say, card: 'questions', questions: { eyebrow: 'to start', items: [{ id: WORKING_ID, type: 'open', title: WORKING_TITLE, placeholder: 'In your own words…' }] }, ready: false });
  if (stage === 'next') return nextCard(say);
  return asked ? JSON.stringify(asked) : text;
}

/**
 * The Welcome walkthrough's result, or its stage card, with no model run: what turnPlan wrote as the reply,
 * with the foot an answer has. The session the exchange ran in is let go (turnPlan's caller has taken it): it never saw
 * their sentence, so the next line starts a new one, given the document.
 */
function resultReply(plan) {
  const meta = { provider: plan.provider, level: { name: '', effort: '', model: '' }, trail: [], ms: 0, pinned: false };
  // The welcome path's result says so: the window asks @discover on it (screens/Workspace.jsx askBart).
  return { lines: replyLines(plan.written, meta, { model: false, agent: 'brainstorm' }), meta, ...(plan.welcome && plan.stage === 'result' ? { welcome: 'result' } : {}) };
}

/**
 * Whether an @brainstorm turn is the Welcome walkthrough's (WELCOME_CARDS): asked in its workspace's own document, while
 * the walkthrough shows (store/getting-started.cjs). turnPlan makes it the welcome path when the exchange opened empty.
 */
function welcomeHere(ctx, projectId, agent, ref, workspaceId) {
  if (agent !== 'brainstorm' || !ref || ref.kind !== 'workspace' || !workspaceId) return false;
  let state = null;
  try { state = readGettingStarted(ctx, projectId); } catch { return false; }
  return !!state && !state.hidden && state.workspaceId === workspaceId;
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
  // the sign-in linked into this home (auth.json), never a keychain entry of another home's
  const lines = ['# Written by Engelbart (src/main/bart/ask.cjs). Replaced on every run.', 'cli_auth_credentials_store = "file"'];
  for (const [name, server] of Object.entries(servers)) {
    lines.push('', `[mcp_servers.${name}]`, `command = ${toml(server.command)}`, `args = ${toml(server.args)}`, `env = { ${Object.entries(server.env || {}).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')} }`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 90');
  }
  const text = `${lines.join('\n')}\n`, file = path.join(home, 'config.toml');
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== text) fs.writeFileSync(file, text, { mode: 0o600 });
}

// A closing line like the foot the app writes (./reply.cjs attribution): "*Chat · Opus · high*". The model copies one it
// saw in the conversation (2026-10-13, Chat UX); the app adds the real one, which always ends with the time.
const COPIED_FOOT_RE = /^\*(Chat|Brainstorm|Discover|Create|Build)( · [^*]*)?\*$/;

/** The text without the copied feet it ends with, and the blank lines before them. */
function withoutCopiedFoot(text) {
  const lines = String(text).split('\n');
  let end = lines.length;
  while (end > 0 && (!lines[end - 1].trim() || COPIED_FOOT_RE.test(lines[end - 1].trim()))) end -= 1;
  if (lines.slice(end).every((line) => !line.trim())) return String(text);
  return lines.slice(0, end).join('\n');
}

/**
 * Chat's answer with its citations checked (2026-10-21, ./cite.cjs): each against what it cites, before the answer is
 * written into the document and before its thread is kept, so a follow-up finds the same answer. What was kept and what
 * was taken out is logged with the run. Build's replies, and the other agents', are as they came. Should the library not
 * be read, every citation is taken out: none is kept unchecked.
 */
/** Whether a reply's citations are checked: Chat's own answers, a highlight's included; not a Build's, Brainstorm's, Discover's or Create's. */
const citesChecked = (agent, routed) => agent === 'bart' && !(routed && routed.build);

async function citedBody(ctx, { agent, routed, body, projectId, workspaceId, prior, question, log, logId, context = null, events = [] }) {
  if (!citesChecked(agent, routed)) return body;
  const thread = { dataRoot: ctx.dataRoot, projectId, workspaceId, currentThread: [...(prior || []), { question }] };
  let checked;
  try {
    const library = await ctx.libraryDb.list();
    // What it read (2026-10-22, ./source-text.cjs): a whole source it cites must be among it; a page it read by its address
    // alone is kept first, so its quotes can be checked.
    const opened = context ? readWhileAnswering(context, events) : null;
    if (opened) await keepPageTexts(ctx, library, opened);
    const readRowText = (row) => ctx.libraryDb.textsFor([row.id], MAX_TEXT_CHARS).then((texts) => texts.get(row.id) || null);
    checked = await checkCitations(body, { ...thread, library, opened, readRowText });
  } catch {
    checked = await checkCitations(body, { ...thread, library: [], readText: () => null });
  }
  if (checked.kept.length || checked.dropped.length) log((runs) => runs.amend(logId, { citations: { kept: checked.kept, dropped: checked.dropped } }));
  return checked.body;
}

/**
 * What Chat read while it answered (./source-text.cjs openedBy), from its run's raw `events`: the files and pages its tools
 * opened, a kept text as its source, and the notes the documents mention, which its context held whole.
 */
function readWhileAnswering(context, events) {
  const entries = context.entries || [];
  return openedBy(events, {
    known: entries.map((entry) => entry.path).filter(Boolean),
    texts: new Map(entries.filter((entry) => entry.text).map((entry) => [entry.text, entry.path || entry.url])),
    full: entries.filter((entry) => entry.mentioned && entry.type === 'md').map((entry) => entry.path),
  });
}

/**
 * The reply as the document keeps it, by agent: @discover's card when it asked one, else its guide as it came;
 * @brainstorm's opening card (2026-10-16), its labels only and at most four, else its prose (2026-10-14, as Chat's); @bart's
 * and @create's answer as it came. Each loses a copied foot at its end. (The Welcome walkthrough's cards are kept by
 * welcomeReply and ./card.cjs cardBody.)
 */
function replyBody(agent, text) {
  if (agent === 'brainstorm' && /^\s*(\{|```)/.test(String(text))) {
    const card = readCard(text);
    if (card && card.card !== 'none') return cardBody(topicsOnly(String(text))).body;
  }
  if (agent === 'discover') {
    const card = /^\s*(\{|```)/.test(String(text)) ? readCard(text) : null;
    if (card && card.card !== 'none') return cardBody(text).body;
    // A guide starts at its first "## " heading (round 2): a status line or an account of the run written before it is dropped.
    const lines = withoutCopiedFoot(text).split('\n'), at = lines.findIndex((line) => line.startsWith('## '));
    return at > 0 ? lines.slice(at).join('\n') : lines.join('\n');
  }
  return withoutCopiedFoot(text);
}

// A Brainstorm conversation's topic (2026-10-14): Brainstorm ends a reply with `<topic>label</topic>` when the person
// first says what they want to talk about, or changes to another topic (its prompt, "# The conversation's topic"). The
// tag is taken out of the reply and its label goes back with the answer (`topic`), for the editor to write into the
// conversation's title line, which is what its chip shows. A reply without one leaves the topic as it is.
const TOPIC_TAG_RE = /<topic>([^<\n]*)<\/topic>/g;
/** → { text, topic }: the reply without its topic tags, and the last one's label as a title reads (or null). */
function takeTopic(text) {
  let label = null;
  const said = String(text == null ? '' : text);
  if (!said.includes('<topic>')) return { text: said, topic: null };
  const rest = said.replace(TOPIC_TAG_RE, (_, inner) => { label = inner; return ''; }).replace(/\s+$/, '');
  return { text: rest, topic: (label && capTitle(plainTitle(label))) || null };
}
// What Discover settled to research (2026-10-14): a reply that ends the conversation about it ends with
// `<research>direction</research>` (its prompt, "# First, the direction"). The tag is taken out of the reply and the
// direction goes back with the answer (`research`), for the window to open a research box on.
const RESEARCH_TAG_RE = /<research>([\s\S]*?)<\/research>/g;
/** → { text, research }: the reply without its research tags, and the last one's direction on one line (or null). */
function takeResearch(text) {
  let found = null;
  const said = String(text == null ? '' : text);
  if (!said.includes('<research>')) return { text: said, research: null };
  const rest = said.replace(RESEARCH_TAG_RE, (_, inner) => { found = inner; return ''; }).replace(/\s+$/, '');
  const research = found ? found.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  return { text: rest, research: research || null };
}
/** The block before <question> that says a Brainstorm conversation's topic, when it has one. */
const topicBlock = (topic) => (topic ? `<topic>${String(topic).replace(/[<>]/g, '')}</topic>` : '');

/**
 * The reply with what it hands back taken out: a Brainstorm conversation's topic (takeTopic); the direction Discover
 * settled on (takeResearch), which a search's own turn never hands back (its tag, if it wrote one, is dropped).
 * → { text, topic, research }
 */
function taken(agent, plan, text) {
  if (agent === 'brainstorm' && !plan.welcome) return { ...takeTopic(text), research: null };
  if (agent === 'discover') { const out = takeResearch(text); return { text: plan.search ? out.text : opened(plan, out.text), topic: null, research: plan.search ? null : out.research }; }
  return { text, topic: null, research: null };
}
// An empty @discover line with nothing in the workspace to make a card of is asked this alone (2026-10-14): the model
// sometimes says first why there is no card, which is dropped here.
const DISCOVER_QUESTION = 'What would you like to research?';
// The opening card's topics (2026-10-15, David): two to four, each a label alone, with no grey line saying where it came from.
const OPENING_TOPICS = 4;
/**
 * A bare opening's reply: a card keeps its topics' labels only, at most four; a reply that is not a card but asks the
 * question is the question alone. Anything else, and any later turn, as it came.
 */
function opened(plan, text) {
  const said = String(text || '');
  if (plan.question) return said;
  if (/^\s*(\{|```)/.test(said)) return topicsOnly(said);
  return said.includes(DISCOVER_QUESTION) ? DISCOVER_QUESTION : said;
}
function topicsOnly(said) {
  const card = parseJson(said), focus = card && card.focus;
  if (!focus || !Array.isArray(focus.options)) return said;
  const options = focus.options.map((option) => (typeof option === 'string' ? { label: option } : option && typeof option === 'object' ? { label: option.label } : null)).filter((option) => option && option.label).slice(0, OPENING_TOPICS);
  return JSON.stringify({ ...card, focus: { ...focus, options } });
}
/** What an answer hands back beside its lines: { topic } and { research } when there are. */
const handedBack = (named) => ({ ...(named.topic ? { topic: named.topic } : {}), ...(named.research ? { research: named.research } : {}) });

/** A pick handed on to be kept; keeping it never stands in a question's way. */
function remember(onPicked, step) {
  try { onPicked({ provider: step.provider, model: step.key, effort: step.effort }); } catch { /* a convenience only */ }
}

/** What a step beginning shows while the turn runs: @brainstorm's model is fixed and never named (2026-10-02, B-05). */
function stepShown(agent, onProgress) {
  if (!QUIET.has(agent) || !onProgress) return onProgress;
  return ({ name, effort, ...rest }) => onProgress(rest);
}

/** The run log's calls, or nothing without one: a call that throws is dropped, so the log never stands in a run's way. */
function logTo(runLog) {
  return (call) => { if (!runLog) return; try { call(runLog); } catch { /* the log only */ } };
}

/** What the run log starts a run with (./runlog.cjs): what the agent is told, block by block, before its first step. */
function runRecord({ id, agent, provider, projectId, question, system, context, shown, extra, mode, pinned, routed = null, place = null, reply = null }) {
  return {
    id, agent, provider, projectId, projectName: context.project ? context.project.name : '', workspaceName: context.workspaceName || '',
    question: String(question || ''), at: Date.now(), status: 'running', system, mode: mode || null, pinned: !!pinned,
    // How many turns of its conversation came before it (2026-10-13, the Agent Viewer's first message or reply): 0 is a first message.
    ...(Number.isInteger(reply) && reply >= 0 ? { reply } : {}),
    // Handed over by the router (./route.cjs): its record's id, and the agent the person picked instead of its pick.
    ...(routed && routed.id ? { routedFrom: routed.id } : {}), ...(routed && routed.corrected ? { corrected: routed.corrected } : {}),
    // Routing failed and the line came here as the fallback: not Bart's pick (Workspace routeLine, `by: 'error'`).
    ...(routed && routed.failed ? { routedBy: 'error', routeError: routed.failed === true ? null : routed.failed } : {}),
    // Where it was asked (2026-10-12, the Agent Viewer): { projectId, ref, line, text }, for its row's click.
    ...(place ? { place } : {}),
    context: { head: context.head, contextJson: context.contextJson, mentionedFiles: context.mentionedFiles, documents: context.documents, now: context.now, conversation: conversationBlock(shown, { agent }), extra, dirs: context.dirs },
    steps: [],
  };
}

/** One climb turn, as the run log sees it: the step and the message it is sent, then what it said and whether it asked to move up (climb's own test). */
async function loggedTurn(log, logId, input, turn) {
  const { level, message } = input;
  log((runs) => runs.step(logId, { model: level.model, name: level.name, effort: level.effort, input: message }));
  const out = await turn(input);
  log((runs) => { const text = String(out.text || '').trim(); runs.output(logId, { raw: out.text, escalated: text.length < 500 && ESCALATE_RE.test(text) }); });
  return out;
}

/** A row @create kept, as its run's meta and record name it. */
// (2026-10-14: a file kept with the project, not yet a row: its name, its type and where it is in its run's folder.)
const createdRow = (file) => ({ name: file.name, type: file.type, path: file.rel });

/**
 * @create's Claude Code permission rules: its read and web tools, and Write and Edit on `draft` (an absolute, real path)
 * and what is under it alone, written as Claude Code writes an absolute path in a rule ("//" then the path without its
 * leading "/"). With --permission-mode dontAsk a write anywhere else is refused, not asked.
 */
function createRules(draft) {
  const under = `/${path.resolve(draft)}/**`;
  return `${CLAUDE_TOOLS},Edit(${under}),Write(${under})`;
}

/**
 * @create's Codex settings (each a `-c key=value` in TOML): the workspace-write sandbox, its working directory the one
 * writable root (no other, not /tmp or $TMPDIR), no network from inside it, and no asking.
 */
const CREATE_CODEX = ['sandbox_mode="workspace-write"', 'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.network_access=false', 'approval_policy="never"'];

// `tools` (../tools/manager.cjs, optional): a question waits for an install or update of its CLI to end and
// holds one off while it runs, a stale check is redone in the background, and a CLI the login shell's PATH
// does not reach is run by its full path. `onPicked({ provider, model, effort })`: a question asked with a model or an
// effort picked by hand (flags, or Regenerate's choice), so the next question starts there (./choices.cjs).
// `brainstormThreads` and `brainstormCodexHome`: @brainstorm's sessions, apart from @bart's (two idle hours; its own
// AGENTS.md, which a Codex home holds one of). `discoverThreads` and `discoverCodexHome` the same for @discover, whose home
// also holds the config.toml that gives Codex the paper tools.
// `papersServer`: the MCP server's script, run by `node` (Engelbart's own executable, as Node).
// `runLog` (./runlog.cjs, optional): the Agent map's record of each run; none keeps nothing. It is told, and never changes,
// what each run is sent and does. `inspectPdf` and `onAdded(row)`: for what @create keeps in the library (a pdf read for
// whether it is a paper; a row made, so the sidebar reads the library again).
function createBart({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-bart-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-bart'), routerCodexHome = `${codexHome}-router`, brainstormCodexHome = `${codexHome}-brainstorm`, discoverCodexHome = `${codexHome}-discover`, createCodexHome = `${codexHome}-create`, makingCodexHome = `${codexHome}-making`, codexAuthFile, run = execFile, threads = createThreads(), brainstormThreads = createThreads({ idleMs: BRAINSTORM_IDLE_MS }), discoverThreads = createThreads({ idleMs: DISCOVER_IDLE_MS }), tools = null, onPicked = () => {}, node = process.execPath, papersServer = PAPERS_SERVER, runLog = null, inspectPdf = null, onAdded = () => {}, makeLine = null } = {}) {
  const log = logTo(runLog);
  // @create's line, what it is making (./making.cjs, 2026-10-15): asked of a quick model as the run starts.
  const making = makeLine || createMaking({ readModels, environment, runDirectory: path.join(runDirectory, 'making'), codexHome: makingCodexHome, codexAuthFile, run, tools });
  // Bart, the router (./route.cjs, 2026-10-12): picks the agent an `@bart` line is for and steps aside.
  const router = createRouter({ readModels, environment, runDirectory, codexHome: routerCodexHome, codexAuthFile, run, tools, runLog });
  const shell = resolveShell(environment);
  // The CLI by name, or by the full path the tool check found it at when PATH misses it (then through the environment, never quoted).
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const running = new Map(); // askId → AbortController
  // A search stopped by a reply sent under it (2026-10-16): its session, for the run that goes on with the reply.
  const settling = new Map(), paused = new Map(); // askId → its run's end; a stopped search's askId → { provider, session }
  const pause = (askId, entry) => {
    paused.set(askId, entry);
    const timer = setTimeout(() => paused.delete(askId), STEER_KEEP_MS); if (timer && timer.unref) timer.unref();
  };
  // The session of search `after`, which is stopped first if it still runs, once its run has ended.
  const pausedFor = async (after, provider) => {
    const controller = running.get(after); if (controller) controller.abort();
    await settling.get(after);
    const entry = paused.get(after); paused.delete(after);
    return entry && entry.provider === provider ? entry : null;
  };
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
  // An OpenAlex key in the environment (2026-10-15) goes with it: a larger daily allowance (./papers.cjs).
  const papers = { command: node, args: [papersServer], env: { ELECTRON_RUN_AS_NODE: '1', ...(environment.OPENALEX_API_KEY ? { OPENALEX_API_KEY: environment.OPENALEX_API_KEY } : {}) } };
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');
  const stopped = (signal) => signal && signal.aborted;

  // Every flag is a literal, every value arrives through the environment: nothing is quoted by hand.
  // `effort` is one of six known words (./question.cjs). `resume`: the id of a session to go on with. `mcp`: the paper
  // tools too (@discover), from a config written next to the prompt.
  // `rules`: the permission rules in place of `allowed` (@create's, which name a path), sent through the environment, with
  // --permission-mode dontAsk.
  function claudeTurns({ system, cwd, dirs, stem, signal, short, onUpdate, onRaw = null, resume, allowed = CLAUDE_TOOLS, rules = null, mcp = false, timeout, logId = null }) {
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
        const permitted = rules ? '--allowedTools "$ENGELBART_BART_RULES" --permission-mode dontAsk' : `--allowedTools "${granted}"`;
        const command = `exec ${program('claude')} -p --output-format stream-json --verbose --include-partial-messages ${session ? '--resume' : '--session-id'} "$ENGELBART_BART_SESSION" --restricted --setting-sources "" --strict-mcp-config${servers} --tools "${allowed}" ${permitted} ${grants} --model "$ENGELBART_BART_MODEL" --effort ${level.effort} --system-prompt-file "$ENGELBART_BART_PROMPT" < "$ENGELBART_BART_INPUT"`;
        const read = claudeReader(short); // a Write named and counted as it comes (2026-10-15)
        const env = childEnvironment({ ...programEnv('claude'), ENGELBART_BART_SESSION: id, ENGELBART_BART_MODEL: level.model, ENGELBART_BART_PROMPT: promptFile, ENGELBART_BART_INPUT: `${stem}.input.txt`, ...(rules ? { ENGELBART_BART_RULES: rules } : {}), ...(mcp ? { ENGELBART_BART_MCP: mcpFile } : {}), ...Object.fromEntries(dirs.map((dir, n) => [`ENGELBART_BART_DIR${n}`, dir])) });
        const { stdout, failure } = await execute(command, cwd, env, signal, (event) => { log((runs) => runs.event(logId, event)); if (onRaw) onRaw(event); onUpdate(read(event)); }, timeout);
        if (stopped(signal)) throw new BartError('stopped', 'Stopped.');
        const result = lastResultLine(stdout);
        if (!result) throw new BartError('unavailable', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
        if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new BartError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 300));
        return { text: result.result, session: id };
      },
    };
  }

  // `mcp`: the paper tools too (@discover), from the private home's config.toml, which holds nothing else.
  // `write`: @create's sandbox (CREATE_CODEX) in place of the read-only one, rooted at `cwd`.
  function codexTurns({ system, cwd, stem, signal, short, onUpdate, onRaw = null, home = codexHome, web = true, mcp = false, write = false, timeout, logId = null }) {
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome: home, source, instructions: system })) throw new BartError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
    writeCodexConfig(home, mcp ? { papers } : {});
    const outFile = `${stem}.out.txt`;
    return {
      done: () => { try { fs.unlinkSync(outFile); } catch { /* none */ } },
      turn: async ({ level, message, session }) => {
        fs.writeFileSync(`${stem}.input.txt`, message, { mode: 0o600 });
        try { fs.unlinkSync(outFile); } catch { /* none */ }
        // -C is `exec`'s, before its subcommand: `exec resume` takes none of its own.
        const sandbox = write ? CREATE_CODEX.map((setting) => `-c '${setting}'`).join(' ') : `-c 'sandbox_mode="read-only"'`, at = write ? '-C "$ENGELBART_BART_CWD" ' : '';
        const shared = `--skip-git-repo-check -m "$ENGELBART_BART_MODEL" -c 'model_reasoning_effort="${level.effort}"' ${sandbox} -c 'tools.web_search=${web}' -c project_doc_max_bytes=0 --json -o "$ENGELBART_BART_OUTPUT" - < "$ENGELBART_BART_INPUT"`;
        const command = session ? `exec ${program('codex')} exec ${at}resume "$ENGELBART_BART_SESSION" ${shared}` : `exec ${program('codex')} exec --color never ${at}${shared}`;
        const env = childEnvironment({ ...programEnv('codex'), CODEX_HOME: home, ENGELBART_BART_SESSION: session || '', ENGELBART_BART_MODEL: level.model, ENGELBART_BART_OUTPUT: outFile, ENGELBART_BART_INPUT: `${stem}.input.txt`, ...(write ? { ENGELBART_BART_CWD: cwd } : {}) });
        const { stdout, failure } = await execute(command, cwd, env, signal, (event) => { log((runs) => runs.event(logId, event)); if (onRaw) onRaw(event); onUpdate(codexUpdate(event, short)); }, timeout);
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
   * `agent`: 'bart', 'brainstorm' or 'discover'; all but @bart may be asked with nothing on the line; @discover may reply with cards, and so may the Welcome walkthrough's @brainstorm.
   * `highlight` ({ quote, note, paper }): a question asked from a note on a pdf highlight (`ref.kind` 'mark', MATH-27),
   * whose exchange is kept by the mark's id like any other (threadKey). `stage` ({ rowId, url, page, kind }): what is in
   * front in the Stage, for @bart's <stage> (./context.cjs). `live` ({ selection(), screenshot() }, MATH-54 build 3a): the
   * web page in front's tab, asked for its selection and picture as they are now. `overleaf` (MATH-65): the window's
   * Overleaf tabs (overleaf/stage.cjs forTurn), for <stage source="overleaf"> and <overleaf_tabs>.
   */
  async function ask(ctx, projectId, { askId, ref, workspaceId, text, turns, choice, agent = 'bart', highlight = null, stage = null, live = null, overleaf = null, routed: routedInput = null, place = null, steer = null }, { onProgress } = {}) {
    const models = readModels();
    const bart = agent === 'bart', create = agent === 'create', routed = routedOf(routedInput);
    // The context first: @brainstorm's path is read against the library it shows (turnPlan).
    const context = await buildContext(ctx, projectId, { ref, workspaceId, askId, agent, highlight, stage, live, overleaf });
    const plan = turnPlan({ agent, text, turns, choice: bart || create || agent === 'brainstorm' || agent === 'discover' ? choice : null, entries: context.entries, welcome: welcomeHere(ctx, projectId, agent, ref, workspaceId) }, models);
    const { question, provider, steps, pinned, prior, asked, shown, extra, mode } = plan;
    if (!question && (bart || create)) throw new BartError('failed', create ? 'There is nothing on the line to make.' : 'There is no question on the line.');
    if (pinned && bart) remember(onPicked, steps[0]);
    // @create keeps no sessions: each turn starts from the document.
    const store = { bart: threads, brainstorm: brainstormThreads, discover: discoverThreads }[agent] || null;
    // A reply sent while its search ran (`steer` { after, words }, 2026-10-16, David), or a level picked on its box (`level`,
    // the line's mode flag already changed): that run stops, and this one goes on in its session, told what was added or
    // how far it now traces (steerMessage), on the level's model; a session that cannot be had (or one on the other
    // provider) is a search of the direction as it now reads, the words part of it (steersShown).
    const steered = agent === 'discover' && plan.search && steer ? await pausedFor(steer.after, provider) : null;
    const held = steered || (prior.length && store && !switched(prior, agent) ? store.take(threadKey(projectId, ref, prior), provider) : null);
    const system = loadSystemPrompt(ctx.dataRoot, plan.welcome ? 'welcome' : agent);
    // The Agent map's record (runLog): from here every way out of the run is logged.
    const logId = askId || randomUUID(), startedAt = Date.now();
    log((runs) => runs.start(runRecord({ id: logId, agent, provider, projectId, question: text, system, context, shown, extra, mode, pinned, routed, place, reply: prior.length })));
    if (routed && routed.corrected) log((runs) => markCorrected(runs, { id: routed.id, projectId, text, agent: routed.corrected }));
    try {
      const result = await answer();
      log((runs) => runs.finish(logId, { status: 'done', written: result.lines, ms: Date.now() - startedAt }));
      return result;
    } catch (error) {
      log((runs) => runs.finish(logId, { status: error && error.kind === 'stopped' ? 'stopped' : 'failed', error: error && error.message, ms: Date.now() - startedAt }));
      throw error;
    }

    async function answer() {
      // The Welcome walkthrough's stage card, or its result: written here, no model runs.
      if (plan.written != null) return resultReply(plan);
      const sent = await withImagePaths(ctx, projectId, asked);
      const cwd = path.join(runDirectory, projectId);
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      const stem = path.join(cwd, `ask-${randomUUID()}`);
      const controller = new AbortController();
      running.set(askId, controller);
      let settle = () => {}; settling.set(askId, new Promise((resolve) => { settle = resolve; }));
      const feed = createFeed({ onProgress });
      // @create's line (./making.cjs, 2026-10-15): what it is making, shown above its row a second or two in, while the run
      // works; and the answer's text once it is done, so the words do not change. Not Opus's: it thinks before it says anything.
      const line = create ? making({ request: question, documents: context.documents, provider }).then((said) => {
        if (said.line && onProgress && running.get(askId) === controller) onProgress({ making: said.line });
        return said.line;
      }).catch(() => '') : null;
      const updated = feed.take;
      // @discover's steps told as its trace (./trace.cjs, 2026-10-15): by part, each saying what came back.
      const trace = agent === 'discover' ? createTrace({ entries: context.entries }) : null;
      // The session a search runs in, as its events name it, kept if it is stopped (pausedFor).
      const live = { session: held ? held.session : null };
      // Chat's tool calls, for what it read (citedBody).
      const events = [];
      const traced = (event) => {
        if (bart && toolCallsOf(event).length) events.push(event);
        const named = event && (event.session_id || (event.type === 'thread.started' ? event.thread_id : null));
        if (typeof named === 'string' && UUID_RE.test(named)) live.session = named;
        if (!trace) return; const story = trace.take(event); if (story && onProgress) onProgress({ trace: story });
      };
      const once = async (session) => {
        let cli = null;
        try {
          const only = {
            bart: {},
            brainstorm: { allowed: BRAINSTORM_TOOLS, home: brainstormCodexHome, web: false },
            // A turn settling what to research only talks (2026-10-15): it reads the person's files, and has no paper tools and
            // no web until its research box searches.
            discover: plan.search ? { home: discoverCodexHome, mcp: true, timeout: mode === 'deep' ? DEEP_DISCOVER_TIMEOUT_MS : DISCOVER_TIMEOUT_MS } : { allowed: BRAINSTORM_TOOLS, home: discoverCodexHome, web: false },
            create: { allowed: CREATE_TOOLS, rules: draft && createRules(draft), home: createCodexHome, write: true, timeout: CREATE_TIMEOUT_MS },
          }[agent];
          cli = (provider === 'anthropic' ? claudeTurns : codexTurns)({ system, cwd: draft || cwd, dirs: context.dirs, stem, signal: controller.signal, short: pathLabeller(context.dirs), onUpdate: updated, onRaw: traced, resume: session, logId, ...only });
          const going = !!steered && session === steered.session; // on in the stopped search's session, told what was added
          return await climb({ steps, pinned, first: firstMessage({ context, prior: shown, question: going ? steerMessage(steer.words, steer.level ? mode : null) : sent, resumed: !!session, extra: going ? '' : extra, routed, agent, topic: agent === 'brainstorm' ? context.topic : null }), session, turn: (input) => { feed.reset(); return loggedTurn(log, logId, input, cli.turn); }, onProgress: stepShown(agent, onProgress) });
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
      // @create's working directory is its draft folder, made empty, the one place it writes (./create.cjs); it is
      // deleted however the run ends.
      const draft = create ? openDraft(ctx.dataRoot, logId) : null;
      try {
        let out;
        // A session that will not resume (its file is gone, the CLI changed) is not the person's problem: start again from the document.
        try { out = await guarded(held ? held.session : null); } catch (error) {
          if (error.kind === 'stopped' && plan.search && live.session) pause(askId, { provider, session: live.session });
          if (!held || error.kind === 'stopped') throw error; out = await guarded(null);
        }
        const meta = { provider, level: { name: out.level.name, effort: out.level.effort, model: out.level.model }, trail: out.trail.map((step) => ({ name: step.name, effort: step.effort, why: step.why })), ms: out.ms, pinned, ...(routed ? { routed } : {}) };
        // @create's files kept in the library, each answered with a mention of its row (./create.cjs); stopped, it keeps none.
        if (create && stopped(controller.signal)) throw new BartError('stopped', 'Stopped.');
        // (2026-10-14: kept with the project, <project>/.created/<id>/, each answered with a line the editor draws as its row.)
        const made = create ? await keepCreated(ctx, projectId, logId, draft) : null;
        if (made) { meta.created = made.files.map(createdRow); log((runs) => runs.amend(logId, { created: meta.created, skipped: made.skipped })); }
        if (made) await saveAllCreated(ctx, projectId, workspaceId, logId, made.files, { inspectPdf, onAdded }); // and saved (2026-10-15)
        // A card is written as its JSON in a fence; a reply that is not one, as it came (the editor draws it as an answer).
        // The Welcome walkthrough's cards always read the same (welcomeReply).
        const named = taken(agent, plan, out.text);
        // With nothing kept (a Build's request, refused), the line on what it was making is not said.
        const body = made ? createdBody(createdSentence(made.files.length ? createdLine((await line) || requestSentence(question)) : '', out.text, question), made, logId) : plan.welcome ? cardBody(welcomeReply(out.text, plan.stage)).body : await citedBody(ctx, { agent, routed, body: replyBody(agent, named.text), projectId, workspaceId, prior, question: text, log, logId, context, events });
        // Kept under what the document will say once this answer is in it: the next follow-up is found by that.
        if (out.session && store) store.keep(threadKey(projectId, ref, [...prior, cleanTurn({ question: text, answer: answerText(body) })]), { provider, session: out.session, projectId, workspaceId });
        return { lines: replyLines(body, meta, { model: !QUIET.has(agent), agent }), meta, ...handedBack(named) };
      } finally {
        feed.end();
        running.delete(askId);
        settling.delete(askId); settle();
        dropDraft(draft);
        try { fs.unlinkSync(`${stem}.input.txt`); } catch { /* already gone */ }
      }
    }
  }

  function stop(askId) {
    const controller = running.get(askId);
    if (controller) controller.abort();
    return !!controller;
  }

  return { ask, stop, stopAll: () => { for (const controller of running.values()) controller.abort(); }, route: router.route, routeHanded: router.handed };
}

/**
 * The fake Welcome walkthrough's cards (2026-10-10), as a model would write them: what they are working on, then the next
 * card's lead-in, a few of their first answer's words (welcomeReply fixes both titles). A line containing "malformed"
 * gets a reply that is not a card.
 */
function fakeWelcome(plan) {
  if (/malformed/i.test(plan.question)) return 'FAKE REPLY that is not a card: {"say": "cut off';
  const ask = (id, title, say = '') => JSON.stringify({ say, card: 'questions', questions: { eyebrow: id === WORKING_ID ? 'to start' : 'what next', items: [{ id, type: 'open', title, placeholder: 'In your own words…' }] }, ready: false });
  if (plan.stage === 'first') return ask(WORKING_ID, WORKING_TITLE);
  const first = plan.prior.length > 1 ? String(plan.prior[1].question || '').trim() : '';
  return ask(NEXT_ID, WELCOME_NEXT_TITLE, first ? `You started from “${first.split(/\s+/).slice(0, 6).join(' ')}”.` : '');
}

/**
 * The fake @brainstorm's reply (2026-10-14: a conversation, in prose), as a model would write it: what it was asked and
 * what of the conversation it was given (a new session given the earlier turns, or the same session given the question
 * alone), so a scripted run shows which. A line asking to wrap up gets a summary with no question after it; any other a
 * question back. An older exchange's cards are named by the text they were sent as (cardAsText). A conversation's first
 * turn opens with the card (2026-10-16, as its prompt says): the workspace's fake themes for an empty line, fake angles on
 * what a line names.
 */
function fakeThink(plan, sent) {
  const n = plan.prior.length, asked = plan.question || OPENING;
  const given = !n ? 'no earlier turns' : /<conversation>/.test(sent) ? `a new session, given ${n} earlier ${n === 1 ? 'turn' : 'turns'}` : 'the same session, given the question alone';
  if (!n && !/\bwrap(?:ping)? (?:it |this )?up\b/i.test(asked)) {
    const title = asked === OPENING ? 'What would you like to talk about?' : `Where would you like to start with “${asked.slice(0, 80)}”?`;
    const labels = asked === OPENING ? ['Fake theme one', 'Fake theme two', 'Fake theme three'] : ['A fake first angle', 'A fake second angle', 'A fake third angle'];
    return JSON.stringify({ say: '', card: 'focus', focus: { title, options: labels.map((label) => ({ label })) }, ready: false });
  }
  if (/\bwrap(?:ping)? (?:it |this )?up\b/i.test(asked)) return `FAKE BRAINSTORM wrap-up after ${n} ${n === 1 ? 'turn' : 'turns'} (${given}).\n\nWhat became clearer: what you said. Still open: the rest.`;
  return `FAKE BRAINSTORM on "${asked}" (${given}).\n\nWhat part of that matters most to you?`;
}

/**
 * The fake @brainstorm's topic (2026-10-14), as Brainstorm would mark it: a conversation with none yet takes what the
 * person said, unless it was empty or a wrap-up; "New topic: X" (the chip's Change topic) takes X when it is not already
 * the topic. Any other turn leaves it. The opening card sets none (2026-10-16): the answer to it does, a pick by its label.
 */
function fakeTopic(reply, sent, question) {
  if (/^\s*\{/.test(reply)) return reply;
  const asked = String(question || '').trim(), now = (String(sent).match(/<topic>([^<]*)<\/topic>/) || [])[1] || '';
  const changed = asked.match(/^New topic:\s*(.+)$/i), picked = asked.match(/^picked "([^"]+)"/);
  const label = changed ? changed[1] : !now && asked && asked !== '(skipped)' && !/\bwrap(?:ping)? (?:it |this )?up\b/i.test(asked) ? (picked ? picked[1] : asked) : '';
  return label && label !== now ? `${reply}\n\n<topic>${label}</topic>` : reply;
}

/**
 * The fake @discover's reply, as a model would write it (2026-10-14: the direction first, in conversation). A turn that
 * is not a search: an empty line gets the card "What would you like to research?", three themes to pick; a line that asks
 * clearly (find, papers, studies, an overview, "just search", a paper by mention), a second answer, a follow-up on a
 * guide or a pick from a card gets a sentence on what it will look for and the <research> line; anything else one question back. A
 * search (a research box's turn) gets a guide in three-line entries, whose first entry is the direction it was given
 * when the conversation took a turn to reach it, then the first library item, by its path when it has one, with a section to find in it
 * (`#find=…&to=…`, round 2), and an "## Essays" group of one essay, its Read a link to its first paragraph's words with
 * no `&to=` (2026-10-03). Each Why says in one short sentence how the reading helps with the question (2026-10-15). No Try line
 * since 2026-10-15. A follow-up on a guide gets additions.
 * A direction holding a mention (`@[Name]`, with or without words beside it; 2026-10-04) names a paper: its search gets a
 * guide that opens with "## This paper", the library item by its path, two sections best first, each its own Read and
 * Why, then a classic it cites, a paper that cites it and an essay; a follow-up that names one gets the same.
 * Nothing is looked up: every entry says it is fake.
 */
/**
 * A fake Chat answer's citations, when the question says "cite" (2026-10-21): one quoting the first words of the first
 * note the library holds, which the check keeps, and one quoting words it does not have, which the check takes out.
 */
function fakeCitations(context) {
  const note = context.entries.find((row) => row.path && /\.md$/i.test(row.path) && fs.existsSync(row.path));
  if (!note) return '';
  const words = fs.readFileSync(note.path, 'utf8').replace(/[#*_`>[\]()-]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  if (words.split(' ').length < 4) return '';
  const good = citeHref({ address: note.path, find: words, cite: 'you' });
  const bad = citeHref({ address: note.path, find: 'words the fake note never says anywhere', cite: 'you' });
  return `\n\nYou wrote this down before [You · Oct 12](${good}). And something else [You · Oct 13](${bad}).`;
}

function fakeDiscover(context, plan) {
  if (!plan.search) return fakeDirection(context, plan);
  const guided = plan.prior.some((turn) => /^## /.test(turn.answer));
  // Title, Read and Why; Read names a section by a link to its first words, or says the fake only had the abstract.
  // Why: in one short sentence, how the reading helps with the question (a method, a measurement, a design…), tied to no
  // feature of the workspace; never the person's words (2026-10-15).
  const why = (gives) => `**Why:** Helps you examine a fake ${gives} bearing on how to tell the work is going well.`;
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
  const classic = (label) => entry(`A fake classic${label} (${plan.mode} mode)`, 'https://example.org/fake-classic', 'Implementation', 'a fake passage on how it was built', 'the fake evaluation after it', 'term for what is being handled');
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
  // A direction the conversation took a turn to reach is the first entry, in its own words.
  const own = plan.prior.length > 1 ? String(plan.question || '').trim() : '';
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

// What makes a fake turn's request clear enough to search on (fakeDirection).
// What makes a fake Refine unclear enough to ask about first.
const FAKE_UNCLEAR_RE = /\b(?:not sure|something else|different)\b/i;
const FAKE_CLEAR_RE = /\b(?:find|papers?|studies|study|overview|survey|literature|just search|explore)\b|@\[/i;
/** The fake @discover's turn that settles what to research (fakeDiscover). */
function fakeDirection(context, plan) {
  const said = String(plan.question || '').trim(), opening = !said || said === DISCOVER_OPENING;
  if (opening) return JSON.stringify({ say: '', card: 'focus', focus: { title: 'What would you like to research?', options: ['Fake theme one', 'Fake theme two', 'Fake theme three'].map((label) => ({ label })) }, ready: false });
  // What was said since the last guide: a follow-up on one is a new direction, settled at once.
  const lastGuide = plan.prior.map((turn) => /^## /.test(turn.answer)).lastIndexOf(true);
  const asked = plan.prior.slice(lastGuide + 1).filter((turn) => turn.question && turn.question !== DISCOVER_OPENING && !isSearch(turn.question));
  const unpick = (question) => question.replace(/^picked "([^"]+)"$/, '$1');
  // A Refine (2026-10-15): its words win; words that could mean several searches get one question first.
  if (plan.refine && FAKE_UNCLEAR_RE.test(said)) return 'FAKE DISCOVER: What should the search look at instead?';
  if (plan.refining) return `FAKE DISCOVER will now look for work on “${said}”.\n\n<research>${said}</research>`;
  // A pick from a card only says where their interest is (2026-10-15): one question first, as for a broad topic, unless
  // they were asked already. Words of their own are read as any line.
  const picked = /^picked "/.test(said);
  if (!asked.length && lastGuide < 0 && (picked || !FAKE_CLEAR_RE.test(said))) return picked ? `FAKE DISCOVER: What are you hoping to understand about ${unpick(said).toLowerCase()}?` : 'FAKE DISCOVER: What are you hoping the research will help you figure out?';
  const direction = [...asked.map((turn) => unpick(turn.question)), unpick(said)].join('; ');
  return `FAKE DISCOVER will look for work on “${direction}”.\n\n<research>${direction}</research>`;
}

/**
 * The fake @create's run (2026-10-13), as a model would do it: a sentence saying what it is making (2026-10-14), files
 * written in its working folder, `draft`, then "Done.". A request to change something it has ("change", "fix", "rename",
 * "edit", "delete", "make the … different", or a Build) gets no file and the one sentence that it is a Build. Anything
 * else: report.md, chart.html (a page that draws its chart itself) and data.csv, from fake numbers.
 * → { first, files, last }: what it says first, the files it writes, as the run's steps name them, and its last message
 */
function fakeCreate(draft, question) {
  if (/\b(?:build|change|fix|rename|edit|delete|remove)\b|\bmake (?:the|my)\b[^.]*\bdifferent\b/i.test(question)) return { first: '', files: [], last: 'This is a Build: it changes something you already have, so I made nothing.' };
  const rows = [[2021, 3], [2022, 5], [2023, 4], [2024, 7]];
  const bars = rows.map(([year, n], at) => `<rect x="${20 + at * 60}" y="${150 - n * 18}" width="40" height="${n * 18}" fill="#4a6fa5"><title>${year}: ${n}</title></rect><text x="${40 + at * 60}" y="168" text-anchor="middle">${year}</text>`).join('');
  const title = String(question).replace(/[<>&"]/g, '').trim().slice(0, 80) || 'Fake chart';
  fs.writeFileSync(path.join(draft, 'report.md'), `# Fake report\n\nA fake report for “${title}”. Nothing was read: every number here is fake.\n`);
  fs.writeFileSync(path.join(draft, 'chart.html'), `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px system-ui;margin:24px}text{font-size:11px}</style></head>\n<body><h1>${title}</h1><svg width="280" height="180" role="img" aria-label="fake bars">${bars}</svg><p id="n"></p><script>document.getElementById('n').textContent = 'Fake data, drawn by the page itself.';</script></body></html>\n`);
  fs.writeFileSync(path.join(draft, 'data.csv'), `year,count\n${rows.map((row) => row.join(',')).join('\n')}\n`);
  return { first: 'A fake report, a chart page and its data, from made-up numbers.', files: ['report.md', 'chart.html', 'data.csv'], last: 'Done.' };
}

/**
 * The paper tools' calls and answers a fake @discover search tells as its trace (2026-10-15), as Claude Code's events: a
 * library paper, a search by meaning and its closest result, both papers' references and what cites the first.
 */
function fakeTraceEvents(entries) {
  const theirs = entries.find((item) => item.type === 'pdf' || (item.tags || []).includes('paper'));
  const own = { id: 'W1', title: theirs ? theirs.name : 'A fake paper of yours', doi: null };
  const found = { id: 'W2', title: 'A fake paper close to the problem', doi: null };
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__papers__${name}`, input }] } });
  const back = (id, value) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: JSON.stringify(value) }] }] } });
  return [
    use('f1', 'resolve', { query: own.title }), back('f1', { found: true, paper: own }),
    use('f2', 'search', { query: 'The fake problem, in a sentence.' }), back('f2', { total: 12, order: 'closest in meaning first (title and abstract)', results: [found, ...Array.from({ length: 11 }, (_, n) => ({ id: `W${10 + n}`, title: `Fake result ${n + 2}` }))] }),
    use('f3', 'resolve', { query: 'W2' }), back('f3', { found: true, paper: found }),
    use('f4', 'references', { id: 'W1' }), back('f4', { of: own, total: 14, listed: 14, results: [] }),
    use('f5', 'references', { id: 'W2' }), back('f5', { of: found, total: 22, listed: 22, results: [] }),
    use('f6', 'citations', { id: 'W1' }), back('f6', { of: own, total: 3, results: [] }),
  ];
}

/** Scripted runs only (ENGELBART_BART_FAKE=1): no model. A question containing "hard" moves up one step; one containing "code" is answered with a JSON code block too. @brainstorm runs fakeThink (the Welcome walkthrough's fakeWelcome), @discover fakeDiscover, @create fakeCreate. */
function createFakeBart({ readModels, delayMs = 1200, threads = createThreads(), brainstormThreads = createThreads({ idleMs: BRAINSTORM_IDLE_MS }), discoverThreads = createThreads({ idleMs: DISCOVER_IDLE_MS }), onPicked = () => {}, runLog = null, inspectPdf = null, onAdded = () => {} }) {
  const waits = new Map();
  const log = logTo(runLog);
  const router = createFakeRouter({ runLog });
  return {
    async ask(ctx, projectId, { askId, ref, workspaceId, text, turns, choice, agent = 'bart', highlight = null, stage = null, live = null, overleaf = null, routed: routedInput = null, place = null, steer = null }, { onProgress } = {}) {
      const models = readModels(), routed = routedOf(routedInput);
      const context = await buildContext(ctx, projectId, { ref, workspaceId, askId, agent, highlight, stage, live, overleaf });
      const plan = turnPlan({ agent, text, turns, choice: ['bart', 'create', 'brainstorm', 'discover'].includes(agent) ? choice : null, entries: context.entries, welcome: welcomeHere(ctx, projectId, agent, ref, workspaceId) }, models);
      const { brainstorm, question, provider, steps, pinned, prior } = plan, discover = agent === 'discover', create = agent === 'create';
      if (pinned && question && agent === 'bart') remember(onPicked, steps[0]);
      const store = { bart: threads, brainstorm: brainstormThreads, discover: discoverThreads }[agent] || null;
      const held = prior.length && store && !switched(prior, agent) ? store.take(threadKey(projectId, ref, prior), provider) : null;
      const logId = askId || randomUUID(), startedAt = Date.now();
      log((runs) => runs.start(runRecord({ id: logId, agent, provider, projectId, question: text, system: loadSystemPrompt(ctx.dataRoot, agent), context, shown: plan.shown, extra: plan.extra, mode: plan.mode, pinned, routed, place, reply: prior.length })));
      if (routed && routed.corrected) log((runs) => markCorrected(runs, { id: routed.id, projectId, text, agent: routed.corrected }));
      const ended = (status, result, error) => log((runs) => runs.finish(logId, { status, written: result ? result.lines : null, error: error && error.message, ms: Date.now() - startedAt }));
      if (plan.written != null) { const result = resultReply(plan); ended('done', result); return result; }
      if (create && !question) { const error = new BartError('failed', 'There is nothing on the line to make.'); ended('failed', null, error); throw error; }
      const message = firstMessage({ context, prior: plan.shown, question: await withImagePaths(ctx, projectId, plan.asked), resumed: !!held, extra: plan.extra, routed, agent, topic: agent === 'brainstorm' ? context.topic : null });
      const pause = (ms) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); waits.set(askId, () => { clearTimeout(timer); reject(new BartError('stopped', 'Stopped.')); }); });
      if (steer && waits.has(steer.after)) waits.get(steer.after)(); // a reply under a running search stops it first (the real ask's pausedFor)
      const feed = createFeed({ onProgress, intervalMs: 0 });
      const take = feed.take;
      // The same kinds of update a real run sends, spread over the delay: two things done, then the answer in pieces.
      const opens = [];
      const act = async (text) => {
        feed.reset();
        // Discover looks papers up only when it searches (2026-10-14); settling what to research, it reads the notes.
        for (const activity of discover ? (plan.search ? ['Reading notes.md', 'Looking up “fake”', 'Reading what cites “fake”'] : ['Reading notes.md']) : [...opens, 'Reading notes.md', QUIET.has(agent) ? 'Searching for “fake”' : 'Searching the web for “fake”']) { feed.take({ activity, log: true }); await pause(delayMs / 4); }
        // And tells them as its trace (./trace.cjs), from the paper tools' calls and answers a real run would get.
        if (discover && plan.search) {
          const trace = createTrace({ entries: context.entries });
          for (const event of fakeTraceEvents(context.entries)) { const story = trace.take(event); if (story && onProgress) onProgress({ trace: story }); await pause(delayMs / 16); }
        }
        feed.take({ textStart: true });
        const pieces = text.match(/[\s\S]{1,24}/g) || [];
        for (const delta of pieces) { feed.take({ delta }); await pause(delayMs / 2 / pieces.length); }
        return text;
      };
      // @create's (2026-10-15): the line on what it is making first, as the quick model would send it (./making.cjs), then
      // what it reads and writes (a file growing as it is written), then its last message.
      let line = '';
      const write = async (text) => { take({ textStart: true }); const pieces = text.match(/[\s\S]{1,24}/g) || []; for (const delta of pieces) { take({ delta }); await pause(delayMs / 4 / pieces.length); } };
      const actCreate = async ({ first, files, last }) => {
        feed.reset();
        line = first;
        if (first && onProgress) onProgress({ making: first });
        take({ activity: 'Reading notes.md', log: true }); await pause(delayMs / 4);
        for (const file of files) { take({ activity: `Writing ${file}` }); take({ activity: `Writing ${file} · 2 KB` }); await pause(delayMs / 8); take({ activity: `Writing ${file}`, log: true }); await pause(delayMs / 8); }
        await write(last);
        return last;
      };
      const draft = create ? openDraft(ctx.dataRoot, logId) : null;
      try {
        const out = await climb({
          steps, pinned, onProgress: stepShown(agent, onProgress),
          first: message, session: held ? held.session : null,
          // What it was sent is what it reports: a resumed session gets the question alone (an @bart one, the Stage and
          // highlights as well), a new one gets everything.
          turn: (input) => loggedTurn(log, logId, input, async ({ message: sent }) => ({ session: 'fake', text: create ? await actCreate(fakeCreate(draft, question)) : await act(plan.welcome ? fakeWelcome(plan) : brainstorm ? fakeTopic(fakeThink(plan, sent), sent, question) : discover ? fakeDiscover(context, plan) : /hard/.test(question) && /step 1 of/.test(sent) ? 'ESCALATE: the question says it is hard' : `FAKE ANSWER to "${question}".\n\n## Seen\n- **${context.documents.length}** characters of documents\n- \`${steps.length}\` steps${prior.length ? `\n- ${/<conversation>/.test(sent) ? `a new session, given ${prior.length} earlier ${prior.length === 1 ? 'turn' : 'turns'}` : /<engelbart>/.test(sent) ? 'a new session, given no earlier turns' : 'the same session, given the question alone'}` : ''}${/code/.test(question) ? `\n\nThe same as JSON:\n\n\`\`\`json\n{\n  "fake": true,\n  "steps": ${steps.length},\n  "note": "# not a heading"\n}\n\`\`\`` : ''}${/\bcite\b/.test(question) ? fakeCitations(context) : ''}`) })),
        });
        const meta = { provider, level: out.level, trail: out.trail, ms: out.ms, pinned, ...(routed ? { routed } : {}) };
        const made = create ? await keepCreated(ctx, projectId, logId, draft) : null;
        if (made) { meta.created = made.files.map(createdRow); log((runs) => runs.amend(logId, { created: meta.created, skipped: made.skipped })); }
        if (made) await saveAllCreated(ctx, projectId, workspaceId, logId, made.files, { inspectPdf, onAdded }); // and saved (2026-10-15)
        const named = taken(agent, plan, out.text);
        const body = made ? createdBody(createdSentence(made.files.length ? createdLine(line || requestSentence(question)) : '', out.text, question), made, logId) : plan.welcome ? cardBody(welcomeReply(out.text, plan.stage)).body : await citedBody(ctx, { agent, routed, body: replyBody(agent, named.text), projectId, workspaceId, prior, question: text, log, logId });
        if (store) store.keep(threadKey(projectId, ref, [...prior, cleanTurn({ question: text, answer: answerText(body) })]), { provider, session: out.session, projectId, workspaceId });
        const result = { lines: replyLines(body, meta, { model: !QUIET.has(agent), agent }), meta, ...handedBack(named) };
        ended('done', result);
        return result;
      } catch (error) {
        ended(error && error.kind === 'stopped' ? 'stopped' : 'failed', null, error);
        throw error;
      } finally { feed.end(); waits.delete(askId); dropDraft(draft); }
    },
    stop(askId) { const cancel = waits.get(askId); if (cancel) cancel(); return !!cancel; },
    stopAll() { for (const cancel of waits.values()) cancel(); },
    // Bart, the router (./route.cjs): by keyword here.
    route: router.route,
    routeHanded: router.handed,
  };
}

module.exports = { citesChecked, takeTopic, takeResearch, withoutResearch, steersShown, steerMessage, isSearch, createBart, createFakeBart, createThreads, logTo, runRecord, routedOf, CLAUDE_TOOLS, BRAINSTORM_TOOLS, CREATE_TOOLS, CREATE_CODEX, createRules, PAPER_TOOLS, STEP_TIMEOUT_MS, PROMPTS, threadKey, cleanTurns, turnPlan, firstMessage, welcomeReply, climb, levelBlock, loadSystemPrompt, replyBody, writeCodexConfig, BartError, ESCALATE_RE, THREAD_IDLE_MS, BRAINSTORM_IDLE_MS, DISCOVER_IDLE_MS, DISCOVER_TIMEOUT_MS, DEEP_DISCOVER_TIMEOUT_MS, MODE_LIMITS, AGENTS, WELCOME_CARDS };
