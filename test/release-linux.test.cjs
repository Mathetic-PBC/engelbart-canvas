'use strict';

// The Linux release (2026-10-07, docs/windows-port-log.md "Linux"): what scripts/release-site.mjs writes for it
// (release/upload-linux/: the AppImage, latest-linux.yml, install-linux.sh, SHA256SUMS-linux.txt, the download page with
// its Linux section, and install.sh with the block that hands Linux to install-linux.sh), and, on Linux, the install
// command itself: `curl … install.sh | bash` against a folder served here, with a stand-in AppImage (a script that
// unpacks a stand-in app when asked to --appimage-extract), into a throwaway home. Also the app's launcher
// (build/linux/engelbart-launch) starting the app with or without Chromium's sandbox. The real install, of the AppImage
// CI makes, is CI's (.github/workflows/ci.yml, "Install with the one-line command (Linux)").

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const INSTALL_MAC = path.join(ROOT, 'scripts', 'install-mac.sh');
const INSTALL_LINUX = path.join(ROOT, 'scripts', 'install-linux.sh');
const LAUNCHER = path.join(ROOT, 'build', 'linux', 'engelbart-launch');
const VERSION = '9.9.9';
const DOWNLOADS = 'https://example.com/engelbart/';
const site = () => import('../scripts/release-site.mjs');
const onLinux = process.platform !== 'linux' && 'runs the Linux install command (bash, GNU coreutils, /proc)';

/** A stand-in app as the AppImage holds it: the binary (prints its arguments), the launcher, the menu entry, an icon. */
function standInApp(dir) {
  fs.mkdirSync(path.join(dir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'engelbart'), '#!/bin/sh\necho "engelbart ran with: $*"\n', { mode: 0o755 });
  fs.copyFileSync(LAUNCHER, path.join(dir, 'engelbart-launch'));
  fs.chmodSync(path.join(dir, 'engelbart-launch'), 0o755);
  fs.writeFileSync(path.join(dir, 'engelbart.desktop'), '[Desktop Entry]\nName=Engelbart\nExec=AppRun --no-sandbox %U\nTerminal=false\nType=Application\nIcon=engelbart\nStartupWMClass=Engelbart\nX-AppImage-Version=9.9.9\nCategories=Development;\n');
  fs.writeFileSync(path.join(dir, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'engelbart.png'), 'png');
  return dir;
}

/** What CI keeps of a Linux release: a stand-in AppImage (unpacks `app` into ./squashfs-root) and latest-linux.yml. */
function ciFolder(dir, { version = VERSION, sha512 = null, app = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const appImage = `Engelbart-${version}-x86_64.AppImage`;
  const script = app
    ? `#!/bin/sh\n[ "$1" = --appimage-extract ] || exit 2\ncp -R ${JSON.stringify(app)} squashfs-root\n`
    : `#!/bin/sh\n# ${crypto.randomBytes(16).toString('hex')}\nexit 2\n`;
  fs.writeFileSync(path.join(dir, appImage), script, { mode: 0o755 });
  const bytes = fs.readFileSync(path.join(dir, appImage));
  const hash = sha512 || crypto.createHash('sha512').update(bytes).digest('base64');
  fs.writeFileSync(path.join(dir, 'latest-linux.yml'), `version: ${version}\nfiles:\n  - url: ${appImage}\n    sha512: ${hash}\n    size: ${bytes.length}\n    blockMapSize: 1\npath: ${appImage}\nsha512: ${hash}\nreleaseDate: '2026-10-07T00:00:00.000Z'\n`);
  return dir;
}

/** A repo-like root for the site writers: the scripts they read. */
function siteRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-linux-site-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const name of ['install-mac.sh', 'install-linux.sh']) fs.copyFileSync(path.join(ROOT, 'scripts', name), path.join(root, 'scripts', name));
  return root;
}

test('release-site: release/upload-linux/ has the AppImage, its feed, install-linux.sh for the folder, the sums, the live page with its Linux section and the live install.sh handing Linux on', async () => {
  const { writeLinuxSite, withSection } = await site();
  const root = siteRoot();
  try {
    const from = ciFolder(path.join(root, 'ci'));
    const before = execFileSync('git', ['show', 'f53c66d:scripts/install-mac.sh'], { cwd: ROOT, encoding: 'utf8' }).replaceAll('__DOWNLOADS__', DOWNLOADS);
    const livePage = '<html><main>\n  <h2>Install</h2>\n\n  <!-- windows -->\n  <h2 id="windows">On Windows</h2>\n  <!-- /windows -->\n</main></html>\n';
    const liveSums = `${'a'.repeat(64)}  Engelbart-0.1.10-arm64.dmg\n${'b'.repeat(64)}  install.sh\n`;
    const out = writeLinuxSite({ root, from, version: VERSION, downloads: 'https://example.com/engelbart', livePage, liveInstall: before, liveSums });
    assert.equal(out, path.join(root, 'release', 'upload-linux'));
    assert.deepEqual(fs.readdirSync(out).sort(), ['Engelbart-9.9.9-x86_64.AppImage', 'SHA256SUMS-linux.txt', 'SHA256SUMS.txt', 'index.html', 'install-linux.sh', 'install.sh', 'latest-linux.yml']);
    const linux = fs.readFileSync(path.join(out, 'install-linux.sh'), 'utf8');
    assert.doesNotMatch(linux, /__DOWNLOADS__/);
    assert.match(linux, /DOWNLOADS="\$\{ENGELBART_DOWNLOADS:-https:\/\/example\.com\/engelbart\/\}"/);
    // install.sh: the live one, with the Linux block before its macOS check and nothing else changed.
    const install = fs.readFileSync(path.join(out, 'install.sh'), 'utf8');
    assert.equal(install.replace(/^# >>> linux[^\n]*\n[\s\S]*?^# <<< linux\n/m, ''), before);
    assert.match(install, /if \[ "\$\(uname -s\)" = Linux \]; then\n {2}linux_installer=\$\(curl -fsSL "\$\{DOWNLOADS\}install-linux\.sh/);
    assert.ok(install.indexOf('# <<< linux') < install.indexOf('= Darwin ] || fail'));
    assert.equal(fs.statSync(path.join(out, 'install.sh')).mode & 0o111, 0o111);
    // The Mac's sums: only install.sh's line changes, to the new file's.
    const sums = fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8');
    assert.equal(sums, `${'a'.repeat(64)}  Engelbart-0.1.10-arm64.dmg\n${crypto.createHash('sha256').update(install).digest('hex')}  install.sh\n`);
    // The page: the Windows section kept, the Linux one added once, and replaced (not added) by the next release.
    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(page, /<!-- \/windows -->\n\n {2}<!-- linux -->\n {2}<h2 id="linux">On Linux<\/h2>/);
    assert.match(page, /curl -fsSL https:\/\/example\.com\/engelbart\/install\.sh \| bash/);
    assert.match(page, /Version 9\.9\.9 · for 64-bit Intel and AMD PCs/);
    assert.match(page, /href="Engelbart-9\.9\.9-x86_64\.AppImage"/);
    assert.equal(withSection(page, 'linux', '\n  <!-- linux -->\nnew\n  <!-- /linux -->\n').match(/<!-- linux -->/g).length, 1);
    const again = writeLinuxSite({ root, from, version: VERSION, downloads: DOWNLOADS, livePage: page, liveInstall: install, liveSums: sums });
    assert.equal(fs.readFileSync(path.join(again, 'index.html'), 'utf8').match(/<!-- linux -->/g).length, 1);
    assert.equal(fs.readFileSync(path.join(again, 'install.sh'), 'utf8'), install, 'the block is replaced, not added again');
    const linuxSums = fs.readFileSync(path.join(out, 'SHA256SUMS-linux.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(linuxSums.map((line) => line.split('  ')[1]), ['Engelbart-9.9.9-x86_64.AppImage', 'install-linux.sh']);
    // CI's install test gives nothing live: install.sh is ours, and there is no page or SHA256SUMS.txt.
    const ci = writeLinuxSite({ root, from, version: VERSION, downloads: DOWNLOADS, out: path.join(root, 'ci-site') });
    assert.equal(fs.readFileSync(path.join(ci, 'install.sh'), 'utf8'), fs.readFileSync(INSTALL_MAC, 'utf8').replaceAll('__DOWNLOADS__', DOWNLOADS));
    assert.ok(!fs.existsSync(path.join(ci, 'index.html')) && !fs.existsSync(path.join(ci, 'SHA256SUMS.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-site: a Linux release for another version, or whose AppImage does not match its feed, is refused; liveLinux reads the live feed', async () => {
  const { writeLinuxSite, liveLinux } = await site();
  const root = siteRoot();
  try {
    assert.throws(() => writeLinuxSite({ root, from: ciFolder(path.join(root, 'a'), { version: '9.9.8' }), version: VERSION, downloads: DOWNLOADS }), /latest-linux\.yml is for 9\.9\.8, not 9\.9\.9/);
    assert.throws(() => writeLinuxSite({ root, from: ciFolder(path.join(root, 'b'), { sha512: 'bad' }), version: VERSION, downloads: DOWNLOADS }), /does not match the sha512/);
    assert.ok(!fs.existsSync(path.join(root, 'release')));
    const feed = fs.readFileSync(path.join(ciFolder(path.join(root, 'c')), 'latest-linux.yml'), 'utf8');
    const size = fs.statSync(path.join(root, 'c', 'Engelbart-9.9.9-x86_64.AppImage')).size;
    const answer = (status, text) => async () => ({ ok: status === 200, text: async () => text });
    assert.deepEqual(await liveLinux(DOWNLOADS, answer(200, feed)), { version: VERSION, appImage: 'Engelbart-9.9.9-x86_64.AppImage', size });
    assert.equal(await liveLinux(DOWNLOADS, answer(404, '')), null);
    assert.equal(await liveLinux(DOWNLOADS, async () => { throw new Error('offline'); }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-site: the Mac page keeps a live Linux section after the Windows one, and is as before with neither', async () => {
  const { writeSite } = await site();
  const root = siteRoot();
  try {
    const release = path.join(root, 'release');
    fs.mkdirSync(release);
    for (const arch of ['arm64', 'x64']) for (const ext of ['dmg', 'zip']) fs.writeFileSync(path.join(release, `Engelbart-0.2.0-${arch}.${ext}`), Buffer.alloc(1024));
    fs.writeFileSync(path.join(release, 'latest-mac.yml'), 'version: 0.2.0\nfiles:\n  - url: Engelbart-0.2.0-arm64.zip\n  - url: Engelbart-0.2.0-x64.zip\n');
    const plain = fs.readFileSync(path.join(writeSite({ root, version: '0.2.0', downloads: DOWNLOADS, developerId: false }), 'index.html'), 'utf8');
    assert.doesNotMatch(plain, /<!-- (windows|linux) -->/);
    const page = fs.readFileSync(path.join(writeSite({ root, version: '0.2.0', downloads: DOWNLOADS, developerId: false, windows: { version: '0.2.0', installer: 'Engelbart-0.2.0-x64.exe', size: 1 }, linux: { version: '0.2.0', appImage: 'Engelbart-0.2.0-x86_64.AppImage', size: 1 } }), 'index.html'), 'utf8');
    assert.ok(page.indexOf('<!-- /windows -->') < page.indexOf('<!-- linux -->'));
    assert.equal(page.replace(/\n {2}<!-- (windows|linux) -->\n[\s\S]*?<!-- \/\1 -->\n/g, ''), plain);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('install-mac.sh: the Linux block hands over before the macOS check and runs nothing else on Linux; install-linux.sh keeps the download folder for the release', () => {
  const mac = fs.readFileSync(INSTALL_MAC, 'utf8');
  const block = /^# >>> linux[^\n]*\n[\s\S]*?^# <<< linux\n/m.exec(mac)[0];
  assert.match(block, /exec bash -c "\$linux_installer" install-linux\.sh\n/);
  assert.ok(mac.indexOf(block) + block.length === mac.indexOf('[ "$(uname -s)" = Darwin ] || fail'));
  const linux = fs.readFileSync(INSTALL_LINUX, 'utf8');
  assert.match(linux, /DOWNLOADS="\$\{ENGELBART_DOWNLOADS:-__DOWNLOADS__\}"/);
  for (const name of ['ENGELBART_FORCE', 'ENGELBART_NO_OPEN', 'ENGELBART_APPARMOR', 'ENGELBART_INSTALL_DIR']) assert.match(linux, new RegExp(`\\$\\{${name}`));
  assert.doesNotMatch(linux, /\bread\b(?![^\n]*< \/dev\/tty)/, 'a question is read from the terminal, never from stdin (the script itself under curl | bash)');
  execFileSync('bash', ['-n', INSTALL_LINUX]);
  execFileSync('sh', ['-n', LAUNCHER]);
});

test('engelbart-launch: starts the app with Chromium\'s sandbox, or with --no-sandbox and the reason on stderr', { skip: process.platform === 'win32' && 'a POSIX shell script' }, () => {
  const dir = standInApp(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-launch-')));
  try {
    const run = (env) => {
      const result = require('node:child_process').spawnSync(path.join(dir, 'engelbart-launch'), ['--a', 'b c'], { env: { ...process.env, ...env }, encoding: 'utf8' });
      return { out: result.stdout.trim(), err: result.stderr.trim() };
    };
    assert.deepEqual(run({ ENGELBART_SANDBOX: 'on' }), { out: 'engelbart ran with: --a b c', err: '' });
    const off = run({ ENGELBART_SANDBOX: 'off' });
    assert.equal(off.out, 'engelbart ran with: --no-sandbox --a b c');
    assert.equal(off.err, "Engelbart: starting without Chromium's sandbox: ENGELBART_SANDBOX=off.");
    if (process.platform === 'linux') { // what this system decides, either way
      const own = run({ ENGELBART_SANDBOX: '' });
      const restricted = fs.existsSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') && fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1';
      if (restricted) assert.match(own.err, /AppArmor lets only programs with a profile make user namespaces, and Engelbart has none\. Run the install command again where you can use sudo/);
      assert.equal(own.out.includes('--no-sandbox'), own.err !== '');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A folder served on 127.0.0.1. → { url, asked, close } */
async function serve(folder) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const file = path.join(folder, decodeURIComponent(req.url.split('?')[0]).slice(1));
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200); res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/`, asked, close: () => server.close() };
}

/** `curl -fsSL <served>install.sh | bash` with `env`. → { code, out } */
function curlBash(served, env) {
  return new Promise((resolve) => {
    execFile('bash', ['-c', `curl -fsSL ${served}install.sh | bash`], { env, timeout: 60000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
}

test('install-linux.sh through install.sh: installs into the home folder, with the engelbart command and a menu entry; stops when up to date; ENGELBART_FORCE installs again', { skip: onLinux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-linux-install-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const app = standInApp(path.join(dir, 'app'));
  const folder = ciFolder(path.join(dir, 'site'), { app });
  const { writeLinuxSite } = await site();
  writeLinuxSite({ root: ROOT, from: folder, version: VERSION, downloads: 'https://example.com/engelbart/', out: path.join(dir, 'served') });
  const server = await serve(path.join(dir, 'served'));
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', ENGELBART_DOWNLOADS: server.url, ENGELBART_NO_OPEN: '1', ENGELBART_APPARMOR: 'no' };
  try {
    const first = await curlBash(server.url, env);
    assert.equal(first.code, 0, first.out);
    const dest = path.join(home, '.local', 'share', 'engelbart');
    assert.match(first.out, new RegExp(`Engelbart 9\\.9\\.9 is installed in ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: open it from the app menu, or with \`engelbart\`\\.`));
    assert.match(first.out, /^Chromium's sandbox: (on|off): .+\.$/m);
    assert.ok(server.asked.some((url) => /^\/install-linux\.sh\?t=\d+$/.test(url)), `install.sh fetched install-linux.sh: ${server.asked.join(' ')}`);
    assert.equal(fs.readFileSync(path.join(dest, 'version'), 'utf8'), '9.9.9\n');
    assert.equal(fs.readlinkSync(path.join(home, '.local', 'bin', 'engelbart')), path.join(dest, 'app', 'engelbart-launch'));
    assert.equal(execFileSync(path.join(home, '.local', 'bin', 'engelbart'), ['x'], { env: { ...env, ENGELBART_SANDBOX: 'on' }, encoding: 'utf8' }), 'engelbart ran with: x\n');
    const entry = fs.readFileSync(path.join(home, '.local', 'share', 'applications', 'engelbart.desktop'), 'utf8');
    assert.match(entry, new RegExp(`^Exec="${path.join(dest, 'app', 'engelbart-launch').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" %U$`, 'm'));
    assert.match(entry, /^Icon=engelbart$/m);
    assert.match(entry, /^StartupWMClass=Engelbart$/m);
    assert.doesNotMatch(entry, /AppRun|--no-sandbox|X-AppImage/);
    assert.ok(fs.existsSync(path.join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'engelbart.png')));

    const downloads = server.asked.filter((url) => url.endsWith('.AppImage')).length;
    const again = await curlBash(server.url, env);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, new RegExp(`Engelbart 9\\.9\\.9 is already installed in ${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} and up to date\\.`));
    assert.equal(server.asked.filter((url) => url.endsWith('.AppImage')).length, downloads, 'nothing downloaded');

    const forced = await curlBash(server.url, { ...env, ENGELBART_FORCE: '1' });
    assert.equal(forced.code, 0, forced.out);
    assert.match(forced.out, /Engelbart 9\.9\.9 is installed in /);
    assert.equal(server.asked.filter((url) => url.endsWith('.AppImage')).length, downloads + 1);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('install-linux.sh: no Git, an ARM computer, a bad checksum and an unreachable folder each stop it with one line', { skip: onLinux }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-linux-refuse-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const folder = ciFolder(path.join(dir, 'site'), { sha512: crypto.createHash('sha512').update('something else').digest('base64') });
  const { writeLinuxSite } = await site();
  writeLinuxSite({ root: ROOT, from: folder, version: VERSION, downloads: DOWNLOADS, out: path.join(dir, 'served') });
  const server = await serve(path.join(dir, 'served'));
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', ENGELBART_DOWNLOADS: server.url, ENGELBART_NO_OPEN: '1', ENGELBART_APPARMOR: 'no' };
  const run = (extra) => new Promise((resolve) => {
    execFile('bash', [INSTALL_LINUX], { env: { ...env, ...extra }, timeout: 60000 }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
  try {
    const bad = await run({});
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /Engelbart was not installed: the download does not match its checksum; run the command again\./);
    assert.ok(!fs.existsSync(path.join(home, '.local', 'share', 'engelbart')));

    const offline = await run({ ENGELBART_DOWNLOADS: 'http://127.0.0.1:9/engelbart/' });
    assert.equal(offline.code, 1, offline.out);
    assert.match(offline.out, /Engelbart was not installed: could not reach http:\/\/127\.0\.0\.1:9\/engelbart\/ \(is this computer online\?\)\./);

    // A PATH with uname (saying aarch64, or the real one) and the shell's own tools, and no git.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -m) echo aarch64 ;; *) echo Linux ;; esac\n', { mode: 0o755 });
    const arm = await run({ PATH: `${bin}:${process.env.PATH}` });
    assert.equal(arm.code, 1, arm.out);
    assert.match(arm.out, /Engelbart was not installed: Engelbart for Linux runs on 64-bit Intel and AMD computers \(x86_64\); this one has an ARM processor \(aarch64\)\./);
    fs.rmSync(path.join(bin, 'uname'));
    fs.symlinkSync(execFileSync('bash', ['-c', 'command -v uname'], { encoding: 'utf8' }).trim(), path.join(bin, 'uname'));
    const noGit = await run({ PATH: bin });
    assert.equal(noGit.code, 1, noGit.out);
    assert.match(noGit.out, /Engelbart was not installed: Engelbart needs Git, which is not installed\. Install it with (sudo apt install git|sudo dnf install git|sudo pacman -S git|sudo zypper install git|your distribution's package manager \(the package is called git\)), then run this command again\./);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
