'use strict';

// Engelbart on Windows (2026-10-05, docs/windows-port.md). The first tests run everywhere: each is given the platform
// and, where it looks at the disk, what is there. The last ones run on Windows alone, against its real Git for Windows,
// PowerShell and node-pty (they are not registered elsewhere, so a Mac's run is as it was).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createLaunchSpec, findGitBash, loginShellArgs, resolvePowerShell, resolveShell, sanitizeEnvironment, GIT_BASH_MISSING } = require('../src/main/terminal/launch.cjs');
const { environmentForSessions } = require('../src/main/shell-rc.cjs');
const { knownPlaces, lookupCommand, parseLookup, sourceOf } = require('../src/main/tools/detect.cjs');
const { createActions, markRollback, rollback, rollbackPoint } = require('../src/main/tools/install.cjs');
const { createProcesses, freePort, groupPids, killTree, stopLeftover } = require('../src/main/build/run-processes.cjs');
const { assertAppModules } = require('../scripts/check-app-modules.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-windows-platform-'));
const W = path.win32;

test('Git for Windows\' bash: beside the git on PATH first, then Program Files, then the one-person install; else where it would be', () => {
  const env = { Path: 'C:\\Windows\\system32;"D:\\Tools\\Git\\cmd"', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\h\\AppData\\Local' };
  const there = (...files) => (file) => files.includes(file);
  assert.equal(findGitBash(env, { exists: there('D:\\Tools\\Git\\cmd\\git.exe', 'D:\\Tools\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe') }), 'D:\\Tools\\Git\\bin\\bash.exe', 'the git on PATH names its own');
  assert.equal(findGitBash(env, { exists: there('C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Users\\h\\AppData\\Local\\Programs\\Git\\bin\\bash.exe') }), 'C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(findGitBash({ ...env, PATH: undefined }, { exists: there('C:\\Users\\h\\AppData\\Local\\Programs\\Git\\bin\\bash.exe') }), 'C:\\Users\\h\\AppData\\Local\\Programs\\Git\\bin\\bash.exe', 'installed for one person');
  assert.equal(findGitBash(env, { exists: () => false }), null);
  // Not installed: Engelbart still starts; a command fails as not found, and says where to get Git for Windows.
  assert.equal(resolveShell({ ProgramFiles: 'E:\\Programs' }, 'win32'), 'E:\\Programs\\Git\\bin\\bash.exe');
  assert.match(GIT_BASH_MISSING, /https:\/\/git-scm\.com\/download\/win/);
});

test('a terminal on Windows opens PowerShell: pwsh when it is on PATH, else Windows PowerShell; Claude Code and Codex run in it and it stays open', () => {
  assert.equal(resolvePowerShell({ PATH: 'C:\\a;C:\\Program Files\\PowerShell\\7' }, { exists: (file) => file === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }), 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(resolvePowerShell({ SystemRoot: 'C:\\WINDOWS' }, { exists: () => false }), 'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  const cwd = temp();
  const environment = { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows', ENGELBART_AGENT_PATH: 'C:\\Users\\h\\.local\\bin', CLAUDECODE: '1' };
  const shell = createLaunchSpec({ provider: 'shell', cwd, cols: 80, rows: 24 }, environment, 'win32');
  assert.match(shell.file, /(pwsh|powershell)\.exe$/i);
  assert.deepEqual(shell.args, ['-NoLogo']);
  assert.equal(shell.env.Path, 'C:\\Windows;C:\\Users\\h\\.local\\bin', 'the agents\' folder last on PATH');
  assert.equal(shell.env.CLAUDECODE, undefined, 'an outer agent\'s variables are left out');
  const claude = createLaunchSpec({ provider: 'claude', cwd, cols: 80, rows: 24 }, environment, 'win32');
  assert.deepEqual(claude.args.slice(0, 3), ['-NoLogo', '-NoExit', '-Command']);
  assert.match(claude.args[3], /^if \(\$env:ENGELBART_CLAUDE_BIN\) \{ & \$env:ENGELBART_CLAUDE_BIN \} else \{ claude \}; Write-Host "`r`n\[Claude Code exited with status \$LASTEXITCODE\]"$/);
  assert.match(createLaunchSpec({ provider: 'codex', cwd, cols: 80, rows: 24 }, environment, 'win32').args[3], /\{ codex \}/);
});

test('a login shell\'s command on Windows: the folders added to PATH are turned into bash\'s own with cygpath', () => {
  const env = { ENGELBART_AGENT_PATH: 'C:\\a;C:\\b', ENGELBART_GIT_BIN: 'C:\\git' };
  assert.deepEqual(loginShellArgs('C:\\Program Files\\Git\\bin\\bash.exe', 'codex', env, 'win32'), ['-ilc', 'PATH="$(cygpath -p "$ENGELBART_GIT_BIN"):$PATH"; PATH="$PATH:$(cygpath -p "$ENGELBART_AGENT_PATH")"; codex']);
  assert.deepEqual(loginShellArgs('C:\\Program Files\\Git\\bin\\bash.exe', 'codex', {}, 'win32'), ['-ilc', 'codex']);
  assert.deepEqual(loginShellArgs('/bin/zsh', 'codex', { ENGELBART_AGENT_PATH: '/a:/b' }, 'darwin'), ['-ilc', 'PATH="$PATH:$ENGELBART_AGENT_PATH"; codex'], 'a Mac as before');
});

test('the terminal\'s environment on Windows has no zsh launcher: PowerShell starts as it is', () => {
  const userData = temp();
  const environment = environmentForSessions({ SHELL: 'C:\\x', CLAUDE_CODE_SESSION_ID: 'outer', Path: 'C:\\Windows' }, userData, 'win32');
  assert.deepEqual(environment, { SHELL: 'C:\\x', Path: 'C:\\Windows' });
  assert.equal(fs.existsSync(path.join(userData, 'shell')), false);
});

test('tools on Windows: the lookup prints Windows paths, the installers\' folders are Windows ones, Claude Code\'s own install is native', () => {
  const command = lookupCommand(false, 'win32');
  assert.match(command, /type -aP "\$tool"/);
  assert.match(command, /cygpath -w "\$found"/);
  assert.match(command, /\[ -f "\$found\.exe" \] && found="\$found\.exe"/);
  assert.deepEqual(parseLookup('@tool git\nC:\\Program Files\\Git\\mingw64\\bin\\git.exe\n@tool claude\n@tool codex\nC:\\Users\\h\\AppData\\Roaming\\npm\\codex\n@env DISABLE_AUTOUPDATER=\n').paths, { git: ['C:\\Program Files\\Git\\mingw64\\bin\\git.exe'], claude: [], codex: ['C:\\Users\\h\\AppData\\Roaming\\npm\\codex'] });
  const places = knownPlaces('claude', 'C:\\Users\\h', undefined, { platform: 'win32', env: { APPDATA: 'C:\\Users\\h\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\h\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } });
  assert.deepEqual(places, ['C:\\Users\\h\\.local\\bin\\claude.exe', 'C:\\Users\\h\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\h\\AppData\\Local\\Programs\\claude\\claude.exe', 'C:\\Program Files\\nodejs\\claude']);
  assert.deepEqual(knownPlaces('git', 'C:\\Users\\h', undefined, { platform: 'win32' }), []);
  assert.equal(sourceOf('claude', 'C:\\Users\\h\\.local\\bin\\claude.exe'), 'native');
});

/** A runner (src/main/tools/run.cjs) that records what it was asked and answers `code`. */
function recordingRunner(code = 0) {
  const asked = [];
  return {
    asked,
    exec: async (file, args) => { asked.push(['exec', file, ...args]); return { code, stdout: '', stderr: '', timedOut: false, missing: false }; },
    shell: async (command) => { asked.push(['shell', command]); return { code, stdout: '', stderr: '', timedOut: false, marked: true }; },
  };
}

test('installing on Windows: Claude Code with its PowerShell installer, Codex with npm; nothing of Apple\'s or Homebrew\'s', async () => {
  const runner = recordingRunner();
  const actions = createActions({ runner, home: temp(), tmpDir: temp(), platform: 'win32', environment: { SystemRoot: 'C:\\Windows' } });
  assert.deepEqual(await actions.installAgent('claude'), { ok: true });
  assert.deepEqual(runner.asked[0], ['exec', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex']);
  assert.deepEqual(await actions.installAgent('codex'), { ok: true });
  assert.deepEqual(runner.asked[1], ['shell', 'npm install -g @openai/codex < /dev/null 2>&1']);
  const git = await actions.installGit();
  assert.equal(git.ok, false);
  assert.match(git.error, /Git for Windows from https:\/\/git-scm\.com\/download\/win/);
  assert.match((await actions.updateGit('other')).error, /git update-git-for-windows/);
  assert.equal(runner.asked.length, 2, 'no xcode-select, no brew');
  const failed = createActions({ runner: recordingRunner(1), home: temp(), tmpDir: temp(), platform: 'win32', environment: {} });
  assert.equal((await failed.installAgent('claude')).ok, false);
});

test('a rollback on Windows copies Claude Code back, as there is no symlink to point; npm\'s Codex has none', () => {
  const home = temp();
  const file = rollbackPoint('claude', { home, platform: 'win32' });
  assert.equal(file, path.join(home, '.local', 'bin', 'claude.exe'));
  assert.equal(rollbackPoint('codex', { home, platform: 'win32' }), null);
  assert.equal(markRollback('claude', { home, platform: 'win32' }), null, 'nothing installed: nothing to keep');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'version 1');
  const mark = markRollback('claude', { home, platform: 'win32' });
  fs.writeFileSync(file, 'version 2, broken');
  assert.equal(rollback(mark), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'version 1');
  assert.equal(fs.existsSync(`${file}.engelbart-rollback`), false);
});

test('processes on Windows: stopped with their tree (each descendant named) by taskkill, once; no ps or lsof', async () => {
  const ran = [];
  // 4242 started 5000, which started 5001; 6000 is another's. A pid that is its own parent (the idle process) is skipped.
  const listing = '4242 100\r\n5000 4242\r\n5001 5000\r\n6000 100\r\n0 0\r\n';
  const run = (file, args, options, done) => { ran.push([file, ...args]); setImmediate(() => done(null, file === 'powershell.exe' ? listing : '')); return {}; };
  await killTree(4242, { run });
  assert.equal(ran[0][0], 'powershell.exe');
  assert.deepEqual(ran.slice(1), [['taskkill', '/T', '/F', '/PID', '4242', '/PID', '5000', '/PID', '5001']]);
  ran.length = 0;
  assert.deepEqual(await groupPids(4242, { run, platform: 'win32' }), []);
  assert.equal(await stopLeftover(4242, temp(), { run, platform: 'win32' }), false);
  assert.equal(ran.length, 0, 'neither ps nor lsof ran');

  // Git Bash started npm: its exec left npm's bash a Windows process whose parent has gone (9256). Git Bash's ps knows it.
  ran.length = 0;
  const windowsParents = '7048 7700\r\n4392 7048\r\n3532 9256\r\n2136 3532\r\n5572 2136\r\n7532 5572\r\n7180 7532\r\n9999 1\r\n';
  const gitBashPs = [
    '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
    '      100       1     100       4392  ?         197108 05:20:01 /usr/bin/bash',
    '      101     100     100       3532  ?         197108 05:20:02 /usr/bin/bash',
    'I     102     101     100       2136  ?         197108 05:20:02 /usr/bin/bash',
    '      200       1     200       9999  ?         197108 05:20:02 /usr/bin/bash',
  ].join('\r\n');
  const both = (file, args, options, done) => { ran.push([file, ...args]); setImmediate(() => done(null, file === 'powershell.exe' ? windowsParents : file.endsWith('ps.exe') ? gitBashPs : '')); return {}; };
  await killTree(7048, { run: both, shell: 'C:\\Program Files\\Git\\bin\\bash.exe' });
  assert.ok(ran.some(([file, ...args]) => file === 'C:\\Program Files\\Git\\usr\\bin\\ps.exe' && args.join(' ') === '-e'), JSON.stringify(ran));
  const killed = ran.find(([file]) => file === 'taskkill').slice(1);
  assert.deepEqual(killed.slice(0, 2), ['/T', '/F']);
  assert.deepEqual(killed.filter((arg, i) => killed[i - 1] === '/PID').map(Number).sort((x, y) => x - y), [2136, 3532, 4392, 5572, 7048, 7180, 7532], 'npm\'s chain and its server; not 9999');

  // No listing (PowerShell failed): the pid alone, with /T.
  ran.length = 0;
  const failing = (file, args, options, done) => { ran.push([file, ...args]); setImmediate(() => done(file === 'powershell.exe' ? new Error('no') : null, '')); return {}; };
  await killTree(4242, { run: failing });
  assert.deepEqual(ran.slice(1), [['taskkill', '/T', '/F', '/PID', '4242']]);

  // A started process: stop() asks taskkill for its tree, then waits for it to exit.
  ran.length = 0;
  const { EventEmitter } = require('node:events');
  const child = Object.assign(new EventEmitter(), { pid: 777, stdout: null, stderr: null, kill: () => assert.fail('no signal on Windows') });
  const killer = (file, args, options, done) => { ran.push([file, ...args]); setImmediate(() => { if (file === 'taskkill') child.emit('exit', 1, null); done(null, ''); }); return {}; };
  const processes = createProcesses({ environment: { ProgramFiles: 'C:\\Program Files' }, platform: 'win32', run: killer, spawnProcess: (file, args, options) => { assert.equal(options.windowsHide, true); return child; } });
  await processes.start('web', 'npm start', temp());
  assert.equal(await processes.stop('web'), true);
  assert.deepEqual(ran.filter(([file]) => file === 'taskkill'), [['taskkill', '/T', '/F', '/PID', '777']]);
});

test('an app packed for Windows keeps app.asar in resources/: the package check reads it there', async () => {
  const asar = require(require.resolve('@electron/asar', { paths: [path.dirname(require.resolve('app-builder-lib'))] }));
  const dir = temp();
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'node_modules', 'e2b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ dependencies: { e2b: '1' } }));
  fs.writeFileSync(path.join(src, 'node_modules', 'e2b', 'package.json'), JSON.stringify({}));
  const app = path.join(dir, 'win-unpacked');
  fs.mkdirSync(path.join(app, 'resources'), { recursive: true });
  await asar.createPackage(src, path.join(app, 'resources', 'app.asar'));
  assert.equal(assertAppModules(app), 1);
});

if (process.platform === 'win32') {
  const run = promisify(execFile);

  test('Windows: Git for Windows\' bash is found and runs a POSIX script as a login shell, with the agents\' folders on its PATH', async () => {
    const bash = findGitBash(process.env);
    assert.ok(bash, 'Git for Windows is installed on this machine');
    assert.equal(resolveShell(process.env), bash);
    const folder = temp();
    const env = { ...sanitizeEnvironment(process.env), ENGELBART_AGENT_PATH: folder };
    const { stdout } = await run(bash, loginShellArgs(bash, 'printf "posix:%s\\n" "$(uname -s | cut -c1-5)"; for dir in $(echo "$PATH" | tr ":" " "); do cygpath -w "$dir"; done', env), { env, windowsHide: true });
    assert.match(stdout, /posix:(MINGW|MSYS_)/);
    assert.ok(stdout.split(/\r?\n/).map((line) => line.trim().toLowerCase()).includes(folder.toLowerCase()), stdout);
  });

  /** Whether something answers at `url` within two seconds. */
  const answers = async (url) => { try { await fetch(url, { signal: AbortSignal.timeout(2000) }); return true; } catch { return false; } };
  /** Every process now: pid, parent pid, name and command line (PowerShell's CIM, as tasklist has no parents). */
  const tree = async () => {
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }'], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      return stdout.split(/\r?\n/).filter(Boolean).map((line) => { const [pid, parent, ...rest] = line.split(' '); return { pid: Number(pid), parent: Number(parent), text: rest.join(' ').slice(0, 160) }; });
    } catch (error) { return [{ pid: 0, parent: 0, text: error.message }]; }
  };
  /** Git Bash's own process table (its ps: pid, parent, group, Windows pid), as the stop reads it. */
  const bashTable = async () => {
    try { return (await run(path.win32.join(path.win32.dirname(resolveShell(process.env)), '..', 'usr', 'bin', 'ps.exe'), ['-e'], { windowsHide: true })).stdout; } catch (error) { return `ps failed: ${error.message}`; }
  };
  const below = (all, root) => { const out = all.filter((item) => item.pid === root); for (let i = 0; i < out.length; i += 1) out.push(...all.filter((item) => item.parent === out[i].pid && !out.includes(item))); return out; };

  test('Windows: a dev server started through Git Bash (as a Build\'s run step starts one) answers, and stop() takes its whole tree down', async () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { start: 'node server.cjs' } }));
    fs.writeFileSync(path.join(root, 'server.cjs'), "require('node:http').createServer((q, r) => r.end('hello')).listen(Number(process.env.PORT), 'localhost');\n");
    const processes = createProcesses({ environment: process.env, appAliveMs: 400, uiReadyMs: 60_000 });
    for (const command of ['PORT={port} node server.cjs', 'PORT={port} npm start']) {
      const port = await freePort();
      await processes.start('web', command.replace('{port}', port), root);
      const web = await processes.check('web', 'ui', { port });
      assert.equal(web.ok, true, `${command}: ${JSON.stringify(web)}`);
      const before = below(await tree(), processes.status('web').pid);
      const table = await bashTable();
      assert.equal(await processes.stop('web'), true);
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      const after = await tree();
      const left = before.filter((item) => after.some((now) => now.pid === item.pid));
      const named = (list) => list.map((item) => `${item.pid} (parent ${item.parent}) ${item.text}`).join('\n');
      assert.equal(await answers(`http://localhost:${port}/`), false, `${command}: still answering after stop.\nIts tree before:\n${named(before)}\nStill there:\n${named(left)}\nNode processes now:\n${named(after.filter((item) => /node|bash|cmd/i.test(item.text)))}\nGit Bash's ps before:\n${table}`);
    }
  });

  test('Windows: a terminal session is PowerShell in a real PTY (node-pty\'s Windows modules), and echoes a line back', async () => {
    const pty = require('node-pty');
    const cwd = temp();
    const spec = createLaunchSpec({ provider: 'shell', cwd, cols: 100, rows: 30 }, process.env);
    const child = pty.spawn(spec.file, spec.args, { name: 'xterm-256color', cols: spec.cols, rows: spec.rows, cwd: spec.cwd, env: spec.env });
    let output = '';
    child.onData((data) => { output += data; });
    try {
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
      child.write('Write-Output ("engelbart" + "-pty")\r');
      for (const end = Date.now() + 30_000; !output.includes('engelbart-pty') && Date.now() < end;) await new Promise((resolve) => { setTimeout(resolve, 100); });
      assert.match(output, /engelbart-pty/);
    } finally {
      child.kill();
    }
  });
}
