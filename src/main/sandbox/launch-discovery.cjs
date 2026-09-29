'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./environment.cjs');
const REMOTE = '/home/user/.engelbart-canvas/launch-discovery.py';

async function discoverLaunch({ sandbox, signal, secrets = [], onEvent = () => {} }) {
  const started = performance.now();
  signal?.throwIfAborted();
  onEvent({ phase: 'plan', source: 'railpack', status: 'running', message: 'Discovering launch facts with Railpack' });
  let result;
  try {
    await sandbox.files.write(REMOTE, fs.readFileSync(path.join(__dirname, 'launch-discovery.py'), 'utf8'));
    const output = await sandbox.commands.run(`python3 ${REMOTE}`, { timeoutMs: 12_000, signal });
    if (Buffer.byteLength(output.stdout || '') > 12000) throw new Error('Discovery exceeds context limit');
    result = redact(JSON.parse(output.stdout), secrets);
    if (!Array.isArray(result.components)) throw new Error('Invalid discovery response');
  } catch {
    signal?.throwIfAborted();
    result = { status: 'unavailable', components: [], scan_truncated: true };
  }
  signal?.throwIfAborted();
  const available = result.components.some(c => c.railpack?.status === 'planned');
  onEvent({ phase: 'plan', source: 'railpack', status: available ? 'ok' : 'unavailable',
    message: available ? 'Launch hints discovered; Claude verifies the preview recipe' : 'Railpack hints unavailable; Claude will inspect the repository',
    elapsed_ms: Math.round(performance.now() - started), context_bytes: Buffer.byteLength(JSON.stringify(result)),
    components: result.components.map(c => ({ cwd: c.cwd, status: c.railpack?.status, raw_bytes: c.railpack?.raw_bytes })) });
  return result;
}

// On this Mac (2026-09-29): the same bounded, read-only facts about a repository's folder — for a Build's run step
// (../build/run-step.cjs), which finds what a repository can run in its worktree. launch-discovery.py's scan and
// workspace grouping, ported so nothing depends on a Python or Railpack being installed here, plus the facts that tell a
// web UI from a desktop app or a terminal program (hints). Never runs, installs or builds anything; never follows a link.
const IGNORE = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', '.next', 'dist', 'build', '__pycache__']);
const MANIFESTS = new Set(['package.json', 'requirements.txt', 'pyproject.toml', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json']);
const LOCKS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'uv.lock', 'poetry.lock']);
const SCRIPTS = ['dev', 'start', 'serve', 'preview', 'build', 'predev', 'prestart', 'prebuild', 'postinstall', 'prepare', 'backend', 'server', 'client'];
const UI_PACKAGES = ['vite', 'next', 'react-scripts', 'nuxt', 'astro', '@sveltejs/kit', '@angular/cli', 'webpack-dev-server', 'parcel', 'gatsby', '@remix-run/dev', 'express', 'fastify', 'koa', 'http-server', 'serve'];
const APP_PACKAGES = ['electron', '@tauri-apps/cli', '@tauri-apps/api', 'nw', '@neutralinojs/lib'];
const LOCAL_BYTES = 11900;

const cut = (value, limit = 300) => (typeof value === 'string' ? value.slice(0, limit) : null);

function readSmallJson(file, limit = 64_000) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) return {};
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

/** fnmatch's case-sensitive match, as launch-discovery.py uses it for npm workspace patterns. */
function globMatch(value, pattern) {
  const source = pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  try { return new RegExp(`^${source}$`).test(value); } catch { return false; }
}

function localComponent(root, relative, files) {
  const dir = path.join(root, relative);
  const names = files.filter((name) => MANIFESTS.has(name));
  const item = {
    cwd: relative || '.',
    manifests: names.filter((name) => { try { return !fs.lstatSync(path.join(dir, name)).isSymbolicLink(); } catch { return false; } }).sort(),
    lockfiles: files.filter((name) => LOCKS.has(name)).sort(),
    files: files.filter((name) => !name.startsWith('.') && !LOCKS.has(name)).sort().slice(0, 20),
  };
  const pkg = files.includes('package.json') ? readSmallJson(path.join(dir, 'package.json')) : {};
  if (pkg.scripts && typeof pkg.scripts === 'object') {
    item.scripts = Object.fromEntries(Object.entries(pkg.scripts).filter(([key]) => SCRIPTS.includes(key)).map(([key, value]) => [key, cut(value)]));
  }
  if (typeof pkg.proxy === 'string') {
    let target = null;
    try { target = new URL(pkg.proxy); } catch { target = null; }
    // Local routing evidence only, never another address or credentials.
    if (target && ['http:', 'https:'].includes(target.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && !target.username) item.local_proxy = cut(pkg.proxy, 200);
    else item.proxy_configured = true;
  }
  for (const key of ['workspaces', 'engines', 'packageManager']) {
    if (key in pkg) item[key] = JSON.stringify(pkg[key]).length < 500 ? pkg[key] : '[truncated; inspect package.json]';
  }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const hints = {};
  const ui = UI_PACKAGES.filter((name) => Object.hasOwn(deps, name));
  const app = APP_PACKAGES.filter((name) => Object.hasOwn(deps, name));
  if (ui.length) hints.web = ui.slice(0, 4);
  if (app.length || files.includes('src-tauri')) hints.desktop = app.length ? app.slice(0, 3) : ['tauri'];
  if (typeof pkg.bin === 'string') hints.bin = [cut(pkg.name, 80) || 'bin'];
  else if (pkg.bin && typeof pkg.bin === 'object') hints.bin = Object.keys(pkg.bin).slice(0, 4).map((name) => cut(name, 80));
  if (typeof pkg.main === 'string') hints.main = cut(pkg.main, 200);
  if (Object.keys(hints).length) item.hints = hints;
  item.evidence = files.filter((name) => /^readme/i.test(name) || /^(vite|next)\.config\./.test(name) || ['Procfile', 'railpack.json', 'server.py', 'app.py', 'main.py', 'manage.py', 'index.html', 'electron.js', 'main.js'].includes(name))
    .sort().slice(0, 8).map((name) => (relative ? `${relative}/${name}` : name));
  return item;
}

/**
 * The launch facts of a repository's folder on this Mac, bounded like launch-discovery.py: at most 120 folders three
 * deep, 8 components, 11,900 bytes of JSON. → { components, scan_truncated, elapsed_ms }
 */
function discoverLocal(root) {
  const started = performance.now();
  const found = [];
  let visited = 0;
  let truncated = false;
  const walk = (relative, depth) => {
    if (visited >= 120) { truncated = true; return false; }
    visited += 1;
    let entries;
    try { entries = fs.readdirSync(path.join(root, relative), { withFileTypes: true }); } catch { return true; }
    const files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const children = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !IGNORE.has(entry.name)).map((entry) => entry.name).sort();
    if (files.some((name) => MANIFESTS.has(name))) {
      if (found.length === 8) { truncated = true; return false; }
      found.push(localComponent(root, relative, [...files, ...(children.includes('src-tauri') ? ['src-tauri'] : [])]));
    }
    if (depth >= 3) { truncated = truncated || children.length > 0; return true; }
    for (const child of children) if (!walk(relative ? `${relative}/${child}` : child, depth + 1)) return false;
    return true;
  };
  if (typeof root === 'string' && path.isAbsolute(root)) walk('', 0);
  // A child of an npm workspace keeps its facts but is marked with the root it installs from.
  for (const item of found) {
    for (const candidate of found) {
      let patterns = candidate.workspaces;
      if (patterns && !Array.isArray(patterns) && typeof patterns === 'object') patterns = patterns.packages;
      if (candidate === item || !item.manifests.includes('package.json') || !Array.isArray(patterns)) continue;
      const base = candidate.cwd === '.' ? '' : `${candidate.cwd}/`;
      if (item.cwd === candidate.cwd || !item.cwd.startsWith(base)) continue;
      const relative = item.cwd.slice(base.length);
      if (patterns.some((pattern) => typeof pattern === 'string' && !pattern.startsWith('!') && globMatch(relative, pattern.replace(/\/+$/, '')))) { item.workspace_root = candidate.cwd; break; }
    }
  }
  const result = { components: found, scan_truncated: truncated, elapsed_ms: 0 };
  while (Buffer.byteLength(JSON.stringify(result)) > LOCAL_BYTES && found.length) { found.pop(); result.scan_truncated = true; }
  result.elapsed_ms = Math.round(performance.now() - started);
  return result;
}

module.exports = { discoverLaunch, discoverLocal };
