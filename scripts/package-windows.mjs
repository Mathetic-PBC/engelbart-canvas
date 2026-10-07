// A Windows release (2026-10-07, docs/windows-port-log.md "One-command install"): `npm run dist:win`, on Windows (CI
// makes it on windows-latest and keeps it as the engelbart-windows-installer artifact). Like `npm run dist:mac`: a
// production build (no test mode, src/main/developer.cjs) with the main process minified (scripts/app-source.mjs),
// then the x64 installer, release/Engelbart-<version>-x64.exe, and its update feed, release/latest.yml, which the
// install command (scripts/install-windows.ps1) reads. ENGELBART_DOWNLOAD_URL, the folder they are uploaded to, is
// required, as for the Mac: electron-builder writes latest.yml only when it has one. Uploading: `npm run upload:win`.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { minifiedSources } from './app-source.mjs';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const run = (command, args, env = {}) => execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });

if (process.platform !== 'win32') { console.error('The Windows installer is made on Windows (CI makes it on windows-latest).'); process.exit(1); }
const downloads = process.env.ENGELBART_DOWNLOAD_URL;
if (!downloads) {
  console.error('Set ENGELBART_DOWNLOAD_URL to the web folder this release will be uploaded to, e.g.\n  $env:ENGELBART_DOWNLOAD_URL="https://example.com/engelbart"; npm run dist:win');
  process.exit(1);
}
if (!/^https:\/\/|^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(downloads)) {
  console.error(`ENGELBART_DOWNLOAD_URL must be an https address: ${downloads}`);
  process.exit(1);
}
process.env.ENGELBART_APP_SOURCE = await minifiedSources(ROOT); // read by the config as it loads

let builder;
try { builder = require('electron-builder'); } catch { console.error('electron-builder is not installed yet: run `npm install` first.'); process.exit(1); }
const { build, Platform, Arch } = builder;
const config = require('../electron-builder.config.cjs');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

run('node', ['scripts/build.mjs'], { NODE_ENV: 'production', ENGELBART_DEVELOPER: '0' }); // what ships has no test mode
fs.mkdirSync(path.join(ROOT, 'release'), { recursive: true });
for (const stale of fs.readdirSync(path.join(ROOT, 'release'), { withFileTypes: true })) {
  if (stale.isFile() && /^Engelbart-.*\.(exe|blockmap)$|^latest\.yml$/.test(stale.name)) fs.rmSync(path.join(ROOT, 'release', stale.name));
}
await build({ targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64), config, publish: 'never' });
const installer = `Engelbart-${version}-x64.exe`;
for (const name of [installer, 'latest.yml']) if (!fs.existsSync(path.join(ROOT, 'release', name))) { console.error(`release/${name} was not made.`); process.exit(1); }
console.log(`\nrelease/${installer} and release/latest.yml, for ${config.extraMetadata.engelbart.downloads}. Upload them from the Mac: npm run upload:win`);
