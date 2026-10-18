'use strict';

// The Windows release (2026-10-07, docs/windows-port-log.md "One-command install"): what scripts/release-site.mjs
// writes for it (release/upload-win/: the installer, latest.yml, install.ps1 with the download folder written in,
// SHA256SUMS-windows.txt and the download page with its Windows section), the Mac page left as it was when there is no
// Windows release, and the install command (scripts/install-windows.ps1) refusing a download that does not match its
// checksum and saying so when the download folder cannot be reached. The real install, of the installer CI makes, is
// CI's (.github/workflows/ci.yml, "Install with the one-line command").

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'install-windows.ps1');
const VERSION = '9.9.9';
const DOWNLOADS = 'https://example.com/engelbart/';
const site = () => import('../scripts/release-site.mjs');

/** What CI keeps of a Windows release for `version`: a stand-in installer, its blockmap and latest.yml. `sha512` and
 *  `size` override what latest.yml says. */
function ciFolder(dir, { version = VERSION, sha512 = null, size = null } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const installer = `Engelbart-${version}-x64.exe`;
  const bytes = crypto.randomBytes(4096);
  fs.writeFileSync(path.join(dir, installer), bytes);
  fs.writeFileSync(path.join(dir, `${installer}.blockmap`), 'blockmap');
  const hash = sha512 || crypto.createHash('sha512').update(bytes).digest('base64');
  fs.writeFileSync(path.join(dir, 'latest.yml'), `version: ${version}\nfiles:\n  - url: ${installer}\n    sha512: ${hash}\n    size: ${size ?? bytes.length}\npath: ${installer}\nsha512: ${hash}\nreleaseDate: '2026-10-07T00:00:00.000Z'\n`);
  return dir;
}

/** A Mac release folder as electron-builder leaves it, for writeSite. */
function macRelease(root, version) {
  const release = path.join(root, 'release');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'install-mac.sh'), path.join(root, 'scripts', 'install-mac.sh'));
  fs.mkdirSync(release, { recursive: true });
  const files = [];
  for (const arch of ['arm64', 'x64']) {
    for (const ext of ['dmg', 'zip']) fs.writeFileSync(path.join(release, `Engelbart-${version}-${arch}.${ext}`), Buffer.alloc(3 * 1024 * 1024));
    files.push(`  - url: Engelbart-${version}-${arch}.zip\n    sha512: x\n    size: 3145728\n`);
  }
  fs.writeFileSync(path.join(release, 'latest-mac.yml'), `version: ${version}\nfiles:\n${files.join('')}`);
}

test('release-site: the Mac page is as before without a Windows release, and gains only the Windows section with one', async () => {
  const { writeSite, withWindows } = await site();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-site-'));
  try {
    macRelease(root, '0.2.0');
    const plain = fs.readFileSync(path.join(writeSite({ root, version: '0.2.0', downloads: DOWNLOADS, developerId: false }), 'index.html'), 'utf8');
    assert.doesNotMatch(plain, /windows|install\.ps1/i);
    assert.match(plain, /curl -fsSL https:\/\/example\.com\/engelbart\/install\.sh \| bash/);
    const windows = { version: '0.2.1', installer: 'Engelbart-0.2.1-x64.exe', size: 90 * 1024 * 1024 };
    const upload = writeSite({ root, version: '0.2.0', downloads: DOWNLOADS, developerId: false, windows });
    const both = fs.readFileSync(path.join(upload, 'index.html'), 'utf8');
    assert.equal(both.replace(/\n  <!-- windows -->\n[\s\S]*?<!-- \/windows -->\n/, ''), plain);
    assert.match(both, /irm https:\/\/example\.com\/engelbart\/install\.ps1 \| iex/);
    assert.match(both, /Version 0\.2\.1 · for 64-bit Windows/);
    assert.match(both, /href="Engelbart-0\.2\.1-x64\.exe"[\s\S]*90 MB/);
    assert.equal(withWindows(both, '\n  <!-- windows -->\nnew\n  <!-- /windows -->\n').match(/<!-- windows -->/g).length, 1);
    assert.deepEqual(fs.readdirSync(upload).filter((name) => /windows|\.exe|\.ps1|latest\.yml/.test(name)), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-site: release/upload-win/ has the installer, latest.yml, install.ps1 for the folder, the sums and the live page with its Windows section', async () => {
  const { writeWindowsSite, writeSite } = await site();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-site-'));
  try {
    macRelease(root, '0.2.0');
    fs.copyFileSync(SCRIPT, path.join(root, 'scripts', 'install-windows.ps1'));
    const livePage = fs.readFileSync(path.join(writeSite({ root, version: '0.2.0', downloads: DOWNLOADS, developerId: false }), 'index.html'), 'utf8');
    const from = ciFolder(path.join(root, 'ci'));
    const out = writeWindowsSite({ root, from, version: VERSION, downloads: 'https://example.com/engelbart', livePage });
    assert.equal(out, path.join(root, 'release', 'upload-win'));
    assert.deepEqual(fs.readdirSync(out).sort(), ['Engelbart-9.9.9-x64.exe', 'Engelbart-9.9.9-x64.exe.blockmap', 'SHA256SUMS-windows.txt', 'index.html', 'install.ps1', 'latest.yml']);
    const ps1 = fs.readFileSync(path.join(out, 'install.ps1'), 'utf8');
    assert.doesNotMatch(ps1, /__DOWNLOADS__/);
    assert.match(ps1, /else \{ 'https:\/\/example\.com\/engelbart\/' \}/);
    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(page.startsWith(livePage.slice(0, livePage.indexOf('</main>'))), 'the Mac part of the page is kept');
    assert.match(page, /irm https:\/\/example\.com\/engelbart\/install\.ps1 \| iex/);
    assert.match(page, /Version 9\.9\.9 · for 64-bit Windows/);
    // A later Windows release replaces the section, not adds another.
    const again = writeWindowsSite({ root, from, version: VERSION, downloads: DOWNLOADS, livePage: page });
    assert.equal(fs.readFileSync(path.join(again, 'index.html'), 'utf8').match(/<!-- windows -->/g).length, 1);
    const sums = fs.readFileSync(path.join(out, 'SHA256SUMS-windows.txt'), 'utf8').trim().split('\n');
    assert.deepEqual(sums.map((line) => line.split('  ')[1]), ['Engelbart-9.9.9-x64.exe', 'install.ps1']);
    assert.equal(sums[0].split('  ')[0], crypto.createHash('sha256').update(fs.readFileSync(path.join(from, 'Engelbart-9.9.9-x64.exe'))).digest('hex'));
    // CI's install test gives no page: then there is none.
    assert.ok(!fs.existsSync(path.join(writeWindowsSite({ root, from, version: VERSION, downloads: DOWNLOADS }), 'index.html')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-site: a Windows release for another version, or whose installer does not match latest.yml, is refused', async () => {
  const { writeWindowsSite } = await site();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-site-'));
  try {
    assert.throws(() => writeWindowsSite({ root: ROOT, from: ciFolder(path.join(root, 'a'), { version: '9.9.8' }), version: VERSION, downloads: DOWNLOADS, out: path.join(root, 'out') }), /latest\.yml is for 9\.9\.8, not 9\.9\.9/);
    assert.throws(() => writeWindowsSite({ root: ROOT, from: ciFolder(path.join(root, 'b'), { sha512: 'bad' }), version: VERSION, downloads: DOWNLOADS, out: path.join(root, 'out') }), /does not match the sha512/);
    assert.throws(() => writeWindowsSite({ root: ROOT, from: ciFolder(path.join(root, 'c'), { size: 1 }), version: VERSION, downloads: DOWNLOADS, out: path.join(root, 'out') }), /as 1 bytes, not 4096/);
    assert.ok(!fs.existsSync(path.join(root, 'out')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('release-site: liveWindows reads the live latest.yml for the Mac page, and is null when there is none or it cannot be read', async () => {
  const { liveWindows, parseFeed } = await site();
  const feed = fs.readFileSync(path.join(ciFolder(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-feed-'))), 'latest.yml'), 'utf8');
  assert.equal(parseFeed(feed).version, VERSION);
  const asked = [];
  const answer = (status, text) => async (url) => { asked.push(url); return { ok: status === 200, text: async () => text }; };
  assert.deepEqual(await liveWindows(DOWNLOADS, answer(200, feed)), { version: VERSION, installer: 'Engelbart-9.9.9-x64.exe', size: 4096 });
  assert.match(asked[0], /^https:\/\/example\.com\/engelbart\/latest\.yml\?nc=\d+$/);
  assert.equal(await liveWindows(DOWNLOADS, answer(404, 'no')), null);
  assert.equal(await liveWindows(DOWNLOADS, answer(200, 'version: 1.0.0\nfiles:\n  - url: Engelbart-1.0.0-arm64.zip\n')), null);
  assert.equal(await liveWindows(DOWNLOADS, async () => { throw new Error('offline'); }), null);
});

test('install-windows.ps1: plain ASCII, the download folder left for the release to write in, and no exit (it runs under iex)', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(text, /^[\x09\x0a\x0d\x20-\x7e]*$/);
  assert.match(text, /'__DOWNLOADS__'/);
  assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /(^|[;{])\s*exit\b/m);
  for (const name of ['ENGELBART_DOWNLOADS', 'ENGELBART_FORCE', 'ENGELBART_NO_OPEN']) assert.match(text, new RegExp(`\\$env:${name}`));
  assert.match(text, /winget\.exe install --id Git\.Git -e/);
});

/** `irm <server>/install.ps1 | iex` in Windows PowerShell, reading from `site`. → { code, out } */
function runInstall(downloads, served) {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${served}install.ps1 | iex; exit $LASTEXITCODE`], {
      env: { ...process.env, ENGELBART_DOWNLOADS: downloads, ENGELBART_NO_OPEN: '1' }, timeout: 120000, windowsHide: true,
    }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: `${stdout}${stderr}` }));
  });
}

test('install-windows.ps1: a download that does not match its checksum is not installed, and an unreachable folder is one line', { skip: process.platform !== 'win32' && 'runs the install command in Windows PowerShell' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-ps1-'));
  const folder = ciFolder(path.join(dir, 'site'), { sha512: crypto.createHash('sha512').update('something else').digest('base64') });
  fs.copyFileSync(SCRIPT, path.join(folder, 'install.ps1'));
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const file = path.join(folder, decodeURIComponent(req.url.split('?')[0]).slice(1));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': file.endsWith('.yml') ? 'text/yaml' : file.endsWith('.ps1') ? 'text/plain' : 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const served = `http://127.0.0.1:${server.address().port}/`;
  try {
    const bad = await runInstall(served, served);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /Engelbart was not installed: the download does not match its checksum; run the command again\./);
    assert.ok(asked.some((url) => /^\/latest\.yml\?t=\d+$/.test(url)), asked.join(' '));
    assert.ok(asked.includes('/Engelbart-9.9.9-x64.exe'), asked.join(' '));

    const offline = await runInstall('http://127.0.0.1:9/engelbart/', served); // port 9 (discard): nothing listens
    assert.equal(offline.code, 1, offline.out);
    assert.match(offline.out, /Engelbart was not installed: could not reach http:\/\/127\.0\.0\.1:9\/engelbart\/ \(is this PC online\?\)\./);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
