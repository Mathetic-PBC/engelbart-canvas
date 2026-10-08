'use strict';

// Connect your library (2026-10-07; Claude Design "Connect Library.dc.html", the "Onboarding brainstorm" note): the kinds
// of thing the person can bring into their library and the apps each comes from, as the choose screen lists them. Shared
// by main (src/main/connect: what is looked for on this Mac, how an app is reached) and the renderer (the list itself).
// Experimental: onboarding shows it only in test mode.
//
// `reach` says how an import agent gets at an app:
//   local   Engelbart reads where the app keeps its files on this Mac (found: `where`)
//   signin  Engelbart's own sign-in (Zotero, GitHub), started from a button in the chat
//   export  the person exports from the app and chooses the file or folder (a button in the chat says how)
// `pick` is what that button chooses: 'folder', or 'file' (a .json or .zip export).

const SOURCES = Object.freeze([
  { id: 'notes', label: 'Notes', apps: ['Obsidian', 'Notion', 'Apple Notes', 'OneNote', 'Google Docs', 'Evernote'] },
  { id: 'transcripts', label: 'Meeting transcripts', apps: ['Granola', 'Google Meet', 'Zoom'] },
  { id: 'chats', label: 'AI chats', apps: ['ChatGPT', 'Codex', 'Claude', 'Claude Code', 'Grok', 'Gemini', 'Perplexity', 'Cursor'] },
  { id: 'sites', label: 'Websites', apps: [] },
  { id: 'papers', label: 'Papers', apps: ['Zotero', 'Overleaf'] },
  { id: 'code', label: 'Code', apps: [] },
]);

const APPS = Object.freeze({
  Obsidian: { reach: 'local', pick: 'folder', how: 'Choose the vault folder.' },
  Notion: { reach: 'export', pick: 'folder', how: 'In Notion: Settings → Export all workspace content, Markdown & CSV. Unzip it and choose the folder.' },
  'Apple Notes': { reach: 'export', pick: 'folder', how: 'Apple Notes keeps its notes in a locked database. Export them to a folder (File → Export, or an exporter app) and choose it.' },
  OneNote: { reach: 'export', pick: 'folder', how: 'Export your notebooks (File → Export) to a folder and choose it.' },
  'Google Docs': { reach: 'local', pick: 'folder', how: 'Choose your Google Drive folder (Google Drive for desktop), or a Google Takeout export.' },
  Evernote: { reach: 'export', pick: 'folder', how: 'Export your notebooks as Markdown or .enex to a folder and choose it.' },
  Granola: { reach: 'export', pick: 'folder', how: 'Granola encrypts what it keeps on this Mac. Copy the transcripts you want into a folder and choose it.' },
  'Google Meet': { reach: 'export', pick: 'folder', how: 'Meet saves transcripts as Google Docs in Drive → Meet Recordings. Choose that folder in your Google Drive folder.' },
  Zoom: { reach: 'local', pick: 'folder', how: 'Choose the folder Zoom saves recordings and transcripts to (usually ~/Documents/Zoom).' },
  ChatGPT: { reach: 'export', pick: 'file', how: 'In ChatGPT: Settings → Data controls → Export data. Choose the .zip it emails you, or its conversations.json.' },
  Codex: { reach: 'local', pick: 'folder', how: 'Codex keeps its sessions in ~/.codex/sessions.' },
  Claude: { reach: 'export', pick: 'file', how: 'In Claude: Settings → Privacy → Export data. Choose the .zip it emails you, or its conversations.json.' },
  'Claude Code': { reach: 'local', pick: 'folder', how: 'Claude Code keeps its sessions in ~/.claude/projects.' },
  Grok: { reach: 'export', pick: 'file', how: 'Export your Grok data (Settings → Data) and choose the file.' },
  Gemini: { reach: 'export', pick: 'folder', how: 'Export Gemini Apps activity with Google Takeout and choose the folder.' },
  Perplexity: { reach: 'export', pick: 'folder', how: 'Export threads you want as Markdown to a folder and choose it.' },
  Cursor: { reach: 'export', pick: 'folder', how: 'Export the chats you want as Markdown to a folder and choose it.' },
  Zotero: { reach: 'signin', pick: null, how: 'Sign in to Zotero; Engelbart keeps a copy of your library to read.' },
  Overleaf: { reach: 'export', pick: 'folder', how: 'Download your projects (Menu → Download → Source) and choose the folder they are in.' },
  GitHub: { reach: 'signin', pick: null, how: 'Sign in to GitHub to choose repositories.' },
});

const SOURCE_IDS = Object.freeze(SOURCES.map((source) => source.id));
const sourceOf = (id) => SOURCES.find((source) => source.id === id) || null;
const appOf = (name) => (Object.hasOwn(APPS, name) ? APPS[name] : null);

module.exports = { SOURCES, APPS, SOURCE_IDS, sourceOf, appOf };
