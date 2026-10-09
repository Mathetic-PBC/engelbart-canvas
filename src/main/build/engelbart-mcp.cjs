'use strict';

// Engelbart's tools for a Build's agent (./engelbart-tools.cjs), served to Claude Code and Codex as the MCP server
// `engelbart`: the sandbox setup's stdio adapter (../sandbox/local-mcp.cjs) serving these tools instead. It holds no
// credentials; its loopback capability reaches only the one turn that started it.
const { main } = require('../sandbox/local-mcp.cjs');
const { ENGELBART_TOOLS } = require('./engelbart-tools.cjs');

if (require.main === module) main(ENGELBART_TOOLS, 'engelbart').catch(() => { process.stderr.write('Engelbart\'s tools failed to start.\n'); process.exitCode = 1; });
