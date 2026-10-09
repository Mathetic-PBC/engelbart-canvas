'use strict';

// Connect your library (2026-10-07, experimental): one turn of its agents, run exactly as @bart runs Claude Code and Codex
// (../bart/ask.cjs): hidden, on the person's subscription (API keys removed), through the login shell, every value in the
// environment, one process per turn, its events read as they arrive for what it is doing.
//   the librarian (interview)  Claude Code --restricted with Read, Grep and Glob over the folders the scan found (vaults,
//                              ~/.claude/projects, an export's folder), its session resumed turn to turn; Codex in a
//                              private home with the read-only sandbox and no web.
//   survey, import, recall     the same file tools, WebSearch and WebFetch (an app's help pages, when its skill is out of
//                              date: never the person's accounts), Engelbart's import tools (./tools.cjs: the hidden
//                              browser among them) as the MCP server "engelbart" over the turn's loopback bridge, and the
//                              official MCP servers of the connectors the person signed in to (./connectors.cjs), each
//                              with its access token for this run only. They write only through Engelbart's tools: Claude
//                              Code has no Edit, Write or Bash, and Codex's sandbox is read-only. Codex gets a home of its
//                              own per job, so two imports at once never share a configuration.
//   memory                     Read, Grep and Glob over the session's notes; writes MEMORY.md's draft as its reply.
//   redact                     no tools at all: the draft in, the draft without secrets out.
// Neither CLI is given computer use or Claude in Chrome (--no-chrome; Codex's own browser and computer use stay off): the
// agents' browser is Engelbart's, whose sites and steps Engelbart controls and logs. Every kind runs on the model its
// session pinned (./session.cjs CONNECT_MODELS, Sonnet high or Sol high: "do not even allow me to change model or
// effort"), with no ladder to climb ("the subagents for this should not be able to escalate").

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { resolveShell, sanitizeEnvironment, loginShellArgs } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { NOT_THE_SUBSCRIPTION, prepareCodexHome, lastResultLine } = require('../context/summarizer.cjs');
const { pathLabeller, claudeUpdate, codexUpdate, eventReader } = require('../bart/activity.cjs');
const { writeCodexConfig } = require('../bart/ask.cjs');

const READ_TOOLS = 'Read,Grep,Glob';
const WEB_TOOLS = 'WebSearch,WebFetch';
const IMPORT_TOOLS_PREFIX = 'mcp__engelbart__*';
const IMPORT_SERVER = path.join(__dirname, 'import-mcp.cjs');
const TIMEOUTS = Object.freeze({ interview: 10 * 60_000, survey: 15 * 60_000, import: 45 * 60_000, recall: 15 * 60_000, memory: 15 * 60_000, redact: 6 * 60_000 });
const BRIDGED = new Set(['survey', 'import', 'recall']);
const INTERVIEW_TIMEOUT_MS = TIMEOUTS.interview;
const IMPORT_TIMEOUT_MS = TIMEOUTS.import;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVER_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;

class ConnectError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ConnectError';
    this.kind = kind; // 'unavailable' | 'failed' | 'stopped'
  }
}

const quote = (value) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > 40 ? `${text.slice(0, 39)}…` : text; };
const tokenEnv = (name) => `ENGELBART_CONNECTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * The config.toml of an import agent's private Codex home: Engelbart's import tools (`server` { command, args, env }) and
 * the connectors' servers (`connectors` [{ name, url }], their tokens read from ENGELBART_CONNECTOR_<NAME>), nothing else.
 * `codex exec` cannot ask anyone, so the tools are approved in advance: Engelbart's only write into its data root
 * (./tools.cjs), the connectors' only read. Its own browser and computer use stay off: the agent uses Engelbart's.
 */
function writeImportConfig(home, server, connectors = []) {
  const toml = (value) => (Array.isArray(value) ? `[${value.map(toml).join(', ')}]` : JSON.stringify(String(value)));
  const lines = ['# Written by Engelbart (src/main/connect/agents.cjs). Replaced on every run.', '', '[features]', 'computer_use = false', 'browser_use = false', 'browser_use_external = false', '',
    '[mcp_servers.engelbart]', `command = ${toml(server.command)}`, `args = ${toml(server.args)}`,
    `env = { ${Object.entries(server.env || {}).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')} }`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 240', 'default_tools_approval_mode = "approve"'];
  for (const connector of connectors) {
    if (!SERVER_NAME_RE.test(connector.name) || connector.name === 'engelbart') continue;
    lines.push('', `[mcp_servers.${connector.name}]`, `url = ${toml(connector.url)}`, `bearer_token_env_var = ${toml(tokenEnv(connector.name))}`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 120', 'default_tools_approval_mode = "approve"');
  }
  const text = `${lines.join('\n')}\n`;
  const file = path.join(home, 'config.toml');
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== text) fs.writeFileSync(file, text, { mode: 0o600 });
}

/** Claude Code's --mcp-config for a bridged turn: Engelbart's tools and the connectors, each token in its header. */
function claudeServers({ node, server, connection, connectors = [] }) {
  const servers = { engelbart: { command: node, args: [server, connection], env: { ELECTRON_RUN_AS_NODE: '1' } } };
  for (const connector of connectors) {
    if (!SERVER_NAME_RE.test(connector.name) || connector.name === 'engelbart') continue;
    servers[connector.name] = { type: 'http', url: connector.url, headers: { Authorization: `Bearer ${connector.token}` } };
  }
  return { mcpServers: servers };
}

/** What an import tool call is doing, in the person's words: what it was asked, never what came back. */
function importToolLabel(tool, input = {}) {
  const n = (list) => (Array.isArray(list) ? list.length : 0);
  const host = (url) => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return 'a page'; } };
  switch (tool) {
    case 'folder_overview': return `Looking through ${path.basename(String(input.path || 'a folder'))}`;
    case 'list_note_files': return `Listing notes in ${path.basename(String(input.folder || 'a folder'))}`;
    case 'import_note_files': return `Bringing in ${n(input.files)} note${n(input.files) === 1 ? '' : 's'}`;
    case 'add_note': return `Writing “${quote(input.title)}”`;
    case 'add_to_library': return `Adding ${quote(input.name || input.input)}`;
    case 'list_pdfs': return `Listing PDFs in ${path.basename(String(input.folder || 'a folder'))}`;
    case 'import_pdfs': return `Bringing in ${n(input.files)} PDF${n(input.files) === 1 ? '' : 's'}`;
    case 'unpack': return `Unpacking ${path.basename(String(input.file || 'a zip'))}`;
    case 'list_chats': case 'web_chats': return `Listing ${input.app || ''} chats`.replace(/\s+/g, ' ');
    case 'read_chat': case 'web_chat_read': return `Reading a ${input.app || ''} chat`.replace(/\s+/g, ' ');
    case 'import_chats': case 'import_web_chats': return `Bringing in ${n(input.ids)} chat${n(input.ids) === 1 ? '' : 's'}`;
    case 'browser_open': return `Opening ${host(input.url)}`;
    case 'browser_read': return 'Reading the page';
    case 'browser_click': return 'Clicking';
    case 'browser_type': return 'Typing';
    case 'browser_press': return `Pressing ${input.key || 'a key'}`;
    case 'browser_scroll': return 'Scrolling';
    case 'browser_wait': return 'Waiting for the page';
    case 'browser_screenshot': return 'Looking at the page';
    case 'browser_eval': return 'Asking the page';
    case 'browser_download': return `Downloading from ${host(input.url)}`;
    case 'import_google_files': return `Bringing in ${n(input.items)} Google Drive file${n(input.items) === 1 ? '' : 's'}`;
    case 'overleaf_projects': return 'Listing your Overleaf projects';
    case 'import_overleaf_projects': return `Bringing in ${n(input.ids)} Overleaf project${n(input.ids) === 1 ? '' : 's'}`;
    case 'apple_notes_folders': return 'Reading Apple Notes\' folders';
    case 'apple_notes_list': return 'Listing Apple Notes';
    case 'import_apple_notes': return `Bringing in ${n(input.ids)} Apple Note${n(input.ids) === 1 ? '' : 's'}`;
    case 'browser_history': return 'Going through your browser history';
    case 'browser_bookmarks': return 'Reading your bookmarks';
    case 'links_in_notes': return 'Finding links in your notes';
    case 'zotero_collections': return 'Reading your Zotero collections';
    case 'zotero_items': return 'Reading your Zotero library';
    case 'import_zotero_items': return `Bringing in ${n(input.keys)} paper${n(input.keys) === 1 ? '' : 's'}`;
    case 'github_repos': return 'Listing your GitHub repositories';
    case 'needs_you': case 'wait_for_you': return 'Waiting for you';
    case 'save_memory': return 'Keeping what it remembers';
    default: return 'Working';
  }
}

/** A CLI event → { activity } | null, Engelbart's import tools named by importToolLabel, a connector's by its name. */
function updateOf(provider, event, short) {
  if (provider === 'anthropic') {
    if (event && event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      const tool = event.message.content.find((block) => block && block.type === 'tool_use');
      const own = tool && String(tool.name || '').match(/^mcp__engelbart__(\w+)$/);
      if (own) return { activity: importToolLabel(own[1], tool.input || {}) };
      const other = tool && String(tool.name || '').match(/^mcp__([\w-]+)__/);
      if (other) return { activity: `Asking ${other[1].replace(/[-_]/g, ' ')}` };
    }
    const update = claudeUpdate(event, short);
    return update && update.activity ? { activity: update.activity } : null;
  }
  const item = event && /^item\.started$/.test(event.type) ? event.item : null;
  if (item && item.type === 'mcp_tool_call') {
    if (item.server !== 'engelbart') return { activity: `Asking ${String(item.server || 'a connector').replace(/[-_]/g, ' ')}` };
    let args = item.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return { activity: importToolLabel(item.tool, args || {}) };
  }
  const update = codexUpdate(event, short);
  return update && update.activity ? { activity: update.activity } : null;
}

/** Claude Code's tools for a kind: what it is given (--tools) and what it may use without asking (--allowedTools). */
function claudeToolsFor(kind, connectors = []) {
  if (kind === 'redact') return { tools: '', allowed: '' };
  if (!BRIDGED.has(kind)) return { tools: READ_TOOLS, allowed: READ_TOOLS };
  const tools = `${READ_TOOLS},${WEB_TOOLS}`;
  const extra = connectors.filter((connector) => SERVER_NAME_RE.test(connector.name)).map((connector) => `mcp__${connector.name}__*`);
  return { tools, allowed: [tools, IMPORT_TOOLS_PREFIX, ...extra].join(',') };
}

/**
 * `runDirectory`: where a turn's files go (prompt, input, MCP config). `interviewHome` / `importHome`: the private Codex
 * homes (their AGENTS.md is the agent's instructions; an import's is `${importHome}-<turn>`, removed after it).
 * `tools`: ../tools/manager.cjs, for the CLI's path and its lock.
 */
function createConnectAgents({ environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-connect-runs'), interviewHome = path.join(os.tmpdir(), 'engelbart-codex-home-connect'), importHome = `${interviewHome}-import`, codexAuthFile, run = execFile, tools = null, node = process.execPath, server = IMPORT_SERVER } = {}) {
  const shell = resolveShell(environment);
  const program = (name) => (tools && tools.binaryFor(name) ? `"$ENGELBART_${name.toUpperCase()}_BIN"` : name);
  const programEnv = (name) => (tools && tools.binaryFor(name) ? { [`ENGELBART_${name.toUpperCase()}_BIN`]: tools.binaryFor(name) } : {});
  const childEnvironment = (extra) => {
    const base = sanitizeEnvironment(scrubAgentSession(environment));
    for (const key of NOT_THE_SUBSCRIPTION) delete base[key];
    return { ...base, ...(tools && tools.environment ? tools.environment() : {}), ...extra };
  };
  const execute = (command, cwd, env, signal, onEvent, timeout) => new Promise((resolve) => {
    const child = run(shell, loginShellArgs(shell, command, env), { cwd, env, timeout, maxBuffer: 128 * 1024 * 1024, signal }, (error, out) => resolve({ stdout: out, failure: error }));
    if (onEvent && child && child.stdout) child.stdout.on('data', eventReader(onEvent));
  });
  const notFound = (failure) => failure && (failure.code === 127 || failure.code === 'ENOENT');

  async function claudeTurn({ kind, system, message, session, dirs, model, effort, signal, onUpdate, bridge, connectors, timeout, stem, cwd }) {
    const promptFile = `${stem}.system.md`, inputFile = `${stem}.input.txt`, mcpFile = `${stem}.mcp.json`, connection = `${stem}.engelbart.json`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    fs.writeFileSync(inputFile, message, { mode: 0o600 });
    if (bridge) {
      fs.writeFileSync(connection, JSON.stringify({ url: bridge.url, token: bridge.token, kind }), { mode: 0o600 });
      fs.writeFileSync(mcpFile, JSON.stringify(claudeServers({ node, server, connection, connectors })), { mode: 0o600 });
    }
    const id = session || randomUUID();
    const grants = dirs.map((_, n) => `--add-dir "$ENGELBART_CONNECT_DIR${n}"`).join(' ');
    const servers = bridge ? ' --mcp-config "$ENGELBART_CONNECT_MCP"' : '';
    const { tools: given, allowed } = claudeToolsFor(kind, bridge ? connectors : []);
    const command = `exec ${program('claude')} -p --output-format stream-json --verbose ${session ? '--resume' : '--session-id'} "$ENGELBART_CONNECT_SESSION" --restricted --setting-sources "" --strict-mcp-config${servers} --no-chrome --tools "${given}"${allowed ? ` --allowedTools "${allowed}"` : ''} --permission-prompts none ${grants} --model "$ENGELBART_CONNECT_MODEL" --effort ${effort} --system-prompt-file "$ENGELBART_CONNECT_PROMPT" < "$ENGELBART_CONNECT_INPUT"`;
    const env = childEnvironment({ ...programEnv('claude'), ENGELBART_CONNECT_SESSION: id, ENGELBART_CONNECT_MODEL: model, ENGELBART_CONNECT_PROMPT: promptFile, ENGELBART_CONNECT_INPUT: inputFile, ...(bridge ? { ENGELBART_CONNECT_MCP: mcpFile } : {}), ...Object.fromEntries(dirs.map((dir, n) => [`ENGELBART_CONNECT_DIR${n}`, dir])) });
    try {
      const short = pathLabeller(dirs);
      const { stdout, failure } = await execute(command, cwd, env, signal, (event) => { const update = updateOf('anthropic', event, short); if (update) onUpdate(update); }, timeout);
      if (signal && signal.aborted) throw new ConnectError('stopped', 'Stopped.');
      const result = lastResultLine(stdout);
      if (!result) throw new ConnectError('unavailable', notFound(failure) ? 'Claude Code was not found on the login shell PATH.' : `Claude Code did not return a result${failure ? ` (${failure.message.split('\n')[0]})` : ''}.`);
      if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new ConnectError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 300));
      return { text: result.result, session: id };
    } finally {
      for (const file of [promptFile, inputFile, mcpFile, connection]) { try { fs.unlinkSync(file); } catch { /* none */ } }
    }
  }

  async function codexTurn({ kind, system, message, session, model, effort, signal, onUpdate, bridge, connectors, timeout, stem, cwd, dirs }) {
    const own = bridge ? `${importHome}-${path.basename(stem)}` : interviewHome;
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome: own, source, instructions: system })) throw new ConnectError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
    const inputFile = `${stem}.input.txt`, outFile = `${stem}.out.txt`, connection = `${stem}.engelbart.json`;
    fs.writeFileSync(inputFile, message, { mode: 0o600 });
    if (bridge) {
      fs.writeFileSync(connection, JSON.stringify({ url: bridge.url, token: bridge.token, kind }), { mode: 0o600 });
      writeImportConfig(own, { command: node, args: [server, connection], env: { ELECTRON_RUN_AS_NODE: '1' } }, connectors);
    } else writeCodexConfig(own, {});
    const web = bridge ? 'true' : 'false'; // an app's help pages, when its skill is out of date
    const shared = `--skip-git-repo-check -m "$ENGELBART_CONNECT_MODEL" -c 'model_reasoning_effort="${effort}"' -c 'sandbox_mode="read-only"' -c 'tools.web_search=${web}' -c project_doc_max_bytes=0 --json -o "$ENGELBART_CONNECT_OUTPUT" - < "$ENGELBART_CONNECT_INPUT"`;
    const command = session ? `exec ${program('codex')} exec resume "$ENGELBART_CONNECT_SESSION" ${shared}` : `exec ${program('codex')} exec --color never ${shared}`;
    const tokens = Object.fromEntries((bridge ? connectors : []).filter((connector) => SERVER_NAME_RE.test(connector.name)).map((connector) => [tokenEnv(connector.name), connector.token]));
    const env = childEnvironment({ ...programEnv('codex'), ...tokens, CODEX_HOME: own, ENGELBART_CONNECT_SESSION: session || '', ENGELBART_CONNECT_MODEL: model, ENGELBART_CONNECT_OUTPUT: outFile, ENGELBART_CONNECT_INPUT: inputFile });
    try {
      const short = pathLabeller(dirs);
      const { stdout, failure } = await execute(command, cwd, env, signal, (event) => { const update = updateOf('openai', event, short); if (update) onUpdate(update); }, timeout);
      if (signal && signal.aborted) throw new ConnectError('stopped', 'Stopped.');
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
      let thread = session;
      for (const line of String(stdout || '').split(/\r?\n/)) {
        if (thread || !line.startsWith('{')) continue;
        try { const event = JSON.parse(line); if (event.type === 'thread.started' && UUID_RE.test(event.thread_id)) thread = event.thread_id; } catch { /* not an event */ }
      }
      if (!text.trim()) {
        if (notFound(failure)) throw new ConnectError('unavailable', 'Codex was not found on the login shell PATH.');
        const reason = String(stdout || '').split(/\r?\n/).reverse().find((line) => /"type":"(error|turn\.failed)"|^ERROR/.test(line)) || (failure ? failure.message.split('\n')[0] : 'Codex returned no message.');
        throw new ConnectError('failed', reason.slice(0, 300));
      }
      return { text, session: thread };
    } finally {
      for (const file of [inputFile, outFile, connection]) { try { fs.unlinkSync(file); } catch { /* none */ } }
      if (bridge) fs.rmSync(own, { recursive: true, force: true });
    }
  }

  /**
   * One turn. `choice` { provider, modelId, effort }; `kind` interview | survey | import | recall | memory | redact;
   * `bridge` { url, token } for the kinds that have Engelbart's tools; `connectors` [{ name, url, token }].
   */
  async function turn({ choice, kind = 'interview', system, message, session = null, dirs = [], signal, onUpdate = () => {}, bridge = null, connectors = [] }) {
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const stem = path.join(runDirectory, `${kind}-${randomUUID()}`);
    const cwd = runDirectory;
    const timeout = TIMEOUTS[kind] || TIMEOUTS.import;
    const cli = choice.provider === 'openai' ? 'codex' : 'claude';
    const once = () => (cli === 'codex' ? codexTurn : claudeTurn)({ kind, system, message, session, dirs, model: choice.modelId, effort: choice.effort, signal, onUpdate, bridge: BRIDGED.has(kind) ? bridge : null, connectors, timeout, stem, cwd });
    if (!tools) return once();
    await tools.ensure(cli);
    try { return await tools.use(cli, once); } catch (error) { if (error && error.kind === 'unavailable') void tools.check([cli]).catch(() => {}); throw error; }
  }

  return { turn };
}

module.exports = { createConnectAgents, writeImportConfig, claudeServers, claudeToolsFor, importToolLabel, updateOf, ConnectError, IMPORT_SERVER, TIMEOUTS, INTERVIEW_TIMEOUT_MS, IMPORT_TIMEOUT_MS };
