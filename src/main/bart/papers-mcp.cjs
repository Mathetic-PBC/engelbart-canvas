'use strict';

// @discover's paper tools as an MCP server over stdio (2026-09-30; ./papers.cjs), started by Claude Code (--mcp-config)
// or Codex (its private home's config.toml) with Engelbart's own executable as Node (ELECTRON_RUN_AS_NODE), as the
// sandbox adapter is (../sandbox/local-mcp.cjs). It holds no credentials and reads nothing on disk.
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { PAPER_TOOLS, createPapers, callTool } = require('./papers.cjs');

async function main() {
  const papers = createPapers();
  const server = new Server({ name: 'engelbart-papers', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PAPER_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => callTool(papers, params.name, params.arguments));
  await server.connect(new StdioServerTransport());
}
if (require.main === module) main().catch(() => { process.stderr.write('Engelbart paper tools failed to start.\n'); process.exitCode = 1; });

module.exports = { main };
