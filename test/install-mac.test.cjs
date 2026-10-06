'use strict';

// The install command (scripts/install-mac.sh) as the app runs it to update itself (MATH-43, 2026-10-05): once the new
// version is ready it waits for the app for as long as the app stays open (Later in the app means the next quit, hours
// away), then installs it. It runs for real, against a download folder served here (latest-mac.yml and a zip holding an
// ad hoc-signed stand-in Engelbart.app), installing into a temporary folder. `sleep` is a stub that returns at once and
// counts its calls, so the old limit (1800 one-second waits) goes by in seconds; `open` is a stub that writes down what
// it was asked to open. It opens the new version only when the app left the reopen file (Restart to Update), and takes
// that file; a plain quit after Later opens nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../scripts/install-mac.sh');
const OLD_LIMIT = 1800; // seconds the command used to wait for the app before giving up
const VERSION = '0.2.0';

/** Resolves once `check()` is true; rejects after `ms`. */
async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A download folder as the release script makes it: the zip for each kind of Mac and the feed naming them. */
function downloadFolder(dir) {
  const app = path.join(dir, 'build', 'Engelbart.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents', 'MacOS', 'Engelbart'));
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Engelbart</string>
<key>CFBundleIdentifier</key><string>com.example.engelbart-install-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
</dict></plist>
`);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  const site = path.join(dir, 'site');
  fs.mkdirSync(site);
  const zip = path.join(site, `Engelbart-${VERSION}-arm64.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, zip]);
  fs.copyFileSync(zip, path.join(site, `Engelbart-${VERSION}-x64.zip`));
  const bytes = fs.readFileSync(zip);
  const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
  const files = ['arm64', 'x64'].map((arch) => `  - url: Engelbart-${VERSION}-${arch}.zip\n    sha512: ${sha512}\n    size: ${bytes.length}\n`).join('');
  fs.writeFileSync(path.join(site, 'latest-mac.yml'), `version: ${VERSION}\nfiles:\n${files}path: Engelbart-${VERSION}-arm64.zip\nsha512: ${sha512}\n`);
  return site;
}

/** The install command, run as the app runs it, for an app (a process that stays until it is told to go) that is open;
 * removed after the test. */
async function installing(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-install-')));
  const site = downloadFolder(dir);
  const server = http.createServer((request, response) => {
    const file = path.join(site, path.basename(decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)));
    if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const stubs = path.join(dir, 'bin');
  const ticks = path.join(dir, 'ticks');
  const opens = path.join(dir, 'opens');
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, 'sleep'), '#!/bin/sh\nprintf . >> "$ENGELBART_TEST_TICKS"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(stubs, 'open'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$ENGELBART_TEST_OPENS"\n', { mode: 0o755 });
  const dest = path.join(dir, 'Applications');
  const ready = path.join(dir, 'update.ready');
  const reopen = path.join(dir, 'update.reopen');

  const engelbart = spawn('/bin/sleep', ['600'], { stdio: 'ignore' });
  const run = { dir, dest, ready, reopen, engelbart, output: '' };
  const install = spawn('/bin/bash', [SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: dir,
      TMPDIR: dir,
      LANG: 'en_US.UTF-8',
      ENGELBART_DOWNLOADS: `http://127.0.0.1:${server.address().port}/`,
      ENGELBART_WAIT_PID: String(engelbart.pid),
      ENGELBART_READY_FILE: ready,
      ENGELBART_REOPEN_FILE: reopen,
      ENGELBART_INSTALL_DIR: dest, // never /Applications; and no ENGELBART_APP_PATH, so a failure opens nothing
      ENGELBART_TEST_TICKS: ticks,
      ENGELBART_TEST_OPENS: opens,
    },
  });
  install.stdout.on('data', (chunk) => { run.output += chunk; });
  install.stderr.on('data', (chunk) => { run.output += chunk; });
  run.install = install;
  run.exited = new Promise((resolve) => install.on('exit', (code) => resolve(code)));
  run.waited = () => (fs.existsSync(ticks) ? fs.statSync(ticks).size : 0);
  run.opened = () => (fs.existsSync(opens) ? fs.readFileSync(opens, 'utf8').split('\n').filter(Boolean) : []);
  t.after(() => {
    engelbart.kill();
    install.kill();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await until(() => fs.existsSync(ready) || install.exitCode !== null, 30_000, 'the ready file');
  assert.ok(fs.existsSync(ready), run.output);
  assert.match(run.output, new RegExp(`Ready; Engelbart ${VERSION.replace(/\./g, '\\.')} is installed when Engelbart quits\\.`));
  return run;
}

const skip = process.platform !== 'darwin' && 'macOS only';

test('install-mac.sh, run by the app: once ready it waits for the app past the old 30-minute limit, then installs when the app quits, opening nothing after Later', { skip, timeout: 120_000 }, async (t) => {
  const run = await installing(t);
  await until(() => run.waited() > OLD_LIMIT + 100 || run.install.exitCode !== null, 90_000, `${OLD_LIMIT} seconds of waiting`);
  assert.equal(run.install.exitCode, null, `still waiting after ${run.waited()} seconds:\n${run.output}`);
  assert.doesNotMatch(run.output, /not installed|did not quit/);
  assert.equal(fs.existsSync(path.join(run.dest, 'Engelbart.app')), false, 'nothing is replaced while the app is open');

  run.engelbart.kill(); // a plain quit: no reopen file
  assert.equal(await run.exited, 0, run.output);
  assert.match(run.output, new RegExp(`Engelbart ${VERSION.replace(/\./g, '\\.')} is installed in `));
  assert.ok(fs.existsSync(path.join(run.dest, 'Engelbart.app', 'Contents', 'Info.plist')));
  assert.deepEqual(run.opened(), [], 'not opened');
});

test('install-mac.sh, run by the app: after Restart to Update (the reopen file) it opens the new version once, and removes the file', { skip, timeout: 120_000 }, async (t) => {
  const run = await installing(t);
  fs.writeFileSync(run.reopen, ''); // the app, as it quits for Restart to Update
  run.engelbart.kill();
  assert.equal(await run.exited, 0, run.output);
  assert.ok(fs.existsSync(path.join(run.dest, 'Engelbart.app', 'Contents', 'Info.plist')));
  assert.deepEqual(run.opened(), [path.join(run.dest, 'Engelbart.app')], 'opened once');
  assert.equal(fs.existsSync(run.reopen), false, 'taken');
});
