'use strict';

// The Agent map's Design tab (2026-10-12): each agent as it is set up now, read from the code and files that set it up,
// never written down twice. Its system prompt (the open data root's .context/<agent>-system-prompt.md when it holds any,
// else the built-in one), its tools on each provider, its model steps and efforts as the models file has them now, its
// time limit, and the blocks of context it is sent.

const fs = require('node:fs');
const path = require('node:path');
const { loadSystemPrompt, AGENTS, PROMPTS, CLAUDE_TOOLS, BRAINSTORM_TOOLS, PAPER_TOOLS, STEP_TIMEOUT_MS, DISCOVER_TIMEOUT_MS, DEEP_DISCOVER_TIMEOUT_MS, MODE_LIMITS, BRAINSTORM_PATHS, BRAINSTORM_MOVES, MAX_BRAINSTORM_CARDS } = require('../bart/ask.cjs');
const { readQuestion, readBrainstorm, readDiscover, MODES } = require('../bart/models.cjs');
const { SCOPED, ZOTERO_READERS, LIBRARY_READERS } = require('../bart/context.cjs');
const { OMITTED } = require('../bart/strip.cjs');

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

/** → { agents: [{ agent, prompt, tools, models, timeout, context }] } for the open data root and the models in force. */
function agentDesign({ dataRoot, models }) {
  return {
    agents: AGENTS.map((agent) => ({
      agent,
      prompt: promptOf(dataRoot, agent),
      tools: toolsOf(agent),
      models: stepsOf(agent, models),
      timeout: agent === 'discover' ? { quick: DISCOVER_TIMEOUT_MS, standard: DISCOVER_TIMEOUT_MS, deep: DEEP_DISCOVER_TIMEOUT_MS } : { step: STEP_TIMEOUT_MS },
      context: contextOf(agent),
    })),
  };
}

module.exports = { agentDesign };
