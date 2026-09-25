'use strict';

// Runs only while building the derived template. No app source, credentials, or
// installed application node_modules/venv is retained in the resulting image.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CACHE_ENV, hash, validateProfile, seedCommand } = require('./common.cjs');

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Seed download failed: HTTP ${response.status} ${url}`);
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 5 * 1024 * 1024) throw new Error('Seed manifest exceeds 5 MiB');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(chunks);
}

async function seed(profile) {
  validateProfile(profile);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-cache-seed-'));
  const started = Date.now();
  const manifests = [];
  try {
    for (const repo of profile.repositories) {
      const root = path.join(scratch, repo.name.replace('/', '--'));
      for (const file of repo.files) {
        const content = await download(`https://raw.githubusercontent.com/${repo.name}/${repo.commit}/${file}`);
        const target = path.join(root, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        manifests.push({ repo: repo.name, file, sha256: hash(content.toString('utf8')) });
      }
      for (const step of repo.installs) {
        console.log(`CACHE SEED ${repo.name} ${step.manager} ${step.cwd}`);
        const [command, args] = seedCommand(step, path.join(scratch, 'wheels'));
        const result = spawnSync(command, args, { cwd: path.join(root, step.cwd), env: { ...process.env, ...CACHE_ENV }, stdio: 'inherit', timeout: 10 * 60_000 });
        if (result.error || result.status !== 0) throw new Error(`Cache seed failed for ${repo.name}: ${result.error?.message || result.status}`);
      }
    }
    const report = { version: 1, profile: hash(profile), seeded_at: new Date().toISOString(), duration_ms: Date.now() - started,
      node: process.version, repositories: profile.repositories.map(({ name, commit }) => ({ name, commit })), manifests };
    fs.mkdirSync('/home/user/.cache/engelbart', { recursive: true });
    fs.writeFileSync('/home/user/.cache/engelbart/seed.json', JSON.stringify(report, null, 2));
    console.log(`CACHE READY ${report.profile}`);
  } finally {
    // Exactly this process's generated scratch directory, never a repository or home.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) seed(require('./profile.json')).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { download, seed };
