#!/usr/bin/env node
'use strict';

// Engelbart on Macs it has never seen (2026-09-30): each scenario (./scenarios.cjs) is a pretend Mac (./machine.cjs)
// with pretend Claude Code, Codex and Git (./pretend.cjs), and Engelbart's real code runs against it: the launch check
// and what it does by itself (src/main/tools/manager.cjs start), then what a person does in the setup dialog (Install,
// Update, Sign In), then whether each program runs where Engelbart runs it: the terminal's Claude Code / Codex item,
// typed in a terminal, and hidden runs (@bart, Build, summaries). Nothing on this Mac is touched: installs are pretend
// ones from local files, sign-ins are pretend, and Apple's Git installer is never opened.
//
//   npm run mac-states                      every scenario but the slow ones (a hung program costs 40 seconds)
//   npm run mac-states -- --slow            all of them
//   npm run mac-states -- fresh-mac both-off-path     only these
//   npm run mac-states -- --keep            leave the pretend Macs on disk (their paths are printed)
//   npm run mac-states -- --json            what each scenario saw, as JSON
//
// Exits 1 when a scenario did not go as expected. test/mac-states.test.cjs runs the quick ones that guard fixed bugs
// through runScenario.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pty = require('node-pty');
const { createRunner } = require('../../src/main/tools/run.cjs');
const { detectTools } = require('../../src/main/tools/detect.cjs');
const { createActions } = require('../../src/main/tools/install.cjs');
const { createTools } = require('../../src/main/tools/manager.cjs');
const { createSignInProcess } = require('../../src/main/tools/sign-in.cjs');
const { createLaunchSpec, loginShellArgs, sanitizeEnvironment } = require('../../src/main/terminal/launch.cjs');
const { environmentForSessions } = require('../../src/main/shell-rc.cjs');
const { makeMac } = require('./machine.cjs');
const { SCENARIOS } = require('./scenarios.cjs');

const AGENTS = ['claude', 'codex'];
const LABEL = { claude: 'Claude Code', codex: 'Codex', git: 'Git' };
const RAN = { claude: 'PRETEND-CLAUDE-RAN', codex: 'PRETEND-CODEX-RAN' };

const args = require.main === module ? process.argv.slice(2) : [];
const flag = (name) => args.includes(`--${name}`);
const names = args.filter((arg) => !arg.startsWith('--'));
const unknown = names.filter((name) => !SCENARIOS.some((scenario) => scenario.name === name));
if (unknown.length) { console.error(`No scenario ${unknown.join(', ')}. There are: ${SCENARIOS.map((s) => s.name).join(', ')}`); process.exit(2); }
const chosen = SCENARIOS.filter((scenario) => (names.length ? names.includes(scenario.name) : flag('slow') || !scenario.slow));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function idle(tools, ms = 120_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const snap = tools.snapshot();
    if (snap.checked && Object.values(snap.tools).every((tool) => !tool.busy)) return snap;
    await sleep(200);
  }
  throw new Error('Engelbart was still busy after two minutes');
}

const brief = (tool) => `${tool.status}${tool.version ? ` ${tool.version}` : ''}${tool.installed && tool.onPath === false ? ' (off PATH)' : ''}${tool.untested ? ' (untested)' : ''}`;

/** A command run the way the terminal and the hidden runs run it: → what it printed. */
function run(file, argv, env, input = 'exit\n') {
  const out = spawnSync(file, argv, { env, input, encoding: 'utf8', timeout: 20_000, detached: true, cwd: env.HOME });
  return `${out.stdout || ''}${out.stderr || ''}`;
}

/** Where `tool` runs by name: the terminal's item for it, typed in a terminal, and a hidden run; the copy Engelbart chose (its version), not another. */
function reach(mac, tools, tool) {
  const version = tools.snapshot().tools[tool].version;
  const extra = tools.environment();
  const sessions = { ...environmentForSessions(mac.env, mac.userData), ...extra };
  const menuSpec = createLaunchSpec({ provider: tool, cwd: mac.home, cols: 120, rows: 30 }, sessions);
  const shellSpec = createLaunchSpec({ provider: 'shell', cwd: mac.home, cols: 120, rows: 30 }, sessions);
  // As @bart, Build and the summaries start it (src/main/build/runner.cjs program): by its full path when PATH misses it.
  const binary = tools.binaryFor(tool);
  const variable = `ENGELBART_${tool.toUpperCase()}_BIN`;
  const hiddenEnv = { ...sanitizeEnvironment(mac.env), ...extra, ...(binary ? { [variable]: binary } : {}) };
  const menu = run(menuSpec.file, menuSpec.args, menuSpec.env);
  const shell = run(shellSpec.file, shellSpec.args, shellSpec.env, `${tool}\nexit\n`);
  const hidden = run(mac.shell, loginShellArgs(mac.shell, `exec ${binary ? `"$${variable}"` : tool}`, hiddenEnv), hiddenEnv);
  const ok = (text) => text.includes(version ? `${RAN[tool]} ${version}` : RAN[tool]);
  const why = (text) => (ok(text) ? '' : (text.match(new RegExp(`${RAN[tool]} [\\d.]+`)) || text.match(/command not found[^\n]*|not found[^\n]*|Not logged in[^\n]*|Invalid API key[^\n]*|\bno such file[^\n]*/i) || [text.trim().split('\n').pop() || 'nothing'])[0].slice(0, 100));
  return { menu: ok(menu), shell: ok(shell), hidden: ok(hidden), why: { menu: why(menu), shell: why(shell), hidden: why(hidden) } };
}

async function runScenario(scenario, parent) {
  const mac = makeMac(scenario, parent);
  const runner = createRunner({ environment: mac.env });
  const detect = (only) => detectTools({ runner, only, home: mac.home, systemBins: mac.systemBins, bundledGit: mac.bundledGit });
  const real = createActions({ runner, home: mac.home, tmpDir: mac.tmp, installers: mac.installers });
  const refused = [];
  const actions = {
    ...real,
    // Apple's installer and Homebrew are this Mac's: never run from here (the VM is for those).
    installGit: async () => { refused.push('git install (Apple\'s installer)'); return { ok: false, kind: 'other', error: 'not run in scripts/mac-states' }; },
    updateGit: async () => { refused.push('git update (brew upgrade git)'); return { ok: false, kind: 'other', error: 'not run in scripts/mac-states' }; },
  };
  let stored = {};
  const tools = createTools({
    readTools: () => stored,
    writeTools: (value) => { stored = JSON.parse(JSON.stringify(value)); return null; },
    detect,
    actions,
    signInProcess: createSignInProcess({ pty, shell: runner.shellPath, environment: mac.env }),
    installAtLaunch: ['claude'],
  });

  const steps = [];
  const started = Date.now();
  await tools.start();
  const launch = await idle(tools);
  steps.push(`launch: ${AGENTS.map((name) => `${LABEL[name]} ${brief(launch.tools[name])}`).join(', ')}, Git ${brief(launch.tools.git)}`);
  for (const name of AGENTS) if (launch.tools[name].note) steps.push(`  ${LABEL[name]}'s note: "${launch.tools[name].note}"`);
  for (const name of AGENTS) if (launch.tools[name].error && launch.tools[name].status !== 'ready') steps.push(`  ${LABEL[name]}'s message: "${launch.tools[name].error}"`);

  // The person, in the setup dialog: whatever each row offers, until it works or nothing more is offered.
  for (const name of AGENTS) {
    if ((scenario.person || {})[name] === 'skip') { tools.skip([name]); steps.push(`${LABEL[name]}: skipped`); continue; }
    for (let turn = 0; turn < 3; turn += 1) {
      const record = tools.snapshot().tools[name];
      let did = null;
      if (record.status === 'missing' || record.status === 'failed') { did = 'Install'; await tools.install([name]); }
      else if (record.status === 'outdated' || record.status === 'incompatible') { did = 'Update'; await tools.update(name); }
      else if (record.status === 'signed-out') { did = 'Sign In'; await tools.signIn(name); }
      if (!did) break;
      const now = tools.snapshot().tools[name];
      steps.push(`${LABEL[name]}: ${did} → ${brief(now)}${now.error ? ` · "${now.error}"` : ''}${now.note ? ` · note: "${now.note}"` : ''}`);
      if (now.status === record.status && now.version === record.version) break; // nothing changed: the row stays as it is
    }
  }
  const final = await idle(tools);
  const reached = {};
  for (const name of AGENTS) {
    const record = final.tools[name];
    if (record.installed || tools.snapshot().tools[name].status === 'ready' || ((scenario.expect || {}).reach || {})[name]) reached[name] = reach(mac, tools, name);
  }
  const usable = tools.usableAgents();

  // Against what should have happened.
  const expect = scenario.expect || {};
  const problems = [];
  for (const [name, status] of Object.entries(expect.launch || {})) {
    if (launch.tools[name].status !== status) problems.push(`${LABEL[name]} at launch: ${brief(launch.tools[name])}, expected ${status}${launch.tools[name].error ? ` ("${launch.tools[name].error}")` : ''}`);
  }
  const finals = { claude: 'ready', codex: 'ready', ...(expect.final || {}) };
  for (const [name, status] of Object.entries(finals)) {
    if (final.tools[name].status !== status) problems.push(`${LABEL[name]} at the end: ${brief(final.tools[name])}, expected ${status}${final.tools[name].error ? ` ("${final.tools[name].error}")` : ''}`);
  }
  for (const [name, pattern] of Object.entries(expect.notes || {})) {
    if (!pattern.test(final.tools[name].note || '')) problems.push(`${LABEL[name]}'s note ${final.tools[name].note ? `"${final.tools[name].note}"` : '(none)'} does not match ${pattern}`);
  }
  for (const [name, pattern] of Object.entries(expect.errors || {})) {
    if (!pattern.test(final.tools[name].error || '')) problems.push(`${LABEL[name]}'s message ${final.tools[name].error ? `"${final.tools[name].error}"` : '(none)'} does not match ${pattern}`);
  }
  for (const name of AGENTS) {
    const want = (expect.reach || {})[name] || (finals[name] === 'ready' ? { menu: true, shell: true, hidden: true } : null);
    if (!want) continue;
    const got = reached[name] || { menu: false, shell: false, hidden: false, why: {} };
    for (const where of ['menu', 'shell', 'hidden']) {
      if (got[where] !== want[where]) problems.push(`${LABEL[name]} ${want[where] ? 'does not run' : 'runs'} ${{ menu: 'from the terminal\'s menu', shell: 'typed in a terminal', hidden: 'in a hidden run (@bart, Build)' }[where]}${got.why && got.why[where] ? `: ${got.why[where]}` : ''}`);
    }
    const shouldUse = finals[name] === 'ready' && want.hidden !== false;
    if (usable && usable.includes(name) !== shouldUse) problems.push(`@bart ${shouldUse ? 'cannot' : 'can'} use ${LABEL[name]}`);
  }
  const gitWant = expect.git || 'ready';
  if (final.tools.git.status !== gitWant) problems.push(`Git at the end: ${brief(final.tools.git)}, expected ${gitWant}`);
  if (expect.gitSource && final.tools.git.source !== expect.gitSource) problems.push(`Git is ${final.tools.git.source}'s, expected ${expect.gitSource}'s`);
  if (expect.gitSource === 'bundled') {
    const env = { ...sanitizeEnvironment(mac.env), ...tools.environment() };
    const said = run(mac.shell, loginShellArgs(mac.shell, 'git --version', env), env);
    if (!/2\.53\.0/.test(said)) problems.push(`a hidden run's git is not Engelbart's: "${said.trim().split('\n').pop()}"`);
  }

  return { name: scenario.name, about: scenario.about, why: scenario.why || null, mac: mac.root, seconds: Math.round((Date.now() - started) / 1000), steps, refused, reached, problems, launch: launch.tools, final: final.tools };
}

async function main() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-mac-states-'));
  const results = [];
  const queue = [...chosen];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (queue.length) {
      const scenario = queue.shift();
      try { results.push(await runScenario(scenario, parent)); } catch (error) { results.push({ name: scenario.name, about: scenario.about, problems: [`the run itself failed: ${error.stack || error.message}`], steps: [], refused: [] }); }
      if (!flag('json')) process.stderr.write('.');
    }
  });
  await Promise.all(workers);
  if (!flag('json')) process.stderr.write('\n');
  results.sort((a, b) => chosen.findIndex((s) => s.name === a.name) - chosen.findIndex((s) => s.name === b.name));

  if (flag('json')) console.log(JSON.stringify(results, null, 2));
  else {
    for (const result of results) {
      console.log(`\n${result.problems.length ? '✗' : '✓'} ${result.name}${result.seconds != null ? `  (${result.seconds}s)` : ''}\n  ${result.about}`);
      for (const step of result.steps) console.log(`    ${step}`);
      for (const [name, where] of Object.entries(result.reached || {})) console.log(`    ${LABEL[name]} runs: menu ${where.menu ? '✓' : '✗'}  typed ${where.shell ? '✓' : '✗'}  hidden ${where.hidden ? '✓' : '✗'}`);
      if (result.refused.length) console.log(`    not run here: ${result.refused.join(', ')}`);
      for (const problem of result.problems) console.log(`  ✗ ${problem}`);
      if (result.problems.length && result.why) console.log(`    why it matters: ${result.why}`);
      if (flag('keep')) console.log(`    the pretend Mac: ${result.mac}`);
    }
    const failed = results.filter((result) => result.problems.length);
    console.log(`\n${results.length - failed.length} of ${results.length} went as expected${failed.length ? `; not: ${failed.map((result) => result.name).join(', ')}` : ''}.${chosen.length < SCENARIOS.length && !names.length ? ` (${SCENARIOS.length - chosen.length} slow ones left out: --slow)` : ''}`);
  }
  if (!flag('keep')) fs.rmSync(parent, { recursive: true, force: true });
  process.exit(results.some((result) => result.problems.length) ? 1 : 0);
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(2); });

module.exports = { runScenario };
