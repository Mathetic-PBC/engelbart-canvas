# Parity ledger: Tools (git, Claude Code, Codex) + app updates

Sources: `src/main/tools/*.cjs`, `src/main/updates.cjs`, `src/renderer/ui/ToolSetup.jsx`, `src/renderer/ui/UpdateBanner.jsx`,
`src/renderer/model/tools.js`, the tools/update parts of `src/main/{ipc,index}.cjs`, `src/preload.cjs`, `src/renderer/App.jsx`
(setup-dialog gating), `src/main/terminal/launch.cjs` (the three helpers run.cjs/sign-in.cjs borrow), `src/main/store/home.cjs`
`writeTools`; spec `docs/superpowers/specs/2026-09-23-tools-and-defaults-design.md` D4–D17, main spec §2 #94–97; tests
`test/tools.test.cjs`, `tools-model.test.cjs`, `bundled-git.test.cjs`, `updates.test.cjs`, `update-banner.test.cjs`,
`sign-in.integration.cjs`; memory notes (engelbart-desktop-experiment.md "tools check", release-pipeline.md,
beta-release-channel.md). Swift paths are relative to `mac/Packages/Tools/Sources/EngelbartTools/`.

Status: `done` = implemented and checked by an XCTest (named in the Swift column when not obvious) or a run; `partial: …`;
`todo`; `n/a: …`.

Test runs (2026-10-28): every `done (local run; cloud run pending)` row was checked by `swift test` on this Mac before
Hudson's cloud-only rule (118 XCTests, 0 failures, plus one opt-in read-only detection of this Mac's real tools). Under the
rule, `done` needs a passing `mac/scripts/cloud-test.sh Tools` run; that script did not exist yet when this was written.
Since the rule only `swift build --build-tests` has been run. The opt-in real-machine test (`ENGELBART_TOOLS_REAL=1`) and the
offscreen pictures (`ENGELBART_TOOLS_SNAPSHOTS=<dir>`) are skipped unless asked for.

## A. Requirements and versions (requirements.cjs, version.cjs; D7)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 1 | Tools are `git`, `claude`, `codex` in that order; agents are `claude`, `codex` | requirements.cjs:36-37 | Requirements.swift | done (local run; cloud run pending) |
| 2 | Git: name "Git", minimum 2.30.0, testedMajor 2, no incompatible ranges, version pattern `git version (\d+\.\d+(?:\.\d+)?)` | requirements.cjs:10-17 | Requirements.swift | done (local run; cloud run pending) |
| 3 | Claude Code: name "Claude Code", minimum 2.1.278, testedMajor 2, pattern `(\d+\.\d+\.\d+)\s*\(Claude Code\)` | requirements.cjs:18-25 | Requirements.swift | done (local run; cloud run pending) |
| 4 | Codex: name "Codex", minimum 0.155.0, testedMajor 0, pattern `codex-cli\s+(\d+\.\d+\.\d+)` | requirements.cjs:26-33 | Requirements.swift | done (local run; cloud run pending) |
| 5 | Provider ↔ tool: claude↔anthropic, codex↔openai | requirements.cjs:39-40 | Requirements.swift | done (local run; cloud run pending) |
| 6 | `requires` text is `>=<minimum>` (e.g. `>=2.1.278`) | requirements.cjs:42 | Requirements.swift | done (local run; cloud run pending) |
| 7 | The shipped table is immutable at run time | requirements.cjs Object.freeze; tools.test:42 | `let` constants | done (local run; cloud run pending) |
| 8 | parseVersion: the tool's own pattern first, then any loose `x.y(.z)` not part of a longer dotted number; missing patch → 0; leading zeros dropped; none → nil (`git version 2.39` → 2.39.0; `10.0.0.1 is an address` → nil; a warning's `v18.2.0` loses to `codex-cli 0.155.1`) | version.cjs:7-16; tools.test:23-29 | Version.swift | done (local run; cloud run pending) |
| 9 | compareVersions numeric per part (2.10.0 > 2.9.9) | version.cjs:21-28 | Version.swift | done (local run; cloud run pending) |
| 10 | judge: not x.y.z → unknown; below minimum → outdated with why "`<Name> <v> is older than <min>.`"; inside an incompatible [from,to) → incompatible with its why; else ready, `untested` when major > testedMajor | version.cjs:35-41; tools.test:32-41 | Version.swift | done (local run; cloud run pending) |

## B. The `config.json → tools` record (record.cjs; D5)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 11 | Statuses: unknown, checking, ready, missing, outdated, incompatible, signed-out, installing, updating, signing-in, failed | record.cjs:12 | Record.swift | done (local run; cloud run pending) |
| 12 | Sources: apple, homebrew, bundled, native, standalone, npm, bun, desktop, other; updates policy auto \| ask (default auto) | record.cjs:15-16,70 | Record.swift | done (local run; cloud run pending) |
| 13 | Blank record: installed false, version null, requires from table, status unknown, signedIn/account null (agents only: git has no such keys), path null, onPath null, source null, untested false, updaterOff false, checkedAt null, error null, note null, failedUpdate null, skip false, pin null | record.cjs:19-38 | Record.swift | done (local run; cloud run pending) |
| 14 | Normalize: each field kept only when valid (booleans; version x.y.z; status/source in their lists; account only for an agent signed in and matching `^\S{1,254}$`; path absolute, ≤4096, no NUL; checkedAt ≤40 chars and a date; error/note collapsed to one line, trimmed, cut to 300; failedUpdate only {from: version, at: date}; skip only `true`; pin only a version) | record.cjs:44-65; tools.test:248-256, tools-model.test:106 | Record.swift | done (local run; cloud run pending) |
| 15 | `requires` is always rewritten from the table, never trusted from disk | record.cjs:23 | Record.swift | done (local run; cloud run pending) |

## C. Running programs (run.cjs + the borrowed terminal/launch.cjs helpers)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 16 | `exec` never throws: → {code, signal, stdout, stderr, timedOut, missing}; default timeout 20 s; output capped 4 MiB; stdin closed (or given input) | run.cjs:22-40 | Run.swift `ToolRunner.exec` (output over 4 MiB is cut; Node's maxBuffer killed the child) | done (local run; cloud run pending) |
| 17 | `shell(command)` runs `printf '__ENGELBART_TOOLS__\n'; <command>` in the login shell (`-ilc`, fish `--login --interactive --command`); stdout is what follows the LAST mark; `marked` false when the mark never printed (rc noise skipped) | run.cjs:43-49 | Run.swift | done (local run; cloud run pending) |
| 18 | The environment is re-read at each run (CLAUDE_CONFIG_DIR/CODEX_HOME set after launch reach the checks) and sanitized: transient keys dropped (CLAUDECODE, CLAUDE_CODE_*, CODEX_SESSION_ID…, NODE_CHANNEL_FD, NO_COLOR, ELECTRON_*, WARP_*, INSPECT*, NODE_OPTIONS with --inspect), TERM=xterm-256color, COLORTERM=truecolor, TERM_PROGRAM=Engelbart, TERM_PROGRAM_VERSION=0.1.0, LANG=en_US.UTF-8 when no LANG/LC_* | run.cjs:17-19; launch.cjs:12-25,67-99 | Run.swift `ToolShell.sanitize` | done (local run; cloud run pending) |
| 19 | The shell: $SHELL when absolute, zsh/bash/fish and executable; else /bin/zsh; else /bin/bash | launch.cjs:109-117 | Run.swift `ToolShell.resolve` | done (local run; cloud run pending) |
| 20 | loginShellArgs: `PATH="$ENGELBART_GIT_BIN:$PATH"; ` first when ENGELBART_GIT_BIN is set, `PATH="$PATH:$ENGELBART_AGENT_PATH"; ` when ENGELBART_AGENT_PATH is set (fish forms `set -gx …`), then the command | launch.cjs:45-66 | Run.swift | done (local run; cloud run pending) |
| 21 | Values reach shell commands through the environment (`$ENGELBART_TOOL`), never quoted into the text | run.cjs:5-6 | Detect/Install/SignIn | done (local run; cloud run pending) |

## D. Detection (detect.cjs; D8)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 22 | One login-shell lookup lists every git/claude/codex on PATH in order (zsh `whence -ap`, bash `type -aP`, fish `command -a -s`), names that are aliases/functions, and `DISABLE_AUTOUPDATER`; exact command text kept | detect.cjs:35-40 | Detect.swift `lookupCommand` | done (local run; cloud run pending) |
| 23 | parseLookup: `@tool`, `@alias`, `@env K=V` lines; absolute paths only, each once per tool; unknown tool names ignored | detect.cjs:42-59; tools.test:45-49 | Detect.swift | done (local run; cloud run pending) |
| 24 | Known places when PATH misses an agent: ~/.local/bin, ~/.claude/local (claude), ~/.bun/bin, ~/.npm-global/bin, ~/.volta/bin, then /opt/homebrew/bin, /usr/local/bin, then nvm versions newest first (numeric sort); none for git | detect.cjs:90-107; tools.test:64-65 | Detect.swift | done (local run; cloud run pending) |
| 25 | The Claude app's own Claude Code: ~/Library/Application Support/Claude/claude-code/<version>/<build>/claude.app/Contents/MacOS/claude, newest 3 versions, executable only; looked at last; counts only when recent enough; source `desktop`; Engelbart never updates it (updaterOff true) | detect.cjs:115-131,355,380-381 | Detect.swift `desktopCopies` | done (local run; cloud run pending) |
| 26 | sourceOf from the real path: desktop; git → apple (/usr/bin/git, /Applications/Xcode…, /Library/Developer/CommandLineTools/), homebrew (Cellar/Homebrew/homebrew, /opt/homebrew/), other; claude under ~/.local/share/claude/versions/ → native; codex under ~/.codex/packages/standalone/ → standalone; Caskroom/Cellar → homebrew; node_modules → npm (bun when under .bun); .bun → bun; else other | detect.cjs:134-148; tools.test:51-66 | Detect.swift | done (local run; cloud run pending) |
| 27 | shellSilent message names the shell and its rc file (.zshrc, .bash_profile, config.fish, else "startup files"), exact text | detect.cjs:150-157 | Detect.swift | done (local run; cloud run pending) |
| 28 | readVersion: `exec "$ENGELBART_TOOL" --version 2>&1` in the login shell (or direct exec for git); 20 s timeout, one retry on timeout, then "`<Name> did not answer --version within 20 seconds`"; unmarked → silent; non-zero → "`<Name> did not start: <first line or exit status N>`"; claude/codex without their own version line → `other` ("`<file> is another program called <name>, not <Name> (it says "<60 chars>").`"); unparseable → ran, version nil, "Could not read the version …" (80 chars) | detect.cjs:164-179; tools.test:258-266 | Detect.swift | done (local run; cloud run pending) |
| 29 | Claude sign-in: `exec "$ENGELBART_TOOL" auth status --json 2>&1`; the JSON object past any leading warning; `loggedIn` boolean + `email` string as account; not JSON → regex `"loggedIn": true/false`, no account; else unknown | detect.cjs:203-215; tools.test:186-198 | Detect.swift `AuthReaders` | done (local run; cloud run pending) |
| 30 | Codex sign-in: `exec "$ENGELBART_TOOL" login status 2>&1`; "not logged in" → false; "logged in using chatgpt" → true; other "logged in" → false with the API-key error text; else unknown | detect.cjs:216-225; tools.test:171-180 | Detect.swift | done (local run; cloud run pending) |
| 31 | Codex account = `email` claim of tokens.id_token (base64url payload, unverified) in $CODEX_HOME/auth.json else ~/.codex/auth.json; any failure → nil; no token text ever leaves | detect.cjs:188-201; tools.test:200-246 | Detect.swift `codexAccount` | done (local run; cloud run pending) |
| 32 | Sign-in check timeout 15 s; unmarked → unknown; a Codex signed in without auth.json (keychain only) counts as signed out with "Codex keeps its sign-in in the keychain, where Engelbart’s agents can’t use it. Connect it again." | detect.cjs:229-245 | Detect.swift `readSignIn` | done (local run; cloud run pending) |
| 33 | updaterOff: claude when DISABLE_AUTOUPDATER is 1/true/yes (shell's value over the process's) or ~/.claude.json contains `"autoUpdates": false` (regex, not parsed; Hudson's file has it → ASK, never silent); codex when $CODEX_HOME/config.toml has `check_for_update_on_startup = false` | detect.cjs:248-258; memory note | Detect.swift | done (local run; cloud run pending) |
| 34 | observed(): installed = a file was found; missing without file; failed when it did not run; else judged (unknown version → ready, never auto-updated in a loop); judge's why fills error; ready + signedIn false → signed-out; signedIn only when ran; account only when signed in | detect.cjs:261-279; tools.test:68-76 | Detect.swift | done (local run; cloud run pending) |
| 35 | Apple's /usr/bin/git stub is never run unless `/usr/bin/xcode-select -p` (5 s) names a folder whose usr/bin/git is executable; then that git's version is read; then the stub `--version` is run and a non-zero exit mentioning licen[cs]e → failed "Xcode's license has not been accepted, so git will not run (in Terminal: sudo xcodebuild -license accept)." | detect.cjs:282-302; tools.test:100-121 | Detect.swift | done (local run; cloud run pending) |
| 36 | Engelbart's own Git stands in when the person's is missing, broken or too old (source bundled, onPath false); their own (even broken) is reported when the bundled one cannot run either; ENGELBART_GIT=bundled prefers it | detect.cjs:305-311; tools.test:123-152 | Detect.swift | done (local run; cloud run pending) |
| 37 | Every copy counts: PATH copies in order, then known places, then desktop copies, each real file once; first recent enough wins, else the first that is the program; a silent login shell stops the search | detect.cjs:326-360 | Detect.swift | done (local run; cloud run pending) |
| 38 | onPath only when the chosen copy is the first on PATH; otherwise a note: another program of the same name ("Typing <n> in a terminal runs another program of the same name; Engelbart runs <Name> by its full path. The other one is at <where>.") or an older copy ("An older <Name> comes first on your PATH, so typing <n> in a terminal runs it; Engelbart uses a newer one.[ To remove the older one: <hint>.] It is at <where>."), home shown as ~ | detect.cjs:363-375 | Detect.swift | done (local run; cloud run pending) |
| 39 | removal hint from the real path: `brew uninstall --cask <cask>`, `brew uninstall <formula>`, `npm uninstall -g <pkg>` | detect.cjs:314-323 | Detect.swift | done (local run; cloud run pending) |
| 40 | A wrapper script (`#!`) in front of the program (Hudson's vault shim) is seen through for `source`: the next non-script on PATH decides | detect.cjs:376-378; memory note | Detect.swift | done (local run; cloud run pending) |
| 41 | detectTools: one lookup (15 s), tools checked concurrently, one checkedAt for all; lookupError "The login shell (<shell>) did not answer within 15 seconds." or shellSilent; a missing tool carries lookupError as its error; returns aliases and lookupError | detect.cjs:390-400; tools.test:268-276 | Detect.swift | done (local run; cloud run pending) |
| 42 | Real zsh: an alias is reported by name only (its definition never captured); sign-in and account read from real CLIs; nothing else of their status (orgId) stored | tools.test:707-736 | DetectRealShellTests | done (local run; cloud run pending) |

## E. Install and update actions (install.cjs; D9–D13)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 43 | Installers: claude `https://claude.ai/install.sh` via bash; codex `https://chatgpt.com/codex/install.sh` via sh with CODEX_NON_INTERACTIVE=1 | install.cjs:26-29 | Install.swift | done (local run; cloud run pending) |
| 44 | Agent install: free space first (1 GiB for an agent, 5 GiB for Git at /Library); downloaded to `<tmp>/engelbart-<name>-install-<pid>-<ms>.sh` with `curl -fsSL --retry 2 --connect-timeout 20 -o "$ENGELBART_INSTALLER" "$ENGELBART_INSTALLER_URL" && <interp> "$ENGELBART_INSTALLER" < /dev/null 2>&1`, 10-minute limit, script removed afterwards | install.cjs:107-124; tools.test:302-312 | Install.swift | done (local run; cloud run pending) |
| 45 | roomFor: "`<Name> needs about X.X GB free; Y.Y GB is left.`" kind disk; unknown free space → go ahead | install.cjs:53-68; tools.test:289-300 | Install.swift | done (local run; cloud run pending) |
| 46 | classifyFailure, in order: proxy (407/proxy), certificate (ssl/certificate/curl 35,51,58,59,60,77,83 → network), network (resolve/connect/refused/reset/timed out/unreachable/ENOTFOUND…/curl 5,6,7,28,52,55,56), disk (ENOSPC/no space left), permission (EACCES/EPERM/permission denied/operation not permitted/not writable), package-manager (npm ERR!/error, brew, homebrew, cask), other; detail = last non-empty line without ANSI codes (≤160) else "exit status N"; exact sentences | install.cjs:37-51; tools.test:278-287 | Install.swift | done (local run; cloud run pending) |
| 47 | Git install: `/usr/bin/xcode-select --install` (30 s); "already installed" with git there → ok; phase "Waiting for Apple’s installer"; poll every 5 s up to an hour for xcode-select -p + git; installer process (`pgrep -f "Install Command Line Developer Tools"`) seen then gone twice in a row → cancelled "Apple’s installer was closed before it finished."; never seen within 60 s → "Apple’s installer did not open."; an hour → "Apple’s installer had not finished after an hour." | install.cjs:72-105; tools.test:314-345 | Install.swift | done (local run; cloud run pending) |
| 48 | Agent update: the CLI's own `exec "$ENGELBART_TOOL" update < /dev/null 2>&1` by the path Engelbart runs it by, CODEX_NON_INTERACTIVE=1, 10 minutes ("The update had not finished after 10 minutes.") | install.cjs:127-135 | Install.swift | done (local run; cloud run pending) |
| 49 | Git update: bundled → "This Git came with Engelbart and is updated with it."; not homebrew → "Apple’s Git is updated by macOS: System Settings › General › Software Update."; homebrew → `brew upgrade git < /dev/null 2>&1` | install.cjs:137-143 | Install.swift | done (local run; cloud run pending) |
| 50 | Rollback point: claude ~/.local/bin/claude; codex $CODEX_HOME|~/.codex/packages/standalone/current; mark = its link target when it resolves; rollback = new symlink beside it then one rename; → true when done | install.cjs:151-183; tools.test:347-363 | Install.swift | done (local run; cloud run pending) |
| 51 | Every action answers {ok, error, kind} and never throws | install.cjs:17-18 | Install.swift `ActionResult` | done (local run; cloud run pending) |

## F. Lock (lock.cjs; D14)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 52 | Readers–writer lock per tool: runs share; install/update holds it alone after running runs end; runs asked meanwhile wait; a waiting writer goes first | lock.cjs; tools.test:365-378 | Lock.swift | done (local run; cloud run pending) |
| 53 | Installs run one at a time (one installer lock over all tools) | manager.cjs:50,121,177 | Manager.swift | done (local run; cloud run pending) |

## G. Engelbart's own Git (bundled-git.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 54 | Launcher `engelbart-bin/git` in the app's Resources/git, else a checkout's vendor/git/darwin-<arch>; ENGELBART_BUNDLED_GIT overrides; executable regular files only; Macs only | bundled-git.cjs; bundled-git.test:18-34 | BundledGit.swift | done (local run; cloud run pending) |
| 55 | The real dugite git runs Build's commands with nothing in the environment | bundled-git.test:38-58 | — | n/a: needs vendor/git (scripts/fetch-git.mjs) inside the Swift app bundle; that is the bundle script's job (mac/scripts/bundle.sh, not owned here); Build's git commands belong to the Build package |

## H. Repository checks for Build (repository.cjs; D17)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 56 | findGitDir walks up; a `.git` file (`gitdir: …`) is followed, with `commondir` | repository.cjs:26-46 | Repository.swift | done (local run; cloud run pending) |
| 57 | inspectRepository → repository, top, branch, detached (40/64-hex HEAD), commits (ref file or packed-refs), operation (rebase-merge/rebase-apply/MERGE_HEAD/CHERRY_PICK_HEAD/REVERT_HEAD/BISECT_LOG), locked (index.lock), submodules (.gitmodules), lfs (filter=lfs or lfs dir), freeBytes; problems in order no-commits, detached, operation, locked with exact messages; not a repository → "This folder has no history yet." | repository.cjs:62-85; tools.test:651-692 | Repository.swift | done (local run; cloud run pending) |

## I. Sign in and sign out (sign-in.cjs; D16)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 58 | Sign-in commands: claude `exec "$ENGELBART_TOOL" auth login --claudeai`; codex `exec "$ENGELBART_TOOL" login -c 'cli_auth_credentials_store="file"'` (file, never keychain only) | sign-in.cjs:19-23 | SignIn.swift | done (local run; cloud run pending) |
| 59 | Run in a hidden PTY (xterm-256color, 400 cols so an address never wraps, 40 rows, cwd home) through loginShellArgs with ENGELBART_TOOL and ENGELBART_AGENT_PATH = the CLI's folder (last on PATH; Claude Code otherwise says it "is not in your PATH") | sign-in.cjs:32-41; sign-in.integration:48-57 | SignIn.swift + Pty.swift (forkpty) | done (local run; cloud run pending) |
| 60 | The first https URL in the ANSI-stripped output is passed on once; "press enter/return" is answered with \r once; output kept to the last 50 000 chars | sign-in.cjs:42-53; sign-in.integration:20-31 | SignIn.swift | done (local run; cloud run pending) |
| 61 | Ended by a signal (Cancel, ten-minute limit) → {code: nil, output: ""}, never success; else exit code and, when non-zero, the last non-empty line (≤200) | sign-in.cjs:54-61; sign-in.integration:33-46 | SignIn.swift | done (local run; cloud run pending) |
| 62 | Sign-out: `exec "$ENGELBART_TOOL" auth logout 2>&1` / `exec "$ENGELBART_TOOL" logout 2>&1` in the login shell, 30 s ("it did not finish within 30 seconds"), unmarked → shellSilent, failure → last line without ANSI (≤200) or "exit status N" | sign-in.cjs:24-28,66-74; tools.test:551-566 | SignIn.swift | done (local run; cloud run pending) |

## J. Pretend machine (fake.cjs; ENGELBART_TOOLS_FAKE)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 63 | Spec JSON per tool: "missing", "broken", "bundled" (git, 2.53.0), or a version optionally + " signed-out" / " unknown" (signedIn nil) / " no-plan"; defaults git 2.50.1, agents their minimum; `failInstall`, `signInNever` lists; bad JSON → all defaults | fake.cjs:20-32 | Fake.swift | done (local run; cloud run pending) |
| 64 | Fake paths: /usr/bin/git (apple), bundled launcher path, /Users/fake/.local/bin/<name> (native); broken → failed "<Name> did not start: exit status 1"; account researcher@example.com | fake.cjs:18,38-53 | Fake.swift | done (local run; cloud run pending) |
| 65 | Detect waits min(400, delay); install waits delay, fails per failInstall (git → cancelled text, agent → network text with curl (6)); installed agent = minimum, signed out; update → minimum; git update refused with Apple text; sign-in prints `https://example.invalid/<name>/sign-in` after 200 ms, signs in after delay (never for signInNever), kill → {130, "Cancelled."}; sign-out quick | fake.cjs:40-91 | Fake.swift | done (local run; cloud run pending) |
| 66 | reset(): the pretend machine back to its first state (test mode's reset), then a check | fake.cjs:37; index.cjs:1245 | Fake.swift, ToolsSetup.resetFake | done (local run; cloud run pending) |
| 67 | `claude auth status --json` answered for the pretend machine (onboarding providers) | fake.cjs:94-102 | Fake.swift `authStatusJSON` | done (local run; cloud run pending) |
| 68 | A pretend machine keeps its records in memory only: config.json is never read or written | index.cjs:647-655; memory note 2026-09-28 | ToolsSetup.swift | done (local run; cloud run pending) |

## K. Manager (manager.cjs; D5, D6, D11, D12, D14, D15)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 69 | Starts from what the last launch wrote (records read from disk) | manager.cjs:45-47 | Manager.swift | done (local run; cloud run pending) |
| 70 | persist: observed fields from what the checks saw, failedUpdate from the manager, `skip`/`pin`/`updates` re-read from disk on every write unless this action sets them (an edit by hand is never overwritten); the written value is normalized back into records | manager.cjs:58-73; tools.test:462-471 | Manager.swift | done (local run; cloud run pending) |
| 71 | Snapshot: {checked, platform, updates, tools: {id, name, minimum, …record, busy, autoUpdate}} sent on every change as `engelbart:tools` | manager.cjs:82-97; index.cjs:661 | Manager.swift | done (local run; cloud run pending) |
| 72 | check(only): tools already busy are left out; busy {action: check} while it runs; a detect that throws → each tool's error "The check failed: <message>"; aliases merged per name; `checked` and lookupError only on a full check | manager.cjs:99-115 | Manager.swift | done (local run; cloud run pending) |
| 73 | canAutoUpdate: never git; only outdated/incompatible; updates auto, not pinned, not skipped, CLI updater on, a path; not when the same version's update failed within 24 h | manager.cjs:75-80; tools.test:412-444 | Manager.swift | done (local run; cloud run pending) |
| 74 | update: "<Name> is not installed." when not installed; installer lock then tool lock; status updating; rollback mark only for native/standalone; afterwards found again; failed/missing → rollback and found again; errors: "The update broke <Name>, so <v|the earlier version> was put back.[ <error>]", the action's error, "<Name> updated to <v|a version> that still does not meet <min>.", found's error or "<Name> did not answer after the update."; "A <source> install keeps no earlier copy to go back to." appended for npm/homebrew/…; failedUpdate {from, at} when it failed | manager.cjs:117-155; tools.test:473-503 | Manager.swift | done (local run; cloud run pending) |
| 75 | start(): the launch check once, then installFirst, then maintain (auto-updates in order) | manager.cjs:157-166 | Manager.swift | done (local run; cloud run pending) |
| 76 | installFirst: on a Mac with neither agent installed and a lookup that answered, the agents in installAtLaunch (index: ["claude"]) that are missing, not skipped, not busy are installed in the background | manager.cjs:169-173; tools.test:620-649 | Manager.swift | done (local run; cloud run pending) |
| 77 | installOne: already installed and working → ok; again after waiting its turn (no second install); status installing, skip cleared; Git reports Apple's phases; verified by finding the program; errors "<Name> <v> was installed but is older than <min>." (double space collapsed), found's error or "<Name> was installed but could not be found."; → {ok, error, kind} | manager.cjs:175-202; tools.test:446-460 | Manager.swift | done (local run; cloud run pending) |
| 78 | install(names): one after another, unknown names dropped | manager.cjs:205-209 | Manager.swift | done (local run; cloud run pending) |
| 79 | signIn: agents with a path only; one per tool; busy {sign-in, url}; ten-minute limit kills it; then a check; not signed in with output → "Not signed in: <output>" (≤300) | manager.cjs:212-229; tools.test:505-511 | Manager.swift | done (local run; cloud run pending) |
| 80 | connect(name): install when missing/failed/installing, else update when outdated/incompatible and not pinned; then check when sign-in is not known true; then sign in when installed and signed-out/ready; a press while one runs joins it | manager.cjs:236-257 | Manager.swift | done (local run; cloud run pending) |
| 81 | cancelSignIn kills the running sign-in → whether there was one | manager.cjs:259-263 | Manager.swift | done (local run; cloud run pending) |
| 82 | stopSignIns (quit): every sign-in killed, waits for them up to 3 s → how many | manager.cjs:270-278; sign-in.integration:59+ | Manager.swift | done (local run; cloud run pending) |
| 83 | signOut: agents with a path, not busy, not signing in; busy {sign-out}; logout then a check of that tool; → {ok:true} when no longer signed in, else "Could not sign out of <Name>: <output>" or "<Name> still says it is signed in." | manager.cjs:284-295; tools.test:513-549 | Manager.swift | done (local run; cloud run pending) |
| 84 | skip(names) / askAgain(name) / setUpdates('ask'|'auto' else auto) persist the person's choices | manager.cjs:298-314 | Manager.swift | done (local run; cloud run pending) |
| 85 | ensure(name) before a run: nothing before the first check or while busy; the program's file gone → check now; checkedAt over 10 minutes old → check in the background | manager.cjs:317-325 | Manager.swift | done (local run; cloud run pending) |
| 86 | use(name, fn): a run holds the tool's lock shared | manager.cjs:328-330; tools.test:568-581 | Manager.swift | done (local run; cloud run pending) |
| 87 | usableAgents: nil before the first check, else installed agents with status ready | manager.cjs:333-336 | Manager.swift | done (local run; cloud run pending) |
| 88 | environment(): ENGELBART_GIT_BIN = folder of a bundled, ready Git whose file exists; ENGELBART_AGENT_PATH = folders (deduped, ":"-joined) of agents run by full path; ENGELBART_CLAUDE_BIN/ENGELBART_CODEX_BIN their full paths; a path gone from disk gives nothing | manager.cjs:344-354; tools.test:591-618 | Manager.swift | done (local run; cloud run pending) |
| 89 | binaryFor(name): the full path when onPath is false, else nil | manager.cjs:357-360 | Manager.swift | done (local run; cloud run pending) |
| 90 | providers(shellPath): waits for the launch check; Shell + Claude Code + Codex, available when installed and not failed, or an alias ("shell alias/function" as path); authenticated = signedIn; checkedAt | manager.cjs:363-373; tools.test:583-589,707-725 | Manager.swift | done (local run; cloud run pending) |

## L. Wiring (index.cjs, ipc.cjs, preload.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 91 | Channels: tools, tools-check, tools-install (answers at once, runs in background), tools-update, tools-sign-in, tools-connect (all answer the snapshot at once), tools-cancel-sign-in, tools-sign-out (answers once done), tools-skip, tools-ask-again, tools-set-updates ('ask' else 'auto'); names validated ("Unknown tool"), at most 3 | ipc.cjs:1230-1248 | Channels.swift `ToolsChannels` | done (local run; cloud run pending) |
| 92 | Events: `engelbart:tools` (snapshot) to every window; `engelbart:tools-open` (Engelbart ▸ Set Up Tools…, focused window) | preload.cjs:364-378; index.cjs:419,661 | Manager / Channels.swift | done (local run; cloud run pending) |
| 93 | ENGELBART_TOOLS=off skips the launch check; ENGELBART_TOOLS_FAKE pretends a machine; ENGELBART_GIT=bundled prefers Engelbart's Git; installAtLaunch ["claude"] | index.cjs:641-663 | ToolsSetup.swift | done (local run; cloud run pending) |
| 94 | The tool check's runner, bundled git found from the app bundle, real actions/sign-in/sign-out unless faked | index.cjs:649-660 | ToolsSetup.swift | partial: real installs, updates and sign-ins are never run on this Mac (not allowed); each is tested against fakes and a real PTY, and real detection was run read-only (MoreTests.testTheRealMachineReadOnly: git apple 2.50.1, claude via the vault shim → native 2.1.312 updaterOff, codex homebrew 0.164.0) |
| 95 | A quit ends sign-ins still waiting in the browser first (stopSignIns) | index.cjs:274 | Manager.stopSignIns (app calls it) | done (local run; cloud run pending) |
| 96 | Sessions get tools.environment() on top of their own (terminal, agent terminal, run processes, codex mcp list) | index.cjs:619,739,1024,1139 | Manager.environment (Terminal/others call it) | done (local run; cloud run pending) |
| 97 | Menu: Engelbart ▸ [update item] · Set Up Tools… sends `engelbart:tools-open` | index.cjs:419-428 | ToolsMenu (API.md: app builds the menu) | done (local run; cloud run pending) |
| 98 | Test mode's reset resets a pretend machine and checks again | index.cjs:1245 | ToolsSetup.afterTestReset | done (local run; cloud run pending) |
| 99 | `update-state` (snapshot or {enabled:false}), `update-restart`, `update-later`; `engelbart:update` on every change, which also rebuilds the menu | ipc.cjs:1250-1254; index.cjs:1386-1394 | Updates.swift + Channels.swift | done (local run; cloud run pending) |

## M. Rows and gating (model/tools.js, App.jsx)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 100 | launchRows: [] before the first check; Git missing/failed and not skipped; neither agent installed → both unless both skipped; installed but none ready → the installed not skipped; any agent signed-out, or outdated/incompatible without autoUpdate, not skipped/busy; in tool order | tools.js:13-30; tools-model.test:26-54 | Model.swift | done (local run; cloud run pending) |
| 101 | installedSignedOut(before, after): agents installing before, done and signed-out after, not skipped | tools.js:36-42 | Model.swift | done (local run; cloud run pending) |
| 102 | needsAction: not busy and not ready | tools.js:45-47 | Model.swift | done (local run; cloud run pending) |
| 103 | rowOf: install busy → agents "Connecting…", git its phase or "Installing…"; "Updating…"; sign-in → "Finish signing in in your browser" + Cancel + page; "Signing out…"; ready → "<v>[ · untested][ · built in]" (else "Installed" + error) with note in amber; signed-out → "Not signed in" + Sign in; missing → "Skipped"/"Not installed" + Install; outdated/incompatible → "<v> · needs <min>" / "<v> · does not work with Engelbart" + Update (git only from Homebrew); failed → "Not working" + Try again; else "Connecting…"/"Checking…"; account only when signed in | tools.js:55-86; tools-model.test:56-107 | Model.swift | done (local run; cloud run pending) |
| 104 | installable: rows missing and not busy; skipWarnings: Git line when git not ready; agent line when no agent ready; allDone: every row not busy and ready | tools.js:89-108; tools-model.test:82-96 | Model.swift | done (local run; cloud run pending) |
| 105 | Gating: the first checked snapshot opens the dialog once with launchRows; an install that ends signed out asks again ('after'); held while onboarding a new install is on screen; 'after' waits until no row is busy, then asks what is left; Set Up Tools… opens all three in mode all; onboarding's Install → 'after', Skip → nothing | App.jsx:122-162 | Model.swift `SetupGate` | done (local run; cloud run pending) |
| 106 | The dialog shows only while no other popup is up (needUp/statusUp/providerUp) | App.jsx:565 | — | n/a: the app's popup arbitration belongs to the wave-2 screens; SetupGate exposes `request` and the app decides when to show it (API.md) |

## N. ToolSetup dialog (ToolSetup.jsx; D15)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 107 | Backdrop rgba(255,255,255,.35), centered, padding 24; card min(500, 100%) wide, padding 28, gap 16, white, 1px #c9c9c9, radius 12, shadow 0 12 40 #0000001f, rise 200 ms | ToolSetup.jsx:79-80 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 108 | Title "Set up Engelbart" (mode launch) / "Tools" (mode all), 500 20/1.3, tracking -0.2, ink; × close 18 pt #c9c9c9, ink on hover | ToolSetup.jsx:81-84 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 109 | Row: grid 112 / 1fr / auto, column gap 12, row gap 4, padding 10 0; name 500 13.5 ink; state mono 12 in its tone (ok ink, muted/busy #8f8f8f, warn #a35200, error #e70022) with a green check (#1a7f37, 12×12) when ok or a pulsing 6×6 dot (opacity .25↔1, 1.4 s) when busy; ellipsis | ToolSetup.jsx:11-29 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 110 | Row buttons: Open page and Ask again (mode all, skipped) as 12.5 #8f8f8f text (ink on hover); the action button min height 30, padding 6 12, 1px #eaeaea, radius 7, white, 500 12.5 ink, #f2f2f2 wash on hover, labels Install/Update/Sign in/Try again/Cancel | ToolSetup.jsx:10,30-36 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 111 | Detail line under the row, 12/1.5, red or amber (detailTone), wraps anywhere | ToolSetup.jsx:37 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 112 | Actions: install → install([id]); update; sign-in; cancel → cancel sign-in; retry → check when installed else install; Open page → open in the default browser; errors shown 12.5 red under the rows, cleared on the next action | ToolSetup.jsx:49,59-67,96-98 | ToolSetupModel | done (local run; cloud run pending) |
| 113 | Footer, mode all: "Update automatically" checkbox (checked unless updates ask) · spacer · "Check again" quiet · Done primary | ToolSetup.jsx:100-109 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 114 | Footer, launch: Done (autofocus) when all done; else "Install all" primary when 2+ installable, spacer, "Skip" quiet when any row needs action | ToolSetup.jsx:110-118 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 115 | Skip: warnings first when any (each line 13.5/1.6 ink; "Skip anyway" ink-filled primary, autofocus; "Back" quiet); else skip and close | ToolSetup.jsx:68-73,85-92 | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |
| 116 | Escape closes the dialog only (taken before anything else sees it) | ToolSetup.jsx:51-57 | ToolSetupView.swift (.onExitCommand / key monitor) | partial: the capture-first Escape (a local key monitor) is built; no test sends it a real key event |
| 117 | Primary button: min height 36, padding 9 16, radius 8, #0070f3, white, 500 13; quiet: 13 #8f8f8f; no divider lines anywhere | ToolSetup.jsx:75-76; fceced2 "No divider lines in the tool setup screens" | ToolSetupView.swift (drawn offscreen in ViewTests and looked at) | done (local run; cloud run pending) |

## O. App updates (updates.cjs; MATH-43)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 118 | Enabled only with a download folder: an https URL ending in "/" without quotes/spaces/`$`/backslash, or http://127.0.0.1:<port>/…/ for scripted runs; ENGELBART_UPDATES=off stops it; Electron also required a packaged Mac app | updates.cjs:39-47,85; updates.test:62-84 | Updates.swift `ReleaseInfo`; `packaged` = running from an .app bundle | done (local run; cloud run pending) |
| 119 | The Swift app has no release feed yet: the download folder is a setting, off by default (Info.plist `EngelbartDownloads` / defaults `engelbart.updates.downloads`); with none set nothing is checked | task brief | Updates.swift `UpdateFeedSetting` | done (local run; cloud run pending) |
| 120 | First check a minute after launch, then every 6 hours; each new version offered once per launch | updates.cjs:32-33,224-226,278-284 | Updates.swift | done (local run; cloud run pending) |
| 121 | States idle → checking → installing → ready; snapshot {enabled, state, available, version (the one being installed, else the newer seen), percent (installing only), dismissed}; dismissed reset on every state change | updates.cjs:88-105 | Updates.swift | done (local run; cloud run pending) |
| 122 | Ad hoc offer: "Engelbart <v> is available", detail "You have <current>. Engelbart downloads the new version, then quits and opens again with it. Your projects and notes stay as they are.", buttons Update / Later | updates.cjs:224-241 | Updates.swift | done (local run; cloud run pending) |
| 123 | Install command: /bin/bash -c `script=$(mktemp "${TMPDIR:-/tmp}/engelbart-install.XXXXXX") && curl -fsSL --retry 2 --connect-timeout 20 -o "$script" "${ENGELBART_DOWNLOADS}install.sh" && exec /bin/bash "$script"`, detached, output to ~/Library/Logs/Engelbart/update.log (truncated), env PATH=/usr/bin:/bin:/usr/sbin:/sbin, HOME, TMPDIR, LANG, ENGELBART_DOWNLOADS, ENGELBART_WAIT_PID, ENGELBART_APP_PATH (the .app), ENGELBART_READY_FILE, ENGELBART_REOPEN_FILE (`<tmp>/engelbart-update-<pid>-<ms>-<n>.ready/.reopen`), ENGELBART_NO_OPEN=1 passed on | updates.cjs:111-129; updates.test:94-131,171-178 | Updates.swift (log at ~/Library/Logs/Engelbart Swift/update.log, beside the Swift app's own data; the Swift app's install.sh does not exist yet) | done (local run; cloud run pending) |
| 124 | While installing: Dock progress indeterminate (2) until curl's percentage; every 500 ms the last `NN.N%` in the log's last 4096 bytes; told only when the whole number changes; menu "Downloading Update…[ NN%]" | updates.cjs:63-81,134-143,289; updates.test:115-131 | Updates.swift | partial: the values (2, N/100, -1) are tested; DockProgress's tile drawing has not been seen in a run |
| 125 | Ready file → state ready, Dock bar cleared (-1), ready file removed; then "Engelbart <v> is ready" with Restart to Update / Later (default 0, cancel 1); detail names running terminal sessions ("Restarting ends N running terminal session(s), which cannot be recovered. Later, it is installed the next time you quit. Documents are already saved.") or "Engelbart quits and opens again with it. Later, it is installed the next time you quit. Your projects and notes stay as they are." | updates.cjs:144-149,175-190; updates.test:133-146,199-206 | Updates.swift | done (local run; cloud run pending) |
| 126 | The command exits/errors: not alive, reopen file removed; while installing → idle, Dock cleared, "Engelbart <v> could not be installed" with the log's last 3 lines (progress bars left out) or "The install command stopped (exit status N)." + "This version is still installed. The details are in <log>."; spawn error → "Engelbart could not be updated" | updates.cjs:152-170; updates.test:275-304 | Updates.swift | done (local run; cloud run pending) |
| 127 | restart({warned}): only when ready; developer ID → quitAndInstall; a waiting command → write its reopen file, requestQuit({update: warned}); a stopped one → run again (quitWhenReady), reopen file written at once, quits itself once ready; a quit that does not go ahead removes the reopen file | updates.cjs:192-216; updates.test:148-273 | Updates.swift | done (local run; cloud run pending) |
| 128 | later(): ready and not dismissed → dismissed, told; the menu keeps Restart to Update | updates.cjs:219-222 | Updates.swift | done (local run; cloud run pending) |
| 129 | Manual check (menu): "Engelbart <v> is the newest version."; developer ID "Engelbart <v> is downloading." / "You will be asked to restart when it is ready."; ad hoc → offer again (manual offers even if offered); failure "Engelbart could not check for updates" with the first line | updates.cjs:257-276; updates.test:306-317 | Updates.swift | done (local run; cloud run pending) |
| 130 | Menu item by state: Restart to Update · Downloading Update…[ N%] (disabled) · Checking for Updates… (disabled) · Check for Updates… | updates.cjs:287-292 | Updates.swift `menuItem` | done (local run; cloud run pending) |
| 131 | Developer ID path: download in the background, install at quit, "Restart Now"/"Later" offer with "Restart to finish updating, or it will be installed the next time you quit. …" | updates.cjs:8-9,227-255; updates.test:319-327 | Updates.swift (`UpdateChecker` protocol) | partial: the state machine is ported and tested with a fake checker; the Swift app has no Developer ID downloader (electron-updater's part), so `FeedChecker.quitAndInstall` does nothing |
| 132 | ENGELBART_CONFIRM_ALL=1 answers every dialog with its first button (scripted runs) | updates.cjs:98 | Updates.swift | done (local run; cloud run pending) |
| 133 | Dialogs are sheets on the focused window when there is one | updates.cjs:96-100 | UpdateAlerts.swift (NSAlert sheet on the key window, else modal) | partial: not run in a window |

## P. Update banner (UpdateBanner.jsx; MATH-43)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| 134 | Shows only when enabled and installing, or ready and not dismissed | UpdateBanner.jsx:18; update-banner.test:43-45 | UpdateBanner.swift `showsUpdate` | done (local run; cloud run pending) |
| 135 | Installing: 260 wide, "Downloading Engelbart <v>…[ N%]", a 2 pt #eaeaea track (radius 1) with a #0070f3 bar: N% wide (200 ms linear) or a 33% bar sliding −100%→300% over 1.2 s ease-in-out until a percentage | UpdateBanner.jsx:25-36; update-banner.test:27-35 | UpdateBanner.swift | done (local run; cloud run pending) |
| 136 | Ready: "Engelbart <v> is ready." + "Restart to Update" (500, ink; tooltip "Quit and open again as the new version") + "Later" (#8f8f8f; tooltip "It is installed the next time you quit"); buttons padding 3 6, radius 5, 12.5/1.4, ink on hover (120 ms) | UpdateBanner.jsx:15,38-44; update-banner.test:37-41 | UpdateBanner.swift | done (local run; cloud run pending) |
| 137 | Box: padding 7 12 (ready 5 6 5 12), 1px #eaeaea, radius 8, white, 12.5/1.5 ink, rise 160 ms, max width window − 48; no name → "Engelbart" | UpdateBanner.jsx:23-24 | UpdateBanner.swift | done (local run; cloud run pending) |
| 138 | Placement: the document column's bottom-right on the workspace (right = max(24, window − column.right + 16), bottom = max(18, window − column.bottom + 18)), else the window's corner (24, 18); follows resizes | UpdateBanner.jsx:12-13,48-53,67-83 | UpdateBanner.swift `UpdateBannerPlacement` | done (local run; cloud run pending) |
| 139 | Later in a window hides the banner at once there (optimistic) and asks main, which hides it in every window | UpdateBanner.jsx:86-89 | UpdateBannerModel | done (local run; cloud run pending) |
| 140 | The state now, then every change; an event that comes before the first answer wins | UpdateBanner.jsx:59-65 | UpdateBannerModel | done (local run; cloud run pending) |
