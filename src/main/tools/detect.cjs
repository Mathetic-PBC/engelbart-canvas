'use strict';

// What is installed (2026-09-23; design D8). One login-shell call lists every git, claude and codex on
// the PATH @bart and the terminal use; the first is what runs, and a wrapper script in front of the real
// program (Hudson's vault shim) is seen through for where the program came from. A program missing from
// that PATH is looked for where its installers put it, and is then run by its full path. Each is asked
// its version; Claude Code and Codex are asked whether they are signed in, and whether the person turned
// their own updater off.
//
// Every copy counts (2026-09-30, scripts/mac-states): the copies PATH reaches, in its order, then those where the
// installers put them; the first recent enough is used, by its full path when its name runs another (an old Homebrew
// copy first on PATH), and the row says which comes first and how to remove it. A program of the same name that does
// not print Claude Code's or Codex's own version line is another program, and is passed over. A login shell that
// never runs what it is given (a .zshrc that ends in `exec tmux`) makes every program in it fail, and says why. On macOS /usr/bin/git is Apple's stub: it is only run once `xcode-select -p`
// names a developer folder that holds git, because otherwise running it opens Apple's installer unasked.
// When the person's own Git is missing, cannot run or is too old, the Git that came with Engelbart stands
// in (2026-09-28; ./bundled-git.cjs), recorded with the source `bundled`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REQUIREMENTS } = require('./requirements.cjs');
const { parseVersion, judge } = require('./version.cjs');

const APPLE_GIT_STUB = '/usr/bin/git';
const LOOKUP_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 20_000;
const AUTH_TIMEOUT_MS = 15_000;

const firstLine = (text) => String(text || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';

// Every program of each name on PATH, in PATH order; whether the name is (also) a shell alias or function,
// which the terminal can run and a hidden run cannot (its definition is never printed); and the one
// switch the shell's environment can hold.
function lookupCommand(fish) {
  if (fish) {
    return "for tool in git claude codex; printf '@tool %s\\n' $tool; command -a -s $tool 2>/dev/null; if functions -q $tool; printf '@alias %s\\n' $tool; end; end; printf '@env DISABLE_AUTOUPDATER=%s\\n' \"$DISABLE_AUTOUPDATER\"";
  }
  return "for tool in git claude codex; do printf '@tool %s\\n' \"$tool\"; if [ -n \"$ZSH_VERSION\" ]; then whence -ap \"$tool\" 2>/dev/null; kind=$(whence -w \"$tool\" 2>/dev/null); else type -aP \"$tool\" 2>/dev/null; kind=\"$tool: $(type -t \"$tool\" 2>/dev/null)\"; fi; case \"$kind\" in *alias|*function) printf '@alias %s\\n' \"$tool\";; esac; done; printf '@env DISABLE_AUTOUPDATER=%s\\n' \"${DISABLE_AUTOUPDATER:-}\"";
}

function parseLookup(stdout) {
  const paths = { git: [], claude: [], codex: [] };
  const aliases = [];
  const env = {};
  let current = null;
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const tool = /^@tool (\w+)$/.exec(line);
    if (tool) { current = Object.hasOwn(paths, tool[1]) ? tool[1] : null; continue; }
    const alias = /^@alias (\w+)$/.exec(line);
    if (alias) { if (Object.hasOwn(paths, alias[1]) && !aliases.includes(alias[1])) aliases.push(alias[1]); continue; }
    const setting = /^@env (\w+)=(.*)$/.exec(line);
    if (setting) { env[setting[1]] = setting[2]; current = null; continue; }
    if (current && path.isAbsolute(line) && !paths[current].includes(line)) paths[current].push(line);
  }
  return { paths, aliases, env };
}

function isExecutable(file) {
  try {
    const stat = fs.statSync(file);
    fs.accessSync(file, fs.constants.X_OK);
    return stat.isFile();
  } catch {
    return false;
  }
}

function isScript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      return head.toString('latin1') === '#!';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

function realPath(file) {
  try { return fs.realpathSync(file); } catch { return file; }
}

const SYSTEM_BINS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin']);

/** Where installers put each program when PATH does not reach it. Newest nvm Node first. */
function knownPlaces(name, home, systemBins = SYSTEM_BINS) {
  if (name === 'git') return [];
  const inHome = {
    claude: ['.local/bin/claude', '.claude/local/claude', '.bun/bin/claude', '.npm-global/bin/claude', '.volta/bin/claude'],
    codex: ['.local/bin/codex', '.bun/bin/codex', '.npm-global/bin/codex', '.volta/bin/codex'],
  }[name].map((relative) => path.join(home, relative));
  let nvm = [];
  try {
    const root = path.join(home, '.nvm', 'versions', 'node');
    nvm = fs.readdirSync(root).filter((entry) => /^v\d+/.test(entry))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((entry) => path.join(root, entry, 'bin', name));
  } catch { /* no nvm */ }
  return [...inHome, ...systemBins.map((dir) => path.join(dir, name)), ...nvm];
}

/** How a program was installed, from where its file really is: this decides how it updates and whether an update can be undone. */
function sourceOf(name, file) {
  const real = realPath(file);
  if (name === 'git') {
    if (real === APPLE_GIT_STUB || real.startsWith('/Applications/Xcode') || real.startsWith('/Library/Developer/CommandLineTools/')) return 'apple';
    if (/\/(Cellar|Homebrew|homebrew)\//.test(real) || real.startsWith('/opt/homebrew/')) return 'homebrew';
    return 'other';
  }
  if (name === 'claude' && real.includes(`${path.sep}.local${path.sep}share${path.sep}claude${path.sep}versions${path.sep}`)) return 'native';
  if (name === 'codex' && real.includes(`${path.sep}.codex${path.sep}packages${path.sep}standalone${path.sep}`)) return 'standalone';
  if (/\/Caskroom\/|\/Cellar\//.test(real)) return 'homebrew';
  if (real.includes('/node_modules/')) return real.includes(`${path.sep}.bun${path.sep}`) ? 'bun' : 'npm';
  if (real.includes(`${path.sep}.bun${path.sep}`)) return 'bun';
  return 'other';
}

const RC_FILE = { zsh: '.zshrc', bash: '.bash_profile', fish: 'config.fish' };

/** Why nothing ran: the login shell exited without running the command it was given. */
function shellSilent(runner) {
  const shell = runner.shellPath || '/bin/zsh';
  const rc = RC_FILE[path.basename(shell)] || 'startup files';
  return `Your login shell (${shell}) never runs Engelbart's commands: something in your ${rc} starts another program, such as \`exec tmux\` or \`exec bash\`. Put that line inside \`if [[ -t 1 ]]; then … fi\`, so it only runs in a terminal window.`;
}

/**
 * What `file --version` says. → { ran, version, text, code, error, other, silent }. `other`: it ran, but is not Claude
 * Code or Codex (their own version line is missing: another program of the same name). `silent`: the login shell never
 * ran it (shellSilent).
 */
async function readVersion(runner, name, file, { direct = false } = {}) {
  const label = REQUIREMENTS[name].name;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = direct
      ? await runner.exec(file, ['--version'], { timeout: VERSION_TIMEOUT_MS })
      : await runner.shell('exec "$ENGELBART_TOOL" --version 2>&1', { env: { ENGELBART_TOOL: file }, timeout: VERSION_TIMEOUT_MS });
    if (out.timedOut) continue;
    if (!direct && out.marked === false) return { ran: false, version: null, text: '', code: out.code, silent: true, error: shellSilent(runner) };
    const text = `${out.stdout}\n${direct ? out.stderr : ''}`;
    if (out.code !== 0) return { ran: false, version: null, text, code: out.code, error: `${label} did not start: ${firstLine(text) || `exit status ${out.code}`}` };
    if (name !== 'git' && !REQUIREMENTS[name].version.test(text)) return { ran: true, version: null, text, code: 0, other: true, error: `${file} is another program called ${name}, not ${label} (it says "${firstLine(text).slice(0, 60)}").` };
    const version = parseVersion(text, name);
    return { ran: true, version, text, code: 0, error: version ? null : `Could not read the version ${label} printed: "${firstLine(text).slice(0, 80)}"` };
  }
  return { ran: false, version: null, text: '', code: null, error: `${label} did not answer --version within ${VERSION_TIMEOUT_MS / 1000} seconds` };
}

// Sign-in belongs to the CLIs: each is asked for its own status. Engelbart runs Codex on a ChatGPT sign-in
// only (an API key is never used), so an API-key sign-in counts as signed out for it.
// Who is signed in (2026-10-03, Connections' "Connected · <account>"): Claude Code's status JSON has it (`email`);
// Codex's status line does not, so it is the `email` claim of the ID token in Codex's own auth.json (codexAccount).
// Only that address is kept; no token is ever logged or returned. Not found → account null, never an error.
const accountOf = (value) => (typeof value === 'string' && /^\S{1,254}$/.test(value.trim()) ? value.trim() : null);

/** The account in Codex's sign-in file ($CODEX_HOME, else ~/.codex): its ID token's `email` claim, decoded unverified. */
function codexAccount({ env = process.env, home = os.homedir() } = {}) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), 'utf8'));
    const token = auth && auth.tokens && auth.tokens.id_token;
    if (typeof token !== 'string') return null;
    const payload = token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return accountOf(claims && claims.email);
  } catch {
    return null;
  }
}

const AUTH = {
  claude: {
    command: 'exec "$ENGELBART_TOOL" auth status --json 2>&1',
    read: (text) => {
      // The JSON object, past any warning printed in front of it; else the one field, as before.
      const raw = String(text || '');
      let status = null;
      try { status = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)); } catch { status = null; }
      if (status && typeof status.loggedIn === 'boolean') return { signedIn: status.loggedIn, account: status.loggedIn ? accountOf(status.email) : null };
      const match = /"loggedIn"\s*:\s*(true|false)/.exec(raw);
      return { signedIn: match ? match[1] === 'true' : null, account: null };
    },
  },
  codex: {
    command: 'exec "$ENGELBART_TOOL" login status 2>&1',
    read: (text) => {
      if (/not logged in/i.test(text)) return { signedIn: false, account: null };
      if (/logged in using chatgpt/i.test(text)) return { signedIn: true, account: null };
      if (/logged in/i.test(text)) return { signedIn: false, account: null, error: 'Codex is signed in with an API key; Engelbart uses a ChatGPT sign-in (run `codex login`).' };
      return { signedIn: null, account: null };
    },
    account: codexAccount,
  },
};

/** → { signedIn, account, error? }. `where`: { env, home } for a sign-in file the CLI does not print from (Codex's). */
async function readSignIn(runner, name, file, where = {}) {
  const out = await runner.shell(AUTH[name].command, { env: { ENGELBART_TOOL: file }, timeout: AUTH_TIMEOUT_MS });
  if (out.marked === false) return { signedIn: null, account: null };
  const read = AUTH[name].read(out.stdout);
  if (read.signedIn !== true) return { ...read, account: null };
  if (!read.account && AUTH[name].account) return { ...read, account: AUTH[name].account(where) };
  return read;
}

/** Whether the person turned the CLI's own updater off: then Engelbart asks before updating it too (design D11). */
function updaterOff(name, { env, home }) {
  if (name === 'claude') {
    if (/^(1|true|yes)$/i.test(String(env.DISABLE_AUTOUPDATER || '').trim())) return true;
    // ~/.claude.json can run to megabytes of project history: the one setting is looked for, not parsed out.
    try { return /"autoUpdates"\s*:\s*false/.test(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch { return false; }
  }
  if (name === 'codex') {
    try { return /^\s*check_for_update_on_startup\s*=\s*false\b/m.test(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), 'utf8')); } catch { return false; }
  }
  return false;
}

/** The observed half of a tool's record (./record.cjs), from what was found. */
function observed(name, { file = null, onPath = null, source = null, version = null, ran = false, error = null, signedIn = null, account = null, updater = false, note = null }) {
  // `installed`: a program is there. Whether it can be used is `status` (a broken one is installed and failed).
  // `onPath`: running it by its name runs this copy; else Engelbart runs it by its full path. `note`: what the row adds.
  // `account`: who is signed in (an email address), only while signed in.
  const out = { installed: !!file, version, status: 'missing', path: file, onPath, source, untested: false, error, updaterOff: updater, note };
  if (name !== 'git') {
    out.signedIn = file && ran ? signedIn : null;
    out.account = out.signedIn === true ? accountOf(account) : null;
  }
  if (!file) return out;
  if (!ran) return { ...out, status: 'failed' };
  const verdict = judge(name, version);
  out.untested = verdict.untested;
  if (verdict.status === 'unknown') out.status = 'ready';
  else out.status = verdict.status;
  if (verdict.why && !out.error) out.error = verdict.why;
  if (out.status === 'ready' && name !== 'git' && signedIn === false) out.status = 'signed-out';
  return out;
}

/** The person's own Git: the first on the login shell's PATH (Apple's stub read through, never run bare). */
async function detectOwnGit(runner, candidates) {
  const first = candidates[0] || null;
  if (!first) return observed('git', {});
  if (realPath(first) !== APPLE_GIT_STUB) {
    const read = await readVersion(runner, 'git', first, { direct: true });
    return observed('git', { file: first, onPath: true, source: sourceOf('git', first), ...read });
  }
  // Apple's stub: which git it hands over to, if any. No developer folder = no git, and the stub is not touched.
  const selected = await runner.exec('/usr/bin/xcode-select', ['-p'], { timeout: 5000 });
  const developer = selected.code === 0 ? firstLine(selected.stdout) : '';
  const real = developer ? path.join(developer, 'usr', 'bin', 'git') : '';
  if (!real || !isExecutable(real)) return observed('git', {});
  const read = await readVersion(runner, 'git', real, { direct: true });
  if (!read.ran) return observed('git', { file: first, onPath: true, source: 'apple', ...read });
  // The stub itself refuses to run until Xcode's license is accepted (exit 69), which breaks every `git` Claude Code and Codex type.
  const stub = await runner.exec(APPLE_GIT_STUB, ['--version'], { timeout: VERSION_TIMEOUT_MS });
  if (stub.code !== 0 && /licen[cs]e/i.test(`${stub.stdout}\n${stub.stderr}`)) {
    return observed('git', { file: first, onPath: true, source: 'apple', ran: false, error: "Xcode's license has not been accepted, so git will not run (in Terminal: sudo xcodebuild -license accept)." });
  }
  return observed('git', { file: first, onPath: true, source: 'apple', ...read });
}

/** Their own Git when it works; else Engelbart's (`bundled`: its launcher), unless that cannot run either. `preferBundled`: tests of the stand-in on a Mac that has Git. */
async function detectGit(runner, candidates, { bundled = null, preferBundled = false } = {}) {
  const own = preferBundled && bundled ? observed('git', {}) : await detectOwnGit(runner, candidates);
  if (!bundled || own.status === 'ready') return own;
  const read = await readVersion(runner, 'git', bundled, { direct: true });
  if (!read.ran && own.installed) return own;
  return observed('git', { file: bundled, onPath: false, source: 'bundled', ...read });
}

// What to type to take a copy away, from where it really is.
function removal(name, file) {
  const real = realPath(file);
  const cask = /\/Caskroom\/([^/]+)\//.exec(real);
  if (cask) return `brew uninstall --cask ${cask[1]}`;
  const formula = /\/Cellar\/([^/]+)\//.exec(real);
  if (formula) return `brew uninstall ${formula[1]}`;
  const npm = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(real);
  if (npm) return `npm uninstall -g ${npm[1]}`;
  return null;
}

/** Every copy of `name`: those PATH reaches, in its order, then those where installers put them; each file once. */
function copiesOf(name, candidates, { home, systemBins }) {
  const seen = new Set();
  const copies = [];
  const add = (file, onPath) => {
    const key = realPath(file);
    if (seen.has(key)) return;
    seen.add(key);
    copies.push({ file, onPath });
  };
  for (const file of candidates) add(file, true);
  for (const file of knownPlaces(name, home, systemBins)) if (isExecutable(file)) add(file, false);
  return copies;
}

async function detectAgent(runner, name, candidates, { env, home, systemBins }) {
  const label = REQUIREMENTS[name].name;
  const shellEnv = { ...process.env, ...env };
  const updater = updaterOff(name, { env: shellEnv, home });
  // The first copy recent enough, else the first that is this program at all (its row offers Update, or Try again).
  let first = null;
  let chosen = null;
  let other = null; // the first program of the same name that is not it
  for (const copy of copiesOf(name, candidates, { home, systemBins })) {
    const read = await readVersion(runner, name, copy.file);
    if (read.other) { other = other || { ...copy, read }; continue; }
    const entry = { ...copy, read };
    first = first || entry;
    if (read.ran && judge(name, read.version).status !== 'outdated' && judge(name, read.version).status !== 'incompatible') { chosen = entry; break; }
    if (read.silent) break; // the login shell runs nothing: every other copy would fail the same way
  }
  chosen = chosen || first;
  if (!chosen) return observed(name, { updater, error: other ? other.read.error : null });
  const { file, read } = chosen;
  // Its name runs this copy only when it is the first on PATH; otherwise it runs by its full path, and the row says why.
  const byName = candidates[0] || null;
  const onPath = chosen.onPath && byName === file;
  let note = null;
  if (byName && byName !== file) {
    const shadow = other && other.file === byName ? other : null;
    const hint = removal(name, byName);
    // What to do first, the path last: the record keeps a note to 300 characters, and paths can be long.
    const where = byName.startsWith(`${home}${path.sep}`) ? `~${byName.slice(home.length)}` : byName;
    note = shadow
      ? `Typing ${name} in a terminal runs another program of the same name; Engelbart runs ${label} by its full path. The other one is at ${where}.`
      : `An older ${label} comes first on your PATH, so typing ${name} in a terminal runs it; Engelbart uses a newer one.${hint ? ` To remove the older one: ${hint}.` : ''} It is at ${where}.`;
  }
  // A wrapper script in front of the program says nothing about where the program came from: the next one on PATH does.
  const after = candidates.slice(candidates.indexOf(file) + 1);
  const origin = (isScript(file) && after.find((candidate) => !isScript(candidate))) || file;
  const auth = read.ran ? await readSignIn(runner, name, file, { env: shellEnv, home }) : { signedIn: null, account: null };
  return observed(name, { file, onPath, source: sourceOf(name, origin), ...read, signedIn: auth.signedIn, account: auth.account, error: read.error || auth.error || null, updater, note });
}

/**
 * Looks for all three, or only the ones named. → { git?, claude?, codex? } (each the observed half of a
 * record), `aliases` (names the shell defines as an alias or function) and `lookupError` when the login
 * shell could not be asked (then only the installers' folders are). `bundledGit`: the launcher of the Git
 * that came with Engelbart (./bundled-git.cjs), or null.
 */
async function detectTools({ runner, only = ['git', 'claude', 'codex'], home = os.homedir(), systemBins = SYSTEM_BINS, now = () => new Date(), bundledGit = null, preferBundledGit = false }) {
  const lookup = await runner.shell(lookupCommand(runner.fish), { timeout: LOOKUP_TIMEOUT_MS });
  const { paths, aliases, env } = parseLookup(lookup.stdout);
  const lookupError = lookup.marked ? null : lookup.timedOut ? `The login shell (${runner.shellPath}) did not answer within ${LOOKUP_TIMEOUT_MS / 1000} seconds.` : shellSilent(runner);
  const checkedAt = now().toISOString();
  const jobs = only.map(async (name) => {
    const found = name === 'git' ? await detectGit(runner, paths.git, { bundled: bundledGit, preferBundled: preferBundledGit }) : await detectAgent(runner, name, paths[name], { env, home, systemBins });
    return [name, { ...found, error: found.error || (found.status === 'missing' ? lookupError : null), checkedAt }];
  });
  return { ...Object.fromEntries(await Promise.all(jobs)), aliases, lookupError };
}

module.exports = { detectTools, lookupCommand, parseLookup, knownPlaces, sourceOf, observed, readVersion, readSignIn, codexAccount, removal, shellSilent, AUTH, APPLE_GIT_STUB };
