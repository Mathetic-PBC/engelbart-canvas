'use strict';

// Diagnostic only: copied into a NEW disposable E2B sandbox. No Canvas runtime
// imports, credentials, cache deletion, template writes, or package substitutions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = '/home/user/repository';
const OUT = '/home/user/install-diagnostics';
const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const save = (file, value) => fs.writeFileSync(path.join(OUT, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function npmEnvironment(preferOffline) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && key !== 'NODE_ENV'));
  return { ...env, npm_config_userconfig: `${OUT}/user.npmrc`, npm_config_globalconfig: `${OUT}/global.npmrc`,
    npm_config_cache: '/home/user/.npm', npm_config_logs_dir: `${OUT}/npm-logs`,
    npm_config_ignore_scripts: 'false', npm_config_include: 'dev', npm_config_audit: 'true',
    npm_config_prefer_offline: String(preferOffline), npm_config_timing: 'true' };
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.error?.message || result.stderr?.slice(-2000)}`);
  return result.stdout;
}

function manifestHashes(repo) {
  return Object.fromEntries(repo.files.map((file) => [file, hash(fs.readFileSync(path.join(ROOT, file), 'utf8'))]));
}

function packageFingerprint(cwd) {
  const file = path.join(cwd, 'node_modules/.package-lock.json');
  if (!fs.existsSync(file)) return null;
  const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  const packages = Object.entries(lock.packages || {}).map(([location, pkg]) => {
    const manifest = path.join(cwd, location, 'package.json');
    let actual;
    try { actual = JSON.parse(fs.readFileSync(manifest, 'utf8')).version || null; } catch { actual = null; }
    return { location, version: pkg.version || null, actual_version: actual, integrity: pkg.integrity || '', link: !!pkg.link };
  }).sort((a, b) => a.location.localeCompare(b.location));
  save('packages.json', packages);
  return { hash: hash(packages), packages: packages.length,
    version_mismatches: packages.filter((p) => !p.link && p.actual_version !== p.version).length };
}

function analyze(timers, debug) {
  const named = Object.fromEntries(Object.entries(timers).filter(([key]) =>
    /^(npm|command:|idealTree$|idealTree:buildDeps$|reify$|reify:(loadTrees|diffTrees|unpack|build|audit|save)|auditReport|build$|build:deps|build:run:)/.test(key)));
  const fetches = debug.split('\n').filter((line) => /\bhttp (fetch|cache)\b/.test(line));
  const requests = fetches.map((line) => ({ line, duration_ms: Number(/\s(\d+)ms\b/.exec(line)?.[1] || 0) }));
  const top = (prefix) => Object.entries(timers).filter(([key]) => key.startsWith(prefix)).sort((a, b) => b[1] - a[1]).slice(0, 15);
  return { timers_ms: named, longest_package_timers: top('reifyNode:'), longest_script_timers: top('build:run:'),
    http: { lines: fetches.length, cache_hits: fetches.filter((s) => /cache hit/.test(s)).length,
      cache_misses: fetches.filter((s) => /cache miss/.test(s)).length,
      cache_revalidated: fetches.filter((s) => /cache revalidated/.test(s)).length,
      aggregate_request_ms_NOT_wall_time: requests.reduce((sum, entry) => sum + entry.duration_ms, 0),
      slowest: requests.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 12) },
    warning: 'Timers are nested/overlapping, not additive. reify:unpack includes retrieval, extraction and filesystem work; npm does not isolate disk-write wall time.' };
}

async function verifyApp(repo, cwd, env) {
  const port = repo.name === 'mqo00/rope' ? 3333 : 5173;
  const command = ['npm', 'run', 'dev'];
  const stdout = fs.openSync(path.join(OUT, 'app.stdout.log'), 'w');
  const stderr = fs.openSync(path.join(OUT, 'app.stderr.log'), 'w');
  const started = performance.now();
  const child = spawn(command[0], command.slice(1), { cwd, env: { ...env, NEXT_TELEMETRY_DISABLED: '1', BROWSER: 'none' },
    detached: true, stdio: ['ignore', stdout, stderr] });
  let spawnError;
  child.once('error', (error) => { spawnError = error.message; });
  try {
    const attempts = [];
    while (performance.now() - started < 120_000 && child.exitCode === null && !spawnError) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(20_000) });
        const text = await response.text();
        attempts.push({ status: response.status, elapsed_ms: Math.round(performance.now() - started) });
        if (response.ok && /<html|<!doctype/i.test(text)) {
          save('app.html', text.slice(0, 128_000));
          return { ok: true, command, port, elapsed_ms: Math.round(performance.now() - started), attempts,
            scope: 'Development server and root HTML only. No keys supplied; AI/database features not exercised.' };
        }
      } catch (error) { attempts.push({ error: error.name, elapsed_ms: Math.round(performance.now() - started) }); }
      await pause(1000);
    }
    return { ok: false, command, port, attempts, exit_code: child.exitCode, error: spawnError || 'No successful root HTML response within 120 seconds' };
  } finally {
    // A dedicated process group created above, never an existing application.
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      await pause(500);
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.closeSync(stdout); fs.closeSync(stderr);
  }
}

async function measure(spec) {
  const { repo, args, preferOffline, verify } = spec;
  if (!['install', 'ci'].includes(args[0]) || args.slice(1).some((arg) => !['--prefer-offline', '--no-audit', '--timing'].includes(arg))) throw new Error('Unexpected diagnostic npm arguments');
  const cwd = path.resolve(ROOT, repo.installs[0].cwd);
  if (cwd !== ROOT && !cwd.startsWith(`${ROOT}/`)) throw new Error('Invalid install root');
  fs.mkdirSync(`${OUT}/npm-logs`, { recursive: true });
  fs.mkdirSync(`${OUT}/config-logs`, { recursive: true });
  save('user.npmrc', ''); save('global.npmrc', '');
  const env = npmEnvironment(preferOffline);
  const config = JSON.parse(execute('npm', ['config', 'list', '--json', ...args.slice(1)], {
    cwd, env: { ...env, npm_config_logs_dir: `${OUT}/config-logs` },
  }));
  config['logs-dir'] = `${OUT}/npm-logs`;
  for (const key of Object.keys(config)) if (/auth|token|password|cert|keyfile/i.test(key)) delete config[key];
  if (config['ignore-scripts'] !== false || !config.include.includes('dev') || config.omit.includes('dev')) throw new Error('Scripts/devDependencies are not enabled');
  save('npm-config.json', config);
  const before = manifestHashes(repo);
  save('package.before.json', fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  const runtime = { node: process.version, npm: execute('npm', ['--version'], { cwd: '/tmp' }).trim(),
    python: execute('python3', ['--version']).trim(), arch: process.arch, platform: process.platform };
  const cacheBefore = execute('du', ['-sk', '/home/user/.npm']).trim();
  const seed = '/home/user/.cache/engelbart/seed.json';
  const cache = { size_before_kib: Number(cacheBefore.split(/\s+/)[0]),
    seed: fs.existsSync(seed) ? JSON.parse(fs.readFileSync(seed, 'utf8')) : null };
  const out = fs.openSync(path.join(OUT, 'install.stdout.log'), 'w');
  const err = fs.openSync(path.join(OUT, 'install.stderr.log'), 'w');
  const haveTime = fs.existsSync('/usr/bin/time');
  const started = performance.now();
  const result = spawnSync(haveTime ? '/usr/bin/time' : 'npm', haveTime ? ['-v', '-o', `${OUT}/resources.txt`, 'npm', ...args] : args,
    { cwd, env, stdio: ['ignore', out, err], timeout: 10 * 60_000 });
  const wall = Math.round(performance.now() - started);
  fs.closeSync(out); fs.closeSync(err);
  const timings = fs.readdirSync(`${OUT}/npm-logs`).filter((f) => f.endsWith('-timing.json'));
  const debugFiles = fs.readdirSync(`${OUT}/npm-logs`).filter((f) => f.endsWith('-debug-0.log'));
  const timing = timings.map((f) => JSON.parse(fs.readFileSync(`${OUT}/npm-logs/${f}`, 'utf8')));
  const primary = timing.find((t) => t.timers?.[`command:${args[0]}`] !== undefined) || timing[0];
  const debug = debugFiles.map((f) => fs.readFileSync(`${OUT}/npm-logs/${f}`, 'utf8')).join('\n');
  const measured = { command: ['npm', ...args], cwd: repo.installs[0].cwd, wall_ms: wall,
    exit_code: result.status, signal: result.signal, error: result.error?.message || null,
    runtime, config_hash: hash(config), cache, fingerprint: packageFingerprint(cwd),
    input_hashes: before, after_hashes: manifestHashes(repo), timing_files: timings,
    analysis: analyze(primary?.timers || {}, debug),
    script_events: debug.split('\n').filter((line) => /\binfo run\b/.test(line)),
    install_changes: execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT }),
    resources: haveTime ? fs.readFileSync(`${OUT}/resources.txt`, 'utf8') : null };
  save('measurement.json', measured); // retain install results even if launch checks fail
  if (verify && result.status === 0) measured.startup = await verifyApp(repo, cwd, env);
  measured.after_startup_changes = execute('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT });
  save('measurement.json', measured);
  return measured;
}

if (require.main === module) measure(JSON.parse(fs.readFileSync(`${OUT}/spec.json`, 'utf8')))
  .then((r) => console.log(JSON.stringify({ exit_code: r.exit_code, wall_ms: r.wall_ms, startup: r.startup })))
  .catch((error) => { save('diagnostic-error.txt', error.stack); console.error(error.message); process.exitCode = 1; });
module.exports = { npmEnvironment, packageFingerprint, analyze, measure };
