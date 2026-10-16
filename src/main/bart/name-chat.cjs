'use strict';

// A conversation's title (2026-10-12): the `bart# <title>` line above the question that starts an @bart, @brainstorm or
// @discover thread (src/renderer/model/doc.js TITLE_RE). The editor writes the line empty when the question is asked and
// the window fills it in when this answers, without waiting on it: the answer runs alongside. One short run with no
// tools and no session, on the provider the question runs on and that provider's lowest model (the first the models file
// lists: Haiku on Claude Code, Luna on Codex) at low effort, 15 seconds at most. Whatever goes wrong, the title is the
// person's opening message as a title reads (plainTitle, at most 60 characters). Follow-ups are never named again.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { readQuestion, readDiscover } = require('./question.cjs');
const { TOOL_OF } = require('../tools/requirements.cjs');

const NAME_PROMPT = 'Name this conversation in 2–6 words, sentence case, no quotes or final period.';
const NAME_TIMEOUT_MS = 15_000;
const MAX_TITLE = 60;
// A reply longer than this is not taken as a title.
const MAX_WORDS = 10;
// What an empty question line (an @brainstorm or @discover started from the workspace) is called: there is nothing to name.
const UNNAMED = 'New conversation';
// The question as the model is shown it, at most.
const MAX_QUESTION = 4000;

/** The provider a question runs on, as ./ask.cjs reads it: @bart's line (its flags), @discover's, @brainstorm's default. */
function providerOf(text, agent, models) {
  if (agent === 'brainstorm') return models.provider;
  if (agent === 'discover') return readDiscover(text, models, []).provider;
  return readQuestion(text, models).provider;
}

/** The model a title is asked of: `provider`'s first model (its lowest), at low effort. */
function namingStep(models, provider) {
  const at = models.providers[provider] ? provider : models.provider;
  const entry = models.providers[at];
  const key = Object.keys(entry.models)[0];
  return { provider: at, key, model: entry.models[key].id, name: entry.models[key].name, effort: 'low' };
}

/**
 * Text as a title reads: mentions as the names they show (`@[Paper](lib:…)` → Paper), agent tokens and flags gone,
 * markdown taken off (links to their words, emphasis, code ticks, a heading's #, a bullet), quotes around it and a final
 * period dropped, one line, the first letter upper case.
 */
function plainTitle(text) {
  let s = String(text == null ? '' : text).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
  s = s.replace(/@\[([^\]\n]+)\]\([^)\s]*\)/g, '$1').replace(/@\[([^\]\n]+)\]/g, '$1')
    .replace(/(^|\s)@(?:bart|chat|brainstorm|orient|discover|create)\b/gi, '$1').replace(/(^|\s)--\S+/g, '$1')
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/(\*\*|__|\*|_|`)(\S(?:.*?\S)?)\1/g, '$2').replace(/[*`]/g, '')
    .replace(/^(?:title|name)\s*:\s*/i, '')
    .replace(/\s+/g, ' ').trim();
  // A wrapper can hide another: `Title: "## Retry logic."` has its heading mark under the quotes.
  for (;;) { const next = s.replace(/^["'“”‘’«»]+|["'“”‘’«»]+$/g, '').replace(/\.+$/, '').replace(/^(?:#{1,6}\s+|(?:title|name)\s*:\s*)/i, '').trim(); if (next === s) break; s = next; }
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** At most MAX_TITLE characters, cut at a word where there is one, with no punctuation left hanging at the end. */
function capTitle(text) {
  const s = String(text || '').trim();
  if (s.length <= MAX_TITLE) return s;
  const cut = s.slice(0, MAX_TITLE + 1), space = cut.lastIndexOf(' ');
  return (space > MAX_TITLE / 2 ? cut.slice(0, space) : s.slice(0, MAX_TITLE)).replace(/[\s,;:–—-]+$/, '');
}

/** What the model said, as the title line holds it; '' when nothing usable is left. */
const cleanTitle = (raw) => capTitle(plainTitle(raw));

/**
 * The title when no model names it (2026-10-12): the person's opening message as a title reads (mentions as their names,
 * agent tokens, flags and markdown gone), at most MAX_TITLE characters, cut at a word. UNNAMED only for an empty line.
 */
function fallbackTitle(text) {
  return capTitle(plainTitle(text)) || UNNAMED;
}

/**
 * One short run with no tools and no session (2026-10-15: shared with @create's line, ./making.cjs): `step` (namingStep)
 * given `system` and `input`, at most `timeoutMs`. → quickRun(step, system, input) → what the model said, '' when it
 * said nothing usable. Never throws. `codexHome`: Codex is given `system` as its home's instructions, so each kind of
 * run has its own.
 */
function createQuickRun({ environment = process.env, runDirectory, codexHome, codexAuthFile, run = execFile, tools = null, timeoutMs = NAME_TIMEOUT_MS, prefix = 'name' } = {}) {
  const shell = resolveShell(environment);
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...(tools && tools.environment ? tools.environment() : {}), ...extra };
  };
  const execute = (command, env) => new Promise((resolve) => {
    run(shell, loginShellArgs(shell, command, env), { cwd: runDirectory, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, out) => resolve({ stdout: out, failure: error }));
  });

  // Every flag is a literal and every value arrives through the environment, as the summary sweep's runs.
  async function viaClaudeCode(step, stem) {
    const command = `exec ${program('claude')} -p --output-format json --no-session-persistence --setting-sources "" --strict-mcp-config --tools "" --model "$ENGELBART_NAME_MODEL" --effort ${step.effort} --system-prompt-file "$ENGELBART_NAME_PROMPT" < "$ENGELBART_NAME_INPUT"`;
    const { stdout } = await execute(command, childEnvironment({ ...programEnv('claude'), ENGELBART_NAME_MODEL: step.model, ENGELBART_NAME_PROMPT: `${stem}.system.md`, ENGELBART_NAME_INPUT: `${stem}.input.txt` }));
    const result = lastResultLine(stdout);
    return result && !result.is_error && typeof result.result === 'string' ? result.result : '';
  }

  async function viaCodex(step, stem, system) {
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome, source, instructions: system })) return '';
    const command = `exec ${program('codex')} exec --skip-git-repo-check --ephemeral -s read-only -m "$ENGELBART_NAME_MODEL" -c 'model_reasoning_effort="${step.effort}"' -c 'tools.web_search=false' -c project_doc_max_bytes=0 --color never --json -o "$ENGELBART_NAME_OUTPUT" - < "$ENGELBART_NAME_INPUT"`;
    await execute(command, childEnvironment({ ...programEnv('codex'), CODEX_HOME: codexHome, ENGELBART_NAME_MODEL: step.model, ENGELBART_NAME_OUTPUT: `${stem}.out.txt`, ENGELBART_NAME_INPUT: `${stem}.input.txt` }));
    try { return fs.readFileSync(`${stem}.out.txt`, 'utf8'); } catch { return ''; }
  }

  return async function quickRun(step, system, input) {
    let stem = null;
    try {
      fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
      stem = path.join(runDirectory, `${prefix}-${randomUUID()}`);
      fs.writeFileSync(`${stem}.system.md`, system, { mode: 0o600 });
      fs.writeFileSync(`${stem}.input.txt`, input, { mode: 0o600 });
      const runIt = () => (step.provider === 'anthropic' ? viaClaudeCode(step, stem) : viaCodex(step, stem, system));
      return String((tools ? await tools.use(TOOL_OF[step.provider], runIt) : await runIt()) || '');
    } catch { return ''; } finally {
      if (stem) for (const end of ['.system.md', '.input.txt', '.out.txt']) { try { fs.unlinkSync(stem + end); } catch { /* none */ } }
    }
  };
}

/**
 * → nameChat({ text, provider }) → { title, provider, model, modelName, effort, ms, named }. `text`: the question as typed
 * after its agent token; `readModels()`: the list in force, as @bart's runs read it (../index.cjs bartModels). `named`
 * is false when the title is the fallback. Never throws.
 */
function createNameChat({ readModels, environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-name-runs'), codexHome = path.join(os.tmpdir(), 'engelbart-codex-home-name'), codexAuthFile, run = execFile, tools = null, timeoutMs = NAME_TIMEOUT_MS } = {}) {
  const quickRun = createQuickRun({ environment, runDirectory, codexHome, codexAuthFile, run, tools, timeoutMs });
  return async function nameChat({ text, provider }) {
    const started = Date.now();
    const step = namingStep(readModels(), provider);
    const said = { provider: step.provider, model: step.model, modelName: step.name, effort: step.effort };
    const question = plainTitle(String(text || '').replace(/\s+/g, ' ')).slice(0, MAX_QUESTION);
    if (!question) return { title: UNNAMED, ...said, ms: Date.now() - started, named: false };
    // The instruction again after the question, and the title alone: Luna, given it only as instructions, answered the question.
    const raw = await quickRun(step, NAME_PROMPT, `The conversation opens with this question:\n\n<question>\n${question}\n</question>\n\nDo not answer it. ${NAME_PROMPT} Reply with the title alone.`);
    const title = cleanTitle(raw);
    // More words than a title has is an answer, not a name: the fallback.
    if (title && title.split(' ').length <= MAX_WORDS) return { title, ...said, ms: Date.now() - started, named: true };
    return { title: fallbackTitle(text), ...said, ms: Date.now() - started, named: false };
  };
}

/** Scripted runs only (ENGELBART_BART_FAKE=1): no model, the fallback title (the opening message). */
function createFakeNameChat({ readModels }) {
  return async function nameChat({ text, provider }) {
    const step = namingStep(readModels(), provider);
    return { title: fallbackTitle(text), provider: step.provider, model: step.model, modelName: step.name, effort: step.effort, ms: 0, named: false };
  };
}

module.exports = { NAME_PROMPT, NAME_TIMEOUT_MS, MAX_TITLE, UNNAMED, providerOf, namingStep, plainTitle, capTitle, cleanTitle, fallbackTitle, createQuickRun, createNameChat, createFakeNameChat };
