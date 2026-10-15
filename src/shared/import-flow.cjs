'use strict';

// Import your context (2026-10-13, the "Onboarding" workspace and its mockup design/onboarding-mockup/Onboarding.html):
// what the work-first import flow decides, without any I/O, shared by main (src/main/onboarding) and the renderer
// (src/renderer/import). The flow:
//   Import context → How would you like to import context? (agents choose | choose sources myself)
//   → What kind of work do you do? → What are you working on? → What project do you want to work on first?
//   → agents: Confirm your tools → Import to Engelbart
//   → myself: the source picker → Choose exactly what to bring in → Import to Engelbart
// A project-discovery agent starts the moment Import context is pressed (before the method is chosen) and returns 1-5
// recent projects; a tool-discovery agent starts when agents are chosen and says which of the catalog's tools the person
// uses. Then Connect's own pipeline (src/main/connect/session.cjs, "direct" sessions) imports each confirmed tool, every
// agent told to bring in only what pertains to the projects picked.

const { SOURCES, APPS, LOCAL_PDFS, shownName } = require('./connect-sources.cjs');

/** Code's second row (the mockup's): repositories and folders on this Mac, chosen with the folder picker. */
const LOCAL_FOLDERS = 'Folders on this Mac';
/** Websites' one row: the browser's history. */
const SITES = '__sites';

/** Apps left out of Import your context for now (From Amitav, 2026-10-15: "Get rid of Gmail and Calendar imports for now"). */
const PAUSED_APPS = Object.freeze(['Gmail']);

/**
 * The picker's groups: Connect's sources (a paused app taken out, and a category it leaves empty with it), Code holding
 * GitHub and the folders on this Mac, then Other, for the tools the agents find that fit no category (From Amitav,
 * 2026-10-15). Websites and Other have no apps of their own.
 */
const GROUPS = Object.freeze([
  ...SOURCES.map((source) => ({ id: source.id, label: source.label, apps: source.id === 'code' ? ['GitHub', LOCAL_FOLDERS] : source.apps.filter((app) => !PAUSED_APPS.includes(app)), emptied: source.apps.length > 0 && source.apps.every((app) => PAUSED_APPS.includes(app)) }))
    .filter((group) => !group.emptied).map(({ id, label, apps }) => Object.freeze({ id, label, apps: Object.freeze(apps) })),
  Object.freeze({ id: 'other', label: 'Other', apps: Object.freeze([]) }),
]);
const GROUP_IDS = Object.freeze(GROUPS.map((group) => group.id));

const groupOfApp = (app) => (app === SITES ? 'sites' : (GROUPS.find((group) => group.apps.includes(app)) || {}).id || null);

/** A category the tool agent named, as one of GROUPS (its id or its label, any case), else Other. */
function categoryOf(value) {
  const said = String(value || '').trim().toLowerCase();
  const group = GROUPS.find((one) => one.id === said || one.label.toLowerCase() === said);
  return group ? group.id : 'other';
}

/** Tools the agents may not bring back while calendars and mail are paused (From Amitav, 2026-10-15). */
const PAUSED_TOOL = /\b(calendars?|calendly|cal\.com|fantastical|outlook|g?mail)\b/i;

/** How an app is reached, as the picker and the tools page say it: 'local' (read on this Mac), 'web', 'connector', 'signin', 'automation'. */
function reachOf(app) {
  if (app === SITES || app === LOCAL_FOLDERS) return 'local';
  return (APPS[app] && APPS[app].reach) || 'local';
}

/** Whether an app is read on this Mac with no account (the tools page's "Found on this Mac" when it is there). */
const isLocal = (app) => ['local', 'automation'].includes(reachOf(app));

/** Every tool the tools page can list: each picker app, and the browser's history. */
const CATALOG = Object.freeze([...GROUPS.flatMap((group) => group.apps.map((app) => Object.freeze({ id: app, name: app === SITES ? 'Saved URLs' : shownName(app), group: group.id, local: isLocal(app) }))), Object.freeze({ id: SITES, name: 'Saved URLs', group: 'sites', local: true })]);
const CATALOG_IDS = Object.freeze(CATALOG.map((tool) => tool.id));
const catalogTool = (id) => CATALOG.find((tool) => tool.id === id) || null;

/** The roles of "What kind of work do you do?", each with its icon's SVG paths (24 × 24, stroked). */
const ROLES = Object.freeze([
  ['Researcher', '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M8 15h8"/>'],
  ['Writer', '<path d="m15 3 6 6L8 22l-6 1 1-6zm-2 2 6 6M5 17l3 3"/>'],
  ['Founder', '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="m4 16-2 4h20l-2-4M10 20h4"/>'],
  ['Professor', '<path d="m2 8 10-5 10 5-10 5-10-5zm4 3v6c4 3 8 3 12 0v-6m4-3v9"/>'],
  ['Student', '<path d="M3 5h6c2 0 3 1 3 3v13c0-2-1-3-3-3H3zm18 0h-6c-2 0-3 1-3 3v13c0-2 1-3 3-3h6z"/>'],
  ['Engineer', '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>'],
  ['Designer', '<rect x="3" y="3" width="7" height="7" rx="1"/><circle cx="17" cy="6.5" r="3.5"/><path d="m6.5 14 4 7h-8z"/><rect x="13.5" y="14" width="7" height="7" rx="3.5"/>'],
  ['Other', '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'],
].map(([name, paths]) => Object.freeze({ name, paths })));
const ROLE_NAMES = Object.freeze(ROLES.map((role) => role.name));

/* --------------------------------------------------------------------------------------------------------- providers */

const PROVIDER_IDS = Object.freeze(['anthropic', 'openai']);
const PROVIDER_NAMES = Object.freeze({ anthropic: 'Claude Code', openai: 'Codex' });

/**
 * Which provider runs onboarding's agents (2026-10-13, the workspace: "if they have downloaded and signed into both claude
 * and codex and have a subscription for each, they should be prompted to select … if one has a subscription and one
 * doesnt … they should use the one with a subscription", else "the one with most seniority").
 * `providers` [{ id, installed, signedIn, subscription (a plan's name or null), since (ms, when it was first used, or null) }];
 * `remembered` the id picked before. → { pick, ask, choices, setup, suggested }:
 *   setup      neither can run: the tools setup comes first
 *   ask        both subscribed: the person picks among `choices`, every time onboarding runs (2026-10-13, second round:
 *              "I do not think I saw the popup to select the model provider"; a pick remembered from an earlier run
 *              had skipped it). `suggested` is that earlier pick, shown chosen
 *   pick       the provider to use
 */
function chooseProvider(providers, remembered = null) {
  const list = (Array.isArray(providers) ? providers : []).filter((p) => p && PROVIDER_IDS.includes(p.id));
  const ready = list.filter((p) => p.installed && p.signedIn);
  if (!ready.length) return { pick: null, ask: false, choices: [], setup: true };
  const subscribed = ready.filter((p) => !!p.subscription);
  if (subscribed.length >= 2) {
    const suggested = remembered && subscribed.some((p) => p.id === remembered) ? remembered : null;
    return { pick: null, ask: true, choices: subscribed.map((p) => p.id), setup: false, suggested };
  }
  if (subscribed.length === 1) return { pick: subscribed[0].id, ask: false, choices: [subscribed[0].id], setup: false };
  const senior = [...ready].sort((a, b) => (Number.isFinite(a.since) ? a.since : Infinity) - (Number.isFinite(b.since) ? b.since : Infinity) || PROVIDER_IDS.indexOf(a.id) - PROVIDER_IDS.indexOf(b.id))[0];
  return { pick: senior.id, ask: false, choices: [senior.id], setup: false };
}

/* ---------------------------------------------------------------------------------------------------------- browsers */

/**
 * The browsers whose sign-ins Engelbart can use (2026-10-13: "Safari, Chrome, Brave, Firefox, Arc, Edge, Opera, Chromium,
 * Comet"). `importer` is the id ../main/browser/import-cookies.cjs knows it by (Safari's sign-ins are read from its cookie
 * file, which needs Full Disk Access). Only installed ones are ever offered.
 */
const BROWSERS = Object.freeze([
  { id: 'safari', name: 'Safari', bundle: 'com.apple.Safari', keychain: false },
  { id: 'chrome', name: 'Chrome', bundle: 'com.google.Chrome', keychain: true },
  { id: 'brave', name: 'Brave', bundle: 'com.brave.Browser', keychain: true },
  { id: 'firefox', name: 'Firefox', bundle: 'org.mozilla.firefox', keychain: false },
  { id: 'arc', name: 'Arc', bundle: 'company.thebrowser.Browser', keychain: true },
  { id: 'edge', name: 'Edge', bundle: 'com.microsoft.edgemac', keychain: true },
  { id: 'opera', name: 'Opera', bundle: 'com.operasoftware.Opera', keychain: true },
  { id: 'chromium', name: 'Chromium', bundle: 'org.chromium.Chromium', keychain: true },
  { id: 'comet', name: 'Comet', bundle: 'ai.perplexity.comet', keychain: true },
].map((browser) => Object.freeze(browser)));
const browserById = (id) => BROWSERS.find((browser) => browser.id === id) || null;

// macOS's name for the default browser (app.getApplicationNameForProtocol('https://')) → an id here.
const DEFAULT_NAMES = [[/safari/i, 'safari'], [/chromium/i, 'chromium'], [/chrome/i, 'chrome'], [/brave/i, 'brave'], [/firefox/i, 'firefox'], [/^arc\b/i, 'arc'], [/edge/i, 'edge'], [/opera/i, 'opera'], [/comet/i, 'comet']];
function browserIdOfName(name) {
  const text = String(name || '');
  const hit = DEFAULT_NAMES.find(([pattern]) => pattern.test(text));
  return hit ? hit[1] : null;
}

/** The installed browsers (ids), the default first, then the rest in BROWSERS' order. */
function orderBrowsers(installedIds, defaultId) {
  const have = new Set(installedIds || []);
  const out = BROWSERS.filter((browser) => have.has(browser.id)).map((browser) => browser.id);
  return defaultId && have.has(defaultId) ? [defaultId, ...out.filter((id) => id !== defaultId)] : out;
}

/* ------------------------------------------------------------------------------------------------- discovery replies */

const clip = (value, max) => { const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };

/** The JSON object in a model's reply (fences and words around it tolerated), or null. */
function jsonOf(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const value = JSON.parse(raw.slice(start, end + 1)); return value && typeof value === 'object' ? value : null; } catch { return null; }
}

const slug = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';

/**
 * The project-discovery agent's reply made safe → { projects: [{ id, title, description, recent, folder, evidence }] },
 * 1-5 projects with unique ids and titles of at most 80 characters; null when there is not one usable project.
 */
function readProjects(text) {
  const value = jsonOf(text);
  const list = value && Array.isArray(value.projects) ? value.projects : null;
  if (!list) return null;
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const title = clip(entry.title, 80);
    if (!title) continue;
    let id = slug(entry.id || title);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    out.push({ id, title, description: clip(entry.description, 240), recent: clip(entry.recent, 24), folder: typeof entry.folder === 'string' && entry.folder.trim().startsWith('/') ? entry.folder.trim().slice(0, 1024) : '', evidence: clip(entry.evidence, 240) });
    if (out.length === 5) break;
  }
  return out.length ? { projects: out } : null;
}

/**
 * The tool-discovery agent's reply made safe, over the deterministic evidence `known` ({ [id]: { used, evidence, method } })
 * → { tools: [{ id, used, evidence, method }], additional: [{ name, website, used, evidence, category }] }. Every catalog
 * tool has an entry: what the agent said, else what was known, else unused. A tool found on this Mac stays used whatever it
 * said. An extra tool's category is one of GROUPS' (Other when it named none it has); calendars and mail are left out.
 */
function readTools(text, known = {}) {
  const value = jsonOf(text) || {};
  const said = new Map((Array.isArray(value.tools) ? value.tools : []).filter((entry) => entry && typeof entry === 'object' && CATALOG_IDS.includes(entry.id)).map((entry) => [entry.id, entry]));
  const tools = CATALOG_IDS.map((id) => {
    const fact = known[id] || null;
    const reply = said.get(id);
    const local = fact && fact.method === 'local' && fact.used;
    const used = local ? true : reply && typeof reply.used === 'boolean' ? reply.used : !!(fact && fact.used);
    return { id, used, evidence: clip((reply && reply.evidence) || (fact && fact.evidence) || '', 200), method: local ? 'local' : reply ? 'agent' : (fact && fact.method) || 'none' };
  });
  const names = new Set(CATALOG.map((tool) => tool.name.toLowerCase()));
  const additional = [];
  for (const entry of Array.isArray(value.additional) ? value.additional : []) {
    if (!entry || typeof entry !== 'object') continue;
    const name = clip(entry.name, 60);
    if (!name || names.has(name.toLowerCase()) || PAUSED_TOOL.test(name)) continue;
    names.add(name.toLowerCase());
    const website = typeof entry.website === 'string' && /^https?:\/\/[^\s]+$/i.test(entry.website.trim()) ? entry.website.trim().slice(0, 300) : '';
    additional.push({ name, website, used: entry.used !== false, evidence: clip(entry.evidence, 200), category: categoryOf(entry.category) });
    if (additional.length === 12) break;
  }
  return { tools, additional };
}

/* -------------------------------------------------------------------------------------------------------- the scopes */

/** What the manual import asks for a source: folders, email people, drafts, collections, repositories, chats or documents. */
function scopeKind(id) {
  if (['Obsidian', 'Zoom', LOCAL_PDFS, LOCAL_FOLDERS].includes(id)) return 'folders';
  if (id === 'Gmail') return 'email';
  if (id === 'Overleaf') return 'drafts';
  if (id === 'Zotero') return 'collections';
  if (id === 'GitHub') return 'repos';
  if (groupOfApp(id) === 'chats') return 'chats';
  if (id === SITES) return 'sites';
  return 'documents';
}

const emptyScope = (id) => ({ kind: scopeKind(id), folders: [], items: [], people: [], note: '' });

/** Whether a manual source says exactly what to bring in: a folder chosen, a person or group named, an item ticked or a note. */
function scopeReady(scope) {
  if (!scope) return false;
  if (scope.kind === 'folders') return scope.folders.length > 0;
  if (scope.kind === 'email') return scope.people.length > 0 || scope.items.length > 0;
  return scope.items.length > 0 || !!String(scope.note || '').trim();
}

/** The options a manual source offers for the projects picked (the mockup's): drafts, threads, collections, repositories… */
function scopeOptions(id, projects) {
  const kind = scopeKind(id);
  return (projects || []).flatMap((project) => {
    if (kind === 'drafts') return [{ id: `${id}:${project.id}:main`, label: `${project.title} — manuscript` }, { id: `${id}:${project.id}:methods`, label: `${project.title} — methods draft` }];
    if (kind === 'email') return [{ id: `${id}:${project.id}:collaborators`, label: `Collaborator threads about ${project.title}` }];
    if (kind === 'collections') return [{ id: `${id}:${project.id}`, label: `${project.title} collection` }];
    if (kind === 'repos') return [{ id: `${id}:${project.id}`, label: slug(project.title) }];
    if (kind === 'chats') return [{ id: `${id}:${project.id}`, label: `${project.title} conversations` }];
    if (kind === 'sites') return [{ id: `${id}:${project.id}`, label: `Pages about ${project.title}` }];
    return [{ id: `${id}:${project.id}`, label: `${project.title} documents` }];
  });
}

/**
 * The plan an import agent is handed for one tool (the mockup's launchProjectImports): bring in only what pertains to the
 * projects picked, leave out everything else; a manual import keeps to the exact folders, people, drafts, collections
 * or items the person chose. `scope` (manual) as emptyScope's, with `labels` for the ticked items' names.
 */
function importPlan({ app, mode, projects, roles = [], work = '', scope = null, period = '', browser = '' }) {
  const titles = (projects || []).map((project) => project.title).filter(Boolean);
  const described = (projects || []).map((project) => `- ${project.title}${project.description ? `: ${project.description}` : ''}`).join('\n');
  const lines = [
    `Bring in from ${app === SITES ? 'the browser history' : shownName(app)} only what pertains to these projects the person picked:`,
    described || `- ${titles.join('\n- ')}`,
    roles.length ? `They describe their work as: ${roles.join(', ')}.` : '',
    work ? `In their words: ${clip(work, 600)}` : '',
    period ? `Look back over ${period}.` : '',
    'Leave out unrelated projects, personal files, daily notes, journals, receipts and forms, and tools used every day (mail, calendar, social media) unless they are about these projects.',
  ];
  // What the person said under "Specify context" (round 3, 2026-10-13) is optional. The projects ticked there narrow this
  // source to those; the folders and files chosen are where to read; what they wrote says what they want. It holds for a
  // background run too (From Amitav, 2026-10-15: one tools screen whichever way the import runs).
  const said = scope ? [
    scope.folders.length ? `only these folders and files: ${scope.folders.map((folder) => folder.path || folder.name).join('; ')}` : '',
    scope.people.length ? `only email with these people: ${scope.people.join('; ')}` : '',
    scope.labels && scope.labels.length ? `these items: ${scope.labels.join('; ')}` : '',
  ].filter(Boolean) : [];
  if (scope && Array.isArray(scope.projects) && scope.projects.length) lines.push(`For this source, only these of the projects: ${scope.projects.join('; ')}.`);
  if (scope && String(scope.note || '').trim()) lines.push(`In their words, what to bring in from it: ${clip(scope.note, 600)}`);
  if (said.length) {
    lines.push(`They narrowed it down: read ${said.join(', and ')}. Nothing outside it comes in, even when it looks related.`);
  } else if (browser) {
    lines.push(`Find what belongs with these projects yourself, in the person's own ${browser} (their sign-ins are there) and the files on this Mac. Never install a plugin or an extension.`);
  } else {
    lines.push('Find what belongs with these projects yourself, through the person\'s existing sign-ins in Engelbart\'s browser and the files on this Mac. Never install a plugin or an extension.');
  }
  return lines.filter(Boolean).join('\n');
}

/** Whether an app is reached on the web (a browser agent's, when the person let agents use their browser). */
const isWebApp = (app) => reachOf(app) === 'web';

module.exports = {
  LOCAL_FOLDERS, SITES, PAUSED_APPS, GROUPS, GROUP_IDS, CATALOG, CATALOG_IDS, categoryOf, ROLES, ROLE_NAMES, PROVIDER_IDS, PROVIDER_NAMES, BROWSERS,
  groupOfApp, reachOf, isLocal, isWebApp, catalogTool, chooseProvider, browserById, browserIdOfName, orderBrowsers,
  jsonOf, readProjects, readTools, scopeKind, emptyScope, scopeReady, scopeOptions, importPlan,
};
