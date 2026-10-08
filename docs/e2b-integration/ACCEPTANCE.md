# Acceptance and verification

Each row is an observable completion condition, not merely a suggestion to copy a test filename. Port/adapt the relevant reference tests and add tests for hardening. Use fresh fixture databases and mocked SDKs by default. Real sandbox tests must create and clean only their own resources. Do not run model calls or cloud provisioning as part of the ordinary unit suite.

## Required acceptance matrix

| ID | Scenario and expected result | Spec / reference evidence |
| --- | --- | --- |
| A01 | Add public GitHub URL: one library row persists, one setup starts, current UI selection remains | 01–03; sandbox-ipc |
| A02 | Reattach existing repo retries/reuses; repeated context save/reorder produces no extra start | 01–02; sandbox-ipc |
| A03 | Malformed/credentialed/non-GitHub/nested URLs and local files do not provision; canonical forms dedupe | 01; sandbox-manager, sandbox-runs |
| A04 | Setup handoff failure retains saved library/attachment and reports cause | 01; sandbox-ipc |
| A05 | Parallel Start/ensure calls yield one active DB row and one VM; unrelated repo work proceeds | 02,07,09,37; sandbox-manager |
| A06 | Stop/failure stays stopped during same-session refresh; next app session may automatically retry | 02; sandbox-manager |
| A07 | Healthy ready run reused; timeout/auth failure/unreachable state does not authorize duplicate VM | 10–11; sandbox-manager, sandbox-worker |
| A08 | Created VM ID persists before ack/clone; DB failure or missing ack causes cleanup | 12–13; sandbox-worker |
| A09 | Crash between create and persistence recovers by owned metadata, persists handle, cleans exactly its VM | 11,34; sandbox-manager, sandbox-worker |
| A10 | Recovery paginates and rejects ambiguous/unrelated matches; not-found cleanup is idempotent | 34; new hardening tests |
| A11 | Late duplicate/terminal events cannot resurrect failed/stopped/replaced/restarted generations | 09–10,33; sandbox-manager plus new restart race |
| A12 | Mode switch/quit/reset drains pending additions/workers/callbacks before DB close; cross-root events ignored | 07,11; sandbox-ipc, sandbox-manager |
| A13 | Stop during auth/create/clone/install/health/fallback/finalization cancels and never starts fallback/replacement | 10,18,24; sandbox-provider, sandbox-install |
| A14 | Cleanup failure retains handle and clear action; Retry first resolves it, never silently duplicates | 10–11,34; sandbox-manager, sandbox-provider |
| A15 | Automatic mode selects local subscription even when optional API key exists | 15; sandbox-provider |
| A16 | Missing/outdated/signed-out CLI selects allowed fallback before VM create; no-key strict mode fails pre-create | 15–16; sandbox-provider, sandbox-local |
| A17 | Explicit api skips subscription; strict claude-local never invokes API | 15; sandbox-provider |
| A18 | Local failure permits exactly one same-VM API handoff after tool/app drain, recipe reset and env restore | 18; sandbox-provider |
| A19 | Failed cleanup, Stop or post-ready app error cannot trigger API fallback; API failure terminates | 18; sandbox-provider |
| A20 | CLI has no built-in host tools/hooks/inherited provider keys; subscription credentials never enter VM | 07,16; sandbox-local |
| A21 | MCP adapter connects over stdio; wrong token/Host/Origin/method/args are rejected; no VM selector | 17; sandbox-local |
| A22 | File tool path escape, symlink escape, unknown properties, type confusion and unsafe preview routes rejected | 17; sandbox-local plus new symlink tests |
| A23 | Tool requests/results, stdout/stderr, unterminated JSON and queue growth stay bounded; orderly cancellation works | 13,17,35; sandbox-worker/local plus new stream stress |
| A24 | Compatible single-lockfile Node repo starts frozen install before agent; managers/runtime pins honored | 20; sandbox-install |
| A25 | Ambiguous workspaces/custom scripts/configuration/missing runtimes defer with cause, never guess/delete lockfiles | 20; sandbox-install |
| A26 | Read/list planning proceeds during install; mutations/duplicate installs cannot race it | 21; sandbox-install, sandbox-local |
| A27 | Failed/timed-out/stopped/unconfirmed install never unlocks launch; confirmed replacement owns one job | 21; sandbox-install |
| A28 | Independent npm+pip pair runs concurrently, uses new .venv, succeeds only if both children succeed | 21; sandbox-install + Python install checks |
| A29 | Shared/overlapping/linked/custom/unsupported parallel roots rejected with specific reason | 21; sandbox-install |
| A30 | Bounded Railpack discovery finishes before prompt; failure/truncation falls back; no plan execution or secret payload | 22; sandbox-discovery |
| A31 | Read reply can report install completion; prepared start waits then launches without another agent turn | 23; sandbox-install |
| A32 | Expired/cancelled install wait leaves no delayed launch even if installation later succeeds | 23; sandbox-install |
| A33 | Ready arrives before slow/failing final summary, once only; post-ready/queued mutations rejected | 24; sandbox-local, sandbox-provider |
| A34 | Required app exit interrupts summary and changes lifecycle; summary failure alone leaves preview up | 24,26; sandbox-provider |
| A35 | Owned process/PID-start-time records, orphan descendants and actual IPv4/IPv6 listeners are reported | 26; sandbox-launch + sandbox_app_check.py |
| A36 | Unknown port owner never killed; replacement waits for confirmed stop; stale attempt cannot start | 26; sandbox-launch |
| A37 | App-local health and expected assigned-host HTTPS route verified; wrong host/5xx/false 404/redirect rejected | 14; sandbox-worker/local plus new health tests |
| A38 | Required frontend/backend both live; required child failure is propagated; credentials-dependent behavior is not claimed from HTML | 14,26; multi-service fixture |
| A39 | Environment save is encrypted, renderer reads names only, unavailable keychain fails without plaintext fallback | 06,29; sandbox-environment |
| A40 | Add/update/remove/empty/whitespace values, bounds, reserved names and conflicting revisions behave correctly | 29; sandbox-environment + concurrent save |
| A41 | Structured/escaped/split secrets absent from output, DB/logs/prompts/IPC; short values do not corrupt protocol IDs | 30; sandbox-environment/local + stream redaction |
| A42 | Detected variable names survive 300-event eviction/reopen/new failed scan; untouched fields not saved as empty | 06,09,29; environment-report, sandbox-environment |
| A43 | Restart validates recipe before interrupting; same run/VM IDs and installed sentinel survive | 27; sandbox-worker and live environment smoke |
| A44 | Restart makes zero clone/install/setup/repair calls; new env applied to local/native/shell paths and every component | 27,29; sandbox-launch, sandbox-environment smoke |
| A45 | Removed override never resurrects from merge cache; user-app credentials separated from setup credentials | 29; sandbox-launch, environment smoke |
| A46 | Failed restart retains VM/files for correction; Stop releases it; Retry creates distinct attempt | 10,27; sandbox-worker/manager |
| A47 | Log tail 300, agent activity 200, lifecycle first/latest survives eviction; tied timestamps keep order | 09; sandbox-runs, run-timeline |
| A48 | Legacy DB migration twice preserves library/workspaces/old attempts and backfills only available evidence | 09; sandbox-runs, sandbox-environment |
| A49 | Bell matches progress/completion/failure, no auto-navigation, explicit Open live and separate GitHub action | 03–05; sandbox-notifications + UI smoke |
| A50 | Read/clear persisted per mode; dismissed progress quiet but completion alerts; stale/duplicate/stopped rows excluded | 04; sandbox-notifications |
| A51 | Inspector tabs/actions/focus/Escape/keyboard/native-overlay work; time-to-live handles overlap/restart correctly | 05; run-timeline, build-steps + UI smoke |
| A52 | Audit runs only after initial ready; unavailable/findings do not fail app or change dependencies | 25; sandbox-audit |
| A53 | Cache seeds contain pinned public manifests only; actual installs retain scripts and package parity; rollback works | 25; sandbox-cache |
| A54 | Docker query unavailable/truncated is not false confidence; compatible template/daemon checked or clear blocker | 12,36; new capability tests |
| A55 | Packaged app includes/reads worker, MCP and Python helpers; packaged worker starts and reports validated events | 32; isolated packaged smoke |
| A56 | Existing Hudson Build context, worktree isolation, reply/Stop/Resume, checkpoint, Review, Accept, Discard and post-it flows pass | 01,08; target build/build-git/post-it tests |
| A57 | Existing library, Stage browser, tools/onboarding, test-mode switching and application data preserved | 08; target regressions |
| A58 | Fresh local-provider E2B smoke persists verified ready URL and independent expected HTTP result, then confirms owned VM cleanup | 12–26; smoke-sandbox |
| A59 | Fresh API-provider smoke exercises API runner/proxy, persists verified ready and cleanup; fallback exercised separately | 18–19; smoke-sandbox plus provider tests |
| A60 | Report distinguishes historical/source tests, new mock/helper tests, actual live/provider/package evidence and blocked checks | 36; implementation delivery |

## Reference test inventory

Core `test/sandbox-{runs,manager,worker,ipc,environment,local,provider,install,discovery,launch,audit,notifications,cache}.test.cjs`, `test/environment-report.test.cjs`, `test/run-timeline.test.cjs`, `test/build-events.test.cjs`, `test/build-steps.test.cjs`, and corresponding Python `sandbox_*_check.py` files establish the source's intended contracts. Inspect their assertions before porting; source-shape-only UI assertions need behavior-level coverage in the destination.

The runtime ownership helpers use Linux process metadata. Run their relevant checks in a compatible isolated Linux environment; do not weaken production checks so a macOS-only test happens to pass. Unit tests should dependency-inject SDK operations, process spawn, clock/deadlines and probe responses. Include real subprocess tests for JSON framing/stdio bridge and deterministic temporary Git/PGlite fixtures for target integration.

Do not copy frozen `docs/benchmarks/**/implementations` folders or run billed benchmark scripts in the default test suite. The reference history reports missing-module failures in frozen benchmark fixtures, which are not evidence of a runtime regression in this port. Preserve meaningful performance regression checks for overlap, readiness ordering, bounded discovery and package parity.

## Execution guidance for the implementation

After dependencies and tests are ported, run the project's full test/build commands plus focused failing tests as needed. Typical commands are:

```sh
npm ci
node --test test/sandbox-runs.test.cjs test/sandbox-manager.test.cjs test/sandbox-worker.test.cjs test/sandbox-ipc.test.cjs test/sandbox-environment.test.cjs test/sandbox-local.test.cjs test/sandbox-provider.test.cjs test/sandbox-install.test.cjs test/sandbox-discovery.test.cjs test/sandbox-launch.test.cjs test/sandbox-audit.test.cjs test/sandbox-notifications.test.cjs test/sandbox-cache.test.cjs
npm test
npm run build
git diff --check
```

These are commands for the future implementation, not a claim that those files exist on Hudson's current branch or were run while authoring this spec. If the target changes filenames, record the mapping. Missing dependencies/network require an explicit blocked verification result, not a fabricated pass. Use project-appropriate Electron smoke tooling with an isolated profile/data root for IPC/UI/package checks.

For live tests, ensure private credentials/templates and ordinary CLI sign-in are configured through the normal runtime outside the spec. Do not print environment secrets or copy them into a Build prompt. The source smoke commands are:

```sh
# Local subscription only, deliberately no API fallback:
ENGELBART_SANDBOX_SETUP=claude-local ANTHROPIC_API_KEY= node scripts/smoke-sandbox.cjs https://github.com/render-examples/express-hello-world
# Separate API path; requires its private key:
ENGELBART_SANDBOX_SETUP=api node scripts/smoke-sandbox.cjs https://github.com/render-examples/express-hello-world
# Saved recipe, same-VM environment restart; --local does not need model calls:
node scripts/smoke-sandbox-environment.cjs --local
node scripts/smoke-sandbox-environment.cjs
```

Live tests use E2B time and, for setup, the configured provider's subscription/API usage. They must retain cleanup evidence even when the app/probe fails and use only their own disposable DB/VM. Where a fixed public repo HEAD is used, record the resolved commit; for comparable benchmarks pin it. A single smoke latency is not a performance guarantee.

Include a simple Node app, independent frontend+Python backend, a workspace/monorepo needing agent inspection, an intentionally missing startup secret, a port conflict, and failed cleanup in the combined fixture matrix. Docker-backed live verification is required before claiming Docker/Supabase application compatibility; the existence of Docker binaries or a past hello-world container is insufficient.

## Completion report format

Record target/source hashes, changed modules, any explicit behavior deviations, test commands/exit codes, acceptance IDs with pass/fail/blocked status, provider/template and resolved repository commit for each live run, local/public health evidence, environment revision/restart identity evidence, packaged resource checks, and cleanup confirmation. Never include secret values. If blocked, provide the exact remaining operator step and its expected result. Workspace Build success means a reviewable implementation and honest verification report; production deployment and cloud-template publishing are not implied.
