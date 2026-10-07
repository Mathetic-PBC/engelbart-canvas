'use strict';

// node scripts/smoke-windows.cjs [path/to/Engelbart.exe]          (default: release/win-unpacked/Engelbart.exe)
// The packaged Windows app, started (2026-10-05, docs/windows-port.md; CI runs it after building the installer). The app
// runs hidden (ENGELBART_HEADLESS) on a throwaway home and user data, and is driven through Chromium's DevTools
// protocol, as nothing of the smoke test is inside it. It passes only when all of this happens:
//   1. the window loads (the renderer's API is there and the app has drawn);
//   2. a terminal session starts (PowerShell, through node-pty's Windows modules) and echoes a line back;
//   3. the tool check, a POSIX script run through Git for Windows' bash (src/main/tools/detect.cjs lookupCommand),
//      prints what it found: Git, at a Windows path;
//   4. the app quits cleanly when its window closes, with exit code 0.
// On a Mac it runs the same against a packaged Engelbart.app's executable (zsh in place of PowerShell and Git Bash).
// On Linux (scripts/smoke-linux.cjs, under xvfb) against the app's launcher, engelbart-launch (bash; the system's Git),
// and it also says whether Chromium's sandbox is on: SMOKE_SANDBOX=on or off fails it when it is not that.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const linux = process.platform === 'linux';
const NAME = linux ? 'smoke-linux' : 'smoke-windows';
const app = path.resolve(process.argv[2] || (linux ? path.join(ROOT, 'release', 'linux-unpacked', 'engelbart-launch') : path.join(ROOT, 'release', 'win-unpacked', 'Engelbart.exe')));
const LINE = `engelbart-smoke-${process.pid}`;
const STEP_MS = 90_000;

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function until(fn, label, ms = STEP_MS) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    const result = await fn().catch(() => null);
    if (result) return result;
    await pause(250);
  }
  throw new Error(`Timed out: ${label}`);
}

/** One DevTools connection (a page's WebSocket): send(method, params) → its result. */
function devtools(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const waiting = new Map();
    let next = 1;
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      const entry = message.id && waiting.get(message.id);
      if (!entry) return;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
    };
    socket.onerror = () => reject(new Error(`No DevTools connection at ${url}`));
    socket.onopen = () => resolve({
      send: (method, params = {}) => new Promise((done, fail) => { const id = next++; waiting.set(id, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id, method, params })); }),
      close: () => { try { socket.close(); } catch { /* closed */ } },
    });
  });
}

/** `expression` evaluated in the page, awaited (for at most `ms`). → its value */
async function evaluate(page, expression, ms = STEP_MS) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s from: ${expression.slice(0, 120)}`)), ms); });
  const { result, exceptionDetails } = await Promise.race([page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), late]).finally(() => clearTimeout(timer));
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}

async function main() {
  process.exitCode = 1; // until every step has passed: Node ends with it if something is left waiting on nothing
  if (!fs.existsSync(app)) throw new Error(`No app at ${app}: build it first (${linux ? 'npm run dist:linux' : 'npm run dist:win'}).`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-smoke-'));
  const home = path.join(folder, 'home');
  const userData = path.join(folder, 'user-data');
  const work = path.join(folder, 'work');
  for (const dir of [home, userData, work]) fs.mkdirSync(dir, { recursive: true });
  let child = null;
  let output = '';
  try {
    child = spawn(app, ['--remote-debugging-port=0', `--user-data-dir=${userData}`], {
      env: {
        ...process.env,
        ENGELBART_HOME_DIR: home, ENGELBART_ROOT_DIR: path.join(home, '.engelbart'), ENGELBART_HEADLESS: '1',
        ENGELBART_TOOLS: 'off', ENGELBART_SUMMARIES: 'off', ENGELBART_SANDBOXES: 'off', ENGELBART_WEB_PDFS: 'off', ENGELBART_UPDATES: 'off', ENGELBART_RUN_STEP: 'off',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
    console.log(`Starting ${app}`);
    // The port Chromium chose: printed, and written to DevToolsActivePort in the user data (a Windows app's printing can be lost).
    const activePort = () => { try { return fs.readFileSync(path.join(userData, 'DevToolsActivePort'), 'utf8').split(/\r?\n/); } catch { return null; } };
    const port = await until(async () => /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(output)?.[1] || activePort()?.[0], 'the app to start (DevTools port)');

    // 1. The window loads.
    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return list.find((entry) => entry.type === 'page' && entry.url.startsWith('engelbart://app/index.html'));
    }, 'the app window');
    const page = await devtools(target.webSocketDebuggerUrl);
    console.log(`DevTools on port ${port}`);
    if (linux) { // the launcher execs the app in its own place: its arguments say whether the sandbox is off, and why
      const args = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8').split('\0');
      const sandbox = args.includes('--no-sandbox') ? 'off' : 'on';
      const why = /starting without Chromium's sandbox: ([^\n]*)/.exec(output)?.[1];
      console.log(`ok: Chromium's sandbox is ${sandbox}${why ? ` (${why})` : ''}`);
      if (process.env.SMOKE_SANDBOX && process.env.SMOKE_SANDBOX !== sandbox) throw new Error(`Chromium's sandbox is ${sandbox}, not ${process.env.SMOKE_SANDBOX}.`);
    }
    await until(() => evaluate(page, '!!window.engelbartAPI && !!window.terminalAPI && !!document.querySelector("button")'), 'the window to load');
    console.log('ok: the window loaded');
    if (!fs.readdirSync(userData).length) throw new Error(`The app is not using the throwaway user data (${userData}).`);

    // 2. A terminal session echoes a line back.
    const session = await evaluate(page, `(async () => {
      window.__smoke = '';
      await terminalAPI.bootstrap(); // the window's terminal attached, as its pane does: output then comes to it
      terminalAPI.onData((payload) => { window.__smoke += JSON.stringify(payload); });
      return terminalAPI.createSession({ provider: 'shell', cwd: ${JSON.stringify(work)}, cols: 120, rows: 30 });
    })()`);
    console.log(`ok: a terminal session started (${session.shell})`);
    await pause(1500); // the shell's own start
    await evaluate(page, `terminalAPI.writeSession(${JSON.stringify(session.id)}, ${JSON.stringify(`echo ${LINE}-echo\r`)})`);
    await until(() => evaluate(page, `window.__smoke.split(${JSON.stringify(`${LINE}-echo`)}).length > 2`), 'the terminal to echo the line back (typed, then printed)');
    console.log('ok: the terminal echoed a line back');
    await evaluate(page, `terminalAPI.closeSession(${JSON.stringify(session.id)})`);

    // 3. A POSIX script through the login shell (Git for Windows' bash on Windows) prints its output: the tool check.
    const checked = await evaluate(page, 'engelbartAPI.toolsCheck()');
    const git = checked && checked.tools && checked.tools.git;
    if (!git || git.status !== 'ready' || !git.path) throw new Error(`The tool check found no Git through the login shell: ${JSON.stringify(git)}`);
    if (process.platform === 'win32' && !/^[a-z]:\\/i.test(git.path)) throw new Error(`The tool check printed Git at ${git.path}, not a Windows path.`);
    console.log(`ok: the login shell's script found Git ${git.version} at ${git.path}`);

    // 4. The app quits cleanly when its window closes (on a Mac, where an app outlives its windows, when it is told to).
    await page.send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {});
    page.close();
    if (process.platform === 'darwin') {
      const browser = await devtools(/DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1] || `ws://127.0.0.1:${port}${activePort()[1]}`);
      await Promise.race([browser.send('Browser.close').catch(() => {}), exited, pause(5000)]);
      browser.close();
    }
    const { code, signal } = await Promise.race([exited, pause(STEP_MS).then(() => ({ code: null, signal: 'timeout' }))]);
    if (code !== 0) throw new Error(`The app did not quit cleanly (exit code ${code}${signal ? `, ${signal}` : ''}).`);
    child = null;
    console.log('ok: the app quit cleanly');
    process.exitCode = 0;
  } catch (error) {
    console.error(`\n${NAME} failed: ${error.message}\n\nThe app printed:\n${output}`);
    process.exitCode = 1;
  } finally {
    if (child) child.kill();
    await pause(1000);
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* left for the system to clear */ }
  }
}

main();
