# Connect your library — design source and decisions

Design: Claude Design project 851be0e2-50a6-4398-88cd-95a55569d586, file `Connect Library.dc.html` (bundled export
`~/Desktop/Mathetic, PBC/Design/Connect Library.html`, read 2026-10-07). The component's markup and script are kept here
as `Connect Library.dc.html`; the shared tokens it imported are the app's own (`src/renderer/styles.css`). Its logos are
in `design/assets/logos/`, named as the design names them. Brief: the "Onboarding brainstorm" note (Agent onboarding
workspace).

Implemented in `src/renderer/screens/ConnectLibrary.jsx` (+ `src/renderer/model/connect.js`) and `src/main/connect/`.
Experimental: onboarding shows it only in test mode (App.jsx passes `connect={config.testMode}`; main refuses every
`connect-*` call outside test mode), between the tools screen and Add to your library.

What the design mocked and what is real now:
- Choose: the sources and apps are the design's (`src/shared/connect-sources.cjs`). Instead of the design's fixed ticks,
  an app starts ticked when it is found on this Mac (Obsidian's vaults, ~/.claude/projects, ~/.codex/sessions, a
  Chromium browser, a Zotero or GitHub sign-in). "Select a folder…" and "Select repositories…" are real pickers (GitHub's
  list needs its sign-in, started from the row). "Allow agents to use my computer": the agents' file tools may read the
  whole home folder; unticked, only the folders of the picked sources. Nothing ever controls the screen: every agent runs
  hidden, in the background.
- Refine: the design's scripted questions are a real agent, the librarian (`src/main/connect/prompts.cjs`), shown what was
  found (vault folders with counts and the daily-notes folder, Zotero collections, chat counts and recent titles, top
  sites). Its questions are single choice (chips), multiple choice (chips that tick, then Continue) or open (the reply
  box), and it asks only what changes what comes in. Its buttons sign in (Zotero, GitHub) or choose a folder or an export
  (Claude and ChatGPT exports, Notion and other exports). As soon as a source is settled it hands it to an import agent,
  which starts at once in the background (two at a time); the chat shows their progress under its header.
- Import: every picked source not yet handed over goes now with sensible defaults; the list follows each import
  (queued, importing… n added, ✓ n added) with what it is doing. Done moves onboarding on; imports keep running.
- Notes (Obsidian and other Markdown) come in one note per file with the same title, pictures saved into the project,
  `[[links]]` as mentions. Onboarding has no project yet at this point, so notes are held in
  `<dataRoot>/.connect/<session>/notes/` and written into the project when Open project makes it.
- The model chip opens the same selector as @bart's and Build's (BartPicker), on Build's models; both agents run on it.
