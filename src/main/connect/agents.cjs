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
//   browse                     (2026-10-13, the "Onboarding" workspace, second round: "We will use computer use in my real
//                              browser") an import of a web app done in the person's own browser, where they are signed in:
//                              Claude Code with Claude in Chrome (`-p --chrome`), Codex with its Chrome plugin and computer
//                              use (its own Codex home, so its plugins, Computer Use app and sign-in are there). It runs in
//                              the Engelbart terminal (../terminal/agent-terminal.cjs), with a wider reach than the others and
//                              these checks: Engelbart's guardrails in its instructions (prompts.cjs BROWSE_RULES: open,
//                              read, scroll, search, download and export; never send, post, delete, archive, change
//                              settings, type a password or close tabs; a sign-in page is needs_you); the CLI's own review
//                              (Claude Code's auto mode classifier decides each browser call, every prompt it would raise is
//                              refused; Codex's sandbox is read-only, its Chrome plugin's per-site questions go to
//                              Codex's auto-review and every other approval is refused: CODEX_BROWSE_APPROVALS); no tool that runs a
//                              script in a page, uploads a file or closes a tab; none of the person's own MCP servers or
//                              ChatGPT apps; every step and every screenshot kept for the Agent trace; Stop all ends the
//                              terminal session. ../onboarding/browser-agents.cjs says when it may run.
// The other kinds are given neither computer use nor Claude in Chrome (--no-chrome; Codex's own browser and computer use
// stay off): their browser is Engelbart's, whose sites and steps Engelbart controls and logs. Every kind runs on the model
// its session pinned (./session.cjs CONNECT_MODELS, Sonnet high or Sol high: "do not even allow me to change model or
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
const { APPS } = require('../../shared/connect-sources.cjs');
const { codexModel: sharedCodexModel } = require('../tools/codex-models.cjs');

const READ_TOOLS = 'Read,Grep,Glob';
const WEB_TOOLS = 'WebSearch,WebFetch';
const IMPORT_TOOLS_PREFIX = 'mcp__engelbart__*';
const IMPORT_SERVER = path.join(__dirname, 'import-mcp.cjs');
// Import your context (2026-10-13, ../onboarding/discover.cjs): `projects` names the person's recent projects from a
// digest it is handed (no tools: one quick answer); `discover` says which tools they use, looking with the survey's
// read-only tools (tools.cjs TOOLS_FOR.discover).
const TIMEOUTS = Object.freeze({ interview: 10 * 60_000, survey: 15 * 60_000, import: 45 * 60_000, recall: 15 * 60_000, memory: 15 * 60_000, redact: 6 * 60_000, projects: 4 * 60_000, discover: 8 * 60_000, browse: 45 * 60_000 });
const BRIDGED = new Set(['survey', 'import', 'recall', 'discover', 'browse']);
// Claude in Chrome's tools a browser agent is never given: a script in the page, a file sent up, a form filled, a saved
// shortcut run, a recording, another browser or window chosen, a window resized (round 3: "it shifted my window to the
// chrome window … This should also NEVER happen"). What is left opens its own tabs, reads, finds, scrolls, clicks, types
// and closes the tabs it opened (round 3: "The agents need to close all of the tabs and tab groups when they're done").
// Clicking and typing stay (2026-10-15, Hudson: "clicking and typing is important many things are nested"): Engelbart
// can't look at a control in their browser before it is pressed, so what holds those to reading there is BROWSE_RULES
// and auto mode's review of each call, not code.
const CHROME_REFUSED = Object.freeze(['javascript_tool', 'upload_image', 'file_upload', 'form_input', 'shortcuts_execute', 'shortcuts_list', 'gif_creator', 'switch_browser', 'select_browser', 'resize_window'].map((name) => `mcp__claude-in-chrome__${name}`));
// The MCP servers of the person's own Codex a browser agent keeps: node_repl, which its Chrome plugin runs in. Every other
// one of theirs is turned off for the run, Computer Use among them: it drives apps by bringing them to the front.
const CODEX_KEPT_SERVERS = new Set(['node_repl']);
// A Codex browser agent's approvals (2026-10-14). Its Chrome plugin asks before it opens each site ("Allow Chrome to access
// https://mail.google.com?"), as an MCP elicitation. Under approval_policy "never" `codex exec` declines every elicitation
// itself, and the plugin reads that as the person's no: Hudson's run brought nothing in from Gmail or Google Drive ("Browser
// Use rejected this action … The user declined permission for this action") and no question ever reached him. Nobody is
// at a `codex exec` to answer, so, as Claude Code's browser agent leaves each browser call to its auto mode classifier,
// those questions go to Codex's own auto-review (approvals_reviewer "auto_review"), and every other kind of approval
// (a command outside the read-only sandbox, a rule, a skill, more permissions) stays refused as under "never". Checked on
// this Mac (codex-cli 0.162.1) with a stand-in server asking the plugin's question: "never" → decline; this → accept,
// `_meta.approvals_reviewer: "auto_review"` (which the plugin takes as auto-review's yes).
const CODEX_BROWSE_APPROVALS = `-c 'approval_policy={ granular = { sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true } }' -c 'approvals_reviewer="auto_review"'`;
// A turn the model's service turned away for a moment (2026-10-14: Hudson's Granola import ended at once on Codex's
// "Selected model is at capacity. Please try a different model.", shown as "Left out", and nothing tried it again) is run
// again after these waits, on the same model (the run's model is pinned). What it brought in before is not brought in twice
// (./tools.cjs keeps what came in). Not a usage limit, a sign-in or a bad request: those do not pass by waiting.
const RETRY_WAITS_MS = Object.freeze([15_000, 45_000]);
const TRANSIENT_RE = /at capacity|overloaded|\b(?:429|500|502|503|504|529)\b|rate.?limit|too many requests|temporarily unavailable|service unavailable|internal server error|bad gateway|gateway time-?out|stream (?:disconnected|error|closed)|connection (?:reset|refused|closed|error)|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|try again (?:later|shortly|in a)/i;
const LASTING_RE = /usage.?limit|hit your limit|quota|billing|credits?\b|not signed in|log ?in|unauthori[sz]ed|\b40[13]\b|forbidden|invalid (?:api )?key|context (?:window|length)|(?:prompt|input|message) is too long|not found|unsupported|invalid_request/i;
/** Whether a turn's failure is the service's passing refusal (worth the same turn again a little later). */
const transientFailure = (error) => !!error && error.kind === 'failed' && TRANSIENT_RE.test(String(error.message || '')) && !LASTING_RE.test(String(error.message || ''));
const MAX_STEP_PICTURES = 80;
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
const line = (text, max) => { const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
/** `ms` waited, or less when `signal` aborts. */
const waitFor = (ms, signal) => new Promise((resolve) => {
  if (signal && signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', done); resolve(); }
  if (signal) signal.addEventListener('abort', done, { once: true });
});
const tokenEnv = (name) => `ENGELBART_CONNECTOR_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

// A connector's tools an agent may call (From Amitav, 2026-10-15: they were approved whole, `mcp__notion__*` and Codex's
// "approve", so an agent could have created, moved or deleted pages): its reading tools, by name, and nothing else. Claude
// Code is allowed only these (--allowedTools; any other is a prompt, and --permission-prompts none refuses it), Codex is
// given only these (enabled_tools). Granola's switch_workspace is not reading: it changes the workspace in the Granola app
// and every other client (docs.granola.ai). A survey gets the tools that list what is there; an import those that read it
// too. A connector with no list here is not given to an agent at all.
const CONNECTOR_READS = Object.freeze({
  Granola: Object.freeze({ list: ['list_meetings', 'list_meeting_folders', 'get_account_info'], read: ['get_meetings', 'get_meeting_transcript', 'get_meeting_attachment', 'query_granola_meetings'] }),
  Notion: Object.freeze({ list: ['notion-search', 'notion-list-recent-pages', 'notion-list-shared-pages', 'notion-list-private-pages', 'notion-list-favorite-pages', 'notion-get-self'], read: ['notion-fetch', 'notion-query-data-sources', 'notion-query-meeting-notes'] }),
});

/** The tools of `connector` ({ app }) an agent of `kind` may call: a survey's list, an import's list and read. Linear's
 *  and Evernote's (2026-10-16) are their catalog entries' `reads` (shared/connect-sources.cjs). */
function connectorTools(connector, kind) {
  const reads = connector && (CONNECTOR_READS[connector.app] || (APPS[connector.app] && APPS[connector.app].reach === 'connector' && APPS[connector.app].reads) || null);
  if (!reads) return [];
  return kind === 'survey' || kind === 'discover' ? [...reads.list] : [...reads.list, ...reads.read];
}

/**
 * The config.toml of an import agent's private Codex home: Engelbart's import tools (`server` { command, args, env }) and
 * the connectors' servers (`connectors` [{ name, url }], their tokens read from ENGELBART_CONNECTOR_<NAME>), nothing else.
 * `codex exec` cannot ask anyone, so the tools are approved in advance: Engelbart's only write into its data root
 * (./tools.cjs), and of the connectors' only those that read (connectorTools, for `kind`). Its own browser and computer use stay off: the agent uses Engelbart's.
 */
function writeImportConfig(home, server, connectors = [], kind = 'import') {
  const toml = (value) => (Array.isArray(value) ? `[${value.map(toml).join(', ')}]` : JSON.stringify(String(value)));
  const lines = ['# Written by Engelbart (src/main/connect/agents.cjs). Replaced on every run.', 'cli_auth_credentials_store = "file"', '', '[features]', 'computer_use = false', 'browser_use = false', 'browser_use_external = false', '',
    '[mcp_servers.engelbart]', `command = ${toml(server.command)}`, `args = ${toml(server.args)}`,
    `env = { ${Object.entries(server.env || {}).map(([key, value]) => `${key} = ${toml(value)}`).join(', ')} }`, 'startup_timeout_sec = 30', 'tool_timeout_sec = 240', 'default_tools_approval_mode = "approve"'];
  for (const connector of connectors) {
    if (!SERVER_NAME_RE.test(connector.name) || connector.name === 'engelbart') continue;
    // The person's own server (./own-connectors.cjs): no token here, Codex finds its own sign-in for it by name and address.
    const auth = connector.own ? [] : [`bearer_token_env_var = ${toml(tokenEnv(connector.name))}`];
    const reads = connectorTools(connector, kind);
    if (!reads.length) continue;
    lines.push('', `[mcp_servers.${connector.name}]`, `url = ${toml(connector.url)}`, ...auth, 'startup_timeout_sec = 30', 'tool_timeout_sec = 120', `enabled_tools = ${toml(reads)}`, 'default_tools_approval_mode = "approve"');
  }
  const text = `${lines.join('\n')}\n`;
  const file = path.join(home, 'config.toml');
  let current = null;
  try { current = fs.readFileSync(file, 'utf8'); } catch { current = null; }
  if (current !== text) fs.writeFileSync(file, text, { mode: 0o600 });
}

/**
 * The model an agent's Codex runs (2026-10-15: on an account whose ChatGPT plan has no Sol, every Codex agent was turned
 * away, recent projects and imports alike): the pinned `model` when the person's Codex lists it (its models_cache.json in
 * `home`), else the first it lists of the same family (-sol, -luna…), else the first it lists. Nothing listed: `model`.
 * Shared with every Codex run since MATH-159 (../tools/codex-models.cjs); onboarding's calls read the cache whatever
 * Codex wrote it, as they always did.
 */
const codexModel = (model, home) => sharedCodexModel(model, home, { anyVersion: true });

/** Claude Code's --mcp-config for a bridged turn: Engelbart's tools and the connectors, each token in its header. */
function claudeServers({ node, server, connection, connectors = [], kind = 'import' }) {
  const servers = { engelbart: { command: node, args: [server, connection], env: { ELECTRON_RUN_AS_NODE: '1' } } };
  for (const connector of connectors) {
    if (!SERVER_NAME_RE.test(connector.name) || connector.name === 'engelbart' || !connectorTools(connector, kind).length) continue;
    // The person's own server: as their Claude Code has it, which finds its sign-in by that name and address.
    servers[connector.name] = connector.own ? { type: connector.type === 'sse' ? 'sse' : 'http', url: connector.url } : { type: 'http', url: connector.url, headers: { Authorization: `Bearer ${connector.token}` } };
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
    case 'gmail_accounts': return 'Finding your Gmail accounts';
    case 'gmail_search': return 'Searching your Gmail';
    case 'import_gmail_threads': return `Bringing in ${n(input.threads)} email thread${n(input.threads) === 1 ? '' : 's'}`;
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

const hostOf = (url) => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return 'a page'; } };

/** A Claude in Chrome tool call, in the person's words. */
function chromeToolLabel(tool, input = {}) {
  switch (tool) {
    case 'navigate': return input.url ? `Opening ${hostOf(input.url)}` : 'Going back';
    case 'tabs_create_mcp': return 'Opening its own tab';
    case 'tabs_context_mcp': return 'Finding its tab';
    case 'get_page_text': case 'read_page': case 'read_console_messages': case 'read_network_requests': return 'Reading the page';
    case 'find': return input.query ? `Looking for “${quote(input.query)}”` : 'Looking through the page';
    case 'list_connected_browsers': case 'select_browser': case 'switch_browser': return 'Choosing the browser';
    case 'resize_window': return 'Sizing its window';
    case 'browser_batch': return 'Working in the browser';
    case 'computer': {
      const action = String(input.action || '');
      if (action === 'screenshot' || action === 'zoom') return 'Looking at the page';
      if (/click/.test(action)) return 'Clicking';
      if (action === 'type') return 'Typing';
      if (action === 'key') return `Pressing ${quote(input.text || 'a key')}`;
      if (/scroll/.test(action)) return 'Scrolling';
      if (action === 'wait') return 'Waiting for the page';
      return 'Working in the browser';
    }
    default: return 'Working in the browser';
  }
}

/** Codex's node_repl call (its Chrome plugin and computer use run there), in the person's words: its own title first. */
function replLabel(args = {}) {
  if (typeof args.title === 'string' && args.title.trim()) return line(args.title, 80);
  const code = String(args.code || '');
  const url = code.match(/https?:\/\/[^\s'"`)]+/);
  if (/tabs\.new\(/.test(code)) return url ? `Opening ${hostOf(url[0])} in its own tab` : 'Opening its own tab';
  if (/\.(goto|navigate|open)\(/.test(code) && url) return `Opening ${hostOf(url[0])}`;
  if (/screenshot/i.test(code)) return 'Looking at the page';
  if (/\.(click|press_key|perform_secondary_action)\(/.test(code)) return 'Clicking';
  if (/\.(type_text|fill|type|set_value|paste)\(/.test(code)) return 'Typing';
  if (/scroll/i.test(code)) return 'Scrolling';
  if (/get_app_state|\.text\(|content\(|innerText|textContent/.test(code)) return 'Reading the page';
  return 'Using your browser';
}

/** A browser agent's CLI event → { activity?, pictures? } | null: its browser steps in words, the screenshots it was shown. */
function browseUpdateOf(provider, event, short) {
  const pictures = [];
  if (provider === 'anthropic') {
    if (event && event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        const parts = block && block.type === 'tool_result' && Array.isArray(block.content) ? block.content : [];
        for (const part of parts) if (part && part.type === 'image' && part.source && part.source.type === 'base64' && typeof part.source.data === 'string') pictures.push({ type: part.source.media_type || 'image/png', data: part.source.data });
      }
      return pictures.length ? { pictures } : null;
    }
    if (event && event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      const tool = event.message.content.find((block) => block && block.type === 'tool_use');
      const chrome = tool && String(tool.name || '').match(/^mcp__claude-in-chrome__(\w+)$/);
      if (chrome) return { activity: chromeToolLabel(chrome[1], tool.input || {}) };
    }
    return updateOf(provider, event, short);
  }
  const item = event && /^item\.(started|completed)$/.test(event.type) ? event.item : null;
  if (item && item.type === 'mcp_tool_call' && (item.server === 'node_repl' || item.server === 'cua_repl' || item.server === 'computer-use')) {
    if (event.type === 'item.completed') {
      const parts = item.result && Array.isArray(item.result.content) ? item.result.content : [];
      for (const part of parts) if (part && part.type === 'image' && typeof part.data === 'string') pictures.push({ type: part.mimeType || part.mime_type || 'image/png', data: part.data });
      return pictures.length ? { pictures } : null;
    }
    let args = item.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    return { activity: replLabel(args || {}) };
  }
  return updateOf(provider, event, short);
}

/** The person's Codex config.toml → the names of their MCP servers a browser agent turns off. */
function codexServersOff(codexHome) {
  let text = '';
  try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch { return []; }
  const { readCodexConfig } = require('../onboarding/browser-agents.cjs'); // eslint-disable-line global-require
  return readCodexConfig(text).servers.map((server) => server.name).filter((name) => !CODEX_KEPT_SERVERS.has(name) && name !== 'engelbart' && /^[A-Za-z0-9_-]{1,64}$/.test(name));
}

// The person's Codex plugins a browser agent keeps: its browser control only. Every other plugin their config.toml turns
// on (some bring MCP servers of their own, Slack's among them) is off for the run, computer use too (round 3: it brings
// the browser's window to the front).
const CODEX_KEPT_PLUGINS = /^chrome@/;

/** The person's Codex config.toml → the plugins it turns on that a browser agent turns off. */
function codexPluginsOff(codexHome) {
  let text = '';
  try { text = fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'); } catch { return []; }
  const { readCodexConfig } = require('../onboarding/browser-agents.cjs'); // eslint-disable-line global-require
  return Object.entries(readCodexConfig(text).plugins).filter(([name, on]) => on && !CODEX_KEPT_PLUGINS.test(name) && /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+$/.test(name)).map(([name]) => name);
}

/** A TOML value for codex's -c (a string, a list, or an inline table of those), as JSON writes strings. */
function tomlValue(value) {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') return `{ ${Object.entries(value).map(([key, inner]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlValue(inner)}`).join(', ')} }`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

/** Claude Code's tools for a kind: what it is given (--tools) and what it may use without asking (--allowedTools). */
function claudeToolsFor(kind, connectors = []) {
  if (kind === 'redact' || kind === 'projects') return { tools: '', allowed: '' };
  if (!BRIDGED.has(kind)) return { tools: READ_TOOLS, allowed: READ_TOOLS };
  const tools = `${READ_TOOLS},${WEB_TOOLS}`;
  const extra = connectors.filter((connector) => SERVER_NAME_RE.test(connector.name)).flatMap((connector) => connectorTools(connector, kind).map((tool) => `mcp__${connector.name}__${tool}`));
  return { tools, allowed: [tools, IMPORT_TOOLS_PREFIX, ...extra].join(',') };
}

/**
 * `runDirectory`: where a turn's files go (prompt, input, MCP config). `interviewHome` / `importHome`: the private Codex
 * homes (their AGENTS.md is the agent's instructions; an import's is `${importHome}-<turn>`, removed after it).
 * `tools`: ../tools/manager.cjs, for the CLI's path and its lock.
 */
function createConnectAgents({ environment = process.env, runDirectory = path.join(os.tmpdir(), 'engelbart-connect-runs'), interviewHome = path.join(os.tmpdir(), 'engelbart-codex-home-connect'), importHome = `${interviewHome}-import`, codexAuthFile, run = execFile, tools = null, node = process.execPath, server = IMPORT_SERVER, terminal = null, retryWaits = RETRY_WAITS_MS, sleep = waitFor } = {}) {
  // The Engelbart terminal's agent sessions, for browser agents (made when one first runs: node-pty loads with it).
  let agentTerminal = terminal;
  const terminalNow = () => {
    if (!agentTerminal) agentTerminal = require('../terminal/agent-terminal.cjs').createAgentTerminal({ environment }); // eslint-disable-line global-require
    return agentTerminal;
  };
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

  async function claudeTurn({ kind, system, message, session, dirs, model, effort, signal, onUpdate, bridge, connectors, timeout, stem, cwd, toolNames }) {
    const promptFile = `${stem}.system.md`, inputFile = `${stem}.input.txt`, mcpFile = `${stem}.mcp.json`, connection = `${stem}.engelbart.json`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    fs.writeFileSync(inputFile, message, { mode: 0o600 });
    if (bridge) {
      fs.writeFileSync(connection, JSON.stringify({ url: bridge.url, token: bridge.token, kind, ...(toolNames ? { tools: toolNames } : {}) }), { mode: 0o600 });
      fs.writeFileSync(mcpFile, JSON.stringify(claudeServers({ node, server, connection, connectors, kind })), { mode: 0o600 });
    }
    const id = session || randomUUID();
    const grants = dirs.map((_, n) => `--add-dir "$ENGELBART_CONNECT_DIR${n}"`).join(' ');
    const servers = bridge ? ' --mcp-config "$ENGELBART_CONNECT_MCP"' : '';
    const { tools: given, allowed } = claudeToolsFor(kind, bridge ? connectors : []);
    // Not kept in the person's Claude Code history (2026-10-14: "it is alarming and no need for user to see this"), but
    // for the librarian's interview, whose turns resume one session.
    const command = `exec ${program('claude')} -p --output-format stream-json --verbose ${session ? '--resume' : '--session-id'} "$ENGELBART_CONNECT_SESSION"${kind === 'interview' ? '' : ' --no-session-persistence'} --restricted --setting-sources "" --strict-mcp-config${servers} --no-chrome --tools "${given}"${allowed ? ` --allowedTools "${allowed}"` : ''} --permission-prompts none ${grants} --model "$ENGELBART_CONNECT_MODEL" --effort ${effort} --system-prompt-file "$ENGELBART_CONNECT_PROMPT" < "$ENGELBART_CONNECT_INPUT"`;
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

  async function codexTurn({ kind, system, message, session, model, effort, signal, onUpdate, bridge, connectors, timeout, stem, cwd, dirs, toolNames }) {
    // A home of its own for every bridged turn and every discovery turn: the librarian's is shared turn to turn, and a
    // discovery agent starting while it talks would rewrite its instructions (AGENTS.md) under it.
    const own = bridge || kind === 'projects' ? `${importHome}-${path.basename(stem)}` : interviewHome;
    const source = codexAuthFile || path.join(environment.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
    if (!prepareCodexHome({ codexHome: own, source, instructions: system })) throw new ConnectError('unavailable', 'Codex is not signed in with a ChatGPT account (run `codex login`). An API key is never used.');
    const inputFile = `${stem}.input.txt`, outFile = `${stem}.out.txt`, connection = `${stem}.engelbart.json`;
    fs.writeFileSync(inputFile, message, { mode: 0o600 });
    if (bridge) {
      fs.writeFileSync(connection, JSON.stringify({ url: bridge.url, token: bridge.token, kind, ...(toolNames ? { tools: toolNames } : {}) }), { mode: 0o600 });
      writeImportConfig(own, { command: node, args: [server, connection], env: { ELECTRON_RUN_AS_NODE: '1' } }, connectors, kind);
    } else writeCodexConfig(own, {});
    const web = bridge ? 'true' : 'false'; // an app's help pages, when its skill is out of date
    const shared = `--skip-git-repo-check -m "$ENGELBART_CONNECT_MODEL" -c 'model_reasoning_effort="${effort}"' -c 'sandbox_mode="read-only"' -c 'tools.web_search=${web}' -c project_doc_max_bytes=0 --json -o "$ENGELBART_CONNECT_OUTPUT" - < "$ENGELBART_CONNECT_INPUT"`;
    const command = session ? `exec ${program('codex')} exec resume "$ENGELBART_CONNECT_SESSION" ${shared}` : `exec ${program('codex')} exec --color never ${shared}`;
    const tokens = Object.fromEntries((bridge ? connectors : []).filter((connector) => SERVER_NAME_RE.test(connector.name) && !connector.own && connector.token).map((connector) => [tokenEnv(connector.name), connector.token]));
    const env = childEnvironment({ ...programEnv('codex'), ...tokens, CODEX_HOME: own, ENGELBART_CONNECT_SESSION: session || '', ENGELBART_CONNECT_MODEL: codexModel(model, environment.CODEX_HOME || path.join(os.homedir(), '.codex')), ENGELBART_CONNECT_OUTPUT: outFile, ENGELBART_CONNECT_INPUT: inputFile });
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
      if (own !== interviewHome) fs.rmSync(own, { recursive: true, force: true });
    }
  }

  /* ------------------------------------------------------------------------------- browser agents (kind 'browse') */

  /**
   * A browser agent's CLI in the Engelbart terminal: its JSON events read line by line (the terminal's own line endings and
   * escape codes taken out), each step said in words, each screenshot it was shown kept in `steps` (at most
   * MAX_STEP_PICTURES), the transcript handed to `onUpdate({ transcript })` at the end for the Agent trace.
   */
  async function inTerminal({ provider, command, env, cwd, signal, timeout, onUpdate, dirs, steps }) {
    const short = pathLabeller(dirs);
    let pictures = 0;
    const keepPictures = (list) => {
      if (!steps) return;
      for (const picture of list) {
        if (pictures >= MAX_STEP_PICTURES) return;
        const ext = /jpe?g/.test(picture.type) ? 'jpg' : /webp/.test(picture.type) ? 'webp' : 'png';
        pictures += 1;
        const file = path.join(steps, `${String(pictures).padStart(3, '0')}.${ext}`);
        try { fs.mkdirSync(steps, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, Buffer.from(picture.data, 'base64'), { mode: 0o600 }); onUpdate({ picture: file }); } catch { /* the step is still logged */ }
      }
    };
    const lines = [];
    const out = await terminalNow().run({
      command, env, cwd, signal, timeout,
      onLine: (text) => {
        const trimmed = text.trim();
        if (!trimmed.startsWith('{')) return;
        lines.push(trimmed);
        let event;
        try { event = JSON.parse(trimmed); } catch { return; }
        const update = browseUpdateOf(provider, event, short);
        if (!update) return;
        if (update.pictures) keepPictures(update.pictures);
        if (update.activity) onUpdate({ activity: update.activity });
      },
    });
    onUpdate({ transcript: out.output });
    if (out.stopped || (signal && signal.aborted)) throw new ConnectError('stopped', 'Stopped.');
    return { stdout: lines.join('\n'), out };
  }

  /** Claude Code with Claude in Chrome (`-p --chrome`), in the Engelbart terminal. */
  async function claudeBrowse({ kind, system, message, dirs, model, effort, signal, onUpdate, bridge, connectors, timeout, stem, cwd, browse, toolNames }) {
    const promptFile = `${stem}.system.md`, inputFile = `${stem}.input.txt`, mcpFile = `${stem}.mcp.json`, connection = `${stem}.engelbart.json`;
    fs.writeFileSync(promptFile, system, { mode: 0o600 });
    fs.writeFileSync(inputFile, message, { mode: 0o600 });
    if (bridge) {
      fs.writeFileSync(connection, JSON.stringify({ url: bridge.url, token: bridge.token, kind, ...(toolNames ? { tools: toolNames } : {}) }), { mode: 0o600 });
      fs.writeFileSync(mcpFile, JSON.stringify(claudeServers({ node, server, connection, connectors, kind })), { mode: 0o600 });
    }
    const id = randomUUID();
    const grants = dirs.map((_, n) => `--add-dir "$ENGELBART_CONNECT_DIR${n}"`).join(' ');
    const servers = bridge ? ' --mcp-config "$ENGELBART_CONNECT_MCP"' : '';
    const { tools: given, allowed } = claudeToolsFor(kind, bridge ? connectors : []);
    // The browser calls are left to auto mode's classifier (not allowed up front): it reviews each one, and when it lets one
    // through the extension skips its own per-site question (code.claude.com/docs/en/chrome). Every prompt it would raise
    // instead is refused (--permission-prompts none): nobody is at this terminal.
    const command = `exec ${program('claude')} -p --output-format stream-json --verbose --session-id "$ENGELBART_CONNECT_SESSION" --no-session-persistence --setting-sources "" --strict-mcp-config${servers} --chrome --tools "${given}" --allowedTools "${allowed}" --disallowedTools "${CHROME_REFUSED.join(',')}" --permission-mode auto --permission-prompts none ${grants} --model "$ENGELBART_CONNECT_MODEL" --effort ${effort} --system-prompt-file "$ENGELBART_CONNECT_PROMPT" < "$ENGELBART_CONNECT_INPUT"`;
    const env = childEnvironment({ ...programEnv('claude'), ENGELBART_CONNECT_SESSION: id, ENGELBART_CONNECT_MODEL: model, ENGELBART_CONNECT_PROMPT: promptFile, ENGELBART_CONNECT_INPUT: inputFile, ...(bridge ? { ENGELBART_CONNECT_MCP: mcpFile } : {}), ...Object.fromEntries(dirs.map((dir, n) => [`ENGELBART_CONNECT_DIR${n}`, dir])) });
    onUpdate({ command: `claude -p --chrome --setting-sources "" --strict-mcp-config --tools "${given}" --disallowedTools "${CHROME_REFUSED.join(',')}" --permission-mode auto --permission-prompts none --model ${model} --effort ${effort}` });
    try {
      const { stdout, out } = await inTerminal({ provider: 'anthropic', command, env, cwd, signal, timeout, onUpdate, dirs, steps: browse.steps });
      const result = lastResultLine(stdout);
      if (!result) throw new ConnectError('unavailable', out.exitCode === 127 ? 'Claude Code was not found on the login shell PATH.' : `Claude Code did not return a result${out.timedOut ? ' (it ran out of time)' : ''}.`);
      if (result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new ConnectError('failed', String(result.result || result.subtype || 'The model returned no text.').slice(0, 300));
      return { text: result.result, session: id };
    } finally {
      for (const file of [promptFile, inputFile, mcpFile, connection]) { try { fs.unlinkSync(file); } catch { /* none */ } }
    }
  }

  /**
   * Codex with its Chrome plugin and computer use, in the Engelbart terminal: the person's own Codex home (its plugins,
   * Computer Use app and sign-in live there), with everything of theirs that could act on their behalf turned off for the
   * run (their MCP servers but node_repl, ChatGPT apps), its shell read-only, its Chrome plugin's per-site questions left
   * to Codex's auto-review and every other approval refused (CODEX_BROWSE_APPROVALS), Engelbart's tools added.
   */
  async function codexBrowse({ kind, system, message, model, effort, signal, onUpdate, bridge, timeout, stem, cwd, dirs, browse, toolNames }) {
    const home = environment.CODEX_HOME || path.join(os.homedir(), '.codex');
    const inputFile = `${stem}.input.txt`, outFile = `${stem}.out.txt`, connection = `${stem}.engelbart.json`;
    fs.writeFileSync(inputFile, message, { mode: 0o600 });
    if (bridge) fs.writeFileSync(connection, JSON.stringify({ url: bridge.url, token: bridge.token, kind, ...(toolNames ? { tools: toolNames } : {}) }), { mode: 0o600 });
    const off = [...codexServersOff(home).map((name) => `-c 'mcp_servers.${name}.enabled=false'`), ...codexPluginsOff(home).map((name) => `-c 'plugins."${name}".enabled=false'`)].join(' ');
    const enable = `${browse.enable ? ' --enable browser_use' : ''} --disable computer_use`;
    // --ephemeral: the run is not kept in the person's Codex history (their own CODEX_HOME), as Claude's above.
    const command = `exec ${program('codex')} exec --ephemeral --skip-git-repo-check --color never -m "$ENGELBART_CONNECT_MODEL" -c 'model_reasoning_effort="${effort}"' -c 'sandbox_mode="read-only"' ${CODEX_BROWSE_APPROVALS} -c project_doc_max_bytes=0 -c "developer_instructions=$ENGELBART_CONNECT_INSTRUCTIONS" ${off}${bridge ? ' -c "mcp_servers.engelbart=$ENGELBART_CONNECT_SERVER"' : ''} --disable apps${enable} --json -o "$ENGELBART_CONNECT_OUTPUT" - < "$ENGELBART_CONNECT_INPUT"`;
    const serverToml = bridge ? tomlValue({ command: node, args: [server, connection], env: { ELECTRON_RUN_AS_NODE: '1' }, startup_timeout_sec: 30, tool_timeout_sec: 240, default_tools_approval_mode: 'approve' }) : '';
    const env = childEnvironment({ ...programEnv('codex'), CODEX_HOME: home, ENGELBART_CONNECT_MODEL: codexModel(model, home), ENGELBART_CONNECT_OUTPUT: outFile, ENGELBART_CONNECT_INPUT: inputFile, ENGELBART_CONNECT_INSTRUCTIONS: tomlValue(system), ...(bridge ? { ENGELBART_CONNECT_SERVER: serverToml } : {}) });
    onUpdate({ command: `codex exec -m ${model} -c model_reasoning_effort="${effort}" -c sandbox_mode="read-only" ${CODEX_BROWSE_APPROVALS.replace(/'/g, '')} -c developer_instructions=<the system prompt> ${off.replace(/'/g, '')}${bridge ? ' -c mcp_servers.engelbart=<Engelbart\'s import tools>' : ''} --disable apps${enable}` });
    try {
      const { stdout, out } = await inTerminal({ provider: 'openai', command, env, cwd, signal, timeout, onUpdate, dirs, steps: browse.steps });
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch { text = ''; }
      if (!text.trim()) {
        if (out.exitCode === 127) throw new ConnectError('unavailable', 'Codex was not found on the login shell PATH.');
        const reason = String(stdout || '').split(/\r?\n/).reverse().find((one) => /"type":"(error|turn\.failed)"/.test(one)) || (out.timedOut ? 'It ran out of time.' : 'Codex returned no message.');
        throw new ConnectError('failed', reason.slice(0, 300));
      }
      return { text, session: null };
    } finally {
      for (const file of [inputFile, outFile, connection]) { try { fs.unlinkSync(file); } catch { /* none */ } }
    }
  }

  /**
   * One turn. `choice` { provider, modelId, effort }; `kind` interview | survey | import | recall | memory | redact | browse;
   * `bridge` { url, token } for the kinds that have Engelbart's tools; `connectors` [{ name, url, token }]; `browse` (kind
   * browse) { steps: the folder its screenshots go to, enable: Codex's browser use turned on for the run }.
   */
  async function turn({ choice, kind = 'interview', system, message, session = null, dirs = [], signal, onUpdate = () => {}, bridge = null, connectors = [], browse = null, toolNames = null }) {
    fs.mkdirSync(runDirectory, { recursive: true, mode: 0o700 });
    const stem = path.join(runDirectory, `${kind}-${randomUUID()}`);
    const cwd = runDirectory;
    const timeout = TIMEOUTS[kind] || TIMEOUTS.import;
    const cli = choice.provider === 'openai' ? 'codex' : 'claude';
    const fn = kind === 'browse' ? (cli === 'codex' ? codexBrowse : claudeBrowse) : (cli === 'codex' ? codexTurn : claudeTurn);
    const once = () => fn({ kind, system, message, session, dirs, model: choice.modelId, effort: choice.effort, signal, onUpdate, bridge: BRIDGED.has(kind) ? bridge : null, connectors, timeout, stem, cwd, browse: browse || {}, toolNames: Array.isArray(toolNames) ? toolNames : null });
    const attempt = async () => {
      if (!tools) return once();
      await tools.ensure(cli);
      try { return await tools.use(cli, once); } catch (error) { if (error && error.kind === 'unavailable') void tools.check([cli]).catch(() => {}); throw error; }
    };
    // The service's passing refusals (RETRY_WAITS_MS) tried again, the person told what is happening meanwhile.
    for (let tries = 0; ; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (tries >= retryWaits.length || !transientFailure(error) || (signal && signal.aborted)) throw error;
        const seconds = Math.round(retryWaits[tries] / 1000);
        onUpdate({ activity: `The model is busy: trying again${seconds ? ` in ${seconds} s` : ''}`, retry: { attempt: tries + 2, of: retryWaits.length + 1, reason: line(error.message, 200) } });
        await sleep(retryWaits[tries], signal);
        if (signal && signal.aborted) throw new ConnectError('stopped', 'Stopped.');
      }
    }
  }

  return { turn };
}

module.exports = { createConnectAgents, writeImportConfig, codexModel, claudeServers, claudeToolsFor, CONNECTOR_READS, connectorTools, importToolLabel, updateOf, browseUpdateOf, chromeToolLabel, replLabel, codexServersOff, codexPluginsOff, tomlValue, ConnectError, IMPORT_SERVER, TIMEOUTS, INTERVIEW_TIMEOUT_MS, IMPORT_TIMEOUT_MS, CHROME_REFUSED, CODEX_KEPT_SERVERS, CODEX_BROWSE_APPROVALS, RETRY_WAITS_MS, transientFailure };
