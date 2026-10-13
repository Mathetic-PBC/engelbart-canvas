'use strict';

// Browser agents (2026-10-13, the "Onboarding" workspace, second round: "We will use computer use in my real browser").
// An import of a web app (Google Drive, ChatGPT, Overleaf…) can run in the person's own browser, signed in as they are,
// instead of Engelbart's hidden one with sign-ins copied through the Keychain. What each provider can do there was
// checked on this Mac (Claude Code 2.1.296, codex-cli 0.162.1) before this was written:
//   Claude Code  its own computer use exists only in an interactive session (`claude -p` has none) and treats browsers as
//                view-only (code.claude.com/docs/en/computer-use: "browsers and trading platforms are view-only"); one
//                session holds the screen at a time and the other apps are hidden while it works. Its browser control is
//                Claude in Chrome: `claude -p --chrome` connects to the extension (tested: tabs_context_mcp answered, a tab
//                group of the session's own), in Chrome, Edge, Brave, Arc, Vivaldi or Opera.
//   Codex        `codex exec` with the person's own Codex home has its Chrome plugin (control-chrome: node_repl with its
//                browser-client, tested: it listed the connected Chrome) and computer use (@oai/sky through node_repl,
//                tested: sky.list_apps() answered), which works through accessibility in the background.
// So a browser agent is the provider's extension route in a browser where the extension is installed, the person's chosen
// browser first. Engelbart itself needs no macOS permission for it (no Accessibility, no Screen Recording): the
// extensions hold their own access, and Codex's computer use is its own app's ("Codex Computer Use").
//
// Whether the person's CLI already allows it decides whether Engelbart asks first (the workspace: "if it was not allowed
// before then before doing this there should be a permission prompt from Engelbart"):
//   Claude Code  allowed: "Enabled by default" in /chrome (~/.claude.json claudeInChromeDefaultEnabled). Otherwise the run
//                passes --chrome, after the person said yes.
//   Codex        allowed: features.browser_use not turned off in its config.toml, and the chrome plugin not disabled.
//                Otherwise the run turns them on for itself (--enable browser_use), after the person said yes.
// The answer is kept per data root (./prefs.cjs browserAgents). Nothing in the person's own configuration is changed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { browserById } = require('../../shared/import-flow.cjs');

// Where each Chromium browser keeps its profiles, under ~/Library/Application Support.
const PROFILE_ROOTS = Object.freeze({
  chrome: 'Google/Chrome', edge: 'Microsoft Edge', brave: 'BraveSoftware/Brave-Browser', arc: 'Arc/User Data',
  opera: 'com.operasoftware.Opera', chromium: 'Chromium', comet: 'Comet', vivaldi: 'Vivaldi',
});
// The extensions, by their Chrome Web Store ids; Codex's own list (chrome-native-hosts-v2.json extensionIds) wins when present.
const CLAUDE_EXTENSION = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';
const CODEX_EXTENSIONS = Object.freeze(['hehggadaopoacecdllhhajmbjkdcmajg', 'odlomjlbamekndcpllcnffbgeohgkmjh']);
const HOSTS = Object.freeze({ anthropic: 'com.anthropic.claude_code_browser_extension.json', openai: 'com.openai.codexextension.json' });
// The order a browser is chosen in when the person's own has no extension: Chrome first (both extensions ship for it).
const PREFERENCE = Object.freeze(['chrome', 'edge', 'brave', 'arc', 'vivaldi', 'opera', 'chromium', 'comet']);

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const isDir = (dir) => { try { return fs.statSync(dir).isDirectory(); } catch { return false; } };
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

/** A browser's profile folders (Default, Profile 1…) → absolute paths. */
function profilesOf(supportDir, browserId) {
  const root = PROFILE_ROOTS[browserId] ? path.join(supportDir, PROFILE_ROOTS[browserId]) : null;
  if (!root) return [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.filter((name) => name === 'Default' || /^Profile \d+$/.test(name)).map((name) => path.join(root, name)).filter(isDir);
}

/** Whether `browserId` has one of `ids` installed in any profile, and the CLI's messaging host registered for it. */
function hasExtension(supportDir, browserId, ids, host) {
  const root = PROFILE_ROOTS[browserId] ? path.join(supportDir, PROFILE_ROOTS[browserId]) : null;
  if (!root || !isFile(path.join(root, 'NativeMessagingHosts', host))) return false;
  return profilesOf(supportDir, browserId).some((profile) => ids.some((id) => isDir(path.join(profile, 'Extensions', id))));
}

/** Codex's config.toml → { features: { name: bool }, plugins: { 'name@market': bool }, servers: [{ name, enabled }] } (what this needs). */
function readCodexConfig(text) {
  const out = { features: {}, plugins: {}, servers: [] };
  let table = '';
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[\s*([^\]]+?)\s*\]$/);
    if (header) {
      table = header[1];
      const server = table.match(/^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/);
      if (server) out.servers.push({ name: server[1] || server[2], enabled: true });
      continue;
    }
    const pair = line.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const [, key, value] = pair;
    const bool = value === 'true' ? true : value === 'false' ? false : null;
    if (table === 'features' && bool !== null) out.features[key] = bool;
    else if (!table && /^features\./.test(key) && bool !== null) out.features[key.slice(9)] = bool;
    const plugin = table.match(/^plugins\."([^"]+)"$/);
    if (plugin && key === 'enabled' && bool !== null) out.plugins[plugin[1]] = bool;
    const server = table.match(/^mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/);
    if (server && key === 'enabled' && bool === false) { const name = server[1] || server[2]; const entry = out.servers.find((one) => one.name === name); if (entry) entry.enabled = false; }
  }
  return out;
}

/** Codex's Chrome plugin's browser-client, in its plugin cache → true when some version of it is there. */
function codexChromePlugin(codexHome) {
  const dir = path.join(codexHome, 'plugins', 'cache', 'openai-bundled', 'chrome');
  try { return fs.readdirSync(dir).some((version) => isFile(path.join(dir, version, 'scripts', 'browser-client.mjs'))); } catch { return false; }
}

/**
 * `homeDir`; `env` (CODEX_HOME); `prefs` { get(), set(patch) } (./prefs.cjs); `platform`. `fake` (ENGELBART_BROWSER_AGENTS:
 * 'allowed' | 'ask' | 'none') stands in for this Mac in scripted runs.
 * → { status({ provider, browserId }), consent(answer) }
 */
function createBrowserAgents({ homeDir = os.homedir(), env = process.env, prefs, platform = process.platform, fake = env.ENGELBART_BROWSER_AGENTS || '' }) {
  const supportDir = path.join(homeDir, 'Library', 'Application Support');
  const codexHome = () => env.CODEX_HOME || path.join(homeDir, '.codex');

  /** The browsers holding `provider`'s extension, the person's chosen one first, then PREFERENCE's order. */
  function browsersFor(provider, chosenId) {
    if (platform !== 'darwin') return [];
    let ids = provider === 'openai' ? CODEX_EXTENSIONS : [CLAUDE_EXTENSION];
    if (provider === 'openai') {
      const hosts = readJson(path.join(codexHome(), 'chrome-native-hosts-v2.json'));
      const listed = hosts && Array.isArray(hosts.entries) ? hosts.entries.flatMap((entry) => (Array.isArray(entry.extensionIds) ? entry.extensionIds : [])).filter((id) => /^[a-p]{32}$/.test(id)) : [];
      if (listed.length) ids = [...new Set(listed)];
    }
    const order = [...new Set([...(chosenId && PROFILE_ROOTS[chosenId] ? [chosenId] : []), ...PREFERENCE])];
    return order.filter((id) => hasExtension(supportDir, id, ids, HOSTS[provider]));
  }

  /** Whether the person's own CLI configuration already lets its agents drive their browser. */
  function allowedByCli(provider) {
    if (provider === 'anthropic') {
      const config = readJson(path.join(homeDir, '.claude.json')) || {};
      return config.claudeInChromeDefaultEnabled === true;
    }
    let text = '';
    try { text = fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'); } catch { text = ''; }
    const config = readCodexConfig(text);
    return config.features.browser_use !== false && config.plugins['chrome@openai-bundled'] !== false;
  }

  /**
   * → { available, provider, browser: { id, name } | null, others: [names], allowedByCli, consent: 'allowed' | 'declined' |
   * null, ask, use, why }: `ask` when Engelbart asks before the run (available, not allowed by the CLI, not answered yet);
   * `use` when the run uses it (available, and allowed by the CLI or by the person here).
   */
  function status({ provider, browserId = null } = {}) {
    const consent = (prefs.get() || {}).browserAgents || null;
    if (fake) {
      const available = fake !== 'none';
      const byCli = fake === 'allowed';
      const browser = available ? { id: 'chrome', name: 'Chrome' } : null;
      return { available, provider, browser, others: [], allowedByCli: byCli, consent, ask: available && !byCli && !consent, use: available && (byCli ? consent !== 'declined' : consent === 'allowed'), why: available ? '' : 'No browser has the extension (stand-in Mac)' };
    }
    if (provider !== 'anthropic' && provider !== 'openai') return { available: false, provider, browser: null, others: [], allowedByCli: false, consent, ask: false, use: false, why: 'No provider yet' };
    const ids = browsersFor(provider, browserId);
    const pluginOk = provider === 'openai' ? codexChromePlugin(codexHome()) : true;
    const available = ids.length > 0 && pluginOk;
    const byCli = available && allowedByCli(provider);
    const name = (id) => (browserById(id) || { name: id === 'vivaldi' ? 'Vivaldi' : id }).name;
    const why = available ? '' : !pluginOk ? 'Codex\'s Chrome plugin is not installed' : provider === 'anthropic' ? 'The Claude extension is not in a browser on this Mac' : 'The Codex extension is not in a browser on this Mac';
    return {
      available, provider, browser: available ? { id: ids[0], name: name(ids[0]) } : null, others: ids.slice(1).map(name),
      allowedByCli: byCli, consent, ask: available && !byCli && !consent,
      // A "no" given here wins over the CLI's own setting: the person said Engelbart's agents stay out of their browser.
      use: available && consent !== 'declined' && (byCli || consent === 'allowed'),
      why,
    };
  }

  /** The person's answer to "Let agents use your browser?" ('allowed' | 'declined'), kept; null forgets it. */
  function consent(answer) {
    if (answer !== 'allowed' && answer !== 'declined' && answer !== null) throw new TypeError('answer is invalid');
    prefs.set({ browserAgents: answer });
    return answer;
  }

  return { status, consent, browsersFor, allowedByCli };
}

module.exports = { createBrowserAgents, readCodexConfig, codexChromePlugin, hasExtension, PROFILE_ROOTS, CLAUDE_EXTENSION, CODEX_EXTENSIONS, HOSTS };
