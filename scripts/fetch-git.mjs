// Engelbart's own Git (2026-09-28): dugite-native's build of Git, the one GitHub Desktop ships and the npm package
// `dugite` downloads, fetched for each Mac architecture into vendor/git/darwin-<arch>/, where the packaged app picks
// it up (electron-builder.config.cjs → extraResources) and a checkout run with `npm start` finds it too
// (src/main/tools/bundled-git.cjs). It stands in for a Mac without Apple's developer tools, whose /usr/bin/git only
// opens Apple's installer.
//
//   node scripts/fetch-git.mjs            both architectures (a release builds both)
//   node scripts/fetch-git.mjs arm64      one
//
// The archives are checked against the checksums below (dugite 3.2.3's script/embedded-git.json) and kept in
// vendor/git/.cache, so a second run is offline. What is taken out: Git Credential Manager, a .NET program with
// its runtime (~110 MB of the 148), which nothing configures; Git itself, Git LFS and scalar stay. Added: the
// launcher engelbart-bin/git, because this build looks for its helpers and templates under / unless told.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, readdirSync, rmSync, mkdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSION = '2.53.0';
const RELEASE = 'https://github.com/desktop/dugite-native/releases/download/v2.53.0-4';
const ARCHIVES = {
  arm64: { name: 'dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz', sha256: 'f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe' },
  x64: { name: 'dugite-native-v2.53.0-4098283-macOS-x64.tar.gz', sha256: 'ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680' },
};
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = path.join(ROOT, 'vendor', 'git');
const CACHE = path.join(VENDOR, '.cache');
const MARKER = '.engelbart-git.json';

// Run through PATH, so it is found (and Apple's stub never is) wherever a program started by Engelbart looks for `git`.
const LAUNCHER = `#!/bin/sh
# Engelbart's own Git (scripts/fetch-git.mjs): ../bin/git, told where its helpers and templates are,
# because it was built to find them under /. This folder goes first on PATH while Engelbart uses it.
dir=\${0%/*}
dir=\${dir%/*}
GIT_EXEC_PATH="$dir/libexec/git-core"; export GIT_EXEC_PATH
GIT_TEMPLATE_DIR="$dir/share/git-core/templates"; export GIT_TEMPLATE_DIR
exec "$dir/bin/git" "$@"
`;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const megabytes = (dir) => Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]) / 1024;

async function download(archive) {
  mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, archive.name);
  if (existsSync(file) && sha256(file) === archive.sha256) return file;
  console.log(`downloading ${archive.name}`);
  const response = await fetch(`${RELEASE}/${archive.name}`, { headers: { 'User-Agent': 'engelbart-fetch-git' } });
  if (!response.ok) throw new Error(`${archive.name}: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
  const got = sha256(`${file}.part`);
  if (got !== archive.sha256) { rmSync(`${file}.part`, { force: true }); throw new Error(`${archive.name}: checksum ${got}, expected ${archive.sha256}`); }
  renameSync(`${file}.part`, file);
  return file;
}

/** Everything in libexec/git-core that is not Git: Git Credential Manager and the .NET runtime it brings. */
function prune(dir) {
  const core = path.join(dir, 'libexec', 'git-core');
  const keep = (name) => (name.startsWith('git') && !name.startsWith('git-credential-manager')) || name === 'scalar' || name === 'mergetools';
  for (const name of readdirSync(core)) if (!keep(name)) rmSync(path.join(core, name), { recursive: true, force: true });
}

async function fetchGit(arch) {
  const archive = ARCHIVES[arch];
  if (!archive) throw new Error(`no Git for darwin-${arch} (known: ${Object.keys(ARCHIVES).join(', ')})`);
  const target = path.join(VENDOR, `darwin-${arch}`);
  try {
    if (JSON.parse(readFileSync(path.join(target, MARKER), 'utf8')).sha256 === archive.sha256) { console.log(`vendor/git/darwin-${arch}: Git ${VERSION}, up to date`); return; }
  } catch { /* not there yet */ }
  const file = await download(archive);
  const staging = `${target}.partial`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  execFileSync('tar', ['-xzf', file, '-C', staging]); // bsdtar keeps the symlinks (git-core is mostly links to git)
  prune(staging);
  mkdirSync(path.join(staging, 'engelbart-bin'));
  writeFileSync(path.join(staging, 'engelbart-bin', 'git'), LAUNCHER);
  chmodSync(path.join(staging, 'engelbart-bin', 'git'), 0o755);
  if (arch === process.arch) { // the other architecture may not run here (no Rosetta)
    const version = execFileSync(path.join(staging, 'engelbart-bin', 'git'), ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim();
    if (!version.includes(VERSION)) throw new Error(`darwin-${arch}: the launcher printed "${version}"`);
  }
  writeFileSync(path.join(staging, MARKER), `${JSON.stringify({ version: VERSION, archive: archive.name, sha256: archive.sha256 }, null, 2)}\n`);
  rmSync(target, { recursive: true, force: true });
  renameSync(staging, target);
  console.log(`vendor/git/darwin-${arch}: Git ${VERSION}, ${megabytes(target).toFixed(0)} MB`);
}

const wanted = process.argv.slice(2);
for (const arch of wanted.length ? wanted : Object.keys(ARCHIVES)) await fetchGit(arch);
