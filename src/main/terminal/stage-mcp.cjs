'use strict';

// The `engelbart-stage` MCP server a Claude Code or Codex session in Engelbart's terminal starts (MATH-79): open_on_stage
// (./stage-tools.cjs), proxied to the session's bridge in Engelbart (./stage-bridges.cjs). Run with Engelbart's own
// executable as Node (ELECTRON_RUN_AS_NODE=1) and the bridge's connection file as its argument.

const { main } = require('../sandbox/local-mcp.cjs');
const { STAGE_TOOLS } = require('./stage-tools.cjs');

const UNAVAILABLE = 'Engelbart could not be reached: it may have quit, or this terminal session has ended. Nothing was opened.';

if (require.main === module) {
  main(STAGE_TOOLS, 'engelbart-stage', { unavailable: UNAVAILABLE }).catch(() => { process.stderr.write('Engelbart\'s Stage tool failed to start.\n'); process.exitCode = 1; });
}

module.exports = { UNAVAILABLE };
