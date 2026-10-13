# Import your context (2026-10-13)

The onboarding's "Connect your library" became **Import your context**: the mockup in
`Desktop/Codex Readings/Onboarding.html` built as `src/renderer/import/ImportFlow.jsx`, with the backend in
`src/main/onboarding/` and the direct mode of `src/main/connect/session.cjs`.

## Where things are

- Flow: `src/renderer/import/ImportFlow.jsx` (screens and dialogs), `import-api.js` (the preload calls), `ImportStatus.jsx`
  (Imports in progress / Your imports are done, with every sign-in or permission as a card).
- Backend: `src/main/onboarding/` — `providers.cjs` (which agent runs it), `browsers.cjs` (the keychain browser),
  `browser-agents.cjs` (whether the web apps' imports run in the person's own browser, and whether Engelbart asks),
  `discover.cjs` (the project and tool agents), `disk-access.cjs` (Full Disk Access and the relaunch), `trace.cjs` +
  `trace-window.cjs` + `trace.html` (View ▸ Agent Trace, ⌥⌘T).
- Shared: `src/shared/import-flow.cjs` (roles, catalog, each tool's import plan).
- Browser agents: `src/main/connect/agents.cjs` kind `browse` (the commands), `src/main/terminal/agent-terminal.cjs` (the
  Engelbart terminal they run in), `prompts.cjs` `BROWSE_RULES` (the guardrails), `tools.cjs` `TOOLS_FOR.browse`.
- The standalone page: `npm run build && node scripts/build-import-mockup.mjs` →
  `design/onboarding-implemented/Onboarding.html` (mock api, Edit panel, every popup in the Popups menu, Save HTML).
- The real-app check: `npm run build && npx electron scripts/smoke-import-context.cjs` (fakes for providers, browsers,
  Full Disk Access and the agents; `ENGELBART_IMPORT_SHOTS=<dir>` saves pictures).

## Second round (2026-10-13)

- **One click.** Choosing an import method or a provider continues; no Continue button. Both subscribed: always asked,
  the one picked before suggested (not ticked). Not signed in: the tools setup first, then the question.
- **Nothing pre-selected.** No role, no project; the work description is required (no resize corner); no "Recent
  projects found" line on the role and work pages; a project's symbol is the workspace icon.
- **Confirm your tools** lists every tool, the selected ones first; the order settles when the page opens (and for an
  added tool), not on every click, so a tile never jumps under the cursor. The button is **Import to Engelbart**.
- **Imports in progress**: Continue to project; no Agent trace button (View ▸ Agent Trace); Stop all on the left, asked
  again with stopping as the quiet link and Keep importing the button. A new step reopens the modal only 45 s after the
  person put it away (it reopened over their work on every step).
- **"Starting your imports" stuck.** In the standalone page the flow never left that dialog after the run (no workspace
  to open), and its scrim covered everything; it now opens a stand-in project with the status over it. In the app the
  flow clears its dialog after the project opens, and onboarding passes the run on so its status opens over the project.
- **Six agents at once** (`MAX_RUNNING`, was 3).

## Browser agents

Checked on this Mac before building (Claude Code 2.1.296, codex-cli 0.162.1):

- Claude Code's own computer use exists only in an interactive session, holds the whole screen, hides other apps, and
  treats browsers as view-only. So its browser agent is **Claude in Chrome**: `claude -p --chrome`, which works headless.
- Codex: `codex exec` with the person's own Codex home has its **Chrome plugin** (node_repl's browser-client, a deferred
  tool the agent finds by searching "node_repl js") and computer use.
- Engelbart itself needs no macOS permission for either (the extensions and Codex's Computer Use app hold their own), so
  no permission overlay is shown; there is nothing for Engelbart to appear in the list for.

How a run uses them:

- Every web app but **Gmail** (whose threads come in only as approved, under a cap) goes to a browser agent when one is
  available and allowed; so do the tools outside the catalog. A browser agent's app is never held for Engelbart's sign-in
  check; a recall of it still needs Engelbart's browser signed in.
- **Asked first** ("Let agents use Chrome?", after Full Disk Access, before the run) only when the person's CLI does not
  already allow it (`claudeInChromeDefaultEnabled`; Codex's `browser_use` not turned off). Don't allow asks again
  (Continue without it the link, Allow Chrome the button). The answer is kept per data root
  (`.connect/onboarding.json` `browserAgents`); allowing turns it on per run (`--chrome`, `--enable browser_use`),
  never in the person's own configuration. A no wins over the CLI's own setting.
- **Guardrails**, in the prompt: may open, read, scroll, search, download and export; never send, post, delete,
  archive, change settings, type a password or close tabs (their own included); a login page is `needs_you`, shown as a
  card whose Open brings that browser forward and Done goes on. Besides the prompt: Claude Code runs with no settings or
  MCP servers of the person's, auto mode's classifier on every browser call and every prompt refused, and no
  `javascript_tool`, `form_input`, file upload, shortcut or `tabs_close_mcp`; Codex runs read-only, approving nothing,
  with the person's other MCP servers, plugins and ChatGPT apps turned off. Their tools from Engelbart only bring in
  (no hidden browser). Every step, the command, each screenshot (`.connect/<session>/steps/<job>/`) and the terminal's
  transcript go to the Agent trace; Stop all ends the terminal session.
- They run through the **Engelbart terminal** (a pseudo-terminal, the login shell, the terminal's environment, its
  queries answered as xterm.js answers them), as a terminal pane's session does.

## Decisions

- **Provider before mode.** The provider is settled (asked only if both are subscribed) right after Import, so the
  project agent starts while the person answers the role and work questions; the tool agent starts after the keychain
  step in auto mode.
- **One project per picked project.** Run makes a project for each pick (the first opens, with the session); an
  existing folder found by discovery is used as the project's folder.
- **Library only.** What an import brings in goes on the project's list, never into a workspace's context. That was the
  "Context has too many entries" error: imports filled the context to its limit and the next link threw. The limit is
  now 2000 (`MAX_TREE_ENTRIES`) and a context over it reads leniently instead of failing the workspace.
- **A signed-out web app is a card, not left out.** In the run it waits as a held sign-in card in Imports in progress;
  Log in opens it in the keychain browser (or Engelbart's window), Skip leaves it out. Done appears only when every
  import has ended and no card is waiting.
- **One agent per tool**, each limited to the picked projects; tools outside the catalog go to one "Other tools" job.
- **Full Disk Access** relaunches by itself back to the same step once the switch is on (the flow is saved first);
  folder-by-folder access is the fallback.
- **Safari** sign-ins can't be read (its cookies are sandboxed): the keychain dialog offers another installed browser or
  signing in inside Engelbart.
- **An updating agent counts as ready** (Codex's background update no longer blocks the flow).

## Not done

- A live import through a browser agent against real accounts (only harmless calls were run: "is a browser connected").
- Downloads land in the browser's own folder (usually ~/Downloads): without Full Disk Access or Downloads allowed,
  Engelbart cannot read what an agent downloaded, and the agent says so.
- Safari and Firefox have neither extension: with only those, web apps keep Engelbart's own browser.
- The Windows keychain.
- The old Connect your library picker (`ConnectLibrary.jsx`) was not reworked; the new picker replaces it in onboarding.
- `scripts/smoke-connect.cjs` walks the old Create/Connect path, which onboarding no longer shows.
