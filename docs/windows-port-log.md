# Windows port log (MATH-26)

The run that follows docs/windows-port.md, on branch `windows-port` (cut from `hudsons-feedback` at 22d738c).
Newest status first; the sections below are kept current.

## Beta catch-up to 0.1.23 on linux-beta-deployment

Goal (2026-10-18): `linux-beta-deployment` (from 47c66a6: the 0.1.23 beta with origin/windows-port merged in) is the
beta's features working on Linux x64 (Ubuntu 22.04/24.04 first), with windows-port's Linux decisions (AppImage,
install-linux.sh, engelbart-launch, /proc for lsof, bash when zsh is missing, Engelbart's own sign-in window). And the
bug Hudson saw: "on Linux it is not accessing Obsidian files and other files well". Nothing pushed, no release.

### Status

- 2026-10-19, **David's first hand test (Ubuntu 24.04 in VirtualBox, the AppImage from 39186106461)**: onboarding's agent
  popup stopped twice. (1) Installing Claude Code: "It did not finish (sudo apt install curl)": Ubuntu's desktop has no
  curl. tools/install.cjs now downloads with curl, else wget (which Ubuntu has; Claude Code's installer takes either),
  else says to install curl. (2) Signing in: Claude Code could not open the browser itself, so the page Engelbart opened
  was its other sign-in, which ends with a code to paste into Claude Code, and the hidden terminal had nowhere to paste
  it. tools/sign-in.cjs now says when the CLI takes a code (its "Paste code here" prompt, or a `code=true` page) and
  types one in (`send`); the agent popup and Connect Claude Code show a box for it (import/SignInCode.jsx). Why Claude
  Code could not open Firefox from the AppImage is not known yet: David's check (does `claude auth login --claudeai`
  in a terminal open it by itself?) decides whether the AppImage's own variables (APPDIR, APPIMAGE, OWD, ARGV0) are
  taken out of what Engelbart starts. Settings' tool rows (model/tools.js) have no code box yet. The error line under
  the popup sits over Welcome's own Continue in a small window, as on the Mac (the popup's scrim): left.
- 2026-10-19, **windows-beta-deployment merged in** (at 0869062), so this branch is green on all three: it had
  taken 6 of the Windows branch's 12 commits; the other 6 (bdfad42 @create's POSIX rules, 0b047e6 node:sqlite history,
  789a8cb, bb3c149, 78bc4b5, 0869062 the Windows CI fixes) were missing, so its Windows job failed. Conflicts kept both:
  readers' Linux and Windows browser lists (Comet, Opera's one profile), discover's Firefox roots for all three and
  sqliteRunner(env, platform) (which already answers sqliteHere on Windows), scan.detect's Linux .desktop entries and
  Windows programs, onThisMachine for the shown words. linux-platform.test.cjs on a Windows runner: the Chromium
  profiles test compares `/` paths; three skipped there (see Tests skipped).
- 2026-10-19, **first CI run** (39181647830, on c5a487e): Mac ✓; Linux 2 failed, Windows 11 failed, so neither
  packaged. Fixed for Linux (David's session), both tests that assumed the runner is a Mac: discover-assistant-projects'
  D2 runs the discovery as the Mac's (`platform: 'darwin'`; off the Mac the sign-ins question is answered 'allowed',
  e8101ad), and the collapsed title's rename hint is `Alt` off the Mac. The Windows job is left: its failures are the
  Windows port's (@create's rules in Claude Code's POSIX form, bdfad42 on windows-beta-deployment, and tests written for
  a Mac or Linux runner); this branch's installer is the AppImage.
- 2026-10-18, **after the agent's run** (in the session that started it): taken from windows-beta-deployment, because each
  applies off the Mac, not on Windows alone: 96caea2 (release builds copy src/main's .html pages: left unstaged in the
  merge 47c66a6), 2c96f08 and 7cd955c (import sign-ins off the Mac: OneNote's and Evernote's inside Engelbart, the card
  at once, a lapsed one offered again), 6c5710e (the workspace's shortcuts take Ctrl off the Mac: on Linux ⌘'s were
  the Super key; its test in test/keys.test.cjs), a91c881 (main's browsers.list answers the sign-ins question
  'allowed' off the Mac; installed-apps' Windows places, which Linux never reaches). Their subjects still say
  "Windows:". Then e8101ad: f4323b7 had answered that question 'declined' off the Mac, and the run's keychain: false made
  connect/session.cjs close every sign-in step as "which you turned down": Google Drive, ChatGPT and every app needing a
  sign-in were left out on Linux. Now 'allowed', as on Windows, and recent projects never waits for an answer. The two
  tests for it failed first.
- 2026-10-18, **the app on Linux (arm64 container, `electron .` under xvfb)**, a throwaway home with an Obsidian vault in
  ~/.config/obsidian and one in Flatpak's place, Chrome's and Firefox's .desktop entries and a Chrome profile, asked
  through its own preload: on 47c66a6 the import's Obsidian picker had **no vaults**, Connect's detect found no Obsidian
  and no browser history, and the browser list was all nine (safari, chrome, brave, firefox, arc, edge, opera, chromium,
  comet). On fba6a4d: the picker lists both vaults with their notes (Flatpak vault ▸ Paper notes, Plain vault ▸ Idea),
  detect says Obsidian "~/Flatpak vault, ~/Notes/Plain vault" and sites "Chrome", the browsers are chrome and firefox.
  (The driver is a scratch script, not committed; scripts/smoke-linux.cjs is unchanged.)
- 2026-10-18, **Linux npm test** in an ubuntu:24.04 container (Colima profile engelbart-linux, aarch64, 4 CPUs, 8 GB; Node
  22.20.0, zsh, sqlite3 and unzip installed; a git clone of the branch, `npm ci` building node-pty there; /etc/hosts as
  Ubuntu writes it: Docker's own puts `localhost` on ::1 too, so the run-step tests' server, listening on localhost,
  was on ::1 while fetch tried 127.0.0.1). 47c66a6: 2237 tests, 2215 pass, 7 fail, 15 skipped. fba6a4d: 2248 tests, 2228
  pass, 5 fail, 15 skipped. The 5 are this container's, on both commits: build.test.cjs and projects.test.cjs killed by
  the kernel's OOM killer (cgroup oom_kill counted; build.test.cjs peaks at 5.9 GB resident on the Mac too, so 8 GB with
  three files at once is not enough); install-linux.sh's two tests (an arm64 computer: "Engelbart for Linux runs on 64-bit
  Intel and AMD computers"); the sandbox benchmark's `git show d0cb837` (a commit on another branch, not in this one's
  history). Fixed between them: the PDF folders test's tie (failed on 47c66a6 here). On 47c66a6 shell-rc's zsh launcher
  test also failed once (exit 13 after 12 s, under the same memory pressure); it passed in both runs of the branch. The
  first run on 47c66a6 (a `git archive` copy, Docker's hosts file) had 13 failures: these plus the 5 run-step tests
  (localhost) and an updates test, and the release-site test (`git show` without a .git).
- 2026-10-18, **Mac**: `npm test` on 47c66a6 2262 tests, 2258 pass, 4 skipped, 0 failed; on f4323b7 2273, 2269 pass,
  4 skipped, 0 failed (the 11 new tests); on 36c166a (the log) the same, 2273, 2269 pass, 4 skipped, 0 failed (a run before it, while the machine's load average was 84, timed out two tests in connect-web-signin.test.cjs and install-mac.test.cjs, which pass alone and in this run). `npm run build` passes.
- 2026-10-18: f4323b7 (the fix), fba6a4d (the Mac-layout fixtures name the Mac).

### What changed

- **Obsidian** (src/main/connect/readers.cjs `obsidianVaults(homeDir, platform, env)`): on Linux it read only the Mac's
  ~/Library/Application Support/obsidian/obsidian.json, so it found no vault and everything on it failed: Connect's scan
  and detect, the import's Obsidian picker ("Obsidian has no vaults on this Mac"), the link import, the session's folders.
  Now on Linux it reads `$XDG_CONFIG_HOME/obsidian/obsidian.json` (~/.config when unset or not absolute; obsidian.md/help
  "How Obsidian stores data": "$XDG_CONFIG_HOME/obsidian/ or ~/.config/obsidian/"), Flathub's md.obsidian.Obsidian
  (~/.var/app/md.obsidian.Obsidian/config/obsidian, a Flatpak's XDG_CONFIG_HOME) and the Snap's
  (~/snap/obsidian/current/.config/obsidian; a forum log shows /root/snap/obsidian/40/.config/obsidian/obsidian.json).
  **All of them, merged**, one entry per vault folder with its newest time and `open` if any says so: someone who moved
  from the .deb to the Flatpak (or has both) has vaults in each, and a vault an unused install lists is still a folder of
  their notes; taking only the most recent file would hide the others'. A vault folder that is gone is left out as before.
  obsidianTree (the picker) and scan.detect take `platform`/`env`. The Mac and Windows read as before.
- **Chromium browsers** (`browserProfiles(homeDir, platform, env)`): Linux's $XDG_CONFIG_HOME/google-chrome,
  BraveSoftware/Brave-Browser, microsoft-edge, chromium, vivaldi; their Flathub folders (~/.var/app/<id>/config/…); the
  Snaps of Chromium (~/snap/chromium/common/chromium) and Brave. Opera keeps its one profile in ~/.config/opera itself, no
  Default folder: not read (as on the Mac). **Firefox** history (discover.cjs historySites): ~/.mozilla/firefox, the Snap's
  and Flathub's org.mozilla.firefox profiles.
- **sqlite3 and unzip may be missing** (Ubuntu's desktop has no sqlite3): `readers.sqliteRunner(env, platform)` runs the
  command where it is on PATH, else node:sqlite in this process (windows-port's sqliteHere), on Windows always; used by
  browserHistory and historySites (Chromium, Firefox). An export's .zip without unzip is read with
  ../overleaf/copy.cjs readZip (`exportText`).
- **Cursor**: ~/.config/Cursor/User/globalStorage/state.vscdb ($XDG_CONFIG_HOME) on Linux.
- **PDF folders**: on Linux also the Downloads, Documents and Desktop folders xdg-user-dirs names in the person's language
  ($XDG_CONFIG_HOME/user-dirs.dirs; a Desktop set to the home itself is not taken).
- **Installed apps and browsers** (new src/main/connect/linux-apps.cjs): from .desktop entries (Name= of the
  [Desktop Entry] group, or the entry's id; Hidden=true ones not) in $XDG_DATA_HOME, $XDG_DATA_DIRS,
  ~/.local/share/flatpak/exports, /var/lib/flatpak/exports and /var/lib/snapd/desktop. Obsidian also counts when any of its
  obsidian.json is there (an AppImage run without an integrator leaves no entry). scan.detect and discover's toolEvidence
  use it on Linux in place of .app bundles. index.cjs uses `createLinuxInstalledApps` for the browsers: before, the
  missing /usr/bin/mdfind made Spotlight's answer "can't tell", which counts as installed, so every browser, Safari, Arc
  and Comet included, was offered on Linux.
- **The browser's sign-ins question** (renderer/model/onboarding.js `keychainStep(browsers, platform)`, ImportFlow passes
  its platform): off the Mac nothing is ever copied from a browser (copiesSignIns), so "Allow Engelbart to use your
  <browser> sign-ins" is never shown and is answered 'declined' (saved, so the recent projects never wait ten minutes for
  it). The browser list still says whose history the tools screen reads.
- **"this Mac"** off the Mac: the tools screen's evidence (discover.cjs: "Found on this computer", "N repositories on this
  computer", "<browser> history on this computer"), Connect's detect `where` ("on this computer"), and the empty Obsidian
  picker ("Obsidian has no vaults on this computer.", from the preload's data-platform). The Mac's words are unchanged.
- Tests: test/linux-platform.test.cjs (11, each with `platform: 'linux'`, a fake home and env, so they run on the Mac;
  10 fail on 47c66a6, the 11th needs linux-apps.cjs, which 47c66a6 has not). Mac-layout fixtures name the Mac
  (`platform: 'darwin'`: connect.test.cjs's detect and Chromium tests, obsidian-tree.test.cjs); the Cursor test puts its
  database where cursorDb says; the PDF folders test's Downloads files are a minute older than the HCI folder's (they tied
  on Linux, written in one millisecond).

### Mac-only paths in the beta's new code, and what was done

| Where | What | Done |
|---|---|---|
| connect/readers.cjs obsidianVaults | ~/Library/…/obsidian.json only | fixed: XDG, Flatpak, Snap, merged |
| connect/readers.cjs browserProfiles, onboarding/discover.cjs historySites | ~/Library Chromium and Firefox folders | fixed: XDG, Flatpak, Snap |
| connect/readers.cjs browserHistory, discover historySites | the sqlite3 command | fixed: node:sqlite when it is missing |
| connect/readers.cjs exportText | the unzip command | fixed: readZip when it is missing |
| connect/cursor.cjs cursorDb | ~/Library/…/Cursor | fixed: ~/.config/Cursor |
| connect/readers.cjs pdfRoots | English folder names, iCloud, ~/Library/CloudStorage | fixed: xdg-user-dirs too; iCloud and CloudStorage simply absent |
| connect/scan.cjs BUNDLES, onboarding/discover.cjs DESKTOP | .app bundles in /Applications | fixed: .desktop entries (linux-apps.cjs) |
| browser/installed-apps.cjs | /Applications, mdfind | fixed on Linux: linux-apps.cjs createLinuxInstalledApps |
| onboarding/browsers.cjs + ImportFlow keychain dialog | Keychain / Safari Full Disk Access question | degraded on purpose: never asked off the Mac, 'declined' |
| onboarding/browser-agents.cjs | extensions under ~/Library | already off the Mac: not available (browsersFor → []) |
| onboarding/disk-access.cjs | TCC.db probe, System Settings | already: off the Mac `granted: true`, open() does nothing; ImportFlow's folders popup is darwin-only |
| connect/folder-access.cjs, session.cjs findMessage | protected folders | already: nothing protected off the Mac (windows-port) |
| browser/import-cookies.cjs, safari-cookies.cjs, connect/web-signin.cjs copying | Keychain, Safari cookies | already: created on darwin only; off the Mac every sign-in is Engelbart's window |
| index.cjs openChosen / openIn / openInProfile / openBrowserApp | `open -b` | already: openChosen uses shell.openExternal off the Mac; openIn/openInProfile are reached only through copying (Mac); openBrowserApp refuses (browser agents, Mac only) |
| tools/detect.cjs desktopCopies | Claude desktop's bundled claude-code under ~/Library | left: no Linux Claude desktop; the path is just absent |
| connect/apple-notes.cjs | osascript | already: refuses off a Mac |
| onboarding/obsidian-tree.cjs, ObsidianPicker.jsx | obsidian.json via readers, "this Mac" | fixed |
| discover.cjs and scan.cjs evidence words | "this Mac" | fixed: "this computer" off the Mac |
| shared/connect-sources.cjs LOCAL_PDFS "PDFs on this Mac", shared/import-flow.cjs LOCAL_FOLDERS "Folders on this Mac" | ids shown as names in the picker and tools screen | left: they are keys (saved sessions, picks, tests); see Needs a decision |
| renderer/screens/ConnectLibrary.jsx, model/connect.js (~100 lines of "this Mac"/macOS copy) | the manual import's librarian page | left: copy only, the flows are windows-port's off-Mac ones; see Needs a decision |
| agent prompts (shared/import-flow.cjs, connect/prompts.cjs, discover's notes) | "on this Mac" | left: words to the model, not the person |

### Tests skipped (with reasons)

On Windows only, linux-platform.test.cjs: "a browser's history without the sqlite3 command", "apps on Linux: found by
their .desktop entries", "the browsers on Linux: by their .desktop entries". Linux's PATH and XDG_DATA_DIRS are lists
split at `:`, and a Windows runner's temp folders (D:\…) hold one. Mac: 4 skipped, as before.

### Needs a decision

- The names "PDFs on this Mac" and "Folders on this Mac" are also ids (APPS keys, saved sessions, picks, the agents'
  prompts). Showing "PDFs on this computer" off the Mac would go through shownName (SHOWN_NAMES), platform-aware in both
  main and the renderer. Not done: tests that read the shown names would then differ by platform.
- ConnectLibrary.jsx and model/connect.js say "this Mac" and "macOS" in ~100 lines on the manual import's page. A pass
  with one `machine` word (Mac / computer) would cover them; left for a copy decision.
- Off the Mac the sign-ins question is answered 'allowed' without asking (e8101ad, as windows-beta-deployment does), so
  sign-ins made in Engelbart's own window are used, and recent projects asks ChatGPT and Claude through that window. A
  Linux user has no way to say "use no sign-ins"; offering one would need a question in other words than "use your
  <browser> sign-ins", which never happens off the Mac.
- When several obsidian.json files exist on Linux their vaults are merged (above). The alternative, only the most
  recently changed file, was not taken.

### Left for a hand test

- On Ubuntu 24.04 with Obsidian installed as a .deb, then as a Flatpak, then as a Snap (and an AppImage): Import context ▸
  Choose files under Obsidian lists the vaults; Connect's choose screen ticks Obsidian; a librarian import reads a vault.
- The tools screen with Chrome (deb), Chromium (Snap) and Firefox (Snap) installed: only those browsers offered, no
  sign-ins question, the history evidence filled (sqlite3 not installed).
- A ChatGPT or Claude export .zip on a machine without unzip.
- Engelbart's sign-in window for Google Drive and ChatGPT on Linux (windows-port's path; not exercised here).
## Beta catch-up to 0.1.23 on windows-beta-deployment

Goal (2026-10-18): `windows-beta-deployment` (from 47c66a6: the 0.1.23 beta with origin/windows-port merged in) = the
beta's features working on Windows 10/11 x64 with Git for Windows, on windows-port's architecture (Git Bash for POSIX
scripts, PowerShell terminals, AppData, taskkill, node:sqlite, tar.exe, Engelbart's own sign-in window, NSIS). Every
module added or changed since a215457 (0.1.19) audited for Mac-only assumptions. The Mac does not change. Nothing was
pushed: **nothing here has run on Windows** (no CI run); every Windows branch is tested on the Mac with an injected
`platform: 'win32'`, Windows-shaped homes or fakes.

### Status (newest first)

- 2026-10-19, **first CI run** (39181645504, on 96caea2): Mac ✓; Windows 8 failed, Linux 1 failed, so neither
  packaged. Fixed (David's session): `createRules` resolves a POSIX draft with `path.posix` (on Windows `path.resolve`
  made `/a/b` into `D:\a\b`), and the agent map names its placeholder draft in POSIX form on every machine. Tests that
  assumed the runner is a Mac now say so: create.test.cjs expects Claude Code's `//c/…` form on Windows; the collapsed
  title's rename hint is `Alt` off the Mac; skipped on Windows (see Tests skipped): browser-agents' terminal (zsh),
  cookies C1 (chmod 000), provider-connect's Claude app copy (claude.app). run-step's "after a turn ends in review"
  failed once ('failed' for 'done') and passed in the same commit's other Windows run: left as intermittent.
- 2026-10-18: 9 commits (a91c881 … 78bc4b5). Mac `npm test` at 47c66a6: 2262 tests, 2257 pass, 4 skipped, 1 failed
  (install-mac.test.cjs "once ready it waits … past the old 30-minute limit": a timing test under load from parallel
  runs; it passes alone). At 6c5710e: 2279 tests, 2275 pass, 4 skipped, 0 failed. At 78bc4b5 (the last code commit):
  2281 tests, 2276 pass, 4 skipped, 1 failed: windows-platform.test.cjs "an app packed for Windows keeps app.asar …"
  read NULs from an asar just written (the createPackage race "Catch-up to 0.1.19" describes; that run took 643 s beside
  another worktree's suite); the file alone passed 3 of 3. discover-assistant-projects' "wired" test failed once in a
  combined run under the same load and passed 6 of 6 after. `npm run build` passes.
- New tests: test/windows-beta.test.cjs (16) and test/connect-windows-beta.test.cjs (3), all platform-injected, so
  they run on the Mac too. Mac-behaviour tests that relied on the runner's own platform now name `platform: 'darwin'`
  (installed-apps, cookies-onboarding-beta's createBrowsers, discover-assistant-projects' Safari test and harness,
  connect.test's detect and fakeConnect, connect-onboarding-beta's and connect-own-signins' harnesses,
  provider-connect's providers, browser-agents' Stop test, create.test's createRules): what they check is unchanged; on
  Windows CI they would otherwise have run the new Windows branches.

### What changed

- **Browsers on Windows** (browser/installed-apps.cjs `platform`, `windowsExes`): a browser counts as installed when its
  program is where its installer puts it (Program Files, Program Files (x86), %LOCALAPPDATA%): Chrome, Brave, Edge,
  Vivaldi, Opera (`%LOCALAPPDATA%\Programs\Opera`), Chromium, Firefox, Comet. No Spotlight (it used to fail with ENOENT
  there, which counted every browser, Safari and Arc included, as installed). Safari and Arc are never found on Windows.
- **The sign-ins question off the Mac** (onboarding/browsers.cjs `copiesSignIns`): "Allow Engelbart to use your …
  sign-ins" is never drawn (list() reports `keychain: 'allowed'`, setKeychain never calls unlock, Safari never listed).
  'allowed' because the run's sign-ins are used, made in Engelbart's window; 'declined' would have skipped every web
  sign-in. discover.cjs `keychainAnswer` answers 'allowed' at once off the Mac: it used to poll prefs for up to 10
  minutes for an answer nobody is asked for, with "Finding recent projects…" on screen.
- **The tools screen** (onboarding/discover.cjs `platform`): history read with node:sqlite on Windows (historySites
  passed execFile to readers.browserHistory, overriding its Windows default: the sqlite3 command, missing there);
  Firefox's profiles under AppData\Roaming\Mozilla\Firefox\Profiles; Safari none; the evidence says "this computer";
  desktop apps by their programs (connect/scan.cjs `installed`/`windowsPrograms`: Claude, Notion, Evernote, Granola,
  Cursor, Obsidian, Perplexity, Zoom, Zotero, OneNote, Google Drive at their installers' usual places); detect's `where`
  strings ("on this Mac", "its chats on this Mac") through `onThisMachine`.
- **Chromium profiles** (connect/readers.cjs): Opera's single profile at AppData\Roaming\Opera Software\Opera Stable;
  Comet's `AppData\Local\Perplexity\Comet\User Data`; `sqliteHere` exported.
- **"this Mac"** (shared/connect-sources.cjs `hostPlatform`, `thisMachine`, `onThisMachine`, `shownNameOn`):
  shownName says "PDFs on this computer" / "Folders on this computer" off the Mac (ids unchanged: they are keys in saved
  choices). The renderer reads the platform preload marks on `<html>`. The folders job's label uses it too.
- **@create on Claude** (bart/ask.cjs `createRules`): on Windows the draft folder is written in Claude Code's POSIX
  rule form (`//c/Users/…/**`); `/C:\Users…/**` never matched, so with dontAsk every write was refused.
- **No console windows** (`windowsHide`): bart/route.cjs and bart/name-chat.cjs quick runs (router, chat titles,
  @create's making line). onboarding/providers.cjs asks Claude Code's plan through Git Bash on Windows (npm's `claude` is
  a shell script execFile cannot start), hidden.
- **The person's own Codex connectors** (connect/own-connectors.cjs `codexListCall`, used by index.cjs): `codex mcp
  list --json` through Git Bash on Windows (`${ENGELBART_CODEX_BIN:-codex}`), hidden; execFile('codex') could not start
  npm's codex.cmd, and the failure read as "none".
- **Sign-ins in the import off the Mac** (connect/session.cjs `platform`):
  - quietly(): no quiet copies (they could only drop Engelbart's own sign-in and wait ~28 s): the "Sign in inside
    Engelbart" card at once.
  - An app with no known sign-in cookie (OneNote, Evernote, Linear's web route) asking for a sign-in, a code or a check
    gets `here`: its popup says "Sign in inside Engelbart" (NeedPopup.jsx needCopy), Open opens Engelbart's sign-in
    window (signin-window.cjs open → openSite), and the step closes once signed in. It used to open the person's
    browser and wait for "I'm signed in", whose copy can never work off the Mac.
  - signInAgain: an agent reporting the same app signed out twice, its cookie still there (off the Mac no site's check
    page is asked), gets the card instead of being left out.
- **Import flow renderer**: ObsidianPicker names files and covers folders with `\` paths too (model/onboarding.js
  `lastPart`, `within`) and says "no vaults on this computer"; no Apple Notes row off the Mac (shared/import-flow.cjs
  `pickerApps`); "Import context using background agents" names Engelbart's own browser off the Mac
  (`agentsConsentText`).
- **Shortcuts** (renderer/ui/keys.js `modDown`, `keyLabels`): next agent (⌘J → Ctrl+J) and a doc's tabs and find
  (⌘T/⌘W/⌘F/⌘G → Ctrl) take Ctrl off the Mac (they checked metaKey alone); the labels in the sidebar, rail and project
  menu say Ctrl+J, Ctrl+1–9, Ctrl+\, and a thread link's tooltip "Alt-click to rename".
- **Agent terminal** (terminal/agent-terminal.cjs): node-pty on Windows takes no signal; Stop and timeouts call kill()
  there (latent: browser agents, its only caller, are Mac-only).
- **Recent repositories** (onboarding/digest.cjs): AppData not looked through on Windows (its hundreds of folders
  filled the 400 looked in at the next level).

### Degraded on purpose (as before, or by the beta's own gates)

- No browser cookie copying, Keychain prompt, Safari, Full Disk Access or folder-access popup off the Mac
  (cookieImport null; disk-access.cjs grants off the Mac; ImportFlow's organize popup is darwin-only).
- Browser agents off the Mac: none (browser-agents.cjs `browsersFor` returns [] off darwin).
- ChatGPT/Claude asked for recent projects off the Mac only through Engelbart's own browser: on a fresh install it is
  signed in to neither, so they answer 'unavailable' and the person adds a project.
- Ctrl+1–9 is the level-2 projects' (the beta's 2026-10-13 choice); doc tabs by number have no key off the Mac (on
  0.1.19 Ctrl+1–9 switched them).

### Left (listed, not changed)

- LLM prompt text that says "this Mac" (connect/prompts.cjs INTERVIEW/IMPORT/SURVEY, skills.cjs, discover.cjs's digest
  note): the librarian could repeat it to a Windows user. Cheap to pass through `onThisMachine` if wanted.
- "Couldn't check the X sign-in (no answer): counted as signed in" is logged for ChatGPT/Claude/Google off the Mac
  (no check page there); the sign-in is used as before.
- tools/detect.cjs: "Codex keeps its sign-in in the keychain" (on Windows: Credential Manager).
- digest.cjs repoOf matches `${repo}/` only: a folder outside the home on Windows gets no repository.
- bart/trace.cjs: "Reading C:\Users\…" (splits on `/`): cosmetic.
- store/library.cjs outsideHomeCopy/`startsWith(homeReal + sep)`: case-sensitive; a home path typed in another case
  is copied rather than linked (the same comparison predates 0.1.19).
- index.cjs openIn/openInProfile run `open` without a platform check: unreachable off the Mac (no cookieImport).
- Aborting a connect turn kills only bash.exe, not the claude.exe/codex.exe under it (agents.cjs execFile with a
  signal; predates 0.1.19). run-processes.cjs's taskkill tree would fix it.
- session.cjs cleanDirect accepts folders under the home only: a project on D:\ is dropped (policy, as /Volumes on
  a Mac).
- Arc on Windows (a Store package) is not found; Comet's and several desktop apps' Windows places are their
  installers' usual ones, not checked on a Windows machine.
- connect/cursor.cjs on Linux (the Linux branch's).

### Tests skipped

Added on Windows only (2026-10-19, after the first CI run); the Mac and Linux run them as before:

| Test file | Test | Reason |
|---|---|---|
| browser-agents.test.cjs | the Engelbart terminal: a login shell… | POSIX terminals only: on Windows the shell is Git Bash (windows-platform.test.cjs) |
| cookies-onboarding-beta.test.cjs | C1: macOS refusing the read anyway… | Windows has no file modes: chmod 000 does not refuse the read |
| provider-connect.test.cjs | the Claude app's own Claude Code counts as installed… | macOS only: the Claude app keeps its Claude Code inside claude.app |

No Mac test deleted, weakened or newly skipped.

### Needs a decision

- Off the Mac the sign-ins answer is fixed at 'allowed' (sign-ins made in Engelbart's window are used). There is no
  way to say "don't use any sign-ins" there; the question it replaces was about copying the browser's, which never
  happens off the Mac.
- "this computer" is the off-Mac word everywhere (Windows and Linux). The Linux branch may have chosen differently.

### Left for a hand test (Windows 11 + Git for Windows, installer from `npm run dist:win`)

1. Install; onboarding: the agent popup, Claude Code's plan read (no console flash), no sign-ins question, no Safari.
2. Import context: the browser list shows only installed browsers; the tools screen's history (Chrome, Edge, Firefox,
   Opera); desktop apps ticked by their programs; nothing says "this Mac".
3. Import from Obsidian (the picker: choose a folder, then a note inside it), Chrome history, a local folder.
4. A web sign-in: ChatGPT signed out → "Sign in inside Engelbart" card at once; OneNote → its popup opens Engelbart's
   window and closes when signed in.
5. An @bart line (routed with no console window), an @create (files written: the rule form), a Build.
6. Ctrl+J, Ctrl+T/W/F in a doc; the labels.
7. Not verified anywhere: Codex @create's workspace-write sandbox on native Windows.

## Catch-up to 0.1.19

Goal (2026-10-12): merge origin/david-onboarding-revisions a215457 (Release 0.1.19) into windows-port, keeping the port
and every change from that branch. The one new change since 0.1.18 is 302efea: on Connect your library's choose screen,
ticking a web app that is not signed in opens its sign-in by itself (opensSignIn and the sign-in chain in
model/connect.js and ConnectLibrary.jsx). Off the Mac every sign-in goes through Engelbart's own sign-in window (no
Keychain modal, no browser hand-off), and nothing crashes or waits forever. Done when one commit is green on all three.
Then release 0.1.19 for Windows and Linux, one upload at a time, each after its dry run: upload:win, check latest.yml;
upload:linux, check latest-linux.yml. The Mac release (latest-mac.yml, the 0.1.19 Mac files, live since 2026-10-12
21:41Z) is not touched; the page ends up offering all three, and install.sh keeps its Linux hand-off.

### Status

- 2026-10-12, **released** 0.1.19 for Windows, then Linux, one upload at a time, each after its dry run
  (`UPLOAD_DRY_RUN=1`). The real uploads were run by David at the prompt (`!`): Claude Code's auto mode turned them away
  from Claude as a production deploy.
  - **Windows from run 38313878122 (4e35a38)**, at David's asking, before e8cff4c's run had finished: that run's
    windows-latest and macos-latest jobs passed (Windows: npm test 1687 tests, 1645 pass, 42 skipped, 0 failed;
    installer; smoke; one-line install), and the app's code is the same as e8cff4c's (only scripts/smoke-windows.cjs and
    two tests changed since). `npm run upload:win 4e35a38`: the installer's 27 parts (5 resent after TLS `bad record
    mac`), its sha512 checked as stored, latest.yml last. The page written: the live Mac 0.1.19 page with the Windows
    section added. Checked live: latest.yml 0.1.19, Engelbart-0.1.19-x64.exe 136880602 bytes; latest-mac.yml and
    install.sh byte for byte as before.
  - **Linux from run 38318669008 (e8cff4c)**, the done commit. `npm run upload:linux e8cff4c`: the AppImage's parts (2
    resent after the same TLS error), its sha512 checked as stored, latest-linux.yml last. The page with the Linux
    section added; install.sh as it was live (the Mac's 0.1.19, which had no hand-off) plus the `>>> linux` hand-off,
    which is scripts/install-mac.sh as built; SHA256SUMS.txt with only install.sh's line changed.
  - Checked live afterwards: latest-mac.yml byte for byte as before the uploads (0.1.19, releaseDate
    2026-10-12T21:41:49Z), the Mac's four files at their sizes and times (the zips 167906795 and 159284855 bytes, the
    dmgs 168314368 and 159763439, all 21:49–21:54Z); latest.yml 0.1.19; latest-linux.yml 0.1.19
    (Engelbart-0.1.19-x86_64.AppImage, 162468350 bytes); the page (r2 index.html; mathetic.com/engelbart/ itself is the
    Vercel landing page) offers Mac, Windows and Linux, all 0.1.19; index.html, install.sh, install-linux.sh,
    install.ps1 and SHA256SUMS.txt as built. The live `curl -fsSL https://mathetic.com/engelbart/install.sh | bash`, run
    on this Mac with ENGELBART_INSTALL_DIR (a scratch folder) and ENGELBART_NO_OPEN=1, installed Engelbart 0.1.19 for
    Apple silicon, its signature verifying. On Linux the same bytes passed CI's one-line install (run 38318669008).
- 2026-10-12, **done on e8cff4c**: run https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38318669008
  passed on all three. macos-latest: npm test 1683 tests, 1679 pass, 4 skipped; build; `npm run package`.
  windows-latest: npm test 1687 tests, 1645 pass, 42 skipped, 0 failed (the same 42: none added); installer;
  smoke-windows (window, PowerShell 7 echo, Git 2.55.0 at C:\Program Files\Git\mingw64\bin\git.exe, clean quit); the
  one-line install put 0.1.19 in %LOCALAPPDATA%\Programs\Engelbart, its smoke passed, and a second run stopped as up to
  date. ubuntu-latest: npm test 1683 tests, 1669 pass, 14 skipped; AppImage; smoke-linux (window, terminal, Git, clean
  quit); the one-line install, then again with the AppArmor profile, sandbox on, smoke passed.
- 2026-10-12: merged a215457 (302efea and the version) as d9be06c, no conflicts. package.json 0.1.19.
- What the new code does off the Mac: the chain opens each sign-in through signInHere, which takes the browser route only
  where signsInViaBrowser says so, and that needs copiesSignIns(platform): the Mac only. Off the Mac main's signInCheck
  answers from Engelbart's own session ('signed-out' when it holds no sign-in, nothing to copy from), so a fresh tick
  opens Engelbart's window (opensSignIn), and signInNote gives no note, so the Keychain modal never shows. The chain's
  only waits are on that window (it answers when signed in, turned away, replaced or closed) and on the Keychain modal,
  which cannot open there. Added to test/connect-auto-signin.test.cjs: on win32 and linux, Google Drive, Gmail and
  ChatGPT ticked together open one window (Drive and Gmail share it), never the browser, and that window closed ends the
  chain with nothing left waiting. Mac `npm test` on the merge: 1682 tests, 1679 pass, 3 skipped; the file's 11 tests
  with the new one pass. Pushed as 4e35a38.
- Run 1 (4e35a38): Windows ✓, macOS ✓, Linux: smoke-linux ended with exit code 1 and no message after its Git check.
  Its window.close() was awaited alone: the app quit before DevTools answered, so Node had nothing left to wait on and
  ended with the exit code set at the start. Now raced with the app's exit and 5 s (scripts/smoke-windows.cjs, which
  smoke-linux runs). Pushed as 3a02b89.
- Run 2 (3a02b89): Linux ✓, macOS ✓, Windows: npm test 2 failed, both fixtures that race on Windows (both passed in run
  1): check-app-modules.test.cjs read an asar right after @electron/asar's createPackage, which resolves at its stream's
  end() before the files are written (Windows read NULs), so the fixture now waits until the archive is as long as its
  header and files; the period test's Downloads and HCI PDFs, two each in the past year, are ordered by their newest,
  and those written together could tie (the in-period Downloads ones are now a day older). Mac `npm test`: 1683 tests,
  1680 pass, 3 skipped. Pushed as e8cff4c.

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 4e35a38 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38313878122 | ✓ | ✓ installer, smoke, install | ✗ smoke (silent exit 1) | the merge and the off-Mac chain test; **Windows released from it** |
| 3a02b89 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38316094828 | ✓ | ✗ npm test (2) | ✓ | smoke's window.close not awaited alone |
| e8cff4c | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38318669008 | ✓ | ✓ installer, smoke, install | ✓ smoke, install | **fixtures: the done commit; Linux released from it** |

## Catch-up to 0.1.18

Goal (2026-10-12): merge origin/david-onboarding-revisions 66ca1f0 (Release 0.1.18) into windows-port, keeping the
port and every change from that branch: Chrome sign-ins on the Mac and Engelbart's own sign-in window, sign-in windows
opening by themselves after Not now/Deny and unticking when closed, the memory question's chat deleted once saved, the
folder-access popup (MATH-110), the "All your context in one place" intro, and 0.1.17's Library phases (Phase C
reverted). Make what the new code needs work on Windows and Linux; Mac-only parts (Keychain, Chrome cookie import,
folder access, installed apps) off or explained there, never crashing. Done when one commit is green on all three. Then
release 0.1.18 for Windows and Linux from that run, one upload at a time (dry run first): upload:win, check latest.yml;
upload:linux, check latest-linux.yml. The Mac release (latest-mac.yml, the 0.1.18 Mac files) is not touched; the page
ends up offering all three, and the Mac's install command installs on Linux too.

### Status

- 2026-10-12, **released** 0.1.18 for Windows, then Linux, from run 38261058005 (8bafd93), one upload at a time, each
  after its dry run. `CLOUDFLARE_ACCOUNT_ID=… npm run upload:win 8bafd93`: the installer's 27 parts went up (2 resent
  after TLS `bad record mac`), its sha512 checked as stored, latest.yml last. The page it wrote is the live Mac page
  (0.1.18, Mac-only since the Mac upload) with the Windows section added; install.sh and SHA256SUMS.txt untouched.
  Checked live: latest.yml 0.1.18, Engelbart-0.1.18-x64.exe 136875613 bytes. Then `npm run upload:linux 8bafd93`
  (the AppImage's parts resent 7 times after the same TLS error, its sha512 checked as stored, latest-linux.yml last): the page with
  the Linux section added; install.sh as it was live plus the `>>> linux` hand-off (byte for byte scripts/install-mac.sh,
  which CI's Linux install test ran); SHA256SUMS.txt with only install.sh's line changed. Checked live afterwards:
  latest.yml 0.1.18; latest-linux.yml 0.1.18 (Engelbart-0.1.18-x86_64.AppImage, 162464873 bytes; the first Linux
  release to go live); latest-mac.yml byte for byte as before the uploads (0.1.18, 13:26:15Z), the four Mac files at
  their sizes and sums; the page (r2 index.html) offers Mac, Windows and Linux, all 0.1.18; install.sh, install-linux.sh
  and install.ps1 as built. The live `curl -fsSL https://mathetic.com/engelbart/install.sh | bash`, run on this Mac with
  ENGELBART_INSTALL_DIR (a scratch folder) and ENGELBART_NO_OPEN=1, installed Engelbart 0.1.18 for Apple silicon, its
  signature verifying. On Linux the same bytes passed CI's one-line install on ubuntu-latest (run 38261058005); a live
  run in Docker was not possible here (Docker Desktop did not start).
- 2026-10-12, **done on 8bafd93**: run https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38261058005
  passed on all three (Linux on a re-run of its job: attempt 1's AppImage step got a 504 from GitHub downloading
  electron-builder's AppImage tool, after its npm test passed). macos-latest: npm test 1672 tests, 1668 pass, 4 skipped;
  build; `npm run package`. windows-latest: npm test 1676 tests, 1634 pass, 42 skipped, 0 failed (the same 42: none
  added); installer; smoke-windows (window, PowerShell 7 echo, Git 2.55.0 at C:\Program Files\Git\mingw64\bin\git.exe,
  clean quit); the one-line install put 0.1.18 in %LOCALAPPDATA%\Programs\Engelbart, its smoke passed, and a second run
  stopped as up to date. ubuntu-latest: npm test 1672 tests, 1658 pass, 14 skipped; AppImage; smoke-linux (window,
  terminal, Git, clean quit); the one-line install, then again with the AppArmor profile, sandbox on, smoke passed.
- 2026-10-12: merged 66ca1f0 (35 commits since f2cf948; 74 files) as 51263a3. One conflict: library.cjs's exports
  (ours adds markdownStem, theirs describeRows, headAbout, dayOf, TITLE_RULES, aboutRow): both kept. package.json 0.1.18.
  Mac `npm test`: 1670 tests, 1667 pass, 3 skipped. Run 1 (51263a3,
  https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38258865947): macOS ✓, Linux ✓, Windows: npm test 4
  failed (below).
- What the new code does off the Mac:
  - **Chrome cookie import and the Keychain** (browser/import-cookies.cjs): created on macOS only, as before (index.cjs
    passes null elsewhere). web-signin.cjs takes null as "no browser to bring a sign-in over from", and the renderer
    (model/connect.js copiesSignIns, signsInViaBrowser, signInGate) sends every sign-in elsewhere to Engelbart's own
    sign-in window (connect/signin-window.cjs, a BrowserWindow on the Stage's session): no Keychain modal, no `open -b`.
  - **Installed apps** (browser/installed-apps.cjs: /Applications, Spotlight): made on every platform but only asked by
    the cookie importer (null off the Mac) and warmBrowsers (darwin only), so it never looks or runs mdfind there.
  - **Folder access (MATH-110)** was not gated: on Windows and Linux the choose screen would have shown "Let Engelbart
    read your folders? macOS will ask…" and, until it was answered, the PDF scan and the folder search kept out of
    Desktop, Documents and Downloads. Now connect/folder-access.cjs protects nothing off the Mac (`platform`, default
    process.platform): needed() and ask() are empty (no popup, no folders.json), guard() reads everything; session.cjs's
    folder search (MATH-117) is not told about macOS there and skips only hidden folders and ~/AppData. The Mac is as
    before. Tests: connect-folder-access.test.cjs and connect.test.cjs give `platform: 'darwin'` to the Mac's checks
    (they run on every platform), and two new tests check Windows and Linux.
  - Left as on the Mac: the wording "PDFs on this Mac" and the PDFs row's tooltip about macOS (as in 0.1.13); the
    sign-in window, Gmail, GitHub organizations, the Library phases, the intro and the memory chat's delete are
    platform-neutral (Electron windows, net requests, the store).
- Run 1's Windows failures, all fixtures: connect-folder-access.test.cjs's home `/Users/ada`, which path.resolve makes
  `D:\Users\ada` on Windows (now resolved in the fixture); installed-apps.test.cjs's fake file system keyed by `/`
  paths (now takes Windows' `\`); a PDF-folder order test whose files' times could tie on Windows (the Downloads files
  are now a minute older). Mac `npm test`: 1672 tests, 1669 pass, 3 skipped. Pushed as 8bafd93.

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 51263a3 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38258865947 | ✓ | ✗ npm test (4) | ✓ | the merge |
| 8bafd93 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38261058005 | ✓ | ✓ installer, smoke, install | ✓ (re-run: 504) | **folder access Mac-only; fixtures: the done commit, released** |

## Catch-up to 0.1.16

Goal (2026-10-10): merge origin/david-onboarding-revisions f2cf948 (Release 0.1.16) into windows-port, so package.json
is 0.1.16. The one change since 0.1.15 is 95a0d7b: the guided setup, started inside a project, skips Create and adds a
Welcome workspace to that project (App.jsx, screens/Onboarding.jsx, model/onboarding.js, ipc.cjs welcome-workspace,
store/onboarding.cjs addWelcomeWorkspace, preload, tests). Keep the Windows changes, npm test, push, CI green on all
three; log here in a `[skip ci]` commit; an upload:win dry run on the merge commit; the upload command handed over with
that commit's hash (not HEAD, the log commit). No real upload.

### Status

- 2026-10-10, **done on 360abfa** (the merge; contains f2cf948; package.json 0.1.16): run
  https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38111754450 passed on all three. macos-latest: npm test
  1498 tests, 1494 pass, 4 skipped. windows-latest: 1502 tests, 1460 pass, 42 skipped, 0 failed (the same 42 as
  before: none added); installer, smoke and one-line install as before. ubuntu-latest: 1498 tests, 1484 pass, 14
  skipped.
  `UPLOAD_DRY_RUN=1 CLOUDFLARE_ACCOUNT_ID=… npm run upload:win 360abfa` (nothing sent) took run 38111754450's installer
  and listed: Engelbart-0.1.16-x64.exe (136801046 bytes), its .blockmap, index.html, install.ps1,
  SHA256SUMS-windows.txt, then latest.yml (version 0.1.16); live Windows feed still 0.1.15. The page it writes names
  Engelbart-0.1.16-x64.exe beside the Mac's 0.1.16 dmgs (arm64 and x64, already live). Real upload not run: handed
  over as `CLOUDFLARE_ACCOUNT_ID=… npm run upload:win 360abfa`.
- 2026-10-10: merged f2cf948 (95a0d7b and the release; 13 files). No conflicts. Review for Windows: the new
  `addWelcomeWorkspace` and ipc `welcome-workspace` go through projects.createWorkspace / setWorkspaceContext and
  getting-started's existing files, with no new paths, shell commands or file modes; the rest is the renderer's. The new
  test's regex with a literal `\n` over App.jsx holds on Windows because `.gitattributes` checks out LF; its
  `/tmp/guided-paper.pdf` is only a stored library path, as in test/db.test.cjs. No Windows fixes needed.
  Mac `npm ci` and `npm test`: 1498 tests, 1495 pass, 3 skipped, 0 failed.

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 360abfa | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38111754450 | ✓ | ✓ installer, smoke, install | ✓ | **the merge; green on all three, contains f2cf948: the done commit** |

## Catch-up to 0.1.15

Goal (2026-10-10): bring windows-port up to origin/david-onboarding-revisions a32399a (Release 0.1.15: 0.1.14's quieter
Refine button and starting view without each agent's activity, 1420675; then 378015a: Connect's imports join the
Welcome workspace's context, the Welcome walkthrough's Brainstorm asks three cards and hands off to @discover, a
one-time "New: a guided setup" popup and Settings ▸ Guided setup, and the sandbox's wakeAll removed), keeping the
Windows port and every change from that branch, then make what the new code needs work on Windows
(docs/windows-port.md). package.json says 0.1.15. Done when one commit containing a32399a passes CI on windows-latest
and macos-latest (Linux may fail) and `UPLOAD_DRY_RUN=1 CLOUDFLARE_ACCOUNT_ID=… npm run upload:win` lists the 0.1.15
installer, latest.yml, install.ps1, SHA256SUMS-windows.txt and index.html. No real upload: the command is handed over.
(The goal as pasted was cut off after "lists"; read as the same list and hand-over as "Catch-up to 0.1.13".)

### Status

- 2026-10-10, **released** by the person: `npm run upload:win 486d806` (run 38087893503's installer). Without a commit
  it had refused, as it should: HEAD was the `[skip ci]` log commit 1d8305c, which has no CI run. One part of the
  installer (21/27) hit a TLS read error (`bad record mac`) and was sent again; the stored installer then matched
  latest.yml's sha512, and latest.yml went last. Checked live afterwards (read only): latest.yml version 0.1.15 at the
  r2.dev URL and mathetic.com/engelbart; Engelbart-0.1.15-x64.exe 136797891 bytes; SHA256SUMS-windows.txt as built
  (exe f460f50e…, install.ps1 6214d526…); the page names Engelbart-0.1.15-x64.exe beside the Mac's 0.1.15 dmg.
- 2026-10-10, **done on 486d806** (the merge itself; contains a32399a; package.json 0.1.15): run
  https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38087893503 passed on all three. macos-latest: npm test
  1497 tests, 1493 pass, 4 skipped; build; `npm run package`. windows-latest: npm test 1501 tests, 1459 pass, 42
  skipped, 0 failed (the same 42 as "Catch-up to 0.1.13": none added); installer; smoke-windows (window, PowerShell 7
  echo, Git at C:\Program Files\Git\mingw64\bin\git.exe, clean quit); the one-line install put Engelbart 0.1.15 in
  %LOCALAPPDATA%\Programs\Engelbart and its smoke passed too. ubuntu-latest: npm test 1497 tests, 1483 pass, 14
  skipped; AppImage, smoke and install (sandbox off without the AppArmor profile, as before). No Windows fixes were
  needed.
  `UPLOAD_DRY_RUN=1 CLOUDFLARE_ACCOUNT_ID=… npm run upload:win` (nothing sent) took run 38087893503's installer and
  listed: Engelbart-0.1.15-x64.exe (136797891 bytes), its .blockmap, index.html, install.ps1, SHA256SUMS-windows.txt,
  then latest.yml (version 0.1.15); the live Windows feed is still 0.1.10. The page it writes is the live one (Mac
  0.1.15 already there) with its Windows section set to 0.1.15. Real upload not run: handed over.
- 2026-10-10: merged a32399a (4 commits since 6bb60b6; 34 files). No conflicts; scripts/smoke-windows.cjs (the
  packaged-Windows smoke test here, the old multi-window one there) is not among the files that branch changed.
  package.json: 0.1.15. Review of the new code for Windows:
  - `<dataRoot>/.guided-setup.json` and `<project>/.context/getting-started.json` (src/main/store/getting-started.cjs):
    named with path.join and written with projects.writeTextAtomic, as the rest of the store; a dot file's name is
    fine on Windows.
  - src/main/sandbox/activity.cjs deleted: nothing on this branch used it (the port never touched it).
  - The rest (Connect's session and tools, ask.cjs, ipc.cjs, index.cjs, the sandbox manager) adds no paths built with
    `/`, shell commands, file modes or Mac locations; the remaining changes are the renderer's.
  Mac `npm ci` and `npm test`: 1497 tests, 1494 pass, 3 skipped, 0 failed. Pushed for the first CI run.

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 486d806 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/38087893503 | ✓ | ✓ installer, smoke, install | ✓ | **the merge; green on all three, contains a32399a: the done commit** |

## Catch-up to 0.1.13

Goal (2026-10-09): bring windows-port up to origin/david-onboarding-revisions 6bb60b6 (Release 0.1.13: Hudson's 0.1.11
plus the onboarding changes: the stacked Connect choose screen, the filled Refine button, the starting view with status
instead of the opening line, the old Welcome! note), keeping the Windows port and every change from that branch, then
make what the new code needs work on Windows (docs/windows-port.md). package.json says 0.1.13. Done when one commit
containing 6bb60b6 passes CI on windows-latest and macos-latest (Linux may fail) and `UPLOAD_DRY_RUN=1
CLOUDFLARE_ACCOUNT_ID=… npm run upload:win` lists the 0.1.13 installer, latest.yml, install.ps1,
SHA256SUMS-windows.txt and index.html. No real upload: the command is handed to the person.

### Status

- 2026-10-09, **done on c204d0d** (contains 6bb60b6; package.json 0.1.13): catch-up run 4
  (https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37963133942) passed on all three. macos-latest: npm
  test 1484 tests, 1480 pass, 4 skipped; build; `npm run package`. windows-latest: npm test 1488 tests, 1446 pass, 42
  skipped, 0 failed; installer; smoke-windows (window, PowerShell 7 echo, Git at C:\Program
  Files\Git\mingw64\bin\git.exe, clean quit); the one-line install put Engelbart 0.1.13 in
  %LOCALAPPDATA%\Programs\Engelbart. ubuntu-latest: npm test 1484 tests, 1470 pass, 14 skipped; AppImage, smoke and
  install all passed (run 3's quit-step exit did not come back: a flake). Mac `npm ci` and `npm test` locally: 1484
  tests, 1481 pass, 3 skipped.
  `UPLOAD_DRY_RUN=1 CLOUDFLARE_ACCOUNT_ID=… npm run upload:win` (nothing sent) took run 37963133942's installer and
  listed: Engelbart-0.1.13-x64.exe (136780916 bytes), its .blockmap, index.html, install.ps1, SHA256SUMS-windows.txt,
  then latest.yml (version 0.1.13); live Windows feed now 0.1.10. The page it writes is the live one (Mac 0.1.14,
  released meanwhile from another branch) with the Windows section set to 0.1.13. The live site has no Linux section,
  install.sh no Linux hand-off, and no latest-linux.yml: Linux was never uploaded. Real upload not run: handed over.
- 2026-10-09: merged 6bb60b6 (23 commits since cf474cb's base; 139 files). One conflict: scripts/smoke-windows.cjs,
  which on that branch is still the old multi-window smoke test (windows-port renamed it scripts/smoke-new-window.cjs,
  "Needs a decision" below, and smoke-windows.cjs is the packaged-Windows smoke test): kept ours, and that branch's two
  changes to it (ENGELBART_CONNECT_OFFER off; the sidebar's project menu in place of the breadcrumb) applied to
  smoke-new-window.cjs. package.json: 0.1.13. Mac `npm ci` and `npm test`: 1482 tests, 1479 pass, 3 skipped, 0 failed.
  Pushed for the first CI run. To look at on Windows: the new Build git guard (src/main/build/git-guard.cjs: a
  `#!/bin/sh` git first on the agent's PATH, hooks through GIT_CONFIG_PARAMETERS) and the Connect module
  (src/main/connect: Apple Notes through osascript, other apps' folders).
- 2026-10-09, review of the new code for Windows (3c342a9):
  - **Build git guard** (src/main/build/git-guard.cjs). A Build's agent starts in Git for Windows' bash, whose PATH is
    POSIX (/c/Users/…). The command put the guard's Windows folder (C:\…, a ":" inside it) first, so the shim was never
    found; and the shim, comparing PATH entries and git folders as strings, would have taken itself for the real git
    and never matched the Build's repository. Now on Windows: `PATH="$(cygpath -u "$ENGELBART_BUILD_GUARD"):$PATH"`
    (as launch.cjs does for Engelbart's Git), the shim's own folder through cygpath, the repository compared by
    identity (`-ef`, so case and short names like RUNNER~1 don't matter), includeIf with forward slashes and `gitdir/i`,
    the git folder named by its long name (realpathSync.native). Claude Code runs commands in that bash, so it meets
    the shim; a git started outside it (PowerShell, by git.exe) meets the hooks, which Git for Windows runs with its
    own sh. The Mac's shim, hooks and command are byte for byte as before (checked). build-reach.test.cjs runs the
    guard test on Windows through Git Bash; build.test.cjs expects the Windows command there.
  - **Connect** (src/main/connect). Apple Notes already refuses off a Mac; browser sign-in import is still created on
    macOS only (as in 0.1.10). The readers looked only under ~/Library/Application Support: on Windows they now also
    look under AppData (Roaming: Obsidian's obsidian.json, Cursor's state.vscdb; Local: Chrome, Brave, Edge, Chromium,
    Vivaldi's User Data). A browser's history is read with node:sqlite on Windows (no sqlite3 command; Chrome's times
    are past 2^53, read as BigInt), an export's .zip with Windows' own tar (System32\tar.exe; no unzip). Tests in
    windows-platform.test.cjs: the locations everywhere (platform given), history and .zip on Windows. Left as on the
    Mac: which apps count as installed (it looks for .app bundles), the PDF folders (~/Downloads, ~/Documents and
    ~/Desktop are the same names on Windows), and the wording "on this Mac".
  - Mac `npm test`: 1483 tests, 1480 pass, 3 skipped, 0 failed.
- 2026-10-09, catch-up run 1 (6c96a36, the merge) failed on all three:
  - **The guard test, everywhere.** It reads `git config user.name`, which exits 1 on a runner with no Git identity
    (this Mac has one). The test now gives one the way a person's `git -c` would (GIT_CONFIG_PARAMETERS, which the guard
    keeps after its own); the commands checked are the same. Checked here with an empty HOME and GIT_CONFIG_GLOBAL=/dev/null.
  - **Windows, 10 more.**
    - Connect showed home paths as `~\Vault`: shownPath now writes `~/…` on Windows too, and expandPath takes `~\…` back.
    - A note titled "Why do novices skip tests?" could not be saved: `?` is not allowed in a Windows file name. A Markdown
      copy's file name (library.cjs markdownStem) now has none of `<>:"/\|?*`, no trailing dot or space, and no device
      name (CON, NUL…). The row keeps the title. A Mac names the file as before. Test in windows-platform.test.cjs.
    - A picture test compared `path.relative` output with `/` (a fixture; now in `/`).
    - The reach test's agent compared policy.gitDir with fs.realpathSync. It now uses realpathSync.native on Windows
      (long names, as gitCommonDir gives them). The status assertion now names the task's error.
    - The runner test (already fixed in 3c342a9).
- 2026-10-09, run 2 (3c342a9): the guard test now ran in Git Bash on Windows through every reading command before
  `config user.name` (the identity, above); the runner test passed. Run 3 (ff632a0): **macOS green**. Windows: 2
  left, the same kind: a fixture built with `path.relative` (noteFiles) and memory.cjs's own `~\…` path (now `~/…`).
  Linux: tests green (1484, 1470 pass, 14 skipped); the packaged app's smoke test passed the window, the terminal and
  Git, then exited 1 at the quit step without printing its error (Linux may fail; looked at below if it stays).

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 6c96a36 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37958518571 | ✗ 1 test | ✗ 11 tests | ✗ 1 test | the merge; the guard test needs a Git identity; Windows: shown paths, a `?` in a file name, the guard in Git Bash |
| 3c342a9 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37959774124 | ✗ 1 test | ✗ 10 tests | ✗ 1 test | the guard in Git Bash; the runner test passes on Windows |
| ff632a0 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37960794781 | ✓ | ✗ 2 tests | ✗ smoke (quit step) | ~/ paths, file names, the guard test's identity |
| c204d0d | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37963133942 | ✓ | ✓ installer, smoke, install | ✓ | **green on all three, contains 6bb60b6: the done commit** |

### Tests skipped on Windows (new code since 0.1.10)

None added by this catch-up. Windows' 42 = the 38 of "Catch-up to 0.1.10" + the 3 of "Linux" (engelbart-launch and
the two install-linux.sh tests: POSIX scripts) + one 0.1.13 test that skips by its own condition, unchanged:

| Test file | Test | Reason |
|---|---|---|
| connect.test.cjs | a Chromium browser: bookmarks, and its history by site from a copy of the locked database | `t.skip('no sqlite3')`: it makes its fixture with the sqlite3 command, which Windows lacks. Its bookmarks part runs first; the history on Windows (node:sqlite) is tested in windows-platform.test.cjs |

POSIX-only assertions guarded inside a test (the rest runs): the guard shim's execute bit (build.test.cjs, "the real
runner"; Windows has none, bash reads the #! line).

## Linux

Goal (2026-10-07): Engelbart installs and runs on Linux x64 with the Mac's command, `curl -fsSL
https://mathetic.com/engelbart | bash`. Done when one commit on windows-port passes CI on ubuntu-latest, windows-latest
and macos-latest (Linux no longer allowed to fail); on ubuntu-latest CI also serves the AppImage, latest-linux.yml and
install.sh from a local folder, installs with `curl … | bash`, smoke tests the installed copy and sees a second run stop
as up to date; the Windows install step still passes; `UPLOAD_DRY_RUN=1 npm run upload:linux` lists the right files.
Decisions from the person (2026-10-07): the Windows release live since 19:46 UTC is theirs (upload:win on
f210c51) and stays; Chromium's sandbox stays on wherever it can, and where Ubuntu's AppArmor blocks it the
installer offers (with sudo) an AppArmor profile, as Chrome's package does, before falling back to no sandbox.

### What it is

- Tests: the 6 Linux failures of install run 1 (fd68788): 4 ran the real zsh, which the runner lacks (the app then
  falls back to bash, as it should): CI installs zsh, as a Mac has it. 2 stopped a leftover process group: its folder
  was read with /usr/sbin/lsof, which Linux lacks; on Linux it is read from /proc/<pid>/cwd
  (`src/main/build/run-processes.cjs`, the Mac's lsof path unchanged). The apt step: 4-minute tries with apt's own
  retries and timeouts, 3 times, inside a 15-minute limit. `continue-on-error` for Linux removed.
- `npm run dist:linux` (`scripts/package-linux.mjs`, Linux x64 only): the release build as dist:mac and dist:win make it,
  then `Engelbart-<v>-x86_64.AppImage` and latest-linux.yml. node-pty has no Linux prebuild; `npm ci` compiles
  build/Release/pty.node (N-API), which is staged into prebuilds/linux-x64 (the app leaves node-pty's build folder out);
  afterPackLinux checks it and the launcher are in the app.
- `build/linux/engelbart-launch`, beside the binary: everything starts the app through it. The sandbox stays on when
  chrome-sandbox is set up by root or user namespaces are allowed (for everyone, or for Engelbart by an AppArmor
  profile); otherwise it starts with `--no-sandbox` and prints why on stderr.
- `scripts/install-linux.sh` (published as install-linux.sh): x86_64 only; Git required (says `apt`/`dnf`/`pacman`/
  `zypper install git` by /etc/os-release, and stops); latest-linux.yml; stops when ~/.local/share/engelbart/version is
  that version (ENGELBART_FORCE=1 overrides); sha512 with coreutils only; the AppImage unpacked with
  `--appimage-extract` (no FUSE/libfuse2 needed) into ~/.local/share/engelbart/app; `~/.local/bin/engelbart` → the
  launcher; the AppImage's .desktop entry with Exec= the launcher, and its icons in ~/.local/share/icons. AppArmor:
  when the sandbox is off only for want of a profile, it offers (on /dev/tty; ENGELBART_APPARMOR=yes/no answers it)
  to install /etc/apparmor.d/engelbart-<uid> (`userns`, unconfined otherwise, as Chrome's) with sudo. Its last line
  says "Chromium's sandbox: on|off: why".
- `scripts/install-mac.sh` gains a block between `# >>> linux` and `# <<< linux`, before its macOS check: on Linux it
  fetches install-linux.sh from the same folder and execs it. On a Mac it is skipped (test/install-mac.test.cjs runs
  the script for real, unchanged).
- Release site: `writeLinuxSite` → release/upload-linux/: the AppImage, latest-linux.yml, install-linux.sh,
  SHA256SUMS-linux.txt, the live page with a marked Linux section, the live install.sh with the Linux block put in (or
  replaced), and the live SHA256SUMS.txt with only install.sh's line changed. dist:mac keeps the live Linux section
  (`liveLinux`) as it keeps the Windows one.
- `npm run upload:linux` (`scripts/upload-linux.sh`): the run whose ubuntu, windows and macos jobs all passed,
  `gh run download` of engelbart-linux-appimage, version against package.json, release/upload-linux/, then
  upload-release.sh with UPLOAD_FEED=latest-linux.yml (latest-linux.yml last). upload-release.sh only gained the
  AppImage's content type; its Mac dry run is identical (diffed).
- smoke-linux (`scripts/smoke-linux.cjs`): smoke-windows.cjs's steps on Linux, through the launcher, plus which way
  the sandbox is (SMOKE_SANDBOX=on|off to require one).
- Tests: test/release-linux.test.cjs (the site files, the hand-off block, the Mac page with both sections, the
  launcher; on Linux the install through install.sh with a stand-in AppImage, up to date, ENGELBART_FORCE, and the
  refusals: no Git, ARM, bad checksum, unreachable folder).

### Tests skipped on Linux

None added for Linux. The 14 tests that skip on ubuntu-latest (Linux run 1, 896d930) skip by their own conditions,
already in the code, because what they test is macOS's or Windows' alone:

| Test file | Tests | Their condition |
|---|---|---|
| bundled-git.test.cjs | findBundledGit …; the real one: Build's git commands … | macOS only: Engelbart's own Git ships for the Mac alone; the second needs `fetch-git.mjs` |
| install-mac.test.cjs | the 2 tests of install-mac.sh run by the app | macOS only (codesign, ditto, an .app) |
| pretend-mac tests | the 8 "pretend Mac" scenarios | macOS only (scenarios of a Mac's login shell and installers) |
| release-windows.test.cjs | install-windows.ps1: a download that does not match … | runs Windows PowerShell |
| attachments test | macOS: a real docx through textutil, a real heic through sips | textutil and sips are macOS's |

New tests that are Linux's or POSIX's own (release-linux.test.cjs): the 2 that run install-linux.sh skip off Linux
(bash, GNU coreutils, /proc); the launcher's test skips on Windows (a POSIX shell script). On Windows that makes 41
skips: the 38 before and these 3.

### Status

- 2026-10-08, **done on 9a3d773**: Linux run 6 (https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37709695365),
  run conclusion success, Linux counting. ubuntu-latest ✓: npm test 1399 tests, 1385 pass, 14 skipped, 0 failed;
  `npm run dist:linux` (Engelbart-0.1.10-x86_64.AppImage, 160516769 bytes, and latest-linux.yml); smoke-linux on
  release/linux-unpacked (sandbox off by AppArmor, window, bash terminal echo, Git 2.55.0 at /usr/bin/git, clean quit);
  `curl -fsSL http://127.0.0.1:8766/install.sh | bash` (install.sh handing over to install-linux.sh) installed 0.1.10
  into ~/.local/share/engelbart with ~/.local/bin/engelbart and the menu entry and icon, and said "Chromium's sandbox:
  off: AppArmor lets only programs with a profile make user namespaces, and Engelbart has none."; smoke-linux on the
  installed copy passed (sandbox off, as said); the second run: "Engelbart 0.1.10 is already installed in
  /home/runner/.local/share/engelbart and up to date." with no download; then ENGELBART_FORCE=1 ENGELBART_APPARMOR=yes
  added /etc/apparmor.d/engelbart-1001 with sudo, said "Chromium's sandbox: on: the AppArmor profile
  /etc/apparmor.d/engelbart-1001 lets Engelbart make user namespaces.", and smoke-linux passed with the sandbox on.
  windows-latest ✓ (1402 tests, 1361 pass, 41 skipped, 0 failed; the Windows install step passed); macos-latest ✓
  (1399 tests, 1395 pass, 4 skipped; `npm run package`). Against the last green run (5a399d9) no Mac or Windows test
  is missing, and the only new skips there are the new Linux tests (2 on the Mac, 3 on Windows); no `test(` line was
  removed. `UPLOAD_DRY_RUN=1 npm run upload:linux` takes run 37709695365 and lists Engelbart-0.1.10-x86_64.AppImage,
  index.html, install-linux.sh, install.sh, SHA256SUMS-linux.txt, SHA256SUMS.txt, then latest-linux.yml; against the
  live files, install.sh gains only the Linux block, SHA256SUMS.txt only install.sh's line, and the page only the
  Linux section after the Windows one. Not uploaded.
  Still to know: a Mac release made from a branch without this (hudsons-feedback's install-mac.sh and release-site.mjs)
  writes install.sh without the Linux block and a page without the Windows and Linux sections; until windows-port's
  scripts are what Mac releases are made from, run upload:win and upload:linux again after a Mac release.
- 2026-10-08, Linux run 5 (7b6b329, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37708412073):
  macOS ✓. Linux and Windows: 1 test each, the same: sourceOf's `/usr/bin/git` → "apple" ran under the runner's own
  platform; it now names macOS (`'darwin'`), with Linux's "other" beside it.
- 2026-10-08, Linux run 4 (43ff71f, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37705773404):
  macOS ✓, Windows ✓. Linux: tests ✓, AppImage ✓, smoke-linux no longer hangs, and its new diagnostic showed the
  login shell does find /usr/bin/git. The app missed it because the tool check took /usr/bin/git for Apple's stub on
  every platform (`src/main/tools/detect.cjs`): it asked xcode-select, found no developer folder, and called Git
  missing. The stub check (and the "apple" source) are now macOS's only; the Mac's tests of it pass `platform: 'darwin'`
  (they ran under the runner's own platform before, which was right only on a Mac and on Windows' C:\ paths), and a new
  test reads Linux's /usr/bin/git as Git itself, without xcode-select.
- 2026-10-07, Linux run 3 (f3851a6, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37699844498):
  macOS ✓, Windows ✓. Linux npm test ✓ (1398 tests, 1384 pass, 14 skipped, 0 failed); `npm run dist:linux` made
  Engelbart-0.1.10-x86_64.AppImage and latest-linux.yml. smoke-linux on release/linux-unpacked: the launcher found the
  runner's AppArmor restricting user namespaces and started the app without the sandbox (as designed: "AppArmor lets
  only programs with a profile make user namespaces, and Engelbart has none"); the window loaded; a bash terminal
  echoed; then the tool check reported no Git, and smoke-linux hung after failing until the job's hour was up (run
  reported cancelled). Now: on Linux the app runs in its own process group, killed at the end, and smoke-linux exits
  itself; a failed Git check prints what the login shell answers to the same lookup; the Linux smoke and install
  steps have a 10-minute limit.
- 2026-10-07, Linux run 2 (392567f, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37697931884):
  macOS ✓, Windows ✓ (the install step still passes). Linux: 1398 tests, 1383 pass, 14 skipped, 1 failed: the refusals
  test's no-Git case ran `bash` by name with a PATH that holds only uname, so it was not found (ENOENT); its bad
  checksum, unreachable folder and ARM cases passed. Now bash is run by its full path.
- 2026-10-07, Linux run 1 (896d930, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37696023134):
  macOS ✓ (1398 tests). Linux npm test: 1398 tests, 1383 pass, 14 skipped, 1 failed — the 6 earlier failures pass
  (zsh installed; /proc for a leftover's folder), the apt step finished; the failure was the new test's own: it wrote
  its bad-checksum folder with the site writer, which refuses one (now the served feed is changed afterwards).
  Windows: 1401 tests, 1359 pass, 41 skipped, 1 failed: the new site test checked install.sh's execute bits, which
  Windows has not (now POSIX only, as zotero's 0600). The steps after npm test did not run on either.
- 2026-10-07: written; Mac tests pass locally. Pushed for the first CI run.

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 896d930 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37696023134 | ✓ | ✗ 1 test | ✗ 1 test | both the new test's own; the 6 old Linux failures pass |
| 392567f | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37697931884 | ✓ | ✓ | ✗ 1 test | the no-Git case could not find bash |
| f3851a6 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37699844498 | ✓ | ✓ | ✗ smoke (cancelled) | tests ✓, AppImage ✓; smoke: sandbox off by AppArmor, window, terminal ✓, Git not found, then hung |
| 43ff71f | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37705773404 | ✓ | ✓ | ✗ smoke | the app took /usr/bin/git for Apple's stub |
| 7b6b329 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37708412073 | ✓ | ✗ 1 test | ✗ 1 test | sourceOf's Apple case ran unnamed |
| 9a3d773 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37709695365 | ✓ | ✓ install step ✓ | ✓ install, smoke, up to date, AppArmor profile | **run success; the done commit** |

## One-command install

Goal (2026-10-07): install Engelbart on Windows with one PowerShell line, `irm https://mathetic.com/engelbart/install.ps1
| iex`, as the Mac's `curl -fsSL https://mathetic.com/engelbart | bash`. Done when one commit on windows-port passes CI
on windows-latest and macos-latest, and on windows-latest CI serves the installer, latest.yml and install.ps1 from a
local folder, runs the line against it, smoke tests the installed copy and runs it again to see "already up to date";
`UPLOAD_DRY_RUN=1 npm run upload:win` lists the right files.

### What it is

- `scripts/install-windows.ps1` (published as install.ps1, the download folder written in): reads latest.yml, refuses
  ARM and 32-bit PCs, stops when that version is installed (registry uninstall entry, else
  %LOCALAPPDATA%\Programs\Engelbart; ENGELBART_FORCE=1 installs anyway), downloads `Engelbart-<v>-x64.exe`, checks its
  sha512, waits for a running Engelbart to quit, installs with `/S /currentuser` (`/allusers` when it was installed for
  everyone), checks for Git for Windows (winget `Git.Git` when missing, else the git-scm.com link) and opens Engelbart
  (not with ENGELBART_NO_OPEN=1). ENGELBART_DOWNLOADS, ENGELBART_INSTALL_DIR as on the Mac. Windows PowerShell 5.1 and
  PowerShell 7; ASCII; never `exit` (it would close the person's window under `iex`); failures are one line,
  "Engelbart was not installed: …", with $LASTEXITCODE 1.
- `npm run dist:win` (`scripts/package-windows.mjs`, Windows only): the release build, as dist:mac makes it (production,
  minified main process; the minifier moved to `scripts/app-source.mjs`, which package-mac.mjs imports unchanged),
  then the x64 installer and latest.yml. CI runs it with ENGELBART_DOWNLOAD_URL=https://mathetic.com/engelbart and keeps
  the .exe, its blockmap and latest.yml as the `engelbart-windows-installer` artifact.
- `scripts/release-site.mjs`: `writeWindowsSite` writes release/upload-win/ (installer, blockmap, latest.yml,
  install.ps1, SHA256SUMS-windows.txt, and the live download page with a marked Windows section put in or replaced).
  The page is shared, so dist:mac now asks the live latest.yml (`liveWindows`) and keeps the Windows section; with no
  Windows release live, the Mac page and every other file are byte for byte what they were (checked against the old
  release-site.mjs, and in test/release-windows.test.cjs).
- `npm run upload:win` (`scripts/upload-windows.sh`, from the Mac): the green CI run of the commit (HEAD by default),
  `gh run download`, latest.yml's version against package.json, release/upload-win/, then the Mac's uploader
  (`scripts/upload-release.sh`) with UPLOAD_FEED=latest.yml: the same bucket and prefix, 5 MiB retried parts, the
  installer checked against latest.yml as stored, latest.yml last. upload-release.sh only gained UPLOAD_FEED and
  UPLOAD_COMMAND, defaulting to the Mac's; its dry run on a Mac release folder is identical to before (diffed).
- Tests: test/release-windows.test.cjs (site files, the Mac page unchanged, refusals, liveWindows, the script's
  shape; on Windows the script itself in Windows PowerShell: a bad checksum and an unreachable folder). CI step
  "Install with the one-line command (Windows)": the real install in Windows PowerShell 5.1, smoke-windows on
  %LOCALAPPDATA%\Programs\Engelbart\Engelbart.exe, then the second run in PowerShell 7.

### Status

- 2026-10-07, **done on 5a399d9**: install run 3 (https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37675665317),
  run conclusion success. macos-latest ✓ (1391 tests, 1389 pass, 2 skipped: the bundled-Git test's own and the new
  Windows-only PowerShell test; `npm run package`). windows-latest ✓ (1394 tests, 1356 pass, 38 skipped, 0 failed;
  dist:win; smoke on win-unpacked; `irm http://127.0.0.1:8765/install.ps1 | iex` in Windows PowerShell 5.1 installed
  0.1.10; smoke-windows on the installed copy; the second run: "already installed … and up to date", no download).
  Linux failed its apt step at the new 10-minute limit (allowed). `UPLOAD_DRY_RUN=1 npm run upload:win` takes run
  37675665317 and lists Engelbart-0.1.10-x64.exe, its blockmap, index.html, install.ps1, SHA256SUMS-windows.txt,
  latest.yml. No test file but the new one changed since 27d034e.
- 2026-10-07, noticed after the done run: a Windows release is live in the bucket, uploaded 19:46 UTC (the installer
  from install run 2, f210c51, by its sha512; latest.yml, install.ps1, SHA256SUMS-windows.txt and index.html with the
  Windows section). Not from this run, which only ever ran upload:win with UPLOAD_DRY_RUN=1 (no Worker deployed).
- 2026-10-07, install run 2 (f210c51, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37667770887):
  macOS ✓ (1391 tests, 1389 pass, 2 skipped: the bundled-Git test's own and the new Windows-only PowerShell test);
  Windows ✓ (1394 tests, 1356 pass, 38 skipped, 0 failed; dist:win; `irm | iex` in Windows PowerShell 5.1 installed
  0.1.10; smoke-windows on the installed copy; the second run, PowerShell 7: "Engelbart 0.1.10 is already installed
  in C:\Users\runneradmin\AppData\Local\Programs\Engelbart and up to date."). Linux hung an hour in apt-get and was
  cancelled, which marks the whole run cancelled: the apt step now has a 10-minute limit, and upload:win picks the run
  whose windows-latest and macos-latest jobs passed instead of the run's overall status. `UPLOAD_DRY_RUN=1 npm run
  upload:win` against it: Engelbart-0.1.10-x64.exe (135150341 bytes) and its blockmap, then index.html, install.ps1,
  SHA256SUMS-windows.txt, then latest.yml; install.ps1 reads https://mathetic.com/engelbart/; the page is the live one
  with the Windows section added. Pushed for a run on these two changes.
- 2026-10-07, install run 2's change: install.ps1 finds the install folder from the uninstall entry's UninstallString (the
  NSIS installer writes no InstallLocation), and compares only three parts of the exe's version (its ProductVersion
  is 0.1.10.0) in the fallback.
- 2026-10-07, install run 1 (fd68788): macOS ✓. Windows: npm test 1394 tests, 1356 pass, 38 skipped, 0 failed
  (the new script tests ran in Windows PowerShell: bad checksum, unreachable folder); `npm run dist:win` made the
  installer and latest.yml; the first `irm | iex` (Windows PowerShell 5.1) installed 0.1.10 into
  %LOCALAPPDATA%\Programs\Engelbart; smoke-windows passed on the installed copy. The second run installed again
  instead of stopping: the uninstall entry has no InstallLocation, so the version came from the exe, 0.1.10.0.
- 2026-10-07: written; Mac tests for it pass locally. Pushed for the first CI run.

### CI runs

| Commit | Run | macOS | Windows | Notes |
|---|---|---|---|---|
| fd68788 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37665101651 | ✓ | ✗ second run reinstalled | install, smoke of the installed copy ✓; up-to-date check missed the registry entry |
| f210c51 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37667770887 | ✓ | ✓ install, smoke, up to date | Linux hung in apt (run reported cancelled) |
| 5a399d9 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37675665317 | ✓ | ✓ install, smoke, up to date | **run success; the done commit** (Linux failed at the apt limit, allowed) |

## Catch-up to 0.1.10

Goal (2026-10-07): bring `windows-port` up to `hudsons-feedback` f53c66d (Release 0.1.10: 87 commits since 22d738c —
Zotero and Overleaf connections, web boxes, PDF canvas changes, Settings, Stage cookie encryption and more), keep the
Windows port and every hudsons-feedback change, then make what the new code needs on Windows work, per
docs/windows-port.md. Done when CI passes on windows-latest and macos-latest for one commit containing f53c66d.

### Status

- 2026-10-07, **done on d7b90fd** (contains f53c66d): catch-up run 2
  (https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37605945169) passed on macos-latest (npm ci; npm test
  1385 tests, 1384 pass, 1 skipped, the bundled-Git test's own; build; `npm run package`) and windows-latest (npm ci;
  npm test 1388 tests, 1350 pass, 38 skipped, 0 failed; build; installer; smoke-windows: window, PowerShell 7 echo,
  Git at C:\Program Files\Git\mingw64\bin\git.exe, clean quit). Linux fails, allowed. Every test name on
  origin/hudsons-feedback (f53c66d) is on this branch; none deleted, none newly skipped on the Mac.
- 2026-10-07: merged origin/hudsons-feedback into windows-port (19df8f6). Conflicts: `src/main/index.cjs` (both
  sides' imports kept), `DocEditor.jsx` and `doc-editor-answer-line.test.cjs` (this side had only the cherry-picked
  f2d0ac0, so hudsons-feedback's versions). Mac `npm ci` and `npm test` locally: 1384 tests, 1384 pass. Pushed for
  the first CI run on the new code.
- 2026-10-07, catch-up run 1 (020338b): macOS passed (1384 tests, 1383 pass, the bundled-Git skip). Windows: 3
  failures, all fixtures: web-boxes (crop paths written with `/`; the app writes the platform's separator, as
  `path.join` does), web-highlights (a saved page's path built with `+ '/index.html'`; now `path.join`, with the page
  context in the failure message), zotero (the 0600 mode of the saved key: POSIX only, guarded). Review of the new code
  for Windows: browser sign-in import (Keychain, ~/Library) is already created on macOS only, so on Windows it is not
  offered; the terminal box's ↑ history now reads PowerShell's (PSReadLine's ConsoleHost_history.txt) first on
  Windows, then Git Bash's (`src/main/shell-history.cjs`; the Mac reads zsh's first, as before; test in
  windows-platform.test.cjs). Zotero's storage (~/Zotero/storage) is where Zotero keeps it on Windows too.

### Tests skipped on Windows (new code since 22d738c)

None added by the port. One test of the new code skips on Windows by its own condition (unchanged from
hudsons-feedback):

| Test file | Test | Reason |
|---|---|---|
| overleaf.test.cjs | readZip reads a zip made by the zip command (stored and deflated entries) | `t.skip('no zip command')` when `zip -v` fails: it makes its fixture with the `zip` program, which Windows and Git for Windows don't have; readZip itself runs in the test's other cases |

Windows' 38 skips = the port's 20 + the 17 already in the code before (listed in "Tests skipped on Windows" below) +
this one. POSIX-only assertions guarded inside a test (the rest of it runs): the 0600 mode of Zotero's saved key
(zotero.test.cjs; Windows has no such modes).

### CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 020338b | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37604197560 | ✓ | ✗ 3 tests | ✗ (allowed) | the merge; Windows: path fixtures, a file mode |
| d7b90fd | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37605945169 | ✓ | ✓ installer, smoke | ✗ (allowed) | **green on both, contains f53c66d: the done commit** |

## Where things stand

- 2026-10-06, the open decisions settled (see "Needs a decision"): Engelbart's own git keeps LF on Windows
  (`core.autocrlf=false`, with a test that the Mac's arguments are unchanged), and the old multi-window smoke test is
  `scripts/smoke-new-window.cjs`. Run 15 on de68414 passed on macos-latest (1021 tests, 1020 pass, the bundled-Git skip;
  `npm run package`) and windows-latest (1024 tests, 987 pass, 37 skipped, 0 failed; installer; smoke test).

- 2026-10-06, **done on 4e2d95b**: run 14 (https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37438849695)
  passed on macos-latest (npm ci; npm test 1020 tests, 1019 pass, 1 skipped, the bundled-Git test's own; build;
  `npm run package`) and windows-latest (npm ci; npm test 1023 tests, 986 pass, 37 skipped, 0 failed; build; the
  installer; smoke-windows: window loaded, PowerShell 7 terminal echo, Git at C:\Program Files\Git\mingw64\bin\git.exe,
  clean quit). Linux fails, allowed. This commit has the pid-reuse guard. This log update is pushed with [skip ci].

- 2026-10-06, run 13 (e2e764d, a log-only commit): macOS passed; the Windows job never finished `npm test`: after
  49 minutes GitHub reported "The hosted runner lost communication with the server" (no test log kept). It may be
  GitHub's, but it showed a real risk in the Windows stop: Windows uses a pid again soon after its process ends, and a
  process can keep the number of a parent long gone, so the walk from our shell's pid could take in someone else's
  program (on CI, possibly the runner's; on a person's PC, any program) and kill it. The walk now counts a process as
  a descendant only if it started after its parent and after Engelbart started the command (CIM's CreationDate), and
  names exactly those to taskkill, without /T (which follows parent numbers alone); /T only when the list can't be
  read. 55fbf8b's green run stands, but this fix is a code change, so the done commit is the next green run.

- 2026-10-06, **done**: run 12 (55fbf8b, https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37431216041)
  passed on macos-latest and windows-latest. macOS: npm ci, npm test (1020 tests, 1019 pass, 1 skipped: the
  bundled-Git test, skipped wherever vendor/git is not fetched, as on hudsons-feedback), npm run build, npm run
  package (Engelbart.app, ad hoc signed). Windows: npm ci, npm test (1023 tests, 986 pass, 37 skipped, 0 failed),
  npm run build, the installer (release\Engelbart-0.1.9-x64.exe, kept as the run's artifact), smoke-windows on
  release/win-unpacked/Engelbart.exe: the window loaded, a PowerShell 7 terminal echoed a line, the login shell's
  script found Git 2.55.0 at C:\Program Files\Git\mingw64\bin\git.exe, the app quit cleanly. Linux still fails
  (continue-on-error). Every test on hudsons-feedback (f2d0ac0) is on this branch; none was removed.

- 2026-10-06, run 11 (fe85167): macOS passed; Windows 0 failures but 2 files cancelled at the 300 s per-file limit CI
  sets (build.test.cjs, sandbox-manager.test.cjs). Nothing hung: every test in them took about twice as long as in
  run 10 (build.test.cjs's 32 finished tests 293 s, against 175 s for all 37 in run 10), a slow runner. The CI limit
  is now 15 minutes, still well inside the job's 60.

- 2026-10-06, run 10 (86755ab): macOS passed (1020, 1019 pass, 1 skip); Windows 1 failure, new and intermittent
  (it passed in runs 8 and 9): build.test.cjs's restored project kept its Build's worktree at the old folder. On
  Windows `git worktree move` renames a folder, which fails while any program has a file in it open (a virus scan of
  what the Build just wrote, a process just stopped). `build/git.cjs` moveWorktree now tries again for up to 5 s on
  Windows (once on the Mac, as before).

- 2026-10-06, run 9 (bc06f3c, with f2d0ac0): macOS passed (1020 tests, 1019 pass, the 1 bundled-Git skip); Windows
  1 failure, the one seen in run 7 and not in run 8: run-step's "Engelbart's processes" test gives a desktop app 0.4 s
  to prove it stays up, and expects `echo bye` to have exited within it; Git Bash's login shell sometimes takes longer
  than 0.4 s to start. That window is now 5 s on Windows (0.4 s on the Mac, as before), the check unchanged.

- 2026-10-05, run 8 (98c688e) passed on macos-latest and windows-latest (Linux, allowed to fail, still fails): npm ci,
  npm test (macOS 1017 tests, 1016 pass, 1 skipped: the bundled-Git test, which skips wherever vendor/git is not
  fetched, as before this branch; Windows 1020, 983 pass, 37 skipped, 0 failed), the Windows installer built
  (Engelbart-0.1.9-x64.exe, kept as the run's artifact), smoke-windows passed on release/win-unpacked/Engelbart.exe
  (window, PowerShell 7 terminal echo, Git found by the login shell at C:\Program Files\Git\mingw64\bin\git.exe,
  clean quit), `npm run package` passed on the Mac. The Mac's lookup with Apple's python3: 0.06 s; http.server
  answered in 1 s. Then, comparing tests with `hudsons-feedback`: it has one commit made after this branch was cut
  (f2d0ac0, "Keep an answer line's look while the caret is on it", with a new test file). Cherry-picked here (not a
  merge), so every test on hudsons-feedback is on this branch; the Mac suite passes locally with it (1020/1020).
  The final CI run is on that commit (see "CI runs").

- 2026-10-05, run 7 (99c752e): Windows' stop now works (the dev-server test and run-step's two "stops it" pass);
  new: `exit $?` in a login shell prints "logout" into the command's output (run_command's test) and slowed a quick
  command, so the fork now comes from an exit trap (`trap : EXIT`, which disables bash's exec of the last command and
  keeps its status). build-git's file timed out in runs 4-7: most likely Git Credential Manager (Git for Windows'
  system credential helper) waiting for a sign-in in its clone test; CI clears that helper on Windows, and the test's
  `git credential fill` has a 30 s cap so a hang shows as the failure it is. Mac: the probe found the cause (below);
  CI gives the tests Apple's python3, and the probe workflow is removed.
  Probe (https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37423716675): on the macOS 26 runner Homebrew's
  python3 waits 35 s for any name lookup (even libc's gethostbyaddr from it, and getaddrinfo of the host name);
  Apple's /usr/bin/python3 (0.08 s) and dscacheutil answer at once; restarting mDNSResponder, a new host name, no
  multicast, and blocking mDNS changed nothing. macOS holds a non-Apple program's lookups.

- 2026-10-05, run 6 (7886431): the same failures (Mac 1, Windows 3 + 5 file timeouts), with the data asked for.
  Mac: getfqdn(127.0.0.1) took 35.0 s before and after both resolver fixes (/etc/hosts names, public DNS), so the
  time goes elsewhere; a temporary macOS-only workflow (`.github/workflows/probe-mac-lookup.yml`) now times each
  lookup path and mDNSResponder changes, and logs mDNSResponder during one lookup. Windows: Git Bash's ps had no
  entry for the login shell and gave every npm bash parent 1: for a single `-c` command bash execs, and Git Bash's
  exec hands the shell's identity to a new process that neither Windows nor Git Bash lists under it. The run step's
  command is now followed by `exit $?` on Windows, so bash forks it as a child that Git Bash's ps lists under the
  shell, and the stop's walk reaches npm, its cmd and its node.

- 2026-10-05, run 5 (51ee430): macOS 1 failure, Windows 3 failures + 3 file timeouts (CRLF, fixtures, guideTitle now
  pass). Mac cause found: on the macOS runner `socket.getfqdn('127.0.0.1')` took 35.03 s, and http.server answered
  after 35 s, against the test's 8. A runner resolver problem, not the app's: a new CI step adds 127.0.0.1's names to
  /etc/hosts and, if still slow, sets public DNS servers, timing the lookup after each. Windows: npm's server still
  outlives the stop; Git Bash's ps walk found none of npm's processes, for a reason not yet seen; the stop test now
  prints Git Bash's ps table as the stop reads it.

- 2026-10-05, step 7 continued: run 4 (dd1ac32): macOS 1 failure (the same page test, 4th time: its message now shows
  python3's server printed nothing in 8 s), Windows 4 failures + 3 file timeouts. Windows: the process listing showed
  why npm's server survives: Git Bash's exec starts a new Windows process and the one that started it exits, so npm's
  bash has a parent that is gone and neither /T nor a walk of Windows' parents reaches it. The stop now also walks
  Git Bash's own process table (`usr\bin\ps.exe -e`: pid, parent, Windows pid). And `guideTitle` reads a Windows
  path (`C:\…`, encoded) as a paper's address, as `splitTarget` does. Mac, a new approach: http.server looks its
  address's name up (`socket.getfqdn`) before it listens, which the import-only warm-up never did; CI now times that
  lookup and the test's own command once before the tests (it warms them, and the log says which was slow).

- 2026-10-05, step 7 continued: run 3 (ac2fc2f) left macOS 1 failure (run-step's page test: nothing answered within
  8 s, CI only; its message now prints what the task and the server saw) and Windows 22 failed plus 2 files timed out.
  Causes and fixes, pushed as run 4: CRLF in the tests' repositories (the app's git drops GIT_* variables, so
  GIT_CONFIG_NOSYSTEM never reached it; CI now sets `core.autocrlf false` system-wide on Windows); `npm start` started
  through Git Bash kept serving after `taskkill /T` (the stop now lists the tree through PowerShell's CIM and names
  each descendant, which also explains run-step's two "stops it" tests and the file timeouts); a credential-helper
  path written into a gitconfig with `\` (an escape there); Windows-path fixtures in browser, library-home, bart;
  Codex's auth.json is hard-linked on Windows, so the context test checks the inode there; local Claude Code found as
  `claude.exe` with a Windows path; Stage addresses with a drive letter (`C:` or `C%3A`) decoded.

- 2026-10-05, step 7 in progress: run 2 left macOS 1 failure (the login shell's python3 was not the one warmed up;
  fixed) and Windows 64; fixes for most of them pushed as run 3 (see "Tests skipped on Windows" and the step 7 entry).

- 2026-10-05, steps 2–6 and 8 written and pushed; step 7 (making the failing tests work on Windows) is next.
  Run 1 (the unchanged code): macOS 2 failures (CI-only: shallow clone; python3's first start), Windows 84 failures,
  Linux 7.
- 2026-10-05, step 1 (CI): `.github/workflows/ci.yml` added.

## Done-criteria checklist

- [x] CI passes on windows-latest and macos-latest for the same commit (4e2d95b, run 14; 55fbf8b, run 12, before
  the pid-reuse guard)
- [x] `npm ci` and `npm test` exit 0 on both
- [x] Windows installer builds and `scripts/smoke-windows.cjs` passes on the packaged app
- [x] `npm run package` still builds on the Mac; no Mac test deleted, weakened or newly skipped (test names compared
  with hudsons-feedback f2d0ac0: none missing; the Mac's one skip is the bundled-Git test's own, as before)

## What changed

- `.github/workflows/ci.yml`: matrix macos-latest / windows-latest / ubuntu-latest (Linux `continue-on-error`), Node 22.
  Full history (a test reads old commits), python3 warmed up before the tests (a test gives `python3 -m http.server`
  8 s to answer; a runner's first python3 takes longer), `--test-timeout=900000` so a hung test fails instead of
  holding the job. Windows: `electron-builder --win nsis --x64`, the installer kept as an artifact, then the smoke test.
  Mac: `npm run package` (ad hoc signing).
- Step 2, install and packaging: `postinstall` is `scripts/postinstall.mjs` (the same `npm run rebuild` on the Mac;
  nothing on Windows, which uses node-pty's prebuilds). `electron-builder.config.cjs`: `win` block (nsis + zip, x64,
  `build/icon.ico`), Mac-only `files` (strip win32 prebuilds) and `extraResources` (bundled Git) moved under `mac`,
  `afterPackWindows` (node-pty's Windows modules present, `assertAppModules` on the Windows layout).
  `scripts/check-app-modules.cjs` reads `resources/app.asar` too. `build/icon.ico` made by the new
  `scripts/make-icon-ico.cjs` from `design/assets/app-icon.png` (also run by `scripts/make-icon.cjs`).
- Step 3, shell layer (`src/main/terminal/launch.cjs`): `resolveShell` returns Git for Windows' bash.exe on Windows
  (git on PATH → `..\..\bin\bash.exe`, `%ProgramFiles%\Git`, `%LOCALAPPDATA%\Programs\Git`); when missing, the
  ProgramFiles path (commands fail as not found) and `src/main/index.cjs` shows one dialog with the link.
  `loginShellArgs` converts ENGELBART_AGENT_PATH / ENGELBART_GIT_BIN with `cygpath -p` under Git Bash. Terminals:
  `createLaunchSpec` opens `pwsh.exe` or Windows PowerShell; Claude Code / Codex run in it with `-NoExit`.
  `shell-rc.cjs` writes no zsh launcher on Windows. `session-manager.cjs`: no SIGKILL on Windows (node-pty refuses
  signals there). `windowsHide: true` on every bash run (ask, runner, summarizer, build shell, tools, run step).
- Step 4, tools: `detect.cjs` lookup prints Windows paths (`cygpath -w`, `.exe` added) and Windows install places
  (`%USERPROFILE%\.local\bin\*.exe`, `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, `%ProgramFiles%\nodejs`);
  `install.cjs` installs Claude Code with `irm https://claude.ai/install.ps1 | iex`, Codex with
  `npm install -g @openai/codex`, never runs xcode-select or brew on Windows, and rolls Claude Code back by copy.
  `manager.cjs` joins ENGELBART_AGENT_PATH with `path.delimiter`.
- Step 5, processes (`build/run-processes.cjs`): `taskkill /T /F /PID` on Windows, every descendant named (listed
  first with PowerShell's `Get-CimInstance Win32_Process` and Git Bash's `ps -e`, whose parents survive its exec:
  /T alone left npm's server running on CI); `groupPids` and `stopLeftover`
  (ps, lsof) skipped there. `build/manager.cjs` copies node_modules with `fs.promises.cp` on Windows.
- Step 6, paths: `store/projects.cjs` Stage addresses use `path.isAbsolute`. `context/summarizer.cjs` links Codex's
  auth.json with a hard link on Windows (a file, so no junction; a symlink needs Developer Mode), else a copy.
- Step 7, tests: `scripts/test.mjs` sets TEMP/TMP (os.tmpdir() on Windows) and GIT_CONFIG_NOSYSTEM=1 on Windows (Git for
  Windows' system autocrlf turned the test repos' files into CRLF). `.gitattributes`: `* text=auto eol=lf` (tests
  compare sources byte for byte). Source fixes found by tests: asar entries read with the platform separator
  (`check-app-modules.cjs`), catalog paths and activity labels written with `/`, `sourceOf` matches either separator,
  `bundleOf` is POSIX (Mac only). New `test/windows-platform.test.cjs`: Git Bash lookup order, PowerShell launch,
  cygpath PATH, no zsh launcher, Windows tool places and installers, rollback by copy, taskkill, the Windows asar
  layout; and, registered on Windows only, real Git Bash, a real PowerShell PTY, and a dev server started and stopped.
- Step 8, `scripts/smoke-windows.cjs`: starts the packaged app hidden with throwaway home, root and user data
  (`--user-data-dir`), drives it over DevTools: window loads, a terminal echoes a line, the tool check (a POSIX script
  through the login shell, Git Bash on Windows) finds Git at a Windows path, the app quits with code 0. Passes
  locally against the packaged Mac app.

## Tests skipped on Windows (with reasons)

Each is `{ skip: process.platform === 'win32' && '<reason>' }` (or `!== 'darwin'` where noted), so the Mac runs it as
before.

| Test file | Test | Reason |
|---|---|---|
| bundled-git.test.cjs | findBundledGit: the app's Resources first… (`!== 'darwin'`) | macOS only: Engelbart's own Git ships for the Mac alone, and a launcher without the execute bit is what is passed over |
| launch.test.cjs | createLaunchSpec uses login-interactive shell args… | POSIX terminals only: a Windows terminal opens PowerShell (windows-platform.test.cjs) |
| launch.test.cjs | an agent started from the terminal gets Engelbart's own Git first… | same |
| launch.test.cjs | Claude Code and Codex installed where the login shell's PATH misses them… | same |
| shell-rc.test.cjs | the wrappers are written once; sessions launch through an executable launcher… | POSIX terminals only: the zsh launcher; a Windows terminal starts PowerShell as it is |
| sandbox-launch.test.cjs | sandbox adapter applies environment overrides… | E2B sandbox helper: runs in the sandbox's Linux, never on Windows (fcntl, os.killpg) |
| sandbox-launch.test.cjs | application ownership, socket diagnostics… | same |
| sandbox-audit.test.cjs | npm audit discovery, vulnerability exit codes… | same |
| sandbox-install.test.cjs | remote helper bounds inspection… | same |
| tools.test.cjs | detectTools: an agent off the login PATH is found where its installer puts it… | macOS install locations; Windows' are tested in windows-platform.test.cjs |
| tools.test.cjs | installAgent downloads the vendor's installer to a file first… | macOS installers (curl, then bash); Windows uses PowerShell's and npm |
| tools.test.cjs | installGit: Apple's dialog… | macOS only: Apple's Command Line Tools installer |
| tools.test.cjs | rollback points a launcher back… | macOS installers link the launcher; on Windows the rollback copies |
| tools.test.cjs | manager: an update that leaves the launcher broken is put back… | same |
| tools.test.cjs | real zsh: an alias is reported to the terminal… | macOS only: runs the real zsh and its aliases |
| bart.test.cjs | while Engelbart's own Git stands in, a question's CLI finds it first on PATH | macOS only: Engelbart's own Git ships for the Mac alone |
| build.test.cjs | while Engelbart's own Git stands in, a Build's agent, setup and checks find it first | same |
| run-step.test.cjs | a desktop app opened from Review: its window is brought forward… | macOS only: AppKit, ps |
| run-step.test.cjs | a process group left behind is stopped only while its leader… | POSIX only: lsof and process groups; Windows skips the sweep |
| run-step.test.cjs | a kept copy goes when Engelbart quits, and one a crash left behind is swept… | same (the crash half); Windows' stop is tested in windows-platform.test.cjs |

Timing: run-step.test.cjs "Engelbart's processes" gives an app 5 s on Windows, 0.4 s on the Mac (Git Bash's login
shell starts more slowly than zsh); what it checks is unchanged.

Skips already in the code before this branch (unchanged here), which their own conditions also apply on Windows:

| Test file | Tests | Condition and reason |
|---|---|---|
| install-mac.test.cjs | install-mac.sh, run by the app: … (2 tests) | `process.platform !== 'darwin' && 'macOS only'`: the Mac's update installer script |
| mac-states.test.cjs | pretend Mac … (8 scenarios) | `process.platform !== 'darwin' && 'macOS only'`: Mac accounts, Homebrew, ~/.zshrc |
| shell-rc.test.cjs | through the launcher, zsh runs the user rc files…; the shell that replaces an agent…; a ZDOTDIR…; Engelbart's own Git comes first on PATH…; an agent whose folder the person's PATH misses… (5 tests) | `!fs.existsSync('/bin/zsh')`: they run the real zsh, which Windows has not |
| stage-files.test.cjs | macOS: a real docx through textutil, a real heic through sips | `process.platform !== 'darwin'`: macOS's textutil and sips (HEIC/Word previews are out of scope on Windows) |
| bundled-git.test.cjs | the real one: Build's git commands run on it… | `!real`: Engelbart's own Git not fetched (skipped on CI's Mac too) |

Run 12's 37 Windows skips are the 20 in the first table and these 17.

Assertions that only hold on POSIX and are guarded with `process.platform !== 'win32'` inside a test (the rest of the
test runs): file modes 0600/0700 in github.test.cjs, defaults.test.cjs, sandbox-local.test.cjs (Windows has no such
modes). Expectations written with the platform's separator (`path.join`, `path.sep`) or a real file outside home
(`OUTSIDE`: /etc/hosts on the Mac, Windows' hosts file) are the same values on the Mac.

## CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 6f65820 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37413145769 | ✗ 2 tests | ✗ 84 tests | ✗ 7 tests | baseline code; Mac failures are CI-only (shallow clone, python3 warm-up) |
| 324fcbe | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37414993723 | ✗ 1 test | ✗ 64 tests | ✗ | steps 2–6, 8; run-step's page test still slow on the Mac (login shell's python3) |
| ac2fc2f | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37416228818 | ✗ 1 test | ✗ 22 tests + 2 file timeouts | ✗ | step 7; the warm-up showed both python3s are /usr/local/bin's, so the Mac failure is something else; Windows: CRLF, npm's server outliving taskkill /T, fixtures |
| dd1ac32 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37418091552 | ✗ 1 test | ✗ 4 tests + 3 file timeouts | ✗ | CRLF and fixtures fixed; npm's server still outlives stop (its bash's Windows parent is gone); guideTitle and C:\ |
| 51ee430 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37419892150 | ✗ 1 test | ✗ 3 tests + 3 file timeouts | ✗ | Mac: getfqdn(127.0.0.1) 35 s on the runner; Windows: npm's server still outlives stop |
| 7886431 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37421579146 | ✗ 1 test | ✗ 3 tests + 5 file timeouts | ✗ | Mac lookup still 35 s after /etc/hosts and DNS; Windows: Git Bash's exec orphans npm (ps table) |
| 99c752e | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37423625799 | ✗ 1 test | ✗ 2 tests + build-git file timeout | ✗ | Windows stop fixed; "logout" from `exit` in a login shell; Mac fix not in this run |
| 98c688e | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37425057114 | ✓ | ✓ installer, smoke | ✗ (allowed) | first green run for both |
| bc06f3c | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37426600854 | ✓ | ✗ 1 test | ✗ (allowed) | f2d0ac0 brought in; Git Bash's login shell slower than run-step's 0.4 s app window |
| 86755ab | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37427843412 | ✓ | ✗ 1 test | ✗ (allowed) | worktree move refused on Windows (a file open in it), intermittent |
| fe85167 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37429145718 | ✓ | ✗ 2 files over 300 s | ✗ (allowed) | a slow runner: every test twice as long |
| 55fbf8b | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37431216041 | ✓ | ✓ installer, smoke | ✗ (allowed) | green on both (before the pid-reuse guard) |
| e2e764d | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37433090130 | ✓ | ✗ runner lost after 49 min | ✗ (allowed) | log-only commit; led to the pid-reuse guard |
| 4e2d95b | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37438849695 | ✓ | ✓ installer, smoke | ✗ (allowed) | **green on both with the pid-reuse guard: the done commit** |
| de68414 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37445676731 | ✓ | ✓ installer, smoke | ✗ (allowed) | decisions applied (LF on Windows, smoke-new-window.cjs): the branch's latest green |

## Needs a decision

Decided 2026-10-06:

- Line endings: Engelbart's own git passes `-c core.autocrlf=false` on Windows (`src/main/build/git.cjs`), so a
  Build's files are checked out and committed as the repository has them (LF), whatever Git for Windows' default.
  The Mac's arguments are unchanged. CI still sets it system-wide on Windows for the git commands the tests run
  themselves.
- Homebrew python3 on a Mac: left as it is. The 35 s lookup was seen only on GitHub's runner; a page served with it
  would still show, slowly. Act on it only if someone reports a slow page.
- `scripts/smoke-windows.cjs` already existed on `hudsons-feedback`: the smoke test for several app *windows*
  (File ▸ New Window), not for Windows the OS. The Windows smoke test keeps `scripts/smoke-windows.cjs` (the spec and
  CI name it); the old one is now `scripts/smoke-new-window.cjs` (unchanged apart from its usage line), named for what
  it tests. Tell Hudson when this merges: `node scripts/smoke-windows.cjs` now runs the Windows smoke test.

## Baseline

`hudsons-feedback` (22d738c) on this Mac: 1008 tests, 1007 pass, 1 skipped (the bundled-Git test, until
`node scripts/fetch-git.mjs` has run). With this branch's changes (2026-10-05, run 4's commit): 1017 tests, 1017 pass,
0 failed, 0 skipped (vendor/git present; the 9 new ones are windows-platform.test.cjs's cross-platform tests).

## Left for a hand test

On Windows 11 with Git for Windows: install from the CI artifact, open a project, open a terminal, sign in to Claude
Code, run an @bart line and a Build, save a page from the Stage.
