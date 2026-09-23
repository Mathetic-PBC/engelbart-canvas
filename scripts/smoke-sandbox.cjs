'use strict';

// Real E2B/agent smoke test. Uses an isolated local DB and always stops its sandbox.
// node scripts/smoke-sandbox.cjs https://github.com/owner/repository
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openLibraryDb } = require('../src/main/store/db.cjs');
const { createSandboxManager } = require('../src/main/sandbox/manager.cjs');
const { githubRepo } = require('../src/main/sandbox/runs.cjs');

async function main() {
  const repo = githubRepo(process.argv[2]);
  if (!repo) throw new Error('Usage: node scripts/smoke-sandbox.cjs https://github.com/owner/repository');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-e2b-smoke-'));
  const ctx = { root: path.join(os.homedir(), '.engelbart'), dataRoot: root, libraryDb: await openLibraryDb(root) };
  let resolve, reject, lastMessage = '';
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timeout = setTimeout(() => reject(new Error('Smoke test exceeded 8 minutes')), 8 * 60_000);
  const manager = createSandboxManager({ notify({ run, message }) {
    if (message !== lastMessage) { console.log(run.status, String(message).slice(0, 180)); lastMessage = message; }
    if (run.status === 'ready') resolve(run);
    else if (run.status === 'failed') reject(new Error(run.error));
  } });
  try {
    const row = await ctx.libraryDb.insert({ id: randomUUID(), name: `${repo.owner}/${repo.name}`, url: repo.url, type: 'website', tags: ['git'] });
    await manager.start(ctx, row.id);
    const run = await done;
    const saved = await ctx.libraryDb.query('select status, sandbox_id, preview_url, port from sandbox_runs where id = $1', [run.id]);
    console.log('Verified saved preview:', JSON.stringify(saved[0]));
  } finally {
    clearTimeout(timeout);
    await manager.dispose();
    await ctx.libraryDb.close();
    console.log('Sandbox cleanup complete. Test database:', root);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
