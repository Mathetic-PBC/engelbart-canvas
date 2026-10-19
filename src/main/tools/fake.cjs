'use strict';

// Scripted runs only (ENGELBART_TOOLS_FAKE): a pretend machine, so the setup dialog can be driven
// without touching real installs. The spec names each tool's state:
//   {"git":"missing","claude":"2.1.300","codex":"0.150.0 signed-out"}
// "missing", "broken", or a version optionally followed by " signed-out"; for git also "bundled" (the Git that
// came with Engelbart, standing in: ./bundled-git.cjs). Installing takes `delayMs`
// and gives the tool its minimum version; updating does the same; signing in takes `delayMs` too; signing out is quick.
// `failInstall` names tools whose install fails with a network error. A signed-in agent is signed in as FAKE_ACCOUNT.
// 2026-10-14 (onboarding's connect edge cases): " unknown" after a version is a CLI whose sign-in check does not answer
// (signedIn null, as `auth status` timing out); " no-plan" one signed in without a subscription; `signInNever` names
// agents whose sign-in waits in the browser until it is cancelled; `execFile` answers `claude auth status --json` for this
// machine (../onboarding/providers.cjs). `signInCode` (2026-10-19) names agents whose sign-in asks for the page's code
// and finishes once one is sent (./sign-in.cjs onCode, send).

const { REQUIREMENTS, TOOL_NAMES } = require('./requirements.cjs');
const { observed } = require('./detect.cjs');

const FAKE_ACCOUNT = 'researcher@example.com';

function parseSpec(value) {
  let input = {};
  try { input = typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { input = {}; }
  const state = {};
  for (const name of TOOL_NAMES) {
    const text = String(input[name] || (name === 'git' ? '2.50.1' : `${REQUIREMENTS[name].minimum}`)).trim();
    if (text === 'missing') state[name] = { present: false };
    else if (text === 'bundled' && name === 'git') state[name] = { present: true, bundled: true, version: '2.53.0' };
    else if (text === 'broken') state[name] = { present: true, broken: true };
    else { const [version, flag] = text.split(/\s+/); state[name] = { present: true, version, signedIn: flag === 'unknown' ? null : flag !== 'signed-out', plan: flag === 'no-plan' ? null : name === 'codex' ? 'plus' : 'max' }; }
  }
  return { state, failInstall: Array.isArray(input.failInstall) ? input.failInstall : [], signInNever: Array.isArray(input.signInNever) ? input.signInNever : [], signInCode: Array.isArray(input.signInCode) ? input.signInCode : [] };
}

function createFakeTools(spec, { delayMs = 2500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => new Date() } = {}) {
  const { state, failInstall, signInNever, signInCode } = parseSpec(spec);
  /** The pretend machine as it started (test mode's reset, 2026-10-15: its installs stayed, so setup never showed again). */
  const reset = () => { const fresh = parseSpec(spec).state; for (const name of Object.keys(state)) state[name] = fresh[name]; };
  const fakePath = (name) => (name === 'git' ? (state.git.bundled ? '/Users/fake/Applications/Engelbart.app/Contents/Resources/git/engelbart-bin/git' : '/usr/bin/git') : `/Users/fake/.local/bin/${name}`);

  async function detect(only = TOOL_NAMES) {
    await sleep(Math.min(400, delayMs));
    const out = {};
    for (const name of only) {
      const tool = state[name];
      const found = !tool.present
        ? observed(name, {})
        : tool.broken
          ? observed(name, { file: fakePath(name), onPath: true, source: 'other', ran: false, error: `${REQUIREMENTS[name].name} did not start: exit status 1` })
          : observed(name, { file: fakePath(name), onPath: !tool.bundled, source: name === 'git' ? (tool.bundled ? 'bundled' : 'apple') : 'native', ran: true, version: tool.version, signedIn: name === 'git' ? null : tool.signedIn, account: FAKE_ACCOUNT });
      out[name] = { ...found, checkedAt: now().toISOString() };
    }
    return out;
  }

  const actions = {
    async installGit({ onPhase = () => {} } = {}) {
      onPhase('Waiting for Apple’s installer');
      await sleep(delayMs);
      if (failInstall.includes('git')) return { ok: false, kind: 'cancelled', error: 'Apple’s installer was closed before it finished.' };
      state.git = { present: true, version: '2.50.1' };
      return { ok: true };
    },
    async installAgent(name) {
      await sleep(delayMs);
      if (failInstall.includes(name)) return { ok: false, kind: 'network', error: 'The installer could not be reached: no internet connection (curl: (6) Could not resolve host: claude.ai).' };
      state[name] = { present: true, version: REQUIREMENTS[name].minimum, signedIn: false, plan: name === 'codex' ? 'plus' : 'max' };
      return { ok: true };
    },
    async updateAgent(name) {
      await sleep(delayMs);
      state[name] = { ...state[name], present: true, broken: false, version: REQUIREMENTS[name].minimum };
      return { ok: true };
    },
    async updateGit() {
      return { ok: false, kind: 'other', error: 'Apple’s Git is updated by macOS: System Settings › General › Software Update.' };
    },
  };

  function signInProcess(name, _file, { onUrl, onCode = () => {} }) {
    let finish = null;
    const done = new Promise((resolve) => { finish = resolve; });
    const asks = signInCode.includes(name);
    const timer = setTimeout(() => { onUrl(`https://example.invalid/${name}/sign-in${asks ? '?code=true' : ''}`); if (asks) onCode(); }, 200);
    const signedIn = () => { state[name] = { ...state[name], signedIn: true }; finish({ code: 0, output: '' }); };
    const complete = signInNever.includes(name) || asks ? null : setTimeout(signedIn, delayMs);
    const send = (code) => { if (!asks || !code) return false; setTimeout(signedIn, Math.min(400, delayMs)); return true; };
    return { done, send, kill: () => { clearTimeout(timer); clearTimeout(complete); finish({ code: 130, output: 'Cancelled.' }); } };
  }

  async function signOutProcess(name) {
    await sleep(Math.min(400, delayMs));
    state[name] = { ...state[name], signedIn: false };
    return { code: 0, output: '' };
  }

  /** `claude auth status --json` as execFile answers it (callback(error, stdout)): what this machine's Claude Code says. */
  function execFile(_file, args, _options, callback) {
    const tool = state.claude;
    setTimeout(() => {
      if (!tool.present || tool.broken || !Array.isArray(args) || args[0] !== 'auth') { callback(Object.assign(new Error('not found'), { code: 'ENOENT' }), ''); return; }
      if (tool.signedIn === null) { callback(Object.assign(new Error('timed out'), { killed: true }), ''); return; }
      callback(null, JSON.stringify(tool.signedIn ? { loggedIn: true, authMethod: 'claude.ai', email: FAKE_ACCOUNT, subscriptionType: tool.plan || null } : { loggedIn: false, authMethod: 'none' }));
    }, 20);
    return null;
  }

  return { detect, actions, signInProcess, signOutProcess, execFile, state, reset };
}

module.exports = { createFakeTools, parseSpec, FAKE_ACCOUNT };
