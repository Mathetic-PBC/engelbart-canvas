# Tools Engelbart needs, and defaults that reach existing installs — design

Date: 2026-09-23. Source: Hudson's note "Large task building workflow" (project Engelbart), its three
`@bart` answers, and "Do not yet implement the additional agent since this must be resolved first."
Build (worktrees, big and quick tasks) is **not** part of this: this is what Build stands on.

## 1. The two problems

1. **Defaults were written once.** `config.json` and `model-effort-inline-question.json` are written
   with Engelbart's defaults the first time and never again. A default changed in a later build
   (a new model, a new effort, a new ladder, new wording) reaches new installs only: on an existing
   install the old default sits in the file and is indistinguishable from something the person chose.
   `ensureHome` only added *missing top-level keys*; `loadModels` only wrote a *missing file*.
2. **Engelbart never knew what is installed.** Nothing checked for Git; Claude Code and Codex were
   looked up (memory only, no versions) for the terminal's menu, and @bart defaulted to Codex even
   when only Claude Code was installed. Nothing installed or updated anything.

## 2. Decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | How can a changed default reach a file the person may have edited? | **Three-way merge at load.** Each file Engelbart writes defaults into keeps, in `~/.engelbart/.defaults/<file>`, the defaults it was last given (the *base*). At load: a value still equal to the base was left alone and moves to the new default; a value that differs is the person's and is kept; a key the person deleted stays deleted; a key only the new defaults have is added; a key the new defaults dropped goes if the person never touched it. Arrays are single values (a ladder is one choice). | The only way to tell "left alone" from "chose this" is to remember what was given. This is how dpkg/ucf treat conffiles on upgrade; person-wins on conflict is ucf's default. The alternative, overrides-only files (VS Code's `settings.json`), would empty Hudson's files of the text he edits them by. |
| D2 | Files written before D1 have no base | The base is rebuilt per value from **every default Engelbart ever shipped** for that file (`PAST_DEFAULTS`, read out of git history: two versions of the models file, config values never changed). A value equal to any shipped default counts as left alone; a key missing from the file counts as deleted only if every shipped version had it. | Makes D1 work for installs made before it existed. Hudson's own models file (09-20 wording, 09-21 efforts added by hand) comes out with the current wording and his efforts. |
| D3 | A file that does not parse | Never written. That read uses the defaults (as before); the file is merged once it parses again. The first rewrite of a pre-D1 file keeps a copy in `~/.engelbart/.backups/`. | The person may be halfway through an edit. |
| D4 | "Bart will update the default" when a CLI is missing | At run time @bart starts on the saved default provider when it is usable, else on the other one that is (installed, recent enough, not known signed-out). Nothing is written: the preference survives an uninstall. Until the first check has finished, the saved default. A model picked by flag is never changed. | Bart's own recommendation in "User Interface / Middle Canvas". |
| D5 | Where tool status lives | `config.json` → `tools` (Hudson: "the config.json file should have a boolean"), one record per tool. **Observed** fields are rewritten by every check and never trusted between checks: `installed` (default `false`), `version`, `status`, `signedIn`, `path`, `onPath`, `source`, `checkedAt`, `error`. **From the source code**: `requires`. **The person's**: `skip`, `pin`, and `tools.updates` (`auto` \| `ask`). | Bart: "the biggest error to avoid is treating config.json booleans as truth". |
| D6 | When the check runs | At every launch, in the background; again before an @bart question when the last check is over 10 minutes old or the executable is gone; after a run fails with "not found"; from "Set Up Tools…". | Tools change outside Engelbart. |
| D7 | Required versions | Shipped in `src/main/tools/requirements.cjs` as a range, not one number: `minimum`, a list of `incompatible` ranges with reasons, and `testedMajor` (a newer major works but is marked untested). Git ≥ 2.30.0 (`worktree repair` came in 2.29, `worktree list` shows locks from 2.30: Build needs both). Claude Code ≥ 2.1.278 and Codex ≥ 0.155.0: the versions every flag Engelbart passes was verified on (spec §2 #43–47, 58–60). | Bart: "use compatibility ranges, not one required version". |
| D8 | Finding each tool | The login shell's PATH first (what @bart and the terminal run), listing every match so a wrapper script is seen through; then the folders installers use when PATH misses them (`~/.local/bin`, Homebrew, npm/bun/volta/nvm). A tool found off PATH is run by its full path. On macOS `/usr/bin/git` is Apple's stub: it is **never run** unless `xcode-select -p` names a developer folder that holds git, because running it opens Apple's installer unasked. | Bart's "unexpected shell/PATH, alias, Homebrew, npm, or architecture". |
| D9 | Installing Git | Apple's Command Line Tools through `xcode-select --install`: Apple's dialog is the permission request; Engelbart then waits (polling, up to an hour) and notices when the installer is closed without finishing. Rejected: a private Git (GitHub Desktop's dugite) — Claude Code and Codex run `git` from PATH themselves; headless `softwareupdate` — needs the admin password and parses unstable output. | "First Engelbart will have to request all of the permissions, but then it should install git." |
| D10 | Installing Claude Code / Codex | Each vendor's own installer: `https://claude.ai/install.sh` and `https://chatgpt.com/codex/install.sh` (`CODEX_NON_INTERACTIVE=1`). Both verify a SHA-256 before installing, install into the home folder and need no admin rights. Only after the person clicks Install. | No dependency on npm or Homebrew being present. |
| D11 | Updating | When a tool is below `minimum` or inside an `incompatible` range, and `tools.updates` is `auto` (the default: "it should autoinstall it for them"): the CLI's own `claude update` / `codex update`, which know whether they came from their installer, npm or Homebrew. Git is never updated by Engelbart (Apple or Homebrew own it). Asked instead of automatic when the tool is pinned (`pin`), `updates` is `ask`, or the person turned off the CLI's own updater (`DISABLE_AUTOUPDATER`, `autoUpdates: false`, Codex `check_for_update_on_startup = false`). An update that failed for the same version is not retried for a day. | Never update a version the person holds on purpose. |
| D12 | An update that breaks the tool | Before updating, where the launcher points is recorded. Afterwards the tool is found and checked again; if it is gone or will not run, the launcher is pointed back at the previous version, which both installers keep (`~/.local/share/claude/versions/<v>`, `~/.codex/packages/standalone/releases/<v>`). An update that runs but is still below the minimum is kept (it is no worse) and not retried for a day. npm and Homebrew installs cannot be put back and say so. | "Verify afterward and retain the old executable when possible." |
| D13 | Install failures | Free space is checked first (1 GB for an agent, 5 GB for the Command Line Tools). A failure is classified from the installer's output — no network, proxy, permission, disk, package manager — into one line in `error`; the tool stays as it was. | Each needs a different fix. |
| D14 | Installs while things run | One readers–writer lock per tool: @bart turns and summaries hold it shared; an install or update holds it alone, waiting for running turns and holding new ones until it is done. Installs run one at a time. Build will take the same lock. | "A task starts during an update; serialize installs and builds." |
| D15 | The prompt | After the launch check, a dialog appears only when something needs the person: Git missing; neither Claude Code nor Codex installed; no agent usable because every installed one is signed out; an update waiting for approval; an install or update that failed. Rows show the tool, its state and one button (Install, Update, Sign in, Try again); the foot has Install all when two or more are missing, and Skip. Skip with Git in it first warns that Engelbart will be restricted. Skip is remembered per tool; Engelbart ▸ **Set Up Tools…** shows all three tools any time and has Ask again on a skipped one. Closing the dialog without Skip asks again next launch. | Hudson's words; no explanatory microcopy beyond the warning he asked for. |
| D16 | Sign in | "Sign in" runs `claude auth login` / `codex login` in a hidden terminal (a PTY, so the CLI behaves as in a terminal); the CLI opens the browser itself. The row waits (10 minutes at most), then checks again. The page's address, if the CLI printed one, can be opened again from the row. | The CLIs own their credentials; Engelbart only asks them. |
| D17 | Git edge cases for Build (not a repository, no commit, detached HEAD, a merge/rebase/cherry-pick/revert/bisect under way, `index.lock`, submodules, LFS, free space) | `src/main/tools/repository.cjs` `inspectRepository(dir)` reports every one of them, read from `.git` without running git where possible. Nothing calls it until Build exists. Leftover worktrees after a crash belong to Build: there are no Engelbart worktrees to reconcile yet. | "Do not yet implement the additional agent." |

## 3. `config.json` → `tools`

```json
"tools": {
  "updates": "auto",
  "git":    { "installed": true,  "version": "2.50.1",  "requires": ">=2.30.0",  "status": "ready", "path": "/Applications/Xcode.app/Contents/Developer/usr/bin/git", "onPath": true, "source": "apple", "checkedAt": "…", "error": null, "skip": false, "pin": null },
  "claude": { "installed": true,  "version": "2.1.281", "requires": ">=2.1.278", "status": "ready", "signedIn": true, "path": "…/.claude-vault/bin/claude", "onPath": true, "source": "native", "checkedAt": "…", "error": null, "skip": false, "pin": null },
  "codex":  { "installed": true,  "version": "0.155.1", "requires": ">=0.155.0", "status": "ready", "signedIn": true, "path": "/opt/homebrew/bin/codex", "onPath": true, "source": "homebrew", "checkedAt": "…", "error": null, "skip": false, "pin": null }
}
```

`status`: `unknown` (never checked) · `checking` · `ready` · `missing` · `outdated` · `incompatible` ·
`signed-out` · `installing` · `updating` · `signing-in` · `failed`.

## 4. Bart's edge cases → where each is handled

| Case | Handled by |
|---|---|
| Installed but not signed in | `signedIn` from `claude auth status --json` / `codex login status`; status `signed-out`; D4, D15, D16 |
| Unexpected shell/PATH, alias, Homebrew, npm, architecture | D8 (`detect.cjs`), `source`, `onPath`; the Apple stub rule |
| Version output times out, changes format, cannot be parsed | 20 s timeout, one retry; unparseable → `version: null`, `error`, never auto-updated (`version.cjs`) |
| Minimum met but known-incompatible | D7 `incompatible` ranges → status `incompatible` → D11 |
| Install/update fails: network, proxy, permissions, disk, package manager | D13 (`install.cjs` `classifyFailure`, free-space preflight) |
| Update partially succeeds or replaces a working version | D12 (verify, roll back the launcher) |
| A task starts during an update | D14 (`lock.cjs`) |
| The person pinned a version | D11 (`pin`, the CLIs' own updater switches) |
| Skip per tool with Ask again | D15 (`skip`, Set Up Tools…) |
| Git present but the project is not ready for a worktree | D17 (`repository.cjs`) |
| Worktrees left after a crash | Build (none exist yet) |
| A CLI disappears or updates while Engelbart runs | D6 (recheck before a question, after "not found") |

## 5. Scripted runs

`ENGELBART_TOOLS_FAKE` (JSON, e.g. `{"git":"missing","claude":"2.1.300","codex":"missing"}`; a
version may be followed by ` signed-out`) replaces detection and installation with a simulation, so
the dialog can be driven without touching real tools. `ENGELBART_TOOLS=off` skips the launch check.
