'use strict';

// Disposable E2B verification. Uses sandbox time, but no clone, install, or model
// calls. Exercises the real manager, IPC worker, hc launcher and public preview.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Sandbox } = require('e2b');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { createSandboxManager } = require('../src/main/sandbox/manager.cjs');
const { runStore } = require('../src/main/sandbox/runs.cjs');
const db = require('../src/main/store/db.cjs');

async function main() {
  // --local: a Claude Code launch plan; otherwise the older hc ones a restart still replays. Neither needs a model or key.
  const localOnly = process.argv.includes('--local');
  const env = readSandboxEnv(path.join(os.homedir(), '.engelbart'));
  Object.assign(process.env, env);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-env-smoke-'));
  const ctx = { root, dataRoot: root, libraryDb: await db.openLibraryDb(root) };
  const id = randomUUID();
  await ctx.libraryDb.insert({ id, name: 'Environment test', type: 'website', tags: ['git'], url: 'https://github.com/owner/environment-test' });
  const runs = runStore(ctx.libraryDb);
  let sandbox;
  // The manager takes its E2B key only as `e2bKey` (in the app, the GitHub sign-in's); this script's comes from sandbox.env.
  const manager = createSandboxManager({ readEnv: () => env, e2bKey: async () => env.E2B_API_KEY || null,
    // Isolated test store, not the user's credentials or database.
    secure: { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    notify(event) { if (['ready', 'failed'].includes(event.run.status)) console.log('Run status:', event.run.status); },
  });
  try {
    const run = await runs.create(id);
    sandbox = await Sandbox.create(env.E2B_TEMPLATE || 'engelbart-runner', { timeoutMs: 10 * 60_000, metadata: { app: 'engelbart-canvas', canvasRunId: run.id } });
    console.log('Disposable sandbox:', sandbox.sandboxId);
    await sandbox.commands.run('mkdir -p /home/user/repository/.engelbart /home/user/.engelbart-canvas');
    await sandbox.files.write('/home/user/repository/app.py', `import json, os\nfrom http.server import BaseHTTPRequestHandler, HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  body=json.dumps({"value":os.environ.get("CANVAS_TEST_VALUE"),"removedPresent":"CANVAS_TEST_REMOVE" in os.environ,"empty":os.environ.get("CANVAS_TEST_EMPTY"),"platformKeyPresent":"ANTHROPIC_API_KEY" in os.environ}).encode()\n  self.send_response(200);self.send_header("Content-Type","application/json");self.end_headers();self.wfile.write(body)\nHTTPServer.allow_reuse_address=True\nserver=HTTPServer(("0.0.0.0",3000),Handler)\nprint("Serving at http://localhost:3000",flush=True)\nserver.serve_forever()\n`);
    await sandbox.files.write('/home/user/repository/.engelbart/start.sh', 'exec python3 /home/user/repository/app.py\n');
    await sandbox.files.write('/home/user/repository/installed-sentinel', 'keep-me');
    if (localOnly) await sandbox.files.write('/home/user/.engelbart-canvas/recipe.json', JSON.stringify({
      kind: 'claude-local', command: 'python3 app.py', cwd: '/home/user/repository', port: 3000, path: '/',
    }));
    await runs.update(run.id, { sandbox_id: sandbox.sandboxId, status: 'ready', port: 3000, preview_url: `https://${sandbox.getHost(43110)}/` });
    let saved = await manager.saveEnvironment(ctx, id, [{ name: 'CANVAS_TEST_VALUE', value: 'first' }, { name: 'CANVAS_TEST_REMOVE', value: 'remove-me' }, { name: 'CANVAS_TEST_EMPTY', value: '' }], null);
    const deadline = Date.now() + 4 * 60_000;
    async function restart(expected) {
      await manager.restart(ctx, id);
      let current;
      do {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        current = await runs.get(run.id);
        if (current.status === 'failed') throw new Error(current.error);
        if (Date.now() > deadline) throw new Error('Environment smoke deadline exceeded');
      } while (current.status !== 'ready');
      assert.equal(current.sandbox_id, sandbox.sandboxId);
      assert.deepEqual(await (await fetch(current.preview_url, { signal: AbortSignal.timeout(10_000) })).json(), expected);
      assert.equal(await sandbox.files.read('/home/user/repository/installed-sentinel'), 'keep-me');
    }
    await restart({ value: 'first', removedPresent: true, empty: '', platformKeyPresent: false });
    saved = await manager.saveEnvironment(ctx, id, [{ name: 'CANVAS_TEST_VALUE', value: 'updated "$value"\nline' }, { name: 'CANVAS_TEST_REMOVE', value: null }], saved.revision);
    await restart({ value: 'updated "$value"\nline', removedPresent: false, empty: '', platformKeyPresent: false });
    if (localOnly) {
      console.log('PASS: local Claude recipe restarts apply add/update/remove/empty values, keep installed files, and require no model/API key.');
      return;
    }
    console.log('PASS: fallback launcher updated and removed variables in the same sandbox.');
    await sandbox.files.write('/home/user/.engelbart-canvas/recipe.json', JSON.stringify({ version: 1, kind: 'railpack', cwd: '.', plan: { steps: [], deploy: { startCommand: 'python3 app.py' } } }));
    await restart({ value: 'updated "$value"\nline', removedPresent: false, empty: '', platformKeyPresent: false });
    saved = await manager.saveEnvironment(ctx, id, [{ name: 'CANVAS_TEST_VALUE', value: 'native-second-launch' }], saved.revision);
    await restart({ value: 'native-second-launch', removedPresent: false, empty: '', platformKeyPresent: false });
    console.log('PASS: repeated Railpack restarts retire the prior run and retain installed files.');
    await sandbox.files.write('/home/user/.engelbart-canvas/recipe.json', JSON.stringify({ version: 1, kind: 'native', cwd: '.', orderPlan: {
      status: 'plan', summary: 'Restart the existing application', preparation: [],
      services: [{ id: 'app', cwd: '.', argv: ['python3', 'app.py'], dependsOn: [], healthUrl: 'http://127.0.0.1:3000' }], entryService: 'app',
    } }));
    await restart({ value: 'native-second-launch', removedPresent: false, empty: '', platformKeyPresent: false });
    saved = await manager.saveEnvironment(ctx, id, [{ name: 'CANVAS_TEST_VALUE', value: 'run-order-second-launch' }, { name: 'CANVAS_TEST_REMOVE', value: 'newly-added' }], saved.revision);
    await restart({ value: 'run-order-second-launch', removedPresent: true, empty: '', platformKeyPresent: false });
    console.log('PASS: repeated native run-order restarts apply newly added variables in the same sandbox.');
  } finally {
    await manager.dispose();
    if (sandbox) { await sandbox.kill(); console.log('Disposed test sandbox.'); }
    await ctx.libraryDb.close();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
