'use strict';

// Git, Claude Code and Codex for the whole app (2026-09-23; design: docs/superpowers/specs/2026-09-23-tools-and-defaults-design.md).
// It checks what is there at launch and when asked, keeps config.json's `tools` true to what the last
// check saw, and runs every install, update and sign-in:
//
//   check      detect (./detect.cjs) → observed fields; the person's `skip` and `pin` are read from the
//              file each time, so an edit by hand is never overwritten.
//   maintain   after the launch check: a tool below its minimum is updated when `tools.updates` is auto,
//              it is not pinned or skipped, its own updater is on, and the same update has not failed
//              in the last day. Everything else waits for the person.
//   first      after the launch check on a Mac with neither agent (a first launch, 2026-09-28): the agents
//              named in `installAtLaunch` are installed without being asked for, unless skipped. The setup
//              dialog shows them installing; signing in is still the person's.
//   install    one at a time, each holding its tool's lock alone (./lock.cjs), then found again: an
//              installer that says it finished is not believed until the program answers.
//   update     the same, and a launcher left broken by the update is pointed back at the version that
//              worked (./install.cjs rollback), when the install keeps one.
//   use        what a run of a program (an @bart turn, a summary) holds while it runs.
//   environment  what everything Engelbart starts is given: the folder of Engelbart's own Git while it
//              stands in for a missing one (./bundled-git.cjs), which ../terminal/launch.cjs puts first on PATH,
//              and the folders of Claude Code and Codex when the login shell's PATH misses them (a new account:
//              their installers put them in ~/.local/bin, which a fresh .zshrc does not add), which it puts last.
//
// What changes is sent on as a snapshot (`onChange`), which the renderer's dialog draws.

const fs = require('node:fs');
const path = require('node:path');
const { TOOL_NAMES, AGENTS, REQUIREMENTS } = require('./requirements.cjs');
const { normalizeTools } = require('./record.cjs');
const { createLock } = require('./lock.cjs');
const { markRollback, rollback } = require('./install.cjs');

const STALE_MS = 10 * 60_000;
const RETRY_UPDATE_MS = 24 * 60 * 60_000;
const SIGN_IN_MS = 10 * 60_000;
const OBSERVED = ['installed', 'version', 'status', 'signedIn', 'path', 'onPath', 'source', 'untested', 'updaterOff', 'checkedAt', 'error', 'note'];
const WORKS = new Set(['ready', 'signed-out']);

const pick = (found) => Object.fromEntries(OBSERVED.filter((key) => Object.hasOwn(found, key)).map((key) => [key, found[key]]));

function createTools({ readTools, writeTools, detect, actions, signInProcess = null, rollbackOptions = {}, installAtLaunch = [], now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout, onChange = () => {}, platform = process.platform }) {
  // What the checks saw (starting from what the last launch wrote), and what is happening now.
  const disk = () => normalizeTools(readTools());
  const seen = {};
  { const last = disk(); for (const name of TOOL_NAMES) seen[name] = { ...last[name] }; }
  const busy = {}; // name → { action: 'check' | 'install' | 'update' | 'sign-in', phase?, url? }
  const locks = Object.fromEntries(TOOL_NAMES.map((name) => [name, createLock()]));
  const installer = createLock();
  const signIns = new Map();
  let records = disk();
  let aliases = []; // names the login shell defines as an alias or function: the terminal can run them
  let checked = false;
  let lookupError = null; // the last full check could not ask the login shell, so `missing` may only mean unseen
  let launch = null;

  function persist(choices = {}) {
    const onDisk = disk();
    const next = { updates: choices.updates || onDisk.updates };
    for (const name of TOOL_NAMES) {
      const chosen = choices[name] || {};
      next[name] = {
        ...onDisk[name],
        ...pick(seen[name]),
        failedUpdate: seen[name].failedUpdate || null,
        skip: Object.hasOwn(chosen, 'skip') ? chosen.skip : onDisk[name].skip,
        pin: Object.hasOwn(chosen, 'pin') ? chosen.pin : onDisk[name].pin,
      };
    }
    const written = writeTools(next);
    records = normalizeTools(written ? written.tools : next);
  }

  function canAutoUpdate(name, record = records[name]) {
    if (name === 'git' || !(record.status === 'outdated' || record.status === 'incompatible')) return false;
    if (records.updates !== 'auto' || record.pin || record.skip || record.updaterOff || !record.path) return false;
    const failed = record.failedUpdate;
    return !(failed && failed.from === record.version && now().getTime() - Date.parse(failed.at) < RETRY_UPDATE_MS);
  }

  function snapshot() {
    return {
      checked,
      platform,
      updates: records.updates,
      tools: Object.fromEntries(TOOL_NAMES.map((name) => [name, {
        id: name,
        name: REQUIREMENTS[name].name,
        minimum: REQUIREMENTS[name].minimum,
        ...records[name],
        busy: busy[name] ? { ...busy[name] } : null,
        autoUpdate: canAutoUpdate(name),
      }])),
    };
  }
  const emit = () => { try { onChange(snapshot()); } catch { /* a closed window */ } };

  async function check(only = TOOL_NAMES) {
    const names = only.filter((name) => !busy[name]);
    if (!names.length) return snapshot();
    for (const name of names) busy[name] = { action: 'check' };
    emit();
    let found = {};
    try { found = await detect(names); } catch (error) { found = {}; for (const name of names) found[name] = { error: `The check failed: ${error.message}` }; }
    for (const name of names) {
      if (busy[name] && busy[name].action === 'check') busy[name] = null;
      if (found[name]) seen[name] = { ...seen[name], ...pick(found[name]) };
    }
    if (Array.isArray(found.aliases)) aliases = [...aliases.filter((name) => !names.includes(name)), ...found.aliases.filter((name) => names.includes(name))];
    if (TOOL_NAMES.every((name) => names.includes(name))) { checked = true; lookupError = found.lookupError || null; }
    persist();
    emit();
    return snapshot();
  }

  async function update(name, { auto = false } = {}) {
    const record = records[name];
    if (!record.installed) return { ok: false, error: `${REQUIREMENTS[name].name} is not installed.` };
    if (auto && !canAutoUpdate(name)) return { ok: false, error: null };
    return installer.exclusive(() => locks[name].exclusive(async () => {
      const before = { ...records[name] };
      busy[name] = { action: 'update' };
      seen[name] = { ...seen[name], status: 'updating', error: null };
      persist();
      emit();
      const mark = before.source === 'native' || before.source === 'standalone' ? markRollback(name, rollbackOptions) : null;
      const result = name === 'git' ? await actions.updateGit(before.source) : await actions.updateAgent(name, before.path);
      let found = (await detect([name]))[name] || {};
      let error = null;
      let restored = false;
      if (!WORKS.has(found.status) && (found.status === 'failed' || found.status === 'missing') && mark && rollback(mark)) {
        // The update left a launcher that does not run: the version that worked is put back.
        restored = true;
        found = (await detect([name]))[name] || {};
      }
      const ok = WORKS.has(found.status);
      if (!ok) {
        const label = REQUIREMENTS[name].name;
        if (restored) error = `The update broke ${label}, so ${before.version || 'the earlier version'} was put back.${result.error ? ` ${result.error}` : ''}`;
        else if (!result.ok) error = result.error;
        else if (found.status === 'outdated' || found.status === 'incompatible') error = `${label} updated to ${found.version || 'a version'} that still does not meet ${REQUIREMENTS[name].minimum}.`;
        else error = found.error || `${label} did not answer after the update.`;
        if (!restored && mark === null && (found.status === 'failed' || found.status === 'missing') && before.source && before.source !== 'native' && before.source !== 'standalone') {
          error += ` A ${before.source} install keeps no earlier copy to go back to.`;
        }
      }
      // A failed update is not retried automatically for a day from the same version (canAutoUpdate).
      seen[name] = { ...seen[name], ...pick(found), error: ok ? (found.error || null) : error, failedUpdate: ok || !before.version ? null : { from: before.version, at: now().toISOString() } };
      busy[name] = null;
      persist();
      emit();
      return { ok, error };
    }));
  }

  async function maintain() {
    for (const name of TOOL_NAMES) {
      if (canAutoUpdate(name)) await update(name, { auto: true });
    }
  }

  function start() {
    if (!launch) launch = check().then(() => { installFirst(); return maintain(); }).then(() => snapshot());
    return launch;
  }

  /** Neither agent on this Mac: the ones named in `installAtLaunch` are installed now, in the background. */
  function installFirst() {
    if (lookupError || AGENTS.some((name) => records[name].installed)) return;
    const names = installAtLaunch.filter((name) => AGENTS.includes(name) && records[name].status === 'missing' && !records[name].skip && !busy[name]);
    if (names.length) void install(names).catch(() => {});
  }

  async function installOne(name) {
    if (records[name].installed && WORKS.has(records[name].status)) return { ok: true, error: null };
    return installer.exclusive(() => locks[name].exclusive(async () => {
      busy[name] = { action: 'install', phase: null };
      seen[name] = { ...seen[name], status: 'installing', error: null };
      persist({ [name]: { skip: false } });
      emit();
      const result = name === 'git'
        ? await actions.installGit({ onPhase: (phase) => { if (busy[name]) { busy[name].phase = phase; emit(); } } })
        : await actions.installAgent(name);
      const found = (await detect([name]))[name] || {};
      const ok = WORKS.has(found.status);
      let error = null;
      if (!ok) {
        if (!result.ok) error = result.error;
        else if (found.status === 'outdated' || found.status === 'incompatible') error = `${REQUIREMENTS[name].name} ${found.version || ''} was installed but is older than ${REQUIREMENTS[name].minimum}.`.replace('  ', ' ');
        else error = found.error || `${REQUIREMENTS[name].name} was installed but could not be found.`;
      }
      seen[name] = { ...seen[name], ...pick(found), error: ok ? (found.error || null) : error };
      busy[name] = null;
      persist();
      emit();
      return { ok, error, kind: result.kind || null };
    }));
  }

  /** Installs the named tools one after another. → { name: { ok, error } } */
  async function install(names) {
    const out = {};
    for (const name of names.filter((item) => TOOL_NAMES.includes(item))) out[name] = await installOne(name);
    return out;
  }

  /** The CLI's own sign-in in a hidden terminal; it opens the browser. Resolves when it ends (or after ten minutes). */
  async function signIn(name) {
    if (!AGENTS.includes(name) || !signInProcess || !records[name].path) return snapshot();
    if (signIns.has(name)) return snapshot();
    busy[name] = { action: 'sign-in', url: null };
    emit();
    const run = signInProcess(name, records[name].path, { onUrl: (url) => { if (busy[name]) { busy[name].url = url; emit(); } } });
    signIns.set(name, run);
    const timer = setTimer(() => run.kill(), SIGN_IN_MS);
    let exit = null;
    try { exit = await run.done; } finally { clearTimer(timer); signIns.delete(name); busy[name] = null; }
    await check([name]);
    if (records[name].signedIn !== true && exit && exit.output) {
      seen[name] = { ...seen[name], error: `Not signed in: ${exit.output}`.slice(0, 300) };
      persist();
      emit();
    }
    return snapshot();
  }

  function cancelSignIn(name) {
    const run = signIns.get(name);
    if (run) run.kill();
    return !!run;
  }

  /** The person's Skip (remembered per tool) and Ask again. */
  function skip(names) {
    const chosen = {};
    for (const name of names.filter((item) => TOOL_NAMES.includes(item))) chosen[name] = { skip: true };
    persist(chosen);
    emit();
    return snapshot();
  }
  function askAgain(name) {
    persist({ [name]: { skip: false } });
    emit();
    return snapshot();
  }
  function setUpdates(value) {
    persist({ updates: value === 'ask' ? 'ask' : 'auto' });
    emit();
    return snapshot();
  }

  /** Before a run: a program whose file is gone is looked for now; a check over ten minutes old is redone in the background. */
  async function ensure(name) {
    const record = records[name];
    if (!checked || busy[name]) return;
    let gone = false;
    try { gone = !!record.path && !fs.existsSync(record.path); } catch { gone = false; }
    if (gone) { await check([name]); return; }
    const age = record.checkedAt ? now().getTime() - Date.parse(record.checkedAt) : Infinity;
    if (age > STALE_MS) void check([name]).catch(() => {});
  }

  /** What a run holds while it runs: an install or update of the same program waits for it, and it for them. */
  function use(name, fn) {
    return locks[name].shared(fn);
  }

  /** The agents that can run a question right now, or null before the first check has finished. */
  function usableAgents() {
    if (!checked) return null;
    return AGENTS.filter((name) => records[name].installed && records[name].status === 'ready');
  }

  /**
   * What every program Engelbart starts gets besides its own environment: ENGELBART_GIT_BIN while Engelbart's own Git
   * stands in, and ENGELBART_AGENT_PATH (folders, joined by ":") while an agent is installed where PATH does not reach.
   * ENGELBART_CLAUDE_BIN / ENGELBART_CODEX_BIN: the full path of one whose name runs another copy, or nothing
   * (2026-09-30): the terminal's Claude Code and Codex items run it by that (../terminal/launch.cjs).
   */
  function environment() {
    const out = {};
    const git = records.git;
    // A path that is gone: the app moved (or the program was removed) since the last check; the next one finds it.
    const there = (file) => { try { return fs.existsSync(file); } catch { return false; } };
    if (git.source === 'bundled' && git.status === 'ready' && git.path && there(git.path)) out.ENGELBART_GIT_BIN = path.dirname(git.path);
    const folders = [...new Set(AGENTS.filter((name) => binaryFor(name) && there(records[name].path)).map((name) => path.dirname(records[name].path)))];
    if (folders.length) out.ENGELBART_AGENT_PATH = folders.join(':');
    for (const name of AGENTS) if (binaryFor(name) && there(records[name].path)) out[`ENGELBART_${name.toUpperCase()}_BIN`] = records[name].path;
    return out;
  }

  /** The full path to run a program by, when its name does not run it (PATH misses it, or reaches another copy first); else null. */
  function binaryFor(name) {
    const record = records[name];
    return record.onPath === false && record.path ? record.path : null;
  }

  /** The terminal's Claude Code / Codex menu, in the shape it has always had (src/main/terminal/provider-discovery.cjs). */
  async function providers(shellPath) {
    if (!checked && launch) await launch.catch(() => {});
    return [
      { id: 'shell', name: 'Shell', available: true, path: shellPath },
      ...AGENTS.map((name) => {
        const runs = records[name].installed && records[name].status !== 'failed';
        const alias = !runs && aliases.includes(name);
        return { id: name, name: REQUIREMENTS[name].name, available: runs || alias, path: runs ? records[name].path : alias ? 'shell alias/function' : null, authenticated: records[name].signedIn, checkedAt: records[name].checkedAt };
      }),
    ];
  }

  return { start, check, update, install, signIn, cancelSignIn, skip, askAgain, setUpdates, ensure, use, usableAgents, binaryFor, environment, providers, snapshot, canAutoUpdate };
}

module.exports = { createTools, STALE_MS, RETRY_UPDATE_MS };
