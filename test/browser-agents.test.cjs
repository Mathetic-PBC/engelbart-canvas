'use strict';

// Browser agents (2026-10-13, the "Onboarding" workspace, second round: "We will use computer use in my real browser"):
// when the web apps' imports can run in the person's own browser and whether Engelbart asks first
// (src/main/onboarding/browser-agents.cjs), the Engelbart terminal they run in (src/main/terminal/agent-terminal.cjs), and
// the commands they run with (src/main/connect/agents.cjs kind browse). No real CLI and no real browser are touched: the
// terminal is a fake pseudo-terminal, the homes are temporary folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBrowserAgents, readCodexConfig, CLAUDE_EXTENSION, CODEX_EXTENSIONS } = require('../src/main/onboarding/browser-agents.cjs');
const { createAgentTerminal, plain, answersFor } = require('../src/main/terminal/agent-terminal.cjs');
const { createConnectAgents, browseUpdateOf, chromeToolLabel, codexServersOff, codexPluginsOff, CHROME_REFUSED } = require('../src/main/connect/agents.cjs');
const prefsModule = require('../src/main/onboarding/prefs.cjs');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eb-browser-agents-')));
const mkdir = (...parts) => { const dir = path.join(...parts); fs.mkdirSync(dir, { recursive: true }); return dir; };
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** A home with Chrome holding the Claude and Codex extensions, their messaging hosts and Codex's Chrome plugin. */
function homeWithChrome({ claude = true, codex = true } = {}) {
  const home = tmp();
  const chrome = path.join(home, 'Library', 'Application Support', 'Google', 'Chrome');
  if (claude) { mkdir(chrome, 'Default', 'Extensions', CLAUDE_EXTENSION, '1.0'); write(path.join(chrome, 'NativeMessagingHosts', 'com.anthropic.claude_code_browser_extension.json'), '{}'); }
  if (codex) {
    mkdir(chrome, 'Profile 1', 'Extensions', CODEX_EXTENSIONS[0], '1.0');
    write(path.join(chrome, 'NativeMessagingHosts', 'com.openai.codexextension.json'), '{}');
    write(path.join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'chrome', '1.0.0', 'scripts', 'browser-client.mjs'), '');
  }
  return home;
}
const memoryPrefs = () => { let kept = {}; return { get: () => kept, set: (patch) => { kept = { ...kept, ...patch }; for (const [key, value] of Object.entries(patch)) if (value === null) delete kept[key]; return kept; } }; };

test('Claude Code: available where the extension and its host are; asked first unless /chrome is on by default; a no wins', () => {
  const home = homeWithChrome({ codex: false });
  const prefs = memoryPrefs();
  const agents = createBrowserAgents({ homeDir: home, env: {}, prefs, platform: 'darwin', fake: '' });
  let status = agents.status({ provider: 'anthropic' });
  assert.equal(status.available, true);
  assert.deepEqual(status.browser, { id: 'chrome', name: 'Chrome' });
  assert.equal(status.allowedByCli, false);
  assert.equal(status.ask, true, 'not allowed in their CLI: Engelbart asks');
  assert.equal(status.use, false);
  agents.consent('allowed');
  status = agents.status({ provider: 'anthropic' });
  assert.equal(status.ask, false);
  assert.equal(status.use, true);
  write(path.join(home, '.claude.json'), JSON.stringify({ claudeInChromeDefaultEnabled: true }));
  agents.consent(null);
  status = agents.status({ provider: 'anthropic' });
  assert.equal(status.allowedByCli, true);
  assert.equal(status.ask, false, 'allowed in their CLI: not asked');
  assert.equal(status.use, true);
  agents.consent('declined');
  assert.equal(agents.status({ provider: 'anthropic' }).use, false, 'the person\'s no in Engelbart wins over the CLI\'s setting');
  assert.throws(() => agents.consent('maybe'), /invalid/);
  // Codex has no extension in this home.
  assert.equal(agents.status({ provider: 'openai' }).available, false);
  assert.equal(agents.status({ provider: 'openai' }).ask, false);
});

test('Codex: the extension in any profile, its Chrome plugin, and browser_use not turned off in config.toml', () => {
  const home = homeWithChrome({ claude: false });
  const agents = createBrowserAgents({ homeDir: home, env: {}, prefs: memoryPrefs(), platform: 'darwin', fake: '' });
  assert.equal(agents.status({ provider: 'openai' }).allowedByCli, true, 'nothing turned off');
  write(path.join(home, '.codex', 'config.toml'), '[features]\nbrowser_use = false\n');
  const status = agents.status({ provider: 'openai' });
  assert.equal(status.available, true);
  assert.equal(status.allowedByCli, false);
  assert.equal(status.ask, true);
  fs.rmSync(path.join(home, '.codex', 'plugins'), { recursive: true });
  assert.equal(agents.status({ provider: 'openai' }).available, false, 'no Chrome plugin: not available');
  assert.match(agents.status({ provider: 'openai' }).why, /Chrome plugin/);
  assert.equal(createBrowserAgents({ homeDir: home, env: {}, prefs: memoryPrefs(), platform: 'linux', fake: '' }).status({ provider: 'anthropic' }).available, false);
});

test('the answer is kept per data root, beside the other onboarding answers', () => {
  const root = tmp();
  const prefs = { get: () => prefsModule.get(root), set: (patch) => prefsModule.set(root, patch) };
  const agents = createBrowserAgents({ homeDir: homeWithChrome(), env: {}, prefs, platform: 'darwin', fake: '' });
  agents.consent('allowed');
  assert.equal(prefsModule.get(root).browserAgents, 'allowed');
  prefsModule.set(root, { browserAgents: 'whatever' });
  assert.equal(prefsModule.get(root).browserAgents, undefined, 'only allowed or declined is kept');
  agents.consent('declined');
  assert.equal(prefsModule.get(root).browserAgents, 'declined');
  agents.consent(null);
  assert.equal(prefsModule.get(root).browserAgents, undefined);
});

test('config.toml read for what a browser agent needs: features, plugins, MCP servers', () => {
  const config = readCodexConfig(['model = "x"', 'features.computer_use = false', '[features]', 'browser_use = true # on', '[plugins."chrome@openai-bundled"]', 'enabled = true', '[plugins."slack@openai-curated"]', 'enabled = true', '[mcp_servers.research]', 'command = "x"', '[mcp_servers."node_repl"]', 'command = "y"', '[mcp_servers.old]', 'enabled = false'].join('\n'));
  assert.deepEqual(config.features, { computer_use: false, browser_use: true });
  assert.deepEqual(config.plugins, { 'chrome@openai-bundled': true, 'slack@openai-curated': true });
  assert.deepEqual(config.servers, [{ name: 'research', enabled: true }, { name: 'node_repl', enabled: true }, { name: 'old', enabled: false }]);
  const home = tmp();
  write(path.join(home, 'config.toml'), ['[mcp_servers.research]', 'command = "x"', '[mcp_servers.node_repl]', 'command = "y"', '[mcp_servers.computer-use]', 'command = "z"', '[plugins."chrome@openai-bundled"]', 'enabled = true', '[plugins."slack@openai-curated"]', 'enabled = true', '[plugins."computer-use@openai-bundled"]', 'enabled = true'].join('\n'));
  // Round 3 (2026-10-13): computer use is off for a browser agent, server and plugin ("it shifted my window to the chrome window").
  assert.deepEqual(codexServersOff(home), ['research', 'computer-use'], 'node_repl kept, computer use off');
  assert.deepEqual(codexPluginsOff(home), ['slack@openai-curated', 'computer-use@openai-bundled'], 'only the Chrome plugin kept');
});

/** A node-pty stand-in: records what was spawned and written; `script(handle)` plays the session. */
function fakePty(script) {
  const spawned = [];
  return {
    spawned,
    spawn(file, args, options) {
      const events = new EventEmitter();
      const handle = {
        written: [], killed: [],
        onData: (fn) => events.on('data', fn), onExit: (fn) => events.on('exit', fn),
        write: (data) => handle.written.push(data),
        kill: (signal) => { handle.killed.push(signal); setImmediate(() => events.emit('exit', { exitCode: 143, signal: 15 })); },
        print: (data) => events.emit('data', data), exit: (code = 0) => events.emit('exit', { exitCode: code }),
      };
      spawned.push({ file, args, options, handle });
      setImmediate(() => script(handle));
      return handle;
    },
  };
}

test('the Engelbart terminal: a login shell, the terminal\'s questions answered, lines without escape codes, Stop ends it', { skip: process.platform === 'win32' && 'POSIX terminals only: on Windows the shell is Git Bash (windows-platform.test.cjs)' }, async () => {
  assert.equal(plain('\x1b[1mbold\x1b[0m\r\n\x1b]0;title\x07next\rline'), 'bold\nnext\nline');
  assert.deepEqual(answersFor('\x1b[c\x1b[>q'), ['\x1b[?62;22c', '\x1bP>|xterm.js(6.0.0)\x1b\\']);
  const pty = fakePty((handle) => { handle.print('\x1b[c{"type":"a"}\r\n{"type":'); handle.print('"b"}\r\npartial'); handle.exit(0); });
  const terminal = createAgentTerminal({ pty, environment: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: '/tmp' } });
  const lines = [];
  const out = await terminal.run({ command: 'exec claude -p', env: { SHELL: '/bin/zsh', PATH: '/usr/bin', HOME: '/tmp', SECRET: 'kept-as-given' }, cwd: '/tmp', onLine: (line) => lines.push(line) });
  assert.deepEqual(lines, ['{"type":"a"}', '{"type":"b"}', 'partial']);
  assert.equal(out.exitCode, 0);
  const run = pty.spawned[0];
  assert.equal(run.file, '/bin/zsh');
  assert.ok(run.args.includes('exec claude -p'), JSON.stringify(run.args));
  assert.equal(run.options.env.TERM, 'xterm-256color');
  assert.equal(run.options.env.SECRET, 'kept-as-given', 'the caller\'s environment is the whole of it');
  assert.deepEqual(run.handle.written, ['\x1b[?62;22c'], 'the terminal question answered as xterm.js answers it');
  const hung = fakePty(() => {});
  const controller = new AbortController();
  const pending = createAgentTerminal({ platform: 'darwin', pty: hung, environment: { SHELL: '/bin/zsh' } }).run({ command: 'sleep 99', cwd: '/tmp', signal: controller.signal });
  controller.abort();
  const stopped = await pending;
  assert.equal(stopped.stopped, true);
  assert.deepEqual(hung.spawned[0].handle.killed, ['SIGTERM']);
});

test('a browser agent\'s run: Claude in Chrome with the risky tools refused and no prompt left to anyone; Codex read-only with the person\'s other servers and plugins off', async () => {
  const home = tmp();
  write(path.join(home, '.codex', 'config.toml'), '[mcp_servers.research]\ncommand = "x"\n[mcp_servers.node_repl]\ncommand = "y"\n[plugins."slack@openai-curated"]\nenabled = true\n');
  const runs = [];
  const terminal = {
    async run({ command, env, onLine }) {
      runs.push({ command, env });
      if (/claude/.test(command)) {
        onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://docs.google.com/document/d/1' } }] } }));
        onLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Brought in 2 documents.' }));
      } else {
        fs.writeFileSync(env.ENGELBART_CONNECT_OUTPUT, 'Brought in 1 document.');
      }
      return { output: 'transcript', exitCode: 0, signal: null, timedOut: false, stopped: false };
    },
  };
  const agents = createConnectAgents({ environment: { HOME: home, CODEX_HOME: path.join(home, '.codex'), PATH: '/usr/bin' }, runDirectory: path.join(home, 'runs'), terminal });
  const updates = [];
  const steps = path.join(home, 'steps');
  const claude = await agents.turn({ choice: { provider: 'anthropic', modelId: 'sonnet', effort: 'high' }, kind: 'browse', system: 'rules', message: 'go', browse: { steps, enable: true }, onUpdate: (update) => updates.push(update) });
  assert.equal(claude.text, 'Brought in 2 documents.');
  const claudeCommand = runs[0].command;
  assert.match(claudeCommand, / -p /);
  assert.match(claudeCommand, / --chrome /);
  assert.match(claudeCommand, /--setting-sources "" --strict-mcp-config/, 'none of the person\'s settings or MCP servers');
  assert.match(claudeCommand, /--permission-mode auto --permission-prompts none/);
  assert.match(claudeCommand, new RegExp(`--disallowedTools "${CHROME_REFUSED.join(',')}"`));
  for (const name of ['javascript_tool', 'form_input', 'upload_image', 'switch_browser', 'resize_window']) assert.ok(CHROME_REFUSED.includes(`mcp__claude-in-chrome__${name}`), name);
  // Round 3: it closes the tabs it opened ("The agents need to close all of the tabs and tab groups when they're done").
  assert.ok(!CHROME_REFUSED.includes('mcp__claude-in-chrome__tabs_close_mcp'));
  assert.ok(updates.some((update) => update.command && /--chrome/.test(update.command)), 'its command kept for the trace');
  assert.ok(updates.some((update) => update.activity === 'Opening docs.google.com'), JSON.stringify(updates));
  assert.ok(updates.some((update) => update.transcript === 'transcript'));
  const codex = await agents.turn({ choice: { provider: 'openai', modelId: 'gpt-x', effort: 'high' }, kind: 'browse', system: 'rules', message: 'go', browse: { steps, enable: false } });
  assert.equal(codex.text, 'Brought in 1 document.');
  const codexCommand = runs[1].command;
  assert.match(codexCommand, /sandbox_mode="read-only"/);
  // 2026-10-14: not approval_policy="never", which declined the Chrome plugin's every per-site question as if the person
  // had (Hudson's Gmail and Google Drive). Those go to Codex's auto-review; every other approval is still refused.
  assert.doesNotMatch(codexCommand, /approval_policy="never"/);
  assert.match(codexCommand, /approval_policy=\{ granular = \{ sandbox_approval = false, rules = false, skill_approval = false, request_permissions = false, mcp_elicitations = true \} \}/);
  assert.match(codexCommand, /approvals_reviewer="auto_review"/);
  assert.match(codexCommand, /mcp_servers\.research\.enabled=false/);
  assert.doesNotMatch(codexCommand, /node_repl\.enabled=false/, 'node_repl stays: the Chrome plugin runs in it');
  assert.match(codexCommand, /plugins\."slack@openai-curated"\.enabled=false/);
  assert.match(codexCommand, /--disable apps/);
  assert.doesNotMatch(codexCommand, /--enable browser_use/, 'already allowed in their Codex: nothing turned on');
  assert.match(codexCommand, /--disable computer_use/, 'computer use never: it brings windows to the front');
  assert.equal(runs[1].env.CODEX_HOME, path.join(home, '.codex'), 'the person\'s own Codex home: its plugins and sign-in');
  assert.equal(runs[1].env.OPENAI_API_KEY, undefined);
});

test('a browser agent\'s steps in words', () => {
  assert.equal(chromeToolLabel('tabs_create_mcp', {}), 'Opening its own tab');
  const update = browseUpdateOf('anthropic', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__claude-in-chrome__get_page_text', input: {} }] } }, (p) => p);
  assert.equal(update.activity, 'Reading the page');
});
