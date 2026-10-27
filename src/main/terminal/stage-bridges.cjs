'use strict';

// One Stage tool bridge for each Claude Code, Codex or shell session started from Engelbart's terminal (MATH-79, 2026-10-26).
// `prepare(provider)` opens a loopback bridge (../sandbox/local-tools.cjs openToolBridge) before the session starts,
// writes its connection file (0600, under userData, as a Build's is) and answers the variables the provider script reads
// (./launch.cjs STAGE_ENVIRONMENT); `bind(session)` ties it to the session once it has an id. It is closed, and its files
// removed, when the session exits or is closed and when the app quits. A bridge that does not open leaves the agent to
// start without the tool.
//
// A shell session gets both providers' variables from its one bridge: `claude` or `codex` typed in it, which is also
// how the terminal's agent menu starts them in an idle tab, add them through the functions ../shell-rc.cjs defines.
//
// Claude Code gets the `engelbart-stage` server from an --mcp-config file and the line from --append-system-prompt, its
// own settings and MCP servers still loaded. Codex has no flag for extra instructions in its interactive TUI, so the line
// goes in as `-c developer_instructions=…`; that replaces the setting, so a developer_instructions the person's own
// config.toml sets (CODEX_HOME's, else ~/.codex's) comes first and the line after it.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openToolBridge } = require('../sandbox/local-tools.cjs');
const { STAGE_NOTE } = require('./stage-tools.cjs');

const SERVER = path.join(__dirname, 'stage-mcp.cjs');
const SERVER_NAME = 'engelbart-stage';
const PROVIDERS = new Set(['claude', 'codex', 'shell']);
const toml = (value) => JSON.stringify(value); // a JSON string or array of strings is TOML too

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/** A TOML basic string's body with its escapes undone; `multiline`: a backslash at a line's end joins it to the next. */
function unescapeBasic(body, multiline = false) {
  const joined = multiline ? body.replace(/\\[ \t]*\r?\n\s*/g, '') : body;
  return joined.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (all, code) => {
    if (code.length > 1) return String.fromCodePoint(parseInt(code.slice(1), 16));
    return Object.hasOwn(ESCAPES, code) ? ESCAPES[code] : all;
  });
}

/**
 * The top-level `developer_instructions` a Codex config.toml sets (before its first [table]), or null: a basic, literal
 * or multi-line string. Anything this cannot read is left as none.
 */
function codexInstructions(text) {
  const source = String(text || '');
  const header = source.search(/^\s*\[/m);
  const top = header >= 0 ? source.slice(0, header) : source;
  const at = /^[ \t]*developer_instructions[ \t]*=[ \t]*/m.exec(top);
  if (!at) return null;
  const rest = top.slice(at.index + at[0].length);
  const firstLine = (value) => value.replace(/^\r?\n/, ''); // a newline right after the opening quotes is not part of it
  let match;
  if ((match = /^"""([\s\S]*?)"""(?!")/.exec(rest))) return unescapeBasic(firstLine(match[1]), true);
  if ((match = /^'''([\s\S]*?)'''(?!')/.exec(rest))) return firstLine(match[1]);
  if ((match = /^"((?:[^"\\\n]|\\.)*)"/.exec(rest))) return unescapeBasic(match[1]);
  if ((match = /^'([^'\n]*)'/.exec(rest))) return match[1];
  return null;
}

/** What Codex is told: the person's own developer_instructions, when their config.toml sets any, then the line. */
function codexNote(home) {
  let text = '';
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8'); } catch { /* no config: the line alone */ }
  const own = codexInstructions(text);
  return own && own.trim() ? `${own.replace(/\s+$/, '')}\n\n${STAGE_NOTE}` : STAGE_NOTE;
}

/**
 * `directory`: where connection files go (under userData); `toolFor(session)` → the bridge's callTool, where
 * `session()` is { id, cwd } once bound, else null (./stage-tools.cjs stageToolFor); `codexHome()` → the person's
 * CODEX_HOME. `openBridge`, `execPath` and `report` are for tests.
 */
function createStageBridges({ directory, toolFor, codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), openBridge = openToolBridge, execPath = process.execPath, report = (error) => console.warn(`[engelbart] stage tool: ${error.message}`) }) {
  const bound = new Map(); // session id → entry

  // Files a run that did not quit cleanly left behind.
  try {
    for (const name of fs.readdirSync(directory)) if (/\.(?:connection|mcp)\.json$/.test(name)) fs.rmSync(path.join(directory, name), { force: true });
  } catch { /* none yet */ }

  async function release(entry) {
    if (entry.closed) return;
    entry.closed = true;
    for (const file of entry.files) { try { fs.unlinkSync(file); } catch { /* gone */ } }
    await Promise.resolve(entry.bridge.close()).catch(report);
  }

  /** → { stage, bind(session), discard() } for a Claude Code, Codex or shell session; null for another, or when it cannot open. */
  async function prepare(provider) {
    if (!PROVIDERS.has(provider)) return null;
    let current = null;
    let bridge;
    try {
      bridge = await openBridge(toolFor(() => current));
    } catch (error) {
      report(error);
      return null;
    }
    const entry = { bridge, files: [], closed: false };
    let stage;
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stem = path.join(directory, randomUUID());
      const connection = `${stem}.connection.json`;
      fs.writeFileSync(connection, JSON.stringify({ url: bridge.connection.url, token: bridge.connection.token }), { mode: 0o600 });
      entry.files.push(connection);
      const server = { command: execPath, args: [SERVER, connection] };
      stage = {};
      if (provider !== 'codex') {
        const config = `${stem}.mcp.json`;
        fs.writeFileSync(config, JSON.stringify({ mcpServers: { [SERVER_NAME]: { ...server, env: { ELECTRON_RUN_AS_NODE: '1' } } } }), { mode: 0o600 });
        entry.files.push(config);
        Object.assign(stage, { ENGELBART_TERMINAL_MCP: config, ENGELBART_TERMINAL_NOTE: STAGE_NOTE });
      }
      if (provider !== 'claude') {
        Object.assign(stage, {
          ENGELBART_TERMINAL_CODEX_COMMAND: `mcp_servers.${SERVER_NAME}.command=${toml(server.command)}`,
          ENGELBART_TERMINAL_CODEX_ARGS: `mcp_servers.${SERVER_NAME}.args=${toml(server.args)}`,
          ENGELBART_TERMINAL_CODEX_ENV: `mcp_servers.${SERVER_NAME}.env={ ELECTRON_RUN_AS_NODE = "1" }`,
          ENGELBART_TERMINAL_CODEX_NOTE: `developer_instructions=${toml(codexNote(codexHome()))}`,
        });
      }
    } catch (error) {
      report(error);
      await release(entry);
      return null;
    }
    return {
      stage,
      bind(session) {
        current = { id: session.id, cwd: session.cwd };
        bound.set(session.id, entry);
      },
      discard: () => release(entry),
    };
  }

  /** The session exited or was closed: its bridge closes and its files go. */
  function close(sessionId) {
    const entry = bound.get(sessionId);
    if (!entry) return Promise.resolve();
    bound.delete(sessionId);
    return release(entry);
  }

  const closeAll = () => Promise.all([...bound.keys()].map(close)).then(() => {});

  return { prepare, close, closeAll, has: (sessionId) => bound.has(sessionId) };
}

module.exports = { createStageBridges, codexInstructions, codexNote, SERVER_NAME };
