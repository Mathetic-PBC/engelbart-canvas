# Windows port log (MATH-26)

The run that follows docs/windows-port.md, on branch `windows-port` (cut from `hudsons-feedback` at 22d738c).
Newest status first; the sections below are kept current.

## Where things stand

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
- Step 5, processes (`build/run-processes.cjs`): `taskkill /T /F /PID` on Windows; `groupPids` and `stopLeftover`
  (ps, lsof) skipped there. `build/manager.cjs` copies node_modules with `fs.promises.cp` on Windows.
- Step 6, paths: `store/projects.cjs` Stage addresses use `path.isAbsolute`. `context/summarizer.cjs` links Codex's
  auth.json with a hard link on Windows (a file, so no junction; a symlink needs Developer Mode), else a copy.
- Step 8, `scripts/smoke-windows.cjs`: starts the packaged app hidden with throwaway home, root and user data
  (`--user-data-dir`), drives it over DevTools: window loads, a terminal echoes a line, the tool check (a POSIX script
  through the login shell, Git Bash on Windows) finds Git at a Windows path, the app quits with code 0. Passes
  locally against the packaged Mac app.

## Tests skipped on Windows (with reasons)

(none yet)

## CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|
| 6f65820 | https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/37413145769 | ✗ 2 tests | ✗ 84 tests | ✗ 7 tests | baseline code; Mac failures are CI-only (shallow clone, python3 warm-up) |

## Needs a decision

- `scripts/smoke-windows.cjs` already existed on `hudsons-feedback`: the smoke test for several app *windows*
  (File ▸ New Window), not for Windows the OS. The spec names that same file for the Windows smoke test. Worked
  around: the old script moves, unchanged apart from its usage line, to `scripts/smoke-app-windows.cjs`, and the
  Windows smoke test takes `scripts/smoke-windows.cjs`. Rename either if you prefer.

## Baseline

`hudsons-feedback` (22d738c) on this Mac: 1008 tests, 1007 pass, 1 skipped (the bundled-Git test, until
`node scripts/fetch-git.mjs` has run). With this branch's changes: 1008 pass, 0 failed (vendor/git present).

## Left for a hand test

On Windows 11 with Git for Windows: install from the CI artifact, open a project, open a terminal, sign in to Claude
Code, run an @bart line and a Build, save a page from the Stage.
