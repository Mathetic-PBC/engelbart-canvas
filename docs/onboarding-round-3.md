# Onboarding, round 3 (2026-10-13, branch `onboarding`)

Source of truth: the "Onboarding" workspace note (pasted into the session) and the Codex review mockup
`~/Desktop/Codex Readings/Onboarding.html`, whose renderer diff (`/tmp/engelbart-latest-preview/*`) was made against
exactly this branch's `src/renderer/import/ImportFlow.jsx` (sha256 9f60b1e6…). Hudson: "Basically just copy this, except
for the helper window since that requires some pretty advanced and tricky engineering and UX work!"

## Root causes found (with evidence)

| Report | Cause | Evidence |
|---|---|---|
| Mac spinner between screens | `scan.detect`, `scan.localRepos` and the project digest read every Claude Code / Codex session file synchronously on Electron's main process | timed on Hudson's Mac: digest 5.4 s, localRepos 3.9 s, detect 3.8 s (scratch `time-scan.cjs`) |
| OneNote / Gemini ticked though "Not detected" | 1) the quick pass counted Outlook visits on `live.com` as OneNote and the shared `google.com` cookie as Gemini; 2) the renderer only ever added to the selection, so the agent's later `used: false` never unticked them | `.onboarding-preview/root/test/.connect/discovery.json`: `evidence.OneNote = {used: true, "151 visits"}`, `results.OneNote = {used: false, "The visits are to Outlook mail"}` |
| Quit & Reopen does nothing | `before-quit` calls `preventDefault()` on every quit Engelbart didn't start; the app's own relaunch is then dropped because a quit is pending | `index.cjs` before-quit / `requestQuit` |
| Sign-ins open in Engelbart's window (Notion) | Notion is `reach: 'connector'`, so `webSignIn.supports()` is false and `need()` falls through to `showWindow` | `session.cjs` `need()` |
| Gmail "Log in" lands on myaccount | copied Google cookies fail Engelbart's check (Google binds sessions to the browser that made them); Log in then always opens `accounts.google.com` | `web-signin.cjs` `SIGN_IN_PAGES`, `import-cookies.cjs` `GOOGLE_BOUND_COOKIES` |
| Download prompts, focus jumps to Chrome, tab groups left, plugins required | the `browse` route (Claude in Chrome / Codex Chrome plugin) was the default for web apps; its prompt says "use the app's own Download menu" and "never close a tab"; `tabs_close_mcp` is refused | `prompts.cjs` BROWSE_RULES, `agents.cjs` CHROME_REFUSED |
| Granola "needs you to connect it" | agents run with `--strict-mcp-config`, so the Granola MCP the person already authorized in Claude Code / Codex is invisible | verified: a private CODEX_HOME with `[mcp_servers.granola] url=…` shows `Auth: OAuth`; `claude -p --strict-mcp-config --mcp-config '{granola: {type: http, url}}'` listed 8 folders |

## Decisions

1. **Flow order**: intro → provider → browser sign-ins → work → focus → projects → *method* (popup over the next screen)
   → manual: the combined picker | agents: Confirm your tools → Import to Engelbart.
2. **Combined picker** (manual): one accordion group open at a time; a selected source has "Specify context" (collapsed)
   holding project pills ("Select all projects you want Engelbart to import from {App}."), "Further specify" (natural
   language), and Choose a folder / Choose files for file sources. No pill selected = every chosen project.
3. **Removed**: For/Edit strip, Sources/From/Select all bar, subscription card, subtext under rows, the separate
   "Choose exactly what to bring in" page, MEMORY.md lines, dividing lines in the status modal.
4. **Web apps run headless by default**: Engelbart's hidden browser with the sign-ins copied from the chosen browser.
   No plugin needed, nothing comes to the front, no tabs are left. Google Drive files come in through the export URLs
   (`import_google_files`) as Markdown in `<dataRoot>/assets/md`, never a Download menu. The person's own browser
   (Claude in Chrome / Codex plugin) is only a fallback for an app whose copied sign-in is refused, and then it must
   close every tab it opened.
5. **Connectors the person already authorized** in their Claude Code or Codex (matched by the app's official MCP URL:
   Granola, Notion) are given to the import agent as they are, so it uses that sign-in with no prompt.
6. **No sign-in ever happens in Engelbart's Chromium.** A sign-in popup opens the app in the chosen browser; Engelbart
   copies the sign-in once the person is signed in there. Before any popup, the copy is retried quietly; a person
   signed in already in their browser is never asked.
7. **Needs you** = popups (one at a time, over everything), and rows that need the person sort first. The status modal
   loses its subtext; done shows "Your imports are complete!" with the imported sources' logos (duplicates merged).
8. **Full Disk Access**: the in-app dialogs are one line each; the helper beside Settings says only "Toggle Setting"
   (Hudson excluded the simulated-Settings guide); Quit & Reopen relaunches Engelbart on the same step.

## Checked

- `npm test`: 1681 tests, 1680 pass, 0 fail. New: `test/onboarding-round3.test.cjs` (detection heuristics, the scanner
  and its spawn watchdog, the person's own connectors, the agents' MCP configs, optional manual scopes, the helper's
  docking). Tests that encoded the replaced behaviour were changed to the new intent, each with a comment: the browse
  route's "never close a tab" and kept computer use, Notion's sign-in never copied, a dead Google copy as "signed out",
  "Read only folders" plan wording, `done` on a sign-in closing it unchecked.
- The real app, hidden, both paths: `npm run build && npx electron scripts/smoke-import-context.cjs` and
  `ENGELBART_SMOKE_MODE=manual …` (each of Hudson's specifics asserted: no subtext, the popup over the next screen,
  textarea that grows then scrolls, accordion, chevron alignment, project pills, Choose a folder / files, one-line
  dialogs, sign-in popups naming the chosen browser, no Engelbart window, rows that need you first, no dividers, the
  completion with one tile a logo, no MEMORY.md, no header pill once done).
- The lag, A/B in the real app over this Mac's real sessions with a throwaway data root
  (`scripts/probe-onboarding-lag.cjs`): main-process stall during connect-detect 2332 ms → 3 ms, recent projects
  975–4584 ms → 3 ms, tools ~10 ms both.
- The helper against the real System Settings window: docked 4 px right of it at 42% of its height, within ~1.5 s of a
  cold open; renders as the mockup's coach.
- Packaged (`npm run package`): the scanner process forks from inside app.asar and answers (checked over the main
  process's inspector).
- Claude Code and Codex reuse Hudson's Granola sign-in when given just the server's name and address (both checked).

## Not checked live

- macOS's own "Quit & Reopen": this Mac's Electron already has Full Disk Access, so the needs-a-relaunch state can't
  be produced here; the before-quit path is reasoned, not driven.
- A real Google cookie copy: it needs the Keychain prompt for Chrome's key, which the person answers. Whether Google
  refuses the copy (the held-elsewhere branch) on Hudson's Chrome is inferred from his reports, not reproduced.
- Real browser-agent runs (the fallback): no import was run against Hudson's accounts.
- The legacy "Connect your library" choose screen (ConnectLibrary.jsx) can still sign in inside Engelbart's window
  ("Sign in here"); Import your context never does.
