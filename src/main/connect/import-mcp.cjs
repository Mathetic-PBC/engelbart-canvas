'use strict';

// The import agents' tools (./tools.cjs), served to Claude Code and Codex as the MCP server `engelbart` by the stdio
// adapter Build's tools use (../sandbox/local-mcp.cjs). It holds no credentials; its loopback capability reaches only the
// one import that started it.
const { main } = require('../sandbox/local-mcp.cjs');
const { IMPORT_TOOLS } = require('./tools.cjs');

if (require.main === module) main(IMPORT_TOOLS, 'engelbart').catch(() => { process.stderr.write('Engelbart\'s import tools failed to start.\n'); process.exitCode = 1; });
