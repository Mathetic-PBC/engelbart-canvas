'use strict';

// Login shells in a session of their own (2026-10-19, David's hand test on Ubuntu, the AppImage started from a
// terminal): Engelbart showed as "Stopped" each time it was started. `bash -i` opens the terminal Engelbart was started
// from and takes it over for its job control; a second one at once found the terminal not its process group's and sent
// SIGTTIN to that group, Engelbart's. Run here inside a real terminal (util-linux `script`), four checks at once
// through the tool runner (src/main/tools/run.cjs) must finish. Linux only: macOS's bash 3.2 did not stop it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const has = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } };
const RUN = path.join(__dirname, '..', 'src', 'main', 'tools', 'run.cjs');

/** Four login-shell checks at once in a terminal; `detached` the runner's setting. → 'finished' or 'stopped'. */
function inTerminal(detached) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-session-'));
  const script = `const { createRunner } = require(${JSON.stringify(RUN)});
const runner = createRunner({ environment: { SHELL: '/bin/bash', HOME: ${JSON.stringify(home)}, PATH: '/usr/bin:/bin' }, detached: ${detached} });
Promise.all([0, 1, 2, 3].map((i) => new Promise((resolve) => setTimeout(resolve, i * 40)).then(() => runner.shell('sleep 0.3; echo ok'))))
  .then((outs) => { console.log(outs.every((out) => out.stdout.trim() === 'ok') ? 'FINISHED' : 'WRONG'); process.exit(0); });`;
  const file = path.join(home, 'four.cjs');
  fs.writeFileSync(file, script);
  return new Promise((resolve) => {
    execFile('script', ['-qec', `${process.execPath} ${file}`, '/dev/null'], { timeout: 15_000, killSignal: 'SIGKILL' }, (error, stdout) => {
      resolve(/FINISHED/.test(String(stdout)) ? 'finished' : error && error.killed ? 'stopped' : `other: ${String(stdout).slice(-200)}`);
    });
  });
}

test('four login-shell checks at once, started from a terminal, finish: each shell has its own session (2026-10-19)', { skip: (process.platform !== 'linux' || !has('/bin/bash') || !has('/usr/bin/script')) && 'Linux with bash and util-linux script' }, async (t) => {
  const before = await inTerminal(false);
  t.diagnostic(`without their own session: ${before}`); // what the AppImage did before; not asserted
  assert.equal(await inTerminal(true), 'finished');
});
