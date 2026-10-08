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

const SOURCE_IDS = Object.freeze(SOURCES.map((source) => source.id));
const sourceOf = (id) => SOURCES.find((source) => source.id === id) || null;
const appOf = (name) => (Object.hasOwn(APPS, name) ? APPS[name] : null);
/** The source an app is listed under ('notes' for Obsidian), or null. GitHub is Code's. */
const sourceOfApp = (name) => (name === 'GitHub' ? 'code' : (SOURCES.find((source) => source.apps.includes(name)) || {}).id || null);
/** The AI assistants an agent can ask for what they remember, of `apps`. */
const recallApps = (apps) => (Array.isArray(apps) ? apps : []).filter((app) => appOf(app) && appOf(app).memory);
/** The apps reached on the web, of `apps`. */
const webApps = (apps) => (Array.isArray(apps) ? apps : []).filter((app) => appOf(app) && appOf(app).reach === 'web');

module.exports = { SOURCES, APPS, LOCAL_PDFS, SIGN_IN_SITES, SOURCE_IDS, sourceOf, appOf, sourceOfApp, recallApps, webApps };
