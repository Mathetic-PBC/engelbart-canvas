'use strict';

// Bart, the router (2026-10-12). An `@bart` line is no longer a question for one agent: Bart picks @chat (the agent the
// app calls 'bart'), @brainstorm, @discover or Build, the editor rewrites the line to that agent and asks it, and Bart
// steps aside. The editor tries its rules first (src/renderer/model/route.js routeByRule); a line no rule settles comes
// here, and the default provider's fastest model (Haiku on Claude Code, Luna on Codex) is asked at low effort, with no
// tools and no session, which agent it is for. Anything that goes wrong (bad JSON, a timeout, an error) or a pick it is
// less than 0.6 sure of goes to chat: a misrouted line costs more than a plain answer. @create (2026-10-13, ./create.cjs)
// adds files to the library and starts by itself, so a create pick needed 0.8; since 2026-10-14 it needs 0.6 as the others
// do: Chat makes no files, so a create pick it was sent ended in "ask @create", and Stop stops a Create nobody wanted
// (it keeps nothing; the editor's 5 s countdown with Cancel was taken out on 2026-10-15). A follow-up in a thread (2026-10-13)
// comes with `current`, the agent that answered the thread last: it stays there unless the model is at least 0.8 sure
// the line wants another agent, and anything that goes wrong leaves it there too.
//
// What it is sent: the line, the agent the conversation is with now (`current`, for a follow-up), its section (from the nearest heading above to the line, the last 4,000 characters, agent
// replies left out as for @brainstorm, ./strip.cjs), the last five threads above (agent, the first 80 characters of the
// question, how many lines up), and whether the nearest answer above holds a fenced block. The line goes without its
// model and effort flags (2026-10-16): they pick how the agent runs, not which agent. Never the library,
// context_json or a mentioned file.
//
// Every pick is a run in the Agent map's log (./runlog.cjs) under agent 'router', a rule's pick too (by: 'rule'); the run
// it hands the line to names it by `routedFrom`, and a pick the person corrects is marked `corrected`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');
const { codexRun, runningCodexVersion } = require('../tools/codex-models.cjs');
const { stripAgentReplies } = require('./strip.cjs');
const { ROUTE_SYSTEM_PROMPT } = require('./route-system-prompt.cjs');
const { readFlags } = require('./question.cjs');

const ROUTE_TIMEOUT_MS = 20_000;
const SECTION_CHARS = 4000;
const MAX_THREADS = 5;
const QUESTION_CHARS = 80;
const SURE_ENOUGH = 0.6;
const SURE_TO_SWITCH = 0.8;
const PICKS = ['chat', 'brainstorm', 'discover', 'create', 'build'];
const RULE_PICKS = new Set(PICKS);

const clean = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

/** The section as the model sees it: agent replies left out, the last 4,000 characters. */
function sectionText(section) {
  const text = stripAgentReplies(String(section || ''), 'router');
  return text.length > SECTION_CHARS ? text.slice(text.length - SECTION_CHARS) : text;
}

/** The threads above as the model sees them: the last five, each { agent, question (80 characters), up }. */
function threadsOf(threads) {
  if (!Array.isArray(threads)) return [];
  return threads.slice(-MAX_THREADS).map((thread) => ({
    agent: clean(thread && thread.agent, 20) || 'chat',
    question: clean(thread && thread.question, QUESTION_CHARS),
    up: Math.max(0, Math.floor(Number(thread && thread.up) || 0)),
  }));
}

/** The agent a follow-up's conversation is with ('chat', 'brainstorm' or 'discover'), or null. */
const currentOf = (current) => { const agent = String(current || '').toLowerCase().replace(/^@/, ''); return PICKS.includes(agent) && agent !== 'build' && agent !== 'create' ? agent : null; };

// What Discover asked and is waiting on, as the router is sent it, at most (MATH-165).
const ASKED_CHARS = 300;
const REASON_CHARS = 200;

/** What the model is sent: the line, its section, the threads above, whether a spec is above (and its first line,
 * 2026-10-13) and, for a follow-up, the agent the conversation is with. Nothing else. MATH-165 (2026-10-28): with
 * `discoverAsked`, the question Discover asked and is waiting on; with `handedBack` ({ from, reason }), the agent that
 * handed the line back and why. */
function routeInput({ text, section, workspaceName = '', threads = [], specAbove = false, specTitle = '', current = null, discoverAsked = null, handedBack = null }) {
  const list = threadsOf(threads), now = currentOf(current);
  const asked = discoverAsked ? clean(discoverAsked, ASKED_CHARS) : '';
  const from = handedBack ? currentOf(handedBack.from) : null;
  const threadLines = list.length ? list.map((thread) => `- @${thread.agent}, ${thread.up} line${thread.up === 1 ? '' : 's'} up: ${JSON.stringify(thread.question)}`).join('\n') : '(none)';
  return [
    workspaceName ? `<workspace>${clean(workspaceName, 200)}</workspace>` : '',
    `<section>\n${sectionText(section)}\n</section>`,
    `<threads>\n${threadLines}\n</threads>`,
    `<spec_above>${specAbove ? (clean(specTitle, QUESTION_CHARS) ? `yes: ${JSON.stringify(clean(specTitle, QUESTION_CHARS))}` : 'yes') : 'no'}</spec_above>`,
    now ? `<current>${now}</current>` : '',
    asked ? `<discover_asked>${asked}</discover_asked>` : '',
    from ? `<handed_back from="${from}">${clean(handedBack.reason, REASON_CHARS).replace(/[<>]/g, '')}</handed_back>` : '',
    `<line>\n${String(text || '').trim()}\n</line>`,
  ].filter(Boolean).join('\n\n');
}

/** { agent, sure } from the model's reply, or null when it holds no such object; a build's also has `spec` (2026-10-13):
 * true only when the reply says the line asks for the spec above to be built. */
function parseReply(raw) {
  const text = String(raw || '');
  const found = text.match(/\{[^{}]*\}/g) || [];
  for (const candidate of found) {
    let value = null;
    try { value = JSON.parse(candidate); } catch { continue; }
    const agent = value && String(value.agent || '').toLowerCase().replace(/^@/, '');
    const sure = Number(value && value.sure);
    if (PICKS.includes(agent) && Number.isFinite(sure)) return { agent, sure: Math.max(0, Math.min(1, sure)), ...(agent === 'build' ? { spec: value.spec === true } : {}) };
  }
  return null;
}

/**
 * The pick a reply comes to: its agent when it is sure enough (SURE_ENOUGH), else chat. With `current` (a
 * follow-up, 2026-10-13): that agent, unless the reply picks another and is at least 0.8 sure of it. A conversation with
 * discover (2026-10-13) has its search in a research box already: a reply is chat's, a new search only when the reply
 * picks discover at least 0.8 sure, and any other pick as a line with no conversation is.
 * MATH-165 (2026-10-28): `asking`, Discover is waiting on its question: a reply that answers it stays with discover at
 * SURE_ENOUGH. `exclude`: agents the line may not go to (a line handed back, never to the one that handed it back): one
 * picked is chat.
 */
function decide(parsed, current = null, { asking = false, exclude = [] } = {}) {
  const out = decided(parsed, current, asking);
  return exclude.includes(out.agent) ? { agent: 'chat', sure: out.sure } : out;
}
function decided(parsed, current, asking) {
  const now = currentOf(current);
  if (now === 'discover') return parsed && parsed.agent === 'discover' ? (parsed.sure >= (asking ? SURE_ENOUGH : SURE_TO_SWITCH) ? parsed : { agent: 'chat', sure: parsed.sure }) : decided(parsed, null, false);
  if (now) return parsed && parsed.agent !== now && parsed.sure >= SURE_TO_SWITCH ? parsed : { agent: now, sure: parsed ? parsed.sure : 0 };
  if (!parsed) return { agent: 'chat', sure: 0 };
  return parsed.sure < SURE_ENOUGH ? { agent: 'chat', sure: parsed.sure } : parsed;
}

/** The model a line is routed on: the default provider's first model, at low effort (or its lowest). */
function routeModel(models) {
  const provider = models && models.provider === 'openai' ? 'openai' : 'anthropic';
  const entry = models && models.providers && models.providers[provider];
  const keys = entry && entry.models ? Object.keys(entry.models) : [];
  if (!keys.length) return null;
  const model = entry.models[keys[0]];
  const efforts = Array.isArray(entry.efforts) ? entry.efforts : [];
  return { provider, key: keys[0], id: model.id, name: model.name || keys[0], effort: efforts.includes('low') || !efforts.length ? 'low' : efforts[0] };
}

const logTo = (runLog) => (call) => { if (!runLog) return; try { call(runLog); } catch { /* the log only */ } };

/** The router's record, as the run log starts it. */
function routerRecord({ id, provider, projectId, workspaceName, text, section, threads, specAbove, current = null, input, by, rule, place = null }) {
  return {
    id, agent: 'router', provider: provider || null, projectId, projectName: '', workspaceName: workspaceName || '',
    question: String(text || ''), at: Date.now(), status: 'running', system: by === 'rule' ? '' : ROUTE_SYSTEM_PROMPT, mode: null, pinned: false,
    by, ...(rule ? { rule } : {}), sectionSize: sectionText(section).length, threads: threadsOf(threads), specAbove: !!specAbove, ...(currentOf(current) ? { current: currentOf(current) } : {}),
    // Where the line was (2026-10-12, the Agent Viewer): { projectId, ref, line, text }, the line as typed.
    ...(place ? { place } : {}),
    context: { input: input || '' }, steps: [],
  };
}

/** Marks a router record corrected: the person picked `agent` instead. By id, else the newest router record with this line. */
function markCorrected(runs, { id = null, projectId = null, text = '', agent }) {
  if (!runs || !agent) return;
  const target = id || (runs.find ? (runs.find((record) => record.agent === 'router' && record.question === String(text || '').trim() && (!projectId || record.projectId === projectId)) || {}).id : null);
  if (target) runs.amend(target, { corrected: agent });
}

/**
 * → { route, corrected, handed }. `route({ projectId, text, section, workspaceName, threads, specAbove, current, rule, place })` →
 * { id, agent, sure, model, ms, by }: with `rule` (the editor's own pick) it is only logged.
 */
function createRouter({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-bart-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-router'), codexAuthFile, run = execFile, tools = null, runLog = null, timeout = ROUTE_TIMEOUT_MS, now = Date.now } = {}) {
  const log = logTo(runLog);
  const shell = resolveShell(environment);
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...(tools && tools.environment ? tools.environment() : {}), ...extra };
  };
  const execute = (command, env) => new Promise((resolve) => {
    run(shell, loginShellArgs(shell, command, env), { cwd: runDirectory, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, out) => resolve({ stdout: out, failure: error }));
  });

  // Every flag is a literal and every value arrives through the environment, as for summaries (../context/summarizer.cjs).
  async function viaClaudeCode(step, stem) {
    const promptFile = `${stem}.system.md`;
    fs.writeFileSync(promptFile, ROUTE_SYSTEM_PROMPT, { mode: 0o600 });
    try {
      const command = `exec ${program('claude')} -p --output-format json --no-session-persistence --setting-sources "" --strict-mcp-config --tools "" --model "$ENGELBART_ROUTE_MODEL" --effort ${step.effort} --system-prompt-file "$ENGELBART_ROUTE_PROMPT" < "$ENGELBART_ROUTE_INPUT"`;
      const { stdout, failure } = await execute(command, childEnvironment({ ...programEnv('claude'), ENGELBART_ROUTE_MODEL: step.id, ENGELBART_ROUTE_PROMPT: promptFile, ENGELBART_ROUTE_INPUT: `${stem}.input.txt` }));
      const result = lastResultLine(stdout);
      if (!result || result.is_error || typeof result.result !== 'string') throw new Error(result ? String(result.result || result.subtype || 'no text') : `Claude Code returned no result${failure ? ` (${failure.message.split('\n')[0]})` : ''}`);
      return result.result;
    } finally {
      try { fs.unlinkSync(promptFile); } catch { /* already gone */ }
    }
  }

  async function viaCodex(step, stem) {
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome, source, instructions: ROUTE_SYSTEM_PROMPT })) throw new Error('Codex is not signed in with a ChatGPT account');
    const outFile = `${stem}.out.txt`;
    try {
      const command = `exec ${program('codex')} exec --skip-git-repo-check --ephemeral -s read-only -m "$ENGELBART_ROUTE_MODEL" -c 'model_reasoning_effort="${step.effort}"' -c project_doc_max_bytes=0 --color never --json -o "$ENGELBART_ROUTE_OUTPUT" - < "$ENGELBART_ROUTE_INPUT"`;
      // The model as this home's Codex lists it, and once more on the listed one when Codex refuses it (MATH-159).
      const attempt = async (model) => {
        try { fs.unlinkSync(outFile); } catch { /* none yet */ }
        const { stdout, failure } = await execute(command, childEnvironment({ ...programEnv('codex'), CODEX_HOME: codexHome, ENGELBART_ROUTE_MODEL: model, ENGELBART_ROUTE_OUTPUT: outFile, ENGELBART_ROUTE_INPUT: `${stem}.input.txt` }));
        let text = '';
        try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
        return { stdout, failure, text };
      };
      const { failure, text } = await codexRun({ model: step.id, home: codexHome, version: runningCodexVersion(tools), attempt, ok: (out) => !!out.text.trim() });
      if (!text.trim()) throw new Error(failure ? failure.message.split('\n')[0] : 'Codex returned no message');
      return text;
    } finally {
      try { fs.unlinkSync(outFile); } catch { /* none */ }
    }
  }

  async function ask(step, input) {
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const stem = path.join(runDirectory, `route-${randomUUID()}`);
    fs.writeFileSync(`${stem}.input.txt`, input, { mode: 0o600 });
    const go = () => (step.provider === 'openai' ? viaCodex : viaClaudeCode)(step, stem);
    try { return tools ? await tools.use(TOOL_OF[step.provider], go) : await go(); }
    finally { try { fs.unlinkSync(`${stem}.input.txt`); } catch { /* already gone */ } }
  }

  // The line as the model reads it: its model and effort flags (`--sonnet --medium`) left out, once the models file is read.
  const plain = (text) => { const models = readModels ? readModels() : null; return models && models.providers ? readFlags(text, models).rest : text; };
  return routerOf({ log, now, plain, pick: async (input) => {
    const step = routeModel(readModels ? readModels() : null);
    if (!step) return { parsed: null, step: null, raw: '', error: 'no model to route on' };
    try {
      const raw = await ask(step, input);
      return { parsed: parseReply(raw), step, raw };
    } catch (error) {
      return { parsed: null, step, raw: '', error: error && error.message ? error.message : String(error) };
    }
  } });
}

/** The router without a model (ENGELBART_BART_FAKE=1): it picks by keyword, as the model is asked to; a follow-up no
 * keyword settles stays with the agent its thread is with (`current`). */
function fakePick(text, current = null) {
  const line = String(text || '').toLowerCase();
  // "build it", "implement that", "go ahead" build the spec above; anything else asked built is a request of its own
  // (spec: false, 2026-10-13).
  if (/\b(?:build|implement) (?:it|that|this)\b|\bgo ahead\b/.test(line)) return { agent: 'build', sure: 0.9, spec: true };
  if (/\bimplement\b|\bmake the\b.*\bdifferent\b/.test(line)) return { agent: 'build', sure: 0.9, spec: false };
  // Something new made ("make a chart", "make an html page", "write up a summary page", "create a …"), not a prompt or a spec for one.
  if (/\b(?:make|write up|draw) (?:a|an) (?:[\w-]+ ){0,2}(?:chart|page|plot|graph)\b|\bcreate (?:a|an) (?!(?:[\w-]+ )?(?:prompt|spec)\b)/.test(line)) return { agent: 'create', sure: 0.9 };
  if (/\bpapers?\b|\bread\b|\breading\b|prior work/.test(line)) return { agent: 'discover', sure: 0.9 };
  if (/\bthink\b|\bunsure\b/.test(line)) return { agent: 'brainstorm', sure: 0.9 };
  // A conversation with discover (2026-10-13): its search is in a research box already, so a reply is chat's (decide).
  return { agent: currentOf(current) === 'discover' ? 'chat' : currentOf(current) || 'chat', sure: 0.9 };
}

function createFakeRouter({ runLog = null, now = Date.now } = {}) {
  const log = logTo(runLog);
  return routerOf({ log, now, pick: async (input, text, current) => ({ parsed: fakePick(text, current), step: { provider: 'fake', key: 'fake', id: 'fake', name: 'Fake', effort: 'low' }, raw: JSON.stringify(fakePick(text, current)) }) });
}

/** What both routers share: the rule's or the model's pick, logged. `pick(input, text, current)` → { parsed, step, raw, error? }. */
function routerOf({ log, now, pick, plain = (text) => text }) {
  async function route({ projectId = null, text = '', section = '', workspaceName = '', threads = [], specAbove = false, specTitle = '', current = null, asking = false, discoverAsked = null, exclude = [], handedBack = null, rule = null, place = null } = {}) {
    const id = `route-${randomUUID()}`, started = now();
    if (rule && RULE_PICKS.has(rule.agent)) {
      log((runs) => runs.start(routerRecord({ id, projectId, workspaceName, text, section, threads, specAbove, by: 'rule', rule: rule.rule || null, place })));
      const out = { id, agent: rule.agent, sure: 1, model: null, ms: now() - started, by: 'rule', rule: rule.rule || null };
      log((runs) => { runs.amend(id, { pick: out.agent, sure: 1 }); runs.finish(id, { status: 'done', written: [`@${out.agent}`], ms: out.ms }); });
      return out;
    }
    const input = routeInput({ text: plain(text), section, workspaceName, threads, specAbove, specTitle, current, discoverAsked: asking ? discoverAsked : null, handedBack });
    log((runs) => runs.start(routerRecord({ id, projectId, workspaceName, text, section, threads, specAbove, current, input, by: 'model', place })));
    const { parsed, step, raw, error } = await pick(input, text, current);
    if (step) log((runs) => { runs.step(id, { model: step.id, name: step.name, effort: step.effort, input }); runs.output(id, { raw }); });
    const { agent, sure, spec } = decide(parsed, current, { asking: !!asking, exclude: (Array.isArray(exclude) ? exclude : []).filter((name) => PICKS.includes(name)) });
    // Whether the line asks for the spec above to be built (2026-10-13): only a build the model picked says so.
    const means = agent === 'build' && spec === true;
    const out = { id, agent, sure, ...(agent === 'build' ? { spec: means } : {}), model: step ? { provider: step.provider, name: step.name, id: step.id, effort: step.effort } : null, ms: now() - started, by: 'model', ...(error ? { error } : {}) };
    log((runs) => {
      // The model's own pick when it is not where the line went (2026-10-14): `sure` is its sureness of that pick.
      runs.amend(id, { provider: step ? step.provider : null, pick: agent, sure, ...(agent === 'build' ? { spec: means } : {}), ...(parsed ? {} : { unread: true }), ...(parsed && parsed.agent !== agent ? { said: parsed.agent } : {}) });
      runs.finish(id, { status: error ? 'failed' : 'done', written: [`@${agent}`], error: error || null, ms: out.ms });
    });
    return out;
  }
  return {
    route,
    /** The person picked `agent` instead of the router's pick. */
    corrected: (target) => log((runs) => markCorrected(runs, target)),
    /** Where the line went, when it was not an ask: a Build's id. */
    handed: (id, to) => { if (id && to) log((runs) => runs.amend(id, { handedTo: String(to) })); },
  };
}

module.exports = { createRouter, createFakeRouter, routeInput, parseReply, decide, routeModel, sectionText, threadsOf, fakePick, markCorrected, ROUTE_TIMEOUT_MS, SECTION_CHARS, SURE_ENOUGH, SURE_TO_SWITCH, PICKS };
