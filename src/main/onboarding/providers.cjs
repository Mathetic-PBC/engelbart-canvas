'use strict';

// Which of Claude Code and Codex runs onboarding's agents (2026-10-13; the rule is shared/import-flow.cjs chooseProvider).
// The model is never chosen (Connect pins Sonnet high and Sol high); only the provider is, and only when the person has a
// subscription to both. What is read, never a token:
//   installed / signed in   the tool check's records (../tools/manager.cjs)
//   subscription            Claude Code: `claude auth status --json` → subscriptionType ("max", "pro"; null on an API key
//                           or none). Codex: the plan named in its own sign-in file's ID token (chatgpt_plan_type: "plus",
//                           "pro", "team"…; "free" counts as none), decoded unverified, as ../tools/detect.cjs reads the
//                           account's address.
//   seniority (since)       when the CLI's own folder was made (~/.claude, $CODEX_HOME or ~/.codex): the one used longest.
// ENGELBART_PROVIDERS_FAKE ('both' | 'claude' | 'codex' | 'free' | 'none') stands in for this Mac in scripted runs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { sanitizeEnvironment } = require('../terminal/launch.cjs');
const { scrubAgentSession } = require('../shell-rc.cjs');
const { chooseProvider, PROVIDER_NAMES } = require('../../shared/import-flow.cjs');

const AUTH_TIMEOUT_MS = 15_000;
const CACHE_MS = 60_000;
const PAID = /^(plus|pro|team|business|enterprise|edu|max)/i;

const TOOL_OF = { anthropic: 'claude', openai: 'codex' };

/** Codex's plan from its sign-in file → its name, or null (none, free, or no file). */
function codexPlan({ env = process.env, home = os.homedir() } = {}) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), 'utf8'));
    const token = auth && auth.tokens && auth.tokens.id_token;
    if (typeof token !== 'string') return null;
    const claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    const plan = claims && claims['https://api.openai.com/auth'] && claims['https://api.openai.com/auth'].chatgpt_plan_type;
    return typeof plan === 'string' && PAID.test(plan) ? plan.toLowerCase().slice(0, 24) : null;
  } catch {
    return null;
  }
}

/** Claude Code's `auth status --json` text → { loggedIn, plan } (plan: its subscription's name, or null), or null when unreadable. */
function claudeAuth(text) {
  const raw = String(text || '');
  try {
    const status = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    if (!status || typeof status.loggedIn !== 'boolean') return null;
    if (status.loggedIn !== true) return { loggedIn: false, plan: null };
    const plan = (!status.authMethod || status.authMethod === 'claude.ai') && typeof status.subscriptionType === 'string' && status.subscriptionType ? status.subscriptionType.toLowerCase().slice(0, 24) : null;
    return { loggedIn: true, plan };
  } catch {
    return null;
  }
}
/** Claude Code's `auth status --json` text → its plan's name, or null. */
const claudePlan = (text) => { const auth = claudeAuth(text); return auth ? auth.plan : null; };

/** Whether Codex's sign-in file holds a ChatGPT sign-in (an ID token): what `codex login status` says, read without running it. */
function codexSignedIn({ env = process.env, home = os.homedir() } = {}) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'), 'utf8'));
    return !!(auth && auth.tokens && typeof auth.tokens.id_token === 'string' && auth.tokens.id_token);
  } catch {
    return false;
  }
}

/**
 * Where a provider's CLI is, in the words the window shows (2026-10-14: "it says installing claude code, even if it is
 * already installed. it should say connecting instead"): 'connecting' while Engelbart installs, checks or updates it,
 * 'signing-in' while its sign-in waits for the browser, 'ready', else 'not-connected' (missing, signed out, not working).
 */
function stateOf(record, signedIn) {
  const busy = record.busy || null;
  if (busy && busy.action === 'sign-in') return 'signing-in';
  if (busy && (busy.action === 'install' || busy.action === 'check' || busy.action === 'update')) return signedIn ? 'ready' : 'connecting';
  if (record.status === 'installing' || record.status === 'checking' || record.status === 'unknown') return 'connecting';
  return signedIn ? 'ready' : 'not-connected';
}

/** When a folder was made (its birth time, else its change time), in ms, or null. */
function bornAt(dir) {
  try { const stat = fs.statSync(dir); return Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs; } catch { return null; }
}

const FAKES = {
  both: { anthropic: 'max', openai: 'pro' },
  claude: { anthropic: 'max', openai: null },
  codex: { anthropic: null, openai: 'plus' },
  free: { anthropic: null, openai: null },
};

/**
 * `tools` the tool manager (snapshot()); `prefs` { get(), set(patch) } for the remembered pick; `run` execFile or a fake.
 * → { status() → { providers, decision, names }, remember(id) }
 */
function createProviders({ tools, prefs, homeDir = os.homedir(), environment = process.env, run = execFile, fake = process.env.ENGELBART_PROVIDERS_FAKE || '', now = () => Date.now() }) {
  let cache = null;

  function claudeStatus(file) {
    return new Promise((resolve) => {
      const env = { ...sanitizeEnvironment(scrubAgentSession(environment)), ...(tools && tools.environment ? tools.environment() : {}) };
      try {
        run(file, ['auth', 'status', '--json'], { env, timeout: AUTH_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve(error && !stdout ? '' : String(stdout || '')));
      } catch { resolve(''); }
    });
  }

  async function read() {
    if (fake) {
      if (fake === 'none') return ['anthropic', 'openai'].map((id) => ({ id, name: PROVIDER_NAMES[id], installed: true, signedIn: false, subscription: null, since: null, state: 'not-connected' }));
      const plans = FAKES[fake] || FAKES.claude;
      return ['anthropic', 'openai'].map((id, n) => ({ id, name: PROVIDER_NAMES[id], installed: true, signedIn: true, subscription: plans[id], since: n === 0 ? 1_700_000_000_000 : 1_710_000_000_000, state: 'ready' }));
    }
    const snap = tools && tools.snapshot ? tools.snapshot() : null;
    const record = (id) => (snap && snap.tools && snap.tools[TOOL_OF[id]]) || {};
    const out = [];
    for (const id of ['anthropic', 'openai']) {
      const r = record(id);
      const installed = !!r.installed && !(r.busy && r.busy.action === 'install');
      // Updating itself in the background (or about to) counts: the update never holds onboarding (2026-10-13).
      const works = r.status === 'ready' || r.status === 'updating' || (r.status === 'outdated' && r.autoUpdate === true);
      // Signed in only when the CLI says so (2026-10-14): a check that could not tell (`signedIn: null`, e.g. `auth status`
      // timing out on a fresh Mac's first run) counted as signed in, and every agent then failed with "Not logged in".
      // Claude Code is asked now (its answer also names the plan); Codex's own sign-in file is read when its check could not tell.
      let signedIn = installed && works && r.signedIn === true;
      let subscription = null;
      if (installed && works && id === 'anthropic' && r.path) {
        const auth = claudeAuth(await claudeStatus(r.path));
        if (auth) { signedIn = auth.loggedIn; subscription = auth.plan; }
      }
      if (installed && works && id === 'openai') {
        if (r.signedIn !== true && r.signedIn !== false) signedIn = codexSignedIn({ env: environment, home: homeDir });
        if (signedIn) subscription = codexPlan({ env: environment, home: homeDir });
      }
      const since = bornAt(id === 'anthropic' ? path.join(homeDir, '.claude') : (environment.CODEX_HOME || path.join(homeDir, '.codex')));
      out.push({ id, name: PROVIDER_NAMES[id], installed, signedIn, subscription, since, account: r.account || null, status: r.status || 'missing', state: stateOf(r, signedIn), error: signedIn ? null : (r.error || null) });
    }
    return out;
  }

  /** → { providers, decision: chooseProvider's answer, remembered } (a minute's cache; `fresh` reads again). */
  async function status({ fresh = false } = {}) {
    if (!fresh && cache && now() - cache.at < CACHE_MS) return withDecision(cache.providers);
    const providers = await read();
    cache = { at: now(), providers };
    return withDecision(providers);
  }

  function withDecision(providers) {
    const remembered = (prefs.get() || {}).provider || null;
    return { providers, decision: chooseProvider(providers, remembered), remembered };
  }

  /** The person picked `id` (both subscribed): remembered, so they are not asked again. */
  function remember(id) {
    if (!TOOL_OF[id]) throw new TypeError('provider is invalid');
    prefs.set({ provider: id });
    return status();
  }

  const forget = () => { cache = null; };

  /** An agent on `id` failed as one that needs the person (../connect/provider-failure.cjs): its CLI is checked again now. */
  function recheck(id) {
    cache = null;
    const name = TOOL_OF[id];
    if (!name || fake || !tools || typeof tools.check !== 'function') return Promise.resolve(null);
    return Promise.resolve().then(() => tools.check([name])).catch(() => null).then(() => { cache = null; return status({ fresh: true }); });
  }

  /** Whether `id` can run onboarding's agents now (read fresh). */
  async function ready(id) {
    const out = await status({ fresh: true });
    return out.providers.some((one) => one.id === id && one.installed && one.signedIn);
  }

  return { status, remember, forget, recheck, ready };
}

module.exports = { createProviders, codexPlan, claudePlan, claudeAuth, codexSignedIn, stateOf, bornAt };
