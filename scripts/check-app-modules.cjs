'use strict';

// Does a packaged Engelbart.app hold every package its main process needs? (2026-09-30)
//
// electron-builder picks the node_modules that go into app.asar itself, from `npm list` (app-builder-lib's
// node-module-collector), not from our `files` patterns. Release 0.1.2, built on another Mac, came out with only the
// top-level packages and what npm had nested inside them: e2b without openapi-fetch and the rest, so every E2B build
// stopped with "Cannot find module 'openapi-fetch'"; @modelcontextprotocol/sdk and electron-updater were missing theirs
// too. The same commit packaged here was whole, so this runs on every build (electron-builder.config.cjs → afterPack)
// and stops one that is not, whatever Mac it is made on.
//
// It reads app.asar's header (the files, not their contents), then, as Node's require would from inside the app,
// resolves each dependency of package.json and of every package in node_modules. An optional dependency may be
// absent (pdf.js's drawing module is left out on purpose), and so may the renderer's, already bundled into dist/.
//
//   node scripts/check-app-modules.cjs release/mac-arm64/Engelbart.app      any built or downloaded app

const fs = require('node:fs');
const path = require('node:path');

// The renderer's packages: bundled into dist/ by esbuild, so electron-builder.config.cjs leaves them out of node_modules.
const RENDERER_BUNDLED = ['react', 'react-dom', 'scheduler', 'roughjs', 'hachure-fill', 'path-data-parser', 'points-on-curve', 'points-on-path', '@xterm', '@fontsource'];
const rendererBundled = (name) => RENDERER_BUNDLED.includes(name) || RENDERER_BUNDLED.includes(name.split('/')[0]);

/** The file tree in an app.asar's header: { files: { name: { files } | { size, offset, unpacked? } } }. */
function readAsarTree(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const sizes = Buffer.alloc(16);
    fs.readSync(fd, sizes, 0, 16, 0);
    const json = Buffer.alloc(sizes.readUInt32LE(12));
    fs.readSync(fd, json, 0, json.length, 16);
    const offset = 8 + sizes.readUInt32LE(4);
    const tree = JSON.parse(json.toString('utf8'));
    tree.read = (entry) => {
      const out = Buffer.alloc(entry.size);
      fs.readSync(fd, out, 0, entry.size, offset + Number(entry.offset));
      return out.toString('utf8');
    };
    return { tree, close: () => fs.closeSync(fd) };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

/**
 * What cannot be found, as "needed-by → name" lines; empty when the app is whole.
 * @param {(dir: string) => string[] | null} list   entries of a folder ('' is the app's root), null when there is none
 * @param {(file: string) => object | null} readJson
 * @param {(name: string) => boolean} bundled       a dependency of the app's package.json that is not shipped as a package
 */
function missingModules({ list, readJson, bundled }) {
  const missing = [];
  const checked = new Set();
  const isDir = (dir) => list(dir) != null;
  // Node's lookup: <dir>/node_modules/<name>, then each folder above, up to the app's root.
  const resolve = (from, name) => {
    for (let dir = from; ; dir = path.posix.dirname(dir)) {
      if (dir === '.') dir = '';
      const candidate = path.posix.join(dir, 'node_modules', name);
      if (path.posix.basename(dir) !== 'node_modules' && isDir(candidate)) return candidate;
      if (dir === '') return null;
    }
  };
  const visit = (pkgDir, label) => {
    if (checked.has(pkgDir)) return;
    checked.add(pkgDir);
    const pkg = readJson(path.posix.join(pkgDir, 'package.json')) || {};
    const wanted = [
      ...Object.keys(pkg.dependencies || {}).map((name) => [name, false]),
      ...Object.keys(pkg.optionalDependencies || {}).map((name) => [name, true]),
    ];
    for (const [name, optional] of wanted) {
      if (pkgDir === '' && bundled(name)) continue;
      const found = resolve(pkgDir, name);
      if (found) visit(found, name);
      else if (!optional) missing.push(`${label} → ${name}`);
    }
  };
  visit('', 'package.json');
  return missing;
}

/** The same, for an Engelbart.app (or its app.asar) on disk. */
function missingInApp(appOrAsar, { bundled = rendererBundled } = {}) {
  const asarPath = appOrAsar.endsWith('.asar') ? appOrAsar : path.join(appOrAsar, 'Contents', 'Resources', 'app.asar');
  const { tree, close } = readAsarTree(asarPath);
  try {
    const entry = (p) => p.split('/').filter(Boolean).reduce((node, part) => node?.files?.[part], tree);
    return missingModules({
      bundled,
      list: (dir) => {
        const node = entry(dir);
        return node?.files ? Object.keys(node.files) : null;
      },
      readJson: (file) => {
        const node = entry(file);
        if (!node || node.files) return null;
        const text = node.unpacked ? fs.readFileSync(path.join(`${asarPath}.unpacked`, file), 'utf8') : tree.read(node);
        return JSON.parse(text);
      },
    });
  } finally {
    close();
  }
}

module.exports = { RENDERER_BUNDLED, missingModules, missingInApp };

if (require.main === module) {
  const app = process.argv[2];
  if (!app) {
    console.error('usage: node scripts/check-app-modules.cjs <Engelbart.app | app.asar>');
    process.exit(2);
  }
  const missing = missingInApp(path.resolve(app));
  if (missing.length) {
    console.error(`${missing.length} packages the app needs are not in it:\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log('Every package the app needs is in it.');
}
