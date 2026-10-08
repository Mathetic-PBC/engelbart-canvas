'use strict';

// A trusted local stdio adapter. It has no E2B or Claude credentials. The random
// loopback capability reaches only the worker which owns this one sandbox. A Build's
// run step serves its own tools through the same adapter (../build/run-mcp.cjs).
const fs = require('node:fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { TOOL_DEFINITIONS } = require('./local-tools.cjs');

async function main(definitions = TOOL_DEFINITIONS, name = 'canvas-sandbox') {
  const { url, token } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.pathname !== '/tools' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid local tool connection');
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    // The worker validates arguments too; published JSON schemas are not enforcement.
    const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: params.name, args: params.arguments || {} }), signal: AbortSignal.timeout(230_000) });
    if (!response.ok) throw new Error('The sandbox tool connection is unavailable');
    return response.json();
  });
  await server.connect(new StdioServerTransport());
}
if (require.main === module) main().catch(() => { process.stderr.write('Canvas sandbox tools failed to start.\n'); process.exitCode = 1; });

module.exports = { main };
