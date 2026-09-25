'use strict';

// Installing and updating what Engelbart needs (2026-09-23; design D9–D13). Only ever started by the
// person (Install, Update) or, for an update that brings a tool up to its minimum, by the launch check
// when they allow it (./manager.cjs decides which).
//
//   Git          Apple's Command Line Tools: `xcode-select --install` opens Apple's own dialog, which is
//                the permission request; then this waits for the tools to arrive, and notices when the
//                installer is closed without finishing.
//   Claude Code  https://claude.ai/install.sh      } each vendor's installer: SHA-256 checked, into the
//   Codex        https://chatgpt.com/codex/install.sh } home folder, no admin password. Downloaded to a
//                file first, so a failed download is not mistaken for a finished install.
//   Updates      `claude update` / `codex update`: each CLI knows whether it came from its installer,
//                npm or Homebrew. Git is Apple's or Homebrew's to update.
//
// Every action answers { ok, error, kind } and never throws. `kind` names what went wrong (network,
// proxy, permission, disk, package-manager, cancelled, other) so the row can say it in one line.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REQUIREMENTS } = require('./requirements.cjs');

const INSTALLERS = Object.freeze({
  claude: Object.freeze({ url: 'https://claude.ai/install.sh', interpreter: 'bash', env: {} }),
  codex: Object.freeze({ url: 'https://chatgpt.com/codex/install.sh', interpreter: 'sh', env: { CODEX_NON_INTERACTIVE: '1' } }),
});
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const GIT_WAIT_MS = 60 * 60_000;
const GIT_POLL_MS = 5000;
// Free space needed before starting: an agent is ~250-350 MB a version; Apple's tools want several GB while installing.
const NEEDS_BYTES = Object.freeze({ git: 5 * 1024 ** 3, claude: 1024 ** 3, codex: 1024 ** 3 });
const APPLE_INSTALLER = 'Install Command Line Developer Tools';

const lastLines = (text, count = 3) => String(text || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-count);

/** One line saying what went wrong, from what the installer printed. */
function classifyFailure(text, code = null) {
  const output = String(text || '');
  const detail = lastLines(output, 1)[0] || (code == null ? '' : `exit status ${code}`);
  const tail = detail ? ` (${detail.slice(0, 160)})` : '';
  if (/\b407\b|proxy/i.test(output)) return { kind: 'proxy', error: `A proxy stopped the download${tail}.` };
  if (/ssl|certificate|curl: \((35|51|58|59|60|77|83)\)/i.test(output)) return { kind: 'network', error: `The download failed its certificate check; a proxy or firewall may be in the way${tail}.` };
  if (/could not resolve|failed to connect|connection (refused|reset|timed out)|network is unreachable|timed out|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|curl: \((5|6|7|28|52|55|56)\)/i.test(output)) return { kind: 'network', error: `The installer could not be reached: no internet connection${tail}.` };
  if (/ENOSPC|no space left/i.test(output)) return { kind: 'disk', error: `The disk is full${tail}.` };
  if (/EACCES|EPERM|permission denied|operation not permitted|not writable/i.test(output)) return { kind: 'permission', error: `Engelbart was not allowed to write where it installs${tail}.` };
  if (/npm (ERR!|error)|brew|homebrew|cask/i.test(output)) return { kind: 'package-manager', error: `The package manager failed${tail}.` };
  return { kind: 'other', error: `It did not finish${tail}.` };
}

function freeBytes(where) {
  try {
    const stats = fs.statfsSync(where);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null; // cannot tell: the installer will say if it runs out
  }
}

/** → null, or a failure when the disk holding `where` has less room than the tool needs. */
function roomFor(name, where) {
  const free = freeBytes(where);
  if (free == null || free >= NEEDS_BYTES[name]) return null;
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return { ok: false, kind: 'disk', error: `${REQUIREMENTS[name].name} needs about ${gb(NEEDS_BYTES[name])} free; ${gb(free)} is left.` };
}

function createActions({ runner, home = os.homedir(), tmpDir = os.tmpdir(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now, gitWaitMs = GIT_WAIT_MS, gitPollMs = GIT_POLL_MS } = {}) {
  async function gitArrived() {
    const selected = await runner.exec('/usr/bin/xcode-select', ['-p'], { timeout: 5000 });
    const developer = selected.code === 0 ? String(selected.stdout).trim().split(/\r?\n/)[0] : '';
    if (!developer) return false;
    try { fs.accessSync(path.join(developer, 'usr', 'bin', 'git'), fs.constants.X_OK); return true; } catch { return false; }
  }
  async function appleInstallerRunning() {
    const out = await runner.exec('/usr/bin/pgrep', ['-f', APPLE_INSTALLER], { timeout: 5000 });
    return out.code === 0;
  }

  /** Apple's dialog, then waiting for it. `onPhase(text)` reports what it is waiting for. */
  async function installGit({ onPhase = () => {} } = {}) {
    const full = roomFor('git', '/Library');
    if (full) return full;
    const asked = await runner.exec('/usr/bin/xcode-select', ['--install'], { timeout: 30_000 });
    const said = `${asked.stdout}\n${asked.stderr}`;
    if (asked.code !== 0 && !/already installed/i.test(said)) return { ok: false, ...classifyFailure(said, asked.code) };
    if (/already installed/i.test(said) && await gitArrived()) return { ok: true };
    onPhase('Waiting for Apple’s installer');
    const started = now();
    let seen = false;
    let gone = 0;
    while (now() - started < gitWaitMs) {
      await sleep(gitPollMs);
      if (await gitArrived()) return { ok: true };
      if (await appleInstallerRunning()) { seen = true; gone = 0; continue; }
      gone += 1;
      // Closed without finishing (Not Now, or the window shut): twice in a row, so a restart of the process between steps is not mistaken for it.
      if (seen && gone >= 2) return { ok: false, kind: 'cancelled', error: 'Apple’s installer was closed before it finished.' };
      if (!seen && now() - started > 60_000) return { ok: false, kind: 'other', error: 'Apple’s installer did not open.' };
    }
    return { ok: false, kind: 'other', error: 'Apple’s installer had not finished after an hour.' };
  }

  async function installAgent(name) {
    const full = roomFor(name, home);
    if (full) return full;
    const installer = INSTALLERS[name];
    const script = path.join(tmpDir, `engelbart-${name}-install-${process.pid}-${now()}.sh`);
    try {
      const out = await runner.shell(`curl -fsSL --retry 2 --connect-timeout 20 -o "$ENGELBART_INSTALLER" "$ENGELBART_INSTALLER_URL" && ${installer.interpreter} "$ENGELBART_INSTALLER" < /dev/null 2>&1`, {
        env: { ENGELBART_INSTALLER: script, ENGELBART_INSTALLER_URL: installer.url, ...installer.env },
        timeout: INSTALL_TIMEOUT_MS,
      });
      if (out.timedOut) return { ok: false, kind: 'other', error: `The installer had not finished after ${INSTALL_TIMEOUT_MS / 60_000} minutes.` };
      if (out.code !== 0) return { ok: false, ...classifyFailure(`${out.stdout}\n${out.stderr}`, out.code) };
      return { ok: true };
    } finally {
      try { fs.unlinkSync(script); } catch { /* never downloaded */ }
    }
  }

  /** The CLI's own updater, run by the path Engelbart runs it by. */
  async function updateAgent(name, file) {
    const full = roomFor(name, home);
    if (full) return full;
    const out = await runner.shell('exec "$ENGELBART_TOOL" update < /dev/null 2>&1', { env: { ENGELBART_TOOL: file, CODEX_NON_INTERACTIVE: '1' }, timeout: INSTALL_TIMEOUT_MS });
    if (out.timedOut) return { ok: false, kind: 'other', error: `The update had not finished after ${INSTALL_TIMEOUT_MS / 60_000} minutes.` };
    if (out.code !== 0) return { ok: false, ...classifyFailure(`${out.stdout}\n${out.stderr}`, out.code) };
    return { ok: true };
  }

  async function updateGit(source) {
    if (source !== 'homebrew') return { ok: false, kind: 'other', error: 'Apple’s Git is updated by macOS: System Settings › General › Software Update.' };
    const out = await runner.shell('brew upgrade git < /dev/null 2>&1', { timeout: INSTALL_TIMEOUT_MS });
    if (out.code !== 0) return { ok: false, ...classifyFailure(`${out.stdout}\n${out.stderr}`, out.code) };
    return { ok: true };
  }

  return { installGit, installAgent, updateAgent, updateGit };
}

// Putting a working version back (design D12). Both vendors' installers keep earlier versions on disk
// and reach the current one through a symlink: Claude Code's launcher ~/.local/bin/claude points into
// ~/.local/share/claude/versions/, Codex's ~/.codex/packages/standalone/current into releases/.
function rollbackPoint(name, { home = os.homedir(), env = process.env } = {}) {
  if (name === 'claude') return path.join(home, '.local', 'bin', 'claude');
  if (name === 'codex') return path.join(env.CODEX_HOME || path.join(home, '.codex'), 'packages', 'standalone', 'current');
  return null;
}

/** What the rollback point points at now (to restore later), or null when this install has none. */
function markRollback(name, options) {
  const link = rollbackPoint(name, options);
  if (!link) return null;
  try {
    const target = fs.readlinkSync(link);
    const resolved = path.resolve(path.dirname(link), target);
    return fs.existsSync(resolved) ? { link, target } : null;
  } catch {
    return null;
  }
}

/** Points the link back where `mark` found it, in one rename. → true when it did. */
function rollback(mark) {
  if (!mark) return false;
  const temporary = `${mark.link}.engelbart-${process.pid}`;
  try {
    try { fs.unlinkSync(temporary); } catch { /* none */ }
    fs.symlinkSync(mark.target, temporary);
    fs.renameSync(temporary, mark.link);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* none */ }
    return false;
  }
}

module.exports = { createActions, classifyFailure, roomFor, freeBytes, markRollback, rollback, rollbackPoint, INSTALLERS, NEEDS_BYTES };
