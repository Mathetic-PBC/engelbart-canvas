'use strict';

// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html", the "Onboarding brainstorm" note). In
// every library since 2026-10-08 (test mode's only until then): the person picks what should go into their library,
// then a librarian agent talks with them in one continuous chat (single and multiple choice and short open questions,
// built from what was found) and hands each source to an import agent as soon as it is settled. Imports run in the
// background while the chat goes on and after the window is put away.
//
// Second build (same day, "Agent onboarding"), what this file does now:
//   · the agents do the work: survey agents look at each web or connector app first (its files, chats, projects) so the
//     librarian can offer the person their own things; import agents use Engelbart's hidden browser (./browser.cjs), the
//     apps' connectors (./connectors.cjs) and macOS Automation; nobody is told to export or download anything
//   · a priority queue (the workspace's TODO): surveys first (they unblock questions), then the recalls, then imports, then
//     MEMORY.md; three at a time; MEMORY.md waits until everything else has ended
//   · "Needs you": an agent that meets a sign-in, a code or a permission hands it to the person (needs_you) and waits; the
//     window shows it with a button that opens the agent's window, runs the connector's sign-in or asks macOS. One request
//     per app and kind, whichever agents wait on it
//   · the action log: every step of every agent, in the person's words; Stop for one import or all
//   · the models are pinned (CONNECT_MODELS: Sonnet high on Claude Code, Sol high on Codex) and only the provider is chosen;
//     no agent moves up to another model
//   · MEMORY.md: recall agents ask the AI assistants what they remember (with the person's leave), and once everything has
//     ended a memory agent writes it from all of it, a Claude Sonnet agent takes secrets out, and it is saved (./memory.cjs)
//   · a session can belong to an existing project (the one-time popup)
//
// Third build (2026-10-08, "Agent onboarding" again):
//   · what comes in is a Markdown file of the library's own in <dataRoot>/assets/md, not a project's note ("save the
//     imported content not as notes but as md files"), so nothing waits for onboarding to make the project
//   · Skip on a "Needs you" holds for the run: that app is never put to the person again (skipApp)
//   · Skip on the librarian's question or button brings nothing of it in (2026-10-08: "When I hit skip it should not bring
//     in anything, not just have the agent choose"): the question's source (or the apps it named) or the button's app is
//     left out for the run, in code, so neither the librarian nor Import can hand it over (skipAsked)
//   · Papers on this Mac: the folders that hold PDFs, asked about by folder and kind (../../shared/connect-sources.cjs
//     LOCAL_PDFS, ./scan.cjs pdfsAtAGlance)
//   · a session still going when Engelbart quits (or switches library) is saved as it is and picked up again when that
//     library is next open (suspendAll, resume)
//
// What it writes is only in the data root it started in (~/.engelbart, or ~/.engelbart/test in test mode): <dataRoot>/.connect/<id>/
// (session.json, what was said, how each import went and what resuming needs; notes/ notes an earlier build staged;
// memories/ what each assistant answered), <dataRoot>/imports/<id>/ (what the agents downloaded), assets/md/, MEMORY.md,
// and the library rows the import tools add.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { SOURCES, APPS, LOCAL_PDFS, sourceOf, appOf, sourceOfApp, recallApps, cleanDays, periodName, shownName, sharesSignIn, signInGroup, fallbackOf } = require('../../shared/connect-sources.cjs');
const prompts = require('./prompts.cjs');
const { scanFor } = require('./scan.cjs');
const readers = require('./readers.cjs');
const folderAccess = require('./folder-access.cjs');
const notes = require('./notes.cjs');
const { createImportTools, toolNamesFor, browseSitesFor, APPROVAL_APPS } = require('./tools.cjs');
const { skillsFor } = require('./skills.cjs');
const memory = require('./memory.cjs');
const { clipMiddle } = require('../bart/clip.cjs');
const importFlow = require('../../shared/import-flow.cjs');
const { needsProvider } = require('./provider-failure.cjs');

// At most this many agents at once (2026-10-13, the "Onboarding" workspace: "Get rid of the max_running=3 and set it to 6").
const MAX_RUNNING = 6;
const MAX_JOBS = 40;
const MAX_LOG = 400;
const SHOWN_LOG = 150;
const NEED_WAIT_MS = 170_000;
// A web app's sign-in copied again mid-run (signInAgain): another agent asking within this long of it shares its answer.
const SIGN_IN_AGAIN_SHARED_MS = 30_000;
const SIGN_IN_CHECK_MS = 10_000; // the sign-ins looked at before the surveys start, all together, at most this long
// A sign-in that doesn't work in Engelbart's browser is copied again quietly this many times, these far apart, before the
// person is asked (recover, 2026-10-16): a browser writes a fresh sign-in to disk within about half a minute.
const RECOVER_WAITS_MS = Object.freeze([0, 8000, 20000]);
// The steps the person settles by signing in inside Engelbart (or, for Google's, in their own browser): recover's card.
const SIGNIN_HERE = 'signin-here';
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK_KINDS = new Set(['single', 'multi', 'open', 'repos']);
// Which of GitHub's repositories, asked as any choice is: the window shows the GitHub list instead (2026-10-08: "when
// asking me which repositories it should use our existing nice github ui"), whether or not the librarian said "repos".
const REPOS_ASK = /\bwhich\b.*\brepo(?:s|sitory|sitories)?\b/i;
const AUTHORIZE_KINDS = new Set(['signin', 'connector', 'permission', 'folder']);
// The steps that are a sign-in, a code or a check on a site (round 3): made in the person's browser, then copied over.
const SIGNIN_KINDS = new Set(['signin', 'password', 'code', '2fa', 'captcha']);
/** Whether the librarian's run must ask before `app` is touched (askGrant): an app on the web or behind a connector. */
const asksFirst = (app) => !!(APPS[app] && (APPS[app].reach === 'web' || APPS[app].reach === 'connector'));
const SIGNIN_APPS = new Set(['Zotero', 'GitHub']);
// A step whose sign-in Engelbart can see for itself (Zotero's and GitHub's own, a connector's) is looked at this often
// while it is open, so a sign-in finished anywhere closes it and starts what waited on it (2026-10-14, the Zotero beta report).
const STEP_POLL_MS = 1000;
const PRIORITY = Object.freeze({ survey: 0, recall: 1, import: 2, memory: 3, redact: 4 });
const WORK = new Set(['survey', 'recall', 'import']);
const ENDED = new Set(['done', 'failed', 'stopped']);
// The apps on this Mac whose folder an agent looks for when the scan did not find it where it usually is (MATH-117).
const FIND_APPS = new Set(['Obsidian', 'Zoom', LOCAL_PDFS]);
const folderName = (app) => (app === LOCAL_PDFS ? 'folders of PDFs' : `${shownName(app)} folder`);
// "change the default model for the context brainstorming and for the background subagents to sonnet high/sol high, and
// do not even allow mke to change model or effort, only provider": not in model-effort-inline-question.json, so not editable.
const CONNECT_MODELS = Object.freeze({ anthropic: Object.freeze({ model: 'sonnet', effort: 'high' }), openai: Object.freeze({ model: 'sol', effort: 'high' }) });
const PROVIDERS = Object.freeze(['anthropic', 'openai']);
const PROVIDER_NAMES = Object.freeze({ anthropic: 'Claude Code', openai: 'Codex' });
const FALLBACK_IDS = Object.freeze({ sonnet: { id: 'claude-sonnet-5-5', name: 'Sonnet' }, sol: { id: 'gpt-6.1-sol', name: 'Sol' } });

const clip = (text, max) => { const value = String(text == null ? '' : text).trim(); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const line = (text, max) => clip(String(text == null ? '' : text).replace(/\s+/g, ' '), max);

/** The prompt in force: <dataRoot>/.context/<file> when it holds any, else the built-in one. */
function promptOf(dataRoot, file, builtIn) {
  try { const custom = fs.readFileSync(path.join(dataRoot, '.context', file), 'utf8').trim(); if (custom) return custom; } catch { /* built-in */ }
  return builtIn;
}

/**
 * The pinned model of a provider, from Build's list (an id updated there carries here) → { provider, model, modelId,
 * modelName, effort }. `models()` → that list ({ providers: { anthropic: { models } } }), or nothing.
 */
function connectChoice(provider, models) {
  const at = PROVIDERS.includes(provider) ? provider : 'anthropic';
  const pin = CONNECT_MODELS[at];
  const listed = models && models.providers && models.providers[at] && models.providers[at].models ? models.providers[at].models[pin.model] : null;
  const model = listed && listed.id ? listed : FALLBACK_IDS[pin.model];
  return { provider: at, model: pin.model, modelId: model.id, modelName: model.name || FALLBACK_IDS[pin.model].name, effort: pin.effort };
}

// As store/projects.cjs clips them: a project's name to 200 characters, its description to MAX_DESCRIPTION.
const MAX_PROJECT_NAME = 200;
const MAX_DESCRIPTION = 4000;

/** What the project is, as the choose screen sent it ({ name, description }, 2026-10-10) → the same, trimmed, or null. */
function cleanProject(input) {
  if (!input || typeof input !== 'object') return null;
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, MAX_PROJECT_NAME) : '';
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, MAX_DESCRIPTION) : '';
  return name || description ? { name, description } : null;
}

/**
 * The project the agents are told about: only one with a description (with none, Connect works as it did before
 * 2026-10-10, when it was never told).
 */
const projectFor = (choices) => (choices && choices.project && choices.project.description ? choices.project : null);

/**
 * What MEMORY.md's agent is told came in: the imports (label, how many, titles) and the surveys that finished. Never an
 * email job (2026-10-11): Gmail's threads hold what other people wrote, so neither their subjects nor a survey's account
 * of an inbox goes near the person's memory.
 */
function memoryJobs(s) {
  const appsOf = (job) => (job.apps.length ? job.apps : (((s.choices.sources || {})[job.source] || {}).apps || []));
  const email = (job) => job.source === 'email' || appsOf(job).includes('Gmail');
  const imports = s.jobs.filter((job) => job.kind === 'import' && !email(job)).map((job) => ({ label: job.label, status: job.status, notes: job.notes, items: job.items, said: job.summary || job.error, titles: job.titles.slice(0, 40) }));
  const surveys = s.jobs.filter((job) => job.kind === 'survey' && job.status === 'done' && !email(job)).map((job) => ({ app: job.apps[0], said: job.summary }));
  return { imports, surveys };
}

const MAX_DIRECT_PROJECTS = 8;
const hostOfSite = (website) => { try { const url = new URL(String(website || '')); return /^https?:$/.test(url.protocol) ? url.hostname.toLowerCase().replace(/^www\./, '') : ''; } catch { return ''; } };

/**
 * Import your context's answer (2026-10-13, the "Onboarding" workspace) made safe → { mode, projects, roles, work, apps,
 * scopes, additional } or null. `apps` are ids of shared/import-flow.cjs CATALOG (the tools confirmed, or the sources
 * chosen); `scopes` (manual) what exactly to bring in from each; `additional` the tools named that are not in the catalog.
 */
function cleanDirect(input, homeDir) {
  if (!input || typeof input !== 'object') return null;
  const mode = input.mode === 'manual' ? 'manual' : 'auto';
  const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const projects = (Array.isArray(input.projects) ? input.projects : []).filter((one) => one && typeof one === 'object' && text(one.title, 120)).slice(0, MAX_DIRECT_PROJECTS).map((one, at) => ({
    id: text(one.id, 64) || `project-${at + 1}`, title: text(one.title, 120), description: text(one.description, 400),
    folder: typeof one.folder === 'string' && readers.expandPath(homeDir, one.folder) && readers.expandPath(homeDir, one.folder).startsWith(homeDir + path.sep) ? readers.expandPath(homeDir, one.folder) : '',
  }));
  const apps = [...new Set((Array.isArray(input.apps) ? input.apps : []).filter((id) => importFlow.CATALOG_IDS.includes(id)))];
  const scopes = {};
  for (const id of apps) {
    const scope = input.scopes && typeof input.scopes === 'object' ? input.scopes[id] : null;
    if (!scope || typeof scope !== 'object') continue;
    const list = (value, max, each) => (Array.isArray(value) ? value : []).map(each).filter(Boolean).slice(0, max);
    scopes[id] = {
      kind: importFlow.scopeKind(id),
      folders: list(scope.folders, 12, (folder) => { const dir = readers.expandPath(homeDir, folder && typeof folder === 'object' ? folder.path : folder); return dir && dir.startsWith(homeDir + path.sep) ? { path: dir, name: path.basename(dir) } : null; }),
      people: list(scope.people, 20, (person) => text(person, 200)),
      items: list(scope.items, 40, (item) => text(item, 200)),
      labels: list(scope.labels, 40, (label) => text(label, 200)),
      projects: list(scope.projects, MAX_DIRECT_PROJECTS, (title) => text(title, 120)),
      note: text(scope.note, 2000),
    };
  }
  // An extra tool carries what the person specified for it on the tools screen (From Amitav, 2026-10-15): a note, and the
  // projects it is kept to.
  const additional = (Array.isArray(input.additional) ? input.additional : []).filter((one) => one && typeof one === 'object' && text(one.name, 60)).slice(0, 12).map((one) => ({
    name: text(one.name, 60), website: hostOfSite(one.website) ? String(one.website).trim().slice(0, 300) : '', note: text(one.note, 600),
    projects: (Array.isArray(one.projects) ? one.projects : []).map((title) => text(title, 120)).filter(Boolean).slice(0, MAX_DIRECT_PROJECTS),
  }));
  if (!apps.length && !additional.length) return null;
  return { mode, projects, roles: (Array.isArray(input.roles) ? input.roles : []).filter((role) => importFlow.ROLE_NAMES.includes(role)).slice(0, 8), work: text(input.work, 2000), apps, scopes, additional };
}

/**
 * The choose screen's answer that Import your context sends (`direct`) → the sources, folders and project Connect's
 * pipeline runs on: each catalog tool on in its group, Code's GitHub and folders, the browser history as Websites, the
 * folders the person chose (manual) as the source's folders, and the projects picked as the one project every agent is
 * told about.
 */
function directInput(input, homeDir) {
  const direct = cleanDirect(input && input.direct, homeDir);
  if (!direct) return input;
  const sources = Object.fromEntries(SOURCES.map((source) => [source.id, { on: false, apps: [], folders: [], repos: [] }]));
  const picked = [];
  for (const id of direct.apps) {
    const scope = direct.scopes[id] || null;
    const dirs = scope ? scope.folders.map((folder) => folder.path) : [];
    picked.push(...dirs);
    if (id === importFlow.SITES) { sources.sites.on = true; continue; }
    if (id === importFlow.LOCAL_FOLDERS) { sources.code.on = true; sources.code.folders.push(...dirs); continue; }
    if (id === 'GitHub') { sources.code.on = true; continue; }
    const group = importFlow.groupOfApp(id);
    if (!group || !sources[group]) continue;
    sources[group].on = true;
    sources[group].apps.push(id);
    if (id === LOCAL_PDFS) sources[group].folders.push(...dirs);
  }
  if (direct.additional.length) sources.sites.on = true;
  for (const source of Object.values(sources)) source.folders = [...new Set(source.folders)];
  const titles = direct.projects.map((project) => project.title);
  const project = titles.length ? { name: titles.join(', ').slice(0, MAX_PROJECT_NAME), description: direct.projects.map((one) => `${one.title}${one.description ? `: ${one.description}` : ''}`).join('\n').slice(0, MAX_DESCRIPTION) } : null;
  return { ...input, sources, picked: [...new Set([...(Array.isArray(input.picked) ? input.picked : []), ...picked])], project: project || input.project, direct };
}

/**
 * Import manually with fine-grained permissions (From Amitav, 2026-10-15): what the person said on Import your context's
 * tools screen, for the librarian, who asks before anything comes in → the lines of its import instructions: their work,
 * what they specified for each source, and the tools they use that Engelbart has no source for.
 */
/** An extra tool as an agent is told it: its name, its website, and what the person specified for it. */
function toolSaid(tool) {
  const said = [String(tool.note || '').replace(/[.\s]+$/, ''), tool.projects && tool.projects.length ? `only for these of the projects: ${tool.projects.join('; ')}` : ''].filter(Boolean).join('; ');
  return `${tool.name}${tool.website ? ` (${tool.website})` : ''}${said ? `: ${said}` : ''}`;
}

function librarianNotes(direct) {
  const name = (id) => (id === importFlow.SITES ? 'Saved URLs' : shownName(id));
  const lines = [];
  if (direct.roles.length) lines.push(`They describe their work as: ${direct.roles.join(', ')}.`);
  if (direct.work) lines.push(`What they are interested in researching right now, in their words: ${direct.work}`);
  const said = direct.apps.map((id) => {
    const scope = direct.scopes[id];
    if (!scope) return '';
    const parts = [
      String(scope.note || '').replace(/[.\s]+$/, ''),
      scope.folders.length ? `only these folders and files: ${scope.folders.map((folder) => folder.path).join('; ')}` : '',
      scope.people.length ? `only with these people: ${scope.people.join('; ')}` : '',
      scope.projects.length ? `only for these of the projects: ${scope.projects.join('; ')}` : '',
    ].filter(Boolean);
    return parts.length ? `- ${name(id)}: ${parts.join('; ')}` : '';
  }).filter(Boolean);
  if (said.length) lines.push(`What they said to bring in from each source:\n${said.join('\n')}`);
  if (direct.additional.length) lines.push(`Other tools they use that Engelbart has no source for:\n${direct.additional.map((tool) => `- ${toolSaid(tool)}`).join('\n')}`);
  return lines.join('\n');
}

/**
 * The choose screen's answer made safe → { sources: { id: { on, apps, folders, repos } }, custom, computer, permissions,
 * project }. `project` { name, description } (or null) is what the person is working on; it is kept in session.json with
 * the rest, so a session picked up again after a quit still knows it.
 */
function cleanChoices(input, homeDir, { alsoPicked = [] } = {}) {
  const given = input && typeof input === 'object' ? input : {};
  const sources = {};
  for (const source of SOURCES) {
    const value = given.sources && typeof given.sources === 'object' ? given.sources[source.id] : null;
    if (!value || typeof value !== 'object') { sources[source.id] = { on: false, apps: [], folders: [], repos: [] }; continue; }
    const apps = (Array.isArray(value.apps) ? value.apps : []).filter((app) => source.apps.includes(app));
    const folders = (Array.isArray(value.folders) ? value.folders : []).map((dir) => readers.expandPath(homeDir, dir)).filter((dir) => dir && dir.startsWith(homeDir + path.sep)).slice(0, 12);
    const repos = (Array.isArray(value.repos) ? value.repos : []).filter((repo) => typeof repo === 'string' && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo)).slice(0, 100);
    sources[source.id] = { on: !!value.on, apps, folders, repos };
  }
  const allowed = given.permissions && typeof given.permissions === 'object' ? given.permissions : {};
  const computer = given.computer !== false && allowed.files !== false;
  // The folders the person chose in the folder picker (MATH-110): macOS lets Engelbart read them even inside a protected
  // folder it was not let to read. Only those among the sources' folders count.
  const chosen = new Set([...Object.values(sources).flatMap((source) => source.folders), ...alsoPicked]);
  const picked = [...new Set((Array.isArray(given.picked) ? given.picked : []).map((dir) => readers.expandPath(homeDir, dir)).filter((dir) => dir && chosen.has(dir)))].slice(0, 40);
  return {
    sources,
    picked,
    custom: typeof given.custom === 'string' ? given.custom.trim().slice(0, 4000) : '',
    computer,
    // recall (2026-10-15, Hudson: "it should still be able to run the prompt asking about me"): the one thing an agent
    // sends, Engelbart's question word for word (./browser.cjs sendOnly), and the chat it opened is deleted after.
    permissions: { files: computer, browser: allowed.browser !== false, recall: allowed.recall !== false, notes: allowed.notes === true },
    project: cleanProject(given.project),
    days: cleanDays(given.days), // how far back to look (2026-10-10): 182, 365, or null for all time
    direct: cleanDirect(given.direct, homeDir), // Import your context (2026-10-13): no librarian, one import a tool
    keychain: given.keychain !== false, // whether the person let Engelbart copy their browser's sign-ins (2026-10-13)
    browserAgents: cleanBrowserAgents(given.browserAgents), // the web apps' imports in the person's own browser (2026-10-13)
    extras: cleanExtras(given.extras), // the librarian's run: tools the agents found that Engelbart has no import for (2026-10-15)
  };
}

/** Tools Engelbart has no import of its own for, as a manual run keeps them → [{ name, website, note, projects }]. */
function cleanExtras(value) {
  const text = (one, max) => (typeof one === 'string' ? one.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  return (Array.isArray(value) ? value : []).filter((one) => one && typeof one === 'object' && text(one.name, 60)).slice(0, 12).map((one) => ({
    name: text(one.name, 60), website: hostOfSite(one.website) ? String(one.website).trim().slice(0, 300) : '', note: text(one.note, 600),
    projects: (Array.isArray(one.projects) ? one.projects : []).map((title) => text(title, 120)).filter(Boolean).slice(0, MAX_DIRECT_PROJECTS),
  }));
}

/**
 * Browser agents for a run (../onboarding/browser-agents.cjs, set by start from what this Mac and the person allow, never
 * from the window's word) → { browserId, browserName, enable } | null. `enable`: Codex's browser use turned on for the run,
 * the person having allowed it in Engelbart rather than in their own Codex.
 */
function cleanBrowserAgents(value) {
  if (!value || typeof value !== 'object' || typeof value.browserId !== 'string' || !/^[a-z]{2,20}$/.test(value.browserId)) return null;
  const name = typeof value.browserName === 'string' ? value.browserName.replace(/[^\w .-]/g, '').trim().slice(0, 40) : '';
  return { browserId: value.browserId, browserName: name || 'your browser', enable: value.enable === true };
}

// The web apps an Import your context run's browser agents bring in, in the person's own browser. Round 3 (2026-10-13):
// only as a fallback. Every web app is read in Engelbart's hidden browser with the sign-ins copied from the person's (no
// plugin, nothing brought to the front, no tab left open, files exported rather than downloaded); the person's own browser
// is used for an app only when it holds the app's sign-in and that sign-in will not work in Engelbart's (Google ties a
// session to the browser that made it), and only when the person allowed agents to use it: `s.fallback`.
const browseApp = (s, app) => !!(s && s.choices && s.choices.direct && s.choices.browserAgents && s.fallback && s.fallback.has(app));

/** The <project> block every agent is given when there is a project with a description, else nothing. */
function projectBlock(choices) {
  const project = projectFor(choices);
  if (!project) return '';
  return `<project note="What the person is working on: the project this library is being connected for.">\n${project.name ? `Name: ${project.name}\n` : ''}Description: ${project.description}\n</project>`;
}

/** The <period> block surveys and imports are given (2026-10-10): how far back the person chose to look. */
function periodBlock(choices) {
  const days = (choices && choices.days) || null;
  return `<period days="${days || 'all'}">${days ? `Only ${periodName(days)}: things changed or written in the last ${days} days. The listing tools hold to it. Older items come in only when <plan> names them (by path for PDFs).` : 'All time: no limit on how far back.'}</period>`;
}

/**
 * What an option covers (2026-10-11), shown in its ⓘ: the real titles with their dates and places. Its line breaks are
 * kept (at most 10 lines, blank ones dropped, spaces in a line folded), up to 600 characters; anything not a string is ''.
 */
function detailOf(value) {
  if (typeof value !== 'string') return '';
  const lines = value.replace(/\r\n?/g, '\n').split('\n').map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 10);
  return clip(lines.join('\n'), 600);
}

/**
 * One option of a question: a label and, when given, a few words of why and what it covers → { label, why, detail } or null.
 * In a "multi" (`multi` true) it also keeps whether the librarian recommends it, `checked` (MATH-122, 2026-10-11), though the
 * card no longer shows it (2026-10-12: no tag, nothing starts ticked). A "single" has no such field.
 */
function optionOf(option, multi = false) {
  const checked = multi ? { checked: !!(option && typeof option === 'object' && option.checked === true) } : {};
  // The survey ids it stands for (2026-10-15), for an app whose items the person approves (tools.cjs APPROVAL_APPS).
  const ids = option && typeof option === 'object' && Array.isArray(option.ids) ? [...new Set(option.ids.filter((id) => typeof id === 'string' && id.trim()).map((id) => line(id, 300)))].slice(0, 200) : [];
  if (option && typeof option === 'object') { const label = line(option.label, 160); return label ? { label, why: line(option.why, 140), detail: detailOf(option.detail), ...checked, ...(ids.length ? { ids } : {}) } : null; }
  const label = line(option, 160);
  return label ? { label, why: '', detail: '', ...checked } : null;
}

/**
 * The librarian's reply made safe → { say, ask, authorize, dispatch, waiting, done }. A reply that is not the JSON it was
 * asked for is shown as it came, as words with no question: the person can still answer by typing.
 */
function readReply(text, choices) {
  const raw = String(text || '').trim();
  const body = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = body.indexOf('{'), end = body.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(body.slice(start, end + 1)); } catch { value = null; } }
  if (!value || typeof value !== 'object') return { say: clip(raw, 2000) || '…', ask: null, authorize: null, dispatch: [], waiting: false, done: false, unread: true };
  const on = (id) => !!(choices.sources[id] && choices.sources[id].on);
  let ask = null;
  const reposAsk = value.ask && typeof value.ask === 'object' && typeof value.ask.title === 'string' && (value.ask.kind === 'repos' || (value.ask.source === 'code' && value.ask.kind !== 'open' && REPOS_ASK.test(value.ask.title)));
  if (reposAsk && value.ask.title.trim()) {
    ask = { source: 'code', kind: 'repos', title: line(value.ask.title, 300), options: [], placeholder: '' };
  } else if (value.ask && typeof value.ask === 'object' && ASK_KINDS.has(value.ask.kind) && value.ask.kind !== 'repos' && typeof value.ask.title === 'string' && value.ask.title.trim()) {
    const options = (Array.isArray(value.ask.options) ? value.ask.options : []).map((option) => optionOf(option, value.ask.kind === 'multi')).filter(Boolean).filter((option, i, all) => all.findIndex((other) => other.label === option.label) === i).slice(0, 10);
    const source = sourceOf(value.ask.source) ? value.ask.source : null;
    const apps = source && Array.isArray(value.ask.apps) ? [...new Set(value.ask.apps.filter((app) => sourceOf(source).apps.includes(app)))] : [];
    if (value.ask.kind === 'open' || options.length) ask = { source, ...(apps.length ? { apps } : {}), kind: value.ask.kind, title: line(value.ask.title, 300), options: value.ask.kind === 'open' ? [] : options, placeholder: value.ask.kind === 'open' ? line(value.ask.placeholder, 120) : '' };
  }
  let authorize = null;
  const a = value.authorize || value.connect; // "connect" was the first build's name for it
  if (!ask && a && typeof a === 'object' && AUTHORIZE_KINDS.has(a.kind) && (APPS[a.app] || a.app === 'GitHub')) {
    const reach = appOf(a.app) ? appOf(a.app).reach : 'signin';
    const fits = a.kind === 'signin' ? SIGNIN_APPS.has(a.app) : a.kind === 'connector' ? reach === 'connector' : a.kind === 'permission' ? reach === 'automation' : reach === 'local';
    if (fits) {
      const label = line(a.label, 60) || (a.kind === 'permission' ? `Allow Engelbart to read ${shownName(a.app)}` : a.kind === 'folder' ? (a.app === LOCAL_PDFS ? 'Choose a folder of PDFs…' : `Choose your ${shownName(a.app)} folder…`) : `Sign in to ${shownName(a.app)}`);
      authorize = { source: sourceOf(a.source) ? a.source : sourceOfApp(a.app), app: a.app, kind: a.kind, label };
    }
  }
  const dispatch = (Array.isArray(value.dispatch) ? value.dispatch : []).filter((entry) => entry && typeof entry === 'object' && sourceOf(entry.source) && on(entry.source) && typeof entry.plan === 'string' && entry.plan.trim())
    .slice(0, 6).map((entry) => ({ source: entry.source, apps: (Array.isArray(entry.apps) ? entry.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub')).slice(0, 8), label: line(entry.label, 80) || sourceOf(entry.source).label, plan: clip(entry.plan, 8000) }));
  return { say: clip(typeof value.say === 'string' ? value.say : '', 2000), ask, authorize, dispatch, waiting: value.waiting === true && !ask && !authorize, done: value.done === true };
}

/**
 * A survey agent's report made safe → { signedIn, summary, total, items: [{ id, label, kind, date, where, why }], notes,
 * folders, searched }. A search for an app's folder (MATH-117) also says "folder" (or, for PDFs, "folders"): only folders
 * inside `homeDir` that are there are kept.
 */
function readSurvey(text, homeDir = null) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  let value = null;
  if (start >= 0 && end > start) { try { value = JSON.parse(raw.slice(start, end + 1)); } catch { value = null; } }
  if (!value || typeof value !== 'object') return { signedIn: null, summary: line(raw, 600), total: null, items: [], notes: null, folders: [], searched: null };
  const items = (Array.isArray(value.items) ? value.items : []).filter((item) => item && typeof item === 'object' && (item.id || item.label)).slice(0, 40)
    .map((item) => ({ id: line(item.id, 300), label: line(item.label, 160), kind: line(item.kind, 20), date: line(item.date, 20) || null, where: line(item.where, 120) || null, why: line(item.why, 120) || null }));
  const home = homeDir ? path.resolve(homeDir) : null;
  const inHome = (folder) => {
    if (!home || typeof folder !== 'string' || !folder.trim()) return null;
    const full = readers.expandPath(home, folder);
    if (!full || !full.startsWith(home + path.sep)) return null;
    try { return fs.statSync(full).isDirectory() ? full : null; } catch { return null; }
  };
  const folders = [...new Set([value.folder, ...(Array.isArray(value.folders) ? value.folders : [])].map(inHome).filter(Boolean))].slice(0, 12);
  return { signedIn: typeof value.signedIn === 'boolean' ? value.signedIn : null, summary: line(value.summary, 600), total: Number.isFinite(value.total) ? value.total : null, items, notes: value.notes ? line(value.notes, 600) : null, folders, searched: value.searched ? line(value.searched, 300) : null };
}

/** What the person did, as the librarian is told it. */
function messageOf(input) {
  if (input.skipped) return input.left ? `skipped: ${input.left} is left out for this run; nothing of it comes in` : 'skipped';
  if (input.importNow) return 'Import now.';
  if (Array.isArray(input.picked) && input.picked.length) return `picked ${input.picked.map((label) => `"${line(label, 160)}"`).join(', ')}${input.text ? `, and said: ${line(input.text, 2000)}` : ''}`;
  if (input.authorized) return `${input.authorized.kind === 'permission' ? 'allowed' : input.authorized.kind === 'signin' ? 'signed in' : 'authorized'} "${input.authorized.app}"`;
  if (input.chose) return `chose ${input.chose.kind} "${input.chose.shown}" for "${input.chose.app}"`;
  if (input.survey) return `survey finished: "${input.survey}"`;
  return line(input.text, 4000);
}

/** What the chat shows for it. */
function shownOf(input) {
  if (input.skipped) return 'Skip';
  if (input.importNow) return 'Import now';
  if (Array.isArray(input.picked) && input.picked.length) return [input.picked.map((label) => line(label, 160)).join(', '), input.text ? clip(input.text, 2000) : ''].filter(Boolean).join(' — ');
  if (input.authorized) return input.authorized.kind === 'permission' ? `Allowed ${shownName(input.authorized.app)}` : `Signed in to ${shownName(input.authorized.app)}`;
  if (input.chose) return `${input.chose.shown}`;
  return clip(input.text, 4000);
}

/**
 * `agents` (./agents.cjs or the fake's); `models()` Build's model list (the pinned models' ids); `ready()` the providers
 * whose CLI can run now; `context()` the store's context; `zotero` { status(), root(), download? }; `github` { status(),
 * repos() }; `deps` for the library (describe, identifyRepo, inspectPdf, onAdded, onPdf); `notify(snapshot)` on every
 * change; `openBridge` (../sandbox/local-tools.cjs openToolBridge); `browser` the agents' browser (./browser.cjs, null
 * where there is none); `connectors` (./connectors.cjs); `appleNotes` (./apple-notes.cjs).
 */
function createConnect({ agents, models = () => null, ready = () => [...PROVIDERS], context, homeDir, env = process.env, zotero = {}, github = {}, deps = {}, notify = () => {}, placed = () => {}, openBridge, browser = null, connectors = null, appleNotes = null, webSignIn = null, signInWindow = null, trace = null, browserAgents = null, openBrowserApp = null, providerCheck = null, now = () => new Date().toISOString() }) {
  const sessions = new Map();
  // The agent trace (../onboarding/trace.cjs): the dispatching around the agents' turns, written down as it happens.
  const traced = (entry) => { if (trace) { try { trace.event(entry); } catch { /* a record, never in the way */ } } };
  const readyNow = () => { try { return (ready() || []).filter((provider) => PROVIDERS.includes(provider)); } catch { return [...PROVIDERS]; } };
  const choiceFor = (provider) => connectChoice(provider, (() => { try { return models(); } catch { return null; } })());
  // The web apps' sign-ins checked when they were ticked on the choose screen (2026-10-10, signInCheck), kept while Engelbart
  // runs: the browsers macOS refused (not asked again until Try again), each app's last answer { status, browser, browserId },
  // and the checks still waiting on macOS.
  const signInDenied = new Set();
  const signInChecked = new Map();
  const signInChecking = new Map();

  const publicJob = (job) => ({ id: job.id, kind: job.kind, source: job.source, label: job.label, apps: job.apps, status: job.status, skipped: !!job.skipped, notes: job.notes, items: job.items, activity: job.activity, summary: job.summary, error: job.error, started: job.started, ended: job.ended, ...(job.route ? { route: job.route } : {}) });
  const chosenBrowser = () => { try { return webSignIn && webSignIn.browserName ? webSignIn.browserName() : ''; } catch { return ''; } };
  // The browser its sign-in opens in (2026-10-15: "Open Safari" on a card whose sign-in Safari can never give Engelbart).
  const opensIn = (app) => { try { return (webSignIn && typeof webSignIn.opensIn === 'function' && webSignIn.opensIn(app)) || ''; } catch { return ''; } };
  const publicNeed = (need) => ({ id: need.id, app: need.app, kind: need.kind, reason: need.reason, jobs: need.jobs.length, jobIds: [...need.jobs], opened: need.opened, busy: need.busy, browser: need.browser || need.own || (SIGNIN_KINDS.has(need.kind) && opensIn(need.app)) || chosenBrowser(), error: need.error, note: need.note || '', at: need.at, ...(need.own ? { own: true } : {}), ...(need.code ? { code: need.code } : {}), ...(need.kind === SIGNIN_HERE ? { where: need.where || 'here' } : {}) });
  // What was left out of the run and why, in the person's words (2026-10-14: "when she finally hit later, nothing was
  // imported, so she was super confused"): the status's completion names each, with its reason.
  const publicLeftOut = (s) => [...(s.leftOut || new Map())].map(([app, why]) => ({ app, why }));
  function snapshot(s) {
    return {
      id: s.id, mode: s.mode, chat: s.chat, thinking: s.thinking, activity: s.activity, waiting: s.waitingForSurvey, done: s.done, error: s.error, finished: s.finished, stopped: s.stopped, minimized: s.minimized, dismissed: s.dismissed,
      jobs: s.jobs.filter((job) => job.kind !== 'redact').map(publicJob), needs: s.needs.filter((need) => !need.closed).map(publicNeed), log: s.log.slice(-SHOWN_LOG),
      provider: s.choice.provider, choice: { provider: s.choice.provider, name: PROVIDER_NAMES[s.choice.provider], modelName: s.choice.modelName, effort: s.choice.effort },
      permissions: s.choices.permissions, projectId: s.projectId, workspaceId: s.workspaceId || null, staged: s.projectId ? 0 : notes.stagedCount(s.dir), memory: { ...s.memory }, created: s.created,
      counts: { notes: s.jobs.reduce((n, job) => n + job.notes, 0), items: s.jobs.reduce((n, job) => n + job.items, 0) },
      placed: { project: s.inProject.size, workspace: s.inWorkspace.size },
      leftOut: publicLeftOut(s),
      // waiting for its provider's CLI to be connected (holdForProvider): the workspace's "Connect Claude Code" popup
      blocked: s.blocked ? { provider: s.blocked.provider, name: PROVIDER_NAMES[s.blocked.provider], error: s.blocked.error, at: s.blocked.at || null } : null,
      // Import your context's run (2026-10-13): how it was chosen and the projects every agent keeps to, for its status modal
      direct: s.choices.direct ? { mode: s.choices.direct.mode, projects: s.choices.direct.projects.map((project) => project.title) } : null,
      // Import your context's manual run (the librarian's, From Amitav 2026-10-15): put away once finished, its status opens
      // rather than the chat (2026-10-16: "i should not be able to see this weird popup in manual mode").
      manual: !!s.manual,
      // Apps still held on their sign-in or Connect step, or being brought back (recover): the run has not ended while any is.
      holding: s.held ? s.held.size : 0,
    };
  }
  // What session.json keeps is enough to pick the session up again after Engelbart quits (resume): the chat, the choices,
  // what was found, the jobs with their plans, the librarian's agent session, what the person skipped. Never MEMORY.md's
  // draft before its secrets are out: a session that quit then writes it again.
  function save(s, { force = false } = {}) {
    if (s.suspended && !force) return;
    try {
      fs.mkdirSync(s.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({
        ...snapshot(s), log: s.log, choices: s.choices, picked: s.picked, found: s.found, interviewSession: s.interviewSession, skipped: [...s.skipped], skippedSources: [...s.skippedSources],
        suspended: !!s.suspended, allowed: [...(s.allowed || [])], approved: Object.fromEntries([...(s.approved || new Map())].map(([app, ids]) => [app, [...ids]])), gmailThreads: s.gmailThreads || 0, fallback: [...(s.fallback || [])], connected: [...(s.connected || [])], rows: [...s.rows], inProject: [...s.inProject], inWorkspace: [...s.inWorkspace], workspaceId: s.workspaceId, jobs: s.jobs.map((job) => ({ ...publicJob(job), key: job.key, plan: job.plan, titles: job.titles, ...(job.find ? { find: true } : {}), ...(job.extra && job.extra.sites ? { extra: { sites: job.extra.sites, ...(job.extra.tool ? { tool: job.extra.tool } : {}) } } : {}) })),
      }, null, 2), { mode: 0o600 });
    } catch { /* the chat goes on */ }
  }
  let emitTimer = null;
  const pending = new Set();
  function emit(s, { soon = false } = {}) {
    if (s.suspended) return; // put away until Engelbart opens this library again: its agents' last words are not news
    if (!soon) { pending.delete(s); save(s); notify(snapshot(s)); return; }
    pending.add(s);
    if (emitTimer) return;
    emitTimer = setTimeout(() => { emitTimer = null; for (const held of pending) notify(snapshot(held)); pending.clear(); }, 250);
    if (emitTimer.unref) emitTimer.unref();
  }

  /** The action log: what each agent did, in the person's words, newest last. */
  function logAction(s, job, text, who = null) {
    s.log.push({ at: now(), job: job ? job.id : null, who: who || (job ? job.label : 'Engelbart'), text: line(text, 200) });
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG);
    emit(s, { soon: true });
  }

  function get(id) {
    const s = typeof id === 'string' && ID_RE.test(id) ? sessions.get(id) : null;
    if (!s) throw new Error('That import is no longer open');
    return s;
  }

  /**
   * What macOS let Engelbart read of its protected folders (MATH-110, ./folder-access.cjs): those allowed on the choose
   * screen, the folders the person picked themselves, and the places of the apps they ticked that Engelbart knows from the
   * app itself (Obsidian's vaults, ~/Documents/Zoom), which the choose screen does not ask about: read as before.
   */
  function accessOf(s) {
    const on = (app) => Object.values(s.choices.sources).some((choice) => choice.on && choice.apps.includes(app));
    const places = [
      ...(on('Obsidian') || (s.choices.sources.sites && s.choices.sources.sites.on) ? readers.obsidianVaults(homeDir).map((vault) => vault.path) : []),
      ...(on('Zoom') ? [path.join(homeDir, 'Documents', 'Zoom')] : []),
    ];
    return folderAccess.guard({ homeDir, dataRoot: s.dataRoot, picked: [...(s.choices.picked || []), ...places] });
  }

  /**
   * The folders the agents' file tools may read: what the sources need, or the whole home folder when allowed. A folder
   * inside a protected one macOS did not let Engelbart read is not given (MATH-110); the home folder still is, the find
   * search being told to keep out of those (findMessage) and the file tools refusing them (./tools.cjs).
   */
  function dirsOf(s) {
    const dirs = new Set();
    const access = accessOf(s);
    const grant = (dir) => { if (dir && fs.existsSync(dir)) dirs.add(path.resolve(dir)); };
    const add = (dir) => { if (dir && access.readable(dir)) grant(dir); };
    if (s.choices.computer) grant(homeDir);
    for (const [id, choice] of Object.entries(s.choices.sources)) {
      if (!choice.on) continue;
      for (const dir of choice.folders) add(dir);
      for (const app of choice.apps) {
        if (app === 'Obsidian') for (const vault of readers.obsidianVaults(homeDir)) add(vault.path);
        if (app === 'Claude Code') add(path.join(homeDir, '.claude', 'projects'));
        if (app === 'Codex') add(path.join(env.CODEX_HOME || path.join(homeDir, '.codex'), 'sessions'));
        if (app === 'Zoom') add(path.join(homeDir, 'Documents', 'Zoom'));
        if (app === 'Zotero') { add(path.join(homeDir, 'Zotero', 'storage')); add(zotero.root ? zotero.root() : null); }
      }
      if (id === 'sites') for (const vault of readers.obsidianVaults(homeDir).slice(0, 2)) add(vault.path);
    }
    for (const file of [...Object.values(s.picked.folders), ...Object.values(s.picked.exports)]) add(fs.existsSync(file) && fs.statSync(file).isDirectory() ? file : path.dirname(file));
    grant(s.downloads);
    // The narrowest set: a folder inside another granted one adds nothing.
    const list = [...dirs].sort((a, b) => a.length - b.length);
    return list.filter((dir, i) => !list.slice(0, i).some((outer) => dir.startsWith(outer + path.sep)));
  }

  async function libraryCounts(ctx) {
    try {
      const rows = await ctx.libraryDb.list();
      const has = (tag) => rows.filter((row) => Array.isArray(row.tags) && row.tags.includes(tag)).length;
      return { items: rows.length, notes: has('note'), papers: has('paper'), repositories: has('git'), websites: rows.filter((row) => row.type === 'website' && !(row.tags || []).length).length };
    } catch { return null; }
  }

  function instructionsText(dataRoot) {
    try { return fs.readFileSync(path.join(dataRoot, 'instructions.md'), 'utf8').trim(); } catch { return ''; }
  }

  /**
   * A line Engelbart says in the chat about the run (an app left out, skipped, not connected), not the librarian's: drawn
   * quietly, and never the chat's last word, so a question still open stays open (2026-10-16, Hudson: "When these start to
   * fail … the original message got greyed out, meaning I couldn't respond to it").
   */
  function notice(s, text) {
    s.chat.push({ role: 'agent', notice: true, text, ask: null, authorize: null, at: now() });
  }

  /** The librarian's own last word (not a notice, not the apps' grant), or null. */
  function lastSaid(s) {
    return [...s.chat].reverse().find((entry) => entry.role === 'agent' && !entry.notice && !entry.grant && !entry.opener) || null;
  }

  function conversationText(s) {
    const spoken = (entry) => {
      if (entry.grant) return `engelbart: asked the person to allow ${listed(entry.grant.rows.map((row) => row.name))}${entry.grant.answered ? `; they allowed ${entry.grant.answered.allowed.length ? listed(entry.grant.answered.allowed) : 'none'}${entry.grant.answered.skipped.length ? ` and left out ${listed(entry.grant.answered.skipped)}` : ''}` : '; not answered yet'}`;
      if (entry.notice) return `engelbart: ${entry.text}`;
      return null;
    };
    return s.chat.filter((entry) => !entry.opener).map((entry) => spoken(entry) || `${entry.role === 'agent' ? 'librarian' : 'person'}: ${entry.text}${entry.ask ? `\n  (asked, ${entry.ask.kind}: ${entry.ask.title}${entry.ask.options.length ? ` — ${entry.ask.options.map((option) => option.label).join(' | ')}` : ''})` : ''}${entry.authorize ? `\n  (offered the button: ${entry.authorize.label})` : ''}`).join('\n');
  }

  function importsText(s) {
    const work = s.jobs.filter((job) => job.kind === 'import' || job.kind === 'survey');
    if (!work.length) return '';
    return JSON.stringify(work.map((job) => ({ kind: job.kind, label: job.label, source: job.source, apps: job.apps, status: job.status, notesAdded: job.notes, itemsAdded: job.items, ...(job.summary && job.kind === 'import' ? { said: job.summary } : {}), ...(job.error ? { error: job.error } : {}) })));
  }

  function engelbartBlock(s) {
    const where = `What comes in is saved in their library: notes, chats and documents as Markdown files in ${path.join(s.dataRoot, 'assets', 'md')}, papers, files and links as library items.`;
    return `<engelbart>\nA person is connecting their library to Engelbart. Their library is at ${s.dataRoot}. ${where}\nPermissions they gave: read files anywhere in their home folder: ${s.choices.permissions.files ? 'yes' : 'no, only the folders of the sources they picked'}; use their accounts in Engelbart's background browser: ${s.choices.permissions.browser ? 'yes' : 'no (web apps are left out)'}; ask their AI assistants what they remember: ${s.choices.permissions.recall ? 'yes' : 'no'}.\n</engelbart>`;
  }

  /**
   * A browser agent's job (2026-10-13): the browser it works in, the sites of its apps, where what it downloads lands. The
   * rules it keeps are its system prompt's (prompts.BROWSE_SYSTEM_PROMPT).
   */
  function browserBlock(s, job, apps) {
    const agentsOf = s.choice.provider === 'openai' ? 'Codex\'s Chrome plugin' : 'Claude in Chrome';
    const sites = [...new Set([...sitesOf(apps), ...((job.extra && Array.isArray(job.extra.sites)) ? job.extra.sites : [])])];
    return `<browser note="The person's own browser, where they are signed in. You work in it through ${agentsOf}.">\n${JSON.stringify({ browser: s.choices.browserAgents.browserName, sites })}\n</browser>`;
  }

  const surveying = (s) => s.jobs.some((job) => job.kind === 'survey' && !ENDED.has(job.status)) || !!(s.held && s.held.size);

  async function firstMessage(s, message, { again = false } = {}) {
    const ctx = await context();
    const custom = instructionsText(s.dataRoot);
    const parts = [
      engelbartBlock(s),
      projectBlock(s.choices),
      `<choices>\n${JSON.stringify({ ...s.choices.sources, customInstructionsForThisImport: s.choices.custom || null, permissions: s.choices.permissions, period: periodName(s.choices.days), days: s.choices.days || null }, null, 1)}\n</choices>`,
      `<found>\n${JSON.stringify(s.found, null, 1)}\n</found>`,
      `<library>${JSON.stringify(await libraryCounts(ctx))}</library>`,
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      again && s.chat.length ? `<conversation note="What was said so far; your earlier replies are summarised as what you asked.">\n${conversationText(s)}\n</conversation>` : '',
      again && s.jobs.length ? `<imports>${importsText(s)}</imports>` : '',
      `<message>${message}</message>`,
    ];
    s.newFound = null;
    return parts.filter(Boolean).join('\n\n');
  }

  function laterMessage(s, message) {
    const parts = [];
    const imports = importsText(s);
    if (imports && imports !== s.toldImports) { parts.push(`<imports>${imports}</imports>`); s.toldImports = imports; }
    if (s.newFound) { parts.push(`<found note="What changed since your last turn.">\n${JSON.stringify(s.newFound, null, 1)}\n</found>`); s.newFound = null; }
    parts.push(`<message>${message}</message>`);
    return parts.join('\n\n');
  }

  /** One librarian turn: what the person did → its reply applied (a message in the chat, imports started). */
  async function interviewTurn(s, message) {
    if (s.stopped || s.suspended) return;
    s.thinking = true;
    s.activity = '';
    s.error = '';
    s.waitingForSurvey = false;
    s.surveyNews = []; // what they found is in <found> this turn
    emit(s);
    const controller = new AbortController();
    s.interviewController = controller;
    const onUpdate = ({ activity }) => { if (activity && activity !== s.activity) { s.activity = activity; emit(s, { soon: true }); } };
    const system = promptOf(s.dataRoot, 'connect-system-prompt.md', prompts.INTERVIEW_SYSTEM_PROMPT);
    const meta = { kind: 'interview', session: s, message };
    const base = { choice: s.choice, kind: 'interview', system, dirs: s.dirs, signal: controller.signal, onUpdate, meta };
    try {
      let out;
      if (s.interviewSession) {
        try {
          out = await agents.turn({ ...base, message: laterMessage(s, message), session: s.interviewSession });
        } catch (error) {
          if (error && error.kind === 'stopped') throw error;
          // A session that will not resume starts again from everything, the conversation included.
          out = await agents.turn({ ...base, message: await firstMessage(s, message, { again: true }), session: null });
        }
      } else {
        out = await agents.turn({ ...base, message: await firstMessage(s, message, { again: s.chat.length > 1 }), session: null });
      }
      s.interviewSession = out.session || null;
      s.toldImports = importsText(s);
      apply(s, readReply(out.text, s.choices));
    } catch (error) {
      if (!(error && error.kind === 'stopped')) s.error = error && error.message ? error.message : 'The librarian did not answer.';
    } finally {
      if (s.interviewController === controller) s.interviewController = null;
      s.thinking = false;
      s.activity = '';
      emit(s);
      // A survey that reported while the librarian talked, and it said it would wait: woken now. Waiting with no survey
      // left to report would leave the chat still for good: it is told so (twice at most), and goes on.
      if (!s.stopped && !s.suspended && !s.finished && s.waitingForSurvey) {
        if (s.surveyNews.length) wake(s);
        else if (!surveying(s) && (s.nudges = (s.nudges || 0) + 1) <= 2) void interviewTurn(s, 'Every survey has reported already: what they found is in <found>. Go on.');
      }
    }
  }

  function apply(s, reply) {
    s.chat.push({ role: 'agent', text: reply.say || (reply.ask ? '' : reply.dispatch.length ? 'Starting that now.' : '…'), ask: reply.ask, authorize: reply.authorize, at: now() });
    for (const entry of reply.dispatch) dispatch(s, { ...entry, kind: 'import' });
    if (reply.done && !surveying(s)) s.done = true;
    s.waitingForSurvey = !s.done && !reply.ask && !reply.authorize && (reply.waiting || (reply.done && surveying(s)));
    maybeMemory(s);
  }

  /** The librarian woken by what a survey found, when it said it was waiting for one. */
  function wake(s) {
    if (s.thinking || s.stopped || s.suspended || s.finished) return;
    const apps = [...new Set(s.surveyNews.splice(0))];
    if (!apps.length) return;
    void interviewTurn(s, apps.map((app) => messageOf({ survey: app })).join('; '));
  }

  /* --------------------------------------------------------------------------------------------- the priority queue */

  /** A job queued: started when a place is free, the most urgent kind first. The same kind, source and apps go once. */
  function dispatch(s, { kind = 'import', source, apps: given = [], label, plan = '', extra = null, find = false, route = null, again = false, keyExtra = '' }) {
    if (kind === 'import' && s.skippedSources.has(source)) return null; // the person skipped it: nothing of it comes in
    const apps = (kind === 'import' && given.length ? given.filter((app) => !s.skipped.has(app)) : given).filter((app) => mayReach(s, app));
    if (given.length && !apps.length) return null;
    // `again`: an import run once more because a connector was signed in after its agent had started (rerunJob).
    const key = `${find ? 'find' : kind}:${source}:${[...apps].sort().join(',')}${again ? ':again' : ''}${keyExtra ? `:${keyExtra}` : ''}`;
    if (s.jobs.some((job) => job.key === key) || s.jobs.length >= MAX_JOBS) return null;
    if (apps.length && apps.every((app) => s.skipped.has(app))) return null; // the person skipped them for this run
    if (kind === 'import' && apps.length && s.jobs.some((job) => job.kind === 'import' && job.source === source && !job.apps.length)) return null; // the whole source went already
    s.seq += 1;
    const job = { id: randomUUID(), key, kind, priority: PRIORITY[kind], seq: s.seq, source, apps, label, plan, extra, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null, ...(find ? { find: true } : {}), ...(route === 'browser' && kind === 'import' ? { route } : {}) };
    s.jobs.push(job);
    traced({ kind: 'dispatch', sessionId: s.id, jobId: job.id, text: `Queued ${kind}${find ? ' (folder search)' : ''}${job.route ? ` (in ${s.choices.browserAgents.browserName})` : ''}: ${label}`, detail: { kind, source, apps, label, priority: PRIORITY[kind], plan, route: job.route || undefined, sites: extra && extra.sites ? extra.sites : undefined } });
    logAction(s, job, find ? `Will look for your ${folderName(apps[0])}` : kind === 'survey' ? `Will look through ${apps.map(shownName).join(', ')}` : kind === 'recall' ? `Will ask ${apps.map(shownName).join(', ')} what it remembers` : kind === 'import' ? 'Queued' : 'Queued');
    pump(s);
    return job;
  }

  function pump(s) {
    if (s.stopped || s.suspended || s.blocked) return; // `blocked`: waiting for its provider to be connected (holdForProvider)
    for (;;) {
      const running = s.jobs.filter((job) => job.status === 'running' || job.status === 'waiting').length;
      if (running >= (deps.maxRunning || MAX_RUNNING)) break; // deps.maxRunning: a test's smaller limit
      const next = s.jobs.filter((job) => job.status === 'queued').sort((a, b) => a.priority - b.priority || a.seq - b.seq)[0];
      if (!next) break;
      void runJob(s, next);
    }
  }

  const sitesOf = (apps) => [...new Set(apps.flatMap((app) => (appOf(app) && appOf(app).sites) || []))];
  /** The apps a job covers: those it names, else every app picked for its source (a whole source handed over). */
  // A whole source handed over reaches its apps, but in the librarian's run never one the person hasn't allowed (askGrant).
  const appsOfJob = (s, job) => (job.apps.length ? job.apps : ((s.choices.sources[job.source] || {}).apps || [])).filter((app) => job.apps.includes(app) || mayReach(s, app));

  function jobMessage(s, job) {
    const custom = instructionsText(s.dataRoot);
    const choice = s.choices.sources[job.source] || {};
    const apps = job.apps.length ? job.apps : choice.apps || [];
    const found = (s.found || {})[job.source] || {};
    const period = periodBlock(s.choices);
    if (job.kind === 'survey' && job.find) return findMessage(s, job);
    if (job.kind === 'survey') {
      return [engelbartBlock(s), projectBlock(s.choices), period, `<source>${job.source}</source>`, `<app>${apps[0]}</app>`, skillsFor({ source: job.source, apps }, s.dataRoot), `<found>\n${JSON.stringify(found[apps[0]] || {}, null, 1)}\n</found>`, `Look at what they have in ${apps[0]} now, and report.`].filter(Boolean).join('\n\n');
    }
    if (job.kind === 'recall') {
      return [engelbartBlock(s), `<app>${apps[0]}</app>`, skillsFor({ source: job.source, apps }, s.dataRoot), `<prompt>\n${prompts.RECALL_PROMPT}\n</prompt>`, `Ask ${apps[0]} now, and save its answer with save_memory.`].join('\n\n');
    }
    return [
      engelbartBlock(s),
      projectBlock(s.choices),
      `<source>${JSON.stringify({ source: job.source, apps, label: job.label, foldersPicked: choice.folders || [], repositoriesPicked: choice.repos || [], foldersChosen: s.picked.folders, downloadsGoTo: s.downloads })}</source>`,
      period,
      `<plan>\n${job.plan}\n</plan>`,
      `<chat>\n${clipMiddle(conversationText(s), 30000)}\n</chat>`,
      `<found>\n${clipMiddle(JSON.stringify(found, null, 1), 40000)}\n</found>`,
      skillsFor({ source: job.source, apps }, s.dataRoot),
      s.choices.custom ? `<import_instructions note="What the person typed on the choose screen for this import.">\n${s.choices.custom}\n</import_instructions>` : '',
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      job.route === 'browser' && s.choices.browserAgents ? browserBlock(s, job, apps) : '',
      // The skills are written for Engelbart's own browser (round 3): in the person's, their reading steps apply, not its tools.
      job.route === 'browser' && s.choices.browserAgents ? '<note>The skills above name Engelbart\'s own browser tools (browser_*, import_google_files, gmail_*, web_chats). You do not have them: follow the same steps in your own tabs, read each item\'s text and bring it in with add_note. Gmail: at most 50 threads, only about the projects.</note>' : '',
      'Do the import now.',
    ].filter(Boolean).join('\n\n');
  }

  /**
   * A search for an app's folder the scan did not find where it usually is (MATH-117): what to look for, and how. Its reply
   * is a survey's, with "folder" (or "folders") and "searched".
   */
  function findMessage(s, job) {
    const app = job.apps[0];
    // MATH-110: the protected folders macOS did not let Engelbart read are kept out of the search, so it never asks
    // mid-run; ~/Pictures, ~/Music and ~/Movies too (their own prompts). `allowed` are the ones it may look in.
    const access = accessOf(s);
    const shown = (dir) => readers.shownPath(homeDir, dir);
    const allowed = access.allowed.map((folder) => `${folder.name} (${shown(folder.path)})`);
    const allowedTop = new Set(access.allowed.map((folder) => folder.id));
    const skipped = ['Desktop', 'Documents', 'Downloads', 'Library', 'Pictures', 'Music', 'Movies'].filter((name) => !allowedTop.has(name));
    const insideLibrary = access.allowed.filter((folder) => folder.id.startsWith(`Library${path.sep}`)).map((folder) => shown(folder.path));
    const tops = (() => { try { return fs.readdirSync(homeDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !skipped.includes(entry.name)).map((entry) => `~/${entry.name}`).sort().slice(0, 60); } catch { return []; } })();
    const lookIn = [...tops, ...insideLibrary];
    const usual = [fs.existsSync(path.join(homeDir, 'Dropbox')) ? '~/Dropbox' : '', ...allowed].filter(Boolean);
    const what = {
      Zoom: `Find their folder of Zoom recordings. Zoom keeps each meeting in a folder named by its date and topic ("2026-03-04 10.00.00 Lab meeting"), holding its transcript (a .vtt or .txt file), audio and video. People move that folder, or point Zoom's recording setting elsewhere${usual.length ? `: look under ${usual.join(', ')} first` : ''}. "folder" is the folder that holds the meeting folders. When there is none on this Mac, say so in "notes": the cloud recordings at zoom.us/recording are what an import agent reads instead.`,
      Obsidian: 'Find their Obsidian vault: a folder holding a .obsidian folder (Glob for **/.obsidian inside each folder you may look in, one at a time). When there are several, "folder" is the one they most likely work in: the most notes, changed most recently.',
      [LOCAL_PDFS]: 'Find the folders that hold their PDFs, papers mostly: use folder_overview and list_pdfs on the folders Glob finds them in. "folders" lists them, the most PDFs first, at most 6.',
    }[app] || `Find their ${shownName(app)} folder.`;
    const reply = app === LOCAL_PDFS ? '"folders": ["<absolute path>", ...] (empty when you found none)' : '"folder": "<absolute path, or null when you found none>"';
    return [
      engelbartBlock(s), projectBlock(s.choices), `<source>${job.source}</source>`, `<app>${app}</app>`,
      `Engelbart did not find ${app === LOCAL_PDFS ? 'any folder of PDFs' : `their ${shownName(app)} folder`} where it usually is. ${what}`,
      `Look with Glob, Grep and Read, inside their home folder (${homeDir}) only. Never look in ${skipped.map((name) => `~/${name}`).join(', ')}${insideLibrary.length ? ` (${insideLibrary.join(' and ')} aside)` : ''}: macOS has not let Engelbart read ${skipped.length > 1 ? 'them' : 'it'}, and looking there makes it stop the person with a prompt. Skip hidden folders too (a vault's .obsidian aside). Never Glob from the home folder itself (a pattern like ${homeDir}/**/x walks into the folders to skip): Glob inside each folder you may look in instead.`,
      `<folders_allowed note="Protected folders macOS let Engelbart read">${allowed.length ? allowed.join(', ') : 'none'}</folders_allowed>`,
      `<look_in note="The folders of their home folder you may look in">${lookIn.length ? lookIn.join(', ') : 'none'}</look_in>`,
      'Spend a few minutes at most. Never call needs_you to ask them for a folder: when you find nothing, say so, and they are offered a button to choose one.',
      `Reply with the survey's JSON object, with two more fields: ${reply}, and "searched": "<where you looked, in a few words>".`,
    ].filter(Boolean).join('\n\n');
  }

  function systemOf(s, kind) {
    if (kind === 'browse') return prompts.browseSystemPrompt(s.choice.provider, promptOf(s.dataRoot, 'connect-browse-system-prompt.md', prompts.BROWSE_SYSTEM_PROMPT));
    if (kind === 'survey') return prompts.SURVEY_SYSTEM_PROMPT;
    if (kind === 'recall') return prompts.RECALL_SYSTEM_PROMPT;
    if (kind === 'memory') return prompts.MEMORY_SYSTEM_PROMPT;
    if (kind === 'redact') return prompts.REDACT_SYSTEM_PROMPT;
    return promptOf(s.dataRoot, 'connect-import-system-prompt.md', prompts.IMPORT_SYSTEM_PROMPT);
  }

  async function runJob(s, job) {
    job.status = 'running';
    job.started = now();
    logAction(s, job, job.kind === 'memory' ? 'Writing MEMORY.md' : job.kind === 'redact' ? 'Taking any secrets out of MEMORY.md' : 'Started');
    emit(s);
    const controller = new AbortController();
    s.controllers.add(controller);
    job.controller = controller;
    const bridged = WORK.has(job.kind);
    // A browser agent's import (2026-10-13): in the person's own browser, through the Engelbart terminal, with the import
    // tools that bring things in from this Mac (what it downloaded or read) and never Engelbart's hidden browser.
    const browse = job.route === 'browser' && s.choices.browserAgents ? s.choices.browserAgents : null;
    const turnKind = browse ? 'browse' : job.kind;
    const covered = appsOfJob(s, job);
    const sites = [...new Set([...sitesOf(covered), ...((job.extra && Array.isArray(job.extra.sites)) ? job.extra.sites : [])])];
    // A recall may send one message, Engelbart's question, word for word (./browser.cjs sendOnly); no other job may send any.
    const page = bridged && !browse && browser && s.choices.permissions.browser && sites.length ? browser.tools({ id: job.id, label: job.label, sites, ...(job.kind === 'recall' ? { sendOnly: prompts.RECALL_PROMPT } : {}) }) : null;
    // Its tools (2026-10-15): no browser for a job of apps Engelbart reads with readers of its own (ChatGPT, Claude,
    // Overleaf), and the browser held to the sites of the apps it browses.
    const extraSites = (job.extra && Array.isArray(job.extra.sites)) ? job.extra.sites : [];
    // In the librarian's run an app whose items the person approves is read by id only (approvedFor), never browsed.
    const approvals = !s.choices.direct;
    const toolNames = bridged && !browse ? toolNamesFor(turnKind, { apps: covered, extraSites, page: !!page, approvals }) : null;
    const browseSites = browseSitesFor(turnKind, covered, extraSites, { approvals });
    const session = {
      dataRoot: s.dataRoot, homeDir, dir: s.dir, downloads: s.downloads, projectId: () => s.projectId,
      // what macOS let Engelbart read of its protected folders (MATH-110): the file tools keep out of the rest
      readable: (dir) => accessOf(s).readable(dir),
      // the apps the job covers and its source group, for what each row it brings in knows about itself (Library Phase B)
      apps: covered, group: job.source, browseSites,
      // what the person ticked for an app whose items they approve (approvePicked), in the librarian's run; null: anything
      approvedFor: (app) => (approvals && APPROVAL_APPS.has(app) ? (s.approved.get(app) || new Set()) : null),
      get exports() { return s.picked.exports; },
      get folders() { return s.picked.folders; },
      get days() { return s.choices.days || null; }, // the period picked (2026-10-10): the listing tools hold to it
      // The Gmail threads this session brought in (2026-10-11), held to import_gmail_threads' cap across its jobs.
      get gmailThreads() { return s.gmailThreads || 0; },
      set gmailThreads(n) { s.gmailThreads = Math.max(0, Number(n) || 0); save(s); },
    };
    const callTool = bridged ? createImportTools({
      session, context, zotero, github, deps, env, kind: turnKind, page, appleNotes, only: toolNames,
      needs: { ask: (request) => askPerson(s, job, request), wait: () => waitAgain(s, job) },
      recall: (app, text) => keepRecall(s, app, text),
      // the chat the memory question opened (2026-10-12), deleted by the tools once its answer is kept
      asked: (app, id) => { job.asked = { app, id }; }, question: prompts.RECALL_PROMPT,
      kept: (row) => keepRow(s, row),
      log: (text) => logAction(s, job, text),
      added: (kind, n, title) => { job[kind === 'notes' ? 'notes' : 'items'] += n; if (title && job.titles.length < 80) job.titles.push(String(title).slice(0, 120)); emit(s, { soon: true }); },
    }) : null;
    let bridge = null;
    let held = false; // failed as its provider not connected: queued again, the run waiting (holdForProvider)
    try {
      // `retry`: the model's service turned the turn away for a moment and it runs again (agents.cjs RETRY_WAITS_MS), kept
      // in the job's log so the Agent trace says why it took longer.
      const onUpdate = ({ activity, retry }) => {
        if (retry) logAction(s, job, `Trying again (${retry.attempt} of ${retry.of}): ${retry.reason}`);
        if (activity && activity !== job.activity) { job.activity = activity; emit(s, { soon: true }); }
      };
      if (browse) logAction(s, job, `In ${browse.browserName}, in a tab of its own`);
      const connectorsNow = bridged && !browse && connectors ? await (typeof connectors.serversForRun === 'function' ? connectors.serversForRun(covered, s.choice.provider) : connectors.serversFor(covered)).catch(() => []) : [];
      job.connectors = connectorsNow.map((server) => server.app); // what this turn can reach; a connector signed in later is not among them
      if (bridged) bridge = await openBridge(callTool, { signal: controller.signal, maxBody: 1_000_000 });
      const choice = job.kind === 'redact' ? s.redactChoice || s.choice : s.choice;
      const dirs = job.kind === 'memory' ? [s.dir, path.join(s.dataRoot, 'assets', 'md'), ...(s.projectDir ? [s.projectDir] : [])].filter((dir) => fs.existsSync(dir)) : job.kind === 'redact' ? [] : s.dirs;
      const message = job.kind === 'memory' ? await memoryMessage(s) : job.kind === 'redact' ? `<memory_md>\n${s.memoryDraft}\n</memory_md>` : jobMessage(s, job);
      const browseOptions = browse ? { steps: path.join(s.dir, 'steps', job.id), enable: browse.enable, browser: browse.browserName } : null;
      const out = await agents.turn({ choice, kind: turnKind, system: systemOf(s, turnKind), message, session: null, dirs, signal: controller.signal, bridge: bridge && bridge.connection, connectors: browse ? [] : connectorsNow, onUpdate, browse: browseOptions, toolNames, meta: { kind: turnKind, session: s, job, callTool } });
      if (job.kind === 'survey') await surveyed(s, job, out.text);
      else if (job.kind === 'memory') drafted(s, out.text);
      else if (job.kind === 'redact') await finishMemory(s, out.text);
      job.summary = job.kind === 'memory' || job.kind === 'redact' ? '' : line(job.kind === 'survey' ? (readSurvey(out.text).summary || out.text) : out.text, 500);
      job.status = 'done';
      logAction(s, job, job.kind === 'import' ? `Finished: ${job.summary}` : job.kind === 'survey' ? `${job.find ? 'Looked for it' : 'Looked'}: ${job.summary}` : job.kind === 'recall' ? (s.recalls[job.apps[0]] ? 'Kept what it remembers' : `Finished: ${job.summary}`) : 'Finished');
    } catch (error) {
      held = !s.stopped && needsProvider(error) && holdForProvider(s, job, (job.kind === 'redact' ? s.redactChoice || s.choice : s.choice).provider, error);
      if (held) return;
      job.status = error && error.kind === 'stopped' ? 'stopped' : 'failed';
      job.error = job.status === 'failed' ? line(error && error.message ? error.message : 'The import failed', 300) : '';
      logAction(s, job, job.status === 'stopped' ? 'Stopped' : `Failed: ${job.error}`);
      if (job.kind === 'survey') await surveyed(s, job, null, job.error || 'stopped');
      if (job.kind === 'memory' || job.kind === 'redact') { s.memory = { ...s.memory, status: job.status === 'stopped' ? 'stopped' : 'failed', error: job.error }; }
    } finally {
      s.controllers.delete(controller);
      job.controller = null;
      if (bridge) await bridge.close().catch(() => {});
      if (browser) browser.close(job.id);
      releaseNeeds(s, job);
      job.activity = '';
      job.ended = held ? null : now();
      if (!held) rerunJob(s, job);
      emit(s);
      pump(s);
      maybeMemory(s);
    }
  }

  /**
   * An import whose app's connector was signed in while its agent ran (2026-10-14): the agent's tools were fixed when its
   * turn started, so the connection never reached it and nothing came in. Once it ends, the import runs once more, with
   * the connection.
   */
  function rerunJob(s, job) {
    if (!job.rerun || job.kind !== 'import' || s.stopped || job.status === 'stopped') return;
    job.rerun = false;
    if (job.apps.some((app) => s.skipped.has(app))) return;
    const next = dispatch(s, { kind: 'import', source: job.source, apps: job.apps, label: job.label, plan: job.plan, extra: job.extra, route: job.route || null, again: true });
    if (next) logAction(s, next, `Again, now that ${job.apps.map(shownName).join(', ')} ${job.apps.length === 1 ? 'is' : 'are'} connected`);
  }

  /**
   * A job failed as one its provider's CLI needs the person for (./provider-failure.cjs: not installed, not signed in, its
   * account refused). 2026-10-14, a beta tester: every job failed the same way one after another, "Failed: Not logged in",
   * and nothing said what to do. Now the job is queued again and the run waits (`blocked`, which pump honours) until the
   * person connects that provider or picks the other (unblock, from the workspace's Connect popup). Only an Import your
   * context run waits: the librarian's chat has its own error line. → whether it was held.
   */
  function holdForProvider(s, job, provider, error) {
    if (!s.choices.direct || !PROVIDERS.includes(provider)) return false;
    job.status = 'queued';
    job.error = '';
    job.started = null;
    if (!s.blocked) {
      s.blocked = { provider, error: line(error && error.message ? error.message : error, 200), at: now() };
      logAction(s, null, `Waiting for ${PROVIDER_NAMES[provider]}: ${s.blocked.error}`);
      if (providerCheck) void Promise.resolve().then(() => providerCheck(provider)).catch(() => {});
    } else logAction(s, job, `Waiting for ${PROVIDER_NAMES[provider]}`);
    return true;
  }

  /**
   * The run's provider connected (or `provider`, the other one, picked instead): what waited runs now. Throws while the
   * provider still can't run (the window keeps its popup). → snapshot
   */
  function unblock(id, provider = null) {
    const s = get(id);
    if (!s.blocked) return snapshot(s);
    const want = PROVIDERS.includes(provider) ? provider : s.blocked.provider;
    if (!readyNow().includes(want)) throw new Error(`${PROVIDER_NAMES[want]} is not connected yet`);
    if (want !== s.choice.provider) {
      s.choice = choiceFor(want);
      logAction(s, null, `Switched to ${PROVIDER_NAMES[want]} (${s.choice.modelName} · ${s.choice.effort})`, 'You');
    }
    if (s.redactChoice && s.redactChoice.provider !== want) s.redactChoice = null;
    s.blocked = null;
    logAction(s, null, `${PROVIDER_NAMES[want]} connected: going on`);
    emit(s);
    pump(s);
    maybeMemory(s);
    return snapshot(s);
  }

  /* ------------------------------------------------------------------------------------------------------- surveys */

  /** A survey's report goes into what was found, for the librarian; it is woken if it said it was waiting. */
  async function surveyed(s, job, text, error = '') {
    if (job.find) return lookedFor(s, job, text, error);
    const app = job.apps[0];
    const report = text != null ? readSurvey(text) : { error: error || 'The survey did not finish' };
    s.found[job.source] = { ...(s.found[job.source] || {}), [app]: { ...((s.found[job.source] || {})[app] || {}), survey: report } };
    s.newFound = { ...(s.newFound || {}), [job.source]: { ...((s.newFound || {})[job.source] || {}), [app]: s.found[job.source][app] } };
    s.surveyNews.push(app);
    if (s.waitingForSurvey && !s.thinking) wake(s);
  }

  /**
   * The search for an app's folder ended (MATH-117). A folder found is the app's, as if the person had chosen it: the scan
   * reads it again, so the librarian gets its at-a-glance. None found: the app needs its folder, with where the agent
   * looked, and the librarian offers the button. A search stopped by Engelbart quitting runs again when it resumes.
   */
  async function lookedFor(s, job, text, error) {
    const app = job.apps[0], source = job.source;
    if (text == null && (s.suspended || s.stopped)) return;
    const report = text != null ? readSurvey(text, homeDir) : { folders: [], searched: null, notes: null, error: error || 'The search did not finish' };
    // A folder inside a protected one macOS did not let Engelbart read is not taken (MATH-110).
    const access = accessOf(s);
    report.folders = report.folders.filter((dir) => access.readable(dir));
    const reach = appOf(app) ? appOf(app).reach : 'local';
    const put = (entry) => {
      s.found[source] = { ...(s.found[source] || {}), [app]: entry };
      s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: entry } };
    };
    const missing = () => put({ reach, needs: 'folder', searched: report.searched || report.notes || (report.error ? `the search failed: ${report.error}` : 'their home folder'), ...(app === 'Zoom' ? { cloud: 'Cloud recordings can be read at zoom.us in Engelbart\'s browser.' } : {}) });
    const [folder, ...more] = report.folders;
    if (folder) {
      s.picked.folders[app] = folder;
      const choice = s.choices.sources[source];
      if (app === LOCAL_PDFS && choice && more.length) choice.folders = [...new Set([...(choice.folders || []), ...more])].slice(0, 12);
      logAction(s, job, `Found your ${folderName(app)} at ${[folder, ...more].slice(0, 3).map((one) => readers.shownPath(homeDir, one)).join(', ')}`);
      put({ reach }); // no survey: the scan's at-a-glance takes its place
      try { await rescan(s, [source]); } catch { missing(); }
    } else missing();
    s.dirs = dirsOf(s);
    s.surveyNews.push(app);
    save(s);
    if (s.waitingForSurvey && !s.thinking) wake(s);
  }

  /**
   * An app on this Mac whose folder the scan did not find, looked for by an agent before the person is asked to choose it
   * (MATH-117): only when they let the agents read the files on this Mac, once a session for each app.
   */
  function lookForFolders(s) {
    if (!s.choices.computer || s.stopped || s.suspended || s.finished) return;
    for (const [source, apps] of Object.entries(s.found || {})) {
      const choice = s.choices.sources[source];
      if (!choice || !choice.on || !apps || typeof apps !== 'object') continue;
      for (const [app, value] of Object.entries(apps)) {
        if (!value || value.needs !== 'folder' || !FIND_APPS.has(app) || !choice.apps.includes(app) || s.skipped.has(app) || s.picked.folders[app]) continue;
        if (s.jobs.some((job) => job.find && job.apps.includes(app))) continue; // looked for once already
        const entry = { reach: value.reach || 'local', survey: 'running', looking: 'for its folder' };
        s.found[source] = { ...s.found[source], [app]: entry };
        const job = dispatch(s, { kind: 'survey', find: true, source, apps: [app], label: `Looking for your ${folderName(app)}` });
        if (!job) { s.found[source] = { ...s.found[source], [app]: value }; continue; }
        s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: entry } };
      }
    }
  }

  /**
   * The surveys and recalls a session starts with: every web or connector app it may reach, every assistant it may ask.
   * An app in `held` is still signed out or refused (signInsFirst): its survey and recall are held, then left out (releaseHeld).
   */
  function startWork(s, held = new Set(), only = null) {
    for (const [source, choice] of Object.entries(s.choices.sources)) {
      if (!choice.on) continue;
      for (const app of choice.apps) {
        if (only && !only.includes(app)) continue;
        if (!mayReach(s, app)) continue; // not allowed yet (askGrant)
        const reach = appOf(app) ? appOf(app).reach : null;
        if (reach === 'web') {
          if (!s.choices.permissions.browser) { s.found[source] = { ...(s.found[source] || {}), [app]: { reach, left: 'They did not let the agents use their accounts, so this app is left out.' } }; continue; }
          if (held.has(app)) {
            s.held.set(app, { source, recall: false });
            s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running', signIn: 'waiting: not signed in yet' } };
            continue;
          }
          s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running' } };
          dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` });
        } else if (reach === 'connector') {
          const connected = connectorConnected(app);
          if (!connected && connectorFallback(s, app)) {
            s.found[source] = { ...(s.found[source] || {}), [app]: { reach, fallback: 'Its connector does not serve this account: it is read through its website instead, by its own import. Do not offer or dispatch it.' } };
          } else if (connected) {
            s.found[source] = { ...(s.found[source] || {}), [app]: { reach, survey: 'running' } };
            dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` });
          } else if (connectors) {
            // Allowed but not connected (2026-10-16: Notion and Granola were allowed at 09:58 and nothing started: this
            // set needs 'connector' and did nothing else, so no card came and the librarian never heard): its Connect step
            // now, held; connected, its survey starts (releaseHeld), and the librarian is told it waits on the person.
            const entry = { reach, connector: 'Engelbart asked the person to connect it, on a card of its own. Do not offer it or ask about it: its survey reports once they have connected it.' };
            s.found[source] = { ...(s.found[source] || {}), [app]: entry };
            s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: entry } };
            s.held.set(app, { source, recall: false });
            signInCard(s, app, 'connector');
          } else s.found[source] = { ...(s.found[source] || {}), [app]: { reach, needs: 'connector' } };
        }
      }
    }
    if (s.choices.permissions.recall && s.choices.permissions.browser) {
      for (const app of recallApps((s.choices.sources.chats || {}).on ? s.choices.sources.chats.apps : [])) {
        if ((only && !only.includes(app)) || !mayReach(s, app)) continue;
        if (s.held.has(app)) s.held.get(app).recall = true;
        else dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${shownName(app)} what it remembers` });
      }
    }
  }

  /** A held app's sign-in settled: done starts its survey and recall; skip leaves it out, and the librarian hears. */
  function releaseHeld(s, app, how) {
    const held = s.held.get(app);
    if (!held) return;
    s.held.delete(app);
    const { [app]: was = {}, ...rest } = s.found[held.source] || {};
    const { signIn: _signIn, ...entry } = was;
    if (how === 'skip' || s.stopped) {
      const left = { reach: entry.reach || 'web', skipped: 'The person skipped this app for this run: leave it out, and do not offer, ask about or hand it over again.' };
      s.found[held.source] = { ...rest, [app]: left };
      s.newFound = { ...(s.newFound || {}), [held.source]: { ...((s.newFound || {})[held.source] || {}), [app]: left } };
      s.surveyNews.push(app);
      if (s.waitingForSurvey && !s.thinking) wake(s);
      return;
    }
    if (s.choices.direct) {
      s.found[held.source] = { ...rest, [app]: { ...entry } };
      directImport(s, app);
      if (held.recall) dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${shownName(app)} what it remembers` });
      return;
    }
    s.found[held.source] = { ...rest, [app]: { ...entry, survey: s.finished ? 'not run: Import was pressed first' : 'running' } };
    if (!s.finished) dispatch(s, { kind: 'survey', source: held.source, apps: [app], label: `Looking through ${shownName(app)}` });
    if (held.recall) dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${shownName(app)} what it remembers` });
  }

  /**
   * A sign-in check's answer (webSignIn.signInQuiet) as the choose screen shows it → { status, browser, browserId, profile?,
   * unchecked? }: `profile` the browser profile it came from when that browser has several, `unchecked` when the site's
   * check page gave no answer (counted as signed in, 2026-10-12).
   */
  function checkedAs(app, result) {
    const was = signInChecked.get(app);
    if (result && result.signedIn) {
      const kept = !result.browser && was && was.status === 'signed-in' ? was : null;
      const profile = result.browser ? result.profile || '' : (kept && kept.profile) || '';
      return { status: 'signed-in', browser: result.browser || (kept ? kept.browser : ''), browserId: '', ...(profile ? { profile } : {}), ...(result.unchecked ? { unchecked: true } : {}) };
    }
    if (result && result.refused) return { status: 'refused', browser: result.refused, browserId: result.refusedId || '' };
    if (result && result.noBrowser) return { status: 'no-browser', browser: '', browserId: '' };
    if (result && result.held) return { status: 'held-elsewhere', browser: (webSignIn && webSignIn.browserName ? webSignIn.browserName() : '') || '', browserId: '' };
    return { status: 'signed-out', browser: '', browserId: '' };
  }

  /**
   * What to tell the person before a ticked web app's check asks macOS for a browser's sign-ins → { browser, note }; note ''
   * when macOS will not be asked (held already, no browser holding it, Firefox, asked once already, or a browser it
   * refused). Only a browser holding the app's sign-in is named (2026-10-11): the check opens no sign-in page, so where one
   * would open (the Log in card's note, noteFor) is never promised here.
   */
  async function signInNote(app, { route = '' } = {}) {
    if (!webSignIn || !webSignIn.supports(app) || !webSignIn.keychainTarget) return { browser: '', note: '', profiles: [], opens: '' };
    // Google's Sign in (2026-10-12) opens its page in the person's browser: the browser it opens in is the one named.
    const browserRoute = route === 'browser';
    const opens = browserRoute && webSignIn.opensIn ? webSignIn.opensIn(app) : '';
    if (!browserRoute && await webSignIn.signedIn(app).catch(() => false)) return { browser: '', note: '', profiles: [], opens };
    const profiles = profilesToAsk(app);
    let target = null;
    try { target = webSignIn.keychainTarget(app, { holdersOnly: !browserRoute }); } catch { target = null; }
    const browser = target ? target.name : profiles.length ? profiles[0].browser : '';
    if (!target || signInDenied.has(target.id)) return { browser, note: '', profiles, opens };
    return { browser: target.name, note: webSignIn.keychainNote(app, { holdersOnly: !browserRoute }) || '', profiles, opens };
  }

  /**
   * The profiles to ask the person to pick from for an app's sign-in (2026-10-12) → [{ browserId, browser, profileId, name,
   * email, keychain }]: every one holding it, when more than one does and none was picked before (or the one picked no
   * longer holds it); else none, and no question.
   */
  function profilesToAsk(app) {
    if (!webSignIn || !webSignIn.holdersOf) return [];
    let list = [];
    try { list = webSignIn.holdersOf(app) || []; } catch { list = []; }
    list = list.filter((profile) => !signInDenied.has(profile.browserId));
    if (list.length < 2) return [];
    const pick = webSignIn.picked ? webSignIn.picked(app) : null;
    if (pick && list.some((profile) => profile.browserId === pick.browser && profile.profileId === pick.profile)) return [];
    return list;
  }

  /** The profile picked for an app's sign-in ({ browser, profile }, ids), remembered for every app sharing it. */
  function signInPick(app, pick) {
    if (!webSignIn || !webSignIn.choose || !webSignIn.supports(app)) return false;
    return webSignIn.choose(app, pick);
  }

  /**
   * A web app ticked on the choose screen: its sign-in brought over from a browser holding it, however long macOS's prompt
   * waits for the person (2026-10-10: they were told it would ask). → { status: 'signed-in'|'refused'|'signed-out'|
   * 'no-browser', browser } (status '' for an app whose sign-in can't be checked), kept for the run's signInsFirst. `retry` (Try again) asks macOS again about the browser that
   * refused it. Off the Mac (2026-10-12), nothing is copied: whether Engelbart's own session holds the sign-in, signed in or
   * signed out.
   */
  function signInCheck(app, { retry = false } = {}) {
    if (!webSignIn || !signsInAtAll(app)) return Promise.resolve({ status: '', browser: '' }); // not one it can check
    if (signInChecking.has(app)) return signInChecking.get(app);
    if (retry) { const was = signInChecked.get(app); if (was && was.browserId) signInDenied.delete(was.browserId); }
    const checking = webSignIn.signInQuiet(app, { denied: signInDenied }).catch(() => ({ signedIn: false, browser: '' })).then((result) => {
      const out = checkedAs(app, result);
      signInChecked.set(app, out);
      signInChecking.delete(app);
      return { status: out.status, browser: out.browser, ...(out.profile ? { profile: out.profile } : {}) };
    });
    signInChecking.set(app, checking);
    return checking;
  }

  /**
   * "Sign in" on the choose screen (2026-10-11): the app's sign-in page in Engelbart's own browser (./signin-window.cjs), for
   * an app no browser of the person's could sign in, one whose browser sign-ins they turned down, and every app off the Mac
   * (2026-10-12). → { status: 'signed-in' | 'rejected' | 'closed' }. Signed in, it is kept as signed in for every app sharing
   * that sign-in (Google Drive, Gmail, Google Meet and Gemini are one), so the run counts them all, and never copied over
   * from a browser again this run; a wait for it in the person's browser ends. 'rejected': Google turned it away (the window
   * cleared what Google left, so Try again can work).
   */
  async function signInWindowOpen(app) {
    if (!signInWindow || !webSignIn || !signsInAtAll(app)) return { status: 'closed' };
    const out = await signInWindow.open(app).catch(() => ({ status: 'closed' }));
    if (out && out.status === 'signed-in') {
      if (typeof webSignIn.signedInHere === 'function') webSignIn.signedInHere(app);
      for (const other of sharesSignIn(app)) signInChecked.set(other, { status: 'signed-in', browser: '', browserId: '' });
      signInBrowserCancel(app);
      return { status: 'signed-in' };
    }
    if (out && out.status === 'rejected') return { status: 'rejected' };
    return { status: 'closed' };
  }

  /** Whether `app`'s sign-in can be made at all: in Engelbart's window, wherever it runs (webSignIn.canSignIn). */
  function signsInAtAll(app) {
    if (!webSignIn) return false;
    return typeof webSignIn.canSignIn === 'function' ? webSignIn.canSignIn(app) : webSignIn.supports(app);
  }

  // Google's Sign in on the choose screen, waited for in the person's browser (2026-10-12): one wait per sign-in (every
  // Google app shares it), with the controller that ends it.
  const browserWaits = new Map();

  /**
   * "Sign in" for an app whose sign-in goes through the person's browser (signsInThroughBrowser: Google's, which refuses
   * Engelbart's window, 2026-10-12): its sign-in page opened in their default browser (Chrome when that is Safari), then
   * waited for with no time limit until it comes over, or until signInBrowserCancel (the row unticked, Leave out, the choose
   * screen gone). → { status: 'signed-in', browser, profile? } | { status: 'refused', browser } | { status: 'no-browser' } |
   * { status: 'cancelled' }. Signed in, every app sharing the sign-in is kept as signed in. "Sign in here instead" ends it
   * (signInBrowserCancel) for Engelbart's window (signInWindowOpen).
   */
  function signInBrowser(app) {
    if (!webSignIn || !webSignIn.supports(app)) return Promise.resolve({ status: 'no-browser' });
    const key = signInGroup(app);
    if (browserWaits.has(key)) return browserWaits.get(key).done;
    const controller = new AbortController();
    const done = webSignIn.signIn(app, { signal: controller.signal, timeoutMs: Infinity, denied: signInDenied }).catch(() => ({ status: 'cancelled' })).then((out) => {
      browserWaits.delete(key);
      if (out.status === 'signed-in') {
        const kept = { status: 'signed-in', browser: out.browser || '', browserId: '', ...(out.profile ? { profile: out.profile } : {}) };
        for (const other of sharesSignIn(app)) signInChecked.set(other, kept);
        return { status: 'signed-in', browser: kept.browser, ...(out.profile ? { profile: out.profile } : {}) };
      }
      if (out.status === 'denied') {
        if (out.browserId) signInDenied.add(out.browserId);
        for (const other of sharesSignIn(app)) signInChecked.set(other, { status: 'refused', browser: out.browser, browserId: out.browserId || '' });
        return { status: 'refused', browser: out.browser };
      }
      if (out.status === 'no-browser') return { status: 'no-browser' };
      return { status: 'cancelled' };
    });
    browserWaits.set(key, { controller, done });
    return done;
  }

  /**
   * Continue on the Keychain panel for a sign-in through the person's browser (2026-10-12): macOS asked for that browser's
   * sign-ins now, before its page opens, copying nothing (webSignIn.unlock; the key is kept for the run, so the copy when
   * the sign-in shows up asks nothing). → { status: 'allowed', browser } | { status: 'refused', browser }: refused, every
   * app sharing the sign-in is refused (Try again asks again), and nothing is opened.
   */
  async function signInUnlock(app) {
    if (!webSignIn || !webSignIn.supports(app) || typeof webSignIn.unlock !== 'function') return { status: 'allowed', browser: '' };
    const out = await webSignIn.unlock(app, { denied: signInDenied }).catch(() => ({ status: 'allowed', browser: '' }));
    if (out.status === 'denied') {
      if (out.browserId) signInDenied.add(out.browserId);
      for (const other of sharesSignIn(app)) signInChecked.set(other, { status: 'refused', browser: out.browser, browserId: out.browserId || '' });
      return { status: 'refused', browser: out.browser };
    }
    return { status: 'allowed', browser: out.browser || '' };
  }

  /** "Use another account" on a Google row waiting on the browser: Google's add-an-account page there; the wait goes on. */
  async function signInAnotherAccount(app) {
    if (!webSignIn || typeof webSignIn.anotherAccount !== 'function' || !browserWaits.has(signInGroup(app))) return { opened: false, browser: '' };
    return webSignIn.anotherAccount(app).catch(() => ({ opened: false, browser: '' }));
  }

  /** Ends the wait for `app`'s sign-in in the person's browser (any app sharing it), or every wait when `app` is ''. */
  function signInBrowserCancel(app = '') {
    for (const [key, wait] of browserWaits) if (!app || key === signInGroup(app)) wait.controller.abort();
    return true;
  }

  /** Closes the sign-in window, if one is open (Leave out, or the choose screen gone). */
  function signInWindowClose() {
    if (signInWindow) signInWindow.close();
    return true;
  }

  /**
   * The ticked web apps' sign-ins, looked at before any survey starts (2026-10-09). One checked when it was ticked keeps
   * that answer (a check still waiting on macOS is waited for); any other is brought over from a browser that holds it, all
   * together, at most SIGN_IN_CHECK_MS. One with no answer by then is still checking (2026-10-12), not signed out: its
   * answer, when it comes, is lateSignIn's. A browser macOS refused is not asked again.
   * → { signedOut: Set, refused: Map(app → browser), signedIn: Map(app → browser, '' when held already),
   *     checking: Map(app → Promise of its answer) }
   */
  async function signInsFirst(s, only = null) {
    const out = { signedOut: new Set(), refused: new Map(), signedIn: new Map(), checking: new Map(), elsewhere: new Map() };
    if (!webSignIn || !s.choices.permissions.browser) return out;
    // Every web app; in the librarian's run only those the person allowed (askGrant): no sign-in of theirs is looked at
    // before. Not a connector app (Notion) any more (2026-10-15): it is read only through its own tools, never a browser,
    // so a copied sign-in sent it to an agent in their browser that could do nothing; its Connect step reaches it.
    const apps = Object.values(s.choices.sources).filter((choice) => choice.on).flatMap((choice) => choice.apps)
      .filter((app) => (!only || only.includes(app)) && mayReach(s, app))
      .filter((app) => appOf(app) && appOf(app).reach === 'web' && signsInAtAll(app));
    if (!apps.length) return out;
    const results = new Map();
    const waiting = [];
    const quiet = [];
    // Their browser's sign-ins declined (Import your context's keychain question): only what Engelbart's browser holds counts.
    if (s.choices.keychain === false) {
      for (const app of apps) {
        const here = await Promise.resolve().then(() => webSignIn.signedIn(app)).catch(() => false);
        if (here) { out.signedIn.set(app, ''); logAction(s, null, `Signed in to ${shownName(app)} already`); } else out.signedOut.add(app);
      }
      return out;
    }
    for (const app of apps) {
      const known = signInChecked.get(app);
      if (signInChecking.has(app)) waiting.push(signInChecking.get(app).then(() => { results.set(app, signInChecked.get(app)); }));
      else if (known && known.status !== 'no-browser') results.set(app, known);
      else quiet.push(app);
    }
    let timer = null;
    const limit = new Promise((resolve) => { timer = setTimeout(resolve, deps.signInCheckMs || SIGN_IN_CHECK_MS); if (timer.unref) timer.unref(); });
    const answers = new Map(quiet.map((app) => [app, webSignIn.signInQuiet(app, { denied: signInDenied }).catch(() => ({ signedIn: false })).then((result) => {
      const answer = checkedAs(app, result);
      results.set(app, answer);
      return answer;
    })]));
    await Promise.all([
      Promise.all(waiting),
      quiet.length ? Promise.race([Promise.all(answers.values()), limit]) : null,
    ]);
    clearTimeout(timer);
    for (const app of apps) {
      const result = results.get(app);
      if (!result && answers.has(app)) { out.checking.set(app, answers.get(app)); continue; }
      if (result && result.status === 'signed-in') {
        out.signedIn.set(app, result.browser);
        logAction(s, null, result.browser ? `Signed in to ${shownName(app)} from ${result.browser}` : `Signed in to ${shownName(app)} already`);
        if (result.unchecked) logAction(s, null, `Couldn't check the ${shownName(app)} sign-in (no answer): counted as signed in`);
      } else if (result && result.status === 'refused') out.refused.set(app, result.browser);
      else if (result && result.status === 'held-elsewhere') out.elsewhere.set(app, result.browser);
      else out.signedOut.add(app);
    }
    return out;
  }

  /**
   * A sign-in still being checked when the surveys started (signInsFirst's `checking`, 2026-10-12): its app is held, and
   * joins the run when the answer is signed in; signed out, it is left out quietly with a line in the chat (no Log in card,
   * 2026-10-12); refused by macOS, it is skipped as at the start.
   */
  function lateSignIn(s, app, answer) {
    logAction(s, null, `Still checking the ${shownName(app)} sign-in`);
    answer.then((result) => {
      if (s.stopped || !s.held.has(app)) return;
      if (result && result.status === 'signed-in') {
        logAction(s, null, result.browser ? `Signed in to ${shownName(app)} from ${result.browser}` : `Signed in to ${shownName(app)}`);
        if (result.unchecked) logAction(s, null, `Couldn't check the ${shownName(app)} sign-in (no answer): counted as signed in`);
        releaseHeld(s, app, 'done');
        emit(s);
        return;
      }
      if (result && result.status === 'refused') {
        leaveOut(s, app, `macOS didn't allow ${result.browser || 'your browser'}'s sign-ins`);
        skipApp(s, app);
        releaseHeld(s, app, 'skip');
        notice(s, skippedLine(result.browser, [app]));
        emit(s);
        return;
      }
      if (result && result.status === 'held-elsewhere') { heldElsewhere(s, app, result.browser); emit(s); return; }
      // Signed out: brought back (recover), quietly first; its survey or import starts once it is signed in.
      recoverHeld(s, app);
      emit(s);
    });
  }

  /** "ChatGPT", "ChatGPT and Claude", "ChatGPT, Claude and Gemini". */
  const listed = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

  /** The apps grouped by the browser named for each, '' left out → [[browser, apps]]. */
  function byBrowser(map) {
    const out = new Map();
    for (const [app, name] of map) if (name) out.set(name, [...(out.get(name) || []), app]);
    return [...out];
  }

  /** "Skipped ChatGPT and Claude: macOS didn't allow Chrome's sign-ins. You can add them later from Add sources." */
  const skippedLine = (name, apps) => `Skipped ${listed(apps.map(shownName))}: macOS didn't allow ${name || 'your browser'}'s sign-ins. You can add ${apps.length === 1 ? 'it' : 'them'} later from Add sources.`;

  /** "Left out Google Drive: not signed in. You can add it from Add sources." */
  const leftOutLine = (apps) => `Left out ${listed(apps.map(shownName))}: not signed in. You can add ${apps.length === 1 ? 'it' : 'them'} from Add sources.`;

  /** What the opener says of the sign-ins brought over and the apps macOS refused, in plain lines, or ''. */
  function signInLines({ signedIn, refused }) {
    const lines = byBrowser(signedIn).map(([name, apps]) => `Using your ${name} sign-ins for ${listed(apps.map(shownName))}.`);
    const skipped = new Map();
    for (const [app, name] of refused) skipped.set(name || '', [...(skipped.get(name || '') || []), app]);
    for (const [name, apps] of skipped) lines.push(skippedLine(name, apps));
    return lines.join('\n');
  }

  /** The line under a sign-in card before macOS is first asked for a browser's sign-ins this run, or ''. */
  function noteFor(app, kind) {
    if (!(kind === 'signin' || kind === 'password') || !webSignIn || !webSignIn.supports(app) || !webSignIn.keychainNote) return '';
    try { return webSignIn.keychainNote(app) || ''; } catch { return ''; }
  }

  /* ------------------------------------------------------------------------------------------------------ needs you */

  /**
   * The app a need is for: the job's first, unless that isn't a web app and the reason names the site of a web app among
   * the job's (2026-10-12: a job filed under "Codex, Claude, Claude Code" asked to sign in to "Claude (claude.ai)", was
   * taken as Codex's and so never reached signInAgain).
   */
  function needApp(job, reason) {
    // One of the Other tools (2026-10-16: every one asked "Couldn't open Other tools: Linear"): its own name, never the
    // job's label.
    if (!job.apps.length && job.extra && job.extra.tool && job.extra.tool.name) return job.extra.tool.name;
    const first = job.apps[0] || job.label;
    const web = (app) => !!(appOf(app) && appOf(app).reach === 'web');
    if (web(first)) return first;
    const said = String(reason || '').toLowerCase();
    const edge = (ch) => !/[a-z0-9-]/.test(ch || '');
    const names = (site) => { const want = site.toLowerCase(); for (let at = said.indexOf(want); at >= 0; at = said.indexOf(want, at + 1)) if (edge(said[at - 1]) && edge(said[at + want.length])) return true; return false; };
    const site = job.apps.find((app) => web(app) && (appOf(app).sites || []).some(names));
    if (site) return site;
    // The reason names another app outright (2026-10-14: the Folders on this Mac job asked "Sign in to GitHub", and the
    // popup said "Sign in to Folders on this Mac" and offered Chrome): that app, when the job's own isn't named.
    if (!names(shownName(first))) {
      const named = ['GitHub', 'Zotero', ...Object.keys(APPS)].filter((app) => app !== first && names(shownName(app))).sort((a, b) => shownName(b).length - shownName(a).length)[0];
      if (named) return named;
    }
    return first;
  }

  /* Engelbart's own sign-ins (Zotero, GitHub) and the connectors (Granola, Notion's MCP server): Engelbart can tell for
     itself when one is made, wherever it was made, so their steps close by themselves (watchStep) and never ask the person
     to say they are done. 2026-10-14, the beta's Zotero report: "she authenticated … but then she still saw the sign into
     chrome thing": the step had closed, the import agent read the library before its first sync had landed, was told
     "has not finished its first sync", and asked again with kind "confirm", whose popup fell through to "Sign in to
     Zotero · Continue in Chrome · Open Chrome". */
  const ownDep = (app) => (app === 'Zotero' ? zotero : app === 'GitHub' ? github : null);
  /** Zotero's or GitHub's sign-in status ({ connected, pending, error }), {} when it can't be read. */
  function ownStatus(app) {
    const dep = ownDep(app);
    try { return (dep && typeof dep.status === 'function' && dep.status()) || {}; } catch { return {}; }
  }
  const isConnectorApp = (app) => !!(appOf(app) && appOf(app).reach === 'connector');
  function connectorConnected(app) {
    try { return !!(connectors && isConnectorApp(app) && connectors.status(app).connected); } catch { return false; }
  }
  /** Each connector app of `apps` asked for its state (connectors.check: its server, at most every few minutes), quietly. */
  async function checkConnectors(apps) {
    if (!connectors || typeof connectors.check !== 'function') return;
    await Promise.all(apps.filter(isConnectorApp).map((app) => Promise.resolve().then(() => connectors.check(app)).catch(() => null)));
  }

  /**
   * A connector whose server can't serve this account (2026-10-16: Evernote's MCP is in beta, rolling out): its website
   * instead, as one of the Other tools are read (toolJob: the sign-in copied from the chosen browser, recover when it
   * fails); one with no website to fall back on is skipped with a quiet line. → whether it was handled so.
   */
  function connectorFallback(s, app) {
    let status = null;
    try { status = connectors ? connectors.status(app) : null; } catch { status = null; }
    if (!status || status.state !== 'unavailable') return false;
    if (fallbackOf(app) !== 'web' || !appOf(app).sites) {
      leaveOut(s, app, 'its connector doesn’t serve your account');
      skipApp(s, app);
      notice(s, `Couldn't connect to ${shownName(app)}. Skipped.`);
      return true;
    }
    const site = { name: shownName(app), website: appOf(app).start || '', sites: appOf(app).sites };
    const projects = s.choices.direct ? s.choices.direct.projects : [];
    logAction(s, null, `${shownName(app)} through its website: its connector doesn't serve your account`);
    void toolJob(s, site, { plan: (how) => `${s.choices.direct ? `${importFlow.importPlan({ app: importFlow.SITES, mode: s.choices.direct.mode, projects, roles: s.choices.direct.roles, work: s.choices.direct.work, period: periodName(s.choices.days) })}\n\n` : ''}This is ${shownName(app)}, read through its website because its connector doesn't serve their account. ${how}, and bring in its notes about ${s.choices.direct ? 'these projects' : 'the project in <project>'} as notes (add_note).` }).then((job) => dispatch(s, job)).catch(() => {});
    return true;
  }

  /** Whether a step's sign-in is made: Zotero's or GitHub's account connected, or a connector signed in. */
  function stepSignedIn(need) {
    if (SIGNIN_APPS.has(need.app)) return !!ownStatus(need.app).connected;
    if (need.kind === 'connector') return connectorConnected(need.app);
    return false;
  }
  /**
   * While a step Engelbart can check is open, its sign-in is looked at every STEP_POLL_MS: made (in the popup's browser, in
   * Settings, in another window), the step closes as done, which starts the import held on it or lets its agent go on.
   * Zotero's or GitHub's sign-in that ended without an account is said on the popup, which offers Sign in again.
   */
  function watchStep(s, need) {
    if (need.watch || need.closed || need.own) return;
    if (!SIGNIN_APPS.has(need.app) && !(need.kind === 'connector' && isConnectorApp(need.app))) return;
    const tick = () => {
      if (need.closed || s.stopped || s.suspended) { clearInterval(need.watch); need.watch = null; return; }
      if (stepSignedIn(need)) {
        clearInterval(need.watch);
        need.watch = null;
        need.busy = false;
        logAction(s, null, `Signed in to ${shownName(need.app)}`, 'You');
        closeNeed(s, need, 'done');
        return;
      }
      if (!SIGNIN_APPS.has(need.app) || !need.opened) return;
      const now = ownStatus(need.app);
      if (now.pending && now.pending.userCode && need.code !== now.pending.userCode) { need.code = now.pending.userCode; emit(s); }
      if (!now.pending && now.error && now.error !== need.error) { need.opened = false; need.code = ''; need.error = line(now.error, 200); emit(s); }
    };
    need.watch = setInterval(tick, deps.stepPollMs || STEP_POLL_MS);
    if (need.watch.unref) need.watch.unref();
  }

  /** Why an app comes in with nothing, kept for the status's completion (the first reason given holds). */
  function leaveOut(s, app, why) {
    if (!app || s.stopped) return;
    if (!s.leftOut) s.leftOut = new Map();
    if (!s.leftOut.has(app)) s.leftOut.set(app, String(why || 'left out'));
  }
  /** What the person's Later (or Don't allow) on a step means, in words. */
  function laterWhy(need) {
    if (need.kind === 'permission') return 'you didn’t allow Engelbart to read it';
    if (need.kind === 'consent') return 'you didn’t allow Engelbart to search and read it';
    if (need.kind === 'connector') return 'you skipped connecting it';
    if (need.kind === 'confirm') return 'you skipped it';
    return 'you skipped signing in';
  }

  /** An agent hands the person a step (a sign-in, a code, a permission): one request per app and kind, then waits for it. */
  function askPerson(s, job, { kind, reason }) {
    const app = needApp(job, reason);
    // Skip holds for the whole run (2026-10-08: "hitting skip should skip it permanently for this run, right now it tries
    // again"): an app the person skipped is never put to them again; the agent hears at once that it was skipped.
    if (s.skipped.has(app)) return Promise.resolve({ status: 'skipped', note: `The person skipped ${shownName(app)} for this run. Do not ask again: finish without it.` });
    // Zotero's and GitHub's sign-ins are Engelbart's own, whatever kind the agent named ("confirm" while Zotero's library
    // was still syncing came up as a browser sign-in). Signed in already: no step at all, the agent tries again.
    if (SIGNIN_APPS.has(app)) {
      kind = 'signin';
      if (ownStatus(app).connected) {
        logAction(s, job, `${shownName(app)} is signed in: trying again`);
        return Promise.resolve({ status: 'done', note: `${shownName(app)} is signed in already${app === 'Zotero' ? ' (the Zotero tools wait for its library to finish syncing)' : ''}. Try its tools again. Do not call needs_you for ${shownName(app)} again.` });
      }
    }
    // A connector signed in after this agent started (its tools were fixed then): the import runs again with it once this
    // one ends (rerunJob), so this agent finishes now instead of waiting on a step that can't help it.
    if (kind === 'connector' && isConnectorApp(app) && connectorConnected(app) && !(job.connectors || []).includes(app)) {
      job.rerun = true;
      return Promise.resolve({ status: 'done', note: `${shownName(app)} is connected now, but this import started without it. Finish now with what you have; Engelbart starts the ${shownName(app)} import again with the connection.` });
    }
    if (job.route === 'browser' && s.choices.browserAgents) return askInBrowser(s, job, app, { kind, reason });
    // A web app's sign-in lost partway through (2026-10-12): checked, then brought back (recover), quietly first (Zotero's
    // and GitHub's sign-ins, connectors and folder choices keep their steps). An Other tool's the same way (2026-10-16).
    if ((kind === 'signin' || kind === 'password') && webSignIn && signsInAtAll(app) && appOf(app) && appOf(app).reach === 'web') return signInAgain(s, job, app);
    if ((kind === 'signin' || kind === 'password') && !job.apps.length && job.extra && job.extra.tool && job.extra.tool.name === app) return recover(s, job, { tool: job.extra.tool });
    let need = s.needs.find((entry) => !entry.closed && entry.app === app && entry.kind === kind);
    if (!need) {
      need = { id: randomUUID(), app, kind, reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', note: noteFor(app, kind), closed: false, at: now() };
      s.needs.push(need);
      logAction(s, job, `Needs you: ${reason}`);
      traced({ kind: 'need', sessionId: s.id, jobId: job.id, text: `Needs the person (${kind}, ${shownName(app)}): ${reason}` });
    }
    if (!need.jobs.includes(job.id)) need.jobs.push(job.id);
    watchStep(s, need);
    return waitOn(s, job, need);
  }

  /**
   * A browser agent stopped at a sign-in, a code or a check in the person's own browser (2026-10-13: "At a login page it
   * should call `needs_you`"): a card that says so, whose Open brings that browser forward (the agent's tab is in it), and
   * Done once they have. Nothing of Engelbart's own sign-ins is involved.
   */
  function askInBrowser(s, job, app, { kind, reason }) {
    const ba = s.choices.browserAgents;
    let need = s.needs.find((entry) => !entry.closed && entry.app === app && entry.kind === kind && entry.own);
    if (!need) {
      const what = kind === 'signin' || kind === 'password' ? 'Sign in' : kind === '2fa' ? 'Enter the code' : kind === 'captcha' ? 'Answer the check' : 'Do it';
      need = { id: randomUUID(), app, kind, reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', note: `${what} on its tab in ${ba.browserName}, then press Done. The agent never types a password.`, closed: false, own: ba.browserName, ownId: ba.browserId, at: now() };
      s.needs.push(need);
      logAction(s, job, `Needs you in ${ba.browserName}: ${reason}`);
      traced({ kind: 'need', sessionId: s.id, jobId: job.id, text: `Needs the person in ${ba.browserName} (${kind}, ${shownName(app)}): ${reason}` });
    }
    if (!need.jobs.includes(job.id)) need.jobs.push(job.id);
    return waitOn(s, job, need);
  }

  /**
   * An agent found `app` signed out partway through the run. Its word is checked first (2026-10-12: one failed API answer
   * in "Looking through ChatGPT" dropped ChatGPT's working sign-in and stopped "Asking ChatGPT what it remembers"): while
   * Engelbart's browser still holds the sign-in cookie, and the site's check page (where it has one) doesn't say signed out,
   * the sign-in stands and the agent is told to reload and try again; nothing is dropped, no other job stopped, nothing
   * said in the chat. The same agent saying so again after that finishes without the app, quietly. Only a cookie that is
   * gone, or a check that says signed out, has the sign-in copied again quietly from the person's browser (signInQuiet; a
   * browser macOS refused, or was never asked about this run, is not asked: no new Keychain prompt). Signed in now: the
   * agent carries on. Not: the app is left out for the run, with a line in the chat. One check and one copy per sign-in at
   * a time: Gmail and Google Drive losing theirs together wait for the one answer.
   */
  function signInAgain(s, job, app) {
    const group = signInGroup(app);
    if (!s.signInsAgain) s.signInsAgain = new Map();
    let again = s.signInsAgain.get(group);
    if (!again) {
      again = { checking: null, checkedAt: 0, stood: new Set() };
      s.signInsAgain.set(group, again);
    }
    // Already being brought back for another agent (Gmail and Drive share Google's): this one waits for the same answer.
    if (recovering(s, { app })) return recover(s, job, { app });
    const skippedNote = () => ({ status: 'skipped', note: `${shownName(app)} was left out for this run. Do not ask again: finish without it.` });
    if (again.stood.has(job.id)) {
      logAction(s, job, `Carried on without ${shownName(app)}: it still looked signed in`);
      emit(s);
      return Promise.resolve({ status: 'skipped', note: `${shownName(app)} still looks signed in to Engelbart, so the trouble is on its side. Do not ask again: finish without it with what you have, and say so in your answer.` });
    }
    // One look at the sign-in, shared by the agents asking within a while of it.
    if (!again.checking || (again.checkedAt && Date.now() - again.checkedAt > SIGN_IN_AGAIN_SHARED_MS)) {
      again.checkedAt = 0;
      const look = typeof webSignIn.stillSignedIn === 'function' ? () => webSignIn.stillSignedIn(app) : () => webSignIn.signedIn(app);
      again.checking = Promise.resolve().then(look).then((value) => !!value, () => false);
      again.checking.then(() => { again.checkedAt = Date.now(); });
    }
    return again.checking.then((stands) => {
      if (s.skipped.has(app)) return skippedNote();
      if (!stands) return recover(s, job, { app });
      again.stood.add(job.id);
      logAction(s, job, `Still signed in to ${shownName(app)}: its page or API failed for a moment`);
      emit(s);
      return { status: 'done', note: 'Still signed in: the page or its API failed for a moment. Reload and try again, or finish with what you have.' };
    });
  }

  /* ----------------------------------------------------------------------------------- a sign-in brought back (M5) */

  /** Who a recovery is for: a registered web app (its sign-in shared by the apps of its group), or one of the Other tools. */
  function recoveryOf(target) {
    if (target.app) return { key: `app:${signInGroup(target.app)}`, name: shownName(target.app), app: target.app, tool: null };
    return { key: `tool:${String(target.tool.name).toLowerCase()}`, name: target.tool.name, app: null, tool: target.tool };
  }
  const recovering = (s, target) => { const rec = s.recoveries && s.recoveries.get(recoveryOf(target).key); return !!(rec && rec.phase !== 'ended'); };
  const leftAlready = (s, who) => s.skipped.has(who.name) || (!!who.app && s.skipped.has(who.app));
  const skippedNote = (who) => ({ status: 'skipped', note: `${who.name} was left out for this run. Do not ask again: finish without it.` });
  const backNote = (who) => ({ status: 'done', note: `The ${who.name} sign-in works in Engelbart's browser again. Reload the page and carry on.` });
  /** An Other tool's sites: those given, else its website's. */
  const toolSites = (tool) => [...new Set([...(Array.isArray(tool.sites) ? tool.sites : []), hostOfSite(tool.website)].filter(Boolean))];
  const pause = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); if (timer.unref) timer.unref(); });

  /** An Other tool's sign-in copied from the person's chosen browser profile (webSignIn.copyFor) → { copied, signedIn }. */
  function copyTool(tool) {
    const domains = toolSites(tool);
    if (!webSignIn || !domains.length) return Promise.resolve({ copied: 0, signedIn: false });
    if (typeof webSignIn.copyFor === 'function') return Promise.resolve().then(() => webSignIn.copyFor({ name: tool.name, domains }));
    if (typeof webSignIn.copyDomains === 'function') return webSignIn.copyDomains(domains, { denied: signInDenied }).then((ok) => ({ copied: ok ? 1 : 0, signedIn: ok ? null : false }));
    return Promise.resolve({ copied: 0, signedIn: false });
  }

  /**
   * The quiet part of a recovery: the sign-in copied again from the person's chosen browser profile, a few times over half
   * a minute (a fresh sign-in reaches the browser's disk within about that), with no window and no card. → what brought it
   * back (signInQuiet's answer, or copyTool's), or null. A check that couldn't tell counts as signed in (`unchecked`): it
   * never sends the person to sign in again. Their browser's sign-ins turned down, macOS refusing that browser, or a
   * sign-in their browser holds that Engelbart's refuses (`held`): nothing a copy could change.
   */
  async function quietly(s, rec) {
    if (s.choices.keychain === false || !webSignIn) return null;
    for (const wait of deps.recoverWaitsMs || RECOVER_WAITS_MS) {
      if (wait) await pause(wait);
      if (s.stopped || leftAlready(s, rec)) return null;
      let out = null;
      try { out = rec.app ? await webSignIn.signInQuiet(rec.app, { denied: signInDenied, fresh: true }) : await copyTool(rec.tool); } catch { out = null; }
      if (out && out.signedIn) return out;
      if (out && rec.tool && out.signedIn === null && out.copied > 0) return out; // copied, with nothing to check it by: the agent's reload is the check
      if (out && out.refused) { if (out.refusedId) signInDenied.add(out.refusedId); return null; }
      // Signed in there but refused here, or nothing that can be copied at all (Safari without Full Disk Access, the
      // Keychain not allowed, their sign-ins turned down): no copy will change it.
      if (out && (out.held || out.needs || out.declined)) return null;
    }
    return null;
  }

  /**
   * A sign-in that doesn't work in Engelbart's browser, brought back (the onboarding beta, 2026-10-16). Hudson: "The retries
   * should happen in the background with different retries and methods, but if it doesn't work it should auto-skip. Get rid
   * of the option to choose another profile", and Bart's flow, which he took: copy from the chosen profile and check; retry
   * quietly for a while; a check that can't tell keeps the sign-in; then one card, "Sign in inside Engelbart" or Skip
   * (Google's too, since 2026-10-16: it went to the person's browser, whose copy Google refused); signed in, checked,
   * and the agent goes on; failing even then, skipped with one quiet line that stays ("Couldn't connect to Linear.
   * Skipped."), the other imports going on. Nothing opens by itself while it retries. `target`: { app } a registered web
   * app, or { tool } one of the Other tools. One recovery per sign-in (Gmail and Drive share Google's), whoever asks: an
   * agent (`job`), or an app held at the start (`job` null). An agent told it was signed in again that asks again found it
   * did not hold: the card, or, after the card, left out. → a promise of what the agent is told { status, note }.
   */
  function recover(s, job, target) {
    const who = recoveryOf(target);
    if (leftAlready(s, who)) return Promise.resolve(skippedNote(who));
    if (!s.recoveries) s.recoveries = new Map();
    let rec = s.recoveries.get(who.key);
    if (rec && rec.phase === 'ended') {
      if (!job || !rec.told.has(job.id)) rec = null; // lost again later on: brought back again
      else if (rec.carded) { giveUp(s, null, rec); return Promise.resolve({ status: 'skipped', note: `${who.name}'s sign-in did not hold, so it is left out for this run. Do not ask again: finish without it and say so.` }); }
      else rec.phase = 'card';
    }
    if (!rec) {
      rec = { ...who, phase: 'quiet', told: new Set(), carded: false, need: null, quiet: null };
      s.recoveries.set(who.key, rec);
      logAction(s, job, `Bringing back the ${who.name} sign-in`);
      rec.quiet = quietly(s, rec).then((out) => {
        if (out) {
          rec.phase = 'ended';
          if (rec.app) { const kept = checkedAs(rec.app, out); for (const other of sharesSignIn(rec.app)) signInChecked.set(other, kept); }
          logAction(s, job, out.browser ? `Copied the ${who.name} sign-in again from ${out.browser}` : `The ${who.name} sign-in works again`);
          emit(s);
        } else if (rec.phase === 'quiet') rec.phase = 'card';
      });
    }
    const answer = () => {
      if (leftAlready(s, who)) return skippedNote(who);
      if (rec.phase === 'ended') { if (job) rec.told.add(job.id); return backNote(who); }
      const need = rec.need && !rec.need.closed ? rec.need : askCard(s, rec, job);
      if (!job) { need.keep = true; return need.settled.then((how) => (how === 'done' ? backNote(who) : skippedNote(who))); }
      if (!need.jobs.includes(job.id)) need.jobs.push(job.id);
      return waitOn(s, job, need).then((result) => {
        if (result.status === 'done') { rec.told.add(job.id); return backNote(who); }
        return result.status === 'skipped' ? skippedNote(who) : result;
      });
    };
    return rec.phase === 'quiet' && rec.quiet ? rec.quiet.then(answer) : Promise.resolve().then(answer);
  }

  /**
   * The card a recovery ends in, once: Sign in inside Engelbart · Skip, for every app, Google's too (2026-10-16: its card
   * sent the person to Chrome and waited for a copy Google refused every time, "Waiting…" for ten minutes).
   */
  function askCard(s, rec, job) {
    rec.phase = 'card';
    rec.carded = true;
    const need = { id: randomUUID(), app: rec.app || rec.name, kind: SIGNIN_HERE, where: 'here', recovery: rec.key, reason: `Sign in to ${rec.name}`, jobs: job ? [job.id] : [], waiters: new Map(), opened: false, busy: false, error: '', note: '', closed: false, keep: !job, tries: 0, at: now(), doneNote: backNote(rec).note };
    need.settled = new Promise((resolve) => { need.settle = resolve; });
    // Put away because no agent waits on it any more (releaseNeeds): the next loss starts afresh.
    need.settled.then((how) => { rec.phase = 'ended'; if (how === 'gone' && s.recoveries.get(rec.key) === rec) s.recoveries.delete(rec.key); });
    rec.need = need;
    s.needs.push(need);
    logAction(s, job, `Needs you: ${need.reason}`);
    traced({ kind: 'need', sessionId: s.id, ...(job ? { jobId: job.id } : {}), text: `Needs the person (sign in inside Engelbart, ${rec.name})` });
    emit(s);
    return need;
  }

  /** A recovery given up on: left out for the run, with one quiet line that stays, the others going on. */
  function giveUp(s, need, rec) {
    const name = rec ? rec.name : shownName(need.app);
    notice(s, `Couldn't connect to ${name}. Skipped.`);
    logAction(s, null, `Couldn't connect to ${name}: skipped`);
    if (need && !need.closed) { closeNeed(s, need, 'skip', 'Engelbart couldn’t connect to it'); return; }
    const app = rec ? rec.app || rec.name : need.app;
    leaveOut(s, app, 'Engelbart couldn’t connect to it');
    skipApp(s, app);
    emit(s);
  }

  /** An app held at the start whose sign-in didn't come over (signed out, or still checking then signed out): brought back. */
  function recoverHeld(s, app) {
    if (!s.held.has(app)) s.held.set(app, { source: (s.choices.direct ? importFlow.groupOfApp(app) : sourceOfApp(app)) || 'notes', recall: false });
    recover(s, null, { app }).then((answer) => {
      if (s.stopped || !s.held.has(app)) return;
      if (answer.status === 'done') releaseHeld(s, app, 'done');
      else { leaveOut(s, app, 'not signed in'); skipApp(s, app); releaseHeld(s, app, 'skip'); }
      emit(s);
    }).catch(() => {});
  }

  /**
   * A held app signed in in the person's browser whose sign-in Engelbart's browser refuses (`held-elsewhere`): read there by
   * an agent when they let agents use it; else signed in inside Engelbart (recover's card), Google's too (2026-10-16, the
   * beta's trace: every copy of Chrome's Google sign-in answered 302 → ServiceLogin; Hudson: "the same fallback logic we
   * have for everything else for Google Drive, including signing in in Engelbart's chromium if it fails"). Google turning
   * that window away too ends in "Couldn't connect to …. Skipped." (signInHereNow's 'rejected').
   */
  function heldElsewhere(s, app, browserName = '') {
    if (s.choices.browserAgents) { if (readElsewhere(s, app, browserName)) releaseHeld(s, app, 'done'); return; }
    if (signInWindow) { recoverHeld(s, app); return; }
    readElsewhere(s, app, browserName);
    releaseHeld(s, app, 'skip');
  }

  /**
   * "Sign in inside Engelbart" on a recovery's card: the sign-in made in Engelbart's window, checked, and the step closed as
   * done; turned away (Google's "Couldn't sign you in", 'rejected'), or signed in and still not working, given up on
   * (giveUp); the window closed without signing in, said on the card, which can be tried once more. Skip closes the window.
   */
  function signInHere(s, found) {
    if (found.busy) return snapshot(s);
    found.busy = true;
    found.error = '';
    found.opened = true;
    emit(s);
    // It lasts as long as the window is open: the card shows it waiting, and its answer comes as the session's next snapshot.
    void signInHereNow(s, found).catch(() => { found.busy = false; emit(s); });
    return snapshot(s);
  }

  async function signInHereNow(s, found) {
    const rec = (s.recoveries && s.recoveries.get(found.recovery)) || { name: shownName(found.app), app: APPS[found.app] ? found.app : null, tool: null };
    let out = { status: 'closed' };
    if (signInWindow && typeof signInWindow.close === 'function') found.cancel = () => signInWindow.close();
    try {
      if (rec.app) out = await signInWindowOpen(rec.app);
      else if (signInWindow && typeof signInWindow.openSite === 'function') {
        const sites = toolSites(rec.tool);
        out = await signInWindow.openSite({ name: rec.name, url: rec.tool.website || (sites[0] ? `https://${sites[0]}` : ''), domains: sites });
      } else out = { status: 'failed', error: `Couldn't open ${rec.name} inside Engelbart.` };
    } catch (error) { out = { status: 'failed', error: error && error.message ? error.message : '' }; }
    found.busy = false;
    found.cancel = null;
    if (found.closed) return snapshot(s);
    const works = out.status === 'signed-in' && (!rec.app || await Promise.resolve().then(() => (typeof webSignIn.stillSignedIn === 'function' ? webSignIn.stillSignedIn(rec.app) : webSignIn.signedIn(rec.app))).catch(() => false));
    if (works) {
      if (rec.app) for (const other of sharesSignIn(rec.app)) signInChecked.set(other, { status: 'signed-in', browser: '', browserId: '' });
      logAction(s, null, `Signed in to ${rec.name} inside Engelbart`, 'You');
      closeNeed(s, found, 'done');
      return snapshot(s);
    }
    found.tries += 1;
    if (out.status === 'signed-in' || out.status === 'rejected' || out.status === 'refused' || found.tries >= 2) { giveUp(s, found, rec); return snapshot(s); }
    found.error = out.status === 'failed' && out.error ? line(out.error, 200) : `Not signed in to ${rec.name} yet.`;
    emit(s);
    return snapshot(s);
  }

  function waitAgain(s, job) {
    const need = s.needs.find((entry) => !entry.closed && entry.jobs.includes(job.id));
    if (!need) return Promise.resolve({ status: 'done', note: 'Nothing is waiting on the person any more.' });
    return waitOn(s, job, need);
  }

  function waitOn(s, job, need) {
    job.status = 'waiting';
    emit(s);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { need.waiters.delete(job.id); if (job.status === 'waiting') job.status = 'running'; emit(s, { soon: true }); resolve({ status: 'waiting', note: 'The person has not done it yet. Call wait_for_you again, or go on without it and say so.' }); }, NEED_WAIT_MS);
      if (timer.unref) timer.unref();
      need.waiters.set(job.id, (result) => { clearTimeout(timer); if (job.status === 'waiting') job.status = 'running'; resolve(result); });
    });
  }

  /**
   * The person answered a request: done (the agents go on) or skip (they go on without that app). `why`: what a skip
   * leaves out, in words, for the completion (the person's own Later when not given).
   */
  function closeNeed(s, need, how, why = '') {
    if (need.closed) return;
    need.closed = true;
    need.outcome = how;
    if (need.watch) { clearInterval(need.watch); need.watch = null; }
    if (need.cancel) need.cancel(); // a sign-in still waited for in the default browser
    if (how === 'skip' && !s.stopped) {
      leaveOut(s, need.app, why || laterWhy(need));
      skipApp(s, need.app, need.jobs);
      // A recovery's card skipped leaves out every app picked that shares the sign-in (Drive's skips Gmail's too): it
      // would only be asked again for them.
      if (need.kind === SIGNIN_HERE && APPS[need.app]) for (const other of sharesSignIn(need.app)) if (other !== need.app && pickedHere(s, other)) { leaveOut(s, other, why || laterWhy(need)); skipApp(s, other); }
    }
    if (need.settle) need.settle(how);
    // A sign-in that came back signed out after the run started (lateSignIn): Log in done lets it join, Skip leaves it out.
    if (need.held) releaseHeld(s, need.app, how === 'skip' ? 'skip' : 'done');
    // A connector signed in while its agents waited: their tools were fixed when they started, so each finishes now and
    // its import runs again with the connection (rerunJob).
    const restart = how === 'done' && need.kind === 'connector' && isConnectorApp(need.app);
    if (restart) for (const job of s.jobs) if (need.jobs.includes(job.id) && job.kind === 'import' && !(job.connectors || []).includes(need.app)) job.rerun = true;
    const done = restart ? { status: 'done', note: `${shownName(need.app)} is connected now, but this import started without it. Finish now with what you have; Engelbart starts the ${shownName(need.app)} import again with the connection.` } : { status: 'done', ...(need.doneNote ? { note: need.doneNote } : {}) };
    for (const [jobId, resolve] of need.waiters) { resolve(how === 'skip' ? { status: 'skipped' } : done); if (browser) browser.hide(jobId); }
    need.waiters.clear();
    for (const jobId of need.jobs) if (browser) browser.hide(jobId);
    logAction(s, null, how === 'skip' ? `Skipped: ${need.reason}` : `Done: ${need.reason}`, 'You');
    emit(s);
  }

  /**
   * An app the person skipped, left out for the rest of the run: its other jobs end as skipped (queued ones at once, running
   * ones stopped; those that waited on the card hear "skipped" and finish what they report), no new one is queued
   * (dispatch, Import), and the librarian is told not to offer it again.
   */
  function skipApp(s, app, waiting = []) {
    if (!app || s.skipped.has(app)) return;
    s.skipped.add(app);
    for (const job of s.jobs) {
      if (!job.apps.length || !job.apps.every((each) => s.skipped.has(each)) || waiting.includes(job.id)) continue;
      if (job.status === 'queued') { job.status = 'stopped'; job.skipped = true; job.ended = now(); }
      else if (job.status === 'running' && job.controller) { job.skipped = true; job.controller.abort(); }
    }
    const source = sourceOfApp(app);
    if (source) {
      const note = { ...((s.found[source] || {})[app] || {}), skipped: 'The person skipped this app for this run: leave it out, and do not offer, ask about or hand it over again.' };
      s.found[source] = { ...(s.found[source] || {}), [app]: note };
      s.newFound = { ...(s.newFound || {}), [source]: { ...((s.newFound || {})[source] || {}), [app]: note } };
    }
  }

  /**
   * Skip on the librarian's last question or button: nothing of what it was about comes in (2026-10-08: "When I hit skip
   * it should not bring in anything, not just have the agent choose"). A question leaves out the apps it named, else its
   * whole source; a button leaves out its app. → what was left out, in words, or '' when the last turn asked nothing.
   */
  function skipAsked(s) {
    const last = lastSaid(s);
    if (!last) return '';
    if (last.authorize && last.authorize.app) { skipApp(s, last.authorize.app); return last.authorize.app; }
    const ask = last.ask;
    if (!ask || !ask.source || !sourceOf(ask.source)) return '';
    if (Array.isArray(ask.apps) && ask.apps.length) { for (const app of ask.apps) skipApp(s, app); return ask.apps.join(', '); }
    skipSource(s, ask.source);
    return sourceOf(ask.source).label;
  }

  /**
   * A source the person skipped, left out for the rest of the run: no import of it starts after this (dispatch, Import).
   * What they settled before the question, and the librarian handed over then, goes on.
   */
  function skipSource(s, source) {
    if (s.skippedSources.has(source)) return;
    s.skippedSources.add(source);
    const note = { ...((s.newFound || {})[source] || {}), skipped: 'The person skipped this source for this run: nothing of it comes in. Do not offer, ask about or dispatch it again.' };
    s.found[source] = { ...(s.found[source] || {}), skipped: note.skipped };
    s.newFound = { ...(s.newFound || {}), [source]: note };
    logAction(s, null, `Skipped ${sourceOf(source).label}`, 'You');
  }

  /** A job that ended stops waiting; a request no job waits on any more goes. */
  function releaseNeeds(s, job) {
    for (const need of s.needs) {
      if (need.closed || !need.jobs.includes(job.id)) continue;
      need.waiters.delete(job.id);
      need.jobs = need.jobs.filter((id) => id !== job.id);
      // A recovery's card an app held at the start still waits on (`keep`) stays.
      if (!need.jobs.length && !need.keep) { need.closed = true; if (need.watch) { clearInterval(need.watch); need.watch = null; } if (need.cancel) need.cancel(); if (need.settle) need.settle('gone'); }
    }
  }

  /* ------------------------------------------------------------------------------------------------------- MEMORY.md */

  function keepRecall(s, app, text) {
    s.recalls[app] = text;
    const dir = path.join(s.dir, 'memories');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, `${String(app).replace(/[^\w .-]+/g, '-')}.md`), `${text}\n`, { mode: 0o600 });
    emit(s, { soon: true });
  }

  /** MEMORY.md is written once the questions are over and every survey, recall and import has ended. */
  function maybeMemory(s) {
    if (s.stopped || s.suspended || s.memoryQueued || !(s.done || s.finished)) return;
    if (s.choices.direct && s.held.size) return; // a sign-in card still up: its import has not run yet
    if (s.jobs.some((job) => WORK.has(job.kind) && !ENDED.has(job.status))) return;
    const worked = s.jobs.some((job) => WORK.has(job.kind) && job.status === 'done') || Object.keys(s.recalls).length;
    if (!worked) { s.memory = { ...s.memory, status: 'skipped' }; return; }
    s.memoryQueued = true;
    s.memory = { ...s.memory, status: 'writing', error: '' };
    dispatch(s, { kind: 'memory', source: 'memory', apps: [], label: 'MEMORY.md' });
  }

  async function memoryMessage(s) {
    const recalls = Object.entries(s.recalls).map(([app, text]) => `## ${app} (asked ${s.created.slice(0, 10)})\n${clipMiddle(text, 12000)}`);
    const local = memory.localMemories(homeDir, env).map((entry) => `## ${entry.app} (${entry.file})\n${entry.text}`);
    const { imports, surveys } = memoryJobs(s);
    const existing = memory.readMemory(s.dataRoot);
    const custom = instructionsText(s.dataRoot);
    return [
      existing ? `<existing_memory>\n${existing}\n</existing_memory>` : '<existing_memory>none yet</existing_memory>',
      `<assistant_memories>\n${[...recalls, ...local].join('\n\n') || 'none'}\n</assistant_memories>`,
      `<conversation>\n${clipMiddle(conversationText(s), 20000)}\n</conversation>`,
      `<imports>\n${JSON.stringify({ imports, surveys }, null, 1)}\n</imports>`,
      custom ? `<custom_instructions>\n${custom}\n</custom_instructions>` : '',
      s.choices.custom ? `<import_instructions>\n${s.choices.custom}\n</import_instructions>` : '',
      `<folders note="Where what came in is, as Markdown files (one folder each), to Read when a title is not enough.">${[path.join(s.dataRoot, 'assets', 'md'), path.join(s.dir, 'notes'), s.projectDir].filter(Boolean).join(', ')}</folders>`,
      `Today is ${s.created.slice(0, 10)}. Write MEMORY.md now.`,
    ].filter(Boolean).join('\n\n');
  }

  function drafted(s, text) {
    const draft = String(text || '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
    if (draft.length < 40) throw new Error('The memory agent wrote nothing to keep');
    s.memoryDraft = draft;
    s.memory = { ...s.memory, status: 'cleaning' };
    // "one background claude sonnet agent": Claude Code's Sonnet when it can run, else the session's own pinned model.
    s.redactChoice = readyNow().includes('anthropic') ? choiceFor('anthropic') : s.choice;
    dispatch(s, { kind: 'redact', source: 'memory', apps: [], label: 'MEMORY.md, secrets out' });
  }

  async function finishMemory(s, text) {
    const draft = s.memoryDraft || '';
    let cleaned = String(text || '').trim().replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
    // An edit that lost most of the file is not an edit: the draft goes on, with only the secrets of a known shape out.
    if (cleaned.length < draft.length * 0.5) { logAction(s, null, 'The secrets check returned too little; kept the draft with known secrets masked'); cleaned = draft; }
    const scrubbed = memory.scrubSecrets(cleaned);
    const saved = memory.saveMemory(s.dataRoot, scrubbed.text);
    s.memoryDraft = null;
    s.memory = { status: 'saved', path: saved.path, previous: saved.previous, removed: scrubbed.removed, error: '', at: now() };
    logAction(s, null, `Saved MEMORY.md${scrubbed.removed ? ` (${scrubbed.removed} more secret${scrubbed.removed === 1 ? '' : 's'} masked)` : ''}`);
  }

  /* -------------------------------------------------------------------------------------------------------- start */

  async function rescan(s, sourceIds) {
    const only = { sources: Object.fromEntries(Object.entries(s.choices.sources).filter(([id]) => sourceIds.includes(id))), project: projectFor(s.choices), days: s.choices.days || null };
    const fresh = await scanFor(only, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null, access: accessOf(s) });
    for (const [source, apps] of Object.entries(fresh)) {
      // What a survey found is kept: the scan does not know it.
      const merged = { ...(s.found[source] || {}) };
      for (const [app, value] of Object.entries(apps)) {
        const before = merged[app];
        // Where the search for its folder looked is kept while the folder is still missing (MATH-117).
        merged[app] = before && before.survey && value && value.reach ? before : before && before.searched && value && value.needs === 'folder' ? { ...value, searched: before.searched } : value;
      }
      s.found[source] = merged;
      s.newFound = { ...(s.newFound || {}), [source]: merged };
    }
    s.dirs = dirsOf(s);
    lookForFolders(s);
  }

  /** The choose screen sent: the session, the scan, the first surveys, and the librarian's first turn. → snapshot */
  async function start(input) {
    const ctx = await context();
    input = directInput(input, homeDir);
    const choices = cleanChoices(input, homeDir);
    // Import manually with fine-grained permissions (From Amitav, 2026-10-15): Import your context's choices, but a
    // librarian session, which asks before anything comes in. What the person specified is its import instructions; an
    // extra tool is told to it rather than read as the browser history.
    const asked = input && input.librarian === true && choices.direct ? choices.direct : null;
    if (asked) {
      choices.custom = [choices.custom, librarianNotes(asked)].filter(Boolean).join('\n\n').slice(0, 4000);
      choices.sources.sites.on = asked.apps.includes(importFlow.SITES);
      // The tools the agents found, ticked (2026-10-15: told to the librarian, but nothing ever imported them): each asked
      // about in the grant (askGrant), and brought in through its site once allowed (extraImport).
      choices.extras = cleanExtras(asked.additional);
      choices.direct = null;
    }
    if (!Object.values(choices.sources).some((choice) => choice.on) && !(choices.extras || []).length) throw new Error('Pick at least one source.');
    const usable = readyNow();
    // Import your context with neither CLI able to run (2026-10-14): it starts, waiting for the provider the person chose
    // (the workspace's Connect popup), rather than failing in the flow with nowhere to connect it.
    const waitFor = !usable.length && choices.direct ? (PROVIDERS.includes(input && input.provider) ? input.provider : 'anthropic') : null;
    if (!usable.length && !waitFor) throw new Error('Sign in to Claude Code or Codex first: the agents run on one of them.');
    const provider = waitFor || (usable.includes(input && input.provider) ? input.provider : usable[0]);
    // Browser agents (2026-10-13): from what this Mac has and what the person answered, never from the window's word.
    choices.browserAgents = null;
    if (choices.direct && browserAgents) {
      try {
        const status = browserAgents.status({ provider, browserId: input && typeof input.browser === 'string' ? input.browser : null });
        if (status.use && status.browser) choices.browserAgents = { browserId: status.browser.id, browserName: status.browser.name, enable: !status.allowedByCli };
      } catch { choices.browserAgents = null; }
    }
    const id = randomUUID();
    let projectId = null, projectDir = null;
    if (input && typeof input.projectId === 'string' && ID_RE.test(input.projectId)) {
      try { const project = require('../store/projects.cjs').findProject(ctx, input.projectId); projectId = project.id; projectDir = project.dir; } catch { projectId = null; }
    }
    // The workspace it was started from (2026-10-11): what comes in joins its context too (placeRows), when it is one of the project's.
    let workspaceId = null;
    if (projectId && typeof input.workspaceId === 'string' && ID_RE.test(input.workspaceId)) {
      try { workspaceId = require('../store/projects.cjs').findWorkspace(ctx, projectId, input.workspaceId).workspace.id; } catch { workspaceId = null; }
    }
    const s = {
      id, mode: projectId ? 'existing' : 'onboarding', dataRoot: ctx.dataRoot, homeDir, dir: path.join(ctx.dataRoot, '.connect', id), downloads: path.join(ctx.dataRoot, 'imports', id), created: now(), choices, choice: choiceFor(provider), redactChoice: null,
      picked: { folders: {}, exports: {} }, chat: [], thinking: true, activity: 'Looking at what you picked…', done: false, finished: false, minimized: false, dismissed: false, error: '',
      jobs: [], seq: 0, needs: [], log: [], controllers: new Set(), interviewSession: null, interviewController: null, found: {}, newFound: null, toldImports: '', projectId, projectDir, stopped: false,
      waitingForSurvey: false, surveyNews: [], recalls: {}, memory: { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' }, memoryQueued: false, memoryDraft: null,
      skipped: new Set(), skippedSources: new Set(), suspended: false, held: new Map(), fallback: new Set(), connected: new Set(), rows: new Set(), inProject: new Set(), inWorkspace: new Set(), workspaceId, placing: Promise.resolve(),
      allowed: new Set(), approved: new Map(), // the librarian's run (2026-10-15): the apps the person let be read, the items they ticked
      manual: !!asked,
    };
    // A folder the person chose for an app on this Mac (Import your context's manual scopes): the app's, as if found.
    const scoped = choices.direct || asked;
    if (scoped) for (const [app, scope] of Object.entries(scoped.scopes)) if (FIND_APPS.has(app) && app !== LOCAL_PDFS && scope.folders.length) s.picked.folders[app] = scope.folders[0].path;
    if (waitFor) s.blocked = { provider: waitFor, error: `${PROVIDER_NAMES[waitFor]} is not connected`, at: now() };
    sessions.set(id, s);
    s.dirs = dirsOf(s);
    logAction(s, null, `Started with ${PROVIDER_NAMES[s.choice.provider]} (${s.choice.modelName} · ${s.choice.effort})`);
    traced({ kind: 'start', sessionId: id, text: `Connect session started${choices.direct ? ` (Import your context, ${choices.direct.mode === 'manual' ? 'sources chosen by the person' : 'tools found by agents'})` : ''} on ${PROVIDER_NAMES[s.choice.provider]} (${s.choice.modelName} · ${s.choice.effort})`, detail: { choices } });
    emit(s);
    void opening(s);
    return snapshot(s);
  }

  /**
   * A session's opening: a first line at once, the scan of what was picked (said in a sentence, without the model), the
   * web apps' sign-ins looked at, the first surveys and recalls (a signed-out app left out), the librarian's
   * first turn.
   */
  async function opening(s) {
    if (s.choices.direct) return directOpening(s);
    let opener = s.chat.find((entry) => entry.opener);
    if (!opener) {
      opener = { role: 'agent', text: 'Looking at what you picked…', ask: null, authorize: null, opener: true, at: now() };
      s.chat.push(opener);
      emit(s);
    }
    // The librarian must ask (From Amitav, 2026-10-15: "Fix/change this so the librarian must ask!"): nothing of a web app
    // or a connector is touched, no sign-in copied from their browser or reused and no survey run, until the person has
    // allowed it, all of them in one message, at once (askGrant). Those allowed before (a session picked up again) go on.
    // (deps.allowed, the tests: every app allowed before the run, as a session picked up again has them.)
    if (deps.allowed === true) for (const app of askedApps(s)) s.allowed.add(app);
    if (askGrant(s)) emit(s);
    try { s.found = await scanFor({ ...s.choices, project: projectFor(s.choices) }, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null, access: accessOf(s) }); } catch (error) { s.found = { error: error.message }; }
    if (s.stopped || s.suspended) return;
    opener.text = foundSentence(s);
    s.dirs = dirsOf(s);
    markAsking(s);
    emit(s);
    // The librarian starts once the person said which apps it may reach: it plans with what it may reach.
    await granted(s);
    if (s.stopped || s.suspended) return;
    const { lines } = await beginApps(s, askedApps(s).filter((app) => s.allowed.has(app)));
    if (s.stopped || s.suspended) return;
    lookForFolders(s);
    if (lines) opener.text = `${opener.text}\n\n${lines}`;
    emit(s);
    await interviewTurn(s, 'Start.');
  }

  /**
   * A session picked up again whose grant was still open (revive): once it is answered, the apps allowed start, and the
   * librarian, if it had not said anything yet, starts too.
   */
  async function afterGrant(s) {
    await granted(s);
    if (s.stopped || s.suspended) return;
    await beginApps(s, askedApps(s).filter((app) => s.allowed.has(app)));
    if (s.stopped || s.suspended || s.finished) return;
    lookForFolders(s);
    emit(s);
    if (!lastSaid(s) && !s.thinking) await interviewTurn(s, 'Start.');
  }

  /** The apps of the librarian's run on the web or behind a connector, ticked and not skipped. */
  function askedApps(s) {
    return [...new Set(Object.values(s.choices.sources).filter((choice) => choice.on).flatMap((choice) => choice.apps))].filter((app) => asksFirst(app) && !s.skipped.has(app));
  }

  /** Whether an agent may reach `app` now: in the librarian's run, an app it must ask about only once allowed. */
  const mayReach = (s, app) => !!s.choices.direct || !asksFirst(app) || (s.allowed || new Set()).has(app);
  /** Whether the person picked `app` for this run. */
  const pickedHere = (s, app) => Object.values(s.choices.sources).some((choice) => choice.on && choice.apps.includes(app)) || !!(s.choices.direct && s.choices.direct.apps.includes(app));

  /**
   * The librarian's run asks once, in one message, the first one in the chat (the onboarding beta, 2026-10-16, Hudson:
   * "Before I get to the actual library onboarding chat I got 12 different popups … Instead, the first message in the chat
   * window that should appear (this will circumvent the somewhat long loading time too!) is one message … 'Allow Engelbart
   * to access the following apps:' … every one should be unchecked by default … For things like saved URLs from notes apps,
   * don't include those; only include the primitive apps"). It replaced From Amitav's prompt per app (2026-10-15), and asks
   * about the same apps: every one on the web or behind a connector, and every tool the agents found or the person added.
   * Until it is answered those apps are held (no sign-in of theirs looked at, no survey) and the librarian waits; the scan
   * runs behind it. → its chat entry, or null when there is nothing to ask.
   */
  function askGrant(s) {
    if (openGrant(s)) return openGrant(s);
    const rows = [
      ...askedApps(s).filter((app) => !s.allowed.has(app)).map((app) => ({ id: app, name: shownName(app) })),
      ...(s.choices.extras || []).filter((tool) => !s.allowed.has(tool.name) && !s.skipped.has(tool.name)).map((tool) => ({ id: tool.name, name: tool.name, tool: true, ...(tool.website ? { website: tool.website } : {}) })),
    ];
    if (!rows.length) return null;
    const entry = { role: 'agent', text: '', grant: { rows, answered: null }, ask: null, authorize: null, at: now() };
    s.chat.push(entry);
    for (const row of rows) if (!row.tool) s.held.set(row.id, { source: sourceOfApp(row.id), recall: false, consent: true });
    logAction(s, null, `Asking you: Allow Engelbart to access ${listed(rows.map((row) => row.name))}?`);
    return entry;
  }
  const openGrant = (s) => s.chat.find((entry) => entry.grant && !entry.grant.answered) || null;

  /** What the librarian is told of the apps still asked about, once the scan has replaced what was found. */
  function markAsking(s) {
    const entry = openGrant(s);
    if (!entry) return;
    for (const row of entry.grant.rows) {
      const source = row.tool ? null : sourceOfApp(row.id);
      if (source) s.found[source] = { ...(s.found[source] || {}), [row.id]: { reach: appOf(row.id).reach, consent: 'asking: Engelbart asks the person to allow it. Nothing of it has been looked at. Do not ask about it, offer it or dispatch it.' } };
    }
  }

  /** Resolves once the open grant is answered (at once when there is none), or the session stops or is put away. */
  function granted(s) {
    if (!openGrant(s) || s.stopped || s.suspended) return Promise.resolve();
    return new Promise((resolve) => { (s.grantWaiters = s.grantWaiters || []).push(resolve); });
  }
  function releaseGrant(s) {
    const waiters = s.grantWaiters || [];
    s.grantWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * "Grant access" on the grant: { apps: [the ids ticked] }, at least one. Those ticked are allowed for the run (an Other
   * tool's import starts at once); the rest are left out. → snapshot
   */
  function grant(id, input = {}) {
    const s = get(id);
    const entry = openGrant(s);
    if (!entry) return snapshot(s);
    const ids = new Set((Array.isArray(input && input.apps) ? input.apps : []).filter((one) => typeof one === 'string'));
    const allowed = entry.grant.rows.filter((row) => ids.has(row.id)).map((row) => row.id);
    if (!allowed.length) throw new Error('Pick at least one app');
    answerGrant(s, entry, allowed, 'you didn’t allow Engelbart to access it');
    return snapshot(s);
  }

  function answerGrant(s, entry, ids, why) {
    const { rows } = entry.grant;
    entry.grant.answered = { allowed: rows.filter((row) => ids.includes(row.id)).map((row) => row.name), skipped: rows.filter((row) => !ids.includes(row.id)).map((row) => row.name), at: now() };
    for (const row of rows) {
      if (ids.includes(row.id)) { allowOne(s, row); continue; }
      leaveOut(s, row.id, why);
      if (row.tool) s.skipped.add(row.id);
      else { skipApp(s, row.id); releaseHeld(s, row.id, 'skip'); }
    }
    logAction(s, null, entry.grant.answered.allowed.length ? `Allowed Engelbart to access ${listed(entry.grant.answered.allowed)}` : `Left out ${listed(entry.grant.answered.skipped)}`, 'You');
    save(s);
    emit(s);
    releaseGrant(s);
  }

  /** An app or tool the person allowed: kept for the run; an app's sign-in and survey start with beginApps, a tool's import now. */
  function allowOne(s, row) {
    s.allowed.add(row.id);
    if (row.tool) {
      const tool = (s.choices.extras || []).find((one) => one.name === row.id);
      if (tool) void extraImport(s, tool).catch(() => {});
      return;
    }
    s.held.delete(row.id);
    const source = sourceOfApp(row.id);
    if (source) {
      const { consent: _consent, ...entry } = (s.found[source] || {})[row.id] || {};
      s.found[source] = { ...(s.found[source] || {}), [row.id]: entry };
    }
  }

  /**
   * A tool Engelbart has no import of its own for, allowed in the librarian's run: its sign-in copied into Engelbart's
   * browser from theirs (as Import your context does for these), else read in their own browser when agents may use it;
   * one import of its pages, documents or items about their project, as notes.
   */
  async function extraImport(s, tool) {
    dispatch(s, await toolJob(s, tool, { plan: (how, host) => `This is a tool they use that Engelbart has no import of its own for: ${toolSaid(tool)}. ${how}, and bring in its pages, documents or items about the project in <project> as notes (add_note).${host ? '' : ' It has no website given: look for it in their browser history first.'}` }));
  }

  /**
   * One of the Other tools' imports (2026-10-16, Hudson: "Modify the code such that it uses the cookies for all tools,
   * including ones in the 'other' category or that are added by the agents"): its sign-in copied from the person's chosen
   * browser profile into Engelbart's (copyTool); the person's own browser only when nothing could be copied and they let
   * agents use it. One job a tool, carrying the tool (name, website, sites), so a sign-in it asks for is the tool's
   * (needApp, recover). → the job to dispatch
   */
  async function toolJob(s, tool, { plan }) {
    const sites = toolSites(tool);
    const out = sites.length && s.choices.keychain !== false ? await copyTool(tool).catch(() => null) : null;
    const copied = !!(out && (out.copied > 0 || out.signedIn));
    if (copied) logAction(s, null, `Copied your ${tool.name} sign-in`);
    const ba = copied ? null : s.choices.browserAgents;
    const how = ba ? `Open it in a tab of your own in their ${ba.browserName}, where they are signed in` : 'Open it through their sign-in in Engelbart\'s browser';
    return { kind: 'import', source: 'sites', apps: [], label: `Other tools: ${tool.name}`.slice(0, 120), plan: plan(how, sites[0] || ''), extra: { sites, tool: { name: tool.name, website: tool.website || '', sites } }, route: ba ? 'browser' : null, keyExtra: tool.name };
  }

  /**
   * The apps a run may reach now, started: their sign-ins looked at (copied from the person's browser when Engelbart's
   * has none), their surveys started (a signed-out one brought back by recover, its survey waiting on it; one whose browser
   * macOS refused skipped). → { lines: the opener's sign-in lines, leftOut: [] (kept for its callers) }
   */
  async function beginApps(s, apps) {
    if (!apps.length) return { lines: '', leftOut: [] };
    await checkConnectors(apps);
    const checked = await signInsFirst(s, apps);
    if (s.stopped || s.suspended) return { lines: '', leftOut: [] };
    startWork(s, new Set([...checked.signedOut, ...checked.refused.keys(), ...checked.checking.keys()]), apps);
    for (const [app, answer] of checked.checking) if (s.held.has(app)) lateSignIn(s, app, answer);
    // A ticked web app still signed out (2026-10-16, in place of leaving it out): brought back, quietly first, then its
    // card (Sign in inside Engelbart · Skip); its survey starts once it is signed in.
    for (const app of [...checked.signedOut].filter((one) => s.held.has(one))) recoverHeld(s, app);
    const leftOut = [];
    // An app whose browser macOS refused gets no card that can't succeed (2026-10-10): it is skipped for this run.
    for (const [app, name] of checked.refused) {
      skipApp(s, app);
      releaseHeld(s, app, 'skip');
      logAction(s, null, `Skipped ${shownName(app)}: macOS didn't allow ${name || 'your browser'}'s sign-ins`);
    }
    emit(s);
    return { lines: [signInLines(checked), leftOut.length ? leftOutLine(leftOut) : ''].filter(Boolean).join('\n'), leftOut };
  }

  /* ------------------------------------------------------------------------------------- Import your context (direct) */

  /**
   * Import your context's run (2026-10-13, the workspace: "when they confirm, basically our existing agent + dispatch
   * architecture should run, instructing each subagent for each platform to only find information pertaining to the
   * projects the user selected"). No librarian and no questions: the scan, the web apps' sign-ins looked at, then one
   * import job a tool (shared/import-flow.cjs importPlan: only what pertains to the projects picked; a manual import keeps
   * to exactly what the person chose), the tools named that are not in the catalog together through the browser, the
   * assistants asked what they remember, and MEMORY.md once everything has ended. A web app still signed out is not left
   * out: it waits on a sign-in card (a modal in the workspace) and its import starts once it is signed in.
   */
  async function directOpening(s) {
    const d = s.choices.direct;
    const titles = d.projects.map((project) => project.title);
    let opener = s.chat.find((entry) => entry.opener);
    if (!opener) {
      opener = { role: 'agent', text: titles.length ? `Bringing in what pertains to ${listed(titles)}…` : 'Bringing in what you picked…', ask: null, authorize: null, opener: true, at: now() };
      s.chat.push(opener);
      emit(s);
    }
    s.thinking = true;
    s.activity = 'Looking at what you picked…';
    try { s.found = await scanFor({ ...s.choices, project: projectFor(s.choices) }, { homeDir, env, picked: s.picked, zotero, github, appleNotes: s.choices.permissions.notes ? appleNotes : null, access: accessOf(s) }); } catch (error) { s.found = { error: error.message }; }
    if (s.stopped || s.suspended) return;
    s.dirs = dirsOf(s);
    // The apps a connector reaches (Engelbart's sign-in, or the one the person made in their own Claude Code or Codex):
    // their tools are used, no sign-in is copied for them.
    s.connected = new Set();
    await checkConnectors(d.apps);
    for (const app of d.apps) {
      if (!connectors || !appOf(app) || appOf(app).reach !== 'connector') continue;
      const reached = await Promise.resolve().then(() => (typeof connectors.reaches === 'function' ? connectors.reaches(app, s.choice.provider) : connectors.status(app).connected)).catch(() => false);
      if (reached) s.connected.add(app);
    }
    if (s.connected.size) logAction(s, null, `Using your ${listed([...s.connected].map(shownName))} connection${s.connected.size === 1 ? '' : 's'}`);
    const checked = await signInsFirst(s);
    if (s.stopped || s.suspended) return;
    // Their browser's sign-ins declined (the keychain question): a web app Engelbart's browser isn't signed in to is read
    // in their own browser when they let agents use it; else signed in inside Engelbart (recover's card, 2026-10-16: "I
    // suppose we can ask them to sign in using Engelbart's chromium … and then have agents run there").
    if (s.choices.keychain === false && s.choices.browserAgents) { for (const app of checked.signedOut) checked.elsewhere.set(app, s.choices.browserAgents.browserName); checked.signedOut.clear(); }
    // Signed in in their browser, refused by Engelbart's, and no browser agents: signed in inside Engelbart, Google's as
    // well (2026-10-16: it was left out here, said, with no way to sign in; heldElsewhere).
    if (!s.choices.browserAgents && signInWindow) for (const [app] of [...checked.elsewhere]) { checked.elsewhere.delete(app); checked.signedOut.add(app); }
    const held = new Set([...checked.signedOut, ...checked.checking.keys()]);
    for (const [app, name] of checked.refused) {
      leaveOut(s, app, `macOS didn't allow ${name || 'your browser'}'s sign-ins`);
      skipApp(s, app);
      logAction(s, null, `Skipped ${shownName(app)}: macOS didn't allow ${name || 'your browser'}'s sign-ins`);
    }
    for (const [app, name] of checked.elsewhere) readElsewhere(s, app, name);
    if (s.fallback.size) logAction(s, null, `${listed([...s.fallback].map(shownName))} in ${s.choices.browserAgents.browserName}, in the background`);
    // Signed out of Engelbart's own sign-in (Zotero, GitHub), or a connector no sign-in of Engelbart's or the person's
    // reaches and whose sign-in isn't copied from a browser (Granola): held on its step, its import started once signed in.
    const webChecked = (app) => checked.signedIn.has(app) || checked.refused.has(app) || checked.elsewhere.has(app) || checked.signedOut.has(app) || checked.checking.has(app);
    const ownHeld = new Map();
    const viaSite = new Set(); // connectors read through their website instead (connectorFallback)
    for (const app of d.apps) {
      if (s.skipped.has(app) || held.has(app)) continue;
      if (isConnectorApp(app) && !s.connected.has(app) && connectorFallback(s, app)) { viaSite.add(app); continue; } // read through its site instead
      if (SIGNIN_APPS.has(app) && ownDep(app) && typeof ownDep(app).status === 'function' && !ownStatus(app).connected) ownHeld.set(app, 'signin');
      else if (isConnectorApp(app) && connectors && !s.connected.has(app) && !webChecked(app)) ownHeld.set(app, 'connector');
    }
    for (const app of d.apps) {
      if (s.skipped.has(app)) continue;
      if (held.has(app)) {
        s.held.set(app, { source: importFlow.groupOfApp(app), recall: false });
        if (checked.signedOut.has(app)) recoverHeld(s, app);
        continue;
      }
      if (ownHeld.has(app)) { signInCard(s, app, ownHeld.get(app)); continue; }
      if (viaSite.has(app)) continue;
      directImport(s, app);
    }
    for (const [app, answer] of checked.checking) lateSignIn(s, app, answer);
    // The tools not in the catalog (2026-10-16: one job a tool, each with its own sign-in, where they were one job whose
    // every sign-in was "Other tools: …"): their sign-ins copied into Engelbart's browser (round 3: the hidden browser
    // first); the person's own browser only when that can't be done and they let agents use it.
    for (const tool of d.additional) {
      const base = importFlow.importPlan({ app: importFlow.SITES, mode: d.mode, projects: d.projects, roles: d.roles, work: d.work, period: periodName(s.choices.days) });
      dispatch(s, await toolJob(s, tool, { plan: (how, host) => `${base}\n\nThis is a tool they use that Engelbart has no import of its own for: ${toolSaid(tool)}. ${how}, and bring in its pages, documents or items about these projects as notes (add_note) or saved pages.${host ? '' : ' It has no website given: look for it in their browser history first.'}` }));
    }
    if (s.choices.permissions.recall && s.choices.permissions.browser) {
      for (const app of recallApps((s.choices.sources.chats || {}).on ? s.choices.sources.chats.apps : [])) {
        if (s.skipped.has(app)) continue;
        if (s.fallback.has(app) && !checked.signedIn.has(app)) continue; // a recall asks in Engelbart's browser, signed out there
        if (s.held.has(app)) s.held.get(app).recall = true;
        else dispatch(s, { kind: 'recall', source: 'chats', apps: [app], label: `Asking ${shownName(app)} what it remembers` });
      }
    }
    const lines = [signInLines({ signedIn: checked.signedIn, refused: checked.refused }), s.held.size ? `Waiting for you to sign in to ${listed([...s.held.keys()].map(shownName))}.` : ''].filter(Boolean).join('\n');
    opener.text = `${foundSentence(s).replace(/ Starting with .*$/, '')}${lines ? `\n\n${lines}` : ''}`;
    s.thinking = false;
    s.activity = '';
    s.done = true;
    s.finished = true;
    emit(s);
    maybeMemory(s);
  }

  /** One tool's import in an Import your context run, with its plan; the whole source when the tool is the source's one row. */
  function directImport(s, app) {
    const d = s.choices.direct;
    const scope = d.scopes[app] || null;
    const route = browseApp(s, app) ? 'browser' : null;
    const plan = importFlow.importPlan({ app, mode: d.mode, projects: d.projects, roles: d.roles, work: d.work, scope, period: periodName(s.choices.days), browser: route ? s.choices.browserAgents.browserName : '' });
    const where = (folders) => (folders.length ? `\n\nThe folders: ${folders.map((dir) => readers.shownPath(homeDir, dir)).join(', ')}.` : '');
    if (app === importFlow.SITES) return dispatch(s, { kind: 'import', source: 'sites', apps: [], label: 'Pages from your browser history', plan });
    if (app === importFlow.LOCAL_FOLDERS) return dispatch(s, { kind: 'import', source: 'code', apps: [], label: 'Folders on this Mac', plan: `${plan}${where(s.choices.sources.code.folders)}` });
    if (app === 'GitHub') return dispatch(s, { kind: 'import', source: 'code', apps: ['GitHub'], label: 'GitHub', plan });
    const source = importFlow.groupOfApp(app);
    if (!source) return null;
    const label = `${sourceOf(source).label}: ${shownName(app)}`;
    return dispatch(s, { kind: 'import', source, apps: [app], label, plan: app === LOCAL_PDFS ? `${plan}${where(s.choices.sources.papers.folders)}` : plan, route });
  }

  /**
   * `app` is signed in in the person's browser, but that sign-in won't work in Engelbart's (round 3: Gmail's "Log in" only
   * showed them they were signed in). Read in their own browser by an agent when they let agents use it (→ true), else
   * left out with a line in the chat (→ false). Never a sign-in popup: they are signed in already.
   */
  function readElsewhere(s, app, browserName = '') {
    if (s.skipped.has(app)) return false;
    if (s.choices.browserAgents) {
      s.fallback.add(app);
      logAction(s, null, `${shownName(app)}: read in ${s.choices.browserAgents.browserName}, where you're signed in`);
      return true;
    }
    leaveOut(s, app, `you're signed in to it in ${browserName || 'your browser'}, but it doesn't let Engelbart use that sign-in`);
    skipApp(s, app);
    notice(s, `Left out ${shownName(app)}: you're signed in to it in ${browserName || 'your browser'}, but it doesn't let Engelbart use that sign-in.`);
    logAction(s, null, `Left out ${shownName(app)}: its sign-in in ${browserName || 'your browser'} doesn't work in Engelbart`);
    return false;
  }

  /**
   * An app signed out when an Import your context run starts: a card asks the person to sign in, and its import waits
   * (held) until they have. A web app's sign-in is copied from their browser; Zotero's and GitHub's are Engelbart's own
   * (2026-10-14: their imports started signed out, so their agents asked mid-run, raced Zotero's first sync and asked
   * again); a connector's (`kind` 'connector', Granola) is its OAuth, which an agent already running could never use.
   */
  function signInCard(s, app, kind = 'signin') {
    if (s.needs.some((need) => !need.closed && need.app === app && need.kind === kind)) return;
    const reason = kind === 'connector' ? `Connect ${shownName(app)} so its agent can bring in what pertains to your projects` : `Sign in to ${shownName(app)} so its agent can bring in what pertains to your projects`;
    const need = { id: randomUUID(), app, kind, reason, jobs: [], waiters: new Map(), opened: false, busy: false, error: '', note: noteFor(app, kind), closed: false, held: true, at: now() };
    s.needs.push(need);
    if (!s.held.has(app)) s.held.set(app, { source: importFlow.groupOfApp(app), recall: false });
    logAction(s, null, `Needs you: ${reason}`);
    traced({ kind: 'need', sessionId: s.id, text: `Needs the person (${kind}, ${shownName(app)}): ${reason}` });
    watchStep(s, need);
  }

  /** What the scan found, in one plain sentence: "Found 2 Obsidian vaults, 36 PDFs in Downloads and your Claude Code chats. Starting with your notes." */
  function foundSentence(s) {
    const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
    const parts = [];
    const firstSource = [];
    for (const [source, apps] of Object.entries(s.found || {})) {
      if (!apps || typeof apps !== 'object' || source === 'error') continue;
      const before = parts.length;
      for (const [app, value] of Object.entries(apps)) {
        if (!value || typeof value !== 'object') continue;
        if (Array.isArray(value.vaults) && value.vaults.length) parts.push(`${plural(value.vaults.length, `${shownName(app)} vault`)}`);
        else if (Array.isArray(value.folders) && value.folders.length && typeof value.pdfs === 'number') {
          const where = value.folders.slice(0, 2).map((folder) => folder.folder).filter(Boolean);
          parts.push(`${plural(value.pdfs, 'PDF')}${s.choices.days ? ` from ${periodName(s.choices.days)}` : ''}${where.length ? ` in ${where.join(' and ')}` : ''}`);
        } else if (typeof value.chats === 'number' && value.chats) parts.push(`your ${shownName(app)} chats`);
        else if (value.signedIn && typeof value.items === 'number') parts.push(`${plural(value.items, `${shownName(app)} item`)}`);
        else if (Array.isArray(value.repos) && value.repos.length) parts.push(`${plural(value.repos.length, `${shownName(app)} repository`, `${shownName(app)} repositories`)}`);
      }
      if (parts.length > before) firstSource.push(source);
    }
    const ticked = Object.entries(s.choices.sources).filter(([, choice]) => choice.on).map(([source]) => source);
    const startWith = ticked.find((source) => firstSource.includes(source)) || ticked[0];
    const label = startWith && sourceOf(startWith) ? sourceOf(startWith).label.toLowerCase() : '';
    const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    const found = list ? `Found ${list}.` : 'Had a look at what you picked.';
    return label ? `${found} Starting with your ${label}.` : found;
  }

  function busy(s) { if (s.thinking) throw new Error('Wait for the librarian to answer'); }

  /** The person answered: { text } | { picked: [labels], text? } | { skipped: true }, and maybe { provider }. */
  function answer(id, input = {}) {
    const s = get(id);
    busy(s);
    const value = input && typeof input === 'object' ? input : {};
    const picked = Array.isArray(value.picked) ? value.picked.filter((label) => typeof label === 'string' && label.trim()).slice(0, 12) : null;
    const text = typeof value.text === 'string' ? value.text.trim().slice(0, 4000) : '';
    const clean = value.skipped ? { skipped: true } : picked && picked.length ? { picked, text } : { text };
    if (!clean.skipped && !clean.picked && !clean.text) throw new Error('Say something first');
    if (typeof value.provider === 'string') setProvider(s, value.provider);
    if (clean.skipped) clean.left = skipAsked(s);
    if (clean.picked) approvePicked(s, clean.picked);
    s.chat.push({ role: 'user', text: shownOf(clean), at: now() });
    void interviewTurn(s, messageOf(clean));
    return snapshot(s);
  }

  /**
   * What the person ticked is what may be read (From Amitav, 2026-10-15: "if in library brainstorm mode they should be
   * prompted with individual files and asked to bring those in"): the items of the librarian's last question about an app
   * whose items are approved (tools.cjs APPROVAL_APPS) that they picked, by the ids its survey reported, kept for the run;
   * that app's imports read nothing else. An option with no ids is matched to the survey's item of the same name; an id
   * no survey reported is not kept.
   */
  function approvePicked(s, labels) {
    const last = lastSaid(s);
    const ask = last && last.ask;
    if (!ask || !Array.isArray(ask.options) || !sourceOf(ask.source)) return;
    const apps = (Array.isArray(ask.apps) && ask.apps.length ? ask.apps : sourceOf(ask.source).apps).filter((app) => APPROVAL_APPS.has(app));
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    for (const app of apps) {
      const report = ((s.found[ask.source] || {})[app] || {}).survey;
      const items = report && Array.isArray(report.items) ? report.items : [];
      const known = new Set(items.map((item) => item.id).filter(Boolean));
      for (const option of ask.options) {
        if (!labels.includes(option.label)) continue;
        const ids = Array.isArray(option.ids) && option.ids.length ? option.ids : items.filter((item) => same(item.label, option.label)).map((item) => item.id);
        for (const id of ids) {
          if (!known.has(id)) continue;
          if (!s.approved.has(app)) s.approved.set(app, new Set());
          s.approved.get(app).add(id);
        }
      }
    }
    if (apps.length) save(s);
  }

  /** The provider chosen under the chat: the next turns and jobs run there (its pinned model); a new librarian session. */
  function setProvider(s, provider) {
    if (!PROVIDERS.includes(provider) || provider === s.choice.provider) return;
    if (!readyNow().includes(provider)) throw new Error(`${PROVIDER_NAMES[provider]} is not signed in`);
    s.choice = choiceFor(provider);
    s.interviewSession = null;
    logAction(s, null, `Switched to ${PROVIDER_NAMES[provider]} (${s.choice.modelName} · ${s.choice.effort})`, 'You');
  }

  /**
   * A button in the chat was used: { app, kind: 'signin' } done in the window (Zotero, GitHub); { app, kind: 'connector' }
   * (the connector's sign-in, run here: the person's browser opens); { app, kind: 'permission' } (macOS asked here);
   * { app, kind: 'folder', path } chosen. Then the librarian goes on.
   */
  async function authorize(id, input = {}) {
    const s = get(id);
    busy(s);
    const app = typeof input.app === 'string' && (APPS[input.app] || input.app === 'GitHub') ? input.app : null;
    if (!app) throw new Error('Unknown app');
    const kind = AUTHORIZE_KINDS.has(input.kind) ? input.kind : input.kind === 'file' ? 'folder' : null;
    if (!kind) throw new Error('Unknown kind');
    const source = sourceOfApp(app);
    let clean;
    if (kind === 'connector') {
      if (!connectors) throw new Error(`${shownName(app)} cannot be signed in to here`);
      s.activity = `Waiting for you to sign in to ${shownName(app)} in your browser`;
      s.thinking = true;
      emit(s);
      try { await connectors.signIn(app); } catch (error) { s.thinking = false; s.activity = ''; emit(s); throw error; }
      s.thinking = false;
      s.activity = '';
      clean = { authorized: { app, kind } };
      s.found[source] = { ...(s.found[source] || {}), [app]: { reach: 'connector', survey: 'running' } };
      dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` });
    } else if (kind === 'permission') {
      if (!appleNotes) throw new Error(`${shownName(app)} cannot be read here`);
      const out = await appleNotes.permission();
      if (!out.allowed) throw new Error(out.error || 'macOS did not allow it');
      s.choices.permissions.notes = true;
      clean = { authorized: { app, kind } };
    } else if (kind === 'signin') {
      clean = { authorized: { app, kind } };
    } else {
      const file = readers.expandPath(homeDir, input.path);
      if (!file || !file.startsWith(homeDir + path.sep) || !fs.existsSync(file)) throw new Error('Choose something inside your home folder');
      s.picked.folders[app] = file;
      // Chosen in the folder picker: macOS lets Engelbart read it, protected folder or not (MATH-110).
      s.choices.picked = [...new Set([...(s.choices.picked || []), fs.statSync(file).isDirectory() ? file : path.dirname(file)])].slice(-40);
      clean = { chose: { app, kind: 'folder', shown: readers.shownPath(homeDir, file) } };
    }
    s.chat.push({ role: 'user', text: shownOf(clean), at: now() });
    logAction(s, null, shownOf(clean), 'You');
    s.thinking = true;
    emit(s);
    // Zotero's library is read from the copy its first sync makes: waited for (a minute and a half at most), so the
    // librarian can list the collections.
    if (app === 'Zotero' && kind === 'signin') {
      s.activity = 'Waiting for your Zotero library to sync';
      emit(s);
      for (let n = 0; n < 90 && !s.stopped; n += 1) {
        const root = zotero.root ? zotero.root() : null;
        if (root && fs.existsSync(path.join(root, 'items.json'))) break;
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
      }
      s.activity = '';
    }
    if (kind !== 'connector') { try { await rescan(s, source ? [source] : []); } catch { /* the librarian is told what it can be */ } }
    s.thinking = false;
    void interviewTurn(s, messageOf(clean));
    return snapshot(s);
  }

  /**
   * Import: every source picked and not yet handed over goes now, with what the chat said, so the person need not wait
   * for the librarian; it is told, and asks nothing more. → snapshot
   */
  function importNow(id) {
    const s = get(id);
    s.finished = true;
    if (s.interviewController) s.interviewController.abort();
    // The apps still asked about (askGrant) were never allowed: they are left out, the grant answered so.
    const open = openGrant(s);
    if (open) answerGrant(s, open, [], 'you pressed Import before allowing it');
    for (const [source, choice] of Object.entries(s.choices.sources)) {
      const sent = s.jobs.filter((job) => job.kind === 'import' && job.source === source);
      if (!choice.on || s.skippedSources.has(source) || sent.some((job) => !job.apps.length)) continue;
      const covered = new Set(sent.flatMap((job) => job.apps));
      const reachable = (app) => {
        const found = ((s.found || {})[source] || {})[app];
        const reach = appOf(app) ? appOf(app).reach : null;
        if (reach === 'web') return s.choices.permissions.browser;
        if (reach === 'connector') return !!(connectors && connectors.status(app).connected);
        if (reach === 'automation') return s.choices.permissions.notes;
        return !(found && (found.needs || found.looking));
      };
      const apps = choice.apps.filter((app) => !covered.has(app) && !s.skipped.has(app) && reachable(app));
      if (sent.length && !apps.length) continue;
      if (choice.apps.length && !apps.length && !choice.folders.length && !choice.repos.length) continue; // nothing of it can be reached
      const label = sourceOf(source).label;
      const where = [apps.length ? `from ${apps.join(', ')}` : '', choice.folders.length ? `folders ${choice.folders.join(', ')}` : '', choice.repos.length ? `repositories ${choice.repos.join(', ')} (already in the library)` : ''].filter(Boolean).join('; ');
      dispatch(s, { kind: 'import', source, apps, label: apps.length ? `${label}: ${apps.map(shownName).join(', ')}` : label, plan: `Bring in ${label.toLowerCase()} ${where} as the person picked and said in the chat. They pressed Import before this source was talked through, so use sensible defaults: leave out daily notes, personal folders and journals; tools used every day (mail, calendar, social media); runs a program started; anything older than about six months when there is a lot.` });
    }
    s.chat.push({ role: 'user', text: 'Import now', at: now() });
    s.done = true;
    s.waitingForSurvey = false;
    emit(s);
    maybeMemory(s);
    return snapshot(s);
  }

  /* ---------------------------------------------------------------------------------------- the person's controls */

  /** A request the window shows was answered: 'open' (do it: show the agent's window, sign in, ask macOS), 'done', 'skip'. */
  async function need(id, needId, action) {
    const s = get(id);
    const found = s.needs.find((entry) => entry.id === needId && !entry.closed);
    if (!found) return snapshot(s);
    if (!['open', 'done', 'skip'].includes(action)) throw new Error('Unknown action');
    // A recovery's card (recover): its sign-in made inside Engelbart (or in their browser, for Google's), or Skip.
    if (found.kind === SIGNIN_HERE) {
      if (action === 'skip') { closeNeed(s, found, 'skip'); return snapshot(s); }
      return signInHere(s, found);
    }
    // Zotero's and GitHub's own sign-ins (2026-10-14): run here, not in the window, and closed once the account is connected.
    if (SIGNIN_APPS.has(found.app) && !found.own && action !== 'skip') {
      if (action === 'open') return ownSignIn(s, found);
      if (ownStatus(found.app).connected) closeNeed(s, found, 'done');
      else { found.error = `Still not signed in to ${shownName(found.app)}.`; emit(s); }
      return snapshot(s);
    }
    if (action === 'done' && !found.own && SIGNIN_KINDS.has(found.kind) && webSignIn) return signedInNow(s, found);
    if (action === 'done' || action === 'skip') { closeNeed(s, found, action); return snapshot(s); }
    found.error = '';
    // "confirm" (an agent's step for the person with nothing of Engelbart's to run): Done is the person's word.
    if (found.kind === 'confirm') { closeNeed(s, found, 'done'); return snapshot(s); }
    // A browser agent's stop in the person's own browser: that browser brought forward, where its tab is.
    if (found.own) {
      const opened = openBrowserApp ? await Promise.resolve().then(() => openBrowserApp(found.ownId)).then(() => true, () => false) : false;
      found.opened = opened;
      found.error = opened ? '' : `Open ${found.own} yourself: the agent's tab is there.`;
      if (opened) logAction(s, null, `Opened ${found.own}`, 'You');
      emit(s);
      return snapshot(s);
    }
    // A connector's sign-in, in the person's browser: waited for in the background (it can take ten minutes), never in the
    // way of Later, which calls it off (2026-10-14: Later left its sign-in waiting). Made, the step closes (watchStep too).
    if (found.kind === 'connector' && connectors && isConnectorApp(found.app)) {
      if (found.busy) return snapshot(s);
      if (connectorConnected(found.app)) { closeNeed(s, found, 'done'); return snapshot(s); }
      found.busy = true;
      found.opened = true;
      found.cancel = () => { try { connectors.cancel(found.app); } catch { /* nothing waiting */ } };
      emit(s);
      Promise.resolve().then(() => connectors.signIn(found.app)).then(() => {
        found.busy = false;
        found.cancel = null;
        if (!found.closed) { logAction(s, null, `Connected ${shownName(found.app)}`, 'You'); closeNeed(s, found, 'done'); }
      }, (error) => {
        found.busy = false;
        found.cancel = null;
        if (found.closed) return;
        found.opened = false;
        found.error = line(error && error.message ? error.message : `Couldn't connect ${shownName(found.app)}`, 200);
        emit(s);
      });
      watchStep(s, found);
      return snapshot(s);
    }
    if (found.kind === 'permission' && appleNotes && found.app === 'Apple Notes') {
      found.busy = true;
      emit(s);
      const out = await appleNotes.permission();
      found.busy = false;
      if (out.allowed) { s.choices.permissions.notes = true; closeNeed(s, found, 'done'); } else { found.error = line(out.error, 200); emit(s); }
      return snapshot(s);
    }
    // Any other permission an agent asks for (a folder macOS guards): Allow is the person's leave; the agent tries again,
    // and macOS asks for itself if it must. It used to say "Open … in your browser", which no browser could do.
    if (found.kind === 'permission') { closeNeed(s, found, 'done'); return snapshot(s); }
    // Round 3 (2026-10-13): "no logins should happen in Engelbart's Chromium browser". Their browser's sign-ins declined:
    // the app is read in their own browser when agents may use it, else left out; nothing opens in Engelbart.
    if (SIGNIN_KINDS.has(found.kind) && s.choices.keychain === false && webSignIn) {
      const name = webSignIn.browserName ? webSignIn.browserName() : '';
      closeNeed(s, found, readElsewhere(s, found.app, name) ? 'done' : 'skip', 'its sign-in can only be used with your browser’s sign-ins, which you turned down');
      return snapshot(s);
    }
    // An app whose sign-in cookie isn't known (OneNote, Evernote…): its page opens in the browser they chose, and "I'm signed
    // in" copies its cookies over (signedInNow).
    if (SIGNIN_KINDS.has(found.kind) && webSignIn && !webSignIn.supports(found.app) && typeof webSignIn.openApp === 'function') {
      const name = await webSignIn.openApp(found.app).catch(() => '');
      found.opened = !!name;
      if (name) { found.browser = name; logAction(s, null, `Opened ${shownName(found.app)} in ${name}`, 'You'); }
      else found.error = `Couldn't open ${shownName(found.app)}. Open it in your browser, then come back.`;
      emit(s);
      return snapshot(s);
    }
    // A web app's sign-in: in the browser the person chose, where they are likely signed in already, then brought over to
    // Engelbart's (./web-signin.cjs). The window waits on it in the background; done once Engelbart holds the sign-in.
    if (SIGNIN_KINDS.has(found.kind) && webSignIn && webSignIn.supports(found.app)) {
      if (found.busy) return snapshot(s);
      const controller = new AbortController();
      found.busy = true;
      found.cancel = () => controller.abort();
      emit(s);
      const opened = (name) => { found.opened = true; found.browser = name; logAction(s, null, `Opened ${shownName(found.app)}'s sign-in in ${name}`, 'You'); emit(s); };
      webSignIn.signIn(found.app, { signal: controller.signal, onOpened: opened }).catch((error) => ({ status: 'failed', error: error.message })).then((out) => {
        // Ended by "I'm signed in" (signedInNow), which owns the step now.
        if (controller.signal.aborted && out.status === 'cancelled') return;
        found.busy = false;
        found.cancel = null;
        found.note = noteFor(found.app, found.kind); // macOS has been asked now, or will be by the next browser
        if (out.browser) found.browser = out.browser; // the browser it used, not the default it may have passed over
        if (found.closed || out.status === 'cancelled') return;
        if (out.status === 'signed-in') { logAction(s, null, `Signed in to ${shownName(found.app)} from ${out.browser}`, 'You'); closeNeed(s, found, 'done'); return; }
        // Signed in there already, the sign-in refused by Engelbart's browser: read in their browser, or left out.
        if (out.status === 'held-elsewhere') { closeNeed(s, found, readElsewhere(s, found.app, out.browser) ? 'done' : 'skip', 'its sign-in doesn’t work in Engelbart'); emit(s); return; }
        if (out.status === 'unsupported' || out.status === 'no-browser') { found.error = `Couldn't open ${shownName(found.app)} in your browser. Sign in there, then press I’m signed in.`; emit(s); return; }
        // macOS refused: a card that asks again can't succeed (2026-10-10), so the app is skipped and the chat says so.
        if (out.status === 'denied') {
          if (out.browserId) signInDenied.add(out.browserId);
          closeNeed(s, found, 'skip', `macOS didn't allow ${out.browser || 'your browser'}'s sign-ins`);
          notice(s, skippedLine(out.browser, [found.app]));
          emit(s);
          return;
        }
        found.error = out.status === 'timeout' ? `Still not signed in to ${shownName(found.app)} in ${out.browser}. Log in to keep waiting, or skip it.` : line(out.error, 200);
        emit(s);
      });
      return snapshot(s);
    }
    // Anything else (a step with no browser of theirs to open): said, never shown in Engelbart's window.
    found.error = `Open ${shownName(found.app)} in your browser to finish this, then come back.`;
    emit(s);
    return snapshot(s);
  }

  /**
   * "I'm signed in" on a sign-in popup (round 3): the sign-in copied from their browser and checked before the step closes →
   * done; signed in there but refused by Engelbart's browser → their browser or left out; not yet → the popup says so.
   */
  async function signedInNow(s, found) {
    // 2026-10-14 (Notion: "i clicked im signed in but then nothing happend"): Open's wait for the sign-in (busy) used to
    // swallow this press. The person's word ends that wait and the check runs now.
    if (found.busy && typeof found.cancel === 'function') { found.cancel(); found.cancel = null; found.busy = false; }
    if (found.busy) return snapshot(s);
    found.busy = true;
    found.error = '';
    emit(s);
    let out = { signedIn: false };
    try {
      if (webSignIn.supports(found.app)) out = await webSignIn.signInQuiet(found.app, { denied: signInDenied });
      else out = { signedIn: await webSignIn.copyBlind(found.app, { denied: signInDenied }).catch(() => false) };
    } catch { out = { signedIn: false }; }
    found.busy = false;
    if (found.closed) return snapshot(s);
    if (out.signedIn) {
      for (const other of sharesSignIn(found.app)) signInChecked.set(other, checkedAs(other, out));
      logAction(s, null, `Signed in to ${shownName(found.app)}${out.browser ? ` from ${out.browser}` : ''}`, 'You');
      closeNeed(s, found, 'done');
      return snapshot(s);
    }
    if (out.held) { closeNeed(s, found, readElsewhere(s, found.app, found.browser) ? 'done' : 'skip', 'its sign-in doesn’t work in Engelbart'); return snapshot(s); }
    if (out.refused) { if (out.refusedId) signInDenied.add(out.refusedId); closeNeed(s, found, 'skip', `macOS didn't allow ${out.refused}'s sign-ins`); notice(s, skippedLine(out.refused, [found.app])); emit(s); return snapshot(s); }
    // They say they are signed in there and agents may use that browser: read it there (the copy can't be told apart).
    if (found.opened && s.choices.browserAgents && readElsewhere(s, found.app, found.browser)) { closeNeed(s, found, 'done'); return snapshot(s); }
    found.error = `Still not signed in to ${shownName(found.app)}${found.browser ? ` in ${found.browser}` : ''}.`;
    emit(s);
    return snapshot(s);
  }

  /**
   * Sign in on a Zotero or GitHub step (2026-10-14): Engelbart's own sign-in started here (its page in the person's default
   * browser, through the broker), not by the window waiting on events it could miss. The step closes once the account is
   * connected (watchStep), whoever finished it; a sign-in that ends without one says why on the popup, and Sign in starts
   * it again. Pressed again while it waits, the same sign-in's page opens again. GitHub's device code, when it has one,
   * is on the popup (`code`).
   */
  async function ownSignIn(s, found) {
    const app = found.app;
    const dep = ownDep(app);
    if (ownStatus(app).connected) { closeNeed(s, found, 'done'); return snapshot(s); }
    if (!dep || typeof dep.connect !== 'function') { found.error = `Sign in to ${shownName(app)} in Settings, then come back.`; emit(s); return snapshot(s); }
    if (found.busy) return snapshot(s);
    found.busy = true;
    found.error = '';
    emit(s);
    let out = null;
    try { out = await dep.connect(); } catch (error) { out = { failed: error && error.message ? error.message : `Couldn't start the ${shownName(app)} sign-in.` }; }
    found.busy = false;
    if (found.closed) return snapshot(s);
    if (out && out.connected) { logAction(s, null, `Signed in to ${shownName(app)}`, 'You'); closeNeed(s, found, 'done'); return snapshot(s); }
    if (!out || out.failed || !out.pending) {
      found.opened = false;
      found.error = line((out && (out.failed || out.error)) || `Couldn't open the ${shownName(app)} sign-in. Try again.`, 200);
      emit(s);
      return snapshot(s);
    }
    found.opened = true;
    found.code = out.pending.userCode || '';
    logAction(s, null, `Opened the ${shownName(app)} sign-in in your browser`, 'You');
    watchStep(s, found);
    emit(s);
    return snapshot(s);
  }

  /**
   * A code, a captcha, or a sign-in the default browser cannot carry over: the agent's own window, on its page, shown to the
   * person to do it there (the agents' sign-ins are Engelbart's browser's). Closing the window carries on (windowClosed).
   */
  function showWindow(s, found, note = '') {
    const jobId = found.jobs.find((each) => browser && browser.has(each));
    if (!jobId || !browser.show(jobId, { title: `${found.reason} — Engelbart` })) {
      found.error = 'There is no sign-in window to show: sign in to it on the Stage, or skip it.';
      emit(s);
      return;
    }
    found.opened = true;
    found.error = note;
    logAction(s, null, `Opened the window: ${found.reason}`, 'You');
    emit(s);
  }

  /** A step the agents' browser took for a job, into that job's session's action log. */
  function logJob(jobId, text) {
    for (const s of sessions.values()) {
      const job = s.jobs.find((entry) => entry.id === jobId);
      if (job) { logAction(s, job, text); return; }
    }
  }

  /**
   * The person closed a window shown to them: what it was shown for counts as done, but a web app's sign-in only when
   * Engelbart's browser holds it now (2026-10-08: signed in, then asked again), else the card stays with Log in.
   */
  function windowClosed(jobId) {
    for (const s of sessions.values()) {
      const found = s.needs.find((entry) => !entry.closed && entry.jobs.includes(jobId));
      if (!found) continue;
      if (!(webSignIn && webSignIn.supports(found.app))) { closeNeed(s, found, 'done'); continue; }
      webSignIn.signedIn(found.app).catch(() => true).then((yes) => {
        if (found.closed) return;
        if (yes) { closeNeed(s, found, 'done'); return; }
        found.opened = false;
        found.error = `Not signed in to ${shownName(found.app)} yet.`;
        emit(s);
      });
    }
  }

  function stopJob(id, jobId) {
    const s = get(id);
    const job = s.jobs.find((entry) => entry.id === jobId);
    if (!job) return snapshot(s);
    if (job.status === 'queued') { job.status = 'stopped'; job.ended = now(); logAction(s, job, 'Stopped'); }
    else if (job.controller) job.controller.abort();
    emit(s);
    maybeMemory(s);
    return snapshot(s);
  }

  function stop(id) {
    const s = get(id);
    s.stopped = true;
    if (s.interviewController) s.interviewController.abort();
    for (const controller of s.controllers) controller.abort();
    for (const job of s.jobs) if (job.status === 'queued') { job.status = 'stopped'; job.ended = now(); }
    for (const found of s.needs) if (!found.closed) closeNeed(s, found, 'skip');
    releaseGrant(s);
    if (s.memory.status === 'waiting' || s.memory.status === 'writing' || s.memory.status === 'cleaning') s.memory = { ...s.memory, status: 'stopped' };
    logAction(s, null, 'Stopped everything', 'You');
    emit(s);
    return snapshot(s);
  }

  /** MEMORY.md again, after it failed. */
  function retryMemory(id) {
    const s = get(id);
    if (s.stopped) throw new Error('This import was stopped');
    if (s.jobs.some((job) => (job.kind === 'memory' || job.kind === 'redact') && !ENDED.has(job.status))) return snapshot(s);
    s.jobs = s.jobs.filter((job) => job.kind !== 'memory' && job.kind !== 'redact');
    s.memoryQueued = false;
    if (s.memoryDraft) { s.memoryQueued = true; s.memory = { ...s.memory, status: 'cleaning', error: '' }; dispatch(s, { kind: 'redact', source: 'memory', apps: [], label: 'MEMORY.md, secrets out' }); } else maybeMemory(s);
    emit(s);
    return snapshot(s);
  }

  function setMinimized(id, value) { const s = get(id); s.minimized = !!value; emit(s); return snapshot(s); }

  /** Taken off the list of what is running (the dock), once nothing of it runs any more. */
  function dismiss(id) {
    const s = get(id);
    s.dismissed = true;
    emit(s);
    return true;
  }

  /** Onboarding made the project: the staged notes go into it, and later ones straight there. → how many went in */
  async function attachProject(ctx, id, projectId, workspaceId = null) {
    const s = sessions.get(id);
    if (!s || s.dataRoot !== ctx.dataRoot) return 0;
    s.projectId = projectId;
    try { s.projectDir = require('../store/projects.cjs').findProject(ctx, projectId).dir; } catch { s.projectDir = null; }
    const written = await notes.flushStaged(ctx, s.dir, projectId, { projects: require('../store/projects.cjs') });
    if (typeof workspaceId === 'string' && ID_RE.test(workspaceId)) s.workspaceId = workspaceId;
    await placeRows(s, [...s.rows]);
    emit(s);
    return written.length;
  }

  // What the session brought into the library, or found already there (2026-10-10). Library rows belong to no project,
  // so no agent of the project was told of them (shared/project-holds.cjs): once the session knows its project (started
  // from it, or onboarding's attachProject), each goes on the project's own list (project.json `library`, 2026-10-11),
  // those that come in later as well, so the project's agents see the person's library. Never a row taken out of the
  // project before (project.json `removed`): only adding it again brings it back. One placing at a time: each reads what
  // it adds to. Never into a workspace's context (2026-10-13, "imports go only to the library for now, not the
  // workspace"): filling the Welcome workspace's context to its limit was what made "Context has too many entries".
  function keepRow(s, row) {
    if (!row || typeof row.id !== 'string' || !ID_RE.test(row.id) || s.rows.has(row.id)) return;
    s.rows.add(row.id);
    if (s.projectId) void placeRows(s, [row.id]);
  }
  function placeRows(s, ids) {
    if (!ids.length || !s.projectId) return s.placing;
    s.placing = s.placing.then(async () => {
      const projects = require('../store/projects.cjs');
      const ctx = await context();
      if (ctx.dataRoot !== s.dataRoot) return;
      const listed = projects.keepInProject(ctx, s.projectId, ids);
      const { removed } = projects.findProject(ctx, s.projectId);
      for (const row of ids.filter((one) => !removed.includes(one))) s.inProject.add(row);
      // The Welcome project's folder holds everything the run brought in, for every project picked (2026-10-14: "the
      // welcome project folder should be a complete set of their project files"). Not what the person threw out of it.
      // Onboarding's run only: an import started inside a project stays on its list (2026-10-13, "library only").
      let linked = 0;
      if (s.workspaceId && s.mode === 'onboarding') {
        try {
          const { workspace } = projects.findWorkspace(ctx, s.projectId, s.workspaceId);
          const adding = ids.filter((one) => !workspace.removed.includes(one) && !workspace.context.includes(one) && !s.inWorkspace.has(one));
          if (adding.length) { await projects.linkToWorkspace(ctx, s.projectId, s.workspaceId, adding); for (const row of adding) s.inWorkspace.add(row); linked = adding.length; }
        } catch { /* the workspace gone or full: the rows stay in the project and the library */ }
      }
      if (listed.length || linked) placed(s.projectId);
    }).catch(() => {}); // the project gone, or the library closed: what came in stays in the library
    return s.placing;
  }

  /* ------------------------------------------------------------------------------------------ quitting and resuming */

  /**
   * Engelbart quits, or switches to another library: every session still going is saved as it is (`suspended`) and its
   * agents end, to be picked up again by resume when that library is open next. Nothing it did is undone.
   */
  function suspendAll() {
    for (const s of [...sessions.values()]) {
      if (!s.stopped && !s.dismissed) {
        s.suspended = true;
        save(s, { force: true });
        if (s.interviewController) s.interviewController.abort();
        for (const controller of s.controllers) controller.abort();
        releaseGrant(s);
      }
      sessions.delete(s.id);
      resumed.delete(s.dataRoot);
    }
    if (browser) browser.closeAll();
  }

  const resumed = new Set(); // the data roots whose saved sessions were looked at
  const RESUME_DAYS = 7;

  /** A saved session that was not done when Engelbart closed: not stopped, dismissed or over, and less than a week old. */
  function unfinished(saved) {
    if (!saved || typeof saved !== 'object' || saved.stopped || saved.dismissed) return false;
    const created = Date.parse(saved.created);
    if (!Number.isFinite(created) || Date.now() - created > RESUME_DAYS * 86_400_000) return false;
    if (saved.blocked || stalledOnProvider(saved)) return true; // waiting for its provider: picked up, its popup asks again
    const jobs = Array.isArray(saved.jobs) ? saved.jobs : [];
    if (!saved.done && !saved.finished) return true;
    if (jobs.some((job) => job && WORK.has(job.kind) && !ENDED.has(job.status))) return true;
    return !!(saved.memory && ['waiting', 'writing', 'cleaning'].includes(saved.memory.status));
  }

  /**
   * A run saved before runs waited for their provider (2026-10-14): Import your context, nothing came in, and its agents
   * failed as their CLI needed the person ("Not logged in"). It is picked up again with those jobs queued, waiting.
   */
  function stalledOnProvider(saved) {
    if (!saved || typeof saved !== 'object' || !saved.direct || saved.stopped) return false;
    const work = (Array.isArray(saved.jobs) ? saved.jobs : []).filter((job) => job && WORK.has(job.kind));
    if (!work.length || work.some((job) => job.status === 'done')) return false;
    const counts = saved.counts && typeof saved.counts === 'object' ? saved.counts : {};
    if ((Number(counts.notes) || 0) + (Number(counts.items) || 0) > 0) return false;
    return work.some((job) => job.status === 'failed' && needsProvider(job.error));
  }

  /** Paths a saved session kept for an app (a folder chosen, an export), still inside the home folder and still there. */
  /** An Other tool a saved job was for ({ name, website, sites }), or null. */
  function keptTool(tool) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) return null;
    const sites = (Array.isArray(tool.sites) ? tool.sites : []).filter((host) => typeof host === 'string' && /^[a-z0-9.-]{1,200}$/i.test(host)).slice(0, 12);
    return { name: line(tool.name, 60), website: typeof tool.website === 'string' && /^https?:\/\//i.test(tool.website) ? tool.website.slice(0, 300) : '', sites };
  }

  function keptPaths(value) {
    const out = {};
    for (const [app, file] of Object.entries(value && typeof value === 'object' ? value : {})) {
      const real = typeof file === 'string' ? readers.expandPath(homeDir, file) : null;
      if (real && real.startsWith(homeDir + path.sep) && fs.existsSync(real) && (APPS[app] || app === 'GitHub')) out[app] = real;
    }
    return out;
  }

  /** What each assistant answered, read back from the session's memories/ folder. */
  function keptRecalls(dir) {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'memories')).filter((name) => name.endsWith('.md')); } catch { return out; }
    for (const name of names) {
      const app = name.slice(0, -3);
      if (!APPS[app]) continue;
      try { out[app] = fs.readFileSync(path.join(dir, 'memories', name), 'utf8').trim(); } catch { /* gone */ }
    }
    return out;
  }

  /** One saved session made live again: its unfinished jobs queued, the librarian asked again if it had not answered. */
  function revive(ctx, id, saved) {
    const dir = path.join(ctx.dataRoot, '.connect', id);
    const usable = readyNow();
    const stalled = stalledOnProvider(saved);
    const provider = usable.includes(saved.provider) ? saved.provider : usable[0] || (PROVIDERS.includes(saved.provider) ? saved.provider : 'anthropic');
    let projectId = null, projectDir = null;
    if (typeof saved.projectId === 'string' && ID_RE.test(saved.projectId)) {
      try { const project = require('../store/projects.cjs').findProject(ctx, saved.projectId); projectId = project.id; projectDir = project.dir; } catch { projectId = null; }
    }
    const kept = saved.memory && saved.memory.status === 'saved';
    const s = {
      id, mode: saved.mode === 'existing' && projectId ? 'existing' : 'onboarding', dataRoot: ctx.dataRoot, homeDir, dir, downloads: path.join(ctx.dataRoot, 'imports', id), created: saved.created, choices: cleanChoices(saved.choices, homeDir, { alsoPicked: Object.values(keptPaths(saved.picked && saved.picked.folders)).map((file) => (fs.statSync(file).isDirectory() ? file : path.dirname(file))) }), choice: choiceFor(provider), redactChoice: null,
      picked: { folders: keptPaths(saved.picked && saved.picked.folders), exports: keptPaths(saved.picked && saved.picked.exports) },
      chat: (Array.isArray(saved.chat) ? saved.chat : []).filter((entry) => entry && (entry.role === 'agent' || entry.role === 'user')), thinking: false, activity: '', done: !!saved.done, finished: !!saved.finished, minimized: true, dismissed: false, error: '',
      jobs: [], seq: 0, needs: [], log: (Array.isArray(saved.log) ? saved.log : []).slice(-MAX_LOG), controllers: new Set(), interviewSession: typeof saved.interviewSession === 'string' ? saved.interviewSession : null, interviewController: null,
      found: saved.found && typeof saved.found === 'object' ? saved.found : {}, newFound: null, toldImports: '', projectId, projectDir, stopped: false,
      waitingForSurvey: !!saved.waiting, surveyNews: [], recalls: keptRecalls(dir), memory: kept ? { ...saved.memory } : { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' }, memoryQueued: kept, memoryDraft: null,
      skipped: new Set((Array.isArray(saved.skipped) ? saved.skipped : []).filter((app) => typeof app === 'string')),
      skippedSources: new Set((Array.isArray(saved.skippedSources) ? saved.skippedSources : []).filter((id) => sourceOf(id))), suspended: false, held: new Map(),
      fallback: new Set((Array.isArray(saved.fallback) ? saved.fallback : []).filter((app) => typeof app === 'string' && APPS[app])),
      connected: new Set((Array.isArray(saved.connected) ? saved.connected : []).filter((app) => typeof app === 'string' && APPS[app])),
      rows: new Set((Array.isArray(saved.rows) ? saved.rows : []).filter((row) => typeof row === 'string' && ID_RE.test(row))),
      inProject: new Set((Array.isArray(saved.inProject) ? saved.inProject : []).filter((row) => typeof row === 'string' && ID_RE.test(row))),
      inWorkspace: new Set((Array.isArray(saved.inWorkspace) ? saved.inWorkspace : []).filter((row) => typeof row === 'string' && ID_RE.test(row))),
      workspaceId: projectId && typeof saved.workspaceId === 'string' && ID_RE.test(saved.workspaceId) ? saved.workspaceId : null, placing: Promise.resolve(),
      gmailThreads: Number.isInteger(saved.gmailThreads) && saved.gmailThreads > 0 ? saved.gmailThreads : 0, manual: saved.manual === true,
      allowed: new Set((Array.isArray(saved.allowed) ? saved.allowed : []).filter((app) => typeof app === 'string' && APPS[app])),
      approved: new Map(Object.entries(saved.approved && typeof saved.approved === 'object' ? saved.approved : {}).filter(([app, ids]) => APPROVAL_APPS.has(app) && Array.isArray(ids)).map(([app, ids]) => [app, new Set(ids.filter((id) => typeof id === 'string').slice(0, 2000))])),
      leftOut: new Map((Array.isArray(saved.leftOut) ? saved.leftOut : []).filter((entry) => entry && typeof entry.app === 'string' && (APPS[entry.app] || entry.app === 'GitHub') && typeof entry.why === 'string').map((entry) => [entry.app, line(entry.why, 200)])),
    };
    // Closed before the librarian's first word, with only the opening line said: the opening again.
    if (s.chat.every((entry) => entry.opener)) s.chat = [];
    for (const job of Array.isArray(saved.jobs) ? saved.jobs : []) {
      if (!job || !Object.hasOwn(PRIORITY, job.kind)) continue;
      // MEMORY.md is written again once the work has ended, unless it was saved: its draft was never kept on disk.
      if ((job.kind === 'memory' || job.kind === 'redact') && !kept) continue;
      const again = !ENDED.has(job.status) || (stalled && job.status === 'failed' && needsProvider(job.error));
      const apps = (Array.isArray(job.apps) ? job.apps : []).filter((app) => typeof app === 'string' && (APPS[app] || app === 'GitHub'));
      s.seq += 1;
      const find = job.kind === 'survey' && (job.find === true || (typeof job.key === 'string' && job.key.startsWith('find:')));
      s.jobs.push({
        ...(find ? { find: true } : {}),
        id: typeof job.id === 'string' && ID_RE.test(job.id) ? job.id : randomUUID(), key: typeof job.key === 'string' ? job.key : `${find ? 'find' : job.kind}:${job.source}:${[...apps].sort().join(',')}`,
        kind: job.kind, priority: PRIORITY[job.kind], seq: s.seq, source: String(job.source || ''), apps, label: line(job.label, 120), plan: typeof job.plan === 'string' ? clip(job.plan, 8000) : '', extra: job.extra && Array.isArray(job.extra.sites) ? { sites: job.extra.sites.filter((host) => typeof host === 'string' && /^[a-z0-9.-]{1,200}$/i.test(host)).slice(0, 12), ...(keptTool(job.extra.tool) ? { tool: keptTool(job.extra.tool) } : {}) } : null,
        status: again ? 'queued' : job.status, skipped: !!job.skipped, notes: Number(job.notes) || 0, items: Number(job.items) || 0, titles: (Array.isArray(job.titles) ? job.titles : []).slice(0, 80).map((title) => line(title, 120)),
        activity: '', summary: again ? '' : line(job.summary, 500), error: again ? '' : line(job.error, 300), started: again ? null : job.started || null, ended: again ? null : job.ended || null,
        ...(job.route === 'browser' && job.kind === 'import' && s.choices.browserAgents ? { route: 'browser' } : {}),
      });
    }
    // A survey that waited on a sign-in card when Engelbart closed (the card is not kept): it runs now, and asks again itself.
    for (const [source, apps] of Object.entries(s.found)) {
      for (const [app, value] of Object.entries(apps && typeof apps === 'object' ? apps : {})) {
        if (!value || !value.signIn || s.skipped.has(app)) continue;
        const { signIn: _signIn, ...entry } = value;
        s.found[source] = { ...s.found[source], [app]: entry };
        if (!s.jobs.some((job) => job.kind === 'survey' && job.apps.includes(app))) {
          s.seq += 1;
          s.jobs.push({ id: randomUUID(), key: `survey:${source}:${app}`, kind: 'survey', priority: PRIORITY.survey, seq: s.seq, source, apps: [app], label: `Looking through ${shownName(app)}`, plan: '', extra: null, status: 'queued', notes: 0, items: 0, titles: [], activity: '', summary: '', error: '', started: null, ended: null });
        }
      }
    }
    // Waiting for its provider when Engelbart closed, or stalled on it before runs waited: it waits still while neither CLI
    // can run (the popup asks); one that can now runs what waited.
    const waited = (saved.blocked && PROVIDERS.includes(saved.blocked.provider)) ? saved.blocked : stalled ? { provider: provider, error: `${PROVIDER_NAMES[provider]} is not connected` } : null;
    s.blocked = waited && !usable.length && s.choices.direct ? { provider: waited.provider, error: line(waited.error || '', 200), at: now() } : null;
    if (stalled) s.memory = { status: 'waiting', path: memory.memoryPath(ctx.dataRoot), error: '' };
    sessions.set(id, s);
    s.dirs = dirsOf(s);
    // An app held on its sign-in (no import of its own yet) gets its popup again (2026-10-14: Notion's step and its import
    // were gone after a restart: the steps are not kept, and nothing queued the app again).
    if (s.choices.direct) {
      for (const need of Array.isArray(saved.needs) ? saved.needs : []) {
        const app = need && typeof need.app === 'string' ? need.app : '';
        if (!app || need.closed || !(SIGNIN_KINDS.has(need.kind) || need.kind === 'connector' || need.kind === SIGNIN_HERE) || !APPS[app] || !s.choices.direct.apps.includes(app)) continue;
        if (s.skipped.has(app) || s.jobs.some((job) => job.kind === 'import' && job.apps.includes(app))) continue;
        // Signed in while Engelbart was closed (Zotero, GitHub, a connector): its import starts now, with no step.
        if ((SIGNIN_APPS.has(app) && ownStatus(app).connected) || (need.kind === 'connector' && connectorConnected(app))) { directImport(s, app); continue; }
        // A web app's sign-in: brought back again (recover), quietly first.
        if (APPS[app].reach === 'web') { s.held.set(app, { source: importFlow.groupOfApp(app), recall: false }); recoverHeld(s, app); continue; }
        signInCard(s, app, need.kind === 'connector' ? 'connector' : 'signin');
      }
    }
    // The librarian's grant (askGrant): one still open is asked again as it was, and its apps held; apps neither allowed nor
    // left out (a session from before the grant) are asked about in a new one. A connector allowed and still waiting to be
    // connected gets its step again, or, connected meanwhile, its survey.
    let grantOpen = false;
    if (!s.choices.direct && !s.finished && !s.stopped && (s.chat.length || s.jobs.length)) {
      const open = openGrant(s);
      if (open) { for (const row of open.grant.rows) if (!row.tool) s.held.set(row.id, { source: sourceOfApp(row.id), recall: false, consent: true }); } else askGrant(s);
      grantOpen = !!openGrant(s);
      for (const [source, apps] of Object.entries(s.found)) {
        for (const [app, value] of Object.entries(apps && typeof apps === 'object' ? apps : {})) {
          if (!value || !value.connector || !isConnectorApp(app) || !s.allowed.has(app) || s.skipped.has(app)) continue;
          if (connectorConnected(app)) { s.found[source] = { ...s.found[source], [app]: { reach: 'connector', survey: 'running' } }; dispatch(s, { kind: 'survey', source, apps: [app], label: `Looking through ${shownName(app)}` }); } else { s.held.set(app, { source, recall: false }); signInCard(s, app, 'connector'); }
        }
      }
    }
    logAction(s, null, 'Picked up again after Engelbart closed');
    emit(s);
    pump(s);
    if (!s.chat.length && !s.jobs.length) {
      // closed before the librarian's first word: the opening again
      s.thinking = true;
      s.activity = 'Looking at what you picked…';
      void opening(s);
    } else if (s.choices.direct) {
      if (!s.finished) void directOpening(s); // Import your context has no librarian: the imports not queued yet are
    } else if (grantOpen) {
      void afterGrant(s); // the librarian goes on (or starts) once the person has said which apps it may reach
    } else if (!s.done && !s.finished) {
      const last = s.chat[s.chat.length - 1];
      if (!last) void interviewTurn(s, 'Start.');
      else if (last.role === 'user') void interviewTurn(s, `${line(last.text, 2000)} (Engelbart closed before you answered this. Answer it now.)`);
      else if (saved.thinking || (s.waitingForSurvey && !surveying(s))) void interviewTurn(s, 'Engelbart closed while you were working, and has opened again. What the surveys found is in <found>. Go on from where you were.');
    }
    maybeMemory(s);
    return s;
  }

  /**
   * "if i close engelbart and it hasnt finish it should auto-resume" (2026-10-08): the sessions of this library that were
   * still going when Engelbart closed (or switched library) start again where they were, in the background: the jobs that
   * were running or queued are queued again (an import skips what came in before), a librarian turn that had not answered
   * is asked again, and MEMORY.md is written once everything has ended. Once per library each time it is opened. → how many
   */
  function resume(ctx) {
    if (!ctx || !ctx.dataRoot || resumed.has(ctx.dataRoot)) return 0;
    resumed.add(ctx.dataRoot);
    let names = [];
    try { names = fs.readdirSync(path.join(ctx.dataRoot, '.connect')).filter((name) => ID_RE.test(name)); } catch { return 0; }
    let n = 0;
    for (const id of names) {
      if (sessions.has(id)) continue;
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(path.join(ctx.dataRoot, '.connect', id, 'session.json'), 'utf8')); } catch { continue; }
      if (!unfinished(saved)) continue;
      try { revive(ctx, id, saved); n += 1; } catch { sessions.delete(id); }
    }
    return n;
  }

  /** The sessions of a data root that are not dismissed, newest first (the dock, a window that opens later). */
  function list(dataRoot) {
    return [...sessions.values()].filter((s) => !s.dismissed && (!dataRoot || s.dataRoot === dataRoot)).sort((a, b) => String(b.created).localeCompare(String(a.created))).map(snapshot);
  }

  /** What the choose screen offers: the providers that can run now, each with its pinned model. */
  function providers() {
    const usable = readyNow();
    return PROVIDERS.map((provider) => { const choice = choiceFor(provider); return { provider, name: PROVIDER_NAMES[provider], modelName: choice.modelName, effort: choice.effort, ready: usable.includes(provider) }; });
  }

  /** A connector's sign-in the person gave up on: the chat goes on. */
  function cancelSignIn(id, app) {
    get(id);
    if (connectors && typeof app === 'string') connectors.cancel(app);
    return true;
  }

  /**
   * A data root wiped (test mode's reset, 2026-10-15: its runs stayed listed, popups and all, and sign-ins checked before
   * were taken as answered): its sessions stopped and dropped, and every sign-in answer kept in memory forgotten.
   */
  function forget(dataRoot) {
    for (const [id, s] of [...sessions]) {
      if (s.dataRoot !== dataRoot) continue;
      s.stopped = true;
      for (const controller of s.controllers) { try { controller.abort(); } catch { /* ended */ } }
      if (s.interviewController) { try { s.interviewController.abort(); } catch { /* ended */ } }
      for (const need of s.needs) { if (need.watch) clearInterval(need.watch); if (need.cancel) { try { need.cancel(); } catch { /* none */ } } }
      if (browser) for (const job of s.jobs) browser.close(job.id);
      sessions.delete(id);
    }
    resumed.delete(dataRoot);
    signInChecked.clear();
    signInChecking.clear();
    signInDenied.clear();
  }

  return {
    forget,
    start, answer, grant, authorize, importNow, need, stop, stopJob, suspendAll, resume, retryMemory, unblock, setMinimized, dismiss, attachProject, windowClosed, logJob, list, providers, cancelSignIn, signInNote, signInCheck, signInWindowOpen, signInWindowClose, signInBrowser, signInBrowserCancel, signInUnlock, signInAnotherAccount, signInPick,
    setProvider: (id, provider) => { const s = get(id); setProvider(s, provider); emit(s); return snapshot(s); },
    // the first build's name for authorize
    connected: (id, input) => authorize(id, input),
    state: (id) => snapshot(get(id)), has: (id) => sessions.has(id),
  };
}

module.exports = { createConnect, cleanChoices, memoryJobs, projectBlock, optionOf, readReply, readSurvey, messageOf, shownOf, connectChoice, CONNECT_MODELS, PROVIDER_NAMES, PRIORITY, MAX_RUNNING };
