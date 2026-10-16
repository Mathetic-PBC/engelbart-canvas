'use strict';

// The connectors the person has already signed in to in their own Claude Code or Codex (round 3, 2026-10-13: "for
// Granola I am already signed in … so an agent should just be able to use that headlessly"). An app with an official MCP
// server (connect-sources `mcp`: Granola, Notion, Linear, Evernote) that the person added to their CLI — matched by that server's address —
// is handed to the import agent under the person's own name for it, with no token of Engelbart's: each CLI finds its
// own sign-in for a server by its name and address. Verified on Hudson's Mac (Claude Code 2.1.x, codex-cli 0.162): a
// `claude -p --strict-mcp-config --mcp-config '{"granola": {"type": "http", "url": …}}'` turn used his Granola sign-in,
// and a private CODEX_HOME whose config.toml names the same server lists it as signed in ("Auth: OAuth").
//   Claude Code  ~/.claude.json mcpServers (user scope), http or sse servers. Its sign-in can't be read without a Keychain
//                prompt, so a server listed counts; one signed out shows no tools, and the agent asks for the sign-in.
//   Codex        `codex mcp list --json`: only a server whose auth_status says it is signed in (or needs none).
// Read at most every five minutes.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { APPS } = require('../../shared/connect-sources.cjs');

const KEEP_MS = 5 * 60_000;
const NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const SIGNED_IN = new Set(['o_auth', 'oauth', 'bearer_token', 'unsupported']);

const plain = (url) => String(url || '').trim().replace(/\/+$/, '').toLowerCase();

/**
 * The apps with an official server → { [address]: app }: its address and its others (`also`, 2026-10-16: Engelbart signs
 * in to Linear's read-only endpoint, a person's own Claude Code names https://mcp.linear.app/mcp; the agent is given only
 * the tools that read either way, agents.cjs).
 */
const officialServers = () => Object.fromEntries(Object.entries(APPS).filter(([, app]) => app.mcp)
  .flatMap(([name, app]) => [app.mcp, ...(Array.isArray(app.also) ? app.also : [])].map((url) => [plain(url), name])));

/** Claude Code's user-scope servers → [{ name, url, type }]. */
function claudeServersOf({ homeDir, env = process.env, readFile = (file) => fs.readFileSync(file, 'utf8') }) {
  const file = env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(homeDir, '.claude.json');
  let config = {};
  try { config = JSON.parse(readFile(file)) || {}; } catch { return []; }
  return Object.entries(config.mcpServers || {})
    .filter(([, server]) => server && typeof server === 'object' && (server.type === 'http' || server.type === 'sse') && typeof server.url === 'string')
    .map(([name, server]) => ({ name, url: server.url, type: server.type }));
}

/** Codex's servers as `codex mcp list --json` gives them → [{ name, url, signedIn }]. */
function codexServersOf(text) {
  let list = [];
  try { list = JSON.parse(String(text || '[]')); } catch { return []; }
  return (Array.isArray(list) ? list : [])
    .filter((server) => server && server.enabled !== false && server.transport && typeof server.transport.url === 'string')
    .map((server) => ({ name: String(server.name || ''), url: server.transport.url, signedIn: SIGNED_IN.has(String(server.auth_status || '').toLowerCase()) && !server.transport.bearer_token_env_var }));
}

/**
 * `homeDir`, `env`; `codexList()` → Promise<string> the JSON of `codex mcp list --json` (index.cjs runs it with the tools'
 * environment). → { serversFor(apps, provider), reaches(app, provider) }
 */
function createOwnConnectors({ homeDir, env = process.env, codexList = () => new Promise((resolve, reject) => { execFile('codex', ['mcp', 'list', '--json'], { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout))); }), readFile, now = Date.now } = {}) {
  const kept = new Map(); // provider → { at, servers: Promise<[{ app, name, url, type }]> }

  function serversOf(provider) {
    const hit = kept.get(provider);
    if (hit && now() - hit.at < KEEP_MS) return hit.servers;
    const official = officialServers();
    const mine = (list) => list.filter((server) => NAME_RE.test(server.name) && server.name !== 'engelbart' && official[plain(server.url)])
      .map((server) => ({ app: official[plain(server.url)], name: server.name, url: server.url, type: server.type || 'http' }));
    const servers = provider === 'openai'
      ? Promise.resolve().then(codexList).then((text) => mine(codexServersOf(text).filter((server) => server.signedIn))).catch(() => [])
      : Promise.resolve().then(() => mine(claudeServersOf({ homeDir, env, ...(readFile ? { readFile } : {}) }))).catch(() => []);
    kept.set(provider, { at: now(), servers });
    return servers;
  }

  /** The person's own servers for `apps` on `provider` ('anthropic' | 'openai') → [{ app, name, url, type, own: true }]. */
  async function serversFor(apps, provider) {
    const wanted = new Set(apps || []);
    const seen = new Set();
    return (await serversOf(provider)).filter((server) => wanted.has(server.app) && !seen.has(server.app) && seen.add(server.app)).map((server) => ({ ...server, own: true }));
  }

  /** Whether the person's own CLI reaches `app` through its server. */
  async function reaches(app, provider) {
    return (await serversFor([app], provider)).length > 0;
  }

  return { serversFor, reaches };
}

module.exports = { createOwnConnectors, claudeServersOf, codexServersOf, officialServers };
