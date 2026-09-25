'use strict';

// Executed inside a NEW benchmark sandbox, never an existing user run. Match the
// actual install commands, including normal lifecycle scripts. Only installation
// is timed; clone/setup, agent planning, and application startup are excluded.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hash, validateProfile } = require('./common.cjs');
const ROOT = '/home/user/repository';

function pythonFingerprint(packages) {
  // Distribution metadata may spell the same name with '-' or '_' depending
  // on the wheel builder. Normalize names, but never versions or direct URLs.
  const normalized = packages.map((line) => line.replace(/^([A-Za-z0-9_.-]+)(==)/,
    (_, name, separator) => name.toLowerCase().replace(/[-_.]+/g, '-') + separator)).sort();
  return { hash: hash(normalized), packages: normalized.length };
}

function execute(command, args, cwd, fullOutput = false) {
  const started = performance.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  const record = { command: [command, ...args], duration_ms: Math.round(performance.now() - started), exit_code: result.status,
    output_tail: `${result.stdout || ''}${result.stderr || ''}`.slice(-2500) };
  if (result.error) record.error = result.error.message;
  if (fullOutput) record.stdout = result.stdout || '';
  return record;
}

function measure(repo) {
  validateProfile({ version: 1, repositories: [repo] });
  const steps = [], fingerprints = {}, pythonPackages = {};
  for (const step of repo.installs) {
    const cwd = path.join(ROOT, step.cwd);
    const operations = step.manager === 'npm' ? [['npm', ['install']]]
      : [['python3', ['-m', 'venv', '.venv']], [path.join(cwd, '.venv/bin/python'), ['-m', 'pip', 'install', '-r', 'requirements.txt']]];
    const results = operations.map(([command, args]) => {
      if (steps.some((entry) => entry.exit_code !== 0)) return null;
      const result = { ...execute(command, args, cwd), manager: step.manager, cwd: step.cwd };
      steps.push(result);
      return result;
    });
    if (results.some((result) => !result || result.exit_code !== 0)) break;
    if (step.manager === 'npm') {
      const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'node_modules/.package-lock.json'), 'utf8'));
      const packages = Object.entries(lock.packages || {}).map(([location, pkg]) => [location, pkg.version, pkg.integrity || '', pkg.link || false]).sort(([a], [b]) => a.localeCompare(b));
      fingerprints[`${step.manager}:${step.cwd}`] = { hash: hash(packages), packages: packages.length };
    } else {
      const freeze = execute(path.join(cwd, '.venv/bin/python'), ['-m', 'pip', 'freeze', '--all'], cwd, true);
      if (freeze.exit_code !== 0) throw new Error('Could not verify the Python installation');
      const packages = freeze.stdout.trim().split('\n').sort();
      pythonPackages[step.cwd] = packages;
      fingerprints[`${step.manager}:${step.cwd}`] = pythonFingerprint(packages);
    }
  }
  const seedFile = '/home/user/.cache/engelbart/seed.json';
  const seed = fs.existsSync(seedFile) ? JSON.parse(fs.readFileSync(seedFile, 'utf8')) : null;
  return { steps, total_ms: steps.reduce((sum, step) => sum + step.duration_ms, 0), fingerprints, python_packages: pythonPackages,
    success: steps.every((step) => step.exit_code === 0), runtime: { node: process.version,
      npm: execute('npm', ['--version'], ROOT).output_tail.trim(), python: execute('python3', ['--version'], ROOT).output_tail.trim() },
    cache: { seed_profile: seed?.profile || null,
      npm_path: execute('npm', ['config', 'get', 'cache'], ROOT).output_tail.trim(),
      npm_prefer_offline: execute('npm', ['config', 'get', 'prefer-offline'], ROOT).output_tail.trim(),
      pip_path: execute('python3', ['-m', 'pip', 'cache', 'dir'], ROOT).output_tail.trim() } };
}

if (require.main === module) {
  try {
    const repo = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    const result = measure(repo);
    fs.writeFileSync('/home/user/cache-benchmark/result.json', JSON.stringify(result));
    console.log(JSON.stringify({ repository: repo.name, success: result.success, total_ms: result.total_ms }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { measure, pythonFingerprint };
