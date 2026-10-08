# E2B integration — Bart flow specification

> **Changed since (2026-10-03):** setup is the local Claude Code subscription's alone. The Anthropic API-key fallback,
> `ENGELBART_SANDBOX_SETUP` (`auto`/`api`/`claude-local`), `ANTHROPIC_API_KEY`/`HC_*` settings and `launch.py
> --reset-local` described below are gone; hc is used only to restart sandboxes it set up earlier. Claude now declares
> each repository's kind (`interface`, `terminal` or `both`), and a terminal repository is ready without a web preview,
> with a shell in its sandbox. These documents are kept as written; [../sandbox-runs.md](../sandbox-runs.md) describes
> current behavior.

The primary specification is the real Bart question-and-answer document in **Engelbart → E2B integration**, mirrored in [WORKSPACE.md](WORKSPACE.md). It uses numbered Behavior / Event / Decision steps and Before/After JSON, as requested. Current flow means Hudson's baseline; New flow means David's E2B source branch. Explicitly adopted robustness additions are distinguished from observed source behavior.

- [WORKSPACE.md](WORKSPACE.md): primary Build document, including actual `@bart --astra --ultra` questions and unmodified backend replies with model attribution. Later explicit corrections override earlier statements.
- [FLOW.md](FLOW.md): reading copy of Bart's answers with expanded JSON indentation. The questions and authoritative Build context remain in WORKSPACE.md.
- [ENGINEERING-DRAFT.md](ENGINEERING-DRAFT.md): preserved earlier document, before the user's format correction. Supporting material, not the primary flow specification.
- [SPEC.md](SPEC.md), [IMPLEMENTATION.md](IMPLEMENTATION.md), and [ACCEPTANCE.md](ACCEPTANCE.md): earlier supporting requirements, module map, and verification scenarios. Resolve differences using the corrected flow and pinned source; do not mistake a proposed improvement for existing behavior.
- [reference/source-manifest.json](reference/source-manifest.json): immutable source commit, target baseline, per-file hashes and archive checksums.
- [reference/canvas-source.tar.gz](reference/canvas-source.tar.gz): pinned source, tests, scripts and relevant historical docs. Shared files contain unrelated features; port only the specified E2B functionality.
- [reference/template-runtime.tar.gz](reference/template-runtime.tar.gz): allowlisted runner build inputs and preserved hc source from the sibling web project, separately identified and hashed. This is source evidence, not a deployed cloud image.

The user-confirmed behavioral source is `feat/canvas-workspace-updates-2026-09-28` at `2d570caefda24e23cd5b14669b26dd1853abf706`. The Hudson baseline is `ab0377d475ece3ca8231c11ecc6a799277417122`. This preparation changes documentation/reference artifacts only. The question series uses Engelbart's real `createBart().ask` backend and the requested Astra/ultra setting. It does not start workspace Build or provision an E2B sandbox.

## Using it

Open **Engelbart → E2B integration** and press the workspace **Build** button when ready to implement. The project code directory must remain this repository, on the intended `david-e2b` branch. Build creates its own worktree from the last commit. The full specification is in the workspace document, and the reference packet is copied beside it inside the project's read-only note directory; this avoids losing the handoff merely because these docs are not committed yet.

The requested feature is GitHub repository → E2B setup → verified live preview. The coding agent implementing it still runs under Hudson's existing local Build workflow. Moving that coding agent itself into E2B is a separate feature.

Review the resulting code and verification report using normal Build Review/Accept. Live checks need the user's normal runtime configuration and account-accessible templates; report blocked checks truthfully. Bart's documentation answers are real model calls. They are not evidence that the future E2B implementation has passed live or packaged-app tests.
