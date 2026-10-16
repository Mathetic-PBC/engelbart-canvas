# Onboarding beta, 2026-10-16 (branch `hudson-onboarding-beta-10-16`, worktree `draft-one`)

Ground truth is Hudson's Engelbart project note `~/.engelbart/engelbart/Onboarding/workspace.md` (its pictures are
`~/.engelbart/engelbart/assets/<id>.png`, named in the note as `img:<id>`). Read the note in full before touching code:
it says what to change, and its @bart exchanges say why. Three more of his notes, from the annotated page
`~/Desktop/Mathetic, PBC/permission-prompts.html` (annotations in `~/.engelbart/annotations/052aea01-88da-48ca-8c53-8ff3cc6384d9.json`):

- Keychain gate: "This obviously needs to be fixed, the keychain should not be triggered if skipped. However, this is one
  of the questions that wasn't skippable, so you shouldn't even be able to skip this."
- Keychain timing: "The permission prompt should come after for either choose sources myself and the let agents choose!"
- Full Disk Access: "fix. they should be able to deny full disk access. also, ensure there is no weird popup like there
  used to be to guide them with full disk access!"

That page was generated from an older build: on this branch Full Disk Access is no longer asked for (2026-10-15), and
the folders macOS guards are asked about in "Allow Engelbart to organize your research". Safari (S9) brings Full Disk
Access back for one purpose.

## House rules (every workstream)

- Comments: the repo's own voice (dated, quoting Hudson where a rule came from him, saying why). Match the surrounding
  density. Commit messages: one plain sentence or two of what changed and why, as `git log` shows, ending with
  `Claude-Session: https://claude.ai/code/session_01Rj61gNrft3c9mmadsPVvY8`.
- Design rules Hudson set: no horizontal divider lines; a selected row is a black 1.5px outline; no hint subtext under
  rows or headers; plain words, no jargon. Primary buttons on the right, a quiet text link on the far left.
- Tests: `npm test` (node --test over test/*.test.cjs, about 100 s) must pass. Add tests beside the existing ones for
  every behavior you change. Fake-agent smokes can't see the CLI layer: after any change under src/main/connect, run
  `npm run build && npx electron scripts/smoke-import-real.cjs` before calling it done (it uses real Claude Code).
- Running the app: build first (`npm run build`), then an isolated instance only:
  `ENGELBART_HOME_DIR=<your scratch>/home ENGELBART_CONFIRM_ALL=1 npx electron . --user-data-dir=<your scratch>/userdata --remote-debugging-port=<your port>`.
  Drive it with `ENGELBART_DEBUG_PORT=<port> node scripts/drive.mjs …` (read the driver's header first). Never use ports
  9222 or 9223 (Hudson's real windows). Take screenshots with `webContents.capturePage` (the screen may be locked), never
  `screencapture` from an Electron child. Kill your instances by their `--user-data-dir` path when done.
- Never delete anything outside your own scratch directory or `~/.engelbart/test`. Never touch `~/.engelbart` outside
  `~/.engelbart/test`, other worktrees, or the main checkout `~/engelbart-canvas` (it holds someone else's uncommitted work).
- Never `git stash` (the stash is shared across worktrees and sessions). Never push. Never build or upload a release.
- Stay inside the files your workstream owns. When you need something from a file another workstream owns, code against
  the contract below with a `typeof … === 'function'` guard and say so in your report.

## Who owns what

| Workstream | Files |
|---|---|
| SCREENS | src/renderer/screens/Onboarding.jsx, src/renderer/model/onboarding.js, src/renderer/model/tools.js, src/renderer/import/ImportFlow.jsx, import-css.js, round3-css.js, round4-css.js, ProviderPopup.jsx, ObsidianPicker.jsx, standalone.jsx, src/renderer/ui/ToolSetup.jsx, src/main/onboarding/providers.cjs, src/main/tools/* |
| COOKIES | src/main/browser/import-cookies.cjs (+ a new Safari reader module), src/main/connect/web-signin.cjs, signin-profiles.cjs, signin-window.cjs, src/main/onboarding/browsers.cjs, prefs.cjs, disk-access.cjs, the BROWSERS part of src/shared/import-flow.cjs, the IPC for these (src/main/ipc.cjs, src/preload.cjs, src/renderer/import/import-api.js: add, don't reorder) |
| CONNECTORS | src/main/connect/connectors.cjs, own-connectors.cjs, src/shared/connect-sources.cjs, the CATALOG/GROUPS/importPlan parts of src/shared/import-flow.cjs, src/renderer/import/logos.js |
| DISCOVERY | src/main/onboarding/discover.cjs, src/main/onboarding/prompts.cjs, src/main/onboarding/digest.cjs, new modules beside them |
| MAIN (the orchestrating session) | src/main/connect/session.cjs, src/main/connect/prompts.cjs, src/renderer/screens/ConnectLibrary.jsx, src/renderer/model/connect.js, src/renderer/import/NeedPopup.jsx, src/renderer/import/ImportStatus.jsx, src/renderer/App.jsx |

## Contracts between workstreams

- `api.browsers()` → `{ browsers: [{ id, name, keychain, isDefault, profiles: [{ id, name, email }] }], defaultId, chosenId,
  chosenProfile, keychain, safari: { diskAccess: boolean } }`. `profiles` is [] for a browser with one profile or none
  readable. (COOKIES provides, SCREENS shows.)
- `api.chooseBrowser(id)` as now; `api.chooseBrowserProfile(browserId, profileId)` → the same shape as `api.browsers()`.
  The chosen browser and profile are the only ones any copy reads from (no falling through to other profiles or browsers).
- `api.keychain('allowed')` asks macOS for the chosen browser's sign-ins at once (one prompt, cached for the run) and
  resolves after macOS answered → `{ keychain: 'allowed' }` or `{ keychain: 'refused', browser }`. `api.keychain('declined')`
  never asks macOS. Nothing asks macOS while the answer is missing. Safari: 'allowed' means Full Disk Access is granted
  and Safari's cookie file is readable; no Keychain prompt exists for it.
- `api.diskAccess()` → `{ granted }` as now; `api.openDiskAccess()` opens System Settings ▸ Privacy & Security ▸ Full Disk
  Access, nothing else (no guide window, no helper popup).
- webSignIn (main) for MAIN: `signInQuiet(app, …)` → `{ signedIn: true }`, `{ signedIn: true, unchecked: true }` (the check
  could not tell: cookies kept), or `{ signedIn: false }` only when the site said signed out (a redirect to its login page,
  or no session cookie at all). `copyFor({ name, domains })` → `{ copied, signedIn: true | false | null }` for a tool with no
  registered app (an "Other" tool, one the agents found or the person added). `recapture(appOrTool, { signal, timeoutMs })`:
  opens the app in the chosen browser and profile, copies its cookies again once they appear or change (at once when they
  are already there), checks them, → the same shape as `signInQuiet`.
- Discovery (DISCOVERY provides, SCREENS shows): `projects.status` 'done' with `empty: true, reason: 'no-context'` when
  every route ran and none knew of a project (the screen asks the person to add one, and never says anything failed);
  'failed' only when a route itself broke (an agent error, a timeout), with the existing error and Try again.
- Connector apps (CONNECTORS provides): Linear and Evernote in `APPS` with `reach: 'connector'`; Evernote keeps a browser
  fallback (`fallback: 'web'`) while its MCP is in beta. Linear is listed in the Other category by default.

## Requirements

IDs are what reports and commits refer to. Where the note is ambiguous, the reading taken is written down; flag it in
your report if the code made a different reading better.

### SCREENS

- S1 Welcome: Continue on the right, not centered; the same footer placement on every onboarding screen.
- S2 "generally make everything bigger, there is too much whitespace. this should be minimum size but should expand with
  window. same for all like five screens." The screens: Welcome, What kind of work do you do?, What are you interested in
  researching?, What project do you want to work on first?, What should go in your library?. One fluid scale (the type,
  the controls and the column grow with the window from a minimum), checked at 1000×700, 1440×900 and 2560×1440.
- S3 The "Set up your tools" screen after Welcome goes. In its place:
  - A CLI (Claude Code, Codex) that is installed, signed in and has a subscription (src/main/onboarding/providers.cjs) is
    updated in the background when an update exists, and the flow goes straight on. Both qualify: both update.
  - Neither qualifies: a popup (no screen) asks whether to use Claude Code, Codex or both. The choice installs what is
    missing and updates what is out of date. A choice that is installed and up to date but not signed in (or signed in
    without a subscription) shows one button, "Connect to Claude", "Connect to ChatGPT" or "Connect to Claude and
    ChatGPT", which opens that CLI's sign-in. Once one can run, the flow goes on by itself.
  - No subtext under the title or the rows, no version numbers anywhere ("No one cares about the version"), "Skip" in
    plain text on the far left (was "Skip for now"). Git is never a row: it ships with the app; when it is missing it is
    installed in the background.
  - The same popup replaces Import your context's "Connect Claude Code or Codex" dialog (needProvider's 'tools-setup').
  - The pager counts only screens that exist (it read "1 of 3" on Welcome, then "2 of 4").
- S4 "What are you interested in researching?" (no "right now").
- S5 Add a project's description placeholder: "Understanding the history of the Memex".
- S6 The picker: the category-level "Specify context for all {category}" dropdown and its field go; categories are not
  collapsible (always open, no chevron). Each tool keeps its own Specify context. (Reading of "get rid of this dropdown,
  it should not be collapsable on a topic level".)
- S7 A row with no logo (Vercel, Supabase, Cloudflare under Other) has no empty icon slot: its name starts at the left.
- S8 "How should Engelbart import your sources?": the first option gets the agent icon (src/renderer/ui/SidebarIcons.jsx
  AgentsIcon); the second a hand like the note's Attachment 13 without the rounded-square outline, drawn in the same
  stroke as the other icons. "(recommended)" moves into the first option's title when the title still fits on one line
  at the dialog's width, and is dropped when it does not. The titles lose their trailing periods.
- S9 Safari chosen as the browser (the default or picked): a popup with the header "Engelbart requires additional
  permissions to access Safari", the subheader "Click on the toggle next to 'Engelbart' to grant access", an emphasized
  "Grant disk access" lower right, "Select different browser" to its left (not far left), and "Skip" as plain quiet text
  on the far left. Grant disk access opens System Settings ▸ Privacy & Security ▸ Full Disk Access (no guide window) and
  waits for the grant (`api.diskAccess()`); granted, Safari's sign-ins are used like any other browser's. macOS may ask
  to quit and reopen: the flow comes back on this step. Select different browser opens the browser picker. Skip: no
  Safari sign-ins (as Keychain 'declined'). This replaces "Use the sign-ins of another browser?" and the Safari path that
  declined at once.
- S10 The chosen browser has more than one profile: a popup "Select your {Browser} profile" (e.g. "Select your Chrome
  profile"), one row per profile (its name, and its email when known), one selection, "Continue" lower right. It comes
  after Allow and before the macOS prompt.
- S11 The Keychain question can't be skipped and is never skipped for want of an answer: when browser detection hasn't
  finished, the flow waits for it (a short "Looking for your browsers…" in place), then asks. The run's `keychain` flag
  comes from the answer alone (`keychain === 'allowed'`): declined or unanswered, macOS is never asked.
- S12 macOS's Keychain prompt comes right after Allow, with either import method (it waited until Import to Engelbart
  with "Choose sources myself").
- S13 "Allow Engelbart to organize your research" can be declined: a quiet "Skip" on the far left continues without the
  folders macOS guards (what needs them is left out quietly). Nothing anywhere opens a guide window for System Settings.

### COOKIES

- C1 Safari's sign-ins: read Safari's `Cookies.binarycookies` (the container path on current macOS, the old path as a
  fallback; Safari profiles when present) with a parser of our own, modelled on yt-dlp's (`yt_dlp/cookies.py`,
  `_parse_safari_cookies`) and browser_cookie3; the sites asked for only; imported into Engelbart's session like the
  Chromium path. Unreadable without Full Disk Access → `{ needs: 'disk-access' }`, never a crash or a silent empty copy.
- C2 One verdict rule for every sign-in check (SIGN_IN_CHECKS and any other check): a 2xx on the check page is signed in;
  a redirect to that site's own login page, or a 401, is signed out; anything else (403, 429, 5xx, a redirect elsewhere,
  a timeout, a network error) is unknown: the cookies stay and the answer says `unchecked`. Probe each check page (Google,
  GitHub, Overleaf, Zotero, and any other) from Electron's net.request, signed out and with real cookies where you can,
  and record what each returns. Every check records its status and redirect target in the trace.
- C3 A copy that fails its check is undone completely: every cookie that copy added, not only the session cookie (16
  Google cookies of other accounts were left behind).
- C4 One browser profile, chosen once (S10), is used for every copy: no falling through to other profiles or browsers.
  Remembered in prefs with the browser. `browsers.list()` gives each browser's profiles (Chromium: Local State
  `profile.info_cache` name and user_name; Firefox: profiles.ini; Safari: its profiles, if any).
- C5 `keychain('allowed')` unlocks the chosen browser's key at once (S12). Declined or unanswered never asks macOS.
- C6 The second silent path in the Google note: `signInQuiet(app, { askedOnly: true })` gave up with no import when macOS
  hadn't been asked yet this run, though the person had allowed the browser's sign-ins. An allowed browser may be asked.
- C7 Cookies for every tool, including Other tools and those the agents found or the person added: `copyFor({ name,
  domains })` from the chosen profile, with a check where one can be made.
- C8 `recapture(...)`: the native-browser fallback. Opens the app (or tool site) in the chosen browser and profile; copies
  again at once when its cookies are already there (an already signed-in person never has to sign in again), else once
  they appear or change; checks; bounded by `timeoutMs`. Fix what Bart found: after a rejected copy the polling ignored a
  profile until its session cookie's timestamp changed.
- C9 Sign in inside Engelbart (signin-window.cjs) works for any site, not only registered apps, in the same session the
  agents use.

### CONNECTORS

- K1 Evernote through its official MCP server (OAuth). Find the endpoint and its auth in Evernote's own documentation
  (dev.evernote.com/mcp); keep the browser route as the fallback while it is in beta.
- K2 Linear through its official MCP server (OAuth; the read-only endpoint if Linear documents one: linear.app/docs/mcp),
  listed under Other by default (no new category).
- K3 A connector whose token expired or was revoked is refreshed; when it can't be, it asks to be connected again ("Connect
  {app}") rather than being left out silently.

### DISCOVERY

- D1 Project discovery's evidence is the Claude Code and Codex sessions only: the Obsidian and Zotero fallback goes.
- D2 When the CLIs give nothing, the same project prompt (the JSON of projects) goes to the person's ChatGPT or Claude on
  the web: their sign-in copied into Engelbart's browser from the chosen profile, an agent with Engelbart's browser opens a
  new chat, sends it, reads the answer and deletes the chat (as the recall job does). The prompt has an escape: answer
  `null` when it knows nothing about the person. Only when the person allowed their browser's sign-ins; never a visible
  window; bounded in time.
- D3 Every route ran and none knew of a project: `status: 'done', empty: true, reason: 'no-context'` (the person adds a
  project; nothing says failed). A route that broke: 'failed', as now.
- D4 Safari's history is read for tool discovery only when Full Disk Access is granted.

### MAIN

- M1 Manual import's permission ask: one chat message, the first one, shown at once (before the scan finishes): "Allow
  Engelbart to access the following apps:", one row per app (its icon, name and a circular checkbox, drawn like the add
  to library page's topic rows), every one unticked, "Select all" (reading "Deselect all" once all are ticked) beside
  "Grant access", which waits for one tick. Only the apps themselves: no "Saved websites from …" rows. Replaces the
  popup per app (twelve of them in Hudson's run).
- M2 A failure never greys out, disables or takes the place of a question still unanswered.
- M3 A connector app (Notion, Granola, and now Linear and Evernote) allowed but not connected gets its Connect step; once
  connected its survey starts and the librarian hears it was allowed and connected. Zotero and GitHub, signed out, the
  same with their own sign-in. (The bug: allowApp → beginApps → startWork set `needs: 'connector'` and did nothing else.)
- M4 Other tools keep their identity (name, site, chosen browser): their sign-in is copied like a registered app's (C7),
  and a step for one names the tool, never "Other tools: Linear".
- M5 The cookie fallback everywhere a sign-in is used: copy from the chosen profile and check; quiet bounded retries in
  the background (check again, copy again, recapture); a blocked or inconclusive check keeps the sign-in (unknown), never
  a new login; still failing, one card: "Sign in inside Engelbart" and "Skip"; after a sign-in there, check and resume;
  failing even then, the source is skipped with one quiet line that stays ("Couldn't connect to Linear. Skipped."), and
  the other imports go on. Nothing opens a sign-in window by itself during the background retries. No "Choose another
  profile". MCP connections keep their own OAuth recovery (K3).
- M6 The librarian's messages are 3-5x shorter, conversational, and never tell the person what they already know.
- M7 "Getting to know your library": no dot grid; the words in a moving gradient.
- M8 A question's options: a black outline when ticked, not blue; Submit stays blue.
- M9 No "Skipping one leaves it out. You can add it later from Add sources." under the steps.
- M10 Manual mode never shows the "Refine with Claude Code" popup (it opened from the red "Your answer"). Nothing ever
  says "Your answer"; in the manual screen it says "Importing".
- M11 Manual library onboarding has no Reply box (the "Reply…" composer with the provider chip).
- M12 The work line ("Bringing in ChatGPT: …"): the words in the gradient, no blue dot.
- M13 "Bring these in ›" becomes "Finish in background", with no arrow.

## Status, 2026-10-16

Built on this branch (commits 443c99b CONNECTORS, 17c53e8 DISCOVERY, 229c4b1 COOKIES, 90b5bab MAIN, 0b78fcc SCREENS, then
fixes from the smokes). `npm test` 2156/2156; `smoke-import-context` passes both ways; `smoke-import-real` (Claude Code)
passes; three real librarian turns averaged 16.5 words a message (Hudson's examples: 45-55). Test build:
`/Users/Shared/engelbart-test/build-4`, steps in `/Users/Shared/engelbart-test/onboarding-beta-TESTING.md`.

Readings taken where the note left room:
- M1's grant lists the apps the per-app popups asked about (web apps, connectors, the tools the agents found or the person
  added), not local apps (Obsidian, Apple Notes, Claude Code): those were never asked and the scan reads them behind it.
  The popups' line about the provider processing what is read is gone with them (no subtext).
- The grant waits for its answer before the librarian's first turn (the scan runs behind it), so the librarian plans
  with exactly the apps it may reach.
- Recall (Asking ChatGPT/Claude what it remembers) had no browser and could never ask: fixed in tools.cjs.
- A connector its server won't serve for the account (Evernote outside its MCP beta) is read through its website as an
  Other tool; one with no website is skipped with a line.
- S3: "an update exists" is the tool check's outdated/incompatible; the agent popup's Skip goes on to Import your context,
  which asks again.

Checked against real accounts afterwards (Hudson's Chrome, read-only, nothing sent or changed):
- C2 signed out (no cookies): every check page redirects to its own login (GitHub /login, Drive accounts.google.com
  ServiceLogin, Overleaf /login, Zotero /user/login, Evernote /Login.action) and checkResult reads each as false. Signed in
  (the page's own fetch, redirects not followed): GitHub, Drive, Overleaf and Zotero answer 200, read as true. Evernote: not
  signed in on that account.
- D2: ChatGPT's /api/auth/session and Claude's /api/organizations say signed in; the message box is found on both (ChatGPT's
  is no longer #prompt-textarea: the `div[contenteditable][role=textbox]` pick finds its "Ask ChatGPT" editor; Claude's
  "Write your prompt to Claude"). Not checked: the Send button's name once text is in (it only shows then; Enter is the
  fallback). The list and read endpoints answer in the shapes the readers expect.
- C1: the parser read four real `binarycookies` files this Mac's WebKit wrote (ChatGPT, Atlas, Zoom, Opal: 139 cookies, 0
  malformed, creation dates before each file's last write, expiry right). Safari's own file is unreadable without Full Disk
  Access (EPERM) and `readSafariFile` throws `needsDiskAccess`, as C1 wants. Safari's own file with access: not yet.
- K2: Linear's read tool names (agents.cjs `reads`) are all tools of Linear's MCP server.
- Found on the way: ChatGPT's conversation list leaves out every chat inside a ChatGPT project (none of a project's 9 among
  519): fixed in web-chats.cjs (8834c2d). Claude's list includes its projects' chats.

Open:
- Not run against real signed-in accounts: Evernote/Linear OAuth end to end, Safari's own cookie file with Full Disk
  Access, the ChatGPT/Claude project question sent for real.
- The auto smoke once ended with a native SIGABRT at quit: node-pty's exit callback (ThreadSafeFunction::CallJS → a
  Napi::Error) during node::FreeEnvironment (crash report Electron-2026-10-16-050733.ips). The smokes end with app.exit, which
  skips the quit that closes terminal sessions. Not reproduced since (5 smoke runs, 58 isolated runs). A Claude Code or Codex
  sign-in waiting in the browser was the one PTY a real quit left running: requestQuit now ends it first (508c2fe).
- The old Connect your library choose screen still has its own profile and Keychain modals.
- scripts/smoke-provider-real.cjs (the real Claude Code and Codex, detection only; every install, update, sign-in and
  sign-out stubbed and counted) is rewritten for the agent popup but not run: this Mac's `claude` is a wrapper whose
  handling of CLAUDE_CONFIG_DIR wasn't checked, so it might read the real ~/.claude.

The three smokes that walked the removed tools screen walk the agent popup now: smoke-connect-tools passes, and so do all
four scenarios of smoke-provider-connect. Rewriting them found two bugs, both fixed in ImportFlow.jsx:
- The popup opened for one CLI (Claude Code turned the agents away) dead-ended when the person picked the other: Codex
  showed Connected and nothing went on (the effect waited for Claude Code; the popup's onDone was off). The choice made in
  the popup now goes on once it runs.
- With no browser whose sign-ins can be read, the browser question was declined without being asked but never saved, so
  the recent projects' ChatGPT/Claude route waited ten minutes for an answer (discover.cjs keychainAnswer). It is saved now.
