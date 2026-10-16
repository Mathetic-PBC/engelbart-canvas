'use strict';

// Import your context's two discovery agents (2026-10-13, the "Onboarding" workspace):
//
// Recent projects ("What project do you want to work on first?"): starts the moment Import context is pressed, before
// the import method is chosen ("it should not even wait for them to select manual or agent driven"). What the person
// worked on lately is gathered here without a model (a digest: the folders their Claude Code and Codex sessions ran in
// and those sessions' titles, the repositories they were in, the notes their Obsidian vaults changed lately, their Zotero
// collections), then one agent on the provider chosen for onboarding names 1-5 projects as JSON with "a concise and
// easy-to-parse title". It has no tools: the digest is all it reads, so it answers in well under a minute.
//
// Tools ("Confirm your tools"): starts when the person chooses to let agents import. "For anything that can be found
// deterministically (i.e. Obsidian or local things, just do that)": the apps on this Mac (../connect/scan.cjs detect),
// the desktop apps installed, each web app's sign-in cookie in the person's chosen browser (its name only: no Keychain),
// and how often their history visits each app's sites. Then, with their leave to use that browser's sign-ins, the web
// apps they are signed in to are brought into Engelbart's browser, and an agent with the survey's read-only tools
// (browser history and bookmarks, and the apps' own pages in that hidden browser: "using the user's login in their
// browsers in the background using browser use without any plugin") says which catalog tools they use and lists any
// others it sees (shared/import-flow.cjs readTools). The local finds stand whatever it says.
//
// Both are kept per data root in <dataRoot>/.connect/discovery.json, so a relaunch (Full Disk Access needs one) shows
// what was found, and every change goes to the window as `engelbart:discovery`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const readers = require('../connect/readers.cjs');
const scan = require('../connect/scan.cjs');
const { createImportTools } = require('../connect/tools.cjs');
const { connectChoice } = require('../connect/session.cjs');
const { APPS, SIGN_IN_COOKIES, shownName } = require('../../shared/connect-sources.cjs');
const { CATALOG, GROUPS, LOCAL_FOLDERS, SITES, PROVIDER_IDS, browserById, readProjects, readTools } = require('../../shared/import-flow.cjs');
const prompts = require('./prompts.cjs');
const { projectDigest, digestEmpty, DIGEST_DAYS } = require('./digest.cjs');
const { accessSpec } = require('../connect/offthread.cjs');
const { needsProvider } = require('../connect/provider-failure.cjs');

const FILE = 'discovery.json';
const HISTORY_DAYS = 90;
const SIGN_IN_TIMEOUT_MS = 20_000;

const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/* ------------------------------------------------------------------------------------------------- the project digest */

// ./digest.cjs (the scanner process runs it: ../connect/scan-child.cjs).

/* ------------------------------------------------------------------------------------------------- the tool evidence */

// The desktop apps that say a tool is used (../connect/scan.cjs keeps the same list for the picker).
const DESKTOP = { ChatGPT: ['ChatGPT.app'], Claude: ['Claude.app'], Granola: ['Granola.app'], Notion: ['Notion.app'], Evernote: ['Evernote.app'], OneNote: ['Microsoft OneNote.app'], Perplexity: ['Perplexity.app'], Cursor: ['Cursor.app'], Zoom: ['zoom.us.app'], Obsidian: ['Obsidian.app'], 'Google Docs': ['Google Drive.app'], Zotero: ['Zotero.app'], Overleaf: [], Grok: [] };

/** A browser's most visited sites, from its history file (Chromium, Firefox, or Safari with Full Disk Access) → [{ host, visits }]. */
async function historySites({ homeDir, browserId, days = HISTORY_DAYS, run = execFile }) {
  const sqlite = async (file, query) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-history-'));
    try {
      const copy = path.join(scratch, path.basename(file));
      await fs.promises.copyFile(file, copy);
      if (exists(`${file}-wal`)) await fs.promises.copyFile(`${file}-wal`, `${copy}-wal`);
      const out = await new Promise((resolve, reject) => { run('sqlite3', ['-json', '-readonly', copy, query], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))); });
      return JSON.parse(String(out || '').trim() || '[]');
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  };
  const tally = (rows) => {
    const sites = new Map();
    for (const row of rows) { const host = hostOf(row.url); if (host) sites.set(host, (sites.get(host) || 0) + (Number(row.visits) || 1)); }
    return [...sites.entries()].map(([host, visits]) => ({ host, visits })).sort((a, b) => b.visits - a.visits).slice(0, 400);
  };
  const browser = browserById(browserId);
  if (!browser) return [];
  if (browserId === 'firefox') {
    const root = path.join(homeDir, 'Library', 'Application Support', 'Firefox', 'Profiles');
    let profiles = [];
    try { profiles = fs.readdirSync(root).map((name) => path.join(root, name, 'places.sqlite')).filter(exists); } catch { profiles = []; }
    const since = (Date.now() - days * 864e5) * 1000;
    const rows = [];
    for (const file of profiles.slice(0, 3)) { try { rows.push(...await sqlite(file, `SELECT url, visit_count AS visits FROM moz_places WHERE last_visit_date > ${since} ORDER BY visit_count DESC LIMIT 5000;`)); } catch { /* locked */ } }
    return tally(rows);
  }
  if (browserId === 'safari') {
    const file = path.join(homeDir, 'Library', 'Safari', 'History.db');
    const since = (Date.now() / 1000) - 978307200 - days * 86400;
    try { return tally(await sqlite(file, `SELECT i.url AS url, COUNT(v.id) AS visits FROM history_items i JOIN history_visits v ON v.history_item = i.id WHERE v.visit_time > ${since} GROUP BY i.id ORDER BY visits DESC LIMIT 5000;`)); } catch { return []; } // Full Disk Access not given
  }
  const profiles = readers.browserProfiles(homeDir).filter((profile) => profile.browser.toLowerCase() === browser.name.toLowerCase());
  const rows = [];
  for (const profile of profiles.slice(0, 4)) {
    try { rows.push(...(await readers.browserHistory(profile.dir, { days, limit: 400, by: 'site', run })).map((site) => ({ url: `https://${site.host}/`, visits: site.visits }))); } catch { /* locked or none */ }
  }
  return tally(rows);
}

const sitesOf = (app) => (APPS[app] && APPS[app].sites) || [];
// The hosts that show an app itself is used, for apps whose sites are shared with others (2026-10-13: OneNote was ticked
// for 151 visits to Outlook on live.com, Gemini for the google.com sign-in every Google app has). An app not here is told
// by its own sites.
const USAGE_SITES = Object.freeze({
  OneNote: ['onenote.com', 'onenote.cloud.microsoft'],
  'Google Docs': ['docs.google.com', 'drive.google.com'],
  'Google Meet': ['meet.google.com'],
  Gmail: ['mail.google.com'],
  Gemini: ['gemini.google.com'],
  Grok: ['grok.com'],
  ChatGPT: ['chatgpt.com', 'chat.openai.com'],
  Claude: ['claude.ai'],
});
const usageSitesOf = (app) => USAGE_SITES[app] || sitesOf(app);
const visitsTo = (sites, app) => sites.filter((site) => usageSitesOf(app).some((domain) => site.host === domain || site.host.endsWith(`.${domain}`))).reduce((n, site) => n + site.visits, 0);
// A sign-in cookie on a domain other apps share (google.com) says the person has the account, not that they use this app.
const sharedSignIn = (app) => Object.keys(SIGN_IN_COOKIES).some((other) => other !== app && SIGN_IN_COOKIES[other][0] === (SIGN_IN_COOKIES[app] || [])[0]);

/**
 * What can be told without a model → { evidence: { [toolId]: { used, method, evidence } }, sites: [{ host, visits }] }.
 * `cookies(app)` → whether the chosen browser holds the app's sign-in cookie (names only).
 */
async function toolEvidence({ homeDir, env = process.env, browserId, access = null, github = null, zotero = null, connectors = null, cookies = () => false, applications = ['/Applications', path.join(homeDir, 'Applications')], run = execFile, detected: given = null }) {
  const evidence = {};
  const set = (id, used, method, text) => { evidence[id] = { used: !!used, method, evidence: text }; };
  // `detected`: scan.detect's answer, read in the scanner process (../connect/scan-child.cjs) so the window never waits.
  let detected = given || { apps: {}, localRepos: [] };
  if (!given) { try { detected = scan.detect({ homeDir, env, access, zotero: () => (zotero ? zotero.status() : null), github: () => (github ? github.status() : null), connectors: (app) => !!(connectors && connectors.status(app).connected), applications }); } catch { /* nothing found */ } }
  const appInstalled = (app) => (DESKTOP[app] || []).some((bundle) => applications.some((dir) => exists(path.join(dir, bundle))));
  const sites = await historySites({ homeDir, browserId, run }).catch(() => []);
  const browserName = (browserById(browserId) || {}).name || 'your browser';
  for (const tool of CATALOG) {
    const id = tool.id;
    if (id === SITES) { set(id, sites.length > 0, 'local', sites.length ? `${browserName} history on this Mac` : 'No history found'); continue; }
    if (id === LOCAL_FOLDERS) { const repos = Array.isArray(detected.localRepos) ? detected.localRepos : []; set(id, repos.length > 0, 'local', repos.length ? `${repos.length} repositories on this Mac` : ''); continue; }
    if (id === 'GitHub') {
      const signed = github && github.status().connected;
      const repos = Array.isArray(detected.localRepos) ? detected.localRepos.length : 0;
      set(id, signed || repos > 0 || visitsTo(sites, 'GitHub') > 0 || sites.some((site) => site.host === 'github.com'), signed ? 'local' : 'history', signed ? 'Signed in to Engelbart' : repos ? `${repos} repositories on this Mac` : 'In your browser history');
      continue;
    }
    const found = detected.apps && detected.apps[id];
    if (tool.local && found && found.found) { set(id, true, 'local', found.where ? `Found on this Mac (${found.where})` : 'Found on this Mac'); continue; }
    if (tool.local) { set(id, false, 'local', ''); continue; }
    const visits = visitsTo(sites, id);
    if (SIGN_IN_COOKIES[id] && (!sharedSignIn(id) || visits > 0) && cookies(id)) { set(id, true, 'cookie', `Signed in in ${browserName}`); continue; }
    if (visits >= 3) { set(id, true, 'history', `${visits} visits in ${browserName} lately`); continue; }
    if (appInstalled(id)) { set(id, true, 'app', 'Its app is installed'); continue; }
    if (found && found.found) { set(id, true, 'app', found.where || 'Found on this Mac'); continue; }
    set(id, false, 'none', visits ? `${visits} visits lately` : '');
  }
  return { evidence, sites: sites.slice(0, 80) };
}

/* ------------------------------------------------------------------------------------------------------ the module */

/**
 * `agents` ({ turn }, traced); `models()` Build's model list; `context()` the store's; `prefs` (./prefs.cjs, by data root);
 * `providers` (./providers.cjs); `browsers` (./browsers.cjs); `webSignIn` (../connect/web-signin.cjs); `cookieImport`
 * (../browser/import-cookies.cjs: cookie names only, here); `agentBrowser` (../connect/browser.cjs); `openBridge`;
 * `zotero`, `github`, `connectors`, `deps` as Connect's; `notify(state)`; `trace` (./trace.cjs).
 */
function createDiscovery({ agents, models = () => null, context, homeDir, env = process.env, providers, webSignIn = null, cookieImport = null, agentBrowser = null, openBridge = null, zotero = null, zoteroRoot = () => null, github = null, connectors = null, deps = {}, notify = () => {}, trace = null, access = () => null, existingProjects = () => [], scanner = null, now = () => new Date().toISOString() }) {
  const roots = new Map(); // dataRoot → { projects, tools, controllers }

  const fileOf = (dataRoot) => path.join(dataRoot, '.connect', FILE);
  function stateOf(dataRoot) {
    if (!roots.has(dataRoot)) {
      let saved = {};
      try { saved = JSON.parse(fs.readFileSync(fileOf(dataRoot), 'utf8')) || {}; } catch { saved = {}; }
      const settle = (part) => (part && (part.status === 'running' || part.status === 'checking') ? { ...part, status: 'stale' } : part || { status: 'idle' });
      roots.set(dataRoot, { projects: settle(saved.projects), tools: settle(saved.tools), controllers: {} });
    }
    return roots.get(dataRoot);
  }
  const publicOf = (st) => ({ projects: { ...st.projects }, tools: { ...st.tools } });
  function changed(dataRoot) {
    const st = stateOf(dataRoot);
    try {
      fs.mkdirSync(path.dirname(fileOf(dataRoot)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(fileOf(dataRoot), JSON.stringify({ projects: st.projects, tools: { ...st.tools, sites: undefined } }, null, 1), { mode: 0o600 });
    } catch { /* shown, if not kept */ }
    notify(publicOf(st));
  }
  const say = (kind, text, detail) => { if (trace) trace.event({ kind, text, detail }); };

  // The provider to run on, or null when none can run now. One the window names is used only while its CLI can run
  // (2026-10-14: Try again re-ran a signed-out Claude Code forever, each time "Not logged in"); then it is the one the
  // person is asked to connect (`connect` on the 'waiting-provider' state).
  async function provider(asked) {
    const out = await providers.status({ fresh: true });
    const ready = (id) => out.providers.some((one) => one.id === id && one.installed && one.signedIn);
    if (PROVIDER_IDS.includes(asked)) return ready(asked) ? { id: asked } : { id: null, connect: asked };
    return out.decision.pick ? { id: out.decision.pick } : { id: null, connect: null };
  }
  // An agent's failure that connecting the provider fixes (../connect/provider-failure.cjs): its CLI is checked again, so
  // the window's rows and the next decision say what the CLI says.
  const failure = (error, chosen, fallback) => {
    const text = String((error && error.message) || fallback).slice(0, 300);
    if (!needsProvider(error)) return { error: text };
    if (providers && typeof providers.recheck === 'function') void providers.recheck(chosen);
    return { error: text, connect: chosen };
  };

  /** The state now, for the window → { projects, tools } */
  async function state() {
    const ctx = await context();
    return publicOf(stateOf(ctx.dataRoot));
  }

  /**
   * Recent projects, found in the background. Running or done with the same provider: left as it is (`again` runs it
   * again). No provider yet (both subscribed and none picked, or none signed in): 'waiting-provider'.
   */
  async function startProjects({ provider: asked = null, again = false } = {}) {
    const ctx = await context();
    const st = stateOf(ctx.dataRoot);
    const pick = await provider(asked);
    const chosen = pick.id;
    if (!chosen) { if (st.projects.status !== 'done' || again) { st.projects = { status: 'waiting-provider', projects: st.projects.projects || [], connect: pick.connect }; changed(ctx.dataRoot); } return publicOf(st); }
    if (!again && (st.projects.status === 'running' || (st.projects.status === 'done' && st.projects.provider === chosen))) return publicOf(st);
    if (st.controllers.projects) st.controllers.projects.abort();
    const controller = new AbortController();
    st.controllers.projects = controller;
    st.projects = { status: 'running', provider: chosen, projects: st.projects.projects || [], started: now() };
    changed(ctx.dataRoot);
    void (async () => {
      const existing = await Promise.resolve().then(() => existingProjects(ctx)).catch(() => []);
      const args = { homeDir, zoteroRoot: zoteroRoot(), existing: Array.isArray(existing) ? existing : [] };
      // Off the main process (5 s of session files on a busy Mac froze the window between screens).
      const digest = scanner
        ? await scanner.run('projectDigest', { ...args, access: accessSpec(access(ctx), ctx.dataRoot) }).catch(() => projectDigest({ ...args, env, access: access(ctx) }))
        : projectDigest({ ...args, env, access: access(ctx) });
      if (controller.signal.aborted) return;
      say('discovery', `Looking for recent projects with ${chosen === 'openai' ? 'Codex' : 'Claude Code'}`, { folders: digest.folders.length, repos: (digest.repos || []).length, vaults: digest.vaults.length, zotero: digest.zotero.length });
      // Nothing on this Mac to name projects from (a new account, 2026-10-15): no model asked, and not a failure: the
      // person adds their own. Try again would only find nothing again.
      if (digestEmpty(digest)) {
        st.projects = { status: 'done', provider: chosen, projects: [], empty: true, started: st.projects.started, ended: now() };
        if (st.controllers.projects === controller) st.controllers.projects = null;
        changed(ctx.dataRoot);
        return;
      }
      const choice = connectChoice(chosen, (() => { try { return models(); } catch { return null; } })());
      const message = [
        `<recent_work note="Read on this Mac without a model, the last ${DIGEST_DAYS} days.">\n${JSON.stringify(digest, null, 1)}\n</recent_work>`,
        `Today is ${now().slice(0, 10)}.`,
        'Name their recent projects now, as the JSON object only.',
      ].join('\n\n');
      try {
        const out = await agents.turn({ choice, kind: 'projects', system: prompts.PROJECTS_SYSTEM_PROMPT, message, session: null, dirs: [], signal: controller.signal, meta: { kind: 'projects', label: 'Recent projects', digest } });
        const read = readProjects(out.text);
        if (controller.signal.aborted) return;
        // Named none (nothing it saw was a project): done with none, as an empty Mac is, not a failure to try again.
        st.projects = read ? { status: 'done', provider: chosen, projects: read.projects, ...(read.projects.length ? {} : { empty: true }), started: st.projects.started, ended: now() } : { status: 'failed', provider: chosen, projects: [], error: 'The agent did not answer as asked.', ended: now() };
      } catch (error) {
        if (controller.signal.aborted) return;
        // What an earlier run found stays on screen (2026-10-14: a run again that failed emptied the list).
        st.projects = { status: 'failed', provider: chosen, projects: st.projects.projects || [], ...failure(error, chosen, 'The agent did not answer.'), ended: now() };
      } finally {
        if (st.controllers.projects === controller) st.controllers.projects = null;
      }
      changed(ctx.dataRoot);
    })();
    return publicOf(st);
  }

  /**
   * Which tools the person uses. The evidence first (shown at once, `status: 'checking'`), then — with their leave to use
   * `browserId`'s sign-ins (`keychain` 'allowed') — the web apps signed in there brought into Engelbart's browser, then the
   * agent. A failure keeps the evidence (status 'done', `error` saying the agent did not finish).
   */
  async function startTools({ provider: asked = null, browserId = null, keychain = null, again = false } = {}) {
    const ctx = await context();
    const st = stateOf(ctx.dataRoot);
    const pick = await provider(asked);
    const chosen = pick.id;
    if (!chosen) { if (st.tools.status !== 'done' || again) { st.tools = { status: 'waiting-provider', results: st.tools.results || null, evidence: st.tools.evidence, connect: pick.connect }; changed(ctx.dataRoot); } return publicOf(st); }
    // A run that ended needing its provider connected (`connect`) runs again once it is.
    if (!again && (st.tools.status === 'checking' || (st.tools.status === 'done' && !st.tools.connect && st.tools.provider === chosen && st.tools.browser === browserId))) return publicOf(st);
    if (st.controllers.tools) st.controllers.tools.abort();
    const controller = new AbortController();
    st.controllers.tools = controller;
    st.tools = { status: 'checking', provider: chosen, browser: browserId, results: null, started: now() };
    changed(ctx.dataRoot);
    void (async () => {
      const browser = browserById(browserId);
      const holds = (app) => {
        if (!cookieImport || !browser || !SIGN_IN_COOKIES[app]) return false;
        try {
          const [domain, pattern] = SIGN_IN_COOKIES[app];
          const source = (cookieImport.sources() || []).find((one) => one.id === browserId);
          if (!source) return false;
          return source.profiles.some((profile) => cookieImport.cookieNames(source.id, profile.id, [domain]).some((entry) => entry.domain === domain && pattern.test(entry.name)));
        } catch { return false; }
      };
      let detected = null;
      if (scanner) {
        const connected = {};
        for (const [app, entry] of Object.entries(APPS)) {
          if (entry.reach !== 'connector') continue;
          try { connected[app] = !!(connectors && connectors.status(app).connected); } catch { connected[app] = false; }
        }
        detected = await scanner.run('detect', { homeDir, access: accessSpec(access(ctx), ctx.dataRoot), zotero: zotero ? zotero.status() : null, github: github ? github.status() : null, connectors: connected }).catch(() => null);
        if (controller.signal.aborted) return;
      }
      const { evidence, sites } = await toolEvidence({ homeDir, env, browserId, access: access(ctx), github, zotero, connectors, cookies: holds, detected });
      if (controller.signal.aborted) return;
      st.tools = { ...st.tools, results: readTools('', evidence), evidence };
      changed(ctx.dataRoot);
      say('discovery', `Tools found without a model: ${Object.entries(evidence).filter(([, fact]) => fact.used).map(([id]) => shownName(id)).join(', ') || 'none'}`, evidence);
      // Their leave given: the sign-ins the chosen browser holds come into Engelbart's browser now (one macOS prompt for
      // a Chromium browser's key), for the agent's look and for the imports after it.
      const signedIn = [];
      if (keychain === 'allowed' && webSignIn) {
        for (const app of Object.keys(evidence).filter((id) => evidence[id].method === 'cookie')) {
          if (controller.signal.aborted) return;
          try {
            const out = await Promise.race([webSignIn.signInQuiet(app), new Promise((resolve) => { setTimeout(() => resolve(null), SIGN_IN_TIMEOUT_MS); })]);
            if (out && out.signedIn) signedIn.push(app);
          } catch { /* left to the import's needs */ }
        }
        if (signedIn.length) say('discovery', `Signed in to ${signedIn.map(shownName).join(', ')} in Engelbart's browser`);
      }
      const choice = connectChoice(chosen, (() => { try { return models(); } catch { return null; } })());
      const catalog = CATALOG.map((tool) => ({ id: tool.id, name: tool.name, sites: sitesOf(tool.id) }));
      const message = [
        `<catalog note="The tools Engelbart can import from. Answer for every id.">\n${JSON.stringify(catalog)}\n</catalog>`,
        `<evidence note="Found without a model. method local: read on this Mac (it stands); cookie: signed in in their browser; history: visits lately; app: its desktop app is installed.">\n${JSON.stringify(evidence, null, 1)}\n</evidence>`,
        `<browser>${browser ? browser.name : 'none'}${signedIn.length ? `; signed in to ${signedIn.join(', ')} in Engelbart's browser, which browser_open uses` : ''}</browser>`,
        `<top_sites note="Their most visited sites lately, for tools not in the catalog.">\n${JSON.stringify(sites.slice(0, 80))}\n</top_sites>`,
        // From Amitav (2026-10-15): the tools screen is the picker's categories, with every extra tool put in one of them.
        `<categories note="Every tool in additional goes in one of these, by id; other when none fits.">\n${JSON.stringify(GROUPS.map((group) => ({ id: group.id, label: group.label })))}\n</categories>`,
        'Say which tools they use now, as the JSON object only.',
      ].join('\n\n');
      let bridge = null;
      const job = { id: `discover-${Date.now()}`, label: 'Checking your tools' };
      const page = agentBrowser && signedIn.length ? agentBrowser.tools({ id: job.id, label: job.label, sites: [...new Set(signedIn.flatMap(sitesOf))] }) : null;
      try {
        if (openBridge) {
          const session = { dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', 'discovery'), downloads: path.join(ctx.dataRoot, 'imports', 'discovery'), projectId: () => null, readable: access(ctx) ? access(ctx).readable : null, apps: [], group: null, exports: {}, folders: {}, days: HISTORY_DAYS };
          const callTool = createImportTools({ session, context, zotero: { status: () => (zotero ? zotero.status() : { connected: false }), root: zoteroRoot }, github, deps, env, kind: 'discover', page });
          bridge = await openBridge(callTool, { signal: controller.signal, maxBody: 1_000_000 });
        }
        const out = await agents.turn({ choice, kind: bridge ? 'discover' : 'projects', system: prompts.TOOLS_SYSTEM_PROMPT, message, session: null, dirs: [], signal: controller.signal, bridge: bridge && bridge.connection, connectors: [], meta: { kind: 'discover', label: job.label, evidence, job } });
        if (controller.signal.aborted) return;
        st.tools = { ...st.tools, status: 'done', results: readTools(out.text, evidence), signedIn, ended: now() };
      } catch (error) {
        if (controller.signal.aborted) return;
        st.tools = { ...st.tools, status: 'done', results: readTools('', evidence), signedIn, ...failure(error, chosen, 'The agent did not finish'), ended: now() };
      } finally {
        if (bridge) await bridge.close().catch(() => {});
        if (agentBrowser && page) agentBrowser.close(job.id);
        if (st.controllers.tools === controller) st.controllers.tools = null;
      }
      changed(ctx.dataRoot);
    })();
    return publicOf(st);
  }

  /** Stops both (the flow left, or started over). */
  async function stop() {
    const ctx = await context();
    const st = stateOf(ctx.dataRoot);
    for (const key of ['projects', 'tools']) if (st.controllers[key]) { st.controllers[key].abort(); st.controllers[key] = null; }
    return publicOf(st);
  }

  /** Everything found forgotten (the flow starting over): the next start runs again. */
  async function reset() {
    const ctx = await context();
    await stop();
    roots.set(ctx.dataRoot, { projects: { status: 'idle' }, tools: { status: 'idle' }, controllers: {} });
    changed(ctx.dataRoot);
    return publicOf(stateOf(ctx.dataRoot));
  }

  /**
   * A data root wiped (test mode's reset, 2026-10-15: what was found stayed in memory, so the projects and tools screens
   * came back answered): its searches stopped and its state forgotten, read from disk again (nothing there now) next time.
   */
  function forget(dataRoot) {
    const st = roots.get(dataRoot);
    if (st) for (const key of ['projects', 'tools']) if (st.controllers[key]) st.controllers[key].abort();
    roots.delete(dataRoot);
  }

  return { state, startProjects, startTools, stop, reset, forget };
}

module.exports = { createDiscovery, projectDigest, toolEvidence, historySites };
