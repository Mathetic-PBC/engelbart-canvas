'use strict';

// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html", the "Onboarding brainstorm" note): the kinds
// of thing the person can bring into their library and the apps each comes from, as the choose screen lists them. Shared
// by main (src/main/connect: what is looked for on this Mac, how an app is reached) and the renderer (the list itself).
// In every library since 2026-10-08 (test mode's only until then).
//
// `reach` says how the agents get at an app. Since the second build ("Agent onboarding", 2026-10-07: "Instead of telling
// me to do stuff, it must use computer use to do all this stuff for me!") the person is never told to export, download
// or choose a file for an app that lives on the web; the agents do it:
//   local       files on this Mac. `pick` ('folder') is what a button chooses when they are not where the app keeps them
//   web         the agents' own browser, hidden, on the sign-ins of Engelbart's Stage (src/main/connect/browser.cjs).
//               `sites` are the only hosts it opens for the app (sign-in pages: SIGN_IN_SITES), `start` where it begins
//   connector   the app's official MCP server, which Engelbart signs in to with OAuth (src/main/connect/connectors.cjs);
//               `mcp` is its address
//   signin      Engelbart's own sign-in (Zotero, GitHub)
//   automation  macOS Automation: Engelbart asks the app itself, which macOS asks the person to allow once (Apple Notes)
// `memory`: an AI assistant that keeps memories of the person. With their leave, an agent asks it for a research profile
// (src/main/connect/prompts.cjs RECALL_PROMPT), which goes into MEMORY.md.
// LOCAL_PDFS (2026-10-08, "Agent onboarding": "add capability to search local papers ... the questions for this should
// center around folders and genres of papers rather than individual ones"): the PDFs in the person's own folders
// (Downloads, Documents, Desktop, iCloud Drive…), looked through by folder (src/main/connect/readers.cjs pdfFolders).

const LOCAL_PDFS = 'PDFs on this Mac';

const SOURCES = Object.freeze([
  { id: 'notes', label: 'Notes', apps: ['Obsidian', 'Notion', 'Apple Notes', 'OneNote', 'Google Docs', 'Evernote'] },
  { id: 'transcripts', label: 'Meeting transcripts', apps: ['Granola', 'Google Meet', 'Zoom'] },
  { id: 'email', label: 'Email', apps: ['Gmail'] },
  { id: 'chats', label: 'AI chats', apps: ['ChatGPT', 'Codex', 'Claude', 'Claude Code', 'Grok', 'Gemini', 'Perplexity', 'Cursor'] },
  { id: 'sites', label: 'Websites', apps: [] },
  { id: 'papers', label: 'Papers', apps: ['Zotero', 'Overleaf', LOCAL_PDFS] },
  { id: 'code', label: 'Code', apps: [] },
]);

const GOOGLE = ['drive.google.com', 'docs.google.com', 'accounts.google.com', 'myaccount.google.com', 'www.google.com', 'google.com'];

const APPS = Object.freeze({
  Obsidian: { reach: 'local', pick: 'folder' },
  Notion: { reach: 'connector', mcp: 'https://mcp.notion.com/mcp', sites: ['notion.so', 'notion.com'], start: 'https://www.notion.so/' },
  'Apple Notes': { reach: 'automation' },
  OneNote: { reach: 'web', sites: ['onenote.com', 'onenote.cloud.microsoft', 'office.com', 'live.com', 'microsoft.com', 'microsoftonline.com', 'sharepoint.com'], start: 'https://www.onenote.com/notebooks' },
  'Google Docs': { reach: 'web', sites: GOOGLE, start: 'https://drive.google.com/drive/recent' },
  Evernote: { reach: 'web', sites: ['evernote.com'], start: 'https://www.evernote.com/client/web' },
  Granola: { reach: 'connector', mcp: 'https://mcp.granola.ai/mcp' },
  'Google Meet': { reach: 'web', sites: [...GOOGLE, 'meet.google.com'], start: 'https://drive.google.com/drive/search?q=type:document%20Meet%20Recordings' },
  Zoom: { reach: 'local', pick: 'folder', sites: ['zoom.us'] },
  // Gmail (2026-10-11): the same Google sign-in as Google Docs. Never brought in whole: the librarian searches it, lists
  // the threads, and only the ones the person approves come in (main/connect/tools.cjs gmail_*).
  Gmail: { reach: 'web', sites: [...GOOGLE, 'mail.google.com'], start: 'https://mail.google.com/mail/' },
  ChatGPT: { reach: 'web', sites: ['chatgpt.com', 'chat.openai.com', 'openai.com'], start: 'https://chatgpt.com/', memory: true },
  Codex: { reach: 'local' },
  Claude: { reach: 'web', sites: ['claude.ai', 'claude.com', 'anthropic.com'], start: 'https://claude.ai/recents', memory: true },
  'Claude Code': { reach: 'local' },
  Grok: { reach: 'web', sites: ['grok.com', 'x.ai', 'x.com'], start: 'https://grok.com/', memory: true },
  Gemini: { reach: 'web', sites: ['gemini.google.com', ...GOOGLE], start: 'https://gemini.google.com/app', memory: true },
  Perplexity: { reach: 'web', sites: ['perplexity.ai'], start: 'https://www.perplexity.ai/library' },
  Cursor: { reach: 'local' },
  Zotero: { reach: 'signin' },
  Overleaf: { reach: 'web', sites: ['overleaf.com'], start: 'https://www.overleaf.com/project' },
  [LOCAL_PDFS]: { reach: 'local', pick: 'folder' },
  GitHub: { reach: 'signin' },
});

// Where a sign-in may take a page on its way back to an app (an agent's browser only goes where its apps' `sites` are).
const SIGN_IN_SITES = Object.freeze(['accounts.google.com', 'appleid.apple.com', 'idmsa.apple.com', 'login.microsoftonline.com', 'login.live.com', 'auth.openai.com', 'auth0.openai.com', 'accounts.x.ai', 'github.com', 'okta.com', 'auth0.com']);

// The cookie that holds each web app's sign-in: the registrable domain it is on, and its name (main/connect/web-signin.cjs).
// Apps with the same entry share one sign-in: Google Drive, Gmail, Google Meet and Gemini are one Google sign-in.
const SIGN_IN_COOKIES = Object.freeze({
  ChatGPT: ['chatgpt.com', /session-token/],
  Claude: ['claude.ai', /^sessionKey$/],
  'Google Docs': ['google.com', /^(__Secure-1PSID|SID)$/],
  'Google Meet': ['google.com', /^(__Secure-1PSID|SID)$/],
  Gmail: ['google.com', /^(__Secure-1PSID|SID)$/],
  Gemini: ['google.com', /^(__Secure-1PSID|SID)$/],
  Overleaf: ['overleaf.com', /^overleaf_session/],
  Perplexity: ['perplexity.ai', /session-token/],
  Grok: ['grok.com', /^sso$/],
  Notion: ['notion.so', /^token_v2$/],
});
/** The sign-in an app shares with others ('google.com SID…' for Gmail and Google Drive alike); an app with none, its own name. */
const signInGroup = (app) => {
  const entry = Object.hasOwn(SIGN_IN_COOKIES, app) ? SIGN_IN_COOKIES[app] : null;
  return entry ? `${entry[0]} ${entry[1].source}` : String(app);
};
/** The apps signed in by the one sign-in `app` makes, itself first. */
const sharesSignIn = (app) => [app, ...Object.keys(SIGN_IN_COOKIES).filter((other) => other !== app && signInGroup(other) === signInGroup(app))];

// What the person is shown for an app whose id says less than it reaches (2026-10-10): 'Google Docs' opens their whole
// Drive (its agent starts at drive.google.com, import_google_files brings in Docs, Sheets, Slides and any file), so it is
// shown as Google Drive. The id stays a key everywhere (APPS, the groups, sign-ins, the scan, skills, logos, picks, saved
// sessions); only what is drawn or said to the person goes through shownName.
const SHOWN_NAMES = Object.freeze({ 'Google Docs': 'Google Drive' });
/** The name the person sees for an app: 'Google Drive' for 'Google Docs', any other app its own. */
const shownName = (app) => (Object.hasOwn(SHOWN_NAMES, app) ? SHOWN_NAMES[app] : app);

const SOURCE_IDS = Object.freeze(SOURCES.map((source) => source.id));
const sourceOf = (id) => SOURCES.find((source) => source.id === id) || null;
const appOf = (name) => (Object.hasOwn(APPS, name) ? APPS[name] : null);
/** The source an app is listed under ('notes' for Obsidian), or null. GitHub is Code's. */
const sourceOfApp = (name) => (name === 'GitHub' ? 'code' : (SOURCES.find((source) => source.apps.includes(name)) || {}).id || null);
// What a library row knows about where it came from (Library Phase B, 2026-10-11). `source`: an app above (GitHub excepted:
// a repository's source is `github`), or one of the four ways something reaches the library without an import:
// `engelbart` (written here), `mac` (a file or folder on this Mac), `web` (an address, or a copy of one), `github` (a
// repository). Null is unknown. `category`: what the row is to the person, whatever its file type; an import's default is
// its group's (GROUP_CATEGORIES), other groups (sites, code) have none.
const ITEM_SOURCES = Object.freeze([...new Set([...SOURCES.flatMap((source) => source.apps), ...Object.keys(APPS).filter((app) => app !== 'GitHub')]), 'engelbart', 'mac', 'web', 'github']);
const ITEM_CATEGORIES = Object.freeze(['chat', 'meeting', 'email', 'note', 'paper', 'repo', 'web', 'data', 'document', 'image', 'file']);
const GROUP_CATEGORIES = Object.freeze({ transcripts: 'meeting', chats: 'chat', email: 'email', notes: 'note', papers: 'paper' });
/** The category an import from `app` gets unless it knows better: its group's ('chat' for Claude), else null. */
const categoryOfApp = (app) => GROUP_CATEGORIES[sourceOfApp(app)] || null;
/** The chat apps (the `chats` group), whose kept chats begin with a `*<App> · <date> · <project>*` line. */
const CHAT_APPS = Object.freeze(sourceOf('chats').apps.slice());
/** The AI assistants an agent can ask for what they remember, of `apps`. */
const recallApps = (apps) => (Array.isArray(apps) ? apps : []).filter((app) => appOf(app) && appOf(app).memory);
/** The apps reached on the web, of `apps`. */
const webApps = (apps) => (Array.isArray(apps) ? apps : []).filter((app) => appOf(app) && appOf(app).reach === 'web');

/** The browsers a web app's sign-in is brought over from (main/connect/web-signin.cjs), as the person is told when they have none of them. */
const READABLE_NAMES = 'Chrome, Brave, Edge, Arc or Firefox';

// How far back an import looks (2026-10-10): picked on Connect your library, kept in the session's choices. null: all time.
const PERIODS = Object.freeze([{ days: 182, label: 'the past 6 months' }, { days: 365, label: 'the past year' }, { days: null, label: 'all time' }]);
const DEFAULT_PERIOD_DAYS = 365;
/** 182 or 365 as they are; anything else is all time (null). */
const cleanDays = (value) => (value === 182 || value === 365 ? value : null);
/** "the past year" for 365, "the past 6 months" for 182, "all time" otherwise. */
const periodName = (days) => (PERIODS.find((period) => period.days === cleanDays(days)) || PERIODS[2]).label;

module.exports = { SOURCES, APPS, LOCAL_PDFS, ITEM_SOURCES, ITEM_CATEGORIES, GROUP_CATEGORIES, CHAT_APPS, categoryOfApp, READABLE_NAMES, SIGN_IN_SITES, SIGN_IN_COOKIES, signInGroup, sharesSignIn, SOURCE_IDS, PERIODS, DEFAULT_PERIOD_DAYS, SHOWN_NAMES, shownName, sourceOf, appOf, sourceOfApp, recallApps, webApps, cleanDays, periodName };
