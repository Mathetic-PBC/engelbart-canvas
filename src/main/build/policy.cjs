'use strict';

// What a Build agent may reach beyond its worktree (2026-09-25; design B9). This is the one place Hudson's "Engelbart
// sandbox" (a note, empty when this was written) plugs in: network, other folders, MCP servers, computer use. Until it
// exists the answer is the bare minimum a Build needs and nothing else:
//   · write: the worktree only (Claude Code --restricted; Codex's workspace-write sandbox)
//   · read: the worktree, and the project's Engelbart folders (notes, pasted images, saved pdfs), read-only
//   · shell: the CLI's own, approved by its auto mode (Claude Code's classifier, Codex's auto-review). It is not
//     confined to the worktree: that is the sandbox's job
//   · MCP servers: none (--strict-mcp-config with no config; a private CODEX_HOME with none)
//   · computer use, browser control, the person's hooks, settings, plugins and personal CLAUDE.md: none
//   · network: what each CLI allows by default (web search yes; Codex's sandboxed shell no)

const path = require('node:path');

/** The policy for one Build. → { readOnly: [dirs], mcpServers: [], computerUse: false } */
function buildPolicy({ project, dataRoot }) {
  const readOnly = [project && project.dir, dataRoot && path.join(dataRoot, 'assets')].filter(Boolean);
  return { readOnly: [...new Set(readOnly)], mcpServers: [], computerUse: false };
}

/** Claude Code's --settings for a policy: the read-only folders cannot be edited or written (they are --add-dir'ed to be read). */
function claudeSettings(policy) {
  const deny = [];
  for (const dir of policy.readOnly) for (const tool of ['Edit', 'Write', 'NotebookEdit']) deny.push(`${tool}(/${dir}/**)`);
  return { permissions: { deny } };
}

module.exports = { buildPolicy, claudeSettings };
