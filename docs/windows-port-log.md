# Windows port log (MATH-26)

The run that follows docs/windows-port.md, on branch `windows-port` (cut from `hudsons-feedback` at 22d738c).
Newest status first; the sections below are kept current.

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
