'use strict';

// The Agent map's Design tab (2026-10-12): each agent as it is set up now, read from the code and files that set it up,
// never written down twice. Its system prompt (the open data root's .context/<agent>-system-prompt.md when it holds any,
// else the built-in one), its tools on each provider, its model steps and efforts as the models file has them now, its
// time limit, and the blocks of context it is sent. Then Build and the run step after it (its tools, models, limits and what
// starts it), and on every entry the agents it hands work to.

const fs = require('node:fs');
const path = require('node:path');
const { loadSystemPrompt, AGENTS, PROMPTS, CLAUDE_TOOLS, BRAINSTORM_TOOLS, PAPER_TOOLS, STEP_TIMEOUT_MS, DISCOVER_TIMEOUT_MS, DEEP_DISCOVER_TIMEOUT_MS, MODE_LIMITS, BRAINSTORM_PATHS, BRAINSTORM_MOVES, MAX_BRAINSTORM_CARDS } = require('../bart/ask.cjs');
const { readQuestion, readBrainstorm, readDiscover, MODES } = require('../bart/models.cjs');
const { SCOPED, ZOTERO_READERS, LIBRARY_READERS } = require('../bart/context.cjs');
const { OMITTED } = require('../bart/strip.cjs');
const { ROUTE_SYSTEM_PROMPT } = require('../bart/route-system-prompt.cjs');
const { routeModel, ROUTE_TIMEOUT_MS, SECTION_CHARS, SURE_ENOUGH } = require('../bart/route.cjs');
const { buildChoices, resolveBuildChoice } = require('../bart/models.cjs');
const { loadBuildPrompt } = require('../build/prompt.cjs');
const { buildPolicy, claudeSettings } = require('../build/policy.cjs');
const { CLAUDE_TOOLS: BUILD_TOOLS, SETTING_SOURCES, codexOverrides } = require('../build/runner.cjs');
const { ENGELBART_TOOLS } = require('../build/engelbart-tools.cjs');
const { RUN_TOOLS, RUN_KINDS } = require('../build/run-tools.cjs');
const { prompt: runStepPrompt, RUNNABLE_MS, DECLARE_MS, INSTALL_MS, WIND_DOWN_MS, MAX_TURNS } = require('../build/run-step.cjs');
const { LIMITS, TURN_MS } = require('../build/manager.cjs');

// What each agent is called on a line, and above its Design entry (2026-10-12): the internal 'bart' is typed @chat and
// titled Chat; @bart is the router.
const TITLES = { bart: 'Chat', brainstorm: 'Brainstorm', discover: 'Discover' };
const TOKENS = { bart: 'chat', brainstorm: 'brainstorm', discover: 'discover' };

/** Bart, the router (../bart/route.cjs): its rules, model, prompt and inputs. */
function routerDesign(models) {
  const providers = models && models.providers ? Object.keys(models.providers) : [];
  const step = (provider) => { const found = routeModel({ ...models, provider }); return found ? { steps: [{ name: found.name, model: found.id, effort: found.effort }] } : { error: 'no model' }; };
  return {
    agent: 'router', title: 'Bart (router)', token: 'bart',
    prompt: { text: ROUTE_SYSTEM_PROMPT, custom: false, file: null },
    tools: { anthropic: { tools: '', allowedTools: null, papers: false }, openai: { webSearch: false, papers: false, sandbox: 'read-only' } },
    models: { inForce: models ? models.provider : null, providers: Object.fromEntries(providers.map((provider) => [provider, step(provider)])) },
    timeout: { route: ROUTE_TIMEOUT_MS },
    rules: [
      { when: 'an empty @bart', to: '@brainstorm' },
      { when: '--build', to: 'Build' },
      { when: '--quick, --standard or --deep', to: '@discover' },
      { when: 'a model or effort flag', to: '@chat' },
      { when: 'directly under a @brainstorm or @discover thread', to: 'that agent' },
      { when: 'otherwise', to: `the model (bad JSON, a timeout, an error or sure < ${SURE_ENOUGH} → @chat)` },
      { when: 'the model says build, a spec above and sure ≥ 0.8', to: 'Build of that fenced block' },
      { when: 'the model says build otherwise', to: '@chat, told to write the Build prompt' },
    ],
    inputs: ['the line', `its section (nearest heading above to the line, the last ${SECTION_CHARS.toLocaleString('en-US')} characters, agent replies left out)`, 'the last five threads above (agent, first 80 characters, lines up)', 'whether the nearest answer above holds a fenced block', 'never the library, context_json or mentioned files'],
    context: { blocks: [{ block: '<workspace> <section> <threads> <spec_above> <line>', note: 'one message, no session' }], resumed: ['(none: every line is routed afresh)'], dirs: 'none: no tools' },
  };
}


/** The file a custom prompt is read from, and whether it holds one (loadSystemPrompt's own test: any text at all). */
function promptOf(dataRoot, agent) {
  const file = dataRoot ? path.join(dataRoot, '.context', PROMPTS[agent][0]) : null;
  let custom = false;
  try { custom = !!file && fs.readFileSync(file, 'utf8').trim().length > 0; } catch { custom = false; }
  return { text: loadSystemPrompt(dataRoot || '', agent), custom, file };
}

/** The tools each provider's CLI is given, as ask.cjs's `only` gives them. */
function toolsOf(agent) {
  const allowed = agent === 'brainstorm' ? BRAINSTORM_TOOLS : CLAUDE_TOOLS, mcp = agent === 'discover';
  return {
    anthropic: { tools: allowed, allowedTools: mcp ? `${allowed},${PAPER_TOOLS}` : allowed, papers: mcp },
    openai: { webSearch: agent !== 'brainstorm', papers: mcp, sandbox: 'read-only' },
  };
}

/** The steps an agent runs on, per provider ({ name, model, effort }), the provider in force marked. */
function stepsOf(agent, models) {
  const out = {};
  const providers = models && models.providers ? Object.keys(models.providers) : [];
  for (const provider of providers) {
    const on = { ...models, provider };
    const shape = (steps) => steps.map((step) => ({ name: step.name, model: step.model, effort: step.effort }));
    try {
      if (agent === 'bart') out[provider] = { steps: shape(readQuestion('', on).steps) };
      else if (agent === 'brainstorm') out[provider] = { steps: shape(readBrainstorm('', on).steps) };
      else out[provider] = { modes: Object.fromEntries(MODES.map((mode) => [mode, shape(readDiscover(mode === 'standard' ? '' : `--${mode}`, on, []).steps)])) };
    } catch (error) { out[provider] = { error: error.message }; }
  }
  return { inForce: models ? models.provider : null, providers: out };
}

/** The blocks of context an agent is sent, in order: a new session's, and a resumed one's. */
function contextOf(agent) {
  const scoped = SCOPED.has(agent);
  const blocks = [
    { block: '<engelbart>', note: `project, description, code directory, notes folder, where it was asked from${ZOTERO_READERS.has(agent) ? ', the Zotero mirror' : ''}; then the data root's instructions and MEMORY.md` },
    { block: '<context_json>', note: scoped ? 'the library of this workspace alone (notes made in it, items it mentions)' : 'the whole library, each item flagged when the documents mention it' },
    { block: '<mentioned_files>', note: 'files inside library folders the documents point at (none: left out)' },
    { block: 'documents', note: scoped ? `the workspace, with every mentioned note under its line; other agents' replies removed (strip.cjs: "${OMITTED}")` : 'the workspace, with every mentioned note under its line' },
    ...(agent === 'bart' ? [{ block: '<stage> / <highlights>', note: 'the paper, web page or Overleaf editor in front (none: <stage>none</stage>), then the highlights of the papers the documents mention' }] : []),
    { block: '<conversation>', note: 'the earlier turns of the exchange, when there are any' },
    ...(agent === 'brainstorm' ? [{ block: '<path> <stage> <card>', note: `the path (${BRAINSTORM_PATHS.join(', ')}, welcome), which card comes next (moves: ${BRAINSTORM_MOVES.join(', ')}), card n of ${MAX_BRAINSTORM_CARDS}` }] : []),
    ...(agent === 'discover' ? [{ block: '<mode>', note: Object.values(MODE_LIMITS).join(' | ') }] : []),
    { block: '<level>', note: 'the model and effort this step runs on, and whether a higher step exists' },
    { block: '<question>', note: 'the line after the agent\'s name (an empty line: the opening question)' },
  ];
  const resumed = [
    ...(agent === 'brainstorm' ? ['<path> <stage> <card>'] : agent === 'discover' ? ['<mode>'] : []),
    ...(agent === 'bart' ? ['<stage> / <highlights> (as they are now)'] : []),
    '<level>', '<question>',
  ];
  return { blocks, resumed, dirs: LIBRARY_READERS.has(agent) ? 'the code directory and data root, plus the library\'s folders (read-only)' : 'the code directory and data root (read-only)' };
}

// Who hands work to whom, and how: { to, how }.
// Each `to` as a line writes it (2026-10-12): @chat is the agent called 'bart'; @bart is the router.
const CALLS = {
  router: [
    { to: 'chat', how: 'the router\'s pick: the line is rewritten @chat and asked' },
    { to: 'brainstorm', how: 'the router\'s pick, or an empty @bart' },
    { to: 'discover', how: 'the router\'s pick, or --quick, --standard or --deep' },
    { to: 'build', how: '--build, or the router\'s pick with a spec above (else Chat writes the Build prompt)' },
  ],
  bart: [{ to: 'build', how: '--build: the line\'s request becomes a Build; the footer\'s Build' }],
  brainstorm: [
    { to: 'discover', how: 'its result line, the Welcome handoff, Send to Discover' },
    { to: 'chat', how: 'its result line, the Welcome handoff' },
  ],
  discover: [{ to: 'build', how: 'the footer\'s Build' }],
  build: [{ to: 'run step', how: 'on review: a Build turn that ends in review' }],
  'run step': [],
};

// The policy with its folders named, not the open project's: what any Build may reach.
const PLACEHOLDER = { project: { dir: '<project folder>' }, dataRoot: '<data root>', gitDir: '<repository>/.git' };

/** Build's system prompt: the custom file's when it holds any, else the built-in one; a quick task's when it differs. */
function buildPromptOf(dataRoot) {
  const file = dataRoot ? path.join(dataRoot, '.context', 'build-system-prompt.md') : null;
  let custom = false;
  try { custom = !!file && fs.readFileSync(file, 'utf8').trim().length > 0; } catch { custom = false; }
  const text = loadBuildPrompt(dataRoot || '');
  const quick = loadBuildPrompt(dataRoot || '', { quick: true });
  return { text, custom, file, quick: quick !== text ? quick : null };
}

/** One paragraph on what a Build may reach (../build/policy.cjs buildPolicy). */
function reachOf() {
  const policy = buildPolicy(PLACEHOLDER);
  return [
    'Works in a git worktree of its own, on a branch made for the Build; the person\'s folder is never touched.',
    `Also works in ${policy.folders.join(' and ')}${policy.writable.length ? ` (Codex writes there without asking: ${policy.writable.join(', ')})` : ''}.`,
    `Kept aside while it works and put back after each turn: ${policy.kept.join(' and ')}, and every pdf and picture the library holds.`,
    `Refused to the edit tools: ${policy.records.join(', ')}.`,
    `Git is Engelbart's alone: the git guard (first on PATH, with hooks on ${policy.gitDir}) refuses what writes the repository's history, refs or settings, and every push; Engelbart commits after each turn.`,
    `The person's own settings, hooks and MCP servers: ${policy.personal ? 'yes' : 'no'}. Subagents: ${policy.subagents ? 'yes' : 'no'}. Computer use and browser control: ${policy.computerUse ? 'yes' : 'no'}.`,
  ].join(' ');
}

function buildToolsOf() {
  const policy = buildPolicy(PLACEHOLDER);
  let codex;
  try { codex = codexOverrides(policy, { instructions: '<the system prompt>', engelbart: { command: '<node>', args: ['engelbart-mcp.cjs', '<connection>'] }, home: path.join(PLACEHOLDER.dataRoot, '.no-codex-home') }); } catch (error) { codex = [`(${error.message})`]; }
  return {
    anthropic: {
      tools: BUILD_TOOLS,
      settingSources: SETTING_SOURCES,
      personal: 'the person\'s own Claude Code settings, hooks and MCP servers',
      engelbart: ENGELBART_TOOLS.map((tool) => `mcp__engelbart__${tool.name}`),
      deny: claudeSettings(policy).permissions.deny,
    },
    openai: { overrides: codex, engelbart: ENGELBART_TOOLS.map((tool) => `engelbart.${tool.name}`) },
  };
}

/** Build's models per provider (the models file's build block): its default, the models and efforts the dialog offers. */
function buildStepsOf(buildModels) {
  if (!buildModels) return { inForce: null, providers: {} };
  try {
    const choices = buildChoices(buildModels);
    const providers = {};
    for (const [provider, entry] of Object.entries(choices.providers)) {
      const start = entry.ladder[0];
      providers[provider] = {
        steps: [{ name: entry.models[start.model].name, model: entry.models[start.model].id, effort: start.effort }],
        models: Object.values(entry.models).map((model) => ({ name: model.name, model: model.id, use: model.use || '' })),
        efforts: entry.efforts,
      };
    }
    return { inForce: choices.provider, providers };
  } catch (error) { return { inForce: null, providers: {}, error: error.message }; }
}

function buildEntry(dataRoot, buildModels) {
  return {
    agent: 'build',
    prompt: buildPromptOf(dataRoot),
    tools: buildToolsOf(),
    reach: reachOf(),
    models: buildStepsOf(buildModels),
    timeout: { build: TURN_MS.build, quick: TURN_MS.quick },
    slots: { build: LIMITS.build, quick: LIMITS.quick },
    context: {
      blocks: [
        { block: '<engelbart>', note: 'the project, the working copy, the branch and where it started, the person\'s own folder' },
        { block: '<custom_instructions> / <memory>', note: 'the data root\'s instructions and MEMORY.md, when there are any' },
        { block: '<task>', note: 'what to do' },
        { block: '<workspace>', note: 'the workspace document with every mentioned note under its line. A line\'s Build sends <request> instead (what was typed, its notes); a post-it sends <post-it>' },
        { block: '<attached>', note: 'library items attached when the Build started' },
        { block: '<history>', note: 'the newest archived version of the workspace (not for a line\'s request)' },
        { block: '<context_json>', note: 'the library, each item flagged when the document mentions it' },
      ],
      resumed: ['<reply> (and <attachments>, the images pasted into it)', 'a session that will not resume: everything again, <conversation>, then the reply'],
      dirs: 'the worktree, the project folder and the data root\'s assets (./policy.cjs)',
    },
    ends: [
      { line: 'NEEDS YOU: <question>', means: 'a question only the person can answer; the Build waits (needs-you)' },
      { line: 'ESCALATE: <why>', means: 'a quick task that is not small: it changes nothing and is escalated' },
      { line: '(anything else)', means: 'done: the Build goes to review, and its run step starts' },
    ],
    startedFrom: ['--build on an @chat or @bart line', 'Bart\'s pick, with a spec above', 'an answer\'s footer Build (its last fenced block)', 'the Build panel (a workspace\'s Build button)', 'a post-it (a quick task)'],
  };
}

function runStepEntry(buildModels) {
  let fallback = null;
  try { const choice = resolveBuildChoice(buildModels, { provider: 'anthropic' }); fallback = { name: choice.modelName, model: choice.modelId, effort: choice.effort, provider: choice.provider }; } catch { fallback = null; }
  let template = '';
  try { template = runStepPrompt({ name: '<repository>', discovery: null, uncovered: [], stored: [], tried: [], minutes: Math.round(RUNNABLE_MS / 60_000), kinds: RUN_KINDS, changed: [] }); } catch (error) { template = `(${error.message})`; }
  return {
    agent: 'run step',
    prompt: { text: template, custom: false, file: null, note: 'written per Build from launch facts (the repository, what the Build changed, the stored commands and how they did); the template, with no facts:' },
    tools: { anthropic: { tools: '', allowedTools: RUN_TOOLS.map((tool) => `mcp__canvas__${tool.name}`).join(','), restricted: true }, openai: null },
    models: { rule: 'the Build\'s own model and effort when it ran on Claude Code, else Claude Code\'s Build step', fallback, providers: {} },
    timeout: { runnable: RUNNABLE_MS, declare: DECLARE_MS, install: INSTALL_MS, windDown: WIND_DOWN_MS },
    maxTurns: MAX_TURNS,
    context: { blocks: [{ block: 'prompt', note: 'one message, written for the Build (above)' }], resumed: [], dirs: 'none: it reads and writes the worktree through its tools alone' },
    startedFrom: ['a Build turn that ends in review (never a quick task)'],
  };
}

/**
 * → { agents: [{ agent, title?, token?, prompt, tools, models, timeout, context, calls, rules?, inputs?, … }] } for the
 * open data root and the models in force; Bart, the router, first (2026-10-12).
 */
function agentDesign({ dataRoot, models, buildModels = models }) {
  const agents = [
    routerDesign(models),
    ...AGENTS.map((agent) => ({
      agent, title: TITLES[agent], token: TOKENS[agent],
      prompt: promptOf(dataRoot, agent),
      tools: toolsOf(agent),
      models: stepsOf(agent, models),
      timeout: agent === 'discover' ? { quick: DISCOVER_TIMEOUT_MS, standard: DISCOVER_TIMEOUT_MS, deep: DEEP_DISCOVER_TIMEOUT_MS } : { step: STEP_TIMEOUT_MS },
      context: contextOf(agent),
    })),
    buildEntry(dataRoot, buildModels),
    runStepEntry(buildModels),
  ];
  return { agents: agents.map((entry) => ({ ...entry, calls: CALLS[entry.agent] || [] })) };
}

module.exports = { agentDesign, CALLS };
