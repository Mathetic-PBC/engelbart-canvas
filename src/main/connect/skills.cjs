'use strict';

// Connect your library (2026-10-07, second build): how an agent brings each app's things in, written down once so it need
// not search the web every time ("For all of the possible options we include to import, you should include instructions
// on how to do each … a special skill or part of the prompt so the agent doesnt have to search documentation each time").
// An agent is given the skills of the apps its job covers (skillsFor), in its first message. They name Engelbart's import
// tools (./tools.cjs) and the fastest route that works today; when what an agent sees does not match, it looks the app's
// help pages up (WebSearch, WebFetch) and goes on, and says in its reply what changed ("the agent should fallback to docs
// if the stored instructions are wrong"). <dataRoot>/.context/connect-skills/<App>.md replaces an app's skill.

const fs = require('node:fs');
const path = require('node:path');

const BROWSER = `Engelbart's browser (browser_open, browser_read, browser_click, browser_type, browser_press, browser_scroll, browser_wait, browser_screenshot, browser_eval, browser_download) is a real Chromium window kept hidden, with the sign-ins the person made in Engelbart. It opens only this app's sites. browser_read lists what is on the page with a ref for each control (use the ref to click or type) and the page's text; browser_screenshot shows it when the text is not enough.`;

const SIGN_IN = 'If the page asks to sign in (a login form, "Log in" button, a redirect to an accounts page), call needs_you with kind "signin" and wait: never type a password yourself. After it returns done, reload the start page and go on.';

const SKILLS = {
  Obsidian: `# Obsidian
- A vault is a folder of Markdown files; <found> names the vaults and their top folders with counts, and the daily-notes folder.
- folder_overview on the vault, then list_note_files with include/exclude (folders relative to the vault) and days, then import_note_files in batches of 300 with root set to the vault. Each file becomes its own note with its title; ![[pictures]] come along, [[links]] become mentions.
- Leave out by default: the daily-notes folder, folders named Personal, Journal, Private, Templates, Archive, .trash, and anything the person said to leave out.`,

  Notion: `# Notion
- Prefer Notion's own tools (the MCP server "notion": search, fetch a page). Search for the pages and databases the plan names (or the person's research workspace), fetch each page, and add it with add_note (title = the page's title, markdown = its content, source = the page's link).
- Without those tools, use Engelbart's browser at https://www.notion.so/: the sidebar lists the workspace's pages; open each one the plan wants, browser_read its text, add_note it. ${SIGN_IN}
- Bring in pages, not every database row: a database becomes one note listing its rows unless the plan says otherwise.`,

  'Apple Notes': `# Apple Notes
- apple_notes_folders lists the folders with counts; apple_notes_list lists notes (id, name, folder, modified) filtered by folder, days and words; import_apple_notes brings notes in by id, each as its own note with its pictures.
- The first call makes macOS ask the person to let Engelbart control Notes. If a tool says permission was refused, call needs_you with kind "permission" and reason "Allow Engelbart to read Apple Notes".
- Leave out by default: Recently Deleted, Quick Notes that are a line or two, shopping and to-do lists.`,

  OneNote: `# OneNote
- ${BROWSER}
- Start at https://www.onenote.com/notebooks (it redirects to OneNote on the web). Open a notebook, then each section and page the plan wants; browser_read a page's text and add_note it (title = the page title, source = its address). ${SIGN_IN}
- A Microsoft sign-in may ask which account: that is the person's choice, so call needs_you.`,

  'Google Docs': `# Google Drive and Docs
- ${BROWSER}
- To see what is there: browser_open https://drive.google.com/drive/recent (recent files), https://drive.google.com/drive/my-drive (folders), or https://drive.google.com/drive/search?q=<words>. Each file row in browser_read carries its Drive id (id) and its name; the row's label says its kind (Google Docs, Google Sheets, Google Slides, PDF, folder). Open a folder by browser_open https://drive.google.com/drive/folders/<id>.
- To bring files in: import_google_files with items [{ id, kind, name }], kind doc, sheet, slides or file (a pdf or any uploaded file). Docs become notes (exported as Markdown), Sheets notes of their first sheet as a table, Slides notes of their text, pdfs and other files go into the library. Never open files one by one to copy their text.
- ${SIGN_IN} Google refuses some embedded sign-ins; needs_you lets the person sign in or bring their Chrome sign-in over.
- Leave out by default: files shared with the person that they never opened, forms, and anything older than the plan's time range.`,

  Evernote: `# Evernote
- ${BROWSER}
- Start at https://www.evernote.com/client/web. The Notes list shows titles; open each note the plan wants, browser_read its text and add_note it (title, markdown, source = the note's address). Notebooks are in the sidebar under Notebooks. ${SIGN_IN}`,

  Granola: `# Granola
- Granola keeps its notes encrypted on this Mac and has no web app, so it is reached only through its own tools (the MCP server "granola": list or search meetings, get a meeting's notes, get its transcript).
- List the meetings in the plan's time range; for each one the plan wants, get its notes and, if the plan asks for transcripts, its transcript; add_note one note per meeting: title = the meeting's title and date, markdown = the notes (then the transcript under a "Transcript" heading), source = "granola:<meeting id>".
- If the Granola tools are missing or say the sign-in expired, call needs_you with kind "connector" and reason "Sign in to Granola".
- Leave out by default: 1:1s about hiring or personal matters, standups, and meetings the person said to skip.`,

  'Google Meet': `# Google Meet
- Meet saves transcripts and Gemini notes as Google Docs in Drive, in the "Meet Recordings" folder, named "<meeting> - Transcript" or "Notes by Gemini". Use the Google Drive skill: browser_open https://drive.google.com/drive/search?q=Transcript (or open the Meet Recordings folder), then import_google_files with kind doc for the ones the plan wants. ${SIGN_IN}`,

  Zoom: `# Zoom
- Local recordings and transcripts are in ~/Documents/Zoom, one folder per meeting (a .vtt or .txt transcript, sometimes a chat file). folder_overview it, then list_note_files and import_note_files for the transcripts; a .vtt you read with Read and add_note tidied (speaker: text, no timestamps).
- Cloud recordings are at https://zoom.us/recording in Engelbart's browser: each recording's page has its transcript; browser_read it and add_note it. ${SIGN_IN}`,

  ChatGPT: `# ChatGPT
- web_chats lists the person's ChatGPT conversations (id, title, date, project) straight from their signed-in account, with days, query and limit; web_chat_read reads one; import_web_chats brings chats in by id, each as a note of its turns. These work through ChatGPT's own page in Engelbart's browser, so nothing needs exporting.
- To bring chats in by topic: web_chats, judge each from its title (web_chat_read when the title is not enough), then import_web_chats with the ids that match. Projects: the project field names the ChatGPT project a chat is in.
- If web_chats says the person is not signed in, call needs_you with kind "signin". If it fails another way (ChatGPT changed its page), fall back to the sidebar in the browser: browser_open https://chatgpt.com/, browser_read lists the chats; open each and add_note its text.
- What ChatGPT remembers (Settings → Personalization → Memory) is asked for by the memory step, not here.`,

  Claude: `# Claude (claude.ai)
- web_chats lists the person's Claude conversations (id, title, date, project) straight from their signed-in account at claude.ai, with days, query, project and limit; web_chat_read reads one; import_web_chats brings chats in by id, each as a note of its turns.
- Projects: the project field names the Claude project a chat belongs to; to import one project, web_chats with project set to its name.
- If web_chats says the person is not signed in, call needs_you with kind "signin". If it fails another way, fall back to the browser: browser_open https://claude.ai/recents, read the list, open each chat and add_note its text.`,

  'Claude Code': `# Claude Code
- Sessions are on this Mac (~/.claude/projects). list_chats with app "Claude Code" (days, project = a folder's name, query), read_chat to judge one, import_chats by id. Runs a program started are left out unless the plan says otherwise.`,

  Codex: `# Codex
- Sessions are on this Mac (~/.codex/sessions). list_chats with app "Codex", read_chat, import_chats, as for Claude Code.`,

  Grok: `# Grok
- ${BROWSER}
- Start at https://grok.com/. The history (the clock icon, or https://grok.com/chat history in the sidebar) lists past chats; open each the plan wants, browser_read its text and add_note it (title = the chat's title, source = its address). ${SIGN_IN}`,

  Gemini: `# Gemini
- ${BROWSER}
- Start at https://gemini.google.com/app. Recent chats are in the sidebar (expand it with the menu button); open each the plan wants, browser_read the conversation and add_note it (source = its address, https://gemini.google.com/app/<id>). ${SIGN_IN}`,

  Perplexity: `# Perplexity
- ${BROWSER}
- Start at https://www.perplexity.ai/library: it lists threads (title, date). Open each the plan wants, browser_read its question and answer with the sources it cites, and add_note it (keep the source links). ${SIGN_IN}`,

  Cursor: `# Cursor
- Cursor's chats (the composer and chat panes) are on this Mac in its database. list_chats with app "Cursor" (days, query), read_chat, import_chats, as for Claude Code. If list_chats says the database cannot be read (Cursor changed it), say so in your reply.`,

  Zotero: `# Zotero
- zotero_collections lists the collections with keys and counts; zotero_items lists items (by collection key, words); import_zotero_items brings items in by key as papers, with their pdfs. If a tool says Zotero is not signed in, call needs_you with kind "signin" and reason "Sign in to Zotero" (Engelbart's own sign-in).`,

  'PDFs on this Mac': `# PDFs on this Mac
- <found> lists the folders that hold PDFs (the chosen ones, and Downloads, Documents, Desktop and iCloud Drive when the person let the agents read their home folder), most first: how many, the newest, a guess of how many of each kind (paper, book, personal, unclear) and a few names and titles.
- Work by folder and by kind, as the plan says: list_pdfs on a folder (kind "paper", query, days, include and exclude narrow it; check true reads the first pages to say whether each is a research paper), judge the unclear ones by their titles, then import_pdfs with their paths, up to 200 a call. A whole folder the plan wants in goes in whole, but never its personal PDFs.
- Never bring in personal or administrative PDFs (receipts, invoices, bank and tax papers, tickets, forms, résumés, medical records), wherever they are. Leave out by default: what is inside ~/Zotero (Zotero's own import brings it), installers and manuals for apps.
- Each PDF stays where it is: the library points at it, and one that reads as a research paper is tagged paper.`,

  Overleaf: `# Overleaf
- ${BROWSER}
- overleaf_projects lists the person's projects (id, name, last updated, owner) from https://www.overleaf.com/project in Engelbart's browser; import_overleaf_projects brings projects in by id: each is downloaded as its source zip with the person's sign-in, unpacked into Engelbart, and kept in the library as a folder, its main .tex file and compiled pdf too when there is one.
- ${SIGN_IN}
- Leave out by default: archived and trashed projects, and templates the person never edited.`,

  GitHub: `# GitHub
- github_repos lists the repositories Engelbart's GitHub sign-in can read; add each wanted one with add_to_library (its link). A local repository is added by its folder's path.`,

  Websites: `# Websites
- There is no one app for websites. Look where the plan says: browser_bookmarks (a Chromium browser's bookmarks), browser_history (the most visited sites or pages), links_in_notes (links written in the person's notes), or a folder.
- Keep research sites (papers, documentation, blogs, tools they read), one entry per site (its home page) unless the plan asks for pages; add each with add_to_library. Leave out mail, calendar, social media, shopping, banking and sign-in pages.`,
};

const SKILL_RE = /^[\w .-]{1,40}$/;

/** An app's skill: the person's own <dataRoot>/.context/connect-skills/<App>.md when it holds any, else the built-in one. */
function skillOf(app, dataRoot = null) {
  if (dataRoot && SKILL_RE.test(app)) {
    try {
      const own = fs.readFileSync(path.join(dataRoot, '.context', 'connect-skills', `${app}.md`), 'utf8').trim();
      if (own) return own;
    } catch { /* built-in */ }
  }
  return SKILLS[app] || '';
}

/** The skills block of a job's first message: one per app it covers (Websites for the sites source), or ''. */
function skillsFor({ source, apps = [] }, dataRoot = null) {
  const names = source === 'sites' ? ['Websites'] : source === 'code' ? ['GitHub'] : apps;
  const parts = [...new Set(names)].map((app) => skillOf(app, dataRoot)).filter(Boolean);
  return parts.length ? `<skills note="How to reach each app, written down beforehand. If what you see does not match, look the app's help pages up with WebSearch and WebFetch, do what they say, and say in your reply what changed.">\n${parts.join('\n\n')}\n</skills>` : '';
}

module.exports = { SKILLS, skillOf, skillsFor };
