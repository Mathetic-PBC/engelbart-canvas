'use strict';

// Engelbart's real tool check, installs, sign-ins, terminal and hidden runs on pretend Macs (scripts/mac-states,
// 2026-09-30): the quick scenarios, among them one for each bug they found. `npm run mac-states` runs every scenario.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScenario } = require('../scripts/mac-states/run.cjs');
const { SCENARIOS } = require('../scripts/mac-states/scenarios.cjs');

const QUICK = [
  'fresh-mac', 'both-off-path',
  'claude-old-homebrew-shadows-new', // an old copy first on PATH hid a good one
  'both-off-path-bash', // bash: typed in the terminal, PATH missed the agents
  'codex-name-clash', 'codex-name-clash-install', // another program called codex was taken for Codex
  'rc-execs-another-shell', 'rc-execs-guarded', // a .zshrc that execs another shell: "ready", yet nothing ran
];

const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-mac-states-test-'));
test.after(() => fs.rmSync(parent, { recursive: true, force: true }));

for (const name of QUICK) {
  const scenario = SCENARIOS.find((item) => item.name === name);
  test(`pretend Mac ${name}: ${scenario.about}`, { skip: process.platform !== 'darwin' && 'macOS only', timeout: 120_000 }, async () => {
    const result = await runScenario(scenario, parent);
    assert.deepEqual(result.problems, [], result.steps.join('\n'));
  });
}
