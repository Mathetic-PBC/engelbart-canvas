# Windows port (MATH-26): spec for an unattended /goal run

Engelbart builds and runs only on macOS today. This run makes it build, pass its tests and start on Windows, without
changing anything on the Mac. It works on its own branch and proves each step on GitHub Actions, because the Mac it
runs on cannot run Windows.

## Done means

All of these, shown in the transcript with the CI run's URL:

1. The `CI` workflow on branch `windows-port` passes on `windows-latest` and `macos-latest` for the same commit.
2. On both: `npm ci` and `npm test` exit 0.
3. On Windows: the installer builds (`electron-builder --win nsis --x64 --publish never`), and the smoke test below
   passes against the packaged app.
4. On the Mac: `npm run package` still builds the app, and no Mac test was deleted, weakened or newly skipped.
5. `docs/windows-port-log.md` lists what changed, every test skipped on Windows with its reason, and what is left for a
   hand test.

## Setup (done before the run starts)

- Branch `windows-port`, cut from `hudsons-feedback`, checked out in its own worktree (`../engelbart-windows`).
- The run may commit and push to `windows-port` only. Pushing is how CI runs.

## Decisions

- **Shell on Windows: Git for Windows is required.** Its `bash.exe` runs every POSIX script the app already writes
  (agent runs, Builds, sign-in, summarizer), so those scripts stay as they are. Look for it via `git` on PATH
  (`<git>\..\..\bin\bash.exe`), then `%ProgramFiles%\Git\bin\bash.exe`, then `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`.
  If it is missing, show one clear message with a link to https://git-scm.com/download/win instead of throwing.
- **Terminals on Windows open PowerShell** (`pwsh.exe` if present, else `powershell.exe`). A user's choice of Git Bash
  can come later.
- **Linux:** a `ubuntu-latest` job runs in the same workflow with `continue-on-error: true`. Its result is reported but
  isn't part of Done.
- **Out of scope:** auto-updates on Windows (keep them off; already gated on darwin), code signing, a release or
  upload, a Windows ARM build, Bundled Git on Windows (use the installed one), HEIC and Word previews (show the existing
  "unsupported" view).

## Work, in order

Commit after each step with a message naming it. Push, wait for CI with `gh run watch` (in the background), and fix
what it shows before going on.

1. **CI.** Add `.github/workflows/ci.yml`: a matrix of `macos-latest`, `windows-latest` and `ubuntu-latest`, Node 22.
   Steps: `npm ci`, `npm test`, `npm run build`. On Windows also: package with electron-builder (installer kept as a
   workflow artifact) and run the smoke test. On the Mac: `ENGELBART_SIGN=adhoc` and package for the runner's
   architecture only. Get this running first, even with Windows failing.
2. **Install and packaging.**
   - `postinstall`: Windows uses node-pty's prebuilds (`node_modules/node-pty/prebuilds/win32-*`), so no forced rebuild
     there. The Mac keeps `electron-rebuild` as it is.
   - `electron-builder.config.cjs`: add a `win` block (nsis + zip, x64), an icon (`build/icon.ico`, made from the
     existing icon), and per-platform `extraResources`. Strip the `win32-*` prebuilds only when building for the Mac.
     `afterPack` keeps its Mac checks for the Mac and gets the matching ones for Windows (node-pty prebuilds present,
     `assertAppModules` against the Windows layout). The Git check stays Mac-only.
3. **The shell layer** (`src/main/terminal/launch.cjs` and its callers). `resolveShell` returns bash from Git for Windows
   there. Login flags, the PATH join (`path.delimiter`), and the provider launch scripts must work under that bash. The
   terminal (`session-manager.cjs`) opens PowerShell. Callers: `tools/run.cjs`, `bart/ask.cjs`,
   `context/summarizer.cjs`, `build/runner.cjs`, `build/manager.cjs`, `build/run-processes.cjs`,
   `sandbox/local-claude.cjs`, `shell-rc.cjs`, `index.cjs`.
4. **Tools** (`src/main/tools/`). Windows locations for Claude, Codex and Git in `detect.cjs`: `%APPDATA%\npm`,
   `%LOCALAPPDATA%`, `%USERPROFILE%\.local\bin`, Program Files. Installs: Claude Code with its PowerShell installer
   (`irm https://claude.ai/install.ps1 | iex`), Codex with `npm install -g @openai/codex`. No `xcode-select` or `brew`
   paths are run on Windows. Rollback without symlinks.
5. **Processes** (`build/run-processes.cjs`): on Windows, stop a process tree with `taskkill /T /F /PID`, and replace
   `ps`/`lsof` lookups with Windows equivalents or skip them where they're only a nicety. `/bin/cp -cR`
   (`build/manager.cjs`) becomes `fs.cpSync` on Windows.
6. **Paths.** Checks that an absolute path starts with `/` (`store/library.cjs`, `store/projects.cjs`) use
   `path.isAbsolute`. Directory symlinks (`context/summarizer.cjs`) use `junction` on Windows.
7. **Tests.** Make each failing test file work on Windows: platform-aware fixtures (no hard-coded `/bin/zsh`; build
   paths with `path.join`), `TEMP` and `TMP` set alongside `TMPDIR` in `scripts/test.mjs`. A test that only means
   something on a Mac (install-mac.sh, the Mac shell scripts) is skipped on Windows with
   `{ skip: process.platform !== 'darwin' && 'macOS only: <why>' }` and listed in the log. New Windows behaviour gets
   its own tests.
8. **Smoke test** (`scripts/smoke-windows.cjs`, run with the packaged app's Electron, hidden, against throwaway
   `ENGELBART_ROOT_DIR` and user data): the window loads; a terminal session starts and echoes a line back; a POSIX
   script run through the Git Bash path prints its output; the app quits cleanly. It exits 0 only if all of that
   happened.

## Rules

- **The Mac doesn't change.** Every Windows change sits behind `process.platform === 'win32'`, or is a change (like
  `path.join` or `path.isAbsolute`) that does the same thing on the Mac. The full Mac `npm test` passes on CI.
- **Never delete or weaken a test** to get a green run. Skips are only for tests that check Mac-only behaviour, and
  each has a written reason.
- **Push only to `windows-port`.** Never push other branches, merge, release, run `upload:mac`, or edit `~/.engelbart`.
- **Don't quit or restart Engelbart,** and don't run `npm run restart` or `relaunch`.
- Match the code around each change: its naming, comment style and density.
- Keep `docs/windows-port-log.md` current after every step: what changed, CI run URLs, what failed and why, what's
  next. Someone reading only that file in the morning should know where things stand.
- If something can't be done without a decision from a person, write it under "Needs a decision" in the log, work
  around it if possible, and go on with the rest.

## Hand test afterwards (not part of the run)

On Windows 11 with Git for Windows installed: install from the CI artifact, open a project, open a terminal, sign in to
Claude Code, run an @bart line and a Build, and save a page from the Stage.
