# Engelbart Agentic Pipelines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This document proposes future implementation; writing it did not authorize starting agents or changing product code in the planning session.

**Goal:** Make delegation from a thinking workspace fast, inspectable, recoverable, and easy to integrate, for both research and bounded code changes.

**Architecture:** An Electron main-process runtime persists task revisions, source snapshots, attempts, events, and returns in a local PGlite store. Provider adapters run independent Claude/Codex sessions; a deterministic scheduler and policy layer control lifecycle and bounded handoffs. The editor remains the place where the user thinks, dispatches, and integrates work.

**Tech Stack:** Existing Electron 44.4.1, React 19.3.0, Node >=22.12.0, CommonJS main modules, PGlite 0.5.8, `node:test`, Git worktrees; Claude Code 2.1.278 and Codex CLI 0.155.0 observed locally. Installed versions are a tested baseline to establish, not guaranteed compatibility floors.

**Spec:** [Proposed design](../specs/2026-09-18-agentic-pipelines-design.md). Read it first. The implementation order assumes research first and coding immediately afterwards; the first three PRs should produce a usable complete loop.

## Global Constraints

- Target `engelbart-canvas`; retain Electron, React, CommonJS main-process modules, and the existing PGlite dependency.
- Keep freeform documents and nested workspaces. A workspace tree expresses containment; a task dependency graph expresses execution order.
- Only explicit dispatch or an enabled automation policy starts work. A checkbox, note, mention, or discovered issue alone is not authorization.
- Every run uses an immutable task revision and context manifest. Reframing creates a new revision; past results retain their original meaning.
- Task identity, provider-session identity, and execution-attempt identity are separate. Never resume “the most recent” session.
- The runtime owns lifecycle state and authorization. Model prose and secretary approval cannot independently grant permissions or mark work integrated.
- Agent results are durable artifacts. Integration into a document or code branch is a separate, recorded action.
- Each code task gets its own Git worktree and feature branch. Integration is serialized per repository; feature code never goes directly to main.
- One active orchestrator action per project, plus exclusive locks for resources shared across projects.
- Unknown side-effect outcomes remain unknown until reconciled. Never repeat an uncertain action merely because a timer or lease expired.
- Test and normal data roots are isolated. No real user notes, credentials, or transcripts enter fixtures or Git.
- V1 survives renderer reload and supports recovery after application restart. It does not promise execution while the application is fully quit or the machine sleeps.

## Delivery map

| PR | Independently reviewable result | Depends on |
| --- | --- | --- |
| 1. Task records and context | A captured request reopens with the exact brief, source versions, and event history | Existing stores |
| 2. One real worker | A real research attempt produces a durable return and can fail/cancel honestly | 1 |
| 3. Dispatch and return in the editor | Select, dispatch, continue writing, inspect, redirect, and integrate | 2 |
| 4. Concurrent code tasks | Two isolated changes can be reviewed and integrated without touching the active checkout | 3 |
| 5. Bounded handoffs | A blocked worker gets an action result through the authored secretary/queue protocol | 2–4 |
| 6. Codex adapter | The same lifecycle and return contract works with Codex | 2, 3; 5 for handoff parity |
| 7. Adaptive planning | Human and agent steps can be changed without corrupting running work | 3, 4 |
| 8. Scout and evaluation | Task suggestions and measured attention costs; autonomous execution remains policy-controlled | 3–7 |

Ship PRs 1–3 as the first product experiment. A working single-agent loop is the gate for proceeding to concurrency. A useful explicit-delegation loop is the gate for autonomous discovery. No calendar estimate is attached: transport/permission compatibility is still unprobed.

## Files and interfaces

Add the following modules only in the PR that needs them. Do not generate an empty framework upfront.

| Module | Responsibility |
| --- | --- |
| `src/main/agents/contracts.cjs` | Versioned input/result validation and normalized event shapes |
| `src/main/agents/store.cjs` | One runtime PGlite connection, migrations, transactions, immutable revisions and artifacts |
| `src/main/agents/context.cjs` | Resolve source IDs, materialize snapshots, hash/order a context manifest |
| `src/main/agents/runtime.cjs` | Queue, claims, attempt lifecycle, event ingestion, cancellation, restart reconciliation |
| `src/main/agents/providers/claude.cjs` | Claude process transport and event normalization |
| `src/main/agents/providers/codex.cjs` | Versioned App Server transport and event normalization |
| `src/main/agents/ipc.cjs` | Trusted renderer endpoints and replay subscriptions |
| `src/main/agents/integration.cjs` | Result review, document version checks and integration journal |
| `src/main/agents/worktrees.cjs` | Code base identity, isolated branches, test resources and integration queue |
| `src/main/agents/policy.cjs` | Capability/authorization checks independent of model judgments |
| `src/main/agents/handoffs.cjs` | Review decisions, FIFO dispatch, resource claims and durable result delivery |
| `src/main/agents/mcp-bridge.cjs` | Run-authenticated access to harness tools from agent backends |
| `src/main/agents/planning.cjs` | Versioned dependencies, cycle rejection and downstream staleness |
| `src/main/agents/discovery.cjs` | Scoped proposals, deduplication, dismissals and automation policy |
| `src/renderer/agents/{DispatchAction,ActivityStrip,TaskReturn}.jsx` | Capture, peripheral status, evidence and review actions |
| `src/renderer/model/anchors.cjs` | Pure source-anchor relocation and ambiguity detection |

Public runtime interfaces below are proposed application APIs, not claims about existing code or provider APIs. Store/UI/tests use these names consistently.

```js
// contracts.cjs — JSON-serializable boundaries; validate all incoming values.
// DocRef = {kind:'workspace', workspaceId} | {kind:'note', id}
// TaskKind = 'research' | 'change' | 'plan'
// Anchor = {docRef, baseHash, exact, prefix, suffix, start, end}; null for unanchored capture.
// Manifest = {id, hash, sources, omissions, instructionsVersion, codeBaseSha}
// Source = {id, contentHash, artifactPath, locator, includedBecause}
// TaskRevision = {taskId, revision, projectId, workspaceId, kind, anchor,
//   request, outcome, checks, exclusions, manifestId, authorizationId,
//   maxDurationMs, maxTurns, dependsOn}
// Result = {resultId, runId, taskId, revision, summary, evidence,
//   unresolved, implications, artifacts, changedPaths, checks}
// Evidence = {sourceId, locator, claim, support:'supports'|'contradicts'|'uncertain'}
// Check = {name, status:'pass'|'fail'|'not_run', evidenceRef}

// runtime.cjs
createRuntime({store, providers, clock, policy}) // -> Runtime
// Runtime methods (all Promise-returning except subscribe):
// dispatch(taskRevision, clientRequestId) -> {taskId, runId}
// list({projectId, workspaceId}) -> Attempt[]
// cancel(runId) -> {state}
// redirect(runId, {request, manifestId}) -> {taskId, revision, runId}
// reconcile() -> RecoveryRecord[]
// subscribe({afterSequence}, listener) -> unsubscribe

// provider adapter: start({run, task, manifest, cwd, capabilityProfile}, emit)
// -> Promise<RunHandle>; RunHandle = {sessionId, stop(), resume(checkpoint)}
// emit({eventId, runId, type, payload})
// Types: session.started, activity, tool.requested, tool.completed,
// input.required, usage.reported, output.returned, transport.closed.
// Provider-specific evidence stays in payload.rawRef; UI uses normalized events.

// integration.cjs
// reviewResult({resultId, decision, feedback}) -> ReviewRecord
// prepareDocIntegration({resultId, docRef, expectedHash, selectedText})
//   -> {operationId, expectedHash, proposedText}
// applyDocIntegration({operationId, currentBufferHash}) -> IntegrationRecord
```

Unknown/malformed events are retained as diagnostic records and cannot advance lifecycle state. Artifacts and file evidence are resolved within the run's authorized roots. The runtime assigns IDs and derives actual project/run identity; model-provided fields cannot impersonate another task.

## PR 1 — Durable requests and source snapshots

**Create:** `contracts.cjs`, `store.cjs`, `context.cjs`, `test/agent-store.test.cjs`, `test/agent-context.test.cjs`. **Modify:** `src/main/store/projects.cjs` to expose a supported project/workspace lookup returning UUID-linked records, and awaitable/version-aware document writes; `src/renderer/screens/Workspace.jsx` so `flush` returns its save promise and reports failures.

**Consumes:** existing `createStore().context()`, project/workspace UUIDs, library IDs, `readDoc`. **Produces:** `openAgentStore(dataRoot)`, `captureContext({ctx, taskInput, editorSnapshot})`, and `writeDocIfHash(ctx, projectId, docRef, expectedHash, text)`. The store exposes `putManifest(manifest)`, `createTask(taskRevision)`, `getTask(taskId, revision)`, `createAttempt({taskId, revision, provider})`, `appendEvent(runId, event)`, `eventsAfter(sequence)`, and `close()`. `putManifest` verifies the referenced artifact hashes and computes the canonical manifest hash; a manifest with no sources is valid for an unanchored question.

- [ ] Add numbered runtime migrations creating `tasks`, `task_revisions`, `attempts`, `events`, `results`, and `integrations`. Use unique `(task_id, revision)`, `(run_id, event_id)` and dispatch idempotency keys. `events.sequence` is database-assigned. Include a partial unique constraint allowing only one nonterminal attempt to own a provider session.
- [ ] Write persistence tests before the store. A store factory accepts a scratch data root. `createTask(taskRevision)` inserts an immutable revision; `appendEvent(runId, event)` deduplicates by event ID; `eventsAfter(sequence)` returns ordered rows. Invalid references, oversized bodies and updates to prior revisions fail explicitly. Store tests use synthetic project/workspace IDs; runtime tests additionally resolve those IDs against actual scratch project fixtures.

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openAgentStore } = require('../src/main/agents/store.cjs');

test('events survive reopen and duplicate delivery has one effect', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eb-agent-'));
  let store = await openAgentStore(root);
  try {
    const taskId = randomUUID();
    const manifest = await store.putManifest({id: randomUUID(), sources: [],
      omissions: [], instructionsVersion: 'fixture-1', codeBaseSha: null});
    await store.createTask({taskId, revision: 1, projectId: randomUUID(),
      workspaceId: randomUUID(), kind: 'research', anchor: null,
      request: 'Find counterevidence', outcome: 'Return supported counterclaims',
      checks: [], exclusions: ['Do not edit project files'],
      manifestId: manifest.id, authorizationId: 'fixture-authorization',
      maxDurationMs: 60000, maxTurns: 2, dependsOn: []});
    const run = await store.createAttempt({taskId, revision: 1, provider: 'fixture'});
    const event = {eventId: 'e1', type: 'activity', payload: {text: 'Reading'}};
    await store.appendEvent(run.runId, event);
    await store.appendEvent(run.runId, event);
    await store.close();
    store = await openAgentStore(root);
    const rows = await store.eventsAfter(0);
    assert.equal(rows.filter(x => x.eventId === 'e1').length, 1);
    assert.equal((await store.getTask(taskId, 1)).request, 'Find counterevidence');
  } finally {
    await store.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});
```

- [ ] Run `node --test test/agent-store.test.cjs test/agent-context.test.cjs`; first failures must concern absent behavior, not a broken fixture. Implement store transactions and hash-addressed artifact writes. Use PGlite's existing dependency, not a second database engine.
- [ ] Implement context capture with selected text, live editor version, explicit source IDs and instruction versions. Persist omitted sources. Block ambiguous duplicate names; never assume a URL's content was read. Snapshot text before any asynchronous extraction; resolve ancestors by UUID, not name/path alone.
- [ ] Test dispatch within the 400 ms save window, source edits during capture, workspace rename, duplicate source names, missing paths, deterministic manifest ordering, and test/normal root isolation. `writeDocIfHash` must return a conflict rather than overwrite a different version. All in-app saves share a per-document write queue.
- [ ] Commit as `feat(agents): persist task revisions and context snapshots` on a feature branch. Acceptance: reopening the scratch store reproduces exactly what the worker would have received.

## PR 2 — One real research worker and honest recovery

**Create:** `runtime.cjs`, `providers/claude.cjs`, `policy.cjs`, `test/{agent-runtime,claude-runner}.test.cjs`, `test/fixtures/agents/`, `scripts/probe-agent-runtime.cjs`. **Modify:** `src/main/index.cjs` for runtime startup/shutdown; `src/main/ipc.cjs` for mode/reset guards.

**Consumes:** PR 1 store/context. **Produces:** Runtime/provider interfaces above, plus `capabilities()` reporting supported tools, interruption, resume, usage and approval behavior from observed backend configuration.

- [ ] Probe a real, tightly scoped research task in a temporary home/run directory. Record executable/version, stream events, session identity, structured output, cancellation, resume, permission denial and available usage fields. Pin sanitized fixtures to that version. Do not put credentials, private prompts or raw user transcripts in Git. Use Node subprocess arguments and stdin, never shell-interpolated prompts.

```js
// Transport shape to verify with the installed CLI; the prompt is written to stdin.
const { spawn } = require('node:child_process');
const child = spawn(claudeExecutable, [
  '-p', '--output-format', 'stream-json', '--verbose',
  '--json-schema', JSON.stringify(resultSchema),
  '--tools', 'Read,Glob,Grep,WebSearch,WebFetch',
  '--allowedTools', 'Read,Glob,Grep,WebSearch,WebFetch',
  '--permission-prompts', 'none',
], {cwd: runDirectory, env: effectiveEnvironment, shell: false});
child.stdin.end(compiledPrompt);
```

`claudeExecutable`, `resultSchema`, `runDirectory`, `effectiveEnvironment` and `compiledPrompt` come from the adapter's validated start arguments, contract validator, run allocation, resolved provider environment and captured manifest respectively. This invocation is for the research profile, not the later code profile. Inspect effective hooks/MCP/config sources during the probe and include them in capability metadata; loading user configuration must not silently broaden the declared profile. Unsupported enforcement blocks that profile until corrected.

- [ ] Test the stream decoder with split JSON lines, repeated IDs, malformed JSON, partial output then exit, and final output without a valid result. `output.returned` plus validated artifact persistence is required for `succeeded`; exit code zero alone is insufficient. For a malformed final result, retain the raw output with a format error and offer repair as an explicit follow-up attempt.
- [ ] Implement a single-worker scheduler: transactionally record `starting`, launch, persist session/process identity, consume events, persist return, then complete. Use `try/finally` for ordinary cleanup but keep unresolved side-effect claims in `outcome_unknown`. Enforce wall-clock and turn budgets; expose missing cost reporting honestly.
- [ ] Add cancellation and explicit-session continuation. After stop, confirm termination before another turn resumes that session. A correction creates revision + attempt records and preserves the old return. V1 may stop/resume for steering; do not advertise unsupported live steering.
- [ ] Inject a crash at each boundary: claim before spawn, spawn before session acknowledgement, final result before completion, completion before renderer delivery. Recovery must not blindly relaunch an unacknowledged process. In the unconfirmed case return `outcome_unknown` and reconcile the run token/process/session first.
- [ ] Guard test-mode switching/reset and project directory changes while a run owns affected resources. Bind every attempt to its original data root. On normal quit stop/record runs before database close; renderer/window hiding does not stop runs.
- [ ] Run `node --test test/agent-runtime.test.cjs test/claude-runner.test.cjs`, then `node scripts/probe-agent-runtime.cjs --provider claude --scenario research-return`. Commit `feat(agents): run and recover a Claude research task` only after the real probe record is inspectable.

## PR 3 — The complete workspace loop

**Create:** `agents/ipc.cjs`, `agents/integration.cjs`, `renderer/agents/{DispatchAction,ActivityStrip,TaskReturn}.jsx`, `renderer/model/anchors.cjs`, `test/{agent-ipc,agent-anchors,agent-integration}.test.cjs`, `scripts/probe-agent-ui.mjs`. **Modify:** `src/preload.cjs`, `src/main/index.cjs`, `Workspace.jsx`, `DocEditor.jsx`, and relevant styles.

**Consumes:** task/context/Runtime contracts. **Produces:** UI dispatch, replay, redirect, cancel, review and integration. Preload methods: `dispatchTask`, `listAgentRuns`, `cancelAgentRun`, `redirectAgentRun`, `reviewAgentResult`, `prepareDocIntegration`, `applyDocIntegration`, `onAgentEvent`. All mutations pass the trusted-frame check and validate project/run association in main.

- [ ] Add pure anchor tests and implement `makeAnchor(text, start, end)` and `relocateAnchor(anchor, currentText)`. Return `{state:'attached',start,end}`, `{state:'missing'}` or `{state:'ambiguous'}`; never silently choose among equivalent duplicate passages.

```js
const { makeAnchor, relocateAnchor } = require('../src/renderer/model/anchors.cjs');
const a = makeAnchor('Why?\nFind evidence.\nNext.', 5, 19);
assert.deepEqual(relocateAnchor(a, 'Heading\nWhy?\nFind evidence.\nNext.'),
  {state: 'attached', start: 13, end: 27});
assert.equal(relocateAnchor(a, 'A different question.').state, 'missing');
```

- [ ] Add select-text → dispatch with one editable request line and a collapsible context preview. Preserve selection/caret and keep the editor active after dispatch. Create a child workspace only when requested; a task can belong to its parent workspace without creating a new folder.
- [ ] Connect explicit task actions and `@chat` to the runtime. Remove timed success for real runs. Ordinary checkboxes stay author-controlled. Streaming output lives outside the mutable document until inserted/reviewed; no unattended whole-document replacement.
- [ ] Render one activity strip with working/needs-input/ready states and per-task returns. A return shows the original request, concise findings, evidence, unresolved issues and implications. Actions: inspect sources, keep as note, insert selected text, redirect, reject. Completion changes a badge and never steals focus.
- [ ] Implement review and a document integration journal. Before applying, compare the active buffer and persisted document versions against the prepared proposal. Serialize save/agent operations, preserve a preimage, and record the postimage hash. A changed target returns `ContextChanged`; missing anchors offer a separate result note. Reapplying an operation ID returns the existing integration. On restart reconcile an interrupted write by its before/after hashes; any third state requires manual placement.
- [ ] Verify renderer reattach replays events after sequence N without duplicate cards. Closing a child workspace or renaming its parent does not orphan the return. Unauthorized frames cannot dispatch, approve, or read another project's runs.
- [ ] Run the three new test files and `npm test`; then `npm run build`. In an isolated Electron home, use the existing `scripts/drive.mjs` pattern for a real run: select → dispatch → keep typing → return → redirect → reload → integrate. Save screenshots, event IDs and source/target hashes to `docs/verification/agent-runtime.md`.
- [ ] Commit `feat(workspace): dispatch and integrate agent returns`. Dogfood this slice before increasing concurrency. The end-user must be able to explain which parent assumption the return changes without opening the full transcript.

## PR 4 — Concurrent small changes and one integration lane

**Create:** `worktrees.cjs`, `test/{agent-worktrees,agent-scheduler}.test.cjs`. **Modify:** `runtime.cjs`, `policy.cjs`, `integration.cjs`, `TaskReturn.jsx`.

**Consumes:** Task kind `change`, task revision checks/exclusions and project code directory. **Produces:** `prepareWorktree({repo, baseSha, taskId, runId})`, `prepareCodeIntegration({resultId, targetRef, expectedHead})`, and a tested integration proposal.

- [ ] Add two-worker scheduling, a unique atomic claim per run, and fairness across projects. Start with two worker slots total. Dependencies block launch, not capture. Cancelling a queued task removes eligibility; cancelling running work waits for stop. A waiting control action has independent capacity.
- [ ] Use a Git worktree/branch per task with a persisted base SHA and task-specific scratch home/ports. Proposed branch convention: `agent/<taskId>`. Read-only research needs no code worktree. Missing repositories block only change tasks. Dirty source changes are excluded and reported; never auto-stash or mutate the active checkout.
- [ ] Add a code capability profile using supported native execution controls. Worktree location alone is not a permission boundary. Record actual paths changed, policy denials and test artifacts. Changes outside the declared module scope return for review. Expand the contract before proceeding with a larger feature.
- [ ] Exercise the real quick-fix example: “preserve `##` when copying markdown.” The task must state expected clipboard contents for a heading plus paragraph and preserve normal editing. Return an inspectable diff and executable regression evidence; no mandatory extra planner pass for an already clear task.
- [ ] Serialize preparation/landing per Git common directory, even when two Engelbart projects point at the same repo. Test against a combined integration branch. Before updating the target feature ref, compare its SHA. A changed ref means revalidate; a conflict returns to the owner. Preserve an explicit pre-integration SHA for undo; do not delete a task worktree while it owns a live run.

| Test scenario | Required result |
| --- | --- |
| Two changes touch the same file | Independent worktrees; conflicting integration reported, no overwrite |
| Both changes pass alone but fail together | Combined checks fail; target ref stays unchanged |
| Two schedulers claim one run | One launch |
| Target branch advances during validation | No stale landing |
| Active user's checkout is dirty | No stash/commit/reset and no agent writes there |
| Two projects share the same repository | One integration owner across both |

- [ ] Run `node --test test/agent-worktrees.test.cjs test/agent-scheduler.test.cjs` and the relevant editor tests. Capture one real two-task run. Commit `feat(agents): isolate code tasks and serialize integration`.

## PR 5 — The secretary and orchestrator handoff

**Create:** `handoffs.cjs`, `mcp-bridge.cjs`, `test/{agent-handoffs,agent-policy,agent-delivery}.test.cjs`. **Modify:** `store.cjs`, `runtime.cjs`, provider configuration, `ActivityStrip.jsx`, `TaskReturn.jsx`.

**Consumes:** the authored handoff protocol and Runtime run identities. **Produces:** harness tools `request_orchestrator_action`, `submit_handoff_decision`, `complete_orchestrator_action`, plus explicit result acknowledgement. Roles receive only their corresponding tools. Use the official MCP SDK for the bridge, with the resolved version pinned and its transport tested in this PR; do not implement MCP framing by intuition.

```js
// Handoff service API. requestId/toolCallId are assigned or bound by the harness.
requestAction({runId, toolCallId, idempotencyKey, action, context, expectedResult})
  // -> Promise<{requestId, status, result}>
submitDecision({requestId, decision, reason, questions, authorizationVersion})
  // decision: approve | request_clarification | reject | require_user_approval
dispatchNext({projectId}) // -> Promise<{requestId, executionId} | null>
completeAction({requestId, executionId, status, evidence, changedPaths, blocker})
  // status: completed | failed | blocked; blocked maps to failed + blocker.
acknowledgeResult({requestId, runId, deliveryId})
```

- [ ] Persist handoffs, action attempts, resource claims, decisions and an outbox in numbered migrations. Authenticate bridge traffic with a per-run capability token; derive run/project identity from it, not arbitrary arguments. Bind approval to canonical action arguments and policy/task revision. Deny expired/revoked authority and cross-run impersonation.
- [ ] Implement all ten protocol states from the spec. The secretary makes a structured recommendation, has no execution authority, and is invoked only for handoff requests. Existing authorization is reused. Unsupported actions return a reason; they do not cause repeated requests to the user.
- [ ] Claim the oldest eligible request and all its project/global resources in one transaction. Do not hold a database transaction across a model/tool call. Waiting clarification/approval does not block unrelated eligible work. Return a no-op success with evidence if the intended outcome is already satisfied.
- [ ] Persist completion and an outbox delivery together. Delivery is at-least-once with idempotent consumption. If a pending tool call survives, resolve it; if the provider process is gone, reconcile it, then continue the exact session with the recorded request/result. Never claim a disconnected in-memory promise survived a restart.
- [ ] Cancellation waits for confirmed stop; record partial effects. A lost connection after an action creates `outcome_unknown` and retains its resources until reconciliation. Do not let timeout, process age, or lease expiry turn unknown into permission to repeat.
- [ ] Test simultaneous requests, duplicate submission, source cancellation, clarification, denied/revoked approval, shared desktop lock across projects, stale inputs, existing satisfaction, result-before-disconnect, and crash after effect/before acknowledgement. In that final test the external effect counter must remain one after restart. Also test that two waiting workers do not starve the control lane.
- [ ] Run the three new test files, then a real worker → secretary → bounded local action → resumed worker probe in a scratch project. Commit `feat(agents): broker bounded handoffs with durable delivery`.

## PR 6 — Codex parity and measured context costs

**Create:** `providers/codex.cjs`, `test/codex-runner.test.cjs`, sanitized versioned protocol fixtures. **Modify:** runtime provider registry, `DispatchAction.jsx`, probe script and verification record.

**Consumes/produces:** the same provider/event contract. Backend differences are explicit capability flags, not fabricated parity.

- [ ] Generate protocol schemas from `codex app-server generate-json-schema` into a temporary probe folder. Record the CLI version and commit only the specific sanitized fixtures needed for tests. Use documented initialization, thread/turn lifecycle, approvals, interruption and session continuation; use the same MCP bridge for harness tools rather than relying on experimental dynamic tools.
- [ ] Probe start, result, approval denial, question handling, interrupt, reconnect and correct-session resume. Verify the order of completion/transport events. Normalize only features actually observed. An unsupported live feature stays disabled in the UI.
- [ ] Repeat the shared contract tests and one real workspace round trip. Store provider/model/context version and reported usage with every run. Benchmark identical task suites with stable versus changed context material; report cold/warm preparation, first-useful-event latency, cached input if exposed and total cost if exposed. Cache reuse is an observation, not a release promise.
- [ ] Run `node --test test/codex-runner.test.cjs test/agent-runtime.test.cjs` and `node scripts/probe-agent-runtime.cjs --provider codex --scenario research-return`. Commit `feat(agents): add Codex runtime parity`.

## PR 7 — Plans that can change while work continues

**Create:** `planning.cjs`, `test/agent-planning.test.cjs`. **Modify:** store migrations, runtime eligibility and return UI.

**Consumes:** immutable task revisions and results. **Produces:** `revisePlan({planId, expectedVersion, tasks, dependencies})`, `readyTasks(planId)`, `markStaleFrom(taskId, revision)`.

- [ ] Represent explicit dependency edges separately from workspace nesting. Validate endpoints and reject cycles before committing a revision. A human-owned step is never silently assigned to an agent.
- [ ] Support split, assign, pause, reframe and replace input. Existing runs continue against their recorded revision unless explicitly cancelled. Their returns are labeled as based on the old question; unstarted dependent tasks become stale and require reauthorization/revision before dispatch.
- [ ] A planner may propose changes, not rewrite the authoritative task graph covertly. Present the change and its consequences: which runs continue, which inputs are outdated, which human decision remains.
- [ ] Test a changed research conclusion invalidating a later spec task; a human prerequisite not completed; a dependency cycle; an agent result arriving after a reframe; and moving a workspace without changing execution dependencies. Run `node --test test/agent-planning.test.cjs` and the scheduler suite. Commit `feat(planning): revise task graphs during execution`.

## PR 8 — Scoped discovery and an attention-cost experiment

**Create:** `discovery.cjs`, `test/agent-discovery.test.cjs`, `docs/experiments/agent-delegation-protocol.md`. **Modify:** events, proposal UI and user-controlled automation settings.

**Consumes:** a selected source scope, recorded tasks/results and an explicit automation policy. **Produces:** deduplicated suggestions, dismissals, user-authorized dispatch and a local evaluation export.

- [ ] Run the scout only on user-selected material. A suggestion includes source/version, proposed outcome, acceptance example and estimated work category. Suggestions cannot mutate notes or launch code. Deduplicate recurring issues and honor dismissal until evidence changes.
- [ ] Add opt-in policies with allowed task classes/paths/actions, maximum run budgets and a review-queue ceiling. Pause optional automated dispatch at five unreviewed returns initially; explicit user dispatch remains available. No nightly daemon is included in this PR.
- [ ] Record capture, launch, needs-input, ready, review, redirect, integration and rework events. Add optional episode markers for active coordination time. Export locally with content redaction; never infer complete scientific thinking or scientific value from app activity.
- [ ] Execute the spec's 20-episode pilot against the existing terminal workflow using the same model/tool access where feasible. Report median active coordination-time difference, uncertainty, task-class breakdown, material error count and later rework. Product hurdle: >=25% reduction with no increase in material errors. The pilot is exploratory and does not establish scientific novelty or general population effects.
- [ ] Test duplicate/dismissed/stale suggestions, disabled policies, scope expansion, budgets, queue backpressure and isolation of private data. Run `node --test test/agent-discovery.test.cjs`. Commit `feat(agents): propose scoped work and measure coordination cost`.

## Verification and release discipline

For each PR, run its focused tests, the full existing `npm test`, and `npm run build` when renderer/packaging code changes. Use `npm run test:pty` when terminal/provider launch or shutdown integration changes. Add deterministic failure-injection tests before real provider probes; fixture success is not evidence that a provider integration works. Store real probe versions and results separately from fixture tests.

Final scratch-home walkthrough: dispatch two research questions, keep writing, redirect one, rename a workspace, reload the renderer, restart the app, inspect evidence, and integrate one return. Then run two code changes, detect a combined failure, resolve it on the owning branch, exercise a blocked handoff, lose its connection, and verify the effect is not repeated. Confirm that normal notes and the active checkout are unchanged by the scratch run.

Document-only planning verification already completed: repository/context inspection, installed CLI help, primary-source checks, and the existing 69-test baseline. No agent pipeline has been implemented or exercised. Do not report this plan's unchecked steps as successful tests.

## Self-review and traceability

| Requirement | Implementation gate |
| --- | --- |
| Fast dispatch without compulsory up-front structure | PR 3 selected-text flow; PR 4 bounded fix |
| Exact context and source provenance | PR 1 manifest and PR 3 return |
| Continued thinking without lost edits | PR 1 save boundary and PR 3 integration |
| Concurrent work without shared-checkout collisions | PR 4 worktrees/integration |
| Authored secretary/queue protocol | PR 5 state, policy, outbox and uncertainty tests |
| Both Claude and Codex | PR 2 and PR 6 contract probes |
| Movement between problem decomposition and execution | PR 7 revisioned graph |
| Autonomous discovery without uncontrolled review burden | PR 8 policies and queue ceiling |
| Evidence of attention benefit | PR 8 pilot, with quality/rework guardrails |

The hard release boundary is the complete return-and-integration loop. The high-risk implementation boundaries are persistence versus external side effects, app-controlled versus external document writes, and native provider permissions versus claimed capabilities. Those receive executable failure cases before expanding the number of agents.
