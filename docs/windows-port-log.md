# Windows port log (MATH-26)

The run that follows docs/windows-port.md, on branch `windows-port` (cut from `hudsons-feedback` at 22d738c).
Newest status first; the sections below are kept current.

## Where things stand

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

- [ ] CI passes on windows-latest and macos-latest for the same commit
- [ ] `npm ci` and `npm test` exit 0 on both
- [ ] Windows installer builds and `scripts/smoke-windows.cjs` passes on the packaged app
- [ ] `npm run package` still builds on the Mac; no Mac test deleted, weakened or newly skipped

## What changed

- `.github/workflows/ci.yml`: matrix macos-latest / windows-latest / ubuntu-latest (Linux `continue-on-error`), Node 22.
  Full history (a test reads old commits), python3 warmed up before the tests (a test gives `python3 -m http.server`
  8 s to answer; a runner's first python3 takes longer), `--test-timeout=300000` so a hung test fails instead of
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
  first with PowerShell's `Get-CimInstance Win32_Process`: /T alone left npm's server running on CI); `groupPids` and `stopLeftover`
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

## Needs a decision

- Git for Windows checks files out with CRLF by default (`core.autocrlf true`). The app's Builds and repositories
  follow whatever the person's Git says; CI turns it off only for the tests. Whether Engelbart should pass
  `-c core.autocrlf=false` on Windows (agents write LF) is a product choice, left as it is.

- `scripts/smoke-windows.cjs` already existed on `hudsons-feedback`: the smoke test for several app *windows*
  (File ▸ New Window), not for Windows the OS. The spec names that same file for the Windows smoke test. Worked
  around: the old script moves, unchanged apart from its usage line, to `scripts/smoke-app-windows.cjs`, and the
  Windows smoke test takes `scripts/smoke-windows.cjs`. Rename either if you prefer.

## Baseline

`hudsons-feedback` (22d738c) on this Mac: 1008 tests, 1007 pass, 1 skipped (the bundled-Git test, until
`node scripts/fetch-git.mjs` has run). With this branch's changes (2026-10-05, run 4's commit): 1017 tests, 1017 pass,
0 failed, 0 skipped (vendor/git present; the 9 new ones are windows-platform.test.cjs's cross-platform tests).

## Left for a hand test

On Windows 11 with Git for Windows: install from the CI artifact, open a project, open a terminal, sign in to Claude
Code, run an @bart line and a Build, save a page from the Stage.
