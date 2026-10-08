'use strict';

// Read-only discovery in one fresh, owned VM; never touches user previews/templates.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Sandbox } = require('e2b');
const { readSandboxEnv } = require('../../src/main/sandbox/config.cjs');
const { quote } = require('../sandbox-cache/common.cjs');
const profile = require('../sandbox-cache/profile.json');

async function main() {
  const directory = path.resolve(process.argv[2]);
  fs.mkdirSync(directory, { recursive: false });
  const env = { ...process.env, ...readSandboxEnv(path.join(os.homedir(), '.engelbart')) };
  const sandbox = await Sandbox.create('engelbart-canvas-cached', { apiKey: env.E2B_API_KEY,
    timeoutMs: 5 * 60_000, metadata: { app: 'canvas-railpack-diagnostic' } });
  const record = { sandbox_id: sandbox.sandboxId, created_at: new Date().toISOString(), trials: [] };
  const save = () => fs.writeFileSync(path.join(directory, 'probe.json'), JSON.stringify(record, null, 2));
  save();
  try {
    record.version = (await sandbox.commands.run('railpack --version', { timeoutMs: 10_000 })).stdout.trim();
    for (const repo of profile.repositories) {
      const root = `/home/user/${repo.name.replace('/', '--')}`;
      await sandbox.commands.run(`git clone --quiet --depth 1 ${quote(`https://github.com/${repo.name}.git`)} ${quote(root)} && test "$(git -C ${quote(root)} rev-parse HEAD)" = ${quote(repo.commit)}`, { timeoutMs: 60_000 });
      // Include the workspace root and independent install roots; no repository code executed.
      const dirs = [...new Set(['.', ...repo.installs.map(step => step.cwd)])];
      for (const cwd of dirs) {
        const name = `${repo.name.replace('/', '--')}-${cwd.replaceAll('/', '--')}`;
        const remote = `/tmp/${name}`;
        const start = performance.now();
        let result;
        try { result = await sandbox.commands.run(`railpack prepare ${quote(`${root}/${cwd}`)} --plan-out ${quote(remote + '-plan.json')} --info-out ${quote(remote + '-info.json')}`, { timeoutMs: 30_000 }); }
        catch (error) { result = { exitCode: error.exitCode ?? null, stdout: error.stdout || '', stderr: error.stderr || '', error: error.message }; }
        const entry = { repo: repo.name, cwd, elapsed_ms: performance.now() - start, ...result };
        for (const type of ['plan', 'info']) {
          try {
            const content = await sandbox.files.read(`${remote}-${type}.json`);
            fs.writeFileSync(path.join(directory, `${name}-${type}.json`), content);
            const json = JSON.parse(content);
            entry[`${type}_bytes`] = Buffer.byteLength(content);
            entry[`${type}_keys`] = Object.keys(json);
          } catch { /* Failed discovery may not create a plan. */ }
        }
        record.trials.push(entry); save();
        console.log(JSON.stringify({ repo: repo.name, cwd, ms: entry.elapsed_ms, exit: entry.exitCode, info_bytes: entry.info_bytes, plan_bytes: entry.plan_bytes }));
      }
    }
  } finally { await sandbox.kill(); record.cleaned_up = true; save(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
