# Parity ledger: Build (agents that change the code)

Sources: `src/main/build/*` (manager, store, context, prompt, policy, runner, git, git-guard, keep, engelbart-tools,
engelbart-mcp, run-step, run-tools, run-processes, run-mcp, runnables), `src/shared/build-history.cjs`, the build
handlers of `src/main/ipc.cjs` / `src/main/index.cjs` / `src/preload.cjs`, renderer `BuildPanel.jsx`, `BuildReview.jsx`,
`BuildReject.jsx`, `BuildDetails.jsx`, `RunTimeline.jsx`, `run-timeline.css`, `build-details.css`, models
`canvas-build.js`, `run-steps.js`, `build-target.js`, `local-build.js`, `build-events.js`, `build-diff.js`; the Build
card parts of `DocEditor.jsx` (buildParts/buildRunHtml/buildDiffHtml, for the embeddable card model); specs
`2026-09-25-build-workflow-design.md` B1–B30 and desktop design §2 #98–101; memory notes
accept-blocked-by-dirty-file.md and the Build sections of engelbart-desktop-experiment.md. Tests: build.test,
build-git, build-reach, run-step, repo-runnables, build-diff, build-target, build-events, build-steps,
local-build-steps, build-card.

Swift paths are relative to `mac/Packages/Build/Sources/EngelbartBuild/`. Status per ARCHITECTURE §6.

**Verification:** cloud run https://github.com/Mathetic-PBC/engelbart-canvas/actions/runs/40754986925 passed all 73
tests (GitTests, ReachTests, RunnerTests, ManagerTests, RunStepTests, ModelTests). Rows marked "compiled, untested" are
ones no test exercises (the views, BuildService validation, BuildSetup, migrateDefault, setDefault, sweepCopy,
LocalClaude prepare/run, focusApp, runState, the `--mcp run` server).

**Deliberate differences:** B15 (the dirty-file staging trick, asked by the orchestrator, falls back to Electron's
refusal); H12 (the MCP server is this app with `--mcp`, so no ELECTRON_RUN_AS_NODE); E2 (SQLite record names added to
the policy); Stop kills the turn's whole process group, not only the shell (Node killed the child, which `exec` had made
the CLI itself).

## A. Records (store.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| A1 | Record at `<project.dir>/builds/<id>/task.json`, frozen first message at `context.md` | store.cjs, B4 | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A2 | Build id = 10 lowercase hex chars (randomBytes(5)); any other id → "build id is invalid" (TypeError) for taskDir | store.cjs ID_RE | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A3 | freeId: up to 20 tries, unused folder and `taken(id)` false (branch `engelbart/<id>` exists) else "No free Build id" | store.cjs freeId | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A4 | writeTask: folder mode 0700, messages cut to last 200, stamped `updated` ISO; written atomically (JSON pretty) | store.cjs writeTask | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A5 | readTask returns null for a bad id, a missing file, or a record whose id differs | store.cjs readTask | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A6 | listTasks: names matching ID_RE, readable, sorted by `created` (string compare) | store.cjs listTasks | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A7 | writeContext: 0700 folder, temp `<file>.<pid>.tmp` mode 0600, renamed; readContext null when missing | store.cjs | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A8 | message(role,text,at,images): text cut to 40,000 chars, `images` only when non-empty | store.cjs message | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A9 | STATUSES (13), FINAL = accepted/discarded, WORKING = setting-up/queued/running/accepting | store.cjs | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |
| A10 | publicTask: the exact field list (id…final), `checkpoints` as a count, `keptCopy` bool, nulls for missing | store.cjs publicTask | TaskStore.swift | done (cloud run 40754986925, 73/73 tests) |

## B. Git (git.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| B1 | Every git call: `-c core.hooksPath=/dev/null -c core.quotepath=off -c advice.detachedHead=false`; env without GIT_*, plus GIT_TERMINAL_PROMPT=0, GIT_EDITOR=true, GIT_SEQUENCE_EDITOR=true, GIT_MERGE_AUTOEDIT=no, GIT_PAGER=cat, PAGER=cat, LC_MESSAGES=C, LANGUAGE=en | git.cjs createGit | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B2 | exec never throws (code, stdout, stderr, missing); must() throws GitError with git's first non-empty line, output tail 4000; "Git was not found." code missing | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B3 | Timeouts 120 s default, 600 s for worktree add/remove/move, rebase, merges, clone, init add/commit | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B4 | head → {sha, branch|nil (detached)}; revParse `<ref>^{commit}` | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B5 | dirtyPaths: porcelain v1 -z, untracked all, rename/copy skips old path | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B6 | identity: person's user.name+email else Engelbart / build@engelbart.local (own:false) | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B7 | addWorktree: parent 0700, `worktree prune`, reuse an existing branch else `-b branch dir startSha` | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B8 | removeWorktree: `worktree remove --force --force`, rm -rf if it is still there, prune; moveWorktree; deleteBranch -D → bool | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B9 | merging (MERGE_HEAD in git dir), abortMerge | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B10 | checkpoint: add -A; nothing staged → nil; commit --no-verify as identity → sha | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B11 | diff: name-status + numstat (renames), binary flag, patch cut at maxPatch (2,000,000) with `truncated` | git.cjs diff | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B12 | workingDiff: a copy of the index (`engelbart-live-<pid>-<rand>.index` in the git dir), add -A, write-tree, diff to it; the real index untouched | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B13 | squashOnto: detach, reset --soft base, nothing → nil, commit -F - message, rebase onto; conflict → abort, GitError conflict with files ("Your branch changed the same lines in …"); always back on branch on failure | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B14 | fastForward: refuses when the folder moved ("Your folder moved while this was being accepted.", moved); ff-only; untracked overwrite / local changes parsed into `overwrite` errors with the files and the exact sentences | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B15 | Dirty-file staging trick (memory note accept-blocked-by-dirty-file): before refusing for "uncommitted edits", each listed file whose index equals HEAD gets the Build's patch applied to index and worktree when both apply cleanly, then the fast-forward again; anything fails → files and index restored, the Electron refusal stands. Swift addition asked by the orchestrator | memory note; deviation | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B16 | mergeInto: merge --no-ff --no-edit; conflicts → files; failure without conflicted files throws | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B17 | concludeMerge: add -A then commit when MERGE_HEAD, else checkpoint | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B18 | treeWithout: scratch index in tmp, read-tree HEAD, reverse-apply each run-step sha (newest first, binary full-index) → tree or nil | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B19 | init(dir, own): init when not inside a work tree (own: no .git here), .gitignore `node_modules/ .env .env.* .DS_Store` when none, add -A, commit --allow-empty "First snapshot (Engelbart)" | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B20 | clone(url, dir, token): `clone --quiet -- url dir`; with a token the GITHUB_HELPER credential helper through GIT_CONFIG_COUNT + ENGELBART_GITHUB_TOKEN env only | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B21 | holdBranch: put HEAD back on refs/heads/<branch> at the turn's start sha (update-ref / symbolic-ref), a concluded merge kept when the turn started merging → {branch, commits} | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B22 | markers: files whose added lines hold `<<<<<<<`/`>>>>>>>` between two commits | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |
| B23 | branchExists, mergeBase, isAncestor, conflicted, checkoutBranch, message, top | git.cjs | Git.swift | done (cloud run 40754986925, 73/73 tests) |

## C. The git ban (git-guard.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| C1 | The shim `bin/git` (byte-for-byte script): reads/files allowed, history/refs/settings of the Build's repository refused with Engelbart's sentences, push refused everywhere, aliases read once | git-guard.cjs SHIM | GitGuard.swift | done (cloud run 40754986925, 73/73 tests) |
| C2 | hooks/reference-transaction (refuses changes under refs/, ignores old==new) and hooks/pre-push | git-guard.cjs | GitGuard.swift | done (cloud run 40754986925, 73/73 tests) |
| C3 | prepareGitGuard writes bin/, hooks/ (0700), files only when changed, modes 0755/0644; build.gitconfig with core.hooksPath | git-guard.cjs | GitGuard.swift | done (cloud run 40754986925, 73/73 tests) |
| C4 | gitCommonDir from .git dir or file + commondir, realpath; nil otherwise | git-guard.cjs | GitGuard.swift | done (cloud run 40754986925, 73/73 tests) |
| C5 | guardEnvironment: ENGELBART_BUILD_GUARD, ENGELBART_BUILD_GIT_DIR, GIT_CONFIG_PARAMETERS (includeIf gitdir + gitdir/**, pushInsteadOf engelbart-no-push:// for https/http/ssh/git/git@), the person's own appended | git-guard.cjs | GitGuard.swift | done (cloud run 40754986925, 73/73 tests) |
| C6 | guardPath: POSIX `PATH="$ENGELBART_BUILD_GUARD:$PATH"; `, fish `set -gx PATH $ENGELBART_BUILD_GUARD $PATH; ` | git-guard.cjs | GitGuard.swift | done (cloud run 40754986925, 73/73 tests) |

## D. Papers kept (keep.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| D1 | Before a turn: every library row's absolute `path` and every file under `<dataRoot>/annotations` hard-linked into the keep dir (emptied first, 0700), a copy when the link fails and the file ≤ 20 MB; at most 20,000 | keep.cjs | Keep.swift | done (cloud run 40754986925, 73/73 tests) |
| D2 | `papers`: pdf/image rows outside the kept folders | keep.cjs | Keep.swift | done (cloud run 40754986925, 73/73 tests) |
| D3 | restore: a gone file put back ("deleted"); a paper/picture or a file in a kept folder replaced (inode change; for copies size/mtime too) and differing bytes put back ("changed"); notes edited stay; rows the person removed/moved meanwhile, ink of a removed row skipped; keep dir removed | keep.cjs | Keep.swift | done (cloud run 40754986925, 73/73 tests) |
| D4 | Put back whole: temp `<file>.engelbart-<pid>.tmp` (link, else copy) renamed over | keep.cjs putBack | Keep.swift | done (cloud run 40754986925, 73/73 tests) |

## E. Policy (policy.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| E1 | folders [project dir, dataRoot/assets], writable [project dir], kept [assets, project/assets], records list (builds, notes.pglite, .context, .legacy, project.json, **/meta.json; library.pglite, config.json, state.json, github.json, zotero.json), papers ≤2000 unique, gitDir, personal/subagents true, computerUse false | policy.cjs | Policy.swift | done (cloud run 40754986925, 73/73 tests) |
| E2 | The Swift data root's SQLite files are records too (library.sqlite, notes.sqlite) beside the PGlite names | ARCHITECTURE §3 | Policy.swift | done (cloud run 40754986925, 73/73 tests) |
| E3 | claudeSettings: allow mcp__engelbart; deny Edit/Write/NotebookEdit on `//kept/**`, records (`/**` unless .json), each paper; deny mcp__computer-use; never a rule on the worktrees | policy.cjs | Policy.swift | done (cloud run 40754986925, 73/73 tests) |

## F. Prompt (prompt.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| F1 | BUILD_SYSTEM_PROMPT text (CORE_PERSONALITY + "# Your role: Build" + rules) verbatim | prompt.cjs, personality.cjs | Prompt.swift | done (cloud run 40754986925, 73/73 tests) |
| F2 | `<dataRoot>/.context/build-system-prompt.md` replaces it when non-empty; quick adds QUICK_PARAGRAPH | prompt.cjs | Prompt.swift | done (cloud run 40754986925, 73/73 tests) |
| F3 | readEnding: quick + <600 chars + ESCALATE: → escalated (why ≤400, text ''); last non-empty line NEEDS YOU: → needs-you (question backticks stripped, ≤600; quick → escalated with why); else done | prompt.cjs | Prompt.swift | done (cloud run 40754986925, 73/73 tests) |

## G. Context (context.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| G1 | freezeContext order: `<engelbart>` head, custom instructions, project page, MEMORY block, `<task>` (four texts), then post-it/request/workspace, attached, history, `<context_json>` | context.cjs | Context.swift | done (cloud run 40754986925, 73/73 tests) |
| G2 | Head lines: project, description (whitespace squashed), working copy, branch line (12-char sha, "a detached commit"), person's folder, notes folder, built from | context.cjs | Context.swift | done (cloud run 40754986925, 73/73 tests) |
| G3 | Workspace text with `build> <id>` lines dropped and mentions expanded (attr escaped, ≤200) | context.cjs expandText | Context.swift | done (cloud run 40754986925, 73/73 tests) |
| G4 | attached: rows attached, not already seen, not images; history = latest archive with its note, not for a request | context.cjs | Context.swift | done (cloud run 40754986925, 73/73 tests) |
| G5 | replyMessage `<reply>` + `<attachments note=…>` list `[Attachment n]: path` | context.cjs | Context.swift | done (cloud run 40754986925, 73/73 tests) |
| G6 | freshMessage: context, `<conversation note=…>` of agent/you turns, the new message | context.cjs | Context.swift | done (cloud run 40754986925, 73/73 tests) |
| G7 | contextParts: top-level blocks by name (repeats joined), `other` | context.cjs | Context.swift | done (cloud run 40754986925, 73/73 tests) |

## H. Runner (runner.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| H1 | One process per turn in the login shell (`-ilc`, fish `--login --interactive --command`), cwd = task cwd, env: sanitized + scrubbed, API keys removed (NOT_THE_SUBSCRIPTION), tools env, values only through env | runner.cjs | Runner.swift, LoginShell.swift | done (cloud run 40754986925, 73/73 tests) |
| H2 | Claude command line exactly (stream-json, --session-id / --resume, --setting-sources user,project,local, --mcp-config when bridged, --no-chrome, --tools list, --permission-mode auto --permission-prompts none, --add-dir per folder, --settings, --model, --effort, --append-system-prompt-file, < input) | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H3 | Claude session id named before the run (uuid); result = last `type:result` line; errors: not found, time limit, no result, is_error text ≤500 | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H4 | Codex: ChatGPT sign-in required (auth.json auth_mode chatgpt + tokens) else unavailable; `exec --color never` / `exec resume "$S"`; -m, -c effort/sandbox_mode/approval_policy/approvals_reviewer/tools.web_search, overrides via ENGELBART_BUILD_C<n>; --json -o output | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H5 | codexOverrides: developer_instructions, features.multi_agent, writable_roots, computer_use/browser_use/browser_use_external false, `mcp_servers.computer-use.enabled=false` only when config.toml has it, engelbart server command/args | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H6 | Codex thread from `thread.started`; output file text; failure reason = last error/turn.failed/ERROR line (not "resuming with"), ≤500 | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H7 | Stopped → TurnError stopped with the session (Claude's named id, Codex's printed thread) | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H8 | Turn files in runDirectory (`<id>-<uuid>.*`, 0600) removed after; the git guard written under runDirectory/git-guard and put first on PATH when policy.gitDir | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H9 | Engelbart's own git (tools env ENGELBART_GIT_BIN) first on PATH; ENGELBART_<NAME>_BIN when tools name a binary | runner.cjs, launch.cjs | Runner.swift, LoginShell.swift | done (cloud run 40754986925, 73/73 tests) |
| H10 | onEvent(raw) before onUpdate; a throwing watcher never reaches the turn | runner.cjs | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H11 | Fake runner (ENGELBART_BUILD_FAKE=1, delay ENGELBART_BUILD_FAKE_MS default 900): BUILD-FAKE.md line per turn, Write tool events, "question" → NEEDS YOU, quick "escalate" → ESCALATE, "fail" → failed, stop rejects | runner.cjs createFakeRunner | Runner.swift | done (cloud run 40754986925, 73/73 tests) |
| H12 | The engelbart MCP server is this executable `--mcp engelbart <connection.json>` (Electron: node + engelbart-mcp.cjs + ELECTRON_RUN_AS_NODE) | runner.cjs | Runner.swift, MCP.swift | done (cloud run 40754986925, 73/73 tests) |

## I. Activity (bart/activity.cjs, used by Build)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| I1 | pathLabeller, claudeUpdate (tool labels incl. engelbart tools, Edit/Write, Bash), codexUpdate (commands, web search, reasoning, mcp, file_change, agent_message), commandLabel | activity.cjs | Activity.swift | done (cloud run 40754986925, 73/73 tests) |
| I2 | Feed: activity once per change ({activity, log?}), text throttled 100 ms as {lines}, ESCALATE text never previewed, reset/end | activity.cjs createFeed | Activity.swift | partial: progress {lines} are the text's plain lines, not bart/reply.cjs bodyLines (Bart owns it); compiled, untested |

## J. Targets, preflight, the default repo (manager.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| J1 | targetOf: project / library (uuid id) / default | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| J2 | targets: default first, the code directory when a repository (not the default's folder), the project's git rows (folder there or a GitHub url), each folder once, place default/project/local/github | manager.cjs targets | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J3 | preflight: no-directory / no-git / not-here (canClone, cloneTo relative) / create for a fresh default / init for a picked folder without history / dirty count / problems | manager.cjs preflight | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J4 | initRepository refuses when it cannot init (first problem, or "This folder already has a history.") | manager.cjs | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J5 | newFolder: slug of the project name, -2…-99; a folder of the person's (not empty, no own history) never taken; "No free folder for the default repository" | manager.cjs | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J6 | migrateDefault from project.json defaultRepoId/repositories and defaultRepo; note line in builds/history.log | manager.cjs | Manager+Targets.swift | done (compiled, untested; no test exercises it) |
| J7 | defaultFolder: defaultTarget project / library row's folder; gone → code dir with history (keep project) else a new folder (fresh, keep made) | manager.cjs | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J8 | recordDefault: one git row per folder (type folder, tags [git], source engelbart, category repo), serialized per folder | manager.cjs | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J9 | setDefault: only project/library that passes preflight (not init) — errors as Electron; returns the list | manager.cjs | Manager+Targets.swift | done (compiled, untested; no test exercises it) |
| J10 | prepareDefault (a folder Engelbart made): nothing while git not ready; makes and keeps the default | manager.cjs | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J11 | cloneRepository: into repos/<name>(-n); token first, the person's git when GitHub refuses; refusal message about the GitHub App; row updated (folder_path), libraryChanged | manager.cjs | Manager+Targets.swift | done (cloud run 40754986925, 73/73 tests) |
| J12 | Serialized git writers per repository / per key (chains) | manager.cjs serial | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## K. Start and turns

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| K1 | start: quick or build; a post-it's/line's text trimmed, empty → "The sticky is empty."; post-it Builds always in the default repo | manager.cjs start | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K2 | Clone first when not here; create/init then preflight again; first problem thrown; keepDefault | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K3 | Title: post-it title (first line without markdown, ≤80, "Quick task") or the workspace name | manager.cjs postItTitle | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K4 | resolveBuildChoice; HEAD must be on a branch ("The code folder is not on a branch."); id free of branches | manager.cjs | Manager.swift, Models.swift | done (cloud run 40754986925, 73/73 tests) |
| K5 | Worktree `<dataRoot>/worktrees/<slug>/<id>`, cwd keeps the folder's place inside the repository; attach ≤50 unique uuids | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K6 | The first message "Started on <model> <effort> in <target>, from <branch> at <sha7>[; n uncommitted file(s) left out]." | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K7 | routedFrom (`route-…`), fromLine, place (ref/line/text ≤8000) | manager.cjs placeOfTask | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K8 | Context frozen; a post-it added to a workspace imported as an archived version; workspace's builds list, attachments linked, ⌘J recent | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K9 | prepare: worktree added (serialized), setup; failure → failed "The Build's copy could not be made: …"; discarded meanwhile → cleaned up | manager.cjs prepare | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K10 | setupWorktree: top-level `.env*` copied from repo and source; project.json build.setup runs (ENGELBART_SOURCE_DIR), failure "the setup command failed: <last 3 lines>"; '' = nothing; else node_modules cloned `cp -cR` | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K11 | Slots: 3 build, 1 quick; queued status while full; stop while waiting → "Stopped before it started." | manager.cjs slot | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K12 | Turn time limits 180 min / 20 min | manager.cjs TURN_MS | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K13 | Around the agent: library kept aside, head + merging read, tool bridge opened; status running, turn+1, agentStarted | manager.cjs runTurn | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K14 | Progress feed → `engelbart:build-progress`; diff watched (700 ms after an update, one read at a time) → `engelbart:build-diff` running true; once more after the turn running false | manager.cjs watchDiff | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K15 | No session (first cut short) → freshMessage; a session that will not resume → freshMessage once | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K16 | After: bridge closed, library restored, branch held, guard notes on the card (exact sentences) | manager.cjs guardNotes | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K17 | Unfinished conflict resolution aborted (conflict status); else concludeMerge "Build <title>: turn <n>"; checkpoint failure note | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K18 | Endings: cut for reply (running, silent); stopped/interrupted notes; failed with error; needs-you/escalated/review | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K19 | After the turn: a queued reply sent next; landing → accept again; quick review → auto accept; build review → run step | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| K20 | Agent map run log: start/step/event/output/finish per turn (`<id>:<turn>`) | manager.cjs | Manager.swift | partial: records complete, but JSONValue keeps no key order, so the first turn's context blocks arrive unordered; compiled, untested |
| K21 | Tool lock: tools.ensure(agent) then tools.use(agent, call) | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## L. Reply, stop, resume

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| L1 | reply: empty → unchanged; final → "This Build is closed."; accepting → "It is being accepted; reply once that is done." | manager.cjs reply | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| L2 | Pasted images: only this project's image rows on disk, ≤50, kept only when the text still names `[Attachment n]` | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| L3 | While working/setting up: queued (joined by blank line), images appended, landing cleared; interrupt → stop('reply') | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| L4 | Copy gone → "This Build's copy is gone; discard it."; else message saved, next turn | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| L5 | stop(projectId,id,why) → bool | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| L6 | resume: setup again when the copy is missing or turn 0; else "Resumed." and the cut-off message | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## M. Review

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| M1 | Accepted → its commit's diff, from baseBranch, sha | manager.cjs review | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| M2 | Copy gone → "This Build's copy is gone."; while running or no run-step changes → workingDiff (CARD_PATCH 400,000) | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| M3 | Run-step checkpoints apart (treeWithout) or, when lines overlap, all together with each run step's own diff (apart:false) | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## N. Accept

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| N1 | Refusals: final → unchanged; working/setting-up/accepting → "It is still working."; copy gone; halted project "Its project is being deleted." | manager.cjs accept | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| N2 | accepting status; serialized per repository; concludeMerge "before accept"; target must be on a branch ("Your code folder is not on a branch.") | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| N3 | One commit: title, last agent summary (≤3000), "Engelbart Build <id> · <model> <effort> · <n> turn(s)" | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| N4 | Conflict message "<branch> and this Build changed the same lines in …"; markers → conflict with markers:true | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| N5 | Checks: project.json build.check ('' = none) else `npm test` when package.json has a real test script; run in a detached login shell with CI=1 (10 min); failure → "The checks failed (<cmd>)." with checks record | manager.cjs checkCommand, createShell | Manager.swift, LoginShell.swift | done (cloud run 40754986925, 73/73 tests) |
| N6 | checkOutput: last 4000 chars, prefixed by the failed test names (TAP/spec/Jest/pytest) before it, ≤40 | manager.cjs | LoginShell.swift | done (cloud run 40754986925, 73/73 tests) |
| N7 | Fast-forward; failure → back on the branch; runnables recorded at what landed; kept copy when something runs (detached), else worktree+branch removed | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| N8 | Accepted message (auto quick note, nothing changed, keep running note, unkept note) | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| N9 | Refused: status conflict / review / before; checks kept; landing attempt+1 while < 2 auto fixes, "Still refused after the agent's fix(es)" note; failure sending → error | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## O. Fix

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| O1 | Conflict: merge the person's branch in; clean → review "merged in without conflicts. Accept again." (and Accept again when landing) | manager.cjs sendFix | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| O2 | Conflict files → the agent note; markers left → their note; failed checks → their note with output | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| O3 | Summary on the card ("; Accept runs again when it is done." while landing) | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## P. Discard, promote, trash, recovery, quit

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| P1 | discard: stop and wait, refuse while accepting, stop run steps, "Discarded.", copy removed (not while setting up) | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P2 | promote: only a quick task not working; archived version; same provider → same session, another → fresh; "Moved to the workspace … as a Build[ on m e]." | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P3 | postItOf from the record or (old records) the frozen context | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P4 | stopProject: refused while accepting; turns stopped; kept copies released; working records interrupted | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P5 | removeWorktrees, moveWorktree | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P6 | reconcile once per data root: gone copy → failed; working → interrupted; run step left running → stopped; kept copies of a crash swept | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P7 | list/get with `working`; openIds | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| P8 | stopAll on quit: every turn stopped (quit → interrupted), run steps stopped, kept copies released; at most 20 s | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |

## Q. Run step (run-step.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| Q1 | Only after a Build turn ends in review; the last run step's processes stopped first; skipped (with message) when the repository has no row | manager.cjs startRunStep | Manager+RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q2 | Model: the Build's when Claude, else Build's Claude default | manager.cjs | Manager+RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q3 | changed paths (diff --name-only --relative base HEAD, ≤200) | manager.cjs | Manager+RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q4 | Stored verified commands tried first; all passed and no uncovered folder → done without the agent | run-step.cjs | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q5 | Agent prompt text (web-only / all kinds variants, CHECKS, tried note) verbatim | run-step.cjs prompt | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q6 | declare/start/status handlers, per-runnable 20 min, install ≤10 min, terminal check ≤2 min, out of time messages | run-step.cjs | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q7 | Watchdog every 2 s: deadlines, declare within 10 min, wind-down 3 min after settled, cap | run-step.cjs | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q8 | Finally: un-passed runnables failed ("The run step ended before it passed its check.") unless halted; agent's processes stopped | run-step.cjs | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q9 | halt, stop, stopAll, stopOne, terminal (reuse running session), focus, holds, working | run-step.cjs | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q10 | Run-step checkpoint "Build <title>: run step" (step:'run'), runLine message variants | manager.cjs | Manager+RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q11 | showRunnable: ui → engelbart:build-run {kind ui, url}; app → focus or error; terminal → session (record's sessionId updated) | manager.cjs | Manager+RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q12 | stopRunnable / releaseCopy / sweepCopy / stopRunning with their messages | manager.cjs | Manager+RunStep.swift | done (compiled, untested; no test exercises it) |
| Q13 | recordRunnables on Accept: passed → verify at the commit; failed → fail with error | manager.cjs | Manager+RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q14 | Local Claude for the run agent: claudeArguments (restricted, no tools but mcp__canvas__*, dontAsk, --max-turns), subscription check, the canvas MCP server = this executable `--mcp run <connection>`, init must report it connected | local-claude.cjs | LocalClaude.swift | done (compiled, untested; no test exercises it) |
| Q15 | Fake run agent (ENGELBART_BUILD_FAKE / ENGELBART_RUN_FAKE): start script → web UI, bin → terminal | run-step.cjs | RunStep.swift | done (cloud run 40754986925, 73/73 tests) |
| Q16 | ENGELBART_RUN_STEP=off: no run step | index.cjs | BuildSetup.swift | done (compiled, untested; no test exercises it) |
| Q17 | Launch facts (discoverLocal) bounded: 120 folders, depth 3, 8 components, 11,900 bytes, never through a link | launch-discovery.cjs | LaunchDiscovery.swift | done (cloud run 40754986925, 73/73 tests) |

## R. Run processes (run-processes.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| R1 | Each process the leader of its own group in the login shell, BROWSER=none, output last 32 KB | run-processes.cjs | RunProcesses.swift | done (cloud run 40754986925, 73/73 tests) |
| R2 | stop: SIGTERM group, 5 s, SIGKILL; always a last SIGKILL to the group | run-processes.cjs | RunProcesses.swift | done (cloud run 40754986925, 73/73 tests) |
| R3 | check ui: 127.0.0.1 and [::1] answer < 500 without "Invalid Host header"/"not allowed" within 90 s → url http://localhost:<port>/; exit before → message; app alive 10 s | run-processes.cjs | RunProcesses.swift | done (cloud run 40754986925, 73/73 tests) |
| R4 | runToExit with timeout and abort; freePort; groupPids via ps; focus app (NSRunningApplication, regular policy); stopLeftover only when cwd is inside the copy | run-processes.cjs | RunProcesses.swift | done (compiled, untested; no test exercises it) |

## S. Run tools (run-tools.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| S1 | RUN_TOOLS definitions and descriptions verbatim; RUN_KINDS ['ui'], ALL_KINDS | run-tools.cjs | RunTools.swift | done (cloud run 40754986925, 73/73 tests) |
| S2 | worktreePath: inside root, not through a link, not .git, ≤4096, no NUL | run-tools.cjs | RunTools.swift | done (cloud run 40754986925, 73/73 tests) |
| S3 | validateRunTool (schemas, types, kinds message) | run-tools.cjs | RunTools.swift | done (cloud run 40754986925, 73/73 tests) |
| S4 | One at a time; LAUNCHES refused; read 64 KB, write (not a link), list (IGNORE, ≤300), run_command (timeout ≤600 s, output last 16,000); closed | run-tools.cjs | RunTools.swift | done (cloud run 40754986925, 73/73 tests) |

## T. Runnables (runnables.cjs; table in the Store)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| T1 | runnableFolder normalisation and refusals; runnableName regex; runnableType; runnableCommand ({port} for ui, ≤4000); withPort | runnables.cjs | Runnables.swift | done (cloud run 40754986925, 73/73 tests) |
| T2 | declare upsert (type change → pending, commands cleared), verify (commit sha 7–64 hex else null), fail (error tail 4000), list ordered by folder, name | runnables.cjs | Runnables.swift | done (cloud run 40754986925, 73/73 tests) |
| T3 | The table reached through `RepoRunnablesTable` (the Store implements it on SQLite) | ARCHITECTURE §3 | Host.swift | done (cloud run 40754986925, 73/73 tests) |

## U. Engelbart's tools (engelbart-tools.cjs)

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| U1 | Tool definitions verbatim; validateEngelbartTool messages | engelbart-tools.cjs | EngelbartTools.swift | done (cloud run 40754986925, 73/73 tests) |
| U2 | save_file md → note; other formats → assets/files/<uuid>/<name>.<ext>; ≤100 KB | engelbart-tools.cjs | EngelbartTools.swift | done (cloud run 40754986925, 73/73 tests) |
| U3 | duplicate_file by id or path; folders/repos/pages cannot be copied | engelbart-tools.cjs | EngelbartTools.swift | done (cloud run 40754986925, 73/73 tests) |
| U4 | move_file_into_engelbart: ~/, file://, relative; already in the library refused; original removed unless kept, the person's folder, or an Engelbart folder | engelbart-tools.cjs | EngelbartTools.swift | done (cloud run 40754986925, 73/73 tests) |
| U5 | Each row linked to the workspace and announced (libraryChanged) | engelbart-tools.cjs | EngelbartTools.swift | done (cloud run 40754986925, 73/73 tests) |

## V. Bridge and MCP servers

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| V1 | Loopback bridge: POST /tools on 127.0.0.1, Bearer token (64 hex), no Origin, Host check, body ≤128,000 (413), result JSON text, errors isError tail 2000 | local-tools.cjs openToolBridge | ToolBridge.swift | done (cloud run 40754986925, 73/73 tests) |
| V2 | `--mcp engelbart <conn>`: serves ENGELBART_TOOLS, forwards calls to the bridge (230 s); connection validated | engelbart-mcp.cjs, local-mcp.cjs | MCP.swift | done (cloud run 40754986925, 73/73 tests) |
| V3 | `--mcp run <conn>`: serves RUN_TOOLS as `engelbart-run-step` | run-mcp.cjs | MCP.swift | done (compiled, untested; no test exercises it) |

## W. IPC surface (ipc.cjs / preload.cjs) → BuildService

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| W1 | build-models(place), build-targets, build-set-default, build-preflight, build-init, build-clone, build-start (field limits), build-list, build-get, build-reply (≤100,000; images ≤50), build-stop, build-resume, build-review, build-accept, build-fix, build-discard, build-run-show, build-run-stop, build-run-stop-runnable, build-promote | ipc.cjs | Service.swift | done (compiled, untested; no test exercises it) |
| W2 | buildId validated `^[0-9a-f]{10}$` "build id is invalid"; target validated (default/project/library) | ipc.cjs | Service.swift | done (compiled, untested; no test exercises it) |
| W3 | Events: engelbart:build (public record), engelbart:build-progress, engelbart:build-diff, engelbart:build-run, engelbart:nav | manager.cjs | Manager.swift | done (cloud run 40754986925, 73/73 tests) |
| W4 | engelbart:build-quick / build-quick-open (post-its) and routeRun to the asking window | post-its/views.cjs, index.cjs | n/a | n/a: the app/post-it windows route these (API.md) |
| W5 | Clear keeps lines of open Builds (openIds + BUILD_LINE_RE) | ipc.cjs keepOpenBuilds | Service.swift | done (compiled, untested; no test exercises it) |

## X. Renderer models

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| X1 | diffRows (file headers, hunks, add/del/ctx/note, bookkeeping skipped, maxLines 2500, cut, unreached files), diffTotals, nextAttachment | build-diff.js | BuildDiff.swift | done (cloud run 40754986925, 73/73 tests) |
| X2 | build-target: per-workspace pick (old per-project key), DEFAULT_TARGET when missing, targetKey/sameTarget/targetTag | build-target.js | BuildTarget.swift | done (cloud run 40754986925, 73/73 tests) |
| X3 | terminalLines, mergeEvents, plainError, STATUS_LABEL | build-events.js | BuildEvents.swift | done (cloud run 40754986925, 73/73 tests) |
| X4 | runSteps, runState, stepDuration, runDuration, formatDuration, formatDay, planner | run-steps.js | RunSteps.swift | done (compiled, untested; no test exercises it) |
| X5 | buildEvents, timeToLive, canvasBuildSteps | canvas-build.js | CanvasBuild.swift | done (cloud run 40754986925, 73/73 tests) |
| X6 | localBuildSteps, isAgentEvent, isEnvironmentApplication | local-build.js | LocalBuild.swift | done (cloud run 40754986925, 73/73 tests) |
| X7 | build-history milestones (milestoneKey, collectBuildMilestones) | build-history.cjs | BuildHistory.swift | done (cloud run 40754986925, 73/73 tests) |
| X8 | Build card model: status words, colors, stepping, actions (Preview/Resume/Reject/Accept, Review/Remove, run rows, Stop all), error line, prompt row | DocEditor.jsx buildParts | BuildCard.swift | done (cloud run 40754986925, 73/73 tests) |

## Y. Views

| # | Behaviour | Source | Swift | Status |
|---|---|---|---|---|
| Y1 | BuildPanel: 420 wide, head "Build" + title + ×, Repository chip (glyph, name, tag, ⌄), Add from library, chips, note line (red for problems), Automatically clear workspace (off each time), model chip + blue send, ⌘↩ sends, Esc closes (not while busy) | BuildPanel.jsx | BuildPanelView.swift | partial: model picker is a SwiftUI Menu, not the Editor's BartPicker; no KindGlyph icons; placement above the Build button and covering post-its (usePlaced, data-cover, B29) is the host's; compiled, untested |
| Y2 | Panel lookups: search field, ↑/↓/Enter/Esc (clear then close), highlighted row's Make default | BuildPanel.jsx Lookup | BuildPanelView.swift | partial: search, arrows, Enter, Esc, Make default; no glyphs; compiled, untested |
| Y3 | Panel model start: last pick (build-models) ; pick remembered (rememberModelChoice 'build') | BuildPanel.jsx | BuildPanelModel.swift | done (compiled, untested; no test exercises it) |
| Y4 | BuildReview: Running first when something runs (aside), Changes tab, files with statuses/counts, patch colors, run step section apart/together, failed list, Reading…, truncated note | BuildReview.jsx | BuildReviewView.swift | done (compiled, untested; no test exercises it) |
| Y5 | BuildReject: "Reject this Build?", title, sentence, Cancel / Delete changes (Deleting…), Esc | BuildReject.jsx | BuildRejectView.swift | done (compiled, untested; no test exercises it) |
| Y6 | RunTimeline and BuildDetails (sandbox run inspector: tabs Build/Logs/Environment, Time to live, actions) | RunTimeline.jsx, BuildDetails.jsx, CSS | RunTimelineView.swift, BuildDetailsView.swift | done (compiled, untested; no test exercises it) |
| Y7 | Build card view for the editor's `build> <id>` lines | DocEditor.jsx | BuildCardView.swift | partial: agent messages render inline markdown only (no fenced-code styling); no wave animation on the live row; compiled, untested |
