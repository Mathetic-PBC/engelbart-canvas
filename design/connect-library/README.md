# Connect your library — design source and decisions

Design: Claude Design project 851be0e2-50a6-4398-88cd-95a55569d586, file `Connect Library.dc.html` (bundled export
`~/Desktop/Mathetic, PBC/Design/Connect Library.html`, read 2026-10-07). The component's markup and script are kept here
as `Connect Library.dc.html`; the shared tokens it imported are the app's own (`src/renderer/styles.css`). Its logos are
in `design/assets/logos/`, named as the design names them. Brief: the "Onboarding brainstorm" note and the "Agent
onboarding" workspace.

Implemented in `src/renderer/screens/ConnectLibrary.jsx` (+ `src/renderer/model/connect.js`, `src/renderer/ui/ConnectDock.jsx`)
and `src/main/connect/`. Test mode only until 2026-10-08; since then in every library ("migrate the agent onboarding
features to non-testing, too"), each library with its own sessions, offer and MEMORY.md.

## Second build (2026-10-07, the workspace's feedback)

Where it appears
- New users: welcome → tools → **Connect** → create → context. Connect replaces Add to your library and Custom
  instructions ("replace steps 3 and 4 with this, since it will essentially be the same"; the pager showed Connect as 2,
  Add to your library as 3 and Custom instructions as 4). Its agents bring papers, sites and code in, and MEMORY.md does
  what the custom instructions did. The custom instructions step's prompt lives on as the recall prompt ("for extracting
  memories it should use a similar prompt as in step 5": read as that step, whose prompt is the only one).
- "signing into claude code and/or codex must be done before this step": the tools screen is shown whenever neither agent
  is installed and signed in, each agent's row has Install or Sign in, and Continue waits for one. Skipping it without one
  takes Connect out of the flow and brings the two old steps back.
- Existing users: a popup, once per data root (`.connect/offer.json`), over the workspace they are in; closing it
  dismisses it. Its notes go into that project.

The window
- Choose: the design's sources; GitHub through onboarding's own repository list (`workspace/GithubRepos.jsx`, moved out
  of `Onboarding.jsx`), 320 px tall ("way too cramped vertically"). The card **Agents do all of this for you** is the
  disclaimer and the permission requests: files on this Mac, the person's accounts in the background, asking the AI
  assistants what they remember, Apple Notes (macOS's Automation prompt, asked from an Allow button), the connectors'
  sign-ins, and bringing sign-ins over from Chrome. The chip offers only the provider; the model is shown, not offered.
- Refine: the librarian's questions are cards with one option per line, as @brainstorm's are (round mark for one, square
  for several, the why under each, a field for one's own words, Skip, Submit; a double click on a single choice sends it).
  Its buttons: a connector's sign-in, Engelbart's own (Zotero, GitHub), macOS's permission, a folder for an app on this
  Mac. No button chooses an export or a file for an app on the web any more.
- Needs you: an amber card in the chat and the progress list; Open the sign-in window, Bring over sign-ins from Chrome,
  Done, Skip.
- Import: lower right, outlined grey until the librarian sets done, then blue. The working view follows each job (Stop),
  MEMORY.md (Show, Try again) and the activity log; Stop all; Continue (onboarding) or Run in background (popup). The
  minimize button appears once the questions are done.
- In the background: a chip in the top-right controls, beside the bell (a few words; the whole line is its tooltip):
  Needs you (amber), Your answer, Importing n/m, Memory…, Library ✓ (with ×). The first build's place for it, the bottom
  right, would have sat under the Stage's native page.

What the agents do (src/main/connect)
- Models pinned: Sonnet high (Claude Code) or Sol high (Codex) for the librarian and every agent; no escalation.
- Survey agents look at each web or connector app first and report items with ids; recall agents ask each AI assistant
  for a research profile; import agents bring each settled source in; then one agent writes MEMORY.md and a Claude Sonnet
  agent takes secrets out. Surveys, recalls, imports, MEMORY.md: a priority queue, three at a time.
- "Computer use" is Engelbart's own hidden Chromium window per agent (browser.cjs), never the screen: the brainstorm
  asked for all of it to run in the background, so the agents never need macOS's Accessibility or Screen Recording, and
  their sites, steps and sign-ins are Engelbart's to limit and log. Claude Code's own computer use only runs in an
  interactive session, so it could not have been used by these hidden runs anyway.
- No Google Drive API ("We will not add a Google Drive API yet"): Drive is read in the browser with the person's own
  sign-in; Docs are exported as Markdown by id.
- Granola has no web app and keeps its notes encrypted on the Mac: its official MCP server, with Engelbart's own OAuth
  sign-in, is the way in. Notion's official server likewise.
- Per-app instructions: `skills.cjs`, given to each agent for its apps; the docs when they no longer match.

Not yet tried against real accounts: ChatGPT's and Claude's pages, Google Drive, Overleaf, Granola's and Notion's sign-ins,
the other web apps. The agents and the browser were run for real on scratch data and a page served locally.

## First build (2026-10-07)

- Choose: the sources and apps are the design's (`src/shared/connect-sources.cjs`). Instead of the design's fixed ticks,
  an app starts ticked when it is found on this Mac. "Select a folder…" and "Select repositories…" are real pickers.
- Refine: the design's scripted questions are a real agent, the librarian (`src/main/connect/prompts.cjs`), shown what was
  found (vault folders with counts and the daily-notes folder, Zotero collections, chat counts and recent titles, top
  sites). As soon as a source is settled it hands it to an import agent, which starts at once in the background.
- Import: every picked source not yet handed over goes now with sensible defaults; the list follows each import.
- Notes (Obsidian and other Markdown) come in one note per file with the same title, pictures saved into the project,
  `[[links]]` as mentions. Onboarding has no project yet at this point, so notes are held in
  `<dataRoot>/.connect/<session>/notes/` and written into the project when Open project makes it.
