'use strict';

// Every package the packaged app loads is inside it (2026-09-30). 0.1.2 shipped with 8 packages in app.asar instead of
// 134: it was built in a checkout whose node_modules was a symlink to another checkout's, and electron-builder kept the
// packages package.json names but dropped everything npm had hoisted beside them (openapi-fetch for e2b, zod for the
// MCP SDK, fs-extra for electron-updater). Nothing failed until a Build ran in the installed app.
//
// The check reads app.asar's file list and resolves each dependency the way Node's require does: from the package that
// needs it, its own node_modules, then each node_modules above it. It starts from the app's package.json and follows
// `dependencies` (not optional or peer ones). The renderer's packages are left out: they are bundled into dist/.
//
//   node scripts/check-app-modules.cjs [path/to/Engelbart.app]      (default: this Mac's release/mac-<arch> build)
//
// electron-builder.config.cjs runs it on every app it packs (afterPack) and fails the build when anything is missing.

const fs = require('node:fs');
const path = require('node:path');

// Bundled into dist/ by scripts/build.mjs, and left out of the app by electron-builder.config.cjs.
const RENDERER = ['react', 'react-dom', 'roughjs', /^@xterm\//, /^@fontsource\//];
const isRenderer = (name) => RENDERER.some((rule) => (typeof rule === 'string' ? rule === name : rule.test(name)));

function loadAsar() {
  for (const from of [__dirname, path.dirname(require.resolve('app-builder-lib'))]) {
    try { return require(require.resolve('@electron/asar', { paths: [from] })); } catch { /* the next place */ }
  }
  throw new Error('@electron/asar is not installed (it comes with electron-builder): run `npm install`.');
}

/**
 * What the app at `asarPath` is missing → { checked, missing: [{ name, from, chain }] }. `chain`: how the app comes to
 * need it (its package.json's dependency first).
 */
function checkAppModules(asarPath) {
  const asar = loadAsar();
  const files = new Set(asar.listPackage(asarPath).map((file) => file.split(path.sep).join('/')));
  // asar names files with the platform's separator (\ on Windows); the paths here use /.
  const readJson = (file) => JSON.parse(asar.extractFile(asarPath, file.replace(/^\//, '').split('/').join(path.sep)).toString('utf8'));
  // The folder `name` resolves to from package folder `dir` ('' is the app), as Node looks: nearest node_modules first.
  const resolve = (dir, name) => {
    for (let at = dir; ; at = at.slice(0, at.lastIndexOf('/node_modules/'))) {
      const candidate = `${at}/node_modules/${name}`;
      if (files.has(`${candidate}/package.json`)) return candidate;
      if (!at.includes('/node_modules/')) return null;
    }
  };
  const seen = new Set();
  const missing = [];
  const queue = Object.keys(readJson('/package.json').dependencies || {}).filter((name) => !isRenderer(name)).map((name) => ({ name, from: '', chain: [name] }));
  while (queue.length) {
    const { name, from, chain } = queue.shift();
    const found = resolve(from, name);
    if (!found) { missing.push({ name, from: from || '(the app)', chain }); continue; }
    if (seen.has(found)) continue;
    seen.add(found);
    for (const dep of Object.keys(readJson(`${found}/package.json`).dependencies || {})) queue.push({ name: dep, from: found, chain: [...chain, dep] });
  }
  return { checked: seen.size, missing };
}

/**
 * The same for an app folder (Engelbart.app, or Windows' win-unpacked, which keeps app.asar in resources/). Throws when
 * anything is missing, naming each and why it is needed.
 */
function assertAppModules(appPath, label = path.basename(appPath)) {
  const mac = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const windows = path.join(appPath, 'resources', 'app.asar');
  const asarPath = !fs.existsSync(mac) && fs.existsSync(windows) ? windows : mac;
  if (!fs.existsSync(asarPath)) throw new Error(`${label}: no app.asar at ${asarPath}`);
  const { checked, missing } = checkAppModules(asarPath);
  if (missing.length) {
    const lines = missing.slice(0, 40).map((item) => `  ${item.name}  (${item.chain.join(' → ')})`);
    throw new Error(`${label} is missing ${missing.length} package${missing.length === 1 ? '' : 's'} it needs:\n${lines.join('\n')}${missing.length > 40 ? `\n  …and ${missing.length - 40} more` : ''}\n`
      + 'Build from a checkout with its own node_modules, installed with `npm ci` (not a symlink to another checkout\'s).');
  }
  return checked;
}

module.exports = { checkAppModules, assertAppModules, isRenderer };

if (require.main === module) {
  const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
  const app = path.resolve(process.argv[2] || path.join(__dirname, '..', 'release', arch, 'Engelbart.app'));
  try {
    const checked = assertAppModules(app, app);
    console.log(`${app}: all ${checked} packages it needs are inside.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
