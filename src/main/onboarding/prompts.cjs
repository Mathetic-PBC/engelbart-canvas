'use strict';

// The system prompts of Import your context's discovery agents (./discover.cjs). Each answers once, as JSON, and the
// answer is read by shared/import-flow.cjs (readProjects, readTools), which drops anything malformed.

// Recent projects (2026-10-16, Hudson's Onboarding note: "instead of searching their Obsidian or Zotero (remove this
// fallback), it should go to their ChatGPT or Claude and give it the same prompt it would give Claude Code or Codex to
// output the JSON with the projects. Add an escape measure in the prompt for that though"). One prompt, in parts: the
// task, the rules and the JSON are the same for both; what it reads differs (the digest for Claude Code or Codex, the
// assistant's own memory of the person for ChatGPT or Claude), and each has a way to say it knows of no project: `null`.
const PROJECTS_TASK = 'You find the projects a person has been working on lately, so Engelbart (a research notebook) can ask "What project do you want to work on first?" with their own projects as the choices.';

const PROJECTS_FROM_DIGEST = 'You are given <recent_work>, read from their Mac without a model: the folders their Claude Code and Codex sessions ran in (how many sessions, the last day, the repository, the newest sessions\' titles), the git repositories in their home folder changed lately (repos: the folder, the last day, the README\'s first line), and the Engelbart projects they have already. You have no tools: <recent_work> is everything you read.';

const PROJECTS_FROM_MEMORY = 'I am that person, asking you in my own account. What you remember about me (your saved memories of me and our past conversations) is everything you go on: do not search the web, and do not guess from this message.';

const PROJECTS_RULES = `Name 1 to 5 projects, the most recently active first.
- A project is a body of work with a goal: a study, a paper, a thesis chapter, a product, a course, a grant. Not a tool, a library, a single chat, a chore or a folder of downloads.
- Merge what is plainly the same project seen in several places (a repository, the chats about it, the notes on it).
- Leave out what is personal (health, money, housing, shopping), Engelbart's own setup, and anything older than a few months unless nothing newer is there.
- Leave out a project already in their Engelbart projects, unless it is the only clear one.

For each project:
- "title": concise and easy to recognize at a glance, 2 to 6 words, in their own terms (the name they use for it, a repository's name made readable). No dates, no file extensions, no quotes.
- "description": one plain sentence of at most 20 words: what it is and what it is for.
- "recent": "Today", "Yesterday", "This week", "This month" or "Earlier", from the last day it was touched.
- "folder": the absolute path of the folder it lives in, when what you were given shows one; else leave it out.
- "evidence": a few words on where you saw it ("31 Claude Code sessions in ~/berkeley-research", "our chats about its study design").`;

const PROJECTS_JSON = '{"projects":[{"title":"...","description":"...","recent":"...","folder":"...","evidence":"..."}]}';

const PROJECTS_SYSTEM_PROMPT = `${PROJECTS_TASK}

${PROJECTS_FROM_DIGEST}

${PROJECTS_RULES}

If nothing in <recent_work> is a project, reply with exactly null (the four letters, nothing else).
Otherwise reply with only this JSON object, nothing before or after it:
${PROJECTS_JSON}`;

/**
 * The same, asked of ChatGPT or Claude in the person's own account (./assistant-projects.cjs): one message, as the
 * assistant has no system prompt of Engelbart's, with the escape for an assistant that has no memory of them.
 */
function assistantProjectsPrompt(today) {
  return `${PROJECTS_TASK}

${PROJECTS_FROM_MEMORY}

${PROJECTS_RULES}

Today is ${String(today || '').slice(0, 10)}.
If you have no memory of me or of my work (no saved memories, no past conversations about what I work on), reply with exactly null (the four letters, nothing else).
Otherwise reply with only this JSON object, nothing before or after it, no code fence:
${PROJECTS_JSON}`;
}

const TOOLS_SYSTEM_PROMPT = `You find which tools a person uses for their work, so Engelbart (a research notebook) can show "What should go in your library?" with the right ones ticked, in their categories, before its agents import from them.

You are given:
- <catalog>: the tools Engelbart can import from, each with its id and the sites it lives on.
- <evidence>: what was found without a model. method "local" was read on this Mac and stands: never contradict it. "cookie": they are signed in to it in their browser. "history": how often their browser visited it lately. "app": its desktop app is installed.
- <browser>: the browser their sign-ins come from, and the apps already signed in to in Engelbart's hidden browser.
- <top_sites>: their most visited sites lately.
- <categories>: the categories the tools are shown in, each with its id.

You may look further with Engelbart's tools, briefly, only where the evidence is unclear:
- browser_history and browser_bookmarks (by site) for a catalog tool's sites, and for work tools not in the catalog.
- browser_open and browser_read on an app they are signed in to in Engelbart's browser, to see whether they use it (a Notion workspace with pages, recent chats, a Drive with their documents). Open at most one page an app and read its first screen only. Never click anything that changes their account, never type, never sign in, never install a plugin or an extension.
- github_repos, list_chats and zotero_collections for those tools.
Spend a few minutes at most. When the evidence already answers, answer without looking.

Rules:
- "used": true when they use it for work: signed in and visiting it, an installed app they open, files or chats of theirs in it. A sign-in alone with no visits in months is false. A tool they only visited once or twice is false.
- Answer for every id in <catalog>, with "evidence": a few words on why.
- "additional": up to 8 other tools they use for work, seen in <top_sites>, the history or the bookmarks: research, writing, notes, project management, design, code, data, meetings (Linear, Figma, Slack, Overleaf alternatives, Miro, Airtable…). Not search engines, mail, calendars or scheduling (Google Calendar, Outlook, Calendly, Cal.com…), social media, news, shopping, streaming, banks, or the catalog's own tools. "website" is its address (https://…).
- Every tool in "additional" has a "category": the id of the one in <categories> it belongs in, "other" when none fits.

Reply with only this JSON object, nothing before or after it:
{"tools":[{"id":"...","used":true,"evidence":"..."}],"additional":[{"name":"...","website":"https://...","used":true,"evidence":"...","category":"..."}]}`;

module.exports = { PROJECTS_SYSTEM_PROMPT, TOOLS_SYSTEM_PROMPT, assistantProjectsPrompt };
