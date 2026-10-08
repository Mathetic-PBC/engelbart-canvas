'use strict';

// The run step's tools for Claude Code (./run-step.cjs, ./run-tools.cjs): the sandbox setup's stdio adapter
// (../sandbox/local-mcp.cjs) serving these tools instead. It holds no credentials; its loopback capability reaches only
// the one run step that started it.
const { main } = require('../sandbox/local-mcp.cjs');
const { RUN_TOOLS } = require('./run-tools.cjs');

if (require.main === module) main(RUN_TOOLS, 'engelbart-run-step').catch(() => { process.stderr.write('Engelbart run step tools failed to start.\n'); process.exitCode = 1; });
