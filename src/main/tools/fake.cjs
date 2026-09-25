'use strict';

// Scripted runs only (ENGELBART_TOOLS_FAKE): a pretend machine, so the setup dialog can be driven
// without touching real installs. The spec names each tool's state:
//   {"git":"missing","claude":"2.1.300","codex":"0.150.0 signed-out"}
// "missing", "broken", or a version optionally followed by " signed-out". Installing takes `delayMs`
// and gives the tool its minimum version; updating does the same; signing in takes `delayMs` too.
// `failInstall` names tools whose install fails with a network error.

const { REQUIREMENTS, TOOL_NAMES } = require('./requirements.cjs');
const { observed } = require('./detect.cjs');

function parseSpec(value) {
  let input = {};
  try { input = typeof value === 'string' ? JSON.parse(value) : (value || {}); } catch { input = {}; }
  const state = {};
  for (const name of TOOL_NAMES) {
    const text = String(input[name] || (name === 'git' ? '2.50.1' : `${REQUIREMENTS[name].minimum}`)).trim();
    if (text === 'missing') state[name] = { present: false };
    else if (text === 'broken') state[name] = { present: true, broken: true };
    else { const [version, flag] = text.split(/\s+/); state[name] = { present: true, version, signedIn: flag !== 'signed-out' }; }
  }
  return { state, failInstall: Array.isArray(input.failInstall) ? input.failInstall : [] };
}

function createFakeTools(spec, { delayMs = 2500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => new Date() } = {}) {
  const { state, failInstall } = parseSpec(spec);
  const fakePath = (name) => (name === 'git' ? '/usr/bin/git' : `/Users/fake/.local/bin/${name}`);

  async function detect(only = TOOL_NAMES) {
    await sleep(Math.min(400, delayMs));
    const out = {};
    for (const name of only) {
      const tool = state[name];
      const found = !tool.present
        ? observed(name, {})
        : tool.broken
          ? observed(name, { file: fakePath(name), onPath: true, source: 'other', ran: false, error: `${REQUIREMENTS[name].name} did not start: exit status 1` })
          : observed(name, { file: fakePath(name), onPath: true, source: name === 'git' ? 'apple' : 'native', ran: true, version: tool.version, signedIn: name === 'git' ? null : tool.signedIn });
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
      state[name] = { present: true, version: REQUIREMENTS[name].minimum, signedIn: false };
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

  function signInProcess(name, _file, { onUrl }) {
    let finish = null;
    const done = new Promise((resolve) => { finish = resolve; });
    const timer = setTimeout(() => { onUrl(`https://example.invalid/${name}/sign-in`); }, 200);
    const complete = setTimeout(() => { state[name] = { ...state[name], signedIn: true }; finish({ code: 0, output: '' }); }, delayMs);
    return { done, kill: () => { clearTimeout(timer); clearTimeout(complete); finish({ code: 130, output: 'Cancelled.' }); } };
  }

  return { detect, actions, signInProcess, state };
}

module.exports = { createFakeTools, parseSpec };
