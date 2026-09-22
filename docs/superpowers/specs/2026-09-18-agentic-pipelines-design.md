# Engelbart agentic pipelines: proposed design

Prepared 2026-09-18 against `engelbart-canvas` commit `31d700c`, branch `hudson-working-branch-prototype`. This is a proposal for implementation, not an approved design or a report of implemented functionality. The companion implementation plan is `../plans/2026-09-18-agentic-pipelines.md`.

## 1. The first thing to make work

Select a passage in a workspace, ask an agent to resolve a bounded question, continue writing, and return to an evidence-linked result at the originating passage. Inspect its assumptions, accept part of it, revise the question, or discard it. A small code change follows the same loop, with a branch and tested diff as its return.

The first milestone is this complete loop with one agent. Parallelism, a secretary, and autonomous task discovery extend it. They cannot compensate for a return that costs more attention to integrate than the work it saved.

The plan assumes research delegation is the first usable slice, with small code tasks immediately following. This ordering was chosen without a response to the optional workflow-priority question. Both are requirements; model/provider choices remain configurable.

### What the current app already has

| Present at the inspected revision | Implication |
| --- | --- |
| Nested workspaces with UUIDs; project `directory`; a library of context references | Extend the existing workspace model. Do not restore goals/topics or introduce another project hierarchy. |
| Electron main process owns disk/PGlite through validated IPC | Put task authority here initially. The renderer displays and requests actions. |
| Native Claude/Codex PTYs | Keep these for direct interaction. Add machine-readable agent transports separately. |
| `DocEditor.jsx` simulates `@chat` replies and build/check/done with timers | These are UI prototypes, not an existing execution engine. |
| Build state keyed by document and line index; whole-document saves debounced 400 ms | Stable anchors, an awaitable save boundary, and revision-aware integration are prerequisites. |
| `npm test`: 69 passed, 0 failed | Baseline only. No new agent behavior, provider call, or crash recovery has been tested. |

Relevant files: `src/main/index.cjs`, `src/main/ipc.cjs`, `src/main/store/{db,projects}.cjs`, `src/preload.cjs`, `src/renderer/screens/Workspace.jsx`, `src/renderer/workspace/DocEditor.jsx`. The older Python harness in `~/claude-plugins` is a precedent, not the integration target. The project metadata in `~/.engelbart/engelbart/project.json` points here.

## 2. Architecture and alternatives

Use a small, durable local runtime around provider adapters. The runtime owns records, scheduling, authorization, retries, and delivery. Models interpret tasks and produce artifacts. A role such as “secretary” is a bounded invocation, not another continuously running service.

```text
Workspace: selection / @chat / explicit task action
    -> snapshot context + persist task
    -> scheduler -> provider adapter -> agent attempt
                          |                  |
                          |                  +-> bounded handoff request
                          |                       -> review -> policy check
                          |                       -> project/resource queue
                          |                       -> action -> durable return
                          v
                   result + evidence + proposed changes
                          -> review / redirect / integrate
                          -> updated workspace or tested feature branch
```

| Approach | Consequence | Decision |
| --- | --- | --- |
| A local runtime using native agent interfaces | Fits existing Electron/PGlite app; gives Engelbart ownership of context, provenance, and resumption | Use this. |
| Wrap an existing coding orchestrator | Gets worktree and review machinery, but introduces another session, task, and project model | Borrow mechanisms; do not embed its entire product. |
| Build around a general workflow framework or cloud service | Adds infrastructure before the first interaction is validated | Revisit when multi-machine execution or an always-on service is required. |

Start with Claude Code's documented print/stream interface and the installed CLI. Add Codex's App Server behind the same contract. These are independent agent sessions, not necessarily the providers' built-in subagents. Background execution does not itself imply fewer capabilities: handoff is justified by an actual capability gap, authorization requirement, or shared resource.

The verified local versions are Claude Code `2.1.278` and Codex CLI `0.155.0`. Record versions in run metadata; do not make these floating assumptions. Claude supplies structured streaming and session-specific resume. Codex supplies threads, turns, interruption, and approval requests. Generate Codex protocol schemas from the installed CLI. Product-wide Claude SDK authentication is a separate distribution decision; the official SDK documentation requires API-key authentication for third-party products unless otherwise approved. [Claude programmatic interface](https://code.claude.com/docs/en/headless), [Codex App Server](https://learn.chatgpt.com/docs/app-server), [Claude SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

## 3. System constraints

These are the proposed global requirements, copied into the implementation plan.

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

## 4. Objects and invariants

Store operational records in `<dataRoot>/.runtime/state.pglite/`; store immutable content by hash under `<dataRoot>/.runtime/artifacts/`. Use one runtime database per normal/test root so locks can span projects. Only the main process opens it. Existing project/notes databases keep their responsibilities.

| Object | Required information |
| --- | --- |
| Task revision | Task ID, revision, project/workspace IDs, source anchor, original request, intended outcome, success evidence, exclusions, task kind, context manifest ID, authorization reference, budgets, dependency IDs |
| Context manifest | Ordered source IDs, content hashes, immutable text/excerpts or materialized files, provenance/locators, inclusion reasons, omitted/unreadable sources, project instructions version, selected code base SHA |
| Attempt | Run ID, task revision, provider/session ID, runtime version, process identity, start/end, state, usage, checkpoint, base SHA/worktree if applicable |
| Event | Monotonic sequence, event ID, run ID, type, time, payload; duplicate provider events are idempotent |
| Result | Result ID, task revision, summary, evidence, unresolved issues, implications for the originating question, artifact hashes, actual changed paths, checks and their outcomes |
| Handoff | Request ID, originating run and provider tool-call ID, bounded action, context, expected result, decision, policy version, resource requirements, state, evidence, delivery acknowledgement |
| Integration | Result ID, target document revision or branch SHA, operation ID, proposed change, applied outcome and resulting revision/SHA |

Task intent is free text. Do not require a form of these fields from Hudson: infer what is clear, show the compact interpretation, and ask only for a consequential missing decision. A one-sentence fix can be sufficient. Large ambiguous features first return a specification proposal with human-owned decisions.

An anchor combines document/workspace ID, dispatched content hash, quoted text, surrounding text, and original offsets. Line numbers are hints. A rename preserves identity. Multiple equally plausible matches or deleted text produce a detached return; the system must not guess a destination.

Run lifecycle: `queued -> starting -> running -> succeeded | failed`, with `waiting_handoff`, `waiting_user`, `cancelling -> cancelled`, and `outcome_unknown` branches. `starting` is recorded before launching a process. Results move independently through `unreviewed -> accepted | rejected | revision_requested`; accepted output may later be integrated. A successful provider exit is not evidence that a claim is true or a feature works.

Use transactions for task creation with its event, atomic claims, state transitions, and handoff completion with pending delivery. File artifacts are written and hash-verified before their database reference commits; unreferenced files can be collected later. Database plus filesystem plus external tools is not one transaction. Record intent before a side effect and reconcile crashes between steps. [PGlite transaction API](https://pglite.dev/docs/api#transaction).

## 5. Context, memory, and prompt caching

Resolve context before dispatch: current editor text, selected passage, explicit project instructions, the current workspace's attached sources, and relevant references from ancestors. An ancestor's entire prose is not automatically necessary. The broader library remains available for retrieval. Show what was included, what was omitted, and why.

Persist the exact selected text and source versions. Resolve duplicate note names to UUIDs before running. For PDFs preserve page/section locators; for websites preserve URL and retrieval time; for chats preserve conversation/message IDs. An unreadable link is recorded as unread, not silently treated as consumed. Materialize supported content for the chosen backend; surface unsupported modalities. The first slice can be limited to markdown/text and explicit URLs, with PDF/image ingestion added before claiming those are supported.

Give workers a compact brief and access to source artifacts. Return consequential decisions and evidence links to the parent; retain raw tool traces for inspection. Do not flood every worker with every conversation. Conversely, do not assume a short agent summary preserves every decision needed by another task.

Separate three optimizations: reusing local retrieval/extraction, resuming the correct provider session, and provider-side prompt caching. For caches, stable role/tool/project material precedes task-specific content; sort it deterministically and version it. Keep timestamps, task IDs, and varying paths out of a stable prefix when the backend permits it. Claude's cache requires identical prefix content; tool/configuration changes can invalidate reuse. Native CLIs also construct prompts, so cross-worker cache hits are measured, never guaranteed. Record reported cached/uncached input tokens, startup time, time to first useful event, total cost when available, and context size; unavailable usage is `null`. Do not pad prompts or delay work just to create cache hits. [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

## 6. The pipelines

### Research and planning

`Capture question -> resolve context -> bounded research -> evidence-linked return -> human integration or reframe`.

Example: select the claim that agents need project-wide context and ask for evidence about when bounded context fails. Return supported findings, counterevidence, applicability limits, source passages, and which assumption in this workspace each finding bears on. A polished literature dump is insufficient. A return may establish that the question needs revision rather than provide an answer.

For a larger feature, the planner proposes small tasks and dependencies. Each task can belong to the user or an agent. Existing completed artifacts remain visible when the plan changes; downstream tasks are marked stale when their input revision changes. Do not silently rerun them, discard human steps, or automatically convert research into a commitment to build.

### Quick code changes

`Explicit request -> bounded contract -> isolated worktree -> patch -> relevant checks -> result/diff -> serialized integration`.

Use the real example “copy the formatting when I copy things (i.e. ##).” Its acceptance example should state what source text must reach the clipboard. Once that behavior is unambiguous, no separate planner/secretary invocation is required. Bigger scope discovered during work becomes a revision request, not permission for unrelated changes.

Record the committed base SHA. If the current checkout contains needed uncommitted work, show that it is excluded and require an explicit snapshot/checkpoint choice; never stash, commit, or discard it automatically. Worktrees isolate files and Git indexes, not ports, credentials, databases, hooks, or external effects. Allocate task-specific test homes/ports and enforce native execution policy separately. [Git worktree](https://git-scm.com/docs/git-worktree).

Two individually passing patches can fail together. Prepare the combined result in an integration worktree, rerun relevant checks, and compare the target SHA before landing on the selected feature branch. If it moved, retry validation against the new base. Conflicts return to the owning task. A push/PR/merge follows the user's established authorization, not an inference from worker success.

### Capability handoff

Preserve the authored protocol in `~/.engelbart/engelbart/Background agent handoff to orchestrator.md`: the worker retains the task; the secretary reviews; the harness queues and enforces policy; the supervising agent executes only the bounded request.

1. Persist a request and bind it to the authenticated run/tool call. Retrying the same submission returns the same record. A new request by a different worker is distinct.
2. Review necessity, scope, available context, and existing authorization. Outcomes: approve, clarify, reject, or require user approval. The secretary has inspection tools only.
3. Independently check execution policy. Approval is scoped to action arguments, task revision, resources, and policy version. Recheck at dispatch; revoked or stale approval cannot execute.
4. Queue FIFO per project. Waiting questions do not block eligible requests. Reserve all required shared resources atomically; a desktop/browser session needs a global lock across projects.
5. Execute, record evidence and actual changes, release resources only once execution has stopped, and persist delivery to the original worker. The worker judges whether its blocker is resolved.

Canonical handoff states: `awaiting_review`, `needs_clarification`, `awaiting_user_approval`, `queued`, `running`, `completed`, `failed`, `rejected`, `cancelled`, `outcome_unknown`. On timeout or lost connection, retain an unresolved resource claim until liveness and effects are reconciled. A result already present is delivered again idempotently, not executed again. Scope expansion creates a new request. Cancellation records partial effects.

Reserve capacity for the control/action lane independently of worker capacity: two workers waiting on handoffs must not prevent their supervising action from running. Unsupported backend tools produce an explicit blocked result, never an imitation of a successful tool call.

### Discovery and maintenance

Only after explicit delegation is useful, let a scout propose bounded tasks from a selected workspace or repository. Each suggestion names its evidence, expected benefit, acceptance example, and source revision. Deduplicate by issue/source identity; suppress dismissed suggestions until their evidence changes. Initially the scout proposes and never edits.

Autonomous execution requires an enabled policy specifying task classes, paths/actions, checks, budgets, and stop conditions. Pause dispatch when the review queue reaches its limit. A librarian proposes contextual links and a cleanup agent proposes diffs; neither silently rewrites the user's conceptual structure. Nightly operation requires a later daemon/OS-scheduling decision and an explicit owner for the PGlite database.

## 7. Attention and recovery

Expose a small workspace activity strip: working, needs input, ready to review. Keep detailed logs behind the relevant task. A returned item carries the original question, what changed, the necessary decision, and a link back to where thinking paused. Ordinary completion does not steal focus. Start with visible badges and user-chosen review moments; automatic inference of cognitive breakpoints is a later experiment.

Initial engineering defaults: two worker runs in total, one action slot per project, and one global slot per exclusive resource. Stop optional autonomous dispatch at five unreviewed returns. These values are tuning defaults, not conclusions from human-factors research. Budget limits are explicit per run; provider usage may arrive late, so a wall-clock/turn limit is not represented as a guaranteed dollar cap.

Renderer reload replays stored events after its last sequence. Application quit requests stop, persists checkpoints, and leaves uncertain effects unresolved. On restart, reconcile all `starting`, `running`, and `cancelling` records before launching anything new. A PID alone is not identity: check a run token, process start identity, provider session, and checkpoint. Never resume the same provider session concurrently.

The document integration path checks both the current editor buffer revision and the stored document hash. It inserts into the live buffer only after review; saved writes are serialized in the main process. If external edits conflict, offer a new result note or manual placement. Arbitrary simultaneous writes from other applications are not supported as automatic merges.

## 8. Why these precedents change the design

This is a targeted synthesis of the supplied 97-entry guide, not a new systematic review. Sources were retained where they changed a concrete decision about delegation, adaptation, attention, or execution. Current provider interfaces were checked against official documentation and installed CLI help.

| Evidence | Bounded implication for this design |
| --- | --- |
| Shipman & Marshall (1999), reflective synthesis on the costs of premature formalization | Keep freeform capture; materialize task structure at dispatch. This is design reasoning, not an estimated causal benefit. [Author text](https://people.engr.tamu.edu/shipman/formality-paper/harmful.html) |
| Cocoa, CHI 2026 version: within-person study with 16 researchers; reported steerability medians 4 versus 3 on a five-point scale, plus a seven-person field deployment | Make the plan editable during execution and make human/agent ownership explicit. Subjective steerability does not establish better science; the study used GPT-4o and 2024 sessions. [Paper, §5–7](https://arxiv.org/html/2412.10999v4) |
| Retelny et al. (2017): six teams/22 workers; workflows aided coordination but constrained adaptation | Provide explicit reframe, revise, and blocked paths. Human crowd teams are an analogy, not proof about LLM teams. [Paper](https://hci.stanford.edu/publications/2018/workflows/workflows-cscw2017.pdf) |
| Anthropic's multi-agent research account reports benefits for parallel search and difficulty with shared-context dependencies | Decompose by information independence and merge cost; do not equate extra workers with better work. Vendor evidence is not an independent evaluation. [Engineering account](https://www.anthropic.com/engineering/multi-agent-research-system) |
| Agent Orchestrator associates workers with worktrees and displays states derived from execution/review facts | Reuse the isolated-worker and evidence-derived status patterns. Its current repository redirects from ComposioHQ to Untrivial-ai. [Repository](https://github.com/Untrivial-ai/agent-orchestrator) |

The older supervisory-control and blackboard precedents in the supplied guide motivate a shared task record and limits on attention demand. Their findings do not supply an optimal agent count for Engelbart.

## 9. Acceptance and the remaining empirical question

The engineering gate is a repeatable end-to-end run: dispatch two questions from separate passages, continue editing, receive distinct grounded artifacts, redirect one run, restart the app, and integrate one result without losing or misattributing work. Add a pair of code tasks with an integration conflict and a handoff whose connection drops after its side effect. Recovery must preserve uncertainty and prevent duplicate effects.

The product hypothesis is that bounded delegation increases time available for problem formulation without degrading the quality of decisions. Measure active briefing, supervision, return-review, integration and rework time separately. Use explicit episode markers or a small annotated sample; idle app time is not evidence of thinking. Record a concrete decision enabled by each accepted result and whether its cited evidence actually supports it.

Pilot with 20 comparable work episodes split across current terminals and the new loop, counterbalancing task class/order where possible. Predeclare a product hurdle: at least 25% lower median active coordination time, no increase in material errors requiring later correction, and no lost/incorrectly attached returns. The 25% is a chosen hurdle, not a literature-derived effect. Report paired differences where tasks can be matched, distributions, and uncertainty; a personal pilot cannot establish improved scientific novelty or generalize to other researchers.

The decisive question for dogfooding is: when a result arrives, can Hudson judge what it changes about the parent question without reconstructing the agent's entire investigation? That is the test the return format and context model must pass.
