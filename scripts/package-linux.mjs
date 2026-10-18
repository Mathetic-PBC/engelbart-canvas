// A Linux release (2026-10-07, docs/windows-port-log.md "Linux"): `npm run dist:linux`, on Linux x64 (CI makes it on
// ubuntu-latest and keeps it as the engelbart-linux-appimage artifact). Like `npm run dist:win`: a production build (no
// test mode, src/main/developer.cjs) with the main process minified (scripts/app-source.mjs), then the x64 AppImage,
// release/Engelbart-<version>-x86_64.AppImage, and its update feed, release/latest-linux.yml, which the install command
// (scripts/install-linux.sh) reads. ENGELBART_DOWNLOAD_URL, the folder they are uploaded to, is required: electron-builder
// writes latest-linux.yml only when it has one. Uploading: `npm run upload:linux`.
//
// node-pty has no prebuilt module for Linux: `npm ci` compiles it (build/Release/pty.node, N-API, so Electron loads it as
// it is). The app leaves node-pty's build folder out, so the module is put where node-pty also looks,
// prebuilds/linux-x64, before packaging (electron-builder.config.cjs, afterPackLinux, checks it is in the app).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { minifiedSources } from './app-source.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const run = (command, args, env = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

if (process.platform !== 'linux' || process.arch !== 'x64') { console.error('The Linux AppImage is made on Linux x64 (CI makes it on ubuntu-latest).'); process.exit(1); }
const downloads = process.env.ENGELBART_DOWNLOAD_URL;
if (!downloads) {
  console.error('Set ENGELBART_DOWNLOAD_URL to the web folder this release will be uploaded to, e.g.\n  ENGELBART_DOWNLOAD_URL=https://example.com/engelbart npm run dist:linux');
  process.exit(1);
}
if (!/^https:\/\/|^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(downloads)) {
  console.error(`ENGELBART_DOWNLOAD_URL must be an https address: ${downloads}`);
  process.exit(1);
}
const built = path.join(ROOT, 'node_modules', 'node-pty', 'build', 'Release');
const staged = path.join(ROOT, 'node_modules', 'node-pty', 'prebuilds', 'linux-x64');
if (!fs.existsSync(path.join(built, 'pty.node'))) { console.error('node-pty is not built (node_modules/node-pty/build/Release/pty.node): run `npm ci` first.'); process.exit(1); }
fs.mkdirSync(staged, { recursive: true });
fs.copyFileSync(path.join(built, 'pty.node'), path.join(staged, 'pty.node'));
process.env.ENGELBART_APP_SOURCE = await minifiedSources(ROOT); // read by the config as it loads

let builder;
try { builder = require('electron-builder'); } catch { console.error('electron-builder is not installed yet: run `npm install` first.'); process.exit(1); }
const { build, Platform, Arch } = builder;
const config = require('../electron-builder.config.cjs');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

run('node', ['scripts/build.mjs'], { NODE_ENV: 'production', ENGELBART_DEVELOPER: '0' }); // what ships has no test mode
fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
for (const stale of fs.readdirSync(path.join(ROOT, 'release'), { withFileTypes: true })) {
  if (stale.isFile() && /^Engelbart-.*\.AppImage$|^latest-linux\.yml$/.test(stale.name)) fs.rmSync(path.join(ROOT, 'release', stale.name));
}
await build({ targets: Platform.LINUX.createTarget(['AppImage'], Arch.x64), config, publish: 'never' });
const appImage = `Engelbart-${version}-x86_64.AppImage`;
for (const name of [appImage, 'latest-linux.yml']) if (!fs.existsSync(path.join(ROOT, 'release', name))) { console.error(`release/${name} was not made (release/ has: ${fs.readdirSync(path.join(ROOT, 'release')).join(', ')}).`); process.exit(1); }
console.log(`\nrelease/${appImage} and release/latest-linux.yml, for ${config.extraMetadata.engelbart.downloads}. Upload them from the Mac: npm run upload:linux`);
