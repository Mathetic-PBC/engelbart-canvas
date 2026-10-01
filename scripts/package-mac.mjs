// Packaging Engelbart for the Mac (2026-09-28). electron-builder.config.cjs says what goes into the app; this says
// which apps are made. Shipping a release: docs/releasing-mac.md.
//
//   npm run package     this Mac's architecture as an app folder, release/mac-<arch>/Engelbart.app, signed ad hoc
//                       (what `npm run relaunch` opens). Development renderer, with source maps.
//   npm run dist:mac    a release for both kinds of Mac from a production build: a .dmg and a .zip each, the update
//                       feed (latest-mac.yml), then release/upload/, every file to upload: those, the install command
//                       (install.sh) and a download page. Needs ENGELBART_DOWNLOAD_URL, the folder they go in.
//                       The main process goes in minified, file by file (release/.app-src; the same layout, so every
//                       path and require stays as it is): not protection, but the source is not there to read.

import { execFileSync } from 'node:child_process';
import { transform } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const release = process.argv.includes('--release');
const run = (command, args, env = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';

/** src/main, src/shared and the two preloads, minified one file at a time into release/.app-src/src. → that folder */
async function minifiedSources() {
  const out = path.join(ROOT, 'release', '.app-src');
  fs.rmSync(out, { recursive: true, force: true });
  const files = ['src/preload.cjs', 'src/post-it-preload.cjs'];
  for (const dir of ['src/main', 'src/shared']) {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { recursive: true })) if (String(entry).endsWith('.cjs')) files.push(path.join(dir, String(entry)));
  }
  for (const file of files) {
    const { code } = await transform(fs.readFileSync(path.join(ROOT, file), 'utf8'), { loader: 'js', minify: true, platform: 'node', target: 'node22', sourcefile: file });
    fs.mkdirSync(path.dirname(path.join(out, file)), { recursive: true });
    fs.writeFileSync(path.join(out, file), code);
  }
  return path.join(out, 'src');
}

if (process.platform !== 'darwin') { console.error('The Mac app is packaged on a Mac.'); process.exit(1); }
// A node_modules that is a symlink to another checkout's: electron-builder then keeps only the packages package.json
// names and drops every one npm hoisted beside them (how 0.1.2 shipped without 35; scripts/check-app-modules.cjs).
if (fs.existsSync(path.join(ROOT, 'node_modules')) && fs.lstatSync(path.join(ROOT, 'node_modules')).isSymbolicLink()) {
  console.error('node_modules here is a symlink, and electron-builder leaves most packages out of the app when it is.\nRemove it and run `npm ci` in this checkout first.');
  process.exit(1);
}
if (!release) { // read by the config as it loads: an everyday build is never sent to Apple, nor told of releases to update to
  process.env.ENGELBART_SIGN = 'adhoc';
  delete process.env.ENGELBART_DOWNLOAD_URL;
}
if (release) process.env.ENGELBART_APP_SOURCE = await minifiedSources(); // likewise

let builder;
try { builder = require('electron-builder'); } catch { console.error('electron-builder is not installed yet: run `npm install` first.'); process.exit(1); }
const { build, Platform, Arch } = builder;
const config = require('../electron-builder.config.cjs');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (!release) {
  run('node', ['scripts/build.mjs']);
  run('node', ['scripts/fetch-git.mjs', hostArch]);
  await build({ targets: Platform.MAC.createTarget(['dir'], Arch[hostArch]), config, publish: 'never' });
  console.log(`\nrelease/${hostArch === 'arm64' ? 'mac-arm64' : 'mac'}/Engelbart.app`);
} else {
  const downloads = config.extraMetadata.engelbart.downloads;
  if (!downloads) {
    console.error('Set ENGELBART_DOWNLOAD_URL to the web folder this release will be uploaded to, e.g.\n  ENGELBART_DOWNLOAD_URL=https://example.com/engelbart npm run dist:mac');
    process.exit(1);
  }
  if (!/^https:\/\/|^http:\/\/127\.0\.0\.1:\d+\//.test(downloads)) {
    console.error(`ENGELBART_DOWNLOAD_URL must be an https address (the install command is run by bash): ${downloads}`);
    process.exit(1);
  }
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) console.warn(`\nNote: uncommitted changes go into this release too:\n${dirty}\n`);
  run('node', ['scripts/build.mjs'], { NODE_ENV: 'production', ENGELBART_DEVELOPER: '0' }); // what ships has no test mode (src/main/developer.cjs)
  run('node', ['scripts/fetch-git.mjs', 'arm64', 'x64']);
  fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
  for (const stale of fs.readdirSync(path.join(ROOT, 'release'), { withFileTypes: true })) {
    if (stale.isFile() && /^Engelbart-.*\.(dmg|zip|blockmap)$|^latest-mac\.yml$/.test(stale.name)) fs.rmSync(path.join(ROOT, 'release', stale.name));
  }
  await build({ targets: Platform.MAC.createTarget(['dmg', 'zip'], Arch.arm64, Arch.x64), config, publish: 'never' });
  const { writeSite } = await import('./release-site.mjs');
  const site = writeSite({ root: ROOT, version, downloads, developerId: config.extraMetadata.engelbart.developerId });
  console.log(`\nUpload everything in ${path.relative(ROOT, site)}/ to ${downloads}`);
  console.log(`Install command: curl -fsSL ${downloads}install.sh | bash`);
}
