'use strict';

// The import agents' tools (./tools.cjs), served to Claude Code and Codex as the MCP server `engelbart` by the stdio
// adapter Build's tools use (../sandbox/local-mcp.cjs). It holds no credentials; its loopback capability reaches only the
// one import that started it. The connection file also names the agent's kind (survey, recall, import), and only that
// kind's tools are listed (tools.cjs TOOLS_FOR): a survey is never offered a tool that brings something in.
const fs = require('node:fs');
const { main } = require('../sandbox/local-mcp.cjs');
const { IMPORT_TOOLS, toolsFor } = require('./tools.cjs');

function definitions() {
  try { const { kind } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); return kind ? toolsFor(kind) : IMPORT_TOOLS; } catch { return IMPORT_TOOLS; }
}

if (require.main === module) main(definitions(), 'engelbart').catch(() => { process.stderr.write('Engelbart\'s import tools failed to start.\n'); process.exitCode = 1; });
