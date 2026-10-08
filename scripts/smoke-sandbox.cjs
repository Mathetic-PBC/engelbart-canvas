'use strict';

// Real E2B/agent smoke test. Uses an isolated local DB and always stops its sandbox.
// node scripts/smoke-sandbox.cjs https://github.com/owner/repository [NEW_REPORT.json]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openLibraryDb } = require('../src/main/store/db.cjs');
const { createSandboxManager } = require('../src/main/sandbox/manager.cjs');
const { githubRepo } = require('../src/main/sandbox/runs.cjs');
const { readSandboxEnv } = require('../src/main/sandbox/config.cjs');
const { redactOutput } = require('../src/main/sandbox/environment.cjs');
const { Sandbox } = require('e2b');
const { verifyPublic } = require('./benchmark-sandbox-e2e.cjs');

async function main() {
  const repo = githubRepo(process.argv[2]);
  if (!repo) throw new Error('Usage: node scripts/smoke-sandbox.cjs https://github.com/owner/repository');
  const reportFile = process.argv[3] ? path.resolve(process.argv[3]) : null;
  if (reportFile && fs.existsSync(reportFile)) throw new Error('Report already exists; do not overwrite evidence.');
  const env = readSandboxEnv(path.join(os.homedir(), '.engelbart'));
  const report = { github_url: repo.url, started_at: new Date().toISOString(),
    configured_template: env.E2B_TEMPLATE || 'engelbart-runner',
    configured_docker_template: env.E2B_DOCKER_TEMPLATE || `${env.E2B_TEMPLATE || 'engelbart-runner'}-docker`,
    status: 'starting', cleaned_up: false };
  const save = () => { if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2)); };
  if (reportFile) { fs.mkdirSync(path.dirname(reportFile), { recursive: true }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' }); }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-e2b-smoke-'));
  const ctx = { root: path.join(os.homedir(), '.engelbart'), dataRoot: root, libraryDb: await openLibraryDb(root) };
  let resolve, reject, lastMessage = '';
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  done.catch(() => {});
  const timeout = setTimeout(() => reject(new Error('Smoke test exceeded 8 minutes')), 8 * 60_000);
  // The manager takes its E2B key only as `e2bKey` (in the app, the GitHub sign-in's); this script's comes from sandbox.env.
  const manager = createSandboxManager({ e2bKey: async () => env.E2B_API_KEY || null, notify({ run, message }) {
    if (run.sandbox_id && !report.sandbox_id) { report.sandbox_id = run.sandbox_id; save(); }
    if (message !== lastMessage) { console.log(run.status, String(message).slice(0, 180)); lastMessage = message; }
    if (run.status === 'ready') resolve(run);
    else if (run.status === 'failed') reject(new Error(run.error));
  } });
  try {
    const row = await ctx.libraryDb.insert({ id: randomUUID(), name: `${repo.owner}/${repo.name}`, url: repo.url, type: 'website', tags: ['git'] });
    const started = performance.now();
    await manager.start(ctx, row.id);
    const run = await done;
    report.request_to_ready_ms = Math.round(performance.now() - started);
    const saved = await ctx.libraryDb.query('select status, sandbox_id, preview_url, port from sandbox_runs where id = $1', [run.id]);
    const info = await Sandbox.getInfo(run.sandbox_id, { apiKey: env.E2B_API_KEY, requestTimeoutMs: 15_000 });
    report.template_id = info.templateId;
    report.resources = { cpu: info.cpuCount, memory_mb: info.memoryMB };
    report.saved_run = saved[0];
    report.public_check = await verifyPublic(run.preview_url);
    report.build_log = run.build_log;
    if (!report.public_check.ok) throw new Error('Saved preview did not serve HTTP 200 HTML');
    report.status = 'ready'; save();
    console.log('Verified saved preview:', JSON.stringify(saved[0]));
    console.log('Verified template and public page:', JSON.stringify({ template_id: report.template_id, configured: report.configured_template, public_check: report.public_check, request_to_ready_ms: report.request_to_ready_ms }));
  } catch (error) {
    report.status = 'failed'; report.error = redactOutput(error.message, [env.E2B_API_KEY].filter(Boolean));
    throw error;
  } finally {
    clearTimeout(timeout);
    try { await manager.dispose(); report.cleaned_up = true; }
    catch (error) { report.cleanup_error = redactOutput(error.message, [env.E2B_API_KEY].filter(Boolean)); throw error; }
    finally { await ctx.libraryDb.close(); report.finished_at = new Date().toISOString(); report.test_database = root; save(); }
    console.log('Sandbox cleanup complete. Test database:', root);
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
