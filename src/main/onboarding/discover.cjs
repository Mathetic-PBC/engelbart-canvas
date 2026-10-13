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
const { CATALOG, LOCAL_FOLDERS, SITES, PROVIDER_IDS, browserById, readProjects, readTools } = require('../../shared/import-flow.cjs');
const prompts = require('./prompts.cjs');

const FILE = 'discovery.json';
const DIGEST_DAYS = 120;
const HISTORY_DAYS = 90;
const SIGN_IN_TIMEOUT_MS = 20_000;

const exists = (file) => { try { fs.accessSync(file); return true; } catch { return false; } };
const shown = (homeDir, dir) => readers.shownPath(homeDir, dir);
const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const dayOf = (iso) => String(iso || '').slice(0, 10);

/* ------------------------------------------------------------------------------------------------- the project digest */

/**
 * What the person worked on lately, read from this Mac without a model → { folders, vaults, zotero, projects }:
 *   folders  the folders their Claude Code and Codex sessions ran in, the busiest and most recent first, each with how
 *            many sessions, the last day, the repository it is in, and the newest sessions' titles
 *   vaults   each Obsidian vault's notes changed lately (title and folder)
 *   zotero   the collections of their Zotero library (Engelbart's copy), when signed in
 *   projects the Engelbart projects they have already (so a project is not offered twice)
 */
function projectDigest({ homeDir, env = process.env, access = null, zoteroRoot = null, existing = [], days = DIGEST_DAYS }) {
  const byFolder = new Map();
  for (const app of ['Claude Code', 'Codex']) {
    let chats = [];
    try { chats = readers.localChats(app, { homeDir, env, days, limit: 400 }); } catch { chats = []; }
    for (const chat of chats) {
      const key = chat.project || '(no folder)';
      const entry = byFolder.get(key) || { shown: key, sessions: 0, last: '', apps: new Set(), titles: [] };
      entry.sessions += 1;
      entry.apps.add(app);
      if (chat.date > entry.last) entry.last = chat.date;
      if (entry.titles.length < 10 && chat.title && !entry.titles.includes(chat.title)) entry.titles.push(chat.title);
      byFolder.set(key, entry);
    }
  }
  let repos = [];
  try { repos = scan.localRepos({ homeDir, env, access }); } catch { repos = []; }
  const repoOf = (shownPath) => repos.find((repo) => shownPath === repo.shown || shownPath.startsWith(`${repo.shown}/`)) || null;
  const folders = [...byFolder.values()]
    .map((entry) => {
      const repo = repoOf(entry.shown);
      const full = entry.shown.startsWith('~') ? path.join(homeDir, entry.shown.slice(1)) : entry.shown;
      return { shown: entry.shown, path: path.isAbsolute(full) ? full : '', name: path.basename(full) || entry.shown, sessions: entry.sessions, last: dayOf(entry.last), apps: [...entry.apps], repository: repo ? repo.shown : null, titles: entry.titles };
    })
    .sort((a, b) => b.last.localeCompare(a.last) || b.sessions - a.sessions)
    .slice(0, 25);
  const vaults = [];
  let found = [];
  try { found = readers.obsidianVaults(homeDir); } catch { found = []; }
  for (const vault of found.slice(0, 3)) {
    if (access && !access.readable(vault.path)) continue;
    let files = [];
    try { files = readers.noteFiles(vault.path, { days: 60, max: 60, readable: access ? access.readable : null }); } catch { files = []; }
    const notes = files.slice(0, 40).map((file) => ({ title: path.basename(file).replace(/\.(md|markdown|txt)$/i, ''), folder: path.relative(vault.path, path.dirname(file)) || '.' }));
    vaults.push({ vault: vault.shown, notes });
  }
  let zotero = [];
  if (zoteroRoot) { try { zotero = readers.zoteroCollections(zoteroRoot).collections.slice(0, 40).map((one) => ({ name: one.path, items: one.items })); } catch { zotero = []; } }
  return { folders, vaults, zotero, projects: existing.slice(0, 30) };
}

/* ------------------------------------------------------------------------------------------------- the tool evidence */

// The desktop apps that say a tool is used (../connect/scan.cjs keeps the same list for the picker).
const DESKTOP = { ChatGPT: ['ChatGPT.app'], Claude: ['Claude.app'], Granola: ['Granola.app'], Notion: ['Notion.app'], Evernote: ['Evernote.app'], OneNote: ['Microsoft OneNote.app'], Perplexity: ['Perplexity.app'], Cursor: ['Cursor.app'], Zoom: ['zoom.us.app'], Obsidian: ['Obsidian.app'], 'Google Docs': ['Google Drive.app'], Zotero: ['Zotero.app'], Overleaf: [], Grok: [] };

/** A browser's most visited sites, from its history file (Chromium, Firefox, or Safari with Full Disk Access) → [{ host, visits }]. */
async function historySites({ homeDir, browserId, days = HISTORY_DAYS, run = execFile }) {
  const sqlite = async (file, query) => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'engelbart-history-'));
    try {
      const copy = path.join(scratch, path.basename(file));
      fs.copyFileSync(file, copy);
      if (exists(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
      const out = await new Promise((resolve, reject) => { run('sqlite3', ['-json', '-readonly', copy, query], { maxBuffer: 256 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout))); });
      return JSON.parse(String(out || '').trim() || '[]');
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
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
const visitsTo = (sites, app) => sites.filter((site) => sitesOf(app).some((domain) => site.host === domain || site.host.endsWith(`.${domain}`))).reduce((n, site) => n + site.visits, 0);

/**
 * What can be told without a model → { evidence: { [toolId]: { used, method, evidence } }, sites: [{ host, visits }] }.
 * `cookies(app)` → whether the chosen browser holds the app's sign-in cookie (names only).
 */
async function toolEvidence({ homeDir, env = process.env, browserId, access = null, github = null, zotero = null, connectors = null, cookies = () => false, applications = ['/Applications', path.join(homeDir, 'Applications')], run = execFile }) {
  const evidence = {};
  const set = (id, used, method, text) => { evidence[id] = { used: !!used, method, evidence: text }; };
  let detected = { apps: {}, localRepos: [] };
  try { detected = scan.detect({ homeDir, env, access, zotero: () => (zotero ? zotero.status() : null), github: () => (github ? github.status() : null), connectors: (app) => !!(connectors && connectors.status(app).connected), applications }); } catch { /* nothing found */ }
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
    if (SIGN_IN_COOKIES[id] && cookies(id)) { set(id, true, 'cookie', `Signed in in ${browserName}`); continue; }
    const visits = visitsTo(sites, id);
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
function createDiscovery({ agents, models = () => null, context, homeDir, env = process.env, providers, webSignIn = null, cookieImport = null, agentBrowser = null, openBridge = null, zotero = null, zoteroRoot = () => null, github = null, connectors = null, deps = {}, notify = () => {}, trace = null, access = () => null, existingProjects = () => [], now = () => new Date().toISOString() }) {
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

  async function provider(asked) {
    if (PROVIDER_IDS.includes(asked)) return asked;
    const out = await providers.status();
    return out.decision.pick;
  }

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
    const chosen = await provider(asked);
    if (!chosen) { if (st.projects.status !== 'done') { st.projects = { status: 'waiting-provider', projects: [] }; changed(ctx.dataRoot); } return publicOf(st); }
    if (!again && (st.projects.status === 'running' || (st.projects.status === 'done' && st.projects.provider === chosen))) return publicOf(st);
    if (st.controllers.projects) st.controllers.projects.abort();
    const controller = new AbortController();
    st.controllers.projects = controller;
    st.projects = { status: 'running', provider: chosen, projects: st.projects.projects || [], started: now() };
    changed(ctx.dataRoot);
    void (async () => {
      const existing = await Promise.resolve().then(() => existingProjects(ctx)).catch(() => []);
      const digest = projectDigest({ homeDir, env, access: access(ctx), zoteroRoot: zoteroRoot(), existing: Array.isArray(existing) ? existing : [] });
      say('discovery', `Looking for recent projects with ${chosen === 'openai' ? 'Codex' : 'Claude Code'}`, { folders: digest.folders.length, vaults: digest.vaults.length, zotero: digest.zotero.length });
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
        st.projects = read ? { status: 'done', provider: chosen, projects: read.projects, started: st.projects.started, ended: now() } : { status: 'failed', provider: chosen, projects: [], error: 'The agent did not name any projects.', ended: now() };
      } catch (error) {
        if (controller.signal.aborted) return;
        st.projects = { status: 'failed', provider: chosen, projects: [], error: (error && error.message) || 'The agent did not answer.', ended: now() };
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
    const chosen = await provider(asked);
    if (!chosen) { if (st.tools.status !== 'done') { st.tools = { status: 'waiting-provider', results: null }; changed(ctx.dataRoot); } return publicOf(st); }
    if (!again && (st.tools.status === 'checking' || (st.tools.status === 'done' && st.tools.provider === chosen && st.tools.browser === browserId))) return publicOf(st);
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
      const { evidence, sites } = await toolEvidence({ homeDir, env, browserId, access: access(ctx), github, zotero, connectors, cookies: holds });
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
        st.tools = { ...st.tools, status: 'done', results: readTools('', evidence), signedIn, error: (error && error.message) || 'The agent did not finish', ended: now() };
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

  return { state, startProjects, startTools, stop, reset };
}

module.exports = { createDiscovery, projectDigest, toolEvidence, historySites };
