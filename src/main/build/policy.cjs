'use strict';

// What a Build agent may reach beyond its worktree (2026-09-25, design B9). This is the one place Hudson's "Engelbart
// sandbox" note plugs in. It began as the bare minimum a Build needs; on 2026-10-07 ("Bart build agents") it became:
//   · read and write: outside the worktree too. The project's Engelbart folder (notes, workspaces) and the saved files
//     (<data root>/assets) are added to the folders it works in; elsewhere each CLI's own auto mode decides (Claude
//     Code's classifier; Codex's sandbox, whose writable roots gain the project folder, and its auto-review)
//   · never: lose a paper. The edit tools are refused on the folders where Engelbart keeps saved copies (assets) and on
//     every pdf and picture the library holds, wherever it is; after each turn anything of the library's that is gone,
//     and a paper that changed, is put back (./keep.cjs). Code files are the agent's to delete. Engelbart's own records
//     (builds/, its databases, project.json, meta.json, .context/) are refused to the edit tools too
//   · into Engelbart: save_file, duplicate_file and move_file_into_engelbart, Engelbart's own MCP server
//     (./engelbart-tools.cjs). A file written into an Engelbart folder by hand is not in the library
//   · the person's own: settings, hooks, permission rules and managed policies, MCP servers, personal CLAUDE.md /
//     AGENTS.md (Claude Code's user, project and local settings; Codex's own CODEX_HOME)
//   · subagents: Claude Code's Agent tool; Codex's multi_agent
//   · git: Engelbart's alone (./git-guard.cjs), in the repository the Build works in
//   · computer use and browser control: none (Claude Code: no Chrome, the computer-use server refused; Codex: its
//     computer_use and browser_use features off, a computer-use server of the person's turned off)
//   · network: what each CLI allows by default (web search yes; Codex's sandboxed shell no)

const path = require('node:path');

// The person's MCP servers that would hand the agent the screen (Claude Code's built-in one; a Codex one of that name).
const COMPUTER_USE = Object.freeze(['computer-use']);
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
const MAX_PAPER_RULES = 2000;

/**
 * The policy for one turn. `papers`: the pdfs and pictures the library holds outside `kept` (./keep.cjs); `gitDir`: the
 * git folder of the Build's repository (./git-guard.cjs gitCommonDir).
 * → { folders, writable, kept, records, papers, gitDir, personal, subagents, computerUse }
 */
function buildPolicy({ project, dataRoot, papers = [], gitDir = null }) {
  const dir = project && project.dir;
  const assets = dataRoot ? path.join(dataRoot, 'assets') : null;
  const unique = (list) => [...new Set(list.filter(Boolean))];
  return {
    folders: unique([dir, assets]), // worked in besides the worktree (Claude Code --add-dir)
    writable: unique([dir]), // Codex's sandbox writes there without asking
    kept: unique([assets, dir && path.join(dir, 'assets')]), // saved copies: papers, pages, pictures
    records: unique([
      ...(dir ? ['builds', 'notes.pglite', '.context', '.legacy', 'project.json', '**/meta.json'].map((name) => path.join(dir, name)) : []),
      ...(dataRoot ? ['library.pglite', 'config.json', 'state.json', 'github.json', 'zotero.json'].map((name) => path.join(dataRoot, name)) : []),
    ]),
    papers: unique(papers).slice(0, MAX_PAPER_RULES),
    gitDir,
    personal: true,
    subagents: true,
    computerUse: false,
  };
}

/**
 * Claude Code's --settings for a policy, on top of the person's own: Engelbart's tools allowed; the edit tools refused
 * on saved copies, papers and Engelbart's records; the computer-use server refused.
 */
function claudeSettings(policy) {
  const deny = [];
  const rule = (target) => `/${target}`; // an absolute path is written //… (a single / is the settings file's folder)
  for (const dir of policy.kept) for (const tool of EDIT_TOOLS) deny.push(`${tool}(${rule(dir)}/**)`);
  for (const record of policy.records) {
    const folder = !/\.json$/.test(record);
    for (const tool of EDIT_TOOLS) deny.push(`${tool}(${rule(record)}${folder ? '/**' : ''})`);
  }
  for (const file of policy.papers) for (const tool of EDIT_TOOLS) deny.push(`${tool}(${rule(file)})`);
  if (!policy.computerUse) for (const server of COMPUTER_USE) deny.push(`mcp__${server}`);
  return { permissions: { allow: ['mcp__engelbart'], deny } };
}

module.exports = { buildPolicy, claudeSettings, COMPUTER_USE };
