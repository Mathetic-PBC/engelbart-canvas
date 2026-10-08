'use strict';

// Git, Claude Code and Codex: versions, detection, installs, the lock and the manager (2026-09-23).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REQUIREMENTS } = require('../src/main/tools/requirements.cjs');
const { parseVersion, compareVersions, judge } = require('../src/main/tools/version.cjs');
const { parseLookup, sourceOf, observed, detectTools, knownPlaces, AUTH, codexAccount } = require('../src/main/tools/detect.cjs');
const { classifyFailure, roomFor, createActions, markRollback, rollback } = require('../src/main/tools/install.cjs');
const { createLock } = require('../src/main/tools/lock.cjs');
const { createTools } = require('../src/main/tools/manager.cjs');
const { createFakeTools } = require('../src/main/tools/fake.cjs');
const { createSignOutProcess, SIGN_OUT_COMMANDS } = require('../src/main/tools/sign-in.cjs');
const { ensureHome, readConfig, writeTools } = require('../src/main/store/home.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-tools-'));
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('versions are read from what each program prints, and judged against a range', () => {
  assert.equal(parseVersion('git version 2.50.1 (Apple Git-155)', 'git'), '2.50.1');
  assert.equal(parseVersion('2.1.281 (Claude Code)', 'claude'), '2.1.281');
  assert.equal(parseVersion('WARNING: node v18.2.0 is old\ncodex-cli 0.155.1', 'codex'), '0.155.1', 'the program\'s own pattern beats a number in a warning');
  assert.equal(parseVersion('git version 2.39', 'git'), '2.39.0');
  assert.equal(parseVersion('no digits here', 'git'), null);
  assert.equal(parseVersion('10.0.0.1 is an address'), null);
  assert.equal(compareVersions('2.1.278', '2.1.281'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.deepEqual(judge('claude', '2.1.200').status, 'outdated');
  assert.deepEqual(judge('claude', '2.1.278'), { status: 'ready', untested: false, why: null });
  assert.equal(judge('claude', '3.0.0').untested, true, 'a newer major is allowed and marked untested');
  assert.equal(judge('codex', 'nonsense').status, 'unknown');
});

test('a known-bad range makes a version incompatible even above the minimum', () => {
  const requirement = { ...REQUIREMENTS.codex, incompatible: [{ from: '0.156.0', to: '0.156.3', why: 'resume lost the session' }] };
  assert.deepEqual(judge('codex', '0.156.1', requirement), { status: 'incompatible', untested: false, why: 'resume lost the session' });
  assert.equal(judge('codex', '0.156.3', requirement).status, 'ready', 'the end of a range is excluded');
  assert.ok(Object.isFrozen(REQUIREMENTS.codex), 'the shipped table cannot be changed at run time');
});

test('parseLookup lists every program of each name in PATH order, once, and the shell\'s switch', () => {
  const out = parseLookup(['@tool git', '/usr/bin/git', '@tool claude', '/Users/h/.claude-vault/bin/claude', '/Users/h/.local/bin/claude', '/Users/h/.local/bin/claude', 'claude: aliased to nope', '@tool codex', '@env DISABLE_AUTOUPDATER=1'].join('\n'));
  assert.deepEqual(out.paths, { git: ['/usr/bin/git'], claude: ['/Users/h/.claude-vault/bin/claude', '/Users/h/.local/bin/claude'], codex: [] });
  assert.deepEqual(out.env, { DISABLE_AUTOUPDATER: '1' });
});

test('sourceOf tells how a program was installed from where its file really is', () => {
  const dir = temp();
  const versions = path.join(dir, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.writeFileSync(path.join(versions, '2.1.281'), '');
  fs.mkdirSync(path.join(dir, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(path.join(versions, '2.1.281'), path.join(dir, '.local', 'bin', 'claude'));
  assert.equal(sourceOf('claude', path.join(dir, '.local', 'bin', 'claude')), 'native');
  assert.equal(sourceOf('codex', '/opt/homebrew/Caskroom/codex/0.155.1/bin/codex'), 'homebrew');
  assert.equal(sourceOf('codex', '/Users/h/.codex/packages/standalone/releases/0.155.1/bin/codex'), 'standalone');
  assert.equal(sourceOf('claude', '/Users/h/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/cli.js'), 'npm');
  assert.equal(sourceOf('git', '/usr/bin/git'), 'apple');
  assert.equal(sourceOf('git', '/opt/homebrew/Cellar/git/2.51.0/bin/git'), 'homebrew');
  if (process.platform === 'win32') assert.ok(knownPlaces('claude', 'C:\\Users\\h').includes('C:\\Users\\h\\.local\\bin\\claude.exe')); // Windows' own places (test/windows-platform.test.cjs)
  else assert.ok(knownPlaces('claude', '/Users/h').includes('/Users/h/.local/bin/claude'));
  assert.deepEqual(knownPlaces('git', '/Users/h'), []);
});

test('observed: missing, broken, outdated, signed out, and a version that could not be read', () => {
  assert.deepEqual([observed('codex', {}).status, observed('codex', {}).installed], ['missing', false]);
  const broken = observed('claude', { file: '/x/claude', ran: false, error: 'Claude Code did not start: exit status 1' });
  assert.deepEqual([broken.status, broken.installed, broken.signedIn], ['failed', true, null]);
  assert.equal(observed('claude', { file: '/x/claude', ran: true, version: '2.1.100', signedIn: true }).status, 'outdated');
  assert.equal(observed('claude', { file: '/x/claude', ran: true, version: '2.1.300', signedIn: false }).status, 'signed-out');
  const unread = observed('codex', { file: '/x/codex', ran: true, version: null, error: 'Could not read the version' });
  assert.deepEqual([unread.status, unread.version], ['ready', null], 'an unreadable version is not called outdated, so it is never updated in a loop');
});

/** A runner that answers from a table: `shell` by command text, `exec` by file. */
function fakeRunner({ lookup = '', shell = {}, exec = {}, fish = false } = {}) {
  const calls = [];
  const answer = (value) => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, missing: false, marked: true, ...(typeof value === 'function' ? value() : value) });
  return {
    fish,
    shellPath: '/bin/zsh',
    calls,
    async shell(command, options = {}) {
      calls.push({ kind: 'shell', command, env: options.env || {} });
      if (command.startsWith('for tool in')) return answer({ stdout: lookup });
      const key = Object.keys(shell).find((part) => command.includes(part) && (!shell[part].tool || shell[part].tool === (options.env || {}).ENGELBART_TOOL));
      return answer(key ? shell[key] : { code: 127, stdout: 'command not found' });
    },
    async exec(file, args) {
      calls.push({ kind: 'exec', file, args });
      const key = [`${file} ${args.join(' ')}`, file].find((candidate) => Object.hasOwn(exec, candidate));
      return answer(key ? exec[key] : { code: 1, missing: true });
    },
  };
}

test('detectTools: never runs Apple\'s git stub without a developer folder (it would open Apple\'s installer)', async () => {
  const home = temp();
  const runner = fakeRunner({ lookup: '@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n@env DISABLE_AUTOUPDATER=\n', exec: { '/usr/bin/xcode-select -p': { code: 2, stderr: 'xcode-select: error: unable to get active developer directory' } } });
  const found = await detectTools({ runner, only: ['git'], home, platform: 'darwin' });
  assert.deepEqual([found.git.status, found.git.installed], ['missing', false]);
  assert.ok(!runner.calls.some((call) => call.kind === 'exec' && call.file === '/usr/bin/git'), 'the stub was not run');
});

test('detectTools: Apple git is read from the developer folder, and an unaccepted Xcode license is reported', async () => {
  const home = temp();
  const developer = path.join(temp(), 'Developer');
  fs.mkdirSync(path.join(developer, 'usr', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(developer, 'usr', 'bin', 'git'), '#!/bin/sh\n', { mode: 0o755 });
  const realGit = path.join(developer, 'usr', 'bin', 'git');
  const base = { '/usr/bin/xcode-select -p': { stdout: `${developer}\n` }, [`${realGit} --version`]: { stdout: 'git version 2.50.1 (Apple Git-155)\n' } };
  const lookup = '@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n';
  const good = await detectTools({ runner: fakeRunner({ lookup, exec: { ...base, '/usr/bin/git --version': { stdout: 'git version 2.50.1' } } }), only: ['git'], home, platform: 'darwin' });
  assert.deepEqual([good.git.status, good.git.version, good.git.source, good.git.path], ['ready', '2.50.1', 'apple', '/usr/bin/git']);
  const license = await detectTools({ runner: fakeRunner({ lookup, exec: { ...base, '/usr/bin/git --version': { code: 69, stderr: 'You have not agreed to the Xcode license agreements.' } } }), only: ['git'], home, platform: 'darwin' });
  assert.equal(license.git.status, 'failed');
  assert.match(license.git.error, /license/);
});

test('detectTools: with no Git of the person\'s own, the one that came with Engelbart stands in, and Apple\'s stub is never run (2026-09-28)', async () => {
  const home = temp();
  const bundled = '/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git';
  const exec = { '/usr/bin/xcode-select -p': { code: 2 }, [`${bundled} --version`]: { stdout: 'git version 2.53.0\n' } };
  const runner = fakeRunner({ lookup: '@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n', exec });
  const found = await detectTools({ runner, only: ['git'], home, bundledGit: bundled, platform: 'darwin' });
  assert.deepEqual([found.git.status, found.git.installed, found.git.source, found.git.path, found.git.version, found.git.onPath], ['ready', true, 'bundled', bundled, '2.53.0', false]);
  assert.ok(!runner.calls.some((call) => call.kind === 'exec' && call.file === '/usr/bin/git'), 'the stub was not run');
});

test('detectTools: on Linux /usr/bin/git is Git itself, read as any other, and xcode-select is never asked (2026-10-07)', async () => {
  const home = temp();
  const runner = fakeRunner({ lookup: '@tool git\n/usr/bin/git\n@tool claude\n@tool codex\n@env DISABLE_AUTOUPDATER=\n', exec: { '/usr/bin/git --version': { stdout: 'git version 2.43.0\n' } } });
  const found = await detectTools({ runner, only: ['git'], home, platform: 'linux' });
  assert.deepEqual([found.git.status, found.git.installed, found.git.path, found.git.version, found.git.onPath, found.git.source], ['ready', true, '/usr/bin/git', '2.43.0', true, 'other']);
  assert.ok(!runner.calls.some((call) => call.kind === 'exec' && /xcode-select/.test(call.file)), 'no xcode-select');
});

test('detectTools: the person\'s own Git is used when it works; Engelbart\'s only when theirs is broken or too old', async () => {
  const home = temp();
  const bundled = '/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git';
  const lookup = '@tool git\n/opt/homebrew/bin/git\n@tool claude\n@tool codex\n';
  const answers = (own) => ({ '/opt/homebrew/bin/git --version': own, [`${bundled} --version`]: { stdout: 'git version 2.53.0' } });
  const theirs = fakeRunner({ lookup, exec: answers({ stdout: 'git version 2.51.0' }) });
  const works = await detectTools({ runner: theirs, only: ['git'], home, bundledGit: bundled });
  assert.deepEqual([works.git.source, works.git.path, works.git.version], ['homebrew', '/opt/homebrew/bin/git', '2.51.0']);
  assert.ok(!theirs.calls.some((call) => call.file === bundled), 'Engelbart\'s is not even asked');
  const old = await detectTools({ runner: fakeRunner({ lookup, exec: answers({ stdout: 'git version 2.20.1' }) }), only: ['git'], home, bundledGit: bundled });
  assert.deepEqual([old.git.status, old.git.source], ['ready', 'bundled'], 'Build needs 2.30');
  const broken = await detectTools({ runner: fakeRunner({ lookup, exec: answers({ code: 1, stderr: 'dyld: Library not loaded' }) }), only: ['git'], home, bundledGit: bundled });
  assert.deepEqual([broken.git.status, broken.git.source], ['ready', 'bundled']);
  const forced = await detectTools({ runner: fakeRunner({ lookup, exec: answers({ stdout: 'git version 2.51.0' }) }), only: ['git'], home, bundledGit: bundled, preferBundledGit: true });
  assert.equal(forced.git.source, 'bundled', 'ENGELBART_GIT=bundled');
  const neither = await detectTools({ runner: fakeRunner({ lookup: '@tool git\n', exec: { [`${bundled} --version`]: { code: 126, stderr: 'bad CPU type in executable' } } }), only: ['git'], home, bundledGit: bundled });
  assert.deepEqual([neither.git.status, neither.git.source], ['failed', 'bundled'], 'the dialog then offers Apple\'s installer through Try again');
  const brokenBoth = await detectTools({ runner: fakeRunner({ lookup, exec: { '/opt/homebrew/bin/git --version': { code: 1 }, [`${bundled} --version`]: { code: 126 } } }), only: ['git'], home, bundledGit: bundled });
  assert.deepEqual([brokenBoth.git.status, brokenBoth.git.path], ['failed', '/opt/homebrew/bin/git'], 'their own is reported when neither runs');
});

test('detectTools: an agent off the login PATH is found where its installer puts it, run by full path, and asked about sign-in', { skip: process.platform === 'win32' && 'macOS install locations (~/.local/bin/claude); Windows\' are tested in test/windows-platform.test.cjs' }, async () => {
  const home = temp();
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const claude = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(claude, '', { mode: 0o755 });
  const runner = fakeRunner({
    lookup: '@tool git\n@tool claude\n@tool codex\n',
    shell: {
      '--version': { tool: claude, stdout: '2.1.281 (Claude Code)\n' },
      'auth status --json': { tool: claude, stdout: '{"loggedIn": false}\n' },
    },
  });
  const found = await detectTools({ runner, only: ['claude', 'codex'], home, systemBins: [] });
  assert.deepEqual([found.claude.status, found.claude.path, found.claude.onPath, found.claude.signedIn, found.claude.version], ['signed-out', claude, false, false, '2.1.281']);
  assert.equal(found.codex.status, 'missing');
});

test('detectTools: Codex signed in with an API key counts as signed out for Engelbart', async () => {
  const home = temp();
  const runner = fakeRunner({
    lookup: '@tool codex\n/opt/homebrew/bin/codex\n',
    shell: { '--version': { stdout: 'codex-cli 0.155.1\n' }, 'login status': { stdout: 'Logged in using an API key - sk-proj-***\n' } },
  });
  const found = await detectTools({ runner, only: ['codex'], home });
  assert.equal(found.codex.status, 'signed-out');
  assert.match(found.codex.error, /API key/);
});

// Who is signed in (2026-10-03): Claude Code's `auth status --json` has `email`; `codex login status` prints only
// "Logged in using ChatGPT", so Codex's is the `email` claim of tokens.id_token in its auth.json.
const jwt = (claims) => ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'c2lnbmF0dXJl'].join('.');

test('Claude Code\'s account is the email in its status JSON; without one, or when the output is not JSON, there is none', () => {
  const read = AUTH.claude.read;
  const status = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'someone@example.com', orgId: 'org-1', orgName: 'someone@example.com\'s Organization', subscriptionType: 'max' };
  assert.deepEqual(read(`${JSON.stringify(status, null, 2)}\n`), { signedIn: true, account: 'someone@example.com' });
  assert.deepEqual(read(`Warning: an update is available\n${JSON.stringify(status)}\n`), { signedIn: true, account: 'someone@example.com' }, 'past a line printed in front of it');
  assert.deepEqual(read('{"loggedIn": true, "authMethod": "console"}'), { signedIn: true, account: null }, 'signed in, no email');
  assert.deepEqual(read('{"loggedIn": true, "email": ""}'), { signedIn: true, account: null });
  assert.deepEqual(read('{"loggedIn": true, "email": {"address": "x"}}'), { signedIn: true, account: null }, 'only a string is an account');
  assert.deepEqual(read('{"loggedIn": false, "email": "someone@example.com"}'), { signedIn: false, account: null }, 'signed out: nobody');
  assert.deepEqual(read('"loggedIn": true, "email": "someone@example.com"'), { signedIn: true, account: null }, 'not JSON: the old reading, and no account');
  assert.deepEqual(read('{"loggedIn": true, "email": "someone@example.com"'), { signedIn: true, account: null }, 'cut off');
  assert.deepEqual(read('error: unknown command \'auth\''), { signedIn: null, account: null });
});

test('Codex\'s account is the email claim of the ID token in its auth.json; a missing file or a malformed token gives none', () => {
  const home = temp();
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome);
  const auth = path.join(codexHome, 'auth.json');
  const write = (idToken) => fs.writeFileSync(auth, JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: idToken, access_token: 'secret-access', refresh_token: 'secret-refresh', account_id: 'acct-1' }, last_refresh: '2026-10-03T00:00:00Z' }));
  assert.equal(codexAccount({ env: {}, home }), null, 'no auth.json');
  write(jwt({ email: 'someone@example.com', email_verified: true, sub: 'user-1', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }));
  assert.equal(codexAccount({ env: {}, home }), 'someone@example.com');
  const custom = path.join(home, 'elsewhere');
  fs.mkdirSync(custom);
  fs.copyFileSync(auth, path.join(custom, 'auth.json'));
  fs.rmSync(auth);
  assert.equal(codexAccount({ env: { CODEX_HOME: custom }, home }), 'someone@example.com', '$CODEX_HOME first');
  assert.equal(codexAccount({ env: {}, home }), null, 'not in ~/.codex any more');
  for (const [token, why] of [['not-a-token', 'one part'], ['a.%%%.c', 'payload not base64url'], [`a.${Buffer.from('{"email":').toString('base64url')}.c`, 'payload not JSON'], [jwt({ sub: 'user-1' }), 'no email claim'], [jwt({ email: 42 }), 'email not a string'], [null, 'no id_token']]) {
    write(token);
    assert.equal(codexAccount({ env: {}, home }), null, why);
  }
  fs.writeFileSync(auth, '{ not json');
  assert.equal(codexAccount({ env: {}, home }), null, 'auth.json not JSON');
});

test('detectTools: Codex signed in with ChatGPT carries its account into the record, and no token goes with it', async () => {
  const home = temp();
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome);
  const idToken = jwt({ email: 'someone@example.com', sub: 'user-1' });
  fs.writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: idToken, access_token: 'secret-access', refresh_token: 'secret-refresh' } }));
  const status = (stdout) => fakeRunner({ lookup: '@tool codex\n/opt/homebrew/bin/codex\n', shell: { '--version': { stdout: 'codex-cli 0.155.1\n' }, 'login status': { stdout } } });
  const before = process.env.CODEX_HOME;
  delete process.env.CODEX_HOME; // the default, ~/.codex, under this test's home
  try {
    const found = await detectTools({ runner: status('Logged in using ChatGPT\n'), only: ['codex'], home });
    assert.deepEqual([found.codex.status, found.codex.signedIn, found.codex.account], ['ready', true, 'someone@example.com']);
    assert.doesNotMatch(JSON.stringify(found), /secret-|eyJ|c2lnbmF0dXJl/, 'only the address leaves auth.json');
    const out = await detectTools({ runner: status('Not logged in\n'), only: ['codex'], home });
    assert.deepEqual([out.codex.status, out.codex.account], ['signed-out', null], 'a left-over auth.json names nobody once the CLI says signed out');
    const key = await detectTools({ runner: status('Logged in using an API key - sk-proj-***\n'), only: ['codex'], home });
    assert.deepEqual([key.codex.status, key.codex.account], ['signed-out', null]);
    fs.writeFileSync(path.join(codexHome, 'auth.json'), '{ not json');
    const unread = await detectTools({ runner: status('Logged in using ChatGPT\n'), only: ['codex'], home });
    assert.deepEqual([unread.codex.status, unread.codex.signedIn, unread.codex.account, unread.codex.error], ['ready', true, null, null], 'an unreadable auth.json is no account, not an error');
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = before;
  }
});

test('the record keeps the account only while signed in, and drops anything that is not one', () => {
  const { normalizeTools } = require('../src/main/tools/record.cjs');
  const tools = normalizeTools({ claude: { signedIn: true, account: 'someone@example.com' }, codex: { signedIn: false, account: 'someone@example.com' }, git: { account: 'someone@example.com' } });
  assert.deepEqual([tools.claude.account, tools.codex.account, Object.hasOwn(tools.git, 'account')], ['someone@example.com', null, false]);
  assert.equal(normalizeTools({ claude: { signedIn: true, account: 'two words' } }).claude.account, null);
  assert.equal(normalizeTools({ claude: { signedIn: true, account: 7 } }).claude.account, null);
  assert.equal(observed('claude', { file: '/x/claude', ran: true, version: '2.1.300', signedIn: false, account: 'someone@example.com' }).account, null);
  assert.equal(observed('claude', { file: '/x/claude', ran: false, signedIn: true, account: 'someone@example.com' }).account, null, 'a copy that did not run says nothing about who is signed in');
});

test('detectTools: a version that never answers is retried once, then reported without guessing', async () => {
  const home = temp();
  let asked = 0;
  const runner = fakeRunner({ lookup: '@tool claude\n/opt/homebrew/bin/claude\n', shell: { '--version': () => { asked += 1; return { code: null, timedOut: true }; } } });
  const found = await detectTools({ runner, only: ['claude'], home });
  assert.equal(asked, 2);
  assert.deepEqual([found.claude.status, found.claude.version], ['failed', null]);
  assert.match(found.claude.error, /did not answer --version/);
});

test('detectTools: a login shell that does not answer is reported, and the installers\' folders are still looked in', async () => {
  const home = temp();
  const runner = fakeRunner();
  runner.shell = async () => ({ code: null, stdout: '', stderr: '', timedOut: true, marked: false });
  const found = await detectTools({ runner, only: ['codex'], home, systemBins: [] });
  assert.equal(found.codex.status, 'missing');
  assert.match(found.lookupError, /did not answer/);
  assert.match(found.codex.error, /did not answer/);
});

test('classifyFailure names the cause in one line', () => {
  assert.equal(classifyFailure('curl: (6) Could not resolve host: claude.ai', 6).kind, 'network');
  assert.equal(classifyFailure('Received HTTP code 407 from proxy after CONNECT').kind, 'proxy');
  assert.equal(classifyFailure('curl: (60) SSL certificate problem: unable to get local issuer certificate').kind, 'network');
  assert.equal(classifyFailure('mkdir: /Users/h/.local/bin: Permission denied').kind, 'permission');
  assert.equal(classifyFailure('write error: No space left on device').kind, 'disk');
  assert.equal(classifyFailure('npm ERR! code E404').kind, 'package-manager');
  const other = classifyFailure('\u001b[31msomething odd\u001b[0m\n', 1);
  assert.deepEqual([other.kind, other.error], ['other', 'It did not finish (something odd).']);
});

test('roomFor refuses to start an install the disk cannot hold', () => {
  assert.equal(roomFor('claude', os.homedir()), null, 'this machine has a gigabyte free');
  const statfs = fs.statfsSync;
  try {
    fs.statfsSync = () => ({ bavail: 100, bsize: 4096 });
    const full = roomFor('git', '/Library');
    assert.equal(full.kind, 'disk');
    assert.match(full.error, /Git needs about 5\.0 GB free/);
  } finally {
    fs.statfsSync = statfs;
  }
});

test('installAgent downloads the vendor\'s installer to a file first: a failed download is not a finished install', { skip: process.platform === 'win32' && 'macOS installers (curl, then bash); Windows uses PowerShell\'s and npm (test/windows-platform.test.cjs)' }, async () => {
  const runner = fakeRunner({ shell: { 'curl -fsSL': { code: 6, stdout: 'curl: (6) Could not resolve host: claude.ai' } } });
  const actions = createActions({ runner, home: os.homedir(), tmpDir: temp() });
  const out = await actions.installAgent('claude');
  assert.deepEqual([out.ok, out.kind], [false, 'network']);
  const call = runner.calls.find((item) => item.kind === 'shell');
  assert.match(call.command, /curl -fsSL .* -o "\$ENGELBART_INSTALLER" "\$ENGELBART_INSTALLER_URL" && bash "\$ENGELBART_INSTALLER"/);
  assert.equal(call.env.ENGELBART_INSTALLER_URL, 'https://claude.ai/install.sh');
  const codex = createActions({ runner: fakeRunner({ shell: { 'curl -fsSL': { stdout: '==> Installed' } } }), tmpDir: temp() });
  assert.equal((await codex.installAgent('codex')).ok, true);
});

test('installGit: Apple\'s dialog, then waiting until git arrives or the installer is closed', { skip: process.platform === 'win32' && 'macOS only: Apple\'s Command Line Tools installer' }, async () => {
  const developer = path.join(temp(), 'CommandLineTools');
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  const arrived = createActions({
    runner: fakeRunner({ exec: {
      '/usr/bin/xcode-select --install': { stdout: 'xcode-select: note: install requested for command line developer tools' },
      '/usr/bin/xcode-select -p': () => {
        if (clock >= 15_000) { fs.mkdirSync(path.join(developer, 'usr', 'bin'), { recursive: true }); fs.writeFileSync(path.join(developer, 'usr', 'bin', 'git'), '', { mode: 0o755 }); return { stdout: developer }; }
        return { code: 2 };
      },
      '/usr/bin/pgrep': { code: 0 },
    } }),
    sleep, now: () => clock,
  });
  const phases = [];
  const statfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 1e9, bsize: 4096 });
  try {
    assert.deepEqual(await arrived.installGit({ onPhase: (phase) => phases.push(phase) }), { ok: true });
    assert.deepEqual(phases, ['Waiting for Apple’s installer']);
    clock = 0;
    const closed = createActions({
      runner: fakeRunner({ exec: { '/usr/bin/xcode-select --install': { stdout: 'install requested' }, '/usr/bin/xcode-select -p': { code: 2 }, '/usr/bin/pgrep': () => ({ code: clock < 10_000 ? 0 : 1 }) } }),
      sleep, now: () => clock,
    });
    const out = await closed.installGit();
    assert.deepEqual([out.ok, out.kind], [false, 'cancelled']);
  } finally {
    fs.statfsSync = statfs;
  }
});

test('rollback points a launcher back at the version that worked, in one rename', { skip: process.platform === 'win32' && 'macOS installers link the launcher; on Windows the rollback copies (test/windows-platform.test.cjs)' }, () => {
  const home = temp();
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  for (const version of ['2.1.280', '2.1.281']) fs.writeFileSync(path.join(versions, version), version);
  const launcher = path.join(home, '.local', 'bin', 'claude');
  fs.symlinkSync(path.join(versions, '2.1.280'), launcher);
  const mark = markRollback('claude', { home });
  assert.equal(mark.target, path.join(versions, '2.1.280'));
  fs.unlinkSync(launcher);
  fs.symlinkSync(path.join(versions, '2.1.281'), launcher); // the update moved it
  assert.equal(rollback(mark), true);
  assert.equal(fs.readFileSync(launcher, 'utf8'), '2.1.280');
  assert.equal(markRollback('claude', { home: temp() }), null, 'no launcher, nothing to go back to');
  assert.equal(markRollback('git', { home }), null);
});

test('the lock: runs share it, an update waits for them and holds new runs until it is done', async () => {
  const lock = createLock();
  const order = [];
  let finishRun;
  const run = lock.shared(() => new Promise((resolve) => { order.push('run starts'); finishRun = () => { order.push('run ends'); resolve(); }; }));
  await tick();
  const update = lock.exclusive(async () => { order.push('update'); });
  const later = lock.shared(async () => { order.push('later run'); });
  await tick();
  assert.deepEqual(order, ['run starts'], 'the update waits for the run, the later run waits for the update');
  finishRun();
  await Promise.all([run, update, later]);
  assert.deepEqual(order, ['run starts', 'run ends', 'update', 'later run']);
});

/** A manager over a real config.json in a temp home, with a pretend machine. */
function managerFor(spec, options = {}) {
  const { root } = ensureHome(temp());
  const fake = createFakeTools(spec, { delayMs: 0, sleep: async () => {} });
  const seen = [];
  const tools = createTools({
    readTools: () => readConfig(root).tools,
    writeTools: (value) => writeTools(root, value),
    detect: options.detect ? options.detect(fake) : fake.detect,
    actions: options.actions ? { ...fake.actions, ...options.actions(fake) } : fake.actions,
    signInProcess: fake.signInProcess,
    signOutProcess: options.signOutProcess ? options.signOutProcess(fake) : fake.signOutProcess,
    onChange: (snapshot) => seen.push(snapshot),
    ...(options.now ? { now: options.now } : {}),
    ...(options.installAtLaunch ? { installAtLaunch: options.installAtLaunch } : {}),
  });
  return { tools, fake, root, seen };
}

test('manager: the launch check writes what it saw into config.json, with the booleans Hudson asked for', async () => {
  const { tools, root } = managerFor({ git: 'missing', claude: '2.1.300', codex: '0.155.1 signed-out' });
  assert.equal(readConfig(root).tools.git.installed, false, 'false until a check says otherwise');
  await tools.start();
  const written = readConfig(root).tools;
  assert.deepEqual([written.git.installed, written.git.status], [false, 'missing']);
  assert.deepEqual([written.claude.installed, written.claude.version, written.claude.requires, written.claude.status], [true, '2.1.300', '>=2.1.278', 'ready']);
  assert.deepEqual([written.codex.status, written.codex.signedIn], ['signed-out', false]);
  assert.ok(written.claude.checkedAt);
  assert.deepEqual(tools.usableAgents(), ['claude']);
  assert.equal(tools.snapshot().checked, true);
});

test('manager: an outdated agent is updated at launch when allowed, and not when pinned, skipped, or its own updater is off', async () => {
  const allowed = managerFor({ codex: '0.150.0' });
  await allowed.tools.start();
  assert.deepEqual([readConfig(allowed.root).tools.codex.version, readConfig(allowed.root).tools.codex.status], ['0.155.0', 'ready']);

  for (const [choice, why] of [[{ pin: '0.150.0' }, 'pinned'], [{ skip: true }, 'skipped']]) {
    const held = managerFor({ codex: '0.150.0' });
    const tools = readConfig(held.root).tools;
    tools.codex = { ...tools.codex, ...choice };
    writeTools(held.root, tools);
    await held.tools.start();
    assert.equal(readConfig(held.root).tools.codex.version, '0.150.0', why);
    assert.equal(held.tools.snapshot().tools.codex.autoUpdate, false, why);
  }

  const asked = managerFor({ codex: '0.150.0' });
  const off = readConfig(asked.root).tools;
  writeTools(asked.root, { ...off, updates: 'ask' });
  await asked.tools.start();
  assert.equal(readConfig(asked.root).tools.codex.version, '0.150.0', 'tools.updates = ask');
});

test('manager: an update that fails is not retried at every launch, only after a day', async () => {
  let clock = Date.parse('2026-09-23T12:00:00Z');
  const run = managerFor({ claude: '2.1.200' }, { now: () => new Date(clock), actions: () => ({ updateAgent: async () => ({ ok: false, kind: 'network', error: 'The installer could not be reached: no internet connection.' }) }) });
  await run.tools.start();
  const record = readConfig(run.root).tools.claude;
  assert.deepEqual([record.status, record.failedUpdate.from], ['outdated', '2.1.200']);
  assert.match(record.error, /no internet/);
  assert.equal(run.tools.canAutoUpdate('claude'), false);
  clock += 25 * 60 * 60_000;
  assert.equal(run.tools.canAutoUpdate('claude'), true);
});

test('manager: an install is verified by finding the program afterwards; a failure keeps the reason; Skip is remembered per tool', async () => {
  const { tools, root } = managerFor({ git: 'missing', claude: 'missing', codex: 'missing', failInstall: ['codex'] });
  await tools.start();
  const out = await tools.install(['git', 'claude', 'codex']);
  assert.deepEqual([out.git.ok, out.claude.ok, out.codex.ok], [true, true, false]);
  const written = readConfig(root).tools;
  assert.deepEqual([written.git.installed, written.git.status], [true, 'ready']);
  assert.equal(written.claude.status, 'signed-out', 'a fresh Claude Code is installed and not yet signed in: the install worked, signing in is next');
  assert.equal(written.codex.status, 'missing');
  assert.match(written.codex.error, /no internet connection/);
  tools.skip(['codex']);
  assert.equal(readConfig(root).tools.codex.skip, true);
  tools.askAgain('codex');
  assert.equal(readConfig(root).tools.codex.skip, false);
});

test('manager: the person\'s Skip and pin written by hand into config.json are never overwritten by a check', async () => {
  const { tools, root } = managerFor({ git: 'missing' });
  await tools.start();
  const byHand = readConfig(root).tools;
  byHand.git.skip = true;
  byHand.claude.pin = '2.1.278';
  writeTools(root, byHand);
  await tools.check();
  assert.deepEqual([readConfig(root).tools.git.skip, readConfig(root).tools.claude.pin], [true, '2.1.278']);
});

test('manager: an update that leaves the launcher broken is put back to the version that worked', { skip: process.platform === 'win32' && 'macOS installers link the launcher; on Windows the rollback copies (test/windows-platform.test.cjs)' }, async () => {
  const home = temp();
  const versions = path.join(home, '.local', 'share', 'claude', 'versions');
  fs.mkdirSync(versions, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(versions, '2.1.200'), 'old');
  fs.writeFileSync(path.join(versions, '2.1.300'), 'broken');
  const launcher = path.join(home, '.local', 'bin', 'claude');
  fs.symlinkSync(path.join(versions, '2.1.200'), launcher);
  const { root } = ensureHome(temp());
  // what `claude --version` says follows the launcher: the new version file does not run
  const detect = async () => {
    const target = fs.readlinkSync(launcher);
    return { claude: target.endsWith('2.1.300')
      ? observed('claude', { file: launcher, onPath: true, source: 'native', ran: false, error: 'Claude Code did not start: exit status 1' })
      : observed('claude', { file: launcher, onPath: true, source: 'native', ran: true, version: '2.1.200', signedIn: true }) };
  };
  const tools = createTools({
    readTools: () => readConfig(root).tools,
    writeTools: (value) => writeTools(root, value),
    detect: async (only) => { const found = await detect(); return Object.fromEntries(only.filter((name) => found[name]).map((name) => [name, found[name]])); },
    actions: { updateAgent: async () => { fs.unlinkSync(launcher); fs.symlinkSync(path.join(versions, '2.1.300'), launcher); return { ok: true }; } },
    rollbackOptions: { home },
  });
  await tools.check(['claude']);
  const out = await tools.update('claude');
  assert.equal(out.ok, false);
  assert.match(out.error, /broke Claude Code, so 2\.1\.200 was put back/);
  assert.equal(fs.readFileSync(launcher, 'utf8'), 'old');
  assert.equal(readConfig(root).tools.claude.version, '2.1.200');
});

test('manager: sign-in waits for the CLI, shows its page, and checks again', async () => {
  const { tools, root, seen } = managerFor({ claude: '2.1.300 signed-out' });
  await tools.start();
  await tools.signIn('claude');
  assert.ok(seen.some((snapshot) => snapshot.tools.claude.busy && snapshot.tools.claude.busy.action === 'sign-in'));
  assert.deepEqual([readConfig(root).tools.claude.signedIn, readConfig(root).tools.claude.status], [true, 'ready']);
});

test('manager: sign-out runs the CLI\'s logout, then checks that tool again (2026-10-03, Connections)', async () => {
  const calls = [];
  const { tools, root, seen } = managerFor({ claude: '2.1.300', codex: '0.155.1' }, {
    detect: (fake) => async (only) => { calls.push(['check', ...only]); return fake.detect(only); },
    signOutProcess: (fake) => async (name, file) => { calls.push(['logout', name, file]); return fake.signOutProcess(name, file); },
  });
  await tools.start();
  assert.deepEqual([readConfig(root).tools.claude.status, readConfig(root).tools.claude.account, tools.snapshot().tools.claude.account], ['ready', 'researcher@example.com', 'researcher@example.com'], 'who is signed in, through the record to the rows');
  calls.length = 0;
  seen.length = 0;
  assert.deepEqual(await tools.signOut('claude'), { ok: true, error: null });
  assert.deepEqual(calls, [['logout', 'claude', '/Users/fake/.local/bin/claude'], ['check', 'claude']], 'the logout first, then a check of that tool only');
  assert.equal(seen[0].tools.claude.busy.action, 'sign-out', 'the rows say it is signing out while the CLI runs');
  assert.deepEqual([readConfig(root).tools.claude.signedIn, readConfig(root).tools.claude.status, readConfig(root).tools.claude.account], [false, 'signed-out', null]);
  assert.equal(readConfig(root).tools.codex.status, 'ready', 'Codex is left signed in');
  assert.equal(tools.snapshot().tools.claude.busy, null);
});

test('manager: a sign-out the CLI refuses says why; none starts while signing in, for Git, or for an agent not installed', async () => {
  const refused = managerFor({ codex: '0.155.1' }, { signOutProcess: () => async () => ({ code: 1, output: 'Error: could not remove auth.json' }) });
  await refused.tools.start();
  assert.deepEqual(await refused.tools.signOut('codex'), { ok: false, error: 'Could not sign out of Codex: Error: could not remove auth.json' });
  assert.equal(readConfig(refused.root).tools.codex.status, 'ready', 'still signed in, as the check found');
  const silent = managerFor({ claude: '2.1.300' }, { signOutProcess: () => async () => ({ code: 0, output: '' }) });
  await silent.tools.start();
  assert.deepEqual(await silent.tools.signOut('claude'), { ok: false, error: 'Claude Code still says it is signed in.' });

  const calls = [];
  const { tools } = managerFor({ git: '2.50.1', claude: '2.1.300 signed-out', codex: 'missing' }, { signOutProcess: () => async (name) => { calls.push(name); return { code: 0, output: '' }; } });
  await tools.start();
  assert.deepEqual(await tools.signOut('git'), { ok: false, error: null });
  assert.deepEqual(await tools.signOut('codex'), { ok: false, error: null }, 'not installed: nothing to run');
  const signing = tools.signIn('claude');
  assert.deepEqual(await tools.signOut('claude'), { ok: false, error: null }, 'not in the middle of a sign-in');
  await signing;
  assert.deepEqual(calls, []);
});

test('the logout command is each CLI\'s own, run in the login shell by the program\'s full path', async () => {
  assert.deepEqual(SIGN_OUT_COMMANDS, { claude: 'exec "$ENGELBART_TOOL" auth logout 2>&1', codex: 'exec "$ENGELBART_TOOL" logout 2>&1' });
  const runs = [];
  let answer = { code: 0, stdout: 'Successfully logged out from your Anthropic account.\n', marked: true, timedOut: false };
  const runner = { shellPath: '/bin/zsh', shell: async (command, options) => { runs.push([command, options.env]); return answer; } };
  const signOut = createSignOutProcess({ runner });
  assert.deepEqual(await signOut('claude', '/Users/someone/.local/bin/claude'), { code: 0, output: '' });
  assert.deepEqual(runs, [['exec "$ENGELBART_TOOL" auth logout 2>&1', { ENGELBART_TOOL: '/Users/someone/.local/bin/claude' }]]);
  answer = { code: 1, stdout: '\u001b[31mError:\u001b[0m not logged in\nTry codex login\n', marked: true, timedOut: false };
  assert.deepEqual(await signOut('codex', '/opt/homebrew/bin/codex'), { code: 1, output: 'Try codex login' }, 'the last line, without colour codes');
  assert.equal(runs[1][0], 'exec "$ENGELBART_TOOL" logout 2>&1');
  answer = { code: 0, stdout: '', marked: false, timedOut: false };
  assert.match((await signOut('codex', '/opt/homebrew/bin/codex')).output, /never runs Engelbart's commands/);
  answer = { code: null, stdout: '', marked: false, timedOut: true };
  assert.deepEqual(await signOut('codex', '/opt/homebrew/bin/codex'), { code: null, output: 'it did not finish within 30 seconds' });
});

test('manager: runs and updates of the same program never overlap', async () => {
  let running = 0;
  let overlapped = false;
  const { tools } = managerFor({ codex: '0.150.0' }, { actions: () => ({ updateAgent: async () => { if (running) overlapped = true; return { ok: true }; } }) });
  await tools.check();
  let release;
  const run = tools.use('codex', () => new Promise((resolve) => { running += 1; release = () => { running -= 1; resolve(); }; }));
  await tick();
  const update = tools.update('codex');
  await tick();
  release();
  await Promise.all([run, update]);
  assert.equal(overlapped, false);
});

test('manager: the terminal\'s menu keeps its old shape, and a program off PATH is run by its full path', async () => {
  const { tools } = managerFor({ claude: '2.1.300', codex: 'missing' });
  await tools.start();
  const menu = await tools.providers('/bin/zsh');
  assert.deepEqual(menu.map((item) => [item.id, item.available]), [['shell', true], ['claude', true], ['codex', false]]);
  assert.equal(tools.binaryFor('claude'), null, 'on PATH: its name is enough');
});

test('manager: while Engelbart\'s own Git stands in, everything it starts is given its folder; the record survives config.json (2026-09-28)', async () => {
  const { tools, root } = managerFor({ git: 'bundled' });
  assert.deepEqual(tools.environment(), {}, 'nothing before a check');
  await tools.start();
  assert.deepEqual([readConfig(root).tools.git.source, readConfig(root).tools.git.status], ['bundled', 'ready']);
  assert.deepEqual(tools.environment(), {}, 'the launcher named by the record is not on this disk (the app moved): nothing, until the next check');
  const launcher = path.join(temp(), 'engelbart-bin', 'git');
  fs.mkdirSync(path.dirname(launcher));
  fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
  const byDisk = createTools({ readTools: () => readConfig(root).tools, writeTools: (value) => writeTools(root, value), detect: async () => ({ git: { ...observed('git', { file: launcher, onPath: false, source: 'bundled', ran: true, version: '2.53.0' }), checkedAt: new Date().toISOString() } }), actions: {} });
  await byDisk.check(['git']);
  assert.deepEqual(byDisk.environment(), { ENGELBART_GIT_BIN: path.dirname(launcher) });
  const own = managerFor({ git: '2.50.1' });
  await own.tools.start();
  assert.deepEqual(own.tools.environment(), {}, 'the person\'s own Git: PATH is left as it is');
});

test('manager: an agent installed where the login shell\'s PATH misses it hands its folder to everything Engelbart starts (2026-09-29)', async () => {
  const home = temp();
  const launcher = path.join(home, '.local', 'bin', 'claude');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, '#!/bin/sh\n', { mode: 0o755 });
  const { root } = ensureHome(temp());
  const tools = createTools({ readTools: () => readConfig(root).tools, writeTools: (value) => writeTools(root, value), detect: async () => ({ claude: { ...observed('claude', { file: launcher, onPath: false, source: 'native', ran: true, version: '2.1.300', signedIn: false }), checkedAt: new Date().toISOString() } }), actions: {} });
  await tools.check(['claude']);
  assert.deepEqual(tools.environment(), { ENGELBART_AGENT_PATH: path.dirname(launcher), ENGELBART_CLAUDE_BIN: launcher }, 'and its full path, which the terminal\'s Claude Code item runs (2026-09-30)');
  assert.equal(tools.binaryFor('claude'), launcher);
});

test('manager: on a Mac with neither agent, Claude Code is installed at launch without asking; never over a skip, beside Codex, or on a check that could not ask the shell', async () => {
  const fresh = managerFor({ claude: 'missing', codex: 'missing' }, { installAtLaunch: ['claude'] });
  await fresh.tools.start();
  for (let i = 0; i < 20 && fresh.tools.snapshot().tools.claude.status !== 'signed-out'; i += 1) await tick();
  const written = readConfig(fresh.root).tools;
  assert.deepEqual([written.claude.installed, written.claude.status, written.codex.installed], [true, 'signed-out', false], 'Claude Code installed, waiting for its sign-in; Codex left to the person');
  assert.ok(fresh.seen.some((snapshot) => snapshot.checked && snapshot.tools.claude.busy && snapshot.tools.claude.busy.action === 'install'), 'the dialog saw it installing');

  const skipped = managerFor({ claude: 'missing', codex: 'missing' }, { installAtLaunch: ['claude'] });
  writeTools(skipped.root, { ...readConfig(skipped.root).tools, claude: { skip: true } });
  await skipped.tools.start();
  await tick();
  assert.equal(readConfig(skipped.root).tools.claude.installed, false, 'skipped');

  const hasCodex = managerFor({ claude: 'missing', codex: '0.155.1' }, { installAtLaunch: ['claude'] });
  await hasCodex.tools.start();
  await tick();
  assert.equal(readConfig(hasCodex.root).tools.claude.installed, false, 'an agent is already there');

  const notAsked = managerFor({ claude: 'missing', codex: 'missing' });
  await notAsked.tools.start();
  await tick();
  assert.equal(readConfig(notAsked.root).tools.claude.installed, false, 'only when asked for (index.cjs does)');

  const { root } = ensureHome(temp());
  const blind = createTools({ readTools: () => readConfig(root).tools, writeTools: (value) => writeTools(root, value), installAtLaunch: ['claude'], actions: { installAgent: async () => { throw new Error('must not install'); } }, detect: async (only) => ({ ...Object.fromEntries(only.map((name) => [name, observed(name, {})])), lookupError: 'The login shell (/bin/zsh) did not answer.' }) });
  await blind.start();
  await tick();
  assert.equal(blind.snapshot().tools.claude.busy, null, 'the shell did not answer: missing may only mean unseen');
});

test('inspectRepository reads every case Build must handle straight from .git', () => {
  const { inspectRepository } = require('../src/main/tools/repository.cjs');
  const { execFileSync } = require('node:child_process');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).toString().trim();
  const plain = temp();
  assert.deepEqual(inspectRepository(plain).problems.map((problem) => problem.code), ['not-a-repository']);

  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  assert.deepEqual([inspectRepository(repo).repository, inspectRepository(repo).commits, inspectRepository(repo).branch], [true, false, 'main']);
  assert.deepEqual(inspectRepository(repo).problems.map((problem) => problem.code), ['no-commits']);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'first');
  const ready = inspectRepository(path.join(repo));
  assert.deepEqual([ready.commits, ready.detached, ready.operation, ready.locked, ready.problems], [true, false, null, false, []]);
  assert.ok(ready.freeBytes > 0);
  fs.mkdirSync(path.join(repo, 'deep', 'er'), { recursive: true });
  assert.equal(inspectRepository(path.join(repo, 'deep', 'er')).top, repo, 'a folder inside the repository finds its top');

  git(repo, 'pack-refs', '--all');
  assert.equal(inspectRepository(repo).commits, true, 'a branch only in packed-refs still has commits');

  fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
  fs.writeFileSync(path.join(repo, '.git', 'MERGE_HEAD'), git(repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(inspectRepository(repo).problems.map((problem) => problem.code), ['operation', 'locked']);
  fs.unlinkSync(path.join(repo, '.git', 'index.lock'));
  fs.unlinkSync(path.join(repo, '.git', 'MERGE_HEAD'));

  git(repo, 'checkout', '-q', '--detach');
  assert.deepEqual([inspectRepository(repo).detached, inspectRepository(repo).problems.map((problem) => problem.code)], [true, ['detached']]);
  git(repo, 'checkout', '-q', 'main');

  fs.writeFileSync(path.join(repo, '.gitmodules'), '[submodule "x"]\n');
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.bin filter=lfs diff=lfs merge=lfs -text\n');
  assert.deepEqual([inspectRepository(repo).submodules, inspectRepository(repo).lfs], [true, true]);

  const linked = path.join(temp(), 'linked');
  git(repo, 'worktree', 'add', '-q', '-b', 'engelbart/test', linked);
  const worktree = inspectRepository(linked);
  assert.deepEqual([worktree.repository, worktree.branch, worktree.commits], [true, 'engelbart/test', true], 'a linked worktree reads through its .git file');
});

// The same checks in a real login zsh (with an empty home, so nobody's own rc files run), replacing the
// terminal's old provider discovery (src/main/terminal/provider-discovery.cjs, removed 2026-09-23).
const { createRunner } = require('../src/main/tools/run.cjs');
function realShell() {
  const root = temp();
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // After /etc/zprofile: its path_helper puts the system's folders first (/opt/homebrew/bin among them), and a Claude
  // Code installed there was found instead of the one here (2026-09-29). As a person's own .zprofile would, this sets it.
  fs.writeFileSync(path.join(root, '.zprofile'), `export PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}\n`);
  return { root, bin, runner: createRunner({ environment: { HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh', PATH: `${bin}:/usr/bin:/bin` } }) };
}

test('real zsh: an alias is reported to the terminal without its definition, and a hidden run is never given one', { skip: process.platform === 'win32' && 'macOS only: runs the real zsh and its aliases' }, async () => {
  const { root, bin, runner } = realShell();
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.155.1";; login) echo "Logged in using ChatGPT";; esac\n', { mode: 0o700 });
  fs.writeFileSync(path.join(root, '.zshrc'), "alias claude='printf super-secret-definition'\n");
  const found = await detectTools({ runner, only: ['claude', 'codex'], home: root, systemBins: [] });
  assert.deepEqual([found.claude.status, found.aliases], ['missing', ['claude']]);
  assert.deepEqual([found.codex.status, found.codex.version, found.codex.signedIn, found.codex.path], ['ready', '0.155.1', true, path.join(bin, 'codex')]);
  assert.doesNotMatch(JSON.stringify(found), /super-secret-definition/);
  const { tools } = (() => {
    const { root: configRoot } = ensureHome(temp());
    return { tools: createTools({ readTools: () => readConfig(configRoot).tools, writeTools: (value) => writeTools(configRoot, value), detect: async () => found, actions: {} }) };
  })();
  await tools.check();
  const menu = await tools.providers('/bin/zsh');
  assert.deepEqual(menu.find((item) => item.id === 'claude'), { id: 'claude', name: 'Claude Code', available: true, path: 'shell alias/function', authenticated: null, checkedAt: found.claude.checkedAt });
  assert.equal(tools.usableAgents().includes('claude'), false, '@bart cannot run an alias');
});

test('real zsh: sign-in and the account are read from each CLI, and nothing else of its status goes into the record', async () => {
  const { root, bin, runner } = realShell();
  fs.writeFileSync(path.join(root, '.zshrc'), '');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\ncase "$1" in --version) echo "2.1.300 (Claude Code)";; auth) printf \'{"loggedIn": true, "email": "someone@example.com", "orgId": "org-private-id"}\\n\';; esac\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.155.1";; login) echo "Not logged in"; exit 1;; esac\n', { mode: 0o700 });
  const found = await detectTools({ runner, only: ['claude', 'codex'], home: root, systemBins: [] });
  assert.deepEqual([found.claude.status, found.claude.signedIn, found.claude.account], ['ready', true, 'someone@example.com']);
  assert.deepEqual([found.codex.status, found.codex.signedIn, found.codex.account], ['signed-out', false, null]);
  assert.doesNotMatch(JSON.stringify(found), /org-private-id/);
});
