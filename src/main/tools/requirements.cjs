'use strict';

// What Engelbart needs of each program it runs (2026-09-23; design: docs/superpowers/specs/2026-09-23-tools-and-defaults-design.md D7).
// Versions compare as x.y.z. `minimum` is the oldest version every command Engelbart gives it was
// checked on; `incompatible` lists ranges known not to work ({ from, to, why }, `to` excluded), none yet;
// `testedMajor` is the newest major version Engelbart ran against: a newer one is allowed and shown as
// untested. `version` finds the number in what `--version` prints, before any looser match is tried.

const REQUIREMENTS = Object.freeze({
  git: Object.freeze({
    name: 'Git',
    minimum: '2.30.0',
    testedMajor: 2,
    incompatible: Object.freeze([]),
    version: /git version (\d+\.\d+(?:\.\d+)?)/,
    why: 'Build uses `git worktree repair` (2.29) and reads locked worktrees from `git worktree list` (2.30).',
  }),
  claude: Object.freeze({
    name: 'Claude Code',
    minimum: '2.1.278',
    testedMajor: 2,
    incompatible: Object.freeze([]),
    version: /(\d+\.\d+\.\d+)\s*\(Claude Code\)/,
    why: '@bart and the summaries pass --restricted, --effort max, --include-partial-messages and the fable alias, all checked on 2.1.278.',
  }),
  codex: Object.freeze({
    name: 'Codex',
    minimum: '0.155.0',
    testedMajor: 0,
    incompatible: Object.freeze([]),
    version: /codex-cli\s+(\d+\.\d+\.\d+)/,
    why: '@bart and the summaries use exec resume, -o, --ephemeral and the ultra effort, all checked on 0.155.0.',
  }),
});

const TOOL_NAMES = Object.freeze(['git', 'claude', 'codex']);
const AGENTS = Object.freeze(['claude', 'codex']);
// @bart's providers are named for the company, the tools for the program.
const PROVIDER_OF = Object.freeze({ claude: 'anthropic', codex: 'openai' });
const TOOL_OF = Object.freeze({ anthropic: 'claude', openai: 'codex' });

const requiresText = (name) => `>=${REQUIREMENTS[name].minimum}`;

module.exports = { REQUIREMENTS, TOOL_NAMES, AGENTS, PROVIDER_OF, TOOL_OF, requiresText };
