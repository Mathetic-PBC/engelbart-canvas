# Windows port log (MATH-26)

The run that follows docs/windows-port.md, on branch `windows-port` (cut from `hudsons-feedback` at 22d738c).
Newest status first; the sections below are kept current.

## Where things stand

- 2026-10-05, step 1 (CI): `.github/workflows/ci.yml` added; first push pending.

## Done-criteria checklist

- [ ] CI passes on windows-latest and macos-latest for the same commit
- [ ] `npm ci` and `npm test` exit 0 on both
- [ ] Windows installer builds and `scripts/smoke-windows.cjs` passes on the packaged app
- [ ] `npm run package` still builds on the Mac; no Mac test deleted, weakened or newly skipped

## What changed

- `.github/workflows/ci.yml`: matrix macos-latest / windows-latest / ubuntu-latest (Linux `continue-on-error`), Node 22.

## Tests skipped on Windows (with reasons)

(none yet)

## CI runs

| Commit | Run | macOS | Windows | Linux | Notes |
|---|---|---|---|---|---|

## Needs a decision

- `scripts/smoke-windows.cjs` already existed on `hudsons-feedback`: the smoke test for several app *windows*
  (File ▸ New Window), not for Windows the OS. The spec names that same file for the Windows smoke test. Worked
  around: the old script moves, unchanged apart from its usage line, to `scripts/smoke-app-windows.cjs`, and the
  Windows smoke test takes `scripts/smoke-windows.cjs`. Rename either if you prefer.

## Left for a hand test

On Windows 11 with Git for Windows: install from the CI artifact, open a project, open a terminal, sign in to Claude
Code, run an @bart line and a Build, save a page from the Stage.
