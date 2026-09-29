# Repository runtime ownership and relocation

The 2026-09-28 fixes preserve project-default inheritance, explicit workspace
overrides, shared Context, independent terminal directories, and Hudson's Build
approval/checkpoint/review/Accept/Discard lifecycle. No repository migration or
source relocation is performed by these fixes.

## Confirmed problems and changes

1. **Preview ownership.** `stopTask()` used to stop both the task's review server
   and the repository's accepted server. Stop now targets the card's exact
   `serverId`, with a URL fallback for older in-memory records. A stale Stop
   request cannot stop a replacement server. Accepted servers are shared by
   canonical repository path, not by workspace connection or project ID.
   Replacement, explicit Stop, shutdown, and unexpected process exit update all
   referencing Build records and emit the existing Build events. This includes
   other projects, discarded cards restored to an accepted server, and failed
   replacement cards with a previous accepted URL. Stage updates or closes the
   associated tabs without opening tabs or focusing historical cards; routes
   within the same server keep their path/query/hash when its port changes.
   A tab navigated to a different site is untouched. Successful Accept still
   switches to accepted code, failed Git Accept retains review, failed server
   replacement retains the prior accepted server, and Discard restores accepted
   code. Processes are drained before removing their worktrees.

2. **Bart after relocation.** The session cache previously matched stable IDs
   and conversation text alone, while a resume prompt omitted location context.
   A saved session now also has a location fingerprint covering the project,
   workspace, working repository, Context paths, and read directories. Every
   follow-up builds current context before testing that fingerprint. A mismatch,
   including old persisted entries without a fingerprint, starts a fresh
   read-only CLI session with the document's earlier conversation turns. Matching
   sessions still resume normally. This works after restart and when a workspace
   moves but its inherited repository does not. Documents, archives, and durable
   question/repository provenance are not rewritten or discarded.

3. **Context repository paths.** Bart's Context projection now retains absolute
   `folderPath` and falls back to it for `path` when a library row has `path:null`.
   Unmentioned local repositories are included. External Context repositories
   receive read-directory grants; remote-only repositories keep their URLs and
   null local paths. These sources never change the captured working repository,
   the workspace override, or project default. Bart's restricted/read-only tools
   and explicit approval for code generation are unchanged.

4. **Move/rename guards.** Build activity is scoped to its captured project
   storage, workspace, repository, and worktree. Checks include pre-record starts,
   setup, queued turns, preview launches, Accept, Stop, and Discard cleanup. Leases
   likewise record paths/workspace dependencies instead of a project-wide count.
   Bart holds its captured code and Context paths until the answer/proposal
   finishes. Independent terminals are checked by their cwd, not the workspace
   displaying them. Physical repository dependencies cross project boundaries.
   A relocation fence rejects affected starts throughout the asynchronous idle
   check and reference updates. Unrelated workspace/terminal/Build activity no
   longer vetoes moves. Unfinished dependent Builds, Git linked worktrees, and
   macOS process-cwd checks remain protected before any files move.

## Regression checks (disposable data)

- `test/build.test.cjs`: real Git and HTTP processes; A accepted + B review Stop,
  stale server ID, shared replacement/Stop across projects, Stop racing Discard,
  discarded restoration,
  unexpected process exit, start/queue/cleanup/preview-launch dependency scopes,
  failed Accept, and worktree cleanup ordering.
- `test/repository-context.test.cjs`: absolute context-only repository paths and
  read grants; rename/move/project rename followed by a real-runner Bart follow-up
  with a scripted CLI (both in-memory and reloaded session caches); legacy cache
  entries; retained documents; Stage shared URL/route transitions; terminal and
  local-preview coordinator scopes.
- `test/workspace-repositories.test.cjs`: real filesystem moves with affected vs
  unrelated leases, independent terminal starts, shared-repository and
  Context-only dependencies, and starts attempted while relocation is in flight.
- `scripts/smoke-build-integration.cjs`: isolated Electron profile, actual IPC,
  native Stage views, real Git/servers, and scripted model output. Checks Stop
  isolation, shared card/tab synchronization, approval, replies, Accept/Discard,
  failed Accept/server fallback, archive, and post-it destination behavior.
- `scripts/smoke-workspace-repositories.cjs`: isolated Electron/PTYs; unrelated
  same-project sessions permit rename, affected sessions refuse it before files
  move, alongside repository selectors and path/reference updates.

No real account or subscription-backed agent is launched by these tests, and the
user's running app/profile is not restarted or migrated.

Validation on 2026-09-28: `npm run build` and `git diff --check` passed; both
Electron smoke scripts above passed. The complete Node suite ran **842 tests:
839 passed, 3 failed**. The three failures are the pre-existing frozen sandbox
benchmark fixtures in `test/sandbox-pipeline-benchmark.test.cjs`, which cannot
load `../store/captured-sites.cjs`; those snapshots were not changed. The focused
rerun (Bart, repository context, Builds, workspace/project-default repositories,
legacy Code workspaces, and local previews) passed **140/140** checks.
Ownership/guard, Start history, and the final
Stop/Discard cleanup-race checks also passed separately.

## Boundaries

- Bart's CLI memory is intentionally restarted after location changes; its saved
  conversation survives and is supplied again. Legacy cached sessions restart
  once because they have no location fingerprint.
- Unfinished Builds that depend on the moved workspace/repository must still be
  finished or discarded first. Terminals use their recorded launch cwd; macOS's
  existing `lsof` check also detects processes that have changed into the folder.
  Arbitrary external tools that only open files without a cwd inside the folder
  cannot all be identified by this guard.
- Headless Electron can return `UnknownVizError` when capturing an occluded
  native view. The smoke test retains window screenshots and verifies that view
  via live DOM/page interactions and URLs; an unavailable optional native-view
  screenshot does not skip those checks.
